# RTT Timeline 阶段 C 失败复盘

日期：2026-07-30  
项目：Orbit for VS Code RTT/RTOS Trace  
目标工程：`D:\STM32\project\vet6_led`  
目标：STM32F407VET6，SWD 4000 kHz，单一 Native J-Link owner

## 结论

RTT 作为原始高速采集通道是可行的，但在当前硬件、SWD 带宽、Native DAP owner 和调度模型下，RTT 暂时不能超过原 DAP Timeline 的实时显示体验。

因此阶段 C 的 RTT Timeline 默认路径已暂停：

- 日常 Timeline 默认回到 DAP；
- RTTB 协议、decoder、diagnostics、raw log 和显式实验配置保留；
- 不再把 RTT Timeline 作为默认产品能力宣传；
- 不修改第三方 SEGGER RTT 库，不增加第二个 J-Link owner。

这不是目标端数据协议失败，而是“高吞吐字节流”到“低延迟、连续、可比较的 Timeline 曲线”之间的系统性失败。

## 已完成的部分

### RTTB v1 协议

固定 64-byte frame：

| Offset | Size | 字段 |
|---:|---:|---|
| 0 | 4 | magic：`RTTB` |
| 4 | 1 | version：`1` |
| 5 | 1 | flags/reserved |
| 6 | 2 | frameSize：`64` |
| 8 | 4 | sequence，little-endian |
| 12 | 4 | tick，目标端 HAL tick |
| 16 | 44 | payload |
| 60 | 4 | FNV-1a checksum |

### Host 侧能力

- `RttFrameDecoder` 支持半帧、多帧、拆分 header、空读、短读、无效 magic、无效 version/size、checksum error、sequence gap 和 stream 尾部残留。
- `RttTimelineConsumer` 将 `rttb.payload[N]` 转换为 Timeline snapshot。
- Channel 1 字节流经过已有 `RttStreamScheduler` 和 Native DAP owner，不创建第二个读取线程。
- decode error、checksum error、sequence gap、truncated frame、decode latency 已接入 RTT diagnostics。
- DAP Timeline、Watch、evaluate、variables、memoryReference 和 Step fallback 保持不变。

## 失败表现

视觉验证中出现过以下现象：

- RTT 蓝线比 DAP 曲线慢半拍；
- 蓝线呈阶梯状，数据成批出现；
- 绿色 DAP 线偶尔消失，或截图时延迟出现；
- 两个数值来源看似相同，但曲线无法稳定重合；
- 调整 `readSize` 后，吞吐和视觉平滑度互相牺牲。

这些现象容易被误判为 MCU 计算错误或 RTT checksum 错误。实际证据表明，主要问题发生在主机采集、时间轴对齐和批量渲染阶段。

## 根因分析

### 1. RTT 和 DAP 使用了不同的时间域

RTTB frame 中的 `tick` 是目标端 HAL tick；DAP Timeline 使用的是主机/DAP 会话时间。直接把两者当作同一个时间轴会导致：

- 初始位置偏移；
- 运行一段时间后曲线漂移；
- reset 或重新连接后时间轴跳变；
- 两条本应相同的曲线看起来不同步。

后续加入了 batch 对齐和单调性保护，但这只能修正时间轴映射，不能消除 RTT 读取本身的批次延迟。

### 2. 严格递增时间戳制造了人工漂移

原先的时间戳归一化逻辑把相同 tick 也强制加上 1 ms。raw log 离线分析显示：

- 有 53,932 个有效 RTTB frame；
- 相邻 frame 中有 51,548 次重复 tick，占 95.58%；
- 没有 backward tick；
- 目标 tick 实际跨度约 562,958 ms；
- 错误的严格递增逻辑将跨度扩大到约 614,506 ms；
- 人工增加的漂移约 51,548 ms。

该问题已修复为：相同 tick 可以共享时间戳，只有真正倒退时才重新建立时间基准。

### 3. RTT 读取是批量到达，不是连续到达

阶段 A 已确认：

- `readSize=256`：约 10.55 KiB/s；
- `readSize=4096`：约 41.93 KiB/s；
- `readSize=16384`：没有明显超过 4096B；
- DAP RTT 轮询下限为 10 ms。

真实混合会话中，4096B RTT 读取通常以约 93–110 ms 的批次进入 Timeline。即使批次内部包含很多有效 frame，UI 仍然会表现为“停顿一段时间，再跳一批点”。

