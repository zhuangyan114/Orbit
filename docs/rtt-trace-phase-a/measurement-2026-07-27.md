# 阶段 A：2026-07-27 实测记录

状态：已完成目标连接、ELF 识别、A03 DAP/Timeline 并发短测和 A04 Channel 1 三组 ReadSize 窗口；已定位并修正测试夹具的 RTT 占用统计问题，修正后的 ELF 已完成目标复测。SWD/Buffer 矩阵、Legacy 对照和有效 Step P95 仍待补测。

## 1. 环境与证据

| 项目 | 记录 |
|---|---|
| 目标工程 | `D:\STM32\project\vet6_led` |
| MCU | `STM32F407VET6` |
| ELF | `D:\STM32\project\vet6_led\build\Debug\vet6_led.elf` |
| 最新构建 ELF SHA-256 | `A3006F2D4E971D9547735D070E0E4E0245493C7493C2823BB12C38A625347FAD` |
| 编译开关 | `RTT_BENCH_ENABLE=ON`，`RTT_BENCH_BUFFER_SIZE=4096` |
| 调试接口 | SWD，4000 kHz |
| 实际 owner | Native；日志记录 `JLINK_Open OK`、`JLINK_Connect OK` |
| 目标状态 | `running` |
| 日志 | `outputs/Log/dap.log`、`outputs/Log/eval.log`、`outputs/Log/dll.log` |

## 2. A03 短测：DAP 读取路径

本次通过 Orbit Plugin API 的 `ozone.record` 调用活动 DAP session 的 `dataSample` 路径，采样配置为 `intervalMs=5`、单次持续约 10 秒。它验证的是活动 DAP 读取链路，不等同于 Webview Timeline 的完整 UI 调度统计。

目标端 RTT 夹具同时处于运行状态，且当时尚未切换到 Channel 1 读取配置，因此以下数据属于“DAP 读取 + RTT 夹具并发”短测，不是纯 DAP 空载基线。

| 变量数 | 有效帧 | 实际 Hz | 间隔 P50 | 间隔 P95 | 最小/最大间隔 |
|---:|---:|---:|---:|---:|---:|
| 1 | 394 | 39.45 | 16 ms | 62 ms | 6 / 65 ms |
| 4 | 342 | 34.24 | 16 ms | 63 ms | 6 / 64 ms |
| 8 | 347 | 34.86 | 16 ms | 63 ms | 6 / 64 ms |
| 16 | 239 | 24.03 | 32 ms | 63 ms | 15 / 78 ms |

结论仅限于本次条件：变量数从 8 增加到 16 时，有效速率明显下降，间隔 P50 翻倍；不能据此推断 0.2 ms 配置已经达到 5 kHz。

## 3. A04 前置状态

已读到目标端夹具计数器，证明带夹具 ELF 正在运行：

- `rtt_bench_attempted_frames`：持续增长；
- `rtt_bench_written_bytes`：持续增长；
- `rtt_bench_dropped_frames`：持续增长。

当前普通调试配置读取 Channel 0，Channel 1 未被专用接收器消费，因此不能用这组计数器估算正常 RTT 吞吐。下一步需停止当前会话并启动 `Ozone: RTT raw bench channel 1`，再记录接收字节、空读、序号缺口和 Step 干扰。

## 4. A04 首轮窗口：Channel 1

当前已启动 `Ozone: RTT raw bench channel 1`，配置为 `ReadSize=16384`、`Poll=1 ms`、目标缓冲 4096 bytes。目标端夹具以尽可能高的速率写入固定 64-byte 帧，以下是连续三个 5 秒窗口：

| 窗口 | 尝试帧增量 | 接受字节增量 | 目标端接受速率 | 丢帧增量 | 丢帧率 |
|---:|---:|---:|---:|---:|---:|
| 1 | 205602 | 209664 | 41932.8 B/s | 202324 | 98.41% |
| 2 | 206012 | 209664 | 41932.8 B/s | 202736 | 98.41% |
| 3 | 206662 | 209664 | 41932.8 B/s | 203408 | 98.43% |

