import * as fs from 'fs/promises';
import { createReadStream } from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { StringDecoder } from 'string_decoder';
import type { DataSampleSnapshot } from '../ozone-backend/types';
import { createTimelineEntry } from '../webview/timeline/timeline-entry-state';
import type { TimelineHistoryBounds } from '../webview/timeline/timeline-range';
import { decimateTimelineRange } from '../webview/timeline/timeline-decimation';
import { DEFAULT_TIMELINE_VIEW, validTimelineView, type TimelineChannel, type TimelineMeta, type TimelineRow, type TimelineViewState } from './timeline-model';

const INDEX_BYTES = 56;
const FANOUT = 16;
const MAX_LEVEL = 8;
const MAX_LINE = 1024 * 1024;
const ROW_ESTIMATE = 128;
const QUEUE_BUDGET = 8 * 1024 * 1024;
const HOT_BUDGET = 64 * 1024 * 1024;
const CACHE_BUDGET = 28 * 1024 * 1024;
const INDEX_PAGE_BUDGET = 4 * 1024 * 1024;
const INDEX_PAGE_ENTRIES = 64;
const yieldTurn = () => new Promise<void>(resolve => setImmediate(resolve));

/** Shared file scheduler. Target access remains in the existing NativeScheduler. */
class FileScheduler {
  private queue: { priority: number; run: () => Promise<unknown>; resolve: (v: any) => void; reject: (e: unknown) => void }[] = [];
  private running = false;
  run<T>(priority: number, run: () => Promise<T>): Promise<T> {
    if (this.queue.length >= 64) return Promise.reject(new Error('Timeline 文件任务过多，请重试'));
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ priority, run, resolve, reject });
      this.pump();
    });
  }
  private async pump() {
    if (this.running) return;
    this.running = true;
    while (this.queue.length) {
      let best = 0;
      for (let i = 1; i < this.queue.length; i++) if (this.queue[i].priority < this.queue[best].priority) best = i;
      const item = this.queue.splice(best, 1)[0];
      try { item.resolve(await item.run()); } catch (e) { item.reject(e); }
      await yieldTurn();
    }
    this.running = false;
  }
}
const scheduler = new FileScheduler();
let hotBytes = 0;
let queuedBytes = 0;
const hotStores = new Set<TimelineRecordStore>();
const blockCache = new Map<string, { rows: TimelineRow[]; bytes: number }>();
let cacheBytes = 0;
const indexPages = new Map<string, Buffer>();
let indexPageBytes = 0;
const readHandles = new Map<string, fs.FileHandle>();
async function readAt(filePath: string, offset: number, length: number) {
  // Called only inside the serialized file scheduler, so eviction cannot close an in-flight reader.
  let handle = readHandles.get(filePath);
  if (!handle) {
    handle = await fs.open(filePath, 'r');
    if (readHandles.size >= 32) { const key = readHandles.keys().next().value!; await readHandles.get(key)!.close(); readHandles.delete(key); }
  }
  readHandles.delete(filePath); readHandles.set(filePath, handle);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || length > 16 * 1024 * 1024) throw new Error('Timeline 索引偏移或块大小不合法');
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, offset);
  return buffer.subarray(0, bytesRead);
}

