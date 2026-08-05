# DAP-00 有线 DAPLink/CMSIS-DAP + STM32F407VET6 硬件矩阵

- 登记阶段：DAP-00「设备和硬件基线登记」
- 初始资料采集时间：2026-08-03 13:32:59 +08:00
- 真实硬件补充验证时间：2026-08-03 14:33:36 +08:00
- 返工脚本验证时间：2026-08-03 14:55:35、14:59:07 +08:00
- 适用范围：第一阶段、有线 DAPLink/CMSIS-DAP；无线 DAPLink 不在本次范围内
- 当前状态：`DAP-00 条件通过；硬件资料补充和 Flash Algorithm 仍有阻塞项`

## 1. 测试范围和当前结论

本次返工进行工作区和文档一致性检查，并运行只读采集脚本完成 Windows USB/PnP、HID 能力和 `DAP_Info` 验证；此前用户明确授权的硬件采集结果（`DAP_Connect(SWD)`、DP IDCODE）作为历史证据保留，不在本次返工重复执行。

没有新增 CMSIS-DAP helper、DP/AP、Cortex-M 控制、Watch、Timeline、RTT 或 Viewer 代码，也没有使用 J-Link、OpenOCD、GDB Server 或厂商命令行工具执行 CMSIS-DAP 烧录。

硬件操作情况：本次返工未执行 `DAP_Connect`、`SWJ_Pins`、`SWJ_Clock` 或任何目标状态命令；文档保留此前授权采集的 `DAP_Connect(SWD)` 和 DP IDCODE `0x2BA01477` 证据。

当前结论：

1. Windows 当前枚举到一个名称为 `CMSIS-DAP_LU` 的 USB 复合设备，VID/PID 为 `C251:F001`，设备状态为 `OK`、`ProblemCode=0`。
2. 该设备的调试候选接口为 USB class 03 HID，Windows 服务为 `HidUsb`；同时存在 USB class 02 CDC 虚拟串口 `COM15`。CDC 只登记为串口，不能据此当作调试控制通道。
3. HID 报告长度为输入 65、输出 65 字节；设备返回 CMSIS-DAP protocol version `1.0`，因此当前设备的实际调试路径可登记为 `CMSIS-DAP v1/HID`。固件版本、CMSIS-DAP packet size/count 仍未取得有效值。
4. 目标 MCU 已由用户指定为 `STM32F407VET6`，并由外部测试工程的 `.ioc` 文件确认；授权的 `DAP_Connect(SWD)` 和 DP IDCODE 读取返回 `0x2BA01477`，证明当前探针与目标之间存在可用 SWD Debug Port 路径。NRST、供电来源、DAPLink 是否供电和其他调试器情况仍未确认。
5. 已发现可复用测试工程、带 DWARF 的 Debug ELF、精确到 STM32F407VETx 的 SVD、FreeRTOS 10.3.1、RTT 观测对象和外设测试对象。
6. 在本次检查的工作区、`D:\STM32` 和常见 CMSIS-Pack 安装路径中没有发现 STM32F407VET6 可供 CMSIS-DAP 使用的 `.pack`、`.pdsc` 或 `.FLM`。因此默认烧录所需 Flash Algorithm 当前为 `缺失/阻塞`。
7. 当前 Orbit 的 `SessionTargetSelector` 仍只选择 J-Link Native 或 J-Link Legacy 两种 owner；源码、DAP 和 Native helper 结构可作为后续输入，但本次不修改它们。

状态收口：DAP-00 登记工作为 `条件通过`；DAP-01 可以开始，但本次不实施 DAP-01；DAP-02A 默认烧录因 Flash Algorithm `缺失/阻塞`，不能开始。

状态词含义：`已确认` 表示有当前文件、命令输出或 Windows 枚举直接证据；`已发现，未验证` 表示有本地资料但尚未完成对应运行/硬件验证；`未验证`、`待硬件确认`、`无法读取` 表示本次没有安全或授权条件取得该事实；`缺失`、`阻塞` 表示后续实现不能把它当作现成输入。

## 2. 有线 DAPLink/CMSIS-DAP 设备表

| 项目 | 当前登记结果 | 状态 | 证据来源 |
|---|---|---|---|
| Windows 设备描述 | `CMSIS-DAP_LU` | 已确认 | `Get-PnpDeviceProperty`：`DEVPKEY_Device_BusReportedDeviceDesc=CMSIS-DAP_LU` |
| 设备型号/板卡具体型号 | Windows 只暴露 `CMSIS-DAP_LU`，具体板卡型号未读取 | 未验证 | Windows USB/PnP 输出；未读取 USB 厂商私有资料 |
| 当前正式支持标识 | `CMSIS-DAP_LU / VID_C251 / PID_F001 / CMSIS-DAP v1 HID` | 已确认；能力标识，不是板卡商品型号 | Windows PnP、HID string/report capability、`DAP_Info(0x04)=1.0` |
| VID/PID | `VID_C251` / `PID_F001` | 已确认 | 根设备实例：`USB\VID_C251&PID_F001\LU_2022_8888` |
| USB revision 字段 | PnP Hardware ID 含 `REV_0100` | 已确认；不是固件版本 | `DEVPKEY_Device_HardwareIds` |
| 固件版本 | `DAP_Info(0x09)` 返回零长度，未取得有效版本字符串 | 未验证 | Windows HID API CMSIS-DAP protocol query；Windows PnP 不提供固件版本 |
| 根设备 USB class | Composite device；compatible ID 显示 device class 00 | 已确认 | 根设备 `Class=USB`、`Service=usbccgp` |
| 调试候选 interface class | `Class_03 / SubClass_00 / Prot_00` | 已确认 | MI_02 compatible IDs；`Class=HIDClass` |
| 调试候选 interface service | `HidUsb` | 已确认 | MI_02 `DEVPKEY_Device_Service=HidUsb` |
| 虚拟串口 interface | `CMSIS-DAP CDC`，`COM15` | 已确认 | MI_00 `Class=Ports`、`FriendlyName=USB 串行设备 (COM15)`、`Service=usbser` |
| CDC interface class | `Class_02 / SubClass_02 / Prot_01` | 已确认 | MI_00 compatible IDs |
| HID 还是 WinUSB | HID 已确认；未发现该设备的 WinUSB child/interface | HID 已确认；WinUSB 未验证 | MI_02 `HidUsb`；本次 PnP 枚举未出现 `WinUSB` service |
| CMSIS-DAP v1 / v2 | `DAP_Info` 返回 protocol version `1.0`，且 command channel 通过 HID report 工作 | v1/HID 已确认；v2/WinUSB 未验证 | Windows HID API；CMSIS-DAP `DAP_Info(0x04)` response=`1.0` |
| USB packet size | HID input/output report byte length 均为 `65`；CMSIS-DAP `DAP_Info(0x0F)` 返回零长度 | HID report 长度已确认；CMSIS-DAP packet size 未验证 | Windows `HidP_GetCaps`；CMSIS-DAP `DAP_Info` |
| packet count | `DAP_Info(0x0E)` 返回零长度，未取得有效 packet count | 未验证 | CMSIS-DAP `DAP_Info(0x0E)` 原始 response |
| CMSIS-DAP protocol version | `1.0` | 已确认 | HID API 发送 `DAP_Info(0x04)`；response bytes=`00 00 04 31 2E 30 ...` |
| Vendor string | `jixin.pro` | 已确认 | Windows HID API `HidD_GetManufacturerString` |
| Product string | `CMSIS-DAP_LU` | 已确认 | Windows HID API `HidD_GetProductString`；PnP bus description 同名 |
| Serial string | `LU_2022_8888` | 已确认 | Windows HID API `HidD_GetSerialNumberString`；与 root PnP instance token 一致 |
| Windows 枚举 | 根设备、HID interface、CDC interface 均为 `Status=OK`；`ProblemCode=0` | 已确认 | `Get-PnpDevice` / `Get-PnpDeviceProperty` |
| 当前工具识别 | Windows HID API 成功打开并完成 `DAP_Info`、`DAP_Connect(SWD)`、DP IDCODE 只读查询；当前 Orbit 源码没有 CMSIS-DAP owner/helper | Windows/CMSIS-DAP HID 识别已确认；Orbit 集成未实现 | HID API 输出、`src/debugadapter.ts`、`src/ozone-backend/session-target-channel.ts` |
| 无线能力 | 不在本次范围；没有建立无线协议结论 | 不适用 | DAPLink 项目计划第 0 节；本任务范围 |

