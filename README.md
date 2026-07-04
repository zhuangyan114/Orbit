# Ozone for VS Code

现代 STM32 嵌入式调试插件，基于 SEGGER J-Link DLL 直接驱动，提供 DAP (Debug Adapter Protocol) 调试体验和 AI 集成能力。

## 功能

- **DAP 调试** — 启动/暂停/单步/复位，完整 DAP 协议支持
- **断点** — gutter 设置行内断点，支持 6 个硬件断点
- **变量/Watch** — 局部变量、Watch 表达式（5Hz 运行时轮询）、结构体/数组展开
- **寄存器** — R0-R15、SP、LR、PC、xPSR 实时读取
- **调用栈** — PC + LR 栈帧回溯，点击跳转源码
- **Step Over/Into/Out** — 智能步过（自动识别 BL/BLX 指令）
- **Data Sampling / Timeline** — 100Hz 变量采样，Canvas 实时波形图
- **AI 集成** — Ollama / OpenAI 兼容 API，代码辅助分析
- **自动 Flash** — 启动调试时自动烧录 ELF
- **多会话** — 同时调试多个开发板

## 要求

- Windows 10/11（JLink_x64.dll 仅限 Windows）
- [SEGGER J-Link](https://www.segger.com/downloads/jlink/) 已安装（V956+ 推荐）
- `arm-none-eabi-nm` 和 `arm-none-eabi-objdump` 在 PATH 中（用于符号/DWARF 解析）
- VS Code 1.90+

## 安装

### 从 VSIX 安装

1. 在 [Releases](https://github.com/ozone-debug/ozone-for-vscode/releases) 下载 `.vsix`
2. VS Code → 扩展视图 → `···` → Install from VSIX...

### 从源码打包

```bash
git clone https://github.com/ozone-debug/ozone-for-vscode.git
cd ozone-for-vscode
npm install
npm run build
npm install -g @vscode/vsce
vsce package
# 安装生成的 .vsix
```

## 快速开始

1. 在项目根目录创建 `.vscode/launch.json`：

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

2. 按 `F5` 启动调试（自动 Flash → 连接 → Halt）
3. 在 gutter 点击设置断点，按 `F5` 继续运行
4. 使用 **Ozone Watch** 视图（活动栏）添加变量监视（运行时自动 5Hz 刷新）
5. 使用 **Ozone Timeline** 面板（底部 Terminal 区域）查看变量实时波形

## 设置

| 设置 | 默认值 | 说明 |
|------|--------|------|
| `ozone.jlinkPath` | `C:\Program Files\SEGGER\JLink\JLink.exe` | J-Link Commander 路径 |
| `ozone.jlinkDllPath` | `""` | JLink_x64.dll 路径（空则自动检测） |
| `ozone.defaultDevice` | `STM32F407VG` | 默认设备型号 |
| `ozone.defaultInterface` | `SWD` | 默认调试接口 |
| `ozone.defaultSpeed` | `4000` | 默认接口速度 (kHz) |

## 架构

```
WebView (React)  ←→  Extension Host (Node.js)  ←→  JLink_x64.dll (koffi FFI)
                           ↕
                    Debug Adapter (独立进程)
                    (spawn → DAP protocol)
```

- 调试引擎直接通过 [koffi](https://github.com/Koromix/rygel/tree/master/koffi) FFI 调用 JLink_x64.dll，无需 Ozone GUI 进程或 JLink.exe 子进程
- Debug Adapter 运行在独立 Node.js 进程中，避免 child_process 调用导致 VS Code extension host 崩溃
- 所有命令通过 `OzoneCommand`  discriminated union 类型安全分发

## AI 配置

在 VS Code 设置中配置：

```json
{
  "ozone.ai.provider": "ollama",
  "ozone.ai.ollamaUrl": "http://localhost:11434",
  "ozone.ai.ollamaModel": "codellama"
}
```

或使用 OpenAI 兼容 API：

```json
{
  "ozone.ai.provider": "openai-compatible",
  "ozone.ai.openaiUrl": "http://localhost:8000/v1",
  "ozone.ai.openaiModel": "deepseek-coder",
  "ozone.ai.apiKey": ""
}
```

## 开发

```bash
npm run build        # esbuild 构建
npm run watch        # 监听模式
npm run dev          # 构建 + 启动 Extension Host
npm run typecheck    # TypeScript 类型检查
npm run lint         # ESLint
npm test             # Vitest
```

`F5` → "Extension + Watch" 启动带热重载的开发调试。

## 许可

MIT
