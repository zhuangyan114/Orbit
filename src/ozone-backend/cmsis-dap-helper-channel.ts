import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { CppJLinkResult } from './cpp-jlink-channel';
import {
  NativeScheduleOptions,
  NativeScheduler,
  NativeTaskPriority,
} from './native-scheduler';

/**
 * Stable error codes from the CMSIS-DAP helper JSON-lines protocol. Codes in
 * native/cmsis-dap-helper/src/cmsis_dap_transport.h map 1:1; the additional
 * client-side codes below (HelperExited, HelperStartFailed,
 * ProtocolVersionMismatch, UnknownMethod) are produced by this client only.
 */
export type CmsisDapErrorCode =
  | 'DeviceNotFound'
  | 'DeviceOpenFailed'
  | 'DeviceRemoved'
  | 'ReadTimeout'
  | 'WriteTimeout'
  | 'MalformedResponse'
  | 'ProtocolError'
  | 'PacketTooLarge'
  | 'TransportNotSupported'
  | 'RequestCancelled'
  | 'OutcomeUnknown'
  | 'WriteCompletedLate'
  | 'InvalidState'
  | 'InternalError'
  | 'DapAckWait'
  | 'DapAckFault'
  | 'DapAckNoAck'
  | 'DapInvalidRequest'
  | 'DapControlTimeout'
  | 'DapAlgorithmTimeout'
  | 'DapAlgorithmError'
  | 'DapAlgorithmHaltUnknown'
  | 'FlashProtectionError'
  | 'VerifyFailed'
  | 'ProtocolVersionMismatch'
  | 'UnknownMethod'
  | 'HelperExited'
  | 'HelperStartFailed';

export interface CmsisDapDeviceInfo {
  path: string;
  vid: string;
  pid: string;
  manufacturer: string;
  product: string;
  serial: string;
  inputReportLength: number;
  outputReportLength: number;
  reportId: number;
  usagePage: number;
  usage: number;
  transport: string;
}

export type CmsisDapPacketSizeSource = 'protocol-info' | 'hid-report-capability' | 'unavailable';

export interface CmsisDapInfoResult {
  vendor: string;
  product: string;
  serial: string;
  firmwareVersion: string;
  protocolVersion: string;
  capabilities: number[];
  packetCount: number | null;
  packetSize: number | null;
  protocolPacketSize: number | null;
  effectivePacketSize: number;
  packetSizeSource: CmsisDapPacketSizeSource;
}

export interface CmsisDapHelperOptions {
  helperPath?: string;
  requestTimeoutMs?: number;
  onDiagnostic?: (message: string) => void;
}

/** Diagnostic counters reported by the DP/AP and memory-read operations. */
export interface CmsisDapTransferDiagnostics {
  chunks: number;
  packets: number;
  blockReads: number;
  blockWrites: number;
  waitRetries: number;
  faultClears: number;
  packetSize: number;
}

export interface CmsisDapDpReadResult {
  reg: number;
  value: number;
}

export interface CmsisDapApReadResult {
  addr: number;
  value: number;
}

export interface CmsisDapMemoryReadResult {
  address: number;
  size: number;
  bytes: number[];
}

export interface CmsisDapMemoryBlockReadResult {
  address: number;
  wordCount: number;
  words: number[];
}

export interface CmsisDapCoreStateResult {
  state: 'Halted' | 'Running';
  dhcsr: number;
  pc?: number;
}

export interface CmsisDapStepInstructionResult {
  state: 'Halted';
  dhcsr: number;
  pcBefore: number;
  pcAfter: number;
}

export interface CmsisDapRegisterReadResult {
  register: number;
  value: number;
}

export interface CmsisDapFlashAlgorithmRpcResult {
  operation: 'init' | 'uninit' | 'eraseSector' | 'programPage' | 'verify';
  address: number;
  size: number;
  returnCode: number;
  pc: number;
  dhcsr: number;
  flashStatusBefore?: number;
  flashControlBefore?: number;
  flashStatus?: number;
  flashControl?: number;
}

export type CmsisDapControlRequest =
  <T>(method: string, params?: Record<string, unknown>) => Promise<CppJLinkResult<T>>;