设备实例与接口实例：

- 根设备：`USB\VID_C251&PID_F001\LU_2022_8888`
- CDC：`USB\VID_C251&PID_F001&MI_00\7&16D6494D&0&0000`
- HID：`USB\VID_C251&PID_F001&MI_02\7&16D6494D&0&0002`

## 3. STM32F407VET6 目标板信息

| 项目 | 当前登记结果 | 状态 | 证据来源 |
|---|---|---|---|
| 目标 MCU | `STM32F407VET6` | 已确认 | 用户任务输入；`D:\STM32\project\vet6_led\vet6_led.ioc` 的 `Mcu.CPN` |
| CPU | Cortex-M4F | 已确认 | 用户任务输入；测试工程 toolchain 使用 `-mcpu=cortex-m4 -mfpu=fpv4-sp-d16 -mfloat-abi=hard` |
| 目标板实际调试接口 | `SWD`；`DAP_Connect(SWD)` 成功 | 已确认 | Windows HID CMSIS-DAP 只读命令输出；DP IDCODE 查询成功 |
| SWDIO | 有效 SWD 数据路径已确认；针脚实物状态未单独观察 | 已确认（功能路径）/待硬件确认（实物） | `DAP_Transfer` 读取 DP IDCODE 成功 |
| SWCLK | 有效 SWD 时钟路径已确认；针脚实物状态未单独观察 | 已确认（功能路径）/待硬件确认（实物） | `DAP_Transfer` 读取 DP IDCODE 成功 |
| GND | 通信参考路径功能正常；独立接线未测量 | 已发现，未验证 | DP IDCODE 成功；未做电气测量 |
| VTref | 探针与目标通信已成功；VTref 电压和独立接线未测量 | 已发现，未验证 | DP IDCODE 成功；未做电气测量 |
| NRST | 是否连接未确认 | 待硬件确认 | 需要用户提供板卡/探针接线或授权硬件检查 |
| 目标板供电 | 未读取 | 待硬件确认 | 需要板卡实物、电源资料或用户确认 |
| DAPLink 是否给目标板供电 | 未读取 | 待硬件确认 | 需要板卡手册和实际连接确认 |
| 目标板是否连接其他调试器 | 未读取 | 待硬件确认 | 需要断电检查/用户确认；本次没有切换或修改 J-Link |
| 建议 SWD 时钟范围 | 本次未执行 `SWJ_Clock`；OpenOCD 曾尝试 `1000 kHz` 但未完成 endpoint 初始化；可作为后续验证起点，不能登记为已验证安全范围 | 未验证 | OpenOCD 0.12.0 一次性诊断输出；未形成板级时钟稳定性结论 |
| 探针/目标板电气冲突 | 未读取 | 待硬件确认 | 需要确认供电、VTref、IO 电平、NRST 驱动和其他调试器连接 |

本表将 `DAP_Connect(SWD)` 和 DP IDCODE 读取仅解释为“当前探针与一个 SWD Debug Port 建立了可用只读路径”；它不替代用户对板卡型号、供电、各根线、NRST、第二调试器和电气冲突的实物确认。DP IDCODE `0x2BA01477` 与 STM32F4 Cortex-M SW-DP 兼容，但本次没有读取目标 CPU/外设寄存器或目标内存。

## 4. USB transport 判断

当前设备的 Windows interface 事实如下：

| Interface | Windows 结果 | 结论边界 |
|---|---|---|
| MI_02 | HIDClass，compatible ID 为 `USB\Class_03&SubClass_00&Prot_00`，service=`HidUsb`；HID input/output report length=`65` | 有线 HID transport 和标准 CMSIS-DAP command channel 已确认 |
| MI_00 | Ports，compatible ID 为 `USB\Class_02&SubClass_02&Prot_01`，service=`usbser`，COM15 | 虚拟串口已确认；不作为 Orbit 调试控制通道 |
| WinUSB | 本次设备子节点没有发现 `WinUSB` service | 对当前设备没有 WinUSB 证据；不能推断设备永远不支持 v2 |

因此，针对当前实际枚举的有线设备，DAP-01 的 transport 输入建议为：

- 首先支持 HID 路径，并把它登记为当前硬件基线的优先路径；
- 保留 WinUSB/v2 的独立 transport 设计，但不要把当前设备当成已确认的 WinUSB v2 设备；
- CDC 仅作为后续日志/串口用途候选，不与调试 command channel 混用。

## 5. CMSIS-DAP v1/v2 判断

| 判断项 | 状态 | 依据 |
|---|---|---|
| CMSIS-DAP v1 HID | 已确认 | HID API 成功完成 `DAP_Info(0x04)`，返回 protocol version `1.0`；`DAP_Connect(SWD)` 和 DP IDCODE 读取也成功 |
| CMSIS-DAP v2 WinUSB | 未验证；当前枚举未发现 WinUSB interface | Windows PnP child/interface service 只有 `HidUsb` 和 `usbser` 证据 |
| packet size | HID report 长度 `65` 已确认；CMSIS-DAP packet size 未取得 | 已发现，未验证 | Windows `HidP_GetCaps`；`DAP_Info(0x0F)` 返回零长度 |
| packet count | 未取得有效值 | 未验证 | `DAP_Info(0x0E)` 返回零长度 |
| protocol version | `1.0` | 已确认 | `DAP_Info(0x04)` response |
| 安全确认 DAPLink 能力 | 已完成 HID/CMSIS-DAP v1 command channel 与 SWD DP 只读握手 | 已确认；Orbit 集成未实现 | Windows HID API；未执行目标状态修改 |

