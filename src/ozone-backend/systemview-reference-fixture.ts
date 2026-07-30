import {
  concatSystemViewBytes,
  encodeSystemViewPacket,
  encodeSystemViewString,
  encodeSystemViewSync,
  encodeSystemViewVarUint,
  SystemViewEventId,
  SystemViewExtendedEventId,
} from './systemview-protocol';

const words = (...values: readonly number[]): Uint8Array =>
  concatSystemViewBytes(...values.map(value => encodeSystemViewVarUint(value)));

/**
 * D02 reference vector generated from the official V4.12.0 target-source
 * packet rules. It is deliberately labelled as a source-derived vector, not
 * as a target capture or an official SystemView host export.
 */
export const SYSTEMVIEW_V4120_REFERENCE_SOURCE = {
  systemViewTag: 'V4.12.0',
  systemViewCommit: '92ca7a8',
  rttTag: 'V8.58.0',
  rttCommit: '4d8feab',
  timestampBits: 32,
  channelIndex: 2,
} as const;

const packets = [
  encodeSystemViewPacket(SystemViewEventId.TRACE_START, new Uint8Array(), 0),
  encodeSystemViewPacket(
    SystemViewEventId.INIT,
    words(1000000, 168000000, 0x20000000, 0),
    0,
  ),
  encodeSystemViewPacket(
    SystemViewEventId.SYSDESC,
    encodeSystemViewString('N=OrbitD02,D=STM32F407VET6,O=FreeRTOS,I#15=SysTick'),
    1,
  ),
  encodeSystemViewPacket(SystemViewEventId.TASK_CREATE, words(1), 1),
  encodeSystemViewPacket(
    SystemViewEventId.TASK_INFO,
    concatSystemViewBytes(words(1, 5), encodeSystemViewString('defaultTask')),
    1,
  ),
  encodeSystemViewPacket(SystemViewEventId.STACK_INFO, words(1, 0x20001000, 1024, 128), 0),
  encodeSystemViewPacket(SystemViewEventId.TASK_START_READY, words(1), 1),
  encodeSystemViewPacket(SystemViewEventId.TASK_START_EXEC, words(1), 1),
  encodeSystemViewPacket(SystemViewEventId.ISR_ENTER, words(15), 2),
  encodeSystemViewPacket(SystemViewEventId.ISR_EXIT, new Uint8Array(), 1),
  encodeSystemViewPacket(SystemViewEventId.TASK_STOP_EXEC, new Uint8Array(), 1),
  encodeSystemViewPacket(SystemViewEventId.TASK_STOP_READY, words(1, 2), 1),
  encodeSystemViewPacket(SystemViewEventId.OVERFLOW, words(3), 2),
  encodeSystemViewPacket(
    SystemViewEventId.EX,
    words(7),
    1,
    { extendedEventId: SystemViewExtendedEventId.MARK },
  ),
  encodeSystemViewPacket(0x400, words(99), 1),
];

export const SYSTEMVIEW_V4120_REFERENCE_BYTES = concatSystemViewBytes(
  encodeSystemViewSync(),
  ...packets,
);

export const SYSTEMVIEW_V4120_REFERENCE_EXPECTED = [
  { eventId: SystemViewEventId.TRACE_START, timestamp: 0 },
  { eventId: SystemViewEventId.INIT, timestamp: 0 },
  { eventId: SystemViewEventId.SYSDESC, timestamp: 1 },
  { eventId: SystemViewEventId.TASK_CREATE, timestamp: 2 },
  { eventId: SystemViewEventId.TASK_INFO, timestamp: 3 },
  { eventId: SystemViewEventId.STACK_INFO, timestamp: 3 },
  { eventId: SystemViewEventId.TASK_START_READY, timestamp: 4 },
  { eventId: SystemViewEventId.TASK_START_EXEC, timestamp: 5 },
  { eventId: SystemViewEventId.ISR_ENTER, timestamp: 7 },
  { eventId: SystemViewEventId.ISR_EXIT, timestamp: 8 },
  { eventId: SystemViewEventId.TASK_STOP_EXEC, timestamp: 9 },
  { eventId: SystemViewEventId.TASK_STOP_READY, timestamp: 10 },
  { eventId: SystemViewEventId.OVERFLOW, timestamp: 12 },
  { eventId: SystemViewEventId.EX, timestamp: 13 },
  { eventId: 0x400, timestamp: 14 },
] as const;
