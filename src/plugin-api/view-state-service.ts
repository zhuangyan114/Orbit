// Orbit Automation API v1 — Watch and Timeline view state (plan Task 10).
//
// The Watch and Timeline expression collections are the single normalized
// source for both the API and the VS Code UI: they are persisted under the
// same `ozoneWatchExpressions` / `ozoneDataSamplingExpressions` workspace-state
// keys the UI providers use, and every UI/API mutation runs through the same
// Unicode-preserving trim + empty/dedup normalization. The service therefore
// stays in sync with the Watch and Timeline webviews without a second,
// driftable store.
//
// Timeline `start`/`stop`/`status` manage an API-side sampling loop that reads
// through the exact active session via RuntimeRouter.readSignals — the same
// short-window `dataSample` read path the UI Timeline and Watch use. It is an
// independent logical consumer (never merged with recording/RTT), fenced by the
// exact SessionRef generation, and stale samples from a replaced session are
// never published.
import * as vscode from 'vscode';
import {
  AutomationError,
  ExpressionValue,
  SessionRef,
  TimelineSnapshot,
  WatchSnapshot,
} from './protocol';
import { SessionRegistry } from './session-registry';
import { RuntimeRouter } from './runtime-router';
import { RuntimeReadValue, SignalSpec } from './types';
import { EventHub } from './event-hub';
import { FastSampleSink, ReleasedSample } from './fast-sample-sink';
import { normalizeAutomationExpression } from '../utils/watch-expression-validation';

export const WATCH_EXPRESSIONS_KEY = 'ozoneWatchExpressions';
export const TIMELINE_EXPRESSIONS_KEY = 'ozoneDataSamplingExpressions';

/** Minimal persisted-workspace-state surface used to keep UI/API in sync. */
export interface ViewStateStore {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

export interface TimelineEntry {
  expression: string;
  color?: string;
  enabled?: boolean;
}

export interface ViewStateServiceOptions {
  registry: SessionRegistry;
  runtime: RuntimeRouter;
  /** Persisted workspace state sharing the UI keys; unit tests inject a fake. */
  store?: ViewStateStore;
  eventHub?: EventHub;
  /** High-rate sampler reused from the UI Timeline channel (plan Task 10). */
  sampleSink?: FastSampleSink;
  now?(): number;
}

const WATCH_LIMIT = 1000;
const TIMELINE_LIMIT = 64;
const MAX_FRAMES = 50000;
const MIN_INTERVAL_MS = 5;
const MAX_INTERVAL_MS = 10000;

interface ActiveSampling {
  ref: SessionRef;
  intervalMs: number;
  maxFrames: number;
  generation: number;
  token: number;
  timer: NodeJS.Timeout | null;
  frames: Map<string, { timestamp: number; value: number }[]>;
  dropped: number;
  stopped: boolean;
}

/** Converts a RuntimeReadValue into the frozen ExpressionValue wire shape. */
function toExpressionValue(read: RuntimeReadValue): ExpressionValue {
  const value: ExpressionValue = {
    expression: read.expression,
    value: read.display,
    variablesReference: '0',
    available: !read.error,
    stale: false,
  };
  if (read.error) {
    value.error = { errorCode: 'TargetReadCancelled', retryable: false, details: { dapMessage: read.error } };
  } else if (read.exactValue) {
    value.value = read.exactValue;
  }
  return value;
}

export class ViewStateService implements vscode.Disposable {
  private readonly store: ViewStateStore;
  private readonly registry: SessionRegistry;
  private readonly runtime: RuntimeRouter;
  private readonly eventHub?: EventHub;
  private readonly sampleSink?: FastSampleSink;
  private readonly nowFn: () => number;

  private watchExpressions: string[] = [];
  private timeline: TimelineEntry[] = [];
  private watchRevision = 0;
  private timelineRevision = 0;
  private samplingToken = 0;
  private sampling: ActiveSampling | null = null;

  constructor(options: ViewStateServiceOptions) {
    this.registry = options.registry;
    this.runtime = options.runtime;
    this.store = options.store ?? this.nullStore();
    this.eventHub = options.eventHub;
    this.sampleSink = options.sampleSink;
    this.nowFn = options.now ?? (() => Date.now());
    this.hydrate();
  }

  // --- Watch ---------------------------------------------------------------