interface PendingRequest {
  resolve: (result: CppJLinkResult<any>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

// The helper applies timeoutMs to the bounded control operation itself. Keep
// a response envelope after that deadline so the client can receive the
// structured AlgorithmTimeout/diagnostics instead of replacing it with a
// generic RPC timeout at the same millisecond.
// A timed-out flash operation also captures final DHCSR/fault state. Each
// native DAP I/O has a bounded two-second timeout, so reserve enough room for
// those final reads before reporting a client-side RPC timeout.
const CONTROL_RESPONSE_MARGIN_MS = 5000;

function requestTimeoutFor(
  method: string,
  params: Record<string, unknown>,
  baseTimeoutMs: number,
): number {
  if (method === 'flashAlgorithm' || typeof params.timeoutMs === 'number') {
    const controlTimeoutMs = params.timeoutMs;
    if (typeof controlTimeoutMs === 'number' && Number.isFinite(controlTimeoutMs) && controlTimeoutMs > 0) {
      return Math.max(baseTimeoutMs, controlTimeoutMs + CONTROL_RESPONSE_MARGIN_MS);
    }
  }
  return baseTimeoutMs;
}

/**
 * JSON-lines RPC client for the orbit-cmsis-dap-helper.exe child process.
 * Mirrors CppJLinkHelperClient's lifecycle (spawn, request id matching,
 * timeout, abnormal-exit detection, graceful disposal) without sharing code
 * with the J-Link channel.
 */
export class CmsisDapHelperClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private exitError: Error | null = null;
  private intentionalStop = false;
  private exitPromise: Promise<void> | null = null;
  private resolveExit: (() => void) | null = null;
  private readonly scheduler = new NativeScheduler();

  constructor(
    private readonly helperPath: string,
    private readonly requestTimeoutMs = 5000,
    private readonly onDiagnostic: (message: string) => void = () => {},
  ) {}

  async start(): Promise<CppJLinkResult<{ protocol: number; helperVersion: string; platform: string; capabilities: string[] }>> {
    if (this.child) throw new Error('CMSIS-DAP helper is already started');
    this.exitError = null;
    this.intentionalStop = false;
    this.exitPromise = new Promise<void>(resolve => { this.resolveExit = resolve; });
    this.onDiagnostic(`[cmsis-dap process] spawn helper=${this.helperPath} cwd=${process.cwd()}`);
    const child = spawn(this.helperPath, ['--transport=hid'], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.onDiagnostic(`[cmsis-dap process] spawn requested pid=${child.pid ?? 'pending'}`);

    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', line => this.handleLine(line));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) {
        this.onDiagnostic(`[cmsis-dap stderr] ${truncateDiagnostic(line)}`);
      }
    });
    child.once('spawn', () => this.onDiagnostic(`[cmsis-dap process] spawned pid=${child.pid ?? 'unknown'}`));
    child.once('error', error => {
      this.onDiagnostic(`[cmsis-dap process] spawn error code=${(error as NodeJS.ErrnoException).code || 'unknown'} message=${error.message}`);
      this.handleExit(new Error(`CMSIS-DAP helper failed to start: ${error.message}`));
      this.settleExit();
    });
    child.once('exit', (code, signal) => {
      this.onDiagnostic(`[cmsis-dap process] exit code=${code ?? 'null'} signal=${signal ?? 'none'}`);
      this.handleExit(new Error(`CMSIS-DAP helper exited (code=${code ?? 'null'}, signal=${signal ?? 'none'})`));
      this.settleExit();
    });

