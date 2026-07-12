# DAP step 响应优化

## 目标与结论

DAP 不再为每次 step 预读 PC，也不再在 Native step 成功后额外查询 target 状态。Native Debug Engine 的成功结果只有在 `targetState` 为 `Halted` 时才会由 `OzoneBackend` 转换为 `{ mode: "native", ...diagnostics }`；`DapSession` 收到该结果后依次发送 step response 和 `stopped` event。

旧 koffi 路径不承诺 step 调用返回时目标已经稳定停止，因此继续使用短间隔保守轮询。这样 Native 正常路径去掉了 DAP 层固定 100 ms PC 预读和多余状态查询，同时不改变旧路径的容错行为。

## 证据与基线

`outputs/Log/dap.log` 中连续 step 的 `read PC` 基本稳定在 100-103 ms。该 PC 只用于 DAP profiling 日志，不参与 step 决策；真正的 Native state machine 自己读取并在 diagnostics 中返回 `pcBefore`、`pcAfter`。

原 `handleStep` 在任何成功结果后都执行最多 200 次、10 ms 间隔的 `getTargetState` 查询。日志中大多数请求在第 1 次查询即得到 halted，说明 Native 已经完成了停止确认，DAP 再查询一次属于重复确认。

## `handleStep` 改造方案

```text
beginTargetControl
  -> stopPolling
  -> backend.execute(step)
  -> failure: retry/失败响应（保持原策略）
  -> success: 先发送 DAP step response
       -> data.mode == native
            -> markStoppedForUi
            -> stopped(reason=step)
       -> otherwise
            -> legacy getTargetState 短轮询
            -> halted: markStoppedForUi + stopped
            -> timeout: 恢复通用 polling
  -> endControl
```

改造要点：

- 删除 DAP step 前的 `readRegister(PC)`。Native diagnostics 已包含前后 PC，legacy backend 也会在自身 step 实现中读取所需 PC。
- Native/legacy 分流依据 backend 的成功结果 `data.mode`，而不是仅依据 session executor 是否在线。这样配置只启用部分 Native step、运行中降级或命令走 legacy 时不会误走快速事件路径。
- `stepOver` 与 `stepInto`、`stepOut` 一致，必须验证 Native 返回 `targetState === "Halted"` 后才能产出 `mode: "native"` 成功结果。
- `beginControl/endControl`、`readCancelEpoch` 和 `markStoppedForUi` 的调用范围不变，Watch/Timeline 在 stopped event 发出前已切换到可刷新状态。

## stopped event 触发规则

1. DAP step response 必须先于对应的 `stopped` event。VS Code 先完成请求，再刷新线程、堆栈、scopes 和变量视图。
2. Native 结果仅在 `ok === true`、`targetState === "Halted"` 且 backend 标记 `mode === "native"` 时直接触发 `stopped`。
3. Native 返回 Running、Stepping、Unknown 或 Error 时不得伪造 stopped；backend 将其转成 step 失败。
4. legacy 成功结果不直接表示目标已停止，必须由 `getTargetState` 观察到 `halted` 后触发 stopped。
5. legacy 短轮询超时后不丢失事件：恢复 `startPolling()`，由通用 target-state polling 在后续观察到 halted 时发送 stopped。
6. 每个成功 step 只由当前分支发送一次 stopped：Native 分支发送后立即返回；legacy 短轮询发送后立即返回；超时分支只交给通用 polling。

`markStoppedForUi()` 在发送事件前执行，负责设置 `targetRunning = false`、递增 `readCancelEpoch` 并短暂抑制低优先级读取。事件处理期间 VS Code 发起的 stackTrace、scopes、variables 与 Watch/Timeline 恢复不会读取 step 前的旧批次。

## 旧路径兼容策略

- `nativeDebugEngineEnabled` 或对应 step 开关关闭时，backend 返回 legacy 结果，DAP 自动进入原有保守轮询。
- Native executor 不可用或命令没有实际走 Native 时，不会出现 `mode: "native"`，因此不会提前发 stopped。
- legacy 仍保留最多约 2 秒的 10 ms 状态轮询、异常情况下的 soft halt，以及超时后的 200 ms 通用 polling。
- step 的三次尝试和失败间 50 ms 退避保持不变；本任务只优化成功响应路径。
- 不修改 `beginTargetControl` 等待已在途读取的 20 ms 检查，也不缩短控制栅栏，因此不会让 step 与 Watch、Timeline 或变量写入并发访问 target。

## 验证

- 单元测试验证 Native 成功只调用一次 backend step，不调用 DAP `readRegister` 或 `getTargetState`，且 response 在 stopped 之前。
- 单元测试验证 legacy step 至少经历状态查询，并在观察到 halted 后才发送 stopped。
- `npm run typecheck`、`npm test` 和 `npm run build` 应全部通过。

硬件验收时应检查 `outputs/Log/dap.log`：Native 行应出现 `native stopped event`，不再出现约 100 ms 的 DAP `read PC`；关闭 Native 开关后应仍出现 legacy poll 次数，并且 VS Code 的线程、堆栈、变量、Watch 和 Timeline 在每次 step 后恢复。
