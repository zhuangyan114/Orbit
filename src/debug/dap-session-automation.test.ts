import { describe, expect, it, vi } from 'vitest';
import { DapSession, DebugProtocolMessage } from './dap-session';
import { OzoneBackend } from '../ozone-backend/commander';
import {
  parseAutomationControlRequest,
  standardCommandForAction,
  AUTOMATION_BREAKPOINTS_COMMAND,
  AUTOMATION_RUNTIME_COMMAND,
  parseAutomationRuntimeRequest,
} from './dap-automation-protocol';

function automationRequest(seq: number, args: Record<string, unknown>): DebugProtocolMessage {
  return { type: 'request', seq, command: 'orbitAutomationControl', arguments: args };
}

function collect(session: DapSession): DebugProtocolMessage[] {
  const messages: DebugProtocolMessage[] = [];
  session.on('send', message => messages.push(message));
  return messages;
}

function responseFor(messages: DebugProtocolMessage[], requestSeq: number): DebugProtocolMessage | undefined {
  return messages.find(message => message.type === 'response' && message.request_seq === requestSeq);
}

function eventsOf(messages: DebugProtocolMessage[], event: string): DebugProtocolMessage[] {
  return messages.filter(message => message.type === 'event' && message.event === event);
}

function connectedJlinkSession(backend: OzoneBackend): DapSession {
  const session = new DapSession(backend);
  (session as any).phase = 'connected';
  (session as any).targetConnectionEstablished = true;
  (session as any).rttLogEnabled = false;
  (session as any).rttAvailable = false;
  (session as any)._flashEnabled = false;
  (session as any)._runToEntryPoint = false;
  return session;
}

/** J-Link continue/pause/restart backend with a halted PC at 0x08000480. */
function jlinkControlBackend(overrides: Record<string, unknown> = {}): { execute: (command: any) => Promise<any> } {
  const calls: string[] = [];
  const backend = {
    calls,
    execute: async (command: { cmd: string } & Record<string, unknown>) => {
      calls.push(command.cmd);
      if (overrides[command.cmd]) return (overrides[command.cmd] as () => unknown)();
      if (command.cmd === 'readRegister') return { ok: true, data: { value: 0x08000480 } };
      if (command.cmd === 'getTargetState') return { ok: true, data: 'halted' };
      if (command.cmd === 'clearBreakpointAtAddr') return { ok: true, data: {} };
      if (command.cmd === 'stepIntoInstruction') return { ok: true, data: {} };
      if (command.cmd === 'setBreakpointAtAddr') return { ok: true, data: {} };
      if (command.cmd === 'run') return { ok: true, data: 'Running' };
      if (command.cmd === 'halt') return { ok: true, data: 'Halted' };
      if (command.cmd === 'reset') return { ok: true, data: 'Reset' };
      if (command.cmd === 'clearAllBreakpoints') return { ok: true, data: 'cleared' };
      if (command.cmd === 'getPerformanceDiagnostics') return { ok: true, data: { owner: 'legacyJLinkDLL' } };
      return { ok: true, data: {} };
    },
  };
  return backend;
}

describe('DapSession automation control framing', () => {
  it('rejects a control request without arguments as InvalidRequest', async () => {
    const session = connectedJlinkSession({} as OzoneBackend);
    const messages = collect(session);

    await (session as any).handleRequest(automationRequest(1, undefined as unknown as Record<string, unknown>));

    const response = responseFor(messages, 1);
    expect(response).toMatchObject({
      success: false,
      command: 'orbitAutomationControl',
      body: { state: 'unknown', errorCode: 'InvalidRequest' },
    });
    expect(response?.message).toContain('InvalidRequest:');
  });

  it('rejects an unknown action as InvalidRequest', async () => {
    const session = connectedJlinkSession({} as OzoneBackend);
    const messages = collect(session);

    await (session as any).handleRequest(automationRequest(1, { action: 'fly', sessionGeneration: 2 }));

    const response = responseFor(messages, 1);
    expect(response).toMatchObject({ success: false, body: { errorCode: 'InvalidRequest' } });
  });

  it('rejects control while the session has not connected as SessionStarting', async () => {
    const session = connectedJlinkSession({} as OzoneBackend);
    (session as any).phase = 'idle';
    const messages = collect(session);

    await (session as any).handleRequest(automationRequest(1, { action: 'continue', sessionGeneration: 2 }));

    const response = responseFor(messages, 1);
    expect(response).toMatchObject({ success: false, body: { errorCode: 'SessionStarting' } });
    expect(response?.message).toContain('SessionStarting:');
  });

  it('rejects instruction-granularity stepOut as CapabilityUnavailable', async () => {
    const session = connectedJlinkSession({} as OzoneBackend);
    const messages = collect(session);

    await (session as any).handleRequest(automationRequest(1, {
      action: 'stepOut', sessionGeneration: 2, threadId: 1, granularity: 'instruction',
    }));

    expect(responseFor(messages, 1)).toMatchObject({
      success: false,
      body: { errorCode: 'CapabilityUnavailable' },
    });
  });
});

