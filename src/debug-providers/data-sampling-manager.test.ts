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
