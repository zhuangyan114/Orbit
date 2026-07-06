import { EventEmitter } from 'events';
import { StringDecoder } from 'string_decoder';
import { OzoneBackend } from '../ozone-backend/commander';
import { DataPoint, FastDataSamplePlanItem, FastDataSampleSpec, Variable, StackFrame, WatchValue } from '../ozone-backend/types';

function daLog(_msg: string) {
  // no-op
}

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
  private rttDecoder = new StringDecoder('utf8');
  private watchExpressions: string[] = [];
  private _watchPollCycle = 0;
  private lastHaltReason: 'entry' | 'breakpoint' | 'step' | 'pause' = 'entry';

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
          if (this.watchExpressions.length > 0) {
            const results: any[] = [];
            for (const expr of this.watchExpressions) {
              const r = await this.backend.execute({ cmd: 'evaluateExpression', expression: expr });
              daLog(`pollLoop halted read: ${expr} ok=${r.ok} val=${r.ok ? (r.data as any).value : r.error}`);
              if (r.ok) results.push(r.data);
              else results.push({ expression: expr, value: 0, display: '', hex: '', error: r.error });
            }
            this.sendWatchUpdate(results);
          }
          this.sendEvent('stopped', { reason: this.lastHaltReason, threadId: 1 });
          this.stopPolling();
          return;
        }

        if (this.watchExpressions.length > 0) {
          if (this.pollTimer === null) return;
          this._watchPollCycle++;
          daLog(`pollLoop: reading watches without halt (cycle ${this._watchPollCycle})`);
          const results: any[] = [];
          for (const expr of this.watchExpressions) {
            if (this.pollTimer === null) return;
            const r = await this.backend.execute({ cmd: 'evaluateExpression', expression: expr, force: true });
            daLog(`pollLoop read: ${expr} ok=${r.ok} val=${r.ok ? (r.data as any).value : r.error}`);
            if (r.ok) results.push(r.data);
            else results.push({ expression: expr, value: 0, display: '', hex: '', error: r.error });
          }
          daLog(`pollLoop: sending ${results.length} results`);
          this.sendWatchUpdate(results);
        } else {
          daLog('pollLoop: no watch expressions, skipping');
        }
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
              let output = this.rttDecoder.write(Buffer.from(bytes));
              if (this.rttStripAnsi) output = this.stripAnsi(output);
              if (output.length > 0) {
                this.sendEvent('output', { category: 'stdout', output });
              }
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
      const output = this.rttStripAnsi ? this.stripAnsi(trailing) : trailing;
      if (output) this.sendEvent('output', { category: 'stdout', output });
    }
    this.rttDecoder = new StringDecoder('utf8');
    this.rttStarted = false;
    void this.backend.execute({ cmd: 'stopRtt' });
  }

  private stripAnsi(text: string): string {
    return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
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
            supportsReadMemoryRequest: false,
            supportsDisassembleRequest: false,
            supportsCancelRequest: false,
            supportsBreakpointLocationsRequest: false,
            supportsSteppingGranularity: false,
            supportsInstructionBreakpoints: false,
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
          return this.sendResponse(msg, { threads: [{ id: 1, name: 'Cortex-M4' }] });
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
      const device = args.device || 'STM32F407VG';
      const interface_ = args.interface || 'SWD';
      const speedKHz = args.speedKHz || 4000;
      const elfPath = args.program || args.elfPath || '';
      const flashEnabled = args.flashBeforeDebug !== false;
      this.rttLogEnabled = args.rttLogEnabled !== false;
      this.rttBufferIndex = Math.floor(this.clampNumber(args.rttBufferIndex, 0, 0, 15));
      this.rttPollIntervalMs = Math.floor(this.clampNumber(args.rttPollIntervalMs, 50, 10, 5000));
      this.rttReadSize = Math.floor(this.clampNumber(args.rttReadSize, 4096, 64, 65536));
      this.rttControlBlockAddress = this.parseOptionalAddress(args.rttControlBlockAddress);
      this.rttStripAnsi = args.rttStripAnsi !== false;
      this._elfPath = elfPath;
      this._device = device;
      this._interface = interface_;
      this._speedKHz = speedKHz;
      this._flashEnabled = flashEnabled;

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
        await this.backend.execute({ cmd: 'loadSymbols', elfPath });
      }

      if (elfPath && this._flashEnabled) {
        this.sendEvent('output', { category: 'console', output: 'Resetting target after flash...\n' });
        await this.backend.execute({ cmd: 'reset' });
        await new Promise<void>(r => setTimeout(r, 200));
      }
      await this.backend.execute({ cmd: 'halt' });
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
    this.stopRttLogPolling();
    this.stopPolling();
    for (const [key, bpIndex] of this.breakpoints) {
      await this.backend.execute({ cmd: 'clearBreakpoint', id: bpIndex });
    }
    this.breakpoints.clear();
    await this.backend.execute({ cmd: 'disconnect' });
    this.sendResponse(msg);
  }

  private async handleSetBreakpoints(msg: DebugProtocolMessage) {
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
    }
  }

  private async handleConfigurationDone(msg: DebugProtocolMessage) {
    this.lastHaltReason = 'entry';
    this.sendEvent('stopped', { reason: 'entry', threadId: 1 });
    this.sendResponse(msg);
  }

  private async handleStackTrace(msg: DebugProtocolMessage) {
    try {
      const result = await this.backend.execute({ cmd: 'getCallStack' });
      if (!result.ok) {
        this.sendResponse(msg, { stackFrames: [] });
        return;
      }
      const frames = result.data as StackFrame[];
      const stackFrames = frames.map((f) => ({
        id: f.id,
        name: f.function,
        source: f.file ? { path: f.file } : undefined,
        line: f.line > 0 ? f.line : 0,
        column: 0,
      }));
      this.sendResponse(msg, { stackFrames });
    } catch (err: any) {
      this.sendResponse(msg, { stackFrames: [] });
    }
  }

  private async handleVariables(msg: DebugProtocolMessage) {
    try {
      const args = msg.arguments || {};
      const ref = args.variablesReference;

      if (ref === 1) {
        const result = await this.backend.execute({ cmd: 'getLocals' });
        if (result.ok) {
          const vars = (result.data as Variable[]).map((v) => ({
            name: v.name, value: v.value, type: v.type, variablesReference: 0,
          }));
          this.sendResponse(msg, { variables: vars });
        } else {
          this.sendResponse(msg, { variables: [] });
        }
      } else if (ref === 2) {
        const regResult = await this.backend.execute({ cmd: 'getRegisters' });
        if (regResult.ok) {
          const regs = (regResult.data as any[]).map((r: any) => ({
            name: r.name, value: r.hex, type: 'uint32', variablesReference: 0,
          }));
          this.sendResponse(msg, { variables: regs });
        } else {
          this.sendResponse(msg, { variables: [] });
        }
      } else {
        this.sendResponse(msg, { variables: [] });
      }
    } catch (err: any) {
      this.sendResponse(msg, { variables: [] });
    }
  }

  private async handleContinue(msg: DebugProtocolMessage) {
    await this.withStepLock(async () => {
      this.stopPolling();
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
        await this.backend.execute({ cmd: 'stepInto' });
        if (clearResult.ok) {
          await this.backend.execute({ cmd: 'setBreakpointAtAddr', addr: bpAddr });
          daLog('handleContinue: re-set bp after step');
        }
      }

      const runResult = await this.backend.execute({ cmd: 'run' });
      daLog(`handleContinue: run result ok=${runResult.ok}`);
      this.sendResponse(msg, { allThreadsContinued: true });
      this.lastHaltReason = 'breakpoint';
      if (!runResult.ok) {
        daLog('handleContinue: run failed, sending stopped');
        this.sendEvent('stopped', { reason: 'breakpoint', threadId: 1 });
        return;
      }
      await new Promise<void>(r => setTimeout(r, 300));
      this.startPolling();
    });
  }

  private async handleStep(msg: DebugProtocolMessage, cmd: 'stepOver' | 'stepInto' | 'stepOut') {
    await this.withStepLock(async () => {
      this.stopPolling();
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
                  this.sendEvent('stopped', { reason: 'step', threadId: 1 });
                  return;
                }
                daLog(`handleStep: PC unchanged after 5 re-reads (250ms), will retry`);
                pcStuck = true;
                break;
              }
            }
            daLog(`handleStep: ${cmd} complete`);
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
        this.startPolling();
        return;
      }
      daLog(`handleStep: ${cmd} failed after 3 attempts`);
      if (!responseSent) {
        this.sendResponse(msg, undefined, false, 'Step failed after 3 attempts');
      }
    });
  }

  private async handlePause(msg: DebugProtocolMessage) {
    await this.withStepLock(async () => {
      this.stopPolling();
      await this.backend.execute({ cmd: 'halt' });
      this.lastHaltReason = 'pause';
      this.sendEvent('stopped', { reason: 'pause', threadId: 1 });
      this.sendResponse(msg);
    });
  }

  private async handleRestart(msg: DebugProtocolMessage) {
    await this.withStepLock(async () => {
      this.stopRttLogPolling();
      this.stopPolling();

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
      await this.backend.execute({ cmd: 'clearAllBreakpoints' });
      this.breakpoints.clear();

      for (const bp of savedBps) {
        const result = await this.backend.execute({ cmd: 'setBreakpoint', file: bp.file, line: bp.line });
        if (result.ok) {
          const data = result.data as any;
          this.breakpoints.set(`${bp.file}:${bp.line}`, data.id);
        }
      }

      this.lastHaltReason = 'entry';
      if (this.rttLogEnabled) {
        this.startRttLogPolling();
      }
      this.sendEvent('stopped', { reason: 'entry', threadId: 1 });
      this.sendResponse(msg);
    });
  }

  private async handleEvaluate(msg: DebugProtocolMessage) {
    const args = msg.arguments || {};
    const expr = args.expression;
    const context = args.context;
    daLog(`handleEvaluate: expr="${expr}" context=${context}`);
    if (!expr) {
      this.sendResponse(msg, { result: '', variablesReference: 0 });
      return;
    }

    if (context === 'watch' && !this.watchExpressions.includes(expr)) {
      this.watchExpressions.push(expr);
      daLog(`handleEvaluate: auto-captured watch expression "${expr}"`);
      const session = this.listeners('send').length > 0 ? this : null;
    }

    const result = await this.backend.execute({ cmd: 'evaluateExpression', expression: expr });
    if (result.ok) {
      const wv = result.data as WatchValue;
      daLog(`handleEvaluate: result="${wv.display}"`);
      this.sendResponse(msg, { result: wv.display, variablesReference: 0 });
    } else {
      daLog(`handleEvaluate: error="${result.error}"`);
      this.sendResponse(msg, { result: result.error, variablesReference: 0 });
    }
  }

  private async handleWatchEvaluate(msg: DebugProtocolMessage) {
    const args = msg.arguments || {};
    const expressions: string[] = args.expressions || [];
    daLog(`handleWatchEvaluate: ${expressions.length} expressions`);
    const wasHalted = await this.backend.execute({ cmd: 'getTargetState' });
    const needResume = wasHalted.ok && wasHalted.data !== 'halted';
    if (needResume) {
      await this.backend.execute({ cmd: 'halt' });
      await new Promise<void>(r => setTimeout(r, 100));
    }
    const results: any[] = [];
    for (const expr of expressions) {
      const result = await this.backend.execute({ cmd: 'evaluateExpression', expression: expr });
      if (result.ok) {
        results.push(result.data);
      } else {
        results.push({ expression: expr, value: 0, display: '', hex: '', error: result.error });
      }
    }
    if (needResume) {
      await this.backend.execute({ cmd: 'run' });
    }
    this.sendResponse(msg, { results });
  }

  private async handleDataSample(msg: DebugProtocolMessage) {
    const args = msg.arguments || {};
    const expressions: string[] = args.expressions || [];
    daLog(`handleDataSample: ${expressions.length} expressions`);
    const results: any[] = [];
    for (const expr of expressions) {
      const result = await this.backend.execute({ cmd: 'evaluateExpression', expression: expr, force: true });
      if (result.ok) {
        results.push(result.data);
      } else {
        results.push({ expression: expr, value: 0, display: '', hex: '', error: result.error });
      }
    }
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
