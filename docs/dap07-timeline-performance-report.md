# DAP-07 Timeline 性能诊断与优化报告

日期：2026-08-07

## 结论

DAP-07 的可重复卡顿来自同一 CMSIS-DAP HID owner 上的串行 target read 竞争，而不是 owner 路由错误。原实现对每个顶层 Watch 表达式分别执行一次 `evaluateExpression`；6 个 Watch 在真实硬件上形成 6 个约 8--12 ms 的高优先级读片段。Timeline 虽然已经将 3 个标量合并为一次 `readMemoryBatch`，但只能在 Watch 片段之间获得调度机会，因此 Watch 数量增加时 Timeline 有效吞吐下降。

本次已实施中风险、可回退优化：复用现有 DWARF fast-sampling planner，将两个以上未展开、可证明为标量的 Watch 表达式合并为一次 `readMemoryBatch`。展开的结构体/指针、字符串、数组根对象和 planner 不支持的表达式继续走原有逐项 `evaluateExpression` 路径。Scheduler 合同保持 `control > watch > timeline > background`，批量 Watch 显式使用 `watch` 优先级。

真实 CMSIS-DAP HID 复测中，6 Watch 的 Timeline flush 从 31.40 Hz 提升到 41.17 Hz（约 +31%），最大事件间隔从 87 ms 降至 67 ms，Watch P95 从 67 ms 降至 51 ms。3 Watch 的 Timeline flush 从 40.16 Hz 提升到 42.67 Hz，Watch P95 从 53 ms 降至 45 ms。最终 CMSIS-DAP 6-Watch 强校验的 Watch 数据成功率为 100%，Pause 延迟 35 ms，没有 TargetBusy、设备移除或第二 owner。

同一固件、表达式、SWD 速度和采样配置下，J-Link native 的 3/6-Watch 正式结果分别为 50.41/50.23 flush Hz 和 272.98/269.40 Hz/表达式。相比对应 CMSIS-DAP 结果，J-Link 的 flush 提高约 18%/22%，实际每表达式采样率提高约 311%/335%。这说明 UI 收到事件的频率只是批量交付频率，不是目标读取频率；J-Link 每次 flush 携带的有效采样点明显更多。

## 测试环境

| 项目 | 值 |
|---|---|
| MCU | STM32F407VET6 |
| 工程 | `D:\STM32\project\vet6_led` |
| ELF | `D:\STM32\project\vet6_led\build\Debug\vet6_led.elf` |
| Probe | CMSIS-DAP_LU；J-Link |
| Transport | CMSIS-DAP v1 HID；J-Link native helper + DLL |
| VID/PID | CMSIS-DAP：C251/F001 |
| Serial | CMSIS-DAP：LU_2022_8888 |
| HID report | input 65 / output 65 / reportId 0，协议 payload 64 bytes |
| J-Link DLL | 同环境只加载预检：`C:\Program Files\SEGGER\JLink_V956\JLink_x64.dll`，版本返回值 95600（9.56） |
| SWD | CMSIS-DAP：1000--10000 kHz 阶梯；J-Link：1000--8000 kHz 阶梯 |
| Flash | `flashBeforeDebug=false`，所有 DAP-07 测试均未 erase/program/verify |
| Owner | CMSIS-DAP：`probe=cmsis-dap owner=cmsis-dap`；J-Link：`mode=native owner=jlink-native`；每个 session 一个 helper |

本轮 J-Link 1000 kHz 正式 3/6-Watch session 的唯一 helper PID 分别为 31064/33168，4000 kHz 分别为 34000/16984；四次均选择 `mode=native owner=jlink-native`，session 结束后 helper 和其他 owner 进程均为 0。DLL 路径和版本来自同一 helper 构建和环境的只加载预检；当前正式 evidence 未直接持久化 connect 返回的 DLL 字段。

## 基准矩阵

Timeline 固定采样 `uwTick`、`xTickCount`、`aww`。Watch 请求周期 100 ms，Timeline 目标间隔 0.2 ms，DAP send 间隔 16 ms。每个正式矩阵运行至少 60 秒。

- `Timeline flush Hz = ozoneDataSamples 事件数 / 有效时长秒数`，表示 DAP 批次送达 UI 的频率。
- `实际采样 Hz/表达式 = Timeline 总点数 / 3 / 有效时长秒数`，表示每条 Timeline 表达式实际获得的数据点频率。

