# Ozone for VS Code

Ozone for VS Code 是一个面向 STM32 / ARM Cortex-M 的 VS Code 调试扩展。扩展通过 SEGGER J-Link DLL 直接访问目标板，提供 Debug Adapter Protocol 调试、Watch 变量、实时 Timeline 采样、SEGGER RTT 日志、P-RTLog tokenized RTT 日志解码、本地插件 API 和 MCP 工具集成。

当前版本：`0.4.5`

## 版本更新日志

### 0.4.5

- 新增 P-RTLog tokenized RTT 日志解码支持。
- 支持从 ELF/AXF 的 `.pw_tokenizer.entries` 中加载 token 字符串表。
- 支持解析 P-RTLog RTT 二进制帧格式：`[2-byte length][token + encoded args]`。
- 支持还原常见 printf 参数：`%d`、`%u`、`%x`、`%X`、`%c`、`%f`、`%s`、`%p`。
- RTT Terminal 中按日志级别显示 `I:`、`W:`、`E:` 前缀，并保留 ANSI 颜色输出。
- 新增配置项：
  - `ozone.pRtLogEnabled`
  - `ozone.pRtLogRoot`
  - launch 配置中的 `pRtLogEnabled`
  - launch 配置中的 `pRtLogRoot`
- 保留普通 SEGGER RTT 文本日志路径，默认不启用 P-RTLog 解码，避免影响现有项目。
- 改进 RTT 输出目标控制，支持 `terminal`、`debugConsole`、`both`。
- 打包产物更新为 `ozone-for-vscode-0.4.5.vsix`。

