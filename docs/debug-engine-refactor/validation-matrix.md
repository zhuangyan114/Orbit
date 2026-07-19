# Native Debug Engine 重构验证矩阵

## 目的与边界

本矩阵是任务 12 的验收基线，用于比较 Native session-owner 路径与 legacy koffi fallback 路径。它不引入 OpenOCD、GDB server 或 `JLink.exe` 常规调试通道；所有目标访问仍通过 J-Link DLL，且 `JLINK_SetBP(slot, address)` 是硬件断点唯一的正常接口。

每个场景必须分别记录 Native 与 legacy 的实际结果。Native session-owner 和 legacy fallback 不是可相互替代的证据：Native Mock 通过不能证明真实硬件，legacy 硬件通过也不能证明 Native 硬件通过。

## 测试环境与证据分级

### 环境记录表

每次真实硬件运行在报告顶部填写下表；缺失字段使该次结果仅能作为辅助证据。

| 字段 | 本次填写值 | 已有历史数据 | 新采集要求 |
|---|---|---|---|
| 日期、提交/工作树版本 | 待填写 | 2026-07-12 历史运行；工作树目前为脏 | 记录 commit（如有）、工作树状态、Native helper 版本 |
| MCU 与板卡 | 待填写 | STM32F407VE，`vet6_led` | 记录 MCU、板卡、供电与复位方式 |
| J-Link DLL | 待填写 | `JLink_V956/JLink_x64.dll`，日志版本 `v117.112` | 记录完整路径、DLL/firmware 版本 |
| 接口与速度 | 待填写 | SWD，4000 kHz | 记录 SWD/JTAG、kHz 和 J-Link 序列号（可脱敏） |
| ELF 与源码 | 待填写 | `vet6_led.elf`，`Core/Src/freertos.c` | 记录 ELF SHA-256、编译器、`-g`、优化级别、LTO、frame pointer 选项 |
| VS Code 与扩展运行时 | 待填写 | 未在历史记录中完整保存 | 记录 VS Code、Electron/Node、扩展版本 |
| Native 开关 | 待填写 | 历史并发硬件运行明确为 Native step 未启用 | 分别记录 `nativeDebugEngineEnabled` 与 StepInto/Over/Out 开关 |
| 路径与 owner | 待填写 | 历史为单 legacy owner；Native Mock 有 session 禁止内部 fallback 检查 | 记录 `native`/`legacy`、helper PID、唯一 owner 和 fallback 原因 |

### 证据等级与状态

| 证据等级 | 含义 | 可证明的范围 |
|---|---|---|
| 代码检查 | 已从当前实现的控制流、日志点或配置读取到行为 | 设计意图与可观测点，不证明运行结果 |
| Mock | Mock J-Link DLL/helper 集成运行 | 协议、状态机分支、清理和顺序；不证明 J-Link/MCU 时序 |
| 自动测试 | Vitest、类型检查、构建等可重复自动运行 | 被测试的隔离契约；不证明未覆盖的硬件控制流 |
| 真实硬件 | 在记录完整环境中保存日志、DAP trace 或可复查录波的运行 | 该硬件、DLL、固件与配置组合 |
| 未验证 | 尚无上述可复查证据 | 不能据此发布或默认开启 |

状态含义：**通过**表示该场景达到门槛且证据等级满足场景要求；**部分通过**表示仅部分次数、部分路径或较低等级证据；**未验证**表示没有足够证据；**失败**表示复现了不符合预期的结果。表中“历史真实硬件”仅引用已有记录，不会自动升级为 Native 通过。

### 日志与采集约定

保留原始 `outputs/Log/` 目录和 DAP trace，并为每条矩阵记录附上时间范围、session ID 和矩阵编号。检查字段至少包括：

| 文件/来源 | 必查字段 |
|---|---|
| `outputs/Log/step.log` | command ID、step kind、`pcBefore`/`pcAfter`、指令半字/分类、临时断点地址/槽位、wait/poll、cleanup、total elapsed |
| `outputs/Log/dap.log` | `handleStep` attempt、Native/legacy mode、`Target busy`、step response、`native stopped event` 或 legacy poll、stopped event、read-cancel/采样恢复 |
| `outputs/Log/eval.log` | Watch/evaluate、读缓存或 `running` 占位、`setWatchValue` 前后值、DWARF 错误、MemoryView 读写 |
| `outputs/Log/dll.log` | DLL load/open/connect、接口/速度、reset、disconnect/reconnect、唯一 owner 证据 |
| DAP trace 与 plugin/MCP RPC trace | response 在 stopped 前、`customRequest` 路由、失败响应、没有错误回退到 extension-host |
| Timeline/recording 导出 | recording ID、帧数、时间戳单调性、step/写入前后恢复、错误帧与最大间隙 |

