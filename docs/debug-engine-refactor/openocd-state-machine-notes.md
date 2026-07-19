# OpenOCD 状态机参考笔记

本文用于给 Orbit 后续“逐过程状态机”设计提供参考。OpenOCD 是 GPL 项目，本文只整理架构、状态转移、事件语义和可借鉴的设计取舍，不复制源码，不把 OpenOCD 源码改写成本项目实现。

## 参考来源

- OpenOCD `target.h` Doxygen：`enum target_state` 定义了 `TARGET_UNKNOWN`、`TARGET_RUNNING`、`TARGET_HALTED`、`TARGET_RESET`、`TARGET_DEBUG_RUNNING`，见 https://openocd.org/doc-release/doxygen/target_8h.html。
- OpenOCD `target.c` Doxygen：`target_poll`、`target_resume`、`target_step`、`target_wait_state`、`target_add_breakpoint`、`target_remove_breakpoint`、`target_add_watchpoint`、`target_remove_watchpoint` 等目标层入口，见 https://openocd.org/doc-release/doxygen/target_8c_source.html。
- OpenOCD `gdb_server.c` Doxygen：GDB remote `continue/step`、breakpoint/watchpoint、停止状态通知相关处理，见 https://openocd.org/doc/doxygen/html/gdb__server_8c_source.html。
- OpenOCD 用户手册 General Commands：说明 `halt` 会先发 halt 请求，`wait_halt` 只等待进入 halted/debug mode，默认等待 5 秒，见 https://openocd.org/doc/html/General-Commands.html。
- OpenOCD 用户手册 GDB and OpenOCD：说明 OpenOCD 作为 GDB remote gdbserver 与 GDB 协作，见 https://openocd.org/doc/html/GDB-and-OpenOCD.html。
- GDB Remote Serial Protocol 官方文档：停止回复包、`c`/`s` 运行控制、`Z`/`z` 断点 watchpoint 包语义，见 https://sourceware.org/gdb/current/onlinedocs/gdb.html/Remote-Protocol.html。

## OpenOCD target 状态模型

OpenOCD 的 target 状态是目标层的事实来源，不是前端 UI 状态。核心状态可抽象为：

| 状态 | 含义 | 对本项目的启发 |
|---|---|---|
| `UNKNOWN` | 尚未确认或通信失败后的未知状态 | 需要显式区分“没查到”和“确认为 running/halted”，避免默认当作 halted |
| `RUNNING` | 目标正在执行用户程序 | 运行态下只允许安全的运行态读；需要事件或轮询发现 halt |
| `HALTED` | 目标已进入 debug/halt 状态 | 寄存器、栈、变量、断点修改的主要安全状态 |
| `RESET` | 目标处于 reset 相关状态 | reset 不是普通 running/halted，应有单独恢复路径 |
| `DEBUG_RUNNING` | 调试器让目标执行内部算法等特殊运行 | 对 Ozone 可抽象为“调试器占用目标执行内部流程”，避免与用户 continue 混淆 |

更重要的是，OpenOCD 同时维护停止原因。`target.h` 里有 breakpoint、watchpoint、single-step、debug request、exception catch 等 debug reason 枚举。状态回答“现在是否停住”，停止原因回答“为什么停住”。后续 NativeDebugEngine 不应只返回 `halted`，还应返回 `StopReason`、PC、命中的断点/watchpoint、是否由用户 halt 或 step 触发。

## Polling 思路

OpenOCD 的轮询不是简单 sleep，而是“定期刷新 target 层状态并触发事件”。抽象流程：

```text
Timer 或 GDB/命令路径触发 poll
  -> target_poll(target)
  -> adapter/architecture 层读取目标 halt/running 状态
  -> 更新 target.state 和 debug_reason
  -> 状态变化时触发 target event callbacks
  -> GDB server/命令层据此发送 stopped 或继续等待
```

可借鉴点：

- `poll` 是状态同步动作，不是业务动作。它只负责把硬件事实同步到 target model。
- 轮询结果会驱动事件，而不是每个调用点自己猜测是否该发 stopped。
- resume/step 出错后，OpenOCD 的 GDB 路径也会再次 poll，目的是让内部状态尽量与目标一致。
- `halt` 和 `wait_halt` 分离：前者请求目标停住，后者等待状态变为 halted。这个分离比“发 halt 后固定 sleep”更可控。

