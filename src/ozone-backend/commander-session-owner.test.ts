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

  it('reads memory through the selected owner without halting in live-access mode', async () => {
    const target = {
      getState: vi.fn(async () => ({ ok: true, data: { state: 'Running' } })),
      halt: vi.fn(async () => ({ ok: true })),
      run: vi.fn(async () => ({ ok: true })),
      readMemory: vi.fn(async () => ({
        ok: true,
        message: 'memory read',
        targetState: 'Running' as const,
        elapsedMs: 1,
        data: { bytes: Uint8Array.from([1, 2, 3, 4]) },
      })),
    } as unknown as SessionTargetOwner;
    const backend = new OzoneBackend(target, target);

    const result = await backend.execute({
      cmd: 'readMemory', address: 0x20000000, size: 4, liveAccess: true,
    });

    expect(result).toMatchObject({ ok: true, data: { address: 0x20000000, data: [1, 2, 3, 4] } });
    expect(target.readMemory).toHaveBeenCalledOnce();
    expect(target.getState).not.toHaveBeenCalled();
    expect(target.halt).not.toHaveBeenCalled();
    expect(target.run).not.toHaveBeenCalled();
  });

  it('writes memory through the selected owner without halting in live-access mode', async () => {
    const target = {
      getState: vi.fn(async () => ({ ok: true, data: { state: 'Running' } })),
      halt: vi.fn(async () => ({ ok: true })),
      run: vi.fn(async () => ({ ok: true })),
      writeMemory: vi.fn(async () => ({
        ok: true,
        message: 'memory written',
        targetState: 'Running' as const,
        elapsedMs: 1,
        data: { address: 0x20000000, bytesWritten: 4 },
      })),
    } as unknown as SessionTargetOwner;
    const backend = new OzoneBackend(target, target);

    const result = await backend.execute({
      cmd: 'writeMemory', address: 0x20000000, data: [1, 2, 3, 4], liveAccess: true,
    });

    expect(result).toMatchObject({ ok: true });
    expect(target.writeMemory).toHaveBeenCalledOnce();
    expect(target.getState).not.toHaveBeenCalled();
    expect(target.halt).not.toHaveBeenCalled();
    expect(target.run).not.toHaveBeenCalled();
  });

  it('returns a structured live-write error without falling back to halt', async () => {
    const target = {
      getState: vi.fn(),
      halt: vi.fn(),
      run: vi.fn(),
      writeMemory: vi.fn(async () => ({
        ok: false,
        message: 'running writes are unavailable',
        errorCode: 'UnsupportedCapability',
        targetState: 'Running' as const,
        elapsedMs: 1,
        diagnostics: { operation: 'writeMemory', mode: 'live' },
      })),
    } as unknown as SessionTargetOwner;
    const backend = new OzoneBackend(target, target);

    const result = await backend.execute({
      cmd: 'writeMemory', address: 0x20000000, data: [1, 2, 3, 4], liveAccess: true,
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'UnsupportedCapability',
      error: 'UnsupportedCapability: running writes are unavailable',
      targetState: 'Running',
      diagnostics: { operation: 'writeMemory', mode: 'live' },
    });
    expect(target.getState).not.toHaveBeenCalled();
    expect(target.halt).not.toHaveBeenCalled();
    expect(target.run).not.toHaveBeenCalled();
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
    if (!result.ok) expect(result.error).toContain('probe must be one of auto, jlink, cmsis-dap, or rmlink');
    expect(jlink.open).not.toHaveBeenCalled();
    expect(jlink.connect).not.toHaveBeenCalled();
  });

  it.each(['foo', 'jlink'])('rejects probe %s with a RMLink device selector before opening a target', async (probe) => {
    const backend = new OzoneBackend();
    const jlink = { open: vi.fn(), connect: vi.fn() };
    (backend as any).jlink = jlink;
    const result = await backend.execute({
      cmd: 'connect',
      config: {
        probe,
        rmlinkDeviceId: 'test-probe',
        device: 'STM32F103C8',
        interface: 'SWD',
        speedKHz: 4000,
      } as any,
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'InvalidConfiguration' });
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
    if (!result.ok) expect(result.error).toContain('cmsisDapTransport must be one of auto, cmsis-dap-v2, cmsis-dap, hid, winusb, or tcp');
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

  it('routes getRttCapabilities, enumerateRtt, writeRtt, startRtt, and readRtt through the single selected J-Link owner', async () => {
    const rttCaps = {
      ownerKind: 'jlink-native' as const,
      rttStart: { available: true, evidence: 'source' as const },
      rttEnumerate: { available: true, evidence: 'source' as const },
      rttUpRead: { available: true, evidence: 'source' as const },
      rttDownWrite: { available: true, evidence: 'source' as const },
    };
    const nativeOwner = {
      kind: 'jlink-native' as const,
      usingNative: true,
      getRttCapabilities: vi.fn(() => rttCaps),
      startRtt: vi.fn(async () => ({ ok: true, message: 'RTT started', targetState: 'Running' as const, elapsedMs: 1, data: { controlBlockAddress: 0x24000100 } })),
      enumerateRtt: vi.fn(async () => ({
        ok: true,
        message: 'RTT channels enumerated',
        targetState: 'Running' as const,
        elapsedMs: 1,
        data: {
          controlBlockAddress: 0x24000100,
          maxUpBuffers: 1,
          maxDownBuffers: 1,
          upBuffers: [],
          downBuffers: [],
          duplicateUpNames: [],
          duplicateDownNames: [],
          validUpCount: 0,
          validDownCount: 0,
          corruptCount: 0,
          unusedCount: 0,
        },
      })),
      readRtt: vi.fn(async () => ({
        ok: true,
        message: 'RTT read',
        targetState: 'Running' as const,
        elapsedMs: 1,
        data: { bytes: Uint8Array.from([0x41, 0x42]) },
      })),
      writeRtt: vi.fn(async () => ({
        ok: true,
        message: 'RTT down write committed',
        targetState: 'Running' as const,
        elapsedMs: 1,
        data: {
          controlBlockAddress: 0x24000100,
          bufferIndex: 0,
          descriptorAddress: 0x24000130,
          bufferAddress: 0x24002000,
          bufferSize: 64,
          initialWrOff: 0,
          initialRdOff: 0,
          rdOff: 0,
          committedWrOff: 2,
          flags: 1,
          mode: 1,
          availableSpace: 63,
          requestedBytes: 2,
          writtenBytes: 2,
          committedBytes: 2,
          wrapped: false,
          shortWrite: false,
          skipped: false,
          firstSegmentWritten: true,
          secondSegmentWritten: false,
          wrOffWriteAttempted: true,
          wrOffCommitted: true,
          completion: 'completed' as const,
          failureStage: 'none' as const,
          retryable: false,
        },
      })),
      stopRtt: vi.fn(async () => ({ ok: true, message: 'RTT stopped', targetState: 'Running' as const, elapsedMs: 0, data: {} })),
    } as unknown as SessionTargetOwner;

    const backend = new OzoneBackend(nativeOwner, nativeOwner);
    const directJlink = { startRtt: vi.fn(), readRtt: vi.fn(), stopRtt: vi.fn() };
    (backend as any).jlink = directJlink;

    await expect(backend.execute({ cmd: 'getRttCapabilities' })).resolves.toEqual({ ok: true, data: rttCaps });
    await expect(backend.execute({ cmd: 'startRtt', controlBlockAddress: 0x24000100 })).resolves.toMatchObject({ ok: true });
    await expect(backend.execute({ cmd: 'enumerateRtt', controlBlockAddress: 0x24000100 })).resolves.toMatchObject({ ok: true });
    await expect(backend.execute({ cmd: 'readRtt', bufferIndex: 1, size: 32 })).resolves.toMatchObject({
      ok: true,
      data: { bytes: [0x41, 0x42] },
    });
    await expect(backend.execute({ cmd: 'writeRtt', bufferIndex: 0, bytes: [0x01, 0x02] })).resolves.toMatchObject({
      ok: true,
      data: { committedBytes: 2, completion: 'completed' },
    });
    await expect(backend.execute({ cmd: 'stopRtt' })).resolves.toMatchObject({ ok: true });

    expect(directJlink.startRtt).not.toHaveBeenCalled();
    expect(directJlink.readRtt).not.toHaveBeenCalled();
    expect(directJlink.stopRtt).not.toHaveBeenCalled();
  });

  it('reports legacy RTT capabilities and UnsupportedCapability cleanly when no native RTT owner exists', async () => {
    const backend = new OzoneBackend();
    (backend as any).jlink = {
      connected: true,
      getRttApiAvailability: vi.fn(() => ({ control: true, read: false, write: false })),
      startRtt: vi.fn(() => true),
      readRtt: vi.fn(() => null),
      stopRtt: vi.fn(),
    };

    await expect(backend.execute({ cmd: 'getRttCapabilities' })).resolves.toMatchObject({
      ok: true,
      data: {
        ownerKind: 'jlink-legacy',
        rttStart: { available: true },
        rttUpRead: { available: false, reason: expect.stringContaining('JLINK_RTTERMINAL_Read') },
        rttEnumerate: { available: false },
        rttDownWrite: { available: false },
      },
    });
    await expect(backend.execute({ cmd: 'readRtt', bufferIndex: 0, size: 8 })).resolves.toMatchObject({
      ok: false,
      errorCode: 'UnsupportedCapability',
    });
    await expect(backend.execute({ cmd: 'enumerateRtt', controlBlockAddress: 0x20000100 })).resolves.toMatchObject({
      ok: false,
      errorCode: 'UnsupportedCapability',
    });
    await expect(backend.execute({ cmd: 'writeRtt', bufferIndex: 0, bytes: [1] })).resolves.toMatchObject({
      ok: false,
      errorCode: 'UnsupportedCapability',
    });
  });
});
