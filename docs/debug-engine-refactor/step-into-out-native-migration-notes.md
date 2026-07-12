# Step-into / Step-out Native 迁移说明

## 迁移范围

任务 09 将 `stepIntoInstruction` 和 `stepOut` 加入任务 08 的 C++ J-Link helper。三种 step 现在通过同一个 `CppJLinkHelperClient`、`NativeScheduler` control queue 和 Timeline 暂停区执行。TypeScript 只负责选择 Native/legacy 路径、为 step-out 提供当前函数范围和断点槽快照、记录诊断，并把结果交给 DAP。

旧的 `doStepIntoLegacy`、`doStepOutLegacy` 和 `doStepOverLegacy` 均保留。Native 总开关、对应 step 开关或 session-owned executor 任一不可用时，Commander 使用旧路径。

## Native 接口

### `stepIntoInstruction`

无参数。状态流为：

```text
EnsureHalted -> ReadPc -> JLINK_Step -> WaitHaltedShort
             -> ForceHaltOnTimeout -> ReadPcAfter -> Halted/Error
```

该路径不会同步、清除或恢复任何用户断点，也不调用 TypeScript 的 `cleanupStepBreakpoints` 或 `clearCurrentBpAndTrack`。如果 J-Link 无法在当前用户断点上执行单步，返回 `StepIntoInstructionFailed` 并强制保持 halted，而不是修改用户断点集合。

### `stepOut`

请求：

```json
{
  "functionStart": 134217984,
  "functionEnd": 134218112,
  "waitTimeoutMs": 1000,
  "breakpoints": { "0": 134218000 }
}
```

状态流为：

```text
EnsureHalted -> ReadPcLrSp -> ValidateFunctionAndReturnState
             -> ClearCurrentUserBreakpoint? -> InstallOrReuseReturnBreakpoint
             -> Resume -> WaitHaltedShort -> ReadPcAfter
             -> CleanupTempBreakpoint -> RestoreUserBreakpoint -> Halted/Error
```

Native 层把 `(LR & ~1)` 作为 return breakpoint 地址。执行前必须满足：

- TypeScript 从 ELF symbols 解析到非空函数范围，且 PC 位于范围内；
- LR 不是 Cortex-M exception-return token，Thumb bit 已设置；
- return address 位于当前函数范围外且至少可读取两个字节；
- SP 非零并按 4 字节对齐。

当前不猜测保存于栈中的 LR。非叶函数中若 LR 已被内部 `BL/BLX` 覆盖并指回当前函数，返回 `StepOutLrInsideFunction`；异常帧返回 `StepOutExceptionFrameUnsupported`；缺少符号范围、寄存器读取失败、SP 无效或返回地址不可读也都有独立错误码。这样会拒绝一部分尚无 unwind 信息的场景，但不会向不可信地址放行 CPU。后续可用 DWARF CFI 或受验证的 Cortex-M frame unwinder 扩展该策略。

若运行途中先命中已有用户断点，结果仍成功且 `classification=userBreakpoint`，DAP 会在实际 halted 后发送 stopped。超时路径先强制 halt，再执行同一个 cleanup；清理或恢复失败返回 `StepCleanupFailed`。

## TypeScript 统一封装

`NativeStepExecutor` 统一暴露：

```text
stepIntoInstruction()
stepOverSourceLine(request)
stepOut(request)
```

`ExperimentalCppJLinkChannel.callNativeStep` 统一检查 Native owner、提交 control request、处理 scheduler cancellation 和 channel fallback。Commander 的 `executeNativeStep` 统一记录 `pcBefore/pcAfter`、classification、分段耗时和 cleanup 状态，并要求成功结果的 `targetState` 必须为 `Halted`。

三种 step 都会暂停 Timeline queue；control request 完成或失败后由 `finally` 语义恢复。Watch、evaluate、变量写入和 DAP 数据格式未改变。DAP 自身仍用 `withStepLock`、`beginControl/endControl` 防止 legacy backend 并发访问；Native helper 内部 RPC 串行执行 J-Link 操作。

## 配置与回退

设置项默认均为 `false`：

```json
{
  "ozone.nativeDebugEngine.enabled": false,
  "ozone.nativeDebugEngine.stepInto": false,
  "ozone.nativeDebugEngine.stepOver": false,
  "ozone.nativeDebugEngine.stepOut": false
}
```

DAP launch 对应字段为 `nativeDebugEngineEnabled`、`nativeDebugEngineStepInto`、`nativeDebugEngineStepOver` 和 `nativeDebugEngineStepOut`。只要启用了任一种 Native step，session 就连接唯一的 Native executor；每种命令仍按自己的开关独立回退。

## DAP 时序

Native RPC 返回时已经完成停止确认和断点清理。`handleStep` 的顺序为：

```text
backend step success -> DAP response -> getTargetState == halted
                     -> markStoppedForUi -> DAP stopped event
```

移除了成功后的固定 100 ms 等待，首次 target-state 检查立即执行；未 halted 时才进入 10 ms 短轮询。response 始终先于 stopped event。Native 返回失败时不发送伪 stopped event，也不会把 target 标记为 running。

## 诊断与耗时

两种新结果都包含 `pcBefore`、`pcAfter`、`classification`、`cleanupOk` 和：

```text
timings.haltMs/readPcMs/decodeMs/executeMs/waitMs/cleanupMs/totalMs
```

