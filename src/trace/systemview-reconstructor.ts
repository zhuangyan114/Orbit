import {
  DecodedSystemViewPacket,
  SegmentReliability,
  SystemViewDecodeBatch,
  SystemViewDecodeResult,
  TimeAnchorStatus,
  TraceGapInput,
  TraceGapKind,
  TraceGapRecord,
  TraceSegmentSummary,
} from './systemview-decoder';
import { SYSTEMVIEW_PROTOCOL_VERSION } from './systemview-protocol';

/** FreeRTOS apiID_VTASKDELETE (SEGGER_SYSVIEW_FreeRTOS.h)。 */
const FREERTOS_API_ID_VTASKDELETE = 2;

export type ReconstructorDiagnosticSeverity = 'info' | 'warning' | 'error';

export type ReconstructorDiagnosticCode =
  | 'identity-mismatch'
  | 'batch-out-of-order'
  | 'batch-sequence-gap'
  | 'target-reset'
  | 'gap-closed-open-intervals'
  | 'uncertain-segment'
  | 'uncertain-time-continuity'
  | 'timestamp-out-of-order'
  | 'missing-init-for-id'
  | 'orphan-isr-exit'
  | 'orphan-isr-to-scheduler'
  | 'missing-isr-exit'
  | 'illegal-isr-reentry'
  | 'nested-isr-to-scheduler'
  | 'orphan-timer-exit'
  | 'missing-timer-exit'
  | 'orphan-task-stop-exec'
  | 'same-task-rescheduled'
  | 'ready-while-running'
  | 'duplicate-task-ready'
  | 'missing-ready-start'
  | 'task-recreated-without-delete'
  | 'terminate-unknown-task'
  | 'post-terminate-activity'
  | 'duplicate-marker-start'
  | 'orphan-marker-stop'
  | 'budget-exceeded';

export type IntervalCompleteness = 'complete' | 'incomplete' | 'uncertain';

export type LabelSource =
  | 'task-info'
  | 'sysdesc'
  | 'ex-name-marker'
  | 'name-resource'
  | 'symbol-map'
  | 'fixed-idle'
  | 'fixed-scheduler'
  | 'missing';

export type ExecutionContextKind = 'task' | 'idle' | 'isr' | 'scheduler';

export type ReadyOutcome = 'dispatched' | 'removed-from-ready' | 'incomplete';

export type ReadyChainStatus = 'matched-ready' | 'no-start-ready' | 'post-gap-unknown' | 'uncertain';

export type TaskIdentityConfidence =
  | 'created-in-segment'
  | 'task-info-in-boot'
  | 'observed-mid-stream'
  | 'carried-across-gap';

export type AddressResolutionStatus =
  | 'resolved'
  | 'unresolved-missing-init'
  | 'invalid-shift'
  | 'address-overflow';

export interface TraceReconstructionIdentity {
  readonly sessionId: string;
  readonly sessionGeneration: number;
  readonly bootGeneration: number;
  readonly recordId: string;
}

export type SymbolLookupInput = ReadonlyMap<number, string> | Readonly<Record<string, string>>;

export interface TraceSymbolMap {
  readonly tasks?: SymbolLookupInput;
  readonly interrupts?: SymbolLookupInput;
  readonly markers?: SymbolLookupInput;
  readonly resources?: SymbolLookupInput;
}

export interface SystemViewReconstructorOptions {
  readonly identity?: Partial<TraceReconstructionIdentity>;
  readonly symbolMap?: TraceSymbolMap;
  readonly maxIsrDepth?: number;
  readonly maxTimerDepth?: number;
  readonly maxOpenReadyTasks?: number;
  readonly maxOpenMarkers?: number;
  readonly maxTrackedTasks?: number;
  readonly maxKnownTaskAddresses?: number;
  readonly maxIrqDescriptions?: number;
  readonly maxMarkerNames?: number;
  readonly maxResourceNames?: number;
}

export interface ReconstructBatchOptions {
  readonly identity?: Partial<TraceReconstructionIdentity>;
  readonly batchSequence?: number;
}

export interface TraceTimePoint {
  readonly segmentId: number;
  readonly packetIndexInSegment: number;
  readonly streamByteOffset: number;
  readonly relativeTicks: string;
  readonly relativeTicksBigInt: bigint;
  readonly absoluteTicks?: string;
  readonly absoluteTicksBigInt?: bigint;
  readonly timeAnchorStatus: TimeAnchorStatus;
  readonly sysFreqHz?: number;
  readonly timestampNs?: string;
}

export interface ExecutionSliceInterval {
  readonly sliceId: string;
  readonly bootGeneration: number;
  readonly segmentId: number;
  readonly segmentReliability: SegmentReliability;
  readonly completeness: IntervalCompleteness;
  readonly contextKind: ExecutionContextKind;
  readonly contextKey: string;
  readonly taskInstanceId?: string;
  readonly tcbAddress?: number;
  readonly shrunkTaskId?: number;
  readonly taskGeneration?: number;
  readonly irqId?: number;
  readonly isrDepth: number;
  readonly label?: string;
  readonly labelSource: LabelSource;
  readonly start?: TraceTimePoint;
  readonly end?: TraceTimePoint;
  readonly observedUntil?: TraceTimePoint;
  readonly durationTicks?: string;
  readonly durationTicksBigInt?: bigint;
  readonly durationNs?: string;
  readonly timeDomain: 'anchored-ticks' | 'segment-relative-ticks' | 'unknown';
  readonly startReason: string;
  readonly endReason?: string;
}

export interface ContextActivationInterval {
  readonly activationId: string;
  readonly bootGeneration: number;
  readonly segmentId: number;
  readonly segmentReliability: SegmentReliability;
  readonly completeness: IntervalCompleteness;
  readonly kind: 'task-exec' | 'isr' | 'timer';
  readonly contextKey: string;
  readonly taskInstanceId?: string;
  readonly tcbAddress?: number;
  readonly shrunkTaskId?: number;
  readonly taskGeneration?: number;
  readonly irqId?: number;
  readonly isrDepth?: number;
  readonly timerId?: number;
  readonly shrunkTimerId?: number;
  readonly label?: string;
  readonly labelSource: LabelSource;
  readonly start?: TraceTimePoint;
  readonly end?: TraceTimePoint;
  readonly observedUntil?: TraceTimePoint;
  readonly inclusiveDurationTicks?: string;
  readonly inclusiveDurationTicksBigInt?: bigint;
  readonly exclusiveDurationTicks?: string;
  readonly exclusiveDurationTicksBigInt?: bigint;
  readonly preemptedDurationTicks?: string;
  readonly preemptedDurationTicksBigInt?: bigint;
  readonly inclusiveDurationNs?: string;
  readonly exclusiveDurationNs?: string;
  readonly preemptionCount: number;
  readonly readyChainStatus?: ReadyChainStatus;
  readonly matchedReadyWaitId?: string;
  readonly timeDomain: 'anchored-ticks' | 'segment-relative-ticks' | 'unknown';
  readonly endReason?: string;
}

export interface ReadyWaitInterval {
  readonly waitId: string;
  readonly bootGeneration: number;
  readonly segmentId: number;
  readonly segmentReliability: SegmentReliability;
  readonly completeness: IntervalCompleteness;
  readonly outcome: ReadyOutcome;
  readonly taskInstanceId: string;
  readonly tcbAddress?: number;
  readonly shrunkTaskId?: number;
  readonly taskGeneration: number;
  readonly label?: string;
  readonly labelSource: LabelSource;
  readonly start?: TraceTimePoint;
  readonly end?: TraceTimePoint;
  readonly observedUntil?: TraceTimePoint;
  readonly durationTicks?: string;
  readonly durationTicksBigInt?: bigint;
  readonly durationNs?: string;
  readonly readyToRunningTicks?: string;
  readonly readyToRunningTicksBigInt?: bigint;
  readonly stopCause?: number;
  readonly timeDomain: 'anchored-ticks' | 'segment-relative-ticks' | 'unknown';
  readonly endReason?: string;
}

export interface MarkerInterval {
  readonly markerInstanceId: string;
  readonly bootGeneration: number;
  readonly segmentId: number;
  readonly segmentReliability: SegmentReliability;
  readonly completeness: IntervalCompleteness;
  readonly markerId: number;
  readonly name?: string;
  readonly nameSource: LabelSource;
  readonly start?: TraceTimePoint;
  readonly end?: TraceTimePoint;
  readonly observedUntil?: TraceTimePoint;
  readonly durationTicks?: string;
  readonly durationTicksBigInt?: bigint;
  readonly durationNs?: string;
  readonly startContextKey?: string;
  readonly endContextKey?: string;
  readonly timeDomain: 'anchored-ticks' | 'segment-relative-ticks' | 'unknown';
  readonly endReason?: string;
}

export interface MarkerPointEvent {
  readonly bootGeneration: number;
  readonly segmentId: number;
  readonly segmentReliability: SegmentReliability;
  readonly markerId: number;
  readonly name?: string;
  readonly nameSource: LabelSource;
  readonly time: TraceTimePoint;
  readonly contextKey?: string;
}

export interface TaskStackInfo {
  readonly stackBase: number;
  readonly stackSize: number;
  readonly stackUsage: number;
  readonly segmentId: number;
  readonly relativeTicks: string;
}

export interface TaskInstanceSummary {
  readonly taskInstanceId: string;
  readonly bootGeneration: number;
  readonly firstSeenSegmentId: number;
  readonly lastSeenSegmentId: number;
  readonly tcbAddress?: number;
  readonly addressStatus: AddressResolutionStatus;
  readonly shrunkTaskId?: number;
  readonly generation: number;
  readonly name?: string;
  readonly nameSource: LabelSource;
  readonly priority?: number;
  readonly stackInfo?: TaskStackInfo;
  readonly createdInTrace: boolean;
  readonly createdAt?: TraceTimePoint;
  readonly terminated: boolean;
  readonly terminatedAt?: TraceTimePoint;
  readonly terminationSource?: 'task-terminate' | 'os-vtask-delete' | 'recreated-implicitly';
  readonly identityConfidence: TaskIdentityConfidence;
}

export interface ReconstructorDiagnostic {
  readonly severity: ReconstructorDiagnosticSeverity;
  readonly code: ReconstructorDiagnosticCode;
  readonly message: string;
  readonly bootGeneration: number;
  readonly segmentId: number;
  readonly streamByteOffset: number;
  readonly relativeTicks?: string;
  readonly details?: Record<string, unknown>;
}

export interface ReconstructorGapBoundary {
  readonly kind: TraceGapKind | 'target-reset' | 'trace-stop' | 'eof' | 'metadata-reconfigured' | 'resync';
  readonly bootGeneration: number;
  readonly segmentIdBefore?: number;
  readonly byteOffset?: number;
  readonly droppedPackets: number | 'unknown';
  readonly droppedBytes: number | 'unknown';
  readonly reason: string;
  readonly closedOpenCount: number;
}

export interface TraceReconstructBatch {
  readonly protocolVersion: typeof SYSTEMVIEW_PROTOCOL_VERSION;
  readonly accepted: boolean;
  readonly rejectionReason?: string;
  readonly errorCode?: 'SessionChanged' | 'RecordChanged' | 'BatchSequenceInvalid' | 'BatchSequenceGap' | 'StaleBootGeneration' | 'Finished';
  readonly identity: TraceReconstructionIdentity;
  readonly executionSlices: readonly ExecutionSliceInterval[];
  readonly contextActivations: readonly ContextActivationInterval[];
  readonly readyWaits: readonly ReadyWaitInterval[];
  readonly markers: readonly MarkerInterval[];
  readonly markerPoints: readonly MarkerPointEvent[];
  readonly taskUpdates: readonly TaskInstanceSummary[];
  readonly gapBoundaries: readonly ReconstructorGapBoundary[];
  readonly diagnostics: readonly ReconstructorDiagnostic[];
}

export interface TraceReconstructorState {
  readonly protocolVersion: typeof SYSTEMVIEW_PROTOCOL_VERSION;
  readonly identity: TraceReconstructionIdentity;
  readonly finished: boolean;
  readonly currentSegmentId: number | null;
  readonly currentSegmentReliability: SegmentReliability | null;
  readonly continuityEpoch: number;
  readonly lastBatchSequence: number | null;
  readonly activeBaseContextKind: 'task' | 'idle' | 'scheduler' | null;
  readonly activeBaseTaskInstanceId: string | null;
  readonly activeIsrDepth: number;
  readonly activeTimerDepth: number;
  readonly openReadyCount: number;
  readonly openMarkerCount: number;
  readonly trackedTaskCount: number;
  readonly knownTaskAddressCount: number;
  readonly peakIsrDepth: number;
  readonly peakOpenReadyCount: number;
  readonly peakOpenMarkerCount: number;
  readonly totalPacketsProcessed: number;
  readonly totalEmittedIntervals: number;
  readonly totalBudgetEvictions: number;
  readonly totalRejectedBatches: number;
}

export interface TraceReconstructResult {
  readonly identity: TraceReconstructionIdentity;
  readonly executionSlices: readonly ExecutionSliceInterval[];
  readonly contextActivations: readonly ContextActivationInterval[];
  readonly readyWaits: readonly ReadyWaitInterval[];
  readonly markers: readonly MarkerInterval[];
  readonly markerPoints: readonly MarkerPointEvent[];
  readonly taskUpdates: readonly TaskInstanceSummary[];
  readonly tasksByInstanceId: ReadonlyMap<string, TaskInstanceSummary>;
  readonly gapBoundaries: readonly ReconstructorGapBoundary[];
  readonly diagnostics: readonly ReconstructorDiagnostic[];
  readonly summary: TraceReconstructorState;
}

interface InternalTaskInstance {
  readonly taskInstanceId: string;
  readonly lookupKey: string;
  readonly bootGeneration: number;
  firstSeenSegmentId: number;
  lastSeenSegmentId: number;
  readonly tcbAddress?: number;
  readonly addressStatus: AddressResolutionStatus;
  readonly shrunkTaskId?: number;
  readonly generation: number;
  name?: string;
  nameSource: LabelSource;
  priority?: number;
  stackInfo?: TaskStackInfo;
  createdInTrace: boolean;
  createdAt?: TraceTimePoint;
  terminated: boolean;
  terminatedAt?: TraceTimePoint;
  terminationSource?: 'task-terminate' | 'os-vtask-delete' | 'recreated-implicitly';
  pendingSelfDelete: boolean;
  identityConfidence: TaskIdentityConfidence;
  carriedAcrossGap: boolean;
  lastStopReadyCause?: number;
  lastTouchedSeq: number;
}

interface OpenSliceState {
  readonly sliceId: string;
  readonly bootGeneration: number;
  readonly segmentId: number;
  readonly segmentReliability: SegmentReliability;
  readonly contextKind: ExecutionContextKind;
  readonly contextKey: string;
  readonly taskInstanceId?: string;
  readonly tcbAddress?: number;
  readonly shrunkTaskId?: number;
  readonly taskGeneration?: number;
  readonly irqId?: number;
  readonly isrDepth: number;
  readonly label?: string;
  readonly labelSource: LabelSource;
  readonly start: TraceTimePoint;
  readonly startReason: string;
  tainted: boolean;
}

interface OpenTaskActivationState {
  readonly activationId: string;
  readonly bootGeneration: number;
  readonly segmentId: number;
  readonly segmentReliability: SegmentReliability;
  readonly taskInstanceId: string;
  readonly contextKey: string;
  readonly tcbAddress?: number;
  readonly shrunkTaskId?: number;
  readonly taskGeneration: number;
  readonly label?: string;
  readonly labelSource: LabelSource;
  readonly start: TraceTimePoint;
  exclusiveTicks: bigint;
  preemptionCount: number;
  readonly readyChainStatus: ReadyChainStatus;
  readonly matchedReadyWaitId?: string;
  tainted: boolean;
}

interface OpenIsrFrameState {
  readonly activationId: string;
  readonly bootGeneration: number;
  readonly segmentId: number;
  readonly segmentReliability: SegmentReliability;
  readonly irqId: number;
  readonly isrDepth: number;
  readonly contextKey: string;
  readonly label?: string;
  readonly labelSource: LabelSource;
  readonly start: TraceTimePoint;
  exclusiveTicks: bigint;
  preemptionCount: number;
  tainted: boolean;
}

