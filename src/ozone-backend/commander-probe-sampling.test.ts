import { describe, expect, it, vi } from 'vitest';
import { OzoneBackend } from './commander';
import type { FastDataSampleSpec, ProbeSampleBatch } from './types';

function fixture(options: { kind?: string; supported?: boolean } = {}) {
  const backend = new OzoneBackend();
  const target = {
    kind: options.kind ?? 'cmsis-dap',
    supportsProbeSampling: vi.fn(async () => options.supported ?? true),
    startProbeSampling: vi.fn(async (periodUs: number) => ({
      ok: true,
      data: { periodUs, maxFrameBytes: 18, estFrameUs: 120 },
    })),
    readProbeSampling: vi.fn(async (): Promise<any> => ({
      ok: true,
      data: {
        probeNowUs: 5_000,
        probeNowAgeUs: 300,
        pendingBytes: 0,
        frames: [
          // power = 17, counter read failed in this tick
          { t: 4_000, v: [[0, 1, '11000000'], [1, 0, '00000000']] },
          { t: 4_100, v: [[0, 1, 'feffffff'], [1, 1, '2a00']] },
        ],
        stats: { droppedFrames: 0, skippedTicks: 0, suspends: 0, vendorReads: 0 },
      },
    })),
    stopProbeSampling: vi.fn(async () => ({ ok: true, data: {} })),
  };
  (backend as any).sessionTarget = target;
  const specs: FastDataSampleSpec[] = [
    { expression: 'power', address: 0x20000400, size: 4, signed: true },
    {
      expression: 'motor.speed', address: 0, size: 2,
      pointerChain: [
        { pointerAddress: 0x20000100, offset: 0 },
        { pointerAddress: 0, offset: 8 },
        { pointerAddress: 0, offset: 12 },
      ],
    },
  ];
  return { backend, target, specs };
}

describe('XR-DAP probe-side sampling', () => {
  it('maps scalar and pointer-chain specs onto probe items', async () => {
    const f = fixture();
    const started = await f.backend.execute({ cmd: 'startProbeSampling', specs: f.specs, periodUs: 200.4 });
    expect(started.ok).toBe(true);
    expect(f.target.startProbeSampling).toHaveBeenCalledWith(200, [
      { size: 4, base: 0x20000400 },
      // *(*(p) + 8) + 12: read the pointer at p, the pointer at +8, then the value at +12.
      { size: 2, base: 0x20000100, derefs: [0, 8], finalOffset: 12 },
    ]);
  });

  it('maps a single pointer dereference', async () => {
    const f = fixture();
    const spec: FastDataSampleSpec = {
      expression: 'p->x', address: 0, size: 4, pointerAddress: 0x20000200, pointeeOffset: 4,
    };
    await f.backend.execute({ cmd: 'startProbeSampling', specs: [spec], periodUs: 1000 });
    expect(f.target.startProbeSampling).toHaveBeenCalledWith(1000, [
      { size: 4, base: 0x20000200, derefs: [0], finalOffset: 4 },
    ]);
  });

  it('formats frames like fast sampling reads and skips failed values', async () => {
    const f = fixture();
    await f.backend.execute({ cmd: 'startProbeSampling', specs: f.specs, periodUs: 1000 });
    const result = await f.backend.execute({ cmd: 'readProbeSampling' });
    expect(result.ok).toBe(true);
    const batch = (result as { data: ProbeSampleBatch }).data;
    expect(batch.probeNowUs).toBe(5_000);
    expect(batch.frames.map(frame => [frame.timestampUs, frame.values.map(v => [v.expression, v.value])])).toEqual([
      [4_000, [['power', 17]]],
      [4_100, [['power', -2], ['motor.speed', 42]]],
    ]);
  });

  it('declines when the owner is not an XR-DAP CMSIS-DAP probe', async () => {
    for (const f of [fixture({ supported: false }), fixture({ kind: 'jlink-native' })]) {
      const result = await f.backend.execute({ cmd: 'startProbeSampling', specs: f.specs, periodUs: 1000 });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errorCode).toBe('UnsupportedCapability');
      expect(f.target.startProbeSampling).not.toHaveBeenCalled();
    }
  });

  it('declines offsets the probe item encoding cannot hold', async () => {
    const f = fixture();
    const spec: FastDataSampleSpec = {
      expression: 'big->tail', address: 0, size: 4, pointerAddress: 0x20000200, pointeeOffset: 0x8000,
    };
    const result = await f.backend.execute({ cmd: 'startProbeSampling', specs: [spec], periodUs: 1000 });
    expect(result.ok).toBe(false);
    expect(f.target.startProbeSampling).not.toHaveBeenCalled();
  });

  it('ignores the stop of a run that a newer start replaced', async () => {
    const f = fixture();
    const first = await f.backend.execute({ cmd: 'startProbeSampling', specs: f.specs, periodUs: 1000 });
    await f.backend.execute({ cmd: 'startProbeSampling', specs: f.specs, periodUs: 1000 });
    const run = (first as { data: { run: number } }).data.run;
    expect((await f.backend.execute({ cmd: 'stopProbeSampling', run })).ok).toBe(true);
    expect(f.target.stopProbeSampling).not.toHaveBeenCalled();
    expect((await f.backend.execute({ cmd: 'readProbeSampling' })).ok).toBe(true);
  });

  it('stops probe sampling and refuses reads afterwards', async () => {
    const f = fixture();
    await f.backend.execute({ cmd: 'startProbeSampling', specs: f.specs, periodUs: 1000 });
    expect((await f.backend.execute({ cmd: 'stopProbeSampling' })).ok).toBe(true);
    expect(f.target.stopProbeSampling).toHaveBeenCalledTimes(1);
    expect((await f.backend.execute({ cmd: 'readProbeSampling' })).ok).toBe(false);
  });
});
