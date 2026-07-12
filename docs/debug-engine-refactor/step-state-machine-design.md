# Step 调试状态机设计

本文定义后续 Native Debug Engine 中 `stepIntoInstruction`、`stepOverInstruction`、`stepOverSourceLine`、`stepOut`、`resumeUntilBreakpoint` 的状态机。目标是把当前 TypeScript 中散落在 `doStepInto`、`doStepOver`、`doStepOut`、`setTempBpAndRun`、`waitForHalt`、`findNextSourceLineAddress`、`doSingleStep` 里的补丁式分支，收敛为可迁移到 C++ 的显式状态、转移条件和资源生命周期。

本文不设计 OpenOCD/GDB server 替代路径，也不复制 OpenOCD 实现。可借鉴的是目标状态、停止原因、断点资源表、poll/wait 分离和结构化诊断。

## 设计原则

1. 普通非调用指令优先走单指令 step，不设置临时断点，不进入秒级等待。
2. 临时断点只用于可证明会被执行到的 resume-until 地址，例如 `BL/BLX` 的 return address、step-out 的 LR 返回地址、已验证可达的 source boundary。
3. 分支、循环、`switch`、`do-while` 不把 “DWARF 看起来像下一行” 的地址直接当作可达临时断点。
4. 用户断点、临时断点和内部 step 断点进入统一 breakpoint table，冲突处理由状态机负责。
5. 每个状态都有进入条件、成功出口、失败出口、cleanup 规则和结构化诊断。
6. DAP 层只消费 `StepResult`，不重复 step，不用固定 sleep 猜测 step 是否完成。

## 基础模型

### TargetState

```text
Unknown
Halted
Running
Stepping
WaitingForTempBreakpoint
Recovering
Error
```

### StopReason

```text
None
SingleStep
Breakpoint
TemporaryBreakpoint
Watchpoint
UserHalt
Exception
Timeout
CommunicationError
InternalError
```

### StepIntent

```text
StepIntoInstruction
StepOverInstruction
StepOverSourceLine
ResumeUntilBreakpoint
StepOut
```

### StepResult

```ts
interface StepResult {
  ok: boolean;
  errorCode: EngineErrorCode;
  message: string;
  targetState: TargetState;
  stopReason: StopReason;
  phase: StepPhase;
  pcBefore?: number;
  pcAfter?: number;
  instructionHalfwords?: number[];
  instructionClass?: ThumbInstructionClass;
  tempBreakpoint?: TempBreakpointDiagnostic;
  elapsedMs: number;
  pollCount: number;
  recovery?: RecoveryDiagnostic;
}
```

## Thumb 指令分类策略

分类器只读取当前 PC 后足够小的一段指令字节，通常 6 字节即可覆盖当前 32-bit 指令和下一条 16-bit 指令的基本判断。分类结果必须包含 `width`、`fallthroughPc`、`branchTarget`、`returnAddress`、`canUseTempBreakpoint`。

| 分类 | 典型指令 | step-over 策略 |
|---|---|---|
| `NonControl16` / `NonControl32` | 算术、load/store、mov、cmp | `stepOverInstruction` 直接单指令 step |
| `CallImmediate` | Thumb-2 `BL`、immediate `BLX` | 先计算 `returnAddress = pc + 4`，只在地址有效后设置临时断点 |
| `CallRegister` | `BLX Rm` | return address 为下一条指令；目标地址可未知，但 return address 必须可确定 |
| `UnconditionalBranch` | `B`、`B.W` | 单步执行分支，再按新 PC/source location 判定，不给 fallthrough 盲设临时断点 |
| `ConditionalBranch` | `B<cond>`、`CBZ`、`CBNZ` | 单步执行，让 CPU 决定 taken/not taken；source step 继续进入 source-boundary 循环 |
| `TableBranch` | `TBB`、`TBH` | 单步执行，随后根据实际 PC 判断；不预测 switch 目标 |
| `ReturnLike` | `BX LR`、`POP {...,PC}`、`LDR PC,...` | 对 step-over instruction 走单步；step-out 使用 LR/栈解析的 return address 时另走 resume-until |
| `SupervisorOrException` | `SVC`、`BKPT`、异常返回 | 单步或返回异常诊断；不得设置临时断点 |
| `Unknown` | 解码失败或内存读失败 | 降级为单指令 step；若 step 失败进入 recovery |

