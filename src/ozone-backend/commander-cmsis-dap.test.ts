import { describe, expect, it, vi } from 'vitest';
import { OzoneBackend } from './commander';
import { SessionTargetOwner } from './session-target-channel';
import { log } from '../utils/logger';

function cmsisOwner(overrides: Partial<SessionTargetOwner> = {}): SessionTargetOwner {
  return {
    kind: 'cmsis-dap',
    usingNative: false,
    connect: vi.fn(),
    disconnect: vi.fn(),
    halt: vi.fn(async () => ({
      ok: true, message: 'halted', targetState: 'Halted' as const, elapsedMs: 1,
      data: { state: 'Halted', dhcsr: 0x00030001, pc: 0x080001C0 },
    })),
    run: vi.fn(async () => ({
      ok: true, message: 'running', targetState: 'Running' as const, elapsedMs: 1,
      data: { state: 'Running', dhcsr: 1 },
    })),
    step: vi.fn(async () => ({
      ok: true, message: 'step', targetState: 'Halted' as const, elapsedMs: 1,
      data: { state: 'Halted', pcBefore: 0x080001C0, pcAfter: 0x080001C2 },
    })),
    reset: vi.fn(async () => ({
      ok: true, message: 'reset', targetState: 'Halted' as const, elapsedMs: 1,
      data: { state: 'Halted', pc: 0x080001C0 },
    })),
    getState: vi.fn(async () => ({
      ok: true, message: 'state', targetState: 'Halted' as const, elapsedMs: 1,
      data: { state: 'Halted', pc: 0x080001C0 },
    })),
    readRegister: vi.fn(),
    readMemory: vi.fn(),
    readMemoryBatch: vi.fn(),
    writeMemory: vi.fn(),
    setBreakpoint: vi.fn(),
    clearBreakpoint: vi.fn(),
    clearAllBreakpoints: vi.fn(),
    startRtt: vi.fn(),
    stopRtt: vi.fn(),
    readRtt: vi.fn(),
    stepIntoInstruction: vi.fn(),
    stepIntoSourceLine: vi.fn(),
    stepOverSourceLine: vi.fn(),
    stepOut: vi.fn(),
    dispose: vi.fn(),
    ...overrides,
  } as unknown as SessionTargetOwner;
}

