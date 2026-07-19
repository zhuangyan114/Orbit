import { describe, expect, it, vi } from 'vitest';
import { OzoneBackend } from './commander';
import { SessionTargetOwner } from './session-target-channel';

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
});