`BL/BLX` 的重要规则：

- `BL` / immediate `BLX` 只有在当前半字确认为 32-bit call 且 `pc + 4` 在可执行代码范围内时，才允许安装 return-address 临时断点。
- `BLX Rm` 的 step-over 目标不是 `Rm` 指向的函数入口，而是 fallthrough return address。只有 return address 可确定且合法时才安装临时断点。
- 如果当前 PC 上存在用户断点，先进入 `HandleCurrentBreakpoint`，单步越过或临时清除后再执行 call-over，避免启动即重新命中同一断点。

## 状态图：stepIntoInstruction

`stepIntoInstruction` 是最小控制原语。它不做源码行判断，不 step-over 调用，不设置临时断点。

```text
IdleHalted
  -> AcquireControl
  -> SyncHaltedState
  -> ReadPc
  -> HandleCurrentBreakpoint
  -> ExecuteSingleStep
  -> WaitHaltShort
  -> ResolveStopInfo
  -> RestoreUserBreakpoints
  -> DoneStopped

AnyState
  -> TimeoutOrError
  -> RecoverAndCleanup
  -> ReturnDiagnosticError
```

转移规则：

- `IdleHalted -> AcquireControl`：ControlQueue 获得独占 J-Link 控制权，暂停 Timeline/SampleQueue。
- `SyncHaltedState -> ReadPc`：poll 确认 target halted；若无法确认，先 `halt()`，再短轮询。
- `HandleCurrentBreakpoint`：如果 PC 等于用户断点地址，记录该断点，临时清除，执行一次 step 后恢复；不得永久删除。
- `ExecuteSingleStep`：调用 J-Link step 原语。
- `WaitHaltShort`：短轮询确认 halted，正常路径不超过 50 ms 目标值；超时进入 recovery。
- `DoneStopped`：返回 `StopReason.SingleStep`，包含 `pcBefore/pcAfter`。

## 状态图：stepOverInstruction

`stepOverInstruction` 是指令级 step-over，不关心源码行。非调用指令走 fast path；调用指令使用 return-address 临时断点。

```text
IdleHalted
  -> AcquireControl
  -> SyncHaltedState
  -> ReadPc
  -> DecodeThumbInstruction
  -> ClassifyInstruction
    -> FastSingleStep
    -> ComputeReturnAddress
    -> BranchSingleStep
    -> UnknownSingleStep
  -> ResolveStopInfo
  -> DoneStopped
```

调用路径：

```text
ClassifyInstruction(CallImmediate | CallRegister)
  -> ComputeReturnAddress
  -> ValidateResumeAddress
  -> InstallTempBreakpoint
  -> ResumeTarget
  -> WaitTempBreakpoint
  -> ClassifyStopReason
  -> CleanupTempBreakpoint
  -> RestoreUserBreakpoints
  -> DoneStopped
```

分支路径：

```text
ClassifyInstruction(Branch | TableBranch | ReturnLike)
  -> ExecuteSingleStep
  -> WaitHaltShort
  -> ResolveStopInfo
  -> DoneStopped
```

关键规则：

- `NonControl*`、条件分支、无条件分支、table branch、return-like 指令都优先单步。
- 只有 `CallImmediate` / `CallRegister` 能进入临时断点路径。
- `ComputeReturnAddress` 失败、地址非法、硬件断点槽不足时，不退化为盲 resume；应返回明确错误或降级为单步策略，由调用方知道行为已降级。
- 若命中的是用户断点而非临时断点，返回 `StopReason.Breakpoint`，并清理临时断点。

