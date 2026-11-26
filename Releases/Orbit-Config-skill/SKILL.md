---
name: Orbit-Config-skill
description: Configure and verify an STM32 firmware workspace for Orbit for VS Code. Use when Codex must inspect or edit CMake and ARM toolchain settings, .vscode/launch.json, J-Link / CMSIS-DAP / DAPLink / RMLink probe and flashBackend settings, target ownership, MCU Debug Views integration, RTT, P-RTLog, built-in Orbit RTOS panel (FreeRTOS snapshot & SystemView Trace) firmware hooks, or the local MCP setup. Do not use for generic embedded debugging, firmware algorithm/PID changes, or changes to Orbit debug implementation.
---

# Orbit Workspace Configuration

## When to use

Use this skill when the user asks to configure or validate an STM32 firmware workspace for Orbit — The Debugger for What's Next, including:

- `.vscode/launch.json`, `.vscode/settings.json`, CMake, ARM GCC, ELF/AXF, or SVD setup;
- J-Link `JLink_x64.dll`/`JLink.exe`, CMSIS-DAP/DAPLink (HID/WinUSB/TCP), RMLink (`probe: "rmlink"`), `flashBackend`（`auto` / `native` / `openocd`）, either native helper, or probe-selection options;
- Watch（支持运行中不停机直写）、Timeline（含 XR-DAP / RMLink 板端采样）、RTT、P-RTLog、Orbit 内置 RTOS 面板（FreeRTOS 全面板快照：Tasks + 栈水位 + runtime/CPU% + Queue/Mutex/Sem + Timers/Heap，及可选 SEGGER SystemView Trace），以及 Memory View / Peripheral Viewer 集成;
- FreeRTOS `FreeRTOSConfig.h` / `freertos.c` USER CODE 调试钩子与 `rtosSnapshotPort` 配置;
- the local Orbit Plugin API or MCP server setup;
- a source-grounded audit of an existing Orbit debug configuration.

## Do not use when

Do not use this skill for:

- changing Orbit debugger implementation under `src/`, `native/`, or generated `dist/`;
- changing the MCP protocol or MCP server behavior;
- firmware control logic, PID tuning, GPIO/peripheral algorithms, or target-side bug fixing（FreeRTOS 调试钩子除外，见下文全面板默认项）;
- generic OpenOCD, GDB server, SEGGER Ozone GUI automation, or a different debugger stack.

## Goal

让当前 STM32 firmware workspace 默认只保留一个精简、可复现的 `Orbit Debug` launch：标准 DAP 字段加一次真实芯片型号，其余使用 Orbit 的自动探针、ELF、SVD、SWD/4000 kHz、自动 `flashBackend` 和 Native 默认值。只有用户明确要求固定 probe（如 `cmsis-dap` / `jlink` / `rmlink`）、禁用 Flash、显式选择 `flashBackend`、指定 ELF/SVD/RTOS/RTT 或需要多个快捷入口时才增加对应字段或配置。工程实际使用 FreeRTOS 时，**默认一次配齐 Orbit 内置 RTOS 面板所需的全面板固件钩子**（launch `rtos` + 可选 `rtosSnapshotPort` + 固件 trace/stack/runtime-stat/queue registry），不要只配 launch 然后把固件缺口留给用户。

具体 JSON、CMake、RTOS、RTT、P-RTLog 和 MCP 示例必须先阅读 `references/configuration-details.md`。完整配置项、默认值、范围和功能说明以仓库内 `Releases/docs/user-guide.md` 与当前 `package.json` 为准。

## Required launch output

默认确保 `.vscode/launch.json` 中存在一项：

```jsonc
{
  "name": "Orbit Debug",
  "type": "orbit",
  "request": "launch",
  "device": "当前工程已核实的 MCU 型号"
}
```

省略 `probe` 等价于 `probe: "auto"`：先检测 J-Link，再检测 CMSIS-DAP/DAPLink；两者同时连接时始终选择 J-Link。省略 `interface` 和 `speedKHz` 分别使用 `SWD` 和 `4000`。`deviceName` 自动跟随 `device`。保留非 Orbit 配置和用户额外命名的配置，不为了瘦身删除用户已有的显式变体。