function cacheBlock(key: string, rows: TimelineRow[]) {
  const bytes = rows.length * ROW_ESTIMATE;
  if (bytes > CACHE_BUDGET) return;
  const previous = blockCache.get(key);
  if (previous) cacheBytes -= previous.bytes;
  blockCache.delete(key);
  blockCache.set(key, { rows, bytes });
  cacheBytes += bytes;
  while (cacheBytes > CACHE_BUDGET) {
    const first = blockCache.keys().next().value!;
    cacheBytes -= blockCache.get(first)!.bytes;
    blockCache.delete(first);
  }
}
export interface TimelineSaveSnapshot {
  cutoff: number;
  channels: TimelineChannel[];
  meta: TimelineMeta;
  view: TimelineViewState;
  tail: TimelineRow[];
  fence: Promise<void>;
}
interface NodeIndex { start: number; end: number; payloadOffset: number; payloadLength: number; from: number; to: number; rows: number; }
function encodeIndex(n: NodeIndex) {
  const b = Buffer.alloc(INDEX_BYTES);
  [n.start, n.end, n.payloadOffset, n.payloadLength, n.from, n.to, n.rows].forEach((v, i) => b.writeDoubleLE(v, i * 8));
  return b;
}
function decodeIndex(b: Buffer): NodeIndex {
  const v = Array.from({ length: 7 }, (_, i) => b.readDoubleLE(i * 8));
  if (!v.every(Number.isFinite) || v[0] < 0 || v[1] < v[0] || !v.slice(2).every(n => Number.isSafeInteger(n) && n >= 0) || v[3] > 16 * 1024 * 1024 || v[5] < v[4]) throw new Error('Timeline 索引损坏');
  return { start: v[0], end: v[1], payloadOffset: v[2], payloadLength: v[3], from: v[4], to: v[5], rows: v[6] };
}
function rowLine(p: TimelineRow) { return p.timestamp + ',' + p.channelId + ',' + p.value + ',' + p.segmentId + '\r\n'; }
function parseRow(line: string): TimelineRow {
  const values = line.split(',');
  if (values.length !== 4 || values.some(v => v.trim() === '')) throw new Error('CSV 数据行必须包含四列');
  const [timestamp, channelId, value, segmentId] = values.map(Number);
  if (![timestamp, value].every(Number.isFinite) || timestamp < 0 || !Number.isSafeInteger(channelId) || channelId < 0
    || !Number.isSafeInteger(segmentId) || segmentId < 0) throw new Error('CSV 数据包含非法时间、通道或数值');
  return { timestamp, channelId, value, segmentId, display: String(value) };
}
function summarize(rows: readonly TimelineRow[]): TimelineRow[] {
  const groups = new Map<number, TimelineRow[]>();
  for (const row of rows) { const group = groups.get(row.channelId) ?? []; group.push(row); groups.set(row.channelId, group); }
  const result: TimelineRow[] = [];
  for (const group of groups.values()) {
    const segments = new Map<number, TimelineRow[]>();
    for (const row of group) { const segment = segments.get(row.segmentId) ?? []; segment.push(row); segments.set(row.segmentId, segment); }
    const extrema = (points: TimelineRow[]) => {
      let min = points[0], max = points[0];
      for (const row of points) { if (row.value < min.value) min = row; if (row.value > max.value) max = row; }
      return [...new Set([points[0], min, max, points[points.length - 1]])].sort((a, b) => a.timestamp - b.timestamp);
    };
    const chosen = [...segments.values()].flatMap(extrema);
    // Keep summaries bounded even for pathological alternating gaps. A parent
    // cannot repair missing boundaries: refine such nodes during display reads.
    const refine = chosen.length > 256 || group.some(p => p.summaryNeedsRefine);
    for (const row of refine ? extrema(group) : chosen) result.push({ ...row, summaryVersion: 2, summaryNeedsRefine: refine });
  }
  return result.sort((a, b) => a.timestamp - b.timestamp || a.channelId - b.channelId);
}
function header(meta: TimelineMeta, channels: TimelineChannel[], view: TimelineViewState) {
  const lines = [JSON.stringify(meta), JSON.stringify(channels), JSON.stringify(view)];
  if (lines.some(line => Buffer.byteLength(line) > MAX_LINE - 32)) throw new Error('CSV 配置超过单行 1 MiB 限制，请减少通道或表达式长度');
  return '# orbit-timeline-version=1\r\n# meta=' + JSON.stringify(meta)
    + '\r\n# channels=' + JSON.stringify(channels) + '\r\n# view=' + JSON.stringify(view)
    + '\r\ntime_ms,channel_id,value,segment_id\r\n';
}
function bounded<T>(promise: Promise<T>, ms = 15000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeline 磁盘操作超时')), ms);
    promise.then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); });
  });
}

/** CSV is authoritative. Indexes and display summaries are rebuildable caches. */
export class TimelineRecordStore {
  readonly id: string;
  readonly csvPath!: string;
  readonly directory!: string;
  meta!: TimelineMeta;
  channels: TimelineChannel[] = [];
  view: TimelineViewState = structuredClone(DEFAULT_TIMELINE_VIEW);
  bounds: TimelineHistoryBounds | null = null;
  error: string | undefined;
  live = true;
  acceptedRows = 0;
  writtenRows = 0;
  checkpointRows = 0;
  onError?: (message: string) => void;
  private sampleRateChannels = new Map<number, { last: number; segmentId: number; intervals: number; durationMs: number }>();
  private restoredAverageSampleRateHz = 0;

  getAverageSampleRateHz(): number {
    let total = 0, count = 0;
    for (const channel of this.sampleRateChannels.values()) {
      if (channel.durationMs <= 0) continue;
      total += channel.intervals * 1000 / channel.durationMs;
      count++;
    }
    return count ? total / count : this.restoredAverageSampleRateHz;
  }

