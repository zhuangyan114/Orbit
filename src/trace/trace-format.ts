import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  DecodedEventPayload,
  DecodedSystemViewPacket,
  SegmentReliability,
  SystemViewDecoderOptions,
  TimeAnchorStatus,
  TraceDiagnostic,
  TraceGapKind,
  TraceGapRecord,
  TraceSegmentSummary,
} from './systemview-decoder';
import type {
  ContextActivationInterval,
  ExecutionSliceInterval,
  MarkerInterval,
  MarkerPointEvent,
  ReadyWaitInterval,
  ReconstructorDiagnostic,
  TaskInstanceSummary,
  TraceReconstructionIdentity,
  TraceTimePoint,
} from './systemview-reconstructor';
import { SYSTEMVIEW_PROTOCOL_VERSION } from './systemview-protocol';

/**
 * Orbit 内部 Trace 录制与回放格式（非 SEGGER `.SVDat`）。
 *
 * 目录结构：
 * - `manifest.json`：录制元数据、状态（recording/completed/interrupted/failed/corrupted）、提交统计与校验信息。
 * - `raw.otbin`：严格逐字节与源输入一致的原始二进制流（无任何帧头混入），按有界块追加持久化。
 * - `data.otd`：`OTD1` 分页二进制存储（packets / executionSlices / contextActivations / readyWaits / markers / markerPoints / long*）。
 * - `journal.otj`：`OTJ1` 追加提交日志，每条记录带头 CRC32、整帧 CRC32、raw/data 偏移与 CRC32 校验，界定有效提交边界。
 * - `index.otidx`：`OTI1` 可选索引快照（仅有序关闭时写入；缺失时可从 `journal.otj` 重建）。
 */
export const ORBIT_TRACE_FORMAT = 'orbit-trace-v1' as const;
export const ORBIT_TRACE_FORMAT_VERSION = 1 as const;
export const ORBIT_TRACE_NON_SVDAT_NOTICE =
  'Orbit internal trace recording format v1 (orbit-trace-v1); NOT SEGGER .SVDat format.' as const;

export const ORBIT_TRACE_FILES = {
  manifest: 'manifest.json',
  manifestTmp: 'manifest.json.tmp',
  raw: 'raw.otbin',
  data: 'data.otd',
  journal: 'journal.otj',
  index: 'index.otidx',
  indexTmp: 'index.otidx.tmp',
} as const;

export const OTJ_MAGIC = 0x4f544a31; // 'OTJ1'
export const OTD_MAGIC = 0x4f544431; // 'OTD1'
export const OTI_MAGIC = 0x4f544931; // 'OTI1'
export const OTJ_HEADER_BYTES = 56;
export const OTJ_TRAILER_BYTES = 4;
export const OTD_HEADER_BYTES = 32;
export const OTI_HEADER_BYTES = 16;
export const MAX_JOURNAL_META_BYTES = 16 * 1024 * 1024;
export const MAX_DATA_PAGE_PAYLOAD_BYTES = 32 * 1024 * 1024;

export type RecordingLifecycleState =
  | 'recording'
  | 'completed'
  | 'interrupted'
  | 'failed'
  | 'corrupted';

export type JournalFrameKind = 1 | 2 | 3 | 4 | 5;
export const JOURNAL_FRAME_KIND = {
  CHUNK_COMMIT: 1 as JournalFrameKind,
  GAP_MARK: 2 as JournalFrameKind,
  BOOT_RESET: 3 as JournalFrameKind,
  CLEAN_CLOSE: 4 as JournalFrameKind,
  FAILURE_MARK: 5 as JournalFrameKind,
} as const;

export type TracePageKind =
  | 'packets'
  | 'slices'
  | 'activations'
  | 'readyWaits'
  | 'markers'
  | 'markerPoints'
  | 'longSlices'
  | 'longActivations'
  | 'longReadyWaits'
  | 'longMarkers';

export const TRACE_PAGE_KIND_TO_CODE: Readonly<Record<TracePageKind, number>> = {
  packets: 1,
  slices: 2,
  activations: 3,
  readyWaits: 4,
  markers: 5,
  markerPoints: 6,
  longSlices: 7,
  longActivations: 8,
  longReadyWaits: 9,
  longMarkers: 10,
};

export const CODE_TO_TRACE_PAGE_KIND: Readonly<Record<number, TracePageKind>> = {
  1: 'packets',
  2: 'slices',
  3: 'activations',
  4: 'readyWaits',
  5: 'markers',
  6: 'markerPoints',
  7: 'longSlices',
  8: 'longActivations',
  9: 'longReadyWaits',
  10: 'longMarkers',
};

export interface TraceRecordingCommittedCounts {
  readonly commitSeq: number;
  readonly rawBytes: number;
  readonly dataBytes: number;
  readonly journalBytes: number;
  readonly packetCount: number;
  readonly sliceCount: number;
  readonly activationCount: number;
  readonly readyWaitCount: number;
  readonly markerCount: number;
  readonly markerPointCount: number;
  readonly gapCount: number;
  readonly segmentCount: number;
}

export interface TraceRecordingLimitsSnapshot {
  readonly rawChunkBytes: number;
  readonly pageMaxItems: number;
  readonly pageMaxBytes: number;
  readonly maxCacheBytes: number;
  readonly maxCachedPages: number;
  readonly maxIndexPagesInMemory: number;
  readonly maxWriteQueueBytes: number;
  readonly maxSingleBatchBytes: number;
}

export interface TraceRecordingManifest {
  readonly format: typeof ORBIT_TRACE_FORMAT;
  readonly formatVersion: typeof ORBIT_TRACE_FORMAT_VERSION;
  readonly protocolVersion: typeof SYSTEMVIEW_PROTOCOL_VERSION;
  readonly nonStandardNotice: typeof ORBIT_TRACE_NON_SVDAT_NOTICE;
  readonly recordId: string;
  readonly identity: TraceReconstructionIdentity;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly closedAtMs?: number;
  readonly state: RecordingLifecycleState;
  readonly closeReason?: string;
  readonly failureCode?: string;
  readonly failureDiagnostics?: Record<string, unknown>;
  readonly decoderOptions?: SystemViewDecoderOptions;
  readonly committed: TraceRecordingCommittedCounts;
  readonly rawSha256?: string;
  readonly files: {
    readonly raw: string;
    readonly data: string;
    readonly journal: string;
    readonly index: string;
  };
  readonly limits: TraceRecordingLimitsSnapshot;
}

export interface IndexedPageDescriptor {
  readonly pageId: number;
  readonly kind: TracePageKind;
  readonly bootGeneration: number;
  readonly segmentId: number;
  readonly dataOffset: number;
  readonly dataLength: number;
  readonly dataCrc32: number;
  readonly itemCount: number;
  readonly isLongIntervalPage: boolean;
  readonly minRelativeTicks: string;
  readonly maxRelativeTicks: string;
  readonly hasAbsoluteTicks: boolean;
  readonly allAbsoluteTicks: boolean;
  readonly minAbsoluteTicks?: string;
  readonly maxAbsoluteTicks?: string;
  readonly sysFreqHz?: number;
  readonly minNs?: string;
  readonly maxNs?: string;
  readonly minByteOffset: number;
  readonly maxByteOffset: number;
  readonly maxDurationTicks: string;
  readonly hasIncomplete: boolean;
  readonly hasUncertain: boolean;
}

export interface SegmentIndexMetadata {
  readonly bootGeneration: number;
  readonly segmentId: number;
  readonly startByteOffset: number;
  readonly endByteOffset?: number;
  readonly reliability: SegmentReliability;
  readonly closed: boolean;
  readonly endReason?: TraceSegmentSummary['endReason'];
  readonly packetCount: number;
  readonly syncCount: number;
  readonly timestampBits: number;
  readonly timestampWrapCount: number;
  readonly timeAnchorStatus: TimeAnchorStatus;
  readonly minRelativeTicks: string;
  readonly maxRelativeTicks: string;
  readonly firstAbsoluteTicks?: string;
  readonly lastAbsoluteTicks?: string;
  readonly sysFreqHz?: number;
  readonly minNs?: string;
  readonly maxNs?: string;
}

export interface StoredGapEntry {
  readonly seq: number;
  readonly bootGeneration: number;
  readonly kind: TraceGapKind | 'target-reset' | 'trace-stop' | 'eof' | 'metadata-reconfigured' | 'resync';
  readonly segmentIdBefore?: number;
  readonly byteOffset: number;
  readonly relativeTicks?: string;
  readonly absoluteTicks?: string;
  readonly droppedPackets: number | 'unknown';
  readonly droppedBytes: number | 'unknown';
  readonly reason: string;
  readonly preservesFraming?: boolean;
  readonly closedOpenCount?: number;
}

export interface JournalCommitMetadata {
  readonly batchSequence?: number;
  readonly bootGeneration: number;
  readonly identity?: TraceReconstructionIdentity;
  readonly pages?: readonly IndexedPageDescriptor[];
  readonly segments?: readonly SegmentIndexMetadata[];
  readonly gaps?: readonly StoredGapEntry[];
  readonly tasks?: readonly TaskInstanceSummary[];
  readonly decoderDiagnostics?: readonly TraceDiagnostic[];
  readonly reconstructorDiagnostics?: readonly ReconstructorDiagnostic[];
  readonly droppedDiagnosticsCount?: number;
  readonly countsDelta?: {
    readonly packetCount?: number;
    readonly sliceCount?: number;
    readonly activationCount?: number;
    readonly readyWaitCount?: number;
    readonly markerCount?: number;
    readonly markerPointCount?: number;
    readonly gapCount?: number;
  };
  readonly closeSummary?: {
    readonly reason: string;
    readonly rawSha256: string;
    readonly totalRawBytes: number;
    readonly totalDataBytes: number;
    readonly committed: TraceRecordingCommittedCounts;
  };
  readonly failureSummary?: {
    readonly errorCode: string;
    readonly message: string;
    readonly terminalState?: 'interrupted' | 'failed';
    readonly rawSha256?: string;
    readonly totalRawBytes?: number;
    readonly committed?: TraceRecordingCommittedCounts;
    readonly diagnostics?: Record<string, unknown>;
  };
  readonly resetSummary?: {
    readonly previousBootGeneration: number;
    readonly nextBootGeneration: number;
    readonly reason: string;
  };
}

export interface ParsedJournalFrame {
  readonly frameOffset: number;
  readonly frameLength: number;
  readonly frameKind: JournalFrameKind;
  readonly commitSeq: number;
  readonly rawOffset: number;
  readonly rawLength: number;
  readonly rawCrc32: number;
  readonly dataOffset: number;
  readonly dataLength: number;
  readonly dataCrc32: number;
  readonly meta: JournalCommitMetadata;
}

export type RecordingIndexStatus = 'valid' | 'missing' | 'corrupt';

export type RecordingRecoveryDisposition =
  | 'intact'
  | 'rebuilt-bad-index'
  | 'recovered-prefix-bad-chunk'
  | 'recovered-interrupted'
  | 'recovered-failed'
  | 'unrecoverable';

