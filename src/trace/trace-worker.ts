import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { inspectRecordingDirectory, ORBIT_TRACE_FILES, TraceFileHandle, defaultTraceFileSystem } from './trace-format';
import {
  TraceQueryCancelToken,
  TraceRecordingStore,
  TraceStorageLimits,
  TraceStorageResult,
} from './trace-recording-store';
import {
  estimateDecodedBatchBytes,
  OpenRecordingWorkerResult,
  PullRawStreamResult,
  resolveTraceWorkerLimits,
  TraceWorkerInitData,
  TraceWorkerLimits,
  TraceWorkerMessage,
  TraceWorkerRequest,
  TraceWorkerStatsSnapshot,
} from './trace-worker-protocol';

interface QueuedIngestTask {
  readonly byteSize: number;
  readonly run: () => Promise<void>;
}

interface WorkerRecordSlot {
  readonly recordId: string;
  readonly store: TraceRecordingStore;
  readonly queue: QueuedIngestTask[];
  pumping: boolean;
  finishing: boolean;
  finished: boolean;
  closing: boolean;
  progressInFlight: boolean;
  progressDirty: boolean;
}

interface ActiveQueryEntry {
  readonly queryId: string;
  readonly recordId: string;
  readonly controller: AbortController;
}

interface RawExportStreamState {
  readonly streamId: string;
  readonly recordId: string;
  readonly totalBytes: number;
  readonly chunkBytes: number;
  readonly rawPath: string;
  handle: TraceFileHandle | null;
  offset: number;
  closed: boolean;
  pulling: boolean;
}

export class TraceWorkerRuntime {
  private readonly limits: TraceWorkerLimits;
  private readonly cancelView: Int32Array | null;
  private readonly post: (msg: TraceWorkerMessage) => void;

  private readonly records = new Map<string, WorkerRecordSlot>();
  private readonly activeQueries = new Map<string, ActiveQueryEntry>();
  private readonly rawStreams = new Map<string, RawExportStreamState>();

  private pendingInputBytes = 0;
  private pendingInputBatches = 0;
  private peakInputQueueBytes = 0;
  private peakInputQueueBatches = 0;
  private peakQueryQueueCount = 0;
  private rejectedBackpressureCount = 0;
  private rejectedQueryLimitCount = 0;
  private highWaterReached = false;
  private shuttingDown = false;

  public constructor(
    initData: TraceWorkerInitData | undefined,
    post: (msg: TraceWorkerMessage) => void,
  ) {
    this.limits = resolveTraceWorkerLimits(initData?.limits);
    this.cancelView = initData?.cancelBuffer ? new Int32Array(initData.cancelBuffer) : null;
    this.post = post;
  }

  private replyOk(reqId: number, data: unknown): void {
    this.post({ kind: 'response', reqId, ok: true, data });
  }

  private replyErr(
    reqId: number,
    errorCode: string,
    message: string,
    extra: { backpressure?: boolean; cancelled?: boolean; diagnostics?: Record<string, unknown> } = {},
  ): void {
    this.post({
      kind: 'response',
      reqId,
      ok: false,
      errorCode,
      message,
      ...extra,
    });
  }

  private replyFromStoreResult<T>(reqId: number, res: TraceStorageResult<T>): void {
    if (res.ok) {
      this.replyOk(reqId, res.data);
    } else {
      this.replyErr(reqId, res.errorCode, res.message, {
        cancelled: res.cancelled,
        diagnostics: res.diagnostics,
      });
    }
  }

  private mergeStorageLimits(override?: Partial<TraceStorageLimits>): Partial<TraceStorageLimits> {
    return {
      ...this.limits.storageLimits,
      ...override,
      maxSingleBatchBytes: override?.maxSingleBatchBytes ?? this.limits.maxSingleBatchBytes,
      maxQueryResultItems: Math.min(
        this.limits.maxResultItems,
        override?.maxQueryResultItems ?? this.limits.maxResultItems,
      ),
      maxQueryResultBytes: Math.min(
        this.limits.maxResultBytes,
        override?.maxQueryResultBytes ?? this.limits.maxResultBytes,
      ),
    };
  }

