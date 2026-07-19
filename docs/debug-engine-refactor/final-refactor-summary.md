# Native Debug Engine 重构收尾总结

> 本文记录 2026-07-12 时仓库中的实际实现和可复查证据。它不是新的硬件验收结论；Mock、自动测试和历史硬件日志分别标注，不能相互替代。owner 选择和回退的唯一现行说明见 [rollout-and-fallback.md](rollout-and-fallback.md)，场景级验收见 [validation-matrix.md](validation-matrix.md)。历史问题记录保留在 [../bug-fix-log.md](../bug-fix-log.md)。

## 重构前后

重构前，extension host、DAP、Watch/Timeline 和逐过程 step 分别接触 koffi J-Link 通道，TypeScript 承担大量 Thumb 指令、临时断点和等待逻辑。这样会造成 DLL 访问竞争、长等待、临时断点残留风险，以及活动 DAP 会话和 extension-host 后端同时访问 target 的风险。

当前实现把物理 target owner 收敛到 DAP 会话中的 `SessionTargetSelector`，并把 Native helper RPC 串行化：

```text
VS Code extension host                         DAP adapter process
Watch / Timeline / plugin API -- customRequest --> DapSession
         | no active ozone session only              |
         +--> extension-host OzoneBackend            +--> OzoneBackend
                                                          |
                                               SessionTargetSelector
                                                /                    \
                                  native helper process             legacy koffi
                                  JLink_x64.dll                     JLink_x64.dll
```

- `src/extension.ts` 只负责扩展生命周期、视图、plugin API 和无活动 DAP 会话时的本地 backend。
- `src/debugadapter.ts` 启动独立 DAP 进程；`src/debug/dap-session.ts` 通过 stdio DAP 帧处理 target、step、Watch、Timeline、RTT 和自定义请求，且不导入 `vscode`。
- `SessionTargetSelector` 是唯一物理 owner 选择点。一个会话只有 `native`、`legacy` 或 `none`，不会并存两个 J-Link DLL owner。
- Native owner 是 `ExperimentalCppJLinkChannel` 启动的 `orbit-jlink-helper.exe`。helper 使用 JSON-lines 协议，在其进程中加载 DLL；TS 侧 `NativeScheduler` 按 `control > watch > timeline` 串行请求并可暂停/coalesce Timeline。
- legacy owner 是 koffi `JLinkDLL`。它仍是默认和必要的兼容/回退路径，保留六个槽位的硬件断点规则及既有 DAP 行为。

## Owner 选择与回退

`nativeDebugEngineMode` 的可选值为 `legacy`、`native`、`auto`，并保留 launch camelCase 与 VS Code setting 两套配置别名。默认 setting 是 `enabled=false`、`mode=auto`，其有效 owner 仍是 legacy。

| 选择 | 初始化 | 已连接 Native owner 发生 `NativeOwnerLost` |
|---|---|---|
| `legacy` | 只创建 koffi owner | 不适用 |
| `native` | helper 失败后完全 dispose，返回初始化错误 | dispose helper，命令失败；必须重启会话 |
| `auto` + enabled | 先创建 helper；仅当握手/DLL load/connect 失败且 helper 已退出后创建 legacy | dispose helper，命令失败；**不在同一会话热切 legacy** |
| `auto` + disabled 或未启用 Native | 只创建 legacy | 不适用 |

运行期不回退是有意的单-owner保护：命令、断点、RTT 或采样可能已经部分执行，继续用第二个 DLL owner 会使会话状态不可判定。当前仓库的 `AGENTS.md` 中有一条将运行期 `NativeOwnerLost` 描述为会话内回退 legacy 的旧说明，与代码及本目录的 rollout 文档不一致；本收尾不修改根指令文件，发布前应统一该说明。

## 最终运行行为

