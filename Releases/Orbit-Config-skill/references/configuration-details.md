# Orbit Configuration Details

本文是 `Orbit-Config-skill` 的配置参考。配置项名称、枚举值、默认值和范围来自当前仓库的 `package.json`、debug configuration provider、DAP session、Plugin API，以及 J-Link/CMSIS-DAP owner 源码；不要把示例中的芯片、路径或 RTOS 值复制到另一个 firmware workspace。

## Workspace settings

下面是当前源码注册的关键 `orbit.*` workspace settings。旧版 `ozone.*` 设置会在激活时迁移；只有在目标工程需要时才写入，未列出的 VS Code/CMake 设置继续沿用项目现有配置。

| Setting | Type / unit | Default / range | 说明 |
| --- | --- | --- | --- |
| `orbit.jlinkPath` | path | `C:\Program Files\SEGGER\JLink\JLink.exe` | 自动 flash 使用的 J-Link Commander executable。|
| `orbit.jlinkDllPath` | path | `""` | 指定 `JLink_x64.dll`；空值时自动搜索。|
| `orbit.defaultDevice` | string | `STM32F407VG` | `device` 的共享默认值；必须改成当前真实 MCU。|
| `orbit.defaultInterface` | `SWD` / `JTAG` | `SWD` | 默认 debug interface。|
| `orbit.defaultSpeed` | number, kHz | `4000` | 默认 target interface speed。|
| `orbit.defaultProgram` | path | `""` | 默认 ELF/AXF；空值时扫描 `build/Debug`、`build/Release`、`build`。|
| `orbit.defaultSvdFile` | path | `""` | 外部 Peripheral Viewer 使用的 SVD 默认路径。|
| `orbit.svdAutoDownload` | boolean | `true` | 本地没有匹配项时按需下载并缓存对应 STM32 系列的一个 Keil DFP，只提取当前芯片 SVD。|
| `orbit.defaultRtos` | string | `""` | 默认 RTOS 名称（例如 `FreeRTOS`），用于 Orbit 内置 RTOS 面板及标准 DAP `rtosInfo`。|
| `orbit.logging.enabled` | boolean | `true` | 是否记录 Orbit 内部诊断日志（`outputs/Log/`）。|
| `orbit.logging.clearOnStart` | boolean | `true` | 扩展或调试会话启动时是否清空旧日志。|
| `orbit.rttLogEnabled` | boolean | `true` | 是否读取 SEGGER RTT。|
| `orbit.rttBufferIndex` | number | `0`, `0..15` | RTT up-buffer index。|
| `orbit.rttPollIntervalMs` | number, ms | `50`, `10..5000` | RTT poll interval。|
| `orbit.rttReadSize` | number, bytes/poll | `4096`, `64..65536` | 每轮 RTT 最大读取字节数。|
| `orbit.rttControlBlockAddress` | string | `""` | RTT control block address；J-Link 可自动检测，CMSIS-DAP / RMLink 可从 ELF 符号定位或使用显式地址。|
| `orbit.rttStripAnsi` | boolean | `true` | 仅去除写入 Debug Console 的 ANSI 控制序列。|
| `orbit.rttLogTarget` | `terminal` / `debugConsole` / `both` | `terminal` | RTT 输出位置。|
| `orbit.pRtLogEnabled` | boolean | `false` | 是否把 RTT bytes 解码为 P-RTLog tokenized frames。|
| `orbit.pRtLogRoot` | path | `""` | P-RTLog root 配置/诊断值；当前 decoder 不从该目录搜索 token。|
| `orbit.watchPollIntervalMs` | number, ms | `500`, `100..10000` | Watch Webview 可见时的刷新计时基准。|
| `orbit.timelineSampleIntervalMs` | number, ms | `0.2`, `0.1..10000` | Timeline target sampling 目标间隔。|
| `orbit.timelineSendIntervalMs` | number, ms | `16`, `1..10000` | Timeline 向 Webview 发送更新的间隔。|
| `orbit.flashBeforeDebug` | boolean | `true` | 启动调试前默认是否烧录固件。|
| `orbit.recentSessions` | number | `10`, `0..50` | 保留的最近调试会话数量。|
| `orbit.automation.enabled` | boolean | `false` | 是否开启本机 `127.0.0.1` Automation API v1。|
| `orbit.automation.allowedScopes` | string[] | `["read"]` | 自动化接口允许授予的最高权限范围（`read` / `session.control` / `breakpoints.write` / `view.write` / `record` / `rtt.control` / `variables.write` / `memory.write` / `flash`）。|