  private maybeEmitProgress(slot: WorkerRecordSlot): void {
    if (slot.closing || slot.store.isClosed()) {
      return;
    }
    if (slot.progressInFlight) {
      slot.progressDirty = true;
      return;
    }
    const stats = slot.store.getStats();
    slot.progressInFlight = true;
    slot.progressDirty = false;
    this.post({
      kind: 'event',
      event: 'progress',
      recordId: slot.recordId,
      committedRawBytes: stats.committed.rawBytes,
      packetCount: stats.committed.packetCount,
      sliceCount: stats.committed.sliceCount,
      gapCount: stats.committed.gapCount,
    });
  }

  private enqueueRecordIngest(
    reqId: number,
    slot: WorkerRecordSlot,
    byteSize: number,
    run: () => Promise<void>,
  ): boolean {
    if (byteSize > this.limits.maxSingleBatchBytes) {
      this.replyErr(
        reqId,
        'BatchLimitExceeded',
        `单批字节 ${byteSize} 超过 worker 上限 ${this.limits.maxSingleBatchBytes}`,
      );
      return false;
    }
    if (
      this.pendingInputBytes + byteSize > this.limits.maxInputQueueBytes ||
      this.pendingInputBatches + 1 > this.limits.maxInputQueueBatches
    ) {
      this.rejectedBackpressureCount += 1;
      this.highWaterReached = true;
      this.replyErr(
        reqId,
        'WorkerInputQueueFull',
        `Worker 输入队列已满 (bytes=${this.pendingInputBytes}/${this.limits.maxInputQueueBytes}, batches=${this.pendingInputBatches}/${this.limits.maxInputQueueBatches})`,
        { backpressure: true },
      );
      return false;
    }

    this.pendingInputBytes += byteSize;
    this.pendingInputBatches += 1;
    if (this.pendingInputBytes > this.peakInputQueueBytes) {
      this.peakInputQueueBytes = this.pendingInputBytes;
    }
    if (this.pendingInputBatches > this.peakInputQueueBatches) {
      this.peakInputQueueBatches = this.pendingInputBatches;
    }
    if (this.pendingInputBytes >= this.limits.inputLowWaterMarkBytes) {
      this.highWaterReached = true;
    }

    slot.queue.push({ byteSize, run });
    if (!slot.pumping) {
      void this.pumpRecordQueue(slot);
    }
    return true;
  }

  private async pumpRecordQueue(slot: WorkerRecordSlot): Promise<void> {
    if (slot.pumping) {
      return;
    }
    slot.pumping = true;
    try {
      while (slot.queue.length > 0) {
        const task = slot.queue.shift()!;
        try {
          await task.run();
        } finally {
          this.pendingInputBytes = Math.max(0, this.pendingInputBytes - task.byteSize);
          this.pendingInputBatches = Math.max(0, this.pendingInputBatches - 1);
          if (this.highWaterReached && this.pendingInputBytes <= this.limits.inputLowWaterMarkBytes) {
            this.highWaterReached = false;
            this.post({
              kind: 'event',
              event: 'drain',
              pendingInputBytes: this.pendingInputBytes,
              pendingInputBatches: this.pendingInputBatches,
            });
          }
        }
        // 在批与批之间让出事件循环，保证查询取消与控制消息能及时调度
        await new Promise((resolve) => setImmediate(resolve));
      }
    } finally {
      slot.pumping = false;
    }
  }

