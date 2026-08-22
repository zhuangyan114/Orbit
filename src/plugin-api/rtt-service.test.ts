// RttService (plan Task 11): status/start/stop/read route exclusively through
// the exact session's `orbitRttSnapshot` custom request, mapping structured
// DAP failures onto the frozen error codes and never falling back locally.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionRef } from './protocol';
import { SessionRegistry } from './session-registry';
import { RttService } from './rtt-service';
import { EventHub } from './event-hub';
import { AutomationRttRequest, AutomationRttResult, AutomationRttLogRequest, AutomationRttLogResult } from '../debug/dap-automation-protocol';

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

describe('RttService.readLog', () => {
  it('maps decoded/text entries, strips ANSI by default, and forwards count+cursor', async () => {
    const registry = new SessionRegistry();
    const session = { id: 'sess-rttlog', type: 'orbit', name: 'test' };
    const calls: AutomationRttLogRequest[] = [];
    const service = new RttService({
      registry,
      snapshotRttLogDap: async (_session, request) => {
        calls.push(request);
        const result: AutomationRttLogResult = {
          entries: [
            { id: '1', timestamp: '1700000000000', kind: 'decoded', text: '\x1B[1;36mI:\x1B[0m hello' },
            { id: '2', timestamp: '1700000000001', kind: 'text', text: 'raw line' },
          ],
          retained: 5,
          nextCursor: '2',
        };
        return result;
      },
    });
    registry.onStarted(session as never);
    const data = await service.readLog(registry.currentRef()!, { count: 2, cursor: '0' });
    expect(calls).toEqual([{ sessionGeneration: 1, count: 2, cursor: '0' }]);
    expect(data.retained).toBe(5);
    expect(data.nextCursor).toBe('2');
    expect(data.entries).toEqual([
      { id: '1', timestamp: '1700000000000', kind: 'decoded', text: 'I: hello' },
      { id: '2', timestamp: '1700000000001', kind: 'text', text: 'raw line' },
    ]);
  });

  it('preserves ANSI when stripAnsi is false', async () => {
    const registry = new SessionRegistry();
    const session = { id: 'sess-rttlog-ansi', type: 'orbit', name: 'test' };
    const service = new RttService({
      registry,
      snapshotRttLogDap: async () => ({
        entries: [{ id: '1', timestamp: '1', kind: 'decoded', text: '\x1B[1;36mI:\x1B[0m x' }],
        retained: 1,
        nextCursor: '1',
      }),
    });
    registry.onStarted(session as never);
    const data = await service.readLog(registry.currentRef()!, { count: 1, stripAnsi: false });
    expect(data.entries[0].text).toBe('\x1B[1;36mI:\x1B[0m x');
  });

  it('rejects a count outside 1..1000 before any DAP call', async () => {
    const registry = new SessionRegistry();
    const session = { id: 'sess-rttlog-count', type: 'orbit', name: 'test' };
    const calls: AutomationRttLogRequest[] = [];
    const service = new RttService({
      registry,
      snapshotRttLogDap: async (_session, request) => { calls.push(request); return { entries: [], retained: 0 }; },
    });
    registry.onStarted(session as never);
    await expect(service.readLog(registry.currentRef()!, { count: 1001 })).rejects.toMatchObject({ errorCode: 'InvalidRequest' });
    expect(calls).toHaveLength(0);
  });
});
