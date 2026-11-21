import { createHash } from 'node:crypto';
import * as path from 'node:path';
import {
  DecodedSystemViewPacket,
  SystemViewDecodeBatch,
  SystemViewDecoderOptions,
  SystemViewStreamDecoder,
  TraceDiagnostic,
  TraceGapInput,
  TraceSegmentSummary,
} from './systemview-decoder';
import {
  ContextActivationInterval,
  ExecutionSliceInterval,
  MarkerInterval,
  MarkerPointEvent,
  ReadyWaitInterval,
  ReconstructorDiagnostic,
  SystemViewTraceReconstructor,
  TaskInstanceSummary,
  TraceReconstructBatch,
  TraceReconstructionIdentity,
  TraceSymbolMap,
  TraceTimePoint,
} from './systemview-reconstructor';
import {
  computeCrc32,
  decodeIndexSnapshot,
  decodeTraceDataPage,
  DecodedTracePage,
  defaultTraceFileSystem,
  encodeIndexSnapshot,
  encodeJournalFrame,
  encodeTraceDataPage,
  IndexedPageDescriptor,
  inspectRecordingDirectory,
  JOURNAL_FRAME_KIND,
  JournalCommitMetadata,
  ORBIT_TRACE_FILES,
  ORBIT_TRACE_FORMAT,
  ORBIT_TRACE_FORMAT_VERSION,
  ORBIT_TRACE_NON_SVDAT_NOTICE,
  OTJ_HEADER_BYTES,
  OTJ_MAGIC,
  OTJ_TRAILER_BYTES,
  ParsedJournalFrame,
  RecordingDiagnostic,
  RecordingInspectionResult,
  RecordingLifecycleState,
  safeTraceJsonStringify,
  SegmentIndexMetadata,
  StoredGapEntry,
  TraceFileHandle,
  TraceFileSystem,
  TracePageItems,
  TracePageKind,
  TraceRecordingCommittedCounts,
  TraceRecordingLimitsSnapshot,
  TraceRecordingManifest,
} from './trace-format';
import { SYSTEMVIEW_PROTOCOL_VERSION } from './systemview-protocol';
import {
  computeTraceAnalysis,
  TraceAnalysisQueryRequest,
  TraceAnalysisQueryResult,
} from './trace-analytics';
import {
  streamEventsToCsvWriter,
  type TraceCsvExportRequest,
  type TraceCsvExportResult,
} from './trace-csv-export';
import {
  buildRecordingDiagnosticsResult,
  createTraceEventMetadataContext,
  executeEventLocate,
  executeEventsQuery,
  executeTerminalQuery,
  TraceEventLocateRequest,
  TraceEventLocateResult,
  TraceEventsExecutionHost,
  TraceEventsQueryRequest,
  TraceEventsQueryResult,
  TraceRecordingDiagnosticsResult,
  TraceTerminalQueryRequest,
  TraceTerminalQueryResult,
} from './trace-events';
import type {
  TraceEventMetadataContext,
  VerifiedElfRodataLookup,
} from './systemview-formatter';
import {
  CompactedDirectoryBlock,
  getIntervalBoundsForUnit,
  getMarkerPointTimeForUnit,
  getPacketTimeForUnit,
  getPageKindsForQueryTarget,
  getTimePointValueForUnit,
  intersectsHalfOpen,
  PageLodSummary,
  parseRangeBoundBigInt,
  SpillIndexBlockHandler,
  ticksToNsBigInt,
  TraceLodBucket,
  TraceQueryTarget,
  TraceQueryTimeUnit,
  TraceRangeIndex,
} from './trace-range-index';

export interface TraceStorageLimits {
  readonly rawChunkBytes: number;
  readonly pageMaxItems: number;
  readonly pageMaxBytes: number;
  readonly maxCacheBytes: number;
  readonly maxCachedPages: number;
  readonly maxIndexPagesInMemory: number;
  readonly maxLodSummariesPerSegment: number;
  readonly maxWriteQueueBytes: number;
  readonly maxSingleBatchBytes: number;
  readonly maxQueryResultItems: number;
  readonly maxQueryResultBytes: number;
  readonly maxLodBuckets: number;
  readonly longIntervalThresholdTicks?: bigint;
}

export const DEFAULT_TRACE_STORAGE_LIMITS: TraceStorageLimits = {
  rawChunkBytes: 64 * 1024,
  pageMaxItems: 4096,
  pageMaxBytes: 256 * 1024,
  maxCacheBytes: 8 * 1024 * 1024,
  maxCachedPages: 64,
  maxIndexPagesInMemory: 16384,
  maxLodSummariesPerSegment: 4096,
  maxWriteQueueBytes: 16 * 1024 * 1024,
  maxSingleBatchBytes: 4 * 1024 * 1024,
  maxQueryResultItems: 4096,
  maxQueryResultBytes: 2 * 1024 * 1024,
  maxLodBuckets: 4096,
};

export type TraceStorageErrorCode =
  | 'InvalidArgument'
  | 'BatchLimitExceeded'
  | 'WriteQueueFull'
  | 'SessionChanged'
  | 'RecordChanged'
  | 'RecordingClosed'
  | 'RecordingFailed'
  | 'RecordingCorrupted'
  | 'RecordingNotFinished'
  | 'RecordingNotFinalized'
  | 'RecordingDirectoryNotEmpty'
  | 'RecordingDirectoryBusy'
  | 'UnsupportedArchiveFormat'
  | 'UnsupportedArchiveVersion'
  | 'ExportPathConflict'
  | 'ExportTargetExists'
  | 'BatchSequenceGap'
  | 'BatchSequenceInvalid'
  | 'StaleBootGeneration'
  | 'ENOSPC'
  | 'ShortWrite'
  | 'StorageWriteError'
  | 'StorageReadError'
  | 'QueryCancelled'
  | 'InvalidCursor'
  | 'UnsupportedCapability';

export interface TraceStorageFailure {
  readonly ok: false;
  readonly errorCode: TraceStorageErrorCode;
  readonly message: string;
  readonly cancelled?: boolean;
  readonly diagnostics?: Record<string, unknown>;
}

export interface TraceStorageSuccess<T> {
  readonly ok: true;
  readonly data: T;
}

export type TraceStorageResult<T> = TraceStorageSuccess<T> | TraceStorageFailure;

export interface TraceQueryCancelToken {
  readonly signal?: AbortSignal;
  readonly cancelBuffer?: Int32Array;
  readonly cancelIndex?: number;
  readonly expectedCancelValue?: number;
  readonly isCancelled?: () => boolean;
  readonly yieldEveryPages?: number;
  readonly yieldEveryItems?: number;
}

export interface TraceRangeQueryRequest {
  readonly target: TraceQueryTarget;
  readonly start: bigint | string | number;
  readonly end: bigint | string | number;
  readonly unit: TraceQueryTimeUnit;
  readonly bootGeneration?: number;
  readonly segmentId?: number;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface TraceRangeQueryResult<T = unknown> {
  readonly target: TraceQueryTarget;
  readonly unit: TraceQueryTimeUnit;
  readonly start: string;
  readonly end: string;
  readonly items: readonly T[];
  readonly totalReturned: number;
  readonly hasMore: boolean;
  readonly nextCursor?: string;
  readonly candidatePagesScanned: number;
  readonly cacheHits: number;
  readonly cacheMisses: number;
  readonly skippedUnanchoredSegments: readonly number[];
  readonly skippedNoFrequencySegments: readonly number[];
}

export interface TraceLodQueryRequest {
  readonly start: bigint | string | number;
  readonly end: bigint | string | number;
  readonly unit: TraceQueryTimeUnit;
  readonly maxBuckets?: number;
  readonly bootGeneration?: number;
  readonly segmentId?: number;
}

export interface TraceLodQueryResult {
  readonly unit: TraceQueryTimeUnit;
  readonly start: string;
  readonly end: string;
  readonly buckets: readonly TraceLodBucket[];
  readonly skippedUnanchoredSegments: readonly number[];
  readonly skippedNoFrequencySegments: readonly number[];
  readonly usedFineItems: boolean;
}

export interface TraceStorageStats {
  readonly recordId: string;
  readonly state: RecordingLifecycleState;
  readonly closed: boolean;
  readonly limits: TraceStorageLimits;
  readonly committed: TraceRecordingCommittedCounts;
  readonly pendingRawBytes: number;
  readonly writeQueueBytes: number;
  readonly peakWriteQueueBytes: number;
  readonly cache: {
    readonly cachedPages: number;
    readonly cachedBytes: number;
    readonly peakCachedPages: number;
    readonly peakCachedBytes: number;
    readonly hits: number;
    readonly misses: number;
    readonly evictions: number;
  };
  readonly index: ReturnType<TraceRangeIndex['getStats']>;
  readonly peakRssBytes: number;
  readonly peakHeapUsedBytes: number;
}

export interface CreateTraceRecordingOptions {
  readonly recordingDir: string;
  readonly recordId: string;
  readonly identity: TraceReconstructionIdentity;
  readonly decoderOptions?: SystemViewDecoderOptions;
  readonly symbolMap?: TraceSymbolMap;
  readonly limits?: Partial<TraceStorageLimits>;
  readonly fileSystem?: TraceFileSystem;
  readonly commitOnEachIngest?: boolean;
}

export interface OpenTraceRecordingOptions {
  readonly recordingDir: string;
  readonly limits?: Partial<TraceStorageLimits>;
  readonly fileSystem?: TraceFileSystem;
  readonly verifyRawSha256?: boolean;
}

export interface IngestRawChunkMeta {
  readonly sessionId?: string;
  readonly sessionGeneration?: number;
  readonly bootGeneration?: number;
  readonly recordId?: string;
  readonly batchSequence?: number;
  readonly flush?: boolean;
}

export interface IngestBatchSummary {
  readonly commitSeq: number;
  readonly committedRawBytes: number;
  readonly packetsDecoded: number;
  readonly slicesEmitted: number;
  readonly activationsEmitted: number;
  readonly readyWaitsEmitted: number;
  readonly markersEmitted: number;
  readonly markerPointsEmitted: number;
  readonly gapsRecorded: number;
  readonly clockTail?: { readonly segmentId: number; readonly relativeTicks: string; readonly frequencyHz: number };
}

// ---------------------------------------------------------------------------
// Bounded LRU Page Cache
// ---------------------------------------------------------------------------

interface CachedPageEntry {
  readonly key: string;
  readonly page: DecodedTracePage;
  readonly byteSize: number;
}

class BoundedPageCache {
  private readonly map = new Map<string, CachedPageEntry>();
  private currentBytes = 0;
  private peakPages = 0;
  private peakBytes = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  public constructor(
    private readonly maxPages: number,
    private readonly maxBytes: number,
  ) {}

  public get(key: string): DecodedTracePage | undefined {
    const entry = this.map.get(key);
    if (!entry) {
      this.misses += 1;
      return undefined;
    }
    this.hits += 1;
    // 刷新 LRU 位置
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.page;
  }

  public put(key: string, page: DecodedTracePage, byteSize: number): void {
    if (byteSize > this.maxBytes || this.maxPages <= 0) {
      return;
    }
    const existing = this.map.get(key);
    if (existing) {
      this.currentBytes -= existing.byteSize;
      this.map.delete(key);
    }
    while (this.map.size >= this.maxPages || this.currentBytes + byteSize > this.maxBytes) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      const oldest = this.map.get(oldestKey)!;
      this.map.delete(oldestKey);
      this.currentBytes -= oldest.byteSize;
      this.evictions += 1;
    }
    this.map.set(key, { key, page, byteSize });
    this.currentBytes += byteSize;
    if (this.map.size > this.peakPages) {
      this.peakPages = this.map.size;
    }
    if (this.currentBytes > this.peakBytes) {
      this.peakBytes = this.currentBytes;
    }
  }

  public clear(): void {
    this.map.clear();
    this.currentBytes = 0;
  }

  public getStats() {
    return {
      cachedPages: this.map.size,
      cachedBytes: this.currentBytes,
      peakCachedPages: this.peakPages,
      peakCachedBytes: this.peakBytes,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
    };
  }
}

// ---------------------------------------------------------------------------
// Active Page Accumulator
// ---------------------------------------------------------------------------

interface PendingPageBuffer {
  readonly kind: TracePageKind;
  readonly bootGeneration: number;
  readonly segmentId: number;
  readonly items: unknown[];
  estimatedBytes: number;
}

interface CursorState {
  readonly pIdx: number;
  readonly kIdx: number;
  readonly pgIdx: number;
  readonly iIdx: number;
}

function encodeCursor(state: CursorState): string {
  return `${state.pIdx}:${state.kIdx}:${state.pgIdx}:${state.iIdx}`;
}

function decodeCursor(cursor: string): CursorState | null {
  const parts = cursor.split(':');
  if (parts.length !== 4) {
    return null;
  }
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0)) {
    return null;
  }
  return { pIdx: nums[0], kIdx: nums[1], pgIdx: nums[2], iIdx: nums[3] };
}

function resolveLimits(partial?: Partial<TraceStorageLimits>): TraceStorageLimits {
  const merged: TraceStorageLimits = {
    ...DEFAULT_TRACE_STORAGE_LIMITS,
    ...partial,
  };
  const check = (val: number, name: string, min: number, max: number) => {
    if (!Number.isInteger(val) || val < min || val > max) {
      throw new RangeError(`${name} must be an integer in ${min}..${max}, got ${val}`);
    }
  };
  check(merged.rawChunkBytes, 'rawChunkBytes', 256, 16 * 1024 * 1024);
  check(merged.pageMaxItems, 'pageMaxItems', 4, 65536);
  check(merged.pageMaxBytes, 'pageMaxBytes', 1024, 16 * 1024 * 1024);
  check(merged.maxCacheBytes, 'maxCacheBytes', 4096, 512 * 1024 * 1024);
  check(merged.maxCachedPages, 'maxCachedPages', 1, 16384);
  check(merged.maxIndexPagesInMemory, 'maxIndexPagesInMemory', 4, 1048576);
  check(merged.maxLodSummariesPerSegment, 'maxLodSummariesPerSegment', 8, 65536);
  check(merged.maxWriteQueueBytes, 'maxWriteQueueBytes', 1024, 256 * 1024 * 1024);
  check(merged.maxSingleBatchBytes, 'maxSingleBatchBytes', 1024, 64 * 1024 * 1024);
  check(merged.maxQueryResultItems, 'maxQueryResultItems', 1, 16384);
  check(merged.maxQueryResultBytes, 'maxQueryResultBytes', 4096, 16 * 1024 * 1024);
  check(merged.maxLodBuckets, 'maxLodBuckets', 1, 16384);
  return merged;
}

function classifyStorageWriteError(err: unknown): {
  errorCode: TraceStorageErrorCode;
  message: string;
} {
  if (err && typeof err === 'object') {
    const code = (err as { code?: unknown }).code;
    const msg = err instanceof Error ? err.message : String(err);
    if (code === 'ENOSPC' || msg.includes('ENOSPC')) {
      return { errorCode: 'ENOSPC', message: `磁盘空间不足 (ENOSPC): ${msg}` };
    }
    if (code === 'ShortWrite' || msg.includes('ShortWrite')) {
      return { errorCode: 'ShortWrite', message: `短写失败: ${msg}` };
    }
    return { errorCode: 'StorageWriteError', message: `存储写入失败: ${msg}` };
  }
  return { errorCode: 'StorageWriteError', message: `存储写入失败: ${String(err)}` };
}

async function writeAllChecked(
  handle: TraceFileHandle,
  buffer: Uint8Array,
  position: number,
  chunkSize: number,
): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const len = Math.min(chunkSize, buffer.length - offset);
    const res = await handle.write(buffer, offset, len, position + offset);
    if (res.bytesWritten !== len) {
      const err = new Error(`ShortWrite: expected ${len} bytes, wrote ${res.bytesWritten} bytes at offset ${position + offset}`);
      (err as { code?: string }).code = 'ShortWrite';
      throw err;
    }
    offset += res.bytesWritten;
  }
}

async function readExactFromHandle(
  handle: TraceFileHandle,
  position: number,
  length: number,
): Promise<Buffer> {
  const out = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const res = await handle.read(out, offset, length - offset, position + offset);
    if (res.bytesRead === 0) {
      throw new Error(`Unexpected EOF reading ${length} bytes at offset ${position}`);
    }
    offset += res.bytesRead;
  }
  return out;
}

