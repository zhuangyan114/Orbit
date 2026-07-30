import { describe, expect, it } from 'vitest';
import { SystemViewEventDecoder } from './systemview-event-decoder';
import { SystemViewRtosStateMachine } from './systemview-rtos-state';
import {
  concatSystemViewBytes,
  encodeSystemViewPacket,
  encodeSystemViewSync,
  encodeSystemViewVarUint,
  SystemViewEventId,
} from './systemview-protocol';

const words = (...values: readonly number[]): Uint8Array =>
  concatSystemViewBytes(...values.map(value => encodeSystemViewVarUint(value)));

function decode(bytes: Uint8Array) {
  const decoder = new SystemViewEventDecoder();
  const batch = decoder.push(bytes);
  expect(batch.bufferedBytes).toBe(0);
  return batch;
}

describe('SystemViewRtosStateMachine', () => {
  it('reconstructs task ready/running, nested ISR, and idle intervals', () => {
    const bytes = concatSystemViewBytes(
      encodeSystemViewSync(),
      encodeSystemViewPacket(SystemViewEventId.TRACE_START, new Uint8Array(), 0),
      encodeSystemViewPacket(SystemViewEventId.TASK_CREATE, words(1), 0),
      encodeSystemViewPacket(SystemViewEventId.TASK_START_READY, words(1), 1),
      encodeSystemViewPacket(SystemViewEventId.TASK_START_EXEC, words(1), 1),
      encodeSystemViewPacket(SystemViewEventId.ISR_ENTER, words(15), 1),
      encodeSystemViewPacket(SystemViewEventId.ISR_ENTER, words(16), 1),
      encodeSystemViewPacket(SystemViewEventId.ISR_EXIT, new Uint8Array(), 1),
      encodeSystemViewPacket(SystemViewEventId.ISR_EXIT, new Uint8Array(), 1),
      encodeSystemViewPacket(SystemViewEventId.TASK_STOP_EXEC, new Uint8Array(), 1),
      encodeSystemViewPacket(SystemViewEventId.TASK_STOP_READY, words(1, 2), 1),
      encodeSystemViewPacket(SystemViewEventId.IDLE, new Uint8Array(), 1),
      encodeSystemViewPacket(SystemViewEventId.TRACE_STOP, new Uint8Array(), 1),
    );
    const state = new SystemViewRtosStateMachine();
    state.applyBatch(decode(bytes));
    const snapshot = state.snapshot();

    expect(snapshot.trusted).toBe(true);
    expect(snapshot.currentContext).toBe('unknown');
    expect(snapshot.isrDepth).toBe(0);
    expect(snapshot.tasks).toEqual([{ taskId: 1, state: 'blocked', ready: false }]);
    expect(snapshot.readyIntervals).toEqual([{ taskId: 1, startTimestamp: 1, endTimestamp: 8 }]);
    expect(snapshot.contextSegments).toEqual([
      { kind: 'task', taskId: 1, startTimestamp: 2, endTimestamp: 3 },
      { kind: 'isr', interruptId: 15, startTimestamp: 3, endTimestamp: 4 },
      { kind: 'isr', interruptId: 16, startTimestamp: 4, endTimestamp: 5 },
      { kind: 'isr', interruptId: 15, startTimestamp: 5, endTimestamp: 6 },
      { kind: 'task', taskId: 1, startTimestamp: 6, endTimestamp: 7 },
      { kind: 'idle', startTimestamp: 9, endTimestamp: 10 },
    ]);
  });

  it('turns overflow into a data gap and requires a new trace epoch before rebuilding state', () => {
    const bytes = concatSystemViewBytes(
      encodeSystemViewPacket(SystemViewEventId.TRACE_START, new Uint8Array(), 0),
      encodeSystemViewPacket(SystemViewEventId.TASK_START_EXEC, words(1), 1),
      encodeSystemViewPacket(SystemViewEventId.OVERFLOW, words(4), 1),
      encodeSystemViewPacket(SystemViewEventId.TASK_START_EXEC, words(1), 1),
      encodeSystemViewPacket(SystemViewEventId.INIT, words(1, 168000000, 0x20000000, 0), 1),
      encodeSystemViewPacket(SystemViewEventId.TASK_START_EXEC, words(1), 1),
      encodeSystemViewPacket(SystemViewEventId.TRACE_STOP, new Uint8Array(), 1),
    );
    const state = new SystemViewRtosStateMachine();
    state.applyBatch(decode(bytes));
    const snapshot = state.snapshot();

    expect(snapshot.trusted).toBe(true);
    expect(snapshot.dataGaps).toEqual([{ startTimestamp: 2, endTimestamp: 4, reason: 'SystemView overflow' }]);
    expect(snapshot.contextSegments).toEqual([
      { kind: 'task', taskId: 1, startTimestamp: 1, endTimestamp: 2 },
      { kind: 'task', taskId: 1, startTimestamp: 5, endTimestamp: 6 },
    ]);
    expect(snapshot.tasks).toEqual([{ taskId: 1, state: 'running', ready: false }]);
  });
});
