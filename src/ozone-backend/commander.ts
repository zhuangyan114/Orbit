import {
  OzoneCommand, OzoneCommandResult,
  DebugSessionConfig, RegisterValue, Variable,
  StackFrame, MemoryBlock, TargetState, WatchValue,
  FastDataSamplePlanItem, FastDataSampleSpec,
} from './types';
import { cancelActiveFlashes, flashElf } from './flasher';
import { JLinkDLL } from './jlink-dll';
import { SessionTargetOwner, SessionTargetSelector } from './session-target-channel';
import { readElfSymbols, SymbolInfo, preloadLineMappings, preloadAddressMappings, parseDwarfTypeInfo, DwarfInfo, DwarfTypeInfo, DwarfField, OBJDUMP_EXE, LineMappingByFile, resolveMappedStatementAddress } from './jlink-symbols';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { log } from '../utils/logger';
import {
  CppJLinkResult,
  NativeStepExecutor,
  NativeStepIntoDiagnostics,
  NativeStepOverDiagnostics,
  NativeStepOutDiagnostics,
} from './cpp-jlink-channel';

const REG_INDEXES: Record<string, number> = {
  R0: 0, R1: 1, R2: 2, R3: 3, R4: 4, R5: 5, R6: 6, R7: 7,
  R8: 8, R9: 9, R10: 10, R11: 11, R12: 12,
  SP: 13, LR: 14, PC: 15, xPSR: 16,
};

interface NativeStopInfo {
  pcBefore: number;
  pcAfter: number;
  classification: string;
  stopReason: 'step';
  timestamp: number;
  sourceHint?: {
    file: string;
    line: number;
    address: number;
    reason: string;
    rawFile: string;
    rawLine: number;
  };
}

interface WatchEvaluationContext {
  /** Undefined preserves the eager behavior required by standard DAP evaluate/variables. */
  expandedExpressions?: ReadonlySet<string>;
}

interface SourceStatementRange {
  startLine: number;
  endLine: number;
}

export class OzoneBackend {
  private jlink: JLinkDLL = new JLinkDLL();
  private state: TargetState = TargetState.Disconnected;
  private symbols: SymbolInfo[] = [];
  private elfPath = '';
  private lineMapCache: LineMappingByFile = new Map();
  private addressLocCache = new Map<number, { file: string; line: number; func: string }>();
  private lineEntries: { address: number; file: string; line: number }[] = [];
  private sourceStatementRanges = new Map<string, Map<number, SourceStatementRange>>();
  private tempBreakpoint: { index: number; addr: number } | null = null;
  private stepOverClearedBps: { index: number; addr: number }[] = [];
  private _lastTempBpAddr = -1;
  private dwarfInfo: DwarfInfo = { varToType: new Map(), typeDefs: new Map() };
  private runtimeCounterWraps = new Map<string, { lastRaw: number; base: number }>();
  private runtimeTaskCounters = new Map<string, number>();
  private stepProfileSeq = 0;
  private activeStepProfile: { id: number; kind: 'stepOver' | 'stepInto' | 'stepOut'; start: number } | null = null;
  private nativeStepsEnabled = { stepInto: false, stepOver: false, stepOut: false };
  private lastNativeStopInfo: NativeStopInfo | null = null;
  private readonly sessionTarget?: SessionTargetOwner | SessionTargetSelector;
  private readonly sessionBreakpointSlots: (number | null)[] = [null, null, null, null, null, null];

  constructor(
    private readonly nativeStepExecutor?: NativeStepExecutor,
    sessionTarget?: SessionTargetOwner | SessionTargetSelector,
    private readonly localTargetAccessBlocked: () => boolean = () => false,
  ) {
    this.sessionTarget = sessionTarget;
  }

  get currentState(): TargetState {
    return this.state;
  }

  private async targetHalt(): Promise<boolean> {
    if (!this.sessionTarget) return this.jlink.halt();
    const result = await this.sessionTarget.halt();
    return result.ok;
  }

  private async targetRun(): Promise<boolean> {
    if (!this.sessionTarget) return this.jlink.run();
    const result = await this.sessionTarget.run();
    return result.ok;
  }

  private async targetReset(): Promise<boolean> {
    if (!this.sessionTarget) return this.jlink.reset();
    const result = await this.sessionTarget.reset();
    return result.ok;
  }

  private async targetIsHalted(): Promise<boolean> {
    if (!this.sessionTarget) return this.jlink.isHalted();
    const result = await this.sessionTarget.getState();
    return result.ok && result.data?.state === 'Halted';
  }

  private async targetReadRegister(index: number): Promise<number | null> {
    if (!this.sessionTarget) return this.jlink.readRegister(index);
    const result = await this.sessionTarget.readRegister(index);
    return result.ok && result.data ? result.data.value : null;
  }

  private async targetReadMemory(
    address: number,
    size: number,
    priority: 'watch' | 'timeline' = 'watch',
  ): Promise<Uint8Array | null> {
    if (!this.sessionTarget) return this.jlink.readMemory(address, size);
    const result = await this.sessionTarget.readMemory(address, size, { priority });
    return result.ok && result.data ? result.data.bytes : null;
  }

  private async targetWriteMemory(address: number, bytes: Uint8Array): Promise<boolean> {
    if (!this.sessionTarget) return this.jlink.writeMemoryBytes(address, bytes);
    const result = await this.sessionTarget.writeMemory(address, bytes);
    return result.ok && result.data?.bytesWritten === bytes.length;
  }

  private async targetSetBreakpoint(address: number, preferredSlot?: number): Promise<number | null> {
    if (!this.sessionTarget) return this.jlink.setBreakpoint(address, preferredSlot);
    const result = await this.sessionTarget.setBreakpoint(address, preferredSlot);
    if (!result.ok || !result.data) return null;
    this.sessionBreakpointSlots[result.data.id] = address;
    return result.data.id;
  }

  private async targetClearBreakpoint(id: number): Promise<boolean> {
    if (!this.sessionTarget) return this.jlink.clearBreakpoint(id);
    const result = await this.sessionTarget.clearBreakpoint(id);
    if (result.ok && id >= 0 && id < this.sessionBreakpointSlots.length) this.sessionBreakpointSlots[id] = null;
    return result.ok;
  }

  private async targetClearAllBreakpoints(): Promise<boolean> {
    if (!this.sessionTarget) {
      this.jlink.clearAllBreakpoints();
      return true;
    }
    const result = await this.sessionTarget.clearAllBreakpoints();
    if (result.ok) this.sessionBreakpointSlots.fill(null);
    return result.ok;
  }

  private async targetStartRtt(controlBlockAddress?: number): Promise<boolean> {
    if (!this.sessionTarget) return this.jlink.startRtt(controlBlockAddress);
    const result = await this.sessionTarget.startRtt(controlBlockAddress);
    return result.ok;
  }

  private async targetStopRtt(): Promise<boolean> {
    if (!this.sessionTarget) {
      this.jlink.stopRtt();
      return true;
    }
    const result = await this.sessionTarget.stopRtt();
    return result.ok;
  }

  private async targetReadRtt(bufferIndex: number, size: number): Promise<Uint8Array | null> {
    if (!this.sessionTarget) return this.jlink.readRtt(bufferIndex, size);
    const result = await this.sessionTarget.readRtt(bufferIndex, size);
    return result.ok && result.data ? result.data.bytes : null;
  }

  configureNativeSteps(enabled = true): void {
    const nativeReady = enabled && this.nativeStepExecutor?.usingNative === true;
    this.nativeStepsEnabled = {
      stepInto: nativeReady,
      stepOver: nativeReady,
      stepOut: nativeReady,
    };
    if (!Object.values(this.nativeStepsEnabled).some(Boolean)) this.clearNativeStopInfo('native steps disabled');
  }

  async execute(command: OzoneCommand): Promise<OzoneCommandResult> {
    try {
      if (this.localTargetAccessBlocked()
        && command.cmd !== 'disconnect'
        && command.cmd !== 'loadSymbols'
        && command.cmd !== 'prepareFastDataSampling') {
        return { ok: false, error: 'Target access is owned by the active ozone DAP session' };
      }
      switch (command.cmd) {
        case 'connect':
          return await this.doConnect(command.config);
        case 'disconnect':
          return this.doDisconnect();
        case 'halt':
          this.clearNativeStopInfo('legacy halt requested');
          return (await this.targetHalt())
            ? (this.state = TargetState.Halted, { ok: true, data: 'Halted' })
            : { ok: false, error: 'Halt failed' };
        case 'run':
          this.clearNativeStopInfo('legacy run requested');
          return (await this.targetRun())
            ? (this.state = TargetState.Running, { ok: true, data: 'Running' })
            : { ok: false, error: 'Run failed' };
        case 'stepOver':
          return await this.profileStepCommand('stepOver', () => this.doStepOver());
        case 'stepInto':
          return await this.profileStepCommand('stepInto', () => this.doStepInto());
        case 'stepIntoInstruction':
          return await this.doStepIntoInstruction();
        case 'stepOut':
          return await this.profileStepCommand('stepOut', () => this.doStepOut());
        case 'reset':
          this.clearNativeStopInfo('reset requested');
          return (await this.targetReset())
            ? { ok: true, data: 'Reset' }
            : { ok: false, error: 'Reset failed' };
        case 'setBreakpoint':
          return await this.doSetBreakpoint(command.file, command.line, command.condition);
        case 'clearBreakpoint':
          return await this.doClearBreakpoint(command.id);
        case 'clearAllBreakpoints':
          if (!(await this.targetClearAllBreakpoints())) return { ok: false, error: 'Clear all breakpoints failed' };
          this.tempBreakpoint = null;
          this.stepOverClearedBps = [];
          return { ok: true, data: 'All breakpoints cleared' };
        case 'getRegisters':
          return await this.doGetRegisters();
        case 'getLocals':
          return await this.doGetLocals();
        case 'getCallStack':
          return await this.doGetCallStack();
        case 'readMemory':
          return await this.doReadMemory(command.address, command.size);
        case 'readRegister':
          return await this.doReadRegister(command.name);
        case 'getTargetState': {
          if (this.nativeStepExecutor?.usingNative && this.lastNativeStopInfo) {
            log.dap('getTargetState source=nativeStopInfo state=halted');
            return { ok: true, data: TargetState.Halted };
          }
          if (this.sessionTarget) {
            const stateResult = await this.sessionTarget.getState();
            if (!stateResult.ok || !stateResult.data) {
              return {
                ok: false,
                error: `${stateResult.errorCode || 'TargetStateReadFailed'}: ${stateResult.message}`,
                errorCode: stateResult.errorCode || 'TargetStateReadFailed',
              };
            }
            const result = stateResult.data.state === 'Halted'
              ? TargetState.Halted
              : stateResult.data.state === 'Running'
                ? TargetState.Running
                : stateResult.data.state === 'Disconnected'
                  ? TargetState.Disconnected
                  : TargetState.Error;
            log.dap(`getTargetState source=sessionTarget state=${result}`);
            return { ok: true, data: result };
          }
          const halted = this.jlink.isHalted();
          log.dap(`getTargetState source=legacyJLinkDLL halted=${halted}`);
          return { ok: true, data: halted ? TargetState.Halted : this.state };
        }
        case 'flash':
          return await this.doFlash(command.elfPath, command.device, command.interface, command.speedKHz, command.signal);
case 'readVariableRuntime':
          return await this.readVariableAtRuntime(command.name);
        case 'clearBreakpointAtAddr':
          return this.doClearBreakpointAtAddr(command.addr);
        case 'setBreakpointAtAddr':
          return this.doSetBreakpointAtAddr(command.addr);
        case 'evaluateExpression':
          return await this.doEvaluateExpression(
            command.expression,
            command.force,
            command.expandedExpressions === undefined
              ? undefined
              : { expandedExpressions: new Set(command.expandedExpressions) },
          );
        case 'prepareFastDataSampling':
          return { ok: true, data: this.prepareFastDataSampling(command.expressions) };
        case 'readFastDataSampling':
          return { ok: true, data: await this.readFastDataSampling(command.specs) };
        case 'writeMemory':
          return await this.doWriteMemory(command.address, command.data);
        case 'setWatchValue':
          return await this.doSetWatchValue(command.expression, command.value, command.address, command.typeName);
        case 'startRtt':
          return (await this.targetStartRtt(command.controlBlockAddress))
            ? { ok: true, data: 'RTT started' }
            : { ok: false, error: 'RTT start failed' };
        case 'stopRtt':
          return (await this.targetStopRtt())
            ? { ok: true, data: 'RTT stopped' }
            : { ok: false, error: 'RTT stop failed' };
        case 'readRtt': {
          const bytes = await this.targetReadRtt(command.bufferIndex, command.size);
          return bytes
            ? { ok: true, data: { bytes: Array.from(bytes) } }
            : { ok: false, error: 'RTT read failed' };
        }
        case 'loadSymbols':
    if (this.elfPath === command.elfPath && this.symbols.length > 0) {
      return { ok: true, data: `Already loaded ${this.symbols.length} symbols` };
    }
    this.elfPath = command.elfPath;
    this.symbols = await readElfSymbols(command.elfPath);
    this.lineMapCache = await preloadLineMappings(command.elfPath);
    this.sourceStatementRanges.clear();
    const funcAddrs = this.symbols
      .filter(s => s.type === 'T' || s.type === 't')
      .map(s => s.address);
    this.addressLocCache = await preloadAddressMappings(command.elfPath, funcAddrs);

    const fnameToAbs = new Map<string, string>();
    for (const loc of this.addressLocCache.values()) {
      const base = path.basename(loc.file);
      if (base && !fnameToAbs.has(base)) fnameToAbs.set(base, loc.file);
    }
    for (const [addr, loc] of this.addressLocCache) {
      const base = path.basename(loc.file);
      if (base) fnameToAbs.set(base, loc.file);
    }

    this.lineEntries = [];
    for (const [fName, entries] of this.lineMapCache) {
      let resolvedFile: string;
      if (path.isAbsolute(fName) && fs.existsSync(fName)) {
        resolvedFile = fName;
      } else if (fnameToAbs.has(fName)) {
        resolvedFile = fnameToAbs.get(fName)!;
      } else {
        const base = path.basename(fName);
        if (fnameToAbs.has(base)) {
          resolvedFile = fnameToAbs.get(base)!;
        } else {
          const elfDir = path.dirname(command.elfPath);
          resolvedFile = path.resolve(elfDir, fName);
        }
      }
      for (const entry of entries) {
        if (entry.isStatement && entry.address >= 0x08000000 && entry.address < 0x20100000) {
          this.lineEntries.push({ address: entry.address, file: resolvedFile, line: entry.line });
        }
      }
    }
    this.lineEntries.sort((a, b) => a.address - b.address);
    this.dwarfInfo = await parseDwarfTypeInfo(command.elfPath);
    return { ok: true, data: `Loaded ${this.symbols.length} symbols` };
        default:
          return { ok: false, error: `Unsupported command: ${(command as any).cmd}` };
      }
    } catch (err: any) {
      this.state = TargetState.Error;
      return { ok: false, error: err.message ?? String(err) };
    }
  }

  private async profileStepCommand(
    kind: 'stepOver' | 'stepInto' | 'stepOut',
    run: () => Promise<OzoneCommandResult>,
  ): Promise<OzoneCommandResult> {
    const profile = { id: ++this.stepProfileSeq, kind, start: Date.now() };
    this.activeStepProfile = profile;
    log.step(`[profile#${profile.id}] ${kind} begin`);
    try {
      const result = await run();
      log.step(`[profile#${profile.id}] ${kind} total=${Date.now() - profile.start}ms ok=${result.ok}${result.ok ? '' : ` error=${result.error}`}`);
      return result;
    } finally {
      if (this.activeStepProfile?.id === profile.id) this.activeStepProfile = null;
    }
  }

  private stepProfileMark(segment: string, startedAt: number, detail = ''): void {
    if (!this.activeStepProfile) return;
    const suffix = detail ? ` ${detail}` : '';
    log.step(`[profile#${this.activeStepProfile.id}] ${segment}=${Date.now() - startedAt}ms${suffix}`);
  }

  private async doConnect(config: DebugSessionConfig): Promise<OzoneCommandResult> {
    this.clearNativeStopInfo('new connect');
    if (this.state === TargetState.Connected) {
      return { ok: true, data: { state: TargetState.Connected } };
    }
    const nativeMode = config.nativeDebugEngineMode === 'native'
      ? 'native'
      : config.nativeDebugEngineMode === 'auto'
        ? config.nativeDebugEngineEnabled === true ? 'auto' : 'legacy'
        : config.nativeDebugEngineMode === undefined && config.nativeDebugEngineEnabled === true
          ? 'auto'
          : 'legacy';
    if (this.sessionTarget) {
      const connected = this.sessionTarget instanceof SessionTargetSelector
        ? await this.sessionTarget.connect(config, nativeMode)
        : await this.sessionTarget.connect(config);
      if (!connected.ok) return { ok: false, error: connected.message };
    } else {
      if (!this.jlink.open()) return { ok: false, error: 'Failed to load JLink DLL' };
      if (!this.jlink.connect(config.device, config.speedKHz)) {
        this.jlink.close();
        return { ok: false, error: `Failed to connect to ${config.device}` };
      }
    }

    this.configureNativeSteps();
    if (config.nativeDebugEngineEnabled && !this.nativeStepExecutor?.usingNative) {
      log.step('Native step paths requested but no connected exclusive native executor is available; using legacy paths');
    }
    if (!(await this.targetHalt())) {
      if (this.sessionTarget) await this.sessionTarget.dispose(false);
      return { ok: false, error: 'Connected target could not be halted' };
    }
    if (!(await this.targetClearAllBreakpoints())) {
      if (this.sessionTarget) await this.sessionTarget.dispose(false);
      return { ok: false, error: 'Connected target breakpoints could not be initialized' };
    }

    this.state = TargetState.Connected;

    return { ok: true, data: { state: TargetState.Connected } };
  }