历史可复用数据：`performance-baseline.md` 的 2026-07-12 legacy stepOver profile，及 `realtime-variable-protection.md` 的 Watch/Timeline/写入与 legacy 单 owner 记录。必须新采集：所有 Native 真实硬件性能、完整 Native 20/20/20 压力、VS Code/ELF 元数据、Native helper 异常与完整路由失败场景。

## 统一矩阵

除非“路径”列另有说明，每个 `N+L` 项都要在 Native session-owner 和禁用 Native 的 legacy fallback 各执行一次；记录相同固件位置的 PC、源码位置及停止原因。`<50/<100/<200 ms` 是 Native 正常路径门槛，不适用于历史 legacy 基线。

| 编号 | 类别 / 路径 | 复现代码形态或固件前置条件 | 操作步骤 | 预期 PC、源码行或 DAP stopped 状态 | 性能门槛 | 日志检查 | 执行方式 | 当前证据与状态 | 失败后初查方向 |
|---|---|---|---|---|---|---|---|---|---|
| VM-01 | 普通语句 / N+L | 独立赋值、算术、load/store；每句单独行 | 在每句首条指令执行 stepOver、stepInto 各一次 | PC 前进到下一实际指令；源码离开当前 statement；一次 `stopped(reason=step)` | Native 非调用 `<50 ms`；无正常 5 s 等待 | step 的前后 PC、分类 `NonControl*`、无 temp BP；DAP response/stopped | 自动测试 + 硬件 | 代码检查；历史真实硬件仅 legacy stepOver；Native 硬件未验证。**部分通过** | 指令解码、halt 同步、source map、固定 sleep |
| VM-02 | 直接调用与嵌套调用 / N+L | `foo()`、`outer()->inner()`，包含 Thumb `BL`/立即 `BLX` | 调用行 stepOver；在相同位置 stepInto；在 inner stepOut | Over 停在 return statement/return address 后的有效源码位置，不进入 callee；Into 进入 callee；Out 回 caller | Over `<100 ms`；嵌套/复杂 `<200 ms` | return address、temp BP、槽位、命中分类、cleanup、LR、PC before/after | Mock + 硬件 | Mock/自动测试覆盖基本 step；历史硬件有 legacy 调用样本；Native 硬件未验证。**部分通过** | call 宽度、return PC、temp BP 生命周期、DWARF 行表 |
| VM-03 | 寄存器间接调用 / N+L | 函数指针 `fn()`，编译出 `BLX Rm` | 在参数准备和 `BLX` 行分别 stepOver/stepInto | Over 以 fallthrough return address 停止；Into 在实际 callee；不把 `Rm` 目标当 temp BP | Over `<100 ms` | `CallRegister`、return address、PC after、source range | Mock + 硬件 | 代码检查；历史 legacy 基线包含 BLX；Native 硬件未验证。**部分通过** | BLX 分类、Thumb 位、参数准备的源码级扫描 |
| VM-04 | stepInto 源码级扫描 / Native；指令级对照 / legacy | 调用前有 2-3 条参数准备指令 | 点击一次 stepInto；再对照 legacy stepInto | Native 一次 UI 操作进入 callee；非调用行在离开当前源码范围或上限时 stopped；无伪 stopped | Native 扫描正常 `<200 ms` | 扫描 PC/分类、最大步数、`pcAfter`、DAP 顺序 | Mock + 硬件 | Mock/自动测试；历史硬件曾确认一次进入但次数不足。**部分通过** | `stepIntoSourceLine` 范围、32 条上限、line bounds、DAP 路由 |
| VM-05 | stepOut、source hint、后续首步 / N+L | 叶/非叶函数；caller 的调用后有下一 statement | callee stepOut，核对首帧；紧接首次 stepInto 和 stepOver | Out 停在 LR return address；stackTrace 可用 source hint 显示调用后 statement；首次后续 step 直接离开 hint，不出现视觉空步 | Out `<100 ms`，复杂 `<200 ms` | LR/SP/return address、hint raw/used、line bounds、PC before/after、cleanup、stopped | 自动测试 + Mock + 硬件 | 自动测试与历史真实硬件确认该回归；Native 完整压力未验证。**部分通过** | hint 有效性/同函数限制、真实 PC、`resolveNativeLineBounds` |
| VM-06 | 条件与选择分支 / N+L | `if/else`，`switch-case break`，含 `B/B.W`、`TBB/TBH` | 在 condition、每个 case 与 `break` 上 stepOver | 停在 CPU 实际选择的分支/后续语句；`break` 不跳回 switch，不在不可达 `PC+2` 等待 | 分支正常 `<50 ms`；复杂 `<200 ms` | 分类、实际 PC、`waitForHalt`、timeout、用户 BP 命中 | 自动测试 + 硬件 | 代码检查；历史 legacy baseline 无 5 s stall；Native 硬件未验证。**部分通过** | branch/table-branch 策略、line map、不可达 temp BP |
| VM-07 | 循环与递归 / N+L | `while`、`for`、`do-while`，递归函数；循环尾与循环头均可设断点 | 每个循环体/条件/回跳处反复 stepOver；在递归层 stepInto/Out | 实际执行流可停在循环头、下一语句或用户 BP；不回跳随机位置、不无限循环；递归 Out 返回正确层级 | 单次复杂 `<200 ms`；无 5 s 正常等待 | same-line count、重复 PC、branch、poll、stack/LR、timeout/cleanup | 自动测试 + 硬件 | 历史 legacy 真实硬件覆盖 loops/recursion；Native 未验证。**部分通过** | same-line 上限、回跳 policy、函数范围、stale BP |
| VM-08 | DWARF 边界 / N+L | 宏展开、多语句同行、逗号表达式；分别构建 `-O0 -g`、`-Og/-O2 -g` | 对每种行形态 step 三种操作；对优化版保留原始地址/行表 | 可接受停止到同 statement 的实际指令或返回明确诊断；不得盲设 BP 或伪造源码行 | 非调用 `<50 ms`；复杂 `<200 ms`；异常不走 5 s | source before/after、line range、same-line count、`Unknown` 分类、DWARF 错误 | 硬件 | 历史 legacy 有多语句同行基线；宏/优化 Native 未验证。**部分通过** | line table 可靠性、范围校验、有限单步/诊断降级 |
| VM-09 | 当前 PC 用户断点 / N+L | 当前停点正好是已启用用户 BP | 命中 BP 后执行 Into/Over/Out；重复一次 | 先安全越过当前 BP，再完成 step；原 BP 恢复到原槽；不立即再次命中 | 各路径正常门槛；无 5 s 等待 | 当前 BP 地址/槽位、clear/restore、PC、cleanup | Mock + 硬件 | Mock/自动测试覆盖；历史明确硬件采样缺失。**部分通过** | `HandleCurrentBreakpoint`、JLINK step 后同步、restore 槽位 |
| VM-10 | 临时 BP 冲突与槽位耗尽 / N+L | return address 已有用户 BP；再设置 6 个用户硬件槽位 | 分别调用 Over/Out；验证共享地址；六槽满时重试 | 同址时共享逻辑 BP，不删除用户 BP；槽满返回明确 `NoBreakpointSlot/StepOutNoBreakpointSlot` 或受控单步，绝不盲 run | 失败快速返回；不得 5 s 等待 | breakpoint table、slot、`sharesUserBreakpointId`、cleanup/recovery | Mock + 硬件 | Mock 部分覆盖同址/cleanup；六槽硬件未验证。**部分通过** | slot snapshot、地址归一化、错误码、临时逻辑记录 |
| VM-11 | Native DAP 直接停止 / Native | Native result `ok=true,targetState=Halted,mode=native` | 捕获 DAP 消息；对三种 step 各执行一次 | 每次先 step response，后一个 `stopped(reason=step)`；不读 DAP `readRegister(PC)`/`getTargetState`；只发一次 stopped | response 到 stopped 无固定 100 ms；总延迟记录 | DAP request/response/event 顺序、`native stopped event`、poll=0、PC diagnostics | 自动测试 + 硬件 | 自动测试/Mock 已证明顺序；真实 Native 时序未验证。**部分通过** | result mode、halted 判定、重复事件、`markStoppedForUi` |
| VM-12 | legacy 保守轮询对照 / Legacy | Native 全部开关关闭，或每种 step 开关关闭 | 对 VM-01、VM-02 各执行一次；故意慢停止一次 | response 仍先发送；只有 `getTargetState` 观察到 halted 才 stopped；短轮询超时后由通用 polling 补发 | 保持历史容错；不把 Native `<50 ms` 误用于 legacy | poll 次数/间隔、soft halt、fallback polling、stopped 唯一性 | 自动测试 + 硬件 | 代码检查；历史 legacy 硬件有 profile。**部分通过** | 模式判断、poll timeout、通用 polling 恢复 |
| VM-13 | session 单 owner / Native | Native 任一步开关开启并成功 launch | 同时开 Watch、Timeline、DAP step、plugin 读；统计 DLL open/connect 与 helper PID | 仅 session-owned helper/target channel 接触 J-Link；无第二 helper/koffi owner；队列为 control > watch > timeline | 无持续 `Target busy`；control 可抢占低优先级 | dll open/connect、owner 标签、scheduler snapshot、queue priority | 自动测试 + 硬件 | 代码检查、自动测试；历史硬件为 legacy single owner，非 Native 证据。**部分通过** | session lifecycle、内部 fallback 禁止、scheduler 串行化 |
| VM-14 | helper 失败后的 legacy 单 owner fallback / N+L | launch 时 helper 缺失、握手失败或 Native 开关组合不可用 | 启动会话，执行 Into/Over/Out、Watch、Timeline；检查 owner | 仅在 session 创建 Native owner 前允许 legacy fallback；fallback 后只有一个 legacy owner，三种 step 可用 | 启动/首命令失败快速且可诊断 | helper 错误码、fallback reason、DLL open/connect 数、mode=legacy | 自动测试 + 硬件 | 自动测试/Mock 覆盖 channel fallback 与禁止第二 owner；真实硬件未验证。**部分通过** | helper lifecycle、fallback 条件、owner 释放 |
| VM-15 | 活动 ozone DAP 失败时禁止 extension-host 回退 / 路由 | 已有活动 ozone DAP session；让 `customRequest(dataSample/setWatchValue)` 返回失败/超时 | 通过 Watch、Timeline、MCP/plugin API 读与写各一次 | 返回 DAP 失败给调用者；**不得**调用 extension-host backend、不得读到本地第二 owner 数据；无活动会话时才可本地路由 | 路由失败有界返回，不能悬挂 | RPC 方法、active session、customRequest error、local backend 调用计数/owner | 自动测试 + 硬件故障注入 | 代码检查；路由自动测试应作为发布门槛，尚未本次执行。**未验证** | `RuntimeRouter` active-session 分支、异常捕获、错误转换 |
| VM-16 | Watch、evaluate 与运行态读取 / N+L | `count` 每约 1 ms 变化；target running；step 期间发读 | Watch/evaluate/MCP 连续读取 30 s；在每种 step 中插入读 | running 时值持续更新；step 中立即得到缓存或 `running` 占位；stopped 后刷新为新 PC 对应值 | UI 不等待整个 step；无永久停止 | eval 值/时间、cache、`readCancelEpoch`、Target busy、step 后恢复 | 自动测试 + 硬件 | 历史真实硬件 60 次/30 s legacy 路由通过；Native 未验证。**部分通过** | read barrier、缓存失效、DAP customRequest 路由 |
| VM-17 | MemoryView、Peripheral Viewer、RTOS Views / N+L | 可读 RAM、SVD、可展开 struct/array/pointer、RTOS 任务 | stopped 与 running 边界执行 memory read/write、寄存器/外设读取、evaluate/variables 展开 | `readMemory` base64 正确；`memoryReference` 有效；变量树、RTOS/外设不崩溃且不绕过 owner | 不阻塞 control；失败返回 DAP 错误 | DAP initialize/readMemory/variables、eval、owner、dll | 自动测试 + 硬件 | 代码检查；真实硬件未验证。**未验证** | DAP capability、base64 字节、DWARF、读队列/路由 |
| VM-18 | Timeline 运行与 step 暂停恢复 / N+L | Watch 与 Timeline 同时运行，采样表达式为 `count`,`uwTick` | recording 连续 30 s；期间 Into/Over/Out 各执行；不重启会话 | step 时可丢点但不补造；每次 stopped 后自动恢复；时间戳严格单调，recording ID 持续有效 | 完整压力需各 step 20 次；无永久中断 | sampling start/stop、帧数/间隙/时间戳、queue pause/resume、stopped 后新帧 | 自动测试 + 硬件 | 历史 legacy 有 1058 帧与人工 Timeline 观察，但 20/20/20 未完成；Native 未验证。**部分通过** | timeline pause `finally`、recording lifecycle、scheduler/target read |
| VM-19 | 变量写入 20 次与 MCP/plugin API / N+L | 可验证可写变量 `count`；Timeline/Watch 同时运行 | 通过 Watch 与 MCP/plugin API 交替写 20 次，每次后读；穿插 step | 每次写完成；写前 Timeline 批次先发；写后 cache 失效；读到新值或允许的短暂 `running`；活动会话始终走 DAP | 写有界完成，不能被采样饿死 | setWatchValue、flush、cache invalidation、RPC、采样恢复 | 自动测试 + 硬件 | 历史 legacy 20/20 写通过（2 次短暂 `running`）；Native 未验证。**部分通过** | control lock、write barrier、RuntimeRouter、读缓存 |
| VM-20 | RTT、reset、断连重连 / N+L | 有 RTT control block；可安全 reset；连接参数已记录 | 连续读 RTT；reset；disconnect/reconnect 后重复 VM-01 与 Watch | RTT 不永久阻塞；reset 后状态一致；重连不崩溃、不产生第二 owner，step/读取恢复 | 操作各自有界；不将异常 wait 计作正常性能 | dll connect/disconnect、RTT、state、owner、DAP stopped/terminated | 硬件 | 代码检查；真实硬件未验证。**未验证** | `disconnect` 不 Close、_wasOpened、RTT timeout、session dispose |
| VM-21 | Native helper 异常、超时与 BP 清理 / Native | 注入 helper 退出、RPC malformed、step timeout、cleanup 失败、用户 BP 先命中 | 在 call-over/stepOut 中触发；随后尝试安全断开或重连 | 无伪 stopped；running 时 force halt；temp BP 清理、用户 BP 恢复；cleanup 失败标为 error，禁止继续脏表 | 异常上限：single 200 ms/call 500 ms/复杂 1000 ms；仅异常可更长 | errorCode、state、recovery、cleanupOk、slot、helper exit、owner | Mock + 硬件故障注入 | 代码检查、Mock 错误码检查；真实 helper/硬件未验证。**部分通过** | recovery 顺序、IPC 退出、breakpoint table、session teardown |
| VM-22 | Native 性能与 20 次压力 / Native | 完成 VM-01--VM-10 的专用固件；Watch/Timeline/recording 全程开启 | Into、Over、Out 各连续 20 次；记录每次 PC、source、耗时；不重启 session | 60 次均有一次 response 与一次 stopped；无 Target busy；所有临时 BP 清理；最终采样仍恢复 | 非调用 `<50 ms`；调用 Over/Out `<100 ms`；复杂 `<200 ms`；正常路径 0 次 5 s | 完整 step/dap/eval/dll 日志与 recording 导出 | 真实硬件 | 历史仅 legacy：Over 83 次、Into 17 次、Out 15 次，且未满足新性能门槛；Native 未验证。**未验证** | 分类/轮询、队列饥饿、采样恢复、fixed sleep、DLL/MCU 时序 |
| VM-23 | 配置切换与路径可观测性 / N+L | 分别启用总开关+单项开关，及仅一项关闭 | 每个组合 launch 后执行对应 step 与 Watch | 开启且 executor 可用时 mode=native；单项关闭或不可用时 mode=legacy；不发生跨路径误判 | 启动可诊断；性能按实际 mode 计 | launch config、executor state、step mode、fallback reason | 自动测试 + 硬件 | 代码检查；Mock/自动测试历史报告；硬件组合未验证。**部分通过** | config aliases、executor availability、mode 标记 |

