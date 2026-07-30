import {
  classifySystemViewEventId,
  decodeSystemViewFloat32,
  decodeSystemViewString,
  readSystemViewLengthPrefixedBytes,
  readSystemViewVarUint,
  SYSTEMVIEW_MAX_EVENT_ID,
  SYSTEMVIEW_MAX_U32,
  SYSTEMVIEW_SYNC_SIZE,
  SystemViewEventId,
  SystemViewExtendedEventId,
  type SystemViewDiagnostic,
  type SystemViewDecodeBatch,
  type SystemViewDecoderOptions,
  type SystemViewEvent,
  type SystemViewPayload,
} from './systemview-protocol';

type ParseAttempt =
  | { readonly status: 'complete'; readonly nextOffset: number; readonly event: SystemViewEvent; readonly diagnostics?: readonly SystemViewDiagnostic[] }
  | { readonly status: 'incomplete' }
  | { readonly status: 'invalid'; readonly diagnostic: Omit<SystemViewDiagnostic, 'streamOffset'> };

type PayloadResult =
  | { readonly ok: true; readonly payload: SystemViewPayload; readonly extendedEventId?: number }
  | { readonly ok: false; readonly message: string };

const DEFAULT_MAX_PACKET_BYTES = 64 * 1024;

/**
 * Incremental decoder for the SystemView target event stream.
 *
 * The decoder only consumes bytes from the supplied stream. It does not read
 * RTT itself, so a caller can feed arbitrary read fragments and decide how to
 * report owner loss, channel disappearance, or stream end through finish().
 */
export class SystemViewEventDecoder {
  private carry = new Uint8Array();
  private streamOffset = 0;
  private timestamp = 0;
  private readonly timestampMask: number;
  private readonly maxPacketBytes: number;
  private readonly syncMode: NonNullable<SystemViewDecoderOptions['syncMode']>;
  private started: boolean;

  public constructor(options: SystemViewDecoderOptions = {}) {
    const timestampBits = options.timestampBits ?? 32;
    if (!Number.isInteger(timestampBits) || timestampBits < 1 || timestampBits > 32) {
      throw new Error(`SystemView timestampBits must be in [1, 32]: ${timestampBits}`);
    }
    const maxPacketBytes = options.maxPacketBytes ?? DEFAULT_MAX_PACKET_BYTES;
    if (!Number.isInteger(maxPacketBytes) || maxPacketBytes < 2) {
      throw new Error(`SystemView maxPacketBytes must be at least 2: ${maxPacketBytes}`);
    }
    this.timestampMask = timestampBits === 32 ? SYSTEMVIEW_MAX_U32 : 2 ** timestampBits - 1;
    this.maxPacketBytes = maxPacketBytes;
    this.syncMode = options.syncMode ?? 'optional';
    this.started = this.syncMode === 'disabled';
  }

