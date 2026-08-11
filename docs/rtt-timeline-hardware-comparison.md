# RTT 与 Timeline 真机测试对比报告

日期：2026-08-08

## 1. 测试目标与结论

本报告汇总 DAPLink 与 J-Link OB 在 Timeline、Watch 和 RTT 并行运行时的真实硬件数据，并对比 J-Link RTT 修复前后的行为。核心结论如下：

1. J-Link 修复前的问题不是 RTT 读取大小、轮询间隔、SWD 1/4 MHz 或 RTT 地址发现方式造成的，而是 native helper 同步调用 `JLINK_RTTERMINAL_Read` 后约 5 秒不返回。该调用占住唯一 owner，Scheduler 无法抢占，最终阻塞 Timeline/Watch，并可能导致 `NativeOwnerLost`。
2. J-Link 改为同一 native owner 下的内存型 RTT reader 后，`64 B / 500 ms` 与 Timeline 可以稳定并行。5 秒同配置对照中，Timeline 从 `678.07` 变为 `679.10 Hz/表达式`，差异约 `+0.15%`；15 秒 soak 为 `712.47 Hz/表达式`，Watch P95 为 `3 ms`。
3. DAPLink 在本轮 4 MHz、3 Watch、15 秒对照中，开启 `64 B / 500 ms` RTT 后，Timeline 从 `270.28` 降至 `256.96 Hz/表达式`，变化 `-4.93%`；Timeline P95 从 `19` 增至 `20 ms`，Watch P95 从 `8` 增至 `9 ms`。RTT 共轮询 28 次并读取 1218 B，无 overrun、无错误。
4. 受限机会式轮询继续由 `orbit.rttPollIntervalMs` 控制，并采用“本轮完成后至少等待配置间隔”的语义。本轮 DAPLink 配置为 500 ms，实测轮询间隔 P50/P95 为 `527/531 ms`，没有轮询积压。
5. 两种探针的 RTT 均复用当前调试会话的唯一物理 owner；未创建第二 owner，未使用 OpenOCD、GDB server、`JLink.exe` 或 Ozone GUI 自动化路径。

## 2. 测试环境

| 项目 | DAPLink | J-Link OB |
|---|---|---|
| MCU | STM32F407VET6 | STM32F407VET6 |
| 工程 | `D:\STM32\project\vet6_led` | `D:\STM32\project\vet6_led` |
| ELF | `D:\STM32\project\vet6_led\build\Debug\vet6_led.elf` | 同左 |
| RTT 符号 | `_SEGGER_RTT = 0x20005178`，从 ELF 自动解析 | `_SEGGER_RTT = 0x20005178`，显式地址与自动解析均测试过 |
| Probe | CMSIS-DAP_LU | J-Link OB |
| VID/PID | `C251:F001` | `1366:0101` |
| Serial | `LU_2022_8888` | `000020090928` |
| Transport | CMSIS-DAP v1 HID | J-Link native helper + DLL |
| Report/packet | input/output report 65 B，report ID 0，协议 payload 64 B | 不适用 |
| DLL | 不适用 | `C:\Program Files\SEGGER\JLink_V956\JLink_x64.dll`，版本 95600 |
| Owner | `probe=cmsis-dap owner=cmsis-dap` | `mode=native owner=jlink-native` |
| SWD | 请求 4000 kHz；另有历史 1000--10000 kHz 阶梯 | 请求 1000/4000 kHz；另有历史 6000/8000 kHz 阶梯 |
| Flash | `flashBeforeDebug=false` | `flashBeforeDebug=false` |

说明：本轮性能脚本验证了 SWD 配置请求和稳定 target access，但没有用示波器或逻辑分析仪回读物理 SWCLK；因此本文中的 4 MHz 均表示请求配置值。当前探针/脚本未提供 VTref 数值，本轮 evidence 也未单独持久化 DPIDR 数值；连接成功后的 DP/AP、Cortex-M 状态和内存采样均正常，但不能把缺失字段写成已测量值。

## 3. 统一测试方法

