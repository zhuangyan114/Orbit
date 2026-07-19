# Native Debug Engine 发布与回退（现行）

本文件是 owner 选择、发布阶段和回退语义的唯一事实来源。总体结论见 [final-refactor-summary.md](final-refactor-summary.md)，场景验收见 [validation-matrix.md](validation-matrix.md)。

## 单 owner 规则

每个 `ozone` DAP session 只有一个物理 J-Link DLL owner：native 是独立 helper，legacy 是 koffi。`SessionTargetSelector` 先选择、后发布 owner；Watch、Timeline、evaluate、变量读写、MemoryView、RTOS/Peripheral Viewer 和 RTT 都使用该 owner。不得通过 `JLINK_Close()`/open、extension-host backend 或第二个 helper 切换 owner。

## 选择矩阵

| 请求模式 | Native enabled | 启动选择 | Native 初始化失败 | 已连接后 `NativeOwnerLost` |
|---|---:|---|---|---|
| `legacy` | 任意 | 仅 legacy | legacy connect error | 不适用 |
| `native` | 任意 | 仅 helper | dispose helper，返回 `NativeInitializationFailed` | dispose helper，返回错误；重启会话 |
| `auto` | `true` | 先 helper | helper 完全退出后才创建 legacy | dispose helper，返回错误；重启会话 |
| `auto` | `false` | 仅 legacy | legacy connect error | 不适用 |

`nativeDebugEngineMode` 决定 owner。选择 Native owner 后，`stepInto`、`stepOver` 和 `stepOut` 都强制调用 Native source-step；选择 Legacy owner 时三种单步都走 Legacy 路径。launch camelCase 与 `orbit.nativeDebugEngine.*` setting 只保留 owner 选择相关配置；未指定时默认 setting 是 `enabled=false`、`mode=auto`，实际运行 legacy。

运行期不回退是当前实现的安全策略：已经执行的命令、临时断点、RTT 或采样状态可能不完整，连接 legacy 会制造第二 owner。失败后控制作用域、Timeline pause、helper 生命周期和 queued request 必须释放；调用者得到可诊断错误，而不是继续调试。

## 路由与诊断

活动 `ozone` DAP session 是运行态 target owner。`RuntimeRouter` 对 `getTargetState`、`dataSample`、`setWatchValue` 使用 `session.customRequest`；格式错误或失败就返回 error，禁止 extension-host fallback。排障时先检查 `dap.log` 的 request/control state、`dll.log` 的本会话 connect owner，再检查 `step.log` 的 cleanup 与 `eval.log` 的采样恢复。

## 发布阶段

| 阶段 | 默认 | 准入 | 回退 |
|---|---|---|---|
| 0--1 | legacy | build、Mock、selector/router/scheduler tests | 关闭 Native flags |
| 2 | legacy | Native 单 owner 最小硬件冒烟 | 新 legacy session |
| 3 | legacy | auto 启动 fallback、DAP no-fallback、Watch/Timeline/RTT 冒烟 | mode=legacy 或禁用 enabled |
| 4 | legacy | VM 历史场景、异常清理、step capability 硬件证据 | 新 legacy/auto session |
| 5 | 尚未进入 | 20/20/20、同 session recording、Viewer/RTT、故障演练、性能门槛 | 保持 legacy 默认 |

目前只能停留在阶段 3--4 的部分验收：自动基线和部分 Native 硬件日志存在，但 Into/Out 20 次、同会话录波、RTT/reset/reconnect、owner-loss 故障演练与性能门槛未完成。Native 不得成为默认。
