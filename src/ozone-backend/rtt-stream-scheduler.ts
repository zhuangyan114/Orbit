import {
  NativeScheduler,
  NativeTaskPriority,
} from './native-scheduler';
import {
  RttChannelDescriptor,
  RttChannelRegistry,
  RttStreamConsumer,
} from './rtt-channel-registry';
import {
  RttBoundedByteQueue,
  RttFrameDiagnosticsDelta,
  RttStreamDiagnostics,
  RttStreamMetricsSnapshot,
} from './rtt-stream-diagnostics';
import {
  RttReadResult,
  RttTransport,
  RttTransportError,
  RttTransportErrorCategory,
  RttTransportResult,
  rttFailure,
  rttSuccess,
} from './rtt-transport';

export interface RttStreamConsumerPolicy {
  readonly maxPendingReads: number;
  readonly maxBytesPerSecond?: number;
}

export interface RttStreamSchedulerOptions {
  readonly policies?: Partial<Record<RttStreamConsumer, Partial<RttStreamConsumerPolicy>>>;
  readonly clock?: () => number;
}

export interface RttStreamReadRequest {
  readonly consumer: RttStreamConsumer;
  readonly channelIndex: number;
  readonly size?: number;
  readonly signal?: AbortSignal;
  readonly coalesceKey?: string;
}

export interface RttStreamReadResult {
  readonly read: RttReadResult;
  readonly acceptedBytes: number;
  readonly droppedBytes: number;
  readonly queueDepthBytes: number;
  readonly metrics: RttStreamMetricsSnapshot;
}

export interface RttBufferedReadResult {
  readonly consumer: RttStreamConsumer;
  readonly channelIndex: number;
  readonly bytes: Uint8Array;
  readonly empty: boolean;
  readonly maxDelayMs: number;
  readonly queueDepthBytes: number;
  readonly metrics: RttStreamMetricsSnapshot;
}

interface PendingRead {
  readonly id: number;
  readonly consumer: RttStreamConsumer;
  readonly controller: AbortController;
  readonly state: StreamState;
  readonly signal?: AbortSignal;
  readonly signalListener?: () => void;
}

interface StreamState {
  readonly consumer: RttStreamConsumer;
  readonly channelIndex: number;
  readonly queue: RttBoundedByteQueue;
  readonly diagnostics: RttStreamDiagnostics;
}

interface QuotaState {
  windowStartedAt: number;
  bytesReserved: number;
}

const DEFAULT_POLICIES: Record<RttStreamConsumer, RttStreamConsumerPolicy> = {
  // These are host-side safety ceilings, not target sampling-rate claims.
  watch: { maxPendingReads: 2, maxBytesPerSecond: 64 * 1024 },
  // A 4096-byte Timeline read at the DAP 10ms floor can reserve up to
  // 409.6 KiB/s even when the target returns empty. Keep the reservation
  // semantics shared with RTT/Legacy, but leave enough headroom for this
  // supported polling configuration.
  timeline: { maxPendingReads: 4, maxBytesPerSecond: 512 * 1024 },
  rtt: { maxPendingReads: 4, maxBytesPerSecond: 512 * 1024 },
};

/**
 * Schedules RTT stream reads through the existing NativeScheduler.
 *
 * `NativeScheduler` remains the owner serializer and therefore keeps
 * `control > watch > timeline`; RTT and Timeline stream reads share the
 * `timeline` lane, while Watch remains above both. This class adds per-stream
 * quotas, cancellation/pause, host-side bounded queues, and diagnostics.
 */
export class RttStreamScheduler {
  private readonly policies: Record<RttStreamConsumer, RttStreamConsumerPolicy>;
  private readonly clock: () => number;
  private readonly streams = new Map<string, StreamState>();
  private readonly pending = new Map<number, PendingRead>();
  private readonly pendingByConsumer: Record<RttStreamConsumer, number> = {
    watch: 0,
    timeline: 0,
    rtt: 0,
  };
  private readonly pauseCounts: Record<RttStreamConsumer, number> = {
    watch: 0,
    timeline: 0,
    rtt: 0,
  };
  private readonly quota = new Map<RttStreamConsumer, QuotaState>();
  private readonly removeOwnerLossListener: () => void;
  private ownerLoss: RttTransportError | null = null;
  private nextId = 1;
  private disposed = false;

