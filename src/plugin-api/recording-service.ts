// Orbit Automation API v1 — unified recording service (plan Task 10).
//
// API recording is an independent logical sampling consumer. It reads through
// the exact active session via RuntimeRouter.readSignals — the same short-window
// `dataSample` path the UI Timeline uses — so it never creates a second
// physical transport. It is never merged with Watch/Timeline/RTT as one
// consumer; instead it is an additional bounded, paginated channel.
//
// Budgets (frozen): at most 4 concurrent recordings, 64 channels, 50,000 frames
// per recording, and a whole-instance 64 MiB serialized frame budget. When the
// budget is exceeded the oldest stopped recordings are evicted first and then
// the oldest active frames are trimmed, publishing `record.truncated`; a frame
// is added before each budget check so the sum never exceeds the cap.
import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import {
  AutomationError,
  Recording,
  RecordingChannel,
  RecordingFrame,
  RecordingFramesPage,
  RecordingFrameValue,
  RecordingListData,
  RecordClearData,
  SessionRef,
} from './protocol';
import { SessionRegistry } from './session-registry';
import { RuntimeRouter } from './runtime-router';
import { SignalSpec } from './types';
import { EventHub } from './event-hub';
import { FastSampleSink, ReleasedSample } from './fast-sample-sink';
import { normalizeAutomationExpression } from '../utils/watch-expression-validation';

const MAX_CONCURRENT_RECORDINGS = 4;
const MAX_CHANNELS = 64;
const MIN_INTERVAL_MS = 0;
const MAX_FRAMES = 50000;
const BUDGET_BYTES = 64 * 1024 * 1024;
const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 1000;

export interface RecordingStartParams {
  name: string;
  channels: RecordingChannel[];
  intervalMs: number;
  maxFrames?: number;
}

interface ActiveRecording {
  recording: Recording;
  frames: RecordingFrame[];
  timer: NodeJS.Timeout | null;
  stopped: boolean;
  frameCounter: number;
  token: number;
  maxFrames: number;
  ref: SessionRef;
  /** Latest per-channel value captured from the high-rate sink (fast path). */
  latest: Map<string, number>;
}

export interface RecordingServiceOptions {
  registry: SessionRegistry;
  runtime: RuntimeRouter;
  eventHub?: EventHub;
  now?(): number;
  /** High-rate sampler reused from the UI Timeline channel (plan Task 10). */
  sampleSink?: FastSampleSink;
  /** Expressions (UI Timeline) that must keep sampling alongside recordings. */
  sharedSampleExpressions?: () => string[];
}

export class RecordingService implements vscode.Disposable {
  private readonly recordings = new Map<string, ActiveRecording>();
  private readonly registry: SessionRegistry;
  private readonly runtime: RuntimeRouter;
  private readonly eventHub?: EventHub;
  private readonly nowFn: () => number;
  private nextToken = 0;
  private readonly sampleSink?: FastSampleSink;
  private readonly sharedSampleExpressions?: () => string[];

  constructor(options: RecordingServiceOptions) {
    this.registry = options.registry;
    this.runtime = options.runtime;
    this.eventHub = options.eventHub;
    this.nowFn = options.now ?? (() => Date.now());
    this.sampleSink = options.sampleSink;
    this.sharedSampleExpressions = options.sharedSampleExpressions;
  }

  /** `orbit.record.start`: create and begin sampling a new recording. */
  async start(ref: SessionRef, params: RecordingStartParams): Promise<Recording> {
    this.registry.requireExact(ref); // generation fence
    const channels = this.normalizeChannels(params.channels);
    const intervalMs = this.normalizeInterval(params.intervalMs);
    const maxFrames = this.clampMaxFrames(params.maxFrames);

    const activeCount = Array.from(this.recordings.values()).filter(r => !r.stopped).length;
    if (activeCount >= MAX_CONCURRENT_RECORDINGS) {
      throw new AutomationError('RateLimited', `at most ${MAX_CONCURRENT_RECORDINGS} concurrent recordings`, false);
    }

    const id = `rec_${randomUUID()}`;
    const token = ++this.nextToken;
    const recording: Recording = {
      recordingId: id,
      name: params.name,
      status: 'recording',
      startedAt: String(this.nowFn()),
      intervalMs,
      channels,
      frameCount: 0,
      bytesRetained: 0,
    };
    const active: ActiveRecording = {
      recording,
      frames: [],
      timer: null,
      stopped: false,
      frameCounter: 0,
      token,
      maxFrames,
      ref,
      latest: new Map(),
    };
    this.recordings.set(id, active);
    this.publish('record.started', { recordingId: id, name: recording.name });
    if (this.sampleSink) {
      this.syncSampleSink();
    } else {
      this.schedule(active);
    }
    return this.summary(recording);
  }

