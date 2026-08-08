# DAP-08 CMSIS-DAP RTT 验收报告

日期：2026-08-08

## 1. 验收结论

**结论：通过。** Orbit 使用正式构建的 `dist/debugadapter.js` 和唯一的 CMSIS-DAP native helper owner，在 STM32F407VET6 真机上完成了 60.136 秒持续 RTT 压力读取，并在同一会话内完成环形回绕、日志顺序与丢失统计、Pause/Continue/Instruction Step/Reset 抢占、Watch/Timeline 并行、Reset 后 RTT 恢复、停止与断线清理验证。最终证据 `validation.ok=true`，`violations=[]`，`errors=0`。

基础日志配置也已单独验收：4,000 kHz、3 Watch、Timeline 0.2 ms、RTT `64 B / 500 ms` 并行 15.528 秒时，Timeline 实际采样为 `256.96 Hz/表达式`，相比同条件 RTT-off 基线 `270.28 Hz/表达式` 下降 `4.93%`；Timeline P95 仅增加 1 ms，Watch P95 仅增加 1 ms。RTT 共轮询 28 次、读取 1,218 B，无 overrun、无 Watch 失败、无 owner 丢失。

本次压力固件使用 RTT `NO_BLOCK_SKIP` 模式且无限速生产。固件生产端主动丢弃 1,523,881 帧（99.363%）；这不是 Orbit 主机侧丢包。成功进入 RTT ring 的 624,960 B 全部被 Orbit 读取，主机侧字节守恒残差为 0 B，RTT reader overrun 为 0。

最终硬件证据目录：`outputs/dap08/2026-08-08-06-55-25/`

## 2. 验收范围与授权边界

| 项目 | 配置/结果 |
| --- | --- |
| 目标工程 | `D:\STM32\project\vet6_led` |
| ELF | `D:\STM32\project\vet6_led\build\Debug\vet6_led.elf` |
| MCU | STM32F407VET6 |
| 探针 | `CMSIS-DAP_LU`，HID，VID/PID `C251:F001`，Serial `LU_2022_8888` |
| HID 报告 | input 65 B，output 65 B，report ID 0；协议 packet 64 B |
| SWD 速率 | 4,000 kHz |
| 压力 RTT | Channel 1，4,096 B ring，单次读取 4,096 B，完成后间隔 20 ms |
| 基础日志 RTT | Channel 0，单次读取 64 B，完成后间隔 500 ms |
| Watch | 100 ms 请求周期；表达式含 `uwTick`、`xTickCount`、`aww` 及压力计数器 |
| Timeline | `uwTick`、`xTickCount`、`aww`，请求采样周期 1 ms，发送周期 16 ms |
| DAP 入口 | 正式 bundle `dist/debugadapter.js` |
| Flash | `flashBeforeDebug=false`；Flash operation count = 0 |

用户已授权本次对目标执行 RTT `RdOff` 写入、Halt、Run、Instruction Step、Reset 和 DAP disconnect。未执行 Flash erase/program/verify、Option Bytes 或烧录。

本次 CMSIS-DAP 接口未暴露 VTref 数值，因此 **VTref 未测量**。当前 DAP-08 证据没有重新采集 DPIDR；同一探针与目标的 DAP-03 历史证据 `outputs/dap03/verify-dap03-hw-2026-08-04-15-19-57.json` 记录 DPIDR 为 `0x2BA01477`，该历史值仅作设备身份旁证，不冒充本次运行的采样值。

## 3. 60 秒持续 RTT 与环形回绕

| 指标 | 实测值 |
| --- | ---: |
| 持续时间 | 60.136 s |
| RTT read 次数 | 189 |
| 非空 read 次数 | 155 |
| Orbit 读取字节 | 624,960 B |
| 平均读取吞吐 | 约 10,392 B/s |
| wrapped read | 151 |
| reader overrun | 0 |
| 字节守恒残差 | 0 B |

4,096 B ring 的起始 `WrOff/RdOff` 均为 3,584，结束时均为 1,856，且 151 次读取明确记录 `wrapped=true`，证明读取路径持续跨越 ring 尾部并正确回到起点，而不是只覆盖线性读取。

