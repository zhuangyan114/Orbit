import { afterEach, describe, expect, it, vi } from 'vitest';
import { DapSession, DebugProtocolMessage } from './dap-session';
import { OzoneBackend } from '../ozone-backend/commander';
import { log } from '../utils/logger';

describe('DapSession native executor lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('selects the target owner through the backend connect only once', async () => {
    vi.useFakeTimers();
    const backend = {
      execute: vi.fn(async () => ({ ok: true, data: {} })),
      configureNativeSteps: vi.fn(),
      dispose: vi.fn(),
    } as unknown as OzoneBackend;
    const session = new DapSession(backend);
    const launch = (session as any).handleLaunch({
      type: 'request', seq: 1, command: 'launch',
      arguments: {
        device: 'STM32F407VG',
        interface: 'SWD',
        speedKHz: 4000,
        flashBeforeDebug: false,
        rttLogEnabled: false,
        nativeDebugEngineMode: 'native',
        nativeDebugEngineEnabled: true,
      },
    });
    await vi.advanceTimersByTimeAsync(250);
    await launch;

    const connectCalls = vi.mocked(backend.execute).mock.calls
      .map(call => call[0])
      .filter(command => command.cmd === 'connect');
    expect(connectCalls).toHaveLength(1);
    expect(connectCalls[0]).toMatchObject({
      config: {
        nativeDebugEngineMode: 'native',
        nativeDebugEngineEnabled: true,
      },
    });

    await (session as any).handleDisconnect({ type: 'request', seq: 2, command: 'disconnect' });
    expect(backend.configureNativeSteps).toHaveBeenLastCalledWith(false);
  });

  it('routes default CMSIS-DAP flashing through the CMSIS-DAP owner command', async () => {
    const backend = {
      execute: vi.fn(async () => ({ ok: true, data: {} })),
      configureNativeSteps: vi.fn(),
    } as unknown as OzoneBackend;
    const session = new DapSession(backend);
    const messages: DebugProtocolMessage[] = [];
    session.on('send', message => messages.push(message));

    await (session as any).handleLaunch({
      type: 'request', seq: 2, command: 'launch',
      arguments: {
        probe: 'cmsis-dap',
        program: 'firmware.elf',
        flashBeforeDebug: true,
        rttLogEnabled: false,
      },
    });

    expect(backend.execute).toHaveBeenCalledWith(expect.objectContaining({
      cmd: 'connect',
      config: expect.objectContaining({ probe: 'cmsis-dap' }),
    }));
    expect(backend.execute).toHaveBeenCalledWith(expect.objectContaining({
      cmd: 'flash',
      probe: 'cmsis-dap',
      flashBeforeDebug: true,
    }));
    expect(backend.execute).not.toHaveBeenCalledWith(expect.objectContaining({
      cmd: 'flash',
      probe: 'jlink',
    }));
  });

  it('forwards explicit CMSIS-DAP flash skip and selectors to the connect command', async () => {
    const backend = {
      execute: vi.fn(async (command: { cmd: string }) => command.cmd === 'connect'
        ? { ok: false, error: 'UnsupportedCapability: CMSIS-DAP helper is not implemented', errorCode: 'UnsupportedCapability' }
        : { ok: true, data: {} }),
      configureNativeSteps: vi.fn(),
    } as unknown as OzoneBackend;
    const session = new DapSession(backend);

    await (session as any).handleLaunch({
      type: 'request', seq: 3, command: 'launch',
      arguments: {
        probe: 'cmsis-dap',
        cmsisDapTransport: 'hid',
        cmsisDapSerial: 'CMSIS-123',
        cmsisDapVid: 'C251',
        cmsisDapPid: 'F001',
        flashBeforeDebug: false,
        rttLogEnabled: false,
      },
    });

    expect(backend.execute).toHaveBeenCalledWith(expect.objectContaining({
      cmd: 'connect',
      config: expect.objectContaining({
        probe: 'cmsis-dap',
        cmsisDapTransport: 'hid',
        cmsisDapSerial: 'CMSIS-123',
        cmsisDapVid: 'C251',
        cmsisDapPid: 'F001',
        flashBeforeDebug: false,
      }),
    }));
    expect(backend.execute).not.toHaveBeenCalledWith(expect.objectContaining({ cmd: 'flash' }));
  });

  it('sends the step response before the stopped event once native reports halted', async () => {
    const backend = {
      execute: vi.fn(async (command: { cmd: string }) => {
        return command.cmd === 'stepInto'
          ? { ok: true, data: { mode: 'native', pcBefore: 0x08000100, pcAfter: 0x08000102 } }
          : { ok: false, error: `unexpected command ${command.cmd}` };
      }),
    } as unknown as OzoneBackend;
    const session = new DapSession(backend);
    const messages: Array<{ type: string; command?: string; event?: string; success?: boolean }> = [];
    session.on('send', message => messages.push(message));

    await (session as any).handleStep({
      type: 'request', seq: 7, command: 'stepIn', arguments: {},
    }, 'stepInto');

    const responseIndex = messages.findIndex(message => message.type === 'response' && message.command === 'stepIn');
    const stoppedIndex = messages.findIndex(message => message.type === 'event' && message.event === 'stopped');
    expect(responseIndex).toBeGreaterThanOrEqual(0);
    expect(stoppedIndex).toBeGreaterThan(responseIndex);
    expect(messages[responseIndex].success).toBe(true);
    expect(backend.execute).toHaveBeenCalledTimes(1);
    expect(backend.execute).not.toHaveBeenCalledWith({ cmd: 'getTargetState' });
    expect(backend.execute).not.toHaveBeenCalledWith({ cmd: 'readRegister', name: 'PC' });
  });

  it('profiles native step latency segments and applies the single-step and step-out budgets', async () => {
    const dapLog = vi.spyOn(log, 'dap').mockImplementation(() => {});
    let stepOverCalls = 0;
    const backend = {
      execute: vi.fn(async (command: { cmd: string }) => {
        if (command.cmd === 'stepOver') {
          stepOverCalls++;
          return {
            ok: true,
            data: {
              mode: 'native', classification: stepOverCalls === 1 ? 'singleStep' : 'branchSingleStep', helperElapsedMs: 12,
              timings: { totalMs: 10 }, pcBefore: 0x08000100, pcAfter: 0x08000102,
            },
          };
        }
        if (command.cmd === 'stepOut') {
          return {
            ok: true,
            data: {
              mode: 'native', classification: 'returnBreakpoint', helperElapsedMs: 24,
              timings: { totalMs: 22 }, pcBefore: 0x08000102, pcAfter: 0x08000120,
            },
          };
        }
        return { ok: false, error: `unexpected command ${command.cmd}` };
      }),
    } as unknown as OzoneBackend;
    const session = new DapSession(backend);

    await (session as any).handleStep({ type: 'request', seq: 9, command: 'next', arguments: {} }, 'stepOver');
    await (session as any).handleStep({ type: 'request', seq: 10, command: 'next', arguments: {} }, 'stepOver');
    await (session as any).handleStep({ type: 'request', seq: 11, command: 'stepOut', arguments: {} }, 'stepOut');

    const nativeProfiles = dapLog.mock.calls.map(([message]) => message).filter(message => message.includes(' native '));
    expect(nativeProfiles).toHaveLength(3);
    expect(nativeProfiles[0]).toContain('lockWait=');
    expect(nativeProfiles[0]).toContain('controlDrain=');
    expect(nativeProfiles[0]).toContain('pollingStop=');
    expect(nativeProfiles[0]).toContain('helper=12ms');
    expect(nativeProfiles[0]).toContain('nativeStateMachine=10ms');
    expect(nativeProfiles[0]).toContain('transportAndBackend=');
    expect(nativeProfiles[0]).toContain('responseToStopped=');
    expect(nativeProfiles[0]).toContain('budget=50ms budgetStatus=within classification=singleStep');
    expect(nativeProfiles[1]).toContain('budget=50ms budgetStatus=within classification=branchSingleStep');
    expect(nativeProfiles[2]).toContain('budget=100ms budgetStatus=within classification=returnBreakpoint');
  });

  it('keeps conservative target-state polling for legacy step results', async () => {
    vi.useFakeTimers();
    let stateReads = 0;
    const backend = {
      execute: vi.fn(async (command: { cmd: string }) => {
        if (command.cmd === 'stepOver') return { ok: true, data: 'Stepped' };
        if (command.cmd === 'getTargetState') {
          stateReads++;
          return { ok: true, data: stateReads > 1 ? 'halted' : 'running' };
        }
        return { ok: false, error: `unexpected command ${command.cmd}` };
      }),
    } as unknown as OzoneBackend;
    const session = new DapSession(backend);
    const messages: Array<{ type: string; command?: string; event?: string }> = [];
    session.on('send', message => messages.push(message));

    const step = (session as any).handleStep({
      type: 'request', seq: 8, command: 'next', arguments: {},
    }, 'stepOver');
    await vi.runAllTimersAsync();
    await step;

    expect(stateReads).toBe(2);
    const responseIndex = messages.findIndex(message => message.type === 'response' && message.command === 'next');
    const stoppedIndex = messages.findIndex(message => message.type === 'event' && message.event === 'stopped');
    expect(stoppedIndex).toBeGreaterThan(responseIndex);
  });
});