这里的速率是目标端 `SEGGER_RTT_Write` 成功接收进入 RTT buffer 的字节率，不是已直接从主机 API 读取出的字节数；它可证明 Channel 1 正在被消费，但不能单独替代 host-side `readRtt` 字节统计。丢帧率高是因为夹具是饱和发送模式，后续应增加限速/分档测试以区分链路容量和过载行为。

## 5. A04 第二组窗口：4096B/5ms

切换到 `Ozone: RTT raw bench channel 1 (4096B 5ms)` 后，目标状态保持 `running`，连续三个 5 秒窗口如下：

| 窗口 | 尝试帧增量 | 接受字节增量 | 目标端接受速率 | 丢帧增量 | 丢帧率 |
|---:|---:|---:|---:|---:|---:|
| 1 | 205951 | 206976 | 41395.2 B/s | 204425 | 99.26% |
| 2 | 207339 | 208320 | 41664.0 B/s | 202398 | 97.62% |
| 3 | 205212 | 209664 | 41932.8 B/s | 201895 | 98.38% |

与 16384B/1ms 组相比，接受速率基本相同，当前短测尚未显示 ReadSize/Poll 参数对饱和吞吐有明显影响。

## 6. A04 第三组窗口：256B/1ms

切换到 `Ozone: RTT raw bench channel 1 (256B 1ms)` 后，首个窗口包含会话启动预热，未纳入稳态比较；后两个窗口如下：

| 窗口 | 尝试帧增量 | 接受字节增量 | 目标端接受速率 | 丢帧增量 | 丢帧率 |
|---:|---:|---:|---:|---:|---:|
| 预热 | 1127649 | 1145088 | 229017.6 B/s | 1109878 | 98.42% |
| 1 | 206036 | 209664 | 41932.8 B/s | 202770 | 98.41% |
| 2 | 205962 | 209664 | 41932.8 B/s | 202667 | 98.40% |

稳态结果仍约 41.93 KiB/s，与前两组一致。随后控制干扰窗口中目标会话断开，计数器保持为 0，未将该窗口记为“零吞吐”；Step 干扰需要重新连接后单独复测。

## 7. Step 干扰复测结果

重新连接后，在 `256B/1ms` 配置下进行约 20 秒观察。前 3 个 5 秒窗口 RTT 接受速率为 `41.93`、`41.93`、`41.13 KiB/s`，丢帧率均约 `98.4%`；第 4 个窗口计数暂时为 0，随后目标恢复为 `running`。

本次 `step.log` 只新增了 `stackTrace frames=0:0x8004244@0x8004244`，没有形成可计算的 Step 请求到响应延迟，因此不填写 Step P95。该结果说明当前会话的 Step 操作没有产出有效源级 Step 证据，不能据此宣称 RTT 对 Step 的具体延迟影响。

## 8. 主机侧 RTT 统计补强

为区分“目标端写入 RTT buffer 的字节”与“主机 `readRtt` 实际收到的字节”，Orbit 已增加只读 API：

```text
ozone.rtt.getStats
```

返回当前活动 Ozone DAP session 的 `readCalls`、`receivedBytes`、`receivedBytesPerSecond`、`emptyReads`、`readErrors`、`totalReadDurationMs`、`averageReadDurationMs`、`maxReadDurationMs`、RTT 启动错误和当前配置。该接口不回退到 extension-host backend，保持单一 target owner。

代码验证：`npm run typecheck` 通过；全量测试 `109 passed / 1 skipped`；`npm run build` 通过。Reload VS Code 并重新启动 RTT 配置后，下一轮 A04 可直接记录 host-side 接收速率。

## 9. Host-side 统计实测：256B 配置

