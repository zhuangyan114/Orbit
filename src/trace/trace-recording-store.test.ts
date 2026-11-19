import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DecodedSystemViewPacket,
  SystemViewDecodeBatch,
} from './systemview-decoder';
import { SYSTEMVIEW_PROTOCOL_VERSION } from './systemview-protocol';
import {
  ExecutionSliceInterval,
  TraceReconstructBatch,
  TraceTimePoint,
} from './systemview-reconstructor';
import {
  defaultTraceFileSystem,
  NodeTraceFileSystem,
  ORBIT_TRACE_FILES,
  TraceFileHandle,
  TraceFileSystem,
} from './trace-format';
import { TraceRecordingStore } from './trace-recording-store';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

function encodeVarUint(value: number): number[] {
  const out: number[] = [];
  let v = value >>> 0;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v & 0x7f);
  return out;
}

function encodeExplicitPacket(eventId: number, payload: number[], delta: number): number[] {
  return [...encodeVarUint(eventId), ...encodeVarUint(payload.length), ...payload, ...encodeVarUint(delta)];
}

function encodeInitPacket(sysFreqHz: number, cpuFreqHz: number, ramBase: number, idShift: number, delta = 0): number[] {
  const payload = [
    ...encodeVarUint(sysFreqHz),
    ...encodeVarUint(cpuFreqHz),
    ...encodeVarUint(ramBase),
    ...encodeVarUint(idShift),
  ];
  return encodeExplicitPacket(24, payload, delta);
}

function encodeShortPacket(eventId: number, u32Args: number[], delta: number): number[] {
  const out: number[] = [eventId];
  for (const a of u32Args) {
    out.push(...encodeVarUint(a));
  }
  out.push(...encodeVarUint(delta));
  return out;
}

function makeFaultInjectingFs(options: {
  failFileSuffix: string;
  afterWrites: number;
  mode: 'enospc' | 'short-write' | 'eio';
}): { fs: TraceFileSystem; writeCount: () => number; closeCountForFile: () => number } {
  const inner = new NodeTraceFileSystem();
  let writes = 0;
  let closes = 0;

  const wrapper: TraceFileSystem = {
    mkdir: (p, o) => inner.mkdir(p, o),
    readFile: (p) => inner.readFile(p),
    writeFile: async (p, d) => {
      if (p.endsWith(options.failFileSuffix)) {
        writes += 1;
        if (writes > options.afterWrites) {
          const err = new Error(`Injected ${options.mode} on writeFile ${p}`);
          (err as { code?: string }).code = options.mode === 'enospc' ? 'ENOSPC' : 'EIO';
          throw err;
        }
      }
      return inner.writeFile(p, d);
    },
    rename: (o, n) => inner.rename(o, n),
    stat: (p) => inner.stat(p),
    exists: (p) => inner.exists(p),
    open: async (filePath, flags): Promise<TraceFileHandle> => {
      const h = await inner.open(filePath, flags);
      const isTarget = filePath.endsWith(options.failFileSuffix);
      let handleClosed = false;
      return {
        read: (b, o, l, p) => h.read(b, o, l, p),
        sync: () => h.sync(),
        truncate: (l) => h.truncate(l),
        stat: () => h.stat(),
        close: async () => {
          if (isTarget) {
            closes += 1;
          }
          if (!handleClosed) {
            handleClosed = true;
            await h.close();
          }
        },
        write: async (buffer, offset, length, position) => {
          if (isTarget) {
            writes += 1;
            if (writes > options.afterWrites) {
              if (options.mode === 'short-write') {
                const partial = Math.max(0, Math.floor(length / 2));
                if (partial > 0) {
                  await h.write(buffer, offset, partial, position);
                }
                return { bytesWritten: partial };
              }
              const err = new Error(`Injected ${options.mode} at write #${writes}`);
              (err as { code?: string }).code = options.mode === 'enospc' ? 'ENOSPC' : 'EIO';
              throw err;
            }
          }
          return h.write(buffer, offset, length, position);
        },
      };
    },
  };

  return {
    fs: wrapper,
    writeCount: () => writes,
    closeCountForFile: () => closes,
  };
}

