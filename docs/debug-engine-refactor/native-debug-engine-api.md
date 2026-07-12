# Native Debug Engine API 草案

## 目标

本文定义未来 Native Debug Engine 的 TypeScript/DAP 层与 C++ J-Link 层职责边界。目标不是立即替换现有 `OzoneBackend`，而是为后续双路径迁移提供稳定协议：

```text
VS Code DAP / Watch / Timeline / MCP
        |
TypeScript Extension and Debug Adapter
        |
NativeDebugEngine API
        |
C++ J-Link Channel
        |
JLink_x64.dll
        |
Target MCU
```

Native 层承载 J-Link 串行调度、step 状态机、断点槽位管理、寄存器/内存读写和快速变量采样。TypeScript 层保留 DAP 协议、VS Code UI、WebView 通信、配置、符号/DWARF 高层数据和新旧路径选择。

## 设计原则

- J-Link DLL 只能被一个受控线程或串行队列访问。
- 所有命令返回统一结构，调用方必须检查 `ok` 后再读 `data`。
- `stepOverSourceLine`、`stepIntoSourceLine`、`stepOut` 的指令级状态机下沉到 C++，TypeScript 不再拼临时断点、同源码行循环单步和固定 sleep。
- Watch、Timeline、MCP/plugin API 的实时读写路径保留：WebView/外部 API 仍通过 active DAP session 路由，DAP 再调用 Native API。
- 写变量优先级高于普通采样，不能被 Timeline 高频采样饿死。
- Native 路径必须可配置关闭，旧 koffi/TypeScript 路径保留为回退。

## TypeScript 与 C++ 职责边界

### TypeScript 保留

- DAP 请求/响应/event：`initialize`、`continue`、`next`、`stepIn`、`stepOut`、`readMemory`、`variables`、`evaluate`、custom request。
- VS Code 配置读取和开关：例如 `ozone.nativeDebugEngine.enabled`、`stepOver`、`fastSampling`。
- Debug session 生命周期、WebView 生命周期、Watch/Timeline 面板消息。
- active DAP session 路由：Watch/Timeline 在有 `ozone` debug session 时继续使用 `session.customRequest(...)`。
- DAP 兼容转换：base64 memory payload、`variablesReference`、`memoryReference`、stopped/continued event。
- ELF/DWARF 高层解析和缓存的初始阶段：源码路径、行号映射、类型树、变量表达式解析可以先留在 TypeScript；Native API 接受解析后的地址/类型 spec。
- 错误展示、诊断日志汇总、旧路径 fallback。

### C++ NativeDebugEngine 下沉

- J-Link DLL 加载、连接、断开、设备/接口/速度状态。
- J-Link API 串行调度和抢占规则。
- target 状态机：running、halted、stepping、resuming、waitingTempBreakpoint、error。
- 指令级 step 状态机：指令读取、Thumb/ARM 分类、call/branch/return 判断、临时断点生命周期、短轮询确认 halt。
- 硬件断点槽位管理：用户断点、临时断点、同地址冲突、当前 PC 用户断点临时清除和恢复。
- 寄存器读写、内存读写。
- 快速采样：基于已解析地址和类型的批量读取、数值转换、采样暂停/恢复。
- 写变量底层路径：按地址和类型写入，或者通过 TypeScript 解析表达式后传入 write spec。

## 统一返回结构

所有 Native API 返回 `EngineResult<T>`：

```ts
interface EngineResult<T = unknown> {
  ok: boolean;
  data?: T;
  errorCode: EngineErrorCode;
  message: string;
  targetState: NativeTargetState;
  pc?: number;
  elapsedMs: number;
  commandId: number;
  diagnostics?: EngineDiagnostics;
}

interface EngineDiagnostics {
  jlinkError?: string;
  stepPhase?: StepPhase;
  waitElapsedMs?: number;
  pollCount?: number;
  tempBreakpointId?: number;
  tempBreakpointAddress?: number;
  restoredBreakpointIds?: number[];
  sourceBefore?: SourceLocation;
  sourceAfter?: SourceLocation;
  instructionHalfwords?: number[];
  instructionClass?: InstructionClass;
}
```

约束：

- `ok === false` 时 `data` 不可靠，TypeScript 只能读取 `errorCode`、`message`、`targetState`、`diagnostics`。
- `targetState` 必须反映命令结束时 Native 观察到的状态。
- step 类命令成功时必须返回 `pc` 和停止原因。
- 内存/寄存器/采样命令失败时不能改变 target 状态，除非 `diagnostics` 明确说明执行了恢复性 halt。