  constructor(
    private readonly transport: RttTransport,
    private readonly registry: RttChannelRegistry,
    private readonly nativeScheduler: NativeScheduler,
    options: RttStreamSchedulerOptions = {},
  ) {
    this.clock = options.clock || (() => Date.now());
    this.policies = {
      watch: { ...DEFAULT_POLICIES.watch, ...(options.policies?.watch || {}) },
      timeline: { ...DEFAULT_POLICIES.timeline, ...(options.policies?.timeline || {}) },
      rtt: { ...DEFAULT_POLICIES.rtt, ...(options.policies?.rtt || {}) },
    };
    for (const policy of Object.values(this.policies)) {
      if (!Number.isInteger(policy.maxPendingReads) || policy.maxPendingReads <= 0) {
        throw new Error(`RTT maxPendingReads must be positive: ${policy.maxPendingReads}`);
      }
      if (policy.maxBytesPerSecond !== undefined
        && (!Number.isFinite(policy.maxBytesPerSecond) || policy.maxBytesPerSecond <= 0)) {
        throw new Error(`RTT maxBytesPerSecond must be positive: ${policy.maxBytesPerSecond}`);
      }
    }
    this.removeOwnerLossListener = transport.onOwnerLoss(error => this.handleOwnerLoss(error));
  }

  async scheduleRead(request: RttStreamReadRequest): Promise<RttTransportResult<RttStreamReadResult>> {
    if (this.disposed) return this.failure('Cancelled', 'RTT stream scheduler is disposed', 'cancelled');
    if (this.ownerLoss) return rttFailure(this.ownerLoss);
    if (this.transport.state === 'disconnected') {
      return this.failure('NotConnected', 'RTT owner is disconnected', 'connection');
    }
    const descriptor = this.registry.get(request.channelIndex);
    if (!descriptor) {
      return this.failure('ChannelGone', `RTT channel ${request.channelIndex} is not registered`, 'channel');
    }
    if (!descriptor.consumers.includes(request.consumer)) {
      return this.failure('Unsupported', `RTT channel ${request.channelIndex} is not assigned to ${request.consumer}`, 'protocol');
    }
    const size = request.size ?? descriptor.buffer.targetSizeBytes;
    if (!Number.isInteger(size) || size <= 0) {
      return this.failure('InvalidArgument', `RTT read size must be positive: ${size}`, 'protocol');
    }
    if (this.transport.capabilities.maxReadSize !== undefined && size > this.transport.capabilities.maxReadSize) {
      return this.failure('InvalidArgument', `RTT read size exceeds owner limit ${this.transport.capabilities.maxReadSize}`, 'protocol', {
        size,
        maxReadSize: this.transport.capabilities.maxReadSize,
      });
    }
    if (request.signal?.aborted) {
      return this.failure('Cancelled', 'RTT stream read was cancelled before enqueue', 'cancelled');
    }
    if (this.pauseCounts[request.consumer] > 0) {
      return this.failure('Cancelled', `${request.consumer} RTT stream is paused`, 'cancelled', { paused: true });
    }

    const policy = this.policies[request.consumer];
    if (this.pendingByConsumer[request.consumer] >= policy.maxPendingReads) {
      return this.failure('QueueFull', `${request.consumer} RTT read quota is full`, 'queue', {
        consumer: request.consumer,
        maxPendingReads: policy.maxPendingReads,
      });
    }
    if (!this.reserveQuota(request.consumer, size)) {
      return this.failure('QuotaExceeded', `${request.consumer} RTT byte quota is exhausted`, 'queue', {
        consumer: request.consumer,
        maxBytesPerSecond: policy.maxBytesPerSecond,
        requestedBytes: size,
      });
    }

    const state = this.getStreamState(descriptor, request.consumer);
    const controller = new AbortController();
    const signalListener = request.signal ? () => controller.abort() : undefined;
    if (request.signal && signalListener) request.signal.addEventListener('abort', signalListener, { once: true });
    const pending: PendingRead = {
      id: this.nextId++,
      consumer: request.consumer,
      controller,
      state,
      ...(request.signal ? { signal: request.signal } : {}),
      ...(signalListener ? { signalListener } : {}),
    };
    this.pending.set(pending.id, pending);
    this.pendingByConsumer[request.consumer]++;

    const scheduled = this.nativeScheduler.schedule(
      () => this.performRead(pending, request.channelIndex, size),
      {
        priority: priorityForConsumer(request.consumer),
        signal: controller.signal,
        coalesceKey: request.coalesceKey,
        label: `${request.consumer}:rtt:${request.channelIndex}`,
      },
    );
    return scheduled
      .catch(error => {
        this.releaseQuota(pending.consumer, size);
        state.diagnostics.recordCancelled();
        if (this.ownerLoss) return rttFailure(this.ownerLoss);
        return this.failure<RttStreamReadResult>(
          'Cancelled',
          error instanceof Error ? error.message : 'RTT stream read was cancelled',
          'cancelled',
        );
      })
      .finally(() => this.cleanupPending(pending));
  }