  /** `orbit.record.stop`: stop collecting frames for a recording. */
  async stop(ref: SessionRef, recordingId: string): Promise<Recording> {
    this.registry.requireExact(ref);
    const active = this.requireRecording(recordingId);
    this.stopActive(active);
    this.syncSampleSink();
    return this.summary(active.recording);
  }

  /** `orbit.record.list`: recording summaries, newest first. */
  async list(ref: SessionRef, params: { cursor?: string; limit?: number; status?: string } = {}): Promise<RecordingListData> {
    this.registry.requireExact(ref);
    let items = Array.from(this.recordings.values())
      .map(entry => this.summary(entry.recording))
      .reverse();
    if (params.status) items = items.filter(item => item.status === params.status);
    const cursor = params.cursor;
    const start = cursor === undefined ? 0 : this.cursorIndex(cursor, items) + 1;
    const count = this.clampPage(params.limit);
    const slice = items.slice(start, start + count);
    const data: RecordingListData = { items: slice };
    if (start + count < items.length) data.nextCursor = slice[slice.length - 1].recordingId;
    return data;
  }

  /** `orbit.record.get`: a paginated page of frames (default 100, max 1000). */
  async get(ref: SessionRef, params: { recordingId: string; cursor?: string; limit?: number }): Promise<RecordingFramesPage> {
    this.registry.requireExact(ref);
    const active = this.requireRecording(params.recordingId);
    const start = params.cursor === undefined ? 0 : this.frameCursorIndex(params.cursor, active.frames) + 1;
    const count = this.clampPage(params.limit);
    const slice = active.frames.slice(start, start + count);
    const data: RecordingFramesPage = {
      recording: this.summary(active.recording),
      items: slice.map(frame => this.cloneFrame(frame)),
    };
    if (start + count < active.frames.length) {
      data.nextCursor = this.cloneFrame(slice[slice.length - 1]).frameId;
    }
    return data;
  }

  /** `orbit.record.clear`: stop (if active) and remove a recording. */
  async clear(ref: SessionRef, params: { recordingId: string }): Promise<RecordClearData> {
    this.registry.requireExact(ref);
    const active = this.requireRecording(params.recordingId);
    this.stopActive(active);
    const clearedFrames = active.frames.length;
    this.recordings.delete(params.recordingId);
    this.syncSampleSink();
    return { operationId: this.nextOperation(), recordingId: params.recordingId, clearedFrames };
  }

  dispose(): void {
    for (const active of this.recordings.values()) this.stopActive(active);
    this.recordings.clear();
    void this.sampleSink?.dispose();
  }

  /** Whole-instance sampling counters for `orbit.diagnostics.snapshot` (Task 11). */
  stats(): { activeRecordings: number; retainedFrames: number; retainedBytes: number; droppedFrames: number } {
    let activeRecordings = 0;
    let retainedFrames = 0;
    let retainedBytes = 0;
    for (const entry of this.recordings.values()) {
      if (!entry.stopped) activeRecordings += 1;
      retainedFrames += entry.frames.length;
      retainedBytes += entry.recording.bytesRetained;
    }
    return { activeRecordings, retainedFrames, retainedBytes, droppedFrames: 0 };
  }

  // --- high-rate fast-path sampling (plan Task 10) ---------------------------

  /**
   * (Re)configures the shared adapter fast sampler while recordings are active,
   * so recording frames reuse the UI Timeline's high-rate `ozoneDataSamples`
   * channel instead of one-shot `dataSample` reads. When the last recording
   * stops, the sampler is left sampling only the shared (Timeline) expressions,
   * or fully stopped when there is none.
   */
  private syncSampleSink(): void {
    void this.doSyncSink();
  }

  private activeRecordings(): ActiveRecording[] {
    return Array.from(this.recordings.values()).filter(recording => !recording.stopped);
  }

  private async doSyncSink(): Promise<void> {
    const sink = this.sampleSink;
    if (!sink) return;
    const actives = this.activeRecordings();
    const shared = (this.sharedSampleExpressions?.() ?? []).map(expression => ({ expression, color: '#4EC9B0' }));

    if (actives.length === 0) {
      sink.removeConsumer('recording');
      return;
    }
    let session: vscode.DebugSession | null = null;
    try {
      session = this.registry.requireExact(actives[0].ref);
    } catch {
      session = null;
    }
    if (!session) {
      sink.removeConsumer('recording');
      return;
    }
    const channels = actives.flatMap(recording => recording.recording.channels.map(channel => ({
      channelId: channel.channelId,
      expression: channel.expression,
    })));
    sink.addConsumer({
      key: 'recording',
      session,
      channels,
      shared,
      onPoints: points => this.ingestSink(points),
    });
  }