describe('OzoneBackend CMSIS-DAP DAP-04 routing', () => {
  it('does not describe a connected CMSIS-DAP owner as a legacy path', async () => {
    const owner = cmsisOwner({
      connect: vi.fn(async () => ({
        ok: true,
        message: 'CMSIS-DAP connected',
        targetState: 'Unknown' as const,
        elapsedMs: 1,
        data: { channel: 'cmsis-dap' as const },
      })),
    });
    const backend = new OzoneBackend(undefined, owner);
    const stepLog = vi.spyOn(log, 'step');

    const result = await backend.execute({
      cmd: 'connect',
      config: {
        device: 'STM32F407VET6',
        interface: 'SWD',
        speedKHz: 1000,
        probe: 'cmsis-dap',
        nativeDebugEngineEnabled: true,
        nativeDebugEngineMode: 'auto',
      },
    });

    expect(result.ok).toBe(true);
    expect(stepLog).toHaveBeenCalledWith(expect.stringContaining('owner=cmsis-dap'));
    expect(stepLog).not.toHaveBeenCalledWith(expect.stringContaining('legacy'));
    stepLog.mockRestore();
  });

  it('maps stepIn to the CMSIS-DAP owner instruction primitive only', async () => {
    const owner = cmsisOwner();
    const backend = new OzoneBackend(undefined, owner);

    const result = await backend.execute({ cmd: 'stepInto' });

    expect(result).toMatchObject({ ok: true, data: { mode: 'cmsis-dap', pcAfter: 0x080001C2 } });
    expect(owner.step).toHaveBeenCalledOnce();
    expect(owner.stepIntoInstruction).not.toHaveBeenCalled();
    expect(owner.stepIntoSourceLine).not.toHaveBeenCalled();
  });

  it.each(['stepOver', 'stepOut'] as const)('does not emulate %s through J-Link or breakpoints', async command => {
    const owner = cmsisOwner();
    const backend = new OzoneBackend(undefined, owner);

    const result = await backend.execute({ cmd: command });

    expect(result).toMatchObject({ ok: false, errorCode: 'UnsupportedCapability' });
    expect(owner.step).not.toHaveBeenCalled();
    expect(owner.setBreakpoint).not.toHaveBeenCalled();
  });

  it('preserves a structured CMSIS-DAP control error', async () => {
    const owner = cmsisOwner({
      halt: vi.fn(async () => ({
        ok: false,
        message: 'SWD WAIT exhausted during DHCSR write',
        errorCode: 'DapAckWait',
        targetState: 'Error' as const,
        elapsedMs: 3,
        diagnostics: { operation: 'halt', phase: 'writeDhcsr' },
      })),
    });
    const backend = new OzoneBackend(undefined, owner);

    const result = await backend.execute({ cmd: 'halt' });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'DapAckWait',
      diagnostics: { operation: 'halt', phase: 'writeDhcsr' },
    });
    expect(result.ok === false && result.error).toContain('DapAckWait');
  });

  it('preserves a structured CMSIS-DAP memory-read error', async () => {
    const owner = cmsisOwner({
      readMemory: vi.fn(async () => ({
        ok: false,
        message: 'SWD FAULT while reading 0xffffffff',
        errorCode: 'DapAckFault',
        targetState: 'Halted' as const,
        elapsedMs: 7,
        diagnostics: { operation: 'readMemory', phase: 'transfer', ack: 'FAULT' },
      })),
    });
    const backend = new OzoneBackend(undefined, owner);

    const result = await backend.execute({ cmd: 'readMemory', address: 0xFFFFFFFF, size: 4 });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'DapAckFault',
      targetState: 'Halted',
      elapsedMs: 7,
      diagnostics: {
        operation: 'readMemory',
        phase: 'transfer',
        ack: 'FAULT',
        address: 0xFFFFFFFF,
        size: 4,
      },
    });
    expect(result.ok === false && result.error).toContain('DapAckFault');
    expect(owner.readMemory).toHaveBeenCalledWith(0xFFFFFFFF, 4, { priority: 'watch' });
  });

  it('reads call-stack PC and LR through the CMSIS-DAP owner and labels the source', async () => {
    const owner = cmsisOwner({
      getState: vi.fn(async () => ({
        ok: true, message: 'state', targetState: 'Halted' as const, elapsedMs: 1,
        data: { state: 'Halted', pc: 0x080001C0 },
      })),
      readRegister: vi.fn(async (index: number) => ({
        ok: true,
        message: 'register read',
        targetState: 'Halted' as const,
        elapsedMs: 1,
        data: { value: index === 15 ? 0x080001C0 : 0x08000200 },
      })),
    });
    const backend = new OzoneBackend(undefined, owner);
    const directJlink = { readRegister: vi.fn() };
    (backend as any).jlink = directJlink;
    const dapLog = vi.spyOn(log, 'dap');
    const stepLog = vi.spyOn(log, 'step');

    const result = await backend.execute({ cmd: 'getCallStack' });

    expect(result).toMatchObject({ ok: true, data: [
      { address: 0x080001C0 },
      { address: 0x08000200 },
    ] });
    expect(owner.readRegister).toHaveBeenCalledWith(15);
    expect(owner.readRegister).toHaveBeenCalledWith(14);
    expect(directJlink.readRegister).not.toHaveBeenCalled();
    expect(dapLog).toHaveBeenCalledWith(expect.stringContaining('getCallStack PC source=sessionTarget/cmsis-dap'));
    expect(dapLog).toHaveBeenCalledWith(expect.stringContaining('LR source=sessionTarget/cmsis-dap'));
    expect(dapLog).not.toHaveBeenCalledWith(expect.stringContaining('legacyJLinkDLL'));
    expect(stepLog).toHaveBeenCalledWith(expect.stringContaining('pcSource=sessionTarget/cmsis-dap'));
    expect(stepLog).not.toHaveBeenCalledWith(expect.stringContaining('pcSource=legacy'));
    dapLog.mockRestore();
    stepLog.mockRestore();
  });
});