当前 v1 判断不再只依赖设备名称或 HID 枚举，而是有协议层 `DAP_Info(0x04)=1.0` 和 `DAP_Connect(SWD)` 的直接证据。WinUSB/v2 仍没有证据；OpenOCD 的 bulk backend 诊断失败不能反向证明 v2，也不能替代 HID 证据。

## 6. Flash Algorithm 状态

### 6.1 CMSIS-Pack 和算法来源

| 项目 | 当前结果 | 状态 | 证据来源 |
|---|---|---|---|
| 工作区中的 CMSIS-Pack | 未找到 `.pack`、`.pdsc` 或 `.FLM` | 缺失 | `rg --files` 检查工作区 |
| `D:\STM32` 中的 CMSIS-Pack | 未找到 `.pack`、`.pdsc` 或 `.FLM` | 缺失（当前检查范围） | `rg --files D:\STM32` |
| 常见 Pack 路径 | `C:\Users\22690\AppData\Local\Arm\Packs`、`C:\Users\Public\Documents\Arm\Packs`、`C:\Keil_v5\ARM\PACK`、`C:\Program Files\Arm\Packs` 等路径不存在 | 缺失（当前检查范围） | PowerShell `Test-Path` 和只读递归检查 |
| Device Family | `STM32F4` | 已确认 | `vet6_led.ioc`、测试工程 Cube/HAL 目录 |
| 具体器件 | `STM32F407VET6` / Cube 工程设备族名 `STM32F407V(E-G)Tx` | 已确认 | `vet6_led.ioc` |
| Pack 版本 | 未发现 | 未验证 | 没有 Pack 元数据 |
| Flash Algorithm 版本 | 未发现 | 未验证 | 没有 Pack/FLM 元数据 |
| Init | 没有可检查的 CMSIS-Pack Algorithm | 未验证/无法读取 | 算法文件缺失 |
| UnInit | 没有可检查的 CMSIS-Pack Algorithm | 未验证/无法读取 | 算法文件缺失 |
| EraseChip | 没有可检查的 CMSIS-Pack Algorithm | 未验证/无法读取 | 算法文件缺失 |
| EraseSector | 没有可检查的 CMSIS-Pack Algorithm | 未验证/无法读取 | 算法文件缺失 |
| ProgramPage | 没有可检查的 CMSIS-Pack Algorithm | 未验证/无法读取 | 算法文件缺失 |
| Verify | 没有可检查的 CMSIS-Pack Algorithm | 未验证/无法读取 | 算法文件缺失 |
| 授权 | 未发现授权文件或授权限制；算法本身也未发现 | 未验证 | 未找到 Pack/Algorithm 来源 |
| Windows/native 配合 | 没有算法可供加载或验证；不能宣称可配合 CMSIS-DAP helper | 阻塞 | 当前 Orbit 没有 CMSIS-DAP helper；算法来源缺失 |

### 6.2 与 J-Link 有关但不能替代 CMSIS-DAP Algorithm 的文件

已发现以下 SEGGER/J-Link 资料：

- `C:\Program Files\SEGGER\JLink_V956\JLink_x64.dll`，文件版本 `9.56`；
- `C:\Program Files\SEGGER\JLink_V956\Script\PCode_DevPro_ST_STM32F4.pex`；
- `C:\Program Files\SEGGER\JLink_V956\JLink.exe`、`JFlash.exe` 等 J-Link 工具；
- `C:\Program Files\SEGGER\Ozone\Config\Peripherals\STM32F407IG.svd`，这是外设描述文件，不是 Flash Algorithm。

这些文件属于 J-Link/Ozone 工具链或外设描述，当前没有证据表明它们包含可由 CMSIS-DAP 使用的 `Init`、`UnInit`、`EraseChip`、`EraseSector`、`ProgramPage`、`Verify` Algorithm。不得使用它们的烧录结果冒充 CMSIS-DAP 烧录能力。

### 6.3 DAP-02A 结论

STM32F407VET6 默认烧录所需的 CMSIS-Pack Flash Algorithm 当前没有找到；DAP-02A 为 `阻塞`。需要先登记一个可授权、路径明确、包含上述入口并能在 Windows/native 目标访问层加载的 CMSIS-Pack/Algorithm，才能进入默认烧录实现和验收。

## 7. 测试工程、ELF、DWARF、SVD、FreeRTOS、RTT 信息

### 7.1 可复用测试工程

已发现可复用工程：`D:\STM32\project\vet6_led`。该路径不属于 Orbit 工作区；本次只读登记，没有复制、修改或重构文件。

工程证据：

- `D:\STM32\project\vet6_led\vet6_led.ioc`：`Mcu.CPN=STM32F407VET6`、`Mcu.Package=LQFP100`、`ProjectManager.FirmwarePackage=STM32Cube FW_F4 V1.28.3`、目标工具链为 CMake/GCC；
- `D:\STM32\project\vet6_led\CMakeLists.txt`：Debug 工程、RTT bench/SystemView 选项、P-RTLog 链接片段；
- `D:\STM32\project\vet6_led\build\Debug\CMakeCache.txt`：`CMAKE_BUILD_TYPE=Debug`、Ninja generator、`RTT_BENCH_ENABLE=ON`、`SYSTEMVIEW_ENABLE=ON`、RTT buffer 4096；
- `D:\STM32\project\vet6_led\build\Debug\compile_commands.json`：ARM GCC 编译命令和实际宏/编译选项。

### 7.2 ELF、DWARF、编译器和优化级别

| 项目 | 当前结果 | 状态 | 证据来源 |
|---|---|---|---|
| Debug ELF | `D:\STM32\project\vet6_led\build\Debug\vet6_led.elf`，1,401,264 bytes | 已发现，未验证 | 文件元数据；未重新构建、未下载 |
| ELF 架构 | `elf32-littlearm`，`armv7e-m` | 已确认 | `arm-none-eabi-objdump -f` |
| DWARF | `.debug_info`、`.debug_abbrev`、`.debug_aranges`、`.debug_rnglists`、`.debug_macro`、`.debug_line`、`.debug_str`、`.debug_frame`、`.debug_line_str` 均存在 | 已确认 | `arm-none-eabi-objdump -h` |
| 编译器路径 | `C:\CLionToolchains\gcc-arm-none-eabi-10.3-2021.10\bin\arm-none-eabi-gcc.exe` | 已确认 | `compile_commands.json`、`Get-Command` |
| 当前命令行版本 | Arm GNU Toolchain `13.3.Rel1`，GCC `13.3.1`，build `20240614`；`nm/objdump` 为 `2.42.0.20240614` | 已确认 | `gcc --version`、`nm --version`、`objdump --version` |
| 编译目标选项 | `-mcpu=cortex-m4 -mfpu=fpv4-sp-d16 -mfloat-abi=hard` | 已确认 | `compile_commands.json`、`cmake/gcc-arm-none-eabi.cmake` |
| Debug 优化/调试信息 | `-O0 -g3` | 已确认 | `compile_commands.json`、toolchain file |
| ELF link result | `.text/.data/.bss` 和完整 debug sections 存在；`arm-none-eabi-size` 输出 text=32556、data=44、bss=40300 | 已确认；非当前构建验收 | ELF 只读检查；没有重新运行构建 |

