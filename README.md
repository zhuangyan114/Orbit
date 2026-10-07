<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=orbit-debug.orbit-for-vscode"><img src="https://raw.githubusercontent.com/zhuangyan114/Orbit/master/resources/orbit-icon-256.png" width="96" height="96" alt="Orbit 图标"></a>
</p>

<h1 align="center">Orbit — The Debugger for What’s Next</h1>

<p align="center">
  在 VS Code 里调试 STM32 / ARM Cortex-M，支持 J-Link 和 DAPLink。<br>
  直接读 MCU 变量画波形，不用写串口发送代码；参数可以在 Watch 里改。<br>
  断点、单步、RTT 日志也在这里，AI 可以通过 MCP 操作调试器。
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=orbit-debug.orbit-for-vscode">插件市场安装</a> ·
  <a href="https://github.com/zhuangyan114/Orbit/releases">离线下载</a> ·
  <a href="https://github.com/zhuangyan114/Orbit/blob/master/README.md#开始使用">快速开始</a> ·
  <a href="https://github.com/zhuangyan114/Orbit/blob/master/Releases/docs/全套工具链教程.md">从零搭环境</a> ·
  <a href="https://github.com/zhuangyan114/Orbit/blob/master/Releases/docs/user-guide.md">用户手册</a> ·
  <a href="https://github.com/zhuangyan114/Orbit/blob/master/Releases/docs/user-guide.md#12-mcp-与-plugin-api">MCP 接入</a> ·
  <a href="https://github.com/zhuangyan114/Orbit/issues">反馈问题</a>
</p>

