export type DebugProbe = 'jlink' | 'cmsis-dap';
export type CmsisDapTransport = 'auto' | 'hid' | 'winusb';

export interface DebugProbeLaunchConfig {
  probe?: DebugProbe;
  cmsisDapTransport?: CmsisDapTransport;
  cmsisDapSerial?: string;
  cmsisDapVid?: string;
  cmsisDapPid?: string;
  cmsisDapFlashAlgorithmPath?: string;
  flashBeforeDebug?: boolean;
}

export interface DebugSessionConfig extends DebugProbeLaunchConfig {
  device: string;
  interface: 'SWD' | 'JTAG';
  speedKHz: number;
  jdebugScript?: string;
  rtos?: string;
  nativeDebugEngineMode?: 'legacy' | 'native' | 'auto';
  nativeDebugEngineEnabled?: boolean;
}

export enum TargetState {
  Connected = 'connected',
  Running = 'running',
  Halted = 'halted',
  Disconnected = 'disconnected',
  Error = 'error',
}

export interface RegisterValue {
  name: string;
  value: number;
  hex: string;
}

export interface Variable {
  name: string;
  type: string;
  value: string;
  address?: number;
  children?: Variable[];
}

export interface StackFrame {
  id: number;
  level: number;
  function: string;
  file: string;
  line: number;
  address: number;
}

export interface WatchValue {
  expression: string;
  evaluateName?: string;
  value: number;
  display: string;
  hex: string;
  address?: number;
  error?: string;
  typeName?: string;
  hasChildren?: boolean;
  children?: WatchValue[];
}

export interface DataPoint {
  timestamp: number;
  value: number;
  display: string;
  startsNewSegment?: boolean;
}

export interface DataSamplingEntry {
  expression: string;
  enabled: boolean;
  color: string;
}

export interface DataSampleSnapshot {
  expression: string;
  color: string;
  currentValue: string;
  data: DataPoint[];
}

export interface FastDataSampleSpec {
  expression: string;
  address: number;
  size: number;
  pointerAddress?: number;
  pointeeOffset?: number;
  typeName?: string;
  isFloat?: boolean;
  signed?: boolean;
}

export interface FastDataSamplePlanItem {
  expression: string;
  spec?: FastDataSampleSpec;
  error?: string;
}

export interface Breakpoint {
  id: number;
  file: string;
  line: number;
  enabled: boolean;
  type: 'hardware' | 'software' | 'conditional' | 'log';
  condition?: string;
  hitCount: number;
}

export interface MemoryBlock {
  address: number;
  data: number[];
  ascii: string;
  unreadableBytes?: number;
}

export interface DebugContext {
  pc: number;
  registers: RegisterValue[];
  locals: Variable[];
  callStack: StackFrame[];
  sourceFile?: string;
  sourceLine?: number;
  disassembly?: string;
}

export interface AIResult {
  text: string;
  suggestions?: string[];
  confidence?: number;
}

export type OzoneCommand =
  | { cmd: 'connect'; config: DebugSessionConfig }
  | { cmd: 'disconnect' }
  | { cmd: 'halt' }
  | { cmd: 'run' }
  | { cmd: 'stepInto' }
  | { cmd: 'stepIntoInstruction' }
  | { cmd: 'stepOver' }
  | { cmd: 'stepOut' }
  | { cmd: 'reset' }
  | { cmd: 'setBreakpoint'; file: string; line: number; type?: string; condition?: string }
  | { cmd: 'clearBreakpoint'; id: number }
  | { cmd: 'clearAllBreakpoints' }
  | { cmd: 'getRegisters' }
  | { cmd: 'getVariable'; name: string; frame?: number }
  | { cmd: 'getLocals'; frame?: number }
  | { cmd: 'getCallStack' }
  | { cmd: 'readMemory'; address: number; size: number }
  | { cmd: 'writeMemory'; address: number; data: number[] }
  | { cmd: 'readRegister'; name: string }
  | { cmd: 'getTargetState' }
  | {
    cmd: 'flash';
    elfPath: string;
    device: string;
    interface: 'SWD' | 'JTAG';
    speedKHz: number;
    signal?: AbortSignal;
    probe?: DebugProbe;
    flashBeforeDebug?: boolean;
    cmsisDapFlashAlgorithmPath?: string;
  }
  | { cmd: 'readVariableRuntime'; name: string }
  | { cmd: 'loadSymbols'; elfPath: string }
  | { cmd: 'clearBreakpointAtAddr'; addr: number }
  | { cmd: 'setBreakpointAtAddr'; addr: number }
  | { cmd: 'evaluateExpression'; expression: string; force?: boolean; expandedExpressions?: string[] }
  | { cmd: 'prepareFastDataSampling'; expressions: string[] }
  | { cmd: 'readFastDataSampling'; specs: FastDataSampleSpec[] }
  | { cmd: 'setWatchValue'; expression: string; value: number; address?: number; typeName?: string }
  | { cmd: 'startRtt'; controlBlockAddress?: number }
  | { cmd: 'stopRtt' }
  | { cmd: 'readRtt'; bufferIndex: number; size: number };

export type OzoneCommandResult =
  | { ok: true; data: unknown }
  | {
    ok: false;
    error: string;
    errorCode?: string;
    diagnostics?: Record<string, unknown>;
    targetState?: string;
    elapsedMs?: number;
  };