  public push(bytes: Uint8Array): SystemViewDecodeBatch {
    if (bytes.length > 0) {
      const merged = new Uint8Array(this.carry.length + bytes.length);
      merged.set(this.carry, 0);
      merged.set(bytes, this.carry.length);
      this.carry = merged;
    }

    const events: SystemViewEvent[] = [];
    const diagnostics: SystemViewDiagnostic[] = [];
    let cursor = 0;
    let discardedSinceEvent = 0;
    let resyncReported = false;

    while (cursor < this.carry.length) {
      if (!this.started) {
        if (this.carry.length - cursor < SYSTEMVIEW_SYNC_SIZE && this.isZeroRun(cursor, this.carry.length)) {
          break;
        }
        if (this.hasSyncAt(cursor)) {
          diagnostics.push({
            code: 'sync',
            severity: 'info',
            message: 'SystemView sync marker detected',
            streamOffset: this.streamOffset + cursor,
            bytesDiscarded: SYSTEMVIEW_SYNC_SIZE,
          });
          cursor += SYSTEMVIEW_SYNC_SIZE;
          this.started = true;
          continue;
        }
        if (this.syncMode === 'required') {
          diagnostics.push({
            code: 'malformed-event',
            severity: 'error',
            message: 'SystemView sync marker was required but the stream started with a packet',
            streamOffset: this.streamOffset + cursor,
          });
        }
        this.started = true;
      }

      // A sync marker can also appear while recovering from a corrupted read.
      if (this.hasSyncAt(cursor)) {
        diagnostics.push({
          code: 'sync',
          severity: 'info',
          message: 'SystemView sync marker detected during stream recovery',
          streamOffset: this.streamOffset + cursor,
          bytesDiscarded: SYSTEMVIEW_SYNC_SIZE,
        });
        cursor += SYSTEMVIEW_SYNC_SIZE;
        continue;
      }

      const attempt = this.parseAt(this.carry, cursor);
      if (attempt.status === 'incomplete') break;
      if (attempt.status === 'invalid') {
        diagnostics.push({
          ...attempt.diagnostic,
          streamOffset: this.streamOffset + cursor,
        });
        cursor += 1;
        discardedSinceEvent += 1;
        continue;
      }

      if (discardedSinceEvent > 0 && !resyncReported) {
        diagnostics.push({
          code: 'resynchronized',
          severity: 'warning',
          message: `SystemView decoder resynchronized after discarding ${discardedSinceEvent} byte(s)`,
          streamOffset: this.streamOffset + cursor,
          bytesDiscarded: discardedSinceEvent,
        });
        resyncReported = true;
      }
      events.push(attempt.event);
      for (const diagnostic of attempt.diagnostics ?? []) {
        diagnostics.push({
          ...diagnostic,
          streamOffset: diagnostic.streamOffset ?? attempt.event.packetOffset,
        });
      }
      this.timestamp = attempt.event.timestamp;
      cursor = attempt.nextOffset;
      discardedSinceEvent = 0;
      resyncReported = false;
    }

    this.carry = this.carry.slice(cursor);
    this.streamOffset += cursor;
    return {
      events,
      diagnostics,
      bytesConsumed: cursor,
      bufferedBytes: this.carry.length,
    };
  }

  public finish(
    reason: 'stream-end' | 'channel-gone' | 'owner-lost' | 'reset' = 'stream-end',
  ): SystemViewDecodeBatch {
    const flushed = this.push(new Uint8Array());
    const diagnostics = [...flushed.diagnostics];
    let bytesConsumed = flushed.bytesConsumed;
    if (this.carry.length > 0) {
      diagnostics.push({
        code: 'truncated-packet',
        severity: 'error',
        message: `SystemView stream ended with ${this.carry.length} buffered byte(s)`,
        streamOffset: this.streamOffset,
        receivedBytes: this.carry.length,
      });
      bytesConsumed += this.carry.length;
      this.streamOffset += this.carry.length;
      this.carry = new Uint8Array();
    }
    diagnostics.push({
      code: reason,
      severity: reason === 'stream-end' ? 'info' : 'warning',
      message: `SystemView stream finished: ${reason}`,
      streamOffset: this.streamOffset,
    });
    if (reason === 'reset') {
      this.timestamp = 0;
      this.started = this.syncMode === 'disabled';
    }
    return {
      events: flushed.events,
      diagnostics,
      bytesConsumed,
      bufferedBytes: 0,
    };
  }

  public reset(): void {
    this.carry = new Uint8Array();
    this.streamOffset = 0;
    this.timestamp = 0;
    this.started = this.syncMode === 'disabled';
  }

  public get bufferedBytes(): number {
    return this.carry.length;
  }

  public get lastTimestamp(): number {
    return this.timestamp;
  }

