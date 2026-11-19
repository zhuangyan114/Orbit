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
  CreateTraceRecordingOptions,
  IngestBatchSummary,
  TraceLodQueryRequest,
  TraceLodQueryResult,
  TraceRangeQueryRequest,
  TraceRangeQueryResult,
  TraceStorageLimits,
  TraceStorageStats,
} from './trace-recording-store';

export type { TraceAnalysisQueryRequest, TraceAnalysisQueryResult };

export interface TraceWorkerLimits {
  readonly maxSingleBatchBytes: number;
  readonly maxInputQueueBytes: number;
  readonly maxInputQueueBatches: number;
  readonly inputLowWaterMarkBytes: number;
  readonly maxInputWaiters?: number;
  readonly maxInputWaiterBytes?: number;
  readonly maxPendingQueries: number;
  readonly maxResultItems: number;
  readonly maxResultBytes: number;
  readonly maxOpenRecords: number;
  readonly maxCancelSlots: number;
  readonly storageLimits?: Partial<TraceStorageLimits>;
}

export const DEFAULT_TRACE_WORKER_LIMITS: TraceWorkerLimits = {
  maxSingleBatchBytes: 1 * 1024 * 1024,
  maxInputQueueBytes: 8 * 1024 * 1024,
  maxInputQueueBatches: 32,
  inputLowWaterMarkBytes: 4 * 1024 * 1024,
  maxPendingQueries: 16,
  maxResultItems: 4096,
  maxResultBytes: 2 * 1024 * 1024,
  maxOpenRecords: 8,
  maxCancelSlots: 64,
};

export interface TraceWorkerInitData {
  readonly limits?: Partial<TraceWorkerLimits>;
  readonly cancelBuffer?: SharedArrayBuffer;
}

export type TraceWorkerRequest =
  | {
      readonly reqId: number;
      readonly type: 'createRecording';
      readonly recordingDir: string;
      readonly recordId: string;
      readonly identity: TraceReconstructionIdentity;
      readonly decoderOptions?: SystemViewDecoderOptions;
      readonly symbolMap?: TraceSymbolMap;
      readonly limits?: Partial<TraceStorageLimits>;
      readonly commitOnEachIngest?: boolean;
    }
  | {
      readonly reqId: number;
      readonly type: 'openRecording';
      readonly recordId?: string;
      readonly recordingDir: string;
      readonly limits?: Partial<TraceStorageLimits>;
      readonly verifyRawSha256?: boolean;
    }
  | {
      readonly reqId: number;
      readonly type: 'ingestChunk';
      readonly recordId: string;
      readonly sessionId: string;
      readonly sessionGeneration: number;
      readonly bootGeneration?: number;
      readonly batchSequence?: number;
      readonly chunk: Uint8Array;
      readonly flush?: boolean;
    }
  | {
      readonly reqId: number;
      readonly type: 'ingestDecoded';
      readonly recordId: string;
      readonly decodeBatch: SystemViewDecodeBatch;
      readonly reconBatch: TraceReconstructBatch;
      readonly rawChunk?: Uint8Array;
      readonly flush?: boolean;
    }
  | {
      readonly reqId: number;
      readonly type: 'markGap';
      readonly recordId: string;
      readonly sessionId: string;
      readonly sessionGeneration: number;
      readonly gap: TraceGapInput;
    }
  | {
      readonly reqId: number;
      readonly type: 'notifyTargetReset';
      readonly recordId: string;
      readonly sessionId: string;
      readonly sessionGeneration: number;
      readonly nextBootGeneration?: number;
      readonly reason?: string;
    }
  | {
      readonly reqId: number;
      readonly type: 'flushRecording';
      readonly recordId: string;
    }
  | {
      readonly reqId: number;
      readonly type: 'finishRecording';
      readonly recordId: string;
      readonly reason?: string;
      readonly terminalState?: 'completed' | 'interrupted' | 'failed';
      readonly failureCode?: string;
      readonly diagnostics?: Record<string, unknown>;
    }
  | {
      readonly reqId: number;
      readonly type: 'closeRecording';
      readonly recordId: string;
    }
  | {
      readonly reqId: number;
      readonly type: 'inspectRecording';
      readonly recordingDir: string;
      readonly verifyRawSha256?: boolean;
    }
  | {
      readonly reqId: number;
      readonly type: 'queryRange';
      readonly recordId: string;
      readonly queryId: string;
      readonly request: TraceRangeQueryRequest;
      readonly cancelSlot?: number;
      readonly cancelToken?: number;
      readonly yieldEveryPages?: number;
      readonly yieldEveryItems?: number;
    }
  | {
      readonly reqId: number;
      readonly type: 'queryLod';
      readonly recordId: string;
      readonly queryId: string;
      readonly request: TraceLodQueryRequest;
      readonly cancelSlot?: number;
      readonly cancelToken?: number;
    }
  | {
      readonly reqId: number;
      readonly type: 'queryAnalysis';
      readonly recordId: string;
      readonly queryId: string;
      readonly request: TraceAnalysisQueryRequest;
      readonly cancelSlot?: number;
      readonly cancelToken?: number;
      readonly yieldEveryPages?: number;
      readonly yieldEveryItems?: number;
    }
  | {
      readonly reqId: number;
      readonly type: 'cancelQuery';
      readonly queryId: string;
    }
  | {
      readonly reqId: number;
      readonly type: 'exportRawToFile';
      readonly recordId: string;
      readonly queryId: string;
      readonly outputPath: string;
      readonly cancelSlot?: number;
      readonly cancelToken?: number;
      readonly verifyChunkCrc32?: boolean;
    }
  | {
      readonly reqId: number;
      readonly type: 'startRawExportStream';
      readonly recordId: string;
      readonly streamId: string;
      readonly chunkBytes?: number;
      readonly verifyChunkCrc32?: boolean;
    }
  | {
      readonly reqId: number;
      readonly type: 'pullRawExportStream';
      readonly streamId: string;
    }
  | {
      readonly reqId: number;
      readonly type: 'closeRawExportStream';
      readonly streamId: string;
    }
  | {
      readonly reqId: number;
      readonly type: 'getSegments';
      readonly recordId: string;
    }
  | {
      readonly reqId: number;
      readonly type: 'getGaps';
      readonly recordId: string;
    }
  | {
      readonly reqId: number;
      readonly type: 'getStats';
      readonly recordId?: string;
    }
  | {
      readonly reqId: number;
      readonly type: 'ackProgress';
      readonly recordId: string;
    }
  | {
      readonly reqId: number;
      readonly type: 'shutdown';
      readonly reason?: string;
    };

