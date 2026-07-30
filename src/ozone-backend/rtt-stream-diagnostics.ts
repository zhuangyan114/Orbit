import { RttStreamConsumer } from './rtt-channel-registry';

export interface RttQueuePushResult {
  readonly acceptedBytes: number;
  readonly droppedBytes: number;
  readonly droppedChunks: number;
  readonly depthBytes: number;
}

export interface RttQueueReadResult {
  readonly bytes: Uint8Array;
  readonly maxDelayMs: number;
  readonly depthBytes: number;
}

export interface RttFrameDiagnosticsDelta {
  readonly decodedFrames?: number;
  readonly decodeErrors?: number;
  readonly checksumErrors?: number;
  readonly sequenceGaps?: number;
  readonly missingFrames?: number;
  readonly truncatedFrames?: number;
  readonly decodeLatencyMs?: number;
}

interface QueuedChunk {
  bytes: Uint8Array;
  offset: number;
  enqueuedAt: number;
}

/** A byte-bounded FIFO. Overflow drops the oldest complete data first. */
export class RttBoundedByteQueue {
  private readonly chunks: QueuedChunk[] = [];
  private depth = 0;

  constructor(
    readonly capacityBytes: number,
    private readonly clock: () => number = () => Date.now(),
  ) {
    if (!Number.isInteger(capacityBytes) || capacityBytes <= 0) {
      throw new Error(`RTT queue capacity must be positive: ${capacityBytes}`);
    }
  }

  get depthBytes(): number { return this.depth; }
  get depthChunks(): number { return this.chunks.length; }

  push(bytes: Uint8Array, enqueuedAt = this.clock()): RttQueuePushResult {
    if (bytes.length === 0) {
      return { acceptedBytes: 0, droppedBytes: 0, droppedChunks: 0, depthBytes: this.depth };
    }
    if (bytes.length > this.capacityBytes) {
      return {
        acceptedBytes: 0,
        droppedBytes: bytes.length,
        droppedChunks: 1,
        depthBytes: this.depth,
      };
    }

    let droppedBytes = 0;
    let droppedChunks = 0;
    while (this.depth + bytes.length > this.capacityBytes) {
      const oldest = this.chunks.shift();
      if (!oldest) break;
      const remaining = oldest.bytes.length - oldest.offset;
      this.depth -= remaining;
      droppedBytes += remaining;
      droppedChunks++;
    }

    const copy = new Uint8Array(bytes);
    this.chunks.push({ bytes: copy, offset: 0, enqueuedAt });
    this.depth += copy.length;
    return { acceptedBytes: copy.length, droppedBytes, droppedChunks, depthBytes: this.depth };
  }

  read(maxBytes: number, readAt = this.clock()): RttQueueReadResult {
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
      return { bytes: new Uint8Array(), maxDelayMs: 0, depthBytes: this.depth };
    }

    const output = new Uint8Array(Math.min(maxBytes, this.depth));
    let written = 0;
    let maxDelayMs = 0;
    while (written < output.length) {
      const oldest = this.chunks[0];
      if (!oldest) break;
      const available = oldest.bytes.length - oldest.offset;
      const take = Math.min(available, output.length - written);
      output.set(oldest.bytes.subarray(oldest.offset, oldest.offset + take), written);
      oldest.offset += take;
      written += take;
      this.depth -= take;
      maxDelayMs = Math.max(maxDelayMs, Math.max(0, readAt - oldest.enqueuedAt));
      if (oldest.offset === oldest.bytes.length) this.chunks.shift();
    }
    return { bytes: output.subarray(0, written), maxDelayMs, depthBytes: this.depth };
  }

  clear(): number {
    const removed = this.depth;
    this.chunks.length = 0;
    this.depth = 0;
    return removed;
  }
}

export interface RttStreamMetricsSnapshot {
  readonly consumer: RttStreamConsumer;
  readonly channelIndex: number;
  readonly bytesRead: number;
  readonly readCalls: number;
  readonly emptyReads: number;
  readonly bytesPerSecond: number;
  readonly readCallsPerSecond: number;
  readonly emptyReadRate: number;
  readonly droppedBytes: number;
  readonly droppedChunks: number;
  readonly queueDepthBytes: number;
  readonly queueDepthChunks: number;
  readonly maxQueueDepthBytes: number;
  readonly maxDelayMs: number;
  readonly cancelledReads: number;
  readonly errorCount: number;
  readonly lastError?: string;
  readonly decodedFrames: number;
  readonly decodeErrors: number;
  readonly checksumErrors: number;
  readonly sequenceGaps: number;
  readonly missingFrames: number;
  readonly truncatedFrames: number;
  readonly averageDecodeLatencyMs: number;
  readonly maxDecodeLatencyMs: number;
}

