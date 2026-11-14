import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { TimelineRecordStore } from '../../timeline/timeline-store';
import { createTimelineEntry } from './timeline-entry-state';
import { DEFAULT_TIMELINE_VIEW } from '../../timeline/timeline-model';

const state = vi.hoisted(() => ({ session: undefined as any, start: undefined as any, terminate: undefined as any, openPath: '', messages: [] as any[], folders: [] as any[], warning: vi.fn(), info: vi.fn(), saveDialog: vi.fn(), quickPick: vi.fn() }));
vi.mock('vscode', () => ({
  debug: { get activeDebugSession() { return state.session; }, onDidStartDebugSession: (cb: any) => { state.start = cb; return { dispose() {} }; }, onDidTerminateDebugSession: (cb: any) => { state.terminate = cb; return { dispose() {} }; } },
  Uri: { file: (p: string) => ({ fsPath: p }), joinPath: (...p: any[]) => p.join('/') },
  ProgressLocation: { Notification: 1 },
  workspace: { get workspaceFolders() { return state.folders; }, getWorkspaceFolder: (uri: any) => state.folders.find(f => uri.fsPath.startsWith(f.uri.fsPath + path.sep)) },
  window: { showWarningMessage: state.warning, showErrorMessage: vi.fn(), showInformationMessage: state.info, showSaveDialog: state.saveDialog, showQuickPick: state.quickPick, showOpenDialog: async () => [{ fsPath: state.openPath }], withProgress: async (_o: any, run: any) => run({}, { onCancellationRequested: () => ({ dispose() {} }) }) },
}));
import { TimelineWebviewProvider } from './timeline-provider';

let base: string, provider: TimelineWebviewProvider, manager: any, saved: Map<string, any>, picker: any;
beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-tabs-'));
  state.messages = []; state.session = undefined; state.warning.mockReset();
  state.info.mockReset(); state.saveDialog.mockReset(); state.quickPick.mockReset();
  state.folders = [{ name: '工程', uri: { fsPath: path.join(base, 'project'), scheme: 'file' } }];
  saved = new Map([['ozoneTimelineState', { ...DEFAULT_TIMELINE_VIEW, entries: [createTimelineEntry({ expression: 'live_motor', color: '#ABCDEF', yPerDiv: 20 })] }]]);
  manager = { entriesList: [{ expression: 'live_motor', color: '#123456', enabled: true }], setColor: vi.fn((expression: string, color: string) => { manager.entriesList.find((e: any) => e.expression === expression).color = color; }), setExpressions: vi.fn((entries: any[]) => { manager.entriesList = entries.map(e => ({ ...e, enabled: true })); }), setSamplingExpressions: vi.fn(), setRetainHistory: vi.fn(), clearData: vi.fn(), setOnSamples: (cb: any) => { manager.samples = cb; }, addExpression: vi.fn(), removeExpression: vi.fn(), toggleExpression: vi.fn() };
  const context = { workspaceState: { get: (key: string) => saved.get(key), update: async (key: string, value: any) => { saved.set(key, structuredClone(value)); } }, globalStorageUri: { fsPath: base }, subscriptions: [], extensionUri: '' };
  picker = { open: vi.fn(async () => {}) };
  provider = new TimelineWebviewProvider(context as any, manager, undefined, picker);
  (provider as any).view = { visible: true, webview: { postMessage: (msg: any) => state.messages.push(structuredClone(msg)) } };
});
afterEach(async () => { vi.useRealTimers(); await provider.dispose(); await fs.rm(base, { recursive: true, force: true }); });
async function imported() {
  const store = new TimelineRecordStore(base, 'CSV 历史');
  store.view = { ...structuredClone(DEFAULT_TIMELINE_VIEW), entries: [createTimelineEntry({ expression: 'csv_voltage', color: '#FF0000', yPerDiv: 5 })] };
  store.syncChannels(store.view.entries);
  store.append([{ expression: 'csv_voltage', color: '#FF0000', currentValue: '12', data: [{ timestamp: 1700000000000, value: 12, display: '12' }, { timestamp: 1700000000001, value: 13, display: '13' }] }]);
  state.openPath = path.join(base, 'history.csv'); await store.save(state.openPath, null, store.view); await store.dispose();
  await (provider as any).handleMessage({ command: 'openCsv' });
  return state.messages.filter(m => m.command === 'activate').at(-1);
}
function debugStart() { void (provider as any).handleMessage({ command: 'setSamplingEnabled', tabId: 'timeline1', enabled: true }); state.session = { id: 'new', name: '新调试', type: 'orbit' }; state.start(state.session); return (provider as any).tabs.get('timeline1'); }

