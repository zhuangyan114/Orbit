# DAP-02A Flash 启动速度后续优化记录

## 文档目的

本文记录 STM32F407VET6 CMSIS-DAP Flash 启动速度的现状、已完成工作和后续优化方向，供后续继续开发时使用。

本文不改变当前默认语义：

- `flashBeforeDebug: true` 必须完成预检、擦除、编程、验证、复位和进入调试。
- 所有 Flash 工作必须复用同一个 CMSIS-DAP helper 和 physical owner。
- Flash 必须保持 `NativeScheduler` 的 control 临界区。
- 不使用 OpenOCD、J-Link 或第二个 owner 作为 CMSIS-DAP 运行时后端。
- 任何跳过 Flash 的策略都不能只依赖主机缓存中的 ELF hash。

## 当前基线

目标：STM32F407VET6，512 KiB Flash，当前项目 ELF 为 `vet6_led.elf`。

最近一次真机日志显示，Flash 从连接到完成约 7 秒，用户从点击调试到进入停止态约 9 秒：

| 阶段 | 最近耗时 |
| --- | ---: |
| helper 启动、HID 打开、CMSIS-DAP 连接 | 约 0.45 s |
| 初始 halt | 约 0.03 s |
| `Init` | 409 ms |
| `EraseSector` x2 | 975 ms |
| `ProgramPage` 16 KiB | 1876 ms |
| `Verify` 16 KiB | 271 ms |
| `ProgramPage` 16180 B | 1859 ms |
| `Verify` 16180 B | 271 ms |
| `ProgramPage` 44 B | 278 ms |
| `Verify` 44 B | 272 ms |
| `UnInit` | 272 ms |
| reset、halt 和调试会话初始化 | 约 1 s 以上 |

当前最主要的固定开销是两次 16 KiB page buffer 上传，合计约 3.7 秒。单个 HID report 为 65 字节，其中 1 字节为 report ID，协议 packet size 为 64 字节；当前探针为 `CMSIS-DAP_LU`，transport 为 HID，launch 配置为 1000 kHz SWD。

## 已完成的传输层优化

当前实现已经完成以下优化，后续不要重复实现同一方向：

- 使用 `DAP_TransferBlock` 批量传输连续内存。
- 合并起点处的 `SELECT`、`CSW`、`TAR`、`DRW` 和 `RDBUFF` 操作。
- 连续写入时复用 TAR，仅在起点、边界或安全重试时重新设置 TAR。
- 使用 64 字节 packet 中最多 14 个 32-bit word 的有效载荷。
- 对成功完成的 algorithm operation 跳过冗余的 after snapshot。
- 缓存单次 debug session 内的 algorithm code。
- 复用 ProgramPage 后的 page buffer 进行 Verify。
- 对可能已经写入的数据不自动重试，避免写入结果未知时重复 ProgramPage。
- Flash 全流程由一个 control critical section 排他执行。

优化前后的 mock packet 基线如下：

| 操作 | 优化前 | 当前 |
| --- | ---: | ---: |
| 单 word read | 5 packets | 1 packet |
| 4 word block read | 6 packets | 2 packets |
| 512 B read | 38 packets | 18 packets |
| 32 word block write | 11 packets | 4 packets |
| 16 KiB page upload，理论值 | 约 880 packets | 约 309 packets |

这说明协议打包已经有明显收益。真机 16 KiB 上传仍约 1.9 秒，表明剩余瓶颈主要是 HID request/response 往返，而不是重复写入 SELECT 或 TAR。

## OpenOCD 首次和后续启动差异

当前 OpenOCD launch 配置为：

- `adapterSpeed: 1000`
- `servertype: openocd`
- CMSIS-DAP HID interface
- STM32F4 target config
- `runToEntryPoint: main`

仅凭现有 launch 配置，不能确认 OpenOCD 后续 4 秒是否跳过了未变化 Flash。可能原因包括：