  private async doDisconnect(): Promise<OzoneCommandResult> {
    this.clearNativeStopInfo('disconnect');
    if (this.state === TargetState.Disconnected) {
      return { ok: true, data: null };
    }
    if (this.sessionTarget) {
      const disconnected = await this.sessionTarget.disconnect();
      await this.sessionTarget.dispose();
      if (!disconnected.ok) {
        this.state = TargetState.Error;
        return { ok: false, error: `${disconnected.errorCode || 'DisconnectFailed'}: ${disconnected.message}` };
      }
    } else {
      this.jlink.disconnect();
    }
    this.state = TargetState.Disconnected;
    this.symbols = [];
    this.lineMapCache.clear();
    this.addressLocCache.clear();
    this.lineEntries = [];
    this.sourceStatementRanges.clear();
    this.runtimeCounterWraps.clear();
    this.runtimeTaskCounters.clear();
    return { ok: true, data: null };
  }

  private async doSetBreakpoint(file: string, line: number, condition?: string): Promise<OzoneCommandResult> {
    log.step(`setBreakpoint ${file}:${line} elfPath=${this.elfPath} cacheSize=${this.lineMapCache.size}`);
    const addr = await this.resolveLineAddress(file, line);
    log.step(`setBreakpoint resolved addr=${addr}`);
    if (addr === null) return { ok: false, error: `Cannot resolve ${file}:${line}` };
    if (addr < 0x08000000 || addr >= 0x20100000) return { ok: false, error: `Resolved address 0x${addr.toString(16)} for ${file}:${line} is outside valid flash range` };
    log.step(`resolved ${file}:${line} → 0x${addr.toString(16).toUpperCase()}`);
    log.step(`setBreakpoint calling target.setBreakpoint(${addr.toString(16)})`);
    const bpIndex = await this.targetSetBreakpoint(addr);
    log.step(`setBreakpoint target result=${bpIndex}`);
    if (bpIndex === null) return { ok: false, error: `Failed to set breakpoint at 0x${addr.toString(16)}` };
    log.step(`breakpoint set, index=${bpIndex}`);
    return { ok: true, data: { id: bpIndex, address: addr } };
  }

  private async doClearBreakpoint(id: number): Promise<OzoneCommandResult> {
    log.step(`doClearBreakpoint id=${id}`);
    const result = await this.targetClearBreakpoint(id);
    log.step(`doClearBreakpoint result=${result}`);
    return result
      ? { ok: true, data: null }
      : { ok: false, error: 'Failed to clear breakpoint' };
  }

  private async doClearBreakpointAtAddr(addr: number): Promise<OzoneCommandResult> {
    const index = this.currentBreakpointSlots().indexOf(addr);
    if (index >= 0 && await this.targetClearBreakpoint(index)) {
      return { ok: true, data: { index } };
    }
    return { ok: false, error: `No breakpoint at 0x${addr.toString(16)}` };
  }

  private async doSetBreakpointAtAddr(addr: number): Promise<OzoneCommandResult> {
    const index = await this.targetSetBreakpoint(addr);
    if (index !== null) {
      return { ok: true, data: { id: index, address: addr } };
    }
    return { ok: false, error: `Failed to set breakpoint at 0x${addr.toString(16)}` };
  }

  private async doGetRegisters(): Promise<OzoneCommandResult> {
    const isHalted = this.nativeStepExecutor?.usingNative && this.lastNativeStopInfo
      ? true
      : await this.targetIsHalted();
    if (!isHalted) {
      return { ok: true, data: [] };
    }
    const registers: RegisterValue[] = [];

    for (const [name, idx] of Object.entries(REG_INDEXES)) {
      const val = await this.readRegisterValue(idx, name);
      if (val !== null) {
        registers.push({
          name,
          value: val,
          hex: `0x${val.toString(16).toUpperCase().padStart(8, '0')}`,
        });
      }
    }

    return { ok: true, data: registers };
  }

  private async doReadRegister(name: string): Promise<OzoneCommandResult> {
    const idx = REG_INDEXES[name.toUpperCase()];
    if (idx === undefined) return { ok: false, error: `Unknown register: ${name}` };
    const nativeOwner = this.nativeStepExecutor?.usingNative === true;
    if (nativeOwner && this.lastNativeStopInfo) {
      const val = await this.readRegisterValue(idx, name);
      if (val !== null) {
        return {
          ok: true,
          data: { name: name.toUpperCase(), value: val, hex: `0x${val.toString(16).toUpperCase().padStart(8, '0')}` },
        };
      }
      return { ok: false, error: `Native register read failed: ${name}` };
    }
    if (!(await this.targetIsHalted())) {
      const halted = await this.ensureHalted();
      if (!halted) return { ok: false, error: 'Failed to halt CPU for register read' };
    }
    await new Promise<void>(r => setTimeout(r, 100));
    const val = await this.targetReadRegister(idx);
    log.dap(`readRegister ${name.toUpperCase()} source=sessionTarget value=${val === null ? 'null' : `0x${val.toString(16)}`}`);
    if (val === null) return { ok: false, error: `Failed to read ${name}` };
    return { ok: true, data: { name, value: val, hex: `0x${val.toString(16).toUpperCase().padStart(8, '0')}` } };
  }

  private async doGetLocals(): Promise<OzoneCommandResult> {
    const isHalted = await this.targetIsHalted();
    if (!isHalted) {
      return { ok: true, data: [] };
    }
    const variables: Variable[] = [];
    const localSymbols = this.symbols.filter(s =>
      s.type === 'd' || s.type === 'D' || s.type === 'B' || s.type === 'b'
    );

    for (const sym of localSymbols.slice(0, 50)) {
      const varTypeOffset = this.dwarfInfo.varToType.get(sym.name);
      const resolvedType = varTypeOffset ? this.resolveDwarfType(varTypeOffset) : null;
      const readSize = this.getScalarReadSize(sym.size, resolvedType);
      const raw = await this.targetReadMemory(sym.address, readSize);
      let value: string;
      if (raw) {
        value = this.formatScalarValue(raw, readSize, resolvedType).display;
      } else {
        value = `0x${sym.address.toString(16).toUpperCase()}`;
      }
      variables.push({
        name: sym.name,
        type: sym.type,
        value,
        address: sym.address,
      });
    }

    return { ok: true, data: variables };
  }

  private async doGetCallStack(): Promise<OzoneCommandResult> {
    // Wait for CPU to halt if not already halted
    const nativeOwner = this.nativeStepExecutor?.usingNative === true;
    let isHalted = nativeOwner && this.lastNativeStopInfo ? true : await this.targetIsHalted();
    log.step(`doGetCallStack: isHalted=${isHalted}`);
    if (!isHalted) {
      for (let i = 0; i < 20; i++) {
        await new Promise<void>(r => setTimeout(r, 50));
        isHalted = nativeOwner && this.lastNativeStopInfo ? true : await this.targetIsHalted();
        if (isHalted) break;
      }
    }
    if (!isHalted) {
      return { ok: true, data: [] };
    }
    await new Promise<void>(r => setTimeout(r, 100));

    let pc = nativeOwner && this.lastNativeStopInfo
      ? await this.readRegisterValue(REG_INDEXES.PC, 'PC')
      : await this.targetReadRegister(REG_INDEXES.PC);
    let lr = nativeOwner && this.lastNativeStopInfo
      ? await this.readRegisterValue(REG_INDEXES.LR, 'LR')
      : await this.targetReadRegister(REG_INDEXES.LR);

    // Retry LR with DAP as readRegister now auto-fallsback to DAP,
    // but also try once more after a small delay for robustness
    if (pc !== null && lr === null) {
      await new Promise<void>(r => setTimeout(r, 50));
      lr = nativeOwner && this.lastNativeStopInfo
        ? await this.readRegisterValue(REG_INDEXES.LR, 'LR')
        : await this.targetReadRegister(REG_INDEXES.LR);
    }

    log.dap(`getCallStack PC source=${nativeOwner && this.lastNativeStopInfo ? 'nativeStopInfo/helper' : 'legacyJLinkDLL'} pc=${pc === null ? 'null' : `0x${pc.toString(16)}`}`);
    log.step(`doGetCallStack pc=${pc !== null ? '0x' + pc.toString(16) : 'null'} lr=${lr !== null ? '0x' + lr.toString(16) : 'null'}`);

    if (pc === null) {
      process.stderr.write(`[OzoneBackend-DIAG] doGetCallStack: PC read failed (isHalted=${isHalted})\n`);
      return { ok: false, error: 'Cannot read core registers (PC)' };
    }

    // If LR still fails, use a fallback value so we can deliver at least one frame
    if (lr === null) {
      process.stderr.write(`[OzoneBackend-DIAG] doGetCallStack: LR read failed, using fallback (isHalted=${isHalted} pc=0x${pc.toString(16)})\n`);
      lr = 0xFFFFFFFF;
    }

    const frames: StackFrame[] = [];
    let frameIdCounter = 1;

    const sourceHint = nativeOwner && this.lastNativeStopInfo?.pcAfter === pc
      ? this.lastNativeStopInfo.sourceHint
      : undefined;
    const pcLoc = sourceHint
      ? { file: sourceHint.file, line: sourceHint.line, func: this.resolveSymbolName(pc) || `0x${pc.toString(16)}` }
      : this.resolveAddressLoc(pc);
    log.step(
      `stackTrace frame0 pc=0x${pc.toString(16)} pcSource=${nativeOwner && this.lastNativeStopInfo ? 'native' : 'legacy'}`
      + ` sourceSource=${sourceHint ? sourceHint.reason : 'addressMapping'}`
      + ` source=${pcLoc?.file || 'unknown'}:${pcLoc?.line || 0}`,
    );
    frames.push({
      id: frameIdCounter++, level: 0,
      function: pcLoc?.func || this.resolveSymbolName(pc) || `0x${pc.toString(16)}`,
      file: pcLoc?.file || '',
      line: pcLoc?.line || 0,
      address: pc,
    });

    if (lr !== 0xFFFFFFFF) {
      const lrLoc = this.resolveAddressLoc(lr);
      frames.push({
        id: frameIdCounter++, level: 1,
        function: lrLoc?.func || this.resolveSymbolName(lr) || `0x${lr.toString(16)}`,
        file: lrLoc?.file || '',
        line: lrLoc?.line || 0,
        address: lr,
      });
    }

    return { ok: true, data: frames };
  }

  private async readRegisterValue(index: number, name: string): Promise<number | null> {
    const nativeOwner = this.nativeStepExecutor?.usingNative === true;
    if (nativeOwner && this.nativeStepExecutor?.readRegister) {
      try {
        const result = await this.nativeStepExecutor.readRegister(index);
        if (result.ok && result.data) {
          log.dap(`readRegister ${name} source=nativeHelper value=0x${result.data.value.toString(16)}`);
          return result.data.value >>> 0;
        }
      } catch (error) {
        log.dap(`readRegister ${name} source=nativeHelper exception=${error instanceof Error ? error.message : String(error)}`);
      }
      if (index === REG_INDEXES.PC && this.lastNativeStopInfo) {
        log.dap(`readRegister ${name} source=nativeStopInfo value=0x${this.lastNativeStopInfo.pcAfter.toString(16)}`);
        return this.lastNativeStopInfo.pcAfter >>> 0;
      }
      log.dap(`readRegister ${name} source=nativeHelper failed`);
      return null;
    }
    const value = await this.targetReadRegister(index);
    log.dap(`readRegister ${name} source=sessionTarget value=${value === null ? 'null' : `0x${value.toString(16)}`}`);
    return value;
  }

  private recordNativeStop(
    diagnostics: { pcBefore: number; pcAfter: number; classification: string },
    sourceHint?: NativeStopInfo['sourceHint'],
  ): void {
    this.lastNativeStopInfo = {
      pcBefore: diagnostics.pcBefore >>> 0,
      pcAfter: diagnostics.pcAfter >>> 0,
      classification: diagnostics.classification,
      stopReason: 'step',
      timestamp: Date.now(),
      sourceHint,
    };
    log.dap(`native step success pcBefore=0x${diagnostics.pcBefore.toString(16)} pcAfter=0x${diagnostics.pcAfter.toString(16)} classification=${diagnostics.classification} targetState=halted`);
  }

  private clearNativeStopInfo(reason: string): void {
    if (!this.lastNativeStopInfo) return;
    log.dap(`clear native stop info reason=${reason} pcAfter=0x${this.lastNativeStopInfo.pcAfter.toString(16)}`);
    this.lastNativeStopInfo = null;
  }

  private async ensureHalted(): Promise<boolean> {
    await this.targetHalt();
    const immediate = await this.targetIsHalted();
    log.step(`ensureHalted: immediate=${immediate}`);
    if (immediate) return true;
    for (let i = 0; i < 10; i++) {
      await new Promise<void>(r => setTimeout(r, 50));
      const check = await this.targetIsHalted();
      log.step(`ensureHalted: poll ${i + 1} isHalted=${check}`);
      if (check) return true;
    }
    log.step('ensureHalted: timeout waiting for halt');
    return false;
  }

  private async cleanupStepBreakpoints(): Promise<void> {
    const tCleanup = Date.now();
    const clearedBpCount = this.stepOverClearedBps.length;
    log.step(`cleanupStepBreakpoints: tempBp=${this.tempBreakpoint ? `${this.tempBreakpoint.index}@0x${this.tempBreakpoint.addr.toString(16)}` : 'null'} clearedBps=${this.stepOverClearedBps.length}`);
    if (this.tempBreakpoint) {
      this._lastTempBpAddr = this.tempBreakpoint.addr;
      await this.targetClearBreakpoint(this.tempBreakpoint.index);
      this.tempBreakpoint = null;
    }
    await this.restoreClearedBps();
    this.stepProfileMark('cleanupBreakpoint', tCleanup, `clearedBps=${clearedBpCount}`);
  }

  private async restoreClearedBps(): Promise<void> {
    if (this.stepOverClearedBps.length > 0) {
      log.step(`restoreClearedBps: restoring ${this.stepOverClearedBps.length} breakpoints`);
    }
    for (const bp of this.stepOverClearedBps) {
      const setOk = await this.targetSetBreakpoint(bp.addr, bp.index);
      log.step(`restoreClearedBps: addr=0x${bp.addr.toString(16)} origSlot=${bp.index} newSlot=${setOk}`);
    }
    this.stepOverClearedBps = [];
  }

  private async clearCurrentBpAndTrack(pc: number): Promise<void> {
    const slots = this.currentBreakpointSlots();
    let cleared = 0;
    for (let i = 0; i < slots.length; i++) {
      if (slots[i] === pc) {
        if (await this.targetClearBreakpoint(i)) {
          this.stepOverClearedBps.push({ index: i, addr: pc });
          cleared++;
        }
      }
    }
    log.step(`clearCurrentBpAndTrack: pc=0x${pc.toString(16)} cleared=${cleared} tracked=${this.stepOverClearedBps.length}`);
  }

  private async doStepInto(): Promise<OzoneCommandResult> {
    if (this.nativeStepsEnabled.stepInto && this.nativeStepExecutor?.usingNative) {
      const pc = await this.readRegisterValue(REG_INDEXES.PC, 'PC');
      if (pc === null) return { ok: false, error: 'StepIntoReadPcFailed: cannot read PC for native source step into' };
      const bounds = this.resolveNativeLineBounds(pc);
      const startLoc = this.resolveAddressLoc(pc);
      log.step(
        `stepInto phase=prepare pc=0x${pc.toString(16)} lineRange=${bounds
          ? `0x${bounds.start.toString(16)}..0x${bounds.end.toString(16)}`
          : 'unavailable'}`,
      );
      const result = await this.executeNativeStep('stepInto', () => this.nativeStepExecutor!.stepIntoSourceLine({
        lineStart: bounds?.start,
        lineEnd: bounds?.end,
        maxInstructionSteps: 32,
      }));
      if (!result.ok || !startLoc || !bounds) return result;

      const firstStep = result.data as { classification?: string; pcAfter?: number } | undefined;
      const pcAfter = firstStep?.pcAfter;
      if (firstStep?.classification !== 'sourceBoundary' || typeof pcAfter !== 'number') return result;
      const afterLoc = this.resolveAddressLoc(pcAfter);
      if (!afterLoc
          || afterLoc.file !== startLoc.file
          || afterLoc.line !== startLoc.line) {
        return result;
      }

      const continuationBounds = this.resolveNativeLineBounds(pcAfter);
      if (!continuationBounds || continuationBounds.start === bounds.start) return result;
      log.step(
        `stepInto phase=continueLoopHeader pc=0x${pcAfter.toString(16)}`
        + ` lineRange=0x${continuationBounds.start.toString(16)}..0x${continuationBounds.end.toString(16)}`,
      );
      return this.executeNativeStep('stepInto', () => this.nativeStepExecutor!.stepIntoSourceLine({
        lineStart: continuationBounds.start,
        lineEnd: continuationBounds.end,
        maxInstructionSteps: 32,
      }));
    }
    this.clearNativeStopInfo('stepInto using legacy path');
    return this.doStepIntoLegacy();
  }

