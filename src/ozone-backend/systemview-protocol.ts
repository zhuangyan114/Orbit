/**
 * SystemView target-protocol primitives.
 *
 * This file intentionally contains only the wire contract and small codecs.
 * It does not own RTT transport, DAP, or UI state. The constants and packet
 * layout follow the official SEGGER SystemView target source reference.
 */

export const SYSTEMVIEW_SYNC_SIZE = 10;
export const SYSTEMVIEW_MAX_EVENT_ID = 0x7fff;
export const SYSTEMVIEW_STANDARD_EVENT_COUNT = 32;
export const SYSTEMVIEW_MAX_U32 = 0xffffffff;

export const SYSTEMVIEW_SYNC_BYTES = new Uint8Array(SYSTEMVIEW_SYNC_SIZE);

export const SystemViewEventId = {
  NOP: 0,
  OVERFLOW: 1,
  ISR_ENTER: 2,
  ISR_EXIT: 3,
  TASK_START_EXEC: 4,
  TASK_STOP_EXEC: 5,
  TASK_START_READY: 6,
  TASK_STOP_READY: 7,
  TASK_CREATE: 8,
  TASK_INFO: 9,
  TRACE_START: 10,
  TRACE_STOP: 11,
  SYSTIME_CYCLES: 12,
  SYSTIME_US: 13,
  SYSDESC: 14,
  MARK_START: 15,
  MARK_STOP: 16,
  IDLE: 17,
  ISR_TO_SCHEDULER: 18,
  TIMER_ENTER: 19,
  TIMER_EXIT: 20,
  STACK_INFO: 21,
  MODULEDESC: 22,
  DATA_SAMPLE: 23,
  INIT: 24,
  NAME_RESOURCE: 25,
  PRINT_FORMATTED: 26,
  NUMMODULES: 27,
  END_CALL: 28,
  TASK_TERMINATE: 29,
  EX: 31,
} as const;

export const SystemViewExtendedEventId = {
  MARK: 0,
  NAME_MARKER: 1,
  HEAP_DEFINE: 2,
  HEAP_ALLOC: 3,
  HEAP_ALLOC_EX: 4,
  HEAP_FREE: 5,
  REGISTER_DATA: 6,
  PRINT_ELF: 7,
} as const;

export type SystemViewEventClass = 'standard' | 'os' | 'user' | 'undefined';

export type SystemViewPayload =
  | { readonly kind: 'none' }
  | { readonly kind: 'u32'; readonly values: readonly number[] }
  | { readonly kind: 'overflow'; readonly lostPackets: number }
  | { readonly kind: 'isr-enter'; readonly interruptId: number }
  | {
      readonly kind: 'task';
      readonly role: 'create' | 'terminate' | 'start-exec' | 'start-ready';
      readonly taskId: number;
    }
  | {
      readonly kind: 'task-stop-ready';
      readonly taskId: number;
      readonly cause: number;
    }
  | { readonly kind: 'task-stop-exec' }
  | {
      readonly kind: 'task-info';
      readonly taskId: number;
      readonly priority: number;
      readonly name: string;
    }
  | {
      readonly kind: 'stack-info';
      readonly taskId: number;
      readonly stackBase: number;
      readonly stackSize: number;
      readonly stackUsage: number;
    }
  | { readonly kind: 'system-description'; readonly text: string }
  | {
      readonly kind: 'init';
      readonly sysFrequency: number;
      readonly cpuFrequency: number;
      readonly ramBase: number;
      readonly idShift: number;
    }
  | {
      readonly kind: 'system-time-cycles';
      readonly cycles: number;
    }
  | {
      readonly kind: 'system-time-us';
      readonly low: number;
      readonly high: number;
    }
  | {
      readonly kind: 'module-description';
      readonly moduleId: number;
      readonly eventOffset: number;
      readonly description: string;
    }
  | { readonly kind: 'resource-name'; readonly resourceId: number; readonly name: string }
  | {
      readonly kind: 'data-sample';
      readonly sampleId: number;
      readonly rawValue: number;
      readonly floatValue: number;
    }
  | {
      readonly kind: 'printf';
      readonly text: string;
      readonly options: number;
      readonly arguments: readonly number[];
    }
  | {
      readonly kind: 'end-call';
      readonly functionId: number;
      readonly returnValue?: number;
    }
  | {
      readonly kind: 'extended';
      readonly extendedEventId: number;
      readonly values: readonly number[];
      readonly strings: readonly string[];
      readonly raw: Uint8Array;
    }
  | { readonly kind: 'raw'; readonly raw: Uint8Array };

