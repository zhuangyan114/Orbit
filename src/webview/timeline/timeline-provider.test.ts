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

let base: string, provider: TimelineWebviewProvider, manager: any, saved: Map<string, any>;
beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-tabs-'));
  state.messages = []; state.session = undefined; state.warning.mockReset();
  state.info.mockReset(); state.saveDialog.mockReset(); state.quickPick.mockReset();
  state.folders = [{ name: '工程', uri: { fsPath: path.join(base, 'project'), scheme: 'file' } }];
  saved = new Map([['ozoneTimelineState', { ...DEFAULT_TIMELINE_VIEW, entries: [createTimelineEntry({ expression: 'live_motor', color: '#ABCDEF', yPerDiv: 20 })] }]]);
  manager = { entriesList: [{ expression: 'live_motor', color: '#123456', enabled: true }], setColor: vi.fn((expression: string, color: string) => { manager.entriesList.find((e: any) => e.expression === expression).color = color; }), setExpressions: vi.fn((entries: any[]) => { manager.entriesList = entries.map(e => ({ ...e, enabled: true })); }), setRetainHistory: vi.fn(), clearData: vi.fn(), setOnSamples: (cb: any) => { manager.samples = cb; }, addExpression: vi.fn(), removeExpression: vi.fn(), toggleExpression: vi.fn() };
  const context = { workspaceState: { get: (key: string) => saved.get(key), update: async (key: string, value: any) => { saved.set(key, structuredClone(value)); } }, globalStorageUri: { fsPath: base }, subscriptions: [], extensionUri: '' };
  provider = new TimelineWebviewProvider(context as any, manager);
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
function debugStart() { state.session = { id: 'new', name: '新调试', type: 'orbit' }; state.start(state.session); return (provider as any).tabs.get((provider as any).liveId); }

describe('Timeline record and debug configuration isolation', () => {
  it('updates template colors without reactivating and unmounting the color picker', async () => {
    await (provider as any).handleMessage({ command: 'init' });
    state.messages = [];
    for (const color of ['#569CD6', '#123456', '#42D9F3']) {
      await (provider as any).handleMessage({
        command: 'setColor', tabId: 'debug-template', recordId: '', expression: 'live_motor', color,
      });
      expect(state.messages.filter(m => m.command === 'activate')).toHaveLength(0);
      expect(state.messages.filter(m => m.command === 'entries').at(-1)).toMatchObject({
        tabId: 'debug-template', recordId: '', entries: [expect.objectContaining({ expression: 'live_motor', color })],
      });
      expect(saved.get('ozoneDataSamplingExpressions')).toEqual([{ expression: 'live_motor', color }]);
    }
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
    expect(state.messages.at(-1)).toMatchObject({ sampleRateHz: 100, snapshots: [] });
    await (provider as any).handleMessage({ ...request, requestId: 2 });
    const reply = state.messages.at(-1);
    expect(reply).toMatchObject({ command: 'rangeSamples', tabId: live.info.id, recordId: live.info.recordId, requestId: 2, generation: 1, range: { start: 0, end: 10 } });
    expect(reply.snapshots[0].data.map((p: any) => p.value)).toEqual([5, 6]);
    expect(reply.snapshots[0].data.map((p: any) => p.timestamp)).toEqual([0, 10]);
  });
  it('inherits saved debug variables/colors and changes the entire left list on tab switch', async () => {
    const csv = await imported(); const live = debugStart();
    expect((provider as any).activeId).toBe(live.info.id);
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
    state.terminate(state.session); expect(live.info.kind).toBe('history');
    state.session = { id: 'next', name: '下一次', type: 'orbit' }; state.start(state.session);
    expect((provider as any).liveId).not.toBe(live.info.id);
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
  it('selects the latest debug record without revealing the Timeline panel, including while hidden', async () => {
    const previous = debugStart();
    state.terminate(state.session);
    const show = vi.fn();
    (provider as any).view.visible = false;
    (provider as any).view.show = show;
    state.messages = [];
    const live = debugStart();
    expect(previous.info.kind).toBe('history');
    expect((provider as any).activeId).toBe(live.info.id);
    expect(state.messages.filter(m => m.command === 'activate').at(-1)).toMatchObject({
      tab: { id: live.info.id, kind: 'live' }, autoFollow: true,
    });
    expect(show).not.toHaveBeenCalled();
    await (provider as any).handleMessage({ command: 'selectTab', tabId: previous.info.id });
    state.messages = [];
    manager.samples([{ expression: 'live_motor', color: '#ABCDEF', currentValue: '5', data: [{ timestamp: 1700000000100, value: 5, display: '5' }] }]);
    expect((provider as any).activeId).toBe(previous.info.id);
    expect(state.messages.filter(m => m.command === 'activate')).toHaveLength(0);
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
    expect((provider as any).tabs.has(live.info.id)).toBe(false);
    expect((provider as any).tabs.size).toBe(1);
    expect(saved.get('ozoneTimelineOpenRecords')).toBeUndefined();
    const template = (provider as any).tabs.get('debug-template');
    expect(template.view.entries[0]).toMatchObject({ expression: 'live_motor', color: '#ABCDEF' });
  });
  it('a live tab cannot be closed; ending it preserves history', async () => {
    const live = debugStart(); await (provider as any).handleMessage({ command: 'closeTab', tabId: live.info.id });
    expect((provider as any).tabs.has(live.info.id)).toBe(true);
    manager.samples([{ expression: 'live_motor', color: '#ABCDEF', currentValue: '5', data: [0, 10, 30].map(timestamp => ({ timestamp, value: 5, display: '5' })) }]);
    state.terminate(state.session); await live.store.end();
    expect(live.info.kind).toBe('history');
    expect(state.messages.find(m => m.command === 'sampleRate' && m.tabId === live.info.id)).toMatchObject({
      recordId: live.info.recordId, averageSampleRateHz: 2 * 1000 / 30,
    });
    await (provider as any).handleMessage({ command: 'selectTab', tabId: live.info.id });
    expect(state.messages.filter(m => m.command === 'activate').at(-1)).toMatchObject({
      tab: { kind: 'history' }, sampleRateHz: null, averageSampleRateHz: 2 * 1000 / 30,
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
    state.start(state.session);
    let live = (provider as any).tabs.get((provider as any).liveId);
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
    live = (provider as any).tabs.get((provider as any).liveId);
    // Cancel the second save: neither a new timestamp nor an automatic archive is created.
    state.saveDialog.mockResolvedValue(undefined);
    await (provider as any).handleMessage({ command: 'saveCsv', tabId: live.info.id, recordId: live.info.recordId, scope: 'all' });
    expect(state.saveDialog.mock.calls[1][0].defaultUri.fsPath).toBe(destination);
    expect(await fs.readdir(path.dirname(destination))).toEqual([path.basename(destination)]);
    await provider.dispose();
    expect(await fs.readFile(destination, 'utf8')).toBe(content);
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
