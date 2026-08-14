// MemoryService (plan Task 9): byte-oriented read/write through the exact
// session, 32-bit address + count/base64 validation, verify mapping, and the
// frozen error-code fence.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionRef } from './protocol';
import { SessionRegistry } from './session-registry';
import { MemoryService } from './memory-service';
import { AutomationMemoryRequest, AutomationMemoryResult } from '../debug/dap-automation-protocol';

vi.mock('vscode', () => ({}));

interface TestContext {
  service: MemoryService;
  registry: SessionRegistry;
  session: { id: string; type: string; name: string };
  ref: SessionRef;
  calls: AutomationMemoryRequest[];
  setSnapshot: (handler: (request: AutomationMemoryRequest) => AutomationMemoryResult) => void;
}

function makeService(): TestContext {
  const registry = new SessionRegistry();
  const session = { id: 'sess-1', type: 'orbit', name: 'test' };
  const calls: AutomationMemoryRequest[] = [];
  let handler: (request: AutomationMemoryRequest) => AutomationMemoryResult = () => ({});
  const service = new MemoryService({
    registry,
    snapshotMemoryDap: async (_session, request) => {
      calls.push(request);
      return handler(request);
    },
  });
  registry.onStarted(session as never);
  return {
    service,
    registry,
    session,
    ref: registry.currentRef()!,
    calls,
    setSnapshot: h => { handler = h; },
  };
}

describe('MemoryService read', () => {
  let ctx: TestContext;
  beforeEach(() => { ctx = makeService(); });

  it('maps a DAP read block onto the frozen MemoryBlock data', async () => {
    ctx.setSnapshot(() => ({
      address: '0x20000010', requestedBytes: 4, bytesRead: 4, unreadableBytes: 0, data: 'qqqq',
    }));
    const data = await ctx.service.read(ctx.ref, { address: '0x20000010', count: 4 });
    expect(data).toEqual({
      address: '0x20000010', requestedBytes: 4, bytesRead: 4, unreadableBytes: 0, data: 'qqqq',
    });
    expect(ctx.calls).toEqual([{ kind: 'read', sessionGeneration: 1, address: '0x20000010', count: 4 }]);
  });

  it('forwards allowPartial and canonicalizes a lowercase address', async () => {
    ctx.setSnapshot(() => ({ address: '0x20000010', requestedBytes: 8, bytesRead: 8, unreadableBytes: 0, data: 'qqqq' }));
    const data = await ctx.service.read(ctx.ref, { address: '0x20000010', count: 8, allowPartial: false });
    expect(data.address).toBe('0x20000010');
    expect(ctx.calls[0]).toMatchObject({ count: 8, allowPartial: false });
  });

  it('rejects an address outside the 32-bit space as InvalidAddress', async () => {
    await expect(ctx.service.read(ctx.ref, { address: '0x1FFFFFFFF', count: 4 }))
      .rejects.toMatchObject({ errorCode: 'InvalidAddress' });
    expect(ctx.calls).toHaveLength(0);
  });

  it('rejects a non-hex address as InvalidAddress', async () => {
    await expect(ctx.service.read(ctx.ref, { address: '20000010', count: 4 }))
      .rejects.toMatchObject({ errorCode: 'InvalidAddress' });
  });

  it('rejects zero, negative and oversized counts as InvalidRequest', async () => {
    await expect(ctx.service.read(ctx.ref, { address: '0x20000010', count: 0 }))
      .rejects.toMatchObject({ errorCode: 'InvalidRequest' });
    await expect(ctx.service.read(ctx.ref, { address: '0x20000010', count: -4 }))
      .rejects.toMatchObject({ errorCode: 'InvalidRequest' });
    await expect(ctx.service.read(ctx.ref, { address: '0x20000010', count: 1048577 }))
      .rejects.toMatchObject({ errorCode: 'InvalidRequest' });
    expect(ctx.calls).toHaveLength(0);
  });

  it('maps a DAP TargetReadCancelled to the frozen retryable error', async () => {
    ctx.setSnapshot(() => ({ errorCode: 'TargetReadCancelled', message: 'target read cancelled', targetState: 'Running' }));
    await expect(ctx.service.read(ctx.ref, { address: '0x20000010', count: 4 }))
      .rejects.toMatchObject({ errorCode: 'TargetReadCancelled', retryable: true });
  });

  it('maps a DAP MemoryReadFailed to the frozen error', async () => {
    ctx.setSnapshot(() => ({ errorCode: 'MemoryReadFailed', message: 'unreadable region' }));
    await expect(ctx.service.read(ctx.ref, { address: '0x20000010', count: 4 }))
      .rejects.toMatchObject({ errorCode: 'MemoryReadFailed', retryable: false });
  });

  it('rejects a stale generation via the registry fence', async () => {
    await expect(ctx.service.read({ sessionId: 'sess-1', sessionGeneration: 99 }, { address: '0x20000010', count: 4 }))
      .rejects.toMatchObject({ errorCode: 'SessionChanged' });
  });
});