### 7.3 Linker script 和 SVD

- 主 MCU linker script：`D:\STM32\project\vet6_led\STM32F407XX_FLASH.ld`。该路径由 `D:\STM32\project\vet6_led\cmake\gcc-arm-none-eabi.cmake` 的 `CMAKE_EXE_LINKER_FLAGS` 引用。
- P-RTLog linker fragment：`D:\STM32\tool\P-RTLog\scripts\linker\p_rtlog_tokenizer_sections.ld`。这是 token section 链接片段，不是 STM32 Flash Algorithm。
- 测试工程 SVD：`D:\STM32\project\vet6_led\STM32F407VETx.svd`，2,132,383 bytes；器件族名和工程设备覆盖 `STM32F407V(E-G)Tx`。
- 已安装的 Ozone 外设 SVD：`C:\Program Files\SEGGER\Ozone\Config\Peripherals\STM32F407IG.svd`，913,029 bytes；它是 `IG` 型号的外设描述，不能未经确认替代 `VET6` 的目标 SVD。
- Orbit 工作区内没有发现可直接复用的 `.svd` 文件。

### 7.4 FreeRTOS 和 RTT

| 项目 | 当前结果 | 状态 | 证据来源 |
|---|---|---|---|
| FreeRTOS 版本 | `V10.3.1` | 已确认 | `Core/Inc/FreeRTOSConfig.h`、`Middlewares/Third_Party/FreeRTOS/Source/include/task.h` |
| RTOS API 层 | CMSIS-RTOS v1 wrapper（`cmsis_os.h/c`） | 已确认 | 测试工程目录和 `Core/Src/freertos.c` |
| RTOS View 相关配置 | `configUSE_TRACE_FACILITY=1`、`configRECORD_STACK_HIGH_ADDRESS=1`、`configGENERATE_RUN_TIME_STATS=1`；运行时统计使用 DWT CYCCNT | 已确认 | `Core/Inc/FreeRTOSConfig.h` |
| 任务对象 | `defaultTask` stack 256、`myTask02` stack 128；RTT bench task stack 256 | 已确认 | `Core/Src/freertos.c`；RTT task 受 `RTT_BENCH_ENABLE` 控制 |
| RTT implementation | SEGGER RTT；P-RTLog、SEGGER RTT、SystemView 源码均在工程/依赖路径中 | 已发现，未验证 | `CMakeLists.txt`、`Core/Src/rtt_bench.c`、`Core/Src/systemview_config.c` |
| RTT bench buffer | 4096 bytes；固定 64-byte RTTB frame；task source 中每次写入后 `osDelay(10U)` | 已确认；目标运行未验证 | `Core/Inc/rtt_bench.h`、`Core/Src/rtt_bench.c`、Debug CMakeCache |
| RTT Control Block | ELF symbol `_SEGGER_RTT` 地址 `0x20005118`，size `0xA8` | 已确认；只读 ELF 事实 | `arm-none-eabi-nm --defined-only -S -C -p vet6_led.elf` |
| 当前 Orbit 获取方式 | `rttControlBlockAddress` 是可选 launch/config 字段；留空时现有 J-Link 路径交给 J-Link DLL 自动检测 | 已确认（J-Link 路径） | `package.json`、`src/debug/dap-session.ts`、`src/ozone-backend/jlink-dll.ts` |
| CMSIS-DAP RTT 获取方式 | 尚未实现；后续应优先使用已知 ELF symbol/显式地址，不能把 J-Link RTT API 当作 CMSIS-DAP 能力 | 未验证/待后续设计 | 当前源码只有 J-Link RTT API；本任务不实现 CMSIS-DAP RTT |

### 7.5 Watch、Timeline、MemoryView 和 Peripheral Viewer 测试对象

已发现的稳定候选对象：

- 标量/存储区：`g_ram_data`、`g_flash_data`、`g_static_data`；ELF 中地址分别可见为 `0x20000010`、`0x08007B20`、`0x20000014`；
- 指针：`p1`、`p2`、`p3`，源码位于 `D:\STM32\project\vet6_led\Core\Src\freertos.c`；
- 数组：`rtt_bench_buffer[4096]`、`rtt_bench_frame[64]`；
- 计数器：`rtt_bench_attempted_frames`、`rtt_bench_written_bytes`、`rtt_bench_dropped_frames`、`rtt_bench_buffered_bytes`、`rtt_bench_available_bytes`；
- 波形候选：`rtt_bench_demo_value`，源码定义为 0～100 的 2000 ms 三角波，并同时写入 RTTB payload；
- 结构体：HAL 的 `RCC_OscInitTypeDef`、`RCC_ClkInitTypeDef`、`UART_HandleTypeDef` 等存在，但尚未发现专门的稳定全局用户结构体 Watch fixture；
- MemoryView：`.data`、`.bss` 以及上述变量是可登记的候选区域；没有发现独立命名的 MemoryView 专用测试 section，实际读内存未验证；
- Peripheral Viewer：工程包含 GPIOA/PA1、RCC/PLL、TIM14 timebase、USART1；源码中分别可见 `HAL_GPIO_TogglePin(GPIOA, GPIO_PIN_1)`、RCC 时钟配置、TIM14 初始化和 USART1 配置。SVD/Viewer 实际显示未验证。

这些对象适合后续 DAP-05～DAP-08 的 Watch/Timeline/RTT/Viewer 验证，但本次只登记 ELF/源码事实，不读取目标内存，也不宣称变量当前能在板上观察。

## 8. J-Link 基线信息

### 8.1 当前 Orbit owner 和入口

CodeGraph 与源码确认的当前结构：

- `src/ozone-backend/session-target-channel.ts`：`SessionTargetOwner` 统一暴露连接、状态、寄存器/内存、断点、RTT 和 Step 接口；当前 `SessionTargetOwnerKind` 只有 `none`、`native`、`legacy`。
- 同文件的 `SessionTargetSelector` 保证一个 DAP session 选择一个物理 J-Link owner；native 启动失败后，先 `dispose(false)` 等待 helper 退出，再允许 auto 模式创建 legacy owner。
- `src/debugadapter.ts` 创建 `ExperimentalCppJLinkChannel`、`LegacyJLinkTargetChannel`、`SessionTargetSelector`、`OzoneBackend` 和 `DapSession`；当前不存在 CMSIS-DAP owner。
- `src/ozone-backend/cpp-jlink-channel.ts`：native helper 是独立 Windows 子进程，通过 JSON-lines RPC 与 TypeScript 通讯，并由 `NativeScheduler` 按 `control > watch > timeline > background` 调度。
- `native/jlink-helper/src/main.cpp` 和 `native/jlink-helper/CMakeLists.txt`：当前 helper 是 `orbit-jlink-helper`，内部加载 J-Link DLL，不是 CMSIS-DAP helper。

### 8.2 本机安装和历史日志

