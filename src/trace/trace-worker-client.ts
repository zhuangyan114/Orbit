import * as fs from 'node:fs';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import type {
  SystemViewDecodeBatch,
  SystemViewDecoderOptions,
  TraceGapInput,
} from './systemview-decoder';
import type {
  TraceReconstructBatch,
  TraceReconstructionIdentity,
  TraceSymbolMap,
} from './systemview-reconstructor';
import type {
  RecordingInspectionResult,
  SegmentIndexMetadata,
  StoredGapEntry,
  TraceRecordingManifest,
} from './trace-format';
import type {
  TraceAnalysisQueryRequest,
  TraceAnalysisQueryResult,
} from './trace-analytics';
import type {
  IngestBatchSummary,
  TraceLodQueryRequest,
  TraceLodQueryResult,
  TraceRangeQueryRequest,
  TraceRangeQueryResult,
  TraceStorageLimits,
  TraceStorageResult,
  TraceStorageStats,
} from './trace-recording-store';
import {
  DEFAULT_TRACE_WORKER_LIMITS,
  estimateDecodedBatchBytes,
  OpenRecordingWorkerResult,
  PullRawStreamResult,
  resolveTraceWorkerLimits,
  TraceWorkerInitData,
  TraceWorkerLimits,
  TraceWorkerMessage,
  TraceWorkerRequest,
  TraceWorkerResponse,
  TraceWorkerStatsSnapshot,
} from './trace-worker-protocol';

export interface TraceWorkerClientOptions {
  readonly workerPath?: string;
  readonly limits?: Partial<TraceWorkerLimits>;
  readonly useSharedCancelBuffer?: boolean;
  readonly shutdownTimeoutMs?: number;
  readonly onProgress?: (event: {
    recordId: string;
    committedRawBytes: number;
    packetCount: number;
    sliceCount: number;
    gapCount: number;
  }) => Promise<void> | void;
}

export interface HostClientStatsSnapshot {
  readonly inFlightInputBytes: number;
  readonly inFlightInputBatches: number;
  readonly waitingInputBytes: number;
  readonly waitingInputBatches: number;
  readonly totalRetainedInputBytes: number;
  readonly peakInFlightInputBytes: number;
  readonly peakInFlightInputBatches: number;
  readonly peakWaitingInputBytes: number;
  readonly peakRetainedInputBytes: number;
  readonly hostBackpressureWaits: number;
  readonly hostBackpressureRejects: number;
  readonly inFlightQueryCount: number;
  readonly peakInFlightQueryCount: number;
  readonly hostQueryLimitRejects: number;
  readonly pendingRequests: number;
  readonly activeCancelSlots: number;
  readonly closed: boolean;
}

export interface WorkerRawExportStreamHandle {
  readonly streamId: string;
  readonly totalBytes: number;
  readonly chunkBytes: number;
  pull(): Promise<TraceStorageResult<PullRawStreamResult>>;
  close(): Promise<void>;
}

export function resolveDefaultTraceWorkerPath(): string {
  const sibling = path.join(__dirname, 'trace-worker.js');
  if (fs.existsSync(sibling)) {
    return sibling;
  }
  const distPath = path.resolve(__dirname, '../../dist/trace-worker.js');
  if (fs.existsSync(distPath)) {
    return distPath;
  }
  const cwdDistPath = path.resolve(process.cwd(), 'dist/trace-worker.js');
  if (fs.existsSync(cwdDistPath)) {
    return cwdDistPath;
  }
  throw new Error(
    `Trace worker bundle not found (checked ${sibling}, ${distPath}, ${cwdDistPath}). Run npm run build or compile with tsc.`,
  );
}

interface PendingRpc {
  readonly resolve: (res: TraceWorkerResponse) => void;
  readonly reject: (err: Error) => void;
}

/**
 * 宿主侧 `worker_threads` Trace Worker 客户端（阶段 4.3）：
 * - 零 `vscode` 依赖、零硬件直接访问；
 * - 维护宿主机侧有界输入队列背压、SharedArrayBuffer/消息双通道查询取消槽（防二次 release）、
 *   单槽聚合进度通知确认与有序关闭。
 */
export class TraceWorkerClient {
  public readonly limits: TraceWorkerLimits;
  private readonly worker: Worker;
  private readonly cancelBuffer: SharedArrayBuffer | null;
  private readonly cancelView: Int32Array | null;
  private readonly freeCancelSlots: number[] = [];
  private readonly activeCancelTokens = new Map<number, number>();
  private readonly shutdownTimeoutMs: number;
  private readonly onProgress?: TraceWorkerClientOptions['onProgress'];