0.2 ms 只是目标调度间隔（理论请求目标 5 kHz），不能作为实际采样率。一个 flush 可以携带每条表达式的多个数据点，因此实际采样 Hz 可以高于 flush Hz。

| Probe / 阶段 | Watch | Timeline flush Hz | 实际采样 Hz/表达式 | Timeline 点数 | 事件间隔 P50/P95/max ms | Watch P50/P95/max ms | Watch 成功率 | Pause ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| CMSIS-DAP-v1，优化前 | 3 | 40.16 | 59.90 | 10806 | 18 / 53 / 70 | 45 / 53 / 85 | 100%* | 31 |
| CMSIS-DAP-v1，优化后 | 3 | 42.67 | 66.48 | 11997 | 18 / 50 / 66 | 38 / 45 / 71 | 100%* | 35 |
| CMSIS-DAP-v1，优化前 | 6 | 31.40 | 48.05 | 8670 | 19 / 71 / 87 | 57 / 67 / 97 | 100%* | 31 |
| CMSIS-DAP-v1，标量批读后 | 6 | 40.23 | 57.22 | 10326 | 18 / 53 / 73 | 49 / 56 / 77 | 100%* | 33 |
| CMSIS-DAP-v1，最终（含连续范围合并） | 6 | 41.17 | 61.99 | 11253 | 18 / 52 / 67 | 42 / 51 / 56 | 100% | 35 |
| CMSIS-DAP-v1，事件驱动交接后（本轮） | 3 | 56.16 | 87.58 | 15912 | 17 / 20 / 37 | 17 / 23 / 31 | 100% | 30 |
| CMSIS-DAP-v1，事件驱动交接后（本轮） | 6 | 52.27 | 80.95 | 14703 | 17 / 34 / 60 | 23 / 28 / 34 | 100% | 34 |
| J-Link-ob native | 3 | 50.41 | 272.98 | 49548 | 17 / 34 / 51 | 30 / 36 / 42 | 100% | 9 |
| J-Link-ob native | 6 | 50.23 | 269.40 | 48882 | 17 / 34 / 48 | 31 / 37 / 41 | 100% | 12 |
| J-Link-ob native，事件驱动交接后（本轮） | 3 | 58.43 | 368.67 | 66840 | 17 / 18 / 33 | 5 / 6 / 8 | 100% | 10 |
| J-Link-ob native，事件驱动交接后（本轮） | 6 | 60.13 | 357.40 | 64797 | 16 / 18 / 24 | 6 / 7 / 8 | 100% | 11 |
| J-Link native，最终复测，1000 kHz | 3 | 59.38 | 364.69 | 66129 | 16 / 18 / 22 | 5 / 6 / 7 | 100% | 10 |
| J-Link native，最终复测，1000 kHz | 6 | 59.04 | 362.29 | 65682 | 16 / 18 / 32 | 6 / 7 / 8 | 100% | 10 |
| J-Link native，最终复测，4000 kHz | 3 | 61.09 | 752.92 | 136515 | 16 / 17 / 19 | 2 / 3 / 4 | 100% | 3 |
| J-Link native，最终复测，4000 kHz | 6 | 61.08 | 750.16 | 136104 | 16 / 17 / 27 | 3 / 3 / 5 | 100% | 4 |

前两行 J-Link 是此前同配置的 60 秒基线，接下来两行是更换 J-Link OB 后的事件驱动交接复测，最后四行是本次连接后的 1000/4000 kHz 正式对照。最新四组均通过脚本强校验：数据级 Watch 成功率 100%、Flash 0、单 native owner、断开后无进程残留。4000 kHz 相比本轮 1000 kHz，3/6-Watch 实际采样率分别提高约 106%/107%，Watch P95 从 `6/7 ms` 降至 `3/3 ms`；flush 只提高约 3%，符合 16 ms DAP 发送间隔形成的约 60 Hz UI 批次上限。

### CMSIS-DAP v1 SWD 频率阶梯

频率阶梯固定使用 6-Watch 压力场景。1000--8000 kHz 每档运行 15 秒；连续两档实际采样增益低于 5% 后停止正式递增。10000 kHz 仅做 5 秒能力冒烟，用于判断探针是否接受并稳定执行该配置；最佳档 4000 kHz 另做 60 秒长稳复核。

