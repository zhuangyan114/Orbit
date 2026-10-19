import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DapSession, DebugProtocolMessage } from './dap-session';

function request(seq: number, command: string, args: Record<string, unknown> = {}): DebugProtocolMessage {
  return { type: 'request', seq, command, arguments: args };
}

const spec = { expression: 'power', address: 0x20000400, size: 4 };

/** Two frames per read, probe time = session time minus 2 ms of link latency. */
let probeValue = 0;
function probeRead(session: any) {
  const probeNowMs = session.nowMs() - 2;
  return {
    ok: true,
    data: {
      probeNowUs: probeNowMs * 1000,
      probeNowAgeUs: 0,
      pendingBytes: 0,
      frames: [1.0, 0.9].map(ageMs => ({
        timestampUs: (probeNowMs - ageMs) * 1000,
        values: [{ expression: 'power', value: ++probeValue, display: '', hex: '' }],
      })),
      stats: { droppedFrames: 0, skippedTicks: 0, suspends: 0, vendorReads: 0 },
    },
  };
}

function fixture(start: any = { ok: true, data: { periodUs: 1000, estFrameUs: 90, maxFrameBytes: 15, run: 1 } }, xrEnabled = true) {
  const commands: any[] = [];
  const backend = {
    execute: vi.fn(async (command: any) => {
      commands.push(command);
      if (command.cmd === 'prepareFastDataSampling') return { ok: true, data: [{ expression: 'power', spec }] };
      if (command.cmd === 'startProbeSampling') return start;
      if (command.cmd === 'readProbeSampling') return probeRead(session);
      if (command.cmd === 'getTargetState') return { ok: true, data: 'halted' };
      return { ok: true, data: {} };
    }),
    configureNativeSteps: vi.fn(),
    dispose() {},
  };
  const session = new DapSession(backend as any);
  (session as any)._probe = 'cmsis-dap';
  if (xrEnabled) (session as any).xrSamplingEnabled = true;
  (session as any).setTargetRunning(true);
  const sent: DebugProtocolMessage[] = [];
  session.on('send', message => sent.push(message));
  const startSampling = (args: Record<string, unknown> = {}) => (session as any).handleDataSamplingStart(
    request(1, 'dataSamplingStart', { entries: [{ expression: 'power' }], sampleIntervalMs: 1, ...args }),
  );
  return { internal: session as any, commands, sent, startSampling };
}