`Non-blocking, skip` 还会主动丢弃来不及读取的 frame。sequence gap 因此是预期压力现象，不是 decoder 损坏，但它进一步降低了曲线的连续性。

### 4. 原始吞吐不等于 Timeline 体验

RTT 可以在字节数和 frame 数上超过低频 DAP 读取，但 Timeline 体验取决于：

- 端到端延迟；
- 批次间隔；
- 时间戳是否属于同一时钟；
- 丢帧率；
- UI flush 和点保留策略；
- Watch、control、Timeline 之间的调度竞争。

当前架构优先保证 control 和 Watch，RTT 只能使用剩余的 Native scheduler 配额。因此 RTT 没有形成稳定的低延迟显示通道。

## 尝试过但不足以解决问题的方案

1. **增大 `readSize`**  
   提升了原始吞吐，但没有消除批次延迟；16384B 也没有明显超过 4096B。

2. **减小 `readSize` 和轮询间隔**  
   可能让批次更小，但会增加 read calls、调度竞争和 CPU/ SWD 开销，不能保证整体 Timeline 更快。

3. **固定 RTT/DAP 时间偏移**  
   能改善初始位置，但运行过程中仍会漂移，无法处理 reset、重复 tick 和批次延迟。

4. **强制时间戳严格递增**  
   反而制造了与真实目标时间不符的人工漂移。

5. **同时显示 RTT 和 DAP 曲线进行视觉比较**  
   如果没有相同时间基准、相同 flush 语义和相同采样窗口，比较结果会把传输延迟误认为 MCU 数值不一致。

## 证据分层

### 自动化证据

- `npm run typecheck`：通过；
- 全量 Vitest：`152 passed / 1 skipped`；
- `npm run build`：通过；
- `npm run build:native`：通过；
- `npm run test:cpp-channel:mock`：通过。

### 离线 raw log 证据

`D:\STM32\project\vet6_led\rtt-logs\channel1-20260728.log`：

- 53,932 个有效 64-byte RTTB frame；
- checksum error：0；
- payload error：0；
- 重复 tick 很高，backward tick 为 0；
- sequence gap 与 `Non-blocking, skip` 语义一致。

这证明目标端 frame contract 和 decoder 基本正确。

### 真实硬件证据

真实 Native DAP 会话确认：

- Channel 1 可以读取并解码 RTTB；
- Pause、Step Over、Continue、Reset 后重新运行等生命周期路径可用；
- RTT 无持续 read error；
- 但 RTT 数据以约百毫秒批次进入 Timeline，视觉上落后并阶梯化。

最新默认路径回滚后没有再次进行硬件测量；因此不能把后续时间对齐改动宣称为完整硬件验收。

## 最终配置决策

目标工程 `.vscode/launch.json` 已收缩为三个配置：

1. `Ozone: Debug STM32`：日常调试，明确 `flashBeforeDebug=true`，默认 DAP Timeline；
2. `Ozone: RTTB vs DAP Timeline comparison (flash)`：显式 RTTB 对比实验；
3. `Ozone: RTT raw bench channel 1 (4096B 5ms)`：RTT 吞吐测试，不刷写。

日常使用不需要启动 RTT Timeline，也不需要重新刷写目标来验证这次复盘。

## 后续重新开启 RTT Timeline 的前置条件

除非满足以下条件，否则不应重新把 RTT 设为默认 Timeline source：

- 有明确的低延迟、低丢帧传输预算；
- RTT tick 与 DAP Timeline clock 有稳定校准策略；
- 批次读取、UI flush 和插值策略经过独立验证；
- control、Watch、Timeline 的竞争不会破坏实时性；
- 有新的真实硬件数据证明端到端显示延迟优于 DAP，而不仅是字节吞吐更高。

这些条件属于后续架构阶段，不应在当前阶段继续通过增加 launch 配置或微调 `readSize` 反复试错。

## 对后续 AI 的工作提示

- 不要重做阶段 A/B，也不要再次把 RTT Timeline 作为默认目标；
- 保留 RTTB decoder、protocol tests、diagnostics 和 raw log 证据；
- 优先处理 DAP Timeline、Watch、Step、evaluate、variables、memoryReference、RTOS Views 和整体调试体验；
- 任何新的真实硬件操作都必须先得到用户明确授权；
- 自动测试、源码分析、离线 raw log 和真实硬件结果必须分开报告；
- 除非用户明确确认真实硬件修复，不要写入 `docs/bug-fix-log.md`。