  /** Cancels queued and cooperative in-flight reads for one consumer. */
  cancel(consumer: RttStreamConsumer, reason = `${consumer} RTT stream cancelled`): number {
    let cancelled = 0;
    for (const pending of this.pending.values()) {
      if (pending.consumer !== consumer) continue;
      pending.controller.abort(reason);
      cancelled++;
    }
    return cancelled;
  }

  /** Pausing drops outstanding stream work; resume permits new work. */
  pause(consumer: RttStreamConsumer): () => void {
    this.pauseCounts[consumer]++;
    this.cancel(consumer, `${consumer} RTT stream paused`);
    let resumed = false;
    return () => {
      if (resumed) return;
      resumed = true;
      this.pauseCounts[consumer] = Math.max(0, this.pauseCounts[consumer] - 1);
    };
  }

  readBuffered(
    consumer: RttStreamConsumer,
    channelIndex: number,
    maxBytes: number,
  ): RttTransportResult<RttBufferedReadResult> {
    const descriptor = this.registry.get(channelIndex);
    if (!descriptor) return this.failure('ChannelGone', `RTT channel ${channelIndex} is not registered`, 'channel');
    if (!descriptor.consumers.includes(consumer)) {
      return this.failure('Unsupported', `RTT channel ${channelIndex} is not assigned to ${consumer}`, 'protocol');
    }
    const state = this.getStreamState(descriptor, consumer);
    const result = state.queue.read(maxBytes, this.clock());
    state.diagnostics.recordQueue(state.queue.depthBytes, state.queue.depthChunks);
    state.diagnostics.recordDelay(result.maxDelayMs);
    return rttSuccess({
      consumer,
      channelIndex,
      bytes: result.bytes,
      empty: result.bytes.length === 0,
      maxDelayMs: result.maxDelayMs,
      queueDepthBytes: result.depthBytes,
      metrics: state.diagnostics.snapshot(this.clock()),
    });
  }

  metrics(consumer: RttStreamConsumer, channelIndex: number): RttStreamMetricsSnapshot | undefined {
    return this.streams.get(streamKey(consumer, channelIndex))?.diagnostics.snapshot(this.clock());
  }

  /** Records decoder-side metrics without opening another target read path. */
  recordFrameDecode(
    consumer: RttStreamConsumer,
    channelIndex: number,
    delta: RttFrameDiagnosticsDelta,
  ): RttStreamMetricsSnapshot | undefined {
    const state = this.streams.get(streamKey(consumer, channelIndex));
    if (!state) return undefined;
    state.diagnostics.recordFrameDecode(delta);
    return state.diagnostics.snapshot(this.clock());
  }

  recordConsumerError(
    consumer: RttStreamConsumer,
    channelIndex: number,
    message: string,
  ): RttStreamMetricsSnapshot | undefined {
    const state = this.streams.get(streamKey(consumer, channelIndex));
    if (!state) return undefined;
    state.diagnostics.recordError(message);
    return state.diagnostics.snapshot(this.clock());
  }

  allMetrics(): readonly RttStreamMetricsSnapshot[] {
    return [...this.streams.values()].map(state => state.diagnostics.snapshot(this.clock()));
  }

  pendingCount(consumer?: RttStreamConsumer): number {
    return consumer === undefined
      ? this.pending.size
      : this.pendingByConsumer[consumer];
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.removeOwnerLossListener();
    for (const consumer of ['watch', 'timeline', 'rtt'] as const) this.cancel(consumer, 'RTT stream scheduler disposed');
    for (const state of this.streams.values()) state.queue.clear();
  }

