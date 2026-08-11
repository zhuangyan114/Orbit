# Orbit CMSIS-DAP / DAPLink 支持项目计划

- **状态**: 已完成并通过用户最终验收
- **版本**: v1.0
- **日期**: 2026-08-11
- **适用项目**: Orbit for VS Code
- **目标**: 在保留 J-Link 链路的前提下，新增 CMSIS-DAP / DAPLink 调试链路

## 最终验收结论

用户于 2026-08-11 确认本计划的有线 CMSIS-DAP/DAPLink 发布范围全部通过。实现已覆盖 CMSIS-DAP v1 HID 与 v2 WinUSB、唯一 CMSIS-DAP native helper owner、默认烧录与显式跳过烧录、DP/AP 和内存访问、基本/源码级调试、Watch、Timeline、内存型 RTT、RTOS View、MemoryView、Peripheral Viewer，以及 J-Link 回归、会话替换和清理。当前真实 CMSIS-DAP 功能/性能验收设备为 v1 HID；v2 WinUSB 只有代码、Mock、自测和构建证据，尚无 bulk 真机证据。

各阶段的代码、Mock、自动化、真机和性能证据仍以独立报告为准，不用本页的最终状态替代原始证据：

| 计划阶段 | 最终状态 | 主要证据 |
|---|---|---|
| DAP-00 ～ DAP-04 | 通过 | [硬件矩阵](daplink-hardware-matrix.md)、[Flash Algorithm 参考](cmsis-dap-flash-algorithm-references.md)、[启动速度优化](cmsis-dap-flash-startup-speed-optimization.md)、[WinUSB 报告](cmsis-dap-v2-winusb-report.md) |
| DAP-05 | 通过 | [硬件断点与源码级 Step 验收](dap05-acceptance-report.md) |
| DAP-06 | 通过 | [Watch 验收交接](dap06-watch-ai-acceptance-handoff.md) |
| DAP-07 | 通过 | [Timeline 性能报告](dap07-timeline-performance-report.md) |
| DAP-08 | 通过 | [RTT 验收报告](dap08-rtt-acceptance-report.md) |
| DAP-09 | 通过 | [RTOS View 验收报告](dap09-rtos-view-acceptance-report.md) |
| DAP-10 | 通过 | [MemoryView 运行态验收](dap06a-memoryview-runtime-acceptance-report.md) |
| DAP-11 | 通过 | [Peripheral Viewer 双链路验收](dap10-peripheral-viewer-acceptance-report.md)（报告文件沿用实施时的 DAP-10 编号） |
| DAP-12 | 通过 | 本计划完成定义、上述分层证据和 2026-08-11 用户最终确认 |

无线或厂商私有 transport 仍按设备单独登记和验收；本结论不把有线 HID/WinUSB 的性能数字外推到尚未登记的无线设备。

## 0. 当前执行策略

本项目分为两个硬件阶段：

1. **第一阶段只使用有线 DAP-Link/CMSIS-DAP**，先完成协议、基础调试、Watch、Timeline、RTT 和三个 Viewer 的主链路；
2. **第二阶段再使用无线 DAPLink 测试**，验证同一套上层 owner/DAP/Watch/Timeline/RTT/Viewer 是否能适应无线延迟、抖动、丢包和设备私有 transport。

有线设备是第一版功能完成和发布的硬件门槛。无线设备测试属于后续兼容性和性能阶段，不得在无线设备尚未确定、协议尚未确认时阻塞有线主线，也不能用有线通过推断无线通过。

### 0.1 烧录策略

有线 CMSIS-DAP/DAPLink 调试会话默认执行烧录；用户可以在 launch 配置中显式关闭烧录，仅连接并调试目标板上已经存在的固件。

- `flashBeforeDebug` 缺省值为 `true`；
- `flashBeforeDebug: false` 时不得执行擦除、下载、校验或为了烧录而触发的额外 reset；
- 默认烧录流程必须在创建 CMSIS-DAP target owner 后执行，烧录、校验和调试连接不能各自创建第二个物理 owner；
- 第一阶段只要求使用 CMSIS-DAP 访问目标完成烧录，不要求兼容 OpenOCD、GDB Server 或厂商命令行烧录器；
- 芯片 Flash Algorithm、芯片型号识别、擦除策略、下载进度和校验属于独立的小目标，不能用“预烧录调试通过”替代默认烧录验收；
- J-Link 的默认烧录行为保持不变，`flashBeforeDebug` 的兼容语义不得破坏现有 J-Link launch 配置。

## 1. 项目目标

“DAPLink”通常指调试器固件或设备品牌；Orbit 需要适配的是它对主机提供的 **CMSIS-DAP 协议**。第一阶段以有线标准 CMSIS-DAP 为唯一主线；无线 DAPLink 的 VID/PID、USB 类别、固件版本和无线传输方式在第二阶段单独登记和适配。

最终验收目标按优先级排列如下：

| 编号 | 目标 | 优先级 | 目标定义 |
|---|---|---:|---|
| 0 | 基本调试功能正常 | P0 | 连接、暂停、运行、复位、寄存器、内存、断点、基本单步可用，且不破坏 J-Link |
| 1 | Watch 实时查看变量 | P0 | 目标运行时读取基本标量变量，暂停时读取局部/全局变量，保留现有 DAP/Watch 行为 |
| 2 | Timeline 看波形 | P1 | 复用 DAP `dataSample` 采样链路，允许降低频率，但不能阻塞控制操作或产生跨会话数据 |
| 3 | 获取 RTT 日志 | P1 | 通过 CMSIS-DAP 内存读写实现标准 SEGGER RTT 文本读取；高吞吐和无损不作为第一阶段承诺 |
| 4 | 三个 Viewer 正常运行 | P0/P1 | RTOS View、MemoryView、Peripheral Viewer 使用同一个活动 DAP owner，保留现有 DAP 合同 |

