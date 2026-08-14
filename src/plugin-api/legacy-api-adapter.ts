import { ExperimentService } from './experiment-service';
import { RuntimeRouter } from './runtime-router';
import {
  LegacyDeprecationMetadata,
  ReadManyParams,
  RecordClearParams,
  RecordGetParams,
  RecordStartParams,
  RecordStopParams,
  SignalSpec,
  WriteManyParams,
} from './types';
import { WaveRecorder } from './wave-recorder';

export const LEGACY_API_DEPRECATION: LegacyDeprecationMetadata = Object.freeze({
  deprecated: true,
  replacement: '/v1/rpc',
});

const LEGACY_MUTATIONS = new Set([
  'ozone.expr.writeMany',
  'ozone.record.start',
  'ozone.record.stop',
  'ozone.record.clear',
  'ozone.experiment.run',
]);

/** One-release compatibility surface. It deliberately cannot dispatch v1 methods. */
export class LegacyApiAdapter {
  constructor(
    private readonly runtime: RuntimeRouter,
    private readonly recorder: WaveRecorder,
    private readonly experiment: ExperimentService,
  ) {}

  isMutation(method: string): boolean {
    return LEGACY_MUTATIONS.has(method);
  }

  async dispatch(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'ozone.status':
        return { targetState: await this.runtime.getTargetState() };
      case 'ozone.target.getState':
        return { state: await this.runtime.getTargetState() };
      case 'ozone.expr.readMany':
        return { results: await this.runtime.readSignals(this.readManySignals(params as ReadManyParams)) };
      case 'ozone.expr.writeMany':
        return { results: await this.runtime.writeMany((params as WriteManyParams)?.writes || []) };
      case 'ozone.record.start':
        return this.recorder.start(params as RecordStartParams);
      case 'ozone.record.stop':
        return this.recorder.stop(params as RecordStopParams);
      case 'ozone.record.get':
        return this.recorder.get((params as RecordGetParams).recordingId);
      case 'ozone.record.clear':
        return this.recorder.clear((params as RecordClearParams) || {});
      case 'ozone.experiment.run':
        return this.experiment.run(params as any);
      default:
        throw new Error(`Unsupported legacy method: ${method}`);
    }
  }

  private readManySignals(params: ReadManyParams): SignalSpec[] {
    if (Array.isArray(params?.signals)) return params.signals;
    if (Array.isArray(params?.expressions)) {
      return params.expressions.map(expression => ({ alias: expression, expression }));
    }
    throw new Error('readMany requires signals or expressions');
  }
}
