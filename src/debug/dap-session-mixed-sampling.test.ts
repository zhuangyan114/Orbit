import { describe, expect, it, vi } from 'vitest';
import { DapSession } from './dap-session';

describe('DAP mixed Timeline sampling', () => {
  it('partitions RTTB and DAP expressions without creating another target owner', async () => {
    const backend = {
      execute: vi.fn(async (command: any) => {
        if (command.cmd === 'prepareFastDataSampling') {
          return {
            ok: true,
            data: [{
              expression: 'rtt_bench_attempted_frames',
              spec: { expression: 'rtt_bench_attempted_frames', address: 0x20000000, size: 4 },
            }],
          };
        }
        if (command.cmd === 'readFastDataSampling') return { ok: true, data: [] };
        return { ok: true, data: null };
      }),
    } as any;
    const session = new DapSession(backend);
    const sent: any[] = [];
    session.on('send', message => sent.push(message));
    const consumer = {
      configure: vi.fn(() => ({ ok: true, data: [] })),
      finish: vi.fn(() => ({ frames: [], errors: [], sequenceGaps: [], bufferedBytes: 0, decodeLatencyMs: 0 })),
    };
    const state = session as any;
    state.rttTimelineEnabled = true;
    state.rttTimelineConsumer = consumer;
    state.targetRunning = true;

    await state.handleDataSamplingStart({
      type: 'request',
      seq: 1,
      command: 'dataSamplingStart',
      arguments: {
        source: 'mixed',
        entries: [
          { expression: 'rttb.payload[1]', color: '#4EC9B0' },
          { expression: 'rtt_bench_attempted_frames', color: '#569CD6' },
        ],
      },
    });

    expect(consumer.configure).toHaveBeenCalledWith([expect.objectContaining({
      expression: 'rttb.payload[1]',
      payloadOffset: 1,
    })]);
    expect(backend.execute).toHaveBeenCalledWith({
      cmd: 'prepareFastDataSampling',
      expressions: ['rtt_bench_attempted_frames'],
    });
    expect(state.dataSamplingSource).toBe('mixed');
    expect(state.dataSamplingEntries.map((entry: any) => entry.expression)).toEqual([
      'rttb.payload[1]',
      'rtt_bench_attempted_frames',
    ]);
    expect(sent.at(-1)).toMatchObject({
      type: 'response',
      success: true,
      body: {
        source: 'mixed',
        activeExpressions: ['rttb.payload[1]', 'rtt_bench_attempted_frames'],
      },
    });

    state.stopDataSampling();
  });

  it('aligns RTT target ticks to the DAP Timeline clock in mixed mode', async () => {
    const session = new DapSession({ execute: vi.fn() } as any);
    const state = session as any;
    state.dataSamplingSource = 'mixed';
    state.dataSamplingActive = true;
    state.dataSamplingPending.set('rttb.payload[1]', []);
    const now = vi.spyOn(state, 'timelineNowMs')
      .mockReturnValueOnce(5_000)
      .mockReturnValueOnce(5_100);
    let pollCount = 0;
    state.rttTimelineConsumer = {
      poll: vi.fn(async () => ({
        ok: true,
        data: {
          snapshots: [{
            expression: 'rttb.payload[1]',
            color: '#4EC9B0',
            currentValue: '50',
            data: [
              { timestamp: pollCount++ === 0 ? 1_000 : 1_100, value: 49, display: '49' },
              { timestamp: pollCount === 1 ? 1_010 : 1_110, value: 50, display: '50' },
            ],
          }],
          decode: { frames: [], errors: [], sequenceGaps: [], bufferedBytes: 0, decodeLatencyMs: 0 },
          metrics: undefined,
          empty: false,
        },
      })),
    };

    await state.pollRttTimeline();

    expect(state.dataSamplingPending.get('rttb.payload[1]').map((point: any) => point.timestamp))
      .toEqual([4_990, 5_000]);

    await state.pollRttTimeline();

    expect(state.dataSamplingPending.get('rttb.payload[1]').map((point: any) => point.timestamp))
      .toEqual([4_990, 5_000, 5_090, 5_100]);
    expect(now).toHaveBeenCalledTimes(2);
  });
});