## 2. 成功标准和非目标

### 2.1 成功标准

本项目完成后，用户能够在 launch 配置中选择 CMSIS-DAP/DAPLink 调试器，并在同一条 Orbit DAP 会话中完成：

1. 对 Cortex-M 目标进行基本调试；
2. 查看正在运行的全局变量和静态变量；
3. 在 Timeline 中观察一个或多个变量的变化趋势；
4. 查看目标通过 SEGGER RTT 输出的日志；
5. 使用 RTOS View、MemoryView、Peripheral Viewer 读取目标信息；
6. 在 Watch、Timeline、RTT 运行时执行暂停、继续、单步、复位、断点和变量写入。

有线 CMSIS-DAP 的最小配置语义如下，未填写 `flashBeforeDebug` 时按默认值 `true` 处理：

```json
{
  "probe": "cmsis-dap",
  "cmsisDapTransport": "auto",
  "cmsisDapSerial": "optional",
  "flashBeforeDebug": true
}
```

用户需要调试目标板上已有固件时，显式设置 `"flashBeforeDebug": false`。跳过烧录只改变启动阶段，不改变后续基本调试能力。

### 2.2 非目标

以下内容不进入本项目第一版主路径：

- 不把 OpenOCD、GDB Server、Ozone GUI 或 `JLink.exe` 作为 Orbit 的常规调试控制后端；
- 不在同一 DAP session 中同时创建 J-Link owner 和 CMSIS-DAP owner；
- 不通过第二个调试进程绕过活动 DAP owner；
- 有线 MVP 不默认支持任意无线设备的 TCP、BLE 或厂商私有协议；
- 不承诺 CMSIS-DAP v1 HID 与无线链路达到 J-Link Native 的采样性能；
- 不把 SWO 自动等同于 SEGGER RTT；
- 不在没有用户明确授权时执行目标板 reset、run、halt、step、写内存或硬件验证命令；
- 不在未完成硬件验证时宣称“硬件通过”；
- 不手动编辑生成的 `dist/` 文件；
- 不自动更新 `docs/bug-fix-log.md`，该文件只在用户确认修复后记录问题历史。

## 3. 当前 Orbit 基线

### 3.1 现有 owner 和入口

当前调试会话的目标访问由 [SessionTargetOwner](../src/ozone-backend/session-target-channel.ts) 抽象，实际主要是：

- Native: 独立 `orbit-jlink-helper.exe`，内部加载 `JLink_x64.dll`；
- Legacy: Node 进程内通过 `koffi` 加载 `JLink_x64.dll`；
- [SessionTargetSelector](../src/ozone-backend/session-target-channel.ts) 负责选择唯一 owner；
- [debugadapter.ts](../src/debugadapter.ts) 创建 target selector、`OzoneBackend` 和 `DapSession`。

CMSIS-DAP 支持需要把现有 J-Link 专用命名逐步抽象为通用 target owner，同时保留 J-Link 兼容层。第一版可以采用兼容性扩展，避免一次性大规模重命名。

### 3.2 现有可复用链路

以下功能应优先复用，不为 DAPLink 单独复制一套 UI 或表达式系统：

```text
Watch webview / Timeline webview
        ↓
Watch provider / DataSamplingManager
        ↓
active ozone DAP session.customRequest()
        ↓
DapSession: evaluate / dataSample / variables / readMemory
        ↓
OzoneBackend
        ↓
SessionTargetOwner
        ↓
J-Link owner 或 CMSIS-DAP owner
```

重点复用对象：

- ELF/DWARF 符号和类型解析；
- `evaluate`、`variables`、`memoryReference` 和 base64 内存读写；
- Watch 表达式规范化、缓存、展开节点和分片读取；
- Timeline 数据点、颜色、历史保留、刷新和分段逻辑；
- `NativeScheduler` 的优先级和控制临界区；
- RTT 文本处理、ANSI 处理、P-RTLog 处理以及已经存在的 RTTB Timeline 解码器（如果该路径启用）。

## 4. 总体技术方向

### 4.1 推荐分层

OpenOCD 的 adapter/transport/target 分层可作为设计参考，但不引入 OpenOCD 运行时。Orbit 自己实现窄而明确的 CMSIS-DAP 适配层：

```text
CmsisDapTargetChannel
        ↓
CmsisDapCoreTarget
        ↓
ArmDebugPort / MemAP
        ↓
CmsisDapTransport
        ├─ CMSIS-DAP v2 WinUSB
        ├─ CMSIS-DAP v1 HID
        └─ 后续经确认的无线/厂商 transport
```

### 4.2 Native 边界

优先新增独立进程：

```text
orbit-cmsis-dap-helper.exe
```

推荐使用与 J-Link helper 相同的 JSON-lines RPC 形式。helper 负责：

- HID/WinUSB 设备枚举和句柄生命周期；
- CMSIS-DAP packet size、packet count 和 transport framing；
- CMSIS-DAP command request/response；
- DP/AP transfer 和批量 transfer；
- Cortex-M 寄存器、内存、暂停、运行、单步、复位和 FPB 断点；
- 结构化错误、超时、断线和 owner loss。

TypeScript 侧负责：

- owner 选择和生命周期；
- scheduler 优先级；
- DAP/Watch/Timeline/RTT 路由；
- 日志和用户可见错误；
- 现有 DWARF、表达式、Viewer 和 UI 兼容。

不建议首版使用 Node HID/N-API 直接把 native USB 状态放入 DAP adapter。独立 helper 可以隔离 USB 驱动和 native 崩溃，并与当前 J-Link Native 设计保持一致。

### 4.3 CMSIS-DAP 命令范围

第一版按以下顺序实现：