export interface TraceWorkerStatsSnapshot {
  readonly openRecordCount: number;
  readonly pendingInputBytes: number;
  readonly pendingInputBatches: number;
  readonly peakInputQueueBytes: number;
  readonly peakInputQueueBatches: number;
  readonly activeQueryCount: number;
  readonly pendingQueryCount: number;
  readonly peakQueryQueueCount: number;
  readonly activeRawStreamCount: number;
  readonly rejectedBackpressureCount: number;
  readonly rejectedQueryLimitCount: number;
  readonly limits: TraceWorkerLimits;
  readonly records: Readonly<Record<string, TraceStorageStats>>;
}

export type TraceWorkerResponse =
  | {
      readonly kind: 'response';
      readonly reqId: number;
      readonly ok: true;
      readonly data: unknown;
    }
  | {
      readonly kind: 'response';
      readonly reqId: number;
      readonly ok: false;
      readonly errorCode: string;
      readonly message: string;
      readonly backpressure?: boolean;
      readonly cancelled?: boolean;
      readonly diagnostics?: Record<string, unknown>;
    };

export type TraceWorkerEvent =
  | {
      readonly kind: 'event';
      readonly event: 'drain';
      readonly pendingInputBytes: number;
      readonly pendingInputBatches: number;
    }
  | {
      readonly kind: 'event';
      readonly event: 'progress';
      readonly recordId: string;
      readonly committedRawBytes: number;
      readonly packetCount: number;
      readonly sliceCount: number;
      readonly gapCount: number;
    };

export type TraceWorkerMessage = TraceWorkerResponse | TraceWorkerEvent;

export interface OpenRecordingWorkerResult {
  readonly recordId: string;
  readonly inspection: RecordingInspectionResult;
  readonly stats: TraceStorageStats;
}

export interface PullRawStreamResult {
  readonly streamId: string;
  readonly offset: number;
  readonly chunk: Uint8Array;
  readonly done: boolean;
  readonly totalBytes: number;
}

export function resolveTraceWorkerLimits(partial?: Partial<TraceWorkerLimits>): TraceWorkerLimits {
  const merged: TraceWorkerLimits = {
    ...DEFAULT_TRACE_WORKER_LIMITS,
    ...partial,
  };
  if (merged.maxSingleBatchBytes < 256 || merged.maxSingleBatchBytes > 16 * 1024 * 1024) {
    throw new RangeError(`maxSingleBatchBytes out of range: ${merged.maxSingleBatchBytes}`);
  }
  if (merged.maxInputQueueBytes < merged.maxSingleBatchBytes) {
    throw new RangeError('maxInputQueueBytes must be >= maxSingleBatchBytes');
  }
  if (merged.maxInputQueueBatches < 1 || merged.maxInputQueueBatches > 4096) {
    throw new RangeError(`maxInputQueueBatches out of range: ${merged.maxInputQueueBatches}`);
  }
  if (merged.maxPendingQueries < 1 || merged.maxPendingQueries > 1024) {
    throw new RangeError(`maxPendingQueries out of range: ${merged.maxPendingQueries}`);
  }
  if (merged.maxResultItems < 1 || merged.maxResultItems > 16384) {
    throw new RangeError(`maxResultItems out of range: ${merged.maxResultItems}`);
  }
  if (merged.maxResultBytes < 4096 || merged.maxResultBytes > 16 * 1024 * 1024) {
    throw new RangeError(`maxResultBytes out of range: ${merged.maxResultBytes}`);
  }
  if (merged.maxOpenRecords < 1 || merged.maxOpenRecords > 256) {
    throw new RangeError(`maxOpenRecords out of range: ${merged.maxOpenRecords}`);
  }
  return merged;
}

export function estimateDecodedBatchBytes(
  decodeBatch: SystemViewDecodeBatch,
  reconBatch: TraceReconstructBatch,
  rawChunk?: Uint8Array,
): number {
  return (
    (rawChunk?.length ?? 0) +
    decodeBatch.packets.length * 72 +
    reconBatch.executionSlices.length * 96 +
    reconBatch.contextActivations.length * 128 +
    reconBatch.readyWaits.length * 96 +
    reconBatch.markers.length * 96 +
    reconBatch.markerPoints.length * 64 +
    256
  );
}

export type {
  CreateTraceRecordingOptions,
  IngestBatchSummary,
  RecordingInspectionResult,
  SegmentIndexMetadata,
  StoredGapEntry,
  TraceLodQueryRequest,
  TraceLodQueryResult,
  TraceRangeQueryRequest,
  TraceRangeQueryResult,
  TraceRecordingManifest,
  TraceStorageLimits,
  TraceStorageStats,
  PullRawStreamResult as TraceRawStreamChunk,
};
