# 调试引擎重构总体指导

## 背景

当前项目的逐过程调试延迟高，主要不是 J-Link 硬件慢，而是 TypeScript 层用 J-Link DLL 原语拼出了复杂的 step-over 行为。历史修复不断增加临时断点、源码行映射、分支判断、固定等待和兜底单步，导致正确性和延迟互相拉扯。

本轮重构目标是建立更接近成熟调试器的结构：

```text
VS Code DAP / WebView
        |
TypeScript Extension
        |
Native Debug Engine
        |
C++ J-Link Channel
        |
JLink_x64.dll
        |
Target MCU
```

## 总目标

1. 用明确状态机重写 `step over`、`step into`、`step out`。
2. 用 C++ J-Link 通道减少跨语言调用、固定等待和 JS 层轮询。
3. 用调度器统一 step、断点、变量读取、变量写入、Timeline 采样。
4. 保住并优先保护实时获取变量和修改变量功能。
5. 保留旧路径作为回退，避免重构期间项目失去可调试能力。

## 非目标

- 不引入 OpenOCD/GDB server 作为主调试通道。
- 不直接复制 OpenOCD 源码，避免许可证风险。
- 不把 VS Code 扩展改成 Ozone GUI 或外部 JLink.exe 控制模式。
- 不手改 `dist/` 产物。
- 不为了 step 速度牺牲 Watch、Timeline、MCP/plugin API 的实时变量能力。

## 核心原则

### 1. 正确性先由状态机保证，不靠无限兜底

旧逻辑的问题是分支越来越多，但状态不清晰。新逻辑必须显式描述：

- 当前 target 状态：running、halted、stepping、resuming、waitingTempBreakpoint、error。
- 当前断点状态：用户断点、临时断点、被临时清除的用户断点。
- 当前 step 意图：单指令 step、源码行 step、step over call、step out。
- 当前资源占用：J-Link DLL 是否正在被控制命令或采样命令使用。

每个状态都必须有进入条件、退出条件、超时处理和失败恢复。

### 2. Fast path 必须短

普通逐过程不能默认走复杂路径。

推荐 fast path：

1. Halted 状态读取 PC。
2. 读取当前指令少量字节。
3. 如果不是 call，也不是需要特殊处理的分支，直接执行单指令 step。
4. Native 层确认 halted 和新 PC。
5. 返回 DAP stopped 所需信息。

这个路径不应该设置临时断点，不应该进入 5 秒级等待，不应该触发 Timeline/Watch 长时间暂停。

### 3. 临时断点只用于确定的 resume-until

临时断点适合这些场景：

- `BL/BLX` step over，到 return address。
- step out，到 LR 或函数返回地址。
- 明确可达的 source line address。

临时断点不适合这些场景：

- 不能确认会执行到的 `PC+2`。
- 分支目标未知。
- DWARF line table 只给出“看起来像下一行”的地址，但控制流不可达。

临时断点必须有生命周期：

1. 设置前检查硬件槽位。
2. 如与用户断点冲突，记录原用户断点。
3. run 前确认 PC 不在临时断点地址。
4. 命中、超时、错误、取消时都清理。
5. 清理后恢复被移除的用户断点。

### 4. 固定 sleep 必须被状态检查替代

旧逻辑中的 `20ms`、`50ms`、`100ms` 固定等待会稳定制造延迟。新逻辑应优先使用短轮询和明确状态检查：

- J-Link API 返回后立即检查 `isHalted`、PC、断点命中状态。
- 必要等待使用小间隔短轮询。
- 长超时只用于异常路径，并且必须打日志说明等待原因。

### 5. 实时变量能力是一级需求

Watch、Timeline、MCP/plugin API 的实时读写不能成为 step 重构的牺牲品。

调度器优先级建议：

```text
最高：halt、step、continue、reset、断点修改、写变量
中等：Watch 面板读取、用户主动 evaluate
较低：Timeline 高频采样、批量内存读取
```

step 开始时可以暂停低优先级采样，但不能无限期阻塞。step 结束后必须恢复采样，并递增或通知读取消机制，避免 UI 使用旧数据。

写变量必须高于普通采样，防止用户修改变量被高频采样饿死。

### 6. TypeScript 层逐步变薄

重构完成后，TypeScript 层不应继续承担指令级 step-over 逻辑。

TypeScript 应负责：

- DAP 请求和响应。
- VS Code UI 状态。
- 配置读取。
- 新旧路径选择。
- 错误展示。
- Watch/Timeline webview 通信。

Native 层应负责：

- J-Link DLL 加载和状态管理。
- 指令级 step 状态机。
- 断点槽位管理。
- 寄存器和内存读写。
- 快速变量采样。
- J-Link 操作调度。

## 建议 API 草案

Native Debug Engine 可以先按以下能力划分：

```text
connect(config) -> EngineResult
disconnect() -> EngineResult
halt() -> StopResult
continue() -> RunResult
stepIntoInstruction() -> StepResult
stepOverInstruction() -> StepResult
stepOverSourceLine(policy) -> StepResult
stepOut(policy) -> StepResult
readRegister(name) -> RegisterResult
readRegisters() -> RegisterSetResult
readMemory(address, size) -> MemoryResult
writeMemory(address, bytes) -> EngineResult
setBreakpoint(address, kind) -> BreakpointResult
clearBreakpoint(id) -> EngineResult
prepareFastSample(expressions) -> SamplePlanResult
readFastSample(plan) -> SampleResult
writeVariable(spec, value) -> EngineResult
getState() -> TargetStateResult
```

