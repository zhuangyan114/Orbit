import {
  CppJLinkConnectConfig,
  CppJLinkReadOptions,
  CppJLinkResult,
  NativeStepExecutor,
  NativeStepIntoDiagnostics,
  NativeStepIntoSourceLineRequest,
  NativeStepOutDiagnostics,
  NativeStepOutRequest,
  NativeStepOverDiagnostics,
  NativeStepOverRequest,
} from './cpp-jlink-channel';
import { JLinkDLL } from './jlink-dll';
import { log } from '../utils/logger';

export type SessionTargetOwnerKind = 'none' | 'native' | 'legacy';
export type SessionTargetMode = 'legacy' | 'native' | 'auto';

let nextSessionId = 1;

export interface SessionTargetOwner extends NativeStepExecutor {
  readonly kind: Exclude<SessionTargetOwnerKind, 'none'>;
  readonly usingNative: boolean;
  connect(config: CppJLinkConnectConfig): Promise<CppJLinkResult<{ channel: 'cpp' | 'koffi'; dllPath?: string }>>;
  disconnect(): Promise<CppJLinkResult>;
  halt(): Promise<CppJLinkResult>;
  run(): Promise<CppJLinkResult>;
  step(): Promise<CppJLinkResult>;
  reset(): Promise<CppJLinkResult>;
  getState(): Promise<CppJLinkResult<{ state: string }>>;
  readRegister(index: number, options?: CppJLinkReadOptions): Promise<CppJLinkResult<{ value: number }>>;
  readMemory(address: number, size: number, options?: CppJLinkReadOptions): Promise<CppJLinkResult<{ bytes: Uint8Array }>>;
  readMemoryBatch(
    reads: Array<{ address: number; size: number }>,
    options?: CppJLinkReadOptions,
  ): Promise<CppJLinkResult<{ reads: Array<{ address: number; bytes: Uint8Array }> }>>;
  writeMemory(address: number, bytes: Uint8Array): Promise<CppJLinkResult<{ address: number; bytesWritten: number }>>;
  setBreakpoint(address: number, preferredSlot?: number): Promise<CppJLinkResult<{ id: number }>>;
  clearBreakpoint(id: number): Promise<CppJLinkResult>;
  clearAllBreakpoints(): Promise<CppJLinkResult>;
  startRtt(controlBlockAddress?: number): Promise<CppJLinkResult>;
  stopRtt(): Promise<CppJLinkResult>;
  readRtt(bufferIndex: number, size: number): Promise<CppJLinkResult<{ bytes: Uint8Array }>>;
  dispose(graceful?: boolean): Promise<void>;
}

export type SessionTargetOwnerFactory = () => SessionTargetOwner;

/** Chooses exactly one physical J-Link owner for a debug session. */
export class SessionTargetSelector {
  private owner: SessionTargetOwner | null = null;
  private readonly breakpointSlots: (number | null)[] = [null, null, null, null, null, null];
  private readonly sessionId = `target-${nextSessionId++}`;
  private selectedMode: SessionTargetMode = 'legacy';

  constructor(
    private readonly createNative: SessionTargetOwnerFactory,
    private readonly createLegacy: SessionTargetOwnerFactory,
  ) {}

  get ownerKind(): SessionTargetOwnerKind { return this.owner?.kind || 'none'; }
  get usingNative(): boolean { return this.owner?.usingNative === true; }

  async connect(
    config: CppJLinkConnectConfig,
    requestedMode: SessionTargetMode | boolean = 'auto',
  ): Promise<CppJLinkResult<{ channel: 'cpp' | 'koffi'; dllPath?: string }>> {
    if (this.owner) {
      return failure<{ channel: 'cpp' | 'koffi'; dllPath?: string }>(
        'session target owner is already selected',
        'OwnerAlreadySelected',
      );
    }

    const mode = normalizeTargetMode(requestedMode);
    this.selectedMode = mode;
    log.dll(`target-owner session=${this.sessionId} select mode=${mode} owner=none command=connect targetConnected=false`);
    if (mode !== 'legacy') {
      const native = this.createNative();
      const nativeResult = await native.connect(config);
      if (nativeResult.ok) {
        this.owner = native;
        log.dll(`target-owner session=${this.sessionId} selected mode=${mode} owner=native command=connect targetConnected=true`);
        return nativeResult;
      }

      // Process exit is part of dispose's contract. Legacy must not even be
      // constructed until the native DLL owner has fully left the process.
      await native.dispose(false);
      if (mode === 'native') {
        log.dll(`target-owner session=${this.sessionId} native initialization failed mode=${mode} owner=none command=connect code=${nativeResult.errorCode || 'NativeInitializationFailed'} targetConnected=false action=restart-in-legacy-mode`);
        return {
          ...nativeResult,
          errorCode: 'NativeInitializationFailed',
          message: `Native initialization failed: ${nativeResult.message}. The target was not connected; restart the debug session in legacy mode or select auto mode to allow startup fallback.`,
        };
      }
      log.dll(`target-owner session=${this.sessionId} fallback mode=auto owner=none command=connect code=${nativeResult.errorCode || 'NativeInitializationFailed'} targetConnected=false action=create-legacy-owner`);
    }

    const legacy = this.createLegacy();
    const legacyResult = await legacy.connect(config);
    if (legacyResult.ok) {
      this.owner = legacy;
      log.dll(`target-owner session=${this.sessionId} selected mode=${mode} owner=legacy command=connect targetConnected=true`);
      return legacyResult;
    }
    await legacy.dispose(false);
    return legacyResult;
  }