`orbit.flashBeforeDebug` 默认 `true`。launch 层可覆盖它：J-Link 使用 Commander 烧录，CMSIS-DAP / RMLink 按 `flashBackend`（默认 `auto`）优先使用原生快速算法或随扩展提供的 OpenOCD 独立烧录；`false` 跳过所有 Flash 操作。

External Views 的 tracker arrays 不是 Orbit 自有 setting，但可以在目标 workspace 中加入（Orbit 已内置原生 RTOS 面板，不再写入 `mcu-debug.rtos-views.trackDebuggers`）：

```json
{
  "memory-view.trackDebuggers": ["orbit", "ozone"],
  "mcu-debug.debug-tracker-vscode.trackDebuggers": ["orbit", "ozone"]
}
```

合并时保留数组已有元素，并确保 `"orbit"` 与兼容别名 `"ozone"` 不重复。

## Launch configuration

默认只生成或更新一项精简配置。芯片型号必须来自当前工程证据；其余与默认行为相同的字段不要重复写：

```jsonc
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Orbit Debug",
      "type": "orbit",
      "request": "launch",
      "device": "STM32F407VET6"
    }
  ]
}
```

省略 `probe` 等价于 `auto`：先检测 J-Link，J-Link 不可用时才检测 CMSIS-DAP/DAPLink；两者同时连接时始终选择 J-Link。默认还包括 SWD、4000 kHz、Native auto、Flash、RTT，以及自动 ELF/SVD 解析。`deviceName` 自动跟随 `device`。

只有自动 ELF 选择不唯一或不正确时才写 `program`；只有用户要求固定/离线 SVD 时才写 `svdFile` / `svdPath`。要强制使用 DAPLink，增加 `"probe": "cmsis-dap"`；要强制使用 J-Link，增加 `"probe": "jlink"`；要跳过擦除、编程和校验，增加 `"flashBeforeDebug": false`。

默认配置不包含以下 DAPLink 选择器：

```json
"cmsisDapVid": "C251",
"cmsisDapPid": "F001",
"cmsisDapSerial": "LU_2022_8888"
```

上面的值是特定验收设备示例，不是通用默认值。只有用户明确要求绑定该设备时，才把所需选择器加入显式 `probe: "cmsis-dap"` 配置；仅检测到设备或只连接一只 probe 不构成绑定要求。

当前 `package.json` debug schema 注册的 launch properties 如下。`default` 是 schema/config provider 的默认值，不代表当前板卡一定应使用该值。