1. 第一次启动包含 VS Code、Cortex-Debug、OpenOCD、GDB 和 ELF/DWARF 工具的冷启动。
2. Windows 文件缓存使后续启动更快。
3. OpenOCD 使用了更成熟的 RAM loader、USB 队列或批量传输。
4. OpenOCD 或 GDB 对 unchanged image/sector 做了某种增量处理。

后续比较前应先做两个实验：

- 不重新编译，连续启动两次，记录 OpenOCD 的 erase/program/verify 输出。
- 修改 ELF 后再启动一次，比较耗时和是否仍然跳过 Flash。

如果修改 ELF 后仍约 4 秒，主要是冷启动和传输实现差异；如果只有 unchanged ELF 才约 4 秒，则需要重点实现安全的 unchanged-sector 检查。

## 后续优化清单

### P0：补齐真实探针能力诊断

先记录以下信息，再决定是否进入 HID pipeline 优化：

- `DAP_Info` 的 `packetCount`。
- `DAP_Info` 的 packet size、capabilities 和来源。
- 每个 `ProgramPage` 的实际 HID packet 数。
- 每个 HID exchange 的平均、P50、P95 延迟。
- 是否存在多个 outstanding packet 的能力。
- SWD clock 的实际设置和生效结果。

判断标准：

- `packetCount > 1`：可以试验有限的多 packet pipeline。
- `packetCount == 1`：当前 HID request/response 模型基本没有安全的并行空间。
- packet size 仍为 64：单 packet 的数据容量无法通过普通协议封装增加。

这一步只增加诊断，不改变真机 Flash 行为。

### P1：合并同一 page 内的 ELF 段

当前 ELF 末尾产生了独立的 44 B `ProgramPage` 和 `Verify`。Flash planner 应先把所有 Flash PT_LOAD 段映射到统一的 page image，再按 page size 规划操作，而不是逐段直接调用 algorithm。

要求：

- 保留 `p_paddr` 作为 Flash LMA。
- `.data` 仍使用 `p_paddr` 烧录，`p_vaddr` 仅作为 SRAM VMA。
- `.bss` 不进入 Flash image。
- 所有段重叠、越界和空段规则保持不变。
- 一个 page image 内未被 ELF 覆盖的字节应明确填充为 `0xFF`，不能使用未初始化内容。
- 仅对有实际 Flash bytes 的 page 执行 erase/program/verify。

预期收益：当前项目至少减少一次小型 ProgramPage/Verify，预计节省约 0.5 秒，并减少一次 algorithm halt/return 往返。

必须新增测试：

- 相邻段合并。
- 跨 page 段不错误合并。
- page 空洞填充为 `0xFF`。
- page 边界、重叠和 LMA/VMA 检查不回归。
- operation report 中的地址和大小仍准确。

### P1：条件化 HID pipeline

只有在 P0 证明探针允许多个在途 packet 后才实施。

可行方向：

- 将连续 `DAP_TransferBlockWrite` 切成有限窗口。
- 先提交窗口内的多个输出 report，再按协议顺序读取并校验响应。
- 每个窗口都检查 completed count、ACK、protocol error 和 DeviceRemoved。
- 发生 WAIT、FAULT、NO_ACK、超时或设备移除时，立即停止窗口，不重放已经可能写入的 packet。
- 写完成状态未知时不得静默重试整个 page。

不能做的事情：

- 不能假定所有 CMSIS-DAP HID 探针支持多包并发。
- 不能把 HID write 成功当成目标已经执行成功。
- 不能为了吞吐量放松 response 长度、completed count 或 ACK 校验。
- 不能让 Watch、Timeline 或 background 请求插入 Flash control critical section。

如果 `packetCount == 1`，应停止这一方向，避免增加协议复杂度而没有收益。

### P1：验证 WinUSB/CMSIS-DAP v2 的可行性

如果当前 DAPLink 固件支持 WinUSB 或 CMSIS-DAP v2 bulk，传输后端可能比 HID 有更低的每包延迟和更大的吞吐量。

验证内容：

