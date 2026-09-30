# Orbit vs EmberProbe 选型对比

> 基于对两个项目源码的逐项核查(2026-09):Orbit v1.1.2 / EmberProbe v0.7.13。
> 两者都是面向 STM32 / ARM Cortex-M 的 VS Code 调试扩展,但技术路线完全不同。

## 一句话定位

- **Orbit** —— 自研全链路调试器:从 VS Code 调试协议到探针通信全部自己实现,主攻实时数据(波形 + RTT 日志)和 AI 自动化接口。**仅支持 Windows**。
- **EmberProbe** —— 站在 OpenOCD + GDB 生态上的全能工具箱:芯片信息、烧录、波形、外设寄存器、故障分析开箱即用,**覆盖面广**。

## 30 秒选型

| 你的情况 | 建议 |
| --- | --- |
| Windows + J-Link / CMSIS-DAP,需要 RTT 日志和实时波形 | **Orbit** |
| 用 Linux/macOS,或手头是 ST-Link 等其他探针 | **EmberProbe** |
| 芯片不在 Orbit 的 CMSIS-DAP 白名单里又要用 CMSIS-DAP 烧录 | **EmberProbe** |
| 需要条件断点、函数断点 | **EmberProbe** |
| 想让 AI / 脚本(Python、Node、MCP)直接控制调试 | **Orbit** |
| 想读芯片 UID、识别兼容片、一键解码 HardFault | **EmberProbe** |

## 功能对照

| 能力 | Orbit 1.1.2 | EmberProbe 0.7.13 |
| --- | --- | --- |
| 操作系统 | 仅 Windows | Windows / Linux / macOS(后两者需自装 OpenOCD) |
| 探针 | J-Link、CMSIS-DAP/DAPLink | OpenOCD 生态(J-Link、CMSIS-DAP、ST-Link 等) |
| 芯片 | J-Link 链路很广(SEGGER DLL);CMSIS-DAP 烧录目前白名单:F407VET6、H723VGT6 | OpenOCD 认识的芯片基本都可用 |
| 需另装的工具 | 无(符号解析需 arm-none-eabi 工具链) | 无(自带 OpenOCD;断点调试需 ARM GDB 工具链) |
| 断点调试 | 自研:断点、单步、源码级步进 | GDB:同左,另支持**条件断点、函数断点、sourceFileMap** |
| 实时波形 | ✅ 高频采样,内置优先级调度,与调试操作互不拖慢 | ✅ 多面板、冻结快照、滑条/滚轮写入、CSV 导出 |
| 波形采样率上限 | 名义最高 ≈10 kHz(0.1 ms 间隔);实际约 0.7–1 kHz(J-Link 原生) / ≈0.27 kHz(DAPLink V1) | 硬上限 50 Hz(默认 10 Hz);调试会话运行时最高 10 Hz |
| 实时变量写入 | ✅(Watch 视图) | ✅(滑条/输入框/滚轮,写后自动回读校验) |
| RTT 串口日志 | ✅ 完整支持,含 P-RTLog tokenized 解码 | ❌ 不支持 |
| RTOS 感知 | ✅(对接 RTOS Views 扩展) | ❌ |
| 外设寄存器视图 | 借助外部扩展(Memory View / Peripheral Viewer) | ✅ 内置(SVD 解析、位域树、行内写入) |
| 故障分析(HardFault) | 原始寄存器快照 | ✅ 解码 CFSR/HFSR 并符号化 PC/LR |
| 芯片信息读取 | 仅烧录前器件 ID 预检 | ✅ UID / Device ID / Flash 容量 / 兼容片识别 |
| AI / 自动化 | ✅ 本机 HTTP API + Node / Python / MCP 客户端,默认只读授权 | ✅ 9 个内置 Agent Skills(含烧录、故障分析、CubeMX 代码重生成) |
| 烧录 | ✅ 可在调试会话内烧录(同一连接) | ✅ launch 默认烧录并运行至 main |

> **采样率数字依据**:Orbit 的采样间隔在源码中钳制为 0.1–10000 ms(默认 0.2 ms,即目标 5 kHz);仓库自带硬件对照实测 J-Link 原生约 680–715 Hz/表达式(3–6 条 Watch、SWD 4 MHz),少量 Watch 的实际使用场景约可达 1 kHz,DAPLink V1 约 257–270 Hz。EmberProbe 的采样时钟在源码中三处钳制为最小 20 ms(调试模式下 100 ms),且每个定时周期只读取一批变量、周期重叠时直接跳过,没有追赶循环,因此 50 Hz 是结构性硬上限。

## 选 Orbit 的理由

- 调试链路没有 GDB/OpenOCD 黑盒,单步、断点、报错行为完全可预期。
- RTT 日志开箱即用(终端 + ANSI 颜色 + P-RTLog 解码)——嵌入式日常调试刚需,EmberProbe 明确不做。
- 波形采样、变量读取、调试操作之间有优先级调度,互不抢占目标连接。
- AI 接入是真正的本机 API:Python / Node 脚本和 MCP 服务器都能连,默认只读、按范围授权,适合做自动化实验。
- 代码全 TypeScript、测试密度高(测试约占源码 40%),迭代快。

## 选 EmberProbe 的理由

- 跨 Windows / Linux / macOS。
- 探针和芯片兼容面宽,依托 OpenOCD 生态,不挑硬件。
- "工具箱"功能开箱即用:芯片信息 / UID / 兼容片识别、HardFault 解码、SVD 外设寄存器视图。
- 条件断点、函数断点(Orbit 目前不支持)。
- 工程化成熟:三平台 CI、真实硬件测试流水线、覆盖率门槛,版本迭代已 70+ 次。

## 注意事项

- **Orbit**:仅 Windows;CMSIS-DAP v2(WinUSB)尚未真机验收;DAPLink v1 带宽低时波形可能卡顿;CMSIS-DAP 烧录按器件白名单逐颗适配。
- **EmberProbe**:不支持 RTT、RTOS、反汇编视图;Windows 下用 J-Link 需把 SEGGER 驱动切成 WinUSB(需管理员授权,期间 J-Flash 等 SEGGER 工具不可用,可切回)。
- 两者都需要 ARM GCC 工具链在 PATH 中(Orbit 用于解析 ELF/DWARF 符号;EmberProbe 断点调试还需要其中的 GDB)。

## 结论

**深度 vs 广度**:Orbit 把调试链路的每一层握在自己手里,换来 RTT、波形调度和自动化 API 这些"深水区"能力,代价是平台和芯片覆盖窄、部分功能仍在补齐;EmberProbe 借 OpenOCD/GDB 生态换来宽覆盖和开箱即用的工具箱,代价是底层行为不可控、缺少 RTT 等实时能力。按自己手头的硬件和最常用的调试场景选即可。