## 状态枚举

```ts
enum NativeTargetState {
  Disconnected = "disconnected",
  Connected = "connected",
  Running = "running",
  Halted = "halted",
  Stepping = "stepping",
  Resuming = "resuming",
  WaitingTempBreakpoint = "waitingTempBreakpoint",
  Sampling = "sampling",
  Error = "error",
}

enum StopReason {
  Step = "step",
  Breakpoint = "breakpoint",
  Watchpoint = "watchpoint",
  HaltRequested = "haltRequested",
  Reset = "reset",
  Exception = "exception",
  Timeout = "timeout",
  Unknown = "unknown",
}

enum StepKind {
  InstructionInto = "instructionInto",
  InstructionOver = "instructionOver",
  SourceInto = "sourceInto",
  SourceOver = "sourceOver",
  SourceOut = "sourceOut",
}

enum StepPhase {
  IdleHalted = "idleHalted",
  ReadPc = "readPc",
  DecodeInstruction = "decodeInstruction",
  ClassifyInstruction = "classifyInstruction",
  FastSingleStep = "fastSingleStep",
  ComputeResumeAddress = "computeResumeAddress",
  InstallTempBreakpoint = "installTempBreakpoint",
  ResumeTarget = "resumeTarget",
  WaitHalt = "waitHalt",
  CleanupTempBreakpoint = "cleanupTempBreakpoint",
  RestoreUserBreakpoints = "restoreUserBreakpoints",
  ResolveNewLocation = "resolveNewLocation",
  DoneStopped = "doneStopped",
  ErrorRecovery = "errorRecovery",
}

enum InstructionClass {
  Normal = "normal",
  DirectCall = "directCall",
  IndirectCall = "indirectCall",
  ConditionalBranch = "conditionalBranch",
  UnconditionalBranch = "unconditionalBranch",
  Return = "return",
  SupervisorCall = "supervisorCall",
  Unknown = "unknown",
}
```

## 错误码

```ts
enum EngineErrorCode {
  Ok = "ok",
  NotConnected = "notConnected",
  AlreadyRunning = "alreadyRunning",
  NotHalted = "notHalted",
  Busy = "busy",
  Cancelled = "cancelled",
  Timeout = "timeout",
  JLinkLoadFailed = "jlinkLoadFailed",
  JLinkOpenFailed = "jlinkOpenFailed",
  JLinkCommandFailed = "jlinkCommandFailed",
  TargetCommunicationFailed = "targetCommunicationFailed",
  InvalidArgument = "invalidArgument",
  InvalidAddress = "invalidAddress",
  MemoryReadFailed = "memoryReadFailed",
  MemoryWriteFailed = "memoryWriteFailed",
  RegisterReadFailed = "registerReadFailed",
  RegisterWriteFailed = "registerWriteFailed",
  BreakpointNoSlot = "breakpointNoSlot",
  BreakpointConflict = "breakpointConflict",
  BreakpointNotFound = "breakpointNotFound",
  TempBreakpointMissed = "tempBreakpointMissed",
  StepDecodeFailed = "stepDecodeFailed",
  StepPolicyUnsupported = "stepPolicyUnsupported",
  SymbolInfoRequired = "symbolInfoRequired",
  SamplePlanInvalid = "samplePlanInvalid",
  ExpressionNotWritable = "expressionNotWritable",
  InternalError = "internalError",
}
```

## API 总览

