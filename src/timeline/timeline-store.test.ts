import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { TimelineRecordStore } from './timeline-store';
import { createTimelineEntry } from '../webview/timeline/timeline-entry-state';
import { DEFAULT_TIMELINE_VIEW } from './timeline-model';
import { appendTimelineSamples, retainTimelineSamples } from '../webview/timeline/timeline-sample-buffer';
import { buildTimelineTraceCommands } from '../webview/timeline/timeline-trace-path';

const stores: TimelineRecordStore[] = [];
const directories: string[] = [];
async function record() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-timeline-'));
  directories.push(base);
  const store = new TimelineRecordStore(base, '测试'); stores.push(store);
  store.view = { ...structuredClone(DEFAULT_TIMELINE_VIEW), entries: [createTimelineEntry({ expression: 'motor[0]', color: '#123456' })] };
  store.syncChannels(store.view.entries);
  return { store, base };
}
function batch(first: number, count: number, segment = false) {
  return [{ expression: 'motor[0]', color: '#123456', currentValue: '', data: Array.from({ length: count }, (_, i) => ({ timestamp: 1_700_000_000_000 + first + i, value: i === 41 ? 123456.789 : i / 7, display: String(i / 7), startsNewSegment: segment && i === 0 })) }];
}
afterEach(async () => { await Promise.all(stores.splice(0).map(s => s.dispose())); await Promise.all(directories.splice(0).map(d => fs.rm(d, { recursive: true, force: true }))); });

