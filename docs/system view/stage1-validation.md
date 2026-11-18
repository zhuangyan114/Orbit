# 阶段 1：FreeRTOS 快照引擎验收

执行日期：2026-11-18（Asia/Shanghai）。本报告覆盖 1.1～1.4；RTOS 底部面板、对象视图、Trace 和安装包属于后续阶段。

## 实现范围

- src/rtos/freertos-layout.ts：从全局变量实际 DWARF DIE 编译布局，沿用 jlink-symbols.ts 的类型图，按 ELF 内容 hash 缓存。没有 TCB 固定偏移兜底。
- src/rtos/snapshot-reader.ts：分轮读取锚点、节点、TCB；核对 owner/container、双向链接、计数和前后锚点。所有读取受 RAM 范围与字节、批次、节点、时间预算约束。
- src/rtos/task-metrics.ts：按需栈容量/填充值扫描、已结算内核计数差分。缺少边界、时基、任务身份或可信区间时逐字段不可用。
- src/rtos/snapshot-service.ts：单个在途刷新、Live 合并、代次隔离、取消和定时器清理。缓存候选地址用于减少串行发现，值仍逐次读取。
- DAP 内部 orbitRtosSnapshot：通过当前 session owner 的 background 通路读取。RMLink 每片最多 128 bytes / 1 段；其他路径上限 256 bytes / 4 段 / 1024 bytes。控制请求取消旧读，不为了快照额外 halt。

RMLink 的旧内存方法未使用传入的优先级和 signal；本次补齐，避免把 RTOS background 工作排成 control。标准 DAP writeMemory 补上控制/写屏障，保证内存写入也作废旧快照。原有 evaluate、variables、memoryReference、Watch、Timeline、RTT 与 Viewer 通路保留。

## 硬件、输入与授权

| 项目 | 本次事实 |
|---|---|
| 授权 | 用户要求连接硬件并完成阶段 1；沿用此前允许测试固件烧录、运行控制、断点和 RAM 写入且无需备份 Flash 的授权 |
| 板卡 | STM32H723VGT6；CPUID 0x411FC272，DBGMCU DEV_ID 0x483，容量寄存器 1024 KiB |
| 探针与传输 | RMLink 二号机 b81f3fc30470，固件 0.3.4，Wi-Fi，协商 packet_size 512，SWD 请求 4 MHz |
| 唯一 owner | DAP → OzoneBackend → SessionTargetSelector → RMLinkTargetChannel → Connector；没有第二个 helper/DLL owner |
| 固件 | snapshot-benchmark；FreeRTOS 10.3.1，GCC/ARM_CM4F port，heap_4，13 个任务，D-cache 关闭 |
| 统计来源 | SystemCoreClock 回读 64 MHz；DWT CYCCNT，32 bit；契约声明睡眠不计数，本轮未进入 WFI、未验收 tickless。它是固件声明的时基，不是示波器校准结果 |
| 执行环境 | 实际 VS Code Extension Development Host；精确版本、ELF、bundle 和源码 hash 见 stage1-evidence.json |

硬件实际烧录记录在本地 hardware-run2/run3/run4 开发证据中；最后两轮通过 flashBeforeDebug=false 附着并显式 Restart，没有重复烧录。Option Bytes 未操作。DPIDR、VTref、Wi-Fi 实际 SWD 波形频率未另行量测，不用目标型号常量冒充回读。

## 独立 oracle

benchmark 变体用 uxTaskGetSystemState 输出 TaskStatus_t 数组。对照脚本独立按该数组的 DWARF 字段解出任务信息，没有调用 Orbit 的任务解码器制造 expected。当前任务水位在 API 完成后再用 uxTaskGetStackHighWaterMark 补采；从 API 到检查点之间屏蔽 SysTick，确保比较同一时刻的数据，继续执行后恢复 PRIMASK。

三个检查点均包含 13 个任务，逐个核对地址、创建编号、名称、状态、优先级、未用栈字节和累计计数：

