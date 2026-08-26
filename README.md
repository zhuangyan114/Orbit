<p align="center">
  <img src="resources/orbit-icon-256.png" width="128" height="128" alt="Orbit icon">
</p>

<h1 align="center">Orbit — The Debugger for What’s Next</h1>

<p align="center">
  面向 STM32 / ARM Cortex-M 的 VS Code 调试前端：直接连接 J-Link 或 CMSIS-DAP/DAPLink，<br>
  把源码调试、运行时变量、波形、RTT 日志和自动化实验放在同一条目标访问链路上。
</p>

<p align="center">
  <a href="Releases/docs/全套工具链教程.md">全套工具链教程</a> ·
  <a href="Releases/docs/user-guide.md">用户文档</a> ·
  <a href="https://github.com/zhuangyan114/Orbit/releases">Orbit Releases</a>
</p>

> 本 README 是 Orbit 正式版 1.1.2 的产品介绍与架构说明。首次使用请先阅读[全套工具链教程](Releases/docs/全套工具链教程.md)；需要查询 Orbit 的完整配置、功能细节和已知限制时，请阅读[用户文档](Releases/docs/user-guide.md)。

## Orbit 是什么

Orbit 是一个运行在 VS Code 中的嵌入式调试前端。它以 Debug Adapter Protocol（DAP）承接 VS Code 的调试请求，通过 J-Link DLL 或原生 CMSIS-DAP helper（真机验收为 v1 HID；v2 WinUSB 有代码/Mock，本版未做真机）访问 STM32 / ARM Cortex-M 目标，并在同一目标所有权模型下提供：

- 源码级启动、暂停、继续、单步、复位和断点；
- 可展开的 Watch 表达式、运行时数值写入和变化高亮；
- Timeline 实时采样、缩放、悬停读数和短期历史保留；
- SEGGER RTT 输出、ANSI 处理和 P-RTLog tokenized 帧解码；
- 通过标准 DAP memory / variables 能力接入外部 Memory View、Peripheral Viewer 和 RTOS Views；
- 面向脚本和 AI 工具的本机 Automation API v1（Node / Python / MCP 共用同一协议）。

Orbit 的目标不是复制一个完整 IDE，而是把“程序停在哪里、变量现在是多少、波形怎样变化、日志从哪里来、实验是否可重复”连接到同一套调试会话中。

## 能力

### 源码调试

Orbit 暴露 `orbit` DAP 调试器类型，使用 ELF/AXF 载入符号、行号和 DWARF 类型信息；旧配置中的 `ozone` 类型仍作为兼容别名保留。标准 DAP 的 `evaluate`、可展开 `variablesReference`、结构体/数组/指针子节点、`memoryReference`、读写内存和 RTOS capability 会保留给 VS Code 及外部视图使用。

`probe: "jlink"`（默认）选择 J-Link；`probe: "cmsis-dap"` 选择 CMSIS-DAP/DAPLink。`cmsisDapTransport: "auto"` 优先 v2 WinUSB 并兼容 v1 HID。

### 运行时查看变量

WATCH 和 TIMELINE 是两个 VS Code Webview 视图。Watch 负责表达式列表、子节点展开、数值编辑和发送到 Timeline；Timeline 负责采样通道、曲线、时间窗口、自动跟随、手动缩放及悬停读数。两者的表达式与视图状态保存在 VS Code workspace state 中。

> CMSIS-DAP-V1 带宽较低,WATCH变量较多,结构体展开较多,或者RTT轮询过快过多时,可能出现TimeLine卡顿的情况

### 日志与实时数据

  RTT 由选定的目标 owner 读取，既可以显示在 `Orbit RTT Log` 终端，也可以显示在 Debug Console。启用 P-RTLog 后，Orbit 从 ELF 的 `.pw_tokenizer.entries` 节加载 token 数据，再把 RTT 二进制帧转换为带级别、模块和位置的文本。

### 外部调试插件

