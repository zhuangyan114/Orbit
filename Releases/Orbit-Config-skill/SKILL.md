---
name: Orbit-Config-skill
description: Configure and verify an STM32 firmware workspace for Orbit for VS Code. Use when Codex must inspect or edit CMake and ARM toolchain settings, .vscode/launch.json, J-Link or CMSIS-DAP/DAPLink probe settings, target ownership, MCU Debug Views integration, RTT, P-RTLog, FreeRTOS RTOS Views full-panel firmware hooks, or the local MCP setup. Do not use for generic embedded debugging, firmware algorithm/PID changes, or changes to Orbit debug implementation.
---

# Orbit Workspace Configuration

## When to use

Use this skill when the user asks to configure or validate an STM32 firmware workspace for Orbit — The Debugger for What's Next, including:

- `.vscode/launch.json`, `.vscode/settings.json`, CMake, ARM GCC, ELF/AXF, or SVD setup;
- J-Link `JLink_x64.dll`/`JLink.exe`, CMSIS-DAP/DAPLink HID/WinUSB, either native helper, Legacy `koffi`, or owner-selection options;
- Watch, Timeline, RTT, P-RTLog, RTOS Views（默认全面板：Tasks + runtime/CPU% + Queue/Mutex/Sem）, Memory View, or Peripheral Viewer integration;
- FreeRTOS `FreeRTOSConfig.h` / `freertos.c` USER CODE debug hooks for those views;
- the local Orbit Plugin API or MCP server setup;
- a source-grounded audit of an existing Orbit debug configuration.

## Do not use when

Do not use this skill for:

- changing Orbit debugger implementation under `src/`, `native/`, or generated `dist/`;
- changing the MCP protocol or MCP server behavior;
- firmware control logic, PID tuning, GPIO/peripheral algorithms, or target-side bug fixing（FreeRTOS 调试钩子除外，见下文全面板默认项）;
- generic OpenOCD, GDB server, SEGGER Ozone GUI automation, or a different debugger stack.

## Goal

让当前 STM32 firmware workspace 获得四个可复现的 Orbit debug launch，分别覆盖 J-Link/CMSIS-DAP 与烧录/不烧录组合；如果已有配置，合并真实工程值，不用模板芯片、ELF、SVD 或 RTOS 覆盖项目事实。工程实际使用 FreeRTOS 时，**默认一次配齐 RTOS Views 全面板**（workspace tracker + launch `rtos` + 固件 trace/stack/runtime-stat/queue registry），不要只配 launch 然后把固件缺口留给用户。

具体 JSON、CMake、RTOS、RTT、P-RTLog 和 MCP 示例必须先阅读 `references/configuration-details.md`。完整配置项、默认值、范围和功能说明以仓库内 `Releases/docs/user-guide.md` 与当前 `package.json` 为准。

## Required launch output

每次调用本 skill 配置工程时，都要确保 `.vscode/launch.json` 的 `configurations` 中存在以下四项：

| Name | `probe` | `flashBeforeDebug` |
| --- | --- | --- |
| `Orbit: J-Link (Flash)` | `jlink` | `true` |
| `Orbit: J-Link (No Flash)` | `jlink` | `false` |
| `Orbit: DAPLink (Flash)` | `cmsis-dap` | `true` |
| `Orbit: DAPLink (No Flash)` | `cmsis-dap` | `false` |

四项复用同一组已核实的 `program`、`device`、`deviceName`、`interface`、`speedKHz`、SVD、RTOS、RTT 和 P-RTLog 工程值。保留非 Orbit 配置和用户额外命名的配置；按上述名称更新已有标准项，不重复追加同名项。

DAPLink 两项默认只写：

```json
"probe": "cmsis-dap",
"cmsisDapTransport": "auto"
```

只有用户明确要求绑定某一只 probe 时，才在两项 DAPLink 配置中加入 `cmsisDapVid`、`cmsisDapPid`、`cmsisDapSerial` 或 `cmsisDapPath`。PnP/HID 枚举发现的 VID/PID/Serial 只是诊断信息，不能自动写入 launch，也不能因为当前只连接一只设备就固定它。

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

确保生成或更新四项标准配置，而不是只生成当前接入 probe 的一项。最小输出形状为：

```text
Orbit: J-Link (Flash)    -> probe=jlink,     flashBeforeDebug=true
Orbit: J-Link (No Flash)  -> probe=jlink,     flashBeforeDebug=false
Orbit: DAPLink (Flash)   -> probe=cmsis-dap, flashBeforeDebug=true
Orbit: DAPLink (No Flash) -> probe=cmsis-dap, flashBeforeDebug=false
```

先核实一次 `program`、`device`、`deviceName`、`interface`、`speedKHz`、`svdFile` / `svdPath`、`rtos`、RTT 和 P-RTLog 字段，再复制到四项标准配置。每对配置只在 `flashBeforeDebug` 上不同；两类 probe 只在 owner/transport 专属字段上不同。`program` 为空时，源码会检查 `build/Debug`、`build/Release`、`build` 中的第一个 `.elf` 或 `.axf`；不要假设这个自动选择一定是用户想要的 ELF。