- 使用 `DAP_Info` 和设备枚举结果确认实际能力。
- 不改变默认 HID 路径，先做独立 capability probe。
- 为 WinUSB 增加独立 transport abstraction 和 mock/raw-frame 测试。
- 在同一个 helper owner 内完成 transport 选择，不创建第二 owner。
- 发生 WinUSB 初始化失败时，按配置回退 HID，不回退 J-Link 或 OpenOCD。

这属于较大的传输后端工作，优先级低于 page 合并和 unchanged-sector 判定。

### P2：安全的 unchanged-sector 检查

目标是：ELF 没有改变且目标 Flash 内容也没有改变时，跳过 erase/program/verify 专用流程。

不能只保存主机端的“上次已烧录 ELF hash”，因为目标可能已经被其他工具修改、掉电、换板或被用户手工擦除。

候选方案：

#### 方案 A：完整 read-back 比较后决定是否烧录

- 先读取所有相关扇区。
- 与完整 page image 比较。
- 完全相同则跳过 Flash operation。
- 不同则执行正常 erase/program/verify。

优点是语义最直接；缺点是 HID read-back 可能本身需要数秒，收益取决于真实读速度。

#### 方案 B：目标端 checksum/cryptographic digest preflight

- 将一个许可证兼容的 RAM stub 放入目标 SRAM。
- 在目标端计算相关扇区摘要。
- 与主机计算的 page image 摘要比较。
- 只有摘要不同才执行完整 Flash 流程。

CRC32 速度快，但不是严格的无碰撞证明。如果默认 Flash 语义要求最高完整性，CRC 不能作为唯一的最终 Verify；它最多作为性能预筛选，真正发生烧录时仍必须完整 Verify。若要减少碰撞风险，应考虑 SHA-256 或其他许可证兼容实现，并记录算法来源和许可证。

#### 方案 C：目标端精确 compare stub

- 上传 page image 到 RAM page buffer。
- 由 RAM stub 对目标 Flash 与 page buffer 做完整逐字节比较。
- 返回第一个 mismatch 地址或相等结果。
- 相等时跳过 erase/program；不等时继续正常 Flash 流程。

该方案语义比 host cache 安全，但仍需要上传 page image，收益需要用真机 packet/耗时数据评估。

推荐顺序：先实现方案 A 或 C 的 mock 和耗时模型，再决定是否引入方案 B。不要直接把主机 hash cache 作为默认跳过条件。

### P2：algorithm session 级缓存

当前 algorithm code 已在单次 debug session 内缓存。跨 session 保留 helper 或 algorithm RAM 映像可能减少少量连接开销，但不应为了节省约几百毫秒而破坏 owner 生命周期。

不建议：

- 在 session 结束后保留一个偷偷占用探针的后台 owner。
- 让下一个 debug session 复用未验证的 target state。
- 跨 helper 进程复用 SRAM 地址、PC、SP 或 BKPT 状态。

如果以后要做跨 session helper，需要先重新定义 owner handoff、设备移除、session replacement、disconnect 和失败清理协议，并增加专门的生命周期测试。

### P3：提高 SWD clock

提高 `speedKHz` 可能减少 SWD bit-level 时间，但当前观测主要受 HID report 往返影响，收益未必明显。

不能直接把 1000 kHz 改成 4000 kHz 作为性能修复。必须按以下顺序验证：

1. 只读确认 DPIDR 稳定为 `0x2BA01477`。
2. 只读 memory pipeline、DHCSR 和 DP/AP ACK 连续稳定。
3. 使用 mock 和最小控制测试覆盖 clock 配置。
4. 用户明确授权后，才对具体目标板进行 clock 稳定性验证。
5. 任何 NO_ACK、WAIT 增加或 DHCSR 不稳定都应回退，不继续 Flash 性能测试。

## 推荐实施顺序

1. 增加 `packetCount`、packet latency 和 operation packet diagnostics。
2. 实现并测试 page image planner，消除 44 B 独立 ProgramPage。
3. 根据真实 `packetCount` 决定是否实现有限 HID pipeline。
4. 对 unchanged-sector 方案 A/C 做 mock、耗时模型和完整性评审。
5. 若收益不足，再评估 WinUSB/CMSIS-DAP v2。
6. 最后才评估 SWD clock 和跨 session 生命周期优化。