## 性能与硬件压力验收

### 发布门槛

Native 正常路径必须满足下表。超过门槛的样本需要保留完整日志；历史 legacy 样本仅用于回归比较，不能被拿来豁免 Native 门槛。

| 指标 | 门槛 | 测量起止 | 必须附带证据 |
|---|---:|---|---|
| 普通非调用 step | `<50 ms` | helper/native command 开始至已确认 halted 的 result | PC before/after、分类、poll count、无 temp BP |
| 调用 stepOver/stepOut | `<100 ms` | command 开始至 cleanup 完成 | return BP、slot、wait、cleanup、source after |
| 复杂路径 | `<200 ms` | command 开始至 halted result | branch/same-line/递归诊断及实际 PC |
| 正常路径等待 | 禁止 5 秒级等待 | 全部正常样本 | 无 `waitForHalt` 秒级 timeout；异常须显式 error/recovery |
| DAP 顺序 | response 先于 stopped | response/event 时间戳或 trace | 每次仅一个 stopped，Native 无多余 DAP state poll |
| 压力次数 | Into/Over/Out 各 20 次 | 同一 DAP session | 60 条 profile，成功数、失败数、最大/分位耗时 |
| 并发 | Watch + Timeline + 20 次写入 | 同一 recording 和 session | 单 owner、Target busy、写前 flush、读缓存/恢复 |
| Timeline 恢复 | 每次 step 后继续，时间戳单调 | recording 开始至最后 step 后至少一批数据 | recording ID、帧时间戳、最后 stopped 后帧 |