1. `DAP_Info`；
2. `DAP_Connect` / `DAP_Disconnect`；
3. `DAP_SWJ_Clock`；
4. `DAP_SWJ_Pins`（目标 reset 和连接状态需要时）；
5. `DAP_Transfer`；
6. `DAP_TransferBlock`；
7. `DAP_WriteABORT`、`DAP_TransferAbort`；
8. `DAP_ResetTarget`；
9. 可选 `DAP_SWO_*`，仅当设备能力明确报告支持时启用。

CMSIS-DAP v2 优先，v1 HID 作为兼容路径。具体无线设备是否能使用标准 CMSIS-DAP，需要以设备实际枚举结果和协议握手为准。

### 4.4 Cortex-M 控制范围

第一批目标以 Cortex-M3/M4、特别是 STM32F4 为基线：

- DP 初始化和 AP discovery；
- MEM-AP 的 CSW/TAR/DRW 访问；
- `DHCSR`：halt、run、single-step、状态读取；
- `DCRSR`/`DCRDR`：通用寄存器读取和写入；
- `xPSR`、PC、SP、LR 等寄存器映射；
- `AIRCR` 或 probe reset command；
- FPB comparator：硬件断点槽分配、清理和恢复；
- 可选 DWT/DEMCR 能力探测，不作为第一阶段硬门槛。

源码级 Step 的上层语义继续由 Orbit 控制，但底层执行必须使用 CMSIS-DAP/Cortex-M 原语，不得伪造 J-Link 结果。

## 5. 执行分解

每个小目标都必须先完成代码/Mock 验证，再进入自动构建，最后才进行经过授权的硬件验证。一个阶段没有通过，不得用后续阶段的通过替代。

### DAP-00：设备和硬件基线登记

**目的**: 先登记有线 DAP-Link/CMSIS-DAP 设备并建立主线基线；无线设备另行建立兼容性记录，不把无线协议假设带入有线实现。

**执行内容**:

- 登记设备型号、固件版本、VID/PID、USB interface class、HID/WinUSB、是否存在虚拟串口；
- 确认有线设备与目标板之间是 SWD 还是 JTAG；
- 将无线 DAPLink 的设备型号、连接方式和协议状态登记为第二阶段输入，不在 DAP-00 中猜测其私有无线链路；
- 确认目标 MCU、SWD 时钟范围、供电方式和 reset 连接；
- 收集该目标 MCU 对应的 CMSIS-Pack 或其他受支持 Flash Algorithm、算法版本和授权状态；
- 准备一个带 ELF/DWARF 的 Cortex-M 测试工程；
- 准备基本全局变量、结构体、FreeRTOS 任务、MemoryView 区域、SVD 文件和 RTT 输出；
- 记录 J-Link 当前基线，作为性能和功能对照，不修改其现有路径。

**产出**:

- `docs/daplink-hardware-matrix.md`；
- 设备枚举截图或只读设备信息；
- 目标工程和验证脚本；
- J-Link 对照数据：连接耗时、控制延迟、变量读取成功率、Timeline 采样率。

**验收**:

- 能明确回答有线设备是标准 CMSIS-DAP v1 还是 CMSIS-DAP v2；
- 确定第一款正式支持的有线设备和第一款目标 MCU；
- 生成无线设备待测清单，但无线设备不作为有线 MVP 的前置条件；
- 已确认默认烧录所需的 Flash Algorithm 来源；若尚未具备，必须把该状态标记为 DAP-02A 的阻塞项；
- 没有执行未授权的 target-mutating 操作。

### DAP-01：通用 owner 和配置骨架

**技术方向**:

- 扩展 `SessionTargetOwnerKind`，增加 CMSIS-DAP owner 表达；
- 增加 `probe` 或等价 launch 字段，例如 `jlink` / `cmsis-dap`；
- 增加 CMSIS-DAP 配置字段：`cmsisDapTransport`、`cmsisDapSerial`、可选 `cmsisDapVid`/`cmsisDapPid` 和 `flashBeforeDebug`；
- `flashBeforeDebug` 对所有 probe 的缺省值为 `true`，但 CMSIS-DAP 与 J-Link 必须分别走各自 owner 的烧录实现；
- `flashBeforeDebug: false` 必须在 launch、DAP session、owner 和 UI 状态中保持一致，不允许由下层自行恢复默认烧录；
- 当 `flashBeforeDebug` 为 `true` 且 CMSIS-DAP 烧录能力尚未实现时，必须返回明确的 `UnsupportedCapability`，不能静默跳过烧录；
- 保留现有 `nativeDebugEngineMode` 语义，不把 CMSIS-DAP 混进 J-Link fallback；
- owner 类型建议最终表达为 `jlink-native`、`jlink-legacy`、`cmsis-dap`，但可以先保持兼容别名；
- `SessionTargetSelector` 继续保证一 session 一个 physical owner；
- 连接失败后必须清理已创建的 helper，再决定是否回退；
- CMSIS-DAP 不能回退到第二个同时存在的 J-Link owner。

**规范**:

- 所有 owner 方法返回统一的 `ok/data/errorCode/targetState/elapsedMs` 结果；
- 所有 `.data` 使用前检查 `.ok`；
- owner loss 必须释放请求、标记 session 不可用并给出可诊断错误；
- 不在 `RuntimeRouter` 失败后回退到 extension-host backend；
- 不改变现有 J-Link 默认配置和默认行为。

**验收**:

- 现有 J-Link 单元测试、Mock 和构建不回归；
- CMSIS-DAP 模式可以被解析但在 helper 尚未完成时给出明确的 `UnsupportedCapability`；
- `dll.log`/`dap.log` 能区分 J-Link 与 CMSIS-DAP owner；
- 测试证明同一 session 不会同时创建两个 physical owner。
- 测试证明默认配置会请求 CMSIS-DAP 烧录，`flashBeforeDebug: false` 会明确跳过烧录，且 J-Link 原有默认行为不回归。