| Property | Type / unit | Default / range | 说明 |
| --- | --- | --- | --- |
| `device` | string | `STM32F407VG` | 目标 device；J-Link 用于 DLL 选型，CMSIS-DAP 用于芯片/Flash Algorithm 校验。|
| `deviceName` | string | 跟随 `device` | 外部 MCU Views 兼容别名；通常无需填写。|
| `probe` | `auto` / `jlink` / `cmsis-dap` / `rmlink` | `auto` | 每个 session 的物理 target owner 类型；`auto` 固定 J-Link 优先。|
| `rmlinkDeviceId` | string | `""` | RMLink 的 12 位十六进制设备 ID；`probe: "rmlink"` 时可省略，自动选择唯一在线且已配对设备。|
| `cmsisDapTransport` | enum | `auto` | `auto`、`cmsis-dap-v2`/`winusb`、`cmsis-dap`/`hid`、`tcp`（网络探针，地址写在 `cmsisDapPath`，`host[:port]`，默认端口 3241）。|
| `cmsisDapXrSampling` | boolean | `false` | 是否启用 XR-DAP 厂商 Timeline 探针端采样；默认关闭，与传输类型独立。|
| `cmsisDapSerial` | string | `""` | 可选 probe serial 筛选。|
| `cmsisDapVid` / `cmsisDapPid` | string | `""` | 可选 USB VID/PID 筛选。|
| `cmsisDapPath` | string | `""` | 可选设备 interface path 精确筛选。|
| `cmsisDapFlashAlgorithmPath` | path | `""` | 可选、许可和目标适配已确认的 Flash Algorithm。|
| `program` | path | `${workspaceFolder}/build/Debug/frame.elf` | ELF/AXF；provider 可能自动从 build 目录选择。|
| `svdFile` | path | 自动解析 | SVD 兼容字段；显式值优先级最高。|
| `svdPath` | path | 跟随 `svdFile` | SVD 兼容字段；未填写时可从工作区、本机 Pack、缓存或按需下载解析。|
| `interface` | `SWD` / `JTAG` | `SWD` | 调试接口；当前 CMSIS-DAP 与 RMLink 路径使用 SWD。|
| `speedKHz` | number, kHz | `4000` | target interface speed。|
| `flashBeforeDebug` | boolean | `true` | 使用所选探针烧录/校验；Restart 时 ELF 未变化跳过烧录并复位直接运行，变化后重烧并停在 `runToEntryPoint`；`false` 明确跳过。|
| `flashBackend` | `auto` / `native` / `openocd` | `auto` | 为 DAPLink 与 RMLink 选择烧录方式：`auto` 优先原生快速算法，其余受支持 STM32 用内置 OpenOCD；`native` 仅用内置算法；`openocd` 显式使用内置 OpenOCD。|
| `runToEntryPoint` | string / `false` | `main` | J-Link、CMSIS-DAP 和 RMLink 烧录后停靠符号（Restart 仅程序变化后停靠）；`false` 禁用。|
| `rtos` | string | `""` | 目标 RTOS 名称（如 `FreeRTOS`），用于 Orbit 内置 RTOS 面板及标准 DAP `rtosInfo`。|
| `rtosSnapshotPort` | object | 未配置 | FreeRTOS 栈水位与运行统计端口口径（`source`、`stackGrowth`、`stackFillByte`、`runtime`）；缺省时相关列保持不可用。|
| `loggingEnabled` | boolean | `true` | 是否启用 Orbit 内部诊断日志。|
| `clearLogsOnStart` | boolean | `true` | 启动会话时是否清空旧诊断日志。|
| `rttLogEnabled` | boolean | `true` | 是否轮询 RTT。|
| `rttBufferIndex` | number | `0` | RTT up-buffer index；运行时限制为 `0..15`。|
| `rttPollIntervalMs` | number, ms | `50` | RTT poll interval；schema 限制 `10..5000`。|
| `rttReadSize` | number, bytes/poll | `4096` | RTT 每轮读取量；schema 限制 `64..65536`。|
| `rttControlBlockAddress` | number/string, address | `""` | 可写十进制或 `0x` 地址；空值自动检测。|
| `rttStripAnsi` | boolean | `true` | Debug Console 的 ANSI 处理。|
| `rttLogTarget` | enum | `terminal` | `terminal`、`debugConsole` 或 `both`。|
| `pRtLogEnabled` | boolean | `false` | P-RTLog tokenized RTT decoder 开关。|
| `pRtLogRoot` | path | `""` | 当前为 decoder 诊断配置，不是 token 搜索目录。|

