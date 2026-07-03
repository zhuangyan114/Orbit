# Ozone for VS Code — 产品需求文档 (PRD)

## 1. 项目概述

### 1.1 背景
SEGGER Ozone 是功能强大的嵌入式调试器，支持 J-Link/J-Trace，覆盖全系列 ARM Cortex-M 内核 MCU（含 STM32）。但其 UI 陈旧、交互不流畅，且无 AI 扩展能力。

### 1.2 目标
构建 VS Code 插件，以 Ozone CLI/API 为调试后端，提供现代化 UI 和 AI 可扩展架构，让嵌入式调试体验达到 IDE 级水准。

### 1.3 核心原则
- **不重复造轮子** — 调试引擎完全依赖 Ozone，插件只做前端编排与展示
- **离线的 AI 优先** — AI 接口设计为本地模型优先（如通过 Ollama/vLLM 暴露的 OpenAI 兼容 API），支持可选的云端 LLM
- **VS Code 原生感** — 操作手感、快捷键、主题全部遵循 VS Code Design System

---

## 2. 功能需求

### P0 — 最小可用版 (MVP)

#### 2.1 会话管理
| ID | 功能 | 描述 |
|---|---|---|
| SESS-01 | 创建调试会话 | 选择 .jdebug 脚本或手动配置芯片型号、接口速度、连接方式 (SWD/JTAG) |
| SESS-02 | 启动/停止调试 | 启动 Ozone 后台进程，建立 Target Connection |
| SESS-03 | 最近会话 | 记录最近 10 次调试配置，一键重新连接 |
| SESS-04 | 多实例支持 | 允许同时调试多个开发板 (多窗口) |

#### 2.2 断点管理
| ID | 功能 | 描述 |
|---|---|---|
| BP-01 | 行内断点 | 在编辑器 gutter 点击设置/取消断点 |
| BP-02 | 断点类型 | 支持硬件断点、软件断点、条件断点、日志断点 |
| BP-03 | 断点列表视图 | 显示所有断点位置、类型、状态、命中次数 |
| BP-04 | 断点同步 | 断点状态实时同步到 Ozone 引擎 |

#### 2.3 执行控制
| ID | 功能 | 描述 |
|---|---|---|
| EXEC-01 | 运行/暂停 | 全速运行与暂停 |
| EXEC-02 | 单步调试 | Step Into、Step Over、Step Out |
| EXEC-03 | 运行到光标 | Run to Cursor |
| EXEC-04 | 复位 | MCU 复位并停在 main 入口 |

#### 2.4 变量与寄存器
| ID | 功能 | 描述 |
|---|---|---|
| VAR-01 | 局部变量 | 自动显示当前栈帧的局部变量 |
| VAR-02 | Watch 表达式 | 支持添加任意 C 表达式监视 |
| VAR-03 | 寄存器视图 | 显示核心寄存器 (R0-R15, SP, LR, PC, xPSR) 及特殊寄存器 |
| VAR-04 | 外设寄存器 | 读取 SVD 文件解析的外设寄存器，分组展示 |
| VAR-05 | 变量修改 | 支持直接编辑变量/寄存器值 |

#### 2.5 调用栈
| ID | 功能 | 描述 |
|---|---|---|
| STACK-01 | 调用栈视图 | 显示当前线程调用栈，支持点击跳转 |
| STACK-02 | 栈帧切换 | 选中栈帧后变量视图同步更新 |
| STACK-03 | 栈溢出检测 | 可视化栈使用率 |

#### 2.6 内存与反汇编
| ID | 功能 | 描述 |
|---|---|---|
| MEM-01 | 内存浏览器 | Hex + ASCII 显示，支持跳转到任意地址 |
| MEM-02 | 内存监视点 | 设置内存访问/写入断点 (Data Watchpoint) |
| MEM-03 | 反汇编视图 | 同步显示当前 PC 位置的指令 |
| MEM-04 | 混合模式 | 源码与反汇编混合展示 |

### P1 — 体验增强

#### 2.7 RTOS 感知
| ID | 功能 | 描述 |
|---|---|---|
| RTOS-01 | 任务列表 | 显示 FreeRTOS/RT-Thread 任务状态、栈使用、优先级 |
| RTOS-02 | 任务切换 | 点击任务后切换上下文，变量/栈同步更新 |

#### 2.8 Trace 支持 (J-Trace)
| ID | 功能 | 描述 |
|---|---|---|
| TRACE-01 | 指令跟踪 | 实时显示指令执行流 |
| TRACE-02 | 时序分析 | 函数执行时间统计，热点检测 |
| TRACE-03 | 覆盖率 | 代码执行覆盖率报告 |