  async disconnect(): Promise<CppJLinkResult> {
    if (!this.owner) return success('already disconnected');
    return this.owner.disconnect();
  }

  async halt() { return this.call('halt', owner => owner.halt()); }
  async run() { return this.call('run', owner => owner.run()); }
  async step() { return this.call('step', owner => owner.step()); }
  async reset() { return this.call('reset', owner => owner.reset()); }
  async getState() { return this.call('getState', owner => owner.getState()); }
  async readRegister(index: number, options?: CppJLinkReadOptions) {
    return this.call('readRegister', owner => owner.readRegister(index, options));
  }
  async readMemory(address: number, size: number, options?: CppJLinkReadOptions) {
    return this.call('readMemory', owner => owner.readMemory(address, size, options));
  }
  async readMemoryBatch(reads: Array<{ address: number; size: number }>, options?: CppJLinkReadOptions) {
    return this.call('readMemoryBatch', owner => owner.readMemoryBatch(reads, options));
  }
  async writeMemory(address: number, bytes: Uint8Array) {
    return this.call('writeMemory', owner => owner.writeMemory(address, bytes));
  }
  async setBreakpoint(address: number, preferredSlot?: number) {
    const result = await this.call('setBreakpoint', owner => owner.setBreakpoint(address, preferredSlot));
    if (result.ok && result.data) this.breakpointSlots[result.data.id] = address;
    return result;
  }
  async clearBreakpoint(id: number) {
    const result = await this.call('clearBreakpoint', owner => owner.clearBreakpoint(id));
    if (result.ok && id >= 0 && id < this.breakpointSlots.length) this.breakpointSlots[id] = null;
    return result;
  }
  async clearAllBreakpoints() {
    const result = await this.call('clearAllBreakpoints', owner => owner.clearAllBreakpoints());
    if (result.ok) this.breakpointSlots.fill(null);
    return result;
  }
  async startRtt(controlBlockAddress?: number) { return this.call('startRtt', owner => owner.startRtt(controlBlockAddress)); }
  async stopRtt() { return this.call('stopRtt', owner => owner.stopRtt()); }
  async readRtt(bufferIndex: number, size: number) { return this.call('readRtt', owner => owner.readRtt(bufferIndex, size)); }
  async stepIntoInstruction() { return this.call('stepIntoInstruction', owner => owner.stepIntoInstruction()); }
  async stepIntoSourceLine(request: NativeStepIntoSourceLineRequest) {
    return this.call('stepIntoSourceLine', owner => owner.stepIntoSourceLine(request));
  }
  async stepOverSourceLine(request: NativeStepOverRequest) {
    return this.call('stepOverSourceLine', owner => owner.stepOverSourceLine(request));
  }
  async stepOut(request: NativeStepOutRequest) { return this.call('stepOut', owner => owner.stepOut(request)); }

  async dispose(graceful = true): Promise<void> {
    const owner = this.owner;
    this.owner = null;
    if (owner) await owner.dispose(graceful);
  }

  private async call<T>(command: string, run: (owner: SessionTargetOwner) => Promise<CppJLinkResult<T>>): Promise<CppJLinkResult<T>> {
    const owner = this.owner;
    if (!owner) return failure('session target owner is unavailable', 'TargetOwnerUnavailable');
    const result = await run(owner);
    if (!result.ok && result.errorCode === 'NativeOwnerLost' && owner.kind === 'native') {
      // A native owner was already connected. Switching to koffi here would
      // create a new physical owner in the same DAP session, so terminate it.
      this.owner = null;
      await owner.dispose(false);
      log.dll(`target-owner session=${this.sessionId} native command failed mode=${this.selectedMode} owner=native command=${command} code=NativeOwnerLost targetConnected=true action=restart-session`);
      return {
        ...result,
        message: `${result.message}. Native session was terminated; restart the debug session in legacy mode or start a new auto-mode session.`,
      };
    }
    return result;
  }
}

function normalizeTargetMode(mode: SessionTargetMode | boolean): SessionTargetMode {
  if (mode === true) return 'auto';
  if (mode === false) return 'legacy';
  return mode;
}

export class LegacyJLinkTargetChannel implements SessionTargetOwner {
  readonly kind = 'legacy' as const;
  readonly usingNative = false;

  constructor(private readonly jlink = new JLinkDLL()) {}

  async connect(config: CppJLinkConnectConfig): Promise<CppJLinkResult<{ channel: 'koffi' }>> {
    if (!this.jlink.open() || !this.jlink.connect(config.device, config.speedKHz)) {
      return failure('legacy J-Link connect failed', 'FallbackConnectFailed');
    }
    return this.success({ channel: 'koffi' }, 'legacy J-Link connected');
  }

