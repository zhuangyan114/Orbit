import { EventEmitter } from 'events';
import { OzoneBackend } from '../ozone-backend/commander';
import { Variable, StackFrame, WatchValue } from '../ozone-backend/types';
import * as fs from 'fs';
import * as path from 'path';

function daLog(msg: string) {
  try {
    fs.appendFileSync(path.join(__dirname, '..', 'debugadapter.log'), `[${new Date().toISOString()}] ${msg}\n`);
  } catch { }
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

export class DapSession extends EventEmitter {
  private backend: OzoneBackend;
  private seq = 1;
  private pollTimer: NodeJS.Timeout | null = null;
  private watchExpressions: string[] = [];
  private _watchPollCycle = 0;
  private lastHaltReason: 'entry' | 'breakpoint' | 'step' | 'pause' = 'entry';

  private breakpoints = new Map<string, number>();
  private stepLock: Promise<void> = Promise.resolve();

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
    daLog('startPolling: started');
    const pollLoop = async () => {
      if (this.pollTimer === null) return;
      try {
        const stateResult = await this.backend.execute({ cmd: 'getTargetState' });
        if (stateResult.ok && stateResult.data === 'halted') {
          this.stopPolling();
          if (this.watchExpressions.length > 0) {
            const results: any[] = [];
            for (const expr of this.watchExpressions) {
              const r = await this.backend.execute({ cmd: 'evaluateExpression', expression: expr });
              if (r.ok) results.push(r.data);
              else results.push({ expression: expr, value: 0, display: '', hex: '', error: r.error });
            }
            this.sendWatchUpdate(results);
          }
          this.sendEvent('stopped', { reason: this.lastHaltReason, threadId: 1 });
          return;
        }

        if (this.watchExpressions.length > 0) {
          this._watchPollCycle++;
          await this.backend.execute({ cmd: 'halt' });
          await new Promise<void>(q => setTimeout(q, 10));

          const results: any[] = [];
          for (const expr of this.watchExpressions) {
            const r = await this.backend.execute({ cmd: 'evaluateExpression', expression: expr });
            if (r.ok) results.push(r.data);
            else results.push({ expression: expr, value: 0, display: '', hex: '', error: r.error });
          }

          await this.backend.execute({ cmd: 'run' });
          this.sendWatchUpdate(results);
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
    this.sendEvent('output', {
      category: 'ozoneWatch',
      output: JSON.stringify({ results }),
    });
  }

  private stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
      daLog('stopPolling: stopped');
    }
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
          daLog(`setWatches: ${this.watchExpressions.length} expressions`);
          return this.sendResponse(msg);
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

      if (elfPath && args.flashBeforeDebug !== false) {
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

      if (elfPath && args.flashBeforeDebug !== false) {
        this.sendEvent('output', { category: 'console', output: 'Resetting target after flash...\n' });
        await this.backend.execute({ cmd: 'reset' });
        await new Promise<void>(r => setTimeout(r, 200));
      }
      await this.backend.execute({ cmd: 'halt' });

      this.sendEvent('initialized', {});
      this.sendResponse(msg);
    } catch (err: any) {
      this.sendResponse(msg, undefined, false, err.message);
    }
  }

  private async handleDisconnect(msg: DebugProtocolMessage) {
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
      const stateResult = await this.backend.execute({ cmd: 'getTargetState' });
      if (stateResult.ok && stateResult.data === 'halted') {
        daLog('handleContinue: already halted after run, sending stopped');
        this.sendEvent('stopped', { reason: 'breakpoint', threadId: 1 });
        return;
      }
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
        let pcStuck = false;
        for (let i = 0; i < 50; i++) {
          await new Promise<void>(r => setTimeout(r, 10));
          const stateResult = await this.backend.execute({ cmd: 'getTargetState' });
          if (i === 0 || (i + 1) % 10 === 0 || i === 49) {
            daLog(`handleStep: poll ${i + 1}/50 state=${stateResult.ok ? JSON.stringify((stateResult as any).data) : 'err'} ok=${stateResult.ok}`);
          }
          if (stateResult.ok && stateResult.data === 'halted') {
            if (pcBeforeVal !== null) {
              const pcAfter = await this.backend.execute({ cmd: 'readRegister', name: 'PC' });
              const pcAfterVal = pcAfter.ok ? (pcAfter.data as any).value as number : null;
              daLog(`handleStep: halted after ${(i + 1) * 10}ms, pcBefore=0x${pcBeforeVal.toString(16)} pcAfter=0x${pcAfterVal !== null ? pcAfterVal.toString(16) : 'null'}`);
              if (pcAfterVal !== null && pcAfterVal === pcBeforeVal) {
                daLog(`handleStep: PC unchanged after attempt ${attempt + 1}, will retry`);
                pcStuck = true;
                break;
              }
            }
            daLog(`handleStep: ${cmd} complete`);
            this.sendEvent('stopped', { reason: 'step', threadId: 1 });
            return;
          }
        }
        if (pcStuck) {
          await new Promise<void>(r => setTimeout(r, 50));
          continue;
        }
        daLog(`handleStep: not halted after 500ms, starting polling`);
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
      this.stopPolling();
      await this.backend.execute({ cmd: 'reset' });
      await this.backend.execute({ cmd: 'halt' });
      this.lastHaltReason = 'entry';
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

  dispose() {
    this.stopPolling();
    this.backend.dispose();
  }
}