  private readonly pending = new Map<number, PendingRpc>();
  private readonly drainWaiters: Array<() => void> = [];
  private readonly maxInputWaiters: number;
  private readonly maxInputWaiterBytes: number;
  private nextReqId = 1;
  private nextSeqId = 1;
  private nextCancelToken = 1;

  private inFlightInputBytes = 0;
  private inFlightInputBatches = 0;
  private waitingInputBytes = 0;
  private waitingInputBatches = 0;
  private peakInFlightInputBytes = 0;
  private peakInFlightInputBatches = 0;
  private peakWaitingInputBytes = 0;
  private peakRetainedInputBytes = 0;
  private hostBackpressureWaits = 0;
  private hostBackpressureRejects = 0;
  private inFlightQueryCount = 0;
  private peakInFlightQueryCount = 0;
  private hostQueryLimitRejects = 0;
  private closed = false;
  private workerExited = false;
  private exitPromise: Promise<number>;

  public constructor(options: TraceWorkerClientOptions = {}) {
    this.limits = resolveTraceWorkerLimits(options.limits);
    this.maxInputWaiters =
      this.limits.maxInputWaiters ?? Math.max(1, Math.min(this.limits.maxInputQueueBatches, 4));
    this.maxInputWaiterBytes = this.limits.maxInputWaiterBytes ?? this.limits.maxInputQueueBytes;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5000;
    this.onProgress = options.onProgress;

    const useSab = options.useSharedCancelBuffer ?? typeof SharedArrayBuffer === 'function';
    if (useSab) {
      this.cancelBuffer = new SharedArrayBuffer(this.limits.maxCancelSlots * 4);
      this.cancelView = new Int32Array(this.cancelBuffer);
      for (let i = this.limits.maxCancelSlots - 1; i >= 0; i--) {
        this.freeCancelSlots.push(i);
      }
    } else {
      this.cancelBuffer = null;
      this.cancelView = null;
    }

    const workerPath = options.workerPath ?? resolveDefaultTraceWorkerPath();
    const initData: TraceWorkerInitData = {
      limits: this.limits,
      cancelBuffer: this.cancelBuffer ?? undefined,
    };

    this.worker = new Worker(workerPath, { workerData: initData });
    this.exitPromise = new Promise<number>((resolve) => {
      this.worker.once('exit', (code) => {
        this.workerExited = true;
        this.rejectAllPending(new Error(`Trace worker exited with code ${code}`));
        this.wakeDrainWaiters();
        resolve(code);
      });
    });

    this.worker.on('message', (msg: TraceWorkerMessage) => {
      if (msg.kind === 'response') {
        const entry = this.pending.get(msg.reqId);
        if (entry) {
          this.pending.delete(msg.reqId);
          entry.resolve(msg);
        }
        return;
      }
      if (msg.kind === 'event') {
        if (msg.event === 'drain') {
          this.wakeDrainWaiters();
        } else if (msg.event === 'progress') {
          void this.handleProgressEvent(msg);
        }
      }
    });

    this.worker.on('error', (err) => {
      this.rejectAllPending(err instanceof Error ? err : new Error(String(err)));
      this.wakeDrainWaiters();
    });
  }

  private async handleProgressEvent(msg: {
    recordId: string;
    committedRawBytes: number;
    packetCount: number;
    sliceCount: number;
    gapCount: number;
  }): Promise<void> {
    try {
      if (this.onProgress) {
        await this.onProgress({
          recordId: msg.recordId,
          committedRawBytes: msg.committedRawBytes,
          packetCount: msg.packetCount,
          sliceCount: msg.sliceCount,
          gapCount: msg.gapCount,
        });
      }
    } finally {
      if (!this.closed && !this.workerExited) {
        void this.sendRaw({ reqId: this.nextReqId++, type: 'ackProgress', recordId: msg.recordId }).catch(() => {});
      }
    }
  }

  private rejectAllPending(err: Error): void {
    for (const [id, entry] of this.pending.entries()) {
      this.pending.delete(id);
      entry.reject(err);
    }
  }

  private wakeDrainWaiters(): void {
    const count = this.drainWaiters.length;
    for (let i = 0; i < count; i++) {
      const fn = this.drainWaiters.shift();
      if (!fn) break;
      fn();
    }
  }