export interface RecordingDiagnostic {
  readonly code:
    | 'missing-manifest'
    | 'corrupt-manifest'
    | 'unsupported-format'
    | 'unsupported-version'
    | 'corrupt-index'
    | 'unclean-close'
    | 'uncommitted-raw-tail'
    | 'uncommitted-data-tail'
    | 'truncated-journal-tail'
    | 'corrupt-journal-frame'
    | 'raw-truncated'
    | 'raw-crc-mismatch'
    | 'data-truncated'
    | 'data-crc-mismatch'
    | 'raw-sha256-mismatch'
    | 'failure-recorded'
    | 'sequence-mismatch';
  readonly file: string;
  readonly offset?: number;
  readonly commitSeq?: number;
  readonly message: string;
}

export interface RecordingInspectionResult {
  readonly format: typeof ORBIT_TRACE_FORMAT;
  readonly formatVersion: typeof ORBIT_TRACE_FORMAT_VERSION;
  readonly detectedFormat?: string;
  readonly detectedFormatVersion?: number;
  readonly status: RecordingLifecycleState;
  readonly isComplete: boolean;
  readonly isRecoverable: boolean;
  readonly isCorrupted: boolean;
  readonly indexStatus: RecordingIndexStatus;
  readonly hasCommittedChunkCorruption: boolean;
  readonly recoveryDisposition: RecordingRecoveryDisposition;
  readonly recoverableRawBytes: number;
  readonly recoverableDataBytes: number;
  readonly actualRawFileBytes: number;
  readonly actualDataFileBytes: number;
  readonly actualJournalFileBytes: number;
  readonly uncommittedTrailingRawBytes: number;
  readonly uncommittedTrailingDataBytes: number;
  readonly lastValidCommitSeq: number;
  readonly cleanCloseFound: boolean;
  readonly rawSha256Verified: boolean;
  readonly manifest?: TraceRecordingManifest;
  readonly frames: readonly ParsedJournalFrame[];
  readonly diagnostics: readonly RecordingDiagnostic[];
}

/**
 * 可注入文件系统抽象：生产默认使用真实 Node `fs/promises`，测试可包装注入 ENOSPC、短写与写失败。
 */
export interface TraceFileHandle {
  write(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesWritten: number }>;
  read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  sync(): Promise<void>;
  truncate(len: number): Promise<void>;
  stat(): Promise<{ size: number }>;
  close(): Promise<void>;
}

export interface TraceFileStat {
  readonly size: number;
  readonly dev?: number;
  readonly ino?: number;
  readonly isSymbolicLink?: boolean;
}

export interface TraceFileSystem {
  mkdir(dirPath: string, options?: { recursive?: boolean }): Promise<void>;
  open(filePath: string, flags: string): Promise<TraceFileHandle>;
  readFile(filePath: string): Promise<Uint8Array>;
  writeFile(filePath: string, data: Uint8Array | string): Promise<void>;
  writeFileExclusive?(filePath: string, data: Uint8Array | string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  link?(existingPath: string, newPath: string): Promise<void>;
  stat(filePath: string): Promise<TraceFileStat>;
  lstat?(filePath: string): Promise<TraceFileStat>;
  readdir?(dirPath: string): Promise<string[]>;
  unlink?(filePath: string): Promise<void>;
  rmdir?(dirPath: string): Promise<void>;
  realpath?(filePath: string): Promise<string>;
  exists(filePath: string): Promise<boolean>;
}

export class NodeTraceFileSystem implements TraceFileSystem {
  public async mkdir(dirPath: string, options?: { recursive?: boolean }): Promise<void> {
    await fs.mkdir(dirPath, options);
  }

  public async open(filePath: string, flags: string): Promise<TraceFileHandle> {
    const handle = await fs.open(filePath, flags);
    return {
      write: (buffer, offset, length, position) => handle.write(buffer, offset, length, position),
      read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
      sync: () => handle.sync(),
      truncate: (len) => handle.truncate(len),
      stat: async () => ({ size: (await handle.stat()).size }),
      close: () => handle.close(),
    };
  }

  public async readFile(filePath: string): Promise<Uint8Array> {
    return fs.readFile(filePath);
  }

  public async writeFile(filePath: string, data: Uint8Array | string): Promise<void> {
    await fs.writeFile(filePath, data);
  }

  public async writeFileExclusive(filePath: string, data: Uint8Array | string): Promise<void> {
    await fs.writeFile(filePath, data, { flag: 'wx' });
  }

  public async rename(oldPath: string, newPath: string): Promise<void> {
    await fs.rename(oldPath, newPath);
  }

  public async link(existingPath: string, newPath: string): Promise<void> {
    await fs.link(existingPath, newPath);
  }

  public async stat(filePath: string): Promise<TraceFileStat> {
    const st = await fs.stat(filePath);
    return { size: st.size, dev: st.dev, ino: st.ino };
  }

  public async lstat(filePath: string): Promise<TraceFileStat> {
    const st = await fs.lstat(filePath);
    return { size: st.size, dev: st.dev, ino: st.ino, isSymbolicLink: st.isSymbolicLink() };
  }

  public async readdir(dirPath: string): Promise<string[]> {
    return fs.readdir(dirPath);
  }

  public async unlink(filePath: string): Promise<void> {
    await fs.unlink(filePath);
  }

  public async rmdir(dirPath: string): Promise<void> {
    await fs.rmdir(dirPath);
  }

  public async realpath(filePath: string): Promise<string> {
    return fs.realpath(filePath);
  }

  public async exists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}

export const defaultTraceFileSystem = new NodeTraceFileSystem();

// ---------------------------------------------------------------------------
// CRC32 (IEEE 802.3)
// ---------------------------------------------------------------------------

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function computeCrc32(data: Uint8Array, seed = 0): number {
  let crc = (seed ^ 0xffffffff) >>> 0;
  for (let i = 0; i < data.length; i++) {
    crc = CRC32_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * BigInt 保真 JSON 序列化：将所有 `bigint` 字段转为十进制字符串，避免 `JSON.stringify` 抛出 TypeError。
 */
export function safeTraceJsonStringify(value: unknown, space?: number): string {
  return JSON.stringify(
    value,
    (_key, v) => (typeof v === 'bigint' ? v.toString() : v),
    space,
  );
}

// ---------------------------------------------------------------------------
// Journal Frame Codec (OTJ1)
// ---------------------------------------------------------------------------

export function encodeJournalFrame(input: {
  frameKind: JournalFrameKind;
  commitSeq: number;
  rawOffset: number;
  rawLength: number;
  rawCrc32: number;
  dataOffset: number;
  dataLength: number;
  dataCrc32: number;
  meta: JournalCommitMetadata;
}): Buffer {
  const metaJson = safeTraceJsonStringify(input.meta);
  const metaBuf = Buffer.from(metaJson, 'utf8');
  if (metaBuf.length > MAX_JOURNAL_META_BYTES) {
    throw new RangeError(`Journal metadata size ${metaBuf.length} exceeds limit ${MAX_JOURNAL_META_BYTES}`);
  }
  const totalLen = OTJ_HEADER_BYTES + metaBuf.length + OTJ_TRAILER_BYTES;
  const out = Buffer.allocUnsafe(totalLen);

  out.writeUInt32LE(OTJ_MAGIC, 0);
  out.writeUInt16LE(ORBIT_TRACE_FORMAT_VERSION, 4);
  out.writeUInt16LE(input.frameKind, 6);
  out.writeBigUInt64LE(BigInt(input.commitSeq), 8);
  out.writeBigUInt64LE(BigInt(input.rawOffset), 16);
  out.writeUInt32LE(input.rawLength >>> 0, 24);
  out.writeUInt32LE(input.rawCrc32 >>> 0, 28);
  out.writeBigUInt64LE(BigInt(input.dataOffset), 32);
  out.writeUInt32LE(input.dataLength >>> 0, 40);
  out.writeUInt32LE(input.dataCrc32 >>> 0, 44);
  out.writeUInt32LE(metaBuf.length >>> 0, 48);
  const headerCrc = computeCrc32(out.subarray(0, 52));
  out.writeUInt32LE(headerCrc >>> 0, 52);

  metaBuf.copy(out, OTJ_HEADER_BYTES);
  const frameCrc = computeCrc32(out.subarray(0, OTJ_HEADER_BYTES + metaBuf.length));
  out.writeUInt32LE(frameCrc >>> 0, OTJ_HEADER_BYTES + metaBuf.length);
  return out;
}

// ---------------------------------------------------------------------------
// Deterministic Binary Page Codec (OTD1) with String Interning & BigInt
// ---------------------------------------------------------------------------

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: false });

class BinaryWriter {
  private buf: Buffer;
  private pos = 0;
  private readonly stringToId = new Map<string, number>();
  private readonly strings: string[] = [];

  public constructor(initialCapacity = 16384) {
    this.buf = Buffer.allocUnsafe(initialCapacity);
  }

  private ensure(extra: number): void {
    const needed = this.pos + extra;
    if (needed <= this.buf.length) {
      return;
    }
    let nextCap = this.buf.length;
    while (nextCap < needed) {
      nextCap = nextCap < 1024 * 1024 ? nextCap * 2 : nextCap + 1024 * 1024;
    }
    const next = Buffer.allocUnsafe(nextCap);
    this.buf.copy(next, 0, 0, this.pos);
    this.buf = next;
  }

  public writeU8(v: number): void {
    this.ensure(1);
    this.buf[this.pos++] = v & 0xff;
  }

  public writeU32(v: number): void {
    this.ensure(4);
    this.buf.writeUInt32LE(v >>> 0, this.pos);
    this.pos += 4;
  }

  public writeF64(v: number): void {
    this.ensure(8);
    this.buf.writeDoubleLE(v, this.pos);
    this.pos += 8;
  }

  public writeVarUint(v: number): void {
    let n = v >>> 0;
    this.ensure(5);
    while (n >= 0x80) {
      this.buf[this.pos++] = (n & 0x7f) | 0x80;
      n >>>= 7;
    }
    this.buf[this.pos++] = n & 0x7f;
  }

  public writeVarIntSigned(v: number): void {
    if (Number.isSafeInteger(v) && v >= 0 && v <= 0xffffffff) {
      this.writeU8(0);
      this.writeVarUint(v);
      return;
    }
    this.writeU8(1);
    this.writeF64(v);
  }

  public writeBigInt(value: bigint): void {
    if (value === 0n) {
      this.writeU8(0);
      return;
    }
    const negative = value < 0n;
    let mag = negative ? -value : value;
    const bytes: number[] = [];
    while (mag > 0n) {
      bytes.push(Number(mag & 0xffn));
      mag >>= 8n;
    }
    this.writeU8((negative ? 0x80 : 0x00) | (bytes.length & 0x7f));
    if (bytes.length >= 0x80) {
      throw new RangeError(`BigInt byte length ${bytes.length} exceeds encoding limit`);
    }
    this.ensure(bytes.length);
    for (let i = 0; i < bytes.length; i++) {
      this.buf[this.pos++] = bytes[i];
    }
  }