describe('DapSession automation control core reuse', () => {
  it('continue runs through the same handleContinue core and reports running', async () => {
    const backend = jlinkControlBackend();
    const session = connectedJlinkSession(backend as unknown as OzoneBackend);
    const messages = collect(session);

    await (session as any).handleRequest(automationRequest(1, {
      action: 'continue', sessionGeneration: 2, threadId: 1, singleThread: true,
    }));
    (session as any).stopPolling();

    const response = responseFor(messages, 1);
    expect(response).toMatchObject({
      success: true,
      command: 'orbitAutomationControl',
      body: { state: 'running', diagnostics: { action: 'continue' } },
    });
    expect(response?.body?.stopReason).toBeUndefined();
    expect(response?.body?.pc).toBeUndefined();
    // UI sync: the standard continued event still fires.
    expect(eventsOf(messages, 'continued')).toHaveLength(1);
    // Sanitized custom event for the Extension Host.
    const automation = eventsOf(messages, 'orbitAutomationControl');
    expect(automation).toHaveLength(1);
    expect(automation[0].body).toMatchObject({
      action: 'continue', sessionGeneration: 2, ok: true, state: 'running',
    });
    // The standard DAP 'continue' response is never emitted for the synthetic request.
    expect(messages.some(message => message.type === 'response' && message.command === 'continue')).toBe(false);
    // Same backend core as a UI continue: PC clear-breakpoint step re-set run.
    expect((backend as any).calls).toEqual([
      'readRegister', 'clearBreakpointAtAddr', 'stepIntoInstruction', 'setBreakpointAtAddr', 'run',
    ]);
  });

  it('pause runs through handlePause, reports the halted PC and fires the stopped event', async () => {
    const backend = jlinkControlBackend();
    const session = connectedJlinkSession(backend as unknown as OzoneBackend);
    const messages = collect(session);

    await (session as any).handleRequest(automationRequest(1, { action: 'pause', sessionGeneration: 2, threadId: 1 }));

    expect(responseFor(messages, 1)).toMatchObject({
      success: true,
      body: { state: 'halted', stopReason: 'pause', pc: '0x8000480' },
    });
    expect(eventsOf(messages, 'stopped')[0]?.body).toMatchObject({ reason: 'pause', threadId: 1 });
    expect(eventsOf(messages, 'orbitAutomationControl')[0]?.body).toMatchObject({
      action: 'pause', ok: true, state: 'halted', stopReason: 'pause', pc: '0x8000480',
    });
    expect((backend as any).calls).toEqual(['halt', 'readRegister']);
  });

  it('restart runs through handleRestart and reports the entry halt', async () => {
    const backend = jlinkControlBackend();
    const session = connectedJlinkSession(backend as unknown as OzoneBackend);
    const messages = collect(session);

    await (session as any).handleRequest(automationRequest(1, { action: 'restart', sessionGeneration: 2 }));

    expect(responseFor(messages, 1)).toMatchObject({
      success: true,
      body: { state: 'halted', stopReason: 'entry', pc: '0x8000480' },
    });
    expect(eventsOf(messages, 'stopped')[0]?.body).toMatchObject({ reason: 'entry', threadId: 1 });
    expect((backend as any).calls).toEqual(['stopRtt', 'reset', 'halt', 'clearAllBreakpoints', 'readRegister']);
  });

  it('stepOver runs through handleStep and reports the step halt', async () => {
    const backend = jlinkControlBackend({
      stepOver: () => ({
        ok: true,
        data: {
          mode: 'native',
          pcBefore: 0x08000480,
          pcAfter: 0x08000482,
          classification: 'singleStep',
          helperElapsedMs: 1,
          timings: { totalMs: 1 },
        },
      }),
    });
    const session = connectedJlinkSession(backend as unknown as OzoneBackend);
    const messages = collect(session);

    await (session as any).handleRequest(automationRequest(1, {
      action: 'stepOver', sessionGeneration: 2, threadId: 1, granularity: 'source',
    }));

    expect(responseFor(messages, 1)).toMatchObject({
      success: true,
      body: { state: 'halted', stopReason: 'step', pc: '0x8000480' },
    });
    expect(eventsOf(messages, 'stopped')[0]?.body).toMatchObject({ reason: 'step', threadId: 1 });
    expect((backend as any).calls).toContain('stepOver');
  });

  it('stepInstruction maps to the instruction step core', async () => {
    const backend = jlinkControlBackend({
      stepIntoInstruction: () => ({ ok: true, data: { mode: 'legacy' } }),
    });
    const session = connectedJlinkSession(backend as unknown as OzoneBackend);
    const messages = collect(session);

    await (session as any).handleRequest(automationRequest(1, {
      action: 'stepInstruction', sessionGeneration: 2, threadId: 1,
    }));

    expect(responseFor(messages, 1)).toMatchObject({
      success: true,
      body: { state: 'halted', stopReason: 'step' },
    });
    expect((backend as any).calls).toContain('stepIntoInstruction');
  });

  it('reset halt resets, halts and reports the entry stop', async () => {
    const backend = jlinkControlBackend();
    const session = connectedJlinkSession(backend as unknown as OzoneBackend);
    const messages = collect(session);

    await (session as any).handleRequest(automationRequest(1, { action: 'reset', sessionGeneration: 2, mode: 'halt' }));

    expect(responseFor(messages, 1)).toMatchObject({
      success: true,
      body: { state: 'halted', stopReason: 'entry' },
    });
    expect(eventsOf(messages, 'stopped')[0]?.body).toMatchObject({ reason: 'entry', threadId: 1 });
    expect((backend as any).calls).toEqual(['reset', 'halt', 'readRegister']);
  });

  it('reset run resets, runs and reports running', async () => {
    const backend = jlinkControlBackend();
    const session = connectedJlinkSession(backend as unknown as OzoneBackend);
    const messages = collect(session);

    await (session as any).handleRequest(automationRequest(1, { action: 'reset', sessionGeneration: 2, mode: 'run' }));
    (session as any).stopPolling();

    expect(responseFor(messages, 1)).toMatchObject({ success: true, body: { state: 'running' } });
    expect(eventsOf(messages, 'continued')).toHaveLength(1);
    expect((backend as any).calls).toEqual(['reset', 'run']);
  });
});