  /** `orbit.watch.list`: the persisted expressions plus best-effort values. */
  async watchSnapshot(includeValues = true): Promise<WatchSnapshot> {
    let values: ExpressionValue[] = [];
    if (includeValues && this.watchExpressions.length > 0) {
      values = await this.readWatchValues();
    }
    return {
      expressions: [...this.watchExpressions],
      values,
      uiSynchronized: true,
      revision: this.watchRevision,
      items: values,
      nextCursor: null,
    };
  }

  /** `orbit.watch.replace`: replace the whole Watch expression list. */
  async replaceWatch(expressions: string[]): Promise<WatchSnapshot> {
    const next = this.normalizeWatchList(expressions);
    this.watchExpressions = next;
    this.watchRevision += 1;
    void this.store.update(WATCH_EXPRESSIONS_KEY, next);
    this.publish('watch.changed', { expressions: next });
    return this.watchSnapshot(false);
  }

  /** `orbit.watch.add`: append new expressions, dropping duplicates. */
  async addWatch(expressions: string[]): Promise<WatchSnapshot> {
    const additions = this.normalizeWatchList(expressions);
    const next = [...this.watchExpressions];
    for (const expression of additions) {
      if (!next.includes(expression)) next.push(expression);
    }
    this.watchExpressions = next;
    this.watchRevision += 1;
    void this.store.update(WATCH_EXPRESSIONS_KEY, next);
    this.publish('watch.changed', { expressions: next });
    return this.watchSnapshot(false);
  }

  /** `orbit.watch.remove`: drop the exact expressions that exist. */
  async removeWatch(expressions: string[]): Promise<WatchSnapshot> {
    const removeSet = new Set(this.normalizeWatchList(expressions));
    const next = this.watchExpressions.filter(expression => !removeSet.has(expression));
    this.watchExpressions = next;
    this.watchRevision += 1;
    void this.store.update(WATCH_EXPRESSIONS_KEY, next);
    this.publish('watch.changed', { expressions: next });
    return this.watchSnapshot(false);
  }

  /** Adopt the UI's Watch expression list and persist it (UI -> API sync). */
  setWatchFromUi(expressions: string[]): void {
    this.watchExpressions = this.normalizeWatchList(expressions);
    this.watchRevision += 1;
    void this.store.update(WATCH_EXPRESSIONS_KEY, this.watchExpressions);
    this.publish('watch.changed', { expressions: this.watchExpressions });
  }

  /** Adopt the UI's Timeline entries (preserving color metadata) and persist. */
  setTimelineFromUi(entries: (string | TimelineEntry)[]): void {
    const normalized: TimelineEntry[] = [];
    const seen = new Set<string>();
    for (const raw of entries) {
      const expression = typeof raw === 'string' ? raw : raw.expression;
      const check = normalizeAutomationExpression(expression);
      if (!check.ok || seen.has(check.expression)) continue;
      seen.add(check.expression);
      const entry: TimelineEntry = { expression: check.expression, enabled: true };
      if (typeof raw !== 'string') {
        if (raw.color !== undefined) entry.color = raw.color;
        if (raw.enabled !== undefined) entry.enabled = raw.enabled;
      }
      normalized.push(entry);
      if (normalized.length >= TIMELINE_LIMIT) break;
    }
    this.timeline = normalized;
    this.timelineRevision += 1;
    void this.store.update(TIMELINE_EXPRESSIONS_KEY, this.serializeTimeline(normalized));
    this.publish('timeline.changed', { expressions: this.timelineExpressions() });
  }

  // --- Timeline ------------------------------------------------------------

  /** `orbit.timeline.list`: expressions plus the current sampling status. */
  timelineSnapshot(includeStatus = true): TimelineSnapshot {
    const sampling = this.sampling && !this.sampling.stopped ? this.sampling : null;
    let framesRetained = 0;
    if (includeStatus && sampling) {
      for (const points of sampling.frames.values()) framesRetained += points.length;
    }
    return {
      expressions: this.timelineExpressions(),
      sampling: sampling !== null,
      intervalMs: sampling?.intervalMs ?? 0,
      generation: sampling?.generation ?? 0,
      framesRetained,
      droppedFrames: sampling?.dropped ?? 0,
      revision: this.timelineRevision,
      items: this.timelineExpressions(),
      nextCursor: null,
    };
  }