Memory View、Peripheral Viewer、RTOS Views 和 debug tracker 不是 Orbit 内置的独立实现,不过 Orbit 对他们进行了支持。 \
Orbit 通过 DAP memory / variables、`deviceName`、`svdFile` / `svdPath` 以及 `trackDebuggers` 设置为这些外部扩展提供连接面；它们的版本、寄存器树和 RTOS 解析能力由外部扩展决定。

### 自动化与 AI 接入

工作区打开 `orbit.automation.enabled` 后，每个 VS Code 窗口在 `127.0.0.1` 上发布独立的 Automation API v1（`/v1/rpc`、`/v1/events`）。客户端按 `projectId`/`instanceId` 握手，再绑定精确的 `sessionId`/`sessionGeneration`。Node CLI、Python 标准和 MCP 都走同一协议，不会另开第二条目标连接。默认只授 `read`；写入、控制、Flash 需要额外 scope。真实硬件验收与 Mock 分层记录，见 [硬件验收](docs/api/orbit-automation-hardware-acceptance.md)。


## 文档与发布

- [全套工具链教程](Releases/docs/全套工具链教程.md)：面向第一次从 Keil5 等集成 IDE 转到 VS Code 的用户，从零安装和配置 ARM GCC、CMake、CMake Tools、J-Link 与 Orbit，并完成第一次编译和调试。
- [用户文档](Releases/docs/user-guide.md)：面向已经具备基本 VS Code/嵌入式开发环境的用户，作为 Orbit 的正式参考手册，覆盖安装要求、`launch.json`、Watch、Timeline、RTT、P-RTLog、RTOS Views、Memory View、Peripheral Viewer、Native/Legacy、Automation API、MCP、FAQ 和已知限制。
- [Automation API v1](docs/api/orbit-automation-api.md)：本机 JSON-RPC / SSE 协议、握手、generation fence 和客户端快速开始。
- [硬件验收](docs/api/orbit-automation-hardware-acceptance.md)：自动化 / Mock / 真实硬件分层状态。Automation API 1.1.1 已通过 J-Link native 与 CMSIS-DAP HID v1（均无 flash）。1.1.2 另完成 STM32H723VGT6 的 CMSIS-DAP Flash 真机验收（P7-1～P7-5）；H723 的 J-Link 真机与长稳/断线不在本版范围。

两份教程互相补充，并不是重复内容：

| 文档 | 适用对象 | 主要内容 |
| --- | --- | --- |
| [全套工具链教程](Releases/docs/全套工具链教程.md) | 没有完整 VS Code + ARM GCC + CMake 环境，或第一次使用 Orbit 的用户 | 按步骤搭建开发环境，完成工具安装、CMake 配置、编译、J-Link 安装和首次调试 |
| [用户文档](Releases/docs/user-guide.md) | 已能编译工程，需要深入使用 Orbit 的用户 | 查阅 Orbit 的配置项、调试视图、实时数据、日志、MCP、调试通道、常见问题和能力边界 |

推荐阅读顺序：第一次使用 Orbit 时先看[全套工具链教程](Releases/docs/全套工具链教程.md)，完成环境搭建后再把[用户文档](Releases/docs/user-guide.md)作为功能参考手册。

- [Orbit Releases](https://github.com/zhuangyan114/Orbit/releases)：正式版 VSIX 及后续发布资产。

## 1.1.0 更新日志

- 增加了对 DAP-Link-V1 的支持
- 大幅优化了Timeline的采样效率和显示逻辑
- 修复了许多bug,优化了调试体验
- 当时 CMSIS-DAP 链路仅支持 STM32F407VET6

## 1.1.1 更新日志

- 开放调试API，支持python，nodejs调用，AI可直接调用MCP调试

## 1.1.2 更新日志

- CMSIS-DAP 链路新增 STM32H723VGT6（别名 `STM32H723VG`）器件注册与自研 Flash Algorithm

## 预告

- 会尽快支持 CMSIS-DAP-V2
- CMSIS-DAP 链路后续会尽快支持 F103C8T6
- STM32H723 的 J-Link 真机验收放到后续版本

## 许可证

MIT
