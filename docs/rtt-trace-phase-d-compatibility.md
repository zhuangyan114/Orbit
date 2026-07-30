# 阶段 D D01：SystemView 兼容事件解析与 RTOS 状态重建

日期：2026-07-30

状态：D01 的兼容范围、官方 source 和本地目标工程盘点已完成；尚未向目标工程集成 SystemView，尚未启用 Channel 2，尚未进行目标板采集。

## 1. 本轮结论

当前 `D:\STM32\project\vet6_led` 只有 P-RTLog 使用的 SEGGER RTT source 和现有 RTTB fixture，没有 SystemView Target Source、FreeRTOS SystemView integration 或 `SEGGER_SYSVIEW_Conf.h`。因此当前工程不能被称为“已启用 SystemView 兼容事件流”，Orbit 也不能在没有官方 target source、配置和实测记录的情况下宣称解析 `.SVDat` 或兼容官方 SystemView 工具。

D01 只确认后续实现边界，不修改 MCU firmware、FreeRTOS kernel、Orbit UI 或生成的 `dist/`。后续实现仍需保持以下通道隔离：

| RTT channel | 当前/计划用途 | 本轮状态 |
| --- | --- | --- |
| 0 | P-RTLog tokenized log | 当前使用；不得作为 SystemView 输入 |
| 1 | RTTB 固定 64-byte sample stream | 当前 Phase C 既有协议；继续保留，不能与 SystemView decoder 混用 |
| 2 | SystemView event stream 的预留 channel | 仅为后续候选；当前未配置、未分配、未读取 |

默认 Timeline 仍是 DAP 数据源。现有 `RttTransport`、`RttStreamScheduler`、`RttChannelRegistry`、RTTB decoder 和 raw/offline parse 路径属于 Phase A-C 成果，本轮不重做，也不把 SystemView 解析塞入 DAP sampling 路径。

## 2. 本地目标工程的 source/config 证据

目标：`D:\STM32\project\vet6_led`，STM32F407VET6，FreeRTOS Kernel V10.3.1。目标工程没有 Git metadata，因此以下 hash 是本地文件快照标识，不是 commit 标识。

| 检查项 | 本地结果 |
| --- | --- |
| `SEGGER_SYSVIEW`/`SYSVIEW` 文本搜索 | 无结果 |
| `SEGGER_SYSVIEW_Conf.h` | 不存在 |
| `SEGGER_SYSVIEW_FreeRTOS.[ch]` | 不存在 |
| `SEGGER_SYSVIEW_Config_FreeRTOS.c` | 不存在 |
| `Sample/FreeRTOSV10/Patch` | 不存在于目标工程 |
| CMake RTT source | `P-RTLog/third_party/segger_rtt/RTT/SEGGER_RTT.c` |
| P-RTLog 日志 channel | `P_RTT_LOG_CHANNEL 0` |
| RTTB source | `Core/Src/rtt_bench.c`，动态申请 RTT up-buffer；Phase C 记录为 Channel 1 |
| RTTB frame | 固定 64 bytes，版本 1；现有 RTTB decoder/offline parser 继续有效 |
| `FreeRTOSConfig.h` | `configUSE_TRACE_FACILITY=1`，`configGENERATE_RUN_TIME_STATS=1`，DWT CYCCNT runtime counter 已启用 |
| SystemView 专用 integration | 未发现 |

关键本地快照 hash：

- `CMakeLists.txt`: `C4B64E6DC97948379F40649716E08AB1C97F37E5F2E243EC9136230F97C88750`
- `Core/Inc/FreeRTOSConfig.h`: `E85C022356E414F3FF27C547B92F8CB190F4E3261075ADC9DBDEB6D3758910F6`
- `Core/Src/freertos.c`: `48D9409450EF72FBE7952435960B2A35324CB05851A620A67111066E2C3D1EA9`
- `Core/Inc/rtt_bench.h`: `44B7242D12C4D3006A4C99FBEE834BCA079190207C96D5ED8EFF44F65E93251F`
- `Core/Src/rtt_bench.c`: `2651818ABB94EC72B05BA36250D9D0087BA2D96898207A68AAD0383473435B4B`
- `P-RTLog/third_party/segger_rtt/RTT/SEGGER_RTT.c`: `51F8969B91694D322BFE6FD0A4A5015E67E89EB46B3CBF6D3A22095CFCB58A50`
- `P-RTLog/third_party/segger_rtt/RTT/SEGGER_RTT.h`: `FE21E9618410807676E5E964EA76DA11A1744D20B5C0125AFC24F1474B09C595`