```ts
interface NativeDebugEngine {
  connect(config: NativeConnectConfig): Promise<EngineResult<ConnectInfo>>;
  disconnect(): Promise<EngineResult<void>>;
  getState(): Promise<EngineResult<TargetStateInfo>>;

  halt(options?: HaltOptions): Promise<EngineResult<StopInfo>>;
  continue(options?: ContinueOptions): Promise<EngineResult<RunInfo>>;
  reset(options?: ResetOptions): Promise<EngineResult<StopInfo>>;

  stepIntoInstruction(options?: StepOptions): Promise<EngineResult<StepInfo>>;
  stepOverInstruction(options?: StepOptions): Promise<EngineResult<StepInfo>>;
  stepIntoSourceLine(policy: SourceStepPolicy): Promise<EngineResult<StepInfo>>;
  stepOverSourceLine(policy: SourceStepPolicy): Promise<EngineResult<StepInfo>>;
  stepOut(policy: StepOutPolicy): Promise<EngineResult<StepInfo>>;

  setBreakpoint(request: BreakpointRequest): Promise<EngineResult<BreakpointInfo>>;
  clearBreakpoint(id: number): Promise<EngineResult<void>>;
  clearAllBreakpoints(scope?: BreakpointScope): Promise<EngineResult<void>>;
  listBreakpoints(): Promise<EngineResult<BreakpointInfo[]>>;

  readRegister(name: string): Promise<EngineResult<RegisterInfo>>;
  writeRegister(name: string, value: number): Promise<EngineResult<void>>;
  readRegisters(group?: RegisterGroup): Promise<EngineResult<RegisterInfo[]>>;

  readMemory(request: MemoryReadRequest): Promise<EngineResult<MemoryReadResult>>;
  writeMemory(request: MemoryWriteRequest): Promise<EngineResult<MemoryWriteResult>>;

  prepareFastSample(request: FastSamplePrepareRequest): Promise<EngineResult<FastSamplePlan>>;
  readFastSample(planId: number): Promise<EngineResult<FastSampleResult>>;
  stopFastSample(planId: number): Promise<EngineResult<void>>;

  writeVariable(request: VariableWriteRequest): Promise<EngineResult<VariableWriteResult>>;
}
```

基础类型：

```ts
interface ConnectInfo {
  device: string;
  interface: "SWD" | "JTAG";
  speedKHz: number;
  dllVersion?: string;
}

interface HaltOptions {
  timeoutMs?: number;
  reason?: "user" | "control" | "recovery";
}

interface ContinueOptions {
  ignoreCurrentBreakpoint?: boolean;
  timeoutMs?: number;
}

interface ResetOptions {
  haltAfterReset: boolean;
  timeoutMs?: number;
}

interface StepOptions {
  timeoutMs?: number;
}

interface StopInfo {
  reason: StopReason;
  pc: number;
}

interface RunInfo {
  running: boolean;
  pcBefore?: number;
}
```

## 连接与状态

```ts
interface NativeConnectConfig {
  device: string;
  interface: "SWD" | "JTAG";
  speedKHz: number;
  jlinkDllPath?: string;
  serialNumber?: string;
  resetOnConnect?: boolean;
}

interface TargetStateInfo {
  state: NativeTargetState;
  pc?: number;
  halted: boolean;
  connected: boolean;
  activeCommand?: string;
}
```

TypeScript 仍负责从 VS Code 设置和 launch config 解析配置。Native 只接收已归一化配置。

## Step API

```ts
interface SourceLocation {
  file?: string;
  line?: number;
  column?: number;
  address: number;
}

interface SourceStepPolicy {
  currentLocation?: SourceLocation;
  lineEntries?: SourceLocation[];
  maxInstructionSteps: number;
  timeoutMs: number;
  allowTempBreakpoint: boolean;
  stopOnSourceBoundary: boolean;
  stopOnFunctionEntry?: boolean;
}

interface StepOutPolicy {
  returnAddress?: number;
  framePointer?: number;
  stackPointer?: number;
  timeoutMs: number;
  allowLrFallback: boolean;
}

interface StepInfo {
  kind: StepKind;
  reason: StopReason;
  pcBefore: number;
  pcAfter: number;
  sourceBefore?: SourceLocation;
  sourceAfter?: SourceLocation;
  instructionClass: InstructionClass;
  tempBreakpoint?: BreakpointInfo;
  elapsedMs: number;
}
```

边界要求：

- TypeScript 可以传入 line table、当前源码位置和最大步数策略，但不能再执行指令级 step-over 状态机。
- Native 负责判断当前指令是否是 call、branch、return，并决定单步、临时断点或短循环单步。
- 普通非 call 指令走 fast path：读 PC、读少量指令、单指令 step、确认 halt、返回。
- 临时断点只用于明确可达地址，如 call return address、step out return address、明确 source boundary。
- 命中、超时、取消、错误都必须清理临时断点并恢复被移除的用户断点。
- 正常路径不能出现 5 秒级等待；长超时只用于异常恢复，并返回 `Timeout` 或 `TempBreakpointMissed`。

## 断点 API

