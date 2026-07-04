import { randomUUID } from 'crypto';
import { RuntimeRouter } from './runtime-router';
import { WaveRecorder } from './wave-recorder';
import {
  ExperimentRequest,
  ExperimentRunResult,
  ExperimentStep,
  ExperimentStepResult,
  RuntimeWriteResult,
  SafetyRule,
  WriteSpec,
} from './types';

const MAX_STEPS = 64;
const MAX_WAIT_MS = 60000;
const MAX_RECORD_MS = 60000;

export class ExperimentService {
  constructor(private runtime: RuntimeRouter, private recorder: WaveRecorder) {}

  async run(request: ExperimentRequest): Promise<ExperimentRunResult> {
    this.validateRequest(request);
    const startedAt = Date.now();
    const experimentId = `exp_${randomUUID()}`;
    const baseline = request.baseline && request.baseline.length > 0
      ? await this.runtime.readSignals(request.baseline)
      : undefined;

    const steps: ExperimentStepResult[] = [];
    for (const step of request.steps) {
      steps.push(await this.runStep(step, request.safety || []));
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

  private async runStep(step: ExperimentStep, safety: SafetyRule[]): Promise<ExperimentStepResult> {
    switch (step.type) {
      case 'read':
        return { type: 'read', values: await this.runtime.readSignals(step.signals) };
      case 'write':
        return { type: 'write', results: await this.writeWithSafety(step.writes, safety) };
      case 'wait': {
        const durationMs = this.normalizeDuration(step.durationMs, MAX_WAIT_MS, 'wait');
        await this.delay(durationMs);
        return { type: 'wait', durationMs };
      }
      case 'record': {
        const durationMs = this.normalizeDuration(step.durationMs, MAX_RECORD_MS, 'record');
        const recording = await this.recorder.recordFor({
          recordingId: step.recordingId,
          durationMs,
          intervalMs: step.intervalMs,
          channels: step.channels,
        });
        return { type: 'record', recording };
      }
      default:
        throw new Error(`Unsupported experiment step: ${(step as any).type}`);
    }
  }

  private async writeWithSafety(writes: WriteSpec[], safety: SafetyRule[]): Promise<RuntimeWriteResult[]> {
    const blocked: RuntimeWriteResult[] = [];
    const allowed: WriteSpec[] = [];

    for (const write of writes) {
      const violation = this.checkSafety(write, safety);
      if (violation) {
        blocked.push({
          alias: write.alias,
          expression: write.expression,
          value: write.value,
          ok: false,
          error: violation,
        });
      } else {
        allowed.push(write);
      }
    }

    return [...blocked, ...(await this.runtime.writeMany(allowed))];
  }

  private checkSafety(write: WriteSpec, safety: SafetyRule[]): string | null {
    const rule = safety.find(item => item.expression === write.expression);
    if (!rule) return null;
    if (typeof rule.min === 'number' && write.value < rule.min) {
      return `Value ${write.value} is below min ${rule.min}`;
    }
    if (typeof rule.max === 'number' && write.value > rule.max) {
      return `Value ${write.value} is above max ${rule.max}`;
    }
    return null;
  }

  private validateRequest(request: ExperimentRequest) {
    if (!request || !Array.isArray(request.steps)) {
      throw new Error('Experiment steps are required');
    }
    if (request.steps.length > MAX_STEPS) {
      throw new Error(`Too many experiment steps: ${request.steps.length}, max ${MAX_STEPS}`);
    }
  }

  private normalizeDuration(durationMs: number, maxMs: number, label: string): number {
    const value = Number(durationMs);
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${label} duration must be a non-negative finite number`);
    }
    return Math.min(Math.floor(value), maxMs);
  }

  private delay(durationMs: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, durationMs));
  }
}
