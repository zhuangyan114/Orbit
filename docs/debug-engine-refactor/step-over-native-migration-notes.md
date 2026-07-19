# Native stepOver 迁移结果

Native `stepOver` 已从 TypeScript 的主实验路径迁移到 helper `stepOverSourceLine`。Commander 负责读取可信 PC、解析 DWARF 源码行边界、传递六槽 breakpoint snapshot、记录诊断并验证结果为 `Halted`；helper 负责 Thumb 执行、临时断点生命周期、用户断点恢复和 cleanup。

请求带 `lineStart`、`lineEnd`、`waitTimeoutMs=1000`、`maxInstructionSteps=128`。helper 返回 `pcBefore`/`pcAfter`、classification、instruction count、timing 和 `cleanupOk`。同一源码行内的紧凑循环受预算保护；超限是显式失败，不应继续运行或伪造 stopped。

若 Native stepOver 未启用、owner 不是 Native 或 Native 结果失败，Commander 使用既存 legacy stepOver 路径。该 legacy 代码仍有配置与兼容价值，不能作为重复实现删除。Native 已连接后 owner loss 终止会话，不会用 legacy 热切。

Mock/Commander 测试覆盖基本分类、调用、循环预算和 cleanup。真实硬件已有部分 stepOver 成功证据，但非调用路径的端到端时延超过发布门槛；因此状态是部分通过，详见 [validation-matrix.md](validation-matrix.md)。
