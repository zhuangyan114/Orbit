import { describe, expect, it } from 'vitest';
import {
  concatSystemViewBytes,
  encodeSystemViewPacket,
  encodeSystemViewVarUint,
  readSystemViewVarUint,
  SystemViewEventId,
} from './systemview-protocol';
import { SystemViewEventDecoder } from './systemview-event-decoder';
import {
  SYSTEMVIEW_V4120_REFERENCE_BYTES,
  SYSTEMVIEW_V4120_REFERENCE_EXPECTED,
} from './systemview-reference-fixture';

function collectReferenceEvents(decoder: SystemViewEventDecoder) {
  const events = [] as ReturnType<SystemViewEventDecoder['push']>['events'][number][];
  const diagnostics = [] as ReturnType<SystemViewEventDecoder['push']>['diagnostics'][number][];
  const chunkSizes = [1, 2, 3, 5, 8, 13, 21];
  let offset = 0;
  let chunk = 0;
  while (offset < SYSTEMVIEW_V4120_REFERENCE_BYTES.length) {
    const size = Math.min(chunkSizes[chunk % chunkSizes.length], SYSTEMVIEW_V4120_REFERENCE_BYTES.length - offset);
    const result = decoder.push(SYSTEMVIEW_V4120_REFERENCE_BYTES.slice(offset, offset + size));
    events.push(...result.events);
    diagnostics.push(...result.diagnostics);
    offset += size;
    chunk += 1;
  }
  const finished = decoder.finish();
  events.push(...finished.events);
  diagnostics.push(...finished.diagnostics);
  return { events, diagnostics };
}

describe('SystemViewEventDecoder', () => {
  it('matches the official least-significant-group-first varuint example', () => {
    expect([...encodeSystemViewVarUint(500)]).toEqual([0xf4, 0x03]);
    expect(readSystemViewVarUint(Uint8Array.from([0xf4, 0x03]), 0)).toEqual({
      ok: true,
      value: 500,
      nextOffset: 2,
    });
  });

  it('decodes a source-derived V4.12.0 reference vector across arbitrary RTT fragments', () => {
    const result = collectReferenceEvents(new SystemViewEventDecoder());
    expect(result.events.map(event => ({ eventId: event.eventId, timestamp: event.timestamp }))).toEqual(
      SYSTEMVIEW_V4120_REFERENCE_EXPECTED,
    );
    expect(result.events.find(event => event.eventId === SystemViewEventId.SYSDESC)?.payload).toEqual({
      kind: 'system-description',
      text: 'N=OrbitD02,D=STM32F407VET6,O=FreeRTOS,I#15=SysTick',
    });
    expect(result.events.find(event => event.eventId === SystemViewEventId.TASK_INFO)?.payload).toEqual({
      kind: 'task-info',
      taskId: 1,
      priority: 5,
      name: 'defaultTask',
    });
    expect(result.events.find(event => event.eventId === SystemViewEventId.EX)?.payload).toMatchObject({
      kind: 'extended',
      extendedEventId: 0,
      values: [7],
    });
    expect(result.events.find(event => event.eventId === 0x400)?.payload).toEqual({
      kind: 'raw',
      raw: Uint8Array.from([99]),
    });
    expect(result.diagnostics.some(diagnostic => diagnostic.code === 'sync')).toBe(true);
    expect(result.diagnostics.some(diagnostic => diagnostic.code === 'overflow')).toBe(true);
    expect(result.diagnostics.some(diagnostic => diagnostic.code === 'truncated-packet')).toBe(false);
  });

  it('keeps an incomplete length packet until the next read and reports truncation at finish', () => {
    const packet = encodeSystemViewPacket(0x400, Uint8Array.from([0x01]), 3);
    const decoder = new SystemViewEventDecoder();
    const first = decoder.push(packet.slice(0, packet.length - 1));
    expect(first.events).toHaveLength(0);
    expect(first.bufferedBytes).toBeGreaterThan(0);
    const second = decoder.push(packet.slice(packet.length - 1));
    expect(second.events).toHaveLength(1);
    expect(decoder.finish().diagnostics.some(diagnostic => diagnostic.code === 'truncated-packet')).toBe(false);

    const truncated = new SystemViewEventDecoder();
    truncated.push(packet.slice(0, packet.length - 1));
    const finished = truncated.finish('channel-gone');
    expect(finished.diagnostics.map(diagnostic => diagnostic.code)).toEqual(
      expect.arrayContaining(['truncated-packet', 'channel-gone']),
    );
  });

  it('resynchronizes at the official ten-zero sync marker after an invalid length', () => {
    const invalid = Uint8Array.from([0x18, 0x80, 0x80, 0x80, 0x80, 0xff]);
    const valid = encodeSystemViewPacket(SystemViewEventId.TRACE_START, new Uint8Array(), 4);
    const decoder = new SystemViewEventDecoder();
    const result = decoder.push(concatSystemViewBytes(invalid, new Uint8Array(10), valid));
    expect(result.events.map(event => event.eventId)).toEqual([SystemViewEventId.TRACE_START]);
    expect(result.diagnostics.some(diagnostic => diagnostic.code === 'invalid-length')).toBe(true);
    expect(result.diagnostics.some(diagnostic => diagnostic.code === 'resynchronized')).toBe(true);
  });
});