describe('MemoryService write', () => {
  let ctx: TestContext;
  beforeEach(() => { ctx = makeService(); });

  it('decodes base64, forwards verify and maps the write report', async () => {
    ctx.setSnapshot(() => ({ address: '0x20000010', bytesWritten: 4, verified: true, data: 'qqqq' }));
    const report = await ctx.service.write(ctx.ref, {
      address: '0x20000010', data: 'qqqq', verify: true,
    }, 'op-1');
    expect(report).toEqual({
      operationId: 'op-1', address: '0x20000010', bytesWritten: 4, verified: true, verifyData: 'qqqq',
    });
    expect(ctx.calls[0]).toMatchObject({
      kind: 'write', sessionGeneration: 1, address: '0x20000010', data: 'qqqq', verify: true,
    });
  });

  it('omits verifyData when the DAP write report carries none', async () => {
    ctx.setSnapshot(() => ({ address: '0x20000010', bytesWritten: 4, verified: false }));
    const report = await ctx.service.write(ctx.ref, { address: '0x20000010', data: 'qqqq', verify: false }, 'op-1');
    expect(report).toEqual({ operationId: 'op-1', address: '0x20000010', bytesWritten: 4, verified: false });
  });

  it('requires an operationId', async () => {
    await expect(ctx.service.write(ctx.ref, { address: '0x20000010', data: 'qqqq' }))
      .rejects.toMatchObject({ errorCode: 'InternalError' });
  });

  it('rejects empty and non-canonical base64 as InvalidRequest', async () => {
    await expect(ctx.service.write(ctx.ref, { address: '0x20000010', data: '' }, 'op-1'))
      .rejects.toMatchObject({ errorCode: 'InvalidRequest' });
    await expect(ctx.service.write(ctx.ref, { address: '0x20000010', data: 'hello world' }, 'op-1'))
      .rejects.toMatchObject({ errorCode: 'InvalidRequest' });
    expect(ctx.calls).toHaveLength(0);
  });

  it('rejects an oversized decoded payload as InvalidRequest', async () => {
    // 1 MiB + 1 byte; base64 length exceeds the frozen write bound.
    const big = Buffer.alloc(1048577, 0xAA).toString('base64');
    await expect(ctx.service.write(ctx.ref, { address: '0x20000010', data: big }, 'op-1'))
      .rejects.toMatchObject({ errorCode: 'InvalidRequest' });
  });

  it('maps a DAP MemoryWriteFailed to the frozen error', async () => {
    ctx.setSnapshot(() => ({ errorCode: 'MemoryWriteFailed', message: 'write rejected' }));
    await expect(ctx.service.write(ctx.ref, { address: '0x20000010', data: 'qqqq' }, 'op-1'))
      .rejects.toMatchObject({ errorCode: 'MemoryWriteFailed', retryable: false });
  });

  it('maps a DAP TargetBusy to the frozen retryable error', async () => {
    ctx.setSnapshot(() => ({ errorCode: 'TargetBusy', message: 'target busy' }));
    await expect(ctx.service.write(ctx.ref, { address: '0x20000010', data: 'qqqq' }, 'op-1'))
      .rejects.toMatchObject({ errorCode: 'TargetBusy', retryable: true });
  });
});