除修复前专门的失败复现实验外，用于直接比较的 Timeline 场景保持以下配置：

| 参数 | 值 |
|---|---:|
| Timeline 表达式 | `uwTick`、`xTickCount`、`aww` |
| Watch 表达式数 | 3 |
| Watch 请求周期 | 100 ms |
| Timeline 目标采样间隔 | 0.2 ms |
| DAP 发送间隔 | 16 ms |
| RTT 单次最大读取 | 64 B |
| RTT 配置轮询间隔 | 500 ms |
| SWD 请求速度 | 4000 kHz |
| Flash | 关闭 |

指标定义：

- `Timeline flush Hz`：`ozoneDataSamples` 事件数除以有效时长，代表 DAP 向 UI 批量发送数据的频率。
- `实际采样 Hz/表达式`：Timeline 总点数除以表达式数和有效时长，代表每条表达式实际获得的数据点频率。
- `Timeline P95/max`：相邻 `ozoneDataSamples` 事件间隔。
- `Watch P50/P95/max`：一次 `watchEvaluate` 请求的端到端耗时。

## 4. J-Link 修复前数据

### 4.1 RTT-off 基线

| 配置 | 时长 | Watch | Timeline flush Hz | 实际采样 Hz/表达式 | Timeline P50/P95/max ms | Watch P50/P95/max ms | Pause ms | 结果 |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| 1 MHz，RTT-off | 15.47 s | 6 | 58.50 | 348.74 | 16 / 18 / 21 | 6 / 7 / 7 | 9 | 通过 |
| 4 MHz，RTT-off | 15.52 s | 6 | 59.40 | 714.79 | 16 / 17 / 26 | 3 / 3 / 4 | 4 | 通过 |

4 MHz 相比 1 MHz 的实际采样率约为 `2.05x`。两组 Watch 数据成功率均为 100%，Flash 操作为 0，断开后无 owner 进程残留。

### 4.2 Vendor RTT API 失败复现

| SWD / RTT 配置 | RTT 地址 | 观察结果 |
|---|---|---|
| 1 MHz，4096 B / 50 ms | 显式地址 | 首次 `JLINK_RTTERMINAL_Read` 约 5 秒不返回，随后丢失 native owner |
| 4 MHz，4096 B / 50 ms | 显式地址 | 与 1 MHz 相同，约 5 秒阻塞并丢失 owner |
| 4 MHz，64 B / 500 ms | `0x20005178` | RTT 读取 0 B；Timeline `30.37 Hz/表达式`；Watch P95 `527 ms`；Pause `282 ms` |
| 4 MHz，64 B / 500 ms | 自动发现 | RTT 读取 0 B；Timeline `57.68 Hz/表达式`；Watch P95 `530 ms`；Pause `779 ms` |

这组实验排除了以下因素：

- 将 SWD 从 1 MHz 提升到 4 MHz 不能消除阻塞。
- 将读取量从 4096 B 降到 64 B、将轮询从 50 ms 放宽到 500 ms 不能消除阻塞。
- 显式地址与自动发现均出现同类问题，RTT 控制块地址发现不是根因。
- 即使 RTT 没有返回有效字节，vendor API 仍会长时间占用 owner，因此问题不取决于日志吞吐量。

## 5. J-Link 修复方案

J-Link native helper 不再使用同步阻塞的：

- `JLINK_RTTERMINAL_Control`
- `JLINK_RTTERMINAL_Read`

改为在同一 `jlink-native` owner 内通过以下 API 访问 SEGGER RTT control block 和 up-buffer：

- `JLINK_ReadMem`
- `JLINK_WriteMem`

实现复用 CMSIS-DAP helper 已使用的 `segger_rtt` 内存协议解析器，不扫描 RAM，不创建第二 owner。`startRtt`、`stopRtt` 为 control 工作，`readRtt` 为 background 工作；调度顺序保持 `control > watch > timeline > background`。RTT 轮询仍由 `orbit.rttPollIntervalMs` 控制，且一个 DAP 会话最多只有一轮排队或执行中的 RTT 读取。