  async disconnect() {
    this.jlink.disconnect();
    return success('legacy J-Link disconnected');
  }

  async halt() { return this.booleanCall(() => this.jlink.halt(), 'halt'); }
  async run() { return this.booleanCall(() => this.jlink.run(), 'run'); }
  async step() { return this.booleanCall(() => this.jlink.step(), 'step'); }
  async reset() { return this.booleanCall(() => this.jlink.reset(), 'reset'); }
  async getState() {
    const state = this.jlink.isHalted() ? 'Halted' : this.jlink.state === 'running' ? 'Running' : 'Unknown';
    return this.success({ state }, 'target state read');
  }
  async readRegister(index: number) {
    const value = this.jlink.readRegister(index);
    return value === null
      ? failure<{ value: number }>('legacy register read failed', 'JLinkCallFailed')
      : this.success({ value }, 'register read');
  }
  async readMemory(address: number, size: number) {
    const bytes = this.jlink.readMemory(address, size);
    return bytes
      ? this.success({ bytes }, 'memory read')
      : failure<{ bytes: Uint8Array }>('legacy memory read failed', 'JLinkCallFailed');
  }
  async readMemoryBatch(reads: Array<{ address: number; size: number }>) {
    const results: Array<{ address: number; bytes: Uint8Array }> = [];
    for (const read of reads) {
      const bytes = this.jlink.readMemory(read.address, read.size);
      if (!bytes) return failure<{ reads: typeof results }>('legacy memory batch read failed', 'JLinkCallFailed');
      results.push({ address: read.address, bytes });
    }
    return this.success({ reads: results }, 'memory batch read');
  }
  async writeMemory(address: number, bytes: Uint8Array) {
    return this.jlink.writeMemoryBytes(address, bytes)
      ? this.success({ address, bytesWritten: bytes.length }, 'memory written')
      : failure<{ address: number; bytesWritten: number }>('legacy memory write failed', 'JLinkCallFailed');
  }
  async setBreakpoint(address: number, preferredSlot?: number) {
    const id = this.jlink.setBreakpoint(address, preferredSlot);
    return id === null
      ? failure<{ id: number }>('legacy set breakpoint failed', 'JLinkCallFailed')
      : this.success({ id }, 'breakpoint set');
  }
  async clearBreakpoint(id: number) { return this.booleanCall(() => this.jlink.clearBreakpoint(id), 'clear breakpoint'); }
  async clearAllBreakpoints() {
    this.jlink.clearAllBreakpoints();
    return this.success({}, 'all breakpoints cleared');
  }
  async startRtt(controlBlockAddress?: number) {
    return this.booleanCall(() => this.jlink.startRtt(controlBlockAddress), 'start RTT');
  }
  async stopRtt() {
    this.jlink.stopRtt();
    return this.success({}, 'RTT stopped');
  }
  async readRtt(bufferIndex: number, size: number) {
    const bytes = this.jlink.readRtt(bufferIndex, size);
    return bytes
      ? this.success({ bytes }, 'RTT read')
      : failure<{ bytes: Uint8Array }>('legacy RTT read failed', 'JLinkCallFailed');
  }
  async stepIntoInstruction(): Promise<CppJLinkResult<NativeStepIntoDiagnostics>> { return this.nativeUnsupported(); }
  async stepIntoSourceLine(_request: NativeStepIntoSourceLineRequest): Promise<CppJLinkResult<NativeStepIntoDiagnostics>> {
    return this.nativeUnsupported();
  }
  async stepOverSourceLine(_request: NativeStepOverRequest): Promise<CppJLinkResult<NativeStepOverDiagnostics>> {
    return this.nativeUnsupported();
  }
  async stepOut(_request: NativeStepOutRequest): Promise<CppJLinkResult<NativeStepOutDiagnostics>> {
    return this.nativeUnsupported();
  }
  async dispose() { this.jlink.disconnect(); }

  private booleanCall(run: () => boolean, operation: string): CppJLinkResult {
    return run() ? this.success({}, `${operation} completed`) : failure(`legacy ${operation} failed`, 'JLinkCallFailed');
  }
  private nativeUnsupported<T>(): CppJLinkResult<T> {
    return failure('native step is unavailable on the legacy owner', 'NativeChannelUnavailable');
  }
  private success<T>(data: T, message: string): CppJLinkResult<T> {
    const targetState = this.jlink.state === 'running' ? 'Running' : this.jlink.isHalted() ? 'Halted' : 'Unknown';
    return { ok: true, data, message, targetState, elapsedMs: 0 };
  }
}

function success(message: string): CppJLinkResult {
  return { ok: true, message, targetState: 'Disconnected', elapsedMs: 0, data: {} };
}

function failure<T = Record<string, never>>(message: string, errorCode: string): CppJLinkResult<T> {
  return { ok: false, message, errorCode, targetState: 'Error', elapsedMs: 0 };
}
