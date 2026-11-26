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
import { FlashTargetDefinition, resolveFlashTarget } from './cmsis-dap-flasher';
import type {
  CmsisDapRttEnumOptions,
  CmsisDapRttEnumResult,
  CmsisDapRttMemoryRange,
  CmsisDapRttStartOptions,
  CmsisDapRttWriteOptions,
  CmsisDapRttWriteResult,
} from './cmsis-dap-helper-channel';
import {
  RttCapabilities,
  isValidRttCapabilities,
  isValidRttEnumResult,
  isValidRttWriteResult,
  rttCapability,
  unavailableRttCapabilities,
  validateRttMemoryRanges,
} from './rtt-contract';
import type { Capability } from '../rtos/model';
import { log } from '../utils/logger';

export type CppJLinkTargetState = 'Disconnected' | 'Unknown' | 'Halted' | 'Running' | 'Stepping' | 'Error';

export interface CppJLinkConnectConfig {
  device: string;
  speedKHz: number;
  interface?: 'SWD' | 'JTAG';
  dllPath?: string;
}

export interface ProbeDiscoveryResult {
  available: boolean;
  reason?: string;
  dllPath?: string;
  dllVersion?: number;
  count?: number;
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
  helperClient?: CppJLinkHelperClient;
  helperPath?: string;
  requestTimeoutMs?: number;
  onDiagnostic?: (message: string) => void;
}

export interface CppJLinkReadOptions {
  priority?: Extract<NativeTaskPriority, 'watch' | 'timeline' | 'background'>;
  signal?: AbortSignal;
  coalesceKey?: string;
}

export interface NativeStepOverRequest {
  lineStart?: number;
  lineEnd?: number;
  waitTimeoutMs?: number;
  timeoutMs?: number;
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
  stopReason?: string;
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
  stopReason?: string;
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
  timeoutMs?: number;
  breakpoints?: Record<string, number>;
}

export interface NativeStepOutDiagnostics {
  pcBefore: number;
  pcAfter: number;
  lr: number;
  sp: number;
  returnAddress: number;
  classification: 'returnBreakpoint' | 'exceptionReturnBreakpoint' | 'existingReturnBreakpoint' | 'userBreakpoint';
  instructions: 0;
  cleanupOk: boolean;
  stopReason?: string;
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
  /** `onStepResumed` fires once the owner resumed the target and is waiting
   *  for the temporary breakpoint; owners without that signal ignore it. */
  stepOverSourceLine(
    request: NativeStepOverRequest,
    onStepResumed?: () => void,
  ): Promise<CppJLinkResult<NativeStepOverDiagnostics>>;
  stepOut(
    request: NativeStepOutRequest,
    onStepResumed?: () => void,
  ): Promise<CppJLinkResult<NativeStepOutDiagnostics>>;
}

export interface SessionNativeExecutor extends NativeStepExecutor {
  connect(config: CppJLinkConnectConfig): Promise<CppJLinkResult<{ channel: 'cpp'; dllPath?: string }>>;
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

  get started() { return this.child !== null; }

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
        'probeDiscovery', 'basicDebug', 'readRegister', 'readMemory', 'writeMemory',
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
  readonly kind = 'jlink-native' as const;
  private readonly helper: CppJLinkHelperClient;
  private nativeConnected = false;
  private helperCapabilities: Set<string> | null = null;
  private dllCapabilities: Set<string> | null = null;
  private dllRttCapabilities: Pick<RttCapabilities, 'rttStart' | 'rttEnumerate' | 'rttUpRead' | 'rttDownWrite'> | null = null;
  private dllApis: Record<string, boolean> | null = null;
  private flashTargetDef: FlashTargetDefinition | null = null;

  constructor(options: CppJLinkChannelOptions = {}) {
    const helperPath = options.helperPath || findDefaultHelperPath();
    this.helper = options.helperClient
      ?? new CppJLinkHelperClient(helperPath, options.requestTimeoutMs, options.onDiagnostic);
  }

  get usingNative() { return this.nativeConnected; }
  get flashTarget(): FlashTargetDefinition | null { return this.flashTargetDef; }
  getHelperCapabilities(): readonly string[] {
    return this.helperCapabilities ? Array.from(this.helperCapabilities) : [];
  }

