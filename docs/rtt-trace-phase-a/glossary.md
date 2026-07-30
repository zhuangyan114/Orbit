# 阶段 A：术语与产品边界

状态：A01 已完成（设计文档层面）。本文件冻结产品术语；不表示目标板已经验收。

## 1. 术语表

| 术语 | 本项目定义 | 输入 | 输出 | 明确不包含 |
|---|---|---|---|---|
| `RTT Log` | 现有基于 SEGGER RTT 文本/日志通道的输出能力 | 目标端文本字节、Control Block、Up Buffer | 终端或 Debug Console 文本 | 不保证每条文本都可作为时间序列；不承担 Trace 事件解析 |
| `DAP Timeline` | 当前 Timeline 的主机驱动采样路径 | DAP `dataSamplingStart`、Watch 表达式、J-Link/DAP 读取 | 主机时间戳数值点和曲线 | 不代表目标端以固定周期采样；不提供目标事件流 |
| `RTT Timeline` | 目标端主动采样并经独立 RTT 通道发送的数值流 | 固定 signal descriptor、目标端采样值、目标时间戳 | 带序号/时间戳的数值批次、实时曲线、记录文件 | 不承诺任意 DWARF 表达式都能在目标端周期求值 |
| `RTOS Trace` | 目标端产生的任务、ISR、调度器和用户事件流 | 事件 ID、参数、目标时间戳、RTOS integration | 事件列表、Task/ISR 时间线、CPU Load、状态重建 | 不等同于现有 RTOS 内存快照 View |
| `SystemView-compatible` | 对官方 SystemView target source/API、事件语义和必要编码规则的兼容目标 | 官方 target source 产生的事件 | Orbit 中间事件模型，必要时提供对照/导入 | 在完成逐事件对照前，不声称完整 `.SVDat` 或主机应用兼容 |
| `RttTransport` | 对 Native helper 与 Legacy koffi 共同提供的 RTT 生命周期和读取抽象 | start/stop/read、Control Block 地址、buffer index | 统一结果、能力和错误语义 | 不复制 RTT Control Block 或绕过唯一 J-Link owner |
| `RttStreamScheduler` | 位于 `NativeScheduler` 之上的 RTT 流读取调度器 | 消费者、读取预算、块大小、暂停/取消 | 有配额的 RTT 读取批次和诊断指标 | 不改变 `control > watch > timeline` 的控制优先级 |

## 2. 产品边界

```text
RTT Log       -> 文本输出
RTT Timeline  -> 目标端数值采样 -> 波形/记录
RTOS Trace    -> 目标端运行事件   -> Task/ISR/CPU 状态
现有 Timeline -> DAP 表达式轮询   -> 临时变量观察
```

四者可以同时存在，但不得把“收到 RTT 字节”解释为“已经兼容 SystemView”，也不得把“配置了 0.2 ms 轮询间隔”解释为“目标端已经以 5 kHz 稳定采样”。实际频率、抖动、丢失和调试干扰必须由 A03/A04 基线给出。

## 3. 共同约束

1. 活动 `ozone` DAP 会话只有一个物理 J-Link owner；RTT 读取复用该 owner。
2. Step、Continue、Halt、Reset、断点和变量写入优先于 RTT 读取。
3. 普通 RTT 日志、RTT Timeline 和 RTOS Trace 使用独立逻辑消费者，默认不混用同一 Up Channel。
4. 目标时间戳是采样/事件的权威时间；主机接收时间只用于诊断延迟和排序异常。
5. 所有流都必须有版本、长度、序号或等价的恢复边界，并可报告 overflow、sequence gap 和消费者丢弃。
