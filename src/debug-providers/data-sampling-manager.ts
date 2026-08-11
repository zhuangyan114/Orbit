import * as vscode from 'vscode';
import { OzoneBackend } from '../ozone-backend/commander';
import { DataSamplingEntry, DataPoint, DataSampleSnapshot, WatchValue } from '../ozone-backend/types';
import { trimTimelineHistory } from '../utils/timeline-history';
import { getOrbitConfiguration } from '../utils/orbit-settings';
import {
  getTimelineHistoryBounds,
  sliceTimelineRange,
  type TimelineHistoryBounds,
} from '../webview/timeline/timeline-range';

const COLORS = ['#4EC9B0', '#569CD6', '#DCDCA4', '#C586C0', '#D16969', '#CE9178', '#6A9955', '#42C6FF', '#B5CEA8', '#FFD700'];
const DEFAULT_SAMPLE_INTERVAL_MS = 0.2;
const DEFAULT_SEND_INTERVAL_MS = 16;
const MIN_INTERVAL_MS = 0.1;
const MAX_INTERVAL_MS = 10000;

export class DataSamplingManager {
  private entries: DataSamplingEntry[] = [];
  private dataMap = new Map<string, DataPoint[]>();
  private pendingMap = new Map<string, DataPoint[]>();
  private timer: NodeJS.Timeout | null = null;
  private sendTimer: NodeJS.Timeout | null = null;
  private colorIndex = 0;
  private onSamples: ((snapshots: DataSampleSnapshot[]) => void) | null = null;
  private backend: OzoneBackend;
  private sampleIntervalMs = DEFAULT_SAMPLE_INTERVAL_MS;
  private sendIntervalMs = DEFAULT_SEND_INTERVAL_MS;
  private remoteSession: vscode.DebugSession | null = null;
  private remoteSampling = false;
  private samplingGeneration = 0;
  private readonly disposables: vscode.Disposable[] = [];

  onExpressionsChanged: ((exprs: { expression: string; color: string }[]) => void) | null = null;

