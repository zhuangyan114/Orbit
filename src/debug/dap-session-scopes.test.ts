import { describe, expect, it, vi } from 'vitest';
import { DapSession, DebugProtocolMessage } from './dap-session';
import { OzoneBackend } from '../ozone-backend/commander';

describe('DAP frame-bound scopes', () => {
  it('routes Local and Registers through the selected frameId and preserves children', async () => {
    const backend = {
      execute: vi.fn(async (command: { cmd: string; frame?: number }) => {
        if (command.cmd === 'getLocals') {
          return {
            ok: true,
            data: [{
              name: 'sample', type: 'Sample', value: '{...}', address: 0x20001000,
              children: [{ name: 'field', type: 'uint32_t', value: '7', address: 0x20001000 }],
            }],
          };
        }
        if (command.cmd === 'getRegisters') {
          return { ok: true, data: [{ name: 'SP', value: 0x20002000, hex: '0x20002000' }] };
        }
        return { ok: false, error: `unexpected ${command.cmd}` };
      }),
    } as unknown as OzoneBackend;
    const session = new DapSession(backend);
    const messages: DebugProtocolMessage[] = [];
    session.on('send', message => messages.push(message));

    (session as any).handleScopes({
      type: 'request', seq: 1, command: 'scopes', arguments: { frameId: 7 },
    });
    const scopesResponse = messages.find(message => message.type === 'response' && message.command === 'scopes');
    const scopes = scopesResponse?.body.scopes as Array<{ name: string; variablesReference: number }>;
    const localRef = scopes.find(scope => scope.name === 'Local')!.variablesReference;
    const registerRef = scopes.find(scope => scope.name === 'Registers')!.variablesReference;
    expect(localRef).not.toBe(registerRef);

    await (session as any).handleVariables({
      type: 'request', seq: 2, command: 'variables', arguments: { variablesReference: localRef },
    });
    expect(backend.execute).toHaveBeenCalledWith({ cmd: 'getLocals', frame: 7 });
    const localResponse = messages.find(message => message.type === 'response' && message.command === 'variables' && message.request_seq === 2);
    const local = localResponse?.body.variables[0];
    expect(local).toMatchObject({ name: 'sample', value: '{...}', type: 'Sample' });
    expect(local.variablesReference).toBeGreaterThan(0);

    await (session as any).handleVariables({
      type: 'request', seq: 3, command: 'variables', arguments: { variablesReference: local.variablesReference },
    });
    const childResponse = messages.find(message => message.type === 'response' && message.command === 'variables' && message.request_seq === 3);
    expect(childResponse?.body.variables).toMatchObject([{ name: 'field', value: '7' }]);

    await (session as any).handleVariables({
      type: 'request', seq: 4, command: 'variables', arguments: { variablesReference: registerRef },
    });
    expect(backend.execute).toHaveBeenCalledWith({ cmd: 'getRegisters', frame: 7 });
  });

  it('queues concurrent Local and Registers reads across the stopped-event control handoff', async () => {
    const calls: string[] = [];
    const backend = {
      execute: vi.fn(async (command: { cmd: string; frame?: number }) => {
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

    (session as any).handleScopes({
      type: 'request', seq: 10, command: 'scopes', arguments: { frameId: 3 },
    });
    const scopes = messages.find(message => message.request_seq === 10)?.body.scopes as Array<{
      name: string;
      variablesReference: number;
    }>;
    const localRef = scopes.find(scope => scope.name === 'Local')!.variablesReference;
    const registerRef = scopes.find(scope => scope.name === 'Registers')!.variablesReference;

    (session as any).controlInProgress = true;
    const localRead = (session as any).handleVariables({
      type: 'request', seq: 11, command: 'variables', arguments: { variablesReference: localRef },
    });
    const registerRead = (session as any).handleVariables({
      type: 'request', seq: 12, command: 'variables', arguments: { variablesReference: registerRef },
    });
    setTimeout(() => { (session as any).controlInProgress = false; }, 10);
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
