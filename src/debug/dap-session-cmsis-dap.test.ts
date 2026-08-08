import { describe, expect, it, vi } from 'vitest';
import { DapSession, DebugProtocolMessage } from './dap-session';
import { OzoneBackend } from '../ozone-backend/commander';
import { log } from '../utils/logger';

function request(seq: number, command: string): DebugProtocolMessage {
  return { type: 'request', seq, command, arguments: {} };
}

function setBreakpointsRequest(seq: number, sourcePath: string, lines: number[]): DebugProtocolMessage {
  return {
    ...request(seq, 'setBreakpoints'),
    arguments: {
      source: { path: sourcePath },
      breakpoints: lines.map(line => ({ line })),
    },
  };
}

describe('DapSession CMSIS-DAP control routing', () => {
  it('responds to configurationDone before publishing the initial stopped event', async () => {
    const session = new DapSession({} as OzoneBackend);
    const messages: DebugProtocolMessage[] = [];
    session.on('send', message => messages.push(message));

    await (session as any).handleConfigurationDone(request(1, 'configurationDone'));

    const response = messages.find(message => message.type === 'response');
    const stopped = messages.find(message => message.type === 'event' && message.event === 'stopped');
    expect(response).toMatchObject({ success: true, command: 'configurationDone' });
    expect(stopped).toMatchObject({ body: { reason: 'entry', threadId: 1 } });
    expect(messages.indexOf(stopped!)).toBeGreaterThan(messages.indexOf(response!));
  });

  it('skips Flash and halts at the current PC without reset or run-to-main when flashBeforeDebug is false', async () => {
    const calls: string[] = [];
    const backend = {
      execute: async (command: { cmd: string; symbol?: string; reset?: boolean }) => {
        calls.push(command.cmd);
        if (command.cmd === 'connect') return { ok: true, data: { state: 'Connected' } };
        if (command.cmd === 'loadSymbols') return { ok: true, data: 'symbols loaded' };
        if (command.cmd === 'halt') return { ok: true, data: { state: 'Halted' } };
        if (command.cmd === 'getTargetState') return { ok: true, data: 'halted' };
        if (command.cmd === 'disconnect') return { ok: true, data: {} };
        return { ok: true, data: {} };
      },
      configureNativeSteps: () => {},
    } as unknown as OzoneBackend;
    const session = new DapSession(backend);
    (session as any).rttLogEnabled = false;

    await (session as any).handleLaunch({
      type: 'request',
      seq: 1,
      command: 'launch',
      arguments: {
        probe: 'cmsis-dap',
        device: 'STM32F407VET6',
        program: 'firmware.elf',
        flashBeforeDebug: false,
        rttLogEnabled: false,
      },
    });
    (session as any).stopConnectionMonitor();
    (session as any).stopRttLogPolling();

    expect(calls).toContain('connect');
    expect(calls).toContain('halt');
    expect(calls).not.toContain('runToEntryPoint');
    expect(calls).not.toContain('flash');
    expect(calls).not.toContain('reset');
  });

  it('keeps the halt-only launch behavior when CMSIS-DAP runToEntryPoint is explicitly disabled', async () => {
    const calls: string[] = [];
    const backend = {
      execute: async (command: { cmd: string }) => {
        calls.push(command.cmd);
        if (command.cmd === 'connect') return { ok: true, data: { state: 'Connected' } };
        if (command.cmd === 'loadSymbols') return { ok: true, data: 'symbols loaded' };
        if (command.cmd === 'halt') return { ok: true, data: { state: 'Halted' } };
        if (command.cmd === 'getTargetState') return { ok: true, data: 'halted' };
        return { ok: false, error: `unexpected ${command.cmd}` };
      },
      configureNativeSteps: () => {},
    } as unknown as OzoneBackend;
    const session = new DapSession(backend);
    (session as any).rttLogEnabled = false;

    await (session as any).handleLaunch({
      type: 'request', seq: 2, command: 'launch', arguments: {
        probe: 'cmsis-dap', program: 'firmware.elf', flashBeforeDebug: false,
        runToEntryPoint: false, rttLogEnabled: false,
      },
    });
    (session as any).stopConnectionMonitor();

    expect(calls).toContain('halt');
    expect(calls).not.toContain('runToEntryPoint');
    expect(calls).not.toContain('reset');
    expect(calls).not.toContain('flash');
  });

  it('flashes through the current owner and stops at main before the initial stopped event', async () => {
    const calls: string[] = [];
    const backend = {
      execute: async (command: { cmd: string; symbol?: string; reset?: boolean }) => {
        calls.push(command.cmd);
        if (command.cmd === 'connect') return { ok: true, data: { state: 'Connected' } };
        if (command.cmd === 'flash') return { ok: true, data: { message: 'verified' } };
        if (command.cmd === 'loadSymbols') return { ok: true, data: 'symbols loaded' };
        if (command.cmd === 'runToEntryPoint') {
          expect(command).toMatchObject({ symbol: 'main', reset: true });
          return { ok: true, data: { state: 'Halted', pc: 0x08003a2c, cleanupOk: true } };
        }
        if (command.cmd === 'getCallStack') {
          return {
            ok: true,
            data: [{ id: 1, function: 'main', file: 'Core/Src/main.c', line: 80, address: 0x08003a2c }],
          };
        }
        return { ok: false, error: `unexpected ${command.cmd}` };
      },
      configureNativeSteps: () => {},
    } as unknown as OzoneBackend;
    const session = new DapSession(backend);
    (session as any).rttLogEnabled = false;
    const messages: DebugProtocolMessage[] = [];
    session.on('send', message => messages.push(message));

    await (session as any).handleLaunch({
      type: 'request', seq: 10, command: 'launch', arguments: {
        probe: 'cmsis-dap', device: 'STM32F407VET6', program: 'firmware.elf',
        flashBeforeDebug: true, rttLogEnabled: false,
      },
    });
    (session as any).stopConnectionMonitor();
    await (session as any).handleConfigurationDone(request(11, 'configurationDone'));
    await (session as any).handleStackTrace({
      ...request(12, 'stackTrace'), arguments: { threadId: 1 },
    });

    expect(calls.filter(command => command === 'flash')).toHaveLength(1);
    expect(calls).toContain('runToEntryPoint');
    expect(calls).not.toContain('reset');
    expect(calls).not.toContain('halt');
    const launchResponse = messages.find(message => message.type === 'response' && message.command === 'launch');
    const stopped = messages.filter(message => message.type === 'event' && message.event === 'stopped');
    const stackResponse = messages.find(message => message.type === 'response' && message.command === 'stackTrace');
    expect(stopped).toHaveLength(1);
    expect(messages.indexOf(stopped[0])).toBeGreaterThan(messages.indexOf(launchResponse!));
    expect(stackResponse?.body?.stackFrames?.[0]).toMatchObject({
      name: 'main', instructionPointerReference: '0x8003A2C',
    });
  });

  it.each([
    'EntryPointUnavailable',
    'BreakpointResourceExhausted',
    'DapControlTimeout',
    'DeviceRemoved',
    'MalformedResponse',
    'NativeOwnerLost',
  ])(
    'fails Launch with structured %s and never publishes stopped',
    async errorCode => {
      const calls: string[] = [];
      const backend = {
        execute: async (command: { cmd: string }) => {
          calls.push(command.cmd);
          if (command.cmd === 'connect') return { ok: true, data: { state: 'Connected' } };
          if (command.cmd === 'flash') return { ok: true, data: { message: 'verified' } };
          if (command.cmd === 'loadSymbols') return { ok: true, data: 'symbols loaded' };
          if (command.cmd === 'runToEntryPoint') {
            return { ok: false, errorCode, error: `${errorCode}: startup stop failed`, targetState: 'Halted' };
          }
          return { ok: false, error: `unexpected ${command.cmd}` };
        },
        configureNativeSteps: () => {},
      } as unknown as OzoneBackend;
      const session = new DapSession(backend);
      (session as any).rttLogEnabled = false;
      const messages: DebugProtocolMessage[] = [];
      session.on('send', message => messages.push(message));

      await (session as any).handleLaunch({
        type: 'request', seq: 20, command: 'launch', arguments: {
          probe: 'cmsis-dap', program: 'firmware.elf', flashBeforeDebug: true,
          rttLogEnabled: false,
        },
      });
      (session as any).stopConnectionMonitor();

      expect(calls).toContain('runToEntryPoint');
      expect(calls).not.toContain('run');
      expect(messages).toContainEqual(expect.objectContaining({
        type: 'response', command: 'launch', success: false,
        message: expect.stringContaining(errorCode),
      }));
      expect(messages.filter(message => message.type === 'event' && message.event === 'stopped'))
        .toHaveLength(0);
    },
  );

  it('records explicit evidence when CMSIS-DAP flashing is skipped', async () => {
    const calls: string[] = [];
    const dapLog = vi.spyOn(log, 'dap');
    const backend = {
      execute: async (command: { cmd: string }) => {
        calls.push(command.cmd);
        if (command.cmd === 'connect') return { ok: true, data: { state: 'Connected' } };
        if (command.cmd === 'getTargetState') return { ok: true, data: 'halted' };
        if (command.cmd === 'loadSymbols') return { ok: true, data: 'symbols loaded' };
        if (command.cmd === 'halt') return { ok: true, data: { state: 'Halted' } };
        if (command.cmd === 'disconnect') return { ok: true, data: {} };
        return { ok: true, data: {} };
      },
      configureNativeSteps: () => {},
    } as unknown as OzoneBackend;
    const session = new DapSession(backend);
    (session as any).rttLogEnabled = false;
    const messages: DebugProtocolMessage[] = [];
    session.on('send', message => messages.push(message));

    await (session as any).handleLaunch({
      type: 'request',
      seq: 2,
      command: 'launch',
      arguments: {
        probe: 'cmsis-dap',
        device: 'STM32F407VET6',
        program: 'firmware.elf',
        flashBeforeDebug: false,
        rttLogEnabled: false,
      },
    });
    (session as any).stopConnectionMonitor();
    (session as any).stopRttLogPolling();

    expect(calls).not.toContain('flash');
    expect(calls).not.toContain('reset');
    expect(messages).toContainEqual(expect.objectContaining({
      type: 'event',
      event: 'output',
      body: { category: 'console', output: 'Flash skipped: flashBeforeDebug=false\n' },
    }));
    expect(dapLog).toHaveBeenCalledWith('flash skipped reason=flashBeforeDebug=false');
    dapLog.mockRestore();
  });

  it('declares the standard DAP instruction-stepping capability', async () => {
    const backend = {} as OzoneBackend;
    const session = new DapSession(backend);
    const messages: DebugProtocolMessage[] = [];
    session.on('send', message => messages.push(message));

    await (session as any).handleRequest(request(10, 'initialize'));

    expect(messages).toContainEqual(expect.objectContaining({
      type: 'response',
      command: 'initialize',
      success: true,
      body: expect.objectContaining({ supportsSteppingGranularity: true }),
    }));
  });

  it('routes instruction-granularity stepIn to the CMSIS-DAP instruction primitive', async () => {
    const calls: string[] = [];
    const backend = {
      execute: async (command: { cmd: string }) => {
        calls.push(command.cmd);
        if (command.cmd === 'stepIntoInstruction') {
          return { ok: true, data: { mode: 'cmsis-dap', pcBefore: 0x080001C0, pcAfter: 0x080001C2 } };
        }
        if (command.cmd === 'getTargetState') return { ok: true, data: 'halted' };
        return { ok: false, error: `unexpected ${command.cmd}` };
      },
    } as unknown as OzoneBackend;
    const session = new DapSession(backend);
    (session as any)._probe = 'cmsis-dap';
    (session as any).targetConnectionEstablished = true;
    (session as any).phase = 'connected';
    const messages: DebugProtocolMessage[] = [];
    session.on('send', message => messages.push(message));

    await (session as any).handleRequest({
      ...request(11, 'stepIn'),
      arguments: { threadId: 1, granularity: 'instruction' },
    });

    expect(calls[0]).toBe('stepIntoInstruction');
    const response = messages.find(message => message.type === 'response');
    const stopped = messages.find(message => message.type === 'event' && message.event === 'stopped');
    expect(response).toMatchObject({ success: true, command: 'stepIn' });
    expect(messages.indexOf(stopped!)).toBeGreaterThan(messages.indexOf(response!));
  });

  it('emits stopped only after the current CMSIS-DAP owner confirms a step', async () => {
    const backend = {
      execute: async (command: { cmd: string }) => command.cmd === 'stepInto'
        ? {
          ok: true,
          data: { mode: 'cmsis-dap', pcBefore: 0x080001C0, pcAfter: 0x080001C2 },
        }
        : command.cmd === 'getTargetState'
          ? { ok: true, data: 'halted' }
          : { ok: false, error: `unexpected ${command.cmd}` },
    } as unknown as OzoneBackend;
    const session = new DapSession(backend);
    (session as any)._probe = 'cmsis-dap';
    (session as any).targetConnectionEstablished = true;
    (session as any).phase = 'connected';
    const messages: DebugProtocolMessage[] = [];
    session.on('send', message => messages.push(message));

    await (session as any).handleStep(request(1, 'stepIn'), 'stepInto');

    const response = messages.find(message => message.type === 'response');
    const stopped = messages.find(message => message.type === 'event' && message.event === 'stopped');
    expect(response).toMatchObject({ success: true, command: 'stepIn' });
    expect(stopped).toMatchObject({
      body: { reason: 'step', threadId: 1, allThreadsStopped: true },
    });
    expect(messages.indexOf(stopped!)).toBeGreaterThan(messages.indexOf(response!));
  });

  it('uses the trusted halted state returned by the CMSIS-DAP source-step owner', async () => {
    const calls: string[] = [];
    const backend = {
      execute: async (command: { cmd: string }) => {
        calls.push(command.cmd);
        if (command.cmd === 'stepInto') {
          return {
            ok: true,
            data: {
              mode: 'cmsis-dap',
              targetState: 'Halted',
              pcBefore: 0x080001C0,
              pcAfter: 0x080001C2,
            },
          };
        }
        return { ok: false, error: `unexpected ${command.cmd}` };
      },
    } as unknown as OzoneBackend;
    const session = new DapSession(backend);
    (session as any)._probe = 'cmsis-dap';
    (session as any).targetConnectionEstablished = true;
    (session as any).phase = 'connected';

    await (session as any).handleStep(request(2, 'stepIn'), 'stepInto');

    expect(calls).toEqual(['stepInto']);
  });

  it.each([
    ['next', 'stepOver'],
    ['stepOut', 'stepOut'],
  ] as const)('responds to %s before exactly one stopped event from the CMSIS-DAP source step', async (command, backendCommand) => {
    const calls: string[] = [];
    const backend = {
      execute: async (operation: { cmd: string }) => {
        calls.push(operation.cmd);
        if (operation.cmd === 'getTargetState') return { ok: true, data: 'halted' };
        return operation.cmd === backendCommand
          ? { ok: true, data: { mode: 'cmsis-dap', pcBefore: 0x080001C0, pcAfter: 0x080001C6 } }
          : { ok: false, error: `unexpected ${operation.cmd}` };
      },
    } as unknown as OzoneBackend;
    const session = new DapSession(backend);
    (session as any)._probe = 'cmsis-dap';
    (session as any).targetConnectionEstablished = true;
    (session as any).phase = 'connected';
    const messages: DebugProtocolMessage[] = [];
    session.on('send', message => messages.push(message));

    await (session as any).handleRequest({ ...request(20, command), arguments: { threadId: 1 } });

    expect(calls[0]).toBe(backendCommand);
    expect(calls.every(call => call === backendCommand || call === 'getTargetState')).toBe(true);
    const response = messages.find(message => message.type === 'response');
    const stopped = messages.filter(message => message.type === 'event' && message.event === 'stopped');
    expect(response).toMatchObject({ success: true, command });
    expect(stopped).toHaveLength(1);
    expect(messages.indexOf(stopped[0])).toBeGreaterThan(messages.indexOf(response!));
  });

  it('emits continued only after CMSIS-DAP confirms Running, never through J-Link', async () => {
    const calls: string[] = [];
    const backend = {
      execute: async (command: { cmd: string }) => {
        calls.push(command.cmd);
        if (command.cmd === 'run') return { ok: true, data: { state: 'Running' } };
        if (command.cmd === 'getTargetState') return { ok: true, data: 'running' };
        return { ok: false, error: `unexpected ${command.cmd}` };
      },
    } as unknown as OzoneBackend;
    const session = new DapSession(backend);
    (session as any)._probe = 'cmsis-dap';
    (session as any).targetConnectionEstablished = true;
    (session as any).phase = 'connected';
    const messages: DebugProtocolMessage[] = [];
    session.on('send', message => messages.push(message));

    await (session as any).handleContinue(request(2, 'continue'));
    (session as any).stopPolling();

    const response = messages.find(message => message.type === 'response');
    const continued = messages.find(message => message.type === 'event' && message.event === 'continued');
    expect(response).toMatchObject({ success: true, command: 'continue' });
    expect(continued).toMatchObject({ body: { threadId: 1, allThreadsContinued: true } });
    expect(messages.indexOf(continued!)).toBeGreaterThan(messages.indexOf(response!));
    expect(calls).toEqual(['run', 'getTargetState']);
  });

  it('responds before continued and one stopped event when a breakpoint hits before Running is observed', async () => {
    const calls: string[] = [];
    const backend = {
      execute: async (command: { cmd: string }) => {
        calls.push(command.cmd);
        if (command.cmd === 'run') {
          return {
            ok: true,
            data: {
              state: 'Halted',
              pc: 0x08003150,
              breakpointHitBeforeRunningObserved: true,
            },
          };
        }
        return { ok: false, error: `unexpected ${command.cmd}` };
      },
    } as unknown as OzoneBackend;
    const session = new DapSession(backend);
    (session as any)._probe = 'cmsis-dap';
    (session as any).targetConnectionEstablished = true;
    (session as any).phase = 'connected';
    const messages: DebugProtocolMessage[] = [];
    session.on('send', message => messages.push(message));

    await (session as any).handleContinue(request(3, 'continue'));

    const response = messages.find(message => message.type === 'response');
    const continued = messages.find(message => message.type === 'event' && message.event === 'continued');
    const stopped = messages.filter(message => message.type === 'event' && message.event === 'stopped');
    expect(response).toMatchObject({ success: true, command: 'continue' });
    expect(continued).toMatchObject({ body: { threadId: 1, allThreadsContinued: true } });
    expect(stopped).toHaveLength(1);
    expect(stopped[0]).toMatchObject({ body: { reason: 'breakpoint', threadId: 1 } });
    expect(messages.indexOf(continued!)).toBeGreaterThan(messages.indexOf(response!));
    expect(messages.indexOf(stopped[0])).toBeGreaterThan(messages.indexOf(continued!));
    expect(calls).toEqual(['run']);
  });

  it('invalidates the stopped thread stack on every polled breakpoint hit', async () => {
    vi.useFakeTimers();
    const backend = {
      execute: vi.fn(async (command: { cmd: string }) => command.cmd === 'getTargetState'
        ? { ok: true, data: 'halted' }
        : { ok: false, error: `unexpected ${command.cmd}` }),
    } as unknown as OzoneBackend;
    const session = new DapSession(backend);
    const messages: DebugProtocolMessage[] = [];
    session.on('send', message => messages.push(message));

    try {
      for (let hit = 0; hit < 2; hit++) {
        (session as any).setTargetRunning(true);
        (session as any).lastHaltReason = 'breakpoint';
        (session as any).startPolling();
        await vi.advanceTimersByTimeAsync(200);
      }

      const stopped = messages.filter(message => message.type === 'event' && message.event === 'stopped');
      expect(stopped).toHaveLength(2);
      expect(stopped).toEqual([
        expect.objectContaining({
          body: { reason: 'breakpoint', threadId: 1, allThreadsStopped: true },
        }),
        expect.objectContaining({
          body: { reason: 'breakpoint', threadId: 1, allThreadsStopped: true },
        }),
      ]);
    } finally {
      (session as any).stopPolling();
      vi.useRealTimers();
    }
  });

  it('logs distinct DAP stop generations and correlated stack responses for repeated same-PC hits', async () => {
    vi.useFakeTimers();
    const dapLog = vi.spyOn(log, 'dap').mockImplementation(() => {});
    const sourcePath = 'D:/STM32/project/vet6_led/Core/Src/freertos.c';
    const backend = {
      execute: vi.fn(async (command: { cmd: string }) => {
        if (command.cmd === 'getTargetState') return { ok: true, data: 'halted' };
        if (command.cmd === 'getCallStack') {
          return {
            ok: true,
            data: [{
              id: 1,
              level: 0,
              function: 'StartDefaultTask',
              file: sourcePath,
              line: 293,
              address: 0x08003FB0,
            }],
          };
        }
        return { ok: false, error: `unexpected ${command.cmd}` };
      }),
    } as unknown as OzoneBackend;
    const session = new DapSession(backend);
    const messages: DebugProtocolMessage[] = [];
    session.on('send', message => messages.push(message));

    try {
      for (let hit = 0; hit < 2; hit++) {
        (session as any).setTargetRunning(true);
        (session as any).lastHaltReason = 'breakpoint';
        (session as any).startPolling();
        await vi.advanceTimersByTimeAsync(200);
        await (session as any).handleStackTrace({
          ...request(41 + hit, 'stackTrace'),
          arguments: { threadId: 1 },
        });
      }

      expect(dapLog).toHaveBeenCalledWith(
        '[protocol] event seq=1 event=stopped stopGeneration=1 reason=breakpoint threadId=1 allThreadsStopped=true',
      );
      expect(dapLog).toHaveBeenCalledWith(
        `[protocol] response seq=2 requestSeq=41 command=stackTrace success=true stopGeneration=1`
          + ` frameCount=1 frame0Id=1 pc=0x8003FB0 source=${sourcePath}:293`,
      );
      expect(dapLog).toHaveBeenCalledWith(
        '[protocol] event seq=3 event=stopped stopGeneration=2 reason=breakpoint threadId=1 allThreadsStopped=true',
      );
      expect(dapLog).toHaveBeenCalledWith(
        `[protocol] response seq=4 requestSeq=42 command=stackTrace success=true stopGeneration=2`
          + ` frameCount=1 frame0Id=1 pc=0x8003FB0 source=${sourcePath}:293`,
      );
      expect(messages.map(message => message.seq)).toEqual([1, 2, 3, 4]);
    } finally {
      (session as any).stopPolling();
      dapLog.mockRestore();
      vi.useRealTimers();
    }
  });

  it('reserves the target-read gate for a breakpoint stackTrace ahead of a new Watch read', async () => {
    vi.useFakeTimers();
    const backend = {
      execute: vi.fn(async (command: { cmd: string }) => command.cmd === 'getCallStack'
        ? {
          ok: true,
          data: [{
            id: 1,
            level: 0,
            function: 'StartDefaultTask',
            file: 'D:/STM32/project/vet6_led/Core/Src/freertos.c',
            line: 293,
            address: 0x08003FB0,
          }],
        }
        : { ok: false, error: `unexpected ${command.cmd}` }),
    } as unknown as OzoneBackend;
    const session = new DapSession(backend);
    const messages: DebugProtocolMessage[] = [];
    session.on('send', message => messages.push(message));

    try {
      // Model the breakpoint arriving while one runtime read is still in flight.
      (session as any).targetReadInProgress = true;
      const stackTrace = (session as any).handleStackTrace(request(31, 'stackTrace'));
      await vi.advanceTimersByTimeAsync(1);

      // Once the current read releases the gate, a newly arriving Watch slice
      // must yield to the already-waiting stopped-state stack request.
      (session as any).endTargetRead();
      const watchRead = (session as any).beginWatchTargetRead();
      await vi.advanceTimersByTimeAsync(720);
      const watchAcquired = await watchRead;
      if (watchAcquired) (session as any).endTargetRead();
      await stackTrace;

      const response = messages.find(message => message.type === 'response' && message.command === 'stackTrace');
      expect(response).toMatchObject({
        success: true,
        body: {
          stackFrames: [{
            name: 'StartDefaultTask',
            source: { path: 'D:/STM32/project/vet6_led/Core/Src/freertos.c' },
            line: 293,
            instructionPointerReference: '0x8003FB0',
          }],
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels stale Locals before Continue so the next breakpoint stackTrace can refresh', async () => {
    let localsSignal: AbortSignal | undefined;
    let releaseLocals: (() => void) | undefined;
    let markLocalsStarted: (() => void) | undefined;
    const localsStarted = new Promise<void>(resolve => { markLocalsStarted = resolve; });
    const backend = {
      execute: vi.fn(async (command: { cmd: string; signal?: AbortSignal }) => {
        if (command.cmd === 'getLocals') {
          localsSignal = command.signal;
          markLocalsStarted?.();
          await new Promise<void>(resolve => {
            releaseLocals = resolve;
            command.signal?.addEventListener('abort', () => resolve(), { once: true });
          });
          return {
            ok: true,
            data: [{ name: 'stale', type: 'D', value: '123', address: 0x20000000 }],
          };
        }
        if (command.cmd === 'run') return { ok: true, data: { state: 'Running' } };
        if (command.cmd === 'getTargetState') return { ok: true, data: 'running' };
        if (command.cmd === 'getCallStack') {
          return {
            ok: true,
            data: [{
              id: 1,
              level: 0,
              function: 'StartDefaultTask',
              file: 'D:/STM32/project/vet6_led/Core/Src/freertos.c',
              line: 293,
              address: 0x08003FB0,
            }],
          };
        }
        return { ok: false, error: `unexpected ${command.cmd}` };
      }),
    } as unknown as OzoneBackend;
    const session = new DapSession(backend);
    (session as any)._probe = 'cmsis-dap';
    (session as any).targetConnectionEstablished = true;
    (session as any).phase = 'connected';
    const messages: DebugProtocolMessage[] = [];
    session.on('send', message => messages.push(message));

    const variables = (session as any).handleVariables({
      ...request(51, 'variables'),
      arguments: { variablesReference: 1 },
    });
    await localsStarted;

    try {
      await (session as any).handleContinue(request(52, 'continue'));
      (session as any).stopPolling();
      expect(localsSignal?.aborted).toBe(true);
      await variables;

      await (session as any).handleStackTrace({
        ...request(53, 'stackTrace'),
        arguments: { threadId: 1 },
      });

      const variablesResponse = messages.find(message => message.type === 'response' && message.command === 'variables');
      const stackResponse = messages.find(message => message.type === 'response' && message.command === 'stackTrace');
      expect(variablesResponse).toMatchObject({ success: true, body: { variables: [] } });
      expect(stackResponse).toMatchObject({
        success: true,
        body: { stackFrames: [expect.objectContaining({ line: 293 })] },
      });
    } finally {
      releaseLocals?.();
      (session as any).stopPolling();
      await variables;
    }
  });

  it('preserves standard DAP expansion for non-RTOS compound evaluate results', async () => {
    const backend = {
      execute: vi.fn(async (command: { cmd: string }) => {
        if (command.cmd === 'getTargetState') return { ok: true, data: 'halted' };
        if (command.cmd === 'evaluateExpression') {
          return {
            ok: true,
            data: {
              expression: 'config',
              evaluateName: 'config',
              value: 0x20004000,
              display: 'Config_t',
              hex: '',
              typeName: 'Config_t',
              hasChildren: true,
              children: [{
                expression: 'enabled',
                evaluateName: 'config.enabled',
                value: 1,
                display: '1',
                hex: '0x00000001',
                typeName: 'uint32_t',
              }],
            },
          };
        }
        return { ok: false, error: `unexpected ${command.cmd}` };
      }),
    } as unknown as OzoneBackend;
    const session = new DapSession(backend);
    (session as any).targetConnectionEstablished = true;
    (session as any).phase = 'connected';
    const messages: DebugProtocolMessage[] = [];
    session.on('send', message => messages.push(message));

    await (session as any).handleEvaluate({
      ...request(48, 'evaluate'),
      arguments: { expression: 'config', context: 'hover', frameId: 1 },
    });
    const reference = messages.find(message => message.request_seq === 48)?.body?.variablesReference;
    expect(reference).toBeGreaterThan(0);

    await (session as any).handleVariables({
      ...request(49, 'variables'),
      arguments: { variablesReference: reference },
    });

    expect(messages.find(message => message.request_seq === 49)).toMatchObject({
      success: true,
      body: {
        variables: [expect.objectContaining({
          name: 'enabled',
          evaluateName: 'config.enabled',
          value: '1',
          variablesReference: 0,
        })],
      },
    });
  });

  it('preserves the RTOS Views evaluate, variables, and byte readMemory contract', async () => {
    const backend = {
      execute: vi.fn(async (command: { cmd: string; expression?: string; address?: number; size?: number }) => {
        if (command.cmd === 'getTargetState') return { ok: true, data: 'halted' };
        if (command.cmd === 'evaluateExpression') {
          expect(command.expression).toBe('pxReadyTasksLists');
          return {
            ok: true,
            data: {
              expression: 'pxReadyTasksLists',
              value: 0x20001000,
              display: 'List_t[5]',
              hex: '',
              address: 0x20001000,
              typeName: 'List_t[5]',
              children: [{
                expression: '[0]',
                evaluateName: 'pxReadyTasksLists[0]',
                value: 1,
                display: 'List_t',
                hex: '',
                address: 0x20001000,
                typeName: 'List_t',
                children: [{
                  expression: 'uxNumberOfItems',
                  evaluateName: 'pxReadyTasksLists[0].uxNumberOfItems',
                  value: 1,
                  display: '1',
                  hex: '0x00000001',
                  address: 0x20001000,
                  typeName: 'UBaseType_t',
                }],
              }],
            },
          };
        }
        if (command.cmd === 'readMemory') {
          expect(command).toMatchObject({ address: 0x20002000, size: 4 });
          return {
            ok: true,
            data: { address: 0x20002000, data: [0xa5, 0xa5, 0x00, 0x01], ascii: '....' },
          };
        }
        return { ok: false, error: `unexpected ${command.cmd}` };
      }),
    } as unknown as OzoneBackend;
    const session = new DapSession(backend);
    (session as any)._probe = 'cmsis-dap';
    (session as any)._rtos = 'FreeRTOS';
    (session as any).targetConnectionEstablished = true;
    (session as any).phase = 'connected';
    const messages: DebugProtocolMessage[] = [];
    session.on('send', message => messages.push(message));

    await (session as any).handleEvaluate({
      ...request(50, 'evaluate'),
      arguments: { expression: 'pxReadyTasksLists', context: 'hover', frameId: 1 },
    });
    const evaluateResponse = messages.find(message => message.request_seq === 50);
    const listReference = evaluateResponse?.body?.variablesReference;
    expect(evaluateResponse).toMatchObject({
      success: true,
      body: {
        result: 'List_t[5]',
        type: 'List_t[5]',
        variablesReference: expect.any(Number),
        memoryReference: '0x20001000',
      },
    });
    expect(listReference).toBeGreaterThan(0);

    await (session as any).handleVariables({
      ...request(51, 'variables'),
      arguments: { variablesReference: listReference },
    });
    const variablesResponse = messages.find(message => message.request_seq === 51);
    expect(variablesResponse).toMatchObject({
      success: true,
      body: {
        variables: [expect.objectContaining({
          name: '[0]',
          evaluateName: 'pxReadyTasksLists[0]',
          variablesReference: expect.any(Number),
          memoryReference: '0x20001000',
        })],
      },
    });

    await (session as any).handleReadMemory({
      ...request(52, 'readMemory'),
      arguments: { memoryReference: '0x20002000', count: 4 },
    });
    expect(messages.find(message => message.request_seq === 52)).toMatchObject({
      success: true,
      body: {
        address: '0x20002000',
        data: Buffer.from([0xa5, 0xa5, 0x00, 0x01]).toString('base64'),
        unreadableBytes: 0,
      },
    });
  });

  it('keeps compound RTOS variables expandable while loading one DAP level at a time', async () => {
    const expansionCalls: string[][] = [];
    const backend = {
      execute: vi.fn(async (command: {
        cmd: string;
        expression?: string;
        expandedExpressions?: string[];
      }) => {
        if (command.cmd === 'getTargetState') return { ok: true, data: 'halted' };
        if (command.cmd !== 'evaluateExpression') {
          return { ok: false, error: `unexpected ${command.cmd}` };
        }

        expect(command.expression).toBe('pxReadyTasksLists');
        expansionCalls.push(command.expandedExpressions || []);
        const expanded = new Set(command.expandedExpressions);
        const list = {
          expression: '[0]',
          evaluateName: 'pxReadyTasksLists[0]',
          value: 0,
          display: 'List_t',
          hex: '',
          address: 0x20001000,
          typeName: 'List_t',
          hasChildren: true,
          children: expanded.has('pxReadyTasksLists[0]')
            ? [{
              expression: 'uxNumberOfItems',
              evaluateName: 'pxReadyTasksLists[0].uxNumberOfItems',
              value: 3,
              display: '3',
              hex: '0x00000003',
              address: 0x20001000,
              typeName: 'UBaseType_t',
            }]
            : undefined,
        };
        return {
          ok: true,
          data: {
            expression: 'pxReadyTasksLists',
            evaluateName: 'pxReadyTasksLists',
            value: 0x20001000,
            display: 'List_t[40]',
            hex: '',
            address: 0x20001000,
            typeName: 'List_t[40]',
            hasChildren: true,
            children: expanded.has('pxReadyTasksLists') ? [list] : undefined,
          },
        };
      }),
    } as unknown as OzoneBackend;
    const session = new DapSession(backend);
    (session as any)._probe = 'cmsis-dap';
    (session as any)._rtos = 'FreeRTOS';
    (session as any).targetConnectionEstablished = true;
    (session as any).phase = 'connected';
    const messages: DebugProtocolMessage[] = [];
    session.on('send', message => messages.push(message));

    await (session as any).handleEvaluate({
      ...request(60, 'evaluate'),
      arguments: { expression: 'pxReadyTasksLists', context: 'hover', frameId: 1 },
    });
    const rootReference = messages.find(message => message.request_seq === 60)?.body?.variablesReference;
    expect(rootReference).toBeGreaterThan(0);

    await (session as any).handleVariables({
      ...request(61, 'variables'),
      arguments: { variablesReference: rootReference },
    });
    const listReference = messages.find(message => message.request_seq === 61)?.body?.variables?.[0]?.variablesReference;
    expect(listReference).toBeGreaterThan(0);

    await (session as any).handleVariables({
      ...request(62, 'variables'),
      arguments: { variablesReference: listReference },
    });
    expect(messages.find(message => message.request_seq === 62)).toMatchObject({
      success: true,
      body: {
        variables: [expect.objectContaining({
          name: 'uxNumberOfItems',
          evaluateName: 'pxReadyTasksLists[0].uxNumberOfItems',
          value: '3',
          variablesReference: 0,
        })],
      },
    });
    expect(expansionCalls).toEqual([
      [],
      ['pxReadyTasksLists'],
      ['pxReadyTasksLists', 'pxReadyTasksLists[0]'],
    ]);
  });

  it('runs queued Local reads before a background RTOS variable expansion', async () => {
    const executionOrder: string[] = [];
    const backend = {
      execute: vi.fn(async (command: { cmd: string; priority?: string }) => {
        if (command.cmd === 'getLocals') {
          executionOrder.push('locals');
          return { ok: true, data: [{ name: 'localValue', value: '7', type: 'int' }] };
        }
        if (command.cmd === 'evaluateExpression') {
          expect(command.priority).toBe('background');
          executionOrder.push('rtos');
          return {
            ok: true,
            data: {
              expression: 'pxReadyTasksLists',
              evaluateName: 'pxReadyTasksLists',
              value: 0x20001000,
              display: 'List_t[40]',
              hex: '',
              hasChildren: true,
              children: [{
                expression: '[0]',
                evaluateName: 'pxReadyTasksLists[0]',
                value: 0,
                display: 'List_t',
                hex: '',
                hasChildren: true,
              }],
            },
          };
        }
        return { ok: false, error: `unexpected ${command.cmd}` };
      }),
    } as unknown as OzoneBackend;
    const session = new DapSession(backend);
    (session as any)._probe = 'cmsis-dap';
    (session as any)._rtos = 'FreeRTOS';
    (session as any).targetConnectionEstablished = true;
    (session as any).phase = 'connected';
    (session as any).targetReadInProgress = true;
    (session as any).variableHandles.set(1000, {
      rtosExpansion: {
        rootExpression: 'pxReadyTasksLists',
        expandedExpressions: [],
        targetEvaluateName: 'pxReadyTasksLists',
      },
      stopGeneration: 0,
    });
    const messages: DebugProtocolMessage[] = [];
    session.on('send', message => messages.push(message));

    const rtosVariables = (session as any).handleVariables({
      ...request(63, 'variables'),
      arguments: { variablesReference: 1000 },
    });
    await Promise.resolve();
    const locals = (session as any).handleVariables({
      ...request(64, 'variables'),
      arguments: { variablesReference: 1 },
    });
    await Promise.resolve();
    (session as any).endTargetRead();
    await Promise.all([rtosVariables, locals]);

    expect(executionOrder).toEqual(['locals', 'rtos']);
    expect(messages.find(message => message.request_seq === 64)).toMatchObject({
      success: true,
      body: { variables: [expect.objectContaining({ name: 'localValue', value: '7' })] },
    });
    expect(messages.find(message => message.request_seq === 63)).toMatchObject({
      success: true,
      body: { variables: [expect.objectContaining({ name: '[0]' })] },
    });
  });

  it('returns a structured failure instead of a successful zero reference when RTOS evaluate times out', async () => {
    vi.useFakeTimers();
    const backend = {
      execute: vi.fn(async (command: { cmd: string }) => ({ ok: false, error: `unexpected ${command.cmd}` })),
    } as unknown as OzoneBackend;
    const session = new DapSession(backend);
    (session as any)._probe = 'cmsis-dap';
    (session as any)._rtos = 'FreeRTOS';
    (session as any).targetConnectionEstablished = true;
    (session as any).phase = 'connected';
    (session as any).targetReadInProgress = true;
    const messages: DebugProtocolMessage[] = [];
    session.on('send', message => messages.push(message));

    try {
      const evaluate = (session as any).handleEvaluate({
        ...request(67, 'evaluate'),
        arguments: { expression: 'pxReadyTasksLists', context: 'hover', frameId: 1 },
      });
      await vi.advanceTimersByTimeAsync(1200);
      await evaluate;

      expect(backend.execute).not.toHaveBeenCalled();
      expect(messages.find(message => message.request_seq === 67)).toMatchObject({
        success: false,
        body: {
          variablesReference: 0,
          errorCode: 'TargetReadUnavailable',
          targetState: 'Halted',
          elapsedMs: expect.any(Number),
          diagnostics: { targetReadGate: expect.any(Object) },
        },
      });
      expect(messages.find(message => message.request_seq === 67)?.body?.elapsedMs).toBeGreaterThanOrEqual(0);
    } finally {
      (session as any).targetReadInProgress = false;
      vi.useRealTimers();
    }
  });

  it('detects FreeRTOS through rtosInfo symbol probing and preserves diagnostics', async () => {
    const backend = {
      execute: vi.fn(async (command: { cmd: string; expression?: string; signal?: AbortSignal }) => {
        if (command.cmd === 'evaluateExpression') {
          expect(command.expression).toBe('uxCurrentNumberOfTasks');
          expect(command.signal).toBeInstanceOf(AbortSignal);
          return {
            ok: true,
            data: { expression: command.expression, value: 3, display: '3', hex: '0x3', typeName: 'UBaseType_t' },
            targetState: 'Halted',
            elapsedMs: 4,
            diagnostics: { ownerKind: 'cmsis-dap', symbolProbe: true },
          };
        }
        return { ok: false, error: `unexpected ${command.cmd}` };
      }),
    } as unknown as OzoneBackend;
    const session = new DapSession(backend);
    (session as any)._probe = 'cmsis-dap';
    (session as any).targetConnectionEstablished = true;
    (session as any).phase = 'connected';
    const messages: DebugProtocolMessage[] = [];
    session.on('send', message => messages.push(message));

    await (session as any).handleRequest(request(49, 'rtosInfo'));

    expect(messages.find(message => message.request_seq === 49)).toMatchObject({
      success: true,
      body: {
        rtos: 'FreeRTOS',
        detected: true,
        targetState: 'Halted',
        elapsedMs: 4,
        diagnostics: { ownerKind: 'cmsis-dap', symbolProbe: true },
      },
    });
  });

  it('uses the stopped-session state for RTOS evaluate without scheduling getTargetState control work', async () => {
    const backend = {
      execute: vi.fn(async (command: { cmd: string; priority?: string }) => {
        if (command.cmd === 'evaluateExpression') {
          expect(command.priority).toBe('background');
          return {
            ok: true,
            data: {
              expression: 'uxCurrentNumberOfTasks',
              value: 3,
              display: '3',
              hex: '0x00000003',
              typeName: 'UBaseType_t',
            },
          };
        }
        return { ok: false, error: `unexpected ${command.cmd}` };
      }),
    } as unknown as OzoneBackend;
    const session = new DapSession(backend);
    (session as any)._probe = 'cmsis-dap';
    (session as any)._rtos = 'FreeRTOS';
    (session as any).targetConnectionEstablished = true;
    (session as any).phase = 'connected';
    (session as any).targetRunning = false;
    const messages: DebugProtocolMessage[] = [];
    session.on('send', message => messages.push(message));

    await (session as any).handleEvaluate({
      ...request(70, 'evaluate'),
      arguments: { expression: 'uxCurrentNumberOfTasks', context: 'hover', frameId: 1 },
    });

    expect(backend.execute).toHaveBeenCalledTimes(1);
    expect(backend.execute).not.toHaveBeenCalledWith(expect.objectContaining({ cmd: 'getTargetState' }));
    expect(messages.find(message => message.request_seq === 70)).toMatchObject({
      success: true,
      body: { result: '3', variablesReference: 0 },
    });
  });

  it('does not publish a variablesReference tree created before Continue', async () => {
    const backend = {
      execute: vi.fn(async (command: { cmd: string }) => {
        if (command.cmd === 'run') return { ok: true, data: { state: 'Running' } };
        if (command.cmd === 'getTargetState') return { ok: true, data: 'running' };
        return { ok: false, error: `unexpected ${command.cmd}` };
      }),
    } as unknown as OzoneBackend;
    const session = new DapSession(backend);
    (session as any)._probe = 'cmsis-dap';
    (session as any).targetConnectionEstablished = true;
    (session as any).phase = 'connected';
    (session as any).variableHandles.set(1000, [{
      expression: 'pxReadyTasksLists[0]',
      evaluateName: 'pxReadyTasksLists[0]',
      value: 1,
      display: 'List_t',
      hex: '',
      address: 0x20001000,
      typeName: 'List_t',
    }]);
    const messages: DebugProtocolMessage[] = [];
    session.on('send', message => messages.push(message));

    await (session as any).handleContinue(request(53, 'continue'));
    (session as any).stopPolling();
    await (session as any).handleVariables({
      ...request(54, 'variables'),
      arguments: { variablesReference: 1000 },
    });

    expect(messages.find(message => message.request_seq === 54)).toMatchObject({
      success: true,
      body: { variables: [] },
    });
  });

  it('cancels an active lazy RTOS variables expansion on Continue without publishing stale children', async () => {
    let evaluateSignal: AbortSignal | undefined;
    let markEvaluateStarted: (() => void) | undefined;
    const evaluateStarted = new Promise<void>(resolve => { markEvaluateStarted = resolve; });
    const backend = {
      execute: vi.fn(async (command: { cmd: string; signal?: AbortSignal }) => {
        if (command.cmd === 'evaluateExpression') {
          evaluateSignal = command.signal;
          markEvaluateStarted?.();
          await new Promise<void>(resolve => {
            command.signal?.addEventListener('abort', () => resolve(), { once: true });
          });
          return {
            ok: true,
            data: {
              expression: 'pxReadyTasksLists',
              evaluateName: 'pxReadyTasksLists',
              value: 0,
              display: 'stale',
              hex: '',
              children: [{ expression: '[0]', value: 0, display: 'stale child', hex: '' }],
            },
          };
        }
        if (command.cmd === 'run') return { ok: true, data: { state: 'Running' } };
        if (command.cmd === 'getTargetState') return { ok: true, data: 'running' };
        return { ok: false, error: `unexpected ${command.cmd}` };
      }),
    } as unknown as OzoneBackend;
    const session = new DapSession(backend);
    (session as any)._probe = 'cmsis-dap';
    (session as any)._rtos = 'FreeRTOS';
    (session as any).targetConnectionEstablished = true;
    (session as any).phase = 'connected';
    (session as any).variableHandles.set(1000, {
      rtosExpansion: {
        rootExpression: 'pxReadyTasksLists',
        expandedExpressions: [],
        targetEvaluateName: 'pxReadyTasksLists',
      },
      stopGeneration: 0,
    });
    const messages: DebugProtocolMessage[] = [];
    session.on('send', message => messages.push(message));

    const variables = (session as any).handleVariables({
      ...request(65, 'variables'),
      arguments: { variablesReference: 1000 },
    });
    await evaluateStarted;
    const continueRequest = (session as any).handleContinue(request(66, 'continue'));
    await Promise.all([variables, continueRequest]);
    (session as any).stopPolling();

    expect(evaluateSignal?.aborted).toBe(true);
    expect((session as any).variableHandles.size).toBe(0);
    expect(messages.find(message => message.request_seq === 65)).toMatchObject({
      success: false,
      body: {
        variables: [],
        errorCode: 'RtosReadCancelled',
        targetState: 'Halted',
        elapsedMs: expect.any(Number),
        diagnostics: expect.objectContaining({
          readEpoch: expect.any(Number),
          stopGeneration: expect.any(Number),
        }),
      },
    });
    expect(messages.find(message => message.request_seq === 65)).not.toMatchObject({
      body: { variables: [expect.objectContaining({ value: 'stale child' })] },
    });
  });

  it('does not publish cached RTOS children after the target connection is lost', async () => {
    const backend = {
      execute: vi.fn(),
      dispose: vi.fn(async () => {}),
    } as unknown as OzoneBackend;
    const session = new DapSession(backend);
    (session as any)._probe = 'cmsis-dap';
    (session as any)._rtos = 'FreeRTOS';
    (session as any).targetConnectionEstablished = true;
    (session as any).phase = 'connected';
    (session as any).variableHandles.set(1001, {
      children: [{
        expression: 'staleTask',
        evaluateName: 'staleTask',
        value: 0x20005000,
        display: 'staleTask',
        hex: '',
      }],
      rtosExpansion: {
        rootExpression: 'pxReadyTasksLists',
        expandedExpressions: ['pxReadyTasksLists'],
        targetEvaluateName: 'pxReadyTasksLists',
      },
      stopGeneration: 0,
    });
    const messages: DebugProtocolMessage[] = [];
    session.on('send', message => messages.push(message));

    await (session as any).terminateForConnectionLoss('DeviceRemoved');
    await (session as any).handleVariables({
      ...request(68, 'variables'),
      arguments: { variablesReference: 1001 },
    });

    expect((session as any).variableHandles.size).toBe(0);
    expect(messages.find(message => message.request_seq === 68)).not.toMatchObject({
      body: { variables: [expect.objectContaining({ name: 'staleTask' })] },
    });
  });

  it('returns structured RTOS cancellation when a stop generation invalidates a lazy handle', async () => {
    const backend = { execute: vi.fn() } as unknown as OzoneBackend;
    const session = new DapSession(backend);
    (session as any)._probe = 'cmsis-dap';
    (session as any)._rtos = 'FreeRTOS';
    (session as any).targetConnectionEstablished = true;
    (session as any).phase = 'connected';
    (session as any).stopGeneration = 2;
    (session as any).variableHandles.set(1002, {
      rtosExpansion: {
        rootExpression: 'pxReadyTasksLists',
        expandedExpressions: [],
        targetEvaluateName: 'pxReadyTasksLists',
      },
      stopGeneration: 1,
    });
    const messages: DebugProtocolMessage[] = [];
    session.on('send', message => messages.push(message));

    await (session as any).handleVariables({
      ...request(69, 'variables'),
      arguments: { variablesReference: 1002 },
    });

    expect(backend.execute).not.toHaveBeenCalled();
    expect(messages.find(message => message.request_seq === 69)).toMatchObject({
      success: false,
      body: {
        variables: [],
        errorCode: 'RtosReadCancelled',
        targetState: 'Halted',
        elapsedMs: expect.any(Number),
        diagnostics: {
          readEpoch: expect.any(Number),
          stopGeneration: 2,
          handleStopGeneration: 1,
        },
      },
    });
  });

  it('cancels stale RTOS readMemory and never publishes its result after Continue', async () => {
    let readSignal: AbortSignal | undefined;
    let releaseRead: (() => void) | undefined;
    let readStarted: (() => void) | undefined;
    const started = new Promise<void>(resolve => { readStarted = resolve; });
    const backend = {
      execute: vi.fn(async (command: { cmd: string; signal?: AbortSignal }) => {
        if (command.cmd === 'readMemory') {
          readSignal = command.signal;
          readStarted?.();
          await new Promise<void>(resolve => {
            releaseRead = resolve;
            command.signal?.addEventListener('abort', () => resolve(), { once: true });
          });
          return { ok: true, data: { address: 0x20003000, data: [0x5a], ascii: 'Z' } };
        }
        if (command.cmd === 'run') return { ok: true, data: { state: 'Running' } };
        if (command.cmd === 'getTargetState') return { ok: true, data: 'running' };
        return { ok: false, error: `unexpected ${command.cmd}` };
      }),
    } as unknown as OzoneBackend;
    const session = new DapSession(backend);
    (session as any)._probe = 'cmsis-dap';
    (session as any).targetConnectionEstablished = true;
    (session as any).phase = 'connected';
    const messages: DebugProtocolMessage[] = [];
    session.on('send', message => messages.push(message));

    const read = (session as any).handleReadMemory({
      ...request(55, 'readMemory'),
      arguments: { memoryReference: '0x20003000', count: 1 },
    });
    await started;
    const cont = (session as any).handleContinue(request(56, 'continue'));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(readSignal?.aborted).toBe(true);
    releaseRead?.();
    await Promise.all([read, cont]);
    (session as any).stopPolling();

    expect(messages.find(message => message.request_seq === 55)).toMatchObject({
      success: false,
      body: { unreadableBytes: 1 },
    });
  });

  it('cancels stale RTOS evaluate before Continue so the next breakpoint stackTrace can refresh', async () => {
    let evaluateSignal: AbortSignal | undefined;
    let releaseEvaluate: (() => void) | undefined;
    let markEvaluateStarted: (() => void) | undefined;
    let running = false;
    const evaluateStarted = new Promise<void>(resolve => { markEvaluateStarted = resolve; });
    const backend = {
      execute: vi.fn(async (command: { cmd: string; signal?: AbortSignal }) => {
        if (command.cmd === 'evaluateExpression') {
          evaluateSignal = command.signal;
          markEvaluateStarted?.();
          await new Promise<void>(resolve => { releaseEvaluate = resolve; });
          return {
            ok: true,
            data: { expression: 'pxReadyTasksLists', value: 99, display: 'stale', hex: '0x63' },
          };
        }
        if (command.cmd === 'run') {
          running = true;
          return { ok: true, data: { state: 'Running' } };
        }
        if (command.cmd === 'getTargetState') return { ok: true, data: running ? 'running' : 'halted' };
        if (command.cmd === 'getCallStack') {
          return {
            ok: true,
            data: [{
              id: 1,
              level: 0,
              function: 'StartDefaultTask',
              file: 'D:/STM32/project/vet6_led/Core/Src/freertos.c',
              line: 293,
              address: 0x08003FB0,
            }],
          };
        }
        return { ok: false, error: `unexpected ${command.cmd}` };
      }),
    } as unknown as OzoneBackend;
    const session = new DapSession(backend);
    (session as any)._probe = 'cmsis-dap';
    (session as any).targetConnectionEstablished = true;
    (session as any).phase = 'connected';
    const messages: DebugProtocolMessage[] = [];
    session.on('send', message => messages.push(message));

    const evaluate = (session as any).handleEvaluate({
      ...request(54, 'evaluate'),
      arguments: { expression: 'pxReadyTasksLists', context: 'hover', frameId: 1 },
    });
    await evaluateStarted;
    const continueRequest = (session as any).handleContinue(request(55, 'continue'));
    await new Promise<void>(resolve => setImmediate(resolve));
    const evaluateWasAborted = evaluateSignal?.aborted === true;
    releaseEvaluate?.();

    try {
      await Promise.all([evaluate, continueRequest]);
      (session as any).stopPolling();
      await (session as any).handleStackTrace({
        ...request(56, 'stackTrace'),
        arguments: { threadId: 1 },
      });

      const evaluateResponse = messages.find(message => message.type === 'response' && message.command === 'evaluate');
      const stackResponse = messages.find(message => message.type === 'response' && message.command === 'stackTrace');
      expect(evaluateWasAborted).toBe(true);
      expect(evaluateResponse).not.toMatchObject({ body: { result: 'stale' } });
      expect(stackResponse).toMatchObject({
        success: true,
        body: { stackFrames: [expect.objectContaining({ line: 293 })] },
      });
    } finally {
      releaseEvaluate?.();
      (session as any).stopPolling();
      await Promise.all([evaluate, continueRequest]);
    }
  });

  it('responds to pause before publishing exactly one confirmed stopped event', async () => {
    const backend = {
      execute: async (command: { cmd: string }) => {
        if (command.cmd === 'halt') return { ok: true, data: { state: 'Halted' } };
        if (command.cmd === 'getTargetState') return { ok: true, data: 'halted' };
        return { ok: false, error: `unexpected ${command.cmd}` };
      },
    } as unknown as OzoneBackend;
    const session = new DapSession(backend);
    (session as any)._probe = 'cmsis-dap';
    (session as any).targetConnectionEstablished = true;
    (session as any).phase = 'connected';
    const messages: DebugProtocolMessage[] = [];
    session.on('send', message => messages.push(message));

    await (session as any).handlePause(request(3, 'pause'));

    const response = messages.find(message => message.type === 'response');
    const stopped = messages.filter(message => message.type === 'event' && message.event === 'stopped');
    expect(response).toMatchObject({ success: true, command: 'pause' });
    expect(stopped).toHaveLength(1);
    expect(stopped[0]).toMatchObject({ body: { reason: 'pause', threadId: 1 } });
    expect(messages.indexOf(stopped[0])).toBeGreaterThan(messages.indexOf(response!));
  });

  it('runs Restart to main, responds first, and reports main in frame 0 without flashing', async () => {
    const calls: string[] = [];
    const backend = {
      execute: async (command: { cmd: string }) => {
        calls.push(command.cmd);
        if (command.cmd === 'runToEntryPoint') {
          return { ok: true, data: { state: 'Halted', pc: 0x08003a2c, cleanupOk: true } };
        }
        if (command.cmd === 'getCallStack') {
          return {
            ok: true,
            data: [{ id: 1, function: 'main', file: 'Core/Src/main.c', line: 80, address: 0x08003a2c }],
          };
        }
        return { ok: false, error: `unexpected ${command.cmd}` };
      },
    } as unknown as OzoneBackend;
    const session = new DapSession(backend);
    (session as any)._probe = 'cmsis-dap';
    (session as any)._flashEnabled = false;
    (session as any)._runToEntryPoint = 'main';
    (session as any).targetConnectionEstablished = true;
    (session as any).phase = 'connected';
    (session as any).rttLogEnabled = false;
    const messages: DebugProtocolMessage[] = [];
    session.on('send', message => messages.push(message));

    await (session as any).handleRestart(request(4, 'restart'));
    await (session as any).handleStackTrace({
      ...request(5, 'stackTrace'), arguments: { threadId: 1 },
    });

    const response = messages.find(message => message.type === 'response');
    const stopped = messages.filter(message => message.type === 'event' && message.event === 'stopped');
    expect(calls.filter(command => command === 'flash' || command === 'runToEntryPoint'))
      .toEqual(['runToEntryPoint']);
    expect(response).toMatchObject({ success: true, command: 'restart' });
    expect(stopped).toHaveLength(1);
    expect(stopped[0]).toMatchObject({ body: { reason: 'entry', threadId: 1 } });
    expect(messages.indexOf(stopped[0])).toBeGreaterThan(messages.indexOf(response!));
    const stackResponse = messages.find(message => message.type === 'response' && message.command === 'stackTrace');
    expect(stackResponse?.body?.stackFrames?.[0]).toMatchObject({
      name: 'main', instructionPointerReference: '0x8003A2C',
    });
  });

  it('halts and confirms the CMSIS-DAP target before Restart flashes and runs to main', async () => {
    const calls: string[] = [];
    const backend = {
      execute: async (command: { cmd: string }) => {
        calls.push(command.cmd);
        if (command.cmd === 'halt') return { ok: true, data: { state: 'Halted' } };
        if (command.cmd === 'getTargetState') return { ok: true, data: 'halted' };
        if (command.cmd === 'flash') return { ok: true, data: { message: 'verified' } };
        if (command.cmd === 'runToEntryPoint') {
          return { ok: true, data: { state: 'Halted', pc: 0x08003a2c, cleanupOk: true } };
        }
        return { ok: false, error: `unexpected ${command.cmd}` };
      },
    } as unknown as OzoneBackend;
    const session = new DapSession(backend);
    (session as any)._probe = 'cmsis-dap';
    (session as any)._elfPath = 'firmware.elf';
    (session as any)._flashEnabled = true;
    (session as any)._runToEntryPoint = 'main';
    (session as any).targetConnectionEstablished = true;
    (session as any).phase = 'connected';
    (session as any).rttLogEnabled = false;
    const messages: DebugProtocolMessage[] = [];
    session.on('send', message => messages.push(message));

    await (session as any).handleRestart(request(6, 'restart'));

    expect(calls.filter(command =>
      command === 'halt'
      || command === 'getTargetState'
      || command === 'flash'
      || command === 'runToEntryPoint'))
      .toEqual(['halt', 'getTargetState', 'flash', 'runToEntryPoint']);
    const response = messages.find(message => message.type === 'response' && message.command === 'restart');
    const stopped = messages.filter(message => message.type === 'event' && message.event === 'stopped');
    expect(response).toMatchObject({ success: true });
    expect(stopped).toHaveLength(1);
    expect(messages.indexOf(stopped[0])).toBeGreaterThan(messages.indexOf(response!));
  });

  it('reports the confirmed halted state after a Restart flash failure without hanging the UI', async () => {
    const backend = {
      execute: async (command: { cmd: string }) => {
        if (command.cmd === 'halt') return { ok: true, data: { state: 'Halted' } };
        if (command.cmd === 'getTargetState') return { ok: true, data: 'halted' };
        if (command.cmd === 'flash') {
          return {
            ok: false,
            errorCode: 'AlgorithmError',
            error: 'AlgorithmError: Flash Algorithm failed',
            targetState: 'Halted',
          };
        }
        return { ok: false, error: `unexpected ${command.cmd}` };
      },
    } as unknown as OzoneBackend;
    const session = new DapSession(backend);
    (session as any)._probe = 'cmsis-dap';
    (session as any)._elfPath = 'firmware.elf';
    (session as any)._flashEnabled = true;
    (session as any)._runToEntryPoint = 'main';
    (session as any).targetConnectionEstablished = true;
    (session as any).phase = 'connected';
    (session as any).rttLogEnabled = false;
    const messages: DebugProtocolMessage[] = [];
    session.on('send', message => messages.push(message));

    await (session as any).handleRestart(request(7, 'restart'));

    const response = messages.find(message => message.type === 'response' && message.command === 'restart');
    const stopped = messages.filter(message => message.type === 'event' && message.event === 'stopped');
    expect(response).toMatchObject({
      success: false,
      body: expect.objectContaining({ errorCode: 'AlgorithmError', targetState: 'Halted' }),
    });
    expect(stopped).toHaveLength(1);
    expect(stopped[0]).toMatchObject({ body: { reason: 'pause', threadId: 1 } });
    expect(messages.indexOf(stopped[0])).toBeGreaterThan(messages.indexOf(response!));
  });

  it.each(['BreakpointResourceExhausted', 'DapControlTimeout', 'NativeOwnerLost'])(
    'fails Restart with structured %s and does not publish stopped',
    async errorCode => {
      const backend = {
        execute: vi.fn(async (command: { cmd: string }) => command.cmd === 'runToEntryPoint'
          ? {
            ok: false,
            errorCode,
            error: `${errorCode}: restart startup stop failed`,
            targetState: 'Halted',
            diagnostics: { ownerKind: 'cmsis-dap', cleanupOk: true },
          }
          : { ok: false, error: `unexpected ${command.cmd}` }),
      } as unknown as OzoneBackend;
      const session = new DapSession(backend);
      (session as any)._probe = 'cmsis-dap';
      (session as any)._flashEnabled = false;
      (session as any)._runToEntryPoint = 'main';
      (session as any).targetConnectionEstablished = true;
      (session as any).phase = 'connected';
      const messages: DebugProtocolMessage[] = [];
      session.on('send', message => messages.push(message));

      await (session as any).handleRestart(request(6, 'restart'));

      expect(messages).toContainEqual(expect.objectContaining({
        type: 'response',
        command: 'restart',
        success: false,
        body: expect.objectContaining({ errorCode, targetState: 'Halted' }),
      }));
      expect(messages.filter(message => message.type === 'event' && message.event === 'stopped'))
        .toHaveLength(0);
    },
  );

  it('returns structured CMSIS-DAP readMemory failures in the DAP response body', async () => {
    const backend = {
      execute: vi.fn(async () => ({
        ok: false,
        error: 'DapAckFault: SWD FAULT while reading 0xffffffff',
        errorCode: 'DapAckFault',
        targetState: 'Halted',
        elapsedMs: 7,
        diagnostics: {
          ownerKind: 'cmsis-dap',
          operation: 'readMemory',
          phase: 'transfer',
          ack: 'FAULT',
        },
      })),
    } as unknown as OzoneBackend;
    const session = new DapSession(backend);
    const messages: DebugProtocolMessage[] = [];
    session.on('send', message => messages.push(message));

    await (session as any).handleReadMemory({
      ...request(5, 'readMemory'),
      arguments: { memoryReference: '0xffffffff', count: 4 },
    });

    expect(messages).toContainEqual(expect.objectContaining({
      type: 'response',
      command: 'readMemory',
      success: false,
      message: expect.stringContaining('DapAckFault'),
      body: expect.objectContaining({
        address: '0xFFFFFFFF',
        unreadableBytes: 4,
        errorCode: 'DapAckFault',
        targetState: 'Halted',
        elapsedMs: 7,
        diagnostics: expect.objectContaining({
          ownerKind: 'cmsis-dap',
          operation: 'readMemory',
          phase: 'transfer',
          ack: 'FAULT',
        }),
      }),
    }));
  });

  it('keeps every existing breakpoint mapping when the first clear fails', async () => {
    const sourcePath = 'D:/project/main.c';
    const backend = {
      execute: vi.fn(async (command: { cmd: string; id?: number }) => command.cmd === 'clearBreakpoint'
        ? {
          ok: false,
          error: 'clear refused by target',
          errorCode: 'ClearDenied',
          targetState: 'Halted',
          elapsedMs: 4,
          diagnostics: { slot: command.id },
        }
        : { ok: false, error: `unexpected ${command.cmd}` }),
    } as unknown as OzoneBackend;
    const session = new DapSession(backend);
    const messages: DebugProtocolMessage[] = [];
    session.on('send', message => messages.push(message));
    (session as any).breakpoints.set(`${sourcePath}:10`, 2);
    (session as any).breakpoints.set(`${sourcePath}:11`, 3);

    await (session as any).handleSetBreakpoints(setBreakpointsRequest(60, sourcePath, [20]));

    expect(backend.execute).toHaveBeenCalledTimes(1);
    expect(backend.execute).toHaveBeenCalledWith({ cmd: 'clearBreakpoint', id: 2 });
    expect(Array.from((session as any).breakpoints.entries())).toEqual([
      [`${sourcePath}:10`, 2],
      [`${sourcePath}:11`, 3],
    ]);
    expect(messages).toContainEqual(expect.objectContaining({
      type: 'response',
      command: 'setBreakpoints',
      success: false,
      message: expect.stringContaining('ClearDenied'),
      body: expect.objectContaining({
        errorCode: 'ClearDenied',
        message: 'clear refused by target',
        targetState: 'Halted',
        elapsedMs: 4,
        diagnostics: { slot: 2 },
      }),
    }));
  });

  it('removes only mappings whose hardware slots were cleared before a later clear fails', async () => {
    const sourcePath = 'D:/project/main.c';
    const backend = {
      execute: vi.fn(async (command: { cmd: string; id?: number }) => {
        if (command.cmd !== 'clearBreakpoint') return { ok: false, error: `unexpected ${command.cmd}` };
        if (command.id === 0) return { ok: true, data: { id: 0 } };
        return {
          ok: false,
          error: 'slot 1 transport fault',
          errorCode: 'DapAckFault',
          targetState: 'Halted',
          diagnostics: { slot: command.id, ack: 'FAULT' },
        };
      }),
    } as unknown as OzoneBackend;
    const session = new DapSession(backend);
    const messages: DebugProtocolMessage[] = [];
    session.on('send', message => messages.push(message));
    (session as any).breakpoints.set(`${sourcePath}:10`, 0);
    (session as any).breakpoints.set(`${sourcePath}:11`, 1);
    (session as any).breakpoints.set(`${sourcePath}:12`, 2);

    await (session as any).handleSetBreakpoints(setBreakpointsRequest(61, sourcePath, [20]));

    expect(backend.execute).toHaveBeenCalledTimes(2);
    expect(Array.from((session as any).breakpoints.entries())).toEqual([
      [`${sourcePath}:11`, 1],
      [`${sourcePath}:12`, 2],
    ]);
    expect(messages).toContainEqual(expect.objectContaining({
      success: false,
      message: expect.stringContaining('DapAckFault'),
      body: expect.objectContaining({
        errorCode: 'DapAckFault',
        message: 'slot 1 transport fault',
        diagnostics: { slot: 1, ack: 'FAULT' },
      }),
    }));
  });

  it('keeps successful new slots mapped and stops after a set failure', async () => {
    const sourcePath = 'D:/project/main.c';
    const backend = {
      execute: vi.fn(async (command: { cmd: string; id?: number; line?: number }) => {
        if (command.cmd === 'clearBreakpoint') return { ok: true, data: { id: command.id } };
        if (command.cmd === 'setBreakpoint' && command.line === 20) return { ok: true, data: { id: 4 } };
        if (command.cmd === 'setBreakpoint' && command.line === 21) {
          return {
            ok: false,
            error: 'no comparator remains',
            errorCode: 'BreakpointResourceExhausted',
            targetState: 'Halted',
            elapsedMs: 2,
          };
        }
        return { ok: false, error: `unexpected ${command.cmd}` };
      }),
    } as unknown as OzoneBackend;
    const session = new DapSession(backend);
    const messages: DebugProtocolMessage[] = [];
    session.on('send', message => messages.push(message));
    (session as any).breakpoints.set(`${sourcePath}:10`, 0);

    await (session as any).handleSetBreakpoints(setBreakpointsRequest(62, sourcePath, [20, 21, 22]));

    expect(backend.execute).toHaveBeenCalledTimes(3);
    expect(Array.from((session as any).breakpoints.entries())).toEqual([
      [`${sourcePath}:20`, 4],
    ]);
    expect(messages).toContainEqual(expect.objectContaining({
      success: false,
      message: expect.stringContaining('BreakpointResourceExhausted'),
      body: expect.objectContaining({
        errorCode: 'BreakpointResourceExhausted',
        message: 'no comparator remains',
        breakpoints: [
          expect.objectContaining({ verified: true, line: 20, id: 4 }),
          expect.objectContaining({
            verified: false,
            line: 21,
            errorCode: 'BreakpointResourceExhausted',
            message: 'no comparator remains',
          }),
          expect.objectContaining({ verified: false, line: 22, errorCode: 'NotAttempted' }),
        ],
      }),
    }));
  });

  it('turns a backend exception into a structured DAP failure without dropping mappings', async () => {
    const sourcePath = 'D:/project/main.c';
    const thrown = Object.assign(new Error('helper pipe closed during clear'), {
      errorCode: 'HelperExited',
      targetState: 'Error',
      diagnostics: { stage: 'clearBreakpoint' },
    });
    const backend = {
      execute: vi.fn(async () => { throw thrown; }),
    } as unknown as OzoneBackend;
    const session = new DapSession(backend);
    const messages: DebugProtocolMessage[] = [];
    session.on('send', message => messages.push(message));
    (session as any).breakpoints.set(`${sourcePath}:10`, 5);

    await (session as any).handleSetBreakpoints(setBreakpointsRequest(63, sourcePath, [20]));

    expect(Array.from((session as any).breakpoints.entries())).toEqual([
      [`${sourcePath}:10`, 5],
    ]);
    expect(messages).toContainEqual(expect.objectContaining({
      success: false,
      message: expect.stringContaining('HelperExited'),
      body: expect.objectContaining({
        errorCode: 'HelperExited',
        message: 'helper pipe closed during clear',
        targetState: 'Error',
        diagnostics: { stage: 'clearBreakpoint' },
      }),
    }));
  });

  it('replaces all source breakpoints successfully without leaving old slot mappings', async () => {
    const sourcePath = 'D:/project/main.c';
    const backend = {
      execute: vi.fn(async (command: { cmd: string; id?: number; line?: number }) => {
        if (command.cmd === 'clearBreakpoint') return { ok: true, data: { id: command.id } };
        if (command.cmd === 'setBreakpoint') return { ok: true, data: { id: command.line === 20 ? 4 : 5 } };
        return { ok: false, error: `unexpected ${command.cmd}` };
      }),
    } as unknown as OzoneBackend;
    const session = new DapSession(backend);
    const messages: DebugProtocolMessage[] = [];
    session.on('send', message => messages.push(message));
    (session as any).breakpoints.set(`${sourcePath}:10`, 0);
    (session as any).breakpoints.set(`${sourcePath}:11`, 1);

    await (session as any).handleSetBreakpoints(setBreakpointsRequest(64, sourcePath, [20, 21]));

    expect(Array.from((session as any).breakpoints.entries())).toEqual([
      [`${sourcePath}:20`, 4],
      [`${sourcePath}:21`, 5],
    ]);
    expect(messages).toContainEqual(expect.objectContaining({
      success: true,
      body: {
        breakpoints: [
          { verified: true, line: 20, id: 4 },
          { verified: true, line: 21, id: 5 },
        ],
      },
    }));
  });

  it('does not clear a hardware slot still referenced by another source', async () => {
    const sourcePath = 'D:/project/main.c';
    const otherSourcePath = 'D:/project/inlined.h';
    const backend = {
      execute: vi.fn(async (command: { cmd: string }) => command.cmd === 'setBreakpoint'
        ? { ok: true, data: { id: 4 } }
        : { ok: false, error: `unexpected ${command.cmd}` }),
    } as unknown as OzoneBackend;
    const session = new DapSession(backend);
    (session as any).breakpoints.set(`${sourcePath}:10`, 2);
    (session as any).breakpoints.set(`${otherSourcePath}:7`, 2);

    await (session as any).handleSetBreakpoints(setBreakpointsRequest(65, sourcePath, [20]));

    expect(backend.execute).toHaveBeenCalledTimes(1);
    expect(backend.execute).toHaveBeenCalledWith({
      cmd: 'setBreakpoint',
      file: sourcePath,
      line: 20,
    });
    expect(Array.from((session as any).breakpoints.entries())).toEqual([
      [`${otherSourcePath}:7`, 2],
      [`${sourcePath}:20`, 4],
    ]);
  });
});
