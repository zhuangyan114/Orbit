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
        return 'error';
      } catch {
        return 'error';
      }
    }

    const result = await this.backend.execute({ cmd: 'getTargetState' });
    if (!result.ok) return 'error';
    return String(result.data);
  }

  async getRttStats(): Promise<Record<string, unknown>> {
    const session = this.activeOzoneSession();
    if (!session) throw new Error('Active ozone debug session is not available');
    try {
      const response = await session.customRequest('getRttStats', {});
      if (!response || typeof response !== 'object') throw new Error('DAP RTT stats returned no data');
      return response as Record<string, unknown>;
    } catch (err: any) {
      throw new Error(err?.message || 'DAP RTT stats failed');
    }
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
            address: write.address,
            typeName: write.typeName,
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
