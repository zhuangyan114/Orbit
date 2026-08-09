---
name: Orbit-Config-skill
description: Configure and verify an STM32 firmware workspace for Orbit for VS Code. Use when Codex must inspect or edit CMake and ARM toolchain settings, .vscode/launch.json, J-Link DLL or JLink.exe settings, Native/Legacy debug ownership, MCU Debug RTOS Views integration, RTT, P-RTLog, or the local MCP setup. Do not use for generic embedded debugging, firmware algorithm changes, or changes to Orbit debug implementation.
---

# Orbit Workspace Configuration

## When to use

Use this skill when the user asks to configure or validate an STM32 firmware workspace for Orbit — The Debugger for What's Next, including:

- `.vscode/launch.json`, `.vscode/settings.json`, CMake, ARM GCC, ELF/AXF, or SVD setup;
- J-Link `JLink_x64.dll`, `JLink.exe`, Native helper, Legacy `koffi`, or the `nativeDebugEngine*` options;
- Watch, Timeline, RTT, P-RTLog, RTOS Views, Memory View, or Peripheral Viewer integration;
- the local Orbit Plugin API or MCP server setup;
- a source-grounded audit of an existing Orbit debug configuration.

## Do not use when

Do not use this skill for:

- changing Orbit debugger implementation under `src/`, `native/`, or generated `dist/`;
- changing the MCP protocol or MCP server behavior;
- firmware control logic, PID tuning, or target-side bug fixing;
- generic OpenOCD, GDB server, SEGGER Ozone GUI automation, or a different debugger stack.

## Goal

让当前 STM32 firmware workspace 能够以一个可复现的 Orbit debug launch 工作；如果已有配置，合并缺失项并保留用户选择，不用模板值覆盖实际工程值。

具体 JSON、CMake、RTOS、RTT、P-RTLog 和 MCP 示例必须先阅读 `references/configuration-details.md`。完整配置项、默认值、范围和功能说明以仓库内 `docs/user-guide.md` 与当前 `package.json` 为准。

## One-pass workflow

### 1. Identify the target workspace

- 当前目录如果包含 `CMakeLists.txt`、`.ioc`、`Core/`、`Src/`、`Inc/` 或 `build/` 下的 ELF/AXF，才把它当作 firmware workspace。
- 如果当前目录是 Orbit extension repo，先确认真正的 firmware workspace；不要把扩展仓库的配置写入固件工程。
- 默认只改目标工程的 `.vscode/` 和 CMake 配置；不要改 global user settings，除非用户明确要求。

### 2. Audit before editing

先读取并记录：

- `.vscode/settings.json`、`.vscode/launch.json`、`.vscode/tasks.json`；
- `CMakePresets.json`、`CMakeUserPresets.json`、`CMakeLists.txt`、toolchain files；
- `.ioc`、startup file、linker script、SVD、`FreeRTOSConfig.h`、ELF/AXF 和 build output；
- 目标设备、ELF/AXF、SVD、调试 interface、speed、RTOS、RTT buffer 和 build type。

芯片值至少用两个 project-local evidence 交叉确认，例如 `.ioc` 的 `Mcu.Name`、startup/linker 文件名、CMake defines、SVD 文件名和已有可用 debug 配置。禁止把 `STM32F407VG`、`STM32F407IG` 或任何其他示例芯片名直接复制到不匹配的项目。

如果需要 P-RTLog，先检查源码和构建产物是否出现 `P_RTLOG`、`PRTLOG`、`P-RTLog`、`PW_LOG`、`PW_TOKENIZE`、`pw_tokenizer` 或 `.pw_tokenizer.entries`。

### 3. Configure CMake and ARM toolchain

- 保留现有 CMake preset、toolchain 和生成器；只补缺失的最小配置。
- 缺少 ARM GCC toolchain 时，使用 `arm-none-eabi-gcc`、`arm-none-eabi-g++`、`arm-none-eabi-objcopy`、`arm-none-eabi-size`，并设置 `CMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY`。
- 生成的 CMake 或 CubeMX 文件只在有明确安全的 user-code 区块且用户要求时修改；否则报告缺项，不盲改生成文件。