describe('DapSession Timeline sampling source', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('lets an XR-DAP probe sample and reports its interval', async () => {
    const f = fixture({ ok: true, data: { periodUs: 1250, estFrameUs: 900, maxFrameBytes: 15, run: 1 } });
    await f.startSampling();
    expect(f.sent.find(m => m.request_seq === 1)).toMatchObject({ success: true, body: { source: 'probe', intervalMs: 1.25 } });
    expect(f.internal.probeSampler.active).toBe(true);
    expect(f.internal.dataSamplingTimer).toBeNull();
  });

  it.each([
    ['cmsis-dap', undefined, false],
    ['cmsis-dap', false, false],
    ['cmsis-dap', true, true],
    ['jlink', true, false],
  ])('launches %s with XR option %s using the intended owner configuration', async (probe, option, enabled) => {
    const f = fixture(undefined, false);
    try {
      const launch = f.internal.handleLaunch(request(10, 'launch', {
        probe, cmsisDapTransport: 'tcp', cmsisDapPath: 'localhost:3241',
        cmsisDapXrSampling: option, flashBeforeDebug: false, rttLogEnabled: false,
      }));
      await vi.advanceTimersByTimeAsync(250);
      await launch;
      expect(f.sent.find(m => m.request_seq === 10)).toMatchObject({ success: true });
      expect(f.commands.find(c => c.cmd === 'connect').config.cmsisDapXrSampling).toBe(enabled);
      expect(f.internal.xrSamplingEnabled).toBe(enabled);
      expect(f.internal.probeSampler).toBeNull();
      expect(f.commands.some(c => /ProbeSampling$/.test(c.cmd))).toBe(false);
    } finally {
      f.internal.stopConnectionMonitor();
      f.internal.stopRttLogPolling();
    }
  });

  it('uses the original host loop by default without probing XR or allocating its sampler', async () => {
    const f = fixture(undefined, false);
    await f.startSampling({ probeSampling: true });
    expect(f.sent.find(m => m.request_seq === 1)).toMatchObject({ success: true, body: { source: 'host' } });
    expect(f.commands.some(c => /ProbeSampling$/.test(c.cmd))).toBe(false);
    expect(f.internal.probeSampler).toBeNull();
    expect(f.internal.dataSamplingTimer).not.toBeNull();
    f.internal.stopDataSampling();
    expect(f.commands.some(c => /ProbeSampling$/.test(c.cmd))).toBe(false);
  });

  it('keeps J-Link on the host loop even when XR is enabled in the configuration', async () => {
    const f = fixture();
    f.internal._probe = 'jlink';
    await f.startSampling();
    expect(f.sent.find(m => m.request_seq === 1)).toMatchObject({ success: true, body: { source: 'host' } });
    expect(f.commands.some(c => /ProbeSampling$/.test(c.cmd))).toBe(false);
    expect(f.internal.probeSampler).toBeNull();
  });

  it('keeps RMLink subscriptions exclusive even when a client explicitly requests XR', async () => {
    const f = fixture();
    const unsubscribe = vi.fn(async () => {});
    f.internal.backend.supportsProbeSubscriptions = true;
    f.internal.backend.subscribeProbeSamples = vi.fn(async () => unsubscribe);
    await f.startSampling({ probeSampling: true });
    expect(f.sent.find(m => m.request_seq === 1)).toMatchObject({ success: true, body: { source: 'rmlink' } });
    expect(f.internal.backend.subscribeProbeSamples).toHaveBeenCalledWith('memory_series', [spec], 1000, expect.any(Function));
    expect(f.internal.probeSampler).toBeNull();
    expect(f.internal.dataSamplingTimer).toBeNull();
    expect(f.commands.some(c => /ProbeSampling$/.test(c.cmd))).toBe(false);
    f.internal.stopDataSampling();
    await f.internal.probeSamplingCleanup;
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('polls from the host when the probe cannot sample', async () => {
    const f = fixture({ ok: false, errorCode: 'UnsupportedCapability', error: 'no XR-DAP' });
    await f.startSampling();
    expect(f.sent.find(m => m.request_seq === 1)).toMatchObject({ success: true, body: { source: 'host' } });
    expect(f.internal.dataSamplingTimer).not.toBeNull();
  });

  it('honours probeSampling: false', async () => {
    const f = fixture();
    await f.startSampling({ probeSampling: false });
    expect(f.commands.some(c => c.cmd === 'startProbeSampling')).toBe(false);
    expect(f.internal.probeSampler).toBeNull();
  });

  it('never plots a probe frame before the previous point across a Timeline pause', async () => {
    const f = fixture();
    await f.startSampling();
    for (let i = 0; i < 8; i++) await f.internal.probeSampler.poll();
    // The core stopped and resumed: the Timeline clock now excludes 50 ms, so
    // frames sampled before the resume map earlier than points already plotted.
    f.internal.timelineClockPausedTotalMs += 50;
    await f.internal.probeSampler.poll();
    const timestamps = f.internal.dataSamplingPending.get('power').map((p: any) => p.timestamp);
    expect(timestamps.length).toBe(18);
    expect(timestamps.every((t: number, i: number) => i === 0 || t >= timestamps[i - 1])).toBe(true);
  });

  it('stops the probe when Timeline sampling stops', async () => {
    const f = fixture();
    await f.startSampling();
    await f.internal.handleDataSamplingStop(request(2, 'dataSamplingStop'));
    expect(f.commands.filter(c => c.cmd === 'stopProbeSampling')).toEqual([{ cmd: 'stopProbeSampling', run: 1 }]);
    expect(f.internal.probeSampler.active).toBe(false);
  });
});