interface OpenTimerFrameState {
  readonly activationId: string;
  readonly bootGeneration: number;
  readonly segmentId: number;
  readonly segmentReliability: SegmentReliability;
  readonly timerId?: number;
  readonly shrunkTimerId: number;
  readonly contextKey: string;
  readonly label?: string;
  readonly labelSource: LabelSource;
  readonly start: TraceTimePoint;
  preemptedTicks: bigint;
  preemptionCount: number;
  tainted: boolean;
}

interface OpenReadyState {
  readonly waitId: string;
  readonly bootGeneration: number;
  readonly segmentId: number;
  readonly segmentReliability: SegmentReliability;
  readonly taskInstanceId: string;
  readonly lookupKey: string;
  readonly tcbAddress?: number;
  readonly shrunkTaskId?: number;
  readonly taskGeneration: number;
  readonly label?: string;
  readonly labelSource: LabelSource;
  readonly start: TraceTimePoint;
  tainted: boolean;
}

interface OpenMarkerState {
  readonly markerInstanceId: string;
  readonly bootGeneration: number;
  readonly segmentId: number;
  readonly segmentReliability: SegmentReliability;
  readonly markerId: number;
  readonly name?: string;
  readonly nameSource: LabelSource;
  readonly start: TraceTimePoint;
  readonly startContextKey?: string;
  tainted: boolean;
}

interface MutableReconstructBatch {
  executionSlices: ExecutionSliceInterval[];
  contextActivations: ContextActivationInterval[];
  readyWaits: ReadyWaitInterval[];
  markers: MarkerInterval[];
  markerPoints: MarkerPointEvent[];
  taskUpdates: TaskInstanceSummary[];
  gapBoundaries: ReconstructorGapBoundary[];
  diagnostics: ReconstructorDiagnostic[];
}

const DEFAULT_MAX_ISR_DEPTH = 64;
const DEFAULT_MAX_TIMER_DEPTH = 64;
const DEFAULT_MAX_OPEN_READY = 1024;
const DEFAULT_MAX_OPEN_MARKERS = 1024;
const DEFAULT_MAX_TRACKED_TASKS = 2048;
const DEFAULT_MAX_KNOWN_TASK_ADDRESSES = 4096;
const DEFAULT_MAX_IRQ_DESCRIPTIONS = 512;
const DEFAULT_MAX_MARKER_NAMES = 1024;
const DEFAULT_MAX_RESOURCE_NAMES = 1024;

/**
 * SystemView 3.32.0 + FreeRTOS 区间重建器（阶段 4.2）。
 *
 * 约定：
 * - 不持有历史已闭合区间或全量事件；每批输出并立即释放已闭合区间，未闭合结构严格受预算上限保护。
 * - 单核 CPU 同一时刻至多归属一个独占上下文（当前最内层 ISR，或无 ISR 时的任务 / IDLE / 调度器）。
 * - 严格按会话、记录、boot 代次与 segment 隔离连续性；任何缺口、复位、非法重入、缺失退出、失序或重复 Marker
 *   均不得伪造完整区间、持续时间、名称或 TCB 地址身份。
 * - 所有 tick 与换算计算保持 `bigint` / 十进制字符串精确表示。
 */
export class SystemViewTraceReconstructor {
  private readonly symbolMap: TraceSymbolMap;
  private readonly maxIsrDepth: number;
  private readonly maxTimerDepth: number;
  private readonly maxOpenReadyTasks: number;
  private readonly maxOpenMarkers: number;
  private readonly maxTrackedTasks: number;
  private readonly maxKnownTaskAddresses: number;
  private readonly maxIrqDescriptions: number;
  private readonly maxMarkerNames: number;
  private readonly maxResourceNames: number;

  private identity: TraceReconstructionIdentity;
  private finished = false;
  /**
   * 宿主递送批次序号（按 sessionId + sessionGeneration + recordId 单调递增连续，不因目标复位/bootGeneration 变更归零）。
   */
  private lastBatchSequence: number | null = null;
  private sequenceGapDeclared = false;
  private hasOpaqueLossGap = false;
  private totalRejectedBatches = 0;

  private currentSegmentId: number | null = null;
  private currentSegmentReliability: SegmentReliability | null = null;
  private currentSegmentTimeUncertain = false;
  private currentSegmentSysFreqHz: number | undefined = undefined;
  private currentSegmentByteOffset = 0;
  private lastPacketInSegment: DecodedSystemViewPacket | null = null;
  private continuityEpoch = 0;

  private seqCounter = 0;
  private taskInstanceSeq = 0;
  private touchCounter = 0;
  private addressGenerationLruEvicted = false;
  private totalPacketsProcessed = 0;
  private totalEmittedIntervals = 0;
  private totalBudgetEvictions = 0;

  private peakIsrDepth = 0;
  private peakOpenReadyCount = 0;
  private peakOpenMarkerCount = 0;

  // 当前 CPU 独占切片
  private activeSlice: OpenSliceState | null = null;
  // 基底上下文：Task / Idle / Scheduler（可能被 ISR 抢占）
  private baseContextKind: 'task' | 'idle' | 'scheduler' | null = null;
  private activeTaskActivation: OpenTaskActivationState | null = null;
  private idleResumedLabel = 'IDLE';

  // 嵌套栈与未闭合集合（均受预算上限保护）
  private isrStack: OpenIsrFrameState[] = [];
  private timerStack: OpenTimerFrameState[] = [];
  private openReadyWaits = new Map<string, OpenReadyState>();
  private openMarkers = new Map<number, OpenMarkerState>();

  // 当前 boot 内的任务代次与有界元数据表
  private taskGenerationByKey = new Map<string, number>();
  private tasksByKey = new Map<string, InternalTaskInstance>();
  private irqNames = new Map<number, string>();
  private markerNames = new Map<number, string>();
  private resourceNames = new Map<number, string>();

  public constructor(options: SystemViewReconstructorOptions = {}) {
    this.identity = {
      sessionId: options.identity?.sessionId ?? 'default-session',
      sessionGeneration: options.identity?.sessionGeneration ?? 1,
      bootGeneration: options.identity?.bootGeneration ?? 1,
      recordId: options.identity?.recordId ?? 'default-record',
    };
    this.symbolMap = options.symbolMap ?? {};
    this.maxIsrDepth = validateBound(options.maxIsrDepth ?? DEFAULT_MAX_ISR_DEPTH, 'maxIsrDepth', 1, 1024);
    this.maxTimerDepth = validateBound(options.maxTimerDepth ?? DEFAULT_MAX_TIMER_DEPTH, 'maxTimerDepth', 1, 1024);
    this.maxOpenReadyTasks = validateBound(options.maxOpenReadyTasks ?? DEFAULT_MAX_OPEN_READY, 'maxOpenReadyTasks', 1, 65536);
    this.maxOpenMarkers = validateBound(options.maxOpenMarkers ?? DEFAULT_MAX_OPEN_MARKERS, 'maxOpenMarkers', 1, 65536);
    this.maxTrackedTasks = validateBound(options.maxTrackedTasks ?? DEFAULT_MAX_TRACKED_TASKS, 'maxTrackedTasks', 8, 65536);
    this.maxKnownTaskAddresses = validateBound(
      options.maxKnownTaskAddresses ?? DEFAULT_MAX_KNOWN_TASK_ADDRESSES,
      'maxKnownTaskAddresses',
      8,
      131072,
    );
    this.maxIrqDescriptions = validateBound(options.maxIrqDescriptions ?? DEFAULT_MAX_IRQ_DESCRIPTIONS, 'maxIrqDescriptions', 1, 8192);
    this.maxMarkerNames = validateBound(options.maxMarkerNames ?? DEFAULT_MAX_MARKER_NAMES, 'maxMarkerNames', 1, 16384);
    this.maxResourceNames = validateBound(options.maxResourceNames ?? DEFAULT_MAX_RESOURCE_NAMES, 'maxResourceNames', 1, 16384);
  }

  public reset(identity?: Partial<TraceReconstructionIdentity>): void {
    if (identity) {
      this.identity = {
        sessionId: identity.sessionId ?? this.identity.sessionId,
        sessionGeneration: identity.sessionGeneration ?? this.identity.sessionGeneration,
        bootGeneration: identity.bootGeneration ?? this.identity.bootGeneration,
        recordId: identity.recordId ?? this.identity.recordId,
      };
    }
    this.finished = false;
    this.lastBatchSequence = null;
    this.sequenceGapDeclared = false;
    this.hasOpaqueLossGap = false;
    this.totalRejectedBatches = 0;
    this.currentSegmentId = null;
    this.currentSegmentReliability = null;
    this.currentSegmentTimeUncertain = false;
    this.currentSegmentSysFreqHz = undefined;
    this.currentSegmentByteOffset = 0;
    this.lastPacketInSegment = null;
    this.continuityEpoch = 0;
    this.seqCounter = 0;
    this.taskInstanceSeq = 0;
    this.touchCounter = 0;
    this.addressGenerationLruEvicted = false;
    this.totalPacketsProcessed = 0;
    this.totalEmittedIntervals = 0;
    this.totalBudgetEvictions = 0;
    this.peakIsrDepth = 0;
    this.peakOpenReadyCount = 0;
    this.peakOpenMarkerCount = 0;
    this.clearBootAndSegmentState();
  }

  public getState(): TraceReconstructorState {
    return {
      protocolVersion: SYSTEMVIEW_PROTOCOL_VERSION,
      identity: { ...this.identity },
      finished: this.finished,
      currentSegmentId: this.currentSegmentId,
      currentSegmentReliability: this.currentSegmentReliability,
      continuityEpoch: this.continuityEpoch,
      lastBatchSequence: this.lastBatchSequence,
      activeBaseContextKind: this.baseContextKind,
      activeBaseTaskInstanceId: this.activeTaskActivation?.taskInstanceId ?? null,
      activeIsrDepth: this.isrStack.length,
      activeTimerDepth: this.timerStack.length,
      openReadyCount: this.openReadyWaits.size,
      openMarkerCount: this.openMarkers.size,
      trackedTaskCount: this.tasksByKey.size,
      knownTaskAddressCount: this.taskGenerationByKey.size,
      peakIsrDepth: this.peakIsrDepth,
      peakOpenReadyCount: this.peakOpenReadyCount,
      peakOpenMarkerCount: this.peakOpenMarkerCount,
      totalPacketsProcessed: this.totalPacketsProcessed,
      totalEmittedIntervals: this.totalEmittedIntervals,
      totalBudgetEvictions: this.totalBudgetEvictions,
      totalRejectedBatches: this.totalRejectedBatches,
    };
  }

  public pushBatch(batch: SystemViewDecodeBatch, options: ReconstructBatchOptions = {}): TraceReconstructBatch {
    const out = createEmptyBatch();
    if (this.finished) {
      this.totalRejectedBatches += 1;
      const msg = '重建器已 finish()，拒绝接收后续批次';
      this.emitDiagnostic(out, 'error', 'identity-mismatch', msg, this.currentSegmentByteOffset);
      return this.finalizeReturn(out, false, msg, 'Finished');
    }

    const identityCheck = this.validateAndApplyIdentity(options, out);
    if (!identityCheck.ok) {
      this.totalRejectedBatches += 1;
      return this.finalizeReturn(out, false, identityCheck.reason, identityCheck.errorCode);
    }

    const segmentSummaryById = new Map<number, TraceSegmentSummary>();
    for (const seg of batch.segments) {
      segmentSummaryById.set(seg.segmentId, seg);
    }

    const consumedGapIndices = new Set<number>();
    const closedSegmentIds = new Set<number>();

    const consumeGapsForSegment = (segId: number, upToOffset: number) => {
      for (let i = 0; i < batch.gaps.length; i++) {
        if (consumedGapIndices.has(i)) {
          continue;
        }
        const g = batch.gaps[i];
        if (g.byteOffset <= upToOffset && (g.segmentIdBefore === segId || (g.segmentIdBefore === undefined && this.currentSegmentId === null))) {
          consumedGapIndices.add(i);
          this.handleDecoderGap(g, out);
          if (g.segmentIdBefore !== undefined) {
            closedSegmentIds.add(g.segmentIdBefore);
          }
        }
      }
    };

    for (const pkt of batch.packets) {
      if (this.currentSegmentId !== null && pkt.segmentId !== this.currentSegmentId) {
        consumeGapsForSegment(this.currentSegmentId, pkt.streamByteOffset);
        const prevSummary = segmentSummaryById.get(this.currentSegmentId);
        if (prevSummary && prevSummary.closed && !closedSegmentIds.has(this.currentSegmentId)) {
          this.closeSegmentBoundary(
            prevSummary.endReason ?? 'resync',
            prevSummary.endByteOffset ?? this.currentSegmentByteOffset,
            'unknown',
            'unknown',
            `段 #${this.currentSegmentId} 结束 (${prevSummary.endReason ?? 'resync'})`,
            out,
          );
          closedSegmentIds.add(this.currentSegmentId);
        }
        this.enterSegment(pkt.segmentId, pkt.segmentReliability, pkt.streamByteOffset, pkt.sysFreqHz, out);
      } else if (this.currentSegmentId === null) {
        // 先消费可能前置在第一段之前的流起始缺口（例如 Post-Mortem prefix-overwritten）
        for (let i = 0; i < batch.gaps.length; i++) {
          if (consumedGapIndices.has(i)) {
            continue;
          }
          const g = batch.gaps[i];
          if (g.segmentIdBefore === undefined && g.byteOffset <= pkt.streamByteOffset) {
            consumedGapIndices.add(i);
            this.handleDecoderGap(g, out);
          }
        }
        this.enterSegment(pkt.segmentId, pkt.segmentReliability, pkt.streamByteOffset, pkt.sysFreqHz, out);
      }

      this.processPacket(pkt, out);
    }

    // 处理位于批尾的缺口（例如 markGap、最后包的 OVERFLOW、或 truncated）
    for (let i = 0; i < batch.gaps.length; i++) {
      if (consumedGapIndices.has(i)) {
        continue;
      }
      const g = batch.gaps[i];
      this.handleDecoderGap(g, out);
      if (g.segmentIdBefore !== undefined) {
        closedSegmentIds.add(g.segmentIdBefore);
      }
    }

    // 处理未伴随 gap 的显式关闭段（例如 eof / metadata-reconfigured）
    for (const seg of batch.segments) {
      if (seg.closed && !closedSegmentIds.has(seg.segmentId) && this.currentSegmentId === seg.segmentId) {
        this.closeSegmentBoundary(
          seg.endReason ?? 'eof',
          seg.endByteOffset ?? this.currentSegmentByteOffset,
          'unknown',
          'unknown',
          `段 #${seg.segmentId} 关闭 (${seg.endReason ?? 'eof'})`,
          out,
        );
        closedSegmentIds.add(seg.segmentId);
      }
    }

    return this.finalizeReturn(out, true);
  }

  /**
   * 主动注入采集/传输缺口（独立于 decoder.markGap 的外部中断场景），切断当前段所有未闭合区间。
   */
  public markGap(gap: TraceGapInput | TraceGapRecord): TraceReconstructBatch {
    const out = createEmptyBatch();
    if (this.finished) {
      this.totalRejectedBatches += 1;
      const msg = '重建器已 finish()，拒绝 markGap';
      this.emitDiagnostic(out, 'error', 'identity-mismatch', msg, this.currentSegmentByteOffset);
      return this.finalizeReturn(out, false, msg, 'Finished');
    }
    this.sequenceGapDeclared = true;
    const normalized: TraceGapRecord =
      'byteOffset' in gap
        ? gap
        : {
            kind: gap.kind,
            byteOffset: this.currentSegmentByteOffset,
            segmentIdBefore: this.currentSegmentId ?? undefined,
            droppedPackets: gap.droppedPackets ?? 'unknown',
            droppedBytes: gap.droppedBytes ?? 'unknown',
            reason: gap.reason ?? `外部采集缺口: ${gap.kind}`,
            preservesFraming: Boolean(gap.preservesFraming),
          };
    this.handleDecoderGap(normalized, out);
    return this.finalizeReturn(out, true);
  }

