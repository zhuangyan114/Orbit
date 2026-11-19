import * as path from 'node:path';
import type { CmsisDapRttChannelDescriptor, CmsisDapRttEnumResult, CmsisDapRttMemoryRange } from '../ozone-backend/cmsis-dap-helper-channel';
import type { RttCapabilities } from '../ozone-backend/rtt-contract';
import type { RttConflictPolicy, RttTransportBudget } from '../rtos/rtt-coordinator';
import { SYSTEMVIEW_COMMAND_IDS, SYSTEMVIEW_EVENT_IDS } from './systemview-protocol';
import { SystemViewStreamDecoder } from './systemview-decoder';
import {
  computeRingReadPlan,
  FixtureCaptureValues,
  SystemViewGlobalsValues,
  SystemViewTargetMetadataLayout,
  validateSysViewBufferDescriptor,
} from './systemview-target-metadata';
import type {
  IngestBatchSummary,
  RecordingInspectionResult,
  SegmentIndexMetadata,
  StoredGapEntry,
  TraceLodQueryRequest,
  TraceLodQueryResult,
  TraceRangeQueryRequest,
  TraceRangeQueryResult,
  TraceRecordingManifest,
  TraceStorageStats,
  TraceWorkerStatsSnapshot,
} from './trace-worker-protocol';
import type { TraceStorageResult } from './trace-recording-store';
import { TraceWorkerClient } from './trace-worker-client';
import { log } from '../utils/logger';

export type TraceRecordingMode = 'continuous' | 'single-shot' | 'post-mortem';

export type TraceRecordingState =
  | 'idle'
  | 'preparing'
  | 'recording'
  | 'paused'
  | 'stopping'
  | 'stopped'
  | 'incomplete'
  | 'error';

export type TraceTargetState = 'recording' | 'stopped' | 'dropping' | 'unknown';
export type TraceCaptureIntegrity = 'complete' | 'target-overflow' | 'prefix-overwritten' | 'empty' | 'no-sync' | 'incomplete' | 'unknown';
export type TraceTransportAdequacy = 'adequate' | 'limited' | 'insufficient' | 'unknown';

export interface TraceSessionHandle {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  customRequest<T = any>(command: string, args?: Record<string, unknown>): PromiseLike<T>;
}

export interface TraceWorkerClientLike {
  createRecording(options: {
    recordingDir: string;
    recordId: string;
    identity: {
      sessionId: string;
      sessionGeneration: number;
      bootGeneration: number;
      recordId: string;
    };
    decoderOptions?: Record<string, unknown>;
    commitOnEachIngest?: boolean;
  }): Promise<TraceStorageResult<TraceStorageStats>>;
  ingestChunk(params: {
    recordId: string;
    sessionId: string;
    sessionGeneration: number;
    bootGeneration?: number;
    batchSequence?: number;
    chunk: Uint8Array;
    flush?: boolean;
    backpressureTimeoutMs?: number;
  }): Promise<TraceStorageResult<IngestBatchSummary> & { backpressure?: boolean }>;
  tryIngestChunk(params: {
    recordId: string;
    sessionId: string;
    sessionGeneration: number;
    bootGeneration?: number;
    batchSequence?: number;
    chunk: Uint8Array;
    flush?: boolean;
  }): Promise<TraceStorageResult<IngestBatchSummary> & { backpressure?: boolean }>;
  waitForInputDrain(timeoutMs?: number, queuedBytes?: number): Promise<boolean>;
  markGap(params: {
    recordId: string;
    sessionId: string;
    sessionGeneration: number;
    gap: {
      kind: 'target-overflow' | 'host-drop' | 'control-pause' | 'transport-gap' | 'prefix-overwritten' | 'storage-failure';
      reason?: string;
      droppedPackets?: number | 'unknown';
      droppedBytes?: number | 'unknown';
      preservesFraming?: boolean;
    };
  }): Promise<TraceStorageResult<IngestBatchSummary>>;
  notifyTargetReset(params: {
    recordId: string;
    sessionId: string;
    sessionGeneration: number;
    nextBootGeneration?: number;
    reason?: string;
  }): Promise<TraceStorageResult<IngestBatchSummary>>;
  flushRecording(recordId: string): Promise<TraceStorageResult<{ commitSeq: number; committedRawBytes: number }>>;
  finishRecording(
    recordId: string,
    reason?: string,
    options?: {
      terminalState?: 'completed' | 'interrupted' | 'failed';
      failureCode?: string;
      diagnostics?: Record<string, unknown>;
    },
  ): Promise<TraceStorageResult<TraceRecordingManifest>>;
  closeRecording(recordId: string): Promise<TraceStorageResult<{ closed: boolean; alreadyClosed: boolean }>>;
  openRecording(options: {
    recordingDir: string;
    recordId?: string;
    verifyRawSha256?: boolean;
  }): Promise<TraceStorageResult<{ recordId: string; inspection: RecordingInspectionResult; stats: TraceStorageStats }>>;
  inspectRecording(recordingDir: string, verifyRawSha256?: boolean): Promise<TraceStorageResult<RecordingInspectionResult>>;
  queryRange<T = unknown>(
    recordId: string,
    request: TraceRangeQueryRequest,
    options?: {
      signal?: AbortSignal;
      yieldEveryPages?: number;
      yieldEveryItems?: number;
      queryId?: string;
    },
  ): Promise<TraceStorageResult<TraceRangeQueryResult<T>>>;
  queryLod(
    recordId: string,
    request: TraceLodQueryRequest,
    options?: {
      signal?: AbortSignal;
      queryId?: string;
    },
  ): Promise<TraceStorageResult<TraceLodQueryResult>>;
  getSegments(recordId: string): Promise<TraceStorageResult<readonly SegmentIndexMetadata[]>>;
  getGaps(recordId: string): Promise<TraceStorageResult<readonly StoredGapEntry[]>>;
  exportRawToFile(
    recordId: string,
    outputPath: string,
    options?: { verifyChunkCrc32?: boolean },
  ): Promise<TraceStorageResult<{ exportedBytes: number; sha256: string }>>;
  getStats(recordId?: string): Promise<TraceStorageResult<TraceWorkerStatsSnapshot>>;
  shutdown(reason?: string): Promise<{ exitCode: number; forced: boolean }>;
}

export interface TraceTargetInspectResult {
  readonly ok: boolean;
  readonly errorCode?: string;
  readonly message?: string;
  readonly identity?: {
    readonly sessionId: string;
    readonly sessionGeneration: number;
    readonly bootGeneration: number;
    readonly operationGeneration: number;
    readonly elfSha256: string;
    readonly elfPath: string;
    readonly device: string;
  };
  readonly ownerKind?: string;
  readonly transportKind?: string;
  readonly targetState?: 'Running' | 'Halted' | 'Unknown';
  readonly controlInProgress?: boolean;
  readonly ramRanges?: readonly CmsisDapRttMemoryRange[];
  readonly roRanges?: readonly CmsisDapRttMemoryRange[];
  readonly ramRangesAvailable?: boolean;
  readonly rttControlBlockAddress?: number;
  readonly rttCapabilities?: RttCapabilities;
  readonly rttBudgets?: {
    readonly channel0: RttTransportBudget;
    readonly binaryChannel: RttTransportBudget;
  };
  readonly metadataLayout?: SystemViewTargetMetadataLayout;
  readonly globalsValues?: SystemViewGlobalsValues;
  readonly globalsReadError?: string;
  readonly fixtureCaptureValues?: FixtureCaptureValues;
  readonly fixtureCaptureReadError?: string;
  readonly enumerate?: CmsisDapRttEnumResult;
  readonly enumerateError?: { readonly errorCode: string; readonly message: string };
}

export interface StartTraceRecordingOptions {
  readonly mode: TraceRecordingMode;
  readonly recordId?: string;
  readonly recordingDir?: string;
  readonly pollIntervalMs?: number;
  readonly maxBatchBytes?: number;
  readonly maxQueueBytes?: number;
  readonly maxQueueBatches?: number;
  readonly conflictPolicy?: RttConflictPolicy;
  readonly startConfirmTimeoutMs?: number;
  readonly stopConfirmTimeoutMs?: number;
  readonly stopDrainTimeoutMs?: number;
  readonly freezeTimeoutMs?: number;
  readonly waitForFreeze?: boolean;
  readonly sendStartCommand?: boolean;
  readonly sendStopCommandOnCancel?: boolean;
  readonly backpressureWaitTimeoutMs?: number;
  readonly commitOnEachIngest?: boolean;
  readonly alreadyRecordingPolicy?: 'reject' | 'adopt-existing';
}

export interface TraceFreezeEvidence {
  readonly source: 'fixture-capture' | 'halted-globals';
  readonly frozen: boolean;
  readonly mode?: number;
  readonly generation?: number;
  readonly preWrOff?: number;
  readonly preRdOff?: number;
  readonly postWrOff?: number;
  readonly postRdOff?: number;
  readonly enabledBeforeStop?: number;
  readonly dropCount?: number;
  readonly retainedBytes?: number;
  readonly wrapped?: boolean;
  readonly prefixOverwritten?: boolean;
  readonly rdOffAdvancedByHost: boolean;
}

export interface TraceRecordingStatus {
  readonly recordId: string;
  readonly mode: TraceRecordingMode;
  readonly state: TraceRecordingState;
  readonly phaseDetail?: string;
  readonly stateReason: string;
  readonly targetState: TraceTargetState;
  readonly integrity: TraceCaptureIntegrity;
  readonly transportAdequacy: TraceTransportAdequacy;
  readonly transportBudget?: RttTransportBudget;
  readonly identity?: {
    readonly vscodeSessionId: string;
    readonly sessionId: string;
    readonly sessionGeneration: number;
    readonly bootGeneration: number;
    readonly elfSha256: string;
  };
  readonly recordingDir?: string;
  readonly channelInfo?: {
    readonly controlBlockAddress: number;
    readonly upChannelIndex: number;
    readonly upChannelName: string;
    readonly downChannelIndex?: number;
    readonly bufferAddress: number;
    readonly bufferSize: number;
    readonly initialRdOff: number;
    readonly initialWrOff: number;
    readonly finalRdOff?: number;
    readonly finalWrOff?: number;
  };
  readonly freezeEvidence?: TraceFreezeEvidence;
  readonly counters: {
    readonly bytesReceived: number;
    readonly committedRawBytes: number;
    readonly batchesReceived: number;
    readonly packetsDecoded: number;
    readonly sliceCount: number;
    readonly gapCount: number;
    readonly segmentCount: number;
    readonly targetOverruns: number;
    readonly targetDropCount?: number;
    readonly hostDroppedBytes: number;
    readonly transportDroppedBytes: number;
    readonly backpressurePauses: number;
    readonly preStartDrainedBytes: number;
  };
  readonly error?: {
    readonly errorCode: string;
    readonly message: string;
    readonly completion?: 'not-started' | 'partial' | 'completed' | 'unknown';
    readonly diagnostics?: Record<string, unknown>;
  };
  readonly startedAtMs?: number;
  readonly stoppedAtMs?: number;
  readonly manifest?: TraceRecordingManifest;
}

export interface TraceRecordingCoordinatorOptions {
  readonly storageRoot: string;
  readonly workerFactory?: () => TraceWorkerClientLike;
  readonly nowMs?: () => number;
  readonly sleepMs?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly onStatusChange?: (status: TraceRecordingStatus) => void;
}

interface ExtractedDapError {
  readonly errorCode: string;
  readonly message: string;
  readonly completion?: 'not-started' | 'partial' | 'completed' | 'unknown';
  readonly diagnostics?: Record<string, unknown>;
}

function extractDapError(err: unknown, fallbackCode = 'TargetRequestFailed'): ExtractedDapError {
  if (!err || typeof err !== 'object') {
    return { errorCode: fallbackCode, message: String(err) };
  }
  const anyErr = err as Record<string, any>;
  const body = anyErr.body && typeof anyErr.body === 'object' ? anyErr.body as Record<string, any> : undefined;
  const rawMessage = typeof body?.message === 'string' && body.message
    ? body.message
    : typeof anyErr.message === 'string' && anyErr.message
      ? anyErr.message
      : fallbackCode;
  let errorCode = typeof body?.errorCode === 'string' && body.errorCode
    ? body.errorCode
    : typeof anyErr.errorCode === 'string' && anyErr.errorCode
      ? anyErr.errorCode
      : '';
  if (!errorCode) {
    const m = rawMessage.match(/^([A-Z][A-Za-z0-9]+):\s*/);
    errorCode = m ? m[1] : fallbackCode;
  }
  const completion = body?.completion ?? body?.diagnostics?.rtt?.completion;
  const validCompletion = completion === 'not-started' || completion === 'partial' || completion === 'completed' || completion === 'unknown'
    ? completion
    : undefined;
  return {
    errorCode,
    message: rawMessage,
    ...(validCompletion ? { completion: validCompletion } : {}),
    ...(body?.diagnostics && typeof body.diagnostics === 'object' ? { diagnostics: body.diagnostics } : {}),
  };
}

function defaultSleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function findSysViewChannel(
  enumResult: CmsisDapRttEnumResult,
  direction: 'up' | 'down',
): { ok: true; descriptor: CmsisDapRttChannelDescriptor } | { ok: false; errorCode: string; message: string } {
  const list = direction === 'up' ? enumResult.upBuffers : enumResult.downBuffers;
  const dups = direction === 'up' ? enumResult.duplicateUpNames : enumResult.duplicateDownNames;
  if (dups.includes('SysView')) {
    return {
      ok: false,
      errorCode: 'RttDuplicateChannelName',
      message: `RTT ${direction} channel name "SysView" is duplicated`,
    };
  }
  const matches = list.filter(d => d.valid && d.nameStatus === 'ok' && d.name === 'SysView');
  if (matches.length > 1) {
    return {
      ok: false,
      errorCode: 'RttDuplicateChannelName',
      message: `RTT ${direction} channel name "SysView" matched multiple descriptors`,
    };
  }
  if (matches.length === 0) {
    const corrupt = list.filter(d => d.status === 'corrupt' && d.name === 'SysView');
    if (corrupt.length > 0) {
      return {
        ok: false,
        errorCode: corrupt[0].errorCode || 'RttInvalidBufferLayout',
        message: corrupt[0].errorMessage || `RTT ${direction} SysView channel descriptor is corrupt`,
      };
    }
    return {
      ok: false,
      errorCode: 'RttChannelUnavailable',
      message: `RTT ${direction} channel "SysView" was not found`,
    };
  }
  return { ok: true, descriptor: matches[0] };
}

function isAdequateBudget(budget: RttTransportBudget): TraceTransportAdequacy {
  if (budget.transport === 'hid' || budget.transport === 'rmlink-service' || budget.maxBatchBytes <= 512) {
    return 'limited';
  }
  return 'adequate';
}

function ringUnreadBytes(wrOff: number, rdOff: number, bufferSize: number): number {
  if (bufferSize <= 0) return 0;
  return wrOff >= rdOff ? wrOff - rdOff : bufferSize - rdOff + wrOff;
}

function finishDispositionForError(
  errorCode: string,
): { terminalState: 'interrupted' | 'failed'; failureCode: string } {
  if (
    errorCode === 'SessionTerminated'
    || errorCode === 'ConnectionLost'
    || errorCode === 'TargetReset'
    || errorCode === 'SessionChanged'
    || errorCode === 'RecordingStoppedBeforeFreeze'
    || errorCode === 'RecordingStoppedBeforeStart'
    || errorCode === 'RecordingCancelled'
    || errorCode === 'StopConfirmationTimeout'
    || errorCode === 'StopDrainTimeout'
    || errorCode === 'StopDrainPaused'
    || errorCode === 'StopDrainBackpressured'
    || errorCode === 'StopDrainHostDrop'
    || errorCode === 'StopDrainAborted'
    || errorCode === 'NoValidSyncFound'
    || errorCode === 'CoordinatorDisposed'
  ) {
    return { terminalState: 'interrupted', failureCode: errorCode };
  }
  return { terminalState: 'failed', failureCode: errorCode };
}

interface ActiveRecordingContext {
  readonly reservationId: number;
  readonly recordId: string;
  readonly mode: TraceRecordingMode;
  readonly session: TraceSessionHandle;
  identity: {
    readonly vscodeSessionId: string;
    readonly sessionId: string;
    readonly sessionGeneration: number;
    readonly bootGeneration: number;
    readonly elfSha256: string;
  };
  readonly recordingDir: string;
  readonly consumerId: string;
  readonly abortController: AbortController;
  runGeneration: number;
  readonly startedAtMs: number;
  readonly stopConfirmTimeoutMs: number;
  readonly stopDrainTimeoutMs: number;
  readonly backpressureWaitTimeoutMs: number;
  readonly sendStopCommandOnCancel: boolean;
  startPromise?: Promise<TraceRecordingStatus>;
  abortPromise?: Promise<TraceRecordingStatus>;
  startCommandDispatched: boolean;
  startCommandCommitted: boolean;
  finalized: boolean;
  ramRanges?: readonly CmsisDapRttMemoryRange[];
  roRanges?: readonly CmsisDapRttMemoryRange[];

  state: TraceRecordingState;
  phaseDetail: string;
  stateReason: string;
  targetState: TraceTargetState;
  integrity: TraceCaptureIntegrity;
  transportAdequacy: TraceTransportAdequacy;
  transportBudget?: RttTransportBudget;
  channelInfo?: TraceRecordingStatus['channelInfo'];
  freezeEvidence?: TraceFreezeEvidence;
  error?: TraceRecordingStatus['error'];
  stoppedAtMs?: number;
  manifest?: TraceRecordingManifest;