describe('DapSession automation control failures', () => {
  it('a CMSIS-DAP continue failure carries the errorCode and target state', async () => {
    const backend = jlinkControlBackend({
      run: () => ({ ok: false, error: 'TargetControlFailed: run rejected' }),
    });
    const session = connectedJlinkSession(backend as unknown as OzoneBackend);
    (session as any)._probe = 'cmsis-dap';
    const messages = collect(session);

    await (session as any).handleRequest(automationRequest(1, { action: 'continue', sessionGeneration: 2 }));

    const response = responseFor(messages, 1);
    expect(response).toMatchObject({
      success: false,
      body: {
        state: 'unknown',
        errorCode: 'TargetControlFailed',
        message: 'TargetControlFailed: run rejected',
      },
    });
    expect(response?.message).toContain('TargetControlFailed');
    // The halted target is reflected to the UI exactly like the standard path.
    expect(eventsOf(messages, 'stopped')[0]?.body).toMatchObject({ reason: 'breakpoint', threadId: 1 });
    expect(eventsOf(messages, 'orbitAutomationControl')[0]?.body).toMatchObject({
      ok: false, errorCode: 'TargetControlFailed',
    });
  });

  it('a second control while one is in flight is rejected as TargetBusy', async () => {
    let releaseRun!: () => void;
    const runGate = new Promise<void>(resolve => { releaseRun = resolve; });
    const backend = jlinkControlBackend({
      run: async () => { await runGate; return { ok: true, data: 'Running' }; },
    });
    const session = connectedJlinkSession(backend as unknown as OzoneBackend);
    const messages = collect(session);

    const first = (session as any).handleRequest(automationRequest(1, { action: 'continue', sessionGeneration: 2 }));
    await Promise.resolve();
    await Promise.resolve();

    await (session as any).handleRequest(automationRequest(2, { action: 'pause', sessionGeneration: 2 }));
    expect(responseFor(messages, 2)).toMatchObject({
      success: false,
      body: { errorCode: 'TargetBusy' },
    });

    releaseRun();
    await first;
    (session as any).stopPolling();
    expect(responseFor(messages, 1)).toMatchObject({ success: true, body: { state: 'running' } });
  });
});

