# CMSIS-DAP v1/v2 Timeline 对照记录：ABrobot 无线 DAPLink / STM32F407IGT6

测试日期：2026-10-02。本文时间均为北京时间（Asia/Shanghai）；原始日志时间为 UTC，换算时加 8 小时。

当前状态：**用户完成的 v1、v2 会话均已归档并统计。相同前 120 秒窗口内，v1 约 240.79 Hz/表达式，v2 约 446.03 Hz/表达式，v2 为 v1 的 1.85 倍（+85.23%）。** 这是本设备/固件的一组对照，衡量目标读取完成速率。本次记录没有主动连接、复位、烧录或控制目标。

## 设备与固定配置

| 项目 | 值 | 证据来源 |
|---|---|---|
| 探针商品名 | ABrobot 12装甲板无线DAPLink | 用户提供 |
| 目标板 MCU | STM32F407IGT6 | 用户提供；launch 日志配置为 STM32F407IG |
| Orbit 版本 | 1.1.5 | 用户提供；当前 package.json 同为 1.1.5 |
| SWD 配置 | 4000 kHz | 用户提供；未测量 SWCLK 波形 |
| RTT | 启用；500 ms 轮询，每次最多请求 128 B | 用户设置；读取日志确认 requested=128 |
| Watch | 7 个表达式；500 ms 轮询 | 用户提供；日志确认 expressions=7 |
| Timeline | 2 个表达式 | 启动日志 |
| Timeline 表达式 | `total_wheel_power`、`power_meter_actual_power` | 启动日志 |
| Timeline 目标采样间隔 | 0.2 ms | 启动日志 |
| Timeline 发送间隔 | 15 ms | 启动日志；用户设置 |
| 固件 | `D:/STM32/RoboMaster/26Lao_ShaoBin/Down/build/Debug/frame.elf` | launch 日志 |
| 固件 SHA-256 | `36BE298FAB296D196F976FD1C1EDB3C187053DE7DA48D6FD8B4606CBC613A66A` | 会话结束后本地文件哈希 |

7 个 Watch 表达式的完整名称没有逐项归档，v1 应保持原有列表及展开状态。日志中的 `startPolling: started, 0 watch expressions` 是另一条 DAP Watch 轮询路径的数量；本次 Watch webview 的 `watchEvaluate` 批次持续记录 `expressions=7`，两者不能混为一谈。

## 统计口径

只统计 `continued` 之后、`stopped` 之前目标运行段的成功读取。两项 Timeline 对应日志中的 `readMemoryBatch reads=2 bytes=8 owner=cmsis-dap`；Watch 读取主要对应 `reads=3 bytes=10`，不会混入 Timeline 计数。此匹配方法适用于本次两项标量和原有 Watch 列表，换变量或类型后必须重新确认。

全段统计使用 `估算 Hz/表达式 = (成功 Timeline 批次数 - 1) / (最后一次完成时间 - 第一次完成时间)`。固定时间窗口使用左闭右开区间的成功批次数除以窗口秒数。每个匹配批次读取两个变量，因此一个批次约对应每个表达式各一次读取。完成间隔按 UTC 毫秒日志相邻时间差统计，分位数使用 nearest-rank。

这些是**目标读取完成速率的估算**，没有逐点统计 `ozoneDataSamples` 或 webview 接收/绘制点数；不能作为界面帧率或无丢点证明。`sendMs=15` 仅为配置，不能当成实测发送频率。

Watch 仅在批次耗时 **>=16 ms** 时输出 `[watch] batch` 日志。因此本文 Watch 延迟的 P50/P95/max 只描述已记录的慢批次，不能宣称是所有 Watch 请求的延迟。`reads=3 bytes=10` 的时间间隔用于近似观察 Watch 读取周期，不作为完整请求成功率。

## v2：已完成的会话

### 实际传输与生命周期

- 用户会话启动：18:22:10.074；运行段：18:22:26.662–18:25:34.254。
- USB 身份：VID `FAED`，PID `4870`，product `Horco CMSIS-DAP v2`，serial `507874001033`。商品名与 USB product 分别保留，不以商品名替代设备识别结果。
- 实际 transport 为 **WinUSB / CMSIS-DAP v2**，Bulk IN `0x81`、OUT `0x01`，端点最大包长各 64 B。打开时 `protocolPacketSize=0` 为尚未查询值；后续 RTT 诊断记录 packetSize=64，不将端点包长直接当成协议包长。
- 唯一 owner 为 `cmsis-dap`，helper PID `9840`；结束时 helper 正常退出，exit code `0`，未创建 J-Link owner。
- 本次没有独立读取 DPIDR，也没有测量电气 VTref；这些项目不从旧会话移植。

### Timeline