## 状态图：stepOverSourceLine

`stepOverSourceLine` 是源码级策略，建立在 `stepOverInstruction` 和 `resumeUntilBreakpoint` 上。它的目标是离开当前源码语句/源码行，同时不进入函数调用内部。

```text
IdleHalted
  -> AcquireControl
  -> SyncHaltedState
  -> ReadPc
  -> ResolveStartLocation
  -> DecodeThumbInstruction
  -> ClassifyInstruction
  -> SelectSourceStepPolicy
    -> InstructionFastPath
    -> CallOverReturnAddress
    -> BranchAwareSingleStepLoop
    -> SourceBoundaryResume
  -> ResolveFinalLocation
  -> DoneStopped
```

### InstructionFastPath

适用条件：

- 当前指令为普通非控制流指令。
- 当前源码行没有已知的多指令同一行风险，或 `maxSameLineInstructionSteps` 未耗尽。

动作：

```text
stepOverInstruction
  -> 如果 new location 离开 start location：DoneStopped
  -> 如果仍在同一行：继续 SourceLineLoop
```

### CallOverReturnAddress

适用条件：

- 当前指令为 `BL/BLX`，或同一源码行多步过程中遇到 `BL/BLX`。
- return address 已确定且合法。

动作：

```text
ComputeReturnAddress
  -> InstallTempBreakpoint(returnAddress)
  -> ResumeTarget
  -> WaitTempBreakpoint
  -> Cleanup
  -> 如果停止在当前行之后或其他文件：DoneStopped
  -> 如果仍在当前行：回到 SourceLineLoop
```

### BranchAwareSingleStepLoop

适用条件：

- 当前指令是 `B`、`B.W`、条件分支、`CBZ/CBNZ`、`TBB/TBH`。
- 当前场景可能是 `switch-case break`、循环尾、`do-while` 条件、`for/while` 回跳。

动作：

```text
ExecuteSingleStep
  -> WaitHaltShort
  -> ResolveActualPcLocation
  -> 如果到达更大行号：DoneStopped
  -> 如果回跳到同文件更小行号：按 loop policy DoneStopped 或继续有限步
  -> 如果仍在同一行：继续有限 SourceLineLoop
  -> 如果 PC 重复或步数耗尽：ReturnDiagnosticError 或受控 halt，不设置不可达 temp BP
```

规则：

- `switch-case break` 编译为无条件分支时，必须单步执行分支，再使用实际 PC 判断，不在 `PC+2` 安装临时断点。
- `do-while` 条件和循环尾回跳时，允许停止在循环头或下一条实际执行语句；不得为了逃离当前行给 line table 的下一行盲设断点。
- `for/while` 回跳遇到用户断点时，返回 `StopReason.Breakpoint`，不能伪装成 step 完成。

### SourceBoundaryResume

只在满足以下全部条件时允许使用：

- line table 给出的目标地址经过控制流验证：目标地址是当前基本块 fallthrough，或由解码出的分支目标可达，或由 call return address 可达。
- 目标地址在可执行代码范围内。
- 当前 PC 不等于目标地址。
- 与用户断点冲突已登记处理。

如果任何条件不满足，必须回到 `BranchAwareSingleStepLoop` 或返回诊断，不允许盲设临时断点。

## 状态图：resumeUntilBreakpoint

`resumeUntilBreakpoint` 是受控 resume 原语，供 call-over、step-out、已验证 source boundary 使用。

```text
IdleHalted
  -> AcquireControl
  -> SyncHaltedState
  -> ValidateResumeAddress
  -> AllocateBreakpointSlot
  -> ResolveBreakpointConflict
  -> InstallTempBreakpoint
  -> HandleCurrentBreakpoint
  -> ResumeTarget
  -> WaitForStop
  -> ClassifyStopReason
  -> CleanupTempBreakpoint
  -> RestoreUserBreakpoints
  -> DoneStopped
```