#### 2.9 数据可视化
| ID | 功能 | 描述 |
|---|---|---|
| VIZ-01 | 实时波形 | 变量变化时序图 (类似 Logic Analyzer) |
| VIZ-02 | 堆/栈使用 | 动态内存使用趋势图 |

### P2 — AI 集成 (预留接口)

#### 2.10 AI 助手
| ID | 功能 | 描述 |
|---|---|---|
| AI-01 | 断点建议 | 根据当前调试状态，AI 推荐断点位置/条件 |
| AI-02 | 变量解释 | 选中变量值，AI 解释其含义及异常可能 |
| AI-03 | 崩溃分析 | 上传 HardFault 栈帧，AI 辅助分析原因 |
| AI-04 | 代码修复 | 定位到可疑代码后，AI 建议修复方案 |
| AI-05 | Watch 表达式生成 | 自然语言描述 → C 表达式 (如 "帮我监视 USART1 的波特率寄存器") |

#### 2.11 AI 接口设计
- **Provider 抽象层**：`AIDebugProvider` interface
  - `analyze(payload: DebugContext): Promise<AIResult>`
- **内置 Provider**：
  - Ollama (本地部署，默认)
  - OpenAI 兼容 API (配置 URL + Key)
- **请求上下文**：自动打包当前 PC、反汇编、变量、调用栈为结构化 JSON
- **安全沙箱**：所有 AI 调用在独立进程执行，不阻塞 UI

---

## 3. 架构设计

### 3.1 分层架构

```
┌─────────────────────────────────────────────────┐
│                   VS Code Extension              │
│  ┌─────────────────────────────────────────────┐ │
│  │               WebView UI (React)             │ │
│  │  - Variable Tree  - Call Stack              │ │
│  │  - Memory View    - Register View           │ │
│  │  - Watch Panel    - Breakpoint Panel        │ │
│  │  - RTOS Panel     - Trace Panel             │ │
│  │  - AI Chat Panel  - Waveform Viewer         │ │
│  └──────────────┬──────────────────────────────┘ │
│  ┌──────────────┴──────────────────────────────┐ │
│  │           Extension Host (Node.js)           │ │
│  │  - SessionManager     - BreakpointManager   │ │
│  │  - VariableProvider   - StackFrameProvider  │ │
│  │  - MemoryProvider     - CommandDispatcher   │ │
│  │  - AIProviderManager  - SettingsManager     │ │
│  └──────────────┬──────────────────────────────┘ │
└─────────────────┼────────────────────────────────┘
                  │ IPC / Child Process
┌─────────────────┴────────────────────────────────┐
│            Ozone Backend Interface                │
│  ┌─────────────────────────────────────────────┐ │
│  │          Ozone CLI / J-Link Commander        │ │
│  │  ozonede.exe --script                        │ │
│  │  JLink.exe -command                          │ │
│  │  Ozone .jdebug script                        │ │
│  └─────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────┘
```

### 3.2 通信协议
- **Ozone CLI 模式**：通过 `ozonede.exe --script <cmd>` 执行命令，解析 stdout 返回
- **J-Link Commander**：作为备选方案，通过 `JLink.exe -device ... -command` 控制
- **Ozone Remote API**（未来）：若 SEGGER 开放 TCP 接口则切换为长连接

### 3.3 数据流
```
User Action → WebView (React) → postMessage → Extension Host
→ CommandDispatcher → OzoneBackend.execute(cmd)
→ Parse Result → Update State ↔ WebView re-render
```

---

## 4. 技术选型

| 层 | 技术 | 理由 |
|---|---|---|
| 框架 | VS Code Extension API v1.90+ | 最新 TreeView / WebView API |
| UI | React 18 + Tailwind CSS + shadcn/ui | 可嵌入 WebView，组件生态好 |
| 状态管理 | Zustand | 轻量，TS 友好 |
| 调试协议 | Ozone CLI + J-Link Commander | 双通道保障，优雅降级 |
| AI | Ollama JavaScript SDK / OpenAI SDK | 本地模型优先 |
| 构建 | esbuild | 快，配置简单 |
| 语言 | TypeScript 全栈 | 端到端类型安全 |
| 单元测试 | Vitest | 与 esbuild 生态一致 |
| 图标 | VS Code Codicons + Lucide Icons | 符合 VS Code 设计语言 |

---

## 5. 用户界面设计

