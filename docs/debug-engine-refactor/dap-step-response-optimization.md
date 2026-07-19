# DAP Step 响应（现行）

Native step 由 helper 返回可信的 halted result 与诊断。Commander 仅在 `result.ok` 且 `targetState === Halted` 后记录 Native stop；DAP 先发送当前 request response，再发布一次 stopped event。这样 Native 路径不依赖固定 100 ms 等待或额外状态轮询。

legacy 仍保留保守的 halt/state 轮询和既有 source-step 路径，不能因为优化 Native 而删除。source hint 只影响 stepOut 后 stackTrace 显示，真实 Native PC 和随后 step 的 line bounds 仍是事实来源。

验证：DAP Native executor/Commander 回归覆盖 Native route 与 response-before-stopped；历史硬件日志有部分顺序证据。完整性能和长会话 stopped 顺序仍以 [validation-matrix.md](validation-matrix.md) 为准。