### DAP-02：CMSIS-DAP helper 握手和 transport

**最终状态（2026-08-11）**: 通过。Windows CMSIS-DAP v1 HID 和 v2 WinUSB、独立 helper、JSON-lines RPC、framing、握手、设备选择、超时/取消/移除和 mock transport 均已纳入正式路径；后续 DP/AP、Cortex-M、内存和烧录能力由 DAP-02A 至 DAP-04 完成。v1 HID 已完成真机验收；v2 WinUSB 当前只有代码、Mock、自测和构建证据，等待具备 bulk 接口的设备补充硬件矩阵。证据见 `docs/daplink-hardware-matrix.md`、`docs/cmsis-dap-v2-winusb-report.md` 与最终阶段报告。

**返工记录（2026-08-03）**: 协议层按官方规范返工：(1) DAP_Info ID 修正为 Capabilities=0xF0、Packet Count=0xFE、Packet Size=0xFF；(2) DAP_Info 解析改为官方布局 `[0x00][len][data]`（无 info id 回显，length=0=无信息，字符串含 NUL，Packet Count 按 BYTE、Packet Size 按 little-endian SHORT）；(3) DAP_Connect 改为官方 `[0x02][Port]`（0=初始化失败、1=SWD、2=JTAG），删除虚构的 3 字节 status 分支（vendor-echo 仅保留未启用的 mock）；(4) DAP_Disconnect 按官方 v2 `[0x03][Status]` 并兼容 v1 单字节；(5) DAP_ERROR 修正为 0xFF；(6) HID 超时取消复核：CancelIoEx 后等待取消完成才允许 control-transfer 重发，否则返回错误不重发。返工后硬件重验确认设备真实提供 packet size=64（此前用错误 ID 查询误判为未提供）。

**技术方向**:

- 创建 `native/cmsis-dap-helper/`（已完成：`CMakeLists.txt`、`src/main.cpp`、`src/json_rpc.{h,cpp}`、`src/cmsis_dap_transport.h`、`src/cmsis_dap_hid_transport.{h,cpp}`、`src/mock_transport.{h,cpp}`、`src/cmsis_dap_protocol.{h,cpp}`）；
- 实现 Windows HID v1（已完成：SetupAPI 枚举、HidD report capabilities、overlapped I/O、超时取消、设备拔出检测、report ID framing、短包接受/空读拒绝/长包 `PacketTooLarge` 拒绝）；
- 实现 Windows WinUSB v2（未开始；`cmsisDapTransport: winusb` 明确返回 `UnsupportedCapability`）；
- 读取设备 packet size、packet count、protocol version、capabilities、vendor/product/serial（已完成：`DAP_Info` 逐项查询，空字段按"设备未提供"记录；packet size 来源标记 `protocol-info`/`hid-report-capability`/`unavailable`，不把 HID report 长度冒充协议 packet size）；
- 实现 request id、超时、取消、设备移除、helper 进程退出（已完成：helper 侧结构化错误码 + TypeScript 侧 `CmsisDapHelperClient` 生命周期）；
- 建立可注入的 mock transport，不依赖真实 USB 才能测试 framing（已完成：5 种行为设备，`npm run test:cmsis-dap:mock`）。

**边界**:

- 第一版只支持标准 CMSIS-DAP command channel；
- 不把虚拟串口当成调试控制通道；
- 不把 SWO endpoint 当成 RTT；
- 无法证明为标准 CMSIS-DAP 的无线 TCP/BLE 协议先标记为待定，不猜包格式；
- 有线设备的 CMSIS-DAP helper 不为无线私有协议预留未经验证的隐式兼容逻辑。

**验收**:

- Mock 能验证 v1/v2 packet framing、短包、长包、超时、错误 response 和设备断开（已完成：mock 矩阵覆盖 reportId 0/非 0、65/33 字节 report、短读、超长拒绝、错误 command id、错误长度、status 错误、read timeout、设备拔出后 `DeviceRemoved`、helper 异常退出）；
- 经过授权的真实硬件能够完成 `DAP_Info`、`DAP_Connect`、`DAP_Disconnect`（用户已授权 `D:\STM32\project\vet6_led` 开发板；验证结果在阶段报告登记）；
- 记录设备 VID/PID、协议版本、packet size、transport 和 helper PID（硬件验证后登记）；
- `npm run build:native` 和相应 helper mock 测试通过（已通过：`npm run build:native` 产出 `orbit-cmsis-dap-helper.exe`；`npm run test:cmsis-dap:mock` 全部断言通过；`npm test` 112 项、`npm run typecheck`、`npm run build`、`npm run test:cpp-channel:mock` 均通过）。

### DAP-02A：CMSIS-DAP 默认烧录

**目的**: 使用已经建立的 CMSIS-DAP owner 完成默认烧录；`flashBeforeDebug: false` 是明确的预烧录调试分支，而不是烧录失败后的静默降级。

**技术方向**:

- 第一版只支持 DAP-00 确定的第一款目标 MCU 和对应 Flash Algorithm；不在首版承诺任意 Cortex-M 自动识别和烧录；
- 优先接入 CMSIS-Pack Flash Algorithm，使用 CMSIS-DAP 的 DP/AP、寄存器和内存访问作为底层目标通道；
- 支持 ELF 可加载段解析、算法初始化、擦除、编程、校验和反初始化；
- `flashBeforeDebug: true` 时烧录、校验成功后才能进入正常调试状态；
- `flashBeforeDebug: false` 时完全跳过烧录、校验和烧录专用 reset；
- 烧录过程必须复用当前 CMSIS-DAP physical owner，不得通过第二个 OpenOCD、GDB Server、命令行工具或 J-Link owner 绕过；
- Flash Algorithm 缺失、目标不匹配、校验失败和算法异常都必须返回结构化错误。

