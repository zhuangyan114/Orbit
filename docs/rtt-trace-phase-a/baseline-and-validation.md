# 阶段 A：基线步骤与验证矩阵

状态：A03、A04、A09 已建立步骤；A03 已有 DAP record 路径短测，A04 已完成 Native/Channel 1 的 256B、4096B、16384B 首轮 host-side 窗口；完整 Timeline UI、Legacy、Step 干扰和长期稳定性仍待测。下列步骤不会自动连接或改变目标板。

## 1. 统一测试元数据

每次测试必须记录：

| 字段 | 要求 |
|---|---|
| 日期/时间 | 使用本地时间并记录时区 |
| Orbit 版本/commit | 记录扩展源码版本；若工作区未提交，记录工作区状态 |
| ELF | 绝对路径、文件大小、SHA-256、构建时间 |
| 目标 | MCU、板卡、供电、复位方式 |
| RTOS/固件 | FreeRTOS 版本、是否启用 RTT/Trace、目标端 source commit |
| Probe | J-Link 型号、序列号、DLL 路径和文件版本 |
| 连接 | SWD/JTAG、speedKHz、实际 owner（Native/Legacy） |
| 主机 | Windows 版本、CPU、内存、VS Code/Orbit 版本 |
| 日志 | `outputs/Log/dap.log`、`eval.log`、`dll.log`、`step.log` 对应片段 |

## 2. A03：现有 DAP Timeline 基线

### 测试对象

当前路径是 `dataSamplingStart -> dataSample/readFastDataSampling -> Watch/DAP/J-Link`。当前源码的默认配置目标为 `sampleIntervalMs = 0.2`、`sendIntervalMs = 16`，但这两个配置值不是硬件实际采样频率的证明。

### 步骤

1. 使用同一 ELF、同一目标状态和同一 J-Link 配置，分别选择 1、4、8、16 个稳定标量表达式。
2. 每个变量数量至少运行 30 秒，重复 3 次；每次分别记录 Native owner 和 Legacy owner（若该 owner 可用）。
3. 记录 Timeline 事件中每个数据点的主机时间戳、批次数和点数；同时采集日志。
4. 在采样期间执行固定次数的 Step Into/Over/Out、Continue、Halt 和变量写入，记录请求开始到 stopped/response 的延迟。
5. 记录目标停止、恢复、断点和 owner loss 后的采样恢复时间；不得把缓存值当作新采样点。

### 指标

```text
achievedHz       = acceptedPoints / liveSamplingSeconds
interval jitter  = point timestamp delta 的 P50/P95/P99、最小/最大和标准差
batch rate       = batch count / second
drop rate        = rejected/error/missing points / expected points
step latency     = request -> response/stopped 的 P50/P95/P99
host CPU/RSS     = 测试进程与 VS Code 进程的平均/峰值
```

### 结果表

| Owner | 变量数 | 配置 interval | 实际 Hz | 抖动 P95/P99 | Drop | Step P95 | CPU/RSS | 证据文件 |
|---|---:|---:|---:|---:|---:|---:|---|---|
| Native | 1 | 0.2 ms | 待测 | 待测 | 待测 | 待测 | 待测 | 待填 |
| Native | 4 | 0.2 ms | 待测 | 待测 | 待测 | 待测 | 待测 | 待填 |
| Native | 8 | 0.2 ms | 待测 | 待测 | 待测 | 待测 | 待测 | 待填 |
| Native | 16 | 0.2 ms | 待测 | 待测 | 待测 | 待测 | 待测 | 待填 |
| Legacy | 1/4/8/16 | 0.2 ms | 待测 | 待测 | 待测 | 待测 | 待测 | 待填 |

当前已获得的 A03 证据来自 `ozone.record -> dataSample` 短测，不等同于 Webview Timeline UI 调度：1/4/8/16 个变量的有效频率分别为 `39.45/34.24/34.86/24.03 Hz`，对应 P95 间隔 `62/63/63/63 ms`；详见 `measurement-2026-07-27.md`。因此结果表仍保留“待测”，避免把 record 路径误标为完整 Timeline 基线。

## 3. A04：原始 RTT 吞吐基线

### 目标端夹具要求

