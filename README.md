# Ozone for VS Code

Ozone for VS Code 是一个面向 STM32 / ARM Cortex-M 的 VS Code 调试扩展。扩展通过 SEGGER J-Link DLL 直接访问目标板，并提供 DAP 调试、Watch 变量、实时波形采样、插件 API 和 MCP 工具集成。

当前版本：`0.2.0`

## 功能

- J-Link DLL 直连调试，支持启动、暂停、继续、单步、复位和断点。
- VS Code Debug Adapter Protocol 集成，可使用 `.vscode/launch.json` 启动 `ozone` 调试会话。
- Watch 视图支持表达式读取、结构体/数组展开和运行时轮询。
- Timeline 视图支持变量实时采样和 Canvas 波形显示。
- 符号与 DWARF 解析使用 `arm-none-eabi-nm` 和 `arm-none-eabi-objdump`。
- 插件 API 通过本机 `127.0.0.1` HTTP RPC 暴露目标状态、表达式读写、波形记录和实验流程。
- MCP server 可让 Codex、Claude Desktop 等 MCP 客户端读取和控制当前 Ozone 调试会话。

## 系统要求

- Windows 10/11。
- VS Code `1.90.0` 或更高版本。
- 已安装 SEGGER J-Link，并能找到 `JLink_x64.dll`。
- `arm-none-eabi-nm` 和 `arm-none-eabi-objdump` 在 `PATH` 中，用于 ELF 符号和 DWARF 信息解析。
- Node.js 18 或更高版本，仅源码开发和 MCP server 运行需要。

## 安装 VSIX

生成好的扩展包为：

```powershell
ozone-for-vscode-0.2.0.vsix
```

在 VS Code 中安装：

1. 打开扩展面板。
2. 点击右上角 `...`。
3. 选择 `Install from VSIX...`。
4. 选择 `ozone-for-vscode-0.2.0.vsix`。

也可以使用命令行安装：

```powershell
code --install-extension .\ozone-for-vscode-0.2.0.vsix
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
      "interface": "SWD",
      "speedKHz": 4000
    }
  ]
}
```

启动调试后，可以在 Watch 面板添加变量，在 Timeline 面板查看变量波形。

## 配置项

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `ozone.jlinkPath` | `C:\Program Files\SEGGER\JLink\JLink.exe` | J-Link Commander 路径，仅作为备用配置。 |
| `ozone.jlinkDllPath` | 空 | `JLink_x64.dll` 路径，留空时自动检测。 |
| `ozone.defaultDevice` | `STM32F407VG` | 默认目标芯片型号。 |
| `ozone.defaultInterface` | `SWD` | 默认调试接口，可选 `SWD` 或 `JTAG`。 |
| `ozone.defaultSpeed` | `4000` | 默认接口速度，单位 kHz。 |
| `ozone.defaultProgram` | 空 | 默认 ELF/AXF 路径，留空时自动扫描 `build` 目录。 |

## MCP 集成

扩展激活后会启动插件 API，并将连接信息写入 VS Code 的 global storage：

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
        "C:\\Users\\22690\\Desktop\\Ozone for VScode\\mcp\\ozone-mcp-server.js"
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

配套 Codex skill 已复制到：

```text
mcp/skill
```

该 skill 描述了 MCP 工具的安全使用方式、表达式约定、波形记录和 PID/电机调参流程。

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
npx vsce package
```

运行 MCP server：

```powershell
npm run mcp
```

## 目录结构

```text
src/extension.ts                 扩展主入口
src/debugadapter.ts              Debug Adapter 入口
src/ozone-backend/               J-Link DLL、符号和命令分发
src/debug-providers/             Watch 与数据采样逻辑
src/webview/                     Watch 和 Timeline 前端
src/plugin-api/                  本机插件 API
mcp/ozone-mcp-server.js          MCP server
mcp/skill/                       MCP 控制 skill
dist/                            esbuild 输出
```

## 注意事项

- 该扩展当前仅支持 Windows，因为调试链路依赖 `JLink_x64.dll`。
- 常规调试命令不启动 Ozone GUI，也不依赖 JLink.exe 子进程。
- 当已有 `ozone` 调试会话时，Watch 和数据采样请求应通过 debug session 路由。
- 对目标写值前建议先进行只读检查，并在 MCP 实验里设置安全范围。

## 许可证

MIT