测试结束时读取完整 ring 快照。64 个 64 B RTTB 帧全部通过 magic、version、size 和 FNV-1a checksum 校验；按 ring 逻辑顺序解析后倒序计数为 0。快照序号范围为 20,956,252 到 20,966,278，快照内 gap 为 9,963，最后有效帧到生产计数尾部 gap 为 667。

## 4. 日志顺序与丢失统计

| 口径 | 帧数/字节 | 结论 |
| --- | ---: | --- |
| 固件尝试生产 | 1,533,646 帧 | 压力源总尝试量 |
| 成功写入 RTT ring | 9,765 帧 / 624,960 B | 可被 Host 消费的数据 |
| 固件 `NO_BLOCK_SKIP` 丢弃 | 1,523,881 帧 | 生产端丢弃率约 99.363% |
| Orbit 实际读取 | 624,960 B | 等于成功写入字节数 |
| Orbit reader overrun | 0 次 | 未报告 ring overrun |
| Orbit 主机额外丢失 | 0 B | 字节守恒残差为 0 |
| 有效 ring 快照顺序 | 64/64 帧有效，倒序 0 | checksum 与顺序校验通过 |

计数关系严格成立：`attempted = writtenFrames + dropped`，即 `1,533,646 = 9,765 + 1,523,881`。字节关系也成立：`writtenBytesDelta = hostBytes + endUsed - baselineUsed`，本次起止已用字节均为 0，因此 `624,960 = 624,960 + 0 - 0`。

快照中的 sequence gap 与固件侧 `NO_BLOCK_SKIP` 计数一致地反映“生产尝试未写入 ring”的帧，不代表已经成功写入 ring 后又被 Orbit 丢失。此项压力配置用于证明高压下的回绕、调度和守恒，不是建议的常规日志生产速率。

## 5. 控制操作抢占与恢复

RTT 作为 `background` 工作运行；Pause、Continue、Step 和 Reset 作为 `control` 工作抢占低优先级读取。所有要求的控制操作均成功，并且 RTT 在控制完成后恢复。

| 操作 | 耗时 | 状态/PC 证据 | RTT 恢复 |
| --- | ---: | --- | ---: |
| Pause before Step | 134 ms | `stopped(reason=pause)` | 3 ms |
| Instruction Step | 50 ms | `0x08004312 -> 0x08004314`，`stopped(reason=step)` | 4 ms |
| Continue after Step | 384 ms | `continued` | 3 ms |
| 第二次 Pause | 274 ms | `stopped(reason=pause)` | 3 ms |
| Continue after Pause | 372 ms | `continued` | 4 ms |
| Reset/Restart | 76 ms | `stopped(reason=entry)` | 未恢复；控制块尚未就绪 |
| Continue after Reset | 20 ms | `continued` | 首个有效 RTT 427 ms |

Reset 后目标停在 entry，固件尚未重新初始化 `_SEGGER_RTT`。`startRtt` 首次返回 `RttInvalidControlBlock` 后，DAP 保留 RTT 启用意图，在当前 Restart polling generation 内继续按 `orbit.rttPollIntervalMs=20 ms` 做串行、完成后再调度的受限机会式重试；只记录第一次瞬态错误，不把 session 永久标记为 RTT unavailable。Continue 后控制块完成初始化，`startRtt` 成功，首个有效 RTT 在 427 ms 内恢复。非法 buffer layout/flags 仍会禁用 RTT，owner 丢失仍走 session failure 与清理路径。控制期间未创建第二 owner，也未通过其他调试后端绕过调度器。

## 6. 与 Watch/Timeline 并行

RTT、Watch 和 Timeline 在同一 CMSIS-DAP owner 上并行运行 60.136 秒。Timeline 启停不会停止、重启或重置 RTT；RTT 在 Timeline 活动期间继续以 `background` 优先级进行受限机会式轮询。只有 control 临界区会暂停低优先级工作，完成后自动恢复：

| 消费者 | 实测结果 |
| --- | --- |
| Watch | 157 次请求，成功率 100%；延迟 P50/P95/max = 377/680/769 ms |
| Timeline | 167 个事件、657 个点；3 个表达式均有数据 |
| Timeline 采样 | 每表达式约 3.642 Hz |
| Timeline 事件间隔 | P50/P95/max = 380/419/1,530 ms |
| RTT | 同期读取 624,960 B，151 次回绕，0 overrun |