Direct helper 验证中，`startRtt` 为 `0 ms`，`readRtt` 为 `3 ms`，单次成功读取 64 B；原先约 5 秒的不可抢占阻塞不再出现。

## 6. J-Link 修复后数据

### 6.1 5 秒等条件对照

| 配置 | 有效时长 | Timeline flush Hz | 实际采样 Hz/表达式 | Timeline P50/P95/max ms | Watch P50/P95/max ms | Pause ms | RTT |
|---|---:|---:|---:|---:|---:|---:|---|
| 4 MHz，RTT-off | 5.44 s | 56.08 | 678.07 | 16 / 17 / 18 | 2 / 3 / 3 | 4 | 关闭 |
| 4 MHz，RTT-on，64 B / 500 ms | 5.44 s | 56.24 | 679.10 | 16 / 17 / 31 | 2 / 3 / 7 | 4 | 连续 10 轮，每轮 64 B |

同条件下实际采样率变化约 `+0.15%`，P95 没有变化。RTT-on 组无错误、无 `NativeOwnerLost`、无 Flash、单一 `jlink-native` owner，断开后无残留进程。

### 6.2 15 秒 RTT soak

| 指标 | 结果 |
|---|---:|
| 有效时长 | 15.42 s |
| Timeline 点数 | 32965 |
| Timeline flush | 59.92 Hz |
| 实际采样率 | 712.47 Hz/表达式 |
| Timeline P50/P95/max | 16 / 17 / 18 ms |
| Watch 请求 | 142 |
| Watch P50/P95/max | 2 / 3 / 6 ms |
| Watch 数据成功率 | 100% |
| Pause | 4 ms |
| 错误 | 0 |
| Flash 操作 | 0 |
| owner 清理 | 通过 |

## 7. DAPLink 4 MHz 本轮数据

本轮于 2026-08-08 使用当前重新连接的 DAPLink 采集。两组均为 3 Watch、目标 Timeline 间隔 0.2 ms、发送间隔 16 ms、请求时长 15 秒。

### 7.1 RTT-off 与 RTT-on 对照

| 指标 | RTT-off 基线 | RTT-on，64 B / 500 ms | 变化 |
|---|---:|---:|---:|
| 有效时长 | 15.506 s | 15.528 s | +0.022 s |
| Timeline 事件 | 870 | 852 | -18 |
| Timeline 点数 | 12573 | 11970 | -603 |
| Timeline flush | 56.11 Hz | 54.87 Hz | -2.21% |
| 实际采样率 | 270.28 Hz/表达式 | 256.96 Hz/表达式 | **-4.93%** |
| Timeline P50 | 17 ms | 17 ms | 0 ms |
| Timeline P95 | 19 ms | 20 ms | +1 ms |
| Timeline max | 24 ms | 42 ms | +18 ms |
| Watch 请求 | 149 | 149 | 0 |
| Watch P50 | 7 ms | 7 ms | 0 ms |
| Watch P95 | 8 ms | 9 ms | +1 ms |
| Watch max | 12 ms | 33 ms | +21 ms |
| Watch 数据成功率 | 100% | 100% | 0 |
| Pause | 23 ms | 23 ms | 0 ms |
| 错误 | 0 | 0 | 0 |
| Flash 操作 | 0 | 0 | 0 |
| owner 清理 | 通过 | 通过 | 无回归 |

### 7.2 RTT 轮询与吞吐

| RTT 指标 | 实测值 |
|---|---:|
| Control block | `0x20005178`，ELF 自动解析 |
| Buffer index | 0 |
| 配置读取上限 | 64 B/轮 |
| 配置轮询间隔 | 500 ms，完成后计时 |
| 实际轮询次数 | 28 |
| 非空轮询 | 23 |
| 空轮询 | 5 |
| 总读取字节 | 1218 B |
| 实际轮询间隔 P50/P95/max | 527 / 531 / 533 ms |
| 首次读取 | 64 B |
| overrun | 0 |
| `startRtt` / `stopRtt` | 均成功 |

