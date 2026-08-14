// RuntimeService: exact-session runtime inspection routing, DTO mapping and
// generation-fenced variablesReference (plan Task 7).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionRef } from './protocol';
import { SessionRegistry } from './session-registry';
import { RuntimeService } from './runtime-service';
import { AutomationRuntimeRequest, AutomationRuntimeResult } from '../debug/dap-automation-protocol';

// The service only touches vscode values inside its default `snapshotDap` seam,
// which every test overrides, so an empty module mock suffices.
vi.mock('vscode', () => ({}));

interface TestContext {
  service: RuntimeService;
  registry: SessionRegistry;
  session: { id: string; type: string; name: string };
  ref: SessionRef;
  snapshotCalls: AutomationRuntimeRequest[];
  setSnapshot: (handler: (request: AutomationRuntimeRequest) => AutomationRuntimeResult) => void;
  restart: () => void;
}

function makeService(): TestContext {
  const registry = new SessionRegistry();
  const session = { id: 'sess-1', type: 'orbit', name: 'test' };
  const snapshotCalls: AutomationRuntimeRequest[] = [];
  let snapshotHandler: (request: AutomationRuntimeRequest) => AutomationRuntimeResult = () => ({});
  const service = new RuntimeService({
    registry,
    snapshotDap: async (_session, request) => {
      snapshotCalls.push(request);
      return snapshotHandler(request);
    },
  });
  registry.onStarted(session as never);
  return {
    service,
    registry,
    session,
    ref: registry.currentRef()!,
    snapshotCalls,
    setSnapshot: handler => {
      snapshotHandler = handler;
    },
    restart: () => registry.onRestarted(session as never),
  };
}

describe('RuntimeService threads/stackTrace/scopes/registers', () => {
  let ctx: TestContext;
  beforeEach(() => {
    ctx = makeService();
  });

  it('threads maps the adapter thread list', async () => {
    ctx.setSnapshot(() => ({
      threads: [{ threadId: 1, name: 'STM32F407 (FreeRTOS)', state: 'halted', stopped: true }],
    }));
    const data = await ctx.service.threads(ctx.ref);
    expect(data.items).toEqual([{ threadId: 1, name: 'STM32F407 (FreeRTOS)', state: 'halted', stopped: true }]);
    expect(ctx.snapshotCalls).toEqual([{ kind: 'threads', sessionGeneration: 1 }]);
  });

  it('stackTrace maps frames and applies startFrame/levels', async () => {
    ctx.setSnapshot(() => ({
      stackFrames: [
        { frameId: 1, name: 'StartTask02', source: { path: 'c:/ws/freertos.c', line: 402 }, instructionPointerReference: '0x8004E2E' },
        { frameId: 2, name: 'main', source: { path: 'c:/ws/main.c', line: 10 }, instructionPointerReference: '0x8000100' },
        { frameId: 3, name: 'Reset_Handler', instructionPointerReference: '0x80056C4' },
      ],
    }));
    const data = await ctx.service.stackTrace(ctx.ref, { threadId: 1, startFrame: 1, levels: 1 });
    expect(data.items).toEqual([
      { frameId: 2, name: 'main', source: { path: 'c:/ws/main.c', line: 10 }, instructionPointerReference: '0x8000100' },
    ]);
    expect(data.nextCursor).toBe('2');
    expect(ctx.snapshotCalls).toEqual([{ kind: 'stackTrace', sessionGeneration: 1, threadId: 1 }]);
  });

  it('stackTrace omits the source when the frame has no line info', async () => {
    ctx.setSnapshot(() => ({
      stackFrames: [{ frameId: 3, name: 'Reset_Handler', instructionPointerReference: '0x80056C4' }],
    }));
    const data = await ctx.service.stackTrace(ctx.ref, { threadId: 1 });
    expect(data.items[0]).toEqual({ frameId: 3, name: 'Reset_Handler', instructionPointerReference: '0x80056C4' });
  });

  it('scopes stringifies variablesReference and records its generation', async () => {
    ctx.setSnapshot(() => ({
      scopes: [
        { name: 'Local', variablesReference: 1, expensive: false },
        { name: 'Registers', variablesReference: 2, expensive: false },
      ],
    }));
    const data = await ctx.service.scopes(ctx.ref, { frameId: 1 });
    expect(data.items).toEqual([
      { name: 'Local', variablesReference: '1', expensive: false },
      { name: 'Registers', variablesReference: '2', expensive: false },
    ]);
  });

  it('registers maps group/bits/value/memoryReference', async () => {
    ctx.setSnapshot(() => ({
      registers: [
        { name: 'PC', value: '0x08000480', group: 'core', bits: 32, memoryReference: '0x08000480' },
        { name: 'R0', value: '0x00000001', group: 'core', bits: 32, memoryReference: '0x00000001' },
      ],
    }));
    const data = await ctx.service.registers(ctx.ref, { groups: ['core'] });
    expect(data.items).toEqual([
      { name: 'PC', value: '0x08000480', group: 'core', bits: 32, memoryReference: '0x08000480' },
      { name: 'R0', value: '0x00000001', group: 'core', bits: 32, memoryReference: '0x00000001' },
    ]);
    expect(ctx.snapshotCalls).toEqual([{ kind: 'registers', sessionGeneration: 1, groups: ['core'] }]);
  });
});