本地 RTT source 与官方 RTT V8.58.0 的 hash 不同；P-RTLog 当前 branch 也没有记录 SEGGER RTT tag。因此后续不得把本地 RTT copy 直接标记为某个已确认的官方版本。

## 3. 官方 source 基线与采用边界

本轮核对的官方候选版本如下。它们是 D02 的 reference baseline，不代表已经集成到目标工程或通过了目标板验证。

| 组件 | 官方 reference | 用途 | 本轮结论 |
| --- | --- | --- | --- |
| SystemView Target Source | [SEGGERMicro/SystemView V4.12.0](https://github.com/SEGGERMicro/SystemView/tree/V4.12.0)，tag commit `92ca7a8`，2026-06-03 | SystemView event encoding、standard event IDs、timestamp、system description 和 target API | 候选 source baseline；未复制到目标工程 |
| SystemView core | `SYSVIEW/SEGGER_SYSVIEW.c/.h/_Int.h/_ConfDefaults.h` | 事件编码与 RTT 写入 | 必须作为同一版本族检查，不能只拿一个 decoder 头文件 |
| SystemView config | `Config/SEGGER_SYSVIEW_Conf.h` | CPU/timestamp/channel/RTT 配置 | 目标当前缺失；必须显式配置 channel，不能依赖默认 channel 0 |
| FreeRTOS integration | `Sample/FreeRTOSV10/SEGGER_SYSVIEW_FreeRTOS.c/.h` | task、ISR、scheduler、idle 和 RTOS metadata | 目标当前缺失；需针对 FreeRTOS V10.3.1 检查 |
| FreeRTOS V10 patch | `Sample/FreeRTOSV10/Patch/FreeRTOSV10_Core.patch` | 补齐 scheduler/ready/delayed/ISR 等 hook 所需的 kernel extension | 只记录为后续候选；本轮未应用 |
| RTT target source | [SEGGERMicro/RTT V8.58.0](https://github.com/SEGGERMicro/RTT/tree/V8.58.0)，tag commit `4d8feab`，2026-06-03 | SystemView 和 P-RTLog 的 RTT transport 基础 | 官方 reference；目标现有 P-RTLog copy 尚未确认该版本 |

已核对的官方文件 hash（SHA-256）：

- SystemView `SYSVIEW/SEGGER_SYSVIEW.c`: `989C849C919D0737D58EB66902EEAF555C4E05060942BE70AD69D910CA7D24`
- SystemView `SYSVIEW/SEGGER_SYSVIEW.h`: `F530F60ACC79FD0FE9703E1CBEF358C11B76BFCE4185CA825D85B2BC73EFB8C9`
- SystemView `SYSVIEW/SEGGER_SYSVIEW_ConfDefaults.h`: `D83B57898AE664A9DF1D1BB4954E4A9AFCA150E81FF146DCEE7246DDBD5A6A3A`
- SystemView `Config/SEGGER_SYSVIEW_Conf.h`: `754B6476E3ADF71C0C1006982EB4DCAB68390BB7593F5487CC911D6C48292E4F`
- SystemView `Sample/FreeRTOSV10/SEGGER_SYSVIEW_FreeRTOS.c`: `90492A7B552FE5D61FAA56A69EEFA1F0B4B857C3E2C6D7AF3E4172A471E4C086`
- SystemView `Sample/FreeRTOSV10/SEGGER_SYSVIEW_FreeRTOS.h`: `796B63F602EF3291693B68FAB48F44B0662BB2FA2EAC516348A8545B2486CD80`
- SystemView `Sample/FreeRTOSV10/Config/Cortex-M/SEGGER_SYSVIEW_Config_FreeRTOS.c`: `9EA453A7DF391FD06C14BE33132E00D7D88D4F375676BC87CA5C3645952F0109`
- SystemView `Sample/FreeRTOSV10/Patch/FreeRTOSV10_Core.patch`: `F63AD2046F8D89EF23B05DE42743E2A1099F0E15A29653A132BA63101C5EECCC`
- RTT `RTT/SEGGER_RTT.c`: `CAF3D20BC2DEF30E176F937A56C878A363DEC3CD805334EA8173F22E097F1106`
- RTT `RTT/SEGGER_RTT.h`: `B8B6C29ABD72C42082502306FE7CDAA0CA90CA2A9B7821DCEAA3B023B75F4D95`
- RTT `Config/SEGGER_RTT_Conf.h`: `D02EF83F826DD29CDDB466ADCA6C75DBDD71128F18BC6BEF1113CA0127944D6F`

官方 SystemView source README 说明了 `SYSVIEW`、`Config`、FreeRTOS sample 和 RTT 依赖的目录关系：[SystemView V4.12.0 README](https://raw.githubusercontent.com/SEGGERMicro/SystemView/V4.12.0/README.md)。官方 RTT README 也要求将 RTT source 和配置作为 target-side source 一起管理：[RTT repository](https://github.com/SEGGERMicro/RTT)。

## 4. SystemView event 解析范围

官方 `SEGGER_SYSVIEW.c/.h` 的 wire format 是后续 D03 的事实基线：低 event ID 使用预定义格式，扩展 event 使用 length；整数和 timestamp 使用变长编码；event ID 还区分标准事件、OS 事件和 user event。标准事件包括 overflow、ISR enter/exit、task execution/ready/create/info/terminate、trace start/stop、system time、system description、idle、ISR-to-scheduler、timer、stack info、module description、data sample、name/resource、formatted print、init 和 end 等。

这定义了 D03 decoder 的输入能力范围，但不表示 D03 已完成。D03 仍需要独立的 fixture 和单元测试，至少覆盖：

- RTT read fragment 边界，以及一个 read 中包含多个 event；
- varint、delta timestamp、system description 和 sync/init/end；
- overflow、unknown event、truncated event、integer overflow、malformed length；
- 丢包/owner loss/channel gone/end-of-stream 的诊断与 resync；
- 标准事件、FreeRTOS task/ISR 事件和 user event 的原始字段保留；
- 不能安全恢复时，明确标记 data gap，而不是伪造 RTOS 状态。

D01 不批准把“能读 RTT bytes”或“能识别某个 magic”当作 SystemView compatibility。后续 compatibility 必须同时有：官方 source/version 记录、编码级 fixture、语义级状态重建测试，并在授权后增加目标板证据。

## 5. 时间戳与目标配置的候选关系

目标 `main.c` 使用 HSI + PLL，源代码配置得到 HCLK/SystemCoreClock 为 168 MHz；`FreeRTOSConfig.h` 已用 DWT `CYCCNT` 做 runtime stats。官方 Cortex-M SystemView 默认配置也使用 DWT cycle counter，并以 `configCPU_CLOCK_HZ` 作为 timestamp/CPU frequency 的候选来源。

因此后续配置可把以下内容作为待验证候选，而不是当前事实：

- timestamp source：DWT `CYCCNT`；
- timestamp frequency：`configCPU_CLOCK_HZ`，候选值 168 MHz；
- timestamp width：32 bit；
- 32-bit cycle counter wrap：约 25.565 秒；
- SystemView RTT channel：显式设为 2，避免官方默认 channel 0 与 P-RTLog 冲突，也避免占用 RTTB Channel 1。

上述频率、wrap 和 channel 选择必须在 D02 source/config snapshot、构建产物和目标板捕获中重新验证。尤其不能从 CPU clock 配置单独推出实际 target capture 的时间戳正确性。

## 6. FreeRTOS V10.3.1 兼容前置条件

当前工程启用了 FreeRTOS trace facility 和 DWT runtime stats，但没有 SystemView 的 `SEGGER_SYSVIEW_FreeRTOS.h/.c`，也没有官方 V10 integration patch。官方 FreeRTOS/SystemView 说明对旧版 FreeRTOS 需要相应 kernel integration；V10 sample 还包含 scheduler/ready/delayed/ISR 等 hook 所需的 patch。

后续必须逐项检查：

1. `INCLUDE_xTaskGetIdleTaskHandle`、`INCLUDE_pxTaskGetStackStart` 等 SystemView integration 要求与当前 `FreeRTOSConfig.h` 的关系；当前配置没有发现这两个完整配置项。
2. 当前 FreeRTOS kernel/portable 路径是否与官方 V10 patch 的上下文一致，尤其是 `tasks.c`、ARM Cortex-M4F `port.c/portmacro.h` 和 ISR-to-scheduler 路径。
3. Cube/工程生成流程是否会覆盖 integration 文件；D02 需要记录 source ownership 和重新生成后的复现方式。
4. 不能用已有 `configGENERATE_RUN_TIME_STATS` 把 runtime counter 误称为完整 SystemView task event stream。

本轮未修改 `FreeRTOSConfig.h`、FreeRTOS kernel、`freertos.c`、`main.c`、CMake 或 target source。

## 7. 许可证与发布边界

SystemView V4.12.0 target source 的 [LICENSE.md](https://raw.githubusercontent.com/SEGGERMicro/SystemView/V4.12.0/LICENSE.md) 要求保留 copyright、条件和 disclaimer。RTT source 也必须按其对应官方 LICENSE 和 source 版本一起记录。后续若把官方 target source 放入 firmware checkout，应保留原始 license 文件和版本/hash 记录。

SystemView host application 的授权是另一层边界，不能由 target source license 推导。官方页面区分 SystemView host 的 Friendly License、非商业/教育使用和商业授权：[SystemView license](https://www.segger.com/products/development-tools/systemview/license/systemview-installation/)。Orbit 后续应使用“SystemView-compatible event parser/RTOS trace”，不打包或伪装成 SEGGER SystemView host application，也不宣称官方 `.SVDat` 全兼容，除非 D02/D03 有直接证据。

## 8. D02-D05 的进入条件

### D02：官方 reference dataset

- 固定并保存 SystemView V4.12.0 source snapshot、RTT V8.58.0 snapshot、license 和 hash；
- 在授权后选择与目标 FreeRTOS V10.3.1 对应的 official sample/config/patch；
- 形成最小官方 target event fixture，记录 source version、CPU/timestamp/channel 配置和生成方式；
- 在 fixture 中保留 raw bytes，避免只保存已解析字段；
- 在目标工程 build 前做 channel 0/1/2 冲突检查。

### D03：独立 decoder

只消费 Channel 2 的 raw bytes，不改变 Channel 0 log、Channel 1 RTTB、DAP Timeline 或既有 RTT lifecycle。decoder 先输出带 timestamp、event ID、raw fields、diagnostics/data-gap 的中间事件，再交给状态重建层。

### D04：metadata

从 system description、task info、resource/module/name 等事件建立可追踪 metadata；无法确认的字段保留 unknown，不依据名称或 ID 猜测语义。

### D05：RTOS 状态重建

以明确事件驱动 task/ISR/idle/scheduler 状态机，处理 overflow、gap、owner loss、channel gone 和 trace end 后的 unknown 状态。状态机不应把一次 DAP snapshot 或 FreeRTOS runtime counter 当作完整事件历史。

## 9. 证据等级与本轮未做事项

| 证据等级 | 本轮结果 |
| --- | --- |
| source/config inspection | 已完成：目标无 SystemView integration；官方 V4.12.0/V8.58.0 source/tag/license 已核对 |
| Orbit automated tests | 未改 decoder/source，因此未新增或运行 D03 测试 |
| offline fixture parse | 未生成，留给 D02 |
| mock/helper channel test | 未运行；本轮不是 transport/channel 变更 |
| target build/flash | 未执行 |
| real hardware capture | 未执行；没有改变 Native J-Link owner、SWD 4000 kHz 或目标状态 |
| official SystemView host comparison | 未执行 |

本报告是 D01 的 source-grounded compatibility gate，不是 SystemView 功能完成报告。下一步若继续，应先获得将官方 target source、FreeRTOS integration 和显式 Channel 2 配置引入 `vet6_led` 的授权，再进入 D02；在此之前不应实现或启用 Channel 2 decoder。
## D12-D13 target integration addendum — 2026-07-30

The earlier gate text above is historical. The target-side integration and first real-board capture were completed after the official SystemView V4.10 source became available.

- Official target source is vendored under `D:\STM32\project\vet6_led\ThirdParty\SystemView`, with provenance and license recorded in `README-Orbit.md` and `License_SystemView.txt`.
- SystemView writes RTT Up Channel 2. P-RTLog remains on Channel 0 and RTTBench remains on Channel 1. When RTTBench is disabled for an isolated regression, a one-byte Channel 1 reservation keeps the J-Link RTT channel table contiguous so Channel 2 remains readable.
- `SYSTEMVIEW_ENABLE` is an explicit CMake option. The final flashed build used `SYSTEMVIEW_ENABLE=ON` and `RTT_BENCH_ENABLE=ON`; no second J-Link owner or OpenOCD/GDB path was introduced.
- The decoder now follows the official packet rule that the length-prefixed value covers payload data only; for length-prefixed events the timestamp delta follows that payload. This was validated against the real target stream.
- A combined target capture produced 114,672 Channel 2 bytes and 28,185 decoded events with metadata, task, ISR, idle, and scheduler records. Six overflow events make the post-gap RTOS interpretation conservative (`trusted=false`).
- An isolated RTTBench-off regression produced 15,220 bytes, 3,299 events, zero overflow/data-gap diagnostics, and an RTOS snapshot with `trusted=true`.

This establishes source, build, flash, transport, decoding, metadata, and RTOS-state evidence. It does not yet claim byte-for-byte equivalence with an official SystemView `.SVDat` export or long-duration loss-free capture.