RTT 日志显示轮询在 Timeline 活动期间持续进行。前段连续读取 64 B 并推进 `RdOff`，缓冲区追平后出现正常的 14 B 或 0 B 读取。实际间隔比 500 ms 多约 27--31 ms，是“RTT 读取完成后再等待 500 ms”的预期结果，不是定时器漂移积压。

### 7.3 DAPLink 历史 4 MHz 基线

历史 6-Watch、RTT-off、4 MHz 数据用于观察长期稳定性，不与本轮 3-Watch 数据直接计算 RTT 开销：

| 场景 | 时长 | Timeline flush Hz | 实际采样 Hz/表达式 | Watch P50/P95/max ms | 结果 |
|---|---:|---:|---:|---:|---|
| 6 Watch，RTT-off | 15 s | 55.73 | 262.89 | 11 / 12 / 14 | 稳定 |
| 6 Watch，RTT-off 长稳 | 60 s | 57.34 | 266.39 | 11 / 12 / 14 | 594/594 Watch 成功 |

历史频率阶梯显示，当前 CMSIS-DAP v1 HID 探针从 1 MHz 提升到 4 MHz 有明显收益，4 MHz 以上进入平台，因此 4 MHz 仍是推荐速度。主要上限来自 HID 64-byte payload 往返和 helper/USB 调度，而不是 SWD 位时钟。

### 7.4 DAPLink 早期 RTT 传输 smoke

在固件重新链接前，DAPLink 还完成过一次不启用 Timeline 的短时 RTT 传输验证：

| 项目 | 结果 |
|---|---|
| 当时的 RTT 符号 | `_SEGGER_RTT = 0x20005174` |
| `startRtt` | 成功 |
| 首次读取 | 6 B：`[4, 0, 233, 52, 210, 95]` |
| `RdOff` | 从 0 推进到 6 |
| 后续空读 | 4 次，`RdOff` 保持 6 |
| Up-buffer | 地址 `0x2000521C`，大小 1024 B |
| 目标状态 | Running |
| Flash/控制操作 | 未烧录、未 reset、未 halt、未 run |

该 6 B 是固件 P-RTLog 的 token 化二进制数据，不是 ASCII 文本。它证明了 CMSIS-DAP 内存型 RTT reader 的 control block、payload 读取和 `RdOff` 提交路径。当前 ELF 重新链接后符号变为 `0x20005178`，本轮测试由 ELF 自动解析新地址；地址变化不是 RTT 行为回归。

## 8. 跨探针对比

取本轮/修复后的 4 MHz、3 Watch、15 秒、RTT `64 B / 500 ms` 结果：

| 指标 | DAPLink | J-Link OB | 观察 |
|---|---:|---:|---|
| Timeline flush | 54.87 Hz | 59.92 Hz | 两者均接近 16 ms 批次发送上限 |
| 实际采样率 | 256.96 Hz/表达式 | 712.47 Hz/表达式 | J-Link 约为 DAPLink 的 2.77 倍 |
| Timeline P95 | 20 ms | 17 ms | J-Link 更稳定 |
| Watch P95 | 9 ms | 3 ms | J-Link 更低 |
| Pause | 23 ms | 4 ms | J-Link 更低 |
| Watch 成功率 | 100% | 100% | 均通过 |
| RTT 有效读取 | 28 轮，1218 B | 5 秒验证连续 10 轮，每轮 64 B | 均证明 Timeline 活动期间 RTT 可用 |
| owner 丢失 | 0 | 0 | 均无 `NativeOwnerLost` |
| Flash 操作 | 0 | 0 | 均未烧录 |

J-Link 与 DAPLink 的绝对采样率差异主要来自传输路径：J-Link native helper/DLL 单次 target read 延迟更低；DAPLink 使用 CMSIS-DAP v1 HID，每次访问受 64-byte payload 和 USB report 往返限制。该差异不是受限机会式 RTT 轮询本身造成的。