只有用户明确要求强制 DAPLink 时才写 `"probe": "cmsis-dap"`；强制 J-Link 时写 `"probe": "jlink"`；使用 RMLink 连接服务时写 `"probe": "rmlink"`（仅一台已配对在线设备时可省略 `rmlinkDeviceId`，多台设备时才填写 12 位 `rmlinkDeviceId`）。只有用户明确要求绑定某一只 DAPLink probe 时才加入 `cmsisDapVid`、`cmsisDapPid`、`cmsisDapSerial` 或 `cmsisDapPath`。PnP/HID 枚举发现的 VID/PID/Serial 只是诊断信息，不能自动写入 launch，也不能因为当前只连接一只设备就固定它。

## One-pass workflow

### 1. Identify the target workspace

- 当前目录如果包含 `CMakeLists.txt`、`.ioc`、`Core/`、`Src/`、`Inc/` 或 `build/` 下的 ELF/AXF，才把它当作 firmware workspace。
- 如果当前目录是 Orbit extension repo，先确认真正的 firmware workspace；不要把扩展仓库的配置写入固件工程。
- 默认改目标工程的 `.vscode/`、CMake，以及 FreeRTOS 全面板所需的 USER CODE（`FreeRTOSConfig.h`、`freertos.c`）；不要改 global user settings，除非用户明确要求。

### 2. Audit before editing

先读取并记录：

- `.vscode/settings.json`、`.vscode/launch.json`、`.vscode/tasks.json`；
- `CMakePresets.json`、`CMakeUserPresets.json`、`CMakeLists.txt`、toolchain files；
- `.ioc`、startup file、linker script、SVD、`FreeRTOSConfig.h`、`freertos.c`、ELF/AXF 和 build output；
- 目标设备、ELF/AXF、SVD、调试 interface、speed、RTOS、RTT buffer 和 build type；
- FreeRTOS 全面板缺口：`configUSE_TRACE_FACILITY`、`configRECORD_STACK_HIGH_ADDRESS`、`configGENERATE_RUN_TIME_STATS`、runtime 时基宏、`configQUEUE_REGISTRY_SIZE`、`vQueueAddToRegistry`、ELF 中的 `ulRunTimeCounter` / `xQueueRegistry`。

芯片值至少用两个 project-local evidence 交叉确认，例如 `.ioc` 的 `Mcu.Name`、startup/linker 文件名、CMake defines、SVD 文件名和已有可用 debug 配置。禁止把 `STM32F407VG`、`STM32F407IG` 或任何其他示例芯片名直接复制到不匹配的项目。

如果需要 P-RTLog，先检查源码和构建产物是否出现 `P_RTLOG`、`PRTLOG`、`P-RTLog`、`PW_LOG`、`PW_TOKENIZE`、`pw_tokenizer` 或 `.pw_tokenizer.entries`。

### 3. Configure CMake and ARM toolchain

- 保留现有 CMake preset、toolchain 和生成器；只补缺失的最小配置。
- 缺少 ARM GCC toolchain 时，使用 `arm-none-eabi-gcc`、`arm-none-eabi-g++`、`arm-none-eabi-objcopy`、`arm-none-eabi-size`，并设置 `CMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY`。
- 生成的 CMake 或 CubeMX 文件只改有明确 USER CODE 区块的内容。FreeRTOS 全面板钩子**默认**写入 `FreeRTOSConfig.h` / `freertos.c` 的 USER CODE，不要改 USER CODE 之外的 CubeMX 生成区。其他生成文件缺项仍只报告，不盲改。

### 4. Configure `launch.json`

默认生成或更新单项 `Orbit Debug`，只写 `name`、`type`、`request`、`device`。先核实 `device`；再判断自动 ELF 是否唯一、自动 SVD 是否能精确匹配，以及工程是否实际使用 RTOS/特殊 RTT。只有自动行为不足以表达工程事实时才添加相应字段。