export interface SystemViewEvent {
  readonly eventId: number;
  readonly eventClass: SystemViewEventClass;
  readonly extendedEventId?: number;
  readonly packetOffset: number;
  readonly rawPacket: Uint8Array;
  /** Event data without the trailing timestamp delta. */
  readonly rawData: Uint8Array;
  readonly timestampDelta: number;
  /** Cumulative timestamp modulo the configured timestamp width. */
  readonly timestamp: number;
  readonly payload: SystemViewPayload;
}

export type SystemViewDiagnosticCode =
  | 'sync'
  | 'invalid-varint'
  | 'invalid-length'
  | 'unknown-standard-event'
  | 'malformed-event'
  | 'truncated-packet'
  | 'resynchronized'
  | 'overflow'
  | 'stream-end'
  | 'channel-gone'
  | 'owner-lost'
  | 'reset';

export interface SystemViewDiagnostic {
  readonly code: SystemViewDiagnosticCode;
  readonly severity: 'info' | 'warning' | 'error';
  readonly message: string;
  readonly streamOffset?: number;
  readonly eventId?: number;
  readonly bytesDiscarded?: number;
  readonly expectedBytes?: number;
  readonly receivedBytes?: number;
  readonly lostPackets?: number;
}

export interface SystemViewDecodeBatch {
  readonly events: readonly SystemViewEvent[];
  readonly diagnostics: readonly SystemViewDiagnostic[];
  readonly bytesConsumed: number;
  readonly bufferedBytes: number;
}

export interface SystemViewDecoderOptions {
  readonly maxPacketBytes?: number;
  readonly timestampBits?: number;
  /** Optional is the safe default for a raw RTT stream. */
  readonly syncMode?: 'optional' | 'required' | 'disabled';
}

export type SystemViewVarUintResult =
  | { readonly ok: true; readonly value: number; readonly nextOffset: number }
  | { readonly ok: false; readonly reason: 'incomplete' | 'overflow' };

export type SystemViewBytesResult =
  | { readonly ok: true; readonly bytes: Uint8Array; readonly nextOffset: number }
  | { readonly ok: false; readonly reason: 'incomplete' | 'overflow' };

export function classifySystemViewEventId(eventId: number): SystemViewEventClass {
  if (eventId < 32) return 'standard';
  if (eventId <= 1023) return 'os';
  if (eventId <= 2047) return 'user';
  return 'undefined';
}

export function systemViewEventName(eventId: number): string {
  const names: Record<number, string> = {
    [SystemViewEventId.NOP]: 'NOP',
    [SystemViewEventId.OVERFLOW]: 'OVERFLOW',
    [SystemViewEventId.ISR_ENTER]: 'ISR_ENTER',
    [SystemViewEventId.ISR_EXIT]: 'ISR_EXIT',
    [SystemViewEventId.TASK_START_EXEC]: 'TASK_START_EXEC',
    [SystemViewEventId.TASK_STOP_EXEC]: 'TASK_STOP_EXEC',
    [SystemViewEventId.TASK_START_READY]: 'TASK_START_READY',
    [SystemViewEventId.TASK_STOP_READY]: 'TASK_STOP_READY',
    [SystemViewEventId.TASK_CREATE]: 'TASK_CREATE',
    [SystemViewEventId.TASK_INFO]: 'TASK_INFO',
    [SystemViewEventId.TRACE_START]: 'TRACE_START',
    [SystemViewEventId.TRACE_STOP]: 'TRACE_STOP',
    [SystemViewEventId.SYSTIME_CYCLES]: 'SYSTIME_CYCLES',
    [SystemViewEventId.SYSTIME_US]: 'SYSTIME_US',
    [SystemViewEventId.SYSDESC]: 'SYSDESC',
    [SystemViewEventId.MARK_START]: 'MARK_START',
    [SystemViewEventId.MARK_STOP]: 'MARK_STOP',
    [SystemViewEventId.IDLE]: 'IDLE',
    [SystemViewEventId.ISR_TO_SCHEDULER]: 'ISR_TO_SCHEDULER',
    [SystemViewEventId.TIMER_ENTER]: 'TIMER_ENTER',
    [SystemViewEventId.TIMER_EXIT]: 'TIMER_EXIT',
    [SystemViewEventId.STACK_INFO]: 'STACK_INFO',
    [SystemViewEventId.MODULEDESC]: 'MODULEDESC',
    [SystemViewEventId.DATA_SAMPLE]: 'DATA_SAMPLE',
    [SystemViewEventId.INIT]: 'INIT',
    [SystemViewEventId.NAME_RESOURCE]: 'NAME_RESOURCE',
    [SystemViewEventId.PRINT_FORMATTED]: 'PRINT_FORMATTED',
    [SystemViewEventId.NUMMODULES]: 'NUMMODULES',
    [SystemViewEventId.END_CALL]: 'END_CALL',
    [SystemViewEventId.TASK_TERMINATE]: 'TASK_TERMINATE',
    [SystemViewEventId.EX]: 'EX',
  };
  return names[eventId] ?? `EVENT_${eventId}`;
}

