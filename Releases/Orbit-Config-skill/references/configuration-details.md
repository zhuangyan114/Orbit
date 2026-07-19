# Orbit Configuration Details

本文是 `Orbit-Config-skill` 的配置参考。配置项名称、枚举值、默认值和范围来自当前仓库的 `package.json`、debug configuration provider、DAP session、Plugin API 和 Native/Legacy channel 源码；不要把示例中的芯片、路径或 RTOS 值复制到另一个 firmware workspace。

## Workspace settings

下面是当前源码注册的关键 `orbit.*` workspace settings。旧版 `ozone.*` 设置会在激活时迁移；只有在目标工程需要时才写入，未列出的 VS Code/CMake 设置继续沿用项目现有配置。

| Setting | Type / unit | Default / range | 说明 |
| --- | --- | --- | --- |
| `orbit.jlinkPath` | path | `C:\Program Files\SEGGER\JLink\JLink.exe` | 自动 flash 使用的 J-Link Commander executable。|
| `orbit.jlinkDllPath` | path | `""` | 指定 `JLink_x64.dll`；空值时自动搜索。|
| `orbit.defaultDevice` | string | `STM32F407VG` | `device` 的共享默认值；必须改成当前真实 MCU。|
| `orbit.defaultInterface` | `SWD` / `JTAG` | `SWD` | 默认 debug interface。|
| `orbit.defaultSpeed` | number, kHz | `4000` | 默认 J-Link interface speed。|
| `orbit.defaultProgram` | path | `""` | 默认 ELF/AXF；空值时扫描 `build/Debug`、`build/Release`、`build`。|
| `orbit.defaultSvdFile` | path | `""` | 外部 Peripheral Viewer 使用的 SVD 默认路径。|
| `orbit.defaultRtos` | string | `""` | 默认 RTOS 名称；例如实际使用 FreeRTOS 时写 `FreeRTOS`。|
| `orbit.rtosViewsAutoRefresh` | boolean | `false` | 首次 stack trace 后是否请求外部 RTOS Views focus/refresh。|
| `orbit.rttLogEnabled` | boolean | `true` | 是否读取 SEGGER RTT。|
| `orbit.rttBufferIndex` | number | `0`, `0..15` | RTT up-buffer index。|
| `orbit.rttPollIntervalMs` | number, ms | `50`, `10..5000` | RTT poll interval。|
| `orbit.rttReadSize` | number, bytes/poll | `4096`, `64..65536` | 每轮 RTT 最大读取字节数。|
| `orbit.rttControlBlockAddress` | string | `""` | RTT control block address；空值交给 J-Link 自动检测。|
| `orbit.rttStripAnsi` | boolean | `true` | 仅去除写入 Debug Console 的 ANSI 控制序列。|
| `orbit.rttLogTarget` | `terminal` / `debugConsole` / `both` | `terminal` | RTT 输出位置。|
| `orbit.pRtLogEnabled` | boolean | `false` | 是否把 RTT bytes 解码为 P-RTLog tokenized frames。|
| `orbit.pRtLogRoot` | path | `""` | P-RTLog root 配置/诊断值；当前 decoder 不从该目录搜索 token。|
| `orbit.nativeDebugEngine.enabled` | boolean | `true` | Native helper 总开关。|
| `orbit.nativeDebugEngine.mode` | `legacy` / `native` / `auto` | `auto` | target owner 选择策略。|
| `orbit.watchPollIntervalMs` | number, ms | `500`, `100..10000` | Watch Webview 可见时的刷新计时基准。|
| `orbit.timelineSampleIntervalMs` | number, ms | `0.2`, `0.1..10000` | Timeline target sampling 目标间隔。|
| `orbit.timelineSendIntervalMs` | number, ms | `16`, `1..10000` | Timeline 向 Webview 发送更新的间隔。|

另有源码会读取但 `package.json` 当前未注册的 workspace setting：`orbit.flashBeforeDebug`，默认 `true`。它控制有 `program` 时是否先调用 `JLink.exe` flash；launch 层的 `flashBeforeDebug: false` 可以跳过 flash。

External Views 的 tracker arrays 不是 Orbit 自有 setting，但可以在目标 workspace 中加入：

```json
{
  "memory-view.trackDebuggers": ["ozone"],
  "mcu-debug.rtos-views.trackDebuggers": ["ozone"],
  "mcu-debug.debug-tracker-vscode.trackDebuggers": ["ozone"]
}
```

合并时保留数组已有元素，并确保 `"ozone"` 不重复。

## Launch configuration

