import {
  RttFrameDecodeBatch,
  RttFrameStreamEndReason,
  RttFrameDecoder,
  RttSampleFrame,
} from './rtt-frame-decoder';
import { RttStreamMetricsSnapshot } from './rtt-stream-diagnostics';
import {
  RttStreamScheduler,
} from './rtt-stream-scheduler';
import {
  RttTransportError,
  RttTransportResult,
  rttFailure,
  rttSuccess,
} from './rtt-transport';

export interface RttTimelineSignal {
  readonly expression: string;
  readonly color: string;
  readonly payloadOffset: number;
}

export interface RttTimelinePoint {
  readonly timestamp: number;
  readonly value: number;
  readonly display: string;
  readonly startsNewSegment?: boolean;
}

export interface RttTimelineSnapshot {
  readonly expression: string;
  readonly color: string;
  readonly currentValue: string;
  readonly data: readonly RttTimelinePoint[];
}

export interface RttTimelinePollResult {
  readonly snapshots: readonly RttTimelineSnapshot[];
  readonly decode: RttFrameDecodeBatch;
  readonly metrics?: RttStreamMetricsSnapshot;
  readonly empty: boolean;
}

export interface RttTimelineConsumerOptions {
  readonly clock?: () => number;
  readonly decoder?: RttFrameDecoder;
}

/**
 * Converts decoded RTTB payload bytes into Timeline batches. It deliberately
 * accepts only explicit `rttb.payload[N]` signal names; arbitrary DWARF
 * expressions remain on the existing DAP Timeline source.
 */
export class RttTimelineConsumer {
  private readonly decoder: RttFrameDecoder;
  private readonly clock: () => number;
  private signals: RttTimelineSignal[] = [];
  private segmentPending = true;
  // HAL_GetTick() is target uptime and restarts from a low value after reset.
  // Keep Timeline timestamps monotonic while preserving the tick deltas within
  // each target run, so auto-follow remains valid across reset/owner changes.
  private timestampOffset = 0;
  private lastTimestamp: number | null = null;

  constructor(
    private readonly scheduler: RttStreamScheduler,
    private readonly channelIndex: number,
    options: RttTimelineConsumerOptions = {},
  ) {
    this.clock = options.clock || (() => Date.now());
    this.decoder = options.decoder || new RttFrameDecoder({ clock: this.clock });
  }

  configure(signals: readonly RttTimelineSignal[]): RttTransportResult<readonly RttTimelineSignal[]> {
    for (const signal of signals) {
      if (!Number.isInteger(signal.payloadOffset)
        || signal.payloadOffset < 0
        || signal.payloadOffset >= 44) {
        return rttFailure(new RttTransportError(
          'InvalidArgument',
          `RTTB payload offset must be in [0, 43]: ${signal.payloadOffset}`,
          'protocol',
        ));
      }
      if (!signal.expression.trim()) {
        return rttFailure(new RttTransportError(
          'InvalidArgument',
          'RTTB Timeline signal expression must not be empty',
          'protocol',
        ));
      }
    }
    this.signals = [...signals];
    this.segmentPending = true;
    return rttSuccess(this.signals);
  }

  async poll(size: number): Promise<RttTransportResult<RttTimelinePollResult>> {
    if (this.signals.length === 0) {
      return rttFailure(new RttTransportError(
        'InvalidArgument',
        'RTTB Timeline has no configured signals',
        'protocol',
      ));
    }
    const scheduled = await this.scheduler.scheduleRead({
      consumer: 'timeline',
      channelIndex: this.channelIndex,
      size,
      coalesceKey: `rttb-timeline:${this.channelIndex}`,
    });
    if (!scheduled.ok) {
      this.scheduler.recordConsumerError('timeline', this.channelIndex, scheduled.error.message);
      return scheduled;
    }
    const buffered = this.scheduler.readBuffered('timeline', this.channelIndex, size);
    if (!buffered.ok) {
      this.scheduler.recordConsumerError('timeline', this.channelIndex, buffered.error.message);
      return buffered;
    }

    const decode = this.decoder.feed(buffered.data.bytes);
    const metrics = this.recordDecodeMetrics(decode);
    // A forward sequence gap is expected from SEGGER_RTT_MODE_NO_BLOCK_SKIP:
    // samples were dropped, but target time is still continuous. Keep the
    // gap in diagnostics without fragmenting every read batch visually. An
    // out-of-order frame is a real stream discontinuity and starts a segment.
    if (decode.sequenceGaps.some(gap => gap.outOfOrder)) this.segmentPending = true;
    const snapshots = this.makeSnapshots(decode.frames);
    return rttSuccess({
      snapshots,
      decode,
      ...(metrics ? { metrics } : {}),
      empty: buffered.data.empty && decode.frames.length === 0,
    });
  }

