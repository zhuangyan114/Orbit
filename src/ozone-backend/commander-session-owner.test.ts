import { describe, expect, it, vi } from 'vitest';
import { OzoneBackend } from './commander';
import { SessionTargetOwner } from './session-target-channel';

describe('OzoneBackend extension-host ownership guard', () => {
  it('resolves RTT symbols from loaded ELF data without target access', async () => {
    const backend = new OzoneBackend(undefined, undefined, () => true);
    (backend as any).elfPath = 'firmware.elf';
    (backend as any).symbols = [{ name: '_SEGGER_RTT', address: 0x20005178, size: 0xa8, type: 'B' }];

    const resolved = await backend.execute({ cmd: 'resolveSymbol', name: '_SEGGER_RTT' });
    expect(resolved).toMatchObject({
      ok: true,
      data: { name: '_SEGGER_RTT', address: 0x20005178, size: 0xa8, type: 'B' },
    });

    const missing = await backend.execute({ cmd: 'resolveSymbol', name: 'missing' });
    expect(missing).toMatchObject({ ok: false, errorCode: 'SymbolNotFound' });
  });

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

  it('preserves structured RTT Flags failures from the selected owner', async () => {
    const target = {
      readRtt: vi.fn(async () => ({
        ok: false,
        message: 'RTT Up Buffer Flags contain reserved bits',
        errorCode: 'RttInvalidBufferFlags',
        targetState: 'Running' as const,
        elapsedMs: 2,
        diagnostics: {
          rtt: {
            bufferIndex: 0,
            descriptorAddress: 0x20000118,
            bufferAddress: 0x20001000,
            bufferSize: 8,
            wrOff: 3,
            rdOff: 0,
            flags: 4,
            mode: 0,
            bytes: [],
          },
        },
      })),
    } as unknown as SessionTargetOwner;
    const backend = new OzoneBackend(target, target);

    await expect(backend.execute({ cmd: 'readRtt', bufferIndex: 0, size: 8 })).resolves.toMatchObject({
      ok: false,
      errorCode: 'RttInvalidBufferFlags',
      error: expect.stringContaining('RttInvalidBufferFlags'),
      diagnostics: {
        rtt: {
          flags: 4,
          mode: 0,
          bufferIndex: 0,
          descriptorAddress: 0x20000118,
          bytes: [],
        },
      },
    });
  });

  it('rejects a direct CMSIS-DAP flash command when no CMSIS-DAP owner exists', async () => {
    const backend = new OzoneBackend();

    const result = await backend.execute({
      cmd: 'flash',
      elfPath: 'firmware.elf',
      device: 'STM32F407VET6',
      interface: 'SWD',
      speedKHz: 4000,
      probe: 'cmsis-dap',
      flashBeforeDebug: true,
    });

    expect(result).toMatchObject({ ok: false, errorCode: 'OwnerUnavailable' });
    if (!result.ok) expect(result.error).toContain('CMSIS-DAP target owner');
  });

  it('returns OwnerUnavailable for CMSIS-DAP without a selector and never opens J-Link', async () => {
    const backend = new OzoneBackend();
    const jlink = {
      open: vi.fn(() => true),
      connect: vi.fn(() => true),
    };
    (backend as any).jlink = jlink;

    const result = await backend.execute({
      cmd: 'connect',
      config: {
        probe: 'cmsis-dap',
        flashBeforeDebug: false,
        device: 'STM32F407VET6',
        interface: 'SWD',
        speedKHz: 4000,
      },
    });

    expect(result).toMatchObject({ ok: false, errorCode: 'OwnerUnavailable' });
    if (!result.ok) expect(result.error).toContain('CMSIS-DAP');
    expect(jlink.open).not.toHaveBeenCalled();
    expect(jlink.connect).not.toHaveBeenCalled();
  });

  it('returns InvalidConfiguration for an invalid probe at the backend boundary', async () => {
    const backend = new OzoneBackend();
    const jlink = {
      open: vi.fn(() => true),
      connect: vi.fn(() => true),
    };
    (backend as any).jlink = jlink;

    const result = await backend.execute({
      cmd: 'connect',
      config: {
        probe: 'foo',
        flashBeforeDebug: false,
        device: 'STM32F407VET6',
        interface: 'SWD',
        speedKHz: 4000,
      } as any,
    });

    expect(result).toMatchObject({ ok: false, errorCode: 'InvalidConfiguration' });
    if (!result.ok) expect(result.error).toContain('probe must be one of jlink or cmsis-dap');
    expect(jlink.open).not.toHaveBeenCalled();
    expect(jlink.connect).not.toHaveBeenCalled();
  });

  it('returns InvalidConfiguration for an invalid CMSIS-DAP transport at the backend boundary', async () => {
    const backend = new OzoneBackend();
    const jlink = {
      open: vi.fn(() => true),
      connect: vi.fn(() => true),
    };
    (backend as any).jlink = jlink;

    const result = await backend.execute({
      cmd: 'connect',
      config: {
        probe: 'jlink',
        cmsisDapTransport: 'usb',
        device: 'STM32F407VET6',
        interface: 'SWD',
        speedKHz: 4000,
      } as any,
    });

    expect(result).toMatchObject({ ok: false, errorCode: 'InvalidConfiguration' });
    if (!result.ok) expect(result.error).toContain('cmsisDapTransport must be one of auto, cmsis-dap-v2, cmsis-dap, hid, or winusb');
    expect(jlink.open).not.toHaveBeenCalled();
    expect(jlink.connect).not.toHaveBeenCalled();
  });

  it('keeps a same-probe reconnect idempotent for an already selected J-Link owner', async () => {
    const jlinkOwner = {
      kind: 'jlink-legacy' as const,
      usingNative: false,
      connect: vi.fn(),
    } as unknown as SessionTargetOwner;
    const backend = new OzoneBackend(undefined, jlinkOwner);
    (backend as any).state = 'connected';

    const result = await backend.execute({
      cmd: 'connect',
      config: {
        probe: 'jlink',
        device: 'STM32F407VET6',
        interface: 'SWD',
        speedKHz: 4000,
      },
    });

    expect(result).toEqual({ ok: true, data: { state: 'connected' } });
    expect(jlinkOwner.connect).not.toHaveBeenCalled();
  });

  it('rejects a CMSIS-DAP reconnect when a J-Link owner is already selected', async () => {
    const jlinkOwner = {
      kind: 'jlink-legacy' as const,
      usingNative: false,
      connect: vi.fn(),
    } as unknown as SessionTargetOwner;
    const backend = new OzoneBackend(undefined, jlinkOwner);
    (backend as any).state = 'connected';

    const result = await backend.execute({
      cmd: 'connect',
      config: {
        probe: 'cmsis-dap',
        flashBeforeDebug: false,
        device: 'STM32F407VET6',
        interface: 'SWD',
        speedKHz: 4000,
      },
    });

    expect(result).toMatchObject({ ok: false, errorCode: 'ProbeMismatch' });
    if (!result.ok) expect(result.error).toContain('J-Link');
    expect(jlinkOwner.connect).not.toHaveBeenCalled();
  });
});