  /**
   * 处理目标复位 / 重新启动：关闭所有未闭合区间为不完整，并彻底清空本 boot 的任务代次与元信息。
   */
  public notifyTargetReset(nextBootGeneration?: number, reason = '目标发生复位，隔离此前状态与地址身份'): TraceReconstructBatch {
    const out = createEmptyBatch();
    if (this.finished) {
      this.totalRejectedBatches += 1;
      const msg = '重建器已 finish()，拒绝 notifyTargetReset';
      this.emitDiagnostic(out, 'error', 'identity-mismatch', msg, this.currentSegmentByteOffset);
      return this.finalizeReturn(out, false, msg, 'Finished');
    }
    const targetBoot = nextBootGeneration ?? this.identity.bootGeneration + 1;
    if (!Number.isInteger(targetBoot) || targetBoot <= this.identity.bootGeneration) {
      this.totalRejectedBatches += 1;
      const msg = `无效目标复位代次 ${targetBoot}（当前 bootGeneration=${this.identity.bootGeneration}）`;
      this.emitDiagnostic(out, 'error', 'identity-mismatch', msg, this.currentSegmentByteOffset);
      return this.finalizeReturn(out, false, msg, 'StaleBootGeneration');
    }
    this.handleBootReset(targetBoot, reason, out);
    return this.finalizeReturn(out, true);
  }

  public finish(): TraceReconstructBatch {
    const out = createEmptyBatch();
    if (this.finished) {
      return this.finalizeReturn(out, true);
    }
    const closedCount = this.closeAllOpenIntervals('eof', undefined, out);
    if (this.currentSegmentId !== null || closedCount > 0) {
      out.gapBoundaries.push({
        kind: 'eof',
        bootGeneration: this.identity.bootGeneration,
        segmentIdBefore: this.currentSegmentId ?? undefined,
        byteOffset: this.currentSegmentByteOffset,
        droppedPackets: 0,
        droppedBytes: 0,
        reason: '流结束，剩余未闭合区间按不完整收尾',
        closedOpenCount: closedCount,
      });
    }
    this.currentSegmentId = null;
    this.currentSegmentReliability = null;
    this.lastPacketInSegment = null;
    this.finished = true;
    return this.finalizeReturn(out, true);
  }

  private validateAndApplyIdentity(
    options: ReconstructBatchOptions,
    out: MutableReconstructBatch,
  ):
    | { ok: true }
    | {
        ok: false;
        reason: string;
        errorCode: 'SessionChanged' | 'RecordChanged' | 'BatchSequenceInvalid' | 'BatchSequenceGap' | 'StaleBootGeneration';
      } {
    const id = options.identity;
    if (id?.sessionId !== undefined && id.sessionId !== this.identity.sessionId) {
      const reason = `会话 ID 不匹配: expected=${this.identity.sessionId}, actual=${id.sessionId}`;
      this.emitDiagnostic(out, 'error', 'identity-mismatch', reason, this.currentSegmentByteOffset);
      return { ok: false, reason, errorCode: 'SessionChanged' };
    }
    if (id?.sessionGeneration !== undefined && id.sessionGeneration !== this.identity.sessionGeneration) {
      const reason = `会话代次不匹配: expected=${this.identity.sessionGeneration}, actual=${id.sessionGeneration}`;
      this.emitDiagnostic(out, 'error', 'identity-mismatch', reason, this.currentSegmentByteOffset);
      return { ok: false, reason, errorCode: 'SessionChanged' };
    }
    if (id?.recordId !== undefined && id.recordId !== this.identity.recordId) {
      const reason = `录制 ID 不匹配: expected=${this.identity.recordId}, actual=${id.recordId}`;
      this.emitDiagnostic(out, 'error', 'identity-mismatch', reason, this.currentSegmentByteOffset);
      return { ok: false, reason, errorCode: 'RecordChanged' };
    }
    // batchSequence 归属宿主录制流（不随 bootGeneration 重置）：必须连续递增，除非此前已显式调用 markGap()
    if (options.batchSequence !== undefined) {
      if (!Number.isInteger(options.batchSequence) || options.batchSequence < 0) {
        const reason = `非法批次序号: ${options.batchSequence}`;
        this.emitDiagnostic(out, 'error', 'batch-out-of-order', reason, this.currentSegmentByteOffset);
        return { ok: false, reason, errorCode: 'BatchSequenceInvalid' };
      }
      if (this.lastBatchSequence !== null) {
        if (options.batchSequence <= this.lastBatchSequence) {
          const reason = `批次序号乱序或重复: last=${this.lastBatchSequence}, received=${options.batchSequence}`;
          this.emitDiagnostic(out, 'error', 'batch-out-of-order', reason, this.currentSegmentByteOffset);
          return { ok: false, reason, errorCode: 'BatchSequenceInvalid' };
        }
        if (options.batchSequence !== this.lastBatchSequence + 1 && !this.sequenceGapDeclared) {
          const reason = `批次序号不连续（存在未送达批次）: expected=${this.lastBatchSequence + 1}, received=${options.batchSequence}`;
          this.emitDiagnostic(
            out,
            'error',
            'batch-sequence-gap',
            reason,
            this.currentSegmentByteOffset,
            { expectedBatchSequence: this.lastBatchSequence + 1, receivedBatchSequence: options.batchSequence },
          );
          return { ok: false, reason, errorCode: 'BatchSequenceGap' };
        }
      }
    }
    if (id?.bootGeneration !== undefined && id.bootGeneration !== this.identity.bootGeneration) {
      if (!Number.isInteger(id.bootGeneration) || id.bootGeneration < this.identity.bootGeneration) {
        const reason = `过期 bootGeneration: current=${this.identity.bootGeneration}, received=${id.bootGeneration}`;
        this.emitDiagnostic(out, 'error', 'identity-mismatch', reason, this.currentSegmentByteOffset);
        return { ok: false, reason, errorCode: 'StaleBootGeneration' };
      }
      this.handleBootReset(id.bootGeneration, `bootGeneration 变更 (${this.identity.bootGeneration} -> ${id.bootGeneration})`, out);
    }
    if (options.batchSequence !== undefined) {
      this.lastBatchSequence = options.batchSequence;
      this.sequenceGapDeclared = false;
    }
    return { ok: true };
  }

  private handleBootReset(nextBootGeneration: number, reason: string, out: MutableReconstructBatch): void {
    const closedCount = this.closeAllOpenIntervals('target-reset', undefined, out);
    out.gapBoundaries.push({
      kind: 'target-reset',
      bootGeneration: this.identity.bootGeneration,
      segmentIdBefore: this.currentSegmentId ?? undefined,
      byteOffset: this.currentSegmentByteOffset,
      droppedPackets: 'unknown',
      droppedBytes: 'unknown',
      reason,
      closedOpenCount: closedCount,
    });
    this.emitDiagnostic(
      out,
      'warning',
      'target-reset',
      reason,
      this.currentSegmentByteOffset,
      { previousBootGeneration: this.identity.bootGeneration, nextBootGeneration, closedOpenCount: closedCount },
    );

    this.identity = {
      ...this.identity,
      bootGeneration: nextBootGeneration,
    };
    this.currentSegmentId = null;
    this.currentSegmentReliability = null;
    this.currentSegmentTimeUncertain = false;
    this.currentSegmentSysFreqHz = undefined;
    this.lastPacketInSegment = null;
    this.continuityEpoch += 1;
    this.clearBootAndSegmentState();
  }

  private clearBootAndSegmentState(): void {
    this.activeSlice = null;
    this.baseContextKind = null;
    this.activeTaskActivation = null;
    this.isrStack = [];
    this.timerStack = [];
    this.openReadyWaits.clear();
    this.openMarkers.clear();
    this.taskGenerationByKey.clear();
    this.tasksByKey.clear();
    this.irqNames.clear();
    this.markerNames.clear();
    this.resourceNames.clear();
    this.taskInstanceSeq = 0;
    this.addressGenerationLruEvicted = false;
    this.hasOpaqueLossGap = false;
  }

  private enterSegment(
    segmentId: number,
    reliability: SegmentReliability,
    byteOffset: number,
    sysFreqHz: number | undefined,
    out: MutableReconstructBatch,
  ): void {
    this.currentSegmentId = segmentId;
    this.currentSegmentReliability = reliability;
    this.currentSegmentTimeUncertain = false;
    this.currentSegmentSysFreqHz = sysFreqHz;
    this.currentSegmentByteOffset = byteOffset;
    this.lastPacketInSegment = null;
    if (reliability === 'uncertain') {
      this.emitDiagnostic(
        out,
        'warning',
        'uncertain-segment',
        `进入不确定段 #${segmentId}（之前存在解码错误或未重同步），区间结果将标为 uncertain`,
        byteOffset,
      );
    }
  }

  private handleDecoderGap(gap: TraceGapRecord, out: MutableReconstructBatch): void {
    this.closeSegmentBoundary(
      gap.kind,
      gap.byteOffset,
      gap.droppedPackets,
      gap.droppedBytes,
      gap.reason,
      out,
      gap.segmentIdBefore,
    );
  }

  private closeSegmentBoundary(
    endReason: ReconstructorGapBoundary['kind'],
    byteOffset: number,
    droppedPackets: number | 'unknown',
    droppedBytes: number | 'unknown',
    reason: string,
    out: MutableReconstructBatch,
    explicitSegmentId?: number,
  ): void {
    const segBefore = explicitSegmentId ?? this.currentSegmentId ?? undefined;
    const closedCount = this.closeAllOpenIntervals(endReason, undefined, out);
    if (closedCount > 0) {
      this.emitDiagnostic(
        out,
        'warning',
        'gap-closed-open-intervals',
        `边界 (${endReason}) 切断 ${closedCount} 个未闭合区间/等待/Marker`,
        byteOffset,
        { endReason, closedOpenCount: closedCount },
      );
    }
    out.gapBoundaries.push({
      kind: endReason,
      bootGeneration: this.identity.bootGeneration,
      segmentIdBefore: segBefore,
      byteOffset,
      droppedPackets,
      droppedBytes,
      reason,
      closedOpenCount: closedCount,
    });

    // 若缺口可能跨越任务删除与重建（如传输丢包、overflow、失步、截断、控制暂停），必须隔离此前任务身份与标签，
    // 保留 taskGenerationByKey 以便后续同地址推进到新代次，绝不沿用缺口前名称或合并为同一历史实例。
    if (isOpaqueTaskLossGap(endReason)) {
      this.hasOpaqueLossGap = true;
      this.tasksByKey.clear();
    } else {
      for (const task of this.tasksByKey.values()) {
        task.lastStopReadyCause = undefined;
      }
    }

    this.continuityEpoch += 1;
    this.currentSegmentId = null;
    this.currentSegmentReliability = null;
    this.currentSegmentTimeUncertain = false;
    this.currentSegmentSysFreqHz = undefined;
    this.lastPacketInSegment = null;
  }

  /**
   * 仅关闭当前活跃执行/嵌套/Ready/Marker，不丢弃同 boot 下已建立的任务名称与代次，但标明不可跨缺口伪造区间。
   */
  private closeAllOpenIntervals(
    endReason: string,
    observedUntil: TraceTimePoint | undefined,
    out: MutableReconstructBatch,
  ): number {
    let closedCount = 0;

    if (this.activeSlice) {
      this.emitIncompleteSlice(this.activeSlice, endReason, observedUntil, out);
      this.activeSlice = null;
      closedCount += 1;
    }

    while (this.isrStack.length > 0) {
      const frame = this.isrStack.pop()!;
      this.emitIncompleteIsrActivation(frame, endReason, observedUntil, out);
      closedCount += 1;
    }

    while (this.timerStack.length > 0) {
      const timer = this.timerStack.pop()!;
      this.emitIncompleteTimerActivation(timer, endReason, observedUntil, out);
      closedCount += 1;
    }

    if (this.activeTaskActivation) {
      this.emitIncompleteTaskActivation(this.activeTaskActivation, endReason, observedUntil, out);
      this.activeTaskActivation = null;
      closedCount += 1;
    }
    this.baseContextKind = null;

    for (const ready of this.openReadyWaits.values()) {
      this.emitIncompleteReadyWait(ready, endReason, observedUntil, out);
      closedCount += 1;
    }
    this.openReadyWaits.clear();

    for (const marker of this.openMarkers.values()) {
      this.emitIncompleteMarker(marker, endReason, observedUntil, out);
      closedCount += 1;
    }
    this.openMarkers.clear();

    return closedCount;
  }

  private processPacket(pkt: DecodedSystemViewPacket, out: MutableReconstructBatch): void {
    this.totalPacketsProcessed += 1;
    this.currentSegmentByteOffset = pkt.streamByteOffset + pkt.byteLength;
    if (pkt.sysFreqHz !== undefined) {
      this.currentSegmentSysFreqHz = pkt.sysFreqHz;
    }

    // 检查段内时间单调性（失序）与 timeAnchorStatus === 'uncertain'
    if (this.lastPacketInSegment && pkt.segmentRelativeTicksBigInt < this.lastPacketInSegment.segmentRelativeTicksBigInt) {
      this.currentSegmentTimeUncertain = true;
      this.taintAllOpenIntervals();
      this.emitDiagnostic(
        out,
        'error',
        'timestamp-out-of-order',
        `段 #${pkt.segmentId} 时间回退: ${this.lastPacketInSegment.segmentRelativeTicks} -> ${pkt.segmentRelativeTicks}`,
        pkt.streamByteOffset,
        {
          previousTicks: this.lastPacketInSegment.segmentRelativeTicks,
          currentTicks: pkt.segmentRelativeTicks,
        },
        pkt.segmentRelativeTicks,
      );
    }

    if (pkt.timeAnchorStatus === 'uncertain' && !this.currentSegmentTimeUncertain) {
      this.currentSegmentTimeUncertain = true;
      this.taintAllOpenIntervals();
      this.emitDiagnostic(
        out,
        'warning',
        'uncertain-time-continuity',
        `段 #${pkt.segmentId} 时间连续性进入 uncertain 状态（可能存在位宽溢出或锚点冲突），跨该点的区间持续时间不予采信`,
        pkt.streamByteOffset,
        undefined,
        pkt.segmentRelativeTicks,
      );
    }

    const time = toTraceTimePoint(pkt);
    const decoded = pkt.decoded;

    switch (decoded.kind) {
      case 'sysdesc':
        this.handleSysDesc(decoded.parsed.interrupts);
        break;

      case 'ex-name-marker':
        this.setBoundedMap(this.markerNames, decoded.markerId, decoded.name, this.maxMarkerNames);
        break;

      case 'name-resource':
        if (decoded.resourceId !== undefined && decoded.idResolution === 'resolved') {
          this.setBoundedMap(this.resourceNames, decoded.resourceId, decoded.name, this.maxResourceNames);
        }
        break;

      case 'task-create':
        this.handleTaskCreate(decoded.shrunkTaskId, decoded.taskId, decoded.idResolution, pkt, time, out);
        break;

      case 'task-info':
        this.handleTaskInfo(
          decoded.shrunkTaskId,
          decoded.taskId,
          decoded.idResolution,
          decoded.priority,
          decoded.name,
          pkt,
          time,
          out,
        );
        break;

      case 'stack-info':
        this.handleStackInfo(
          decoded.shrunkTaskId,
          decoded.taskId,
          decoded.idResolution,
          decoded.stackBase,
          decoded.stackSize,
          decoded.stackUsage,
          pkt,
          time,
          out,
        );
        break;

      case 'task-terminate':
        this.handleTaskTerminate(decoded.shrunkTaskId, decoded.taskId, decoded.idResolution, pkt, time, out);
        break;

      case 'os-freertos':
        if (decoded.apiId === FREERTOS_API_ID_VTASKDELETE && decoded.params && decoded.params.length >= 1) {
          const p0 = decoded.params[0];
          this.handleOsTaskDelete(
            p0.rawValue,
            p0.resolvedId,
            p0.idResolution ?? 'unresolved-missing-init',
            pkt,
            time,
            out,
          );
        }
        break;

      case 'task-start-ready':
        this.handleTaskStartReady(decoded.shrunkTaskId, decoded.taskId, decoded.idResolution, pkt, time, out);
        break;

      case 'task-stop-ready':
        this.handleTaskStopReady(decoded.shrunkTaskId, decoded.taskId, decoded.idResolution, decoded.cause, pkt, time, out);
        break;

      case 'task-start-exec':
        this.handleTaskStartExec(decoded.shrunkTaskId, decoded.taskId, decoded.idResolution, pkt, time, out);
        break;

      case 'task-stop-exec':
        this.handleTaskStopExec(pkt, time, out);
        break;

      case 'idle':
        this.handleIdle(pkt, time, out);
        break;

      case 'isr-enter':
        this.handleIsrEnter(decoded.irqId, pkt, time, out);
        break;

      case 'isr-exit':
        this.handleIsrExit(pkt, time, out);
        break;

      case 'isr-to-scheduler':
        this.handleIsrToScheduler(pkt, time, out);
        break;

      case 'timer-enter':
        this.handleTimerEnter(decoded.shrunkTimerId, decoded.timerId, decoded.idResolution, pkt, time, out);
        break;

      case 'timer-exit':
        this.handleTimerExit(pkt, time, out);
        break;

      case 'mark-start':
        this.handleMarkStart(decoded.markerId, pkt, time, out);
        break;

      case 'mark-stop':
        this.handleMarkStop(decoded.markerId, pkt, time, out);
        break;

      case 'ex-mark':
        this.handleExMark(decoded.markerId, pkt, time, out);
        break;

      case 'trace-stop':
        this.closeAllOpenIntervals('trace-stop', time, out);
        break;

      default:
        break;
    }

    this.lastPacketInSegment = pkt;
  }

