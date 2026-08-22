// Orbit Automation API v1 — high-rate sampling sink (plan Task 10).
//
// The UI Timeline and the API resolve recordings both want the adapter's
// dedicated continuous sampler (`dataSamplingStart` -> `readFastDataSampling`
// -> batched `ozoneDataSamples`), which runs at several hundred Hz to kHz.
// Only ONE such sampler can run per session, so this sink is a multi-consumer
// coordinator: every consumer (the API Timeline, each recording, and optionally
// the live UI expressions) registers the expressions it wants, and the sink
// starts a single adapter sampler over their union and fans the high-rate points
// back to each consumer it owns. `shared` expressions are sampled to keep their
// stream alive but are never re-relayed (their own consumers consume ozoneSamples
// directly via the adapter).
import * as vscode from 'vscode';
import { DataSampleSnapshot } from '../ozone-backend/types';

/** A single high-rate sample released to a consumer. */
export interface ReleasedSample {
  channelId: string;
  expression: string;
  timestamp: number;
  value: number;
}

export interface FastSampleConsumer {
  /** Stable identity (e.g. 'timeline', 'recording'). */
  key: string;
  session: vscode.DebugSession;
  /** Expressions this consumer turns into frames. */
  channels: Array<{ channelId: string; expression: string }>;
  /** Expressions that must keep sampling but are not relayed to this consumer. */
  shared: Array<{ expression: string; color: string }>;
  onPoints: (points: ReleasedSample[]) => void;
}

export interface FastSampleSinkOptions {
  /** Target sample cadence in ms; 0.2 matches the UI Timeline fast sampler. */
  sampleIntervalMs?: number;
  /** Adapter flush cadence in ms; default 16. */
  sendIntervalMs?: number;
  /**
   * Expressions the UI Timeline owns and must stay sampled even when no API
   * consumer is active. When non-empty, the sink never issues `dataSamplingStop`
   * after removing the last API consumer — it re-primes the adapter sampler with
   * these expressions instead, so the UI Timeline keeps moving (plan Task 10).
   */
  persistentExpressions?: () => string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export class FastSampleSink implements vscode.Disposable {
  private readonly sampleIntervalMs: number;
  private readonly sendIntervalMs: number;
  private readonly persistentExpressions?: () => string[];
  private readonly consumers = new Map<string, FastSampleConsumer>();
  private activeSession: vscode.DebugSession | null = null;
  private subscription: vscode.Disposable | null = null;
  private gen = 0;

  constructor(options: FastSampleSinkOptions = {}) {
    this.sampleIntervalMs = options.sampleIntervalMs ?? 0.2;
    this.sendIntervalMs = options.sendIntervalMs ?? 16;
    this.persistentExpressions = options.persistentExpressions;
  }

  get consumerCount(): number {
    return this.consumers.size;
  }

  /** Registers (or replaces) a consumer and reconciles the shared adapter sampler. */
  addConsumer(consumer: FastSampleConsumer): void {
    this.consumers.set(consumer.key, consumer);
    const session = consumer.session;
    this.activeSession = session; // a session is the union group
    void this.sync(session);
  }

  /** Removes a consumer and reconfigures the sampler (stops it when empty). */
  removeConsumer(key: string): void {
    const removed = this.consumers.get(key);
    this.consumers.delete(key);
    const session = removed?.session ?? this.activeSession;
    if (session) void this.sync(session);
  }

  async dispose(): Promise<void> {
    await this.stopSampler();
    this.consumers.clear();
    this.activeSession = null;
  }

  // --- internals -------------------------------------------------------------

  private async sync(session: vscode.DebugSession): Promise<void> {
    const gen = ++this.gen;
    const seen = new Set<string>();
    const entries: Array<{ expression: string; color: string }> = [];
    const push = (expression: string, color: string) => {
      if (!expression || seen.has(expression)) return;
      seen.add(expression);
      entries.push({ expression, color });
    };
    for (const consumer of this.consumers.values()) {
      for (const channel of consumer.channels) push(channel.expression, '#4EC9B0');
      for (const shared of consumer.shared) push(shared.expression, shared.color);
    }
    // The UI Timeline's expressions stay sampled even when the last API consumer
    // leaves, so removing a consumer hands the sampler back instead of stopping
    // the UI's own stream.
    for (const expression of this.persistentExpressions?.() ?? []) push(expression, '#4EC9B0');
    if (entries.length === 0) {
      await this.stopSampler();
      return;
    }
    await this.startSampler(session, entries, gen);
  }

  private async startSampler(session: vscode.DebugSession, entries: Array<{ expression: string; color: string }>, gen: number): Promise<void> {
    await this.stopSampler();
    if (gen !== this.gen) return;
    if (entries.length === 0) {
      this.activeSession = null;
      return;
    }
    try {
      const response: unknown = await session.customRequest('dataSamplingStart', {
        entries,
        sampleIntervalMs: this.sampleIntervalMs,
        sendIntervalMs: this.sendIntervalMs,
      });
      if (isRecord(response) && response.ok === false) {
        return; // adapter rejected; leave sampler off
      }
    } catch {
      return;
    }
    if (gen !== this.gen) return;
    this.activeSession = session;
    this.subscription = vscode.debug.onDidReceiveDebugSessionCustomEvent(event => {
      if (event.session !== session || event.event !== 'ozoneDataSamples') return;
      this.ingest(session, event.body);
    });
  }

  private async stopSampler(): Promise<void> {
    if (this.subscription) {
      this.subscription.dispose();
      this.subscription = null;
    }
    const session = this.activeSession;
    this.activeSession = null;
    if (!session) return;
    try {
      await session.customRequest('dataSamplingStop', {});
    } catch {
      // Adapter may already be gone.
    }
  }

  private ingest(session: vscode.DebugSession, body: unknown): void {
    if (!isRecord(body)) return;
    const snapshots = Array.isArray(body.snapshots) ? body.snapshots : [];
    for (const consumer of this.consumers.values()) {
      if (consumer.session !== session) continue;
      const channelByExpression = new Map(consumer.channels.map(ch => [ch.expression, ch.channelId]));
      if (channelByExpression.size === 0) continue;
      const points: ReleasedSample[] = [];
      for (const raw of snapshots) {
        const snapshot = raw as Partial<DataSampleSnapshot>;
        const expression = typeof snapshot.expression === 'string' ? snapshot.expression : '';
        const channelId = channelByExpression.get(expression);
        if (channelId === undefined) continue;
        const data = snapshot.data;
        if (!Array.isArray(data)) continue;
        for (const point of data) {
          if (typeof point.value !== 'number' || !Number.isFinite(point.value)) continue;
          points.push({ channelId, expression, timestamp: point.timestamp, value: point.value });
        }
      }
      if (points.length > 0) consumer.onPoints(points);
    }
  }
}