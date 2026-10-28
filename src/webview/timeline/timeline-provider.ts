import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { DataSamplingManager } from '../../debug-providers/data-sampling-manager';
import type { DataSampleSnapshot } from '../../ozone-backend/types';
import { intersectTimelineRange, parseTimelineRangeLoadRequest } from './timeline-range';
import { createTimelineEntry } from './timeline-entry-state';
import { isOrbitDebugSessionType } from '../../utils/debug-session-type';
import { stripHanCharacters } from '../../utils/watch-expression-validation';
import { DEFAULT_TIMELINE_VIEW, validTimelineView, type TimelineTab, type TimelineViewState } from '../../timeline/timeline-model';
import { TimelineRecordStore } from '../../timeline/timeline-store';
import { TimelineTemporaryCache } from '../../timeline/timeline-cache';
import { log } from '../../utils/logger';
import { TimelineSampleRate } from './timeline-sample-rate';
import { loadActiveSymbolCatalog } from '../../debug-providers/symbol-catalog-loader';
import type { SymbolCatalog } from '../../symbols/symbol-catalog';
import type { SymbolPickerPanel } from '../../debug-providers/symbol-picker-panel';

const STATE_KEY = 'ozoneTimelineState';
interface RecordTab { info: TimelineTab; store?: TimelineRecordStore; view: TimelineViewState; session?: vscode.DebugSession; archiveDirectory?: string; revision: number; queryGeneration?: number; sampleRate?: TimelineSampleRate; }