describe('DapSession automation flash', () => {
  it('flashes through the selected owner, reports the verified report and halts', async () => {
    const backend = jlinkControlBackend({
      getPerformanceDiagnostics: () => ({ ok: true, data: { owner: 'sessionTarget/cmsis-dap' } }),
      flash: () => ({
        ok: true,
        data: {
          success: true,
          message: 'CMSIS-DAP Flash successful: firmware.elf',
          elfPath: 'firmware.elf',
          reports: [{ operation: 'verify', address: 0x08000000, size: 4, elapsedMs: 1, ok: true }],
          erasedSectors: [{ number: 0, address: 0x08000000, size: 0x4000 }],
        },
      }),
    });
    const session = connectedJlinkSession(backend as unknown as OzoneBackend);
    (session as any)._probe = 'cmsis-dap';
    // rttLogEnabled + rttAvailable=false: the restore path is invoked (and
    // no-ops internally), letting us assert it without RTT poll timers.
    (session as any).rttLogEnabled = true;
    const startRttSpy = vi.spyOn(session as any, 'startRttLogPolling');
    const messages = collect(session);

    await (session as any).handleRequest(automationRequest(1, {
      action: 'flash',
      sessionGeneration: 2,
      elfPath: 'missing-elf-for-segment-parse.elf',
      verify: true,
      resetAfter: 'halt',
    }));

    const response = responseFor(messages, 1);
    expect(response).toMatchObject({
      success: true,
      body: {
        state: 'halted',
        stopReason: 'entry',
        flash: {
          elfPath: 'missing-elf-for-segment-parse.elf',
          owner: 'cmsis-dap',
          verified: true,
          bytesProgrammed: 0,
          segments: [],
          elapsedMs: expect.any(Number),
          diagnostics: {
            verifyRequested: true,
            elfSegmentParseError: expect.any(String),
          },
        },
      },
    });
    expect(eventsOf(messages, 'stopped')[0]?.body).toMatchObject({ reason: 'entry', threadId: 1 });
    expect(eventsOf(messages, 'orbitAutomationControl')[0]?.body?.flash).toMatchObject({
      owner: 'cmsis-dap', verified: true,
    });
    expect((backend as any).calls).toEqual([
      'stopRtt', 'halt', 'getTargetState', 'flash', 'getPerformanceDiagnostics',
      'reset', 'halt', 'getTargetState', 'readRegister',
    ]);
    // M1: RTT polling is paused before the flash and restored after it.
    expect(startRttSpy).toHaveBeenCalledWith({ retryInvalidControlBlock: true });
  });

  it('flash with resetAfter run leaves the target running', async () => {
    let stateCalls = 0;
    const backend = jlinkControlBackend({
      getPerformanceDiagnostics: () => ({ ok: true, data: { owner: 'sessionTarget/cmsis-dap' } }),
      flash: () => ({ ok: true, data: { success: true, message: 'flashed', elfPath: 'f.elf' } }),
      getTargetState: () => {
        stateCalls += 1;
        // First confirm is the pre-flash halt; later confirms report running.
        return { ok: true, data: stateCalls === 1 ? 'halted' : 'running' };
      },
    });
    const session = connectedJlinkSession(backend as unknown as OzoneBackend);
    (session as any)._probe = 'cmsis-dap';
    const messages = collect(session);

    await (session as any).handleRequest(automationRequest(1, {
      action: 'flash',
      sessionGeneration: 2,
      elfPath: 'missing.elf',
      resetAfter: 'run',
    }));
    (session as any).stopPolling();

    const response = responseFor(messages, 1);
    expect(response).toMatchObject({
      success: true,
      body: { state: 'running', flash: { verified: false, bytesProgrammed: 0 } },
    });
    expect(eventsOf(messages, 'continued')).toHaveLength(1);
  });

  it('a flash failure carries the owner error code', async () => {
    const backend = jlinkControlBackend({
      flash: () => ({ ok: false, errorCode: 'FlashFailed', error: 'sector erase rejected' }),
    });
    const session = connectedJlinkSession(backend as unknown as OzoneBackend);
    (session as any)._probe = 'cmsis-dap';
    const messages = collect(session);

    await (session as any).handleRequest(automationRequest(1, {
      action: 'flash', sessionGeneration: 2, elfPath: 'missing.elf',
    }));

    expect(responseFor(messages, 1)).toMatchObject({
      success: false,
      body: { errorCode: 'FlashFailed', message: 'sector erase rejected', targetState: 'halted' },
    });
    // M2: the failed flash re-syncs the UI to the recovered halted state.
    expect(eventsOf(messages, 'stopped')[0]?.body).toMatchObject({ reason: 'pause', threadId: 1 });
  });

  it('a flash failure reconciles a running target without a spurious stopped event', async () => {
    let stateCalls = 0;
    const backend = jlinkControlBackend({
      flash: () => ({ ok: false, errorCode: 'FlashFailed', error: 'sector erase rejected' }),
      getTargetState: () => {
        stateCalls += 1;
        // First call is the pre-flash halt confirm; the recovery reads running.
        return { ok: true, data: stateCalls === 1 ? 'halted' : 'running' };
      },
    });
    const session = connectedJlinkSession(backend as unknown as OzoneBackend);
    (session as any)._probe = 'cmsis-dap';
    const messages = collect(session);

    await (session as any).handleRequest(automationRequest(1, {
      action: 'flash', sessionGeneration: 2, elfPath: 'missing.elf',
    }));
    (session as any).stopPolling();

    expect(responseFor(messages, 1)).toMatchObject({
      success: false,
      body: { errorCode: 'FlashFailed', targetState: 'running' },
    });
    expect(eventsOf(messages, 'stopped')).toHaveLength(0);
    expect(eventsOf(messages, 'continued')).toHaveLength(0);
  });
});