项目级值优先写在 launch；`orbit.*` 是共享默认值。`deviceName`、`svdFile`、`svdPath` 是兼容外部 MCU Debug Views 的字段，保留别名时仍要指向同一实际目标。

Native owner 规则：

- `nativeDebugEngineMode: "auto"`：Native helper 优先；仅在 Native 启动/初始化失败，或已完全 dispose 的 Native owner 报告 `NativeOwnerLost` 时允许 Legacy fallback；
- `nativeDebugEngineMode: "native"`：只使用 Native，初始化失败即失败；
- `nativeDebugEngineMode: "legacy"`：只使用 Legacy `koffi` channel；
- `nativeDebugEngineEnabled: false` 且 mode 为 `auto`：使用 Legacy；
- 一个 DAP session 只有一个 target owner。不能让 Native helper 和 Legacy DLL 同时控制同一个目标，也不能用 Legacy 模拟 Native source-level step。

CMSIS-DAP owner 规则：

- `probe: "cmsis-dap"` 只能创建唯一的 `orbit-cmsis-dap-helper.exe` owner；不得回退 J-Link、Legacy 或第二个 helper；
- 两项 DAPLink 标准配置默认使用 `cmsisDapTransport: "auto"`，优先 v2 WinUSB 并兼容 v1 HID；
- 默认省略 `cmsisDapSerial`、`cmsisDapVid`、`cmsisDapPid` 和 `cmsisDapPath`。只有用户明确要求固定具体 probe 时才加入，并在烧录/不烧录两项中保持相同选择器；
- 不从 Windows 枚举、当前连接设备、验收 fixture 或示例值推断绑定。尤其不得默认写入 `C251`、`F001`、`LU_2022_8888`；
- 当前 CMSIS-DAP 调试接口为 SWD。不要把 J-Link 的 `nativeDebugEngineMode` 当成 CMSIS-DAP transport 开关；
- `flashBeforeDebug: true` 使用当前 CMSIS-DAP owner 和匹配目标的 Flash Algorithm；`false` 不得触发 erase/program/verify 或 Flash-only reset；
- owner loss 结束当前 session。Watch、Timeline、RTT 和 Viewer 失败不得创建 J-Link 或 extension-host bypass。

### 5. Configure external MCU Debug Views

工程使用 FreeRTOS 时，**默认一次配齐全面板**，不要只写 launch/`trackDebuggers` 然后把固件缺口写成“已知限制”。全面板 = Tasks（含栈/任务 ID）+ runtime/CPU% + Queue/Mutex/Sem。精确宏、DWT 时基和 registry 对象写法见 `references/configuration-details.md` 的 RTOS Views 节。

补齐这些 workspace arrays（扩展未安装也先写入，并在报告里提示安装 `mcu-debug.rtos-views`、`mcu-debug.debug-tracker-vscode`、`mcu-debug.memory-view`）：

- `memory-view.trackDebuggers`；
- `mcu-debug.rtos-views.trackDebuggers`；
- `mcu-debug.debug-tracker-vscode.trackDebuggers`。

数组中加入字符串 `"orbit"`，并为旧配置保留 `"ozone"`；去重并保留其他 debugger 类型。执行 `Orbit: Enable MCU Debug Views Integration` 后按提示 Reload Window。Orbit 提供 DAP memory、`memoryReference`、RTOS capability 和 SVD metadata，但不把外部视图的 UI 或 kernel/SVD parser 复制进本 skill。

`rtos` / `orbit.defaultRtos` 只有在 firmware 实际使用对应 RTOS 时才填写，例如 `FreeRTOS`。不要把启动成功当作 RTOS Views 已在硬件上验证。

#### FreeRTOS 全面板（默认应用）

检测到 `FreeRTOSConfig.h`、`cmsis_os.h` 或 FreeRTOS 源码时，默认在 USER CODE 中补齐，而不是只报告：

1. `FreeRTOSConfig.h` 的 `USER CODE BEGIN Defines`：`configUSE_TRACE_FACILITY`、`configRECORD_STACK_HIGH_ADDRESS`、`INCLUDE_uxTaskGetStackHighWaterMark`、`INCLUDE_xTaskGetCurrentTaskHandle`、`configGENERATE_RUN_TIME_STATS`，以及 `portCONFIGURE_TIMER_FOR_RUN_TIME_STATS` / `portGET_RUN_TIME_COUNTER_VALUE`。`configQUEUE_REGISTRY_SIZE` 若为 0 或未定义，改为至少 `8`。
2. `freertos.c`（或同等 USER CODE 文件）：用 DWT CYCCNT 实现 runtime 时基（Cortex-M7 先 `DWT->LAR = 0xC5ACCE55`）；不要占用已用作 HAL tick 的定时器。
3. 若应用未 `vQueueAddToRegistry` 任何对象：在 `RTOS_QUEUES` / `RTOS_MUTEX` / `RTOS_SEMAPHORES` USER CODE 中创建并注册 `rtosViewQueue`（深度 4）、`rtosViewMutex`、`rtosViewSemaphore`。已有业务对象并已注册则不重复创建。
4. 改完后编译；用 `nm`/`objdump` 确认 ELF 含 `pxCurrentTCB`、`ulRunTimeCounter`、`ulTotalRunTime`、`xQueueRegistry`。不要在未授权时 flash。

