# Native Debug Engine 总体指导（现行）

本文件只描述当前仓库的实现约束。重构收尾与证据边界见 [final-refactor-summary.md](final-refactor-summary.md)，owner 回退事实见 [rollout-and-fallback.md](rollout-and-fallback.md)，逐场景验收见 [validation-matrix.md](validation-matrix.md)。旧设计设想不应覆盖这三个文件。

## 架构边界

- 正常调试只通过 J-Link DLL：Native helper 或 legacy koffi。不得把 OpenOCD、GDB server、Ozone GUI 或 `JLink.exe` 作为 debug-control 路径。
- extension host 与 DAP adapter 是独立进程。`src/debug/dap-session.ts` 保持无 `vscode` import，并通过 DAP `Content-Length` 帧通信。
- `SessionTargetSelector` 为一个 `ozone` DAP 会话选择唯一物理 owner。Native helper 必须完全退出后，`auto` 才能在**初始化失败**时构造 legacy owner。
- Native 已连接后发生 `NativeOwnerLost`：终止/释放当前 Native owner，返回失败并要求新会话；不得在会话内新建 legacy owner。
- `RuntimeRouter`、Watch 与 Timeline 在活动 ozone DAP 会话存在时只走 `session.customRequest`。失败是操作错误，禁止 extension-host fallback。

## Native 与 legacy

配置字段包括 launch 的 `nativeDebugEngineEnabled`、`nativeDebugEngineMode`、三个 step 开关，以及对应的 `orbit.nativeDebugEngine.*` settings。默认 `enabled=false`、`mode=auto`，所以默认 owner 是 legacy。`mode` 决定 owner，step 开关只决定 Native owner 下是否调用源码级 Native step。

| 模式 | 行为 |
|---|---|
| `legacy` | 仅 koffi owner。保留完整兼容路径。 |
| `native` | 仅 helper；初始化失败不构造 legacy。 |
| `auto` + enabled | helper 初始化失败后才 fallback legacy；已连接后不热切。 |
| `auto` + disabled | 等同 legacy。 |

## 控制、调度与数据

`NativeScheduler` 对 helper RPC 使用 `control > watch > timeline` 和单 in-flight。step、continue/halt/reset、断点和变量写入是 control；Watch 是 watch；Timeline 是可暂停/合并的 timeline。控制临界区必须覆盖完整 Native transaction，且无论成功、失败或超时都恢复采样。

DAP 的实时保护补充此规则：控制开始后不接纳新 target read，等待已开始的 read 退出；step 期间 read 返回缓存或 `running` 占位。写变量与 step 串行，写前发送已捕获的 Timeline 批次，写后失效 Watch cache。不得为了 step 修复而关闭 Watch、Timeline、evaluate、variables 或写变量。

## DAP 兼容性

保持 `evaluate`、可展开 `variablesReference`、struct/array/pointer children、`memoryReference`、base64 byte-oriented `readMemory`/`writeMemory` 和 `supportsReadMemoryRequest`。保留 launch `deviceName`、`svdFile`、`svdPath` 别名。Native step 成功并确认 halted 后先回复 DAP，再发送一次 stopped；legacy 保持保守状态轮询。

Native `stepInto` 在当前源码行范围内扫描/进入调用；`stepOver` 在 helper 管理临时断点和用户断点；`stepOut` 的 source hint 仅改变显示位置，不改变可信 Native PC，下一次源码级 step 必须越过 hint。

## 修改准则

1. 任何 target 访问都先辨认 active DAP owner，不能创建第二 DLL owner。
2. 每个 `OzoneCommandResult` consumer 先检查 `.ok`。
3. 使用 `log.step`、`log.eval`、`log.dll`、`log.dap`，不增加临时 console logger。
4. Native helper 协议或 capability 改动必须同时更新 `src/ozone-backend/cpp-jlink-channel.ts` 与 `native/jlink-helper/src/main.cpp`。
5. Mock/自动测试不得标记为真实硬件通过；硬件结论只按 validation matrix 的可复查记录更新。