| 请求 SWD | 时长 | Timeline flush Hz | 实际采样 Hz/表达式 | 相对上一档 | Watch P50/P95/max ms | Helper RPC P95 ms | Pause ms | 结果 |
|---:|---:|---:|---:|---:|---:|---:|---:|---|
| 1000 kHz | 15 s | 54.60 | 155.05 | 基线 | 16 / 18 / 20 | 9 | 35 | 稳定 |
| 2000 kHz | 15 s | 55.66 | 201.60 | +30.0% | 13 / 14 / 16 | 5 | 24 | 稳定且明显提升 |
| 4000 kHz | 15 s | 55.73 | 262.89 | +30.4% | 11 / 12 / 14 | 4 | 20 | 稳定且明显提升 |
| 6000 kHz | 15 s | 55.46 | 257.72 | -2.0% | 11 / 12 / 14 | 4 | 22 | 稳定但进入平台 |
| 8000 kHz | 15 s | 55.59 | 257.11 | -0.2% | 11 / 12 / 15 | 4 | 23 | 稳定但无新增收益 |
| 10000 kHz | 5 s | 51.63 | 239.23 | -7.0% | 11 / 13 / 13 | 4 | 24 | 短时稳定，仅能力冒烟 |
| 4000 kHz | 60 s | 57.34 | 266.39 | 长稳复核 | 11 / 12 / 14 | 4 | 22 | 594/594 Watch 成功 |

本探针的推荐性能档是 **4000 kHz**：60 秒实际采样 `266.39 Hz/表达式`，比 1000 kHz 的 15 秒同场景基线高约 71.8%，Watch P95 从 `18 ms` 降至 `12 ms`。6000/8000 kHz 连续两档没有收益，说明此处瓶颈已经转移到 CMSIS-DAP v1 HID 的 64-byte report 往返和 helper/USB 调度，而不是 SWD 位时钟。10000 kHz 的 launch、DP/AP 读取、Watch/Timeline、Pause 和 disconnect 均成功，证明该配置在本次 5 秒场景中可用；但 CMSIS-DAP `DAP_SWJ_Clock` 没有实际频率回读，未使用示波器或逻辑分析仪测量 SWCLK，因此不能仅凭协议成功确认物理引脚持续达到 10 MHz，也不能把短时冒烟称为 10 MHz 长稳通过。

### J-Link native SWD 频率阶梯

J-Link 使用相同的 6-Watch 压力场景，从已验证的 4000 kHz 开始，每档运行 15 秒；连续两档实际采样增益低于 5% 后停止递增。4000 kHz 另有前述 60 秒正式结果作为长稳基线。

| 请求 SWD | 时长 | Timeline flush Hz | 实际采样 Hz/表达式 | 相对上一档 | Watch P50/P95/max ms | Timeline gate hold P50/P95 ms | Pause ms | 结果 |
|---:|---:|---:|---:|---:|---:|---:|---:|---|
| 4000 kHz | 15 s | 59.61 | 718.90 | 基线 | 3 / 4 / 4 | 1.30 / 1.45 | 4 | 稳定 |
| 6000 kHz | 15 s | 59.75 | 732.79 | +1.9% | 3 / 4 / 4 | 1.27 / 1.41 | 4 | 稳定但无明显提升 |
| 8000 kHz | 15 s | 59.66 | 719.55 | -1.8% | 3 / 3 / 4 | 1.29 / 1.44 | 4 | 稳定但进入平台 |
| 4000 kHz | 60 s | 61.08 | 750.16 | 长稳基线 | 3 / 3 / 5 | 1.26 / 1.41 | 4 | 568/568 Watch 成功 |

J-Link 从 4000 提升到 6000/8000 kHz 后，实际采样、Watch 延迟和 gate hold 都没有可重复的明显改善；因此同样推荐 **4000 kHz**。这条路径没有 CMSIS-DAP HID report 瓶颈，但单次同步 native helper/DLL target-read 临界区稳定在约 `1.3 ms`，固定的进程 IPC、DLL 调用、目标读取和调度开销已经主导。8000 kHz 仍稳定，停止继续测试 10000 kHz 及以上的原因是达到预设“连续两档低于 5%”的平台门槛，而不是连接失败。

`*` 早期 CMSIS-DAP 基准脚本只统计 DAP response success；最终 CMSIS-DAP 6-Watch 和两组 J-Link 正式结果额外要求每个 Watch item 无错误、表达式齐全，数据级成功率均为 100%。

附加否证实验：