源码还支持 `elfPath` 作为 `program` 的兼容别名。`probe`、`interface`、`device`、`speedKHz`、`flashBeforeDebug`、`rtos` 和所有 RTT/P-RTLog/owner 字段最终由 DAP session 使用。

项目实际值确认顺序建议：`.ioc` 的 `Mcu.Name`、startup file、linker script、CMake compile definitions、SVD 文件名、同板已知可用配置。`device`、最终解析的 `deviceName`/SVD 和 active ELF 必须属于同一目标。

## ARM GCC toolchain

如果工程没有 ARM GCC toolchain，可创建 project-local `cmake/gcc-arm-none-eabi.cmake`：

```cmake
set(CMAKE_SYSTEM_NAME Generic)
set(CMAKE_SYSTEM_PROCESSOR arm)
set(CMAKE_TRY_COMPILE_TARGET_TYPE STATIC_LIBRARY)

find_program(ARM_GCC arm-none-eabi-gcc REQUIRED)
get_filename_component(ARM_TOOLCHAIN_BIN_DIR "${ARM_GCC}" DIRECTORY)
set(CMAKE_C_COMPILER "${ARM_TOOLCHAIN_BIN_DIR}/arm-none-eabi-gcc.exe")
set(CMAKE_CXX_COMPILER "${ARM_TOOLCHAIN_BIN_DIR}/arm-none-eabi-g++.exe")
set(CMAKE_ASM_COMPILER "${ARM_TOOLCHAIN_BIN_DIR}/arm-none-eabi-gcc.exe")
set(CMAKE_OBJCOPY "${ARM_TOOLCHAIN_BIN_DIR}/arm-none-eabi-objcopy.exe")
set(CMAKE_SIZE "${ARM_TOOLCHAIN_BIN_DIR}/arm-none-eabi-size.exe")
```

已经存在 CMake/CubeMX layout 时，优先合并现有 preset 或 VS Code CMake Tools setting，不要重写 `CMakeLists.txt`。

## J-Link DLL and flash

调试控制使用 `JLink_x64.dll`；`orbit-jlink-helper.exe` 在独立进程中加载 DLL。`orbit.jlinkDllPath` 非空且存在时优先使用；否则源码会按版本目录、SEGGER Ozone 目录和 `JLink_x64.dll` 进行搜索。

自动 flash 使用 `orbit.jlinkPath` 指向的 `JLink.exe`，并将 `device`、`interface`、`speedKHz` 写入 J-Link Commander script。flash 不是持续调试控制 owner；已有固件时可将 `flashBeforeDebug` 设为 `false`。


## CMSIS-DAP / DAPLink

`probe: "auto"` 先用短生命周期 helper 检测 J-Link，只有 J-Link 不可用时才枚举 CMSIS-DAP；发现 helper 会在正式 owner 建立前释放。`probe: "cmsis-dap"` 启动 `out/native/win32-x64/orbit-cmsis-dap-helper.exe`，不加载 J-Link DLL。`cmsisDapTransport: "auto"` 优先 WinUSB v2 并兼容 HID v1。标准配置保持未绑定；用户明确要求选择特定设备时，才使用 serial、VID/PID 或 interface path。

CMSIS-DAP owner 负责协议 framing、SWD/DP/AP、Cortex-M 控制、FPB、内存、Flash Algorithm 和内存型 RTT。它不回退到 J-Link，也不允许 Watch、Timeline、RTT 或 Viewer 创建第二个 target owner。

默认 `flashBeforeDebug: true` 按 `flashBackend`（默认 `auto`）处理：已登记型号使用原生快速 Flash Algorithm，其余受支持 STM32（部分 F1/F4/H72x/G0/G4）在建立调试 owner 前通过随扩展提供的 OpenOCD 子进程完成独立烧录与校验（OpenOCD 进程完全退出后再建立调试 owner）；`false` 不得发出 Flash 操作。使用自定义 `cmsisDapFlashAlgorithmPath` 时，必须确认来源、许可、目标范围、RAM 布局和 ABI。

