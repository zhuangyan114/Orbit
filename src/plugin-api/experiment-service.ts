// Orbit Automation API v1 — experiment service (plan Task 10).
//
// `runV1` (`orbit.experiment.run`) executes a script of read/write/memoryRead/
// memoryWrite/wait/record steps through the exact active session, reusing the
// runtime read path, the byte memory service and the unified RecordingService —
// never a second transport or owner. Every step is fenced by the exact
// SessionRef generation and by the scopes the caller was granted; a failed step
// stops subsequent mutation steps and returns the completed ones.
//
// `run` (the legacy `ozone.experiment.run` `/rpc` alias) is preserved verbatim
// for the Task 12 compatibility layer and keeps using the legacy WaveRecorder.
import { randomUUID } from 'crypto';
import { RuntimeRouter } from './runtime-router';
import { WaveRecorder } from './wave-recorder';
import { RecordingService } from './recording-service';
import { MemoryService } from './memory-service';
import {
  ExperimentRequest,
  ExperimentRunResult,
  ExperimentStep as LegacyExperimentStep,
  ExperimentStepResult,
  RuntimeWriteResult,
  SafetyRule,
  WriteSpec,
} from './types';
import {
  AutomationError,
  ExperimentReport,
  ExperimentStep as V1ExperimentStep,
  ExperimentStepOutcome,
  SessionRef,
} from './protocol';
import { parseWriteValue } from '../utils/watch-expression-validation';

const MAX_STEPS = 64;
const MAX_WAIT_MS = 60000;
const MAX_RECORD_MS = 60000;
const MAX_RECORD_MS_V1 = 600000;
const MAX_TIMEOUT_MS_V1 = 600000;

export interface ExperimentRunV1Options {
  operationId: string;
  scopes: ReadonlySet<string>;
}

function errorBase(code: string, retryable: boolean, details?: Record<string, unknown>): ExperimentStepOutcome['error'] {
  return { errorCode: code, retryable, ...(details ? { details } : {}) };
}

export class ExperimentService {
  constructor(
    private runtime: RuntimeRouter,
    private recorder: WaveRecorder,
    private recording: RecordingService,
    private memory: MemoryService,
  ) {}

  // --- v1 (plan Task 10) ------------------------------------------------------

  /** `orbit.experiment.run`: scripted, generation/scope-fenced experiment report. */
  async runV1(ref: SessionRef, request: { steps: V1ExperimentStep[]; timeoutMs?: number; continueOnError?: boolean }, options: ExperimentRunV1Options): Promise<ExperimentReport> {
    this.requireOperationId(options.operationId);
    const startedAt = Date.now();
    const deadline = startedAt + this.normalizeTimeout(request.timeoutMs);

    // The frozen catalog declares no requiredScopes for experiment.run, so the
    // dispatcher cannot gate it; check each step's scope here (plan: union of
    // step scopes).
    const missing = this.requiredScopes(request.steps).filter(scope => !options.scopes.has(scope));
    if (missing.length > 0) {
      throw new AutomationError('Unauthorized', `experiment requires scopes ${missing.join(', ')}`, false, undefined, {
        requiredScopes: missing,
      });
    }

    const steps: ExperimentStepOutcome[] = [];
    const recordingIds: string[] = [];
    let failed = false;
    let stopping = false;

    for (let index = 0; index < request.steps.length; index += 1) {
      const step = request.steps[index];
      if (stopping) {
        steps.push(this.skipOutcome(index, step.kind, Date.now(), 'skipped'));
        continue;
      }
      if (index > 0 && Date.now() >= deadline) {
        stopping = true;
        steps.push(this.skipOutcome(index, step.kind, Date.now(), 'cancelled'));
        continue;
      }
      const executed = await this.executeStep(ref, index, step);
      steps.push(executed.outcome);
      if (executed.recordingId) recordingIds.push(executed.recordingId);
      if (executed.outcome.status === 'failed') {
        failed = true;
        if (!request.continueOnError) stopping = true;
      }
    }

    return {
      operationId: options.operationId,
      status: failed ? 'failed' : stopping ? 'cancelled' : 'succeeded',
      steps,
      recordingIds,
      elapsedMs: Date.now() - startedAt,
    };
  }