  // Continuous-specific streaming state
  subscribedUpChannel: boolean;
  discardPreStartBytes: boolean;
  preStartBacklogBytes: number;
  hostBackpressured: boolean;
  userPaused: boolean;
  lastRttBatchSeq: number | null;
  nextWorkerBatchSeq: number;
  pendingHostQueueBytes: number;
  pendingHostQueueBatches: number;
  ingestChain: Promise<void>;
  workerCreated: boolean;
  workerFinished: boolean;
  stopPromise?: Promise<TraceRecordingStatus>;
  tailDrainNotify?: () => void;
  streamObserver?: SystemViewStreamDecoder;
  sawTraceStartAndInit: boolean;
  sawAttributedPostStartSync: boolean;
  sawTraceStop: boolean;

  // Counters
  bytesReceived: number;
  committedRawBytes: number;
  batchesReceived: number;
  packetsDecoded: number;
  sliceCount: number;
  gapCount: number;
  segmentCount: number;
  targetOverruns: number;
  initialTargetDropCount?: number;
  targetDropCount?: number;
  hostDroppedBytes: number;
  transportDroppedBytes: number;
  backpressurePauses: number;
  preStartDrainedBytes: number;
}

/**
 * Extension Host 侧 SystemView Trace 录制协调器（阶段 4.4）：
 * - 严格绑定精确活动 `TraceSessionHandle` 与 `(sessionId, sessionGeneration, bootGeneration)`；
 * - 复用 3.4 `orbitRttTransport` 按名发现 SysView 通道与唯一读者/写入；
 * - 交付 4.3 `TraceWorkerClient` 进行流式解码、区间重建与盘上归档；
 * - 接入 Continuous、Single-Shot、Post-Mortem 三种模式，全程不自动 halt/reset 或盲重试未知写入。
 */
export class TraceRecordingCoordinator {
  private readonly storageRoot: string;
  private readonly workerFactory: () => TraceWorkerClientLike;
  private readonly nowMs: () => number;
  private readonly sleepMs: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly onStatusChange?: (status: TraceRecordingStatus) => void;
  private readonly statusListeners = new Set<(status: TraceRecordingStatus) => void>();
  private lastProgressEmitMs = 0;

  private worker: TraceWorkerClientLike | null = null;
  private boundSession: TraceSessionHandle | undefined;
  private readonly endedSessions = new WeakSet<TraceSessionHandle>();
  private activeRecording: ActiveRecordingContext | null = null;
  private activeReservationId = 0;
  private readonly completedRecords = new Map<string, TraceRecordingStatus>();
  private recordSeq = 0;
  private reservationSeq = 0;
  private runGenSeq = 0;
  private disposed = false;

  constructor(options: TraceRecordingCoordinatorOptions) {
    this.storageRoot = path.resolve(options.storageRoot);
    this.workerFactory = options.workerFactory ?? (() => new TraceWorkerClient());
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.sleepMs = options.sleepMs ?? defaultSleepMs;
    this.onStatusChange = options.onStatusChange;
  }

  private ensureWorker(): TraceWorkerClientLike {
    if (this.disposed) {
      throw new Error('TraceRecordingCoordinator is disposed');
    }
    if (!this.worker) {
      this.worker = this.workerFactory();
    }
    return this.worker;
  }

  public get activeSession(): TraceSessionHandle | undefined {
    return this.boundSession;
  }

  public onDidChangeStatus(listener: (status: TraceRecordingStatus) => void): { dispose(): void } {
    this.statusListeners.add(listener);
    return {
      dispose: () => {
        this.statusListeners.delete(listener);
      },
    };
  }

  public bindSession(session: TraceSessionHandle | undefined): void {
    const valid = session && !this.endedSessions.has(session) ? session : undefined;
    if (valid === this.boundSession) return;
    if (this.activeRecording && this.isRecordingInProgress(this.activeRecording.state)) {
      void this.abortActiveRecording('SessionChanged', 'Active debug session changed or unbound', false);
    }
    this.boundSession = valid;
  }

  public onSessionTerminated(session: TraceSessionHandle): void {
    this.endedSessions.add(session);
    if (this.activeRecording && this.activeRecording.session === session
      && this.isRecordingInProgress(this.activeRecording.state)) {
      void this.abortActiveRecording('SessionTerminated', 'Debug session terminated during Trace recording', false);
    }
    if (this.boundSession === session) {
      this.boundSession = undefined;
    }
  }

  public onCustomEvent(session: TraceSessionHandle, eventName: string, body: unknown): void {
    if (this.disposed || !this.boundSession || session !== this.boundSession || this.endedSessions.has(session)) {
      return;
    }
    if (!body || typeof body !== 'object') return;
    const payload = body as Record<string, any>;

    if (eventName === 'orbitAutomationLifecycle') {
      if (payload.type === 'target.connectionLost') {
        if (this.activeRecording && this.activeRecording.session === session
          && this.isRecordingInProgress(this.activeRecording.state)) {
          void this.abortActiveRecording('ConnectionLost', 'Target connection lost during Trace recording', false);
        }
      }
      return;
    }

    if (eventName === 'orbitTraceBootChanged') {
      const rec = this.activeRecording;
      if (!rec || rec.session !== session || !this.isRecordingInProgress(rec.state)) return;
      if (payload.sessionId !== rec.identity.sessionId || payload.sessionGeneration !== rec.identity.sessionGeneration) {
        return;
      }
      if (typeof payload.bootGeneration === 'number' && payload.bootGeneration !== rec.identity.bootGeneration) {
        void this.abortActiveRecording(
          'TargetReset',
          `Target bootGeneration changed (${rec.identity.bootGeneration} -> ${payload.bootGeneration}: ${String(payload.reason || 'reset')})`,
          false,
          payload.bootGeneration,
        );
      }
      return;
    }

    const rec = this.activeRecording;
    if (!rec || rec.session !== session || rec.mode !== 'continuous') return;
    if (!this.isRecordingInProgress(rec.state)) return;
    if (!rec.subscribedUpChannel || !rec.identity.sessionId) return;

    if (eventName === 'orbitRttData') {
      if (payload.consumerId !== rec.consumerId) return;
      if (rec.channelInfo && payload.bufferIndex !== rec.channelInfo.upChannelIndex) return;
      if (payload.sessionId !== rec.identity.sessionId || payload.sessionGeneration !== rec.identity.sessionGeneration) {
        return;
      }
      if (payload.bootGeneration !== rec.identity.bootGeneration) {
        void this.abortActiveRecording(
          'TargetReset',
          `RTT batch bootGeneration mismatch (${rec.identity.bootGeneration} -> ${payload.bootGeneration})`,
          true,
          typeof payload.bootGeneration === 'number' ? payload.bootGeneration : undefined,
        );
        return;
      }
      const seq = Number(payload.batchSequence);
      if (!Number.isInteger(seq) || (rec.lastRttBatchSeq !== null && seq <= rec.lastRttBatchSeq)) {
        return;
      }
      const prevSeq = rec.lastRttBatchSeq;
      rec.lastRttBatchSeq = seq;
      if (prevSeq !== null && seq > prevSeq + 1) {
        this.handleContinuousSequenceGap(rec, prevSeq + 1, seq - 1, seq - prevSeq - 1);
      }
      const bytes = typeof payload.dataBase64 === 'string' && payload.dataBase64.length > 0
        ? Uint8Array.from(Buffer.from(payload.dataBase64, 'base64'))
        : new Uint8Array(0);
      this.handleContinuousRttBatch(rec, {
        bytes,
        rdOff: typeof payload.rdOff === 'number' ? payload.rdOff : undefined,
        wrOff: typeof payload.wrOff === 'number' ? payload.wrOff : undefined,
        committedRdOff: typeof payload.committedRdOff === 'number' ? payload.committedRdOff : undefined,
        overrun: payload.overrun === true,
        congested: payload.congested === true,
      });
      rec.tailDrainNotify?.();
      return;
    }

    if (eventName === 'orbitRttDrop') {
      if (payload.consumerId !== rec.consumerId) return;
      if (rec.channelInfo && payload.bufferIndex !== rec.channelInfo.upChannelIndex) return;
      this.handleContinuousRttDrop(rec, payload);
      rec.tailDrainNotify?.();
      return;
    }

    if (eventName === 'orbitRttChannelState') {
      if (rec.channelInfo && payload.bufferIndex !== rec.channelInfo.upChannelIndex) return;
      if (payload.pausedReason === 'reset') {
        void this.abortActiveRecording('TargetReset', 'RTT channel suspended due to target reset', false);
      }
      rec.tailDrainNotify?.();
    }
  }

  public getStatus(recordId?: string): TraceRecordingStatus | null {
    if (recordId !== undefined) {
      if (this.activeRecording?.recordId === recordId) {
        return this.snapshotStatus(this.activeRecording);
      }
      return this.completedRecords.get(recordId) ?? null;
    }
    if (this.activeRecording) {
      return this.snapshotStatus(this.activeRecording);
    }
    const entries = [...this.completedRecords.values()];
    return entries.length > 0 ? entries[entries.length - 1] : null;
  }

  public listRecordings(): TraceRecordingStatus[] {
    const out = [...this.completedRecords.values()];
    if (this.activeRecording) {
      out.push(this.snapshotStatus(this.activeRecording));
    }
    return out;
  }

  public async inspectTarget(options: { includeEnumerate?: boolean; timeoutMs?: number } = {}): Promise<TraceTargetInspectResult> {
    const session = this.boundSession;
    if (!session || this.endedSessions.has(session)) {
      return { ok: false, errorCode: 'NoActiveSession', message: 'No active Orbit debug session' };
    }
    try {
      const inspectRes = await session.customRequest<TraceTargetInspectResult>('orbitTraceTarget', { action: 'inspect' });
      if (!inspectRes?.ok) {
        return {
          ok: false,
          errorCode: inspectRes?.errorCode || 'InspectFailed',
          message: inspectRes?.message || 'orbitTraceTarget inspect failed',
        };
      }
      if (options.includeEnumerate && inspectRes.rttCapabilities?.rttEnumerate.available
        && inspectRes.ramRangesAvailable && inspectRes.rttControlBlockAddress !== undefined) {
        try {
          const enumRes = await session.customRequest<{ ok: boolean; data?: CmsisDapRttEnumResult }>('orbitRttTransport', {
            action: 'enumerate',
            controlBlockAddress: inspectRes.rttControlBlockAddress,
            ramRanges: inspectRes.ramRanges,
            ...(inspectRes.roRanges ? { roRanges: inspectRes.roRanges } : {}),
            ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
          });
          if (enumRes?.ok && enumRes.data) {
            return { ...inspectRes, enumerate: enumRes.data };
          }
        } catch (enumErr) {
          const parsed = extractDapError(enumErr, 'RttEnumerateFailed');
          return {
            ...inspectRes,
            enumerateError: { errorCode: parsed.errorCode, message: parsed.message },
          };
        }
      }
      return inspectRes;
    } catch (err) {
      const parsed = extractDapError(err, 'InspectFailed');
      return { ok: false, errorCode: parsed.errorCode, message: parsed.message };
    }
  }

  public async startRecording(options: StartTraceRecordingOptions): Promise<TraceRecordingStatus> {
    if (this.disposed) {
      return this.failedImmediateStatus(options, 'CoordinatorDisposed', 'TraceRecordingCoordinator is disposed');
    }
    const mode = options.mode;
    if (mode !== 'continuous' && mode !== 'single-shot' && mode !== 'post-mortem') {
      return this.failedImmediateStatus(options, 'InvalidRequest', `Unsupported trace recording mode: ${String(mode)}`);
    }

    const recordId = options.recordId?.trim() || `trace-${mode}-${++this.recordSeq}-${this.nowMs()}`;
    if (this.activeRecording) {
      if (this.activeRecording.recordId === recordId) {
        if (this.activeRecording.startPromise && this.isRecordingInProgress(this.activeRecording.state)) {
          return this.activeRecording.startPromise;
        }
        return this.snapshotStatus(this.activeRecording);
      }
      if (this.isRecordingInProgress(this.activeRecording.state)) {
        return this.failedImmediateStatus(
          { ...options, recordId },
          'RecordingAlreadyActive',
          `Another recording (${this.activeRecording.recordId}) is already ${this.activeRecording.state}`,
        );
      }
    }

    const session = this.boundSession;
    if (!session || this.endedSessions.has(session)) {
      return this.failedImmediateStatus({ ...options, recordId }, 'NoActiveSession', 'No active Orbit debug session');
    }

    const recordingDir = options.recordingDir
      ? path.resolve(options.recordingDir)
      : path.join(this.storageRoot, `${recordId.replace(/[^A-Za-z0-9._-]/g, '_')}`);

    const reservationId = ++this.reservationSeq;
    const rec: ActiveRecordingContext = {
      reservationId,
      recordId,
      mode,
      session,
      identity: {
        vscodeSessionId: session.id,
        sessionId: '',
        sessionGeneration: 0,
        bootGeneration: 0,
        elfSha256: '',
      },
      recordingDir,
      consumerId: `trace-${recordId}`,
      abortController: new AbortController(),
      runGeneration: ++this.runGenSeq,
      startedAtMs: this.nowMs(),
      stopConfirmTimeoutMs: options.stopConfirmTimeoutMs ?? 2500,
      stopDrainTimeoutMs: options.stopDrainTimeoutMs ?? 4000,
      backpressureWaitTimeoutMs: options.backpressureWaitTimeoutMs ?? 5000,
      sendStopCommandOnCancel: options.sendStopCommandOnCancel === true,
      startCommandDispatched: false,
      startCommandCommitted: false,
      finalized: false,
      state: 'preparing',
      phaseDetail: 'inspecting',
      stateReason: `Preparing ${mode} recording`,
      targetState: 'unknown',
      integrity: 'unknown',
      transportAdequacy: 'unknown',
      subscribedUpChannel: false,
      discardPreStartBytes: false,
      preStartBacklogBytes: 0,
      hostBackpressured: false,
      userPaused: false,
      lastRttBatchSeq: null,
      nextWorkerBatchSeq: 1,
      pendingHostQueueBytes: 0,
      pendingHostQueueBatches: 0,
      ingestChain: Promise.resolve(),
      workerCreated: false,
      workerFinished: false,
      sawTraceStartAndInit: false,
      sawAttributedPostStartSync: false,
      sawTraceStop: false,
      bytesReceived: 0,
      committedRawBytes: 0,
      batchesReceived: 0,
      packetsDecoded: 0,
      sliceCount: 0,
      gapCount: 0,
      segmentCount: 0,
      targetOverruns: 0,
      hostDroppedBytes: 0,
      transportDroppedBytes: 0,
      backpressurePauses: 0,
      preStartDrainedBytes: 0,
    };

    // Synchronously reserve active slot BEFORE the first await!
    this.activeRecording = rec;
    this.activeReservationId = reservationId;
    this.emitStatus(rec);

    const runPromise = (async (): Promise<TraceRecordingStatus> => {
      let inspect: TraceTargetInspectResult;
      try {
        inspect = await rec.session.customRequest<TraceTargetInspectResult>('orbitTraceTarget', { action: 'inspect' });
      } catch (err) {
        if (!this.isReservationValid(rec)) {
          return await this.waitForSettledStatus(rec);
        }
        const parsed = extractDapError(err, 'InspectFailed');
        return this.failReservedPreStart(rec, parsed.errorCode, parsed.message, 'not-started', parsed.diagnostics);
      }

      if (!this.isReservationValid(rec)) {
        return await this.waitForSettledStatus(rec);
      }
      if (!inspect?.ok || !inspect.identity || !inspect.rttCapabilities) {
        return this.failReservedPreStart(
          rec,
          inspect?.errorCode || 'TargetUnavailable',
          inspect?.message || 'Target inspection failed',
          'not-started',
        );
      }

      rec.identity = {
        vscodeSessionId: rec.session.id,
        sessionId: inspect.identity.sessionId,
        sessionGeneration: inspect.identity.sessionGeneration,
        bootGeneration: inspect.identity.bootGeneration,
        elfSha256: inspect.identity.elfSha256,
      };
      rec.targetState = this.targetStateFromGlobals(inspect.globalsValues);
      rec.transportAdequacy = inspect.rttBudgets ? isAdequateBudget(inspect.rttBudgets.binaryChannel) : 'unknown';
      rec.transportBudget = inspect.rttBudgets?.binaryChannel;
      if (inspect.globalsValues?.dropCount !== undefined) {
        rec.initialTargetDropCount = inspect.globalsValues.dropCount;
        rec.targetDropCount = inspect.globalsValues.dropCount;
      }
      rec.phaseDetail = 'validating';
      this.emitStatus(rec);

      if (mode === 'continuous') {
        return this.startContinuous(rec, inspect, options);
      }
      return this.runBufferedMode(rec, inspect, options);
    })();

    rec.startPromise = runPromise;
    return runPromise;
  }

  public async stopRecording(recordId?: string): Promise<TraceRecordingStatus | null> {
    const rec = this.resolveTargetRecording(recordId);
    if (!rec) {
      if (recordId !== undefined && this.completedRecords.has(recordId)) {
        return this.completedRecords.get(recordId)!;
      }
      return null;
    }
    if (rec.stopPromise) {
      return rec.stopPromise;
    }
    if (!this.isRecordingInProgress(rec.state)) {
      return this.snapshotStatus(rec);
    }
    if (rec.mode === 'continuous') {
      if (rec.state === 'preparing' && !rec.startCommandDispatched) {
        rec.stopPromise = this.abortActiveRecording(
          'RecordingStoppedBeforeStart',
          'Explicit stop requested before SystemView START was dispatched',
          true,
        );
        return rec.stopPromise;
      }
      if (rec.state === 'preparing' && rec.startCommandDispatched && rec.startPromise) {
        rec.stopPromise = (async () => {
          const started = await rec.startPromise!;
          if (this.activeRecording !== rec || !this.isRecordingInProgress(rec.state)) {
            return started;
          }
          return this.stopContinuous(rec);
        })();
        return rec.stopPromise;
      }
      rec.stopPromise = this.stopContinuous(rec);
      return rec.stopPromise;
    }
    // Single-Shot / Post-Mortem: explicit stop cancels waiting/reading cleanly
    rec.stopPromise = this.stopBufferedRecording(rec);
    return rec.stopPromise;
  }