describe('TraceRecordingStore 存储、索引、LOD 与异常恢复 (阶段 4.3)', () => {
  it('消费独立样本并保证原始字节逐字节一致导出（不受 LOD 影响）', async () => {
    const sample = await fs.readFile('scripts/rtos/fixtures/samples/continuous.bin');
    const dir = await makeTempDir('orbit-store-raw-');
    const recDir = path.join(dir, 'recording');
    const exportPath = path.join(dir, 'exported-raw.bin');

    const store = await TraceRecordingStore.create({
      recordingDir: recDir,
      recordId: 'rec-raw-1',
      identity: { sessionId: 'sess-1', sessionGeneration: 1, bootGeneration: 1, recordId: 'rec-raw-1' },
      limits: { rawChunkBytes: 256, pageMaxItems: 16, maxCachedPages: 4 },
      commitOnEachIngest: true,
    });

    // 分片写入（覆盖跨块边界）
    const splitPoints = [0, 17, 35, 51, sample.length];
    for (let i = 0; i < splitPoints.length - 1; i++) {
      const res = await store.ingestRawChunk(sample.subarray(splitPoints[i], splitPoints[i + 1]), {
        batchSequence: i + 1,
      });
      expect(res.ok).toBe(true);
    }

    const fin = await store.finish();
    expect(fin.ok).toBe(true);
    if (!fin.ok) return;
    const expectedSha = createHash('sha256').update(sample).digest('hex');
    expect(fin.data.rawSha256).toBe(expectedSha);
    expect(fin.data.committed.rawBytes).toBe(sample.length);
    await store.close();

    // 重新打开只读回放
    const { store: opened, inspection } = await TraceRecordingStore.open({ recordingDir: recDir });
    expect(inspection.isComplete).toBe(true);
    expect(inspection.status).toBe('completed');

    // LOD 抽稀查询不影响原始导出
    const lodRes = await opened.queryLod({
      start: 0n,
      end: 100000n,
      unit: 'relative-ticks',
      maxBuckets: 8,
    });
    expect(lodRes.ok).toBe(true);
    if (lodRes.ok) {
      expect(lodRes.data.buckets.length).toBeGreaterThan(0);
    }

    const expRes = await opened.exportRaw({ outputPath: exportPath });
    expect(expRes.ok).toBe(true);
    if (!expRes.ok) return;
    expect(expRes.data.exportedBytes).toBe(sample.length);
    expect(expRes.data.sha256).toBe(expectedSha);

    const exportedBytes = await fs.readFile(exportPath);
    expect(Buffer.compare(exportedBytes, sample)).toBe(0);

    // 幂等多次 close 不得报错或二次释放
    await opened.close();
    await opened.close();
  });

  it('索引正确处理跨时间页的长区间、半开边界 [start, end) 与相对/绝对时间单位', async () => {
    const dir = await makeTempDir('orbit-store-long-');
    const store = await TraceRecordingStore.create({
      recordingDir: dir,
      recordId: 'rec-long-1',
      identity: { sessionId: 'sess-l', sessionGeneration: 1, bootGeneration: 1, recordId: 'rec-long-1' },
      limits: {
        pageMaxItems: 4, // 强制每 4 条分页，制造大量跨页区间
        maxCachedPages: 2,
        maxCacheBytes: 16384,
      },
      commitOnEachIngest: true,
    });

    // 构造精确事件流：
    // 1) sync + TRACE_START + INIT(1000 Hz) + SYSTIME_CYCLES=1000
    // 2) 外层任务 0x20000100 在 relTick=10 开始，Marker 77 在 relTick=15 开始
    // 3) 中间反复发生 20 次短 IRQ(17) 抢占（跨 5+ 个常规 slices/activations 页）
    // 4) 最后外层 Marker 77 与外层任务 0x20000100 在 relTick=500 才结束！
    const bytes: number[] = [
      ...new Array(10).fill(0),
      10, 0, // TRACE_START
      ...encodeInitPacket(1000, 1000, 0x20000000, 2, 0),
      ...encodeShortPacket(12, [1000], 0), // SYSTIME_CYCLES=1000
      ...encodeShortPacket(4, [0x40], 10), // TASK_START_EXEC rel=10, abs=1010
      ...encodeShortPacket(15, [77], 5), // MARK_START 77 rel=15, abs=1015
    ];
    for (let i = 0; i < 20; i++) {
      bytes.push(...encodeShortPacket(2, [17], 10)); // ISR_ENTER
      bytes.push(...encodeShortPacket(3, [], 5)); // ISR_EXIT (每次推进 15 ticks)
    }
    // 20 * 15 = 300 -> 当前 rel=315; 再过 185 ticks 结束
    bytes.push(...encodeShortPacket(16, [77], 100)); // MARK_STOP 77 rel=415, abs=1415
    bytes.push(...encodeShortPacket(5, [], 85)); // TASK_STOP_EXEC rel=500, abs=1500
    bytes.push(11, 0); // TRACE_STOP

    const res = await store.ingestRawChunk(Uint8Array.from(bytes), { batchSequence: 1 });
    expect(res.ok).toBe(true);
    await store.finish();
    await store.close();

    const { store: opened } = await TraceRecordingStore.open({
      recordingDir: dir,
      limits: { pageMaxItems: 4, maxCachedPages: 2, maxCacheBytes: 16384 },
    });

    // 查询正中间一个很窄的窗口 [150, 155)（relative-ticks）：必须命中跨页长 Task activation 与 Marker 77
    const actMid = await opened.queryRange<any>({
      target: 'activations',
      start: 150n,
      end: 155n,
      unit: 'relative-ticks',
    });
    expect(actMid.ok).toBe(true);
    if (actMid.ok) {
      expect(actMid.data.items.some((a) => a.kind === 'task-exec' && a.start.relativeTicksBigInt === 10n && a.end.relativeTicksBigInt === 500n)).toBe(true);
    }

    const markerMid = await opened.queryRange<any>({
      target: 'markers',
      start: 150n,
      end: 155n,
      unit: 'relative-ticks',
    });
    expect(markerMid.ok).toBe(true);
    if (markerMid.ok) {
      expect(markerMid.data.items.length).toBe(1);
      expect(markerMid.data.items[0].markerId).toBe(77);
      expect(markerMid.data.items[0].durationTicksBigInt).toBe(400n);
    }

    // 半开边界验证：Marker 77 为 [15, 415)
    // 查询 [415, 450) 不得包含 Marker 77；查询 [0, 15) 不得包含 Marker 77；查询 [414, 415) 必须包含 Marker 77
    const touchRight = await opened.queryRange<any>({ target: 'markers', start: 415n, end: 450n, unit: 'relative-ticks' });
    expect(touchRight.ok && touchRight.data.items.length).toBe(0);
    const touchLeft = await opened.queryRange<any>({ target: 'markers', start: 0n, end: 15n, unit: 'relative-ticks' });
    expect(touchLeft.ok && touchLeft.data.items.length).toBe(0);
    const overlapEnd = await opened.queryRange<any>({ target: 'markers', start: 414n, end: 415n, unit: 'relative-ticks' });
    expect(overlapEnd.ok && overlapEnd.data.items.length).toBe(1);

    // 绝对 tick 单位与纳秒单位（1000 Hz -> 1 tick = 1,000,000 ns）
    const absRes = await opened.queryRange<any>({
      target: 'markers',
      start: 1200n,
      end: 1210n,
      unit: 'absolute-ticks',
    });
    expect(absRes.ok && absRes.data.items.length).toBe(1);

    const nsRes = await opened.queryRange<any>({
      target: 'markers',
      start: 1_200_000_000n,
      end: 1_210_000_000n,
      unit: 'ns',
    });
    expect(nsRes.ok && nsRes.data.items.length).toBe(1);

    // 验证有限 LRU 缓存生效（多次查询不同页触发逐出且能重读）
    await opened.queryRange({ target: 'slices', start: 0n, end: 500n, unit: 'relative-ticks' });
    await opened.queryRange({ target: 'packets', start: 0n, end: 500n, unit: 'relative-ticks' });
    const stats = opened.getStats();
    expect(stats.cache.cachedPages).toBeLessThanOrEqual(2);
    expect(stats.cache.evictions).toBeGreaterThan(0);

    await opened.close();
  });

  it('多段相对 tick 回零隔离与未锚定段在绝对时间查询中的排除', async () => {
    const dir = await makeTempDir('orbit-store-multiseg-');
    const store = await TraceRecordingStore.create({
      recordingDir: dir,
      recordId: 'rec-mseg',
      identity: { sessionId: 's-m', sessionGeneration: 1, bootGeneration: 1, recordId: 'rec-mseg' },
      commitOnEachIngest: true,
    });

    // 段 1（有 SYSTIME_CYCLES=5000 锚点）：relTick 0..30
    const seg1 = Uint8Array.from([
      ...new Array(10).fill(0),
      10, 0,
      ...encodeInitPacket(1000, 1000, 0x20000000, 2, 0),
      ...encodeShortPacket(12, [5000], 0), // abs=5000
      ...encodeShortPacket(4, [0x10], 10), // rel=10, abs=5010
      ...encodeShortPacket(5, [], 20), // rel=30, abs=5030
    ]);
    await store.ingestRawChunk(seg1, { batchSequence: 1 });

    // 注入缺口，段 2 重新同步后无 SYSTIME_CYCLES（unanchored），且 relativeTicks 从 0 重新开始！
    await store.markGap({ kind: 'host-drop', reason: '模拟主机丢包导致失步与相对 tick 回零' });

    const seg2 = Uint8Array.from([
      ...new Array(10).fill(0),
      10, 0,
      ...encodeInitPacket(1000, 1000, 0x20000000, 2, 0),
      // 故意不发 SYSTIME_CYCLES，保持 unanchored
      ...encodeShortPacket(4, [0x20], 5), // rel=5
      ...encodeShortPacket(5, [], 15), // rel=20
      11, 0,
    ]);
    await store.ingestRawChunk(seg2, { batchSequence: 2 });
    await store.finish();
    await store.close();

    const { store: opened } = await TraceRecordingStore.open({ recordingDir: dir });
    const segments = opened.getSegments();
    expect(segments.length).toBe(2);
    expect(segments[0].timeAnchorStatus).toBe('anchored-cycles');
    expect(segments[1].timeAnchorStatus).toBe('unanchored');

    // 按 relative-ticks 查询 segmentId=1 vs segmentId=2：两段各有自己的 [0..30] / [0..20]，互不混淆
    const qSeg1 = await opened.queryRange<ExecutionSliceInterval>({
      target: 'slices',
      start: 10n,
      end: 25n,
      unit: 'relative-ticks',
      segmentId: 1,
    });
    expect(qSeg1.ok && qSeg1.data.items.length).toBe(1);
    if (qSeg1.ok) {
      expect(qSeg1.data.items[0].segmentId).toBe(1);
      expect(qSeg1.data.items[0].shrunkTaskId).toBe(0x10);
    }

    const qSeg2 = await opened.queryRange<ExecutionSliceInterval>({
      target: 'slices',
      start: 5n,
      end: 15n,
      unit: 'relative-ticks',
      segmentId: 2,
    });
    expect(qSeg2.ok && qSeg2.data.items.length).toBe(1);
    if (qSeg2.ok) {
      expect(qSeg2.data.items[0].segmentId).toBe(2);
      expect(qSeg2.data.items[0].shrunkTaskId).toBe(0x20);
    }

    // 按 absolute-ticks 查询全范围：未锚定的段 2 不得被猜测或伪造，应列在 skippedUnanchoredSegments
    const qAbs = await opened.queryRange<ExecutionSliceInterval>({
      target: 'slices',
      start: 0n,
      end: 10000n,
      unit: 'absolute-ticks',
    });
    expect(qAbs.ok).toBe(true);
    if (qAbs.ok) {
      expect(qAbs.data.items.every((i) => i.segmentId === 1)).toBe(true);
      expect(qAbs.data.skippedUnanchoredSegments).toContain(2);
    }

    // 验证缺口记录完整保留
    expect(opened.getGaps().some((g) => g.kind === 'host-drop')).toBe(true);
    await opened.close();
  });

  it('索引内存上限触发目录溢写，溢写后仍可准确范围查询', async () => {
    const dir = await makeTempDir('orbit-store-idxspill-');
    const store = await TraceRecordingStore.create({
      recordingDir: dir,
      recordId: 'rec-spill',
      identity: { sessionId: 's-sp', sessionGeneration: 1, bootGeneration: 1, recordId: 'rec-spill' },
      limits: {
        pageMaxItems: 8,
        maxIndexPagesInMemory: 6, // 极小内存索引上限，强制触发溢写
        maxCachedPages: 4,
      },
      commitOnEachIngest: true,
    });

    const bytes: number[] = [
      ...new Array(10).fill(0),
      10, 0,
      ...encodeInitPacket(1000, 1000, 0x20000000, 2, 0),
      ...encodeShortPacket(12, [100], 0),
    ];
    for (let i = 0; i < 60; i++) {
      bytes.push(...encodeShortPacket(4, [0x10], 5));
      bytes.push(...encodeShortPacket(5, [], 5));
    }
    bytes.push(11, 0);

    await store.ingestRawChunk(Uint8Array.from(bytes), { batchSequence: 1 });
    await store.finish();

    const stats = store.getStats();
    expect(stats.index.compactedDirectoryBlocks).toBeGreaterThan(0);
    expect(stats.index.inMemoryPageDescriptors).toBeLessThanOrEqual(6);
    await store.close();

    // 重新打开同样以极小索引上限加载并查询最早区间（位于已溢写目录块内）
    const { store: opened } = await TraceRecordingStore.open({
      recordingDir: dir,
      limits: { maxIndexPagesInMemory: 6, maxCachedPages: 4 },
    });
    expect(opened.getStats().index.compactedDirectoryBlocks).toBeGreaterThan(0);

    const earlyRes = await opened.queryRange<ExecutionSliceInterval>({
      target: 'slices',
      start: 5n,
      end: 25n,
      unit: 'relative-ticks',
    });
    expect(earlyRes.ok).toBe(true);
    if (earlyRes.ok) {
      expect(earlyRes.data.items.length).toBeGreaterThanOrEqual(2);
      expect(earlyRes.data.items[0].start?.relativeTicksBigInt).toBe(5n);
    }
    await opened.close();
  });

  it('ENOSPC、短写、后写失败与未完整关闭回滚至有效提交边界并保留可恢复前缀', async () => {
    const sample = await fs.readFile('scripts/rtos/fixtures/samples/continuous.bin');

    // 1. 测试 raw.otbin 在第 3 次写入时发生 ENOSPC：前 2 块必须完整恢复，第 3 块不可破坏前缀
    const dirEnospc = await makeTempDir('orbit-store-enospc-');
    const faultEnospc = makeFaultInjectingFs({
      failFileSuffix: ORBIT_TRACE_FILES.raw,
      afterWrites: 2,
      mode: 'enospc',
    });
    const store1 = await TraceRecordingStore.create({
      recordingDir: dirEnospc,
      recordId: 'rec-enospc',
      identity: { sessionId: 's-e', sessionGeneration: 1, bootGeneration: 1, recordId: 'rec-enospc' },
      fileSystem: faultEnospc.fs,
      commitOnEachIngest: true,
    });

    const chunk1 = sample.subarray(0, 20);
    const chunk2 = sample.subarray(20, 44);
    const chunk3 = sample.subarray(44, sample.length);

    expect((await store1.ingestRawChunk(chunk1, { batchSequence: 1 })).ok).toBe(true);
    expect((await store1.ingestRawChunk(chunk2, { batchSequence: 2 })).ok).toBe(true);
    const fail3 = await store1.ingestRawChunk(chunk3, { batchSequence: 3 });
    expect(fail3.ok).toBe(false);
    if (!fail3.ok) {
      expect(fail3.errorCode).toBe('ENOSPC');
    }
    expect(store1.getState()).toBe('failed');
    // 故障后再写必须被拒绝，且不得破坏前两块
    const fail4 = await store1.ingestRawChunk(chunk3, { batchSequence: 4 });
    expect(fail4.ok).toBe(false);
    await store1.close();
    // 二次 close 不得多关闭文件句柄
    await store1.close();
    expect(faultEnospc.closeCountForFile()).toBe(1);

    const { store: rec1, inspection: insp1 } = await TraceRecordingStore.open({ recordingDir: dirEnospc });
    expect(insp1.status).toBe('failed');
    expect(insp1.isRecoverable).toBe(true);
    expect(insp1.recoverableRawBytes).toBe(44);
    const expChunks: Uint8Array[] = [];
    const expRes = await rec1.exportRaw({
      onChunk: (c) => {
        expChunks.push(Buffer.from(c));
      },
    });
    expect(expRes.ok).toBe(true);
    expect(Buffer.compare(Buffer.concat(expChunks), sample.subarray(0, 44))).toBe(0);
    await rec1.close();

    // 2. 测试 data.otd 发生短写 (ShortWrite) 与 journal.otj 发生后写 EIO：均须回滚至有效提交边界
    for (const scenario of [
      { file: ORBIT_TRACE_FILES.data, after: 1, mode: 'short-write' as const, expectCode: 'ShortWrite' },
      { file: ORBIT_TRACE_FILES.journal, after: 2, mode: 'eio' as const, expectCode: 'StorageWriteError' },
    ]) {
      const parent = await makeTempDir(`orbit-store-${scenario.mode}-`);
      const d = path.join(parent, 'recording');
      const fault = makeFaultInjectingFs({
        failFileSuffix: scenario.file,
        afterWrites: scenario.after,
        mode: scenario.mode,
      });
      const st = await TraceRecordingStore.create({
        recordingDir: d,
        recordId: `rec-${scenario.mode}`,
        identity: { sessionId: 's-f', sessionGeneration: 1, bootGeneration: 1, recordId: `rec-${scenario.mode}` },
        fileSystem: fault.fs,
        commitOnEachIngest: true,
      });
      // 第 1 批写入成功（raw + data + journal 各 1 次 write）
      const r1 = await st.ingestRawChunk(sample.subarray(0, 20), { batchSequence: 1 });
      expect(r1.ok).toBe(true);

      // 连续触发直到命中故障
      let hitErr: string | undefined;
      let offset = 20;
      let seq = 2;
      while (offset < sample.length) {
        const next = Math.min(sample.length, offset + 16);
        const r = await st.ingestRawChunk(sample.subarray(offset, next), { batchSequence: seq++ });
        if (!r.ok) {
          hitErr = r.errorCode;
          break;
        }
        offset = next;
      }
      expect(hitErr).toBe(scenario.expectCode);
      const committedBytes = st.getStats().committed.rawBytes;
      expect(committedBytes).toBeGreaterThanOrEqual(20);
      await st.close();

      const { store: opened, inspection } = await TraceRecordingStore.open({ recordingDir: d });
      expect(inspection.isRecoverable).toBe(true);
      expect(inspection.recoverableRawBytes).toBe(committedBytes);
      const outPath = path.join(parent, 'recovered.bin');
      const exp = await opened.exportRaw({ outputPath: outPath });
      expect(exp.ok).toBe(true);
      const recoveredBytes = await fs.readFile(outPath);
      expect(Buffer.compare(recoveredBytes, sample.subarray(0, committedBytes))).toBe(0);
      await opened.close();
    }
  });

  it('消费 4.1/4.2 显式批次并保留 BigInt 精度与查询取消语义', async () => {
    const dir = await makeTempDir('orbit-store-batches-');
    const store = await TraceRecordingStore.create({
      recordingDir: dir,
      recordId: 'rec-batch-1',
      identity: { sessionId: 's-b', sessionGeneration: 2, bootGeneration: 3, recordId: 'rec-batch-1' },
      commitOnEachIngest: true,
    });

    const baseTick = 10_000_000_000_000_000n; // > Number.MAX_SAFE_INTEGER (9.007e15)
    const pStart: TraceTimePoint = {
      segmentId: 1,
      packetIndexInSegment: 0,
      streamByteOffset: 0,
      relativeTicks: '10',
      relativeTicksBigInt: 10n,
      absoluteTicks: baseTick.toString(),
      absoluteTicksBigInt: baseTick,
      timeAnchorStatus: 'anchored-cycles',
      sysFreqHz: 100_000_000,
      timestampNs: (baseTick * 10n).toString(),
    };
    const pEnd: TraceTimePoint = {
      segmentId: 1,
      packetIndexInSegment: 1,
      streamByteOffset: 10,
      relativeTicks: '35',
      relativeTicksBigInt: 35n,
      absoluteTicks: (baseTick + 25n).toString(),
      absoluteTicksBigInt: baseTick + 25n,
      timeAnchorStatus: 'anchored-cycles',
      sysFreqHz: 100_000_000,
      timestampNs: ((baseTick + 25n) * 10n).toString(),
    };

    const pkt: DecodedSystemViewPacket = {
      protocolVersion: SYSTEMVIEW_PROTOCOL_VERSION,
      segmentId: 1,
      packetIndexInSegment: 0,
      streamByteOffset: 0,
      byteLength: 10,
      eventId: 4,
      eventName: 'TASK_START_EXEC',
      category: 'standard-short',
      schemaReliability: 'known',
      segmentReliability: 'trusted',
      deltaTicks: 10,
      segmentRelativeTicks: '10',
      segmentRelativeTicksBigInt: 10n,
      absoluteTicks: baseTick.toString(),
      absoluteTicksBigInt: baseTick,
      timestampWrapped: false,
      timeAnchorStatus: 'anchored-cycles',
      sysFreqHz: 100_000_000,
      timestampNs: (baseTick * 10n).toString(),
      decoded: { kind: 'task-start-exec', shrunkTaskId: 1, taskId: 0x20000004, idResolution: 'resolved' },
    };

    const slice: ExecutionSliceInterval = {
      sliceId: 'sl-bigint',
      bootGeneration: 3,
      segmentId: 1,
      segmentReliability: 'trusted',
      completeness: 'complete',
      contextKind: 'task',
      contextKey: 'task:b3:tcb:0x20000004#g1:i1',
      taskInstanceId: 'b3:tcb:0x20000004#g1:i1',
      tcbAddress: 0x20000004,
      shrunkTaskId: 1,
      taskGeneration: 1,
      isrDepth: 0,
      label: 'HighTickTask',
      labelSource: 'task-info',
      start: pStart,
      end: pEnd,
      durationTicks: '25',
      durationTicksBigInt: 25n,
      durationNs: '250',
      timeDomain: 'anchored-ticks',
      startReason: 'task-start-exec',
      endReason: 'task-stop-exec',
    };

    const decBatch: SystemViewDecodeBatch = {
      packets: [pkt],
      syncs: [],
      gaps: [],
      segments: [
        {
          segmentId: 1,
          startByteOffset: 0,
          endByteOffset: 10,
          reliability: 'trusted',
          closed: false,
          packetCount: 1,
          syncCount: 1,
          timestampBits: 32,
          timestampWrapCount: 0,
          timeAnchorStatus: 'anchored-cycles',
          relativeTicksTotal: '35',
          firstAbsoluteTicks: baseTick.toString(),
          lastAbsoluteTicks: (baseTick + 25n).toString(),
          metadata: { sysFreqHz: 100_000_000 },
        },
      ],
      diagnostics: [],
    };
    const reconBatch: TraceReconstructBatch = {
      protocolVersion: SYSTEMVIEW_PROTOCOL_VERSION,
      accepted: true,
      identity: { sessionId: 's-b', sessionGeneration: 2, bootGeneration: 3, recordId: 'rec-batch-1' },
      executionSlices: [slice],
      contextActivations: [],
      readyWaits: [],
      markers: [],
      markerPoints: [],
      taskUpdates: [],
      gapBoundaries: [],
      diagnostics: [],
    };

    const ing = await store.ingestDecodedBatches(decBatch, reconBatch);
    expect(ing.ok).toBe(true);

    // 1. BigInt 精确范围查询（绝对 tick 与 ns）
    const q = await store.queryRange<ExecutionSliceInterval>({
      target: 'slices',
      start: baseTick + 5n,
      end: baseTick + 10n,
      unit: 'absolute-ticks',
    });
    expect(q.ok).toBe(true);
    if (q.ok) {
      expect(q.data.items.length).toBe(1);
      expect(q.data.items[0].start?.absoluteTicksBigInt).toBe(baseTick);
      expect(q.data.items[0].end?.absoluteTicksBigInt).toBe(baseTick + 25n);
    }

    // 2. AbortSignal 取消查询
    const ac = new AbortController();
    ac.abort();
    const cancelled = await store.queryRange(
      { target: 'slices', start: baseTick, end: baseTick + 100n, unit: 'absolute-ticks' },
      { signal: ac.signal },
    );
    expect(cancelled.ok).toBe(false);
    if (!cancelled.ok) {
      expect(cancelled.errorCode).toBe('QueryCancelled');
      expect(cancelled.cancelled).toBe(true);
    }

    await store.finish();
    await store.close();
  });

  it('保护既有录制目录、防并发重建覆盖、防自导出/同文件别名截断已有输出', async () => {
    const sample = await fs.readFile('scripts/rtos/fixtures/samples/continuous.bin');
    const dir = await makeTempDir('orbit-store-pathguard-');
    const recDir = path.join(dir, 'rec');
    const store = await TraceRecordingStore.create({
      recordingDir: recDir,
      recordId: 'rec-orig',
      identity: { sessionId: 's-pg', sessionGeneration: 1, bootGeneration: 1, recordId: 'rec-orig' },
    });
    expect((await store.ingestRawChunk(sample, { batchSequence: 1 })).ok).toBe(true);
    expect((await store.finish()).ok).toBe(true);

    // 1. 自导出与录制目录内部路径拒绝，且不得截断 raw.otbin
    const rawPath = path.join(recDir, ORBIT_TRACE_FILES.raw);
    const selfExp = await store.exportRaw({ outputPath: rawPath });
    expect(selfExp.ok).toBe(false);
    if (!selfExp.ok) expect(selfExp.errorCode).toBe('ExportPathConflict');
    expect(Buffer.compare(await fs.readFile(rawPath), sample)).toBe(0);

    const insideExp = await store.exportRaw({ outputPath: path.join(recDir, 'nested.bin') });
    expect(insideExp.ok).toBe(false);
    if (!insideExp.ok) expect(insideExp.errorCode).toBe('ExportPathConflict');

    // 2. 导出至已存在外部文件拒绝覆盖
    const existingOut = path.join(dir, 'existing.bin');
    await fs.writeFile(existingOut, Buffer.from('KEEP-ME'));
    const overwriteExp = await store.exportRaw({ outputPath: existingOut });
    expect(overwriteExp.ok).toBe(false);
    if (!overwriteExp.ok) expect(overwriteExp.errorCode).toBe('ExportTargetExists');
    expect((await fs.readFile(existingOut)).toString('utf8')).toBe('KEEP-ME');
    await store.close();

    // 3. 在既有完成录制目录重新 create 必须被拒绝且原档案保持完整
    await expect(
      TraceRecordingStore.create({
        recordingDir: recDir,
        recordId: 'rec-other',
        identity: { sessionId: 's-pg', sessionGeneration: 1, bootGeneration: 1, recordId: 'rec-other' },
      }),
    ).rejects.toMatchObject({ code: 'RecordingDirectoryNotEmpty' });
    expect(Buffer.compare(await fs.readFile(rawPath), sample)).toBe(0);

    // 4. 并发 create 同一空目录仅一个成功，另一个拒绝且不破坏胜出者
    const raceDir = path.join(dir, 'race-rec');
    const [rA, rB] = await Promise.allSettled([
      TraceRecordingStore.create({
        recordingDir: raceDir,
        recordId: 'race-1',
        identity: { sessionId: 's-pg', sessionGeneration: 1, bootGeneration: 1, recordId: 'race-1' },
      }),
      TraceRecordingStore.create({
        recordingDir: raceDir,
        recordId: 'race-2',
        identity: { sessionId: 's-pg', sessionGeneration: 1, bootGeneration: 1, recordId: 'race-2' },
      }),
    ]);
    const fulfilled = [rA, rB].filter((r): r is PromiseFulfilledResult<TraceRecordingStore> => r.status === 'fulfilled');
    const rejected = [rA, rB].filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    await fulfilled[0].value.close();
  });

  it('可恢复拒绝（缺序/重复/过期 boot/错会话）零副作用且派生超预算时终止录制', async () => {
    const sample = await fs.readFile('scripts/rtos/fixtures/samples/continuous.bin');
    const dir = await makeTempDir('orbit-store-reject-');

    const store = await TraceRecordingStore.create({
      recordingDir: dir,
      recordId: 'rec-rej',
      identity: { sessionId: 's-r', sessionGeneration: 1, bootGeneration: 2, recordId: 'rec-rej' },
    });
    expect((await store.ingestRawChunk(sample.subarray(0, 35), { batchSequence: 1 })).ok).toBe(true);

    // 缺序 seq=3、重复 seq=1、过期 boot=1、错会话均须被拒绝且对 decoder/reconstructor 无副作用
    const gRes = await store.ingestRawChunk(sample.subarray(44), { batchSequence: 3 });
    expect(gRes.ok).toBe(false);
    if (!gRes.ok) expect(gRes.errorCode).toBe('BatchSequenceGap');

    const dupRes = await store.ingestRawChunk(sample.subarray(0, 35), { batchSequence: 1 });
    expect(dupRes.ok).toBe(false);
    if (!dupRes.ok) expect(dupRes.errorCode).toBe('BatchSequenceInvalid');

    const staleBoot = await store.ingestRawChunk(sample.subarray(35, 44), { batchSequence: 2, bootGeneration: 1 });
    expect(staleBoot.ok).toBe(false);
    if (!staleBoot.ok) expect(staleBoot.errorCode).toBe('StaleBootGeneration');

    // 正确重试 seq=2 与 seq=3
    expect((await store.ingestRawChunk(sample.subarray(35, 44), { batchSequence: 2 })).ok).toBe(true);
    expect((await store.ingestRawChunk(sample.subarray(44), { batchSequence: 3 })).ok).toBe(true);
    expect((await store.finish()).ok).toBe(true);

    const pkts = await store.queryRange<DecodedSystemViewPacket>({
      target: 'packets',
      unit: 'byte-offset',
      start: 0,
      end: 160,
    });
    expect(pkts.ok).toBe(true);
    if (pkts.ok) {
      const taskCreate = pkts.data.items.find((p) => p.eventId === 8);
      const stopPkt = pkts.data.items.find((p) => p.eventId === 11);
      expect(taskCreate?.streamByteOffset).toBe(35);
      expect(taskCreate?.absoluteTicks).toBe('110');
      expect(stopPkt?.streamByteOffset).toBe(66);
      expect(stopPkt?.absoluteTicks).toBe('210');
    }
    await store.close();

    // 派生输出超写队列预算：先提交的第 1 批保留，超预算的第 2 批必须终止录制为 failed 而非接受后续批次
    const dirBudget = await makeTempDir('orbit-store-derived-budget-');
    const bStore = await TraceRecordingStore.create({
      recordingDir: dirBudget,
      recordId: 'rec-db',
      identity: { sessionId: 's-db', sessionGeneration: 1, bootGeneration: 1, recordId: 'rec-db' },
      limits: { maxSingleBatchBytes: 2048, maxWriteQueueBytes: 2048 },
    });
    expect((await bStore.ingestRawChunk(sample.subarray(0, 35), { batchSequence: 1 })).ok).toBe(true);
    // 构造 600 字节的 300 个 2-byte NOP 包：原始长度 600 <= 2048，但派生包估算 300*72 = 21600 > 2048
    const nopWithZeroDelta = new Uint8Array(600);
    for (let i = 0; i < 600; i += 2) {
      nopWithZeroDelta[i] = 0;
      nopWithZeroDelta[i + 1] = 1;
    }
    const over = await bStore.ingestRawChunk(nopWithZeroDelta, { batchSequence: 2 });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.errorCode).toBe('WriteQueueFull');
    expect(bStore.getState()).toBe('failed');
    // 终止后后续批次必须继续被拒绝
    expect((await bStore.ingestRawChunk(sample.subarray(35, 44), { batchSequence: 3 })).ok).toBe(false);
    await bStore.close();
  });

  it('saveArchive 支持完整/坏索引/坏块精确前缀恢复、路径安全保护与取消/写失败回滚', async () => {
    const sample = await fs.readFile('scripts/rtos/fixtures/samples/continuous.bin');
    const sandbox = await makeTempDir('orbit-save-sandbox-');
    const dirSrc = path.join(sandbox, 'src');
    const store = await TraceRecordingStore.create({
      recordingDir: dirSrc,
      recordId: 'rec-save',
      identity: { sessionId: 's-save', sessionGeneration: 1, bootGeneration: 1, recordId: 'rec-save' },
      commitOnEachIngest: true,
    });
    expect((await store.ingestRawChunk(sample.subarray(0, 35), { batchSequence: 1 })).ok).toBe(true);
    expect((await store.ingestRawChunk(sample.subarray(35), { batchSequence: 2 })).ok).toBe(true);
    expect((await store.finish()).ok).toBe(true);

    // 1. 路径安全拒绝：自导出、子目录、父目录、非空目标目录、.svdat 扩展名
    const sameRes = await store.saveArchive({ targetDir: dirSrc });
    expect(sameRes.ok).toBe(false);
    if (!sameRes.ok) expect(sameRes.errorCode).toBe('ExportPathConflict');

    const childRes = await store.saveArchive({ targetDir: path.join(dirSrc, 'nested-copy') });
    expect(childRes.ok).toBe(false);
    if (!childRes.ok) expect(childRes.errorCode).toBe('ExportPathConflict');

    const parentRes = await store.saveArchive({ targetDir: path.dirname(dirSrc) });
    expect(parentRes.ok).toBe(false);
    if (!parentRes.ok) expect(parentRes.errorCode).toBe('ExportPathConflict');

    const nonEmptyDir = path.join(sandbox, 'nonempty');
    await fs.mkdir(nonEmptyDir, { recursive: true });
    await fs.writeFile(path.join(nonEmptyDir, 'keep.txt'), 'do-not-overwrite');
    const nonEmptyRes = await store.saveArchive({ targetDir: nonEmptyDir });
    expect(nonEmptyRes.ok).toBe(false);
    if (!nonEmptyRes.ok) expect(nonEmptyRes.errorCode).toBe('RecordingDirectoryNotEmpty');

    const svdatArchiveRes = await store.saveArchive({ targetDir: path.join(sandbox, 'bad.SVDat') });
    expect(svdatArchiveRes.ok).toBe(false);
    if (!svdatArchiveRes.ok) expect(svdatArchiveRes.errorCode).toBe('UnsupportedCapability');

    // 2. 正常保存到空目录并重开校验一致性
    const cleanOut = path.join(sandbox, 'saved-clean');
    const saveOk = await store.saveArchive({ targetDir: cleanOut });
    expect(saveOk).toMatchObject({ ok: true });
    if (saveOk.ok) {
      expect(saveOk.data.inspection.recoverableRawBytes).toBe(sample.length);
      expect(saveOk.data.inspection.rawSha256Verified).toBe(true);
    }
    const { store: reopenedClean, inspection: cleanInsp } = await TraceRecordingStore.open({ recordingDir: cleanOut });
    expect(cleanInsp.status).toBe('completed');
    await reopenedClean.close();
    await store.close();

    // 3. 损坏第 2 批已提交块 -> 只恢复精确的第 1 批前缀（35 B）
    const dirCorrupt = path.join(sandbox, 'corrupt-src');
    await fs.cp(dirSrc, dirCorrupt, { recursive: true });
    const rawPath = path.join(dirCorrupt, ORBIT_TRACE_FILES.raw);
    const rawBuf = await fs.readFile(rawPath);
    rawBuf[40] ^= 0xff;
    await fs.writeFile(rawPath, rawBuf);
    const { store: corruptStore } = await TraceRecordingStore.open({ recordingDir: dirCorrupt });
    expect(corruptStore.getInspection()?.recoveryDisposition).toBe('recovered-prefix-bad-chunk');
    const recoveredOut = path.join(sandbox, 'saved-recovered-prefix');
    const recRes = await corruptStore.saveArchive({ targetDir: recoveredOut });
    expect(recRes.ok).toBe(true);
    if (recRes.ok) {
      expect(recRes.data.inspection.recoverableRawBytes).toBe(35);
      expect(recRes.data.inspection.recoveryDisposition).toBe('recovered-interrupted');
      const expRaw = path.join(sandbox, 'prefix.bin');
      const { store: reopenedRec } = await TraceRecordingStore.open({ recordingDir: recoveredOut });
      expect((await reopenedRec.exportRaw({ outputPath: expRaw })).ok).toBe(true);
      expect(createHash('sha256').update(await fs.readFile(expRaw)).digest('hex')).toBe(
        createHash('sha256').update(sample.subarray(0, 35)).digest('hex'),
      );
      await reopenedRec.close();
    }
    await corruptStore.close();

    // 4. 取消与写失败（ENOSPC）回滚，不能残留临时目录或部分输出
    const { store: reopenedForFail } = await TraceRecordingStore.open({ recordingDir: cleanOut });
    const cancelOut = path.join(sandbox, 'saved-cancelled');
    const cancelRes = await reopenedForFail.saveArchive({
      targetDir: cancelOut,
      cancel: { isCancelled: () => true },
    });
    expect(cancelRes.ok).toBe(false);
    if (!cancelRes.ok) expect(cancelRes.errorCode).toBe('QueryCancelled');
    await expect(fs.stat(cancelOut)).rejects.toThrow();

    const failFs = new (class extends NodeTraceFileSystem {
      override async open(filePath: string, flags: string): Promise<TraceFileHandle> {
        const handle = await super.open(filePath, flags);
        if (flags === 'wx' && filePath.includes('saved-enospc')) {
          return {
            async write() {
              const e: NodeJS.ErrnoException = new Error('No space left on device');
              e.code = 'ENOSPC';
              throw e;
            },
            read: handle.read.bind(handle),
            truncate: handle.truncate.bind(handle),
            stat: handle.stat.bind(handle),
            sync: handle.sync.bind(handle),
            close: handle.close.bind(handle),
          };
        }
        return handle;
      }
    })();
    const enospcDir = path.join(sandbox, 'saved-enospc');
    const { store: reopenEnospc } = await TraceRecordingStore.open({ recordingDir: cleanOut, fileSystem: failFs });
    const enospcRes = await reopenEnospc.saveArchive({ targetDir: enospcDir });
    expect(enospcRes.ok).toBe(false);
    if (!enospcRes.ok) expect(enospcRes.errorCode).toBe('ENOSPC');
    await expect(fs.stat(enospcDir)).rejects.toThrow();
    await reopenEnospc.close();
    await reopenedForFail.close();
  });

  it('exportRaw 同路径并发、提交时目标抢占（含硬链接/EXDEV回退wx）与发布取消均不覆盖赢家文件', async () => {
    const sample = await fs.readFile('scripts/rtos/fixtures/samples/continuous.bin');
    const sandbox = await makeTempDir('orbit-raw-race-');
    const recDir = path.join(sandbox, 'rec');
    const s = await TraceRecordingStore.create({
      recordingDir: recDir,
      recordId: 'rec-raw-race',
      identity: { sessionId: 's-rr', sessionGeneration: 1, bootGeneration: 1, recordId: 'rec-raw-race' },
      commitOnEachIngest: true,
    });
    expect((await s.ingestRawChunk(sample, { batchSequence: 1 })).ok).toBe(true);
    expect((await s.finish()).ok).toBe(true);
    await s.close();

    // 1. 两个并发 exportRaw 竞争同一 outputPath：恰好 1 胜 1 负（ExportTargetExists），赢家内容完整且无残留临时文件
    const sameRawOut = path.join(sandbox, 'concurrent.bin');
    const { store: s1 } = await TraceRecordingStore.open({ recordingDir: recDir });
    const { store: s2 } = await TraceRecordingStore.open({ recordingDir: recDir });
    const [r1, r2] = await Promise.all([
      s1.exportRaw({ outputPath: sameRawOut }),
      s2.exportRaw({ outputPath: sameRawOut }),
    ]);
    await Promise.all([s1.close(), s2.close()]);
    const oks = [r1, r2].filter((r) => r.ok);
    const errs = [r1, r2].filter((r) => !r.ok);
    expect(oks.length).toBe(1);
    expect(errs.length).toBe(1);
    if (!errs[0].ok) expect(errs[0].errorCode).toBe('ExportTargetExists');
    expect((await fs.readFile(sameRawOut)).length).toBe(sample.length);
    expect((await fs.readdir(sandbox)).filter((n) => n.includes('.orbit-export-'))).toEqual([]);

    // 2. 提交时在 link() 之前并发写入外部文件，以及 EXDEV 回退 'wx' 前并发写入外部文件：均拒绝覆盖并保护外部赢家
    const externalContent = Buffer.from('EXTERNAL_RAW_WINNER');
    for (const mode of ['link-race', 'exdev-wx-race'] as const) {
      const targetOut = path.join(sandbox, `${mode}.bin`);
      const raceFs = new (class extends NodeTraceFileSystem {
        override async link(existingPath: string, newPath: string): Promise<void> {
          if (newPath === targetOut) {
            if (mode === 'link-race') {
              await fs.writeFile(newPath, externalContent, { flag: 'wx' });
            } else {
              const e: NodeJS.ErrnoException = new Error('EXDEV unsupported');
              e.code = 'EXDEV';
              throw e;
            }
          }
          return super.link(existingPath, newPath);
        }
        override async open(filePath: string, flags: string): Promise<TraceFileHandle> {
          if (mode === 'exdev-wx-race' && flags === 'wx' && filePath === targetOut) {
            await fs.writeFile(targetOut, externalContent, { flag: 'wx' });
          }
          return super.open(filePath, flags);
        }
      })();
      const { store: sr } = await TraceRecordingStore.open({ recordingDir: recDir, fileSystem: raceFs });
      const res = await sr.exportRaw({ outputPath: targetOut });
      await sr.close();
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.errorCode).toBe('ExportTargetExists');
      expect(await fs.readFile(targetOut)).toEqual(externalContent);
      expect((await fs.readdir(sandbox)).filter((n) => n.includes('.orbit-export-'))).toEqual([]);
    }

    // 3. 发布阶段 fallback wx 拷贝途中取消：清理新建部分文件与临时文件，且 0 字节录制同样走无覆盖发布
    let cancelFlag = false;
    const cancelFallbackFs = new (class extends NodeTraceFileSystem {
      override async link(): Promise<void> {
        const e: NodeJS.ErrnoException = new Error('ENOTSUP');
        e.code = 'ENOTSUP';
        throw e;
      }
      override async open(filePath: string, flags: string): Promise<TraceFileHandle> {
        const h = await super.open(filePath, flags);
        if (flags === 'wx' && filePath.endsWith('cancel-pub.bin')) {
          return {
            async write(buf, offset, length, position) {
              cancelFlag = true;
              return h.write(buf, offset, length, position);
            },
            read: h.read.bind(h),
            truncate: h.truncate.bind(h),
            stat: h.stat.bind(h),
            sync: h.sync.bind(h),
            close: h.close.bind(h),
          };
        }
        return h;
      }
    })();
    const cancelOut = path.join(sandbox, 'cancel-pub.bin');
    const { store: sc } = await TraceRecordingStore.open({ recordingDir: recDir, fileSystem: cancelFallbackFs });
    const cancelRes = await sc.exportRaw({
      outputPath: cancelOut,
      cancel: { isCancelled: () => cancelFlag },
    });
    await sc.close();
    expect(cancelRes.ok).toBe(false);
    if (!cancelRes.ok) expect(cancelRes.errorCode).toBe('QueryCancelled');
    await expect(fs.stat(cancelOut)).rejects.toThrow();
    expect((await fs.readdir(sandbox)).filter((n) => n.includes('.orbit-export-'))).toEqual([]);

    // 4. 0 字节导出在提交前目标被并发创建：同样拒绝覆盖
    const emptyDir = path.join(sandbox, 'empty-rec');
    const se = await TraceRecordingStore.create({
      recordingDir: emptyDir,
      recordId: 'rec-empty-race',
      identity: { sessionId: 's-er', sessionGeneration: 1, bootGeneration: 1, recordId: 'rec-empty-race' },
    });
    expect((await se.finish()).ok).toBe(true);
    await se.close();
    const emptyTarget = path.join(sandbox, 'empty-race.bin');
    const emptyRaceFs = new (class extends NodeTraceFileSystem {
      override async link(existingPath: string, newPath: string): Promise<void> {
        if (newPath === emptyTarget) {
          await fs.writeFile(newPath, externalContent, { flag: 'wx' });
        }
        return super.link(existingPath, newPath);
      }
    })();
    const { store: seOpen } = await TraceRecordingStore.open({ recordingDir: emptyDir, fileSystem: emptyRaceFs });
    const seRes = await seOpen.exportRaw({ outputPath: emptyTarget });
    await seOpen.close();
    expect(seRes.ok).toBe(false);
    if (!seRes.ok) expect(seRes.errorCode).toBe('ExportTargetExists');
    expect(await fs.readFile(emptyTarget)).toEqual(externalContent);
  });
});