### 5.1 VS Code 视图容器
```
OZONE DEBUG ────────────────────────────────────
├── Debug Session      (会话控制: 启动/停止/复位)
├── Breakpoints        (断点列表 + 条件编辑)
├── Call Stack         (调用栈 + 栈帧切换)
├── Variables          (局部变量 + Watch)
├── Registers          (核心寄存器 + 外设)
├── Memory Browser     (内存查看/编辑)
├── Disassembly        (反汇编 + 混合模式)
├── RTOS Tasks         (实时任务列表) [P1]
├── Trace              (指令跟踪)     [P1]
├── AI Assistant       (AI 对话面板) [P2]
└── Serial Monitor     (串口输出)    [P1]
```

### 5.2 状态栏元素
- 当前调试状态 (Running / Halted / Disconnected)
- 当前 PC 地址 / 源码位置
- 连接时间 / 命中断点次数
- AI 状态 (ready / busy / error)

---

## 6. 非功能需求

| 类别 | 要求 |
|---|---|
| 性能 | 变量读取 < 100ms；内存读取 < 200ms；UI 帧率 > 30fps |
| 资源 | Ozone 子进程内存 < 200MB；插件自身 < 50MB |
| 兼容 | 支持 VS Code 1.90+，Windows 10/11 (Mac/Linux 暂不支持 Ozone) |
| 健壮 | Ozone 崩溃后自动恢复会话；网络中断不导致数据丢失 |
| 安全 | AI 请求仅在用户显式触发时发送；不泄露源代码 |
| 可扩展 | Provider 模式支持新调试后端、新 AI Provider |

---

## 7. 里程碑

| 阶段 | 内容 | 预计周期 |
|---|---|---|
| M1 架构搭建 | 项目脚手架、Ozone CLI 通信层、基础 WebView | 2 周 |
| M2 MVP | 会话管理 + 断点 + 执行控制 + 变量/寄存器 + 调用栈 | 4 周 |
| M3 内存与反汇编 | 内存浏览器 + 反汇编 + 混合模式 | 2 周 |
| M4 AI 集成 | AI Provider 框架 + AI Chat Panel + Ollama 集成 | 3 周 |
| M5 体验打磨 | RTOS 感知 + Trace + 波形图 + 性能优化 | 4 周 |
| M6 发布 | 文档 + 测试 + VS Code Marketplace 发布 | 2 周 |

---

## 8. Ozone CLI 参考

### 8.1 已知命令
```bash
# 启动 Ozone (无 GUI 模式)
ozonede.exe --jdebug script.jdebug --cmd "Project.EnableGUIMode(0)"

# 可能的控制序列（待实验确认）
ozonede.exe --cmd "Target.Connect()"
ozonede.exe --cmd "Target.Halt()"
ozonede.exe --cmd "Target.Run()"
ozonede.exe --cmd "Target.StepInto()"
ozonede.exe --cmd "Target.StepOver()"
ozonede.exe --cmd "Target.StepOut()"
ozonede.exe --cmd "Breakpoint.Set(1, \"main.c\", 42)"
ozonede.exe --cmd "Breakpoint.Delete(1)"
ozonede.exe --cmd "Read.Register(\"R0\")"
ozonede.exe --cmd "Read.Memory(0x20000000, 256)"
ozonede.exe --cmd "Write.Memory(0x20000000, 0xDEADBEEF)"
```

### 8.2 待实验确认
- Ozone 是否提供 JSON 格式输出 (vs 纯文本)
- Ozone Remote API 的 TCP 端口与协议
- Ozone 批处理模式下的错误码约定
- 多 Target 支持的限制

---

## 9. 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| Ozone CLI 功能不足 | 中 | 高 | 备选 J-Link Commander；必要时封装 JLink SDK DLL |
| Ozone 无 JSON 输出 | 高 | 中 | 文本解析层做健壮正则匹配 |
| SEGGER 变更 CLI 接口 | 低 | 中 | API 适配器模式，只影响 OzoneBackend 模块 |
| AI 响应速度慢 | 中 | 低 | 流式输出 + 进度提示；本地小模型优先 |
| VS Code WebView 性能瓶颈 | 低 | 中 | 大数据集使用虚拟列表 (react-window) |

---

## 10. 附录

### 10.1 术语表
| 术语 | 说明 |
|---|---|
| Ozone | SEGGER 公司出品的嵌入式调试器 |
| J-Link | SEGGER 的调试探头硬件 |
| SWD | Serial Wire Debug，ARM 调试接口 |
| SVD | System View Description，芯片外设寄存器描述文件 |
| HardFault | ARM Cortex-M 硬件错误异常 |

### 10.2 参考资源
- [SEGGER Ozone 文档](https://www.segger.com/products/debug-probes/j-link/tools/ozone/)
- [VS Code Extension API](https://code.visualstudio.com/api)
- [Ollama](https://ollama.ai/)