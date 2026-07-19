# Native stepInto / stepOut 迁移结果

Native `stepInto` 通过 helper `stepIntoSourceLine` 实现，而不是仅调用一条 `stepIntoInstruction`。Commander 从当前 PC 解析源码行范围并请求 helper 在该范围内扫描/进入 `BL`、立即 `BLX` 或寄存器 `BLX`；没有调用时在越过边界或预算内停止。`stepIntoInstruction` 仍作为低层原语和 DAP 指令级兼容路径存在。

Native `stepOut` 由 Commander 提供函数范围和 breakpoint snapshot，helper 验证 PC/LR/SP、设置返回断点、处理清理并返回可信 stop PC。Dwarf 映射仍在调用行时，Commander 可为 stackTrace 提供同函数内的下一 statement source hint；hint 不移动 PC，之后第一次 source-level step 必须以真实 PC 为起点越过该 hint。

三种 Native source step 都经 `CppJLinkHelperClient` 的 control request，并在完整 RPC 期间暂停 Timeline queue。Native 不可用、capability 关闭或 legacy owner 时，保留对应 legacy 逻辑。不要通过第二 owner 模拟 Native step。

Mock、Commander 与 DAP 回归覆盖 source bounds、hint 和结果路由。真实硬件历史证据尚未完成 Into/Out 各 20 次、同会话 Timeline recording 和性能门槛，故仍为部分通过。