**边界**:

- CMSIS-DAP 协议本身不提供通用 Flash 命令，烧录能力由目标 MCU 对应的 Flash Algorithm 提供；
- 首版不实现完整 CMSIS-Pack 生态的所有器件族，只冻结一个真实硬件目标；
- 不把“预烧录后能调试”作为“默认烧录已通过”的替代证据。

**验收**:

- 默认配置下，能够烧录测试 ELF，并通过版本号、校验值或目标变量变化确认新固件生效；
- `flashBeforeDebug: false` 下，烧录计数为零，启动日志明确记录 `flash skipped`，目标已有固件可以直接进入调试；
- Flash Algorithm 缺失或烧录失败时，launch 失败并给出可诊断原因，不进入误导性的“烧录成功后状态”；
- 连续至少 5 次执行默认烧录，均使用同一个 CMSIS-DAP owner，不创建第二个物理连接；
- J-Link 默认烧录和 `flashBeforeDebug` 兼容行为无回归。

### DAP-03：DP/AP 和内存访问

**最终状态（2026-08-11）**: 通过。返工已统一到官方 `DAP_Transfer=0x05` / `DAP_TransferBlock=0x06` 布局，Mock 使用独立 oracle，保留位、ACK、WAIT/FAULT、协议错误、短包和“写完成状态未知不得重试”均严格处理；DP/AP、连续/散地址批量内存和真机读取证据已由后续阶段覆盖。

**技术方向**:

- 初始化 SWD DP；
- 选择 MEM-AP；
- 实现 8/16/32 位访问所需的对齐和 byte lane；
- 实现连续内存读写和 `DAP_TransferBlock`；
- 处理 `WAIT`、`FAULT`、`NO_ACK`、sticky error 和 transfer abort；
- 对 Watch/Timeline 提供批量读取接口；
- 所有 read/write 进入同一个 owner scheduler。

**验收**:

- Mock 覆盖 DP/AP 寄存器访问、WAIT 重试、FAULT 清理、跨边界读写；
- 真实硬件能够读 Flash、RAM 和一个已知外设地址；
- MemoryView 的 base64 byte-oriented `readMemory`/`writeMemory` 合同不变；
- 连续 10 分钟只读内存不会产生 owner loss 或不可恢复状态；
- 不能用一次“普通内存读成功”代替完整硬件验收，必须记录目标状态和错误码。

### DAP-04：基本调试控制

**技术方向**:

- 实现 `getState`、halt、run、reset；
- 实现 Cortex-M 通用寄存器读取；
- 实现单条指令 step；
- P0 只要求可靠的 instruction step；源码级 Step Over/Into/Out 不得作为基本调试控制的隐式前置条件；
- 控制请求使用 `control` 优先级，暂停 `watch`、`timeline` 和 `background`；
- 控制结束后恢复被暂停的采样；
- 将 PC/state 作为可信目标事实来源，不使用旧 owner 或缓存覆盖。

**验收**:

- DAP launch 后目标能按预期停在入口；
- Pause、Continue、Reset 各执行至少 20 次，目标状态和 DAP 事件一致；
- Step response 在 stopped event 之前，且没有重复 stopped event；
- 控制期间 Watch、Timeline、RTT background 不发出并发 target read；
- 任何一次失败都能进入明确的 error/owner-loss 路径，不留下第二 owner。
- `flashBeforeDebug: true` 时，烧录失败必须阻止进入“烧录成功后的调试状态”并报告原因；`flashBeforeDebug: false` 时，启动日志必须表明已跳过烧录。

### DAP-05：硬件断点和源码级 Step

**技术方向**:

- 读取并配置 Cortex-M FPB comparator；
- 维护用户断点槽和临时断点槽；
- 支持当前 PC 位于用户断点时的 continue-at-current-PC；
- 实现单步越过当前断点、临时断点清理和用户断点恢复；
- 先完成硬件断点和 instruction step 的稳定配合，再复用现有 ELF/DWARF 行号范围实现源码 Step；
- 源码 Step 分为 Step Over、Step Into、Step Out 三个独立能力，任何一种暂不支持时单独返回 capability error；
- CMSIS-DAP owner 提供与 `SessionTargetOwner` 一致的控制结果；
- 若第一版某类源码 Step 暂不支持，必须返回 capability error，不能静默退化成第二 owner 或重复点击式指令步进。

**验收**:

- 至少覆盖 6 个 FPB 硬件断点槽；实际槽数量以目标报告为准；
- 设置、命中、清除、重新设置断点后槽位和 PC 一致；
- instruction step 和断点配合先各执行 20 次；Step Over、Step Into、Step Out 在源码 Step 能力启用后各执行 20 次，包含函数调用、循环、条件分支和当前 PC 命中断点；
- 用户断点在临时断点完成后恢复到原槽；
- timeout、取消、断线和异常路径都清理临时断点；
- 记录 `step.log` 中的 PC before/after、槽位、耗时、错误码和清理结果。

### DAP-06：Watch 基础实时变量

**技术方向**:

- 复用现有 `evaluate`、DWARF 类型解析和 Watch UI；
- 复用 `dataSample` 的 realtime path，目标运行时不额外查询 target state；
- 复用 Watch 分片读取、缓存、展开节点和表达式规范化；
- 对 CMSIS-DAP 尽量合并同一批次的连续内存读取；
- 保持 `control > watch` 优先级；
- 维护 active DAP session identity 和 generation fence；
- session 终止、替换或尚未连接时，不启动新的读请求，也不接收旧 session 的结果。

**第一版支持范围**:

- 全局标量变量；
- 静态变量；
- 指向有效内存的基础指针；
- 停止状态的局部变量；
- `uint8/16/32`、有符号整数、float、double（目标 ABI 可解析时）。

