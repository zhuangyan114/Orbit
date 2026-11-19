import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TraceRecordingCoordinator, type TraceSessionHandle } from '../../trace/trace-recording-coordinator';
import { TraceWorkerClient } from '../../trace/trace-worker-client';
import type {
  ContextActivationInterval,
  ExecutionSliceInterval,
  MarkerInterval,
  ReadyWaitInterval,
} from '../../trace/systemview-reconstructor';
import type { DecodedSystemViewPacket } from '../../trace/systemview-decoder';
import {
  projectActivationDto,
  projectMarkerDto,
  projectPacketDto,
  projectReadyWaitDto,
  projectSliceDto,
} from './trace-dto';
import { computeAxisDomain, evaluateCursorSpanContinuity, resolveGapAnchors } from './trace-timeline-state';

const tempDirs: string[] = [];
const clients: TraceWorkerClient[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (clients.length > 0) {
    await clients.pop()!.shutdown('test-cleanup').catch(() => {});
  }
  while (tempDirs.length > 0) {
    await fs.rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('Trace Timeline 固定样本、1M 取消与热录制集成 (阶段 4.5)', () => {
  it('精确核对阶段 0 固定样本 continuous.bin 的嵌套 ISR、Ready、Marker 与精确游标查询', async () => {
    const sample = await fs.readFile('scripts/rtos/fixtures/samples/continuous.bin');
    const oracleMeta = JSON.parse(await fs.readFile('scripts/rtos/fixtures/samples/continuous.json', 'utf8'));
    const dir = await makeTempDir('orbit-tl-s0-');
    const recDir = path.join(dir, 'rec');

    const client = new TraceWorkerClient();
    clients.push(client);

    await client.createRecording({
      recordingDir: recDir,
      recordId: 's0-cont',
      identity: { sessionId: 's0', sessionGeneration: 1, bootGeneration: 1, recordId: 's0-cont' },
      commitOnEachIngest: true,
    });
    const ing = await client.ingestChunk({
      recordId: 's0-cont',
      sessionId: 's0',
      sessionGeneration: 1,
      batchSequence: 1,
      chunk: sample,
      flush: true,
    });
    expect(ing.ok).toBe(true);
    await client.finishRecording('s0-cont', 'done');

    const [segsRes, gapsRes, slicesRes, actsRes, readyRes, markersRes, pktsRes] = await Promise.all([
      client.getSegments('s0-cont'),
      client.getGaps('s0-cont'),
      client.queryRange<ExecutionSliceInterval>('s0-cont', { target: 'slices', start: '0', end: '1000000', unit: 'relative-ticks' }),
      client.queryRange<ContextActivationInterval>('s0-cont', { target: 'activations', start: '0', end: '1000000', unit: 'relative-ticks' }),
      client.queryRange<ReadyWaitInterval>('s0-cont', { target: 'readyWaits', start: '0', end: '1000000', unit: 'relative-ticks' }),
      client.queryRange<MarkerInterval>('s0-cont', { target: 'markers', start: '0', end: '1000000', unit: 'relative-ticks' }),
      client.queryRange<DecodedSystemViewPacket>('s0-cont', { target: 'packets', start: '0', end: '1000000', unit: 'relative-ticks' }),
    ]);

    expect(segsRes.ok && gapsRes.ok && slicesRes.ok && actsRes.ok && readyRes.ok && markersRes.ok && pktsRes.ok).toBe(true);
    if (!segsRes.ok || !gapsRes.ok || !slicesRes.ok || !actsRes.ok || !readyRes.ok || !markersRes.ok || !pktsRes.ok) return;

    const segMap = new Map(segsRes.data.map(s => [`${s.bootGeneration}:${s.segmentId}`, s]));
    const slices = slicesRes.data.items.map(s => projectSliceDto(s, segMap));
    const acts = actsRes.data.items.map(a => projectActivationDto(a, segMap));
    const readyWaits = readyRes.data.items.map(r => projectReadyWaitDto(r, segMap));
    const markers = markersRes.data.items.map(m => projectMarkerDto(m, segMap));
    const packets = pktsRes.data.items.map(p => projectPacketDto(p, segMap, 1));

    // Cross-check Stage 0 oracle byte offsets against decoded packet offsets
    for (const check of oracleMeta.checks as Array<{ name: string; offset: number; length: number }>) {
      const matchedPkt = packets.find(p => p.streamByteOffset === check.offset);
      expect(matchedPkt, `oracle check ${check.name} @ ${check.offset}`).toBeDefined();
      expect(matchedPkt!.byteLength).toBe(check.length);
    }

    // Verify nested ISR preemption (outer ISR has preemptionCount >= 1 and inclusive > exclusive)
    const isrActs = acts.filter(a => a.kind === 'isr');
    expect(isrActs.length).toBeGreaterThanOrEqual(2);
    const outerIsr = isrActs.find(a => a.preemptionCount > 0);
    expect(outerIsr).toBeDefined();
    expect(BigInt(outerIsr!.inclusiveDurationTicks!)).toBeGreaterThan(BigInt(outerIsr!.exclusiveDurationTicks!));

    // Verify Ready wait and Marker intervals exist with complete duration
    expect(readyWaits.length).toBeGreaterThanOrEqual(1);
    expect(readyWaits[0].outcome).toBe('dispatched');
    expect(markers.length).toBeGreaterThanOrEqual(1);
    expect(markers[0].completeness).toBe('complete');

    // Exact point query inside the nested inner ISR interval
    const innerIsrSlice = slices.find(s => s.contextKind === 'isr' && s.isrDepth >= 2);
    expect(innerIsrSlice).toBeDefined();
    const pointAtInner = await client.queryRange<ExecutionSliceInterval>('s0-cont', {
      target: 'slices',
      start: innerIsrSlice!.startRelTicks,
      end: (BigInt(innerIsrSlice!.startRelTicks) + 1n).toString(),
      unit: 'relative-ticks',
    });
    expect(pointAtInner.ok).toBe(true);
    if (pointAtInner.ok) {
      expect(pointAtInner.data.items.some(i => i.sliceId === innerIsrSlice!.sliceId)).toBe(true);
    }
  });

  it('在 overflow 与 post-mortem 样本中保留缺口/前缀覆盖语义且拒绝跨缺口计算连续区间', async () => {
    const overflowSample = await fs.readFile('scripts/rtos/fixtures/samples/continuous-overflow.bin');
    const postMortemSample = await fs.readFile('scripts/rtos/fixtures/samples/post-mortem.bin');
    const dir = await makeTempDir('orbit-tl-gaps-');

    const client = new TraceWorkerClient();
    clients.push(client);

    // 1. Overflow sample
    await client.createRecording({
      recordingDir: path.join(dir, 'ovf'),
      recordId: 'ovf',
      identity: { sessionId: 's-ovf', sessionGeneration: 1, bootGeneration: 1, recordId: 'ovf' },
      commitOnEachIngest: true,
    });
    await client.ingestChunk({
      recordId: 'ovf',
      sessionId: 's-ovf',
      sessionGeneration: 1,
      batchSequence: 1,
      chunk: overflowSample,
      flush: true,
    });
    await client.finishRecording('ovf', 'done');

    const [ovfSegsRes, ovfGapsRes] = await Promise.all([
      client.getSegments('ovf'),
      client.getGaps('ovf'),
    ]);
    expect(ovfSegsRes.ok && ovfGapsRes.ok).toBe(true);
    if (!ovfSegsRes.ok || !ovfGapsRes.ok) return;

    expect(ovfGapsRes.data.some(g => g.kind === 'target-overflow')).toBe(true);
    const segDtos = ovfSegsRes.data.map(s => ({
      ...s,
      reliability: s.reliability,
    }));
    const domain = computeAxisDomain(segDtos, 'ns', 'all-anchored');
    if (ovfSegsRes.data.length >= 2 && domain.includedSegments.length >= 2) {
      const s1 = domain.includedSegments[0];
      const s2 = domain.includedSegments[1];
      const gapEval = evaluateCursorSpanContinuity(
        { timeStr: s1.minNs ?? s1.minRelativeTicks, unit: domain.unit, bootGeneration: s1.bootGeneration, segmentId: s1.segmentId, inspect: null },
        { timeStr: s2.maxNs ?? s2.maxRelativeTicks, unit: domain.unit, bootGeneration: s2.bootGeneration, segmentId: s2.segmentId, inspect: null },
        segDtos,
        ovfGapsRes.data,
        domain.unit,
      );
      expect(gapEval.continuous).toBe(false);
    }

    // 2. Post-Mortem sample
    await client.createRecording({
      recordingDir: path.join(dir, 'pm'),
      recordId: 'pm',
      identity: { sessionId: 's-pm', sessionGeneration: 1, bootGeneration: 1, recordId: 'pm' },
      commitOnEachIngest: true,
    });
    await client.ingestChunk({
      recordId: 'pm',
      sessionId: 's-pm',
      sessionGeneration: 1,
      batchSequence: 1,
      chunk: postMortemSample,
      flush: true,
    });
    await client.finishRecording('pm', 'done');
    const [pmSegsRes, pmGapsRes] = await Promise.all([
      client.getSegments('pm'),
      client.getGaps('pm'),
    ]);
    expect(pmSegsRes.ok && pmGapsRes.ok).toBe(true);
    if (!pmSegsRes.ok || !pmGapsRes.ok) return;
    expect(pmSegsRes.data.length).toBeGreaterThan(0);
    const anchors = resolveGapAnchors(pmSegsRes.data, pmGapsRes.data, 'relative-ticks', 1, pmSegsRes.data[0].segmentId);
    expect(Array.isArray(anchors)).toBe(true);
  });

  it('在百万级事件录制上支持快速连续范围切换与过期取消，并保持精确查询准确', async () => {
    const baseSample = await fs.readFile('scripts/rtos/fixtures/samples/continuous.bin');
    const preamble = baseSample.subarray(0, 31);
    const taskCreate = Uint8Array.from([8, 0x40, 1]);
    const cycle = Uint8Array.from([6, 0x40, 2, 4, 0x40, 3, 2, 17, 5, 3, 7, 5, 11, 17, 2]);
    // 167,000 cycles * 6 packets + 5 preamble packets = 1,002,005 packets (~2.5 MB raw)
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

    const dir = await makeTempDir('orbit-tl-1m-');
    const client = new TraceWorkerClient();
    clients.push(client);

    await client.createRecording({
      recordingDir: path.join(dir, 'rec-1m'),
      recordId: 'rec-1m',
      identity: { sessionId: 's-1m', sessionGeneration: 1, bootGeneration: 1, recordId: 'rec-1m' },
      commitOnEachIngest: false,
    });

    const chunkBytes = 32 * 1024;
    let seq = 1;
    for (let offset = 0; offset < raw.length; offset += chunkBytes) {
      const res = await client.ingestChunk({
        recordId: 'rec-1m',
        sessionId: 's-1m',
        sessionGeneration: 1,
        batchSequence: seq++,
        chunk: raw.subarray(offset, Math.min(raw.length, offset + chunkBytes)),
      });
      if (!res.ok) throw new Error(`ingestChunk failed at ${offset}: ${res.errorCode} ${res.message}`);
    }
    const fin = await client.finishRecording('rec-1m', 'done-1m');
    expect(fin.ok).toBe(true);
    if (fin.ok) {
      expect(fin.data.committed.packetCount).toBe(1_002_005);
    }

    // Rapid consecutive range switches cancelling prior queries immediately
    const controllers: AbortController[] = [];
    const promises: Array<Promise<any>> = [];
    for (let i = 0; i < 12; i++) {
      if (controllers.length > 0) {
        controllers[controllers.length - 1].abort();
      }
      const ac = new AbortController();
      controllers.push(ac);
      const start = BigInt(i * 100_000);
      const end = start + 500_000n;
      promises.push(
        client.queryLod('rec-1m', { start, end, unit: 'relative-ticks', maxBuckets: 256 }, { signal: ac.signal }),
      );
    }
    const settled = await Promise.all(promises);
    const lastRes = settled[settled.length - 1];
    expect(lastRes.ok).toBe(true);
    expect(lastRes.data.buckets.length).toBeGreaterThan(0);

    // Exact query deep inside the 1M dataset
    const exactSlice = await client.queryRange<ExecutionSliceInterval>('rec-1m', {
      target: 'slices',
      start: '2700103',
      end: '2700132',
      unit: 'relative-ticks',
      limit: 64,
    });
    expect(exactSlice.ok).toBe(true);
    if (exactSlice.ok) {
      expect(exactSlice.data.items.length).toBeGreaterThan(0);
    }
  }, 60000);

  it('热录制期间支持 flush 提交部分流供实时绘图且不自动 halt/reset', async () => {
    const sample = await fs.readFile('scripts/rtos/fixtures/samples/continuous.bin');
    const dir = await makeTempDir('orbit-tl-hot-');
    const client = new TraceWorkerClient();
    clients.push(client);

    const coordinator = new TraceRecordingCoordinator({
      storageRoot: dir,
      workerFactory: () => client,
    });

    const statuses: string[] = [];
    const sub = coordinator.onDidChangeStatus(s => statuses.push(`${s.state}:${s.counters.committedRawBytes}`));

    let customRequests: string[] = [];
    let haltedOrReset = false;
    const session: TraceSessionHandle = {
      id: 'hot-sess',
      name: 'HotMock',
      type: 'orbit',
      customRequest: (async (command: string, args: Record<string, any> = {}): Promise<any> => {
        customRequests.push(`${command}:${args?.action ?? ''}`);
        if (command === 'pause' || command === 'reset' || command === 'restart') {
          haltedOrReset = true;
        }
        if (command === 'orbitTraceTarget' && args.action === 'inspect') {
          return {
            ok: true,
            identity: { sessionId: 'hot-1', sessionGeneration: 1, bootGeneration: 1, operationGeneration: 1, elfSha256: 'abc', elfPath: 'x.elf', device: 'STM32H723VGT6' },
            targetState: 'Running',
            ramRangesAvailable: true,
            ramRanges: [{ address: 0x20000000, size: 0x20000 }],
            rttControlBlockAddress: 0x20001000,
            rttCapabilities: {
              ownerKind: 'cmsis-dap',
              rttStart: { available: true, evidence: 'offline' },
              rttEnumerate: { available: true, evidence: 'offline' },
              rttUpRead: { available: true, evidence: 'offline' },
              rttDownWrite: { available: true, evidence: 'offline' },
            },
            globalsValues: { enableState: 0, dropCount: 0 },
          };
        }
        if (command === 'orbitTraceTarget' && args.action === 'readState') {
          return {
            ok: true,
            sessionGeneration: 1,
            bootGeneration: 1,
            targetState: 'Running',
            globalsValues: { enableState: 1, dropCount: 0 },
            enumerate: {
              controlBlockAddress: 0x20001000,
              upBuffers: [{ direction: 'up', index: 1, bufferAddress: 0x20002000, status: 'valid', name: 'SysView', nameStatus: 'ok', valid: true, bufferSize: 8192, rdOff: 0, wrOff: 0 }],
              downBuffers: [{ direction: 'down', index: 1, bufferAddress: 0x20004000, status: 'valid', name: 'SysView', nameStatus: 'ok', valid: true, bufferSize: 16, rdOff: 1, wrOff: 1 }],
              duplicateUpNames: [],
              duplicateDownNames: [],
            },
          };
        }
        if (command === 'orbitRttTransport' && args.action === 'enumerate') {
          return {
            ok: true,
            data: {
              controlBlockAddress: 0x20001000,
              upBuffers: [{ direction: 'up', index: 1, bufferAddress: 0x20002000, status: 'valid', name: 'SysView', nameStatus: 'ok', valid: true, bufferSize: 8192, rdOff: 0, wrOff: 0 }],
              downBuffers: [{ direction: 'down', index: 1, bufferAddress: 0x20004000, status: 'valid', name: 'SysView', nameStatus: 'ok', valid: true, bufferSize: 16, rdOff: 0, wrOff: 0 }],
              duplicateUpNames: [],
              duplicateDownNames: [],
            },
          };
        }
        if (command === 'orbitRttTransport' && args.action === 'subscribe') {
          return { ok: true, bufferIndex: 1, budget: { ownerKind: 'cmsis-dap', transport: 'winusb', maxBatchBytes: 512, minPollIntervalMs: 10, defaultPollIntervalMs: 20, maxBatchesPerTurn: 4, source: 'test' } };
        }
        if (command === 'orbitRttTransport' && args.action === 'writeDown') {
          return { ok: true, data: { committedBytes: 1, committedWrOff: 1 } };
        }
        if (command === 'orbitRttTransport' && args.action === 'drain') {
          return { ok: true, drained: true, batchesDrained: 0, bytesDrained: 0, lastRdOff: 0, lastWrOff: 0, bufferSize: 8192 };
        }
        return { ok: true };
      }) as TraceSessionHandle['customRequest'],
    };

    coordinator.bindSession(session);
    const started = await coordinator.startRecording({ mode: 'continuous', recordId: 'hot-rec' });
    expect(started.state).toBe('recording');

    // Deliver the tiny 68-byte continuous.bin while recording (< 64 KiB auto-commit threshold)
    coordinator.onCustomEvent(session, 'orbitRttData', {
      consumerId: 'trace-hot-rec',
      sessionId: 'hot-1',
      sessionGeneration: 1,
      bootGeneration: 1,
      bufferIndex: 1,
      batchSequence: 1,
      dataBase64: Buffer.from(sample).toString('base64'),
    });

    // Flush during hot recording makes committed data immediately queryable
    const flushRes = await coordinator.flushRecording('hot-rec');
    expect(flushRes.ok).toBe(true);
    if (flushRes.ok) {
      expect(flushRes.data.committedRawBytes).toBe(sample.length);
    }

    const liveSlices = await coordinator.queryRange<ExecutionSliceInterval>('hot-rec', {
      target: 'slices',
      start: '0',
      end: '1000000',
      unit: 'relative-ticks',
    });
    expect(liveSlices.ok).toBe(true);
    if (liveSlices.ok) {
      expect(liveSlices.data.items.length).toBeGreaterThan(0);
    }

    expect(haltedOrReset).toBe(false);
    expect(statuses.length).toBeGreaterThan(0);
    sub.dispose();
    await coordinator.cancelRecording('hot-rec');
    await coordinator.dispose();
  });
});