  getDescriptor() {
    return { id: this.id, meta: structuredClone(this.meta), channels: structuredClone(this.channels), view: structuredClone(this.view), bounds: this.bounds, offset: this.offset, complete: !this.live && !this.error, fileStamp: this.fileStamp, averageSampleRateHz: this.getAverageSampleRateHz() };
  }
  static async restore(base: string, descriptor: ReturnType<TimelineRecordStore['getDescriptor']>): Promise<TimelineRecordStore> {
    if (!descriptor || !/^[0-9a-f-]{36}$/i.test(descriptor.id) || !validTimelineView(descriptor.view) || !Array.isArray(descriptor.channels)) throw new Error('Timeline 恢复配置不合法');
    const store = new TimelineRecordStore(base, descriptor.meta.name, descriptor.meta.source, descriptor.id);
    const stat = await fs.stat(store.csvPath);
    if (descriptor.complete && (!descriptor.fileStamp || descriptor.fileStamp.size !== stat.size || descriptor.fileStamp.mtimeMs !== stat.mtimeMs)) throw new Error('Timeline 文件已改变，需重建索引');
    store.fileStamp = descriptor.fileStamp;
    if (Number.isFinite(descriptor.averageSampleRateHz) && descriptor.averageSampleRateHz >= 0) store.restoredAverageSampleRateHz = descriptor.averageSampleRateHz;
    store.meta = descriptor.meta; store.channels = descriptor.channels; store.view = descriptor.view;
    store.meta.complete = descriptor.complete && descriptor.meta.complete;
    if (!store.meta.complete) store.error = '上次录制未正常结束，记录可能不完整';
    let lastIndexed = 0;
    for (let level = 0; level <= MAX_LEVEL; level++) {
      const indexStat = await fs.stat(path.join(store.directory, level + '.index')).catch(() => null);
      if (!indexStat) continue;
      if (indexStat.size % INDEX_BYTES !== 0) throw new Error('Timeline 索引中断，需重建');
      store.counts[level] = indexStat.size / INDEX_BYTES;
      const summaryStat = await fs.stat(path.join(store.directory, level + '.summary'));
      if (store.counts[level]) { const last = await store.readIndex(level, store.counts[level] - 1); if (last.payloadOffset + last.payloadLength > summaryStat.size) throw new Error('Timeline 摘要缓存截断'); }
      if (level === 0) {
        for (let i = 0; i < store.counts[0]; i++) { const n = await store.readIndex(0, i); store.acceptedRows += n.rows; lastIndexed = n.to; if (!store.bounds) store.bounds = { start: n.start, end: n.end }; else store.bounds.end = n.end; }
      }
    }
    if (store.counts[0] === 0 && descriptor.bounds) throw new Error('Timeline 索引已丢失，需重建');
    if (lastIndexed > stat.size) throw new Error('Timeline 原始文件截断，需重建');
    // Extra bytes in a finished file are configuration/end comments. An unfinished
    // file may contain raw rows beyond its last committed index, so rebuild it.
    if (!descriptor.complete && stat.size > lastIndexed) throw new Error('Timeline 异常退出记录需重建');
    store.writtenRows = store.acceptedRows; store.checkpointRows = store.writtenRows;
    store.offset = stat.size;
    return store;
  }
  getMetrics() {
    return { acceptedRows: this.acceptedRows, writtenRows: this.writtenRows, checkpointRows: this.checkpointRows,
      hotRows: this.hot.length - this.hotStart, globalHotBytes: hotBytes, globalQueuedBytes: queuedBytes,
      globalHistoryCacheBytes: cacheBytes + indexPageBytes, indexNodes: [...this.counts] };
  }
  private origin: number | null = null;
  private activeChannels = new Map<string, TimelineChannel>();
  private segments = new Map<number, number>();
  private hot: TimelineRow[] = [];
  private hotStart = 0;
  private queue: TimelineRow[] = [];
  private queuedBytes = 0;
  private disk: fs.FileHandle | undefined;
  private ready: Promise<void>;
  private writing: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;
  private offset = 0;
  private counts = Array(MAX_LEVEL + 1).fill(0) as number[];
  private payloadOffsets = Array(MAX_LEVEL + 1).fill(0) as number[];
  private pending: { node: NodeIndex; summary: TimelineRow[] }[][] = Array.from({ length: MAX_LEVEL + 1 }, () => []);
  private lastCheckpoint = 0;
  private closed = false;
  private ending: Promise<void> | undefined;
  private lastRawTime = -Infinity;
  private fileStamp: { size: number; mtimeMs: number } | undefined;
  private events: string[] = [];

