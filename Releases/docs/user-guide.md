# Orbit 用户手册

> 适用版本：1.2.3

## 目录

- [1. 安装与环境要求](#1-安装与环境要求)
- [2. 调试探针与烧录](#2-调试探针与烧录)
- [3. launch.json 配置](#3-launchjson-配置)
- [4. Watch 变量读写](#4-watch-变量读写)
- [5. Timeline 波形采样](#5-timeline-波形采样)
- [6. RTT 日志](#6-rtt-日志)
- [7. P-RTLog 二进制日志](#7-p-rtlog-二进制日志)
- [8. RTOS 诊断与 SystemView Trace](#8-rtos-诊断与-systemview-trace)
- [9. Memory View](#9-memory-view)
- [10. Peripheral Viewer](#10-peripheral-viewer)
- [11. 调试通道与调度机制](#11-调试通道与调度机制)
- [12. MCP 与 Plugin API](#12-mcp-与-plugin-api)
- [13. 常见问题](#13-常见问题)
- [14. 已知限制](#14-已知限制)
- [15. 开源许可与第三方组件](#15-开源许可与第三方组件)

## 1. 安装与环境要求

### 1.1 安装扩展

可以直接在 VS Code 扩展市场搜索 **Orbit STM32 Debugger**（ID：`orbit-debug.orbit-for-vscode`）安装，也可以从 [GitHub Releases](https://github.com/zhuangyan114/Orbit/releases) 下载 `.vsix` 离线安装：

1. 在 VS Code 中按 `Ctrl + Shift + P`，执行 `Extensions: Install from VSIX...`。
2. 选择下载的 `.vsix` 文件，安装后按提示重新加载窗口。
3. 打开包含 ELF/AXF 固件的工程，在 `launch.json` 中使用 `"type": "orbit"` 即可（旧配置中的 `"type": "ozone"` 仍然兼容）。

Releases 中也会附带独立的 MCP server 和配置 Skill，配合 AI 进行自动化调试，详见 [12. MCP 与 Plugin API](#12-mcp-与-plugin-api)。

### 1.2 运行环境

| 项目 | 说明 |
| --- | --- |
| 操作系统 | 目前仅支持 Windows x64（扩展自带原生 helper 可执行文件）。 |
| VS Code | 需要 VS Code 1.90.0 及以上版本。 |
| 目标芯片 | 面向 STM32 与 ARM Cortex-M。J-Link 支持其自带器件库中的所有芯片；CMSIS-DAP / RMLink 烧录优先使用内置 F103C8、F407VE/IG、H723VG 快速算法，其余受支持的 STM32 F1/F4/H72x/G0/G4 型号由随扩展提供的 OpenOCD 烧录。 |
| 调试探针 | 支持 SEGGER J-Link（需安装 SEGGER 软件包提供 `JLink_x64.dll`）、CMSIS-DAP / DAPLink（HID v1、WinUSB v2 与 TCP 网络探针）以及 RMLink 连接服务。WinUSB 详细测试见 [WinUSB 报告](../../docs/cmsis-dap-v2-winusb-report.md)。 |
| 固件文件 | 需要带 DWARF 调试信息的 `.elf` 或 `.axf` 文件。 |
| 外部视图 | Memory View 和 Peripheral Viewer 由对应外部扩展提供，Orbit 负责向它们提供内存、寄存器和符号数据；FreeRTOS 诊断与 SystemView Trace 已由 Orbit 原生内置。 |

### 1.3 GNU Arm 符号工具链

Orbit 通过以下工具解析 ELF 符号、源码行号与变量类型：

- `arm-none-eabi-nm.exe`
- `arm-none-eabi-objdump.exe`
- `arm-none-eabi-addr2line.exe`

建议将它们所在的 `bin` 目录加入系统 `PATH`。缺少这些工具时探针仍可连接，但断点定位、变量展开和源码级单步会受到影响。

### 1.4 从源码构建（开发者）

如果你需要自己修改并构建扩展，除了 Node.js / npm 外，构建原生 helper 还需要 CMake 3.20+ 和 Windows C++ 编译环境（Visual Studio C++ 工具链或 x64 MinGW-w64）：

```powershell
npm install
npm run build:openocd
npm run build
npm run build:native
npm run typecheck
```

构建产物位于 `dist/`、`out/openocd/` 和 `out/native/win32-x64/`。普通用户直接安装 VSIX 即可，不需要配置 CMake 或 C++ 编译器。

## 2. 调试探针与烧录

### 2.1 J-Link

Orbit 通过 `orbit-jlink-helper.exe`（或备选的 `koffi` 通道）加载 `JLink_x64.dll` 与探针通信，不需要启动 OpenOCD、GDB server 或 Ozone GUI。

当工作区设置 `orbit.jlinkDllPath` 留空时，Orbit 按以下顺序查找 `JLink_x64.dll`：

1. `C:\Program Files\SEGGER\JLink_V*\JLink_x64.dll`（优先最新版本号）；
2. `C:\Program Files\SEGGER\Ozone\JLink_x64.dll`；
3. 系统默认搜索路径中的 `JLink_x64.dll`。

遇到连接或驱动异常时，可以先查看工程目录下的 `outputs/Log/dll.log`。如果安装的 J-Link DLL 缺少 RTT 导出函数，即使调试功能正常，RTT 日志也无法使用。

### 2.2 `JLink.exe` 与自动烧录

`orbit.jlinkPath` 默认指向 `C:\Program Files\SEGGER\JLink\JLink.exe`。当 `flashBeforeDebug` 为 `true`（默认值）且指定了有效的固件文件时，启动调试会调用 `JLink.exe` 完成擦除、烧录和校验（默认超时 30 秒）。

如果设置了 `"flashBeforeDebug": false`，或在同一次调试中点击“重启”且固件文件没有变化，Orbit 会跳过烧录流程，直接复位运行。

### 2.3 CMSIS-DAP / DAPLink

设置 `"probe": "cmsis-dap"` 会启动 `orbit-cmsis-dap-helper.exe` 连接探针。默认 `"cmsisDapTransport": "auto"` 会优先匹配 CMSIS-DAP v2（WinUSB），找不到时再尝试 v1（HID）。多只探针同时接入时，可通过 `cmsisDapSerial`、`cmsisDapVid`、`cmsisDapPid` 或 `cmsisDapPath` 指定具体设备。

如果电脑上同时插着 J-Link 和 DAPLink 且希望强制使用 DAPLink，请在 `launch.json` 中加上 `"probe": "cmsis-dap"`。锁定 v2 WinUSB 和序列号的示例：

```jsonc
"probe": "cmsis-dap",
"cmsisDapTransport": "cmsis-dap-v2",
"cmsisDapSerial": "507874001033"
```

（`winusb` 与 `cmsis-dap-v2` 等价；显式指定 `cmsis-dap-v2` 时不会降级到 HID。）

#### 网络探针（TCP）

将 `cmsisDapTransport` 设为 `"tcp"`，并在 `cmsisDapPath` 中填入探针地址 `host` 或 `host:port`（默认端口 3241，IPv6 写成 `[addr]:port`），即可连接支持 OpenOCD `cmsis-dap tcp` 帧格式的网络探针。由于 `"auto"` 不会扫描局域网，网络探针需要显式指定 `"tcp"`。

```jsonc
"probe": "cmsis-dap",
"cmsisDapTransport": "tcp",
"cmsisDapPath": "192.168.0.108",
"flashBeforeDebug": false
```

#### 探针端采样（XR-DAP）

当探针固件实现了 [XR-DAP](https://github.com/Jiu-xiao/XRDAP-ESP) 厂商扩展（命令 `0x80–0x85`），且在 `launch.json` 中显式设置 `"cmsisDapXrSampling": true` 时，Timeline 会把采样任务交给探针本身：探针按固定定时器采样并打上微秒级时间戳缓存，Orbit 每 10 ms 批量取回，即使在 Wi-Fi 下也能保持稳定的采样节拍。USB、HID 和 TCP 均可使用。

- 探针采样期间，Watch 标量读取和运行态查询不打断采样；单步、断点、写变量或 RTT 读取等命令会由 helper 自动暂停采样、执行完再恢复。
- 如果探针评估无法跟上 `orbit.timelineSampleIntervalMs`，helper 会自动放宽到探针可维持的周期，并在界面显示实际速率。
- 当前单次最多支持 32 个采样通道，且指针偏移需在 `0–32767` 字节内；超出限制或探针不支持时自动退回电脑轮询。

#### 内置 Flash 烧录支持

CMSIS-DAP 和 RMLink 默认根据 `device` 选择烧录方式。下列芯片优先使用内置快速算法，其他受支持的型号由随 Orbit 提供的 OpenOCD 烧录。

| `device` 名称 / 别名 | 容量与算法说明 | 实板状态 |
| --- | --- | --- |
| `STM32F407VET6` / `STM32F407VE` | 512 KiB Flash，自研 F4 算法 | 已在 HID v1 上验证通过 |
| `STM32F407IG` / `STM32F407IGT6` / `STM32F407IGT7` / `STM32F407IGH6` / `STM32F407IGH7` | 1 MiB（12 扇区），独立 F4 算法镜像 | 已在 HID v1 / RMLink 上实测可用 |
| `STM32F103C8T6` / `STM32F103C8` | 64 KiB（64 × 1 KiB 页），20 KiB SRAM，F1 半字算法 | 源码已适配，待完整实板验证 |
| `STM32H723VGT6` / `STM32H723VG` | 1 MiB Flash，自研 H7 算法 | 已在 HID v1 与 J-Link 上验证通过 |

说明：
- `flashBackend` 默认等同于 `"auto"`。`"native"` 仅使用已登记型号的算法，`"openocd"` 则为已支持的型号显式选择内置 OpenOCD。只填写型号即可，Orbit 会自动选择脚本。
- OpenOCD 路径目前覆盖部分 STM32 F103、F4、H723/H725、G0 和 G4 型号的 SWD 片内 Flash 烧录。未匹配型号、外置 Flash 或超出探测到的 Flash 容量会在擦除前报错。RMLink 未登记型号在此路径下使用通用 CMSIS-DAP 调试，增强采样仍要求已登记型号。
- 只调试板上已有固件时设置 `"flashBeforeDebug": false`。
- `STM32F407IG` 的芯片 ID（`0x413`）为 F405/407/415/417 系列共用，算法工作区使用 `0x20000000` 起的普通 SRAM（暂不支持固件段直接落在 CCM RAM 中）。
- `STM32F103C8` 按标准 64 KiB 容量校验，暂不支持非官方扩容型号或 128 KiB 的 CB 型号。
- 用 **J-Link** 调试 `STM32H723` 时请注意：部分旧版 J-Link 器件库（例如 V9.56）只识别 `"STM32H723VG"`，不识别 `"STM32H723VGT6"`，写错会导致 J-Link 弹窗卡住。

### 2.4 RMLink 连接服务

设置 `"probe": "rmlink"` 即可通过 RMLink 服务进行调试、缓存/页镜像烧录和板端高速订阅采样：

```jsonc
{
  "name": "Orbit RMLink",
  "type": "orbit",
  "request": "launch",
  "probe": "rmlink",
  "device": "STM32F407IG",
  "interface": "SWD",
  "speedKHz": 4000,
  "flashBeforeDebug": true
}
```

- **设备选择**：如果当前只有一台在线且已配对的 RMLink 设备，可省略 `rmlinkDeviceId`；多台设备在线时请填写 12 位十六进制 `rmlinkDeviceId`。如果只写了 `rmlinkDeviceId` 而未写 `probe`，Orbit 也会自动启用 RMLink（此时若未显式设置 `flashBeforeDebug`，默认跳过烧录）。
- **烧录与诊断**：支持基于芯片注册表的缓存/页镜像烧录，控制台会输出阶段、地址、扇区进度、板端重试与总耗时；若烧录失败，诊断信息会记录在日志中方便排查。
- **Timeline 订阅与恢复**：Timeline 会使用 RMLink 板端 `memory_series` 订阅并同步探针时间。如果采样流因网络波动中断且分组采样仍处于开启状态，Orbit 会自动按指数退避重连恢复（连续稳定接收 3 秒后重置退避时间），无需重启调试。

## 3. `launch.json` 配置

### 3.1 最小配置

在 VS Code 的“运行和调试”面板点击 **创建 launch.json 文件**，选择 **Orbit (J-Link / CMSIS-DAP / RMLink)**，会生成一份精简配置。通常只需要把 `device` 填上你的芯片型号就能直接按 **F5** 调试：

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

编辑 `device` 时会提供 18 个常用 STM32 F1/F4/G4/H7 型号的代码补全（按 `Ctrl + Space` 触发），也可以手动输入其他型号。

默认省略 `probe` 时等效于 `"probe": "auto"`：Orbit 会先检测是否连接了 J-Link，没有的话再检测 CMSIS-DAP/DAPLink（两者同时连接时优先选 J-Link）。如果需要强制使用 DAPLink 或 RMLink，只需加上对应的 `probe` 字段即可：

```jsonc
{
  "name": "Orbit DAPLink",
  "type": "orbit",
  "request": "launch",
  "probe": "cmsis-dap",
  "device": "STM32H723VGT6"
}
```

### 3.2 常用 `launch.json` 属性

| 属性 | 类型 / 可选值 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `device` | string | `"STM32F407VG"` | 目标芯片型号。J-Link 使用 SEGGER 器件名，CMSIS-DAP 和 RMLink 用它自动选烧录配置。 |
| `flashBackend` | string | `"auto"` | `auto` 优先选快速算法，`native` 只选快速算法，`openocd` 选用内置通用烧录。 |
| `deviceName` | string | 跟随 `device` | 供外部 MCU Debug Views 使用的别名，通常不用单独填写。 |
| `probe` | `auto` / `jlink` / `cmsis-dap` / `rmlink` | `"auto"` | 调试探针类型。 |
| `rmlinkDeviceId` | string（12 位十六进制） | `""` | 指定 RMLink 设备 ID；`probe: "rmlink"` 且仅一台设备在线时可省略。 |
| `cmsisDapTransport` | `auto` / `cmsis-dap-v2` / `winusb` / `cmsis-dap` / `hid` / `tcp` | `"auto"` | CMSIS-DAP 传输方式；`auto` 优先 WinUSB v2，其次 HID v1；`tcp` 用于网络探针。 |
| `cmsisDapXrSampling` | boolean | `false` | 是否启用 XR-DAP 探针端 Timeline 采样。 |
| `cmsisDapSerial` | string | `""` | 按探针序列号过滤。 |
| `cmsisDapVid` / `cmsisDapPid` | string | `""` | 按 USB VID / PID 过滤（十六进制字符串）。 |
| `cmsisDapPath` | string | `""` | 按设备路径精确匹配；`cmsisDapTransport: "tcp"` 时填 `host[:port]`（默认端口 3241）。 |
| `cmsisDapFlashAlgorithmPath` | path | `""` | 自定义 CMSIS-DAP Flash 算法文件（`.flm` 或 manifest）路径。 |
| `program` | path | 自动查找 | `.elf` / `.axf` 固件路径（兼容旧别名 `elfPath`）。 |
| `svdFile` / `svdPath` | path | 自动解析 | 外设寄存器描述文件（`.svd`）路径，留空时自动搜索或后台按需下载。 |
| `interface` | `SWD` / `JTAG` | `"SWD"` | 调试接口。CMSIS-DAP、RMLink 与 J-Link Legacy 仅使用 SWD；JTAG 需配合 J-Link Native。 |
| `speedKHz` | number（kHz） | `4000` | SWD / JTAG 通信时钟频率。 |
| `flashBeforeDebug` | boolean | `true` | 启动前是否烧录固件。点击“重启”时若固件未变化则自动跳过烧录直接复位运行，固件变化后重烧并停在入口；设为 `false` 则始终跳过烧录。 |
| `runToEntryPoint` | string / `false` | `"main"` | J-Link、CMSIS-DAP 和 RMLink 烧录后自动停靠的函数名（重启时仅固件变化后停靠）；设为 `false` 禁用。 |
| `rtos` | string | `""` | 目标 RTOS 名称（如 `"FreeRTOS"`），用于 Orbit 内置 RTOS 面板及标准 DAP `rtosInfo`（兼容别名 `defaultRtos`）。 |
| `rtosSnapshotPort` | object | 未配置 | FreeRTOS 栈高水位扫描与 CPU% 运行统计端口参数（`source`、`stackGrowth`、`stackFillByte`、`runtime`），缺省时相关列保持不可用。 |
| `loggingEnabled` | boolean | `true` | 是否启用 Orbit 内部诊断日志（`step`、`eval`、`dll`、`dap`）。 |
| `clearLogsOnStart` | boolean | `true` | 启动会话时是否清空旧的内部诊断日志。 |
| `rttLogEnabled` | boolean | `true` | 是否开启 SEGGER RTT 日志读取。 |
| `rttBufferIndex` | number（`0..15`） | `0` | RTT 上行缓冲区编号。 |
| `rttPollIntervalMs` | number（`10..5000` ms） | `50` | RTT 轮询间隔。 |
| `rttReadSize` | number（`64..65536` bytes） | `4096` | 每次轮询最大读取字节数。 |
| `rttControlBlockAddress` | number / string | `""` | RTT 控制块地址（支持 `0x...` 或十进制）。留空时 J-Link 自动搜索内存，CMSIS-DAP 从 ELF 的 `_SEGGER_RTT` 符号定位。 |
| `rttStripAnsi` | boolean | `true` | 输出到 Debug Console 时是否去除 ANSI 颜色控制符（RTT 终端始终保留颜色）。 |
| `rttLogTarget` | `terminal` / `debugConsole` / `both` | `"terminal"` | RTT 日志显示位置。 |
| `pRtLogEnabled` | boolean | `false` | 是否启用 P-RTLog 二进制帧解码。 |
| `pRtLogRoot` | path | `""` | P-RTLog 诊断记录用路径配置。 |
| `nativeDebugEngineEnabled` | boolean | `true` | 是否优先使用 J-Link 原生 C++ helper。 |
| `nativeDebugEngineMode` | `auto` / `native` / `legacy` | `"auto"` | J-Link 引擎模式：`auto` 优先原生 helper，启动失败时回退 `koffi` Legacy；`native` 与 `legacy` 分别强制使用对应模式。 |

### 3.3 固件 ELF/AXF 自动查找规则

如果 `program` 和 `orbit.defaultProgram` 都未填写，Orbit 会按顺序扫描工程下的以下目录，选取找到的第一个 `.elf` 或 `.axf` 文件：

1. `build/Debug`
2. `build/Release`
3. `build`

若工程同时存在多个编译产物或放在自定义目录，建议直接在 `program` 中显式指定路径。

### 3.4 工作区全局设置（`orbit.*`）

在 VS Code 的 `settings.json` 中可以配置 `orbit.*` 默认参数（旧版 `ozone.*` 设置会在激活时自动迁移）；`launch.json` 中的同名配置优先级更高。

| 设置项 | 类型 / 范围 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `orbit.jlinkPath` | path | `C:\Program Files\SEGGER\JLink\JLink.exe` | J-Link 烧录使用的 Commander 路径。 |
| `orbit.jlinkDllPath` | path | `""` | 手动指定 `JLink_x64.dll` 路径，留空自动查找。 |
| `orbit.defaultDevice` | string | `"STM32F407VG"` | 默认芯片型号。 |
| `orbit.defaultInterface` | `SWD` / `JTAG` | `"SWD"` | 默认调试接口。 |
| `orbit.defaultSpeed` | number（kHz） | `4000` | 默认时钟速率。 |
| `orbit.defaultProgram` | path | `""` | 默认固件路径，留空自动扫描 `build/` 目录。 |
| `orbit.defaultSvdFile` | path | `""` | 默认 SVD 文件路径。 |
| `orbit.svdAutoDownload` | boolean | `true` | 本地缺少 SVD 时先正常启动调试，并在后台按芯片系列下载缓存 Keil DFP 中的对应 SVD。 |
| `orbit.defaultRtos` | string | `""` | 默认 RTOS 名称（如 `"FreeRTOS"`），用于内置 RTOS 面板与标准 DAP `rtosInfo`。 |
| `orbit.logging.enabled` | boolean | `true` | 是否记录 Orbit 内部诊断日志（输出到 `outputs/Log/`）。 |
| `orbit.logging.clearOnStart` | boolean | `true` | 每次启动时是否清空旧的内部诊断日志。 |
| `orbit.rttLogEnabled` | boolean | `true` | 默认启用 RTT。 |
| `orbit.rttBufferIndex` | number（`0..15`） | `0` | 默认 RTT 通道索引。 |
| `orbit.rttPollIntervalMs` | number（`10..5000` ms） | `50` | 默认 RTT 轮询周期。 |
| `orbit.rttReadSize` | number（`64..65536` bytes） | `4096` | 默认 RTT 单次读取字节数。 |
| `orbit.rttControlBlockAddress` | string | `""` | 默认 RTT 控制块地址。 |
| `orbit.rttStripAnsi` | boolean | `true` | Debug Console 输出去除 ANSI 颜色码。 |
| `orbit.rttLogTarget` | `terminal` / `debugConsole` / `both` | `"terminal"` | 默认 RTT 显示窗口。 |
| `orbit.pRtLogEnabled` | boolean | `false` | 默认启用 P-RTLog 解码。 |
| `orbit.pRtLogRoot` | path | `""` | 默认 P-RTLog 路径配置。 |
| `orbit.nativeDebugEngine.enabled` | boolean | `true` | 是否允许 J-Link 原生 helper。 |
| `orbit.nativeDebugEngine.mode` | `auto` / `native` / `legacy` | `"auto"` | 默认 J-Link 引擎策略。 |
| `orbit.watchPollIntervalMs` | number（`100..10000` ms） | `500` | Watch 面板可见时的轮询刷新间隔。 |
| `orbit.timelineSampleIntervalMs` | number（`0.1..10000` ms） | `0.2` | Timeline 目标采样间隔（0.2 ms 对应目标 5 kHz；实际速率受探针和通道数限制）。 |
| `orbit.timelineSendIntervalMs` | number（`1..10000` ms） | `16` | Timeline 向界面推送刷新的节拍。 |
| `orbit.flashBeforeDebug` | boolean | `true` | 默认启动调试前烧录固件。 |
| `orbit.recentSessions` | number（`0..50`） | `10` | 保留的最近调试会话记录条数。 |
| `orbit.automation.enabled` | boolean | `false` | 是否开启本地 Automation API（供 MCP 和脚本接入）。 |
| `orbit.automation.allowedScopes` | string[] | `["read"]` | 自动化接口允许授予的最高权限范围。 |

## 4. Watch 变量读写

### 4.1 主要功能

- **直接添加与批量选变量**：在 `WATCH` 面板输入框直接输入表达式回车添加；或者留空后点击右侧蓝色 **+**，在编辑器区域打开「选择变量」面板。
  - 变量选择面板采用 Name、Type、Size、Address、Select 五列表格，按源文件分组，支持按变量名、成员名、类型或源文件搜索（“其他符号”默认折叠，搜索时自动展开匹配项）。
  - 点击箭头或双击变量名可展开结构体、数组或指针，勾选或取消勾选后点击「添加」一次性应用增删；点击「关闭」、`Esc` 或切换窗口会取消本次修改。
- **多分组管理**：顶部提供 `watch1`、`watch2` 等分组标签，支持新建分组（自动复用最小空缺编号）、点击切换、双击重命名（支持中文）、拖动调整标签顺序以及点击 `×` 删除分组（至少保留一个）。
- **数值实时查看与高亮**：支持展开结构体、数组和指针查看子成员；数值发生变化时会自动高亮提示（持续 500 ms）。
- **运行中不停机直写（Live Write）**：点击叶子数值可以直接修改并写入 MCU 内存，支持十进制、科学计数法和 `0x...` 十六进制格式（复合结构节点不能整体直接写入）。目标运行中改参无需临时暂停（halt）和恢复芯片，避免打断 PWM、实时控制中断或触发看门狗；CMSIS-DAP 采用原生 8/16/32-bit MEM-AP CSW 写入消除子字写竞态，同时保留控制写屏障与 RAM 地址边界安全校验。
- **一键发送到 Timeline**：点击 Watch 行上的图表图标，可直接把该数值变量添加到 Timeline 采样。

### 4.2 状态与调度机制

- 各分组的表达式、展开状态与顺序会自动保存在当前工作区；当前活动分组每次只刷新可见面板里的表达式，Watch 面板隐藏时自动停止后台轮询，减少探针占用。
- 调试控制指令（暂停、继续、单步、断点、修改变量）优先于 Watch 和 Timeline 读取，确保调试控制响应流畅。

## 5. Timeline 波形采样

### 5.1 通道管理与分组

- **添加采样变量**：可以在 Timeline 输入框直接输入全局变量或成员路径添加，也可以从 Watch 行一键发送过来；输入框留空点击蓝色 **+** 即可打开共用的「选择变量」面板。
  - Timeline 只允许新增数值叶子变量（`float`、`double`、整数、枚举等）；结构体、数组和指针需要先展开再勾选内部成员（大数组每次分页展开 100 项，也可直接输入如 `buffer[1500]` 筛选）。
  - 即使没有启动调试，也可以直接离线解析工程的 ELF/AXF 文件预先选好要看的变量（如果工程有多个 ELF 会弹出列表供选择）。
- **变量排序与颜色**：左侧变量列表支持鼠标拖动调整顺序并保存；点击变量前的色块可打开调色盘（跟随 VS Code 深/浅/高对比度主题），支持拖动选色或输入 RGB / 十六进制颜色值。
- **调试分组与采样开关**：顶部支持新建、切换、双击重命名（支持中文）、拖动排序和删除调试分组（默认 `timeline1`）。每个调试分组左侧带有一个采样复选框：
  - 默认未勾选（显示“采样已关闭”），防止不需要采样时白占探针带宽；
  - 勾选后，在调试运行期间自动开启采样（显示“采样已启用”或“等待调试”）；取消勾选可随时停止该组采样。

### 5.2 图表交互与游标测量

- **追踪与缩放**：默认开启自动追踪最新波形；鼠标滚轮以当前指针所在时间为中心缩放横轴，工具栏加减号与输入框以图表中心缩放（横轴最大支持 `100 s/div`，8 格可查看 800 秒）。缩放或向左拖动查看历史后会自动暂停追踪，**右键单击图表空白处**可立刻恢复追踪。
- **Y 轴比例**：默认开启自动缩放；在左侧或通道栏手动输入 `/div` 数值后进入手动缩放，双击即可切回自动缩放。
- **A/B 时间游标**：
  - **左键单击**图表空白处依次放置 A、B 两条时间游标，图内自动绘制水平连线并标注时间差 Δt（若 A 未放置或已移出当前可视范围，再次单击会重新从 A 开始放置）。
  - **左右拖动**游标可微调位置，虚线与悬浮值实时跟随；**右键单击**某个游标将其删除，**按下鼠标中键**可一次性清除 A/B 两条游标。
- **开始新记录**：点击清除实时数据会结束当前记录并保留为一个历史标签页，同时基于当前变量列表开始一段全新的记录，不会丢失刚才抓到的波形。

### 5.3 保存、打开与恢复历史记录

- **导出 CSV**：“保存全部 CSV”导出整段记录，“保存 A/B 区间”只导出两条游标之间的数据。CSV 内同时保存原始时间戳、数值和各通道颜色/比例/游标等视图配置，默认保存在工程的 `.vscode/timeline/` 目录下（以调试开始时间命名）。
- **离线查看**：点击“打开 CSV”可在独立标签页回看保存的波形，无需连接开发板，也不会干扰当前正在采集的实时标签页；点击“恢复记录”可快速列出工作区 `.vscode/timeline/` 中保存过的历史文件。
- **长期记录支持**：采集期间采样数据会持续写入系统的临时磁盘缓存，内存占用保持平稳，可以轻松回看超过 10 分钟的长波形（只有手动点击保存的 CSV 才会保留在工程目录中，关闭 VS Code 后未保存的临时记录会自动清理）。

### 5.4 采样率与多探针说明

- **采样率显示**：保存按钮右侧、坐标格上方显示当前采样率（整数 Hz）。实时调试时悬停提示“实时采样率”（约 1.5 秒无新数据后归零）；调试结束、打开 CSV 或恢复记录后自动切换为整段“平均采样率”（暂停期间不计入）。
- **采集方式差异**：
  - **J-Link / 普通 CMSIS-DAP**：由电脑端定时批量读取内存；复杂多级指针或过多通道会分摊读取带宽，目标处于暂停状态时不产生新采样点。
  - **RMLink**：由探针板端直接订阅 `memory_series` 采样并带有精确时间戳，流中断时支持自动重连恢复。
  - **XR-DAP（需开启 `cmsisDapXrSampling: true`）**：由探针端定时器采样并缓存回传，避免 USB/Wi-Fi 往返抖动。
- **表达格式限制**：如果输入的表达式无法解析为静态地址或受限指针链，会被快速采样计划跳过（不会画成一条零线），可在 `outputs/Log/dap.log` 查看详细原因。

## 6. RTT 日志

### 6.1 使用方法

`rttLogEnabled` 默认为 `true`。启动调试连接目标后，Orbit 会自动开始读取 SEGGER RTT 上行通道数据：

- **J-Link**：通过 DLL 内置的 RTT 接口自动搜索控制块并读取；
- **CMSIS-DAP / RMLink**：通过目标内存直接读取控制块与环形缓冲区（要求固件已初始化 RTT，且 ELF 中存在 `_SEGGER_RTT` 符号或配置了 `rttControlBlockAddress`）。

通过 `rttLogTarget` 可选择输出位置：
- `terminal`（默认）：在 VS Code 的 `Orbit RTT Log` 终端显示，完整保留 ANSI 彩色日志；
- `debugConsole`：输出到 VS Code Debug Console（默认去除 ANSI 控制符）；
- `both`：两处同时输出。

### 6.2 常用 RTT 配置

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `rttBufferIndex` | `0` | 上行通道号（`0..15`）。 |
| `rttPollIntervalMs` | `50` | 轮询间隔（`10..5000 ms`）。 |
| `rttReadSize` | `4096` | 单次最大读取字节数（`64..65536`）。 |
| `rttControlBlockAddress` | `""` | 手动指定 RTT 控制块地址（如 `0x20000000`）。 |
| `rttStripAnsi` | `true` | 写入 Debug Console 前去除颜色控制码。 |
| `rttLogTarget` | `"terminal"` | 显示目标：`terminal`、`debugConsole` 或 `both`。 |

注：统一 RTT 通道支持普通文本日志（如通道 0 `Terminal`）与 SystemView 二进制流（独立 `SysView` 通道）共存。在高速 Timeline 采样期间，后台 RTT 文本轮询会自动暂停以让出探针带宽，采样停止后自动恢复。

## 7. P-RTLog 二进制日志

P-RTLog 是运行在 RTT 之上的二进制令牌化日志格式（基于 `pw_tokenizer`），能大幅减少 MCU 串口/RTT 格式化开销。在 `launch.json` 中启用 `"pRtLogEnabled": true` 后：

1. Orbit 从当前 `program` ELF 的 `.pw_tokenizer.entries` 段加载 token 字符串表；
2. 按 `[2 字节小端长度][帧负载]` 拆分 RTT 字节流；
3. 解析前 4 字节 token 及后续变长参数（支持整数、浮点、字符串、指针及常见 printf 格式），还原出日志级别、模块名、源码位置和格式化文本。

```jsonc
{
  "type": "orbit",
  "request": "launch",
  "rttLogEnabled": true,
  "pRtLogEnabled": true
}
```

请确保 ELF 文件在链接时保留了 `.pw_tokenizer.entries` 段；若遇到未识别的 token，日志中会直接输出原始 token ID 方便核对固件版本。

## 8. RTOS 诊断与 SystemView Trace

Orbit 在 VS Code 底部面板区原生内置了 **RTOS** 诊断视图（视图 ID：`ozoneRtos`），直接复用当前活动调试会话的探针连接（支持 J-Link、CMSIS-DAP/DAPLink 与 RMLink），**不再需要安装外部 `mcu-debug.rtos-views` 扩展**（自 `1.2.2` 起已移除旧的 `mcu-debug.rtos-views.trackDebuggers` 注入和 `orbit.rtosViewsAutoRefresh` 设置）。

RTOS 面板分为三个顶层视图：

1. **Tasks & Objects（FreeRTOS 内核快照）**：仅需带完整 DWARF 调试信息的 FreeRTOS ELF，无需修改业务代码。从真实 DWARF 类型图自动推导结构体偏移，展示：
   - **任务**：状态、优先级（含互斥锁优先级继承标注）、列表发现证据、按需栈高水位扫描（超 85% 高亮）与双帧差分 CPU%；
   - **队列与锁**：从 `xQueueRegistry`、ELF 全局句柄和阻塞任务等待链发现 Queue / Mutex / Recursive Mutex / Semaphore，支持持有者、递归层级与**候选死锁等待环**检测；
   - **定时器与堆**：Software Timers 列表及 `heap_4` 容量、当前剩余、历史最低剩余与分配/释放统计。
   - 面板顶部会标明快照一致性等级（`halted-consistent`、`live-best-effort`、`partial`、`stale`）；配置 `launch.json` 中的 `rtosSnapshotPort` 可显式提供栈增长方向、填充字节与运行时间计数器频率。
2. **Trace Timeline（SEGGER SystemView 泳道）**：固件接入 SEGGER SystemView 并提供独立 `SysView` RTT 通道后，支持 **Continuous（流式）**、**Single-Shot（单次）** 和 **Post-Mortem（回卷）** 三种录制模式、任务/中断分层泳道、A/B 游标以及与**变量 TIMELINE 跨面板时间联动**（支持实时同会话联动及离线单点 A / 双点 A+B 手动对齐）。
3. **Contexts & Events（统计、事件流与归档）**：提供 CPU Load 分箱图（点击分箱直接下钻到泳道）、任务/ISR 独占与包含耗时及 Ready 延迟统计、自定义 Markers、百万级分页事件与 FreeRTOS API 参数解码、Trace 终端；支持将录制保存为 **`orbit-trace-v1` 归档目录**离线回放，并支持导出 **`.bin` 原始流**和 **39 列 `.csv`**（不支持 `.SVDat`）。

固件接入步骤、`FreeRTOSConfig.h` 宏对照、`rtosSnapshotPort` 写法、SystemView 配置与故障排查请查看完整的 [RTOS 诊断功能使用教程](RTOS诊断功能使用教程.md)。

## 9. Memory View

Memory View 同样由外部扩展（`mcu-debug.memory-view`）提供。Orbit 已实现标准 DAP 内存读写接口（单次读取上限 1 MiB）并为有地址的变量提供跳转支持。

如果 Memory View 没有自动识别 Orbit 会话，可执行 `Orbit: Enable MCU Debug Views Integration`，或在工作区设置中添加：

```json
{
  "memory-view.trackDebuggers": ["orbit", "ozone"]
}
```

## 10. Peripheral Viewer

Peripheral Viewer 使用 CMSIS-SVD 文件渲染外设寄存器树。Orbit 会按以下优先级自动解析并提供 SVD 文件：

1. `launch.json` 中显式填写的 `svdFile` 或 `svdPath`；
2. 工作区设置 `orbit.defaultSvdFile`；
3. 工程目录下与芯片型号匹配的 `.svd` 文件（如 `STM32F407.svd`）；
4. 本机 Keil Pack 目录（`CMSIS_PACK_ROOT` 或 `%LOCALAPPDATA%\Arm\Packs`）中已安装的对应系列 SVD；
5. Orbit 扩展全局缓存中的 SVD；
6. 当本地均找不到且 `orbit.svdAutoDownload` 为 `true`（默认）时，Orbit 会先正常启动调试，同时在后台自动下载对应系列的 Keil Device Family Pack 并只提取当前芯片的 SVD 缓存下来，下一次启动调试即可直接使用。

如果需要完全离线环境或固定 SVD 版本，可将 `orbit.svdAutoDownload` 设为 `false` 并显式指定 `svdFile`。

## 11. 调试通道与调度机制

### 11.1 单连接架构

为了避免多工具同时抢占探针导致掉线或状态错乱，Orbit 严格保证**每个调试会话只持有唯一一个目标连接**：

- **J-Link 原生通道**（`orbit-jlink-helper.exe`）：独立进程加载 `JLink_x64.dll`，支持源码级单步（`stepInto` / `stepOver` / `stepOut`）、批量读取和优先级调度。
- **J-Link Legacy 通道**（`koffi`）：仅在原生通道初始化失败（或显式设为 `legacy`）时作为备用，不支持原生源码级单步。
- **CMSIS-DAP 通道**（`orbit-cmsis-dap-helper.exe`）：独立进程处理 HID / WinUSB / TCP 通信、SWD、硬件断点（FPB）、烧录和内存型 RTT。
- **RMLink 通道**：通过 `@rmlink/client` 与 RMLink 服务通信，复用同一条连接完成控制、烧录、订阅和 RTT。

无论是 Watch、Timeline、RTT、外部 Viewer 还是 MCP 自动化请求，在调试运行期间全部复用这同一个连接，不会额外打开第二条调试链路。

### 11.2 任务优先级调度

所有探针访问按以下四级优先级串行调度：

```text
control（控制） > watch（变量刷新） > timeline（波形采样） > background（RTT / 后台刷新）
```

单步、暂停、继续、复位、断点修改、变量写入和烧录属于最高优先级 `control`，执行期间会暂停低优先级采样并在结束后自动恢复，确保调试操作永远跟手；Watch 读取会在每个表达式分片之间让出间隙，避免长时间饿死 Timeline。

## 12. MCP 与 Plugin API

### 12.1 Automation API v1

在工作区设置中开启 `"orbit.automation.enabled": true` 并重载窗口后，Orbit 会在本机回环地址 `127.0.0.1` 启动独立的 JSON-RPC 2.0 + SSE 自动化服务（带 Bearer Token 鉴权），方便 Python、Node.js 脚本或 AI 工具操作调试器。

为了安全起见，Automation API 默认关闭；开启后 `orbit.automation.allowedScopes` 默认也只授予 `["read"]` 只读权限，如需执行暂停/单步、修改断点、录波、写变量或烧录，需要在工作区设置中手动勾选对应权限。

客户端通过 `%LOCALAPPDATA%\Orbit\automation\registries.json`（可通过环境变量 `ORBIT_AUTOMATION_REGISTRY` 覆盖）发现运行中的 VS Code 窗口；如果同时打开了多个同一工程的窗口，调用时需指定具体的 `instanceId`。详细接口定义见 [Automation API 文档](../../docs/api/orbit-automation-api.md)。

### 12.2 MCP Server

仓库中提供了开箱即用的 stdio MCP 适配器 `Releases/mcp/orbit-mcp-server.js`（以及兼容旧名的 `ozone-mcp-server.js`），使 Claude Code、Codex、OpenCode、Cursor 等支持 MCP 的 AI 客户端可以直接连接并控制 Orbit：

- **主要工具**：`orbit_instances`、`orbit_handshake`、`orbit_project_describe`、`orbit_session_*`、`orbit_target_*`、`orbit_breakpoints_*`、`orbit_memory_*`、`orbit_expression_evaluate`、`orbit_diagnostics_snapshot`，RTOS 与 SystemView Trace 工具 `orbit_rtos_capabilities`、`orbit_rtos_snapshot`、`orbit_trace_list`、`orbit_trace_status`、`orbit_trace_start`、`orbit_trace_stop`、`orbit_trace_events`、`orbit_trace_statistics`，以及便捷组合工具 `orbit_status`、`orbit_read_many`、`orbit_write_many`、`orbit_record`、`orbit_experiment_run`。
- **RTOS / Trace 权限**：查询 RTOS 能力/快照以及读取当前录制或已在 RTOS 面板打开的离线归档只需 `read` 权限；通过 `orbit_trace_start` / `orbit_trace_stop` 启停目标录制需要同时授予 `record` 与 `rtt.control`。
- **录波与实验限制**：单次 `orbit_record` 最多支持 64 个通道，采样间隔 `5..10000 ms`（默认 `10 ms`），单份缓存最多保留 `50000` 帧；`orbit_experiment_run` 单次最多编排 64 步（支持 `read` / `write` / `wait` / `record`），支持通过 `min` / `max` 配置写入安全边界。

## 13. 常见问题

### Q1：提示 `Failed to load JLink DLL` 或 `JLinkDllLoadFailed`
确认已安装 SEGGER J-Link 软件包且 `JLink_x64.dll` 存在。如果安装在了非默认路径，请在设置中填写 `orbit.jlinkDllPath`，然后查看 `outputs/Log/dll.log` 检查具体加载路径和报错。

### Q2：调试能连上，但启动自动烧录失败
- 使用 J-Link 时，连接走 `JLink_x64.dll` 而烧录默认调用 `JLink.exe`，请检查 `orbit.jlinkPath` 是否正确。
- 使用 CMSIS-DAP / RMLink 时，请确认 `device` 与芯片型号一致。如果芯片里已经有固件，只想直接调试，在 `launch.json` 加上 `"flashBeforeDebug": false` 即可。

### Q3：提示找不到 ELF/AXF 文件
Orbit 默认只自动扫描 `build/Debug`、`build/Release` 和 `build` 目录。如果固件在其他位置（比如 Keil `MDK-ARM/Objects/`），请在 `launch.json` 中手动填写 `"program"` 字段。

### Q4：Watch 显示 `Running...`，或者 Timeline 没波形
- Timeline 在 MCU 处于暂停状态时不会采集新数据点，请先按 F5 让程序跑起来；另外请检查 Timeline 顶部对应调试分组左侧的**采样复选框**是否已经勾选。
- 若仍无数据，可检查表达式是否为全局变量/简单结构体成员，并在 `outputs/Log/dap.log` 中查看采样计划是否正常生成。

### Q5：RTT 终端没有输出
1. 确认固件已经调用过 `SEGGER_RTT_Init()` 或打印过日志；
2. 检查 `rttBufferIndex` 是否与固件使用的通道一致（通常为 0）；
3. 使用 CMSIS-DAP / RMLink 时确认 ELF 中包含 `_SEGGER_RTT` 符号（或手动指定 `rttControlBlockAddress`）；
4. 注意默认输出在终端面板的 `Orbit RTT Log` 中，而不是 Debug Console。

### Q6：P-RTLog 输出 `unknown token` 或找不到数据库
确认当前 `program` 指向的 ELF 文件中包含 `.pw_tokenizer.entries` 段，并与板子上正在运行的固件一致，同时已开启 `"rttLogEnabled": true` 和 `"pRtLogEnabled": true`。

### Q7：Memory View 或 Peripheral Viewer 没有显示内容
确认已安装对应外部扩展，在命令面板执行 `Orbit: Enable MCU Debug Views Integration` 后重新加载窗口；使用 Peripheral Viewer 时检查 `outputs/Log/dap.log` 中的 `[svd]` 日志确认 SVD 是否加载成功。

### Q8：配置了 `interface: "JTAG"` 但依然走了 SWD
J-Link Legacy 引擎当前固定使用 SWD；需要使用 JTAG 请确认 `orbit.nativeDebugEngine.mode` 为 `"auto"` 或 `"native"`，不要设为 `"legacy"`。

### Q9：MCP 客户端提示找不到调试实例或读写报错
1. 确认已在 VS Code 中打开工作区、设置了 `"orbit.automation.enabled": true` 并重新加载窗口；
2. 修改变量或控制调试器前，确认已在 `orbit.automation.allowedScopes` 中添加了对应权限；
3. 确保目标变量存在于当前 ELF 符号表中（局部变量仅在停在对应作用域时可访问）。

### Q10：RTOS 面板提示 `DwarfUnavailable` / `RtosNotDetected` 或探测不到 `SysView` 通道
1. 确认编译选项开启 `-g`/`-g3` 且 `program` 指向未经 `strip` 的 ELF，并已在 `launch.json` 填写准确 `device`；
2. 栈水位和 CPU% 不可用时，检查 `FreeRTOSConfig.h` 宏与 `launch.json` 中的 `rtosSnapshotPort` 配置；
3. 探测 SystemView 通道前，需先从 `main` 入口断点继续运行让固件执行完 `SEGGER_SYSVIEW_Conf()`，且 Continuous 模式不要在固件启动时主动调用 `SEGGER_SYSVIEW_Start()`。完整排查见 [RTOS 诊断功能使用教程](RTOS诊断功能使用教程.md#11-常见错误码与问题排查速查表)。

## 14. 已知限制

- **平台限制**：目前仅支持 Windows x64，暂不支持 macOS 与 Linux。
- **烧录芯片支持范围**。J-Link 的覆盖取决于 SEGGER 器件库。CMSIS-DAP 和 RMLink 优先使用已登记型号的快速算法，其余受支持的 STM32 可由内置 OpenOCD 烧录。
- **硬件断点数量**：J-Link 最多使用 6 个硬件断点槽位；CMSIS-DAP 根据芯片 FPB 比较器数量动态判断，槽位用满后新增断点会提示失败。
- **单步与接口限制**：J-Link Legacy 模式不支持源码级单步（`stepInto`/`stepOver`/`stepOut`）与 JTAG 接口，建议保持默认的原生 helper 模式。
- **采样频率**：`orbit.timelineSampleIntervalMs`（默认 `0.2 ms`）是期望周期而非硬实时保证，实际采样率取决于探针通信速率、通道数、指针深度和并发 Watch/RTT 负载。
- **内置 RTOS 诊断范围**：目前面向单核 ARM Cortex-M FreeRTOS；SystemView 归档与导出采用 `orbit-trace-v1` 目录、`.bin` 与 `.csv`，暂不支持 `.SVDat` 导入导出。
- **部分 DAP 高级特性未支持**：当前暂不支持条件断点（Conditional Breakpoint）、数据断点（Watchpoint）、Logpoint、反向单步（Step Back）以及反汇编视图（Disassemble）。

## 15. 开源许可与第三方组件

- **Orbit 扩展主体**：采用 [MIT License](../../LICENSE) 开源。
- **随扩展分发的 OpenOCD Windows 运行时**：`out/openocd/` 源自未经修改的上游 OpenOCD `0.12.0+dev-g6fbe9e7` 构建（固定提交 `6fbe9e772476ce55c634cb0e8cd14244588ee9e2`），Orbit 仅在独立的烧录阶段通过子进程按需调用，不与 GPL 代码链接。OpenOCD 及其脚本遵循 **GNU GPL-2.0-or-later**，附带的 `libjaylink`、`libftdi1`、`libusb-1.0`、`hidapi` 等动态库遵循各自的开源协议（GPL-2.0-or-later / LGPL-2.1 / BSD / MIT 等），且均不提供任何明示或默示担保。
- **完整许可文本与源码获取要约**：请查阅扩展目录下的 [resources/openocd/README.md](../../resources/openocd/README.md)、[resources/openocd/COPYING](../../resources/openocd/COPYING)、[resources/openocd/LICENSES/preferred/GPL-2.0](../../resources/openocd/LICENSES/preferred/GPL-2.0) 及 [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md)（含 GPL v2 第 3(b) 条三年有效书面源码要约）。