  private async doStepIntoInstruction(): Promise<OzoneCommandResult> {
    if (this.nativeStepsEnabled.stepInto && this.nativeStepExecutor?.usingNative) {
      return this.executeNativeStep('stepInto', () => this.nativeStepExecutor!.stepIntoInstruction());
    }
    this.clearNativeStopInfo('instruction step using legacy path');
    return this.doSingleStep();
  }

  private async doStepIntoLegacy(): Promise<OzoneCommandResult> {
    const haltedBefore = await this.ensureHalted();
    if (!haltedBefore) return { ok: false, error: 'Cannot halt CPU for step into' };
    await new Promise<void>(r => setTimeout(r, 20));
    await this.cleanupStepBreakpoints();
    const tReadPc = Date.now();
    const pc = await this.targetReadRegister(REG_INDEXES.PC);
    this.stepProfileMark('read PC', tReadPc, `pc=0x${(pc ?? 0).toString(16)}`);
    if (pc === null) return { ok: false, error: 'Cannot read PC' };

    const tReadMemory = Date.now();
    let raw = await this.targetReadMemory(pc, 4);
    if (!raw || raw.length < 4) {
      await new Promise<void>(r => setTimeout(r, 10));
      raw = await this.targetReadMemory(pc, 4);
    }
    this.stepProfileMark('readMemory', tReadMemory, `addr=0x${pc.toString(16)} size=4 bytes=${raw?.length ?? 0}`);

    let hw1 = 0, hw2 = 0;
    if (raw && raw.length >= 2) {
      hw1 = (raw[1] << 8) | raw[0];
      if (raw.length >= 4) hw2 = (raw[3] << 8) | raw[2];
    }

    const isBL = (hw1 & 0xF800) === 0xF000 && (hw2 & 0xD000) === 0xD000;
    const isBLX = (hw1 & 0xF800) === 0xF000 && (hw2 & 0xD000) === 0x8000;
    const isBLXReg = (hw1 & 0xFF87) === 0x4780;

    await this.clearCurrentBpAndTrack(pc);

    if (isBL || isBLX) {
      const S = (hw1 >> 10) & 1;
      const J1 = (hw2 >> 14) & 1;
      const J2 = (hw2 >> 12) & 1;
      const I1 = (~(J1 ^ S)) & 1;
      const I2 = (~(J2 ^ S)) & 1;
      const imm10 = hw1 & 0x3FF;
      const imm11 = hw2 & 0x7FF;
      let imm32 = (S << 24) | (I1 << 23) | (I2 << 22) | (imm10 << 12) | (imm11 << 1);
      if (imm32 & 0x01000000) imm32 |= 0xFE000000;
      let target = ((pc + 4) + imm32) >>> 0;
      if (isBLX) target = (target & ~3) >>> 0;
      return this.setTempBpAndRun(target);
    }

    if (isBLXReg) {
      const rmIndex = (hw1 >> 3) & 0xF;
      const rmVal = await this.targetReadRegister(rmIndex);
      if (rmVal === null) return await this.doSingleStep();
      const target = (rmVal & ~1) >>> 0;
      return this.setTempBpAndRun(target);
    }

    const startLoc = this.resolveAddressLoc(pc);
    if (startLoc) {
      for (let i = 0; i < 20; i++) {
        const stepResult = await this.doSingleStep();
        if (!stepResult.ok) return stepResult;

        const newPc = await this.targetReadRegister(REG_INDEXES.PC);
        if (newPc === null) return { ok: false, error: 'Cannot read PC after single step' };

        const newLoc = this.resolveAddressLoc(newPc);
        if (!newLoc || newLoc.file !== startLoc.file || newLoc.line !== startLoc.line) {
          await this.restoreClearedBps();
          return { ok: true, data: 'Stepped' };
        }

        const raw = await this.targetReadMemory(newPc, 4);
        if (!raw || raw.length < 4) continue;

        const hw1 = (raw[1] << 8) | raw[0];
        const hw2 = (raw[3] << 8) | raw[2];

        const isBL = (hw1 & 0xF800) === 0xF000 && (hw2 & 0xD000) === 0xD000;
        const isBLX = (hw1 & 0xF800) === 0xF000 && (hw2 & 0xD000) === 0x8000;
        const isBLXReg = (hw1 & 0xFF87) === 0x4780;

        if (isBL || isBLX) {
          const S = (hw1 >> 10) & 1;
          const J1 = (hw2 >> 14) & 1;
          const J2 = (hw2 >> 12) & 1;
          const I1 = (~(J1 ^ S)) & 1;
          const I2 = (~(J2 ^ S)) & 1;
          const imm10 = hw1 & 0x3FF;
          const imm11 = hw2 & 0x7FF;
          let imm32 = (S << 24) | (I1 << 23) | (I2 << 22) | (imm10 << 12) | (imm11 << 1);
          if (imm32 & 0x01000000) imm32 |= 0xFE000000;
          let target = ((newPc + 4) + imm32) >>> 0;
          if (isBLX) target = (target & ~3) >>> 0;
          return this.setTempBpAndRun(target);
        }

        if (isBLXReg) {
          const rmIndex = (hw1 >> 3) & 0xF;
          const rmVal = await this.targetReadRegister(rmIndex);
          if (rmVal === null) continue;
          const target = (rmVal & ~1) >>> 0;
          return this.setTempBpAndRun(target);
        }
      }
    }
    await this.restoreClearedBps();
    return await this.doSingleStep();
  }

  private async doStepOut(): Promise<OzoneCommandResult> {
    if (this.nativeStepsEnabled.stepOut && this.nativeStepExecutor?.usingNative) {
      const pcStarted = Date.now();
      const pc = await this.readRegisterValue(REG_INDEXES.PC, 'PC');
      this.stepProfileMark('native prepare PC', pcStarted, `pc=0x${(pc ?? 0).toString(16)}`);
      if (pc === null) return { ok: false, error: 'StepOutReadPcFailed: cannot read PC for native step out' };
      const functionRange = this.resolveFunctionRange(pc);
      if (!functionRange) {
        return { ok: false, error: `StepOutFunctionRangeUnavailable: no function contains PC 0x${pc.toString(16)}` };
      }
      return this.executeNativeStep('stepOut', () => this.nativeStepExecutor!.stepOut({
        functionStart: functionRange.start,
        functionEnd: functionRange.end,
        waitTimeoutMs: 1000,
        breakpoints: this.snapshotBreakpoints(),
      }));
    }
    this.clearNativeStopInfo('stepOut using legacy path');
    return this.doStepOutLegacy();
  }

  private async doStepOutLegacy(): Promise<OzoneCommandResult> {
    const haltedBefore = await this.ensureHalted();
    if (!haltedBefore) return { ok: false, error: 'Cannot halt CPU for step out' };
    await new Promise<void>(r => setTimeout(r, 20));
    await this.cleanupStepBreakpoints();
    const tReadPc = Date.now();
    const pc = await this.targetReadRegister(REG_INDEXES.PC);
    const lr = await this.targetReadRegister(REG_INDEXES.LR);
    this.stepProfileMark('read PC', tReadPc, `pc=0x${(pc ?? 0).toString(16)} lr=0x${(lr ?? 0).toString(16)}`);
    if (pc === null || lr === null) return { ok: false, error: 'Cannot read PC/LR' };
    if (lr === 0xFFFFFFFF || (lr & 0xF0000000) === 0xF0000000) {
      await this.clearCurrentBpAndTrack(pc);
      return await this.doSingleStep();
    }
    const returnAddr = (lr & ~1) >>> 0;
    await this.clearCurrentBpAndTrack(pc);
    const result = await this.setTempBpAndRun(returnAddr);
    if (!(await this.targetIsHalted())) {
      await this.targetHalt();
      await new Promise<void>(r => setTimeout(r, 100));
      if (await this.targetIsHalted()) {
        return { ok: true, data: 'Stepped' };
      }
      return await this.doSingleStep();
    }
    return result;
  }

  private async doStepOver(): Promise<OzoneCommandResult> {
    if (!this.nativeStepsEnabled.stepOver || !this.nativeStepExecutor?.usingNative) {
      this.clearNativeStopInfo('stepOver using legacy path');
      return this.doStepOverLegacy();
    }

    const pcStarted = Date.now();
    const pc = await this.readRegisterValue(REG_INDEXES.PC, 'PC');
    this.stepProfileMark('native prepare PC', pcStarted, `pc=0x${(pc ?? 0).toString(16)}`);
    if (pc === null) return { ok: false, error: 'Cannot read PC for native step over' };
    const bounds = this.resolveNativeLineBounds(pc);
    const startLoc = this.resolveAddressLoc(pc);
    const nativeStarted = Date.now();
    const result = await this.nativeStepExecutor.stepOverSourceLine({
      lineStart: bounds?.start,
      lineEnd: bounds?.end,
      waitTimeoutMs: 1000,
      // A single source line can contain a compact loop body. Keep the step
      // bounded, but allow enough instructions to complete its iterations.
      maxInstructionSteps: 128,
      breakpoints: this.snapshotBreakpoints(),
    });
    const completed = this.completeNativeStepOver(result, nativeStarted);
    if (!completed.ok || !bounds || !startLoc || !result.data) return completed;

    const diagnostics = result.data;
    const afterLoc = this.resolveAddressLoc(diagnostics.pcAfter);
    const beforeFunctionRange = this.resolveFunctionRange(diagnostics.pcBefore);
    const afterFunctionRange = this.resolveFunctionRange(diagnostics.pcAfter);
    const crossedFunctionBoundary = Boolean(
      beforeFunctionRange
      && (!afterFunctionRange
        || beforeFunctionRange.start !== afterFunctionRange.start
        || beforeFunctionRange.end !== afterFunctionRange.end),
    );
    const returnedToCallLine = afterLoc
      ? this.isReturnAddressOnSourceLine(diagnostics.pcAfter, afterLoc)
      : false;
    const shouldContinue = (diagnostics.classification === 'singleStep' || diagnostics.classification === 'branchSingleStep')
      && (
        (afterLoc?.file === startLoc.file && afterLoc.line === startLoc.line)
        || (crossedFunctionBoundary && returnedToCallLine)
      );
    if (!shouldContinue) return completed;

    const continuationBounds = this.resolveNativeLineBounds(diagnostics.pcAfter);
    if (!continuationBounds || (!crossedFunctionBoundary && continuationBounds.start === bounds.start)) return completed;
    log.step(
      `stepOver phase=${crossedFunctionBoundary ? 'continueAfterFunctionReturn' : 'continueLoopHeader'}`
      + ` pc=0x${diagnostics.pcAfter.toString(16)}`
      + ` lineRange=0x${continuationBounds.start.toString(16)}..0x${continuationBounds.end.toString(16)}`,
    );
    const continuationStarted = Date.now();
    const continuation = await this.nativeStepExecutor.stepOverSourceLine({
      lineStart: continuationBounds.start,
      lineEnd: continuationBounds.end,
      waitTimeoutMs: 1000,
      maxInstructionSteps: 128,
      breakpoints: this.snapshotBreakpoints(),
    });
    return this.completeNativeStepOver(continuation, continuationStarted);
  }

  private completeNativeStepOver(
    result: CppJLinkResult<NativeStepOverDiagnostics>,
    nativeStarted: number,
  ): OzoneCommandResult {
    const diagnostics = result.data;
    this.stepProfileMark(
      'native state machine',
      nativeStarted,
      diagnostics
        ? `class=${diagnostics.classification} pc=0x${diagnostics.pcBefore.toString(16)}->0x${diagnostics.pcAfter.toString(16)} instructions=${diagnostics.instructions} segments=${JSON.stringify(diagnostics.timings)} cleanup=${diagnostics.cleanupOk}`
        : `errorCode=${result.errorCode || 'unknown'} message=${result.message}`,
    );
    if (!result.ok) {
      this.clearNativeStopInfo('native stepOver failed or fell back');
      return { ok: false, error: `${result.errorCode || 'NativeStepOverFailed'}: ${result.message}` };
    }
    if (result.targetState !== 'Halted') {
      this.clearNativeStopInfo('native stepOver returned non-halted state');
      return { ok: false, error: `NativeStepOverStateInvalid: expected Halted, got ${result.targetState}` };
    }
    this.state = TargetState.Halted;
    if (diagnostics) this.recordNativeStop(diagnostics);
    return { ok: true, data: { mode: 'native', helperElapsedMs: result.elapsedMs, ...diagnostics } };
  }

  private snapshotBreakpoints(): Record<string, number> {
    return Object.fromEntries(
      this.currentBreakpointSlots()
        .map((address, slot) => address === null ? null : [String(slot), address] as const)
        .filter((entry): entry is readonly [string, number] => entry !== null),
    );
  }

  private currentBreakpointSlots(): readonly (number | null)[] {
    return this.sessionTarget ? this.sessionBreakpointSlots : this.jlink.breakpointSlots;
  }

  private async executeNativeStep(
    kind: 'stepInto' | 'stepOut',
    run: () => Promise<CppJLinkResult<NativeStepIntoDiagnostics | NativeStepOutDiagnostics>>,
  ): Promise<OzoneCommandResult> {
    const nativeStarted = Date.now();
    const result = await run();
    const diagnostics = result.data;
    this.stepProfileMark(
      'native state machine',
      nativeStarted,
      diagnostics
        ? `kind=${kind} class=${diagnostics.classification} pc=0x${diagnostics.pcBefore.toString(16)}->0x${diagnostics.pcAfter.toString(16)} segments=${JSON.stringify(diagnostics.timings)} cleanup=${diagnostics.cleanupOk}`
        : `kind=${kind} errorCode=${result.errorCode || 'unknown'} message=${result.message}`,
    );
    if (kind === 'stepInto' && diagnostics && 'trace' in diagnostics && diagnostics.trace) {
      for (const [index, entry] of diagnostics.trace.entries()) {
        log.step(
          `stepInto phase=sameLineInstruction index=${index + 1} pc=0x${entry.pc.toString(16)}`
          + ` instructionClass=${entry.classification} call=${entry.call}`,
        );
      }
      log.step(
        `stepInto phase=complete classification=${diagnostics.classification}`
        + ` pcAfter=0x${diagnostics.pcAfter.toString(16)} instructions=${diagnostics.instructions}`,
      );
    }
    if (!result.ok) {
      this.clearNativeStopInfo(`native ${kind} failed or fell back`);
      return { ok: false, error: `${result.errorCode || `Native${kind}Failed`}: ${result.message}` };
    }
    if (result.targetState !== 'Halted') {
      this.clearNativeStopInfo(`native ${kind} returned non-halted state`);
      return { ok: false, error: `Native${kind}StateInvalid: expected Halted, got ${result.targetState}` };
    }
    this.state = TargetState.Halted;
    const sourceHint = kind === 'stepOut' && diagnostics
      ? this.resolveStepOutSourceHint(diagnostics as NativeStepOutDiagnostics)
      : null;
    if (diagnostics) this.recordNativeStop(diagnostics, sourceHint || undefined);
    return {
      ok: true,
      data: {
        mode: 'native',
        helperElapsedMs: result.elapsedMs,
        ...diagnostics,
        ...(sourceHint ? {
          sourceAdjustReason: sourceHint.reason,
          rawSourceLoc: { file: sourceHint.rawFile, line: sourceHint.rawLine },
          adjustedSourceLoc: { file: sourceHint.file, line: sourceHint.line, address: sourceHint.address },
        } : {}),
      },
    };
  }

  private resolveStepOutSourceHint(diagnostics: NativeStepOutDiagnostics): NativeStopInfo['sourceHint'] | null {
    const pcAfter = diagnostics.pcAfter >>> 0;
    const raw = this.resolveAddressLoc(pcAfter);
    if (!raw) {
      log.step(
        `stepOut returnAddress=0x${diagnostics.returnAddress.toString(16)} pcAfter=0x${pcAfter.toString(16)}`
        + ' rawSourceLoc=unavailable adjustedSourceLoc=none',
      );
      return null;
    }

    const stillOnCallLine = this.isReturnAddressOnSourceLine(pcAfter, raw);
    const callerRange = this.resolveFunctionRange(pcAfter);
    const next = stillOnCallLine
      ? this.lineEntries.find(entry =>
        entry.address > pcAfter
        && entry.file === raw.file
        && entry.line !== raw.line
        && (!callerRange || entry.address < callerRange.end),
      )
      : undefined;

    if (!next) {
      log.step(
        `stepOut returnAddress=0x${diagnostics.returnAddress.toString(16)} pcAfter=0x${pcAfter.toString(16)}`
        + ` rawSourceLoc=${raw.file}:${raw.line} adjustedSourceLoc=none`,
      );
      return null;
    }

    const hint = {
      file: next.file,
      line: next.line,
      address: next.address,
      reason: 'returnAddressMappedToCallLine',
      rawFile: raw.file,
      rawLine: raw.line,
    };
    log.step(
      `stepOut returnAddress=0x${diagnostics.returnAddress.toString(16)} pcAfter=0x${pcAfter.toString(16)}`
      + ` rawSourceLoc=${raw.file}:${raw.line}`
      + ` adjustedSourceLoc=${hint.file}:${hint.line}@0x${hint.address.toString(16)}`
      + ` sourceAdjustReason=${hint.reason}`,
    );
    return hint;
  }

