import * as vscode from 'vscode';
import { OzoneBackend } from '../ozone-backend/commander';
import { WatchValue } from '../ozone-backend/types';
import {
  RuntimeReadValue,
  RuntimeWriteResult,
  SignalSpec,
  WriteSpec,
  normalizeWatchValue,
} from './types';

export class RuntimeRouter {
  constructor(private backend: OzoneBackend) {}

  async getTargetState(): Promise<string> {
    const session = this.activeOzoneSession();
    if (session) {
      try {
        const response: any = await session.customRequest('getTargetState', {});
        if (typeof response?.state === 'string') return response.state;
      } catch {}
    }

    const result = await this.backend.execute({ cmd: 'getTargetState' });
    if (!result.ok) return 'error';
    return String(result.data);
  }

  async readSignals(signals: SignalSpec[]): Promise<RuntimeReadValue[]> {
    const normalized = signals.map(signal => this.normalizeSignal(signal));
    if (normalized.length === 0) return [];

    const expressions = normalized.map(signal => signal.expression);
    const session = this.activeOzoneSession();
    if (session) {
      try {
        const response: any = await session.customRequest('dataSample', { expressions });
        if (Array.isArray(response?.results)) {
          return normalized.map((signal, index) => {
            const value = response.results[index] as WatchValue | undefined;
            return normalizeWatchValue(signal.alias, signal.expression, value);
          });
        }
      } catch {}
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

  async writeMany(writes: WriteSpec[]): Promise<RuntimeWriteResult[]> {
    const normalized = writes.map(write => this.normalizeWrite(write));
    if (normalized.length === 0) return [];

    const results: RuntimeWriteResult[] = [];
    for (const write of normalized) {
      const session = this.activeOzoneSession();
      if (session) {
        try {
          const response: any = await session.customRequest('setWatchValue', {
            expression: write.expression,
            value: write.value,
          });
          if (response?.ok === true) {
            results.push({ ...write, ok: true });
          } else {
            results.push({ ...write, ok: false, error: response?.error || 'Write failed' });
          }
          continue;
        } catch (err: any) {
          results.push({ ...write, ok: false, error: err?.message || String(err) });
          continue;
        }
      }

      try {
        const result = await this.backend.execute({
          cmd: 'setWatchValue',
          expression: write.expression,
          value: write.value,
        });
        results.push(result.ok ? { ...write, ok: true } : { ...write, ok: false, error: result.error });
      } catch (err: any) {
        results.push({ ...write, ok: false, error: err?.message || String(err) });
      }
    }
    return results;
  }

  private activeOzoneSession(): vscode.DebugSession | undefined {
    const session = vscode.debug.activeDebugSession;
    return session?.type === 'ozone' ? session : undefined;
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
    return { ...write, expression, value };
  }
}