1. 初始任务与阻塞对象存在。
2. worker00 挂起、worker01 被删除；额外高优先级任务 selfDelete 自行退出，留下真实 termination 节点。
3. idle 已回收退出任务，worker00 恢复，worker01 地址可复用但创建编号改变，recreated 任务存在。

删除其他任务会立即回收，不能据原 fixture 中的一次 vTaskDelete 就断言 termination 列表有节点。栈水位是填充区的历史未用字节，不是 SP 与边界的差值。

## 运行态一致性与统计

10 ms 任务周期短于无线整帧读取时间，完整链表在两次读之间经常变化。首轮实测 76 个发布结果只有 2 个完整图；该轮没有通过任务字段覆盖要求，原始失败记录保留。

改进后，发生链表变化时仍报告 partial 和具体错误，同时保留本次重新读取、通过自身 owner/container 校验的 TCB 字段。每行附 listEvidence；旧地址没有旧值，释放或复用后的地址不能凭名字继承生命周期。完整图比例与可用任务字段帧数分别报告，不能把后者叫作一致快照。

CPU 百分比来自同一任务身份、同一 boot/control 代次内的累计计数与 ulTotalRunTime 差分。ISR 按所选内核记到当前任务，未结算运行段不补算。输出 readWindowMs，说明多次读取的时间窗口；这是 best effort 估算。内核源时钟回绕时本身可能漏记一个切换区间，主机不补造丢失时间。计数重置、未知/多次回绕、零总量、首帧、控制、复位或身份变化不输出百分比。

## 检查与性能门槛

最终数值、命令结果与检查项见 [机器可读证据](stage1-evidence.json)，门槛见 [冻结值](stage1-performance-gates.json)。

全量类型/构建/测试、J-Link 与 CMSIS-DAP mock 分别登记。Mock 没有访问实板。真实 VS Code 验收记录包含三个 oracle、暂停态重复读取/全栈扫描、运行态共存、step/write/restart/termination 交错、刷新合并、停止与会话替换。

| 最终检查 | 结果 |
|---|---|
| 类型检查 / 扩展构建 / 原生构建 | 通过；dist 由构建生成 |
| 全量 Vitest | 104 文件，1378 项通过、1 项跳过 |
| 原生 J-Link / CMSIS-DAP mock | 通过；含 RTT/XR mock；不是实板证据 |
| 固定依赖、离线工程与样本 | 63 个 vendor hash、11 个原有 ELF 变体、5 份独立样本与 7 项校验器测试通过；额外 benchmark 构建通过 |
| 实板 oracle | 3 个检查点、每点 13 个任务，逐字段零差异 |
| 实板生命周期 | 35 项通过；暖快照 20 次统计 p50/p95 见机器证据，p95 为 583 ms；全栈扫描 3217 ms |
| 原始采集独立复算 | validate-hardware.py 检查冻结门槛、代次/序列、停止事件与原始文件 hash |

| 同一最终读取实现，三轮合并 | 不启用快照 | 启用快照 |
|---|---|---|
| 测量时长 | 180.467 s | 180.731 s |
| 控制操作 / 错误 | 198 / 0 | 198 / 0 |
| pause p95 | 131 ms | 197 ms（+66 ms） |
| continue p95 | 162 ms | 165 ms（+3 ms） |
| 新鲜 13 任务字段帧 | — | 252 帧，约 1.4 Hz |
| 完整图 / partial | — | 4 / 263；partial 的有效字段单独保留 |
| CPU 估算字段 | — | 2223 项，均带身份和读取窗口；没有把它当作独立标定的 CPU 精度结果 |

Watch 和 Timeline 的精确吞吐及保留比、读取量、请求/取消计数见 JSON。本轮实际测试 host 为 VS Code 1.146.0；阶段 0 环境记录的 1.145.2 保留为历史，两者不混作同环境性能比较。

性能采集之后，交付构建仅修正取消错误的 completion：读操作已进入但被代次取消时返回 unknown，纯元数据/参数失败保持 not-started。内核布局、读计划、后台片、调度及统计热路径未改；校验器通过反向应用这三个文本变化后的 SHA256，核对其余字节与性能构建一致。交付构建已重新完成 35 项实板 lifecycle，两个构建 hash 均保留。