| 指标 | v2 结果 |
|---|---:|
| 有效运行统计时长 | 187.592 s |
| 成功的双变量读取批次 | 83,800 |
| 估算实际读取率 | **446.71 Hz/表达式** |
| 两变量合计读取量 | 167,600 个标量值（按批次推算） |
| 平均读取完成间隔 | 2.239 ms |
| 完成间隔 P50 / P95 / max | **2 / 4 / 33 ms** |
| 大于 30 ms 的间隔 | 1 次：18:23:04.600–18:23:04.633 |
| 运行段传输超时 / owner 丢失 | 日志未发现 |

| 时间窗口 | 批次数 | 估算 Hz/表达式 |
|---|---:|---:|
| 18:22:26.662–18:23:26.662（60 s） | 26,920 | 448.67 |
| 18:23:26.662–18:24:26.662（60 s） | 26,603 | 443.38 |
| 18:24:26.662–18:25:26.662（60 s） | 26,820 | 447.00 |
| 18:25:26.662–18:25:34.254（7.592 s） | 3,456 | 455.22 |

窗口使用左闭右开范围，因此末次完成只计入总量，没有重复计入窗口。0.2 ms 对应期望 5 kHz，本次实际读取约 446.71 Hz/表达式，没有达到 5 kHz。

### Watch 与 RTT

| 指标 | v2 结果 |
|---|---:|
| 运行段 Watch 读取批次代理数量 | 361 |
| Watch 读取代理间隔 P50 / P95 / max | 516 / 522 / 841 ms |
| 已记录的 Watch 慢批次数量（>=16 ms） | 72，均为 7 个表达式 |
| **已记录慢批次**耗时 P50 / P95 / max | 17 / 22 / 25 ms |
| 已记录慢批次最大读取分片耗时 P50 / P95 / max | 7 / 11 / 14 ms |
| RTT 成功轮询次数 | 368，均请求 128 B |
| RTT 实际返回字节数 / 有数据轮询次数 | 1,137 B / 9 次 |
| RTT 完成间隔 P50 / P95 / max | 509 / 514 / 535 ms |
| RTT overrun | 日志记录 0 次 |

启动停在入口、目标尚未继续运行时，18:22:23.276–18:22:26.355 有 **7 次** `startRtt` 返回 `RttInvalidControlBlock`（DAP/dll 各记录一份，不重复算成 14 次）。继续运行后 18:22:26.863 RTT 启动成功，随后按约 500 ms 轮询。此提示没有计入运行段通信故障；它也不等于 USB 传输失败。没有据此修改协议或运行时实现。

本会话证明给定固件与配置下约 188 s 的运行段可以并行进行 Timeline、7 项 Watch 和 RTT 轮询。RTT 实际只返回 1,137 B，不能推断为持续满载 RTT 场景，也不代表小时级长稳通过。

## v1：已完成的会话

- 用户会话启动：18:28:29.321；运行统计段：18:28:51.688–18:31:19.326，有效时长 **147.638 s**。启动过程包括烧录和入口暂停，不算进 Timeline 运行时长；本轮有效运行不足 3 分钟。
- USB VID/PID 与 serial 同 v2，为 `FAED:4870` / `507874001033`；product 为 `Horco CMSIS-DAP v1`。
- 实际 transport 为 **HID / CMSIS-DAP v1**，input/output report 均为 65 B、report ID=0，RTT 诊断中的协议 packetSize=64。请求值为 `cmsis-dap`，在本实现中是 HID 的别名。
- 唯一 owner 为 `cmsis-dap`，helper PID `42816`；结束时正常退出，exit code `0`。
- 固件、helper、DAP adapter、package.json 的 SHA-256 与 v2 全部一致；启动日志确认相同的两项 Timeline、sampleMs=0.2、sendMs=15，Watch 日志均为 expressions=7 / expanded=7。
- 全段成功双变量读取 35,360 批，估算 **239.50 Hz/表达式**，平均完成间隔 4.175 ms；P50/P95/max 为 **4/6/51 ms**，大于 30 ms 的间隔 32 次。
- 全段有 278 条 Watch 慢批次日志，耗时 P50/P95/max 为 **24/32/55 ms**；读取批次代理间隔为 **528/544/1274 ms**。
- RTT 成功轮询 285 次，均请求 128 B；9 次返回数据，共 1,137 B；完成间隔 P50/P95/max 为 **517/525/557 ms**，overrun=0。
- 启动暂停期间有 **4 次** `RttInvalidControlBlock`；继续运行后 18:28:52.155 RTT 启动成功。运行段未发现通信超时或 owner 丢失。

| 时间窗口 | 批次数 | 估算 Hz/表达式 |
|---|---:|---:|
| 18:28:51.688–18:29:51.688（60 s） | 14,497 | 241.62 |
| 18:29:51.688–18:30:51.688（60 s） | 14,398 | 239.97 |
| 18:30:51.688–18:31:19.326（27.638 s） | 6,464 | 233.88 |