异常路径：

```text
AnyState
  -> TimeoutOrError
  -> PollState
  -> ForceHaltIfRunning
  -> CleanupTempBreakpoint
  -> RestoreUserBreakpoints
  -> ReturnDiagnosticError
```

停止分类：

- PC 等于临时断点地址：`StopReason.TemporaryBreakpoint`，step 成功。
- PC 等于用户断点地址：`StopReason.Breakpoint`，用户断点优先，step 被用户断点中断。
- Watchpoint/exception/hardfault：返回对应 reason，清理临时断点。
- Timeout 后 target 已 halted：返回 `Timeout`，附带实际 PC 和可能停止原因。
- Timeout 后 target 仍 running：请求 halt，等待短 recovery timeout，随后清理并返回诊断。

## 临时断点生命周期规则

### BreakpointTable

每个断点条目包含：

```text
id
address
slotIndex
kind: User | Temporary | InternalStep
ownerCommandId
enabled
replacedUserBreakpointId?
installedAtPhase
```

### 安装规则

1. 安装前验证地址范围、对齐、Thumb bit 归一化和可执行区间。
2. 检查硬件槽位；槽位不足返回 `NoBreakpointSlot`，不得静默 resume。
3. 如果同地址已有用户断点：
   - 不重复安装硬件断点。
   - 创建临时逻辑断点，记录 `sharesUserBreakpointId`。
   - 命中时同时报告 “临时目标已到达” 和 “该地址存在用户断点”，DAP 层可优先显示 step 完成，但诊断保留冲突信息。
4. 如果当前 PC 等于临时断点地址，不允许直接 resume；应先单步离开或返回 `CurrentPcAtTempBreakpoint`。
5. 如果当前 PC 上有用户断点，进入 `HandleCurrentBreakpoint`，临时清除、单步、恢复，再继续 resume。

### 清理规则

所有出口都必须执行：

1. 如果安装了独立临时硬件断点，清除对应槽位。
2. 如果临时断点共享用户断点，不清除用户断点，只删除临时逻辑记录。
3. 恢复因当前 PC 冲突而临时清除的用户断点。
4. 如果清理失败，`StepResult.ok` 可以反映主操作成功，但 `recovery.cleanupOk=false` 必须进入诊断，并禁止继续使用脏 breakpoint table。
5. 清理完成后恢复被暂停的 SampleQueue，并递增 read epoch，防止 UI 使用旧采样数据。

## 用户断点冲突处理

| 场景 | 处理 |
|---|---|
| 当前 PC 正在用户断点上执行 step | 临时清除该断点，单步越过，恢复断点，再执行后续策略 |
| 临时断点地址已有用户断点 | 共享硬件断点，记录逻辑临时断点，不删除用户断点 |
| resume 途中先命中其他用户断点 | 清理临时断点，返回 `StopReason.Breakpoint`，不强行继续到临时断点 |
| 清理临时断点时 CPU 被 halt | 如果进入前是 running，清理后按状态机决定是否恢复；step/resume-until 场景通常保持 halted 并发 stopped |
| 用户删除断点与 step 并发 | ControlQueue 持锁期间延迟断点修改；不得并发调用 J-Link breakpoint API |

## 超时和异常恢复规则

### 正常超时目标

| 操作 | 正常目标 | 异常上限 |
|---|---:|---:|
| 非调用单指令 step | < 50 ms | 200 ms |
| call step-over return BP | < 100 ms | 500 ms |
| 复杂源码行 step-over | < 200 ms | 1000 ms |
| recovery halt | 不在正常路径 | 500 ms |

秒级等待只允许出现在异常诊断路径，不能作为普通 step-over 的完成机制。

### Recovery 顺序

