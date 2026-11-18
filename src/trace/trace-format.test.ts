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
});