describe('automation request validation', () => {
  it('accepts the frozen param shapes', () => {
    expect(parseAutomationControlRequest({ action: 'continue', sessionGeneration: 1, threadId: 2, singleThread: true }))
      .toMatchObject({ ok: true, request: { action: 'continue', sessionGeneration: 1, threadId: 2, singleThread: true } });
    expect(parseAutomationControlRequest({ action: 'pause', sessionGeneration: 1 }))
      .toMatchObject({ ok: true, request: { action: 'pause' } });
    expect(parseAutomationControlRequest({ action: 'reset', sessionGeneration: 1, mode: 'run' }))
      .toMatchObject({ ok: true, request: { action: 'reset', mode: 'run' } });
    expect(parseAutomationControlRequest({ action: 'flash', sessionGeneration: 1, elfPath: 'f.elf', resetAfter: 'none' }))
      .toMatchObject({ ok: true, request: { action: 'flash', resetAfter: 'none', verify: true } });
  });

  it('rejects invalid frozen param shapes with InvalidRequest', () => {
    expect(parseAutomationControlRequest({ action: 'continue', sessionGeneration: 0 })).toMatchObject({ ok: false });
    expect(parseAutomationControlRequest({ action: 'continue', sessionGeneration: -1 })).toMatchObject({ ok: false });
    expect(parseAutomationControlRequest({ action: 'stepOver', sessionGeneration: 1 }))
      .toMatchObject({ ok: false, message: expect.stringContaining('threadId') });
    expect(parseAutomationControlRequest({ action: 'stepInstruction', sessionGeneration: 1, threadId: 1, granularity: 'source' }))
      .toMatchObject({ ok: false });
    expect(parseAutomationControlRequest({ action: 'reset', sessionGeneration: 1, mode: 'sleep' })).toMatchObject({ ok: false });
    expect(parseAutomationControlRequest({ action: 'flash', sessionGeneration: 1 })).toMatchObject({ ok: false });
  });

  it('maps DAP failure messages onto the frozen error codes (L2)', () => {
    const session = connectedJlinkSession({} as OzoneBackend);
    const normalize = (body: Record<string, unknown>, message: string) =>
      (session as any).normalizeAutomationErrorCode(body, message);
    // Step-lock "Target busy" is the frozen TargetBusy, not InternalError.
    expect(normalize({}, 'Target busy')).toBe('TargetBusy');
    // A structured body code always wins.
    expect(normalize({ errorCode: 'TargetControlFailed' }, 'anything')).toBe('TargetControlFailed');
    // A leading Code: prefix is preserved.
    expect(normalize({}, 'TargetStateInvalid: pause returned running')).toBe('TargetStateInvalid');
    // Unknown failures fall back to InternalError.
    expect(normalize({}, 'something broke')).toBe('InternalError');
  });

  it('maps actions to the standard DAP commands', () => {
    expect(standardCommandForAction({ action: 'continue', sessionGeneration: 1 }))
      .toEqual({ command: 'continue' });
    expect(standardCommandForAction({ action: 'pause', sessionGeneration: 1 }))
      .toEqual({ command: 'pause' });
    expect(standardCommandForAction({ action: 'restart', sessionGeneration: 1 }))
      .toEqual({ command: 'restart' });
    expect(standardCommandForAction({ action: 'stepOver', sessionGeneration: 1, threadId: 1, granularity: 'source' }))
      .toEqual({ command: 'next' });
    expect(standardCommandForAction({ action: 'stepOver', sessionGeneration: 1, threadId: 1, granularity: 'instruction' }))
      .toEqual({ command: 'next', arguments: { granularity: 'instruction' } });
    expect(standardCommandForAction({ action: 'stepInstruction', sessionGeneration: 1, threadId: 1 }))
      .toEqual({ command: 'stepIn', arguments: { granularity: 'instruction' } });
    expect(standardCommandForAction({ action: 'stepOut', sessionGeneration: 1, threadId: 1, granularity: 'source' }))
      .toEqual({ command: 'stepOut' });
    expect(standardCommandForAction({ action: 'stepOut', sessionGeneration: 1, threadId: 1, granularity: 'instruction' }))
      .toBeNull();
    expect(standardCommandForAction({ action: 'reset', sessionGeneration: 1 })).toBeNull();
    expect(standardCommandForAction({ action: 'flash', sessionGeneration: 1, elfPath: 'f.elf' })).toBeNull();
  });
});