**验收**:

- 5 个标量变量连续运行 60 秒，至少 95% 的采样请求返回有效值或明确错误；
- 值变化方向和目标计数器/已知波形一致；
- 变量写入后 Watch 缓存失效，下一次读取得到新值；
- 停止状态 Local、Registers、Watch 都能读取；
- 关闭或替换 DAP session 后，旧结果不会发布到新 session；
- 在 Watch 运行时执行 Step/Halt/Continue，不出现第二 owner、死锁或永久空白。

### DAP-07：普通 DAP Timeline

**技术方向**:

- 保持现有 `DataSamplingManager -> DAP dataSample -> DapSession` 路径；
- Timeline 只读取用户明确加入的表达式，不自动展开复杂 Watch 子树；
- 维持 `control > watch > timeline > background`；
- Timeline 采样读取可以被控制请求取消或暂停；
- 保留 Timeline UI 的 `enabled`、颜色、缩放、中心线和历史点；
- 使用实际采样时间戳，不把配置中的 `sampleMs` 直接宣传为真实频率；
- 无线设备默认采用较保守采样间隔，允许用户调低频率换取控制稳定性；
- 采样缺口必须被记录，不能跨越明显缺口连接成误导性波形。

**建议验收门槛**:

| 配置 | 最低目标 |
|---|---|
| CMSIS-DAP v2 有线，3 个标量 | 60 秒无 session 终止，采样率和 P95 延迟有记录 |
| CMSIS-DAP v1 HID，3 个标量 | 功能可用，允许显著降低采样率 |
| 有线 CMSIS-DAP，3 个标量 | 完成功能验收，记录实际采样率和 P95 延迟 |
| 无线 DAPLink，3 个标量 | 作为第二阶段测试，最低 2 Hz 或由设备矩阵明确标记为降级模式 |
| 任意链路 + Step/Halt | 控制请求不能被 Timeline 长时间饿死 |

验收报告必须同时给出有效采样率、读请求 P50/P95、控制 P50/P95、丢点数和设备信息，不能只截图波形。

### DAP-08：基于内存读写的 RTT 日志

**技术方向**:

- 不调用 `JLINK_RTTERMINAL_Control/Read`；
- 新增 generic RTT memory transport；
- `startRtt` 首先支持显式 `rttControlBlockAddress`；
- 验证 `SEGGER RTT` Control Block、Up Buffer 元数据、`WrOff/RdOff`；
- 读取上行环形缓冲区后更新 `RdOff`；
- 将 RTT 轮询标记为 `background`，不能与 Watch/Timeline 平级竞争；
- 控制请求暂停 RTT background，控制结束后恢复；
- 复用现有 ANSI、终端、Debug Console、P-RTLog 处理；
- 后续再增加 ELF 符号定位和内存扫描，避免第一阶段有线主线被 RTT 自动扫描拖慢；无线设备的扫描性能另行测试。

**边界**:

- RTT 是目标内存协议，不是 CMSIS-DAP 标准命令；
- SWO 是可选独立能力，不等于 RTT；
- 第一版不承诺无线高吞吐无损；
- RTT 文本、RTT Timeline Sample、RTOS Trace 必须保持为三个逻辑 consumer。

**验收**:

- 已知 RTT Control Block 地址下，目标连续输出 1 KB/s 日志 60 秒，日志内容无明显乱序；
- 目标运行时 RTT 轮询不导致目标异常 halt；
- 控制请求能够暂停 RTT 读取并在结束后恢复；
- RTT 停止、断线、reset、session replacement 都清理轮询定时器；
- 对 ring buffer 覆盖、空读、短读和 owner loss 有单元测试；
- 真机报告区分“日志功能通过”和“高吞吐无损未验证”。

### DAP-09：RTOS View

**状态**: 2026-08-09 已通过用户独立验收；实现、Mock、真实 CMSIS-DAP lifecycle/session replacement 和剩余风险边界见 `docs/dap09-rtos-view-acceptance-report.md`。后续 Viewer 阶段也已完成。

**技术方向**:

- 第一版只支持明确版本范围内的 FreeRTOS、Cortex-M、ELF/DWARF 可用目标；其他 RTOS 标记为未支持，不通过猜测结构体布局兼容；
- 首个硬件验收固定使用一个已知 FreeRTOS 工程和固定编译配置，记录 FreeRTOS 版本、优化级别和相关内核配置；
- 复用现有 `rtosInfo`、`stackTrace`、`evaluate`、`variables`、`readMemory`；
- 以 TCB 地址作为任务稳定 key；
- 使用批量内存读取，但必须走活动 DAP owner；
- 读取 RTOS 结构体时保持 halted/running 语义清晰；
- RTOS refresh 属于低优先级 background 或受控 read，不得压住 Step/Halt；
- 不能通过 extension-host backend 建立第二条目标访问路径。

**验收**:

- 至少 3 个 FreeRTOS 任务能显示名称、状态、优先级、栈使用和运行计数；
- 任务创建/删除后列表能正确刷新，不复用已经失效的 TCB 地址；
- RTOS View refresh 与 Watch/Timeline 并行时控制仍可用；
- 停止、继续、reset、disconnect 后不残留旧任务数据；
- 目标优化级别和 ELF 信息记录在验收报告中。
- 首版验收必须记录 FreeRTOS 版本、目标 ABI、内核配置和任务结构体读取依据。

### DAP-10：MemoryView

**技术方向**:

- 保持 DAP `supportsReadMemoryRequest`；
- 保持 `memoryReference` 的十六进制解析；
- 保持 base64 字节数据和 `unreadableBytes` 语义；
- 对大块读取分块，并让控制请求能够抢占；
- Flash、RAM、外设地址区分别记录访问结果；
- 写内存只在明确用户操作和硬件授权测试中执行。