- J-Link DLL：`C:\Program Files\SEGGER\JLink_V956\JLink_x64.dll`，文件版本 `9.56`。
- Orbit 源码会从 `C:\Program Files\SEGGER\JLink_V*` 中选择排序后的最新 `JLink_x64.dll`，除非显式配置 `orbit.jlinkDllPath`。
- 已有 `outputs/Log/dll.log` / `outputs/Log/dap.log` 在 2026-07-30 记录过一次历史 J-Link Native 会话：`device=STM32F407VE`、helper `orbit-jlink-helper.exe`、`JLINK_Connect OK`、owner=`native`。后续 `readRegister` 在约 5008 ms 超时并记录 `NativeOwnerLost`，因此这只能作为“已有连接日志”，不是无条件通过的稳定基线。
- 本次没有为收集 J-Link 基线重新打开、连接、复位或访问目标；没有新的连接耗时、控制 P95、Watch 成功率或 Timeline 采样率数据。

J-Link 资料只作为后续对照，不得把 J-Link 连接/烧录结果移植成 CMSIS-DAP 能力，也不改变既有 J-Link 配置。

## 9. 已确认事实

- 目标 MCU 为 `STM32F407VET6`；测试工程 `.ioc` 也登记为该 CPN。
- Windows 当前有一个 `CMSIS-DAP_LU` USB 复合设备，`VID_C251/PID_F001`，根设备和两个接口的 PnP 状态为 `OK`，`ProblemCode=0`。
- 该设备存在 HID class 03、`HidUsb` 接口和 CDC class 02、`usbser` 的 `COM15` 虚拟串口。
- 工作区当前 Orbit 只有 J-Link Native/Legacy owner；CMSIS-DAP helper、owner 和 protocol path 尚不存在。
- 可复用测试工程为 `D:\STM32\project\vet6_led`，已有 `vet6_led.elf`、DWARF sections、STM32F407VETx SVD、linker scripts、FreeRTOS 10.3.1 和 RTT bench。
- ELF 中存在 `_SEGGER_RTT`、RTT counters、`rtt_bench_demo_value`、全局数据和 RTT buffer/frame 等后续测试对象。
- 本次检查范围内没有找到 CMSIS-Pack Flash Algorithm；SEGGER/J-Link `.pex`、DLL、J-Link 工具和 SVD 不能替代 CMSIS-DAP Algorithm。
- 当前 Windows 可用 CMake 4.4.0、Node v24.15.0、npm 11.12.1 和 Arm GNU Toolchain 13.3.1；这只说明本地工具可读取/可用于后续构建准备，不证明 CMSIS-DAP helper 或 Flash Algorithm 已可用。

## 10. 未确认事项

- 设备固件版本；USB vendor/product/serial 已通过 HID descriptor 读取，但 CMSIS-DAP `DAP_Info` 对应字符串项为空；
- CMSIS-DAP v2/WinUSB、packet size、packet count、capabilities；CMSIS-DAP v1/HID 和 protocol version `1.0` 已确认；
- 目标板实际 SWD/JTAG 接线和 SWDIO/SWCLK/GND/VTref/NRST 各根线的实物连通性；当前只确认 SWD Debug Port 功能路径；
- 目标板供电方式、DAPLink 是否给目标板供电、IO 电平和 NRST 驱动关系；
- 是否存在第二个调试器或其他探针造成电气/所有权冲突；
- 针对该板和探针的安全 SWD clock range；现有 `4000 kHz` 只是 Orbit/J-Link 默认配置；
- pyOCD/probe-rs 是否能识别该设备；本次未安装或运行它们；Windows HID API 已完成 CMSIS-DAP v1/DAP_Info 和 SWD DP 只读握手；
- 目标板上当前固件是否就是登记的 Debug ELF，以及目标端 RTT/Watch/Peripheral 实际可读性；
- CMSIS-Pack Flash Algorithm 的来源、版本、授权、依赖、入口和 Windows/native 加载可行性；
- 测试工程当前 ELF 是否由本次采集时刻重新构建；本次只检查现有产物，没有运行构建。

## 11. 阻塞项

1. **实物连接资料部分缺失**：SWD 功能路径已由 DP IDCODE `0x2BA01477` 确认，但板卡接线、供电、NRST、第二调试器和电气安全仍需实物/资料确认。
2. **packet 能力部分缺失**：CMSIS-DAP v1/HID 和 protocol version `1.0` 已确认；`DAP_Info` 未返回有效 packet size/count、capabilities 和固件版本。
3. **默认烧录算法缺失**：没有发现可用于 STM32F407VET6 的 CMSIS-Pack/`.FLM`，DAP-02A 不能以现状开始默认烧录实现。
4. **当前 Orbit 不识别 CMSIS-DAP owner**：这是 DAP-01 及之后的实现输入，不是本次允许修改的内容。

## 12. 后续 DAP-01、DAP-02、DAP-02A 的输入建议

### DAP-01：通用 owner 和配置骨架

- 针对当前已枚举硬件，优先登记和设计 HID transport；不要把 `COM15` 当调试控制通道。
- Owner 应继续保持“一次 DAP session 一个 physical owner”，不能因为 CMSIS-DAP 失败而在同一 session 并存或热切换到第二个 J-Link owner。
- 下一步优先实现 CMSIS-DAP v1/HID；当前设备没有 WinUSB 证据，不能把 `cmsisDapTransport=WinUSB` 写成已确认配置。
- 目标配置使用 `STM32F407VET6`，SWD 功能路径已确认；物理时钟范围仍未验证，不能从现有 J-Link 默认 `4000 kHz` 推导 DAPLink 推荐值。

### DAP-02：CMSIS-DAP helper 和 transport

- 已采集 `DAP_Info`、protocol version、HID report length 和 endpoint/driver 证据；后续仍需处理 packet size/count/capabilities 空响应，并把 HID/WinUSB framing 分开实现。
- 需要记录设备移除、超时和 owner loss；CDC 虚拟串口独立保留，不与调试 command channel 复用。
- 当前测试工程的 ELF、SVD 和稳定 RTT symbol 可作为离线/后续硬件测试输入，但不能替代真实 DAP handshake。

### DAP-02A：CMSIS-DAP 默认烧录

- 先取得并登记 STM32F407VET6 对应 CMSIS-Pack/Flash Algorithm 的明确路径、Device Family、器件覆盖、版本、授权和依赖。
- 逐项确认 `Init`、`UnInit`、`EraseChip`、`EraseSector`、`ProgramPage`、`Verify`；确认后才能定义默认 `flashBeforeDebug=true` 的 CMSIS-DAP 行为。
- 在 Algorithm 到位前只能支持“资料登记/后续能力设计”，不能用 J-Link 烧录成功、预烧录调试成功或已有 ELF 冒充 CMSIS-DAP 默认烧录通过。

## 13. 证据来源和采集时间

采集时间：初始资料 `2026-08-03 13:32:59 +08:00`；真实硬件补充验证 `2026-08-03 14:33:36 +08:00`。文件修改时间和历史日志时间在各条事实中单独保留。

### Orbit 工作区