1. `PollState`：读取 target state、PC、stop reason。
2. 如果 running，执行 `halt()`，进入短轮询。
3. 如果 halted，读取 PC 和停止原因。
4. 清理临时断点和内部逻辑记录。
5. 恢复用户断点。
6. 标记 engine state：
   - 清理成功：`Halted`，允许后续命令。
   - 清理失败或 breakpoint table 不一致：`Error`，要求用户重新连接或重置会话。
7. 返回结构化错误，不自动重试 step。

## 场景策略

### 普通语句

普通算术、赋值、寄存器/内存访问指令：

- `stepOverInstruction` 直接单步。
- `stepOverSourceLine` 多次调用 fast path，直到离开当前源码行或达到有限步数。
- 不设置临时断点。

### 函数调用

`BL/BLX`：

- 先确定 return address。
- return address 合法后安装临时断点。
- resume 后只等待临时断点、用户断点、watchpoint、exception 或 timeout。
- timeout 不继续盲跑，必须 halt + cleanup。

### switch / break

`break;` 常见为无条件分支：

- 对 `B/B.W` 单步执行。
- 根据实际 PC/source location 判断是否离开当前 case。
- 不在 `PC+2` 或 line table 下一地址设置临时断点。

### do-while

循环尾条件通常包含比较和条件/无条件回跳：

- 条件判断和回跳走 `BranchAwareSingleStepLoop`。
- 如果实际 PC 回到循环体或外层循环头，按实际执行流停止或继续有限步。
- 不使用 “下一源码行地址” 逃逸，除非控制流验证该地址可达。

### for / while

- 循环体内部普通语句走 fast path。
- 循环尾回跳走分支单步。
- 命中循环头用户断点时返回用户断点停止，不把它覆盖为 step 成功。

### 多语句同一行 / 宏展开行

- 使用有限 `SourceLineLoop`。
- 每次循环都重新解码实际 PC。
- 遇到 call 按 call-over，遇到 branch 按 branch-aware。
- 步数耗尽时返回 `SourceLineStepLimitExceeded` 诊断，不设置不可达 escape BP。

## 验收用例

1. 普通非调用指令逐过程：一次点击完成，日志显示 `FastSingleStep`，无 temp BP，目标 < 50 ms。
2. `BL` 逐过程：日志显示 `CallImmediate -> ComputeReturnAddress -> InstallTempBreakpoint`，return address 为 `pc+4`，命中后清理 temp BP。
3. `BLX Rm` 逐过程：不依赖函数入口是否可解析，只使用 fallthrough return address。
4. `switch-case break`：当前指令为 `B/B.W` 时单步分支，不在 `PC+2` 设置 temp BP，无 5 秒级等待。
5. `do-while` 尾部：条件和回跳按实际 PC 单步推进，不跳到不可达下一行 temp BP。
6. `for/while` 回跳：遇到循环头用户断点时返回 `StopReason.Breakpoint`，不继续盲跑。
7. 多语句同一行包含调用：同行普通指令单步，遇到调用才设置 return-address temp BP。
8. 当前 PC 有用户断点：step 前临时清除并记录，step 后恢复，用户断点仍存在。
9. 临时断点地址与用户断点同址：共享硬件断点，step 完成后用户断点仍存在且未被误删。
10. 硬件断点槽不足：返回 `NoBreakpointSlot` 或降级单步诊断，不 resume 到未知状态。
11. 临时断点 timeout：执行 halt、cleanup、restore，返回实际 PC 和 `Timeout`，无残留 temp BP。
12. DAP 层不重复 step：Native 返回结构化失败时，DAP 发出错误/停止事件，不再次执行 step。

## 日志要求

每次 step 命令至少记录：

- command id
- step intent
- phase transitions
- pc before / after
- instruction halfwords
- instruction class
- selected policy
- temp breakpoint address、slot、冲突用户断点 id
- wait elapsed、poll count
- stop reason
- cleanup result
- total elapsed

这些日志继续写入 `log.step`；J-Link DLL open/connect/device/speed 写入 `log.dll`；DAP request/stopped event 写入 `log.dap`。