  getRttCapabilities(): RttCapabilities {
    if (!this.nativeConnected) {
      return unavailableRttCapabilities(this.kind, 'J-Link native helper is not connected');
    }
    const resolveCap = (
      helperCap: string | null,
      dllCap: Capability | undefined,
      missingHelperReason: string,
    ): Capability => {
      if (helperCap && this.helperCapabilities && !this.helperCapabilities.has(helperCap)) {
        return rttCapability(false, missingHelperReason);
      }
      if (dllCap) return dllCap;
      return rttCapability(true);
    };
    return {
      ownerKind: this.kind,
      rttStart: resolveCap('rtt', this.dllRttCapabilities?.rttStart, 'J-Link helper does not advertise rtt capability'),
      rttEnumerate: resolveCap(
        'rttEnumerate',
        this.dllRttCapabilities?.rttEnumerate,
        'J-Link helper does not advertise rttEnumerate capability',
      ),
      rttUpRead: resolveCap('rtt', this.dllRttCapabilities?.rttUpRead, 'J-Link helper does not advertise rtt capability'),
      rttDownWrite: resolveCap(
        'rttWrite',
        this.dllRttCapabilities?.rttDownWrite,
        'J-Link helper does not advertise rttWrite capability',
      ),
      details: {
        dllApis: this.dllApis,
        dllCapabilities: this.dllCapabilities ? Array.from(this.dllCapabilities) : null,
        registeredTarget: Boolean(this.flashTargetDef),
        requiresExplicitRamRanges: !this.flashTargetDef,
      },
    };
  }

  async detectProbe(config: CppJLinkConnectConfig): Promise<CppJLinkResult<ProbeDiscoveryResult>> {
    try {
      const hello = await this.helper.start();
      if (!hello.ok) return this.failNative<ProbeDiscoveryResult>(`helper handshake failed: ${hello.message}`);
      const caps = hello.data?.capabilities;
      this.helperCapabilities = Array.isArray(caps) && caps.length > 0 ? new Set(caps) : null;
      return await this.helper.request<ProbeDiscoveryResult>('probe', { dllPath: config.dllPath });
    } catch (error) {
      return this.failNative<ProbeDiscoveryResult>(error instanceof Error ? error.message : String(error));
    }
  }