describe('DapSession automation breakpoints snapshot', () => {
  it('reports the verified hardware breakpoint map by normalized source location', async () => {
    const session = connectedJlinkSession({} as OzoneBackend);
    (session as any).breakpoints = new Map([
      ['c:\\ws\\main.c:10', 2],
      ['c:\\ws\\main.c:12', 5],
    ]);
    const messages = collect(session);

    await (session as any).handleRequest({
      type: 'request',
      seq: 1,
      command: AUTOMATION_BREAKPOINTS_COMMAND,
      arguments: {},
    });

    const response = responseFor(messages, 1);
    expect(response).toMatchObject({ success: true, command: AUTOMATION_BREAKPOINTS_COMMAND });
    expect(response?.body?.breakpoints).toEqual(expect.arrayContaining([
      { path: 'c:\\ws\\main.c', line: 10, verified: true, slot: 2 },
      { path: 'c:\\ws\\main.c', line: 12, verified: true, slot: 5 },
    ]));
  });

  it('returns an empty snapshot when no breakpoints are tracked', async () => {
    const session = connectedJlinkSession({} as OzoneBackend);
    const messages = collect(session);

    await (session as any).handleRequest({
      type: 'request',
      seq: 1,
      command: AUTOMATION_BREAKPOINTS_COMMAND,
      arguments: {},
    });

    expect(responseFor(messages, 1)?.body?.breakpoints).toEqual([]);
  });
});

function runtimeRequest(seq: number, args: Record<string, unknown>): DebugProtocolMessage {
  return { type: 'request', seq, command: AUTOMATION_RUNTIME_COMMAND, arguments: args };
}

