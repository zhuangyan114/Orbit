'use strict';
/**
 * RTOS 阶段 5.1 离线基准与归档守恒校验脚本：
 * - 1,002,005 包百万事件 Worker queryAnalysis 精确全量/缩放/快速取消/预算降级耗时与内存统计；
 * - 4.4 五份 H723 实板归档 + 4.5 H723 保存副本（只读拷贝，绝不修改原目录）的时间守恒与上下文/Marker 校验。
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

async function copyDirReadOnly(srcDir, dstDir) {
  await fsp.mkdir(dstDir, { recursive: true });
  const files = ['manifest.json', 'raw.otbin', 'data.otd', 'journal.otj', 'index.otidx', 'index-spill.otidx'];
  for (const f of files) {
    const src = path.join(srcDir, f);
    if (fs.existsSync(src)) {
      await fsp.copyFile(src, path.join(dstDir, f));
    }
  }
}

async function main() {
  const outPath = path.resolve(
    process.argv.find(a => a.startsWith('--out='))?.slice(6)
    || path.join(workspaceRoot, 'out/rtos-stage5/acceptance-5.1/benchmark-and-oracle.json'),
  );
  await fsp.mkdir(path.dirname(outPath), { recursive: true });

  const esbuild = require('esbuild');
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'orbit-bench51-'));
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

  const report = {
    ok: false,
    generatedAt: new Date().toISOString(),
    millionEvents: {},
    h723Archives: {},
  };

  try {
    // 1. 1,002,005-packet benchmark
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
    await client.createRecording({
      recordingDir: recDir,
      recordId: 'bench51-1m',
      identity: { sessionId: 'bench51', sessionGeneration: 1, bootGeneration: 1, recordId: 'bench51-1m' },
      commitOnEachIngest: false,
    });
    const chunkBytes = 32 * 1024;
    let seq = 1;
    for (let off = 0; off < raw.length; off += chunkBytes) {
      const r = await client.ingestChunk({
        recordId: 'bench51-1m',
        sessionId: 'bench51',
        sessionGeneration: 1,
        batchSequence: seq++,
        chunk: raw.subarray(off, Math.min(raw.length, off + chunkBytes)),
      });
      if (!r.ok) throw new Error(`ingestChunk failed: ${r.errorCode}`);
    }
    const fin = await client.finishRecording('bench51-1m', 'done');
    if (!fin.ok) throw new Error(`finish failed: ${fin.errorCode}`);

    const segsRes = await client.getSegments('bench51-1m');
    if (!segsRes.ok || !segsRes.data.length) throw new Error('missing segments');
    const seg = segsRes.data[0];

    // Full-range exact aggregation (5 runs)
    const fullLatencies = [];
    let lastFull = null;
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      const res = await client.queryAnalysis('bench51-1m', {
        start: seg.minRelativeTicks,
        end: seg.maxRelativeTicks,
        unit: 'relative-ticks',
        bootGeneration: seg.bootGeneration,
        segmentId: seg.segmentId,
        maxBins: 120,
      });
      const dt = performance.now() - t0;
      if (!res.ok) throw new Error(`full queryAnalysis failed: ${res.errorCode} ${res.message}`);
      fullLatencies.push(dt);
      lastFull = res.data;
    }

    // Zoomed-range exact aggregation (20 runs, 50,000 ticks wide)
    const zoomedLatencies = [];
    for (let i = 0; i < 20; i++) {
      const start = BigInt(100_000 + i * 120_000);
      const end = start + 50_000n;
      const t0 = performance.now();
      const res = await client.queryAnalysis('bench51-1m', {
        start,
        end,
        unit: 'relative-ticks',
        bootGeneration: seg.bootGeneration,
        segmentId: seg.segmentId,
        maxBins: 120,
      });
      const dt = performance.now() - t0;
      if (!res.ok) throw new Error(`zoomed queryAnalysis failed: ${res.errorCode}`);
      zoomedLatencies.push(dt);
    }

    // Rapid cancellation (12 back-to-back)
    const controllers = [];
    const promises = [];
    const tCancel0 = performance.now();
    for (let i = 0; i < 12; i++) {
      if (controllers.length > 0) controllers[controllers.length - 1].abort();
      const ac = new AbortController();
      controllers.push(ac);
      promises.push(
        client.queryAnalysis(
          'bench51-1m',
          {
            start: BigInt(i * 150_000),
            end: BigInt(i * 150_000 + 800_000),
            unit: 'relative-ticks',
            bootGeneration: seg.bootGeneration,
            segmentId: seg.segmentId,
            maxBins: 120,
          },
          { signal: ac.signal },
        ),
      );
    }
    const cancelSettled = await Promise.all(promises);
    const rapidCancelMs = Math.round((performance.now() - tCancel0) * 100) / 100;
    const cancelledCount = cancelSettled.filter(r => !r.ok && r.cancelled).length;
    const lastCancelRes = cancelSettled[cancelSettled.length - 1];
    if (!lastCancelRes.ok) throw new Error('last cancel query failed');

    // Approx budget fallback
    const approxRes = await client.queryAnalysis('bench51-1m', {
      start: seg.minRelativeTicks,
      end: seg.maxRelativeTicks,
      unit: 'relative-ticks',
      bootGeneration: seg.bootGeneration,
      segmentId: seg.segmentId,
      maxBins: 60,
      maxCandidatePages: 8,
    });
    if (!approxRes.ok || approxRes.data.precision !== 'approx') {
      throw new Error('expected approx fallback when maxCandidatePages=8');
    }

    const fullSum =
      BigInt(lastFull.totals.taskDuration)
      + BigInt(lastFull.totals.isrDuration)
      + BigInt(lastFull.totals.schedulerDuration)
      + BigInt(lastFull.totals.idleDuration)
      + BigInt(lastFull.totals.unknownDuration);
    if (fullSum !== BigInt(lastFull.windowDuration)) {
      throw new Error(`1M conservation failed: ${fullSum} !== ${lastFull.windowDuration}`);
    }

    const stats = await client.getStats('bench51-1m');
    const hostStats = client.getHostStats();
    await client.closeRecording('bench51-1m');

    report.millionEvents = {
      packets: fin.data.committed.packetCount,
      slices: fin.data.committed.sliceCount,
      rawBytes: fin.data.committed.rawBytes,
      fullExactP50Ms: percentile(fullLatencies, 50),
      fullExactP95Ms: percentile(fullLatencies, 95),
      fullExactMaxMs: Math.round(Math.max(...fullLatencies) * 100) / 100,
      zoomedExactP50Ms: percentile(zoomedLatencies, 50),
      zoomedExactP95Ms: percentile(zoomedLatencies, 95),
      zoomedExactMaxMs: Math.round(Math.max(...zoomedLatencies) * 100) / 100,
      rapid12CancelMs: rapidCancelMs,
      cancelledCount,
      fullTotals: lastFull.totals,
      fullContextsCount: lastFull.contexts.length,
      approxFallbackPrecision: approxRes.data.precision,
      workerStats: stats.ok ? stats.data.records['bench51-1m'] : null,
      hostStats,
    };

    // 2. Verify all 5 Stage 4.4 H723 archives + Stage 4.5 saved copy (read-only copies)
    const archiveSources = {};
    const r4SummaryPath = path.join(workspaceRoot, 'out/rtos-stage4/acceptance-4.4/codex-r4-acceptance-summary.json');
    if (fs.existsSync(r4SummaryPath)) {
      const r4 = JSON.parse(fs.readFileSync(r4SummaryPath, 'utf8'));
      for (const [k, info] of Object.entries(r4.hardware || {})) {
        if (info?.recordingDir && fs.existsSync(info.recordingDir)) {
          archiveSources[`r4-${k}`] = info.recordingDir;
        }
      }
    }
    const r45CopyPath = path.join(workspaceRoot, 'out/rtos-stage4/acceptance-4.5/codex-stage45-saved-copy.json');
    if (fs.existsSync(r45CopyPath)) {
      const r45 = JSON.parse(fs.readFileSync(r45CopyPath, 'utf8'));
      if (r45?.copy && fs.existsSync(r45.copy)) {
        archiveSources['r45-saved-copy'] = r45.copy;
      }
    }

    for (const [name, srcDir] of Object.entries(archiveSources)) {
      const copyDir = path.join(tmpDir, `copy-${name}`);
      await copyDirReadOnly(srcDir, copyDir);
      const recId = `verify-${name}`;
      const openRes = await client.openRecording({ recordingDir: copyDir, recordId: recId, verifyRawSha256: true });
      if (!openRes.ok) throw new Error(`openRecording ${name} failed: ${openRes.errorCode}`);
      const sRes = await client.getSegments(recId);
      const gRes = await client.getGaps(recId);
      if (!sRes.ok || !gRes.ok) throw new Error(`meta failed for ${name}`);

      const segResults = [];
      for (const s of sRes.data) {
        const endTick = BigInt(s.maxRelativeTicks) > BigInt(s.minRelativeTicks)
          ? s.maxRelativeTicks
          : (BigInt(s.minRelativeTicks) + 1n).toString();
        const aRes = await client.queryAnalysis(recId, {
          start: s.minRelativeTicks,
          end: endTick,
          unit: 'relative-ticks',
          bootGeneration: s.bootGeneration,
          segmentId: s.segmentId,
          maxBins: 80,
        });
        if (!aRes.ok) throw new Error(`queryAnalysis ${name} seg#${s.segmentId} failed: ${aRes.errorCode}`);
        const t = aRes.data.totals;
        const sum = BigInt(t.taskDuration) + BigInt(t.isrDuration) + BigInt(t.schedulerDuration) + BigInt(t.idleDuration) + BigInt(t.unknownDuration);
        if (sum !== BigInt(aRes.data.windowDuration)) {
          throw new Error(`conservation failed for ${name} seg#${s.segmentId}: ${sum} !== ${aRes.data.windowDuration}`);
        }
        segResults.push({
          segmentId: s.segmentId,
          reliability: s.reliability,
          precision: aRes.data.precision,
          verifiable: aRes.data.verifiable,
          windowDuration: aRes.data.windowDuration,
          totals: aRes.data.totals,
          contextsCount: aRes.data.contexts.length,
          markersCount: aRes.data.markers.length,
          markerPointsTotal: aRes.data.markers.reduce((acc, m) => acc + m.pointCount, 0),
        });
      }
      await client.closeRecording(recId);
      report.h723Archives[name] = {
        status: openRes.data.inspection.status,
        rawBytes: openRes.data.stats.committed.rawBytes,
        segmentsCount: sRes.data.length,
        gapsCount: gRes.data.length,
        segments: segResults,
      };
    }

    report.ok = true;
    await fsp.writeFile(outPath, JSON.stringify(report, null, 2));
    console.log('[stage5.1-benchmark] PASSED:', JSON.stringify({
      ok: report.ok,
      millionEvents: {
        fullExactP95Ms: report.millionEvents.fullExactP95Ms,
        zoomedExactP95Ms: report.millionEvents.zoomedExactP95Ms,
        rapid12CancelMs: report.millionEvents.rapid12CancelMs,
        cancelledCount: report.millionEvents.cancelledCount,
      },
      h723ArchiveCount: Object.keys(report.h723Archives).length,
    }, null, 2));
  } finally {
    await client.shutdown('bench-done').catch(() => {});
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch(err => {
  console.error('[stage5.1-benchmark] FAILED:', err);
  process.exitCode = 1;
});
