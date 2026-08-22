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
| `orbit.defaultRtos` | string | `""` | 默认 RTOS 名称；例如实际使用 FreeRTOS 时写 `FreeRTOS`。|
| `orbit.rtosViewsAutoRefresh` | boolean | `false` | 首次 stack trace 后是否请求外部 RTOS Views focus/refresh。|
| `orbit.rttLogEnabled` | boolean | `true` | 是否读取 SEGGER RTT。|
| `orbit.rttBufferIndex` | number | `0`, `0..15` | RTT up-buffer index。|
| `orbit.rttPollIntervalMs` | number, ms | `50`, `10..5000` | RTT poll interval。|
| `orbit.rttReadSize` | number, bytes/poll | `4096`, `64..65536` | 每轮 RTT 最大读取字节数。|
| `orbit.rttControlBlockAddress` | string | `""` | RTT control block address；J-Link 可自动检测，CMSIS-DAP 可从 ELF 符号定位或使用显式地址。|
| `orbit.rttStripAnsi` | boolean | `true` | 仅去除写入 Debug Console 的 ANSI 控制序列。|
| `orbit.rttLogTarget` | `terminal` / `debugConsole` / `both` | `terminal` | RTT 输出位置。|
| `orbit.pRtLogEnabled` | boolean | `false` | 是否把 RTT bytes 解码为 P-RTLog tokenized frames。|
| `orbit.pRtLogRoot` | path | `""` | P-RTLog root 配置/诊断值；当前 decoder 不从该目录搜索 token。|
| `orbit.nativeDebugEngine.enabled` | boolean | `true` | Native helper 总开关。|
| `orbit.nativeDebugEngine.mode` | `legacy` / `native` / `auto` | `auto` | target owner 选择策略。|
| `orbit.watchPollIntervalMs` | number, ms | `500`, `100..10000` | Watch Webview 可见时的刷新计时基准。|
| `orbit.timelineSampleIntervalMs` | number, ms | `0.2`, `0.1..10000` | Timeline target sampling 目标间隔。|
| `orbit.timelineSendIntervalMs` | number, ms | `16`, `1..10000` | Timeline 向 Webview 发送更新的间隔。|

`orbit.flashBeforeDebug` 默认 `true`。launch 层可覆盖它：J-Link 使用 Commander 烧录，CMSIS-DAP 使用当前 helper owner 的 Flash Algorithm；`false` 跳过所有 Flash 操作。

External Views 的 tracker arrays 不是 Orbit 自有 setting，但可以在目标 workspace 中加入：

```json
{
  "memory-view.trackDebuggers": ["orbit", "ozone"],
  "mcu-debug.rtos-views.trackDebuggers": ["orbit", "ozone"],
  "mcu-debug.debug-tracker-vscode.trackDebuggers": ["orbit", "ozone"]
}
```

合并时保留数组已有元素，并确保 `"orbit"` 与兼容别名 `"ozone"` 不重复。

## Launch configuration

每次调用 Orbit-Config-skill 都生成或更新四项标准配置。下面是结构示例；`program`、`device`、`deviceName`、SVD、RTOS 和速度必须替换为当前工程已核实的值：

```jsonc
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Orbit: J-Link (Flash)",
      "type": "orbit",
      "request": "launch",
      "probe": "jlink",
      "program": "${workspaceFolder}/build/Debug/firmware.elf",
      "device": "STM32F407VE",
      "deviceName": "STM32F407VET6",
      "interface": "SWD",
      "speedKHz": 4000,
      "flashBeforeDebug": true
    },
    {
      "name": "Orbit: J-Link (No Flash)",
      "type": "orbit",
      "request": "launch",
      "probe": "jlink",
      "program": "${workspaceFolder}/build/Debug/firmware.elf",
      "device": "STM32F407VE",
      "deviceName": "STM32F407VET6",
      "interface": "SWD",
      "speedKHz": 4000,
      "flashBeforeDebug": false
    },
    {
      "name": "Orbit: DAPLink (Flash)",
      "type": "orbit",
      "request": "launch",
      "probe": "cmsis-dap",
      "cmsisDapTransport": "auto",
      "program": "${workspaceFolder}/build/Debug/firmware.elf",
      "device": "STM32F407VE",
      "deviceName": "STM32F407VET6",
      "interface": "SWD",
      "speedKHz": 4000,
      "flashBeforeDebug": true
    },
    {
      "name": "Orbit: DAPLink (No Flash)",
      "type": "orbit",
      "request": "launch",
      "probe": "cmsis-dap",
      "cmsisDapTransport": "auto",
      "program": "${workspaceFolder}/build/Debug/firmware.elf",
      "device": "STM32F407VE",
      "deviceName": "STM32F407VET6",
      "interface": "SWD",
      "speedKHz": 4000,
      "flashBeforeDebug": false
    }
  ]
}
```