  public writeRawString(str: string): void {
    const encoded = textEncoder.encode(str);
    this.writeVarUint(encoded.length);
    this.ensure(encoded.length);
    this.buf.set(encoded, this.pos);
    this.pos += encoded.length;
  }

  public writeInternedString(str: string): void {
    let id = this.stringToId.get(str);
    if (id === undefined) {
      id = this.strings.length;
      this.strings.push(str);
      this.stringToId.set(str, id);
    }
    this.writeVarUint(id);
  }

  public writeOptionalInternedString(str: string | undefined): void {
    if (str === undefined) {
      this.writeVarUint(0);
    } else {
      let id = this.stringToId.get(str);
      if (id === undefined) {
        id = this.strings.length;
        this.strings.push(str);
        this.stringToId.set(str, id);
      }
      this.writeVarUint(id + 1);
    }
  }

  public writeBytes(bytes: Uint8Array): void {
    this.writeVarUint(bytes.length);
    this.ensure(bytes.length);
    Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).copy(this.buf, this.pos);
    this.pos += bytes.length;
  }

  public writeTagValue(val: unknown): void {
    if (val === undefined) {
      this.writeU8(0);
      return;
    }
    if (val === null) {
      this.writeU8(1);
      return;
    }
    if (typeof val === 'boolean') {
      this.writeU8(val ? 2 : 3);
      return;
    }
    if (typeof val === 'number') {
      if (Number.isInteger(val) && val >= 0 && val <= 0xffffffff) {
        this.writeU8(4);
        this.writeVarUint(val);
      } else {
        this.writeU8(5);
        this.writeF64(val);
      }
      return;
    }
    if (typeof val === 'bigint') {
      this.writeU8(6);
      this.writeBigInt(val);
      return;
    }
    if (typeof val === 'string') {
      this.writeU8(7);
      this.writeInternedString(val);
      return;
    }
    if (val instanceof Uint8Array) {
      this.writeU8(8);
      this.writeBytes(val);
      return;
    }
    if (Array.isArray(val)) {
      this.writeU8(9);
      this.writeVarUint(val.length);
      for (let i = 0; i < val.length; i++) {
        this.writeTagValue(val[i]);
      }
      return;
    }
    if (typeof val === 'object') {
      this.writeU8(10);
      const entries = Object.entries(val as Record<string, unknown>);
      this.writeVarUint(entries.length);
      for (let i = 0; i < entries.length; i++) {
        this.writeInternedString(entries[i][0]);
        this.writeTagValue(entries[i][1]);
      }
      return;
    }
    throw new TypeError(`Unsupported value type in trace page: ${typeof val}`);
  }

  public finalizeWithStringTable(): Buffer {
    const strTableWriter = new BinaryWriter(Math.max(512, this.strings.length * 32));
    strTableWriter.writeVarUint(this.strings.length);
    for (let i = 0; i < this.strings.length; i++) {
      strTableWriter.writeRawString(this.strings[i]);
    }
    const headerPart = strTableWriter.getWrittenSlice();
    const bodyPart = this.buf.subarray(0, this.pos);
    const out = Buffer.allocUnsafe(headerPart.length + bodyPart.length);
    headerPart.copy(out, 0);
    bodyPart.copy(out, headerPart.length);
    return out;
  }

  public getWrittenSlice(): Buffer {
    return this.buf.subarray(0, this.pos);
  }
}

class BinaryReader {
  private pos = 0;
  private strings: string[] = [];

  public constructor(private readonly buf: Uint8Array) {}

  public loadStringTable(): void {
    const count = this.readVarUint();
    const list: string[] = new Array(count);
    for (let i = 0; i < count; i++) {
      const len = this.readVarUint();
      if (this.pos + len > this.buf.length) {
        throw new Error('Corrupt string table in trace page');
      }
      list[i] = textDecoder.decode(this.buf.subarray(this.pos, this.pos + len));
      this.pos += len;
    }
    this.strings = list;
  }

  public readU8(): number {
    if (this.pos >= this.buf.length) {
      throw new Error('Unexpected EOF reading U8');
    }
    return this.buf[this.pos++];
  }

  public readU32(): number {
    if (this.pos + 4 > this.buf.length) {
      throw new Error('Unexpected EOF reading U32');
    }
    const v =
      (this.buf[this.pos] |
        (this.buf[this.pos + 1] << 8) |
        (this.buf[this.pos + 2] << 16) |
        (this.buf[this.pos + 3] << 24)) >>>
      0;
    this.pos += 4;
    return v;
  }

  public readF64(): number {
    if (this.pos + 8 > this.buf.length) {
      throw new Error('Unexpected EOF reading F64');
    }
    const dv = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 8);
    this.pos += 8;
    return dv.getFloat64(0, true);
  }

  public readVarUint(): number {
    let result = 0;
    let shift = 0;
    while (true) {
      if (this.pos >= this.buf.length) {
        throw new Error('Unexpected EOF reading varuint');
      }
      const b = this.buf[this.pos++];
      result |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) {
        return result >>> 0;
      }
      shift += 7;
      if (shift > 35) {
        throw new Error('Corrupt varuint in trace page');
      }
    }
  }

  public readBigInt(): bigint {
    const tag = this.readU8();
    if (tag === 0) {
      return 0n;
    }
    const negative = (tag & 0x80) !== 0;
    const byteLen = tag & 0x7f;
    if (this.pos + byteLen > this.buf.length) {
      throw new Error('Unexpected EOF reading BigInt');
    }
    let mag = 0n;
    for (let i = byteLen - 1; i >= 0; i--) {
      mag = (mag << 8n) | BigInt(this.buf[this.pos + i]);
    }
    this.pos += byteLen;
    return negative ? -mag : mag;
  }

  public readInternedString(): string {
    const id = this.readVarUint();
    if (id >= this.strings.length) {
      throw new Error(`Invalid interned string id ${id}`);
    }
    return this.strings[id];
  }

  public readOptionalInternedString(): string | undefined {
    const id = this.readVarUint();
    if (id === 0) {
      return undefined;
    }
    const idx = id - 1;
    if (idx >= this.strings.length) {
      throw new Error(`Invalid optional interned string id ${idx}`);
    }
    return this.strings[idx];
  }

  public readBytes(): Uint8Array {
    const len = this.readVarUint();
    if (this.pos + len > this.buf.length) {
      throw new Error('Unexpected EOF reading byte array');
    }
    const out = new Uint8Array(len);
    out.set(this.buf.subarray(this.pos, this.pos + len));
    this.pos += len;
    return out;
  }

  public readTagValue(): unknown {
    const tag = this.readU8();
    switch (tag) {
      case 0:
        return undefined;
      case 1:
        return null;
      case 2:
        return true;
      case 3:
        return false;
      case 4:
        return this.readVarUint();
      case 5:
        return this.readF64();
      case 6:
        return this.readBigInt();
      case 7:
        return this.readInternedString();
      case 8:
        return this.readBytes();
      case 9: {
        const len = this.readVarUint();
        const arr = new Array(len);
        for (let i = 0; i < len; i++) {
          arr[i] = this.readTagValue();
        }
        return arr;
      }
      case 10: {
        const len = this.readVarUint();
        const obj: Record<string, unknown> = {};
        for (let i = 0; i < len; i++) {
          const k = this.readInternedString();
          obj[k] = this.readTagValue();
        }
        return obj;
      }
      default:
        throw new Error(`Unknown binary tag ${tag}`);
    }
  }
}

const RELIABILITY_TO_CODE: Record<SegmentReliability, number> = {
  trusted: 0,
  uncertain: 1,
};
const CODE_TO_RELIABILITY: SegmentReliability[] = ['trusted', 'uncertain'];

const ANCHOR_TO_CODE: Record<TimeAnchorStatus, number> = {
  unanchored: 0,
  'anchored-cycles': 1,
  'anchored-systime-us': 2,
  uncertain: 3,
};
const CODE_TO_ANCHOR: TimeAnchorStatus[] = ['unanchored', 'anchored-cycles', 'anchored-systime-us', 'uncertain'];

const COMPLETENESS_TO_CODE: Record<'complete' | 'incomplete' | 'uncertain', number> = {
  complete: 0,
  incomplete: 1,
  uncertain: 2,
};
const CODE_TO_COMPLETENESS: ('complete' | 'incomplete' | 'uncertain')[] = ['complete', 'incomplete', 'uncertain'];

const TIME_DOMAIN_TO_CODE: Record<'anchored-ticks' | 'segment-relative-ticks' | 'unknown', number> = {
  'anchored-ticks': 0,
  'segment-relative-ticks': 1,
  unknown: 2,
};
const CODE_TO_TIME_DOMAIN: ('anchored-ticks' | 'segment-relative-ticks' | 'unknown')[] = [
  'anchored-ticks',
  'segment-relative-ticks',
  'unknown',
];

function writeOptionalBigInt(w: BinaryWriter, v: bigint | undefined): void {
  if (v === undefined) {
    w.writeU8(0);
  } else {
    w.writeU8(1);
    w.writeBigInt(v);
  }
}

function readOptionalBigInt(r: BinaryReader): bigint | undefined {
  const present = r.readU8();
  return present === 0 ? undefined : r.readBigInt();
}

function writeOptionalVarUint(w: BinaryWriter, v: number | undefined): void {
  if (v === undefined) {
    w.writeU8(0);
  } else {
    w.writeU8(1);
    w.writeVarUint(v);
  }
}

function readOptionalVarUint(r: BinaryReader): number | undefined {
  const present = r.readU8();
  return present === 0 ? undefined : r.readVarUint();
}

function writeTimePoint(w: BinaryWriter, p: TraceTimePoint): void {
  w.writeVarUint(p.segmentId);
  w.writeVarUint(p.packetIndexInSegment);
  w.writeVarUint(p.streamByteOffset);
  w.writeBigInt(p.relativeTicksBigInt);
  writeOptionalBigInt(w, p.absoluteTicksBigInt);
  w.writeU8(ANCHOR_TO_CODE[p.timeAnchorStatus]);
  writeOptionalVarUint(w, p.sysFreqHz);
  w.writeOptionalInternedString(p.timestampNs);
}

function readTimePoint(r: BinaryReader): TraceTimePoint {
  const segmentId = r.readVarUint();
  const packetIndexInSegment = r.readVarUint();
  const streamByteOffset = r.readVarUint();
  const relativeTicksBigInt = r.readBigInt();
  const absoluteTicksBigInt = readOptionalBigInt(r);
  const timeAnchorStatus = CODE_TO_ANCHOR[r.readU8()] ?? 'uncertain';
  const sysFreqHz = readOptionalVarUint(r);
  const timestampNs = r.readOptionalInternedString();
  return {
    segmentId,
    packetIndexInSegment,
    streamByteOffset,
    relativeTicks: relativeTicksBigInt.toString(),
    relativeTicksBigInt,
    absoluteTicks: absoluteTicksBigInt?.toString(),
    absoluteTicksBigInt,
    timeAnchorStatus,
    sysFreqHz,
    timestampNs,
  };
}