  /** Routes high-rate sink points into each recording's raw frame stream. A frame
   *  is emitted per distinct capture timestamp — the adapter already assigns the
   *  same timestamp to all channels of one `readFastDataSampling` batch, so this
   *  delivers the underlying fast-sampler cadence without any intervalMs cap. */
  private ingestSink(points: ReleasedSample[]): void {
    if (points.length === 0) return;
    const byRecording = new Map<ActiveRecording, ReleasedSample[]>();
    for (const point of points) {
      for (const recording of this.activeRecordings()) {
        if (!recording.recording.channels.some(channel => channel.channelId === point.channelId)) continue;
        const list = byRecording.get(recording);
        if (list) list.push(point); else byRecording.set(recording, [point]);
      }
    }
    for (const [recording, samples] of byRecording) {
      const byTimestamp = new Map<number, ReleasedSample[]>();
      for (const sample of samples) {
        const list = byTimestamp.get(sample.timestamp);
        if (list) list.push(sample); else byTimestamp.set(sample.timestamp, [sample]);
      }
      const timestamps = Array.from(byTimestamp.keys()).sort((a, b) => a - b);
      for (const timestamp of timestamps) {
        for (const sample of byTimestamp.get(timestamp) ?? []) {
          recording.latest.set(sample.channelId, sample.value);
        }
        const values: RecordingFrameValue[] = recording.recording.channels.map(channel => {
          const value = recording.latest.get(channel.channelId);
          return {
            channelId: channel.channelId,
            value: value === undefined ? null : value,
            available: value !== undefined,
          };
        });
        this.appendFrame(recording, values, timestamp);
      }
    }
  }

  // --- sampling --------------------------------------------------------------

  private schedule(active: ActiveRecording): void {
    if (active.stopped) return;
    active.timer = setTimeout(() => void this.sampleLoop(active), active.recording.intervalMs);
  }

  private async sampleLoop(active: ActiveRecording): Promise<void> {
    if (active.stopped || active.token !== this.nextToken) return;
    const signals: SignalSpec[] = active.recording.channels.map(channel => ({
      alias: channel.channelId,
      expression: channel.expression,
    }));
    try {
      const reads = await this.runtime.readSignals(signals, active.ref);
      if (active.stopped) return; // a stale sample must not be published
      this.appendFrame(active, reads.map((read, index) => ({
        channelId: active.recording.channels[index].channelId,
        value: read.error ? null : (read.value ?? null),
        available: !read.error,
      })));
    } catch {
      // A generation fence or a lost session must stop this recording so its
      // timer is released and no stale frame is published (§2.3).
      this.stopActive(active);
      return;
    }
    if (!active.stopped) this.schedule(active);
  }

  private appendFrame(active: ActiveRecording, values: RecordingFrameValue[], timestampMs?: number): void {
    active.frameCounter += 1;
    const frame: RecordingFrame = {
      frameId: String(active.frameCounter),
      timestamp: String(timestampMs === undefined ? this.nowFn() : timestampMs),
      sessionGeneration: active.ref.sessionGeneration,
      values,
    };
    active.frames.push(frame);
    active.recording.frameCount += 1;
    active.recording.bytesRetained += Buffer.byteLength(JSON.stringify(frame), 'utf8');
    while (active.frames.length > active.maxFrames) {
      const removed = active.frames.shift()!;
      active.recording.bytesRetained = Math.max(0, active.recording.bytesRetained - Buffer.byteLength(JSON.stringify(removed), 'utf8'));
      active.recording.frameCount -= 1;
    }
    this.enforceBudget();
  }

  /** Whole-instance 64 MiB budget: evict oldest stopped, then trim active frames. */
  private enforceBudget(): void {
    if (this.currentBudget() <= BUDGET_BYTES) return;

    const stopped = Array.from(this.recordings.values())
      .filter(entry => entry.stopped)
      .sort((a, b) => this.timestampValue(a.recording.stoppedAt ?? a.recording.startedAt) - this.timestampValue(b.recording.stoppedAt ?? b.recording.startedAt));
    for (const entry of stopped) {
      if (this.currentBudget() <= BUDGET_BYTES) break;
      this.recordings.delete(entry.recording.recordingId);
    }

    if (this.currentBudget() > BUDGET_BYTES) {
      let removed = 0;
      let progress = true;
      while (this.currentBudget() > BUDGET_BYTES && progress) {
        progress = false;
        for (const entry of Array.from(this.recordings.values())) {
          if (entry.frames.length <= 0) continue;
          const removedFrame = entry.frames.shift()!;
          entry.recording.bytesRetained = Math.max(0, entry.recording.bytesRetained - Buffer.byteLength(JSON.stringify(removedFrame), 'utf8'));
          entry.recording.frameCount -= 1;
          removed += 1;
          progress = true;
          if (this.currentBudget() <= BUDGET_BYTES) break;
        }
      }
      if (removed > 0) this.publish('record.truncated', { removedFrames: removed });
    }
  }

