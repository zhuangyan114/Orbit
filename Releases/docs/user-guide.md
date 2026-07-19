# Orbit — 用户使用与配置指南

> 版本：1.0.0 文档
>
> 本文按当前仓库源码、`package.json` 的贡献点和 Native helper 实现整理。配置名、默认值、范围和单位均以源码为准；外部扩展的具体版本和 UI 由外部扩展决定。

## 目录

- [1. 安装和系统要求](#1-安装和系统要求)
- [2. J-Link DLL 与烧录工具](#2-j-link-dll-与烧录工具)
- [3. launch.json](#3-launchjson)
- [4. Watch](#4-watch)
- [5. Timeline](#5-timeline)
- [6. RTT](#6-rtt)
- [7. P-RTLog](#7-p-rtlog)
- [8. RTOS Views](#8-rtos-views)
- [9. Memory View](#9-memory-view)
- [10. Peripheral Viewer](#10-peripheral-viewer)
- [11. Native / Legacy 调试通道](#11-native--legacy-调试通道)
- [12. MCP 与 Plugin API](#12-mcp-与-plugin-api)
- [13. 常见问题](#13-常见问题)
- [14. 已知限制](#14-已知限制)

## 1. 安装和系统要求

### 1.1 使用发行版安装

正式发布资产放在 [GitHub Releases](https://github.com/zhuangyan114/Orbit/releases)。安装 VSIX 的标准流程是：

1. 下载对应版本的 `.vsix`。
2. 在 VS Code 中打开命令面板，执行 `Extensions: Install from VSIX...`。
3. 选择 VSIX，安装完成后重新加载窗口。
4. 打开包含 ELF/AXF 固件的工作区，再使用 `type: "ozone"` 的调试配置。

当前仓库的发布计划还会把 MCP server 和 SKILL 作为 Releases 资产提供；它们不是 VSIX 内的 DAP 协议替代品，详见 [MCP 与 Plugin API](#12-mcp-与-plugin-api)。

### 1.2 运行时要求

| 项目 | 源码依据和要求 |
| --- | --- |
| 操作系统 | Native helper 的 CMake 配置明确要求 Windows；Native 发布目标为 `win32-x64`。当前产品应按 Windows 环境准备。 |
| VS Code | `package.json` 声明 `engines.vscode: ^1.90.0`，即 VS Code 1.90.0 以上且仍在 1.x 主版本范围内。 |
| 目标 | 产品定位为 STM32 / ARM Cortex-M；目标设备名必须能被 J-Link DLL 识别。 |
| 调试器 | 需要已安装、已连接的 SEGGER J-Link probe，并准备相应 J-Link 软件包和 `JLink_x64.dll`。 |
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

## 2. J-Link DLL 与烧录工具

### 2.1 DLL 的作用

F5/Run and Debug 的 `ozone` DAP 路径直接使用 J-Link DLL 访问目标。它不需要通过 OpenOCD、GDB server 或 Ozone GUI 来承接常规 DAP 控制。

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

没有 `program`，或显式设置 `flashBeforeDebug: false` 时，不会因为 DAP 连接本身而调用 `JLink.exe`。J-Link DLL 仍然是调试连接的必需品。

## 3. `launch.json`

### 3.1 最小配置

下面的配置使用源码中公开的 `ozone` debugger schema：

```jsonc
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Orbit: Debug STM32",
      "type": "ozone",
      "request": "launch",
      "program": "${workspaceFolder}/build/Debug/frame.elf",
      "device": "STM32F407IG",
      "interface": "SWD",
      "speedKHz": 4000,
      "nativeDebugEngineMode": "auto"
    }
  ]
}
```

### 3.2 默认值和 launch 属性

以下是 `package.json` 的 launch schema 以及 DAP 源码实际读取的值：

| 属性 | 类型 / 单位 | 默认值 | 作用 |
| --- | --- | --- | --- |
| `device` | string | `STM32F407VG` | J-Link 目标设备名。 |
| `deviceName` | string | `STM32F407VG` | `device` 的外部 MCU Debug Views 兼容别名；未填写时由 `device` 补齐。 |
| `program` | path | `${workspaceFolder}/build/Debug/frame.elf` | ELF/AXF 路径；用于可选烧录、符号和 DWARF。 |
| `svdFile` | path | `""` | 提供给外部 Peripheral Viewer 的 CMSIS-SVD 路径。 |
 | `svdPath` | path | `""` | `svdFile` 的兼容别名；未填写时跟随 `svdFile` 或 `orbit.defaultSvdFile`。 |
| `interface` | `SWD` / `JTAG` | `SWD` | J-Link 接口。Native 连接会按该值选择接口；Legacy 当前源码固定选择 SWD，见限制。 |
| `speedKHz` | number，kHz | `4000` | J-Link 接口速度。 |
| `rtos` | string | `""` | 传给 DAP capability/外部 RTOS Views 的 RTOS 名称，例如 `FreeRTOS`。 |
| `rttLogEnabled` | boolean | `true` | 启动后读取 SEGGER RTT。 |
| `rttBufferIndex` | number，up-buffer index | `0`，限制为 `0..15` | RTT 上行缓冲区索引。 |
| `rttPollIntervalMs` | number，ms | `50`，限制为 `10..5000` | RTT 轮询周期。 |
| `rttReadSize` | number，bytes/poll | `4096`，限制为 `64..65536` | 每次 RTT 读取的最大字节数。 |
| `rttControlBlockAddress` | number 或 string，地址 | `""` | RTT control block 地址；空值交给 J-Link 自动检测，正数可写成十进制或 `0x` 形式。 |
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

DAP 源码还接受下列兼容输入，但它们没有全部出现在 `package.json` 的 launch schema 中：

| 输入 | 默认值 | 当前行为 |
| --- | --- | --- |
| `elfPath` | `""` | `program` 为空时作为 ELF 路径别名。 |
| `defaultRtos` | `""` | `rtos` 为空时作为 RTOS 名称别名。 |
| `flashBeforeDebug` | `true` | 有 ELF 时默认先调用 JLink.exe 烧录；设为 `false` 可跳过烧录。它是源码读取的 launch 字段，不是当前 package schema 中的独立配置项。 |

### 3.4 `ozone.*` 工作区设置

这些设置可以在 VS Code Settings JSON 中使用；设置前缀仍是源码中的 `ozone`，与 Orbit 的产品品牌名称无关。

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
- 写入通过活动 `ozone` DAP session 的 `setWatchValue` 完成；写入后会清理对应运行时缓存并重新读取。
- 叶子表达式可以发送到 Timeline；值变化会短暂高亮，源码中的高亮窗口是 500 ms。

### 4.2 状态保存和路由

Watch 表达式保存为 workspace state 的 `ozoneWatchExpressions`，展开节点保存为 `ozoneWatchExpandedExpressions`。切换视图或重新创建 Webview 后，表达式和展开状态会恢复。

如果存在活动的 `ozone` DAP session，Watch 读取和写入都通过该 session 路由；不会为同一目标再打开一个 Extension Host owner。没有活动 DAP session 时，扩展侧 Watch provider 才会使用其后端路径。

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
- 活动 DAP session 使用 Native/Legacy 选定 owner 的快速采样路径；控制和 Watch 读取优先于 Timeline。
- 不是每个表达式都能进入快速采样计划。无法解析为当前快速采样格式的表达式会被计划拒绝，不应把它当作“曲线为零”。
- `orbit.timelineSampleIntervalMs` 是目标采样目标，不是硬件保证的实际采样频率。
- `orbit.timelineSendIntervalMs` 只控制发送到 Webview 的节奏，不等于目标采样间隔。

## 6. RTT

### 6.1 启动和输出

`rttLogEnabled` 默认为 `true`。DAP launch 在目标连接并初次 halt 后开始 RTT 轮询，断开或会话结束时停止。读取使用当前 session 选定的 Native 或 Legacy owner。

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
| `rttControlBlockAddress` | 空 | 正的 32-bit 地址；空值由 J-Link 自动检测 |
| `rttStripAnsi` | `true` | 只影响 Debug Console |
| `rttLogTarget` | `terminal` | `terminal`、`debugConsole` 或 `both` |

RTT 需要目标固件已经初始化 SEGGER RTT control block，并且当前 J-Link DLL 导出 RTT control/read 函数。RTT 不会替目标固件自动插入 RTT 初始化代码。

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
  "type": "ozone",
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

RTOS Views 由外部扩展提供。Orbit 激活时会尝试把 `ozone` 加入以下设置数组：

```jsonc
{
  "memory-view.trackDebuggers": ["ozone"],
  "mcu-debug.rtos-views.trackDebuggers": ["ozone"],
  "mcu-debug.debug-tracker-vscode.trackDebuggers": ["ozone"]
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
- `trackDebuggers` 包含 `ozone`；
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

若 Memory View 没有列出 `ozone`，执行集成命令，或在工作区设置中加入：

```json
{
  "memory-view.trackDebuggers": ["ozone"]
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

## 11. Native / Legacy 调试通道

### 11.1 两条通道

| 通道 | 实现 | 特点 |
| --- | --- | --- |
| Native | 独立的 `orbit-jlink-helper.exe`，通过 JSON-lines 与 DAP 侧通信；helper 内加载 J-Link DLL | 拥有 Native source-level step into/over/out、批量内存读取和 NativeScheduler；目标为 Windows x64。 |
| Legacy | Node 进程中的 `koffi` 直接加载 `JLink_x64.dll` | 保留现有调试和 DAP 兼容路径；Native source-level step API 在该 owner 上不可用。 |

### 11.2 owner 选择

当前每个 DAP session 由 `SessionTargetSelector` 选择且只持有一个物理 owner：

- `nativeDebugEngineMode: "legacy"`：只建立 Legacy owner；
- `nativeDebugEngineMode: "native"`：只尝试 Native，Native 初始化失败即失败，不回退；
- `nativeDebugEngineMode: "auto"` 且 `nativeDebugEngineEnabled: true`：先尝试 Native，只有 Native 启动/初始化失败且尚未建立目标连接时才创建 Legacy owner；
- `nativeDebugEngineMode: "auto"` 且 `nativeDebugEngineEnabled: false`：走 Legacy；
- Native owner 已连接后发生 `NativeOwnerLost`：当前 session 终止，重新启动时再选择通道，不在原 session 热切换。

选择 Native owner 后，`stepInto`、`stepOver` 和 `stepOut` 都强制走 Native source-level stepping；选择 Legacy owner 时三种单步都走 Legacy 路径。

### 11.3 访问调度

NativeScheduler 的优先级为：

```text
control  >  watch  >  timeline
```

继续、暂停、复位、断点、单步和变量/内存写入属于 control；Watch 和 Timeline 目标读属于低优先级读取。调试会话运行时，活动 DAP 请求沿已选 owner 路由，Extension Host 不会再作为第二个物理 owner 接管目标。

## 12. MCP 与 Plugin API

### 12.1 Plugin API

Extension Host 激活时启动一个随机端口的本机 HTTP server：

- host：`127.0.0.1`；
- `GET /health`：返回 ready 状态；
- `POST /rpc`：需要 `Authorization: Bearer <token>`；
- 请求体最大 `1 MiB`；
- endpoint 文件名：`plugin-api-endpoint.json`；
- 文件写入 VS Code extension global storage；
- API 停止时随扩展释放。

当前 JSON-RPC 方法：

| 方法 | 能力 |
| --- | --- |
| `ozone.status` | 返回目标状态。 |
| `ozone.target.getState` | 返回目标状态。 |
| `ozone.expr.readMany` | 批量读取表达式或带 alias/unit/role 的 signal。 |
| `ozone.expr.writeMany` | 按表达式写入有限数值，可带 address/typeName 元数据。 |
| `ozone.record.start` / `stop` / `get` / `clear` | 录制、停止、读取和清理波形。 |
| `ozone.experiment.run` | 执行 read / write / wait / record 步骤，可配置 baseline 和 min/max safety。 |

若活动 `ozone` DAP session 存在，RuntimeRouter 将读写和目标状态请求发送到该 DAP session；DAP 请求失败会作为该操作的错误返回，不会回退到 Extension Host 的另一条目标连接。

### 12.2 MCP server

源码 MCP server 是 stdio 进程 `Releases/mcp/orbit-mcp-server.js`，它读取 endpoint 文件，再调用上面的本机 Plugin API。当前注册工具：

- `ozone_status`；
- `ozone_read_many`；
- `ozone_write_many`；
- `ozone_record`；
- `ozone_experiment_run`。

Windows 下未设置环境变量时，endpoint 默认路径为：

```text
%APPDATA%\Code\User\globalStorage\orbit-debug.orbit-for-vscode\plugin-api-endpoint.json
```

也可以显式设置：

```text
OZONE_PLUGIN_API_ENDPOINT_FILE=<endpoint 文件绝对路径>
```

### 12.3 MCP 数值、录波和实验边界

| 项目 | 源码限制 |
| --- | --- |
| 写入值 | 必须是 finite number；可选 address 必须是 `0..0xFFFFFFFF` 的 32-bit unsigned integer。 |
| 单次录波通道 | 至少 1 个，最多 64 个；alias 不能重复。 |
| 录波间隔 | 默认 `10 ms`，最终限制到 `5..10000 ms` 并取整数毫秒。 |
| 录波帧数 | 每个 recording 最多保留 `50000` 帧，超出时丢弃最旧帧。 |
| 录波时长 | `ExperimentService` 的 record step 最多 `60000 ms`。直接 `ozone_record` 的时长由调用参数提供，MCP wrapper 会等待结束后读取并清理 recording。 |
| wait 时长 | `0..60000 ms`，取整数毫秒。 |
| 实验步骤 | 最多 64 步，类型为 `read`、`write`、`wait`、`record`。 |
| safety | 对匹配 expression 的写入执行可选 `min` / `max` 检查。 |

MCP 可以写入目标变量，因此应先用只读状态/读取确认表达式和目标状态，再进行带边界的写入。`unit`、`role`、`writable` 是 signal 元数据，不会替 Orbit 猜测目标变量的真实单位或安全范围。

## 13. 常见问题

### Q1：报 `Failed to load JLink DLL` 或 `JLinkDllLoadFailed`。

先确认 J-Link 软件已安装，并确认 `JLink_x64.dll` 存在。需要固定版本时设置 `orbit.jlinkDllPath`。然后查看 `outputs/Log/dll.log`，确认加载路径、DLL 版本和缺失导出符号。

### Q2：调试连接正常，但自动烧录失败。

调试连接使用 DLL，自动烧录使用 `JLink.exe`。确认 `orbit.jlinkPath` 指向真实的 Commander 可执行文件；如果固件已经烧录，可在 launch 中设置 `flashBeforeDebug: false` 跳过烧录。`program` 仍用于符号加载。

### Q3：没有找到 ELF/AXF。

设置 `program` 或 `orbit.defaultProgram`。未设置时只会检查 `build/Debug`、`build/Release`、`build`，且只匹配 `.elf` / `.axf`。

### Q4：Watch 显示 `Running...`，或者 Timeline 没有数据。

Watch 和 Timeline 都依赖当前 DAP session 的目标状态。Timeline 在目标停止时不生成采样点；表达式还必须能进入快速采样计划。减少通道数、确认目标确实在运行，并查看 `outputs/Log/dap.log` 中的读取和 Timeline 计划日志。

### Q5：RTT 没有输出。

确认 `rttLogEnabled` 为 `true`、固件已初始化 RTT、up-buffer index 正确、J-Link DLL 提供 RTT 导出。必要时设置 `rttControlBlockAddress`。如果使用 `debugConsole`，注意 `rttLogTarget` 默认不是 `debugConsole`，而是 `terminal`。

### Q6：P-RTLog 输出 unknown token 或 token database not found。

确认当前 launch 的 `program` 是包含 `.pw_tokenizer.entries` 的 ELF，并同时设置 `rttLogEnabled: true` 与 `pRtLogEnabled: true`。当前 decoder 不从 `pRtLogRoot` 目录查找 token 数据；unknown token 会保留原始 token 和帧数据用于诊断。

### Q7：RTOS Views、Memory View 或 Peripheral Viewer 没有跟踪到 Orbit。

确认外部扩展已安装，并检查对应的 `trackDebuggers` 数组是否包含 `ozone`。可以执行 MCU Debug Views 集成命令后 Reload Window。Peripheral Viewer 还需要有效 `svdFile` / `svdPath`；RTOS Views 还需要外部扩展能解析当前 ELF、RTOS 和目标状态。

### Q8：`nativeDebugEngineMode: "auto"` 为什么变成 Legacy？

`auto` 只在 Native 启动/初始化失败时回退 Legacy。查看 `outputs/Log/dll.log` 和 `outputs/Log/dap.log`；如果 Native owner 已连接后丢失，不会在原 session 中热切换，必须重新启动调试。

### Q9：配置写了 `interface: "JTAG"`，行为与预期不同。

Native helper 会按 `JTAG` 选择 JTAG；Legacy 当前 `JLinkDLL.connect()` 源码固定调用 `TIF_Select(SWD)`。请先使用 Native，并把该行为作为当前版本限制处理。

### Q10：MCP 找不到 endpoint 文件。

先启动 VS Code 并激活 Orbit；endpoint 文件只有在 Extension Host 启动 Plugin API 后才会生成。确认 MCP 与 VS Code 使用同一用户配置目录，或设置 `OZONE_PLUGIN_API_ENDPOINT_FILE` 指向实际的 `plugin-api-endpoint.json`。

### Q11：MCP 读取/写入失败，但 VS Code 中调试已启动。

确认活动 session 的类型是 `ozone`，目标状态为 `running` 或 `halted`，并使用 ELF/DWARF 中实际存在的表达式。活动 DAP session 存在时 MCP 不会绕过它建立第二条目标连接。

## 14. 已知限制

### 当前实现限制

- Native helper 和当前 J-Link DLL 集成是 Windows 目标；仓库没有把 Linux/macOS 作为当前 Native 运行目标。
- `J-Link` 设备支持列表由已安装的 J-Link 软件/DLL 决定，源码没有内置完整 MCU 清单。
- `interface` schema 接受 `SWD` 和 `JTAG`，但 Legacy DLL 连接实现当前固定选择 SWD；JTAG 应使用 Native 并单独确认硬件。
- 每个 session 的硬件断点槽位固定为 6 个；槽位耗尽时新断点无法建立。
- Native source-level step into/over/out 只属于 Native owner；Legacy 不能把普通单步宣传为 Native source-level stepping。
- Timeline 的 `0.2 ms` 是目标间隔，不是硬件实时采样保证；目标读取延迟、表达式数量、控制操作和 Watch 会降低实际频率。
- Timeline 只保留约 10 分钟历史，且停止期间不回填数据。
- 快速 Timeline 只接受当前源码能解析的表达式；不支持的表达式会被采样计划拒绝。
- RTOS Views、Memory View 和 Peripheral Viewer 不随 Orbit 的源码自动获得全部功能；它们需要外部扩展、正确的 tracking 配置和与当前固件匹配的 ELF/SVD。
- Orbit 不解析 SVD，也不内置 RTOS kernel 解析器。
- P-RTLog token 必须在当前 ELF 的 `.pw_tokenizer.entries` 中；`pRtLogRoot` 当前不是 token 搜索路径。

### 当前 DAP capability 中明确未提供的功能

源码的 `initialize` 响应明确关闭或不支持：conditional breakpoint、hit conditional breakpoint、step back、set variable、restart frame、goto targets、step-in targets、completions、exception options、terminate debuggee、log points、data breakpoints、disassemble、cancel、breakpoint locations、stepping granularity 和 instruction breakpoints。读写 memory、evaluate for hovers、restart request 和 RTOS capability 则明确声明支持。

### 发布/品牌确认边界

Orbit 改名已覆盖扩展元数据、用户可见命令和视图标题、输出通道、图标、MCP 展示文案以及 Native helper 产物。`ozone` 前缀的 DAP 类型、配置键、外部视图 tracking 值、workspace state 键和 MCP 方法仍作为兼容标识保留。