| 实验 | 结果 | 判断 |
|---|---|---|
| Watch slice budget 8 ms 改为 4 ms | 6 Watch Timeline 31.40 -> 31.47 Hz，Watch P95 67 -> 66 ms | 无实质收益，已撤销 |
| Timeline 目标间隔 0.2 ms 改为 20 ms | 6 Watch Timeline 31.40 -> 30.68 Hz；3 Watch 40.16 -> 34.43 Hz | Watch P50 略降，但 Timeline 退化，不改默认值 |
| Timeline 目标间隔改为 10 ms | 6 Watch Timeline 32.46 Hz，Watch P95 80 ms | 无净收益，不改默认值 |

## 根因证据

1. DAP 日志在优化前稳定出现 `batch expressions=6 ... chunks=6 ... elapsedMs=49..63`。每个 Watch 表达式独占一个顶层 target-read slice。
2. 同期 Timeline 日志为 `readMemoryBatch reads=3 bytes=12 owner=cmsis-dap`，单次批读约 9--12 ms。Watch 增加后 Timeline flush 从 40.16 Hz 降到 31.40 Hz。
3. 设备是 64-byte payload 的 CMSIS-DAP v1 HID，传输时延和包往返构成硬件上限；0.2 ms 目标间隔不等于真实 5 kHz 采样率。
4. `NativeScheduler` 和 DAP target-read gate 正确保持串行和 `watch > timeline`。没有第二 helper、J-Link、OpenOCD、GDB server 或 extension-host fallback。
5. 仅改变 Watch 的 RPC/内存读合并后，同一硬件、同一表达式和同一周期下 Timeline/Watch 指标同步改善，验证瓶颈是重复 Watch target read，而不是 8 ms slice 常数或简单限频。
6. J-Link native 在 3/6 Watch 下分别保持 272.98/269.40 Hz/表达式，负载增加只下降 1.3%；对应 CMSIS-DAP 从 66.48 降至 61.99 Hz/表达式。跨 probe 结果进一步支持 CMSIS-DAP v1 HID 往返延迟是该设备剩余瓶颈，而不是 Timeline UI flush 本身。

## 优化方案评估

当前应先优化 target-read 调度空洞，再减少 CMSIS-DAP helper/USB 往返。Watch 端到端 P50/P95 为 CMSIS-DAP `42/51 ms`、J-Link OB `31/37 ms`，但真正持有 target-read gate 的时间分别只有约 `14--19 ms` 和 `3--6 ms`。主要额外延迟来自 `beginTargetReadWhenAvailable()` 的 20 ms 定时轮询：Watch 排队后会阻止新的 Timeline 读取，而当前 Timeline 读取结束时 Watch 可能仍休眠最多 20 ms，造成 owner 空闲但两个 consumer 都无法推进。

### 已实施并验证

| 方案 | 风险 | 实测收益或作用 | 实施状态 |
|---|---|---|---|
| 可证明为标量的 Watch 批量读取 | 中 | CMSIS-DAP 6 Watch：Timeline flush `31.40 -> 40.23 Hz`（+28%）；Watch P95 `67 -> 56 ms` | 已实施；保留展开对象、指针、字符串及 planner 不支持表达式的原求值路径，失败项不缓存并回退 |
| 相邻/重叠地址合并为连续读块 | 中 | CMSIS-DAP 6 Watch：flush `40.23 -> 41.17 Hz`；实际采样 `57.22 -> 61.99 Hz/表达式`；Watch P95 `56 -> 51 ms` | 已实施；仅合并连续范围，不读取范围外字节 |
| Watch/Timeline 调度语义保持 | 低 | 批量 Watch 使用 `watch` 优先级；Timeline 保持可合并、可取消的 `timeline`，未破坏 `control > watch > timeline > background` | 已实施并由自动化回归覆盖 |
| 真实硬件基准与证据强校验 | 低 | 可重复记录 flush Hz、实际采样率、逐项 Watch 成功率、Pause 延迟、owner/helper PID、Flash 次数和退出清理 | 已实施；同时支持 CMSIS-DAP 与 J-Link，违例保存证据并非零退出 |
| 事件驱动 target-read/control waiter queue | 中 | CMSIS-DAP 3/6 Watch 的 queue wait 分别为 `6.50/11.33/17.56 ms`、`6.49/11.57/17.03 ms`；J-Link 3/6 分别为 `2.20/2.39/3.92 ms`、`2.15/2.45/3.89 ms`。四组 handoff gap P95 均不超过 `0.003 ms`，Watch P50/P95 分别降至 CMSIS-DAP `17/23`、`23/28 ms` 和 J-Link `5/6`、`6/7 ms` | 已实施并验证；11 个聚焦 gate 测试、全量回归和四组 60 秒真机矩阵均通过 |