  private async drainSlotQueue(slot: WorkerRecordSlot): Promise<void> {
    while (slot.pumping || slot.queue.length > 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  private cancelQueriesForRecord(recordId: string): void {
    for (const q of this.activeQueries.values()) {
      if (q.recordId === recordId) {
        q.controller.abort();
      }
    }
  }

  private async closeRawStreamsForRecord(recordId: string): Promise<void> {
    const targets: RawExportStreamState[] = [];
    for (const st of this.rawStreams.values()) {
      if (st.recordId === recordId) {
        targets.push(st);
      }
    }
    for (const st of targets) {
      await this.closeRawStreamInternal(st.streamId);
    }
  }

  private async closeRawStreamInternal(streamId: string): Promise<void> {
    const st = this.rawStreams.get(streamId);
    if (!st || st.closed) {
      this.rawStreams.delete(streamId);
      return;
    }
    st.closed = true;
    this.rawStreams.delete(streamId);
    const h = st.handle;
    st.handle = null;
    if (h) {
      await h.close().catch(() => {});
    }
  }

  private buildCancelToken(
    queryId: string,
    recordId: string,
    cancelSlot?: number,
    cancelToken?: number,
    yieldEveryPages?: number,
    yieldEveryItems?: number,
  ): { ok: true; token: TraceQueryCancelToken; cleanup: () => void } | { ok: false } {
    if (this.activeQueries.size >= this.limits.maxPendingQueries) {
      this.rejectedQueryLimitCount += 1;
      return { ok: false };
    }
    const controller = new AbortController();
    this.activeQueries.set(queryId, { queryId, recordId, controller });
    if (this.activeQueries.size > this.peakQueryQueueCount) {
      this.peakQueryQueueCount = this.activeQueries.size;
    }
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      this.activeQueries.delete(queryId);
    };

    const token: TraceQueryCancelToken = {
      signal: controller.signal,
      cancelBuffer: this.cancelView ?? undefined,
      cancelIndex: cancelSlot,
      expectedCancelValue: cancelToken,
      yieldEveryPages: yieldEveryPages ?? 1,
      yieldEveryItems: yieldEveryItems ?? 512,
    };
    return { ok: true, token, cleanup };
  }

  public getStatsSnapshot(recordId?: string): TraceWorkerStatsSnapshot {
    const recordsObj: Record<string, ReturnType<TraceRecordingStore['getStats']>> = {};
    if (recordId !== undefined) {
      const slot = this.records.get(recordId);
      if (slot) {
        recordsObj[recordId] = slot.store.getStats();
      }
    } else {
      for (const [id, slot] of this.records.entries()) {
        recordsObj[id] = slot.store.getStats();
      }
    }
    return {
      openRecordCount: this.records.size,
      pendingInputBytes: this.pendingInputBytes,
      pendingInputBatches: this.pendingInputBatches,
      peakInputQueueBytes: this.peakInputQueueBytes,
      peakInputQueueBatches: this.peakInputQueueBatches,
      activeQueryCount: this.activeQueries.size,
      pendingQueryCount: this.activeQueries.size,
      peakQueryQueueCount: this.peakQueryQueueCount,
      activeRawStreamCount: this.rawStreams.size,
      rejectedBackpressureCount: this.rejectedBackpressureCount,
      rejectedQueryLimitCount: this.rejectedQueryLimitCount,
      limits: this.limits,
      records: recordsObj,
    };
  }

  public async handleMessage(msg: TraceWorkerRequest): Promise<void> {
    if (this.shuttingDown && msg.type !== 'shutdown') {
      this.replyErr(msg.reqId, 'WorkerShuttingDown', 'Trace Worker 正在关闭，拒绝新请求');
      return;
    }

    try {
      switch (msg.type) {
        case 'createRecording': {
          if (this.records.has(msg.recordId)) {
            this.replyErr(msg.reqId, 'RecordAlreadyOpen', `recordId=${msg.recordId} 已打开，禁止重复创建`);
            return;
          }
          if (this.records.size >= this.limits.maxOpenRecords) {
            this.replyErr(msg.reqId, 'MaxOpenRecordsReached', `打开录制数已达上限 ${this.limits.maxOpenRecords}`);
            return;
          }
          const store = await TraceRecordingStore.create({
            recordingDir: msg.recordingDir,
            recordId: msg.recordId,
            identity: msg.identity,
            decoderOptions: msg.decoderOptions,
            symbolMap: msg.symbolMap,
            limits: this.mergeStorageLimits(msg.limits),
            commitOnEachIngest: msg.commitOnEachIngest,
          });
          this.records.set(msg.recordId, {
            recordId: msg.recordId,
            store,
            queue: [],
            pumping: false,
            finishing: false,
            finished: false,
            closing: false,
            progressInFlight: false,
            progressDirty: false,
          });
          this.replyOk(msg.reqId, store.getStats());
          return;
        }

        case 'openRecording': {
          if (this.records.size >= this.limits.maxOpenRecords) {
            this.replyErr(msg.reqId, 'MaxOpenRecordsReached', `打开录制数已达上限 ${this.limits.maxOpenRecords}`);
            return;
          }
          const { store, inspection } = await TraceRecordingStore.open({
            recordingDir: msg.recordingDir,
            limits: this.mergeStorageLimits(msg.limits),
            verifyRawSha256: msg.verifyRawSha256,
          });
          const effectiveRecordId = msg.recordId ?? store.recordId;
          if (this.records.has(effectiveRecordId)) {
            await store.close();
            this.replyErr(msg.reqId, 'RecordAlreadyOpen', `recordId=${effectiveRecordId} 已打开`);
            return;
          }
          this.records.set(effectiveRecordId, {
            recordId: effectiveRecordId,
            store,
            queue: [],
            pumping: false,
            finishing: false,
            finished: true,
            closing: false,
            progressInFlight: false,
            progressDirty: false,
          });
          const payload: OpenRecordingWorkerResult = {
            recordId: effectiveRecordId,
            inspection,
            stats: store.getStats(),
          };
          this.replyOk(msg.reqId, payload);
          return;
        }

        case 'ingestChunk': {
          const slot = this.records.get(msg.recordId);
          if (!slot || slot.closing || slot.finishing || slot.finished) {
            this.replyErr(msg.reqId, 'RecordNotFound', `未找到可写入录制 recordId=${msg.recordId}`);
            return;
          }
          this.enqueueRecordIngest(msg.reqId, slot, msg.chunk.length, async () => {
            const res = await slot.store.ingestRawChunk(msg.chunk, {
              recordId: msg.recordId,
              sessionId: msg.sessionId,
              sessionGeneration: msg.sessionGeneration,
              bootGeneration: msg.bootGeneration,
              batchSequence: msg.batchSequence,
              flush: msg.flush,
            });
            if (res.ok) {
              this.maybeEmitProgress(slot);
            }
            this.replyFromStoreResult(msg.reqId, res);
          });
          return;
        }

        case 'ingestDecoded': {
          const slot = this.records.get(msg.recordId);
          if (!slot || slot.closing || slot.finishing || slot.finished) {
            this.replyErr(msg.reqId, 'RecordNotFound', `未找到可写入录制 recordId=${msg.recordId}`);
            return;
          }
          const byteSize = estimateDecodedBatchBytes(msg.decodeBatch, msg.reconBatch, msg.rawChunk);
          this.enqueueRecordIngest(msg.reqId, slot, byteSize, async () => {
            const res = await slot.store.ingestDecodedBatches(
              msg.decodeBatch,
              msg.reconBatch,
              msg.rawChunk,
              msg.flush,
            );
            if (res.ok) {
              this.maybeEmitProgress(slot);
            }
            this.replyFromStoreResult(msg.reqId, res);
          });
          return;
        }

        case 'markGap': {
          const slot = this.records.get(msg.recordId);
          if (!slot || slot.closing || slot.finishing || slot.finished) {
            this.replyErr(msg.reqId, 'RecordNotFound', `未找到可写入录制 recordId=${msg.recordId}`);
            return;
          }
          const id = slot.store.getIdentity();
          if (id.sessionId !== msg.sessionId || id.sessionGeneration !== msg.sessionGeneration) {
            this.replyErr(msg.reqId, 'SessionChanged', 'markGap 会话身份不匹配');
            return;
          }
          this.enqueueRecordIngest(msg.reqId, slot, 256, async () => {
            const res = await slot.store.markGap(msg.gap);
            if (res.ok) this.maybeEmitProgress(slot);
            this.replyFromStoreResult(msg.reqId, res);
          });
          return;
        }

        case 'notifyTargetReset': {
          const slot = this.records.get(msg.recordId);
          if (!slot || slot.closing || slot.finishing || slot.finished) {
            this.replyErr(msg.reqId, 'RecordNotFound', `未找到可写入录制 recordId=${msg.recordId}`);
            return;
          }
          const id = slot.store.getIdentity();
          if (id.sessionId !== msg.sessionId || id.sessionGeneration !== msg.sessionGeneration) {
            this.replyErr(msg.reqId, 'SessionChanged', 'notifyTargetReset 会话身份不匹配');
            return;
          }
          this.enqueueRecordIngest(msg.reqId, slot, 256, async () => {
            const res = await slot.store.notifyTargetReset(msg.nextBootGeneration, msg.reason);
            if (res.ok) this.maybeEmitProgress(slot);
            this.replyFromStoreResult(msg.reqId, res);
          });
          return;
        }

        case 'flushRecording': {
          const slot = this.records.get(msg.recordId);
          if (!slot || slot.closing || slot.finishing || slot.finished) {
            this.replyErr(msg.reqId, 'RecordNotFound', `未找到可写入录制 recordId=${msg.recordId}`);
            return;
          }
          this.enqueueRecordIngest(msg.reqId, slot, 0, async () => {
            const res = await slot.store.flush();
            this.replyFromStoreResult(msg.reqId, res);
          });
          return;
        }

        case 'finishRecording': {
          const slot = this.records.get(msg.recordId);
          if (!slot || slot.closing || slot.finishing) {
            this.replyErr(msg.reqId, 'RecordNotFound', `未找到活动录制 recordId=${msg.recordId}`);
            return;
          }
          if (slot.finished) {
            this.replyErr(msg.reqId, 'RecordingClosed', `录制 recordId=${msg.recordId} 已完成封存`);
            return;
          }
          slot.finishing = true;
          await this.drainSlotQueue(slot);
          const res = await slot.store.finish(msg.reason);
          slot.finishing = false;
          if (res.ok) {
            slot.finished = true;
          }
          this.replyFromStoreResult(msg.reqId, res);
          return;
        }

        case 'closeRecording': {
          const slot = this.records.get(msg.recordId);
          if (!slot) {
            // 幂等关闭：不报错也不重复 release
            this.replyOk(msg.reqId, { closed: true, alreadyClosed: true });
            return;
          }
          slot.closing = true;
          this.cancelQueriesForRecord(msg.recordId);
          await this.closeRawStreamsForRecord(msg.recordId);
          await this.drainSlotQueue(slot);
          await slot.store.close();
          this.records.delete(msg.recordId);
          this.replyOk(msg.reqId, { closed: true, alreadyClosed: false });
          return;
        }

        case 'inspectRecording': {
          const inspection = await inspectRecordingDirectory(msg.recordingDir, defaultTraceFileSystem, {
            verifyRawSha256: msg.verifyRawSha256,
          });
          this.replyOk(msg.reqId, inspection);
          return;
        }

        case 'queryRange': {
          const slot = this.records.get(msg.recordId);
          if (!slot || slot.closing) {
            this.replyErr(msg.reqId, 'RecordNotFound', `未找到活动录制 recordId=${msg.recordId}`);
            return;
          }
          const guard = this.buildCancelToken(
            msg.queryId,
            msg.recordId,
            msg.cancelSlot,
            msg.cancelToken,
            msg.yieldEveryPages,
            msg.yieldEveryItems,
          );
          if (!guard.ok) {
            this.replyErr(msg.reqId, 'QueryQueueFull', `并发查询数已达上限 ${this.limits.maxPendingQueries}`, {
              backpressure: true,
            });
            return;
          }
          try {
            const res = await slot.store.queryRange(msg.request, guard.token);
            this.replyFromStoreResult(msg.reqId, res);
          } finally {
            guard.cleanup();
          }
          return;
        }

        case 'queryLod': {
          const slot = this.records.get(msg.recordId);
          if (!slot || slot.closing) {
            this.replyErr(msg.reqId, 'RecordNotFound', `未找到活动录制 recordId=${msg.recordId}`);
            return;
          }
          const guard = this.buildCancelToken(msg.queryId, msg.recordId, msg.cancelSlot, msg.cancelToken);
          if (!guard.ok) {
            this.replyErr(msg.reqId, 'QueryQueueFull', `并发查询数已达上限 ${this.limits.maxPendingQueries}`, {
              backpressure: true,
            });
            return;
          }
          try {
            const res = await slot.store.queryLod(msg.request, guard.token);
            this.replyFromStoreResult(msg.reqId, res);
          } finally {
            guard.cleanup();
          }
          return;
        }

        case 'cancelQuery': {
          const q = this.activeQueries.get(msg.queryId);
          if (q) {
            q.controller.abort();
            this.replyOk(msg.reqId, { cancelled: true, active: true });
          } else {
            this.replyOk(msg.reqId, { cancelled: false, active: false });
          }
          return;
        }

        case 'exportRawToFile': {
          const slot = this.records.get(msg.recordId);
          if (!slot || slot.closing) {
            this.replyErr(msg.reqId, 'RecordNotFound', `未找到活动录制 recordId=${msg.recordId}`);
            return;
          }
          const guard = this.buildCancelToken(msg.queryId, msg.recordId, msg.cancelSlot, msg.cancelToken);
          if (!guard.ok) {
            this.replyErr(msg.reqId, 'QueryQueueFull', `并发查询数已达上限 ${this.limits.maxPendingQueries}`, {
              backpressure: true,
            });
            return;
          }
          try {
            const res = await slot.store.exportRaw({
              outputPath: msg.outputPath,
              cancel: guard.token,
              verifyChunkCrc32: msg.verifyChunkCrc32,
            });
            this.replyFromStoreResult(msg.reqId, res);
          } finally {
            guard.cleanup();
          }
          return;
        }

        case 'startRawExportStream': {
          const slot = this.records.get(msg.recordId);
          if (!slot || slot.closing) {
            this.replyErr(msg.reqId, 'RecordNotFound', `未找到活动录制 recordId=${msg.recordId}`);
            return;
          }
          if (this.rawStreams.has(msg.streamId)) {
            this.replyErr(msg.reqId, 'InvalidArgument', `streamId=${msg.streamId} 已存在`);
            return;
          }
          const stats = slot.store.getStats();
          const chunkBytes = Math.min(
            this.limits.maxResultBytes,
            Math.max(256, msg.chunkBytes ?? slot.store.limits.rawChunkBytes),
          );
          const rawPath = path.join(slot.store.recordingDir, ORBIT_TRACE_FILES.raw);
          const handle = stats.committed.rawBytes > 0 ? await defaultTraceFileSystem.open(rawPath, 'r') : null;
          this.rawStreams.set(msg.streamId, {
            streamId: msg.streamId,
            recordId: msg.recordId,
            totalBytes: stats.committed.rawBytes,
            chunkBytes,
            rawPath,
            handle,
            offset: 0,
            closed: false,
            pulling: false,
          });
          this.replyOk(msg.reqId, {
            streamId: msg.streamId,
            totalBytes: stats.committed.rawBytes,
            chunkBytes,
          });
          return;
        }

        case 'pullRawExportStream': {
          const st = this.rawStreams.get(msg.streamId);
          if (!st || st.closed) {
            this.replyErr(msg.reqId, 'StreamNotFound', `原始导出流不存在或已关闭: ${msg.streamId}`);
            return;
          }
          if (st.pulling) {
            this.replyErr(msg.reqId, 'StreamBusy', `原始导出流正在读取上一块: ${msg.streamId}`);
            return;
          }
          st.pulling = true;
          try {
            if (st.offset >= st.totalBytes || !st.handle) {
              const donePayload: PullRawStreamResult = {
                streamId: st.streamId,
                offset: st.offset,
                chunk: new Uint8Array(0),
                done: true,
                totalBytes: st.totalBytes,
              };
              await this.closeRawStreamInternal(st.streamId);
              this.replyOk(msg.reqId, donePayload);
              return;
            }
            const toRead = Math.min(st.chunkBytes, st.totalBytes - st.offset);
            const buf = Buffer.allocUnsafe(toRead);
            let filled = 0;
            while (filled < toRead) {
              const r = await st.handle.read(buf, filled, toRead - filled, st.offset + filled);
              if (r.bytesRead === 0) {
                throw new Error(`Unexpected EOF reading raw export stream at ${st.offset + filled}`);
              }
              filled += r.bytesRead;
            }
            const chunkOffset = st.offset;
            st.offset += filled;
            const done = st.offset >= st.totalBytes;
            const payload: PullRawStreamResult = {
              streamId: st.streamId,
              offset: chunkOffset,
              chunk: new Uint8Array(buf.buffer, buf.byteOffset, filled),
              done,
              totalBytes: st.totalBytes,
            };
            if (done) {
              await this.closeRawStreamInternal(st.streamId);
            }
            this.replyOk(msg.reqId, payload);
          } finally {
            st.pulling = false;
          }
          return;
        }

        case 'closeRawExportStream': {
          await this.closeRawStreamInternal(msg.streamId);
          this.replyOk(msg.reqId, { closed: true });
          return;
        }

        case 'getSegments': {
          const slot = this.records.get(msg.recordId);
          if (!slot || slot.closing) {
            this.replyErr(msg.reqId, 'RecordNotFound', `未找到活动录制 recordId=${msg.recordId}`);
            return;
          }
          this.replyOk(msg.reqId, slot.store.getSegments());
          return;
        }

        case 'getGaps': {
          const slot = this.records.get(msg.recordId);
          if (!slot || slot.closing) {
            this.replyErr(msg.reqId, 'RecordNotFound', `未找到活动录制 recordId=${msg.recordId}`);
            return;
          }
          this.replyOk(msg.reqId, slot.store.getGaps());
          return;
        }

        case 'getStats': {
          this.replyOk(msg.reqId, this.getStatsSnapshot(msg.recordId));
          return;
        }

        case 'ackProgress': {
          const slot = this.records.get(msg.recordId);
          if (slot) {
            slot.progressInFlight = false;
            if (slot.progressDirty) {
              this.maybeEmitProgress(slot);
            }
          }
          this.replyOk(msg.reqId, { acked: true });
          return;
        }

        case 'shutdown': {
          this.shuttingDown = true;
          for (const q of this.activeQueries.values()) {
            q.controller.abort();
          }
          for (const sid of Array.from(this.rawStreams.keys())) {
            await this.closeRawStreamInternal(sid);
          }
          const closedRecords: string[] = [];
          for (const [id, slot] of Array.from(this.records.entries())) {
            slot.closing = true;
            await this.drainSlotQueue(slot);
            await slot.store.close();
            this.records.delete(id);
            closedRecords.push(id);
          }
          this.replyOk(msg.reqId, { shutdown: true, closedRecords });
          return;
        }
      }
    } catch (err) {
      const code =
        err && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'string'
          ? (err as { code: string }).code
          : 'WorkerInternalError';
      const mappedCode =
        code === 'EEXIST'
          ? 'RecordingDirectoryNotEmpty'
          : code;
      this.replyErr(
        msg.reqId,
        mappedCode,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

if (!isMainThread && parentPort) {
  const port = parentPort;
  const runtime = new TraceWorkerRuntime(workerData as TraceWorkerInitData | undefined, (msg) => {
    port.postMessage(msg);
  });

  port.on('message', (msg: TraceWorkerRequest) => {
    void runtime.handleMessage(msg).then(() => {
      if (msg.type === 'shutdown') {
        setImmediate(() => {
          port.close();
        });
      }
    });
  });
}

// 保持未使用的 node:crypto / node:fs 引用不出错时的辅助校验导出
export function verifyWorkerLoaded(): boolean {
  return typeof createHash === 'function' && typeof fs.open === 'function';
}