  public async cancelRecording(recordId?: string): Promise<TraceRecordingStatus | null> {
    const rec = this.resolveTargetRecording(recordId);
    if (!rec) return null;
    if (!this.isRecordingInProgress(rec.state)) {
      return this.snapshotStatus(rec);
    }
    return this.abortActiveRecording('RecordingCancelled', 'Recording cancelled by caller', rec.mode === 'continuous');
  }

  public async pauseReceiving(recordId?: string): Promise<TraceRecordingStatus | null> {
    const rec = this.resolveTargetRecording(recordId);
    if (!rec || rec.mode !== 'continuous' || rec.state !== 'recording' || !rec.channelInfo) {
      return rec ? this.snapshotStatus(rec) : null;
    }
    try {
      await rec.session.customRequest('orbitRttTransport', {
        action: 'setBackpressure',
        consumerId: rec.consumerId,
        bufferIndex: rec.channelInfo.upChannelIndex,
        paused: true,
      });
      rec.userPaused = true;
      rec.state = 'paused';
      rec.stateReason = 'Host receiving paused (target recording unaffected)';
      this.emitStatus(rec);
    } catch (err) {
      const parsed = extractDapError(err, 'PauseReceivingFailed');
      rec.error = { errorCode: parsed.errorCode, message: parsed.message };
      this.emitStatus(rec);
    }
    return this.snapshotStatus(rec);
  }

  public async resumeReceiving(recordId?: string): Promise<TraceRecordingStatus | null> {
    const rec = this.resolveTargetRecording(recordId);
    if (!rec || rec.mode !== 'continuous' || rec.state !== 'paused' || !rec.channelInfo) {
      return rec ? this.snapshotStatus(rec) : null;
    }
    try {
      rec.userPaused = false;
      if (!rec.hostBackpressured) {
        await rec.session.customRequest('orbitRttTransport', {
          action: 'setBackpressure',
          consumerId: rec.consumerId,
          bufferIndex: rec.channelInfo.upChannelIndex,
          paused: false,
        });
      }
      rec.state = 'recording';
      rec.stateReason = 'Host receiving resumed';
      this.emitStatus(rec);
    } catch (err) {
      const parsed = extractDapError(err, 'ResumeReceivingFailed');
      rec.error = { errorCode: parsed.errorCode, message: parsed.message };
      this.emitStatus(rec);
    }
    return this.snapshotStatus(rec);
  }

  // --- 4.3 Worker query / export / archive verification pass-throughs -------

  public async queryRange<T = unknown>(
    recordId: string,
    request: TraceRangeQueryRequest,
    options?: {
      signal?: AbortSignal;
      yieldEveryPages?: number;
      yieldEveryItems?: number;
      queryId?: string;
    },
  ): Promise<TraceStorageResult<TraceRangeQueryResult<T>>> {
    return this.ensureWorker().queryRange<T>(recordId, request, options);
  }

  public async queryLod(
    recordId: string,
    request: TraceLodQueryRequest,
    options?: {
      signal?: AbortSignal;
      queryId?: string;
    },
  ): Promise<TraceStorageResult<TraceLodQueryResult>> {
    return this.ensureWorker().queryLod(recordId, request, options);
  }

  public async flushRecording(
    recordId: string,
  ): Promise<TraceStorageResult<{ commitSeq: number; committedRawBytes: number }>> {
    const rec = this.activeRecording;
    if (!rec || rec.recordId !== recordId || !rec.workerCreated || rec.workerFinished || rec.finalized) {
      return { ok: false, errorCode: 'RecordingClosed', message: `Recording ${recordId} is not writable` };
    }
    const runGen = rec.runGeneration;
    let result: TraceStorageResult<{ commitSeq: number; committedRawBytes: number }> = {
      ok: false,
      errorCode: 'RecordingClosed',
      message: `Recording ${recordId} closed before flush`,
    };
    rec.ingestChain = rec.ingestChain.then(async () => {
      if (rec.runGeneration !== runGen || !rec.workerCreated || rec.workerFinished || rec.finalized) {
        return;
      }
      const worker = this.ensureWorker();
      result = await worker.flushRecording(rec.recordId);
      if (result.ok) {
        rec.committedRawBytes = result.data.committedRawBytes;
        const statsRes = await worker.getStats(rec.recordId).catch(() => undefined);
        if (statsRes?.ok) {
          const s = statsRes.data.records[rec.recordId];
          if (s) {
            rec.packetsDecoded = s.committed.packetCount;
            rec.sliceCount = s.committed.sliceCount;
            rec.gapCount = s.committed.gapCount;
            rec.segmentCount = s.committed.segmentCount;
          }
        }
        this.emitStatus(rec);
      }
    });
    await rec.ingestChain;
    return result;
  }

  public async getSegments(recordId: string): Promise<TraceStorageResult<readonly SegmentIndexMetadata[]>> {
    return this.ensureWorker().getSegments(recordId);
  }

  public async getGaps(recordId: string): Promise<TraceStorageResult<readonly StoredGapEntry[]>> {
    return this.ensureWorker().getGaps(recordId);
  }

  public async getWorkerStats(recordId?: string): Promise<TraceStorageResult<TraceWorkerStatsSnapshot>> {
    return this.ensureWorker().getStats(recordId);
  }

  public async exportRawToFile(
    recordId: string,
    outputPath: string,
    verifyChunkCrc32 = true,
  ): Promise<TraceStorageResult<{ exportedBytes: number; sha256: string }>> {
    return this.ensureWorker().exportRawToFile(recordId, outputPath, { verifyChunkCrc32 });
  }

  public async openRecording(
    recordingDir: string,
    recordId?: string,
    verifyRawSha256 = true,
  ): Promise<TraceStorageResult<{ recordId: string; inspection: RecordingInspectionResult; stats: TraceStorageStats }>> {
    return this.ensureWorker().openRecording({ recordingDir, recordId, verifyRawSha256 });
  }

  public async inspectRecordingDirectory(
    recordingDir: string,
    verifyRawSha256 = true,
  ): Promise<TraceStorageResult<RecordingInspectionResult>> {
    return this.ensureWorker().inspectRecording(recordingDir, verifyRawSha256);
  }

  public async closeRecording(recordId: string): Promise<TraceStorageResult<{ closed: boolean; alreadyClosed: boolean }>> {
    return this.ensureWorker().closeRecording(recordId);
  }

  public async dispose(): Promise<void> {
    if (this.disposed) return;
    if (this.activeRecording && this.isRecordingInProgress(this.activeRecording.state)) {
      await this.abortActiveRecording('CoordinatorDisposed', 'Extension host shutting down', false);
    }
    this.disposed = true;
    this.boundSession = undefined;
    if (this.worker) {
      await this.worker.shutdown('coordinator-disposed').catch(() => {});
      this.worker = null;
    }
  }

  // --- Continuous mode implementation --------------------------------------

  private async startContinuous(
    rec: ActiveRecordingContext,
    inspect: TraceTargetInspectResult,
    options: StartTraceRecordingOptions,
  ): Promise<TraceRecordingStatus> {
    const failPreStart = async (
      errorCode: string,
      message: string,
      completion: 'not-started' | 'partial' | 'completed' | 'unknown' = 'not-started',
      diagnostics?: Record<string, unknown>,
    ): Promise<TraceRecordingStatus> => {
      if (!this.isReservationValid(rec)) {
        return await this.waitForSettledStatus(rec);
      }
      await this.cleanupContinuousFailure(rec, errorCode, message, completion, diagnostics);
      return this.snapshotStatus(rec);
    };

    if (inspect.targetState !== 'Running') {
      return failPreStart(
        'TargetNotRunning',
        `Continuous recording requires a running target (current targetState=${inspect.targetState ?? 'Unknown'}); Orbit will not auto-run or halt`,
        'not-started',
        { targetState: inspect.targetState },
      );
    }

    const caps = inspect.rttCapabilities!;
    if (!caps.rttEnumerate.available || !caps.rttUpRead.available || !caps.rttDownWrite.available) {
      const missingReason = !caps.rttDownWrite.available
        ? (caps.rttDownWrite.reason || 'Owner does not support RTT Down-buffer writes')
        : !caps.rttEnumerate.available
          ? (caps.rttEnumerate.reason || 'Owner does not support RTT channel enumeration')
          : (caps.rttUpRead.reason || 'Owner does not support RTT Up reads');
      return failPreStart('UnsupportedCapability', missingReason, 'not-started', { rttCapabilities: caps });
    }

    if (!inspect.ramRangesAvailable || !inspect.ramRanges?.length) {
      return failPreStart('UnsupportedCapability', 'Valid target RAM ranges are unavailable for SysView RTT discovery');
    }

    if (inspect.metadataLayout?.globals?.postMortemCompiled === true || inspect.fixtureCaptureValues?.mode === 3) {
      return failPreStart(
        'TraceModeMismatch',
        'Target firmware is compiled for Post-Mortem mode; Continuous Down commands are unavailable',
      );
    }
    if (inspect.fixtureCaptureValues && inspect.fixtureCaptureValues.mode !== 0 && inspect.fixtureCaptureValues.mode !== 1) {
      return failPreStart(
        'TraceModeMismatch',
        `Target firmware fixtureCapture.mode=${inspect.fixtureCaptureValues.mode} does not match Continuous mode (expected 1)`,
      );
    }

    const initialEnableState = inspect.globalsValues?.enableState;
    const adoptingExisting = initialEnableState !== undefined && initialEnableState !== 0
      && options.alreadyRecordingPolicy === 'adopt-existing';
    if (initialEnableState !== undefined && initialEnableState !== 0 && !adoptingExisting) {
      return failPreStart(
        'TargetAlreadyRecording',
        `Target SystemView is already active (EnableState=${initialEnableState}); cannot establish a clean Start boundary without explicit STOP or adopt-existing policy`,
        'not-started',
        { enableState: initialEnableState },
      );
    }

    if (inspect.rttControlBlockAddress === undefined) {
      return failPreStart('RttControlBlockUnavailable', 'RTT control block (_SEGGER_RTT) could not be resolved');
    }

    let enumResult: CmsisDapRttEnumResult;
    try {
      const res = await rec.session.customRequest<{ ok: boolean; data?: CmsisDapRttEnumResult }>('orbitRttTransport', {
        action: 'enumerate',
        controlBlockAddress: inspect.rttControlBlockAddress,
        ramRanges: inspect.ramRanges,
        ...(inspect.roRanges ? { roRanges: inspect.roRanges } : {}),
      });
      if (!this.isReservationValid(rec)) {
        return await this.waitForSettledStatus(rec);
      }
      if (!res?.ok || !res.data) {
        return failPreStart('RttEnumerateFailed', 'RTT enumerate returned no descriptor table');
      }
      enumResult = res.data;
    } catch (err) {
      if (!this.isReservationValid(rec)) {
        return await this.waitForSettledStatus(rec);
      }
      const parsed = extractDapError(err, 'RttEnumerateFailed');
      return failPreStart(parsed.errorCode, parsed.message, 'not-started', parsed.diagnostics);
    }

    if (!this.isContextCurrent(rec)) {
      return failPreStart('SessionChanged', 'Debug session or boot generation changed during RTT enumeration');
    }

    const upLookup = findSysViewChannel(enumResult, 'up');
    if (!upLookup.ok) {
      return failPreStart(upLookup.errorCode, upLookup.message);
    }
    const downLookup = findSysViewChannel(enumResult, 'down');
    if (!downLookup.ok) {
      return failPreStart('UnsupportedCapability', `SysView Down channel unavailable for Continuous Start/Stop: ${downLookup.message}`);
    }

    const upGeo = validateSysViewBufferDescriptor(upLookup.descriptor, inspect.ramRanges);
    if (!upGeo.ok) return failPreStart(upGeo.errorCode, upGeo.message);
    const downGeo = validateSysViewBufferDescriptor(downLookup.descriptor, inspect.ramRanges);
    if (!downGeo.ok) return failPreStart(downGeo.errorCode, downGeo.message);

    rec.ramRanges = inspect.ramRanges;
    rec.roRanges = inspect.roRanges;
    rec.channelInfo = {
      controlBlockAddress: enumResult.controlBlockAddress,
      upChannelIndex: upLookup.descriptor.index,
      upChannelName: upLookup.descriptor.name,
      downChannelIndex: downLookup.descriptor.index,
      bufferAddress: upLookup.descriptor.bufferAddress,
      bufferSize: upLookup.descriptor.bufferSize,
      initialRdOff: upLookup.descriptor.rdOff,
      initialWrOff: upLookup.descriptor.wrOff,
    };

    const worker = this.ensureWorker();
    const createRes = await worker.createRecording({
      recordingDir: rec.recordingDir,
      recordId: rec.recordId,
      identity: {
        sessionId: rec.identity.sessionId,
        sessionGeneration: rec.identity.sessionGeneration,
        bootGeneration: rec.identity.bootGeneration,
        recordId: rec.recordId,
      },
      decoderOptions: { initialSyncMode: 'seeking-sync' },
      commitOnEachIngest: options.commitOnEachIngest ?? false,
    });
    if (!this.isReservationValid(rec)) {
      if (createRes.ok) {
        const disp = finishDispositionForError('RecordingStoppedBeforeStart');
        await worker.finishRecording(rec.recordId, 'aborted-during-create', disp).catch(() => {});
        await worker.closeRecording(rec.recordId).catch(() => {});
        rec.workerFinished = true;
      }
      return await this.waitForSettledStatus(rec);
    }
    if (!createRes.ok) {
      return failPreStart(createRes.errorCode, createRes.message, 'not-started', createRes.diagnostics);
    }
    rec.workerCreated = true;

    const initialUsed = upLookup.descriptor.wrOff >= upLookup.descriptor.rdOff
      ? upLookup.descriptor.wrOff - upLookup.descriptor.rdOff
      : upLookup.descriptor.bufferSize - upLookup.descriptor.rdOff + upLookup.descriptor.wrOff;

    rec.streamObserver = new SystemViewStreamDecoder({ initialSyncMode: 'seeking-sync' });
    rec.phaseDetail = 'subscribing';
    rec.discardPreStartBytes = !adoptingExisting;
    rec.preStartBacklogBytes = adoptingExisting ? 0 : initialUsed;
    this.emitStatus(rec);

    try {
      const subRes = await rec.session.customRequest<{
        ok: boolean;
        bufferIndex: number;
        budget: RttTransportBudget;
      }>('orbitRttTransport', {
        action: 'subscribe',
        consumerId: rec.consumerId,
        channelIndex: upLookup.descriptor.index,
        deliveryKind: 'binary',
        deliveryMode: 'callback',
        backpressurePolicy: 'pause-reader',
        conflictPolicy: options.conflictPolicy ?? 'reject-on-xr',
        ...(options.pollIntervalMs !== undefined ? { pollIntervalMs: options.pollIntervalMs } : {}),
        ...(options.maxBatchBytes !== undefined ? { maxBatchBytes: options.maxBatchBytes } : {}),
        ...(options.maxQueueBytes !== undefined ? { maxQueueBytes: options.maxQueueBytes } : {}),
        ...(options.maxQueueBatches !== undefined ? { maxQueueBatches: options.maxQueueBatches } : {}),
        controlBlockAddress: enumResult.controlBlockAddress,
        ramRanges: inspect.ramRanges,
        ...(inspect.roRanges ? { roRanges: inspect.roRanges } : {}),
      });
      if (!this.isReservationValid(rec)) {
        if (subRes?.ok && !this.endedSessions.has(rec.session)) {
          await Promise.resolve(rec.session.customRequest('orbitRttTransport', {
            action: 'unsubscribe',
            consumerId: rec.consumerId,
            bufferIndex: subRes.bufferIndex,
            drainLastBatch: false,
          })).catch(() => {});
        }
        return await this.waitForSettledStatus(rec);
      }
      if (!subRes?.ok) {
        return failPreStart('RttSubscribeFailed', 'Failed to subscribe SysView Up channel');
      }
      rec.subscribedUpChannel = true;
      rec.transportBudget = subRes.budget;
      rec.transportAdequacy = isAdequateBudget(subRes.budget);
    } catch (err) {
      if (!this.isReservationValid(rec)) {
        return await this.waitForSettledStatus(rec);
      }
      const parsed = extractDapError(err, 'RttSubscribeFailed');
      return failPreStart(parsed.errorCode, parsed.message, 'not-started', parsed.diagnostics);
    }

    if (!this.isContextCurrent(rec)) {
      return await this.waitForSettledStatus(rec);
    }

    if (adoptingExisting) {
      rec.state = 'recording';
      rec.phaseDetail = 'adopted-existing';
      rec.targetState = this.targetStateFromGlobals(inspect.globalsValues);
      rec.integrity = rec.targetOverruns > 0 ? 'target-overflow' : 'complete';
      rec.stateReason = 'Adopted already-running Continuous SystemView session on target';
      this.emitStatus(rec);
      return this.snapshotStatus(rec);
    }

    // If the Up ring already had nearly full backlog (e.g. from an earlier stopped capture),
    // wait briefly for the active subscription to drain enough free space without issuing STOP/halt/reset.
    const initialFree = Math.max(0, upLookup.descriptor.bufferSize - 1 - initialUsed);
    if (initialFree < 256) {
      const drainDeadline = this.nowMs() + 400;
      while (this.isContextCurrent(rec) && this.nowMs() < drainDeadline) {
        await this.sleepMs(25, rec.abortController.signal);
        if (!this.isReservationValid(rec)) {
          return await this.waitForSettledStatus(rec);
        }
        const st = await this.readTargetStateSafe(rec);
        if (!this.isReservationValid(rec)) {
          return await this.waitForSettledStatus(rec);
        }
        if (st?.enumerate) {
          const curUp = findSysViewChannel(st.enumerate, 'up');
          if (curUp.ok) {
            const used = curUp.descriptor.wrOff >= curUp.descriptor.rdOff
              ? curUp.descriptor.wrOff - curUp.descriptor.rdOff
              : curUp.descriptor.bufferSize - curUp.descriptor.rdOff + curUp.descriptor.wrOff;
            if (curUp.descriptor.bufferSize - 1 - used >= 256) break;
          }
        }
      }
    }

    if (!this.isReservationValid(rec)) {
      return await this.waitForSettledStatus(rec);
    }

    // Snapshot pre-Start Down boundaries so confirmation can verify target actually consumed THIS Start command
    const preStartDownRdOff = downLookup.descriptor.rdOff;
    const preStartDownWrOff = downLookup.descriptor.wrOff;
    const downBufSize = downLookup.descriptor.bufferSize;

    // Only accept post-Start sync packets once writeDown(START) is committed (and any preStartBacklogBytes skipped)
    rec.discardPreStartBytes = false;
    rec.phaseDetail = 'sending-start';
    rec.startCommandDispatched = true;
    this.emitStatus(rec);

    const startByteBase64 = Buffer.from([SYSTEMVIEW_COMMAND_IDS.START]).toString('base64');
    let writeStartData: { skipped?: boolean; committedBytes?: number; committedWrOff?: number; wrOff?: number; rdOff?: number } | undefined;
    try {
      const writeRes = await rec.session.customRequest<{ ok: boolean; data?: typeof writeStartData }>('orbitRttTransport', {
        action: 'writeDown',
        bufferIndex: downLookup.descriptor.index,
        dataBase64: startByteBase64,
        controlBlockAddress: enumResult.controlBlockAddress,
        ramRanges: inspect.ramRanges,
        ...(inspect.roRanges ? { roRanges: inspect.roRanges } : {}),
        timeoutMs: 2000,
      });
      if (!this.isReservationValid(rec)) {
        return await this.waitForSettledStatus(rec);
      }
      if (!writeRes?.ok || !writeRes.data) {
        return failPreStart('RttMemoryWriteFailed', 'writeDown(START) returned no result', 'unknown');
      }
      writeStartData = writeRes.data;
    } catch (err) {
      if (!this.isReservationValid(rec)) {
        return await this.waitForSettledStatus(rec);
      }
      const parsed = extractDapError(err, 'RttMemoryWriteFailed');
      // Never blindly retry a Down write when completion is unknown!
      if (parsed.completion === 'unknown') {
        const probe = await this.readTargetStateSafe(rec);
        if (probe?.globalsValues) {
          rec.targetState = this.targetStateFromGlobals(probe.globalsValues);
        }
      }
      return failPreStart(parsed.errorCode, parsed.message, parsed.completion ?? 'unknown', parsed.diagnostics);
    }

    if (writeStartData.skipped || (writeStartData.committedBytes ?? 0) < 1) {
      return failPreStart(
        'DownBufferFull',
        'Target did not consume SysView Down buffer (START command skipped/short-written)',
        'not-started',
        { writeStartData },
      );
    }

    rec.startCommandCommitted = true;
    const expectedDownWrOff = typeof writeStartData.committedWrOff === 'number'
      ? writeStartData.committedWrOff
      : typeof writeStartData.wrOff === 'number'
        ? writeStartData.wrOff
        : (preStartDownWrOff + 1) % downBufSize;

    rec.phaseDetail = 'confirming-start';
    this.emitStatus(rec);

    const confirmDeadline = this.nowMs() + (options.startConfirmTimeoutMs ?? 3000);
    let confirmed = false;
    while (this.isReservationValid(rec) && this.nowMs() < confirmDeadline) {
      const probe = await this.readTargetStateSafe(rec);
      if (!this.isReservationValid(rec)) {
        return await this.waitForSettledStatus(rec);
      }
      if (probe) {
        if (probe.targetState === 'Halted') {
          return failPreStart(
            'TargetNotRunning',
            'Target halted while waiting for SystemView Start confirmation',
            'unknown',
          );
        }
        if (probe.globalsValues) {
          rec.targetState = this.targetStateFromGlobals(probe.globalsValues);
        }
        const curDown = probe.enumerate ? findSysViewChannel(probe.enumerate, 'down') : undefined;
        const downConsumed = curDown?.ok
          ? (curDown.descriptor.rdOff === expectedDownWrOff
            || (curDown.descriptor.rdOff !== preStartDownRdOff && curDown.descriptor.rdOff === curDown.descriptor.wrOff))
          : false;
        const hasGlobals = Boolean(probe.globalsValues);
        const enableActive = hasGlobals ? probe.globalsValues!.enableState !== 0 : false;
        const enableExplicitStopped = hasGlobals && probe.globalsValues!.enableState === 0;
        const enableTransitionedToActive = initialEnableState === 0 && enableActive;

        // Negative invariant: stale Up bytes cannot confirm Start when EnableState=0 and Down RdOff did not advance.
        if (enableExplicitStopped && !downConsumed) {
          confirmed = false;
        } else if (hasGlobals) {
          if (
            enableTransitionedToActive
            || (downConsumed && enableActive)
            || (enableActive && rec.sawAttributedPostStartSync)
            || (downConsumed && rec.sawAttributedPostStartSync)
          ) {
            confirmed = true;
            break;
          }
        } else if (downConsumed || (rec.sawAttributedPostStartSync && curDown === undefined)) {
          confirmed = true;
          break;
        }
      }
      await this.sleepMs(35, rec.abortController.signal);
    }

    if (!this.isReservationValid(rec)) {
      return await this.waitForSettledStatus(rec);
    }
    if (!confirmed) {
      return failPreStart(
        'StartConfirmationTimeout',
        'Target did not confirm SystemView START command within timeout',
        'unknown',
      );
    }

    rec.state = 'recording';
    rec.phaseDetail = 'streaming';
    rec.targetState = 'recording';
    rec.integrity = rec.targetOverruns > 0 ? 'target-overflow' : 'complete';
    rec.stateReason = 'Continuous SystemView recording active';
    this.emitStatus(rec);
    log.dap(`[trace] continuous started recordId=${rec.recordId} ch=${rec.channelInfo.upChannelIndex}`);
    return this.snapshotStatus(rec);
  }