  private parseAt(bytes: Uint8Array, offset: number): ParseAttempt {
    const idResult = readSystemViewVarUint(bytes, offset);
    if (!idResult.ok) {
      return idResult.reason === 'incomplete'
        ? { status: 'incomplete' }
        : {
            status: 'invalid',
            diagnostic: {
              code: 'invalid-varint',
              severity: 'error',
              message: 'SystemView event ID varuint overflowed uint32',
            },
          };
    }
    const eventId = idResult.value;
    if (eventId > SYSTEMVIEW_MAX_EVENT_ID) {
      return {
        status: 'invalid',
        diagnostic: {
          code: 'invalid-varint',
          severity: 'error',
          message: `SystemView event ID ${eventId} is outside the supported wire range`,
          eventId,
        },
      };
    }

    if (eventId < 24) {
      return this.parseStandardPacket(bytes, offset, eventId, idResult.nextOffset);
    }

    const lengthResult = readSystemViewVarUint(bytes, idResult.nextOffset);
    if (!lengthResult.ok) {
      return lengthResult.reason === 'incomplete'
        ? { status: 'incomplete' }
        : {
            status: 'invalid',
            diagnostic: {
              code: 'invalid-length',
              severity: 'error',
              message: `SystemView event ${eventId} length varuint overflowed uint32`,
              eventId,
            },
          };
    }
    const packetLength = lengthResult.value;
    if (packetLength < 1 || packetLength > this.maxPacketBytes) {
      return {
        status: 'invalid',
        diagnostic: {
          code: 'invalid-length',
          severity: 'error',
          message: `SystemView event ${eventId} declared invalid packet length ${packetLength}`,
          eventId,
          expectedBytes: this.maxPacketBytes,
        },
      };
    }
    // Official SystemView stores the length of the event payload only.  The
    // timestamp delta is appended after that payload and is not included in
    // the length prefix (SEGGER_SYSVIEW.c::_SendPacket/_SendPacket_Ex).
    const payloadEnd = lengthResult.nextOffset + packetLength;
    if (payloadEnd > bytes.length) return { status: 'incomplete' };
    const timestampResult = readSystemViewVarUint(bytes, payloadEnd);
    if (!timestampResult.ok) {
      if (timestampResult.reason === 'incomplete') return { status: 'incomplete' };
      return {
        status: 'invalid',
        diagnostic: {
          code: 'malformed-event',
          severity: 'error',
          message: `SystemView event ${eventId} has an invalid timestamp delta`,
          eventId,
        },
      };
    }
    return this.completeEvent(
      bytes,
      offset,
      timestampResult.nextOffset,
      eventId,
      bytes.slice(lengthResult.nextOffset, payloadEnd),
      timestampResult.value,
    );
  }

  private parseStandardPacket(
    bytes: Uint8Array,
    packetOffset: number,
    eventId: number,
    dataOffset: number,
  ): ParseAttempt {
    const payloadResult = this.decodeStandardPayload(bytes, dataOffset, eventId);
    if (payloadResult.status === 'incomplete') return { status: 'incomplete' };
    if (payloadResult.status === 'invalid') {
      return {
        status: 'invalid',
        diagnostic: {
          code: payloadResult.code,
          severity: 'error',
          message: payloadResult.message,
          eventId,
        },
      };
    }
    const timestampResult = readSystemViewVarUint(bytes, payloadResult.nextOffset);
    if (!timestampResult.ok) {
      return timestampResult.reason === 'incomplete'
        ? { status: 'incomplete' }
        : {
            status: 'invalid',
            diagnostic: {
              code: 'invalid-varint',
              severity: 'error',
              message: `SystemView event ${eventId} timestamp delta overflowed uint32`,
              eventId,
            },
          };
    }
    return this.completeEvent(
      bytes,
      packetOffset,
      timestampResult.nextOffset,
      eventId,
      bytes.slice(dataOffset, payloadResult.nextOffset),
      timestampResult.value,
      payloadResult.payload,
    );
  }

  private completeEvent(
    bytes: Uint8Array,
    packetOffset: number,
    nextOffset: number,
    eventId: number,
    data: Uint8Array,
    timestampDelta: number,
    decodedPayload?: SystemViewPayload,
  ): ParseAttempt {
    const payloadResult = decodedPayload === undefined
      ? this.decodePayload(eventId, data)
      : { ok: true as const, payload: decodedPayload };
    const payload = payloadResult.ok ? payloadResult.payload : { kind: 'raw' as const, raw: data.slice() };
    const timestamp = this.addTimestamp(timestampDelta);
    const event: SystemViewEvent = {
      eventId,
      eventClass: classifySystemViewEventId(eventId),
      ...(payloadResult.ok && payloadResult.extendedEventId !== undefined
        ? { extendedEventId: payloadResult.extendedEventId }
        : {}),
      packetOffset: this.streamOffset + packetOffset,
      rawPacket: bytes.slice(packetOffset, nextOffset),
      rawData: data.slice(),
      timestampDelta,
      timestamp,
      payload,
    };
    const diagnostics: SystemViewDiagnostic[] = [];
    if (!payloadResult.ok) {
      diagnostics.push({
        code: 'malformed-event',
        severity: 'warning',
        message: payloadResult.message,
        eventId,
      });
    }
    if (payload.kind === 'overflow') {
      diagnostics.push({
        code: 'overflow',
        severity: 'warning',
        message: `SystemView reported ${payload.lostPackets} dropped packet(s)`,
        eventId,
        lostPackets: payload.lostPackets,
      });
    }
    return { status: 'complete', nextOffset, event, diagnostics };
  }

