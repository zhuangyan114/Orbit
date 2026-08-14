import {
  OzoneCommand, OzoneCommandResult,
  DebugSessionConfig, RegisterValue, Variable,
  DebugProbe,
  StackFrame, MemoryBlock, TargetState, WatchValue,
  FastDataSamplePlanItem, FastDataSampleSpec,
} from './types';
import { cancelActiveFlashes, flashElf } from './flasher';
import { CmsisDapFlashOptions } from './cmsis-dap-flasher';
import { JLinkDLL } from './jlink-dll';
import { SessionTargetOwner, SessionTargetSelector } from './session-target-channel';
import { readElfSymbols, SymbolInfo, findSymbol, preloadLineMappings, preloadAddressMappings, parseDwarfTypeInfo, DwarfInfo, DwarfTypeInfo, DwarfField, OBJDUMP_EXE, LineMappingByFile, resolveMappedStatementAddress } from './jlink-symbols';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { log } from '../utils/logger';
import { BoundedMetric } from '../utils/bounded-metric';
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
  signal?: AbortSignal;
  priority?: 'watch' | 'timeline' | 'background';
}

class EvaluateCancelledError extends Error {
  constructor() {
    super('EvaluateCancelled: expression evaluation was cancelled');
    this.name = 'EvaluateCancelledError';
  }
}

interface SourceStatementRange {
  startLine: number;
  endLine: number;
}