## v1/v2 对照

### 相同 120 秒窗口：主要结论

两轮全段时长不同，主要比例采用各自首次 Timeline 成功读取之后的前 120 秒，使用相同窗口长度和相同计数方法。

| 指标 | v1 / HID | v2 / WinUSB |
|---|---:|---:|
| 120 秒窗口（北京时间） | 18:28:51.688–18:30:51.688 | 18:22:26.662–18:24:26.662 |
| 双变量成功读取批次数 | 28,895 | 53,523 |
| 估算读取 Hz/表达式 | **240.79** | **446.03** |
| v2/v1 | — | **1.8523 倍，+85.23%** |

公式：`(53523 / 120) / (28895 / 120) = 1.8523273923`。计数已用独立 PowerShell 正则和时间窗口与 Python 统计结果交叉核对。

### 各自完整运行段：补充指标

| 指标 | v1 / HID | v2 / WinUSB |
|---|---:|---:|
| 状态 | 已归档 | 已归档 |
| Watch / Timeline 数量 | 7 / 2 | 7 / 2 |
| 同一固件 SHA-256 | 与 v2 一致 | 见上表 |
| 运行段时长 | 147.638 s | 187.592 s |
| 成功的双变量读取批次 | 35,360 | 83,800 |
| 估算读取 Hz/表达式 | 239.50 | 446.71 |
| Timeline 完成间隔 P50/P95/max | 4 / 6 / 51 ms | 2 / 4 / 33 ms |
| Watch 慢批次 P50/P95/max（条件统计） | 24 / 32 / 55 ms | 17 / 22 / 25 ms |
| Watch 读取代理间隔 P50/P95/max | 528 / 544 / 1274 ms | 516 / 522 / 841 ms |
| RTT 成功轮询次数 | 285 | 368 |
| RTT 返回字节数 / 有数据轮询次数 | 1,137 B / 9 次 | 1,137 B / 9 次 |
| RTT overrun | 0 | 0 |
| 运行段通信超时 / owner 丢失 | 未发现 | 未发现 |
| helper 正常退出 | 是 | 是 |

全段读取率比值约 1.8652 倍（+86.52%），与相同窗口的结论接近；正式比较使用上面的 120 秒窗口。Watch 条件统计的阈值会使两轮纳入的慢批次比例不同，不能直接当成所有 Watch 请求的整体改善幅度。

对照以实际打开日志 `transport=hid` / `winusb` 为准，不以请求的 `auto` 或产品名称判断。不同固件、3-Watch/3-Timeline 或 8-Watch/1-Timeline 的历史会话没有用于计算本次比例。两轮 RTT 都返回 1,137 B，但大部分轮询返回 0 B，结论仍限于该实际负载，不能外推到持续满载 RTT。只有各一轮，未做多轮随机顺序或小时级长稳测试。

## 证据与复算

- [v2 原始 DAP 日志](../outputs/cmsis-dap-timeline/2026-10-02-v2-182210/dap.log)
- [v2 原始 DLL 日志](../outputs/cmsis-dap-timeline/2026-10-02-v2-182210/dll.log)
- [v2 统计 JSON](../outputs/cmsis-dap-timeline/2026-10-02-v2-182210/analysis.json)
- [配置、版本和构建物哈希清单](../outputs/cmsis-dap-timeline/2026-10-02-v2-182210/manifest.json)
- [v1 原始 DAP 日志](../outputs/cmsis-dap-timeline/2026-10-02-v1-182829/dap.log)
- [v1 原始 DLL 日志](../outputs/cmsis-dap-timeline/2026-10-02-v1-182829/dll.log)
- [v1 统计 JSON](../outputs/cmsis-dap-timeline/2026-10-02-v1-182829/analysis.json)
- [v1 配置与构建物哈希清单](../outputs/cmsis-dap-timeline/2026-10-02-v1-182829/manifest.json)
- [120 秒窗口对照及构建物一致性 JSON](../outputs/cmsis-dap-timeline/comparison-2026-10-02.json)
- 同目录包含项目 launch/settings 快照。原始日志 SHA-256 写入 analysis.json，固件/helper/adapter/package 哈希写入 manifest.json。

```powershell
python scripts/cmsis-dap/analyze-timeline-log.py outputs/cmsis-dap-timeline/2026-10-02-v2-182210 --timeline-variables 2
python scripts/cmsis-dap/analyze-timeline-log.py outputs/cmsis-dap-timeline/2026-10-02-v1-182829 --timeline-variables 2
```

复算脚本只读取已归档文本并生成 analysis.json，不启动 helper 或访问目标。未修改 `docs/bug-fix-log.md`。
