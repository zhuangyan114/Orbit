import { WatchValue } from '../ozone-backend/types';

export interface JsonRpcRequest {
  id?: string | number;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  id?: string | number;
  ok: true;
  data: unknown;
}

export interface JsonRpcFailure {
  id?: string | number;
  ok: false;
  error: string;
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

export interface SignalSpec {
  alias: string;
  expression: string;
  role?: string;
  unit?: string;
  writable?: boolean;
}

export interface WriteSpec {
  alias?: string;
  expression: string;
  value: number;
}

export interface ReadManyParams {
  expressions?: string[];
  signals?: SignalSpec[];
}

export interface WriteManyParams {
  writes: WriteSpec[];
}

export interface RuntimeReadValue {
  alias: string;
  expression: string;
  value: number;
  display: string;
  hex?: string;
  address?: number;
  typeName?: string;
  error?: string;
}

export interface RuntimeWriteResult {
  alias?: string;
  expression: string;
  value: number;
  ok: boolean;
  error?: string;
}

export interface WaveFrame {
  timestamp: number;
  values: Record<string, RuntimeReadValue>;
}

export interface Recording {
  recordingId: string;
  startedAt: number;
  stoppedAt?: number;
  intervalMs: number;
  channels: SignalSpec[];
  frames: WaveFrame[];
}

export interface RecordStartParams {
  recordingId?: string;
  intervalMs?: number;
  durationMs?: number;
  channels: SignalSpec[];
}

export interface RecordStopParams {
  recordingId: string;
}

export interface RecordGetParams {
  recordingId: string;
}

export interface RecordClearParams {
  recordingId?: string;
}

export interface ExperimentRequest {
  name?: string;
  baseline?: SignalSpec[];
  steps: ExperimentStep[];
  safety?: SafetyRule[];
}

export type ExperimentStep =
  | { type: 'read'; signals: SignalSpec[] }
  | { type: 'write'; writes: WriteSpec[] }
  | { type: 'wait'; durationMs: number }
  | { type: 'record'; recordingId?: string; durationMs: number; intervalMs?: number; channels: SignalSpec[] };

export interface SafetyRule {
  expression: string;
  min?: number;
  max?: number;
}

export interface ExperimentRunResult {
  experimentId: string;
  name?: string;
  startedAt: number;
  stoppedAt: number;
  baseline?: RuntimeReadValue[];
  steps: ExperimentStepResult[];
}

export type ExperimentStepResult =
  | { type: 'read'; values: RuntimeReadValue[] }
  | { type: 'write'; results: RuntimeWriteResult[] }
  | { type: 'wait'; durationMs: number }
  | { type: 'record'; recording: Recording };

export interface ApiEndpointInfo {
  host: string;
  port: number;
  token: string;
  url: string;
  updatedAt: number;
}

export function normalizeWatchValue(alias: string, expression: string, value: WatchValue | null | undefined): RuntimeReadValue {
  if (!value) {
    return { alias, expression, value: 0, display: '', error: 'No value returned' };
  }
  return {
    alias,
    expression,
    value: value.value,
    display: value.display,
    hex: value.hex,
    address: value.address,
    typeName: value.typeName,
    error: value.error,
  };
}