默认 DAPLink 配置不包含以下选择器：

```json
"cmsisDapVid": "C251",
"cmsisDapPid": "F001",
"cmsisDapSerial": "LU_2022_8888"
```

上面的值是特定验收设备示例，不是通用默认值。只有用户明确要求绑定该设备时，才把所需选择器同时加入 `Orbit: DAPLink (Flash)` 和 `Orbit: DAPLink (No Flash)`；仅检测到设备或只连接一只 probe 不构成绑定要求。

当前 `package.json` debug schema 注册的 launch properties 如下。`default` 是 schema/config provider 的默认值，不代表当前板卡一定应使用该值。

| Property | Type / unit | Default / range | 说明 |
| --- | --- | --- | --- |
| `device` | string | `STM32F407VG` | 目标 device；J-Link 用于 DLL 选型，CMSIS-DAP 用于芯片/Flash Algorithm 校验。|
| `deviceName` | string | `STM32F407VG` | 外部 MCU Views 兼容别名；provider 默认跟随 `device`。|
| `probe` | `jlink` / `cmsis-dap` | `jlink` | 每个 session 的物理 target owner 类型。|
| `cmsisDapTransport` | enum | `auto` | `auto`、`cmsis-dap-v2`/`winusb`、`cmsis-dap`/`hid`。|
| `cmsisDapSerial` | string | `""` | 可选 probe serial 筛选。|
| `cmsisDapVid` / `cmsisDapPid` | string | `""` | 可选 USB VID/PID 筛选。|
| `cmsisDapPath` | string | `""` | 可选设备 interface path 精确筛选。|
| `cmsisDapFlashAlgorithmPath` | path | `""` | 可选、许可和目标适配已确认的 Flash Algorithm。|
| `program` | path | `${workspaceFolder}/build/Debug/frame.elf` | ELF/AXF；provider 可能自动从 build 目录选择。|
| `svdFile` | path | `""` | SVD 兼容字段。|
| `svdPath` | path | `""` | SVD 兼容字段；provider 默认跟随 `svdFile`。|
| `interface` | `SWD` / `JTAG` | `SWD` | 调试接口；当前 CMSIS-DAP 路径使用 SWD。|
| `speedKHz` | number, kHz | `4000` | target interface speed。|
| `flashBeforeDebug` | boolean | `true` | 使用当前 owner 烧录/校验；`false` 明确跳过。|
| `runToEntryPoint` | string / `false` | `main` | CMSIS-DAP Launch/Restart 后停靠符号；`false` 禁用。|
| `rtos` | string | `""` | 传给 RTOS Views 的 RTOS 名称。|
| `rttLogEnabled` | boolean | `true` | 是否轮询 RTT。|
| `rttBufferIndex` | number | `0` | RTT up-buffer index；运行时限制为 `0..15`。|
| `rttPollIntervalMs` | number, ms | `50` | RTT poll interval；schema 限制 `10..5000`。|
| `rttReadSize` | number, bytes/poll | `4096` | RTT 每轮读取量；schema 限制 `64..65536`。|
| `rttControlBlockAddress` | number/string, address | `""` | 可写十进制或 `0x` 地址；空值自动检测。|
| `rttStripAnsi` | boolean | `true` | Debug Console 的 ANSI 处理。|
| `rttLogTarget` | enum | `terminal` | `terminal`、`debugConsole` 或 `both`。|
| `pRtLogEnabled` | boolean | `false` | P-RTLog tokenized RTT decoder 开关。|
| `pRtLogRoot` | path | `""` | 当前为 decoder 诊断配置，不是 token 搜索目录。|
| `nativeDebugEngineEnabled` | boolean | `true` | Native helper 开关。|
| `nativeDebugEngineMode` | enum | `auto` | `legacy`、`native` 或 `auto`。|
| `nativeDebugEngineStepInto` | boolean | `true` | Native step into 开关。|
| `nativeDebugEngineStepOver` | boolean | `true` | Native step over 开关。|
| `nativeDebugEngineStepOut` | boolean | `true` | Native step out 开关。|

