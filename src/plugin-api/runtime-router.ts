import * as vscode from 'vscode';
import { OzoneBackend } from '../ozone-backend/commander';
import { WatchValue } from '../ozone-backend/types';
import { SessionRef } from './protocol';
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
