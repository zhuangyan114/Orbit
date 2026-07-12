# Native Debug Engine 分阶段发布与回退

## 当前架构与 owner 不变量

每个 `ozone` DAP 会话只能有一个物理 J-Link owner：Native 模式由 `ozone-jlink-helper.exe` 在独立进程中加载 DLL，legacy 模式由该会话的 koffi channel 加载 DLL。`SessionTargetSelector` 是唯一的选择点；Watch、Timeline、evaluate、变量读写、MemoryView、Peripheral Viewer、RTOS Views 与 RTT 都必须经过已选 owner。

禁止在同一会话中热切换 owner，也禁止用 `JLINK_Close()`/open 作为切换手段。Native 已经连接 target 后的命令失败会释放/终止 Native owner 并保留失败结果，用户必须启动新的 legacy 或 auto 会话；不会构造或连接第二个 koffi owner。这样避免两个 DLL owner 对同一 probe/target 的断点、halt、RTT 与采样状态产生不可判定竞争。

活动 `ozone` DAP 会话也是运行态路由 owner。`RuntimeRouter` 对 `getTargetState`、`dataSample`、`setWatchValue` 必须使用 `session.customRequest(...)`；请求失败返回该操作的错误，绝不回退 extension-host backend。

## 配置矩阵

现有布尔开关保持兼容，默认值不变：`nativeDebugEngineEnabled` 与每个 step capability 都默认 `false`。新增 `nativeDebugEngineMode` / `ozone.nativeDebugEngine.mode` 只定义 owner 选择策略，默认 `auto`；在 `enabled=false` 时其有效结果仍为 legacy。

| 启动配置 | 默认值 | owner 选择 | 初始化失败 | 运行期 Native 命令失败 |
|---|---:|---|---|---|
| `nativeDebugEngineMode: legacy` | 可显式设置 | 只构造 koffi legacy owner | legacy connect error | 不适用 |
| `nativeDebugEngineMode: native` | 非默认 | 只构造 Native helper owner | 释放 helper，返回 `NativeInitializationFailed`；不构造 legacy | 释放 helper，返回 `NativeOwnerLost` 上下文；要求新会话 |
| `nativeDebugEngineMode: auto`, `nativeDebugEngineEnabled: true` | 灰度模式 | 先构造 Native | helper 握手、DLL load 或 connect 失败且 helper 已退出后，构造新的 legacy owner | 释放 Native owner，返回错误；不热切 legacy |
| `nativeDebugEngineMode: auto`, `nativeDebugEngineEnabled: false` | 当前默认行为 | 只构造 legacy owner | legacy connect error | 不适用 |
| 未设置 `nativeDebugEngineMode` | 历史兼容 | `enabled=true` 等价 auto；`enabled=false` 等价 legacy | 按上述规则 | 按上述规则 |

`nativeDebugEngineStepInto`、`nativeDebugEngineStepOver`、`nativeDebugEngineStepOut` 仍独立控制源码级 Native step 的启用；它们不改变 session owner。Native owner 已连接但某 capability 关闭时，该 command 使用该 owner 支持的保守路径或返回不支持错误，不能因此创建 legacy owner。

## 状态策略

```text
legacy
  -> create legacy owner -> connect -> LegacyConnected

native
  -> create Native helper -> handshake/load/connect
  -> success: NativeConnected
  -> failure before ownership: dispose helper -> NativeInitializationFailed

auto + enabled
  -> create Native helper -> handshake/load/connect
  -> success: NativeConnected
  -> failure before ownership: dispose helper/process exit
       -> create legacy owner -> connect -> LegacyConnected

NativeConnected + command failure / NativeOwnerLost
  -> cancel/finish control work -> dispose Native helper -> NoOwner
  -> return diagnostic error; user restarts a new legacy or auto session
```

初始化失败和运行期失败的区别是 owner 是否已拥有 target。只有前者可在同一次启动中使用 auto fallback；后者不能确认命令、临时断点、RTT 或采样是否已部分执行，跨 owner 继续会污染会话状态。

disconnect、restart、cancel 和 timeout 必须走既有 `finally`/dispose 路径：释放 DAP control lock、NativeScheduler 的 Timeline 暂停作用域、在途读取标志、helper 生命周期和断点清理状态。cleanup 失败应使 owner 不可用，不能继续普通 step。