function isQueryCancelled(token?: TraceQueryCancelToken): boolean {
  if (!token) {
    return false;
  }
  if (token.signal?.aborted) {
    return true;
  }
  if (token.cancelBuffer && token.cancelIndex !== undefined) {
    const v = Atomics.load(token.cancelBuffer, token.cancelIndex);
    if (token.expectedCancelValue !== undefined ? v === token.expectedCancelValue : v !== 0) {
      return true;
    }
  }
  if (token.isCancelled && token.isCancelled()) {
    return true;
  }
  return false;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Orbit Trace 录制与回放存储引擎（阶段 4.3）。
 *
 * 职责：
 * - 消费 4.1 流式解码与 4.2 区间重建批次（或从原始字节驱动 4.1+4.2），保留完整身份、boot/segment、gap 与 BigInt 时间精度；
 * - 逐字节按有界分块持久化 `raw.otbin`，并按页二进制存储 `data.otd` 与提交边界日志 `journal.otj`；
 * - 维护有界 LRU 页缓存与范围/LOD 索引（支持跨时间页长区间、多段相对 tick 回零、半开范围 `[start, end)` 与绝对/相对单位）；
 * - 落实 ENOSPC / 短写 / 后写失败回滚至上一有效提交边界、异常中断可恢复前缀、幂等关闭与可取消分页查询。
 */
export class TraceRecordingStore {
  public readonly recordingDir: string;
  public readonly recordId: string;
  public readonly limits: TraceStorageLimits;

  private readonly fs: TraceFileSystem;
  private readonly mode: 'write' | 'readonly';
  private readonly decoder?: SystemViewStreamDecoder;
  private readonly reconstructor?: SystemViewTraceReconstructor;
  private readonly decoderOptions?: SystemViewDecoderOptions;
  private readonly commitOnEachIngest: boolean;

  private identity: TraceReconstructionIdentity;
  private state: RecordingLifecycleState = 'recording';
  private closeReason?: string;
  private failureCode?: string;
  private failureDiagnostics?: Record<string, unknown>;
  private createdAtMs: number;
  private updatedAtMs: number;
  private closedAtMs?: number;
  private rawSha256?: string;

  private rawHandle: TraceFileHandle | null = null;
  private dataHandle: TraceFileHandle | null = null;
  private journalHandle: TraceFileHandle | null = null;
  private spillHandle: TraceFileHandle | null = null;
  private spillOffset = 0;
  private nextSpillBlockId = 1;
  private closed = false;

  private readonly cache: BoundedPageCache;
  private readonly index: TraceRangeIndex;
  private readonly packetTimeCache = new WeakMap<object, bigint>();

  private rawHash = createHash('sha256');
  private pendingRawChunks: Uint8Array[] = [];
  private pendingRawBytes = 0;
  private pendingBatchSequences: number[] = [];
  private pendingSegments = new Map<string, SegmentIndexMetadata>();
  private pendingGaps: StoredGapEntry[] = [];
  private pendingTasks = new Map<string, TaskInstanceSummary>();
  private readonly eventMetadata: TraceEventMetadataContext = createTraceEventMetadataContext();
  private readonly seededMetadataPartitions = new Set<string>();
  private rodataLookup?: VerifiedElfRodataLookup;
  private readonly storedDecoderDiagnostics: TraceDiagnostic[] = [];
  private readonly storedReconstructorDiagnostics: ReconstructorDiagnostic[] = [];
  private pendingDecoderDiagnostics: TraceDiagnostic[] = [];
  private pendingReconstructorDiagnostics: ReconstructorDiagnostic[] = [];
  private droppedRecordedDiagnostics = 0;
  private static readonly MAX_STORED_DIAGNOSTICS = 512;

  private activePageBuffers = new Map<string, PendingPageBuffer>();
  private regularMaxEndByPartKind = new Map<string, bigint>();
  private nextPageId = 1;
  private nextGapSeq = 1;

  private committed: TraceRecordingCommittedCounts = {
    commitSeq: 0,
    rawBytes: 0,
    dataBytes: 0,
    journalBytes: 0,
    packetCount: 0,
    sliceCount: 0,
    activationCount: 0,
    readyWaitCount: 0,
    markerCount: 0,
    markerPointCount: 0,
    gapCount: 0,
    segmentCount: 0,
  };

  private pendingCountsDelta = {
    packetCount: 0,
    sliceCount: 0,
    activationCount: 0,
    readyWaitCount: 0,
    markerCount: 0,
    markerPointCount: 0,
    gapCount: 0,
  };

  private writeQueueBytes = 0;
  private peakWriteQueueBytes = 0;
  private peakRssBytes = 0;
  private peakHeapUsedBytes = 0;
  private sequenceGapDeclared = false;
  private inspection?: RecordingInspectionResult;

  private constructor(params: {
    recordingDir: string;
    recordId: string;
    identity: TraceReconstructionIdentity;
    limits: TraceStorageLimits;
    fs: TraceFileSystem;
    mode: 'write' | 'readonly';
    decoder?: SystemViewStreamDecoder;
    reconstructor?: SystemViewTraceReconstructor;
    decoderOptions?: SystemViewDecoderOptions;
    commitOnEachIngest: boolean;
    createdAtMs: number;
  }) {
    this.recordingDir = params.recordingDir;
    this.recordId = params.recordId;
    this.identity = { ...params.identity };
    this.limits = params.limits;
    this.fs = params.fs;
    this.mode = params.mode;
    this.decoder = params.decoder;
    this.reconstructor = params.reconstructor;
    this.decoderOptions = params.decoderOptions;
    this.commitOnEachIngest = params.commitOnEachIngest;
    this.createdAtMs = params.createdAtMs;
    this.updatedAtMs = params.createdAtMs;

    this.cache = new BoundedPageCache(this.limits.maxCachedPages, this.limits.maxCacheBytes);
    const spillHandler: SpillIndexBlockHandler = {
      spillDescriptors: (bootGen, segId, kind, descriptors) =>
        this.spillIndexDescriptors(bootGen, segId, kind, descriptors),
      loadSpilledDescriptors: (block) => this.loadSpilledIndexDescriptors(block),
    };
    this.index = new TraceRangeIndex({
      maxIndexPagesInMemory: this.limits.maxIndexPagesInMemory,
      maxLodSummariesPerSegment: this.limits.maxLodSummariesPerSegment,
      spillHandler,
    });
    this.sampleMemoryUsage();
  }

  public static async create(options: CreateTraceRecordingOptions): Promise<TraceRecordingStore> {
    if (!options.recordId || options.recordId.trim().length === 0) {
      throw new RangeError('recordId must be a non-empty string');
    }
    const limits = resolveLimits(options.limits);
    const fileSystem = options.fileSystem ?? defaultTraceFileSystem;
    const lockKey = await canonicalizeDirectoryKey(options.recordingDir, fileSystem);
    if (activeCreateDirectories.has(lockKey)) {
      throw createCodedError(
        'RecordingDirectoryBusy',
        `录制目录正在并发创建中: ${options.recordingDir}`,
      );
    }
    activeCreateDirectories.add(lockKey);

    try {
      await ensureEmptyRecordingDirectory(options.recordingDir, fileSystem);

      const identity: TraceReconstructionIdentity = {
        ...options.identity,
        recordId: options.recordId,
      };

      const decoder = new SystemViewStreamDecoder(options.decoderOptions);
      const reconstructor = new SystemViewTraceReconstructor({
        identity,
        symbolMap: options.symbolMap,
      });

      const store = new TraceRecordingStore({
        recordingDir: options.recordingDir,
        recordId: options.recordId,
        identity,
        limits,
        fs: fileSystem,
        mode: 'write',
        decoder,
        reconstructor,
        decoderOptions: options.decoderOptions,
        commitOnEachIngest: options.commitOnEachIngest ?? true,
        createdAtMs: Date.now(),
      });

      await store.initializeWriteHandles();
      return store;
    } finally {
      activeCreateDirectories.delete(lockKey);
    }
  }

  public static async open(
    options: OpenTraceRecordingOptions,
  ): Promise<{ store: TraceRecordingStore; inspection: RecordingInspectionResult }> {
    const limits = resolveLimits(options.limits);
    const fileSystem = options.fileSystem ?? defaultTraceFileSystem;
    const inspection = await inspectRecordingDirectory(options.recordingDir, fileSystem, {
      verifyRawSha256: options.verifyRawSha256,
    });

    if (!inspection.isRecoverable) {
      const diagSummary = inspection.diagnostics.map((d) => d.message).join('; ');
      const code: TraceStorageErrorCode = inspection.diagnostics.some((d) => d.code === 'unsupported-version')
        ? 'UnsupportedArchiveVersion'
        : inspection.diagnostics.some((d) => d.code === 'unsupported-format')
          ? 'UnsupportedArchiveFormat'
          : 'RecordingCorrupted';
      const err = createCodedError(code, diagSummary || `录制归档不可恢复或格式无效: ${options.recordingDir}`) as Error & {
        code: TraceStorageErrorCode;
        diagnostics?: Record<string, unknown>;
      };
      err.diagnostics = {
        status: inspection.status,
        recoveryDisposition: inspection.recoveryDisposition,
        detectedFormat: inspection.detectedFormat,
        detectedFormatVersion: inspection.detectedFormatVersion,
        diagnostics: inspection.diagnostics,
      };
      throw err;
    }

    const manifest = inspection.manifest;
    const recordId = manifest?.recordId ?? path.basename(options.recordingDir);
    const identity: TraceReconstructionIdentity = manifest?.identity ?? {
      sessionId: 'recovered-session',
      sessionGeneration: 1,
      bootGeneration: 1,
      recordId,
    };

    const store = new TraceRecordingStore({
      recordingDir: options.recordingDir,
      recordId,
      identity,
      limits,
      fs: fileSystem,
      mode: 'readonly',
      decoderOptions: manifest?.decoderOptions,
      commitOnEachIngest: false,
      createdAtMs: manifest?.createdAtMs ?? Date.now(),
    });
    store.state = inspection.status;
    store.closeReason = manifest?.closeReason;
    store.failureCode = manifest?.failureCode;
    store.failureDiagnostics = manifest?.failureDiagnostics;
    store.closedAtMs = manifest?.closedAtMs;
    store.rawSha256 = manifest?.rawSha256;
    store.inspection = inspection;

    await store.initializeReadOnlyHandles(inspection);
    return { store, inspection };
  }

  private async initializeWriteHandles(): Promise<void> {
    const rawPath = path.join(this.recordingDir, ORBIT_TRACE_FILES.raw);
    const dataPath = path.join(this.recordingDir, ORBIT_TRACE_FILES.data);
    const journalPath = path.join(this.recordingDir, ORBIT_TRACE_FILES.journal);
    const spillPath = path.join(this.recordingDir, 'index-spill.otidx');
    const manifestPath = path.join(this.recordingDir, ORBIT_TRACE_FILES.manifest);

    const createdFiles: string[] = [];
    const openedHandles: TraceFileHandle[] = [];

    const openExclusive = async (filePath: string): Promise<TraceFileHandle> => {
      try {
        const h = await this.fs.open(filePath, 'wx+');
        createdFiles.push(filePath);
        openedHandles.push(h);
        return h;
      } catch (err) {
        if (isAlreadyExistsError(err)) {
          throw createCodedError(
            'RecordingDirectoryNotEmpty',
            `录制文件已存在，拒绝覆盖现有档案: ${filePath}`,
          );
        }
        throw err;
      }
    };

    try {
      this.rawHandle = await openExclusive(rawPath);
      this.dataHandle = await openExclusive(dataPath);
      this.journalHandle = await openExclusive(journalPath);
      this.spillHandle = await openExclusive(spillPath);

      const content = safeTraceJsonStringify(this.getManifestSnapshot(), 2) + '\n';
      if (this.fs.writeFileExclusive) {
        try {
          await this.fs.writeFileExclusive(manifestPath, content);
          createdFiles.push(manifestPath);
        } catch (err) {
          if (isAlreadyExistsError(err)) {
            throw createCodedError(
              'RecordingDirectoryNotEmpty',
              `manifest.json 已存在，拒绝覆盖现有档案: ${manifestPath}`,
            );
          }
          throw err;
        }
      } else {
        const mh = await openExclusive(manifestPath);
        const buf = Buffer.from(content, 'utf8');
        await writeAllChecked(mh, buf, 0, this.limits.rawChunkBytes);
        await mh.close();
      }
    } catch (err) {
      // 初始化失败仅回滚本次新建的句柄与文件，绝不触碰任何既有料件
      this.rawHandle = null;
      this.dataHandle = null;
      this.journalHandle = null;
      this.spillHandle = null;
      await Promise.allSettled(openedHandles.map((h) => h.close()));
      if (this.fs.unlink) {
        await Promise.allSettled(createdFiles.map((f) => this.fs.unlink!(f)));
      }
      throw err;
    }
  }

  private async initializeReadOnlyHandles(inspection: RecordingInspectionResult): Promise<void> {
    const rawPath = path.join(this.recordingDir, ORBIT_TRACE_FILES.raw);
    const dataPath = path.join(this.recordingDir, ORBIT_TRACE_FILES.data);
    const spillPath = path.join(this.recordingDir, 'index-spill.otidx');

    if (await this.fs.exists(rawPath)) {
      this.rawHandle = await this.fs.open(rawPath, 'r');
    }
    if (await this.fs.exists(dataPath)) {
      this.dataHandle = await this.fs.open(dataPath, 'r');
    }
    if (await this.fs.exists(spillPath)) {
      this.spillHandle = await this.fs.open(spillPath, 'r+');
    } else {
      // 只读恢复溢写时如果需要可创建临时溢写或保留在内存中
      this.spillHandle = null;
    }

    // 优先从 journal.otj 重建到可恢复提交边界（权威提交来源）
    let packetCount = 0;
    let sliceCount = 0;
    let activationCount = 0;
    let readyWaitCount = 0;
    let markerCount = 0;
    let markerPointCount = 0;
    let gapCount = 0;

    for (const frame of inspection.frames) {
      if (frame.meta.segments) {
        for (const seg of frame.meta.segments) {
          this.index.upsertSegment(seg);
        }
      }
      if (frame.meta.gaps) {
        for (const g of frame.meta.gaps) {
          this.index.addGap(g);
        }
      }
      if (frame.meta.pages) {
        for (const p of frame.meta.pages) {
          this.index.addPage(p, buildBasicLodSummaryFromDescriptor(p));
          if (p.pageId >= this.nextPageId) {
            this.nextPageId = p.pageId + 1;
          }
        }
      }
      if (frame.meta.tasks) {
        for (const t of frame.meta.tasks) {
          this.absorbTaskSummaryMetadata(t);
        }
      }
      if (frame.meta.decoderDiagnostics) {
        for (const d of frame.meta.decoderDiagnostics) {
          if (this.storedDecoderDiagnostics.length < TraceRecordingStore.MAX_STORED_DIAGNOSTICS) {
            this.storedDecoderDiagnostics.push(d);
          } else {
            this.droppedRecordedDiagnostics++;
          }
        }
      }
      if (frame.meta.reconstructorDiagnostics) {
        for (const r of frame.meta.reconstructorDiagnostics) {
          if (this.storedReconstructorDiagnostics.length < TraceRecordingStore.MAX_STORED_DIAGNOSTICS) {
            this.storedReconstructorDiagnostics.push(r);
          } else {
            this.droppedRecordedDiagnostics++;
          }
        }
      }
      if (frame.meta.droppedDiagnosticsCount) {
        this.droppedRecordedDiagnostics += frame.meta.droppedDiagnosticsCount;
      }
      if (frame.meta.countsDelta) {
        packetCount += frame.meta.countsDelta.packetCount ?? 0;
        sliceCount += frame.meta.countsDelta.sliceCount ?? 0;
        activationCount += frame.meta.countsDelta.activationCount ?? 0;
        readyWaitCount += frame.meta.countsDelta.readyWaitCount ?? 0;
        markerCount += frame.meta.countsDelta.markerCount ?? 0;
        markerPointCount += frame.meta.countsDelta.markerPointCount ?? 0;
        gapCount += frame.meta.countsDelta.gapCount ?? 0;
      }
    }

    // 若有序关闭提供了有效 index.otidx 且目录未损坏，可补充检验（但以 journal.otj 可恢复提交边界为准）
    const indexPath = path.join(this.recordingDir, ORBIT_TRACE_FILES.index);
    if (inspection.isComplete && inspection.indexStatus === 'valid' && (await this.fs.exists(indexPath))) {
      try {
        const snap = decodeIndexSnapshot(await this.fs.readFile(indexPath));
        for (const seg of snap.segments) {
          this.index.upsertSegment(seg);
        }
        for (const t of snap.tasks) {
          this.absorbTaskSummaryMetadata(t);
        }
      } catch {
        // 索引快照仅作辅助，journal.otj 已完成权威重建
      }
    }

    await this.index.enforceMemoryBounds();

    this.committed = {
      commitSeq: inspection.lastValidCommitSeq,
      rawBytes: inspection.recoverableRawBytes,
      dataBytes: inspection.recoverableDataBytes,
      journalBytes:
        inspection.frames.length > 0
          ? inspection.frames[inspection.frames.length - 1].frameOffset +
            inspection.frames[inspection.frames.length - 1].frameLength
          : 0,
      packetCount,
      sliceCount,
      activationCount,
      readyWaitCount,
      markerCount,
      markerPointCount,
      gapCount,
      segmentCount: this.index.getSegments().length,
    };
    this.sampleMemoryUsage();
  }

  private sampleMemoryUsage(): void {
    const mu = process.memoryUsage();
    if (mu.rss > this.peakRssBytes) {
      this.peakRssBytes = mu.rss;
    }
    if (mu.heapUsed > this.peakHeapUsedBytes) {
      this.peakHeapUsedBytes = mu.heapUsed;
    }
  }

  private getManifestSnapshot(): TraceRecordingManifest {
    return {
      format: ORBIT_TRACE_FORMAT,
      formatVersion: ORBIT_TRACE_FORMAT_VERSION,
      protocolVersion: SYSTEMVIEW_PROTOCOL_VERSION,
      nonStandardNotice: ORBIT_TRACE_NON_SVDAT_NOTICE,
      recordId: this.recordId,
      identity: { ...this.identity },
      createdAtMs: this.createdAtMs,
      updatedAtMs: this.updatedAtMs,
      closedAtMs: this.closedAtMs,
      state: this.state,
      closeReason: this.closeReason,
      failureCode: this.failureCode,
      ...(this.failureDiagnostics ? { failureDiagnostics: this.failureDiagnostics } : {}),
      decoderOptions: this.decoderOptions,
      committed: { ...this.committed },
      rawSha256: this.rawSha256,
      files: {
        raw: ORBIT_TRACE_FILES.raw,
        data: ORBIT_TRACE_FILES.data,
        journal: ORBIT_TRACE_FILES.journal,
        index: ORBIT_TRACE_FILES.index,
      },
      limits: {
        rawChunkBytes: this.limits.rawChunkBytes,
        pageMaxItems: this.limits.pageMaxItems,
        pageMaxBytes: this.limits.pageMaxBytes,
        maxCacheBytes: this.limits.maxCacheBytes,
        maxCachedPages: this.limits.maxCachedPages,
        maxIndexPagesInMemory: this.limits.maxIndexPagesInMemory,
        maxWriteQueueBytes: this.limits.maxWriteQueueBytes,
        maxSingleBatchBytes: this.limits.maxSingleBatchBytes,
      },
    };
  }

  private async writeManifestAtomic(): Promise<void> {
    const manifestPath = path.join(this.recordingDir, ORBIT_TRACE_FILES.manifest);
    const tmpPath = path.join(this.recordingDir, ORBIT_TRACE_FILES.manifestTmp);
    const content = safeTraceJsonStringify(this.getManifestSnapshot(), 2) + '\n';
    await this.fs.writeFile(tmpPath, content);
    await this.fs.rename(tmpPath, manifestPath);
  }

  public getState(): RecordingLifecycleState {
    return this.state;
  }

  public isClosed(): boolean {
    return this.closed;
  }

  public getIdentity(): TraceReconstructionIdentity {
    return { ...this.identity };
  }

  public getInspection(): RecordingInspectionResult | undefined {
    return this.inspection;
  }

  public getStats(): TraceStorageStats {
    this.sampleMemoryUsage();
    return {
      recordId: this.recordId,
      state: this.state,
      closed: this.closed,
      limits: this.limits,
      committed: { ...this.committed },
      pendingRawBytes: this.pendingRawBytes,
      writeQueueBytes: this.writeQueueBytes,
      peakWriteQueueBytes: this.peakWriteQueueBytes,
      cache: this.cache.getStats(),
      index: this.index.getStats(),
      peakRssBytes: this.peakRssBytes,
      peakHeapUsedBytes: this.peakHeapUsedBytes,
    };
  }

  public getSegments(): readonly SegmentIndexMetadata[] {
    return this.index.getSegments();
  }

  public getGaps(): readonly StoredGapEntry[] {
    return this.index.getGaps();
  }

  private checkWriteWritable(): TraceStorageFailure | null {
    if (this.closed) {
      return { ok: false, errorCode: 'RecordingClosed', message: `录制 ${this.recordId} 已关闭` };
    }
    if (this.mode !== 'write') {
      return { ok: false, errorCode: 'RecordingClosed', message: `录制 ${this.recordId} 为只读打开模式` };
    }
    if (this.state === 'failed') {
      return {
        ok: false,
        errorCode: (this.failureCode as TraceStorageErrorCode) ?? 'RecordingFailed',
        message: `录制 ${this.recordId} 已因存储故障停止接受写入 (${this.failureCode ?? 'unknown'})`,
      };
    }
    if (this.state !== 'recording') {
      return {
        ok: false,
        errorCode: 'RecordingClosed',
        message: `录制 ${this.recordId} 当前状态为 ${this.state}，禁止继续写入`,
      };
    }
    return null;
  }

  private validateIdentityInput(meta?: IngestRawChunkMeta): TraceStorageFailure | null {
    if (!meta) {
      return null;
    }
    if (meta.recordId !== undefined && meta.recordId !== this.recordId) {
      return {
        ok: false,
        errorCode: 'RecordChanged',
        message: `recordId 不匹配: expected=${this.recordId}, actual=${meta.recordId}`,
      };
    }
    if (meta.sessionId !== undefined && meta.sessionId !== this.identity.sessionId) {
      return {
        ok: false,
        errorCode: 'SessionChanged',
        message: `sessionId 不匹配: expected=${this.identity.sessionId}, actual=${meta.sessionId}`,
      };
    }
    if (meta.sessionGeneration !== undefined && meta.sessionGeneration !== this.identity.sessionGeneration) {
      return {
        ok: false,
        errorCode: 'SessionChanged',
        message: `sessionGeneration 不匹配: expected=${this.identity.sessionGeneration}, actual=${meta.sessionGeneration}`,
      };
    }
    return null;
  }

  private validatePreIngest(meta: IngestRawChunkMeta): TraceStorageFailure | null {
    const idErr = this.validateIdentityInput(meta);
    if (idErr) {
      return idErr;
    }
    if (!this.decoder || !this.reconstructor) {
      return { ok: false, errorCode: 'RecordingClosed', message: '缺少写入解码器/重建器' };
    }
    const reconState = this.reconstructor.getState();
    if (reconState.finished) {
      return { ok: false, errorCode: 'RecordingClosed', message: '重建器已完成，拒绝接收后续批次' };
    }
    if (meta.bootGeneration !== undefined) {
      if (!Number.isInteger(meta.bootGeneration) || meta.bootGeneration < reconState.identity.bootGeneration) {
        return {
          ok: false,
          errorCode: 'StaleBootGeneration',
          message: `过期 bootGeneration: current=${reconState.identity.bootGeneration}, received=${meta.bootGeneration}`,
        };
      }
    }
    if (meta.batchSequence !== undefined) {
      if (!Number.isInteger(meta.batchSequence) || meta.batchSequence < 0) {
        return {
          ok: false,
          errorCode: 'BatchSequenceInvalid',
          message: `非法批次序号: ${meta.batchSequence}`,
        };
      }
      if (reconState.lastBatchSequence !== null) {
        if (meta.batchSequence <= reconState.lastBatchSequence) {
          return {
            ok: false,
            errorCode: 'BatchSequenceInvalid',
            message: `批次序号乱序或重复: last=${reconState.lastBatchSequence}, received=${meta.batchSequence}`,
          };
        }
        if (meta.batchSequence !== reconState.lastBatchSequence + 1 && !this.sequenceGapDeclared) {
          return {
            ok: false,
            errorCode: 'BatchSequenceGap',
            message: `批次序号不连续（存在未送达批次）: expected=${reconState.lastBatchSequence + 1}, received=${meta.batchSequence}`,
            diagnostics: {
              expectedBatchSequence: reconState.lastBatchSequence + 1,
              receivedBatchSequence: meta.batchSequence,
            },
          };
        }
      }
    }
    return null;
  }

  private async failPipeline(errorCode: TraceStorageErrorCode, message: string): Promise<TraceStorageFailure> {
    this.state = 'failed';
    this.failureCode = errorCode;
    this.closeReason = message;
    this.updatedAtMs = Date.now();
    this.pendingRawChunks = [];
    this.pendingRawBytes = 0;
    this.queuedDataPages = [];
    this.activePageBuffers.clear();
    this.writeQueueBytes = 0;
    try {
      await this.writeManifestAtomic();
    } catch {
      // 忽略二次错误
    }
    return {
      ok: false,
      errorCode,
      message,
      diagnostics: {
        committedRawBytes: this.committed.rawBytes,
        committedCommitSeq: this.committed.commitSeq,
      },
    };
  }

  /**
   * 写入一段原始 SystemView 字节块：
   * - 在推进任何解码/重建状态前完整校验身份、bootGeneration、batchSequence 与单批/写队列上限（可恢复拒绝零副作用）；
   * - 驱动 4.1 解码与 4.2 重建；若派生状态不可回滚却超预算或失败，则立即终止录制并标为不完整；
   * - 精确分块持久化 `raw.otbin`、`data.otd` 与 `journal.otj`。
   */
  public async ingestRawChunk(
    chunk: Uint8Array,
    meta: IngestRawChunkMeta = {},
  ): Promise<TraceStorageResult<IngestBatchSummary>> {
    const writableErr = this.checkWriteWritable();
    if (writableErr) {
      return writableErr;
    }
    const preErr = this.validatePreIngest(meta);
    if (preErr) {
      return preErr;
    }
    if (chunk.length > this.limits.maxSingleBatchBytes) {
      return {
        ok: false,
        errorCode: 'BatchLimitExceeded',
        message: `单批字节长度 ${chunk.length} 超过上限 ${this.limits.maxSingleBatchBytes}`,
      };
    }
    if (this.writeQueueBytes + chunk.length > this.limits.maxWriteQueueBytes) {
      return {
        ok: false,
        errorCode: 'WriteQueueFull',
        message: `写队列缓冲 ${this.writeQueueBytes + chunk.length} 超过上限 ${this.limits.maxWriteQueueBytes}`,
      };
    }

    let decodeBatch: SystemViewDecodeBatch;
    try {
      decodeBatch = this.decoder!.push(chunk);
    } catch (err) {
      return await this.failPipeline(
        'InvalidArgument',
        `流式解码异常导致状态不可回滚，终止录制: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const reconBatch = this.reconstructor!.pushBatch(decodeBatch, {
      identity: {
        sessionId: meta.sessionId ?? this.identity.sessionId,
        sessionGeneration: meta.sessionGeneration ?? this.identity.sessionGeneration,
        bootGeneration: meta.bootGeneration ?? this.identity.bootGeneration,
        recordId: this.recordId,
      },
      batchSequence: meta.batchSequence,
    });

    if (!reconBatch.accepted) {
      return await this.failPipeline(
        (reconBatch.errorCode as TraceStorageErrorCode) ?? 'InvalidArgument',
        `解码后重建拒绝批次且状态不可回滚，终止录制: ${reconBatch.rejectionReason ?? 'unknown'}`,
      );
    }

    // 校验派生块规模：若单个块的派生数据加上当前写队列超出 maxWriteQueueBytes，
    // 先尝试排空既有已接受队列；若单批自身仍超写队列上限，因解码器已推进，立即终止并标记不完整
    const derivedEstimateBytes =
      chunk.length +
      decodeBatch.packets.length * 72 +
      reconBatch.executionSlices.length * 96 +
      reconBatch.contextActivations.length * 128 +
      reconBatch.readyWaits.length * 96 +
      reconBatch.markers.length * 96 +
      reconBatch.markerPoints.length * 64;

    if (this.writeQueueBytes > 0 && this.writeQueueBytes + derivedEstimateBytes > this.limits.maxWriteQueueBytes) {
      const flushOld = await this.commitPending(JOURNAL_FRAME_KIND.CHUNK_COMMIT, true);
      if (!flushOld.ok) {
        return flushOld;
      }
    }
    if (this.writeQueueBytes + derivedEstimateBytes > this.limits.maxWriteQueueBytes) {
      return await this.failPipeline(
        'WriteQueueFull',
        `单批派生输出估算 ${derivedEstimateBytes} 字节超过写队列上限 ${this.limits.maxWriteQueueBytes}，终止录制并保留此前提交前缀`,
      );
    }

    if (meta.batchSequence !== undefined) {
      this.sequenceGapDeclared = false;
    }
    if (meta.bootGeneration !== undefined && meta.bootGeneration > this.identity.bootGeneration) {
      this.identity = { ...this.identity, bootGeneration: meta.bootGeneration };
    }

    // 仅在 4.1/4.2 与派生预算均通过后才将本批原始字节与产物入队
    if (chunk.length > 0) {
      const copy = Buffer.from(chunk);
      this.pendingRawChunks.push(copy);
      this.pendingRawBytes += copy.length;
      this.writeQueueBytes += copy.length;
      if (this.writeQueueBytes > this.peakWriteQueueBytes) {
        this.peakWriteQueueBytes = this.writeQueueBytes;
      }
    }
    if (meta.batchSequence !== undefined) {
      this.pendingBatchSequences.push(meta.batchSequence);
    }

    await this.absorbBatches(decodeBatch, reconBatch);

    const shouldCommit =
      meta.flush === true ||
      this.commitOnEachIngest ||
      this.pendingRawBytes >= this.limits.rawChunkBytes;

    if (shouldCommit) {
      const commitRes = await this.commitPending(JOURNAL_FRAME_KIND.CHUNK_COMMIT, true);
      if (!commitRes.ok) {
        return commitRes;
      }
    }

    const tail = decodeBatch.packets.at(-1);
    const clockTail = tail?.sysFreqHz && tail.segmentReliability !== 'uncertain' && !decodeBatch.gaps.length
      ? { segmentId: tail.segmentId, relativeTicks: tail.segmentRelativeTicks, frequencyHz: tail.sysFreqHz }
      : undefined;
    this.sampleMemoryUsage();
    return {
      ok: true,
      data: {
        commitSeq: this.committed.commitSeq,
        committedRawBytes: this.committed.rawBytes,
        packetsDecoded: decodeBatch.packets.length,
        slicesEmitted: reconBatch.executionSlices.length,
        ...(clockTail ? { clockTail } : {}),
        activationsEmitted: reconBatch.contextActivations.length,
        readyWaitsEmitted: reconBatch.readyWaits.length,
        markersEmitted: reconBatch.markers.length,
        markerPointsEmitted: reconBatch.markerPoints.length,
        gapsRecorded: reconBatch.gapBoundaries.length,
      },
    };
  }

  /**
   * 直接消费外部提供的 4.1/4.2 批次（并可选附带该批次对应的精确原始字节），保留完整元数据与 BigInt 精度。
   */
  public async ingestDecodedBatches(
    decodeBatch: SystemViewDecodeBatch,
    reconBatch: TraceReconstructBatch,
    rawChunk?: Uint8Array,
    flush = true,
  ): Promise<TraceStorageResult<IngestBatchSummary>> {
    const writableErr = this.checkWriteWritable();
    if (writableErr) {
      return writableErr;
    }
    if (!reconBatch.accepted) {
      return {
        ok: false,
        errorCode: (reconBatch.errorCode as TraceStorageErrorCode) ?? 'InvalidArgument',
        message: reconBatch.rejectionReason ?? '重建批次未被接受',
      };
    }
    if (
      reconBatch.identity.recordId !== this.recordId ||
      reconBatch.identity.sessionId !== this.identity.sessionId ||
      reconBatch.identity.sessionGeneration !== this.identity.sessionGeneration
    ) {
      return {
        ok: false,
        errorCode: reconBatch.identity.recordId !== this.recordId ? 'RecordChanged' : 'SessionChanged',
        message: '批次身份与当前录制不一致',
      };
    }
    const estimatedBytes =
      (rawChunk?.length ?? 0) +
      decodeBatch.packets.length * 72 +
      reconBatch.executionSlices.length * 96 +
      reconBatch.contextActivations.length * 128 +
      reconBatch.readyWaits.length * 96 +
      reconBatch.markers.length * 96 +
      reconBatch.markerPoints.length * 64;
    if (estimatedBytes > this.limits.maxSingleBatchBytes) {
      return {
        ok: false,
        errorCode: 'BatchLimitExceeded',
        message: `单批估算字节 ${estimatedBytes} 超过上限 ${this.limits.maxSingleBatchBytes}`,
      };
    }
    if (this.writeQueueBytes + estimatedBytes > this.limits.maxWriteQueueBytes) {
      return {
        ok: false,
        errorCode: 'WriteQueueFull',
        message: `写队列缓冲 ${this.writeQueueBytes + estimatedBytes} 超过上限 ${this.limits.maxWriteQueueBytes}`,
      };
    }
    if (rawChunk && rawChunk.length > 0) {
      const copy = Buffer.from(rawChunk);
      this.pendingRawChunks.push(copy);
      this.pendingRawBytes += copy.length;
      this.writeQueueBytes += copy.length;
      if (this.writeQueueBytes > this.peakWriteQueueBytes) {
        this.peakWriteQueueBytes = this.writeQueueBytes;
      }
    }

    await this.absorbBatches(decodeBatch, reconBatch);

    if (flush || this.commitOnEachIngest || this.pendingRawBytes >= this.limits.rawChunkBytes) {
      const commitRes = await this.commitPending(JOURNAL_FRAME_KIND.CHUNK_COMMIT, true);
      if (!commitRes.ok) {
        return commitRes;
      }
    }

    return {
      ok: true,
      data: {
        commitSeq: this.committed.commitSeq,
        committedRawBytes: this.committed.rawBytes,
        packetsDecoded: decodeBatch.packets.length,
        slicesEmitted: reconBatch.executionSlices.length,
        activationsEmitted: reconBatch.contextActivations.length,
        readyWaitsEmitted: reconBatch.readyWaits.length,
        markersEmitted: reconBatch.markers.length,
        markerPointsEmitted: reconBatch.markerPoints.length,
        gapsRecorded: reconBatch.gapBoundaries.length,
      },
    };
  }

  public async markGap(gap: TraceGapInput): Promise<TraceStorageResult<IngestBatchSummary>> {
    const writableErr = this.checkWriteWritable();
    if (writableErr) {
      return writableErr;
    }
    if (!this.decoder || !this.reconstructor) {
      return { ok: false, errorCode: 'RecordingClosed', message: '缺少写入解码器/重建器' };
    }
    const decodeBatch = this.decoder.markGap(gap);
    const reconBatch = this.reconstructor.pushBatch(decodeBatch, { identity: this.identity });
    if (!reconBatch.accepted) {
      return await this.failPipeline(
        (reconBatch.errorCode as TraceStorageErrorCode) ?? 'InvalidArgument',
        reconBatch.rejectionReason ?? 'markGap 被重建器拒绝',
      );
    }
    this.sequenceGapDeclared = true;
    await this.absorbBatches(decodeBatch, reconBatch);
    const commitRes = await this.commitPending(JOURNAL_FRAME_KIND.GAP_MARK, true);
    if (!commitRes.ok) {
      return commitRes;
    }
    return {
      ok: true,
      data: {
        commitSeq: this.committed.commitSeq,
        committedRawBytes: this.committed.rawBytes,
        packetsDecoded: decodeBatch.packets.length,
        slicesEmitted: reconBatch.executionSlices.length,
        activationsEmitted: reconBatch.contextActivations.length,
        readyWaitsEmitted: reconBatch.readyWaits.length,
        markersEmitted: reconBatch.markers.length,
        markerPointsEmitted: reconBatch.markerPoints.length,
        gapsRecorded: reconBatch.gapBoundaries.length,
      },
    };
  }

  public async notifyTargetReset(
    nextBootGeneration?: number,
    reason?: string,
  ): Promise<TraceStorageResult<IngestBatchSummary>> {
    const writableErr = this.checkWriteWritable();
    if (writableErr) {
      return writableErr;
    }
    if (!this.decoder || !this.reconstructor) {
      return { ok: false, errorCode: 'RecordingClosed', message: '缺少写入解码器/重建器' };
    }
    const prevBoot = this.identity.bootGeneration;
    if (
      nextBootGeneration !== undefined &&
      (!Number.isInteger(nextBootGeneration) || nextBootGeneration <= prevBoot)
    ) {
      return {
        ok: false,
        errorCode: 'StaleBootGeneration',
        message: `无效目标复位代次 ${nextBootGeneration}（当前 bootGeneration=${prevBoot}）`,
      };
    }

    const decodeBatch = this.decoder.markGap({
      kind: 'transport-gap',
      reason: reason ?? '目标复位，开启新 bootGeneration',
      preservesFraming: false,
    });
    const r1 = this.reconstructor.pushBatch(decodeBatch, { identity: this.identity });
    if (!r1.accepted) {
      return await this.failPipeline(
        (r1.errorCode as TraceStorageErrorCode) ?? 'StaleBootGeneration',
        r1.rejectionReason ?? 'reset 前置批次失败',
      );
    }
    const r2 = this.reconstructor.notifyTargetReset(nextBootGeneration, reason);
    if (!r2.accepted) {
      return await this.failPipeline(
        (r2.errorCode as TraceStorageErrorCode) ?? 'StaleBootGeneration',
        r2.rejectionReason ?? '无效目标复位代次',
      );
    }
    this.sequenceGapDeclared = true;
    this.identity = { ...this.identity, bootGeneration: r2.identity.bootGeneration };
    await this.absorbBatches(decodeBatch, r1);
    await this.absorbBatches({ packets: [], syncs: [], gaps: [], segments: [], diagnostics: [] }, r2);
    const commitRes = await this.commitPending(JOURNAL_FRAME_KIND.BOOT_RESET, true, {
      resetSummary: {
        previousBootGeneration: prevBoot,
        nextBootGeneration: r2.identity.bootGeneration,
        reason: reason ?? '目标复位',
      },
    });
    if (!commitRes.ok) {
      return commitRes;
    }
    return {
      ok: true,
      data: {
        commitSeq: this.committed.commitSeq,
        committedRawBytes: this.committed.rawBytes,
        packetsDecoded: decodeBatch.packets.length,
        slicesEmitted: r1.executionSlices.length + r2.executionSlices.length,
        activationsEmitted: r1.contextActivations.length + r2.contextActivations.length,
        readyWaitsEmitted: r1.readyWaits.length + r2.readyWaits.length,
        markersEmitted: r1.markers.length + r2.markers.length,
        markerPointsEmitted: r1.markerPoints.length + r2.markerPoints.length,
        gapsRecorded: r1.gapBoundaries.length + r2.gapBoundaries.length,
      },
    };
  }

  public async flush(): Promise<TraceStorageResult<{ commitSeq: number; committedRawBytes: number }>> {
    const writableErr = this.checkWriteWritable();
    if (writableErr) {
      return writableErr;
    }
    const res = await this.commitPending(JOURNAL_FRAME_KIND.CHUNK_COMMIT, true);
    if (!res.ok) {
      return res;
    }
    return {
      ok: true,
      data: {
        commitSeq: this.committed.commitSeq,
        committedRawBytes: this.committed.rawBytes,
      },
    };
  }

  /**
   * 封存录制：
   * - 默认（`terminalState` 未指定或为 `'completed'`）：有序关闭，写入 `CLEAN_CLOSE` 帧与 `rawSha256`，
   *   并原子更新 `manifest.json`（`state='completed'`）与 `index.otidx`（保留 4.3 原有行为）。
   * - 显式失败/中断（`terminalState: 'interrupted' | 'failed'`）：保留已解码与已提交的有效前缀后，
   *   写入 `FAILURE_MARK` 帧（绝不写 `CLEAN_CLOSE`），保存明确 `state`、`failureCode`、`closeReason` 与诊断，
   *   确保落盘 `manifest.json` / `journal.otj` / `open()` 重开状态完全一致。
   */
  public async finish(
    reason = 'clean-finish',
    options?: {
      terminalState?: 'completed' | 'interrupted' | 'failed';
      failureCode?: string;
      diagnostics?: Record<string, unknown>;
    },
  ): Promise<TraceStorageResult<TraceRecordingManifest>> {
    const writableErr = this.checkWriteWritable();
    if (writableErr) {
      return writableErr;
    }
    const terminalState = options?.terminalState ?? 'completed';
    if (this.decoder && this.reconstructor) {
      const endDecode = this.decoder.finish();
      const r1 = this.reconstructor.pushBatch(endDecode, { identity: this.identity });
      if (!r1.accepted) {
        return {
          ok: false,
          errorCode: (r1.errorCode as TraceStorageErrorCode) ?? 'InvalidArgument',
          message: r1.rejectionReason ?? 'finish 前置批次被拒绝',
        };
      }
      const r2 = this.reconstructor.finish();
      await this.absorbBatches(endDecode, r1);
      await this.absorbBatches({ packets: [], syncs: [], gaps: [], segments: [], diagnostics: [] }, r2);
    }

    // 先提交所有剩余有效原始字节和挂起页，保留完整前缀
    const preCommit = await this.commitPending(JOURNAL_FRAME_KIND.CHUNK_COMMIT, true);
    if (!preCommit.ok) {
      return preCommit;
    }

    const rawSha256 = this.rawHash.digest('hex');
    this.rawSha256 = rawSha256;

    const isAbnormalFinish = terminalState === 'interrupted' || terminalState === 'failed';
    const terminalMeta: JournalCommitMetadata = isAbnormalFinish
      ? {
          bootGeneration: this.identity.bootGeneration,
          identity: { ...this.identity },
          failureSummary: {
            errorCode: options?.failureCode || (terminalState === 'interrupted' ? 'Interrupted' : 'Failed'),
            message: reason,
            terminalState,
            rawSha256,
            totalRawBytes: this.committed.rawBytes,
            committed: { ...this.committed },
            ...(options?.diagnostics ? { diagnostics: options.diagnostics } : {}),
          },
        }
      : {
          bootGeneration: this.identity.bootGeneration,
          identity: { ...this.identity },
          closeSummary: {
            reason,
            rawSha256,
            totalRawBytes: this.committed.rawBytes,
            totalDataBytes: this.committed.dataBytes,
            committed: { ...this.committed },
          },
        };

    try {
      const closeFrame = encodeJournalFrame({
        frameKind: isAbnormalFinish ? JOURNAL_FRAME_KIND.FAILURE_MARK : JOURNAL_FRAME_KIND.CLEAN_CLOSE,
        commitSeq: this.committed.commitSeq + 1,
        rawOffset: this.committed.rawBytes,
        rawLength: 0,
        rawCrc32: 0,
        dataOffset: this.committed.dataBytes,
        dataLength: 0,
        dataCrc32: 0,
        meta: terminalMeta,
      });
      await writeAllChecked(this.journalHandle!, closeFrame, this.committed.journalBytes, this.limits.rawChunkBytes);
      await this.journalHandle!.sync();

      this.committed = {
        ...this.committed,
        commitSeq: this.committed.commitSeq + 1,
        journalBytes: this.committed.journalBytes + closeFrame.length,
        segmentCount: this.index.getSegments().length,
      };
      this.state = terminalState;
      this.closeReason = reason;
      if (isAbnormalFinish) {
        this.failureCode = options?.failureCode || (terminalState === 'interrupted' ? 'Interrupted' : 'Failed');
        this.failureDiagnostics = options?.diagnostics;
      } else {
        this.failureCode = undefined;
        this.failureDiagnostics = undefined;
      }
      this.closedAtMs = Date.now();
      this.updatedAtMs = this.closedAtMs;

      // 写入可选索引快照
      const indexBytes = encodeIndexSnapshot({
        format: ORBIT_TRACE_FORMAT,
        formatVersion: ORBIT_TRACE_FORMAT_VERSION,
        segments: this.index.getSegments(),
        pages: this.index.getAllInMemoryPages(),
        gaps: this.index.getGaps(),
        tasks: Array.from(this.pendingTasks.values()),
      });
      const idxPath = path.join(this.recordingDir, ORBIT_TRACE_FILES.index);
      const idxTmpPath = path.join(this.recordingDir, ORBIT_TRACE_FILES.indexTmp);
      await this.fs.writeFile(idxTmpPath, indexBytes);
      await this.fs.rename(idxTmpPath, idxPath);

      await this.writeManifestAtomic();
    } catch (err) {
      return await this.handleStorageFailure(err);
    }

    // 有序封存后仅关闭只写日志句柄，保留 raw/data/spill 供同一录制后续查询与原始导出直到 close()
    const jh = this.journalHandle;
    this.journalHandle = null;
    if (jh) {
      await jh.close().catch(() => {});
    }
    return { ok: true, data: this.getManifestSnapshot() };
  }

  /**
   * 幂等关闭所有底层文件句柄与缓存资源（保证不会发生二次 release）。
   */
  public async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const handles = [this.rawHandle, this.dataHandle, this.journalHandle, this.spillHandle];
    this.rawHandle = null;
    this.dataHandle = null;
    this.journalHandle = null;
    this.spillHandle = null;
    this.cache.clear();
    this.pendingRawChunks = [];
    this.pendingRawBytes = 0;
    this.writeQueueBytes = 0;
    await Promise.allSettled(handles.filter((h): h is TraceFileHandle => h !== null).map((h) => h.close()));
  }

  private async absorbBatches(decodeBatch: SystemViewDecodeBatch, reconBatch: TraceReconstructBatch): Promise<void> {
    const bootGen = reconBatch.identity.bootGeneration;

    // 1. 段摘要更新
    for (const seg of decodeBatch.segments) {
      this.updateSegmentFromDecoder(bootGen, seg);
    }

    // 2. 分页吸纳解码包
    for (const pkt of decodeBatch.packets) {
      this.ensureSegmentForPacket(bootGen, pkt);
      this.absorbPacketSummaryMetadata(bootGen, pkt);
      this.pendingCountsDelta.packetCount += 1;
      await this.appendItemToBuffer('packets', bootGen, pkt.segmentId, pkt, estimatePacketBytes(pkt));
    }

    // 3. 分页吸纳重建区间（区分常规时间页与跨页长区间）
    for (const s of reconBatch.executionSlices) {
      this.pendingCountsDelta.sliceCount += 1;
      const isLong = this.shouldRouteToLongBuffer(bootGen, s.segmentId, 'slices', s.start?.relativeTicksBigInt, s.end?.relativeTicksBigInt);
      await this.appendItemToBuffer(isLong ? 'longSlices' : 'slices', bootGen, s.segmentId, s, 96);
    }
    for (const a of reconBatch.contextActivations) {
      this.pendingCountsDelta.activationCount += 1;
      const isLong = this.shouldRouteToLongBuffer(
        bootGen,
        a.segmentId,
        'activations',
        a.start?.relativeTicksBigInt,
        a.end?.relativeTicksBigInt,
      );
      await this.appendItemToBuffer(isLong ? 'longActivations' : 'activations', bootGen, a.segmentId, a, 128);
    }
    for (const rw of reconBatch.readyWaits) {
      this.pendingCountsDelta.readyWaitCount += 1;
      const isLong = this.shouldRouteToLongBuffer(
        bootGen,
        rw.segmentId,
        'readyWaits',
        rw.start?.relativeTicksBigInt,
        rw.end?.relativeTicksBigInt,
      );
      await this.appendItemToBuffer(isLong ? 'longReadyWaits' : 'readyWaits', bootGen, rw.segmentId, rw, 96);
    }
    for (const m of reconBatch.markers) {
      this.pendingCountsDelta.markerCount += 1;
      const isLong = this.shouldRouteToLongBuffer(bootGen, m.segmentId, 'markers', m.start?.relativeTicksBigInt, m.end?.relativeTicksBigInt);
      await this.appendItemToBuffer(isLong ? 'longMarkers' : 'markers', bootGen, m.segmentId, m, 96);
    }
    for (const mp of reconBatch.markerPoints) {
      this.pendingCountsDelta.markerPointCount += 1;
      await this.appendItemToBuffer('markerPoints', bootGen, mp.segmentId, mp, 64);
    }

    // 4. 缺口与任务摘要
    for (const g of reconBatch.gapBoundaries) {
      this.pendingCountsDelta.gapCount += 1;
      const entry: StoredGapEntry = {
        seq: this.nextGapSeq++,
        bootGeneration: g.bootGeneration,
        kind: g.kind,
        segmentIdBefore: g.segmentIdBefore,
        byteOffset: g.byteOffset ?? 0,
        droppedPackets: g.droppedPackets,
        droppedBytes: g.droppedBytes,
        reason: g.reason,
        closedOpenCount: g.closedOpenCount,
      };
      this.pendingGaps.push(entry);
      this.index.addGap(entry);
    }

    for (const t of reconBatch.taskUpdates) {
      this.pendingTasks.set(t.taskInstanceId, t);
      this.absorbTaskSummaryMetadata(t);
    }

    for (const diag of decodeBatch.diagnostics) {
      if (this.storedDecoderDiagnostics.length < TraceRecordingStore.MAX_STORED_DIAGNOSTICS) {
        this.storedDecoderDiagnostics.push(diag);
        this.pendingDecoderDiagnostics.push(diag);
      } else {
        this.droppedRecordedDiagnostics++;
      }
    }
    for (const rdiag of reconBatch.diagnostics) {
      if (this.storedReconstructorDiagnostics.length < TraceRecordingStore.MAX_STORED_DIAGNOSTICS) {
        this.storedReconstructorDiagnostics.push(rdiag);
        this.pendingReconstructorDiagnostics.push(rdiag);
      } else {
        this.droppedRecordedDiagnostics++;
      }
    }

    // 更新活跃段当前相对/绝对时间边界
    if (this.decoder) {
      const snap = this.decoder.getState();
      if (snap.activeSegment) {
        this.updateSegmentFromDecoder(bootGen, snap.activeSegment);
      }
    }
  }

  private shouldRouteToLongBuffer(
    bootGen: number,
    segmentId: number,
    regularKind: 'slices' | 'activations' | 'readyWaits' | 'markers',
    startTicks?: bigint,
    endTicks?: bigint,
  ): boolean {
    if (startTicks === undefined) {
      return true;
    }
    if (
      this.limits.longIntervalThresholdTicks !== undefined &&
      endTicks !== undefined &&
      endTicks - startTicks >= this.limits.longIntervalThresholdTicks
    ) {
      return true;
    }
    const key = `${bootGen}:${segmentId}:${regularKind}`;
    const lastFinalizedMaxEnd = this.regularMaxEndByPartKind.get(key);
    if (lastFinalizedMaxEnd !== undefined && startTicks < lastFinalizedMaxEnd) {
      return true;
    }
    return false;
  }

  private ensureSegmentForPacket(bootGen: number, pkt: DecodedSystemViewPacket): void {
    const key = `${bootGen}:${pkt.segmentId}`;
    let seg = this.pendingSegments.get(key) ?? this.index.getSegment(bootGen, pkt.segmentId);
    const rel = pkt.segmentRelativeTicksBigInt;
    const abs = pkt.absoluteTicksBigInt;
    const freq = pkt.sysFreqHz;
    const ns = pkt.timestampNs ?? (abs !== undefined && freq && freq > 0 ? ticksToNsBigInt(abs, freq).toString() : undefined);

    if (!seg) {
      seg = {
        bootGeneration: bootGen,
        segmentId: pkt.segmentId,
        startByteOffset: pkt.streamByteOffset,
        endByteOffset: pkt.streamByteOffset + pkt.byteLength,
        reliability: pkt.segmentReliability,
        closed: false,
        packetCount: 1,
        syncCount: 0,
        timestampBits: 32,
        timestampWrapCount: pkt.timestampWrapped ? 1 : 0,
        timeAnchorStatus: pkt.timeAnchorStatus,
        minRelativeTicks: rel.toString(),
        maxRelativeTicks: rel.toString(),
        firstAbsoluteTicks: abs?.toString(),
        lastAbsoluteTicks: abs?.toString(),
        sysFreqHz: freq,
        minNs: ns,
        maxNs: ns,
      };
    } else {
      const minRel = BigInt(seg.minRelativeTicks);
      const maxRel = BigInt(seg.maxRelativeTicks);
      let firstAbs = seg.firstAbsoluteTicks;
      let lastAbs = seg.lastAbsoluteTicks;
      if (abs !== undefined) {
        if (firstAbs === undefined || abs < BigInt(firstAbs)) firstAbs = abs.toString();
        if (lastAbs === undefined || abs > BigInt(lastAbs)) lastAbs = abs.toString();
      }
      let minNs = seg.minNs;
      let maxNs = seg.maxNs;
      if (ns !== undefined) {
        const nsBig = BigInt(ns);
        if (minNs === undefined || nsBig < BigInt(minNs)) minNs = ns;
        if (maxNs === undefined || nsBig > BigInt(maxNs)) maxNs = ns;
      }
      seg = {
        ...seg,
        endByteOffset: Math.max(seg.endByteOffset ?? 0, pkt.streamByteOffset + pkt.byteLength),
        reliability: pkt.segmentReliability === 'uncertain' ? 'uncertain' : seg.reliability,
        packetCount: Math.max(seg.packetCount, pkt.packetIndexInSegment + 1),
        timestampWrapCount: seg.timestampWrapCount + (pkt.timestampWrapped ? 1 : 0),
        timeAnchorStatus: pkt.timeAnchorStatus !== 'unanchored' ? pkt.timeAnchorStatus : seg.timeAnchorStatus,
        minRelativeTicks: (rel < minRel ? rel : minRel).toString(),
        maxRelativeTicks: (rel > maxRel ? rel : maxRel).toString(),
        firstAbsoluteTicks: firstAbs,
        lastAbsoluteTicks: lastAbs,
        sysFreqHz: freq ?? seg.sysFreqHz,
        minNs,
        maxNs,
      };
    }
    this.pendingSegments.set(key, seg);
    this.index.upsertSegment(seg);
  }

  private updateSegmentFromDecoder(bootGen: number, decSeg: TraceSegmentSummary): void {
    const key = `${bootGen}:${decSeg.segmentId}`;
    const existing = this.pendingSegments.get(key) ?? this.index.getSegment(bootGen, decSeg.segmentId);
    const freq = decSeg.metadata?.sysFreqHz ?? existing?.sysFreqHz;
    const minNs =
      decSeg.firstAbsoluteTicks !== undefined && freq && freq > 0
        ? ticksToNsBigInt(BigInt(decSeg.firstAbsoluteTicks), freq).toString()
        : existing?.minNs;
    const maxNs =
      decSeg.lastAbsoluteTicks !== undefined && freq && freq > 0
        ? ticksToNsBigInt(BigInt(decSeg.lastAbsoluteTicks), freq).toString()
        : existing?.maxNs;

    const merged: SegmentIndexMetadata = {
      bootGeneration: bootGen,
      segmentId: decSeg.segmentId,
      startByteOffset: decSeg.startByteOffset,
      endByteOffset: decSeg.endByteOffset ?? existing?.endByteOffset,
      reliability: decSeg.reliability,
      closed: decSeg.closed,
      endReason: decSeg.endReason ?? existing?.endReason,
      packetCount: decSeg.packetCount,
      syncCount: decSeg.syncCount,
      timestampBits: decSeg.timestampBits,
      timestampWrapCount: decSeg.timestampWrapCount,
      timeAnchorStatus: decSeg.timeAnchorStatus,
      minRelativeTicks: existing?.minRelativeTicks ?? '0',
      maxRelativeTicks: decSeg.relativeTicksTotal,
      firstAbsoluteTicks: decSeg.firstAbsoluteTicks ?? existing?.firstAbsoluteTicks,
      lastAbsoluteTicks: decSeg.lastAbsoluteTicks ?? existing?.lastAbsoluteTicks,
      sysFreqHz: freq,
      minNs,
      maxNs,
    };
    this.pendingSegments.set(key, merged);
    this.index.upsertSegment(merged);
  }

  private async appendItemToBuffer(
    kind: TracePageKind,
    bootGen: number,
    segmentId: number,
    item: unknown,
    estBytes: number,
  ): Promise<void> {
    const key = `${bootGen}:${segmentId}:${kind}`;
    let buf = this.activePageBuffers.get(key);
    if (!buf) {
      buf = { kind, bootGeneration: bootGen, segmentId, items: [], estimatedBytes: 0 };
      this.activePageBuffers.set(key, buf);
    }
    buf.items.push(item);
    buf.estimatedBytes += estBytes;
    this.writeQueueBytes += estBytes;
    if (this.writeQueueBytes > this.peakWriteQueueBytes) {
      this.peakWriteQueueBytes = this.writeQueueBytes;
    }

    if (buf.items.length >= this.limits.pageMaxItems || buf.estimatedBytes >= this.limits.pageMaxBytes) {
      await this.flushSingleBuffer(key, buf);
    }
  }

  private queuedDataPages: Array<{
    desc: IndexedPageDescriptor;
    lod: PageLodSummary;
    bytes: Buffer;
    estimatedMemBytes: number;
  }> = [];

  private async flushSingleBuffer(key: string, buf: PendingPageBuffer): Promise<void> {
    if (buf.items.length === 0) {
      return;
    }
    this.activePageBuffers.delete(key);

    // 常规区间页在落盘前按 startRelativeTicks 排序，确保页内有序
    if (buf.kind === 'slices' || buf.kind === 'activations' || buf.kind === 'readyWaits' || buf.kind === 'markers') {
      buf.items.sort((a: any, b: any) => {
        const sa = (a.start?.relativeTicksBigInt ?? 0n) as bigint;
        const sb = (b.start?.relativeTicksBigInt ?? 0n) as bigint;
        if (sa < sb) return -1;
        if (sa > sb) return 1;
        return 0;
      });
    }

    const pageId = this.nextPageId++;
    const segMeta = this.index.getSegment(buf.bootGeneration, buf.segmentId);
    const encoded = encodeTraceDataPage(
      buf.kind,
      buf.bootGeneration,
      buf.segmentId,
      buf.items as TracePageItems,
    );
    const summary = computeDescriptorAndLod(
      pageId,
      buf.kind,
      buf.bootGeneration,
      buf.segmentId,
      buf.items,
      encoded.buffer.length,
      encoded.pageCrc32,
      segMeta,
    );

    if (buf.kind === 'slices' || buf.kind === 'activations' || buf.kind === 'readyWaits' || buf.kind === 'markers') {
      const partKindKey = `${buf.bootGeneration}:${buf.segmentId}:${buf.kind}`;
      const prevMax = this.regularMaxEndByPartKind.get(partKindKey);
      const curMax = BigInt(summary.desc.maxRelativeTicks);
      if (prevMax === undefined || curMax > prevMax) {
        this.regularMaxEndByPartKind.set(partKindKey, curMax);
      }
    }

    this.queuedDataPages.push({
      desc: summary.desc,
      lod: summary.lod,
      bytes: encoded.buffer,
      estimatedMemBytes: buf.estimatedBytes,
    });
  }

  private async commitPending(
    frameKind: 1 | 2 | 3 | 4 | 5,
    flushOpenPages: boolean,
    extraMeta: Partial<JournalCommitMetadata> = {},
  ): Promise<TraceStorageResult<void>> {
    if (flushOpenPages) {
      const keys = Array.from(this.activePageBuffers.keys());
      for (const k of keys) {
        const buf = this.activePageBuffers.get(k);
        if (buf && buf.items.length > 0) {
          await this.flushSingleBuffer(k, buf);
        }
      }
    }

    const hasPendingRaw = this.pendingRawBytes > 0;
    const hasPendingPages = this.queuedDataPages.length > 0;
    const hasPendingMeta = this.pendingGaps.length > 0 || frameKind !== JOURNAL_FRAME_KIND.CHUNK_COMMIT;
    if (!hasPendingRaw && !hasPendingPages && !hasPendingMeta) {
      return { ok: true, data: undefined };
    }

    const prevRawOffset = this.committed.rawBytes;
    const prevDataOffset = this.committed.dataBytes;
    const prevJournalOffset = this.committed.journalBytes;

    const rawCombined =
      this.pendingRawChunks.length === 0
        ? Buffer.alloc(0)
        : this.pendingRawChunks.length === 1
          ? Buffer.from(this.pendingRawChunks[0])
          : Buffer.concat(this.pendingRawChunks.map((c) => Buffer.from(c)));
    const rawCrc32 = rawCombined.length > 0 ? computeCrc32(rawCombined) : 0;

    // 拼接待写入的 data.otd 页并赋予实际 dataOffset
    let dataPos = prevDataOffset;
    const pageDescs: IndexedPageDescriptor[] = [];
    const pageLods: PageLodSummary[] = [];
    const pageBuffers: Buffer[] = [];
    for (const q of this.queuedDataPages) {
      const assignedDesc: IndexedPageDescriptor = {
        ...q.desc,
        dataOffset: dataPos,
      };
      pageDescs.push(assignedDesc);
      pageLods.push(q.lod);
      pageBuffers.push(q.bytes);
      dataPos += q.bytes.length;
    }
    const dataCombined = pageBuffers.length > 0 ? Buffer.concat(pageBuffers) : Buffer.alloc(0);
    const dataCrc32 = dataCombined.length > 0 ? computeCrc32(dataCombined) : 0;

    const commitSeq = this.committed.commitSeq + 1;
    const meta: JournalCommitMetadata = {
      batchSequence:
        this.pendingBatchSequences.length > 0
          ? this.pendingBatchSequences[this.pendingBatchSequences.length - 1]
          : undefined,
      bootGeneration: this.identity.bootGeneration,
      identity: { ...this.identity },
      pages: pageDescs.length > 0 ? pageDescs : undefined,
      segments: this.pendingSegments.size > 0 ? Array.from(this.pendingSegments.values()) : undefined,
      gaps: this.pendingGaps.length > 0 ? [...this.pendingGaps] : undefined,
      ...(this.pendingDecoderDiagnostics.length > 0 ? { decoderDiagnostics: [...this.pendingDecoderDiagnostics] } : {}),
      ...(this.pendingReconstructorDiagnostics.length > 0 ? { reconstructorDiagnostics: [...this.pendingReconstructorDiagnostics] } : {}),
      ...(this.droppedRecordedDiagnostics > 0 ? { droppedDiagnosticsCount: this.droppedRecordedDiagnostics } : {}),
      countsDelta: { ...this.pendingCountsDelta },
      ...extraMeta,
    };

    const journalFrame = encodeJournalFrame({
      frameKind,
      commitSeq,
      rawOffset: prevRawOffset,
      rawLength: rawCombined.length,
      rawCrc32,
      dataOffset: prevDataOffset,
      dataLength: dataCombined.length,
      dataCrc32,
      meta,
    });

    // 严格按序写入：1) raw.otbin -> 2) data.otd -> 3) journal.otj
    try {
      if (rawCombined.length > 0) {
        await writeAllChecked(this.rawHandle!, rawCombined, prevRawOffset, this.limits.rawChunkBytes);
      }
      if (dataCombined.length > 0) {
        await writeAllChecked(this.dataHandle!, dataCombined, prevDataOffset, this.limits.rawChunkBytes);
      }
      await writeAllChecked(this.journalHandle!, journalFrame, prevJournalOffset, this.limits.rawChunkBytes);
    } catch (err) {
      // 回滚未提交尾部，保留 [0, prevRawOffset) / [0, prevDataOffset) / [0, prevJournalOffset)
      await Promise.allSettled([
        this.rawHandle?.truncate(prevRawOffset),
        this.dataHandle?.truncate(prevDataOffset),
        this.journalHandle?.truncate(prevJournalOffset),
      ]);
      return await this.handleStorageFailure(err);
    }

    // 提交成功后再更新内存统计与索引
    if (rawCombined.length > 0) {
      this.rawHash.update(rawCombined);
    }
    for (let i = 0; i < pageDescs.length; i++) {
      this.index.addPage(pageDescs[i], pageLods[i]);
    }
    await this.index.enforceMemoryBounds();

    this.committed = {
      commitSeq,
      rawBytes: prevRawOffset + rawCombined.length,
      dataBytes: prevDataOffset + dataCombined.length,
      journalBytes: prevJournalOffset + journalFrame.length,
      packetCount: this.committed.packetCount + this.pendingCountsDelta.packetCount,
      sliceCount: this.committed.sliceCount + this.pendingCountsDelta.sliceCount,
      activationCount: this.committed.activationCount + this.pendingCountsDelta.activationCount,
      readyWaitCount: this.committed.readyWaitCount + this.pendingCountsDelta.readyWaitCount,
      markerCount: this.committed.markerCount + this.pendingCountsDelta.markerCount,
      markerPointCount: this.committed.markerPointCount + this.pendingCountsDelta.markerPointCount,
      gapCount: this.committed.gapCount + this.pendingCountsDelta.gapCount,
      segmentCount: this.index.getSegments().length,
    };

    // 清理已提交队列并释放写队列内存计数
    this.pendingRawChunks = [];
    this.pendingRawBytes = 0;
    this.pendingBatchSequences = [];
    this.pendingSegments.clear();
    this.pendingGaps = [];
    this.pendingDecoderDiagnostics = [];
    this.pendingReconstructorDiagnostics = [];
    let releasedQueueBytes = rawCombined.length;
    for (const q of this.queuedDataPages) {
      releasedQueueBytes += q.estimatedMemBytes;
    }
    this.queuedDataPages = [];
    this.writeQueueBytes = Math.max(0, this.writeQueueBytes - releasedQueueBytes);
    this.pendingCountsDelta = {
      packetCount: 0,
      sliceCount: 0,
      activationCount: 0,
      readyWaitCount: 0,
      markerCount: 0,
      markerPointCount: 0,
      gapCount: 0,
    };
    this.updatedAtMs = Date.now();
    return { ok: true, data: undefined };
  }

  private async handleStorageFailure(err: unknown): Promise<TraceStorageFailure> {
    const classified = classifyStorageWriteError(err);
    this.state = 'failed';
    this.failureCode = classified.errorCode;
    this.closeReason = classified.message;
    this.updatedAtMs = Date.now();

    // 丢弃尚未提交的脏队列内存，避免持续积压
    this.pendingRawChunks = [];
    this.pendingRawBytes = 0;
    this.queuedDataPages = [];
    this.activePageBuffers.clear();
    this.writeQueueBytes = 0;

    // 尽力更新 manifest 或写入失败标记，若磁盘已满产生二次错误也不掩盖原始失败
    try {
      await this.writeManifestAtomic();
    } catch {
      // 忽略磁盘满情况下的二次元数据更新失败
    }

    return {
      ok: false,
      errorCode: classified.errorCode,
      message: classified.message,
      diagnostics: {
        committedRawBytes: this.committed.rawBytes,
        committedCommitSeq: this.committed.commitSeq,
      },
    };
  }

  private async spillIndexDescriptors(
    bootGeneration: number,
    segmentId: number,
    kind: TracePageKind,
    descriptors: readonly IndexedPageDescriptor[],
  ): Promise<CompactedDirectoryBlock> {
    const payload = Buffer.from(safeTraceJsonStringify(descriptors), 'utf8');
    if (!this.spillHandle) {
      const spillPath = path.join(this.recordingDir, 'index-spill.otidx');
      this.spillHandle = await this.fs.open(spillPath, 'w+');
    }
    const offset = this.spillOffset;
    await writeAllChecked(this.spillHandle, payload, offset, this.limits.rawChunkBytes);
    this.spillOffset += payload.length;

    let minRel = BigInt(descriptors[0].minRelativeTicks);
    let maxRel = BigInt(descriptors[0].maxRelativeTicks);
    let minAbs: bigint | undefined;
    let maxAbs: bigint | undefined;
    let minNs: bigint | undefined;
    let maxNs: bigint | undefined;
    let allAbs = true;
    let minByte = descriptors[0].minByteOffset;
    let maxByte = descriptors[0].maxByteOffset;
    let sysFreqHz: number | undefined;

    for (const d of descriptors) {
      const r0 = BigInt(d.minRelativeTicks);
      const r1 = BigInt(d.maxRelativeTicks);
      if (r0 < minRel) minRel = r0;
      if (r1 > maxRel) maxRel = r1;
      if (!d.hasAbsoluteTicks || d.minAbsoluteTicks === undefined || d.maxAbsoluteTicks === undefined) {
        allAbs = false;
      } else {
        const a0 = BigInt(d.minAbsoluteTicks);
        const a1 = BigInt(d.maxAbsoluteTicks);
        if (minAbs === undefined || a0 < minAbs) minAbs = a0;
        if (maxAbs === undefined || a1 > maxAbs) maxAbs = a1;
      }
      if (d.minNs !== undefined && d.maxNs !== undefined) {
        const n0 = BigInt(d.minNs);
        const n1 = BigInt(d.maxNs);
        if (minNs === undefined || n0 < minNs) minNs = n0;
        if (maxNs === undefined || n1 > maxNs) maxNs = n1;
      }
      if (d.minByteOffset < minByte) minByte = d.minByteOffset;
      if (d.maxByteOffset > maxByte) maxByte = d.maxByteOffset;
      if (d.sysFreqHz !== undefined) sysFreqHz = d.sysFreqHz;
    }

    return {
      blockId: this.nextSpillBlockId++,
      bootGeneration,
      segmentId,
      kind,
      minRelativeTicks: minRel.toString(),
      maxRelativeTicks: maxRel.toString(),
      hasAbsoluteTicks: allAbs && minAbs !== undefined && maxAbs !== undefined,
      minAbsoluteTicks: minAbs?.toString(),
      maxAbsoluteTicks: maxAbs?.toString(),
      sysFreqHz,
      minNs: minNs?.toString(),
      maxNs: maxNs?.toString(),
      minByteOffset: minByte,
      maxByteOffset: maxByte,
      pageCount: descriptors.length,
      spillOffset: offset,
      spillLength: payload.length,
    };
  }

  private async loadSpilledIndexDescriptors(block: CompactedDirectoryBlock): Promise<readonly IndexedPageDescriptor[]> {
    if (!this.spillHandle) {
      throw new Error('缺少 index-spill.otidx 句柄，无法加载已溢写页目录');
    }
    const buf = await readExactFromHandle(this.spillHandle, block.spillOffset, block.spillLength);
    return JSON.parse(buf.toString('utf8')) as IndexedPageDescriptor[];
  }

  private async loadPage(desc: IndexedPageDescriptor): Promise<DecodedTracePage> {
    const cacheKey = `${desc.dataOffset}:${desc.dataLength}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }
    if (!this.dataHandle) {
      throw new Error('data.otd 文件句柄未打开');
    }
    const raw = await readExactFromHandle(this.dataHandle, desc.dataOffset, desc.dataLength);
    const decoded = decodeTraceDataPage(raw, desc.dataCrc32);
    this.cache.put(cacheKey, decoded, desc.dataLength);
    return decoded;
  }

  /**
   * 精确范围查询（半开区间 `[start, end)`，支持分页、取消与协作让步）。
   */
  public async queryRange<T = unknown>(
    request: TraceRangeQueryRequest,
    cancel?: TraceQueryCancelToken,
  ): Promise<TraceStorageResult<TraceRangeQueryResult<T>>> {
    if (this.closed || !this.dataHandle) {
      return { ok: false, errorCode: 'RecordingClosed', message: '存储已关闭，无法执行查询' };
    }
    if (isQueryCancelled(cancel)) {
      return { ok: false, errorCode: 'QueryCancelled', cancelled: true, message: '查询已取消' };
    }

    let qStart: bigint;
    let qEnd: bigint;
    try {
      qStart = parseRangeBoundBigInt(request.start, 'start');
      qEnd = parseRangeBoundBigInt(request.end, 'end');
    } catch (err) {
      return {
        ok: false,
        errorCode: 'InvalidArgument',
        message: err instanceof Error ? err.message : String(err),
      };
    }

    const limit = Math.min(
      this.limits.maxQueryResultItems,
      Math.max(1, request.limit ?? this.limits.maxQueryResultItems),
    );
    const maxResultBytes = this.limits.maxQueryResultBytes;
    const cursorState: CursorState = request.cursor
      ? (decodeCursor(request.cursor) ?? { pIdx: -1, kIdx: 0, pgIdx: 0, iIdx: 0 })
      : { pIdx: 0, kIdx: 0, pgIdx: 0, iIdx: 0 };
    if (cursorState.pIdx < 0) {
      return { ok: false, errorCode: 'InvalidCursor', message: `非法分页游标: ${request.cursor}` };
    }

    const { partitions, skippedUnanchoredSegments, skippedNoFrequencySegments } =
      this.index.getMatchingPartitions({
        bootGeneration: request.bootGeneration,
        segmentId: request.segmentId,
        unit: request.unit,
        start: qStart,
        end: qEnd,
      });

    if (qStart >= qEnd || partitions.length === 0) {
      return {
        ok: true,
        data: {
          target: request.target,
          unit: request.unit,
          start: qStart.toString(),
          end: qEnd.toString(),
          items: [],
          totalReturned: 0,
          hasMore: false,
          candidatePagesScanned: 0,
          cacheHits: this.cache.getStats().hits,
          cacheMisses: this.cache.getStats().misses,
          skippedUnanchoredSegments,
          skippedNoFrequencySegments,
        },
      };
    }

    const pageKinds = getPageKindsForQueryTarget(request.target);
    const results: T[] = [];
    let accumulatedResultBytes = 0;
    const yieldEveryPages = cancel?.yieldEveryPages ?? 1;
    const yieldEveryItems = cancel?.yieldEveryItems ?? 512;
    let pagesScanned = 0;
    let itemsCheckedSinceYield = 0;
    let nextCursor: string | undefined;
    let hitLimit = false;

    const hitsBefore = this.cache.getStats().hits;
    const missesBefore = this.cache.getStats().misses;

    for (let pIdx = cursorState.pIdx; pIdx < partitions.length && !hitLimit; pIdx++) {
      const part = partitions[pIdx];
      const startK = pIdx === cursorState.pIdx ? cursorState.kIdx : 0;

      for (let kIdx = startK; kIdx < pageKinds.length && !hitLimit; kIdx++) {
        const kind = pageKinds[kIdx];
        const candidatePages = await this.index.findCandidatePages(part, kind, request.unit, qStart, qEnd);
        const startPg = pIdx === cursorState.pIdx && kIdx === cursorState.kIdx ? cursorState.pgIdx : 0;

        for (let pgIdx = startPg; pgIdx < candidatePages.length && !hitLimit; pgIdx++) {
          if (isQueryCancelled(cancel)) {
            return { ok: false, errorCode: 'QueryCancelled', cancelled: true, message: '查询在分页扫描中取消' };
          }
          const desc = candidatePages[pgIdx];
          let page: DecodedTracePage;
          try {
            page = await this.loadPage(desc);
          } catch (err) {
            return {
              ok: false,
              errorCode: 'StorageReadError',
              message: `读取或校验数据页失败 (pageId=${desc.pageId}): ${err instanceof Error ? err.message : String(err)}`,
            };
          }
          pagesScanned += 1;

          const items = page.items as readonly any[];
          const startI =
            pIdx === cursorState.pIdx && kIdx === cursorState.kIdx && pgIdx === cursorState.pgIdx
              ? cursorState.iIdx
              : 0;

          for (let iIdx = startI; iIdx < items.length; iIdx++) {
            itemsCheckedSinceYield += 1;
            if (itemsCheckedSinceYield >= yieldEveryItems) {
              itemsCheckedSinceYield = 0;
              if (isQueryCancelled(cancel)) {
                return { ok: false, errorCode: 'QueryCancelled', cancelled: true, message: '查询在条目扫描中取消' };
              }
              await yieldToEventLoop();
              if (isQueryCancelled(cancel)) {
                return { ok: false, errorCode: 'QueryCancelled', cancelled: true, message: '查询让步恢复后已取消' };
              }
            }

            const item = items[iIdx];
            if (itemMatchesRange(request.target, item, request.unit, qStart, qEnd, part.meta)) {
              const estBytes = request.target === 'packets' ? estimatePacketBytes(item) : 160;
              if (results.length > 0 && accumulatedResultBytes + estBytes > maxResultBytes) {
                nextCursor = encodeCursor({ pIdx, kIdx, pgIdx, iIdx });
                hitLimit = true;
                break;
              }
              results.push(item as T);
              accumulatedResultBytes += estBytes;
              if (results.length >= limit || accumulatedResultBytes >= maxResultBytes) {
                const hasRemainingInPage = iIdx + 1 < items.length;
                if (hasRemainingInPage) {
                  nextCursor = encodeCursor({ pIdx, kIdx, pgIdx, iIdx: iIdx + 1 });
                } else if (pgIdx + 1 < candidatePages.length) {
                  nextCursor = encodeCursor({ pIdx, kIdx, pgIdx: pgIdx + 1, iIdx: 0 });
                } else if (kIdx + 1 < pageKinds.length) {
                  nextCursor = encodeCursor({ pIdx, kIdx: kIdx + 1, pgIdx: 0, iIdx: 0 });
                } else if (pIdx + 1 < partitions.length) {
                  nextCursor = encodeCursor({ pIdx: pIdx + 1, kIdx: 0, pgIdx: 0, iIdx: 0 });
                }
                hitLimit = true;
                break;
              }
            }
          }

          if (!hitLimit && pagesScanned % yieldEveryPages === 0) {
            await yieldToEventLoop();
            if (isQueryCancelled(cancel)) {
              return { ok: false, errorCode: 'QueryCancelled', cancelled: true, message: '查询在页间让步后取消' };
            }
          }
        }
      }
    }

    // 单页完整结果按起点时间确定性排序（合并常规页与跨页长区间）
    if (!request.cursor && nextCursor === undefined && results.length > 1) {
      results.sort((a: any, b: any) => compareItemsByTime(request.target, a, b));
    }

    const cacheAfter = this.cache.getStats();
    return {
      ok: true,
      data: {
        target: request.target,
        unit: request.unit,
        start: qStart.toString(),
        end: qEnd.toString(),
        items: results,
        totalReturned: results.length,
        hasMore: nextCursor !== undefined,
        nextCursor,
        candidatePagesScanned: pagesScanned,
        cacheHits: cacheAfter.hits - hitsBefore,
        cacheMisses: cacheAfter.misses - missesBefore,
        skippedUnanchoredSegments,
        skippedNoFrequencySegments,
      },
    };
  }

  /**
   * 仅用于显示的 LOD 抽稀查询：
   * - 不修改原始字节或持久化数据；
   * - 将查询范围分为 `1..maxBuckets` 个展示桶，统计上下文时间占比、包数、缺口与不完整标记。
   */
  public async queryLod(
    request: TraceLodQueryRequest,
    cancel?: TraceQueryCancelToken,
  ): Promise<TraceStorageResult<TraceLodQueryResult>> {
    if (this.closed || !this.dataHandle) {
      return { ok: false, errorCode: 'RecordingClosed', message: '存储已关闭，无法执行 LOD 查询' };
    }
    if (isQueryCancelled(cancel)) {
      return { ok: false, errorCode: 'QueryCancelled', cancelled: true, message: 'LOD 查询已取消' };
    }

    let qStart: bigint;
    let qEnd: bigint;
    try {
      qStart = parseRangeBoundBigInt(request.start, 'start');
      qEnd = parseRangeBoundBigInt(request.end, 'end');
    } catch (err) {
      return { ok: false, errorCode: 'InvalidArgument', message: err instanceof Error ? err.message : String(err) };
    }

    const maxBuckets = Math.min(this.limits.maxLodBuckets, Math.max(1, request.maxBuckets ?? 256));
    const { partitions, skippedUnanchoredSegments, skippedNoFrequencySegments } =
      this.index.getMatchingPartitions({
        bootGeneration: request.bootGeneration,
        segmentId: request.segmentId,
        unit: request.unit,
        start: qStart,
        end: qEnd,
      });

    if (qStart >= qEnd || partitions.length === 0) {
      return {
        ok: true,
        data: {
          unit: request.unit,
          start: qStart.toString(),
          end: qEnd.toString(),
          buckets: [],
          skippedUnanchoredSegments,
          skippedNoFrequencySegments,
          usedFineItems: false,
        },
      };
    }

    const buckets: TraceLodBucket[] = [];
    const span = qEnd - qStart;
    const bucketCount = span < BigInt(maxBuckets) ? Number(span) : maxBuckets;
    const gaps = this.index.getGaps();

    // 当所有候选切片与包页总数很少（<= 8 页）时，使用精确条目折叠以保证局部高精度；大范围时直接聚合页级 LOD 摘要
    let totalCandidatePages = 0;
    for (const part of partitions) {
      const sp = await this.index.findCandidatePages(part, 'slices', request.unit, qStart, qEnd);
      const lsp = await this.index.findCandidatePages(part, 'longSlices', request.unit, qStart, qEnd);
      const pp = await this.index.findCandidatePages(part, 'packets', request.unit, qStart, qEnd);
      totalCandidatePages += sp.length + lsp.length + pp.length;
    }

    const useFine = totalCandidatePages <= 12;

    for (const part of partitions) {
      if (isQueryCancelled(cancel)) {
        return { ok: false, errorCode: 'QueryCancelled', cancelled: true, message: 'LOD 查询已取消' };
      }

      const accs = Array.from({ length: bucketCount }, (_, idx) => {
        const bStart = qStart + (span * BigInt(idx)) / BigInt(bucketCount);
        const bEnd = idx === bucketCount - 1 ? qEnd : qStart + (span * BigInt(idx + 1)) / BigInt(bucketCount);
        return {
          bStart,
          bEnd,
          packetCount: 0,
          intervalCount: 0,
          markerCount: 0,
          hasGap: false,
          gapKinds: new Set<string>(),
          hasIncomplete: false,
          hasUncertain: part.meta.reliability === 'uncertain',
          ticksByKind: { task: 0n, isr: 0n, idle: 0n, scheduler: 0n },
          contextTicks: new Map<string, { contextKind: string; label?: string; ticks: bigint }>(),
        };
      });

      const assignRangeToBuckets = (
        s: bigint,
        e: bigint,
        cb: (acc: (typeof accs)[number], overlap: bigint) => void,
      ) => {
        if (e <= qStart || s >= qEnd) return;
        const cs = s < qStart ? qStart : s;
        const ce = e > qEnd ? qEnd : e;
        let i0 = Number(((cs - qStart) * BigInt(bucketCount)) / span);
        let i1 = Number(((ce - qStart) * BigInt(bucketCount)) / span);
        if (i0 < 0) i0 = 0;
        if (i1 >= bucketCount) i1 = bucketCount - 1;
        for (let i = i0; i <= i1; i++) {
          const acc = accs[i];
          const os = cs > acc.bStart ? cs : acc.bStart;
          const oe = ce < acc.bEnd ? ce : acc.bEnd;
          if (oe > os || (ce === cs && cs >= acc.bStart && cs < acc.bEnd)) {
            cb(acc, oe > os ? oe - os : 0n);
          }
        }
      };

      // 标注落在查询范围内的缺口
      for (const g of gaps) {
        if (g.bootGeneration !== part.meta.bootGeneration) continue;
        if (g.segmentIdBefore !== undefined && g.segmentIdBefore !== part.meta.segmentId) continue;
        const gOff = BigInt(g.byteOffset);
        if (request.unit === 'byte-offset' && gOff >= qStart && gOff < qEnd) {
          const idx = Math.min(bucketCount - 1, Number(((gOff - qStart) * BigInt(bucketCount)) / span));
          accs[idx].hasGap = true;
          accs[idx].gapKinds.add(g.kind);
        } else if (part.meta.endByteOffset !== undefined && g.segmentIdBefore === part.meta.segmentId) {
          // 段末尾缺口关联到该段最大已知时刻所在的桶
          const segMax =
            request.unit === 'relative-ticks'
              ? BigInt(part.meta.maxRelativeTicks)
              : request.unit === 'absolute-ticks' && part.meta.lastAbsoluteTicks !== undefined
                ? BigInt(part.meta.lastAbsoluteTicks)
                : request.unit === 'ns' && part.meta.maxNs !== undefined
                  ? BigInt(part.meta.maxNs)
                  : undefined;
          if (segMax !== undefined && segMax >= qStart && segMax < qEnd) {
            const idx = Math.min(bucketCount - 1, Number(((segMax - qStart) * BigInt(bucketCount)) / span));
            accs[idx].hasGap = true;
            accs[idx].gapKinds.add(g.kind);
          }
        }
      }

      if (useFine) {
        for (const kind of ['packets', 'slices', 'longSlices', 'markerPoints'] as const) {
          const cand = await this.index.findCandidatePages(part, kind, request.unit, qStart, qEnd);
          for (const desc of cand) {
            if (isQueryCancelled(cancel)) {
              return { ok: false, errorCode: 'QueryCancelled', cancelled: true, message: 'LOD 细粒度查询取消' };
            }
            const page = await this.loadPage(desc);
            const items = page.items as readonly any[];
            for (let idx = 0; idx < items.length; idx++) {
              if (idx > 0 && idx % 512 === 0) {
                await yieldToEventLoop();
                if (isQueryCancelled(cancel)) {
                  return { ok: false, errorCode: 'QueryCancelled', cancelled: true, message: 'LOD 查询取消' };
                }
              }
              const item = items[idx];
              if (kind === 'packets') {
                const pt = getPacketTimeForUnit(item, request.unit, part.meta.sysFreqHz);
                if (!pt) continue;
                assignRangeToBuckets(pt.start, pt.end ?? pt.start, (acc) => {
                  acc.packetCount += 1;
                });
              } else if (kind === 'markerPoints') {
                const mp = getMarkerPointTimeForUnit(item, request.unit, part.meta);
                if (!mp) continue;
                assignRangeToBuckets(mp.start, mp.start, (acc) => {
                  acc.markerCount += 1;
                });
              } else {
                const sl = item as ExecutionSliceInterval;
                const bounds = getIntervalBoundsForUnit(sl, request.unit, part.meta);
                if (!bounds) continue;
                assignRangeToBuckets(bounds.start, bounds.end ?? bounds.start, (acc, overlap) => {
                  acc.intervalCount += 1;
                  if (sl.completeness === 'incomplete') acc.hasIncomplete = true;
                  if (sl.completeness === 'uncertain') acc.hasUncertain = true;
                  acc.ticksByKind[sl.contextKind] += overlap;
                  const prev = acc.contextTicks.get(sl.contextKey);
                  if (prev) {
                    prev.ticks += overlap;
                  } else {
                    acc.contextTicks.set(sl.contextKey, {
                      contextKind: sl.contextKind,
                      label: sl.label,
                      ticks: overlap,
                    });
                  }
                });
              }
            }
          }
        }
      } else {
        // 粗粒度路径：聚合分区 LOD 摘要，无需解包百万事件
        for (let sIdx = 0; sIdx < part.lodSummaries.length; sIdx++) {
          if (sIdx > 0 && sIdx % 256 === 0) {
            await yieldToEventLoop();
            if (isQueryCancelled(cancel)) {
              return { ok: false, errorCode: 'QueryCancelled', cancelled: true, message: 'LOD 摘要聚合取消' };
            }
          }
          const sum = part.lodSummaries[sIdx];
          const bounds = getLodSummaryBounds(sum, request.unit);
          if (!bounds) continue;
          const dur = bounds.max > bounds.min ? bounds.max - bounds.min : 1n;
          assignRangeToBuckets(bounds.min, bounds.max, (acc, overlap) => {
            const shareNum = overlap > 0n ? overlap : 1n;
            const ratioCount = (c: number) => Math.max(c > 0 ? 1 : 0, Number((BigInt(c) * shareNum) / dur));
            if (sum.kind === 'packets') {
              acc.packetCount += ratioCount(sum.itemCount);
            } else if (sum.kind === 'markerPoints' || sum.kind === 'markers' || sum.kind === 'longMarkers') {
              acc.markerCount += ratioCount(sum.itemCount);
            } else {
              if (sum.kind === 'slices' || sum.kind === 'longSlices') {
                acc.intervalCount += ratioCount(sum.itemCount);
              }
              if (sum.hasIncomplete) acc.hasIncomplete = true;
              if (sum.hasUncertain) acc.hasUncertain = true;
              if (sum.sliceTicksByKind) {
                acc.ticksByKind.task += (BigInt(sum.sliceTicksByKind.task) * shareNum) / dur;
                acc.ticksByKind.isr += (BigInt(sum.sliceTicksByKind.isr) * shareNum) / dur;
                acc.ticksByKind.idle += (BigInt(sum.sliceTicksByKind.idle) * shareNum) / dur;
                acc.ticksByKind.scheduler += (BigInt(sum.sliceTicksByKind.scheduler) * shareNum) / dur;
              }
              if (sum.dominantContext) {
                const prev = acc.contextTicks.get(sum.dominantContext.contextKey);
                const addTicks = (BigInt(sum.dominantContext.ticks) * shareNum) / dur;
                if (prev) {
                  prev.ticks += addTicks;
                } else {
                  acc.contextTicks.set(sum.dominantContext.contextKey, {
                    contextKind: sum.dominantContext.contextKind,
                    label: sum.dominantContext.label,
                    ticks: addTicks,
                  });
                }
              }
            }
          });
        }
      }

      for (let i = 0; i < accs.length; i++) {
        const acc = accs[i];
        let dominant: TraceLodBucket['dominantContext'];
        let bestTicks = -1n;
        for (const [ctxKey, info] of acc.contextTicks.entries()) {
          if (info.ticks > bestTicks) {
            bestTicks = info.ticks;
            dominant = {
              contextKind: info.contextKind,
              contextKey: ctxKey,
              label: info.label,
              ticks: info.ticks.toString(),
            };
          }
        }
        buckets.push({
          bucketIndex: i,
          bootGeneration: part.meta.bootGeneration,
          segmentId: part.meta.segmentId,
          unit: request.unit,
          start: acc.bStart.toString(),
          end: acc.bEnd.toString(),
          startBigInt: acc.bStart,
          endBigInt: acc.bEnd,
          packetCount: acc.packetCount,
          intervalCount: acc.intervalCount,
          markerCount: acc.markerCount,
          hasGap: acc.hasGap,
          gapKinds: Array.from(acc.gapKinds),
          hasIncomplete: acc.hasIncomplete,
          hasUncertain: acc.hasUncertain,
          activeTicksByKind: {
            task: acc.ticksByKind.task.toString(),
            isr: acc.ticksByKind.isr.toString(),
            idle: acc.ticksByKind.idle.toString(),
            scheduler: acc.ticksByKind.scheduler.toString(),
          },
          dominantContext: dominant,
        });
      }
    }

    return {
      ok: true,
      data: {
        unit: request.unit,
        start: qStart.toString(),
        end: qEnd.toString(),
        buckets,
        skippedUnanchoredSegments,
        skippedNoFrequencySegments,
        usedFineItems: useFine,
      },
    };
  }

  /**
   * 有界可取消的上下文统计、Ready 延迟、Marker 统计与 CPU Load 分箱聚合（阶段 5.1）。
   */
  public async queryAnalysis(
    request: TraceAnalysisQueryRequest,
    cancel?: TraceQueryCancelToken,
  ): Promise<TraceStorageResult<TraceAnalysisQueryResult>> {
    if (this.closed || !this.dataHandle) {
      return { ok: false, errorCode: 'RecordingClosed', message: '存储已关闭，无法执行统计分析查询' };
    }
    if (isQueryCancelled(cancel)) {
      return { ok: false, errorCode: 'QueryCancelled', cancelled: true, message: '统计分析查询已取消' };
    }
    if (request.unit === 'byte-offset') {
      return {
        ok: false,
        errorCode: 'InvalidArgument',
        message: 'Contexts 与 CPU Load 统计不支持 byte-offset 单位，请使用时间/tick 单位',
      };
    }

    let qStart: bigint;
    let qEnd: bigint;
    try {
      qStart = parseRangeBoundBigInt(request.start, 'start');
      qEnd = parseRangeBoundBigInt(request.end, 'end');
    } catch (err) {
      return { ok: false, errorCode: 'InvalidArgument', message: err instanceof Error ? err.message : String(err) };
    }

    try {
      const res = await computeTraceAnalysis(
        {
          index: this.index,
          loadPage: desc => this.loadPage(desc),
          getCacheStats: () => this.cache.getStats(),
          isCancelled: () => isQueryCancelled(cancel),
          yieldToLoop: () => yieldToEventLoop(),
          yieldEveryPages: cancel?.yieldEveryPages ?? 2,
          yieldEveryItems: cancel?.yieldEveryItems ?? 512,
        },
        request,
        qStart,
        qEnd,
      );
      if (!res.ok) {
        return { ok: false, errorCode: 'QueryCancelled', cancelled: true, message: '统计分析查询已取消' };
      }
      return { ok: true, data: res.data };
    } catch (err) {
      return {
        ok: false,
        errorCode: 'StorageReadError',
        message: `统计分析读取数据页失败: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  public setRodataLookup(lookup: VerifiedElfRodataLookup | undefined): void {
    this.rodataLookup = lookup;
  }

  private absorbTaskSummaryMetadata(t: TaskInstanceSummary): void {
    (this.eventMetadata.tasksByInstanceId as Map<string, TaskInstanceSummary>).set(t.taskInstanceId, t);
    if (t.tcbAddress !== undefined) {
      (this.eventMetadata.tasksByBootAddr as Map<string, TaskInstanceSummary>).set(
        `${t.bootGeneration}:${t.tcbAddress >>> 0}`,
        t,
      );
    }
  }

  private absorbPacketSummaryMetadata(bootGen: number, pkt: DecodedSystemViewPacket): void {
    const d = pkt.decoded;
    if (d.kind === 'sysdesc') {
      let irqMap = this.eventMetadata.irqNamesByBoot.get(bootGen) as Map<number, string> | undefined;
      if (!irqMap) {
        irqMap = new Map();
        (this.eventMetadata.irqNamesByBoot as Map<number, Map<number, string>>).set(bootGen, irqMap);
      }
      for (const [k, v] of Object.entries(d.parsed.interrupts)) {
        const id = Number(k);
        if (Number.isInteger(id)) irqMap.set(id, v);
      }
    } else if (d.kind === 'ex-name-marker') {
      let mMap = this.eventMetadata.markerNamesByBoot.get(bootGen) as Map<number, string> | undefined;
      if (!mMap) {
        mMap = new Map();
        (this.eventMetadata.markerNamesByBoot as Map<number, Map<number, string>>).set(bootGen, mMap);
      }
      mMap.set(d.markerId, d.name);
    } else if (d.kind === 'name-resource' && d.resourceId !== undefined) {
      let rMap = this.eventMetadata.resourceNamesByBoot.get(bootGen) as Map<number, string> | undefined;
      if (!rMap) {
        rMap = new Map();
        (this.eventMetadata.resourceNamesByBoot as Map<number, Map<number, string>>).set(bootGen, rMap);
      }
      rMap.set(d.resourceId >>> 0, d.name);
    } else if (d.kind === 'ex-register-data') {
      let dMap = this.eventMetadata.dataNamesByBoot.get(bootGen) as Map<number, { name: string; unit?: string }> | undefined;
      if (!dMap) {
        dMap = new Map();
        (this.eventMetadata.dataNamesByBoot as Map<number, Map<number, { name: string; unit?: string }>>).set(bootGen, dMap);
      }
      dMap.set(d.dataId, { name: d.name, unit: d.unit });
    } else if (d.kind === 'task-info' && d.taskId !== undefined) {
      const key = `${bootGen}:${d.taskId >>> 0}`;
      if (!this.eventMetadata.tasksByBootAddr.has(key)) {
        (this.eventMetadata.tasksByBootAddr as Map<string, TaskInstanceSummary>).set(key, {
          taskInstanceId: `pkt-${bootGen}-${d.taskId >>> 0}`,
          bootGeneration: bootGen,
          firstSeenSegmentId: pkt.segmentId,
          lastSeenSegmentId: pkt.segmentId,
          tcbAddress: d.taskId >>> 0,
          addressStatus: 'resolved',
          shrunkTaskId: d.shrunkTaskId,
          generation: 1,
          name: d.name,
          nameSource: 'task-info',
          priority: d.priority,
          createdInTrace: false,
          terminated: false,
          identityConfidence: 'task-info-in-boot',
        });
      }
    }
  }

  /**
   * 仅读取每段首包页（最多 64 段）以恢复老归档中的 SYSDESC/TASK_INFO/NAME_RESOURCE 元数据，不扫描全量数据。
   */
  private async ensureSegmentLeadMetadata(cancel?: TraceQueryCancelToken): Promise<void> {
    if (!this.dataHandle) return;
    const segments = this.index.getSegments();
    const limitSegs = Math.min(segments.length, 64);
    for (let i = 0; i < limitSegs; i++) {
      if (isQueryCancelled(cancel)) return;
      const seg = segments[i];
      const partKey = `${seg.bootGeneration}:${seg.segmentId}`;
      if (this.seededMetadataPartitions.has(partKey)) continue;
      this.seededMetadataPartitions.add(partKey);
      const { partitions } = this.index.getMatchingPartitions({
        bootGeneration: seg.bootGeneration,
        segmentId: seg.segmentId,
        unit: 'relative-ticks',
        start: BigInt(seg.minRelativeTicks),
        end: BigInt(seg.maxRelativeTicks) + 1n,
      });
      if (partitions.length === 0) continue;
      const pages = await this.index.findCandidatePages(
        partitions[0],
        'packets',
        'relative-ticks',
        BigInt(seg.minRelativeTicks),
        BigInt(seg.maxRelativeTicks) + 1n,
      );
      if (pages.length === 0) continue;
      try {
        const firstPage = await this.loadPage(pages[0]);
        for (const pkt of firstPage.items as readonly DecodedSystemViewPacket[]) {
          this.absorbPacketSummaryMetadata(seg.bootGeneration, pkt);
        }
      } catch {
        // 坏页将在具体查询时报告
      }
    }
  }

  private createEventsHost(cancel?: TraceQueryCancelToken): TraceEventsExecutionHost {
    return {
      index: this.index,
      metadata: this.eventMetadata,
      rodataLookup: this.rodataLookup,
      decoderDiagnostics: this.storedDecoderDiagnostics,
      reconstructorDiagnostics: this.storedReconstructorDiagnostics,
      storageDiagnostics: this.inspection?.diagnostics ?? [],
      droppedRecordedDiagnostics: this.droppedRecordedDiagnostics,
      loadPage: desc => this.loadPage(desc),
      getCacheStats: () => this.cache.getStats(),
      isCancelled: () => isQueryCancelled(cancel),
      yieldToLoop: () => yieldToEventLoop(),
      yieldEveryPages: cancel?.yieldEveryPages ?? 1,
      yieldEveryItems: cancel?.yieldEveryItems ?? 256,
    };
  }

  /**
   * 阶段 5.2：有界可取消的虚拟化事件分页查询。
   */
  public async queryEvents(
    request: TraceEventsQueryRequest,
    cancel?: TraceQueryCancelToken,
  ): Promise<TraceStorageResult<TraceEventsQueryResult>> {
    if (this.closed || !this.dataHandle) {
      return { ok: false, errorCode: 'RecordingClosed', message: '存储已关闭，无法执行事件查询' };
    }
    if (isQueryCancelled(cancel)) {
      return { ok: false, errorCode: 'QueryCancelled', cancelled: true, message: '事件查询已取消' };
    }

    let qStart: bigint;
    let qEnd: bigint;
    try {
      qStart = parseRangeBoundBigInt(request.start, 'start');
      qEnd = parseRangeBoundBigInt(request.end, 'end');
    } catch (err) {
      return { ok: false, errorCode: 'InvalidArgument', message: err instanceof Error ? err.message : String(err) };
    }

    await this.ensureSegmentLeadMetadata(cancel);
    if (isQueryCancelled(cancel)) {
      return { ok: false, errorCode: 'QueryCancelled', cancelled: true, message: '事件查询已取消' };
    }

    try {
      const res = await executeEventsQuery(this.createEventsHost(cancel), request, qStart, qEnd);
      if (!res.ok) {
        return { ok: false, errorCode: 'QueryCancelled', cancelled: true, message: '事件查询已取消' };
      }
      return { ok: true, data: res.data };
    } catch (err) {
      return {
        ok: false,
        errorCode: 'StorageReadError',
        message: `事件查询读取数据页失败: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * 阶段 5.2：有界可取消的精确事件定位（支持 Trace Timeline 点击 -> Events 行号）。
   */
  public async locateEvent(
    request: TraceEventLocateRequest,
    cancel?: TraceQueryCancelToken,
  ): Promise<TraceStorageResult<TraceEventLocateResult>> {
    if (this.closed || !this.dataHandle) {
      return { ok: false, errorCode: 'RecordingClosed', message: '存储已关闭，无法定位事件' };
    }
    if (isQueryCancelled(cancel)) {
      return { ok: false, errorCode: 'QueryCancelled', cancelled: true, message: '事件定位已取消' };
    }

    let qStart: bigint;
    let qEnd: bigint;
    let targetTimeBig: bigint | undefined;
    try {
      qStart = parseRangeBoundBigInt(request.start, 'start');
      qEnd = parseRangeBoundBigInt(request.end, 'end');
      if (request.targetTime !== undefined) {
        targetTimeBig = parseRangeBoundBigInt(request.targetTime, 'targetTime');
      }
    } catch (err) {
      return { ok: false, errorCode: 'InvalidArgument', message: err instanceof Error ? err.message : String(err) };
    }

    await this.ensureSegmentLeadMetadata(cancel);
    if (isQueryCancelled(cancel)) {
      return { ok: false, errorCode: 'QueryCancelled', cancelled: true, message: '事件定位已取消' };
    }

    try {
      const res = await executeEventLocate(this.createEventsHost(cancel), request, qStart, qEnd, targetTimeBig);
      if (!res.ok) {
        return { ok: false, errorCode: 'QueryCancelled', cancelled: true, message: '事件定位已取消' };
      }
      return { ok: true, data: res.data };
    } catch (err) {
      return {
        ok: false,
        errorCode: 'StorageReadError',
        message: `事件定位读取数据页失败: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * 阶段 5.2：有界可取消的 Trace Terminal 格式化输出查询。
   */
  public async queryTerminal(
    request: TraceTerminalQueryRequest,
    cancel?: TraceQueryCancelToken,
  ): Promise<TraceStorageResult<TraceTerminalQueryResult>> {
    if (this.closed || !this.dataHandle) {
      return { ok: false, errorCode: 'RecordingClosed', message: '存储已关闭，无法查询 Trace Terminal' };
    }
    if (isQueryCancelled(cancel)) {
      return { ok: false, errorCode: 'QueryCancelled', cancelled: true, message: 'Trace Terminal 查询已取消' };
    }

    let qStart: bigint;
    let qEnd: bigint;
    try {
      qStart = parseRangeBoundBigInt(request.start, 'start');
      qEnd = parseRangeBoundBigInt(request.end, 'end');
    } catch (err) {
      return { ok: false, errorCode: 'InvalidArgument', message: err instanceof Error ? err.message : String(err) };
    }

    await this.ensureSegmentLeadMetadata(cancel);
    if (isQueryCancelled(cancel)) {
      return { ok: false, errorCode: 'QueryCancelled', cancelled: true, message: 'Trace Terminal 查询已取消' };
    }

    try {
      const res = await executeTerminalQuery(this.createEventsHost(cancel), request, qStart, qEnd);
      if (!res.ok) {
        return { ok: false, errorCode: 'QueryCancelled', cancelled: true, message: 'Trace Terminal 查询已取消' };
      }
      return { ok: true, data: res.data };
    } catch (err) {
      return {
        ok: false,
        errorCode: 'StorageReadError',
        message: `Trace Terminal 读取数据页失败: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * 阶段 5.2：返回有界的解码、重建、存储与缺口诊断。
   */
  public getDiagnostics(options: { bootGeneration?: number; segmentId?: number; limit?: number } = {}): TraceRecordingDiagnosticsResult {
    return buildRecordingDiagnosticsResult({
      gaps: this.index.getGaps(),
      decoderDiagnostics: this.storedDecoderDiagnostics,
      reconstructorDiagnostics: this.storedReconstructorDiagnostics,
      storageDiagnostics: this.inspection?.diagnostics ?? [],
      droppedRecordedDiagnostics: this.droppedRecordedDiagnostics,
      bootGeneration: options.bootGeneration,
      segmentId: options.segmentId,
      limit: options.limit,
    });
  }

  /**
   * 原始流精确导出：逐字节从 `raw.otbin` `[0, committed.rawBytes)` 读取（与输入完全一致，不使用任何 LOD 抽稀）。
   */
  public async exportRaw(options: {
    outputPath?: string;
    onChunk?: (chunk: Uint8Array, offset: number) => Promise<void> | void;
    cancel?: TraceQueryCancelToken;
    verifyChunkCrc32?: boolean;
  }): Promise<TraceStorageResult<{ exportedBytes: number; sha256: string }>> {
    if (this.closed) {
      return { ok: false, errorCode: 'RecordingClosed', message: '存储已关闭，无法导出原始流' };
    }
    const totalBytes = this.committed.rawBytes;
    const hash = createHash('sha256');
    let outHandle: TraceFileHandle | null = null;
    let tmpOutputPath: string | null = null;

    if (options.outputPath) {
      const pathErr = await this.validateExportOutputPath(options.outputPath);
      if (pathErr) {
        return pathErr;
      }
    }

    try {
      if (options.outputPath) {
        tmpOutputPath = `${options.outputPath}.orbit-export-${process.pid}-${++exportTempSeq}.tmp`;
        outHandle = await this.fs.open(tmpOutputPath, 'wx');
      }
      if (totalBytes === 0) {
        if (outHandle && tmpOutputPath && options.outputPath) {
          await outHandle.sync();
          await outHandle.close();
          outHandle = null;
          const pubErr = await this.publishStagedFileNoOverwrite(tmpOutputPath, options.outputPath, options.cancel);
          if (pubErr) {
            return pubErr;
          }
          // tmpOutputPath 由 finally 清理
        }
        return { ok: true, data: { exportedBytes: 0, sha256: hash.digest('hex') } };
      }
      if (!this.rawHandle) {
        return { ok: false, errorCode: 'StorageReadError', message: 'raw.otbin 句柄不可用' };
      }

      const verifyCrc = options.verifyChunkCrc32 ?? Boolean(this.inspection);
      const frames: readonly ParsedJournalFrame[] = this.inspection?.frames ?? [];
      let offset = 0;

      const exportAndVerifyRawSpan = async (
        expectedOffset: number,
        rawLength: number,
        expectedCrc32: number,
        commitSeq: number,
      ): Promise<TraceStorageFailure | null> => {
        if (expectedOffset !== offset) {
          return {
            ok: false,
            errorCode: 'RecordingCorrupted',
            message: `导出时检测到非连续提交偏移 ${expectedOffset} !== ${offset}`,
          };
        }
        let remaining = rawLength;
        let frameCrc = 0;
        while (remaining > 0) {
          if (isQueryCancelled(options.cancel)) {
            return { ok: false, errorCode: 'QueryCancelled', cancelled: true, message: '原始导出已取消' };
          }
          const toRead = Math.min(this.limits.rawChunkBytes, remaining);
          const buf = await readExactFromHandle(this.rawHandle!, offset, toRead);
          frameCrc = computeCrc32(buf, frameCrc);
          hash.update(buf);
          if (outHandle) {
            await writeAllChecked(outHandle, buf, offset, this.limits.rawChunkBytes);
          }
          if (options.onChunk) {
            await options.onChunk(buf, offset);
          }
          offset += toRead;
          remaining -= toRead;
          await yieldToEventLoop();
        }
        if (frameCrc !== expectedCrc32) {
          return {
            ok: false,
            errorCode: 'RecordingCorrupted',
            message: `原始流块 CRC32 校验失败 (commitSeq=${commitSeq})`,
          };
        }
        return null;
      };

      if (verifyCrc && frames.length > 0) {
        for (const f of frames) {
          if (f.rawLength === 0) continue;
          const err = await exportAndVerifyRawSpan(f.rawOffset, f.rawLength, f.rawCrc32, f.commitSeq);
          if (err) return err;
        }
      } else if (verifyCrc) {
        // 新完成写入的录制尚未建立 inspection：以 O(1) 内存顺扫 journal.otj 帧头并逐块核对 rawCrc32
        const journalPath = path.join(this.recordingDir, ORBIT_TRACE_FILES.journal);
        if (await this.fs.exists(journalPath)) {
          const jh = await this.fs.open(journalPath, 'r');
          try {
            let jPos = 0;
            const jSize = this.committed.journalBytes;
            while (jPos + OTJ_HEADER_BYTES <= jSize && offset < totalBytes) {
              const hdr = await readExactFromHandle(jh, jPos, OTJ_HEADER_BYTES);
              if (hdr.readUInt32LE(0) !== OTJ_MAGIC) {
                return { ok: false, errorCode: 'RecordingCorrupted', message: `journal.otj 魔数异常 @ ${jPos}` };
              }
              const expectedHdrCrc = hdr.readUInt32LE(52);
              if (computeCrc32(hdr.subarray(0, 52)) !== expectedHdrCrc) {
                return { ok: false, errorCode: 'RecordingCorrupted', message: `journal.otj 帧头 CRC32 异常 @ ${jPos}` };
              }
              const commitSeq = Number(hdr.readBigUInt64LE(8));
              const rawOffset = Number(hdr.readBigUInt64LE(16));
              const rawLength = hdr.readUInt32LE(24);
              const rawCrc32 = hdr.readUInt32LE(28);
              const metaLen = hdr.readUInt32LE(48);
              if (rawLength > 0) {
                const err = await exportAndVerifyRawSpan(rawOffset, rawLength, rawCrc32, commitSeq);
                if (err) return err;
              }
              jPos += OTJ_HEADER_BYTES + metaLen + OTJ_TRAILER_BYTES;
            }
          } finally {
            await jh.close().catch(() => {});
          }
        }
      }

      if (!verifyCrc || offset < totalBytes) {
        while (offset < totalBytes) {
          if (isQueryCancelled(options.cancel)) {
            return { ok: false, errorCode: 'QueryCancelled', cancelled: true, message: '原始导出已取消' };
          }
          const toRead = Math.min(this.limits.rawChunkBytes, totalBytes - offset);
          const buf = await readExactFromHandle(this.rawHandle, offset, toRead);
          hash.update(buf);
          if (outHandle) {
            await writeAllChecked(outHandle, buf, offset, this.limits.rawChunkBytes);
          }
          if (options.onChunk) {
            await options.onChunk(buf, offset);
          }
          offset += toRead;
          await yieldToEventLoop();
        }
      }

      if (outHandle && tmpOutputPath && options.outputPath) {
        await outHandle.sync();
        await outHandle.close();
        outHandle = null;
        const pubErr = await this.publishStagedFileNoOverwrite(tmpOutputPath, options.outputPath, options.cancel);
        if (pubErr) {
          return pubErr;
        }
        // tmpOutputPath 由 finally 清理
      }
      return {
        ok: true,
        data: {
          exportedBytes: offset,
          sha256: hash.digest('hex'),
        },
      };
    } catch (err) {
      const classified = classifyStorageWriteError(err);
      return {
        ok: false,
        errorCode: classified.errorCode,
        message: classified.message,
      };
    } finally {
      if (outHandle) {
        await outHandle.close().catch(() => {});
      }
      if (tmpOutputPath && this.fs.unlink) {
        await this.fs.unlink(tmpOutputPath).catch(() => {});
      }
    }
  }

  /**
   * 有界分块流式保存 Orbit `orbit-trace-v1` 归档副本到新目录：
   * - 仅拷贝经 `journal.otj` 校验的已提交前缀 `[0, committed.*)`；
   * - 拒绝覆盖源目录/嵌套目录/非空目标目录/已有文件及 `.SVDat` 路径；
   * - 支持 `AbortSignal`/`SharedArrayBuffer` 取消与写失败（ENOSPC/ShortWrite/EIO）全量清理回滚。
   */
  public async saveArchive(options: {
    targetDir: string;
    cancel?: TraceQueryCancelToken;
    verifyChunkCrc32?: boolean;
  }): Promise<TraceStorageResult<{ targetDir: string; inspection: RecordingInspectionResult }>> {
    if (this.closed) {
      return { ok: false, errorCode: 'RecordingClosed', message: '存储已关闭，无法保存归档副本' };
    }
    if (this.mode === 'write' && this.state === 'recording') {
      return { ok: false, errorCode: 'RecordingNotFinalized', message: '录制仍在进行中，请先停止并封存后再保存归档副本' };
    }
    if (!options.targetDir || options.targetDir.trim().length === 0) {
      return { ok: false, errorCode: 'InvalidArgument', message: 'targetDir 不能为空' };
    }
    if (/\.svdat$/i.test(options.targetDir.trim())) {
      return {
        ok: false,
        errorCode: 'UnsupportedCapability',
        message: '不支持导出 SEGGER .SVDat 格式；请保存为 Orbit 归档目录或使用 .bin / .csv',
      };
    }
    if (isQueryCancelled(options.cancel)) {
      return { ok: false, errorCode: 'QueryCancelled', cancelled: true, message: '保存归档已取消' };
    }

    const srcKey = await canonicalizeDirectoryKey(this.recordingDir, this.fs);
    const dstKey = await canonicalizeDirectoryKey(options.targetDir, this.fs);
    const sep = path.sep;
    const srcPrefix = srcKey.endsWith(sep) ? srcKey : srcKey + sep;
    const dstPrefix = dstKey.endsWith(sep) ? dstKey : dstKey + sep;
    if (dstKey === srcKey || dstKey.startsWith(srcPrefix) || srcKey.startsWith(dstPrefix)) {
      return {
        ok: false,
        errorCode: 'ExportPathConflict',
        message: `禁止将归档保存到源录制目录自身、内部子目录或父级冲突路径: ${options.targetDir}`,
      };
    }
    if (activeCreateDirectories.has(dstKey)) {
      return {
        ok: false,
        errorCode: 'RecordingDirectoryBusy',
        message: `目标目录正被其他录制创建/保存任务占用: ${options.targetDir}`,
      };
    }

    // 检查目标路径是否已有文件或非空目录
    if (this.fs.lstat) {
      try {
        const st = await this.fs.lstat(options.targetDir);
        if (st.isSymbolicLink) {
          return {
            ok: false,
            errorCode: 'ExportPathConflict',
            message: `目标路径为符号链接，拒绝覆盖: ${options.targetDir}`,
          };
        }
      } catch {
        // 不存在则继续
      }
    }
    if (await this.fs.exists(options.targetDir)) {
      if (this.fs.readdir) {
        try {
          const entries = await this.fs.readdir(options.targetDir);
          if (entries.length > 0) {
            return {
              ok: false,
              errorCode: 'RecordingDirectoryNotEmpty',
              message: `目标归档目录非空，拒绝覆盖既有文件: ${options.targetDir}`,
            };
          }
        } catch {
          return {
            ok: false,
            errorCode: 'ExportTargetExists',
            message: `目标路径已存在且不是可写空目录: ${options.targetDir}`,
          };
        }
      } else {
        return {
          ok: false,
          errorCode: 'RecordingDirectoryNotEmpty',
          message: `目标路径已存在，拒绝覆盖: ${options.targetDir}`,
        };
      }
    }

    activeCreateDirectories.add(dstKey);
    const createdFiles: string[] = [];
    const openedHandles: TraceFileHandle[] = [];
    let createdTargetDir = false;
    let srcJournalHandle: TraceFileHandle | null = null;
    let srcIndexHandle: TraceFileHandle | null = null;
    let srcSpillHandle: TraceFileHandle | null = null;

    const cleanupOnAbortOrError = async () => {
      await Promise.allSettled(openedHandles.map((h) => h.close()));
      if (this.fs.unlink) {
        await Promise.allSettled(createdFiles.map((f) => this.fs.unlink!(f)));
      }
      if (createdTargetDir && this.fs.rmdir) {
        await this.fs.rmdir(options.targetDir).catch(() => {});
      }
    };

    const streamCopySpan = async (
      srcHandle: TraceFileHandle,
      dstPath: string,
      totalBytes: number,
      verifyRawFrames?: readonly ParsedJournalFrame[],
    ): Promise<{ sha256: string } | TraceStorageFailure> => {
      let dstHandle: TraceFileHandle | null = null;
      try {
        dstHandle = await this.fs.open(dstPath, 'wx');
        createdFiles.push(dstPath);
        openedHandles.push(dstHandle);
      } catch (err) {
        if (isAlreadyExistsError(err)) {
          return { ok: false, errorCode: 'RecordingDirectoryNotEmpty', message: `目标文件已存在: ${dstPath}` };
        }
        throw err;
      }

      const hash = createHash('sha256');
      let offset = 0;

      if (verifyRawFrames && verifyRawFrames.length > 0) {
        for (const frame of verifyRawFrames) {
          if (frame.rawLength === 0) continue;
          if (frame.rawOffset !== offset) {
            return {
              ok: false,
              errorCode: 'RecordingCorrupted',
              message: `保存归档时检测到非连续原始块偏移 ${frame.rawOffset} !== ${offset}`,
            };
          }
          let rem = frame.rawLength;
          let frameCrc = 0;
          while (rem > 0) {
            if (isQueryCancelled(options.cancel)) {
              return { ok: false, errorCode: 'QueryCancelled', cancelled: true, message: '保存归档已取消' };
            }
            const toRead = Math.min(this.limits.rawChunkBytes, rem);
            const buf = await readExactFromHandle(srcHandle, offset, toRead);
            frameCrc = computeCrc32(buf, frameCrc);
            hash.update(buf);
            await writeAllChecked(dstHandle, buf, offset, this.limits.rawChunkBytes);
            offset += toRead;
            rem -= toRead;
            await yieldToEventLoop();
          }
          if (frameCrc !== frame.rawCrc32) {
            return {
              ok: false,
              errorCode: 'RecordingCorrupted',
              message: `保存归档时原始块 CRC32 校验失败 (commitSeq=${frame.commitSeq})`,
            };
          }
        }
      }

      while (offset < totalBytes) {
        if (isQueryCancelled(options.cancel)) {
          return { ok: false, errorCode: 'QueryCancelled', cancelled: true, message: '保存归档已取消' };
        }
        const toRead = Math.min(this.limits.rawChunkBytes, totalBytes - offset);
        const buf = await readExactFromHandle(srcHandle, offset, toRead);
        hash.update(buf);
        await writeAllChecked(dstHandle, buf, offset, this.limits.rawChunkBytes);
        offset += toRead;
        await yieldToEventLoop();
      }

      await dstHandle.sync();
      await dstHandle.close();
      const idx = openedHandles.indexOf(dstHandle);
      if (idx >= 0) openedHandles.splice(idx, 1);
      return { sha256: hash.digest('hex') };
    };

    try {
      if (!(await this.fs.exists(options.targetDir))) {
        await this.fs.mkdir(options.targetDir, { recursive: true });
        createdTargetDir = true;
      }

      const totalRaw = this.committed.rawBytes;
      const totalData = this.committed.dataBytes;
      const totalJournal = this.committed.journalBytes;

      if (totalRaw > 0 && !this.rawHandle) {
        await cleanupOnAbortOrError();
        return { ok: false, errorCode: 'StorageReadError', message: 'raw.otbin 句柄不可用' };
      }
      if (totalData > 0 && !this.dataHandle) {
        await cleanupOnAbortOrError();
        return { ok: false, errorCode: 'StorageReadError', message: 'data.otd 句柄不可用' };
      }

      const verifyCrc = options.verifyChunkCrc32 ?? true;
      const rawFrames = verifyCrc ? this.inspection?.frames : undefined;
      let savedRawSha = createHash('sha256').digest('hex');

      if (this.rawHandle) {
        const rawCopy = await streamCopySpan(
          this.rawHandle,
          path.join(options.targetDir, ORBIT_TRACE_FILES.raw),
          totalRaw,
          rawFrames,
        );
        if ('ok' in rawCopy) {
          await cleanupOnAbortOrError();
          return rawCopy;
        }
        savedRawSha = rawCopy.sha256;
      } else {
        const emptyRaw = await this.fs.open(path.join(options.targetDir, ORBIT_TRACE_FILES.raw), 'wx');
        createdFiles.push(path.join(options.targetDir, ORBIT_TRACE_FILES.raw));
        await emptyRaw.sync();
        await emptyRaw.close();
      }

      if (this.dataHandle) {
        const dataCopy = await streamCopySpan(
          this.dataHandle,
          path.join(options.targetDir, ORBIT_TRACE_FILES.data),
          totalData,
        );
        if ('ok' in dataCopy) {
          await cleanupOnAbortOrError();
          return dataCopy;
        }
      } else {
        const emptyData = await this.fs.open(path.join(options.targetDir, ORBIT_TRACE_FILES.data), 'wx');
        createdFiles.push(path.join(options.targetDir, ORBIT_TRACE_FILES.data));
        await emptyData.sync();
        await emptyData.close();
      }

      const srcJournalPath = path.join(this.recordingDir, ORBIT_TRACE_FILES.journal);
      if (totalJournal > 0 && (await this.fs.exists(srcJournalPath))) {
        srcJournalHandle = await this.fs.open(srcJournalPath, 'r');
        const journalCopy = await streamCopySpan(
          srcJournalHandle,
          path.join(options.targetDir, ORBIT_TRACE_FILES.journal),
          totalJournal,
        );
        await srcJournalHandle.close().catch(() => {});
        srcJournalHandle = null;
        if ('ok' in journalCopy) {
          await cleanupOnAbortOrError();
          return journalCopy;
        }
      } else {
        const emptyJournal = await this.fs.open(path.join(options.targetDir, ORBIT_TRACE_FILES.journal), 'wx');
        createdFiles.push(path.join(options.targetDir, ORBIT_TRACE_FILES.journal));
        await emptyJournal.sync();
        await emptyJournal.close();
      }

      const srcSpillPath = path.join(this.recordingDir, 'index-spill.otidx');
      const dstSpillPath = path.join(options.targetDir, 'index-spill.otidx');
      let spillCopied = false;
      if (this.index.getCompactedBlocks().length > 0 && (await this.fs.exists(srcSpillPath))) {
        const spillStat = await this.fs.stat(srcSpillPath);
        if (spillStat.size > 0) {
          srcSpillHandle = await this.fs.open(srcSpillPath, 'r');
          const spillCopy = await streamCopySpan(srcSpillHandle, dstSpillPath, spillStat.size);
          await srcSpillHandle.close().catch(() => {});
          srcSpillHandle = null;
          if ('ok' in spillCopy) {
            await cleanupOnAbortOrError();
            return spillCopy;
          }
          spillCopied = true;
        }
      }
      if (!spillCopied) {
        const emptySpill = await this.fs.open(dstSpillPath, 'wx');
        createdFiles.push(dstSpillPath);
        await emptySpill.sync();
        await emptySpill.close();
      }

      if (isQueryCancelled(options.cancel)) {
        await cleanupOnAbortOrError();
        return { ok: false, errorCode: 'QueryCancelled', cancelled: true, message: '保存归档已取消' };
      }

      const srcIndexPath = path.join(this.recordingDir, ORBIT_TRACE_FILES.index);
      const dstIndexPath = path.join(options.targetDir, ORBIT_TRACE_FILES.index);
      const canCopySourceIndex =
        this.inspection !== undefined
          ? this.inspection.isComplete && this.inspection.indexStatus === 'valid'
          : this.state === 'completed';

      if (canCopySourceIndex && (await this.fs.exists(srcIndexPath))) {
        const idxSize = (await this.fs.stat(srcIndexPath)).size;
        srcIndexHandle = await this.fs.open(srcIndexPath, 'r');
        const idxCopy = await streamCopySpan(srcIndexHandle, dstIndexPath, idxSize);
        await srcIndexHandle.close().catch(() => {});
        srcIndexHandle = null;
        if ('ok' in idxCopy) {
          await cleanupOnAbortOrError();
          return idxCopy;
        }
      } else if (
        this.inspection?.recoveryDisposition === 'rebuilt-bad-index' &&
        this.index.getCompactedBlocks().length === 0
      ) {
        const rebuiltIdx = encodeIndexSnapshot({
          format: ORBIT_TRACE_FORMAT,
          formatVersion: ORBIT_TRACE_FORMAT_VERSION,
          segments: this.index.getSegments(),
          pages: this.index.getAllInMemoryPages(),
          gaps: this.index.getGaps(),
          tasks: Array.from(this.pendingTasks.values()),
        });
        const idxH = await this.fs.open(dstIndexPath, 'wx');
        createdFiles.push(dstIndexPath);
        openedHandles.push(idxH);
        await writeAllChecked(idxH, rebuiltIdx, 0, this.limits.rawChunkBytes);
        await idxH.sync();
        await idxH.close();
        const pos = openedHandles.indexOf(idxH);
        if (pos >= 0) openedHandles.splice(pos, 1);
      }

      const savedState: RecordingLifecycleState =
        this.inspection?.recoveryDisposition === 'rebuilt-bad-index'
          ? 'completed'
          : this.inspection?.hasCommittedChunkCorruption
            ? 'interrupted'
            : this.state === 'recording'
              ? 'interrupted'
              : this.state;

      const savedManifest: TraceRecordingManifest = {
        ...this.getManifestSnapshot(),
        state: savedState,
        updatedAtMs: Date.now(),
        ...(this.inspection?.hasCommittedChunkCorruption
          ? {
              closeReason: 'recovered-prefix',
              failureCode: 'RecoveredPrefix',
              failureDiagnostics: {
                ...(this.failureDiagnostics ?? {}),
                sourceStatus: this.state,
                recoveredRawBytes: this.committed.rawBytes,
              },
            }
          : {}),
        committed: { ...this.committed },
        rawSha256: savedRawSha,
      };

      const manifestTmpPath = path.join(options.targetDir, ORBIT_TRACE_FILES.manifestTmp);
      const manifestFinalPath = path.join(options.targetDir, ORBIT_TRACE_FILES.manifest);
      const manifestBuf = Buffer.from(safeTraceJsonStringify(savedManifest, 2) + '\n', 'utf8');
      const mh = await this.fs.open(manifestTmpPath, 'wx');
      createdFiles.push(manifestTmpPath);
      openedHandles.push(mh);
      await writeAllChecked(mh, manifestBuf, 0, this.limits.rawChunkBytes);
      await mh.sync();
      await mh.close();
      const mhIdx = openedHandles.indexOf(mh);
      if (mhIdx >= 0) openedHandles.splice(mhIdx, 1);
      const manifestPubErr = await this.publishStagedFileNoOverwrite(manifestTmpPath, manifestFinalPath, options.cancel);
      if (manifestPubErr) {
        await cleanupOnAbortOrError();
        return manifestPubErr;
      }
      if (this.fs.unlink) {
        await this.fs.unlink(manifestTmpPath).catch(() => {});
      }
      const tmpPos = createdFiles.indexOf(manifestTmpPath);
      if (tmpPos >= 0) createdFiles.splice(tmpPos, 1);
      createdFiles.push(manifestFinalPath);

      const savedInspection = await inspectRecordingDirectory(options.targetDir, this.fs, {
        verifyRawSha256: true,
      });
      return {
        ok: true,
        data: {
          targetDir: options.targetDir,
          inspection: savedInspection,
        },
      };
    } catch (err) {
      await cleanupOnAbortOrError();
      const classified = classifyStorageWriteError(err);
      return {
        ok: false,
        errorCode: classified.errorCode,
        message: classified.message,
      };
    } finally {
      await Promise.allSettled([
        srcJournalHandle?.close(),
        srcIndexHandle?.close(),
        srcSpillHandle?.close(),
      ]);
      activeCreateDirectories.delete(dstKey);
    }
  }

  /**
   * 有界分块流式导出 CSV（复用 Worker 分页/过滤/格式化引擎）：
   * - 按页流式读取 `data.otd`，以有界缓冲区写入独占临时文件后原子重命名提交；
   * - 显式携带记录元数据、时间单位、时基（`timeDomain`/`timeAnchorStatus`/`sysFreqHz`）与不确定性标志；
   * - 拒绝覆盖已有文件、自导出到录制目录及 `.SVDat` 路径；支持取消与写失败清理回滚。
   */
  public async exportCsv(options: {
    outputPath: string;
    request: TraceCsvExportRequest;
    cancel?: TraceQueryCancelToken;
  }): Promise<TraceStorageResult<TraceCsvExportResult>> {
    if (this.closed || !this.dataHandle) {
      return { ok: false, errorCode: 'RecordingClosed', message: '存储已关闭，无法导出 CSV' };
    }
    if (isQueryCancelled(options.cancel)) {
      return { ok: false, errorCode: 'QueryCancelled', cancelled: true, message: 'CSV 导出已取消' };
    }

    let qStart: bigint;
    let qEnd: bigint;
    try {
      qStart = parseRangeBoundBigInt(options.request.start, 'start');
      qEnd = parseRangeBoundBigInt(options.request.end, 'end');
    } catch (err) {
      return { ok: false, errorCode: 'InvalidArgument', message: err instanceof Error ? err.message : String(err) };
    }
    if (qEnd <= qStart) {
      return { ok: false, errorCode: 'InvalidArgument', message: `CSV 导出区间无效: start=${qStart} >= end=${qEnd}` };
    }

    const pathErr = await this.validateExportOutputPath(options.outputPath);
    if (pathErr) {
      return pathErr;
    }

    await this.ensureSegmentLeadMetadata(options.cancel);
    if (isQueryCancelled(options.cancel)) {
      return { ok: false, errorCode: 'QueryCancelled', cancelled: true, message: 'CSV 导出已取消' };
    }

    let outHandle: TraceFileHandle | null = null;
    let tmpOutputPath: string | null = null;
    let writeOffset = 0;

    try {
      tmpOutputPath = `${options.outputPath}.orbit-csv-${process.pid}-${++exportTempSeq}.tmp`;
      outHandle = await this.fs.open(tmpOutputPath, 'wx');

      const archiveState = this.inspection?.status ?? this.state;
      const recoveryDisposition =
        this.inspection?.recoveryDisposition ??
        (archiveState === 'completed'
          ? 'intact'
          : archiveState === 'failed'
            ? 'recovered-failed'
            : 'recovered-interrupted');

      const streamRes = await streamEventsToCsvWriter({
        host: this.createEventsHost(options.cancel),
        recordId: this.recordId,
        archiveState,
        recoveryDisposition,
        request: options.request,
        qStart,
        qEnd,
        chunkSizeBytes: this.limits.rawChunkBytes,
        writeChunk: async (chunk) => {
          await writeAllChecked(outHandle!, chunk, writeOffset, this.limits.rawChunkBytes);
          writeOffset += chunk.length;
        },
      });

      if (!streamRes.ok) {
        return { ok: false, errorCode: 'QueryCancelled', cancelled: true, message: 'CSV 导出已取消' };
      }

      await outHandle.sync();
      await outHandle.close();
      outHandle = null;

      const pubErr = await this.publishStagedFileNoOverwrite(tmpOutputPath, options.outputPath, options.cancel);
      if (pubErr) {
        return pubErr;
      }
      // tmpOutputPath 由 finally 清理

      return {
        ok: true,
        data: {
          outputPath: options.outputPath,
          exportedRows: streamRes.data.exportedRows,
          exportedBytes: streamRes.data.exportedBytes,
          sha256: streamRes.data.sha256,
          exportSource: options.request.exportSource,
          unit: options.request.unit,
          start: qStart.toString(),
          end: qEnd.toString(),
          archiveState,
          recoveryDisposition,
          skippedUnanchoredSegments: streamRes.data.skippedUnanchoredSegments,
          skippedNoFrequencySegments: streamRes.data.skippedNoFrequencySegments,
          gapsInWindow: streamRes.data.gapsInWindow,
          hasTargetOverflow: streamRes.data.hasTargetOverflow,
          hasHostDrop: streamRes.data.hasHostDrop,
        },
      };
    } catch (err) {
      const classified = classifyStorageWriteError(err);
      return {
        ok: false,
        errorCode: classified.errorCode,
        message: classified.message,
      };
    } finally {
      if (outHandle) {
        await outHandle.close().catch(() => {});
      }
      if (tmpOutputPath && this.fs.unlink) {
        await this.fs.unlink(tmpOutputPath).catch(() => {});
      }
    }
  }

  private async validateExportOutputPath(outputPath: string): Promise<TraceStorageFailure | null> {
    if (!outputPath || outputPath.trim().length === 0) {
      return { ok: false, errorCode: 'InvalidArgument', message: 'outputPath 不能为空' };
    }
    if (/\.svdat$/i.test(outputPath.trim())) {
      return {
        ok: false,
        errorCode: 'UnsupportedCapability',
        message: '不支持导出 SEGGER .SVDat 格式，请使用 .bin、.csv 或 Orbit 归档目录',
      };
    }
    const recDirKey = await canonicalizeDirectoryKey(this.recordingDir, this.fs);
    const outKey = await canonicalizeFilePathKey(outputPath, this.fs);

    if (outKey === recDirKey || outKey.startsWith(recDirKey + (recDirKey.endsWith(path.sep) ? '' : path.sep))) {
      return {
        ok: false,
        errorCode: 'ExportPathConflict',
        message: `禁止导出到录制目录内部或覆盖录制文件: ${outputPath}`,
      };
    }

    const archiveNames = [
      ORBIT_TRACE_FILES.raw,
      ORBIT_TRACE_FILES.data,
      ORBIT_TRACE_FILES.journal,
      ORBIT_TRACE_FILES.manifest,
      ORBIT_TRACE_FILES.manifestTmp,
      ORBIT_TRACE_FILES.index,
      ORBIT_TRACE_FILES.indexTmp,
      'index-spill.otidx',
    ];

    if (await this.fs.exists(outputPath)) {
      try {
        const outStat = await this.fs.stat(outputPath);
        for (const name of archiveNames) {
          const recFile = path.join(this.recordingDir, name);
          if (await this.fs.exists(recFile)) {
            const recStat = await this.fs.stat(recFile);
            if (
              outStat.dev !== undefined &&
              recStat.dev !== undefined &&
              outStat.ino !== undefined &&
              recStat.ino !== undefined &&
              outStat.dev === recStat.dev &&
              outStat.ino === recStat.ino &&
              outStat.ino !== 0
            ) {
              return {
                ok: false,
                errorCode: 'ExportPathConflict',
                message: `导出目标与录制文件指向同一物理文件 (硬链接/符号链接别名): ${outputPath}`,
              };
            }
          }
        }
      } catch {
        // stat 失败仍按已有文件拒绝覆盖
      }
      return {
        ok: false,
        errorCode: 'ExportTargetExists',
        message: `导出目标已存在，拒绝覆盖既有文件: ${outputPath}`,
      };
    }

    // 若 outputPath 为悬空符号链接，lstat 也能检测到并拒绝覆盖
    if (this.fs.lstat) {
      try {
        await this.fs.lstat(outputPath);
        return {
          ok: false,
          errorCode: 'ExportTargetExists',
          message: `导出目标路径已存在（符号链接），拒绝覆盖: ${outputPath}`,
        };
      } catch {
        // 不存在则可继续
      }
    }

    return null;
  }

  /**
   * 提交时原子拒绝既有目标的无覆盖发布：
   * 1. 优先使用同文件系统原子硬链接 `link(stagedPath, destinationPath)`（若目标已存在则内核原子返回 `EEXIST`）；
   * 2. 当底层文件系统不支持硬链接或自定义 `TraceFileSystem` 未实现 `link` 时，退回排他创建 `open(destinationPath, 'wx')` 并分块拷贝；
   * 3. 全程禁止先检查再用可覆盖目标的 `rename`，亦绝不删除非本调用排他创建的外部目标文件。
   */
  private async publishStagedFileNoOverwrite(
    stagedPath: string,
    destinationPath: string,
    cancel?: TraceQueryCancelToken,
  ): Promise<TraceStorageFailure | null> {
    if (isQueryCancelled(cancel)) {
      return { ok: false, errorCode: 'QueryCancelled', cancelled: true, message: '发布导出文件前已取消' };
    }

    if (typeof this.fs.link === 'function') {
      try {
        await this.fs.link(stagedPath, destinationPath);
        return null;
      } catch (err) {
        const code = err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
        if (isAlreadyExistsError(err) || code === 'EISDIR') {
          return {
            ok: false,
            errorCode: 'ExportTargetExists',
            message: `导出目标在提交时已存在，拒绝覆盖既有文件: ${destinationPath}`,
          };
        }
        if (!isUnsupportedLinkError(err)) {
          throw err;
        }
      }
    }

    let dstHandle: TraceFileHandle | null = null;
    let srcHandle: TraceFileHandle | null = null;
    let dstOwnedByUs = false;
    try {
      try {
        dstHandle = await this.fs.open(destinationPath, 'wx');
        dstOwnedByUs = true;
      } catch (err) {
        const code = err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
        if (isAlreadyExistsError(err) || code === 'EISDIR') {
          return {
            ok: false,
            errorCode: 'ExportTargetExists',
            message: `导出目标在提交时已存在，拒绝覆盖既有文件: ${destinationPath}`,
          };
        }
        throw err;
      }

      srcHandle = await this.fs.open(stagedPath, 'r');
      const copyBuf = Buffer.allocUnsafe(Math.max(4096, Math.min(this.limits.rawChunkBytes, 256 * 1024)));
      let offset = 0;
      while (true) {
        if (isQueryCancelled(cancel)) {
          await srcHandle.close().catch(() => {});
          srcHandle = null;
          await dstHandle.close().catch(() => {});
          dstHandle = null;
          if (dstOwnedByUs && this.fs.unlink) {
            await this.fs.unlink(destinationPath).catch(() => {});
          }
          return { ok: false, errorCode: 'QueryCancelled', cancelled: true, message: '导出发布过程中已取消' };
        }
        const readRes = await srcHandle.read(copyBuf, 0, copyBuf.length, offset);
        if (readRes.bytesRead <= 0) {
          break;
        }
        const slice = copyBuf.subarray(0, readRes.bytesRead);
        await writeAllChecked(dstHandle, slice, offset, this.limits.rawChunkBytes);
        offset += readRes.bytesRead;
        await yieldToEventLoop();
      }
      await srcHandle.close().catch(() => {});
      srcHandle = null;
      await dstHandle.sync();
      await dstHandle.close();
      dstHandle = null;
      return null;
    } catch (err) {
      await srcHandle?.close().catch(() => {});
      await dstHandle?.close().catch(() => {});
      if (dstOwnedByUs && this.fs.unlink) {
        await this.fs.unlink(destinationPath).catch(() => {});
      }
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function estimatePacketBytes(pkt: DecodedSystemViewPacket): number {
  let extra = 72;
  if (pkt.decoded.kind === 'sysdesc') extra += pkt.decoded.rawText.length;
  else if (pkt.decoded.kind === 'print-formatted') extra += pkt.decoded.text.length;
  else if (pkt.decoded.kind === 'task-info') extra += pkt.decoded.name.length;
  else if ('rawPayload' in pkt.decoded && pkt.decoded.rawPayload instanceof Uint8Array) {
    extra += pkt.decoded.rawPayload.length;
  }
  return extra;
}

function itemMatchesRange(
  target: TraceQueryTarget,
  item: any,
  unit: TraceQueryTimeUnit,
  qStart: bigint,
  qEnd: bigint,
  segmentMeta: SegmentIndexMetadata,
): boolean {
  if (target === 'packets') {
    const pt = getPacketTimeForUnit(item as DecodedSystemViewPacket, unit, segmentMeta.sysFreqHz);
    if (!pt) return false;
    return intersectsHalfOpen(pt.start, pt.end, qStart, qEnd, pt.isPoint);
  }
  if (target === 'markerPoints') {
    const mp = getMarkerPointTimeForUnit(item as MarkerPointEvent, unit, segmentMeta);
    if (!mp) return false;
    return intersectsHalfOpen(mp.start, undefined, qStart, qEnd, true);
  }
  const bounds = getIntervalBoundsForUnit(item, unit, segmentMeta);
  if (!bounds) return false;
  return intersectsHalfOpen(bounds.start, bounds.end, qStart, qEnd, bounds.isPoint);
}

function getItemSortKey(target: TraceQueryTarget, item: any): bigint {
  if (target === 'packets') {
    return (item as DecodedSystemViewPacket).segmentRelativeTicksBigInt;
  }
  if (target === 'markerPoints') {
    return (item as MarkerPointEvent).time.relativeTicksBigInt;
  }
  return (item.start?.relativeTicksBigInt ?? 0n) as bigint;
}

function compareItemsByTime(target: TraceQueryTarget, a: any, b: any): number {
  const segA = (a.segmentId ?? 0) as number;
  const segB = (b.segmentId ?? 0) as number;
  if (segA !== segB) return segA - segB;
  const ta = getItemSortKey(target, a);
  const tb = getItemSortKey(target, b);
  if (ta < tb) return -1;
  if (ta > tb) return 1;
  return 0;
}

function computeDescriptorAndLod(
  pageId: number,
  kind: TracePageKind,
  bootGeneration: number,
  segmentId: number,
  items: readonly any[],
  dataLength: number,
  dataCrc32: number,
  segMeta?: SegmentIndexMetadata,
): { desc: IndexedPageDescriptor; lod: PageLodSummary } {
  let minRel: bigint | undefined;
  let maxRel: bigint | undefined;
  let minAbs: bigint | undefined;
  let maxAbs: bigint | undefined;
  let allAbs = true;
  let minNs: bigint | undefined;
  let maxNs: bigint | undefined;
  let minByte = Number.MAX_SAFE_INTEGER;
  let maxByte = 0;
  let maxDur = 0n;
  let hasIncomplete = false;
  let hasUncertain = false;
  let sysFreqHz = segMeta?.sysFreqHz;

  const ticksByKind = { task: 0n, isr: 0n, idle: 0n, scheduler: 0n };
  const ctxTicks = new Map<string, { contextKind: string; label?: string; ticks: bigint }>();

  for (const item of items) {
    if (kind === 'packets') {
      const pkt = item as DecodedSystemViewPacket;
      const r = pkt.segmentRelativeTicksBigInt;
      if (minRel === undefined || r < minRel) minRel = r;
      if (maxRel === undefined || r > maxRel) maxRel = r;
      if (pkt.absoluteTicksBigInt !== undefined) {
        if (minAbs === undefined || pkt.absoluteTicksBigInt < minAbs) minAbs = pkt.absoluteTicksBigInt;
        if (maxAbs === undefined || pkt.absoluteTicksBigInt > maxAbs) maxAbs = pkt.absoluteTicksBigInt;
      } else {
        allAbs = false;
      }
      const ns = pkt.timestampNs !== undefined ? BigInt(pkt.timestampNs) : undefined;
      if (ns !== undefined) {
        if (minNs === undefined || ns < minNs) minNs = ns;
        if (maxNs === undefined || ns > maxNs) maxNs = ns;
      }
      if (pkt.streamByteOffset < minByte) minByte = pkt.streamByteOffset;
      const endByte = pkt.streamByteOffset + Math.max(1, pkt.byteLength);
      if (endByte > maxByte) maxByte = endByte;
      if (pkt.segmentReliability === 'uncertain') hasUncertain = true;
      if (pkt.sysFreqHz !== undefined) sysFreqHz = pkt.sysFreqHz;
    } else if (kind === 'markerPoints') {
      const mp = item as MarkerPointEvent;
      const r = mp.time.relativeTicksBigInt;
      if (minRel === undefined || r < minRel) minRel = r;
      if (maxRel === undefined || r > maxRel) maxRel = r;
      if (mp.time.absoluteTicksBigInt !== undefined) {
        if (minAbs === undefined || mp.time.absoluteTicksBigInt < minAbs) minAbs = mp.time.absoluteTicksBigInt;
        if (maxAbs === undefined || mp.time.absoluteTicksBigInt > maxAbs) maxAbs = mp.time.absoluteTicksBigInt;
      } else {
        allAbs = false;
      }
      const ns = mp.time.timestampNs !== undefined ? BigInt(mp.time.timestampNs) : undefined;
      if (ns !== undefined) {
        if (minNs === undefined || ns < minNs) minNs = ns;
        if (maxNs === undefined || ns > maxNs) maxNs = ns;
      }
      if (mp.time.streamByteOffset < minByte) minByte = mp.time.streamByteOffset;
      if (mp.time.streamByteOffset > maxByte) maxByte = mp.time.streamByteOffset;
      if (mp.segmentReliability === 'uncertain') hasUncertain = true;
      if (mp.time.sysFreqHz !== undefined) sysFreqHz = mp.time.sysFreqHz;
    } else {
      const sPt = item.start as TraceTimePoint | undefined;
      const ePt = (item.end ?? item.observedUntil) as TraceTimePoint | undefined;
      if (item.completeness === 'incomplete') hasIncomplete = true;
      if (item.completeness === 'uncertain' || item.segmentReliability === 'uncertain') hasUncertain = true;

      if (sPt) {
        if (minRel === undefined || sPt.relativeTicksBigInt < minRel) minRel = sPt.relativeTicksBigInt;
        const eRel = ePt?.relativeTicksBigInt ?? (segMeta ? BigInt(segMeta.maxRelativeTicks) : sPt.relativeTicksBigInt);
        if (maxRel === undefined || eRel > maxRel) maxRel = eRel;
        const dur: bigint = eRel > sPt.relativeTicksBigInt ? eRel - sPt.relativeTicksBigInt : 0n;
        if (dur > maxDur) maxDur = dur;

        if (sPt.absoluteTicksBigInt !== undefined) {
          if (minAbs === undefined || sPt.absoluteTicksBigInt < minAbs) minAbs = sPt.absoluteTicksBigInt;
          const eAbs = ePt?.absoluteTicksBigInt ?? (segMeta?.lastAbsoluteTicks ? BigInt(segMeta.lastAbsoluteTicks) : sPt.absoluteTicksBigInt);
          if (maxAbs === undefined || eAbs > maxAbs) maxAbs = eAbs;
        } else {
          allAbs = false;
        }

        const f = sPt.sysFreqHz ?? ePt?.sysFreqHz ?? sysFreqHz;
        if (f !== undefined) sysFreqHz = f;
        const sNs = getTimePointValueForUnit(sPt, 'ns', f);
        const eNs = getTimePointValueForUnit(ePt, 'ns', f) ?? (segMeta?.maxNs ? BigInt(segMeta.maxNs) : sNs);
        if (sNs !== undefined) {
          if (minNs === undefined || sNs < minNs) minNs = sNs;
          if (eNs !== undefined && (maxNs === undefined || eNs > maxNs)) maxNs = eNs;
        }

        if (sPt.streamByteOffset < minByte) minByte = sPt.streamByteOffset;
        const eByte = ePt?.streamByteOffset ?? sPt.streamByteOffset;
        if (eByte > maxByte) maxByte = eByte;

        if (kind === 'slices' || kind === 'longSlices') {
          const sl = item as ExecutionSliceInterval;
          ticksByKind[sl.contextKind] += dur;
          const prev = ctxTicks.get(sl.contextKey);
          if (prev) prev.ticks += dur;
          else ctxTicks.set(sl.contextKey, { contextKind: sl.contextKind, label: sl.label, ticks: dur });
        }
      } else if (ePt) {
        if (minRel === undefined || ePt.relativeTicksBigInt < minRel) minRel = ePt.relativeTicksBigInt;
        if (maxRel === undefined || ePt.relativeTicksBigInt > maxRel) maxRel = ePt.relativeTicksBigInt;
        if (ePt.absoluteTicksBigInt !== undefined) {
          if (minAbs === undefined || ePt.absoluteTicksBigInt < minAbs) minAbs = ePt.absoluteTicksBigInt;
          if (maxAbs === undefined || ePt.absoluteTicksBigInt > maxAbs) maxAbs = ePt.absoluteTicksBigInt;
        } else {
          allAbs = false;
        }
        const f = ePt.sysFreqHz ?? sysFreqHz;
        if (f !== undefined) sysFreqHz = f;
        const eNs = getTimePointValueForUnit(ePt, 'ns', f);
        if (eNs !== undefined) {
          if (minNs === undefined || eNs < minNs) minNs = eNs;
          if (maxNs === undefined || eNs > maxNs) maxNs = eNs;
        }
        if (ePt.streamByteOffset < minByte) minByte = ePt.streamByteOffset;
        if (ePt.streamByteOffset > maxByte) maxByte = ePt.streamByteOffset;
      }
    }
  }

  let dominantContext: PageLodSummary['dominantContext'];
  let bestCtx = -1n;
  for (const [ctxKey, info] of ctxTicks.entries()) {
    if (info.ticks > bestCtx) {
      bestCtx = info.ticks;
      dominantContext = {
        contextKind: info.contextKind,
        contextKey: ctxKey,
        label: info.label,
        ticks: info.ticks.toString(),
      };
    }
  }

  const desc: IndexedPageDescriptor = {
    pageId,
    kind,
    bootGeneration,
    segmentId,
    dataOffset: 0,
    dataLength,
    dataCrc32,
    itemCount: items.length,
    isLongIntervalPage:
      kind === 'longSlices' || kind === 'longActivations' || kind === 'longReadyWaits' || kind === 'longMarkers',
    minRelativeTicks: (minRel ?? 0n).toString(),
    maxRelativeTicks: (maxRel ?? 0n).toString(),
    hasAbsoluteTicks: minAbs !== undefined && maxAbs !== undefined,
    allAbsoluteTicks: allAbs && minAbs !== undefined && maxAbs !== undefined,
    minAbsoluteTicks: minAbs?.toString(),
    maxAbsoluteTicks: maxAbs?.toString(),
    sysFreqHz,
    minNs: minNs?.toString(),
    maxNs: maxNs?.toString(),
    minByteOffset: minByte === Number.MAX_SAFE_INTEGER ? 0 : minByte,
    maxByteOffset: maxByte,
    maxDurationTicks: maxDur.toString(),
    hasIncomplete,
    hasUncertain,
  };

  const lod: PageLodSummary = {
    pageId,
    kind,
    bootGeneration,
    segmentId,
    minRelativeTicks: desc.minRelativeTicks,
    maxRelativeTicks: desc.maxRelativeTicks,
    minAbsoluteTicks: desc.minAbsoluteTicks,
    maxAbsoluteTicks: desc.maxAbsoluteTicks,
    sysFreqHz: desc.sysFreqHz,
    minNs: desc.minNs,
    maxNs: desc.maxNs,
    itemCount: items.length,
    hasIncomplete,
    hasUncertain,
    sliceTicksByKind:
      kind === 'slices' || kind === 'longSlices'
        ? {
            task: ticksByKind.task.toString(),
            isr: ticksByKind.isr.toString(),
            idle: ticksByKind.idle.toString(),
            scheduler: ticksByKind.scheduler.toString(),
          }
        : undefined,
    dominantContext,
  };

  return { desc, lod };
}

function buildBasicLodSummaryFromDescriptor(d: IndexedPageDescriptor): PageLodSummary {
  return {
    pageId: d.pageId,
    kind: d.kind,
    bootGeneration: d.bootGeneration,
    segmentId: d.segmentId,
    minRelativeTicks: d.minRelativeTicks,
    maxRelativeTicks: d.maxRelativeTicks,
    minAbsoluteTicks: d.minAbsoluteTicks,
    maxAbsoluteTicks: d.maxAbsoluteTicks,
    sysFreqHz: d.sysFreqHz,
    minNs: d.minNs,
    maxNs: d.maxNs,
    itemCount: d.itemCount,
    hasIncomplete: d.hasIncomplete,
    hasUncertain: d.hasUncertain,
  };
}

function getLodSummaryBounds(
  sum: PageLodSummary,
  unit: TraceQueryTimeUnit,
): { min: bigint; max: bigint } | undefined {
  switch (unit) {
    case 'relative-ticks':
      return { min: BigInt(sum.minRelativeTicks), max: BigInt(sum.maxRelativeTicks) };
    case 'absolute-ticks':
      if (sum.minAbsoluteTicks === undefined || sum.maxAbsoluteTicks === undefined) return undefined;
      return { min: BigInt(sum.minAbsoluteTicks), max: BigInt(sum.maxAbsoluteTicks) };
    case 'ns':
      if (sum.minNs !== undefined && sum.maxNs !== undefined) {
        return { min: BigInt(sum.minNs), max: BigInt(sum.maxNs) };
      }
      if (sum.minAbsoluteTicks !== undefined && sum.maxAbsoluteTicks !== undefined && sum.sysFreqHz && sum.sysFreqHz > 0) {
        return {
          min: ticksToNsBigInt(BigInt(sum.minAbsoluteTicks), sum.sysFreqHz),
          max: ticksToNsBigInt(BigInt(sum.maxAbsoluteTicks), sum.sysFreqHz),
        };
      }
      return undefined;
    case 'relative-ns':
      if (!sum.sysFreqHz || sum.sysFreqHz <= 0) return undefined;
      return {
        min: ticksToNsBigInt(BigInt(sum.minRelativeTicks), sum.sysFreqHz),
        max: ticksToNsBigInt(BigInt(sum.maxRelativeTicks), sum.sysFreqHz),
      };
    case 'byte-offset':
      return undefined;
  }
}

const activeCreateDirectories = new Set<string>();
let exportTempSeq = 0;

function createCodedError(code: TraceStorageErrorCode, message: string): Error & { code: TraceStorageErrorCode } {
  const err = new Error(message) as Error & { code: TraceStorageErrorCode };
  err.code = code;
  return err;
}

function isAlreadyExistsError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  return code === 'EEXIST' || code === 'RecordingDirectoryNotEmpty';
}

function isUnsupportedLinkError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  return (
    code === 'EXDEV' ||
    code === 'ENOTSUP' ||
    code === 'EOPNOTSUPP' ||
    code === 'ENOSYS' ||
    code === 'EPERM' ||
    code === 'UNKNOWN' ||
    code === 'EINVAL'
  );
}

function normalizePlatformPath(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function resolveNearestRealPath(targetPath: string, fileSystem: TraceFileSystem): Promise<string> {
  let cur = path.resolve(targetPath);
  const trailing: string[] = [];
  while (true) {
    if (fileSystem.realpath) {
      try {
        const real = await fileSystem.realpath(cur);
        return trailing.length > 0 ? path.join(real, ...trailing.reverse()) : real;
      } catch {
        // 尚不存在，继续向上找最近存在的父目录
      }
    }
    const parent = path.dirname(cur);
    if (parent === cur) {
      return path.resolve(targetPath);
    }
    trailing.push(path.basename(cur));
    cur = parent;
  }
}

async function canonicalizeDirectoryKey(dirPath: string, fileSystem: TraceFileSystem): Promise<string> {
  const real = await resolveNearestRealPath(dirPath, fileSystem);
  return normalizePlatformPath(real);
}

async function canonicalizeFilePathKey(filePath: string, fileSystem: TraceFileSystem): Promise<string> {
  const real = await resolveNearestRealPath(filePath, fileSystem);
  return normalizePlatformPath(real);
}

async function ensureEmptyRecordingDirectory(dirPath: string, fileSystem: TraceFileSystem): Promise<void> {
  const dirExists = await fileSystem.exists(dirPath);
  if (dirExists) {
    if (fileSystem.readdir) {
      const entries = await fileSystem.readdir(dirPath);
      if (entries.length > 0) {
        throw createCodedError(
          'RecordingDirectoryNotEmpty',
          `目标录制目录非空，拒绝覆盖既有档案或文件: ${dirPath}`,
        );
      }
    } else {
      const probeFiles = [
        ORBIT_TRACE_FILES.manifest,
        ORBIT_TRACE_FILES.manifestTmp,
        ORBIT_TRACE_FILES.raw,
        ORBIT_TRACE_FILES.data,
        ORBIT_TRACE_FILES.journal,
        ORBIT_TRACE_FILES.index,
        ORBIT_TRACE_FILES.indexTmp,
        'index-spill.otidx',
      ];
      for (const name of probeFiles) {
        if (await fileSystem.exists(path.join(dirPath, name))) {
          throw createCodedError(
            'RecordingDirectoryNotEmpty',
            `目标录制目录已包含档案文件 ${name}，拒绝覆盖: ${dirPath}`,
          );
        }
      }
    }
  } else {
    await fileSystem.mkdir(dirPath, { recursive: true });
  }
}
