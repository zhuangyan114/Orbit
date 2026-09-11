import { describe, expect, it, vi } from 'vitest';
import { DapSession } from './dap-session';
import { log } from '../utils/logger';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(next => { resolve = next; });
  return { promise, resolve };
}

describe('DapSession RTT polling lifecycle', () => {
  function launchRequest(overrides: Record<string, unknown> = {}) {
    return {
      type: 'request',
      seq: 1,
      command: 'launch',
      arguments: {
        probe: 'cmsis-dap',
        program: 'firmware.elf',
        flashBeforeDebug: false,
        rttLogEnabled: true,
        ...overrides,
      },
    };
  }

  function launchBackend(symbolResult: any) {
    const backend = {
      execute: vi.fn(async (command: any) => {
        if (command.cmd === 'connect') return { ok: true, data: { state: 'Connected' } };
        if (command.cmd === 'loadSymbols') return { ok: true, data: 'symbols loaded' };
        if (command.cmd === 'resolveSymbol') return symbolResult;
        if (command.cmd === 'halt') return { ok: true, data: { state: 'Halted' } };
        if (command.cmd === 'getTargetState') return { ok: true, data: 'halted' };
        if (command.cmd === 'startRtt') return { ok: true, data: {} };
        if (command.cmd === 'readRtt') return { ok: true, data: { bytes: [] } };
        if (command.cmd === 'stopRtt') return { ok: true, data: {} };
        if (command.cmd === 'disconnect') return { ok: true, data: {} };
        return { ok: true, data: {} };
      }),
      configureNativeSteps: vi.fn(),
      dispose: vi.fn(),
    };
    return backend;
  }

  it('passes an explicit RTT control block address without resolving the ELF symbol', async () => {
    const backend = launchBackend({ ok: true, data: { address: 0x20000200, size: 0xa8, type: 'B' } });
    const session = new DapSession(backend as any);
    try {
      await (session as any).handleLaunch(launchRequest({ rttControlBlockAddress: '0x20000100' }));
      (session as any).stopRttLogPolling();
      (session as any).startRttLogPolling();
      await new Promise(resolve => setTimeout(resolve, 70));
      expect(backend.execute).not.toHaveBeenCalledWith(expect.objectContaining({ cmd: 'resolveSymbol' }));
      expect(backend.execute).toHaveBeenCalledWith(expect.objectContaining({
        cmd: 'startRtt',
        controlBlockAddress: 0x20000100,
      }));
    } finally {
      (session as any).stopConnectionMonitor();
      (session as any).stopRttLogPolling();
    }
  });

  it('resolves the RTT control block from the loaded ELF when no address is configured', async () => {
    const backend = launchBackend({ ok: true, data: { address: 0x20005178, size: 0xa8, type: 'B' } });
    const session = new DapSession(backend as any);
    try {
      await (session as any).handleLaunch(launchRequest());
      (session as any).stopRttLogPolling();
      (session as any).startRttLogPolling();
      await new Promise(resolve => setTimeout(resolve, 70));
      expect(backend.execute).toHaveBeenCalledWith(expect.objectContaining({
        cmd: 'resolveSymbol',
        name: '_SEGGER_RTT',
      }));
      expect(backend.execute).toHaveBeenCalledWith(expect.objectContaining({
        cmd: 'startRtt',
        controlBlockAddress: 0x20005178,
      }));
    } finally {
      (session as any).stopConnectionMonitor();
      (session as any).stopRttLogPolling();
    }
  });

  it('resolves the RTT control block for a native J-Link launch when no address is configured', async () => {
    const backend = launchBackend({ ok: true, data: { address: 0x20005178, size: 0xa8, type: 'B' } });
    const session = new DapSession(backend as any);
    try {
      await (session as any).handleLaunch(launchRequest({ probe: 'jlink' }));
      (session as any).stopRttLogPolling();
      (session as any).startRttLogPolling();
      await new Promise(resolve => setTimeout(resolve, 70));
      expect(backend.execute).toHaveBeenCalledWith(expect.objectContaining({
        cmd: 'resolveSymbol',
        name: '_SEGGER_RTT',
      }));
      expect(backend.execute).toHaveBeenCalledWith(expect.objectContaining({
        cmd: 'startRtt',
        controlBlockAddress: 0x20005178,
      }));
    } finally {
      (session as any).stopConnectionMonitor();
      (session as any).stopRttLogPolling();
    }
  });

  it('resolves the RTT control block on demand for an automation start when RTT Log is disabled', async () => {
    const backend = launchBackend({ ok: true, data: { address: 0x20005178, size: 0xa8, type: 'B' } });
    const session = new DapSession(backend as any);
    const messages: any[] = [];
    session.on('send', message => messages.push(message));
    try {
      await (session as any).handleLaunch(launchRequest({ rttLogEnabled: false }));
      // The launch skips RTT resolution when the log is disabled, leaving the
      // automation start to resolve it so `startRtt` never gets undefined.
      expect((session as any).rttControlBlockAddress).toBeUndefined();
      expect((session as any).rttAvailable).toBe(true);

      await (session as any).handleAutomationRtt({
        type: 'request', seq: 2, command: 'orbitRttSnapshot',
        arguments: { kind: 'start', sessionGeneration: 1 },
      });

      expect(backend.execute).toHaveBeenCalledWith(expect.objectContaining({
        cmd: 'resolveSymbol', name: '_SEGGER_RTT',
      }));
      expect(backend.execute).toHaveBeenCalledWith(expect.objectContaining({
        cmd: 'startRtt', controlBlockAddress: 0x20005178,
      }));
      const response = messages.find(m => m.type === 'response' && m.command === 'orbitRttSnapshot');
      expect(response?.success).toBe(true);
      expect(response?.body?.snapshot?.state).toBe('running');
    } finally {
      (session as any).stopConnectionMonitor();
      (session as any).stopRttLogPolling();
    }
  });

  it('returns CapabilityUnavailable when the automation start cannot resolve the RTT control block', async () => {
    const backend = launchBackend({
      ok: false, errorCode: 'SymbolNotFound', error: 'SymbolNotFound: _SEGGER_RTT',
    });
    const session = new DapSession(backend as any);
    const messages: any[] = [];
    session.on('send', message => messages.push(message));
    try {
      await (session as any).handleLaunch(launchRequest({ rttLogEnabled: false }));
      await (session as any).handleAutomationRtt({
        type: 'request', seq: 2, command: 'orbitRttSnapshot',
        arguments: { kind: 'start', sessionGeneration: 1 },
      });
      expect(backend.execute).toHaveBeenCalledWith(expect.objectContaining({
        cmd: 'resolveSymbol', name: '_SEGGER_RTT',
      }));
      expect(backend.execute).not.toHaveBeenCalledWith(expect.objectContaining({ cmd: 'startRtt' }));
      const response = messages.find(m => m.type === 'response' && m.command === 'orbitRttSnapshot');
      expect(response?.success).toBe(false);
      expect(response?.body?.errorCode).toBe('CapabilityUnavailable');
    } finally {
      (session as any).stopConnectionMonitor();
      (session as any).stopRttLogPolling();
    }
  });

  it('continues launch without RTT when the ELF has no RTT control block symbol', async () => {
    const backend = launchBackend({
      ok: false,
      errorCode: 'SymbolNotFound',
      error: 'SymbolNotFound: _SEGGER_RTT',
    });
    const session = new DapSession(backend as any);
    const messages: any[] = [];
    const dapLog = vi.spyOn(log, 'dap').mockImplementation(() => {});
    session.on('send', message => messages.push(message));
    try {
      await (session as any).handleLaunch(launchRequest());
      expect(messages).toContainEqual(expect.objectContaining({
        type: 'response',
        command: 'launch',
        success: true,
      }));
      expect(messages).toContainEqual(expect.objectContaining({ event: 'initialized' }));
      expect((session as any).phase).toBe('connected');
      expect((session as any).rttAvailable).toBe(false);
      expect((session as any).rttPollTimer).toBeNull();
      expect((session as any).connectionMonitorTimer).not.toBeNull();
      expect(backend.execute).not.toHaveBeenCalledWith(expect.objectContaining({ cmd: 'startRtt' }));
      expect(backend.execute).not.toHaveBeenCalledWith(expect.objectContaining({ cmd: 'readRtt' }));
      expect(dapLog).toHaveBeenCalledWith(expect.stringContaining('errorCode=RttControlBlockUnavailable'));
      expect(dapLog).toHaveBeenCalledWith(expect.stringContaining('source=elf-symbol'));
      expect(dapLog).toHaveBeenCalledWith(expect.stringContaining('debugContinues=true'));

      await (session as any).handleConfigurationDone({
        type: 'request', seq: 2, command: 'configurationDone', arguments: {},
      });
      expect(messages).toContainEqual(expect.objectContaining({
        event: 'stopped',
        body: expect.objectContaining({ reason: 'entry' }),
      }));
    } finally {
      (session as any).stopConnectionMonitor();
      (session as any).stopRttLogPolling();
      dapLog.mockRestore();
    }
  });

  it.each([
    {
      name: 'there is no ELF and no configured RTT address',
      overrides: { program: '' },
      symbolResult: { ok: false, errorCode: 'SymbolNotFound', error: 'SymbolNotFound: _SEGGER_RTT' },
    },
    {
      name: 'the ELF RTT symbol address is invalid',
      overrides: {},
      symbolResult: { ok: true, data: { address: 0, size: 0xa8, type: 'B' } },
    },
  ])('continues launch without RTT when $name', async ({ overrides, symbolResult }) => {
    const backend = launchBackend(symbolResult);
    const session = new DapSession(backend as any);
    const messages: any[] = [];
    session.on('send', message => messages.push(message));
    try {
      await (session as any).handleLaunch(launchRequest(overrides));
      expect(messages).toContainEqual(expect.objectContaining({
        type: 'response', command: 'launch', success: true,
      }));
      expect(messages).toContainEqual(expect.objectContaining({ event: 'initialized' }));
      expect((session as any).rttAvailable).toBe(false);
      expect((session as any).rttPollTimer).toBeNull();
      expect(backend.execute).not.toHaveBeenCalledWith(expect.objectContaining({ cmd: 'startRtt' }));
      expect(backend.execute).not.toHaveBeenCalledWith(expect.objectContaining({ cmd: 'readRtt' }));
    } finally {
      (session as any).stopConnectionMonitor();
      (session as any).stopRttLogPolling(false);
    }
  });

  it('cleans up a connected owner once when launch fails after connection', async () => {
    const backend = launchBackend({ ok: true, data: { address: 0x20000100 } });
    backend.execute.mockImplementation(async (command: any) => {
      if (command.cmd === 'connect') return { ok: true, data: { state: 'Connected' } };
      if (command.cmd === 'loadSymbols') return { ok: true, data: 'symbols loaded' };
      if (command.cmd === 'halt') {
        return { ok: false, errorCode: 'DapControlTimeout', error: 'halt timed out' };
      }
      if (command.cmd === 'stopRtt') return { ok: true, data: {} };
      return { ok: true, data: {} };
    });
    const session = new DapSession(backend as any);
    const messages: any[] = [];
    session.on('send', message => messages.push(message));

    await (session as any).handleLaunch(launchRequest({
      rttLogEnabled: false,
      runToEntryPoint: false,
    }));

    expect(messages).toContainEqual(expect.objectContaining({
      type: 'response', command: 'launch', success: false,
    }));
    expect(backend.dispose).toHaveBeenCalledTimes(1);
    expect(backend.dispose).toHaveBeenCalledWith(false);
    expect((session as any).targetConnectionEstablished).toBe(false);
    expect((session as any).connectionMonitorTimer).toBeNull();
    expect((session as any).rttPollTimer).toBeNull();

    await (session as any).handleDisconnect({
      type: 'request', seq: 2, command: 'disconnect', arguments: {},
    });
    expect(backend.execute).not.toHaveBeenCalledWith({ cmd: 'disconnect' });
    await session.dispose();
    expect(backend.dispose).toHaveBeenCalledTimes(1);
  });

  it('terminates the session when launch detects that the connected owner was lost', async () => {
    const backend = launchBackend({ ok: true, data: { address: 0x20000100 } });
    backend.execute.mockImplementation(async (command: any) => {
      if (command.cmd === 'connect') return { ok: true, data: { state: 'Connected' } };
      if (command.cmd === 'loadSymbols') return { ok: true, data: 'symbols loaded' };
      if (command.cmd === 'halt') {
        return { ok: false, errorCode: 'NativeOwnerLost', error: 'helper exited during halt' };
      }
      if (command.cmd === 'stopRtt') return { ok: true, data: {} };
      return { ok: true, data: {} };
    });
    const session = new DapSession(backend as any);
    const messages: any[] = [];
    session.on('send', message => messages.push(message));

    await (session as any).handleLaunch(launchRequest({
      rttLogEnabled: false,
      runToEntryPoint: false,
    }));

    expect(messages).toContainEqual(expect.objectContaining({
      type: 'response', command: 'launch', success: false,
      body: expect.objectContaining({ errorCode: 'NativeOwnerLost' }),
    }));
    expect(messages.filter(message => message.event === 'terminated')).toHaveLength(1);
    expect(backend.dispose).toHaveBeenCalledTimes(1);
    expect(backend.dispose).toHaveBeenCalledWith(false);
    expect((session as any).phase).toBe('terminated');
    expect((session as any).targetConnectionEstablished).toBe(false);
    expect((session as any).connectionMonitorTimer).toBeNull();
    expect((session as any).rttPollTimer).toBeNull();

    await session.dispose();
    expect(backend.dispose).toHaveBeenCalledTimes(1);
  });

  it('disables only RTT when the connected owner reports an invalid RTT layout', async () => {
    vi.useFakeTimers();
    const dapLog = vi.spyOn(log, 'dap').mockImplementation(() => {});
    const backend = launchBackend({ ok: true, data: { address: 0x20000100 } });
    backend.execute.mockImplementation(async (command: any) => {
      if (command.cmd === 'startRtt') {
        return {
          ok: false,
          errorCode: 'RttInvalidBufferFlags',
          error: 'RTT Up Buffer Flags are invalid',
          diagnostics: { flags: 4, mode: 0, bufferIndex: 0 },
        };
      }
      if (command.cmd === 'stopRtt') return { ok: true, data: {} };
      return { ok: true, data: {} };
    });
    const session = new DapSession(backend as any);
    (session as any).phase = 'connected';
    (session as any).targetConnectionEstablished = true;
    (session as any).rttPollIntervalMs = 10;
    (session as any).rttControlBlockAddress = 0x20000100;
    (session as any).rttControlBlockSource = 'config';

    try {
      (session as any).startRttLogPolling();
      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(0);

      expect((session as any).rttAvailable).toBe(false);
      expect((session as any).phase).toBe('connected');
      expect((session as any).rttPollTimer).toBeNull();
      expect(backend.dispose).not.toHaveBeenCalled();
      expect(dapLog).toHaveBeenCalledWith(expect.stringContaining('errorCode=RttInvalidBufferFlags'));
      expect(dapLog).toHaveBeenCalledWith(expect.stringContaining('source=config'));
      expect(dapLog).toHaveBeenCalledWith(expect.stringContaining('debugContinues=true'));
    } finally {
      (session as any).stopRttLogPolling();
      dapLog.mockRestore();
      vi.useRealTimers();
    }
  });

  it('retries a missing RTT control block magic after launch until firmware initializes it', async () => {
    vi.useFakeTimers();
    let startAttempts = 0;
    const backend = launchBackend({ ok: true, data: { address: 0x2000408c, size: 0xa8, type: 'B' } });
    backend.execute.mockImplementation(async (command: any) => {
      if (command.cmd === 'connect') return { ok: true, data: { state: 'Connected' } };
      if (command.cmd === 'loadSymbols') return { ok: true, data: 'symbols loaded' };
      if (command.cmd === 'resolveSymbol') {
        return { ok: true, data: { address: 0x2000408c, size: 0xa8, type: 'B' } };
      }
      if (command.cmd === 'halt') return { ok: true, data: { state: 'Halted' } };
      if (command.cmd === 'getTargetState') return { ok: true, data: 'halted' };
      if (command.cmd === 'startRtt') {
        startAttempts++;
        if (startAttempts < 3) {
          return {
            ok: false,
            errorCode: 'RttInvalidControlBlock',
            error: 'RTT Control Block magic is not SEGGER RTT',
          };
        }
        return { ok: true, data: {} };
      }
      if (command.cmd === 'readRtt') return { ok: true, data: { bytes: [0x41] } };
      if (command.cmd === 'stopRtt') return { ok: true, data: {} };
      return { ok: true, data: {} };
    });
    const session = new DapSession(backend as any);
    const dapLog = vi.spyOn(log, 'dap').mockImplementation(() => {});
    try {
      const launchPromise = (session as any).handleLaunch(launchRequest({
        rttPollIntervalMs: 10,
        runToEntryPoint: false,
      }));
      await vi.advanceTimersByTimeAsync(200);
      await launchPromise;

      expect((session as any).rttAvailable).toBe(true);
      expect((session as any).rttPollTimer).not.toBeNull();
      expect((session as any).rttControlBlockAddress).toBe(0x2000408c);

      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(0);
      expect(startAttempts).toBe(1);
      expect((session as any).rttStarted).toBe(false);
      expect((session as any).rttAvailable).toBe(true);
      expect(dapLog).toHaveBeenCalledWith(expect.stringContaining('action=retry'));
      expect(dapLog).not.toHaveBeenCalledWith(expect.stringContaining('action=disabled'));

      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(0);
      expect(startAttempts).toBe(2);
      expect((session as any).rttStarted).toBe(false);

      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(0);
      expect(startAttempts).toBe(3);
      expect((session as any).rttStarted).toBe(true);
      expect(backend.execute).toHaveBeenCalledWith(expect.objectContaining({ cmd: 'readRtt' }));
      expect(backend.dispose).not.toHaveBeenCalled();
    } finally {
      (session as any).stopConnectionMonitor();
      (session as any).stopRttLogPolling();
      dapLog.mockRestore();
      vi.useRealTimers();
    }
  });

  it('retries a transient invalid RTT control block after restart at the configured interval', async () => {
    vi.useFakeTimers();
    let startAttempts = 0;
    const backend = launchBackend({ ok: true, data: { address: 0x20000100 } });
    backend.execute.mockImplementation(async (command: any) => {
      if (command.cmd === 'runToEntryPoint') {
        return { ok: true, data: { state: 'Halted' } };
      }
      if (command.cmd === 'run') return { ok: true, data: { state: 'Running' } };
      if (command.cmd === 'getTargetState') return { ok: true, data: 'running' };
      if (command.cmd === 'startRtt') {
        startAttempts++;
        if (startAttempts === 1) {
          return {
            ok: false,
            errorCode: 'RttInvalidControlBlock',
            error: 'RTT Control Block magic is not SEGGER RTT',
          };
        }
        return { ok: true, data: {} };
      }
      if (command.cmd === 'readRtt') return { ok: true, data: { bytes: [] } };
      if (command.cmd === 'stopRtt') return { ok: true, data: {} };
      return { ok: true, data: {} };
    });
    const session = new DapSession(backend as any);
    (session as any).phase = 'connected';
    (session as any).targetConnectionEstablished = true;
    (session as any)._probe = 'cmsis-dap';
    (session as any)._runToEntryPoint = 'main';
    (session as any).rttLogEnabled = true;
    (session as any).rttAvailable = true;
    (session as any).rttPollIntervalMs = 10;
    (session as any).rttControlBlockAddress = 0x20000100;

    try {
      await (session as any).handleRestart({
        type: 'request', seq: 2, command: 'restart', arguments: {},
      });
      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(0);

      expect(startAttempts).toBe(1);
      expect((session as any).rttAvailable).toBe(true);
      expect((session as any).rttPollTimer).not.toBeNull();

      await (session as any).handleContinue({
        type: 'request', seq: 3, command: 'continue', arguments: { threadId: 1 },
      });
      await vi.advanceTimersByTimeAsync(9);
      expect(startAttempts).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(0);

      expect(startAttempts).toBe(2);
      expect((session as any).rttStarted).toBe(true);
      expect(backend.execute).toHaveBeenCalledWith(expect.objectContaining({ cmd: 'readRtt' }));
      expect(backend.dispose).not.toHaveBeenCalled();
    } finally {
      (session as any).stopRttLogPolling();
      vi.useRealTimers();
    }
  });

  it.each(['DeviceRemoved', 'HelperExited', 'NativeOwnerLost', 'RttOwnerLost'])(
    'terminates and disposes the owner when RTT reports %s',
    async errorCode => {
      vi.useFakeTimers();
      const backend = launchBackend({ ok: true, data: { address: 0x20000100 } });
      backend.execute.mockImplementation(async (command: any) => {
        if (command.cmd === 'startRtt') {
          return { ok: false, errorCode, error: `${errorCode}: RTT owner failed` };
        }
        if (command.cmd === 'stopRtt') return { ok: true, data: {} };
        return { ok: true, data: {} };
      });
      const session = new DapSession(backend as any);
      const messages: any[] = [];
      session.on('send', message => messages.push(message));
      (session as any).phase = 'connected';
      (session as any).targetConnectionEstablished = true;
      (session as any).rttPollIntervalMs = 10;
      (session as any).rttControlBlockAddress = 0x20000100;

      try {
        (session as any).startConnectionMonitor();
        (session as any).startRttLogPolling();
        await vi.advanceTimersByTimeAsync(10);
        await vi.advanceTimersByTimeAsync(0);
        await (session as any).terminationPromise;

        expect(backend.dispose).toHaveBeenCalledTimes(1);
        expect(backend.dispose).toHaveBeenCalledWith(false);
        expect((session as any).phase).toBe('terminated');
        expect((session as any).targetConnectionEstablished).toBe(false);
        expect((session as any).connectionMonitorTimer).toBeNull();
        expect((session as any).rttPollTimer).toBeNull();
        expect(backend.execute.mock.calls.filter(([command]) => command.cmd === 'connect')).toHaveLength(0);
        expect(messages.filter(message => message.event === 'terminated')).toHaveLength(1);

        await (session as any).terminateForConnectionLoss(errorCode);
        await session.dispose();
        expect(backend.dispose).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('keeps repeated start and stop calls on separate polling generations', async () => {
    vi.useFakeTimers();
    const backend = {
      execute: vi.fn(async (command: any) => {
        if (command.cmd === 'startRtt') return { ok: true, data: {} };
        if (command.cmd === 'readRtt') return { ok: true, data: { bytes: [] } };
        if (command.cmd === 'stopRtt') return { ok: true, data: {} };
        return { ok: true, data: {} };
      }),
    };
    const session = new DapSession(backend as any);
    (session as any).rttPollIntervalMs = 10;
    (session as any).rttControlBlockAddress = 0x20000100;

    try {
      (session as any).startRttLogPolling();
      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(0);
      (session as any).stopRttLogPolling();

      (session as any).startRttLogPolling();
      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(0);
      const reads = backend.execute.mock.calls.filter(([command]) => command.cmd === 'readRtt');
      expect(reads).toHaveLength(2);

      (session as any).stopRttLogPolling();
      await vi.advanceTimersByTimeAsync(100);
      expect(backend.execute.mock.calls.filter(([command]) => command.cmd === 'readRtt')).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not publish output for an empty RTT read', async () => {
    vi.useFakeTimers();
    const events: any[] = [];
    const backend = {
      execute: vi.fn(async (command: any) => {
        if (command.cmd === 'startRtt') return { ok: true, data: {} };
        if (command.cmd === 'readRtt') return { ok: true, data: { bytes: [] } };
        if (command.cmd === 'stopRtt') return { ok: true, data: {} };
        return { ok: true, data: {} };
      }),
    };
    const session = new DapSession(backend as any);
    session.on('send', message => events.push(message));
    (session as any).rttPollIntervalMs = 10;
    (session as any).rttControlBlockAddress = 0x20000100;

    try {
      (session as any).startRttLogPolling();
      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(0);
      expect(backend.execute).toHaveBeenCalledWith(expect.objectContaining({ cmd: 'readRtt' }));
      expect(events.filter(event => event.event === 'ozoneRttOutput')).toHaveLength(0);
    } finally {
      (session as any).stopRttLogPolling();
      vi.useRealTimers();
    }
  });

  it('publishes RTT output when the owner returns Uint8Array bytes', async () => {
    vi.useFakeTimers();
    const events: any[] = [];
    const backend = {
      execute: vi.fn(async (command: any) => {
        if (command.cmd === 'startRtt') return { ok: true, data: {} };
        if (command.cmd === 'readRtt') {
          return { ok: true, data: { bytes: new Uint8Array(Buffer.from('hello\n')) } };
        }
        if (command.cmd === 'stopRtt') return { ok: true, data: {} };
        return { ok: true, data: {} };
      }),
    };
    const session = new DapSession(backend as any);
    session.on('send', message => events.push(message));
    (session as any).rttPollIntervalMs = 10;
    (session as any).rttControlBlockAddress = 0x20000100;
    (session as any).pRtLogEnabled = false;

    try {
      (session as any).startRttLogPolling();
      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(0);
      expect(events).toContainEqual(expect.objectContaining({
        event: 'ozoneRttOutput',
        body: { text: 'hello\n' },
      }));
    } finally {
      (session as any).stopRttLogPolling();
      vi.useRealTimers();
    }
  });

  it('logs structured RTT failures with their error code and diagnostics', async () => {
    vi.useFakeTimers();
    const dapLog = vi.spyOn(log, 'dap').mockImplementation(() => {});
    const backend = {
      execute: vi.fn(async (command: any) => {
        if (command.cmd === 'startRtt') return { ok: true, data: {} };
        if (command.cmd === 'readRtt') {
          return {
            ok: false,
            errorCode: 'RttBufferOverrun',
            error: 'RTT writer advanced over unread data',
            diagnostics: { bufferIndex: 0, wrapped: true, overrun: true },
          };
        }
        if (command.cmd === 'stopRtt') return { ok: true, data: {} };
        return { ok: true, data: {} };
      }),
    };
    const session = new DapSession(backend as any);
    (session as any).rttPollIntervalMs = 10;
    (session as any).rttControlBlockAddress = 0x20000100;

    try {
      (session as any).startRttLogPolling();
      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(0);
      expect(dapLog).toHaveBeenCalledWith(expect.stringContaining('RttBufferOverrun'));
      expect(dapLog).toHaveBeenCalledWith(expect.stringContaining('"overrun":true'));
    } finally {
      (session as any).stopRttLogPolling();
      dapLog.mockRestore();
      vi.useRealTimers();
    }
  });

  it('keeps RTT polling active across Timeline start and stop', async () => {
    vi.useFakeTimers();
    const backend = {
      execute: vi.fn(async (command: any) => {
        if (command.cmd === 'startRtt') return { ok: true, data: {} };
        if (command.cmd === 'readRtt') return { ok: true, data: { bytes: [] } };
        if (command.cmd === 'stopRtt') return { ok: true, data: {} };
        if (command.cmd === 'prepareFastDataSampling') {
          return {
            ok: true,
            data: [{
              expression: 'counter',
              spec: {
                expression: 'counter',
                address: 0x20000100,
                size: 4,
                typeName: 'uint32_t',
                isFloat: false,
                signed: false,
              },
            }],
          };
        }
        if (command.cmd === 'getPerformanceDiagnostics') return { ok: true, data: {} };
        return { ok: true, data: {} };
      }),
    };
    const session = new DapSession(backend as any);
    (session as any).phase = 'connected';
    (session as any).rttLogEnabled = true;
    (session as any).rttPollIntervalMs = 10;
    (session as any).rttControlBlockAddress = 0x20000100;

    try {
      (session as any).startRttLogPolling();
      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(0);
      expect(backend.execute.mock.calls.filter(([command]) => command.cmd === 'readRtt')).toHaveLength(1);
      backend.execute.mockClear();

      await (session as any).handleDataSamplingStart({
        type: 'request',
        seq: 2,
        command: 'dataSamplingStart',
        arguments: {
          entries: [{ expression: 'counter', color: '#4EC9B0' }],
          sampleIntervalMs: 0.2,
          sendIntervalMs: 16,
        },
      });
      expect(backend.execute.mock.calls.filter(([command]) => command.cmd === 'stopRtt')).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(0);
      expect(backend.execute.mock.calls.filter(([command]) => command.cmd === 'readRtt')).toHaveLength(1);

      await (session as any).handleDataSamplingStop({
        type: 'request',
        seq: 3,
        command: 'dataSamplingStop',
        arguments: {},
      });
      expect(backend.execute.mock.calls.filter(([command]) => command.cmd === 'startRtt')).toHaveLength(0);
      expect(backend.execute.mock.calls.filter(([command]) => command.cmd === 'stopRtt')).toHaveLength(0);
    } finally {
      (session as any).stopDataSampling();
      (session as any).stopRttLogPolling();
      vi.useRealTimers();
    }
  });

  it('waits for the configured interval after an RTT read completes', async () => {
    vi.useFakeTimers();
    const firstRead = deferred<any>();
    let readCount = 0;
    const backend = {
      execute: vi.fn(async (command: any) => {
        if (command.cmd === 'startRtt') return { ok: true, data: {} };
        if (command.cmd === 'readRtt') {
          readCount++;
          return readCount === 1
            ? firstRead.promise
            : { ok: true, data: { bytes: [] } };
        }
        if (command.cmd === 'stopRtt') return { ok: true, data: {} };
        return { ok: true, data: {} };
      }),
    };
    const session = new DapSession(backend as any);
    (session as any).rttPollIntervalMs = 10;
    (session as any).rttControlBlockAddress = 0x20000100;

    try {
      (session as any).startRttLogPolling();
      vi.advanceTimersByTime(10);
      await Promise.resolve();
      await Promise.resolve();
      expect(readCount).toBe(1);

      vi.advanceTimersByTime(100);
      await Promise.resolve();
      expect(readCount).toBe(1);

      firstRead.resolve({ ok: true, data: { bytes: [] } });
      await Promise.resolve();
      await Promise.resolve();
      vi.advanceTimersByTime(9);
      await Promise.resolve();
      expect(readCount).toBe(1);

      vi.advanceTimersByTime(1);
      await Promise.resolve();
      await Promise.resolve();
      expect(readCount).toBe(2);
    } finally {
      (session as any).stopRttLogPolling();
      vi.useRealTimers();
    }
  });

  it('aborts an in-flight RTT read and drops its stale completion after stop', async () => {
    vi.useFakeTimers();
    const read = deferred<any>();
    let readSignal: AbortSignal | undefined;
    const events: any[] = [];
    const backend = {
      execute: vi.fn(async (command: any) => {
        if (command.cmd === 'startRtt') return { ok: true, data: {} };
        if (command.cmd === 'readRtt') {
          readSignal = command.signal;
          return read.promise;
        }
        if (command.cmd === 'stopRtt') return { ok: true, data: {} };
        return { ok: true, data: {} };
      }),
    };
    const session = new DapSession(backend as any);
    session.on('send', message => events.push(message));
    (session as any).rttPollIntervalMs = 10;
    (session as any).rttControlBlockAddress = 0x20000100;

    try {
      (session as any).startRttLogPolling();
      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(0);
      expect(readSignal).toBeDefined();
      (session as any).stopRttLogPolling();
      expect(readSignal!.aborted).toBe(true);
      read.resolve({ ok: true, data: { bytes: Array.from(Buffer.from('stale\\n')) } });
      await vi.advanceTimersByTimeAsync(0);
      expect(events.filter(event => event.event === 'ozoneRttOutput')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