function writeOptionalTimePoint(w: BinaryWriter, p: TraceTimePoint | undefined): void {
  if (p === undefined) {
    w.writeU8(0);
  } else {
    w.writeU8(1);
    writeTimePoint(w, p);
  }
}

function readOptionalTimePoint(r: BinaryReader): TraceTimePoint | undefined {
  return r.readU8() === 0 ? undefined : readTimePoint(r);
}

function writePacket(w: BinaryWriter, pkt: DecodedSystemViewPacket): void {
  w.writeVarUint(pkt.segmentId);
  w.writeVarUint(pkt.packetIndexInSegment);
  w.writeVarUint(pkt.streamByteOffset);
  w.writeVarUint(pkt.byteLength);
  w.writeVarUint(pkt.eventId);
  w.writeInternedString(pkt.eventName);
  w.writeInternedString(pkt.category);
  w.writeInternedString(pkt.schemaReliability);
  w.writeU8(RELIABILITY_TO_CODE[pkt.segmentReliability]);
  w.writeVarUint(pkt.deltaTicks);
  w.writeBigInt(pkt.segmentRelativeTicksBigInt);
  writeOptionalBigInt(w, pkt.absoluteTicksBigInt);
  writeOptionalVarUint(w, pkt.rawTimestampMod);
  w.writeU8((pkt.timestampWrapped ? 1 : 0) | (ANCHOR_TO_CODE[pkt.timeAnchorStatus] << 1));
  writeOptionalVarUint(w, pkt.sysFreqHz);
  if (pkt.timestampUs === undefined) {
    w.writeU8(0);
  } else {
    w.writeU8(1);
    w.writeF64(pkt.timestampUs);
  }
  w.writeOptionalInternedString(pkt.timestampNs);
  w.writeTagValue(pkt.decoded);
}

function readPacket(r: BinaryReader): DecodedSystemViewPacket {
  const segmentId = r.readVarUint();
  const packetIndexInSegment = r.readVarUint();
  const streamByteOffset = r.readVarUint();
  const byteLength = r.readVarUint();
  const eventId = r.readVarUint();
  const eventName = r.readInternedString();
  const category = r.readInternedString() as DecodedSystemViewPacket['category'];
  const schemaReliability = r.readInternedString() as DecodedSystemViewPacket['schemaReliability'];
  const segmentReliability = CODE_TO_RELIABILITY[r.readU8()] ?? 'uncertain';
  const deltaTicks = r.readVarUint();
  const segmentRelativeTicksBigInt = r.readBigInt();
  const absoluteTicksBigInt = readOptionalBigInt(r);
  const rawTimestampMod = readOptionalVarUint(r);
  const flags = r.readU8();
  const timestampWrapped = (flags & 1) !== 0;
  const timeAnchorStatus = CODE_TO_ANCHOR[(flags >>> 1) & 0x03] ?? 'uncertain';
  const sysFreqHz = readOptionalVarUint(r);
  const timestampUs = r.readU8() === 0 ? undefined : r.readF64();
  const timestampNs = r.readOptionalInternedString();
  const decoded = r.readTagValue() as DecodedEventPayload;
  return {
    protocolVersion: SYSTEMVIEW_PROTOCOL_VERSION,
    segmentId,
    packetIndexInSegment,
    streamByteOffset,
    byteLength,
    eventId,
    eventName,
    category,
    schemaReliability,
    segmentReliability,
    deltaTicks,
    segmentRelativeTicks: segmentRelativeTicksBigInt.toString(),
    segmentRelativeTicksBigInt,
    absoluteTicks: absoluteTicksBigInt?.toString(),
    absoluteTicksBigInt,
    rawTimestampMod,
    timestampWrapped,
    timeAnchorStatus,
    sysFreqHz,
    timestampUs,
    timestampNs,
    decoded,
  };
}

function writeSlice(w: BinaryWriter, s: ExecutionSliceInterval): void {
  w.writeInternedString(s.sliceId);
  w.writeVarUint(s.bootGeneration);
  w.writeVarUint(s.segmentId);
  w.writeU8(
    RELIABILITY_TO_CODE[s.segmentReliability] |
      (COMPLETENESS_TO_CODE[s.completeness] << 1) |
      (TIME_DOMAIN_TO_CODE[s.timeDomain] << 3),
  );
  w.writeInternedString(s.contextKind);
  w.writeInternedString(s.contextKey);
  w.writeOptionalInternedString(s.taskInstanceId);
  writeOptionalVarUint(w, s.tcbAddress);
  writeOptionalVarUint(w, s.shrunkTaskId);
  writeOptionalVarUint(w, s.taskGeneration);
  writeOptionalVarUint(w, s.irqId);
  w.writeVarUint(s.isrDepth);
  w.writeOptionalInternedString(s.label);
  w.writeInternedString(s.labelSource);
  writeOptionalTimePoint(w, s.start);
  writeOptionalTimePoint(w, s.end);
  writeOptionalTimePoint(w, s.observedUntil);
  writeOptionalBigInt(w, s.durationTicksBigInt);
  w.writeOptionalInternedString(s.durationNs);
  w.writeInternedString(s.startReason);
  w.writeOptionalInternedString(s.endReason);
}

function readSlice(r: BinaryReader): ExecutionSliceInterval {
  const sliceId = r.readInternedString();
  const bootGeneration = r.readVarUint();
  const segmentId = r.readVarUint();
  const flags = r.readU8();
  const segmentReliability = CODE_TO_RELIABILITY[flags & 1] ?? 'uncertain';
  const completeness = CODE_TO_COMPLETENESS[(flags >>> 1) & 3] ?? 'incomplete';
  const timeDomain = CODE_TO_TIME_DOMAIN[(flags >>> 3) & 3] ?? 'unknown';
  const contextKind = r.readInternedString() as ExecutionSliceInterval['contextKind'];
  const contextKey = r.readInternedString();
  const taskInstanceId = r.readOptionalInternedString();
  const tcbAddress = readOptionalVarUint(r);
  const shrunkTaskId = readOptionalVarUint(r);
  const taskGeneration = readOptionalVarUint(r);
  const irqId = readOptionalVarUint(r);
  const isrDepth = r.readVarUint();
  const label = r.readOptionalInternedString();
  const labelSource = r.readInternedString() as ExecutionSliceInterval['labelSource'];
  const start = readOptionalTimePoint(r);
  const end = readOptionalTimePoint(r);
  const observedUntil = readOptionalTimePoint(r);
  const durationTicksBigInt = readOptionalBigInt(r);
  const durationNs = r.readOptionalInternedString();
  const startReason = r.readInternedString();
  const endReason = r.readOptionalInternedString();
  return {
    sliceId,
    bootGeneration,
    segmentId,
    segmentReliability,
    completeness,
    contextKind,
    contextKey,
    taskInstanceId,
    tcbAddress,
    shrunkTaskId,
    taskGeneration,
    irqId,
    isrDepth,
    label,
    labelSource,
    start,
    end,
    observedUntil,
    durationTicks: durationTicksBigInt?.toString(),
    durationTicksBigInt,
    durationNs,
    timeDomain,
    startReason,
    endReason,
  };
}

function writeActivation(w: BinaryWriter, a: ContextActivationInterval): void {
  w.writeInternedString(a.activationId);
  w.writeVarUint(a.bootGeneration);
  w.writeVarUint(a.segmentId);
  w.writeU8(
    RELIABILITY_TO_CODE[a.segmentReliability] |
      (COMPLETENESS_TO_CODE[a.completeness] << 1) |
      (TIME_DOMAIN_TO_CODE[a.timeDomain] << 3),
  );
  w.writeInternedString(a.kind);
  w.writeInternedString(a.contextKey);
  w.writeOptionalInternedString(a.taskInstanceId);
  writeOptionalVarUint(w, a.tcbAddress);
  writeOptionalVarUint(w, a.shrunkTaskId);
  writeOptionalVarUint(w, a.taskGeneration);
  writeOptionalVarUint(w, a.irqId);
  writeOptionalVarUint(w, a.isrDepth);
  writeOptionalVarUint(w, a.timerId);
  writeOptionalVarUint(w, a.shrunkTimerId);
  w.writeOptionalInternedString(a.label);
  w.writeInternedString(a.labelSource);
  writeOptionalTimePoint(w, a.start);
  writeOptionalTimePoint(w, a.end);
  writeOptionalTimePoint(w, a.observedUntil);
  writeOptionalBigInt(w, a.inclusiveDurationTicksBigInt);
  writeOptionalBigInt(w, a.exclusiveDurationTicksBigInt);
  writeOptionalBigInt(w, a.preemptedDurationTicksBigInt);
  w.writeOptionalInternedString(a.inclusiveDurationNs);
  w.writeOptionalInternedString(a.exclusiveDurationNs);
  w.writeVarUint(a.preemptionCount);
  w.writeOptionalInternedString(a.readyChainStatus);
  w.writeOptionalInternedString(a.matchedReadyWaitId);
  w.writeOptionalInternedString(a.endReason);
}

function readActivation(r: BinaryReader): ContextActivationInterval {
  const activationId = r.readInternedString();
  const bootGeneration = r.readVarUint();
  const segmentId = r.readVarUint();
  const flags = r.readU8();
  const segmentReliability = CODE_TO_RELIABILITY[flags & 1] ?? 'uncertain';
  const completeness = CODE_TO_COMPLETENESS[(flags >>> 1) & 3] ?? 'incomplete';
  const timeDomain = CODE_TO_TIME_DOMAIN[(flags >>> 3) & 3] ?? 'unknown';
  const kind = r.readInternedString() as ContextActivationInterval['kind'];
  const contextKey = r.readInternedString();
  const taskInstanceId = r.readOptionalInternedString();
  const tcbAddress = readOptionalVarUint(r);
  const shrunkTaskId = readOptionalVarUint(r);
  const taskGeneration = readOptionalVarUint(r);
  const irqId = readOptionalVarUint(r);
  const isrDepth = readOptionalVarUint(r);
  const timerId = readOptionalVarUint(r);
  const shrunkTimerId = readOptionalVarUint(r);
  const label = r.readOptionalInternedString();
  const labelSource = r.readInternedString() as ContextActivationInterval['labelSource'];
  const start = readOptionalTimePoint(r);
  const end = readOptionalTimePoint(r);
  const observedUntil = readOptionalTimePoint(r);
  const inclusiveDurationTicksBigInt = readOptionalBigInt(r);
  const exclusiveDurationTicksBigInt = readOptionalBigInt(r);
  const preemptedDurationTicksBigInt = readOptionalBigInt(r);
  const inclusiveDurationNs = r.readOptionalInternedString();
  const exclusiveDurationNs = r.readOptionalInternedString();
  const preemptionCount = r.readVarUint();
  const readyChainStatus = r.readOptionalInternedString() as ContextActivationInterval['readyChainStatus'];
  const matchedReadyWaitId = r.readOptionalInternedString();
  const endReason = r.readOptionalInternedString();
  return {
    activationId,
    bootGeneration,
    segmentId,
    segmentReliability,
    completeness,
    kind,
    contextKey,
    taskInstanceId,
    tcbAddress,
    shrunkTaskId,
    taskGeneration,
    irqId,
    isrDepth,
    timerId,
    shrunkTimerId,
    label,
    labelSource,
    start,
    end,
    observedUntil,
    inclusiveDurationTicks: inclusiveDurationTicksBigInt?.toString(),
    inclusiveDurationTicksBigInt,
    exclusiveDurationTicks: exclusiveDurationTicksBigInt?.toString(),
    exclusiveDurationTicksBigInt,
    preemptedDurationTicks: preemptedDurationTicksBigInt?.toString(),
    preemptedDurationTicksBigInt,
    inclusiveDurationNs,
    exclusiveDurationNs,
    preemptionCount,
    readyChainStatus,
    matchedReadyWaitId,
    timeDomain,
    endReason,
  };
}