**验收**:

- 读取已知 RAM、Flash 和外设寄存器区；
- 读取跨 packet size 的大块内存；
- 非法地址、不可读区域、短读返回明确错误或 `unreadableBytes`；
- 写入已知 RAM 后目标变量变化可被 Watch 读到；
- 大块 MemoryView 读取不永久阻塞 Step/Halt/Timeline。

### DAP-11：Peripheral Viewer

**技术方向**:

- 保留 `svdFile` 和 `svdPath` launch aliases；
- SVD 解析和寄存器树继续使用现有 Viewer 路由；
- 只替换底层 `readMemory`/`writeMemory`；
- 按寄存器宽度和访问属性执行读写；
- 对 read-only、write-only、write-one-to-clear 等属性显示清晰限制；
- 不自动写入外设寄存器，不用刷新动作模拟写入。

**验收**:

- 能加载 SVD 并显示外设层级、寄存器和字段；
- 至少读取 GPIO、RCC、TIM 或 USART 等已知外设；
- 读写操作经过 DAP owner，日志中有地址、宽度、结果和错误码；
- MemoryView、Peripheral Viewer 和 Watch 同时存在时不发生 owner 冲突；
- Viewer 不会因一个不可读寄存器导致整个 DAP session 结束。

### DAP-12：统一稳定性、性能和发布验收

**技术方向**:

- 第一阶段完成 J-Link、有线 CMSIS-DAP v1/v2 的支持矩阵；
- 第二阶段补充无线 DAPLink 的设备、协议、延迟、抖动、丢包和功能矩阵；
- 完成 owner loss、设备拔出、helper crash、session replacement、reset、cancel 测试；
- 建立固定日志证据格式；
- 更新用户配置和 README，但不改变 J-Link 默认行为；
- 打包 helper 到 VSIX；
- 维持现有 DAP、Watch、Timeline、RTT 和 Viewer 的回归测试。

**自动化验收**:

```text
npm run typecheck
npm test
npm run build
npm run build:native
npm run test:cpp-channel:mock
git diff --check
```

CMSIS-DAP helper 需要增加对应的 mock 命令，例如：

```text
npm run test:cmsis-dap:mock
```

**硬件验收**:

- 只在用户明确授权后执行；
- 每项记录 probe 型号、固件、VID/PID、transport、目标 MCU、SWD 速度、ELF 和编译优化等级；
- 记录 owner 数量、helper PID、连接次数、target state、PC、控制延迟和错误码；
- 硬件报告必须独立于 Mock、单元测试、构建和离线解析报告；
- 未执行的项目明确标记为“未验证”，不能用代码通过代替硬件通过。

**有线 MVP 建议最低门槛**:

- CMSIS-DAP v2：3 个标量变量连续运行采样 60 秒，至少 95% 请求返回有效值或明确错误；
- CMSIS-DAP v2：Timeline 有效采样率至少达到 2 Hz；若实际设备低于该值，必须降级为“功能可用、性能受限”并记录原因；
- CMSIS-DAP v1 HID：允许低于 2 Hz，但必须完成 Watch/Timeline 功能路径并记录有效采样率；
- 任意有线 transport：Step/Halt/Continue 控制请求的 P95 延迟必须单独记录，且 Timeline 不得无限期占用控制通道；
- 默认烧录：连续 5 次烧录、校验和启动成功；跳过烧录：连续 5 次确认没有烧录请求且已有固件可调试；
- 所有性能数字只适用于完成测试的具体 probe、目标 MCU、SWD 速度和 ELF，不外推到无线设备。

## 6. 统一工程规范

### 6.1 Owner 规范

- 每个 `ozone` DAP session 只有一个 physical target owner；
- J-Link Native、J-Link Legacy、CMSIS-DAP 三者不能并存访问同一个目标；
- owner 选择在连接阶段完成；
- 已连接 owner 丢失后，不在同一 session 中热切换到第二 owner；
- helper 退出必须完成，才允许创建另一个 owner；
- owner 的连接、断开、能力、错误和耗时必须可观测。

### 6.2 Scheduler 规范

优先级固定为：

```text
control > watch > timeline > background
```

- control: run、halt、reset、step、断点、变量写入、外设写入；
- watch: 停止状态 Watch 和必要的高优先级变量读；
- timeline: DAP 数据采样；
- background: RTT、RTOS refresh、诊断性低优先级读取；
- control 的完整临界区必须暂停低优先级读取；
- Watch 必须在小分片之间释放 target-read gate；
- 所有后台结果都要通过 session/generation 检查后才能发布。

### 6.3 DAP 和 Viewer 规范

- 不改变标准 DAP `evaluate`、`variables`、`readMemory`、`writeMemory` 和 `memoryReference` 合同；
- `initialize.supportsReadMemoryRequest` 保持有效；
- 所有 success-only 字段读取前检查 `.ok`；
- 活动 DAP session 存在时，RuntimeRouter 只能通过 `customRequest` 访问目标；
- 活动 DAP session 存在时，MemoryView、Peripheral Viewer 和 RTOS View 的目标读写失败必须返回明确错误，不得静默回退到 extension-host backend；
- `deviceName`、`svdFile`、`svdPath` launch aliases 保持兼容；
- Watch、Timeline、RTOS View、MemoryView、Peripheral Viewer 不得创建 duplicate backend。
- 所有 Watch、Timeline、RTT、RTOS 和 Viewer 异步结果必须检查 active session identity 与 generation，旧 session 结果不得发布到新 session。

### 6.4 日志规范