### 执行与记录规则

1. 首先留存启动配置、DLL/板卡版本和 ELF 编译选项；Native 与 legacy 使用同一固件和相同断点位置。
2. 每次 step 记录 `mode`、command ID、Target busy、PC before/after、source before/after、stopped event、临时断点和 cleanup。对 Native 还记录 helper PID 与唯一 owner。
3. 压力运行期间保持 Watch、Timeline、recording 与 MCP/plugin API 可用；进行 20 次变量写入。若 step 中读返回 `running` 占位，记录为允许的短暂降级，不能伪装成已读到真实值。
4. 任何 helper 异常、timeout 或 cleanup 失败立即保存日志并停止继续普通 step；先完成 VM-21 的恢复判定再继续。
5. 历史基线提示 legacy 同行多指令样本约 550--1400 ms，且 DAP 后置约 100 ms；这是重构前对照，不是 Native 通过证据。

## 历史 bug 可追溯

`docs/bug-fix-log.md` 的每条现有记录均映射到至少一个矩阵项。状态指映射场景的当前总体状态，而非重新宣称历史修复已在 Native 硬件中通过。

| 历史 bug | 日志日期 | 矩阵编号 | 必验关键点 | 当前证据等级 / 状态 |
|---|---|---|---|---|
| stepOut 后首次 stepInto/stepOver 视觉上不前进 | 2026-07-12 | VM-05、VM-22 | source hint 不移动真实 PC；下一次源码级 step 必须越过 hint statement | 自动测试、历史真实硬件；**部分通过** |
| stepInto 需多次点击才进入调用函数，stepOut 返回后仍停在调用行 | 2026-07-12 | VM-04、VM-05、VM-11 | 参数准备扫描、进入 BL/BLX、source hint、response-before-stopped | Mock/自动测试、历史真实硬件小样本；**部分通过** |
| sameLineStepping 步数限制不足导致 escape 后跳转到用户断点 | 2026-07-11 | VM-07、VM-08、VM-09、VM-22 | `do-while` 同行超过 10 条指令、回跳与用户 BP 不得走不可达 escape BP | 历史修复记录；Native 硬件未验证。**部分通过** |
| switch-case break 逐过程卡死或跳回 switch 行 | 2026-07-10 | VM-06、VM-22 | `B/B.W` 走实际单步，禁止 `PC+2` 临时 BP 与 5.7 s timeout | 历史 legacy 硬件/基线；Native 未验证。**部分通过** |
| 未命中断点清除时 CPU 被 halt 不恢复 | 2026-07-10 | VM-10、VM-20、VM-21 | running 时清 BP 后恢复运行，异常清理保持状态一致 | 历史日志标为待验证；**未验证** |
| 地址解析错误导致断点写入系统区引发 HardFault | 2026-07-10 | VM-10、VM-17、VM-21 | 地址范围/对齐/Thumb 归一化；非法地址拒绝，不能写系统区 | 代码检查与历史单点地址结果；**部分通过** |
| 循环中逐过程卡死 + 跳转到随机位置 | 2026-07-10 | VM-06、VM-07、VM-09、VM-10、VM-22 | stale BP、`address <= pc`、同行 BL 与当前用户 BP 的清理/恢复 | 历史 legacy 修复记录；Native 未验证。**部分通过** |