  private async performRead(
    pending: PendingRead,
    channelIndex: number,
    size: number,
  ): Promise<RttTransportResult<RttStreamReadResult>> {
    if (this.ownerLoss) return rttFailure(this.ownerLoss);
    if (pending.controller.signal.aborted || this.pauseCounts[pending.consumer] > 0) {
      pending.state.diagnostics.recordCancelled();
      return this.failure('Cancelled', `${pending.consumer} RTT stream read was cancelled`, 'cancelled');
    }

    const read = await this.transport.read({
      channelIndex,
      size,
      signal: pending.controller.signal,
      scheduledByOwnerScheduler: true,
    });
    if (this.ownerLoss) return rttFailure(this.ownerLoss);
    if (!read.ok) {
      this.releaseQuota(pending.consumer, size);
      if (read.error.code === 'Cancelled') pending.state.diagnostics.recordCancelled();
      pending.state.diagnostics.recordError(read.error.message);
      return read;
    }
    pending.state.diagnostics.recordRead(read.data.bytes.length, read.data.empty);
    if (pending.controller.signal.aborted) {
      pending.state.diagnostics.recordCancelled();
      return this.failure('Cancelled', `${pending.consumer} RTT stream read was cancelled after dispatch`, 'cancelled');
    }

    const pushed = pending.state.queue.push(read.data.bytes, this.clock());
    pending.state.diagnostics.recordDrop(pushed.droppedBytes, pushed.droppedChunks);
    pending.state.diagnostics.recordQueue(pending.state.queue.depthBytes, pending.state.queue.depthChunks);
    return rttSuccess({
      read: read.data,
      acceptedBytes: pushed.acceptedBytes,
      droppedBytes: pushed.droppedBytes,
      queueDepthBytes: pushed.depthBytes,
      metrics: pending.state.diagnostics.snapshot(this.clock()),
    });
  }

  private getStreamState(descriptor: RttChannelDescriptor, consumer: RttStreamConsumer): StreamState {
    const key = streamKey(consumer, descriptor.index);
    const existing = this.streams.get(key);
    if (existing) return existing;
    const state: StreamState = {
      consumer,
      channelIndex: descriptor.index,
      queue: new RttBoundedByteQueue(descriptor.buffer.hostQueueCapacityBytes, this.clock),
      diagnostics: new RttStreamDiagnostics(consumer, descriptor.index, this.clock),
    };
    this.streams.set(key, state);
    return state;
  }

  private reserveQuota(consumer: RttStreamConsumer, bytes: number): boolean {
    const maxBytesPerSecond = this.policies[consumer].maxBytesPerSecond;
    if (maxBytesPerSecond === undefined) return true;
    const now = this.clock();
    let state = this.quota.get(consumer);
    if (!state || now - state.windowStartedAt >= 1000) {
      state = { windowStartedAt: now, bytesReserved: 0 };
      this.quota.set(consumer, state);
    }
    if (state.bytesReserved + bytes > maxBytesPerSecond) return false;
    state.bytesReserved += bytes;
    return true;
  }

  private releaseQuota(consumer: RttStreamConsumer, bytes: number) {
    const state = this.quota.get(consumer);
    if (!state || this.clock() - state.windowStartedAt >= 1000) return;
    state.bytesReserved = Math.max(0, state.bytesReserved - bytes);
  }

  private cleanupPending(pending: PendingRead) {
    this.pending.delete(pending.id);
    this.pendingByConsumer[pending.consumer] = Math.max(0, this.pendingByConsumer[pending.consumer] - 1);
    if (pending.signal && pending.signalListener) {
      pending.signal.removeEventListener('abort', pending.signalListener);
    }
  }

  private handleOwnerLoss(error: RttTransportError) {
    if (this.ownerLoss) return;
    this.ownerLoss = error;
    for (const state of this.streams.values()) state.diagnostics.recordError(error.message);
    for (const consumer of ['watch', 'timeline', 'rtt'] as const) {
      this.cancel(consumer, error.message);
    }
  }

  private failure<T>(
    code: RttTransportError['code'],
    message: string,
    category: RttTransportErrorCategory,
    diagnostics: Readonly<Record<string, unknown>> = {},
  ): RttTransportResult<T> {
    return rttFailure(new RttTransportError(code, message, category, diagnostics));
  }
}

function priorityForConsumer(consumer: RttStreamConsumer): Extract<NativeTaskPriority, 'watch' | 'timeline'> {
  return consumer === 'watch' ? 'watch' : 'timeline';
}

function streamKey(consumer: RttStreamConsumer, channelIndex: number): string {
  return `${consumer}:${channelIndex}`;
}