export function encodeSystemViewVarUint(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > SYSTEMVIEW_MAX_U32) {
    throw new Error(`SystemView varuint value must be a uint32: ${value}`);
  }
  const bytes: number[] = [];
  let remaining = value >>> 0;
  do {
    const group = remaining & 0x7f;
    remaining = Math.floor(remaining / 0x80);
    bytes.push(remaining > 0 ? group | 0x80 : group);
  } while (remaining > 0);
  return Uint8Array.from(bytes);
}

export function readSystemViewVarUint(
  bytes: Uint8Array,
  offset: number,
  end = bytes.length,
): SystemViewVarUintResult {
  let value = 0;
  let multiplier = 1;
  for (let index = offset; index < end; index += 1) {
    const byte = bytes[index];
    value += (byte & 0x7f) * multiplier;
    if (value > SYSTEMVIEW_MAX_U32) return { ok: false, reason: 'overflow' };
    if ((byte & 0x80) === 0) {
      return { ok: true, value, nextOffset: index + 1 };
    }
    multiplier *= 0x80;
    if (multiplier > 0x100000000) return { ok: false, reason: 'overflow' };
  }
  return { ok: false, reason: 'incomplete' };
}

export function encodeSystemViewLengthPrefixedBytes(bytes: Uint8Array): Uint8Array {
  if (bytes.length >= 0xffff) {
    throw new Error(`SystemView byte array is too long: ${bytes.length}`);
  }
  if (bytes.length < 0xff) {
    return concatSystemViewBytes(Uint8Array.of(bytes.length), bytes);
  }
  return concatSystemViewBytes(
    Uint8Array.of(0xff, (bytes.length >>> 8) & 0xff, bytes.length & 0xff),
    bytes,
  );
}

export function readSystemViewLengthPrefixedBytes(
  bytes: Uint8Array,
  offset: number,
  end = bytes.length,
): SystemViewBytesResult {
  if (offset >= end) return { ok: false, reason: 'incomplete' };
  const first = bytes[offset];
  let length: number;
  let dataOffset: number;
  if (first !== 0xff) {
    length = first;
    dataOffset = offset + 1;
  } else {
    if (offset + 3 > end) return { ok: false, reason: 'incomplete' };
    length = (bytes[offset + 1] << 8) | bytes[offset + 2];
    dataOffset = offset + 3;
  }
  if (dataOffset + length > end) return { ok: false, reason: 'incomplete' };
  return {
    ok: true,
    bytes: bytes.slice(dataOffset, dataOffset + length),
    nextOffset: dataOffset + length,
  };
}

export function encodeSystemViewString(value: string): Uint8Array {
  return encodeSystemViewLengthPrefixedBytes(new TextEncoder().encode(value));
}

export function decodeSystemViewString(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

export function decodeSystemViewFloat32(rawValue: number): number {
  const buffer = new ArrayBuffer(4);
  new DataView(buffer).setUint32(0, rawValue >>> 0, true);
  return new DataView(buffer).getFloat32(0, true);
}

export function concatSystemViewBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

export interface SystemViewPacketEncodeOptions {
  readonly extendedEventId?: number;
}

/**
 * Encodes a packet for reference fixtures and protocol tests. The target
 * implementation prepends the packet ID/length and appends the timestamp
 * delta; for IDs >= 24 the length covers the payload only, while the
 * timestamp delta follows outside that length-prefixed payload.
 */
export function encodeSystemViewPacket(
  eventId: number,
  data: Uint8Array = new Uint8Array(),
  timestampDelta = 0,
  options: SystemViewPacketEncodeOptions = {},
): Uint8Array {
  if (!Number.isInteger(eventId) || eventId < 0 || eventId > SYSTEMVIEW_MAX_EVENT_ID) {
    throw new Error(`SystemView event ID must be in [0, ${SYSTEMVIEW_MAX_EVENT_ID}]: ${eventId}`);
  }
  if (options.extendedEventId !== undefined && eventId !== SystemViewEventId.EX) {
    throw new Error('An extended event ID is only valid with event ID 31');
  }
  const extended = options.extendedEventId === undefined
    ? new Uint8Array()
    : encodeSystemViewVarUint(options.extendedEventId);
  const payload = concatSystemViewBytes(extended, data);
  const timestamp = encodeSystemViewVarUint(timestampDelta);
  const id = encodeSystemViewVarUint(eventId);
  return eventId < 24
    ? concatSystemViewBytes(id, payload, timestamp)
    : concatSystemViewBytes(id, encodeSystemViewVarUint(payload.length), payload, timestamp);
}

export function encodeSystemViewSync(): Uint8Array {
  return SYSTEMVIEW_SYNC_BYTES.slice();
}