## 执行顺序

1. **Mock/自动测试**：运行现有 Native scheduler、session-owner、DAP native executor、commander native stop、runtime-router 及 C++ mock 通道测试；将每项映射到 VM-04、VM-05、VM-09--VM-15、VM-19、VM-21、VM-23。失败即先停止硬件压力。
2. **最小真实硬件冒烟**：填写环境记录，在同一固件上完成 VM-01--VM-07、VM-09--VM-12、VM-16--VM-17、VM-20、VM-23，Native 与 legacy 分开留痕；先确认单 owner 和 DAP 顺序。
3. **完整 20 次并发压力**：不重启 session，执行 VM-18、VM-19、VM-22；保持 Watch、Timeline、recording 和 MCP/plugin API，收集 20 次写入及 Into/Over/Out 各 20 次的完整证据。
4. **发布前回归**：重跑全部自动测试，复测 VM-10、VM-14、VM-15、VM-20、VM-21 的失败/回退路径；确认所有未验证项已明确保留在发布说明，且没有将 Mock 或 legacy 硬件结果标记为 Native 硬件通过。

当前不可宣称为真实硬件通过的重点包括：Native 复杂控制流、六槽耗尽、MemoryView/Peripheral/RTOS 兼容、helper 异常恢复、RTT/reset/reconnect、活动 DAP 请求失败时无 extension-host 回退，以及同一 session 的 Native 20/20/20 并发压力。

