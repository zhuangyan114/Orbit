# 阶段 C：RTTB Sample frame v1

本阶段冻结 `D:\STM32\project\vet6_led` 当前 Channel 1 夹具实际发送的固定帧。它是 Orbit 独立 Sample payload，外层仍使用 SEGGER 官方 RTT Control Block、Up Buffer、channel 和 `SEGGER_RTT_Write` 语义。

## 帧布局

所有多字节整数均为 little-endian；帧总长度固定为 64 字节，不使用对齐填充。

| 偏移 | 长度 | 字段 | 语义 |
|---:|---:|---|---|
| 0 | 4 | `magic` | ASCII `RTTB` (`52 54 54 42`) |
| 4 | 2 | `version` | 无符号整数，当前为 `1` |
| 6 | 2 | `frameSize` | 无符号整数，当前必须为 `64` |
| 8 | 4 | `sequence` | 无符号单调序号；按 32-bit 模运算回绕 |
| 12 | 4 | `tick` | 目标端 `HAL_GetTick()` 原始 tick；v1 单位为目标毫秒 tick |
| 16 | 44 | `payload` | v1 原始固定宽度 payload；不在解码器中猜测字段含义 |
| 60 | 4 | `checksum` | FNV-1a 32-bit，覆盖偏移 `0..59` |

v1 的 payload 信号由显式 Timeline 表达式 `rttb.payload[N]` 选择，其中 `N` 为 `0..43`。这只是当前 bench 的字节级 Sample 视图；具名 signal descriptor、缩放/单位和批量信号布局属于后续 C02/C03，不得把任意 DWARF 表达式伪装成 RTTB 信号。

## 解码和恢复

- `RttFrameDecoder` 是增量、无 target 访问的纯字节解码器；一次 `feed` 可以接收半帧、多个帧或空读。
- 不足 4 字节的 magic 前缀和不足完整帧的尾部会保留到下一次输入。
- 无效 magic、version、size 或 checksum 产生显式错误；解码器从后续 `RTTB` magic 重新同步，不生成伪造样本。
- 合法帧之间的序号不连续产生 `RttSequenceGap`；向前缺失数量按 32-bit 模运算计算，倒序/旧帧标记为 `outOfOrder`。
- `finish('stream-end' | 'channel-gone' | 'owner-lost' | 'reset')` 将残留字节记录为 truncated frame，并清空当前帧边界。新会话/新 reset 通过 `reset()` 清除序号上下文。

## 主机边界

Channel 1 的 Timeline consumer 通过活动 DAP session 提供的 `RttStreamScheduler` 读取，优先级仍为 `control > watch > timeline`。Legacy owner 没有该 Native scheduler 时，显式 RTT source 返回错误；不会回退到 extension-host backend 或创建第二个 J-Link owner。默认 Timeline source 仍是 DAP 表达式采样。

解码错误、checksum 错误、sequence gap、缺失帧数量、truncated frame 和 decode latency 都写入现有 `RttStreamDiagnostics`；transport read/owner-loss/error 计数继续保持独立。
