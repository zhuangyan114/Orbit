import { describe, expect, it, vi } from 'vitest';
import { DapSession, DebugProtocolMessage } from './dap-session';
import { OzoneBackend } from '../ozone-backend/commander';

describe('DAP stopped-state scopes', () => {
  it('queues concurrent Local and Registers reads across the stopped-event control handoff', async () => {
    const calls: string[] = [];
    const backend = {
      execute: vi.fn(async (command: { cmd: string }) => {
        calls.push(`${command.cmd}:start`);
        await new Promise<void>(resolve => setTimeout(resolve, 20));
        calls.push(`${command.cmd}:end`);
        if (command.cmd === 'getLocals') {
          return { ok: true, data: [{ name: 'local', type: 'int', value: '1' }] };
        }
        if (command.cmd === 'getRegisters') {
          return { ok: true, data: [{ name: 'PC', value: 0x08000100, hex: '0x08000100' }] };
        }
        return { ok: false, error: `unexpected ${command.cmd}` };
      }),
    } as unknown as OzoneBackend;
    const session = new DapSession(backend);
    const messages: DebugProtocolMessage[] = [];
    session.on('send', message => messages.push(message));

    (session as any).controlInProgress = true;
    const localRead = (session as any).handleVariables({
      type: 'request', seq: 11, command: 'variables', arguments: { variablesReference: 1 },
    });
    const registerRead = (session as any).handleVariables({
      type: 'request', seq: 12, command: 'variables', arguments: { variablesReference: 2 },
    });
    setTimeout(() => { (session as any).endControl(); }, 10);
    await Promise.all([localRead, registerRead]);

    expect(messages.find(message => message.request_seq === 11)?.body.variables).toMatchObject([
      { name: 'local', value: '1' },
    ]);
    expect(messages.find(message => message.request_seq === 12)?.body.variables).toMatchObject([
      { name: 'PC', value: '0x08000100' },
    ]);
    expect(calls).toEqual([
      'getLocals:start', 'getLocals:end', 'getRegisters:start', 'getRegisters:end',
    ]);
  });
});