  private handleSysDesc(interrupts: Readonly<Record<number, string>>): void {
    for (const [irqKey, name] of Object.entries(interrupts)) {
      const irqId = Number(irqKey);
      if (Number.isInteger(irqId)) {
        this.setBoundedMap(this.irqNames, irqId, name, this.maxIrqDescriptions);
      }
    }
  }

  private handleTaskCreate(
    shrunkTaskId: number,
    taskId: number | undefined,
    idResolution: AddressResolutionStatus,
    pkt: DecodedSystemViewPacket,
    time: TraceTimePoint,
    out: MutableReconstructBatch,
  ): void {
    if (idResolution !== 'resolved') {
      this.emitDiagnostic(
        out,
        'warning',
        'missing-init-for-id',
        `TASK_CREATE 缺少有效 INIT 元数据 (${idResolution})，保留未解析 shrunkId=${shrunkTaskId}`,
        pkt.streamByteOffset,
        { shrunkTaskId, idResolution },
        pkt.segmentRelativeTicks,
      );
    }

    const lookupKey = makeTaskLookupKey(shrunkTaskId, taskId, idResolution);
    const existing = this.tasksByKey.get(lookupKey);
    if (existing && !existing.terminated) {
      this.emitDiagnostic(
        out,
        'warning',
        'task-recreated-without-delete',
        `地址 ${formatTaskRef(taskId, shrunkTaskId)} 在未见终止事件情况下重新 TASK_CREATE，切断旧代次 #${existing.generation}`,
        pkt.streamByteOffset,
        { taskInstanceId: existing.taskInstanceId, previousGeneration: existing.generation },
        pkt.segmentRelativeTicks,
      );
      this.retireTaskInstance(existing, 'recreated-implicitly', time, 'task-recreated-without-delete', out);
    }

    const nextGen = (this.taskGenerationByKey.get(lookupKey) ?? 0) + 1;
    this.setBoundedGeneration(lookupKey, nextGen);

    const instance = this.createTaskInstance({
      lookupKey,
      tcbAddress: idResolution === 'resolved' ? taskId : undefined,
      addressStatus: idResolution,
      shrunkTaskId,
      generation: nextGen,
      segmentId: pkt.segmentId,
      createdInTrace: true,
      createdAt: time,
      identityConfidence: 'created-in-segment',
    });

    out.taskUpdates.push(summarizeTask(instance));
  }

  private handleTaskInfo(
    shrunkTaskId: number,
    taskId: number | undefined,
    idResolution: AddressResolutionStatus,
    priority: number,
    name: string,
    pkt: DecodedSystemViewPacket,
    _time: TraceTimePoint,
    out: MutableReconstructBatch,
  ): void {
    if (idResolution !== 'resolved') {
      this.emitDiagnostic(
        out,
        'warning',
        'missing-init-for-id',
        `TASK_INFO 缺少有效 INIT 元数据 (${idResolution})，shrunkId=${shrunkTaskId}`,
        pkt.streamByteOffset,
        { shrunkTaskId, idResolution, name },
        pkt.segmentRelativeTicks,
      );
    }
    const instance = this.getOrCreateTaskForObservation(
      shrunkTaskId,
      taskId,
      idResolution,
      pkt.segmentId,
      'task-info-in-boot',
      false,
      out,
      pkt,
    );
    instance.name = name;
    instance.nameSource = 'task-info';
    instance.priority = priority;
    instance.carriedAcrossGap = false;
    if (!instance.createdInTrace) {
      instance.identityConfidence = 'task-info-in-boot';
    } else {
      instance.identityConfidence = 'created-in-segment';
    }
    this.refreshOpenTaskLabels(instance);
    out.taskUpdates.push(summarizeTask(instance));
  }

  private handleStackInfo(
    shrunkTaskId: number,
    taskId: number | undefined,
    idResolution: AddressResolutionStatus,
    stackBase: number,
    stackSize: number,
    stackUsage: number,
    pkt: DecodedSystemViewPacket,
    _time: TraceTimePoint,
    out: MutableReconstructBatch,
  ): void {
    const instance = this.getOrCreateTaskForObservation(
      shrunkTaskId,
      taskId,
      idResolution,
      pkt.segmentId,
      'observed-mid-stream',
      false,
      out,
      pkt,
    );
    instance.stackInfo = {
      stackBase,
      stackSize,
      stackUsage,
      segmentId: pkt.segmentId,
      relativeTicks: pkt.segmentRelativeTicks,
    };
    out.taskUpdates.push(summarizeTask(instance));
  }

  private handleTaskTerminate(
    shrunkTaskId: number,
    taskId: number | undefined,
    idResolution: AddressResolutionStatus,
    pkt: DecodedSystemViewPacket,
    time: TraceTimePoint,
    out: MutableReconstructBatch,
  ): void {
    const lookupKey = makeTaskLookupKey(shrunkTaskId, taskId, idResolution);
    const existing = this.tasksByKey.get(lookupKey);
    if (!existing) {
      this.emitDiagnostic(
        out,
        'warning',
        'terminate-unknown-task',
        `未见创建/信息即收到 TASK_TERMINATE (${formatTaskRef(taskId, shrunkTaskId)})，不伪造起始创建期`,
        pkt.streamByteOffset,
        { shrunkTaskId, taskId },
        pkt.segmentRelativeTicks,
      );
      const gen = (this.taskGenerationByKey.get(lookupKey) ?? 0) + 1;
      this.setBoundedGeneration(lookupKey, gen);
      const phantom = this.createTaskInstance({
        lookupKey,
        tcbAddress: idResolution === 'resolved' ? taskId : undefined,
        addressStatus: idResolution,
        shrunkTaskId,
        generation: gen,
        segmentId: pkt.segmentId,
        createdInTrace: false,
        identityConfidence: 'observed-mid-stream',
      });
      phantom.terminated = true;
      phantom.terminatedAt = time;
      phantom.terminationSource = 'task-terminate';
      out.taskUpdates.push(summarizeTask(phantom));
      return;
    }

    if (existing.terminated) {
      this.emitDiagnostic(
        out,
        'warning',
        'post-terminate-activity',
        `任务 ${existing.taskInstanceId} 重复收到 TASK_TERMINATE`,
        pkt.streamByteOffset,
        { taskInstanceId: existing.taskInstanceId },
        pkt.segmentRelativeTicks,
      );
      return;
    }

    this.retireTaskInstance(existing, 'task-terminate', time, 'task-terminate', out);
    out.taskUpdates.push(summarizeTask(existing));
  }

  private handleOsTaskDelete(
    shrunkTaskId: number,
    taskId: number | undefined,
    idResolution: AddressResolutionStatus,
    pkt: DecodedSystemViewPacket,
    time: TraceTimePoint,
    out: MutableReconstructBatch,
  ): void {
    const lookupKey = makeTaskLookupKey(shrunkTaskId, taskId, idResolution);
    const existing = this.tasksByKey.get(lookupKey);
    if (!existing) {
      return;
    }
    if (existing.terminated) {
      this.emitDiagnostic(
        out,
        'warning',
        'post-terminate-activity',
        `任务 ${existing.taskInstanceId} 已终止后再次收到 OS_vTaskDelete`,
        pkt.streamByteOffset,
        { taskInstanceId: existing.taskInstanceId },
        pkt.segmentRelativeTicks,
      );
      return;
    }

    // FreeRTOS vTaskDelete(NULL) 在自删切换出去前仍短暂执行 portYIELD，需等待切换出后完成终止
    if (this.activeTaskActivation?.taskInstanceId === existing.taskInstanceId) {
      existing.pendingSelfDelete = true;
      const openReady = this.openReadyWaits.get(lookupKey);
      if (openReady) {
        this.openReadyWaits.delete(lookupKey);
        this.emitIncompleteReadyWait(openReady, 'os-vtask-delete', time, out);
      }
      return;
    }

    this.retireTaskInstance(existing, 'os-vtask-delete', time, 'os-vtask-delete', out);
    out.taskUpdates.push(summarizeTask(existing));
  }

  private retireTaskInstance(
    instance: InternalTaskInstance,
    terminationSource: NonNullable<InternalTaskInstance['terminationSource']>,
    time: TraceTimePoint,
    endReason: string,
    out: MutableReconstructBatch,
  ): void {
    instance.terminated = true;
    instance.terminatedAt = time;
    instance.terminationSource = terminationSource;
    instance.pendingSelfDelete = false;

    const openReady = this.openReadyWaits.get(instance.lookupKey);
    if (openReady) {
      this.openReadyWaits.delete(instance.lookupKey);
      this.emitIncompleteReadyWait(openReady, endReason, time, out);
    }

    if (this.activeTaskActivation?.taskInstanceId === instance.taskInstanceId) {
      if (this.isrStack.length === 0 && this.activeSlice?.contextKind === 'task' && this.activeSlice.taskInstanceId === instance.taskInstanceId) {
        this.closeActiveSliceComplete(time, endReason, out);
        this.closeActiveTaskActivationComplete(time, endReason, out);
      } else {
        if (this.activeSlice?.taskInstanceId === instance.taskInstanceId) {
          this.emitIncompleteSlice(this.activeSlice, `${endReason}-during-isr`, time, out);
          this.activeSlice = null;
        }
        this.emitIncompleteTaskActivation(this.activeTaskActivation, `${endReason}-during-isr`, time, out);
        this.activeTaskActivation = null;
      }
      this.baseContextKind = null;
    }
  }

  private handleTaskStartReady(
    shrunkTaskId: number,
    taskId: number | undefined,
    idResolution: AddressResolutionStatus,
    pkt: DecodedSystemViewPacket,
    time: TraceTimePoint,
    out: MutableReconstructBatch,
  ): void {
    if (idResolution !== 'resolved') {
      this.emitDiagnostic(
        out,
        'warning',
        'missing-init-for-id',
        `TASK_START_READY 缺少有效 INIT 元数据 (${idResolution})，shrunkId=${shrunkTaskId}`,
        pkt.streamByteOffset,
        { shrunkTaskId, idResolution },
        pkt.segmentRelativeTicks,
      );
    }

    const instance = this.getOrCreateTaskForObservation(
      shrunkTaskId,
      taskId,
      idResolution,
      pkt.segmentId,
      'observed-mid-stream',
      true,
      out,
      pkt,
    );

    // 若任务当前正在运行（如 vTaskPrioritySet(NULL, ...) 调用 prvAddTaskToReadyList），它不在等待调度
    if (this.activeTaskActivation?.taskInstanceId === instance.taskInstanceId) {
      this.emitDiagnostic(
        out,
        'info',
        'ready-while-running',
        `运行中的任务 ${instance.taskInstanceId} 触发 TASK_START_READY（如自调优先级），不计为 Ready 等待`,
        pkt.streamByteOffset,
        { taskInstanceId: instance.taskInstanceId },
        pkt.segmentRelativeTicks,
      );
      return;
    }

    const existingReady = this.openReadyWaits.get(instance.lookupKey);
    if (existingReady) {
      this.openReadyWaits.delete(instance.lookupKey);
      this.emitDiagnostic(
        out,
        'warning',
        'duplicate-task-ready',
        `任务 ${instance.taskInstanceId} 连续触发 TASK_START_READY 而未见中间切换或 STOP_READY，前段 Ready 标为不完整`,
        pkt.streamByteOffset,
        { taskInstanceId: instance.taskInstanceId },
        pkt.segmentRelativeTicks,
      );
      this.emitIncompleteReadyWait(existingReady, 'duplicate-task-ready', time, out);
    }

    if (this.openReadyWaits.size >= this.maxOpenReadyTasks) {
      this.evictOldestOpenReady(out, pkt);
    }

    const wait: OpenReadyState = {
      waitId: this.nextId('ready'),
      bootGeneration: this.identity.bootGeneration,
      segmentId: pkt.segmentId,
      segmentReliability: pkt.segmentReliability,
      taskInstanceId: instance.taskInstanceId,
      lookupKey: instance.lookupKey,
      tcbAddress: instance.tcbAddress,
      shrunkTaskId: instance.shrunkTaskId,
      taskGeneration: instance.generation,
      label: instance.name,
      labelSource: instance.nameSource,
      start: time,
      tainted: this.currentSegmentTimeUncertain || pkt.segmentReliability === 'uncertain',
    };
    this.openReadyWaits.set(instance.lookupKey, wait);
    if (this.openReadyWaits.size > this.peakOpenReadyCount) {
      this.peakOpenReadyCount = this.openReadyWaits.size;
    }
  }

  private handleTaskStopReady(
    shrunkTaskId: number,
    taskId: number | undefined,
    idResolution: AddressResolutionStatus,
    cause: number,
    pkt: DecodedSystemViewPacket,
    time: TraceTimePoint,
    out: MutableReconstructBatch,
  ): void {
    const instance = this.getOrCreateTaskForObservation(
      shrunkTaskId,
      taskId,
      idResolution,
      pkt.segmentId,
      'observed-mid-stream',
      true,
      out,
      pkt,
    );

    const openReady = this.openReadyWaits.get(instance.lookupKey);
    if (openReady) {
      this.openReadyWaits.delete(instance.lookupKey);
      this.emitClosedReadyWait(openReady, time, 'removed-from-ready', 'stop-ready', cause, out);
      return;
    }

    // 依据 SEGGER_SYSVIEW_FreeRTOS.h：当前运行任务阻塞/挂起前会触发 OnTaskStopReady(pxCurrentTCB, cause)
    if (this.activeTaskActivation?.taskInstanceId === instance.taskInstanceId) {
      instance.lastStopReadyCause = cause;
      return;
    }

    // 非当前运行且无前置 TASK_START_READY：多见于录制中途开始或丢包后
    this.emitDiagnostic(
      out,
      'warning',
      'missing-ready-start',
      `任务 ${instance.taskInstanceId} 收到 TASK_STOP_READY(cause=${cause}) 但缺少对应的 TASK_START_READY`,
      pkt.streamByteOffset,
      { taskInstanceId: instance.taskInstanceId, cause },
      pkt.segmentRelativeTicks,
    );
    const interval: ReadyWaitInterval = {
      waitId: this.nextId('ready'),
      bootGeneration: this.identity.bootGeneration,
      segmentId: pkt.segmentId,
      segmentReliability: pkt.segmentReliability,
      completeness: 'incomplete',
      outcome: 'incomplete',
      taskInstanceId: instance.taskInstanceId,
      tcbAddress: instance.tcbAddress,
      shrunkTaskId: instance.shrunkTaskId,
      taskGeneration: instance.generation,
      label: instance.name,
      labelSource: instance.nameSource,
      start: undefined,
      end: undefined,
      observedUntil: time,
      stopCause: cause,
      timeDomain: 'unknown',
      endReason: 'stop-ready-without-start',
    };
    this.pushReadyWait(out, interval);
  }