- `stepInto`：Native enabled 时，Commander 解析当前 DWARF 源码行边界后调用 helper `stepIntoSourceLine`，在当前行内扫描/进入 `BL`/`BLX`；无法使用 Native 时保留 legacy 指令/临时断点实现。
- `stepOver`：Native helper 在源码行范围内执行，跟踪临时断点和用户断点，并把 `pcBefore`、`pcAfter`、分类、时序和 cleanup 诊断返回。紧凑循环可使用 128 条指令预算，超限仍是显式错误而不是伪成功。
- `stepOut`：Native helper 基于函数范围、LR、SP 和 return breakpoint 完成退出；DAP 使用可信的 Native stop PC。仅为显示可产生同函数内的 source hint，hint 不改写真实 PC，下一次源码级 step 会越过 hint statement。
- DAP：Native step 成功并确认 `Halted` 后，先响应 DAP request，再发布唯一 stopped event；legacy 路径保留保守轮询。标准 `evaluate`、可展开 variables、`memoryReference`、字节导向 read/writeMemory、`deviceName`/`svdFile`/`svdPath` 别名继续保留。
- 实时变量：控制操作排空已开始的 target read 后独占执行；控制期间 Watch/MCP read 返回缓存或 `running` 占位，Timeline 暂停且恢复后不伪造点。变量写入与 step 共用控制锁，写前 flush Timeline、写后失效缓存。
- RuntimeRouter：有活动 `ozone` DAP 会话时，`getTargetState`、`dataSample`、`setWatchValue` 必须走 `session.customRequest(...)`；请求失败即返回错误，绝不访问 extension-host backend。
- RTT：start/stop/read 仍由已选 owner 执行，并保留 buffer、poll interval、control block 和 ANSI 配置；完整 Native RTT/reset/reconnect 硬件演练尚未完成。

## 任务 03--13 状态

| 任务 | 产出 | 代码/自动证据 | 真实硬件状态 |
|---|---|---|---|
| 03 | OpenOCD 状态机参考 | 完成，历史设计参考 | 不适用，不是实现路径 |
| 04 | step 状态机设计 | Native helper 已实现核心 source step；legacy 保留 | 部分通过，性能门槛未达 |
| 05 | C++ 通道选型 | 完成，独立 helper 被采用 | 通过最小连接证据，非完整验收 |
| 06 | helper 原型 | connect/control/read/write/BP/RTT 和协议已存在 | 部分通过 |
| 07 | NativeScheduler | 单 in-flight、优先级、暂停、取消、合并有单测 | 并发压测部分通过 |
| 08 | Native step-over | helper + Commander 路由和 Mock 回归 | 部分通过，端到端延迟不达标 |
| 09 | Native into/out | helper、source hint、DAP 路由和回归 | 部分通过，Into/Out 样本不足 |
| 10 | 实时变量保护 | DAP 栅栏和 RuntimeRouter no-fallback 有测试 | 部分通过，缺同会话完整录波证据 |
| 11 | DAP 响应优化 | Native response-before-stopped 有测试/日志 | 部分通过，需更多压力数据 |
| 12 | 验证矩阵 | 文档和自动基线存在 | 按 VM 项逐项部分/未验证 |
| 13 | 验证续跑 | 历史记录存在；本次将重新执行全量基线 | 不提升任何硬件结论 |

## 证据边界与发布

本次自动基线已通过：`npm run build:native`、`npm run test:cpp-channel:mock`、`npm run typecheck`、`npm run build`、`npm test`（Vitest 9 个文件、43 项）和 `git diff --check`。Mock helper 验证协议、分类、临时断点清理和错误处理，不加载真实 probe/MCU；TypeScript/Vitest 也不能证明 DLL 时序、RTT、Viewer 或 J-Link 资源竞争。

已有真实硬件历史证据显示 Native auto 单 owner、运行态读写、Viewer 补验和 92 个 Native UI step 的部分行为，但不足以进入 Native 默认阶段：Into/Out 未各达 20 次，同会话 Timeline recording 证据不完整，且 Native step 延迟未满足 validation matrix 的门槛。保持默认 legacy。

Native 默认启用的前置条件：完成同一不重启会话中的 Into/Over/Out 各 20 次、Watch/Timeline/recording/写变量并发记录、RTT/reset/reconnect 与 helper 故障演练、MemoryView/Peripheral/RTOS 的 Native 与 legacy 对照，以及所有 VM 发布门槛的可复查日志。

## 剩余技术债

- legacy TypeScript source-step 仍很复杂，但它是可配置兼容路径，不能按静态重复代码删除。
- NativeScheduler 的严格优先级可能使 Timeline 在持续 Watch 流量下饥饿；需要硬件压力数据后再决定是否引入配额。
- 历史设计文档仍包含预期 API/开关；现行配置和行为以本文及 rollout 文档为准。
- 根 `AGENTS.md` 的运行期 fallback 描述需要与实际单-owner终止策略统一。