  private isReturnAddressOnSourceLine(
    address: number,
    location: { file: string; line: number },
  ): boolean {
    return [address - 2, address - 4]
      .filter(previousAddress => previousAddress >= 0)
      .some(previousAddress => {
        const previousLocation = this.resolveAddressLoc(previousAddress);
        return previousLocation?.file === location.file && previousLocation.line === location.line;
      });
  }

  private resolveSourceStatementRange(file: string, line: number): SourceStatementRange | null {
    let ranges = this.sourceStatementRanges.get(file);
    if (!ranges) {
      ranges = this.parseSourceStatementRanges(file);
      this.sourceStatementRanges.set(file, ranges);
    }
    return ranges.get(line) || null;
  }

  private parseSourceStatementRanges(file: string): Map<number, SourceStatementRange> {
    const ranges = new Map<number, SourceStatementRange>();
    let source: string;
    try {
      source = fs.readFileSync(file, 'utf8');
    } catch (_) {
      return ranges;
    }

    const assignRange = (startLine: number | null, endLine: number) => {
      if (startLine === null) return;
      const range = { startLine, endLine };
      for (let line = startLine; line <= endLine; line++) {
        const existing = ranges.get(line);
        if (!existing || (range.endLine - range.startLine) > (existing.endLine - existing.startLine)) {
          ranges.set(line, range);
        }
      }
    };

    let inBlockComment = false;
    let quote: '"' | '\'' | null = null;
    let escaped = false;
    let parenDepth = 0;
    let bracketDepth = 0;
    let statementStartLine: number | null = null;
    const continuationAtLineEnd = /(?:\+|-|\*|\/|%|&|\||\^|=|\?|:|,|&&|\|\||<<|>>|->|\\)\s*$/;

    source.split(/\r?\n/).forEach((rawLine, index) => {
      const lineNumber = index + 1;
      let codeLine = '';

      for (let cursor = 0; cursor < rawLine.length; cursor++) {
        const current = rawLine[cursor];
        const next = rawLine[cursor + 1];

        if (inBlockComment) {
          if (current === '*' && next === '/') {
            inBlockComment = false;
            cursor++;
          }
          continue;
        }
        if (quote !== null) {
          if (escaped) {
            escaped = false;
          } else if (current === '\\') {
            escaped = true;
          } else if (current === quote) {
            quote = null;
          }
          codeLine += ' ';
          continue;
        }
        if (current === '/' && next === '/') break;
        if (current === '/' && next === '*') {
          inBlockComment = true;
          cursor++;
          continue;
        }
        if (current === '"' || current === '\'') {
          quote = current;
          escaped = false;
          codeLine += ' ';
          continue;
        }

        codeLine += current;
        if (statementStartLine === null && !/\s/.test(current)) statementStartLine = lineNumber;

        if (current === '(') parenDepth++;
        else if (current === ')') parenDepth = Math.max(0, parenDepth - 1);
        else if (current === '[') bracketDepth++;
        else if (current === ']') bracketDepth = Math.max(0, bracketDepth - 1);
        else if (current === ';' && parenDepth === 0 && bracketDepth === 0) {
          assignRange(statementStartLine, lineNumber);
          statementStartLine = null;
        } else if ((current === '{' || current === '}') && parenDepth === 0 && bracketDepth === 0) {
          assignRange(statementStartLine, lineNumber);
          statementStartLine = null;
        }
      }

      const trimmedCode = codeLine.trim();
      const continued = parenDepth > 0 || bracketDepth > 0 || continuationAtLineEnd.test(trimmedCode);
      if (statementStartLine !== null && !continued) {
        assignRange(statementStartLine, lineNumber);
        statementStartLine = null;
      }
    });

    return ranges;
  }

  private resolveNativeLineBounds(pc: number): { start: number; end: number } | null {
    const startLoc = this.resolveAddressLoc(pc);
    if (!startLoc || this.lineEntries.length === 0) return null;
    const functionRange = this.resolveFunctionRange(pc);
    const statementRange = this.resolveSourceStatementRange(startLoc.file, startLoc.line);
    const belongsToCurrentStatement = (entry: { file: string; line: number }) => entry.file === startLoc.file
      && (statementRange
        ? entry.line >= statementRange.startLine && entry.line <= statementRange.endLine
        : entry.line === startLoc.line);
    let start = pc;
    let end = 0;
    for (const entry of this.lineEntries) {
      if (functionRange && (entry.address < functionRange.start || entry.address >= functionRange.end)) continue;
      if (entry.file !== startLoc.file) continue;
      if (entry.address <= pc && entry.line === startLoc.line) start = entry.address;
      if (entry.address > pc && !belongsToCurrentStatement(entry)) {
        end = entry.address;
        break;
      }
    }
    if (end <= start) end = functionRange?.end || ((pc + 4) >>> 0);

    const sourceHint = this.lastNativeStopInfo?.sourceHint;
    const hintFunctionRange = sourceHint ? this.resolveFunctionRange(sourceHint.address) : null;
    const hintMatchesCurrentStop = Boolean(
      this.nativeStepExecutor?.usingNative
      && this.lastNativeStopInfo?.pcAfter === pc
      && sourceHint
      && sourceHint.address >= pc
      && functionRange
      && hintFunctionRange
      && hintFunctionRange.start === functionRange.start
      && hintFunctionRange.end === functionRange.end
      && sourceHint.address < functionRange.end
      && this.lineEntries.some(entry =>
        entry.address === sourceHint.address
        && entry.file === sourceHint.file
        && entry.line === sourceHint.line,
      ),
    );
    let usedHint = false;
    if (hintMatchesCurrentStop && sourceHint && functionRange) {
      const hintStatementRange = this.resolveSourceStatementRange(sourceHint.file, sourceHint.line);
      const adjustedEnd = this.lineEntries.find(entry =>
        entry.address > sourceHint.address
        && entry.address < functionRange.end
        && (entry.file !== sourceHint.file
          || (hintStatementRange
            ? entry.line < hintStatementRange.startLine || entry.line > hintStatementRange.endLine
            : entry.line !== sourceHint.line)),
      )?.address;
      if (adjustedEnd !== undefined && adjustedEnd > sourceHint.address) {
        start = pc;
        end = adjustedEnd;
        usedHint = true;
      }
    }

    log.step(
      `native source bounds pc=0x${pc.toString(16)}`
      + ` rawSource=${startLoc.file}:${startLoc.line}`
      + ` hintSource=${sourceHint
        ? `${sourceHint.file}:${sourceHint.line}@0x${sourceHint.address.toString(16)}`
        : 'none'}`
      + ` logicalSourceRange=${statementRange
        ? `${statementRange.startLine}..${statementRange.endLine}`
        : `${startLoc.line}..${startLoc.line}`}`
      + ` effectiveLineStart=0x${start.toString(16)} effectiveLineEnd=0x${end.toString(16)}`
      + ` usedStepOutHint=${usedHint}`,
    );
    return { start, end };
  }

  private async doStepOverLegacy(): Promise<OzoneCommandResult> {
    const haltedBefore = await this.ensureHalted();
    if (!haltedBefore) return { ok: false, error: 'Cannot halt CPU for step over' };
    await new Promise<void>(r => setTimeout(r, 20));
    await this.cleanupStepBreakpoints();
    const tReadPc = Date.now();
    const pc = await this.targetReadRegister(REG_INDEXES.PC);
    this.stepProfileMark('read PC', tReadPc, `pc=0x${(pc ?? 0).toString(16)}`);
    if (pc === null) return { ok: false, error: 'Cannot read PC' };

    const tReadMemory = Date.now();
    let raw = await this.targetReadMemory(pc, 6);
    if (!raw || raw.length < 6) {
      await new Promise<void>(r => setTimeout(r, 10));
      raw = await this.targetReadMemory(pc, 6);
    }
    this.stepProfileMark('readMemory', tReadMemory, `addr=0x${pc.toString(16)} size=6 bytes=${raw?.length ?? 0}`);

    let hw1 = 0, hw2 = 0, hw3 = 0;
    if (raw && raw.length >= 2) {
      hw1 = (raw[1] << 8) | raw[0];
      if (raw.length >= 4) hw2 = (raw[3] << 8) | raw[2];
      if (raw.length >= 6) hw3 = (raw[5] << 8) | raw[4];
    }

    const isBL = (hw1 & 0xF800) === 0xF000 && (hw2 & 0xD000) === 0xD000;
    const isBLX = (hw1 & 0xF800) === 0xF000 && (hw2 & 0xD000) === 0x8000;
    const isBLXReg = (hw1 & 0xFF87) === 0x4780;
    const instrIs32 = (hw1 >> 11) >= 0x1D;
    const isBranch = !instrIs32 && (hw1 & 0xF000) === 0xE000
      || (hw1 & 0xF800) === 0xF000 && (hw2 & 0xC000) === 0x8000;

    await this.clearCurrentBpAndTrack(pc);
    const startLoc = this.resolveAddressLoc(pc);

    if (isBLXReg) {
      const nextAddr = ((pc + 2) >>> 0);
      const stepResult = await this.setTempBpAndRun(nextAddr);
      const newPc = await this.targetReadRegister(REG_INDEXES.PC);
      if (newPc !== null && startLoc) {
        const newLoc = this.resolveAddressLoc(newPc);
        if (newLoc && newLoc.file === startLoc.file && newLoc.line > startLoc.line) {
          return stepResult;
        }
        if (newPc !== pc) {
          log.step(`BL: return addr reached (PC changed 0x${pc.toString(16)}->0x${newPc.toString(16)}), call completed`);
          return { ok: true, data: 'Stepped' };
        } else {
          log.step(`BL: stale BP - PC unchanged at 0x${pc.toString(16)}, falling through`);
        }
      }
    } else if (isBL || isBLX) {
      const nextAddr = ((pc + 4) >>> 0);
      const stepResult = await this.setTempBpAndRun(nextAddr);
      const newPc = await this.targetReadRegister(REG_INDEXES.PC);
      if (newPc !== null && startLoc) {
        const newLoc = this.resolveAddressLoc(newPc);
        if (newLoc && newLoc.file === startLoc.file && newLoc.line > startLoc.line) {
          return stepResult;
        }
        if (newPc !== pc) {
          log.step(`BL: return addr reached (PC changed 0x${pc.toString(16)}->0x${newPc.toString(16)}), call completed`);
          return { ok: true, data: 'Stepped' };
        }
      }
    }

    const nonBranchStepOver = async (): Promise<OzoneCommandResult | null> => {
      let nextOffset = instrIs32 ? 4 : 2;
      let branchAfterCurrent = false;
      if (!instrIs32 && raw && raw.length >= 4) {
        if ((hw2 & 0xFF00) === 0xDF00) {
          nextOffset = 4;
        } else if ((hw2 & 0xF000) === 0xE000) {
          branchAfterCurrent = true;
        } else if (raw.length >= 6 && (hw2 >> 11) >= 0x1D) {
          const nextIsCall = (hw2 & 0xF800) === 0xF000 && ((hw3 & 0xD000) === 0xD000 || (hw3 & 0xD000) === 0x8000);
          const nextIsBranch = (hw2 & 0xF800) === 0xF000 && (hw3 & 0xC000) === 0x8000;
          if (nextIsCall || nextIsBranch) {
            nextOffset = 6;
            branchAfterCurrent = !nextIsCall;
          }
        }
      }
      if (branchAfterCurrent) return null;
      const nextAddr = ((pc + nextOffset) >>> 0);
      if (nextAddr <= pc) return null;
      const stepResult = await this.setTempBpAndRun(nextAddr, 500);
      const newPc = await this.targetReadRegister(REG_INDEXES.PC);
      if (newPc === null || !startLoc) return null;
      const newLoc = this.resolveAddressLoc(newPc);
      log.step(`nonBranchBp: fired pc=0x${newPc.toString(16)} loc=${newLoc ? `${newLoc.file}:${newLoc.line}` : 'null'} startLoc=${startLoc.file}:${startLoc.line}`);
      if (newLoc && newLoc.file === startLoc.file && newLoc.line > startLoc.line) {
        return stepResult;
      }
      if (newLoc && newLoc.file === startLoc.file && newLoc.line < startLoc.line) {
        log.step(`nonBranchBp: loop wrap to line ${newLoc.line}, step done`);
        return { ok: true, data: 'Stepped' };
      }
      if (newLoc && newLoc.file === startLoc.file && newLoc.line === startLoc.line) {
        const bpRaw = await this.targetReadMemory(newPc, 4);
        if (bpRaw && bpRaw.length >= 4) {
          const bpHw1 = (bpRaw[1] << 8) | bpRaw[0];
          const bpHw2 = (bpRaw[3] << 8) | bpRaw[2];
          if ((bpHw1 & 0xFF87) === 0x4780 || ((bpHw1 & 0xF800) === 0xF000 && ((bpHw2 & 0xD000) === 0xD000 || (bpHw2 & 0xD000) === 0x8000))) {
            log.step(`nonBranchBp: call at 0x${newPc.toString(16)}, stepping over via return BP`);
            await this.clearCurrentBpAndTrack(newPc);
            return await this.setTempBpAndRun((newPc + 4) >>> 0);
          }
        }
        log.step(`sameLineStepping: start 0x${newPc.toString(16)} line=${newLoc.line}`);
        let steppedLoc = false;
        for (let i = 0; i < 20; i++) {
          const prePc = await this.targetReadRegister(REG_INDEXES.PC);
          if (prePc !== null) {
            const preRaw = await this.targetReadMemory(prePc, 6);
            if (preRaw && preRaw.length >= 4) {
              const pHw1 = (preRaw[1] << 8) | preRaw[0];
              const pHw2 = (preRaw[3] << 8) | preRaw[2];
              const isCallNow = (pHw1 & 0xFF87) === 0x4780 || ((pHw1 & 0xF800) === 0xF000 && ((pHw2 & 0xD000) === 0xD000 || (pHw2 & 0xD000) === 0x8000));
              const stepOverCall = async (target: number): Promise<boolean> => {
                const r = await this.setTempBpAndRun(target);
                const postPc = await this.targetReadRegister(REG_INDEXES.PC);
                if (postPc !== null && startLoc) {
                  const postLoc = this.resolveAddressLoc(postPc);
                  if (postLoc && (postLoc.file !== startLoc.file || postLoc.line !== startLoc.line)) {
                    return true;
                  }
                }
                return false;
              };
              if (isCallNow) {
                log.step(`sameLineStepping: call at 0x${prePc.toString(16)}, stepping over via return BP`);
                await this.clearCurrentBpAndTrack(prePc);
                const retAddr = ((prePc + (pHw1 >> 11 >= 0x1D ? 4 : 2)) >>> 0);
                const done = await stepOverCall(retAddr);
                if (done) { steppedLoc = true; break; }
                continue;
              }
              if (preRaw.length >= 6) {
                const pHw3 = (preRaw[5] << 8) | preRaw[4];
                if ((pHw2 & 0xF800) === 0xF000 && ((pHw3 & 0xD000) === 0xD000 || (pHw3 & 0xD000) === 0x8000)) {
                  log.step(`sameLineStepping: call at 0x${(prePc+2).toString(16)} (next instr), stepping over`);
                  await this.clearCurrentBpAndTrack(prePc);
                  const done = await stepOverCall(((prePc + 6) >>> 0));
                  if (done) { steppedLoc = true; break; }
                  continue;
                }
              }
            }
          }
          const step2Result = await this.doSingleStep();
          if (!step2Result.ok) { log.step(`sameLineStepping: step fail ${step2Result.error}`); break; }
          const step2Pc = await this.targetReadRegister(REG_INDEXES.PC);
          if (step2Pc !== null && startLoc) {
            const step2Loc = this.resolveAddressLoc(step2Pc);
            log.step(`sameLineStepping: step${i} pc=0x${step2Pc.toString(16)} loc=${step2Loc ? `${step2Loc.file}:${step2Loc.line}` : 'null'}`);
            if (step2Loc && (step2Loc.file !== startLoc.file || step2Loc.line !== startLoc.line)) {
              log.step(`sameLineStepping: reached ${step2Loc.file}:${step2Loc.line}, done`);
              steppedLoc = true;
              break;
            }
          }
        }
        if (steppedLoc) return { ok: true, data: 'Stepped' };
        log.step(`sameLineStepping: exhausted 10 steps, using findNextSourceLineAddress to escape`);
        const escapePc = await this.targetReadRegister(REG_INDEXES.PC) ?? newPc;
        const nextLineAddr = this.findNextSourceLineAddress(escapePc, startLoc);
        if (nextLineAddr !== null) {
          const escapeResult = await this.setTempBpAndRun(nextLineAddr, 2000);
          const postPc = await this.targetReadRegister(REG_INDEXES.PC);
          if (postPc !== null && startLoc) {
            const postLoc = this.resolveAddressLoc(postPc);
            if (postLoc && postLoc.file === startLoc.file && postLoc.line < startLoc.line) {
              log.step(`sameLineStepping: escape wrapped to line ${postLoc.line} (< ${startLoc.line}), step done`);
              return { ok: true, data: 'Stepped' };
            }
          }
          return escapeResult;
        }
      }
      return null;
    };

    const nonBranchResult = await nonBranchStepOver();
    if (nonBranchResult) return nonBranchResult;
    const multiSeenPcs = new Set<number>();
    for (let stepCount = 0; stepCount < 20; stepCount++) {
      const stepResult = await this.doSingleStep();
      if (!stepResult.ok) return stepResult;
      const newPc = await this.targetReadRegister(REG_INDEXES.PC);
      if (newPc !== null) {
        const newLoc = this.resolveAddressLoc(newPc);
        log.step(`multiStep: step${stepCount} pc=0x${newPc.toString(16)} loc=${newLoc ? `${newLoc.file}:${newLoc.line}` : 'null'}`);

        if (multiSeenPcs.has(newPc) && stepCount >= 2) {
          log.step(`multiStep: pc loop detected at 0x${newPc.toString(16)}, switching to temp BP`);
          const nextLineAddr = this.findNextSourceLineAddress(newPc, startLoc);
          if (nextLineAddr !== null) {
            return await this.setTempBpAndRun(nextLineAddr, 2000);
          }
          log.step(`multiStep: no next source line found, continuing`);
        }
        multiSeenPcs.add(newPc);

        if (newLoc && startLoc && newLoc.file === startLoc.file && newLoc.line > startLoc.line) {
          return { ok: true, data: 'Stepped' };
        }
        if (newLoc && startLoc && newLoc.file === startLoc.file && newLoc.line < startLoc.line) {
          const blRaw2 = await this.targetReadMemory(newPc, 4);
          if (blRaw2 && blRaw2.length >= 4) {
            const bl2Hw1 = (blRaw2[1] << 8) | blRaw2[0];
            const bl2Hw2 = (blRaw2[3] << 8) | blRaw2[2];
            if ((bl2Hw1 & 0xF800) === 0xF000 && ((bl2Hw2 & 0xD000) === 0xD000 || (bl2Hw2 & 0xD000) === 0x8000)) {
              log.step(`multiStep: backward+BL at 0x${newPc.toString(16)} line=${newLoc.line} hw=0x${bl2Hw1.toString(16)}`);
              return { ok: true, data: 'Stepped' };
            }
          }
          continue;
        }
        const blRaw = await this.targetReadMemory(newPc, 4);
        if (blRaw && blRaw.length >= 4) {
          const blHw1 = (blRaw[1] << 8) | blRaw[0];
          const blHw2 = (blRaw[3] << 8) | blRaw[2];
          if ((blHw1 & 0xF800) === 0xF000 && ((blHw2 & 0xD000) === 0xD000 || (blHw2 & 0xD000) === 0x8000)) {
            if (newLoc && startLoc && newLoc.line === startLoc.line) {
              log.step(`multiStep: sameLine+BL at 0x${newPc.toString(16)} line=${newLoc.line} hw=0x${blHw1.toString(16)}`);
              await this.clearCurrentBpAndTrack(newPc);
              const blNextAddr = ((newPc + 4) >>> 0);
              return await this.setTempBpAndRun(blNextAddr);
            }
            return { ok: true, data: 'Stepped' };
          }
        }
      }
    }
    return await this.doSingleStep();
  }