/** Read-only backend for runtime snapshots: call stack, locals and registers. */
function runtimeBackend(overrides: Record<string, unknown> = {}): { execute: (command: any) => Promise<any>; calls: string[] } {
  const calls: string[] = [];
  const backend = {
    calls,
    execute: async (command: { cmd: string } & Record<string, unknown>) => {
      calls.push(command.cmd);
      if (overrides[command.cmd]) return (overrides[command.cmd] as () => unknown)();
      if (command.cmd === 'getCallStack') {
        return {
          ok: true,
          data: [{ id: 1, function: 'StartTask02', file: 'c:\\ws\\freertos.c', line: 402, address: 0x08004E2E }],
        };
      }
      if (command.cmd === 'getLocals') {
        return { ok: true, data: [{ name: 'aww', value: '0.5', type: 'float' }] };
      }
      if (command.cmd === 'getRegisters') {
        return {
          ok: true,
          data: [
            { name: 'PC', value: 0x08000480, hex: '0x08000480' },
            { name: 'R0', value: 1, hex: '0x00000001' },
          ],
        };
      }
      return { ok: true, data: {} };
    },
  };
  return backend;
}

describe('DapSession automation runtime snapshot', () => {
  it('threads reuses the standard handler and reports the halted thread', async () => {
    const session = connectedJlinkSession(runtimeBackend() as unknown as OzoneBackend);
    const messages = collect(session);

    await (session as any).handleRequest(runtimeRequest(1, { kind: 'threads', sessionGeneration: 2 }));

    expect(responseFor(messages, 1)).toMatchObject({
      success: true,
      command: AUTOMATION_RUNTIME_COMMAND,
      body: {
        threads: [{ threadId: 1, name: expect.any(String), state: 'halted', stopped: true }],
        targetState: 'Halted',
      },
    });
  });

  it('stackTrace reuses handleStackTrace and reports frames with addresses', async () => {
    const backend = runtimeBackend();
    const session = connectedJlinkSession(backend as unknown as OzoneBackend);
    const messages = collect(session);

    await (session as any).handleRequest(runtimeRequest(1, { kind: 'stackTrace', sessionGeneration: 2, threadId: 1 }));

    expect(responseFor(messages, 1)).toMatchObject({
      success: true,
      body: {
        stackFrames: [{
          frameId: 1,
          name: 'StartTask02',
          source: { path: 'c:\\ws\\freertos.c', line: 402 },
          instructionPointerReference: '0x8004E2E',
        }],
      },
    });
    expect((backend as any).calls).toContain('getCallStack');
  });

  it('scopes reuses the standard handler (Local + Registers)', async () => {
    const session = connectedJlinkSession(runtimeBackend() as unknown as OzoneBackend);
    const messages = collect(session);

    await (session as any).handleRequest(runtimeRequest(1, { kind: 'scopes', sessionGeneration: 2, frameId: 1 }));

    expect(responseFor(messages, 1)?.body).toMatchObject({
      scopes: [
        { name: 'Local', variablesReference: 1, expensive: false },
        { name: 'Registers', variablesReference: 2, expensive: false },
      ],
    });
  });

  it('variables reference 1 reuses handleVariables and returns locals', async () => {
    const backend = runtimeBackend();
    const session = connectedJlinkSession(backend as unknown as OzoneBackend);
    const messages = collect(session);

    await (session as any).handleRequest(runtimeRequest(1, { kind: 'variables', sessionGeneration: 2, variablesReference: 1 }));

    expect(responseFor(messages, 1)?.body).toMatchObject({
      variables: [{ name: 'aww', value: '0.5', type: 'float', variablesReference: 0 }],
    });
    expect((backend as any).calls).toContain('getLocals');
  });

  it('variables reference 2 reuses handleVariables and returns registers as variables', async () => {
    const session = connectedJlinkSession(runtimeBackend() as unknown as OzoneBackend);
    const messages = collect(session);

    await (session as any).handleRequest(runtimeRequest(1, { kind: 'variables', sessionGeneration: 2, variablesReference: 2 }));

    expect(responseFor(messages, 1)?.body?.variables).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'PC', value: '0x08000480', type: 'uint32', variablesReference: 0 }),
    ]));
  });

  it('registers runs a dedicated core and reports group/bits/value/memoryReference', async () => {
    const backend = runtimeBackend();
    const session = connectedJlinkSession(backend as unknown as OzoneBackend);
    const messages = collect(session);

    await (session as any).handleRequest(runtimeRequest(1, { kind: 'registers', sessionGeneration: 2 }));

    expect(responseFor(messages, 1)?.body).toMatchObject({
      registers: [
        { name: 'PC', value: '0x08000480', group: 'core', bits: 32, memoryReference: '0x8000480' },
        { name: 'R0', value: '0x00000001', group: 'core', bits: 32, memoryReference: '0x1' },
      ],
    });
    expect((backend as any).calls).toContain('getRegisters');
  });

  it('reports TargetRunning instead of fabricating stopped-state data', async () => {
    const session = connectedJlinkSession(runtimeBackend() as unknown as OzoneBackend);
    (session as any).targetRunning = true;
    const messages = collect(session);

    await (session as any).handleRequest(runtimeRequest(1, { kind: 'stackTrace', sessionGeneration: 2, threadId: 1 }));

    expect(responseFor(messages, 1)).toMatchObject({
      success: false,
      body: { errorCode: 'TargetRunning', targetState: 'Running' },
    });
  });

  it('rejects a runtime request while not connected as SessionStarting', async () => {
    const session = connectedJlinkSession(runtimeBackend() as unknown as OzoneBackend);
    (session as any).phase = 'idle';
    const messages = collect(session);

    await (session as any).handleRequest(runtimeRequest(1, { kind: 'threads', sessionGeneration: 2 }));

    expect(responseFor(messages, 1)).toMatchObject({ success: false, body: { errorCode: 'SessionStarting' } });
  });
});

