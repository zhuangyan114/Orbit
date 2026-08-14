// RuntimeService expression/symbol methods (plan Task 8): Unicode-preserving
// normalization, ordered per-item reads, control-barrier writes, inspect
// expansion, ELF symbol search/resolve mapping, and frozen error mapping.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionRef } from './protocol';
import { SessionRegistry } from './session-registry';
import { RuntimeService } from './runtime-service';
import { AutomationExpressionRequest, AutomationExpressionResult } from '../debug/dap-automation-protocol';

vi.mock('vscode', () => ({}));

interface TestContext {
  service: RuntimeService;
  registry: SessionRegistry;
  session: { id: string; type: string; name: string };
  ref: SessionRef;
  calls: AutomationExpressionRequest[];
  setSnapshot: (handler: (request: AutomationExpressionRequest) => AutomationExpressionResult) => void;
  restart: () => void;
}

function makeService(): TestContext {
  const registry = new SessionRegistry();
  const session = { id: 'sess-1', type: 'orbit', name: 'test' };
  const calls: AutomationExpressionRequest[] = [];
  let handler: (request: AutomationExpressionRequest) => AutomationExpressionResult = () => ({});
  const service = new RuntimeService({
    registry,
    snapshotExpressionDap: async (_session, request) => {
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
    restart: () => registry.onRestarted(session as never),
  };
}

describe('RuntimeService expression.evaluate', () => {
  let ctx: TestContext;
  beforeEach(() => { ctx = makeService(); });

  it('maps a value and stringifies the child variablesReference', async () => {
    ctx.setSnapshot(() => ({
      value: { expression: 'aww', value: '0.5', type: 'float', variablesReference: 1000, available: true, stale: false },
    }));
    const value = await ctx.service.evaluate(ctx.ref, { expression: 'aww' });
    expect(value).toEqual({
      expression: 'aww', value: '0.5', type: 'float', variablesReference: '1000', available: true, stale: false,
    });
    expect(ctx.calls).toEqual([{ kind: 'evaluate', sessionGeneration: 1, expression: 'aww' }]);
  });

  it('rejects a control-character expression as InvalidExpression without rewriting', async () => {
    await expect(ctx.service.evaluate(ctx.ref, { expression: 'a\u0000b' }))
      .rejects.toMatchObject({ errorCode: 'InvalidExpression' });
    expect(ctx.calls).toHaveLength(0);
  });

  it('maps a DAP TargetRunning failure to the frozen retryable error', async () => {
    ctx.setSnapshot(() => ({ errorCode: 'TargetRunning', message: 'target is running', targetState: 'Running' }));
    await expect(ctx.service.evaluate(ctx.ref, { expression: 'x' }))
      .rejects.toMatchObject({ errorCode: 'TargetRunning', retryable: true });
  });

  it('rejects a stale generation via the registry fence', async () => {
    await expect(ctx.service.evaluate({ sessionId: 'sess-1', sessionGeneration: 99 }, { expression: 'x' }))
      .rejects.toMatchObject({ errorCode: 'SessionChanged' });
  });
});

describe('RuntimeService expression.readMany', () => {
  let ctx: TestContext;
  beforeEach(() => { ctx = makeService(); });

  it('preserves input order', async () => {
    ctx.setSnapshot(request => ({
      values: request.expressions!.map(expr => ({
        expression: expr, value: expr === 'b' ? '2' : '1', variablesReference: 0, available: true, stale: false,
      })),
    }));
    const data = await ctx.service.readMany(ctx.ref, { expressions: ['a', 'b', 'c'] });
    expect(data.items.map(i => i.expression)).toEqual(['a', 'b', 'c']);
    expect(data.items.map(i => i.value)).toEqual(['1', '2', '1']);
  });

  it('isolates a control-character item without masking the others', async () => {
    ctx.setSnapshot(() => ({
      values: [{ expression: 'good', value: '1', variablesReference: 0, available: true, stale: false }],
    }));
    const data = await ctx.service.readMany(ctx.ref, { expressions: ['good', 'bad\u0000expr'] });
    expect(data.items[0]).toMatchObject({ expression: 'good', available: true, value: '1' });
    expect(data.items[1]).toMatchObject({
      expression: 'bad\u0000expr', available: false, error: { errorCode: 'InvalidExpression' },
    });
  });

  it('maps a running placeholder to stale/unavailable with TargetRunning', async () => {
    ctx.setSnapshot(() => ({
      values: [{ expression: 'x', value: '', variablesReference: 0, available: false, stale: true, error: { errorCode: 'TargetRunning', message: 'target is running' } }],
    }));
    const data = await ctx.service.readMany(ctx.ref, { expressions: ['x'] });
    expect(data.items[0]).toMatchObject({ available: false, stale: true, error: { errorCode: 'TargetRunning', retryable: true } });
  });

  it('forwards forceRealtime', async () => {
    ctx.setSnapshot(() => ({ values: [] }));
    await ctx.service.readMany(ctx.ref, { expressions: ['x'], forceRealtime: true });
    expect(ctx.calls[0]).toMatchObject({ kind: 'readMany', expressions: ['x'], forceRealtime: true });
  });
});

describe('RuntimeService expression.writeMany', () => {
  let ctx: TestContext;
  beforeEach(() => { ctx = makeService(); });

  it('parses decimal/hex/float values and merges DAP outcomes in order', async () => {
    ctx.setSnapshot(request => ({
      writes: (request.writes ?? []).map(write => ({ expression: write.expression, written: true })),
    }));
    const data = await ctx.service.writeMany(ctx.ref, {
      writes: [
        { expression: 'a', value: '0x10' },
        { expression: 'b', value: '3.5' },
      ],
    }, 'op-1');
    expect(data.operationId).toBe('op-1');
    expect(data.items.map(i => i.written)).toEqual([true, true]);
    expect(data.items[0]).toMatchObject({ expression: 'a', value: '0x10' });
    expect(data.items[1]).toMatchObject({ expression: 'b', value: '3.5' });
    expect(ctx.calls[0]).toMatchObject({
      kind: 'writeMany',
      writes: [{ expression: 'a', value: 16 }, { expression: 'b', value: 3.5 }],
    });
  });

  it('isolates invalid expressions and non-numeric values, preserving order', async () => {
    ctx.setSnapshot(() => ({ writes: [{ expression: 'c', written: true }] }));
    const data = await ctx.service.writeMany(ctx.ref, {
      writes: [
        { expression: 'a\u0000b', value: '1' },
        { expression: 'c', value: 'abc' },
        { expression: 'c', value: '5' },
      ],
    }, 'op-1');
    expect(data.items[0]).toMatchObject({ expression: 'a\u0000b', written: false, error: { errorCode: 'InvalidExpression' } });
    expect(data.items[1]).toMatchObject({ expression: 'c', written: false, error: { errorCode: 'ExpressionNotWritable' } });
    expect(data.items[2]).toMatchObject({ expression: 'c', written: true, value: '5' });
    expect(ctx.calls[0]).toMatchObject({ writes: [{ expression: 'c', value: 5 }] });
  });

  it('maps a DAP write failure to a per-item outcome', async () => {
    ctx.setSnapshot(() => ({ writes: [{ expression: 'a', written: false, error: { errorCode: 'ExpressionNotWritable', message: 'read-only' } }] }));
    const data = await ctx.service.writeMany(ctx.ref, { writes: [{ expression: 'a', value: '1' }] }, 'op-1');
    expect(data.items[0]).toMatchObject({ written: false, error: { errorCode: 'ExpressionNotWritable' } });
  });

  it('requires an operationId', async () => {
    await expect(ctx.service.writeMany(ctx.ref, { writes: [{ expression: 'a', value: '1' }] }))
      .rejects.toMatchObject({ errorCode: 'InternalError' });
  });
});

describe('RuntimeService expression.inspect', () => {
  let ctx: TestContext;
  beforeEach(() => { ctx = makeService(); });

  it('maps root and children with generation-fenced references', async () => {
    ctx.setSnapshot(() => ({
      value: { expression: 's', value: '{...}', variablesReference: 1000, available: true, stale: false },
      inspectItems: [
        { name: 's.x', value: '7', variablesReference: 0 },
        { name: 's.child', value: '{...}', variablesReference: 1001, memoryReference: '0x20000000' },
      ],
    }));
    const data = await ctx.service.inspect(ctx.ref, { expression: 's' });
    expect(data.root).toMatchObject({ expression: 's', variablesReference: '1000' });
    expect(data.items[0]).toEqual({ name: 's.x', value: '7', variablesReference: '0' });
    expect(data.items[1]).toMatchObject({ name: 's.child', variablesReference: '1001', memoryReference: '0x20000000' });
  });
});

describe('RuntimeService symbol.search / symbol.resolve', () => {
  let ctx: TestContext;
  beforeEach(() => { ctx = makeService(); });

  it('maps nm type characters to frozen kinds and stringifies address/size', async () => {
    ctx.setSnapshot(() => ({
      symbols: [
        { name: 'Reset_Handler', address: 0x080056C4, size: 16, typeChar: 'T' },
        { name: 'aww', address: 0x20000000, size: 4, typeChar: 'B' },
        { name: 'weird', address: 0x08001000, size: 0, typeChar: '?' },
      ],
    }));
    const data = await ctx.service.symbolSearch(ctx.ref, { query: 'a', limit: 10 });
    expect(data.items.map(s => s.kind)).toEqual(['function', 'variable', 'unknown']);
    expect(data.items[0]).toMatchObject({ name: 'Reset_Handler', address: '0x080056C4', size: '16' });
    expect(data.items[2]).not.toHaveProperty('size');
  });

  it('filters by kinds', async () => {
    ctx.setSnapshot(() => ({
      symbols: [
        { name: 'alpha_fn', address: 0x08000000, size: 0, typeChar: 'T' },
        { name: 'alpha_var', address: 0x20000000, size: 4, typeChar: 'B' },
      ],
    }));
    const data = await ctx.service.symbolSearch(ctx.ref, { query: 'alpha', kinds: ['variable'] });
    expect(data.items.map(s => s.name)).toEqual(['alpha_var']);
  });

  it('resolves by name exactly', async () => {
    ctx.setSnapshot(() => ({ symbol: { name: 'main', address: 0x08000000, size: 0, typeChar: 'T' }, exact: true }));
    const data = await ctx.service.symbolResolve(ctx.ref, { name: 'main' });
    expect(data).toEqual({ symbol: { name: 'main', kind: 'function', address: '0x08000000' }, exact: true });
    expect(ctx.calls[0]).toMatchObject({ kind: 'symbolResolve', expression: 'main' });
  });

  it('resolves by address', async () => {
    ctx.setSnapshot(() => ({ symbol: { name: 'Reset_Handler', address: 0x080056C4, size: 16, typeChar: 'T' }, exact: false }));
    const data = await ctx.service.symbolResolve(ctx.ref, { address: '0x080056C4' });
    expect(data.exact).toBe(false);
    expect(ctx.calls[0]).toMatchObject({ kind: 'symbolResolve', address: '0x080056C4' });
  });

  it('maps SymbolsUnavailable to CapabilityUnavailable', async () => {
    ctx.setSnapshot(() => ({ errorCode: 'SymbolsUnavailable', message: 'no symbols' }));
    await expect(ctx.service.symbolSearch(ctx.ref, { query: 'x' })).rejects.toMatchObject({ errorCode: 'CapabilityUnavailable' });
  });

  it('maps SymbolNotFound to InvalidRequest', async () => {
    ctx.setSnapshot(() => ({ errorCode: 'SymbolNotFound', message: 'not found' }));
    await expect(ctx.service.symbolResolve(ctx.ref, { name: 'nope' })).rejects.toMatchObject({ errorCode: 'InvalidRequest' });
  });
});