`program` 为空时，源码按 `build/Debug`、`build/Release`、`build` 检查第一个 `.elf` 或 `.axf`。若存在多个候选或自动路径不是 active ELF，显式写 `program`。SVD 优先使用显式 `svdFile` / `svdPath` 和 `orbit.defaultSvdFile`，否则依次查工作区、本机 CMSIS Pack、缓存，并可按需下载一个对应 STM32 系列的 Keil DFP、只提取当前芯片 SVD；需要离线固定版本时才显式写 SVD 并关闭 `orbit.svdAutoDownload`。

`orbit.*` 是共享默认值。不要重复写与默认值相同的 `deviceName`、`interface`、`speedKHz`、`cmsisDapTransport`、`flashBeforeDebug` 或 SVD 字段。用户要求多个快捷入口时，才从同一已核实基础配置派生显式 probe/Flash 变体。

Native owner 规则：

- J-Link 调试使用原生 helper。启动失败时释放 helper 并返回错误。连接后的 owner 丢失会结束会话。

CMSIS-DAP owner 规则：

- `probe: "auto"` 先检测 J-Link；检测成功即选 J-Link，只有 J-Link 不可用时才枚举 CMSIS-DAP；
- `probe: "cmsis-dap"` 只能创建唯一的 `orbit-cmsis-dap-helper.exe` owner；不得回退 J-Link 或第二个 helper；
- DAPLink 默认 `cmsisDapTransport: "auto"`，优先 v2 WinUSB 并兼容 v1 HID；该字段可省略；
- 默认省略 `cmsisDapSerial`、`cmsisDapVid`、`cmsisDapPid` 和 `cmsisDapPath`。只有用户明确要求固定具体 probe 时才加入；
- 不从 Windows 枚举、当前连接设备、验收 fixture 或示例值推断绑定。尤其不得默认写入 `C251`、`F001`、`LU_2022_8888`；
- 当前 CMSIS-DAP 调试接口为 SWD。
- `flashBeforeDebug: true` 对已登记型号使用当前 CMSIS-DAP / RMLink owner 的原生快速算法，对其余受支持 STM32 型号由内置 OpenOCD 在认领调试 owner 前完成独立烧录校验（`flashBackend` 默认 `"auto"`，可选 `"native"` / `"openocd"`）；`false` 不得触发 erase/program/verify 或 Flash-only reset；
- owner loss 结束当前 session。Watch、Timeline、RTT 和 Viewer 失败不得创建 J-Link 或 extension-host bypass。

### 5. Configure external MCU Debug Views and built-in RTOS panel

Orbit 自 `1.2.2` 起内置了原生底部 **RTOS** 诊断面板（`ozoneRtos`），**不再依赖或向工作区写入 `mcu-debug.rtos-views.trackDebuggers` 与 `orbit.rtosViewsAutoRefresh`**。工程使用 FreeRTOS 时，**默认一次配齐内置 RTOS 面板所需的全面板固件钩子**（Tasks + 栈水位 + runtime/CPU% + Queue/Mutex/Sem + Timers/Heap），不要只写 launch 然后把固件缺口写成“已知限制”。精确宏、DWT 时基、`rtosSnapshotPort` 和 registry 对象写法见 `references/configuration-details.md` 的内置 RTOS 面板节。

仅补齐 Memory View 与 debug-tracker 所需的 workspace arrays（扩展未安装也先写入，并在报告里提示按需安装 `mcu-debug.memory-view`、`mcu-debug.debug-tracker-vscode`）：

- `memory-view.trackDebuggers`；
- `mcu-debug.debug-tracker-vscode.trackDebuggers`。

数组中加入字符串 `"orbit"`，并为旧配置保留 `"ozone"`；去重并保留其他 debugger 类型。执行 `Orbit: Enable MCU Debug Views Integration` 后按提示 Reload Window。Orbit 提供 DAP memory、`memoryReference`、RTOS capability 和 SVD metadata，但不把外部视图的 UI 或 SVD parser 复制进本 skill。

`rtos` / `orbit.defaultRtos` 只有在 firmware 实际使用对应 RTOS 时才填写，例如 `FreeRTOS`（不要写 `CMSIS-RTOS`）。需要启用精确栈高水位扫描与 CPU% 估算口径时，按实际核对的 port 与计时器频率在 `launch.json` 补充 `rtosSnapshotPort`。不要把启动成功当作硬件已验证。

#### FreeRTOS 全面板（默认应用）

