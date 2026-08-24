import { describe, expect, it, vi } from 'vitest';
import { OzoneBackend } from './commander';
import { SessionTargetOwner } from './session-target-channel';
import { NativeSchedulerCancelledError } from './native-scheduler';
import { log } from '../utils/logger';
import { STM32F407VET6, STM32H723VGT6 } from './cmsis-dap-flasher';

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

function addSourceLine(backend: OzoneBackend, start: number, end: number): void {
  (backend as any).symbols = [{ name: 'source_line', address: start, size: end - start + 0x20, type: 'T' }];
  (backend as any).addressLocCache = new Map([
    [start, { file: 'main.c', line: 10, func: 'source_line' }],
    [end, { file: 'main.c', line: 11, func: 'source_line' }],
  ]);
  (backend as any).lineEntries = [
    { address: start, file: 'main.c', line: 10 },
    { address: end, file: 'main.c', line: 11 },
  ];
}

function addDisjointSourceLine(backend: OzoneBackend): void {
  (backend as any).symbols = [{ name: 'loop', address: 0x08000100, size: 0x100, type: 'T' }];
  (backend as any).addressLocCache = new Map([
    [0x08000100, { file: 'main.c', line: 10, func: 'loop' }],
    [0x08000104, { file: 'main.c', line: 11, func: 'loop' }],
    [0x08000180, { file: 'main.c', line: 10, func: 'loop' }],
    [0x08000184, { file: 'main.c', line: 12, func: 'loop' }],
    [0x08000200, { file: 'callee.c', line: 20, func: 'callee' }],
  ]);
  (backend as any).lineEntries = [
    { address: 0x08000100, file: 'main.c', line: 10 },
    { address: 0x08000104, file: 'main.c', line: 11 },
    { address: 0x08000180, file: 'main.c', line: 10 },
    { address: 0x08000184, file: 'main.c', line: 12 },
    { address: 0x08000200, file: 'callee.c', line: 20 },
  ];
}

