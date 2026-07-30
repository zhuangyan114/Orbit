import { describe, expect, it, vi } from 'vitest';
import { NativeScheduler } from './native-scheduler';
import { RttChannelRegistry, RttChannelDescriptor } from './rtt-channel-registry';
import { RttStreamScheduler } from './rtt-stream-scheduler';
import { RttTransportAdapter, RttTransportBackend, RttTransportBackendResult } from './rtt-transport';

function descriptor(consumers: RttChannelDescriptor['consumers'] = ['rtt']): RttChannelDescriptor {
  return {
    index: 1,
    name: 'trace',
    purpose: 'target trace stream',
    consumers,
    buffer: { targetSizeBytes: 4096, hostQueueCapacityBytes: 4 },
  };
}

async function makeScheduler(
  read: () => Promise<RttTransportBackendResult<{ bytes: Uint8Array }>>,
  options: ConstructorParameters<typeof RttStreamScheduler>[3] = {},
  consumers: RttChannelDescriptor['consumers'] = ['rtt'],
) {
  const backend: RttTransportBackend = {
    kind: 'native',
    startRtt: vi.fn(async () => ({ ok: true, message: 'started' })),
    stopRtt: vi.fn(async () => ({ ok: true, message: 'stopped' })),
    readRtt: vi.fn(read),
  };
  const transport = new RttTransportAdapter(backend);
  await transport.start();
  const registry = new RttChannelRegistry();
  registry.register(descriptor(consumers));
  const nativeScheduler = new NativeScheduler();
  const scheduler = new RttStreamScheduler(transport, registry, nativeScheduler, options);
  return { backend, transport, registry, nativeScheduler, scheduler };
}