## 日志与用户诊断

连接和路径选择写入 `outputs/Log/dll.log`，命令/stop 与控制状态写入 `step.log`/`dap.log`。每条策略事件应包含：session 标识（DAP/session 关联信息）、requested mode、实际 owner、command、error code、`targetConnected`、fallback 是否允许与建议动作。不要记录 bearer token、完整敏感路径或未筛选的 helper stderr。

| 情况 | 用户可见错误 / 建议动作 | 日志重点 |
|---|---|---|
| 显式 Native 初始化失败 | `Native initialization failed`；target 未连接。选择 legacy，或选择 auto 后重启会话。 | mode=native、owner=none、初始化错误码、`targetConnected=false` |
| auto 初始化失败后 legacy 成功 | 可继续调试；状态显示实际 legacy 路径。 | Native 原始错误、helper 已 dispose、legacy owner connect 成功 |
| Native 已连接后命令失败 | Native session 已终止以保护 target；重启 legacy 或 auto 会话。 | owner=native、command、`NativeOwnerLost`、dispose、`targetConnected=true` |
| 活动 DAP 路由失败 | 操作失败；重试 DAP 会话或结束会话，不使用 extension-host 读取。 | custom request 方法、DAP error、无 local backend 调用 |
| Watch/Timeline/写操作控制失败 | `Target busy` 或具体 command error；控制结束后读/采样应恢复。 | read-cancel epoch、control scope、sampling pause/resume、写前 flush |

排障顺序：先确认 `dap.log` 的活动会话和 command，再确认 `dll.log` 中本会话仅有一个 connect owner；随后检查 `step.log` 的临时断点/cleanup 和 `eval.log` 的读写/采样恢复。若 owner 已丢失，不对同一会话继续发 target command。

## 分阶段发布计划

| 阶段 | 默认策略 | 准入条件 | 回退 |
|---|---|---|---|
| 0. 观测 | legacy | 保留 profiling、路径日志和 validation matrix | legacy 无变化 |
| 1. 内部 Mock | legacy | helper build、mock channel、selector/RuntimeRouter 测试通过 | 关闭 Native flags |
| 2. 显式 Native 冒烟 | legacy | VM-01--VM-17 的 Native 最小硬件验收，单 owner 证据 | 新会话选择 legacy；不热切 |
| 3. auto 灰度 | legacy | 启动失败 auto fallback、RuntimeRouter 不回退、Watch/Timeline/RTT 冒烟通过 | 保持 `enabled=false` 或 mode=legacy |
| 4. 扩大 Native step | legacy | validation matrix 的历史 bug、owner、DAP 顺序与 step capability 硬件数据满足门槛 | 新会话选择 legacy/auto |
| 5. 考虑默认 Native | 尚未授权 | 同一会话 20/20/20 并发压力、viewer/RTT、异常演练均有真实硬件证据 | 发布配置保持 legacy，必要时撤回默认值 |

目前不得把 Native 设为默认。Mock、类型检查与历史 legacy 硬件记录不等价于 Native 真实硬件通过。

## 与验证矩阵的映射

| 发布关口 | 矩阵项 |
|---|---|
| owner 选择、初始化 fallback、路径可见性 | VM-13、VM-14、VM-23 |
| 禁止运行期热切与异常清理 | VM-21 |
| 活动 DAP 路由失败不回退 | VM-15 |
| Watch/Timeline/写入恢复 | VM-16、VM-18、VM-19 |
| DAP stopped 与 legacy 对照 | VM-11、VM-12 |
| viewer、RTT、reset/reconnect | VM-17、VM-20 |
| Native 性能与完整灰度压力 | VM-22 |

## 验收状态

| 验收层 | 当前状态 | 证据边界 |
|---|---|---|
| 代码 | 部分通过 | selector 已区分 legacy/native/auto，运行期 Native owner loss 不再创建 legacy；RuntimeRouter 已返回活动 DAP 请求错误 |
| 自动测试 | 通过 | `npm run build:native`、Mock channel、类型检查、bundle 构建及全量 Vitest 已通过；Vitest 为 9 文件、38 项，覆盖显式 legacy、auto 启动 fallback、显式 Native 初始化错误、已连接 Native owner loss、DAP route no-fallback 与控制恢复 |
| 真实硬件 | 部分通过 | 已有 Native auto 单 owner、运行态读取、20 次变量写入和 92 次 UI step 的实测日志；VM-14/15/17/20/21/23、同 session Timeline recording、Into/Out 各 20 次及 VM-22 性能门槛仍未完成 |