源码还支持 `elfPath` 作为 `program` 的兼容别名。`probe`、`interface`、`device`、`speedKHz`、`flashBeforeDebug`、`rtos` 和所有 RTT/P-RTLog/owner 字段最终由 DAP session 使用。

项目实际值确认顺序建议：`.ioc` 的 `Mcu.Name`、startup file、linker script、CMake compile definitions、SVD 文件名、同板已知可用配置。`device`、`deviceName`、SVD 和 active ELF 必须属于同一目标。

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

调试控制使用 `JLink_x64.dll`；Native channel 在 `orbit-jlink-helper.exe` 进程中加载 DLL，Legacy channel 通过 Node `koffi` 加载 DLL。`orbit.jlinkDllPath` 非空且存在时优先使用；否则源码会按版本目录、SEGGER Ozone 目录和 `JLink_x64.dll` 进行搜索。

自动 flash 使用 `orbit.jlinkPath` 指向的 `JLink.exe`，并将 `device`、`interface`、`speedKHz` 写入 J-Link Commander script。flash 不是持续调试控制 owner；已有固件时可将 `flashBeforeDebug` 设为 `false`。

注意：当前 Legacy `JLinkDLL.connect()` 固定选择 SWD，虽然配置 schema 接受 `JTAG`；需要 JTAG 时优先使用 Native，并把这个结论作为 source limitation 报告。

## CMSIS-DAP / DAPLink

`probe: "cmsis-dap"` 启动 `out/native/win32-x64/orbit-cmsis-dap-helper.exe`，不加载 J-Link DLL。`cmsisDapTransport: "auto"` 优先 WinUSB v2 并兼容 HID v1。标准配置保持未绑定；用户明确要求选择特定设备时，才使用 serial、VID/PID 或 interface path。

CMSIS-DAP owner 负责协议 framing、SWD/DP/AP、Cortex-M 控制、FPB、内存、Flash Algorithm 和内存型 RTT。它不回退到 J-Link/Legacy，也不允许 Watch、Timeline、RTT 或 Viewer 创建第二个 target owner。

默认 `flashBeforeDebug: true` 要求目标型号和 Flash Algorithm 匹配，并由同一 owner 完成 erase/program/verify；`false` 不得发出 Flash 操作。使用自定义 `cmsisDapFlashAlgorithmPath` 时，必须确认来源、许可、目标范围、RAM 布局和 ABI。

## Native / Legacy owner

Native helper 路径为 source checkout 的 `out/native/win32-x64/orbit-jlink-helper.exe`。Native 与 Legacy 不能在同一 DAP session 同时持有 target。`auto` 的 fallback 发生在 Native startup/initialization 失败或已 dispose 的 Native owner loss 之后；不会 hot-switch，Native owner 丢失通常要求结束并重新启动 session。

Native scheduler 的优先级是 `control > watch > timeline > background`。step、continue、halt、reset、breakpoint、Flash 和 write 属于 control work；RTT/RTOS refresh 属于 background。不要通过第二个 owner 绕过调度。

## RTOS Views

Orbit 通过 DAP capability 和外部 extension tracker 对接 RTOS Views；Orbit 本身不解析 RTOS kernel。需要三层同时正确：

1. tracker arrays 含 `"orbit"`（兼容时同时保留 `"ozone"`），且对应的 MCU Debug extensions 已安装；
2. launch 的 MCU、active ELF、SVD、`rtos` 一致；
3. firmware 有外部 RTOS View 所需的 symbols、trace 和 runtime-stat hooks。

`orbit.rtosViewsAutoRefresh` 默认 `false`；设为 `true` 时，源码会在外部 tracker 报告首次 stack trace 后尝试 focus/refresh RTOS Views。

### FreeRTOS / CMSIS-RTOS v1

FreeRTOS 10.x 使用 CMSIS-RTOS v1 wrapper 时，launch 示例为：

```json
{
  "type": "orbit",
  "request": "launch",
  "name": "Orbit: FreeRTOS STM32F407",
  "program": "${workspaceFolder}/build/Debug/firmware.elf",
  "device": "STM32F407VE",
  "rtos": "FreeRTOS"
}
```