新 bundle 加载后，`ozone.rtt.getStats` 返回的实际配置为 `bufferIndex=1`、`readSize=256`、`pollIntervalMs=10`。虽然 launch 配置名称写的是 `1ms`，当前 DAP 实现把轮询间隔下限钳制为 10ms，因此本次不能标记为 1ms 测试。

首个累计快照（约 21.1 秒）为：`readCalls=859`、`receivedBytes=204992`、`receivedBytesPerSecond=9699.6 B/s`、`emptyReads=58`、`readErrors=0`、`averageReadDurationMs=8.97`、`maxReadDurationMs=76.5`。

随后连续三个 5 秒增量窗口：

| 窗口 | Host bytes | Host bytes/s | Read calls | Empty | Avg read ms | Read errors |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 52224 | 10444.8 | 203 | 0 | 9.207 | 0 |
| 2 | 50688 | 10137.6 | 198 | 0 | 9.703 | 0 |
| 3 | 47872 | 9574.4 | 188 | 0 | 10.139 | 0 |

这组数据给出了当前实现的主机实际读出速率约 `9.35–10.20 KiB/s`。同窗口目标端计数约为 `205–214 KiB` 写入、约 `203k` 丢帧；目标计数与 host bytes 尚未按同一口径对齐，下一步需读取并记录实际分配的 `rtt_bench_channel`，再核对 Channel 1 映射和计数器语义，暂不把两者合并为单一吞吐结论。

为完成该核对，测试 ELF 已增加只读符号 `rtt_bench_channel_index`、`rtt_bench_buffered_bytes` 和 `rtt_bench_available_bytes` 并重新构建。旧诊断值曾出现 `buffered_bytes=4160`、`available_bytes=63`；进一步读取 RTT 控制块得到 `SizeOfBuffer=4096`、`WrOff=3584`、`RdOff=3648`，确认是随附 SEGGER RTT 版本在环回分支的无符号减法缺陷，实际占用为 `4032` 字节。测试夹具现改为由可写空间计算占用，不修改第三方 RTT 库。最新构建 ELF SHA-256 为 `BC3C2A80E4F8C4B643D46F3E338CA9EEFDAA4BDAE1670DA19D7720BC3A117279`，已在目标上加载并验证。

## 10. 最新诊断构建：目标复测结果

本次修正只影响 `rtt_bench_buffered_bytes` 的诊断计算，不改变 RTT 帧格式、写入速率或 host-side 轮询路径。最新目标快照为 `channel_index=1`、`buffered_bytes=4032`、`available_bytes=63`，说明 4096-byte RTT buffer 的有效容量基本处于满载状态。

5 秒增量窗口如下：

| 指标 | 起始值 | 结束值 | 增量/速率 |
|---|---:|---:|---:|
| Target attempted frames | 878183 | 1078390 | 200207 frames，约 40041 frames/s |
| Target accepted bytes | 919296 | 1128960 | 209664 bytes，约 41.93 KiB/s |
| Target dropped frames | 863929 | 1060848 | 196919 frames，约 98.36% |
| Host received bytes | 226560 | 279296 | 52736 bytes，约 10.55 KiB/s |
| Host read calls | 905 | 1111 | 206，约 41.2 calls/s |

该窗口没有 RTT read error，增量平均单次读取约 `8.67 ms`；目标端产出约为主机实际接收的 4 倍，且 buffer 占用稳定在 `4032/4096`。因此当前结论是：RTT Channel 1 链路和单一 Native owner 工作正常，但现有 host-side 轮询路径在该高压发送夹具下的实测接收能力约为 `10.5 KiB/s`。这不是最终 RTT 高速采样上限，还需要继续完成不同 `ReadSize/Poll` 组合及 Timeline/Step 干扰窗口。

## 11. A04 第二个 host-side 窗口：4096B/5ms 配置

启动 `Ozone: RTT raw bench channel 1 (4096B 5ms)` 后，API 报告实际参数为 `readSize=4096`、`pollIntervalMs=10`。5 秒增量如下：