### 本轮四项低/中风险优化：已实施并验证

| 优先级 | 方案 | 风险 | 实测收益或作用 | 实施状态 |
|---:|---|---|---|---|
| 1 | 增加分段时序与传输指标 | 低 | 60 秒 CMSIS-DAP 3-Watch 证据记录 gate queue/hold/handoff、planner、helper RPC `5/6/7 ms`、helper processing `4/5/6 ms`、`10787` 次 batch RPC、`21574` HID reports、`10787` 次 `DAP_Transfer`、`129444` 有效字节；6-Watch 同类证据记录 `10201` RPC、`22758` reports、`10790` Transfer、`589` TransferBlock | 已实施并验证；快路径只做有界聚合，J-Link 的 CMSIS-DAP 字段保持 `null/unavailable` |
| 2 | 按规范化表达式列表和 ELF/session generation 缓存 fast-sampling plan | 低 | 3-Watch 60 秒 planner `hit=589/miss=1`，6-Watch `hit=588/miss=2`；缓存只存 planner 输出，rejected 结果也保留语义；session/ELF/symbol reload 和 disconnect 会失效 | 已实施并验证；key 显式绑定 `plannerMode`、`readSizePolicy`、表达式顺序、symbol generation 和 session generation，不缓存 target 值 |
| 3 | 为 CMSIS-DAP helper 增加单次 `readMemoryBatch` RPC | 中 | TypeScript 每个 batch 恰为一次 `readMemoryBatch` helper request；native mock smoke 验证原序返回、空数组/uint32 溢出拒绝、结构化 `failedIndex/failedAddress/completedReads`；硬件 3/6-Watch 均 100% Watch 数据成功 | 已实施并验证；单 owner、单 scheduler task、`control > watch > timeline > background` 保持不变，J-Link 原有路径未改 |
| 4 | 将散地址标量读打包进更少的 `DAP_Transfer` 请求 | 中 | 独立 raw-frame oracle 185/185 通过：64-byte payload 每包最多 7 个 32-bit 标量，乱序输入按原序返回；mock smoke 验证连续区间走 `DAP_TransferBlock`、非标量 fallback、`packedReads/fallbackReads` 和有效字节计数；CMSIS-DAP 3-Watch `32361` packed reads，6-Watch `30603` packed + `589` continuous fallback，Watch P95 分别 `12/18 ms` | 已实施并验证；仅对齐只读 scalar，严格校验 count/status/ACK/长度，WAIT/FAULT 有界恢复，任何写操作不进入 packed path |

本轮组合收益已用同一 STM32F407VET6/CMSIS-DAP v1 HID/1000 kHz/60 秒矩阵复测，不再把工程预估写成硬件承诺：事件驱动基线的 3/6-Watch 实际采样率为 `87.58/80.95 Hz/表达式`，本轮分别为 `168.46/158.84 Hz/表达式`；Watch P95 为 `23/28 ms -> 12/18 ms`，Pause 为 `30/34 ms -> 35/34 ms`。J-Link 连接恢复后又完成 1000/4000 kHz 两档 3/6-Watch 矩阵：1000 kHz 为 `364.69/362.29 Hz/表达式`、Watch P95 `6/7 ms`；4000 kHz 为 `752.92/750.16 Hz/表达式`、Watch P95 `3/3 ms`。所有正式矩阵均无 Watch 数据失败、Flash 操作或 owner 残留。

CMSIS-DAP 频率阶梯进一步确认：提高 SWD 时钟在 1000 -> 2000 -> 4000 kHz 区间有明确收益，4000 kHz 以上进入平台。4000 kHz 的 60 秒 6-Watch 实际采样为 `266.39 Hz/表达式`、Watch P95 `12 ms`，成为当前 DAPLink v1 HID 的推荐配置；更高请求频率未增加有效吞吐。

### 未实施：高风险，需用户授权

