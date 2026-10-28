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

  it('adds a multi-selection with one sampling reconfiguration and preserves existing data', () => {
    const manager = fixture();
    try {
      manager.addExpression('existing');
      const points = manager.getAllData('existing'); points.push({ timestamp: 10, value: 3, display: '3' });
      const sync = vi.spyOn(manager as any, 'syncSamplingMode');
      const changed = vi.fn(); manager.onExpressionsChanged = changed;
      manager.addExpressions(['a', 'b', 'a', 'existing', ' 中文 ']);
      expect(manager.expressionList).toEqual(['existing', 'a', 'b']);
      expect(manager.getAllData('existing')).toBe(points);
      expect(manager.getAllData('existing')).toHaveLength(1);
      expect(sync).toHaveBeenCalledOnce();
      expect(changed).toHaveBeenCalledOnce();
    } finally { manager.dispose(); }
  });

  it('avoids a restored custom color that is close to the old first palette color', () => {
    const manager = fixture();
    try {
      manager.setExpressions([{ expression: 'saved', color: '#4ec9af' }]);
      manager.addExpression('new');
      expect(manager.entriesList[0].color).toBe('#4ec9af');
      expect(manager.entriesList[1].color.toUpperCase()).not.toBe('#4EC9B0');
    } finally { manager.dispose(); }
  });
  it('applies picker additions and removals in one sampling update without clearing retained points or colors', () => {
    const manager = fixture();
    try {
      manager.addExpressions(['remove', 'keep']);
      manager.setColor('keep', '#123456'); manager.toggleExpression('keep', false);
      const points = manager.getAllData('keep'); points.push({ timestamp: 10, value: 3, display: '3' });
      const sync = vi.spyOn(manager as any, 'syncSamplingMode');
      const changed = vi.fn(); manager.onExpressionsChanged = changed;
      manager.updateExpressions(['new', 'new'], ['remove']);
      expect(manager.expressionList).toEqual(['keep', 'new']);
      expect(manager.getAllData('keep')).toBe(points); expect(manager.getAllData('keep')).toHaveLength(1);
      expect(manager.entriesList[0]).toMatchObject({ expression: 'keep', color: '#123456', enabled: false });
      expect((manager as any).dataMap.has('remove')).toBe(false);
      expect((manager as any).pendingMap.has('remove')).toBe(false);
      expect(sync).toHaveBeenCalledOnce(); expect(changed).toHaveBeenCalledOnce();
      manager.updateExpressions([], ['keep', 'new']);
      expect(manager.expressionList).toEqual([]); expect(sync).toHaveBeenCalledTimes(2);
      manager.updateExpressions([], ['missing']);
      expect(sync).toHaveBeenCalledTimes(2);
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

  it('routes a picker delta through one DAP sampling request and stops sampling when the last entry is removed', async () => {
    const { manager, session, backend } = fixture(vi.fn(async () => ({ ok: true })));
    try {
      manager.addExpressions(['old', 'keep']); await (manager as any).remoteTransition;
      session.customRequest.mockClear();
      manager.updateExpressions(['new'], ['old']); await (manager as any).remoteTransition;
      expect(session.customRequest).toHaveBeenCalledOnce();
      expect(session.customRequest).toHaveBeenCalledWith('dataSamplingStart', expect.objectContaining({
        entries: [expect.objectContaining({ expression: 'keep' }), expect.objectContaining({ expression: 'new' })],
      }));
      session.customRequest.mockClear();
      manager.updateExpressions([], ['keep', 'new']); await (manager as any).remoteTransition;
      expect(session.customRequest).toHaveBeenCalledOnce();
      expect(session.customRequest).toHaveBeenCalledWith('dataSamplingStop', {});
      expect(backend.execute).not.toHaveBeenCalled();
    } finally { manager.dispose(); }
  });

  it('does not let a late expression update stop the newer remote sampler', async () => {
    let release!: () => void, starts = 0, remoteActive = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const commands: string[] = [];
    const { manager, session } = fixture(vi.fn(async (command: string) => {
      commands.push(command);
      if (command === 'dataSamplingStart') {
        if (++starts === 1) await gate;
        remoteActive = true;
      } else if (command === 'dataSamplingStop') remoteActive = false;
      return { ok: true };
    }));
    const m = manager as any;
    m.samplingGeneration = 1;
    const first = m.startRemoteSampling(session, 1);
    await Promise.resolve();
    m.samplingGeneration = 2;
    const newest = m.startRemoteSampling(session, 2);
    release();
    await Promise.all([first, newest]);
    expect(remoteActive).toBe(true);
    expect(commands.at(-1)).toBe('dataSamplingStart');
    manager.dispose();
  });

  it('stops an in-flight startup when the last expression is removed', async () => {
    let release!: () => void, active = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { manager, session } = fixture(vi.fn(async (command: string) => {
      if (command === 'dataSamplingStart') { await gate; active = true; }
      else if (command === 'dataSamplingStop') active = false;
      return { ok: true };
    }));
    const m = manager as any;
    const first = m.startRemoteSampling(session, 0);
    await Promise.resolve();
    m.samplingGeneration++;
    const stopping = m.stopRemoteSampling();
    release();
    await Promise.all([first, stopping]);
    expect(active).toBe(false);
    expect(m.remoteSampling).toBe(false);
    manager.dispose();
  });

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
    await Promise.resolve();
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