    this.onDiagnostic(`[cmsis-dap protocol] hello queued at=${new Date().toISOString()}`);
    return this.request('hello', {
      clientProtocol: 1,
      extensionVersion: 'experimental',
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

  /** Runs a control-priority request with Timeline/background reads paused. */
  async controlRequest<T>(method: string, params: Record<string, unknown> = {}): Promise<CppJLinkResult<T>> {
    return this.scheduler.withPaused(['watch', 'timeline', 'background'], () =>
      this.request<T>(method, params, { priority: 'control' }),
    );
  }

  /** Queues the entire multi-request Flash flow as one exclusive control task. */
  async withControlCriticalSection<T>(
    execute: (request: CmsisDapControlRequest) => Promise<T>,
  ): Promise<T> {
    const controlRequest: CmsisDapControlRequest = <TRequest>(
      method: string,
      params: Record<string, unknown> = {},
    ) => this.sendRequest<TRequest>(method, params);
    return this.scheduler.schedule(
      () => this.scheduler.withPaused(
        ['watch', 'timeline', 'background'],
        () => execute(controlRequest),
      ),
      { priority: 'control', label: 'CMSIS-DAP Flash critical section' },
    );
  }

  pauseTimeline(): () => void { return this.scheduler.pause('timeline'); }

  cancelTimeline(reason = 'Timeline sampling cancelled') { this.scheduler.cancel('timeline', reason); }

  getSchedulerSnapshot() { return this.scheduler.snapshot(); }

  private sendRequest<T>(method: string, params: Record<string, unknown>): Promise<CppJLinkResult<T>> {
    if (!this.child || !this.child.stdin.writable) {
      return Promise.reject(this.exitError || new Error('CMSIS-DAP helper is not running'));
    }
    const id = this.nextId++;
    return new Promise<CppJLinkResult<T>>((resolve, reject) => {
      const sentAt = Date.now();
      const requestTimeoutMs = requestTimeoutFor(method, params, this.requestTimeoutMs);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const child = this.child;
        this.onDiagnostic(
          `[cmsis-dap protocol] ${method} timeout after=${Date.now() - sentAt}ms pid=${child?.pid ?? 'none'} `
          + `exitCode=${child?.exitCode ?? 'null'} killed=${child?.killed ?? false} stdinWritable=${child?.stdin.writable ?? false}`,
        );
        reject(new Error(`CMSIS-DAP helper request timed out: ${method}`));
      }, requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const requestLine = `${JSON.stringify({ id, method, params })}\n`;
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
    this.onDiagnostic(`[cmsis-dap process] dispose graceful=${graceful} pid=${child.pid ?? 'unknown'} pending=${this.pending.size}`);
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
      throw new Error(`CMSIS-DAP helper did not exit after termination request (pid=${child.pid ?? 'unknown'})`);
    }
    this.child = null;
  }

  private handleLine(line: string) {
    let response: { id: number | null; result: CppJLinkResult<unknown> };
    try {
      response = JSON.parse(line) as { id: number | null; result: CppJLinkResult<unknown> };
    } catch (error) {
      this.onDiagnostic(`[cmsis-dap protocol] invalid response: ${truncateDiagnostic(line)}; ${error}`);
      return;
    }
    if (typeof response.id !== 'number') {
      this.onDiagnostic(`[cmsis-dap protocol] response without request id: ${line}`);
      return;
    }
    const pending = this.pending.get(response.id);
    if (!pending) {
      this.onDiagnostic(`[cmsis-dap protocol] response for unknown request ${response.id}`);
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
  }

  private settleExit() {
    const resolveExit = this.resolveExit;
    this.resolveExit = null;
    if (resolveExit) resolveExit();
  }
}

function findDefaultHelperPath(): string {
  const relatives = [
    path.join('out', 'native', 'win32-x64', 'orbit-cmsis-dap-helper.exe'),
    path.join('out', 'native', 'win32-x64', 'orbit-cmsis-dap-helper'),
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

/** Maps helper RPC methods to NativeScheduler priorities (control > watch > timeline > background). */
function priorityForMethod(method: string): NativeTaskPriority {
  switch (method) {
    case 'connect':
    case 'disconnect':
    case 'close':
    case 'open':
    case 'enumDevices':
    case 'getInfo':
    case 'hello':
    case 'shutdown':
    case 'dpWrite':
    case 'apWrite':
    case 'getState':
    case 'halt':
    case 'run':
    case 'reset':
    case 'stepInstruction':
    case 'readRegister':
    case 'flashAlgorithm':
      return 'control';
    case 'dpRead':
    case 'apRead':
    case 'readMemory':
    case 'readMemoryBlock':
      return 'watch';
    default:
      return 'watch';
  }
}

export { findDefaultHelperPath };
