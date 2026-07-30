import { SystemViewEventDecoder } from './systemview-event-decoder';
import { SystemViewMetadataStore, type SystemViewMetadataSnapshot } from './systemview-metadata';
import { SystemViewApiSpanTracker, type SystemViewApiSnapshot } from './systemview-api-span';
import {
  SystemViewEventId,
  SystemViewExtendedEventId,
  type SystemViewDecodeBatch,
  type SystemViewDecoderOptions,
  type SystemViewEvent,
  type SystemViewPayload,
} from './systemview-protocol';
import {
  SystemViewRtosStateMachine,
  type RtosStateSnapshot,
} from './systemview-rtos-state';

export type OrbitTraceEventKind =
  | 'metadata'
  | 'task'
  | 'isr'
  | 'idle'
  | 'api-enter'
  | 'api-exit'
  | 'marker'
  | 'message'
  | 'data-sample'
  | 'overflow'
  | 'unknown';

export interface OrbitTraceEvent {
  readonly kind: OrbitTraceEventKind;
  readonly eventId: number;
  readonly timestamp: number;
  readonly timestampDelta: number;
  readonly payload: SystemViewPayload;
  readonly rawPacket: Uint8Array;
}

export interface SystemViewTraceSnapshot {
  readonly events: readonly OrbitTraceEvent[];
  readonly metadata: SystemViewMetadataSnapshot;
  readonly rtos: RtosStateSnapshot;
  readonly api: SystemViewApiSnapshot;
}

export interface SystemViewTraceModelOptions {
  readonly decoder?: SystemViewDecoderOptions;
}

/**
 * Host-side aggregation seam for D09. It deliberately has no RTT/DAP/UI
 * dependency: callers may feed live RTT Channel 2 bytes or offline records.
 */
export class SystemViewTraceModel {
  public readonly decoder: SystemViewEventDecoder;
  public readonly metadata = new SystemViewMetadataStore();
  public readonly rtos = new SystemViewRtosStateMachine();
  public readonly api = new SystemViewApiSpanTracker();
  private readonly events: OrbitTraceEvent[] = [];

  public constructor(options: SystemViewTraceModelOptions = {}) {
    this.decoder = new SystemViewEventDecoder(options.decoder);
  }

  public push(bytes: Uint8Array): SystemViewDecodeBatch {
    const batch = this.decoder.push(bytes);
    this.consume(batch);
    return batch;
  }

  public finish(
    reason: 'stream-end' | 'channel-gone' | 'owner-lost' | 'reset' = 'stream-end',
  ): SystemViewDecodeBatch {
    const batch = this.decoder.finish(reason);
    this.consume(batch);
    if (reason === 'stream-end' || reason === 'reset') this.api.finish(this.decoder.lastTimestamp);
    else this.api.markGap(this.decoder.lastTimestamp, reason);
    this.rtos.finish(reason, this.decoder.lastTimestamp);
    return batch;
  }

  public snapshot(): SystemViewTraceSnapshot {
    return {
      events: [...this.events],
      metadata: this.metadata.snapshot(),
      rtos: this.rtos.snapshot(),
      api: this.api.snapshot(),
    };
  }

  public reset(): void {
    this.decoder.reset();
    this.metadata.reset();
    this.rtos.reset();
    this.api.reset();
    this.events.length = 0;
  }

  private consume(batch: SystemViewDecodeBatch): void {
    for (const diagnostic of batch.diagnostics) {
      if (diagnostic.code === 'overflow'
        || diagnostic.code === 'truncated-packet'
        || diagnostic.code === 'invalid-varint'
        || diagnostic.code === 'invalid-length'
        || diagnostic.code === 'malformed-event'
        || diagnostic.code === 'resynchronized'
        || diagnostic.code === 'channel-gone'
        || diagnostic.code === 'owner-lost'
        || diagnostic.code === 'reset') {
        if (diagnostic.code !== 'overflow') {
          this.api.markGap(this.decoder.lastTimestamp, diagnostic.code);
        }
      }
    }
    this.rtos.applyBatch(batch);
    for (const event of batch.events) {
      this.metadata.apply(event);
      if (event.payload.kind === 'overflow') {
        this.api.markGap(event.timestamp, 'SystemView overflow');
      }
      this.api.apply(event);
      this.events.push(normalizeSystemViewEvent(event));
    }
  }
}

export function normalizeSystemViewEvent(event: SystemViewEvent): OrbitTraceEvent {
  return {
    kind: classifyEvent(event),
    eventId: event.eventId,
    timestamp: event.timestamp,
    timestampDelta: event.timestampDelta,
    payload: event.payload,
    rawPacket: event.rawPacket.slice(),
  };
}

function classifyEvent(event: SystemViewEvent): OrbitTraceEventKind {
  if (event.eventId === SystemViewEventId.OVERFLOW) return 'overflow';
  if (event.eventId === SystemViewEventId.ISR_ENTER || event.eventId === SystemViewEventId.ISR_EXIT || event.eventId === SystemViewEventId.ISR_TO_SCHEDULER) return 'isr';
  if (event.eventId === SystemViewEventId.IDLE) return 'idle';
  if (event.eventId === SystemViewEventId.END_CALL) return 'api-exit';
  if (event.eventClass === 'os') return 'api-enter';
  if (event.eventId === SystemViewEventId.MARK_START
    || event.eventId === SystemViewEventId.MARK_STOP
    || (event.eventId === SystemViewEventId.EX
      && event.extendedEventId === SystemViewExtendedEventId.MARK)) return 'marker';
  if (event.eventId === SystemViewEventId.PRINT_FORMATTED) return 'message';
  if (event.eventId === SystemViewEventId.DATA_SAMPLE) return 'data-sample';
  if (event.eventId === SystemViewEventId.INIT || event.eventId === SystemViewEventId.SYSDESC || event.eventId === SystemViewEventId.TASK_INFO || event.eventId === SystemViewEventId.STACK_INFO || event.eventId === SystemViewEventId.MODULEDESC || event.eventId === SystemViewEventId.NAME_RESOURCE) return 'metadata';
  if (event.payload.kind === 'task' || event.payload.kind === 'task-stop-ready' || event.payload.kind === 'task-stop-exec') return 'task';
  return 'unknown';
}