[![Orbit 功能总览：源码调试、变量读写、TIMELINE 波形、RTT 日志和自动化接口](https://raw.githubusercontent.com/zhuangyan114/Orbit/master/resources/orbit-feature-overview-promo.png)](https://github.com/zhuangyan114/Orbit/blob/master/resources/orbit-feature-overview-promo.png)

## 功能

### TIMELINE 高频波形

- **通过 J-Link / DAPLink 直接采样 MCU 变量**，不需要专门的波形上报代码，也不额外占用串口。
- 支持多变量曲线、时间窗口缩放、游标读数和 CSV 导出。
- A/B 时间游标测量时间差，可保存全部数据或游标区间，再通过 CSV 和多个标签页回看；长期记录持续写盘，查看历史时实时采集继续。
- **J-Link 采样可达 1 kHz，无线 DAPLink 有约 400 Hz 的使用记录。** 实际速率取决于目标、表达式数量和并行负载。

[![Orbit TIMELINE：真实调试界面与多变量波形](https://raw.githubusercontent.com/zhuangyan114/Orbit/master/resources/orbit-timeline-promo.png)](https://github.com/zhuangyan114/Orbit/blob/master/resources/orbit-timeline-promo.png)

采样率指变量读取速率，不是界面刷新率。具体配置和结果见[无线 DAPLink 对照记录](https://github.com/zhuangyan114/Orbit/blob/master/docs/cmsis-dap-v1-v2-timeline-2026-10-02.md)。

### Watch 变量读写

- 查看变量和表达式，展开结构体、数组与指针，数值变化高亮。
- **直接修改可写变量，无需重新编译烧录或实现串口调参命令。**

### 源码调试与固件烧录

- 支持断点、单步、暂停、继续、复位和调用堆栈。
- **自动查找 ELF/AXF**，通常只需在 `launch.json` 中指定芯片型号。
- 启动前可烧录并校验固件；烧录支持取决于芯片与探针链路。

### RTT 彩色日志

- 在 `Orbit RTT Log` 终端显示日志，保留 ANSI 颜色，也可输出到 Debug Console。
- 支持 P-RTLog 二进制日志解码，读取 ELF 中的 token 信息。

[![Orbit RTT 日志：真实终端中的彩色日志输出](https://raw.githubusercontent.com/zhuangyan114/Orbit/master/resources/orbit-rtt-promo.png)](https://github.com/zhuangyan114/Orbit/blob/master/resources/orbit-rtt-promo.png)

日志需要固件接入 RTT；P-RTLog 解码需要匹配的固件和 ELF 信息。接法和配置见[用户手册](https://github.com/zhuangyan114/Orbit/blob/master/Releases/docs/user-guide.md)。

### MCP 与 AI 自动调试

- 提供 Python、Node.js 和 MCP 接口，支持变量读写、波形记录、断点管理和调试控制。
- **AI 可通过 MCP 实际操作调试器，自动执行已配置、已授权的调试流程。**
- 脚本和 AI 复用当前调试连接，不另开连接抢占探针。

自动化默认关闭；开启后默认只授予读取权限。记录、写入、控制和烧录等操作需要对应授权，AI 结论仍需实板验证。配置见 [MCP 接入指南](https://github.com/zhuangyan114/Orbit/blob/master/Releases/docs/user-guide.md#12-mcp-与-plugin-api)和 [Automation API 文档](https://github.com/zhuangyan114/Orbit/blob/master/docs/api/orbit-automation-api.md)。

### 内存与外设视图

兼容 Memory View、Peripheral Viewer，查看内存和外设寄存器；需要另外安装对应扩展。

**Orbit 的差异在于 VS Code 内使用、兼容 J-Link 与 DAPLink，并支持 MCP 自动化。** [Ozone](https://www.segger.com/products/development-tools/ozone-j-link-debugger/technology/tool-overview/) 已有 Watch、变量修改和波形采样，上限更高，但不支持 DAPLink；[VOFA+](https://www.vofa.plus/docs/learning/) 通过串口或网络接收上报数据，Orbit 则通过探针直接读取变量。

## 开始使用

### 准备这些东西

| 你需要 | 说明 |
| --- | --- |
| Windows x64 + VS Code | 当前发布目标是 Windows；VS Code 需要 1.90.0 及以上的 1.x 版本 |
| STM32 / ARM Cortex-M 开发板 | 芯片和探针组合需要在支持范围内，尤其是 CMSIS-DAP 烧录 |
| J-Link 或 CMSIS-DAP / DAPLink | J-Link 需要安装 SEGGER 软件包；CMSIS-DAP v1 使用 HID，v2 使用 WinUSB |
| 带调试信息的 ELF/AXF | Orbit 负责调试，不替你编译固件；先确认工程能编译 |
| GNU Arm 工具链 | 确保 `arm-none-eabi-nm`、`arm-none-eabi-objdump`、`arm-none-eabi-addr2line` 可用，建议加入 `PATH` |

如果你还没有完整的 VS Code + ARM GCC + CMake 环境，先看[全套工具链教程](https://github.com/zhuangyan114/Orbit/blob/master/Releases/docs/全套工具链教程.md)，不用在这里猜该装什么。

### 安装，然后按 F5

1. 在 VS Code 扩展页搜索 **Orbit STM32 Debugger**，选择扩展 ID 为 `orbit-debug.orbit-for-vscode` 的插件安装，也可以直接打开[插件市场页面](https://marketplace.visualstudio.com/items?itemName=orbit-debug.orbit-for-vscode)。需要离线安装时，从 [Releases](https://github.com/zhuangyan114/Orbit/releases) 下载 VSIX，再执行 `Extensions: Install from VSIX...`。安装后重新加载窗口。
2. 打开固件工程文件夹，编译得到 ELF/AXF，连接开发板和探针。
3. 新建 `.vscode/launch.json`。下面用 STM32F407IG 举例，**把芯片型号改成你自己的即可，ELF/AXF 文件会自动查找**：

```jsonc
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Orbit Debug",
      "type": "orbit",
      "request": "launch",
      "device": "STM32F407IG"
    }
  ]
}
```

4. 选择 `Orbit Debug`，按 **F5**。连上后，先打一个断点、读一个变量，再打开 TIMELINE 试一条曲线。

**默认启动前会烧录固件。** 只想调试板子里现有的程序时，加上 `"flashBeforeDebug": false`，并确保 ELF 与板上固件一致。

通常不需要填写 `program`：Orbit 会依次在 `build/Debug`、`build/Release`、`build` 中自动查找 ELF/AXF。工程里有多个固件，或输出到其他目录时，也可以用 `program` 手动指定。

默认优先选择 J-Link；两种探针都插着、但你想用 DAPLink 时，加上 `"probe": "cmsis-dap"`。CMSIS-DAP 默认优先 v2 WinUSB，也兼容 v1 HID。更多配置见[用户手册](https://github.com/zhuangyan114/Orbit/blob/master/Releases/docs/user-guide.md)。

## 限制

Orbit 主要由个人维护，板子、探针和测试时间都有限。能在一块板上跑通，不等于所有芯片都已经适配。

- **当前发布只面向 Windows x64。** macOS / Linux 暂未提供支持。
- **CMSIS-DAP 的芯片支持不是填个型号就有。** 连接、调试和烧录也不是一回事；烧录还需要匹配的 Flash 算法和容量校验。
  1.1.6 已加入 `STM32F103C8T6` / `STM32F103C8` 的 64 KiB Flash、20 KiB SRAM 和半字编程算法；完整实板验收尚未完成。配置与各型号验收范围见[用户手册](https://github.com/zhuangyan114/Orbit/blob/master/Releases/docs/user-guide.md)。
- **表达式不是越复杂越好。** 类型和地址解析依赖 ELF/DWARF；局部变量可能只在暂停且对应栈帧有效时能访问。高频采样优先从简单、可解析的变量开始。
- **采样和日志要共享带宽。** 大量 Watch 展开、复杂表达式或高日志负载可能拖慢波形；高速采样期间，RTT 文本轮询可能暂停，结束后恢复。
- **RTOS 视图目前有已知问题，暂不建议使用。** 不建议依赖它完成任务分析。

碰到问题可以提 [Issue](https://github.com/zhuangyan114/Orbit/issues)。附上芯片完整型号、探针和传输方式、Orbit 版本、`launch.json`、复现步骤及相关日志，比一句“连不上”更容易定位。发之前记得删掉敏感路径和身份信息。

## 欢迎加入

Orbit 还有不少要打磨的地方。我手里的开发板十分有限，所以CMSIS-DAP链路目前支持芯片较少。

如果你想适配新的 CMSIS-DAP 芯片，从[新芯片适配指南](https://github.com/zhuangyan114/Orbit/blob/master/.agent/skills/cmsis-dap-add-target/SKILL.md)开始。


## 文档和开发

| 想做什么 | 去哪里看 |
| --- | --- |
| 从 Keil 等环境转到 VS Code | [全套工具链教程](https://github.com/zhuangyan114/Orbit/blob/master/Releases/docs/全套工具链教程.md) |
| 查 Watch、TIMELINE、RTT 和配置 | [用户手册](https://github.com/zhuangyan114/Orbit/blob/master/Releases/docs/user-guide.md) |
| 接 Python / Node.js / MCP | [Automation API](https://github.com/zhuangyan114/Orbit/blob/master/docs/api/orbit-automation-api.md) |
| 看实现结构 | [架构说明](https://github.com/zhuangyan114/Orbit/blob/master/docs/architecture.md) |
| 看测试到了哪一步 | [自动化与硬件验收](https://github.com/zhuangyan114/Orbit/blob/master/docs/api/orbit-automation-hardware-acceptance.md) |
| 看各版本更新 | [更新日志](https://github.com/zhuangyan114/Orbit/blob/master/CHANGELOG.md) |
| 查已确认的修复 | [修复记录](https://github.com/zhuangyan114/Orbit/blob/master/docs/bug-fix-log.md) |

<details>
<summary>从源码构建</summary>

除 Node.js / npm 外，Native helper 构建还需要 CMake 3.20+ 和 Windows C++ 编译环境（Visual Studio C++ 工具或 x64 MinGW-w64）。

```powershell
npm install
npm run build
npm run build:native
npm run typecheck
npm test
```

启动扩展开发窗口可执行 `npm run dev`。源码在 `src/` 和 `native/`，不要直接修改生成的 `dist/` 文件。自动化测试通过不等于实板验收通过。

</details>

## 许可证

[MIT](https://github.com/zhuangyan114/Orbit/blob/master/LICENSE)。SEGGER 软件包等外部依赖仍遵循各自的许可。