function writeReadyWait(w: BinaryWriter, rw: ReadyWaitInterval): void {
  w.writeInternedString(rw.waitId);
  w.writeVarUint(rw.bootGeneration);
  w.writeVarUint(rw.segmentId);
  w.writeU8(
    RELIABILITY_TO_CODE[rw.segmentReliability] |
      (COMPLETENESS_TO_CODE[rw.completeness] << 1) |
      (TIME_DOMAIN_TO_CODE[rw.timeDomain] << 3),
  );
  w.writeInternedString(rw.outcome);
  w.writeInternedString(rw.taskInstanceId);
  writeOptionalVarUint(w, rw.tcbAddress);
  writeOptionalVarUint(w, rw.shrunkTaskId);
  w.writeVarUint(rw.taskGeneration);
  w.writeOptionalInternedString(rw.label);
  w.writeInternedString(rw.labelSource);
  writeOptionalTimePoint(w, rw.start);
  writeOptionalTimePoint(w, rw.end);
  writeOptionalTimePoint(w, rw.observedUntil);
  writeOptionalBigInt(w, rw.durationTicksBigInt);
  w.writeOptionalInternedString(rw.durationNs);
  writeOptionalBigInt(w, rw.readyToRunningTicksBigInt);
  writeOptionalVarUint(w, rw.stopCause);
  w.writeOptionalInternedString(rw.endReason);
}

function readReadyWait(r: BinaryReader): ReadyWaitInterval {
  const waitId = r.readInternedString();
  const bootGeneration = r.readVarUint();
  const segmentId = r.readVarUint();
  const flags = r.readU8();
  const segmentReliability = CODE_TO_RELIABILITY[flags & 1] ?? 'uncertain';
  const completeness = CODE_TO_COMPLETENESS[(flags >>> 1) & 3] ?? 'incomplete';
  const timeDomain = CODE_TO_TIME_DOMAIN[(flags >>> 3) & 3] ?? 'unknown';
  const outcome = r.readInternedString() as ReadyWaitInterval['outcome'];
  const taskInstanceId = r.readInternedString();
  const tcbAddress = readOptionalVarUint(r);
  const shrunkTaskId = readOptionalVarUint(r);
  const taskGeneration = r.readVarUint();
  const label = r.readOptionalInternedString();
  const labelSource = r.readInternedString() as ReadyWaitInterval['labelSource'];
  const start = readOptionalTimePoint(r);
  const end = readOptionalTimePoint(r);
  const observedUntil = readOptionalTimePoint(r);
  const durationTicksBigInt = readOptionalBigInt(r);
  const durationNs = r.readOptionalInternedString();
  const readyToRunningTicksBigInt = readOptionalBigInt(r);
  const stopCause = readOptionalVarUint(r);
  const endReason = r.readOptionalInternedString();
  return {
    waitId,
    bootGeneration,
    segmentId,
    segmentReliability,
    completeness,
    outcome,
    taskInstanceId,
    tcbAddress,
    shrunkTaskId,
    taskGeneration,
    label,
    labelSource,
    start,
    end,
    observedUntil,
    durationTicks: durationTicksBigInt?.toString(),
    durationTicksBigInt,
    durationNs,
    readyToRunningTicks: readyToRunningTicksBigInt?.toString(),
    readyToRunningTicksBigInt,
    stopCause,
    timeDomain,
    endReason,
  };
}

function writeMarker(w: BinaryWriter, m: MarkerInterval): void {
  w.writeInternedString(m.markerInstanceId);
  w.writeVarUint(m.bootGeneration);
  w.writeVarUint(m.segmentId);
  w.writeU8(
    RELIABILITY_TO_CODE[m.segmentReliability] |
      (COMPLETENESS_TO_CODE[m.completeness] << 1) |
      (TIME_DOMAIN_TO_CODE[m.timeDomain] << 3),
  );
  w.writeVarUint(m.markerId);
  w.writeOptionalInternedString(m.name);
  w.writeInternedString(m.nameSource);
  writeOptionalTimePoint(w, m.start);
  writeOptionalTimePoint(w, m.end);
  writeOptionalTimePoint(w, m.observedUntil);
  writeOptionalBigInt(w, m.durationTicksBigInt);
  w.writeOptionalInternedString(m.durationNs);
  w.writeOptionalInternedString(m.startContextKey);
  w.writeOptionalInternedString(m.endContextKey);
  w.writeOptionalInternedString(m.endReason);
}

function readMarker(r: BinaryReader): MarkerInterval {
  const markerInstanceId = r.readInternedString();
  const bootGeneration = r.readVarUint();
  const segmentId = r.readVarUint();
  const flags = r.readU8();
  const segmentReliability = CODE_TO_RELIABILITY[flags & 1] ?? 'uncertain';
  const completeness = CODE_TO_COMPLETENESS[(flags >>> 1) & 3] ?? 'incomplete';
  const timeDomain = CODE_TO_TIME_DOMAIN[(flags >>> 3) & 3] ?? 'unknown';
  const markerId = r.readVarUint();
  const name = r.readOptionalInternedString();
  const nameSource = r.readInternedString() as MarkerInterval['nameSource'];
  const start = readOptionalTimePoint(r);
  const end = readOptionalTimePoint(r);
  const observedUntil = readOptionalTimePoint(r);
  const durationTicksBigInt = readOptionalBigInt(r);
  const durationNs = r.readOptionalInternedString();
  const startContextKey = r.readOptionalInternedString();
  const endContextKey = r.readOptionalInternedString();
  const endReason = r.readOptionalInternedString();
  return {
    markerInstanceId,
    bootGeneration,
    segmentId,
    segmentReliability,
    completeness,
    markerId,
    name,
    nameSource,
    start,
    end,
    observedUntil,
    durationTicks: durationTicksBigInt?.toString(),
    durationTicksBigInt,
    durationNs,
    startContextKey,
    endContextKey,
    timeDomain,
    endReason,
  };
}

function writeMarkerPoint(w: BinaryWriter, mp: MarkerPointEvent): void {
  w.writeVarUint(mp.bootGeneration);
  w.writeVarUint(mp.segmentId);
  w.writeU8(RELIABILITY_TO_CODE[mp.segmentReliability]);
  w.writeVarUint(mp.markerId);
  w.writeOptionalInternedString(mp.name);
  w.writeInternedString(mp.nameSource);
  writeTimePoint(w, mp.time);
  w.writeOptionalInternedString(mp.contextKey);
}

function readMarkerPoint(r: BinaryReader): MarkerPointEvent {
  const bootGeneration = r.readVarUint();
  const segmentId = r.readVarUint();
  const segmentReliability = CODE_TO_RELIABILITY[r.readU8()] ?? 'uncertain';
  const markerId = r.readVarUint();
  const name = r.readOptionalInternedString();
  const nameSource = r.readInternedString() as MarkerPointEvent['nameSource'];
  const time = readTimePoint(r);
  const contextKey = r.readOptionalInternedString();
  return {
    bootGeneration,
    segmentId,
    segmentReliability,
    markerId,
    name,
    nameSource,
    time,
    contextKey,
  };
}

export type TracePageItems =
  | readonly DecodedSystemViewPacket[]
  | readonly ExecutionSliceInterval[]
  | readonly ContextActivationInterval[]
  | readonly ReadyWaitInterval[]
  | readonly MarkerInterval[]
  | readonly MarkerPointEvent[];

export interface EncodedTracePage {
  readonly buffer: Buffer;
  readonly payloadCrc32: number;
  readonly pageCrc32: number;
}

export function encodeTraceDataPage(
  kind: TracePageKind,
  bootGeneration: number,
  segmentId: number,
  items: TracePageItems,
  flags = 0,
): EncodedTracePage {
  const writer = new BinaryWriter(Math.max(4096, items.length * 48));
  switch (kind) {
    case 'packets':
      for (const item of items as readonly DecodedSystemViewPacket[]) writePacket(writer, item);
      break;
    case 'slices':
    case 'longSlices':
      for (const item of items as readonly ExecutionSliceInterval[]) writeSlice(writer, item);
      break;
    case 'activations':
    case 'longActivations':
      for (const item of items as readonly ContextActivationInterval[]) writeActivation(writer, item);
      break;
    case 'readyWaits':
    case 'longReadyWaits':
      for (const item of items as readonly ReadyWaitInterval[]) writeReadyWait(writer, item);
      break;
    case 'markers':
    case 'longMarkers':
      for (const item of items as readonly MarkerInterval[]) writeMarker(writer, item);
      break;
    case 'markerPoints':
      for (const item of items as readonly MarkerPointEvent[]) writeMarkerPoint(writer, item);
      break;
  }

  const payload = writer.finalizeWithStringTable();
  if (payload.length > MAX_DATA_PAGE_PAYLOAD_BYTES) {
    throw new RangeError(`Encoded page payload ${payload.length} exceeds limit ${MAX_DATA_PAGE_PAYLOAD_BYTES}`);
  }
  const payloadCrc32 = computeCrc32(payload);
  const pageBuf = Buffer.allocUnsafe(OTD_HEADER_BYTES + payload.length);

  pageBuf.writeUInt32LE(OTD_MAGIC, 0);
  pageBuf.writeUInt16LE(ORBIT_TRACE_FORMAT_VERSION, 4);
  pageBuf.writeUInt16LE(TRACE_PAGE_KIND_TO_CODE[kind], 6);
  pageBuf.writeUInt32LE(items.length >>> 0, 8);
  pageBuf.writeUInt32LE(segmentId >>> 0, 12);
  pageBuf.writeUInt32LE(bootGeneration >>> 0, 16);
  pageBuf.writeUInt32LE(flags >>> 0, 20);
  pageBuf.writeUInt32LE(payload.length >>> 0, 24);
  pageBuf.writeUInt32LE(payloadCrc32 >>> 0, 28);
  payload.copy(pageBuf, OTD_HEADER_BYTES);

  return {
    buffer: pageBuf,
    payloadCrc32,
    pageCrc32: computeCrc32(pageBuf),
  };
}