  private async executeStep(ref: SessionRef, index: number, step: V1ExperimentStep): Promise<{ outcome: ExperimentStepOutcome; recordingId?: string }> {
    const startedAt = String(Date.now());
    try {
      switch (step.kind) {
        case 'read': {
          const alias = step.as ?? step.expression;
          const reads = await this.runtime.readSignals([{ alias, expression: step.expression }], ref);
          const read = reads[0];
          return {
            outcome: {
              index, kind: 'read', status: 'succeeded', startedAt,
              completedAt: String(Date.now()),
              value: read && !read.error ? read.display : null,
            },
          };
        }
        case 'write': {
          const numeric = parseWriteValue(step.value);
          if (numeric === undefined) {
            return { outcome: this.failOutcome(index, 'write', startedAt, 'ExpressionNotWritable') };
          }
          const results = await this.runtime.writeMany([{ expression: step.expression, value: numeric }], ref);
          if (!results[0]?.ok) {
            return { outcome: this.failOutcome(index, 'write', startedAt, 'TargetBusy') };
          }
          return {
            outcome: { index, kind: 'write', status: 'succeeded', startedAt, completedAt: String(Date.now()), value: step.value },
          };
        }
        case 'memoryRead': {
          const block = await this.memory.read(ref, { address: step.address, count: step.count });
          return {
            outcome: { index, kind: 'memoryRead', status: 'succeeded', startedAt, completedAt: String(Date.now()), value: block.bytesRead },
          };
        }
        case 'memoryWrite': {
          const report = await this.memory.write(ref, { address: step.address, data: step.data }, this.opId());
          return {
            outcome: { index, kind: 'memoryWrite', status: 'succeeded', startedAt, completedAt: String(Date.now()), value: report.bytesWritten },
          };
        }
        case 'wait': {
          const durationMs = this.normalizeDuration(step.durationMs, MAX_RECORD_MS_V1);
          await this.delay(durationMs);
          return {
            outcome: { index, kind: 'wait', status: 'succeeded', startedAt, completedAt: String(Date.now()), value: durationMs },
          };
        }
        case 'record': {
          const channels = step.expressions.map((expression, i) => ({
            channelId: `ch_${i}`, expression, valueType: '_',
          }));
          const recording = await this.recording.start(ref, {
            name: step.expressions[0],
            channels,
            intervalMs: step.intervalMs,
          });
          const durationMs = this.normalizeDuration(step.durationMs, MAX_RECORD_MS_V1);
          await this.delay(durationMs);
          const stopped = await this.recording.stop(ref, recording.recordingId);
          return {
            recordingId: stopped.recordingId,
            outcome: { index, kind: 'record', status: 'succeeded', startedAt, completedAt: String(Date.now()), value: stopped.recordingId },
          };
        }
        default:
          return { outcome: this.skipOutcome(index, String((step as { kind: string }).kind), Date.now(), 'skipped') };
      }
    } catch (error) {
      return { outcome: this.failOutcome(index, step.kind, startedAt, errorCodeFromError(error)) };
    }
  }

  private requiredScopes(steps: V1ExperimentStep[]): string[] {
    const scopes = new Set<string>();
    for (const step of steps) {
      if (step.kind === 'write') scopes.add('variables.write');
      if (step.kind === 'memoryWrite') scopes.add('memory.write');
      if (step.kind === 'record') scopes.add('record');
    }
    return Array.from(scopes);
  }

  private failOutcome(index: number, kind: string, startedAt: string, errorCode: string): ExperimentStepOutcome {
    return { index, kind, status: 'failed', startedAt, error: errorBase(errorCode, false) };
  }

  private skipOutcome(index: number, kind: string, startedAt: number, status: 'skipped' | 'cancelled'): ExperimentStepOutcome {
    return { index, kind, status, startedAt: String(startedAt) };
  }

