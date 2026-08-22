// DiagnosticsService (plan Task 11): a redacted API/DAP/owner/scheduler/
// sampling summary that never leaks a token, Authorization, memory or variable
// values. The `tokenIncluded` const-false is asserted on the wire shape.
import { describe, expect, it, vi } from 'vitest';
import { SessionRegistry } from './session-registry';
import { DiagnosticsService } from './diagnostics-service';
import { AutomationDiagnosticsResult } from '../debug/dap-automation-protocol';

vi.mock('vscode', () => ({}));

function makeService(overrides: {
  dap?: () => AutomationDiagnosticsResult;
  getConnections?: () => number;
  getSseConnections?: () => number;
} = {}) {
  const registry = new SessionRegistry();
  const session = { id: 'sess-diag', type: 'orbit', name: 'test' };
  const service = new DiagnosticsService({
    registry,
    version: '1.0',
    getConnections: overrides.getConnections ?? (() => 3),
    getSseConnections: overrides.getSseConnections ?? (() => 1),
    getSamplingStats: () => ({ activeRecordings: 2, retainedFrames: 100, retainedBytes: 4096, droppedFrames: 0 }),
    snapshotDiagnosticsDap: async () => (overrides.dap ?? (() => ({
      phase: 'running',
      targetState: 'Running',
      ownerKind: 'jlink-native',
      transport: 'native',
      connected: true,
      pendingRequests: 1,
      scheduler: { control: 0, watch: 1, timeline: 2, background: 0 },
    })))(),
  });
  registry.onStarted(session as never);
  return { service, registry, session };
}

function walkForKeys(value: unknown, keys: string[]): string[] {
  const hits: string[] = [];
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (keys.includes(key)) hits.push(key);
      hits.push(...walkForKeys(child, keys));
    }
  }
  return hits;
}

describe('DiagnosticsService', () => {
  it('assembles the frozen DiagnosticsSnapshot with all sections', async () => {
    const { service, registry } = makeService();
    const snapshot = await service.snapshot();
    expect(snapshot.tokenIncluded).toBe(false);
    expect(snapshot.api).toEqual({
      version: '1.0',
      connections: 3,
      sseConnections: 1,
      registryGeneration: 1,
    });
    expect(snapshot.dap).toMatchObject({ phase: 'running', pendingRequests: 1, sessionGeneration: 1 });
    expect(snapshot.owner).toMatchObject({ kind: 'jlink-native', connected: true, transport: 'native' });
    expect(snapshot.scheduler).toEqual({ control: 0, watch: 1, timeline: 2, background: 0 });
    expect(snapshot.sampling).toEqual({ activeRecordings: 2, retainedFrames: 100, retainedBytes: 4096, droppedFrames: 0 });
    expect(registry.registryGeneration).toBe(1);
  });

  it('never leaks token, Authorization, memory or variable-value keys', async () => {
    const { service } = makeService({
      dap: () => ({
        phase: 'running',
        targetState: 'Running',
        ownerKind: 'jlink-native',
        connected: true,
        pendingRequests: 0,
        scheduler: { control: 0, watch: 0, timeline: 0, background: 0 },
      }),
    });
    const snapshot = await service.snapshot();
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain('Bearer');
    expect(serialized).not.toContain('Authorization');
    expect(walkForKeys(snapshot, ['token', 'authorization', 'memory', 'value', 'data'])).toEqual([]);
    expect(snapshot.tokenIncluded).toBe(false);
  });

  it('reports no session when the registry has none (and no DAP fallback)', async () => {
    const registry = new SessionRegistry();
    const service = new DiagnosticsService({
      registry,
      version: '1.0',
      getConnections: () => 0,
      getSseConnections: () => 0,
      getSamplingStats: () => ({ activeRecordings: 0, retainedFrames: 0, retainedBytes: 0, droppedFrames: 0 }),
      snapshotDiagnosticsDap: async () => { throw new Error('unreachable'); },
    });
    const snapshot = await service.snapshot();
    expect(snapshot.dap).toEqual({ phase: 'none', pendingRequests: 0 });
    expect(snapshot.owner).toEqual({ connected: false });
    expect(snapshot.scheduler).toEqual({ control: 0, watch: 0, timeline: 0, background: 0 });
    expect(snapshot.tokenIncluded).toBe(false);
  });
});