  private currentBudget(): number {
    return Array.from(this.recordings.values()).reduce((sum, entry) => sum + entry.recording.bytesRetained, 0);
  }

  // --- helpers --------------------------------------------------------------

  private stopActive(active: ActiveRecording): void {
    if (active.stopped) return;
    active.stopped = true;
    if (active.timer) {
      clearTimeout(active.timer);
      active.timer = null;
    }
    if (active.recording.status === 'recording' || active.recording.status === 'starting') {
      active.recording.status = 'stopped';
      active.recording.stoppedAt = String(this.nowFn());
    }
    this.publish('record.stopped', { recordingId: active.recording.recordingId });
  }

  private normalizeChannels(channels: RecordingChannel[]): RecordingChannel[] {
    if (!Array.isArray(channels) || channels.length === 0) {
      throw new AutomationError('InvalidRequest', 'at least one recording channel is required', false);
    }
    if (channels.length > MAX_CHANNELS) {
      throw new AutomationError('InvalidRequest', `at most ${MAX_CHANNELS} recording channels`, false);
    }
    const ids = new Set<string>();
    return channels.map(channel => {
      const channelId = typeof channel.channelId === 'string' ? channel.channelId.trim() : '';
      if (!channelId || ids.has(channelId)) {
        throw new AutomationError('InvalidRequest', 'recording channelId must be non-empty and unique', false);
      }
      const expression = normalizeAutomationExpression(channel.expression);
      if (!expression.ok) throw new AutomationError('InvalidExpression', expression.reason, false);
      ids.add(channelId);
      const mapped: RecordingChannel = { channelId, expression: expression.expression, valueType: channel.valueType };
      if (channel.unit !== undefined) mapped.unit = channel.unit;
      return mapped;
    });
  }

  private normalizeInterval(intervalMs: number): number {
    if (!Number.isFinite(intervalMs)) throw new AutomationError('InvalidRequest', 'intervalMs must be finite', false);
    return Math.max(MIN_INTERVAL_MS, Math.floor(intervalMs));
  }

  private clampMaxFrames(maxFrames: number | undefined): number {
    if (maxFrames === undefined || !Number.isFinite(maxFrames)) return MAX_FRAMES;
    return Math.max(1, Math.min(Math.floor(maxFrames), MAX_FRAMES));
  }

  private requireRecording(recordingId: string): ActiveRecording {
    const active = this.recordings.get(recordingId);
    if (!active) throw new AutomationError('RecordingNotFound', `recording ${recordingId} not found`, false);
    return active;
  }

  private summary(recording: Recording): Recording {
    return { ...recording, channels: recording.channels.map(channel => ({ ...channel })) };
  }

  private cloneFrame(frame: RecordingFrame): RecordingFrame {
    const cloned: RecordingFrame = {
      frameId: frame.frameId,
      timestamp: frame.timestamp,
      sessionGeneration: frame.sessionGeneration,
      values: frame.values.map(value => ({ ...value })),
    };
    if (frame.timestampNs !== undefined) cloned.timestampNs = frame.timestampNs;
    return cloned;
  }

  private clampPage(value: number | undefined): number {
    const page = value ?? DEFAULT_PAGE_LIMIT;
    if (!Number.isFinite(page)) return DEFAULT_PAGE_LIMIT;
    return Math.max(1, Math.min(Math.floor(page), MAX_PAGE_LIMIT));
  }

  private cursorIndex(cursor: string, items: Recording[]): number {
    const index = items.findIndex(item => item.recordingId === cursor);
    if (index === -1) throw new AutomationError('InvalidRequest', `unknown cursor ${cursor}`, false);
    return index;
  }

  private frameCursorIndex(cursor: string, frames: RecordingFrame[]): number {
    const index = frames.findIndex(frame => frame.frameId === cursor);
    if (index === -1) throw new AutomationError('InvalidRequest', `unknown cursor ${cursor}`, false);
    return index;
  }

  private timestampValue(value: string): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private nextOperation(): string {
    return `op_${randomUUID()}`;
  }

  private publish(type: string, data?: Record<string, unknown>): void {
    const hub = this.eventHub;
    if (!hub || hub.isDisposed()) return;
    try {
      hub.publish(type, { data });
    } catch {
      // A disposed hub must not break a recording mutation.
    }
  }
}