  /** `orbit.timeline.replace`: replace the timeline expression collection. */
  async replaceTimeline(expressions: string[]): Promise<TimelineSnapshot> {
    const entries = this.normalizeTimelineList(expressions);
    this.timeline = entries;
    this.timelineRevision += 1;
    void this.store.update(TIMELINE_EXPRESSIONS_KEY, this.serializeTimeline(entries));
    this.publish('timeline.changed', { expressions: this.timelineExpressions() });
    return this.timelineSnapshot(true);
  }

  /** `orbit.timeline.start`: begin API-side sampling of the current expressions. */
  async startTimeline(ref: SessionRef, intervalMs: number, maxFrames?: number): Promise<TimelineSnapshot> {
    const session = this.registry.requireExact(ref); // generation fence happens here
    this.stopSampling();
    const token = ++this.samplingToken;
    this.sampling = {
      ref,
      intervalMs: this.normalizeInterval(intervalMs),
      maxFrames: this.clampMaxFrames(maxFrames),
      generation: ref.sessionGeneration,
      token,
      timer: null,
      frames: new Map(),
      dropped: 0,
      stopped: false,
    };
    if (this.sampleSink) {
      // Ride the UI Timeline's high-rate adapter sampler (plan Task 10).
      this.sampleSink.addConsumer({
        key: 'timeline',
        session,
        channels: this.timelineExpressions().map(expression => ({ channelId: expression, expression })),
        shared: [],
        onPoints: points => this.ingestTimeline(points),
      });
    } else {
      this.scheduleNext();
    }
    this.publish('timeline.changed', { sampling: true });
    return this.timelineSnapshot(true);
  }

  /** `orbit.timeline.stop`: halt the API sampling loop. */
  async stopTimeline(_ref: SessionRef): Promise<TimelineSnapshot> {
    this.stopSampling();
    this.publish('timeline.changed', { sampling: false });
    return this.timelineSnapshot(true);
  }

  /** `orbit.timeline.status`: current sampling state. */
  async timelineStatus(_ref: SessionRef): Promise<TimelineSnapshot> {
    return this.timelineSnapshot(true);
  }

  get timelineEntries(): ReadonlyArray<TimelineEntry> {
    return this.timeline.map(entry => ({ ...entry }));
  }

  dispose(): void {
    this.stopSampling();
  }

  // --- internals -----------------------------------------------------------

  private timelineExpressions(): string[] {
    return this.timeline.map(entry => entry.expression);
  }

  /** Best-effort value read through the current session; never falls back locally. */
  private async readWatchValues(ref?: SessionRef): Promise<ExpressionValue[]> {
    const target = ref ?? this.registry.currentRef();
    if (!target) return [];
    const signals: SignalSpec[] = this.watchExpressions.map(expression => ({
      alias: expression,
      expression,
    }));
    try {
      const reads = await this.runtime.readSignals(signals, target);
      return reads.map(toExpressionValue);
    } catch {
      return [];
    }
  }

  private scheduleNext(): void {
    const active = this.sampling;
    if (!active || active.stopped) return;
    active.timer = setTimeout(() => void this.sampleLoop(active), active.intervalMs);
  }

  private async sampleLoop(active: ActiveSampling): Promise<void> {
    if (active.stopped || active.token !== this.samplingToken) return;
    const timestamp = this.nowFn();
    const signals: SignalSpec[] = this.timelineExpressions().map(expression => ({
      alias: expression,
      expression,
    }));
    if (signals.length > 0) {
      try {
        const reads = await this.runtime.readSignals(signals, active.ref);
        for (const read of reads) {
          this.appendPoint(active, timestamp, read);
        }
      } catch {
        // A generation fence or a lost session must stop sampling rather than
        // publish stale samples under a newer session (§2.3).
        this.stopSampling();
        return;
      }
    }
    if (active.token === this.samplingToken && !active.stopped) this.scheduleNext();
  }

  private appendPoint(active: ActiveSampling, timestamp: number, read: RuntimeReadValue): void {
    if (read.error) return;
    if (typeof read.value !== 'number' || !Number.isFinite(read.value)) return;
    const points = active.frames.get(read.expression) ?? [];
    points.push({ timestamp, value: read.value });
    const overflow = points.length - active.maxFrames;
    if (overflow > 0) {
      points.splice(0, overflow);
      active.dropped += overflow;
    }
    active.frames.set(read.expression, points);
  }

