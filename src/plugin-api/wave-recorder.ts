import { randomUUID } from 'crypto';
import { RuntimeRouter } from './runtime-router';
import {
  RecordClearParams,
  Recording,
  RecordStartParams,
  RecordStopParams,
  RuntimeReadValue,
  SignalSpec,
  WaveFrame,
} from './types';

const DEFAULT_INTERVAL_MS = 10;
const MIN_INTERVAL_MS = 5;
const MAX_INTERVAL_MS = 10000;
const MAX_CHANNELS = 64;
const MAX_FRAMES = 50000;

interface ActiveRecording {
  recording: Recording;
  timer: NodeJS.Timeout | null;
  stopped: boolean;
}

export class WaveRecorder {
  private recordings = new Map<string, ActiveRecording>();

  constructor(private runtime: RuntimeRouter) {}

  start(params: RecordStartParams): Recording {
    const channels = this.normalizeChannels(params.channels);
    const intervalMs = this.normalizeInterval(params.intervalMs);
    const recordingId = String(params.recordingId || `rec_${randomUUID()}`);
    if (this.recordings.has(recordingId)) {
      throw new Error(`Recording already exists: ${recordingId}`);
    }

    const active: ActiveRecording = {
      recording: {
        recordingId,
        startedAt: Date.now(),
        intervalMs,
        channels,
        frames: [],
      },
      timer: null,
      stopped: false,
    };

    this.recordings.set(recordingId, active);
    void this.sampleLoop(active);

    if (params.durationMs && params.durationMs > 0) {
      setTimeout(() => {
        if (!active.stopped) this.stop({ recordingId });
      }, params.durationMs);
    }

    return this.cloneRecording(active.recording);
  }

  async recordFor(params: RecordStartParams & { durationMs: number }): Promise<Recording> {
    const recording = this.start(params);
    await this.delay(Math.max(0, params.durationMs));
    return this.stop({ recordingId: recording.recordingId });
  }

  stop(params: RecordStopParams): Recording {
    const active = this.requireRecording(params.recordingId);
    if (!active.stopped) {
      active.stopped = true;
      active.recording.stoppedAt = Date.now();
      if (active.timer) {
        clearTimeout(active.timer);
        active.timer = null;
      }
    }
    return this.cloneRecording(active.recording);
  }

  get(recordingId: string): Recording {
    const active = this.requireRecording(recordingId);
    return this.cloneRecording(active.recording);
  }

  clear(params: RecordClearParams = {}): { cleared: string[] } {
    if (params.recordingId) {
      const active = this.requireRecording(params.recordingId);
      if (active.timer) clearTimeout(active.timer);
      this.recordings.delete(params.recordingId);
      return { cleared: [params.recordingId] };
    }

    const cleared = Array.from(this.recordings.keys());
    for (const active of this.recordings.values()) {
      if (active.timer) clearTimeout(active.timer);
    }
    this.recordings.clear();
    return { cleared };
  }

  dispose() {
    this.clear();
  }

  private async sampleLoop(active: ActiveRecording): Promise<void> {
    if (active.stopped) return;
    const timestamp = Date.now();
    const values = await this.runtime.readSignals(active.recording.channels);
    if (!active.stopped) {
      active.recording.frames.push(this.toFrame(timestamp, values));
      if (active.recording.frames.length > MAX_FRAMES) {
        active.recording.frames.splice(0, active.recording.frames.length - MAX_FRAMES);
      }
      active.timer = setTimeout(() => void this.sampleLoop(active), active.recording.intervalMs);
    }
  }

  private toFrame(timestamp: number, values: RuntimeReadValue[]): WaveFrame {
    const byAlias: WaveFrame['values'] = {};
    for (const value of values) {
      byAlias[value.alias] = value;
    }
    return { timestamp, values: byAlias };
  }

  private normalizeChannels(channels: SignalSpec[]): SignalSpec[] {
    if (!Array.isArray(channels) || channels.length === 0) {
      throw new Error('At least one recording channel is required');
    }
    if (channels.length > MAX_CHANNELS) {
      throw new Error(`Too many recording channels: ${channels.length}, max ${MAX_CHANNELS}`);
    }
    const aliases = new Set<string>();
    return channels.map(channel => {
      const expression = String(channel.expression || '').trim();
      if (!expression) throw new Error('Recording channel expression is required');
      const alias = String(channel.alias || expression).trim();
      if (aliases.has(alias)) throw new Error(`Duplicate channel alias: ${alias}`);
      aliases.add(alias);
      return { ...channel, alias, expression };
    });
  }

  private normalizeInterval(intervalMs?: number): number {
    const value = intervalMs ?? DEFAULT_INTERVAL_MS;
    if (!Number.isFinite(value)) throw new Error('Recording interval must be finite');
    return Math.max(MIN_INTERVAL_MS, Math.min(MAX_INTERVAL_MS, Math.floor(value)));
  }

  private requireRecording(recordingId: string): ActiveRecording {
    const active = this.recordings.get(recordingId);
    if (!active) throw new Error(`Recording not found: ${recordingId}`);
    return active;
  }

  private cloneRecording(recording: Recording): Recording {
    return {
      ...recording,
      channels: recording.channels.map(channel => ({ ...channel })),
      frames: recording.frames.map(frame => ({
        timestamp: frame.timestamp,
        values: Object.fromEntries(Object.entries(frame.values).map(([alias, value]) => [alias, { ...value }])),
      })),
    };
  }

  private delay(durationMs: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, durationMs));
  }
}