| 指标 | 起始值 | 结束值 | 增量/速率 |
|---|---:|---:|---:|
| Target attempted frames | 622825 | 824803 | 201978 frames |
| Target accepted bytes | 653184 | 862848 | 209664 bytes，约 41.93 KiB/s |
| Target dropped frames | 612719 | 811422 | 198703 frames，约 98.38% |
| Host received bytes | 653184 | 862848 | 209664 bytes，约 41.93 KiB/s |
| Host read calls | 657 | 865 | 208 |

该窗口 `readErrors=0`，主机增量平均单次读取约 `8.85 ms`，`emptyReads` 增加 156 次。与上一组 256B 配置相比，读取块增大到 4096B 后，主机接收速率从约 `10.55 KiB/s` 提升到约 `41.93 KiB/s`，并与目标端接受写入量对齐；buffer 仍稳定在 `4032/4096`。这说明当前瓶颈主要来自每次 RTT read 的固定调用成本，而不是 Channel 1 或 target owner 失效。

## 12. A04 第三个 host-side 窗口：16384B/1ms 配置

启动 `Ozone: RTT raw bench channel 1` 后，API 报告实际参数为 `readSize=16384`、`pollIntervalMs=10`。约 5 秒增量如下：

| 指标 | 起始值 | 结束值 | 增量/速率 |
|---|---:|---:|---:|
| Target attempted frames | 726103 | 928205 | 202102 frames |
| Target accepted bytes | 758016 | 971712 | 213696 bytes，约 42.74 KiB/s（按 5 秒） |
| Target dropped frames | 714382 | 913191 | 198809 frames，约 98.37% |
| Host received bytes | 758016 | 971712 | 213696 bytes，约 42.74 KiB/s（按 5 秒） |
| Host read calls | 767 | 963 | 196 |

该窗口 `readErrors=0`，`buffered_bytes=4032`、`available_bytes=63` 保持不变。主机接收字节仍与目标端接受写入量对齐，但吞吐没有相对 4096B 配置出现明显提升；考虑窗口时长约 `5.07 s`，两组实际接收能力均约为 `40–42 KiB/s`。因此当前配置建议优先使用 `readSize=4096`，16384B 不带来可见收益，且两者都受约 `10 ms` 单次 RTT read 调度/调用时延影响。

## 13. A03/A04 并发窗口：Timeline + Watch + RTT

保持 `16384B` RTT 配置运行后，Timeline 日志记录了两个表达式 `cnt,aww`，请求参数为 `sampleMs=0.2`、`sendMs=16`；同一时段 Watch 日志持续出现 `batch expressions=7`。Timeline 从 `11:03:50.636` 的 `flush count=1` 到 `11:07:59.034` 的 `flush count=11318`，约 `45.56 flush/s`。这是实际 DAP Timeline 批次速率，不是配置中的 5 kHz 目标采样率。

在并发期间另取约 `5.054 s` 窗口：

| 指标 | 增量/结果 |
|---|---:|
| Target attempted frames | 197899 |
| Target accepted bytes | 209664 |
| Target dropped frames | 194624，约 98.35% |
| Host received bytes | 209664，约 40.52 KiB/s（按实际时长） |
| Host read calls / empty reads | 263 / 211 |
| RTT read errors | 0 |
| RTT buffer | 4032/4096 used，63 bytes free |
| Incremental average read duration | 约 7.52 ms |

目标端接受字节和主机 RTT 接收字节仍然完全对齐，说明 Timeline/Watch 并发没有破坏 RTT Channel 1 的 owner 或读取链路；但 Timeline 实际只达到约 `45.6` 个批次/秒，且 RTT buffer 持续接近满载。当前可确认的结论是：大 ReadSize 能维持约 `40 KiB/s` 的 RTT 接收，Timeline 可以与 RTT 并发运行，但 DAP Timeline 仍受单次目标读和控制/Watch 调度影响，不能把 `0.2 ms` 配置解释为 `5 kHz` 实际采样。