- 使用官方 RTT API 和独立测试 Up Channel；不要把普通日志通道当作吞吐测试通道。
- 发送带递增序号的固定模式，至少能检测短读、重复、丢字节和顺序错误。
- 记录目标端写入速率、目标端 overflow/丢弃计数和 buffer 配置。
- 业务 payload 解析关闭；A04 只测原始字节吞吐和调试并发。

### 变量矩阵

| 维度 | 值 |
|---|---|
| Read size | 256、1024、4096、16384 bytes |
| Poll interval | 1、2、5、10、20 ms |
| SWD speed | 1000、2000、4000、8000 kHz；超出探针/目标能力时标记 N/A |
| Target Up Buffer | 由目标 RAM 预算决定，建议先测 1、4、16 KiB |
| Duration | 每个组合至少 30 秒；稳定性另测 10 分钟/1 小时 |
| Owner | Native、Legacy 分开记录 |

### 指标

```text
raw throughput   = receivedBytes / liveSeconds
read latency     = each read call duration 的 P50/P95/P99
empty-read rate  = zero-byte reads / total reads
loss             = target overflow + sequence gap + malformed bytes
control impact   = RTT 开启前后 Step/Continue/Halt 延迟差
recovery         = reset/halt/owner loss 后停止、重启和恢复时间
```

### 结果表

| Owner | Read size | Poll | SWD | Buffer | bytes/s | Empty % | Gap/overflow | Step 影响 | 证据 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| Native | 256 | 10 ms（请求 1 ms） | 4000 kHz | 4 KiB | 约 10.55 KiB/s | 0% | 目标端 drop 约 98.36% | 未形成有效 Step P95 | `measurement-2026-07-27.md` |
| Native | 4096 | 10 ms（请求 5 ms） | 4000 kHz | 4 KiB | 约 41.93 KiB/s | 约 75.0% | 目标端 drop 约 98.38% | 未形成有效 Step P95 | `measurement-2026-07-27.md` |
| Native | 16384 | 10 ms（请求 1 ms） | 4000 kHz | 4 KiB | 约 42.74 KiB/s | 约 73.0% | 目标端 drop 约 98.37% | 未形成有效 Step P95 | `measurement-2026-07-27.md` |
| Legacy | 256/4096/16384 | 1/5/10 ms | 4000 kHz | 1/4/16 KiB | 待测 | 待测 | 待测 | 待测 | 待填 |

说明：当前 DAP 实现将轮询间隔下限限制为 10ms，因此表中同时记录请求值和实际值；`Target drop` 是夹具的 `SEGGER_RTT_Write` 未完整接受帧计数，不等同于已完成 host-side sequence-gap 解析。4096B 与 16384B 的 host bytes 均与 target accepted bytes 对齐，继续增大 ReadSize 未见明显收益。

## 4. A09：验证矩阵

| 层级 | 场景 | 通过标准 | 当前状态 |
|---|---|---|---|
| 文档 | 术语、ADR、MCU 合同互相引用 | 无核心选项悬空；非目标明确 | 已完成 |
| 单元 | 帧边界、长度、版本、序号、CRC/错误、环形缓存 | 覆盖正常、分包、短包、坏包、gap、overflow | 待实现 |
| 集成 | Native helper/Legacy 读取同一 RTT 合同 | 结果语义一致；无第二 owner | 待实现 |
| Mock DLL | 空读、短读、负返回、owner loss、reset | 消费者停止/恢复可诊断；无 fallback 绕过 | 待实现 |
| 回放 | 固定二进制记录 -> parser/UI | 曲线/事件与记录一致；可重复 | 待实现 |
| 性能 | A03 DAP Timeline 与 A04 RTT 原始吞吐 | 数字达到后续 C/B 任务门槛 | 待硬件/性能测试 |
| 真实硬件 | F407IGHx + FreeRTOS + J-Link 并发 Step/Watch/RTT | 日志、环境、固件和 ELF identity 完整 | 未执行 |

## 5. 证据等级

- **源码/配置**：只能证明路径、默认值、接口和候选环境。
- **自动测试/Mock**：证明协议和错误处理，不证明 J-Link/MCU 吞吐。
- **真实硬件**：必须有目标板、J-Link、ELF、固件、日志和可复现步骤；只有这一等级可以填写硬件通过。
