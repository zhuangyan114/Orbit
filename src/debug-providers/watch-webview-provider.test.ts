import { afterEach, describe, expect, it, vi } from 'vitest';

const vscodeState = vi.hoisted(() => ({ activeDebugSession: undefined as any }));

vi.mock('vscode', () => ({
  debug: vscodeState,
}));

import { OzoneBackend } from '../ozone-backend/commander';
import { WatchWebviewProvider } from './watch-webview-provider';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(next => { resolve = next; });
  return { promise, resolve };
}

function createProvider(isCurrentSession: (session: any) => boolean = () => true, seed: Record<string, unknown> = {}) {
  const postMessage = vi.fn();
  const saved = new Map(Object.entries(seed));
  const context = {
    workspaceState: {
      get: vi.fn((key: string, fallback: unknown) => saved.has(key) ? saved.get(key) : fallback),
      update: vi.fn((key: string, value: unknown) => { saved.set(key, structuredClone(value)); return Promise.resolve(); }),
    },
  } as any;
  const backend = { hasTargetConnection: false, execute: vi.fn() } as unknown as OzoneBackend;
  const picker = { open: vi.fn(async () => {}) };
  const provider = new WatchWebviewProvider(context, backend, isCurrentSession, picker as any);
  (provider as any).view = { webview: { postMessage } };
  return { provider, postMessage, saved, context, backend, picker };
}

afterEach(() => { vscodeState.activeDebugSession = undefined; });

