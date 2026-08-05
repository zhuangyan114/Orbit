---
name: daplink-debug-fix
description: Use whenever a task mentions DAPLink, CMSIS-DAP, CMSIS-DAP HID or WinUSB, DAP_Transfer, SWD, DP/AP, Cortex-M over a CMSIS-DAP probe, STM32 Flash Algorithm, pyOCD, or OpenOCD as a reference. Apply this skill before inspecting, changing, diagnosing, or verifying any wired or wireless DAPLink target path, including owner routing, Flash, Watch, Timeline, RTT, RTOS View, MemoryView, and Peripheral Viewer.
---

# CMSIS-DAP/DAPLink 准则

本准则适用于 Orbit for VS Code 中所有 CMSIS-DAP/DAPLink 工作。它覆盖有线 HID、WinUSB、未来无线 DAPLink、SWD/DP/AP、Cortex-M 控制、Flash Algorithm、Watch、Timeline、RTT 和 Viewer。J-Link 专属问题仍使用 `ozone-debug-fix`；同时涉及两条链路时，分别遵守两套规则。

## 核心原则

CMSIS-DAP 是调试协议，DAPLink 是实现该协议的探针固件/产品。`DAP_Connect` 成功不等于目标 DP 已经响应；mock、连接握手和一次内存读取都不能单独证明硬件调试或烧录通过。

所有结论按以下层级分别报告：

1. 代码路径和 owner 路由。
2. mock/raw-frame/单元测试。
3. 构建、类型检查和回归测试。
4. 授权后的真实硬件。
5. 长时间、性能和断线恢复验证。

缺少某一层时，不得用上一层的通过结果代替它。

## 强制前置检查

1. 先阅读仓库 `AGENTS.md`、本技能和 `ozone-debug-fix`；确认任务属于诊断、修改还是验收。
2. 修改前执行 `git status --short`，保留用户已有改动，不修改 `dist/`，不提交 Git。
3. 结构化调用关系优先使用 CodeGraph；配置、文档、日志和 raw trace 使用直接读取或 `rg`。
4. 在提出修复前保存最小复现：helper RPC、DAP raw frame、日志、mock trace 或硬件证据。
5. 记录当前 session 的 physical owner、target owner、native/legacy 路径和是否存在活动 DAP session。

## Owner 和路由不变量

- `probe: 'cmsis-dap'` 只能创建 CMSIS-DAP native helper owner，禁止构造或回退 J-Link owner。
- 一个调试 session 只能有一个 physical owner；Flash、DAP、Watch、Timeline、RTT 和 Viewer 必须复用它。
- 不通过 OpenOCD、GDB server、`JLink.exe` 或第二个 helper 绕过活动 owner。
- helper 启动失败和 CMSIS-DAP 能力错误必须返回结构化错误；不得静默切换到 J-Link。
- 目标访问必须经过 `NativeScheduler`：`control > watch > timeline > background`。
- halt/run/reset/step、断点、Flash 和变量写入是 control；控制临界区必须暂停低优先级读取。
- Watch、Timeline、RTT 和 Viewer 的失败不能触发第二条目标访问路径。

## 协议和传输检查

协议层必须以 CMSIS-DAP 官方布局为准，不能根据某个 mock 或某个探针固件臆造格式：

- `DAP_Transfer = 0x05`，`DAP_TransferBlock = 0x06`。
- Transfer Request：bit0=APnDP、bit1=RnW、bit3:2=A[3:2]。
- Transfer 响应为 command、completed count、一个 Transfer Response status、read data。
- TransferBlock 的 count 是 little-endian 16 位，status 位于数据前。
- ACK、Protocol Error、Value Mismatch、保留位和长度必须严格校验。
- unknown/timeout/设备移除后的写请求不得自动重试，因为完成状态未知。
- HID report 长度、report ID、协议 packet size 和尾部 padding 必须分开记录；不能把 HID report 长度伪装成协议 packet size。
- `DAP_Connect` 成功后仍必须单独验证 DPIDR、CTRL/STAT 和 DP/AP ACK。

真实设备出现短响应、尾部残留、仅 control-transfer 输出或 stale latch 时，先保存 raw trace，再做最小的协议兼容；兼容逻辑必须有独立 mock 覆盖，并且不能降低官方帧校验严格度。

## SWD、DP/AP 和 Cortex-M

- 先确认 DPIDR；STM32F407VET6 基线为 `0x2BA01477`。
- DP power-up、SELECT、ABORT、MEM-AP CSW/TAR/DRW 和 RDBUFF 必须记录 request、response、ACK、重试次数和 elapsedMs。
- STM32F4 32-bit/single auto-increment 的 CSW 基线是 `0x12`：Size bits[2:0]=`0b010`，AddrInc bits[5:4]=`0b01`。
- AP read pipeline 中 dummy AP DRW + RDBUFF 返回的首字必须保留；后续 block read 只能读取下一个 TAR word。
- WAIT/FAULT 必须有界重试；FAULT 先 ABORT 清 sticky；NO_ACK、MalformedResponse、DeviceRemoved 直接传播。
- Cortex-M algorithm/control 入口必须检查 PC、LR、SP、xPSR、DHCSR、DCRSR/DCRDR 和必要的 fault status；Thumb 入口和返回地址的 bit0 不能凭感觉设置，需与实际指令和 CMSIS-Pack ABI 对照。
- 读到 DHCSR 不代表 algorithm 已完成；必须确认 halted、返回地址、返回值和 operation。