export interface DecodedTracePage {
  readonly kind: TracePageKind;
  readonly bootGeneration: number;
  readonly segmentId: number;
  readonly flags: number;
  readonly items: TracePageItems;
}

export function decodeTraceDataPage(buf: Uint8Array, expectedPageCrc32?: number): DecodedTracePage {
  if (buf.length < OTD_HEADER_BYTES) {
    throw new Error(`Truncated OTD1 page header: ${buf.length} bytes`);
  }
  if (expectedPageCrc32 !== undefined) {
    const actualPageCrc = computeCrc32(buf);
    if (actualPageCrc !== expectedPageCrc32) {
      throw new Error(`Page CRC32 mismatch: expected=0x${expectedPageCrc32.toString(16)}, actual=0x${actualPageCrc.toString(16)}`);
    }
  }
  const view = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  const magic = view.readUInt32LE(0);
  if (magic !== OTD_MAGIC) {
    throw new Error(`Invalid OTD1 magic: 0x${magic.toString(16)}`);
  }
  const version = view.readUInt16LE(4);
  if (version !== ORBIT_TRACE_FORMAT_VERSION) {
    throw new Error(`Unsupported OTD1 version: ${version}`);
  }
  const kindCode = view.readUInt16LE(6);
  const kind = CODE_TO_TRACE_PAGE_KIND[kindCode];
  if (!kind) {
    throw new Error(`Unknown OTD1 page kind code: ${kindCode}`);
  }
  const itemCount = view.readUInt32LE(8);
  const segmentId = view.readUInt32LE(12);
  const bootGeneration = view.readUInt32LE(16);
  const flags = view.readUInt32LE(20);
  const payloadLength = view.readUInt32LE(24);
  const expectedPayloadCrc = view.readUInt32LE(28);
  if (OTD_HEADER_BYTES + payloadLength !== buf.length) {
    throw new Error(`OTD1 page length mismatch: header declares ${OTD_HEADER_BYTES + payloadLength}, got ${buf.length}`);
  }
  const payload = buf.subarray(OTD_HEADER_BYTES);
  const actualPayloadCrc = computeCrc32(payload);
  if (actualPayloadCrc !== expectedPayloadCrc) {
    throw new Error(
      `OTD1 payload CRC32 mismatch: expected=0x${expectedPayloadCrc.toString(16)}, actual=0x${actualPayloadCrc.toString(16)}`,
    );
  }

  const reader = new BinaryReader(payload);
  reader.loadStringTable();

  const items: unknown[] = new Array(itemCount);
  switch (kind) {
    case 'packets':
      for (let i = 0; i < itemCount; i++) items[i] = readPacket(reader);
      break;
    case 'slices':
    case 'longSlices':
      for (let i = 0; i < itemCount; i++) items[i] = readSlice(reader);
      break;
    case 'activations':
    case 'longActivations':
      for (let i = 0; i < itemCount; i++) items[i] = readActivation(reader);
      break;
    case 'readyWaits':
    case 'longReadyWaits':
      for (let i = 0; i < itemCount; i++) items[i] = readReadyWait(reader);
      break;
    case 'markers':
    case 'longMarkers':
      for (let i = 0; i < itemCount; i++) items[i] = readMarker(reader);
      break;
    case 'markerPoints':
      for (let i = 0; i < itemCount; i++) items[i] = readMarkerPoint(reader);
      break;
  }

  return {
    kind,
    bootGeneration,
    segmentId,
    flags,
    items: items as TracePageItems,
  };
}

// ---------------------------------------------------------------------------
// Index Snapshot Codec (OTI1)
// ---------------------------------------------------------------------------

export interface PersistedIndexSnapshot {
  readonly format: typeof ORBIT_TRACE_FORMAT;
  readonly formatVersion: typeof ORBIT_TRACE_FORMAT_VERSION;
  readonly segments: readonly SegmentIndexMetadata[];
  readonly pages: readonly IndexedPageDescriptor[];
  readonly gaps: readonly StoredGapEntry[];
  readonly tasks: readonly TaskInstanceSummary[];
}

export function encodeIndexSnapshot(snapshot: PersistedIndexSnapshot): Buffer {
  const payload = Buffer.from(safeTraceJsonStringify(snapshot), 'utf8');
  const crc = computeCrc32(payload);
  const out = Buffer.allocUnsafe(OTI_HEADER_BYTES + payload.length);
  out.writeUInt32LE(OTI_MAGIC, 0);
  out.writeUInt16LE(ORBIT_TRACE_FORMAT_VERSION, 4);
  out.writeUInt16LE(0, 6);
  out.writeUInt32LE(payload.length >>> 0, 8);
  out.writeUInt32LE(crc >>> 0, 12);
  payload.copy(out, OTI_HEADER_BYTES);
  return out;
}

export function decodeIndexSnapshot(buf: Uint8Array): PersistedIndexSnapshot {
  if (buf.length < OTI_HEADER_BYTES) {
    throw new Error(`Truncated OTI1 index snapshot: ${buf.length} bytes`);
  }
  const view = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (view.readUInt32LE(0) !== OTI_MAGIC) {
    throw new Error('Invalid OTI1 index magic');
  }
  if (view.readUInt16LE(4) !== ORBIT_TRACE_FORMAT_VERSION) {
    throw new Error('Unsupported OTI1 index version');
  }
  const len = view.readUInt32LE(8);
  const crc = view.readUInt32LE(12);
  if (OTI_HEADER_BYTES + len !== buf.length) {
    throw new Error('OTI1 index snapshot length mismatch');
  }
  const payload = buf.subarray(OTI_HEADER_BYTES);
  if (computeCrc32(payload) !== crc) {
    throw new Error('OTI1 index snapshot CRC32 mismatch');
  }
  const parsed = JSON.parse(textDecoder.decode(payload)) as PersistedIndexSnapshot;
  const restorePoint = (pt: any) => {
    if (!pt || typeof pt !== 'object') return pt;
    return {
      ...pt,
      relativeTicksBigInt: typeof pt.relativeTicks === 'string' ? BigInt(pt.relativeTicks) : pt.relativeTicksBigInt,
      absoluteTicksBigInt:
        typeof pt.absoluteTicks === 'string' ? BigInt(pt.absoluteTicks) : pt.absoluteTicksBigInt,
    };
  };
  return {
    ...parsed,
    tasks: Array.isArray(parsed.tasks)
      ? parsed.tasks.map((t) => ({
          ...t,
          createdAt: restorePoint(t.createdAt),
          terminatedAt: restorePoint(t.terminatedAt),
        }))
      : [],
  };
}

// ---------------------------------------------------------------------------
// Recording Inspection, Commit Verification & Recovery Boundary Detection
// ---------------------------------------------------------------------------

async function readExactFromHandle(
  handle: TraceFileHandle,
  position: number,
  length: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (length === 0) {
    return { bytes: new Uint8Array(0), truncated: false };
  }
  const buf = Buffer.allocUnsafe(length);
  let totalRead = 0;
  while (totalRead < length) {
    const res = await handle.read(buf, totalRead, length - totalRead, position + totalRead);
    if (res.bytesRead === 0) {
      return { bytes: buf.subarray(0, totalRead), truncated: true };
    }
    totalRead += res.bytesRead;
  }
  return { bytes: buf, truncated: false };
}

async function computeCrc32FromHandle(
  handle: TraceFileHandle,
  position: number,
  length: number,
): Promise<{ ok: true; crc32: number } | { ok: false; truncated: boolean }> {
  const chunkBuf = Buffer.allocUnsafe(Math.min(65536, Math.max(1, length)));
  let remaining = length;
  let offset = position;
  let crc = 0;
  while (remaining > 0) {
    const toRead = Math.min(remaining, chunkBuf.length);
    const res = await handle.read(chunkBuf, 0, toRead, offset);
    if (res.bytesRead === 0) {
      return { ok: false, truncated: true };
    }
    crc = computeCrc32(chunkBuf.subarray(0, res.bytesRead), crc);
    offset += res.bytesRead;
    remaining -= res.bytesRead;
  }
  return { ok: true, crc32: crc };
}

async function computeSha256FromHandle(handle: TraceFileHandle, length: number): Promise<string> {
  const hash = createHash('sha256');
  const buf = Buffer.allocUnsafe(65536);
  let offset = 0;
  while (offset < length) {
    const toRead = Math.min(buf.length, length - offset);
    const res = await handle.read(buf, 0, toRead, offset);
    if (res.bytesRead === 0) {
      throw new Error(`Unexpected EOF computing SHA256 at offset ${offset} < ${length}`);
    }
    hash.update(buf.subarray(0, res.bytesRead));
    offset += res.bytesRead;
  }
  return hash.digest('hex');
}

/**
 * 核对磁盘上的 `orbit-trace-v1` 录制目录：
 * - 严格按 `journal.otj` 帧校验有效提交边界，并交叉校验 `raw.otbin` 与 `data.otd` 的长度与 CRC32；
 * - 区分 `completed`（含 `CLEAN_CLOSE` 且 SHA256 与提交长度一致）、`interrupted`（未完整关闭或尾部存在未提交截断）、
 *   `failed`（记录了写入失败/ENOSPC 但前缀有效）和 `corrupted`（已提交区域校验失败或结构篡改）。
 */