## 任务 13 验证续跑（2026-07-12）

### 本轮环境与自动基线

| 字段 | 本轮记录 |
|---|---|
| 日期、工作树版本 | 2026-07-12；`7e705cf`；工作树已脏，本轮未修改功能代码、配置、测试、`dist/` 或 `docs/bug-fix-log.md` |
| Native helper | 已由 `npm run build:native` 重建；Mock 握手报告 helper `0.2.0`，这不是硬件 owner 证据 |
| 自动验证 | `npm run build:native`、`npm run test:cpp-channel:mock`、`npm run typecheck`、`npm run build`、`npm test` 均通过；本次收尾 Vitest 为 9 个文件、43 项 |
| 差异检查 | `git diff --check` 通过；仅报告已有文件的 CRLF/LF 转换警告 |
| 活动 DAP/MCP | plugin API endpoint 文件存在，但 `ozone.status` 的 loopback RPC 连接失败；未发现运行中的 `orbit-jlink-helper` 进程 |
| 真实硬件环境 | 未提供活动 ozone DAP session，因此 MCU、ELF、优化级别、J-Link DLL、接口、速度、launch 开关、session/mode、owner 数、helper PID、`JLINK_Open/JLINK_Connect` 次数均未采集 |
| 本轮日志时间范围 | 无本轮真实硬件日志范围。现有 `dll.log`、`dap.log`、`eval.log`、`step.log` 分别最后写于 19:51:28、19:57:47、19:52:21、19:52:20，早于本轮基线，未被引用为本轮结果 |