```ts
enum BreakpointKind {
  User = "user",
  Temporary = "temporary",
  InternalStep = "internalStep",
}

enum BreakpointScope {
  User = "user",
  Temporary = "temporary",
  All = "all",
}

interface BreakpointRequest {
  address: number;
  kind: BreakpointKind;
  condition?: string;
  source?: SourceLocation;
}

interface BreakpointInfo {
  id: number;
  address: number;
  kind: BreakpointKind;
  enabled: boolean;
  hardwareSlot?: number;
  source?: SourceLocation;
  replacedUserBreakpointId?: number;
}
```

Native 管理硬件槽位和同地址冲突。TypeScript 的源码断点仍先解析为地址，再调用 Native `setBreakpoint`。DAP 返回的 verified/line 信息仍由 TypeScript 组装。

## 寄存器 API

```ts
interface RegisterInfo {
  name: string;
  value: number;
  hex: string;
  bits?: number;
  group?: string;
}

type RegisterGroup = "core" | "float" | "system" | "all";
```

`readRegisters("core")` 至少覆盖 R0-R15、xPSR、MSP、PSP、LR、PC。DAP 变量树和 RTOS Views 的展示格式仍由 TypeScript 生成。

## 内存 API

```ts
interface MemoryReadRequest {
  address: number;
  size: number;
  allowPartial?: boolean;
}

interface MemoryReadResult {
  address: number;
  bytes: number[];
  unreadableBytes: number;
}

interface MemoryWriteRequest {
  address: number;
  bytes: number[];
  verify?: boolean;
}

interface MemoryWriteResult {
  address: number;
  bytesWritten: number;
  verified?: boolean;
}
```

DAP `readMemory` 继续由 TypeScript 转成 base64。Native 只返回 byte array。`writeMemory` 也是 byte-oriented，不接受 `uint32[]` 语义，避免破坏 DAP MemoryView 兼容性。

## 变量读写与 Watch

```ts
interface VariableAddressSpec {
  expression: string;
  address: number;
  size: number;
  typeName?: string;
  encoding: "u8" | "i8" | "u16" | "i16" | "u32" | "i32" | "u64" | "i64" | "float32" | "float64";
  endian?: "little" | "big";
}

interface VariableWriteRequest extends VariableAddressSpec {
  value: number;
  verify?: boolean;
}

interface VariableWriteResult {
  expression: string;
  address: number;
  display: string;
  value: number;
  verified?: boolean;
}
```

当前 `setWatchValue` 路径必须保留：

```text
Watch WebView
  -> active ozone session customRequest("setWatchValue")
  -> DAP session
  -> NativeDebugEngine.writeVariable(...)
```

迁移初期，TypeScript 继续负责表达式解析、类型解析、地址解析和 children 展开。Native 只负责按 `VariableAddressSpec` 进行确定地址写入。后续如果 C++ 增加 DWARF 能力，可以扩展 `writeVariableByExpression`，但不作为第一阶段要求。

## 快速采样 API

```ts
interface FastSamplePrepareRequest {
  expressions: VariableAddressSpec[];
  intervalMs: number;
  maxPointsPerVariable: number;
}

interface FastSamplePlan {
  planId: number;
  items: FastSamplePlanItem[];
}

interface FastSamplePlanItem {
  expression: string;
  spec?: VariableAddressSpec;
  errorCode?: EngineErrorCode;
  message?: string;
}

interface FastSampleResult {
  planId: number;
  timestamp: number;
  values: FastSampleValue[];
}

interface FastSampleValue {
  expression: string;
  value: number;
  display: string;
  errorCode?: EngineErrorCode;
  message?: string;
}
```

现有 Timeline 路径必须保留：

```text
Timeline WebView / DataSamplingManager
  -> active ozone session customRequest("dataSamplingStart")
  -> DAP prepares specs
  -> NativeDebugEngine.prepareFastSample(...)
  -> DAP sample loop or Native scheduler readFastSample(...)
  -> custom event "ozoneDataSamples"
```

规则：

- step/control 开始时 Native 调度器可暂停低优先级采样。
- step/control 结束后必须恢复采样，并让 TypeScript 的 read cancel epoch 或等价机制失效旧读。
- 采样失败单点返回 error，不应停止整个 plan，除非 plan 已失效。
- `writeVariable` 优先级高于 `readFastSample`。

## 调度与线程约束

Native 内部使用单 J-Link worker：

```text
ControlQueue: halt, continue, reset, step, breakpoint, writeVariable, writeMemory
ReadQueue: readRegister, readRegisters, readMemory, evaluate-resolved-variable
SampleQueue: readFastSample
```

