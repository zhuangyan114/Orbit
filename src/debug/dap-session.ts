import { EventEmitter } from 'events';
import { StringDecoder } from 'string_decoder';
import { OzoneBackend } from '../ozone-backend/commander';
import { DataPoint, FastDataSamplePlanItem, FastDataSampleSpec, MemoryBlock, Variable, StackFrame, WatchValue } from '../ozone-backend/types';
import { PRtLogDecoder } from './p-rtlog-decoder';

let daLog_Enabled = false;
function daLog(msg: string) {
  if (daLog_Enabled) {
    process.stderr.write('[DapSession] ' + msg + '\n');
  }
}
function enableDaLog() { daLog_Enabled = true; }

export interface DebugProtocolMessage {
  type: 'request' | 'response' | 'event';
  seq: number;
  command?: string;
  arguments?: any;
  success?: boolean;
  body?: any;
  message?: string;
  event?: string;
  request_seq?: number;
}

interface DapSamplingEntry {
  expression: string;
  color: string;
}

export class DapSession extends EventEmitter {
  private backend: OzoneBackend;
  private seq = 1;
  private pollTimer: NodeJS.Timeout | null = null;
  private rttPollTimer: NodeJS.Timeout | null = null;
  private rttLogEnabled = true;
  private rttStarted = false;
  private rttBufferIndex = 0;
  private rttPollIntervalMs = 50;
  private rttReadSize = 4096;
  private rttControlBlockAddress: number | undefined;
  private rttStripAnsi = true;
  private _rtos = '';
  private rttLogTarget: 'terminal' | 'debugConsole' | 'both' = 'terminal';
  private rttDecoder = new StringDecoder('utf8');
  private rttControlCarry = '';
  private rttLineCarry = '';
  private pRtLogEnabled = false;
  private pRtLogRoot = 'D:\\STM32\\tool\\P-RTLog';
  private pRtLogDecoder = new PRtLogDecoder();
  private watchExpressions: string[] = [];
  private _watchPollCycle = 0;
  private lastHaltReason: 'entry' | 'breakpoint' | 'step' | 'pause' = 'entry';
  private targetRunning = false;
  private controlInProgress = false;
  private readCancelEpoch = 0;
  private targetReadInProgress = false;
  private lowPriorityReadBlockedUntil = 0;

  private breakpoints = new Map<string, number>();
  private stepLock: Promise<void> = Promise.resolve();

  private _elfPath = '';
  private _device = '';
  private _interface = 'SWD';
  private _speedKHz = 4000;
  private _flashEnabled = true;
  private dataSamplingActive = false;
  private dataSamplingTimer: NodeJS.Immediate | null = null;
  private dataSamplingEntries: DapSamplingEntry[] = [];
  private dataSamplingSpecs: FastDataSampleSpec[] = [];
  private dataSamplingPending = new Map<string, DataPoint[]>();
  private dataSamplingLastDisplay = new Map<string, string>();
  private dataSamplingIntervalMs = 0.2;
  private dataSamplingSendIntervalMs = 16;
  private dataSamplingNextSampleMs = 0;
  private dataSamplingNextSendMs = 0;
  private readonly highResEpochMs = Date.now();
  private readonly highResStartNs = process.hrtime.bigint();
  private variableHandles = new Map<number, WatchValue[]>();
  private nextVariableHandle = 1000;
  private runtimeWatchReadInFlight = false;
  private runtimeWatchCache = new Map<string, WatchValue>();
  private runtimeWatchCacheTime = new Map<string, number>();
  private readonly runtimeEvaluateCacheMs = 250;

  constructor(backend: OzoneBackend) {
    super();
    this.backend = backend;
  }