未启动 JLink.exe、独立 helper、koffi 或任何第二 owner；未绕过活动 DAP 会话。由于没有活动会话，也未执行变量写入、step、RTT、reset、disconnect/reconnect 或 helper 故障注入。

### VM-13 至 VM-23 本轮状态

| 编号 | 本轮状态 | 本轮证据与缺口 |
|---|---|---|
| VM-13 | 部分通过（维持） | 自动测试与 Mock 基线通过；没有 Native 硬件 session，未验证单 helper owner、优先级与并发读取。 |
| VM-14 | 部分通过（维持） | 自动测试与 Mock 覆盖启动 fallback/显式 Native 初始化错误；未在真实 J-Link 上验证 helper 退出后的 auto fallback。 |
| VM-15 | 部分通过 | `runtime-router` 自动测试已随全量 Vitest 通过；硬件活动 DAP 的受控失败/超时未验证。 |
| VM-16 | 部分通过（维持） | 历史 legacy 数据与自动测试存在；Native 的 30 秒 Watch/evaluate/MCP 读取未验证。 |
| VM-17 | 未验证（维持） | 未执行 Native 或 legacy 的 MemoryView、Peripheral Viewer、RTOS Views 硬件检查。 |
| VM-18 | 部分通过（维持） | 历史 legacy Timeline 数据存在；Native 30 秒 recording 与 step 后恢复未验证。 |
| VM-19 | 部分通过（维持） | 历史 legacy 20 次写入与自动测试存在；Native 活动 DAP 会话下的 20 次交替写入未验证。 |
| VM-20 | 未验证（维持） | 未获测试环境安全确认，且没有活动 session；未执行 RTT、reset、disconnect/reconnect。 |
| VM-21 | 部分通过（维持） | Mock/自动测试基线通过；真实 Native helper 异常、超时和断点清理未注入。 |
| VM-22 | 未验证（维持） | 未执行同一 Native 会话的 Into/Over/Out 各 20 次，未取得 PC/source、response/stopped、耗时与 recording 证据。 |
| VM-23 | 部分通过（维持） | 自动测试覆盖配置选择；没有硬件 session，未验证 legacy/native/auto 与单项 step 开关组合。 |

本轮没有发现可报告的硬件 bug；原因是硬件 DAP 前置条件未满足，不能把未运行的路径判定为通过或失败。

### Native 硬件会话与压力证据（2026-07-12）

