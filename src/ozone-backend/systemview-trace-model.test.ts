import { describe, expect, it } from 'vitest';
import { SystemViewApiSpanTracker } from './systemview-api-span';
import { SystemViewEventDecoder } from './systemview-event-decoder';
import { SystemViewTraceModel } from './systemview-trace-model';
import {
  concatSystemViewBytes,
  encodeSystemViewPacket,
  encodeSystemViewVarUint,
  SystemViewEventId,
} from './systemview-protocol';

const words = (...values: readonly number[]): Uint8Array =>
  concatSystemViewBytes(...values.map(value => encodeSystemViewVarUint(value)));

function decodeEvents(bytes: Uint8Array) {
  const decoder = new SystemViewEventDecoder();
  return decoder.push(bytes).events;
}

describe('SystemViewApiSpanTracker', () => {
  it('pairs nested OS API events with END_CALL and preserves scalar arguments', () => {
    const bytes = concatSystemViewBytes(
      encodeSystemViewPacket(33, words(1, 2), 1),
      encodeSystemViewPacket(34, words(3), 1),
      encodeSystemViewPacket(SystemViewEventId.END_CALL, words(34, 99), 1),
      encodeSystemViewPacket(SystemViewEventId.END_CALL, words(33, 7), 1),
    );
    const tracker = new SystemViewApiSpanTracker();
    for (const event of decodeEvents(bytes)) tracker.apply(event);
    const snapshot = tracker.snapshot();

    expect(snapshot.spans).toEqual([
      {
        functionId: 34,
        contextKey: 'unknown',
        startTimestamp: 2,
        endTimestamp: 3,
        arguments: [3],
        argumentsRaw: Uint8Array.from([3]),
        returnValue: 99,
        complete: true,
      },
      {
        functionId: 33,
        contextKey: 'unknown',
        startTimestamp: 1,
        endTimestamp: 4,
        arguments: [1, 2],
        argumentsRaw: Uint8Array.from([1, 2]),
        returnValue: 7,
        complete: true,
      },
    ]);
    expect(snapshot.diagnostics).toHaveLength(0);
  });

  it('closes non-top spans as incomplete instead of inventing nesting', () => {
    const bytes = concatSystemViewBytes(
      encodeSystemViewPacket(33, words(1), 1),
      encodeSystemViewPacket(34, words(2), 1),
      encodeSystemViewPacket(SystemViewEventId.END_CALL, words(33), 1),
    );
    const tracker = new SystemViewApiSpanTracker();
    for (const event of decodeEvents(bytes)) tracker.apply(event);
    expect(tracker.snapshot().spans.map(span => ({ functionId: span.functionId, complete: span.complete }))).toEqual([
      { functionId: 34, complete: false },
      { functionId: 33, complete: true },
    ]);
    expect(tracker.snapshot().diagnostics.some(diagnostic => diagnostic.code === 'missing-exit')).toBe(true);
  });
});

describe('SystemViewTraceModel', () => {
  it('aggregates normalized events, metadata, RTOS state, and API spans without DAP coupling', () => {
    const bytes = concatSystemViewBytes(
      encodeSystemViewPacket(SystemViewEventId.TRACE_START, new Uint8Array(), 0),
      encodeSystemViewPacket(SystemViewEventId.INIT, words(1, 168000000, 0x20000000, 0), 0),
      encodeSystemViewPacket(SystemViewEventId.TASK_START_EXEC, words(1), 1),
      encodeSystemViewPacket(33, words(1), 1),
      encodeSystemViewPacket(SystemViewEventId.END_CALL, words(33), 1),
      encodeSystemViewPacket(SystemViewEventId.OVERFLOW, words(2), 1),
    );
    const model = new SystemViewTraceModel();
    model.push(bytes);
    const snapshot = model.snapshot();

    expect(snapshot.events.map(event => event.kind)).toEqual([
      'unknown',
      'metadata',
      'task',
      'api-enter',
      'api-exit',
      'overflow',
    ]);
    expect(snapshot.metadata.cpuFrequency).toBe(168000000);
    expect(snapshot.api.spans).toHaveLength(1);
    expect(snapshot.rtos.dataGaps).toEqual([{ startTimestamp: 4, reason: 'SystemView overflow' }]);
    expect(snapshot.rtos.trusted).toBe(false);
  });
});
