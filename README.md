# Ozone for VS Code

> 以 SEGGER Ozone 为调试引擎的现代化嵌入式 IDE 插件，支持 STM32 全系列 ARM Cortex-M MCU。

[![Version](https://img.shields.io/badge/version-0.1.0-blue)](https://github.com/ozone-debug/ozone-for-vscode)
[![VS Code](https://img.shields.io/badge/vscode-%5E1.90.0-007ACC)](https://code.visualstudio.com/api)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-0078D6)]()

---

## 功能一览

| 类别 | 功能 | 状态 |
|------|------|------|
| 会话管理 | 启动/停止/重启调试会话，支持 .jdebug 脚本，最近会话记录 | ✅ MVP |
| 断点管理 | 编辑器 gutter 设断，条件断点、日志断点，断点列表视图 | ✅ MVP |
| 执行控制 | 运行/暂停、Step Into/Over/Out、复位 | ✅ MVP |
| 变量与寄存器 | 局部变量自动显示、Watch 表达式、核心寄存器 R0-xPSR | ✅ MVP |
| 调用栈 | 栈帧视图、点击跳转源码、栈帧切换变量同步 | ✅ MVP |
| 内存浏览器 | Hex + ASCII 显示、跳转任意地址、内存监视点 | ✅ MVP |
| 反汇编 | 同步 PC 指令、源码-反汇编混合模式 | ✅ MVP |
| AI 助手 | 断点建议、变量解释、崩溃分析、代码修复 | ✅ 接口预留 |
| RTOS 感知 | FreeRTOS/RT-Thread 任务列表、栈使用、任务切换 | 🚧 P1 |
| Trace 支持 | 指令跟踪、时序分析、覆盖率 | 🚧 P1 |
| 数据可视化 | 实时波形图、堆/栈使用趋势 | 🚧 P1 |

---

## 环境要求

| 依赖 | 说明 |
|------|------|
| **操作系统** | Windows 10 / 11（Ozone 仅支持 Windows） |
| **VS Code** | ≥ 1.90.0 |
| **SEGGER Ozone** | 安装 Ozone（含 `ozonede.exe`），默认路径 `C:\Program Files\SEGGER\Ozone\` |
| **J-Link 驱动** | 安装 J-Link Software Pack，确保调试器驱动正常 |
| **调试硬件** | SEGGER J-Link / J-Trace 或兼容调试器 |
| **Node.js** | ≥ 20（仅开发需要） |

---

## 快速开始

### 1. 安装 Ozone

下载并安装 [SEGGER Ozone](https://www.segger.com/products/debug-probes/j-link/tools/ozone/)，确保 `ozonede.exe` 可用。

### 2. 安装插件

在 VS Code 扩展商店搜索 `Ozone for VS Code`，或从 VSIX 安装：

```bash
code --install-extension ozone-for-vscode.vsix
```

### 3. 配置

打开 VS Code 设置 → 搜索 `ozone`，或直接编辑 `settings.json`：

```jsonc
{
  // Ozone 路径（默认自动检测）
  "ozone.ozonePath": "C:\\Program Files\\SEGGER\\Ozone\\ozonede.exe",

  // 默认调试目标
  "ozone.defaultDevice": "STM32F407VG",
  "ozone.defaultInterface": "SWD",
  "ozone.defaultSpeed": 4000,

  // AI 配置（可选）
  "ozone.ai.enabled": true,
  "ozone.ai.provider": "ollama",
  "ozone.ai.ollamaUrl": "http://localhost:11434",
  "ozone.ai.ollamaModel": "llama3.2"
}
```

### 4. 开始调试

1. 点击左侧活动栏的 **Ozone Debug** 图标（芯片 logo）
2. 在 Debug Session 面板点击 **Connect**
3. 输入芯片型号（如 `STM32F407VG`）
4. 等待 Ozone 连接完成，状态栏显示 `Ozone: STM32F407VG @ SWD`

---

## 使用教程

### 调试会话

```
Ozone Debug 面板
├── [Connect]         → 启动新调试会话
├── [Disconnect]      → 断开当前连接
├── 状态指示灯         → 绿色=运行中, 黄色=已暂停, 红色=断开
└── Tab 切换          → Control / Registers / Memory / AI / Settings
```

- **启动会话**：在 Debug Session 面板点击 Connect，输入芯片型号
- **停止会话**：点击 Disconnect
- **快速重启**：执行命令 `Ozone: Restart Debug Session`

### 断点操作

- **设置/取消**：在编辑器行号左侧点击，或光标所在行按 `Ctrl+Shift+B`
- **查看断点**：活动栏 Breakpoints 视图列出所有断点
- **条件断点**：在代码中右键 → 断点条件...（即将支持）

### 执行控制

在 Debug Session 面板的 Control 标签页：

| 按钮 | 快捷键 | 说明 |
|------|--------|------|
| ▶ Run | `F5` | 全速运行 |
| ⏸ Halt | `Shift+F5` | 暂停执行 |
| ↘ Step Into | `F11` | 单步进入 |
| → Step Over | `F10` | 单步跳过 |
| ↖ Step Out | `Shift+F11` | 步出当前函数 |
| ⟳ Reset | - | 复位 MCU |

### 查看变量与寄存器

- **Variables 视图**：自动显示当前栈帧的局部变量
- **Registers 视图**：显示 R0-R15、SP、LR、PC、xPSR
- **Watch 表达式**：在 Variables 面板添加监视表达式

### 调用栈

- Call Stack 视图显示当前线程调用链
- 点击栈帧跳转到对应源码位置
- 切换栈帧后变量视图自动同步

### 内存浏览器

在 Memory 标签页：
1. 输入地址（如 `0x20000000`）
2. 输入读取大小（字节）
3. 点击 Read 查看 Hex + ASCII 内容

---

## AI 集成

### 配置 Ollama（推荐）

```bash
# 安装 Ollama
curl -fsSL https://ollama.ai/install.sh | sh

# 拉取调试模型（推荐）
ollama pull llama3.2

# 确认服务运行在 http://localhost:11434
```

设置 → `ozone.ai.provider` → `ollama`，在 AI 面板即可与调试助手对话。

### 配置 OpenAI 兼容 API

```jsonc
{
  "ozone.ai.provider": "openai-compatible",
  "ozone.ai.openaiUrl": "https://api.openai.com/v1",
  "ozone.ai.openaiKey": "sk-xxx",
  "ozone.ai.openaiModel": "gpt-4o-mini"
}
```

### AI 能做什么

- **变量解释**："R0 寄存器当前值是 0xDEADBEEF，这是什么意思？"
- **崩溃分析**："发生了 HardFault，帮我分析调用栈"
- **断点建议**："UART 接收中断没有触发，应该在哪里设断点？"
- **代码修复**："这段代码可能导致死锁，帮我检查"

---

## 开发指南

### 克隆与构建

```bash
git clone https://github.com/ozone-debug/ozone-for-vscode
cd ozone-for-vscode
npm install
npm run build     # 编译 extension + webview
npm run typecheck # 类型检查
```

### 调试插件

在 VS Code 中按 `F5`，选择：
- **Run Extension** — 先编译再启动
- **Extension + Watch** — 监听文件变化自动重编译

### 项目结构

```
src/
├── extension.ts                # 扩展入口
├── ozone-backend/
│   ├── types.ts                # 类型定义
│   └── commander.ts            # Ozone CLI 通信
├── session/
│   └── session-manager.ts      # 会话管理
├── breakpoints/
│   └── breakpoint-manager.ts   # 断点管理
├── debug-providers/
│   ├── variable-provider.ts    # 变量/寄存器 TreeView
│   ├── stack-frame-provider.ts # 调用栈 TreeView
│   └── memory-provider.ts      # 内存读写
├── ai/
│   ├── types.ts                # AIProvider 接口
│   ├── ai-provider-manager.ts  # AI 管理器
│   └── providers/
│       ├── ollama-provider.ts  # Ollama 实现
│       └── openai-compatible-provider.ts  # OpenAI 兼容实现
└── webview/
    ├── webview-provider.ts     # WebView 桥接
    ├── app.tsx                 # React 主面板
    └── main.tsx                # WebView 入口
```

### 命令参考

| 命令 | 说明 |
|------|------|
| `npm run build` | esbuild 编译 |
| `npm run watch` | 监听模式编译 |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm run lint` | ESLint 检查 |
| `npm test` | Vitest 运行测试 |
| `npm run dev` | 编译 + 启动扩展开发窗口 |

---

## 配置参考

| 设置项 | 默认值 | 说明 |
|--------|--------|------|
| `ozone.ozonePath` | `C:\Program Files\SEGGER\Ozone\ozonede.exe` | Ozone CLI 路径 |
| `ozone.jlinkPath` | `C:\Program Files\SEGGER\JLink\JLink.exe` | J-Link Commander 备选路径 |
| `ozone.defaultDevice` | `STM32F407VG` | 默认芯片型号 |
| `ozone.defaultInterface` | `SWD` | 调试接口 (SWD/JTAG) |
| `ozone.defaultSpeed` | `4000` | 接口速度 (kHz) |
| `ozone.recentSessions` | `10` | 最近会话记录数 |
| `ozone.ai.enabled` | `true` | 启用 AI |
| `ozone.ai.provider` | `ollama` | AI 后端 (ollama/openai-compatible) |
| `ozone.ai.ollamaUrl` | `http://localhost:11434` | Ollama 地址 |
| `ozone.ai.ollamaModel` | `llama3.2` | Ollama 模型 |
| `ozone.ai.openaiUrl` | `` | OpenAI 兼容 API 地址 |
| `ozone.ai.openaiKey` | `` | API Key |
| `ozone.ai.openaiModel` | `gpt-4o-mini` | OpenAI 模型 |

---

## 常见问题

**Q: 连接 Ozone 时提示 "ozonede.exe not found"？**
A: 检查 `ozone.ozonePath` 设置是否正确，或重新安装 SEGGER Ozone。

**Q: 支持 Mac/Linux 吗？**
A: 暂不支持。Ozone 本身仅支持 Windows，本插件依赖 Ozone CLI。

**Q: AI 面板提示 "Connection failed"？**
A: 确认 Ollama 服务已启动：`ollama serve`，或检查 `ozone.ai.ollamaUrl` 配置。

**Q: 如何添加新的调试器支持？**
A: 目前仅支持 SEGGER Ozone。如需扩展，可提交 Issue 或 PR。

---

## 路线图

- **M1** 架构搭建 ✅
- **M2** MVP 功能（会话、断点、执行、变量、栈） ✅
- **M3** 内存与反汇编
- **M4** AI 集成
- **M5** RTOS + Trace + 可视化
- **M6** 发布 Marketplace

---

## 许可

[MIT](LICENSE)

## 致谢

- [SEGGER Ozone](https://www.segger.com/products/debug-probes/j-link/tools/ozone/) — 强大的调试引擎
- [VS Code Extension API](https://code.visualstudio.com/api) — 扩展框架
- [Ollama](https://ollama.ai/) — 本地 AI 推理