| 字段 | 实测记录 |
|---|---|
| MCU、ELF、RTOS | STM32F407VE；`D:\STM32\project\vet6_led\build\Debug\vet6_led.elf`；FreeRTOS |
| owner 与模式 | `target-1` 请求 `mode=auto`，实际 owner 为 Native helper；`dll.log` 在 12:24:17.603/12:24:17.757 分别仅记录一次 `JLINK_Open OK`/`JLINK_Connect OK`，无 `NativeOwnerLost` 或 legacy connect |
| 开关与环境缺口 | 日志未输出 `nativeDebugEngineEnabled` 和三个 step capability 的原始 launch 字段；三种 step 均实际进入 Native 路径，故其有效 capability 为已启用。J-Link DLL 版本、接口/速度、ELF 优化级别未从本会话采集，不能用历史值代替 |
| 日志时间范围 | `dll.log` 12:24:17.547--12:24:17.758；`dap.log` 12:24:15.874--12:25:58.983；`step.log` 12:24:19.128--12:25:57.759；`eval.log` 至少 12:25:50.504--12:25:58.379 |
| Watch/MCP/录波 | 前一 Native 会话中，`count`/`uwTick` plugin recording 1,289 帧、55.955 s、零错误、时间戳严格递增；MCP/plugin 写 `count` 20/20 成功且 20/20 立即经活动 DAP 回读，写入录波 115 帧、零错误、最大间隙 62 ms。当前压力会话的 Watch/evaluate 在 step 后继续记录到 12:25:58.379 |
| 压力 session 边界 | UI 压力发生在 12:24 的新 Native session；先前 recording 不属于该 session，不能作为同 session Timeline 全程连续证据 |

`dap.log` 的 92 个 profile 均有一次 `handleStep` 尝试、一次 response 和一次 `native stopped event`，顺序为 response 在 stopped 前；`Target busy=0`、`NativeOwnerLost=0`、无超 200 ms 样本、无 5 秒级等待。实测计数与人工“20/20/20”声明不一致，验收仅采用日志可复查计数：stepOver 78、stepInto 8、stepOut 6。

| 类型 | 可复查次数/成功 | DAP 最大耗时 | Native command 最大耗时 | 门槛判定 |
|---|---:|---:|---:|---|
| stepOver | 78/78 | 162 ms | 116 ms | 未通过性能门槛：35 个 `branchSingleStep` 中 18 个 DAP 样本 >=50 ms，41 个 `singleStep` 中 21 个 >=50 ms；非调用 DAP 最大 149 ms |
| stepInto | 8/8 | 77 ms | 10 ms | 次数不足 20；性能无 >=100 ms 样本 |
| stepOut | 6/6 | 144 ms | 116 ms | 次数不足 20；profile #85 (`0x08002F82 -> 0x08003B50`) 超过调用/Out `<100 ms` 门槛 |

代表性 PC/source：profile #1 `stepOver 0x08003A34 -> 0x08003A4A`，`branchSingleStep`，DAP 45 ms；profile #84 `stepInto 0x08003B4A -> 0x08002F82`，`callEntered`，进入 `cmsis_os.c:323`；profile #85 `stepOut 0x08002F82 -> 0x08003B50`，`returnBreakpoint`，返回 `freertos.c:195`，DAP 144 ms。所有列出的 Native state-machine 记录均为 `cleanup=true`。

`handleContinue: clear bp result ok=false` 在 12:24:20.092、12:24:56.163、12:25:41.748 出现三次，但每次随后 `run result ok=true`。当前日志未证明用户断点残留或清理失败；它是需要后续复现时重点检查的诊断信号，不将其作为已确认断点清理 bug。

据此更新本轮矩阵结论：VM-13、VM-16、VM-18、VM-19、VM-22 均为**部分通过**；VM-22 仍被实际次数不足和 Native 性能门槛不达标阻塞，不能进入下一发布阶段。VM-14、VM-15、VM-17、VM-20、VM-21、VM-23 的既有状态不变。

### VM-17 Viewer 补验（2026-07-12）

用户确认 VM-17 的 Viewer 修复后已在真实目标重新测试正常。本轮 Native `auto` 会话在 12:41:02.927 launch，12:41:04.665/12:41:04.818 分别记录唯一 helper 的 `JLINK_Open OK`/`JLINK_Connect OK`。`eval.log` 在 12:43:03.692--12:43:13.121 记录了 RTOS 与变量视图的实际读取：

- `uxCurrentNumberOfTasks=3`、`pxReadyTasksLists`（7 项数组）、`pxCurrentTCB=0x20000578`；
- `xDelayedTaskList1`、`xDelayedTaskList2`、`xPendingReadyList`、`xSuspendedTaskList`、`xTasksWaitingTermination` 等 `xLIST` struct 的内存读取与子字段展开；
- `huart1` 16 字段 struct，以及 `count`、`cnt`、`ulTotalRunTime` 的 evaluate。

日志未出现 `NativeOwnerLost` 或 `Target busy`。本次收尾自动回归重新通过：`npm run build:native`、`npm run test:cpp-channel:mock`、`npm run typecheck`、`npm run build`、`npm test`；Vitest 为 9 个文件、43 项。VM-17 为**部分通过**：Native 的 RTOS/变量树及用户确认的 Viewer 行为已验证，但 legacy owner 下的同一组 MemoryView、Peripheral Viewer、RTOS Views 尚未在本轮留存可复查硬件日志。
