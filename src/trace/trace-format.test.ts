import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DecodedSystemViewPacket } from './systemview-decoder';
import type { ExecutionSliceInterval, ReadyWaitInterval } from './systemview-reconstructor';
import { SYSTEMVIEW_PROTOCOL_VERSION } from './systemview-protocol';
import {
  computeCrc32,
  decodeIndexSnapshot,
  decodeTraceDataPage,
  encodeIndexSnapshot,
  encodeJournalFrame,
  encodeTraceDataPage,
  inspectRecordingDirectory,
  JOURNAL_FRAME_KIND,
  ORBIT_TRACE_FILES,
  ORBIT_TRACE_FORMAT,
  ORBIT_TRACE_FORMAT_VERSION,
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

describe('Orbit 内部 Trace 格式与校验 (阶段 4.3)', () => {
  it('二进制页编解码保持 BigInt 超 53 位精度、Uint8Array 与可选字段无损还原', () => {
    const hugeRel = 9007199254740993123456n;
    const hugeAbs = 18446744073709551615009n;
    const pkt: DecodedSystemViewPacket = {
      protocolVersion: SYSTEMVIEW_PROTOCOL_VERSION,
      segmentId: 2,
      packetIndexInSegment: 7,
      streamByteOffset: 1234,
      byteLength: 19,
      eventId: 512,
      eventName: 'USER_EVENT_0',
      category: 'user',
      schemaReliability: 'known',
      segmentReliability: 'trusted',
      deltaTicks: 42,
      segmentRelativeTicks: hugeRel.toString(),
      segmentRelativeTicksBigInt: hugeRel,
      absoluteTicks: hugeAbs.toString(),
      absoluteTicksBigInt: hugeAbs,
      rawTimestampMod: 12345,
      timestampWrapped: true,
      timeAnchorStatus: 'anchored-cycles',
      sysFreqHz: 64_000_000,
      timestampUs: 123.5,
      timestampNs: '288230376151711744000',
      decoded: {
        kind: 'user-event',
        rawPayload: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
      },
    };

    const encoded = encodeTraceDataPage('packets', 3, 2, [pkt]);
    const decoded = decodeTraceDataPage(encoded.buffer, encoded.pageCrc32);
    expect(decoded.kind).toBe('packets');
    expect(decoded.bootGeneration).toBe(3);
    expect(decoded.segmentId).toBe(2);
    expect(decoded.items.length).toBe(1);
    const out = (decoded.items as DecodedSystemViewPacket[])[0];
    expect(out.segmentRelativeTicksBigInt).toBe(hugeRel);
    expect(out.absoluteTicksBigInt).toBe(hugeAbs);
    expect(out.segmentRelativeTicks).toBe(hugeRel.toString());
    expect(out.absoluteTicks).toBe(hugeAbs.toString());
    expect(out.decoded).toEqual(pkt.decoded);

    const slice: ExecutionSliceInterval = {
      sliceId: 's-1',
      bootGeneration: 3,
      segmentId: 2,
      segmentReliability: 'trusted',
      completeness: 'complete',
      contextKind: 'task',
      contextKey: 'task:b3:tcb:0x20000100#g1:i1',
      taskInstanceId: 'b3:tcb:0x20000100#g1:i1',
      tcbAddress: 0x20000100,
      shrunkTaskId: 0x40,
      taskGeneration: 1,
      isrDepth: 0,
      label: 'WorkerTask',
      labelSource: 'task-info',
      start: {
        segmentId: 2,
        packetIndexInSegment: 0,
        streamByteOffset: 100,
        relativeTicks: hugeRel.toString(),
        relativeTicksBigInt: hugeRel,
        absoluteTicks: hugeAbs.toString(),
        absoluteTicksBigInt: hugeAbs,
        timeAnchorStatus: 'anchored-cycles',
        sysFreqHz: 64_000_000,
        timestampNs: '288230376151711744000',
      },
      end: {
        segmentId: 2,
        packetIndexInSegment: 1,
        streamByteOffset: 120,
        relativeTicks: (hugeRel + 50n).toString(),
        relativeTicksBigInt: hugeRel + 50n,
        absoluteTicks: (hugeAbs + 50n).toString(),
        absoluteTicksBigInt: hugeAbs + 50n,
        timeAnchorStatus: 'anchored-cycles',
        sysFreqHz: 64_000_000,
        timestampNs: '288230376151711744781',
      },
      durationTicks: '50',
      durationTicksBigInt: 50n,
      durationNs: '781',
      timeDomain: 'anchored-ticks',
      startReason: 'task-start-exec',
      endReason: 'task-stop-exec',
    };

    const encSlice = encodeTraceDataPage('slices', 3, 2, [slice]);
    const decSlice = decodeTraceDataPage(encSlice.buffer, encSlice.pageCrc32);
    expect((decSlice.items as ExecutionSliceInterval[])[0]).toEqual(slice);

    const rw: ReadyWaitInterval = {
      waitId: 'w-1',
      bootGeneration: 3,
      segmentId: 2,
      segmentReliability: 'trusted',
      completeness: 'incomplete',
      outcome: 'incomplete',
      taskInstanceId: 'b3:tcb:0x20000100#g1:i1',
      taskGeneration: 1,
      labelSource: 'missing',
      start: slice.start,
      timeDomain: 'anchored-ticks',
      endReason: 'eof',
    };
    const encRw = encodeTraceDataPage('longReadyWaits', 3, 2, [rw]);
    const decRw = decodeTraceDataPage(encRw.buffer, encRw.pageCrc32);
    expect((decRw.items as ReadyWaitInterval[])[0]).toEqual(rw);
  });

  it('OTI1 索引快照与 OTJ1 日志帧校验能检测页/帧篡改', () => {
    const snap = encodeIndexSnapshot({
      format: ORBIT_TRACE_FORMAT,
      formatVersion: ORBIT_TRACE_FORMAT_VERSION,
      segments: [],
      pages: [],
      gaps: [],
      tasks: [],
    });
    expect(decodeIndexSnapshot(snap).format).toBe(ORBIT_TRACE_FORMAT);
    snap[snap.length - 1] ^= 0xff;
    expect(() => decodeIndexSnapshot(snap)).toThrow(/CRC32/);

    const frame = encodeJournalFrame({
      frameKind: JOURNAL_FRAME_KIND.CHUNK_COMMIT,
      commitSeq: 1,
      rawOffset: 0,
      rawLength: 10,
      rawCrc32: computeCrc32(new Uint8Array(10)),
      dataOffset: 0,
      dataLength: 0,
      dataCrc32: 0,
      meta: { bootGeneration: 1 },
    });
    expect(frame.readUInt32LE(0)).toBe(0x4f544a31);
  });

  it('精确区分完整录制、未完整关闭（含未提交尾部）、以及数据/校验损坏录制', async () => {
    const sample = await fs.readFile('scripts/rtos/fixtures/samples/continuous.bin');
    const dirComplete = await makeTempDir('orbit-fmt-complete-');

    const store = await TraceRecordingStore.create({
      recordingDir: dirComplete,
      recordId: 'rec-fmt-1',
      identity: { sessionId: 's1', sessionGeneration: 1, bootGeneration: 1, recordId: 'rec-fmt-1' },
      commitOnEachIngest: true,
    });
    await store.ingestRawChunk(sample.subarray(0, 32), { batchSequence: 1 });
    await store.ingestRawChunk(sample.subarray(32), { batchSequence: 2 });
    const fin = await store.finish();
    expect(fin.ok).toBe(true);
    await store.close();

    const inspComplete = await inspectRecordingDirectory(dirComplete);
    expect(inspComplete.status).toBe('completed');
    expect(inspComplete.isComplete).toBe(true);
    expect(inspComplete.isCorrupted).toBe(false);
    expect(inspComplete.rawSha256Verified).toBe(true);
    expect(inspComplete.recoverableRawBytes).toBe(sample.length);

    // 模拟未完整关闭：复制一份未调用 finish() 的录制目录并附加未提交尾部 + 截断的 journal 尾部帧
    const dirCrash = await makeTempDir('orbit-fmt-crash-');
    const storeCrash = await TraceRecordingStore.create({
      recordingDir: dirCrash,
      recordId: 'rec-crash',
      identity: { sessionId: 's1', sessionGeneration: 1, bootGeneration: 1, recordId: 'rec-crash' },
      commitOnEachIngest: true,
    });
    const prefixLen = 32;
    await storeCrash.ingestRawChunk(sample.subarray(0, prefixLen), { batchSequence: 1 });
    // 不调用 finish()，直接 close 模拟进程崩溃前仅持久化了第 1 个提交
    await storeCrash.close();
    // 往 raw.otbin 末尾写入未提交的半截字节，并往 journal.otj 写入半截帧头
    await fs.appendFile(path.join(dirCrash, ORBIT_TRACE_FILES.raw), Buffer.from([0xaa, 0xbb, 0xcc]));
    await fs.appendFile(path.join(dirCrash, ORBIT_TRACE_FILES.journal), Buffer.alloc(12, 0x55));

    const inspCrash = await inspectRecordingDirectory(dirCrash);
    expect(inspCrash.status).toBe('interrupted');
    expect(inspCrash.isComplete).toBe(false);
    expect(inspCrash.isRecoverable).toBe(true);
    expect(inspCrash.recoverableRawBytes).toBe(prefixLen);
    expect(inspCrash.uncommittedTrailingRawBytes).toBe(3);
    expect(inspCrash.diagnostics.some((d) => d.code === 'truncated-journal-tail')).toBe(true);
    expect(inspCrash.diagnostics.some((d) => d.code === 'uncommitted-raw-tail')).toBe(true);

    // 模拟已提交区域篡改（在 dirComplete 的 raw.otbin 第 10 字节翻转 1 bit）
    const rawBuf = await fs.readFile(path.join(dirComplete, ORBIT_TRACE_FILES.raw));
    rawBuf[10] ^= 0x01;
    await fs.writeFile(path.join(dirComplete, ORBIT_TRACE_FILES.raw), rawBuf);
    const inspCorrupt = await inspectRecordingDirectory(dirComplete);
    expect(inspCorrupt.status).toBe('corrupted');
    expect(inspCorrupt.isComplete).toBe(false);
    expect(inspCorrupt.isCorrupted).toBe(true);
    expect(inspCorrupt.diagnostics.some((d) => d.code === 'raw-crc-mismatch')).toBe(true);
    expect(createHash('sha256').update(sample.subarray(0, prefixLen)).digest('hex')).toBeTypeOf('string');
  });

  it('精确区分坏索引、截断最终 journal 帧（可按已验证 SHA 恢复）、以及非法格式/版本号拒绝', async () => {
    const sample = await fs.readFile('scripts/rtos/fixtures/samples/continuous.bin');
    const sampleSha = createHash('sha256').update(sample).digest('hex');

    // 1. corrupt-index: 破坏 index.otidx 但 journal.otj 完整 -> 可由 journal 重建索引
    const dirBadIdx = await makeTempDir('orbit-fmt-badidx-');
    const sIdx = await TraceRecordingStore.create({
      recordingDir: dirBadIdx,
      recordId: 'rec-badidx',
      identity: { sessionId: 's1', sessionGeneration: 1, bootGeneration: 1, recordId: 'rec-badidx' },
      commitOnEachIngest: true,
    });
    expect((await sIdx.ingestRawChunk(sample, { batchSequence: 1 })).ok).toBe(true);
    expect((await sIdx.finish()).ok).toBe(true);
    await sIdx.close();

    await fs.writeFile(path.join(dirBadIdx, ORBIT_TRACE_FILES.index), Buffer.from('CORRUPT-IDX'));
    const inspBadIdx = await inspectRecordingDirectory(dirBadIdx);
    expect(inspBadIdx.indexStatus).toBe('corrupt');
    expect(inspBadIdx.recoveryDisposition).toBe('rebuilt-bad-index');
    expect(inspBadIdx.isRecoverable).toBe(true);
    expect(inspBadIdx.recoverableRawBytes).toBe(sample.length);
    expect(inspBadIdx.rawSha256Verified).toBe(true);
    expect(inspBadIdx.diagnostics.some((d) => d.code === 'corrupt-index')).toBe(true);

    const { store: reopenedIdx } = await TraceRecordingStore.open({ recordingDir: dirBadIdx });
    const outIdxDir = await makeTempDir('orbit-fmt-outidx-');
    const expIdx = path.join(outIdxDir, 'rebuilt.bin');
    expect((await reopenedIdx.exportRaw({ outputPath: expIdx })).ok).toBe(true);
    expect(createHash('sha256').update(await fs.readFile(expIdx)).digest('hex')).toBe(sampleSha);
    await reopenedIdx.close();

    // 2. truncated-final-journal-frame (无已提交块损坏):
    // 2a. 未 finish 崩溃 -> manifest.rawSha256 不存在 -> status=interrupted, rawSha256Verified=false
    const dirTruncJ = await makeTempDir('orbit-fmt-truncj-');
    const sTj = await TraceRecordingStore.create({
      recordingDir: dirTruncJ,
      recordId: 'rec-truncj',
      identity: { sessionId: 's1', sessionGeneration: 1, bootGeneration: 1, recordId: 'rec-truncj' },
      commitOnEachIngest: true,
    });
    expect((await sTj.ingestRawChunk(sample, { batchSequence: 1 })).ok).toBe(true);
    await sTj.close(); // unclean close without finish
    await fs.appendFile(path.join(dirTruncJ, ORBIT_TRACE_FILES.journal), Buffer.from([0x4f, 0x54, 0x4a, 0x31, 0x00, 0x00]));
    const inspTruncJ = await inspectRecordingDirectory(dirTruncJ);
    expect(inspTruncJ.status).toBe('interrupted');
    expect(inspTruncJ.recoveryDisposition).toBe('recovered-interrupted');
    expect(inspTruncJ.isRecoverable).toBe(true);
    expect(inspTruncJ.rawSha256Verified).toBe(false);
    expect(inspTruncJ.recoverableRawBytes).toBe(sample.length);
    expect(inspTruncJ.diagnostics.some((d) => d.code === 'truncated-journal-tail')).toBe(true);

    // 2b. 已 finish（含 manifest.rawSha256）但最终 clean_close journal 帧写入半截截断 -> status=interrupted 且 rawSha256Verified=true
    const dirTruncJFin = await makeTempDir('orbit-fmt-truncj-fin-');
    const sTjFin = await TraceRecordingStore.create({
      recordingDir: dirTruncJFin,
      recordId: 'rec-truncj-fin',
      identity: { sessionId: 's1', sessionGeneration: 1, bootGeneration: 1, recordId: 'rec-truncj-fin' },
      commitOnEachIngest: true,
    });
    expect((await sTjFin.ingestRawChunk(sample, { batchSequence: 1 })).ok).toBe(true);
    expect((await sTjFin.finish()).ok).toBe(true);
    await sTjFin.close();
    const jPathFin = path.join(dirTruncJFin, ORBIT_TRACE_FILES.journal);
    const jBytesFin = await fs.readFile(jPathFin);
    await fs.writeFile(jPathFin, jBytesFin.subarray(0, jBytesFin.length - 10));
    const inspTruncJFin = await inspectRecordingDirectory(dirTruncJFin);
    expect(inspTruncJFin.status).toBe('interrupted');
    expect(inspTruncJFin.recoveryDisposition).toBe('recovered-interrupted');
    expect(inspTruncJFin.isRecoverable).toBe(true);
    expect(inspTruncJFin.rawSha256Verified).toBe(true);
    expect(inspTruncJFin.recoverableRawBytes).toBe(sample.length);

    // 3. unsupported-version (999) & unsupported-format: 必须拒绝打开
    const dirBadVer = await makeTempDir('orbit-fmt-ver999-');
    await fs.cp(dirTruncJ, dirBadVer, { recursive: true });
    const manifestPath = path.join(dirBadVer, ORBIT_TRACE_FILES.manifest);
    const man = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    man.formatVersion = 999;
    await fs.writeFile(manifestPath, JSON.stringify(man, null, 2));
    const inspBadVer = await inspectRecordingDirectory(dirBadVer);
    expect(inspBadVer.detectedFormatVersion).toBe(999);
    expect(inspBadVer.isRecoverable).toBe(false);
    expect(inspBadVer.diagnostics.some((d) => d.code === 'unsupported-version')).toBe(true);
    await expect(TraceRecordingStore.open({ recordingDir: dirBadVer })).rejects.toMatchObject({ code: 'UnsupportedArchiveVersion' });

    const dirBadFmt = await makeTempDir('orbit-fmt-badfmt-');
    await fs.cp(dirTruncJ, dirBadFmt, { recursive: true });
    const manFmtPath = path.join(dirBadFmt, ORBIT_TRACE_FILES.manifest);
    const manFmt = JSON.parse(await fs.readFile(manFmtPath, 'utf8'));
    manFmt.format = 'custom-unknown-v9';
    await fs.writeFile(manFmtPath, JSON.stringify(manFmt, null, 2));
    await expect(TraceRecordingStore.open({ recordingDir: dirBadFmt })).rejects.toMatchObject({ code: 'UnsupportedArchiveFormat' });
  });
});