describe('RuntimeService variablesReference generation fence', () => {
  it('expands a reference issued under the current generation', async () => {
    const ctx = makeService();
    ctx.setSnapshot(request => request.kind === 'scopes'
      ? { scopes: [{ name: 'Local', variablesReference: 1, expensive: false }] }
      : {
          variables: [{
            name: 'aww', value: '0.5', variablesReference: 0,
          }],
        });
    await ctx.service.scopes(ctx.ref, { frameId: 1 });
    const data = await ctx.service.variables(ctx.ref, { variablesReference: '1' });
    expect(data.items).toEqual([{ name: 'aww', value: '0.5', variablesReference: '0' }]);
  });

  it('rejects a reference reused after session restart as SessionChanged', async () => {
    const ctx = makeService();
    ctx.setSnapshot(() => ({ scopes: [{ name: 'Local', variablesReference: 1, expensive: false }] }));
    await ctx.service.scopes(ctx.ref, { frameId: 1 });

    ctx.restart();
    const newRef = ctx.registry.currentRef()!;
    expect(newRef.sessionGeneration).toBe(2);

    await expect(ctx.service.variables(newRef, { variablesReference: '1' }))
      .rejects.toMatchObject({ errorCode: 'SessionChanged', data: { variablesReference: '1' } });
  });

  it('records child references for a subsequent expansion round-trip', async () => {
    const ctx = makeService();
    ctx.setSnapshot(request => {
      if (request.kind === 'scopes') {
        return { scopes: [{ name: 'Local', variablesReference: 1, expensive: false }] };
      }
      if (request.variablesReference === 1) {
        return {
          variables: [{
            name: 'structVar', value: '{...}', variablesReference: 1000,
            memoryReference: '0x20000000',
          }],
        };
      }
      return {
        variables: [{
          name: 'structVar.field', value: '7', variablesReference: 0,
        }],
      };
    });
    await ctx.service.scopes(ctx.ref, { frameId: 1 });
    const parent = await ctx.service.variables(ctx.ref, { variablesReference: '1' });
    expect(parent.items[0]).toMatchObject({ name: 'structVar', variablesReference: '1000', memoryReference: '0x20000000' });

    const child = await ctx.service.variables(ctx.ref, { variablesReference: '1000' });
    expect(child.items).toEqual([{ name: 'structVar.field', value: '7', variablesReference: '0' }]);
  });
});

describe('RuntimeService failures and pagination', () => {
  it('maps a DAP TargetRunning failure to the frozen error', async () => {
    const ctx = makeService();
    ctx.setSnapshot(() => ({ errorCode: 'TargetRunning', message: 'target is running', targetState: 'Running' }));
    await expect(ctx.service.stackTrace(ctx.ref, { threadId: 1 }))
      .rejects.toMatchObject({ errorCode: 'TargetRunning', retryable: true });
  });

  it('maps a DAP TargetReadCancelled failure', async () => {
    const ctx = makeService();
    ctx.setSnapshot(() => ({ errorCode: 'TargetReadCancelled', message: 'read cancelled', targetState: 'Running' }));
    await expect(ctx.service.registers(ctx.ref)).rejects.toMatchObject({ errorCode: 'TargetReadCancelled' });
  });

  it('falls back to InternalError for an unknown DAP failure code', async () => {
    const ctx = makeService();
    ctx.setSnapshot(() => ({ errorCode: 'WeirdBackendFailure', message: 'boom' }));
    await expect(ctx.service.scopes(ctx.ref, { frameId: 1 })).rejects.toMatchObject({ errorCode: 'InternalError' });
  });

  it('rejects an unknown session ref as NoActiveSession', async () => {
    const ctx = makeService();
    await expect(ctx.service.threads({ sessionId: 'missing', sessionGeneration: 1 }))
      .rejects.toMatchObject({ errorCode: 'NoActiveSession' });
  });

  it('rejects a stale generation as SessionChanged via the registry fence', async () => {
    const ctx = makeService();
    await expect(ctx.service.threads({ sessionId: 'sess-1', sessionGeneration: 99 }))
      .rejects.toMatchObject({ errorCode: 'SessionChanged' });
  });

  it('paginates threads by threadId cursor', async () => {
    const ctx = makeService();
    ctx.setSnapshot(() => ({
      threads: [
        { threadId: 1, name: 'a', state: 'halted', stopped: true },
        { threadId: 2, name: 'b', state: 'halted', stopped: true },
        { threadId: 3, name: 'c', state: 'halted', stopped: true },
      ],
    }));
    const page1 = await ctx.service.threads(ctx.ref, { limit: 2 });
    expect(page1.items.map(t => t.threadId)).toEqual([1, 2]);
    expect(page1.nextCursor).toBe('2');

    const page2 = await ctx.service.threads(ctx.ref, { cursor: '2', limit: 2 });
    expect(page2.items.map(t => t.threadId)).toEqual([3]);
    expect(page2.nextCursor).toBeUndefined();
  });
});
