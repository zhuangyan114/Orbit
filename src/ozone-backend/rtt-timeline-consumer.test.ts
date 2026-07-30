import { describe, expect, it, vi } from 'vitest';
import { NativeScheduler } from './native-scheduler';
import { RttChannelRegistry } from './rtt-channel-registry';
import { RttTimelineConsumer, parseRttTimelineSignal } from './rtt-timeline-consumer';
import { RttStreamScheduler } from './rtt-stream-scheduler';
import { RttTransportAdapter, RttTransportBackend } from './rtt-transport';
import { fnv1a, RTTB_CHECKSUM_OFFSET, RTTB_FRAME_SIZE } from './rtt-frame-decoder';

function makeFrame(sequence: number, tick: number): Uint8Array {
  const bytes = new Uint8Array(RTTB_FRAME_SIZE);
  bytes.set([0x52, 0x54, 0x54, 0x42]);
  const view = new DataView(bytes.buffer);
  view.setUint16(4, 1, true);
  view.setUint16(6, RTTB_FRAME_SIZE, true);
  view.setUint32(8, sequence, true);
  view.setUint32(12, tick, true);
  for (let index = 16; index < RTTB_CHECKSUM_OFFSET; index++) bytes[index] = index + sequence;
  view.setUint32(RTTB_CHECKSUM_OFFSET, fnv1a(bytes.subarray(0, RTTB_CHECKSUM_OFFSET)), true);
  return bytes;
}