function invalidConfiguration(field: string, allowed: string, value: unknown): OzoneCommandResult {
  const received = typeof value === 'string' ? `"${value}"` : String(value);
  return {
    ok: false,
    errorCode: 'InvalidConfiguration',
    error: `InvalidConfiguration: ${field} must be one of ${allowed}; received ${received}`,
  };
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
  private stepProfileSeq = 0;
  private activeStepProfile: { id: number; kind: 'stepOver' | 'stepInto' | 'stepOut'; start: number } | null = null;
  private nativeStepsEnabled = { stepInto: false, stepOver: false, stepOut: false };
  private lastNativeStopInfo: NativeStopInfo | null = null;
  private readonly sessionTarget?: SessionTargetOwner | SessionTargetSelector;
  private readonly sessionBreakpointSlots: (number | null)[] = [];
  private symbolGeneration = 0;
  private sessionGeneration = 0;
  private readonly fastPlanCache = new Map<string, FastDataSamplePlanItem[]>();
  private readonly planBuildElapsed = new BoundedMetric(2_048);
  private planCacheHit = 0;
  private planCacheMiss = 0;
  private planCacheInvalidation = 0;

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

  get hasTargetConnection(): boolean {
    if (this.sessionTarget) {
      return 'ownerKind' in this.sessionTarget
        ? this.sessionTarget.ownerKind !== 'none'
        : true;
    }
    return this.jlink.connected
      && this.state !== TargetState.Disconnected
      && this.state !== TargetState.Error;
  }

  private async targetHalt(): Promise<boolean> {
    if (!this.sessionTarget) return this.jlink.halt();
    const result = await this.sessionTarget.halt();
    return result.ok;
  }

  private async targetHaltResult(): Promise<CppJLinkResult> {
    if (this.sessionTarget) return this.sessionTarget.halt();
    const ok = this.jlink.halt();
    return {
      ok,
      message: ok ? 'J-Link target halted' : 'J-Link halt failed',
      targetState: ok ? 'Halted' : 'Error',
      elapsedMs: 0,
    };
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

  private targetRegisterSource(): string {
    if (!this.sessionTarget) return 'legacyJLinkDLL';
    const ownerKind = 'ownerKind' in this.sessionTarget
      ? this.sessionTarget.ownerKind
      : this.sessionTarget.kind;
    return `sessionTarget/${ownerKind}`;
  }

  private async targetReadMemory(
    address: number,
    size: number,
    priority: 'watch' | 'timeline' | 'background' = 'watch',
    signal?: AbortSignal,
  ): Promise<Uint8Array | null> {
    const result = await this.targetReadMemoryResult(address, size, priority, signal);
    return result.ok && result.data ? result.data.bytes : null;
  }

  private async targetReadMemoryResult(
    address: number,
    size: number,
    priority: 'watch' | 'timeline' | 'background' = 'watch',
    signal?: AbortSignal,
  ): Promise<CppJLinkResult<{ bytes: Uint8Array }>> {
    if (signal?.aborted) {
      return { ok: false, errorCode: 'TargetReadCancelled', message: 'target read cancelled', targetState: 'Unknown', elapsedMs: 0 };
    }
    if (this.sessionTarget) {
      return this.sessionTarget.readMemory(address, size, signal ? { priority, signal } : { priority });
    }
    const started = Date.now();
    const bytes = this.jlink.readMemory(address, size);
    if (bytes) {
      return {
        ok: true,
        message: 'J-Link memory read',
        targetState: 'Unknown',
        elapsedMs: Date.now() - started,
        data: { bytes },
      };
    }
    return {
      ok: false,
      message: `J-Link failed to read ${size} bytes at 0x${address.toString(16)}`,
      errorCode: 'MemoryReadFailed',
      targetState: 'Unknown',
      elapsedMs: Date.now() - started,
      diagnostics: { ownerKind: 'jlink-legacy', operation: 'readMemory', phase: 'targetRead' },
    };
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

  private async targetStartRtt(controlBlockAddress?: number): Promise<CppJLinkResult<any>> {
    if (!this.sessionTarget) {
      const ok = this.jlink.startRtt(controlBlockAddress);
      return ok
        ? { ok: true, message: 'RTT started', targetState: 'Unknown', elapsedMs: 0, data: {} }
        : { ok: false, message: 'legacy RTT start failed', errorCode: 'JLinkCallFailed', targetState: 'Error', elapsedMs: 0 };
    }
    return this.sessionTarget.startRtt(controlBlockAddress);
  }

  private async targetStopRtt(): Promise<CppJLinkResult<any>> {
    if (!this.sessionTarget) {
      this.jlink.stopRtt();
      return { ok: true, message: 'RTT stopped', targetState: 'Unknown', elapsedMs: 0, data: {} };
    }
    return this.sessionTarget.stopRtt();
  }

  private async targetReadRtt(
    bufferIndex: number,
    size: number,
    signal?: AbortSignal,
  ): Promise<CppJLinkResult<{ bytes: Uint8Array }>> {
    if (!this.sessionTarget) {
      const bytes = this.jlink.readRtt(bufferIndex, size);
      return bytes
        ? { ok: true, message: 'RTT read', targetState: 'Unknown', elapsedMs: 0, data: { bytes } }
        : { ok: false, message: 'legacy RTT read failed', errorCode: 'JLinkCallFailed', targetState: 'Error', elapsedMs: 0 };
    }
    return this.sessionTarget.readRtt(bufferIndex, size, { priority: 'background', signal });
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
        && command.cmd !== 'resolveSymbol'
        && command.cmd !== 'searchSymbols'
        && command.cmd !== 'prepareFastDataSampling'
        && command.cmd !== 'getPerformanceDiagnostics') {
        return { ok: false, error: 'Target access is owned by the active ozone DAP session' };
      }
      switch (command.cmd) {
        case 'connect':
          return await this.doConnect(command.config);
        case 'disconnect':
          return this.doDisconnect();
        case 'halt':
          this.clearNativeStopInfo('legacy halt requested');
          if (this.isCmsisDapOwner()) return this.ownerControlResult(await this.sessionTarget!.halt(), 'Halted', 'halt');
          return (await this.targetHalt())
            ? (this.state = TargetState.Halted, { ok: true, data: 'Halted' })
            : { ok: false, error: 'Halt failed' };
        case 'run':
          this.clearNativeStopInfo('legacy run requested');
          if (this.isCmsisDapOwner()) return this.ownerControlResult(await this.sessionTarget!.run(), 'Running', 'run');
          return (await this.targetRun())
            ? (this.state = TargetState.Running, { ok: true, data: 'Running' })
            : { ok: false, error: 'Run failed' };
        case 'stepOver':
          if (this.isCmsisDapOwner()) return await this.doCmsisDapStepOver();
          return await this.profileStepCommand('stepOver', () => this.doStepOver());
        case 'stepInto':
          if (this.isCmsisDapOwner()) return await this.doCmsisDapStepInto();
          return await this.profileStepCommand('stepInto', () => this.doStepInto());
        case 'stepIntoInstruction':
          return await this.doStepIntoInstruction();
        case 'stepOut':
          if (this.isCmsisDapOwner()) return await this.doCmsisDapStepOut();
          return await this.profileStepCommand('stepOut', () => this.doStepOut());
        case 'reset':
          this.clearNativeStopInfo('reset requested');
          if (this.isCmsisDapOwner()) return this.ownerControlResult(await this.sessionTarget!.reset(), 'Reset', 'reset');
          return (await this.targetReset())
            ? { ok: true, data: 'Reset' }
            : { ok: false, error: 'Reset failed' };
        case 'runToEntryPoint':
          return await this.doRunToEntryPoint(command.symbol, command.reset);
        case 'setBreakpoint':
          return await this.doSetBreakpoint(command.file, command.line, command.condition);
        case 'clearBreakpoint':
          return await this.doClearBreakpoint(command.id);
        case 'clearAllBreakpoints':
          if (this.isCmsisDapOwner()) return await this.doClearAllCmsisDapBreakpoints();
          if (!(await this.targetClearAllBreakpoints())) return { ok: false, error: 'Clear all breakpoints failed' };
          this.tempBreakpoint = null;
          this.stepOverClearedBps = [];
          return { ok: true, data: 'All breakpoints cleared' };
        case 'getRegisters':
          return await this.doGetRegisters(command.signal);
        case 'getLocals':
          return await this.doGetLocals(command.signal);
        case 'getCallStack':
          return await this.doGetCallStack();
        case 'readMemory':
          return await this.doReadMemory(command.address, command.size, command.signal);
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
          return await this.doFlash(command.elfPath, command.device, command.interface, command.speedKHz,
            command.signal, command.probe, command.flashBeforeDebug, command.cmsisDapFlashAlgorithmPath, command.verify);
case 'readVariableRuntime':
          return await this.readVariableAtRuntime(command.name);
        case 'clearBreakpointAtAddr':
          return this.doClearBreakpointAtAddr(command.addr);
        case 'setBreakpointAtAddr':
          return this.doSetBreakpointAtAddr(command.addr);
        case 'evaluateExpression': {
          const watchContext = command.expandedExpressions === undefined && !command.signal && !command.priority
            ? undefined
            : {
              expandedExpressions: command.expandedExpressions === undefined
                ? undefined
                : new Set(command.expandedExpressions),
              signal: command.signal,
              priority: command.priority,
            };
          try {
            return await this.doEvaluateExpression(command.expression, command.force, watchContext);
          } catch (error) {
            if (error instanceof EvaluateCancelledError) {
              return {
                ok: false,
                errorCode: 'EvaluateCancelled',
                error: error.message,
                targetState: this.state,
              };
            }
            throw error;
          }
        }
        case 'prepareFastDataSampling':
          return { ok: true, data: this.prepareFastDataSampling(command.expressions) };
        case 'readFastDataSampling':
          return { ok: true, data: await this.readFastDataSampling(command.specs, command.priority) };
        case 'getPerformanceDiagnostics':
          return {
            ok: true,
            data: {
              owner: this.targetRegisterSource(),
              planner: {
                planCacheHit: this.planCacheHit,
                planCacheMiss: this.planCacheMiss,
                planCacheInvalidation: this.planCacheInvalidation,
                planBuildElapsed: this.planBuildElapsed.snapshot(),
                cacheEntries: this.fastPlanCache.size,
                symbolGeneration: this.symbolGeneration,
                sessionGeneration: this.sessionGeneration,
              },
              ...(this.sessionTarget?.getPerformanceDiagnostics?.() || {
                helperRpcElapsedMs: null,
                helperProcessingMs: null,
                cmsisDap: null,
              }),
            },
          };
        case 'writeMemory':
          return await this.doWriteMemory(command.address, command.data);
        case 'setWatchValue':
          return await this.doSetWatchValue(command.expression, command.value, command.address, command.typeName);
        case 'startRtt':
          {
            const result = await this.targetStartRtt(command.controlBlockAddress);
            if (!result.ok) return this.sessionOwnerFailure(result, 'RttStartFailed');
            return {
              ok: true,
              data: result.data ?? 'RTT started',
              message: result.message,
              targetState: result.targetState,
              elapsedMs: result.elapsedMs,
              diagnostics: result.diagnostics,
            };
          }
        case 'stopRtt':
          {
            const result = await this.targetStopRtt();
            if (!result.ok) return this.sessionOwnerFailure(result, 'RttStopFailed');
            return {
              ok: true,
              data: result.data ?? 'RTT stopped',
              message: result.message,
              targetState: result.targetState,
              elapsedMs: result.elapsedMs,
              diagnostics: result.diagnostics,
            };
          }
        case 'readRtt': {
          const result = await this.targetReadRtt(command.bufferIndex, command.size, command.signal);
          if (!result.ok) return this.sessionOwnerFailure(result, 'RttReadFailed');
          return {
            ok: true,
            data: { bytes: Array.from(result.data?.bytes || []) },
            message: result.message,
            targetState: result.targetState,
            elapsedMs: result.elapsedMs,
            diagnostics: result.diagnostics,
          };
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
    this.symbolGeneration++;
    this.invalidateFastPlan('ELF/symbol reload');
    return { ok: true, data: `Loaded ${this.symbols.length} symbols` };
        case 'resolveSymbol': {
          if (!this.elfPath || this.symbols.length === 0) {
            return {
              ok: false,
              errorCode: 'SymbolsUnavailable',
              error: 'SymbolsUnavailable: no ELF symbols are loaded',
            };
          }
          const byName = command.name !== undefined ? this.findSymbolByName(command.name) : undefined;
          const byAddress = command.address !== undefined ? this.findSymbolByAddress(command.address) : undefined;
          const symbol = byName ?? byAddress;
          if (!symbol || !Number.isFinite(symbol.address)) {
            return {
              ok: false,
              errorCode: 'SymbolNotFound',
              error: `SymbolNotFound: ${command.name ?? `0x${command.address?.toString(16)}`}`,
            };
          }
          const exact = command.name !== undefined
            ? symbol.name === command.name
            : (symbol.address >>> 0) === (command.address! >>> 0);
          log.eval(`resolveSymbol name=${command.name ?? ''} address=${command.address ?? '0x0'} -> ${symbol.name} source=elf exact=${exact}`);
          return {
            ok: true,
            data: { name: symbol.name, address: symbol.address, size: symbol.size, type: symbol.type, exact },
          };
        }
        case 'searchSymbols': {
          if (!this.elfPath || this.symbols.length === 0) {
            return {
              ok: false,
              errorCode: 'SymbolsUnavailable',
              error: 'SymbolsUnavailable: no ELF symbols are loaded',
            };
          }
          const query = command.query.toLowerCase();
          const matches = this.symbols
            .filter(s => s.name.toLowerCase().includes(query))
            .sort((a, b) => a.name.localeCompare(b.name))
            .slice(0, command.maxResults);
          log.eval(`searchSymbols query=${command.query} matches=${matches.length}`);
          return {
            ok: true,
            data: matches.map(s => ({ name: s.name, address: s.address, size: s.size, type: s.type })),
          };
        }
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
    if (config.probe !== undefined && config.probe !== 'jlink' && config.probe !== 'cmsis-dap') {
      return invalidConfiguration('probe', 'jlink or cmsis-dap', config.probe);
    }
    if (config.cmsisDapTransport !== undefined
      && config.cmsisDapTransport !== 'auto'
      && config.cmsisDapTransport !== 'cmsis-dap-v2'
      && config.cmsisDapTransport !== 'cmsis-dap'
      && config.cmsisDapTransport !== 'hid'
      && config.cmsisDapTransport !== 'winusb') {
      return invalidConfiguration('cmsisDapTransport', 'auto, cmsis-dap-v2, cmsis-dap, hid, or winusb', config.cmsisDapTransport);
    }
    const requestedProbe: DebugProbe = config.probe === undefined ? 'jlink' : config.probe;
    const selectedProbe = this.selectedProbe();
    if (selectedProbe && selectedProbe !== requestedProbe) {
      return {
        ok: false,
        errorCode: 'ProbeMismatch',
        error: `ProbeMismatch: ${selectedProbe === 'jlink' ? 'J-Link' : 'CMSIS-DAP'} owner is already selected; cannot connect with ${requestedProbe === 'jlink' ? 'J-Link' : 'CMSIS-DAP'}.`,
      };
    }
    if (this.state === TargetState.Connected) {
      return { ok: true, data: { state: TargetState.Connected } };
    }
    if (requestedProbe === 'cmsis-dap' && !this.sessionTarget) {
      return {
        ok: false,
        errorCode: 'OwnerUnavailable',
        error: 'OwnerUnavailable: CMSIS-DAP target owner requires a SessionTargetSelector; J-Link fallback is disabled.',
      };
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
      if (!connected.ok) {
        return {
          ok: false,
          errorCode: connected.errorCode,
          error: `${connected.errorCode ? `${connected.errorCode}: ` : ''}${connected.message}`,
        };
      }
    } else {
      if (!this.jlink.open()) return { ok: false, error: 'Failed to load JLink DLL' };
      if (!this.jlink.connect(config.device, config.speedKHz)) {
        this.jlink.close();
        return { ok: false, error: `Failed to connect to ${config.device}` };
      }
    }

    this.configureNativeSteps();
    if (config.nativeDebugEngineEnabled && !this.nativeStepExecutor?.usingNative) {
      if (this.isCmsisDapOwner()) {
        log.step('Native J-Link source-step executor unavailable owner=cmsis-dap; instruction steps remain on sessionTarget/cmsis-dap');
      } else {
        log.step('Native step paths requested but no connected exclusive native executor is available; using legacy paths');
      }
    }
    if (this.isCmsisDapOwner()) {
      const haltResult = await this.targetHaltResult();
      if (!haltResult.ok) {
        if (this.sessionTarget) await this.sessionTarget.dispose(false);
        return this.ownerControlResult(haltResult, 'Halted', 'halt');
      }
    } else if (!(await this.targetHalt())) {
      if (this.sessionTarget) await this.sessionTarget.dispose(false);
      return { ok: false, error: 'Connected target could not be halted' };
    }
    // DAP-04 deliberately has no CMSIS-DAP breakpoint owner yet. Do not turn
    // that unsupported capability into a failed connection.
    if (!this.isCmsisDapOwner() && !(await this.targetClearAllBreakpoints())) {
      if (this.sessionTarget) await this.sessionTarget.dispose(false);
      return { ok: false, error: 'Connected target breakpoints could not be initialized' };
    }

    this.state = TargetState.Connected;
    this.sessionGeneration++;
    this.invalidateFastPlan('session connected');

    return { ok: true, data: { state: TargetState.Connected } };
  }

  private selectedProbe(): DebugProbe | null {
    if (this.sessionTarget) {
      const ownerKind = 'ownerKind' in this.sessionTarget
        ? this.sessionTarget.ownerKind
        : this.sessionTarget.kind;
      if (ownerKind === 'cmsis-dap') return 'cmsis-dap';
      if (ownerKind === 'jlink-native' || ownerKind === 'jlink-legacy') return 'jlink';
      return null;
    }
    return this.state === TargetState.Connected || this.jlink.connected ? 'jlink' : null;
  }

  private isCmsisDapOwner(): boolean {
    if (!this.sessionTarget) return false;
    const ownerKind = 'ownerKind' in this.sessionTarget
      ? this.sessionTarget.ownerKind
      : this.sessionTarget.kind;
    return ownerKind === 'cmsis-dap';
  }

  private async doRunToEntryPoint(symbolName: string, reset: boolean): Promise<OzoneCommandResult> {
    const symbol = symbolName.trim();
    if (!this.isCmsisDapOwner() || !this.sessionTarget || !this.sessionTarget.runToAddress) {
      return this.unsupportedSessionCapability('runToEntryPoint');
    }

    const entry = symbol ? findSymbol(this.symbols, symbol) : undefined;
    if (!entry || !Number.isFinite(entry.address)) {
      const haltResult = await this.sessionTarget.halt();
      if (!haltResult.ok) return this.sessionOwnerFailure(haltResult, 'EntryPointRecoveryFailed');
      this.state = TargetState.Halted;
      return {
        ok: false,
        errorCode: 'EntryPointUnavailable',
        error: `EntryPointUnavailable: symbol "${symbol || symbolName}" was not found in the loaded ELF`,
        targetState: 'Halted',
        diagnostics: { ownerKind: 'cmsis-dap', symbol: symbol || symbolName, symbolCount: this.symbols.length },
      };
    }

    const requestedAddress = entry.address >>> 0;
    const entryAddress = requestedAddress & ~1;
    log.step(
      `startup-stop owner=cmsis-dap symbol=${symbol} requestedAddress=0x${requestedAddress.toString(16)}`
      + ` entryAddress=0x${entryAddress.toString(16)} thumbBit=${requestedAddress & 1} reset=${reset}`,
    );
    this.clearNativeStopInfo('CMSIS-DAP startup stop requested');
    const result = await this.sessionTarget.runToAddress(requestedAddress, reset);
    if (!result.ok) return this.sessionOwnerFailure(result, 'StartupStopFailed');
    if (!result.data || result.targetState !== 'Halted') {
      return {
        ok: false,
        errorCode: 'MalformedResponse',
        error: 'MalformedResponse: CMSIS-DAP runToAddress did not return a halted startup result',
        targetState: result.targetState,
        elapsedMs: result.elapsedMs,
        diagnostics: { ...result.diagnostics, ownerKind: 'cmsis-dap', symbol, entryAddress },
      };
    }
    const actualPc = result.data.pc & ~1;
    if (!result.data.cleanupOk || actualPc !== entryAddress) {
      const errorCode = !result.data.cleanupOk ? 'FpbCleanupFailed' : 'StartupEntryNotReached';
      return {
        ok: false,
        errorCode,
        error: `${errorCode}: startup stop returned PC 0x${actualPc.toString(16)} for ${symbol} at 0x${entryAddress.toString(16)}`,
        targetState: result.targetState,
        elapsedMs: result.elapsedMs,
        diagnostics: { ...result.diagnostics, ownerKind: 'cmsis-dap', symbol, entryAddress, actualPc },
      };
    }
    this.state = TargetState.Halted;
    return {
      ok: true,
      data: {
        ...result.data,
        symbol,
        entryAddress,
        pc: actualPc,
        state: TargetState.Halted,
      },
    };
  }

  private ownerControlResult(
    result: CppJLinkResult,
    fallbackData: string,
    operation: 'halt' | 'run' | 'reset',
  ): OzoneCommandResult {
    if (!result.ok) {
      const errorCode = result.errorCode || 'TargetControlFailed';
      return {
        ok: false,
        errorCode,
        error: `${errorCode}: ${result.message}`,
        diagnostics: result.diagnostics,
        targetState: result.targetState,
        elapsedMs: result.elapsedMs,
      };
    }
    const resultState = result.data && typeof result.data === 'object' && 'state' in result.data
      ? String((result.data as unknown as { state: unknown }).state)
      : result.targetState;
    const breakpointHitBeforeRunningObserved = operation === 'run'
      && resultState === 'Halted'
      && result.data !== null
      && typeof result.data === 'object'
      && (result.data as unknown as { breakpointHitBeforeRunningObserved?: unknown })
        .breakpointHitBeforeRunningObserved === true;
    if ((operation === 'halt' && resultState !== 'Halted')
      || (operation === 'run' && resultState !== 'Running' && !breakpointHitBeforeRunningObserved)
      || (operation === 'reset' && resultState !== 'Halted' && resultState !== 'Running')) {
      const errorCode = 'TargetStateInvalid';
      return {
        ok: false,
        errorCode,
        error: `${errorCode}: ${operation} returned ${resultState || 'unknown'}`,
        diagnostics: { operation, targetState: resultState },
      };
    }
    this.state = operation === 'halt'
      || breakpointHitBeforeRunningObserved
      || (operation === 'reset' && resultState === 'Halted')
      ? TargetState.Halted
      : operation === 'run'
        ? TargetState.Running
        : TargetState.Connected;
    return { ok: true, data: result.data ?? fallbackData };
  }

  private sessionOwnerFailure(result: CppJLinkResult<any>, fallbackCode: string): OzoneCommandResult {
    const errorCode = result.errorCode || fallbackCode;
    return {
      ok: false,
      errorCode,
      error: `${errorCode}: ${result.message}`,
      diagnostics: result.diagnostics,
      targetState: result.targetState,
      elapsedMs: result.elapsedMs,
    };
  }

  private unsupportedSessionCapability(capability: string): OzoneCommandResult {
    return {
      ok: false,
      errorCode: 'UnsupportedCapability',
      error: `UnsupportedCapability: CMSIS-DAP ${capability} is not implemented in DAP-04`,
      diagnostics: { capability, ownerKind: 'cmsis-dap' },
    };
  }

  private async doDisconnect(): Promise<OzoneCommandResult> {
    this.clearNativeStopInfo('disconnect');
    if (this.state === TargetState.Disconnected) {
      this.sessionGeneration++;
      this.invalidateFastPlan('disconnect while disconnected');
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
    this.sessionGeneration++;
    this.symbolGeneration++;
    this.invalidateFastPlan('disconnect');
    this.symbols = [];
    this.lineMapCache.clear();
    this.addressLocCache.clear();
    this.lineEntries = [];
    this.sourceStatementRanges.clear();
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
    if (this.isCmsisDapOwner()) return this.doSetCmsisDapBreakpointAtAddress(addr);
    const bpIndex = await this.targetSetBreakpoint(addr);
    log.step(`setBreakpoint target result=${bpIndex}`);
    if (bpIndex === null) return { ok: false, error: `Failed to set breakpoint at 0x${addr.toString(16)}` };
    log.step(`breakpoint set, index=${bpIndex}`);
    return { ok: true, data: { id: bpIndex, address: addr } };
  }

  private async doClearBreakpoint(id: number): Promise<OzoneCommandResult> {
    log.step(`doClearBreakpoint id=${id}`);
    if (this.isCmsisDapOwner() && this.sessionTarget) {
      const result = await this.sessionTarget.clearBreakpoint(id);
      if (!result.ok) return this.sessionOwnerFailure(result, 'BreakpointClearFailed');
      if (id >= 0 && id < this.sessionBreakpointSlots.length) this.sessionBreakpointSlots[id] = null;
      return { ok: true, data: result.data ?? null };
    }
    const result = await this.targetClearBreakpoint(id);
    log.step(`doClearBreakpoint result=${result}`);
    return result
      ? { ok: true, data: null }
      : { ok: false, error: 'Failed to clear breakpoint' };
  }

  private async doClearBreakpointAtAddr(addr: number): Promise<OzoneCommandResult> {
    const index = this.currentBreakpointSlots().indexOf(addr);
    if (this.isCmsisDapOwner() && this.sessionTarget && index >= 0) {
      const result = await this.sessionTarget.clearBreakpoint(index);
      if (!result.ok) return this.sessionOwnerFailure(result, 'BreakpointClearFailed');
      this.sessionBreakpointSlots[index] = null;
      return { ok: true, data: { index, ...(result.data || {}) } };
    }
    if (index >= 0 && await this.targetClearBreakpoint(index)) {
      return { ok: true, data: { index } };
    }
    return { ok: false, error: `No breakpoint at 0x${addr.toString(16)}` };
  }

  private async doSetBreakpointAtAddr(addr: number): Promise<OzoneCommandResult> {
    if (this.isCmsisDapOwner()) return this.doSetCmsisDapBreakpointAtAddress(addr);
    const index = await this.targetSetBreakpoint(addr);
    if (index !== null) {
      return { ok: true, data: { id: index, address: addr } };
    }
    return { ok: false, error: `Failed to set breakpoint at 0x${addr.toString(16)}` };
  }

  private async doSetCmsisDapBreakpointAtAddress(addr: number): Promise<OzoneCommandResult> {
    if (!this.sessionTarget) {
      return { ok: false, errorCode: 'TargetOwnerUnavailable', error: 'TargetOwnerUnavailable: CMSIS-DAP owner is unavailable' };
    }
    const result = await this.sessionTarget.setBreakpoint(addr);
    if (!result.ok) return this.sessionOwnerFailure(result, 'BreakpointSetFailed');
    if (!result.data || !Number.isInteger(result.data.id) || result.data.id < 0) {
      return {
        ok: false,
        errorCode: 'MalformedResponse',
        error: 'MalformedResponse: CMSIS-DAP setBreakpoint returned no valid slot',
        targetState: result.targetState,
        elapsedMs: result.elapsedMs,
      };
    }
    this.sessionBreakpointSlots[result.data.id] = addr;
    return { ok: true, data: { address: addr, ...result.data } };
  }

  private async doClearAllCmsisDapBreakpoints(): Promise<OzoneCommandResult> {
    if (!this.sessionTarget) {
      return { ok: false, errorCode: 'TargetOwnerUnavailable', error: 'TargetOwnerUnavailable: CMSIS-DAP owner is unavailable' };
    }
    const result = await this.sessionTarget.clearAllBreakpoints();
    if (!result.ok) return this.sessionOwnerFailure(result, 'BreakpointClearFailed');
    this.sessionBreakpointSlots.fill(null);
    this.tempBreakpoint = null;
    this.stepOverClearedBps = [];
    return { ok: true, data: result.data ?? 'All breakpoints cleared' };
  }

  private async doGetRegisters(signal?: AbortSignal): Promise<OzoneCommandResult> {
    if (signal?.aborted) return { ok: true, data: [] };
    const isHalted = this.nativeStepExecutor?.usingNative && this.lastNativeStopInfo
      ? true
      : await this.targetIsHalted();
    if (signal?.aborted) return { ok: true, data: [] };
    if (!isHalted) {
      return { ok: true, data: [] };
    }
    const registers: RegisterValue[] = [];

    for (const [name, idx] of Object.entries(REG_INDEXES)) {
      if (signal?.aborted) {
        log.dap(`getRegisters cancelled before register=${name}`);
        return { ok: true, data: [] };
      }
      const val = await this.readRegisterValue(idx, name);
      if (signal?.aborted) {
        log.dap(`getRegisters cancelled after register=${name}`);
        return { ok: true, data: [] };
      }
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
    log.dap(`readRegister ${name.toUpperCase()} source=${this.targetRegisterSource()} value=${val === null ? 'null' : `0x${val.toString(16)}`}`);
    if (val === null) return { ok: false, error: `Failed to read ${name}` };
    return { ok: true, data: { name, value: val, hex: `0x${val.toString(16).toUpperCase().padStart(8, '0')}` } };
  }

  private async doGetLocals(signal?: AbortSignal): Promise<OzoneCommandResult> {
    if (signal?.aborted) return { ok: true, data: [] };
    const isHalted = await this.targetIsHalted();
    if (signal?.aborted) return { ok: true, data: [] };
    if (!isHalted) {
      return { ok: true, data: [] };
    }
    const dwarfLocals = this.dwarfInfo.localVariables;
    const cfaRows = this.dwarfInfo.cfaRows;
    if (dwarfLocals && cfaRows) {
      const pcValue = await this.targetReadRegister(REG_INDEXES.PC);
      if (signal?.aborted || pcValue === null) return { ok: true, data: [] };
      const pc = pcValue & ~1;
      const cfaRow = cfaRows.find(row => pc >= row.lowPc && pc < row.highPc);
      if (!cfaRow) return { ok: true, data: [] };
      const cfaRegister = await this.targetReadRegister(cfaRow.registerIndex);
      if (signal?.aborted || cfaRegister === null) return { ok: true, data: [] };
      const cfa = (cfaRegister + cfaRow.offset) >>> 0;
      const variables: Variable[] = [];
      const activeLocals = dwarfLocals
        .filter(local => pc >= local.lowPc && pc < local.highPc)
        .sort((left, right) => (left.highPc - left.lowPc) - (right.highPc - right.lowPc));
      const seenNames = new Set<string>();

      for (const local of activeLocals) {
        if (seenNames.has(local.name)) continue;
        seenNames.add(local.name);
        if (signal?.aborted) return { ok: true, data: [] };
        const resolvedType = this.resolveDwarfType(local.typeOffset);
        const readSize = this.getScalarReadSize(undefined, resolvedType);
        const address = (cfa + local.fbregOffset) >>> 0;
        const raw = await this.targetReadMemory(address, readSize);
        if (signal?.aborted) return { ok: true, data: [] };
        if (!raw || raw.length < readSize) continue;
        const formatted = this.isFloatType(resolvedType)
          ? this.readBytesAsFloat(raw, readSize).toString()
          : this.formatScalarValue(raw, readSize, resolvedType).display;
        variables.push({
          name: local.name,
          type: this.getDwarfTypeName(local.typeOffset) || resolvedType?.name || 'unknown',
          value: formatted,
          address,
        });
      }

      return { ok: true, data: variables };
    }

    const variables: Variable[] = [];
    const localSymbols = this.symbols.filter(s =>
      s.type === 'd' || s.type === 'D' || s.type === 'B' || s.type === 'b'
    );

    for (const sym of localSymbols.slice(0, 50)) {
      if (signal?.aborted) {
        log.dap(`getLocals cancelled before symbol=${sym.name}`);
        return { ok: true, data: [] };
      }
      const varTypeOffset = this.dwarfInfo.varToType.get(sym.name);
      const resolvedType = varTypeOffset ? this.resolveDwarfType(varTypeOffset) : null;
      const readSize = this.getScalarReadSize(sym.size, resolvedType);
      const raw = await this.targetReadMemory(sym.address, readSize);
      if (signal?.aborted) {
        log.dap(`getLocals cancelled after symbol=${sym.name}`);
        return { ok: true, data: [] };
      }
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

    const registerSource = nativeOwner && this.lastNativeStopInfo
      ? 'nativeStopInfo/helper'
      : this.targetRegisterSource();
    log.dap(`getCallStack PC source=${registerSource} pc=${pc === null ? 'null' : `0x${pc.toString(16)}`}`
      + ` LR source=${registerSource} lr=${lr === null ? 'null' : `0x${lr.toString(16)}`}`);
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
      `stackTrace frame0 pc=0x${pc.toString(16)} pcSource=${registerSource}`
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
    log.dap(`readRegister ${name} source=${this.targetRegisterSource()} value=${value === null ? 'null' : `0x${value.toString(16)}`}`);
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
    if (this.isCmsisDapOwner() && this.sessionTarget) {
      const result = await this.sessionTarget.step();
      if (!result.ok) {
        const errorCode = result.errorCode || 'TargetControlFailed';
        return {
          ok: false,
          errorCode,
          error: `${errorCode}: ${result.message}`,
          diagnostics: result.diagnostics,
        };
      }
      if (result.targetState !== 'Halted') {
        return {
          ok: false,
          errorCode: 'TargetStateInvalid',
          error: `TargetStateInvalid: CMSIS-DAP instruction step returned ${result.targetState}`,
          diagnostics: { ownerKind: 'cmsis-dap', targetState: result.targetState },
        };
      }
      this.state = TargetState.Halted;
      const data = result.data && typeof result.data === 'object' ? result.data : {};
      return {
        ok: true,
        data: { mode: 'cmsis-dap', helperElapsedMs: result.elapsedMs, ...data },
      };
    }
    if (this.nativeStepsEnabled.stepInto && this.nativeStepExecutor?.usingNative) {
      return this.executeNativeStep('stepInto', () => this.nativeStepExecutor!.stepIntoInstruction());
    }
    this.clearNativeStopInfo('instruction step using legacy path');
    return this.doSingleStep();
  }

  private async doCmsisDapStepInto(): Promise<OzoneCommandResult> {
    const pc = await this.readRegisterValue(REG_INDEXES.PC, 'PC');
    if (pc === null) return this.cmsisDapSourceStepPreparationError('stepInto', 'cannot read PC');
    const bounds = this.resolveNativeLineBounds(pc);
    if (!bounds) return this.cmsisDapSourceStepPreparationError('stepInto', `no source-line range contains PC 0x${pc.toString(16)}`);
    const run = (range: { start: number; end: number }) => this.executeCmsisDapSourceStep(
      'stepInto',
      () => this.sessionTarget!.stepIntoSourceLine({
        lineStart: range.start,
        lineEnd: range.end,
        maxInstructionSteps: 32,
      }),
    );
    const result = await run(bounds);
    return this.continueCmsisDapStepAcrossSameSourceLine('stepInto', pc, bounds, result, run);
  }

  private async doCmsisDapStepOver(): Promise<OzoneCommandResult> {
    const pc = await this.readRegisterValue(REG_INDEXES.PC, 'PC');
    if (pc === null) return this.cmsisDapSourceStepPreparationError('stepOver', 'cannot read PC');
    const bounds = this.resolveNativeLineBounds(pc);
    if (!bounds) return this.cmsisDapSourceStepPreparationError('stepOver', `no source-line range contains PC 0x${pc.toString(16)}`);
    const run = (range: { start: number; end: number }) => this.executeCmsisDapSourceStep(
      'stepOver',
      () => this.sessionTarget!.stepOverSourceLine({
        lineStart: range.start,
        lineEnd: range.end,
        waitTimeoutMs: 1000,
        maxInstructionSteps: 128,
        breakpoints: this.snapshotBreakpoints(),
      }),
    );
    const result = await run(bounds);
    return this.continueCmsisDapStepAcrossSameSourceLine('stepOver', pc, bounds, result, run);
  }

  private async continueCmsisDapStepAcrossSameSourceLine(
    kind: 'stepInto' | 'stepOver',
    startPc: number,
    firstBounds: { start: number; end: number },
    result: OzoneCommandResult,
    run: (bounds: { start: number; end: number }) => Promise<OzoneCommandResult>,
  ): Promise<OzoneCommandResult> {
    if (!result.ok) return result;
    const startLoc = this.resolveAddressLoc(startPc);
    const step = result.data as {
      pcAfter?: number;
      classification?: string;
      enteredCall?: boolean;
    } | undefined;
    if (!startLoc || typeof step?.pcAfter !== 'number') return result;
    if (kind === 'stepInto' && (step.enteredCall || step.classification === 'call')) return result;

    const afterLoc = this.resolveAddressLoc(step.pcAfter);
    if (!afterLoc || afterLoc.file !== startLoc.file || afterLoc.line !== startLoc.line) return result;
    const continuationBounds = this.resolveNativeLineBounds(step.pcAfter);
    if (!continuationBounds || continuationBounds.start === firstBounds.start) return result;

    log.step(
      `CMSIS-DAP ${kind} phase=continueSameSourceLine pc=0x${step.pcAfter.toString(16)}`
      + ` source=${afterLoc.file}:${afterLoc.line}`
      + ` lineRange=0x${continuationBounds.start.toString(16)}..0x${continuationBounds.end.toString(16)}`,
    );
    return run(continuationBounds);
  }

  private async doCmsisDapStepOut(): Promise<OzoneCommandResult> {
    const pc = await this.readRegisterValue(REG_INDEXES.PC, 'PC');
    if (pc === null) return this.cmsisDapSourceStepPreparationError('stepOut', 'cannot read PC');
    const functionRange = this.resolveFunctionRange(pc);
    if (!functionRange) return this.cmsisDapSourceStepPreparationError('stepOut', `no function contains PC 0x${pc.toString(16)}`);
    return this.executeCmsisDapSourceStep('stepOut', () => this.sessionTarget!.stepOut({
      functionStart: functionRange.start,
      functionEnd: functionRange.end,
      waitTimeoutMs: 1000,
      breakpoints: this.snapshotBreakpoints(),
    }));
  }

  private cmsisDapSourceStepPreparationError(capability: string, detail: string): OzoneCommandResult {
    return {
      ok: false,
      errorCode: 'SourceLocationUnavailable',
      error: `SourceLocationUnavailable: CMSIS-DAP ${capability} ${detail}`,
      targetState: 'Halted',
      diagnostics: { capability, ownerKind: 'cmsis-dap', detail },
    };
  }

  private async executeCmsisDapSourceStep(
    kind: 'stepInto' | 'stepOver' | 'stepOut',
    run: () => Promise<CppJLinkResult<NativeStepIntoDiagnostics | NativeStepOverDiagnostics | NativeStepOutDiagnostics>>,
  ): Promise<OzoneCommandResult> {
    const started = Date.now();
    const result = await run();
    const diagnostics = result.data;
    log.step(
      `CMSIS-DAP ${kind} owner=cmsis-dap ok=${result.ok}`
      + ` targetState=${result.targetState} elapsedMs=${result.elapsedMs}`
      + (diagnostics
        ? ` pc=0x${diagnostics.pcBefore.toString(16)}->0x${diagnostics.pcAfter.toString(16)}`
          + ` class=${diagnostics.classification} cleanup=${diagnostics.cleanupOk}`
        : ` errorCode=${result.errorCode || 'unknown'} diagnostics=${JSON.stringify(result.diagnostics || {})}`),
    );
    this.stepProfileMark('CMSIS-DAP source state machine', started, `kind=${kind}`);
    if (!result.ok) {
      return {
        ok: false,
        errorCode: result.errorCode || 'CmsisDapSourceStepFailed',
        error: `${result.errorCode || 'CmsisDapSourceStepFailed'}: ${result.message}`,
        diagnostics: result.diagnostics,
        targetState: result.targetState,
        elapsedMs: result.elapsedMs,
      };
    }
    if (result.targetState !== 'Halted' || !diagnostics) {
      return {
        ok: false,
        errorCode: result.targetState !== 'Halted' ? 'TargetStateInvalid' : 'MalformedResponse',
        error: result.targetState !== 'Halted'
          ? `TargetStateInvalid: CMSIS-DAP ${kind} returned ${result.targetState}`
          : `MalformedResponse: CMSIS-DAP ${kind} returned no diagnostics`,
        diagnostics: result.diagnostics,
        targetState: result.targetState,
        elapsedMs: result.elapsedMs,
      };
    }
    this.state = TargetState.Halted;
    return {
      ok: true,
      data: {
        mode: 'cmsis-dap',
        targetState: result.targetState,
        helperElapsedMs: result.elapsedMs,
        ...diagnostics,
      },
    };
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
        .map((address, slot) => address == null ? null : [String(slot), address] as const)
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

  private async doReadMemory(address: number, size: number, signal?: AbortSignal): Promise<OzoneCommandResult> {
    if (signal?.aborted) {
      return { ok: false, errorCode: 'TargetReadCancelled', error: 'Target read cancelled', targetState: 'Unknown', elapsedMs: 0 };
    }
    const wasRunning = !(await this.targetIsHalted());
    if (wasRunning) {
      if (signal?.aborted) {
        return { ok: false, errorCode: 'TargetReadCancelled', error: 'Target read cancelled', targetState: 'Running', elapsedMs: 0 };
      }
      const halted = await this.ensureHalted();
      if (!halted) return { ok: false, error: 'halt failed' };
      await new Promise<void>(r => setTimeout(r, 50));
    }

    const readResult = await this.readMemoryChunked(address, size, signal);
    const resumed = wasRunning && !signal?.aborted ? await this.targetRun() : false;
    const currentTargetState = wasRunning
      ? (resumed ? 'Running' : readResult.targetState)
      : 'Halted';
    if (!readResult.ok) {
      const errorCode = readResult.errorCode || 'MemoryReadFailed';
      log.dap(`readMemory failed owner=${this.targetRegisterSource()} errorCode=${errorCode}`
        + ` targetState=${currentTargetState} elapsedMs=${readResult.elapsedMs}`
        + ` diagnostics=${JSON.stringify(readResult.diagnostics || {})}`);
      return {
        ok: false,
        errorCode,
        error: `${errorCode}: ${readResult.message}`,
        diagnostics: {
          ...readResult.diagnostics,
          helperTargetState: readResult.targetState,
          targetState: currentTargetState,
        },
        targetState: currentTargetState,
        elapsedMs: readResult.elapsedMs,
      };
    }

    const raw = readResult.data?.bytes;
    if (!raw || raw.length === 0) {
      return {
        ok: false,
        errorCode: 'MalformedResponse',
        error: 'MalformedResponse: memory read returned no bytes',
        diagnostics: { operation: 'readMemory', phase: 'decode', address, size },
        targetState: readResult.targetState,
        elapsedMs: readResult.elapsedMs,
      };
    }

    const data = Array.from(raw);
    const ascii = data.map(b => (b >= 0x20 && b <= 0x7E) ? String.fromCharCode(b) : '.').join('');
    const block: MemoryBlock = { address, data, ascii, unreadableBytes: Math.max(0, size - data.length) };
    return { ok: true, data: block };
  }

  private async readMemoryChunked(
    address: number,
    size: number,
    signal?: AbortSignal,
  ): Promise<CppJLinkResult<{ bytes: Uint8Array }>> {
    const chunkSize = 256;
    const chunks: number[] = [];
    let elapsedMs = 0;
    let targetState: CppJLinkResult['targetState'] = 'Unknown';
    for (let offset = 0; offset < size; offset += chunkSize) {
      if (signal?.aborted) {
        return {
          ok: false,
          errorCode: 'TargetReadCancelled',
          message: 'target read cancelled',
          targetState,
          elapsedMs,
          diagnostics: { operation: 'readMemory', phase: 'cancelled', address, size, chunkOffset: offset },
        };
      }
      const count = Math.min(chunkSize, size - offset);
      const chunkAddress = address + offset;
      const result = await this.targetReadMemoryResult(chunkAddress, count, 'background', signal);
      elapsedMs += result.elapsedMs;
      targetState = result.targetState;
      if (!result.ok || !result.data) {
        return {
          ...result,
          ok: false,
          elapsedMs,
          diagnostics: {
            ...result.diagnostics,
            operation: 'readMemory',
            phase: typeof result.diagnostics?.phase === 'string'
              ? result.diagnostics.phase
              : 'targetRead',
            address,
            size,
            chunkAddress,
            chunkSize: count,
            chunkOffset: offset,
          },
        };
      }
      chunks.push(...Array.from(result.data.bytes));
    }
    return {
      ok: true,
      message: 'memory read',
      targetState,
      elapsedMs,
      data: { bytes: Uint8Array.from(chunks) },
    };
  }

  private async doFlash(
    elfPath: string,
    device: string,
    interface_: string,
    speedKHz: number,
    signal?: AbortSignal,
    probe: DebugProbe = 'jlink',
    flashBeforeDebug = true,
    algorithmPath?: string,
    verify?: boolean,
  ): Promise<OzoneCommandResult> {
    if (flashBeforeDebug === false) return { ok: true, data: { skipped: true, reason: 'flashBeforeDebug=false' } };
    let result: {
      success: boolean;
      message: string;
      elfPath?: string;
      reports?: Array<{ operation: string; address: number; size: number; elapsedMs: number; ok: boolean; errorCode?: string; message?: string }>;
      erasedSectors?: Array<{ number: number; address: number; size: number }>;
    };
    if (probe === 'cmsis-dap') {
      if (!this.sessionTarget) return { ok: false, errorCode: 'OwnerUnavailable', error: 'CMSIS-DAP target owner is unavailable' };
      const options: CmsisDapFlashOptions = { signal, algorithmPath, clockHz: speedKHz * 1000, verify: verify ?? true };
      const flashResult = 'ownerKind' in this.sessionTarget
        ? await this.sessionTarget.flash(elfPath, device, options)
        : this.sessionTarget.flash
          ? await this.sessionTarget.flash(elfPath, device, options)
          : {
            ok: false,
            errorCode: 'UnsupportedCapability',
            message: 'CMSIS-DAP owner does not implement Flash Algorithm',
            targetState: 'Error' as const,
            elapsedMs: 0,
          };
      if (!flashResult.ok) {
        return {
          ok: false,
          errorCode: flashResult.errorCode,
          error: `${flashResult.errorCode ? `${flashResult.errorCode}: ` : ''}${flashResult.message}`,
          diagnostics: flashResult.diagnostics,
        };
      }
      result = {
        success: true,
        message: flashResult.message,
        elfPath,
        // Per-operation reports (including verify) stay additive so the
        // automation flash outcome can report what the owner verified.
        reports: flashResult.data?.reports,
        erasedSectors: flashResult.data?.erasedSectors,
      };
    } else {
      result = await flashElf(elfPath, device, interface_, speedKHz, { signal });
    }
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
      this.symbolGeneration++;
      this.invalidateFastPlan('ELF reload after flash');
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
    const normalized = expressions.map(expression => String(expression).trim());
    const key = JSON.stringify({
      version: 'scalar-v1',
      plannerMode: 'fast-scalar-read-v1',
      readSizePolicy: 'strict-scalar-only',
      expressions: normalized,
      symbolGeneration: this.symbolGeneration,
      sessionGeneration: this.sessionGeneration,
    });
    const cached = this.fastPlanCache.get(key);
    if (cached) {
      this.planCacheHit++;
      return this.cloneFastPlan(cached);
    }
    this.planCacheMiss++;
    const started = Date.now();
    const plan = normalized.map(expression => {
      const spec = this.resolveFastDataSampleSpec(expression);
      return spec ? { expression, spec } : { expression, error: 'Fast sampling supports scalar globals, scalar array elements, and scalar struct fields only' };
    });
    this.planBuildElapsed.record(Date.now() - started);
    this.fastPlanCache.set(key, this.cloneFastPlan(plan));
    while (this.fastPlanCache.size > 32) this.fastPlanCache.delete(this.fastPlanCache.keys().next().value!);
    return this.cloneFastPlan(plan);
  }

  private cloneFastPlan(plan: FastDataSamplePlanItem[]): FastDataSamplePlanItem[] {
    return plan.map(item => ({
      expression: item.expression,
      ...(item.error ? { error: item.error } : {}),
      ...(item.spec ? { spec: { ...item.spec, format: item.spec.format ? { ...item.spec.format } : undefined } } : {}),
    }));
  }

  private invalidateFastPlan(_reason: string) {
    this.fastPlanCache.clear();
    this.planCacheInvalidation++;
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
      const typeName = arrayType.typeOffset ? this.getDwarfTypeName(arrayType.typeOffset) : elemType?.typeName || elemType?.name || '';
      return {
        expression,
        address: baseSym.address + index * size,
        size,
        typeName,
        isFloat: this.isFloatType(elemType),
        signed: this.isSignedIntegerType(elemType),
        format: this.fastDataSampleFormat(elemType, typeName),
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
        if ((currentType?.kind !== 'struct' && currentType?.kind !== 'union') || !currentType.fields) return null;
        const field = currentType.fields.find(candidate => candidate.name === fieldName);
        if (!field) return null;
        const fieldType = this.resolveDwarfType(field.typeOffset);
        fieldOffset += field.byteOffset;

        if (index < segments.length - 1) {
          if (fieldType?.kind !== 'struct' && fieldType?.kind !== 'union') return null;
          currentType = fieldType;
          continue;
        }

        if (!this.isFastScalarType(fieldType)) return null;
        const size = this.getScalarReadSize(undefined, fieldType);
        const typeName = this.getDwarfTypeName(field.typeOffset) || fieldType?.typeName || fieldType?.name || '';
        return {
          expression,
          address: pointerAddress === undefined ? baseSym.address + fieldOffset : pointerAddress,
          size,
          ...(pointerAddress === undefined ? {} : { pointerAddress, pointeeOffset: fieldOffset }),
          typeName,
          isFloat: this.isFloatType(fieldType),
          signed: this.isSignedIntegerType(fieldType),
          format: this.fastDataSampleFormat(fieldType, typeName),
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
    const typeName = varTypeOffset ? this.getDwarfTypeName(varTypeOffset) : resolvedType?.typeName || resolvedType?.name || '';
    return {
      expression,
      address: sym.address,
      size,
      typeName,
      isFloat: this.isFloatType(resolvedType),
      signed: this.isSignedIntegerType(resolvedType),
      format: this.fastDataSampleFormat(resolvedType, typeName),
    };
  }

  private fastDataSampleFormat(
    info: {
      kind?: string;
      encoding?: string;
      name?: string;
      typeName?: string;
      enumerators?: Array<{ name: string; value: string }>;
    } | null,
    typeName: string,
  ): FastDataSampleSpec['format'] {
    return {
      kind: info?.kind || 'base',
      encoding: info?.encoding,
      name: info?.name || typeName,
      typeName: info?.typeName || typeName,
      enumerators: info?.enumerators,
    };
  }

  private findSymbolByName(name: string): SymbolInfo | undefined {
    return this.symbols.find(s => s.name === name)
      || this.symbols.find(s => s.name.toLowerCase() === name.toLowerCase());
  }

  /** Resolves a symbol whose exact address matches, or that contains the address. */
  private findSymbolByAddress(address: number): SymbolInfo | undefined {
    const normalized = address >>> 0;
    let exact: SymbolInfo | undefined;
    for (const sym of this.symbols) {
      if ((sym.address >>> 0) === normalized) {
        if (!exact || sym.size < exact.size) exact = sym;
      }
    }
    if (exact) return exact;
    let container: SymbolInfo | undefined;
    for (const sym of this.symbols) {
      if (sym.size > 0 && normalized > (sym.address >>> 0) && normalized < (sym.address >>> 0) + sym.size) {
        if (!container || sym.size < container.size) container = sym;
      }
    }
    return container;
  }

  private isFastScalarType(info: { kind?: string; byteSize?: number } | null): boolean {
    if (!info) return true;
    if (info.kind === 'struct' || info.kind === 'union' || info.kind === 'array') return false;
    const size = info.byteSize || 4;
    return size > 0 && size <= 8;
  }

  private mergeFastSampleReads(reads: Array<{ index: number; address: number; size: number }>): Array<{
    address: number;
    size: number;
    members: Array<{ index: number; address: number; size: number }>;
  }> {
    const merged: Array<{
      address: number;
      size: number;
      members: Array<{ index: number; address: number; size: number }>;
    }> = [];
    for (const read of [...reads].sort((left, right) => left.address - right.address || left.size - right.size)) {
      const previous = merged[merged.length - 1];
      if (previous && read.address <= previous.address + previous.size) {
        previous.size = Math.max(previous.address + previous.size, read.address + read.size) - previous.address;
        previous.members.push(read);
      } else {
        merged.push({ address: read.address, size: read.size, members: [read] });
      }
    }
    return merged;
  }

  private assignFastSampleBatch(
    rawByIndex: Array<Uint8Array | null>,
    merged: Array<{
      address: number;
      size: number;
      members: Array<{ index: number; address: number; size: number }>;
    }>,
    reads: Array<{ address: number; bytes: Uint8Array }>,
  ): void {
    for (let groupIndex = 0; groupIndex < merged.length; groupIndex++) {
      const group = merged[groupIndex];
      const bytes = reads[groupIndex]?.bytes;
      if (!bytes) continue;
      for (const member of group.members) {
        const offset = member.address - group.address;
        if (offset + member.size <= bytes.length) {
          rawByIndex[member.index] = bytes.slice(offset, offset + member.size);
        }
      }
    }
  }

  private async readFastDataSampling(
    specs: FastDataSampleSpec[],
    priority: 'watch' | 'timeline' = 'timeline',
  ): Promise<WatchValue[]> {
    const rawByIndex: Array<Uint8Array | null> = Array(specs.length).fill(null);
    const resolvedAddresses = specs.map(spec => spec.address);
    const initialReads = specs.map(spec => ({
      address: spec.pointerAddress ?? spec.address,
      size: spec.pointerAddress === undefined ? spec.size : 4,
    }));

    if (this.sessionTarget && specs.length > 0) {
      const merged = this.mergeFastSampleReads(initialReads.map((read, index) => ({ index, ...read })));
      const result = await this.sessionTarget.readMemoryBatch(
        merged.map(read => ({ address: read.address, size: read.size })),
        priority === 'timeline'
          ? { priority, coalesceKey: 'fast-data-sampling' }
          : { priority },
      );
      if (result.ok && result.data) {
        this.assignFastSampleBatch(rawByIndex, merged, result.data.reads);
      }
    }
    for (let index = 0; index < specs.length; index++) {
      if (rawByIndex[index]) continue;
      const initial = initialReads[index];
      rawByIndex[index] = await this.targetReadMemory(initial.address, initial.size, priority);
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
      const merged = this.mergeFastSampleReads(indirectReads);
      const result = await this.sessionTarget.readMemoryBatch(
        merged.map(read => ({ address: read.address, size: read.size })),
        priority === 'timeline'
          ? { priority, coalesceKey: 'fast-data-sampling' }
          : { priority },
      );
      if (result.ok && result.data) {
        this.assignFastSampleBatch(rawByIndex, merged, result.data.reads);
      } else {
        for (const read of indirectReads) rawByIndex[read.index] = null;
      }
    }
    for (const read of indirectReads) {
      if (rawByIndex[read.index]) continue;
      rawByIndex[read.index] = await this.targetReadMemory(read.address, read.size, priority);
    }

    const results: WatchValue[] = [];
    for (let index = 0; index < specs.length; index++) {
      const spec = specs[index];
      const raw = rawByIndex[index];
      if (!raw) {
        results.push({ expression: spec.expression, value: 0, display: '', hex: '', error: `read failed at 0x${resolvedAddresses[index].toString(16)}` });
        continue;
      }

      let value: number | string;
      let display: string;
      let hex: string;
      let exactValue: string | undefined;
      let numericValueExact: boolean | undefined;
      if (spec.isFloat) {
        value = this.readBytesAsFloat(raw, spec.size);
        display = spec.size === 8 ? `${value.toExponential(6)}` : `${value.toFixed(6)}`;
        hex = `0x${Array.from(raw.slice(0, spec.size)).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
      } else {
        const formatted = this.formatScalarValue(
          raw,
          spec.size,
          spec.format || { kind: 'base', encoding: spec.signed ? 'signed' : 'unsigned', name: spec.typeName || '' },
        );
        value = formatted.value;
        display = formatted.display;
        hex = formatted.hex;
        exactValue = formatted.exactValue;
        numericValueExact = formatted.numericValueExact;
      }

      results.push({
        expression: spec.expression,
        value,
        display,
        hex,
        exactValue,
        numericValueExact,
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
    this.throwIfEvaluationCancelled(watchContext);
    expression = expression.trim();
    const isRTOS = expression === 'uxCurrentNumberOfTasks' || expression === 'pxCurrentTCB' || expression === 'pxReadyTasksLists';

    const sizeofValue = this.evaluateSizeofExpression(expression);
    if (sizeofValue !== null) {
      return { ok: true, data: this.makeNumericWatchValue(expression, sizeofValue, 'size_t', false) };
    }

    const derefValue = await this.evaluatePointerDereferenceExpression(expression, watchContext);
    if (derefValue) return { ok: true, data: derefValue };

    const charPointerValue = await this.evaluateCharPointerExpression(expression, watchContext);
    if (charPointerValue) return { ok: true, data: charPointerValue };

    const castStructValue = await this.evaluateCastStructExpression(expression, watchContext);
    if (castStructValue) return { ok: true, data: castStructValue };

    const fieldValue = await this.evaluateFieldAccessExpression(expression, watchContext);
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
              this.throwIfEvaluationCancelled(watchContext);
              return { ok: false, error: 'process is running' };
            }
            if (!force) {
              await new Promise<void>(r => setTimeout(r, 100));
              this.throwIfEvaluationCancelled(watchContext);
            }

            const raw = await this.evaluateReadMemory(elemAddr, elemSize, watchContext);
            if (raw) {
              const isFloat = this.isFloatType(elemType);
              let value: number | string;
              let display: string;
              let exactValue: string | undefined;
              let numericValueExact: boolean | undefined;
              if (isFloat && raw.length >= (elemType?.byteSize || 4)) {
                value = this.readBytesAsFloat(raw, elemType!.byteSize);
                display = elemType!.byteSize === 8 ? `${value.toExponential(6)}` : `${value.toFixed(6)}`;
              } else {
                const formatted = this.formatScalarValue(raw, elemSize, elemType);
                value = formatted.value;
                display = formatted.display;
                exactValue = formatted.exactValue;
                numericValueExact = formatted.numericValueExact;
              }
              return {
                ok: true,
                data: { expression, value, display, hex: this.formatScalarValue(raw, elemSize, elemType).hex, exactValue, numericValueExact, address: elemAddr, typeName: elemTypeName } as WatchValue,
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
        this.throwIfEvaluationCancelled(watchContext);
        const val = await this.targetReadRegister(regIdx);
        this.throwIfEvaluationCancelled(watchContext);
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
      const isHalted = watchContext?.priority === 'background'
        ? this.state === TargetState.Halted
        : await this.targetIsHalted();
      this.throwIfEvaluationCancelled(watchContext);
      log.step(`sym=${sym.name} addr=0x${sym.address.toString(16)} size=${sym.size} type=${sym.type} isHalted=${isHalted} force=${force}`);
    }

    if (!force && watchContext?.priority !== 'background' && !(await this.targetIsHalted())) {
      this.throwIfEvaluationCancelled(watchContext);
      log.eval(`doEvaluateExpression: CPU is running, returning running`);
      return { ok: false, error: 'process is running' };
    }

    if (!force && watchContext?.priority !== 'background') {
      await new Promise<void>(r => setTimeout(r, 100));
      this.throwIfEvaluationCancelled(watchContext);
    }

    const varTypeOffset = this.dwarfInfo.varToType.get(sym.name);
    log.eval(`doEvaluateExpression: varTypeOffset for "${sym.name}" = ${varTypeOffset || 'none'}`);
    const resolvedType = varTypeOffset ? this.resolveDwarfType(varTypeOffset) : null;
    if (varTypeOffset) {
      log.eval(`doEvaluateExpression: resolvedType kind=${resolvedType?.kind} name=${resolvedType?.name} fields=${resolvedType?.fields?.length || 0}`);
      if (resolvedType?.kind === 'pointer' && resolvedType.typeOffset) {
        const pointee = this.resolveDwarfType(resolvedType.typeOffset);
        if (this.isCharType(pointee)) {
          const pointerRaw = await this.evaluateReadMemory(sym.address, this.getScalarReadSize(sym.size, resolvedType), watchContext);
          if (!pointerRaw) return { ok: false, error: `read failed at 0x${sym.address.toString(16)}` };
          const pointerAddress = this.readUnsignedLittleEndian(pointerRaw, pointerRaw.length) >>> 0;
          if (pointerAddress === 0) {
            return {
              ok: true,
              data: { expression, value: 0, display: 'NULL', hex: '0x00000000', address: sym.address, typeName: this.getDwarfTypeName(varTypeOffset) } as WatchValue,
            };
          }
          const stringValue = await this.readBoundedString(pointerAddress, 256, watchContext);
          if (!stringValue) return { ok: false, error: `read failed at 0x${pointerAddress.toString(16)}` };
          return {
            ok: true,
            data: {
              expression,
              value: pointerAddress,
              display: stringValue.display,
              hex: `0x${pointerAddress.toString(16).toUpperCase()}`,
              address: sym.address,
              typeName: this.getDwarfTypeName(varTypeOffset),
              error: stringValue.error,
            } as WatchValue,
          };
        }
      }
      if (resolvedType && (resolvedType.kind === 'struct' || resolvedType.kind === 'union') && resolvedType.fields && resolvedType.fields.length > 0) {
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
        const raw = await this.evaluateReadMemory(sym.address, readLen, watchContext);
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
        const isCharArray = this.isCharType(elemType);
        const expanded = this.shouldExpandWatchNode(expression, watchContext);
        if (!expanded && !isCharArray) {
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
        const raw = await this.evaluateReadMemory(sym.address, readLen, watchContext);
        if (raw) {
          const stringValue = isCharArray ? this.formatBoundedString(raw.slice(0, totalBytes)) : undefined;
          if (isCharArray && !expanded) {
            return {
              ok: true,
              data: {
                expression,
                value: sym.address,
                display: stringValue!.display,
                hex: `0x${sym.address.toString(16).toUpperCase()}`,
                address: sym.address,
                typeName: arrayTypeName,
                hasChildren: count > 0,
                error: stringValue!.error,
              } as WatchValue,
            };
          }
          const children: WatchValue[] = [];
          for (let i = 0; i < count; i++) {
            this.throwIfEvaluationCancelled(watchContext);
            const elemAddr = sym.address + i * elemSize;
            const elemRawOffset = i * elemSize;
            if ((elemType?.kind === 'struct' || elemType?.kind === 'union') && elemType.fields) {
              const childRaw = raw.slice(elemRawOffset, elemRawOffset + elemSize);
              const elementExpression = `${expression}[${i}]`;
              const structChildren = this.shouldExpandWatchNode(elementExpression, watchContext)
                ? await this.evaluateStructFields(childRaw, elemType.fields, elemType.typeDefs || this.dwarfInfo.typeDefs, elemAddr, elementExpression, 0, watchContext)
                : undefined;
              children.push({
                expression: `[${i}]`,
                evaluateName: elementExpression,
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
                exactValue: formatted.exactValue,
                numericValueExact: formatted.numericValueExact,
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
              display: stringValue?.display || (children.length > 0
                ? `${count} elems [${children.slice(0, 3).map(c => c.display).join(', ')}${children.length > 3 ? ', ...' : ''}]`
                : `${count} elems`),
              hex: '',
              address: sym.address,
              typeName: arrayTypeName,
              hasChildren: count > 0,
              children,
              error: stringValue?.error,
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
    const raw = await this.evaluateReadMemory(sym.address, readSize, watchContext);

    if (!raw) {
      if (isRTOS) log.eval(`memory read failed for "${expression}" at 0x${sym.address.toString(16)}`);
      return { ok: false, error: `read failed at 0x${sym.address.toString(16)}` };
    }

    const isFloat = this.isFloatType(resolvedType);

    let value: number | string;
    let display: string;
    let exactValue: string | undefined;
    let numericValueExact: boolean | undefined;
    if (isFloat && raw.length >= (resolvedType?.byteSize || 4)) {
      value = this.readBytesAsFloat(raw, resolvedType!.byteSize);
      if (resolvedType!.byteSize === 8) display = `${value.toExponential(6)}`;
      else display = `${value.toFixed(6)}`;
    } else {
      const formatted = this.formatScalarValue(raw, readSize, resolvedType);
      value = formatted.value;
      display = formatted.display;
      exactValue = formatted.exactValue;
      numericValueExact = formatted.numericValueExact;
    }
    if (this.isFunctionPointerType(resolvedType) && typeof value === 'number') {
      display = this.formatFunctionPointer(value);
    }
    let typeName = '';
    if (varTypeOffset) {
      const tn = this.getDwarfTypeName(varTypeOffset);
      if (tn) typeName = tn;
    }

    if (isRTOS || expression.startsWith('ux')) {
      log.eval(`read result value=${value} display="${display}"`);
    }

    const pointerHasChildren = resolvedType?.kind === 'pointer'
      && !!resolvedType.typeOffset
      && this.pointerTargetHasChildren(resolvedType.typeOffset);
    const pointerValue = typeof value === 'number' ? value : null;
    const pointerChildren = pointerHasChildren && pointerValue && this.shouldExpandWatchNode(expression, watchContext)
      ? await this.evaluatePointerChildren(pointerValue, resolvedType!.typeOffset!, expression, 1, watchContext)
      : undefined;

    const hexValue = isFloat
      ? `0x${Array.from(raw.slice(0, readSize)).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase()}`
      : this.formatScalarValue(raw, readSize, resolvedType).hex;

    return {
      ok: true,
      data: {
        expression, value, display,
        hex: hexValue,
        exactValue,
        numericValueExact,
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

  private async evaluatePointerDereferenceExpression(
    expression: string,
    watchContext?: WatchEvaluationContext,
  ): Promise<WatchValue | null> {
    const match = expression.match(/^\*\s*\(\s*([^)]+?)\s*\*\s*\)\s*(.+)$/);
    if (!match) return null;
    const typeName = this.normalizeTypeName(match[1]);
    const address = await this.resolveAddressExpression(match[2], watchContext);
    if (address === null) return null;

    const builtinSize = this.getBuiltinTypeSize(typeName);
    const offset = this.findDwarfTypeOffsetByName(typeName);
    const resolved = offset ? this.resolveDwarfType(offset) : null;
    const size = builtinSize || this.getScalarReadSize(resolved?.byteSize, resolved) || 4;
    const raw = await this.evaluateReadMemory(address, size, watchContext);
    if (!raw) return null;
    const formatted = this.formatScalarValue(raw, size, resolved || { kind: 'base', name: typeName });
    return {
      expression,
      evaluateName: expression,
      value: formatted.value,
      display: formatted.display,
      hex: formatted.hex,
      exactValue: formatted.exactValue,
      numericValueExact: formatted.numericValueExact,
      address,
      typeName,
    };
  }

  private formatBoundedString(raw: Uint8Array): { display: string; error?: string } {
    const terminator = raw.indexOf(0);
    const bytes = terminator >= 0 ? raw.slice(0, terminator) : raw;
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      text = Array.from(bytes).map(byte => {
        if (byte >= 0x20 && byte <= 0x7E && byte !== 0x22 && byte !== 0x5C) return String.fromCharCode(byte);
        return `\\x${byte.toString(16).toUpperCase().padStart(2, '0')}`;
      }).join('');
    }
    return {
      display: `${JSON.stringify(text)}${terminator >= 0 ? '' : ' (unterminated)'}`,
      ...(terminator >= 0 ? {} : { error: 'unterminated string' }),
    };
  }

  private async readBoundedString(address: number, maxBytes: number, watchContext?: WatchEvaluationContext): Promise<{ display: string; error?: string } | null> {
    const raw = await this.evaluateReadMemory(address, maxBytes, watchContext);
    return raw ? this.formatBoundedString(raw) : null;
  }

  private async evaluateCharPointerExpression(
    expression: string,
    watchContext?: WatchEvaluationContext,
  ): Promise<WatchValue | null> {
    const match = expression.match(/^\(\s*(?:const\s+)?char\s*\*\s*\)\s*(.+)$/);
    if (!match) return null;
    const address = await this.resolveAddressExpression(match[1], watchContext);
    if (address === null) return null;
    const formatted = await this.readBoundedString(address, 256, watchContext);
    if (!formatted) return null;
    return {
      expression,
      evaluateName: expression,
      value: address,
      display: formatted.display,
      hex: `0x${address.toString(16).toUpperCase()}`,
      address,
      typeName: 'char *',
      error: formatted.error,
    };
  }

  private async evaluateCastStructExpression(
    expression: string,
    watchContext?: WatchEvaluationContext,
  ): Promise<WatchValue | null> {
    const match = expression.match(/^\(\s*\(?\s*(?:struct\s+)?([A-Za-z_]\w*)\s*\*\s*\)?\s*\)\s*(?:\(\s*)?(.+?)(?:\s*\))?$/);
    if (!match) return null;
    const typeName = this.normalizeTypeName(match[1]);
    const address = await this.resolveAddressExpression(match[2], watchContext);
    if (address === null) return null;
    return this.evaluateStructAtAddress(expression, typeName, address, watchContext);
  }

  private async evaluateFieldAccessExpression(
    expression: string,
    watchContext?: WatchEvaluationContext,
  ): Promise<WatchValue | null> {
    const match = expression.match(/^(.+?)(->|\.)\s*([A-Za-z_]\w*)$/);
    if (!match) return null;
    const baseExpr = match[1].trim();
    const operator = match[2];
    const fieldName = match[3];
    let base = await this.evaluateCastStructExpression(baseExpr, watchContext);
    if (!base && !/^[A-Za-z_]\w*$/.test(baseExpr)) {
      // A field chain can itself be the base of a later member access, e.g.
      // pitch->angle_pid->kp. Resolve the shorter left-hand chain first so a
      // pointer-valued intermediate field supplies its evaluated children.
      base = await this.evaluateFieldAccessExpression(baseExpr, watchContext);
    }
    if (!base && /^[A-Za-z_]\w*$/.test(baseExpr)) {
      const sym = this.symbols.find(s => s.name === baseExpr) || this.symbols.find(s => s.name.toLowerCase() === baseExpr.toLowerCase());
      if (sym) {
        const offset = this.dwarfInfo.varToType.get(sym.name);
        const resolved = offset ? this.resolveDwarfType(offset) : null;
        if (operator === '->' && resolved?.kind === 'pointer' && resolved.typeOffset) {
          const raw = await this.evaluateReadMemory(
            sym.address,
            this.getScalarReadSize(sym.size, resolved),
            watchContext,
          );
          const pointeeAddress = raw ? this.readUnsignedLittleEndian(raw, raw.length) >>> 0 : 0;
          if (pointeeAddress) {
            base = await this.evaluateStructAtTypeOffset(baseExpr, resolved.typeOffset, pointeeAddress, watchContext);
          }
        } else {
          const typeName = offset ? this.getDwarfTypeName(offset) : '';
          base = await this.evaluateStructAtAddress(baseExpr, typeName, sym.address, watchContext);
        }
      }
    }
    const child = base?.children?.find(c => c.expression === fieldName);
    return child || null;
  }

  private async evaluateStructAtAddress(
    expression: string,
    typeName: string,
    address: number,
    watchContext?: WatchEvaluationContext,
  ): Promise<WatchValue | null> {
    const offset = this.findDwarfTypeOffsetByName(typeName) || (typeName === 'TCB_t' ? this.findDwarfTypeOffsetByName('tskTaskControlBlock') : undefined);
    if (!offset) return null;
    return this.evaluateStructAtTypeOffset(expression, offset, address, watchContext);
  }

  private async evaluateStructAtTypeOffset(
    expression: string,
    typeOffset: string,
    address: number,
    watchContext?: WatchEvaluationContext,
  ): Promise<WatchValue | null> {
    const typeName = this.getDwarfTypeName(typeOffset);
    const offset = typeOffset;
    const resolved = offset ? this.resolveDwarfType(offset) : null;
    if (!resolved || (resolved.kind !== 'struct' && resolved.kind !== 'union') || !resolved.fields || !resolved.byteSize) return null;
    const raw = await this.evaluateReadMemory(address, resolved.byteSize, watchContext);
    if (!raw) return null;
    const children = await this.evaluateStructFields(
      raw,
      resolved.fields,
      resolved.typeDefs || this.dwarfInfo.typeDefs,
      address,
      expression,
      0,
      watchContext,
    );
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

  private async resolveAddressExpression(
    expression: string,
    watchContext?: WatchEvaluationContext,
  ): Promise<number | null> {
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
      const raw = await this.evaluateReadMemory(
        sym.address,
        Math.max(1, Math.min(sym.size || 4, 4)),
        watchContext,
      );
      return raw ? this.readUnsignedLittleEndian(raw, raw.length) >>> 0 : sym.address;
    }
    const field = await this.evaluateFieldAccessExpression(expr, watchContext);
    // For fields that have an address (arrays, struct members), use that memory
    // address rather than the scalar value (which for char arrays is the first
    // character, not the address of the string).
    if (field) {
      if (field.address !== undefined) return field.address >>> 0;
      if (field.children && field.children.length > 0) return field.address ?? (typeof field.value === 'number' ? field.value >>> 0 : null);
      return typeof field.value === 'number' ? field.value >>> 0 : null;
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

  private isBooleanType(info: { kind?: string; encoding?: string; name?: string; typeName?: string } | null): boolean {
    if (!info || info.kind !== 'base') return false;
    const name = `${info.typeName || ''} ${info.name || ''}`.trim().toLowerCase();
    const encoding = (info.encoding || '').toLowerCase();
    return encoding.includes('boolean') || /(^|\s)(bool|_bool)$/.test(name);
  }

  private isCharType(info: { kind?: string; encoding?: string; name?: string; typeName?: string } | null): boolean {
    if (!info || info.kind !== 'base') return false;
    const name = `${info.typeName || ''} ${info.name || ''}`.trim().toLowerCase();
    return /(^|\s)char$/.test(name) && !/u?int8_t|signed char|unsigned char/.test(name);
  }

  private getScalarReadSize(symbolSize: number | undefined, info: { byteSize?: number } | null): number {
    const typeSize = info?.byteSize || 0;
    const size = typeSize > 0 ? typeSize : (symbolSize && symbolSize > 0 ? symbolSize : 4);
    return Math.max(1, Math.min(size, 8));
  }

  private readUnsignedLittleEndianBigInt(raw: Uint8Array, byteSize: number): bigint {
    const count = Math.min(byteSize, raw.length);
    let value = 0n;
    let factor = 1n;
    for (let i = 0; i < count; i++) {
      value += BigInt(raw[i]) * factor;
      factor *= 256n;
    }
    return value;
  }

  private readUnsignedLittleEndian(raw: Uint8Array, byteSize: number): number {
    const value = this.readUnsignedLittleEndianBigInt(raw, byteSize);
    return Number(value);
  }

  private formatChar(value: bigint): string {
    const byte = Number(value & 0xFFn);
    if (byte === 0x0A) return '\\n';
    if (byte === 0x0D) return '\\r';
    if (byte === 0x09) return '\\t';
    if (byte === 0x5C) return '\\\\';
    if (byte === 0x27) return "\\'";
    if (byte >= 0x20 && byte <= 0x7E) return String.fromCharCode(byte);
    return `\\x${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }

  private formatScalarValue(
    raw: Uint8Array,
    byteSize: number,
    info: {
      kind?: string;
      encoding?: string;
      name?: string;
      typeName?: string;
      enumerators?: Array<{ name: string; value: string }>;
    } | null,
  ): { value: number | string; display: string; hex: string; exactValue?: string; numericValueExact?: boolean } {
    const unsigned = this.readUnsignedLittleEndianBigInt(raw, byteSize);
    const bits = BigInt(byteSize * 8);
    const range = 1n << bits;
    const signBit = 1n << (bits - 1n);
    const signed = this.isSignedIntegerType(info) || info?.kind === 'enum';
    const integer = signed && unsigned >= signBit ? unsigned - range : unsigned;
    const exactValue = integer.toString(10);
    const numeric = Number(integer);
    const numericValueExact = Number.isSafeInteger(numeric);
    const value: number | string = numericValueExact ? numeric : exactValue;
    const hex = `0x${unsigned.toString(16).toUpperCase().padStart(byteSize * 2, '0')}`;
    const exactSuffix = numericValueExact ? `${numeric}` : exactValue;

    if (this.isBooleanType(info)) {
      return { value, display: `${hex} (${exactSuffix}, ${integer === 0n ? 'false' : 'true'})`, hex, exactValue: numericValueExact ? undefined : exactValue, numericValueExact };
    }

    if (this.isCharType(info)) {
      return { value, display: `'${this.formatChar(unsigned)}' (${exactSuffix}, ${hex})`, hex, exactValue: numericValueExact ? undefined : exactValue, numericValueExact };
    }

    if (info?.kind === 'enum') {
      const enumerator = info.enumerators?.find(item => {
        try { return BigInt(item.value) === integer; } catch { return false; }
      });
      const suffix = enumerator ? `${exactSuffix}, ${enumerator.name}` : exactSuffix;
      return { value, display: `${hex} (${suffix})`, hex, exactValue: numericValueExact ? undefined : exactValue, numericValueExact };
    }

    return { value, display: `${hex} (${exactSuffix})`, hex, exactValue: numericValueExact ? undefined : exactValue, numericValueExact };
  }

  private readBytesAsFloat(raw: Uint8Array, byteSize: number): number {
    if (raw.length < byteSize) return 0;
    const buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + byteSize);
    const dv = new DataView(buf);
    if (byteSize === 8) return dv.getFloat64(0, true);
    return dv.getFloat32(0, true);
  }

  private resolveDwarfType(offset: string, visited?: Set<string>): { kind: string; name: string; byteSize: number; fields?: DwarfField[]; enumerators?: Array<{ name: string; value: string }>; typeDefs?: Map<string, DwarfTypeInfo>; typeName?: string; typeOffset?: string; arrayCount?: number; encoding?: string } | null {
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
    if (info.kind === 'struct' || info.kind === 'union') {
      return { kind: info.kind, name: info.name, byteSize: info.byteSize, fields: info.fields, typeDefs: this.dwarfInfo.typeDefs };
    }
    return { kind: info.kind, name: info.name, byteSize: info.byteSize, typeName: info.name, typeOffset: info.typeOffset, arrayCount: info.arrayCount, encoding: info.encoding, enumerators: info.enumerators };
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

  private throwIfEvaluationCancelled(context?: WatchEvaluationContext): void {
    if (context?.signal?.aborted) throw new EvaluateCancelledError();
  }

  private async evaluateReadMemory(
    address: number,
    size: number,
    context?: WatchEvaluationContext,
  ): Promise<Uint8Array | null> {
    this.throwIfEvaluationCancelled(context);
    try {
      const raw = await this.targetReadMemory(address, size, context?.priority, context?.signal);
      this.throwIfEvaluationCancelled(context);
      return raw;
    } catch (error) {
      this.throwIfEvaluationCancelled(context);
      throw error;
    }
  }

  private pointerTargetHasChildren(typeOffset: string): boolean {
    const resolved = this.resolveDwarfType(typeOffset);
    return (resolved?.kind === 'struct' || resolved?.kind === 'union') && !!resolved.fields?.length;
  }

  private isFunctionPointerType(info: { kind?: string; typeOffset?: string } | null): boolean {
    return info?.kind === 'pointer' && !!info.typeOffset && this.resolveDwarfType(info.typeOffset)?.kind === 'subroutine';
  }

  private formatFunctionPointer(value: number): string {
    if ((value >>> 0) === 0) return 'NULL';
    const normalizedAddress = (value >>> 0) & ~1;
    const symbol = this.symbols.find(item => /^(T|t|W|w)$/.test(item.type) && (item.address >>> 0) === normalizedAddress);
    const address = this.formatAddress(value);
    return symbol ? `${symbol.name} @ ${address}` : `${address} (<unknown>)`;
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
      this.throwIfEvaluationCancelled(watchContext);
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
    this.throwIfEvaluationCancelled(watchContext);
    if (_depth > OzoneBackend.MAX_POINTER_DEPTH) return undefined;
    const pointee = this.resolveDwarfType(typeOffset);
    if (!pointee || (pointee.kind !== 'struct' && pointee.kind !== 'union') || !pointee.fields || !pointee.byteSize) return undefined;
    const raw = await this.evaluateReadMemory(address, pointee.byteSize, watchContext);
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
    this.throwIfEvaluationCancelled(watchContext);
    const addr = baseAddress + field.byteOffset;
    const evaluateName = parentExpr ? `${parentExpr}.${field.name}` : field.name;
    const resolved = this.resolveDwarfType(field.typeOffset);
    const resolvedKind = resolved?.kind || '';
    const resolvedName = resolved?.name || '';
    const resolvedByteSize = resolved?.byteSize || 0;
    const resolvedTypeName = this.getDwarfTypeName(field.typeOffset) || resolvedName;

    if ((resolvedKind === 'struct' || resolvedKind === 'union') && resolved?.fields) {
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
        this.throwIfEvaluationCancelled(watchContext);
        const elemAddr = addr + i * elemSize;
        const elemRawOffset = i * elemSize;
        if ((elemType?.kind === 'struct' || elemType?.kind === 'union') && elemType.fields) {
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
          let value: number | string;
          let display: string;
          let hex: string;
          let exactValue: string | undefined;
          let numericValueExact: boolean | undefined;
          if (isFloatArrElem && elemRaw.length >= elemSize) {
            value = this.readBytesAsFloat(elemRaw, elemSize);
            display = elemSize === 8 ? `${value.toExponential(6)}` : `${value.toFixed(6)}`;
            hex = `0x${Array.from(elemRaw).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
          } else {
            const formatted = this.formatScalarValue(elemRaw, elemSize, elemType);
            value = formatted.value;
            display = formatted.display;
            hex = formatted.hex;
            exactValue = formatted.exactValue;
            numericValueExact = formatted.numericValueExact;
          }
          if (this.isFunctionPointerType(elemType) && typeof value === 'number') {
            display = this.formatFunctionPointer(value);
          }
          const elementExpression = `${evaluateName}[${i}]`;
          const pointerHasChildren = elemType?.kind === 'pointer'
            && !!elemType.typeOffset
            && this.pointerTargetHasChildren(elemType.typeOffset);
          const pointerValue = typeof value === 'number' ? value : null;
          const pointerChildren = pointerHasChildren && pointerValue && this.shouldExpandWatchNode(elementExpression, watchContext)
            ? await this.evaluatePointerChildren(pointerValue >>> 0, elemType!.typeOffset!, elementExpression, _depth + 1, watchContext)
            : undefined;
          children.push({
            expression: `[${i}]`,
            evaluateName: `${evaluateName}[${i}]`,
            value,
            display: elemType?.kind === 'pointer' && !this.isFunctionPointerType(elemType) && typeof value === 'number' ? this.formatAddress(value) : display,
            hex,
            exactValue,
            numericValueExact,
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

    let value: number | string;
    let display: string;
    let hex: string;
    let exactValue: string | undefined;
    let numericValueExact: boolean | undefined;
    if (isFloat && fieldRaw.length >= fieldSize) {
      value = this.readBytesAsFloat(fieldRaw, fieldSize);
      display = fieldSize === 8 ? `${value.toExponential(6)}` : `${value.toFixed(6)}`;
      hex = `0x${Array.from(fieldRaw).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
    } else {
      const formatted = this.formatScalarValue(fieldRaw, fieldSize, resolved);
      value = formatted.value;
      display = formatted.display;
      hex = formatted.hex;
      exactValue = formatted.exactValue;
      numericValueExact = formatted.numericValueExact;
    }
    if (this.isFunctionPointerType(resolved) && typeof value === 'number') {
      display = this.formatFunctionPointer(value);
    }

    const pointerHasChildren = resolvedKind === 'pointer'
      && !!resolved?.typeOffset
      && this.pointerTargetHasChildren(resolved.typeOffset);
    const pointerValue = typeof value === 'number' ? value : null;
    const pointerChildren = pointerHasChildren && pointerValue && this.shouldExpandWatchNode(evaluateName, watchContext)
      ? await this.evaluatePointerChildren(pointerValue >>> 0, resolved!.typeOffset!, evaluateName, _depth + 1, watchContext)
      : undefined;

    return {
      expression: field.name,
      evaluateName,
      value,
      display: resolvedKind === 'pointer' && !this.isFunctionPointerType(resolved) && typeof value === 'number' ? this.formatAddress(value) : display,
      hex,
      exactValue,
      numericValueExact,
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
    if (this.isCmsisDapOwner()
      && (writeAddress < 0x20000000 || writeAddress + writeSize > 0x20020000)) {
      return {
        ok: false,
        error: `CMSIS-DAP Watch writes require an STM32F407 SRAM address: 0x${writeAddress.toString(16)}`,
        errorCode: 'InvalidWatchWriteAddress',
        targetState: this.state,
        diagnostics: { ownerKind: 'cmsis-dap', address: writeAddress, size: writeSize },
      };
    }
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