## 性能验收矩阵

每次优化都应记录以下四种场景，不能只测一次成功启动：

| 场景 | 预期行为 |
| --- | --- |
| 冷启动 + ELF 未变化 | 完成预检；若目标相同，可安全跳过烧录操作 |
| 热启动 + ELF 未变化 | 不应因 host cache 直接信任，必须有目标端证据 |
| ELF 改变但只影响一个扇区 | 只擦除和编程受影响扇区 |
| 目标被外部修改后 ELF 不变 | 必须重新发现 mismatch 并烧录，不能跳过 |

每个场景至少记录：

- helper PID 和 owner 数量。
- DPIDR、DBGMCU_IDCODE、Flash size。
- `Init`、`EraseSector`、`ProgramPage`、`Verify`、`UnInit` 次数和耗时。
- HID packet 数、packet latency、completed count 和 ACK。
- reset/halt 和进入调试的耗时。
- 失败时 operation、PC、LR、SP、DHCSR、fault status 和 error code。

目标不是单纯降低总耗时，而是在不牺牲完整 Verify、owner 唯一性和失败安全性的前提下，减少不必要的 Flash 操作。

## 代码和测试关注位置

- `native/cmsis-dap-helper/src/cmsis_dap_protocol.*`：DAP_Info、packet capability 和 transport protocol。
- `native/cmsis-dap-helper/src/cmsis_dap_target.*`：Transfer/TransferBlock、TAR 复用和 packet diagnostics。
- `native/cmsis-dap-helper/src/cmsis_dap_helper.*`：HID request/response 生命周期。
- `native/cmsis-dap-helper/src/main.cpp`：Flash RPC、诊断和 selftest。
- `native/cmsis-dap-flash-algorithm/`：内置 algorithm 和 RAM layout。
- `src/ozone-backend/cmsis-dap-flasher.ts`：ELF、page image、sector plan、operation flow。
- `src/ozone-backend/cmsis-dap-helper-channel.ts`：单一 helper owner 和 control critical section。
- `src/ozone-backend/session-target-channel.ts`：CMSIS-DAP owner 生命周期。

测试至少包括：

- mock DAP packet count、TransferBlock、TAR 边界和 DeviceRemoved。
- page 合并、空洞填充、段边界和 Flash sector plan。
- pipeline 的 ACK、completed count、WAIT、NO_ACK、超时和未知写入结果。
- unchanged-sector 正确跳过和外部修改后重新烧录。
- `flashBeforeDebug:false` 的 erase/program/verify/reset 次数仍为 0。
- 一个 Flash 全流程只创建一个 CMSIS-DAP owner。
- J-Link、DAP-03 memory pipeline、DAP-04 mock 回归。

## 安全和许可证边界

- 不复制 OpenOCD GPL 代码或 loader 二进制。
- 新增 RAM stub、checksum 或 digest 实现必须记录来源、版本、链接和许可证。
- 许可证不明确的 FLM/算法不能直接提交或分发。
- 不开放通用 `writeMemory` RPC 来替代 Flash algorithm。
- 不访问 Option Bytes、OTP、System Memory 或 Flash 范围外地址。
- 不在没有明确用户授权时执行真实 erase/program/verify。
- mock、selftest 和自动化测试通过不等于 DAP-04 或完整真机链路已通过。

## 当前结论

当前 HID 协议打包已经接近单 packet 容量上限，但 `packetCount` 和真实 HID latency 尚未形成完整诊断证据，不能宣称传输层绝对没有优化空间。

最值得优先做的是 page image 合并和安全的 unchanged-sector 判定。若探针不支持多个 outstanding packet，则继续微调 `SELECT`、`TAR` 或 `DAP_Transfer` 的收益会很小；应把开发投入转向减少需要上传、擦除和验证的数据量。

本记录只用于后续设计和自动化准备。本次未执行真实硬件 erase/program/verify。