  private async withStepLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.stepLock;
    let resolve: () => void;
    this.stepLock = new Promise<void>(r => { resolve = r; });
    await prev;
    try {
      return await fn();
    } finally {
      resolve!();
    }
  }

  private beginControl() {
    this.controlInProgress = true;
    this.readCancelEpoch++;
  }

  private endControl() {
    this.controlInProgress = false;
  }

  private shouldDeferTargetRead(): boolean {
    return this.controlInProgress;
  }

  private beginTargetRead(priority: 'high' | 'low' = 'low'): boolean {
    if (this.shouldDeferTargetRead() || this.targetReadInProgress) return false;
    if (priority === 'low' && Date.now() < this.lowPriorityReadBlockedUntil) return false;
    this.targetReadInProgress = true;
    return true;
  }

  private async beginTargetReadWhenAvailable(priority: 'high' | 'low' = 'low', timeoutMs = 0): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!this.beginTargetRead(priority)) {
      if (this.controlInProgress || Date.now() >= deadline) return false;
      await new Promise<void>(resolve => setTimeout(resolve, 20));
    }
    return true;
  }

  private endTargetRead() {
    this.targetReadInProgress = false;
  }

  private cachedOrRunningWatchValue(expression: string): WatchValue {
    return this.runtimeWatchCache.get(expression) || this.makeRunningWatchValue(expression);
  }

  private sendEvaluateValue(msg: DebugProtocolMessage, value: WatchValue, allowChildren: boolean) {
    this.sendResponse(msg, {
      result: value.display || value.hex || value.error || `${value.value}`,
      type: value.typeName || undefined,
      variablesReference: allowChildren ? this.allocateVariableHandle(value.children) : 0,
      memoryReference: this.memoryReferenceForWatch(value),
    });
  }

  private markStoppedForUi() {
    this.targetRunning = false;
    this.readCancelEpoch++;
    this.lowPriorityReadBlockedUntil = Date.now() + 150;
  }

  private isRtosEvaluateExpression(expression: string): boolean {
    return expression === 'uxCurrentNumberOfTasks'
      || expression === 'pxCurrentTCB'
      || expression === 'pxCurrentTCBs'
      || expression === 'pxReadyTasksLists'
      || expression === 'ulTotalRunTime'
      || expression === 'uxTopReadyPriority'
      || expression.includes('xDelayed')
      || expression.includes('xPending')
      || expression.includes('xSuspended')
      || expression.includes('xTasksWaitingTermination')
      || expression.includes('xQueueRegistry')
      || expression.includes('xTimerQueue')
      || expression.includes('pxCurrentTCBs')
      || expression.includes('ulTotalRunTime')
      || expression.includes('TCB_t')
      || expression.includes('tskTaskControlBlock')
      || expression.includes('Queue_t')
      || expression.includes('List_t')
      || expression.includes('ListItem_t')
      || expression.includes('ulRunTimeCounter')
      || expression.includes('pcTaskName')
      || expression.includes('pxTopOfStack')
      || expression.includes('pxStack');
  }

  handleMessage(message: DebugProtocolMessage): void {
    if (message.type === 'request') {
      this.handleRequest(message);
    }
  }

  private sendResponse(msg: DebugProtocolMessage, body?: any, success = true, message?: string) {
    this.emit('send', {
      type: 'response', seq: this.seq++,
      request_seq: msg.seq, success, command: msg.command || '', body, message,
    } as DebugProtocolMessage);
  }

  private sendEvent(event: string, body?: any) {
    this.emit('send', { type: 'event', seq: this.seq++, event, body } as DebugProtocolMessage);
  }

  private resetVariableHandles() {
    this.variableHandles.clear();
    this.nextVariableHandle = 1000;
  }

  private allocateVariableHandle(children?: WatchValue[]): number {
    if (!children || children.length === 0) return 0;
    const ref = this.nextVariableHandle++;
    this.variableHandles.set(ref, children);
    return ref;
  }

  private formatMemoryReference(address: number): string {
    return `0x${Math.max(0, address >>> 0).toString(16).toUpperCase()}`;
  }

  private parseMemoryReference(memoryReference: unknown, offset: unknown = 0): number | null {
    if (typeof memoryReference !== 'string' && typeof memoryReference !== 'number') return null;
    const refText = String(memoryReference).trim();
    const match = refText.match(/0x[0-9a-fA-F]+|\b\d+\b/);
    if (!match) return null;
    const base = match[0].toLowerCase().startsWith('0x') ? parseInt(match[0], 16) : parseInt(match[0], 10);
    if (!Number.isFinite(base)) return null;
    const off = typeof offset === 'number' && Number.isFinite(offset) ? offset : 0;
    return (base + off) >>> 0;
  }

  private memoryReferenceForWatch(value: WatchValue): string | undefined {
    if (value.typeName?.includes('*') && value.value) {
      return this.formatMemoryReference(value.value);
    }
    if (typeof value.address === 'number') {
      return this.formatMemoryReference(value.address);
    }
    if ((value.expression.startsWith('&') || /^0x[0-9a-fA-F]+$/.test(value.expression)) && Number.isFinite(value.value)) {
      return this.formatMemoryReference(value.value);
    }
    return undefined;
  }

  private toDapVariable(value: WatchValue) {
    return {
      name: value.expression,
      value: value.error || value.display || value.hex || `${value.value}`,
      type: value.typeName || undefined,
      variablesReference: this.allocateVariableHandle(value.children),
      memoryReference: this.memoryReferenceForWatch(value),
      evaluateName: value.evaluateName || value.expression,
    };
  }

  private startPolling() {
    this.stopPolling();
    daLog(`startPolling: started, ${this.watchExpressions.length} watch expressions`);
    const pollLoop = async () => {
      if (this.pollTimer === null) return;
      try {
        if (this.pollTimer === null) return;
        const stateResult = await this.backend.execute({ cmd: 'getTargetState' });
        daLog(`pollLoop: state=${stateResult.ok ? stateResult.data : 'error'}`);
        if (stateResult.ok && stateResult.data === 'halted') {
          daLog('pollLoop: CPU is halted, stopping polling');
          this.markStoppedForUi();
          this.sendEvent('stopped', { reason: this.lastHaltReason, threadId: 1 });
          this.stopPolling();
          if (this.watchExpressions.length > 0) {
            setTimeout(() => {
              void this.readWatchExpressions(this.watchExpressions, false)
                .then(results => this.sendWatchUpdate(results))
                .catch(err => daLog(`pollLoop: deferred watch read error ${err}`));
            }, 150);
          }
          return;
        }

        daLog('pollLoop: target running');
      } catch (err) {
        daLog(`startPolling: error ${err}`);
      }
      if (this.pollTimer !== null) {
        this.pollTimer = setTimeout(pollLoop, 200);
      }
    };
    this.pollTimer = setTimeout(pollLoop, 200);
  }

  private sendWatchUpdate(results: any[]) {
    this.sendEvent('ozoneWatchData', { results });
  }

  private makeRunningWatchValue(expression: string): WatchValue {
    return { expression, value: 0, display: '', hex: '', error: 'running' };
  }

  private makeRunningWatchValues(expressions: string[]): WatchValue[] {
    return expressions.map(expression => this.makeRunningWatchValue(expression));
  }

  private cacheRuntimeWatchValue(expression: string, value: WatchValue) {
    this.runtimeWatchCache.set(expression, value);
    this.runtimeWatchCacheTime.set(expression, Date.now());
  }

  private getFreshRuntimeWatchValue(expression: string, maxAgeMs = this.runtimeEvaluateCacheMs): WatchValue | undefined {
    const cached = this.runtimeWatchCache.get(expression);
    const timestamp = this.runtimeWatchCacheTime.get(expression);
    if (!cached || timestamp === undefined || Date.now() - timestamp > maxAgeMs) return undefined;
    return cached;
  }

  private async isTargetHalted(): Promise<boolean> {
    const result = await this.backend.execute({ cmd: 'getTargetState' });
    return result.ok && result.data === 'halted';
  }

  private async readWatchExpressions(expressions: string[], forceRuntimeRead: boolean): Promise<WatchValue[]> {
    if (expressions.length === 0) return [];
    const epoch = this.readCancelEpoch;
    if (!this.beginTargetRead()) {
      return expressions.map(expr => this.cachedOrRunningWatchValue(expr));
    }
    try {
      const halted = await this.isTargetHalted();
      if (!halted && forceRuntimeRead) {
        return await this.readRuntimeWatchExpressions(expressions);
      }
      if (!halted) {
        return expressions.map(expr => this.cachedOrRunningWatchValue(expr));
      }
      if (epoch !== this.readCancelEpoch || this.shouldDeferTargetRead()) {
        return expressions.map(expr => this.cachedOrRunningWatchValue(expr));
      }

      const results: WatchValue[] = [];
      for (const expr of expressions) {
        if (epoch !== this.readCancelEpoch || this.shouldDeferTargetRead()) {
          results.push(this.cachedOrRunningWatchValue(expr));
          continue;
        }
        const result = await this.backend.execute({ cmd: 'evaluateExpression', expression: expr });
        if (result.ok) {
          const value = result.data as WatchValue;
          this.cacheRuntimeWatchValue(expr, value);
          results.push(value);
        } else {
          results.push(this.runtimeWatchCache.get(expr) || { expression: expr, value: 0, display: '', hex: '', error: result.error });
        }
      }
      return results;
    } finally {
      this.endTargetRead();
    }
  }

  private async readRuntimeWatchExpressions(expressions: string[]): Promise<WatchValue[]> {
    if (this.controlInProgress) {
      return expressions.map(expr => this.cachedOrRunningWatchValue(expr));
    }
    if (this.runtimeWatchReadInFlight) {
      return expressions.map(expr => this.cachedOrRunningWatchValue(expr));
    }

    this.runtimeWatchReadInFlight = true;
    try {
      const results: WatchValue[] = [];
      const epoch = this.readCancelEpoch;
      for (const expr of expressions) {
        if (epoch !== this.readCancelEpoch || this.controlInProgress) {
          results.push(this.cachedOrRunningWatchValue(expr));
          continue;
        }
        const result = await this.backend.execute({ cmd: 'evaluateExpression', expression: expr, force: true });
        if (result.ok) {
          const value = result.data as WatchValue;
          this.cacheRuntimeWatchValue(expr, value);
          results.push(value);
        } else {
          results.push(this.runtimeWatchCache.get(expr) || { expression: expr, value: 0, display: '', hex: '', error: result.error });
        }
      }
      return results;
    } finally {
      this.runtimeWatchReadInFlight = false;
    }
  }

  private stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
      daLog('stopPolling: stopped');
    }
  }

  private startRttLogPolling() {
    this.stopRttLogPolling();
    this.rttStarted = false;
    this.rttDecoder = new StringDecoder('utf8');
    this.rttControlCarry = '';
    this.rttLineCarry = '';
    this.pRtLogDecoder.resetFrames();
    this.emitRttTerminalStarted();

    const pollLoop = async () => {
      if (this.rttPollTimer === null) return;
      try {
        if (!this.rttStarted) {
          const startResult = await this.backend.execute({
            cmd: 'startRtt',
            controlBlockAddress: this.rttControlBlockAddress,
          });
          this.rttStarted = startResult.ok;
        }

        if (this.rttStarted) {
          const readResult = await this.backend.execute({
            cmd: 'readRtt',
            bufferIndex: this.rttBufferIndex,
            size: this.rttReadSize,
          });
          if (readResult.ok) {
            const bytes = (readResult.data as any)?.bytes;
            if (Array.isArray(bytes) && bytes.length > 0) {
              this.emitRttBytes(Buffer.from(bytes));
            }
          } else {
            this.rttStarted = false;
          }
        }
      } catch {
        this.rttStarted = false;
      }

      if (this.rttPollTimer !== null) {
        this.rttPollTimer = setTimeout(pollLoop, this.rttPollIntervalMs);
      }
    };

    this.rttPollTimer = setTimeout(pollLoop, this.rttPollIntervalMs);
  }

  private stopRttLogPolling() {
    if (this.rttPollTimer) {
      clearTimeout(this.rttPollTimer);
      this.rttPollTimer = null;
    }
    const trailing = this.rttDecoder.end();
    if (trailing) {
      this.emitRttOutput(trailing);
    }
    if (this.pRtLogEnabled) {
      for (const line of this.pRtLogDecoder.flush()) {
        this.emitRttOutput(line);
      }
    }
    if (this.rttControlCarry) {
      this.emitRttText(this.rttControlCarry);
    }
    if (this.rttLineCarry) {
      this.emitRttLine(this.rttLineCarry);
    }
    this.rttDecoder = new StringDecoder('utf8');
    this.rttControlCarry = '';
    this.rttLineCarry = '';
    this.rttStarted = false;
    void this.backend.execute({ cmd: 'stopRtt' });
  }

  private stripAnsi(text: string): string {
    return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
  }

  private emitRttBytes(bytes: Buffer) {
    if (this.pRtLogEnabled) {
      for (const line of this.pRtLogDecoder.feed(bytes)) {
        this.emitRttOutput(line);
      }
      return;
    }

    this.emitRttOutput(this.rttDecoder.write(bytes));
  }

  private emitRttOutput(text: string) {
    text = this.rttControlCarry + text;
    this.rttControlCarry = this.takeTrailingClearPrefix(text);
    if (this.rttControlCarry) {
      text = text.slice(0, -this.rttControlCarry.length);
    }

    const clearPattern = /\x1B\[2J/g;
    let cursor = 0;
    let match: RegExpExecArray | null;
    while ((match = clearPattern.exec(text)) !== null) {
      const beforeClear = text.slice(cursor, match.index).replace(/[ \t]+$/g, '');
      this.emitRttText(beforeClear);
      this.sendEvent('ozoneClearDebugConsole', {});
      this.sendRttClearMarker();
      cursor = match.index + match[0].length;
    }
    this.emitRttText(text.slice(cursor));
  }

  private sendRttClearMarker() {
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    this.emitRttTerminalText(`\x1B[2J\x1B[H\x1B[1;36m========== RTT Log_Clear() ${time} ==========\x1B[0m\r\n`);
    this.emitRttDebugConsoleLine(`\n========== RTT Log_Clear() ${time} ==========\n`, 'stdout');
  }

  private takeTrailingClearPrefix(text: string): string {
    const clearSequence = '\x1B[2J';
    for (let len = clearSequence.length - 1; len > 0; len--) {
      const suffix = text.slice(-len);
      if (clearSequence.startsWith(suffix)) return suffix;
    }
    return '';
  }

  private emitRttText(text: string) {
    if (text.length === 0) return;

    text = this.rttLineCarry + text;
    this.rttLineCarry = '';

    let cursor = 0;
    const linePattern = /\r\n|\n|\r/g;
    let match: RegExpExecArray | null;
    while ((match = linePattern.exec(text)) !== null) {
      this.emitRttLine(text.slice(cursor, match.index + match[0].length));
      cursor = match.index + match[0].length;
    }

    const rest = text.slice(cursor);
    if (rest.length > 0) {
      this.rttLineCarry = rest;
    }
  }

  private emitRttLine(text: string) {
    if (text.length > 0) {
      this.emitRttTerminalText(text);
    }
    const output = this.rttStripAnsi ? this.stripAnsi(text) : text;
    if (output.length <= 0) return;
    const category = this.isWarningOrErrorRttLine(text) ? 'stderr' : 'stdout';
    this.emitRttDebugConsoleLine(output, category);
  }

  private isWarningOrErrorRttLine(text: string): boolean {
    if (/\x1B\[1;3[13]m\s*[WE]:/.test(text)) return true;
    return /^\s*[WE]:/.test(this.stripAnsi(text));
  }

  private emitRttTerminalText(text: string) {
    if (this.rttLogTarget === 'terminal' || this.rttLogTarget === 'both') {
      this.sendEvent('ozoneRttOutput', { text });
    }
  }

  private emitRttTerminalStarted() {
    if (this.rttLogTarget === 'terminal' || this.rttLogTarget === 'both') {
      this.sendEvent('ozoneRttStarted', {});
    }
  }

  private emitRttDebugConsoleLine(output: string, category: 'stdout' | 'stderr') {
    if (this.rttLogTarget === 'debugConsole' || this.rttLogTarget === 'both') {
      this.sendEvent('output', { category, output });
    }
  }

  private parseRttLogTarget(value: unknown): 'terminal' | 'debugConsole' | 'both' {
    return value === 'debugConsole' || value === 'both' ? value : 'terminal';
  }

  private async handleRequest(msg: DebugProtocolMessage) {
    try {
      switch (msg.command) {
        case 'initialize':
          return this.sendResponse(msg, {
            supportsConfigurationDoneRequest: true,
            supportsConditionalBreakpoints: false,
            supportsHitConditionalBreakpoints: false,
            supportsEvaluateForHovers: true,
            supportsStepBack: false,
            supportsSetVariable: false,
            supportsRestartFrame: false,
            supportsGotoTargetsRequest: false,
            supportsStepInTargetsRequest: false,
            supportsCompletionsRequest: false,
            supportsRestartRequest: true,
            supportsExceptionOptions: false,
            supportTerminateDebuggee: false,
            supportsLogPoints: false,
            supportsDataBreakpoints: false,
            supportsReadMemoryRequest: true,
            supportsWriteMemoryRequest: true,
            supportsDisassembleRequest: false,
            supportsCancelRequest: false,
            supportsBreakpointLocationsRequest: false,
            supportsSteppingGranularity: false,
            supportsInstructionBreakpoints: false,
            supportsRTOS: true,
            rtosName: this._rtos || '',
          });
        case 'launch':
          return this.handleLaunch(msg);
        case 'disconnect':
          return this.handleDisconnect(msg);
        case 'setBreakpoints':
          return this.handleSetBreakpoints(msg);
        case 'setExceptionBreakpoints':
          return this.sendResponse(msg);
        case 'configurationDone':
          return this.handleConfigurationDone(msg);
        case 'threads':
          return this.sendResponse(msg, {
            threads: [{
              id: 1,
              name: this._rtos ? `${this._device} (${this._rtos})` : this._device || 'Cortex-M4',
            }]
          });
        case 'stackTrace':
          return this.handleStackTrace(msg);
        case 'scopes':
          return this.sendResponse(msg, {
            scopes: [
              { name: 'Local', variablesReference: 1, expensive: false },
              { name: 'Registers', variablesReference: 2, expensive: false },
            ],
          });
        case 'variables':
          return this.handleVariables(msg);
        case 'readMemory':
          return this.handleReadMemory(msg);
        case 'writeMemory':
          return this.handleWriteMemory(msg);
        case 'continue':
          return this.handleContinue(msg);
        case 'next':
          return this.handleStep(msg, 'stepOver');
        case 'stepIn':
          return this.handleStep(msg, 'stepInto');
        case 'stepOut':
          return this.handleStep(msg, 'stepOut');
        case 'pause':
          return this.handlePause(msg);
        case 'restart':
          return this.handleRestart(msg);
        case 'evaluate':
          return this.handleEvaluate(msg);
        case 'watchEvaluate':
          return this.handleWatchEvaluate(msg);
        case 'setWatches':
          this.watchExpressions = msg.arguments?.expressions || [];
          daLog(`setWatches: ${this.watchExpressions.length} expressions: [${this.watchExpressions.join(', ')}]`);
          return this.sendResponse(msg);
        case 'dataSample':
          return this.handleDataSample(msg);
        case 'dataSamplingStart':
          return this.handleDataSamplingStart(msg);
        case 'dataSamplingStop':
          return this.handleDataSamplingStop(msg);
        case 'setWatchValue':
          return this.handleSetWatchValue(msg);
        case 'getTargetState':
          return this.handleGetTargetState(msg);
        case 'rtosInfo':
          return this.sendResponse(msg, {
            rtos: this._rtos,
            device: this._device,
            detected: false,
          });
        default:
          this.sendResponse(msg, undefined, false, `Unsupported: ${msg.command}`);
      }
    } catch (err: any) {
      this.sendResponse(msg, undefined, false, err.message);
    }
  }

  private async handleLaunch(msg: DebugProtocolMessage) {
    try {
      const args = msg.arguments || {};
      const device = args.device || args.deviceName || 'STM32F407VG';
      const interface_ = args.interface || 'SWD';
      const speedKHz = args.speedKHz || 4000;
      this._rtos = args.rtos || args.defaultRtos || '';
      const elfPath = args.program || args.elfPath || '';
      const flashEnabled = args.flashBeforeDebug !== false;
      this.rttLogEnabled = args.rttLogEnabled !== false;
      this.rttBufferIndex = Math.floor(this.clampNumber(args.rttBufferIndex, 0, 0, 15));
      this.rttPollIntervalMs = Math.floor(this.clampNumber(args.rttPollIntervalMs, 50, 10, 5000));
      this.rttReadSize = Math.floor(this.clampNumber(args.rttReadSize, 4096, 64, 65536));
      this.rttControlBlockAddress = this.parseOptionalAddress(args.rttControlBlockAddress);
      this.rttStripAnsi = args.rttStripAnsi !== false;
      this.rttLogTarget = this.parseRttLogTarget(args.rttLogTarget);
      this.pRtLogEnabled = args.pRtLogEnabled === true;
      this.pRtLogRoot = typeof args.pRtLogRoot === 'string' && args.pRtLogRoot.trim()
        ? args.pRtLogRoot.trim()
        : 'D:\\STM32\\tool\\P-RTLog';
      this._elfPath = elfPath;
      this._device = device;
      this._interface = interface_;
      this._speedKHz = speedKHz;
      this._flashEnabled = flashEnabled;
      console.log(`[Ozone] Launch: device=${device} rtos=${this._rtos || '(none)'} elf=${elfPath}`);
      this.resetVariableHandles();
      if (this.pRtLogEnabled) {
        const tokenLoad = this.pRtLogDecoder.loadTokenDatabase(elfPath);
        const output = tokenLoad.ok
          ? `P-RTLog enabled (${tokenLoad.count} token strings loaded from ${elfPath}).\n`
          : `P-RTLog enabled, but token database was not loaded: ${tokenLoad.error}. Root: ${this.pRtLogRoot}\n`;
        this.sendEvent('output', { category: tokenLoad.ok ? 'console' : 'stderr', output });
      }

      if (elfPath && this._flashEnabled) {
        this.sendEvent('output', { category: 'console', output: `Flashing ${elfPath}...\n` });
        const flashResult = await this.backend.execute({
          cmd: 'flash', elfPath, device, interface: interface_, speedKHz,
        });
        if (flashResult.ok) {
          this.sendEvent('output', { category: 'console', output: `Flash successful: ${(flashResult.data as any).message}\n` });
        } else {
          this.sendEvent('output', { category: 'stderr', output: `Flash failed: ${flashResult.error}\n` });
          this.sendResponse(msg, undefined, false, flashResult.error);
          return;
        }
        await new Promise<void>(r => setTimeout(r, 500));
      }

      const connectResult = await this.backend.execute({
        cmd: 'connect', config: { device, interface: interface_, speedKHz },
      });
      if (!connectResult.ok) {
        this.sendEvent('output', { category: 'stderr', output: `Connect failed: ${connectResult.error}\n` });
        this.sendResponse(msg, undefined, false, connectResult.error);
        return;
      }

      if (elfPath) {
        const loadResult = await this.backend.execute({ cmd: 'loadSymbols', elfPath });
        if (loadResult.ok) {
          daLog(`Symbol loading: ${JSON.stringify(loadResult.data)}`);
        } else {
          daLog(`Symbol loading failed: ${loadResult.error}`);
        }
      }

      if (elfPath && this._flashEnabled) {
        this.sendEvent('output', { category: 'console', output: 'Resetting target after flash...\n' });
        await this.backend.execute({ cmd: 'reset' });
        await new Promise<void>(r => setTimeout(r, 200));
      }
      await this.backend.execute({ cmd: 'halt' });
      // Wait for CPU to actually halt before sending stopped event
      await new Promise<void>(r => setTimeout(r, 200));
      this.markStoppedForUi();
      this.lastHaltReason = 'entry';
      if (this.rttLogEnabled) {
        this.startRttLogPolling();
      } else {
        this.stopRttLogPolling();
      }

      this.sendEvent('initialized', {});
      this.sendResponse(msg);
    } catch (err: any) {
      this.sendResponse(msg, undefined, false, err.message);
    }
  }

  private async handleDisconnect(msg: DebugProtocolMessage) {
    this.beginControl();
    this.stopRttLogPolling();
    this.stopPolling();
    try {
      this.targetRunning = false;
      for (const [key, bpIndex] of this.breakpoints) {
        await this.backend.execute({ cmd: 'clearBreakpoint', id: bpIndex });
      }
      this.breakpoints.clear();
      await this.backend.execute({ cmd: 'disconnect' });
      this.sendResponse(msg);
    } finally {
      this.endControl();
    }
  }

  private async handleSetBreakpoints(msg: DebugProtocolMessage) {
    this.beginControl();
    try {
      const args = msg.arguments || {};
      const source = args.source || {};
      const filePath = source.path || '';
      const lines: number[] = args.lines || (args.breakpoints || []).map((b: any) => b.line);

      for (const [key, bpIndex] of this.breakpoints) {
        if (key.startsWith(filePath + ':')) {
          daLog(`handleSetBreakpoints: clearing old bp ${key} index=${bpIndex}`);
          await this.backend.execute({ cmd: 'clearBreakpoint', id: bpIndex });
          this.breakpoints.delete(key);
        }
      }

      const results: Array<{ verified: boolean; line?: number; id?: number; message?: string }> = [];

      for (const line of lines) {
        const result = await this.backend.execute({
          cmd: 'setBreakpoint', file: filePath, line,
        });
        if (result.ok) {
          const data = result.data as any;
          const key = `${filePath}:${line}`;
          this.breakpoints.set(key, data.id);
          results.push({ verified: true, line, id: data.id });
        } else {
          results.push({ verified: false, line, message: result.error });
        }
      }

      this.sendResponse(msg, { breakpoints: results });
    } catch (err: any) {
      this.sendResponse(msg, { breakpoints: [] });
    } finally {
      this.endControl();
    }
  }

  private async handleConfigurationDone(msg: DebugProtocolMessage) {
    // Wait for CPU to be halted before sending stopped event
    await new Promise<void>(r => setTimeout(r, 100));
    this.lastHaltReason = 'entry';
    this.markStoppedForUi();
    this.sendEvent('stopped', { reason: 'entry', threadId: 1 });
    this.sendResponse(msg);
  }

  private async handleStackTrace(msg: DebugProtocolMessage) {
    try {
      if (!(await this.beginTargetReadWhenAvailable('high', 700))) {
        this.sendResponse(msg, { stackFrames: [] });
        return;
      }
      try {
        daLog('handleStackTrace called');
        const result = await this.backend.execute({ cmd: 'getCallStack' });
        if (!result.ok) {
          daLog(`handleStackTrace failed: ${result.error}`);
          this.sendResponse(msg, { stackFrames: [] });
          return;
        }
        const frames = result.data as StackFrame[];
        daLog(`handleStackTrace: ${frames.length} frames`);
        const stackFrames = frames.map((f) => ({
          id: f.id,
          name: f.function,
          source: f.file ? { path: f.file } : undefined,
          line: f.line > 0 ? f.line : 0,
          column: 0,
        }));
        this.sendResponse(msg, { stackFrames });
      } finally {
        this.endTargetRead();
      }
    } catch (err: any) {
      daLog(`handleStackTrace error: ${err.message}`);
      this.sendResponse(msg, { stackFrames: [] });
    }
  }

  private async handleVariables(msg: DebugProtocolMessage) {
    try {
      const args = msg.arguments || {};
      const ref = args.variablesReference;
      if (this.shouldDeferTargetRead()) {
        this.sendResponse(msg, { variables: [] });
        return;
      }

      if (ref === 1) {
        if (!this.beginTargetRead('high')) {
          this.sendResponse(msg, { variables: [] });
          return;
        }
        try {
          const result = await this.backend.execute({ cmd: 'getLocals' });
          if (result.ok) {
            const vars = (result.data as Variable[]).map((v) => ({
              name: v.name, value: v.value, type: v.type, variablesReference: 0,
            }));
            this.sendResponse(msg, { variables: vars });
          } else {
            this.sendResponse(msg, { variables: [] });
          }
        } finally {
          this.endTargetRead();
        }
      } else if (ref === 2) {
        if (!this.beginTargetRead('high')) {
          this.sendResponse(msg, { variables: [] });
          return;
        }
        try {
          const regResult = await this.backend.execute({ cmd: 'getRegisters' });
          if (regResult.ok) {
            const regs = (regResult.data as any[]).map((r: any) => ({
              name: r.name,
              value: r.hex,
              type: 'uint32',
              variablesReference: 0,
              memoryReference: this.formatMemoryReference(r.value),
            }));
            this.sendResponse(msg, { variables: regs });
          } else {
            this.sendResponse(msg, { variables: [] });
          }
        } finally {
          this.endTargetRead();
        }
      } else if (this.variableHandles.has(ref)) {
        const children = this.variableHandles.get(ref) || [];
        this.sendResponse(msg, { variables: children.map(value => this.toDapVariable(value)) });
      } else {
        this.sendResponse(msg, { variables: [] });
      }
    } catch (err: any) {
      this.sendResponse(msg, { variables: [] });
    }
  }

  private async handleReadMemory(msg: DebugProtocolMessage) {
    const args = msg.arguments || {};
    const address = this.parseMemoryReference(args.memoryReference, args.offset);
    const count = Math.max(0, Math.min(Number(args.count) || 0, 1024 * 1024));
    if (address === null || count <= 0) {
      this.sendResponse(msg, undefined, false, 'Invalid memoryReference or count');
      return;
    }

    if (!(await this.beginTargetReadWhenAvailable('low', 700))) {
      this.sendResponse(msg, { address: this.formatMemoryReference(address), unreadableBytes: count }, false, 'Target is running');
      return;
    }

    try {
      const result = await this.backend.execute({ cmd: 'readMemory', address, size: count });
      if (!result.ok) {
        this.sendResponse(msg, { address: this.formatMemoryReference(address), unreadableBytes: count }, false, result.error);
        return;
      }

      const block = result.data as MemoryBlock;
      const bytes = Uint8Array.from(block.data);
      this.sendResponse(msg, {
        address: this.formatMemoryReference(address),
        data: Buffer.from(bytes).toString('base64'),
        unreadableBytes: block.unreadableBytes ?? Math.max(0, count - bytes.length),
      });
    } finally {
      this.endTargetRead();
    }
  }

  private async handleWriteMemory(msg: DebugProtocolMessage) {
    const args = msg.arguments || {};
    const address = this.parseMemoryReference(args.memoryReference, args.offset);
    if (address === null || typeof args.data !== 'string') {
      this.sendResponse(msg, undefined, false, 'Invalid memoryReference or data');
      return;
    }

    let data: number[];
    try {
      data = Array.from(Buffer.from(args.data, 'base64'));
    } catch {
      this.sendResponse(msg, undefined, false, 'Invalid base64 memory payload');
      return;
    }

    const result = await this.backend.execute({ cmd: 'writeMemory', address, data });
    if (!result.ok) {
      this.sendResponse(msg, { offset: 0, bytesWritten: 0 }, false, result.error);
      return;
    }

    this.sendResponse(msg, { offset: 0, bytesWritten: data.length });
  }

  private async handleContinue(msg: DebugProtocolMessage) {
    await this.withStepLock(async () => {
      this.beginControl();
      this.stopPolling();
      try {
        daLog('handleContinue: reading PC');
        const pcResult = await this.backend.execute({ cmd: 'readRegister', name: 'PC' });
        let bpAddr: number | null = null;
        if (pcResult.ok) {
          const pcData = pcResult.data as any;
          bpAddr = pcData.value as number;
          daLog(`handleContinue: pc=0x${bpAddr.toString(16)}`);
        }

        if (bpAddr !== null) {
          const clearResult = await this.backend.execute({ cmd: 'clearBreakpointAtAddr', addr: bpAddr });
          daLog(`handleContinue: clear bp result ok=${clearResult.ok}`);
          if (clearResult.ok) {
            await this.backend.execute({ cmd: 'stepInto' });
            await this.backend.execute({ cmd: 'setBreakpointAtAddr', addr: bpAddr });
            daLog('handleContinue: re-set bp after step');
          }
        }

        const runResult = await this.backend.execute({ cmd: 'run' });
        daLog(`handleContinue: run result ok=${runResult.ok}`);
        this.targetRunning = runResult.ok;
        if (runResult.ok) {
          this.readCancelEpoch++;
        }
        this.sendResponse(msg, { allThreadsContinued: true });
        this.sendEvent('continued', { threadId: 1, allThreadsContinued: true });
        this.lastHaltReason = 'breakpoint';
        if (!runResult.ok) {
          daLog('handleContinue: run failed, sending stopped');
          this.markStoppedForUi();
          this.sendEvent('stopped', { reason: 'breakpoint', threadId: 1 });
          return;
        }
        this.startPolling();
      } finally {
        this.endControl();
      }
    });
  }

  private async handleStep(msg: DebugProtocolMessage, cmd: 'stepOver' | 'stepInto' | 'stepOut') {
    await this.withStepLock(async () => {
      this.beginControl();
      this.stopPolling();
      this.targetRunning = false;
      try {
        const pcBefore = await this.backend.execute({ cmd: 'readRegister', name: 'PC' });
        const pcBeforeVal = pcBefore.ok ? (pcBefore.data as any).value as number : null;
        daLog(`handleStep: ${cmd} pcBefore=0x${pcBeforeVal !== null ? pcBeforeVal.toString(16) : 'null'}`);

        let responseSent = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          daLog(`handleStep: ${cmd} attempt ${attempt + 1}/3 start`);
          const result = await this.backend.execute({ cmd });
          daLog(`handleStep: ${cmd} attempt ${attempt + 1} result=${result.ok} ${result.ok ? '' : result.error}`);
          if (!result.ok) {
            if (attempt < 2) {
              await new Promise<void>(r => setTimeout(r, 50));
              continue;
            }
            if (!responseSent) {
              this.sendResponse(msg, undefined, false, result.error);
              responseSent = true;
            }
            return;
          }

          if (!responseSent) {
            this.sendResponse(msg);
            responseSent = true;
            daLog(`handleStep: ${cmd} response sent, starting poll`);
          }
          this.lastHaltReason = 'step';

          await new Promise<void>(r => setTimeout(r, 100));

          let pcStuck = false;
          for (let i = 0; i < 200; i++) {
            await new Promise<void>(r => setTimeout(r, 10));
            const stateResult = await this.backend.execute({ cmd: 'getTargetState' });
            if (i === 0 || (i + 1) % 20 === 0 || i === 199) {
              daLog(`handleStep: poll ${i + 1}/200 state=${stateResult.ok ? JSON.stringify((stateResult as any).data) : 'err'} ok=${stateResult.ok}`);
            }
            if (stateResult.ok && stateResult.data === 'halted') {
              if (pcBeforeVal !== null) {
                const pcAfter = await this.backend.execute({ cmd: 'readRegister', name: 'PC' });
                const pcAfterVal = pcAfter.ok ? (pcAfter.data as any).value as number : null;
                daLog(`handleStep: halted after ${(i + 1) * 10}ms, pcBefore=0x${pcBeforeVal.toString(16)} pcAfter=0x${pcAfterVal !== null ? pcAfterVal.toString(16) : 'null'}`);
                if (pcAfterVal !== null && pcAfterVal === pcBeforeVal) {
                  daLog(`handleStep: PC same, re-reading to rule out stale DLL state`);
                  let reReadOk = false;
                  for (let r = 0; r < 5; r++) {
                    await new Promise<void>(r2 => setTimeout(r2, 50));
                    const reRead = await this.backend.execute({ cmd: 'readRegister', name: 'PC' });
                    const reReadVal = reRead.ok ? (reRead.data as any).value as number : null;
                    if (reReadVal !== null && reReadVal !== pcBeforeVal) {
                      daLog(`handleStep: re-read ${r + 1}/5 PC changed to 0x${reReadVal.toString(16)}, step OK`);
                      reReadOk = true;
                      break;
                    }
                  }
                  if (reReadOk) {
                    daLog(`handleStep: ${cmd} complete after re-read`);
                    this.markStoppedForUi();
                    this.sendEvent('stopped', { reason: 'step', threadId: 1 });
                    return;
                  }
                  daLog(`handleStep: PC unchanged after 5 re-reads (250ms), will retry`);
                  pcStuck = true;
                  break;
                }
              }
              daLog(`handleStep: ${cmd} complete`);
              this.markStoppedForUi();
              this.sendEvent('stopped', { reason: 'step', threadId: 1 });
              return;
            }
            if (i > 50 && (i % 25 === 0)) {
              const settleResult = await this.backend.execute({ cmd: 'halt' });
              daLog(`handleStep: soft settle at poll ${i + 1} halt=${settleResult.ok}`);
            }
          }
          if (pcStuck) {
            await new Promise<void>(r => setTimeout(r, 50));
            continue;
          }
          daLog(`handleStep: not halted after 2000ms, starting polling`);
          this.targetRunning = true;
          this.readCancelEpoch++;
          this.startPolling();
          return;
        }
        daLog(`handleStep: ${cmd} failed after 3 attempts`);
        if (!responseSent) {
          this.sendResponse(msg, undefined, false, 'Step failed after 3 attempts');
        }
      } finally {
        this.endControl();
      }
    });
  }

  private async handlePause(msg: DebugProtocolMessage) {
    await this.withStepLock(async () => {
      this.beginControl();
      this.stopPolling();
      try {
        await this.backend.execute({ cmd: 'halt' });
        this.markStoppedForUi();
        this.lastHaltReason = 'pause';
        this.sendEvent('stopped', { reason: 'pause', threadId: 1 });
        this.sendResponse(msg);
      } finally {
        this.endControl();
      }
    });
  }

  private async handleRestart(msg: DebugProtocolMessage) {
    await this.withStepLock(async () => {
      this.beginControl();
      this.stopRttLogPolling();
      this.stopPolling();
      this.targetRunning = false;

      try {
        const savedBps: Array<{ file: string; line: number }> = [];
        for (const [key] of this.breakpoints) {
          const colonIdx = key.lastIndexOf(':');
          if (colonIdx > 0) {
            savedBps.push({ file: key.substring(0, colonIdx), line: parseInt(key.substring(colonIdx + 1)) });
          }
        }

        if (this._elfPath && this._flashEnabled) {
          this.sendEvent('output', { category: 'console', output: `Restart: flashing ${this._elfPath}...\n` });
          const flashResult = await this.backend.execute({
            cmd: 'flash', elfPath: this._elfPath, device: this._device,
            interface: this._interface as 'SWD' | 'JTAG', speedKHz: this._speedKHz,
          });
          if (flashResult.ok) {
            this.sendEvent('output', { category: 'console', output: `Restart: flash successful\n` });
          } else {
            this.sendEvent('output', { category: 'stderr', output: `Restart: flash failed: ${flashResult.error}\n` });
            this.sendResponse(msg, undefined, false, flashResult.error);
            return;
          }
          await new Promise<void>(r => setTimeout(r, 500));
        }
        await this.backend.execute({ cmd: 'reset' });
        await this.backend.execute({ cmd: 'halt' });
        await new Promise<void>(r => setTimeout(r, 200));
        await this.backend.execute({ cmd: 'clearAllBreakpoints' });
        this.breakpoints.clear();

        for (const bp of savedBps) {
          const result = await this.backend.execute({ cmd: 'setBreakpoint', file: bp.file, line: bp.line });
          if (result.ok) {
            const data = result.data as any;
            this.breakpoints.set(`${bp.file}:${bp.line}`, data.id);
          }
        }

        this.markStoppedForUi();
        this.lastHaltReason = 'entry';
        if (this.rttLogEnabled) {
          this.startRttLogPolling();
        }
        this.sendEvent('stopped', { reason: 'entry', threadId: 1 });
        this.sendResponse(msg);
      } finally {
        this.endControl();
      }
    });
  }

  private async handleEvaluate(msg: DebugProtocolMessage) {
    const args = msg.arguments || {};
    const expr = args.expression;
    const context = args.context;
    const frameId = args.frameId;
    daLog(`handleEvaluate: expr="${expr}" context=${context} frameId=${frameId}`);
    const isRTOS = this.isRtosEvaluateExpression(expr);
    if (isRTOS) daLog(`handleEvaluate RTOS: "${expr}" context=${context}`);
    if (!expr) {
      this.sendResponse(msg, { result: '', variablesReference: 0 });
      return;
    }

    const force = context === 'watch' || context === 'hover';
    const waitForConsistentEvaluate = context === 'hover' || isRTOS;
    if (context === 'watch' && !this.watchExpressions.includes(expr)) {
      this.watchExpressions.push(expr);
      daLog(`handleEvaluate: auto-captured watch expression "${expr}"`);
    }

    if (this.shouldDeferTargetRead()) {
      daLog(`handleEvaluate: deferring read while target/control busy for "${expr}"`);
      this.sendEvaluateValue(msg, this.cachedOrRunningWatchValue(expr), false);
      return;
    }

    // Running-target evaluate requests can arrive in bursts from RTOS Views and hovers.
    // Reuse very recent values so those bursts do not monopolize J-Link.
    if (force && this.targetReadInProgress && !waitForConsistentEvaluate) {
      const wv = this.runtimeWatchReadInFlight
        ? this.cachedOrRunningWatchValue(expr)
        : this.getFreshRuntimeWatchValue(expr);
      if (wv) {
        this.sendEvaluateValue(msg, wv, false);
        return;
      }
    }

    if (!(await this.beginTargetReadWhenAvailable('low', waitForConsistentEvaluate ? 700 : 0))) {
      this.sendEvaluateValue(msg, this.cachedOrRunningWatchValue(expr), false);
      return;
    }
    try {
      const targetHalted = force ? await this.isTargetHalted() : true;
      if (!targetHalted) {
        this.sendEvaluateValue(msg, this.cachedOrRunningWatchValue(expr), false);
        return;
      }

      const result = await this.backend.execute({ cmd: 'evaluateExpression', expression: expr, force });
      if (result.ok) {
        const wv = result.data as WatchValue;
        this.cacheRuntimeWatchValue(expr, wv);
        if (isRTOS) daLog(`evaluate RTOS success: "${expr}" = ${wv.display}`);
        daLog(`handleEvaluate: result="${wv.display}"`);
        this.sendEvaluateValue(msg, wv, true);
      } else {
        if (isRTOS) daLog(`evaluate RTOS failed: "${expr}" -> ${result.error}`);
        this.sendResponse(msg, { result: result.error, variablesReference: 0 }, false, result.error);
      }
    } finally {
      this.endTargetRead();
    }
  }

  private async handleWatchEvaluate(msg: DebugProtocolMessage) {
    const args = msg.arguments || {};
    const expressions: string[] = args.expressions || [];
    daLog(`handleWatchEvaluate: ${expressions.length} expressions`);
    if (this.shouldDeferTargetRead()) {
      this.sendResponse(msg, { results: expressions.map(expr => this.cachedOrRunningWatchValue(expr)) });
      return;
    }
    const results = await this.readWatchExpressions(expressions, true);
    this.sendResponse(msg, { results });
  }

  private async handleDataSample(msg: DebugProtocolMessage) {
    const args = msg.arguments || {};
    const expressions: string[] = args.expressions || [];
    daLog(`handleDataSample: ${expressions.length} expressions`);
    const results = await this.readWatchExpressions(expressions, true);
    this.sendResponse(msg, { results });
  }

  private async handleDataSamplingStart(msg: DebugProtocolMessage) {
    const args = msg.arguments || {};
    const entries: DapSamplingEntry[] = Array.isArray(args.entries)
      ? args.entries
        .map((entry: any) => ({ expression: String(entry.expression || '').trim(), color: String(entry.color || '#4EC9B0') }))
        .filter((entry: DapSamplingEntry) => entry.expression)
      : (Array.isArray(args.expressions) ? args.expressions.map((expression: string) => ({ expression, color: '#4EC9B0' })) : []);

    this.stopDataSampling();
    if (entries.length === 0) {
      this.sendResponse(msg, { ok: true, planned: [] });
      return;
    }

    const planResult = await this.backend.execute({
      cmd: 'prepareFastDataSampling',
      expressions: entries.map(entry => entry.expression),
    });
    if (!planResult.ok) {
      this.sendResponse(msg, undefined, false, planResult.error);
      return;
    }

    const plan = planResult.data as FastDataSamplePlanItem[];
    const specs = plan.map(item => item.spec).filter((spec): spec is FastDataSampleSpec => !!spec);
    if (specs.length === 0) {
      this.sendResponse(msg, { ok: false, planned: plan }, false, 'No expressions can use fast data sampling');
      return;
    }

    const supported = new Set(specs.map(spec => spec.expression));
    this.dataSamplingEntries = entries.filter(entry => supported.has(entry.expression));
    this.dataSamplingSpecs = specs;
    this.dataSamplingPending.clear();
    this.dataSamplingLastDisplay.clear();
    for (const entry of this.dataSamplingEntries) {
      this.dataSamplingPending.set(entry.expression, []);
    }
    this.dataSamplingIntervalMs = this.clampNumber(args.sampleIntervalMs, 0.2, 0.1, 10000);
    this.dataSamplingSendIntervalMs = this.clampNumber(args.sendIntervalMs, 16, 1, 10000);
    const now = this.nowMs();
    this.dataSamplingNextSampleMs = now;
    this.dataSamplingNextSendMs = now + this.dataSamplingSendIntervalMs;
    this.dataSamplingActive = true;
    this.scheduleDataSamplingLoop();
    this.sendResponse(msg, {
      ok: true,
      planned: plan,
      activeExpressions: this.dataSamplingEntries.map(entry => entry.expression),
      intervalMs: this.dataSamplingIntervalMs,
    });
  }

  private handleDataSamplingStop(msg: DebugProtocolMessage) {
    this.stopDataSampling();
    this.sendResponse(msg, { ok: true });
  }

  private scheduleDataSamplingLoop() {
    if (!this.dataSamplingActive || this.dataSamplingTimer) return;
    this.dataSamplingTimer = setImmediate(() => {
      this.dataSamplingTimer = null;
      void this.dataSamplingLoop();
    });
  }

  private async dataSamplingLoop() {
    if (!this.dataSamplingActive) return;
    const budgetEndMs = this.nowMs() + 4;
    let samplesThisTurn = 0;

    while (this.dataSamplingActive && this.nowMs() >= this.dataSamplingNextSampleMs && this.nowMs() < budgetEndMs && samplesThisTurn < 512) {
      await this.captureFastDataSample();
      this.dataSamplingNextSampleMs += this.dataSamplingIntervalMs;
      const now = this.nowMs();
      if (this.dataSamplingNextSampleMs < now - this.dataSamplingIntervalMs * 256) {
        this.dataSamplingNextSampleMs = now;
      }
      samplesThisTurn++;
    }

    if (this.dataSamplingActive && this.nowMs() >= this.dataSamplingNextSendMs) {
      this.flushDataSampling();
      this.dataSamplingNextSendMs = this.nowMs() + this.dataSamplingSendIntervalMs;
    }

    this.scheduleDataSamplingLoop();
  }

  private async captureFastDataSample() {
    if (!this.beginTargetRead()) return;
    try {
      const result = await this.backend.execute({ cmd: 'readFastDataSampling', specs: this.dataSamplingSpecs });
      if (!result.ok) return;
      const values = result.data as WatchValue[];
      const timestamp = this.nowMs();
      for (const value of values) {
        if (!value || value.error) continue;
        const pending = this.dataSamplingPending.get(value.expression);
        if (!pending) continue;
        pending.push({ timestamp, value: value.value, display: value.display });
        this.dataSamplingLastDisplay.set(value.expression, value.display);
      }
    } finally {
      this.endTargetRead();
    }
  }

  private flushDataSampling() {
    const snapshots = [];
    for (const entry of this.dataSamplingEntries) {
      const pending = this.dataSamplingPending.get(entry.expression);
      if (!pending || pending.length === 0) continue;
      snapshots.push({
        expression: entry.expression,
        color: entry.color,
        currentValue: this.dataSamplingLastDisplay.get(entry.expression) || '',
        data: pending.splice(0),
      });
    }
    if (snapshots.length > 0) {
      this.sendEvent('ozoneDataSamples', {
        snapshots,
        intervalMs: this.dataSamplingIntervalMs,
      });
    }
  }

  private stopDataSampling() {
    this.dataSamplingActive = false;
    if (this.dataSamplingTimer) {
      clearImmediate(this.dataSamplingTimer);
      this.dataSamplingTimer = null;
    }
    this.flushDataSampling();
    this.dataSamplingEntries = [];
    this.dataSamplingSpecs = [];
    this.dataSamplingPending.clear();
    this.dataSamplingLastDisplay.clear();
  }

  private nowMs(): number {
    return this.highResEpochMs + Number(process.hrtime.bigint() - this.highResStartNs) / 1_000_000;
  }

  private clampNumber(value: unknown, fallback: number, min: number, max: number): number {
    const numeric = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.max(min, Math.min(max, numeric));
  }

  private parseOptionalAddress(value: unknown): number | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    const numeric = typeof value === 'number' ? value : Number(String(value).trim());
    if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
    return numeric >>> 0;
  }

  private async handleSetWatchValue(msg: DebugProtocolMessage) {
    const args = msg.arguments || {};
    const expression: string = args.expression || '';
    const value: number = args.value ?? 0;
    daLog(`handleSetWatchValue: "${expression}" = ${value}`);
    const result = await this.backend.execute({ cmd: 'setWatchValue', expression, value });
    this.sendResponse(msg, result);
  }

  private async handleGetTargetState(msg: DebugProtocolMessage) {
    const r = await this.backend.execute({ cmd: 'getTargetState' });
    this.sendResponse(msg, r.ok ? { state: r.data } : { state: 'error' });
  }

  dispose() {
    this.stopDataSampling();
    this.stopRttLogPolling();
    this.stopPolling();
    this.backend.dispose();
  }
}