## 9. 对 Timeline 的影响判断

### J-Link

- 修复前：RTT 会让约 700 Hz/表达式的 Timeline 降至约 30--58 Hz/表达式，Watch P95 上升到约 527--530 ms，并可能丢失 owner，属于不可接受的灾难性阻塞。
- 修复后：5 秒等条件对照为 `678.07 -> 679.10 Hz/表达式`，P95 保持 17 ms；15 秒 soak 为 712.47 Hz/表达式。当前数据中没有可测的持续吞吐损失。

### DAPLink

- 本轮 4 MHz 的实际采样率下降 4.93%，Timeline P95 增加 1 ms，Watch P95 增加 1 ms。
- 最大间隔出现一次性放大，但没有形成持续阻塞、Watch 失败、owner 丢失或控制超时。
- 28 轮 RTT 均按约 527--533 ms 的完成后间隔执行，没有积压或 overrun。
- 对基础日志场景而言，`64 B / 500 ms` 的影响较小，符合“优先保证 Timeline，RTT 使用剩余机会”的设计目标。

## 10. 自动化验证

本次 RTT/Timeline 修改此前已经完成以下自动化验证：

| 验证 | 结果 |
|---|---|
| focused Vitest | 6 个文件，83 个测试通过 |
| 后续 RTT/J-Link focused | 15 个测试通过 |
| CMSIS-DAP RTT C++ oracle | `orbit-cmsis-dap-rtt-tests.exe` PASS |
| J-Link mock channel | `node scripts/cpp-channel-smoke.js --mock` PASS |
| TypeScript | `npm run typecheck` 通过 |
| Extension bundle | `npm run build` 通过 |
| Native helper | `npm run build:native` 通过 |
| Whitespace | `git diff --check` 无 whitespace error，仅 CRLF warning |

Mock、单元测试和构建结果只证明代码与协议层；第 6、7 节的 evidence 才是真实硬件性能证据。

## 11. 安全、路由与清理结果

- 两种 probe 均只创建一个物理 target owner。
- DAPLink 路径未创建或回退到 J-Link owner；J-Link 路径未创建 legacy 或 CMSIS-DAP owner。
- 所有正式测试均为 `flashBeforeDebug=false`，Flash operation count 为 0。
- 未执行 erase、program、verify、Option Bytes 或保护位操作。
- RTT 读取在消费数据后会写入 `RdOff`，这是 SEGGER RTT 协议必需的目标 RAM 写入；除此之外未进行日志相关目标写入。
- 测试包含连接、halt、continue、pause、RTT `RdOff` 提交和 disconnect。
- 测试结束后未发现 `orbit-cmsis-dap-helper`、`orbit-jlink-helper`、OpenOCD、GDB 或 `JLink.exe` 残留进程。

## 12. 证据归档

本节对应的原始硬件 evidence、运行日志和阶段验收报告已在 1.1.0 发布清理中移出仓库。本文保留最终对比结果、测试条件、安全边界和已知限制；后续复验应使用仓库中的硬件验证脚本生成新的独立证据。

## 13. 适用范围与剩余限制

- 结论适用于当前 STM32F407VET6 固件、当前 ELF、CMSIS-DAP_LU v1 HID、当前 J-Link OB 与 J-Link DLL 9.56 组合。
- DAPLink 本轮 RTT-on/off 对照为 15 秒；已证明短时稳定和对 Timeline 的影响，但不等同于 60 秒 RTT soak、断线恢复或高日志吞吐无损测试。
- J-Link 已完成 15 秒 RTT soak；更长时间、不同 J-Link 固件/DLL、其他 MCU 或其他 RTT buffer 大小仍需单独验证。
- RTT 总读取字节数只表示 host 从当前 control block 消费的字节，不等同于固件完整日志产生量；无丢日志结论还需要固件侧序号或产生/丢弃计数共同验证。
- VS Code Timeline webview 的渲染流畅度不包含在 DAP harness 指标内，本文衡量的是 target read、DAP 批次和 Watch 请求性能。