describe('RttTimelineConsumer', () => {
  it('routes reads through the timeline scheduler and maps target ticks to points', async () => {
    const chunks = [makeFrame(1, 100).subarray(0, 20), makeFrame(1, 100).subarray(20)];
    const backend: RttTransportBackend = {
      kind: 'native',
      startRtt: vi.fn(async () => ({ ok: true, message: 'started' })),
      stopRtt: vi.fn(async () => ({ ok: true, message: 'stopped' })),
      readRtt: vi.fn(async () => ({ ok: true, data: { bytes: chunks.shift() || new Uint8Array() } })),
    };
    const transport = new RttTransportAdapter(backend);
    await transport.start();
    const registry = new RttChannelRegistry();
    registry.register({
      index: 1,
      name: 'OrbitRTTBench',
      purpose: 'RTTB Timeline sample stream',
      consumers: ['timeline'],
      buffer: { targetSizeBytes: 4096, hostQueueCapacityBytes: 4096 },
    });
    const scheduler = new RttStreamScheduler(transport, registry, new NativeScheduler());
    const consumer = new RttTimelineConsumer(scheduler, 1);
    expect(parseRttTimelineSignal('rttb.payload[0]', '#4EC9B0')).toMatchObject({ payloadOffset: 0 });
    expect(parseRttTimelineSignal('counter', '#4EC9B0')).toBeUndefined();
    expect(consumer.configure([{ expression: 'rttb.payload[0]', color: '#4EC9B0', payloadOffset: 0 }]).ok).toBe(true);

    const first = await consumer.poll(64);
    const second = await consumer.poll(64);
    expect(first.ok && first.data.snapshots).toEqual([]);
    expect(second).toMatchObject({
      ok: true,
      data: {
        snapshots: [{
          expression: 'rttb.payload[0]',
          data: [{ timestamp: 100, value: 17, startsNewSegment: true }],
        }],
      },
    });
    expect(scheduler.metrics('timeline', 1)).toMatchObject({ decodedFrames: 1, decodeErrors: 0 });
  });

  it('keeps a forward sequence gap in diagnostics without fragmenting the Timeline', async () => {
    const chunks = [makeFrame(10, 100), makeFrame(12, 120)];
    const backend: RttTransportBackend = {
      kind: 'native',
      startRtt: vi.fn(async () => ({ ok: true, message: 'started' })),
      stopRtt: vi.fn(async () => ({ ok: true, message: 'stopped' })),
      readRtt: vi.fn(async () => ({ ok: true, data: { bytes: chunks.shift() || new Uint8Array() } })),
    };
    const transport = new RttTransportAdapter(backend);
    await transport.start();
    const registry = new RttChannelRegistry();
    registry.register({
      index: 1,
      name: 'OrbitRTTBench',
      purpose: 'RTTB Timeline sample stream',
      consumers: ['timeline'],
      buffer: { targetSizeBytes: 4096, hostQueueCapacityBytes: 4096 },
    });
    const scheduler = new RttStreamScheduler(transport, registry, new NativeScheduler());
    const consumer = new RttTimelineConsumer(scheduler, 1);
    consumer.configure([{ expression: 'rttb.payload[0]', color: '#4EC9B0', payloadOffset: 0 }]);

    const first = await consumer.poll(64);
    const second = await consumer.poll(64);
    expect(first.ok && first.data.snapshots[0].data[0].startsNewSegment).toBe(true);
    expect(second.ok && second.data.decode.sequenceGaps).toHaveLength(1);
    expect(second.ok && second.data.decode.sequenceGaps[0].outOfOrder).toBe(false);
    expect(second.ok && second.data.snapshots[0].data[0].startsNewSegment).toBeUndefined();
    expect(scheduler.metrics('timeline', 1)).toMatchObject({ sequenceGaps: 1, missingFrames: 1 });
  });

  it('does not accumulate time drift when several frames share one target tick', async () => {
    const join = (...frames: Uint8Array[]) => {
      const bytes = new Uint8Array(frames.reduce((total, frame) => total + frame.length, 0));
      let offset = 0;
      for (const frame of frames) {
        bytes.set(frame, offset);
        offset += frame.length;
      }
      return bytes;
    };
    const chunks = [
      join(makeFrame(1, 100), makeFrame(2, 100)),
      join(makeFrame(3, 200), makeFrame(4, 200)),
    ];
    const backend: RttTransportBackend = {
      kind: 'native',
      startRtt: vi.fn(async () => ({ ok: true, message: 'started' })),
      stopRtt: vi.fn(async () => ({ ok: true, message: 'stopped' })),
      readRtt: vi.fn(async () => ({ ok: true, data: { bytes: chunks.shift() || new Uint8Array() } })),
    };
    const transport = new RttTransportAdapter(backend);
    await transport.start();
    const registry = new RttChannelRegistry();
    registry.register({
      index: 1,
      name: 'OrbitRTTBench',
      purpose: 'RTTB Timeline sample stream',
      consumers: ['timeline'],
      buffer: { targetSizeBytes: 4096, hostQueueCapacityBytes: 4096 },
    });
    const scheduler = new RttStreamScheduler(transport, registry, new NativeScheduler());
    const consumer = new RttTimelineConsumer(scheduler, 1);
    consumer.configure([{ expression: 'rttb.payload[0]', color: '#4EC9B0', payloadOffset: 0 }]);

    const first = await consumer.poll(128);
    const second = await consumer.poll(128);

    expect(first.ok && first.data.snapshots[0].data.map(point => point.timestamp)).toEqual([100, 100]);
    expect(second.ok && second.data.snapshots[0].data.map(point => point.timestamp)).toEqual([200, 200]);
  });

  it('starts a new Timeline segment for an out-of-order frame', async () => {
    const chunks = [makeFrame(10, 100), makeFrame(9, 90)];
    const backend: RttTransportBackend = {
      kind: 'native',
      startRtt: vi.fn(async () => ({ ok: true, message: 'started' })),
      stopRtt: vi.fn(async () => ({ ok: true, message: 'stopped' })),
      readRtt: vi.fn(async () => ({ ok: true, data: { bytes: chunks.shift() || new Uint8Array() } })),
    };
    const transport = new RttTransportAdapter(backend);
    await transport.start();
    const registry = new RttChannelRegistry();
    registry.register({
      index: 1,
      name: 'OrbitRTTBench',
      purpose: 'RTTB Timeline sample stream',
      consumers: ['timeline'],
      buffer: { targetSizeBytes: 4096, hostQueueCapacityBytes: 4096 },
    });
    const scheduler = new RttStreamScheduler(transport, registry, new NativeScheduler());
    const consumer = new RttTimelineConsumer(scheduler, 1);
    consumer.configure([{ expression: 'rttb.payload[0]', color: '#4EC9B0', payloadOffset: 0 }]);

    await consumer.poll(64);
    const second = await consumer.poll(64);

    expect(second.ok && second.data.decode.sequenceGaps[0]).toMatchObject({
      outOfOrder: true,
      missingFrames: 0,
    });
    expect(second.ok && second.data.snapshots[0].data[0].startsNewSegment).toBe(true);
  });

  it('rebases target ticks after reset so Timeline time remains monotonic', async () => {
    const chunks = [makeFrame(10, 100), makeFrame(0, 5)];
    const backend: RttTransportBackend = {
      kind: 'native',
      startRtt: vi.fn(async () => ({ ok: true, message: 'started' })),
      stopRtt: vi.fn(async () => ({ ok: true, message: 'stopped' })),
      readRtt: vi.fn(async () => ({ ok: true, data: { bytes: chunks.shift() || new Uint8Array() } })),
    };
    const transport = new RttTransportAdapter(backend);
    await transport.start();
    const registry = new RttChannelRegistry();
    registry.register({
      index: 1,
      name: 'OrbitRTTBench',
      purpose: 'RTTB Timeline sample stream',
      consumers: ['timeline'],
      buffer: { targetSizeBytes: 4096, hostQueueCapacityBytes: 4096 },
    });
    const scheduler = new RttStreamScheduler(transport, registry, new NativeScheduler());
    const consumer = new RttTimelineConsumer(scheduler, 1);
    consumer.configure([{ expression: 'rttb.payload[0]', color: '#4EC9B0', payloadOffset: 0 }]);

    const beforeReset = await consumer.poll(64);
    consumer.reset();
    const afterReset = await consumer.poll(64);

    expect(beforeReset.ok && beforeReset.data.snapshots[0].data[0].timestamp).toBe(100);
    expect(afterReset).toMatchObject({
      ok: true,
      data: {
        snapshots: [{
          data: [{ timestamp: 101, value: 16, startsNewSegment: true }],
        }],
      },
    });
  });
});
