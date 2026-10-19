import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoundedMetric } from '../utils/bounded-metric';
import { ProbeTimelineSampler, ProbeTimelineSamplerHost } from './probe-timeline-sampler';

const spec = { expression: 'power', address: 0x20000400, size: 4 };

function fixture(options: { start?: any; read?: () => any } = {}) {
  let hostMs = 1_000_000;
  let value = 0;
  const commands: any[] = [];
  const accepted: Array<{ value: number; timestamp: number }> = [];
  // The probe clock runs 900 s behind the host; replies take 2 ms.
  const read = options.read ?? (() => {
    hostMs += 10;
    const probeNowMs = hostMs - 900_000 - 2;
    return {
      ok: true,
      data: {
        probeNowUs: probeNowMs * 1000,
        probeNowAgeUs: 0,
        pendingBytes: 0,
        frames: [1.0, 0.9].map(ageMs => ({
          timestampUs: (probeNowMs - ageMs) * 1000,
          values: [{ expression: 'power', value: ++value, display: '', hex: '' }],
        })),
        stats: { droppedFrames: 0, skippedTicks: 0, suspends: 0, vendorReads: 0 },
      },
    };
  });
  const host: ProbeTimelineSamplerHost & { running: boolean; fallback: number } = {
    running: true,
    fallback: 0,
    execute: vi.fn(async (command: any) => {
      commands.push(command);
      if (command.cmd === 'startProbeSampling') {
        return options.start ?? { ok: true, data: { periodUs: command.periodUs, estFrameUs: 90, maxFrameBytes: 15, run: 7 } };
      }
      if (command.cmd === 'readProbeSampling') return read();
      return { ok: true, data: {} };
    }),
    nowMs: () => hostMs,
    timelineNowMs: ms => ms,
    isTargetRunning: () => host.running,
    beginTargetRead: () => true,
    endTargetRead: () => {},
    accept: (v, timestamp) => accepted.push({ value: v.value as number, timestamp }),
    fallBackToHost: () => { host.fallback++; },
    counts: { attempts: 0, gateDeferred: 0, readsCompleted: 0 },
    commitMs: new BoundedMetric(16),
  };
  const sampler = new ProbeTimelineSampler(host);
  return { sampler, host, commands, accepted };
}

describe('ProbeTimelineSampler', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the probe interval and starts with the probe', async () => {
    const f = fixture();
    expect(await f.sampler.start([spec], 0.5)).toBe(0.5);
    expect(f.commands[0]).toEqual({ cmd: 'startProbeSampling', specs: [spec], periodUs: 500 });
    expect(f.sampler.active).toBe(true);
  });

  it('holds frames until the clock settles, then keeps the probe spacing', async () => {
    const f = fixture();
    await f.sampler.start([spec], 1);
    for (let i = 0; i < 7; i++) await f.sampler.poll();
    expect(f.accepted).toEqual([]);
    await f.sampler.poll();
    expect(f.accepted.map(p => p.value)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
    expect(f.accepted[1].timestamp - f.accepted[0].timestamp).toBeCloseTo(0.1, 6);
    // A constant link latency is indistinguishable from clock offset, so the
    // newest frame (0.9 ms older than the probe reading) lands 0.9 ms before the reply.
    expect(f.host.nowMs() - f.accepted.at(-1)!.timestamp).toBeCloseTo(0.9, 6);
  });

  it('drops frames read while the core is stopped', async () => {
    const f = fixture();
    await f.sampler.start([spec], 1);
    for (let i = 0; i < 8; i++) await f.sampler.poll();
    f.accepted.length = 0;
    f.host.running = false;
    await f.sampler.poll();
    f.host.running = true;
    await f.sampler.poll();
    expect(f.accepted.map(p => p.value)).toEqual([19, 20]);
  });

  it('declines when the probe cannot sample', async () => {
    const f = fixture({ start: { ok: false, errorCode: 'UnsupportedCapability', error: 'no XR-DAP' } });
    expect(await f.sampler.start([spec], 1)).toBeNull();
    expect(f.sampler.active).toBe(false);
  });

  it('declines and stops a start that reports no period', async () => {
    const f = fixture({ start: { ok: true, data: { run: 3 } } });
    expect(await f.sampler.start([spec], 1)).toBeNull();
    expect(f.commands.at(-1)).toEqual({ cmd: 'stopProbeSampling', run: 3 });
  });

  it('stops the probe and falls back to the host when a read fails', async () => {
    const f = fixture({ read: () => ({ ok: false, errorCode: 'InvalidState', error: 'stopped' }) });
    await f.sampler.start([spec], 1);
    await f.sampler.poll();
    expect(f.sampler.active).toBe(false);
    expect(f.host.fallback).toBe(1);
    expect(f.commands.at(-1)).toEqual({ cmd: 'stopProbeSampling', run: 7 });
  });

  it('stops a start that completes after stop()', async () => {
    const f = fixture();
    const starting = f.sampler.start([spec], 1);
    f.sampler.stop();
    expect(await starting).toBeNull();
    expect(f.sampler.active).toBe(false);
    expect(f.commands.at(-1)).toEqual({ cmd: 'stopProbeSampling', run: 7 });
  });

  it('stop() ends its own run once', async () => {
    const f = fixture();
    await f.sampler.start([spec], 1);
    f.sampler.stop();
    f.sampler.stop();
    expect(f.commands.filter(c => c.cmd === 'stopProbeSampling')).toEqual([{ cmd: 'stopProbeSampling', run: 7 }]);
  });
});