  finish(reason: RttFrameStreamEndReason = 'stream-end'): RttFrameDecodeBatch {
    const decode = this.decoder.finish(reason);
    this.recordDecodeMetrics(decode);
    this.decoder.reset();
    this.segmentPending = true;
    return decode;
  }

  reset() {
    this.decoder.reset();
    this.segmentPending = true;
  }

  get bufferedBytes(): number {
    return this.decoder.bufferedBytes;
  }

  private recordDecodeMetrics(decode: RttFrameDecodeBatch): RttStreamMetricsSnapshot | undefined {
    return this.scheduler.recordFrameDecode('timeline', this.channelIndex, {
      decodedFrames: decode.frames.length,
      decodeErrors: decode.errors.length,
      checksumErrors: decode.errors.filter(error => error.code === 'checksum-mismatch').length,
      sequenceGaps: decode.sequenceGaps.length,
      missingFrames: decode.sequenceGaps.reduce((total, gap) => total + gap.missingFrames, 0),
      truncatedFrames: decode.errors.filter(error => error.code === 'truncated-frame').length,
      decodeLatencyMs: decode.decodeLatencyMs,
    });
  }

  private makeSnapshots(frames: readonly RttSampleFrame[]): RttTimelineSnapshot[] {
    const dataByExpression = new Map<string, RttTimelinePoint[]>();
    const latestByExpression = new Map<string, string>();
    for (const signal of this.signals) {
      dataByExpression.set(signal.expression, []);
    }

    for (const frame of frames) {
      const timestamp = this.normalizeTimestamp(frame.tick);
      for (const signal of this.signals) {
        const value = frame.payload[signal.payloadOffset];
        const data = dataByExpression.get(signal.expression)!;
        const startsNewSegment = this.segmentPending;
        data.push({
          timestamp,
          value,
          display: String(value),
          ...(startsNewSegment ? { startsNewSegment: true } : {}),
        });
        latestByExpression.set(signal.expression, String(value));
      }
      this.segmentPending = false;
    }

    return this.signals
      .map(signal => ({
        expression: signal.expression,
        color: signal.color,
        currentValue: latestByExpression.get(signal.expression) || '',
        data: dataByExpression.get(signal.expression) || [],
      }))
      .filter(snapshot => snapshot.data.length > 0);
  }

  private normalizeTimestamp(tick: number): number {
    let timestamp = tick + this.timestampOffset;
    // Multiple frames can legitimately share one HAL_GetTick() millisecond.
    // Keep those timestamps equal instead of permanently adding 1 ms per
    // frame, which would make a high-rate RTT stream run ahead of the DAP
    // session clock. Only a real backwards tick (reset/out-of-order stream)
    // needs rebasing.
    if (this.lastTimestamp !== null && timestamp < this.lastTimestamp) {
      this.timestampOffset += this.lastTimestamp + 1 - timestamp;
      timestamp = tick + this.timestampOffset;
    }
    this.lastTimestamp = timestamp;
    return timestamp;
  }
}

export function parseRttTimelineSignal(
  expression: string,
  color: string,
): RttTimelineSignal | undefined {
  const match = /^rttb\.payload\[(\d+)\]$/.exec(expression.trim());
  if (!match) return undefined;
  const payloadOffset = Number(match[1]);
  if (!Number.isInteger(payloadOffset) || payloadOffset < 0 || payloadOffset >= 44) return undefined;
  return { expression: expression.trim(), color, payloadOffset };
}