- `C:\Users\22690\Desktop\AI\Ozone for VScode\AGENTS.md`
- `C:\Users\22690\Desktop\AI\Ozone for VScode\docs\cmsis-dap-daplink-support-project-plan.md`
- `C:\Users\22690\Desktop\AI\Ozone for VScode\src\ozone-backend\session-target-channel.ts`
- `C:\Users\22690\Desktop\AI\Ozone for VScode\src\debugadapter.ts`
- `C:\Users\22690\Desktop\AI\Ozone for VScode\src\debug\dap-session.ts`
- `C:\Users\22690\Desktop\AI\Ozone for VScode\src\debug\ozone-debug-config.ts`
- `C:\Users\22690\Desktop\AI\Ozone for VScode\src\ozone-backend\cpp-jlink-channel.ts`
- `C:\Users\22690\Desktop\AI\Ozone for VScode\src\ozone-backend\jlink-dll.ts`
- `C:\Users\22690\Desktop\AI\Ozone for VScode\native\jlink-helper\src\main.cpp`
- `C:\Users\22690\Desktop\AI\Ozone for VScode\native\jlink-helper\CMakeLists.txt`
- `C:\Users\22690\Desktop\AI\Ozone for VScode\outputs\Log\dll.log`
- `C:\Users\22690\Desktop\AI\Ozone for VScode\outputs\Log\dap.log`

### Windows USB/PnP 只读采集

- `Get-PnpDevice -PresentOnly`：枚举根设备、HID interface、Ports interface；
- `Get-PnpDeviceProperty`：读取 `DEVPKEY_Device_BusReportedDeviceDesc`、`Manufacturer`、`Service`、`HardwareIds`、`CompatibleIds`、`ProblemCode`、`InstallState`；
- `Get-CimInstance Win32_SerialPort`：确认 `COM15`；
- 结果只表明 Windows 枚举和驱动安装状态，不表明目标板已连接或 CMSIS-DAP protocol handshake 已成功。

### DAP-00 只读采集脚本

- 脚本：`C:\Users\22690\Desktop\AI\Ozone for VScode\scripts\cmsis-dap\collect-dap00.ps1`
- 运行命令：
  `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\cmsis-dap\collect-dap00.ps1 -OutputPath .\outputs\dap00\collect-dap00-20260803-rework.json`
- 本次结果文件：`C:\Users\22690\Desktop\AI\Ozone for VScode\outputs\dap00\collect-dap00-20260803-rework.json`（`outputs/` 被 `.gitignore` 忽略）
- 重复运行命令使用同一脚本，仅更换输出路径；结果文件：`C:\Users\22690\Desktop\AI\Ozone for VScode\outputs\dap00\collect-dap00-20260803-rework-second.json`。两次结果的 HID、VID/PID、product、serial、report length 和 protocol version 均一致；packet size 两次均为 `UNVERIFIED`。
- 脚本交付状态：`已确认`。脚本不依赖 J-Link/OpenOCD，只进行 PnP、Windows HID descriptor/string/report capability 读取和 CMSIS-DAP `DAP_Info`；无法读取的值写为 `UNVERIFIED`。
- 脚本安全边界：不调用 `DAP_Connect`、`SWJ_Pins`、`SWJ_Clock`、reset、halt、run、step、breakpoint、目标内存/寄存器读写、flash、erase 或 verify。
- `DPIDR=0x2BA01477` 的来源是此前用户授权的一次性只读 HID 验证，不是本脚本本次输出；为避免返工脚本触碰目标调试状态，本脚本有意不重复该步骤。

### 测试工程和工具

- `D:\STM32\project\vet6_led\vet6_led.ioc`
- `D:\STM32\project\vet6_led\build\Debug\vet6_led.elf`
- `D:\STM32\project\vet6_led\build\Debug\CMakeCache.txt`
- `D:\STM32\project\vet6_led\build\Debug\compile_commands.json`
- `D:\STM32\project\vet6_led\cmake\gcc-arm-none-eabi.cmake`
- `D:\STM32\project\vet6_led\STM32F407XX_FLASH.ld`
- `D:\STM32\project\vet6_led\STM32F407VETx.svd`
- `D:\STM32\project\vet6_led\Core\Inc\FreeRTOSConfig.h`
- `D:\STM32\project\vet6_led\Core\Src\freertos.c`
- `D:\STM32\project\vet6_led\Core\Inc\rtt_bench.h`
- `D:\STM32\project\vet6_led\Core\Src\rtt_bench.c`
- `D:\STM32\project\vet6_led\Core\Src\systemview_config.c`
- `arm-none-eabi-objdump -f/-h`、`arm-none-eabi-nm --defined-only -S -C -p`、`arm-none-eabi-size`：只读检查 ELF/DWARF/符号/大小；
- `Get-Command cmake,ninja,node,npm,arm-none-eabi-gcc,arm-none-eabi-nm,arm-none-eabi-objdump,pyocd,probe-rs,JLink.exe`：只读检查本机工具路径和版本。

本文件是 DAP-00 登记结果，不是 DAP-01、DAP-02 或 DAP-02A 的实现验收记录。

## 14. 历史真实硬件补充验证（2026-08-03 14:33:36 +08:00）

本节记录此前用户授权后进行的最小硬件验证，补充并更新前文在未授权目标操作时形成的 `未验证` 状态。它是 DAP-00 的历史证据，不代表本次返工重新操作目标板。验证通过 Windows HID API 直接访问当前 HID interface；没有修改工作区源码、没有新增 helper，也没有使用 J-Link 结果替代 CMSIS-DAP 结果。

### 14.1 HID 描述符和 CMSIS-DAP v1

| 项目 | 结果 | 状态 | 证据 |
|---|---|---|---|
| HID device path | `\\?\hid#vid_c251&pid_f001&mi_02#8&304b7d8&0&0000#{4d1e55b2-f16f-11cf-88cb-001111000030}` | 已确认 | Windows SetupAPI HID interface enumeration |
| HID VID/PID | `C251:F001` | 已确认 | `HidD_GetAttributes` |
| HID descriptor version field | `0x0100` | 已确认；不是 firmware version | `HidD_GetAttributes.VersionNumber` |
| HID manufacturer/product/serial | `jixin.pro` / `CMSIS-DAP_LU` / `LU_2022_8888` | 已确认 | `HidD_GetManufacturerString`、`HidD_GetProductString`、`HidD_GetSerialNumberString` |
| HID report length | Input=`65`、Output=`65`、Feature=`2` bytes | 已确认 | `HidD_GetPreparsedData` + `HidP_GetCaps` |
| CMSIS-DAP protocol version | `1.0` | 已确认 | `DAP_Info(0x04)` response：`00 00 04 31 2E 30 ...`（第 1 字节为 HID report ID） |
| Vendor/Product/Serial 的 CMSIS-DAP `DAP_Info` 项 | 返回零长度，未取得有效协议层字符串 | 未验证 | `DAP_Info(0x01/0x02/0x03)` 原始 response |
| Firmware version | 返回零长度 | 未验证 | `DAP_Info(0x09)` 原始 response |
| Capabilities | 返回零长度 | 未验证 | `DAP_Info(0x0A)` 原始 response |
| CMSIS-DAP packet count | 返回零长度 | 未验证 | `DAP_Info(0x0E)` 原始 response |
| CMSIS-DAP packet size | 返回零长度；不能把 HID report length 65 直接等同于 packet size 字段 | 未验证 | `DAP_Info(0x0F)` 原始 response |