对 Ozone 的建议：

- Native 层提供 `pollState()` 或在 `waitForHalt()` 内部做短间隔状态刷新，返回 `targetState + stopReason + pc + pollCount + elapsedMs`。
- DAP 层不应再用固定 `100ms + 200 * 10ms` 自行确认 step 完成；它应消费 Native 返回的最终状态，必要时只做运行态后台 polling。
- Watch/Timeline 读请求不能隐式改变目标状态；若触发 poll，也应标注为只同步状态。

## Resume / Continue 思路

OpenOCD 的 `target_resume(target, current, address, handle_breakpoints, debug_execution)` 可抽象为：

```text
Require target halted or recover state
  -> 处理当前 PC 断点问题
  -> 恢复/写回必要寄存器和上下文
  -> 调用 architecture/adapter resume
  -> 标记 target 进入 running 或 debug-running
  -> 后续由 poll 发现停住原因
```

这里最值得借鉴的是 `handle_breakpoints` 这个概念：继续运行时，如果 PC 正在断点地址，必须有明确策略处理当前断点，否则会立刻再次命中。策略可以是临时清掉当前断点、单步越过、恢复断点、再 resume。OpenOCD 把这个作为 resume 的显式参数/语义，而不是散落在调用方。

对 Ozone 的建议：

- `continue(options)` 明确包含 `ignoreCurrentBreakpoint` 或 `handleCurrentBreakpoint` 策略。
- 当前 PC 用户断点的“清除、单步、恢复、继续”应属于 Native 控制状态机，DAP 只接收 `continued`/`stopped` 事件。
- resume 成功只表示目标进入运行态，不表示最终停在哪里；最终 stop 由 poll/wait 产生。

## Step 思路

OpenOCD 的 `target_step(target, current, address, handle_breakpoints)` 是目标层单步入口。其抽象重点：

```text
Require halted
  -> 处理当前断点
  -> 设置 step 地址或使用当前 PC
  -> 执行 architecture/adapter 单步
  -> 等待/同步 halted
  -> 设置 debug_reason = single-step
  -> 触发 halted/stopped 事件
```

OpenOCD 并不把“源代码逐过程”作为 target 层的唯一语义。GDB 的 `next` 往往由 GDB 自己基于符号、临时断点和单步策略实现；OpenOCD 作为 remote server/target 层更关注硬件单步、继续、断点和停止原因。

对 Ozone 的建议：

- Native 层至少区分 instruction step 与 source step。instruction step 是基础原语；source step over 是在 instruction step、临时断点、符号 line table 上建立的策略。
- 非 call 指令走短 fast path：读 PC、读少量指令、单步、确认 halted、返回。
- call/return/source-boundary 这类需要 resume-until 的路径才使用临时断点。
- step 的返回值必须包含 step phase、instruction class、pcBefore/pcAfter、stopReason、临时断点清理结果。

## Breakpoint / Watchpoint 思路

OpenOCD 把断点和 watchpoint 作为 target 层资源管理，GDB server 只把 remote `Z`/`z` 包翻译成对应的 add/remove 操作。可抽象为：

```text
Frontend/GDB 请求设置断点或 watchpoint
  -> target 层记录逻辑断点/watchpoint
  -> architecture 层选择硬件/软件实现
  -> resume/step 时处理当前 PC 与断点冲突
  -> poll/halt 时根据 debug reason 报告命中类型
```

可借鉴点：

- 断点是受限资源，尤其 Cortex-M 硬件断点槽位有限。设置失败需要明确错误，而不是静默降级。
- 用户断点、临时断点、内部 step 断点必须有不同 kind 和生命周期。
- 临时断点必须在命中、超时、取消、错误恢复路径都清理。
- watchpoint 的停止原因要与 breakpoint 分开，否则 UI 和后续策略无法判断是执行断点还是数据访问命中。

对 Ozone 的建议：

- 建立统一 breakpoint table：`User`、`Temporary`、`InternalStep`，记录硬件 slot、地址、来源、是否替换了同地址用户断点。
- 临时断点只用于确定可达地址：BL/BLX return address、step out return address、明确 source boundary。
- 不要把“看起来像下一行”的 DWARF 地址直接当作一定可达的临时断点地址。