describe('RttStreamScheduler', () => {
  it('maps RTT reads to NativeScheduler priority and keeps control above Watch and RTT', async () => {
    let releaseFirst!: () => void;
    const firstRead = new Promise<void>(resolve => { releaseFirst = resolve; });
    const order: string[] = [];
    let readCount = 0;
    const { scheduler, nativeScheduler } = await makeScheduler(async () => {
      readCount++;
      order.push(readCount === 1 ? 'rtt' : 'watch');
      if (readCount === 1) await firstRead;
      return { ok: true, data: { bytes: new Uint8Array([readCount]) } };
    }, {}, ['rtt', 'watch', 'timeline']);

    const rtt = scheduler.scheduleRead({ consumer: 'rtt', channelIndex: 1, size: 1 });
    const watch = scheduler.scheduleRead({ consumer: 'watch', channelIndex: 1, size: 1 });
    const control = nativeScheduler.schedule(async () => {
      order.push('control');
      return true;
    }, { priority: 'control', label: 'halt' });

    releaseFirst();
    await expect(rtt).resolves.toMatchObject({ ok: true });
    await expect(control).resolves.toBe(true);
    await expect(watch).resolves.toMatchObject({ ok: true });
    expect(order).toEqual(['rtt', 'control', 'watch']);
  });

  it('does not requeue a Native read that is already inside the owner scheduler', async () => {
    let ownerScheduler!: NativeScheduler;
    const backend: RttTransportBackend = {
      kind: 'native',
      startRtt: vi.fn(async () => ({ ok: true, message: 'started' })),
      stopRtt: vi.fn(async () => ({ ok: true, message: 'stopped' })),
      readRtt: vi.fn(async (_bufferIndex, _size, options) => {
        if (!options?.scheduledByOwnerScheduler) {
          return ownerScheduler.schedule(
            async () => ({ ok: true, data: { bytes: new Uint8Array([7]) } }),
            { priority: 'timeline', label: 'nested-rtt-read' },
          );
        }
        return { ok: true, data: { bytes: new Uint8Array([7]) } };
      }),
    };
    const transport = new RttTransportAdapter(backend);
    await transport.start();
    const registry = new RttChannelRegistry();
    registry.register(descriptor());
    ownerScheduler = new NativeScheduler();
    const scheduler = new RttStreamScheduler(transport, registry, ownerScheduler);

    await expect(scheduler.scheduleRead({ consumer: 'rtt', channelIndex: 1, size: 1 })).resolves.toMatchObject({
      ok: true,
      data: { read: { bytes: new Uint8Array([7]) } },
    });
  });

  it('bounds host queue, records drops, short/empty reads, rates and maximum delay', async () => {
    let now = 0;
    const reads = [
      new Uint8Array([1, 2]),
      new Uint8Array(),
      new Uint8Array([3, 4, 5, 6]),
    ];
    const { scheduler } = await makeScheduler(async () => ({
      ok: true,
      data: { bytes: reads.shift() || new Uint8Array() },
    }), { clock: () => now });

    const shortRead = await scheduler.scheduleRead({ consumer: 'rtt', channelIndex: 1, size: 8 });
    expect(shortRead).toMatchObject({ ok: true, data: { read: { requestedSize: 8, bytes: new Uint8Array([1, 2]) } } });

    now = 100;
    const emptyRead = await scheduler.scheduleRead({ consumer: 'rtt', channelIndex: 1, size: 8 });
    expect(emptyRead).toMatchObject({ ok: true, data: { read: { empty: true } } });

    now = 200;
    const queuedRead = await scheduler.scheduleRead({ consumer: 'rtt', channelIndex: 1, size: 8 });
    expect(queuedRead).toMatchObject({ ok: true, data: { droppedBytes: 2, queueDepthBytes: 4 } });

    now = 275;
    const buffered = scheduler.readBuffered('rtt', 1, 8);
    expect(buffered).toMatchObject({
      ok: true,
      data: { bytes: new Uint8Array([3, 4, 5, 6]), maxDelayMs: 75, empty: false },
    });
    expect(scheduler.metrics('rtt', 1)).toMatchObject({
      bytesRead: 6,
      readCalls: 3,
      emptyReads: 1,
      droppedBytes: 2,
      maxQueueDepthBytes: 4,
      maxDelayMs: 75,
      emptyReadRate: 1 / 3,
    });
  });

  it('enforces pending-read and byte quotas, cancellation, pause and resume', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { scheduler } = await makeScheduler(async () => {
      await gate;
      return { ok: true, data: { bytes: new Uint8Array([1]) } };
    }, {
      policies: {
        rtt: { maxPendingReads: 1, maxBytesPerSecond: 4 },
      },
    });

    const first = scheduler.scheduleRead({ consumer: 'rtt', channelIndex: 1, size: 4 });
    const full = await scheduler.scheduleRead({ consumer: 'rtt', channelIndex: 1, size: 1 });
    expect(full).toMatchObject({ ok: false, error: { code: 'QueueFull', category: 'queue' } });
    scheduler.cancel('rtt');
    release();
    await expect(first).resolves.toMatchObject({ ok: false, error: { code: 'Cancelled' } });

    const resume = scheduler.pause('rtt');
    await expect(scheduler.scheduleRead({ consumer: 'rtt', channelIndex: 1, size: 1 })).resolves.toMatchObject({
      ok: false,
      error: { code: 'Cancelled', diagnostics: { paused: true } },
    });
    resume();
  });

  it('maps negative returns, owner loss and channel disappearance without fallback', async () => {
    let next: RttTransportBackendResult<{ bytes: Uint8Array }> = {
      ok: false,
      errorCode: 'JLinkCallFailed',
      message: 'negative RTT return',
    };
    const { scheduler, transport, registry } = await makeScheduler(async () => next);

    await expect(scheduler.scheduleRead({ consumer: 'rtt', channelIndex: 1, size: 4 })).resolves.toMatchObject({
      ok: false,
      error: { code: 'ReadFailed', category: 'read' },
    });

    registry.unregister(1);
    await expect(scheduler.scheduleRead({ consumer: 'rtt', channelIndex: 1, size: 4 })).resolves.toMatchObject({
      ok: false,
      error: { code: 'ChannelGone', category: 'channel' },
    });

    registry.register(descriptor());
    next = { ok: true, data: { bytes: new Uint8Array([9]) } };
    transport.markOwnerLost('helper exited');
    await expect(scheduler.scheduleRead({ consumer: 'rtt', channelIndex: 1, size: 4 })).resolves.toMatchObject({
      ok: false,
      error: { code: 'OwnerLost', category: 'owner' },
    });
  });

  it('cancels pending reads when the physical owner is lost', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { scheduler, transport } = await makeScheduler(async () => {
      await gate;
      return { ok: true, data: { bytes: new Uint8Array([1]) } };
    });

    const pending = scheduler.scheduleRead({ consumer: 'rtt', channelIndex: 1, size: 1 });
    transport.markOwnerLost('native helper exited');
    release();

    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'OwnerLost' } });
    await expect(scheduler.scheduleRead({ consumer: 'rtt', channelIndex: 1, size: 1 })).resolves.toMatchObject({
      ok: false,
      error: { code: 'OwnerLost' },
    });
  });
});
