import * as vscode from 'vscode';
import { OzoneBackend } from '../ozone-backend/commander';
import { DataSamplingEntry, DataPoint, DataSampleSnapshot, WatchValue } from '../ozone-backend/types';

const COLORS = ['#4EC9B0', '#569CD6', '#DCDCA4', '#C586C0', '#D16969', '#CE9178', '#6A9955', '#42C6FF', '#B5CEA8', '#FFD700'];
const MAX_POINTS_PER_VAR = 50000;
const SAMPLE_INTERVAL_MS = 10;
const SEND_INTERVAL_MS = 10;

export class DataSamplingManager {
  private entries: DataSamplingEntry[] = [];
  private dataMap = new Map<string, DataPoint[]>();
  private pendingMap = new Map<string, DataPoint[]>();
  private timer: NodeJS.Timeout | null = null;
  private sendTimer: NodeJS.Timeout | null = null;
  private colorIndex = 0;
  private onSamples: ((snapshots: DataSampleSnapshot[]) => void) | null = null;
  private backend: OzoneBackend;

  onExpressionsChanged: ((exprs: { expression: string; color: string }[]) => void) | null = null;

  constructor(backend: OzoneBackend) {
    this.backend = backend;
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
    if (!this.timer) this.startSampling();
    if (this.onExpressionsChanged) this.onExpressionsChanged(this.entries.map(e => ({ expression: e.expression, color: e.color })));
  }

  removeExpression(expression: string) {
    this.entries = this.entries.filter(e => e.expression !== expression);
    this.dataMap.delete(expression);
    this.pendingMap.delete(expression);
    if (this.entries.length === 0) this.stopSampling();
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
    if (this.entries.length > 0 && !this.timer) this.startSampling();
    else if (this.entries.length === 0) this.stopSampling();
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
      if (this.onExpressionsChanged) this.onExpressionsChanged(this.entries.map(e => ({ expression: e.expression, color: e.color })));
    }
  }

  getAllData(expression: string): DataPoint[] {
    return this.dataMap.get(expression) || [];
  }

  clearData() {
    for (const [expr] of this.dataMap) {
      this.dataMap.set(expr, []);
      this.pendingMap.set(expr, []);
    }
  }

  private _stopped = false;

  private startSampling() {
    this._stopped = false;
    this.sampleLoop();
    this.sendTimer = setInterval(() => this.flush(), SEND_INTERVAL_MS);
  }

  stopSampling() {
    this._stopped = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.sendTimer) { clearInterval(this.sendTimer); this.sendTimer = null; }
  }

  private async sampleLoop() {
    if (this._stopped) return;
    await this.sample();
    if (this._stopped) return;
    this.timer = setTimeout(() => this.sampleLoop(), SAMPLE_INTERVAL_MS);
  }

  private async isHalted(): Promise<boolean> {
    const session = vscode.debug.activeDebugSession;
    if (session && session.type === 'ozone') {
      try {
        const r: any = await session.customRequest('getTargetState', {});
        if (r && r.state === 'halted') return true;
        if (r && r.state === 'running') return false;
      } catch {}
    }
    const r = await this.backend.execute({ cmd: 'getTargetState' });
    return r.ok && r.data === 'halted';
  }

  private async sample() {
    if (await this.isHalted()) return;
    if (this.entries.length === 0) return;
    const now = Date.now();
    const exprs = this.entries.map(e => e.expression);
    const values = await this.readValues(exprs);
    for (let i = 0; i < this.entries.length; i++) {
      const wv = values[i];
      if (!wv || wv.error) continue;
      const entry = this.entries[i];
      const pt: DataPoint = { timestamp: now, value: wv.value, display: wv.display };
      const pts = this.dataMap.get(entry.expression);
      if (pts) {
        pts.push(pt);
        if (pts.length > MAX_POINTS_PER_VAR) pts.splice(0, pts.length - MAX_POINTS_PER_VAR);
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
    }
    const results: (WatchValue | null)[] = [];
    for (const expr of exprs) {
      const result = await this.backend.execute({ cmd: 'evaluateExpression', expression: expr, force: true });
      if (result.ok) results.push(result.data as WatchValue);
      else results.push(null);
    }
    return results;
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
    this.entries = [];
    this.dataMap.clear();
    this.pendingMap.clear();
  }
}