原有基线覆盖六个至少 60 s 场景：仅调试、Watch、Timeline、RTT、三者共存、共存加快照；每场景 30 次 pause、30 次 continue、6 次 instruction step。正式性能对照在最后的 128-byte 片实现上独立进行，不并行构建/回归测试。由于单轮 p95 增量比 80 ms 门槛高 9 ms，增加两轮并合并全部 90 次 pause/continue 样本；单轮失败保留，门槛未降低。

暂停态 20 ms 是原计划优化目标；本次 Wi-Fi 路径未达到。1.4 冻结轻量暖快照 p95 ≤1000 ms、13 任务全栈扫描 ≤5000 ms、Live 新鲜任务字段 ≥1 Hz、控制零错误、pause/continue p95 ≤1200 ms 且增量 ≤80 ms，Watch/Timeline 吞吐保留 ≥80%。相对增量 20% 继续作为优化参考，不能把当前无线结果声明为满足该目标。

## 已知限制与失败记录

- RMLink 在当前 PC 命中用户 FPB 断点后直接 run 会再次停住；20 ms 内命中的新断点也可能早于无线 Running 确认。对照脚本显式移除当前检查点断点、执行一条 instruction step、再恢复；快速命中只在 oracle 证实预期 phase 后接受。未改动该既有运行控制行为，也没有写入 bug-fix-log。
- 最初固件使用虚拟调试前缀且脚本行号错误；benchmark 改为保留真实源路径并从源码定位检查点。原有离线 ELF 变体仍使用固定前缀。
- 首次容量寄存器 2-byte 读被服务拒绝，改为对齐 4-byte 读取并取低 16 bit。保留 InvalidRequest 证据。
- No-flash launch 仅附着并 halt；固件未变时 Restart 会自动运行。验收脚本在显式 Restart 前安装检查点，不把 RAM 旧 phase 当作新一轮初始化。
- 停机 UI 刷新可能占用 gate；独立 oracle 只对只读的 Busy/取消作有界重读，不重放结果未知的目标写入。
- 诊断脚本最初把 disconnect 当作 customRequest 发送，留下尚未结束的 VS Code 可见会话，单 owner guard 正确拒绝下一次 start。脚本已改用 vscode.debug.stopDebugging(精确 session)，等待终止后再验证替换；失败记录保留。
- SVD 后台下载曾超时，快照不依赖 SVD；VS Code 用例仍继续完成。
- 只新增 H723/RMLink 这条实板证据。J-Link native、legacy、WinUSB/HID、tickless/其他配置仍保留各自未验收状态；未声明所有 FreeRTOS 版本或 port 可用。

## 复跑与原始文件

所有硬件命令都在显式授权的 VS Code 测试实例中执行，使用当前源码生成的 dist。没有增加临时 HTTP/MCP 公开接口；以下是开发验收入口：

```powershell
python scripts/rtos/fixtures/build.py
cmake --build out/rtos-stage0/fixtures/arm --target snapshot-benchmark -j 4
npm run typecheck
npm run build
node scripts/rtos/run-vscode-hardware.js --hardware --authorize-target-control --authorize-flash --output=out/rtos-stage1/new-run
# 测试 host ready 后，在另一个终端运行。首次写入测试固件，省略 --no-flash。
node scripts/rtos/hardware-oracle.js out/rtos-stage1/new-run
node scripts/rtos/hardware-benchmark.js out/rtos-stage1/new-run
node scripts/rtos/hardware-lifecycle.js out/rtos-stage1/new-run
```

已有相同固件可使用 oracle 的 --no-flash；它会显式 Restart。切勿把固件相同的假设用于其他 ELF。测试 host 的命令目录、response、DAP trace、oracle、各轮 benchmark、lifecycle 都存放在相应 out 目录；hash 索引纳入 stage1-evidence.json，VS Code user-data 不作为交付证据。

阶段 2 接手时，任务表须能显示 partial 帧中的逐行证据与采集时间，并为 CPU 估算保留采集窗口说明。不要清理旧 RTOS Views 通路，直到 2.4 的替代视图验收完成。