停止采样时 target-read gate 已完全释放：`queuedWaiters=0`、`activeWaiterTimers=0`、`controlWaiters=0`、`gateOwned=false`、`activePriority=null`。NativeScheduler 结束状态为 `running=false`，`control/watch/timeline/background` 队列均为 0，`pausedPriorities=[]`。

这是 4,096 B/20 ms 饱和 RTT 压力矩阵。Watch 和 Timeline 在压力下保持可用且无请求失败，但这里的延迟和采样率不作为常规低负载性能指标。

## 7. 基础日志配置的 Timeline 影响

为测量常规日志场景而不是饱和压力上限，使用同一 DAPLink、同一目标和同一 4,000 kHz 配置，执行了 15 秒 RTT-off/RTT-on 对照。两组均为 3 Watch，Watch 周期 100 ms，Timeline 目标采样周期 0.2 ms，发送周期 16 ms。

| 指标 | RTT-off | RTT-on，64 B / 500 ms | 变化 |
| --- | ---: | ---: | ---: |
| 有效时长 | 15.506 s | 15.528 s | +0.022 s |
| Timeline 事件 | 870 | 852 | -18 |
| Timeline 点数 | 12,573 | 11,970 | -603 |
| Timeline flush | 56.11 Hz | 54.87 Hz | -2.21% |
| 实际采样率 | 270.28 Hz/表达式 | 256.96 Hz/表达式 | **-4.93%** |
| Timeline P50/P95/max | 17/19/24 ms | 17/20/42 ms | P95 +1 ms |
| Watch 请求 | 149 | 149 | 0 |
| Watch P50/P95/max | 7/8/12 ms | 7/9/33 ms | P95 +1 ms |
| Watch 成功率 | 100% | 100% | 0 |
| Pause | 23 ms | 23 ms | 0 ms |
| 错误 / Flash 操作 | 0 / 0 | 0 / 0 | 无回归 |

RTT-on 组从 ELF 自动解析 `_SEGGER_RTT = 0x20005178`。15.528 秒内共完成 28 次轮询，其中 23 次非空、5 次空读，总计读取 1,218 B；实际轮询间隔 P50/P95/max 为 `527/531/533 ms`。该间隔符合“本轮读取完成后至少等待 `orbit.rttPollIntervalMs`”的语义；错过的周期不排队、不追赶，因此没有后台任务积压。

该配置下 Timeline 实际采样下降 4.93%，但 P95 仅增加 1 ms，Watch 成功率保持 100%，控制延迟不变。由此将 `64 B / 500 ms` 判定为当前 CMSIS-DAP v1 HID 探针上的基础日志推荐档；4096 B/20 ms 压力矩阵用于功能和守恒验收，不作为常规性能配置。

## 8. 停止、断线与资源清理

| 检查项 | 结果 |
| --- | --- |
| `dataSamplingStop` | 成功，1 ms |
| `stopRtt` | `dll.log` 记录成功，后续重复停止返回 already stopped |
| DAP `disconnect` | 成功，337 ms |
| disconnect 成功响应后 RTT stale event | 0 |
| helper stdin 关闭 | 已记录 `stdin closed, exiting` |
| 断开后 owner 进程 | 0 |
| 调度器与 target-read gate | 无运行任务、无排队、无暂停优先级、gate 未持有 |

stale event 的统计边界是 **DAP disconnect 成功响应之后**。disconnect 响应之前，为完成解码而产生的合法 decoder flush 不计作断线后事件。

## 9. 单一 CMSIS-DAP Owner

会话开始前没有目标 owner 进程。运行期间只观察到一个 helper PID `33508`，唯一选择记录为 `probe=cmsis-dap owner=cmsis-dap`；没有 J-Link、OpenOCD、GDB server 或第二个 CMSIS-DAP helper。会话结束后目标 owner 进程列表为空。

Watch、Timeline、RTT 和所有控制命令均通过该 owner 与 NativeScheduler 执行。`flashOperationCount=0` 也确认本次会话没有越过授权边界进入烧录路径。

## 10. 自动化回归