### 4. Configure `launch.json`

确保至少有一项：

```json
{
  "type": "ozone",
  "request": "launch"
}
```

按实际工程配置 `program`、`device`、`deviceName`、`interface`、`speedKHz`、`svdFile` / `svdPath`、`rtos`、RTT 字段、P-RTLog 字段和 Native/Legacy 字段。`program` 为空时，源码会检查 `build/Debug`、`build/Release`、`build` 中的第一个 `.elf` 或 `.axf`；不要假设这个自动选择一定是用户想要的 ELF。

项目级值优先写在 launch；`orbit.*` 是共享默认值。`deviceName`、`svdFile`、`svdPath` 是兼容外部 MCU Debug Views 的字段，保留别名时仍要指向同一实际目标。

Native owner 规则：

- `nativeDebugEngineMode: "auto"`：Native helper 优先；仅在 Native 启动/初始化失败，或已完全 dispose 的 Native owner 报告 `NativeOwnerLost` 时允许 Legacy fallback；
- `nativeDebugEngineMode: "native"`：只使用 Native，初始化失败即失败；
- `nativeDebugEngineMode: "legacy"`：只使用 Legacy `koffi` channel；
- `nativeDebugEngineEnabled: false` 且 mode 为 `auto`：使用 Legacy；
- 一个 DAP session 只有一个 target owner。不能让 Native helper 和 Legacy DLL 同时控制同一个目标，也不能用 Legacy 模拟 Native source-level step。

### 5. Configure external MCU Debug Views

只有在用户要用这些外部视图、且对应扩展已安装时，才补齐这些 workspace arrays：

- `memory-view.trackDebuggers`；
- `mcu-debug.rtos-views.trackDebuggers`；
- `mcu-debug.debug-tracker-vscode.trackDebuggers`。

数组中加入字符串 `"ozone"`，去重并保留已有 debugger 类型。执行 `Orbit: Enable MCU Debug Views Integration` 后按提示 Reload Window。Orbit 提供 DAP memory、`memoryReference`、RTOS capability 和 SVD metadata，但不把外部视图的 UI 或 kernel/SVD parser 复制进本 skill。

`rtos` / `orbit.defaultRtos` 只有在 firmware 实际使用对应 RTOS 时才填写，例如 `FreeRTOS`。RTOS Views 还依赖正确的 ELF/SVD/MCU 和 firmware-side FreeRTOS symbols、trace/runtime-stat hooks；缺失时要明确报告，而不是把启动成功当作 RTOS Views 已验证。

FreeRTOS 兼容性验收补充：

- FreeRTOS 10.x 配合 CMSIS-RTOS v1 wrapper 时，launch 使用 `"rtos": "FreeRTOS"`；`CMSIS-RTOS` 是 API wrapper 名称，不是 RTOS Views 的识别值。
- J-Link 和 CMSIS-DAP HID 都可以承载同一套 RTOS View DAP 合同。`probe: "cmsis-dap"` 必须由唯一 CMSIS-DAP helper owner 服务，不能创建 J-Link、Legacy 或第二个 target owner；J-Link 路径同样只能保留一个活动 owner。
- 最低 DAP 合同包括 `initialize.supportsRTOS` / `rtosName`、`rtosInfo`、`evaluate`、可展开的 `variables` / `variablesReference`、有效 `memoryReference` 以及 byte-oriented `readMemory`。RTOS View 失败时要保留 `errorCode`、`targetState`、`elapsedMs` 和 `diagnostics`。
- RTOS 链表和 runtime counter 必须来自同一停止态快照；Continue、Halt、Step、Reset、Disconnect 或 session replacement 时取消排队的 RTOS refresh，旧 generation 的结果不得发布。RTOS refresh 只能作为 background/低优先级读取，不能阻塞控制操作或禁用 Watch、Timeline、RTT、变量树和 Memory View。
- 遇到 `Unable to collect full RTOS information` 或 `No RTOS detected` 时，先确认目标已停止、ELF 与实际固件一致，再终止旧 session、Reload Window 并创建新 session；外部 RTOS Views 会缓存当前 session 的检测失败。瞬态 `Busy` / `TargetReadUnavailable` 应允许重试，符号缺失等永久错误才应报告为配置问题。
- `vet6_led` 的验收 fixture 在 `RTT_BENCH_ENABLE=ON` 时额外创建 `rttBench`，并注册 `rtosViewQueue`、`rtosViewMutex`、`rtosViewSemaphore`；看到 4 个线程、1 个队列和 2 个 MUX/SEM 只说明该 fixture 已启用，不应当作所有工程的固定期望。