所有返回值必须包含：

- `ok`
- `errorCode`
- `message`
- `targetState`
- `pc`
- `elapsedMs`
- 必要的诊断字段

## Step 状态机建议

### Step Over Source Line

```text
IdleHalted
  -> ReadPc
  -> DecodeInstruction
  -> ClassifyInstruction
  -> FastSingleStep
  -> ResolveNewLocation
  -> DoneStopped
```

遇到调用指令：

```text
ClassifyInstruction
  -> ComputeReturnAddress
  -> InstallTempBreakpoint
  -> ResumeTarget
  -> WaitTempBreakpointShort
  -> CleanupTempBreakpoint
  -> ResolveNewLocation
  -> DoneStopped
```

遇到分支或复杂源码行：

```text
ClassifyInstruction
  -> BranchPolicy
  -> SingleStepUntilSourceBoundary
  -> DoneStopped
```

异常路径：

```text
AnyState
  -> TimeoutOrError
  -> ForceHaltIfNeeded
  -> CleanupTempBreakpoint
  -> RestoreUserBreakpoints
  -> ReturnDiagnosticError
```

## C++ 通道建议

优先考虑 N-API native addon 或独立 helper 进程。两者取舍：

- N-API addon 延迟低，调用直接，但崩溃会带崩扩展宿主或调试适配器进程。
- 独立 helper 进程崩溃隔离好，协议可控，但有 IPC 开销和生命周期管理成本。

如果首要目标是快速验证性能，可以先做 N-API 原型；如果目标是长期稳定，建议评估 helper 进程。

无论哪种方式，都必须保证：

- J-Link DLL 只在一个受控线程或串行队列中访问。
- 不并发调用会改变 target 状态的 API。
- 崩溃或初始化失败能回退旧 koffi 路径。
- 日志足够定位 DLL 加载、连接、step、断点、采样问题。

## 调度器要求

调度器必须解决一个问题：J-Link 是单目标调试通道，但 VS Code 同时可能有 DAP、Watch、Timeline、MCP/plugin API 请求。

建议队列：

```text
ControlQueue: halt, step, continue, reset, breakpoint, write variable
ReadQueue: watch, evaluate, read registers, read memory
SampleQueue: timeline fast sampling
```

规则：

- ControlQueue 可打断或暂停 SampleQueue。
- 写变量不能排在 Timeline 采样之后长期等待。
- step 期间拒绝或延迟低优先级采样。
- continue 后恢复运行态采样。
- halt 后暂停运行态采样，允许 halted 态 evaluate 和变量展开。

## 迁移策略

### 阶段 1：观测

只加 profiling，不改行为。目标是建立旧路径延迟基线。

### 阶段 2：Native 原型

实现 C++ 通道最小能力，默认关闭。

### 阶段 3：双路径运行

增加配置开关：

```json
{
  "ozone.nativeDebugEngine.enabled": false,
  "ozone.nativeDebugEngine.stepOver": false,
  "ozone.nativeDebugEngine.fastSampling": false
}
```

### 阶段 4：迁移 step

先迁移 `stepOver`，再迁移 `stepInto` 和 `stepOut`。

### 阶段 5：迁移采样

确认 step 稳定后，再考虑把 fast sampling 下沉到 Native 调度器。

### 阶段 6：默认启用

只有当历史 bug 矩阵和实时变量能力都通过验证后，才考虑默认启用 Native 路径。

## 验证要求

必须覆盖：

- 普通语句逐过程。
- 函数调用逐过程。
- 函数指针调用。
- `switch-case break`。
- `do-while`。
- `while/for` 循环回跳。
- 多语句同行。
- 宏展开行。
- 当前 PC 上存在用户断点。
- 临时断点和用户断点同地址。
- Watch 运行态刷新。
- Timeline 高频采样。
- step 期间采样暂停和恢复。
- `setWatchValue` 写变量。
- MemoryView、Peripheral Viewer、RTOS Views 基本兼容。

性能目标建议：

- 普通非调用 step：目标小于 50ms。
- 函数调用 step over：目标小于 100ms，复杂目标小于 200ms。
- 不允许正常路径出现 5 秒级等待。
- Timeline 采样在 step 后自动恢复。

## 日志要求

每次 Native step 至少记录：

- command id
- step kind
- pc before
- instruction halfwords
- classification
- temp breakpoint address
- wait elapsed
- pc after
- source location before/after
- cleanup result
- total elapsed

日志仍按现有分类写入：

- `log.step`：step、断点、临时断点、continue。
- `log.eval`：变量、内存、DWARF。
- `log.dll`：J-Link DLL 加载、连接、设备、速度。
- `log.dap`：DAP 请求、stopped event、轮询。

## 风险清单

- Native 崩溃会影响调试会话。
- J-Link DLL API 同步语义和项目现有假设不完全一致。
- C++ 和 TypeScript 双路径期间行为不一致。
- 硬件断点数量不足。
- DWARF line table 在优化编译下不稳定。
- 高频采样和 step 抢占导致数据点丢失。
- 写变量和采样竞争导致 UI 显示旧值。

每个风险都必须有回退或诊断方案。

## 最重要的约束

实时获取和修改变量是本项目的核心能力。任何 step 重构如果让 Watch、Timeline 或 `setWatchValue` 明显退化，都不能合并为默认路径。