  private stopSampling(): void {
    const active = this.sampling;
    if (active) {
      if (active.timer) {
        clearTimeout(active.timer);
        active.timer = null;
      }
      active.stopped = true;
    }
    this.sampling = null;
    this.sampleSink?.removeConsumer('timeline');
  }

  /** Appends high-rate sink points into the timeline frame buffers (fast path). */
  private ingestTimeline(points: ReleasedSample[]): void {
    const active = this.sampling;
    if (!active || active.stopped) return;
    for (const point of points) {
      const list = active.frames.get(point.expression) ?? [];
      list.push({ timestamp: point.timestamp, value: point.value });
      const overflow = list.length - active.maxFrames;
      if (overflow > 0) {
        list.splice(0, overflow);
        active.dropped += overflow;
      }
      active.frames.set(point.expression, list);
    }
  }

  private publish(type: string, data?: Record<string, unknown>): void {
    const hub = this.eventHub;
    if (!hub || hub.isDisposed()) return;
    try {
      hub.publish(type, { data });
    } catch {
      // A disposed hub must not break a view mutation.
    }
  }

  // --- normalization ---------------------------------------------------------

  private normalizeWatchList(input: string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const raw of input) {
      const normalized = normalizeAutomationExpression(raw);
      if (!normalized.ok || seen.has(normalized.expression)) continue;
      seen.add(normalized.expression);
      result.push(normalized.expression);
      if (result.length >= WATCH_LIMIT) break;
    }
    return result;
  }

  private normalizeTimelineList(input: string[]): TimelineEntry[] {
    const seen = new Set<string>();
    const entries: TimelineEntry[] = [];
    for (const raw of input) {
      const normalized = normalizeAutomationExpression(raw);
      if (!normalized.ok || seen.has(normalized.expression)) continue;
      seen.add(normalized.expression);
      entries.push({ expression: normalized.expression, enabled: true });
      if (entries.length >= TIMELINE_LIMIT) break;
    }
    return entries;
  }

  private serializeTimeline(entries: TimelineEntry[]): (string | TimelineEntry)[] {
    return entries.map(entry => (entry.color ? { ...entry } : entry.expression));
  }

  private hydrate(): void {
    const savedWatch = this.store.get<unknown>(WATCH_EXPRESSIONS_KEY, []);
    this.watchExpressions = Array.isArray(savedWatch)
      ? this.normalizeWatchList(savedWatch as string[])
      : [];

    const savedTimeline = this.store.get<unknown[]>(TIMELINE_EXPRESSIONS_KEY, []);
    const entries: TimelineEntry[] = [];
    if (Array.isArray(savedTimeline)) {
      for (const raw of savedTimeline) {
        const expression = typeof raw === 'string'
          ? raw
          : (raw && typeof raw === 'object' && typeof (raw as { expression?: unknown }).expression === 'string'
              ? (raw as { expression: string }).expression
              : '');
        const normalized = normalizeAutomationExpression(expression);
        if (!normalized.ok || entries.some(entry => entry.expression === normalized.expression)) continue;
        const entry: TimelineEntry = { expression: normalized.expression };
        if (raw && typeof raw === 'object') {
          const color = (raw as { color?: unknown }).color;
          const enabled = (raw as { enabled?: unknown }).enabled;
          if (typeof color === 'string') entry.color = color;
          entry.enabled = typeof enabled === 'boolean' ? enabled : true;
        } else {
          entry.enabled = true;
        }
        entries.push(entry);
        if (entries.length >= TIMELINE_LIMIT) break;
      }
    }
    this.timeline = entries;
  }

  private normalizeInterval(intervalMs: number): number {
    if (!Number.isFinite(intervalMs)) throw new AutomationError('InvalidRequest', 'intervalMs must be finite', false);
    return Math.max(MIN_INTERVAL_MS, Math.min(MAX_INTERVAL_MS, Math.floor(intervalMs)));
  }

  private clampMaxFrames(maxFrames: number | undefined): number {
    if (maxFrames === undefined || !Number.isFinite(maxFrames)) return MAX_FRAMES;
    return Math.max(1, Math.min(Math.floor(maxFrames), MAX_FRAMES));
  }

  private nullStore(): ViewStateStore {
    return {
      get: (_key, defaultValue) => defaultValue,
      update: () => Promise.resolve(),
    };
  }
}