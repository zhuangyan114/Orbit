# Step-over Native 状态机迁移说明

## 迁移范围

任务 08 将逐过程的指令分类、短步进、函数调用 return breakpoint、等待停止和临时断点清理放入 C++ helper 的 `stepOverSourceLine` RPC。TypeScript `doStepOver` 只负责：

1. 根据 DWARF 行表把当前 PC 转换为当前源码行地址范围；
2. 调用 Native executor；
3. 记录并转发 Native 的分段计时和最终结果。

旧实现保留为 `doStepOverLegacy`，开关关闭、executor 不存在或 executor 未独占 native 通道时继续使用旧路径。

## 状态机

```text
Halted
  -> ReadPc
  -> DecodeInstruction
  ->
     non-call: JLINK_Step -> WaitHaltedShort
     call:     ClearCurrentUserBp? -> SetReturnTempBp? -> Go -> WaitHaltedShort
  -> ReadPcAfter
  -> same source range? repeat (bounded)
  -> CleanupTempBpAndRestoreUserBp
  -> Halted / Error
```

Native 接口：

```json
{
  "method": "stepOverSourceLine",
  "params": {
    "lineStart": 134221000,
    "lineEnd": 134221016,
    "waitTimeoutMs": 1000,
    "maxInstructionSteps": 32
  }
}
```

返回 `data` 包含：

- `pcBefore` / `pcAfter`
- `classification`: `singleStep`、`branchSingleStep` 或 `callReturnBreakpoint`
- `instructions`
- `cleanupOk`
- `timings.haltMs/readPcMs/decodeMs/executeMs/waitMs/cleanupMs/totalMs`

所有 Native 结果仍保留 `ok/message/targetState/elapsedMs` 外层字段。

## 指令和源码行策略

- Thumb `BL`、`BLX` immediate 和 `BLX` register 走 return-address 临时断点路径。
- 普通语句、分支和循环迭代使用 `JLINK_Step`，每次完成后立即检查 halted 和 PC。
- TypeScript 只传当前函数内当前源码行的近似地址范围；DWARF 仍由 TypeScript 解析，避免把 ELF/DWARF 解析器复制进 helper。
- 行范围循环有 64 条指令上限，调用等待有 2 秒硬上限，默认请求等待上限为 1 秒。达到上限返回明确错误，不进入 5 秒级无限轮询。
- `lineStart/lineEnd` 缺失时执行一次 fast single-step，适用于没有 ELF 行表的场景。

## 断点生命周期

1. 执行前检查当前 PC 是否命中 helper 跟踪的用户断点。
   Commander 会把 legacy `JLinkDLL.breakpointSlots` 的六槽快照随每次请求传入，helper 在分配临时槽位前同步该视图，避免覆盖另一侧已设置的用户断点。
2. 若命中，记录 slot/address 并清除；失败立即返回。
3. 计算 return address。若已有用户断点，复用该断点；否则申请空槽并标记为临时断点。
4. `Go` 后短轮询 `JLINK_IsHalted`。
5. 命中、超时、DLL 错误、取消或异常都执行同一个 cleanup block。
6. 清除临时断点并恢复步骤开始前被清除的用户断点。
7. cleanup 失败优先于 step 成功，返回 `StepCleanupFailed`，避免 UI 误以为断点仍然有效。

Native helper 不调用 `JLINK_ExecCommand("SetBP ...")`，仍严格使用 `JLINK_SetBP(slot, address)` 和 `JLINK_ClrBP(slot)`。

## 配置切换

新增配置：

```json
{
  "ozone.nativeDebugEngine.enabled": false,
  "ozone.nativeDebugEngine.stepOver": false
}
```

DAP launch 也接受同名驼峰字段 `nativeDebugEngineEnabled` 和 `nativeDebugEngineStepOver`。只有两个字段都为 `true` 且注入的 `NativeStepOverExecutor.usingNative` 为 `true` 时，Commander 才选择 Native 路径。

默认关闭是有意的。DAP adapter 现在为每个 adapter 进程创建一个禁用内部 koffi fallback 的 session-owned executor；`handleLaunch` 在 legacy 会话建立后连接它并注入 Commander，`handleDisconnect`、launch 异常、stdin EOF、进程信号和 session dispose 都会关闭 helper。Native 连接失败只关闭 Native 路径，不影响 legacy 会话。

当前任务只把 step-over 交给该 executor；后续接入完整 Native session 时，Watch、Timeline 和写变量也必须迁移到同一个 helper/scheduler owner，不能再创建额外 native executor。

## Watch / Timeline 行为

Native step RPC 通过任务 07 的高优先级 control queue 执行，step 期间 Timeline queue 被暂停，完成或失败后由 `finally` 恢复。Watch 和 `setWatchValue` 的现有 DAP 路由不变。

本任务没有修改 `session.customRequest('dataSample')`、`dataSamplingStart/Stop` 或 `setWatchValue` 的数据格式。真实 Native session 接入时必须验证：

- step 返回后 Watch 能读取新 PC 对应的变量；
- Timeline 暂停期间不补造数据点，step 后继续采样；
- 高优先级写变量不会被采样队列饿死。

## 日志和性能

每次 step 的 `profileStepCommand` 仍记录总耗时；Native result 额外记录上述七个分段耗时，写入现有 `log.step`。重点观察：

- 普通语句是否只发生一次 `decode + JLINK_Step`；
- 函数调用是否使用 return breakpoint 而不是固定 sleep；
- 循环、switch、do-while 是否在指令上限前离开当前源码行；
- cleanup 是否为 true；
- Watch/Timeline 是否在 step 完成后恢复。

当前已验证：C++ helper 可构建，mock DLL 可执行 `stepOverSourceLine`，并返回分段诊断。真实硬件性能和复杂控制流结果需要在 session-owned Native executor 接入后验证，不能由 mock DLL 证明。

## 变更文件

- `native/jlink-helper/src/main.cpp`: `stepOverSourceLine` 状态机和 RPC dispatch。
- `src/ozone-backend/cpp-jlink-channel.ts`: Native step request/result 类型和 channel 封装。
- `src/ozone-backend/commander.ts`: `doStepOver` 薄封装、legacy 保留、行范围和 profile 日志。
- `src/ozone-backend/types.ts`: launch 配置字段。
- `src/debug/dap-session.ts`: DAP launch 字段转发。
- `src/debugadapter.ts`: 创建并注入 session-owned executor，处理 stdin/信号退出清理。
- `src/debug/ozone-debug-config.ts`: VS Code 设置转发。
- `package.json`: Native step-over 配置开关。
- `scripts/cpp-channel-smoke.js`: mock smoke 覆盖 `stepOverSourceLine`。

## 验证结果

- `npm run build:native` 通过。
- `npm run typecheck` 通过。
- `npm test`：4 个测试文件、13 个测试通过，包含 DAP session executor 生命周期和禁用内部 koffi fallback 的测试。
- `npm run test:cpp-channel:mock` 通过，包含 `stepOverSourceLine`。
- mock call 场景验证了当前 PC 用户断点临时清除、return breakpoint 命中、临时槽清理和原用户断点恢复。
- 未宣称真实硬件 step-over 已通过；需要后续单一 Native owner 接入后进行硬件矩阵测试。