`HidD_SetOutputReport` 和重叠 `ReadFile` 均成功完成 65 字节 report 往返；因此当前设备不是“只有 PnP 枚举而没有可访问协议”的状态。空响应项仍保留为 `未验证`，没有用响应尾部的非协议数据猜测固件、packet 或 capability 值。

### 14.2 SWD Debug Port 只读握手

执行顺序和结果：

1. `DAP_Connect(SWD)`：HID report 请求 `00 02 01 ...`，响应的 CMSIS-DAP 部分为 `02 01`，SWD port 选择成功。
2. `DAP_Transfer` 只读 DP IDCODE：请求为 DAP index 0、transfer count 1、request `0x02`（DP read，IDCODE）；响应的 CMSIS-DAP 部分为 `05 01 01 77 14 A0 2B`，transfer response=`DAP_TRANSFER_OK`，读取到 `DPIDR=0x2BA01477`。
3. `DAP_Disconnect`：已执行，未执行 reset、halt、run、step 或任何目标状态命令。

结论：当前探针和目标之间已确认存在可用的 SWD Debug Port 路径。该结果不能单独确认 NRST、目标供电来源、DAPLink 是否给目标供电、第二调试器或各根线的物理连接；这些仍为 `待硬件确认`。

### 14.3 外部 OpenOCD 一次性诊断

使用本机 `C:\CLionToolchains\OpenOCD-20231002-0.12.0\bin\openocd.exe`（版本 `0.12.0`）做了一次性 transport 诊断，未加载 `target/stm32f4x.cfg`，未执行烧录。命令选择 `cmsis-dap`、VID/PID `C251:F001`、SWD 和 `1000 kHz`；输出确认读到 product string `CMSIS-DAP_LU`，随后 bulk backend 在 interface/endpoint 选择处报告：interface 0 endpoint 数不足、interface 1 class `10` 被跳过、interface 2 不是 bulk out。`init` 未返回成功的 target 结果而卡住，进程已终止。

该诊断只说明 OpenOCD 的这次 bulk backend 路径未完成，不推翻 Windows HID/CMSIS-DAP v1 直接证据，也不能作为 Orbit 支持或烧录能力结论。OpenOCD 仅作为外部诊断工具，不是 Orbit 的正常 debug-control 路径。

### 14.4 此前授权验证的硬件操作边界

- 已执行：HID descriptor/string/report-capability 读取、CMSIS-DAP `DAP_Info`、`DAP_Connect(SWD)`、一次 DP IDCODE 只读 transfer、`DAP_Disconnect`。
- 未执行：目标板 reset、halt、run、step、breakpoint、烧录、擦除、校验、目标内存读写、CPU/外设寄存器读写、`SWJ_Pins`、`SWJ_Clock`。
- 结论：此前验证未执行目标板状态修改或目标内存/寄存器访问；本次返工同样未重复执行目标板操作。

### 14.5 对 DAP-01、DAP-02、DAP-02A 的状态更新

- DAP-01 transport：可以开始，优先支持 `CMSIS-DAP v1 + HID`；当前探针的真实 `DAP_Info` 和 SWD DP handshake 已有证据。
- DAP-01 owner：当前 Orbit 仍只有 J-Link Native/Legacy owner，CMSIS-DAP owner/helper 尚不存在；这是实现阻塞，不在 DAP-00 修改。
- DAP-02 packet：HID report 长度为 65，但协议层 packet size/count/capabilities/firmware 项为空响应，需在 helper 设计中保留“设备未提供/无法读取”路径。
- DAP-02A Flash Algorithm：STM32F407VET6 对应 CMSIS-Pack/`.FLM` 仍未找到，`Init`、`UnInit`、`EraseChip`、`EraseSector`、`ProgramPage`、`Verify` 仍不能确认；默认 CMSIS-DAP 烧录继续阻塞。

## 15. DAP-01 开始条件

本节只登记后续输入，不在本次返工实现 DAP-01。

| 条目 | 当前结论 | 状态 | 证据/前置条件 |
|---|---|---|---|
| 当前 transport 首选 | `CMSIS-DAP v1/HID` | 已确认 | HID interface、HID report 往返、`DAP_Info(0x04)=1.0` |
| 当前目标 | `STM32F407VET6` | 已确认 | 用户指定；`D:\STM32\project\vet6_led\vet6_led.ioc` |
| 当前 Orbit owner | CMSIS-DAP owner 尚未实现；现有 owner 仍为 J-Link Native/Legacy | 已确认 | `SessionTargetOwner` / `SessionTargetSelector` 源码分析 |
| DAP-01 第一输入 | 设计并实现 HID helper framing，并先覆盖 `DAP_Info` | 已发现，未验证 | 仅作为 DAP-01 输入建议；本次不实现 |
| 默认烧录 DAP-02A | 当前不能开始 | 阻塞 | STM32F407VET6 CMSIS-Pack/Flash Algorithm 缺失 |
| DAP-02A 开始前必须提供 | Flash Algorithm 文件、Device Family/器件覆盖、版本、绝对路径、授权和依赖确认 | 阻塞 | 需找到并逐项确认 `Init`、`UnInit`、`EraseChip`、`EraseSector`、`ProgramPage`、`Verify` |
| `flashBeforeDebug: true` | 默认策略保持阻塞，不得宣称 CMSIS-DAP 默认烧录通过 | 阻塞 | Flash Algorithm 尚未确认 |
| `flashBeforeDebug: false` | 只能作为预烧录调试分支的设计输入，不表示烧录能力完成 | 已发现，未验证 | 仍需 DAP-01/DAP-02 后续实现和单独验收 |

收口结论：DAP-00 为 `条件通过`；DAP-01 可以在后续任务开始，但本任务到此为止，不开始 DAP-01 或任何后续 CMSIS-DAP 实现。

## 16. DAP-02-HID helper 集成状态（2026-08-03）

本节登记 DAP-02 第一子阶段（有线 CMSIS-DAP v1/HID helper、framing、握手与最小 owner 连接）的实现与验证状态。DAP-02A、DAP-03、DAP-04 未开始，不在此节标记完成。

### 16.1 实现状态