检测到 `FreeRTOSConfig.h`、`cmsis_os.h` 或 FreeRTOS 源码时，默认在 USER CODE 中补齐，而不是只报告：

1. `FreeRTOSConfig.h` 的 `USER CODE BEGIN Defines`：`configUSE_TRACE_FACILITY`、`configRECORD_STACK_HIGH_ADDRESS`、`INCLUDE_uxTaskGetStackHighWaterMark`、`INCLUDE_xTaskGetCurrentTaskHandle`、`configGENERATE_RUN_TIME_STATS`，以及 `portCONFIGURE_TIMER_FOR_RUN_TIME_STATS` / `portGET_RUN_TIME_COUNTER_VALUE`。`configQUEUE_REGISTRY_SIZE` 若为 0 或未定义，改为至少 `8`。
2. `freertos.c`（或同等 USER CODE 文件）：用 DWT CYCCNT 实现 runtime 时基（Cortex-M7 先 `DWT->LAR = 0xC5ACCE55`）；不要占用已用作 HAL tick 的定时器。
3. 若应用未 `vQueueAddToRegistry` 任何对象：在 `RTOS_QUEUES` / `RTOS_MUTEX` / `RTOS_SEMAPHORES` USER CODE 中创建并注册 `rtosViewQueue`（深度 4）、`rtosViewMutex`、`rtosViewSemaphore`。已有业务对象并已注册则不重复创建。
4. 改完后编译；用 `nm`/`objdump` 确认 ELF 含 `pxCurrentTCB`、`ulRunTimeCounter`、`ulTotalRunTime`、`xQueueRegistry`。不要在未授权时 flash。

用户明确说只要 launch、不要改固件时，才跳过上述固件补丁并在报告中列出缺口。

FreeRTOS 与 SystemView 补充：

- FreeRTOS 10.x 配合 CMSIS-RTOS v1 wrapper 时，launch 使用 `"rtos": "FreeRTOS"`；保留完整 DWARF（`-g`/`-g3`，禁止对调试 ELF 执行 `strip`），否则内置 RTOS 面板会报 `DwarfUnavailable`。
- J-Link、CMSIS-DAP 与 RMLink 均可复用同一活动调试会话为内置 RTOS 面板提供快照与 SystemView RTT 访问，不会创建第二个 target owner；RTOS 刷新与 RTT 均为低优先级后台工作，不会阻塞调试控制。
- 如用户需要 SystemView Trace 泳道与事件分析，提示按 `Releases/docs/RTOS诊断功能使用教程.md` 接入 SEGGER SystemView（提供独立 `SysView` RTT 通道，Continuous 模式不要在启动时主动调用 `SEGGER_SYSVIEW_Start()`）。
- `vet6_led` 的 `RTT_BENCH_ENABLE=ON` fixture 会额外创建 `rttBench`，并注册同名 `rtosViewQueue` / `rtosViewMutex` / `rtosViewSemaphore`。全面板默认对象与该 fixture 同名时不要重复创建。

### 6. Configure RTT and P-RTLog

- RTT 默认 `rttLogEnabled: true`，up-buffer 默认 `0`，默认 poll interval `50 ms`，每轮默认读取 `4096 bytes`，输出默认到 `terminal`。
- J-Link RTT 使用 DLL API；CMSIS-DAP 与 RMLink RTT 使用目标内存 control block/ring buffer，必要时配置 `rttControlBlockAddress`。所有探针均复用当前 owner，且普通文本日志通道（如通道 0 `Terminal`）可与 SystemView 通道（`SysView`）共存。
- `rttLogTarget` 只能使用 `terminal`、`debugConsole` 或 `both`。
- `pRtLogEnabled` 默认 `false`；仅在当前 firmware 使用 tokenized P-RTLog 或用户明确要求时打开。
- P-RTLog 解码使用当前 ELF/AXF 的 `.pw_tokenizer.entries`；`pRtLogRoot` 是当前源码读取的配置/诊断值，不要描述成 token 搜索目录，除非源码已改变并重新核对。

### 7. Configure local MCP

Orbit 的 MCP client/server 关系必须保持清楚：

