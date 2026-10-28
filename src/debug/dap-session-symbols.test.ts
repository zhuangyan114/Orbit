import { describe, expect, it, vi } from 'vitest';
import { DapSession } from './dap-session';

describe('DAP symbol catalog', () => {
  it('returns metadata while running without control operations or state queries', async () => {
    const result = { ok: true, data: { roots: [], types: {} } };
    const backend = { execute: vi.fn(async () => result) };
    const session = new DapSession(backend as any);
    (session as any).targetRunning = true;
    const messages: any[] = []; session.on('send', message => messages.push(message));
    await session.handleMessage({ seq: 1, type: 'request', command: 'getSymbolCatalog' });
    expect(messages.at(-1)).toMatchObject({ request_seq: 1, success: true, body: result });
    expect(backend.execute).toHaveBeenCalledOnce();
    expect(backend.execute).toHaveBeenCalledWith({ cmd: 'getSymbolCatalog' });
    expect((session as any).targetRunning).toBe(true);
  });
  it('never calls the backend after termination', async () => {
    const backend = { execute: vi.fn() }; const session = new DapSession(backend as any);
    (session as any).phase = 'terminated';
    await session.handleMessage({ seq: 1, type: 'request', command: 'getSymbolCatalog' });
    expect(backend.execute).not.toHaveBeenCalled();
  });
});