优先级：

1. ControlQueue
2. 高优先级 ReadQueue：Watch 当前值、用户主动 evaluate、DAP variables/registers
3. 低优先级 ReadQueue：MemoryView 大块读取
4. SampleQueue：Timeline 高频采样

约束：

- 同一时刻只能有一个 J-Link 调用序列访问 DLL。
- ControlQueue 进入时取消或延迟 SampleQueue。
- ReadQueue 不能插入正在执行的 step 状态机。
- `halt` 可以请求抢占采样，但不能在 Native 内部并发调用 J-Link。
- 如果队列忙，返回 `Busy` 或按调用方指定 timeout 等待；不能无限排队。

## DAP 映射

| DAP/Custom 请求 | TypeScript 行为 | Native API |
|---|---|---|
| `continue` | 发送 response/event，启动 polling | `continue()` |
| `next` | 选择 native/legacy 路径 | `stepOverSourceLine(policy)` |
| `stepIn` | 选择 native/legacy 路径 | `stepIntoSourceLine(policy)` |
| `stepOut` | 选择 native/legacy 路径 | `stepOut(policy)` |
| `pause` | 停止 running UI 状态 | `halt()` |
| `setBreakpoints` | file/line 解析为地址，组装 DAP response | `setBreakpoint(...)` / `clearBreakpoint(...)` |
| `variables` registers | 组装 DAP variable tree | `readRegisters()` |
| `variables` locals/watch | TS 解析表达式和 children | `readMemory(...)` 或 prepared variable read |
| `readMemory` | base64 编解码和 DAP error 格式 | `readMemory(...)` |
| `writeMemory` | base64 解码 | `writeMemory(...)` |
| `evaluate` | DAP 展示、children handle | TS 解析后调用 memory/register read |
| `dataSample` | 保留实时 Watch 读取 custom request | `readFastSample(...)` 或 resolved reads |
| `dataSamplingStart` | 解析表达式，创建 plan | `prepareFastSample(...)` |
| `setWatchValue` | 保留 custom request 路由 | `writeVariable(...)` |

## 兼容与迁移

建议开关：

```json
{
  "ozone.nativeDebugEngine.enabled": false,
  "ozone.nativeDebugEngine.stepOver": false,
  "ozone.nativeDebugEngine.stepInto": false,
  "ozone.nativeDebugEngine.stepOut": false,
  "ozone.nativeDebugEngine.fastSampling": false,
  "ozone.nativeDebugEngine.memory": false
}
```

迁移顺序：

1. Native connect/state/register/memory 原型，默认关闭。
2. `stepOverSourceLine` 双路径接入，失败回退 legacy。
3. `stepIntoSourceLine` 和 `stepOut` 接入。
4. 断点管理迁移到 Native 槽位管理。
5. fast sampling 接入 Native 调度器。
6. 写变量和采样竞争验证通过后，再考虑默认启用。

## 日志要求

Native 每个命令至少输出：

- `commandId`
- command name
- queue wait time
- target state before/after
- pc before/after
- elapsedMs
- errorCode/message

Native step 额外输出：

- step kind
- instruction halfwords
- instruction class
- temp breakpoint address/id
- wait elapsed and poll count
- cleanup result
- source location before/after

TypeScript 继续按现有分类写入 `log.step`、`log.eval`、`log.dll`、`log.dap`。Native 可把结构化日志返回给 TypeScript 写入现有日志文件，避免新增一套用户不可见日志。

## 验收覆盖

该 API 覆盖以下能力：

- Step：`stepIntoInstruction`、`stepOverInstruction`、`stepIntoSourceLine`、`stepOverSourceLine`、`stepOut`。
- 断点：`setBreakpoint`、`clearBreakpoint`、`clearAllBreakpoints`、`listBreakpoints`。
- 寄存器：`readRegister`、`writeRegister`、`readRegisters`。
- 内存：`readMemory`、`writeMemory`。
- 变量读写：prepared variable read、`writeVariable`，保留 `setWatchValue` 路由。
- 快速采样：`prepareFastSample`、`readFastSample`、`stopFastSample`，保留 Watch/Timeline 实时路径。

最关键的边界是：TypeScript 不再负责指令级 step-over 状态机，但仍负责 DAP/WebView/API 路由和表达式/源码层语义；C++ 负责所有 J-Link 临界区内的时序、状态和恢复。