- MCP server 文件是 `<workspace-root>\Releases\mcp\orbit-mcp-server.js`；
- 它是 Automation API v1 的 Node-client 适配器，通过 `ORBIT_AUTOMATION_REGISTRY` 发现实例；不要再写 `ORBIT_PLUGIN_API_ENDPOINT_FILE` 作为新配置；
- endpoint 是 loopback Automation API，不是公共 HTTP 服务；
- 相同 `projectId` 的多窗口必须指定 `instanceId`；
- 只有用户指定 MCP client 配置位置或该位置已明确可解析时，才写入 client 配置；不要猜测或修改未知的 global config。

未来 Release 资产可能包含 `.vsix`、MCP 和 SKILL；配置 skill 只负责验证当前源码和目标工程，不生成或修改 Release 资产，除非用户另行要求。

### 8. Validate

按当前工程实际情况执行非破坏检查：

- JSON/JSONC 语法检查；
- `cmake`、选定 generator、`arm-none-eabi-gcc`、`arm-none-eabi-objdump` 和 `node`；按所选 probe 验证 J-Link DLL/可执行文件或 CMSIS-DAP Windows 枚举/驱动；
- extension checkout 需要 Native 时确认相应的 `out/native/win32-x64/orbit-jlink-helper.exe` 或 `orbit-cmsis-dap-helper.exe` 存在，必要时报告需要 `npm run build:native`；
- firmware project 支持时执行 non-destructive CMake configure/build；
- FreeRTOS 全面板应用后，用 `arm-none-eabi-nm` / `objdump -W` 确认 `ulRunTimeCounter`、`ulTotalRunTime`、`xQueueRegistry`、`vQueueAddToRegistry` 存在于 active ELF；缺失则视为配置未完成，不要只报告“launch 已写 rtos”；
- MCP 仅可验证 Node module/dependency 是否能加载；endpoint 和目标读写必须在 VS Code 激活 Orbit 且有活动目标时验证。

不要把 mock、静态 source inspection 或 build 成功写成 real-hardware validation。不要在未获授权时运行会 reset、flash、run 或修改目标状态的硬件命令。

### 9. Report

报告必须包含：

- 修改的文件和保留的用户配置；
- `Orbit Debug` 的精简字段、自动默认项，以及因工程事实而保留的显式 ELF/AXF、probe、SVD、RTOS 或 Flash 覆盖项；
- RTOS Views 全面板：已写入的 FreeRTOS 宏、runtime 时基（DWT 或已有定时器）、registry 对象名称；若用户要求跳过固件补丁，列出仍缺的面板；
- probe、transport、serial/VID/PID（若使用）、J-Link DLL/JLink.exe 或 CMSIS-DAP helper、最终 owner 和 fallback 状态；
- RTT/P-RTLog 状态以及 `.pw_tokenizer.entries` 是否被 source/build 检查发现；
- MCP server、endpoint 和验证范围；
- 已执行命令及结果；
- 未能从工程或硬件确认的假设和剩余人工步骤。

## Editing rules

- 修改 JSON 数组时去重加入 `"orbit"` 和兼容别名 `"ozone"`，保留其他 debugger 类型、注释和用户值。
- 更新 `Orbit Debug` 时按 name 去重；不删除用户已有的其他 launch。只有当前请求明确要求绑定 DAPLink 时才写 probe selector。
- 使用 `${workspaceFolder}` 表示提交到 firmware workspace 的路径；不要硬编码本机扩展仓库路径，除非没有可解析的已安装扩展路径且用户明确同意。
- `.vscode/*.json` 可能是 JSONC；不要为验证而删除注释。
- 不要启用 P-RTLog 来处理普通文本 RTT。
- 不要修改 Orbit `src/`、`native/`、`dist/`、MCP protocol 或 `docs/bug-fix-log.md`。
- 允许修改的固件范围仅限 FreeRTOS 全面板：`FreeRTOSConfig.h` / `freertos.c`（或同等文件）的 USER CODE、DWT runtime 时基、queue registry 对象。不要改任务算法、PID、GPIO 或 USER CODE 之外的 CubeMX 生成区。
- 用户明确说不要改固件时，才把全面板缺口写成报告而不落盘。
