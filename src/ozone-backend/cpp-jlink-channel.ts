import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import {
  NativeScheduleOptions,
  NativeScheduler,
  NativeSchedulerCancelledError,
  NativeTaskPriority,
} from './native-scheduler';

export type CppJLinkTargetState = 'Disconnected' | 'Unknown' | 'Halted' | 'Running' | 'Stepping' | 'Error';

export interface CppJLinkConnectConfig {
  device: string;
  speedKHz: number;
  interface?: 'SWD' | 'JTAG';
  dllPath?: string;
}

export interface CppJLinkResult<T = Record<string, never>> {
  ok: boolean;
  message: string;
  targetState: CppJLinkTargetState;
  elapsedMs: number;
  data?: T;
  errorCode?: string;
  diagnostics?: Record<string, unknown>;
}

export interface CppJLinkChannelOptions {
  helperPath?: string;
  requestTimeoutMs?: number;
  onDiagnostic?: (message: string) => void;
}

export interface CppJLinkReadOptions {
  priority?: Extract<NativeTaskPriority, 'watch' | 'timeline'>;
  signal?: AbortSignal;
  coalesceKey?: string;
}

export interface NativeStepOverRequest {
  lineStart?: number;
  lineEnd?: number;
  waitTimeoutMs?: number;
  maxInstructionSteps?: number;
  breakpoints?: Record<string, number>;
}

export interface NativeStepOverDiagnostics {
  pcBefore: number;
  pcAfter: number;
  classification: string;
  instructions: number;
  temporaryBreakpointCount?: number;
  cleanupOk: boolean;
  timings: {
    haltMs: number;
    readPcMs: number;
    decodeMs: number;
    executeMs: number;
    waitMs: number;
    cleanupMs: number;
    totalMs: number;
  };
}

export interface NativeStepIntoDiagnostics {
  pcBefore: number;
  pcAfter: number;
  classification: string;
  instructions: number;
  cleanupOk: true;
  timings: NativeStepTimings;
  phase?: 'instruction' | 'sourceLine';
  trace?: Array<{ pc: number; classification: string; call: boolean }>;
}

export interface NativeStepIntoSourceLineRequest {
  lineStart?: number;
  lineEnd?: number;
  maxInstructionSteps?: number;
}

export interface NativeStepOutRequest {
  functionStart: number;
  functionEnd: number;
  waitTimeoutMs?: number;
  breakpoints?: Record<string, number>;
}

export interface NativeStepOutDiagnostics {
  pcBefore: number;
  pcAfter: number;
  lr: number;
  sp: number;
  returnAddress: number;
  classification: 'returnBreakpoint' | 'existingReturnBreakpoint' | 'userBreakpoint';
  instructions: 0;
  cleanupOk: boolean;
  timings: NativeStepTimings;
}

export interface NativeStepTimings {
  haltMs: number;
  readPcMs: number;
  decodeMs: number;
  executeMs: number;
  waitMs: number;
  cleanupMs: number;
  totalMs: number;
}

export interface NativeStepExecutor {
  readonly usingNative: boolean;
  /** Reads a core register from the native owner when available. */
  readRegister?(index: number): Promise<CppJLinkResult<{ value: number }>>;
  stepIntoInstruction(): Promise<CppJLinkResult<NativeStepIntoDiagnostics>>;
  stepIntoSourceLine(request: NativeStepIntoSourceLineRequest): Promise<CppJLinkResult<NativeStepIntoDiagnostics>>;
  stepOverSourceLine(request: NativeStepOverRequest): Promise<CppJLinkResult<NativeStepOverDiagnostics>>;
  stepOut(request: NativeStepOutRequest): Promise<CppJLinkResult<NativeStepOutDiagnostics>>;
}

export interface SessionNativeExecutor extends NativeStepExecutor {
  connect(config: CppJLinkConnectConfig): Promise<CppJLinkResult<{ channel: 'cpp' | 'koffi'; dllPath?: string }>>;
  dispose(graceful?: boolean): Promise<void>;
}

interface RpcResponse<T> {
  id: number | null;
  result: CppJLinkResult<T>;
}

