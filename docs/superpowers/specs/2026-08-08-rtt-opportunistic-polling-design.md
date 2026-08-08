# RTT 受限机会式后台轮询设计

日期：2026-08-08

## 目标

在高频 Timeline 采样期间保持 RTT 日志可用，同时维持 Timeline 的调度优先级，并继续由用户配置控制 RTT 轮询间隔。

## 调度合同

- `orbit.rttPollIntervalMs` 仍是唯一的 RTT 轮询间隔设置。
- 间隔采用“完成后计时”语义：一次 RTT 轮询完成后，DAP 至少等待配置的间隔，才提交下一次轮询。
- 错过的轮询周期不排队、不重放、不追赶。
- 每个 DAP 会话最多只能有一个已排队或正在执行的 RTT 读取。
- `readRtt` 保持为 `background` 工作，并继续使用现有的 `rtt-read` 合并键及 generation/abort 隔离。
- `control > watch > timeline > background` 保持不变；已经开始的 owner 调用不能被抢占。

## 生命周期

- 启用 RTT 日志时，RTT 在 launch 阶段启动一次。
- 启动或停止 Timeline 采样不得启动、停止、重置或中止 RTT 日志。
- Timeline 活动标记不得禁止 RTT 轮询调度。
- 只有禁用 RTT 日志，或者 DAP 会话断开、重启、丢失 owner、被释放时，才真正停止 RTT。
- Timeline 启停期间保留 RTT 解码器状态。
- J-Link `startRtt` 和 `stopRtt` 是 `control` 优先级的生命周期操作；`readRtt` 保持 `background` 优先级。

## 轮询循环

每轮最多执行一次“按需启动 RTT”和一次 RTT 读取。该轮结束后，使用当前配置的 `rttPollIntervalMs` 创建唯一的下一次定时器。轮询不使用固定墙钟节拍，也不会形成待处理积压。

RTT 读取失败时保留结构化错误日志，将 RTT 标记为未启动，并在同一个“完成后计时”间隔后重试；不得立即重试。会话停止或 generation 被替换时，取消排队工作并禁止过期字节发布。

## 范围

本次修改只涉及 DAP RTT 轮询和 J-Link RTT 生命周期优先级。不新增 target owner，不改变 RuntimeRouter 路由，不改变 Timeline/Watch 优先级，不引入 Scheduler 全局公平配额，也不修改 native helper 协议字段。

## 测试

- 证明 `dataSamplingActive` 为 `true` 时 RTT 仍继续轮询。
- 证明 Timeline 启动不会调用 `stopRtt`，Timeline 停止也不会重新启动 RTT。
- 证明下一次轮询只能在前一次读取完成并经过 `rttPollIntervalMs` 后开始。
- 保留真正停止 RTT 后对过期完成结果的抑制。
- 证明 J-Link `startRtt` 和 `stopRtt` 使用 `control` 优先级，而 `readRtt` 使用 `background` 优先级。
- 依次运行 RTT、实时采样、Scheduler 和 J-Link channel 聚焦测试，再运行类型检查、构建及完整 Vitest。

## 验收

自动化测试必须通过，并且不得改变现有 owner 或路由合同。真实硬件验收需要单独确认 RTT 输出与 Timeline 采样能够并行工作；将 Timeline 吞吐、P95/最大间隙与关闭 RTT 的基线比较，并检查 RTT 是否发生 overrun 或输出缺失。自动化和 mock 结果不能替代硬件验收。

## 回退

回退 DAP 共存修改以及 J-Link 生命周期优先级映射即可。本方案不涉及持久化数据或协议迁移。
