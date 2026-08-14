// RttService (plan Task 11): status/start/stop/read route exclusively through
// the exact session's `orbitRttSnapshot` custom request, mapping structured
// DAP failures onto the frozen error codes and never falling back locally.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionRef } from './protocol';
import { SessionRegistry } from './session-registry';
import { RttService } from './rtt-service';
import { EventHub } from './event-hub';
import { AutomationRttRequest, AutomationRttResult } from '../debug/dap-automation-protocol';

vi.mock('vscode', () => ({}));

interface TestContext {
  service: RttService;
  registry: SessionRegistry;
  ref: SessionRef;
  calls: AutomationRttRequest[];
  setResult: (handler: (request: AutomationRttRequest) => AutomationRttResult) => void;
}

function makeSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    state: 'running',
    owner: 'jlink-native',
    bufferIndex: 0,
    pollIntervalMs: 50,
    ansi: true,
    bytesAvailable: 0,
    droppedBytes: 0,
    ...overrides,
  } as AutomationRttResult['snapshot'];
}

function makeService(): TestContext {
  const registry = new SessionRegistry();
  const session = { id: 'sess-rtt', type: 'orbit', name: 'test' };
  const calls: AutomationRttRequest[] = [];
  let handler: (request: AutomationRttRequest) => AutomationRttResult = () => ({ snapshot: makeSnapshot() });
  const service = new RttService({
    registry,
    snapshotRttDap: async (_session, request) => {
      calls.push(request);
      return handler(request);
    },
  });
  registry.onStarted(session as never);
  return {
    service,
    registry,
    ref: registry.currentRef()!,
    calls,
    setResult: h => { handler = h; },
  };
}

describe('RttService', () => {
  let ctx: TestContext;
  beforeEach(() => { ctx = makeService(); });

  it('maps a status snapshot onto the frozen RttSnapshot shape', async () => {
    ctx.setResult(() => ({ snapshot: makeSnapshot({ state: 'running', targetName: 'SEGGER RTT' }) }));
    const snapshot = await ctx.service.status(ctx.ref, {});
    expect(snapshot).toEqual({
      state: 'running',
      owner: 'jlink-native',
      bufferIndex: 0,
      pollIntervalMs: 50,
      targetName: 'SEGGER RTT',
      ansi: true,
      bytesAvailable: 0,
      droppedBytes: 0,
    });
    expect(ctx.calls).toEqual([{ kind: 'status', sessionGeneration: 1 }]);
  });

  it('forwards start parameters (bufferIndex, pollIntervalMs, targetName, ansi)', async () => {
    ctx.setResult(() => ({ snapshot: makeSnapshot({ state: 'running', bufferIndex: 2 }) }));
    await ctx.service.start(ctx.ref, {
      bufferIndex: 2,
      pollIntervalMs: 20,
      targetName: 'SEGGER RTT',
      ansi: false,
    });
    expect(ctx.calls[0]).toEqual({
      kind: 'start',
      sessionGeneration: 1,
      bufferIndex: 2,
      pollIntervalMs: 20,
      targetName: 'SEGGER RTT',
      ansi: false,
    });
  });

  it('maps a read result into the frozen RttReadData with base64 data', async () => {
    ctx.setResult(() => ({ snapshot: makeSnapshot({ state: 'running' }), data: 'aGVsbG8=', bytesRead: 5 }));
    const data = await ctx.service.read(ctx.ref, { bufferIndex: 0, maxBytes: 16 });
    expect(data).toEqual({
      snapshot: expect.objectContaining({ state: 'running' }),
      data: 'aGVsbG8=',
      bytesRead: 5,
      nextCursor: null,
    });
    expect(ctx.calls[0]).toMatchObject({ kind: 'read', sessionGeneration: 1, maxBytes: 16 });
  });

  it('omits nextCursor when the read returned no data field', async () => {
    ctx.setResult(() => ({ snapshot: makeSnapshot({ state: 'stopped' }), bytesRead: 0 }));
    const data = await ctx.service.read(ctx.ref, {});
    expect(data.nextCursor).toBeUndefined();
    expect(data.data).toBe('');
  });

  it('maps CapabilityUnavailable from the adapter to the frozen error', async () => {
    ctx.setResult(() => ({ errorCode: 'CapabilityUnavailable', message: 'no RTT control block' }));
    await expect(ctx.service.start(ctx.ref, {})).rejects.toMatchObject({ errorCode: 'CapabilityUnavailable' });
  });

  it('maps TargetReadCancelled for a read that lost the read gate', async () => {
    ctx.setResult(() => ({ errorCode: 'TargetReadCancelled', message: 'read cancelled' }));
    await expect(ctx.service.read(ctx.ref, {})).rejects.toMatchObject({ errorCode: 'TargetReadCancelled', retryable: true });
  });

  it('maps TargetBusy / SessionStarting / SessionTerminating / TargetDisconnected', async () => {
    const cases: Array<[string, string]> = [
      ['TargetBusy', 'TargetBusy'],
      ['SessionStarting', 'SessionStarting'],
      ['SessionTerminating', 'SessionTerminating'],
      ['NativeOwnerLost', 'TargetDisconnected'],
    ];
    for (const [dapCode, frozen] of cases) {
      ctx.setResult(() => ({ errorCode: dapCode, message: dapCode }));
      await expect(ctx.service.stop(ctx.ref, {})).rejects.toMatchObject({ errorCode: frozen });
    }
  });

  it('throws TargetDisconnected when the DAP custom request rejects at transport level', async () => {
    const registry = new SessionRegistry();
    const session = { id: 'sess-rtt-2', type: 'orbit', name: 'test' };
    const service = new RttService({
      registry,
      snapshotRttDap: async () => { throw new Error('socket closed'); },
    });
    registry.onStarted(session as never);
    await expect(service.status(registry.currentRef()!, {})).rejects.toMatchObject({ errorCode: 'TargetDisconnected' });
  });

  it('fences a stale session generation before any DAP call', async () => {
    const stale: SessionRef = { sessionId: ctx.ref.sessionId, sessionGeneration: ctx.ref.sessionGeneration + 1 };
    await expect(ctx.service.status(stale, {})).rejects.toMatchObject({ errorCode: 'SessionChanged' });
    expect(ctx.calls).toHaveLength(0);
  });

  it('publishes rtt.stateChanged to the shared EventHub on start and stop', async () => {
    const registry = new SessionRegistry();
    const session = { id: 'sess-rtt-hub', type: 'orbit', name: 'test' };
    const hub = new EventHub({ instanceId: () => 'i', projectId: () => 'p' });
    const service = new RttService({
      registry,
      eventHub: hub,
      snapshotRttDap: async () => ({ snapshot: makeSnapshot({ state: 'running' }) }),
    });
    registry.onStarted(session as never);
    await service.start(registry.currentRef()!, {});
    await service.stop(registry.currentRef()!, {});
    const types = hub.eventsAfter(undefined).events.map(event => event.type);
    expect(types).toEqual(['rtt.stateChanged', 'rtt.stateChanged']);
  });
});