  private handleTaskStartExec(
    shrunkTaskId: number,
    taskId: number | undefined,
    idResolution: AddressResolutionStatus,
    pkt: DecodedSystemViewPacket,
    time: TraceTimePoint,
    out: MutableReconstructBatch,
  ): void {
    if (idResolution !== 'resolved') {
      this.emitDiagnostic(
        out,
        'warning',
        'missing-init-for-id',
        `TASK_START_EXEC 缺少有效 INIT 元数据 (${idResolution})，shrunkId=${shrunkTaskId}`,
        pkt.streamByteOffset,
        { shrunkTaskId, idResolution },
        pkt.segmentRelativeTicks,
      );
    }

    // 若 ISR 栈未清空就切换任务，说明缺失 ISR_EXIT / ISR_TO_SCHEDULER
    if (this.isrStack.length > 0) {
      this.handleMissingIsrExitsOnTaskSwitch(pkt, time, out);
    }

    const instance = this.getOrCreateTaskForObservation(
      shrunkTaskId,
      taskId,
      idResolution,
      pkt.segmentId,
      'observed-mid-stream',
      true,
      out,
      pkt,
    );

    // 闭合此前基底上下文（前一个任务 / IDLE / 调度器）
    this.closeCurrentBaseContext(time, 'task-switch', out, instance.taskInstanceId);

    // 核对 Ready -> Running 完整链条
    let readyChainStatus: ReadyChainStatus;
    let matchedReadyWaitId: string | undefined;
    const openReady = this.openReadyWaits.get(instance.lookupKey);
    if (openReady) {
      this.openReadyWaits.delete(instance.lookupKey);
      const emitted = this.emitClosedReadyWait(openReady, time, 'dispatched', 'start-exec', undefined, out);
      if (emitted.completeness === 'complete') {
        readyChainStatus = 'matched-ready';
        matchedReadyWaitId = emitted.waitId;
      } else {
        readyChainStatus = 'uncertain';
      }
    } else if (instance.carriedAcrossGap) {
      readyChainStatus = 'post-gap-unknown';
    } else {
      readyChainStatus = 'no-start-ready';
    }

    this.baseContextKind = 'task';
    this.activeTaskActivation = {
      activationId: this.nextId('act'),
      bootGeneration: this.identity.bootGeneration,
      segmentId: pkt.segmentId,
      segmentReliability: pkt.segmentReliability,
      taskInstanceId: instance.taskInstanceId,
      contextKey: instance.taskInstanceId,
      tcbAddress: instance.tcbAddress,
      shrunkTaskId: instance.shrunkTaskId,
      taskGeneration: instance.generation,
      label: instance.name,
      labelSource: instance.nameSource,
      start: time,
      exclusiveTicks: 0n,
      preemptionCount: 0,
      readyChainStatus,
      matchedReadyWaitId,
      tainted: this.currentSegmentTimeUncertain || pkt.segmentReliability === 'uncertain',
    };

    this.activeSlice = {
      sliceId: this.nextId('slice'),
      bootGeneration: this.identity.bootGeneration,
      segmentId: pkt.segmentId,
      segmentReliability: pkt.segmentReliability,
      contextKind: 'task',
      contextKey: instance.taskInstanceId,
      taskInstanceId: instance.taskInstanceId,
      tcbAddress: instance.tcbAddress,
      shrunkTaskId: instance.shrunkTaskId,
      taskGeneration: instance.generation,
      isrDepth: 0,
      label: instance.name,
      labelSource: instance.nameSource,
      start: time,
      startReason: 'task-start-exec',
      tainted: this.currentSegmentTimeUncertain || pkt.segmentReliability === 'uncertain',
    };
  }

  private handleTaskStopExec(pkt: DecodedSystemViewPacket, time: TraceTimePoint, out: MutableReconstructBatch): void {
    if (this.isrStack.length > 0) {
      this.handleMissingIsrExitsOnTaskSwitch(pkt, time, out);
    }
    if (!this.activeTaskActivation && this.baseContextKind === null) {
      this.emitDiagnostic(
        out,
        'warning',
        'orphan-task-stop-exec',
        '收到 TASK_STOP_EXEC 但当前无已知运行任务（可能录制中途开始）',
        pkt.streamByteOffset,
        undefined,
        pkt.segmentRelativeTicks,
      );
      const slice: ExecutionSliceInterval = {
        sliceId: this.nextId('slice'),
        bootGeneration: this.identity.bootGeneration,
        segmentId: pkt.segmentId,
        segmentReliability: pkt.segmentReliability,
        completeness: 'incomplete',
        contextKind: 'task',
        contextKey: `b${this.identity.bootGeneration}:unknown-task`,
        isrDepth: 0,
        labelSource: 'missing',
        start: undefined,
        end: undefined,
        observedUntil: time,
        timeDomain: 'unknown',
        startReason: 'unknown',
        endReason: 'orphan-task-stop-exec',
      };
      this.pushSlice(out, slice);
      return;
    }

    this.closeCurrentBaseContext(time, 'task-stop-exec', out);
  }

  private handleIdle(pkt: DecodedSystemViewPacket, time: TraceTimePoint, out: MutableReconstructBatch): void {
    if (this.isrStack.length > 0) {
      this.handleMissingIsrExitsOnTaskSwitch(pkt, time, out);
    }

    this.closeCurrentBaseContext(time, 'idle-switch', out);
    this.baseContextKind = 'idle';
    this.activeSlice = {
      sliceId: this.nextId('slice'),
      bootGeneration: this.identity.bootGeneration,
      segmentId: pkt.segmentId,
      segmentReliability: pkt.segmentReliability,
      contextKind: 'idle',
      contextKey: `b${this.identity.bootGeneration}:idle`,
      isrDepth: 0,
      label: this.idleResumedLabel,
      labelSource: 'fixed-idle',
      start: time,
      startReason: 'idle',
      tainted: this.currentSegmentTimeUncertain || pkt.segmentReliability === 'uncertain',
    };
  }

  private handleIsrEnter(irqId: number, pkt: DecodedSystemViewPacket, time: TraceTimePoint, out: MutableReconstructBatch): void {
    // 抢占当前独占执行切片（外层 ISR / 任务 / IDLE / 调度器）
    if (this.activeSlice) {
      this.closeActiveSliceComplete(time, 'preempted-by-isr', out);
    }
    if (this.isrStack.length > 0) {
      this.isrStack[this.isrStack.length - 1].preemptionCount += 1;
    } else if (this.activeTaskActivation) {
      this.activeTaskActivation.preemptionCount += 1;
    }
    if (this.timerStack.length > 0) {
      this.timerStack[this.timerStack.length - 1].preemptionCount += 1;
    }

    // 单核 NVIC 上同一 irqId 不可能合法重入自身
    const duplicateIdx = this.isrStack.findIndex((f) => f.irqId === irqId);
    let tainted = this.currentSegmentTimeUncertain || pkt.segmentReliability === 'uncertain';
    if (duplicateIdx >= 0) {
      tainted = true;
      this.isrStack[duplicateIdx].tainted = true;
      this.emitDiagnostic(
        out,
        'error',
        'illegal-isr-reentry',
        `单核上检测到 ISR #${irqId} 非法重入（当前嵌套深度 ${this.isrStack.length}）`,
        pkt.streamByteOffset,
        { irqId, activeStack: this.isrStack.map((f) => f.irqId) },
        pkt.segmentRelativeTicks,
      );
    }

    if (this.isrStack.length >= this.maxIsrDepth) {
      this.totalBudgetEvictions += 1;
      this.taintAllOpenIntervals();
      this.emitDiagnostic(
        out,
        'error',
        'budget-exceeded',
        `ISR 嵌套深度超过预算上限 ${this.maxIsrDepth}，忽略后续栈帧并标为不完整`,
        pkt.streamByteOffset,
        { irqId, maxIsrDepth: this.maxIsrDepth },
        pkt.segmentRelativeTicks,
      );
      return;
    }

    const depth = this.isrStack.length + 1;
    if (depth > this.peakIsrDepth) {
      this.peakIsrDepth = depth;
    }
    const { label, labelSource } = this.resolveIrqLabel(irqId);
    const contextKey = `b${this.identity.bootGeneration}:isr:${irqId}`;

    const frame: OpenIsrFrameState = {
      activationId: this.nextId('isr'),
      bootGeneration: this.identity.bootGeneration,
      segmentId: pkt.segmentId,
      segmentReliability: pkt.segmentReliability,
      irqId,
      isrDepth: depth,
      contextKey,
      label,
      labelSource,
      start: time,
      exclusiveTicks: 0n,
      preemptionCount: 0,
      tainted,
    };
    this.isrStack.push(frame);

    this.activeSlice = {
      sliceId: this.nextId('slice'),
      bootGeneration: this.identity.bootGeneration,
      segmentId: pkt.segmentId,
      segmentReliability: pkt.segmentReliability,
      contextKind: 'isr',
      contextKey,
      irqId,
      isrDepth: depth,
      label,
      labelSource,
      start: time,
      startReason: 'isr-enter',
      tainted,
    };
  }

  private handleIsrExit(pkt: DecodedSystemViewPacket, time: TraceTimePoint, out: MutableReconstructBatch): void {
    if (this.isrStack.length === 0) {
      this.emitDiagnostic(
        out,
        'warning',
        'orphan-isr-exit',
        '收到 ISR_EXIT 但当前无活动 ISR 栈帧（可能录制中途开始或失序）',
        pkt.streamByteOffset,
        undefined,
        pkt.segmentRelativeTicks,
      );
      if (this.activeSlice) {
        this.emitIncompleteSlice(this.activeSlice, 'orphan-isr-exit', time, out);
        this.activeSlice = null;
      }
      if (this.activeTaskActivation) {
        this.emitIncompleteTaskActivation(this.activeTaskActivation, 'orphan-isr-exit', time, out);
        this.activeTaskActivation = null;
      }
      this.baseContextKind = null;
      this.pushActivation(out, {
        activationId: this.nextId('isr'),
        bootGeneration: this.identity.bootGeneration,
        segmentId: pkt.segmentId,
        segmentReliability: pkt.segmentReliability,
        completeness: 'incomplete',
        kind: 'isr',
        contextKey: `b${this.identity.bootGeneration}:isr:unknown`,
        labelSource: 'missing',
        start: undefined,
        end: undefined,
        observedUntil: time,
        preemptionCount: 0,
        timeDomain: 'unknown',
        endReason: 'orphan-isr-exit',
      });
      return;
    }

    this.closeActiveSliceComplete(time, 'isr-exit', out);
    const top = this.isrStack.pop()!;
    this.closeIsrActivation(top, time, 'isr-exit', out);
    this.resumeAfterIsrExit(pkt, time);
  }

  private handleIsrToScheduler(pkt: DecodedSystemViewPacket, time: TraceTimePoint, out: MutableReconstructBatch): void {
    if (this.isrStack.length === 0) {
      this.emitDiagnostic(
        out,
        'warning',
        'orphan-isr-to-scheduler',
        '收到 ISR_TO_SCHEDULER 但当前无活动 ISR 栈帧（可能录制中途开始或缺失 ISR_ENTER）',
        pkt.streamByteOffset,
        undefined,
        pkt.segmentRelativeTicks,
      );
      if (this.activeSlice) {
        this.emitIncompleteSlice(this.activeSlice, 'orphan-isr-to-scheduler', time, out);
        this.activeSlice = null;
      }
      if (this.activeTaskActivation) {
        this.emitIncompleteTaskActivation(this.activeTaskActivation, 'orphan-isr-to-scheduler', time, out);
        this.activeTaskActivation = null;
      }
      this.pushActivation(out, {
        activationId: this.nextId('isr'),
        bootGeneration: this.identity.bootGeneration,
        segmentId: pkt.segmentId,
        segmentReliability: pkt.segmentReliability,
        completeness: 'incomplete',
        kind: 'isr',
        contextKey: `b${this.identity.bootGeneration}:isr:unknown`,
        labelSource: 'missing',
        start: undefined,
        end: undefined,
        observedUntil: time,
        preemptionCount: 0,
        timeDomain: 'unknown',
        endReason: 'orphan-isr-to-scheduler',
      });
      this.enterSchedulerSlice(pkt, time);
      return;
    }

    this.closeActiveSliceComplete(time, 'isr-to-scheduler', out);
    const top = this.isrStack.pop()!;
    this.closeIsrActivation(top, time, 'isr-to-scheduler', out);

    if (this.isrStack.length > 0) {
      this.emitDiagnostic(
        out,
        'warning',
        'nested-isr-to-scheduler',
        `内层 ISR #${top.irqId} 在仍有外层 ISR (#${this.isrStack[this.isrStack.length - 1].irqId}) 时调用 ISR_TO_SCHEDULER`,
        pkt.streamByteOffset,
        { innerIrqId: top.irqId, remainingDepth: this.isrStack.length },
        pkt.segmentRelativeTicks,
      );
      this.resumeAfterIsrExit(pkt, time);
      return;
    }

    // 退出最外层 ISR 进入调度器：被抢占任务的执行驻留期到此结束，不再恢复用户代码执行
    if (this.activeTaskActivation) {
      const prevTaskKey = this.activeTaskActivation.taskInstanceId;
      this.closeActiveTaskActivationComplete(time, 'preempted-to-scheduler', out);
      this.finalizePendingSelfDelete(prevTaskKey, time, out);
    }
    this.enterSchedulerSlice(pkt, time);
  }

  private enterSchedulerSlice(pkt: DecodedSystemViewPacket, time: TraceTimePoint): void {
    this.baseContextKind = 'scheduler';
    this.activeSlice = {
      sliceId: this.nextId('slice'),
      bootGeneration: this.identity.bootGeneration,
      segmentId: pkt.segmentId,
      segmentReliability: pkt.segmentReliability,
      contextKind: 'scheduler',
      contextKey: `b${this.identity.bootGeneration}:scheduler`,
      isrDepth: 0,
      label: 'Scheduler',
      labelSource: 'fixed-scheduler',
      start: time,
      startReason: 'isr-to-scheduler',
      tainted: this.currentSegmentTimeUncertain || pkt.segmentReliability === 'uncertain',
    };
  }

  private resumeAfterIsrExit(pkt: DecodedSystemViewPacket, time: TraceTimePoint): void {
    const tainted = this.currentSegmentTimeUncertain || pkt.segmentReliability === 'uncertain';
    if (this.isrStack.length > 0) {
      const outer = this.isrStack[this.isrStack.length - 1];
      this.activeSlice = {
        sliceId: this.nextId('slice'),
        bootGeneration: this.identity.bootGeneration,
        segmentId: pkt.segmentId,
        segmentReliability: pkt.segmentReliability,
        contextKind: 'isr',
        contextKey: outer.contextKey,
        irqId: outer.irqId,
        isrDepth: outer.isrDepth,
        label: outer.label,
        labelSource: outer.labelSource,
        start: time,
        startReason: 'isr-resume',
        tainted: outer.tainted || tainted,
      };
      return;
    }

    if (this.baseContextKind === 'task' && this.activeTaskActivation) {
      const act = this.activeTaskActivation;
      this.activeSlice = {
        sliceId: this.nextId('slice'),
        bootGeneration: this.identity.bootGeneration,
        segmentId: pkt.segmentId,
        segmentReliability: pkt.segmentReliability,
        contextKind: 'task',
        contextKey: act.contextKey,
        taskInstanceId: act.taskInstanceId,
        tcbAddress: act.tcbAddress,
        shrunkTaskId: act.shrunkTaskId,
        taskGeneration: act.taskGeneration,
        isrDepth: 0,
        label: act.label,
        labelSource: act.labelSource,
        start: time,
        startReason: 'task-resume',
        tainted: act.tainted || tainted,
      };
    } else if (this.baseContextKind === 'idle') {
      this.activeSlice = {
        sliceId: this.nextId('slice'),
        bootGeneration: this.identity.bootGeneration,
        segmentId: pkt.segmentId,
        segmentReliability: pkt.segmentReliability,
        contextKind: 'idle',
        contextKey: `b${this.identity.bootGeneration}:idle`,
        isrDepth: 0,
        label: this.idleResumedLabel,
        labelSource: 'fixed-idle',
        start: time,
        startReason: 'idle-resume',
        tainted,
      };
    } else if (this.baseContextKind === 'scheduler') {
      this.enterSchedulerSlice(pkt, time);
    }
  }