## J-Link owner

Native helper 路径为 `out/native/win32-x64/orbit-jlink-helper.exe`。启动失败时释放 helper 并返回错误。已连接 owner 丢失时结束会话，重新连接需开启新会话。

Native scheduler 的优先级是 `control > watch > timeline > background`。step、continue、halt、reset、breakpoint、Flash 和 write 属于 control work；RTT/RTOS refresh 属于 background。不要通过第二个 owner 绕过调度。

## 内置 RTOS 面板与 FreeRTOS 全面板

Orbit 自 `1.2.2` 起在底部面板区原生内置 **RTOS** 视图（`ozoneRtos`），直接从 ELF DWARF 类型图推导 FreeRTOS 结构偏移并通过当前活动会话探针读取，**不再依赖外部 `mcu-debug.rtos-views` 扩展，也不再写入 `mcu-debug.rtos-views.trackDebuggers` 或 `orbit.rtosViewsAutoRefresh`**。

要一次配齐内置 RTOS 面板的全面板能力（Tasks + 栈水位 + runtime/CPU% + Queue/Mutex/Sem + Timers/Heap），**配置 skill 默认一次做完**：

1. launch 的 MCU（`device`，用于 RAM 范围校验）、active ELF（带完整 `-g`/`-g3` DWARF，禁止 `strip`）、SVD、`rtos`（以及核对后的 `rtosSnapshotPort`）一致；
2. firmware USER CODE 具备 Tasks + 栈边界 + runtime/CPU% + Queue/Mutex/Sem 全面板所需的宏、DWT 时基和 queue registry；
3. 如用户还需要 SEGGER SystemView Trace 泳道与事件分析，按 `Releases/docs/RTOS诊断功能使用教程.md` 接入 SystemView 并配置独立 `SysView` RTT 通道。

### FreeRTOS / CMSIS-RTOS v1

FreeRTOS 10.x 使用 CMSIS-RTOS v1 wrapper 时，launch 示例为：

```jsonc
{
  "type": "orbit",
  "request": "launch",
  "name": "Orbit: FreeRTOS STM32F407",
  "program": "${workspaceFolder}/build/Debug/firmware.elf",
  "device": "STM32F407VE",
  "rtos": "FreeRTOS",
  "rtosSnapshotPort": {
    "source": "GCC/ARM_CM4F",
    "stackGrowth": "down",
    "stackFillByte": 165,
    "runtime": {
      "source": "DWT_CYCCNT",
      "frequencyHz": 656250,
      "countsDuringSleep": false
    }
  }
}
```

`rtos` 必须写 `FreeRTOS`，不要写 `CMSIS-RTOS`。`rtosSnapshotPort.runtime.frequencyHz` 必须填写真实计数器有效频率（例如使用 `DWT->CYCCNT >> 8` 时应为 `SystemCoreClock / 256`）。J-Link、CMSIS-DAP 与 RMLink 均可复用唯一活动调试会话提供快照与 SystemView RTT 读取，不能并存第二个 target owner。

固件侧至少要从同一个 active ELF 中确认 FreeRTOS 内核符号，例如 `uxCurrentNumberOfTasks`、`pxReadyTasksLists`、`xDelayedTaskList1` 和 `pxCurrentTCB`（多数为 `static`，靠 DWARF 解析，因此保持 Debug `-g`）。运行中读取遇链表变动会标明 `partial`，需要精确核对或死锁确认时请暂停目标后刷新以获取 `halted-consistent`。

### CubeMX 全面板默认补丁

CubeMX 默认 `FreeRTOSConfig.h` 通常不含 trace / stack-high / runtime-stat。配置 skill **默认**写入 USER CODE，而不是只报告缺口。用户明确说不要改固件时才跳过。

在 `FreeRTOSConfig.h` 的 `USER CODE BEGIN Defines` 加入（已存在且为 1 的宏不要重复定义）：