## GDB remote 事件流

OpenOCD 的 GDB server 面向 remote protocol。抽象事件流：

```text
GDB 发送 c/s/vCont/Z/z
  -> gdb_server 解析 packet
  -> target 层 continue/step/breakpoint/watchpoint
  -> 返回命令接收结果
  -> target running 期间由 poll 发现停止
  -> gdb_server 根据 target.state/debug_reason 发送 stopped reply
```

与 VS Code DAP 的映射：

| GDB remote 概念 | DAP 概念 | Ozone 应保持的边界 |
|---|---|---|
| `c`/`s` packet | `continue` / `next` / `stepIn` / `stepOut` request | request response 只确认命令被接受或完成到定义点 |
| stopped reply | `stopped` event | 停止事件必须由 target state + stop reason 驱动 |
| `Z`/`z` | `setBreakpoints` | DAP 负责源码行映射，Native 负责地址断点资源 |
| stop reason | `stopped.reason` | step/breakpoint/watchpoint/pause/exception 不应混为一种 |

对 Ozone 来说，DAP 的 step request 可以等 Native step 完整结束后再响应，也可以先响应再发 stopped；但两者都必须有清晰协议。当前代码“后端 step 返回后，DAP 再 sleep 和 poll”会造成职责重复。

## 可借鉴与不可直接搬用

可借鉴：

- target state 与 stop reason 分离。
- `halt` 请求和 `wait_halt` 等待分离。
- resume/step 入口显式处理当前 PC 断点。
- breakpoint/watchpoint 由目标层统一管理，前端只做协议映射。
- poll 作为状态同步和事件触发机制，而不是业务逻辑的固定延迟。
- 所有控制命令返回结构化诊断：状态、原因、PC、耗时、错误码。

不能直接搬：

- 任何 OpenOCD C 源码、函数体、宏、数据结构布局、注释文本的大段复制。
- OpenOCD 的 GPL 实现细节，例如具体链表结构、命令注册表、target type vtable 布局、GDB packet parser 实现。
- OpenOCD 面向多架构、多 adapter、多命令解释器的通用框架。本项目是 Windows-only VS Code extension + J-Link DLL，应该保留更窄、更直接的接口。
- 通过引入 OpenOCD/GDB server 作为主调试通道来替代 J-Link DLL。总体指导已明确这是非目标。

## 与本项目当前实现的差异

### `src/ozone-backend/commander.ts` `doStepOver`

当前 `doStepOver` 在 TypeScript 层读取 PC、读内存解码少量 Thumb 指令、判断 BL/BLX/branch，并在部分 call 场景调用 `setTempBpAndRun`。这说明 step-over 状态机已经散落在 TS 层。

差异：

- OpenOCD target 层把 step/resume 当作底层控制原语，前端协议层不承担硬件时序；本项目 TS 同时承担 DAP、指令分类、临时断点、等待 halt。
- 当前对 BL/BLX 使用 return address 临时断点是合理方向，但缺少统一 phase 和生命周期模型。
- 当前分支和源码行策略混在单个函数里，容易形成越来越多例外分支。

建议模仿：

- 把 `ReadPc -> DecodeInstruction -> ClassifyInstruction -> FastSingleStep/InstallTempBreakpoint -> WaitHalt -> Cleanup -> DoneStopped` 显式建模。
- 非 call 快速路径不设置临时断点，不进入长等待。
- step 结果返回 `instructionClass`、`pcBefore`、`pcAfter`、`stopReason`、`elapsedMs`。

### `setTempBpAndRun`

当前 `setTempBpAndRun` 是临时断点 resume-until 的核心，但从调用关系看，它被多个 step 路径复用，生命周期和错误恢复依赖调用者理解。

差异：

- OpenOCD 的思想是 breakpoint/watchpoint 属于 target 层资源，resume/step 负责当前断点冲突策略；本项目临时断点更像过程局部工具，没有完整资源表。
- 临时断点与用户断点同地址、硬件槽位不足、超时未命中、清理失败等情况需要结构化诊断。

建议模仿：

- 临时断点进入统一 breakpoint table，kind 为 `Temporary` 或 `InternalStep`。
- 安装前检查槽位和同地址用户断点，必要时记录 `replacedUserBreakpointId`。
- 所有出口都执行 cleanup，并返回 cleanup 结果。