## Flash 和芯片适配

Flash 属于 DAP-02A，不是 CMSIS-DAP 通信层的自动能力。首版目标为 STM32F407VET6；优先使用 CMSIS-Pack Flash Algorithm 和数据驱动的型号描述。

- 应用 ELF 的 `.data` 保留 `p_vaddr` 作为 SRAM 运行地址、`p_paddr` 作为 Flash LMA；Program、Verify、read-back 和擦除范围使用 LMA。
- `.bss` 不产生 Flash 数据；所有 PT_LOAD 段必须检查 offset、filesz、memsz、溢出、越界和重叠。
- 擦除前先验证芯片 ID、Flash size、算法存在性、RAM 布局和所有段范围；不得默认 mass erase。
- `flashBeforeDebug: true` 必须使用当前 CMSIS-DAP owner 完成 erase/program/verify；任一步失败都失败退出，不回退 J-Link。
- `flashBeforeDebug: false` 不得调用 Flash、verify 或烧录专用 reset。
- 对 STM32F407VET6 记录 Flash base、容量、sector map、algorithm code、static_base、stack 和 page buffer；地址不能越过目标 SRAM。
- OpenOCD、pyOCD、CMSIS-Pack 和 ST RM0090 只能作为行为、ABI、扇区和错误处理参考。不得直接复制 GPL 代码或许可证不明的二进制；报告版本、来源和许可证判断。
- Flash Program/Erase 的 timeout、busy、保护错误、verify mismatch、取消和设备移除必须有结构化错误；写完成状态未知时不得重试同一编程操作。

## Watch、Timeline、RTT 和 Viewer

这些功能共享物理 owner，但必须保持逻辑隔离：

- Watch 是高优先级读，必须归一化表达式、遵守 DAP owner 和 generation fence。
- Timeline 是可取消的采样流，不能因为一次采样失败切换到 extension-host backend。
- RTT 是 background 轮询，控制操作必须暂停它并在结束后恢复；不得把 SWO 自动当作 RTT。
- RTOS View、MemoryView、Peripheral Viewer 必须使用标准 DAP `variables`、`memoryReference`、`readMemory` 和 SVD/ELF 信息。
- Viewer/RTT/Timeline 的 mock 通过不代表真机吞吐、实时性或长期稳定通过。

## 硬件授权边界

没有用户明确授权，不得执行 target-mutating 操作。以下操作均需单独记录授权范围：reset、halt、run、step、断点、RAM 写、Flash erase/program/verify、Option Bytes 和复位线控制。

真实硬件报告必须包含 VID/PID、serial、transport、report 信息、helper PID、owner、目标电源/VTref、DPIDR、targetState、完整 raw trace 摘要和错误码。`NO_ACK` 首先按供电、VTref、SWD 线序、NRST、SWJ 初始化、时钟和探针状态排查，不要继续改 CoreDebug 或 Flash 算法。

Flash 真机验证必须分级：只读连接/ID → RAM stub → Init/UnInit → 明确授权的测试扇区 → 具体 ELF 的擦除编程校验。没有最后一级证据，不得宣称默认烧录可用。

## 验证顺序

按风险逐步验证：

1. focused unit/raw-frame/mock。
2. `npm run typecheck`、`npm test`、`npm run build`。
3. `npm run build:native`、CMSIS-DAP mock、J-Link mock 回归。
4. helper selftest 和 `git diff --check`。
5. 经过授权的真机操作。
6. 断线、helper crash、取消、session replacement 和长稳测试。

mock 必须独立维护协议 oracle；不得只用 production 常量和同一错误模型验证自己。硬件失败时保留失败证据，不用重新插拔后的成功结果覆盖历史失败。

## 常见错误

| 错误判断 | 正确判断 |
|---|---|
| DAP_Connect 成功就是调试连接成功 | 仍需 DPIDR、CTRL/STAT 和 DP/AP ACK |
| mock 内存读成功就是硬件通过 | 还需真实目标和完整时序证据 |
| DAPLink 每个芯片都要重写传输层 | 通信和 Cortex-M 层复用，Flash/SVD/内存参数按型号或家族适配 |
| OpenOCD 可以直接当生产后端 | 只能作为参考，除非明确设计外部 backend 并处理 owner/进程边界 |
| `.data` 的 p_vaddr 就是烧录地址 | p_vaddr 是运行地址，p_paddr 通常是 Flash LMA |
| waitForHalt 超时只能修超时 | 先区分入口、Flash busy、fault、返回地址和 BKPT 失败 |
| 读取一个变量成功就是 Watch 通过 | 还需 owner 路由、运行态采样、调度公平和 session fence |

## 报告模板

```text
结论: <未实现/代码通过/真机通过/被阻塞>
阶段: <DAP-02-HID/DAP-03/DAP-02A/DAP-04/DAP-06...>
Owner/路由: <probe、owner、helper、是否有第二 owner>
证据: <代码、mock、构建、硬件、长稳，分层列出>
关键 trace: <DPIDR、ACK、PC、DHCSR、Flash operation、错误码>
风险/缺口: <未验证层和已知设备限制>
下一步: <最小可执行动作>
硬件授权: <未执行/已授权范围/未授权操作>
```

不要更新 `docs/bug-fix-log.md`，除非用户明确确认修复；不要把计划状态、mock 通过或一次真机读成功写成完整 DAPLink 支持。