```c
#define configUSE_TRACE_FACILITY              1
#define configRECORD_STACK_HIGH_ADDRESS       1
#define INCLUDE_uxTaskGetStackHighWaterMark   1
#define INCLUDE_xTaskGetCurrentTaskHandle     1
#define configGENERATE_RUN_TIME_STATS         1
#if defined(__ICCARM__) || defined(__CC_ARM) || defined(__GNUC__)
extern void configureTimerForRunTimeStats(void);
extern unsigned long getRunTimeCounterValue(void);
#endif
#define portCONFIGURE_TIMER_FOR_RUN_TIME_STATS configureTimerForRunTimeStats
#define portGET_RUN_TIME_COUNTER_VALUE getRunTimeCounterValue
```

`configQUEUE_REGISTRY_SIZE` 若未定义或为 `0`，在同一 USER CODE 区改为至少 `8`。不要开 `configUSE_STATS_FORMATTING_FUNCTIONS`，RTOS Views 读 TCB 的 `ulRunTimeCounter`，不需要 `vTaskGetRunTimeStats()`。

CubeMX 若已生成空的 `configureTimerForRunTimeStats` / `getRunTimeCounterValue` 桩，填桩，不要再定义一份。否则写在 `freertos.c` 的 `USER CODE BEGIN Application`。默认用 DWT CYCCNT，不占用 HAL tick 定时器（H7 上常见为 TIM23）：

```c
void configureTimerForRunTimeStats(void)
{
  CoreDebug->DEMCR |= CoreDebug_DEMCR_TRCENA_Msk;
  DWT->LAR = 0xC5ACCE55; /* Cortex-M7 CoreSight unlock; M3/M4 可保留 */
  DWT->CYCCNT = 0;
  DWT->CTRL |= DWT_CTRL_CYCCNTENA_Msk;
}

unsigned long getRunTimeCounterValue(void)
{
  /* 将计数降到约 1–10 MHz（≥ 10× tick），避免 CYCCNT 在高频 CPU 上数秒溢出 */
  return DWT->CYCCNT >> 8;
}
```

若工程已有更快的空闲 32-bit 定时器并已被 runtime stats 使用，保留现有时基，不要改成 DWT。

### Queue / Mutex / Sem 面板

要显示 Queue/Mux/Sem，必须同时：

1. `configQUEUE_REGISTRY_SIZE > 0`（否则 `xQueueRegistry` 会被 `--gc-sections` 丢掉）；
2. 对每个要显示的对象调用 `vQueueAddToRegistry(handle, "persistent_name")`，名称用字符串字面量。

应用里没有任何 registry 对象时，默认在 `freertos.c` 对应 USER CODE 创建并注册：

```c
rtosViewQueueHandle = xQueueCreate(4, sizeof(uint32_t));
vQueueAddToRegistry(rtosViewQueueHandle, "rtosViewQueue");

rtosViewMutexHandle = xSemaphoreCreateMutex();
vQueueAddToRegistry(rtosViewMutexHandle, "rtosViewMutex");

rtosViewSemaphoreHandle = xSemaphoreCreateBinary();
vQueueAddToRegistry(rtosViewSemaphoreHandle, "rtosViewSemaphore");
```

已有业务 IPC 并已注册则不重复创建。创建后编译，并用 `arm-none-eabi-nm` 确认 ELF 含 `xQueueRegistry`、`vQueueAddToRegistry`、`ulRunTimeCounter`、`ulTotalRunTime`。不要在未授权时 flash。

`vet6_led` 的 `RTT_BENCH_ENABLE=ON` fixture 会额外创建 `rttBench`，并注册同名 `rtosViewQueue` / `rtosViewMutex` / `rtosViewSemaphore`。全面板默认对象与该 fixture 同名时不要重复创建。该 fixture 的 4 任务快照不是所有工程的固定期望；未开 bench 时任务数以工程实际线程 + IDLE 为准。

