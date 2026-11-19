'use strict';
/**
 * RTOS 阶段 4.5 Trace 性能与资源基准脚本（离线 Worker + 1M 事件 + 并发取消）。
 * 真实 VS Code + Chromium 帧耗时与长任务另由 scripts/rtos/verify-stage45-vscode.js 实测。
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const workspaceRoot = path.resolve(__dirname, '../..');

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[idx] * 100) / 100;
}

async function main() {
  const outPath = path.resolve(
    process.argv.find(a => a.startsWith('--out='))?.slice(6)
    || path.join(workspaceRoot, 'out/rtos-stage4/acceptance-4.5/benchmark-worker.json'),
  );
  await fsp.mkdir(path.dirname(outPath), { recursive: true });

  const esbuild = require('esbuild');
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'orbit-bench45-'));
  const bundlePath = path.join(tmpDir, 'worker-client.cjs');
  await esbuild.build({
    entryPoints: [path.join(workspaceRoot, 'src/trace/trace-worker-client.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: bundlePath,
  });

  const { TraceWorkerClient } = require(bundlePath);
  const workerPath = path.join(workspaceRoot, 'dist/trace-worker.js');
  const client = new TraceWorkerClient({ workerPath });

  try {
    const baseSample = await fsp.readFile(path.join(workspaceRoot, 'scripts/rtos/fixtures/samples/continuous.bin'));
    const preamble = baseSample.subarray(0, 31);
    const taskCreate = Uint8Array.from([8, 0x40, 1]);
    const cycle = Uint8Array.from([6, 0x40, 2, 4, 0x40, 3, 2, 17, 5, 3, 7, 5, 11, 17, 2]);
    const cycles = 167_000;
    const raw = new Uint8Array(preamble.length + taskCreate.length + cycles * cycle.length + 2);
    raw.set(preamble, 0);
    raw.set(taskCreate, preamble.length);
    let pos = preamble.length + taskCreate.length;
    for (let i = 0; i < cycles; i++) {
      raw.set(cycle, pos);
      pos += cycle.length;
    }
    raw[pos] = 11;
    raw[pos + 1] = 1;

    const recDir = path.join(tmpDir, 'rec-1m');
    const t0 = performance.now();
    await client.createRecording({
      recordingDir: recDir,
      recordId: 'bench-1m',
      identity: { sessionId: 'bench', sessionGeneration: 1, bootGeneration: 1, recordId: 'bench-1m' },
      commitOnEachIngest: false,
    });

    const chunkBytes = 32 * 1024;
    let seq = 1;
    for (let off = 0; off < raw.length; off += chunkBytes) {
      const res = await client.ingestChunk({
        recordId: 'bench-1m',
        sessionId: 'bench',
        sessionGeneration: 1,
        batchSequence: seq++,
        chunk: raw.subarray(off, Math.min(raw.length, off + chunkBytes)),
      });
      if (!res.ok) throw new Error(`ingestChunk failed: ${res.errorCode} ${res.message}`);
    }
    const ingestMs = performance.now() - t0;

    const tFin0 = performance.now();
    const fin = await client.finishRecording('bench-1m', 'bench-done');
    const finishMs = performance.now() - tFin0;
    if (!fin.ok) throw new Error(`finish failed: ${fin.errorCode}`);

    const packetCount = fin.data.committed.packetCount;
    const rawBytes = fin.data.committed.rawBytes;

    // 20 LOD queries across 1M dataset
    const lodLatenciesMs = [];
    for (let i = 0; i < 20; i++) {
      const start = BigInt(i * 150_000);
      const end = start + 800_000n;
      const q0 = performance.now();
      const res = await client.queryLod('bench-1m', { start, end, unit: 'relative-ticks', maxBuckets: 256 });
      const dt = performance.now() - q0;
      if (!res.ok) throw new Error(`queryLod failed: ${res.errorCode}`);
      lodLatenciesMs.push(dt);
    }

    // 20 exact point/window slice queries across 1M dataset
    const exactPointLatenciesMs = [];
    for (let i = 0; i < 20; i++) {
      const start = BigInt(200_000 + i * 130_000);
      const end = start + 1n;
      const q0 = performance.now();
      const res = await client.queryRange('bench-1m', {
        target: 'slices',
        start,
        end,
        unit: 'relative-ticks',
        limit: 64,
      });
      const dt = performance.now() - q0;
      if (!res.ok) throw new Error(`exact queryRange failed: ${res.errorCode}`);
      exactPointLatenciesMs.push(dt);
    }

    // 20 zoomed-in viewport slice queries (~1000 ticks wide)
    const zoomedRangeLatenciesMs = [];
    for (let i = 0; i < 20; i++) {
      const start = BigInt(100_000 + i * 130_000);
      const end = start + 2000n;
      const q0 = performance.now();
      const res = await client.queryRange('bench-1m', {
        target: 'slices',
        start,
        end,
        unit: 'relative-ticks',
        limit: 1200,
      });
      const dt = performance.now() - q0;
      if (!res.ok) throw new Error(`zoomed queryRange failed: ${res.errorCode}`);
      zoomedRangeLatenciesMs.push(dt);
    }

    // Rapid cancellation test (12 back-to-back queries aborting prior ones)
    const cancelControllers = [];
    const cancelPromises = [];
    const tCancel0 = performance.now();
    for (let i = 0; i < 12; i++) {
      if (cancelControllers.length > 0) {
        cancelControllers[cancelControllers.length - 1].abort();
      }
      const ac = new AbortController();
      cancelControllers.push(ac);
      cancelPromises.push(
        client.queryLod('bench-1m', {
          start: BigInt(i * 100_000),
          end: BigInt(i * 100_000 + 600_000),
          unit: 'relative-ticks',
          maxBuckets: 256,
        }, { signal: ac.signal }),
      );
    }
    const cancelSettled = await Promise.all(cancelPromises);
    const rapidCancelTotalMs = Math.round((performance.now() - tCancel0) * 100) / 100;
    const cancelledCount = cancelSettled.filter(r => !r.ok && r.cancelled).length;
    const finalCancelOk = cancelSettled[cancelSettled.length - 1].ok;

    const statsRes = await client.getStats('bench-1m');
    const hostStats = client.getHostStats();
    const recStats = statsRes.ok ? statsRes.data.records['bench-1m'] : null;

    const report = {
      timestamp: new Date().toISOString(),
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        cpus: os.cpus().length,
      },
      dataset: {
        packetCount,
        rawBytes,
        sliceCount: fin.data.committed.sliceCount,
        activationCount: fin.data.committed.activationCount,
        readyWaitCount: fin.data.committed.readyWaitCount,
      },
      ingestion: {
        ingestMs: Math.round(ingestMs * 100) / 100,
        finishMs: Math.round(finishMs * 100) / 100,
        packetsPerSec: Math.round(packetCount / (ingestMs / 1000)),
        bytesPerSec: Math.round(rawBytes / (ingestMs / 1000)),
      },
      queries: {
        lodP50Ms: percentile(lodLatenciesMs, 50),
        lodP95Ms: percentile(lodLatenciesMs, 95),
        lodMaxMs: percentile(lodLatenciesMs, 100),
        exactPointP50Ms: percentile(exactPointLatenciesMs, 50),
        exactPointP95Ms: percentile(exactPointLatenciesMs, 95),
        exactPointMaxMs: percentile(exactPointLatenciesMs, 100),
        zoomedViewportP50Ms: percentile(zoomedRangeLatenciesMs, 50),
        zoomedViewportP95Ms: percentile(zoomedRangeLatenciesMs, 95),
        zoomedViewportMaxMs: percentile(zoomedRangeLatenciesMs, 100),
        rapidCancel12TotalMs: rapidCancelTotalMs,
        cancelledCount,
        finalCancelOk,
      },
      memoryAndQueues: {
        workerPeakRssBytes: recStats?.peakRssBytes ?? null,
        workerPeakHeapUsedBytes: recStats?.peakHeapUsedBytes ?? null,
        workerInMemoryPageDescriptors: recStats?.index?.inMemoryPageDescriptors ?? null,
        workerMaxIndexPages: recStats?.index?.maxIndexPagesInMemory ?? null,
        workerCachedPagesPeak: recStats?.cache?.peakCachedPages ?? null,
        workerCachedBytesPeak: recStats?.cache?.peakCachedBytes ?? null,
        hostPeakRetainedInputBytes: hostStats.peakRetainedInputBytes,
        hostPeakInFlightQueryCount: hostStats.peakInFlightQueryCount,
      },
    };

    await fsp.writeFile(outPath, JSON.stringify(report, null, 2));
    console.log('[benchmark-trace-45] PASSED:', JSON.stringify(report, null, 2));
  } finally {
    await client.shutdown('bench-end').catch(() => {});
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch(err => {
  console.error('[benchmark-trace-45] FAILED:', err);
  process.exitCode = 1;
});
