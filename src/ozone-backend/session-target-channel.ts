import {
  CppJLinkConnectConfig,
  CppJLinkReadOptions,
  CppJLinkResult,
  CppJLinkTargetState,
  NativeStepExecutor,
  NativeStepIntoDiagnostics,
  NativeStepIntoSourceLineRequest,
  NativeStepOutDiagnostics,
  NativeStepOutRequest,
  NativeStepOverDiagnostics,
  NativeStepOverRequest,
} from './cpp-jlink-channel';
import {
  CmsisDapDeviceInfo,
  CmsisDapHelperClient,
  CmsisDapHelperOptions,
  CmsisDapMemoryReadResult,
  CmsisDapCoreStateResult,
  CmsisDapStepInstructionResult,
  CmsisDapRegisterReadResult,
  CmsisDapDpReadResult,
  CmsisDapFlashAlgorithmRpcResult,
  CmsisDapControlRequest,
  findDefaultHelperPath,
} from './cmsis-dap-helper-channel';
import {
  CmsisDapFlashOptions,
  CmsisDapFlashResult,
  flashCmsisDapElf,
  FlashAlgorithmRunRequest,
  FlashAlgorithmRunData,
} from './cmsis-dap-flasher';
import { JLinkDLL } from './jlink-dll';
import { NativeSchedulerCancelledError } from './native-scheduler';
import { log } from '../utils/logger';
import { CmsisDapTransport, DebugProbe } from './types';

export type SessionTargetOwnerKind = 'none' | 'jlink-native' | 'jlink-legacy' | 'cmsis-dap';
export type SessionTargetMode = 'legacy' | 'native' | 'auto';

/** Physical owner channel identifiers reported by connect(). */
export type TargetChannelKind = 'cpp' | 'koffi' | 'cmsis-dap';

export interface TargetChannelInfo {
  channel: TargetChannelKind;
  dllPath?: string;
  diagnostics?: Record<string, unknown>;
}

export interface SessionTargetConnectConfig extends CppJLinkConnectConfig {
  probe?: DebugProbe;
  cmsisDapTransport?: CmsisDapTransport;
  cmsisDapSerial?: string;
  cmsisDapVid?: string;
  cmsisDapPid?: string;
  cmsisDapFlashAlgorithmPath?: string;
  flashBeforeDebug?: boolean;
}

let nextSessionId = 1;

export interface SessionTargetOwner extends NativeStepExecutor {
  readonly kind: Exclude<SessionTargetOwnerKind, 'none'>;
  readonly usingNative: boolean;
  connect(config: SessionTargetConnectConfig): Promise<CppJLinkResult<TargetChannelInfo>>;
  disconnect(): Promise<CppJLinkResult>;
  halt(): Promise<CppJLinkResult<any>>;
  run(): Promise<CppJLinkResult<any>>;
  step(): Promise<CppJLinkResult<any>>;
  reset(): Promise<CppJLinkResult<any>>;
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
  flash?(elfPath: string, device: string, options?: CmsisDapFlashOptions): Promise<CppJLinkResult<CmsisDapFlashResult>>;
  dispose(graceful?: boolean): Promise<void>;
}

export type SessionTargetOwnerFactory = () => SessionTargetOwner;

/** Chooses exactly one physical target owner for a debug session. */
export class SessionTargetSelector {
  private owner: SessionTargetOwner | null = null;
  private readonly breakpointSlots: (number | null)[] = [null, null, null, null, null, null];
  private readonly sessionId = `target-${nextSessionId++}`;
  private selectedMode: SessionTargetMode = 'legacy';

  constructor(
    private readonly createNative: SessionTargetOwnerFactory,
    private readonly createLegacy: SessionTargetOwnerFactory,
    private readonly createCmsisDap: SessionTargetOwnerFactory = () => new CmsisDapTargetChannel(),
  ) {}

  get ownerKind(): SessionTargetOwnerKind { return this.owner?.kind || 'none'; }
  get usingNative(): boolean { return this.owner?.usingNative === true; }