describe('Timeline CSV store', () => {
  it('keeps a short real gap localized when both segments occupy the same display bucket, hot and on disk', async () => {
    const { store } = await record();
    store.append(batch(0, 100)); store.append(batch(101, 100, true));
    const check = (data: any[]) => {
      expect(data.find(p => p.timestamp === 99)?.startsNewSegment).not.toBe(true);
      expect(data.find(p => p.timestamp === 101)?.startsNewSegment).toBe(true);
      expect(data.find(p => p.timestamp === 200)?.startsNewSegment).not.toBe(true);
      const commands = buildTimelineTraceCommands(data, { tStart: 0, tEnd: 200, plotLeft: 0, plotWidth: 1000, projectY: p => p.value });
      expect(commands.filter(c => c.command === 'moveTo')).toHaveLength(2);
      expect(commands.filter(c => c.command === 'lineTo').length).toBeGreaterThanOrEqual(2);
    };
    check((await store.query(0, 200, 1))[0].data);
    await store.end(); check((await store.query(0, 200, 1))[0].data);
  });
  it('refines bounded multi-level summaries without widening hundreds of short gaps', async () => {
    const { store } = await record();
    for (let start = 0; start < 33000; start += 1000) {
      store.append([{ expression: 'motor[0]', color: '#123456', currentValue: '0', data: Array.from({ length: 1000 }, (_, j) => {
        const i = start + j;
        return { timestamp: i + Math.floor(i / 100), value: 0, display: '0', startsNewSegment: i > 0 && i % 100 === 0 };
      }) }]);
      await store.flush();
    }
    await store.end();
    const data = (await store.query(0, 33328, 10))[0].data;
    expect(data.filter(p => p.startsNewSegment)).toHaveLength(330);
    expect(data).toHaveLength(660);
    for (let i = 1; i < data.length; i++) if (data[i].startsNewSegment) expect(data[i].timestamp - data[i - 1].timestamp).toBe(2);
    expect(buildTimelineTraceCommands(data, { tStart: 0, tEnd: 33328, plotLeft: 0, plotWidth: 1000, projectY: p => p.value }).filter(c => c.command === 'lineTo')).toHaveLength(330);
  });
  it('retains a whole-record average across sampling rate changes and debug completion', async () => {
    const { store } = await record();
    expect(store.getAverageSampleRateHz()).toBe(0);
    const data = batch(0, 1)[0];
    store.append([{ ...data, data: [0, 10, 20, 40, 60].map(timestamp => ({ timestamp, value: 1, display: '1' })) }]);
    expect(store.getAverageSampleRateHz()).toBeCloseTo(4 * 1000 / 60);
    await store.end();
    expect(store.getAverageSampleRateHz()).toBeCloseTo(4 * 1000 / 60);
  });
  it('excludes segmented pauses from the average and computes the same value after CSV import', async () => {
    const { store, base } = await record();
    store.append(batch(0, 100)); store.append(batch(10000, 50, true));
    expect(store.getAverageSampleRateHz()).toBe(1000);
    const destination = path.join(base, 'average.csv');
    await store.save(destination, null, store.view);
    const loaded = await TimelineRecordStore.open(base, destination); stores.push(loaded);
    expect(loaded.getAverageSampleRateHz()).toBe(1000);
    await loaded.query(0, 10049, 1);
    expect(loaded.getAverageSampleRateHz()).toBe(1000);
  });
  it('averages per-channel rates without multiplying by the channel count', async () => {
    const { store } = await record();
    store.view.entries.push(createTimelineEntry({ expression: 'voltage', color: '#654321' }));
    store.syncChannels(store.view.entries);
    store.append(['motor[0]', 'voltage'].map((expression, channel) => ({
      expression, color: '#123456', currentValue: '1',
      data: [0, 10, 20].map(timestamp => ({ timestamp: timestamp * (channel + 1), value: 1, display: '1' })),
    })));
    expect(store.getAverageSampleRateHz()).toBe(75);
  });
  it('joins continuous incremental display ranges without manufacturing gaps at reply boundaries', async () => {
    const { store } = await record();
    store.append(batch(0, 50));
    const cache = new Map();
    appendTimelineSamples(cache, await store.query(0, 49, 100));
    store.append(batch(50, 50));
    const next = await store.query(49, 99, 100);
    expect(next[0].data[0].startsNewSegment).not.toBe(true);
    appendTimelineSamples(cache, next);
    const viewport = { tStart: 0, tEnd: 99, plotLeft: 12, plotWidth: 600, projectY: (p: any) => p.value };
    expect(buildTimelineTraceCommands(cache.get('motor[0]'), viewport).filter(c => c.command === 'moveTo')).toHaveLength(1);
    await store.end();
    const disk = await store.query(49, 99, 100);
    expect(disk[0].data[0].startsNewSegment).not.toBe(true);
  });
  it('preserves real segment gaps between separate disk range replies', async () => {
    const { store } = await record();
    store.append(batch(0, 50)); store.append(batch(200, 50, true)); await store.end();
    const cache = new Map();
    appendTimelineSamples(cache, await store.query(0, 49, 100));
    appendTimelineSamples(cache, await store.query(200, 249, 100));
    const viewport = { tStart: 0, tEnd: 249, plotLeft: 12, plotWidth: 600, projectY: (p: any) => p.value };
    expect(buildTimelineTraceCommands(cache.get('motor[0]'), viewport).filter(c => c.command === 'moveTo')).toHaveLength(2);
  });
  it('saves raw precision and configuration and reopens without a target', async () => {
    const { store, base } = await record(); store.append(batch(0, 200));
    const file = path.join(base, 'export.csv');
    store.view.cursorA_ms = 10; store.view.cursorB_ms = 50;
    await store.save(file, null, store.view);
    const csv = await fs.readFile(file, 'utf8');
    expect(csv).toContain('41,0,123456.789,1'); expect(csv).toContain('"cursorA_ms":10');
    const loaded = await TimelineRecordStore.open(base, file); stores.push(loaded);
    expect(loaded.getAverageSampleRateHz()).toBe(1000);
    expect(loaded.id).not.toBe(store.id); expect(loaded.meta.complete).toBe(true);
    expect(loaded.view.entries[0].color).toBe('#123456');
    const raw = await loaded.query(0, 199, 20, true);
    expect(raw[0].data).toHaveLength(200); expect(raw[0].data[41].value).toBe(123456.789);
  });
  it('restores completed records using existing CSV and indexes without copying raw data', async () => {
    const { store, base } = await record(); store.append(batch(0, 3000)); await store.end();
    const descriptor = store.getDescriptor(); expect(store.checkpointRows).toBe(3000);
    const restored = await TimelineRecordStore.restore(base, descriptor); stores.push(restored);
    expect(restored.getAverageSampleRateHz()).toBe(1000);
    expect(restored.csvPath).toBe(store.csvPath); expect(restored.id).toBe(store.id);
    expect(restored.live).toBe(false); expect(restored.meta.complete).toBe(true);
    const data = await restored.query(20, 40, 100, true); expect(data[0].data).toHaveLength(21);
  });
  it('exports inclusive A/B interval with original time offsets', async () => {
    const { store, base } = await record(); store.append(batch(0, 100));
    const file = path.join(base, 'selection.csv'); await store.save(file, { start: 20, end: 40 }, store.view);
    const loaded = await TimelineRecordStore.open(base, file); stores.push(loaded);
    expect(loaded.bounds).toEqual({ start: 20, end: 40 }); expect(loaded.acceptedRows).toBe(21);
  });
  it('keeps data across channel removal/readdition with new IDs and segments', async () => {
    const { store, base } = await record(); store.append(batch(0, 10));
    store.syncChannels([]); store.syncChannels(store.view.entries); store.append(batch(20, 10));
    expect(store.channels.map(c => c.id)).toEqual([0, 1]);
    const file = path.join(base, 'dynamic.csv'); await store.end(); await store.save(file, null, store.view);
    const loaded = await TimelineRecordStore.open(base, file); stores.push(loaded);
    expect(loaded.acceptedRows).toBe(20); expect(loaded.channels).toHaveLength(2);
  });
  it('serves old data from disk beyond ten minutes and preserves extrema with bounded replies', async () => {
    const { store } = await record();
    for (let i = 0; i < 40; i++) { store.append(batch(i * 20000, 2048)); await store.flush(); }
    await store.end();
    const old = await store.query(0, 2047, 100, true); expect(old[0].data).toHaveLength(2048);
    const view = await store.query(0, 800000, 10); expect(view[0].data.length).toBeLessThanOrEqual(60);
    expect(view[0].data.some(p => p.value === 123456.789)).toBe(true);
    expect(store.bounds!.end).toBeGreaterThan(600000);
    const cache = new Map();
    appendTimelineSamples(cache, view);
    retainTimelineSamples(cache, { start: 0, end: 800000 });
    expect(cache.get('motor[0]')[0].timestamp).toBe(0);
    appendTimelineSamples(cache, await store.query(780000, 800000, 10));
    appendTimelineSamples(cache, await store.query(0, 2047, 100));
    retainTimelineSamples(cache, { start: 0, end: 2047 });
    expect(cache.get('motor[0]').some((p: any) => p.timestamp === 0)).toBe(true);
    expect(buildTimelineTraceCommands(cache.get('motor[0]'), {
      tStart: 0, tEnd: 2047, plotLeft: 12, plotWidth: 600, projectY: (p: any) => p.value,
    }).some(command => command.command === 'lineTo')).toBe(true);
  }, 30000);
  it('refines summary edges so tiny raw intervals never include outside points', async () => {
    const { store } = await record();
    for (let i = 0; i < 33; i++) { store.append(batch(i * 2048, 2048)); await store.flush(); }
    await store.end();
    const raw = await store.query(32000, 33000, 1, true);
    expect(raw[0].data).toHaveLength(1001);
    expect(raw[0].data[0].timestamp).toBe(32000); expect(raw[0].data.at(-1)!.timestamp).toBe(33000);
    const display = await store.query(32123, 66500, 2);
    expect(display[0].data.every(p => p.timestamp >= 32123 && p.timestamp <= 66500)).toBe(true);
  }, 30000);
  it('returns no cursor value inside a segment gap', async () => {
    const { store } = await record(); store.append(batch(0, 100)); store.append(batch(300, 100, true));
    expect((await store.measure(200))[0].value).toBeNull();
    expect((await store.measure(41))[0].value).toBe(123456.789);
  });
  it('recovers missing end markers as explicitly incomplete and rejects malformed numeric data', async () => {
    const { store, base } = await record(); store.append(batch(0, 5)); await store.flush();
    const loaded = await TimelineRecordStore.open(base, store.csvPath); stores.push(loaded);
    expect(loaded.meta.complete).toBe(false); expect(loaded.acceptedRows).toBe(5);
    const file = path.join(base, 'bad.csv'); await fs.writeFile(file, '# orbit-timeline-version=1\ntime_ms,channel_id,value,segment_id\n1,0,NaN,1\n');
    await expect(TimelineRecordStore.open(base, file)).rejects.toThrow();
  });
  it('freezes the clicked snapshot while later samples keep arriving', async () => {
    const { store, base } = await record(); store.append(batch(0, 10));
    const snapshot = store.captureSnapshot(null, store.view);
    store.append(batch(10, 10));
    const file = path.join(base, 'snapshot.csv'); await store.save(file, null, store.view, undefined, snapshot);
    const loaded = await TimelineRecordStore.open(base, file); stores.push(loaded);
    expect(loaded.acceptedRows).toBe(10); expect(store.acceptedRows).toBe(20);
  });
  it('marks disk failures incomplete and exports the still available tail', async () => {
    const { store, base } = await record(); store.append(batch(0, 10)); await store.flush();
    const original = (store as any).disk.writeFile.bind((store as any).disk);
    (store as any).disk.writeFile = async () => { throw new Error('ENOSPC'); };
    store.append(batch(10, 10)); await store.flush();
    expect(store.error).toContain('ENOSPC'); expect(store.meta.complete).toBe(false);
    (store as any).disk.writeFile = original;
    const file = path.join(base, 'incomplete.csv'); await store.save(file, null, store.view);
    const loaded = await TimelineRecordStore.open(base, file); stores.push(loaded);
    expect(loaded.meta.complete).toBe(false); expect(loaded.acceptedRows).toBe(20);
    const raw = await loaded.query(0, 19, 10, true); expect(raw[0].data[10].startsNewSegment).toBe(true);
  });
  it('recovers the valid prefix when a crash leaves a partial final CSV row', async () => {
    const { store, base } = await record(); store.append(batch(0, 5)); await store.flush();
    const source = path.join(base, 'crashed.csv');
    await fs.writeFile(source, (await fs.readFile(store.csvPath, 'utf8')) + '6,0,');
    const loaded = await TimelineRecordStore.open(base, source); stores.push(loaded);
    expect(loaded.acceptedRows).toBe(5); expect(loaded.meta.complete).toBe(false);
    await fs.appendFile(source, '\n7,0,42,1\n');
    await expect(TimelineRecordStore.open(base, source)).rejects.toThrow();
  });
  it('does not replace an existing output on cancellation', async () => {
    const { store, base } = await record(); store.append(batch(0, 100));
    const file = path.join(base, 'old.csv'); await fs.writeFile(file, 'old content');
    const controller = new AbortController(); controller.abort();
    await expect(store.save(file, null, store.view, controller.signal)).rejects.toThrow('取消');
    expect(await fs.readFile(file, 'utf8')).toBe('old content');
  });
});