export async function inspectRecordingDirectory(
  recordingDir: string,
  fileSystem: TraceFileSystem = defaultTraceFileSystem,
  options: { verifyRawSha256?: boolean } = {},
): Promise<RecordingInspectionResult> {
  const diagnostics: RecordingDiagnostic[] = [];
  const manifestPath = path.join(recordingDir, ORBIT_TRACE_FILES.manifest);
  const rawPath = path.join(recordingDir, ORBIT_TRACE_FILES.raw);
  const dataPath = path.join(recordingDir, ORBIT_TRACE_FILES.data);
  const journalPath = path.join(recordingDir, ORBIT_TRACE_FILES.journal);

  let manifest: TraceRecordingManifest | undefined;
  let manifestCorrupt = false;
  let detectedFormat: string | undefined;
  let detectedFormatVersion: number | undefined;
  if (await fileSystem.exists(manifestPath)) {
    try {
      const rawText = Buffer.from(await fileSystem.readFile(manifestPath)).toString('utf8');
      const parsed = JSON.parse(rawText) as Partial<TraceRecordingManifest> | null;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        manifestCorrupt = true;
        diagnostics.push({
          code: 'corrupt-manifest',
          file: ORBIT_TRACE_FILES.manifest,
          message: 'manifest.json 顶层结构必须是 JSON 对象',
        });
      } else {
        if (typeof parsed.format === 'string') detectedFormat = parsed.format;
        if (typeof parsed.formatVersion === 'number') detectedFormatVersion = parsed.formatVersion;
        if (parsed.format !== ORBIT_TRACE_FORMAT) {
          manifestCorrupt = true;
          diagnostics.push({
            code: 'unsupported-format',
            file: ORBIT_TRACE_FILES.manifest,
            message: `不支持的录制格式: format=${String(parsed.format)} (预期 ${ORBIT_TRACE_FORMAT})`,
          });
        } else if (parsed.formatVersion !== ORBIT_TRACE_FORMAT_VERSION) {
          manifestCorrupt = true;
          diagnostics.push({
            code: 'unsupported-version',
            file: ORBIT_TRACE_FILES.manifest,
            message: `不支持的录制格式版本: formatVersion=${String(parsed.formatVersion)} (支持版本 ${ORBIT_TRACE_FORMAT_VERSION})`,
          });
        } else if (
          typeof parsed.recordId !== 'string' ||
          parsed.recordId.length === 0 ||
          !parsed.identity ||
          typeof parsed.identity !== 'object' ||
          !parsed.committed ||
          typeof parsed.committed !== 'object' ||
          typeof parsed.committed.rawBytes !== 'number' ||
          !['recording', 'completed', 'interrupted', 'failed', 'corrupted'].includes(String(parsed.state))
        ) {
          manifestCorrupt = true;
          diagnostics.push({
            code: 'corrupt-manifest',
            file: ORBIT_TRACE_FILES.manifest,
            message: 'manifest.json 缺少必需元数据字段或状态无效',
          });
        } else {
          manifest = parsed as TraceRecordingManifest;
        }
      }
    } catch (err) {
      manifestCorrupt = true;
      diagnostics.push({
        code: 'corrupt-manifest',
        file: ORBIT_TRACE_FILES.manifest,
        message: `manifest.json 解析失败: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  } else {
    diagnostics.push({
      code: 'missing-manifest',
      file: ORBIT_TRACE_FILES.manifest,
      message: '缺少 manifest.json（可能是崩溃发生于初始元数据落盘前）',
    });
  }

  const rawExists = await fileSystem.exists(rawPath);
  const dataExists = await fileSystem.exists(dataPath);
  const journalExists = await fileSystem.exists(journalPath);
  const indexPath = path.join(recordingDir, ORBIT_TRACE_FILES.index);
  const indexExists = await fileSystem.exists(indexPath);

  const actualRawFileBytes = rawExists ? (await fileSystem.stat(rawPath)).size : 0;
  const actualDataFileBytes = dataExists ? (await fileSystem.stat(dataPath)).size : 0;
  const actualJournalFileBytes = journalExists ? (await fileSystem.stat(journalPath)).size : 0;

  const frames: ParsedJournalFrame[] = [];
  const journalSegKeys = new Set<string>();
  let journalGapCount = 0;
  let recoverableRawBytes = 0;
  let recoverableDataBytes = 0;
  let lastValidCommitSeq = 0;
  let cleanCloseFound = false;
  let failureFound = false;
  let failureTerminalState: 'interrupted' | 'failed' | undefined;
  let failureExpectedSha: string | undefined;
  let hasCommittedCorruption = false;
  let hasTruncatedJournalTail = false;
  let indexStatus: RecordingIndexStatus = indexExists ? 'valid' : 'missing';

  let rawHandle: TraceFileHandle | undefined;
  let dataHandle: TraceFileHandle | undefined;
  let journalHandle: TraceFileHandle | undefined;

  try {
    if (rawExists) rawHandle = await fileSystem.open(rawPath, 'r');
    if (dataExists) dataHandle = await fileSystem.open(dataPath, 'r');
    if (journalExists) journalHandle = await fileSystem.open(journalPath, 'r');

    if (journalHandle) {
      let jPos = 0;
      while (jPos < actualJournalFileBytes) {
        const hdrRes = await readExactFromHandle(journalHandle, jPos, OTJ_HEADER_BYTES);
        if (hdrRes.truncated) {
          hasTruncatedJournalTail = true;
          diagnostics.push({
            code: 'truncated-journal-tail',
            file: ORBIT_TRACE_FILES.journal,
            offset: jPos,
            message: `journal.otj 尾部截断（仅剩 ${hdrRes.bytes.length}/${OTJ_HEADER_BYTES} 字节头）`,
          });
          break;
        }
        const hdrBuf = Buffer.from(hdrRes.bytes.buffer, hdrRes.bytes.byteOffset, hdrRes.bytes.byteLength);
        const magic = hdrBuf.readUInt32LE(0);
        const version = hdrBuf.readUInt16LE(4);
        const frameKind = hdrBuf.readUInt16LE(6) as JournalFrameKind;
        const commitSeq = Number(hdrBuf.readBigUInt64LE(8));
        const rawOffset = Number(hdrBuf.readBigUInt64LE(16));
        const rawLength = hdrBuf.readUInt32LE(24);
        const rawCrc32 = hdrBuf.readUInt32LE(28);
        const dataOffset = Number(hdrBuf.readBigUInt64LE(32));
        const dataLength = hdrBuf.readUInt32LE(40);
        const dataCrc32 = hdrBuf.readUInt32LE(44);
        const metaLength = hdrBuf.readUInt32LE(48);
        const expectedHdrCrc = hdrBuf.readUInt32LE(52);
        const actualHdrCrc = computeCrc32(hdrBuf.subarray(0, 52));

        if (magic !== OTJ_MAGIC || version !== ORBIT_TRACE_FORMAT_VERSION || actualHdrCrc !== expectedHdrCrc) {
          // 若在文件尾部出现未完成写出的字节且其后没有更多内容，可能是尾部损坏；
          // 但一旦头校验失败，立即停止于上一有效提交边界并标记为损坏。
          hasCommittedCorruption = true;
          diagnostics.push({
            code: 'corrupt-journal-frame',
            file: ORBIT_TRACE_FILES.journal,
            offset: jPos,
            message: `journal.otj 帧头校验失败 (magic=0x${magic.toString(16)}, ver=${version})`,
          });
          break;
        }

        if (metaLength > MAX_JOURNAL_META_BYTES) {
          hasCommittedCorruption = true;
          diagnostics.push({
            code: 'corrupt-journal-frame',
            file: ORBIT_TRACE_FILES.journal,
            offset: jPos,
            message: `journal.otj 元数据长度超限: ${metaLength}`,
          });
          break;
        }

        const bodyAndTrailer = await readExactFromHandle(
          journalHandle,
          jPos + OTJ_HEADER_BYTES,
          metaLength + OTJ_TRAILER_BYTES,
        );
        if (bodyAndTrailer.truncated) {
          hasTruncatedJournalTail = true;
          diagnostics.push({
            code: 'truncated-journal-tail',
            file: ORBIT_TRACE_FILES.journal,
            offset: jPos,
            commitSeq,
            message: `journal.otj 尾部帧不完整截断 (commitSeq=${commitSeq})`,
          });
          break;
        }

        const fullFrame = Buffer.allocUnsafe(OTJ_HEADER_BYTES + metaLength);
        hdrBuf.copy(fullFrame, 0);
        Buffer.from(
          bodyAndTrailer.bytes.buffer,
          bodyAndTrailer.bytes.byteOffset,
          metaLength,
        ).copy(fullFrame, OTJ_HEADER_BYTES);
        const trailerBuf = Buffer.from(
          bodyAndTrailer.bytes.buffer,
          bodyAndTrailer.bytes.byteOffset + metaLength,
          OTJ_TRAILER_BYTES,
        );
        const expectedFrameCrc = trailerBuf.readUInt32LE(0);
        const actualFrameCrc = computeCrc32(fullFrame);
        if (actualFrameCrc !== expectedFrameCrc) {
          hasCommittedCorruption = true;
          diagnostics.push({
            code: 'corrupt-journal-frame',
            file: ORBIT_TRACE_FILES.journal,
            offset: jPos,
            commitSeq,
            message: `journal.otj 整帧 CRC32 不匹配 (commitSeq=${commitSeq})`,
          });
          break;
        }

        let meta: JournalCommitMetadata;
        try {
          meta = JSON.parse(fullFrame.subarray(OTJ_HEADER_BYTES).toString('utf8')) as JournalCommitMetadata;
        } catch {
          hasCommittedCorruption = true;
          diagnostics.push({
            code: 'corrupt-journal-frame',
            file: ORBIT_TRACE_FILES.journal,
            offset: jPos,
            commitSeq,
            message: `journal.otj 元数据 JSON 解析失败 (commitSeq=${commitSeq})`,
          });
          break;
        }

        // 严格顺序与偏移连续校验
        if (commitSeq !== lastValidCommitSeq + 1 || rawOffset !== recoverableRawBytes || dataOffset !== recoverableDataBytes) {
          hasCommittedCorruption = true;
          diagnostics.push({
            code: 'sequence-mismatch',
            file: ORBIT_TRACE_FILES.journal,
            offset: jPos,
            commitSeq,
            message: `提交边界不连续: expectedSeq=${lastValidCommitSeq + 1} actual=${commitSeq}, rawOff=${rawOffset}/${recoverableRawBytes}, dataOff=${dataOffset}/${recoverableDataBytes}`,
          });
          break;
        }

        if (rawLength > 0) {
          if (!rawHandle || rawOffset + rawLength > actualRawFileBytes) {
            hasCommittedCorruption = true;
            diagnostics.push({
              code: 'raw-truncated',
              file: ORBIT_TRACE_FILES.raw,
              offset: rawOffset,
              commitSeq,
              message: `raw.otbin 长度不足，缺少已提交块 [${rawOffset}, ${rawOffset + rawLength})`,
            });
            break;
          }
          const rawCrcRes = await computeCrc32FromHandle(rawHandle, rawOffset, rawLength);
          if (!rawCrcRes.ok || rawCrcRes.crc32 !== rawCrc32) {
            hasCommittedCorruption = true;
            diagnostics.push({
              code: 'raw-crc-mismatch',
              file: ORBIT_TRACE_FILES.raw,
              offset: rawOffset,
              commitSeq,
              message: `raw.otbin CRC32 校验失败 [${rawOffset}, ${rawOffset + rawLength})`,
            });
            break;
          }
        }

        if (dataLength > 0) {
          if (!dataHandle || dataOffset + dataLength > actualDataFileBytes) {
            hasCommittedCorruption = true;
            diagnostics.push({
              code: 'data-truncated',
              file: ORBIT_TRACE_FILES.data,
              offset: dataOffset,
              commitSeq,
              message: `data.otd 长度不足，缺少已提交页 [${dataOffset}, ${dataOffset + dataLength})`,
            });
            break;
          }
          const dataCrcRes = await computeCrc32FromHandle(dataHandle, dataOffset, dataLength);
          if (!dataCrcRes.ok || dataCrcRes.crc32 !== dataCrc32) {
            hasCommittedCorruption = true;
            diagnostics.push({
              code: 'data-crc-mismatch',
              file: ORBIT_TRACE_FILES.data,
              offset: dataOffset,
              commitSeq,
              message: `data.otd CRC32 校验失败 [${dataOffset}, ${dataOffset + dataLength})`,
            });
            break;
          }
        }

        const frameLength = OTJ_HEADER_BYTES + metaLength + OTJ_TRAILER_BYTES;
        frames.push({
          frameOffset: jPos,
          frameLength,
          frameKind,
          commitSeq,
          rawOffset,
          rawLength,
          rawCrc32,
          dataOffset,
          dataLength,
          dataCrc32,
          meta,
        });
        if (meta.segments) {
          for (const seg of meta.segments) {
            journalSegKeys.add(`${seg.bootGeneration}:${seg.segmentId}`);
          }
        }
        if (meta.gaps) {
          journalGapCount += meta.gaps.length;
        }

        lastValidCommitSeq = commitSeq;
        recoverableRawBytes = rawOffset + rawLength;
        recoverableDataBytes = dataOffset + dataLength;
        jPos += frameLength;

        if (frameKind === JOURNAL_FRAME_KIND.CLEAN_CLOSE) {
          cleanCloseFound = true;
          if (jPos < actualJournalFileBytes) {
            hasCommittedCorruption = true;
            diagnostics.push({
              code: 'corrupt-journal-frame',
              file: ORBIT_TRACE_FILES.journal,
              offset: jPos,
              commitSeq,
              message: `CLEAN_CLOSE 之后仍存在 ${actualJournalFileBytes - jPos} 字节多余日志数据`,
            });
          }
          break;
        }
        if (frameKind === JOURNAL_FRAME_KIND.FAILURE_MARK) {
          failureFound = true;
          const fs = meta.failureSummary;
          if (fs?.terminalState === 'interrupted' || fs?.terminalState === 'failed') {
            failureTerminalState = fs.terminalState;
          }
          if (fs?.rawSha256 && typeof fs.totalRawBytes === 'number') {
            failureExpectedSha = fs.rawSha256;
          }
          diagnostics.push({
            code: 'failure-recorded',
            file: ORBIT_TRACE_FILES.journal,
            offset: jPos - frameLength,
            commitSeq,
            message: fs
              ? `录制记录了中断/失败封存 (${fs.terminalState ?? 'failed'}): ${fs.errorCode} (${fs.message})`
              : '录制记录了存储失败标记',
          });
        }
      }
    }

    const uncommittedTrailingRawBytes = Math.max(0, actualRawFileBytes - recoverableRawBytes);
    const uncommittedTrailingDataBytes = Math.max(0, actualDataFileBytes - recoverableDataBytes);
    if (uncommittedTrailingRawBytes > 0) {
      diagnostics.push({
        code: 'uncommitted-raw-tail',
        file: ORBIT_TRACE_FILES.raw,
        offset: recoverableRawBytes,
        message: `raw.otbin 存在 ${uncommittedTrailingRawBytes} 字节未提交尾部，可恢复前缀止步于 ${recoverableRawBytes}`,
      });
    }
    if (uncommittedTrailingDataBytes > 0) {
      diagnostics.push({
        code: 'uncommitted-data-tail',
        file: ORBIT_TRACE_FILES.data,
        offset: recoverableDataBytes,
        message: `data.otd 存在 ${uncommittedTrailingDataBytes} 字节未提交尾部，可恢复前缀止步于 ${recoverableDataBytes}`,
      });
    }

    let rawSha256Verified = false;
    const cleanFrame = cleanCloseFound ? frames[frames.length - 1] : undefined;
    const expectedSha = cleanFrame?.meta.closeSummary?.rawSha256 ?? failureExpectedSha ?? manifest?.rawSha256;
    const canVerifySha =
      cleanCloseFound ||
      (failureFound && expectedSha !== undefined) ||
      (hasTruncatedJournalTail && !hasCommittedCorruption && manifest !== undefined && manifest.committed.rawBytes === recoverableRawBytes);
    if (canVerifySha && expectedSha && (options.verifyRawSha256 ?? true)) {
      if (recoverableRawBytes === 0) {
        const emptySha = createHash('sha256').digest('hex');
        if (emptySha === expectedSha) {
          rawSha256Verified = true;
        } else {
          hasCommittedCorruption = true;
          diagnostics.push({
            code: 'raw-sha256-mismatch',
            file: ORBIT_TRACE_FILES.raw,
            message: `空 raw.otbin SHA256 不匹配: expected=${expectedSha}, actual=${emptySha}`,
          });
        }
      } else if (rawHandle) {
        const actualSha = await computeSha256FromHandle(rawHandle, recoverableRawBytes);
        if (actualSha === expectedSha) {
          rawSha256Verified = true;
        } else {
          hasCommittedCorruption = true;
          diagnostics.push({
            code: 'raw-sha256-mismatch',
            file: ORBIT_TRACE_FILES.raw,
            message: `raw.otbin SHA256 不匹配: expected=${expectedSha}, actual=${actualSha}`,
          });
        }
      }
    }

    // 校验可选 index.otidx（区分坏索引与坏分块：坏索引可从 journal.otj 权威重建）
    if (indexExists) {
      try {
        const idxBuf = await fileSystem.readFile(indexPath);
        const snap = decodeIndexSnapshot(idxBuf);
        if (snap.format !== ORBIT_TRACE_FORMAT || snap.formatVersion !== ORBIT_TRACE_FORMAT_VERSION) {
          indexStatus = 'corrupt';
          diagnostics.push({
            code: 'corrupt-index',
            file: ORBIT_TRACE_FILES.index,
            offset: 0,
            message: `index.otidx 格式或版本不匹配: format=${String(snap.format)}, version=${String(snap.formatVersion)}`,
          });
        } else if (
          cleanCloseFound &&
          !hasCommittedCorruption &&
          (snap.segments.length !== journalSegKeys.size || snap.gaps.length !== journalGapCount)
        ) {
          indexStatus = 'corrupt';
          diagnostics.push({
            code: 'corrupt-index',
            file: ORBIT_TRACE_FILES.index,
            offset: 0,
            message: `index.otidx 索引摘要与 journal.otj 不一致 (segments=${snap.segments.length}/${journalSegKeys.size}, gaps=${snap.gaps.length}/${journalGapCount})`,
          });
        } else {
          indexStatus = 'valid';
        }
      } catch (err) {
        indexStatus = 'corrupt';
        diagnostics.push({
          code: 'corrupt-index',
          file: ORBIT_TRACE_FILES.index,
          offset: 0,
          message: `index.otidx 校验失败，将从 journal.otj 重建索引: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    // 检查 manifest 宣称 completed 但 journal 缺少 CLEAN_CLOSE 或数量不一致
    if (manifest?.state === 'completed' && !cleanCloseFound) {
      if (hasTruncatedJournalTail && !hasCommittedCorruption) {
        diagnostics.push({
          code: 'unclean-close',
          file: ORBIT_TRACE_FILES.journal,
          message: 'journal.otj 最终提交帧被截断（缺少完整 CLEAN_CLOSE 边界），可恢复至已提交前缀',
        });
      } else {
        hasCommittedCorruption = true;
        diagnostics.push({
          code: 'unclean-close',
          file: ORBIT_TRACE_FILES.journal,
          message: 'manifest.json 标记 completed，但 journal.otj 缺少 CLEAN_CLOSE 帧',
        });
      }
    } else if (manifest && (manifest.state === 'interrupted' || manifest.state === 'failed') && cleanCloseFound) {
      hasCommittedCorruption = true;
      diagnostics.push({
        code: 'unclean-close',
        file: ORBIT_TRACE_FILES.journal,
        message: `manifest.json 标记 ${manifest.state}，但 journal.otj 存在矛盾的 CLEAN_CLOSE 帧`,
      });
    } else if (manifest?.state === 'completed' && manifest.committed.rawBytes !== recoverableRawBytes && !hasTruncatedJournalTail) {
      hasCommittedCorruption = true;
      diagnostics.push({
        code: 'sequence-mismatch',
        file: ORBIT_TRACE_FILES.manifest,
        message: `manifest.json 记录的 committed.rawBytes (${manifest.committed.rawBytes}) 与 journal.otj 校验长度 (${recoverableRawBytes}) 不一致`,
      });
    } else if (!cleanCloseFound && !failureFound && !hasCommittedCorruption) {
      diagnostics.push({
        code: 'unclean-close',
        file: ORBIT_TRACE_FILES.journal,
        message: '未检测到 CLEAN_CLOSE 提交边界，录制处于未完整关闭状态（interrupted）',
      });
    }

    let status: RecordingLifecycleState;
    if (hasCommittedCorruption || manifestCorrupt || indexStatus === 'corrupt') {
      status = 'corrupted';
    } else if (cleanCloseFound && manifest?.state === 'completed') {
      status = 'completed';
    } else if (manifest?.state === 'interrupted' || failureTerminalState === 'interrupted' || hasTruncatedJournalTail) {
      status = 'interrupted';
    } else if (failureFound || manifest?.state === 'failed') {
      status = 'failed';
    } else {
      status = 'interrupted';
    }

    const hasAnyArchiveFile = Boolean(manifest) || rawExists || dataExists || journalExists;
    const isRecoverable =
      !manifestCorrupt &&
      hasAnyArchiveFile &&
      (frames.length > 0 || (!hasCommittedCorruption && manifest !== undefined && recoverableRawBytes === 0));

    const isComplete =
      status === 'completed' &&
      cleanCloseFound &&
      indexStatus !== 'corrupt' &&
      uncommittedTrailingRawBytes === 0 &&
      uncommittedTrailingDataBytes === 0 &&
      !hasTruncatedJournalTail &&
      (options.verifyRawSha256 === false || rawSha256Verified);

    const recoveryDisposition: RecordingRecoveryDisposition = !isRecoverable
      ? 'unrecoverable'
      : status === 'completed'
        ? 'intact'
        : indexStatus === 'corrupt' && !hasCommittedCorruption
          ? 'rebuilt-bad-index'
          : hasCommittedCorruption
            ? 'recovered-prefix-bad-chunk'
            : status === 'failed'
              ? 'recovered-failed'
              : 'recovered-interrupted';

    return {
      format: ORBIT_TRACE_FORMAT,
      formatVersion: ORBIT_TRACE_FORMAT_VERSION,
      ...(detectedFormat !== undefined ? { detectedFormat } : {}),
      ...(detectedFormatVersion !== undefined ? { detectedFormatVersion } : {}),
      status,
      isComplete,
      isRecoverable,
      isCorrupted: status === 'corrupted',
      indexStatus,
      hasCommittedChunkCorruption: hasCommittedCorruption,
      recoveryDisposition,
      recoverableRawBytes,
      recoverableDataBytes,
      actualRawFileBytes,
      actualDataFileBytes,
      actualJournalFileBytes,
      uncommittedTrailingRawBytes,
      uncommittedTrailingDataBytes,
      lastValidCommitSeq,
      cleanCloseFound,
      rawSha256Verified,
      manifest,
      frames,
      diagnostics,
    };
  } finally {
    await Promise.allSettled([
      rawHandle?.close(),
      dataHandle?.close(),
      journalHandle?.close(),
    ]);
  }
}