| 项目 | 结果 | 状态 | 证据 |
|---|---|---|---|
| 独立 helper 目录 | `native/cmsis-dap-helper/`：CMakeLists、main.cpp、json_rpc、cmsis_dap_transport、cmsis_dap_hid_transport、mock_transport、cmsis_dap_protocol | 已确认 | 源码存在；`scripts/build-native.ps1 -Project all` 构建 |
| helper 产物 | `out/native/win32-x64/orbit-cmsis-dap-helper.exe`（MSVC 19.51 构建，cxx_std_17，链接 hid/setupapi） | 已确认 | `npm run build:native` 输出 |
| JSON-lines RPC | `{"id","method","params"}` → `{"id","result":{ok,message,targetState,elapsedMs,data?,errorCode?,diagnostics?}}`；hello 报 protocol=1、helperVersion、capabilities | 已确认 | helper 冒烟输出；`src/ozone-backend/cmsis-dap-helper-channel.ts` |
| HID transport | SetupAPI(HIDClass GUID)+HidD 枚举、VID/PID/serial/product/path 过滤、preparsed data/report capabilities、overlapped I/O、超时 CancelIoEx、拔出检测、report ID framing、长包拒绝 | 已确认 | `cmsis_dap_hid_transport.{h,cpp}` |
| packet size 规则 | `DAP_Info(0x0F)` 提供 → `packetSizeSource: protocol-info`；空响应 → `hid-report-capability`（用 HID report 长度-1，不冒充协议值）并记录 `protocolPacketSize: null`；都不可用 → `unavailable` | 已确认 | `cmsis_dap_protocol.cpp`；mock 空字段设备验证 |
| 握手命令 | `DAP_Info`（8 项）、`DAP_Connect(SWD/JTAG)`（3 字节响应、status=0、返回实际端口）、`DAP_Disconnect`（2 字节、status=0）；错误 command id/长度/status/超时/空响应均结构化报错 | 已确认 | `cmsis_dap_protocol.{h,cpp}`；mock 矩阵 |
| mock transport | 5 种内置行为设备（normal/empty-info/corrupt/silent/report-id-1），`--transport=mock` 启用 | 已确认 | `mock_transport.{h,cpp}`；`npm run test:cmsis-dap:mock` |
| TypeScript owner | `CmsisDapHelperClient`（spawn/超时/异常退出检测/dispose）+ `CmsisDapTargetChannel`（winusb→UnsupportedCapability、auto→HID、失败清理 owner、对称 disconnect） | 已确认 | `src/ozone-backend/cmsis-dap-helper-channel.ts`、`session-target-channel.ts`；vitest 11 项 |
| 构建集成 | `npm run build:native` 同时构建 J-Link 与 CMSIS-DAP helper；新增 `npm run test:cmsis-dap:mock` | 已确认 | `scripts/build-native.ps1`、`package.json` |

### 16.2 自动化验证结果（2026-08-03）

| 命令 | 结果 |
|---|---|
| `npm test -- --run src/debug/dap-launch-config.test.ts src/debug/dap-session-native-executor.test.ts src/ozone-backend/session-target-channel.test.ts src/ozone-backend/commander-session-owner.test.ts` | 4 文件 31 项通过 |
| `npm run typecheck` | 通过 |
| `npm test` | 20 文件 112 项通过 |
| `npm run build` | 通过 |
| `npm run build:native` | 通过（两个 helper） |
| `npm run test:cpp-channel:mock` | 通过（J-Link 链路无回归） |
| `npm run test:cmsis-dap:mock` | 全部断言通过（25 项检查） |
| `git diff --check` | 通过 |

### 16.3 真实硬件验证状态（2026-08-03，已授权执行；2026-08-03 返工后重验）

用户已授权对 `D:\STM32\project\vet6_led` 目标板执行 DAP-02 硬件验证。验证通过 `orbit-cmsis-dap-helper.exe`（helper PID=34904 首次、PID 以重验时输出为准）驱动 `scripts/cmsis-dap-smoke.js --transport=hid --hardware` 完成。本次执行严格限定为低风险操作（USB/HID 枚举、`DAP_Info`、`DAP_Connect(SWD)`、`DAP_Disconnect`）；未执行 reset/halt/run/step/断点/SWJ_Pins/SWJ_Clock/目标内存与寄存器读写/flash/erase/verify。

**返工说明（2026-08-03）**：协议层返工修正了 DAP_Info 的官方 ID（Capabilities=0xF0、Packet Count=0xFE、Packet Size=0xFF）与官方响应布局（`[0x00][len][data]` 无 info id 回显）后重新执行硬件验证。**首次验证时因使用错误的 ID（0x0F）查询 Packet Size，误判为“设备未提供 packet size”；改用官方 ID 0xFF 后设备返回 packet size=64，packetSizeSource 从 hid-report-capability 修正为 protocol-info。**

| 项目 | 结果 |
|---|---|
| device path | `\\?\hid#vid_c251&pid_f001&mi_02#8&304b7d8&0&0000#{4d1e55b2-f16f-11cf-88cb-001111000030}`（helper 枚举 path 与 DAP-00 一致） |
| VID/PID | `C251:F001` |
| product/serial | `CMSIS-DAP_LU` / `LU_2022_8888` |
| HID report length | Input `65`、Output `65`（含 report id 字节），reportId=0，有效 payload 64 字节 |
| 输出路径 | overlapped `WriteFile`（interrupt-out）在 CMSIS-DAP_LU 上超时；CancelIoEx 等待取消完成后回退 `HidD_SetOutputReport`（control transfer）成功，并记住该设备只用 control-transfer 输出 |
| DAP_Info 原始结果 | vendor/product/serial/firmware/capabilities/packetCount 为空项（`[0x00][len=0]`）；`protocolVersion="1.0"`；**`packetSize=64`（官方 ID 0xFF，SHORT LE `40 00`，packetSizeSource=protocol-info）** |
| 响应格式确认 | 该固件符合官方布局 `[0x00][len][data]`（无 info id 回显；字符串含 NUL 终止符）；DAP_Connect 响应 `[0x02][Port]`；DAP_Disconnect 响应 `[0x03][Status]`；输入报告尾部保留历史残留字节，协议层以“前缀解析 + command id 校验 + open 后排空 + 单次重读”处理 |
| protocol version | `1.0` |
| packet size | 设备真实提供 `64`（官方 ID 0xFF）；`protocolPacketSize=64`、`packetSizeSource=protocol-info`、`effectivePacketSize=64` |
| DAP_Connect(SWD) 返回值 | 成功；官方 `[0x02][0x01]`，`connectResponse=1`（SWD），如实报告不伪造 |
| DAP_Disconnect 返回值 | 成功；`[0x03][0x00]`（DAP_OK） |
| 超时/拔出事件 | 无设备拔出；首次 interrupt-out 写超时后取消确认完成再切 control-transfer（已优化为记住设备特性，后续请求 1-2ms） |
| 设备状态异常记录 | 首次硬件会话后设备固件曾进入异常状态（所有 DAP_Info 返回残留内容），用户重新插拔 USB 后恢复正常；独立 PowerShell 采集脚本与 helper 结果一致，证明非 helper 缺陷 |

结论：DAP-02-HID 返工后真实硬件验证通过（四项低风险操作，其中 DAP_Info 在官方 ID 下确认设备真实提供 packet size=64）。未执行任何目标板状态修改操作；`DAP_Transfer`、DP/AP、Cortex-M 控制、内存访问、烧录等仍属后续阶段，未在本阶段验证。