### `waitForHalt`

当前 `waitForHalt` 是等待目标 halt 的底层辅助。总体方向与 OpenOCD `wait_halt`/`target_wait_state` 类似，但需要避免成为固定 sleep 的包装。

差异：

- OpenOCD 的等待语义是等待状态达到目标值，并通过 poll 刷新 target state；本项目还需要确保每次轮询都更新本地 `TargetState` 和 PC/stopReason。
- 当前 DAP 层在后端 step 返回后还额外等待和 poll，说明 `waitForHalt` 的完成语义没有传到 DAP。

建议模仿：

- `waitForHalt` 返回 `StopInfo`，而不是只返回布尔或字符串。
- 记录 `pollCount`、`elapsedMs`、最后 PC、最后 state、timeout reason。
- timeout 是异常路径；正常 step-over 不应出现秒级等待。

### `src/debug/dap-session.ts` `handleStep`

当前 `handleStep` 使用 `withStepLock`、`beginControl`、`stopPolling` 是正确的调度方向；但它会重试后端 step，成功后先发 DAP response，再固定等待 100ms，随后最多 200 次每 10ms 查询 `getTargetState`，超过 50 次还会发 `halt`。

差异：

- OpenOCD/GDB server 的 stopped 事件由 target state/debug reason 驱动；本项目 DAP 层在 step 完成后仍自行制造等待和 halt recovery。
- DAP 层不知道后端 step 的 phase，也不知道临时断点是否命中、是否已清理，只能靠轮询 `halted`。
- 失败重试可能重复执行 step，风险高：第一次 step 可能已经改变 PC，但返回错误或状态没同步，第二次会从新 PC 再 step。

建议模仿：

- DAP `handleStep` 只负责：加锁、暂停低优先级采样、调用 `backend.step*`、根据结构化结果发 response/stopped event、恢复调度。
- 不在 DAP 层做盲目三次 step 重试；如果 Native 返回 `Busy` 可重试，若返回 `Timeout`/`TargetCommunicationFailed` 应进入明确 recovery。
- stopped event 的 `reason` 来自 Native `StopReason.Step/Breakpoint/Watchpoint/Exception`，而不是固定写 `step`。

## 给下一步逐过程状态机设计的输入

建议把后续 Native step-over 状态机定义为：

```text
IdleHalted
  -> ReadPc
  -> DecodeInstruction
  -> ClassifyInstruction
  -> FastSingleStep
  -> WaitHalt
  -> ResolveStopInfo
  -> DoneStopped
```

call / step-out / resume-until 路径：

```text
IdleHalted
  -> ReadPc
  -> DecodeInstruction
  -> ComputeResumeAddress
  -> InstallTempBreakpoint
  -> ResumeTarget
  -> WaitHalt
  -> ClassifyStopReason
  -> CleanupTempBreakpoint
  -> RestoreUserBreakpoints
  -> DoneStopped
```

统一异常路径：

```text
AnyState
  -> TimeoutOrError
  -> PollState
  -> ForceHaltIfNeeded
  -> CleanupTempBreakpoint
  -> RestoreUserBreakpoints
  -> ReturnDiagnosticError
```

Native API 需要至少返回：

```ts
interface StepResult {
  ok: boolean;
  errorCode: EngineErrorCode;
  message: string;
  targetState: NativeTargetState;
  stopReason: StopReason;
  pcBefore?: number;
  pcAfter?: number;
  instructionClass?: InstructionClass;
  phase: StepPhase;
  elapsedMs: number;
  pollCount?: number;
  tempBreakpoint?: BreakpointInfo;
  diagnostics?: EngineDiagnostics;
}
```

验收关注点：

- 普通非 call step-over 走 fast path，目标小于 50ms。
- call step-over 使用明确 return address 临时断点，目标小于 100-200ms。
- 当前 PC 用户断点、临时断点同地址、硬件槽位不足、临时断点未命中都有明确诊断。
- DAP 层不再重复 step，不再用固定长 sleep 判断完成。
- Watch/Timeline 在 step 期间可暂停或取消低优先级读，step 结束后恢复，并递增 stale read/cancel epoch。