interface PendingRequest {
  resolve: (result: CppJLinkResult<any>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class CppJLinkHelperClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private exitError: Error | null = null;
  private intentionalStop = false;
  private sawStdoutLine = false;
  private sawStderrLine = false;
  private exitPromise: Promise<void> | null = null;
  private resolveExit: (() => void) | null = null;
  private readonly scheduler = new NativeScheduler();

  constructor(
    private readonly helperPath: string,
    private readonly requestTimeoutMs = 5000,
    private readonly onDiagnostic: (message: string) => void = () => {},
  ) {}

  async start(): Promise<CppJLinkResult<{ protocol: number; helperVersion: string; capabilities: string[] }>> {
    if (this.child) throw new Error('C++ J-Link helper is already started');
    this.exitError = null;
    this.intentionalStop = false;
    this.sawStdoutLine = false;
    this.sawStderrLine = false;
    this.exitPromise = new Promise<void>(resolve => { this.resolveExit = resolve; });
    this.onDiagnostic(`[cpp-jlink process] spawn helper=${this.helperPath} cwd=${process.cwd()}`);
    const child = spawn(this.helperPath, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    this.onDiagnostic(`[cpp-jlink process] spawn requested pid=${child.pid ?? 'pending'}`);

    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', line => this.handleLine(line));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) {
        this.sawStderrLine = true;
        this.onDiagnostic(`[cpp-jlink stderr] ${truncateDiagnostic(line)}`);
      }
    });
    child.once('spawn', () => this.onDiagnostic(`[cpp-jlink process] spawned pid=${child.pid ?? 'unknown'}`));
    child.once('error', error => {
      this.onDiagnostic(`[cpp-jlink process] spawn error code=${(error as NodeJS.ErrnoException).code || 'unknown'} message=${error.message}`);
      this.handleExit(new Error(`C++ J-Link helper failed to start: ${error.message}`));
      this.settleExit();
    });
    child.once('exit', (code, signal) => {
      this.onDiagnostic(`[cpp-jlink process] exit code=${code ?? 'null'} signal=${signal ?? 'none'}`);
      this.handleExit(new Error(`C++ J-Link helper exited (code=${code ?? 'null'}, signal=${signal ?? 'none'})`));
      this.settleExit();
    });

