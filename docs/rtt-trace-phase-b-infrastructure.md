# RTT Trace Phase B Infrastructure（B06–B11）

本文件记录统一 RTT 基础设施的第一版实现边界。它不改变阶段 A 的测量结论，也不引入目标端高速 Sample 协议。

## B05：Control Block 定位

`RttControlBlockResolver` 按显式地址、ELF 中的 `_SEGGER_RTT`/`SEGGER_RTT` symbol、受控 `auto-search` 的顺序解析 Control Block。自动搜索必须提供有限的 `ranges`、`maxBytes` 和 target memory reader；未提供这些边界时不会扫描未知 RAM。

## B06：Channel Registry

`RttChannelRegistry` 为每个 RTT channel 保存：

- `index`、`name`、`purpose`
- `consumers`：`watch`、`timeline`、`rtt`
- `buffer.targetSizeBytes`：目标端 RTT channel buffer 容量
- `buffer.hostQueueCapacityBytes`：主机端有界队列容量
- `conflicts`：重复 index、重复 name、channel 消失和手工记录的冲突

重复 index/name 不会覆盖现有注册；调用方必须处理失败并从 `conflicts()` 读取诊断。

## B07/B08：RttStreamScheduler

`RttStreamScheduler` 接收一个已有的 `NativeScheduler`，不创建第二个 target owner。优先级映射固定为：

```text
control                -> NativeScheduler control
Watch                  -> NativeScheduler watch
Timeline / RTT stream  -> NativeScheduler timeline
```

每个 stream consumer 有独立的：

- `maxPendingReads`
- 可选 `maxBytesPerSecond`
- `AbortSignal` / `cancel`
- `pause` / resume release function
- channel-specific host queue

暂停会取消该 consumer 的 outstanding stream work；恢复后只允许新的 read，避免把 reset/owner-loss 前的旧请求重新送入 target。

## B09/B10：背压与诊断

`RttBoundedByteQueue` 按字节容量限制主机缓存，溢出时丢弃最旧数据并记录 `droppedBytes`、`droppedChunks`。

`RttStreamDiagnostics` 提供：

- `bytesPerSecond`
- `readCallsPerSecond`
- `emptyReadRate`
- `queueDepthBytes`、`queueDepthChunks`、`maxQueueDepthBytes`
- `maxDelayMs`
- `droppedBytes`、`droppedChunks`
- `cancelledReads`、`errorCount`、`lastError`

这些指标是主机侧诊断，不代表目标端实际采样率；目标端吞吐仍需按阶段 A 的证据和后续发布验收单独报告。

## B11：自动测试边界

当前测试覆盖：

- 短读和成功空读
- 负返回映射为 `ReadFailed`
- `NativeOwnerLost`、channel disappearance
- reset stop/start 生命周期
- bounded queue 丢弃和最大延迟
- pending/byte quota、取消、暂停恢复
- `control > watch > timeline/RTT` 排队顺序

## 运行时接入边界

当前 selector-backed DAP session 已通过 `RttSessionLifecycle` 管理 start/stop 生命周期，Native owner 的真实 `NativeScheduler` 已提供给 `RttStreamScheduler`，RTT log channel 通过 `RttChannelRegistry` 注册，Native RTT read 经过 scheduler 后从 bounded queue 取出。旧 RTT timer 仍保留文本解码和输出逻辑；Legacy owner 使用统一 Transport，但没有伪造 Native scheduler。

下一步接入必须由活动 DAP session 提供当前选中的 `RttTransport` 和对应的 `NativeScheduler`，不能在 extension-host 创建第二个 J-Link owner，也不能通过 Legacy 路径绕过 Native owner。

## B02/B03：Owner protocol alignment

Native helper RTT reads now report the shared `NotStarted` guard, successful short/empty reads, negative DLL returns, and cumulative `stats` (`readCalls`, `receivedBytes`, `emptyReads`, `readErrors`). Legacy reads expose the same lifecycle error boundary through the selected owner, while `supportsOwnerLoss` and `supportsReadStatistics` remain explicit capabilities.

`RttStreamScheduler` marks reads that already hold the owner `NativeScheduler` slot so the Native helper request is not nested back into the same scheduler. Direct DAP reads retain normal scheduler priority. DAP custom request `getRttStreamMetrics` exposes bounded-queue diagnostics without replacing the existing `getRttStats` contract.