- 连接和 transport: `log.dll`，消息前缀 `[cmsis-dap]`；
- DAP/session/Watch 路由: `log.dap`；
- 表达式、内存和 DWARF: `log.eval`；
- run、halt、step、断点: `log.step`；
- RTT 和 Timeline 诊断不得新增重复 logger；
- 日志包含 session id、owner kind、request label、target state、elapsedMs、errorCode；
- 不输出完整 ELF 内容、认证 token 或不必要的目标内存数据。

## 7. 风险和处理策略

| 风险 | 影响 | 处理策略 |
|---|---|---|
| 无线设备不是标准 CMSIS-DAP | 无法复用标准 transport | DAP-00 先登记 VID/PID 和协议，未知协议单独立项 |
| CMSIS-DAP v1 HID 延迟高 | Timeline 稀疏、Step 慢 | 优先 v2，限制批量大小，默认降低采样率 |
| AP transfer WAIT/FAULT | 读写失败或 session 卡死 | 统一重试、abort、超时和 owner-loss 状态机 |
| FPB 槽位少 | 断点数量受限 | 动态探测，保留用户断点优先级，明确报告容量 |
| 源码 Step 反复访问目标 | 无线环境下延迟放大 | 先保证 instruction step，再逐项优化 source step 和批量读取 |
| RTT memory polling 覆盖数据 | 日志丢失 | 增大目标 buffer、降低轮询周期、记录丢失和覆盖统计 |
| RTOS/Viewer 读取压住控制 | 调试器失去可用性 | 统一 scheduler，background 可取消，control 永不绕过 |
| 旧 session 结果发布到新 session | UI 数据错乱 | active session identity + generation fence |
| 仅通过 Mock 就宣称支持 | 发布后真机失败 | 将代码、Mock、自动化、硬件、长稳分别报告 |

## 8. 最小发布版本定义

### MVP-1：可用调试器

必须包含 DAP-00 至 DAP-04，并且以有线设备验收；其中 DAP-02A 是默认烧录的必要前置：

- 第一款有线标准 CMSIS-DAP v2 设备；如果实际设备只有 v1，则明确记录 HID 性能限制；
- 连接、halt、run、reset、register、memory、基本 instruction step；
- 基础硬件断点；
- 默认烧录成功；`flashBeforeDebug: false` 跳过烧录后仍可调试；
- J-Link 旧路径无回归。

### MVP-2：可观测变量

必须包含 DAP-05 至 DAP-06：

- 基础硬件断点；
- Watch 运行时标量变量；
- 停止状态 Local/Registers；
- 变量写入和缓存失效；
- active session/generation 保护。

### MVP-3：可视化和日志

必须包含 DAP-07 至 DAP-08，并且先以有线设备验收：

- 普通 DAP Timeline；
- RTT 文本日志；
- Timeline/RTT/Watch 互不永久阻塞；
- 明确记录有线链路的实际采样率和 RTT 丢失风险；无线链路测试放入第二阶段。

### MVP-4：插件兼容发布

必须包含 DAP-09 至 DAP-12，并且先完成有线设备发布门槛：

- RTOS View；
- MemoryView；
- Peripheral Viewer；
- 完整回归、断线恢复、长时间运行和 VSIX 打包；
- 至少一款真实有线 DAPLink/CMSIS-DAP 设备完成硬件验收；
- 无线 DAPLink 作为后续兼容性阶段单独验收，不得用有线结果代替无线结果。

## 9. 完成定义

有线 CMSIS-DAP/DAPLink 发布项目已满足以下完成条件：

- [x] 0. 基本调试功能在目标硬件上通过；
- [x] 默认 `flashBeforeDebug: true` 的烧录、校验和启动通过，且显式 `false` 时确认跳过烧录；
- [x] 1. Watch 实时变量在目标运行和停止状态均通过；
- [x] 2. Timeline 在目标设备支持的合理频率下通过，实际频率有记录；
- [x] 3. RTT 日志在明确声明的吞吐和丢失边界内通过；
- [x] 4. RTOS View、MemoryView、Peripheral Viewer 使用同一个 DAP owner 正常运行；
- [x] 第一阶段：有线 DAPLink/CMSIS-DAP 完成上述 0～4 目标；
- [x] J-Link 既有链路回归通过；
- [x] Mock、自动化构建、真机、长稳四类证据分开记录；
- [x] 没有第二 owner、extension-host bypass、旧 session 数据污染或未清理的后台任务；
- [x] 用户于 2026-08-11 确认最终结果。

无线 DAPLink、TCP/BLE 或厂商私有 transport 不从有线结果推断为通过；出现具体设备时，使用独立设备矩阵记录协议、性能和稳定性。`docs/bug-fix-log.md` 仍只记录用户明确确认的具体缺陷修复，不因项目计划收口自动新增条目。

## 10. 参考资料

- [CMSIS-DAP 官方概览](https://arm-software.github.io/CMSIS-DAP/latest/index.html)
- [CMSIS-DAP Transfer Commands](https://arm-software.github.io/CMSIS-DAP/latest/group__DAP__transfer__gr.html)
- [CMSIS-DAP USB 配置](https://arm-software.github.io/CMSIS_5/5.7.0/DAP/html/group__DAP__ConfigUSB__gr.html)
- [CMSIS-DAP SWO Commands](https://arm-software.github.io/CMSIS-DAP/latest/group__DAP__swo__gr.html)
- [pyOCD Debug Probes / CMSIS-DAP](https://pyocd.io/docs/debug_probes.html)
- [OpenOCD Architecture（仅作分层参考）](https://openocd.org/doc/doxygen/html/oocd.html)
- [Orbit Native scheduler 设计](debug-engine-refactor/native-scheduler-design.md)
- [Orbit 实时变量保护](debug-engine-refactor/realtime-variable-protection.md)
- [Orbit DAP step 状态机](debug-engine-refactor/step-state-machine-design.md)
- [Orbit DAP/owner 验证矩阵](debug-engine-refactor/validation-matrix.md)