    this.onDiagnostic(`[cpp-jlink protocol] hello queued at=${new Date().toISOString()}`);
    return this.request('hello', {
      clientProtocol: 2,
      extensionVersion: 'experimental',
      requiredCapabilities: [
        'basicDebug', 'readRegister', 'readMemory', 'writeMemory',
        'readMemoryBatch', 'hardwareBreakpoints', 'reset',
        'stepIntoInstruction', 'stepIntoSourceLine', 'stepOverSourceLine', 'stepOut',
      ],
    });
  }

  request<T>(
    method: string,
    params: Record<string, unknown> = {},
    schedule: Partial<NativeScheduleOptions> = {},
  ): Promise<CppJLinkResult<T>> {
    const priority = schedule.priority || priorityForMethod(method);
    return this.scheduler.schedule(
      () => this.sendRequest<T>(method, params),
      { ...schedule, priority, label: schedule.label || method },
    );
  }

  async controlRequest<T>(method: string, params: Record<string, unknown> = {}): Promise<CppJLinkResult<T>> {
    return this.scheduler.withPaused(['timeline', 'background'], () =>
      this.request<T>(method, params, { priority: 'control' }),
    );
  }

  pauseTimeline(): () => void { return this.scheduler.pause('timeline'); }

  cancelTimeline(reason = 'Timeline sampling cancelled') { this.scheduler.cancel('timeline', reason); }

  getSchedulerSnapshot() { return this.scheduler.snapshot(); }

  private sendRequest<T>(method: string, params: Record<string, unknown>): Promise<CppJLinkResult<T>> {
    if (!this.child || !this.child.stdin.writable) {
      return Promise.reject(this.exitError || new Error('C++ J-Link helper is not running'));
    }
    const id = this.nextId++;
    return new Promise<CppJLinkResult<T>>((resolve, reject) => {
      const sentAt = Date.now();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const child = this.child;
        this.onDiagnostic(
          `[cpp-jlink protocol] ${method} timeout after=${Date.now() - sentAt}ms pid=${child?.pid ?? 'none'} `
          + `exitCode=${child?.exitCode ?? 'null'} killed=${child?.killed ?? false} stdinWritable=${child?.stdin.writable ?? false}`,
        );
        reject(new Error(`C++ J-Link helper request timed out: ${method}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const requestLine = `${JSON.stringify({ id, method, params })}\n`;
      if (method === 'hello') {
        this.onDiagnostic(`[cpp-jlink protocol] hello send id=${id} bytes=${Buffer.byteLength(requestLine)} at=${new Date().toISOString()}`);
      }
      this.child!.stdin.write(requestLine, error => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(error);
      });
    });
  }

  async dispose(graceful = true): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.onDiagnostic(`[cpp-jlink process] dispose graceful=${graceful} pid=${child.pid ?? 'unknown'} pending=${this.pending.size}`);
    this.intentionalStop = true;
    if (graceful) {
      try {
        await this.request('shutdown');
      } catch {}
    }
    this.scheduler.dispose();
    const exited = this.exitPromise || Promise.resolve();
    if (!graceful && !child.killed) child.kill();
    let didExit = false;
    await Promise.race([
      exited.then(() => { didExit = true; }),
      new Promise<void>(resolve => setTimeout(resolve, 500)),
    ]);
    if (!didExit && !child.killed) child.kill();
    didExit = false;
    await Promise.race([
      exited.then(() => { didExit = true; }),
      new Promise<void>(resolve => setTimeout(resolve, 2000)),
    ]);
    if (!didExit) {
      throw new Error(`C++ J-Link helper did not exit after termination request (pid=${child.pid ?? 'unknown'})`);
    }
    this.child = null;
  }

  private handleLine(line: string) {
    let response: RpcResponse<unknown>;
    try {
      response = JSON.parse(line) as RpcResponse<unknown>;
      if (!this.sawStdoutLine) {
        this.sawStdoutLine = true;
        this.onDiagnostic(`[cpp-jlink protocol] stdout first line parsed=true raw=${truncateDiagnostic(line)}`);
      }
    } catch (error) {
      if (!this.sawStdoutLine) {
        this.sawStdoutLine = true;
        this.onDiagnostic(`[cpp-jlink protocol] stdout first line parsed=false raw=${truncateDiagnostic(line)}`);
      }
      this.onDiagnostic(`[cpp-jlink protocol] invalid response: ${truncateDiagnostic(line)}; ${error}`);
      return;
    }
    if (typeof response.id !== 'number') {
      this.onDiagnostic(`[cpp-jlink protocol] response without request id: ${line}`);
      return;
    }
    const pending = this.pending.get(response.id);
    if (!pending) {
      this.onDiagnostic(`[cpp-jlink protocol] response for unknown request ${response.id}`);
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(response.id);
    pending.resolve(response.result);
  }

  private handleExit(error: Error) {
    if (this.intentionalStop) {
      this.child = null;
      return;
    }
    if (!this.child && this.exitError) return;
    this.exitError = error;
    this.child = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.onDiagnostic(`[cpp-jlink process] ${error.message}`);
  }

  private settleExit() {
    this.resolveExit?.();
    this.resolveExit = null;
  }
}

export class ExperimentalCppJLinkChannel {
  readonly kind = 'native' as const;
  private readonly helper: CppJLinkHelperClient;
  private nativeConnected = false;

  constructor(options: CppJLinkChannelOptions = {}) {
    const helperPath = options.helperPath || findDefaultHelperPath();
    this.helper = new CppJLinkHelperClient(helperPath, options.requestTimeoutMs, options.onDiagnostic);
  }

  get usingNative() { return this.nativeConnected; }

  async connect(config: CppJLinkConnectConfig): Promise<CppJLinkResult<{ channel: 'cpp' | 'koffi'; dllPath?: string }>> {
    try {
      const hello = await this.helper.start();
      if (!hello.ok) return this.failNative(`helper handshake failed: ${hello.message}`);
      const result = await this.helper.request<{ dllPath: string }>('connect', { ...config });
      if (result.ok) {
        this.nativeConnected = true;
        return { ...result, data: { channel: 'cpp' as const, dllPath: result.data?.dllPath } };
      }
      await this.helper.dispose(false);
      return this.failure(`${result.errorCode || 'NativeConnectFailed'}: ${result.message}`, 'NativeChannelUnavailable');
    } catch (error) {
      return this.failNative(error instanceof Error ? error.message : String(error));
    }
  }

  async halt(): Promise<CppJLinkResult> { return this.callNative('halt', {}); }
  async run(): Promise<CppJLinkResult> { return this.callNative('run', {}); }
  async step(): Promise<CppJLinkResult> { return this.callNative('step', {}); }
  async reset(): Promise<CppJLinkResult> { return this.callNative('reset', {}); }
  async getState() { return this.callNative<{ state: CppJLinkTargetState }>('getState', {}); }

  async stepOverSourceLine(request: NativeStepOverRequest): Promise<CppJLinkResult<NativeStepOverDiagnostics>> {
    return this.callNativeStep('stepOverSourceLine', { ...request });
  }

  async stepIntoInstruction(): Promise<CppJLinkResult<NativeStepIntoDiagnostics>> {
    return this.callNativeStep('stepIntoInstruction', {});
  }

  async stepIntoSourceLine(request: NativeStepIntoSourceLineRequest): Promise<CppJLinkResult<NativeStepIntoDiagnostics>> {
    return this.callNativeStep('stepIntoSourceLine', { ...request });
  }

  async stepOut(request: NativeStepOutRequest): Promise<CppJLinkResult<NativeStepOutDiagnostics>> {
    return this.callNativeStep('stepOut', { ...request });
  }

  async readRegister(index: number, options: CppJLinkReadOptions = {}): Promise<CppJLinkResult<{ value: number }>> {
    return this.callNative('readRegister', { index }, readSchedule(options));
  }

  async readMemory(address: number, size: number, options: CppJLinkReadOptions = {}): Promise<CppJLinkResult<{ bytes: Uint8Array }>> {
    const result = await this.callNative<{ bytesBase64: string }>('readMemory', { address, size }, readSchedule(options));
    if (!result.ok || !result.data) return withoutData(result);
    return { ...result, data: { bytes: Uint8Array.from(Buffer.from(result.data.bytesBase64, 'base64')) } };
  }

  async readMemoryBatch(
    reads: Array<{ address: number; size: number }>,
    options: CppJLinkReadOptions = {},
  ): Promise<CppJLinkResult<{ reads: Array<{ address: number; bytes: Uint8Array }> }>> {
    const result = await this.callNative<{ reads: Array<{ address: number; bytesBase64: string }> }>(
      'readMemoryBatch', { reads }, readSchedule(options),
    );
    if (!result.ok || !result.data) return withoutData(result);
    return {
      ...result,
      data: {
        reads: result.data.reads.map(read => ({
          address: read.address,
          bytes: Uint8Array.from(Buffer.from(read.bytesBase64, 'base64')),
        })),
      },
    };
  }

  async writeMemory(address: number, bytes: Uint8Array): Promise<CppJLinkResult<{ address: number; bytesWritten: number }>> {
    return this.callNative<{ address: number; bytesWritten: number }>('writeMemory', {
      address,
      bytesBase64: Buffer.from(bytes).toString('base64'),
    });
  }

  async setBreakpoint(address: number, preferredSlot?: number): Promise<CppJLinkResult<{ id: number }>> {
    return this.callNative('setBreakpoint', { address, preferredSlot });
  }

  async clearBreakpoint(id: number): Promise<CppJLinkResult> {
    return this.callNative('clearBreakpoint', { id });
  }

  async clearAllBreakpoints(): Promise<CppJLinkResult> { return this.callNative('clearAllBreakpoints', {}); }
  async startRtt(controlBlockAddress?: number): Promise<CppJLinkResult> { return this.callNative('startRtt', { controlBlockAddress }); }
  async stopRtt(): Promise<CppJLinkResult> { return this.callNative('stopRtt', {}); }
  async readRtt(bufferIndex: number, size: number): Promise<CppJLinkResult<{ bytes: Uint8Array }>> {
    const result = await this.callNative<{ bytesBase64: string }>(
      'readRtt',
      { bufferIndex, size },
      { priority: 'background', coalesceKey: 'rtt-read' },
    );
    if (!result.ok || !result.data) return withoutData(result);
    return { ...result, data: { bytes: Uint8Array.from(Buffer.from(result.data.bytesBase64, 'base64')) } };
  }

  async disconnect(): Promise<CppJLinkResult> {
    if (!this.usingNative) return this.failure('native channel is not connected', 'NativeChannelUnavailable');
    return this.callNative('disconnect', {});
  }

  async dispose(graceful = true) {
    await this.helper.dispose(graceful);
    this.nativeConnected = false;
  }

  private async callNative<T>(
    method: string,
    params: Record<string, unknown>,
    schedule?: Partial<NativeScheduleOptions>,
  ): Promise<CppJLinkResult<T>> {
    if (!this.usingNative) return this.failure(`native ${method} channel is unavailable`, 'NativeChannelUnavailable');
    try {
      return priorityForMethod(method) === 'control'
        ? await this.helper.controlRequest<T>(method, params)
        : await this.helper.request<T>(method, params, schedule);
    } catch (error) {
      if (error instanceof NativeSchedulerCancelledError) throw error;
      this.nativeConnected = false;
      await this.helper.dispose(false);
      return this.failure(`native owner lost during ${method}: ${error instanceof Error ? error.message : String(error)}`, 'NativeOwnerLost');
    }
  }

  private async callNativeStep<T>(method: string, params: Record<string, unknown>): Promise<CppJLinkResult<T>> {
    if (!this.usingNative) return this.failure(`native ${method} channel is unavailable`, 'NativeChannelUnavailable');
    try {
      return await this.helper.controlRequest<T>(method, params);
    } catch (error) {
      if (error instanceof NativeSchedulerCancelledError) throw error;
      this.nativeConnected = false;
      await this.helper.dispose(false);
      return this.failure(`native owner lost during ${method}: ${error instanceof Error ? error.message : String(error)}`, 'NativeOwnerLost');
    }
  }

  private async failNative(reason: string): Promise<CppJLinkResult<{ channel: 'cpp' }>> {
    this.nativeConnected = false;
    await this.helper.dispose(false);
    return this.failure(`C++ channel unavailable: ${reason}`, 'NativeChannelUnavailable');
  }

  private failure<T = Record<string, never>>(message: string, errorCode = 'JLinkCallFailed'): CppJLinkResult<T> {
    return { ok: false, message, errorCode, targetState: 'Error', elapsedMs: 0 };
  }
}

function priorityForMethod(method: string): NativeTaskPriority {
  switch (method) {
    case 'connect':
    case 'halt':
    case 'run':
    case 'reset':
    case 'continue':
    case 'step':
    case 'stepIntoInstruction':
    case 'stepIntoSourceLine':
    case 'stepOverSourceLine':
    case 'stepOut':
    case 'setBreakpoint':
    case 'clearBreakpoint':
    case 'clearAllBreakpoints':
    case 'disconnect':
    case 'writeVariable':
    case 'writeMemory':
      return 'control';
    case 'startRtt':
    case 'stopRtt':
    case 'readRtt':
      return 'background';
    case 'readFastSample':
      return 'timeline';
    default:
      return 'watch';
  }
}

function readSchedule(options: CppJLinkReadOptions): Partial<NativeScheduleOptions> {
  return {
    priority: options.priority || 'watch',
    signal: options.signal,
    coalesceKey: options.coalesceKey,
  };
}

function findDefaultHelperPath(): string {
  const relatives = [
    path.join('out', 'native', 'win32-x64', 'orbit-jlink-helper.exe'),
    path.join('out', 'native', 'win32-x64', 'ozone-jlink-helper.exe'),
  ];
  const candidates = relatives.flatMap(relative => [
    path.resolve(__dirname, '..', relative),
    path.resolve(__dirname, '..', '..', relative),
  ]);
  return candidates.find(candidate => fs.existsSync(candidate)) || candidates[0];
}

function truncateDiagnostic(value: string, maxLength = 256): string {
  const normalized = value.replace(/[\r\n]+/g, ' ');
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength)}...`;
}

function withoutData<T>(result: CppJLinkResult<unknown>): CppJLinkResult<T> {
  const { data: _data, ...rest } = result;
  return rest;
}