  async connect(config: CppJLinkConnectConfig): Promise<CppJLinkResult<{ channel: 'cpp'; dllPath?: string }>> {
    try {
      if (!this.helper.started) {
        const hello = await this.helper.start();
        if (!hello.ok) return this.failNative(`helper handshake failed: ${hello.message}`);
        const caps = hello.data?.capabilities;
        this.helperCapabilities = Array.isArray(caps) && caps.length > 0 ? new Set(caps) : null;
      }
      const result = await this.helper.request<{
        dllPath: string;
        capabilities?: string[];
        dllApis?: Record<string, boolean>;
        rttCapabilities?: Pick<RttCapabilities, 'rttStart' | 'rttEnumerate' | 'rttUpRead' | 'rttDownWrite'>;
      }>('connect', { ...config });
      if (result.ok) {
        this.nativeConnected = true;
        const dllCaps = result.data?.capabilities;
        this.dllCapabilities = Array.isArray(dllCaps) && dllCaps.length > 0 ? new Set(dllCaps) : null;
        this.dllApis = result.data?.dllApis ?? null;
        const rawRttCaps = result.data?.rttCapabilities;
        this.dllRttCapabilities = rawRttCaps && isValidRttCapabilities({ ownerKind: this.kind, ...rawRttCaps })
          ? rawRttCaps
          : null;
        try {
          this.flashTargetDef = config.device ? resolveFlashTarget(config.device) : null;
        } catch {
          this.flashTargetDef = null;
        }
        return { ...result, data: { channel: 'cpp' as const, dllPath: result.data?.dllPath } };
      }
      this.resetSessionCapabilities();
      await this.helper.dispose(false);
      return withoutData(result);
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
  async startRtt(controlBlockAddress?: number, options?: CmsisDapRttStartOptions): Promise<CppJLinkResult> {
    if (!this.usingNative) return this.failure('native startRtt channel is unavailable', 'NativeChannelUnavailable');
    const rttCaps = this.getRttCapabilities();
    if (!rttCaps.rttStart.available) {
      return this.failureWithCode(rttCaps.rttStart.reason || 'J-Link RTT start is unavailable', 'UnsupportedCapability', {
        ownerKind: this.kind,
        capability: 'startRtt',
      });
    }
    let ramRanges: CmsisDapRttMemoryRange[] | undefined;
    if (options?.ramRanges !== undefined) {
      const checked = validateRttMemoryRanges(options.ramRanges, false, 'ramRanges');
      if (!checked.ok) {
        return this.failureWithCode(checked.message, 'DapInvalidRequest', {
          ownerKind: this.kind,
          capability: 'startRtt',
        });
      }
      ramRanges = checked.normalized;
    } else if (this.flashTargetDef) {
      ramRanges = this.flashTargetDef.ramRegions.map(region => ({
        address: region.address,
        size: region.size,
      }));
    }
    return this.callNative('startRtt', {
      controlBlockAddress,
      ...(ramRanges ? { ramRanges } : {}),
    });
  }

  async enumerateRtt(
    controlBlockAddress?: number,
    options?: CmsisDapRttEnumOptions,
  ): Promise<CppJLinkResult<CmsisDapRttEnumResult>> {
    if (!this.usingNative) return this.failure('native enumerateRtt channel is unavailable', 'NativeChannelUnavailable');
    const rttCaps = this.getRttCapabilities();
    if (!rttCaps.rttEnumerate.available) {
      return this.failureWithCode(
        rttCaps.rttEnumerate.reason || 'J-Link RTT channel enumeration is unavailable',
        'UnsupportedCapability',
        { ownerKind: this.kind, capability: 'enumerateRtt' },
      );
    }
    if (controlBlockAddress !== undefined
      && (!Number.isInteger(controlBlockAddress) || controlBlockAddress <= 0 || controlBlockAddress > 0xFFFFFFFF)) {
      return this.failureWithCode(
        'J-Link RTT control block address must be a positive uint32',
        'DapInvalidRequest',
        { ownerKind: this.kind, capability: 'enumerateRtt' },
      );
    }

    let ramRanges: CmsisDapRttMemoryRange[];
    if (options?.ramRanges !== undefined) {
      const checked = validateRttMemoryRanges(options.ramRanges, false, 'ramRanges');
      if (!checked.ok) {
        return this.failureWithCode(checked.message, 'DapInvalidRequest', {
          ownerKind: this.kind,
          capability: 'enumerateRtt',
        });
      }
      ramRanges = checked.normalized;
    } else if (this.flashTargetDef) {
      ramRanges = this.flashTargetDef.ramRegions.map(region => ({
        address: region.address,
        size: region.size,
      }));
    } else {
      return this.failureWithCode(
        'J-Link RTT channel enumeration requires a registered target or explicit ramRanges',
        'UnsupportedCapability',
        { ownerKind: this.kind, capability: 'enumerateRtt' },
      );
    }

    let roRanges: CmsisDapRttMemoryRange[] | undefined;
    if (options?.roRanges !== undefined) {
      const checkedRo = validateRttMemoryRanges(options.roRanges, true, 'roRanges');
      if (!checkedRo.ok) {
        return this.failureWithCode(checkedRo.message, 'DapInvalidRequest', {
          ownerKind: this.kind,
          capability: 'enumerateRtt',
        });
      }
      roRanges = checkedRo.normalized;
    } else if (this.flashTargetDef) {
      roRanges = [{ address: this.flashTargetDef.flashBase, size: this.flashTargetDef.flashSize }];
    }

    let timeoutMs = 2000;
    if (options?.timeoutMs !== undefined) {
      if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 10000) {
        return this.failureWithCode(
          'J-Link enumerateRtt timeoutMs must be an integer in 1..10000',
          'DapInvalidRequest',
          { ownerKind: this.kind, capability: 'enumerateRtt' },
        );
      }
      timeoutMs = options.timeoutMs;
    }

    let result: CppJLinkResult<CmsisDapRttEnumResult>;
    try {
      result = await this.callNative<CmsisDapRttEnumResult>(
        'enumerateRtt',
        {
          ...(controlBlockAddress !== undefined ? { controlBlockAddress: controlBlockAddress >>> 0 } : {}),
          ramRanges,
          ...(roRanges ? { roRanges } : {}),
          timeoutMs,
        },
        { priority: 'watch', label: 'RTT channel enumeration' },
      );
    } catch (error) {
      if (error instanceof NativeSchedulerCancelledError) {
        return {
          ok: false,
          message: 'J-Link enumerateRtt was cancelled',
          errorCode: 'RequestCancelled',
          targetState: 'Unknown',
          elapsedMs: 0,
          diagnostics: { ownerKind: this.kind, method: 'enumerateRtt' },
        };
      }
      throw error;
    }
    if (!result.ok) {
      log.dap('[rtt] enumerateRtt failed owner=jlink-native errorCode=' + (result.errorCode || 'unknown')
        + ' message=' + result.message);
      return {
        ...result,
        diagnostics: { ...result.diagnostics, ownerKind: this.kind, method: 'enumerateRtt' },
      };
    }
    if (!isValidRttEnumResult(result.data)) {
      return {
        ok: false,
        message: 'J-Link enumerateRtt returned a malformed result',
        errorCode: 'MalformedResponse',
        targetState: 'Error',
        elapsedMs: result.elapsedMs,
        diagnostics: { ...result.diagnostics, ownerKind: this.kind, method: 'enumerateRtt' },
      };
    }
    log.dap('[rtt] enumerateRtt owner=jlink-native controlBlock=0x'
      + (result.data.controlBlockAddress >>> 0).toString(16)
      + ' up=' + result.data.validUpCount + '/' + result.data.maxUpBuffers
      + ' down=' + result.data.validDownCount + '/' + result.data.maxDownBuffers
      + ' corrupt=' + result.data.corruptCount + ' unused=' + result.data.unusedCount);
    return {
      ...result,
      diagnostics: { ...result.diagnostics, ownerKind: this.kind, method: 'enumerateRtt' },
    };
  }

  async stopRtt(): Promise<CppJLinkResult> { return this.callNative('stopRtt', {}); }

  async readRtt(
    bufferIndex: number,
    size: number,
    options: CppJLinkReadOptions = {},
  ): Promise<CppJLinkResult<{ bytes: Uint8Array }>> {
    if (!this.usingNative) return this.failure('native readRtt channel is unavailable', 'NativeChannelUnavailable');
    const rttCaps = this.getRttCapabilities();
    if (!rttCaps.rttUpRead.available) {
      return this.failureWithCode(
        rttCaps.rttUpRead.reason || 'J-Link RTT reading is unavailable',
        'UnsupportedCapability',
        { ownerKind: this.kind, capability: 'readRtt' },
      );
    }
    const result = await this.callNative<{ bytesBase64: string } & Record<string, unknown>>(
      'readRtt',
      { bufferIndex, size },
      { priority: 'background', coalesceKey: bufferIndex === 0 ? 'rtt-read' : `rtt-read-${bufferIndex}`, signal: options.signal },
    );
    if (!result.ok || !result.data) return withoutData(result);
    const { bytesBase64, ...metadata } = result.data;
    return {
      ...result,
      data: {
        ...metadata,
        bytes: Uint8Array.from(Buffer.from(bytesBase64, 'base64')),
      },
    };
  }

  async writeRtt(
    bufferIndex: number,
    bytes: Uint8Array,
    options?: CmsisDapRttWriteOptions,
  ): Promise<CppJLinkResult<CmsisDapRttWriteResult>> {
    if (!this.usingNative) return this.failure('native writeRtt channel is unavailable', 'NativeChannelUnavailable');
    const rttCaps = this.getRttCapabilities();
    if (!rttCaps.rttDownWrite.available) {
      return this.failureWithCode(
        rttCaps.rttDownWrite.reason || 'J-Link RTT down-buffer writes are unavailable',
        'UnsupportedCapability',
        { ownerKind: this.kind, capability: 'writeRtt' },
      );
    }
    if (!Number.isInteger(bufferIndex) || bufferIndex < 0 || bufferIndex > 0xFFFFFFFF) {
      return this.failureWithCode(
        'J-Link RTT Down bufferIndex must be a uint32',
        'DapInvalidRequest',
        { ownerKind: this.kind, capability: 'writeRtt' },
      );
    }
    if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > 65536) {
      return this.failureWithCode(
        'J-Link RTT write requires bytes in 1..65536',
        'DapInvalidRequest',
        { ownerKind: this.kind, capability: 'writeRtt' },
      );
    }
    if (options?.controlBlockAddress !== undefined
      && (!Number.isInteger(options.controlBlockAddress) || options.controlBlockAddress <= 0 || options.controlBlockAddress > 0xFFFFFFFF)) {
      return this.failureWithCode(
        'J-Link RTT control block address must be a positive uint32',
        'DapInvalidRequest',
        { ownerKind: this.kind, capability: 'writeRtt' },
      );
    }

    let ramRanges: CmsisDapRttMemoryRange[];
    if (options?.ramRanges !== undefined) {
      const checked = validateRttMemoryRanges(options.ramRanges, false, 'ramRanges');
      if (!checked.ok) {
        return this.failureWithCode(checked.message, 'DapInvalidRequest', {
          ownerKind: this.kind,
          capability: 'writeRtt',
        });
      }
      ramRanges = checked.normalized;
    } else if (this.flashTargetDef) {
      ramRanges = this.flashTargetDef.ramRegions.map(region => ({
        address: region.address,
        size: region.size,
      }));
    } else {
      return this.failureWithCode(
        'J-Link RTT Down-buffer write requires a registered target or explicit ramRanges',
        'UnsupportedCapability',
        { ownerKind: this.kind, capability: 'writeRtt' },
      );
    }

    let timeoutMs = 2000;
    if (options?.timeoutMs !== undefined) {
      if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 10000) {
        return this.failureWithCode(
          'J-Link writeRtt timeoutMs must be an integer in 1..10000',
          'DapInvalidRequest',
          { ownerKind: this.kind, capability: 'writeRtt' },
        );
      }
      timeoutMs = options.timeoutMs;
    }

