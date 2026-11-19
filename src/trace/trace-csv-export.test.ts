import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SYSTEMVIEW_PROTOCOL_VERSION } from './systemview-protocol';
import type { DecodedSystemViewPacket } from './systemview-decoder';
import type { ExecutionSliceInterval, TraceReconstructBatch, TraceTimePoint } from './systemview-reconstructor';
import type { SystemViewDecodeBatch } from './systemview-decoder';
import {
  buildCsvRowUncertaintyFlags,
  formatCsvCell,
  TRACE_CSV_COLUMNS,
} from './trace-csv-export';
import { defaultTraceFileSystem, NodeTraceFileSystem, ORBIT_TRACE_FILES, TraceFileHandle, TraceFileSystem } from './trace-format';
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

/**
 * 简单严格的 RFC 4180 CSV 解析器（独立用于测试验证，不依赖生产格式化器）。
 */
function parseRfc4180Csv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < text.length && text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      cell += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ',') {
      row.push(cell);
      cell = '';
      i++;
      continue;
    }
    if (ch === '\r' && i + 1 < text.length && text[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i += 2;
      continue;
    }
    if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i++;
      continue;
    }
    cell += ch;
    i++;
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function makeFaultWriteFs(failOnSuffix: string, failAfterWrites: number, mode: 'enospc' | 'short-write'): TraceFileSystem {
  let writeCount = 0;
  return {
    mkdir: (d, o) => defaultTraceFileSystem.mkdir(d, o),
    readFile: (p) => defaultTraceFileSystem.readFile(p),
    writeFile: (p, d) => defaultTraceFileSystem.writeFile(p, d),
    writeFileExclusive: (p, d) => defaultTraceFileSystem.writeFileExclusive(p, d),
    rename: (a, b) => defaultTraceFileSystem.rename(a, b),
    stat: (p) => defaultTraceFileSystem.stat(p),
    lstat: (p) => defaultTraceFileSystem.lstat(p),
    readdir: (p) => defaultTraceFileSystem.readdir(p),
    unlink: (p) => defaultTraceFileSystem.unlink(p),
    rmdir: (p) => defaultTraceFileSystem.rmdir(p),
    realpath: (p) => defaultTraceFileSystem.realpath(p),
    exists: (p) => defaultTraceFileSystem.exists(p),
    open: async (filePath, flags): Promise<TraceFileHandle> => {
      const inner = await defaultTraceFileSystem.open(filePath, flags);
      const match = filePath.includes(failOnSuffix);
      return {
        write: async (buffer, offset, length, position) => {
          if (match) {
            writeCount++;
            if (writeCount > failAfterWrites) {
              if (mode === 'enospc') {
                const err = new Error('No space left on device') as Error & { code: string };
                err.code = 'ENOSPC';
                throw err;
              }
              return { bytesWritten: Math.max(0, Math.floor(length / 2)) };
            }
          }
          return inner.write(buffer, offset, length, position);
        },
        read: (b, o, l, p) => inner.read(b, o, l, p),
        sync: () => inner.sync(),
        truncate: (len) => inner.truncate(len),
        stat: () => inner.stat(),
        close: () => inner.close(),
      };
    },
  };
}