  private normalizeTimeout(timeoutMs: number | undefined): number {
    const value = timeoutMs ?? MAX_TIMEOUT_MS_V1;
    if (!Number.isFinite(value)) return MAX_TIMEOUT_MS_V1;
    return Math.max(1, Math.min(Math.floor(value), MAX_TIMEOUT_MS_V1));
  }

  private requireOperationId(operationId: string | undefined): void {
    if (!operationId) {
      throw new AutomationError('InternalError', 'experiment dispatched without an operationId', false);
    }
  }

  private opId(): string {
    return `op_${randomUUID()}`;
  }

  // --- legacy `/rpc` `ozone.experiment.run` (preserved for Task 12) ----------

  async run(request: ExperimentRequest): Promise<ExperimentRunResult> {
    this.validateRequest(request);
    const startedAt = Date.now();
    const experimentId = `exp_${randomUUID()}`;
    const baseline = request.baseline && request.baseline.length > 0
      ? await this.runtime.readSignals(request.baseline)
      : undefined;

    const steps: ExperimentStepResult[] = [];
    for (const step of request.steps) {
      steps.push(await this.runLegacyStep(step, request.safety || []));
    }

    return {
      experimentId,
      name: request.name,
      startedAt,
      stoppedAt: Date.now(),
      baseline,
      steps,
    };
  }

  private async runLegacyStep(step: LegacyExperimentStep, safety: SafetyRule[]): Promise<ExperimentStepResult> {
    switch (step.type) {
      case 'read':
        return { type: 'read', values: await this.runtime.readSignals(step.signals) };
      case 'write':
        return { type: 'write', results: await this.writeWithSafety(step.writes, safety) };
      case 'wait': {
        const durationMs = this.normalizeDuration(step.durationMs, MAX_WAIT_MS);
        await this.delay(durationMs);
        return { type: 'wait', durationMs };
      }
      case 'record': {
        const durationMs = this.normalizeDuration(step.durationMs, MAX_RECORD_MS);
        const recording = await this.recorder.recordFor({
          recordingId: step.recordingId,
          durationMs,
          intervalMs: step.intervalMs,
          channels: step.channels,
        });
        return { type: 'record', recording };
      }
      default:
        throw new Error(`Unsupported experiment step: ${(step as { type: string }).type}`);
    }
  }

  private async writeWithSafety(writes: WriteSpec[], safety: SafetyRule[]): Promise<RuntimeWriteResult[]> {
    const blocked: RuntimeWriteResult[] = [];
    const allowed: WriteSpec[] = [];
    for (const write of writes) {
      const violation = this.checkSafety(write, safety);
      if (violation) {
        blocked.push({ alias: write.alias, expression: write.expression, value: write.value, ok: false, error: violation });
      } else {
        allowed.push(write);
      }
    }
    return [...blocked, ...(await this.runtime.writeMany(allowed))];
  }

  private checkSafety(write: WriteSpec, safety: SafetyRule[]): string | null {
    const rule = safety.find(item => item.expression === write.expression);
    if (!rule) return null;
    if (typeof rule.min === 'number' && write.value < rule.min) return `Value ${write.value} is below min ${rule.min}`;
    if (typeof rule.max === 'number' && write.value > rule.max) return `Value ${write.value} is above max ${rule.max}`;
    return null;
  }

  private validateRequest(request: ExperimentRequest) {
    if (!request || !Array.isArray(request.steps)) throw new Error('Experiment steps are required');
    if (request.steps.length > MAX_STEPS) throw new Error(`Too many experiment steps: ${request.steps.length}, max ${MAX_STEPS}`);
  }

  private normalizeDuration(durationMs: number, maxMs: number): number {
    const value = Number(durationMs);
    if (!Number.isFinite(value) || value < 0) return 0;
    return Math.min(Math.floor(value), maxMs);
  }

  private delay(durationMs: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, durationMs));
  }
}

function errorCodeFromError(error: unknown): string {
  if (error instanceof AutomationError) return error.errorCode;
  const message = error instanceof Error ? error.message : String(error);
  if (/read|sample|target/i.test(message)) return 'TargetReadCancelled';
  return 'InternalError';
}