    const result = await this.callNative<CmsisDapRttWriteResult>('writeRtt', {
      ...(options?.controlBlockAddress !== undefined
        ? { controlBlockAddress: options.controlBlockAddress >>> 0 }
        : {}),
      bufferIndex: bufferIndex >>> 0,
      bytesBase64: Buffer.from(bytes).toString('base64'),
      ramRanges,
      timeoutMs,
    });
    if (!result.ok) {
      const rttDiag = (result.diagnostics as { rtt?: Partial<CmsisDapRttWriteResult> } | undefined)?.rtt;
      log.dap('[rtt] writeRtt failed owner=jlink-native buffer=' + bufferIndex
        + ' requested=' + bytes.length
        + ' errorCode=' + (result.errorCode || 'unknown')
        + ' completion=' + (rttDiag?.completion || 'unknown')
        + ' failureStage=' + (rttDiag?.failureStage || 'unknown')
        + ' committed=' + (rttDiag?.committedBytes ?? 0));
      return {
        ...result,
        diagnostics: { ...result.diagnostics, ownerKind: this.kind, method: 'writeRtt' },
      };
    }
    if (!isValidRttWriteResult(result.data, bytes.length, bufferIndex)) {
      return {
        ok: false,
        message: 'J-Link writeRtt returned a malformed result',
        errorCode: 'MalformedResponse',
        targetState: 'Error',
        elapsedMs: result.elapsedMs,
        diagnostics: { ...result.diagnostics, ownerKind: this.kind, method: 'writeRtt' },
      };
    }
    log.dap('[rtt] writeRtt owner=jlink-native buffer=' + bufferIndex
      + ' requested=' + result.data.requestedBytes
      + ' written=' + result.data.writtenBytes
      + ' committed=' + result.data.committedBytes
      + ' committedWrOff=' + result.data.committedWrOff
      + ' mode=' + result.data.mode
      + ' shortWrite=' + result.data.shortWrite
      + ' wrapped=' + result.data.wrapped
      + ' completion=' + result.data.completion);
    return {
      ...result,
      diagnostics: { ...result.diagnostics, ownerKind: this.kind, method: 'writeRtt' },
    };
  }

  async disconnect(): Promise<CppJLinkResult> {
    if (!this.usingNative) return this.failure('native channel is not connected', 'NativeChannelUnavailable');
    return this.callNative('disconnect', {});
  }

  async dispose(graceful = true) {
    await this.helper.dispose(graceful);
    this.nativeConnected = false;
    this.resetSessionCapabilities();
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
      this.resetSessionCapabilities();
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
      this.resetSessionCapabilities();
      await this.helper.dispose(false);
      return this.failure(`native owner lost during ${method}: ${error instanceof Error ? error.message : String(error)}`, 'NativeOwnerLost');
    }
  }

  private async failNative<T = { channel: 'cpp' }>(reason: string): Promise<CppJLinkResult<T>> {
    this.nativeConnected = false;
    this.resetSessionCapabilities();
    await this.helper.dispose(false);
    return this.failure(`C++ channel unavailable: ${reason}`, 'NativeChannelUnavailable');
  }

  private resetSessionCapabilities() {
    this.helperCapabilities = null;
    this.dllCapabilities = null;
    this.dllRttCapabilities = null;
    this.dllApis = null;
    this.flashTargetDef = null;
  }

  private failureWithCode<T = Record<string, never>>(
    message: string,
    errorCode: string,
    diagnostics?: Record<string, unknown>,
  ): CppJLinkResult<T> {
    return { ok: false, message, errorCode, diagnostics, targetState: 'Error', elapsedMs: 0 };
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
    case 'startRtt':
    case 'stopRtt':
    case 'writeRtt':
      return 'control';
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