  private updateRetainedPeaks(): void {
    if (this.inFlightInputBytes > this.peakInFlightInputBytes) {
      this.peakInFlightInputBytes = this.inFlightInputBytes;
    }
    if (this.inFlightInputBatches > this.peakInFlightInputBatches) {
      this.peakInFlightInputBatches = this.inFlightInputBatches;
    }
    if (this.waitingInputBytes > this.peakWaitingInputBytes) {
      this.peakWaitingInputBytes = this.waitingInputBytes;
    }
    const retained = this.inFlightInputBytes + this.waitingInputBytes;
    if (retained > this.peakRetainedInputBytes) {
      this.peakRetainedInputBytes = retained;
    }
  }

  private sendRaw(msg: TraceWorkerRequest): Promise<TraceWorkerResponse> {
    if (this.closed || this.workerExited) {
      return Promise.resolve({
        kind: 'response',
        reqId: msg.reqId,
        ok: false,
        errorCode: 'WorkerClosed',
        message: 'Trace Worker 客户端已关闭',
      });
    }
    return new Promise<TraceWorkerResponse>((resolve, reject) => {
      this.pending.set(msg.reqId, { resolve, reject });
      try {
        this.worker.postMessage(msg);
      } catch (err) {
        this.pending.delete(msg.reqId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private toResult<T>(res: TraceWorkerResponse): TraceStorageResult<T> {
    if (res.ok) {
      return { ok: true, data: res.data as T };
    }
    return {
      ok: false,
      errorCode: res.errorCode as any,
      message: res.message,
      cancelled: res.cancelled,
      diagnostics: res.diagnostics,
    };
  }

  private acquireCancelSlot(): {
    slot?: number;
    token?: number;
    cancel: () => void;
    release: () => void;
  } {
    let released = false;
    if (!this.cancelView || this.freeCancelSlots.length === 0) {
      return {
        cancel: () => {},
        release: () => {
          released = true;
        },
      };
    }
    const slot = this.freeCancelSlots.pop()!;
    const token = (this.nextCancelToken++ % 0x7ffffffe) + 1;
    Atomics.store(this.cancelView, slot, 0);
    this.activeCancelTokens.set(slot, token);
    return {
      slot,
      token,
      cancel: () => {
        if (!released && this.cancelView) {
          Atomics.store(this.cancelView, slot, token);
        }
      },
      release: () => {
        if (released) {
          return;
        }
        released = true;
        if (this.cancelView) {
          Atomics.store(this.cancelView, slot, 0);
        }
        this.activeCancelTokens.delete(slot);
        this.freeCancelSlots.push(slot);
      },
    };
  }

  public getHostStats(): HostClientStatsSnapshot {
    return {
      inFlightInputBytes: this.inFlightInputBytes,
      inFlightInputBatches: this.inFlightInputBatches,
      waitingInputBytes: this.waitingInputBytes,
      waitingInputBatches: this.waitingInputBatches,
      totalRetainedInputBytes: this.inFlightInputBytes + this.waitingInputBytes,
      peakInFlightInputBytes: this.peakInFlightInputBytes,
      peakInFlightInputBatches: this.peakInFlightInputBatches,
      peakWaitingInputBytes: this.peakWaitingInputBytes,
      peakRetainedInputBytes: this.peakRetainedInputBytes,
      hostBackpressureWaits: this.hostBackpressureWaits,
      hostBackpressureRejects: this.hostBackpressureRejects,
      inFlightQueryCount: this.inFlightQueryCount,
      peakInFlightQueryCount: this.peakInFlightQueryCount,
      hostQueryLimitRejects: this.hostQueryLimitRejects,
      pendingRequests: this.pending.size,
      activeCancelSlots: this.activeCancelTokens.size,
      closed: this.closed,
    };
  }

  public async createRecording(options: {
    recordingDir: string;
    recordId: string;
    identity: TraceReconstructionIdentity;
    decoderOptions?: SystemViewDecoderOptions;
    symbolMap?: TraceSymbolMap;
    limits?: Partial<TraceStorageLimits>;
    commitOnEachIngest?: boolean;
  }): Promise<TraceStorageResult<TraceStorageStats>> {
    const res = await this.sendRaw({
      reqId: this.nextReqId++,
      type: 'createRecording',
      ...options,
    });
    return this.toResult(res);
  }

  public async openRecording(options: {
    recordingDir: string;
    recordId?: string;
    limits?: Partial<TraceStorageLimits>;
    verifyRawSha256?: boolean;
  }): Promise<TraceStorageResult<OpenRecordingWorkerResult>> {
    const res = await this.sendRaw({
      reqId: this.nextReqId++,
      type: 'openRecording',
      ...options,
    });
    return this.toResult(res);
  }

  public async inspectRecording(
    recordingDir: string,
    verifyRawSha256 = true,
  ): Promise<TraceStorageResult<RecordingInspectionResult>> {
    const res = await this.sendRaw({
      reqId: this.nextReqId++,
      type: 'inspectRecording',
      recordingDir,
      verifyRawSha256,
    });
    return this.toResult(res);
  }

  private canAcceptInputAtLowWater(bytes: number): boolean {
    return (
      this.inFlightInputBytes <= this.limits.inputLowWaterMarkBytes &&
      this.inFlightInputBytes + bytes <= this.limits.maxInputQueueBytes &&
      this.inFlightInputBatches + 1 <= this.limits.maxInputQueueBatches
    );
  }

  private tryReserveInFlightInput(bytes: number): boolean {
    if (
      this.inFlightInputBytes + bytes > this.limits.maxInputQueueBytes ||
      this.inFlightInputBatches + 1 > this.limits.maxInputQueueBatches
    ) {
      return false;
    }
    this.inFlightInputBytes += bytes;
    this.inFlightInputBatches += 1;
    this.updateRetainedPeaks();
    return true;
  }

  private releaseInFlightInput(bytes: number): void {
    this.inFlightInputBytes = Math.max(0, this.inFlightInputBytes - bytes);
    this.inFlightInputBatches = Math.max(0, this.inFlightInputBatches - 1);
    if (this.inFlightInputBytes <= this.limits.inputLowWaterMarkBytes) {
      this.wakeDrainWaiters();
    }
  }

  public async waitForInputDrain(timeoutMs = 10000, queuedBytes = 0): Promise<boolean> {
    if (this.canAcceptInputAtLowWater(queuedBytes)) {
      return true;
    }
    if (this.closed || this.workerExited) {
      return false;
    }
    if (
      this.drainWaiters.length >= this.maxInputWaiters ||
      this.waitingInputBytes + queuedBytes > this.maxInputWaiterBytes
    ) {
      return false;
    }

    this.waitingInputBytes += queuedBytes;
    this.waitingInputBatches += 1;
    this.updateRetainedPeaks();

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const releaseWaiting = () => {
        this.waitingInputBytes = Math.max(0, this.waitingInputBytes - queuedBytes);
        this.waitingInputBatches = Math.max(0, this.waitingInputBatches - 1);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const idx = this.drainWaiters.indexOf(onWake);
        if (idx >= 0) this.drainWaiters.splice(idx, 1);
        releaseWaiting();
        resolve(false);
      }, timeoutMs);
      const onWake = () => {
        if (settled) return;
        if (this.closed || this.workerExited) {
          settled = true;
          clearTimeout(timer);
          releaseWaiting();
          resolve(false);
          return;
        }
        if (this.canAcceptInputAtLowWater(queuedBytes)) {
          settled = true;
          clearTimeout(timer);
          releaseWaiting();
          resolve(true);
        } else {
          this.drainWaiters.push(onWake);
        }
      };
      this.drainWaiters.push(onWake);
    });
  }

  private async waitAndReserveInFlightInput(bytes: number, timeoutMs: number): Promise<boolean> {
    if (this.tryReserveInFlightInput(bytes)) {
      return true;
    }
    if (this.closed || this.workerExited) {
      return false;
    }
    if (
      this.drainWaiters.length >= this.maxInputWaiters ||
      this.waitingInputBytes + bytes > this.maxInputWaiterBytes
    ) {
      return false;
    }

    this.waitingInputBytes += bytes;
    this.waitingInputBatches += 1;
    this.updateRetainedPeaks();

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const releaseWaiting = () => {
        this.waitingInputBytes = Math.max(0, this.waitingInputBytes - bytes);
        this.waitingInputBatches = Math.max(0, this.waitingInputBatches - 1);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const idx = this.drainWaiters.indexOf(onWake);
        if (idx >= 0) this.drainWaiters.splice(idx, 1);
        releaseWaiting();
        resolve(false);
      }, timeoutMs);
      const onWake = () => {
        if (settled) return;
        if (this.closed || this.workerExited) {
          settled = true;
          clearTimeout(timer);
          releaseWaiting();
          resolve(false);
          return;
        }
        if (this.inFlightInputBytes <= this.limits.inputLowWaterMarkBytes && this.tryReserveInFlightInput(bytes)) {
          settled = true;
          clearTimeout(timer);
          releaseWaiting();
          resolve(true);
        } else {
          this.drainWaiters.push(onWake);
        }
      };
      this.drainWaiters.push(onWake);
    });
  }

  private async sendReservedIngestChunk(params: {
    recordId: string;
    sessionId: string;
    sessionGeneration: number;
    bootGeneration?: number;
    batchSequence?: number;
    chunk: Uint8Array;
    flush?: boolean;
  }): Promise<TraceStorageResult<IngestBatchSummary> & { backpressure?: boolean }> {
    const len = params.chunk.length;
    try {
      const res = await this.sendRaw({
        reqId: this.nextReqId++,
        type: 'ingestChunk',
        ...params,
      });
      if (!res.ok) {
        return {
          ok: false,
          errorCode: res.errorCode as any,
          message: res.message,
          backpressure: res.backpressure,
          diagnostics: res.diagnostics,
        };
      }
      return { ok: true, data: res.data as IngestBatchSummary };
    } finally {
      this.releaseInFlightInput(len);
    }
  }

  /**
   * 非阻塞背压写入：若宿主机侧在途队列达上限，立即返回 `backpressure: true`，绝不无限积压。
   */
  public async tryIngestChunk(params: {
    recordId: string;
    sessionId: string;
    sessionGeneration: number;
    bootGeneration?: number;
    batchSequence?: number;
    chunk: Uint8Array;
    flush?: boolean;
  }): Promise<TraceStorageResult<IngestBatchSummary> & { backpressure?: boolean }> {
    const len = params.chunk.length;
    if (len > this.limits.maxSingleBatchBytes) {
      return {
        ok: false,
        errorCode: 'BatchLimitExceeded',
        message: `单批字节 ${len} 超过上限 ${this.limits.maxSingleBatchBytes}`,
      };
    }
    if (!this.tryReserveInFlightInput(len)) {
      this.hostBackpressureRejects += 1;
      return {
        ok: false,
        backpressure: true,
        errorCode: 'WriteQueueFull',
        message: `宿主机输入队列已满 (bytes=${this.inFlightInputBytes}/${this.limits.maxInputQueueBytes}, batches=${this.inFlightInputBatches}/${this.limits.maxInputQueueBatches})`,
      };
    }
    return this.sendReservedIngestChunk(params);
  }

  /**
   * 带有限等待预算的背压写入：等待队列未满时纳入真实保留量，超出等待预算立即拒绝且不保留输入引用。
   */
  public async ingestChunk(params: {
    recordId: string;
    sessionId: string;
    sessionGeneration: number;
    bootGeneration?: number;
    batchSequence?: number;
    chunk: Uint8Array;
    flush?: boolean;
    backpressureTimeoutMs?: number;
  }): Promise<TraceStorageResult<IngestBatchSummary> & { backpressure?: boolean }> {
    const len = params.chunk.length;
    if (len > this.limits.maxSingleBatchBytes) {
      return {
        ok: false,
        errorCode: 'BatchLimitExceeded',
        message: `单批字节 ${len} 超过上限 ${this.limits.maxSingleBatchBytes}`,
      };
    }
    if (this.tryReserveInFlightInput(len)) {
      return this.sendReservedIngestChunk(params);
    }
    this.hostBackpressureWaits += 1;
    const reserved = await this.waitAndReserveInFlightInput(len, params.backpressureTimeoutMs ?? 10000);
    if (!reserved) {
      this.hostBackpressureRejects += 1;
      return {
        ok: false,
        backpressure: true,
        errorCode: 'WriteQueueFull',
        message: '等待输入队列回落超时或等待队列已满，触发背压拒绝',
      };
    }
    return this.sendReservedIngestChunk(params);
  }

  public async ingestDecoded(params: {
    recordId: string;
    decodeBatch: SystemViewDecodeBatch;
    reconBatch: TraceReconstructBatch;
    rawChunk?: Uint8Array;
    flush?: boolean;
    backpressureTimeoutMs?: number;
  }): Promise<TraceStorageResult<IngestBatchSummary> & { backpressure?: boolean }> {
    const estBytes = estimateDecodedBatchBytes(params.decodeBatch, params.reconBatch, params.rawChunk);
    if (estBytes > this.limits.maxSingleBatchBytes) {
      return {
        ok: false,
        errorCode: 'BatchLimitExceeded',
        message: `单批解码/重建估算字节 ${estBytes} 超过上限 ${this.limits.maxSingleBatchBytes}`,
      };
    }
    let reserved = this.tryReserveInFlightInput(estBytes);
    if (!reserved) {
      this.hostBackpressureWaits += 1;
      reserved = await this.waitAndReserveInFlightInput(estBytes, params.backpressureTimeoutMs ?? 10000);
      if (!reserved) {
        this.hostBackpressureRejects += 1;
        return {
          ok: false,
          backpressure: true,
          errorCode: 'WriteQueueFull',
          message: 'ingestDecoded 触发宿主机背压预算上限，拒绝继续积压',
        };
      }
    }
    try {
      const res = await this.sendRaw({
        reqId: this.nextReqId++,
        type: 'ingestDecoded',
        recordId: params.recordId,
        decodeBatch: params.decodeBatch,
        reconBatch: params.reconBatch,
        rawChunk: params.rawChunk,
        flush: params.flush,
      });
      if (!res.ok) {
        return {
          ok: false,
          errorCode: res.errorCode as any,
          message: res.message,
          backpressure: res.backpressure,
          diagnostics: res.diagnostics,
        };
      }
      return { ok: true, data: res.data as IngestBatchSummary };
    } finally {
      this.releaseInFlightInput(estBytes);
    }
  }

  public async markGap(params: {
    recordId: string;
    sessionId: string;
    sessionGeneration: number;
    gap: TraceGapInput;
  }): Promise<TraceStorageResult<IngestBatchSummary>> {
    const res = await this.sendRaw({
      reqId: this.nextReqId++,
      type: 'markGap',
      ...params,
    });
    return this.toResult(res);
  }

  public async notifyTargetReset(params: {
    recordId: string;
    sessionId: string;
    sessionGeneration: number;
    nextBootGeneration?: number;
    reason?: string;
  }): Promise<TraceStorageResult<IngestBatchSummary>> {
    const res = await this.sendRaw({
      reqId: this.nextReqId++,
      type: 'notifyTargetReset',
      ...params,
    });
    return this.toResult(res);
  }

  public async flushRecording(
    recordId: string,
  ): Promise<TraceStorageResult<{ commitSeq: number; committedRawBytes: number }>> {
    const res = await this.sendRaw({
      reqId: this.nextReqId++,
      type: 'flushRecording',
      recordId,
    });
    return this.toResult(res);
  }

  public async finishRecording(
    recordId: string,
    reason?: string,
    options?: {
      terminalState?: 'completed' | 'interrupted' | 'failed';
      failureCode?: string;
      diagnostics?: Record<string, unknown>;
    },
  ): Promise<TraceStorageResult<TraceRecordingManifest>> {
    const res = await this.sendRaw({
      reqId: this.nextReqId++,
      type: 'finishRecording',
      recordId,
      reason,
      ...(options?.terminalState ? { terminalState: options.terminalState } : {}),
      ...(options?.failureCode ? { failureCode: options.failureCode } : {}),
      ...(options?.diagnostics ? { diagnostics: options.diagnostics } : {}),
    });
    return this.toResult(res);
  }

  public async closeRecording(recordId: string): Promise<TraceStorageResult<{ closed: boolean; alreadyClosed: boolean }>> {
    const res = await this.sendRaw({
      reqId: this.nextReqId++,
      type: 'closeRecording',
      recordId,
    });
    return this.toResult(res);
  }

  private tryAcquireQuerySlot(): boolean {
    if (this.inFlightQueryCount >= this.limits.maxPendingQueries) {
      this.hostQueryLimitRejects += 1;
      return false;
    }
    this.inFlightQueryCount += 1;
    if (this.inFlightQueryCount > this.peakInFlightQueryCount) {
      this.peakInFlightQueryCount = this.inFlightQueryCount;
    }
    return true;
  }

  private releaseQuerySlot(): void {
    this.inFlightQueryCount = Math.max(0, this.inFlightQueryCount - 1);
  }

  public async queryRange<T = unknown>(
    recordId: string,
    request: TraceRangeQueryRequest,
    options: {
      signal?: AbortSignal;
      yieldEveryPages?: number;
      yieldEveryItems?: number;
      queryId?: string;
    } = {},
  ): Promise<TraceStorageResult<TraceRangeQueryResult<T>>> {
    if (options.signal?.aborted) {
      return { ok: false, errorCode: 'QueryCancelled', cancelled: true, message: '查询在发送前已取消' };
    }
    if (!this.tryAcquireQuerySlot()) {
      return {
        ok: false,
        errorCode: 'QueryQueueFull' as any,
        message: `宿主机并发查询数已达上限 ${this.limits.maxPendingQueries}`,
      };
    }
    const queryId = options.queryId ?? `q-${this.nextSeqId++}`;
    const slotGuard = this.acquireCancelSlot();

    const onAbort = () => {
      slotGuard.cancel();
      void this.cancelQuery(queryId).catch(() => {});
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const clampedRequest: TraceRangeQueryRequest = {
        ...request,
        limit:
          request.limit !== undefined
            ? Math.min(this.limits.maxResultItems, Math.max(1, request.limit))
            : this.limits.maxResultItems,
      };
      const res = await this.sendRaw({
        reqId: this.nextReqId++,
        type: 'queryRange',
        recordId,
        queryId,
        request: clampedRequest,
        cancelSlot: slotGuard.slot,
        cancelToken: slotGuard.token,
        yieldEveryPages: options.yieldEveryPages,
        yieldEveryItems: options.yieldEveryItems,
      });
      return this.toResult(res);
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
      slotGuard.release();
      this.releaseQuerySlot();
    }
  }

  public async queryLod(
    recordId: string,
    request: TraceLodQueryRequest,
    options: { signal?: AbortSignal; queryId?: string } = {},
  ): Promise<TraceStorageResult<TraceLodQueryResult>> {
    if (options.signal?.aborted) {
      return { ok: false, errorCode: 'QueryCancelled', cancelled: true, message: 'LOD 查询在发送前已取消' };
    }
    if (!this.tryAcquireQuerySlot()) {
      return {
        ok: false,
        errorCode: 'QueryQueueFull' as any,
        message: `宿主机并发查询数已达上限 ${this.limits.maxPendingQueries}`,
      };
    }
    const queryId = options.queryId ?? `lod-${this.nextSeqId++}`;
    const slotGuard = this.acquireCancelSlot();
    const onAbort = () => {
      slotGuard.cancel();
      void this.cancelQuery(queryId).catch(() => {});
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const res = await this.sendRaw({
        reqId: this.nextReqId++,
        type: 'queryLod',
        recordId,
        queryId,
        request,
        cancelSlot: slotGuard.slot,
        cancelToken: slotGuard.token,
      });
      return this.toResult(res);
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
      slotGuard.release();
      this.releaseQuerySlot();
    }
  }

  public async queryAnalysis(
    recordId: string,
    request: TraceAnalysisQueryRequest,
    options: {
      signal?: AbortSignal;
      yieldEveryPages?: number;
      yieldEveryItems?: number;
      queryId?: string;
    } = {},
  ): Promise<TraceStorageResult<TraceAnalysisQueryResult>> {
    if (options.signal?.aborted) {
      return { ok: false, errorCode: 'QueryCancelled', cancelled: true, message: '统计分析查询在发送前已取消' };
    }
    if (!this.tryAcquireQuerySlot()) {
      return {
        ok: false,
        errorCode: 'QueryQueueFull' as any,
        message: `宿主机并发查询数已达上限 ${this.limits.maxPendingQueries}`,
      };
    }
    const queryId = options.queryId ?? `ana-${this.nextSeqId++}`;
    const slotGuard = this.acquireCancelSlot();
    const onAbort = () => {
      slotGuard.cancel();
      void this.cancelQuery(queryId).catch(() => {});
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const res = await this.sendRaw({
        reqId: this.nextReqId++,
        type: 'queryAnalysis',
        recordId,
        queryId,
        request,
        cancelSlot: slotGuard.slot,
        cancelToken: slotGuard.token,
        yieldEveryPages: options.yieldEveryPages,
        yieldEveryItems: options.yieldEveryItems,
      });
      return this.toResult(res);
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
      slotGuard.release();
      this.releaseQuerySlot();
    }
  }

  public async cancelQuery(queryId: string): Promise<TraceStorageResult<{ cancelled: boolean; active: boolean }>> {
    const res = await this.sendRaw({
      reqId: this.nextReqId++,
      type: 'cancelQuery',
      queryId,
    });
    return this.toResult(res);
  }

  public async exportRawToFile(
    recordId: string,
    outputPath: string,
    options: { signal?: AbortSignal; verifyChunkCrc32?: boolean } = {},
  ): Promise<TraceStorageResult<{ exportedBytes: number; sha256: string }>> {
    if (options.signal?.aborted) {
      return { ok: false, errorCode: 'QueryCancelled', cancelled: true, message: '导出在发送前已取消' };
    }
    if (!this.tryAcquireQuerySlot()) {
      return {
        ok: false,
        errorCode: 'QueryQueueFull' as any,
        message: `宿主机并发查询/导出数已达上限 ${this.limits.maxPendingQueries}`,
      };
    }
    const queryId = `exp-${this.nextSeqId++}`;
    const slotGuard = this.acquireCancelSlot();
    const onAbort = () => {
      slotGuard.cancel();
      void this.cancelQuery(queryId).catch(() => {});
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await this.sendRaw({
        reqId: this.nextReqId++,
        type: 'exportRawToFile',
        recordId,
        queryId,
        outputPath,
        cancelSlot: slotGuard.slot,
        cancelToken: slotGuard.token,
        verifyChunkCrc32: options.verifyChunkCrc32,
      });
      return this.toResult(res);
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
      slotGuard.release();
      this.releaseQuerySlot();
    }
  }

  /**
   * 拉模式原始字节流导出：每次 `pull()` 仅由 Worker 读取并发送 1 个有界分块，慢消费者不会引发积压。
   */
  public async openRawExportStream(
    recordId: string,
    options: { chunkBytes?: number } = {},
  ): Promise<TraceStorageResult<WorkerRawExportStreamHandle>> {
    const streamId = `raw-stream-${this.nextSeqId++}`;
    const startRes = await this.sendRaw({
      reqId: this.nextReqId++,
      type: 'startRawExportStream',
      recordId,
      streamId,
      chunkBytes: options.chunkBytes,
    });
    if (!startRes.ok) {
      return this.toResult(startRes);
    }
    const info = startRes.data as { streamId: string; totalBytes: number; chunkBytes: number };
    let closed = false;

    const handle: WorkerRawExportStreamHandle = {
      streamId: info.streamId,
      totalBytes: info.totalBytes,
      chunkBytes: info.chunkBytes,
      pull: async () => {
        if (closed) {
          return { ok: false, errorCode: 'RecordingClosed', message: '导出流已关闭' };
        }
        const res = await this.sendRaw({
          reqId: this.nextReqId++,
          type: 'pullRawExportStream',
          streamId: info.streamId,
        });
        return this.toResult(res);
      },
      close: async () => {
        if (closed) {
          return;
        }
        closed = true;
        if (!this.closed && !this.workerExited) {
          await this.sendRaw({
            reqId: this.nextReqId++,
            type: 'closeRawExportStream',
            streamId: info.streamId,
          }).catch(() => {});
        }
      },
    };
    return { ok: true, data: handle };
  }

  public async getSegments(recordId: string): Promise<TraceStorageResult<readonly SegmentIndexMetadata[]>> {
    const res = await this.sendRaw({ reqId: this.nextReqId++, type: 'getSegments', recordId });
    return this.toResult(res);
  }

  public async getGaps(recordId: string): Promise<TraceStorageResult<readonly StoredGapEntry[]>> {
    const res = await this.sendRaw({ reqId: this.nextReqId++, type: 'getGaps', recordId });
    return this.toResult(res);
  }

  public async getStats(recordId?: string): Promise<TraceStorageResult<TraceWorkerStatsSnapshot>> {
    const res = await this.sendRaw({ reqId: this.nextReqId++, type: 'getStats', recordId });
    return this.toResult(res);
  }

  /**
   * 幂等有序关闭 Worker：通知 Worker 取消查询并关闭所有录制句柄，超时后兜底终止。
   */
  public async shutdown(reason = 'host-shutdown'): Promise<{ exitCode: number; forced: boolean }> {
    if (this.closed) {
      const code = await this.exitPromise;
      return { exitCode: code, forced: false };
    }
    if (!this.workerExited) {
      await Promise.race([
        this.sendRaw({ reqId: this.nextReqId++, type: 'shutdown', reason }).catch(() => {}),
        new Promise<void>((resolve) => setTimeout(resolve, this.shutdownTimeoutMs)),
      ]);
    }
    this.closed = true;
    this.wakeDrainWaiters();

    let forced = false;
    const exitOrTimeout = await Promise.race([
      this.exitPromise.then((code) => ({ timedOut: false as const, code })),
      new Promise<{ timedOut: true }>((resolve) =>
        setTimeout(() => resolve({ timedOut: true }), Math.min(1000, this.shutdownTimeoutMs)),
      ),
    ]);

    if (exitOrTimeout.timedOut) {
      forced = true;
      const termCode = await this.worker.terminate();
      return { exitCode: termCode, forced };
    }
    return { exitCode: exitOrTimeout.code, forced };
  }
}

export { DEFAULT_TRACE_WORKER_LIMITS };