describe('Timeline record and debug configuration isolation', () => {
  it('starts with sampling unchecked and gates recording immediately when the group is toggled', async () => {
    state.session = { id: 'disabled', name: '调试', type: 'orbit' }; state.start(state.session);
    const tab = (provider as any).tabs.get('timeline1');
    const samples = [{ expression: 'live_motor', color: '#ABCDEF', currentValue: '1', data: [{ timestamp: 1000, value: 1, display: '1' }] }];
    manager.samples(samples);
    expect(tab.info.samplingEnabled).toBe(false);
    expect(tab.store).toBeUndefined();
    expect(manager.setSamplingExpressions).toHaveBeenLastCalledWith([]);
    await (provider as any).handleMessage({ command: 'setSamplingEnabled', tabId: 'timeline1', enabled: true });
    manager.samples(samples);
    expect(tab.store.acceptedRows).toBe(1);
    expect(manager.setSamplingExpressions).toHaveBeenLastCalledWith(['live_motor']);
    await (provider as any).handleMessage({ command: 'setSamplingEnabled', tabId: 'timeline1', enabled: false });
    manager.samples(samples);
    expect(tab.store.acceptedRows).toBe(1);
    expect(manager.setSamplingExpressions).toHaveBeenLastCalledWith([]);
  });

  it('records checked groups independently and shares duplicate expressions through one sampler', async () => {
    const first = debugStart();
    await (provider as any).handleMessage({ command: 'addGroup' });
    const second = (provider as any).tabs.get('timeline2');
    provider.addExpressions(['live_motor', 'second']);
    expect(second.info.samplingEnabled).toBe(false);
    await (provider as any).handleMessage({ command: 'setSamplingEnabled', tabId: 'timeline2', enabled: true });
    expect(manager.entriesList.map((entry: any) => entry.expression)).toEqual(['live_motor', 'second']);
    const samples = ['live_motor', 'second'].map(expression => ({ expression, color: '#123456', currentValue: '1', data: [{ timestamp: 1000, value: 1, display: '1' }] }));
    manager.samples(samples);
    expect(first.store.acceptedRows).toBe(1);
    expect(second.store.acceptedRows).toBe(2);
    await (provider as any).handleMessage({ command: 'setSamplingEnabled', tabId: 'timeline2', enabled: false });
    manager.samples(samples.map(snapshot => ({ ...snapshot, data: [{ timestamp: 1010, value: 2, display: '2' }] })));
    expect(first.store.acceptedRows).toBe(2);
    expect(second.store.acceptedRows).toBe(2);
    expect(manager.setSamplingExpressions).toHaveBeenLastCalledWith(['live_motor']);
    await (provider as any).handleMessage({ command: 'selectTab', tabId: 'timeline2' });
    expect(second.info.samplingEnabled).toBe(false);
  });

  it('restores group names, order, selection, checkboxes, and variables after reload', async () => {
    await (provider as any).handleMessage({ command: 'addGroup' });
    provider.addExpressions(['second']);
    await (provider as any).handleMessage({ command: 'renameGroup', tabId: 'timeline2', name: '  云台  ' });
    await (provider as any).handleMessage({ command: 'setSamplingEnabled', tabId: 'timeline2', enabled: true });
    await (provider as any).handleMessage({ command: 'reorderGroup', tabId: 'timeline2', index: 0 });
    const groups = saved.get('ozoneTimelineGroups');
    expect(groups.groups.map((group: any) => group.id)).toEqual(['timeline2', 'timeline1']);
    await provider.dispose();
    const context = { workspaceState: { get: (key: string) => saved.get(key), update: async (key: string, value: any) => { saved.set(key, structuredClone(value)); } }, subscriptions: [] };
    provider = new TimelineWebviewProvider(context as any, manager);
    expect((provider as any).activeId).toBe('timeline2');
    expect([...((provider as any).tabs.keys())]).toEqual(['timeline2', 'timeline1']);
    const tab = (provider as any).tabs.get('timeline2');
    expect(tab.info).toMatchObject({ name: '云台', samplingEnabled: true, recordId: '' });
    expect(tab.view.entries.map((entry: any) => entry.expression)).toEqual(['second']);
  });

  it('stops a removed group and rejects a picker commit after its identifier is reused', async () => {
    await (provider as any).handleMessage({ command: 'addGroup' });
    provider.addExpressions(['second']);
    await (provider as any).handleMessage({ command: 'openSymbolPicker', tabId: 'timeline2', recordId: '' });
    const request = picker.open.mock.calls[0][0];
    await (provider as any).handleMessage({ command: 'setSamplingEnabled', tabId: 'timeline2', enabled: true });
    await (provider as any).handleMessage({ command: 'closeTab', tabId: 'timeline2' });
    expect(manager.setSamplingExpressions).toHaveBeenLastCalledWith([]);
    await (provider as any).handleMessage({ command: 'addGroup' });
    request.commit(['stale']);
    expect((provider as any).tabs.get('timeline2').view.entries).toEqual([]);
  });

  it('marks every channel after a restart even when their first samples arrive in separate batches', async () => {
    const tab = debugStart(); provider.addExpressions(['aux']);
    manager.samples(['live_motor', 'aux'].map(expression => ({ expression, color: '#123456', currentValue: '1', data: [{ timestamp: 1000, value: 1, display: '1' }] })));
    state.terminate(state.session);
    state.session = { id: 'next', name: '下一次', type: 'orbit' }; state.start(state.session);
    manager.samples([{ expression: 'live_motor', color: '#123456', currentValue: '2', data: [{ timestamp: 2000, value: 2, display: '2' }] }]);
    manager.samples([{ expression: 'aux', color: '#123456', currentValue: '3', data: [{ timestamp: 2001, value: 3, display: '3' }] }]);
    const aux = (await tab.store.query(0, 2000, 100, true)).find((snapshot: any) => snapshot.expression === 'aux');
    expect(aux.data[1]).toMatchObject({ startsNewSegment: true, segmentId: 2 });
    expect(tab.store.meta.debugSessions).toHaveLength(2);
  });
  it('preserves saved variable order on sampler refresh and new debug records', async () => {
    manager.entriesList.push({ expression: 'second', color: '#654321', enabled: true });
    provider.refreshEntries();
    const entries = [...(provider as any).tabs.get('timeline1').view.entries].reverse();
    await (provider as any).handleMessage({
      command: 'saveState', tabId: 'timeline1', recordId: '',
      state: { ...DEFAULT_TIMELINE_VIEW, entries },
    });
    manager.entriesList.push({ expression: 'added', color: '#abcdef', enabled: true });
    provider.refreshEntries();
    expect((provider as any).tabs.get('timeline1').view.entries.map((entry: any) => entry.expression)).toEqual(['second', 'live_motor', 'added']);
    const live = debugStart();
    expect(live.view.entries.map((entry: any) => entry.expression)).toEqual(['second', 'live_motor', 'added']);
    expect(saved.get('ozoneTimelineState').entries.map((entry: any) => entry.expression)).toEqual(['second', 'live_motor', 'added']);
  });

  it('does not restart the sampler when only the variable display order changes', async () => {
    provider.addExpressions(['second']);
    const before = manager.setExpressions.mock.calls.length;
    const tab = (provider as any).tabs.get('timeline1');
    await (provider as any).handleMessage({ command: 'saveState', tabId: tab.info.id, recordId: tab.info.recordId,
      state: { ...tab.view, entries: [...tab.view.entries].reverse() } });
    expect(manager.setExpressions).toHaveBeenCalledTimes(before);
    expect(tab.view.entries.map((entry: any) => entry.expression)).toEqual(['second', 'live_motor']);
  });

  it('submits a group symbol multi-selection to the sampler as one batch', async () => {
    const before = manager.setExpressions.mock.calls.length;
    await (provider as any).handleMessage({ command: 'addExpressions', tabId: 'timeline1', recordId: '', expressions: ['speed', 'count', null] });
    expect(manager.setExpressions).toHaveBeenCalledTimes(before + 1);
    expect(manager.entriesList.map((entry: any) => entry.expression)).toEqual(['live_motor', 'speed', 'count']);
    expect(manager.setSamplingExpressions).toHaveBeenLastCalledWith([]);
  });
  it('browses recorded channels without a live DAP session or changing the sampler', async () => {
    const live = debugStart();
    state.terminate(state.session); state.session = undefined;
    state.messages = [];
    await (provider as any).handleMessage({ command: 'openSymbolPicker', tabId: live.info.id, recordId: live.info.recordId });
    const request = picker.open.mock.calls[0][0];
    expect(await request.loadCatalog()).toMatchObject({
      source: 'recording', roots: [expect.objectContaining({ expression: 'live_motor', file: '当前记录' })],
    });
    expect(manager.entriesList.map((entry: any) => entry.expression)).toEqual(['live_motor']);
  });
  it('cancels pending shared picker opening after tab reactivation', async () => {
    const live = debugStart();
    await (provider as any).handleMessage({ command: 'openSymbolPicker', tabId: live.info.id, recordId: live.info.recordId });
    const request = picker.open.mock.calls[0][0];
    expect(request.canOpen()).toBe(true);
    await (provider as any).handleMessage({ command: 'selectTab', tabId: live.info.id });
    expect(request.canOpen()).toBe(false);
  });
  it('keeps the same editable group available after stop and applies picker additions to that group', async () => {
    const live = debugStart();
    await (provider as any).handleMessage({ command: 'openSymbolPicker', tabId: live.info.id, recordId: live.info.recordId });
    const request = picker.open.mock.calls[0][0];
    state.terminate(state.session); state.session = undefined;
    request.commit(['next_session_variable']);
    expect((provider as any).tabs.get('timeline1')).toBe(live);
    expect(live.view.entries.map((entry: any) => entry.expression)).toEqual(['live_motor', 'next_session_variable']);
    expect(saved.get('ozoneTimelineGroups').groups[0].view.entries.map((entry: any) => entry.expression)).toEqual(['live_motor', 'next_session_variable']);
  });
  it('applies picker additions and removals in one sampler batch and refreshes saved debug entries', async () => {
    const before = manager.setExpressions.mock.calls.length;
    await (provider as any).handleMessage({ command: 'openSymbolPicker', tabId: 'timeline1', recordId: '' });
    picker.open.mock.calls[0][0].commit(['speed'], ['live_motor']);
    expect(manager.setExpressions).toHaveBeenCalledTimes(before + 1);
    expect(saved.get('ozoneDataSamplingExpressions').map((entry: any) => entry.expression)).toEqual(['speed']);
  });
  it('hides unchecked historical channels without deleting recorded data or changing the sampler', async () => {
    const csv = await imported();
    await (provider as any).handleMessage({ command: 'openSymbolPicker', tabId: csv.tab.id, recordId: csv.tab.recordId });
    const request = picker.open.mock.calls[0][0];
    expect(request.existing).toEqual(['csv_voltage']); request.commit([], ['csv_voltage']);
    const tab = (provider as any).tabs.get(csv.tab.id);
    expect(tab.view.entries[0]).toMatchObject({ expression: 'csv_voltage', enabled: false, color: '#FF0000', yPerDiv: 5 });
    expect(tab.store.channels).toHaveLength(1); expect(tab.store.acceptedRows).toBe(2);
    expect(state.messages.filter(m => m.command === 'entries').at(-1).entries[0].enabled).toBe(false);
    await (provider as any).handleMessage({ command: 'openSymbolPicker', tabId: csv.tab.id, recordId: csv.tab.recordId });
    const reopened = picker.open.mock.calls[1][0]; expect(reopened.existing).toEqual([]);
    reopened.commit(['csv_voltage']); expect(tab.view.entries[0].enabled).toBe(true);
    expect(manager.removeExpression).not.toHaveBeenCalled(); expect(manager.addExpression).not.toHaveBeenCalled();
    expect(manager.setExpressions).toHaveBeenCalledTimes(1);
  });
  it('updates template colors without reactivating and unmounting the color picker', async () => {
    await (provider as any).handleMessage({ command: 'init' });
    state.messages = [];
    for (const color of ['#569CD6', '#123456', '#42D9F3']) {
      await (provider as any).handleMessage({
        command: 'setColor', tabId: 'timeline1', recordId: '', expression: 'live_motor', color,
      });
      expect(state.messages.filter(m => m.command === 'activate')).toHaveLength(0);
      expect(state.messages.filter(m => m.command === 'entries').at(-1)).toMatchObject({
        tabId: 'timeline1', recordId: '', entries: [expect.objectContaining({ expression: 'live_motor', color })],
      });
      expect(saved.get('ozoneDataSamplingExpressions')).toEqual([{ expression: 'live_motor', color }]);
    }
  });

  it('pushes a resolution-tagged live tail while recording all raw samples', async () => {
    const live = debugStart();
    const input = { expression: 'live_motor', color: '#ABCDEF', currentValue: '99', data: Array.from({ length: 100 }, (_, index) => ({ timestamp: 1700000000000 + index, value: index === 45 ? 500 : index, display: String(index) })) };
    manager.samples([{ ...input, data: input.data.slice(0, 1) }]);
    expect(state.messages.filter(m => m.command === 'samples').at(-1).snapshots).toEqual([]);
    await (provider as any).handleMessage({ command: 'loadRange', tabId: live.info.id, recordId: live.info.recordId, requestId: 1, generation: 7, resolutionKey: 100, targetBuckets: 1, start: 0, end: 0 });
    manager.samples([{ ...input, data: input.data.slice(1) }]);
    const pushed = state.messages.filter(m => m.command === 'samples').at(-1);
    expect(pushed).toMatchObject({ generation: 7, resolutionKey: 100, tabId: live.info.id, recordId: live.info.recordId });
    expect(pushed.snapshots[0].data.map((point: any) => point.timestamp)).toEqual([1, 45, 99]);
    expect(live.store.acceptedRows).toBe(100);
    const [raw] = await live.store.query(0, 99, 1, true);
    expect(raw.data).toHaveLength(100);
    expect(raw.data[45].value).toBe(500);
  });

  it('continues the same group and record across debug sessions with explicit disconnected segments', async () => {
    const first = debugStart();
    manager.samples([{ expression: 'live_motor', color: '#ABCDEF', currentValue: '5', data: [1000, 1010].map(timestamp => ({ timestamp, value: 5, display: '5' })) }]);
    const recordId = first.info.recordId;
    state.terminate(state.session);
    state.session = { id: 'second', name: '第二轮', type: 'orbit' };
    state.messages = [];
    state.start(state.session);
    manager.samples([{ expression: 'live_motor', color: '#ABCDEF', currentValue: '6', data: [0, 10].map(timestamp => ({ timestamp, value: 6, display: '6' })) }]);
    expect((provider as any).tabs.get('timeline1')).toBe(first);
    expect((provider as any).tabs.size).toBe(1);
    expect(first.info.recordId).toBe(recordId);
    expect(first.store.acceptedRows).toBe(4);
    expect(first.store.meta.debugSessions).toMatchObject([{ name: '新调试', startMs: 0 }, { name: '第二轮', startMs: 11 }]);
    const data = (await first.store.query(0, 100, 100, true))[0].data;
    expect(data.map((point: any) => point.timestamp)).toEqual([0, 10, 11, 21]);
    expect(data[2].startsNewSegment).toBe(true);
    expect(state.messages.filter(message => message.command === 'activate')).toHaveLength(0);
  });
  it('delivers real rangeSamples replies from an initially empty live record', async () => {
    const live = debugStart();
    const request = { command: 'loadRange', tabId: live.info.id, recordId: live.info.recordId, requestId: 1, generation: 1, resolutionKey: 1, targetBuckets: 20, start: 0, end: 20 };
    state.messages = [];
    await (provider as any).handleMessage(request);
    expect(state.messages.at(-1)).toMatchObject({ command: 'rangeSamples', range: null, snapshots: [] });
    manager.samples([{ expression: 'live_motor', color: '#ABCDEF', currentValue: '6', data: [
      { timestamp: 1700000000100, value: 5, display: '5' },
      { timestamp: 1700000000110, value: 6, display: '6' },
    ] }]);
    expect(state.messages.at(-1)).toMatchObject({ command: 'samples', historyBounds: { start: 0, end: 10 } });
    expect(state.messages.at(-1)).toMatchObject({ sampleRateHz: 100, generation: 1, resolutionKey: 1 });
    expect(state.messages.at(-1).snapshots[0].data.map((point: any) => point.timestamp)).toEqual([0, 10]);
    await (provider as any).handleMessage({ ...request, requestId: 2 });
    const reply = state.messages.at(-1);
    expect(reply).toMatchObject({ command: 'rangeSamples', tabId: live.info.id, recordId: live.info.recordId, requestId: 2, generation: 1, range: { start: 0, end: 10 } });
    expect(reply.snapshots[0].data.map((p: any) => p.value)).toEqual([5, 6]);
    expect(reply.snapshots[0].data.map((p: any) => p.timestamp)).toEqual([0, 10]);
  });
  it('inherits saved debug variables/colors and changes the entire left list on tab switch', async () => {
    const csv = await imported(); const live = debugStart();
    expect((provider as any).activeId).toBe(csv.tab.id);
    expect(live.view.entries[0].expression).toBe('live_motor'); expect(live.view.entries[0].color).toBe('#ABCDEF');
    await (provider as any).handleMessage({ command: 'selectTab', tabId: live.info.id });
    const active = state.messages.filter(m => m.command === 'activate').at(-1);
    expect(active.entries.map((e: any) => e.expression)).toEqual(['live_motor']);
    await (provider as any).handleMessage({ command: 'selectTab', tabId: csv.tab.id });
    expect(state.messages.filter(m => m.command === 'activate').at(-1).entries[0].expression).toBe('csv_voltage');
  });
  it('CSV view/color edits cannot update debug defaults or sampler operations', async () => {
    const csv = await imported();
    const view = { ...DEFAULT_TIMELINE_VIEW, entries: [createTimelineEntry({ expression: 'csv_voltage', color: '#00FF00' })] };
    await (provider as any).handleMessage({ command: 'saveState', tabId: csv.tab.id, recordId: csv.tab.recordId, state: view });
    await (provider as any).handleMessage({ command: 'setColor', tabId: csv.tab.id, recordId: csv.tab.recordId, expression: 'live_motor', color: '#000000' });
    await (provider as any).handleMessage({ command: 'addExpression', tabId: csv.tab.id, recordId: csv.tab.recordId, expression: 'csv_variable' });
    expect(saved.get('ozoneTimelineState').entries[0].color).toBe('#ABCDEF');
    expect(manager.addExpression).not.toHaveBeenCalled(); expect(manager.setColor).not.toHaveBeenCalled(); expect(manager.setExpressions).toHaveBeenCalledTimes(1);
    const live = debugStart(); expect(live.view.entries[0].color).toBe('#ABCDEF');
  });
  it('records hidden live samples without appending or publishing into imported history', async () => {
    const csv = await imported(); const live = debugStart();
    await (provider as any).handleMessage({ command: 'selectTab', tabId: csv.tab.id }); state.messages = [];
    manager.samples([{ expression: 'live_motor', color: '#ABCDEF', currentValue: '5', data: [{ timestamp: 1700000000100, value: 5, display: '5' }] }]);
    expect(live.store.acceptedRows).toBe(1);
    expect((provider as any).tabs.get(csv.tab.id).store.acceptedRows).toBe(2);
    expect(state.messages.filter(m => m.command === 'samples')).toHaveLength(0);
    state.terminate(state.session); expect(live.info.running).toBe(false);
    state.session = { id: 'next', name: '下一次', type: 'orbit' }; state.start(state.session);
    expect((provider as any).tabs.get('timeline1')).toBe(live);
    expect((provider as any).activeId).toBe(csv.tab.id);
  });
  it('adding a recorded variable on history only changes that page and never starts debug sampling', async () => {
    const csv = await imported();
    const tab = (provider as any).tabs.get(csv.tab.id);
    const defaults = structuredClone(saved.get('ozoneTimelineState'));
    tab.view.entries = [];
    tab.store.channels.find((c: any) => c.expression === 'csv_voltage').enabled = false;
    await (provider as any).handleMessage({ command: 'addExpression', tabId: csv.tab.id, recordId: csv.tab.recordId, expression: 'csv_voltage' });
    expect(tab.view.entries.map((e: any) => e.expression)).toEqual(['csv_voltage']);
    expect(tab.view.entries[0].enabled).toBe(true);
    expect(state.messages.at(-1)).toMatchObject({ command: 'entries', tabId: csv.tab.id });
    tab.view.entries[0].enabled = false;
    await (provider as any).handleMessage({ command: 'addExpression', tabId: csv.tab.id, recordId: csv.tab.recordId, expression: 'csv_voltage' });
    expect(tab.view.entries).toHaveLength(1);
    expect(tab.view.entries[0].enabled).toBe(true);
    await (provider as any).handleMessage({ command: 'addExpression', tabId: csv.tab.id, recordId: csv.tab.recordId, expression: 'live_motor' });
    expect(tab.view.entries.map((e: any) => e.expression)).toEqual(['csv_voltage']);
    expect(manager.addExpression).not.toHaveBeenCalled();
    expect(saved.get('ozoneTimelineState')).toEqual(defaults);
  });
  it('rejects stale range replies after switching tabs before bounds or data are sent', async () => {
    const csv = await imported(); const live = debugStart();
    await (provider as any).handleMessage({ command: 'selectTab', tabId: csv.tab.id });
    const tab = (provider as any).tabs.get(csv.tab.id);
    let resolve!: (value: any) => void;
    tab.store.query = () => new Promise(r => { resolve = r; });
    const pending = (provider as any).handleMessage({ command: 'loadRange', tabId: csv.tab.id, recordId: csv.tab.recordId, requestId: 1, generation: 1, resolutionKey: 1, targetBuckets: 20, start: 0, end: 1 });
    await (provider as any).handleMessage({ command: 'selectTab', tabId: live.info.id }); state.messages = [];
    resolve([]); await pending;
    expect(state.messages.filter(m => m.command === 'rangeSamples')).toHaveLength(0);
  });
  it('continues the existing debug group while hidden without revealing or remounting the Timeline panel', async () => {
    const previous = debugStart();
    state.terminate(state.session);
    const show = vi.fn();
    (provider as any).view.visible = false;
    (provider as any).view.show = show;
    state.messages = [];
    const live = debugStart();
    expect(live).toBe(previous);
    expect((provider as any).activeId).toBe(live.info.id);
    expect(state.messages.filter(message => message.command === 'activate')).toHaveLength(0);
    expect(show).not.toHaveBeenCalled();
    manager.samples([{ expression: 'live_motor', color: '#ABCDEF', currentValue: '5', data: [{ timestamp: 1700000000100, value: 5, display: '5' }] }]);
    expect(live.store.acceptedRows).toBe(1);
    expect(state.messages.filter(message => message.command === 'samples')).toHaveLength(0);
  });
  it('discards unsaved records on reload while retaining debug variables and colors', async () => {
    const live = debugStart();
    manager.samples([{ expression: 'live_motor', color: '#ABCDEF', currentValue: '5', data: [{ timestamp: 1700000000100, value: 5, display: '5' }] }]);
    const cache = (provider as any).directory;
    await live.store.flush();
    expect(await fs.stat(live.store.csvPath)).toBeTruthy();
    expect(await fs.stat(path.join(state.folders[0].uri.fsPath, '.vscode', 'timeline')).catch(() => null)).toBeNull();
    // Even stale descriptors from the old automatic-save implementation are ignored.
    saved.set('ozoneTimelineOpenRecords', { activeId: live.info.id, records: [{ tab: live.info, descriptor: live.store.getDescriptor(), view: live.view }] });
    await provider.dispose(); state.session = undefined;
    expect(await fs.stat(cache).catch(() => null)).toBeNull();
    const context = { workspaceState: { get: (key: string) => saved.get(key), update: async (key: string, value: any) => { saved.set(key, structuredClone(value)); } }, globalStorageUri: { fsPath: base }, subscriptions: [], extensionUri: '' };
    provider = new TimelineWebviewProvider(context as any, manager);
    (provider as any).view = { visible: true, webview: { postMessage: (msg: any) => state.messages.push(structuredClone(msg)) } };
    await (provider as any).handleMessage({ command: 'init' });
    expect((provider as any).tabs.get(live.info.id).store).toBeUndefined();
    expect((provider as any).tabs.get(live.info.id).info.recordId).toBe('');
    expect((provider as any).tabs.size).toBe(1);
    expect(saved.get('ozoneTimelineOpenRecords')).toBeUndefined();
    const template = (provider as any).tabs.get('timeline1');
    expect(template.view.entries[0]).toMatchObject({ expression: 'live_motor', color: '#ABCDEF' });
  });
  it('keeps the final group and its data available after the debug session ends', async () => {
    const live = debugStart();
    await (provider as any).handleMessage({ command: 'closeTab', tabId: live.info.id });
    expect((provider as any).tabs.has(live.info.id)).toBe(true);
    manager.samples([{ expression: 'live_motor', color: '#ABCDEF', currentValue: '5', data: [0, 10, 30].map(timestamp => ({ timestamp, value: 5, display: '5' })) }]);
    state.terminate(state.session);
    expect(live.info).toMatchObject({ kind: 'live', running: false });
    expect(state.messages.find(message => message.command === 'sampleRate' && message.tabId === live.info.id)).toMatchObject({
      recordId: live.info.recordId, sampleRateHz: 0, averageSampleRateHz: 2 * 1000 / 30,
    });
    await (provider as any).handleMessage({ command: 'selectTab', tabId: live.info.id });
    expect(state.messages.filter(message => message.command === 'activate').at(-1)).toMatchObject({
      tab: { kind: 'live', running: false }, averageSampleRateHz: 2 * 1000 / 30,
    });
    expect(await fs.stat(path.join(state.folders[0].uri.fsPath, '.vscode', 'timeline')).catch(() => null)).toBeNull();
  });
  it('defaults manual saves to the debug workspace and session start time, including fresh records', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const started = new Date(2026, 9, 4, 13, 37, 48, 123);
    vi.setSystemTime(started);
    const second = { name: '调试工程', uri: { fsPath: path.join(base, 'second-project'), scheme: 'file' } };
    state.folders.push(second);
    state.session = { id: 'new', name: '调试名称不作为文件名', type: 'orbit', workspaceFolder: second };
    await (provider as any).handleMessage({ command: 'setSamplingEnabled', tabId: 'timeline1', enabled: true });
    state.start(state.session);
    let live = (provider as any).tabs.get('timeline1');
    vi.setSystemTime(new Date(2026, 9, 4, 13, 39, 0));
    manager.samples([{ expression: 'live_motor', color: '#ABCDEF', currentValue: '5', data: [{ timestamp: Date.now(), value: 5, display: '5' }] }]);
    const destination = path.join(second.uri.fsPath, '.vscode', 'timeline', '2026-10-04_13-37-48-123.csv');
    state.saveDialog.mockImplementation(async (options: any) => options.defaultUri);
    await (provider as any).handleMessage({ command: 'saveCsv', tabId: live.info.id, recordId: live.info.recordId, scope: 'all' });
    expect(state.saveDialog.mock.calls[0][0].defaultUri.fsPath).toBe(destination);
    const content = await fs.readFile(destination, 'utf8');
    expect(content).toContain('"debugStartedAtUtc":"' + started.toISOString() + '"');
    expect(content).toContain('0,0,5,1');
    await (provider as any).handleMessage({ command: 'clearData', tabId: live.info.id, recordId: live.info.recordId });
    live = (provider as any).tabs.get('timeline1');
    // Cancel the second save: neither a new timestamp nor an automatic archive is created.
    state.saveDialog.mockResolvedValue(undefined);
    await (provider as any).handleMessage({ command: 'saveCsv', tabId: live.info.id, recordId: live.info.recordId, scope: 'all' });
    expect(state.saveDialog.mock.calls[1][0].defaultUri.fsPath).toBe(destination);
    expect(await fs.readdir(path.dirname(destination))).toEqual([path.basename(destination)]);
    await provider.dispose();
    expect(await fs.readFile(destination, 'utf8')).toBe(content);
  });
  it('saves the captured record if a fresh record begins while the save dialog is open', async () => {
    const tab = debugStart();
    manager.samples([{ expression: 'live_motor', color: '#ABCDEF', currentValue: '5', data: [{ timestamp: 1000, value: 5, display: '5' }] }]);
    const oldStore = tab.store;
    const destination = path.join(base, 'captured.csv');
    let choose!: (uri: any) => void;
    state.saveDialog.mockImplementation(() => new Promise(resolve => { choose = resolve; }));
    const saving = (provider as any).handleMessage({ command: 'saveCsv', tabId: tab.info.id, recordId: tab.info.recordId, scope: 'all' });
    await vi.waitFor(() => expect(state.saveDialog).toHaveBeenCalledOnce());
    await (provider as any).handleMessage({ command: 'clearData', tabId: tab.info.id, recordId: tab.info.recordId });
    expect(tab.store).not.toBe(oldStore);
    manager.samples([{ expression: 'live_motor', color: '#ABCDEF', currentValue: '6', data: [{ timestamp: 2000, value: 6, display: '6' }] }]);
    choose({ fsPath: destination }); await saving;
    const restored = await TimelineRecordStore.open(base, destination);
    try {
      const samples = await restored.query(0, 100, 100, true);
      expect(samples[0].data.map(point => point.value)).toEqual([5]);
    } finally { await restored.dispose(); }
  });
  it('recovers only CSV files in workspace .vscode/timeline and keeps imported source files', async () => {
    const csv = await imported();
    const directory = path.join(state.folders[0].uri.fsPath, '.vscode', 'timeline');
    await fs.mkdir(directory, { recursive: true });
    const destination = path.join(directory, '2026-10-04_13-37-48-123.csv');
    await fs.copyFile(state.openPath, destination);
    await fs.writeFile(path.join(directory, 'unfinished.csv.tmp'), 'ignored');
    await fs.mkdir(path.join(directory, 'nested.csv'));
    state.quickPick.mockImplementation(async (items: any[]) => items[0]);
    await (provider as any).handleMessage({ command: 'recoverRecord' });
    const items = state.quickPick.mock.calls[0][0];
    expect(items.map((i: any) => i.csv)).toEqual([destination]);
    expect(state.quickPick.mock.calls[0][1].title).not.toContain('异常');
    const restored = state.messages.filter(m => m.command === 'activate').at(-1);
    expect(restored.tab.id).not.toBe(csv.tab.id);
    expect(restored.entries[0].expression).toBe('csv_voltage');
    expect(restored.averageSampleRateHz).toBe(1000);
    const tab = (provider as any).tabs.get(restored.tab.id);
    const cache = tab.store.directory;
    await (provider as any).handleMessage({ command: 'closeTab', tabId: restored.tab.id });
    await Promise.all([...(provider as any).finalizers]);
    expect(await fs.stat(cache).catch(() => null)).toBeNull();
    expect(await fs.readFile(destination, 'utf8')).toContain('time_ms,channel_id,value,segment_id');
  });
  it('does not list temporary or legacy automatic recordings when no archive was saved', async () => {
    const live = debugStart();
    await live.store.flush();
    const legacy = path.join(base, 'timeline-records', 'legacy');
    await fs.mkdir(legacy, { recursive: true });
    await fs.writeFile(path.join(legacy, 'record.csv'), 'old automatic data');
    await (provider as any).handleMessage({ command: 'recoverRecord' });
    expect(state.quickPick).not.toHaveBeenCalled();
    expect(state.info).toHaveBeenCalledWith('.vscode/timeline 中没有已保存的 Timeline CSV。');
  });
});