  constructor(backend: OzoneBackend) {
    this.backend = backend;
    this.refreshIntervals();
    this.disposables.push(vscode.workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration('orbit.timelineSampleIntervalMs') && !e.affectsConfiguration('orbit.timelineSendIntervalMs') &&
          !e.affectsConfiguration('ozone.timelineSampleIntervalMs') && !e.affectsConfiguration('ozone.timelineSendIntervalMs')) return;
      const previousSendInterval = this.sendIntervalMs;
      this.refreshIntervals();
      if (this.sendTimer && previousSendInterval !== this.sendIntervalMs) {
        clearInterval(this.sendTimer);
        this.sendTimer = setInterval(() => this.flush(), this.sendIntervalMs);
      }
      void this.syncSamplingMode();
    }));
    this.disposables.push(vscode.debug.onDidChangeActiveDebugSession(() => void this.syncSamplingMode()));
    this.disposables.push(vscode.debug.onDidTerminateDebugSession(session => {
      if (session.type !== 'ozone') return;
      if (this.remoteSession === session) {
        this.remoteSession = null;
        this.remoteSampling = false;
      }
      void this.syncSamplingMode();
    }));
    this.disposables.push(vscode.debug.onDidReceiveDebugSessionCustomEvent(event => {
      if (event.session === this.remoteSession
        && event.session === vscode.debug.activeDebugSession
        && event.event === 'ozoneDataSamples') {
        this.acceptRemoteSamples(event.body?.snapshots || []);
      }
    }));
  }

  setOnSamples(cb: ((snapshots: DataSampleSnapshot[]) => void) | null) {
    this.onSamples = cb;
  }

  get expressionList(): string[] {
    return this.entries.map(e => e.expression);
  }

  get entriesList(): ReadonlyArray<DataSamplingEntry> {
    return this.entries;
  }

  addExpression(expression: string) {
    if (this.entries.some(e => e.expression === expression)) return;
    const color = COLORS[this.colorIndex % COLORS.length];
    this.colorIndex++;
    this.entries.push({ expression, enabled: true, color });
    this.dataMap.set(expression, []);
    this.pendingMap.set(expression, []);
    void this.syncSamplingMode();
    if (this.onExpressionsChanged) this.onExpressionsChanged(this.entries.map(e => ({ expression: e.expression, color: e.color })));
  }

  removeExpression(expression: string) {
    this.entries = this.entries.filter(e => e.expression !== expression);
    this.dataMap.delete(expression);
    this.pendingMap.delete(expression);
    void this.syncSamplingMode();
    if (this.onExpressionsChanged) this.onExpressionsChanged(this.entries.map(e => ({ expression: e.expression, color: e.color })));
  }

  setExpressions(expressions: ({ expression: string; color?: string } | string)[]) {
    this.entries = [];
    this.dataMap.clear();
    this.pendingMap.clear();
    this.colorIndex = 0;
    for (const spec of expressions) {
      if (!spec) continue;
      const expr = typeof spec === 'string' ? spec : spec.expression;
      if (!expr) continue;
      const color = typeof spec === 'string' ? COLORS[this.colorIndex % COLORS.length] : (spec.color || COLORS[this.colorIndex % COLORS.length]);
      if (typeof spec !== 'string' && !spec.color) this.colorIndex++;
      else if (typeof spec === 'string') this.colorIndex++;
      this.entries.push({ expression: expr, enabled: true, color });
      this.dataMap.set(expr, []);
      this.pendingMap.set(expr, []);
    }
    void this.syncSamplingMode();
    if (this.onExpressionsChanged) this.onExpressionsChanged(this.entries.map(e => ({ expression: e.expression, color: e.color })));
  }

  toggleExpression(expression: string, enabled: boolean) {
    const entry = this.entries.find(e => e.expression === expression);
    if (entry) entry.enabled = enabled;
  }

  setColor(expression: string, color: string) {
    const entry = this.entries.find(e => e.expression === expression);
    if (entry) {
      entry.color = color;
      void this.syncSamplingMode();
      if (this.onExpressionsChanged) this.onExpressionsChanged(this.entries.map(e => ({ expression: e.expression, color: e.color })));
    }
  }

  getAllData(expression: string): DataPoint[] {
    return this.dataMap.get(expression) || [];
  }

  getHistoryBounds(): TimelineHistoryBounds | null {
    return getTimelineHistoryBounds(this.dataMap.values());
  }

  getDataRange(expression: string, start: number, end: number): DataPoint[] {
    return sliceTimelineRange(this.dataMap.get(expression) || [], start, end);
  }

  clearData() {
    for (const [expr] of this.dataMap) {
      this.dataMap.set(expr, []);
      this.pendingMap.set(expr, []);
    }
  }

  private _stopped = false;

  private async syncSamplingMode() {
    const generation = ++this.samplingGeneration;
    if (this.entries.length === 0) {
      await this.stopRemoteSampling();
      this.stopLocalSampling();
      return;
    }

    const session = vscode.debug.activeDebugSession;
    if (session && session.type === 'ozone') {
      this.stopLocalSampling();
      await this.startRemoteSampling(session, generation);
      return;
    }

    await this.stopRemoteSampling();
    if (!this.backend.hasTargetConnection) {
      this.stopLocalSampling();
      return;
    }
    if (!this.timer) this.startSampling();
  }

  private async startRemoteSampling(session: vscode.DebugSession, generation: number) {
    try {
      const response: any = await session.customRequest('dataSamplingStart', {
        entries: this.entries.map(e => ({ expression: e.expression, color: e.color })),
        sampleIntervalMs: this.sampleIntervalMs,
        sendIntervalMs: this.sendIntervalMs,
      });
      if (response?.ok === false) throw new Error(response?.message || 'remote sampler rejected expressions');
      if (generation !== this.samplingGeneration || vscode.debug.activeDebugSession !== session) {
        try { await session.customRequest('dataSamplingStop', {}); } catch {}
        return;
      }
      this.remoteSession = session;
      this.remoteSampling = true;
    } catch {
      this.remoteSession = null;
      this.remoteSampling = false;
      const activeSession = vscode.debug.activeDebugSession;
      if ((!activeSession || activeSession.type !== 'ozone') && !this.timer) this.startSampling();
    }
  }

  private async stopRemoteSampling() {
    if (!this.remoteSampling || !this.remoteSession) return;
    const session = this.remoteSession;
    this.remoteSampling = false;
    this.remoteSession = null;
    try { await session.customRequest('dataSamplingStop', {}); } catch {}
  }

  private stopLocalSampling() {
    this._stopped = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.sendTimer) { clearInterval(this.sendTimer); this.sendTimer = null; }
  }

  private startSampling() {
    this._stopped = false;
    this.sampleLoop();
    this.sendTimer = setInterval(() => this.flush(), this.sendIntervalMs);
  }

  stopSampling() {
    this.samplingGeneration++;
    void this.stopRemoteSampling();
    this.stopLocalSampling();
  }

  private async sampleLoop() {
    if (this._stopped) return;
    if (!this.backend.hasTargetConnection) {
      this.stopLocalSampling();
      return;
    }
    const started = Date.now();
    await this.sample();
    if (this._stopped) return;
    const elapsed = Date.now() - started;
    const delay = Math.max(MIN_INTERVAL_MS, this.sampleIntervalMs - elapsed);
    this.timer = setTimeout(() => this.sampleLoop(), delay);
  }

  private refreshIntervals() {
    this.sampleIntervalMs = this.getConfiguredInterval('timelineSampleIntervalMs', DEFAULT_SAMPLE_INTERVAL_MS);
    this.sendIntervalMs = this.getConfiguredInterval('timelineSendIntervalMs', DEFAULT_SEND_INTERVAL_MS);
  }

  private getConfiguredInterval(key: string, defaultValue: number): number {
    const value = getOrbitConfiguration().get<number>(key, defaultValue);
    if (!Number.isFinite(value)) return defaultValue;
    return Math.max(MIN_INTERVAL_MS, Math.min(MAX_INTERVAL_MS, value));
  }

  private async isHalted(): Promise<boolean> {
    const session = vscode.debug.activeDebugSession;
    if (session && session.type === 'ozone') {
      try {
        const r: any = await session.customRequest('getTargetState', {});
        if (r && r.state === 'halted') return true;
        if (r && r.state === 'running') return false;
      } catch {}
      return false;
    }
    const r = await this.backend.execute({ cmd: 'getTargetState' });
    return r.ok && r.data === 'halted';
  }

  private async sample() {
    if (!this.backend.hasTargetConnection) return;
    if (await this.isHalted()) return;
    if (this.entries.length === 0) return;
    const now = Date.now();
    const exprs = this.entries.map(e => e.expression);
    const values = await this.readValues(exprs);
    for (let i = 0; i < this.entries.length; i++) {
      const wv = values[i];
      if (!wv || wv.error) continue;
      if (typeof wv.value !== 'number' || !Number.isFinite(wv.value)) continue;
      const entry = this.entries[i];
      const pt: DataPoint = { timestamp: now, value: wv.value, display: wv.display };
      const pts = this.dataMap.get(entry.expression);
      if (pts) {
        pts.push(pt);
        trimTimelineHistory(pts);
      }
      const pending = this.pendingMap.get(entry.expression);
      if (pending) pending.push(pt);
    }
  }

  private async readValues(exprs: string[]): Promise<(WatchValue | null)[]> {
    const session = vscode.debug.activeDebugSession;
    if (session && session.type === 'ozone') {
      try {
        const r: any = await session.customRequest('dataSample', { expressions: exprs });
        if (r && r.results) return r.results;
      } catch {}
      return exprs.map(() => null);
    }
    const results: (WatchValue | null)[] = [];
    for (const expr of exprs) {
      const result = await this.backend.execute({ cmd: 'evaluateExpression', expression: expr, force: true });
      if (result.ok) results.push(result.data as WatchValue);
      else results.push(null);
    }
    return results;
  }

  private acceptRemoteSamples(snapshots: DataSampleSnapshot[]) {
    const accepted: DataSampleSnapshot[] = [];
    const entryByExpression = new Map(this.entries.map(entry => [entry.expression, entry]));
    for (const snapshot of snapshots) {
      const entry = entryByExpression.get(snapshot.expression);
      if (!entry || !Array.isArray(snapshot.data) || snapshot.data.length === 0) continue;
      const pts = this.dataMap.get(snapshot.expression) || [];
      pts.push(...snapshot.data);
      trimTimelineHistory(pts);
      this.dataMap.set(snapshot.expression, pts);
      accepted.push({
        expression: snapshot.expression,
        color: entry.color,
        currentValue: snapshot.currentValue,
        data: snapshot.data,
      });
    }
    if (accepted.length > 0 && this.onSamples) this.onSamples(accepted);
  }

  private flush() {
    if (this.pendingMap.size === 0) return;
    const snapshots: DataSampleSnapshot[] = [];
    let hasData = false;
    for (const entry of this.entries) {
      const pending = this.pendingMap.get(entry.expression);
      if (!pending || pending.length === 0) continue;
      const allData = this.dataMap.get(entry.expression) || [];
      const currentValue = allData.length > 0 ? allData[allData.length - 1].display : '';
      snapshots.push({
        expression: entry.expression,
        color: entry.color,
        currentValue,
        data: pending.splice(0),
      });
      hasData = true;
    }
    if (!hasData) return;
    if (this.onSamples) this.onSamples(snapshots);
  }

  dispose() {
    this.stopSampling();
    for (const disposable of this.disposables) disposable.dispose();
    this.entries = [];
    this.dataMap.clear();
    this.pendingMap.clear();
  }
}