  private handleMissingIsrExitsOnTaskSwitch(pkt: DecodedSystemViewPacket, time: TraceTimePoint, out: MutableReconstructBatch): void {
    this.emitDiagnostic(
      out,
      'error',
      'missing-isr-exit',
      `任务切换时仍有 ${this.isrStack.length} 层 ISR 未退出，未闭合 ISR 与被抢占任务区间标为不完整`,
      pkt.streamByteOffset,
      { unclosedIrqs: this.isrStack.map((f) => f.irqId) },
      pkt.segmentRelativeTicks,
    );
    if (this.activeSlice) {
      this.emitIncompleteSlice(this.activeSlice, 'missing-isr-exit', time, out);
      this.activeSlice = null;
    }
    while (this.isrStack.length > 0) {
      const frame = this.isrStack.pop()!;
      this.emitIncompleteIsrActivation(frame, 'missing-isr-exit', time, out);
    }
    if (this.activeTaskActivation) {
      this.activeTaskActivation.tainted = true;
    }
  }

  private handleTimerEnter(
    shrunkTimerId: number,
    timerId: number | undefined,
    idResolution: AddressResolutionStatus,
    pkt: DecodedSystemViewPacket,
    time: TraceTimePoint,
    out: MutableReconstructBatch,
  ): void {
    if (this.timerStack.length >= this.maxTimerDepth) {
      this.totalBudgetEvictions += 1;
      this.emitDiagnostic(
        out,
        'error',
        'budget-exceeded',
        `Timer 嵌套深度超过预算上限 ${this.maxTimerDepth}`,
        pkt.streamByteOffset,
        { shrunkTimerId, timerId },
        pkt.segmentRelativeTicks,
      );
      return;
    }
    const resolvedTimerId = idResolution === 'resolved' ? timerId : undefined;
    const { label, labelSource } = this.resolveResourceLabel(resolvedTimerId);
    const contextKey =
      resolvedTimerId !== undefined
        ? `b${this.identity.bootGeneration}:timer:0x${resolvedTimerId.toString(16)}`
        : `b${this.identity.bootGeneration}:timer-shrunk:${shrunkTimerId}`;

    this.timerStack.push({
      activationId: this.nextId('tmr'),
      bootGeneration: this.identity.bootGeneration,
      segmentId: pkt.segmentId,
      segmentReliability: pkt.segmentReliability,
      timerId: resolvedTimerId,
      shrunkTimerId,
      contextKey,
      label,
      labelSource,
      start: time,
      preemptedTicks: 0n,
      preemptionCount: 0,
      tainted: this.currentSegmentTimeUncertain || pkt.segmentReliability === 'uncertain',
    });
  }

  private handleTimerExit(pkt: DecodedSystemViewPacket, time: TraceTimePoint, out: MutableReconstructBatch): void {
    if (this.timerStack.length === 0) {
      this.emitDiagnostic(
        out,
        'warning',
        'orphan-timer-exit',
        '收到 TIMER_EXIT 但当前无活动 Timer 回调帧',
        pkt.streamByteOffset,
        undefined,
        pkt.segmentRelativeTicks,
      );
      this.pushActivation(out, {
        activationId: this.nextId('tmr'),
        bootGeneration: this.identity.bootGeneration,
        segmentId: pkt.segmentId,
        segmentReliability: pkt.segmentReliability,
        completeness: 'incomplete',
        kind: 'timer',
        contextKey: `b${this.identity.bootGeneration}:timer:unknown`,
        labelSource: 'missing',
        start: undefined,
        end: undefined,
        observedUntil: time,
        preemptionCount: 0,
        timeDomain: 'unknown',
        endReason: 'orphan-timer-exit',
      });
      return;
    }
    const frame = this.timerStack.pop()!;
    const tainted = frame.tainted || this.currentSegmentTimeUncertain || pkt.segmentReliability === 'uncertain';
    const complete = !tainted && frame.segmentId === time.segmentId && time.relativeTicksBigInt >= frame.start.relativeTicksBigInt;
    const inclusiveTicks = complete ? time.relativeTicksBigInt - frame.start.relativeTicksBigInt : undefined;
    const exclusiveTicks =
      inclusiveTicks !== undefined && inclusiveTicks >= frame.preemptedTicks
        ? inclusiveTicks - frame.preemptedTicks
        : undefined;
    const preemptedTicks =
      inclusiveTicks !== undefined && exclusiveTicks !== undefined ? inclusiveTicks - exclusiveTicks : undefined;

    this.pushActivation(out, {
      activationId: frame.activationId,
      bootGeneration: frame.bootGeneration,
      segmentId: frame.segmentId,
      segmentReliability: frame.segmentReliability,
      completeness: complete ? 'complete' : pkt.segmentReliability === 'uncertain' ? 'uncertain' : 'incomplete',
      kind: 'timer',
      contextKey: frame.contextKey,
      timerId: frame.timerId,
      shrunkTimerId: frame.shrunkTimerId,
      label: frame.label,
      labelSource: frame.labelSource,
      start: frame.start,
      end: complete ? time : undefined,
      observedUntil: complete ? undefined : time,
      inclusiveDurationTicks: inclusiveTicks?.toString(),
      inclusiveDurationTicksBigInt: inclusiveTicks,
      exclusiveDurationTicks: exclusiveTicks?.toString(),
      exclusiveDurationTicksBigInt: exclusiveTicks,
      preemptedDurationTicks: preemptedTicks?.toString(),
      preemptedDurationTicksBigInt: preemptedTicks,
      inclusiveDurationNs: computeDurationNs(inclusiveTicks, this.currentSegmentSysFreqHz),
      exclusiveDurationNs: computeDurationNs(exclusiveTicks, this.currentSegmentSysFreqHz),
      preemptionCount: frame.preemptionCount,
      timeDomain: resolveTimeDomain(frame.start, time, complete),
      endReason: 'timer-exit',
    });
  }

  private handleMarkStart(markerId: number, pkt: DecodedSystemViewPacket, time: TraceTimePoint, out: MutableReconstructBatch): void {
    const existing = this.openMarkers.get(markerId);
    if (existing) {
      this.openMarkers.delete(markerId);
      this.emitDiagnostic(
        out,
        'warning',
        'duplicate-marker-start',
        `Marker #${markerId} 尚未 STOP 即再次收到 MARK_START，前后配对均无法唯一证明`,
        pkt.streamByteOffset,
        { markerId },
        pkt.segmentRelativeTicks,
      );
      this.emitIncompleteMarker(existing, 'duplicate-marker-start', time, out);
      // 同一段内出现未配对的重复 MARK_START 时，下一个 MARK_STOP 也无法确定归属哪一次 START，因此标记为 tainted
      this.openMarkers.set(markerId, this.createOpenMarker(markerId, pkt, time, true));
      return;
    }

    if (this.openMarkers.size >= this.maxOpenMarkers) {
      this.evictOldestOpenMarker(out, pkt);
    }

    this.openMarkers.set(markerId, this.createOpenMarker(markerId, pkt, time, false));
    if (this.openMarkers.size > this.peakOpenMarkerCount) {
      this.peakOpenMarkerCount = this.openMarkers.size;
    }
  }

  private handleMarkStop(markerId: number, pkt: DecodedSystemViewPacket, time: TraceTimePoint, out: MutableReconstructBatch): void {
    const open = this.openMarkers.get(markerId);
    if (!open) {
      this.emitDiagnostic(
        out,
        'warning',
        'orphan-marker-stop',
        `Marker #${markerId} 收到 MARK_STOP 但无配对 MARK_START`,
        pkt.streamByteOffset,
        { markerId },
        pkt.segmentRelativeTicks,
      );
      const { name, nameSource } = this.resolveMarkerName(markerId);
      this.pushMarker(out, {
        markerInstanceId: this.nextId('mrk'),
        bootGeneration: this.identity.bootGeneration,
        segmentId: pkt.segmentId,
        segmentReliability: pkt.segmentReliability,
        completeness: 'incomplete',
        markerId,
        name,
        nameSource,
        start: undefined,
        end: undefined,
        observedUntil: time,
        endContextKey: this.activeSlice?.contextKey,
        timeDomain: 'unknown',
        endReason: 'orphan-marker-stop',
      });
      return;
    }

    this.openMarkers.delete(markerId);
    const { name, nameSource } = this.resolveMarkerName(markerId, open.name, open.nameSource);
    const tainted = open.tainted || this.currentSegmentTimeUncertain || pkt.segmentReliability === 'uncertain';
    const complete = !tainted && open.segmentId === time.segmentId && time.relativeTicksBigInt >= open.start.relativeTicksBigInt;
    const durationTicksBigInt = complete ? time.relativeTicksBigInt - open.start.relativeTicksBigInt : undefined;

    this.pushMarker(out, {
      markerInstanceId: open.markerInstanceId,
      bootGeneration: open.bootGeneration,
      segmentId: open.segmentId,
      segmentReliability: open.segmentReliability,
      completeness: complete ? 'complete' : pkt.segmentReliability === 'uncertain' ? 'uncertain' : 'incomplete',
      markerId,
      name,
      nameSource,
      start: open.start,
      end: complete ? time : undefined,
      observedUntil: complete ? undefined : time,
      durationTicks: durationTicksBigInt?.toString(),
      durationTicksBigInt,
      durationNs: computeDurationNs(durationTicksBigInt, this.currentSegmentSysFreqHz),
      startContextKey: open.startContextKey,
      endContextKey: this.activeSlice?.contextKey,
      timeDomain: resolveTimeDomain(open.start, time, complete),
      endReason: open.tainted ? 'ambiguous-duplicate-marker' : 'mark-stop',
    });
  }

  private handleExMark(markerId: number, pkt: DecodedSystemViewPacket, time: TraceTimePoint, out: MutableReconstructBatch): void {
    const { name, nameSource } = this.resolveMarkerName(markerId);
    out.markerPoints.push({
      bootGeneration: this.identity.bootGeneration,
      segmentId: pkt.segmentId,
      segmentReliability: pkt.segmentReliability,
      markerId,
      name,
      nameSource,
      time,
      contextKey: this.activeSlice?.contextKey,
    });
  }

  private createOpenMarker(
    markerId: number,
    pkt: DecodedSystemViewPacket,
    time: TraceTimePoint,
    tainted: boolean,
  ): OpenMarkerState {
    const { name, nameSource } = this.resolveMarkerName(markerId);
    return {
      markerInstanceId: this.nextId('mrk'),
      bootGeneration: this.identity.bootGeneration,
      segmentId: pkt.segmentId,
      segmentReliability: pkt.segmentReliability,
      markerId,
      name,
      nameSource,
      start: time,
      startContextKey: this.activeSlice?.contextKey,
      tainted: tainted || this.currentSegmentTimeUncertain || pkt.segmentReliability === 'uncertain',
    };
  }

  private closeCurrentBaseContext(
    time: TraceTimePoint,
    endReason: string,
    out: MutableReconstructBatch,
    nextTaskInstanceId?: string,
  ): void {
    if (this.activeSlice && this.isrStack.length === 0) {
      if (this.activeTaskActivation && nextTaskInstanceId === this.activeTaskActivation.taskInstanceId) {
        this.emitDiagnostic(
          out,
          'info',
          'same-task-rescheduled',
          `任务 ${this.activeTaskActivation.taskInstanceId} 连续再次收到 TASK_START_EXEC`,
          time.streamByteOffset,
          { taskInstanceId: this.activeTaskActivation.taskInstanceId },
          time.relativeTicks,
        );
      }
      this.closeActiveSliceComplete(time, endReason, out);
    }

    if (this.activeTaskActivation) {
      const prevTaskKey = this.activeTaskActivation.taskInstanceId;
      this.closeActiveTaskActivationComplete(time, endReason, out);
      this.finalizePendingSelfDelete(prevTaskKey, time, out);
    }

    this.baseContextKind = null;
  }

  private finalizePendingSelfDelete(taskInstanceId: string, time: TraceTimePoint, out: MutableReconstructBatch): void {
    const prevTask = this.findTaskByInstanceId(taskInstanceId);
    if (prevTask?.pendingSelfDelete && !prevTask.terminated) {
      prevTask.terminated = true;
      prevTask.terminatedAt = time;
      prevTask.terminationSource = 'os-vtask-delete';
      prevTask.pendingSelfDelete = false;
      out.taskUpdates.push(summarizeTask(prevTask));
    }
  }

  private closeActiveSliceComplete(time: TraceTimePoint, endReason: string, out: MutableReconstructBatch): void {
    const slice = this.activeSlice;
    if (!slice) {
      return;
    }
    this.activeSlice = null;
    const tainted = slice.tainted || this.currentSegmentTimeUncertain;
    const complete = !tainted && slice.segmentId === time.segmentId && time.relativeTicksBigInt >= slice.start.relativeTicksBigInt;
    const duration = complete ? time.relativeTicksBigInt - slice.start.relativeTicksBigInt : undefined;

    if (duration !== undefined) {
      if (slice.contextKind === 'isr' && this.isrStack.length > 0) {
        const top = this.isrStack[this.isrStack.length - 1];
        if (top.contextKey === slice.contextKey && top.isrDepth === slice.isrDepth) {
          top.exclusiveTicks += duration;
        }
      } else if (slice.contextKind === 'task' && this.activeTaskActivation && this.activeTaskActivation.taskInstanceId === slice.taskInstanceId) {
        this.activeTaskActivation.exclusiveTicks += duration;
      }
      if (slice.contextKind === 'isr' && this.timerStack.length > 0) {
        for (const t of this.timerStack) {
          t.preemptedTicks += duration;
        }
      }
    } else if (slice.contextKind === 'isr' && this.isrStack.length > 0) {
      this.isrStack[this.isrStack.length - 1].tainted = true;
      for (const t of this.timerStack) {
        t.tainted = true;
      }
    } else if (slice.contextKind === 'task' && this.activeTaskActivation) {
      this.activeTaskActivation.tainted = true;
    }

    this.pushSlice(out, {
      sliceId: slice.sliceId,
      bootGeneration: slice.bootGeneration,
      segmentId: slice.segmentId,
      segmentReliability: slice.segmentReliability,
      completeness: complete ? 'complete' : slice.segmentReliability === 'uncertain' ? 'uncertain' : 'incomplete',
      contextKind: slice.contextKind,
      contextKey: slice.contextKey,
      taskInstanceId: slice.taskInstanceId,
      tcbAddress: slice.tcbAddress,
      shrunkTaskId: slice.shrunkTaskId,
      taskGeneration: slice.taskGeneration,
      irqId: slice.irqId,
      isrDepth: slice.isrDepth,
      label: slice.label,
      labelSource: slice.labelSource,
      start: slice.start,
      end: complete ? time : undefined,
      observedUntil: complete ? undefined : time,
      durationTicks: duration?.toString(),
      durationTicksBigInt: duration,
      durationNs: computeDurationNs(duration, this.currentSegmentSysFreqHz),
      timeDomain: resolveTimeDomain(slice.start, time, complete),
      startReason: slice.startReason,
      endReason,
    });
  }

  private emitIncompleteSlice(
    slice: OpenSliceState,
    endReason: string,
    observedUntil: TraceTimePoint | undefined,
    out: MutableReconstructBatch,
  ): void {
    this.pushSlice(out, {
      sliceId: slice.sliceId,
      bootGeneration: slice.bootGeneration,
      segmentId: slice.segmentId,
      segmentReliability: slice.segmentReliability,
      completeness: slice.segmentReliability === 'uncertain' ? 'uncertain' : 'incomplete',
      contextKind: slice.contextKind,
      contextKey: slice.contextKey,
      taskInstanceId: slice.taskInstanceId,
      tcbAddress: slice.tcbAddress,
      shrunkTaskId: slice.shrunkTaskId,
      taskGeneration: slice.taskGeneration,
      irqId: slice.irqId,
      isrDepth: slice.isrDepth,
      label: slice.label,
      labelSource: slice.labelSource,
      start: slice.start,
      end: undefined,
      observedUntil,
      timeDomain: resolveOpenTimeDomain(slice.start),
      startReason: slice.startReason,
      endReason,
    });
  }