  async connect(
    config: SessionTargetConnectConfig,
    requestedMode: SessionTargetMode | boolean = 'auto',
  ): Promise<CppJLinkResult<TargetChannelInfo>> {
    if (this.owner) {
      return failure<TargetChannelInfo>(
        'session target owner is already selected',
        'OwnerAlreadySelected',
      );
    }

    if (config.probe === 'cmsis-dap') {
      log.dll(`target-owner session=${this.sessionId} select probe=cmsis-dap owner=none command=connect targetConnected=false`);
      const cmsisDap = this.createCmsisDap();
      const result = await cmsisDap.connect(config);
      if (result.ok) {
        this.owner = cmsisDap;
        log.dll(`target-owner session=${this.sessionId} selected probe=cmsis-dap owner=cmsis-dap command=connect targetConnected=true`);
        return result;
      }
      await cmsisDap.dispose(false);
      return result;
    }

    const mode = normalizeTargetMode(requestedMode);
    this.selectedMode = mode;
    log.dll(`target-owner session=${this.sessionId} select mode=${mode} owner=none command=connect targetConnected=false`);
    if (mode !== 'legacy') {
      const native = this.createNative();
      const nativeResult = await native.connect(config);
      if (nativeResult.ok) {
        this.owner = native;
        log.dll(`target-owner session=${this.sessionId} selected mode=${mode} owner=jlink-native command=connect targetConnected=true`);
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
      log.dll(`target-owner session=${this.sessionId} selected mode=${mode} owner=jlink-legacy command=connect targetConnected=true`);
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
  async flash(elfPath: string, device: string, options?: CmsisDapFlashOptions) {
    return this.call('flash', owner => owner.flash
      ? owner.flash(elfPath, device, options)
      : Promise.resolve(failure<CmsisDapFlashResult>('target owner has no CMSIS-DAP Flash Algorithm', 'UnsupportedCapability')));
  }
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
    if (!result.ok && result.errorCode === 'NativeOwnerLost' && owner.kind === 'jlink-native') {
      // A native owner was already connected. Switching to koffi here would
      // create a new physical owner in the same DAP session, so terminate it.
      this.owner = null;
      await owner.dispose(false);
      log.dll(`target-owner session=${this.sessionId} native command failed mode=${this.selectedMode} owner=jlink-native command=${command} code=NativeOwnerLost targetConnected=true action=restart-session`);
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
  readonly kind = 'jlink-legacy' as const;
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
    const disconnected = !this.jlink.isTargetConnected() || this.jlink.state === 'disconnected';
    if (disconnected) this.jlink.abandon();
    const targetLinkAlive = disconnected ? null : this.jlink.probeTargetLink();
    if (targetLinkAlive === false) {
      return failure<{ state: CppJLinkTargetState }>(
        'legacy SW-DP health probe could not reach the target',
        'TargetStateReadFailed',
      );
    }
    const haltState = disconnected ? false : this.jlink.getHaltState();
    if (haltState === null) {
      return failure<{ state: CppJLinkTargetState }>(
        'legacy JLINK_IsHalted could not read target state',
        'TargetStateReadFailed',
      );
    }
    const state = disconnected
      ? 'Disconnected'
      : haltState
        ? 'Halted'
        : this.jlink.state === 'running'
          ? 'Running'
          : 'Unknown';
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
  async dispose(graceful = true) {
    if (graceful) this.jlink.disconnect();
    else this.jlink.abandon();
  }

  private booleanCall(run: () => boolean, operation: string): CppJLinkResult {
    return run() ? this.success({}, `${operation} completed`) : failure(`legacy ${operation} failed`, 'JLinkCallFailed');
  }
  private nativeUnsupported<T>(): CppJLinkResult<T> {
    return failure('native step is unavailable on the legacy owner', 'NativeChannelUnavailable');
  }
  private success<T>(data: T, message: string): CppJLinkResult<T> {
    const targetState = this.jlink.state === 'disconnected'
      ? 'Disconnected'
      : this.jlink.state === 'running'
        ? 'Running'
        : this.jlink.isHalted()
          ? 'Halted'
          : 'Unknown';
    return { ok: true, data, message, targetState, elapsedMs: 0 };
  }
}

export interface CmsisDapTargetChannelOptions {
  /** Injectable helper client for tests; defaults to a real spawned helper. */
  helperClient?: CmsisDapHelperClient;
  helperPath?: string;
  requestTimeoutMs?: number;
  onDiagnostic?: (message: string) => void;
}

/**
 * CMSIS-DAP owner boundary backed by the orbit-cmsis-dap-helper.exe process.
 * The CMSIS-DAP owner keeps target control, memory reads, and the DAP-02A
 * Flash Algorithm on the same helper process and physical transport.
 */
export class CmsisDapTargetChannel implements SessionTargetOwner {
  readonly kind = 'cmsis-dap' as const;
  readonly usingNative = false;
  private readonly helper: CmsisDapHelperClient;
  private state: 'idle' | 'opened' | 'connected' | 'failed' = 'idle';
  private lastDevice: CmsisDapDeviceInfo | null = null;

  constructor(options: CmsisDapTargetChannelOptions = {}) {
    this.helper = options.helperClient
      ?? new CmsisDapHelperClient(
        options.helperPath || findDefaultHelperPath(),
        options.requestTimeoutMs,
        options.onDiagnostic || (message => log.dll(`[cmsis-dap] ${message}`)),
      );
  }

  async connect(config: SessionTargetConnectConfig): Promise<CppJLinkResult<TargetChannelInfo>> {
    const transport = config.cmsisDapTransport || 'auto';
    if (transport === 'winusb') {
      return this.unsupported<TargetChannelInfo>('connect', {
        transport,
        reason: 'CMSIS-DAP v2/WinUSB transport is not implemented in DAP-02-HID',
      });
    }
    // 'auto' resolves to HID: the only transport implemented in this stage.
    // The helper never guesses wireless or WinUSB capability.
    const effectiveTransport = 'hid';

    log.dll(`[cmsis-dap] connect transport=${effectiveTransport} serial=${config.cmsisDapSerial || ''} vid=${config.cmsisDapVid || ''} pid=${config.cmsisDapPid || ''}`);

    let hello: Awaited<ReturnType<CmsisDapHelperClient['start']>>;
    try {
      hello = await this.helper.start();
    } catch (error) {
      return this.failAndDispose(this.helperFailure('start', error), 'start');
    }
    if (!hello.ok) {
      return this.failAndDispose(
        {
          ...hello,
          errorCode: 'HelperStartFailed',
          message: `CMSIS-DAP helper failed to start: ${hello.message}`,
        },
        'start',
      );
    }

    const selector: Record<string, string> = { transport: effectiveTransport };
    if (config.cmsisDapVid) selector.vid = config.cmsisDapVid;
    if (config.cmsisDapPid) selector.pid = config.cmsisDapPid;
    if (config.cmsisDapSerial) selector.serial = config.cmsisDapSerial;

    try {
      const enumeration = await this.helper.request<{ devices: CmsisDapDeviceInfo[] }>('enumDevices', selector);
      if (!enumeration.ok) return this.failAndDispose(enumeration, 'enumDevices');
      if (!enumeration.data || enumeration.data.devices.length === 0) {
        return this.failAndDispose({
          ok: false,
          message: 'no matching CMSIS-DAP HID device found',
          errorCode: 'DeviceNotFound',
          targetState: 'Error' as const,
          elapsedMs: 0,
        }, 'enumDevices');
      }

      const opened = await this.helper.request<CmsisDapDeviceInfo>('open', selector);
      if (!opened.ok) return this.failAndDispose(opened, 'open');
      this.lastDevice = opened.data ?? null;
      this.state = 'opened';
      log.dll(`[cmsis-dap] opened device vid=${this.lastDevice?.vid || ''} pid=${this.lastDevice?.pid || ''} product=${this.lastDevice?.product || ''} serial=${this.lastDevice?.serial || ''} inputReportLength=${this.lastDevice?.inputReportLength ?? 0} outputReportLength=${this.lastDevice?.outputReportLength ?? 0} reportId=${this.lastDevice?.reportId ?? 0}`);

      // DAP_Info is diagnostic: an empty or failing info item must not block
      // the connect handshake, but every structured result is surfaced.
      let infoDiagnostics: Record<string, unknown> = {};
      try {
        const info = await this.helper.request('getInfo', { timeoutMs: 2000 });
        if (info.ok) infoDiagnostics = { info: info.data };
        else infoDiagnostics = { infoError: { errorCode: info.errorCode, message: info.message } };
      } catch (error) {
        infoDiagnostics = { infoError: { errorCode: 'HelperExited', message: String(error) } };
      }

      const connected = await this.helper.request('connect', {
        port: config.interface === 'JTAG' ? 'JTAG' : 'SWD',
        speedKHz: config.speedKHz,
        resetTarget: false,
        timeoutMs: 2000,
      });
      if (!connected.ok) {
        await this.helper.request('close', {}).catch(() => {});
        return this.failAndDispose(connected, 'connect');
      }
      this.state = 'connected';
      log.dll(`[cmsis-dap] connected port=${(connected.data as { port?: string })?.port || 'unknown'} owner=cmsis-dap`);
      return {
        ok: true,
        message: 'CMSIS-DAP connected',
        targetState: 'Unknown' as const,
        elapsedMs: 0,
        data: {
          channel: 'cmsis-dap',
          diagnostics: {
            device: this.lastDevice,
            connectResponse: connected.data,
            ...infoDiagnostics,
          },
        },
      };
    } catch (error) {
      return this.failAndDispose(this.helperFailure('connect', error), 'connect');
    }
  }

  async disconnect(): Promise<CppJLinkResult> {
    if (this.state === 'idle' || this.state === 'failed') {
      return { ok: true, message: 'CMSIS-DAP already disconnected', targetState: 'Disconnected', elapsedMs: 0, data: {} };
    }
    if (this.state === 'connected') {
      const result = await this.helper.request('disconnect', {}).catch(() => null);
      if (result && !result.ok) {
        log.dll(`[cmsis-dap] DAP_Disconnect failed: ${result.errorCode || 'Error'} ${result.message}`);
      }
    }
    await this.helper.request('close', {}).catch(() => {});
    await this.helper.dispose(true).catch(() => {});
    this.state = 'idle';
    this.lastDevice = null;
    log.dll('[cmsis-dap] disconnected owner=cmsis-dap');
    return { ok: true, message: 'CMSIS-DAP disconnected', targetState: 'Disconnected', elapsedMs: 0, data: {} };
  }

  async halt() {
    return this.controlViaHelper<CmsisDapCoreStateResult>('halt', {});
  }
  async run() {
    return this.controlViaHelper<CmsisDapCoreStateResult>('run', {});
  }
  async step() {
    return this.controlViaHelper<CmsisDapStepInstructionResult>('stepInstruction', {});
  }
  async reset() {
    return this.controlViaHelper<CmsisDapCoreStateResult>('reset', {});
  }
  async getState() {
    return this.controlViaHelper<CmsisDapCoreStateResult>('getState', {});
  }
  async readRegister(index: number, _options?: CppJLinkReadOptions) {
    return this.controlViaHelper<CmsisDapRegisterReadResult>('readRegister', { index });
  }
  async readDp(reg: number): Promise<{ ok: boolean; value?: number; message?: string; errorCode?: string }> {
    const result = await this.controlViaHelper<CmsisDapDpReadResult>('dpRead', { reg });
    if (!result.ok || !result.data) {
      return { ok: false, message: result.message, errorCode: result.errorCode };
    }
    return { ok: true, value: result.data.value, message: result.message };
  }
  async runAlgorithm(request: FlashAlgorithmRunRequest) {
    const result = await this.controlViaHelper<CmsisDapFlashAlgorithmRpcResult>('flashAlgorithm', request as unknown as Record<string, unknown>);
    return {
      ok: result.ok,
      message: result.message,
      errorCode: result.errorCode,
      data: result.data,
      elapsedMs: result.elapsedMs,
      diagnostics: result.diagnostics,
    };
  }
  async readMemory(address: number, size: number, options?: CppJLinkReadOptions) {
    return this.readViaHelper<CmsisDapMemoryReadResult, { bytes: Uint8Array }>(
      'readMemory',
      { address, size },
      options,
      result => ({ bytes: Uint8Array.from(result.bytes) }),
    );
  }
  private async readMemoryForFlash(address: number, size: number) {
    const result = await this.controlViaHelper<CmsisDapMemoryReadResult>('readMemory', { address, size });
    if (!result.ok || !result.data) {
      return { ok: false, message: result.message, errorCode: result.errorCode };
    }
    return { ok: true, bytes: Uint8Array.from(result.data.bytes), message: result.message };
  }
  async flash(elfPath: string, device: string, options: CmsisDapFlashOptions = {}) {
    if (this.state !== 'connected') return this.invalidState<CmsisDapFlashResult>('flash');
    const result = await this.helper.withControlCriticalSection(async (controlRequest: CmsisDapControlRequest) =>
      flashCmsisDapElf({
        readDp: async reg => {
          const response = await controlRequest<CmsisDapDpReadResult>('dpRead', { reg });
          return response.ok
            ? { ok: true, value: response.data?.value, message: response.message }
            : { ok: false, message: response.message, errorCode: response.errorCode };
        },
        readMemory: async (address, size) => {
          const response = await controlRequest<CmsisDapMemoryReadResult>('readMemory', { address, size });
          return response.ok && response.data
            ? { ok: true, bytes: Uint8Array.from(response.data.bytes), message: response.message }
            : { ok: false, message: response.message, errorCode: response.errorCode };
        },
        runAlgorithm: async request => {
          const response = await controlRequest<CmsisDapFlashAlgorithmRpcResult>(
            'flashAlgorithm',
            request as unknown as Record<string, unknown>,
          );
          return {
            ok: response.ok,
            message: response.message,
            errorCode: response.errorCode,
            data: response.data,
            elapsedMs: response.elapsedMs,
            diagnostics: response.diagnostics,
          };
        },
      }, elfPath, device, {
        ...options,
        onOperation: report => {
          log.dll(`[cmsis-dap] flash operation=${report.operation} address=0x${report.address.toString(16)} `
            + `size=${report.size} elapsedMs=${report.elapsedMs} ok=${report.ok} `
            + `errorCode=${report.errorCode || ''}`);
        },
      }));
    const elapsedMs = result.reports.reduce((total, item) => total + item.elapsedMs, 0);
    if (!result.success) {
      return {
        ok: false,
        message: result.message,
        errorCode: result.errorCode,
        targetState: 'Error' as const,
        elapsedMs,
        diagnostics: { ...result.diagnostics, reports: result.reports, erasedSectors: result.erasedSectors },
      };
    }
    return {
      ok: true,
      message: result.message,
      targetState: 'Halted' as const,
      elapsedMs,
      data: result,
      diagnostics: { ...result.diagnostics, reports: result.reports, erasedSectors: result.erasedSectors },
    };
  }
  async readMemoryBatch(reads: Array<{ address: number; size: number }>, options?: CppJLinkReadOptions) {
    if (this.state !== 'connected') {
      return this.invalidState<{ reads: Array<{ address: number; bytes: Uint8Array }> }>('readMemoryBatch');
    }
    const results: Array<{ address: number; bytes: Uint8Array }> = [];
    for (const read of reads) {
      const result = await this.readMemory(read.address, read.size, options);
      if (!result.ok || !result.data) {
        return {
          ok: false,
          message: `CMSIS-DAP memory batch read failed at 0x${read.address.toString(16)}: ${result.message}`,
          errorCode: result.errorCode || 'DapReadFailed',
          targetState: 'Error' as const,
          elapsedMs: 0,
          diagnostics: { ownerKind: this.kind, reads: reads.length },
        };
      }
      results.push({ address: read.address, bytes: result.data.bytes });
    }
    log.dap(`[cmsis-dap] readMemoryBatch reads=${results.length} bytes=${results.reduce((sum, item) => sum + item.bytes.length, 0)} owner=cmsis-dap`);
    return { ok: true, message: 'CMSIS-DAP memory batch read', targetState: 'Unknown' as const, elapsedMs: 0, data: { reads: results } };
  }
  async writeMemory(_address: number, _bytes: Uint8Array) {
    return this.unsupported<{ address: number; bytesWritten: number }>('writeMemory');
  }
  async setBreakpoint(_address: number, _preferredSlot?: number) {
    return this.unsupported<{ id: number }>('setBreakpoint');
  }
  async clearBreakpoint(_id: number) { return this.unsupported('clearBreakpoint'); }
  async clearAllBreakpoints() { return this.unsupported('clearAllBreakpoints'); }
  async startRtt(_controlBlockAddress?: number) { return this.unsupported('startRtt'); }
  async stopRtt() { return this.unsupported('stopRtt'); }
  async readRtt(_bufferIndex: number, _size: number) {
    return this.unsupported<{ bytes: Uint8Array }>('readRtt');
  }
  async stepIntoInstruction(): Promise<CppJLinkResult<NativeStepIntoDiagnostics>> {
    const result = await this.controlViaHelper<CmsisDapStepInstructionResult>('stepInstruction', {});
    if (!result.ok || !result.data) return result as unknown as CppJLinkResult<NativeStepIntoDiagnostics>;
    return {
      ...result,
      data: {
        pcBefore: result.data.pcBefore,
        pcAfter: result.data.pcAfter,
        classification: 'instruction',
        instructions: 1,
        cleanupOk: true,
        phase: 'instruction',
        timings: {
          haltMs: 0,
          readPcMs: 0,
          decodeMs: 0,
          executeMs: 0,
          waitMs: 0,
          cleanupMs: 0,
          totalMs: result.elapsedMs,
        },
      },
    };
  }
  async stepIntoSourceLine(_request: NativeStepIntoSourceLineRequest) {
    return this.unsupported<NativeStepIntoDiagnostics>('stepIntoSourceLine');
  }
  async stepOverSourceLine(_request: NativeStepOverRequest) {
    return this.unsupported<NativeStepOverDiagnostics>('stepOverSourceLine');
  }
  async stepOut(_request: NativeStepOutRequest) {
    return this.unsupported<NativeStepOutDiagnostics>('stepOut');
  }
  async dispose(graceful = true): Promise<void> {
    if (this.state !== 'idle') await this.disconnect().catch(() => {});
    if (!graceful) await this.helper.dispose(false).catch(() => {});
  }

  private helperFailure<T = TargetChannelInfo>(stage: string, error: unknown): CppJLinkResult<T> {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      message: `CMSIS-DAP helper ${stage} failed: ${message}`,
      errorCode: 'HelperExited',
      targetState: 'Error',
      elapsedMs: 0,
      diagnostics: { stage, ownerKind: this.kind },
    };
  }

  private invalidState<T>(capability: string): CppJLinkResult<T> {
    return failure<T>(
      `CMSIS-DAP is not connected; cannot ${capability}`,
      'InvalidState',
      { capability, ownerKind: this.kind, state: this.state },
    );
  }

  /**
   * Runs one helper memory/register request on the connected owner with the
   * standard read scheduling (watch priority by default, `controlRequest`
   * semantics for writes in later stages). Helper errors are passed through
   * verbatim so the structured error code (DapAckWait/DapAckFault/...) is
   * preserved; a helper crash surfaces as HelperExited.
   */
  private async readViaHelper<THelper, TResult>(
    method: string,
    params: Record<string, unknown>,
    options: CppJLinkReadOptions | undefined,
    map: (helper: THelper) => TResult,
  ): Promise<CppJLinkResult<TResult>> {
    if (this.state !== 'connected') {
      return this.invalidState<TResult>(method);
    }
    let result: CppJLinkResult<THelper>;
    try {
      result = await this.helper.request<THelper>(method, params, {
        priority: options?.priority || 'watch',
        signal: options?.signal,
        coalesceKey: options?.coalesceKey,
      });
    } catch (error) {
      if (error instanceof NativeSchedulerCancelledError) {
        return {
          ok: false,
          message: `CMSIS-DAP ${method} was cancelled`,
          errorCode: 'RequestCancelled',
          targetState: 'Unknown' as const,
          elapsedMs: 0,
          diagnostics: { ownerKind: this.kind, method },
        };
      }
      return this.helperFailure<TResult>(method, error);
    }
    if (!result.ok) {
      return result as unknown as CppJLinkResult<TResult>;
    }
    if (!result.data) {
      return {
        ok: false,
        message: `CMSIS-DAP ${method} returned no data`,
        errorCode: 'MalformedResponse',
        targetState: 'Error' as const,
        elapsedMs: 0,
        diagnostics: { ownerKind: this.kind, method },
      };
    }
    log.dap(`[cmsis-dap] ${method} address=${params.address ?? ''} size=${params.size ?? params.wordCount ?? ''} ok=true owner=cmsis-dap`);
    return {
      ok: true,
      message: result.message,
      targetState: 'Unknown' as const,
      elapsedMs: result.elapsedMs,
      data: map(result.data),
      diagnostics: result.diagnostics,
    };
  }

  private async controlViaHelper<THelper>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<CppJLinkResult<THelper>> {
    if (this.state !== 'connected') {
      return this.invalidState<THelper>(method);
    }
    let result: CppJLinkResult<THelper>;
    try {
      result = await this.helper.controlRequest<THelper>(method, params);
    } catch (error) {
      if (error instanceof NativeSchedulerCancelledError) {
        return {
          ok: false,
          message: 'CMSIS-DAP ' + method + ' was cancelled',
          errorCode: 'RequestCancelled',
          targetState: 'Unknown',
          elapsedMs: 0,
          diagnostics: { ownerKind: this.kind, method },
        };
      }
      return this.helperFailure<THelper>(method, error);
    }
    log.dll(`[cmsis-dap] control method=${method} ok=${result.ok} errorCode=${result.errorCode || ''} `
      + `targetState=${result.targetState} message=${result.message} `
      + `diagnostics=${JSON.stringify(result.diagnostics || {})} data=${JSON.stringify(result.data || {})}`);
    if (!result.ok) return result;
    if (!result.data) {
      return {
        ok: false,
        message: 'CMSIS-DAP ' + method + ' returned no data',
        errorCode: 'MalformedResponse',
        targetState: 'Error',
        elapsedMs: result.elapsedMs,
        diagnostics: { ownerKind: this.kind, method },
      };
    }
    log.dap('[cmsis-dap] ' + method + ' control=true ok=true owner=cmsis-dap');
    return result;
  }

  private async failAndDispose<T>(result: CppJLinkResult<T>, stage: string): Promise<CppJLinkResult<TargetChannelInfo>> {
    log.dll(`[cmsis-dap] connect failed stage=${stage} code=${result.errorCode || 'Error'} message=${result.message}`);
    this.state = 'failed';
    await this.helper.dispose(false).catch(() => {});
    this.state = 'idle';
    return result as unknown as CppJLinkResult<TargetChannelInfo>;
  }

  private unsupported<T = Record<string, never>>(
    capability: string,
    diagnostics: Record<string, unknown> = {},
  ): CppJLinkResult<T> {
    return failure<T>(
      `CMSIS-DAP helper does not implement ${capability} in DAP-04 (CoreDebug controls and reads only)`,
      'UnsupportedCapability',
      { capability, ownerKind: this.kind, ...diagnostics },
    );
  }
}

function success(message: string): CppJLinkResult {
  return { ok: true, message, targetState: 'Disconnected', elapsedMs: 0, data: {} };
}

function failure<T = Record<string, never>>(
  message: string,
  errorCode: string,
  diagnostics?: Record<string, unknown>,
): CppJLinkResult<T> {
  return { ok: false, message, errorCode, diagnostics, targetState: 'Error', elapsedMs: 0 };
}