  private decodeStandardPayload(
    bytes: Uint8Array,
    offset: number,
    eventId: number,
  ):
    | { readonly status: 'complete'; readonly nextOffset: number; readonly payload: SystemViewPayload }
    | { readonly status: 'incomplete' }
    | { readonly status: 'invalid'; readonly code: 'unknown-standard-event' | 'malformed-event'; readonly message: string } {
    const field = this.readPayload(bytes, offset, bytes.length, eventId);
    if (field.status === 'incomplete') return field;
    if (field.status === 'invalid') return field;
    return { status: 'complete', nextOffset: field.nextOffset, payload: field.payload };
  }

  private decodePayload(eventId: number, data: Uint8Array): PayloadResult {
    if (eventId >= 30 && eventId !== SystemViewEventId.EX) {
      return { ok: true, payload: { kind: 'raw', raw: data.slice() } };
    }
    const field = this.readPayload(data, 0, data.length, eventId);
    if (field.status === 'incomplete') return { ok: false, message: 'event payload ended before all fields were decoded' };
    if (field.status === 'invalid') return { ok: false, message: field.message };
    if (field.nextOffset !== data.length) {
      return { ok: false, message: `event payload has ${data.length - field.nextOffset} unexpected trailing byte(s)` };
    }
    return { ok: true, payload: field.payload, ...(field.extendedEventId === undefined ? {} : { extendedEventId: field.extendedEventId }) };
  }