| 方案 | 预期收益 | 高风险原因 |
|---|---|---|
| Watch 复用足够新的 Timeline 样本 | 消除相同地址在两个 consumer 间的重复读取，显著降低 Watch 占用 | 涉及新鲜度定义、写入后失效、类型/显示语义、session/generation/read epoch 和展开对象一致性 |
| 跨 consumer read broker/请求合并 | 自动合并 Watch、Timeline、Viewer 等同时到达的相同或相邻读取 | 改变共享调度和取消边界，可能影响 Watch 优先级、控制操作隔离、错误归属及所有读取 consumer |
| native helper 流式 sampler/ring buffer | 将采样循环下沉，减少逐次 JSON-lines RPC，并提高高性能 probe 的持续吞吐 | 引入新协议、缓冲/背压、时间戳、断线恢复和生命周期状态机，影响 native 与 TypeScript 两端 |
| CMSIS-DAP v2 WinUSB transport | 绕开 v1 HID 的 64-byte 包和高往返延迟限制，硬件支持时可能获得数量级更高吞吐 | 属于新增 transport 和设备枚举/驱动路径，不是 DAP-07 局部调整，需要完整协议与真机矩阵 |

### 已评估但未采用

| 方案/实验 | 结果 | 结论 |
|---|---|---|
| Watch slice budget `8 -> 4 ms` | 6 Watch flush `31.40 -> 31.47 Hz`，Watch P95 `67 -> 66 ms` | 无实质收益，已撤销 |
| Timeline 目标间隔 `0.2 -> 20 ms` | 6 Watch flush `31.40 -> 30.68 Hz`；3 Watch `40.16 -> 34.43 Hz` | Timeline 退化，不修改默认值；保留用户配置 |
| Timeline 目标间隔 `10 ms` | 6 Watch flush `32.46 Hz`，Watch P95 `80 ms` | 无净收益，不修改默认值 |

明确不采用：提高 Timeline 到 Watch 之上、关闭或永久降频 Watch、返回静态旧值、创建第二 owner、引入 OpenOCD/GDB server/JLink.exe。

## 证据与验证

主要硬件证据：