  constructor(baseDirectory: string, name: string, source: 'debug' | 'import' = 'debug', existingId?: string) {
    this.id = existingId ?? randomUUID();
    this.directory = path.join(baseDirectory, this.id);
    this.csvPath = path.join(this.directory, 'record.csv');
    this.meta = { recordId: this.id, name, timeUnit: 'ms', timeOriginUtc: new Date().toISOString(), source, complete: true };
    if (existingId) { this.live = false; this.closed = true; this.ready = Promise.resolve(); return; }
    hotStores.add(this);
    this.ready = (async () => {
      await fs.mkdir(this.directory, { recursive: true });
      this.disk = await fs.open(this.csvPath, 'wx');
      // Metadata is finalized on save; channel events describe the growing work file.
      const text = header(this.meta, [], this.view);
      await this.disk.writeFile(text);
      this.offset = Buffer.byteLength(text);
    })().catch(e => { this.fail(e); });
  }
  private fail(error: unknown) {
    if (this.error) return;
    this.error = error instanceof Error ? error.message : String(error);
    this.meta.complete = false;
    this.queue = [];
    queuedBytes -= this.queuedBytes;
    this.queuedBytes = 0;
    this.onError?.(this.error);
  }
  syncChannels(entries: TimelineViewState['entries']) {
    const requested = new Set(entries.map(e => e.expression));
    for (const [expression, channel] of this.activeChannels) if (!requested.has(expression)) { channel.active = false; this.activeChannels.delete(expression); }
    for (const entry of entries) {
      let channel = this.activeChannels.get(entry.expression);
      if (!channel) {
        channel = { ...entry, id: this.channels.length, active: true };
        if (channel.id >= 1024) { this.fail('Timeline 通道注册次数超过 1024，请开始新记录'); return; }
        this.channels.push(channel);
        this.activeChannels.set(entry.expression, channel);
        this.events.push('# orbit.channel=' + JSON.stringify(channel) + '\r\n');
      } else Object.assign(channel, entry);
    }
  }
  private updateBounds(rows: readonly TimelineRow[]) {
    for (const row of rows) {
      if (!this.bounds) this.bounds = { start: row.timestamp, end: row.timestamp };
      else { this.bounds.start = Math.min(this.bounds.start, row.timestamp); this.bounds.end = Math.max(this.bounds.end, row.timestamp); }
    }
  }
  append(snapshots: DataSampleSnapshot[]): DataSampleSnapshot[] {
    if (!this.live || this.closed) return [];
    const rows: TimelineRow[] = [];
    const output: DataSampleSnapshot[] = [];
    const first = Math.min(...snapshots.flatMap(s => s.data.length ? [s.data[0].timestamp] : []));
    if (this.origin === null && Number.isFinite(first)) { this.origin = first; this.meta.timeOriginUtc = new Date(first).toISOString(); this.events.push('# orbit.origin=' + JSON.stringify(this.meta.timeOriginUtc) + '\r\n'); }
    for (const snapshot of snapshots) {
      const channel = this.activeChannels.get(snapshot.expression);
      if (!channel) continue;
      const data: TimelineRow[] = [];
      for (const point of snapshot.data) {
        if (!Number.isFinite(point.timestamp) || !Number.isFinite(point.value)) continue;
        const timestamp = point.timestamp - (this.origin ?? 0);
        if (timestamp < this.lastRawTime) { this.fail('采样时钟回退，记录不完整，请开始新记录'); continue; }
        let segmentId = this.segments.get(channel.id) ?? 0;
        const startsNewSegment = point.startsNewSegment || !this.segments.has(channel.id);
        if (startsNewSegment) segmentId++;
        this.segments.set(channel.id, segmentId);
        const row = { ...point, timestamp, channelId: channel.id, segmentId, startsNewSegment };
        rows.push(row); data.push(row);
      }
      if (data.length) output.push({ ...snapshot, data });
    }
    rows.sort((a, b) => a.timestamp - b.timestamp || a.channelId - b.channelId);
    if (rows.length) this.lastRawTime = rows[rows.length - 1].timestamp;
    this.acceptRows(rows);
    return output;
  }
  private acceptRows(rows: TimelineRow[]) {
    // 实时写入和 CSV 导入共用原始点统计，跳过暂停产生的分段间隔。
    for (const row of rows) {
      const channel = this.sampleRateChannels.get(row.channelId);
      if (channel) {
        if (channel.segmentId === row.segmentId && row.timestamp > channel.last) {
          channel.intervals++;
          channel.durationMs += row.timestamp - channel.last;
        }
        channel.last = row.timestamp;
        channel.segmentId = row.segmentId;
      } else {
        this.sampleRateChannels.set(row.channelId, { last: row.timestamp, segmentId: row.segmentId, intervals: 0, durationMs: 0 });
      }
      row.sequence = ++this.acceptedRows;
    }
    this.updateBounds(rows);
    for (const row of rows) this.hot.push(row);
    hotBytes += rows.length * ROW_ESTIMATE;
    if (!this.error) {
      for (const row of rows) this.queue.push(row);
      this.queuedBytes += rows.length * ROW_ESTIMATE;
      queuedBytes += rows.length * ROW_ESTIMATE;
      if (queuedBytes > QUEUE_BUDGET) this.fail('CSV 写盘队列超过 8 MiB，持久记录已停止；实时显示继续，记录不完整');
      else if (this.queue.length >= 2048) void this.flush();
      else if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, 200);
    }
    this.trimHot();
  }
  private trimHot() {
    // Only one live record has a hot cache; completed/imported records release it.
    for (const store of hotStores) {
      while (hotBytes > HOT_BUDGET && store.hotStart < store.hot.length) { store.hotStart++; hotBytes -= ROW_ESTIMATE; }
      if (store.hotStart > 8192) { store.hot = store.hot.slice(store.hotStart); store.hotStart = 0; }
    }
  }
  private async addNode(level: number, node: NodeIndex, summary: TimelineRow[]) {
    const payload = Buffer.from(JSON.stringify(summary) + '\n');
    node.payloadOffset = this.payloadOffsets[level]; node.payloadLength = payload.length;
    await scheduler.run(0, async () => {
      await fs.appendFile(path.join(this.directory, level + '.summary'), payload);
      await fs.appendFile(path.join(this.directory, level + '.index'), encodeIndex(node));
    });
    this.counts[level]++; this.payloadOffsets[level] += payload.length;
    if (level >= MAX_LEVEL) return;
    const pending = this.pending[level]; pending.push({ node, summary });
    if (pending.length === FANOUT) {
      const group = pending.splice(0);
      await this.addNode(level + 1, { start: group[0].node.start, end: group[FANOUT - 1].node.end, from: group[0].node.from,
        to: group[FANOUT - 1].node.to, rows: group.reduce((n, g) => n + g.node.rows, 0), payloadOffset: 0, payloadLength: 0 }, summarize(group.flatMap(g => g.summary)));
    }
  }
  flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    const next = this.writing.then(async () => {
      await this.ready;
      if (this.error || !this.disk) return;
      const events = this.events.splice(0);
      for (const event of events) { await scheduler.run(0, () => this.disk!.writeFile(event)); this.offset += Buffer.byteLength(event); }
      let remaining = this.queue.length;
      while (remaining > 0 && !this.error) {
        const rows = this.queue.splice(0, Math.min(2048, remaining));
        remaining -= rows.length;
        const text = rows.map(rowLine).join('');
        const from = this.offset;
        await scheduler.run(0, () => this.disk!.writeFile(text));
        this.offset += Buffer.byteLength(text);
        await this.addNode(0, { start: rows[0].timestamp, end: rows[rows.length - 1].timestamp,
          from, to: this.offset, rows: rows.length, payloadOffset: 0, payloadLength: 0 }, summarize(rows));
        const released = Math.min(this.queuedBytes, rows.length * ROW_ESTIMATE);
        this.queuedBytes -= released;
        queuedBytes -= released;
        this.writtenRows += rows.length;
      }
      if (Date.now() - this.lastCheckpoint >= 1000) {
        await scheduler.run(0, () => this.disk!.sync());
        this.checkpointRows = this.writtenRows; this.lastCheckpoint = Date.now();
      }
    }).catch(e => { this.fail(e); });
    this.writing = next;
    return next;
  }
  private async readIndex(level: number, index: number): Promise<NodeIndex> {
    const page = Math.floor(index / INDEX_PAGE_ENTRIES);
    const offset = (index % INDEX_PAGE_ENTRIES) * INDEX_BYTES;
    const key = this.id + ':' + level + ':' + page;
    let buffer = indexPages.get(key);
    if (!buffer || buffer.length < offset + INDEX_BYTES) {
      buffer = await scheduler.run(1, () => readAt(path.join(this.directory, level + '.index'), page * INDEX_PAGE_ENTRIES * INDEX_BYTES, INDEX_PAGE_ENTRIES * INDEX_BYTES));
      const old = indexPages.get(key); if (old) indexPageBytes -= old.length;
      indexPages.delete(key); indexPages.set(key, buffer); indexPageBytes += buffer.length;
      while (indexPageBytes > INDEX_PAGE_BUDGET) { const first = indexPages.keys().next().value!; indexPageBytes -= indexPages.get(first)!.length; indexPages.delete(first); }
    } else { indexPages.delete(key); indexPages.set(key, buffer); }
    if (buffer.length < offset + INDEX_BYTES) throw new Error('Timeline 索引不完整');
    return decodeIndex(buffer.subarray(offset, offset + INDEX_BYTES));
  }
  private async readNodes(level: number, start: number, end: number, visit: (node: NodeIndex) => Promise<void>) {
    let lo = 0, hi = this.counts[level];
    while (lo < hi) { const mid = Math.floor((lo + hi) / 2); const node = await this.readIndex(level, mid); if (node.end < start) lo = mid + 1; else hi = mid; }
    for (let i = lo; i < this.counts[level]; i++) { const node = await this.readIndex(level, i); if (node.start > end) break; await visit(node); }
  }
  private async readPayload(node: NodeIndex, level: number, raw: boolean): Promise<TimelineRow[]> {
    const key = this.id + ':' + (raw ? 'raw' : level) + ':' + node.from;
    const cached = blockCache.get(key);
    if (cached) { blockCache.delete(key); blockCache.set(key, cached); return cached.rows; }
    const rows = await scheduler.run(1, async () => {
      const filePath = raw ? this.csvPath : path.join(this.directory, level + '.summary');
      const length = raw ? node.to - node.from : node.payloadLength;
      const buffer = await readAt(filePath, raw ? node.from : node.payloadOffset, length);
      if (buffer.length !== length) throw new Error('Timeline 记录已截断');
      return raw ? buffer.toString('utf8').trim().split(/\r?\n/).filter(l => l && !l.startsWith('#')).map(parseRow) : JSON.parse(buffer.toString('utf8')) as TimelineRow[];
    });
    cacheBlock(key, rows); return rows;
  }
  async query(start: number, end: number, buckets: number, raw = false, isCurrentQuery: () => boolean = () => true): Promise<DataSampleSnapshot[]> {
    if (![start, end, buckets].every(Number.isFinite) || end < start || buckets < 1) return [];
    if (!isCurrentQuery()) throw new Error('Timeline 查询已取消');
    const groups = new Map<number, TimelineRow[]>();
    const envelopes = new Map<number, Map<string, { first: TimelineRow; last: TimelineRow; min: TimelineRow; max: TimelineRow }>>();
    let rawCount = 0;
    const accept = (rows: readonly TimelineRow[]) => {
      for (const row of rows) if (row.timestamp >= start && row.timestamp <= end) {
        if (raw) {
          if (++rawCount > 250000) throw new Error('游标原始数据查询超过 250000 点，请缩小区间');
          const points = groups.get(row.channelId) ?? []; points.push(row); groups.set(row.channelId, points);
        } else {
          const bucket = end === start ? 0 : Math.min(buckets - 1, Math.floor((row.timestamp - start) / (end - start) * buckets));
          const channel = envelopes.get(row.channelId) ?? new Map();
          const key = bucket + ':' + row.segmentId;
          const current = channel.get(key);
          if (!current) channel.set(key, { first: row, last: row, min: row, max: row });
          else { current.last = row; if (row.value < current.min.value) current.min = row; if (row.value > current.max.value) current.max = row; }
          envelopes.set(row.channelId, channel);
        }
      }
    };
    const firstHot = this.hot[this.hotStart];
    if (firstHot && start >= firstHot.timestamp && !raw) {
      let lo = this.hotStart, hi = this.hot.length;
      while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (this.hot[mid].timestamp < start) lo = mid + 1; else hi = mid; }
      let after = lo; while (after < this.hot.length && this.hot[after].timestamp <= end) after++;
      accept(this.hot.slice(lo, after));
    }
    else {
      await bounded(this.flush());
      let level = 0;
      const resolution = (end - start) / buckets;
      const blockDuration = this.bounds && this.counts[0] ? (this.bounds.end - this.bounds.start) / this.counts[0] : Infinity;
      while (!raw && level < MAX_LEVEL && this.counts[level + 1] > 0 && blockDuration * FANOUT ** (level + 1) <= resolution * 2) level++;
      const visitLevel = async (current: number, from: number, to: number): Promise<void> => {
        let cursor = from;
        await this.readNodes(current, start, end, async node => {
          if (!isCurrentQuery()) throw new Error('Timeline 查询已取消');
          if (node.to <= from || node.from >= to) return;
          if (current > 0 && node.from > cursor) await visitLevel(current - 1, cursor, Math.min(node.from, to));
          if (current > 0 && (node.start < start || node.end > end)) await visitLevel(current - 1, Math.max(from, node.from), Math.min(to, node.to));
          else {
            const payload = await this.readPayload(node, current, raw || (current === 0 && node.end - node.start > resolution * 2));
            if (!raw && payload.some(p => p.summaryNeedsRefine || (p.startsNewSegment && p.summaryVersion !== 2))) {
              if (current > 0) await visitLevel(current - 1, Math.max(from, node.from), Math.min(to, node.to));
              else accept(await this.readPayload(node, 0, true));
            } else accept(payload);
          }
          cursor = Math.max(cursor, node.to);
        });
        if (current > 0 && cursor < to) await visitLevel(current - 1, cursor, to);
      };
      await visitLevel(level, 0, Infinity);
      // Failed persistence leaves the still available tail viewable, never advertises a complete archive.
      if (this.error) accept(this.hot.slice(this.hotStart));
    }
    if (!isCurrentQuery()) throw new Error('Timeline 查询已取消');
    if (!raw) for (const [channelId, channel] of envelopes) {
      const rows: TimelineRow[] = [];
      for (const bucket of channel.values()) for (const row of new Set([bucket.first, bucket.min, bucket.max, bucket.last])) rows.push(row);
      groups.set(channelId, rows);
    }
    const snapshots: DataSampleSnapshot[] = [];
    const byExpression = new Map<string, { channel: TimelineChannel; points: TimelineRow[] }>();
    for (const channel of this.channels) {
      const group = byExpression.get(channel.expression) ?? { channel, points: [] };
      group.channel = channel;
      for (const row of groups.get(channel.id) ?? []) group.points.push(row);
      byExpression.set(channel.expression, group);
    }
    for (const { channel, points: input } of byExpression.values()) {
      let points = input.sort((a, b) => a.timestamp - b.timestamp || a.channelId - b.channelId);
      if (!raw) points = points.filter((p, i) => i === 0 || p.timestamp !== points[i - 1].timestamp);
      // A query boundary is not a sampling boundary. The first point retains
      // its real flag/identity so overlapping incremental replies stay joined.
      for (let i = points.length - 1; i > 0; i--) if (points[i].segmentId !== points[i - 1].segmentId || points[i].channelId !== points[i - 1].channelId) points[i] = { ...points[i], startsNewSegment: true };
      if (!raw) points = decimateTimelineRange(points, start, end, buckets) as TimelineRow[];
      if (points.length) snapshots.push({ expression: channel.expression, color: channel.color, currentValue: String(points[points.length - 1].value), data: points });
    }
    return snapshots;
  }
  async measure(time: number): Promise<{ expression: string; value: number | null; timestamp: number | null }[]> {
    const data = await this.query(Math.max(0, time - 100), time + 100, 1, true);
    return this.channels.filter(c => c.active).map(channel => {
      const points = data.find(s => s.expression === channel.expression)?.data ?? [];
      let best: TimelineRow | undefined;
      for (const p of points as TimelineRow[]) if (!best || Math.abs(p.timestamp - time) < Math.abs(best.timestamp - time)) best = p;
      const after = points.find(p => p.timestamp >= time) as TimelineRow | undefined;
      const before = [...points].reverse().find(p => p.timestamp <= time) as TimelineRow | undefined;
      const gap = !before || !after || (before.timestamp !== after.timestamp && (before.segmentId !== after.segmentId || before.channelId !== after.channelId));
      // Derive tolerance from the two raw neighbours, bounded to 100 ms.
      const tolerance = before && after ? Math.min(100, Math.max(1, (after.timestamp - before.timestamp) * 1.5)) : 0;
      if (!best || gap || Math.abs(best.timestamp - time) > tolerance) return { expression: channel.expression, value: null, timestamp: null };
      return { expression: channel.expression, value: best.value, timestamp: best.timestamp };
    });
  }
  end(): Promise<void> {
    if (!this.ending) this.ending = bounded(this.finish()).catch(error => { this.fail(error); });
    return this.ending;
  }
  private async finish() {
    if (!this.live) return;
    this.live = false;
    await bounded(this.flush()).catch(e => this.fail(e));
    if (this.disk && !this.closed) {
      try { header(this.meta, this.channels, this.view); await this.disk.writeFile('# meta=' + JSON.stringify(this.meta) + '\r\n# channels=' + JSON.stringify(this.channels) + '\r\n# view=' + JSON.stringify(this.view) + '\r\n'); await this.disk.writeFile('# orbit.end=' + JSON.stringify({ kind: 'record', rows: this.writtenRows, fileFinalized: true, recordComplete: this.meta.complete && !this.error, rangeComplete: !this.error }) + '\r\n'); await this.disk.sync(); this.checkpointRows = this.writtenRows; } catch (e) { this.fail(e); }
      await this.disk.close().catch(() => {}); this.disk = undefined; this.closed = true;
      const stat = await fs.stat(this.csvPath).catch(() => null); if (stat) this.fileStamp = { size: stat.size, mtimeMs: stat.mtimeMs };
    }
    hotBytes -= (this.hot.length - this.hotStart) * ROW_ESTIMATE; this.hot = []; this.hotStart = 0; hotStores.delete(this);
    this.pending.forEach(nodes => { nodes.length = 0; });
  }
  captureSnapshot(range: TimelineHistoryBounds | null, view: TimelineViewState): TimelineSaveSnapshot {
    return { cutoff: this.acceptedRows, channels: structuredClone(this.channels),
      meta: { ...this.meta, exportRange: range ? { startMs: range.start, endMs: range.end } : undefined },
      view: structuredClone(view), tail: this.hot.slice(this.hotStart).filter(row => (row.sequence ?? 0) > this.writtenRows), fence: this.flush() };
  }
  async save(destination: string, range: TimelineHistoryBounds | null, view: TimelineViewState, signal?: AbortSignal, captured?: TimelineSaveSnapshot) {
    if (path.resolve(destination).toLowerCase() === path.resolve(this.csvPath).toLowerCase()) throw new Error('不能覆盖正在使用的 Timeline 工作文件');
    const snapshot = captured ?? this.captureSnapshot(range, view);
    const { cutoff, channels } = snapshot;
    const meta = { ...snapshot.meta, complete: snapshot.meta.complete && this.meta.complete };
    view = snapshot.view;
    await bounded(snapshot.fence);
    const diskLimit = Math.min(this.writtenRows, cutoff);
    const tail = snapshot.tail.filter(row => (row.sequence ?? 0) > diskLimit && (row.sequence ?? 0) <= cutoff);
    const rangeComplete = diskLimit + tail.length === cutoff;
    if (!rangeComplete) meta.complete = false;
    const temporary = destination + '.' + randomUUID() + '.tmp';
    const file = await fs.open(temporary, 'wx');
    let rowCount = 0, scanned = 0, buffer = '';
    try {
      await file.writeFile(header(meta, channels, view));
      if (diskLimit > 0) for await (const line of lines(this.csvPath)) {
        if (signal?.aborted) throw new Error('已取消保存');
        if (!line || line.startsWith('#') || line.startsWith('time_ms,')) continue;
        if (scanned >= diskLimit) break;
        scanned++;
        const p = parseRow(line);
        if (!range || (p.timestamp >= range.start && p.timestamp <= range.end)) { buffer += rowLine(p); rowCount++; }
        if (buffer.length >= 64 * 1024) { const text = buffer; buffer = ''; await scheduler.run(2, () => file.writeFile(text)); }
      }
      if (scanned < diskLimit) throw new Error('保存快照数据已截断');
      if (tail.length || !rangeComplete) {
        buffer += '# orbit.gap=' + JSON.stringify({ reason: this.error ?? 'persistence incomplete', missingRows: cutoff - diskLimit - tail.length }) + '\r\n';
        // A fresh segment namespace prevents drawing across a persistence gap.
        for (const p of tail) if (!range || (p.timestamp >= range.start && p.timestamp <= range.end)) {
          if (signal?.aborted) throw new Error('已取消保存');
          buffer += rowLine({ ...p, segmentId: p.segmentId + 1_000_000_000 }); rowCount++;
          if (buffer.length >= 64 * 1024) { const text = buffer; buffer = ''; await scheduler.run(2, () => file.writeFile(text)); }
        }
      }
      if (buffer) await scheduler.run(2, () => file.writeFile(buffer));
      await file.writeFile('# orbit.end=' + JSON.stringify({ kind: 'export', rows: rowCount, fileFinalized: true, recordComplete: meta.complete, rangeComplete }) + '\r\n');
      await file.sync(); await file.close();
      if (signal?.aborted) throw new Error('已取消保存');
      await fs.rename(temporary, destination);
    } catch (e) { await file.close().catch(() => {}); await fs.unlink(temporary).catch(() => {}); throw e; }
  }
  static async open(base: string, source: string, signal?: AbortSignal): Promise<TimelineRecordStore> {
    const sourceStat = await fs.stat(source);
    const store = new TimelineRecordStore(base, path.basename(source), 'import');
    await store.ready;
    let version = false, columns = false, ended = false, rowCount = 0, endRows = -1, lastTime = -Infinity;
    const defined = new Map<number, TimelineChannel>();
    const segments = new Map<number, number>();
    let batch: TimelineRow[] = [];
    let trailingFailure: unknown;
    const addChannel = (v: any) => {
      if (!v || !Number.isSafeInteger(v.id) || v.id < 0 || v.id >= 1024 || typeof v.expression !== 'string' || !v.expression || v.expression.length > 4096 || !/^#[0-9a-f]{6}$/i.test(v.color)) throw new Error('CSV 通道配置不合法');
      const channel = { ...createTimelineEntry(v), id: v.id, active: v.active !== false };
      if (!validTimelineView({ ...DEFAULT_TIMELINE_VIEW, entries: [channel] })) throw new Error('CSV 通道比例不合法');
      const old = defined.get(v.id);
      if (old && old.expression !== channel.expression) throw new Error('CSV 通道 ID 重复');
      defined.set(v.id, channel);
      if (!old) store.events.push('# orbit.channel=' + JSON.stringify(channel) + '\r\n');
    };
    try {
      for await (const original of lines(source)) {
        if (signal?.aborted) throw new Error('已取消打开');
        const line = original.replace(/^\uFEFF/, '');
        if (!line) continue;
        if (trailingFailure) throw trailingFailure;
        try {
        if (line === '# orbit-timeline-version=1') { if (columns) throw new Error('CSV 版本头位置不合法'); version = true; }
        else if (line.startsWith('# meta=')) {
          const m = JSON.parse(line.slice(7)); if (m.timeUnit !== 'ms' || typeof m.name !== 'string' || !Number.isFinite(Date.parse(m.timeOriginUtc))) throw new Error('CSV 记录配置不合法');
          if (m.debugStartedAtUtc !== undefined && (typeof m.debugStartedAtUtc !== 'string' || !Number.isFinite(Date.parse(m.debugStartedAtUtc)))) throw new Error('CSV 调试开始时间不合法');
          store.meta = { ...m, originalRecordId: m.originalRecordId ?? m.recordId, recordId: store.id, source: 'import', complete: m.complete !== false };
        } else if (line.startsWith('# channels=')) { const c = JSON.parse(line.slice(11)); if (!Array.isArray(c) || c.length > 1024) throw new Error('CSV 通道数不合法'); c.forEach(addChannel); }
        else if (line.startsWith('# orbit.channel=')) addChannel(JSON.parse(line.slice(16)));
        else if (line.startsWith('# orbit.origin=')) { const origin = JSON.parse(line.slice(15)); if (!Number.isFinite(Date.parse(origin))) throw new Error('CSV 时间原点不合法'); store.meta.timeOriginUtc = origin; }
        else if (line.startsWith('# view=')) { const v = JSON.parse(line.slice(7)); if (!validTimelineView(v)) throw new Error('CSV 视图配置不合法'); store.view = v; }
        else if (line.startsWith('# orbit.end=')) { const e = JSON.parse(line.slice(12)); ended = e.fileFinalized === true; endRows = e.rows; store.meta.complete &&= e.recordComplete === true && e.rangeComplete === true; }
        else if (line.startsWith('#')) continue;
        else if (line === 'time_ms,channel_id,value,segment_id') { if (!version || columns) throw new Error('CSV 缺少版本头或表头重复'); columns = true; }
        else {
          if (!columns || ended) throw new Error('CSV 数据位置不合法');
          const row = parseRow(line);
          if (!defined.has(row.channelId) || row.timestamp < lastTime) throw new Error('CSV 通道不存在或时间倒退');
          row.startsNewSegment = segments.get(row.channelId) !== row.segmentId; segments.set(row.channelId, row.segmentId); lastTime = row.timestamp;
          batch.push(row); rowCount++;
          if (batch.length >= 2048) { store.acceptRows(batch); batch = []; await store.flush(); if (store.error) throw new Error(store.error); await yieldTurn(); }
        }
        } catch (error) {
          if (!columns || signal?.aborted) throw error;
          trailingFailure = error;
        }
      }
      if (trailingFailure && rowCount === 0) throw trailingFailure;
      const finalStat = await fs.stat(source);
      if (finalStat.size !== sourceStat.size || finalStat.mtimeMs !== sourceStat.mtimeMs) throw new Error('CSV 在读取期间被修改，请重新打开');
      if (!version || !columns) throw new Error('仅支持 Orbit Timeline CSV v1');
      store.channels = [...defined.values()];
      const preferences = new Map(store.view.entries.map(e => [e.expression, e]));
      const uniqueChannels = new Map(store.channels.map(c => [c.expression, c]));
      store.view.entries = [...uniqueChannels.values()].map(c => ({ ...c, ...preferences.get(c.expression) }));
      store.view.autoFollow = false;
      store.acceptRows(batch); await store.flush();
      // Finalize imported metadata in the working copy for range queries and manual saves.
      header(store.meta, store.channels, store.view);
      await store.disk!.writeFile('# meta=' + JSON.stringify(store.meta) + '\r\n# channels=' + JSON.stringify(store.channels) + '\r\n# view=' + JSON.stringify(store.view) + '\r\n');
      if (trailingFailure || !ended || endRows !== rowCount) { store.meta.complete = false; store.error = 'CSV 缺少有效结束标记，已恢复可读取的数据'; }
      await store.end();
      return store;
    } catch (e) { await store.end().catch(() => {}); throw e; }
  }
  async dispose() {
    await bounded(this.releaseCaches()).catch(error => { this.fail(error); });
  }
  private async releaseCaches() {
    await this.end();
    await scheduler.run(1, async () => {
      for (const [filePath, handle] of readHandles) if (filePath.startsWith(this.directory + path.sep)) { await handle.close().catch(() => {}); readHandles.delete(filePath); }
    });
    for (const [key, cached] of blockCache) if (key.startsWith(this.id + ':')) { cacheBytes -= cached.bytes; blockCache.delete(key); }
    for (const [key, buffer] of indexPages) if (key.startsWith(this.id + ':')) { indexPageBytes -= buffer.length; indexPages.delete(key); }
  }
}

/** Bounded line reader: malformed giant lines cannot allocate the whole input. */
async function* lines(file: string): AsyncGenerator<string> {
  const stream = createReadStream(file, { highWaterMark: 64 * 1024 });
  let remainder = '';
  const decoder = new StringDecoder('utf8');
  try {
    for await (const chunk of stream) {
      remainder += decoder.write(chunk as Buffer);
      let newline: number;
      while ((newline = remainder.indexOf('\n')) >= 0) {
        const line = remainder.slice(0, newline).replace(/\r$/, ''); remainder = remainder.slice(newline + 1);
        if (Buffer.byteLength(line) > MAX_LINE) throw new Error('CSV 单行超过 1 MiB'); yield line;
      }
      if (Buffer.byteLength(remainder) > MAX_LINE) throw new Error('CSV 单行超过 1 MiB');
      await yieldTurn();
    }
    remainder += decoder.end();
    if (remainder) yield remainder.replace(/\r$/, '');
  } finally { stream.destroy(); }
}
