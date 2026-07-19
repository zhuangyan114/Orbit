import { describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { OzoneBackend } from './commander';
import { JLinkDLL } from './jlink-dll';
import { NativeStepExecutor } from './cpp-jlink-channel';

function legacyJLink(pc: number, lr = 0x08002001): JLinkDLL {
  return {
    breakpointSlots: Array(6).fill(null),
    isHalted: vi.fn(() => true),
    readRegister: vi.fn((index: number) => index === 15 ? pc : index === 14 ? lr : 0),
    disconnect: vi.fn(),
  } as unknown as JLinkDLL;
}

describe('OzoneBackend native stop routing', () => {
  it('routes DAP stepInto through the source-line native primitive', async () => {
    const pcBefore = 0x08000104;
    const executor = {
      usingNative: true,
      readRegister: vi.fn(async () => ({
        ok: true,
        message: 'native register',
        targetState: 'Halted' as const,
        elapsedMs: 0,
        data: { value: pcBefore },
      })),
      stepIntoInstruction: vi.fn(),
      stepIntoSourceLine: vi.fn(async () => ({
        ok: true,
        message: 'source step in',
        targetState: 'Halted' as const,
        elapsedMs: 1,
        data: {
          pcBefore,
          pcAfter: 0x08001000,
          classification: 'callEntered',
          phase: 'sourceLine' as const,
          instructions: 3,
          cleanupOk: true as const,
          trace: [
            { pc: pcBefore, classification: 'nonControl', call: false },
            { pc: pcBefore + 2, classification: 'nonControl', call: false },
            { pc: pcBefore + 4, classification: 'call', call: true },
          ],
          timings: { haltMs: 0, readPcMs: 0, decodeMs: 0, executeMs: 1, waitMs: 0, cleanupMs: 0, totalMs: 1 },
        },
      })),
      stepOverSourceLine: vi.fn(),
      stepOut: vi.fn(),
    } as unknown as NativeStepExecutor;
    const backend = new OzoneBackend(executor);
    (backend as any).jlink = legacyJLink(pcBefore);
    (backend as any).symbols = [{ name: 'caller', address: 0x08000100, size: 0x100, type: 'T' }];
    (backend as any).lineEntries = [
      { address: pcBefore, file: 'main.c', line: 7 },
      { address: 0x0800010C, file: 'main.c', line: 8 },
    ];
    backend.configureNativeSteps();

    const result = await backend.execute({ cmd: 'stepInto' });
    expect(result.ok).toBe(true);
    expect(executor.stepIntoSourceLine).toHaveBeenCalledWith({
      lineStart: pcBefore,
      lineEnd: 0x0800010C,
      maxInstructionSteps: 32,
    });
    expect(executor.stepIntoInstruction).not.toHaveBeenCalled();
  });

  it.each(['stepInto', 'stepOver'] as const)(
    'uses one logical source range for a multiline call during %s',
    async command => {
      const pcBefore = 0x08001000;
      const pcAfter = 0x0800100C;
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ozone-native-step-'));
      const sourceFile = path.join(tempDir, 'main.c');
      fs.writeFileSync(sourceFile, [
        'm = calcSum(count,',
        '              count++);',
        'osDelay(1);',
      ].join('\n'), 'utf8');

      const sourceStep = vi.fn(async () => ({
        ok: true,
        message: 'native multiline source step',
        targetState: 'Halted' as const,
        elapsedMs: 1,
        data: {
          pcBefore,
          pcAfter,
          classification: command === 'stepInto' ? 'sourceBoundary' as const : 'singleStep' as const,
          instructions: 3,
          cleanupOk: true as const,
          timings: { haltMs: 0, readPcMs: 0, decodeMs: 0, executeMs: 1, waitMs: 0, cleanupMs: 0, totalMs: 1 },
        },
      }));
      const executor = {
        usingNative: true,
        readRegister: vi.fn(async () => ({
          ok: true,
          message: 'native register',
          targetState: 'Halted' as const,
          elapsedMs: 0,
          data: { value: pcBefore },
        })),
        stepIntoInstruction: vi.fn(),
        stepIntoSourceLine: command === 'stepInto' ? sourceStep : vi.fn(),
        stepOverSourceLine: command === 'stepOver' ? sourceStep : vi.fn(),
        stepOut: vi.fn(),
      } as unknown as NativeStepExecutor;
      const backend = new OzoneBackend(executor);
      (backend as any).jlink = legacyJLink(pcBefore);
      (backend as any).symbols = [{ name: 'caller', address: pcBefore, size: 0x40, type: 'T' }];
      (backend as any).lineEntries = [
        { address: pcBefore, file: sourceFile, line: 1 },
        { address: pcBefore + 4, file: sourceFile, line: 2 },
        { address: pcBefore + 8, file: sourceFile, line: 1 },
        { address: pcAfter, file: sourceFile, line: 3 },
      ];
      backend.configureNativeSteps();

      try {
        const result = await backend.execute({ cmd: command });
        expect(result.ok).toBe(true);
        expect(sourceStep).toHaveBeenCalledWith(expect.objectContaining({
          lineStart: pcBefore,
          lineEnd: pcAfter,
        }));
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );

  it('continues once through a loop header trampoline mapped to the same source line', async () => {
    const loopHeaderPc = 0x08000100;
    const firstBodyEntryPc = 0x08000104;
    const trampolinePc = 0x08000108;
    const loopBodyPc = 0x0800010C;
    const sourceStep = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        message: 'loop condition branch',
        targetState: 'Halted' as const,
        elapsedMs: 1,
        data: {
          pcBefore: loopHeaderPc,
          pcAfter: trampolinePc,
          classification: 'sourceBoundary',
          phase: 'sourceLine' as const,
          instructions: 1,
          cleanupOk: true as const,
          timings: { haltMs: 0, readPcMs: 0, decodeMs: 0, executeMs: 1, waitMs: 0, cleanupMs: 0, totalMs: 1 },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        message: 'loop body reached',
        targetState: 'Halted' as const,
        elapsedMs: 1,
        data: {
          pcBefore: trampolinePc,
          pcAfter: loopBodyPc,
          classification: 'sourceBoundary',
          phase: 'sourceLine' as const,
          instructions: 1,
          cleanupOk: true as const,
          timings: { haltMs: 0, readPcMs: 0, decodeMs: 0, executeMs: 1, waitMs: 0, cleanupMs: 0, totalMs: 1 },
        },
      });
    const executor = {
      usingNative: true,
      readRegister: vi.fn(async () => ({
        ok: true,
        message: 'native register',
        targetState: 'Halted' as const,
        elapsedMs: 0,
        data: { value: loopHeaderPc },
      })),
      stepIntoInstruction: vi.fn(),
      stepIntoSourceLine: sourceStep,
      stepOverSourceLine: vi.fn(),
      stepOut: vi.fn(),
    } as unknown as NativeStepExecutor;
    const backend = new OzoneBackend(executor);
    (backend as any).symbols = [{ name: 'loop', address: loopHeaderPc, size: 0x20, type: 'T' }];
    (backend as any).lineEntries = [
      { address: loopHeaderPc, file: 'main.c', line: 7 },
      { address: firstBodyEntryPc, file: 'main.c', line: 8 },
      { address: trampolinePc, file: 'main.c', line: 7 },
      { address: loopBodyPc, file: 'main.c', line: 8 },
    ];
    backend.configureNativeSteps();

    const result = await backend.execute({ cmd: 'stepInto' });

    expect(result.ok).toBe(true);
    expect(sourceStep).toHaveBeenNthCalledWith(1, {
      lineStart: loopHeaderPc,
      lineEnd: firstBodyEntryPc,
      maxInstructionSteps: 32,
    });
    expect(sourceStep).toHaveBeenNthCalledWith(2, {
      lineStart: trampolinePc,
      lineEnd: loopBodyPc,
      maxInstructionSteps: 32,
    });
  });

  it('continues stepOver through a loop header trampoline without using a breakpoint', async () => {
    const loopHeaderPc = 0x08000200;
    const firstBodyEntryPc = 0x08000204;
    const trampolinePc = 0x08000208;
    const loopBodyPc = 0x0800020C;
    const sourceStep = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        message: 'loop condition branch',
        targetState: 'Halted' as const,
        elapsedMs: 1,
        data: {
          pcBefore: loopHeaderPc,
          pcAfter: trampolinePc,
          classification: 'branchSingleStep',
          instructions: 3,
          cleanupOk: true,
          timings: { haltMs: 0, readPcMs: 0, decodeMs: 0, executeMs: 1, waitMs: 0, cleanupMs: 0, totalMs: 1 },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        message: 'loop body reached',
        targetState: 'Halted' as const,
        elapsedMs: 1,
        data: {
          pcBefore: trampolinePc,
          pcAfter: loopBodyPc,
          classification: 'branchSingleStep',
          instructions: 3,
          cleanupOk: true,
          timings: { haltMs: 0, readPcMs: 0, decodeMs: 0, executeMs: 1, waitMs: 0, cleanupMs: 0, totalMs: 1 },
        },
      });
    const executor = {
      usingNative: true,
      readRegister: vi.fn(async () => ({
        ok: true,
        message: 'native register',
        targetState: 'Halted' as const,
        elapsedMs: 0,
        data: { value: loopHeaderPc },
      })),
      stepIntoInstruction: vi.fn(),
      stepIntoSourceLine: vi.fn(),
      stepOverSourceLine: sourceStep,
      stepOut: vi.fn(),
    } as unknown as NativeStepExecutor;
    const backend = new OzoneBackend(executor);
    (backend as any).symbols = [{ name: 'loop', address: loopHeaderPc, size: 0x20, type: 'T' }];
    (backend as any).lineEntries = [
      { address: loopHeaderPc, file: 'main.c', line: 7 },
      { address: firstBodyEntryPc, file: 'main.c', line: 8 },
      { address: trampolinePc, file: 'main.c', line: 7 },
      { address: loopBodyPc, file: 'main.c', line: 8 },
    ];
    backend.configureNativeSteps();

    const result = await backend.execute({ cmd: 'stepOver' });

    expect(result.ok).toBe(true);
    expect(sourceStep).toHaveBeenNthCalledWith(1, {
      lineStart: loopHeaderPc,
      lineEnd: firstBodyEntryPc,
      waitTimeoutMs: 1000,
      maxInstructionSteps: 128,
      breakpoints: {},
    });
    expect(sourceStep).toHaveBeenNthCalledWith(2, {
      lineStart: trampolinePc,
      lineEnd: loopBodyPc,
      waitTimeoutMs: 1000,
      maxInstructionSteps: 128,
      breakpoints: {},
    });
  });

  it('continues stepOver after returning from a function into the caller call statement', async () => {
    const callerStart = 0x08001100;
    const callStart = 0x08001104;
    const callArgument = 0x08001108;
    const callContinuation = 0x0800110A;
    const returnAddress = 0x0800110C;
    const nextStatement = 0x08001110;
    const calleePc = 0x08002000;
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ozone-native-step-return-'));
    const sourceFile = path.join(tempDir, 'main.c');
    fs.writeFileSync(sourceFile, [
      'm = calcSum(count,',
      '              count++);',
      'osDelay(1);',
    ].join('\n'), 'utf8');
    const sourceStep = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        message: 'returned from callee',
        targetState: 'Halted' as const,
        elapsedMs: 1,
        data: {
          pcBefore: calleePc,
          pcAfter: returnAddress,
          classification: 'singleStep',
          instructions: 1,
          cleanupOk: true,
          timings: { haltMs: 0, readPcMs: 0, decodeMs: 0, executeMs: 1, waitMs: 0, cleanupMs: 0, totalMs: 1 },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        message: 'completed caller statement',
        targetState: 'Halted' as const,
        elapsedMs: 1,
        data: {
          pcBefore: returnAddress,
          pcAfter: nextStatement,
          classification: 'singleStep',
          instructions: 1,
          cleanupOk: true,
          timings: { haltMs: 0, readPcMs: 0, decodeMs: 0, executeMs: 1, waitMs: 0, cleanupMs: 0, totalMs: 1 },
        },
      });
    const executor = {
      usingNative: true,
      readRegister: vi.fn(async () => ({
        ok: true,
        message: 'native register',
        targetState: 'Halted' as const,
        elapsedMs: 0,
        data: { value: calleePc },
      })),
      stepIntoInstruction: vi.fn(),
      stepIntoSourceLine: vi.fn(),
      stepOverSourceLine: sourceStep,
      stepOut: vi.fn(),
    } as unknown as NativeStepExecutor;
    const backend = new OzoneBackend(executor);
    (backend as any).jlink = legacyJLink(calleePc);
    (backend as any).symbols = [
      { name: 'caller', address: callerStart, size: 0x100, type: 'T' },
      { name: 'calcSum', address: calleePc, size: 0x20, type: 't' },
    ];
    (backend as any).lineEntries = [
      { address: callerStart, file: sourceFile, line: 0 },
      { address: callStart, file: sourceFile, line: 1 },
      { address: callArgument, file: sourceFile, line: 2 },
      { address: callContinuation, file: sourceFile, line: 1 },
      { address: nextStatement, file: sourceFile, line: 3 },
      { address: calleePc, file: sourceFile, line: 5 },
    ];
      backend.configureNativeSteps();

    try {
      const result = await backend.execute({ cmd: 'stepOver' });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error);
      expect(sourceStep).toHaveBeenCalledTimes(2);
      expect(sourceStep).toHaveBeenNthCalledWith(1, expect.objectContaining({
        lineStart: calleePc,
      }));
      expect(sourceStep).toHaveBeenNthCalledWith(2, expect.objectContaining({
        lineStart: callContinuation,
        lineEnd: nextStatement,
      }));
      expect(result.data).toMatchObject({ pcAfter: nextStatement });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does not continue a call stepOver that stops on the same source line', async () => {
    const loopHeaderPc = 0x08000300;
    const firstBodyEntryPc = 0x08000304;
    const returnPc = 0x08000308;
    const sourceStep = vi.fn(async () => ({
      ok: true,
      message: 'call return',
      targetState: 'Halted' as const,
      elapsedMs: 1,
      data: {
        pcBefore: loopHeaderPc,
        pcAfter: returnPc,
        classification: 'callReturnBreakpoint',
        instructions: 1,
        cleanupOk: true,
        timings: { haltMs: 0, readPcMs: 0, decodeMs: 0, executeMs: 1, waitMs: 0, cleanupMs: 0, totalMs: 1 },
      },
    }));
    const executor = {
      usingNative: true,
      readRegister: vi.fn(async () => ({
        ok: true,
        message: 'native register',
        targetState: 'Halted' as const,
        elapsedMs: 0,
        data: { value: loopHeaderPc },
      })),
      stepIntoInstruction: vi.fn(),
      stepIntoSourceLine: vi.fn(),
      stepOverSourceLine: sourceStep,
      stepOut: vi.fn(),
    } as unknown as NativeStepExecutor;
    const backend = new OzoneBackend(executor);
    (backend as any).symbols = [{ name: 'loop', address: loopHeaderPc, size: 0x20, type: 'T' }];
    (backend as any).lineEntries = [
      { address: loopHeaderPc, file: 'main.c', line: 7 },
      { address: firstBodyEntryPc, file: 'main.c', line: 8 },
      { address: returnPc, file: 'main.c', line: 7 },
      { address: returnPc + 4, file: 'main.c', line: 8 },
    ];
    backend.configureNativeSteps();

    const result = await backend.execute({ cmd: 'stepOver' });

    expect(result.ok).toBe(true);
    expect(sourceStep).toHaveBeenCalledTimes(1);
  });

  it('uses native pcAfter for stackTrace and PC reads after a native step', async () => {
    const pcBefore = 0x08000100;
    const pcAfter = 0x08000104;
    const executor = {
      usingNative: true,
      readRegister: vi.fn(async (index: number) => ({
        ok: true,
        message: 'native register',
        targetState: 'Halted' as const,
        elapsedMs: 0,
        data: { value: index === 15 ? pcAfter : 0x08002001 },
      })),
      stepOverSourceLine: vi.fn(async () => ({
        ok: true,
        message: 'native step',
        targetState: 'Halted' as const,
        elapsedMs: 1,
        data: {
          pcBefore,
          pcAfter,
          classification: 'singleStep',
          instructions: 1,
          cleanupOk: true,
          timings: { haltMs: 0, readPcMs: 0, decodeMs: 0, executeMs: 1, waitMs: 0, cleanupMs: 0, totalMs: 1 },
        },
      })),
      stepIntoInstruction: vi.fn(),
      stepOut: vi.fn(),
    } as unknown as NativeStepExecutor;
    const backend = new OzoneBackend(executor);
    const legacy = legacyJLink(pcBefore);
    (backend as any).jlink = legacy;
    (backend as any).symbols = [{ name: 'caller', address: 0x08000100, size: 0x100, type: 'T' }];
    (backend as any).lineEntries = [
      { address: pcBefore, file: 'main.c', line: 7 },
      { address: 0x0800010C, file: 'main.c', line: 8 },
    ];
    backend.configureNativeSteps();

    const step = await backend.execute({ cmd: 'stepOver' });
    expect(step.ok).toBe(true);
    expect(executor.stepOverSourceLine).toHaveBeenCalledWith({
      lineStart: pcBefore,
      lineEnd: 0x0800010C,
      waitTimeoutMs: 1000,
      maxInstructionSteps: 128,
      breakpoints: {},
    });
    vi.mocked(legacy.readRegister).mockClear();

    const stack = await backend.execute({ cmd: 'getCallStack' });
    if (!stack.ok) throw new Error(stack.error);
    expect((stack.data as Array<{ address: number }>)[0].address).toBe(pcAfter);

    const pc = await backend.execute({ cmd: 'readRegister', name: 'PC' });
    if (!pc.ok) throw new Error(pc.error);
    expect((pc.data as { value: number }).value).toBe(pcAfter);
    expect(executor.readRegister).toHaveBeenCalledWith(15);
    expect(legacy.readRegister).not.toHaveBeenCalled();
  });

  it('keeps legacy JLinkDLL as the register and stack source without native', async () => {
    const legacyPc = 0x08001000;
    const backend = new OzoneBackend();
    const legacy = legacyJLink(legacyPc);
    (backend as any).jlink = legacy;

    const stack = await backend.execute({ cmd: 'getCallStack' });
    if (!stack.ok) throw new Error(stack.error);
    expect((stack.data as Array<{ address: number }>)[0].address).toBe(legacyPc);

    const pc = await backend.execute({ cmd: 'readRegister', name: 'PC' });
    if (!pc.ok) throw new Error(pc.error);
    expect((pc.data as { value: number }).value).toBe(legacyPc);
    expect(legacy.readRegister).toHaveBeenCalled();
  });

  it('uses an adjusted first-frame source hint when stepOut returns into the call line mapping', async () => {
    const calleePc = 0x08002000;
    const returnAddress = 0x08001104;
    let currentPc = calleePc;
    const executor = {
      usingNative: true,
      readRegister: vi.fn(async (index: number) => ({
        ok: true,
        message: 'native register',
        targetState: 'Halted' as const,
        elapsedMs: 0,
        data: { value: index === 15 ? currentPc : returnAddress | 1 },
      })),
      stepIntoInstruction: vi.fn(),
      stepIntoSourceLine: vi.fn(),
      stepOverSourceLine: vi.fn(),
      stepOut: vi.fn(async () => {
        currentPc = returnAddress;
        return {
          ok: true,
          message: 'native step out',
          targetState: 'Halted' as const,
          elapsedMs: 1,
          data: {
            pcBefore: calleePc,
            pcAfter: returnAddress,
            lr: returnAddress | 1,
            sp: 0x20001000,
            returnAddress,
            classification: 'returnBreakpoint' as const,
            instructions: 0 as const,
            cleanupOk: true,
            timings: { haltMs: 0, readPcMs: 0, decodeMs: 0, executeMs: 1, waitMs: 0, cleanupMs: 0, totalMs: 1 },
          },
        };
      }),
    } as unknown as NativeStepExecutor;
    const backend = new OzoneBackend(executor);
    (backend as any).jlink = legacyJLink(calleePc);
    (backend as any).symbols = [
      { name: 'caller', address: 0x08001100, size: 0x100, type: 'T' },
      { name: 'callee', address: calleePc, size: 0x100, type: 'T' },
    ];
    (backend as any).lineEntries = [
      { address: 0x08001100, file: 'main.c', line: 7 },
      { address: 0x08001108, file: 'main.c', line: 8 },
      { address: calleePc, file: 'main.c', line: 20 },
    ];
    backend.configureNativeSteps();

    const step = await backend.execute({ cmd: 'stepOut' });
    if (!step.ok) throw new Error(step.error);
    expect(step.data).toMatchObject({
      pcAfter: returnAddress,
      sourceAdjustReason: 'returnAddressMappedToCallLine',
      rawSourceLoc: { file: 'main.c', line: 7 },
      adjustedSourceLoc: { file: 'main.c', line: 8, address: 0x08001108 },
    });

    const stack = await backend.execute({ cmd: 'getCallStack' });
    if (!stack.ok) throw new Error(stack.error);
    expect((stack.data as Array<{ address: number; file: string; line: number }>)[0]).toMatchObject({
      address: returnAddress,
      file: 'main.c',
      line: 8,
    });
  });

  it('uses a weak runtime helper symbol range for native stepOut', async () => {
    const helperPc = 0x08000190;
    const helperEnd = 0x080003E4;
    const returnAddress = 0x08003B6E;
    const executor = {
      usingNative: true,
      readRegister: vi.fn(async (index: number) => ({
        ok: true,
        message: 'native register',
        targetState: 'Halted' as const,
        elapsedMs: 0,
        data: { value: index === 15 ? helperPc : returnAddress | 1 },
      })),
      stepIntoInstruction: vi.fn(),
      stepIntoSourceLine: vi.fn(),
      stepOverSourceLine: vi.fn(),
      stepOut: vi.fn(async () => ({
        ok: true,
        message: 'native step out',
        targetState: 'Halted' as const,
        elapsedMs: 1,
        data: {
          pcBefore: helperPc,
          pcAfter: returnAddress,
          lr: returnAddress | 1,
          sp: 0x20001000,
          returnAddress,
          classification: 'returnBreakpoint' as const,
          instructions: 0 as const,
          cleanupOk: true,
          timings: { haltMs: 0, readPcMs: 0, decodeMs: 0, executeMs: 1, waitMs: 0, cleanupMs: 0, totalMs: 1 },
        },
      })),
    } as unknown as NativeStepExecutor;
    const backend = new OzoneBackend(executor);
    (backend as any).jlink = legacyJLink(helperPc);
    (backend as any).symbols = [
      { name: '__aeabi_dmul', address: helperPc, size: helperEnd - helperPc, type: 'W' },
      { name: 'caller', address: returnAddress, size: 0x100, type: 'T' },
    ];
    backend.configureNativeSteps();

    const step = await backend.execute({ cmd: 'stepOut' });
    expect(step.ok).toBe(true);
    expect(executor.stepOut).toHaveBeenCalledWith({
      functionStart: helperPc,
      functionEnd: helperEnd,
      waitTimeoutMs: 1000,
      breakpoints: {},
    });
  });

  it.each(['stepInto', 'stepOver'] as const)(
    'extends the first %s source range through the statement displayed by the preceding stepOut',
    async command => {
      const calleePc = 0x08002000;
      const returnAddress = 0x08001104;
      const hintAddress = 0x08001108;
      const adjustedEnd = 0x08001110;
      let currentPc = calleePc;
      const sourceStep = vi.fn(async () => ({
        ok: true,
        message: 'native source step',
        targetState: 'Halted' as const,
        elapsedMs: 1,
        data: {
          pcBefore: currentPc,
          pcAfter: adjustedEnd,
          classification: 'lineBoundary',
          instructions: 2,
          cleanupOk: true as const,
          timings: { haltMs: 0, readPcMs: 0, decodeMs: 0, executeMs: 1, waitMs: 0, cleanupMs: 0, totalMs: 1 },
        },
      }));
      const executor = {
        usingNative: true,
        readRegister: vi.fn(async (index: number) => ({
          ok: true,
          message: 'native register',
          targetState: 'Halted' as const,
          elapsedMs: 0,
          data: { value: index === 15 ? currentPc : returnAddress | 1 },
        })),
        stepIntoInstruction: vi.fn(),
        stepIntoSourceLine: command === 'stepInto' ? sourceStep : vi.fn(),
        stepOverSourceLine: command === 'stepOver' ? sourceStep : vi.fn(),
        stepOut: vi.fn(async () => {
          currentPc = returnAddress;
          return {
            ok: true,
            message: 'native step out',
            targetState: 'Halted' as const,
            elapsedMs: 1,
            data: {
              pcBefore: calleePc,
              pcAfter: returnAddress,
              lr: returnAddress | 1,
              sp: 0x20001000,
              returnAddress,
              classification: 'returnBreakpoint' as const,
              instructions: 0 as const,
              cleanupOk: true,
              timings: { haltMs: 0, readPcMs: 0, decodeMs: 0, executeMs: 1, waitMs: 0, cleanupMs: 0, totalMs: 1 },
            },
          };
        }),
      } as unknown as NativeStepExecutor;
      const backend = new OzoneBackend(executor);
      (backend as any).jlink = legacyJLink(calleePc);
      (backend as any).symbols = [
        { name: 'caller', address: 0x08001100, size: 0x100, type: 'T' },
        { name: 'callee', address: calleePc, size: 0x100, type: 'T' },
      ];
      (backend as any).lineEntries = [
        { address: 0x08001100, file: 'main.c', line: 178 },
        { address: hintAddress, file: 'main.c', line: 181 },
        { address: adjustedEnd, file: 'main.c', line: 185 },
        { address: calleePc, file: 'main.c', line: 220 },
      ];
      backend.configureNativeSteps();

      const stepOut = await backend.execute({ cmd: 'stepOut' });
      if (!stepOut.ok) throw new Error(stepOut.error);
      const sourceResult = await backend.execute({ cmd: command });
      if (!sourceResult.ok) throw new Error(sourceResult.error);

      expect(sourceStep).toHaveBeenCalledWith(expect.objectContaining({
        lineStart: returnAddress,
        lineEnd: adjustedEnd,
      }));
    },
  );

  it.each([
    { name: 'stop PC no longer matches', stopPc: 0x08001102, hintAddress: 0x08001108 },
    { name: 'hint crosses the current function', stopPc: 0x08001104, hintAddress: 0x08001200 },
  ])('keeps the raw DWARF source range when the stepOut $name', async ({ stopPc, hintAddress }) => {
    const pc = 0x08001104;
    const rawLineEnd = 0x08001108;
    const sourceStep = vi.fn(async () => ({
      ok: true,
      message: 'native source step',
      targetState: 'Halted' as const,
      elapsedMs: 1,
      data: {
        pcBefore: pc,
        pcAfter: rawLineEnd,
        classification: 'lineBoundary',
        instructions: 1,
        cleanupOk: true as const,
        timings: { haltMs: 0, readPcMs: 0, decodeMs: 0, executeMs: 1, waitMs: 0, cleanupMs: 0, totalMs: 1 },
      },
    }));
    const executor = {
      usingNative: true,
      readRegister: vi.fn(async () => ({
        ok: true,
        message: 'native register',
        targetState: 'Halted' as const,
        elapsedMs: 0,
        data: { value: pc },
      })),
      stepIntoInstruction: vi.fn(),
      stepIntoSourceLine: sourceStep,
      stepOverSourceLine: vi.fn(),
      stepOut: vi.fn(),
    } as unknown as NativeStepExecutor;
    const backend = new OzoneBackend(executor);
    (backend as any).symbols = [
      { name: 'caller', address: 0x08001100, size: 0x100, type: 'T' },
      { name: 'other', address: 0x08001200, size: 0x100, type: 'T' },
    ];
    (backend as any).lineEntries = [
      { address: 0x08001100, file: 'main.c', line: 178 },
      { address: rawLineEnd, file: 'main.c', line: 181 },
      { address: 0x08001110, file: 'main.c', line: 185 },
      { address: 0x08001200, file: 'other.c', line: 20 },
      { address: 0x08001208, file: 'other.c', line: 21 },
    ];
    (backend as any).lastNativeStopInfo = {
      pcBefore: 0x08002000,
      pcAfter: stopPc,
      classification: 'returnBreakpoint',
      stopReason: 'step',
      timestamp: Date.now(),
      sourceHint: {
        file: hintAddress === rawLineEnd ? 'main.c' : 'other.c',
        line: hintAddress === rawLineEnd ? 181 : 20,
        address: hintAddress,
        reason: 'returnAddressMappedToCallLine',
        rawFile: 'main.c',
        rawLine: 178,
      },
    };
    backend.configureNativeSteps();

    const result = await backend.execute({ cmd: 'stepInto' });
    if (!result.ok) throw new Error(result.error);
    expect(sourceStep).toHaveBeenCalledWith({
      lineStart: 0x08001100,
      lineEnd: rawLineEnd,
      maxInstructionSteps: 32,
    });
  });
});
