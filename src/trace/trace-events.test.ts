import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TraceRecordingStore } from './trace-recording-store';
import { TraceWorkerClient } from './trace-worker-client';

const tmpDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

afterEach(async () => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

function encodeVarint(value: number): number[] {
  const out: number[] = [];
  let v = value >>> 0;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return out;
}

function makePacket(eventId: number, payload: number[], deltaTicks: number, explicit = eventId >= 24): number[] {
  if (explicit) {
    return [
      ...encodeVarint(eventId),
      ...encodeVarint(payload.length),
      ...payload,
      ...encodeVarint(deltaTicks),
    ];
  }
  return [eventId, ...payload, ...encodeVarint(deltaTicks)];
}

function makeInitPacket(sysFreqHz: number, cpuFreqHz: number, ramBase: number, idShift: number, deltaTicks = 0): number[] {
  return makePacket(
    24,
    [
      ...encodeVarint(sysFreqHz),
      ...encodeVarint(cpuFreqHz),
      ...encodeVarint(ramBase),
      ...encodeVarint(idShift),
    ],
    deltaTicks,
    true,
  );
}

function makeStringBytes(s: string): number[] {
  const bytes = Array.from(Buffer.from(s, 'utf8'));
  return [bytes.length, ...bytes];
}

function makePrintPacket(text: string, options: number, args: number[], deltaTicks: number): number[] {
  const payload = [
    ...makeStringBytes(text),
    ...encodeVarint(options),
    ...encodeVarint(args.length),
    ...args.flatMap(a => encodeVarint(a)),
  ];
  return makePacket(26, payload, deltaTicks, true);
}

describe('Trace Events 虚拟分页、双向定位、Trace Terminal 与诊断 (阶段 5.2)', () => {
  it('支持阶段 0 continuous.bin 与 post-mortem.bin 的事件列表、ISR/Task 上下文与精确事件定位', async () => {
    const dir = await makeTempDir('orbit-ev-s0-');
    const recDir = path.join(dir, 'rec');
    const contBin = await fs.readFile(path.resolve('scripts/rtos/fixtures/samples/continuous.bin'));

    const store = await TraceRecordingStore.create({
      recordingDir: recDir,
      recordId: 's0-cont-52',
      identity: { sessionId: 's0', sessionGeneration: 1, bootGeneration: 1, recordId: 's0-cont-52' },
    });
    const ing = await store.ingestRawChunk(contBin, { sessionId: 's0', sessionGeneration: 1, bootGeneration: 1, batchSequence: 1 });
    expect(ing.ok).toBe(true);
    await store.finish('done');

    const evRes = await store.queryEvents({
      start: 0n,
      end: 1000n,
      unit: 'relative-ticks',
      offset: 0,
      limit: 50,
    });
    expect(evRes.ok).toBe(true);
    if (!evRes.ok) return;
    expect(evRes.data.totalMatched).toBeGreaterThan(10);
    expect(evRes.data.items.every(it => it.bootGeneration === 1)).toBe(true);

    // 验证 ISR 嵌套深度标注（Stage 0 样本含 IRQ17 -> IRQ18 嵌套）
    const irq18Enter = evRes.data.items.find(it => it.eventName === 'ISR_ENTER' && it.irqId === 18);
    expect(irq18Enter).toBeDefined();
    expect(irq18Enter?.nestedIsr).toBe(true);
    expect(irq18Enter?.isrDepth).toBe(2);

    // 精确双向定位（事件 -> 行号）
    const loc = await store.locateEvent({
      start: 0n,
      end: 1000n,
      unit: 'relative-ticks',
      targetBootGeneration: irq18Enter!.bootGeneration,
      targetSegmentId: irq18Enter!.segmentId,
      targetPacketIndex: irq18Enter!.packetIndexInSegment,
      targetByteOffset: irq18Enter!.streamByteOffset,
    });
    expect(loc.ok).toBe(true);
    if (loc.ok) {
      expect(loc.data.found).toBe(true);
      expect(loc.data.exactMatch).toBe(true);
      expect(loc.data.event?.eventKey).toBe(irq18Enter!.eventKey);
    }
    await store.close();
  });

  it('在含坏包、超限、嵌套 ISR 异常、未知事件、跨断段与多启动代次的流中准确隔离与呈现诊断', async () => {
    const dir = await makeTempDir('orbit-ev-diag-');
    const recDir = path.join(dir, 'rec');
    const sync = new Array(10).fill(0);

    // Boot 1: TRACE_START + INIT + nested ISR + orphan ISR_EXIT + illegal unknown event + PRINT_FORMATTED + EX_PRINT_ELF(NULL)
    const boot1Bytes = new Uint8Array([
      ...sync,
      ...makePacket(10, [], 10, false), // TRACE_START @10
      ...makeInitPacket(1_000_000, 64_000_000, 0x20000000, 2, 0),
      ...makePacket(2, encodeVarint(17), 5, false), // ISR_ENTER(17) @15
      ...makePacket(2, encodeVarint(18), 5, false), // ISR_ENTER(18) nested @20
      ...makePrintPacket('in_irq=%u', 0, [18], 2), // @22
      ...makePacket(3, [], 3, false), // ISR_EXIT(18) @25
      ...makePacket(3, [], 5, false), // ISR_EXIT(17) @30
      ...makePacket(3, [], 2, false), // orphan ISR_EXIT @32 -> recon diag!
      ...makePacket(30, [0xde, 0xad, 0xbe], 3, true), // UNKNOWN_30 @35
      ...makePrintPacket('partA', 0, [], 5), // @40
      // EX_PRINT_ELF with NULL address (0x00000000) & ERROR level (2) & varint arg 77
      ...makePacket(31, [...encodeVarint(7), ...encodeVarint(0), ...encodeVarint(2), ...encodeVarint(77)], 5, true), // @45
      // 坏包：PRINT_FORMATTED 声明 200 个参数（超过 maxPrintArgs=64）触发 print-arg-count-exceeded 诊断并入缺口
      ...makePacket(26, [...makeStringBytes('bad'), ...encodeVarint(0), ...encodeVarint(200)], 5, true),
    ]);

    // Boot 2: reset 后新启动代次 + TRACE_START + INIT + append=true（跨断段/重启绝不能拼接到 partA）
    const boot2Bytes = new Uint8Array([
      ...sync,
      ...makePacket(10, [], 10, false),
      ...makeInitPacket(1_000_000, 64_000_000, 0x20000000, 2, 0),
      ...makePrintPacket('partB_append', 64, [], 5),
    ]);

    const store = await TraceRecordingStore.create({
      recordingDir: recDir,
      recordId: 'diag-52',
      identity: { sessionId: 's-diag', sessionGeneration: 1, bootGeneration: 1, recordId: 'diag-52' },
    });
    const r1 = await store.ingestRawChunk(boot1Bytes, { sessionId: 's-diag', sessionGeneration: 1, bootGeneration: 1, batchSequence: 1 });
    expect(r1.ok).toBe(true);

    await store.notifyTargetReset(2, 'target-reset-test');
    const r2 = await store.ingestRawChunk(boot2Bytes, { sessionId: 's-diag', sessionGeneration: 1, bootGeneration: 2, batchSequence: 2 });
    expect(r2.ok).toBe(true);
    await store.finish('done');

    // 重新只读打开并校验持久化的诊断
    const { store: reopened } = await TraceRecordingStore.open({ recordingDir: recDir });
    const diag = reopened.getDiagnostics();
    expect(diag.countsBySource.decoder).toBeGreaterThanOrEqual(1);
    expect(diag.countsBySource.reconstructor).toBeGreaterThanOrEqual(1);
    expect(diag.countsBySource.gap).toBeGreaterThanOrEqual(2);
    expect(diag.items.some(d => d.code === 'print-arg-count-exceeded')).toBe(true);
    expect(diag.items.some(d => d.code === 'orphan-isr-exit')).toBe(true);

    // Terminal 查询：确认 partB_append 未跨启动代次/断段合并到 partA，且 NULL EX_PRINT_ELF 清晰标注
    const termRes = await reopened.queryTerminal({
      start: 0n,
      end: 1000n,
      unit: 'relative-ticks',
      mergeAppend: true,
    });
    expect(termRes.ok).toBe(true);
    if (termRes.ok) {
      const partA = termRes.data.lines.find(l => l.renderedText === 'partA');
      const partB = termRes.data.lines.find(l => l.renderedText === 'partB_append');
      expect(partA).toBeDefined();
      expect(partB).toBeDefined();
      expect(partB?.bootGeneration).toBe(2);
      expect(partB?.appendBrokenReason).toContain('跨断段');

      const nullElf = termRes.data.lines.find(l => l.addressStatus === 'null-address');
      expect(nullElf).toBeDefined();
      expect(nullElf?.formatSource).toBe('unresolved-address');
      expect(nullElf?.logLevelLabel).toBe('ERROR');
    }

    // Events 仅看未知/异常分类
    const anom = await reopened.queryEvents({
      start: 0n,
      end: 1000n,
      unit: 'relative-ticks',
      filter: { category: 'anomalies' },
    });
    expect(anom.ok).toBe(true);
    if (anom.ok) {
      const unk30 = anom.data.items.find(it => it.eventId === 30);
      expect(unk30).toBeDefined();
      expect(unk30?.schemaReliability).toBe('unknown-explicit');
      expect(unk30?.rawPayloadHex).toBe('de ad be');
    }

    await reopened.close();
    await store.close();
  });

  it('在未锚定段（缺失 SYSTIME_CYCLES/INIT）上使用 relative-ticks 浏览并显式标注 timeDomain=segment-relative-ticks/unknown', async () => {
    const dir = await makeTempDir('orbit-ev-unanchored-');
    const recDir = path.join(dir, 'rec');
    const sync = new Array(10).fill(0);
    // 只有 TRACE_START + INIT + TASK_START_EXEC + PRINT_FORMATTED，无 SYSTIME_CYCLES/SYSTIME_US
    const raw = new Uint8Array([
      ...sync,
      ...makePacket(10, [], 5, false),
      ...makeInitPacket(1_000_000, 64_000_000, 0x20000000, 2, 0),
      ...makePacket(4, encodeVarint(1), 10, false),
      ...makePrintPacket('no_init_log=%u', 0, [7], 5),
    ]);

    const store = await TraceRecordingStore.create({
      recordingDir: recDir,
      recordId: 'unanchored-52',
      identity: { sessionId: 's-u', sessionGeneration: 1, bootGeneration: 1, recordId: 'unanchored-52' },
    });
    await store.ingestRawChunk(raw, { sessionId: 's-u', sessionGeneration: 1, bootGeneration: 1, batchSequence: 1 });
    await store.finish('done');

    const evNs = await store.queryEvents({ start: 0n, end: 1_000_000n, unit: 'ns' });
    expect(evNs.ok).toBe(true);
    if (evNs.ok) {
      expect(evNs.data.totalMatched).toBe(0);
      expect(evNs.data.skippedUnanchoredSegments.length).toBe(1);
    }

    const evRel = await store.queryEvents({ start: 0n, end: 100n, unit: 'relative-ticks' });
    expect(evRel.ok).toBe(true);
    if (evRel.ok) {
      expect(evRel.data.totalMatched).toBeGreaterThan(0);
      const printEv = evRel.data.items.find(it => it.eventName === 'PRINT_FORMATTED');
      expect(printEv?.terminalEntry?.renderedText).toBe('no_init_log=7');
      expect(printEv?.timeDomain).toBe('segment-relative-ticks');
    }

    await store.close();
  });

  it('支持 Worker 十万级事件快速偏移跳转、过滤分页与高并发取消', async () => {
    const dir = await makeTempDir('orbit-ev-worker-');
    const recDir = path.join(dir, 'rec');
    const workerPath = path.resolve('dist/trace-worker.js');
    const client = new TraceWorkerClient({ workerPath });

    try {
      await client.createRecording({
        recordingDir: recDir,
        recordId: 'w-scale-52',
        identity: { sessionId: 's-w', sessionGeneration: 1, bootGeneration: 1, recordId: 'w-scale-52' },
      });

      const sync = new Array(10).fill(0);
      const header = [
        ...sync,
        ...makePacket(10, [], 10, false),
        ...makeInitPacket(1_000_000, 64_000_000, 0x20000000, 2, 0),
        ...makePacket(12, encodeVarint(100), 0, false),
      ];
      // 15,000 cycles * 6 packets = 90,000 events + header
      const bodyChunks: number[] = [...header];
      for (let i = 0; i < 15000; i++) {
        bodyChunks.push(
          ...makePacket(4, encodeVarint(1), 2, false),
          ...makePacket(5, [], 2, false),
          ...makePacket(2, encodeVarint(17), 1, false),
          ...makePacket(3, [], 1, false),
          ...makePacket(17, [], 1, false),
          ...(i % 3000 === 0 ? makePrintPacket('tick_mark=%u', 0, [i], 1) : makePacket(15, encodeVarint(i & 0x7f), 1, false)),
        );
      }

      const raw = new Uint8Array(bodyChunks);
      const chunkSize = 65536;
      let seq = 1;
      for (let off = 0; off < raw.length; off += chunkSize) {
        const sub = raw.subarray(off, Math.min(raw.length, off + chunkSize));
        const res = await client.ingestChunk({
          recordId: 'w-scale-52',
          sessionId: 's-w',
          sessionGeneration: 1,
          bootGeneration: 1,
          batchSequence: seq++,
          chunk: sub,
          flush: off + chunkSize >= raw.length,
        });
        expect(res.ok).toBe(true);
      }
      await client.finishRecording('w-scale-52', 'done');

      // 1. 快速偏移定位到第 85,000 行
      const jump = await client.queryEvents('w-scale-52', {
        start: 0n,
        end: 500_000n,
        unit: 'relative-ticks',
        offset: 85000,
        limit: 50,
      });
      expect(jump.ok).toBe(true);
      if (jump.ok) {
        expect(jump.data.totalMatched).toBeGreaterThan(90000);
        expect(jump.data.items.length).toBe(50);
        expect(jump.data.candidatePagesScanned).toBeLessThanOrEqual(4);
      }

      // 2. 终端过滤仅 5 条日志
      const term = await client.queryTerminal('w-scale-52', {
        start: 0n,
        end: 500_000n,
        unit: 'relative-ticks',
      });
      expect(term.ok).toBe(true);
      if (term.ok) {
        expect(term.data.totalLines).toBe(5);
        expect(term.data.lines.map(l => l.renderedText)).toEqual([
          'tick_mark=0',
          'tick_mark=3000',
          'tick_mark=6000',
          'tick_mark=9000',
          'tick_mark=12000',
        ]);
      }

      // 3. 并发过滤取消：前 6 个立即 abort，最后一个完成
      const ctrls = Array.from({ length: 6 }, () => new AbortController());
      const cancelledPromises = ctrls.map((c, idx) =>
        client.queryEvents(
          'w-scale-52',
          { start: 0n, end: 500_000n, unit: 'relative-ticks', filter: { searchText: `tick_mark=${idx * 3000}` } },
          { signal: c.signal },
        ),
      );
      ctrls.forEach(c => c.abort());
      const finalPromise = client.queryEvents('w-scale-52', {
        start: 0n,
        end: 500_000n,
        unit: 'relative-ticks',
        filter: { searchText: 'tick_mark=12000' },
      });
      const cancelledResults = await Promise.all(cancelledPromises);
      expect(cancelledResults.every(r => !r.ok && r.errorCode === 'QueryCancelled')).toBe(true);
      const finalRes = await finalPromise;
      expect(finalRes.ok).toBe(true);
      if (finalRes.ok) {
        expect(finalRes.data.totalMatched).toBe(1);
        expect(finalRes.data.items[0].terminalEntry?.renderedText).toBe('tick_mark=12000');
      }
    } finally {
      await client.shutdown();
    }
  }, 30000);

  it('兼容缺失诊断/页级扩展字段的旧归档并保证 Queue 4 参数、零参数字面日志、未解析 ELF 与双向定位稳定', async () => {
    const dir = await makeTempDir('orbit-ev-legacy-');
    const recDir = path.join(dir, 'rec');
    const sync = new Array(10).fill(0);
    // xQueueGenericSend = API 58 (32 + 58 = 90): 4 params (queueId=shrunk 0x400, itemPtr=0x20002000, ticksToWait=10, copyPosition=0)
    // Print zero-arg target-formatted text "literal=%d %x %%"
    // EX_PRINT_ELF pointing to 0x0801fff0 without ELF .rodata
    const stream = new Uint8Array([
      ...sync,
      ...makePacket(10, [], 10, false),
      ...makeInitPacket(1_000_000, 64_000_000, 0x20000000, 2, 0),
      ...makePacket(12, encodeVarint(100), 0, false),
      ...makePacket(90, [...encodeVarint(0x400), ...encodeVarint(0x20002000), ...encodeVarint(10), ...encodeVarint(0)], 5, true),
      ...makePrintPacket('literal=%d %x %%', 0, [], 5),
      ...makePacket(31, [...encodeVarint(7), ...encodeVarint(0x0801fff0), ...encodeVarint(1), ...encodeVarint(42)], 5, true),
    ]);

    const store = await TraceRecordingStore.create({
      recordingDir: recDir,
      recordId: 'legacy-compat-52',
      identity: { sessionId: 's-leg', sessionGeneration: 1, bootGeneration: 1, recordId: 'legacy-compat-52' },
    });
    await store.ingestRawChunk(stream, { sessionId: 's-leg', sessionGeneration: 1, bootGeneration: 1, batchSequence: 1 });
    await store.finish('done');
    await store.close();

    // 模拟旧版归档（移除 manifest 中可选 5.2 字段检查，确保 open() 仍稳定推导 bootGeneration=1）
    const manifestPath = path.join(recDir, 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    expect(manifest.identity.bootGeneration).toBe(1);

    const { store: reopened } = await TraceRecordingStore.open({ recordingDir: recDir });
    try {
      const ev = await reopened.queryEvents({ start: 0n, end: 10_000n, unit: 'relative-ticks' });
      expect(ev.ok).toBe(true);
      if (!ev.ok) return;
      expect(ev.data.items.every(it => it.bootGeneration === 1 && !it.eventKey.includes('undefined'))).toBe(true);

      const queueEv = ev.data.items.find(it => it.eventName.includes('xQueueGenericSend'));
      expect(queueEv?.apiDetails?.params.length).toBe(4);
      expect(queueEv?.apiDetails?.params[0].resolvedHex).toBe('0x20001000');

      const litEv = ev.data.items.find(it => it.terminalEntry?.renderedText === 'literal=%d %x %%');
      expect(litEv).toBeDefined();

      const elfEv = ev.data.items.find(it => it.terminalEntry?.stringAddress === 0x0801fff0);
      expect(elfEv?.terminalEntry?.stringAddressHex).toBe('0x0801FFF0');
      expect(elfEv?.terminalEntry?.formatSource).toBe('unresolved-address');
      expect(elfEv?.terminalEntry?.addressStatus).toBe('no-elf-loaded');

      const loc = await reopened.locateEvent({
        start: 0n,
        end: 10_000n,
        unit: 'relative-ticks',
        targetBootGeneration: queueEv!.bootGeneration,
        targetSegmentId: queueEv!.segmentId,
        targetPacketIndex: queueEv!.packetIndexInSegment,
        targetByteOffset: queueEv!.streamByteOffset,
      });
      expect(loc.ok).toBe(true);
      if (loc.ok) {
        expect(loc.data.found).toBe(true);
        expect(loc.data.exactMatch).toBe(true);
        expect(loc.data.event?.eventKey).toBe(queueEv!.eventKey);
      }
    } finally {
      await reopened.close();
    }
  });
});