describe('OzoneBackend CMSIS-DAP routing', () => {
  it('resolves a Thumb entry symbol and runs to its normalized instruction address', async () => {
    const runToAddress = vi.fn(async () => ({
      ok: true,
      message: 'startup entry reached',
      targetState: 'Halted' as const,
      elapsedMs: 9,
      data: {
        state: 'Halted' as const,
        requestedAddress: 0x08003a2d,
        entryAddress: 0x08003a2c,
        pc: 0x08003a2c,
        cleanupOk: true,
      },
    }));
    const owner = cmsisOwner({ runToAddress } as any);
    const backend = new OzoneBackend(undefined, owner);
    (backend as any).symbols = [{ name: 'main', address: 0x08003a2d, size: 0x30, type: 'T' }];

    const result = await backend.execute({ cmd: 'runToEntryPoint', symbol: 'main', reset: true });

    expect(runToAddress).toHaveBeenCalledWith(0x08003a2d, true);
    expect(result).toMatchObject({
      ok: true,
      data: {
        symbol: 'main',
        entryAddress: 0x08003a2c,
        pc: 0x08003a2c,
        state: 'halted',
        cleanupOk: true,
      },
    });
    expect(backend.currentState).toBe('halted');
  });

  it('halts and returns EntryPointUnavailable without running when the symbol is missing', async () => {
    const runToAddress = vi.fn();
    const owner = cmsisOwner({ runToAddress } as any);
    const backend = new OzoneBackend(undefined, owner);
    (backend as any).state = 'running';
    (backend as any).symbols = [{ name: 'Reset_Handler', address: 0x08004519, size: 0x20, type: 'T' }];

    const result = await backend.execute({ cmd: 'runToEntryPoint', symbol: 'main', reset: true });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'EntryPointUnavailable',
      targetState: 'Halted',
    });
    expect(owner.halt).toHaveBeenCalledOnce();
    expect(runToAddress).not.toHaveBeenCalled();
    expect(owner.run).not.toHaveBeenCalled();
  });

  it('accepts a trusted immediate breakpoint halt as a completed run', async () => {
    const owner = cmsisOwner({
      run: vi.fn(async () => ({
        ok: true,
        message: 'breakpoint hit before running was observed',
        targetState: 'Halted' as const,
        elapsedMs: 2,
        data: {
          state: 'Halted',
          pc: 0x08003150,
          breakpointHitBeforeRunningObserved: true,
        },
      })),
    });
    const backend = new OzoneBackend(owner, owner);
    (backend as any).state = 'halted';

    const result = await backend.execute({ cmd: 'run' });

    expect(result).toMatchObject({
      ok: true,
      data: {
        state: 'Halted',
        pc: 0x08003150,
        breakpointHitBeforeRunningObserved: true,
      },
    });
    expect(backend.currentState).toBe('halted');
  });

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
    addSourceLine(backend, 0x080001C0, 0x080001C6);
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

  it('maps ordinary stepIn to the CMSIS-DAP source-step primitive', async () => {
    const owner = cmsisOwner({
      readRegister: vi.fn(async () => ({
        ok: true, message: 'pc', targetState: 'Halted' as const, elapsedMs: 1,
        data: { value: 0x080001C0 },
      })),
      stepIntoSourceLine: vi.fn(async () => ({
        ok: true, message: 'source step in', targetState: 'Halted' as const, elapsedMs: 2,
        data: {
          pcBefore: 0x080001C0, pcAfter: 0x080001E0, classification: 'call', instructions: 2,
          cleanupOk: true as const,
          timings: { haltMs: 0, readPcMs: 0, decodeMs: 0, executeMs: 1, waitMs: 0, cleanupMs: 0, totalMs: 2 },
        },
      })),
    });
    const backend = new OzoneBackend(undefined, owner);
    addSourceLine(backend, 0x080001C0, 0x080001C6);

    const result = await backend.execute({ cmd: 'stepInto' });

    expect(result).toMatchObject({
      ok: true,
      data: { mode: 'cmsis-dap', targetState: 'Halted', pcAfter: 0x080001E0 },
    });
    expect(owner.step).not.toHaveBeenCalled();
    expect(owner.stepIntoSourceLine).toHaveBeenCalledOnce();
  });

  it('routes source stepOver through the current CMSIS-DAP owner', async () => {
    const owner = cmsisOwner({
      readRegister: vi.fn(async () => ({
        ok: true, message: 'pc', targetState: 'Halted' as const, elapsedMs: 1,
        data: { value: 0x080001C0 },
      })),
      stepOverSourceLine: vi.fn(async () => ({
        ok: true, message: 'source step over', targetState: 'Halted' as const, elapsedMs: 2,
        data: {
          pcBefore: 0x080001C0, pcAfter: 0x080001C6, classification: 'callReturnBreakpoint', instructions: 2,
          cleanupOk: true,
          timings: { haltMs: 0, readPcMs: 0, decodeMs: 0, executeMs: 1, waitMs: 0, cleanupMs: 1, totalMs: 2 },
        },
      })),
    });
    const backend = new OzoneBackend(undefined, owner);
    addSourceLine(backend, 0x080001C0, 0x080001C6);

    const result = await backend.execute({ cmd: 'stepOver' });

    expect(result).toMatchObject({ ok: true, data: { mode: 'cmsis-dap', pcAfter: 0x080001C6 } });
    expect(owner.stepOverSourceLine).toHaveBeenCalledOnce();
    expect(owner.setBreakpoint).not.toHaveBeenCalled();
  });

  it('continues stepOver across disjoint address ranges mapped to the same source line', async () => {
    const stepOverSourceLine = vi.fn(async (request: { lineStart?: number }) => ({
      ok: true,
      message: 'source step over',
      targetState: 'Halted' as const,
      elapsedMs: 2,
      data: request.lineStart === 0x08000180
        ? {
          pcBefore: 0x08000180, pcAfter: 0x08000100, classification: 'branchSingleStep', instructions: 1,
          cleanupOk: true,
          timings: { haltMs: 0, readPcMs: 0, decodeMs: 0, executeMs: 1, waitMs: 0, cleanupMs: 0, totalMs: 1 },
        }
        : {
          pcBefore: 0x08000100, pcAfter: 0x08000104, classification: 'singleStep', instructions: 1,
          cleanupOk: true,
          timings: { haltMs: 0, readPcMs: 0, decodeMs: 0, executeMs: 1, waitMs: 0, cleanupMs: 0, totalMs: 1 },
        },
    }));
    const owner = cmsisOwner({
      readRegister: vi.fn(async () => ({
        ok: true, message: 'pc', targetState: 'Halted' as const, elapsedMs: 1,
        data: { value: 0x08000180 },
      })),
      stepOverSourceLine,
    });
    const backend = new OzoneBackend(undefined, owner);
    addDisjointSourceLine(backend);

    const result = await backend.execute({ cmd: 'stepOver' });

    expect(result).toMatchObject({ ok: true, data: { pcAfter: 0x08000104 } });
    expect(stepOverSourceLine).toHaveBeenCalledTimes(2);
    expect(stepOverSourceLine.mock.calls.map(([request]) => request.lineStart)).toEqual([
      0x08000180,
      0x08000100,
    ]);
  });

  it('continues stepInto across a loop back-edge before entering a call on the same source line', async () => {
    const stepIntoSourceLine = vi.fn(async (request: { lineStart?: number }) => ({
      ok: true,
      message: 'source step in',
      targetState: 'Halted' as const,
      elapsedMs: 2,
      data: request.lineStart === 0x08000180
        ? {
          pcBefore: 0x08000180, pcAfter: 0x08000100, classification: 'branch', instructions: 1,
          cleanupOk: true as const,
          timings: { haltMs: 0, readPcMs: 0, decodeMs: 0, executeMs: 1, waitMs: 0, cleanupMs: 0, totalMs: 1 },
        }
        : {
          pcBefore: 0x08000100, pcAfter: 0x08000200, classification: 'call', instructions: 1,
          enteredCall: true,
          cleanupOk: true as const,
          timings: { haltMs: 0, readPcMs: 0, decodeMs: 0, executeMs: 1, waitMs: 0, cleanupMs: 0, totalMs: 1 },
        },
    }));
    const owner = cmsisOwner({
      readRegister: vi.fn(async () => ({
        ok: true, message: 'pc', targetState: 'Halted' as const, elapsedMs: 1,
        data: { value: 0x08000180 },
      })),
      stepIntoSourceLine,
    });
    const backend = new OzoneBackend(undefined, owner);
    addDisjointSourceLine(backend);

    const result = await backend.execute({ cmd: 'stepInto' });

    expect(result).toMatchObject({ ok: true, data: { pcAfter: 0x08000200, enteredCall: true } });
    expect(stepIntoSourceLine).toHaveBeenCalledTimes(2);
  });

  it('routes source stepOut through the current CMSIS-DAP owner', async () => {
    const owner = cmsisOwner({
      readRegister: vi.fn(async () => ({
        ok: true, message: 'pc', targetState: 'Halted' as const, elapsedMs: 1,
        data: { value: 0x080001E0 },
      })),
      stepOut: vi.fn(async () => ({
        ok: true, message: 'source step out', targetState: 'Halted' as const, elapsedMs: 2,
        data: {
          pcBefore: 0x080001E0, pcAfter: 0x080001C6, classification: 'returnBreakpoint' as const, instructions: 0 as const,
          lr: 0x080001C7, sp: 0x20001000, returnAddress: 0x080001C6,
          cleanupOk: true as const,
          timings: { haltMs: 0, readPcMs: 0, decodeMs: 0, executeMs: 1, waitMs: 0, cleanupMs: 1, totalMs: 2 },
        },
      })),
    });
    const backend = new OzoneBackend(undefined, owner);
    (backend as any).symbols = [{ name: 'callee', address: 0x080001E0, size: 0x20, type: 'T' }];

    const result = await backend.execute({ cmd: 'stepOut' });

    expect(result).toMatchObject({ ok: true, data: { mode: 'cmsis-dap', pcAfter: 0x080001C6 } });
    expect(owner.stepOut).toHaveBeenCalledOnce();
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

  it('preserves structured source-step errors and cleanup diagnostics', async () => {
    const owner = cmsisOwner({
      readRegister: vi.fn(async () => ({
        ok: true, message: 'pc', targetState: 'Halted' as const, elapsedMs: 1,
        data: { value: 0x080001C0 },
      })),
      stepOverSourceLine: vi.fn(async () => ({
        ok: false,
        message: 'temporary breakpoint wait timed out',
        errorCode: 'StepTimeout',
        targetState: 'Halted' as const,
        elapsedMs: 1000,
        diagnostics: { operation: 'stepOverSourceLine', cleanupOk: true, restoredSlots: [0, 4] },
      })),
    });
    const backend = new OzoneBackend(undefined, owner);
    addSourceLine(backend, 0x080001C0, 0x080001C6);

    const result = await backend.execute({ cmd: 'stepOver' });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'StepTimeout',
      targetState: 'Halted',
      elapsedMs: 1000,
      diagnostics: { cleanupOk: true, restoredSlots: [0, 4] },
    });
  });

  it('does not throw when a CMSIS-DAP source-step failure returns empty data', async () => {
    const owner = cmsisOwner({
      readRegister: vi.fn(async () => ({
        ok: true, message: 'pc', targetState: 'Halted' as const, elapsedMs: 1,
        data: { value: 0x080001C0 },
      })),
      stepOverSourceLine: vi.fn(async () => ({
        ok: false,
        message: 'Cortex-M instruction step did not retire before the control timeout',
        errorCode: 'DapControlTimeout',
        targetState: 'Halted' as const,
        elapsedMs: 1000,
        // Helper coreFailure serializes data as {}. Runtime JSON has no pcBefore/pcAfter.
        data: {} as never,
        diagnostics: { operation: 'stepOverSourceLine' },
      })),
    });
    const backend = new OzoneBackend(undefined, owner);
    addSourceLine(backend, 0x080001C0, 0x080001C6);

    await expect(backend.execute({ cmd: 'stepOver' })).resolves.toMatchObject({
      ok: false,
      errorCode: 'DapControlTimeout',
      targetState: 'Halted',
      elapsedMs: 1000,
    });
  });

  it('preserves structured FPB resource exhaustion', async () => {
    const owner = cmsisOwner({
      setBreakpoint: vi.fn(async () => ({
        ok: false,
        message: 'all target-reported FPB code comparators are occupied',
        errorCode: 'BreakpointResourceExhausted',
        targetState: 'Halted' as const,
        elapsedMs: 4,
        diagnostics: { operation: 'setBreakpoint', codeComparators: 6 },
      })),
    });
    const backend = new OzoneBackend(undefined, owner);

    const result = await backend.execute({ cmd: 'setBreakpointAtAddr', addr: 0x080001CC });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'BreakpointResourceExhausted',
      targetState: 'Halted',
      elapsedMs: 4,
      diagnostics: { codeComparators: 6 },
    });
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
    expect(owner.readMemory).toHaveBeenCalledWith(0xFFFFFFFF, 4, { priority: 'background' });
  });

  it('writes only an explicitly resolved STM32F407 SRAM Watch address', async () => {
    const writeMemory = vi.fn(async (address: number, bytes: Uint8Array) => ({
      ok: true,
      message: 'memory written',
      targetState: 'Halted' as const,
      elapsedMs: 1,
      data: { address, bytesWritten: bytes.length },
    }));
    const owner = cmsisOwner({
      getState: vi.fn(async () => ({
        ok: true, message: 'state', targetState: 'Halted' as const, elapsedMs: 1,
        data: { state: 'Halted' },
      })),
      writeMemory,
    });
    const backend = new OzoneBackend(undefined, owner);

    await expect(backend.execute({
      cmd: 'setWatchValue', expression: 'counter', value: 42,
      address: 0x20000004, typeName: 'uint32_t',
    })).resolves.toMatchObject({ ok: true });
    expect(writeMemory).toHaveBeenCalledWith(0x20000004, Uint8Array.from([42, 0, 0, 0]));

    await expect(backend.execute({
      cmd: 'setWatchValue', expression: 'FLASH_ACR', value: 1,
      address: 0x40023C00, typeName: 'uint32_t',
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'InvalidWatchWriteAddress',
    });
    expect(writeMemory).toHaveBeenCalledTimes(1);
  });

  it('permits CMSIS-DAP Watch writes inside any STM32H723 RAM region', async () => {
    const writeMemory = vi.fn(async (address: number, bytes: Uint8Array) => ({
      ok: true,
      message: 'memory written',
      targetState: 'Halted' as const,
      elapsedMs: 1,
      data: { address, bytesWritten: bytes.length },
    }));
    const owner = cmsisOwner({
      getState: vi.fn(async () => ({
        ok: true, message: 'state', targetState: 'Halted' as const, elapsedMs: 1,
        data: { state: 'Halted' },
      })),
      writeMemory,
      flashTarget: STM32H723VGT6,
    });
    const backend = new OzoneBackend(undefined, owner);

    // DTCM, AXI SRAM, and D2 SRAM1-3 are all registry RAM regions; DAP
    // reachability of DTCM/D2 is deferred to hardware acceptance and any
    // failure surfaces through the write path itself.
    await expect(backend.execute({
      cmd: 'setWatchValue', expression: 'dtcmVar', value: 8,
      address: 0x2001FFFC, typeName: 'uint32_t',
    })).resolves.toMatchObject({ ok: true });
    await expect(backend.execute({
      cmd: 'setWatchValue', expression: 'axiVar', value: 7,
      address: 0x24000100, typeName: 'uint32_t',
    })).resolves.toMatchObject({ ok: true });
    await expect(backend.execute({
      cmd: 'setWatchValue', expression: 'd2Var', value: 9,
      address: 0x30000000, typeName: 'uint32_t',
    })).resolves.toMatchObject({ ok: true });
    expect(writeMemory).toHaveBeenCalledTimes(3);

    await expect(backend.execute({
      cmd: 'setWatchValue', expression: 'FLASH_CR1', value: 1,
      address: 0x5200200C, typeName: 'uint32_t',
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'InvalidWatchWriteAddress',
      diagnostics: { ownerKind: 'cmsis-dap', target: 'STM32H723VGT6' },
    });
    // The first word past the DTCM end (0x20000000 + 128 KiB) is outside
    // every region even though the H723 map continues elsewhere.
    await expect(backend.execute({
      cmd: 'setWatchValue', expression: 'pastDtcm', value: 1,
      address: 0x20020000, typeName: 'uint32_t',
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'InvalidWatchWriteAddress',
    });
    expect(writeMemory).toHaveBeenCalledTimes(3);
  });

  it('keeps the STM32F407 Watch-write window unchanged under the registry gate', async () => {
    const writeMemory = vi.fn(async (address: number, bytes: Uint8Array) => ({
      ok: true,
      message: 'memory written',
      targetState: 'Halted' as const,
      elapsedMs: 1,
      data: { address, bytesWritten: bytes.length },
    }));
    const owner = cmsisOwner({
      getState: vi.fn(async () => ({
        ok: true, message: 'state', targetState: 'Halted' as const, elapsedMs: 1,
        data: { state: 'Halted' },
      })),
      writeMemory,
      flashTarget: STM32F407VET6,
    });
    const backend = new OzoneBackend(undefined, owner);

    await expect(backend.execute({
      cmd: 'setWatchValue', expression: 'counter', value: 42,
      address: 0x20000004, typeName: 'uint32_t',
    })).resolves.toMatchObject({ ok: true });
    expect(writeMemory).toHaveBeenCalledWith(0x20000004, Uint8Array.from([42, 0, 0, 0]));

    // Both the first word past SRAM and CCM RAM stay rejected: the F407
    // registry entry deliberately models only the 128 KiB SRAM window.
    await expect(backend.execute({
      cmd: 'setWatchValue', expression: 'pastSram', value: 1,
      address: 0x20020000, typeName: 'uint32_t',
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'InvalidWatchWriteAddress',
      diagnostics: { target: 'STM32F407VET6' },
    });
    await expect(backend.execute({
      cmd: 'setWatchValue', expression: 'ccmVar', value: 1,
      address: 0x10000000, typeName: 'uint32_t',
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'InvalidWatchWriteAddress',
    });
    expect(writeMemory).toHaveBeenCalledTimes(1);
  });

  it('stops a cancelled Locals scan after the current CMSIS-DAP memory read', async () => {
    const controller = new AbortController();
    const owner = cmsisOwner({
      readMemory: vi.fn(async () => {
        controller.abort('continue started');
        return {
          ok: true,
          message: 'memory read',
          targetState: 'Halted' as const,
          elapsedMs: 1,
          data: { bytes: Uint8Array.from([1, 0, 0, 0]) },
        };
      }),
    });
    const backend = new OzoneBackend(undefined, owner);
    (backend as any).symbols = [
      { name: 'first', address: 0x20000000, size: 4, type: 'D' },
      { name: 'second', address: 0x20000004, size: 4, type: 'D' },
    ];
    (backend as any).dwarfInfo = { varToType: new Map(), types: new Map() };

    const result = await backend.execute({ cmd: 'getLocals', signal: controller.signal });

    expect(result).toEqual({ ok: true, data: [] });
    expect(owner.readMemory).toHaveBeenCalledTimes(1);
  });

  it('stops a cancelled Registers scan after the current CMSIS-DAP register read', async () => {
    const controller = new AbortController();
    const owner = cmsisOwner({
      readRegister: vi.fn(async () => {
        controller.abort('continue started');
        return {
          ok: true,
          message: 'register read',
          targetState: 'Halted' as const,
          elapsedMs: 1,
          data: { value: 0x12345678 },
        };
      }),
    });
    const backend = new OzoneBackend(undefined, owner);

    const result = await backend.execute({ cmd: 'getRegisters', signal: controller.signal });

    expect(result).toEqual({ ok: true, data: [] });
    expect(owner.readRegister).toHaveBeenCalledTimes(1);
  });

  it('stops a cancelled recursive evaluate after the current CMSIS-DAP memory read', async () => {
    const controller = new AbortController();
    const owner = cmsisOwner({
      readMemory: vi.fn(async (address: number) => {
        if (address === 0x20000000) {
          controller.abort('continue started');
          return {
            ok: true,
            message: 'pointer read',
            targetState: 'Halted' as const,
            elapsedMs: 1,
            data: { bytes: Uint8Array.from([0x00, 0x10, 0x00, 0x20]) },
          };
        }
        return {
          ok: true,
          message: 'pointee read',
          targetState: 'Halted' as const,
          elapsedMs: 1,
          data: { bytes: Uint8Array.from([0x00, 0x00, 0x80, 0x3f]) },
        };
      }),
    });
    const backend = new OzoneBackend(undefined, owner);
    (backend as any).symbols = [{ name: 'root', address: 0x20000000, size: 4, type: 'D' }];
    (backend as any).dwarfInfo = {
      varToType: new Map([['root', 'root-pointer']]),
      typeDefs: new Map([
        ['root-pointer', { name: 'Root_t*', byteSize: 4, kind: 'pointer', typeOffset: 'root-struct' }],
        ['root-struct', {
          name: 'Root_t', byteSize: 4, kind: 'struct',
          fields: [{ name: 'value', typeOffset: 'float-type', byteOffset: 0 }],
        }],
        ['float-type', { name: 'float', byteSize: 4, kind: 'base', encoding: 'float' }],
      ]),
    };

    const result = await backend.execute({
      cmd: 'evaluateExpression',
      expression: 'root',
      force: true,
      signal: controller.signal,
      priority: 'background',
    } as any);

    expect(result).toMatchObject({ ok: false, errorCode: 'EvaluateCancelled' });
    expect(owner.readMemory).toHaveBeenCalledTimes(1);
    expect(owner.readMemory).toHaveBeenCalledWith(0x20000000, 4, {
      priority: 'background',
      signal: controller.signal,
    });
  });

  it('normalizes a queued owner cancellation into a structured evaluate result', async () => {
    const controller = new AbortController();
    let markReadQueued: (() => void) | undefined;
    const readQueued = new Promise<void>(resolve => { markReadQueued = resolve; });
    const owner = cmsisOwner({
      readMemory: vi.fn(async (_address: number, _size: number, options?: { signal?: AbortSignal }) => {
        markReadQueued?.();
        return await new Promise<never>((_, reject) => {
          options?.signal?.addEventListener('abort', () => {
            reject(new NativeSchedulerCancelledError('RTOS background read was cancelled'));
          }, { once: true });
        });
      }),
    });
    const backend = new OzoneBackend(undefined, owner);
    (backend as any).state = 'halted';
    (backend as any).symbols = [{ name: 'uxCurrentNumberOfTasks', address: 0x20000000, size: 4, type: 'D' }];
    (backend as any).dwarfInfo = {
      varToType: new Map([['uxCurrentNumberOfTasks', 'u32-type']]),
      typeDefs: new Map([['u32-type', { name: 'uint32_t', byteSize: 4, kind: 'base', encoding: 'unsigned' }]]),
    };

    const evaluate = backend.execute({
      cmd: 'evaluateExpression',
      expression: 'uxCurrentNumberOfTasks',
      force: true,
      priority: 'background',
      signal: controller.signal,
    });
    const assertion = expect(evaluate).resolves.toMatchObject({
      ok: false,
      errorCode: 'EvaluateCancelled',
      targetState: 'halted',
    });
    await readQueued;
    controller.abort('continue started');

    await assertion;
  });

  it('does not schedule a control-priority getState while evaluating an RTOS symbol in background', async () => {
    const controller = new AbortController();
    const owner = cmsisOwner({
      readMemory: vi.fn(async () => ({
        ok: true,
        message: 'memory read',
        targetState: 'Halted' as const,
        elapsedMs: 1,
        data: { bytes: Uint8Array.from([3, 0, 0, 0]) },
      })),
    });
    const backend = new OzoneBackend(undefined, owner);
    (backend as any).state = 'halted';
    (backend as any).symbols = [{ name: 'uxCurrentNumberOfTasks', address: 0x20000000, size: 4, type: 'D' }];
    (backend as any).dwarfInfo = {
      varToType: new Map([['uxCurrentNumberOfTasks', 'u32-type']]),
      typeDefs: new Map([['u32-type', { name: 'uint32_t', byteSize: 4, kind: 'base', encoding: 'unsigned' }]]),
    };
    const result = await backend.execute({
      cmd: 'evaluateExpression',
      expression: 'uxCurrentNumberOfTasks',
      force: true,
      expandedExpressions: [],
      priority: 'background',
      signal: controller.signal,
    });

    expect(result).toMatchObject({ ok: true, data: expect.objectContaining({ value: 3 }) });
    expect(owner.getState).not.toHaveBeenCalled();
    expect(owner.readMemory).toHaveBeenCalledWith(0x20000000, 4, {
      priority: 'background',
      signal: controller.signal,
    });
  });

  it('does not schedule getState for a standard RTOS background evaluate without force', async () => {
    const controller = new AbortController();
    const owner = cmsisOwner({
      readMemory: vi.fn(async () => ({
        ok: true,
        message: 'memory read',
        targetState: 'Halted' as const,
        elapsedMs: 1,
        data: { bytes: Uint8Array.from([3, 0, 0, 0]) },
      })),
    });
    const backend = new OzoneBackend(undefined, owner);
    (backend as any).state = 'halted';
    (backend as any).symbols = [{ name: 'uxCurrentNumberOfTasks', address: 0x20000000, size: 4, type: 'D' }];
    (backend as any).dwarfInfo = {
      varToType: new Map([['uxCurrentNumberOfTasks', 'u32-type']]),
      typeDefs: new Map([['u32-type', { name: 'uint32_t', byteSize: 4, kind: 'base', encoding: 'unsigned' }]]),
    };
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    const result = await backend.execute({
      cmd: 'evaluateExpression',
      expression: 'uxCurrentNumberOfTasks',
      expandedExpressions: [],
      priority: 'background',
      signal: controller.signal,
    });
    const scheduledTimeouts = setTimeoutSpy.mock.calls.length;
    setTimeoutSpy.mockRestore();

    expect(result).toMatchObject({ ok: true, data: expect.objectContaining({ value: 3 }) });
    expect(owner.getState).not.toHaveBeenCalled();
    expect(scheduledTimeouts).toBe(0);
    expect(owner.readMemory).toHaveBeenCalledWith(0x20000000, 4, {
      priority: 'background',
      signal: controller.signal,
    });
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
