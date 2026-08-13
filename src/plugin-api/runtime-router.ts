import * as vscode from 'vscode';
import { OzoneBackend } from '../ozone-backend/commander';
import { WatchValue } from '../ozone-backend/types';
import {
  AUTOMATION_CONTROL_COMMAND,
  AutomationControlRequest,
  AutomationControlResult,
  isStepAction,
} from '../debug/dap-automation-protocol';
import { AutomationError, SessionRef } from './protocol';
import {
  RuntimeReadValue,
  RuntimeWriteResult,
  SignalSpec,
  WriteSpec,
  normalizeWatchValue,
} from './types';

/**
 * Exact-session routing hooks (plan Task 3). The router never reads
 * `vscode.debug.activeDebugSession` itself: callers hand it an explicit
 * `SessionRef` (v1 path) or the injected `currentRef` (legacy /rpc path).
 */
export interface RuntimeRouterOptions {
  /** Resolves an exact SessionRef; must throw a frozen AutomationError on any mismatch. */
  resolveSession(ref: SessionRef): vscode.DebugSession;
  /** Current usable Orbit session identity for legacy callers without a ref. */
  currentRef?(): SessionRef | undefined;
}

export class RuntimeRouter {
  constructor(private backend: OzoneBackend, private options?: RuntimeRouterOptions) {}

  async getTargetState(ref?: SessionRef): Promise<string> {
    const session = this.resolveTargetSession(ref);
    if (session) {
      try {
        const response: any = await session.customRequest('getTargetState', {});
        if (typeof response?.state === 'string') return response.state;
        return 'error';
      } catch {
        return 'error';
      }
    }

    const result = await this.backend.execute({ cmd: 'getTargetState' });
    if (!result.ok) return 'error';
    return String(result.data);
  }

  async readSignals(signals: SignalSpec[], ref?: SessionRef): Promise<RuntimeReadValue[]> {
    const normalized = signals.map(signal => this.normalizeSignal(signal));
    if (normalized.length === 0) return [];

    const expressions = normalized.map(signal => signal.expression);
    const session = this.resolveTargetSession(ref);
    if (session) {
      try {
        const response: any = await session.customRequest('dataSample', { expressions });
        if (Array.isArray(response?.results)) {
          return normalized.map((signal, index) => {
            const value = response.results[index] as WatchValue | undefined;
            return normalizeWatchValue(signal.alias, signal.expression, value);
          });
        }
        return normalized.map(signal => ({
          alias: signal.alias,
          expression: signal.expression,
          value: 0,
          display: '',
          error: 'DAP dataSample returned no results',
        }));
      } catch (err: any) {
        const error = err?.message || 'DAP dataSample failed';
        return normalized.map(signal => ({
          alias: signal.alias,
          expression: signal.expression,
          value: 0,
          display: '',
          error,
        }));
      }
    }

    const values: RuntimeReadValue[] = [];
    for (const signal of normalized) {
      try {
        const result = await this.backend.execute({
          cmd: 'evaluateExpression',
          expression: signal.expression,
          force: true,
        });
        if (result.ok) {
          values.push(normalizeWatchValue(signal.alias, signal.expression, result.data as WatchValue));
        } else {
          values.push({
            alias: signal.alias,
            expression: signal.expression,
            value: 0,
            display: '',
            error: result.error,
          });
        }
      } catch (err: any) {
        values.push({
          alias: signal.alias,
          expression: signal.expression,
          value: 0,
          display: '',
          error: err?.message || String(err),
        });
      }
    }
    return values;
  }

  async writeMany(writes: WriteSpec[], ref?: SessionRef): Promise<RuntimeWriteResult[]> {
    const normalized = writes.map(write => this.normalizeWrite(write));
    if (normalized.length === 0) return [];

    // Resolve once: the whole batch shares the same generation fence.
    const session = this.resolveTargetSession(ref);
    if (session) {
      const results: RuntimeWriteResult[] = [];
      for (const write of normalized) {
        try {
          const response: any = await session.customRequest('setWatchValue', {
            expression: write.expression,
            value: write.value,
            address: write.address,
            typeName: write.typeName,
          });
          if (response?.ok === true) {
            results.push({ ...write, ok: true });
          } else {
            results.push({ ...write, ok: false, error: response?.error || 'Write failed' });
          }
        } catch (err: any) {
          results.push({ ...write, ok: false, error: err?.message || String(err) });
        }
      }
      return results;
    }

    const results: RuntimeWriteResult[] = [];
    for (const write of normalized) {
      try {
        const result = await this.backend.execute({
          cmd: 'setWatchValue',
          expression: write.expression,
          value: write.value,
          address: write.address,
          typeName: write.typeName,
        });
        results.push(result.ok ? { ...write, ok: true } : { ...write, ok: false, error: result.error });
      } catch (err: any) {
        results.push({ ...write, ok: false, error: err?.message || String(err) });
      }
    }
    return results;
  }

  /**
   * Automation control (plan Task 5). Control is exclusively routed through
   * the exact active DAP session — there is no extension-host backend
   * fallback; a missing or stale session is a frozen error, never a local
   * backend control attempt.
   */
  async control(ref: SessionRef | undefined, request: AutomationControlRequest): Promise<AutomationControlResult> {
    return this.controlSession(this.resolveSession(ref), request);
  }

  /**
   * Resolves an explicit `SessionRef` to its exact active session, throwing
   * the frozen fencing errors. Callers that also need the `vscode.DebugSession`
   * object (e.g. to mirror state into the registry) resolve once and pass it
   * to `controlSession` instead of re-resolving.
   */
  resolveSession(ref: SessionRef | undefined): vscode.DebugSession {
    const session = this.resolveTargetSession(ref);
    if (!session) {
      throw new AutomationError('NoActiveSession', 'no active Orbit session to control', false);
    }
    return session;
  }

