import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ activeDebugSession: undefined as any, warning: vi.fn() }));
vi.mock('vscode', () => ({
  debug: {
    get activeDebugSession() { return state.activeDebugSession; },
    onDidChangeActiveDebugSession: () => ({ dispose() {} }),
    onDidTerminateDebugSession: () => ({ dispose() {} }),
    onDidReceiveDebugSessionCustomEvent: () => ({ dispose() {} }),
  },
  workspace: {
    getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
  },
  window: { showWarningMessage: state.warning },
}));

import { DataSamplingManager } from './data-sampling-manager';

describe('Timeline automatic colors', () => {
  function fixture() {
    state.activeDebugSession = undefined;
    return new DataSamplingManager({ hasTargetConnection: false, execute: vi.fn() } as any);
  }

  it('avoids a restored custom color that is close to the old first palette color', () => {
    const manager = fixture();
    try {
      manager.setExpressions([{ expression: 'saved', color: '#4ec9af' }]);
      manager.addExpression('new');
      expect(manager.entriesList[0].color).toBe('#4ec9af');
      expect(manager.entriesList[1].color.toUpperCase()).not.toBe('#4EC9B0');
    } finally { manager.dispose(); }
  });

  it('reserves saved colors even when an automatic entry comes first', () => {
    const manager = fixture();
    try {
      manager.setExpressions(['automatic', { expression: 'saved', color: '#4EC9B0' }]);
      expect(manager.entriesList[0].color).not.toBe('#4EC9B0');
      expect(manager.entriesList[1].color).toBe('#4EC9B0');
    } finally { manager.dispose(); }
  });

  it('uses current custom colors, disabled entries, and more colors than one palette cycle', () => {
    const manager = fixture();
    try {
      manager.addExpression('first');
      manager.setColor('first', '#569cd5');
      manager.toggleExpression('first', false);
      manager.addExpression('second');
      expect(manager.entriesList[1].color.toUpperCase()).not.toBe('#569CD6');
      for (let i = 2; i < 24; i++) manager.addExpression('variable' + i);
      expect(new Set(manager.entriesList.map(e => e.color.toUpperCase())).size).toBe(24);
    } finally { manager.dispose(); }
  });
});

describe('Timeline sampling rejection feedback', () => {
  beforeEach(() => {
    state.warning.mockReset();
    state.activeDebugSession = undefined;
  });

  function fixture(customRequest: ReturnType<typeof vi.fn>) {
    const backend = { hasTargetConnection: false, execute: vi.fn() };
    const session = { type: 'orbit', customRequest };
    state.activeDebugSession = session;
    const manager = new DataSamplingManager(backend as any);
    return { backend, session, manager };
  }

  it('reports rejected expressions while keeping the supported remote sampler active', async () => {
    const { manager, session, backend } = fixture(vi.fn(async () => ({
      ok: true,
      planned: [
        { expression: 'speed', spec: { expression: 'speed', address: 0x20000100, size: 4 } },
        { expression: 'motors[i].velocity', error: 'unsupported index' },
      ],
    })));
    await (manager as any).startRemoteSampling(session, 0);
    expect(state.warning).toHaveBeenCalledOnce();
    expect(state.warning.mock.calls[0][0]).toContain('motors[i].velocity（unsupported index）');
    expect((manager as any).remoteSampling).toBe(true);
    expect((manager as any).remoteSession).toBe(session);
    expect(backend.execute).not.toHaveBeenCalled();
    manager.dispose();
  });

  it.each(['response', 'exception'])('reports an entirely rejected batch once via %s', async mode => {
    const { manager, session, backend } = fixture(vi.fn(async () => {
      if (mode === 'exception') throw new Error('No expressions can use fast data sampling: motors[i].velocity');
      return { ok: false, planned: [{ expression: 'motors[i].velocity', error: 'unsupported index' }] };
    }));
    await (manager as any).startRemoteSampling(session, 0);
    expect(state.warning).toHaveBeenCalledOnce();
    expect(state.warning.mock.calls[0][0]).toContain('motors[i].velocity');
    expect((manager as any).remoteSampling).toBe(false);
    expect((manager as any).timer).toBeNull();
    expect(backend.execute).not.toHaveBeenCalled();
    manager.dispose();
  });

  it.each(['generation', 'session'])('ignores obsolete startup errors after a %s change', async mode => {
    let reject!: (error: Error) => void;
    const pending = new Promise((_, fail) => { reject = fail; });
    const { manager, session } = fixture(vi.fn(() => pending));
    const starting = (manager as any).startRemoteSampling(session, 0);
    const current = mode === 'session' ? { type: 'orbit' } : session;
    if (mode === 'generation') (manager as any).samplingGeneration++;
    state.activeDebugSession = current;
    (manager as any).remoteSession = current;
    (manager as any).remoteSampling = true;
    reject(new Error('obsolete sampling error'));
    await starting;
    expect(state.warning).not.toHaveBeenCalled();
    expect((manager as any).remoteSampling).toBe(true);
    expect((manager as any).remoteSession).toBe(current);
    // Release test state without sending a stop request to the fake session.
    (manager as any).remoteSampling = false;
    manager.dispose();
  });
});