  private async stopContinuous(rec: ActiveRecordingContext): Promise<TraceRecordingStatus> {
    rec.state = 'stopping';
    rec.phaseDetail = 'sending-stop';
    rec.stateReason = 'Stopping Continuous SystemView recording';
    this.emitStatus(rec);

    let stopWriteOk = false;
    let stopWriteError: TraceRecordingStatus['error'] | undefined;
    if (rec.channelInfo?.downChannelIndex !== undefined && !rec.abortController.signal.aborted) {
      const stopByteBase64 = Buffer.from([SYSTEMVIEW_COMMAND_IDS.STOP]).toString('base64');
      try {
        const writeRes = await rec.session.customRequest<{
          ok: boolean;
          data?: { skipped?: boolean; committedBytes?: number };
        }>('orbitRttTransport', {
          action: 'writeDown',
          bufferIndex: rec.channelInfo.downChannelIndex,
          dataBase64: stopByteBase64,
          controlBlockAddress: rec.channelInfo.controlBlockAddress,
          ...(rec.ramRanges ? { ramRanges: rec.ramRanges } : {}),
          ...(rec.roRanges ? { roRanges: rec.roRanges } : {}),
          timeoutMs: 2000,
        });
        if (writeRes?.ok && writeRes.data && !writeRes.data.skipped && (writeRes.data.committedBytes ?? 0) >= 1) {
          stopWriteOk = true;
        } else {
          stopWriteError = {
            errorCode: 'DownBufferFull',
            message: 'Target Down buffer full; STOP command skipped',
            completion: 'not-started',
          };
        }
      } catch (err) {
        const parsed = extractDapError(err, 'RttMemoryWriteFailed');
        // Never blindly retry unknown write outcome!
        stopWriteError = {
          errorCode: parsed.errorCode,
          message: parsed.message,
          completion: parsed.completion ?? 'unknown',
          diagnostics: parsed.diagnostics,
        };
      }
    } else {
      stopWriteError = {
        errorCode: 'UnsupportedCapability',
        message: 'Down channel unavailable for STOP command',
        completion: 'not-started',
      };
    }

    let stopConfirmed = false;
    let lastKnownUpDesc: CmsisDapRttChannelDescriptor | undefined;
    if (stopWriteOk && this.isContextCurrent(rec)) {
      rec.phaseDetail = 'confirming-stop';
      this.emitStatus(rec);
      const deadline = this.nowMs() + rec.stopConfirmTimeoutMs;
      while (this.isContextCurrent(rec) && this.nowMs() < deadline) {
        const probe = await this.readTargetStateSafe(rec);
        if (rec.abortPromise || rec.finalized) {
          return await this.waitForSettledStatus(rec);
        }
        if (probe) {
          if (probe.globalsValues) {
            rec.targetState = this.targetStateFromGlobals(probe.globalsValues);
            if (probe.globalsValues.dropCount !== undefined) {
              rec.targetDropCount = probe.globalsValues.dropCount;
              if (rec.initialTargetDropCount !== undefined && probe.globalsValues.dropCount > rec.initialTargetDropCount) {
                rec.integrity = 'target-overflow';
                rec.transportAdequacy = 'insufficient';
              }
            }
          }
          const curDown = probe.enumerate ? findSysViewChannel(probe.enumerate, 'down') : undefined;
          const downConsumed = curDown?.ok ? curDown.descriptor.rdOff === curDown.descriptor.wrOff : false;
          const curUp = probe.enumerate ? findSysViewChannel(probe.enumerate, 'up') : undefined;
          if (curUp?.ok) {
            lastKnownUpDesc = curUp.descriptor;
            if (rec.channelInfo) {
              rec.channelInfo = {
                ...rec.channelInfo,
                finalRdOff: curUp.descriptor.rdOff,
                finalWrOff: curUp.descriptor.wrOff,
              };
            }
          }
          const globalsStopped = probe.globalsValues ? probe.globalsValues.enableState === 0 : false;
          if ((globalsStopped && (downConsumed || rec.sawTraceStop)) || (!probe.globalsValues && downConsumed && rec.sawTraceStop)) {
            stopConfirmed = true;
            break;
          }
        } else if (rec.sawTraceStop) {
          stopConfirmed = true;
          break;
        }
        await this.sleepMs(35, rec.abortController.signal);
      }
    }

    if (rec.abortPromise || rec.finalized) {
      return await this.waitForSettledStatus(rec);
    }

    rec.phaseDetail = 'draining';
    this.emitStatus(rec);

    const drainDeadline = this.nowMs() + rec.stopDrainTimeoutMs;
    let verifiedEmpty = false;
    let batchesDrained = 0;
    let bytesDrained = 0;
    let drainHitCondition: string | undefined;
    let stopDrainError: TraceRecordingStatus['error'] | undefined;
    const worker = this.ensureWorker();

    type TailSnapshot = {
      readonly rdOff?: number;
      readonly wrOff?: number;
      readonly bufferSize?: number;
      readonly remainingUnreadBytes: number | 'unknown';
      readonly remainingKnown: boolean;
      readonly snapshotSource: 'target-readState' | 'rtt-drain' | 'rtt-batch' | 'shared-consumer-uncertain' | 'unavailable';
      readonly sharedOtherConsumers: number;
    };

    const makeSnapshot = (
      source: 'target-readState' | 'rtt-drain' | 'rtt-batch',
      rdOff: number | undefined,
      wrOff: number | undefined,
      bufferSize: number | undefined,
      sharedOtherConsumers = 0,
    ): TailSnapshot => {
      if (sharedOtherConsumers > 0) {
        return {
          ...(rdOff !== undefined ? { rdOff } : {}),
          ...(wrOff !== undefined ? { wrOff } : {}),
          ...(bufferSize !== undefined ? { bufferSize } : {}),
          remainingUnreadBytes: 'unknown',
          remainingKnown: false,
          snapshotSource: 'shared-consumer-uncertain',
          sharedOtherConsumers,
        };
      }
      if (typeof rdOff === 'number' && typeof wrOff === 'number' && typeof bufferSize === 'number' && bufferSize > 0) {
        return {
          rdOff,
          wrOff,
          bufferSize,
          remainingUnreadBytes: ringUnreadBytes(wrOff, rdOff, bufferSize),
          remainingKnown: true,
          snapshotSource: source,
          sharedOtherConsumers: 0,
        };
      }
      return {
        ...(rdOff !== undefined ? { rdOff } : {}),
        ...(wrOff !== undefined ? { wrOff } : {}),
        ...(bufferSize !== undefined ? { bufferSize } : {}),
        remainingUnreadBytes: 'unknown',
        remainingKnown: false,
        snapshotSource: 'unavailable',
        sharedOtherConsumers: 0,
      };
    };

    const makeUnavailableSnapshot = (
      lastKnown: TailSnapshot | undefined,
      sharedOtherConsumers: number,
      reasonSource: 'shared-consumer-uncertain' | 'unavailable' = 'unavailable',
    ): TailSnapshot => ({
      ...(lastKnown?.rdOff !== undefined ? { rdOff: lastKnown.rdOff } : {}),
      ...(lastKnown?.wrOff !== undefined ? { wrOff: lastKnown.wrOff } : {}),
      ...(lastKnown?.bufferSize !== undefined ? { bufferSize: lastKnown.bufferSize } : rec.channelInfo?.bufferSize ? { bufferSize: rec.channelInfo.bufferSize } : {}),
      remainingUnreadBytes: 'unknown',
      remainingKnown: false,
      snapshotSource: sharedOtherConsumers > 0 ? 'shared-consumer-uncertain' : reasonSource,
      sharedOtherConsumers,
    });

    const formatSnapshotDiagnostics = (
      snap: TailSnapshot,
      extra?: Record<string, unknown>,
    ): Record<string, unknown> => ({
      ...(extra ?? {}),
      ...(snap.rdOff !== undefined ? { finalRdOff: snap.rdOff, rdOff: snap.rdOff } : {}),
      ...(snap.wrOff !== undefined ? { finalWrOff: snap.wrOff, wrOff: snap.wrOff } : {}),
      ...(snap.bufferSize !== undefined ? { bufferSize: snap.bufferSize } : {}),
      remainingUnreadBytes: snap.remainingUnreadBytes,
      remainingKnown: snap.remainingKnown,
      snapshotSource: snap.snapshotSource,
      sharedOtherConsumers: snap.sharedOtherConsumers,
      batchesDrained,
      bytesDrained,
      ...(drainHitCondition ? { drainReason: drainHitCondition } : {}),
    });

    let latestSnapshot: TailSnapshot = lastKnownUpDesc
      ? makeSnapshot('target-readState', lastKnownUpDesc.rdOff, lastKnownUpDesc.wrOff, lastKnownUpDesc.bufferSize, 0)
      : makeUnavailableSnapshot(undefined, 0);

    if (stopWriteOk && stopConfirmed && rec.subscribedUpChannel && rec.channelInfo && this.isContextCurrent(rec)) {
      // Handle paused / backpressured states cleanly before or during multi-batch tail drain
      if (rec.userPaused) {
        if (!rec.hostBackpressured) {
          try {
            await rec.session.customRequest('orbitRttTransport', {
              action: 'setBackpressure',
              consumerId: rec.consumerId,
              bufferIndex: rec.channelInfo.upChannelIndex,
              paused: false,
            });
            rec.userPaused = false;
          } catch (err) {
            const parsed = extractDapError(err, 'StopDrainPaused');
            drainHitCondition = 'paused';
            stopDrainError = {
              errorCode: 'StopDrainPaused',
              message: `Failed to resume paused RTT receiver during STOP drain: ${parsed.message}`,
              completion: 'partial',
              diagnostics: formatSnapshotDiagnostics(latestSnapshot, { pausedByUser: true, underlyingError: parsed.errorCode }),
            };
          }
        }
      }

      if (!stopDrainError && rec.hostBackpressured) {
        const waitMs = Math.max(1, drainDeadline - this.nowMs());
        const drainedWorker = await worker.waitForInputDrain(waitMs, 1).catch(() => false);
        if (drainedWorker) {
          rec.hostBackpressured = false;
          rec.userPaused = false;
          try {
            await rec.session.customRequest('orbitRttTransport', {
              action: 'setBackpressure',
              consumerId: rec.consumerId,
              bufferIndex: rec.channelInfo.upChannelIndex,
              paused: false,
            });
          } catch (err) {
            const parsed = extractDapError(err, 'StopDrainBackpressured');
            drainHitCondition = 'backpressured';
            stopDrainError = {
              errorCode: 'StopDrainBackpressured',
              message: `Failed to clear host backpressure during STOP drain: ${parsed.message}`,
              completion: 'partial',
              diagnostics: formatSnapshotDiagnostics(latestSnapshot, { hostBackpressured: true, underlyingError: parsed.errorCode }),
            };
          }
        } else {
          drainHitCondition = 'backpressured';
          stopDrainError = {
            errorCode: 'StopDrainBackpressured',
            message: 'Host trace worker backpressure did not clear before stopDrainTimeoutMs',
            completion: 'partial',
            diagnostics: formatSnapshotDiagnostics(latestSnapshot, { hostBackpressured: true }),
          };
        }
      }

      // Multi-batch STOP tail drain bounded by stopDrainTimeoutMs until target ring is confirmed empty
      while (!stopDrainError && this.isContextCurrent(rec)) {
        const remainingMs = drainDeadline - this.nowMs();
        if (remainingMs <= 0) {
          drainHitCondition = 'timeout';
          stopDrainError = {
            errorCode: 'StopDrainTimeout',
            message: `STOP tail drain exceeded stopDrainTimeoutMs (${rec.stopDrainTimeoutMs} ms)`,
            completion: 'partial',
            diagnostics: formatSnapshotDiagnostics(latestSnapshot),
          };
          break;
        }

        let drainSupported = true;
        try {
          type DrainTransportResponse = {
            ok?: boolean;
            drained?: boolean;
            reason?: string;
            batchesDrained?: number;
            bytesDrained?: number;
            lastBatchSequence?: number;
            lastRdOff?: number;
            lastWrOff?: number;
            bufferSize?: number;
            errorCode?: string;
            message?: string;
          };
          const drainRes: DrainTransportResponse = await rec.session.customRequest<DrainTransportResponse>('orbitRttTransport', {
            action: 'drain',
            consumerId: rec.consumerId,
            bufferIndex: rec.channelInfo.upChannelIndex,
            timeoutMs: remainingMs,
          });

          if (!this.isContextCurrent(rec) || rec.abortPromise || rec.finalized) {
            return await this.waitForSettledStatus(rec);
          }

          if (drainRes && typeof drainRes.drained === 'boolean') {
            batchesDrained += drainRes.batchesDrained ?? 0;
            bytesDrained += drainRes.bytesDrained ?? 0;
            if (typeof drainRes.lastRdOff === 'number' && typeof drainRes.lastWrOff === 'number') {
              latestSnapshot = makeSnapshot(
                'rtt-drain',
                drainRes.lastRdOff,
                drainRes.lastWrOff,
                drainRes.bufferSize ?? rec.channelInfo.bufferSize,
                0,
              );
            }
            // Wait bounded (up to remaining deadline + short 150ms settle) for already-dispatched atomic batch events
            if (typeof drainRes.lastBatchSequence === 'number' && (rec.lastRttBatchSeq ?? 0) < drainRes.lastBatchSequence) {
              const eventSettleDeadline = Math.max(drainDeadline, this.nowMs() + 150);
              await this.waitForRttSeq(rec, drainRes.lastBatchSequence, eventSettleDeadline);
              if (!this.isContextCurrent(rec) || rec.abortPromise || rec.finalized) {
                return await this.waitForSettledStatus(rec);
              }
            }

            if (drainRes.ok === false) {
              drainHitCondition = drainRes.reason || 'error';
              stopDrainError = {
                errorCode: drainRes.errorCode || 'RttDrainFailed',
                message: drainRes.message || `RTT tail drain failed (${drainRes.reason ?? 'error'})`,
                completion: 'partial',
                diagnostics: formatSnapshotDiagnostics(latestSnapshot),
              };
              break;
            }
            if (!drainRes.drained) {
              drainHitCondition = drainRes.reason;
              if (drainRes.reason === 'paused' || drainRes.reason === 'xr-paused' || drainRes.reason === 'control') {
                stopDrainError = {
                  errorCode: 'StopDrainPaused',
                  message: `STOP tail drain halted because RTT channel is paused (${drainRes.reason})`,
                  completion: 'partial',
                  diagnostics: formatSnapshotDiagnostics(latestSnapshot),
                };
                break;
              } else if (drainRes.reason === 'backpressured') {
                const bpMs = drainDeadline - this.nowMs();
                const cleared = bpMs > 0 && await worker.waitForInputDrain(bpMs, 1).catch(() => false);
                if (cleared && this.isContextCurrent(rec)) {
                  rec.hostBackpressured = false;
                  await this.applyHostBackpressure(rec, false);
                  continue;
                }
                stopDrainError = {
                  errorCode: 'StopDrainBackpressured',
                  message: 'STOP tail drain stopped due to sustained host backpressure',
                  completion: 'partial',
                  diagnostics: formatSnapshotDiagnostics(latestSnapshot, { hostBackpressured: true }),
                };
                break;
              } else if (drainRes.reason === 'timeout') {
                stopDrainError = {
                  errorCode: 'StopDrainTimeout',
                  message: `STOP tail drain timed out after ${rec.stopDrainTimeoutMs} ms`,
                  completion: 'partial',
                  diagnostics: formatSnapshotDiagnostics(latestSnapshot),
                };
                break;
              } else if (drainRes.reason === 'reset' || drainRes.reason === 'aborted') {
                break;
              }
            }
          } else {
            drainSupported = false;
          }
        } catch (err) {
          if (!this.isContextCurrent(rec) || rec.abortPromise || rec.finalized) {
            return await this.waitForSettledStatus(rec);
          }
          const parsed = extractDapError(err, 'RttDrainFailed');
          if (parsed.errorCode === 'UnsupportedAction' || parsed.errorCode === 'InvalidRequest' || parsed.errorCode === 'DapInvalidRequest') {
            drainSupported = false;
          } else {
            drainHitCondition = 'dap-error';
            stopDrainError = {
              errorCode: parsed.errorCode,
              message: `STOP tail drain DAP error: ${parsed.message}`,
              completion: 'partial',
              diagnostics: formatSnapshotDiagnostics(latestSnapshot),
            };
            break;
          }
        }

        // Probe target within loop when drain says empty or drain is unsupported on mock
        const loopProbe = await this.readTargetStateSafe(rec);
        if (rec.abortPromise || rec.finalized) {
          return await this.waitForSettledStatus(rec);
        }
        if (!loopProbe) {
          stopDrainError = {
            errorCode: 'TargetStateReadFailed',
            message: 'Failed to read target SysView state to verify empty Up ring after STOP',
            completion: 'partial',
            diagnostics: formatSnapshotDiagnostics(makeUnavailableSnapshot(latestSnapshot, 0)),
          };
          break;
        }
        if (loopProbe.globalsValues) {
          rec.targetState = this.targetStateFromGlobals(loopProbe.globalsValues);
          if (loopProbe.globalsValues.dropCount !== undefined) {
            rec.targetDropCount = loopProbe.globalsValues.dropCount;
            if (rec.initialTargetDropCount !== undefined && loopProbe.globalsValues.dropCount > rec.initialTargetDropCount) {
              rec.integrity = 'target-overflow';
              rec.transportAdequacy = 'insufficient';
            }
          }
        }
        const loopUp = loopProbe.enumerate ? findSysViewChannel(loopProbe.enumerate, 'up') : undefined;
        if (!loopUp || !loopUp.ok) {
          stopDrainError = {
            errorCode: loopUp?.errorCode || 'RttEnumerateFailed',
            message: loopUp?.message || 'SysView Up descriptor missing during STOP drain verification',
            completion: 'partial',
            diagnostics: formatSnapshotDiagnostics(makeUnavailableSnapshot(latestSnapshot, 0)),
          };
          break;
        }
        latestSnapshot = makeSnapshot('target-readState', loopUp.descriptor.rdOff, loopUp.descriptor.wrOff, loopUp.descriptor.bufferSize, 0);
        if (latestSnapshot.remainingKnown && latestSnapshot.remainingUnreadBytes === 0) {
          verifiedEmpty = true;
          break;
        }
        if (this.nowMs() >= drainDeadline) {
          drainHitCondition = drainHitCondition || 'timeout';
          stopDrainError = {
            errorCode: 'StopDrainTimeout',
            message: `Target Up ring still has ${latestSnapshot.remainingUnreadBytes} unread bytes when stopDrainTimeoutMs (${rec.stopDrainTimeoutMs} ms) expired`,
            completion: 'partial',
            diagnostics: formatSnapshotDiagnostics(latestSnapshot),
          };
          break;
        }
        if (!drainSupported) {
          await this.waitForTailDrainActivity(rec, Math.min(40, Math.max(1, drainDeadline - this.nowMs())));
        }
      }
    }

    if (rec.abortPromise || rec.finalized) {
      return await this.waitForSettledStatus(rec);
    }

    let sharedOtherConsumers = 0;
    const hostDropsBeforeUnsub = rec.hostDroppedBytes;
    if (rec.subscribedUpChannel && rec.channelInfo) {
      try {
        const unsub = await rec.session.customRequest<{
          ok: boolean;
          remainingRefCount?: number;
          drainedBatch?: {
            sessionId: string;
            sessionGeneration: number;
            bootGeneration: number;
            bufferIndex: number;
            batchSequence: number;
            dataBase64: string;
            rdOff?: number;
            wrOff?: number;
            committedRdOff?: number;
            bufferSize?: number;
            overrun?: boolean;
            congested: boolean;
          };
        }>('orbitRttTransport', {
          action: 'unsubscribe',
          consumerId: rec.consumerId,
          bufferIndex: rec.channelInfo.upChannelIndex,
          drainLastBatch: false,
        });
        rec.subscribedUpChannel = false;
        if (typeof unsub?.remainingRefCount === 'number' && unsub.remainingRefCount > 0) {
          sharedOtherConsumers = unsub.remainingRefCount;
        }
        if (unsub?.drainedBatch
          && unsub.drainedBatch.sessionId === rec.identity.sessionId
          && unsub.drainedBatch.sessionGeneration === rec.identity.sessionGeneration
          && unsub.drainedBatch.bootGeneration === rec.identity.bootGeneration
          && (rec.lastRttBatchSeq === null || unsub.drainedBatch.batchSequence > rec.lastRttBatchSeq)) {
          const prevSeq = rec.lastRttBatchSeq;
          const drainSeq = unsub.drainedBatch.batchSequence;
          rec.lastRttBatchSeq = drainSeq;
          if (prevSeq !== null && drainSeq > prevSeq + 1) {
            this.handleContinuousSequenceGap(rec, prevSeq + 1, drainSeq - 1, drainSeq - prevSeq - 1);
          }
          const bytes = unsub.drainedBatch.dataBase64.length > 0
            ? Uint8Array.from(Buffer.from(unsub.drainedBatch.dataBase64, 'base64'))
            : new Uint8Array(0);
          this.handleContinuousRttBatch(rec, {
            bytes,
            rdOff: unsub.drainedBatch.rdOff,
            wrOff: unsub.drainedBatch.wrOff,
            committedRdOff: unsub.drainedBatch.committedRdOff,
            overrun: unsub.drainedBatch.overrun === true,
            congested: unsub.drainedBatch.congested === true,
          });
          const batchRd = unsub.drainedBatch.committedRdOff ?? unsub.drainedBatch.rdOff;
          if (typeof batchRd === 'number' && typeof unsub.drainedBatch.wrOff === 'number') {
            latestSnapshot = makeSnapshot(
              'rtt-batch',
              batchRd,
              unsub.drainedBatch.wrOff,
              unsub.drainedBatch.bufferSize ?? rec.channelInfo.bufferSize,
              sharedOtherConsumers,
            );
          }
        }
      } catch {
        rec.subscribedUpChannel = false;
        // Session/channel may already have terminated; preserve committed prefix & reflect uncertain snapshot if read fails.
      }
      if (rec.hostDroppedBytes > hostDropsBeforeUnsub && !stopDrainError) {
        drainHitCondition = 'host-drop';
        stopDrainError = {
          errorCode: 'StopDrainHostDrop',
          message: `Callback consumer dropped ${rec.hostDroppedBytes - hostDropsBeforeUnsub} queued byte(s) during STOP/unsubscribe`,
          completion: 'partial',
          diagnostics: formatSnapshotDiagnostics(latestSnapshot, { droppedBytesOnUnsub: rec.hostDroppedBytes - hostDropsBeforeUnsub }),
        };
      }
    }

    if (rec.abortPromise || rec.finalized) {
      return await this.waitForSettledStatus(rec);
    }

    rec.phaseDetail = 'persisting';
    this.emitStatus(rec);

    // Let any already-received atomic batches finish Worker ingestion within a finite bounded settle window
    const persistBudgetMs = stopDrainError?.errorCode === 'StopDrainBackpressured'
      ? Math.max(10, Math.min(50, drainDeadline - this.nowMs()))
      : Math.max(250, drainDeadline - this.nowMs());
    let ingestSettled = false;
    await Promise.race([
      rec.ingestChain.then(() => { ingestSettled = true; }),
      this.sleepMs(persistBudgetMs),
    ]);
    if (!ingestSettled && !stopDrainError && !stopWriteError && stopConfirmed) {
      drainHitCondition = 'ingest-timeout';
      stopDrainError = {
        errorCode: 'StopDrainTimeout',
        message: 'Trace worker ingest queue did not drain within stopDrainTimeoutMs',
        completion: 'partial',
        diagnostics: formatSnapshotDiagnostics(latestSnapshot, { ingestTimedOut: true }),
      };
    }

    if (rec.abortPromise || rec.finalized) {
      return await this.waitForSettledStatus(rec);
    }

    // Take ONE single authoritative target snapshot AFTER unsubscribe + in-flight batch settlement!
    // No reader is running on a single-consumer channel anymore, so finalRdOff/finalWrOff/remainingUnreadBytes
    // are guaranteed coherent across channelInfo, error.diagnostics, manifest.failureDiagnostics, and any later DAP read.
    let finalSnapshot: TailSnapshot;
    if (this.isContextCurrent(rec) && !this.endedSessions.has(rec.session)) {
      const finalProbe = await this.readTargetStateSafe(rec);
      if (rec.abortPromise || rec.finalized) {
        return await this.waitForSettledStatus(rec);
      }
      if (finalProbe) {
        if (finalProbe.globalsValues) {
          rec.targetState = this.targetStateFromGlobals(finalProbe.globalsValues);
          if (finalProbe.globalsValues.dropCount !== undefined) {
            rec.targetDropCount = finalProbe.globalsValues.dropCount;
            if (rec.initialTargetDropCount !== undefined && finalProbe.globalsValues.dropCount > rec.initialTargetDropCount) {
              rec.integrity = 'target-overflow';
              rec.transportAdequacy = 'insufficient';
            }
          }
        }
        const finalUp = finalProbe.enumerate ? findSysViewChannel(finalProbe.enumerate, 'up') : undefined;
        if (finalUp?.ok) {
          finalSnapshot = makeSnapshot(
            'target-readState',
            finalUp.descriptor.rdOff,
            finalUp.descriptor.wrOff,
            finalUp.descriptor.bufferSize,
            sharedOtherConsumers,
          );
          if (finalSnapshot.remainingKnown && finalSnapshot.remainingUnreadBytes === 0 && stopConfirmed && !stopWriteError
            && (!stopDrainError || (stopDrainError.errorCode === 'StopDrainTimeout' && ingestSettled))) {
            verifiedEmpty = true;
            stopDrainError = undefined;
          } else if (finalSnapshot.remainingKnown && finalSnapshot.remainingUnreadBytes === 0) {
            verifiedEmpty = true;
          } else if (finalSnapshot.remainingKnown && finalSnapshot.remainingUnreadBytes !== 0) {
            verifiedEmpty = false;
          }
        } else {
          verifiedEmpty = false;
          finalSnapshot = makeUnavailableSnapshot(latestSnapshot, sharedOtherConsumers);
        }
      } else {
        verifiedEmpty = false;
        finalSnapshot = makeUnavailableSnapshot(latestSnapshot, sharedOtherConsumers);
      }
    } else {
      verifiedEmpty = false;
      finalSnapshot = makeUnavailableSnapshot(latestSnapshot, sharedOtherConsumers);
    }

    if (rec.channelInfo) {
      rec.channelInfo = {
        ...rec.channelInfo,
        ...(finalSnapshot.rdOff !== undefined ? { finalRdOff: finalSnapshot.rdOff } : {}),
        ...(finalSnapshot.wrOff !== undefined ? { finalWrOff: finalSnapshot.wrOff } : {}),
      };
    }

    const baseEffectiveError = stopWriteError
      ?? (!stopConfirmed ? {
        errorCode: 'StopConfirmationTimeout',
        message: 'Target did not confirm SystemView STOP within timeout',
        completion: 'unknown' as const,
      } : undefined)
      ?? stopDrainError
      ?? rec.error
      ?? (!verifiedEmpty ? {
        errorCode: 'StopDrainTimeout',
        message: finalSnapshot.remainingKnown
          ? `Target Up ring still has ${finalSnapshot.remainingUnreadBytes} unread bytes after STOP drain`
          : 'SysView Up buffer emptiness could not be proven after STOP',
        completion: 'partial' as const,
      } : undefined);

    const unifiedError: TraceRecordingStatus['error'] | undefined = baseEffectiveError
      ? {
          ...baseEffectiveError,
          ...(baseEffectiveError.errorCode === 'StopDrainTimeout' && finalSnapshot.remainingKnown
            ? {
                message: `STOP tail drain timed out after ${rec.stopDrainTimeoutMs} ms (${finalSnapshot.remainingUnreadBytes} unread bytes remaining)`,
              }
            : {}),
          diagnostics: formatSnapshotDiagnostics(
            finalSnapshot,
            baseEffectiveError.diagnostics as Record<string, unknown> | undefined,
          ),
        }
      : undefined;

    if (rec.workerCreated && !rec.workerFinished) {
      const flushRes = await worker.flushRecording(rec.recordId);
      const finishReason = unifiedError
        ? `${unifiedError.errorCode}: ${unifiedError.message}`
        : 'continuous-stopped';
      const finishOpts = unifiedError
        ? {
            ...finishDispositionForError(unifiedError.errorCode),
            ...(unifiedError.diagnostics ? { diagnostics: unifiedError.diagnostics } : {}),
          }
        : { terminalState: 'completed' as const };
      const finishRes = await worker.finishRecording(rec.recordId, finishReason, finishOpts);
      rec.workerFinished = true;
      if (finishRes.ok) {
        rec.manifest = finishRes.data;
        this.syncCountsFromManifest(rec, finishRes.data);
        if (finishRes.data.committed.gapCount > 0) {
          const gapsRes = await worker.getGaps(rec.recordId);
          if (gapsRes.ok) {
            if (gapsRes.data.some(g => g.kind === 'target-overflow')) {
              rec.integrity = 'target-overflow';
              rec.transportAdequacy = 'insufficient';
            } else if (gapsRes.data.some(g => g.kind === 'host-drop' || g.kind === 'transport-gap')) {
              rec.transportAdequacy = 'insufficient';
            }
          }
        }
      } else if (!stopWriteError && !stopDrainError) {
        stopWriteError = {
          errorCode: finishRes.errorCode,
          message: finishRes.message,
          completion: 'partial',
          diagnostics: formatSnapshotDiagnostics(finalSnapshot),
        };
      }
      if (!flushRes.ok && !stopWriteError && !stopDrainError) {
        stopWriteError = {
          errorCode: flushRes.errorCode,
          message: flushRes.message,
          completion: 'partial',
          diagnostics: formatSnapshotDiagnostics(finalSnapshot),
        };
      }
    }

    rec.stoppedAtMs = this.nowMs();
    if (stopWriteError) {
      rec.targetState = stopWriteError.completion === 'unknown' ? 'unknown' : rec.targetState;
      rec.error = unifiedError && unifiedError.errorCode === stopWriteError.errorCode ? unifiedError : stopWriteError;
      rec.state = stopWriteError.completion === 'unknown' ? 'error' : 'incomplete';
      rec.integrity = rec.integrity === 'target-overflow' ? 'target-overflow' : 'incomplete';
      rec.stateReason = `Stop failed (${stopWriteError.errorCode}): ${stopWriteError.message}`;
    } else if (!stopConfirmed) {
      rec.targetState = 'unknown';
      rec.error = unifiedError;
      rec.state = 'incomplete';
      rec.integrity = rec.integrity === 'target-overflow' ? 'target-overflow' : 'incomplete';
      rec.stateReason = 'Stop confirmation timed out; target recording state unknown';
    } else if (unifiedError) {
      const disp = finishDispositionForError(unifiedError.errorCode);
      rec.error = unifiedError;
      rec.state = disp.terminalState === 'interrupted' ? 'incomplete' : 'error';
      rec.integrity = rec.integrity === 'target-overflow' ? 'target-overflow' : 'incomplete';
      rec.stateReason = `Stop drain incomplete (${unifiedError.errorCode}): ${unifiedError.message}`;
    } else {
      rec.targetState = 'stopped';
      rec.state = 'stopped';
      rec.stateReason = 'Continuous SystemView recording stopped and persisted';
    }
    this.finalizeRecord(rec);
    return this.snapshotStatus(rec);
  }