最小结构：

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "ozone",
      "request": "launch",
      "name": "Orbit: Debug STM32"
    }
  ]
}
```

当前 `package.json` debug schema 注册的 launch properties 如下。`default` 是 schema/config provider 的默认值，不代表当前板卡一定应使用该值。

| Property | Type / unit | Default / range | 说明 |
| --- | --- | --- | --- |
| `device` | string | `STM32F407VG` | J-Link device name。|
| `deviceName` | string | `STM32F407VG` | 外部 MCU Views 兼容别名；provider 默认跟随 `device`。|
| `program` | path | `${workspaceFolder}/build/Debug/frame.elf` | ELF/AXF；provider 可能自动从 build 目录选择。|
| `svdFile` | path | `""` | SVD 兼容字段。|
| `svdPath` | path | `""` | SVD 兼容字段；provider 默认跟随 `svdFile`。|
| `interface` | `SWD` / `JTAG` | `SWD` | J-Link interface。|
| `speedKHz` | number, kHz | `4000` | J-Link interface speed。|
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

源码还支持 launch-only/未在 schema 注册但被读取的字段：`elfPath` 是 `program` 的别名；`flashBeforeDebug` 默认 `true`。`interface`、`device`、`speedKHz`、`rtos` 和所有 RTT/P-RTLog/Native 字段最终由 DAP session 使用。

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

## Native / Legacy owner

Native helper 路径为 source checkout 的 `out/native/win32-x64/orbit-jlink-helper.exe`。Native 与 Legacy 不能在同一 DAP session 同时持有 target。`auto` 的 fallback 发生在 Native startup/initialization 失败或已 dispose 的 Native owner loss 之后；不会 hot-switch，Native owner 丢失通常要求结束并重新启动 session。

Native scheduler 的优先级是 `control > watch > timeline`。step、continue、halt、reset、breakpoint 和 write 属于 control work；不要通过第二个 DLL owner 绕过调度。

## RTOS Views

Orbit 通过 DAP capability 和外部 extension tracker 对接 RTOS Views；Orbit 本身不解析 RTOS kernel。需要三层同时正确：

1. tracker arrays 含 `"ozone"`，且对应的 MCU Debug extensions 已安装；
2. launch 的 MCU、active ELF、SVD、`rtos` 一致；
3. firmware 有外部 RTOS View 所需的 symbols、trace 和 runtime-stat hooks。

`orbit.rtosViewsAutoRefresh` 默认 `false`；设为 `true` 时，源码会在外部 tracker 报告首次 stack trace 后尝试 focus/refresh RTOS Views。

## RTT and P-RTLog

RTT 必须由 firmware 初始化 SEGGER RTT control block，当前 J-Link DLL 还要导出 RTT control/read 函数。`rttStripAnsi` 仅影响 Debug Console；terminal 输出保留 ANSI。RTT `ESC[2J` 会触发 Debug Console 清屏行为。

P-RTLog frame 格式是：

```text
[2-byte little-endian length][frame payload]
```

frame 的前 4 bytes 是 little-endian token。decoder 从 active ELF 的 `.pw_tokenizer.entries` 读取 token metadata，并处理整数、浮点、字符串、指针和 printf 类参数；未知或截断 frame 应报告 decoder diagnostic。`pRtLogRoot` 当前不会让 decoder 从该目录加载 token。

## MCP and Plugin API

MCP server：`Releases/mcp/orbit-mcp-server.js`，stdio 进程；它读取 `ORBIT_PLUGIN_API_ENDPOINT_FILE` 指向的 endpoint，再访问 loopback Plugin API。endpoint 通常位于：

```text
%APPDATA%\Code\User\globalStorage\orbit-debug.orbit-for-vscode\plugin-api-endpoint.json
```

Plugin API 使用 `127.0.0.1`、随机端口、`/health` GET 和带 Bearer token 的 `/rpc` POST；endpoint 文件在 extension global storage 中生成。当前 MCP tools：`ozone_status`、`ozone_read_many`、`ozone_write_many`、`ozone_record`、`ozone_experiment_run`。

如果活动 `ozone` DAP session 存在，runtime reads/writes/status 通过该 DAP session 路由；DAP 请求失败应返回错误，不回退到另一个 Extension Host target owner。

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

最终报告使用以下英文字段名，内容可用中文：`Files changed`、`Launch`、`Device`、`Interface`、`Speed`、`SVD`、`RTOS`、`J-Link DLL`、`Native/Legacy owner`、`RTT/P-RTLog`、`MCP endpoint`、`Commands run`、`Manual confirmation required`。