- `outputs/dap07/watch-3/2026-08-07-05-33-32/evidence.json`：优化前 3 Watch。
- `outputs/dap07/watch-6/2026-08-07-05-34-56/evidence.json`：优化前 6 Watch。
- `outputs/dap07/watch-6/2026-08-07-05-49-21/evidence.json`：优化后 6 Watch。
- `outputs/dap07/watch-3/2026-08-07-05-50-38/evidence.json`：优化后 3 Watch。
- `outputs/dap07/watch-3/2026-08-07-05-53-07/`：owner/log 归档增强验证。
- `outputs/dap07/watch-3/2026-08-07-06-06-37/evidence.json`：审查修正后的 5 秒强校验，50 次 Watch 数据成功率 100%，Timeline 966 点/37.80 Hz，唯一 helper PID 29624，Flash 0，断开后 owner 进程 0。
- `outputs/dap07/watch-6/2026-08-07-06-13-49/evidence.json`：最终 60 秒 6 Watch 强校验，594 次 Watch 数据成功率 100%，Timeline 11253 点/41.17 Hz，Pause 35 ms，唯一 helper PID 4356，Flash 0，断开后 owner 进程 0。
- `outputs/dap07/jlink/watch-3/2026-08-07-06-37-46/evidence.json`：J-Link 5 秒冒烟，验证 probe 参数、唯一 `jlink-native` owner、零 Flash 和清理门禁。
- `outputs/dap07/jlink/watch-3/2026-08-07-06-39-05/evidence.json`：J-Link 60 秒 3-Watch，Timeline 49548 点、50.41 flush Hz、272.98 Hz/表达式，Watch 数据成功率 100%，Pause 9 ms，helper PID 12060。
- `outputs/dap07/jlink/watch-6/2026-08-07-06-40-22/evidence.json`：J-Link 60 秒 6-Watch，Timeline 48882 点、50.23 flush Hz、269.40 Hz/表达式，Watch 数据成功率 100%，Pause 12 ms，helper PID 8848。
- `outputs/dap07/watch-3/2026-08-07-08-46-54/evidence.json`：事件驱动方案 CMSIS-DAP 60 秒 3-Watch，Timeline 3401 flush、56.16 Hz、87.58 Hz/表达式，Watch 17/23/31 ms，Watch gate queue wait 6.50/11.33/17.56 ms，handoff gap 0.002/0.005/0.041 ms，helper PID 10848，Flash 0，退出后 owner 进程 0。
- `outputs/dap07/watch-6/2026-08-07-08-48-15/evidence.json`：事件驱动方案 CMSIS-DAP 60 秒 6-Watch，Timeline 3165 flush、52.27 Hz、80.95 Hz/表达式，Watch 23/28/34 ms，Watch gate queue wait 6.49/11.57/17.03 ms，handoff gap 0.002/0.005/0.050 ms，helper PID 18720，Flash 0，退出后 owner 进程 0。
- `outputs/dap07/watch-6/2026-08-07-11-24-58/evidence.json`：CMSIS-DAP 1000 kHz 15 秒频率基线，155.05 Hz/表达式，Watch 16/18/20 ms。
- `outputs/dap07/watch-6/2026-08-07-11-25-25/evidence.json`：CMSIS-DAP 2000 kHz 15 秒，201.60 Hz/表达式，Watch 13/14/16 ms。
- `outputs/dap07/watch-6/2026-08-07-11-25-54/evidence.json`：CMSIS-DAP 4000 kHz 15 秒，262.89 Hz/表达式，Watch 11/12/14 ms。
- `outputs/dap07/watch-6/2026-08-07-11-26-22/evidence.json`：CMSIS-DAP 6000 kHz 15 秒，257.72 Hz/表达式，稳定但无新增收益。
- `outputs/dap07/watch-6/2026-08-07-11-26-52/evidence.json`：CMSIS-DAP 8000 kHz 15 秒，257.11 Hz/表达式，连续第二档进入平台。
- `outputs/dap07/watch-6/2026-08-07-11-27-14/evidence.json`：CMSIS-DAP 10000 kHz 5 秒能力冒烟，239.23 Hz/表达式；协议与数据稳定，但未测量物理 SWCLK。
- `outputs/dap07/watch-6/2026-08-07-11-28-39/evidence.json`：CMSIS-DAP 4000 kHz 60 秒长稳复核，Timeline 48390 点、57.34 flush Hz、266.39 Hz/表达式，594/594 Watch 成功，Pause 22 ms，helper PID 29536，Flash 0，退出后 owner 进程 0。
- `outputs/dap07/jlink/watch-3/2026-08-07-08-49-07/evidence.json`：本轮 J-Link 3-Watch 尝试在 native helper `connect` 超时（5 s）时终止，未产生采样；当时系统未枚举 SEGGER/J-Link USB 设备，不能作为硬件性能结果。
- `outputs/dap07/jlink/watch-6/2026-08-07-08-57-14/evidence.json`：本轮 J-Link 6-Watch 同样在 native helper `connect` 超时（5 s）时终止，未产生采样；不能作为硬件性能结果。
- `outputs/dap07/jlink/watch-3/2026-08-07-09-03-26/evidence.json`：更换探针后的 J-Link 60 秒 3-Watch，Timeline 66840 点、58.43 flush Hz、368.67 Hz/表达式，Watch 5/6/8 ms，Watch 成功率 100%，Pause 10 ms，helper PID 32996，Flash 0，退出后 owner 进程 0。
- `outputs/dap07/jlink/watch-6/2026-08-07-09-04-54/evidence.json`：更换探针后的 J-Link 60 秒 6-Watch，Timeline 64797 点、60.13 flush Hz、357.40 Hz/表达式，Watch 6/7/8 ms，Watch 成功率 100%，Pause 11 ms，helper PID 29308，Flash 0，退出后 owner 进程 0。
- `outputs/dap07/jlink/watch-3/2026-08-07-11-06-14/evidence.json`：本次连接后的 J-Link 1000 kHz 5 秒冒烟，唯一 native helper、Watch 数据成功率 100%、Pause 11 ms、Flash 0，退出清理通过。
- `outputs/dap07/jlink/watch-3/2026-08-07-11-07-27/evidence.json`：J-Link 1000 kHz 60 秒 3-Watch，Timeline 66129 点、59.38 flush Hz、364.69 Hz/表达式，Watch 5/6/7 ms，Pause 10 ms，helper PID 31064。
- `outputs/dap07/jlink/watch-6/2026-08-07-11-08-45/evidence.json`：J-Link 1000 kHz 60 秒 6-Watch，Timeline 65682 点、59.04 flush Hz、362.29 Hz/表达式，Watch 6/7/8 ms，Pause 10 ms，helper PID 33168。
- `outputs/dap07/jlink/watch-3/2026-08-07-11-09-06/evidence.json`：J-Link 4000 kHz 5 秒冒烟，689.38 Hz/表达式、Watch P95 3 ms、Pause 4 ms，全部强校验通过。
- `outputs/dap07/jlink/watch-3/2026-08-07-11-10-20/evidence.json`：J-Link 4000 kHz 60 秒 3-Watch，Timeline 136515 点、61.09 flush Hz、752.92 Hz/表达式，Watch 2/3/4 ms，Pause 3 ms，helper PID 34000。
- `outputs/dap07/jlink/watch-6/2026-08-07-11-11-33/evidence.json`：J-Link 4000 kHz 60 秒 6-Watch，Timeline 136104 点、61.08 flush Hz、750.16 Hz/表达式，Watch 3/3/5 ms，Pause 4 ms，helper PID 16984。
- `outputs/dap07/jlink/watch-6/2026-08-07-11-44-29/evidence.json`：本次连接后的 J-Link 4000 kHz 5 秒冒烟，唯一 native owner、Watch 成功率 100%、Pause 4 ms、Flash 0，退出清理通过。
- `outputs/dap07/jlink/watch-6/2026-08-07-11-44-59/evidence.json`：J-Link 4000 kHz 15 秒频率基线，718.90 Hz/表达式，Watch 3/4/4 ms。
- `outputs/dap07/jlink/watch-6/2026-08-07-11-45-29/evidence.json`：J-Link 6000 kHz 15 秒，732.79 Hz/表达式，较上一档仅提升 1.9%。
- `outputs/dap07/jlink/watch-6/2026-08-07-11-46-00/evidence.json`：J-Link 8000 kHz 15 秒，719.55 Hz/表达式，连续第二档无明显提升，按门槛停止递增。
- J-Link DLL 只加载预检：helper 0.2.0 加载 `C:\Program Files\SEGGER\JLink_V956\JLink_x64.dll`，`dllVersion=95600`；未连接 target，随后正常 shutdown。