  private async waitForRttSeq(
    rec: ActiveRecordingContext,
    targetSeq: number,
    deadlineMs: number,
  ): Promise<void> {
    while ((rec.lastRttBatchSeq ?? 0) < targetSeq && this.isContextCurrent(rec) && this.nowMs() < deadlineMs) {
      const remaining = Math.max(1, Math.min(25, deadlineMs - this.nowMs()));
      await this.waitForTailDrainActivity(rec, remaining);
    }
  }

  private waitForTailDrainActivity(rec: ActiveRecordingContext, maxMs: number): Promise<void> {
    if (maxMs <= 0) return Promise.resolve();
    return new Promise<void>(resolve => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (rec.tailDrainNotify === done) {
          rec.tailDrainNotify = undefined;
        }
        resolve();
      };
      rec.tailDrainNotify = done;
      const timer = setTimeout(done, maxMs);
    });
  }

  private handleContinuousRttBatch(
    rec: ActiveRecordingContext,
    batch: {
      bytes: Uint8Array;
      rdOff?: number;
      wrOff?: number;
      committedRdOff?: number;
      overrun: boolean;
      congested: boolean;
    },
  ): void {
    let payloadBytes = batch.bytes;
    if (rec.discardPreStartBytes) {
      rec.preStartDrainedBytes += payloadBytes.length;
      rec.preStartBacklogBytes = Math.max(0, rec.preStartBacklogBytes - payloadBytes.length);
      return;
    }
    if (rec.preStartBacklogBytes > 0 && payloadBytes.length > 0) {
      const skipCount = Math.min(rec.preStartBacklogBytes, payloadBytes.length);
      rec.preStartDrainedBytes += skipCount;
      rec.preStartBacklogBytes -= skipCount;
      payloadBytes = payloadBytes.subarray(skipCount);
    }
    if (rec.channelInfo) {
      rec.channelInfo = {
        ...rec.channelInfo,
        ...(batch.committedRdOff !== undefined ? { finalRdOff: batch.committedRdOff } : batch.rdOff !== undefined ? { finalRdOff: batch.rdOff } : {}),
        ...(batch.wrOff !== undefined ? { finalWrOff: batch.wrOff } : {}),
      };
    }

    if (payloadBytes.length > 0 && rec.streamObserver) {
      const observed = rec.streamObserver.push(payloadBytes);
      for (const pkt of observed.packets) {
        if (pkt.eventId === SYSTEMVIEW_EVENT_IDS.TRACE_START || pkt.eventId === SYSTEMVIEW_EVENT_IDS.INIT) {
          if (pkt.eventId === SYSTEMVIEW_EVENT_IDS.INIT) {
            rec.sawTraceStartAndInit = true;
            if (rec.startCommandCommitted) {
              rec.sawAttributedPostStartSync = true;
            }
          }
        } else if (pkt.eventId === SYSTEMVIEW_EVENT_IDS.TRACE_STOP) {
          rec.sawTraceStop = true;
        } else if (pkt.eventId === SYSTEMVIEW_EVENT_IDS.OVERFLOW) {
          rec.integrity = 'target-overflow';
          if (rec.transportAdequacy !== 'insufficient') {
            rec.transportAdequacy = 'insufficient';
          }
        }
      }
      if (observed.gaps.some(g => g.kind === 'target-overflow')) {
        rec.integrity = 'target-overflow';
        rec.transportAdequacy = 'insufficient';
      }
    }

    if (batch.overrun) {
      rec.targetOverruns++;
      rec.integrity = 'target-overflow';
      rec.transportAdequacy = 'insufficient';
    } else if (batch.congested && rec.transportAdequacy === 'adequate') {
      rec.transportAdequacy = 'limited';
    }

    if (payloadBytes.length === 0 && !batch.overrun) {
      return;
    }

    rec.batchesReceived++;
    rec.bytesReceived += payloadBytes.length;
    const batchBytes = payloadBytes.length;
    rec.pendingHostQueueBytes += batchBytes;
    rec.pendingHostQueueBatches += 1;
    const runGen = rec.runGeneration;

    rec.ingestChain = rec.ingestChain.then(async () => {
      try {
        if (rec.runGeneration !== runGen || !rec.workerCreated || rec.workerFinished) {
          return;
        }
        const worker = this.ensureWorker();
        if (batch.overrun) {
          await worker.markGap({
            recordId: rec.recordId,
            sessionId: rec.identity.sessionId,
            sessionGeneration: rec.identity.sessionGeneration,
            gap: {
              kind: 'target-overflow',
              droppedPackets: 'unknown',
              droppedBytes: 'unknown',
              preservesFraming: false,
              reason: 'RTT Up buffer overrun reported by target owner',
            },
          });
        }
        if (batchBytes === 0) {
          return;
        }
        const seq = rec.nextWorkerBatchSeq++;
        let ingestRes = await worker.tryIngestChunk({
          recordId: rec.recordId,
          sessionId: rec.identity.sessionId,
          sessionGeneration: rec.identity.sessionGeneration,
          bootGeneration: rec.identity.bootGeneration,
          batchSequence: seq,
          chunk: payloadBytes,
        });
        if (!ingestRes.ok && ingestRes.backpressure) {
          await this.applyHostBackpressure(rec, true);
          const drained = await worker.waitForInputDrain(rec.backpressureWaitTimeoutMs, batchBytes);
          if (rec.runGeneration !== runGen || !rec.workerCreated || rec.workerFinished || rec.finalized || rec.abortController.signal.aborted) {
            return;
          }
          if (!drained) {
            throw Object.assign(new Error('Trace worker input drain timed out under backpressure'), {
              errorCode: 'WriteQueueFull',
            });
          }
          ingestRes = await worker.ingestChunk({
            recordId: rec.recordId,
            sessionId: rec.identity.sessionId,
            sessionGeneration: rec.identity.sessionGeneration,
            bootGeneration: rec.identity.bootGeneration,
            batchSequence: seq,
            chunk: payloadBytes,
            backpressureTimeoutMs: rec.backpressureWaitTimeoutMs,
          });
        }
        if (!ingestRes.ok) {
          rec.error = {
            errorCode: ingestRes.errorCode,
            message: ingestRes.message,
            diagnostics: ingestRes.diagnostics,
          };
          void this.abortActiveRecording(ingestRes.errorCode, ingestRes.message, true);
          return;
        }
        rec.committedRawBytes = ingestRes.data.committedRawBytes;
        rec.packetsDecoded += ingestRes.data.packetsDecoded;
        rec.sliceCount += ingestRes.data.slicesEmitted;
        rec.gapCount += ingestRes.data.gapsRecorded;
        this.emitStatusThrottled(rec);
        if (rec.hostBackpressured && rec.pendingHostQueueBytes <= 128 * 1024) {
          await this.applyHostBackpressure(rec, false);
        }
      } catch (err) {
        const parsed = extractDapError(err, 'WorkerIngestFailed');
        rec.error = { errorCode: parsed.errorCode, message: parsed.message };
        void this.abortActiveRecording(parsed.errorCode, parsed.message, true);
      } finally {
        rec.pendingHostQueueBytes = Math.max(0, rec.pendingHostQueueBytes - batchBytes);
        rec.pendingHostQueueBatches = Math.max(0, rec.pendingHostQueueBatches - 1);
      }
    });
  }

  private handleContinuousRttDrop(rec: ActiveRecordingContext, event: Record<string, any>): void {
    const reason = event.reason as string;
    const droppedBytes = typeof event.droppedBytes === 'number' ? event.droppedBytes : 'unknown';
    if (reason === 'host-drop' && typeof event.droppedBytes === 'number') {
      rec.hostDroppedBytes += event.droppedBytes;
    } else if (reason === 'transport-drop' && typeof event.droppedBytes === 'number') {
      rec.transportDroppedBytes += event.droppedBytes;
    } else if (reason === 'target-overflow') {
      rec.targetOverruns++;
      rec.integrity = 'target-overflow';
    }
    rec.transportAdequacy = 'insufficient';
    const gapKind = reason === 'target-overflow'
      ? 'target-overflow'
      : reason === 'transport-drop'
        ? 'transport-gap'
        : 'host-drop';
    const runGen = rec.runGeneration;
    rec.ingestChain = rec.ingestChain.then(async () => {
      if (rec.runGeneration !== runGen || !rec.workerCreated || rec.workerFinished) return;
      const res = await this.ensureWorker().markGap({
        recordId: rec.recordId,
        sessionId: rec.identity.sessionId,
        sessionGeneration: rec.identity.sessionGeneration,
        gap: {
          kind: gapKind,
          droppedPackets: 'unknown',
          droppedBytes,
          preservesFraming: false,
          reason: `Continuous RTT ${reason}`,
        },
      });
      if (res.ok) {
        rec.gapCount += res.data.gapsRecorded;
      }
    });
    this.emitStatus(rec);
  }

  private handleContinuousSequenceGap(
    rec: ActiveRecordingContext,
    firstMissingSeq: number,
    lastMissingSeq: number,
    missingBatchCount: number,
  ): void {
    const reason = `Missing RTT batchSequence ${firstMissingSeq}..${lastMissingSeq} (${missingBatchCount} batch(es) lost before seq=${lastMissingSeq + 1})`;
    rec.transportAdequacy = 'insufficient';
    if (!rec.discardPreStartBytes && rec.streamObserver) {
      rec.streamObserver.markGap({
        kind: 'transport-gap',
        droppedPackets: 'unknown',
        droppedBytes: 'unknown',
        preservesFraming: false,
        reason,
      });
    }
    const runGen = rec.runGeneration;
    rec.ingestChain = rec.ingestChain.then(async () => {
      if (rec.runGeneration !== runGen || !rec.workerCreated || rec.workerFinished) return;
      const res = await this.ensureWorker().markGap({
        recordId: rec.recordId,
        sessionId: rec.identity.sessionId,
        sessionGeneration: rec.identity.sessionGeneration,
        gap: {
          kind: 'transport-gap',
          droppedPackets: 'unknown',
          droppedBytes: 'unknown',
          preservesFraming: false,
          reason,
        },
      });
      if (res.ok) {
        rec.gapCount += res.data.gapsRecorded;
      }
    });
    this.emitStatus(rec);
  }

  private async applyHostBackpressure(rec: ActiveRecordingContext, paused: boolean): Promise<void> {
    if (!rec.channelInfo || !rec.subscribedUpChannel) return;
    if (paused && rec.hostBackpressured) return;
    if (!paused && !rec.hostBackpressured) return;
    rec.hostBackpressured = paused;
    if (paused) {
      rec.backpressurePauses++;
    }
    if (paused || !rec.userPaused) {
      await Promise.resolve(rec.session.customRequest('orbitRttTransport', {
        action: 'setBackpressure',
        consumerId: rec.consumerId,
        bufferIndex: rec.channelInfo.upChannelIndex,
        paused,
      })).catch(() => {});
    }
    this.emitStatus(rec);
  }

  // --- Single-Shot & Post-Mortem shared buffered capture ------------------

  private async runBufferedMode(
    rec: ActiveRecordingContext,
    inspect: TraceTargetInspectResult,
    options: StartTraceRecordingOptions,
  ): Promise<TraceRecordingStatus> {
    const mode = rec.mode as 'single-shot' | 'post-mortem';
    const failBuffered = async (
      errorCode: string,
      message: string,
      completion: 'not-started' | 'partial' | 'completed' | 'unknown' = 'not-started',
      diagnostics?: Record<string, unknown>,
    ): Promise<TraceRecordingStatus> => {
      if (!this.isReservationValid(rec)) {
        return await this.waitForSettledStatus(rec);
      }
      rec.abortController.abort(errorCode);
      if (rec.workerCreated && !rec.workerFinished) {
        const disp = finishDispositionForError(errorCode);
        await this.ensureWorker().finishRecording(rec.recordId, `${errorCode}: ${message}`, {
          ...disp,
          ...(diagnostics ? { diagnostics } : {}),
        }).catch(() => {});
        rec.workerFinished = true;
      }
      rec.error = { errorCode, message, completion, ...(diagnostics ? { diagnostics } : {}) };
      rec.state = 'error';
      rec.stoppedAtMs = this.nowMs();
      rec.stateReason = `${errorCode}: ${message}`;
      this.finalizeRecord(rec);
      return this.snapshotStatus(rec);
    };

    if (!inspect.rttCapabilities?.rttEnumerate.available) {
      return failBuffered(
        'UnsupportedCapability',
        inspect.rttCapabilities?.rttEnumerate.reason || 'Selected owner does not support RTT enumeration',
      );
    }
    if (!inspect.ramRangesAvailable || !inspect.ramRanges?.length) {
      return failBuffered('UnsupportedCapability', 'Valid target RAM ranges are unavailable');
    }
    if (inspect.rttControlBlockAddress === undefined) {
      return failBuffered('RttControlBlockUnavailable', 'RTT control block (_SEGGER_RTT) could not be resolved');
    }

    // Check mode compatibility from DWARF metadata
    const postMortemCompiled = inspect.metadataLayout?.globals?.postMortemCompiled;
    const fcInitial = inspect.fixtureCaptureValues;
    if (mode === 'single-shot') {
      if (postMortemCompiled === true || fcInitial?.mode === 3) {
        return failBuffered('TraceModeMismatch', 'Target firmware is compiled for Post-Mortem mode, not Single-Shot');
      }
      if (fcInitial && fcInitial.mode !== 0 && fcInitial.mode !== 2) {
        return failBuffered('TraceModeMismatch', `Target firmware fixtureCapture.mode=${fcInitial.mode} does not match Single-Shot (expected 2)`);
      }
    } else {
      if (postMortemCompiled === false) {
        return failBuffered('TraceModeMismatch', 'Target firmware is not compiled with SEGGER_SYSVIEW_POST_MORTEM_MODE=1');
      }
      if (fcInitial && fcInitial.mode !== 0 && fcInitial.mode !== 3) {
        return failBuffered('TraceModeMismatch', `Target firmware fixtureCapture.mode=${fcInitial.mode} does not match Post-Mortem (expected 3)`);
      }
      if (postMortemCompiled !== true && fcInitial?.mode !== 3) {
        return failBuffered(
          'UnsupportedCapability',
          'Missing SystemView DWARF metadata (_SYSVIEW_Globals / fixtureCapture) to prove Post-Mortem mode',
        );
      }
    }

    // Enumerate RTT and ensure NO active Up reader is advancing RdOff on SysView channel
    let enumResult: CmsisDapRttEnumResult;
    try {
      const res = await rec.session.customRequest<{ ok: boolean; data?: CmsisDapRttEnumResult }>('orbitRttTransport', {
        action: 'enumerate',
        controlBlockAddress: inspect.rttControlBlockAddress,
        ramRanges: inspect.ramRanges,
        ...(inspect.roRanges ? { roRanges: inspect.roRanges } : {}),
      });
      if (!this.isReservationValid(rec)) {
        return await this.waitForSettledStatus(rec);
      }
      if (!res?.ok || !res.data) {
        return failBuffered('RttEnumerateFailed', 'RTT enumerate returned no descriptor table');
      }
      enumResult = res.data;
    } catch (err) {
      if (!this.isReservationValid(rec)) {
        return await this.waitForSettledStatus(rec);
      }
      const parsed = extractDapError(err, 'RttEnumerateFailed');
      return failBuffered(parsed.errorCode, parsed.message, 'not-started', parsed.diagnostics);
    }

    const upLookup = findSysViewChannel(enumResult, 'up');
    if (!upLookup.ok) {
      return failBuffered(upLookup.errorCode, upLookup.message);
    }
    const upGeo = validateSysViewBufferDescriptor(upLookup.descriptor, inspect.ramRanges);
    if (!upGeo.ok) return failBuffered(upGeo.errorCode, upGeo.message);

    try {
      const rttStatus = await rec.session.customRequest<{
        ok: boolean;
        status?: { channels?: Array<{ bufferIndex: number; refCount: number }> };
      }>('orbitRttTransport', { action: 'status' });
      if (!this.isReservationValid(rec)) {
        return await this.waitForSettledStatus(rec);
      }
      const activeUp = rttStatus?.status?.channels?.find(c => c.bufferIndex === upLookup.descriptor.index);
      if (activeUp && activeUp.refCount > 0) {
        return failBuffered(
          'RttChannelBusy',
          `SysView Up channel ${upLookup.descriptor.index} already has ${activeUp.refCount} active consumer(s); cannot read ${mode} without RdOff interference`,
        );
      }
    } catch (err) {
      if (!this.isReservationValid(rec)) {
        return await this.waitForSettledStatus(rec);
      }
      const parsed = extractDapError(err, 'RttStatusFailed');
      return failBuffered(parsed.errorCode, parsed.message);
    }

    rec.ramRanges = inspect.ramRanges;
    rec.roRanges = inspect.roRanges;
    rec.channelInfo = {
      controlBlockAddress: enumResult.controlBlockAddress,
      upChannelIndex: upLookup.descriptor.index,
      upChannelName: upLookup.descriptor.name,
      bufferAddress: upLookup.descriptor.bufferAddress,
      bufferSize: upLookup.descriptor.bufferSize,
      initialRdOff: upLookup.descriptor.rdOff,
      initialWrOff: upLookup.descriptor.wrOff,
    };

    // Optional explicit Start Down command for Single-Shot ONLY when explicitly requested
    if (mode === 'single-shot' && options.sendStartCommand === true) {
      if (inspect.targetState !== 'Running') {
        return failBuffered('TargetNotRunning', 'Single-Shot sendStartCommand requires a running target');
      }
      if (!inspect.rttCapabilities.rttDownWrite.available) {
        return failBuffered('UnsupportedCapability', 'Owner does not support RTT Down writes for sendStartCommand');
      }
      const downLookup = findSysViewChannel(enumResult, 'down');
      if (!downLookup.ok) {
        return failBuffered('UnsupportedCapability', `SysView Down channel unavailable: ${downLookup.message}`);
      }
      try {
        const writeRes = await rec.session.customRequest<{
          ok: boolean;
          data?: { skipped?: boolean; committedBytes?: number };
        }>('orbitRttTransport', {
          action: 'writeDown',
          bufferIndex: downLookup.descriptor.index,
          dataBase64: Buffer.from([SYSTEMVIEW_COMMAND_IDS.START]).toString('base64'),
          controlBlockAddress: enumResult.controlBlockAddress,
          ramRanges: inspect.ramRanges,
          ...(inspect.roRanges ? { roRanges: inspect.roRanges } : {}),
          timeoutMs: 2000,
        });
        if (!writeRes?.ok || writeRes.data?.skipped || (writeRes.data?.committedBytes ?? 0) < 1) {
          return failBuffered('DownBufferFull', 'Single-Shot START Down write was skipped or short');
        }
      } catch (err) {
        const parsed = extractDapError(err, 'RttMemoryWriteFailed');
        return failBuffered(parsed.errorCode, parsed.message, parsed.completion ?? 'unknown', parsed.diagnostics);
      }
    }

    // Prove frozen state (NO whole-buffer fallback when metadata is missing!)
    const hasFixtureCapture = Boolean(inspect.metadataLayout?.fixtureCapture);
    const hasGlobals = Boolean(inspect.metadataLayout?.globals);
    if (!hasFixtureCapture && !hasGlobals) {
      return failBuffered(
        'FreezeUnprovable',
        `Cannot prove ${mode} buffer freeze without DWARF metadata (_SYSVIEW_Globals or fixtureCapture)`,
      );
    }

    rec.state = 'recording';
    rec.phaseDetail = 'waiting-freeze';
    rec.stateReason = `Waiting for provable ${mode} freeze`;
    this.emitStatus(rec);

    const waitForFreeze = options.waitForFreeze !== false;
    const freezeDeadline = this.nowMs() + (options.freezeTimeoutMs ?? 10000);

    let preFreezeState: {
      source: 'fixture-capture' | 'halted-globals';
      targetState: 'Running' | 'Halted' | 'Unknown';
      globals?: SystemViewGlobalsValues;
      fixtureCapture?: FixtureCaptureValues;
      upDesc: CmsisDapRttChannelDescriptor;
    } | null = null;

    while (this.isContextCurrent(rec) && !rec.abortController.signal.aborted) {
      const stateSnapshot = await this.readTargetStateSafe(rec);
      if (!stateSnapshot) {
        if (!this.isContextCurrent(rec) || rec.abortController.signal.aborted) break;
        return failBuffered('TargetStateReadFailed', 'Failed to read target SystemView state while verifying freeze');
      }

      const curUpLookup = stateSnapshot.enumerate ? findSysViewChannel(stateSnapshot.enumerate, 'up') : undefined;
      if (curUpLookup && !curUpLookup.ok) {
        return failBuffered(curUpLookup.errorCode, curUpLookup.message);
      }
      const curUp = curUpLookup?.ok ? curUpLookup.descriptor : upLookup.descriptor;

      if (hasFixtureCapture) {
        const fc = stateSnapshot.fixtureCaptureValues;
        if (!fc) {
          return failBuffered('FreezeUnprovable', stateSnapshot.fixtureCaptureReadError || 'Failed to read fixtureCapture metadata');
        }
        const expectedModeNum = mode === 'single-shot' ? 2 : 3;
        if (fc.mode !== expectedModeNum) {
          return failBuffered('TraceModeMismatch', `fixtureCapture.mode=${fc.mode} does not match ${mode} (expected ${expectedModeNum})`);
        }
        if (fc.frozen === 1) {
          if (stateSnapshot.globalsValues && stateSnapshot.globalsValues.enableState !== 0) {
            return failBuffered(
              'FreezeMetadataMismatch',
              `fixtureCapture.frozen=1 conflicts with _SYSVIEW_Globals.EnableState=${stateSnapshot.globalsValues.enableState}`,
            );
          }
          preFreezeState = {
            source: 'fixture-capture',
            targetState: stateSnapshot.targetState,
            globals: stateSnapshot.globalsValues,
            fixtureCapture: fc,
            upDesc: curUp,
          };
          break;
        }
      } else {
        // Without fixtureCapture: ONLY halted target with EnableState === 0 proves buffer is frozen!
        if (stateSnapshot.targetState !== 'Halted') {
          return failBuffered(
            'FreezeUnprovable',
            `Cannot prove ${mode} buffer is frozen while target is ${stateSnapshot.targetState} without fixtureCapture metadata`,
          );
        }
        const g = stateSnapshot.globalsValues;
        if (!g) {
          return failBuffered('FreezeUnprovable', stateSnapshot.globalsReadError || 'Failed to read _SYSVIEW_Globals metadata');
        }
        if (g.enableState === 0) {
          if (curUp.wrOff === curUp.rdOff && g.lastTxTimeStamp === 0) {
            return failBuffered(
              'TraceNoRetainedData',
              'Target is halted with EnableState=0, LastTxTimeStamp=0, and WrOff==RdOff (no recording retained)',
            );
          }
          preFreezeState = {
            source: 'halted-globals',
            targetState: stateSnapshot.targetState,
            globals: g,
            upDesc: curUp,
          };
          break;
        }
      }

      if (!waitForFreeze) {
        return failBuffered('TraceNotFrozen', `${mode} buffer is not yet frozen`);
      }
      if (this.nowMs() >= freezeDeadline) {
        return failBuffered('FreezeTimeout', `Timed out waiting for ${mode} buffer freeze`);
      }
      await this.sleepMs(50, rec.abortController.signal);
    }

    if (!this.isContextCurrent(rec) || rec.abortController.signal.aborted) {
      return await this.waitForSettledStatus(rec);
    }
    if (!preFreezeState) {
      return failBuffered('TraceNotFrozen', `Unable to verify ${mode} freeze`);
    }

    // Validate freeze pointers & consistency with RTT Up descriptor
    const preUp = preFreezeState.upDesc;
    const upGeoAfter = validateSysViewBufferDescriptor(preUp, inspect.ramRanges);
    if (!upGeoAfter.ok) {
      return failBuffered(upGeoAfter.errorCode, upGeoAfter.message);
    }
    if (preFreezeState.fixtureCapture) {
      const fc = preFreezeState.fixtureCapture;
      if (fc.buffer !== preUp.bufferAddress || fc.size !== preUp.bufferSize
        || fc.wrOff !== preUp.wrOff || fc.rdOff !== preUp.rdOff) {
        return failBuffered(
          'FreezeMetadataMismatch',
          `fixtureCapture (buf=0x${fc.buffer.toString(16)}, size=${fc.size}, wr=${fc.wrOff}, rd=${fc.rdOff}) disagrees with RTT Up descriptor (buf=0x${preUp.bufferAddress.toString(16)}, size=${preUp.bufferSize}, wr=${preUp.wrOff}, rd=${preUp.rdOff})`,
        );
      }
    }

    const planResult = computeRingReadPlan(mode, preUp.bufferAddress, preUp.bufferSize, preUp.wrOff, preUp.rdOff);
    if (!planResult.ok) {
      return failBuffered(planResult.errorCode, planResult.message);
    }
    const plan = planResult.plan;
    const dropCount = preFreezeState.globals?.dropCount;
    const enabledBeforeStop = preFreezeState.fixtureCapture?.enabledBeforeStop;
    const targetOverflow = mode === 'single-shot'
      && (enabledBeforeStop === 2 || (dropCount !== undefined && dropCount > 0));

    rec.targetState = 'stopped';
    rec.targetDropCount = dropCount;
    if (targetOverflow) {
      rec.targetOverruns = 1;
    }
    rec.channelInfo = {
      ...rec.channelInfo,
      bufferAddress: preUp.bufferAddress,
      bufferSize: preUp.bufferSize,
      initialRdOff: preUp.rdOff,
      initialWrOff: preUp.wrOff,
    };
    rec.freezeEvidence = {
      source: preFreezeState.source,
      frozen: true,
      ...(preFreezeState.fixtureCapture ? {
        mode: preFreezeState.fixtureCapture.mode,
        generation: preFreezeState.fixtureCapture.generation,
        enabledBeforeStop: preFreezeState.fixtureCapture.enabledBeforeStop,
      } : {}),
      preWrOff: preUp.wrOff,
      preRdOff: preUp.rdOff,
      ...(dropCount !== undefined ? { dropCount } : {}),
      retainedBytes: plan.retainedBytes,
      wrapped: plan.wrapped,
      prefixOverwritten: plan.prefixOverwritten,
      rdOffAdvancedByHost: false,
    };

    if (plan.empty) {
      rec.integrity = 'empty';
      return failBuffered(
        'TraceNoRetainedData',
        `${mode} buffer has no retained bytes (wrOff=${preUp.wrOff} === rdOff=${preUp.rdOff})`,
        'completed',
        { freezeEvidence: rec.freezeEvidence },
      );
    }

    // Read retained ring slices WITHOUT advancing RdOff!
    rec.phaseDetail = 'reading-buffer';
    rec.stateReason = `Reading ${plan.retainedBytes} retained bytes (${plan.slices.length} slice(s)) without advancing RdOff`;
    this.emitStatus(rec);

    const chunks: Uint8Array[] = [];
    for (const slice of plan.slices) {
      if (!this.isContextCurrent(rec) || rec.abortController.signal.aborted) {
        return await this.waitForSettledStatus(rec);
      }
      try {
        const readRes = await rec.session.customRequest<{
          ok: boolean;
          dataBase64: string;
          bytesRead: number;
          sessionGeneration: number;
          bootGeneration: number;
        }>('orbitTraceTarget', {
          action: 'readMemoryRange',
          address: slice.address,
          size: slice.size,
          expectedSessionGeneration: rec.identity.sessionGeneration,
          expectedBootGeneration: rec.identity.bootGeneration,
          ramRanges: inspect.ramRanges,
        });
        if (!this.isReservationValid(rec)) {
          return await this.waitForSettledStatus(rec);
        }
        if (!readRes?.ok || typeof readRes.dataBase64 !== 'string') {
          return failBuffered('MemoryReadFailed', 'readMemoryRange returned no payload', 'partial');
        }
        const sliceBytes = Uint8Array.from(Buffer.from(readRes.dataBase64, 'base64'));
        if (sliceBytes.length !== slice.size) {
          return failBuffered('ShortRead', `Expected ${slice.size} bytes, got ${sliceBytes.length}`, 'partial');
        }
        chunks.push(sliceBytes);
      } catch (err) {
        if (!this.isReservationValid(rec)) {
          return await this.waitForSettledStatus(rec);
        }
        const parsed = extractDapError(err, 'MemoryReadFailed');
        return failBuffered(parsed.errorCode, parsed.message, 'partial', parsed.diagnostics);
      }
    }

    // Post-read freeze identity / generation / offset verification
    rec.phaseDetail = 'verifying-freeze';
    this.emitStatus(rec);

    const postSnapshot = await this.readTargetStateSafe(rec);
    if (!this.isReservationValid(rec)) {
      return await this.waitForSettledStatus(rec);
    }
    if (!postSnapshot) {
      return failBuffered('FreezeIntegrityLost', 'Could not verify target freeze identity after buffer read', 'partial');
    }
    const postUpLookup = postSnapshot.enumerate ? findSysViewChannel(postSnapshot.enumerate, 'up') : undefined;
    if (!postUpLookup || !postUpLookup.ok) {
      return failBuffered('FreezeIntegrityLost', 'SysView Up descriptor unavailable on post-read verification', 'partial');
    }
    const postUp = postUpLookup.descriptor;
    if (postUp.rdOff !== preUp.rdOff || postUp.wrOff !== preUp.wrOff
      || postUp.bufferAddress !== preUp.bufferAddress || postUp.bufferSize !== preUp.bufferSize) {
      return failBuffered(
        'FreezeIntegrityLost',
        `RTT Up pointers changed during ${mode} read (before rd=${preUp.rdOff}/wr=${preUp.wrOff}, after rd=${postUp.rdOff}/wr=${postUp.wrOff})`,
        'partial',
      );
    }
    if (preFreezeState.source === 'fixture-capture') {
      const preFc = preFreezeState.fixtureCapture!;
      const postFc = postSnapshot.fixtureCaptureValues;
      if (!postFc || postFc.frozen !== 1 || postFc.generation !== preFc.generation
        || postFc.wrOff !== preFc.wrOff || postFc.rdOff !== preFc.rdOff
        || postFc.buffer !== preFc.buffer || postFc.size !== preFc.size) {
        return failBuffered(
          'FreezeIntegrityLost',
          `fixtureCapture identity/generation/offsets changed during ${mode} read`,
          'partial',
          { preFc, postFc },
        );
      }
    } else if (postSnapshot.targetState !== 'Halted' || postSnapshot.globalsValues?.enableState !== 0) {
      return failBuffered(
        'FreezeIntegrityLost',
        `Target resumed or EnableState changed during halted ${mode} read`,
        'partial',
      );
    }

    rec.channelInfo = {
      ...rec.channelInfo,
      finalRdOff: postUp.rdOff,
      finalWrOff: postUp.wrOff,
    };
    rec.freezeEvidence = {
      ...rec.freezeEvidence,
      postWrOff: postUp.wrOff,
      postRdOff: postUp.rdOff,
      rdOffAdvancedByHost: false,
    };

    const fullBytes = chunks.length === 1 ? chunks[0] : Uint8Array.from(Buffer.concat(chunks.map(c => Buffer.from(c))));
    rec.bytesReceived = fullBytes.length;
    rec.batchesReceived = 1;

    // Deliver chronological bytes to 4.3 Worker
    rec.phaseDetail = 'persisting';
    this.emitStatus(rec);

    const worker = this.ensureWorker();
    const createRes = await worker.createRecording({
      recordingDir: rec.recordingDir,
      recordId: rec.recordId,
      identity: {
        sessionId: rec.identity.sessionId,
        sessionGeneration: rec.identity.sessionGeneration,
        bootGeneration: rec.identity.bootGeneration,
        recordId: rec.recordId,
      },
      decoderOptions: { initialSyncMode: 'seeking-sync' },
      commitOnEachIngest: options.commitOnEachIngest ?? true,
    });
    if (!this.isReservationValid(rec)) {
      if (createRes.ok) {
        const disp = finishDispositionForError('RecordingStoppedBeforeFreeze');
        await worker.finishRecording(rec.recordId, 'aborted-during-buffered-create', disp).catch(() => {});
        await worker.closeRecording(rec.recordId).catch(() => {});
        rec.workerFinished = true;
      }
      return await this.waitForSettledStatus(rec);
    }
    if (!createRes.ok) {
      return failBuffered(createRes.errorCode, createRes.message, 'not-started', createRes.diagnostics);
    }
    rec.workerCreated = true;

    const ingestRes = await worker.ingestChunk({
      recordId: rec.recordId,
      sessionId: rec.identity.sessionId,
      sessionGeneration: rec.identity.sessionGeneration,
      bootGeneration: rec.identity.bootGeneration,
      batchSequence: 1,
      chunk: fullBytes,
      flush: true,
    });
    if (!ingestRes.ok) {
      return failBuffered(ingestRes.errorCode, ingestRes.message, 'partial', ingestRes.diagnostics);
    }
    rec.committedRawBytes = ingestRes.data.committedRawBytes;
    rec.packetsDecoded = ingestRes.data.packetsDecoded;
    rec.sliceCount = ingestRes.data.slicesEmitted;
    rec.gapCount = ingestRes.data.gapsRecorded;

    if (targetOverflow) {
      const gapRes = await worker.markGap({
        recordId: rec.recordId,
        sessionId: rec.identity.sessionId,
        sessionGeneration: rec.identity.sessionGeneration,
        gap: {
          kind: 'target-overflow',
          droppedPackets: dropCount ?? 'unknown',
          droppedBytes: 'unknown',
          preservesFraming: true,
          reason: `Single-Shot buffer overflowed before freeze (enabledBeforeStop=${enabledBeforeStop ?? 'unknown'}, dropCount=${dropCount ?? 'unknown'})`,
        },
      });
      if (gapRes.ok) {
        rec.gapCount += gapRes.data.gapsRecorded;
      }
    }

    const flushRes = await worker.flushRecording(rec.recordId);
    if (!flushRes.ok) {
      return failBuffered(flushRes.errorCode, flushRes.message, 'partial', flushRes.diagnostics);
    }

    // Post-Mortem requires at least one genuine sync segment
    const statsRes = await worker.getStats(rec.recordId);
    const recStats = statsRes.ok ? statsRes.data.records[rec.recordId] : undefined;
    if (recStats) {
      rec.segmentCount = recStats.committed.segmentCount;
      rec.gapCount = recStats.committed.gapCount;
      rec.packetsDecoded = recStats.committed.packetCount;
      rec.sliceCount = recStats.committed.sliceCount;
    }

    const noSyncFound = mode === 'post-mortem' && rec.segmentCount === 0;
    const finishReason = noSyncFound
      ? 'NoValidSyncFound: Post-Mortem ring lacked a genuine SystemView sync'
      : `${mode}-completed`;
    const finishRes = await worker.finishRecording(
      rec.recordId,
      finishReason,
      noSyncFound ? finishDispositionForError('NoValidSyncFound') : { terminalState: 'completed' },
    );
    rec.workerFinished = true;
    if (!finishRes.ok) {
      return failBuffered(finishRes.errorCode, finishRes.message, 'partial', finishRes.diagnostics);
    }
    rec.manifest = finishRes.data;
    this.syncCountsFromManifest(rec, finishRes.data);
    rec.stoppedAtMs = this.nowMs();

    if (noSyncFound) {
      rec.integrity = 'no-sync';
      rec.state = 'incomplete';
      rec.error = {
        errorCode: 'NoValidSyncFound',
        message: 'Post-Mortem ring contained no genuine SystemView sync (10*0x00 + TRACE_START + INIT)',
        completion: 'completed',
      };
      rec.stateReason = 'Post-Mortem ring lacked a genuine SystemView sync';
      this.finalizeRecord(rec);
      return this.snapshotStatus(rec);
    }

    rec.integrity = targetOverflow
      ? 'target-overflow'
      : (mode === 'post-mortem' && plan.prefixOverwritten)
        ? 'prefix-overwritten'
        : 'complete';
    rec.state = 'stopped';
    rec.stateReason = mode === 'post-mortem'
      ? `Post-Mortem capture verified and persisted (${rec.segmentCount} segment(s), no RdOff advance)`
      : targetOverflow
        ? 'Single-Shot capture completed with target buffer overflow faithfully recorded'
        : 'Single-Shot capture verified and persisted (no RdOff advance)';
    this.finalizeRecord(rec);
    return this.snapshotStatus(rec);
  }

  private async stopBufferedRecording(rec: ActiveRecordingContext): Promise<TraceRecordingStatus> {
    rec.state = 'stopping';
    rec.phaseDetail = 'cancelling-wait';
    if (rec.sendStopCommandOnCancel && rec.mode === 'single-shot' && rec.channelInfo) {
      // Optional explicit STOP Down command if caller requested it
      await Promise.resolve(rec.session.customRequest('orbitRttTransport', {
        action: 'writeDown',
        channelName: 'SysView',
        dataBase64: Buffer.from([SYSTEMVIEW_COMMAND_IDS.STOP]).toString('base64'),
        controlBlockAddress: rec.channelInfo.controlBlockAddress,
        ...(rec.ramRanges ? { ramRanges: rec.ramRanges } : {}),
        ...(rec.roRanges ? { roRanges: rec.roRanges } : {}),
        timeoutMs: 1000,
      })).catch(() => {});
    }
    return this.abortActiveRecording('RecordingStoppedBeforeFreeze', `Explicit stop requested during ${rec.mode} wait`, false);
  }

  private async abortActiveRecording(
    errorCode: string,
    message: string,
    tryUnsubscribe: boolean,
    nextBootGeneration?: number,
  ): Promise<TraceRecordingStatus> {
    const rec = this.activeRecording;
    if (!rec) {
      throw new Error('No active recording to abort');
    }
    if (rec.abortPromise) {
      return rec.abortPromise;
    }

    if (!rec.abortController.signal.aborted) {
      rec.abortController.abort(message);
    }
    rec.runGeneration++;
    if (this.activeReservationId === rec.reservationId) {
      this.activeReservationId = 0;
    }

    const canDetachImmediately = !tryUnsubscribe || !rec.subscribedUpChannel || !rec.channelInfo || this.endedSessions.has(rec.session);
    if (canDetachImmediately && this.activeRecording === rec) {
      this.activeRecording = null;
    }

    rec.abortPromise = (async (): Promise<TraceRecordingStatus> => {
      if (tryUnsubscribe && rec.subscribedUpChannel && rec.channelInfo && !this.endedSessions.has(rec.session)) {
        rec.subscribedUpChannel = false;
        await Promise.resolve(rec.session.customRequest('orbitRttTransport', {
          action: 'unsubscribe',
          consumerId: rec.consumerId,
          bufferIndex: rec.channelInfo.upChannelIndex,
          drainLastBatch: false,
        })).catch(() => {});
      } else {
        rec.subscribedUpChannel = false;
      }

      if (this.activeRecording === rec) {
        this.activeRecording = null;
      }

      await Promise.race([
        rec.ingestChain,
        this.sleepMs(500),
      ]);

      if (rec.workerCreated && !rec.workerFinished) {
        const worker = this.ensureWorker();
        if (nextBootGeneration !== undefined) {
          await worker.notifyTargetReset({
            recordId: rec.recordId,
            sessionId: rec.identity.sessionId,
            sessionGeneration: rec.identity.sessionGeneration,
            nextBootGeneration,
            reason: message,
          }).catch(() => {});
        }
        await worker.flushRecording(rec.recordId).catch(() => {});
        const disp = finishDispositionForError(errorCode);
        const finishRes = await worker.finishRecording(
          rec.recordId,
          `${errorCode}: ${message}`,
          disp,
        ).catch(() => undefined);
        rec.workerFinished = true;
        if (finishRes?.ok) {
          rec.manifest = finishRes.data;
          this.syncCountsFromManifest(rec, finishRes.data);
        }
      }

      rec.stoppedAtMs = this.nowMs();
      rec.error = { errorCode, message };
      const disp = finishDispositionForError(errorCode);
      rec.state = disp.terminalState === 'interrupted' ? 'incomplete' : 'error';
      if (rec.integrity === 'unknown') rec.integrity = 'incomplete';
      if (errorCode === 'SessionTerminated' || errorCode === 'ConnectionLost' || errorCode === 'TargetReset') {
        rec.targetState = 'unknown';
      }
      rec.stateReason = `${errorCode}: ${message}`;
      this.finalizeRecord(rec);
      return this.snapshotStatus(rec);
    })();

    return rec.abortPromise;
  }

  private async cleanupContinuousFailure(
    rec: ActiveRecordingContext,
    errorCode: string,
    message: string,
    completion: 'not-started' | 'partial' | 'completed' | 'unknown',
    diagnostics?: Record<string, unknown>,
  ): Promise<void> {
    if (rec.finalized) {
      return;
    }
    if (!rec.abortController.signal.aborted) {
      rec.abortController.abort(message);
    }
    if (this.activeReservationId === rec.reservationId) {
      this.activeReservationId = 0;
    }
    if (rec.subscribedUpChannel && rec.channelInfo && !this.endedSessions.has(rec.session)) {
      rec.subscribedUpChannel = false;
      await Promise.resolve(rec.session.customRequest('orbitRttTransport', {
        action: 'unsubscribe',
        consumerId: rec.consumerId,
        bufferIndex: rec.channelInfo.upChannelIndex,
        drainLastBatch: false,
      })).catch(() => {});
    } else {
      rec.subscribedUpChannel = false;
    }
    await Promise.race([rec.ingestChain, this.sleepMs(200)]);
    if (rec.workerCreated && !rec.workerFinished) {
      const disp = finishDispositionForError(errorCode);
      const finishRes = await this.ensureWorker().finishRecording(
        rec.recordId,
        `${errorCode}: ${message}`,
        { ...disp, ...(diagnostics ? { diagnostics } : {}) },
      ).catch(() => undefined);
      rec.workerFinished = true;
      if (finishRes?.ok) {
        rec.manifest = finishRes.data;
        this.syncCountsFromManifest(rec, finishRes.data);
      }
    }
    rec.stoppedAtMs = this.nowMs();
    rec.error = { errorCode, message, completion, ...(diagnostics ? { diagnostics } : {}) };
    rec.state = 'error';
    if (completion === 'unknown') {
      rec.targetState = 'unknown';
    }
    rec.stateReason = `${errorCode}: ${message}`;
    this.finalizeRecord(rec);
  }

  private async failReservedPreStart(
    rec: ActiveRecordingContext,
    errorCode: string,
    message: string,
    completion: 'not-started' | 'partial' | 'completed' | 'unknown' = 'not-started',
    diagnostics?: Record<string, unknown>,
  ): Promise<TraceRecordingStatus> {
    if (rec.finalized) {
      return this.completedRecords.get(rec.recordId) ?? this.snapshotStatus(rec);
    }
    if (!rec.abortController.signal.aborted) {
      rec.abortController.abort(message);
    }
    if (this.activeReservationId === rec.reservationId) {
      this.activeReservationId = 0;
    }
    rec.stoppedAtMs = this.nowMs();
    rec.error = { errorCode, message, completion, ...(diagnostics ? { diagnostics } : {}) };
    rec.state = 'error';
    rec.phaseDetail = 'rejected';
    rec.stateReason = `${errorCode}: ${message}`;
    this.finalizeRecord(rec);
    return this.snapshotStatus(rec);
  }

  private async waitForSettledStatus(rec: ActiveRecordingContext): Promise<TraceRecordingStatus> {
    if (rec.abortPromise) {
      return await rec.abortPromise;
    }
    return this.completedRecords.get(rec.recordId) ?? this.snapshotStatus(rec);
  }

  private isReservationValid(rec: ActiveRecordingContext): boolean {
    return !this.disposed
      && !rec.finalized
      && this.activeRecording === rec
      && this.activeReservationId === rec.reservationId
      && this.boundSession === rec.session
      && !this.endedSessions.has(rec.session)
      && !rec.abortController.signal.aborted;
  }

  private async readTargetStateSafe(rec: ActiveRecordingContext): Promise<{
    targetState: 'Running' | 'Halted' | 'Unknown';
    globalsValues?: SystemViewGlobalsValues;
    globalsReadError?: string;
    fixtureCaptureValues?: FixtureCaptureValues;
    fixtureCaptureReadError?: string;
    enumerate?: CmsisDapRttEnumResult;
  } | null> {
    if (!this.isContextCurrent(rec)) return null;
    try {
      const res = await rec.session.customRequest<{
        ok: boolean;
        sessionGeneration: number;
        bootGeneration: number;
        targetState: 'Running' | 'Halted' | 'Unknown';
        globalsValues?: SystemViewGlobalsValues;
        globalsReadError?: string;
        fixtureCaptureValues?: FixtureCaptureValues;
        fixtureCaptureReadError?: string;
        enumerate?: CmsisDapRttEnumResult;
      }>('orbitTraceTarget', { action: 'readState', includeEnumerate: true });
      if (!res?.ok) return null;
      if (res.sessionGeneration !== rec.identity.sessionGeneration || res.bootGeneration !== rec.identity.bootGeneration) {
        void this.abortActiveRecording(
          'TargetReset',
          `Target identity changed during readState (boot ${rec.identity.bootGeneration} -> ${res.bootGeneration})`,
          false,
          res.bootGeneration,
        );
        return null;
      }
      return res;
    } catch {
      return null;
    }
  }

  private isContextCurrent(rec: ActiveRecordingContext): boolean {
    return this.isReservationValid(rec);
  }

  private isRecordingInProgress(state: TraceRecordingState): boolean {
    return state === 'preparing' || state === 'recording' || state === 'paused' || state === 'stopping';
  }

  private resolveTargetRecording(recordId?: string): ActiveRecordingContext | null {
    if (!this.activeRecording) return null;
    if (recordId !== undefined && this.activeRecording.recordId !== recordId) return null;
    return this.activeRecording;
  }

  private targetStateFromGlobals(g?: SystemViewGlobalsValues): TraceTargetState {
    if (!g) return 'unknown';
    if (g.enableState === 0) return 'stopped';
    if (g.enableState === 1) return 'recording';
    if (g.enableState === 2) return 'dropping';
    return 'unknown';
  }

  private syncCountsFromManifest(rec: ActiveRecordingContext, manifest: TraceRecordingManifest): void {
    rec.committedRawBytes = manifest.committed.rawBytes;
    rec.packetsDecoded = manifest.committed.packetCount;
    rec.sliceCount = manifest.committed.sliceCount;
    rec.gapCount = manifest.committed.gapCount;
    rec.segmentCount = manifest.committed.segmentCount;
  }

  private finalizeRecord(rec: ActiveRecordingContext): void {
    rec.finalized = true;
    if (this.activeReservationId === rec.reservationId) {
      this.activeReservationId = 0;
    }
    const snap = this.snapshotStatus(rec);
    this.completedRecords.set(rec.recordId, snap);
    if (this.completedRecords.size > 32) {
      const oldest = this.completedRecords.keys().next().value;
      if (oldest !== undefined) {
        this.completedRecords.delete(oldest);
      }
    }
    if (this.activeRecording === rec) {
      this.activeRecording = null;
    }
    this.emitStatus(rec);
  }

  private snapshotStatus(rec: ActiveRecordingContext): TraceRecordingStatus {
    return {
      recordId: rec.recordId,
      mode: rec.mode,
      state: rec.state,
      phaseDetail: rec.phaseDetail,
      stateReason: rec.stateReason,
      targetState: rec.targetState,
      integrity: rec.integrity,
      transportAdequacy: rec.transportAdequacy,
      ...(rec.transportBudget ? { transportBudget: rec.transportBudget } : {}),
      identity: { ...rec.identity },
      recordingDir: rec.recordingDir,
      ...(rec.channelInfo ? { channelInfo: { ...rec.channelInfo } } : {}),
      ...(rec.freezeEvidence ? { freezeEvidence: { ...rec.freezeEvidence } } : {}),
      counters: {
        bytesReceived: rec.bytesReceived,
        committedRawBytes: rec.committedRawBytes,
        batchesReceived: rec.batchesReceived,
        packetsDecoded: rec.packetsDecoded,
        sliceCount: rec.sliceCount,
        gapCount: rec.gapCount,
        segmentCount: rec.segmentCount,
        targetOverruns: rec.targetOverruns,
        ...(rec.targetDropCount !== undefined ? { targetDropCount: rec.targetDropCount } : {}),
        hostDroppedBytes: rec.hostDroppedBytes,
        transportDroppedBytes: rec.transportDroppedBytes,
        backpressurePauses: rec.backpressurePauses,
        preStartDrainedBytes: rec.preStartDrainedBytes,
      },
      ...(rec.error ? { error: { ...rec.error } } : {}),
      startedAtMs: rec.startedAtMs,
      ...(rec.stoppedAtMs !== undefined ? { stoppedAtMs: rec.stoppedAtMs } : {}),
      ...(rec.manifest ? { manifest: rec.manifest } : {}),
    };
  }

  private failedImmediateStatus(
    options: Pick<StartTraceRecordingOptions, 'mode' | 'recordId'>,
    errorCode: string,
    message: string,
  ): TraceRecordingStatus {
    const status: TraceRecordingStatus = {
      recordId: options.recordId || `trace-err-${this.nowMs()}`,
      mode: options.mode,
      state: 'error',
      phaseDetail: 'rejected',
      stateReason: `${errorCode}: ${message}`,
      targetState: 'unknown',
      integrity: 'unknown',
      transportAdequacy: 'unknown',
      counters: {
        bytesReceived: 0,
        committedRawBytes: 0,
        batchesReceived: 0,
        packetsDecoded: 0,
        sliceCount: 0,
        gapCount: 0,
        segmentCount: 0,
        targetOverruns: 0,
        hostDroppedBytes: 0,
        transportDroppedBytes: 0,
        backpressurePauses: 0,
        preStartDrainedBytes: 0,
      },
      error: {
        errorCode,
        message,
        completion: 'not-started',
      },
    };
    this.publishStatus(status);
    return status;
  }

  private emitStatusThrottled(rec: ActiveRecordingContext): void {
    const now = this.nowMs();
    if (now - this.lastProgressEmitMs < 150) return;
    this.lastProgressEmitMs = now;
    this.emitStatus(rec);
  }

  private emitStatus(rec: ActiveRecordingContext): void {
    this.lastProgressEmitMs = this.nowMs();
    this.publishStatus(this.snapshotStatus(rec));
  }

  private publishStatus(status: TraceRecordingStatus): void {
    this.onStatusChange?.(status);
    for (const listener of this.statusListeners) {
      try {
        listener(status);
      } catch {
        // Ignore listener errors to avoid disrupting coordinator state transitions.
      }
    }
  }
}
