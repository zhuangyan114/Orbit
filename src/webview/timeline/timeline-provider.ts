import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { DataSamplingManager } from '../../debug-providers/data-sampling-manager';
import type { DataSampleSnapshot } from '../../ozone-backend/types';
import { intersectTimelineRange, parseTimelineRangeLoadRequest } from './timeline-range';
import { createTimelineEntry, mergeTimelineEntryRefresh } from './timeline-entry-state';
import { isOrbitDebugSessionType } from '../../utils/debug-session-type';
import { stripHanCharacters } from '../../utils/watch-expression-validation';
import { DEFAULT_TIMELINE_VIEW, validTimelineView, type TimelineDebugSession, type TimelineTab, type TimelineViewState } from '../../timeline/timeline-model';
import { TimelineRecordStore } from '../../timeline/timeline-store';
import { TimelineTemporaryCache } from '../../timeline/timeline-cache';
import { log } from '../../utils/logger';
import { TimelineSampleRate } from './timeline-sample-rate';
import { loadActiveSymbolCatalog } from '../../debug-providers/symbol-catalog-loader';
import type { SymbolCatalog } from '../../symbols/symbol-catalog';
import type { SymbolPickerPanel } from '../../debug-providers/symbol-picker-panel';
import { prepareTimelineLiveSamples } from './timeline-live';
import { pickTimelineColor } from './timeline-colors';
import type { TimelineLinkClock } from '../../trace/clock-link-observations';
import type { TimelineLinkView, TimelineLinkWindow } from '../../trace/clock-panel-link';
import type { TimelineCursors } from './timeline-cursors';

const STATE_KEY = 'ozoneTimelineState';
const GROUPS_STATE_KEY = 'ozoneTimelineGroups';
interface TimelineGroupsState {
  version: 1;
  activeId: string;
  groups: { id: string; name: string; samplingEnabled: boolean; view: TimelineViewState }[];
}
interface RecordTab {
  info: TimelineTab;
  store?: TimelineRecordStore;
  view: TimelineViewState;
  session?: vscode.DebugSession;
  archiveDirectory?: string;
  revision: number;
  queryGeneration?: number;
  queryResolutionKey?: number;
  sampleRate?: TimelineSampleRate;
  pendingSession?: Omit<TimelineDebugSession, 'startMs'>;
  segmentExpressions?: Set<string>;
  timestampOffset?: number;
  clockWindows?: TimelineLinkWindow[];
  clockWindowOpen?: boolean;
  clockLinkNotice?: string;
}

export class TimelineWebviewProvider implements vscode.WebviewViewProvider {
  onClockLink?: (view: TimelineLinkView) => void;
  private view: vscode.WebviewView | null = null;
  private tabs = new Map<string, RecordTab>();
  private activeId = 'timeline1';
  private debugGroupId = 'timeline1';
  private syncingSampler = false;
  private directory: string;
  private cache = new TimelineTemporaryCache();
  private sessionStarts = new WeakMap<vscode.DebugSession, string>();
  private endedSessions = new WeakSet<vscode.DebugSession>();
  private activeRequestCount = 0;
  private disposed = false;
  private finalizers = new Set<Promise<void>>();
  private importing = false;
  private exporting = false;
  private jobs = new Set<Promise<unknown>>();
  private lifetimeAbort = new AbortController();
  private storageSummaryAt = 0;
  private rangeMetrics = { since: Date.now(), requests: 0, maxMs: 0, points: 0 };
  private renderMetricsAt = 0;

