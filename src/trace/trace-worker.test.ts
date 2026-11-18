import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TraceWorkerClient } from './trace-worker-client';

const tempDirs: string[] = [];
const clientsToCleanup: TraceWorkerClient[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (clientsToCleanup.length > 0) {
    const c = clientsToCleanup.pop()!;
    await c.shutdown('test-cleanup');
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe('worker_threads Trace Worker 与宿主客户端 (阶段 4.3)', () => {
  it('完成 Worker 录制、缺口/复位、范围查询、LOD、流式原始导出与有序关闭', async () => {
    const sample = await fs.readFile('scripts/rtos/fixtures/samples/continuous.bin');
    const dir = await makeTempDir('orbit-worker-e2e-');
    const recDir = path.join(dir, 'rec1');
    const exportPath = path.join(dir, 'exported.bin');

    const progressEvents: Array<{ recordId: string; committedRawBytes: number }> = [];
    const client = new TraceWorkerClient({
      onProgress: (ev) => {
        progressEvents.push({ recordId: ev.recordId, committedRawBytes: ev.committedRawBytes });
      },
    });
    clientsToCleanup.push(client);

    const createRes = await client.createRecording({
      recordingDir: recDir,
      recordId: 'rec-w1',
      identity: { sessionId: 'sess-w', sessionGeneration: 1, bootGeneration: 1, recordId: 'rec-w1' },
      commitOnEachIngest: true,
    });
    expect(createRes.ok).toBe(true);

    const mid = Math.floor(sample.length / 2);
    expect(
      (
        await client.ingestChunk({
          recordId: 'rec-w1',
          sessionId: 'sess-w',
          sessionGeneration: 1,
          batchSequence: 1,
          chunk: sample.subarray(0, mid),
        })
      ).ok,
    ).toBe(true);

    expect(
      (
        await client.ingestChunk({
          recordId: 'rec-w1',
          sessionId: 'sess-w',
          sessionGeneration: 1,
          batchSequence: 2,
          chunk: sample.subarray(mid),
        })
      ).ok,
    ).toBe(true);

    const finRes = await client.finishRecording('rec-w1', 'unit-test-done');
    expect(finRes.ok).toBe(true);
    if (finRes.ok) {
      expect(finRes.data.state).toBe('completed');
      expect(finRes.data.committed.rawBytes).toBe(sample.length);
    }

    // finishRecording 后、closeRecording 前仍可直接查询与导出
    const qAfterFinish = await client.queryRange('rec-w1', {
      target: 'packets',
      start: 0n,
      end: 1_000_000_000n,
      unit: 'relative-ticks',
      limit: 50,
    });
    expect(qAfterFinish.ok).toBe(true);
    if (qAfterFinish.ok) {
      expect(qAfterFinish.data.items.length).toBeGreaterThan(0);
    }
    expect((await client.closeRecording('rec-w1')).ok).toBe(true);

    // 重开离线回放
    const openRes = await client.openRecording({ recordingDir: recDir, recordId: 'rec-w1-replay' });
    expect(openRes.ok).toBe(true);
    if (!openRes.ok) return;
    expect(openRes.data.inspection.isComplete).toBe(true);

    // 范围查询（packets 与 slices）
    const qPkts = await client.queryRange('rec-w1-replay', {
      target: 'packets',
      start: 0n,
      end: 1_000_000_000n,
      unit: 'relative-ticks',
      limit: 50,
    });
    expect(qPkts.ok).toBe(true);
    if (qPkts.ok) {
      expect(qPkts.data.items.length).toBeGreaterThan(0);
    }

    const qLod = await client.queryLod('rec-w1-replay', {
      start: 0n,
      end: 1_000_000n,
      unit: 'relative-ticks',
      maxBuckets: 8,
    });
    expect(qLod.ok).toBe(true);
    if (qLod.ok) {
      expect(qLod.data.buckets.length).toBeGreaterThan(0);
    }

    // 导出到文件 + 拉模式流式导出逐字节比对
    const expFile = await client.exportRawToFile('rec-w1-replay', exportPath);
    expect(expFile.ok).toBe(true);
    expect(Buffer.compare(await fs.readFile(exportPath), sample)).toBe(0);

    const streamRes = await client.openRawExportStream('rec-w1-replay', { chunkBytes: 300 });
    expect(streamRes.ok).toBe(true);
    if (streamRes.ok) {
      const chunks: Uint8Array[] = [];
      while (true) {
        // 模拟慢消费者间隔拉取
        await new Promise((r) => setTimeout(r, 5));
        const part = await streamRes.data.pull();
        expect(part.ok).toBe(true);
        if (!part.ok) break;
        if (part.data.chunk.length > 0) chunks.push(part.data.chunk);
        if (part.data.done) break;
      }
      await streamRes.data.close();
      // 幂等二次 close
      await streamRes.data.close();
      expect(Buffer.compare(Buffer.concat(chunks), sample)).toBe(0);
    }

    // 幂等多次关闭同一录制
    expect((await client.closeRecording('rec-w1-replay')).ok).toBe(true);
    const secondClose = await client.closeRecording('rec-w1-replay');
    expect(secondClose.ok).toBe(true);
    if (secondClose.ok) {
      expect(secondClose.data.alreadyClosed).toBe(true);
    }

    expect(progressEvents.length).toBeGreaterThan(0);

    const shut = await client.shutdown();
    expect(shut.exitCode).toBe(0);
    expect(shut.forced).toBe(false);
  });

  it('慢消费者背压限制在途队列上限且聚合进度不堆积', async () => {
    const dir = await makeTempDir('orbit-worker-bp-');
    const recDir = path.join(dir, 'rec-bp');

    let progressCalls = 0;
    const client = new TraceWorkerClient({
      limits: {
        maxSingleBatchBytes: 2048,
        maxInputQueueBytes: 4096,
        maxInputQueueBatches: 2,
        inputLowWaterMarkBytes: 2048,
      },
      onProgress: async () => {
        progressCalls += 1;
        // 故意制造慢消费者进度回调
        await new Promise((r) => setTimeout(r, 40));
      },
    });
    clientsToCleanup.push(client);

    await client.createRecording({
      recordingDir: recDir,
      recordId: 'rec-bp',
      identity: { sessionId: 's-bp', sessionGeneration: 1, bootGeneration: 1, recordId: 'rec-bp' },
      commitOnEachIngest: true,
    });

    const chunk = new Uint8Array(1536).fill(0);
    // 并发发起 8 个非阻塞 tryIngestChunk：超出 2 批 / 4096 B 上限的请求必须立刻返回背压而非无限堆积
    const promises = Array.from({ length: 8 }, (_, idx) =>
      client.tryIngestChunk({
        recordId: 'rec-bp',
        sessionId: 's-bp',
        sessionGeneration: 1,
        batchSequence: idx + 1,
        chunk,
      }),
    );
    const settled = await Promise.all(promises);
    const rejectedBp = settled.filter((r) => !r.ok && r.backpressure);
    expect(rejectedBp.length).toBeGreaterThanOrEqual(4);

    const hostStats = client.getHostStats();
    expect(hostStats.peakInFlightInputBytes).toBeLessThanOrEqual(4096);
    expect(hostStats.peakInFlightInputBatches).toBeLessThanOrEqual(2);
    expect(hostStats.hostBackpressureRejects).toBe(rejectedBp.length);

    // 确认由于慢 onProgress，期间并未积压 8 次进度推送（单槽聚合）
    expect(progressCalls).toBeLessThanOrEqual(2);

    await client.finishRecording('rec-bp');
    await client.shutdown();
  });

  it('支持 SAB 与纯消息双模式中途取消查询，且不影响并发正常查询', async () => {
    const dir = await makeTempDir('orbit-worker-cancel-');
    const recDir = path.join(dir, 'rec-cancel');
    // 基于仓库已提交的独立样本头构造内存级有界循环流（不依赖 out/ 下被 gitignore 的实验文件）
    const baseSample = await fs.readFile('scripts/rtos/fixtures/samples/continuous.bin');
    const preamble = baseSample.subarray(0, 31);
    const taskCreate = Uint8Array.from([8, 0x40, 1]);
    const cycle = Uint8Array.from([6, 0x40, 2, 4, 0x40, 3, 2, 17, 5, 3, 7, 5, 11, 17, 2]);
    const cycles = 800; // 4,805 包 (~12 KiB)，配合小页与每页让步稳定产生数百次协作调度点
    const traceBytes = new Uint8Array(preamble.length + taskCreate.length + cycles * cycle.length + 2);
    traceBytes.set(preamble, 0);
    traceBytes.set(taskCreate, preamble.length);
    for (let i = 0; i < cycles; i++) {
      traceBytes.set(cycle, preamble.length + taskCreate.length + i * cycle.length);
    }
    traceBytes[traceBytes.length - 2] = 11;
    traceBytes[traceBytes.length - 1] = 1;

    for (const useSharedCancelBuffer of [true, false]) {
      const subDir = path.join(recDir, useSharedCancelBuffer ? 'sab' : 'msg');
      const client = new TraceWorkerClient({
        useSharedCancelBuffer,
        limits: {
          maxSingleBatchBytes: 64 * 1024,
          maxInputQueueBytes: 256 * 1024,
          maxInputQueueBatches: 16,
          inputLowWaterMarkBytes: 128 * 1024,
          storageLimits: { rawChunkBytes: 32 * 1024, pageMaxItems: 16, maxCachedPages: 2 },
        },
      });
      clientsToCleanup.push(client);

      await client.createRecording({
        recordingDir: subDir,
        recordId: 'rec-c',
        identity: { sessionId: 's-c', sessionGeneration: 1, bootGeneration: 1, recordId: 'rec-c' },
        commitOnEachIngest: true,
      });

      const ingRes = await client.ingestChunk({
        recordId: 'rec-c',
        sessionId: 's-c',
        sessionGeneration: 1,
        batchSequence: 1,
        chunk: traceBytes,
      });
      expect(ingRes.ok).toBe(true);
      await client.flushRecording('rec-c');

      const ac = new AbortController();
      const longQuery = client.queryRange(
        'rec-c',
        {
          target: 'packets',
          start: 0n,
          end: 100_000_000n,
          unit: 'relative-ticks',
          limit: 4096,
        },
        { signal: ac.signal, yieldEveryPages: 1, yieldEveryItems: 4 },
      );
      const normalQuery = client.queryRange('rec-c', {
        target: 'slices',
        start: 100n,
        end: 200n,
        unit: 'relative-ticks',
        limit: 20,
      });

      // 在数百页逐页让步调度窗口内触发中途取消
      setTimeout(() => ac.abort(), 5);

      const [longRes, normalRes] = await Promise.all([longQuery, normalQuery]);
      expect(longRes.ok).toBe(false);
      if (!longRes.ok) {
        expect(longRes.errorCode).toBe('QueryCancelled');
        expect(longRes.cancelled).toBe(true);
      }
      expect(normalRes.ok).toBe(true);
      if (normalRes.ok) {
        expect(normalRes.data.items.length).toBeGreaterThan(0);
      }
      expect(client.getHostStats().activeCancelSlots).toBe(0);

      await client.finishRecording('rec-c');
      await client.closeRecording('rec-c');
      await client.shutdown();
    }
  });

  it('严格隔离不同 recordId 与 sessionId，防止跨 record 污染或重复释放', async () => {
    const sample = await fs.readFile('scripts/rtos/fixtures/samples/continuous.bin');
    const dir = await makeTempDir('orbit-worker-iso-');
    const dirA = path.join(dir, 'A');
    const dirB = path.join(dir, 'B');

    const client = new TraceWorkerClient();
    clientsToCleanup.push(client);

    await client.createRecording({
      recordingDir: dirA,
      recordId: 'rec-A',
      identity: { sessionId: 'sess-A', sessionGeneration: 1, bootGeneration: 1, recordId: 'rec-A' },
    });
    await client.createRecording({
      recordingDir: dirB,
      recordId: 'rec-B',
      identity: { sessionId: 'sess-B', sessionGeneration: 9, bootGeneration: 1, recordId: 'rec-B' },
    });

    // 错误会话写入 rec-A 必须被拒绝且不得污染 rec-A 或 rec-B
    const badSess = await client.ingestChunk({
      recordId: 'rec-A',
      sessionId: 'sess-B',
      sessionGeneration: 9,
      batchSequence: 1,
      chunk: sample.subarray(0, 100),
    });
    expect(badSess.ok).toBe(false);
    if (!badSess.ok) {
      expect(badSess.errorCode).toBe('SessionChanged');
    }

    // 正常向 A 写入前半、向 B 写入全量
    expect(
      (
        await client.ingestChunk({
          recordId: 'rec-A',
          sessionId: 'sess-A',
          sessionGeneration: 1,
          batchSequence: 1,
          chunk: sample.subarray(0, 128),
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await client.ingestChunk({
          recordId: 'rec-B',
          sessionId: 'sess-B',
          sessionGeneration: 9,
          batchSequence: 1,
          chunk: sample,
        })
      ).ok,
    ).toBe(true);

    // 关闭 A 两次不影响 B
    await client.finishRecording('rec-A');
    await client.closeRecording('rec-A');
    await client.closeRecording('rec-A');

    const statsB = await client.getStats('rec-B');
    expect(statsB.ok).toBe(true);
    if (statsB.ok) {
      expect(statsB.data.openRecordCount).toBe(1);
      expect(statsB.data.records['rec-B'].committed.rawBytes).toBe(sample.length);
      expect(statsB.data.records['rec-A']).toBeUndefined();
    }

    const finB = await client.finishRecording('rec-B');
    expect(finB.ok).toBe(true);
    if (finB.ok) {
      expect(finB.data.rawSha256).toBe(createHash('sha256').update(sample).digest('hex'));
    }
    await client.closeRecording('rec-B');

    const shut = await client.shutdown();
    expect(shut.exitCode).toBe(0);
  });

  it('Host 侧对 ingestChunk/ingestDecoded 等待数与并发查询上限施加硬预算', async () => {
    const dir = await makeTempDir('orbit-worker-host-budget-');
    const recDir = path.join(dir, 'rec-hb');
    const client = new TraceWorkerClient({
      limits: {
        maxSingleBatchBytes: 65536,
        maxInputQueueBytes: 65536,
        maxInputQueueBatches: 1,
        inputLowWaterMarkBytes: 0,
        maxPendingQueries: 2,
      },
    });
    clientsToCleanup.push(client);

    await client.createRecording({
      recordingDir: recDir,
      recordId: 'rec-hb',
      identity: { sessionId: 's-hb', sessionGeneration: 1, bootGeneration: 1, recordId: 'rec-hb' },
    });

    // 1. 并发 20 个 ingestChunk（64 KiB）：1 在途 + 至多 1 等待，其余立刻被拒绝，不保留超限缓冲
    const chunk = new Uint8Array(65536).fill(0);
    const ingestResults = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        client.ingestChunk({
          recordId: 'rec-hb',
          sessionId: 's-hb',
          sessionGeneration: 1,
          batchSequence: i + 1,
          chunk,
          backpressureTimeoutMs: 1000,
        }),
      ),
    );
    const hostStats = client.getHostStats();
    expect(hostStats.peakInFlightInputBytes).toBeLessThanOrEqual(65536);
    expect(hostStats.peakRetainedInputBytes).toBeLessThanOrEqual(131072);
    expect(ingestResults.filter((r) => !r.ok && r.backpressure).length).toBeGreaterThanOrEqual(15);

    // 2. 超限 ingestDecoded 被 Host 直接拒绝而不送入 Worker
    const hugePackets = Array.from({ length: 1000 }, () => ({} as any));
    const badDecoded = await client.ingestDecoded({
      recordId: 'rec-hb',
      decodeBatch: { packets: hugePackets, syncs: [], gaps: [], segments: [], diagnostics: [] },
      reconBatch: {
        protocolVersion: '3.32.0',
        accepted: true,
        identity: { sessionId: 's-hb', sessionGeneration: 1, bootGeneration: 1, recordId: 'rec-hb' },
        executionSlices: [],
        contextActivations: [],
        readyWaits: [],
        markers: [],
        markerPoints: [],
        taskUpdates: [],
        gapBoundaries: [],
        diagnostics: [],
      },
    });
    expect(badDecoded.ok).toBe(false);
    if (!badDecoded.ok) {
      expect(badDecoded.errorCode).toBe('BatchLimitExceeded');
    }

    // 3. 并发超过 maxPendingQueries=2 的查询在 Host 侧直接被拒绝
    const qAll = await Promise.all([
      client.queryRange('rec-hb', { target: 'packets', start: 0n, end: 1000n, unit: 'relative-ticks' }),
      client.queryRange('rec-hb', { target: 'packets', start: 0n, end: 1000n, unit: 'relative-ticks' }),
      client.queryRange('rec-hb', { target: 'packets', start: 0n, end: 1000n, unit: 'relative-ticks' }),
      client.queryRange('rec-hb', { target: 'packets', start: 0n, end: 1000n, unit: 'relative-ticks' }),
    ]);
    expect(qAll.some((q) => !q.ok && q.errorCode === ('QueryQueueFull' as any))).toBe(true);

    await client.finishRecording('rec-hb');
    await client.closeRecording('rec-hb');
    await client.shutdown();
  });
});