/** Lifetime counters for one channel/consumer stream. */
export class RttStreamDiagnostics {
  private readonly startedAt: number;
  private bytesRead = 0;
  private readCalls = 0;
  private emptyReads = 0;
  private droppedBytes = 0;
  private droppedChunks = 0;
  private queueDepthBytes = 0;
  private queueDepthChunks = 0;
  private maxQueueDepthBytes = 0;
  private maxDelayMs = 0;
  private cancelledReads = 0;
  private errorCount = 0;
  private lastError: string | undefined;
  private decodedFrames = 0;
  private decodeErrors = 0;
  private checksumErrors = 0;
  private sequenceGaps = 0;
  private missingFrames = 0;
  private truncatedFrames = 0;
  private decodeLatencyTotalMs = 0;
  private decodeLatencySamples = 0;
  private maxDecodeLatencyMs = 0;

  constructor(
    readonly consumer: RttStreamConsumer,
    readonly channelIndex: number,
    private readonly clock: () => number = () => Date.now(),
  ) {
    this.startedAt = this.clock();
  }

  recordRead(bytes: number, empty: boolean) {
    this.readCalls++;
    this.bytesRead += Math.max(0, bytes);
    if (empty) this.emptyReads++;
  }

  recordDrop(bytes: number, chunks: number) {
    this.droppedBytes += Math.max(0, bytes);
    this.droppedChunks += Math.max(0, chunks);
  }

  recordQueue(depthBytes: number, depthChunks: number) {
    this.queueDepthBytes = Math.max(0, depthBytes);
    this.queueDepthChunks = Math.max(0, depthChunks);
    this.maxQueueDepthBytes = Math.max(this.maxQueueDepthBytes, this.queueDepthBytes);
  }

  recordDelay(delayMs: number) {
    this.maxDelayMs = Math.max(this.maxDelayMs, Math.max(0, delayMs));
  }

  recordCancelled() { this.cancelledReads++; }

  recordError(message: string) {
    this.errorCount++;
    this.lastError = message;
  }

  recordFrameDecode(delta: RttFrameDiagnosticsDelta) {
    this.decodedFrames += Math.max(0, delta.decodedFrames || 0);
    this.decodeErrors += Math.max(0, delta.decodeErrors || 0);
    this.checksumErrors += Math.max(0, delta.checksumErrors || 0);
    this.sequenceGaps += Math.max(0, delta.sequenceGaps || 0);
    this.missingFrames += Math.max(0, delta.missingFrames || 0);
    this.truncatedFrames += Math.max(0, delta.truncatedFrames || 0);
    if (delta.decodeLatencyMs !== undefined && Number.isFinite(delta.decodeLatencyMs)) {
      const latency = Math.max(0, delta.decodeLatencyMs);
      this.decodeLatencyTotalMs += latency;
      this.decodeLatencySamples++;
      this.maxDecodeLatencyMs = Math.max(this.maxDecodeLatencyMs, latency);
    }
  }

  snapshot(now = this.clock()): RttStreamMetricsSnapshot {
    const elapsedSeconds = Math.max((now - this.startedAt) / 1000, 0.001);
    return {
      consumer: this.consumer,
      channelIndex: this.channelIndex,
      bytesRead: this.bytesRead,
      readCalls: this.readCalls,
      emptyReads: this.emptyReads,
      bytesPerSecond: this.bytesRead / elapsedSeconds,
      readCallsPerSecond: this.readCalls / elapsedSeconds,
      emptyReadRate: this.readCalls === 0 ? 0 : this.emptyReads / this.readCalls,
      droppedBytes: this.droppedBytes,
      droppedChunks: this.droppedChunks,
      queueDepthBytes: this.queueDepthBytes,
      queueDepthChunks: this.queueDepthChunks,
      maxQueueDepthBytes: this.maxQueueDepthBytes,
      maxDelayMs: this.maxDelayMs,
      cancelledReads: this.cancelledReads,
      errorCount: this.errorCount,
      ...(this.lastError ? { lastError: this.lastError } : {}),
      decodedFrames: this.decodedFrames,
      decodeErrors: this.decodeErrors,
      checksumErrors: this.checksumErrors,
      sequenceGaps: this.sequenceGaps,
      missingFrames: this.missingFrames,
      truncatedFrames: this.truncatedFrames,
      averageDecodeLatencyMs: this.decodeLatencySamples > 0
        ? this.decodeLatencyTotalMs / this.decodeLatencySamples
        : 0,
      maxDecodeLatencyMs: this.maxDecodeLatencyMs,
    };
  }
}