describe('WatchWebviewProvider groups', () => {
  it('adds a symbol selection as one group update without dropping later items', () => {
    const { provider } = createProvider();
    const changed = vi.fn(); provider.onExpressionsChanged = changed;
    (provider as any).handleMessage({ command: 'addExpressions', expressions: ['motor', 'motor.speed', 'motor', ' counter中文 '],
      groupId: provider.activeGroupId, watchGeneration: provider.generation });
    expect(provider.expressionList).toEqual(['motor', 'motor.speed', 'counter']);
    expect(changed).toHaveBeenCalledOnce();
    expect(provider.generation).toBe(1);
  });
  it('cancels a pending picker opening after switching groups, and commits visible selections into their original group', async () => {
    const { provider, picker, saved } = createProvider();
    await (provider as any).openSymbolPicker();
    const request = (picker.open.mock.calls as any)[0][0];
    expect(request.canOpen()).toBe(true);
    provider.addGroup();
    expect(request.canOpen()).toBe(false);
    request.commit(['speed', 'count']);
    expect(provider.expressionList).toEqual([]);
    expect((saved.get('ozoneWatchGroups') as any).groups[0].expressions).toEqual(['speed', 'count']);
    provider.selectGroup('watch1');
    expect(provider.expressionList).toEqual(['speed', 'count']);
  });
  it('does not revive a deleted Watch group or add its selections into a reused group id', async () => {
    const { provider, picker } = createProvider();
    await (provider as any).openSymbolPicker();
    const request = (picker.open.mock.calls as any)[0][0];
    provider.addGroup(); provider.removeGroup('watch1'); provider.addGroup();
    expect(provider.activeGroupId).toBe('watch1');
    request.commit(['old']); expect(provider.expressionList).toEqual([]);
  });
  it('reopens the global picker with saved variables already checked', async () => {
    const { provider, picker } = createProvider();
    await (provider as any).openSymbolPicker();
    (picker.open.mock.calls as any)[0][0].commit(['speed']);
    await (provider as any).openSymbolPicker();
    expect((picker.open.mock.calls as any)[1][0].existing).toEqual(['speed']);
  });
  it('applies additions and unchecked existing variables once and preserves variables absent from the catalog', async () => {
    const { provider, picker, saved } = createProvider(undefined, { ozoneWatchExpressions: ['old', 'manual + 1'] });
    await (provider as any).openSymbolPicker();
    const changed = vi.fn(); provider.onExpressionsChanged = changed;
    (picker.open.mock.calls as any)[0][0].commit(['new'], ['old']);
    expect(provider.expressionList).toEqual(['manual + 1', 'new']);
    expect(saved.get('ozoneWatchExpressions')).toEqual(['manual + 1', 'new']);
    expect(changed).toHaveBeenCalledOnce(); expect(changed).toHaveBeenCalledWith(['manual + 1', 'new']);
    await (provider as any).openSymbolPicker();
    expect((picker.open.mock.calls as any)[1][0].existing).toEqual(['manual + 1', 'new']);
  });
  it('applies deselection only to the original Watch group after switching groups', async () => {
    const { provider, picker, saved } = createProvider(undefined, { ozoneWatchExpressions: ['old', 'keep'] });
    await (provider as any).openSymbolPicker();
    provider.addGroup(); provider.addExpression('old');
    const changed = vi.fn(); provider.onExpressionsChanged = changed;
    (picker.open.mock.calls as any)[0][0].commit([], ['old']);
    expect(provider.expressionList).toEqual(['old']); expect(changed).not.toHaveBeenCalled();
    expect((saved.get('ozoneWatchGroups') as any).groups[0].expressions).toEqual(['keep']);
  });
  it('renames only the label without resetting values, selection or polling generation', () => {
    const { provider, postMessage, saved } = createProvider();
    provider.addExpression('counter');
    const generation = provider.generation;
    const changed = vi.fn(); provider.onExpressionsChanged = changed;
    postMessage.mockClear();
    (provider as any).handleMessage({ command: 'renameGroup', id: 'watch1', name: '电机测试',
      groupId: 'watch1', watchGeneration: generation });
    expect(provider.activeGroupId).toBe('watch1');
    expect(provider.expressionList).toEqual(['counter']);
    expect(provider.generation).toBe(generation);
    expect(changed).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledOnce();
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      command: 'watchGroups', groups: [{ id: 'watch1', name: '电机测试' }],
    }));
    const restored = createProvider(undefined, Object.fromEntries(saved));
    (restored.provider as any).handleMessage({ command: 'init' });
    expect(restored.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      command: 'init', groups: [{ id: 'watch1', name: '电机测试' }],
    }));
  });
  it('migrates existing variables, selects only one group and persists its own expansion state', () => {
    const { provider, saved } = createProvider(undefined, {
      ozoneWatchExpressions: ['legacy'], ozoneWatchExpandedExpressions: ['legacy.child'],
    });
    const changed = vi.fn(); provider.onExpressionsChanged = changed;
    expect(provider.expressionList).toEqual(['legacy']);
    provider.addGroup();
    expect(provider.expressionList).toEqual([]);
    expect(provider.expandedExpressions).toEqual([]);
    provider.addExpression(' second中文 ');
    (provider as any).setExpandedExpressions(['second.child']);
    provider.selectGroup('watch1');
    expect(provider.expressionList).toEqual(['legacy']);
    expect(provider.expandedExpressions).toEqual(['legacy.child']);
    expect(changed).toHaveBeenLastCalledWith(['legacy']);
    provider.selectGroup('watch2');
    expect(provider.expressionList).toEqual(['second']);
    expect(provider.expandedExpressions).toEqual(['second.child']);
    expect(saved.get('ozoneWatchExpressions')).toEqual(['second']);
    const restored = createProvider(undefined, Object.fromEntries(saved)).provider;
    expect(restored.activeGroupId).toBe('watch2');
    expect(restored.expressionList).toEqual(['second']);
    restored.selectGroup('watch1');
    expect(restored.expressionList).toEqual(['legacy']);
  });

  it('deleting an inactive group does not reset active values or expressions', () => {
    const { provider, postMessage } = createProvider();
    provider.addExpression('first'); provider.addGroup(); provider.addExpression('second');
    const generation = provider.generation;
    postMessage.mockClear();
    provider.removeGroup('watch1');
    expect(provider.expressionList).toEqual(['second']);
    expect(provider.generation).toBe(generation);
    expect(postMessage).toHaveBeenCalledOnce();
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ command: 'watchGroups', activeGroupId: 'watch2' }));
    provider.removeGroup('watch2');
    expect(provider.activeGroupId).toBe('watch2');
  });

  it('deleting the selected group switches its polling list to the adjacent group', () => {
    const { provider } = createProvider();
    provider.addExpression('first'); provider.addGroup(); provider.addExpression('second');
    const changed = vi.fn(); provider.onExpressionsChanged = changed;
    provider.removeGroup('watch2');
    expect(provider.activeGroupId).toBe('watch1');
    expect(changed).toHaveBeenLastCalledWith(['first']);
  });

  it('rejects a stale edit, add, expansion and Timeline action from a previous group', () => {
    const { provider, backend } = createProvider();
    const source = { groupId: provider.activeGroupId, watchGeneration: provider.generation };
    provider.addGroup();
    const generation = provider.generation;
    provider.onSendToTimeline = vi.fn();
    for (const command of ['setWatchValue', 'addExpression', 'setExpandedExpressions', 'sendToTimeline']) {
      (provider as any).handleMessage({ command, ...source, expression: 'old', expressions: ['old'], value: 42 });
    }
    expect(provider.generation).toBe(generation);
    expect(provider.expressionList).toEqual([]);
    expect(provider.expandedExpressions).toEqual([]);
    expect(backend.execute).not.toHaveBeenCalled();
    expect(provider.onSendToTimeline).not.toHaveBeenCalled();
  });

  it('drops a pending group read even after switching away and back to the same group', async () => {
    const { provider, postMessage } = createProvider();
    provider.addExpression('counter');
    const pending = deferred<any>();
    vscodeState.activeDebugSession = { type: 'orbit', customRequest: vi.fn()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValue({ results: [{ expression: 'counter', value: 2 }] }) };
    const read = (provider as any).evaluateWatches(['counter']);
    provider.addGroup(); provider.selectGroup('watch1');
    await Promise.resolve();
    postMessage.mockClear();
    pending.resolve({ results: [{ expression: 'counter', value: 99 }] }); await read;
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('does not publish an old group write completion or restart its refresh', async () => {
    const pending = deferred<any>();
    const session = { type: 'orbit', customRequest: vi.fn(() => pending.promise) };
    vscodeState.activeDebugSession = session;
    const { provider, postMessage } = createProvider();
    const write = (provider as any).setWatchValue('counter', 42);
    provider.addGroup(); postMessage.mockClear();
    pending.resolve({ ok: true }); await write;
    expect(postMessage).not.toHaveBeenCalled();
    expect(session.customRequest).toHaveBeenCalledOnce();
  });

  it('fences extension polling results by group generation, including groups sharing an expression', () => {
    const { provider, postMessage } = createProvider();
    provider.addExpression('same'); const generation = provider.generation;
    provider.addGroup(); provider.addExpression('same'); postMessage.mockClear();
    provider.sendWatchResults([{ expression: 'same', value: 99 } as any], generation);
    expect(postMessage).not.toHaveBeenCalled();
    provider.sendWatchResults([{ expression: 'same', value: 2 } as any], provider.generation);
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      command: 'watchResults', groupId: 'watch2', watchGeneration: provider.generation,
    }));
  });

  it('reads only the selected group through the same DAP session', async () => {
    const { provider } = createProvider();
    provider.addExpression('first'); provider.addGroup(); provider.addExpression('second');
    const session = { type: 'orbit', customRequest: vi.fn().mockResolvedValue({ results: [] }) };
    vscodeState.activeDebugSession = session;
    provider.selectGroup('watch1'); await Promise.resolve();
    provider.selectGroup('watch2'); await Promise.resolve();
    expect(session.customRequest.mock.calls).toEqual([
      ['dataSample', { expressions: ['first'], expandedExpressions: [] }],
      ['dataSample', { expressions: ['second'], expandedExpressions: [] }],
    ]);
  });

  it('does not reuse data or accept stale edits when a deleted group number is reused', async () => {
    const { provider, postMessage } = createProvider();
    provider.addGroup(); provider.addExpression('counter');
    const oldContext = { groupId: provider.activeGroupId, watchGeneration: provider.generation };
    const pending = deferred<any>();
    const session = { type: 'orbit', customRequest: vi.fn()
      .mockImplementationOnce(() => pending.promise).mockResolvedValue({ results: [] }) };
    vscodeState.activeDebugSession = session;
    const oldRead = (provider as any).evaluateWatches(['counter']);
    provider.removeGroup('watch2'); provider.addGroup();
    expect(provider.activeGroupId).toBe('watch2');
    expect(provider.expressionList).toEqual([]);
    expect(provider.expandedExpressions).toEqual([]);
    provider.addExpression('counter'); await Promise.resolve();
    postMessage.mockClear();
    pending.resolve({ results: [{ expression: 'counter', value: 99 }] }); await oldRead;
    expect(postMessage).not.toHaveBeenCalled();
    (provider as any).handleMessage({ command: 'setWatchValue', ...oldContext, expression: 'counter', value: 99 });
    expect(session.customRequest).toHaveBeenCalledTimes(2);
    expect(session.customRequest.mock.calls.every(call => call[0] === 'dataSample')).toBe(true);
  });
});