step-out 额外返回 `lr`、`sp` 和 `returnAddress`。Commander 的既有 `profileStepCommand` 会记录 Native 分段结果和 TypeScript 总耗时，便于和 legacy 路径对照。

## 测试报告

### 测试信息

| 项目 | 内容 |
|---|---|
| 日期 | 2026-07-12 |
| 平台 | Windows / PowerShell |
| Native 编译器 | MinGW GCC 8.1.0，C++17 |
| Native 目标 | `out/native/win32-x64/ozone-jlink-helper.exe` |
| J-Link 测试通道 | `native/jlink-helper/test/mock-jlink.cpp` 生成的 mock `JLink_x64.dll` |
| 测试性质 | 构建、静态类型检查、单元测试和 mock DLL 集成测试；不等同于真实目标板测试 |

### 命令结果

| 命令 | 结果 | 关键输出 |
|---|---|---|
| `npm run build:native` | 通过 | helper 与 mock DLL 均完成编译和链接 |
| `npm run typecheck` | 通过 | `tsc --noEmit` 无错误 |
| `npm run build` | 通过 | `extension`、`debugadapter`、`webview`、`timeline`、`watch` 5 个 bundle 完成 |
| `npm test` | 通过 | 4 个测试文件、14 个测试全部通过 |
| `npm run test:cpp-channel:mock` | 通过 | Native helper 握手、连接及三种 step RPC 均成功 |

### 功能用例

| 用例 | 操作 | 预期结果 | 实际结果 |
|---|---|---|---|
| Native step-into 基本路径 | 在 mock PC `0x08000104` 执行 `stepIntoInstruction` | 执行一条指令并停在 `0x08000106` | 通过 |
| step-into 用户断点保护 | 当前 PC 存在用户断点时执行 step-into，再尝试占用原槽 | 原用户断点槽仍被占用，不触发清理逻辑 | 通过 |
| Native step-out 基本路径 | PC 位于 `0x08000100..0x08000200`，LR 为 `0x08000201` | 规范化 return address 为 `0x08000200`，运行并停止 | 通过 |
| step-out 临时断点清理 | step-out 使用 return breakpoint | 完成后临时断点槽释放 | 通过 |
| step-out 用户断点恢复 | 当前 PC 的用户断点被临时清除 | 完成后恢复至原硬件槽 | 通过 |
| step-over 回归 | 继续执行任务 08 的 `stepOverSourceLine` mock 用例 | 当前 PC 断点恢复且 `cleanupOk=true` | 通过 |
| 调度器回归 | 执行 `native-scheduler.test.ts` | control/watch/timeline 优先级、暂停和取消行为不退化 | 6 项通过 |
| Native channel 回归 | 执行 `cpp-jlink-channel.test.ts` | helper 不可用时回退；session 禁止 fallback 时不创建第二个 koffi owner | 3 项通过 |

### DAP 时序

自动测试 `sends the step response before the stopped event once native reports halted` 使用 Native 成功结果和 `getTargetState=halted`，捕获 DAP 消息顺序。测试结果为：

```text
backend step success
  -> response(stepIn, success=true)
  -> stopped(reason=step, threadId=1)
```

本次测试日志中 response 在 step 开始后约 2 ms 发出，stopped event 在约 3 ms 发出，首次状态检查即确认 halted。该数字来自 mock 环境，仅用于证明没有固定 100 ms 等待以及事件顺序正确，不代表真实 J-Link 延迟。

### 失败处理检查

代码和类型检查确认 Native step-out 对以下状态返回独立错误，不安装不可信的 return breakpoint：

| 错误码 | 条件 |
|---|---|
| `StepOutFunctionRangeInvalid` | 函数范围为空或反向 |
| `StepOutPcOutsideFunction` | PC 不属于 TypeScript 提供的当前函数范围 |
| `StepOutRegisterReadFailed` | PC、LR 或 SP 读取失败 |
| `StepOutExceptionFrameUnsupported` | LR 是 Cortex-M exception-return token |
| `StepOutInvalidLr` | LR 没有 Thumb bit |
| `StepOutLrInsideFunction` | LR 指向当前函数内部，需要 saved-LR unwind |
| `StepOutInvalidStack` | SP 为零或未按 4 字节对齐 |
| `StepOutReturnUnreadable` | return address 无法读取 |
| `StepOutNoBreakpointSlot` | 无可用硬件断点槽 |
| `StepOutTimeout` | 超时后强制 halt，未到达 return breakpoint |
| `StepCleanupFailed` | 临时断点清理或用户断点恢复失败 |

### 未覆盖项

以下项目需要连接真实目标板后执行，当前报告不声明通过：

- 叶函数 step-out 的真实 LR 和停止位置；
- 非叶函数 LR 已被覆盖时是否稳定返回 `StepOutLrInsideFunction`；
- 中断处理函数、HardFault 等 exception-return 上下文；
- 六个硬件断点槽全部占用以及途中先命中用户断点；
- step 前后 Watch 变量读取、变量修改和 Timeline 10 ms 采样恢复；
- 不同 J-Link DLL 版本在当前 PC 有硬件断点时执行 `JLINK_Step` 的行为和耗时；
- DAP `stepIn`、`next`、`stepOut` 在 VS Code UI 中各执行至少一轮并核对 stopped reason、源码位置和调用栈。