  private findNextSourceLineAddress(pc: number, startLoc: { file: string; line: number } | null): number | null {
    if (this.lineEntries.length === 0 || !startLoc) return null;
    const functionRange = this.resolveFunctionRange(pc);
    const inCurrentFunction = (address: number) => !functionRange
      || (address >= functionRange.start && address < functionRange.end);

    for (const entry of this.lineEntries) {
      if (entry.address > pc && inCurrentFunction(entry.address) && entry.file === startLoc.file && entry.line > startLoc.line) {
        return entry.address;
      }
    }

    for (const entry of this.lineEntries) {
      if (entry.address < pc && inCurrentFunction(entry.address) && entry.file === startLoc.file && entry.line === startLoc.line) {
        return entry.address;
      }
    }

    return null;
  }

  private resolveFunctionRange(address: number): { start: number; end: number } | null {
    let best: SymbolInfo | null = null;
    for (const sym of this.symbols) {
      // GNU nm marks compiler runtime helpers such as __aeabi_dmul as weak
      // functions (W/w). They still provide valid code ranges for step-out.
      if ((sym.type === 'T' || sym.type === 't' || sym.type === 'W' || sym.type === 'w') && sym.size > 0) {
        const start = sym.address >>> 0;
        const end = (sym.address + sym.size) >>> 0;
        if (address >= start && address < end && (!best || sym.size < best.size)) {
          best = sym;
        }
      }
    }

    return best ? { start: best.address >>> 0, end: (best.address + best.size) >>> 0 } : null;
  }

  private async doSingleStep(): Promise<OzoneCommandResult> {
    for (let retry = 0; retry < 5; retry++) {
      const tStep = Date.now();
      const stepOk = this.sessionTarget ? (await this.sessionTarget.step()).ok : this.jlink.step();
      log.step(`doSingleStep: retry=${retry} step()=${stepOk} t=${Date.now()-tStep}ms`);
      this.stepProfileMark('run', tStep, `singleStep retry=${retry} ok=${stepOk}`);
      if (stepOk) {
        const tWait = Date.now();
        await this.targetHalt();
        await new Promise<void>(r => setTimeout(r, 50));
        const haltedNow = await this.targetIsHalted();
        const pc = await this.targetReadRegister(REG_INDEXES.PC);
        log.step(`doSingleStep: after halt+50ms isHalted=${haltedNow} pc=0x${(pc??0).toString(16)}`);
        this.stepProfileMark('waitForHalt', tWait, `singleStep halted=${haltedNow} pc=0x${(pc ?? 0).toString(16)}`);
        this.state = TargetState.Halted;
        return { ok: true, data: 'Stepped' };
      }
      await this.targetHalt();
      await new Promise<void>(r => setTimeout(r, 50));
    }
    return { ok: false, error: 'Step failed after retries' };
  }

  private async waitForHalt(maxPolls: number = 500): Promise<boolean> {
    const tStart = Date.now();
    for (let i = 0; i < maxPolls; i++) {
      await new Promise<void>(r => setTimeout(r, 10));
      if (await this.targetIsHalted()) {
        this.state = TargetState.Halted;
        log.step(`waitForHalt: halted at poll ${i+1} t=${Date.now()-tStart}ms`);
        this.stepProfileMark('waitForHalt', tStart, `halted=true polls=${i + 1}/${maxPolls}`);
        return true;
      }
      if (i % 100 === 99) {
        log.step(`waitForHalt: poll ${i+1}/${maxPolls} t=${Date.now()-tStart}ms still waiting`);
      }
    }
    log.step(`waitForHalt: timeout after ${Date.now()-tStart}ms, one final soft settle`);
    this.stepProfileMark('waitForHalt', tStart, `halted=false polls=${maxPolls}/${maxPolls} timeout=true`);
    await this.targetHalt();
    await new Promise<void>(r => setTimeout(r, 50));
    if (await this.targetIsHalted()) {
      this.state = TargetState.Halted;
      return true;
    }
    return false;
  }

  private async setTempBpAndRun(nextAddr: number, maxPolls?: number): Promise<OzoneCommandResult> {
    const tSetBreakpoint = Date.now();
    const bpIndex = await this.targetSetBreakpoint(nextAddr);
    this.stepProfileMark('setBreakpoint', tSetBreakpoint, `addr=0x${nextAddr.toString(16)} bpIndex=${bpIndex}`);
    log.step(`setTempBpAndRun: addr=0x${nextAddr.toString(16)} bpIndex=${bpIndex}`);
    if (bpIndex === null) {
      log.step('setTempBpAndRun: setBreakpoint failed, re-setting cleared bp and using step');
      await this.restoreClearedBps();
      return await this.doSingleStep();
    }
    this.tempBreakpoint = { index: bpIndex, addr: nextAddr };

    const tReadPc = Date.now();
    const curPc = await this.targetReadRegister(REG_INDEXES.PC);
    this.stepProfileMark('read PC', tReadPc, `beforeRun pc=0x${(curPc ?? 0).toString(16)}`);
    if (curPc !== null && curPc === nextAddr) {
      const tReadMemory = Date.now();
      const raw = await this.targetReadMemory(curPc, 4);
      this.stepProfileMark('readMemory', tReadMemory, `addr=0x${curPc.toString(16)} size=4 bytes=${raw?.length ?? 0}`);
      let isCall = false;
      if (raw && raw.length >= 4) {
        const hw1 = (raw[1] << 8) | raw[0];
        const hw2 = (raw[3] << 8) | raw[2];
        isCall = ((hw1 & 0xF800) === 0xF000 && ((hw2 & 0xD000) === 0xD000 || (hw2 & 0xD000) === 0x8000))
               || (hw1 & 0xFF87) === 0x4780;
      }
      if (isCall) {
        log.step(`setTempBpAndRun: at stale BP 0x${curPc.toString(16)}, call instr, skipping step`);
      } else {
        log.step(`setTempBpAndRun: at stale BP 0x${curPc.toString(16)}, non-call, stepping to next call`);
        await this.cleanupStepBreakpoints();
        const startLoc = this.resolveAddressLoc(curPc);
        for (let stepCount = 0; stepCount < 20; stepCount++) {
          const stepResult = await this.doSingleStep();
          if (!stepResult.ok) return stepResult;
          const newPc = await this.targetReadRegister(REG_INDEXES.PC);
          if (newPc !== null) {
            const newLoc = this.resolveAddressLoc(newPc);
            if (newLoc && startLoc && (newLoc.line !== startLoc.line || newLoc.file !== startLoc.file)) {
              log.step(`setTempBpAndRun: reached new source line after ${stepCount + 1} steps`);
              return { ok: true, data: 'Stepped' };
            }
            const raw = await this.targetReadMemory(newPc, 4);
            if (raw && raw.length >= 4) {
              const hw1 = (raw[1] << 8) | raw[0];
              const hw2 = (raw[3] << 8) | raw[2];
              if ((hw1 & 0xF800) === 0xF000 && ((hw2 & 0xD000) === 0xD000 || (hw2 & 0xD000) === 0x8000)) {
                log.step(`setTempBpAndRun: reached call instruction after ${stepCount + 1} steps`);
                return { ok: true, data: 'Stepped' };
              }
            }
          }
        }
        return { ok: true, data: 'Stepped' };
      }
    }

    const tPreHalt = Date.now();
    await this.targetHalt();
    await new Promise<void>(r => setTimeout(r, 20));
    log.step(`setTempBpAndRun: pre-halt done t=${Date.now()-tPreHalt}ms pc=0x${((await this.targetReadRegister(REG_INDEXES.PC))??0).toString(16)}`);

    const tRun = Date.now();
    const runOk = await this.targetRun();
    log.step(`setTempBpAndRun: run=${runOk} t=${Date.now()-tRun}ms`);
    this.stepProfileMark('run', tRun, `ok=${runOk}`);
    if (!runOk) return { ok: false, error: 'Run failed' };
    this.state = TargetState.Running;

    const tWait = Date.now();
    const halted = await this.waitForHalt(maxPolls ?? 500);
    log.step(`setTempBpAndRun: waitForHalt=${halted} t=${Date.now()-tWait}ms pc=0x${((await this.targetReadRegister(REG_INDEXES.PC))??0).toString(16)}`);
    if (!halted) {
      await this.targetHalt();
      await new Promise<void>(r => setTimeout(r, 50));
    }
    await this.targetHalt();
    await new Promise<void>(r => setTimeout(r, 50));
    await this.cleanupStepBreakpoints();
    return { ok: true, data: 'Stepped' };
  }