以下回归在 DAP-08 实现与验收脚本完成后执行，均通过：

| 检查 | 结果 |
| --- | --- |
| RTT/owner 聚焦 Vitest | 5 个文件，81 项通过 |
| 全量 `npm test` | 31 个文件，284 项通过 |
| `npm run typecheck` | 通过 |
| `npm run build` | 通过 |
| `npm run build:native` | 通过 |
| CMSIS-DAP helper selftest | 200/200 通过 |
| RTT C++ oracle | `segger-rtt-tests: PASS` |
| `npm run test:cmsis-dap:mock` | 通过；仅为 mock 证据 |
| `npm run test:cpp-channel:mock` | 通过；仅为 J-Link mock 回归 |
| `npm run test:cmsis-dap:algorithm` | 通过；算法/静态验证，不是本次烧录证据 |

Mock、C++ oracle、类型检查和构建分别证明协议边界、算法行为和工程完整性；`outputs/dap08/2026-08-08-06-55-25/` 是修复后的最终 DAP-08 真机长稳证据。

### J-Link 共路径回归

J-Link native helper 已从可能阻塞约 5 秒的 `JLINK_RTTERMINAL_Read` 改为同一 owner 内的 `JLINK_ReadMem`/`JLINK_WriteMem` 内存型 RTT reader，并复用相同的 SEGGER RTT control block 解析逻辑。该修改不属于 CMSIS-DAP owner，但用于确认共享 DAP RTT 生命周期和受限机会式轮询没有引入跨 probe 回归。

| 场景 | 实际采样 Hz/表达式 | Timeline P95 | Watch P95 | 结果 |
| --- | ---: | ---: | ---: | --- |
| J-Link 4 MHz，5 秒 RTT-off | 678.07 | 17 ms | 3 ms | 通过 |
| J-Link 4 MHz，5 秒 RTT `64 B / 500 ms` | 679.10 | 17 ms | 3 ms | 连续 10 轮读取 64 B |
| J-Link 4 MHz，15 秒 RTT `64 B / 500 ms` | 712.47 | 17 ms | 3 ms | 142/142 Watch 成功 |

5 秒同条件对照变化约 `+0.15%`，没有可测的持续 Timeline 吞吐损失。三组均为单一 `jlink-native` owner、Flash 0、错误 0，断开后无残留进程。完整的修复前失败矩阵和跨探针对比见 `docs/rtt-timeline-hardware-comparison.md`。

## 11. 失败证据与修复闭环

失败运行全部保留，未被成功结果覆盖：

- `outputs/dap08/2026-08-08-05-01-56/`：探针暂时未枚举，返回 `DeviceNotFound`；未进入目标控制，helper 正常退出。
- `outputs/dap08/2026-08-08-05-05-11/`：60 秒硬件矩阵本身有效，但验收脚本最初把 disconnect 成功响应前的 decoder flush 误判为 stale event，导致唯一 violation。统计边界修正为 disconnect 成功响应之后，随后重新执行完整硬件矩阵得到最终通过证据。
- `outputs/dap08/2026-08-08-06-42-04/`：受限机会式 RTT 轮询、Watch/Timeline 并发、Pause/Step/Continue、单 owner 和断连清理均通过，但 Reset 后 RTT 未恢复，最终 `validation.ok=false`。日志显示 `stopRtt` 后立即执行 `startRtt`，目标停在 entry 且 `_SEGGER_RTT` 尚未初始化，因此返回 `RttInvalidControlBlock`；原逻辑将该瞬态状态误判为整个 session 永久不可用，Continue 后不再重试。
- `outputs/dap08/2026-08-08-06-55-25/`：加入仅限 Restart polling generation 的瞬态控制块重试后，使用同一 DAPLink、同一目标、同一 4,000 kHz 和同一 60 秒矩阵复测。日志在 06:55:16.434 记录首个 `RttInvalidControlBlock action=retry intervalMs=20`，Continue 后 06:55:21.477 `startRtt ok`，首个有效 RTT 在 427 ms 内恢复；最终 `validation.ok=true`、`violations=[]`、`errors=0`。