`rtos` 必须写 `FreeRTOS`，不要写 `CMSIS-RTOS`。后者是 API wrapper，不是外部 RTOS Views 的识别名称。J-Link 和 CMSIS-DAP HID 均可使用此配置；CMSIS-DAP 会话必须保持唯一 CMSIS-DAP helper owner，不能与 J-Link/Legacy owner 并存。

外部 RTOS Views 通过以下 DAP 请求展开信息：`initialize` 的 `supportsRTOS` / `rtosName`、`rtosInfo`、`evaluate`、`variables`、`stackTrace` 和 `readMemory`。变量树必须返回可继续请求的 `variablesReference` 与有效 `memoryReference`；`readMemory` 使用 byte-oriented 数据。FreeRTOS 链表、TCB 和 runtime counter 应在停止态取得一致快照，运行态刷新只能走受控 background 读取。

固件侧至少要从同一个 active ELF 中确认 FreeRTOS 内核符号，例如 `uxCurrentNumberOfTasks`、`pxReadyTasksLists`、`xDelayedTaskList1` 和 `pxCurrentTCB`。要显示 Queue/Mux/Sem，还要启用 queue registry，并对目标对象调用 `vQueueAddToRegistry`。名称列若显示 `0x0800...`，通常是 registry 字符串指针尚未被外部视图解引用，不代表对象读取失败。

`Unable to collect full RTOS information` / `No RTOS detected` 可能是停止态读取被控制操作取消、目标仍在运行或旧 session 缓存了失败结果。确认目标停止后，结束旧调试会话、Reload Window、重新启动 launch，再刷新 RTOS Views；`Busy`、`TargetReadUnavailable` 等瞬态错误应重试，符号缺失才作为永久配置错误报告。

`vet6_led` 的可选验收 fixture 由 `RTT_BENCH_ENABLE=ON` 开启：它创建 `rttBench` RTT 测试任务，并注册一个容量为 4 的 `rtosViewQueue`、一个 `rtosViewMutex` 和一个 `rtosViewSemaphore`。因此该 fixture 的典型快照是 4 个任务、1 个队列和 2 个 MUX/SEM；这些数量不是通用 FreeRTOS 预期。

## RTT and P-RTLog

RTT 必须由 firmware 初始化 SEGGER RTT control block。J-Link DLL 还要导出 RTT control/read 函数；CMSIS-DAP 通过当前 owner 读取目标内存，需可解析 `_SEGGER_RTT` 或提供 `rttControlBlockAddress`。`rttStripAnsi` 仅影响 Debug Console；terminal 输出保留 ANSI。RTT `ESC[2J` 会触发 Debug Console 清屏行为。

P-RTLog frame 格式是：

```text
[2-byte little-endian length][frame payload]
```

frame 的前 4 bytes 是 little-endian token。decoder 从 active ELF 的 `.pw_tokenizer.entries` 读取 token metadata，并处理整数、浮点、字符串、指针和 printf 类参数；未知或截断 frame 应报告 decoder diagnostic。`pRtLogRoot` 当前不会让 decoder 从该目录加载 token。

## MCP and Plugin API

MCP server：`Releases/mcp/orbit-mcp-server.js`，stdio 进程；它通过 Node automation client 读取 `ORBIT_AUTOMATION_REGISTRY`（Windows 默认 `%LOCALAPPDATA%\Orbit\automation\registries.json`），握手后调用 `POST /v1/rpc`。多个相同 `projectId` 实例必须指定 `instanceId`。当前 tools：`orbit_instances`、`orbit_handshake`、session/control/breakpoint/memory tools，以及 `orbit_status`、`orbit_read_many`、`orbit_write_many`、`orbit_record`、`orbit_experiment_run`。`tools/list` 对全可选工具也发出 `required: []`，避免 opencode 把缺失字段序列化成 `required: null` 后被严格中转拒绝。

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
```

对无注释 JSON：

```powershell
Get-Content .vscode\settings.json -Raw | ConvertFrom-Json | Out-Null
Get-Content .vscode\launch.json -Raw | ConvertFrom-Json | Out-Null
```

JSONC 必须使用 JSONC-aware parser 或 VS Code 检查，不要删除注释来“修复”验证。

## Final report template

最终报告使用以下英文字段名，内容可用中文：`Files changed`、`Launch`、`Probe`、`Transport`、`Device`、`Interface`、`Speed`、`SVD`、`RTOS`、`Owner`、`J-Link DLL/Helper`、`RTT/P-RTLog`、`MCP endpoint`、`Commands run`、`Manual confirmation required`。