## RTT and P-RTLog

RTT 必须由 firmware 初始化 SEGGER RTT control block。J-Link DLL 还要导出 RTT control/read 函数；CMSIS-DAP 通过当前 owner 读取目标内存，需可解析 `_SEGGER_RTT` 或提供 `rttControlBlockAddress`。`rttStripAnsi` 仅影响 Debug Console；terminal 输出保留 ANSI。RTT `ESC[2J` 会触发 Debug Console 清屏行为。

P-RTLog frame 格式是：

```text
[2-byte little-endian length][frame payload]
```

frame 的前 4 bytes 是 little-endian token。decoder 从 active ELF 的 `.pw_tokenizer.entries` 读取 token metadata，并处理整数、浮点、字符串、指针和 printf 类参数；未知或截断 frame 应报告 decoder diagnostic。`pRtLogRoot` 当前不会让 decoder 从该目录加载 token。

## MCP and Plugin API

MCP server：`Releases/mcp/orbit-mcp-server.js`，stdio 进程；它通过 Node automation client 读取 `ORBIT_AUTOMATION_REGISTRY`（Windows 默认 `%LOCALAPPDATA%\Orbit\automation\registries.json`），握手后调用 `POST /v1/rpc`。多个相同 `projectId` 实例必须指定 `instanceId`。当前 tools：`orbit_instances`、`orbit_handshake`、`orbit_project_describe`、session/control/breakpoint/memory/expression/diagnostics tools、RTOS/Trace tools（`orbit_rtos_capabilities`、`orbit_rtos_snapshot`、`orbit_trace_list`、`orbit_trace_status`、`orbit_trace_start`、`orbit_trace_stop`、`orbit_trace_events`、`orbit_trace_statistics`），以及 `orbit_status`、`orbit_read_many`、`orbit_write_many`、`orbit_record`、`orbit_experiment_run`。`tools/list` 对全可选工具也发出 `required: []`，避免 opencode 把缺失字段序列化成 `required: null` 后被严格中转拒绝。

如果活动 `orbit` DAP session（或旧 `ozone` 别名）存在，runtime reads/writes/status 通过该 DAP session 路由；DAP 请求失败应返回错误，不回退到另一个 Extension Host target owner。

## Validation commands

按 shell 和工程情况选择：

```powershell
Get-Command cmake
Get-Command ninja
Get-Command arm-none-eabi-gcc
Get-Command arm-none-eabi-objdump
Get-Command node
Test-Path "C:\Program Files\SEGGER\JLink\JLink_x64.dll"
Test-Path ".\out\native\win32-x64\orbit-jlink-helper.exe"
Test-Path ".\out\native\win32-x64\orbit-cmsis-dap-helper.exe"
cmake --preset debug
cmake --build --preset debug
arm-none-eabi-nm build/Debug/*.elf | Select-String "pxCurrentTCB|ulRunTimeCounter|ulTotalRunTime|xQueueRegistry|vQueueAddToRegistry"
```

对无注释 JSON：

```powershell
Get-Content .vscode\settings.json -Raw | ConvertFrom-Json | Out-Null
Get-Content .vscode\launch.json -Raw | ConvertFrom-Json | Out-Null
```

JSONC 必须使用 JSONC-aware parser 或 VS Code 检查，不要删除注释来“修复”验证。

## Final report template

最终报告使用以下英文字段名，内容可用中文：`Files changed`、`Launch`、`Probe`、`Transport`、`Device`、`Interface`、`Speed`、`SVD`、`RTOS`、`RTOS Views full panel`、`Owner`、`J-Link DLL/Helper`、`RTT/P-RTLog`、`MCP endpoint`、`Commands run`、`Manual confirmation required`。`RTOS Views full panel` 必须写明 Tasks / runtime / Queue-Mutex-Sem 是已写入固件还是用户要求跳过。