  /** Drives one automation control request through an already-resolved session. */
  async controlSession(
    session: vscode.DebugSession,
    request: AutomationControlRequest,
  ): Promise<AutomationControlResult> {
    let response: unknown;
    try {
      response = await session.customRequest(AUTOMATION_CONTROL_COMMAND, request);
    } catch (error) {
      throw this.mapControlFailure(error, request.action);
    }
    if (response && typeof response === 'object') {
      const outcome = response as Partial<AutomationControlResult>;
      if (typeof outcome.state === 'string' && !outcome.errorCode) {
        return response as AutomationControlResult;
      }
      if (typeof outcome.errorCode === 'string') {
        throw this.mapControlFailure(response, request.action);
      }
    }
    throw new AutomationError('InternalError', 'DAP automation control returned an invalid outcome', false);
  }

  /**
   * Maps a DAP automation failure (a rejected customRequest or a structured
   * failure outcome) onto the frozen automation error codes. VS Code attaches
   * the response body to the rejection as `.body`; the leading `ErrorCode:`
   * message prefix is the fallback when the body is unavailable.
   *
   * `action` keeps the mapping honest: only stepping controls may surface the
   * frozen `TargetRunning` code, so a target-state message that implies
   * "still running" never leaks `TargetRunning` onto a non-step method.
   */
  private mapControlFailure(failure: unknown, action: AutomationControlRequest['action']): AutomationError {
    const record = failure && typeof failure === 'object' ? failure as Record<string, unknown> : {};
    const body = record.body && typeof record.body === 'object'
      ? record.body as Record<string, unknown>
      : record;
    const rawMessage = typeof record.message === 'string'
      ? record.message
      : typeof body.message === 'string'
        ? body.message
        : String(record.error ?? record ?? 'DAP automation control failed');
    const prefix = /^([A-Za-z][A-Za-z0-9]*):/.exec(String(rawMessage).trim())?.[1];
    const errorCode = typeof body.errorCode === 'string' && body.errorCode.length > 0
      ? body.errorCode
      : prefix ?? '';
    const details: Record<string, unknown> = { dapMessage: rawMessage };
    if (typeof body.targetState === 'string') details.targetState = body.targetState;
    if (body.diagnostics && typeof body.diagnostics === 'object') details.diagnostics = body.diagnostics;

    if (errorCode === 'TargetBusy' || /target busy|another automation control/i.test(rawMessage)) {
      return new AutomationError('TargetBusy', rawMessage, true, undefined, details);
    }
    if (errorCode === 'SessionStarting' || /phase (idle|flashing|connecting) cannot run/i.test(rawMessage)) {
      return new AutomationError('SessionStarting', rawMessage, true, undefined, details);
    }
    if (errorCode === 'SessionTerminating' || /terminat/i.test(rawMessage)) {
      return new AutomationError('SessionTerminating', rawMessage, false, undefined, details);
    }
    const runningImplied = isStepAction(action) && /TargetStateInvalid.*[Rr]unning/.test(rawMessage);
    if (errorCode === 'TargetRunning' || runningImplied) {
      return new AutomationError('TargetRunning', rawMessage, true, undefined, details);
    }
    if (errorCode === 'CapabilityUnavailable' || errorCode === 'UnsupportedCapability' || /unavailable|unsupported/i.test(rawMessage)) {
      return new AutomationError('CapabilityUnavailable', rawMessage, false, undefined, details);
    }
    if (errorCode === 'TargetDisconnected' || errorCode === 'NativeOwnerLost' || errorCode === 'TargetOwnerUnavailable' || errorCode === 'DeviceRemoved') {
      return new AutomationError('TargetDisconnected', rawMessage, false, undefined, details);
    }
    return new AutomationError('InternalError', rawMessage, false, undefined, details);
  }

  /**
   * Resolves the routing target for one call. An explicit ref always wins;
   * legacy callers without one use the injected current session. Only when
   * neither yields a session does the router fall back to the extension-host
   * backend (no active Orbit session exists).
   */
  private resolveTargetSession(ref?: SessionRef): vscode.DebugSession | undefined {
    if (!this.options) return undefined;
    if (ref) return this.options.resolveSession(ref);
    const current = this.options.currentRef?.();
    return current ? this.options.resolveSession(current) : undefined;
  }

  private normalizeSignal(signal: SignalSpec): SignalSpec {
    const expression = String(signal.expression || '').trim();
    if (!expression) throw new Error('Signal expression is required');
    const alias = String(signal.alias || expression).trim();
    return { ...signal, alias, expression };
  }

  private normalizeWrite(write: WriteSpec): WriteSpec {
    const expression = String(write.expression || '').trim();
    if (!expression) throw new Error('Write expression is required');
    const value = Number(write.value);
    if (!Number.isFinite(value)) throw new Error(`Write value for ${expression} must be finite`);
    const address = write.address === undefined ? undefined : Number(write.address);
    if (address !== undefined && (!Number.isInteger(address) || address < 0 || address > 0xFFFFFFFF)) {
      throw new Error(`Write address for ${expression} must be a 32-bit unsigned integer`);
    }
    const typeName = write.typeName === undefined ? undefined : String(write.typeName).trim();
    if (write.typeName !== undefined && !typeName) {
      throw new Error(`Write typeName for ${expression} must not be empty`);
    }
    return { ...write, expression, value, address, typeName };
  }
}