最终验证（2026-08-07）：

- DAP-07 focused Vitest：5 个文件、71/71 项测试通过；包含 planner cache、单次 helper batch RPC、gate 指标、probe-aware owner 校验和实际采样率计算。
- 全量 Vitest：30 个文件、257/257 项测试通过。
- `npm run typecheck`、`npm run build`、`npm run build:native` 通过。
- `npm run test:cmsis-dap:mock`、`npm run test:cpp-channel:mock`、`npm run test:cmsis-dap:algorithm` 通过。
- 新增 `src/debug/dap-session-target-read-gate.test.ts`：11/11 通过，覆盖即时交接、优先级、control 排他、timeout、AbortSignal、generation/termination、无双重获取、恢复和指标清理。
- `orbit-cmsis-dap-helper.exe --selftest`：185/185 项通过；`git diff --check` 通过。
- `npm run lint` 未进入规则检查：当前 ESLint 9.39.4 找不到仓库的 `eslint.config.js|mjs|cjs`。这是现有 lint 配置缺口，本次未扩大范围迁移配置。

## 风险与缺口

验收判定：事件驱动交接和四项低/中风险优化的代码、聚焦测试、全量自动化验证及真机矩阵均达到目标；最新 J-Link 1000/4000 kHz 四组的 handoff gap P95 均不超过 0.003 ms，Timeline 吞吐未退化且 Watch 成功率保持 100%。J-Link 1000 kHz Watch P50 为 5--6 ms，4000 kHz 为 2--3 ms；CMSIS-DAP Watch P50 为 11/16 ms。

- 结果只适用于本次 STM32F407VET6、CMSIS-DAP v1 HID 与 J-Link DLL 9.56 环境，不能外推到 CMSIS-DAP v2、无线 DAPLink、其他 J-Link 固件/DLL 或其他 MCU。
- 硬件脚本验证 DAP 事件和数据吞吐，不包含真实 VS Code webview 的 rAF/Canvas 渲染时间；现有 UI 已按 frame 合并消息，但最终主观流畅度仍需用户在 VS Code 中独立确认。
- 本轮 Timeline 只采样 3 个标量；复杂 Watch 的折叠/展开行为由自动化回归保护，但尚未完成 60 秒的真实展开结构体矩阵。
- J-Link native 使用当前连接的 J-Link OB 完成 1000/4000 kHz 的 3/6 Watch 复测；结果适用于当前 STM32F407VET6、J-Link DLL 9.56 和该探针固件组合。
- 未更新 `docs/bug-fix-log.md`。按项目规则，只有用户明确确认真实 UI 修复后才能写入历史。
- 未进入 DAP-08 RTT、RTOS View、MemoryView、Peripheral Viewer 或无线 DAPLink。

## 硬件授权记录

已执行：连接、halt、run/continue、pause、session disconnect/reconnect、RAM 只读采样。

未执行：Flash erase/program/verify、Option Bytes、保护位或危险外设写入。所有 DAP-07 launch 均为 `flashBeforeDebug=false`。