  constructor(private context: vscode.ExtensionContext, private sampleManager: DataSamplingManager,
    private canUseDapSession: (session: vscode.DebugSession) => boolean = () => true,
    private symbolPicker?: SymbolPickerPanel) {
    const saved = context.workspaceState.get<TimelineViewState>(STATE_KEY);
    const defaults = saved && validTimelineView(saved) ? structuredClone(saved) : structuredClone(DEFAULT_TIMELINE_VIEW);
    this.directory = this.cache.directory;
    // Drop the old cache descriptors; unsaved records never survive a host reload.
    void context.workspaceState.update('ozoneTimelineOpenRecords', undefined);
    this.sampleManager.setSamplingExpressions([]);
    const savedGroups = context.workspaceState.get<TimelineGroupsState>(GROUPS_STATE_KEY);
    if (savedGroups?.version === 1 && Array.isArray(savedGroups.groups)) {
      for (const group of savedGroups.groups.slice(0, 32)) {
        if (!group || typeof group.id !== 'string' || !/^timeline[1-9]\d*$/.test(group.id)
          || !Number.isSafeInteger(Number(group.id.slice(8))) || this.tabs.has(group.id) || !validTimelineView(group.view)) continue;
        this.tabs.set(group.id, { info: { id: group.id, recordId: '', name: typeof group.name === 'string' && group.name.trim() ? group.name.trim().slice(0, 128) : group.id,
          kind: 'template', samplingEnabled: group.samplingEnabled === true, incomplete: false }, view: structuredClone(group.view), revision: 0 });
      }
    }
    if (!this.tabs.size) {
      const rawLegacy = context.workspaceState.get<unknown>('ozoneDataSamplingExpressions', []);
      const legacy: TimelineViewState['entries'] = [];
      for (const item of Array.isArray(rawLegacy) ? rawLegacy : []) {
        const expression = stripHanCharacters(typeof item === 'string' ? item : String(item?.expression ?? '')).trim();
        if (!expression || expression.length > 4096 || legacy.some(entry => entry.expression === expression)) continue;
        const color = typeof item?.color === 'string' && /^#[0-9a-f]{6}$/i.test(item.color) ? item.color : pickTimelineColor(legacy.map(entry => entry.color));
        legacy.push(createTimelineEntry({ expression, color }));
        if (legacy.length === 1024) break;
      }
      const inherited = this.sampleManager.entriesList.length ? this.sampleManager.entriesList : legacy.length ? legacy : defaults.entries;
      defaults.entries = mergeTimelineEntryRefresh(defaults.entries, inherited.map(entry => ({ ...entry,
        color: defaults.entries.find(existing => existing.expression === entry.expression)?.color ?? entry.color })));
      this.tabs.set('timeline1', { info: { id: 'timeline1', recordId: '', name: 'timeline1', kind: 'template', samplingEnabled: false, incomplete: false }, view: defaults, revision: 0 });
    }
    this.activeId = this.tabs.has(savedGroups?.activeId ?? '') ? savedGroups!.activeId : this.tabs.keys().next().value!;
    this.debugGroupId = this.activeId;
    this.syncSampling();
    this.persistGroups();
    this.sampleManager.setRetainHistory(false);
    this.sampleManager.setOnSamples((snapshots, clock) => this.sendSamples(snapshots, clock));
    context.subscriptions.push(
      vscode.debug.onDidStartDebugSession(session => { if (isOrbitDebugSessionType(session.type)) this.beginRecord(session); }),
      vscode.debug.onDidTerminateDebugSession(session => {
        this.endedSessions.add(session);
        this.finishLive(session);
      }),
    );
    const current = vscode.debug.activeDebugSession;
    if (current && isOrbitDebugSessionType(current.type)) this.beginRecord(current);
  }
  private debugTabs() { return [...this.tabs.values()].filter(tab => this.isDebugTab(tab)); }
  private persistGroups() {
    const groups = this.debugTabs().map(tab => ({ id: tab.info.id, name: tab.info.name, samplingEnabled: tab.info.samplingEnabled === true, view: structuredClone(tab.view) }));
    void this.context.workspaceState.update(GROUPS_STATE_KEY, { version: 1, activeId: this.debugGroupId, groups });
    const active = this.tabs.get(this.debugGroupId);
    if (active) void this.context.workspaceState.update(STATE_KEY, structuredClone(active.view));
    const entries = [...new Map(groups.flatMap(group => group.view.entries).map(entry => [entry.expression, { expression: entry.expression, color: entry.color }])).values()];
    void this.context.workspaceState.update('ozoneDataSamplingExpressions', entries);
  }
  private syncSampling() {
    const groups = this.debugTabs();
    const entries = [...new Map(groups.flatMap(tab => tab.view.entries).map(entry => [entry.expression, { expression: entry.expression, color: entry.color }])).values()];
    const sampled = [...new Set(groups.filter(tab => tab.info.samplingEnabled).flatMap(tab => tab.view.entries.map(entry => entry.expression)))];
    this.syncingSampler = true;
    try {
      this.sampleManager.setSamplingExpressions(sampled);
      const current = new Map(this.sampleManager.entriesList.map(entry => [entry.expression, entry.color]));
      if (current.size !== entries.length || entries.some(entry => entry.color !== current.get(entry.expression))) {
        this.sampleManager.setExpressions(entries);
      }
    } finally { this.syncingSampler = false; }
  }
  private ensureStore(tab: RecordTab) {
    if (tab.store) return;
    const store = new TimelineRecordStore(this.directory, tab.info.name);
    store.meta.debugStartedAtUtc = tab.pendingSession?.startedAtUtc ?? new Date().toISOString();
    store.meta.debugSessions = [];
    store.view = tab.view;
    store.syncChannels(tab.view.entries);
    tab.store = store;
    tab.info.recordId = store.id;
    tab.info.kind = 'live';
    tab.archiveDirectory = this.archiveDirectory(tab.session?.workspaceFolder);
    tab.sampleRate = new TimelineSampleRate();
    this.attachStoreErrors(tab);
    if (this.activeId === tab.info.id) this.activateTab(tab.info.id);
  }
  private attachStoreErrors(tab: RecordTab) {
    const store = tab.store!;
    store.onError = error => {
      tab.info.error = error; tab.info.incomplete = true;
      log.dap(`[timeline] storage failed recordId=${store.id} error=${error} metrics=${JSON.stringify(store.getMetrics())}`);
      this.postTabs(); void vscode.window.showWarningMessage('Timeline 记录不完整：' + error);
    };
  }
  private beginRecord(session?: vscode.DebugSession) {
    if (this.disposed || (session && this.endedSessions.has(session))) return;
    const startedAt = session ? this.sessionStarts.get(session) ?? new Date().toISOString() : new Date().toISOString();
    if (session) this.sessionStarts.set(session, startedAt);
    for (const tab of this.debugTabs()) {
      if (tab.session !== session || (!tab.store && !tab.pendingSession)) {
        tab.session = session;
        tab.clockWindowOpen = false;
        tab.pendingSession = { name: session?.name || '本地采样', startedAtUtc: startedAt };
        tab.segmentExpressions = new Set(tab.view.entries.map(entry => entry.expression));
        tab.sampleRate = new TimelineSampleRate();
      }
      tab.info.running = !!session;
      if (tab.info.samplingEnabled) this.ensureStore(tab);
    }
    this.postTabs();
  }
  private finishLive(session: vscode.DebugSession) {
    for (const tab of this.debugTabs()) {
      if (tab.session !== session) continue;
      tab.session = undefined;
      tab.clockWindowOpen = false;
      tab.info.running = false;
      tab.segmentExpressions = new Set(tab.view.entries.map(entry => entry.expression));
      this.postMessage({ command: 'sampleRate', tabId: tab.info.id, recordId: tab.info.recordId,
        sampleRateHz: 0, averageSampleRateHz: tab.store?.getAverageSampleRateHz() ?? null });
    }
    this.postTabs();
  }
  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [this.context.extensionUri] };
    webviewView.webview.html = this.getHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage(msg => {
      if (!msg || typeof msg !== 'object') return;
      void this.handleMessage(msg).catch(error => { void vscode.window.showErrorMessage('Timeline：' + (error instanceof Error ? error.message : String(error))); });
    });
    webviewView.onDidChangeVisibility(() => { if (webviewView.visible) this.activateTab(this.activeId); else { const tab = this.tabs.get(this.activeId); if (tab) tab.revision++; } });
    webviewView.onDidDispose(() => { if (this.view === webviewView) this.view = null; });
  }
  private async handleMessage(msg: any) {
    if (this.disposed) return;
    if (msg.command === 'init') {
      this.postTabs(); this.activateTab(this.activeId);
      return;
    }
    if (msg.command === 'selectTab') { this.activateTab(msg.tabId); return; }
    if (msg.command === 'addGroup') {
      if (this.tabs.size >= 32) throw new Error('最多同时打开 32 个标签，请先关闭历史标签');
      let index = 1;
      while (this.tabs.has('timeline' + index)) index++;
      const id = 'timeline' + index;
      this.tabs.set(id, { info: { id, recordId: '', name: id, kind: 'template', samplingEnabled: false, incomplete: false },
        view: structuredClone(DEFAULT_TIMELINE_VIEW), revision: 0 });
      this.activateTab(id);
      this.beginRecord(vscode.debug.activeDebugSession && isOrbitDebugSessionType(vscode.debug.activeDebugSession.type) ? vscode.debug.activeDebugSession : undefined);
      return;
    }
    if (msg.command === 'renameGroup') {
      const renamed = this.tabs.get(msg.tabId);
      if (!renamed || typeof msg.name !== 'string' || !msg.name.trim()) return;
      renamed.info.name = msg.name.trim().slice(0, 128);
      if (renamed.store) renamed.store.meta.name = renamed.info.name;
      this.persistGroups(); this.postTabs();
      return;
    }
    if (msg.command === 'reorderGroup') {
      const ordered = [...this.tabs.entries()];
      const index = ordered.findIndex(([id]) => id === msg.tabId);
      if (index < 0 || !Number.isInteger(msg.index) || msg.index < 0 || msg.index >= ordered.length) return;
      const [tab] = ordered.splice(index, 1);
      ordered.splice(msg.index, 0, tab);
      this.tabs = new Map(ordered);
      this.persistGroups(); this.postTabs();
      return;
    }
    if (msg.command === 'setSamplingEnabled') {
      const sampled = this.tabs.get(msg.tabId);
      if (!sampled || !this.isDebugTab(sampled) || typeof msg.enabled !== 'boolean') return;
      sampled.info.samplingEnabled = msg.enabled;
      sampled.segmentExpressions = new Set(sampled.view.entries.map(entry => entry.expression));
      sampled.sampleRate = new TimelineSampleRate();
      this.syncSampling(); this.persistGroups();
      const session = vscode.debug.activeDebugSession;
      if (msg.enabled && session && isOrbitDebugSessionType(session.type)) this.beginRecord(session);
      this.postTabs();
      if (!msg.enabled) this.postMessage({ command: 'sampleRate', tabId: sampled.info.id, recordId: sampled.info.recordId, sampleRateHz: 0 });
      return;
    }
    if (msg.command === 'openCsv') { await this.openCsv(); return; }
    if (msg.command === 'recoverRecord') { await this.recoverRecord(); return; }
    if (msg.command === 'closeTab') {
      const tab = this.tabs.get(msg.tabId);
      if (!tab || (this.isDebugTab(tab) && this.debugTabs().length === 1)) return;
      this.tabs.delete(msg.tabId);
      this.releaseTab(tab);
      if (this.debugGroupId === msg.tabId) this.debugGroupId = this.debugTabs()[0].info.id;
      this.syncSampling(); this.persistGroups();
      if (this.activeId === msg.tabId) this.activateTab(this.debugGroupId);
      this.postTabs(); return;
    }
    const tab = this.tabs.get(msg.tabId);
    if (!tab || tab.info.recordId !== msg.recordId) return;
    if (msg.command === 'saveState') {
      if (!validTimelineView(msg.state)) return;
      // The CSV tab can never update the debug template or sampler.
      tab.view = structuredClone(msg.state);
      if (tab.store) {
        tab.store.view = tab.view;
        for (const channel of tab.store.channels) { const update = tab.view.entries.find(e => e.expression === channel.expression); if (update) Object.assign(channel, update); }
      }
      if (this.isDebugTab(tab)) { tab.store?.syncChannels(tab.view.entries); this.persistGroups(); this.syncSampling(); }
      return;
    }
    if (tab.info.id !== this.activeId) return;
    if (msg.command === 'openSymbolPicker') {
      await this.openSymbolPicker(tab);
      return;
    }
    if (msg.command === 'addExpressions' && Array.isArray(msg.expressions)) {
      if (this.isDebugTab(tab)) {
        this.changeExpressions(tab, msg.expressions.filter((expression: unknown): expression is string => typeof expression === 'string' && expression.length <= 4096));
        return;
      }
      for (const expression of new Set(msg.expressions)) {
        await this.handleMessage({ ...msg, command: 'addExpression', expression });
      }
      return;
    }
    switch (msg.command) {
      case 'clockLinkToTrace': {
        const view = this.getClockLinkView();
        if (!view) break;
        const valid = (value: unknown): value is number | null => value === null || (typeof value === 'number' && Number.isFinite(value));
        if (valid(msg.cursors?.A) && valid(msg.cursors?.B)) this.onClockLink?.({ ...view, cursors: { A: msg.cursors.A, B: msg.cursors.B } });
        break;
      }
      case 'renderMetrics': {
        if (Date.now() - this.renderMetricsAt < 9000 || ![msg.frames, msg.slowFrames, msg.maxDrawMs].every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0)) break;
        this.renderMetricsAt = Date.now();
        log.dap(`[timeline] render summary frames=${msg.frames} slowFrames=${msg.slowFrames} maxDrawMs=${msg.maxDrawMs.toFixed(2)}`);
        if (msg.delivery && ['notifications', 'maxNotificationGapMs', 'maxNotificationTransitMs', 'rangeReplies', 'maxRangeReplyMs', 'maxFrameWaitMs', 'dataFrames', 'maxDataFrameGapMs', 'longTasks', 'maxLongTaskMs', 'hiddenNotifications'].every(key => typeof msg.delivery[key] === 'number' && Number.isFinite(msg.delivery[key]) && msg.delivery[key] >= 0)) {
          log.dap(`[timeline] delivery summary ${JSON.stringify(msg.delivery)}`);
        }
        break;
      }
      case 'loadRange': await this.sendRange(tab, msg); break;
      case 'measure': {
        if (!tab.store || !Number.isFinite(msg.time) || !Number.isSafeInteger(msg.requestId)) break;
        const revision = tab.revision;
        const values = await tab.store.measure(msg.time);
        if (this.isCurrent(tab, revision)) this.postMessage({ command: 'measurement', tabId: tab.info.id, recordId: tab.info.recordId, requestId: msg.requestId, cursor: msg.cursor, values });
        break;
      }
      case 'saveCsv':
        if (this.exporting) throw new Error('已有 CSV 正在保存，请等待完成');
        this.exporting = true;
        try { await this.saveCsv(tab, msg.scope); } finally { this.exporting = false; }
        break;
      case 'clearData':
        if (this.isDebugTab(tab)) this.beginFreshRecord(tab);
        break;
      case 'addExpression':
        if (typeof msg.expression === 'string') {
          const expression = stripHanCharacters(msg.expression).trim();
          if (!expression || expression.length > 4096) break;
          if (this.isDebugTab(tab)) {
            this.changeExpressions(tab, [expression]);
          } else {
            // Historical pages can select recorded channels without registering
            // new target reads or changing the debug configuration.
            const channel = tab.store && [...tab.store.channels].reverse().find(c => c.expression === expression);
            if (!channel) { void vscode.window.showInformationMessage('当前记录未包含变量：' + expression); break; }
            const existing = tab.view.entries.find(e => e.expression === expression);
            if (existing) existing.enabled = true;
            else tab.view.entries.push(createTimelineEntry({ ...channel, enabled: true }));
            this.postMessage({ command: 'entries', entries: tab.view.entries, tabId: tab.info.id, recordId: tab.info.recordId });
          }
        }
        break;
      case 'removeExpression':
        if (this.isDebugTab(tab) && typeof msg.expression === 'string') this.changeExpressions(tab, [], [msg.expression]);
        break;
      case 'toggleExpression':
        if (this.isDebugTab(tab) && typeof msg.enabled === 'boolean') {
          tab.view.entries = tab.view.entries.map(entry => entry.expression === msg.expression ? { ...entry, enabled: msg.enabled } : entry);
          this.publishEntries(tab);
        }
        break;
      case 'setColor':
        if (this.isDebugTab(tab) && typeof msg.expression === 'string' && /^#[0-9a-f]{6}$/i.test(msg.color)) {
          tab.view.entries = tab.view.entries.map(entry => entry.expression === msg.expression ? { ...entry, color: msg.color } : entry);
          this.publishEntries(tab);
        }
        break;
    }
  }
  private isDebugTab(tab: RecordTab) { return tab.info.kind === 'live' || tab.info.kind === 'template'; }
  private recordedSymbolCatalog(tab: RecordTab): SymbolCatalog {
    return { source: 'recording',
      roots: [...new Map((tab.store?.channels || []).map(channel => [channel.expression, channel])).values()]
        .map(channel => ({ id: `channel-${channel.id}`, expression: channel.expression, file: '当前记录', size: 0, typeOffset: 'recorded', pointerDepth: 0 })),
      types: { recorded: { name: '已记录数值', kind: 'recorded', byteSize: 0 } },
    };
  }
  private async openSymbolPicker(tab: RecordTab) {
    const revision = tab.revision;
    const debug = this.isDebugTab(tab);
    await this.symbolPicker?.open({
      mode: 'timeline', title: `选择变量 → Timeline · ${tab.info.name}`,
      existing: tab.view.entries.filter(entry => debug || entry.enabled).map(entry => entry.expression),
      loadCatalog: () => debug && (vscode.debug.activeDebugSession || !tab.store)
        ? loadActiveSymbolCatalog(this.canUseDapSession) : Promise.resolve(this.recordedSymbolCatalog(tab)),
      canOpen: () => !this.disposed && tab.revision === revision && this.tabs.get(tab.info.id) === tab && tab.info.id === this.activeId,
      commit: (expressions, removedExpressions = []) => {
        if (this.disposed) return;
        if (debug) {
          if (this.tabs.get(tab.info.id) === tab) this.changeExpressions(tab, expressions, removedExpressions);
          return;
        }
        if (this.tabs.get(tab.info.id) !== tab) return;
        const removed = new Set(removedExpressions);
        for (const entry of tab.view.entries) if (removed.has(entry.expression)) entry.enabled = false;
        for (const expression of expressions) {
          const channel = [...(tab.store?.channels || [])].reverse().find(item => item.expression === expression);
          if (!channel) continue;
          const entry = tab.view.entries.find(item => item.expression === expression);
          if (entry) entry.enabled = true;
          else tab.view.entries.push(createTimelineEntry({ ...channel, enabled: true }));
        }
        if (tab.info.id === this.activeId) this.postMessage({ command: 'entries', entries: tab.view.entries, tabId: tab.info.id, recordId: tab.info.recordId });
      },
    });
  }
  private beginFreshRecord(tab: RecordTab) {
    if (this.tabs.size >= 32) throw new Error('最多同时打开 32 个标签，请先关闭历史标签');
    if (tab.store) {
      const store = tab.store;
      const archived: RecordTab = { info: { id: store.id, recordId: store.id, name: tab.info.name + ' · 历史记录', kind: 'history', incomplete: tab.info.incomplete, error: tab.info.error },
        store, view: { ...structuredClone(tab.view), autoFollow: false }, archiveDirectory: tab.archiveDirectory, revision: 0 };
      this.tabs.set(store.id, archived);
      this.attachStoreErrors(archived);
      const ending = store.end();
      this.finalizers.add(ending);
      void ending.then(() => this.finalizers.delete(ending), () => this.finalizers.delete(ending));
      tab.store = undefined;
    }
    tab.info.recordId = '';
    tab.info.kind = 'template';
    tab.info.incomplete = false;
    tab.info.error = undefined;
    tab.view = { ...tab.view, autoFollow: true, viewportEndMs: undefined, cursorA_ms: null, cursorB_ms: null };
    tab.pendingSession = { name: tab.session?.name || '本地采样', startedAtUtc: tab.session ? this.sessionStarts.get(tab.session)! : new Date().toISOString() };
    tab.segmentExpressions = new Set(tab.view.entries.map(entry => entry.expression));
    tab.timestampOffset = 0;
    tab.clockWindows = undefined;
    tab.clockWindowOpen = false;
    tab.clockLinkNotice = undefined;
    if (tab.info.samplingEnabled) this.ensureStore(tab);
    this.activateTab(tab.info.id);
    this.persistGroups();
  }
  addExpressions(expressions: string[]) {
    const tab = this.tabs.get(this.debugGroupId);
    if (tab) this.changeExpressions(tab, expressions);
  }
  private changeExpressions(tab: RecordTab, additions: string[], removals: string[] = []) {
    const removed = new Set(removals);
    const entries = tab.view.entries.filter(entry => !removed.has(entry.expression));
    for (const input of additions) {
      const expression = stripHanCharacters(input).trim();
      if (!expression || expression.length > 4096 || entries.some(entry => entry.expression === expression)) continue;
      if (entries.length >= 1024) throw new Error('每组最多添加 1024 个变量');
      entries.push(createTimelineEntry({ expression, color: pickTimelineColor(entries.map(entry => entry.color)) }));
    }
    tab.view.entries = entries;
    this.publishEntries(tab);
  }
  private publishEntries(tab: RecordTab) {
    if (tab.store) { tab.store.view = tab.view; tab.store.syncChannels(tab.view.entries); }
    this.persistGroups(); this.syncSampling();
    if (this.activeId === tab.info.id) this.postMessage({ command: 'entries', entries: tab.view.entries, tabId: tab.info.id, recordId: tab.info.recordId });
    this.postTabs();
  }
  refreshEntries() {
    if (this.syncingSampler || this.disposed) return;
    const tab = this.tabs.get(this.debugGroupId);
    if (!tab) return;
    const known = new Set(this.debugTabs().flatMap(group => group.view.entries.map(entry => entry.expression)));
    const own = new Set(tab.view.entries.map(entry => entry.expression));
    tab.view.entries = mergeTimelineEntryRefresh(tab.view.entries, this.sampleManager.entriesList.filter(entry => own.has(entry.expression) || !known.has(entry.expression)));
    this.publishEntries(tab);
  }
  private activateTab(id: string) {
    if (!this.tabs.has(id)) id = this.debugGroupId;
    const old = this.tabs.get(this.activeId); if (old) old.revision++;
    this.activeId = id; const tab = this.tabs.get(id)!; tab.revision++;
    if (this.isDebugTab(tab)) { this.debugGroupId = id; this.persistGroups(); }
    this.postTabs();
    this.postMessage({ command: 'activate', tab: tab.info, ...tab.view, clockLinkNotice: tab.clockLinkNotice, debugSessions: tab.store?.meta.debugSessions ?? [],
      historyBounds: tab.store?.bounds ?? null, sampleRateHz: tab.info.kind === 'live' ? tab.sampleRate?.getHz() ?? 0 : null, averageSampleRateHz: tab.store?.getAverageSampleRateHz() ?? null });
  }
  private postTabs() { this.postMessage({ command: 'tabs', tabs: [...this.tabs.values()].map(t => t.info), activeId: this.activeId }); }
  private archiveDirectory(folder?: vscode.WorkspaceFolder) {
    const workspace = folder ?? vscode.workspace.workspaceFolders?.[0];
    return workspace?.uri.scheme === 'file' ? path.join(workspace.uri.fsPath, '.vscode', 'timeline') : undefined;
  }
  private trackJob<T>(job: PromiseLike<T>): Promise<T> {
    const pending = Promise.resolve(job);
    this.jobs.add(pending);
    void pending.finally(() => this.jobs.delete(pending)).catch(() => {});
    return pending;
  }
  private async withCancellation<T>(token: vscode.CancellationToken, run: (signal: AbortSignal) => Promise<T>) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const cancellation = token.onCancellationRequested(abort);
    this.lifetimeAbort.signal.addEventListener('abort', abort);
    if (this.disposed || token.isCancellationRequested) abort();
    try { return await run(controller.signal); }
    finally { cancellation.dispose(); this.lifetimeAbort.signal.removeEventListener('abort', abort); }
  }
  private releaseTab(tab: RecordTab) {
    const store = tab.store;
    if (!store) return;
    const releasing = (async () => {
      await Promise.allSettled([...this.jobs]);
      await store.dispose();
      await this.cache.removeRecord(store.directory);
    })();
    this.finalizers.add(releasing);
    void releasing.finally(() => this.finalizers.delete(releasing)).catch(() => {});
  }
  getClockLinkView(): TimelineLinkView | undefined {
    const tab = this.tabs.get(this.activeId);
    const bounds = tab?.store?.bounds;
    if (!tab || !bounds || !tab.info.recordId) return;
    return { recordId: tab.info.recordId, bounds,
      sessionStarts: tab.store?.meta.debugSessions?.map(session => session.startMs) ?? [],
      windows: tab.clockWindows ?? [], cursors: { A: tab.view.cursorA_ms ?? null, B: tab.view.cursorB_ms ?? null } };
  }

  applyClockLink(recordId: string, cursors: TimelineCursors, notice: string): void {
    const tab = this.tabs.get(this.activeId);
    if (!tab || tab.info.recordId !== recordId) return;
    tab.view = { ...tab.view, cursorA_ms: cursors.A, cursorB_ms: cursors.B };
    tab.clockLinkNotice = notice;
    if (tab.store) tab.store.view = tab.view;
    if (this.view) this.view.show?.(false);
    else void vscode.commands.executeCommand('ozoneTimeline.focus');
    this.postMessage({ command: 'clockLinkSelection', tabId: tab.info.id, recordId, cursors, notice });
  }

  showClockLinkNotice(notice: string): void {
    const tab = this.tabs.get(this.activeId);
    if (!tab) return;
    tab.clockLinkNotice = notice;
    this.postMessage({ command: 'clockLinkNotice', tabId: tab.info.id, recordId: tab.info.recordId, notice });
  }

  private sendSamples(snapshots: DataSampleSnapshot[], clock?: TimelineLinkClock) {
    const active = vscode.debug.activeDebugSession;
    const session = active && isOrbitDebugSessionType(active.type) ? active : undefined;
    if (session && this.endedSessions.has(session)) return;
    if (this.debugTabs().some(tab => tab.session !== session)) this.beginRecord(session);
    for (const tab of this.debugTabs()) {
      if (!tab.info.samplingEnabled) continue;
      const expressions = new Set(tab.view.entries.map(entry => entry.expression));
      const selected = snapshots.filter(snapshot => expressions.has(snapshot.expression));
      const first = Math.min(...selected.flatMap(snapshot => {
        const point = snapshot.data.find(point => Number.isFinite(point.timestamp) && Number.isFinite(point.value));
        return point ? [point.timestamp] : [];
      }));
      if (!Number.isFinite(first)) continue;
      this.ensureStore(tab);
      const store = tab.store!;
      const rawOrigin = store.getRawOriginTimestamp();
      const lastTime = store.bounds && rawOrigin !== null ? rawOrigin + store.bounds.end : undefined;
      if (tab.pendingSession) {
        tab.timestampOffset = lastTime === undefined ? 0 : Math.max(0, lastTime + 1 - first);
      } else if (lastTime !== undefined && first + (tab.timestampOffset ?? 0) < lastTime) {
        tab.pendingSession = { name: (session?.name || '本地采样') + ' · 时钟重置', startedAtUtc: new Date().toISOString() };
        tab.timestampOffset = lastTime + 1 - first;
        tab.segmentExpressions = new Set(tab.view.entries.map(entry => entry.expression));
      }
      const offset = tab.timestampOffset ?? 0;
      const prepared = selected.map(snapshot => {
        const markStart = tab.segmentExpressions?.has(snapshot.expression) === true;
        if (offset === 0 && !markStart) return snapshot;
        const firstIndex = snapshot.data.findIndex(point => Number.isFinite(point.timestamp) && Number.isFinite(point.value));
        return { ...snapshot, data: snapshot.data.map((point, index) => ({ ...point, timestamp: point.timestamp + offset,
          startsNewSegment: point.startsNewSegment || (markStart && index === firstIndex) })) };
      });
      const accepted = store.append(prepared);
      if (!accepted.length) continue;
      const origin = store.getRawOriginTimestamp();
      if (clock && origin !== null && session) {
        const start = Math.min(...accepted.map(snapshot => snapshot.data[0].timestamp));
        const end = Math.max(...accepted.map(snapshot => snapshot.data.at(-1)!.timestamp));
        const shiftMs = origin - offset;
        const windows = tab.clockWindows ??= [];
        const previous = windows.at(-1);
        if (tab.clockWindowOpen && previous?.key === clock.key && previous.shiftMs === shiftMs) {
          windows[windows.length - 1] = { ...previous, end };
        } else {
          windows.push({ key: clock.key, shiftMs, start, end });
          if (windows.length > 32) windows.shift();
        }
        tab.clockWindowOpen = true;
      } else {
        tab.clockWindowOpen = false;
      }
      const markerAdded = !!tab.pendingSession;
      if (tab.pendingSession) {
        store.meta.debugSessions!.push({ ...tab.pendingSession, startMs: Math.min(...accepted.map(snapshot => snapshot.data[0].timestamp)) });
        tab.pendingSession = undefined;
      }
      for (const snapshot of accepted) tab.segmentExpressions?.delete(snapshot.expression);
      tab.sampleRate?.accept(accepted);
      const now = performance.now();
      if (now - this.storageSummaryAt >= 1000) {
        this.storageSummaryAt = now;
        const metrics = store.getMetrics();
        log.dap(`[timeline] storage summary recordId=${tab.info.recordId} accepted=${metrics.acceptedRows} written=${metrics.writtenRows} checkpoint=${metrics.checkpointRows} queuedBytes=${metrics.globalQueuedBytes}`);
      }
      if (this.view?.visible && this.activeId === tab.info.id) {
        this.postMessage({ command: 'samples', tabId: tab.info.id, recordId: tab.info.recordId, sentAtMs: Date.now(), historyBounds: store.bounds,
          debugSessions: markerAdded ? store.meta.debugSessions : undefined,
          generation: tab.queryGeneration, resolutionKey: tab.queryResolutionKey,
          snapshots: prepareTimelineLiveSamples(accepted, tab.queryResolutionKey), sampleRateHz: tab.sampleRate?.getHz() ?? 0 });
      }
    }
  }
  private isCurrent(tab: RecordTab, revision: number) { return !this.disposed && this.view?.visible === true && this.activeId === tab.info.id && this.tabs.get(tab.info.id) === tab && tab.revision === revision; }
  private async sendRange(tab: RecordTab, message: unknown) {
    const request = parseTimelineRangeLoadRequest(message);
    if (!request || !tab.store) return;
    if (this.activeRequestCount >= 4) { this.postMessage({ command: 'rangeSamples', ...request, tabId: tab.info.id, recordId: tab.info.recordId, range: null, snapshots: [] }); return; }
    this.activeRequestCount++;
    const revision = tab.revision;
    const began = Date.now();
    tab.queryGeneration = request.generation;
    tab.queryResolutionKey = request.resolutionKey;
    try {
      const range = intersectTimelineRange(request, tab.store.bounds);
      const snapshots = range ? await tab.store.query(range.start, range.end, Math.min(2048, Math.max(1, Math.floor(8192 / Math.max(1, tab.store.channels.length))), request.targetBuckets), false, () => this.isCurrent(tab, revision) && tab.queryGeneration === request.generation) : [];
      this.rangeMetrics.points += snapshots.reduce((n, s) => n + s.data.length, 0);
      if (this.isCurrent(tab, revision)) this.postMessage({ command: 'rangeSamples', ...request, tabId: tab.info.id, recordId: tab.info.recordId, historyBounds: tab.store.bounds, range, snapshots });
    } catch (error) {
      if (this.isCurrent(tab, revision)) this.postMessage({ command: 'rangeSamples', ...request, tabId: tab.info.id, recordId: tab.info.recordId, range: null, snapshots: [], error: String(error) });
    } finally {
      this.activeRequestCount--;
      const m = this.rangeMetrics; m.requests++; m.maxMs = Math.max(m.maxMs, Date.now() - began);
      if (Date.now() - m.since >= 10000) {
        log.dap(`[timeline] range summary requests=${m.requests} maxMs=${m.maxMs} points=${m.points} active=${this.activeRequestCount}`);
        this.rangeMetrics = { since: Date.now(), requests: 0, maxMs: 0, points: 0 };
      }
    }
  }
  private async openCsv(source?: string) {
    if (this.importing) throw new Error('已有 CSV 正在读取，请等待完成');
    this.importing = true;
    try { await this.importCsv(source); } finally { this.importing = false; }
  }
  private async importCsv(source?: string) {
    if (this.tabs.size >= 32) throw new Error('最多同时打开 32 个标签，请先关闭历史标签');
    if (!source) { const uris = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'Orbit Timeline CSV': ['csv'] }, title: '打开 Timeline CSV' }); source = uris?.[0]?.fsPath; }
    if (!source) return;
    if (this.disposed) return;
    await this.trackJob((async () => {
      const store = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '正在读取 Timeline CSV 并建立索引', cancellable: true }, (_progress, token) =>
        this.withCancellation(token, signal => TimelineRecordStore.open(this.directory, source!, signal)));
      if (this.disposed) { await store.dispose(); await this.cache.removeRecord(store.directory); return; }
      const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(source));
      const tab: RecordTab = { info: { id: store.id, recordId: store.id, name: store.meta.name, kind: 'history', incomplete: !store.meta.complete, error: store.error }, store, view: store.view, archiveDirectory: this.archiveDirectory(folder), revision: 0 };
      this.tabs.set(store.id, tab); this.activateTab(store.id);
    })());
  }
  private async recoverRecord() {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (!folders.length) { void vscode.window.showInformationMessage('请先打开工程，再从 .vscode/timeline 恢复已保存的记录。'); return; }
    const candidates: { label: string; description: string; csv: string }[] = [];
    for (const folder of folders) {
      const directory = this.archiveDirectory(folder);
      if (!directory) continue;
      const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) if (entry.isFile() && /\.csv$/i.test(entry.name)) {
        candidates.push({ label: entry.name, description: folder.name + '/.vscode/timeline', csv: path.join(directory, entry.name) });
      }
    }
    if (!candidates.length) { void vscode.window.showInformationMessage('.vscode/timeline 中没有已保存的 Timeline CSV。'); return; }
    candidates.sort((a, b) => b.label.localeCompare(a.label));
    const chosen = await vscode.window.showQuickPick(candidates, { title: '打开 .vscode/timeline 中已保存的记录' });
    if (chosen) await this.openCsv(chosen.csv);
  }
  private async saveCsv(tab: RecordTab, scope: string) {
    if (!tab.store) throw new Error('当前没有可保存的记录');
    const store = tab.store;
    // Capture view and bounds before opening dialogs; sampling continues independently.
    const view = structuredClone(tab.view);
    const range = scope === 'selection' && Number.isFinite(view.cursorA_ms) && Number.isFinite(view.cursorB_ms)
      ? { start: Math.min(view.cursorA_ms!, view.cursorB_ms!), end: Math.max(view.cursorA_ms!, view.cursorB_ms!) } : null;
    if (scope === 'selection' && !range) throw new Error('请先放置 A/B 游标');
    const snapshot = store.captureSnapshot(range, view);
    const date = new Date(store.meta.debugStartedAtUtc ?? store.meta.timeOriginUtc);
    const pad = (value: number, width = 2) => String(value).padStart(width, '0');
    const filename = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}.csv`;
    const directory = tab.archiveDirectory ?? this.archiveDirectory();
    if (directory) await fs.mkdir(directory, { recursive: true });
    if (this.disposed) return;
    const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(directory ?? os.homedir(), filename)), filters: { CSV: ['csv'] }, title: range ? '保存 A/B 区间 CSV' : '保存全部 CSV' });
    if (!uri || this.disposed || this.tabs.get(tab.info.id) !== tab) return;
    await this.trackJob(vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '正在保存 Timeline CSV', cancellable: true }, (_progress, token) =>
      this.withCancellation(token, signal => store.save(uri.fsPath, range, view, signal, snapshot))));
    void vscode.window.showInformationMessage('Timeline CSV 已保存：' + uri.fsPath);
  }
  private postMessage(msg: any) { if (!this.disposed) void this.view?.webview.postMessage(msg); }
  async dispose() {
    this.disposed = true; this.lifetimeAbort.abort(); this.sampleManager.setOnSamples(null);
    await Promise.allSettled([...this.jobs]);
    await Promise.allSettled([...this.finalizers, ...[...this.tabs.values()].map(t => t.store?.dispose())]);
    await this.cache.dispose();
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'timeline.js')
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-eval' ${webview.cspSource}; script-src-elem ${webview.cspSource};">
  <style>
    :root {
      --bg: var(--vscode-sideBar-background, #1e1e1e);
      --fg: var(--vscode-sideBar-foreground, #cccccc);
      --border: var(--vscode-sideBar-border, #333333);
      --input-bg: var(--vscode-input-background, #3c3c3c);
      --input-fg: var(--vscode-input-foreground, #cccccc);
      --btn-bg: var(--vscode-button-background, #0e639c);
      --btn-fg: var(--vscode-button-foreground, #ffffff);
      --btn-secondary-bg: var(--vscode-button-secondaryBackground, #3a3d41);
      --error-fg: var(--vscode-errorForeground, #f48771);
      --description-fg: var(--vscode-descriptionForeground, #888888);
    }
    body.vscode-dark, body.vscode-high-contrast { color-scheme: dark; }
    body.vscode-light, body.vscode-high-contrast-light { color-scheme: light; }
    body { margin: 0; padding: 0; font-family: var(--vscode-font-family, sans-serif); background: var(--bg); color: var(--fg); font-size: 12px; overflow: hidden; display: flex; flex-direction: column; height: 100vh; }
    #root { height: 100%; display: flex; flex-direction: column; }
  </style>
  <title>Orbit Timeline</title>
</head>
<body>
  <div id="root">Loading...</div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
  }
}
