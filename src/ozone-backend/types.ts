export interface DebugSessionConfig {
  device: string;
  interface: 'SWD' | 'JTAG';
  speedKHz: number;
  jdebugScript?: string;
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
  value: number;
  display: string;
  hex: string;
  address?: number;
  error?: string;
  typeName?: string;
  children?: WatchValue[];
}

export interface DataPoint {
  timestamp: number;
  value: number;
  display: string;
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
  | { cmd: 'flash'; elfPath: string; device: string; interface: 'SWD' | 'JTAG'; speedKHz: number }
  | { cmd: 'readVariableRuntime'; name: string }
  | { cmd: 'loadSymbols'; elfPath: string }
  | { cmd: 'clearBreakpointAtAddr'; addr: number }
  | { cmd: 'setBreakpointAtAddr'; addr: number }
  | { cmd: 'evaluateExpression'; expression: string; force?: boolean };

export type OzoneCommandResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string };