  private readPayload(
    bytes: Uint8Array,
    offset: number,
    end: number,
    eventId: number,
  ):
    | { readonly status: 'complete'; readonly nextOffset: number; readonly payload: SystemViewPayload; readonly extendedEventId?: number }
    | { readonly status: 'incomplete' }
    | { readonly status: 'invalid'; readonly code: 'unknown-standard-event' | 'malformed-event'; readonly message: string } {
    const values = (count: number): { status: 'complete'; nextOffset: number; values: number[] } | { status: 'incomplete' } => {
      const result: number[] = [];
      let cursor = offset;
      for (let index = 0; index < count; index += 1) {
        const value = readSystemViewVarUint(bytes, cursor, end);
        if (!value.ok) return value.reason === 'incomplete' ? { status: 'incomplete' } : { status: 'incomplete' };
        result.push(value.value);
        cursor = value.nextOffset;
      }
      return { status: 'complete', nextOffset: cursor, values: result };
    };
    const string = (cursor: number) => readSystemViewLengthPrefixedBytes(bytes, cursor, end);

    switch (eventId) {
      case SystemViewEventId.NOP:
      case SystemViewEventId.ISR_EXIT:
      case SystemViewEventId.TASK_STOP_EXEC:
      case SystemViewEventId.TRACE_START:
      case SystemViewEventId.TRACE_STOP:
      case SystemViewEventId.IDLE:
      case SystemViewEventId.ISR_TO_SCHEDULER:
      case SystemViewEventId.TIMER_EXIT:
        return {
          status: 'complete',
          nextOffset: offset,
          payload: eventId === SystemViewEventId.TASK_STOP_EXEC ? { kind: 'task-stop-exec' } : { kind: 'none' },
        };
      case SystemViewEventId.OVERFLOW: {
        const result = values(1);
        return result.status === 'incomplete'
          ? result
          : { status: 'complete', nextOffset: result.nextOffset, payload: { kind: 'overflow', lostPackets: result.values[0] } };
      }
      case SystemViewEventId.ISR_ENTER: {
        const result = values(1);
        return result.status === 'incomplete'
          ? result
          : { status: 'complete', nextOffset: result.nextOffset, payload: { kind: 'isr-enter', interruptId: result.values[0] } };
      }
      case SystemViewEventId.TASK_START_EXEC:
      case SystemViewEventId.TASK_CREATE:
      case SystemViewEventId.TASK_TERMINATE:
      case SystemViewEventId.TASK_START_READY: {
        const result = values(1);
        if (result.status === 'incomplete') return result;
        const role = eventId === SystemViewEventId.TASK_START_EXEC
          ? 'start-exec'
          : eventId === SystemViewEventId.TASK_CREATE
            ? 'create'
            : eventId === SystemViewEventId.TASK_TERMINATE
              ? 'terminate'
              : 'start-ready';
        return { status: 'complete', nextOffset: result.nextOffset, payload: { kind: 'task', role, taskId: result.values[0] } };
      }
      case SystemViewEventId.TASK_STOP_READY: {
        const result = values(2);
        return result.status === 'incomplete'
          ? result
          : { status: 'complete', nextOffset: result.nextOffset, payload: { kind: 'task-stop-ready', taskId: result.values[0], cause: result.values[1] } };
      }
      case SystemViewEventId.TASK_INFO: {
        const first = values(2);
        if (first.status === 'incomplete') return first;
        const name = string(first.nextOffset);
        if (!name.ok) return name.reason === 'incomplete' ? { status: 'incomplete' } : { status: 'incomplete' };
        return {
          status: 'complete',
          nextOffset: name.nextOffset,
          payload: { kind: 'task-info', taskId: first.values[0], priority: first.values[1], name: decodeSystemViewString(name.bytes) },
        };
      }
      case SystemViewEventId.SYSTIME_CYCLES: {
        const result = values(1);
        return result.status === 'incomplete'
          ? result
          : { status: 'complete', nextOffset: result.nextOffset, payload: { kind: 'system-time-cycles', cycles: result.values[0] } };
      }
      case SystemViewEventId.SYSTIME_US: {
        const result = values(2);
        return result.status === 'incomplete'
          ? result
          : { status: 'complete', nextOffset: result.nextOffset, payload: { kind: 'system-time-us', low: result.values[0], high: result.values[1] } };
      }
      case SystemViewEventId.SYSDESC: {
        const description = string(offset);
        if (!description.ok) return description.reason === 'incomplete' ? { status: 'incomplete' } : { status: 'incomplete' };
        return { status: 'complete', nextOffset: description.nextOffset, payload: { kind: 'system-description', text: decodeSystemViewString(description.bytes) } };
      }
      case SystemViewEventId.MARK_START:
      case SystemViewEventId.MARK_STOP:
      case SystemViewEventId.TIMER_ENTER:
      case SystemViewEventId.NUMMODULES: {
        const result = values(1);
        return result.status === 'incomplete'
          ? result
          : { status: 'complete', nextOffset: result.nextOffset, payload: { kind: 'u32', values: result.values } };
      }
      case SystemViewEventId.STACK_INFO: {
        const result = values(4);
        return result.status === 'incomplete'
          ? result
          : {
              status: 'complete',
              nextOffset: result.nextOffset,
              payload: { kind: 'stack-info', taskId: result.values[0], stackBase: result.values[1], stackSize: result.values[2], stackUsage: result.values[3] },
            };
      }
      case SystemViewEventId.MODULEDESC: {
        const first = values(2);
        if (first.status === 'incomplete') return first;
        const description = string(first.nextOffset);
        if (!description.ok) return description.reason === 'incomplete' ? { status: 'incomplete' } : { status: 'incomplete' };
        return {
          status: 'complete',
          nextOffset: description.nextOffset,
          payload: { kind: 'module-description', moduleId: first.values[0], eventOffset: first.values[1], description: decodeSystemViewString(description.bytes) },
        };
      }
      case SystemViewEventId.DATA_SAMPLE: {
        const result = values(2);
        return result.status === 'incomplete'
          ? result
          : { status: 'complete', nextOffset: result.nextOffset, payload: { kind: 'data-sample', sampleId: result.values[0], rawValue: result.values[1], floatValue: decodeSystemViewFloat32(result.values[1]) } };
      }
      case SystemViewEventId.INIT: {
        const result = values(4);
        return result.status === 'incomplete'
          ? result
          : { status: 'complete', nextOffset: result.nextOffset, payload: { kind: 'init', sysFrequency: result.values[0], cpuFrequency: result.values[1], ramBase: result.values[2], idShift: result.values[3] } };
      }
      case SystemViewEventId.NAME_RESOURCE: {
        const resource = values(1);
        if (resource.status === 'incomplete') return resource;
        const name = string(resource.nextOffset);
        if (!name.ok) return name.reason === 'incomplete' ? { status: 'incomplete' } : { status: 'incomplete' };
        return { status: 'complete', nextOffset: name.nextOffset, payload: { kind: 'resource-name', resourceId: resource.values[0], name: decodeSystemViewString(name.bytes) } };
      }
      case SystemViewEventId.PRINT_FORMATTED: {
        const text = string(offset);
        if (!text.ok) return text.reason === 'incomplete' ? { status: 'incomplete' } : { status: 'incomplete' };
        const options = readSystemViewVarUint(bytes, text.nextOffset, end);
        if (!options.ok) return options.reason === 'incomplete' ? { status: 'incomplete' } : { status: 'incomplete' };
        const argumentCount = readSystemViewVarUint(bytes, options.nextOffset, end);
        if (!argumentCount.ok) return argumentCount.reason === 'incomplete' ? { status: 'incomplete' } : { status: 'incomplete' };
        if (argumentCount.value > 1024) return { status: 'invalid', code: 'malformed-event', message: `PRINT_FORMATTED has unreasonable argument count ${argumentCount.value}` };
        let cursor = argumentCount.nextOffset;
        const args: number[] = [];
        for (let index = 0; index < argumentCount.value; index += 1) {
          const value = readSystemViewVarUint(bytes, cursor, end);
          if (!value.ok) return value.reason === 'incomplete' ? { status: 'incomplete' } : { status: 'incomplete' };
          args.push(value.value);
          cursor = value.nextOffset;
        }
        return { status: 'complete', nextOffset: cursor, payload: { kind: 'printf', text: decodeSystemViewString(text.bytes), options: options.value, arguments: args } };
      }
      case SystemViewEventId.END_CALL: {
        const result = values(1);
        if (result.status === 'incomplete') return result;
        if (result.nextOffset === end) return { status: 'complete', nextOffset: result.nextOffset, payload: { kind: 'end-call', functionId: result.values[0] } };
        const returnValue = readSystemViewVarUint(bytes, result.nextOffset, end);
        if (!returnValue.ok) return returnValue.reason === 'incomplete' ? { status: 'incomplete' } : { status: 'incomplete' };
        return { status: 'complete', nextOffset: returnValue.nextOffset, payload: { kind: 'end-call', functionId: result.values[0], returnValue: returnValue.value } };
      }
      case SystemViewEventId.EX: {
        const extended = readSystemViewVarUint(bytes, offset, end);
        if (!extended.ok) return extended.reason === 'incomplete' ? { status: 'incomplete' } : { status: 'incomplete' };
        const extendedData = bytes.slice(extended.nextOffset, end);
        if (extended.value === SystemViewExtendedEventId.MARK) {
          const marker = readSystemViewVarUint(extendedData, 0);
          if (!marker.ok || marker.nextOffset !== extendedData.length) return { status: 'invalid', code: 'malformed-event', message: 'extended MARK payload is malformed' };
          return { status: 'complete', nextOffset: end, extendedEventId: extended.value, payload: { kind: 'extended', extendedEventId: extended.value, values: [marker.value], strings: [], raw: extendedData } };
        }
        if (extended.value === SystemViewExtendedEventId.NAME_MARKER) {
          const marker = readSystemViewVarUint(extendedData, 0);
          if (!marker.ok) return { status: 'incomplete' };
          const name = readSystemViewLengthPrefixedBytes(extendedData, marker.nextOffset);
          if (!name.ok || name.nextOffset !== extendedData.length) return { status: 'incomplete' };
          return { status: 'complete', nextOffset: end, extendedEventId: extended.value, payload: { kind: 'extended', extendedEventId: extended.value, values: [marker.value], strings: [decodeSystemViewString(name.bytes)], raw: extendedData } };
        }
        return { status: 'complete', nextOffset: end, extendedEventId: extended.value, payload: { kind: 'extended', extendedEventId: extended.value, values: [], strings: [], raw: extendedData } };
      }
      default:
        return { status: 'invalid', code: 'unknown-standard-event', message: `SystemView event ID ${eventId} has no known standard schema` };
    }
  }

  private addTimestamp(delta: number): number {
    const maskedDelta = delta & this.timestampMask;
    if (this.timestampMask === SYSTEMVIEW_MAX_U32) {
      return (this.timestamp + maskedDelta) >>> 0;
    }
    return (this.timestamp + maskedDelta) & this.timestampMask;
  }

  private hasSyncAt(offset: number): boolean {
    if (offset + SYSTEMVIEW_SYNC_SIZE > this.carry.length) return false;
    for (let index = 0; index < SYSTEMVIEW_SYNC_SIZE; index += 1) {
      if (this.carry[offset + index] !== 0) return false;
    }
    return true;
  }

  private isZeroRun(offset: number, end: number): boolean {
    for (let index = offset; index < end; index += 1) {
      if (this.carry[index] !== 0) return false;
    }
    return true;
  }
}
