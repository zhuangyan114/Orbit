# Orbit — 用户使用与配置指南

> 版本：1.1.2 文档
>
> 本文按当前仓库源码、`package.json` 的贡献点和 Native helper 实现整理。配置名、默认值、范围和单位均以源码为准；外部扩展的具体版本和 UI 由外部扩展决定。

## 目录

- [1. 安装和系统要求](#1-安装和系统要求)
- [2. 调试探针与烧录](#2-调试探针与烧录)
- [3. launch.json](#3-launchjson)
- [4. Watch](#4-watch)
- [5. Timeline](#5-timeline)
- [6. RTT](#6-rtt)
- [7. P-RTLog](#7-p-rtlog)
- [8. RTOS Views](#8-rtos-views)
- [9. Memory View](#9-memory-view)
- [10. Peripheral Viewer](#10-peripheral-viewer)
- [11. Target owner 与调试通道](#11-target-owner-与调试通道)
- [12. MCP 与 Plugin API](#12-mcp-与-plugin-api)
- [13. 常见问题](#13-常见问题)
- [14. 已知限制](#14-已知限制)

## 1. 安装和系统要求

### 1.1 使用发行版安装

正式发布资产放在 [GitHub Releases](https://github.com/zhuangyan114/Orbit/releases)。安装 VSIX 的标准流程是：

1. 下载对应版本的 `.vsix`。
2. 在 VS Code 中打开命令面板，执行 `Extensions: Install from VSIX...`。
3. 选择 VSIX，安装完成后重新加载窗口。
4. 打开包含 ELF/AXF 固件的工作区，再使用 `type: "orbit"` 的调试配置；旧配置中的 `type: "ozone"` 仍可用。

当前仓库的发布计划还会把 MCP server 和 SKILL 作为 Releases 资产提供；它们不是 VSIX 内的 DAP 协议替代品，详见 [MCP 与 Plugin API](#12-mcp-与-plugin-api)。

### 1.2 运行时要求

| 项目 | 源码依据和要求 |
| --- | --- |
| 操作系统 | Native helper 的 CMake 配置明确要求 Windows；Native 发布目标为 `win32-x64`。当前产品应按 Windows 环境准备。 |
| VS Code | `package.json` 声明 `engines.vscode: ^1.90.0`，即 VS Code 1.90.0 以上且仍在 1.x 主版本范围内。 |
| 目标 | 产品定位为 STM32 / ARM Cortex-M；J-Link 需要 DLL 可识别的 device，CMSIS-DAP 烧录需要匹配目标的 Flash Algorithm。 |
| 调试器 | 支持 SEGGER J-Link，以及标准 CMSIS-DAP/DAPLink probe（1.1.0 真机为 v1 HID；v2 WinUSB 有代码/Mock）。J-Link 需要软件包和 `JLink_x64.dll`；CMSIS-DAP 使用 VSIX 内的独立 helper。 |
| 固件文件 | `program` 使用 ELF/AXF。符号、源码行和 DWARF 类型质量取决于文件是否包含相应调试信息。 |
| 外部视图 | RTOS Views、Memory View、Peripheral Viewer 和 debug tracker 由外部扩展提供，Orbit 不在 `extensionDependencies` 中自动安装它们。 |
| 源码构建 | 仅在从源码构建 Native helper 时需要 CMake 3.20+，以及 Visual Studio C++ 工具或 x64 MinGW-w64。 |
| MCP | 从源码运行 `Releases/mcp/orbit-mcp-server.js` 时需要可执行的 `node`；仓库未声明独立的 Node.js 最低版本。 |

### 1.3 符号工具链

源码会调用以下 GNU Arm 工具读取 ELF 符号和 DWARF：

- `arm-none-eabi-nm.exe`；
- `arm-none-eabi-objdump.exe`；
- `arm-none-eabi-addr2line.exe`。

工具会优先从 `PATH` 查找，也会检查源码中列出的 Windows GNU Arm 工具链目录。找不到工具时，连接可能仍可建立，但断点、源码行、表达式类型或 Native source-level step 的能力会受影响。

### 1.4 从源码构建（开发者选项）

仓库已经提供 Native helper 的构建脚本；常用命令为：

```powershell
npm install
npm run build
npm run build:native
npm run typecheck
```

`npm run build:native` 会寻找 CMake 3.20+，优先使用 Visual Studio 生成器，否则要求 x64 MinGW-w64；产物目标目录是 `out/native/win32-x64/`。发布版用户通常直接安装 Releases 中的 VSIX，不需要在目标机上安装 CMake。

## 2. 调试探针与烧录

### 2.1 DLL 的作用

F5/Run and Debug 的 `orbit` DAP 路径按 `probe` 选择 J-Link 或 CMSIS-DAP；旧的 `ozone` DAP 类型仍路由到同一实现。两种路径都不需要 OpenOCD、GDB server 或 Ozone GUI 承接常规 DAP 控制。

扩展设置 `orbit.jlinkDllPath` 为空时，源码按以下顺序尝试定位 `JLink_x64.dll`：

1. `orbit.jlinkDllPath` 指定的、且确实存在的文件；
2. `C:\Program Files\SEGGER\JLink_V*\JLink_x64.dll` 中按版本目录倒序找到的文件；
3. `C:\Program Files\SEGGER\Ozone\JLink_x64.dll`；
4. 名为 `JLink_x64.dll` 的系统搜索路径候选。

Native helper 加载 DLL 后要求基础调试、寄存器、内存、断点、复位和连接相关的 J-Link 导出符号；RTT 还需要 DLL 提供 `JLINK_RTTERMINAL_Control` 和 `JLINK_RTTERMINAL_Read`。缺少 RTT 导出时，调试本身不等于 RTT 可用。

诊断 DLL 路径、版本、打开、连接和 owner 选择时，优先查看 `outputs/Log/dll.log`。

### 2.2 `JLink.exe` 只用于可选烧录

`orbit.jlinkPath` 的默认值是：

```text
C:\Program Files\SEGGER\JLink\JLink.exe
```

它由烧录流程调用。launch 中有 `program` 且 `flashBeforeDebug` 没有设为 `false` 时，Orbit 会调用 JLink Commander，参数包含目标设备、`SWD`/`JTAG` 接口、速度和临时 CommanderScript；烧录默认超时为 30 秒。

没有 `program`，或显式设置 `flashBeforeDebug: false` 时，不会因为 DAP 连接本身而调用 `JLink.exe`。同一会话 Restart 时，若 `flashBeforeDebug: true` 且 ELF 与刚刚烧录的固件相同，也不会再次调用 Commander。J-Link DLL 仍然是调试连接的必需品。

### 2.3 CMSIS-DAP / DAPLink

`probe: "cmsis-dap"` 启动 `orbit-cmsis-dap-helper.exe`。`cmsisDapTransport: "auto"` 优先选择 CMSIS-DAP v2 WinUSB，找不到匹配接口时兼容 v1 HID；可用 serial、VID/PID 或 device path 缩小设备选择范围。1.1.0 真机验收覆盖 HID v1；v2 WinUSB 以设备枚举和握手为准，本版未做真机。

CMSIS-DAP 的 `flashBeforeDebug: true` 通过当前 helper owner 运行匹配目标的 Flash Algorithm，并完成 erase/program/verify；它不会调用 `JLink.exe`。Launch 总会烧录；同一会话 Restart 时若 ELF 与刚刚烧录的固件相同则跳过再烧，不同则重新烧录。`flashBeforeDebug: false` 完全跳过烧录（包括 Restart），仍使用 `program` 加载 ELF/DWARF。CMSIS-DAP 不会在失败时回退到 J-Link owner。

当前 CMSIS-DAP 内置 Flash 目标：

| `device` / 别名 | Flash | 真机验收 |
| --- | --- | --- |
| `STM32F407VET6` / `STM32F407VE` | 512 KiB，自研 F4 算法 | CMSIS-DAP HID v1 已验收 |
| `STM32H723VGT6` / `STM32H723VG` | 1 MiB，自研 H7 算法 | CMSIS-DAP HID v1 已验收（P7-1～P7-5，2026-08-25）；J-Link 已验收（P7-6，2026-09-11）。长稳/断线（P7-7）未验收 |

未注册的器件名会在擦除前返回 `TargetMismatch`，不会回退到 F407 算法。H723 的其他封装/容量（例如 512 KiB E 密度）以及 H725/H73x 不在本版注册表中。默认 `device` 仍是 `STM32F407VG`；调试 H723 必须显式写成 `STM32H723VGT6` 或 `STM32H723VG`。

这张注册表只作用于 CMSIS-DAP 烧录；J-Link 链路不查注册表，`device` 会原样交给 J-Link DLL 和 `JLink.exe`，所以必须填已安装 J-Link 软件认识的器件名。实测 J-Link V9.56 的器件库没有 `STM32H723VGT6`：Commander 会提示器件名未知并降级到 `STM32H723VG`，自动烧录时还会弹出器件选择框、把流程卡到超时。`probe: "jlink"` 请写 `"device": "STM32H723VG"`。

## 3. `launch.json`

### 3.1 最小配置

下面的配置使用 J-Link 默认 owner：

```jsonc
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Orbit: Debug STM32",
      "type": "orbit",
      "request": "launch",
      "probe": "jlink",
      "program": "${workspaceFolder}/build/Debug/frame.elf",
      "device": "STM32F407IG",
      "interface": "SWD",
      "speedKHz": 4000,
      "nativeDebugEngineMode": "auto"
    }
  ]
}
```

有线 CMSIS-DAP/DAPLink 的最小差异配置为：

```jsonc
{
  "type": "orbit",
  "request": "launch",
  "probe": "cmsis-dap",
  "cmsisDapTransport": "auto",
  "program": "${workspaceFolder}/build/Debug/frame.elf",
  "device": "STM32F407VG",
  "interface": "SWD",
  "speedKHz": 4000,
  "flashBeforeDebug": true
}
```

STM32H723VGT6 必须显式写器件名；默认值不会变成 H723。CMSIS-DAP 走内置注册表，两个名称都可用：

```jsonc
{
  "type": "orbit",
  "request": "launch",
  "probe": "cmsis-dap",
  "cmsisDapTransport": "auto",
  "program": "${workspaceFolder}/build/Debug/frame.elf",
  "device": "STM32H723VGT6",
  "deviceName": "STM32H723VGT6",
  "svdFile": "${workspaceFolder}/STM32H723.svd",
  "interface": "SWD",
  "speedKHz": 4000,
  "flashBeforeDebug": true
}
```

同一块板改用 J-Link 时，`device` 要写成 J-Link 器件库里的名称（`deviceName` 只在 `device` 缺省时才会生效）：

```jsonc
{
  "type": "orbit",
  "request": "launch",
  "probe": "jlink",
  "program": "${workspaceFolder}/build/Debug/frame.elf",
  "device": "STM32H723VG",
  "svdFile": "${workspaceFolder}/STM32H723.svd",
  "interface": "SWD",
  "speedKHz": 4000,
  "flashBeforeDebug": true
}
```

### 3.2 默认值和 launch 属性

以下是 `package.json` 的 launch schema 以及 DAP 源码实际读取的值：

| 属性 | 类型 / 单位 | 默认值 | 作用 |
| --- | --- | --- | --- |
| `device` | string | `STM32F407VG` | 实际使用的目标设备名；J-Link 原样交给 DLL 与 `JLink.exe` 选型（必须是已安装 J-Link 软件认识的名称，例如 `STM32H723VG`），CMSIS-DAP 用于 Flash Algorithm 和芯片校验（走内置注册表）。 |
| `deviceName` | string | `STM32F407VG` | 兼容别名；仅在 `device` 缺省时顶替 `device`，同时供外部 MCU Debug Views 使用。 |
| `probe` | `jlink` / `cmsis-dap` | `jlink` | 当前 session 的唯一物理 owner 类型。 |
| `cmsisDapTransport` | `auto` / `cmsis-dap-v2` / `winusb` / `cmsis-dap` / `hid` | `auto` | CMSIS-DAP transport；`auto` 优先 WinUSB v2 并兼容 HID v1。 |
| `cmsisDapSerial` | string | `""` | 可选 probe serial 筛选。 |
| `cmsisDapVid` / `cmsisDapPid` | string | `""` | 可选 USB VID/PID 筛选。 |
| `cmsisDapPath` | string | `""` | 可选设备 interface path 精确筛选。 |
| `cmsisDapFlashAlgorithmPath` | path | `""` | 可选、来源和许可已确认的 Flash Algorithm binary/manifest。 |
| `program` | path | `${workspaceFolder}/build/Debug/frame.elf` | ELF/AXF 路径；用于可选烧录、符号和 DWARF。 |
| `svdFile` | path | `""` | 提供给外部 Peripheral Viewer 的 CMSIS-SVD 路径。 |
 | `svdPath` | path | `""` | `svdFile` 的兼容别名；未填写时跟随 `svdFile` 或 `orbit.defaultSvdFile`。 |
| `interface` | `SWD` / `JTAG` | `SWD` | 调试接口。当前 CMSIS-DAP 路径使用 SWD；J-Link Legacy 固定选择 SWD，见限制。 |
| `speedKHz` | number，kHz | `4000` | SWD/JTAG 目标速度。 |
| `flashBeforeDebug` | boolean | `true` | 使用当前选定 owner 烧录并校验。Launch 总会烧录；同一会话 Restart 时若 ELF 与刚刚烧录的固件相同则跳过再烧，不同则重新烧录。`false` 明确跳过所有 Flash 操作，包括 Restart。 |
| `runToEntryPoint` | string / `false` | `main` | CMSIS-DAP 启动或 Restart 后停靠的符号；`false` 禁用 run-to-entry。 |
| `rtos` | string | `""` | 传给 DAP capability/外部 RTOS Views 的 RTOS 名称，例如 `FreeRTOS`。 |
| `rttLogEnabled` | boolean | `true` | 启动后读取 SEGGER RTT。 |
| `rttBufferIndex` | number，up-buffer index | `0`，限制为 `0..15` | RTT 上行缓冲区索引。 |
| `rttPollIntervalMs` | number，ms | `50`，限制为 `10..5000` | RTT 轮询周期。 |
| `rttReadSize` | number，bytes/poll | `4096`，限制为 `64..65536` | 每次 RTT 读取的最大字节数。 |
| `rttControlBlockAddress` | number 或 string，地址 | `""` | RTT control block 地址；J-Link 可自动检测，CMSIS-DAP 可从 ELF 符号定位或使用显式地址；正数可写成十进制或 `0x`。 |
| `rttStripAnsi` | boolean | `true` | 写入 Debug Console 前去除 ANSI 控制序列；RTT terminal 始终保留 ANSI。 |
| `rttLogTarget` | `terminal` / `debugConsole` / `both` | `terminal` | RTT 文本显示位置。 |
| `pRtLogEnabled` | boolean | `false` | 将 RTT 字节按 P-RTLog tokenized 帧解码，而不是按普通文本处理。 |
| `pRtLogRoot` | path | `""` | P-RTLog root 配置值；当前 decoder 不从该目录加载 token 数据，见 P-RTLog 限制。 |
| `nativeDebugEngineEnabled` | boolean | `true` | `auto` 模式下是否优先 Native helper。 |
| `nativeDebugEngineMode` | `legacy` / `native` / `auto` | `auto` | 选择 Legacy、强制 Native，或 Native 启动失败时允许回退 Legacy。 |

### 3.3 ELF 自动查找与源码兼容别名

如果 `program` 和 `orbit.defaultProgram` 都为空，配置提供器按以下顺序检查工作区：

1. `build/Debug`；
2. `build/Release`；
3. `build`。

每个目录中按文件系统返回顺序取第一个 `.elf` 或 `.axf`。找不到时使用 `${workspaceFolder}/build/Debug/frame.elf` 作为未解析的默认路径。

DAP 源码还接受下列兼容输入：

| 输入 | 默认值 | 当前行为 |
| --- | --- | --- |
| `elfPath` | `""` | `program` 为空时作为 ELF 路径别名。 |
| `defaultRtos` | `""` | `rtos` 为空时作为 RTOS 名称别名。 |
| `flashBeforeDebug` | `true` | 使用当前 owner 烧录；J-Link 调用 Commander，CMSIS-DAP 运行 Flash Algorithm。设为 `false` 时不执行擦除、编程或校验。 |

### 3.4 `orbit.*` 工作区设置

这些设置可以在 VS Code Settings JSON 中使用；正式前缀为 `orbit.*`，旧版 `ozone.*` 会在激活时迁移。

| 设置 | 类型 / 范围 | 默认值 | 作用 |
| --- | --- | --- | --- |
| `orbit.jlinkPath` | path | `C:\Program Files\SEGGER\JLink\JLink.exe` | 烧录流程使用的 J-Link Commander 可执行文件。 |
| `orbit.jlinkDllPath` | path | `""` | `JLink_x64.dll` 路径；空值自动查找。 |
| `orbit.defaultDevice` | string | `STM32F407VG` | 默认目标设备名。 |
| `orbit.defaultInterface` | `SWD` / `JTAG` | `SWD` | 默认调试接口。 |
| `orbit.defaultSpeed` | number，kHz | `4000` | 默认接口速度。 |
| `orbit.defaultProgram` | path | `""` | 默认 ELF/AXF；空值时自动扫描 `build/Debug`、`build/Release`、`build`。 |
| `orbit.defaultSvdFile` | path | `""` | 外部 Peripheral Viewer 使用的默认 CMSIS-SVD。 |
| `orbit.defaultRtos` | string | `""` | 默认 RTOS 名称，例如 `FreeRTOS`。 |
| `orbit.rtosViewsAutoRefresh` | boolean | `false` | 首次 stack trace 后自动 focus/refresh 外部 RTOS Views；关闭可减少调试会话额外开销。 |
| `orbit.rttLogEnabled` | boolean | `true` | 是否读取 RTT。 |
| `orbit.logging.enabled` | boolean | `true` | 是否启用 Orbit 内部诊断日志。 |
| `orbit.logging.clearOnStart` | boolean | `true` | 启动时是否清空 Orbit 内部诊断日志。 |
| `orbit.rttBufferIndex` | number，`0..15` | `0` | RTT up-buffer 索引。 |
| `orbit.rttPollIntervalMs` | number，`10..5000` ms | `50` | RTT 轮询周期。 |
| `orbit.rttReadSize` | number，`64..65536` bytes | `4096` | 每轮 RTT 最大读取量。 |
| `orbit.rttControlBlockAddress` | string | `""` | RTT control block 地址；空值自动检测。 |
| `orbit.rttStripAnsi` | boolean | `true` | 仅 Debug Console 输出去除 ANSI。 |
| `orbit.rttLogTarget` | `terminal` / `debugConsole` / `both` | `terminal` | RTT 输出位置。 |
| `orbit.pRtLogEnabled` | boolean | `false` | 启用 P-RTLog 解码。 |
| `orbit.pRtLogRoot` | path | `""` | P-RTLog root 配置值。 |
| `orbit.nativeDebugEngine.enabled` | boolean | `true` | Native 总开关；关闭时 `auto` 使用 Legacy。 |
| `orbit.nativeDebugEngine.mode` | `legacy` / `native` / `auto` | `auto` | 目标 owner 选择策略。 |
| `orbit.watchPollIntervalMs` | number，`100..10000` ms | `500` | Watch Webview 可见时的扩展侧刷新计时基准；活动 DAP 会话还会执行目标状态和读取调度。 |
| `orbit.timelineSampleIntervalMs` | number，`0.1..10000` ms | `0.2` | Timeline 目标采样间隔；`0.2 ms` 是 5 kHz 的目标值，实际速率取决于目标读取延迟和表达式数量。 |
| `orbit.timelineSendIntervalMs` | number，`1..10000` ms | `16` | Timeline Webview 更新间隔；采样可以快于 UI 更新。 |
| `orbit.flashBeforeDebug` | boolean | `true` | 启动调试前是否烧录当前 ELF/AXF。 |
| `orbit.recentSessions` | number，`0..50` | `10` | 保留的最近调试会话数量。 |
旧版本的 `ozone.*` 设置会在 Orbit 激活时自动迁移到对应的 `orbit.*` 设置；launch 中显式提供的字段仍然优先于设置值。

## 4. Watch

### 4.1 能力

- 在 `WATCH` Webview 中添加和删除调试表达式。
- 展开结构体、数组、指针等返回的子节点。
- 读取 `display`、类型、地址和错误状态；目标运行时可显示 `Running...` 或使用短期缓存。
- 叶子数值可编辑。输入支持十进制、科学计数法和完整的十六进制 `0x...` 数字；复合节点不能直接写入。
- 写入通过活动 Orbit DAP session 的 `setWatchValue` 完成；写入后会清理对应运行时缓存并重新读取。
- 叶子表达式可以发送到 Timeline；值变化会短暂高亮，源码中的高亮窗口是 500 ms。

### 4.2 状态保存和路由

Watch 表达式保存为 workspace state 的 `ozoneWatchExpressions`，展开节点保存为 `ozoneWatchExpandedExpressions`。切换视图或重新创建 Webview 后，表达式和展开状态会恢复。

如果存在活动的 `orbit` DAP session（或旧 `ozone` 别名），Watch 读取和写入都通过该 session 路由；不会为同一目标再打开一个 Extension Host owner。没有活动 DAP session 时，扩展侧 Watch provider 才会使用其后端路径。

### 4.3 刷新和并发

Watch Webview 不可见时，扩展侧轮询不会读取目标。活动 DAP session 会把目标读取切成有限大小的批次，并为控制操作让出优先级；继续、暂停、单步、断点和变量写入不会被 Timeline 低优先级采样绕过。

## 5. Timeline

### 5.1 添加采样通道

Timeline 通道可以直接在 Timeline 中添加，也可以在 Watch 行的操作中发送到 Timeline。每个表达式有独立颜色、启用状态和 Y 轴配置。

### 5.2 显示和交互

- 默认自动跟随最新采样；关闭自动跟随后可以拖动时间轴查看历史。
- 横轴单位是毫秒；默认每格 100 ms，共 8 个横向 division。
- 可放大、缩小、输入每格时间和每个通道的 Y 轴 `/div`。
- Y 轴默认自动缩放；手动设置 `/div` 后进入手动缩放，双击可回到自动缩放。
- 鼠标悬停显示各通道在光标时间附近的值；数据点之间使用相邻点插值显示提示值。
- Clear 会清除当前采样数据，但不会自动删除表达式列表。

Timeline 状态保存为 `ozoneTimelineState`，包括自动跟随、时间每格、通道启用状态、颜色和 Y 轴设置。历史数据按源码保留约 10 分钟，并保留一个窗口前置点连接曲线边界；内部会使用 30 秒滞后避免频繁裁剪。

### 5.3 采样语义

- 目标停止时不生成新的 Timeline 采样点；恢复运行后从新的实时读取继续，不回填停止期间的时间槽。
- 活动 DAP session 使用 J-Link Native/Legacy 或 CMSIS-DAP 选定 owner 的快速采样路径；控制和 Watch 读取优先于 Timeline。
- 不是每个表达式都能进入快速采样计划。无法解析为当前快速采样格式的表达式会被计划拒绝，不应把它当作“曲线为零”。
- `orbit.timelineSampleIntervalMs` 是目标采样目标，不是硬件保证的实际采样频率。
- `orbit.timelineSendIntervalMs` 只控制发送到 Webview 的节奏，不等于目标采样间隔。

## 6. RTT

### 6.1 启动和输出

`rttLogEnabled` 默认为 `true`。DAP launch 在目标连接并初次 halt 后开始 RTT 轮询，断开或会话结束时停止。读取始终使用当前 session 选定的 owner：J-Link 调用 DLL RTT API，CMSIS-DAP 通过目标内存读取 RTT control block 和 ring buffer。

输出目标由 `rttLogTarget` 选择：

- `terminal`：显示在 VS Code 的 `Orbit RTT Log` 终端；
- `debugConsole`：写入 VS Code Debug Console；
- `both`：同时写入两处。

Debug Console 输出默认移除 ANSI 控制序列；RTT terminal 始终保留 ANSI。RTT 中的 `ESC[2J` 会触发 Debug Console 清屏事件，并输出一个带时间的清屏标记。

### 6.2 RTT 配置

| 配置 | 默认值 | 范围 / 单位 |
| --- | --- | --- |
| `rttBufferIndex` | `0` | `0..15`，RTT up-buffer index |
| `rttPollIntervalMs` | `50` | `10..5000 ms` |
| `rttReadSize` | `4096` | `64..65536 bytes` / poll |
| `rttControlBlockAddress` | 空 | 正的 32-bit 地址；J-Link 可自动检测，CMSIS-DAP 可从 ELF 符号定位或使用显式地址 |
| `rttStripAnsi` | `true` | 只影响 Debug Console |
| `rttLogTarget` | `terminal` | `terminal`、`debugConsole` 或 `both` |

RTT 需要目标固件已经初始化 SEGGER RTT control block。J-Link 还要求 DLL 导出 RTT control/read 函数；CMSIS-DAP 要求 control block 地址/符号和目标内存可读写。RTT 不会替目标固件自动插入初始化代码。

## 7. P-RTLog

### 7.1 工作方式

P-RTLog 是 RTT 之上的 tokenized 二进制帧格式。启用 `pRtLogEnabled: true` 后：

1. Orbit 从当前 `program` ELF 中寻找 `.pw_tokenizer.entries` section；
2. 从 section 读取 token、格式字符串和域信息；
3. 把 RTT 数据按 `[2-byte little-endian length][frame payload]` 拆帧；
4. 将 payload 前 4 个字节作为 little-endian token，解码其后的参数；
5. 输出信息级别、文本、模块、文件位置以及必要的解码警告。

当前 decoder 支持源码中实现的整数、浮点、字符串、指针和常见 printf 转换；未知 token、截断帧和不支持的转换会输出带 `[P-RTLog]` 或 warning 的诊断文本，不会静默伪造正常日志。

### 7.2 配置和前提

```jsonc
{
  "type": "orbit",
  "request": "launch",
  "program": "${workspaceFolder}/build/Debug/frame.elf",
  "rttLogEnabled": true,
  "pRtLogEnabled": true,
  "pRtLogRoot": "D:\\STM32\\tool\\P-RTLog"
}
```

`pRtLogRoot` 目前会被读取并在 token database 加载失败时显示在诊断信息中；当前 `PRtLogDecoder` 实际从 ELF 读取 `.pw_tokenizer.entries`，不会遍历该 root 目录寻找 token 数据。若 ELF 没有该 section，启用 P-RTLog 也不会成功加载 token 字符串。

## 8. RTOS Views

### 8.1 外部扩展和自动登记

RTOS Views 由外部扩展提供。Orbit 激活时会尝试把主类型 `orbit` 和兼容别名 `ozone` 加入以下设置数组：

```jsonc
{
  "memory-view.trackDebuggers": ["orbit", "ozone"],
  "mcu-debug.rtos-views.trackDebuggers": ["orbit", "ozone"],
  "mcu-debug.debug-tracker-vscode.trackDebuggers": ["orbit", "ozone"]
}
```

也可以执行命令 `Orbit: Enable MCU Debug Views Integration`，由扩展补齐缺少的数组项；命令完成后可按提示 Reload Window。

### 8.2 RTOS 名称与自动刷新

在 launch 中设置：

```json
{
  "rtos": "FreeRTOS"
}
```

该值会进入 DAP 的 `supportsRTOS` / `rtosName` capability 和线程名称。Orbit 本身不内置 RTOS kernel 任务解析器；任务列表、栈、运行时间和检测逻辑由外部 RTOS Views 根据 DAP 数据和目标固件决定。

`orbit.rtosViewsAutoRefresh` 默认 `false`。设为 `true` 后，Orbit 在外部 debug tracker 报告第一次 stack trace 时，延迟触发 RTOS Views focus，再触发 `mcu-debug.rtos-views.refresh`。该兼容路径会增加调试会话开销，因此默认关闭。

### 8.3 运行时前提

RTOS Views 能看到的字段取决于：

- 外部 RTOS Views 与 debug tracker 已安装并启用；
- `trackDebuggers` 包含 `orbit`（为旧配置兼容也可同时保留 `ozone`）；
- ELF/DWARF 中保留了外部视图需要的类型和符号；
- 目标处于外部视图可读取的状态；
- 固件使用的 RTOS 版本和配置被外部视图支持。

Orbit 不会根据 `rtos: "FreeRTOS"` 自动证明固件确实运行 FreeRTOS。

## 9. Memory View

Memory View 是外部扩展通过 DAP memory 请求访问 Orbit 的目标内存。Orbit 的 DAP initialize capability 声明：

- `supportsReadMemoryRequest: true`；
- `supportsWriteMemoryRequest: true`。

读请求使用字符串或数字形式的 `memoryReference`，支持 offset；返回值是 base64 编码的字节，带 `address` 和 `unreadableBytes`。单次 DAP 读请求的 `count` 在源码中限制为最多 `1024 * 1024` bytes。

变量节点有有效地址时会提供 `memoryReference`，供外部 Memory View 跳转。读写请求仍由当前 DAP session 的唯一 target owner 执行；目标忙或读取失败时返回 DAP 错误，不会偷偷创建第二个连接。

若 Memory View 没有列出 Orbit，执行集成命令，或在工作区设置中加入：

```json
{
  "memory-view.trackDebuggers": ["orbit", "ozone"]
}
```

Orbit 不包含独立的 Memory View 网格 UI；Memory View 的分页、显示格式和外部扩展行为不由 Orbit 控制。

## 10. Peripheral Viewer

Peripheral Viewer 使用 CMSIS-SVD 描述文件构建寄存器树。Orbit 提供两个 launch 兼容字段：

```jsonc
{
  "svdFile": "${workspaceFolder}/STM32F407.svd",
  "svdPath": "${workspaceFolder}/STM32F407.svd",
  "deviceName": "STM32F407IG"
}
```

也可以设置：

```json
{
"orbit.defaultSvdFile": "${workspaceFolder}/STM32F407.svd"
}
```

当前源码保留 `svdFile` / `svdPath` / `deviceName` 供外部 MCU Debug Views 使用，但 Orbit 自身不解析 SVD，也不内置 Peripheral Viewer。寄存器名称、bit 字段、读写权限和显示质量取决于 SVD 文件及外部 Viewer。外部 Viewer 不显示时先检查扩展安装、`trackDebuggers`、SVD 路径和目标 device name。

仓库不内置 SVD。STM32H723 请使用 ST 官方 `STM32H723.svd`，通过 `svdFile` / `svdPath` 或 `orbit.defaultSvdFile` 指向本地文件，并把 `device` / `deviceName` 设为 `STM32H723VGT6`（或别名 `STM32H723VG`）。F407 示例仍可用 `STM32F407.svd`；默认器件不会因为安装 1.1.2 而改成 H723。

## 11. Target owner 与调试通道

### 11.1 三类 owner

| 通道 | 实现 | 特点 |
| --- | --- | --- |
| Native | 独立的 `orbit-jlink-helper.exe`，通过 JSON-lines 与 DAP 侧通信；helper 内加载 J-Link DLL | 拥有 Native source-level step into/over/out、批量内存读取和 NativeScheduler；目标为 Windows x64。 |
| Legacy | Node 进程中的 `koffi` 直接加载 `JLink_x64.dll` | 保留现有调试和 DAP 兼容路径；Native source-level step API 在该 owner 上不可用。 |
| CMSIS-DAP | 独立的 `orbit-cmsis-dap-helper.exe`，HID v1 已真机验收；WinUSB v2 有代码/Mock | 提供 SWD/DP/AP、Cortex-M 控制、FPB、内存、Flash Algorithm、Watch/Timeline 和内存型 RTT；不加载 J-Link DLL。 |

### 11.2 owner 选择

当前每个 DAP session 由 `SessionTargetSelector` 选择且只持有一个物理 owner：

- `probe: "cmsis-dap"`：只建立 CMSIS-DAP owner；失败或 owner loss 都不回退 J-Link；
- `probe: "jlink"`：再由以下 Native/Legacy 设置选择 J-Link owner；
- `nativeDebugEngineMode: "legacy"`：只建立 Legacy owner；
- `nativeDebugEngineMode: "native"`：只尝试 Native，Native 初始化失败即失败，不回退；
- `nativeDebugEngineMode: "auto"` 且 `nativeDebugEngineEnabled: true`：先尝试 Native，只有 Native 启动/初始化失败且尚未建立目标连接时才创建 Legacy owner；
- `nativeDebugEngineMode: "auto"` 且 `nativeDebugEngineEnabled: false`：走 Legacy；
- Native owner 已连接后发生 `NativeOwnerLost`：当前 session 终止，重新启动时再选择通道，不在原 session 热切换。

选择 Native owner 后，`stepInto`、`stepOver` 和 `stepOut` 都强制走 Native source-level stepping；选择 Legacy owner 时三种单步都走 Legacy 路径。

### 11.3 访问调度

Native owner 的 scheduler 优先级为：

```text
control  >  watch  >  timeline  >  background
```

继续、暂停、复位、断点、单步、Flash 和变量/内存写入属于 control；RTT 和 RTOS refresh 属于 background。调试会话运行时，活动 DAP 请求沿已选 owner 路由，Extension Host 不会再作为第二个物理 owner 接管目标。

## 12. MCP 与 Plugin API

### 12.1 Automation API v1

工作区设置 `orbit.automation.enabled`（默认 `false`）后，每个 Extension Host 在 `127.0.0.1` 启动独立 API：

- `GET /health`：实例身份、API version、uptime，不含 token；
- `POST /v1/rpc`：JSON-RPC 2.0，强制 Bearer；
- `GET /v1/events`：SSE，需 Bearer 与 `X-Orbit-Connection-Id`；
- 请求体最大 `1 MiB`；
- 发现：用户范围 `registries.json` + 每窗口 endpoint 文件；
- 一个发布周期仍写 legacy `plugin-api-endpoint.json`，内容只标记 `unique`/`ambiguous`，不会替客户端选窗口。

默认 `orbit.automation.allowedScopes` 仅为 `["read"]`。控制、断点、写入、录波、RTT、Flash 需要对应 scope。目标绑定方法必须带精确 `sessionId`/`sessionGeneration`；mutation 还要 `idempotencyKey`。

完整方法清单、错误码和 DTO 以 [Automation API v1](../../docs/api/orbit-automation-api.md) 和 OpenRPC 为准。Node / Python 客户端与 MCP 共用该协议。

一个发布周期保留旧 `POST /rpc` 的 `ozone.status` / `ozone.expr.*` / `ozone.record.*` / `ozone.experiment.run`，它们只映射到新 service 并带 deprecation，不能跳过 handshake 或 generation fence。

若活动 `orbit` DAP session（或旧 `ozone` 别名）存在，RuntimeRouter 将读写和目标状态请求发送到该 DAP session；DAP 请求失败会作为该操作的错误返回，不会回退到 Extension Host 的另一条目标连接。

### 12.2 MCP server

源码 MCP server 是 stdio 进程 `Releases/mcp/orbit-mcp-server.js`，它只作为 Automation API v1 的适配器：通过 Node client 发现 `ORBIT_AUTOMATION_REGISTRY` 中的实例、握手，再调用 `POST /v1/rpc`。`ozone-mcp-server.js` 只是兼容启动器。多个相同 `projectId` 窗口必须指定 `instanceId`，禁止选择最近活动窗口。

v1 工具：`orbit_instances`、`orbit_handshake`、`orbit_session_*`、`orbit_target_*`、`orbit_breakpoints_*`、`orbit_memory_*`，以及 `orbit_record_get` / `orbit_expression_evaluate` / `orbit_diagnostics_snapshot`。

便捷工具名同样映射到同一 v1 方法：

- `orbit_status` → `orbit.session.list`
- `orbit_read_many` → `orbit.expression.readMany`
- `orbit_write_many` → `orbit.expression.writeMany`
- `orbit_record` → `orbit.record.start/get/stop/clear`（分页读取）
- `orbit_experiment_run` → `orbit.experiment.run`

工具返回 structured JSON。`errorCode` 失败不得伪装成文本成功。默认 registry 为：

```text
%LOCALAPPDATA%\Orbit\automation\registries.json
```

`tools/list` 给每个 object `inputSchema` 显式带上 `required` 数组；全可选工具为 `[]`。opencode 对缺失 `required` 的 object schema 会发出 `required: null`（[issue #15540](https://github.com/anomalyco/opencode/issues/15540)，修复 PR 未合并）。严格的 OpenAI 兼容中转在转成 Anthropic 协议时会因此返回 `standard_violation /required: got null, want array`。MCP 侧补空数组即可，不改变工具参数语义。

### 12.3 MCP 数值、录波和实验边界

| 项目 | 源码限制 |
| --- | --- |
| 写入值 | Automation API 的 write value 是字符串；`orbit_write_many` 仍接受 number，适配器会转成字符串。 |
| 单次录波通道 | 至少 1 个，最多 64 个；alias 不能重复。 |
| 录波间隔 | 默认 `10 ms`，最终限制到 `5..10000 ms` 并取整数毫秒。 |
| 录波帧数 | 每个 recording 最多保留 `50000` 帧，超出时丢弃最旧帧。 |
| 录波时长 | `orbit_record` 按 `durationMs` 等待后分页读取全部 frames，再 stop/clear；单页默认 100、最大 1,000 frames。 |
| wait 时长 | `0..60000 ms`，取整数毫秒。 |
| 实验步骤 | 最多 64 步，类型为 `read`、`write`、`wait`、`record`。 |
| safety | 对匹配 expression 的写入执行可选 `min` / `max` 检查。 |

MCP 可以写入目标变量，因此应先用只读状态/读取确认表达式和目标状态，再进行带边界的写入。`unit`、`role`、`writable` 是 signal 元数据，不会替 Orbit 猜测目标变量的真实单位或安全范围。

## 13. 常见问题

### Q1：报 `Failed to load JLink DLL` 或 `JLinkDllLoadFailed`。

先确认 J-Link 软件已安装，并确认 `JLink_x64.dll` 存在。需要固定版本时设置 `orbit.jlinkDllPath`。然后查看 `outputs/Log/dll.log`，确认加载路径、DLL 版本和缺失导出符号。

### Q2：调试连接正常，但自动烧录失败。

J-Link 调试连接使用 DLL，自动烧录使用 `JLink.exe`；确认 `orbit.jlinkPath` 指向真实 Commander。CMSIS-DAP 烧录使用当前 helper 和匹配目标的 Flash Algorithm；检查算法来源、RAM 布局、芯片 ID 和 verify 错误。固件已存在时可设置 `flashBeforeDebug: false`，`program` 仍用于符号加载。

### Q3：没有找到 ELF/AXF。

设置 `program` 或 `orbit.defaultProgram`。未设置时只会检查 `build/Debug`、`build/Release`、`build`，且只匹配 `.elf` / `.axf`。

### Q4：Watch 显示 `Running...`，或者 Timeline 没有数据。

Watch 和 Timeline 都依赖当前 DAP session 的目标状态。Timeline 在目标停止时不生成采样点；表达式还必须能进入快速采样计划。减少通道数、确认目标确实在运行，并查看 `outputs/Log/dap.log` 中的读取和 Timeline 计划日志。

### Q5：RTT 没有输出。

确认 `rttLogEnabled` 为 `true`、固件已初始化 RTT 且 up-buffer index 正确。J-Link 要确认 DLL RTT 导出；CMSIS-DAP 要确认 `_SEGGER_RTT` 符号或显式 `rttControlBlockAddress`。如果使用 `debugConsole`，注意默认输出位置是 `terminal`。

### Q6：P-RTLog 输出 unknown token 或 token database not found。

确认当前 launch 的 `program` 是包含 `.pw_tokenizer.entries` 的 ELF，并同时设置 `rttLogEnabled: true` 与 `pRtLogEnabled: true`。当前 decoder 不从 `pRtLogRoot` 目录查找 token 数据；unknown token 会保留原始 token 和帧数据用于诊断。

### Q7：RTOS Views、Memory View 或 Peripheral Viewer 没有跟踪到 Orbit。

确认外部扩展已安装，并检查对应的 `trackDebuggers` 数组是否包含 `orbit`；兼容配置可同时保留 `ozone`。可以执行 MCU Debug Views 集成命令后 Reload Window。Peripheral Viewer 还需要有效 `svdFile` / `svdPath`；RTOS Views 还需要外部扩展能解析当前 ELF、RTOS 和目标状态。

### Q8：`nativeDebugEngineMode: "auto"` 为什么变成 Legacy？

`auto` 只在 Native 启动/初始化失败时回退 Legacy。查看 `outputs/Log/dll.log` 和 `outputs/Log/dap.log`；如果 Native owner 已连接后丢失，不会在原 session 中热切换，必须重新启动调试。

### Q9：配置写了 `interface: "JTAG"`，行为与预期不同。

Native helper 会按 `JTAG` 选择 JTAG；Legacy 当前 `JLinkDLL.connect()` 源码固定调用 `TIF_Select(SWD)`。请先使用 Native，并把该行为作为当前版本限制处理。

### Q10：MCP 找不到实例或 endpoint。

先打开工作区并设置 `orbit.automation.enabled: true`，再 Reload Window。客户端读取 `%LOCALAPPDATA%\Orbit\automation\registries.json`（可用 `ORBIT_AUTOMATION_REGISTRY` 覆盖）。多个相同 `projectId` 窗口必须指定 `instanceId`。旧的 `plugin-api-endpoint.json` 在多窗口时是 `ambiguous`，不能用来选窗口。

### Q11：MCP 读取/写入失败，但 VS Code 中调试已启动。

确认活动 session 的类型是 `orbit`（旧配置也可能是 `ozone`），目标状态为 `running` 或 `halted`，并使用 ELF/DWARF 中实际存在的表达式。活动 DAP session 存在时 MCP 不会绕过它建立第二条目标连接。

## 14. 已知限制

### 当前实现限制

- Native helper 和当前 J-Link DLL 集成是 Windows 目标；仓库没有把 Linux/macOS 作为当前 Native 运行目标。
- CMSIS-DAP helper 当前同样以 Windows x64 为发布目标；实现 v2 WinUSB 和 v1 HID。1.1.0 真机验收覆盖 v1 HID；v2 WinUSB 只有代码/Mock/构建证据，具体 probe 固件兼容性仍以设备枚举和握手为准。
- `J-Link` 设备支持列表由已安装的 J-Link 软件/DLL 决定，源码没有内置完整 MCU 清单。STM32H723VGT6 的 J-Link 链路已在 1.1.2 通过真机验收（P7-6，2026-09-11，owner 只出现 `jlink-native`）；`device` 必须写 J-Link 软件认识的名称（如 `STM32H723VG`），`STM32H723VGT6` 不在 J-Link V9.56 的器件库里。长稳/断线（P7-7）未验收。
- CMSIS-DAP 内置 Flash 注册表当前只有 `STM32F407VET6` 与 `STM32H723VGT6`（及各自别名）。H723 需显式设置 `device`；默认值仍是 `STM32F407VG`。
- `interface` schema 接受 `SWD` 和 `JTAG`，但 Legacy DLL 连接实现当前固定选择 SWD；JTAG 应使用 Native 并单独确认硬件。
- J-Link 路径使用 6 个槽位索引；CMSIS-DAP 会读取 Cortex-M FPB 容量。任何路径槽位耗尽时新硬件断点都必须返回明确错误。
- Native source-level step into/over/out 只属于 Native owner；Legacy 不能把普通单步宣传为 Native source-level stepping。
- Timeline 的 `0.2 ms` 是目标间隔，不是硬件实时采样保证；目标读取延迟、表达式数量、控制操作和 Watch 会降低实际频率。
- Timeline 只保留约 10 分钟历史，且停止期间不回填数据。
- 快速 Timeline 只接受当前源码能解析的表达式；不支持的表达式会被采样计划拒绝。
- RTOS Views、Memory View 和 Peripheral Viewer 不随 Orbit 的源码自动获得全部功能；它们需要外部扩展、正确的 tracking 配置和与当前固件匹配的 ELF/SVD。
- Orbit 不解析 SVD，也不内置 RTOS kernel 解析器。
- P-RTLog token 必须在当前 ELF 的 `.pw_tokenizer.entries` 中；`pRtLogRoot` 当前不是 token 搜索路径。
- Automation API v1 默认关闭。1.1.0 硬件层：J-Link native 与 CMSIS-DAP HID v1 已通过（无 flash）；J-Link legacy 与显式 Flash 不在本版范围，不得与 Mock/自动化结果合并成“全部通过”。
- J-Link Legacy 不提供 Native source-level `stepInto`/`stepOver`/`stepOut`；这些调用必须返回 `CapabilityUnavailable`，不得启动第二个 owner 来模拟。

### 当前 DAP capability 中明确未提供的功能

源码的 `initialize` 响应明确关闭或不支持：conditional breakpoint、hit conditional breakpoint、step back、set variable、restart frame、goto targets、step-in targets、completions、exception options、terminate debuggee、log points、data breakpoints、disassemble、cancel、breakpoint locations、stepping granularity 和 instruction breakpoints。读写 memory、evaluate for hovers、restart request 和 RTOS capability 则明确声明支持。

### 发布/品牌确认边界

Orbit 改名已覆盖扩展元数据、用户可见命令和视图标题、输出通道、图标、MCP 展示文案以及 Native helper 产物。`ozone` 前缀的 DAP 类型、配置键、外部视图 tracking 值、workspace state 键和 MCP 方法仍作为兼容标识保留。