export class TimelineWebviewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null;
  private tabs = new Map<string, RecordTab>();
  private activeId = 'debug-template';
  private liveId: string | null = null;
  private debugDefaults: TimelineViewState;
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

  constructor(private context: vscode.ExtensionContext, private sampleManager: DataSamplingManager,
    private canUseDapSession: (session: vscode.DebugSession) => boolean = () => true,
    private symbolPicker?: SymbolPickerPanel) {
    const saved = context.workspaceState.get<TimelineViewState>(STATE_KEY);
    this.debugDefaults = saved && validTimelineView(saved) ? structuredClone(saved) : structuredClone(DEFAULT_TIMELINE_VIEW);
    this.directory = this.cache.directory;
    // Drop the old cache descriptors; unsaved records never survive a host reload.
    void context.workspaceState.update('ozoneTimelineOpenRecords', undefined);
    const inherited = this.sampleManager.entriesList.length ? this.sampleManager.entriesList : this.debugDefaults.entries;
    const restored = inherited.map(entry => ({ expression: entry.expression, color: this.debugDefaults.entries.find(e => e.expression === entry.expression)?.color ?? entry.color }));
    if (restored.some((entry, i) => entry.expression !== this.sampleManager.entriesList[i]?.expression || entry.color !== this.sampleManager.entriesList[i]?.color)) this.sampleManager.setExpressions(restored);
    this.refreshTemplate();
    this.sampleManager.setRetainHistory(false);
    this.sampleManager.setOnSamples(snapshots => this.sendSamples(snapshots));
    context.subscriptions.push(
      vscode.debug.onDidStartDebugSession(session => { if (isOrbitDebugSessionType(session.type)) this.beginRecord(session); }),
      vscode.debug.onDidTerminateDebugSession(session => {
        this.endedSessions.add(session);
        const live = this.liveId ? this.tabs.get(this.liveId) : undefined;
        if (live && live.session === session) this.finishLive();
      }),
    );
    const current = vscode.debug.activeDebugSession;
    if (current && isOrbitDebugSessionType(current.type)) this.beginRecord(current);
  }
  private makeEntries() {
    return this.sampleManager.entriesList.map(e => createTimelineEntry({ ...e, ...this.debugDefaults.entries.find(s => s.expression === e.expression), color: e.color }));
  }
  private refreshTemplate() {
    const entries = this.makeEntries();
    this.tabs.set('debug-template', { info: { id: 'debug-template', recordId: '', name: '调试变量', kind: 'template', incomplete: false }, view: { ...structuredClone(this.debugDefaults), entries }, revision: 0 });
  }
  private beginRecord(session?: vscode.DebugSession) {
    if (this.disposed || (session && this.endedSessions.has(session))) return;
    const live = this.liveId ? this.tabs.get(this.liveId) : undefined;
    if (live && live.session === session) return;
    if (this.tabs.size >= 32) {
      const oldest = [...this.tabs.values()].find(tab => tab.info.kind === 'history' && tab.info.id !== this.activeId);
      if (oldest) {
        this.tabs.delete(oldest.info.id); this.releaseTab(oldest);
        void vscode.window.showInformationMessage('Timeline 标签已达 32 个，最早的后台历史页已关闭；仅手动保存的 CSV 可再次打开。');
      } else { void vscode.window.showWarningMessage('Timeline 标签已满，请关闭历史页'); return; }
    }
    this.finishLive();
    this.sampleManager.clearData();
    const store = new TimelineRecordStore(this.directory, session?.name || '实时记录');
    const startedAt = session ? this.sessionStarts.get(session) ?? new Date().toISOString() : new Date().toISOString();
    if (session) this.sessionStarts.set(session, startedAt);
    store.meta.debugStartedAtUtc = startedAt;
    const view = { ...structuredClone(this.debugDefaults), autoFollow: true, viewportEndMs: undefined, cursorA_ms: null, cursorB_ms: null, entries: this.makeEntries() };
    store.view = view; store.syncChannels(view.entries);
    const tab: RecordTab = { info: { id: store.id, recordId: store.id, name: store.meta.name, kind: 'live', incomplete: false }, store, view, session, archiveDirectory: this.archiveDirectory(session?.workspaceFolder), revision: 0 };
    store.onError = error => { tab.info.error = error; tab.info.incomplete = true; this.postTabs(); void vscode.window.showWarningMessage('Timeline 记录不完整：' + error); };
    tab.sampleRate = new TimelineSampleRate();
    this.tabs.set(store.id, tab); this.liveId = store.id;
    this.tabs.delete('debug-template');
    // Select the new record inside Timeline without revealing/focusing its VS Code panel.
    this.activateTab(store.id);
  }
  private finishLive() {
    if (!this.liveId) return;
    const tab = this.tabs.get(this.liveId); this.liveId = null;
    if (!tab?.store) return;
    tab.info.kind = 'history'; tab.view.autoFollow = false;
    const ending = tab.store.end();
    this.finalizers.add(ending);
    void ending.then(() => { this.finalizers.delete(ending); tab.info.incomplete = !tab.store!.meta.complete; tab.info.error = tab.store!.error; this.postTabs(); });
    this.refreshTemplate();
    this.postTabs();
    this.postMessage({ command: 'sampleRate', tabId: tab.info.id, recordId: tab.info.recordId, averageSampleRateHz: tab.store.getAverageSampleRateHz() });
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
    if (msg.command === 'openCsv') { await this.openCsv(); return; }
    if (msg.command === 'recoverRecord') { await this.recoverRecord(); return; }
    if (msg.command === 'closeTab') {
      const tab = this.tabs.get(msg.tabId);
      if (!tab || tab.info.kind === 'live' || tab.info.kind === 'template') return;
      this.tabs.delete(msg.tabId);
      this.releaseTab(tab);
      if (this.activeId === msg.tabId) this.activateTab(this.liveId ?? this.tabs.keys().next().value ?? 'debug-template');
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
      if (tab.info.kind === 'live' || tab.info.kind === 'template') {
        this.debugDefaults = structuredClone(tab.view);
        await this.context.workspaceState.update(STATE_KEY, this.debugDefaults);
      }
      return;
    }
    if (tab.info.id !== this.activeId) return;
    if (msg.command === 'openSymbolPicker') {
      await this.openSymbolPicker(tab);
      return;
    }
    if (msg.command === 'addExpressions' && Array.isArray(msg.expressions)) {
      if (this.isDebugTab(tab)) {
        this.sampleManager.addExpressions(msg.expressions.filter((expression: unknown): expression is string => typeof expression === 'string' && expression.length <= 4096));
        this.refreshEntries();
        return;
      }
      for (const expression of new Set(msg.expressions)) {
        await this.handleMessage({ ...msg, command: 'addExpression', expression });
      }
      return;
    }
    switch (msg.command) {
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
        if (tab.info.kind === 'live') this.beginFreshRecord(tab.session);
        break;
      case 'addExpression':
        if (typeof msg.expression === 'string') {
          const expression = stripHanCharacters(msg.expression).trim();
          if (!expression || expression.length > 4096) break;
          if (this.isDebugTab(tab)) {
            this.sampleManager.addExpression(expression);
            this.refreshEntries();
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
        if (this.isDebugTab(tab) && typeof msg.expression === 'string') { this.sampleManager.removeExpression(msg.expression); this.refreshEntries(); }
        break;
      case 'toggleExpression':
        if (this.isDebugTab(tab) && typeof msg.enabled === 'boolean') this.sampleManager.toggleExpression(msg.expression, msg.enabled);
        break;
      case 'setColor':
        if (this.isDebugTab(tab) && typeof msg.expression === 'string' && /^#[0-9a-f]{6}$/i.test(msg.color)) {
          this.debugDefaults.entries = this.debugDefaults.entries.map(e => e.expression === msg.expression ? { ...e, color: msg.color } : e);
          this.sampleManager.setColor(msg.expression, msg.color);
          this.refreshEntries();
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
      loadCatalog: () => debug ? loadActiveSymbolCatalog(this.canUseDapSession) : Promise.resolve(this.recordedSymbolCatalog(tab)),
      canOpen: () => !this.disposed && tab.revision === revision && this.tabs.get(tab.info.id) === tab && tab.info.id === this.activeId,
      commit: (expressions, removedExpressions = []) => {
        if (this.disposed) return;
        if (debug) {
          // Apply one sampling update; debug defaults outlive an archived recording.
          this.sampleManager.updateExpressions(expressions, removedExpressions); this.refreshEntries();
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
  private beginFreshRecord(session?: vscode.DebugSession) { this.finishLive(); this.activeId = 'debug-template'; this.beginRecord(session); }
  refreshEntries() {
    const live = this.liveId ? this.tabs.get(this.liveId) : undefined;
    const entries = this.makeEntries();
    if (live) {
      live.view.entries = entries; live.store!.syncChannels(entries);
      if (this.activeId === live.info.id) this.postMessage({ command: 'entries', entries, tabId: live.info.id, recordId: live.info.recordId });
    } else {
      this.refreshTemplate();
      // Editing a template is an entries update, not a tab switch: activation remounts the picker.
      if (this.activeId === 'debug-template') this.postMessage({ command: 'entries', entries, tabId: 'debug-template', recordId: '' });
    }
    this.debugDefaults.entries = entries;
    void this.context.workspaceState.update(STATE_KEY, this.debugDefaults);
    void this.context.workspaceState.update('ozoneDataSamplingExpressions', entries.map(e => ({ expression: e.expression, color: e.color })));
    this.postTabs();
  }
  private activateTab(id: string) {
    if (!this.tabs.has(id)) { this.refreshTemplate(); id = 'debug-template'; }
    const old = this.tabs.get(this.activeId); if (old) old.revision++;
    this.activeId = id; const tab = this.tabs.get(id)!; tab.revision++;
    this.postTabs();
    this.postMessage({ command: 'activate', tab: tab.info, ...tab.view, historyBounds: tab.store?.bounds ?? null, sampleRateHz: tab.info.kind === 'live' ? tab.sampleRate?.getHz() ?? 0 : null, averageSampleRateHz: tab.store?.getAverageSampleRateHz() ?? null });
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
  private sendSamples(snapshots: DataSampleSnapshot[]) {
    const active = vscode.debug.activeDebugSession;
    const session = active && isOrbitDebugSessionType(active.type) ? active : undefined;
    if (session && this.endedSessions.has(session)) return;
    const current = this.liveId ? this.tabs.get(this.liveId) : undefined;
    if (!current || current.session !== session) this.beginRecord(session && isOrbitDebugSessionType(session.type) ? session : undefined);
    const tab = this.liveId ? this.tabs.get(this.liveId) : undefined;
    if (!tab?.store) return;
    const accepted = tab.store.append(snapshots);
    tab.sampleRate?.accept(accepted);
    const now = performance.now();
    if (now - this.storageSummaryAt >= 1000) {
      this.storageSummaryAt = now;
      const metrics = tab.store.getMetrics();
      log.dap(`[timeline] storage summary recordId=${tab.info.recordId} accepted=${metrics.acceptedRows} written=${metrics.writtenRows} checkpoint=${metrics.checkpointRows} queuedBytes=${metrics.globalQueuedBytes}`);
    }
    if (tab.store.error?.startsWith('采样时钟回退')) { this.beginFreshRecord(tab.session); const replacement = this.liveId ? this.tabs.get(this.liveId) : undefined; replacement?.store?.append(snapshots); return; }
    if (this.view?.visible && this.activeId === tab.info.id && accepted.length) {
      // Only notify the current view. Host history is already stored regardless of visibility.
      this.postMessage({ command: 'samples', tabId: tab.info.id, recordId: tab.info.recordId, historyBounds: tab.store.bounds, snapshots: [], sampleRateHz: tab.sampleRate?.getHz() ?? 0 });
    }
  }
  private isCurrent(tab: RecordTab, revision: number) { return !this.disposed && this.view?.visible === true && this.activeId === tab.info.id && this.tabs.get(tab.info.id) === tab && tab.revision === revision; }
  private async sendRange(tab: RecordTab, message: unknown) {
    const request = parseTimelineRangeLoadRequest(message);
    if (!request || !tab.store) return;
    if (this.activeRequestCount >= 4) { this.postMessage({ command: 'rangeSamples', ...request, tabId: tab.info.id, recordId: tab.info.recordId, range: null, snapshots: [] }); return; }
    this.activeRequestCount++;
    const revision = tab.revision;
    tab.queryGeneration = request.generation;
    try {
      const range = intersectTimelineRange(request, tab.store.bounds);
      const snapshots = range ? await tab.store.query(range.start, range.end, Math.min(2048, Math.max(1, Math.floor(8192 / Math.max(1, tab.store.channels.length))), request.targetBuckets), false, () => this.isCurrent(tab, revision) && tab.queryGeneration === request.generation) : [];
      if (this.isCurrent(tab, revision)) this.postMessage({ command: 'rangeSamples', ...request, tabId: tab.info.id, recordId: tab.info.recordId, historyBounds: tab.store.bounds, range, snapshots });
    } catch (error) {
      if (this.isCurrent(tab, revision)) this.postMessage({ command: 'rangeSamples', ...request, tabId: tab.info.id, recordId: tab.info.recordId, range: null, snapshots: [], error: String(error) });
    } finally { this.activeRequestCount--; }
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
    // Capture view and bounds before opening dialogs; sampling continues independently.
    const view = structuredClone(tab.view);
    const range = scope === 'selection' && Number.isFinite(view.cursorA_ms) && Number.isFinite(view.cursorB_ms)
      ? { start: Math.min(view.cursorA_ms!, view.cursorB_ms!), end: Math.max(view.cursorA_ms!, view.cursorB_ms!) } : null;
    if (scope === 'selection' && !range) throw new Error('请先放置 A/B 游标');
    const snapshot = tab.store.captureSnapshot(range, view);
    const date = new Date(tab.store.meta.debugStartedAtUtc ?? tab.store.meta.timeOriginUtc);
    const pad = (value: number, width = 2) => String(value).padStart(width, '0');
    const filename = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}.csv`;
    const directory = tab.archiveDirectory ?? this.archiveDirectory();
    if (directory) await fs.mkdir(directory, { recursive: true });
    if (this.disposed) return;
    const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(directory ?? os.homedir(), filename)), filters: { CSV: ['csv'] }, title: range ? '保存 A/B 区间 CSV' : '保存全部 CSV' });
    if (!uri || this.disposed || this.tabs.get(tab.info.id) !== tab) return;
    await this.trackJob(vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '正在保存 Timeline CSV', cancellable: true }, (_progress, token) =>
      this.withCancellation(token, signal => tab.store!.save(uri.fsPath, range, view, signal, snapshot))));
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