  private closeActiveTaskActivationComplete(time: TraceTimePoint, endReason: string, out: MutableReconstructBatch): void {
    const act = this.activeTaskActivation;
    if (!act) {
      return;
    }
    this.activeTaskActivation = null;
    const tainted = act.tainted || this.currentSegmentTimeUncertain;
    const complete = !tainted && act.segmentId === time.segmentId && time.relativeTicksBigInt >= act.start.relativeTicksBigInt;
    const inclusiveTicks = complete ? time.relativeTicksBigInt - act.start.relativeTicksBigInt : undefined;
    const exclusiveTicks =
      complete && inclusiveTicks !== undefined && act.exclusiveTicks <= inclusiveTicks ? act.exclusiveTicks : undefined;
    const preemptedTicks =
      inclusiveTicks !== undefined && exclusiveTicks !== undefined ? inclusiveTicks - exclusiveTicks : undefined;

    this.pushActivation(out, {
      activationId: act.activationId,
      bootGeneration: act.bootGeneration,
      segmentId: act.segmentId,
      segmentReliability: act.segmentReliability,
      completeness: complete && exclusiveTicks !== undefined ? 'complete' : act.segmentReliability === 'uncertain' ? 'uncertain' : 'incomplete',
      kind: 'task-exec',
      contextKey: act.contextKey,
      taskInstanceId: act.taskInstanceId,
      tcbAddress: act.tcbAddress,
      shrunkTaskId: act.shrunkTaskId,
      taskGeneration: act.taskGeneration,
      label: act.label,
      labelSource: act.labelSource,
      start: act.start,
      end: complete ? time : undefined,
      observedUntil: complete ? undefined : time,
      inclusiveDurationTicks: inclusiveTicks?.toString(),
      inclusiveDurationTicksBigInt: inclusiveTicks,
      exclusiveDurationTicks: exclusiveTicks?.toString(),
      exclusiveDurationTicksBigInt: exclusiveTicks,
      preemptedDurationTicks: preemptedTicks?.toString(),
      preemptedDurationTicksBigInt: preemptedTicks,
      inclusiveDurationNs: computeDurationNs(inclusiveTicks, this.currentSegmentSysFreqHz),
      exclusiveDurationNs: computeDurationNs(exclusiveTicks, this.currentSegmentSysFreqHz),
      preemptionCount: act.preemptionCount,
      readyChainStatus: act.readyChainStatus,
      matchedReadyWaitId: act.matchedReadyWaitId,
      timeDomain: resolveTimeDomain(act.start, time, complete),
      endReason,
    });
  }

  private emitIncompleteTaskActivation(
    act: OpenTaskActivationState,
    endReason: string,
    observedUntil: TraceTimePoint | undefined,
    out: MutableReconstructBatch,
  ): void {
    this.pushActivation(out, {
      activationId: act.activationId,
      bootGeneration: act.bootGeneration,
      segmentId: act.segmentId,
      segmentReliability: act.segmentReliability,
      completeness: act.segmentReliability === 'uncertain' ? 'uncertain' : 'incomplete',
      kind: 'task-exec',
      contextKey: act.contextKey,
      taskInstanceId: act.taskInstanceId,
      tcbAddress: act.tcbAddress,
      shrunkTaskId: act.shrunkTaskId,
      taskGeneration: act.taskGeneration,
      label: act.label,
      labelSource: act.labelSource,
      start: act.start,
      end: undefined,
      observedUntil,
      preemptionCount: act.preemptionCount,
      readyChainStatus: act.readyChainStatus,
      matchedReadyWaitId: act.matchedReadyWaitId,
      timeDomain: resolveOpenTimeDomain(act.start),
      endReason,
    });
  }

  private closeIsrActivation(frame: OpenIsrFrameState, time: TraceTimePoint, endReason: string, out: MutableReconstructBatch): void {
    const tainted = frame.tainted || this.currentSegmentTimeUncertain;
    const complete = !tainted && frame.segmentId === time.segmentId && time.relativeTicksBigInt >= frame.start.relativeTicksBigInt;
    const inclusiveTicks = complete ? time.relativeTicksBigInt - frame.start.relativeTicksBigInt : undefined;
    const exclusiveTicks =
      complete && inclusiveTicks !== undefined && frame.exclusiveTicks <= inclusiveTicks ? frame.exclusiveTicks : undefined;
    const preemptedTicks =
      inclusiveTicks !== undefined && exclusiveTicks !== undefined ? inclusiveTicks - exclusiveTicks : undefined;

    this.pushActivation(out, {
      activationId: frame.activationId,
      bootGeneration: frame.bootGeneration,
      segmentId: frame.segmentId,
      segmentReliability: frame.segmentReliability,
      completeness: complete && exclusiveTicks !== undefined ? 'complete' : frame.segmentReliability === 'uncertain' ? 'uncertain' : 'incomplete',
      kind: 'isr',
      contextKey: frame.contextKey,
      irqId: frame.irqId,
      isrDepth: frame.isrDepth,
      label: frame.label,
      labelSource: frame.labelSource,
      start: frame.start,
      end: complete ? time : undefined,
      observedUntil: complete ? undefined : time,
      inclusiveDurationTicks: inclusiveTicks?.toString(),
      inclusiveDurationTicksBigInt: inclusiveTicks,
      exclusiveDurationTicks: exclusiveTicks?.toString(),
      exclusiveDurationTicksBigInt: exclusiveTicks,
      preemptedDurationTicks: preemptedTicks?.toString(),
      preemptedDurationTicksBigInt: preemptedTicks,
      inclusiveDurationNs: computeDurationNs(inclusiveTicks, this.currentSegmentSysFreqHz),
      exclusiveDurationNs: computeDurationNs(exclusiveTicks, this.currentSegmentSysFreqHz),
      preemptionCount: frame.preemptionCount,
      timeDomain: resolveTimeDomain(frame.start, time, complete),
      endReason,
    });
  }

  private emitIncompleteIsrActivation(
    frame: OpenIsrFrameState,
    endReason: string,
    observedUntil: TraceTimePoint | undefined,
    out: MutableReconstructBatch,
  ): void {
    this.pushActivation(out, {
      activationId: frame.activationId,
      bootGeneration: frame.bootGeneration,
      segmentId: frame.segmentId,
      segmentReliability: frame.segmentReliability,
      completeness: frame.segmentReliability === 'uncertain' ? 'uncertain' : 'incomplete',
      kind: 'isr',
      contextKey: frame.contextKey,
      irqId: frame.irqId,
      isrDepth: frame.isrDepth,
      label: frame.label,
      labelSource: frame.labelSource,
      start: frame.start,
      end: undefined,
      observedUntil,
      preemptionCount: frame.preemptionCount,
      timeDomain: resolveOpenTimeDomain(frame.start),
      endReason,
    });
  }

  private emitIncompleteTimerActivation(
    timer: OpenTimerFrameState,
    endReason: string,
    observedUntil: TraceTimePoint | undefined,
    out: MutableReconstructBatch,
  ): void {
    this.pushActivation(out, {
      activationId: timer.activationId,
      bootGeneration: timer.bootGeneration,
      segmentId: timer.segmentId,
      segmentReliability: timer.segmentReliability,
      completeness: timer.segmentReliability === 'uncertain' ? 'uncertain' : 'incomplete',
      kind: 'timer',
      contextKey: timer.contextKey,
      timerId: timer.timerId,
      shrunkTimerId: timer.shrunkTimerId,
      label: timer.label,
      labelSource: timer.labelSource,
      start: timer.start,
      end: undefined,
      observedUntil,
      preemptionCount: timer.preemptionCount,
      timeDomain: resolveOpenTimeDomain(timer.start),
      endReason,
    });
  }

  private emitClosedReadyWait(
    ready: OpenReadyState,
    time: TraceTimePoint,
    outcome: Exclude<ReadyOutcome, 'incomplete'>,
    endReason: string,
    stopCause: number | undefined,
    out: MutableReconstructBatch,
  ): ReadyWaitInterval {
    const tainted = ready.tainted || this.currentSegmentTimeUncertain;
    const complete = !tainted && ready.segmentId === time.segmentId && time.relativeTicksBigInt >= ready.start.relativeTicksBigInt;
    const duration = complete ? time.relativeTicksBigInt - ready.start.relativeTicksBigInt : undefined;
    const readyToRunning = complete && outcome === 'dispatched' ? duration : undefined;
    const interval: ReadyWaitInterval = {
      waitId: ready.waitId,
      bootGeneration: ready.bootGeneration,
      segmentId: ready.segmentId,
      segmentReliability: ready.segmentReliability,
      completeness: complete ? 'complete' : ready.segmentReliability === 'uncertain' ? 'uncertain' : 'incomplete',
      outcome: complete ? outcome : 'incomplete',
      taskInstanceId: ready.taskInstanceId,
      tcbAddress: ready.tcbAddress,
      shrunkTaskId: ready.shrunkTaskId,
      taskGeneration: ready.taskGeneration,
      label: ready.label,
      labelSource: ready.labelSource,
      start: ready.start,
      end: complete ? time : undefined,
      observedUntil: complete ? undefined : time,
      durationTicks: duration?.toString(),
      durationTicksBigInt: duration,
      durationNs: computeDurationNs(duration, this.currentSegmentSysFreqHz),
      readyToRunningTicks: readyToRunning?.toString(),
      readyToRunningTicksBigInt: readyToRunning,
      stopCause,
      timeDomain: resolveTimeDomain(ready.start, time, complete),
      endReason,
    };
    this.pushReadyWait(out, interval);
    return interval;
  }

  private emitIncompleteReadyWait(
    ready: OpenReadyState,
    endReason: string,
    observedUntil: TraceTimePoint | undefined,
    out: MutableReconstructBatch,
  ): void {
    this.pushReadyWait(out, {
      waitId: ready.waitId,
      bootGeneration: ready.bootGeneration,
      segmentId: ready.segmentId,
      segmentReliability: ready.segmentReliability,
      completeness: ready.segmentReliability === 'uncertain' ? 'uncertain' : 'incomplete',
      outcome: 'incomplete',
      taskInstanceId: ready.taskInstanceId,
      tcbAddress: ready.tcbAddress,
      shrunkTaskId: ready.shrunkTaskId,
      taskGeneration: ready.taskGeneration,
      label: ready.label,
      labelSource: ready.labelSource,
      start: ready.start,
      end: undefined,
      observedUntil,
      timeDomain: resolveOpenTimeDomain(ready.start),
      endReason,
    });
  }

  private emitIncompleteMarker(
    marker: OpenMarkerState,
    endReason: string,
    observedUntil: TraceTimePoint | undefined,
    out: MutableReconstructBatch,
  ): void {
    const { name, nameSource } = this.resolveMarkerName(marker.markerId, marker.name, marker.nameSource);
    this.pushMarker(out, {
      markerInstanceId: marker.markerInstanceId,
      bootGeneration: marker.bootGeneration,
      segmentId: marker.segmentId,
      segmentReliability: marker.segmentReliability,
      completeness: marker.segmentReliability === 'uncertain' ? 'uncertain' : 'incomplete',
      markerId: marker.markerId,
      name,
      nameSource,
      start: marker.start,
      end: undefined,
      observedUntil,
      startContextKey: marker.startContextKey,
      timeDomain: resolveOpenTimeDomain(marker.start),
      endReason,
    });
  }

  private getOrCreateTaskForObservation(
    shrunkTaskId: number,
    taskId: number | undefined,
    idResolution: AddressResolutionStatus,
    segmentId: number,
    defaultConfidence: TaskIdentityConfidence,
    warnPostTerminate: boolean,
    out: MutableReconstructBatch,
    pkt: DecodedSystemViewPacket,
  ): InternalTaskInstance {
    const lookupKey = makeTaskLookupKey(shrunkTaskId, taskId, idResolution);
    const existing = this.tasksByKey.get(lookupKey);
    if (existing) {
      existing.lastSeenSegmentId = segmentId;
      existing.lastTouchedSeq = ++this.touchCounter;
      if (existing.terminated) {
        if (warnPostTerminate) {
          this.emitDiagnostic(
            out,
            'warning',
            'post-terminate-activity',
            `已终止任务 ${existing.taskInstanceId} 在未见新 TASK_CREATE 情况下再次出现活动事件，建立隔离的新未知代次`,
            pkt.streamByteOffset,
            { previousTaskInstanceId: existing.taskInstanceId },
            pkt.segmentRelativeTicks,
          );
        }
        const nextGen = (this.taskGenerationByKey.get(lookupKey) ?? existing.generation) + 1;
        this.setBoundedGeneration(lookupKey, nextGen);
        const replacement = this.createTaskInstance({
          lookupKey,
          tcbAddress: idResolution === 'resolved' ? taskId : undefined,
          addressStatus: idResolution,
          shrunkTaskId,
          generation: nextGen,
          segmentId,
          createdInTrace: false,
          identityConfidence: 'observed-mid-stream',
        });
        out.taskUpdates.push(summarizeTask(replacement));
        return replacement;
      }
      return existing;
    }

    const nextGen = (this.taskGenerationByKey.get(lookupKey) ?? 0) + 1;
    const isPostLossRecreated = this.hasOpaqueLossGap && this.taskGenerationByKey.has(lookupKey);
    this.setBoundedGeneration(lookupKey, nextGen);
    const created = this.createTaskInstance({
      lookupKey,
      tcbAddress: idResolution === 'resolved' ? taskId : undefined,
      addressStatus: idResolution,
      shrunkTaskId,
      generation: nextGen,
      segmentId,
      createdInTrace: false,
      identityConfidence: isPostLossRecreated ? 'carried-across-gap' : defaultConfidence,
    });
    if (isPostLossRecreated) {
      created.carriedAcrossGap = true;
    }
    out.taskUpdates.push(summarizeTask(created));
    return created;
  }

  private createTaskInstance(params: {
    lookupKey: string;
    tcbAddress?: number;
    addressStatus: AddressResolutionStatus;
    shrunkTaskId: number;
    generation: number;
    segmentId: number;
    createdInTrace: boolean;
    createdAt?: TraceTimePoint;
    identityConfidence: TaskIdentityConfidence;
  }): InternalTaskInstance {
    if (this.tasksByKey.size >= this.maxTrackedTasks) {
      this.evictOneTaskRecord();
    }

    // 仅在首代且未发生地址 LRU 淘汰或丢失缺口时允许参考调用者传入的静态符号映射；地址复用后的新代次绝不沿用旧符号/旧名称
    let name: string | undefined;
    let nameSource: LabelSource = 'missing';
    if (
      params.generation === 1 &&
      !this.addressGenerationLruEvicted &&
      !this.hasOpaqueLossGap &&
      params.tcbAddress !== undefined
    ) {
      const symName = lookupSymbol(this.symbolMap.tasks, params.tcbAddress);
      if (symName !== undefined) {
        name = symName;
        nameSource = 'symbol-map';
      }
    }

    const suffix =
      params.tcbAddress !== undefined
        ? `tcb:0x${params.tcbAddress.toString(16)}`
        : `shrunk:${params.shrunkTaskId}`;
    const instanceSeq = ++this.taskInstanceSeq;
    const taskInstanceId = `b${this.identity.bootGeneration}:${suffix}#g${params.generation}:i${instanceSeq}`;

    const instance: InternalTaskInstance = {
      taskInstanceId,
      lookupKey: params.lookupKey,
      bootGeneration: this.identity.bootGeneration,
      firstSeenSegmentId: params.segmentId,
      lastSeenSegmentId: params.segmentId,
      tcbAddress: params.tcbAddress,
      addressStatus: params.addressStatus,
      shrunkTaskId: params.shrunkTaskId,
      generation: params.generation,
      name,
      nameSource,
      createdInTrace: params.createdInTrace,
      createdAt: params.createdAt,
      terminated: false,
      pendingSelfDelete: false,
      identityConfidence: params.identityConfidence,
      carriedAcrossGap: false,
      lastTouchedSeq: ++this.touchCounter,
    };
    this.tasksByKey.set(params.lookupKey, instance);
    return instance;
  }