describe('Trace CSV 流式导出与安全引用 (阶段 5.3)', () => {
  it('正确引用逗号、换行、单双引号并把公式前缀字符串当作纯数据处理', () => {
    expect(formatCsvCell('plain')).toBe('plain');
    expect(formatCsvCell('a, b')).toBe('"a, b"');
    expect(formatCsvCell('say "hi"')).toBe('"say ""hi"""');
    expect(formatCsvCell("it's ok")).toBe('"it\'s ok"');
    expect(formatCsvCell('line1\nline2')).toBe('"line1\nline2"');
    expect(formatCsvCell('mix, "q", \'s\'\r\nnext')).toBe('"mix, ""q"", \'s\'\nnext"');

    // 公式注入前缀：来自记录/manifest 的字符串以 =, +, -, @, \t, \r, \n 开头，或首部空白/BOM 后紧接 =/+/-/@ 时仅作纯文本数据
    expect(formatCsvCell('=1+2', true)).toBe(`"'=1+2"`);
    expect(formatCsvCell('+1+2', true)).toBe(`"'+1+2"`);
    expect(formatCsvCell('-5+1', true)).toBe(`"'-5+1"`);
    expect(formatCsvCell('@SUM(1,2)', true)).toBe(`"'@SUM(1,2)"`);
    expect(formatCsvCell('\t=1+2', true)).toBe(`"'\t=1+2"`);
    expect(formatCsvCell('\r=1+2', true)).toBe(`"'\n=1+2"`);
    expect(formatCsvCell('\n+2*3', true)).toBe(`"'\n+2*3"`);
    expect(formatCsvCell('\r\n-4+5', true)).toBe(`"'\n-4+5"`);
    expect(formatCsvCell('   =2+2', true)).toBe(`"'   =2+2"`);
    expect(formatCsvCell(' \t +3*4', true)).toBe(`"' \t +3*4"`);
    expect(formatCsvCell('\u00a0=5-1', true)).toBe(`"'\u00a0=5-1"`);
    expect(formatCsvCell('\ufeff=6+7', true)).toBe(`"'\ufeff=6+7"`);

    // 精确数值列不加单引号前缀
    expect(formatCsvCell(-5, false)).toBe('-5');
    expect(formatCsvCell(42, false)).toBe('42');
  });

  it('在离线导出中准确保留特殊字符、未知时钟域、缺口/过载不确定性，并能用 RFC4180 完整回读', async () => {
    const dir = await makeTempDir('orbit-csv-special-');
    const recDir = path.join(dir, 'rec');
    const maliciousRecordId = '  +1+2';
    const store = await TraceRecordingStore.create({
      recordingDir: recDir,
      recordId: maliciousRecordId,
      identity: { sessionId: 's-csv', sessionGeneration: 1, bootGeneration: 1, recordId: maliciousRecordId },
      commitOnEachIngest: true,
    });

    const t1: TraceTimePoint = {
      segmentId: 1,
      packetIndexInSegment: 0,
      streamByteOffset: 0,
      relativeTicks: '10',
      relativeTicksBigInt: 10n,
      timeAnchorStatus: 'unanchored',
    };
    const t2: TraceTimePoint = {
      segmentId: 1,
      packetIndexInSegment: 1,
      streamByteOffset: 24,
      relativeTicks: '25',
      relativeTicksBigInt: 25n,
      timeAnchorStatus: 'unanchored',
    };

    const pkt1: DecodedSystemViewPacket = {
      protocolVersion: SYSTEMVIEW_PROTOCOL_VERSION,
      segmentId: 1,
      packetIndexInSegment: 0,
      streamByteOffset: 0,
      byteLength: 24,
      eventId: 26,
      eventName: 'PRINT_FORMATTED',
      category: 'standard-explicit',
      schemaReliability: 'known',
      segmentReliability: 'uncertain',
      deltaTicks: 10,
      segmentRelativeTicks: '10',
      segmentRelativeTicksBigInt: 10n,
      timestampWrapped: true,
      timeAnchorStatus: 'unanchored',
      decoded: {
        kind: 'print-formatted',
        text: 'hello, "world"\nline2 \'single\'',
        options: 0,
        logLevel: 0,
        append: false,
        numArgs: 0,
        args: [],
      },
    };
    const pkt2: DecodedSystemViewPacket = {
      protocolVersion: SYSTEMVIEW_PROTOCOL_VERSION,
      segmentId: 1,
      packetIndexInSegment: 1,
      streamByteOffset: 24,
      byteLength: 16,
      eventId: 26,
      eventName: 'PRINT_FORMATTED',
      category: 'standard-explicit',
      schemaReliability: 'known',
      segmentReliability: 'uncertain',
      deltaTicks: 15,
      segmentRelativeTicks: '25',
      segmentRelativeTicksBigInt: 25n,
      timestampWrapped: false,
      timeAnchorStatus: 'unanchored',
      decoded: {
        kind: 'print-formatted',
        text: '  =1+2',
        options: 2,
        logLevel: 0,
        append: false,
        numArgs: 0,
        args: [],
      },
    };
    const pkt3: DecodedSystemViewPacket = {
      protocolVersion: SYSTEMVIEW_PROTOCOL_VERSION,
      segmentId: 1,
      packetIndexInSegment: 2,
      streamByteOffset: 40,
      byteLength: 4,
      eventId: 1,
      eventName: 'OVERFLOW',
      category: 'standard-short',
      schemaReliability: 'known',
      segmentReliability: 'uncertain',
      deltaTicks: 5,
      segmentRelativeTicks: '30',
      segmentRelativeTicksBigInt: 30n,
      timestampWrapped: false,
      timeAnchorStatus: 'unanchored',
      decoded: {
        kind: 'overflow',
        rawDropCount: 7,
        minDroppedPackets: 7,
      },
    };

    const slice: ExecutionSliceInterval = {
      sliceId: 'sl-1',
      bootGeneration: 1,
      segmentId: 1,
      segmentReliability: 'uncertain',
      completeness: 'incomplete',
      contextKind: 'task',
      contextKey: 'task:b1:tcb:0x20000100#g1:i1',
      taskInstanceId: 'b1:tcb:0x20000100#g1:i1',
      tcbAddress: 0x20000100,
      isrDepth: 0,
      label: 'Task,"A"\'1',
      labelSource: 'task-info',
      start: t1,
      end: t2,
      timeDomain: 'unknown',
      startReason: 'task-start-exec',
    };

    const decBatch: SystemViewDecodeBatch = {
      packets: [pkt1, pkt2, pkt3],
      syncs: [],
      gaps: [
        {
          kind: 'target-overflow',
          segmentIdBefore: 1,
          byteOffset: 40,
          preservesFraming: true,
          droppedPackets: 'unknown',
          droppedBytes: 'unknown',
          reason: 'Target RTT buffer overflow',
        },
      ],
      segments: [
        {
          segmentId: 1,
          startByteOffset: 0,
          endByteOffset: 44,
          reliability: 'uncertain',
          closed: false,
          packetCount: 3,
          syncCount: 0,
          timestampBits: 32,
          timestampWrapCount: 1,
          timeAnchorStatus: 'unanchored',
          relativeTicksTotal: '30',
          metadata: {},
        },
      ],
      diagnostics: [],
    };
    const reconBatch: TraceReconstructBatch = {
      protocolVersion: SYSTEMVIEW_PROTOCOL_VERSION,
      accepted: true,
      identity: { sessionId: 's-csv', sessionGeneration: 1, bootGeneration: 1, recordId: maliciousRecordId },
      executionSlices: [slice],
      contextActivations: [],
      readyWaits: [],
      markers: [],
      markerPoints: [],
      taskUpdates: [],
      gapBoundaries: [
        {
          bootGeneration: 1,
          kind: 'target-overflow',
          segmentIdBefore: 1,
          byteOffset: 40,
          droppedPackets: 'unknown',
          droppedBytes: 'unknown',
          reason: 'Target RTT buffer overflow',
          closedOpenCount: 1,
        },
      ],
      diagnostics: [],
    };

    expect((await store.ingestDecodedBatches(decBatch, reconBatch, Buffer.alloc(44), true)).ok).toBe(true);
    expect((await store.finish('done', { terminalState: 'interrupted', failureCode: 'StopDrainTimeout' })).ok).toBe(true);

    // 1. 若以 unit='ns' 导出未锚定段，应跳过未锚定段并仅输出表头（exportedRows === 0）
    const nsOut = path.join(dir, 'unanchored-ns.csv');
    const nsRes = await store.exportCsv({
      outputPath: nsOut,
      request: { exportSource: 'trace-viewport', unit: 'ns', start: '0', end: '1000' },
    });
    expect(nsRes.ok).toBe(true);
    if (nsRes.ok) {
      expect(nsRes.data.exportedRows).toBe(0);
      expect(nsRes.data.skippedUnanchoredSegments).toEqual([1]);
    }
    const nsRows = parseRfc4180Csv(await fs.readFile(nsOut, 'utf8'));
    expect(nsRows.length).toBe(1);
    expect(nsRows[0]).toEqual([...TRACE_CSV_COLUMNS]);

    // 2. 以 relative-ticks 导出：完整 3 条事件 + 明确时间域/不确定性 + 特殊字符引号与公式防御
    const relOut = path.join(dir, 'unanchored-rel.csv');
    const relRes = await store.exportCsv({
      outputPath: relOut,
      request: {
        exportSource: 'ab-selection',
        unit: 'relative-ticks',
        bootGeneration: 1,
        segmentId: 1,
        start: '0',
        end: '100',
        crossesGap: true,
      },
    });
    expect(relRes.ok).toBe(true);
    if (relRes.ok) {
      expect(relRes.data.exportedRows).toBe(3);
      expect(relRes.data.archiveState).toBe('interrupted');
      expect(relRes.data.hasTargetOverflow).toBe(true);
      expect(createHash('sha256').update(await fs.readFile(relOut)).digest('hex')).toBe(relRes.data.sha256);
    }

    const parsed = parseRfc4180Csv(await fs.readFile(relOut, 'utf8'));
    expect(parsed.length).toBe(4); // header + 3 rows
    expect(parsed[0]).toEqual([...TRACE_CSV_COLUMNS]);

    const col = (name: (typeof TRACE_CSV_COLUMNS)[number]) => TRACE_CSV_COLUMNS.indexOf(name);
    const r1 = parsed[1];
    expect(r1[col('recordId')]).toBe("'  +1+2");
    expect(r1[col('eventId')]).toBe('26');
    expect(r1[col('deltaTicks')]).toBe('10');
    expect(r1[col('relTicks')]).toBe('10');
    expect(r1[col('timeDomain')]).toBe('unknown');
    expect(r1[col('timeAnchorStatus')]).toBe('unanchored');
    expect(r1[col('sysFreqHz')]).toBe('');
    expect(r1[col('absTicks')]).toBe('');
    expect(r1[col('ns')]).toBe('');
    expect(r1[col('terminalText')]).toBe("hello, \"world\"\nline2 'single'");
    expect(r1[col('contextLabel')]).toBe("Task,\"A\"'1");
    expect(r1[col('uncertaintyFlags')]).toContain('incomplete-archive');
    expect(r1[col('uncertaintyFlags')]).toContain('uncertain-segment');
    expect(r1[col('uncertaintyFlags')]).toContain('unanchored-clock');
    expect(r1[col('uncertaintyFlags')]).toContain('unknown-frequency');
    expect(r1[col('uncertaintyFlags')]).toContain('timestamp-wrapped');
    expect(r1[col('uncertaintyFlags')]).toContain('cross-gap-selection');
    expect(r1[col('uncertaintyFlags')]).toContain('target-overflow-in-window');

    const r2 = parsed[2];
    expect(r2[col('terminalText')]).toBe(`'  =1+2`);

    await store.close();
  });

  it('保护已有 CSV/目录路径、拒绝 .SVDat 扩展名，并在 ENOSPC/短写/取消时清理临时文件', async () => {
    const sample = await fs.readFile('scripts/rtos/fixtures/samples/continuous.bin');
    const dir = await makeTempDir('orbit-csv-safety-');
    const recDir = path.join(dir, 'rec');

    const store = await TraceRecordingStore.create({
      recordingDir: recDir,
      recordId: 'rec-safe',
      identity: { sessionId: 's-safe', sessionGeneration: 1, bootGeneration: 1, recordId: 'rec-safe' },
      commitOnEachIngest: true,
    });
    expect((await store.ingestRawChunk(sample, { batchSequence: 1 })).ok).toBe(true);
    expect((await store.finish()).ok).toBe(true);

    // 1. 拒绝 .SVDat
    const svdatPath = path.join(dir, 'forbidden.SVDat');
    const svRes = await store.exportCsv({
      outputPath: svdatPath,
      request: { exportSource: 'trace-viewport', unit: 'relative-ticks', start: '0', end: '100000' },
    });
    expect(svRes.ok).toBe(false);
    if (!svRes.ok) expect(svRes.errorCode).toBe('UnsupportedCapability');
    expect(await defaultTraceFileSystem.exists(svdatPath)).toBe(false);

    // 2. 拒绝自导出到录制目录内部及覆盖既有文件
    const insideCsv = path.join(recDir, 'inside.csv');
    const insideRes = await store.exportCsv({
      outputPath: insideCsv,
      request: { exportSource: 'trace-viewport', unit: 'relative-ticks', start: '0', end: '100000' },
    });
    expect(insideRes.ok).toBe(false);
    if (!insideRes.ok) expect(insideRes.errorCode).toBe('ExportPathConflict');

    const existingCsv = path.join(dir, 'existing.csv');
    await fs.writeFile(existingCsv, 'DO_NOT_OVERWRITE');
    const existRes = await store.exportCsv({
      outputPath: existingCsv,
      request: { exportSource: 'trace-viewport', unit: 'relative-ticks', start: '0', end: '100000' },
    });
    expect(existRes.ok).toBe(false);
    if (!existRes.ok) expect(existRes.errorCode).toBe('ExportTargetExists');
    expect(await fs.readFile(existingCsv, 'utf8')).toBe('DO_NOT_OVERWRITE');

    // 3. AbortSignal 取消
    const ac = new AbortController();
    ac.abort();
    const cancelCsv = path.join(dir, 'cancelled.csv');
    const cancelRes = await store.exportCsv({
      outputPath: cancelCsv,
      request: { exportSource: 'trace-viewport', unit: 'relative-ticks', start: '0', end: '100000' },
      cancel: { signal: ac.signal },
    });
    expect(cancelRes.ok).toBe(false);
    if (!cancelRes.ok) expect(cancelRes.cancelled).toBe(true);
    expect(await defaultTraceFileSystem.exists(cancelCsv)).toBe(false);
    await store.close();

    // 4. ENOSPC 与短写故障下不得留下目标或临时文件
    for (const mode of ['enospc', 'short-write'] as const) {
      const faultFs = makeFaultWriteFs('.orbit-csv-', 0, mode);
      const { store: faultStore } = await TraceRecordingStore.open({ recordingDir: recDir, fileSystem: faultFs });
      const outPath = path.join(dir, `fail-${mode}.csv`);
      const res = await faultStore.exportCsv({
        outputPath: outPath,
        request: { exportSource: 'trace-viewport', unit: 'relative-ticks', start: '0', end: '100000' },
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.errorCode).toBe(mode === 'enospc' ? 'ENOSPC' : 'ShortWrite');
      const left = (await fs.readdir(dir)).filter(f => f.includes(`fail-${mode}.csv`));
      expect(left).toEqual([]);
      await faultStore.close();
    }
  });

  it('buildCsvRowUncertaintyFlags 覆盖 bad-index-rebuilt 与 corrupted-prefix 标志', () => {
    const baseDto: DecodedSystemViewPacket & any = {
      eventKey: 'b1:s1:p0@0',
      bootGeneration: 1,
      segmentId: 1,
      segmentReliability: 'trusted',
      packetIndexInSegment: 0,
      streamByteOffset: 0,
      byteLength: 4,
      eventId: 17,
      eventName: 'IDLE',
      category: 'standard-short',
      schemaReliability: 'known',
      deltaTicks: 1,
      relTicks: '1',
      absTicks: '1',
      ns: '1000',
      sysFreqHz: 1_000_000,
      timeAnchorStatus: 'anchored-cycles',
      timeDomain: 'anchored-ticks',
      timestampWrapped: false,
      contextKind: 'idle',
      isrDepth: 0,
      nestedIsr: false,
      summary: 'IDLE',
      diagnostics: [],
    };
    expect(
      buildCsvRowUncertaintyFlags({
        dto: baseDto,
        archiveState: 'corrupted',
        recoveryDisposition: 'rebuilt-bad-index',
        hasTargetOverflowInSeg: false,
        hasHostDropInSeg: false,
        hasPrefixOverwrittenInSeg: false,
        hasNonTrivialGapInSeg: false,
      }),
    ).toBe('bad-index-rebuilt');

    expect(
      buildCsvRowUncertaintyFlags({
        dto: baseDto,
        archiveState: 'corrupted',
        recoveryDisposition: 'recovered-prefix-bad-chunk',
        hasTargetOverflowInSeg: false,
        hasHostDropInSeg: true,
        hasPrefixOverwrittenInSeg: true,
        hasNonTrivialGapInSeg: true,
      }),
    ).toBe('corrupted-prefix;cross-gap-selection;host-drop-in-window;prefix-overwritten');
  });

  it('exportCsv 同路径并发、提交前目标抢占（含硬链接/EXDEV回退wx）与发布取消均无损保护既有文件', async () => {
    const sample = await fs.readFile('scripts/rtos/fixtures/samples/continuous.bin');
    const sandbox = await makeTempDir('orbit-csv-race-');
    const recDir = path.join(sandbox, 'rec');
    const s = await TraceRecordingStore.create({
      recordingDir: recDir,
      recordId: 'rec-csv-race',
      identity: { sessionId: 's-cr', sessionGeneration: 1, bootGeneration: 1, recordId: 'rec-csv-race' },
      commitOnEachIngest: true,
    });
    expect((await s.ingestRawChunk(sample, { batchSequence: 1 })).ok).toBe(true);
    expect((await s.finish()).ok).toBe(true);
    await s.close();

    // 1. 同路径并发 exportCsv：仅 1 个胜出，另一路返回 ExportTargetExists，胜出文件内容完整且无残留临时文件
    const sameCsv = path.join(sandbox, 'concurrent.csv');
    const { store: c1 } = await TraceRecordingStore.open({ recordingDir: recDir });
    const { store: c2 } = await TraceRecordingStore.open({ recordingDir: recDir });
    const req = { exportSource: 'events-page' as const, unit: 'relative-ticks' as const, start: '0', end: '100000' };
    const [res1, res2] = await Promise.all([
      c1.exportCsv({ outputPath: sameCsv, request: req }),
      c2.exportCsv({ outputPath: sameCsv, request: req }),
    ]);
    await Promise.all([c1.close(), c2.close()]);
    const okList = [res1, res2].filter((r) => r.ok);
    const errList = [res1, res2].filter((r) => !r.ok);
    expect(okList.length).toBe(1);
    expect(errList.length).toBe(1);
    if (!errList[0].ok) expect(errList[0].errorCode).toBe('ExportTargetExists');
    if (okList[0].ok) {
      expect(createHash('sha256').update(await fs.readFile(sameCsv)).digest('hex')).toBe(okList[0].data.sha256);
    }
    expect((await fs.readdir(sandbox)).filter((n) => n.includes('.orbit-csv-'))).toEqual([]);

    // 2. 在提交发布前外部竞争者写入独立文件（分别注入到 link 入口与 EXDEV 回退 wx 入口）：绝不覆盖、绝不删外文件
    const externalCsv = 'winner,col\n1,keep\n';
    const externalHash = createHash('sha256').update(externalCsv).digest('hex');
    for (const mode of ['link-race', 'exdev-wx-race'] as const) {
      const targetCsv = path.join(sandbox, `${mode}.csv`);
      const raceFs = new (class extends NodeTraceFileSystem {
        override async link(existingPath: string, newPath: string): Promise<void> {
          if (newPath === targetCsv) {
            if (mode === 'link-race') {
              await fs.writeFile(newPath, externalCsv, { flag: 'wx' });
            } else {
              const e: NodeJS.ErrnoException = new Error('EXDEV unsupported');
              e.code = 'EXDEV';
              throw e;
            }
          }
          return super.link(existingPath, newPath);
        }
        override async open(filePath: string, flags: string): Promise<TraceFileHandle> {
          if (mode === 'exdev-wx-race' && flags === 'wx' && filePath === targetCsv) {
            await fs.writeFile(targetCsv, externalCsv, { flag: 'wx' });
          }
          return super.open(filePath, flags);
        }
      })();
      const { store: sr } = await TraceRecordingStore.open({ recordingDir: recDir, fileSystem: raceFs });
      const res = await sr.exportCsv({ outputPath: targetCsv, request: req });
      await sr.close();
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.errorCode).toBe('ExportTargetExists');
      expect(createHash('sha256').update(await fs.readFile(targetCsv)).digest('hex')).toBe(externalHash);
      expect((await fs.readdir(sandbox)).filter((n) => n.includes('.orbit-csv-'))).toEqual([]);
    }

    // 3. 发布阶段 fallback wx 写一半时取消：清理自身半成品与临时文件
    let abortPub = false;
    const cancelPubFs = new (class extends NodeTraceFileSystem {
      override async link(): Promise<void> {
        const e: NodeJS.ErrnoException = new Error('ENOTSUP');
        e.code = 'ENOTSUP';
        throw e;
      }
      override async open(filePath: string, flags: string): Promise<TraceFileHandle> {
        const h = await super.open(filePath, flags);
        if (flags === 'wx' && filePath.endsWith('cancel-pub.csv')) {
          return {
            async write(buf, offset, length, position) {
              abortPub = true;
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
    const cancelCsv = path.join(sandbox, 'cancel-pub.csv');
    const { store: sc } = await TraceRecordingStore.open({ recordingDir: recDir, fileSystem: cancelPubFs });
    const cancelRes = await sc.exportCsv({
      outputPath: cancelCsv,
      request: req,
      cancel: { isCancelled: () => abortPub },
    });
    await sc.close();
    expect(cancelRes.ok).toBe(false);
    if (!cancelRes.ok) expect(cancelRes.errorCode).toBe('QueryCancelled');
    await expect(fs.stat(cancelCsv)).rejects.toThrow();
    expect((await fs.readdir(sandbox)).filter((n) => n.includes('.orbit-csv-'))).toEqual([]);
  });
});
