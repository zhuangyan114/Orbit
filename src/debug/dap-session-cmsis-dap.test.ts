import { describe, expect, it, vi } from 'vitest';
import { DapSession, DebugProtocolMessage } from './dap-session';
import { OzoneBackend } from '../ozone-backend/commander';
import { log } from '../utils/logger';

function request(seq: number, command: string): DebugProtocolMessage {
  return { type: 'request', seq, command, arguments: {} };
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

  it('does not issue flash or flash-specific reset when flashBeforeDebug is false', async () => {
    const calls: string[] = [];
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
    expect(calls).not.toContain('flash');
    expect(calls).not.toContain('reset');
  });

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
    expect(stopped).toMatchObject({ body: { reason: 'step', threadId: 1 } });
    expect(messages.indexOf(stopped!)).toBeGreaterThan(messages.indexOf(response!));
  });

  it('emits continued only after CMSIS-DAP confirms Running, never through J-Link', async () => {
    const backend = {
      execute: async (command: { cmd: string }) => {
        if (command.cmd === 'readRegister') return { ok: true, data: { value: 0x080001C0 } };
        if (command.cmd === 'clearBreakpointAtAddr') return { ok: false, error: 'UnsupportedCapability' };
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

  it('responds to restart before publishing exactly one stopped event without flashing', async () => {
    const calls: string[] = [];
    const backend = {
      execute: async (command: { cmd: string }) => {
        calls.push(command.cmd);
        if (command.cmd === 'reset') return { ok: true, data: { state: 'Running' } };
        if (command.cmd === 'halt') return { ok: true, data: { state: 'Halted' } };
        return { ok: false, error: `unexpected ${command.cmd}` };
      },
    } as unknown as OzoneBackend;
    const session = new DapSession(backend);
    (session as any)._probe = 'cmsis-dap';
    (session as any)._flashEnabled = false;
    (session as any).targetConnectionEstablished = true;
    (session as any).phase = 'connected';
    const messages: DebugProtocolMessage[] = [];
    session.on('send', message => messages.push(message));

    await (session as any).handleRestart(request(4, 'restart'));

    const response = messages.find(message => message.type === 'response');
    const stopped = messages.filter(message => message.type === 'event' && message.event === 'stopped');
    expect(calls.filter(command => command === 'flash' || command === 'reset' || command === 'halt'))
      .toEqual(['reset', 'halt']);
    expect(response).toMatchObject({ success: true, command: 'restart' });
    expect(stopped).toHaveLength(1);
    expect(stopped[0]).toMatchObject({ body: { reason: 'entry', threadId: 1 } });
    expect(messages.indexOf(stopped[0])).toBeGreaterThan(messages.indexOf(response!));
  });

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
});
