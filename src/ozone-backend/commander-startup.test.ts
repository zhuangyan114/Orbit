import { describe, expect, it, vi } from 'vitest';
import { OzoneBackend } from './commander';
import { SessionTargetOwner } from './session-target-channel';

function fixture(stopPc = 0x08000400) {
  const owner = {
    kind: 'jlink-native', usingNative: true,
    halt: vi.fn(async () => ({ ok: true })),
    reset: vi.fn(async () => ({ ok: true })),
    run: vi.fn(async () => ({ ok: true })),
    getState: vi.fn(async () => ({ ok: true, data: { state: 'Halted' } })),
    readRegister: vi.fn(async () => ({ ok: true, data: { value: stopPc } })),
    setBreakpoint: vi.fn(async () => ({ ok: true, data: { id: 3 } })),
    clearBreakpoint: vi.fn(async () => ({ ok: true })),
  };
  const backend = new OzoneBackend(undefined, owner as unknown as SessionTargetOwner);
  (backend as any).symbols = [{ name: 'app_main', address: 0x08000401, size: 0x30, type: 'T' }];
  return { backend, owner, run: () => backend.execute({ cmd: 'runToEntryPoint', symbol: ' app_main ', reset: true }) };
}

describe('J-Link entry stop through the selected owner', () => {
  it('uses a temporary hardware breakpoint and removes it', async () => {
    const f = fixture();
    expect(await f.run()).toMatchObject({ ok: true, data: { symbol: 'app_main', pc: 0x08000400, cleanupOk: true } });
    expect(f.owner.reset).toHaveBeenCalledOnce();
    expect(f.owner.setBreakpoint).toHaveBeenCalledWith(0x08000400);
    expect(f.owner.readRegister).toHaveBeenCalledWith(15);
    expect(f.owner.clearBreakpoint).toHaveBeenCalledWith(3);
    expect(f.backend.currentState).toBe('halted');
  });

  it('keeps an existing user breakpoint at the entry', async () => {
    const f = fixture();
    (f.backend as any).sessionBreakpointSlots = [null, 0x08000400];
    expect(await f.run()).toMatchObject({ ok: true });
    expect(f.owner.setBreakpoint).not.toHaveBeenCalled();
    expect(f.owner.clearBreakpoint).not.toHaveBeenCalled();
  });

  it('halts without running when the entry is unavailable', async () => {
    const f = fixture();
    (f.backend as any).symbols = [];
    expect(await f.run()).toMatchObject({ ok: false, errorCode: 'EntryPointUnavailable', targetState: 'Halted' });
    expect(f.owner.run).not.toHaveBeenCalled();
    expect(f.owner.reset).not.toHaveBeenCalled();
  });

  it('reports an earlier user breakpoint instead of claiming the entry was reached', async () => {
    const f = fixture(0x08000200);
    expect(await f.run()).toMatchObject({ ok: false, errorCode: 'StartupEntryNotReached' });
    expect(f.owner.clearBreakpoint).toHaveBeenCalledWith(3);
  });

  it('removes the temporary breakpoint when run fails', async () => {
    const f = fixture();
    f.owner.run.mockResolvedValue({ ok: false });
    expect(await f.run()).toMatchObject({ ok: false, errorCode: 'TargetControlFailed' });
    expect(f.owner.clearBreakpoint).toHaveBeenCalledWith(3);
    expect(f.owner.halt).toHaveBeenCalledTimes(2);
  });

  it('reports breakpoint cleanup failure', async () => {
    const f = fixture();
    f.owner.clearBreakpoint.mockResolvedValue({ ok: false });
    expect(await f.run()).toMatchObject({ ok: false, errorCode: 'BreakpointCleanupFailed' });
  });

  it('does not run when all hardware breakpoint slots are occupied', async () => {
    const f = fixture();
    f.owner.setBreakpoint.mockResolvedValue({ ok: false } as any);
    expect(await f.run()).toMatchObject({ ok: false, errorCode: 'BreakpointResourceExhausted' });
    expect(f.owner.run).not.toHaveBeenCalled();
    expect(f.owner.clearBreakpoint).not.toHaveBeenCalled();
  });

  it('preserves NativeOwnerLost when recovery and cleanup also fail', async () => {
    const f = fixture();
    f.owner.getState.mockResolvedValue({ ok: false, errorCode: 'NativeOwnerLost', message: 'helper exited' } as any);
    f.owner.halt.mockResolvedValueOnce({ ok: true }).mockResolvedValue({ ok: false });
    f.owner.clearBreakpoint.mockResolvedValue({ ok: false });
    expect(await f.run()).toMatchObject({ ok: false, errorCode: 'NativeOwnerLost' });
  });

  it.each(['setBreakpoint', 'readRegister', 'clearBreakpoint'] as const)('preserves owner loss from %s', async operation => {
    const f = fixture();
    f.owner[operation].mockResolvedValue({ ok: false, errorCode: 'NativeOwnerLost', message: 'helper exited' } as any);
    expect(await f.run()).toMatchObject({ ok: false, errorCode: 'NativeOwnerLost' });
  });

  it('halts and removes the entry breakpoint on timeout', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      f.owner.getState.mockResolvedValue({ ok: true, data: { state: 'Running' } });
      const pending = f.run();
      await vi.advanceTimersByTimeAsync(5100);
      expect(await pending).toMatchObject({ ok: false, errorCode: 'StartupEntryNotReached' });
      expect(f.owner.halt).toHaveBeenCalledTimes(2);
      expect(f.owner.clearBreakpoint).toHaveBeenCalledWith(3);
    } finally { vi.useRealTimers(); }
  });
});