  private resolveAddressToLine(address: number): { file: string; line: number } | null {
    if (this.lineEntries.length === 0) return null;
    let lo = 0, hi = this.lineEntries.length - 1;
    if (address < this.lineEntries[0].address) return null;
    if (address >= this.lineEntries[hi].address) {
      if (this.lineEntries[hi].address === address) return this.lineEntries[hi];
      return this.lineEntries[hi];
    }
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineEntries[mid].address <= address) lo = mid;
      else hi = mid - 1;
    }
    if (lo >= 0 && this.lineEntries[lo].address <= address) {
      return this.lineEntries[lo];
    }
    return null;
  }

  private resolveAddressLoc(address: number): { file: string; line: number; func: string } | null {
    const floor = this.resolveAddressToLine(address);
    const cached = this.addressLocCache.get(address);
    const funcName = cached?.func || this.resolveSymbolName(address);

    if (floor) {
      return {
        file: floor.file,
        line: floor.line,
        func: funcName || `0x${address.toString(16)}`,
      };
    }
    if (cached) return cached;

    const symName = this.resolveSymbolName(address);
    if (symName) {
      const sym = this.symbols.find(s => s.name === symName);
      if (sym) {
        const cachedBySym = this.addressLocCache.get(sym.address);
        if (cachedBySym) return cachedBySym;
      }
    }

    return null;
  }

  private async doReadMemory(address: number, size: number): Promise<OzoneCommandResult> {
    const wasRunning = !(await this.targetIsHalted());
    if (wasRunning) {
      const halted = await this.ensureHalted();
      if (!halted) return { ok: false, error: 'halt failed' };
      await new Promise<void>(r => setTimeout(r, 50));
    }

    const raw = await this.readMemoryChunked(address, size);
    if (wasRunning) await this.targetRun();
    if (!raw || raw.length === 0) return { ok: false, error: 'Failed to read memory' };

    const data = Array.from(raw);
    const ascii = data.map(b => (b >= 0x20 && b <= 0x7E) ? String.fromCharCode(b) : '.').join('');
    const block: MemoryBlock = { address, data, ascii, unreadableBytes: Math.max(0, size - data.length) };
    return { ok: true, data: block };
  }

  private async readMemoryChunked(address: number, size: number): Promise<Uint8Array | null> {
    const chunkSize = 256;
    const chunks: number[] = [];
    for (let offset = 0; offset < size; offset += chunkSize) {
      const count = Math.min(chunkSize, size - offset);
      const chunk = await this.targetReadMemory(address + offset, count);
      if (!chunk) break;
      chunks.push(...Array.from(chunk));
    }
    return chunks.length > 0 ? Uint8Array.from(chunks) : null;
  }

  private async doFlash(
    elfPath: string,
    device: string,
    interface_: string,
    speedKHz: number,
    signal?: AbortSignal,
  ): Promise<OzoneCommandResult> {
    const result = await flashElf(elfPath, device, interface_, speedKHz, { signal });
    if (result.success) {
       this.elfPath = elfPath;
       this.symbols = await readElfSymbols(elfPath);
       this.lineMapCache = await preloadLineMappings(elfPath);
       this.sourceStatementRanges.clear();
      const funcAddrs = this.symbols
        .filter(s => s.type === 'T' || s.type === 't')
        .map(s => s.address);
      this.addressLocCache = await preloadAddressMappings(elfPath, funcAddrs);
      this.lineEntries = [];
      const fnameToAbs2 = new Map<string, string>();
      for (const loc of this.addressLocCache.values()) {
        const base = path.basename(loc.file);
        if (base && !fnameToAbs2.has(base)) fnameToAbs2.set(base, loc.file);
      }
      for (const [fName, entries] of this.lineMapCache) {
        let resolvedFile: string;
        if (path.isAbsolute(fName) && fs.existsSync(fName)) {
          resolvedFile = fName;
        } else if (fnameToAbs2.has(fName)) {
          resolvedFile = fnameToAbs2.get(fName)!;
        } else {
          const base = path.basename(fName);
          if (fnameToAbs2.has(base)) {
            resolvedFile = fnameToAbs2.get(base)!;
          } else {
            resolvedFile = path.resolve(path.dirname(elfPath), fName);
          }
        }
        for (const entry of entries) {
          if (entry.isStatement && entry.address >= 0x08000000 && entry.address < 0x20100000) {
            this.lineEntries.push({ address: entry.address, file: resolvedFile, line: entry.line });
          }
        }
      }
      this.lineEntries.sort((a, b) => a.address - b.address);
      this.dwarfInfo = await parseDwarfTypeInfo(elfPath);
      if (this.dwarfInfo.typeDefs.size === 0) {
        try {
          const out = await new Promise<string>(r => {
            execFile(OBJDUMP_EXE, ['--dwarf=info', elfPath], { maxBuffer: 50 * 1024 * 1024, timeout: 30000, windowsHide: true }, (e, o) => r(o || ''));
          });
        } catch (_) {}
      }
      return { ok: true, data: result };
    }
    return { ok: false, error: result.message };
  }

  private resolveSymbolName(address: number): string | null {
    let best: SymbolInfo | null = null;
    for (const sym of this.symbols) {
      if (sym.type === 'T' || sym.type === 't') {
        if (address >= sym.address && address < sym.address + Math.max(sym.size, 1)) {
          if (!best || address - sym.address < address - best.address) {
            best = sym;
          }
        }
      }
    }
    return best?.name || null;
  }

  private async resolveLineAddress(file: string, line: number): Promise<number | null> {
    if (!this.elfPath) return null;

    const fileName = file.split(/[/\\]/).pop() || file;
    for (const entry of this.lineEntries) {
      if (entry.line === line && (entry.file === file || entry.file.endsWith(fileName) || entry.file === fileName)) {
        return entry.address;
      }
    }

    return resolveMappedStatementAddress(this.lineMapCache, file, line);
  }

  private prepareFastDataSampling(expressions: string[]): FastDataSamplePlanItem[] {
    return expressions.map(expression => {
      const spec = this.resolveFastDataSampleSpec(expression);
      return spec ? { expression, spec } : { expression, error: 'Fast sampling supports scalar globals, scalar array elements, and scalar struct fields only' };
    });
  }

  private resolveFastDataSampleSpec(expression: string): FastDataSampleSpec | null {
    const bracketMatch = expression.match(/^(\w+)\[(\d+)\]$/);
    if (bracketMatch) {
      const baseName = bracketMatch[1];
      const index = parseInt(bracketMatch[2], 10);
      const baseSym = this.findSymbolByName(baseName);
      if (!baseSym) return null;
      const varTypeOffset = this.dwarfInfo.varToType.get(baseSym.name);
      const arrayType = varTypeOffset ? this.resolveDwarfType(varTypeOffset) : null;
      if (!arrayType || arrayType.kind !== 'array' || index < 0 || (arrayType.arrayCount !== undefined && index >= arrayType.arrayCount)) return null;
      const elemType = arrayType.typeOffset ? this.resolveDwarfType(arrayType.typeOffset) : null;
      if (!this.isFastScalarType(elemType)) return null;
      const size = this.getScalarReadSize(undefined, elemType);
      return {
        expression,
        address: baseSym.address + index * size,
        size,
        typeName: arrayType.typeOffset ? this.getDwarfTypeName(arrayType.typeOffset) : elemType?.typeName || elemType?.name || '',
        isFloat: this.isFloatType(elemType),
        signed: this.isSignedIntegerType(elemType),
      };
    }

    const fieldMatch = expression.match(/^(\w+)((?:\.|->)[A-Za-z_]\w+)+$/);
    if (fieldMatch) {
      const [, baseName] = fieldMatch;
      const baseSym = this.findSymbolByName(baseName);
      if (!baseSym) return null;
      const varTypeOffset = this.dwarfInfo.varToType.get(baseSym.name);
      const baseType = varTypeOffset ? this.resolveDwarfType(varTypeOffset) : null;
      let currentType = baseType;
      let pointerAddress: number | undefined;
      let fieldOffset = 0;
      if (currentType?.kind === 'pointer') {
        if (!currentType.typeOffset) return null;
        pointerAddress = baseSym.address;
        currentType = this.resolveDwarfType(currentType.typeOffset);
      }

      const segments = [...expression.slice(baseName.length).matchAll(/(\.|->)([A-Za-z_]\w*)/g)];
      for (let index = 0; index < segments.length; index++) {
        const [, operator, fieldName] = segments[index];
        if (operator === '->' && pointerAddress === undefined) return null;
        if (currentType?.kind !== 'struct' || !currentType.fields) return null;
        const field = currentType.fields.find(candidate => candidate.name === fieldName);
        if (!field) return null;
        const fieldType = this.resolveDwarfType(field.typeOffset);
        fieldOffset += field.byteOffset;

        if (index < segments.length - 1) {
          if (fieldType?.kind !== 'struct') return null;
          currentType = fieldType;
          continue;
        }

        if (!this.isFastScalarType(fieldType)) return null;
        const size = this.getScalarReadSize(undefined, fieldType);
        return {
          expression,
          address: pointerAddress === undefined ? baseSym.address + fieldOffset : pointerAddress,
          size,
          ...(pointerAddress === undefined ? {} : { pointerAddress, pointeeOffset: fieldOffset }),
          typeName: this.getDwarfTypeName(field.typeOffset) || fieldType?.typeName || fieldType?.name || '',
          isFloat: this.isFloatType(fieldType),
          signed: this.isSignedIntegerType(fieldType),
        };
      }
    }

    const sym = this.findSymbolByName(expression);
    if (!sym) return null;
    const varTypeOffset = this.dwarfInfo.varToType.get(sym.name);
    const resolvedType = varTypeOffset ? this.resolveDwarfType(varTypeOffset) : null;
    if (!resolvedType && sym.size > 8) return null;
    if (!this.isFastScalarType(resolvedType)) return null;
    const size = this.getScalarReadSize(sym.size, resolvedType);
    return {
      expression,
      address: sym.address,
      size,
      typeName: varTypeOffset ? this.getDwarfTypeName(varTypeOffset) : resolvedType?.typeName || resolvedType?.name || '',
      isFloat: this.isFloatType(resolvedType),
      signed: this.isSignedIntegerType(resolvedType),
    };
  }

  private findSymbolByName(name: string): SymbolInfo | undefined {
    return this.symbols.find(s => s.name === name)
      || this.symbols.find(s => s.name.toLowerCase() === name.toLowerCase());
  }

  private isFastScalarType(info: { kind?: string; byteSize?: number } | null): boolean {
    if (!info) return true;
    if (info.kind === 'struct' || info.kind === 'array') return false;
    const size = info.byteSize || 4;
    return size > 0 && size <= 8;
  }

  private async readFastDataSampling(specs: FastDataSampleSpec[]): Promise<WatchValue[]> {
    const rawByIndex: Array<Uint8Array | null> = Array(specs.length).fill(null);
    const resolvedAddresses = specs.map(spec => spec.address);
    const initialReads = specs.map(spec => ({
      address: spec.pointerAddress ?? spec.address,
      size: spec.pointerAddress === undefined ? spec.size : 4,
    }));

    if (this.sessionTarget && specs.length > 0) {
      const result = await this.sessionTarget.readMemoryBatch(
        initialReads,
        { priority: 'timeline', coalesceKey: 'fast-data-sampling' },
      );
      if (result.ok && result.data) {
        for (let index = 0; index < specs.length; index++) rawByIndex[index] = result.data.reads[index]?.bytes || null;
      }
    }
    for (let index = 0; index < specs.length; index++) {
      if (rawByIndex[index]) continue;
      const initial = initialReads[index];
      rawByIndex[index] = await this.targetReadMemory(initial.address, initial.size, 'timeline');
    }

    const indirectReads: Array<{ index: number; address: number; size: number }> = [];
    for (let index = 0; index < specs.length; index++) {
      const spec = specs[index];
      if (spec.pointerAddress === undefined) continue;
      const pointerBytes = rawByIndex[index];
      const pointer = pointerBytes ? this.readUnsignedLittleEndian(pointerBytes, pointerBytes.length) >>> 0 : 0;
      if (!pointer || spec.pointeeOffset === undefined) {
        rawByIndex[index] = null;
        continue;
      }
      const address = (pointer + spec.pointeeOffset) >>> 0;
      resolvedAddresses[index] = address;
      rawByIndex[index] = null;
      indirectReads.push({ index, address, size: spec.size });
    }

    if (this.sessionTarget && indirectReads.length > 0) {
      const result = await this.sessionTarget.readMemoryBatch(
        indirectReads.map(read => ({ address: read.address, size: read.size })),
        { priority: 'timeline', coalesceKey: 'fast-data-sampling' },
      );
      if (result.ok && result.data) {
        for (let index = 0; index < indirectReads.length; index++) {
          rawByIndex[indirectReads[index].index] = result.data.reads[index]?.bytes || null;
        }
      } else {
        for (const read of indirectReads) rawByIndex[read.index] = null;
      }
    }
    for (const read of indirectReads) {
      if (rawByIndex[read.index]) continue;
      rawByIndex[read.index] = await this.targetReadMemory(read.address, read.size, 'timeline');
    }

    const results: WatchValue[] = [];
    for (let index = 0; index < specs.length; index++) {
      const spec = specs[index];
      const raw = rawByIndex[index];
      if (!raw) {
        results.push({ expression: spec.expression, value: 0, display: '', hex: '', error: `read failed at 0x${resolvedAddresses[index].toString(16)}` });
        continue;
      }

      let value: number;
      let display: string;
      let hex: string;
      if (spec.isFloat) {
        value = this.readBytesAsFloat(raw, spec.size);
        display = spec.size === 8 ? `${value.toExponential(6)}` : `${value.toFixed(6)}`;
        hex = `0x${Array.from(raw.slice(0, spec.size)).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
      } else {
        const formatted = this.formatScalarValue(raw, spec.size, { kind: 'base', encoding: spec.signed ? 'signed' : 'unsigned', name: spec.typeName || '' });
        value = formatted.value;
        display = formatted.display;
        hex = formatted.hex;
      }

      results.push({
        expression: spec.expression,
        value,
        display,
        hex,
        address: resolvedAddresses[index],
        typeName: spec.typeName,
      });
    }
    return results;
  }

  private async doEvaluateExpression(
    expression: string,
    force: boolean = false,
    watchContext?: WatchEvaluationContext,
  ): Promise<OzoneCommandResult> {
    expression = expression.trim();
    const isRTOS = expression === 'uxCurrentNumberOfTasks' || expression === 'pxCurrentTCB' || expression === 'pxReadyTasksLists';

    const sizeofValue = this.evaluateSizeofExpression(expression);
    if (sizeofValue !== null) {
      return { ok: true, data: this.makeNumericWatchValue(expression, sizeofValue, 'size_t', false) };
    }

    const derefValue = await this.evaluatePointerDereferenceExpression(expression);
    if (derefValue) return { ok: true, data: derefValue };

    const charPointerValue = await this.evaluateCharPointerExpression(expression);
    if (charPointerValue) return { ok: true, data: charPointerValue };

    const castStructValue = await this.evaluateCastStructExpression(expression);
    if (castStructValue) return { ok: true, data: castStructValue };

    const fieldValue = await this.evaluateFieldAccessExpression(expression);
    if (fieldValue) return { ok: true, data: fieldValue };

    const arithmeticValue = this.evaluateIntegerExpression(expression);
    if (arithmeticValue !== null) {
      return { ok: true, data: this.makeNumericWatchValue(expression, arithmeticValue, 'integer', false) };
    }

    const numericMatch = expression.match(/^(?:0x[0-9a-fA-F]+|\d+)$/);
    if (numericMatch) {
      const value = expression.toLowerCase().startsWith('0x') ? parseInt(expression, 16) : parseInt(expression, 10);
      return { ok: true, data: this.makeNumericWatchValue(expression, value, 'address', true) };
    }

    const addressOfMatch = expression.match(/^&\s*([A-Za-z_]\w*)$/);
    if (addressOfMatch) {
      const name = addressOfMatch[1];
      const sym = this.symbols.find(s => s.name === name) || this.symbols.find(s => s.name.toLowerCase() === name.toLowerCase());
      if (!sym) return { ok: false, error: `Symbol not found: ${name}` };
      return { ok: true, data: this.makeNumericWatchValue(expression, sym.address, 'address', true) };
    }

    // Handle array element access: name[index]
    const bracketMatch = expression.match(/^(\w+)\[(\d+)\]$/);
    if (bracketMatch) {
      const baseName = bracketMatch[1];
      const index = parseInt(bracketMatch[2], 10);
      const baseSym = this.symbols.find(s => s.name === baseName);
      if (baseSym) {
        const varTypeOffset = this.dwarfInfo.varToType.get(baseSym.name);
        if (varTypeOffset) {
          const resolvedType = this.resolveDwarfType(varTypeOffset);
          if (resolvedType && resolvedType.kind === 'array' && resolvedType.arrayCount && index >= 0 && index < resolvedType.arrayCount) {
            const elemTypeOffset = resolvedType.typeOffset;
            const elemType = elemTypeOffset ? this.resolveDwarfType(elemTypeOffset) : null;
            const elemTypeName = elemTypeOffset ? this.getDwarfTypeName(elemTypeOffset) : (elemType?.typeName || elemType?.name || '');
            const elemSize = elemType?.byteSize || 4;
            const elemAddr = baseSym.address + index * elemSize;

            if (!force && !(await this.targetIsHalted())) {
              return { ok: false, error: 'process is running' };
            }
            if (!force) {
              await new Promise<void>(r => setTimeout(r, 100));
            }

            const raw = await this.targetReadMemory(elemAddr, elemSize);
            if (raw) {
              const isFloat = this.isFloatType(elemType);
              let value: number;
              let display: string;
              if (isFloat && raw.length >= (elemType?.byteSize || 4)) {
                value = this.readBytesAsFloat(raw, elemType!.byteSize);
                display = elemType!.byteSize === 8 ? `${value.toExponential(6)}` : `${value.toFixed(6)}`;
              } else {
                const formatted = this.formatScalarValue(raw, elemSize, elemType);
                value = formatted.value;
                display = formatted.display;
              }
              return {
                ok: true,
                data: { expression, value, display, hex: this.formatScalarValue(raw, elemSize, elemType).hex, address: elemAddr, typeName: elemTypeName } as WatchValue,
              };
            }
            return { ok: false, error: `read failed at 0x${elemAddr.toString(16)}` };
          }
        }
      }
    }

    let sym = this.symbols.find(s => s.name === expression);
    if (!sym) {
      sym = this.symbols.find(s => s.name.toLowerCase() === expression.toLowerCase());
    }
    if (!sym) {
      const regName = expression.startsWith('$') ? expression.slice(1) : expression;
      const regIdx = REG_INDEXES[regName.toUpperCase()];
      if (regIdx !== undefined) {
        const val = await this.targetReadRegister(regIdx);
        if (val !== null) {
          return {
            ok: true,
            data: {
              expression, value: val,
              display: val.toString(10),
              hex: `0x${val.toString(16).toUpperCase().padStart(8, '0')}`,
            } as WatchValue,
          };
        }
        return { ok: false, error: `Cannot read register ${regName}` };
      }
      return { ok: false, error: `Symbol not found: ${expression}` };
    }

    if (isRTOS || expression.startsWith('ux') || expression.startsWith('px') || expression.startsWith('x')) {
      log.step(`sym=${sym.name} addr=0x${sym.address.toString(16)} size=${sym.size} type=${sym.type} isHalted=${await this.targetIsHalted()} force=${force}`);
    }

    if (!force && !(await this.targetIsHalted())) {
      log.eval(`doEvaluateExpression: CPU is running, returning running`);
      return { ok: false, error: 'process is running' };
    }

    if (!force) {
      await new Promise<void>(r => setTimeout(r, 100));
    }

    const varTypeOffset = this.dwarfInfo.varToType.get(sym.name);
    log.eval(`doEvaluateExpression: varTypeOffset for "${sym.name}" = ${varTypeOffset || 'none'}`);
    const resolvedType = varTypeOffset ? this.resolveDwarfType(varTypeOffset) : null;
    if (varTypeOffset) {
      log.eval(`doEvaluateExpression: resolvedType kind=${resolvedType?.kind} name=${resolvedType?.name} fields=${resolvedType?.fields?.length || 0}`);
      if (resolvedType && resolvedType.kind === 'struct' && resolvedType.fields && resolvedType.fields.length > 0) {
        const structTypeName = resolvedType.typeName || resolvedType.name || 'struct';
        if (!this.shouldExpandWatchNode(expression, watchContext)) {
          return {
            ok: true,
            data: {
              expression,
              value: 0,
              display: `${structTypeName} @ 0x${sym.address.toString(16).toUpperCase()}`,
              hex: `0x${sym.address.toString(16).toUpperCase()}`,
              address: sym.address,
              typeName: structTypeName,
              hasChildren: true,
            } as WatchValue,
          };
        }
        const readLen = resolvedType.byteSize || sym.size || 4;
        log.eval(`doEvaluateExpression: reading struct memory at 0x${sym.address.toString(16)} len=${readLen}`);
        const raw = await this.targetReadMemory(sym.address, readLen);
        if (raw) {
          log.eval(`doEvaluateExpression: raw bytes length=${raw.length}`);
          const children = await this.evaluateStructFields(raw, resolvedType.fields, resolvedType.typeDefs || this.dwarfInfo.typeDefs, sym.address, expression, 0, watchContext);
          log.eval(`doEvaluateExpression: struct children count=${children.length}`);
          const summary = `${structTypeName} { ${children.map(c => `${c.expression}=${c.display}`).join(', ')} }`;
          return {
            ok: true,
            data: {
              expression,
              value: children[0]?.value ?? 0,
              display: summary,
              hex: '',
              address: sym.address,
              typeName: structTypeName,
              hasChildren: true,
              children,
            } as WatchValue,
          };
        } else {
          log.eval('doEvaluateExpression: raw read returned null, falling back to flat read');
        }
      } else if (resolvedType && resolvedType.kind === 'array') {
        const count = resolvedType.arrayCount || 0;
        const elemTypeOffset = resolvedType.typeOffset;
        const elemType = elemTypeOffset ? this.resolveDwarfType(elemTypeOffset) : null;
        const elemTypeName = elemTypeOffset ? this.getDwarfTypeName(elemTypeOffset) : (elemType?.typeName || elemType?.name || '');
        const arrayTypeName = this.getDwarfTypeName(varTypeOffset) || (elemTypeName ? `${elemTypeName}[${count}]` : `[${count}]`);
        const elemSize = elemType?.byteSize || 4;
        const totalBytes = count * elemSize;
        const readLen = Math.max(totalBytes, sym.size || 4);
        if (!this.shouldExpandWatchNode(expression, watchContext)) {
          return {
            ok: true,
            data: {
              expression,
              value: 0,
              display: `${arrayTypeName} @ 0x${sym.address.toString(16).toUpperCase()}`,
              hex: `0x${sym.address.toString(16).toUpperCase()}`,
              address: sym.address,
              typeName: arrayTypeName,
              hasChildren: count > 0,
            } as WatchValue,
          };
        }
        log.eval(`doEvaluateExpression: reading array memory at 0x${sym.address.toString(16)} count=${count} elemSize=${elemSize} len=${readLen}`);
        const raw = await this.targetReadMemory(sym.address, readLen);
        if (raw) {
          const children: WatchValue[] = [];
          for (let i = 0; i < count; i++) {
            const elemAddr = sym.address + i * elemSize;
            const elemRawOffset = i * elemSize;
            if (elemType?.kind === 'struct' && elemType.fields) {
              const childRaw = raw.slice(elemRawOffset, elemRawOffset + elemSize);
              const elementExpression = `${expression}[${i}]`;
              const structChildren = this.shouldExpandWatchNode(elementExpression, watchContext)
                ? await this.evaluateStructFields(childRaw, elemType.fields, elemType.typeDefs || this.dwarfInfo.typeDefs, elemAddr, elementExpression, 0, watchContext)
                : undefined;
              children.push({
                expression: `[${i}]`,
                value: structChildren?.[0]?.value ?? 0,
                display: structChildren
                  ? `${elemType.name || 'struct'} { ${structChildren.map(c => `${c.expression}=${c.display}`).join(', ')} }`
                  : (elemType.name || 'struct'),
                hex: '',
                address: elemAddr,
                typeName: elemTypeName,
                hasChildren: true,
                children: structChildren,
              });
            } else {
              const end = Math.min(elemRawOffset + elemSize, raw.length);
              const elemRaw = raw.slice(elemRawOffset, end);
              const formatted = this.formatScalarValue(elemRaw, elemSize, elemType);
              children.push({
                expression: `[${i}]`,
                value: formatted.value,
                display: formatted.display,
                hex: formatted.hex,
                address: elemAddr,
                typeName: elemTypeName,
              });
            }
          }
          return {
            ok: true,
            data: {
              expression,
              value: children[0]?.value ?? 0,
              display: children.length > 0
                ? `${count} elems [${children.slice(0, 3).map(c => c.display).join(', ')}${children.length > 3 ? ', ...' : ''}]`
                : `${count} elems`,
              hex: '',
              address: sym.address,
              typeName: arrayTypeName,
              hasChildren: count > 0,
              children,
            } as WatchValue,
          };
        } else {
          log.eval('doEvaluateExpression: array raw read returned null, falling back to flat read');
        }
      } else {
        log.eval(`doEvaluateExpression: not a struct (kind=${resolvedType?.kind}), reading as flat value`);
      }
    } else {
      log.step('doEvaluateExpression: no DWARF type info, reading as flat value');
    }

    const readSize = this.getScalarReadSize(sym.size, resolvedType);
    if (isRTOS || expression.startsWith('ux') || expression.startsWith('px') || expression.startsWith('x')) {
      log.eval(`reading mem addr=0x${sym.address.toString(16)} size=${readSize}`);
    }
    const raw = await this.targetReadMemory(sym.address, readSize);

    if (!raw) {
      if (isRTOS) log.eval(`memory read failed for "${expression}" at 0x${sym.address.toString(16)}`);
      return { ok: false, error: `read failed at 0x${sym.address.toString(16)}` };
    }

    const isFloat = this.isFloatType(resolvedType);

    let value: number;
    let display: string;
    if (isFloat && raw.length >= (resolvedType?.byteSize || 4)) {
      value = this.readBytesAsFloat(raw, resolvedType!.byteSize);
      if (resolvedType!.byteSize === 8) display = `${value.toExponential(6)}`;
      else display = `${value.toFixed(6)}`;
    } else {
      const formatted = this.formatScalarValue(raw, readSize, resolvedType);
      value = formatted.value;
      display = formatted.display;
    }
    let typeName = '';
    if (varTypeOffset) {
      const tn = this.getDwarfTypeName(varTypeOffset);
      if (tn) typeName = tn;
    }

    if (this.shouldUnwrapRuntimeCounter(expression)) {
      const counter = this.formatRuntimeCounterValue(expression, value, sym.address, typeName || 'uint32_t');
      value = counter.value;
      display = counter.display;
    }
    if (isRTOS || expression.startsWith('ux')) {
      log.eval(`read result value=${value} display="${display}"`);
    }

    const pointerHasChildren = resolvedType?.kind === 'pointer'
      && !!resolvedType.typeOffset
      && this.pointerTargetHasChildren(resolvedType.typeOffset);
    const pointerChildren = pointerHasChildren && value && this.shouldExpandWatchNode(expression, watchContext)
      ? await this.evaluatePointerChildren(value, resolvedType!.typeOffset!, expression, 1, watchContext)
      : undefined;

    const hexValue = this.shouldUnwrapRuntimeCounter(expression)
      ? `0x${(this.readUnsignedLittleEndian(raw, readSize) >>> 0).toString(16).toUpperCase().padStart(readSize * 2, '0')}`
      : isFloat
      ? `0x${Array.from(raw.slice(0, readSize)).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase()}`
      : this.formatScalarValue(raw, readSize, resolvedType).hex;

    return {
      ok: true,
      data: {
        expression, value, display,
        hex: hexValue,
        address: sym.address,
        typeName,
        hasChildren: pointerHasChildren,
        children: pointerChildren,
      } as WatchValue,
    };
  }

  private makeNumericWatchValue(expression: string, value: number, typeName: string, isAddress: boolean): WatchValue {
    const normalized = value >>> 0;
    const hex = this.formatAddress(normalized);
    return {
      expression,
      evaluateName: expression,
      value: normalized,
      display: isAddress ? hex : `${normalized}`,
      hex,
      address: isAddress ? normalized : undefined,
      typeName,
    };
  }

  private shouldUnwrapRuntimeCounter(expression: string): boolean {
    return expression === 'ulTotalRunTime' || expression.endsWith('.ulRunTimeCounter') || expression.endsWith('->ulRunTimeCounter');
  }

  private unwrapRuntimeCounter(key: string, rawValue: number): number {
    const raw = rawValue >>> 0;
    const previous = this.runtimeCounterWraps.get(key);
    if (!previous) {
      this.runtimeCounterWraps.set(key, { lastRaw: raw, base: 0 });
      return raw;
    }

    let base = previous.base;
    if (raw < previous.lastRaw) {
      base += 0x1_0000_0000;
    }
    this.runtimeCounterWraps.set(key, { lastRaw: raw, base });
    return base + raw;
  }

  private formatRuntimeCounterValue(expression: string, rawValue: number, address?: number, typeName = 'uint32_t'): WatchValue {
    const raw = rawValue >>> 0;
    const key = this.runtimeCounterKey(expression, address);
    let value = this.unwrapRuntimeCounter(key, raw);
    if (expression === 'ulTotalRunTime') {
      const taskTotal = this.latestTaskRuntimeTotal();
      if (taskTotal > value) value = taskTotal;
    } else if (this.isTaskRuntimeCounterExpression(expression)) {
      this.runtimeTaskCounters.set(key, value);
    }
    const hex = `0x${raw.toString(16).toUpperCase().padStart(8, '0')}`;
    return {
      expression,
      evaluateName: expression,
      value,
      display: value > raw ? `${value}` : `${hex} (${value})`,
      hex,
      address,
      typeName,
    };
  }

  private isTaskRuntimeCounterExpression(expression: string): boolean {
    return expression.endsWith('.ulRunTimeCounter') || expression.endsWith('->ulRunTimeCounter');
  }

  private runtimeCounterKey(expression: string, address?: number): string {
    if (this.isTaskRuntimeCounterExpression(expression) && address !== undefined) {
      return `tcb-runtime@0x${address.toString(16).toUpperCase()}`;
    }
    return expression;
  }

  private latestTaskRuntimeTotal(): number {
    let total = 0;
    for (const value of this.runtimeTaskCounters.values()) {
      if (Number.isFinite(value) && value > 0) total += value;
    }
    return total;
  }

  private formatAddress(value: number): string {
    return `0x${(value >>> 0).toString(16).toUpperCase()}`;
  }

  private evaluateIntegerExpression(expression: string): number | null {
    const expr = expression.trim();
    if (!expr || !/^[\s\dxa-fA-F()+\-*/%<>&|^~]+$/.test(expr)) return null;
    if (!/(?:0x[0-9a-fA-F]+|\d)/.test(expr)) return null;
    try {
      const value = Function(`"use strict"; return (${expr});`)();
      if (typeof value !== 'number' || !Number.isFinite(value)) return null;
      return Math.trunc(value) >>> 0;
    } catch {
      return null;
    }
  }

  private evaluateSizeofExpression(expression: string): number | null {
    const match = expression.match(/^sizeof\s*\(\s*([^)]+?)\s*\)$/);
    if (!match) return null;
    const typeName = this.normalizeTypeName(match[1]);
    const builtin: Record<string, number> = {
      char: 1, int8_t: 1, uint8_t: 1, byte: 1,
      short: 2, int16_t: 2, uint16_t: 2,
      int: 4, unsigned: 4, 'unsigned int': 4, long: 4, 'unsigned long': 4,
      int32_t: 4, uint32_t: 4, float: 4,
      double: 8, int64_t: 8, uint64_t: 8,
    };
    if (builtin[typeName] !== undefined) return builtin[typeName];
    const offset = this.findDwarfTypeOffsetByName(typeName);
    const resolved = offset ? this.resolveDwarfType(offset) : null;
    return resolved?.byteSize || null;
  }

  private async evaluatePointerDereferenceExpression(expression: string): Promise<WatchValue | null> {
    const match = expression.match(/^\*\s*\(\s*([^)]+?)\s*\*\s*\)\s*(.+)$/);
    if (!match) return null;
    const typeName = this.normalizeTypeName(match[1]);
    const address = await this.resolveAddressExpression(match[2]);
    if (address === null) return null;

    const builtinSize = this.getBuiltinTypeSize(typeName);
    const offset = this.findDwarfTypeOffsetByName(typeName);
    const resolved = offset ? this.resolveDwarfType(offset) : null;
    const size = builtinSize || this.getScalarReadSize(resolved?.byteSize, resolved) || 4;
    const raw = await this.targetReadMemory(address, size);
    if (!raw) return null;
    const formatted = this.formatScalarValue(raw, size, resolved || { kind: 'base', name: typeName });
    return {
      expression,
      evaluateName: expression,
      value: formatted.value,
      display: formatted.display,
      hex: formatted.hex,
      address,
      typeName,
    };
  }

  private async evaluateCharPointerExpression(expression: string): Promise<WatchValue | null> {
    const match = expression.match(/^\(\s*(?:const\s+)?char\s*\*\s*\)\s*(.+)$/);
    if (!match) return null;
    const address = await this.resolveAddressExpression(match[1]);
    if (address === null) return null;
    const raw = await this.targetReadMemory(address, 128);
    if (!raw) return null;
    const chars: string[] = [];
    for (const b of raw) {
      if (b === 0) break;
      chars.push((b >= 0x20 && b <= 0x7e) ? String.fromCharCode(b) : '.');
    }
    const text = chars.join('');
    return {
      expression,
      evaluateName: expression,
      value: address,
      display: `"${text}"`,
      hex: `0x${address.toString(16).toUpperCase()}`,
      address,
      typeName: 'char *',
    };
  }

  private async evaluateCastStructExpression(expression: string): Promise<WatchValue | null> {
    const match = expression.match(/^\(\s*\(?\s*(?:struct\s+)?([A-Za-z_]\w*)\s*\*\s*\)?\s*\)\s*(?:\(\s*)?(.+?)(?:\s*\))?$/);
    if (!match) return null;
    const typeName = this.normalizeTypeName(match[1]);
    const address = await this.resolveAddressExpression(match[2]);
    if (address === null) return null;
    return this.evaluateStructAtAddress(expression, typeName, address);
  }

  private async evaluateFieldAccessExpression(expression: string): Promise<WatchValue | null> {
    const match = expression.match(/^(.+?)(->|\.)\s*([A-Za-z_]\w*)$/);
    if (!match) return null;
    const baseExpr = match[1].trim();
    const operator = match[2];
    const fieldName = match[3];
    let base = await this.evaluateCastStructExpression(baseExpr);
    if (!base && !/^[A-Za-z_]\w*$/.test(baseExpr)) {
      // A field chain can itself be the base of a later member access, e.g.
      // pitch->angle_pid->kp. Resolve the shorter left-hand chain first so a
      // pointer-valued intermediate field supplies its evaluated children.
      base = await this.evaluateFieldAccessExpression(baseExpr);
    }
    if (!base && /^[A-Za-z_]\w*$/.test(baseExpr)) {
      const sym = this.symbols.find(s => s.name === baseExpr) || this.symbols.find(s => s.name.toLowerCase() === baseExpr.toLowerCase());
      if (sym) {
        const offset = this.dwarfInfo.varToType.get(sym.name);
        const resolved = offset ? this.resolveDwarfType(offset) : null;
        if (operator === '->' && resolved?.kind === 'pointer' && resolved.typeOffset) {
          const raw = await this.targetReadMemory(sym.address, this.getScalarReadSize(sym.size, resolved));
          const pointeeAddress = raw ? this.readUnsignedLittleEndian(raw, raw.length) >>> 0 : 0;
          if (pointeeAddress) {
            base = await this.evaluateStructAtTypeOffset(baseExpr, resolved.typeOffset, pointeeAddress);
          }
        } else {
          const typeName = offset ? this.getDwarfTypeName(offset) : '';
          base = await this.evaluateStructAtAddress(baseExpr, typeName, sym.address);
        }
      }
    }
    const child = base?.children?.find(c => c.expression === fieldName);
    return child || null;
  }

  private async evaluateStructAtAddress(expression: string, typeName: string, address: number): Promise<WatchValue | null> {
    const offset = this.findDwarfTypeOffsetByName(typeName) || (typeName === 'TCB_t' ? this.findDwarfTypeOffsetByName('tskTaskControlBlock') : undefined);
    if (!offset) return null;
    return this.evaluateStructAtTypeOffset(expression, offset, address);
  }

  private async evaluateStructAtTypeOffset(expression: string, typeOffset: string, address: number): Promise<WatchValue | null> {
    const typeName = this.getDwarfTypeName(typeOffset);
    const offset = typeOffset;
    const resolved = offset ? this.resolveDwarfType(offset) : null;
    if (!resolved || resolved.kind !== 'struct' || !resolved.fields || !resolved.byteSize) return null;
    const raw = await this.targetReadMemory(address, resolved.byteSize);
    if (!raw) return null;
    const children = await this.evaluateStructFields(raw, resolved.fields, resolved.typeDefs || this.dwarfInfo.typeDefs, address, expression, 0);
    return {
      expression,
      evaluateName: expression,
      value: address,
      display: `${typeName || resolved.name} @ 0x${address.toString(16).toUpperCase()}`,
      hex: `0x${address.toString(16).toUpperCase()}`,
      address,
      typeName: typeName || resolved.name,
      children,
    };
  }

  private async resolveAddressExpression(expression: string): Promise<number | null> {
    const expr = expression.trim().replace(/^\((.*)\)$/, '$1').trim();
    const integer = this.evaluateIntegerExpression(expr);
    if (integer !== null) return integer;
    const addrOf = expr.match(/^&\s*([A-Za-z_]\w*)$/);
    if (addrOf) {
      const sym = this.symbols.find(s => s.name === addrOf[1]) || this.symbols.find(s => s.name.toLowerCase() === addrOf[1].toLowerCase());
      return sym?.address ?? null;
    }
    const sym = this.symbols.find(s => s.name === expr) || this.symbols.find(s => s.name.toLowerCase() === expr.toLowerCase());
    if (sym) {
      const raw = await this.targetReadMemory(sym.address, Math.max(1, Math.min(sym.size || 4, 4)));
      return raw ? this.readUnsignedLittleEndian(raw, raw.length) >>> 0 : sym.address;
    }
    const field = await this.evaluateFieldAccessExpression(expr);
    // For fields that have an address (arrays, struct members), use that memory
    // address rather than the scalar value (which for char arrays is the first
    // character, not the address of the string).
    if (field) {
      if (field.address !== undefined) return field.address >>> 0;
      if (field.children && field.children.length > 0) return field.address ?? (field.value >>> 0);
      return field.value >>> 0;
    }
    return null;
  }

  private normalizeTypeName(typeName: string): string {
    return typeName
      .replace(/\b(const|volatile|struct|class|enum)\b/g, '')
      .replace(/\*/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private getBuiltinTypeSize(typeName: string): number {
    const normalized = this.normalizeTypeName(typeName);
    if (/^(char|int8_t|uint8_t|byte)$/.test(normalized)) return 1;
    if (/^(short|int16_t|uint16_t)$/.test(normalized)) return 2;
    if (/^(int|unsigned|unsigned int|long|unsigned long|int32_t|uint32_t|float)$/.test(normalized)) return 4;
    if (/^(double|int64_t|uint64_t)$/.test(normalized)) return 8;
    return 0;
  }

  private findDwarfTypeOffsetByName(typeName: string): string | undefined {
    const normalized = this.normalizeTypeName(typeName);
    for (const [offset, info] of this.dwarfInfo.typeDefs) {
      if (this.normalizeTypeName(info.name || '') === normalized) return offset;
      const formatted = this.normalizeTypeName(this.getDwarfTypeName(offset));
      if (formatted === normalized) return offset;
    }
    return undefined;
  }

  private isFloatType(info: { kind?: string; encoding?: string; name?: string } | null): boolean {
    if (!info) return false;
    if (info.kind !== 'base') return false;
    const enc = (info.encoding || '').toLowerCase();
    return enc.includes('float') || enc === '4' || enc === '0x4';
  }

  private isSignedIntegerType(info: { kind?: string; encoding?: string; name?: string; typeName?: string } | null): boolean {
    if (!info || info.kind !== 'base') return false;
    const enc = (info.encoding || '').toLowerCase();
    const name = `${info.typeName || ''} ${info.name || ''}`.trim().toLowerCase();
    if (enc.includes('unsigned') || (name.startsWith('uint') && /^uint\d*_?t?\b/.test(name))) return false;
    return enc.includes('signed') || enc === '5' || enc === '0x5' || /^int\d+_t\b/.test(name) || name.includes('short') || name === 'int';
  }

  private getScalarReadSize(symbolSize: number | undefined, info: { byteSize?: number } | null): number {
    const typeSize = info?.byteSize || 0;
    const size = typeSize > 0 ? typeSize : (symbolSize && symbolSize > 0 ? symbolSize : 4);
    return Math.max(1, Math.min(size, 8));
  }

  private readUnsignedLittleEndian(raw: Uint8Array, byteSize: number): number {
    const count = Math.min(byteSize, raw.length);
    let value = 0;
    let factor = 1;
    for (let i = 0; i < count; i++) {
      value += raw[i] * factor;
      factor *= 256;
    }
    return value;
  }

  private formatScalarValue(raw: Uint8Array, byteSize: number, info: { kind?: string; encoding?: string; name?: string; typeName?: string } | null): { value: number; display: string; hex: string } {
    const unsigned = this.readUnsignedLittleEndian(raw, byteSize);
    let value = unsigned;
    if (this.isSignedIntegerType(info)) {
      const bits = byteSize * 8;
      const signBit = 2 ** (bits - 1);
      const range = 2 ** bits;
      if (unsigned >= signBit) value = unsigned - range;
    }

    const hex = `0x${unsigned.toString(16).toUpperCase().padStart(byteSize * 2, '0')}`;
    return { value, display: `${hex} (${value})`, hex };
  }

  private readBytesAsFloat(raw: Uint8Array, byteSize: number): number {
    if (raw.length < byteSize) return 0;
    const buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + byteSize);
    const dv = new DataView(buf);
    if (byteSize === 8) return dv.getFloat64(0, true);
    return dv.getFloat32(0, true);
  }

  private resolveDwarfType(offset: string, visited?: Set<string>): { kind: string; name: string; byteSize: number; fields?: DwarfField[]; typeDefs?: Map<string, DwarfTypeInfo>; typeName?: string; typeOffset?: string; arrayCount?: number; encoding?: string } | null {
    if (!visited) visited = new Set();
    if (visited.has(offset)) return null;
    visited.add(offset);
    const info = this.dwarfInfo.typeDefs.get(offset);
    if (!info) return null;
    if ((info.kind === 'typedef' || info.kind === 'const' || info.kind === 'volatile' || info.kind === 'restrict') && info.typeOffset) {
      const resolved = this.resolveDwarfType(info.typeOffset, visited);
      if (resolved) return { ...resolved, typeName: info.name || resolved.typeName || resolved.name };
      return { kind: info.kind, name: info.name, byteSize: 0, typeName: info.name };
    }
    if (info.kind === 'struct') {
      return { kind: 'struct', name: info.name, byteSize: info.byteSize, fields: info.fields, typeDefs: this.dwarfInfo.typeDefs };
    }
    return { kind: info.kind, name: info.name, byteSize: info.byteSize, typeName: info.name, typeOffset: info.typeOffset, arrayCount: info.arrayCount, encoding: info.encoding };
  }

  private formatDwarfTypeName(offset?: string, visited: Set<string> = new Set()): string {
    if (!offset || visited.has(offset)) return '';
    visited.add(offset);
    const info = this.dwarfInfo.typeDefs.get(offset);
    if (!info) return '';

    if (info.kind === 'typedef') {
      return info.name || this.formatDwarfTypeName(info.typeOffset, visited);
    }

    if (info.kind === 'const' || info.kind === 'volatile' || info.kind === 'restrict') {
      return this.formatDwarfTypeName(info.typeOffset, visited);
    }

    if (info.kind === 'array') {
      const elemName = this.formatDwarfTypeName(info.typeOffset, visited);
      const suffix = info.arrayCount && info.arrayCount > 0 ? `[${info.arrayCount}]` : '[]';
      return `${elemName || 'unknown'}${suffix}`;
    }

    if (info.kind === 'pointer') {
      const pointeeName = this.formatDwarfTypeName(info.typeOffset, visited);
      return pointeeName ? `${pointeeName}*` : 'void*';
    }

    return info.name || '';
  }

  private getDwarfTypeName(offset: string): string {
    const formatted = this.formatDwarfTypeName(offset);
    if (formatted) return formatted;
    const resolved = this.resolveDwarfType(offset);
    return resolved?.typeName || resolved?.name || '';
  }

  private shouldExpandWatchNode(expression: string, context?: WatchEvaluationContext): boolean {
    return context?.expandedExpressions === undefined || context.expandedExpressions.has(expression);
  }

  private pointerTargetHasChildren(typeOffset: string): boolean {
    const resolved = this.resolveDwarfType(typeOffset);
    return resolved?.kind === 'struct' && !!resolved.fields?.length;
  }

  private async evaluateStructFields(
    raw: Uint8Array,
    fields: DwarfField[],
    typeDefs: Map<string, DwarfTypeInfo>,
    baseAddress: number,
    parentExpr = '',
    _depth = 0,
    watchContext?: WatchEvaluationContext,
  ): Promise<WatchValue[]> {
    const values: WatchValue[] = [];
    for (const field of fields) {
      values.push(await this.evaluateSingleField(raw, field, typeDefs, baseAddress, parentExpr, _depth, watchContext));
    }
    return values;
  }

  /** Max depth for pointer chasing — prevents stack overflow on circular lists (FreeRTOS pxNext/pxPrevious). */
  private static readonly MAX_POINTER_DEPTH = 5;

  private async evaluatePointerChildren(
    address: number,
    typeOffset: string,
    parentExpr = '',
    _depth = 1,
    watchContext?: WatchEvaluationContext,
  ): Promise<WatchValue[] | undefined> {
    if (_depth > OzoneBackend.MAX_POINTER_DEPTH) return undefined;
    const pointee = this.resolveDwarfType(typeOffset);
    if (!pointee || pointee.kind !== 'struct' || !pointee.fields || !pointee.byteSize) return undefined;
    const raw = await this.targetReadMemory(address, pointee.byteSize);
    if (!raw) return undefined;
    return this.evaluateStructFields(raw, pointee.fields, pointee.typeDefs || this.dwarfInfo.typeDefs, address, parentExpr, _depth, watchContext);
  }

  private async evaluateSingleField(
    raw: Uint8Array,
    field: DwarfField,
    typeDefs: Map<string, DwarfTypeInfo>,
    baseAddress: number,
    parentExpr = '',
    _depth = 0,
    watchContext?: WatchEvaluationContext,
  ): Promise<WatchValue> {
    const addr = baseAddress + field.byteOffset;
    const evaluateName = parentExpr ? `${parentExpr}.${field.name}` : field.name;
    const resolved = this.resolveDwarfType(field.typeOffset);
    const resolvedKind = resolved?.kind || '';
    const resolvedName = resolved?.name || '';
    const resolvedByteSize = resolved?.byteSize || 0;
    const resolvedTypeName = this.getDwarfTypeName(field.typeOffset) || resolvedName;

    if (resolvedKind === 'struct' && resolved?.fields) {
      const childRaw = resolvedByteSize > 0
        ? raw.slice(field.byteOffset, field.byteOffset + resolvedByteSize)
        : raw;
      const children = this.shouldExpandWatchNode(evaluateName, watchContext)
        ? await this.evaluateStructFields(childRaw, resolved.fields, typeDefs, addr, evaluateName, _depth, watchContext)
        : undefined;
      const summary = children
        ? `${resolvedTypeName || 'struct'} { ${children.map(c => `${c.expression}=${c.display}`).join(', ')} }`
        : (resolvedTypeName || 'struct');
      return {
        expression: field.name,
        evaluateName,
        value: children?.[0]?.value ?? 0,
        display: summary,
        hex: '',
        address: addr,
        typeName: resolvedTypeName,
        hasChildren: resolved.fields.length > 0,
        children,
      };
    }

    if (resolvedKind === 'array') {
      const count = resolved?.arrayCount || 0;
      const elemTypeOffset = resolved?.typeOffset;
      const elemType = elemTypeOffset ? this.resolveDwarfType(elemTypeOffset) : null;
      const elemTypeName = elemTypeOffset ? this.getDwarfTypeName(elemTypeOffset) : (elemType?.typeName || elemType?.name || '');
      const arrayTypeName = this.getDwarfTypeName(field.typeOffset) || (elemTypeName ? `${elemTypeName}[${count}]` : `[${count}]`);
      const elemSize = elemType?.byteSize || 4;
      const totalBytes = count * elemSize;
      if (!this.shouldExpandWatchNode(evaluateName, watchContext)) {
        return {
          expression: field.name,
          evaluateName,
          value: 0,
          display: `${count} elems`,
          hex: '',
          address: addr,
          typeName: arrayTypeName,
          hasChildren: count > 0,
        };
      }
      const arrRaw = raw.length >= field.byteOffset + totalBytes
        ? raw.slice(field.byteOffset, field.byteOffset + totalBytes)
        : new Uint8Array(0);

      const children: WatchValue[] = [];
      for (let i = 0; i < count; i++) {
        const elemAddr = addr + i * elemSize;
        const elemRawOffset = i * elemSize;
        if (elemType?.kind === 'struct' && elemType.fields) {
          const childRaw = arrRaw.slice(elemRawOffset, elemRawOffset + elemSize);
          const elementExpression = `${evaluateName}[${i}]`;
          const structChildren = this.shouldExpandWatchNode(elementExpression, watchContext)
            ? await this.evaluateStructFields(childRaw, elemType.fields, elemType.typeDefs || this.dwarfInfo.typeDefs, elemAddr, elementExpression, _depth, watchContext)
            : undefined;
          children.push({
            expression: `[${i}]`,
            evaluateName: `${evaluateName}[${i}]`,
            value: structChildren?.[0]?.value ?? 0,
            display: structChildren
              ? `${elemType.name || 'struct'} { ${structChildren.map(c => `${c.expression}=${c.display}`).join(', ')} }`
              : (elemType.name || 'struct'),
            hex: '',
            address: elemAddr,
            typeName: elemTypeName,
            hasChildren: elemType.fields.length > 0,
            children: structChildren,
          });
        } else {
          const end = Math.min(elemRawOffset + elemSize, arrRaw.length);
          const elemRaw = arrRaw.slice(elemRawOffset, end);
          const isFloatArrElem = this.isFloatType(elemType);
          let value: number;
          let display: string;
          let hex: string;
          if (isFloatArrElem && elemRaw.length >= elemSize) {
            value = this.readBytesAsFloat(elemRaw, elemSize);
            display = elemSize === 8 ? `${value.toExponential(6)}` : `${value.toFixed(6)}`;
            hex = `0x${Array.from(elemRaw).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
          } else {
            const formatted = this.formatScalarValue(elemRaw, elemSize, elemType);
            value = formatted.value;
            display = formatted.display;
            hex = formatted.hex;
          }
          const elementExpression = `${evaluateName}[${i}]`;
          const pointerHasChildren = elemType?.kind === 'pointer'
            && !!elemType.typeOffset
            && this.pointerTargetHasChildren(elemType.typeOffset);
          const pointerChildren = pointerHasChildren && value && this.shouldExpandWatchNode(elementExpression, watchContext)
            ? await this.evaluatePointerChildren(value >>> 0, elemType!.typeOffset!, elementExpression, _depth + 1, watchContext)
            : undefined;
          children.push({
            expression: `[${i}]`,
            evaluateName: `${evaluateName}[${i}]`,
            value,
            display: elemType?.kind === 'pointer' ? this.formatAddress(value) : display,
            hex,
            address: elemAddr,
            typeName: elemTypeName,
            hasChildren: pointerHasChildren,
            children: pointerChildren,
          });
        }
      }

      return {
        expression: field.name,
        evaluateName,
        value: children[0]?.value ?? 0,
        display: children.length > 0
          ? `${count} elems [${children.slice(0, 3).map(c => c.display).join(', ')}${children.length > 3 ? ', ...' : ''}]`
          : `${count} elems`,
        hex: '',
        address: addr,
        typeName: arrayTypeName,
        hasChildren: count > 0,
        children,
      };
    }

    const fieldSize = resolvedByteSize || 4;
    const fieldEnd = Math.min(field.byteOffset + fieldSize, raw.length);
    const fieldRaw = raw.slice(field.byteOffset, fieldEnd);

    const isFloat = this.isFloatType(resolved);

    let value: number;
    let display: string;
    let hex: string;
    if (isFloat && fieldRaw.length >= fieldSize) {
      value = this.readBytesAsFloat(fieldRaw, fieldSize);
      display = fieldSize === 8 ? `${value.toExponential(6)}` : `${value.toFixed(6)}`;
      hex = `0x${Array.from(fieldRaw).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
    } else {
      const formatted = this.formatScalarValue(fieldRaw, fieldSize, resolved);
      value = formatted.value;
      display = formatted.display;
      hex = formatted.hex;
    }

    if (field.name === 'ulRunTimeCounter') {
      const counter = this.formatRuntimeCounterValue(evaluateName, value, addr, resolvedTypeName || 'uint32_t');
      value = counter.value;
      display = counter.display;
      hex = counter.hex;
    }

    const pointerHasChildren = resolvedKind === 'pointer'
      && !!resolved?.typeOffset
      && this.pointerTargetHasChildren(resolved.typeOffset);
    const pointerChildren = pointerHasChildren && value && this.shouldExpandWatchNode(evaluateName, watchContext)
      ? await this.evaluatePointerChildren(value >>> 0, resolved!.typeOffset!, evaluateName, _depth + 1, watchContext)
      : undefined;

    return {
      expression: field.name,
      evaluateName,
      value,
      display: resolvedKind === 'pointer' ? this.formatAddress(value) : display,
      hex,
      address: addr,
      typeName: resolvedTypeName,
      hasChildren: pointerHasChildren,
      children: pointerChildren,
    };
  }

  async readVariableAtRuntime(variableName: string): Promise<OzoneCommandResult> {
    const wasRunning = !(await this.targetIsHalted());
    log.eval(`readVariableAtRuntime: "${variableName}" wasRunning=${wasRunning}`);
    if (wasRunning) {
      const halted = await this.ensureHalted();
      if (!halted) return { ok: false, error: 'halt failed' };
    } else {
      await new Promise<void>(r => setTimeout(r, 100));
    }
    const result = await this.doEvaluateExpression(variableName, false);
    if (wasRunning) {
      await this.targetRun();
    }
    return result;
  }

  private async doWriteMemory(address: number, data: number[]): Promise<OzoneCommandResult> {
    log.eval(`doWriteMemory: addr=0x${address.toString(16)} len=${data.length}`);
    const wasRunning = !(await this.targetIsHalted());
    if (wasRunning) {
      const halted = await this.targetHalt();
      if (!halted) return { ok: false, error: 'halt failed' };
      await new Promise<void>(r => setTimeout(r, 50));
    }
    const ok = await this.targetWriteMemory(address, Uint8Array.from(data.map(b => b & 0xFF)));
    if (wasRunning) {
      await this.targetRun();
    }
    return ok
      ? { ok: true, data: `Wrote ${data.length} byte(s)` }
      : { ok: false, error: 'write failed' };
  }

  private async doSetWatchValue(expression: string, value: number, address?: number, typeName?: string): Promise<OzoneCommandResult> {
    log.eval(`doSetWatchValue: "${expression}" = ${value}`);

    let sym = this.symbols.find(s => s.name === expression);
    if (!sym) {
      sym = this.symbols.find(s => s.name.toLowerCase() === expression.toLowerCase());
    }
    const writeAddress = sym?.address ?? address;
    if (writeAddress === undefined) {
      return { ok: false, error: `Symbol not found: ${expression}` };
    }

    const wasRunning = !(await this.targetIsHalted());
    if (wasRunning) {
      const halted = await this.ensureHalted();
      if (!halted) return { ok: false, error: 'halt failed' };
    }

    const varTypeOffset = sym ? this.dwarfInfo.varToType.get(sym.name) : undefined;
    const resolvedType = varTypeOffset ? this.resolveDwarfType(varTypeOffset) : null;
    const normalizedTypeName = this.normalizeTypeName(typeName || '');
    const requestedTypeOffset = normalizedTypeName ? this.findDwarfTypeOffsetByName(normalizedTypeName) : undefined;
    const requestedType = requestedTypeOffset ? this.resolveDwarfType(requestedTypeOffset) : null;
    const requestedTypeSize = typeName ? this.getBuiltinTypeSize(typeName) : 0;
    const valueType = requestedType || resolvedType;
    const writeSize = Math.max(Math.min(requestedTypeSize || valueType?.byteSize || sym?.size || 4, 8), 1);
    const buf = new Uint8Array(writeSize);
    const isFloat = this.isFloatType(valueType) || /^(float|float32_t|fp32|double|float64_t|fp64)$/.test(normalizedTypeName);
    if (isFloat) {
      const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      if (writeSize === 8) view.setFloat64(0, value, true);
      else view.setFloat32(0, value, true);
    } else {
      let temp = value >>> 0;
      for (let i = 0; i < writeSize; i++) {
        buf[i] = temp & 0xFF;
        temp >>>= 8;
      }
    }

    const ok = await this.targetWriteMemory(writeAddress, buf);

    if (wasRunning) await this.targetRun();
    await new Promise<void>(r => setTimeout(r, 50));
    return ok
      ? { ok: true, data: { expression, value } }
      : { ok: false, error: 'write failed' };
  }

  cancelFlash(reason?: string) {
    cancelActiveFlashes(reason);
  }

  async dispose(graceful = false): Promise<void> {
    this.clearNativeStopInfo('backend dispose');
    cancelActiveFlashes('backend disposed');
    if (this.sessionTarget) await this.sessionTarget.dispose(graceful);
    else this.jlink.disconnect();
  }
}
