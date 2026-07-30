# 阶段 C 实机验证记录（2026-07-30）

## 范围

- 目标工程：`D:\STM32\project\vet6_led`
- 目标：STM32F407VE/VET6，SWD 4000 kHz
- owner：Native C++ J-Link helper，单一 DAP owner
- 固件操作：`flashBeforeDebug=false`，未刷写目标
- RTT：Channel 1，RTTB sample，`readSize=4096`
- Timeline signal：`rttb.payload[0]`

测试使用仓库自己的 `dist/debugadapter.js`，以标准 DAP request 建立会话；未使用第二个 J-Link、JLink.exe、OpenOCD 或独立 extension-host backend。

## 测试序列

```text
initialize
launch (Native, RTT Timeline enabled, Channel 1, no flash)
configurationDone
continue
等待 500 ms
dataSamplingStart(source=rtt, rttb.payload[0])
运行采样约 3.5 s
getRttStreamMetrics
pause
dataSamplingStop
disconnect
```

## 结果

### 启动后 halted 缓冲区 smoke

- decoded frames：63
- received bytes：4032（63 × 64）
- sample batches：1
- decode/checksum/sequence/truncated errors：0

该次只验证启动、Channel 1 读取和残留缓冲区解码；目标尚未 Continue。

### Continue 运行态采样

- Timeline sample batches：33
- Timeline points：2709
- scheduler bytesRead：169344
- scheduler readCalls：131
- decoded frames（metrics snapshot）：2646
- decode errors：0
- checksum errors：0
- truncated frames：0
- sequence gaps：41
- missing frames：721412
- dropped bytes/chunks：0/0
- empty read rate：0.679
- max queue depth：4096 bytes
- max queue delay：1 ms
- average/max decode latency：约 0.038/1 ms
- bytes/s：约 48.5 KiB/s
- read calls/s：约 37.5

Pause、`dataSamplingStop` 和 `disconnect` 均成功；Native helper 正常退出，未遗留 helper 进程。RTTB frame checksum 始终正确，sequence gap 来自目标端高频生产与 `Non-blocking, skip` 丢帧语义，不是 decoder 损坏。

## 结论与限制

1. RTTB v1 decoder 已通过真实 Native DAP owner 接收的运行态字节流验证。
2. Channel 1 → `RttStreamScheduler` → `RttTimelineConsumer` → DAP `ozoneDataSamples` 链路可工作。
3. `control > watch > timeline` 约束未被绕过；本次 Pause 能够终止运行态采样。
4. 本记录没有验证长时间稳定性、Reset 后重新启动、文本 RTT 与 RTTB 共用 channel，也没有修改目标固件。
5. 该记录不等同于 C12 完整验收；高丢帧率仍需后续评估目标采样率、RTT buffer 和主机 polling 配额。

## Reset 回归补充

再次执行了 `Continue → RTTB 约 1 s → restart(reset/halt) → Continue 约 1.5 s → Pause`，仍未刷写目标：

- Timeline sample batches：26
- Timeline points：2548
- scheduler bytesRead：159040
- decoded frames：2485
- decode/checksum/truncated errors：0/0/0
- sequence gaps：37，missing frames：3553146
- dropped bytes/chunks：0/0
- average/max decode latency：约 0.029/1 ms

Reset 后 decoder 能重新输出合法帧，未把 reset 前的残帧或 sequence context 错接到新段；`restart`、后续 Continue、Pause、停流和断开均完成。

本次未修改 `docs/bug-fix-log.md`。