  private refreshOpenTaskLabels(instance: InternalTaskInstance): void {
    if (this.activeTaskActivation && this.activeTaskActivation.taskInstanceId === instance.taskInstanceId) {
      (this.activeTaskActivation as { label?: string }).label = instance.name;
      (this.activeTaskActivation as { labelSource: LabelSource }).labelSource = instance.nameSource;
    }
    if (this.activeSlice && this.activeSlice.taskInstanceId === instance.taskInstanceId) {
      (this.activeSlice as { label?: string }).label = instance.name;
      (this.activeSlice as { labelSource: LabelSource }).labelSource = instance.nameSource;
    }
    const ready = this.openReadyWaits.get(instance.lookupKey);
    if (ready) {
      (ready as { label?: string }).label = instance.name;
      (ready as { labelSource: LabelSource }).labelSource = instance.nameSource;
    }
  }

  private findTaskByInstanceId(taskInstanceId: string): InternalTaskInstance | undefined {
    for (const task of this.tasksByKey.values()) {
      if (task.taskInstanceId === taskInstanceId) {
        return task;
      }
    }
    return undefined;
  }

  private resolveIrqLabel(irqId: number): { label?: string; labelSource: LabelSource } {
    const sysDescName = this.irqNames.get(irqId);
    if (sysDescName !== undefined) {
      return { label: sysDescName, labelSource: 'sysdesc' };
    }
    const symName = lookupSymbol(this.symbolMap.interrupts, irqId);
    if (symName !== undefined) {
      return { label: symName, labelSource: 'symbol-map' };
    }
    return { label: undefined, labelSource: 'missing' };
  }

  private resolveMarkerName(
    markerId: number,
    existing?: string,
    existingSource?: LabelSource,
  ): { name?: string; nameSource: LabelSource } {
    const dynamic = this.markerNames.get(markerId);
    if (dynamic !== undefined) {
      return { name: dynamic, nameSource: 'ex-name-marker' };
    }
    if (existing !== undefined && existingSource && existingSource !== 'missing') {
      return { name: existing, nameSource: existingSource };
    }
    const symName = lookupSymbol(this.symbolMap.markers, markerId);
    if (symName !== undefined) {
      return { name: symName, nameSource: 'symbol-map' };
    }
    return { name: undefined, nameSource: 'missing' };
  }

  private resolveResourceLabel(resourceId: number | undefined): { label?: string; labelSource: LabelSource } {
    if (resourceId !== undefined) {
      const dynamic = this.resourceNames.get(resourceId);
      if (dynamic !== undefined) {
        return { label: dynamic, labelSource: 'name-resource' };
      }
      const symName = lookupSymbol(this.symbolMap.resources, resourceId);
      if (symName !== undefined) {
        return { label: symName, labelSource: 'symbol-map' };
      }
    }
    return { label: undefined, labelSource: 'missing' };
  }

  private taintAllOpenIntervals(): void {
    if (this.activeSlice) {
      this.activeSlice.tainted = true;
    }
    if (this.activeTaskActivation) {
      this.activeTaskActivation.tainted = true;
    }
    for (const f of this.isrStack) {
      f.tainted = true;
    }
    for (const t of this.timerStack) {
      t.tainted = true;
    }
    for (const r of this.openReadyWaits.values()) {
      r.tainted = true;
    }
    for (const m of this.openMarkers.values()) {
      m.tainted = true;
    }
  }

  private evictOldestOpenReady(out: MutableReconstructBatch, pkt: DecodedSystemViewPacket): void {
    const first = this.openReadyWaits.entries().next();
    if (first.done) {
      return;
    }
    const [key, ready] = first.value;
    this.openReadyWaits.delete(key);
    this.totalBudgetEvictions += 1;
    this.emitDiagnostic(
      out,
      'warning',
      'budget-exceeded',
      `未闭合 Ready 等待任务数达到上限 ${this.maxOpenReadyTasks}，淘汰最早项 ${ready.taskInstanceId}`,
      pkt.streamByteOffset,
      { taskInstanceId: ready.taskInstanceId, maxOpenReadyTasks: this.maxOpenReadyTasks },
      pkt.segmentRelativeTicks,
    );
    this.emitIncompleteReadyWait(ready, 'budget-evicted', undefined, out);
  }

  private evictOldestOpenMarker(out: MutableReconstructBatch, pkt: DecodedSystemViewPacket): void {
    const first = this.openMarkers.entries().next();
    if (first.done) {
      return;
    }
    const [key, marker] = first.value;
    this.openMarkers.delete(key);
    this.totalBudgetEvictions += 1;
    this.emitDiagnostic(
      out,
      'warning',
      'budget-exceeded',
      `未闭合 Marker 数量达到上限 ${this.maxOpenMarkers}，淘汰最早项 Marker #${marker.markerId}`,
      pkt.streamByteOffset,
      { markerId: marker.markerId, maxOpenMarkers: this.maxOpenMarkers },
      pkt.segmentRelativeTicks,
    );
    this.emitIncompleteMarker(marker, 'budget-evicted', undefined, out);
  }

  private evictOneTaskRecord(): void {
    let victimKey: string | null = null;
    let victimScore = Infinity;
    for (const [k, t] of this.tasksByKey.entries()) {
      if (this.activeTaskActivation?.taskInstanceId === t.taskInstanceId || this.openReadyWaits.has(k)) {
        continue;
      }
      // 优先淘汰已终止任务，其次最久未活动任务
      const score = t.terminated ? t.lastTouchedSeq : t.lastTouchedSeq + 1_000_000_000;
      if (score < victimScore) {
        victimScore = score;
        victimKey = k;
      }
    }
    if (victimKey !== null) {
      this.tasksByKey.delete(victimKey);
      this.totalBudgetEvictions += 1;
    }
  }

  private setBoundedGeneration(lookupKey: string, generation: number): void {
    if (!this.taskGenerationByKey.has(lookupKey) && this.taskGenerationByKey.size >= this.maxKnownTaskAddresses) {
      const oldest = this.taskGenerationByKey.keys().next();
      if (!oldest.done) {
        this.taskGenerationByKey.delete(oldest.value);
        this.addressGenerationLruEvicted = true;
      }
    }
    this.taskGenerationByKey.delete(lookupKey);
    this.taskGenerationByKey.set(lookupKey, generation);
  }

  private setBoundedMap<K, V>(map: Map<K, V>, key: K, value: V, limit: number): void {
    if (map.has(key)) {
      map.delete(key);
    } else if (map.size >= limit) {
      const oldest = map.keys().next();
      if (!oldest.done) {
        map.delete(oldest.value);
      }
    }
    map.set(key, value);
  }

  private nextId(prefix: string): string {
    this.seqCounter += 1;
    return `${prefix}-${this.identity.bootGeneration}-${this.seqCounter}`;
  }

  private pushSlice(out: MutableReconstructBatch, slice: ExecutionSliceInterval): void {
    this.totalEmittedIntervals += 1;
    out.executionSlices.push(slice);
  }

  private pushActivation(out: MutableReconstructBatch, activation: ContextActivationInterval): void {
    this.totalEmittedIntervals += 1;
    out.contextActivations.push(activation);
  }

  private pushReadyWait(out: MutableReconstructBatch, wait: ReadyWaitInterval): void {
    this.totalEmittedIntervals += 1;
    out.readyWaits.push(wait);
  }

  private pushMarker(out: MutableReconstructBatch, marker: MarkerInterval): void {
    this.totalEmittedIntervals += 1;
    out.markers.push(marker);
  }

  private emitDiagnostic(
    out: MutableReconstructBatch,
    severity: ReconstructorDiagnosticSeverity,
    code: ReconstructorDiagnosticCode,
    message: string,
    streamByteOffset: number,
    details?: Record<string, unknown>,
    relativeTicks?: string,
  ): void {
    out.diagnostics.push({
      severity,
      code,
      message,
      bootGeneration: this.identity.bootGeneration,
      segmentId: this.currentSegmentId ?? 0,
      streamByteOffset,
      relativeTicks,
      details,
    });
  }

  private finalizeReturn(
    out: MutableReconstructBatch,
    accepted: boolean,
    rejectionReason?: string,
    errorCode?: TraceReconstructBatch['errorCode'],
  ): TraceReconstructBatch {
    return {
      protocolVersion: SYSTEMVIEW_PROTOCOL_VERSION,
      accepted,
      rejectionReason,
      errorCode,
      identity: { ...this.identity },
      executionSlices: out.executionSlices,
      contextActivations: out.contextActivations,
      readyWaits: out.readyWaits,
      markers: out.markers,
      markerPoints: out.markerPoints,
      taskUpdates: out.taskUpdates,
      gapBoundaries: out.gapBoundaries,
      diagnostics: out.diagnostics,
    };
  }
}

/**
 * 离线便捷入口：将一组解码批次或完整解码结果流式喂入 `SystemViewTraceReconstructor` 并汇总输出。
 * 重建器自身不持有历史区间；此汇总函数仅用于离线单次分析或测试对比。
 */
export function reconstructSystemViewTrace(
  input: SystemViewDecodeResult | readonly SystemViewDecodeBatch[],
  options: SystemViewReconstructorOptions = {},
): TraceReconstructResult {
  const reconstructor = new SystemViewTraceReconstructor(options);
  const executionSlices: ExecutionSliceInterval[] = [];
  const contextActivations: ContextActivationInterval[] = [];
  const readyWaits: ReadyWaitInterval[] = [];
  const markers: MarkerInterval[] = [];
  const markerPoints: MarkerPointEvent[] = [];
  const taskUpdates: TaskInstanceSummary[] = [];
  const tasksByInstanceId = new Map<string, TaskInstanceSummary>();
  const gapBoundaries: ReconstructorGapBoundary[] = [];
  const diagnostics: ReconstructorDiagnostic[] = [];

  const absorb = (res: TraceReconstructBatch) => {
    appendAll(executionSlices, res.executionSlices);
    appendAll(contextActivations, res.contextActivations);
    appendAll(readyWaits, res.readyWaits);
    appendAll(markers, res.markers);
    appendAll(markerPoints, res.markerPoints);
    appendAll(taskUpdates, res.taskUpdates);
    for (const t of res.taskUpdates) {
      tasksByInstanceId.set(t.taskInstanceId, t);
    }
    appendAll(gapBoundaries, res.gapBoundaries);
    appendAll(diagnostics, res.diagnostics);
  };

  if (Array.isArray(input)) {
    for (let i = 0; i < input.length; i++) {
      absorb(reconstructor.pushBatch(input[i], { batchSequence: i + 1 }));
    }
  } else {
    const single = input as SystemViewDecodeResult;
    absorb(
      reconstructor.pushBatch(
        {
          packets: single.packets,
          syncs: single.syncs,
          gaps: single.gaps,
          segments: single.segments,
          diagnostics: single.diagnostics,
        },
        { batchSequence: 1 },
      ),
    );
  }
  absorb(reconstructor.finish());

  const summary = reconstructor.getState();
  return {
    identity: summary.identity,
    executionSlices,
    contextActivations,
    readyWaits,
    markers,
    markerPoints,
    taskUpdates,
    tasksByInstanceId,
    gapBoundaries,
    diagnostics,
    summary,
  };
}

function createEmptyBatch(): MutableReconstructBatch {
  return {
    executionSlices: [],
    contextActivations: [],
    readyWaits: [],
    markers: [],
    markerPoints: [],
    taskUpdates: [],
    gapBoundaries: [],
    diagnostics: [],
  };
}

function toTraceTimePoint(pkt: DecodedSystemViewPacket): TraceTimePoint {
  return {
    segmentId: pkt.segmentId,
    packetIndexInSegment: pkt.packetIndexInSegment,
    streamByteOffset: pkt.streamByteOffset,
    relativeTicks: pkt.segmentRelativeTicks,
    relativeTicksBigInt: pkt.segmentRelativeTicksBigInt,
    absoluteTicks: pkt.absoluteTicks,
    absoluteTicksBigInt: pkt.absoluteTicksBigInt,
    timeAnchorStatus: pkt.timeAnchorStatus,
    sysFreqHz: pkt.sysFreqHz,
    timestampNs: pkt.timestampNs,
  };
}

function computeDurationNs(durationTicks: bigint | undefined, sysFreqHz: number | undefined): string | undefined {
  if (durationTicks === undefined || sysFreqHz === undefined || sysFreqHz <= 0) {
    return undefined;
  }
  return ((durationTicks * 1_000_000_000n) / BigInt(sysFreqHz)).toString();
}

function resolveTimeDomain(
  start: TraceTimePoint,
  end: TraceTimePoint,
  complete: boolean,
): 'anchored-ticks' | 'segment-relative-ticks' | 'unknown' {
  if (!complete) {
    return 'unknown';
  }
  if (start.absoluteTicksBigInt !== undefined && end.absoluteTicksBigInt !== undefined) {
    return 'anchored-ticks';
  }
  return 'segment-relative-ticks';
}

function resolveOpenTimeDomain(start: TraceTimePoint): 'anchored-ticks' | 'segment-relative-ticks' | 'unknown' {
  return start.absoluteTicksBigInt !== undefined ? 'anchored-ticks' : 'segment-relative-ticks';
}

function makeTaskLookupKey(shrunkTaskId: number, taskId: number | undefined, idResolution: AddressResolutionStatus): string {
  if (idResolution === 'resolved' && taskId !== undefined) {
    return `addr:0x${taskId.toString(16)}`;
  }
  return `shrunk:${shrunkTaskId}:${idResolution}`;
}

function formatTaskRef(taskId: number | undefined, shrunkTaskId: number): string {
  return taskId !== undefined ? `0x${taskId.toString(16)}` : `shrunk:${shrunkTaskId}`;
}

function summarizeTask(instance: InternalTaskInstance): TaskInstanceSummary {
  return {
    taskInstanceId: instance.taskInstanceId,
    bootGeneration: instance.bootGeneration,
    firstSeenSegmentId: instance.firstSeenSegmentId,
    lastSeenSegmentId: instance.lastSeenSegmentId,
    tcbAddress: instance.tcbAddress,
    addressStatus: instance.addressStatus,
    shrunkTaskId: instance.shrunkTaskId,
    generation: instance.generation,
    name: instance.name,
    nameSource: instance.nameSource,
    priority: instance.priority,
    stackInfo: instance.stackInfo ? { ...instance.stackInfo } : undefined,
    createdInTrace: instance.createdInTrace,
    createdAt: instance.createdAt,
    terminated: instance.terminated,
    terminatedAt: instance.terminatedAt,
    terminationSource: instance.terminationSource,
    identityConfidence: instance.identityConfidence,
  };
}

function lookupSymbol(table: SymbolLookupInput | undefined, id: number): string | undefined {
  if (!table) {
    return undefined;
  }
  if (table instanceof Map) {
    return table.get(id);
  }
  const rec = table as Readonly<Record<string, string>>;
  if (Object.prototype.hasOwnProperty.call(rec, String(id))) {
    return rec[String(id)];
  }
  const hexKey = `0x${id.toString(16)}`;
  if (Object.prototype.hasOwnProperty.call(rec, hexKey)) {
    return rec[hexKey];
  }
  return undefined;
}

function validateBound(value: number, name: string, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer in ${min}..${max}, got ${value}`);
  }
  return value;
}

function isOpaqueTaskLossGap(kind: ReconstructorGapBoundary['kind']): boolean {
  return (
    kind === 'target-overflow' ||
    kind === 'host-drop' ||
    kind === 'transport-gap' ||
    kind === 'decode-sync-loss' ||
    kind === 'decode-schema-error' ||
    kind === 'prefix-overwritten' ||
    kind === 'storage-failure' ||
    kind === 'truncated' ||
    kind === 'control-pause'
  );
}

function appendAll<T>(target: T[], source: readonly T[]): void {
  for (let i = 0; i < source.length; i++) {
    target.push(source[i]);
  }
}