### 6. Configure RTT and P-RTLog

- RTT 默认 `rttLogEnabled: true`，up-buffer 默认 `0`，默认 poll interval `500 ms`，每轮默认读取 `64 bytes`，输出默认到 `terminal`。
- `rttLogTarget` 只能使用 `terminal`、`debugConsole` 或 `both`。
- `pRtLogEnabled` 默认 `false`；仅在当前 firmware 使用 tokenized P-RTLog 或用户明确要求时打开。
- P-RTLog 解码使用当前 ELF/AXF 的 `.pw_tokenizer.entries`；`pRtLogRoot` 是当前源码读取的配置/诊断值，不要描述成 token 搜索目录，除非源码已改变并重新核对。

### 7. Configure local MCP

Orbit 的 MCP client/server 关系必须保持清楚：

- MCP server 文件是 `<workspace-root>\Releases\mcp\orbit-mcp-server.js`；
- server 通过 `ORBIT_PLUGIN_API_ENDPOINT_FILE` 找到 VS Code extension activation 后生成的 endpoint；
- endpoint 是 loopback Plugin API，不是公共 HTTP 服务；
- 只有用户指定 MCP client 配置位置或该位置已明确可解析时，才写入 client 配置；不要猜测或修改未知的 global config。

未来 Release 资产可能包含 `.vsix`、MCP 和 SKILL；配置 skill 只负责验证当前源码和目标工程，不生成或修改 Release 资产，除非用户另行要求。

### 8. Validate

按当前工程实际情况执行非破坏检查：

- JSON/JSONC 语法检查；
- `cmake`、选定 generator、`arm-none-eabi-gcc`、`arm-none-eabi-objdump`、`node` 和 J-Link 可执行文件/DLL 的 discoverability；
- extension checkout 需要 Native 时确认 `out/native/win32-x64/orbit-jlink-helper.exe` 存在，必要时报告需要 `npm run build:native`；
- firmware project 支持时执行 non-destructive CMake configure/build；
- MCP 仅可验证 Node module/dependency 是否能加载；endpoint 和目标读写必须在 VS Code 激活 Orbit 且有活动目标时验证。

不要把 mock、静态 source inspection 或 build 成功写成 real-hardware validation。不要在未获授权时运行会 reset、flash、run 或修改目标状态的硬件命令。

### 9. Report

报告必须包含：

- 修改的文件和保留的用户配置；
- 实际选择的 launch name、ELF/AXF、device、interface、speed、SVD、RTOS；
- J-Link DLL/JLink.exe、Native/Legacy owner 和 fallback 状态；
- RTT/P-RTLog 状态以及 `.pw_tokenizer.entries` 是否被 source/build 检查发现；
- MCP server、endpoint 和验证范围；
- 已执行命令及结果；
- 未能从工程或硬件确认的假设和剩余人工步骤。

## Editing rules

- 修改 JSON 数组时去重加入 `"ozone"`，保留其他 debugger 类型、注释和用户值。
- 使用 `${workspaceFolder}` 表示提交到 firmware workspace 的路径；不要硬编码本机扩展仓库路径，除非没有可解析的已安装扩展路径且用户明确同意。
- `.vscode/*.json` 可能是 JSONC；不要为验证而删除注释。
- 不要启用 P-RTLog 来处理普通文本 RTT。
- 不要修改 Orbit `src/`、`native/`、`dist/`、MCP protocol 或 `docs/bug-fix-log.md`；该 skill 的配置变更必须限定在用户明确授权的 workspace 配置文件。