### 2026-07-12 任务 13 验证续跑

- 工作树版本为 `7e705cf`（脏工作树）；本轮只更新验收文档。
- 自动基线已重新执行并全部通过：`npm run build:native`、`npm run test:cpp-channel:mock`、`npm run typecheck`、`npm run build`、`npm test`（9 个文件、38 项）以及 `git diff --check`（无错误，仅行尾转换警告）。
- plugin API endpoint 文件存在，但 `ozone.status` loopback RPC 无法连接；未发现运行中的 `ozone-jlink-helper`。因此没有活动 ozone DAP session，也没有可记录的 MCU、ELF、DLL、接口/速度、launch 开关、session、owner 或本轮日志时间范围。
- 未启动第二 J-Link owner，未绕过 DAP；未执行 step、变量写入、RTT、reset、disconnect/reconnect 或 helper 故障注入。VM-13--VM-23 的真实硬件状态不升级，仍受 validation matrix 的逐项状态约束。

### 2026-07-12 Native 硬件补充结果

- 新的 `auto` 会话实际选择 Native helper，`dll.log` 只记录一次 helper `JLINK_Open`/`JLINK_Connect`，没有 `NativeOwnerLost` 或 legacy connect。该会话验证了 Native owner 下的 MCP/plugin 运行态读取、20/20 `count` 写入及回读、Watch/evaluate 在 step 后恢复。
- 真实 UI step 日志有 92 个完整 Native profile：Over 78/78、Into 8/8、Out 6/6；每个 response 在唯一的 Native stopped event 前，未出现 `Target busy`、owner loss、超 200 ms 样本或 5 秒级等待。
- 此结果不满足阶段 5 的门槛：当前 session 未达到 Into/Out 各 20 次，且非调用 stepOver DAP 最大 149 ms（门槛 `<50 ms`），stepOut 最大 144 ms（门槛 `<100 ms`）。压力 session 与先前 plugin recording 不是同一 session，不能证明完整 step 期间 Timeline recording 连续。
- 真实硬件验收仍为**部分通过**。保持默认 legacy；不得进入“考虑默认 Native”阶段。后续必须先定位 Native step 的端到端延迟，再在一个不重启的 Native session 中完成 recording + Into/Over/Out 各 20 次。
- VM-17 修复后的 Native Viewer 补验已通过其 Native 范围：FreeRTOS 任务/列表、TCB 指针、struct/array 展开及运行变量读取均有真实 `eval.log` 证据；修复后的全量自动基线为 9 个 Vitest 文件、40 项通过。legacy Viewer 对照仍是剩余缺口。

## 回退演练

1. **legacy 启动**：设置 `nativeDebugEngineMode=legacy`，确认只出现 koffi owner 的 DLL connect；运行 step、Watch、Timeline、变量写入和 RTT。
2. **explicit Native 启动失败**：提供错误 helper 或 DLL 配置，设置 mode=native；确认 launch 返回可诊断错误、helper 已退出、没有 legacy connect。
3. **auto 初始化回退**：保持 `enabled=true` 且 mode=auto，使用相同错误 helper/DLL；确认 helper 退出后才创建 legacy owner，随后验证基础 step 和读取。
4. **Native 运行期失败**：Native 成功连接后注入 helper command failure；确认当前命令报错、owner 被释放、Watch/Timeline control state 恢复，且没有 koffi connect。结束会话后再用新 legacy 会话恢复调试。
5. **路由隔离**：活动 ozone session 下让 `dataSample`/`setWatchValue` 失败；确认 plugin/MCP 得到失败，extension-host backend 没有执行。

真实硬件演练必须额外核对：Native、legacy、auto 三种启动均只有一个 owner；Native step、Watch、Timeline、变量写入、RTT、reset/reconnect 不产生第二 owner；Native 已连接后命令失败只报告并清理，不热切 koffi。