P-RTLog 项目地址：[https://github.com/moment-NEW/P-RTLog](https://github.com/moment-NEW/P-RTLog)

### 0.4.1

- 增强 Watch 和 Timeline 运行时读取能力。
- 改进 RTT Terminal 与 Debug Console 的输出分流。
- 修复运行中 Watch 轮询和缓存更新的稳定性问题。
- 补充 RTOS Views、MemoryView、Peripheral Viewer 相关 DAP 能力。

### 0.4.0

- 适配 mcu-debug 系列外部视图：MemoryView、Peripheral Viewer、RTOS Views。
- DAP 初始化能力新增 `supportsReadMemoryRequest` 和 `supportsWriteMemoryRequest`。
- 实现标准 `readMemory` / `writeMemory` 请求。
- `evaluate` 和 `variables` 支持结构体、数组、指针 child expansion。
- 返回 `variablesReference` 和 `memoryReference`，便于外部视图递归展开对象。
- 表达式读取新增地址表达式支持，例如 `0x20000000` 和 `&symbol`。
- 新增 launch 配置别名：`deviceName`、`svdFile`、`svdPath`、`rtos`。
- 新增设置项：`ozone.defaultSvdFile` 和 `ozone.defaultRtos`。
- 新增命令 `Ozone: Enable MCU Debug Views Integration`。
- 打包产物更新为 `ozone-for-vscode-0.4.0.vsix`。

### 0.3.0

- 新增 SEGGER RTT 日志读取。
- 调试启动后自动读取 RTT up-buffer 并输出到 VS Code。
- 新增 RTT 配置项：`rttLogEnabled`、`rttBufferIndex`、`rttPollIntervalMs`、`rttReadSize`、`rttControlBlockAddress`、`rttStripAnsi`。
- 注册 `ozone` debug configuration provider，使 RTT 默认配置可以从 VS Code settings 自动带入调试会话。
- Timeline 采样优先通过当前 `ozone` debug session 进行高速读取。
- 打包产物更新为 `ozone-for-vscode-0.3.0.vsix`。

## 功能

- J-Link DLL 直连调试：启动、暂停、继续、单步、复位、断点。
- VS Code Debug Adapter Protocol 集成，可通过 `.vscode/launch.json` 启动 `ozone` 调试会话。
- Watch 视图支持表达式读取、结构体/数组/指针展开和运行时轮询。
- Timeline 视图支持变量实时采样和 Canvas 波形显示。
- SEGGER RTT 文本日志读取。
- P-RTLog tokenized RTT 日志解码。
- MemoryView / Peripheral Viewer 可通过标准 DAP memory request 读取目标内存。(暂时无法使用)
~~ - RTOS Views 可通过标准 DAP evaluate/variables request 展开 RTOS 对象。 ~~
- 符号与 DWARF 解析使用 `arm-none-eabi-nm` 和 `arm-none-eabi-objdump`。
- 本地插件 API 通过 `127.0.0.1` HTTP RPC 暴露目标状态、表达式读写、波形记录和实验流程。
- MCP server 可让 Codex、Claude Desktop 等 MCP 客户端读取和控制当前 Ozone 调试会话。

## 系统要求

- Windows 10/11。
- VS Code `1.90.0` 或更高版本。
- 已安装 SEGGER J-Link，并能找到 `JLink_x64.dll`。
- `arm-none-eabi-nm` 和 `arm-none-eabi-objdump` 在 `PATH` 中，用于 ELF 符号和 DWARF 信息解析。
- Node.js 18 或更高版本，仅源码开发和 MCP server 运行需要。

## 安装 VSIX

生成的扩展包为：

```powershell
ozone-for-vscode-0.4.5.vsix
```

在 VS Code 中安装：

1. 打开扩展面板。
2. 点击右上角 `...`。
3. 选择 `Install from VSIX...`。
4. 选择 `ozone-for-vscode-0.4.5.vsix`。

也可以使用命令行安装：

```powershell
code --install-extension .\ozone-for-vscode-0.4.5.vsix
```

## 快速开始

在目标工程中创建 `.vscode/launch.json`：

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "ozone",
      "request": "launch",
      "name": "Ozone Debug",
      "program": "${workspaceFolder}/build/Debug/frame.elf",
      "device": "STM32F407VG",
      "deviceName": "STM32F407VG",
      "interface": "SWD",
      "speedKHz": 4000,
      "svdFile": "${workspaceFolder}/STM32F407.svd",
      "rtos": "FreeRTOS"
    }
  ]
}
```

启动调试后，可以在 Watch 面板添加变量，在 Timeline 面板查看变量波形。

## P-RTLog 日志解码

P-RTLog 是一个基于 Pigweed tokenized log 和 SEGGER RTT 的轻量日志库。项目地址：

[https://github.com/moment-NEW/P-RTLog](https://github.com/moment-NEW/P-RTLog)

P-RTLog 固件侧通过 RTT 输出二进制 tokenized 帧。普通 RTT Viewer 或普通文本模式会看到乱码；启用本扩展的 P-RTLog 解码后，扩展会从当前 ELF/AXF 中读取 `.pw_tokenizer.entries`，把 token 和参数还原成可读日志。

### launch.json 示例

```json
{
  "type": "ozone",
  "request": "launch",
  "name": "Ozone Debug",
  "program": "${workspaceFolder}/build/Debug/vet6_led.elf",
  "device": "STM32F407VE",
  "interface": "SWD",
  "speedKHz": 4000,
  "rttLogEnabled": true,
  "rttBufferIndex": 0,
  "rttLogTarget": "terminal",
  "pRtLogEnabled": true,
  "pRtLogRoot": "D:\\STM32\\tool\\P-RTLog"
}
```

### settings.json 示例

```json
{
  "ozone.pRtLogEnabled": true,
  "ozone.pRtLogRoot": "D:\\STM32\\tool\\P-RTLog",
  "ozone.rttBufferIndex": 0,
  "ozone.rttLogTarget": "terminal"
}
```

### 输出示例

```text
I: loop cnt=2700 f=-0.558789 data1=141 [default] (D:/STM32/project/vet6_led/Core/Src/main.c)
W: P-RTLog RTT channel test data1=1 [default] (D:/STM32/project/vet6_led/Core/Src/main.c)
E: P-RTLog error sample code=-1 [default] (D:/STM32/project/vet6_led/Core/Src/main.c)
```

### 注意事项

- `pRtLogEnabled` 默认是 `false`，只有 P-RTLog 二进制帧项目才需要启用。
- 普通 RTT 文本日志不要开启 `pRtLogEnabled`。
- ELF/AXF 必须保留 `.pw_tokenizer.entries`，否则只能显示 unknown token。
- RTT Terminal 会保留 ANSI 颜色；Debug Console 是否显示颜色取决于 VS Code 输出面板和 `rttStripAnsi` 设置。
- 如果固件侧使用不同 RTT channel，请同步设置 `rttBufferIndex`。

## MCU Debug Views 集成

本扩展可以配合 mcu-debug 系列视图使用：

- RTOS Views：查看 FreeRTOS 等 RTOS 的任务、线程、栈和调度状态。
- MemoryView：按地址查看和编辑目标内存。
- Peripheral Viewer：通过 CMSIS-SVD 文件查看外设寄存器和 bit 字段。

首次使用时，在命令面板执行：

```text
Ozone: Enable MCU Debug Views Integration
```

该命令会在当前 workspace 中追加：

```json
{
  "memory-view.trackDebuggers": ["ozone"],
  "mcu-debug.rtos-views.trackDebuggers": ["ozone"]
}
```

Peripheral Viewer 需要配置 SVD 文件：

```json
{
  "ozone.defaultSvdFile": "C:\\path\\to\\device.svd"
}
```

RTOS Views 需要配置 RTOS 类型：

```json
{
  "ozone.defaultRtos": "FreeRTOS"
}
```

也可以直接写在 `launch.json` 中：

```json
{
  "type": "ozone",
  "request": "launch",
  "name": "Ozone Debug",
  "program": "${workspaceFolder}/build/Debug/frame.elf",
  "device": "STM32F407VG",
  "deviceName": "STM32F407VG",
  "svdFile": "${workspaceFolder}/STM32F407.svd",
  "svdPath": "${workspaceFolder}/STM32F407.svd",
  "rtos": "FreeRTOS"
}
```

## 配置项

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `ozone.jlinkPath` | `C:\Program Files\SEGGER\JLink\JLink.exe` | J-Link Commander 路径，仅作为备用配置。 |
| `ozone.jlinkDllPath` | 空 | `JLink_x64.dll` 路径，留空时自动检测。 |
| `ozone.defaultDevice` | `STM32F407VG` | 默认目标芯片型号。 |
| `ozone.defaultInterface` | `SWD` | 默认调试接口，可选 `SWD` 或 `JTAG`。 |
| `ozone.defaultSpeed` | `4000` | 默认接口速度，单位 kHz。 |
| `ozone.defaultProgram` | 空 | 默认 ELF/AXF 路径，留空时自动扫描 `build` 目录。 |
| `ozone.defaultSvdFile` | 空 | 默认 CMSIS-SVD 文件路径，用于 Peripheral Viewer。 |
| `ozone.defaultRtos` | 空 | 默认 RTOS 类型，用于 RTOS Views，例如 `FreeRTOS`。 |
| `ozone.rttLogEnabled` | `true` | 是否读取 SEGGER RTT 输出。 |
| `ozone.rttBufferIndex` | `0` | SEGGER RTT up-buffer 索引。 |
| `ozone.rttPollIntervalMs` | `50` | RTT 轮询间隔，单位毫秒。 |
| `ozone.rttReadSize` | `4096` | 每次 RTT 读取的最大字节数。 |
| `ozone.rttControlBlockAddress` | 空 | 可选 RTT control block 地址。 |
| `ozone.rttStripAnsi` | `true` | 是否在 Debug Console 中移除 SEGGER/ANSI 控制序列。 |
| `ozone.rttLogTarget` | `terminal` | RTT 输出目标：`terminal`、`debugConsole` 或 `both`。 |
| `ozone.pRtLogEnabled` | `false` | 是否按 P-RTLog tokenized RTT 帧解码。 |
| `ozone.pRtLogRoot` | `D:\STM32\tool\P-RTLog` | P-RTLog 工具库根目录。 |
| `ozone.timelineSampleIntervalMs` | `0.2` | Timeline 目标采样间隔，单位毫秒。 |
| `ozone.timelineSendIntervalMs` | `16` | Timeline UI 更新间隔，单位毫秒。 |

## MCP 集成

扩展激活后会启动插件 API，并将连接信息写入 VS Code global storage：

```text
%APPDATA%\Code\User\globalStorage\ozone-debug.ozone-for-vscode\plugin-api-endpoint.json
```

MCP server 位于：

```text
mcp/ozone-mcp-server.js
```

MCP 客户端配置示例：

```json
{
  "mcpServers": {
    "ozone": {
      "command": "node",
      "args": [
        "C:\\Users\\22690\\Desktop\\AI\\Ozone for VScode\\mcp\\ozone-mcp-server.js"
      ],
      "env": {
        "OZONE_PLUGIN_API_ENDPOINT_FILE": "C:\\Users\\22690\\AppData\\Roaming\\Code\\User\\globalStorage\\ozone-debug.ozone-for-vscode\\plugin-api-endpoint.json"
      }
    }
  }
}
```

MCP 工具：

- `ozone_status`：读取插件 API 和目标状态。
- `ozone_read_many`：读取一个或多个调试表达式。
- `ozone_write_many`：向一个或多个调试表达式写入数值。
- `ozone_record`：按固定间隔记录变量波形。
- `ozone_experiment_run`：执行 read、write、wait、record 组合实验。

## 源码开发

安装依赖：

```powershell
npm install
```

构建扩展：

```powershell
npm run build
```

类型检查：

```powershell
npm run typecheck
```

打包 VSIX：

```powershell
npx @vscode/vsce package --out ozone-for-vscode-0.4.5.vsix
```

运行 MCP server：

```powershell
npm run mcp
```

## 目录结构

```text
src/extension.ts                 扩展主入口
src/debugadapter.ts              Debug Adapter 入口
src/debug/dap-session.ts         DAP 请求、事件和 RTT/P-RTLog 逻辑
src/debug/p-rtlog-decoder.ts     P-RTLog tokenized RTT 解码器
src/ozone-backend/               J-Link DLL、符号和命令分发
src/debug-providers/             Watch 与数据采样逻辑
src/webview/                     Watch 和 Timeline 前端
src/plugin-api/                  本地插件 API
mcp/ozone-mcp-server.js          MCP server
dist/                            esbuild 输出
```

## 注意事项

- 当前扩展主要面向 Windows，因为调试链路依赖 `JLink_x64.dll`。
- 常规调试命令不启动 Ozone GUI，也不依赖 JLink.exe 子进程。
- 当已有 `ozone` 调试会话时，Watch 和数据采样请求应通过 debug session 路由。
- 对目标写值前建议先进行只读检查，并在 MCP 实验里设置安全范围。
- Peripheral Viewer 的寄存器树质量取决于所配置的 SVD 文件。
- RTOS Views 的可见信息取决于 ELF/DWARF 符号、RTOS 类型和目标当前运行状态。

## 许可证

MIT