用户明确说只要 launch、不要改固件时，才跳过上述固件补丁并在报告中列出缺口。

FreeRTOS 兼容性验收补充：

- FreeRTOS 10.x 配合 CMSIS-RTOS v1 wrapper 时，launch 使用 `"rtos": "FreeRTOS"`；`CMSIS-RTOS` 是 API wrapper 名称，不是 RTOS Views 的识别值。
- J-Link 和 CMSIS-DAP HID 都可以承载同一套 RTOS View DAP 合同。`probe: "cmsis-dap"` 必须由唯一 CMSIS-DAP helper owner 服务，不能创建 J-Link、Legacy 或第二个 target owner；J-Link 路径同样只能保留一个活动 owner。
- 最低 DAP 合同包括 `initialize.supportsRTOS` / `rtosName`、`rtosInfo`、`evaluate`、可展开的 `variables` / `variablesReference`、有效 `memoryReference` 以及 byte-oriented `readMemory`。RTOS View 失败时要保留 `errorCode`、`targetState`、`elapsedMs` 和 `diagnostics`。
- RTOS 链表和 runtime counter 必须来自同一停止态快照；Continue、Halt、Step、Reset、Disconnect 或 session replacement 时取消排队的 RTOS refresh，旧 generation 的结果不得发布。RTOS refresh 只能作为 background/低优先级读取，不能阻塞控制操作或禁用 Watch、Timeline、RTT、变量树和 Memory View。
- 遇到 `Unable to collect full RTOS information` 或 `No RTOS detected` 时，先确认目标已停止、ELF 与实际固件一致，再终止旧 session、Reload Window 并创建新 session；外部 RTOS Views 会缓存当前 session 的检测失败。瞬态 `Busy` / `TargetReadUnavailable` 应允许重试，符号缺失等永久错误才应报告为配置问题。
- `vet6_led` 的 `RTT_BENCH_ENABLE=ON` fixture 会额外创建 `rttBench`，并注册同名 `rtosViewQueue` / `rtosViewMutex` / `rtosViewSemaphore`。全面板默认对象与该 fixture 同名时不要重复创建。该 fixture 的 4 任务快照不是所有工程的固定期望；未开 bench 时任务数以工程实际线程 + IDLE 为准。

### 6. Configure RTT and P-RTLog

- RTT 默认 `rttLogEnabled: true`，up-buffer 默认 `0`，默认 poll interval `500 ms`，每轮默认读取 `64 bytes`，输出默认到 `terminal`。
- J-Link RTT 使用 DLL API；CMSIS-DAP RTT 使用目标内存 control block/ring buffer，必要时配置 `rttControlBlockAddress`。两者都必须复用当前 owner。
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
- 四个标准 launch name，以及它们共享的 ELF/AXF、device、interface、speed、SVD、RTOS；
- RTOS Views 全面板：已写入的 FreeRTOS 宏、runtime 时基（DWT 或已有定时器）、registry 对象名称；若用户要求跳过固件补丁，列出仍缺的面板；
- probe、transport、serial/VID/PID（若使用）、J-Link DLL/JLink.exe 或 CMSIS-DAP helper、最终 owner 和 fallback 状态；
- RTT/P-RTLog 状态以及 `.pw_tokenizer.entries` 是否被 source/build 检查发现；
- MCP server、endpoint 和验证范围；
- 已执行命令及结果；
- 未能从工程或硬件确认的假设和剩余人工步骤。

## Editing rules

- 修改 JSON 数组时去重加入 `"orbit"` 和兼容别名 `"ozone"`，保留其他 debugger 类型、注释和用户值。
- 更新四个标准 launch 时按 name 去重；默认 DAPLink 项不得包含 probe selector。只有当前请求明确要求绑定时，才把相同 selector 写入两项 DAPLink 配置。
- 使用 `${workspaceFolder}` 表示提交到 firmware workspace 的路径；不要硬编码本机扩展仓库路径，除非没有可解析的已安装扩展路径且用户明确同意。
- `.vscode/*.json` 可能是 JSONC；不要为验证而删除注释。
- 不要启用 P-RTLog 来处理普通文本 RTT。
- 不要修改 Orbit `src/`、`native/`、`dist/`、MCP protocol 或 `docs/bug-fix-log.md`。
- 允许修改的固件范围仅限 FreeRTOS 全面板：`FreeRTOSConfig.h` / `freertos.c`（或同等文件）的 USER CODE、DWT runtime 时基、queue registry 对象。不要改任务算法、PID、GPIO 或 USER CODE 之外的 CubeMX 生成区。
- 用户明确说不要改固件时，才把全面板缺口写成报告而不落盘。