describe('WatchWebviewProvider session fence', () => {
  it('does not publish a dataSample result from a replaced DAP session', async () => {
    const pending = deferred<any>();
    const firstSession = {
      type: 'orbit',
      customRequest: vi.fn(() => pending.promise),
    };
    const secondSession = { type: 'orbit', customRequest: vi.fn() };
    let currentSession: any = firstSession;
    vscodeState.activeDebugSession = firstSession;
    const { provider, postMessage } = createProvider(session => currentSession === session);

    const evaluating = (provider as any).evaluateWatches(['counter']);
    currentSession = secondSession;
    vscodeState.activeDebugSession = secondSession;
    pending.resolve({
      results: [{ expression: 'counter', value: 41, display: '41', hex: '0x29' }],
    });
    await evaluating;

    expect(postMessage).not.toHaveBeenCalled();
  });

  it('does not publish a setWatchValue result from a terminated DAP session', async () => {
    const pending = deferred<any>();
    const session = {
      type: 'orbit',
      customRequest: vi.fn(() => pending.promise),
    };
    let currentSession: any = session;
    vscodeState.activeDebugSession = session;
    const { provider, postMessage } = createProvider(candidate => currentSession === candidate);

    const writing = (provider as any).setWatchValue('counter', 42, 0x20000000, 'uint32_t');
    currentSession = null;
    vscodeState.activeDebugSession = undefined;
    pending.resolve({ ok: true });
    await writing;

    expect(postMessage).not.toHaveBeenCalled();
  });
});