stale event 修正只改变验收脚本的断线统计窗口。Reset 修复只改变 `RttInvalidControlBlock` 在 Restart 生命周期中的瞬态判定：重试仍由 `orbit.rttPollIntervalMs` 控制，每次完成后才安排下一次；Timeline 调度、采样率、Watch、scheduler 优先级、owner 选择和其他 RTT 错误语义均未改变。两项修正都没有放宽 RTT 数据、回绕、顺序、守恒、控制操作、Watch/Timeline、owner 或清理条件。

## 12. 证据索引与复现

最终证据：

- `outputs/dap08/2026-08-08-06-55-25/evidence.json`：DAP 请求/事件、统计、控制时序、owner、清理和最终 validation。
- `outputs/dap08/2026-08-08-06-55-25/dap.log`：DAP/session/Watch/Timeline/RTT 生命周期及 Reset 瞬态重试、恢复时序。
- `outputs/dap08/2026-08-08-06-55-25/dll.log`：CMSIS-DAP helper、RTT 回绕、控制块错误、owner 与断开证据。
- `outputs/dap08/2026-08-08-06-55-25/eval.log`：Watch/Timeline 表达式读取证据。
- `outputs/dap08/2026-08-08-06-55-25/step.log`：Pause/Continue/Step/Reset 时序与 PC 证据。

基础日志性能证据：

- `outputs/dap07/watch-3/2026-08-08-04-19-59/evidence.json`：DAPLink 4 MHz、3 Watch、15 秒 RTT-off 基线。
- `outputs/dap07/watch-3/2026-08-08-04-20-33/evidence.json`：DAPLink 4 MHz、3 Watch、15 秒 RTT `64 B / 500 ms`。
- `outputs/dap07/watch-3/2026-08-08-04-20-33/dap.log`：28 轮 RTT 读取、字节数、offset 和 overrun 证据。
- `docs/rtt-timeline-hardware-comparison.md`：DAPLink 与 J-Link 修复前后的统一硬件对比。

J-Link 共路径回归证据：

- `outputs/dap07/jlink/watch-3/2026-08-08-03-34-58/evidence.json`：4 MHz、5 秒 RTT-off 基线。
- `outputs/dap07/jlink/watch-3/2026-08-08-03-44-07/evidence.json`：4 MHz、5 秒 RTT `64 B / 500 ms`。
- `outputs/dap07/jlink/watch-3/2026-08-08-03-42-50/evidence.json`：4 MHz、15 秒 RTT soak。

硬件验收脚本：`scripts/cmsis-dap/verify-dap08-rtt-hw.js`

```powershell
node scripts/cmsis-dap/verify-dap08-rtt-hw.js --hardware --project=D:\STM32\project\vet6_led --speed-khz=4000
```

该命令会执行已授权的 Halt、Run、Instruction Step、Reset 和 RTT `RdOff` 写入；默认至少运行 60 秒。它不会烧录、擦除或校验 Flash。再次运行前应确认目标工程仍包含 RTTB Channel 1 压力 fixture、探针已连接且没有其他目标 owner 进程。

## 13. 风险与适用范围

- 结论适用于本次 STM32F407VET6、`CMSIS-DAP_LU` HID、4,000 kHz 和 RTTB Channel 1 配置；未外推到其他探针固件、WinUSB 或其他 MCU。
- 当前接口未提供 VTref 数值，本次运行也未重新读取 DPIDR；这两项不影响已经采集的 RTT、控制和 owner 行为证据，但属于设备遥测缺口。
- 99.363% 固件侧丢弃说明压力源远超 ring/Host 可承载速率。实际业务应限速、增大 ring 或选用合适的 SEGGER RTT 写入策略；不能把本次压力吞吐当作固件日志无损容量。
- `64 B / 500 ms` 基础日志对照运行 15 秒，已验证短时性能影响，但不单独代表该配置的 60 秒断线恢复或无损日志验收；长期功能与清理由 4,096 B/20 ms 压力矩阵覆盖，两者的负载模型不同。
- J-Link 结果适用于当前 J-Link OB 与 J-Link DLL 9.56；它只作为共享 RTT 生命周期与轮询策略的回归证据，不改变本报告对 CMSIS-DAP/DAPLink 的验收范围。
- 本次没有执行 Flash 操作，因此不构成 DAP-02A 烧录验收。
