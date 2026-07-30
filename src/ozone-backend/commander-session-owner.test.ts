import { describe, expect, it, vi } from 'vitest';
import { OzoneBackend } from './commander';
import { SessionTargetOwner, SessionTargetSelector } from './session-target-channel';
import { NativeScheduler } from './native-scheduler';

describe('OzoneBackend extension-host ownership guard', () => {
  it('rejects target access before touching the local J-Link backend', async () => {
    const backend = new OzoneBackend(undefined, undefined, () => true);
    const legacy = {
      open: vi.fn(() => true),
      connect: vi.fn(() => true),
      readMemory: vi.fn(),
      isHalted: vi.fn(),
    };
    (backend as any).jlink = legacy;

    const connect = await backend.execute({
      cmd: 'connect',
      config: { device: 'STM32F407VG', interface: 'SWD', speedKHz: 4000 },
    });
    const read = await backend.execute({ cmd: 'readMemory', address: 0x20000000, size: 4 });

    expect(connect).toEqual({ ok: false, error: 'Target access is owned by the active ozone DAP session' });
    expect(read).toEqual({ ok: false, error: 'Target access is owned by the active ozone DAP session' });
    expect(legacy.open).not.toHaveBeenCalled();
    expect(legacy.connect).not.toHaveBeenCalled();
    expect(legacy.readMemory).not.toHaveBeenCalled();
    expect(legacy.isHalted).not.toHaveBeenCalled();
  });

  it('allows a blocked extension backend to release an older local owner', async () => {
    const backend = new OzoneBackend(undefined, undefined, () => true);
    const legacy = { disconnect: vi.fn() };
    (backend as any).jlink = legacy;
    (backend as any).state = 'connected';

    const result = await backend.execute({ cmd: 'disconnect' });

    expect(result.ok).toBe(true);
    expect(legacy.disconnect).toHaveBeenCalledOnce();
  });

  it('does not turn a session-owner state error into a successful stale state', async () => {
    const target = {
      getState: vi.fn(async () => ({
        ok: false,
        message: 'helper exited',
        errorCode: 'NativeOwnerLost',
        targetState: 'Error' as const,
        elapsedMs: 0,
      })),
    } as unknown as SessionTargetOwner;
    const backend = new OzoneBackend(target, target);

    const result = await backend.execute({ cmd: 'getTargetState' });

    expect(result).toEqual({
      ok: false,
      error: 'NativeOwnerLost: helper exited',
      errorCode: 'NativeOwnerLost',
    });
  });

  it('maps RTT stream backpressure to an empty DAP read without restarting RTT', async () => {
    const nativeScheduler = new NativeScheduler();
    const result = <T>(data?: T) => ({
      ok: true,
      message: 'ok',
      targetState: 'Running' as const,
      elapsedMs: 0,
      ...(data === undefined ? {} : { data }),
    });
    const owner = {
      kind: 'native' as const,
      usingNative: true,
      connect: vi.fn(async () => result({ channel: 'cpp' as const })),
      disconnect: vi.fn(async () => result()),
      halt: vi.fn(async () => result()),
      run: vi.fn(async () => result()),
      step: vi.fn(async () => result()),
      reset: vi.fn(async () => result()),
      getState: vi.fn(async () => result({ state: 'Running' })),
      readRegister: vi.fn(async () => result({ value: 0 })),
      readMemory: vi.fn(async () => result({ bytes: new Uint8Array() })),
      readMemoryBatch: vi.fn(async () => result({ reads: [] })),
      writeMemory: vi.fn(async () => result({ address: 0, bytesWritten: 0 })),
      setBreakpoint: vi.fn(async () => result({ id: 0 })),
      clearBreakpoint: vi.fn(async () => result()),
      clearAllBreakpoints: vi.fn(async () => result()),
      startRtt: vi.fn(async () => result()),
      stopRtt: vi.fn(async () => result()),
      readRtt: vi.fn(async () => result({ bytes: new Uint8Array([0x41]) })),
      getNativeScheduler: () => nativeScheduler,
      stepIntoInstruction: vi.fn(async () => result({})),
      stepIntoSourceLine: vi.fn(async () => result({})),
      stepOverSourceLine: vi.fn(async () => result({})),
      stepOut: vi.fn(async () => result({})),
      dispose: vi.fn(async () => nativeScheduler.dispose()),
    } as unknown as SessionTargetOwner;
    const selector = new SessionTargetSelector(() => owner, () => owner);
    const backend = new OzoneBackend(undefined, selector);

    try {
      expect((await selector.connect({ device: 'STM32F407VET6', speedKHz: 4000, interface: 'SWD' }, 'native')).ok).toBe(true);
      expect(selector.getRttChannelRegistry().register({
        index: 1,
        name: 'OrbitRTTBench',
        purpose: 'test stream',
        consumers: ['rtt'],
        buffer: { targetSizeBytes: 65536, hostQueueCapacityBytes: 1024 },
      }).ok).toBe(true);
      expect(await backend.execute({ cmd: 'readRtt', bufferIndex: 1, size: 65536 }))
        .toEqual({ ok: false, error: 'RTT read failed' });
      expect(owner.readRtt).not.toHaveBeenCalled();
      expect(await backend.execute({ cmd: 'startRtt' })).toEqual({ ok: true, data: 'RTT started' });

      const reads = [];
      for (let index = 0; index < 9; index++) {
        reads.push(await backend.execute({ cmd: 'readRtt', bufferIndex: 1, size: 65536 }));
      }

      expect(reads.slice(0, 8).every(read => read.ok)).toBe(true);
      expect(reads[8]).toEqual({ ok: true, data: { bytes: [] } });
      expect(owner.readRtt).toHaveBeenCalledTimes(8);
      expect(owner.startRtt).toHaveBeenCalledOnce();
    } finally {
      await selector.dispose();
    }
  });
});
