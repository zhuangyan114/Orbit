# Phase D target validation — 2026-07-30

## Scope

本报告记录 Phase D 官方 SystemView 目标接入后的自动化、真实烧录和真实 RTT Channel 2 采集结果。目标为 `D:\STM32\project\vet6_led`，芯片 `STM32F407VE`，SWD 4000 kHz，使用 Orbit native J-Link helper；没有使用 OpenOCD、GDB server 或 `JLink.exe`。

官方 SystemView V4.10 源码来自 SEGGER SystemView 仓库 tag `V4.10`，复制到目标工程 `ThirdParty/SystemView/`，并保留官方许可证文件。目标侧使用官方 `SEGGER_SYSVIEW.c`、FreeRTOS V10 adapter、RTT Channel 2；既有 P-RTLog Channel 0 和 RTTB Channel 1 仍保留。

## Target integration

- `CMakeLists.txt` 增加 `SYSTEMVIEW_ENABLE` 开关；开启后编译官方 SystemView core、FreeRTOS adapter 和 `Core/Src/systemview_config.c`。
- `ThirdParty/SystemView/Config/SEGGER_SYSVIEW_Conf.h` 将 SystemView 固定到 RTT Channel 2，当前测试 buffer 为 16 KiB，timestamp 为 32 bit，RAM base 为 `0x20000000`，ID shift 为 2。
- `FreeRTOSConfig.h` 在 adapter 最后包含前开启 `SYSVIEW_PORT_PROVIDES_CONTEXT_CHECK`，使官方 adapter 在任务和 ISR 上下文分别调用正确的 tick API。
- FreeRTOS task/port trace hooks 已接入 task ready/delayed/suspended、task switch、SysTick ISR enter/exit 和 PendSV 调度事件。
- `SEGGER_SYSVIEW_Conf()` 在创建任务前初始化，`SEGGER_SYSVIEW_Start()` 在 `MX_FREERTOS_Init()` 后启动；系统描述为 `vet6_led / STM32F407VE / FreeRTOS`，并声明 SVC、PendSV、SysTick。

## Build evidence

测试配置：`SYSTEMVIEW_ENABLE=ON`、`RTT_BENCH_ENABLE=ON`、`RTT_BENCH_BUFFER_SIZE=4096`、`RTT_USE_ASM=0`。

- `cmake --build build\Debug --parallel 2`: passed。
- RAM: 40,344 / 131,072 bytes, 30.78%。
- Flash: 28,488 / 524,288 bytes, 5.43%。
- ELF SHA-256（最终恢复 RTTBench=ON 构建）: `8F2F670D93117E6A778808BE3B971E770A190880002DC352321673186888644B`。
- Orbit DAP flash: `Flash successful`，随后 reset 和 clean disconnect 成功。
- SW-DP probe: `0x2ba01477`。

## Real Channel 2 capture

直接 helper 测试顺序为 `connect -> clearAllBreakpoints -> reset -> halt -> startRtt -> run -> readRtt(channel 2) -> halt -> stopRtt -> disconnect`。真实采集文件为 `C:\Users\22690\AppData\Local\Temp\orbit-systemview-target-20260730.bin`：

- 114,672 raw bytes。
- 28 RTT read calls，0 read errors。
- 同步 marker、`TRACE_START`、`INIT`、`SYSTIME_US`、4 条 `SYSDESC`、3 个任务的 `TASK_INFO/STACK_INFO` 被解码。
- 13,206 次 `TASK_START_EXEC`、12,769 次 `IDLE`、435 次 `ISR_ENTER`、435 次 `ISR_TO_SCHEDULER`、439 次 `TASK_START_READY`。
- 6 个官方 `OVERFLOW` 包；最大原因是 `rttBench` 空闲任务持续 yield，事件生产速率高于当前 helper 轮询速率。状态机因此保守报告 `trusted=false`，没有把溢出后的上下文假装成连续可信状态。
- 解码未出现 `invalid-length`、`resynchronized` 或截断包；Channel 2 的官方 packet length 语义已按目标实流修正为“只包含 payload，不包含 trailing timestamp delta”。

## Host validation

- SystemView decoder、metadata store、RTOS state machine、API span tracker 和 aggregate model 的专项 Vitest：4 个文件、11 个测试通过。
- 真实 Channel 2 首段被 Orbit parser 正确识别为：`TRACE_START -> INIT -> SYSTIME_US -> SYSDESC* -> TASK_INFO/STACK_INFO`，没有发生 `INIT` 后的整体错位。
- 官方 adapter 初次运行曾触发 FreeRTOS `vPortValidateInterruptPriority()` 断言；根因是默认 `SYSVIEW_PORT_PROVIDES_CONTEXT_CHECK=0`。修复为使用 `xPortIsInsideInterrupt()` 后，目标持续运行并产生 RTOS 事件。
- 关闭 RTTBench 的独立回归启用了 1 字节 Channel 1 保留槽，避免 J-Link RTT API 因中间 Up buffer 为空而无法读取 Channel 2；短采样得到 15,220 bytes、3,299 events、0 overflow/data gap，RTOS snapshot 为 `trusted=true`。最终板上构建已恢复 `RTT_BENCH_ENABLE=ON`，保留 Channel 0/1/2 共存。

## Boundary

这轮已证明官方 SystemView target source、FreeRTOS hooks、RTT Channel 2、Orbit raw transport 和 host parser 可贯通；也证明溢出时状态机不越过数据缺口臆造状态。仍未声称 `.SVDat` 文件级兼容或无损长时间录制；下一步应接入 down-channel 的 SystemView host command（task list/system description/heartbeat）以及在低事件率或更快轮询条件下做无溢出长录制。