describe('automation runtime request validation', () => {
  it('accepts the frozen runtime request shapes', () => {
    expect(parseAutomationRuntimeRequest({ kind: 'threads', sessionGeneration: 1 }))
      .toMatchObject({ ok: true, request: { kind: 'threads' } });
    expect(parseAutomationRuntimeRequest({ kind: 'stackTrace', sessionGeneration: 1, threadId: 2, startFrame: 1, levels: 5 }))
      .toMatchObject({ ok: true, request: { kind: 'stackTrace', threadId: 2, startFrame: 1, levels: 5 } });
    expect(parseAutomationRuntimeRequest({ kind: 'scopes', sessionGeneration: 1, frameId: 3 }))
      .toMatchObject({ ok: true, request: { kind: 'scopes', frameId: 3 } });
    expect(parseAutomationRuntimeRequest({ kind: 'variables', sessionGeneration: 1, variablesReference: 2 }))
      .toMatchObject({ ok: true, request: { kind: 'variables', variablesReference: 2 } });
    expect(parseAutomationRuntimeRequest({ kind: 'variables', sessionGeneration: 1, variablesReference: 0 }))
      .toMatchObject({ ok: true, request: { kind: 'variables', variablesReference: 0 } });
    expect(parseAutomationRuntimeRequest({ kind: 'registers', sessionGeneration: 1, groups: ['core'] }))
      .toMatchObject({ ok: true, request: { kind: 'registers', groups: ['core'] } });
  });

  it('rejects invalid frozen runtime request shapes with InvalidRequest', () => {
    expect(parseAutomationRuntimeRequest({ kind: 'moon', sessionGeneration: 1 })).toMatchObject({ ok: false });
    expect(parseAutomationRuntimeRequest({ kind: 'threads', sessionGeneration: 0 })).toMatchObject({ ok: false });
    expect(parseAutomationRuntimeRequest({ kind: 'stackTrace', sessionGeneration: 1 }))
      .toMatchObject({ ok: false, message: expect.stringContaining('threadId') });
    expect(parseAutomationRuntimeRequest({ kind: 'scopes', sessionGeneration: 1 }))
      .toMatchObject({ ok: false, message: expect.stringContaining('frameId') });
    expect(parseAutomationRuntimeRequest({ kind: 'variables', sessionGeneration: 1 }))
      .toMatchObject({ ok: false, message: expect.stringContaining('variablesReference') });
    expect(parseAutomationRuntimeRequest({ kind: 'registers', sessionGeneration: 1, groups: ['fpu'] }))
      .toMatchObject({ ok: false });
  });
});
