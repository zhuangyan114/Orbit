import {
  CmsisDapRttChannelDescriptor,
  CmsisDapRttEnumResult,
  CmsisDapRttMemoryRange,
  CmsisDapRttReadResult,
} from '../ozone-backend/cmsis-dap-helper-channel';
import type { RttCapabilities } from '../ozone-backend/rtt-contract';
import { validateRttMemoryRanges } from '../ozone-backend/rtt-contract';
import type { OzoneCommandResult } from '../ozone-backend/types';
import { log } from '../utils/logger';

export type RttDeliveryKind = 'text' | 'binary';
export type RttBackpressurePolicy = 'pause-reader' | 'drop-newest' | 'drop-oldest';
export type RttConflictPolicy = 'reject-on-xr' | 'pause-on-xr' | 'best-effort';
export type RttDeliveryMode = 'callback' | 'pull';

export const RTT_DELIVERY_KINDS: readonly RttDeliveryKind[] = ['text', 'binary'];
export const RTT_DELIVERY_MODES: readonly RttDeliveryMode[] = ['callback', 'pull'];
export const RTT_BACKPRESSURE_POLICIES: readonly RttBackpressurePolicy[] = ['pause-reader', 'drop-newest', 'drop-oldest'];
export const RTT_CONFLICT_POLICIES: readonly RttConflictPolicy[] = ['reject-on-xr', 'pause-on-xr', 'best-effort'];

export function validateStrictInt(
  value: unknown,
  field: string,
  min: number,
  max: number,
  errorCode = 'InvalidRequest',
): { ok: true; value: number } | RttOperationFailure {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < min || value > max) {
    return {
      ok: false,
      errorCode,
      message: `${field} must be an integer in ${min}..${max}`,
      diagnostics: { field, min, max, receivedType: value === null ? 'null' : typeof value },
    };
  }
  return { ok: true, value };
}

export function validatePositiveUint32(
  value: unknown,
  field: string,
  errorCode = 'InvalidRequest',
): { ok: true; value: number } | RttOperationFailure {
  return validateStrictInt(value, field, 1, 0xFFFFFFFF, errorCode);
}

export function validateNonEmptyString(
  value: unknown,
  field: string,
  errorCode = 'InvalidRequest',
): { ok: true; value: string } | RttOperationFailure {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return {
      ok: false,
      errorCode,
      message: `${field} must be a non-empty string`,
      diagnostics: { field, receivedType: value === null ? 'null' : typeof value },
    };
  }
  return { ok: true, value: value.trim() };
}

export function validateEnum<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
  errorCode = 'InvalidRequest',
): { ok: true; value: T } | RttOperationFailure {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    return {
      ok: false,
      errorCode,
      message: `${field} must be one of: ${allowed.join(', ')}`,
      diagnostics: { field, allowed, receivedType: value === null ? 'null' : typeof value },
    };
  }
  return { ok: true, value: value as T };
}

function ramRangesEqual(
  a: readonly CmsisDapRttMemoryRange[],
  b: readonly CmsisDapRttMemoryRange[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if ((a[i].address >>> 0) !== (b[i].address >>> 0) || (a[i].size >>> 0) !== (b[i].size >>> 0)) {
      return false;
    }
  }
  return true;
}

export interface RttTransportBudget {
  ownerKind: string;
  transport: string;
  maxBatchBytes: number;
  minPollIntervalMs: number;
  defaultPollIntervalMs: number;
  maxBatchesPerTurn: number;
  source: 'hardware' | 'design-budget';
}

export interface RttIdentity {
  sessionId: string;
  sessionGeneration: number;
  bootGeneration: number;
  operationGeneration: number;
}

export interface RttChannelBatch {
  sessionId: string;
  sessionGeneration: number;
  bootGeneration: number;
  bufferIndex: number;
  channelName?: string;
  batchSequence: number;
  bytes: Uint8Array;
  rdOff?: number;
  wrOff?: number;
  committedRdOff?: number;
  bufferSize?: number;
  wrapped?: boolean;
  overrun?: boolean;
  writerAdvanced?: boolean;
  congested: boolean;
  backlogLikely: boolean;
  isFinal: boolean;
  timestampMs: number;
}

export interface RttConsumerDropEvent {
  bufferIndex: number;
  consumerId: string;
  reason: 'host-drop' | 'target-overflow' | 'transport-drop';
  droppedBytes: number;
  droppedBatches: number;
  totalHostDroppedBytes: number;
  totalTargetOverruns: number;
}

export interface RttSubscribeOptions {
  consumerId: string;
  channelIndex?: number;
  channelName?: string;
  deliveryKind: RttDeliveryKind;
  deliveryMode?: RttDeliveryMode;
  pollIntervalMs?: number;
  maxBatchBytes?: number;
  maxQueueBytes?: number;
  maxQueueBatches?: number;
  backpressurePolicy?: RttBackpressurePolicy;
  conflictPolicy?: RttConflictPolicy;
  retryInvalidControlBlock?: boolean;
  controlBlockAddress?: number;
  ramRanges?: readonly CmsisDapRttMemoryRange[];
  roRanges?: readonly CmsisDapRttMemoryRange[];
  memoryBacked?: boolean;
  onBatch?: (batch: RttChannelBatch) => boolean | void;
  onDrop?: (event: RttConsumerDropEvent) => void;
  onStateChange?: (state: RttChannelStatus) => void;
  onError?: (error: { errorCode: string; message: string; diagnostics?: Record<string, unknown> }) => void;
}

export interface RttSubscribeResult {
  ok: true;
  subscriptionId: string;
  consumerId: string;
  bufferIndex: number;
  channelName?: string;
  deduplicated: boolean;
  refCount: number;
  budget: RttTransportBudget;
}

export interface RttOperationFailure {
  ok: false;
  errorCode: string;
  message: string;
  diagnostics?: Record<string, unknown>;
}

export interface RttUnsubscribeOptions {
  drainLastBatch?: boolean;
  drainTimeoutMs?: number;
}

export interface RttUnsubscribeResult {
  ok: boolean;
  bufferIndex: number;
  consumerId: string;
  remainingRefCount: number;
  drainedBatch?: RttChannelBatch;
  errorCode?: string;
  message?: string;
}

export interface RttDrainOptions {
  timeoutMs?: number;
}

export interface RttDrainResult {
  ok: boolean;
  bufferIndex: number;
  consumerId: string;
  drained: boolean;
  reason: 'empty' | 'timeout' | 'paused' | 'backpressured' | 'xr-paused' | 'control' | 'reset' | 'aborted' | 'error';
  batchesDrained: number;
  bytesDrained: number;
  lastBatchSequence: number;
  lastRdOff?: number;
  lastWrOff?: number;
  bufferSize?: number;
  errorCode?: string;
  message?: string;
}

export interface RttChannelStatus {
  bufferIndex: number;
  channelName?: string;
  refCount: number;
  consumers: Array<{
    consumerId: string;
    deliveryKind: RttDeliveryKind;
    deliveryMode: RttDeliveryMode;
    paused: boolean;
    backpressured: boolean;
    queuedBytes: number;
    queuedBatches: number;
    hostDroppedBytes: number;
    hostDroppedBatches: number;
    conflictPolicy: RttConflictPolicy;
    backpressurePolicy: RttBackpressurePolicy;
  }>;
  polling: boolean;
  inFlight: boolean;
  pausedReason: 'none' | 'control' | 'xr-timeline-active' | 'backpressure' | 'reset';
  congested: boolean;
  batchSequence: number;
  readCount: number;
  totalBytesRead: number;
  targetOverruns: number;
  transportDroppedBytes: number;
  hostDroppedBytes: number;
  lastRdOff?: number;
  lastWrOff?: number;
  bufferSize?: number;
  lastErrorCode?: string;
  lastErrorMessage?: string;
}

export interface RttCoordinatorSnapshot {
  identity: RttIdentity;
  disposed: boolean;
  ownerStarted: boolean;
  rttAvailable: boolean;
  controlBlockAddress?: number;
  xrSamplingActive: boolean;
  activeChannelCount: number;
  channels: RttChannelStatus[];
}

export interface RttCoordinatorHost {
  identity(): RttIdentity;
  ownerKind(): string;
  transportKind(): string;
  getRttCapabilities(): Promise<RttCapabilities>;
  ensureControlBlockAddress(): Promise<{ ok: true; address: number; source: 'elf-symbol' | 'config' } | RttOperationFailure>;
  isTargetAvailable(): boolean;
  isControlInProgress(): boolean;
  isTerminating(): boolean;
  isXrSamplingActive(): boolean;
  acquireReadGate(priority: 'watch' | 'background', timeoutMs: number, signal?: AbortSignal): boolean | Promise<boolean>;
  releaseReadGate(): void;
  startRtt(controlBlockAddress: number, options?: { ramRanges?: readonly CmsisDapRttMemoryRange[]; memoryBacked?: boolean }): Promise<OzoneCommandResult>;
  stopRtt(): Promise<OzoneCommandResult>;
  enumerateRtt(controlBlockAddress: number, options?: { ramRanges?: readonly CmsisDapRttMemoryRange[]; roRanges?: readonly CmsisDapRttMemoryRange[]; timeoutMs?: number }): Promise<OzoneCommandResult>;
  readRtt(bufferIndex: number, size: number, signal?: AbortSignal): Promise<OzoneCommandResult>;
  writeRtt?(bufferIndex: number, bytes: Uint8Array, options?: { controlBlockAddress?: number; ramRanges?: readonly CmsisDapRttMemoryRange[]; timeoutMs?: number }): Promise<OzoneCommandResult>;
  withWriteControlGate?(run: () => Promise<OzoneCommandResult>): Promise<OzoneCommandResult>;
  onOwnerLost(errorCode: string): void;
  onRttUnavailable(errorCode: string, message: string, diagnostics?: Record<string, unknown>): void;
  onStartTransientRetry?(errorCode: string, message: string, intervalMs: number, diagnostics?: Record<string, unknown>): void;
  onTimerStateChanged?(): void;
  nowMs?(): number;
}

interface ConsumerState {
  subscriptionId: string;
  consumerId: string;
  deliveryKind: RttDeliveryKind;
  deliveryMode: RttDeliveryMode;
  pollIntervalMs: number;
  maxBatchBytes: number;
  maxQueueBytes: number;
  maxQueueBatches: number;
  backpressurePolicy: RttBackpressurePolicy;
  conflictPolicy: RttConflictPolicy;
  retryInvalidControlBlock: boolean;
  paused: boolean;
  backpressured: boolean;
  queue: RttChannelBatch[];
  queuedBytes: number;
  hostDroppedBytes: number;
  hostDroppedBatches: number;
  onBatch?: (batch: RttChannelBatch) => boolean | void;
  onDrop?: (event: RttConsumerDropEvent) => void;
  onStateChange?: (state: RttChannelStatus) => void;
  onError?: (error: { errorCode: string; message: string; diagnostics?: Record<string, unknown> }) => void;
}

interface ChannelReaderState {
  bufferIndex: number;
  channelName?: string;
  consumers: Map<string, ConsumerState>;
  generation: number;
  timer: NodeJS.Timeout | null;
  inFlight: boolean;
  inFlightPromise: Promise<void> | null;
  abortController: AbortController | null;
  pausedReason: 'none' | 'control' | 'xr-timeline-active' | 'backpressure' | 'reset';
  batchSequence: number;
  readCount: number;
  totalBytesRead: number;
  targetOverruns: number;
  transportDroppedBytes: number;
  lastTransportDropTotal: number;
  hostDroppedBytes: number;
  congested: boolean;
  lastRdOff?: number;
  lastWrOff?: number;
  bufferSize?: number;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  transientStartLogged: boolean;
}

const DEFAULT_MAX_QUEUE_BYTES = 256 * 1024;
const DEFAULT_MAX_QUEUE_BATCHES = 64;
const LOW_WATER_RATIO = 0.5;

function isOwnerLossErrorCode(errorCode: string | undefined): boolean {
  return errorCode === 'DeviceRemoved'
    || errorCode === 'HelperExited'
    || errorCode === 'NativeOwnerLost'
    || errorCode === 'RttOwnerLost'
    || errorCode === 'TargetOwnerUnavailable'
    || errorCode === 'TargetDisconnected'
    || errorCode === 'DapAckNoAck';
}

function isRttUnavailableErrorCode(errorCode: string | undefined): boolean {
  return errorCode === 'RttControlBlockUnavailable'
    || errorCode === 'RttInvalidControlBlock'
    || errorCode === 'RttInvalidBufferIndex'
    || errorCode === 'RttInvalidBufferLayout'
    || errorCode === 'RttInvalidBufferFlags';
}

export function resolveRttTransportBudget(
  ownerKind: string,
  transport: string,
  bufferIndex: number,
  memoryBacked = false,
): RttTransportBudget {
  if (ownerKind === 'cmsis-dap' && transport === 'rmlink-service') {
    // Channel 0 uses RMLink probe-side rtt_stream cache by default (no SWD read
    // per poll). Multi-channel memory-backed RTT uses <=128B wireless packets,
    // so bound each batch to 512B (4 wireless round-trips) to protect control.
    if (bufferIndex === 0 && !memoryBacked) {
      return {
        ownerKind,
        transport,
        maxBatchBytes: 4096,
        minPollIntervalMs: 10,
        defaultPollIntervalMs: 50,
        maxBatchesPerTurn: 1,
        source: 'design-budget',
      };
    }
    return {
      ownerKind,
      transport,
      maxBatchBytes: 512,
      minPollIntervalMs: 20,
      defaultPollIntervalMs: 50,
      maxBatchesPerTurn: 1,
      source: 'design-budget',
    };
  }
  if (ownerKind === 'cmsis-dap' && transport === 'hid') {
    return {
      ownerKind,
      transport,
      maxBatchBytes: 512,
      minPollIntervalMs: 20,
      defaultPollIntervalMs: 50,
      maxBatchesPerTurn: 1,
      source: 'design-budget',
    };
  }
  if (ownerKind === 'cmsis-dap' && transport === 'tcp') {
    return {
      ownerKind,
      transport,
      maxBatchBytes: 2048,
      minPollIntervalMs: 10,
      defaultPollIntervalMs: 20,
      maxBatchesPerTurn: 1,
      source: 'design-budget',
    };
  }
  if (ownerKind === 'cmsis-dap' && transport === 'winusb') {
    return {
      ownerKind,
      transport,
      maxBatchBytes: 4096,
      minPollIntervalMs: 5,
      defaultPollIntervalMs: 20,
      maxBatchesPerTurn: 1,
      source: 'design-budget',
    };
  }
  if (ownerKind === 'jlink-native') {
    return {
      ownerKind,
      transport: transport || 'jlink-dll',
      maxBatchBytes: 4096,
      minPollIntervalMs: 5,
      defaultPollIntervalMs: 20,
      maxBatchesPerTurn: 1,
      source: 'design-budget',
    };
  }
  return {
    ownerKind,
    transport: transport || 'default',
    maxBatchBytes: 4096,
    minPollIntervalMs: 10,
    defaultPollIntervalMs: 50,
    maxBatchesPerTurn: 1,
    source: 'design-budget',
  };
}

/**
 * Coordinates all RTT Up-channel consumption inside a single DAP session and
 * its selected physical target owner:
 * - guarantees at most ONE physical reader per Up buffer index;
 * - deduplicates repeated subscriptions and reference-counts shared channels;
 * - enforces strict text vs raw-binary delivery boundaries;
 * - validates control critical sections, XR/Timeline conflicts, bounded
 *   backpressure, graceful final-batch draining, session fences, and owner loss.
 */
export class RttConsumptionCoordinator {
  private readonly channels = new Map<number, ChannelReaderState>();
  private readonly channelQueue: number[] = [];
  private ownerStarted = false;
  private rttAvailable = true;
  private controlBlockAddress: number | undefined;
  private customRamRanges: readonly CmsisDapRttMemoryRange[] | undefined;
  private memoryBacked = false;
  private memoryBackedSet = false;
  private disposed = false;
  private suspendedForReset = false;
  private coordinatorGeneration = 0;
  private subscriptionSeq = 0;
  private gateDrainActive = false;
  private activeReadAbortController: AbortController | null = null;
  private lastServedChannel = -1;
  private ownerLifecycleQueue: Promise<void> = Promise.resolve();
  private ownerTransitionPending = 0;
  private subscribeQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly host: RttCoordinatorHost) {}

  get isOwnerStarted(): boolean {
    return this.ownerStarted;
  }

  get isRttAvailable(): boolean {
    return this.rttAvailable;
  }

  get hasActiveChannelTimers(): boolean {
    for (const channel of this.channels.values()) {
      if (channel.timer !== null || channel.inFlight) return true;
    }
    return false;
  }

  hasConsumer(consumerId: string, bufferIndex?: number): boolean {
    if (bufferIndex !== undefined) {
      return this.channels.get(bufferIndex)?.consumers.has(consumerId) ?? false;
    }
    for (const channel of this.channels.values()) {
      if (channel.consumers.has(consumerId)) return true;
    }
    return false;
  }

  hasChannelTimer(bufferIndex: number): boolean {
    return (this.channels.get(bufferIndex)?.timer ?? null) !== null;
  }

  getChannelTimer(bufferIndex: number): NodeJS.Timeout | null {
    return this.channels.get(bufferIndex)?.timer ?? null;
  }

  private enqueueSubscribe<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.subscribeQueue.then(fn, fn);
    this.subscribeQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private checkSessionBindingConflict(parsed: {
    controlBlockAddress?: number;
    ramRanges?: readonly CmsisDapRttMemoryRange[];
    memoryBacked?: boolean;
  }): RttOperationFailure | null {
    if (this.controlBlockAddress !== undefined && parsed.controlBlockAddress !== undefined
      && (parsed.controlBlockAddress >>> 0) !== (this.controlBlockAddress >>> 0)) {
      return {
        ok: false,
        errorCode: 'RttControlBlockConflict',
        message: `RTT session is already bound to control block 0x${this.controlBlockAddress.toString(16)}; conflicting 0x${parsed.controlBlockAddress.toString(16)} rejected`,
        diagnostics: {
          boundControlBlockAddress: this.controlBlockAddress,
          requestedControlBlockAddress: parsed.controlBlockAddress,
        },
      };
    }
    const active = this.channels.size > 0 || this.ownerStarted || this.ownerTransitionPending > 0;
    if (active) {
      if (parsed.memoryBacked !== undefined && this.memoryBackedSet && parsed.memoryBacked !== this.memoryBacked) {
        return {
          ok: false,
          errorCode: 'InvalidRequest',
          message: `Cannot change memoryBacked (${String(this.memoryBacked)} -> ${String(parsed.memoryBacked)}) while RTT consumers are active`,
        };
      }
      if (parsed.ramRanges !== undefined && this.customRamRanges !== undefined && !ramRangesEqual(parsed.ramRanges, this.customRamRanges)) {
        return {
          ok: false,
          errorCode: 'InvalidRequest',
          message: 'Cannot change RTT ramRanges while RTT consumers are active',
        };
      }
    }
    return null;
  }

  private validateSubscribeRequest(options: RttSubscribeOptions): {
    ok: true;
    parsed: {
      consumerId: string;
      channelIndex?: number;
      channelName?: string;
      deliveryKind: RttDeliveryKind;
      deliveryMode: RttDeliveryMode;
      backpressurePolicy: RttBackpressurePolicy;
      conflictPolicy: RttConflictPolicy;
      pollIntervalMs?: number;
      maxBatchBytes?: number;
      maxQueueBytes?: number;
      maxQueueBatches?: number;
      controlBlockAddress?: number;
      ramRanges?: readonly CmsisDapRttMemoryRange[];
      roRanges?: readonly CmsisDapRttMemoryRange[];
      memoryBacked?: boolean;
      retryInvalidControlBlock: boolean;
    };
  } | RttOperationFailure {
    if (this.disposed || this.host.isTerminating()) {
      return { ok: false, errorCode: 'SessionTerminating', message: 'Debug session is terminating' };
    }
    if (!this.rttAvailable) {
      return { ok: false, errorCode: 'CapabilityUnavailable', message: 'RTT is unavailable for this session' };
    }
    const consumerIdCheck = validateNonEmptyString(options.consumerId, 'consumerId');
    if (!consumerIdCheck.ok) return consumerIdCheck;

    const kindCheck = validateEnum(options.deliveryKind, 'deliveryKind', RTT_DELIVERY_KINDS);
    if (!kindCheck.ok) return kindCheck;

    let deliveryMode: RttDeliveryMode = 'callback';
    if (options.deliveryMode !== undefined) {
      const modeCheck = validateEnum(options.deliveryMode, 'deliveryMode', RTT_DELIVERY_MODES);
      if (!modeCheck.ok) return modeCheck;
      deliveryMode = modeCheck.value;
    }

    let backpressurePolicy: RttBackpressurePolicy = 'pause-reader';
    if (options.backpressurePolicy !== undefined) {
      const bpCheck = validateEnum(options.backpressurePolicy, 'backpressurePolicy', RTT_BACKPRESSURE_POLICIES);
      if (!bpCheck.ok) return bpCheck;
      backpressurePolicy = bpCheck.value;
    }

    let conflictPolicy: RttConflictPolicy = kindCheck.value === 'text' ? 'pause-on-xr' : 'reject-on-xr';
    if (options.conflictPolicy !== undefined) {
      const cpCheck = validateEnum(options.conflictPolicy, 'conflictPolicy', RTT_CONFLICT_POLICIES);
      if (!cpCheck.ok) return cpCheck;
      conflictPolicy = cpCheck.value;
    }

    let channelIndex: number | undefined;
    if (options.channelIndex !== undefined) {
      const idxCheck = validateStrictInt(options.channelIndex, 'channelIndex', 0, 63);
      if (!idxCheck.ok) return idxCheck;
      channelIndex = idxCheck.value;
    }

    let channelName: string | undefined;
    if (options.channelName !== undefined) {
      const nameCheck = validateNonEmptyString(options.channelName, 'channelName');
      if (!nameCheck.ok) return nameCheck;
      channelName = nameCheck.value;
    }

    if (channelIndex === undefined && channelName === undefined) {
      return { ok: false, errorCode: 'InvalidRequest', message: 'subscribe requires channelIndex (0..63) or channelName' };
    }

    let pollIntervalMs: number | undefined;
    if (options.pollIntervalMs !== undefined) {
      const v = validateStrictInt(options.pollIntervalMs, 'pollIntervalMs', 1, 60000);
      if (!v.ok) return v;
      pollIntervalMs = v.value;
    }

    let maxBatchBytes: number | undefined;
    if (options.maxBatchBytes !== undefined) {
      const v = validateStrictInt(options.maxBatchBytes, 'maxBatchBytes', 1, 65536);
      if (!v.ok) return v;
      maxBatchBytes = v.value;
    }

    let maxQueueBytes: number | undefined;
    if (options.maxQueueBytes !== undefined) {
      const v = validateStrictInt(options.maxQueueBytes, 'maxQueueBytes', 1, 16 * 1024 * 1024);
      if (!v.ok) return v;
      maxQueueBytes = v.value;
    }

    let maxQueueBatches: number | undefined;
    if (options.maxQueueBatches !== undefined) {
      const v = validateStrictInt(options.maxQueueBatches, 'maxQueueBatches', 1, 4096);
      if (!v.ok) return v;
      maxQueueBatches = v.value;
    }

    let controlBlockAddress: number | undefined;
    if (options.controlBlockAddress !== undefined) {
      const v = validatePositiveUint32(options.controlBlockAddress, 'controlBlockAddress');
      if (!v.ok) return v;
      controlBlockAddress = v.value >>> 0;
    }

    let ramRanges: readonly CmsisDapRttMemoryRange[] | undefined;
    if (options.ramRanges !== undefined) {
      const checked = validateRttMemoryRanges(options.ramRanges, false, 'ramRanges');
      if (!checked.ok) {
        return { ok: false, errorCode: 'DapInvalidRequest', message: checked.message };
      }
      ramRanges = checked.normalized;
    }

    let roRanges: readonly CmsisDapRttMemoryRange[] | undefined;
    if (options.roRanges !== undefined) {
      const checked = validateRttMemoryRanges(options.roRanges, true, 'roRanges');
      if (!checked.ok) {
        return { ok: false, errorCode: 'DapInvalidRequest', message: checked.message };
      }
      roRanges = checked.normalized;
    }

    if (options.memoryBacked !== undefined && typeof options.memoryBacked !== 'boolean') {
      return { ok: false, errorCode: 'InvalidRequest', message: 'memoryBacked must be a boolean' };
    }
    if (options.retryInvalidControlBlock !== undefined && typeof options.retryInvalidControlBlock !== 'boolean') {
      return { ok: false, errorCode: 'InvalidRequest', message: 'retryInvalidControlBlock must be a boolean' };
    }

    // Preserve XR sampling conflict rejection before mutating any state.
    if (kindCheck.value === 'binary' && conflictPolicy === 'reject-on-xr' && this.host.isXrSamplingActive()) {
      return {
        ok: false,
        errorCode: 'SamplingConflict',
        message: 'XR-DAP probe Timeline sampling is active; stop Timeline sampling or choose best-effort/pause-on-xr mode',
        diagnostics: { xrSamplingActive: true, consumerId: consumerIdCheck.value },
      };
    }

    return {
      ok: true,
      parsed: {
        consumerId: consumerIdCheck.value,
        ...(channelIndex !== undefined ? { channelIndex } : {}),
        ...(channelName !== undefined ? { channelName } : {}),
        deliveryKind: kindCheck.value,
        deliveryMode,
        backpressurePolicy,
        conflictPolicy,
        ...(pollIntervalMs !== undefined ? { pollIntervalMs } : {}),
        ...(maxBatchBytes !== undefined ? { maxBatchBytes } : {}),
        ...(maxQueueBytes !== undefined ? { maxQueueBytes } : {}),
        ...(maxQueueBatches !== undefined ? { maxQueueBatches } : {}),
        ...(controlBlockAddress !== undefined ? { controlBlockAddress } : {}),
        ...(ramRanges !== undefined ? { ramRanges } : {}),
        ...(roRanges !== undefined ? { roRanges } : {}),
        ...(options.memoryBacked !== undefined ? { memoryBacked: options.memoryBacked } : {}),
        retryInvalidControlBlock: options.retryInvalidControlBlock === true,
      },
    };
  }

  /**
   * Synchronous subscription when the numeric Up bufferIndex is already known
   * (used by RTT Log polling so fake-timer launch/poll tests observe the timer
   * immediately without microtask drift).
   */
  subscribeByIndexSync(options: Omit<RttSubscribeOptions, 'channelName'> & { channelIndex: number }): RttSubscribeResult | RttOperationFailure {
    const preflight = this.validateSubscribeRequest(options);
    if (!preflight.ok) return preflight;
    const conflict = this.checkSessionBindingConflict(preflight.parsed);
    if (conflict) return conflict;

    const p = preflight.parsed;
    if (p.controlBlockAddress !== undefined) {
      this.controlBlockAddress = p.controlBlockAddress;
    }
    if (p.ramRanges !== undefined) {
      this.customRamRanges = p.ramRanges;
    }
    if (p.memoryBacked !== undefined) {
      this.memoryBacked = p.memoryBacked;
      this.memoryBackedSet = true;
    }
    return this.registerConsumerOnChannel(p.channelIndex!, undefined, {
      ...options,
      ...p,
    });
  }

  /** Synchronous immediate abortive unsubscribe (used by stopRttLogPolling). */
  unsubscribeImmediate(consumerId: string, bufferIndex?: number, notifyOwner = true): void {
    const targets: ChannelReaderState[] = [];
    if (bufferIndex !== undefined) {
      const ch = this.channels.get(bufferIndex);
      if (ch && ch.consumers.has(consumerId)) targets.push(ch);
    } else {
      for (const ch of this.channels.values()) {
        if (ch.consumers.has(consumerId)) targets.push(ch);
      }
    }
    for (const channel of targets) {
      channel.consumers.delete(consumerId);
      if (channel.consumers.size === 0) {
        this.stopChannelReader(channel, false);
        this.channels.delete(channel.bufferIndex);
      } else {
        this.evaluateBackpressurePause(channel);
        if (!this.suspendedForReset && channel.pausedReason === 'none') {
          this.ensureChannelTimerScheduled(channel);
        }
      }
    }
    if (this.channels.size === 0 && (this.ownerStarted || this.ownerTransitionPending > 0 || targets.length > 0)) {
      if (notifyOwner) {
        void this.requestOwnerStop();
      } else {
        this.ownerStarted = false;
      }
    }
    this.host.onTimerStateChanged?.();
  }

  /** Ensures owner startRtt has succeeded (e.g. for automation start). */
  async ensureStarted(controlBlockAddress?: number): Promise<OzoneCommandResult> {
    if (controlBlockAddress !== undefined) {
      this.controlBlockAddress = controlBlockAddress;
    }
    if (this.ownerStarted && this.ownerTransitionPending === 0) {
      return { ok: true, data: { controlBlockAddress: this.controlBlockAddress } };
    }
    if (this.controlBlockAddress === undefined) {
      const resolved = await this.host.ensureControlBlockAddress();
      if (!resolved.ok) {
        return { ok: false, errorCode: resolved.errorCode, error: resolved.message, diagnostics: resolved.diagnostics };
      }
      this.controlBlockAddress = resolved.address;
    }
    return await this.requestOwnerStart(this.controlBlockAddress, {
      ...(this.customRamRanges ? { ramRanges: this.customRamRanges } : {}),
      ...(this.memoryBacked ? { memoryBacked: true } : {}),
    });
  }

  /**
   * Single coordinated read for legacy/automation `orbitRttSnapshot` `read`:
   * if the channel already has active polling consumers, drains from a
   * coordinated pull consumer rather than launching a second reader on the
   * same Up channel; otherwise performs one gate-protected read.
   */
  async readOnceCoordinated(
    consumerId: string,
    bufferIndex: number,
    maxBytes: number,
  ): Promise<OzoneCommandResult> {
    if (this.disposed || this.host.isTerminating()) {
      return { ok: false, errorCode: 'SessionTerminating', error: 'Debug session is terminating' };
    }
    if (!this.rttAvailable) {
      return { ok: false, errorCode: 'CapabilityUnavailable', error: 'RTT is unavailable for this session' };
    }
    const channel = this.channels.get(bufferIndex);
    if (channel && channel.consumers.size > 0) {
      const existing = channel.consumers.get(consumerId);
      if (existing && existing.deliveryMode === 'pull') {
        const pulled = this.pull(consumerId, bufferIndex, maxBytes);
        const combined = pulled.batches.length === 1
          ? pulled.batches[0].bytes
          : Buffer.concat(pulled.batches.map(b => Buffer.from(b.bytes)));
        return {
          ok: true,
          data: {
            bytes: combined,
            bufferIndex,
            readBytes: combined.length,
            hostDroppedBytes: pulled.hostDroppedBytes,
            targetOverruns: pulled.targetOverruns,
          },
        };
      }
      // Another consumer (e.g. rtt-log) already owns polling on this channel;
      // attach a deduplicated pull consumer so we share its single reader!
      const sub = this.subscribeByIndexSync({
        consumerId,
        channelIndex: bufferIndex,
        deliveryKind: 'binary',
        deliveryMode: 'pull',
        conflictPolicy: 'best-effort',
      });
      if (!sub.ok) return { ok: false, errorCode: sub.errorCode, error: sub.message, diagnostics: sub.diagnostics };
      const pulled = this.pull(consumerId, bufferIndex, maxBytes);
      const combined = pulled.batches.length === 1
        ? pulled.batches[0].bytes
        : Buffer.concat(pulled.batches.map(b => Buffer.from(b.bytes)));
      return {
        ok: true,
        data: {
          bytes: combined,
          bufferIndex,
          readBytes: combined.length,
          hostDroppedBytes: pulled.hostDroppedBytes,
          targetOverruns: pulled.targetOverruns,
        },
      };
    }

    // No active polling reader on this channel: perform a single gate-protected read.
    const abort = new AbortController();
    const acquired = await this.host.acquireReadGate('background', 500, abort.signal);
    if (!acquired) {
      return { ok: false, errorCode: 'TargetReadCancelled', error: 'Target read gate unavailable for RTT read' };
    }
    try {
      if (this.disposed || this.host.isTerminating() || this.host.isControlInProgress()) {
        return { ok: false, errorCode: 'TargetReadCancelled', error: 'RTT read cancelled by control or termination' };
      }
      if (!this.ownerStarted) {
        const started = await this.ensureStarted();
        if (!started.ok) return started;
      }
      return await this.host.readRtt(bufferIndex, maxBytes, abort.signal);
    } finally {
      this.host.releaseReadGate();
    }
  }

  /** Executes a Down-buffer write under the host control critical section without blind retries. */
  async writeDown(options: {
    bufferIndex?: number;
    channelName?: string;
    bytes: Uint8Array;
    controlBlockAddress?: number;
    ramRanges?: readonly CmsisDapRttMemoryRange[];
    roRanges?: readonly CmsisDapRttMemoryRange[];
    timeoutMs?: number;
  }): Promise<OzoneCommandResult> {
    if (this.disposed || this.host.isTerminating()) {
      return { ok: false, errorCode: 'SessionTerminating', error: 'Debug session is terminating' };
    }
    if (!this.host.writeRtt) {
      return { ok: false, errorCode: 'UnsupportedCapability', error: 'Selected owner does not support writeRtt' };
    }
    if (options.controlBlockAddress !== undefined) {
      const v = validatePositiveUint32(options.controlBlockAddress, 'controlBlockAddress');
      if (!v.ok) return { ok: false, errorCode: v.errorCode, error: v.message, diagnostics: v.diagnostics };
      if (this.controlBlockAddress !== undefined && (v.value >>> 0) !== (this.controlBlockAddress >>> 0)) {
        return {
          ok: false,
          errorCode: 'RttControlBlockConflict',
          error: `RTT session is already bound to control block 0x${this.controlBlockAddress.toString(16)}; conflicting 0x${(v.value >>> 0).toString(16)} rejected`,
        };
      }
    }
    if (options.ramRanges !== undefined) {
      const checked = validateRttMemoryRanges(options.ramRanges, false, 'ramRanges');
      if (!checked.ok) return { ok: false, errorCode: 'DapInvalidRequest', error: checked.message };
    }
    if (options.roRanges !== undefined) {
      const checked = validateRttMemoryRanges(options.roRanges, true, 'roRanges');
      if (!checked.ok) return { ok: false, errorCode: 'DapInvalidRequest', error: checked.message };
    }
    if (options.timeoutMs !== undefined) {
      const v = validateStrictInt(options.timeoutMs, 'timeoutMs', 1, 60000);
      if (!v.ok) return { ok: false, errorCode: v.errorCode, error: v.message, diagnostics: v.diagnostics };
    }
    if (options.bufferIndex !== undefined) {
      const v = validateStrictInt(options.bufferIndex, 'bufferIndex', 0, 63, 'DapInvalidRequest');
      if (!v.ok) return { ok: false, errorCode: v.errorCode, error: v.message, diagnostics: v.diagnostics };
    }
    if (options.channelName !== undefined) {
      const v = validateNonEmptyString(options.channelName, 'channelName');
      if (!v.ok) return { ok: false, errorCode: v.errorCode, error: v.message, diagnostics: v.diagnostics };
    }
    if (options.bufferIndex === undefined && options.channelName === undefined) {
      return { ok: false, errorCode: 'DapInvalidRequest', error: 'writeDown requires bufferIndex or channelName' };
    }

    const caps = await this.host.getRttCapabilities();
    if (!caps.rttDownWrite.available) {
      return {
        ok: false,
        errorCode: 'UnsupportedCapability',
        error: caps.rttDownWrite.reason || 'Selected owner does not support RTT down-buffer writes',
      };
    }

    let cbAddr = options.controlBlockAddress !== undefined ? (options.controlBlockAddress >>> 0) : this.controlBlockAddress;
    if (cbAddr === undefined) {
      const resolved = await this.host.ensureControlBlockAddress();
      if (!resolved.ok) {
        return { ok: false, errorCode: resolved.errorCode, error: resolved.message, diagnostics: resolved.diagnostics };
      }
      cbAddr = resolved.address >>> 0;
    }

    let bufferIndex: number;
    if (options.channelName !== undefined) {
      const resolved = await this.resolveChannelByName('down', options.channelName, {
        controlBlockAddress: cbAddr,
        ramRanges: options.ramRanges,
        roRanges: options.roRanges,
        timeoutMs: options.timeoutMs,
      });
      if (!resolved.ok) {
        return { ok: false, errorCode: resolved.errorCode, error: resolved.message, diagnostics: resolved.diagnostics };
      }
      bufferIndex = resolved.index;
    } else {
      bufferIndex = options.bufferIndex!;
    }

    const executeWrite = async (): Promise<OzoneCommandResult> => {
      const res = await this.host.writeRtt!(bufferIndex, options.bytes, {
        controlBlockAddress: cbAddr,
        ...(options.ramRanges ? { ramRanges: options.ramRanges } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      });
      if (!res.ok && isOwnerLossErrorCode(res.errorCode)) {
        this.host.onOwnerLost(res.errorCode || 'RttOwnerLost');
      }
      return res;
    };

    if (this.host.withWriteControlGate) {
      return this.host.withWriteControlGate(executeWrite);
    }
    return executeWrite();
  }

  setRttAvailable(available: boolean): void {
    this.rttAvailable = available;
  }

  setControlBlockAddress(address: number | undefined): void {
    this.controlBlockAddress = address;
  }

  getBudget(bufferIndex = 0, memoryBacked = this.memoryBacked): RttTransportBudget {
    return resolveRttTransportBudget(
      this.host.ownerKind(),
      this.host.transportKind(),
      bufferIndex,
      memoryBacked,
    );
  }

  async resolveChannelByName(
    direction: 'up' | 'down',
    channelName: string,
    options: {
      controlBlockAddress?: number;
      ramRanges?: readonly CmsisDapRttMemoryRange[];
      roRanges?: readonly CmsisDapRttMemoryRange[];
      timeoutMs?: number;
    } = {},
  ): Promise<{ ok: true; index: number; descriptor: CmsisDapRttChannelDescriptor; enumResult: CmsisDapRttEnumResult } | RttOperationFailure> {
    if (this.disposed || this.host.isTerminating()) {
      return { ok: false, errorCode: 'SessionTerminating', message: 'Debug session is terminating' };
    }
    const trimmed = channelName.trim();
    if (!trimmed) {
      return { ok: false, errorCode: 'InvalidRequest', message: 'RTT channelName must be a non-empty string' };
    }
    if (options.controlBlockAddress !== undefined) {
      const v = validatePositiveUint32(options.controlBlockAddress, 'controlBlockAddress');
      if (!v.ok) return v;
      if (this.controlBlockAddress !== undefined && (v.value >>> 0) !== (this.controlBlockAddress >>> 0)) {
        return {
          ok: false,
          errorCode: 'RttControlBlockConflict',
          message: `RTT session is already bound to control block 0x${this.controlBlockAddress.toString(16)}; conflicting 0x${(v.value >>> 0).toString(16)} rejected`,
          diagnostics: {
            boundControlBlockAddress: this.controlBlockAddress,
            requestedControlBlockAddress: v.value >>> 0,
          },
        };
      }
    }
    if (options.ramRanges !== undefined) {
      const checked = validateRttMemoryRanges(options.ramRanges, false, 'ramRanges');
      if (!checked.ok) return { ok: false, errorCode: 'DapInvalidRequest', message: checked.message };
    }
    if (options.roRanges !== undefined) {
      const checked = validateRttMemoryRanges(options.roRanges, true, 'roRanges');
      if (!checked.ok) return { ok: false, errorCode: 'DapInvalidRequest', message: checked.message };
    }
    if (options.timeoutMs !== undefined) {
      const v = validateStrictInt(options.timeoutMs, 'timeoutMs', 1, 60000);
      if (!v.ok) return v;
    }
    const caps = await this.host.getRttCapabilities();
    if (!caps.rttEnumerate.available) {
      return {
        ok: false,
        errorCode: 'UnsupportedCapability',
        message: caps.rttEnumerate.reason || 'Selected target owner does not support RTT channel enumeration',
        diagnostics: { ownerKind: caps.ownerKind, channelName: trimmed, direction },
      };
    }

    let cbAddr = options.controlBlockAddress !== undefined ? (options.controlBlockAddress >>> 0) : this.controlBlockAddress;
    if (cbAddr === undefined) {
      const resolved = await this.host.ensureControlBlockAddress();
      if (!resolved.ok) return resolved;
      cbAddr = resolved.address >>> 0;
    }

    const identityBefore = this.host.identity();
    const abort = new AbortController();
    const gateAcquired = await this.host.acquireReadGate('watch', options.timeoutMs ?? 1200, abort.signal);
    if (!gateAcquired) {
      return {
        ok: false,
        errorCode: this.host.isControlInProgress() ? 'TargetBusy' : 'TargetReadUnavailable',
        message: 'Target read gate unavailable for RTT channel enumeration',
      };
    }
    let enumRes: OzoneCommandResult;
    try {
      if (this.disposed || this.host.isTerminating()) {
        return { ok: false, errorCode: 'SessionTerminating', message: 'Debug session is terminating' };
      }
      enumRes = await this.host.enumerateRtt(cbAddr, options);
    } finally {
      this.host.releaseReadGate();
    }

    const identityAfter = this.host.identity();
    if (this.disposed || identityAfter.sessionGeneration !== identityBefore.sessionGeneration
      || identityAfter.bootGeneration !== identityBefore.bootGeneration) {
      return { ok: false, errorCode: 'SessionChanged', message: 'Session or boot generation changed during RTT enumeration' };
    }

    if (!enumRes.ok) {
      if (isOwnerLossErrorCode(enumRes.errorCode)) {
        this.host.onOwnerLost(enumRes.errorCode || 'RttOwnerLost');
      }
      return {
        ok: false,
        errorCode: enumRes.errorCode || 'RttEnumerateFailed',
        message: enumRes.error,
        diagnostics: enumRes.diagnostics,
      };
    }

    const data = enumRes.data as CmsisDapRttEnumResult;
    const list = direction === 'up' ? data.upBuffers : data.downBuffers;
    const duplicates = direction === 'up' ? data.duplicateUpNames : data.duplicateDownNames;

    if (duplicates.includes(trimmed)) {
      const matchingIndices = list
        .filter(d => d.valid && d.nameStatus === 'ok' && d.name === trimmed)
        .map(d => d.index);
      return {
        ok: false,
        errorCode: 'RttDuplicateChannelName',
        message: `RTT ${direction} channel name "${trimmed}" is duplicated at indices [${matchingIndices.join(', ')}]`,
        diagnostics: { direction, channelName: trimmed, matchingIndices, controlBlockAddress: data.controlBlockAddress },
      };
    }

    const matches = list.filter(d => d.valid && d.nameStatus === 'ok' && d.name === trimmed);
    if (matches.length > 1) {
      const matchingIndices = matches.map(d => d.index);
      return {
        ok: false,
        errorCode: 'RttDuplicateChannelName',
        message: `RTT ${direction} channel name "${trimmed}" matched multiple descriptors [${matchingIndices.join(', ')}]`,
        diagnostics: { direction, channelName: trimmed, matchingIndices, controlBlockAddress: data.controlBlockAddress },
      };
    }

    if (matches.length === 0) {
      const available = list
        .filter(d => d.valid)
        .map(d => ({ index: d.index, name: d.name, nameStatus: d.nameStatus, nameError: d.nameError }));
      const corrupt = list
        .filter(d => d.status === 'corrupt')
        .map(d => ({ index: d.index, errorCode: d.errorCode, errorMessage: d.errorMessage }));
      return {
        ok: false,
        errorCode: 'RttChannelUnavailable',
        message: `RTT ${direction} channel "${trimmed}" was not found or is unavailable`,
        diagnostics: {
          direction,
          channelName: trimmed,
          controlBlockAddress: data.controlBlockAddress,
          available,
          corrupt,
        },
      };
    }

    return {
      ok: true,
      index: matches[0].index,
      descriptor: matches[0],
      enumResult: data,
    };
  }

  async subscribe(options: RttSubscribeOptions): Promise<RttSubscribeResult | RttOperationFailure> {
    const preflight = this.validateSubscribeRequest(options);
    if (!preflight.ok) return preflight;

    return this.enqueueSubscribe(async () => {
      const p = preflight.parsed;
      if (this.disposed || this.host.isTerminating()) {
        return { ok: false, errorCode: 'SessionTerminating', message: 'Debug session is terminating' };
      }
      if (!this.rttAvailable) {
        return { ok: false, errorCode: 'CapabilityUnavailable', message: 'RTT is unavailable for this session' };
      }
      if (p.deliveryKind === 'binary' && p.conflictPolicy === 'reject-on-xr' && this.host.isXrSamplingActive()) {
        return {
          ok: false,
          errorCode: 'SamplingConflict',
          message: 'XR-DAP probe Timeline sampling is active; stop Timeline sampling or choose best-effort/pause-on-xr mode',
          diagnostics: { xrSamplingActive: true, consumerId: p.consumerId },
        };
      }

      const conflict = this.checkSessionBindingConflict(p);
      if (conflict) return conflict;

      let candidateCbAddr = p.controlBlockAddress ?? this.controlBlockAddress;
      if (candidateCbAddr === undefined) {
        const resolved = await this.host.ensureControlBlockAddress();
        if (!resolved.ok) return resolved;
        candidateCbAddr = resolved.address >>> 0;
      }

      let bufferIndex: number;
      let resolvedChannelName: string | undefined = p.channelName;

      if (p.channelName !== undefined) {
        const resolved = await this.resolveChannelByName('up', p.channelName, {
          controlBlockAddress: candidateCbAddr,
          ramRanges: p.ramRanges ?? this.customRamRanges,
          roRanges: p.roRanges,
        });
        if (!resolved.ok) return resolved;
        bufferIndex = resolved.index;
        resolvedChannelName = resolved.descriptor.name;
      } else {
        bufferIndex = p.channelIndex!;
      }

      const existing = this.channels.get(bufferIndex)?.consumers.get(p.consumerId);
      if (existing && existing.deliveryKind !== p.deliveryKind) {
        return {
          ok: false,
          errorCode: 'InvalidRequest',
          message: `consumerId "${p.consumerId}" is already subscribed on channel ${bufferIndex} with deliveryKind=${existing.deliveryKind}`,
        };
      }

      // Commit session binding only after every validation & resolution succeeds.
      this.controlBlockAddress = candidateCbAddr;
      if (p.ramRanges !== undefined) {
        this.customRamRanges = p.ramRanges;
      }
      if (p.memoryBacked !== undefined) {
        this.memoryBacked = p.memoryBacked;
        this.memoryBackedSet = true;
      }

      return this.registerConsumerOnChannel(bufferIndex, resolvedChannelName, {
        ...options,
        ...p,
      });
    });
  }

  private registerConsumerOnChannel(
    bufferIndex: number,
    resolvedChannelName: string | undefined,
    options: Omit<RttSubscribeOptions, 'channelName' | 'channelIndex'> & {
      consumerId: string;
      conflictPolicy: RttConflictPolicy;
    },
  ): RttSubscribeResult | RttOperationFailure {
    const consumerId = options.consumerId;
    const conflictPolicy = options.conflictPolicy;
    const budget = this.getBudget(bufferIndex, options.memoryBacked ?? this.memoryBacked);
    const requestedInterval = options.pollIntervalMs ?? budget.defaultPollIntervalMs;
    const pollIntervalMs = Math.max(budget.minPollIntervalMs, Math.min(5000, Math.floor(requestedInterval)));
    const requestedBatchBytes = options.maxBatchBytes ?? budget.maxBatchBytes;
    const maxBatchBytes = Math.max(1, Math.min(budget.maxBatchBytes, Math.floor(requestedBatchBytes)));
    const maxQueueBytes = options.maxQueueBytes !== undefined
      ? Math.min(16 * 1024 * 1024, Math.floor(options.maxQueueBytes))
      : Math.max(maxBatchBytes, DEFAULT_MAX_QUEUE_BYTES);
    const maxQueueBatches = Math.max(1, Math.min(4096, Math.floor(options.maxQueueBatches ?? DEFAULT_MAX_QUEUE_BATCHES)));

    let channel = this.channels.get(bufferIndex);
    if (!channel) {
      channel = {
        bufferIndex,
        channelName: resolvedChannelName,
        consumers: new Map(),
        generation: 0,
        timer: null,
        inFlight: false,
        inFlightPromise: null,
        abortController: null,
        pausedReason: 'none',
        batchSequence: 0,
        readCount: 0,
        totalBytesRead: 0,
        targetOverruns: 0,
        transportDroppedBytes: 0,
        lastTransportDropTotal: 0,
        hostDroppedBytes: 0,
        congested: false,
        transientStartLogged: false,
      };
      this.channels.set(bufferIndex, channel);
    } else if (resolvedChannelName && !channel.channelName) {
      channel.channelName = resolvedChannelName;
    }

    const existing = channel.consumers.get(consumerId);
    if (existing) {
      if (existing.deliveryKind !== options.deliveryKind) {
        return {
          ok: false,
          errorCode: 'InvalidRequest',
          message: `consumerId "${consumerId}" is already subscribed on channel ${bufferIndex} with deliveryKind=${existing.deliveryKind}`,
        };
      }
      // Subscription deduplication: preserve refCount, update callbacks/options.
      existing.pollIntervalMs = pollIntervalMs;
      existing.maxBatchBytes = maxBatchBytes;
      existing.maxQueueBytes = maxQueueBytes;
      existing.maxQueueBatches = maxQueueBatches;
      if (options.onBatch) existing.onBatch = options.onBatch;
      if (options.onDrop) existing.onDrop = options.onDrop;
      if (options.onStateChange) existing.onStateChange = options.onStateChange;
      if (options.onError) existing.onError = options.onError;
      return {
        ok: true,
        subscriptionId: existing.subscriptionId,
        consumerId,
        bufferIndex,
        channelName: channel.channelName,
        deduplicated: true,
        refCount: channel.consumers.size,
        budget,
      };
    }

    const subscriptionId = `rtt-sub-${++this.subscriptionSeq}`;
    const consumer: ConsumerState = {
      subscriptionId,
      consumerId,
      deliveryKind: options.deliveryKind,
      deliveryMode: options.deliveryMode ?? 'callback',
      pollIntervalMs,
      maxBatchBytes,
      maxQueueBytes,
      maxQueueBatches,
      backpressurePolicy: options.backpressurePolicy ?? 'pause-reader',
      conflictPolicy,
      retryInvalidControlBlock: options.retryInvalidControlBlock === true,
      paused: false,
      backpressured: false,
      queue: [],
      queuedBytes: 0,
      hostDroppedBytes: 0,
      hostDroppedBatches: 0,
      onBatch: options.onBatch,
      onDrop: options.onDrop,
      onStateChange: options.onStateChange,
      onError: options.onError,
    };

    channel.consumers.set(consumerId, consumer);
    if (!this.suspendedForReset && !this.disposed) {
      this.ensureChannelTimerScheduled(channel);
    }

    return {
      ok: true,
      subscriptionId,
      consumerId,
      bufferIndex,
      channelName: channel.channelName,
      deduplicated: false,
      refCount: channel.consumers.size,
      budget,
    };
  }

  async unsubscribe(
    consumerId: string,
    bufferIndex?: number,
    options: RttUnsubscribeOptions = {},
  ): Promise<RttUnsubscribeResult> {
    const targets: ChannelReaderState[] = [];
    if (bufferIndex !== undefined) {
      const ch = this.channels.get(bufferIndex);
      if (ch && ch.consumers.has(consumerId)) targets.push(ch);
    } else {
      for (const ch of this.channels.values()) {
        if (ch.consumers.has(consumerId)) targets.push(ch);
      }
    }

    if (targets.length === 0) {
      return {
        ok: false,
        bufferIndex: bufferIndex ?? -1,
        consumerId,
        remainingRefCount: 0,
        errorCode: 'InvalidRequest',
        message: `No active RTT subscription for consumerId=${consumerId}`,
      };
    }

    let lastResult: RttUnsubscribeResult = {
      ok: true,
      bufferIndex: targets[0].bufferIndex,
      consumerId,
      remainingRefCount: 0,
    };

    for (const channel of targets) {
      let drainedBatch: RttChannelBatch | undefined;
      const isLastConsumerOnChannel = channel.consumers.size === 1;

      if (options.drainLastBatch && isLastConsumerOnChannel && !this.disposed && !this.host.isTerminating()) {
        drainedBatch = await this.drainChannelLastBatch(channel, consumerId, options.drainTimeoutMs ?? 1000);
      }

      const leavingConsumer = channel.consumers.get(consumerId);
      if (leavingConsumer && leavingConsumer.deliveryMode === 'callback' && leavingConsumer.queue.length > 0) {
        if (!leavingConsumer.paused && !leavingConsumer.backpressured) {
          this.flushCallbackQueue(channel, leavingConsumer);
        }
        if (leavingConsumer.queue.length > 0) {
          const droppedBatches = leavingConsumer.queue.length;
          const droppedBytes = leavingConsumer.queuedBytes;
          leavingConsumer.queue.length = 0;
          leavingConsumer.queuedBytes = 0;
          leavingConsumer.hostDroppedBytes += droppedBytes;
          leavingConsumer.hostDroppedBatches += droppedBatches;
          channel.hostDroppedBytes += droppedBytes;
          channel.congested = true;
          leavingConsumer.onDrop?.({
            bufferIndex: channel.bufferIndex,
            consumerId: leavingConsumer.consumerId,
            reason: 'host-drop',
            droppedBytes,
            droppedBatches,
            totalHostDroppedBytes: leavingConsumer.hostDroppedBytes,
            totalTargetOverruns: channel.targetOverruns,
          });
        }
      }

      channel.consumers.delete(consumerId);
      const remaining = channel.consumers.size;
      if (remaining === 0) {
        this.stopChannelReader(channel, false);
        this.channels.delete(channel.bufferIndex);
      } else {
        // Re-evaluate backpressure if the removed consumer was the paused one.
        this.evaluateBackpressurePause(channel);
        if (!this.suspendedForReset && channel.pausedReason === 'none') {
          this.ensureChannelTimerScheduled(channel);
        }
      }

      lastResult = {
        ok: true,
        bufferIndex: channel.bufferIndex,
        consumerId,
        remainingRefCount: remaining,
        ...(drainedBatch ? { drainedBatch } : {}),
      };
    }

    if (this.channels.size === 0 && (this.ownerStarted || this.ownerTransitionPending > 0)) {
      await this.requestOwnerStop();
    }

    return lastResult;
  }

  pull(
    consumerId: string,
    bufferIndex: number,
    maxBytes?: number,
  ): {
    ok: boolean;
    batches: RttChannelBatch[];
    totalBytes: number;
    remainingQueuedBytes: number;
    hostDroppedBytes: number;
    targetOverruns: number;
    congested: boolean;
    errorCode?: string;
    message?: string;
  } {
    const channel = this.channels.get(bufferIndex);
    const consumer = channel?.consumers.get(consumerId);
    if (!channel || !consumer) {
      return {
        ok: false,
        batches: [],
        totalBytes: 0,
        remainingQueuedBytes: 0,
        hostDroppedBytes: 0,
        targetOverruns: 0,
        congested: false,
        errorCode: 'InvalidRequest',
        message: `No active subscription for consumerId=${consumerId} on channel ${bufferIndex}`,
      };
    }

    const limit = maxBytes !== undefined && maxBytes > 0 ? maxBytes : Number.POSITIVE_INFINITY;
    const batches: RttChannelBatch[] = [];
    let totalBytes = 0;

    while (consumer.queue.length > 0) {
      const next = consumer.queue[0];
      if (batches.length > 0 && totalBytes + next.bytes.length > limit) break;
      consumer.queue.shift();
      consumer.queuedBytes = Math.max(0, consumer.queuedBytes - next.bytes.length);
      totalBytes += next.bytes.length;
      batches.push(next);
      if (totalBytes >= limit) break;
    }

    const lowWater = Math.floor(consumer.maxQueueBytes * LOW_WATER_RATIO);
    if (consumer.backpressured && consumer.queuedBytes <= lowWater && consumer.queue.length < consumer.maxQueueBatches) {
      consumer.backpressured = false;
      this.evaluateBackpressurePause(channel);
      if (!this.suspendedForReset && channel.pausedReason === 'none') {
        this.ensureChannelTimerScheduled(channel);
      }
    }

    return {
      ok: true,
      batches,
      totalBytes,
      remainingQueuedBytes: consumer.queuedBytes,
      hostDroppedBytes: consumer.hostDroppedBytes,
      targetOverruns: channel.targetOverruns,
      congested: channel.congested || consumer.backpressured || consumer.hostDroppedBytes > 0,
    };
  }

  setConsumerPaused(consumerId: string, bufferIndex: number, paused: boolean): boolean {
    const channel = this.channels.get(bufferIndex);
    const consumer = channel?.consumers.get(consumerId);
    if (!channel || !consumer) return false;
    consumer.paused = paused;
    if (!paused) {
      if (consumer.deliveryMode === 'callback') {
        consumer.backpressured = false;
        this.flushCallbackQueue(channel, consumer);
      } else {
        const lowWater = Math.floor(consumer.maxQueueBytes * LOW_WATER_RATIO);
        if (consumer.queuedBytes <= lowWater && consumer.queue.length < consumer.maxQueueBatches) {
          consumer.backpressured = false;
        }
      }
    }
    this.evaluateBackpressurePause(channel);
    this.notifyChannelState(channel);
    if (!paused && !consumer.backpressured && !this.suspendedForReset && channel.pausedReason === 'none') {
      this.ensureChannelTimerScheduled(channel);
    }
    return true;
  }

  /**
   * Explicitly drains queued RTT Up bytes on an active subscription across multiple
   * single-owner, budget-sized batches until the ring empties (`bytes.length === 0` or
   * `committedRdOff === wrOff`), the consumer/channel is paused/backpressured, an error
   * or identity change occurs, or `timeoutMs` expires.
   *
   * Existing `unsubscribe()` behavior for all 3.4 consumers remains unchanged.
   */
  async drainConsumer(
    consumerId: string,
    bufferIndex: number,
    options: RttDrainOptions = {},
  ): Promise<RttDrainResult> {
    const channel = this.channels.get(bufferIndex);
    const consumer = channel?.consumers.get(consumerId);
    if (!channel || !consumer) {
      return {
        ok: false,
        bufferIndex,
        consumerId,
        drained: false,
        reason: 'error',
        batchesDrained: 0,
        bytesDrained: 0,
        lastBatchSequence: channel?.batchSequence ?? 0,
        errorCode: 'InvalidRequest',
        message: `No active subscription for consumerId=${consumerId} on channel ${bufferIndex}`,
      };
    }

    const now = () => (this.host.nowMs ? this.host.nowMs() : Date.now());
    const timeoutMs = Math.max(1, options.timeoutMs ?? 2000);
    const deadlineMs = now() + timeoutMs;

    if (channel.timer) {
      clearTimeout(channel.timer);
      channel.timer = null;
      this.host.onTimerStateChanged?.();
    }

    if (channel.inFlightPromise) {
      const waitMs = Math.max(1, Math.min(timeoutMs, deadlineMs - now()));
      await Promise.race([
        channel.inFlightPromise,
        new Promise<void>(resolve => setTimeout(resolve, waitMs)),
      ]);
    }

    if (consumer.deliveryMode === 'callback' && consumer.queue.length > 0 && !consumer.paused && !consumer.backpressured) {
      this.flushCallbackQueue(channel, consumer);
    }

    const generation = channel.generation;
    const coordinatorGen = this.coordinatorGeneration;
    let batchesDrained = 0;
    let bytesDrained = 0;
    let stopReason: RttDrainResult['reason'] = 'empty';
    let failureCode: string | undefined;
    let failureMessage: string | undefined;

    const buildResult = (ok: boolean, drained: boolean): RttDrainResult => ({
      ok,
      bufferIndex: channel.bufferIndex,
      consumerId,
      drained,
      reason: stopReason,
      batchesDrained,
      bytesDrained,
      lastBatchSequence: channel.batchSequence,
      ...(channel.lastRdOff !== undefined ? { lastRdOff: channel.lastRdOff } : {}),
      ...(channel.lastWrOff !== undefined ? { lastWrOff: channel.lastWrOff } : {}),
      ...(channel.bufferSize !== undefined ? { bufferSize: channel.bufferSize } : {}),
      ...(failureCode ? { errorCode: failureCode } : {}),
      ...(failureMessage ? { message: failureMessage } : {}),
    });

    try {
      while (true) {
        if (this.disposed || this.host.isTerminating() || generation !== channel.generation
          || coordinatorGen !== this.coordinatorGeneration || !channel.consumers.has(consumerId)) {
          stopReason = 'aborted';
          return buildResult(true, false);
        }
        if (this.suspendedForReset) {
          stopReason = 'reset';
          return buildResult(true, false);
        }
        if (consumer.paused) {
          stopReason = 'paused';
          return buildResult(true, false);
        }
        if (consumer.backpressured) {
          stopReason = 'backpressured';
          return buildResult(true, false);
        }
        if (this.shouldPauseForXr(channel)) {
          channel.pausedReason = 'xr-timeline-active';
          stopReason = 'xr-paused';
          return buildResult(true, false);
        }
        if (this.host.isControlInProgress()) {
          channel.pausedReason = 'control';
          stopReason = 'control';
          return buildResult(true, false);
        }

        const remainingMs = deadlineMs - now();
        if (remainingMs <= 0) {
          stopReason = 'timeout';
          return buildResult(true, false);
        }

        const abort = new AbortController();
        const gateAcquired = await this.host.acquireReadGate('background', Math.max(1, remainingMs), abort.signal);
        if (!gateAcquired) {
          stopReason = this.host.isTerminating() || this.disposed
            ? 'aborted'
            : this.suspendedForReset
              ? 'reset'
              : this.host.isControlInProgress()
                ? 'control'
                : 'timeout';
          return buildResult(true, false);
        }

        let readResult: OzoneCommandResult;
        const identityBefore = this.host.identity();
        const batchSize = this.effectiveBatchBytes(channel);
        try {
          if (this.disposed || this.host.isTerminating() || generation !== channel.generation
            || coordinatorGen !== this.coordinatorGeneration) {
            stopReason = 'aborted';
            return buildResult(true, false);
          }
          if (this.suspendedForReset) {
            stopReason = 'reset';
            return buildResult(true, false);
          }
          if (this.host.isControlInProgress()) {
            stopReason = 'control';
            return buildResult(true, false);
          }

          if (!this.ownerStarted || this.ownerTransitionPending > 0) {
            if (this.controlBlockAddress === undefined) {
              const resolved = await this.host.ensureControlBlockAddress();
              if (!resolved.ok) {
                const failRes: Extract<OzoneCommandResult, { ok: false }> = {
                  ok: false,
                  errorCode: resolved.errorCode,
                  error: resolved.message,
                  diagnostics: resolved.diagnostics,
                };
                this.handleTransportFailure(channel, 'startRtt', failRes);
                stopReason = 'error';
                failureCode = resolved.errorCode;
                failureMessage = resolved.message;
                return buildResult(false, false);
              }
              this.controlBlockAddress = resolved.address;
            }
            const startRes = await this.requestOwnerStart(this.controlBlockAddress, {
              ...(this.customRamRanges ? { ramRanges: this.customRamRanges } : {}),
              ...(this.memoryBacked ? { memoryBacked: true } : {}),
            });
            if (!startRes.ok) {
              this.handleTransportFailure(channel, 'startRtt', startRes);
              stopReason = 'error';
              failureCode = startRes.errorCode || 'RttStartFailed';
              failureMessage = startRes.error;
              return buildResult(false, false);
            }
          }

          readResult = await this.host.readRtt(channel.bufferIndex, batchSize, abort.signal);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const code = typeof (err as { errorCode?: unknown })?.errorCode === 'string'
            ? (err as { errorCode: string }).errorCode
            : 'RttDrainReadFailed';
          stopReason = 'error';
          failureCode = code;
          failureMessage = msg;
          return buildResult(false, false);
        } finally {
          this.host.releaseReadGate();
        }

        const identityAfter = this.host.identity();
        if (this.disposed || this.host.isTerminating() || generation !== channel.generation
          || coordinatorGen !== this.coordinatorGeneration) {
          stopReason = 'aborted';
          return buildResult(true, false);
        }
        if (identityAfter.sessionGeneration !== identityBefore.sessionGeneration
          || identityAfter.bootGeneration !== identityBefore.bootGeneration) {
          stopReason = 'reset';
          failureCode = 'TargetReset';
          failureMessage = 'Target session/boot generation changed during RTT drain';
          return buildResult(false, false);
        }

        const emitted = this.handleReadResult(channel, readResult, batchSize, false);
        if (!readResult.ok) {
          stopReason = 'error';
          failureCode = readResult.errorCode || 'RttReadFailed';
          failureMessage = readResult.error;
          return buildResult(false, false);
        }
        if (!emitted) {
          stopReason = 'empty';
          return buildResult(true, true);
        }

        batchesDrained++;
        bytesDrained += emitted.bytes.length;

        if (emitted.committedRdOff !== undefined && emitted.wrOff !== undefined
          && emitted.committedRdOff === emitted.wrOff && !emitted.writerAdvanced) {
          stopReason = 'empty';
          return buildResult(true, true);
        }
      }
    } finally {
      if (!this.disposed && !this.suspendedForReset && this.rttAvailable
        && channel.consumers.size > 0 && channel.pausedReason === 'none') {
        this.ensureChannelTimerScheduled(channel);
      }
      this.host.onTimerStateChanged?.();
    }
  }

  /**
   * Called by DapSession.beginControl() when a normal control critical section
   * (halt/continue/step/write) begins. Pauses scheduling of new RTT reads for
   * the entire critical section without discarding already-submitted reads that
   * physically committed RdOff on the target.
   */
  onControlStarted(): void {
    for (const channel of this.channels.values()) {
      if (channel.pausedReason === 'none') {
        channel.pausedReason = 'control';
      }
    }
  }

  /** Called by DapSession.endControl() to resume waiting channels. */
  onControlEnded(): void {
    if (this.disposed || this.suspendedForReset || this.host.isTerminating()) return;
    for (const channel of this.channels.values()) {
      if (channel.pausedReason === 'control') {
        channel.pausedReason = 'none';
      }
      this.evaluateBackpressurePause(channel);
      if (channel.pausedReason === 'none') {
        this.ensureChannelTimerScheduled(channel);
      }
    }
  }

  /** Called by DapSession.handleRestart() / handleAutomationFlash() before target reset/flash. */
  async suspendForTargetReset(forceStopRtt = false): Promise<void> {
    this.suspendedForReset = true;
    this.coordinatorGeneration++;
    for (const channel of this.channels.values()) {
      this.stopChannelReader(channel, false);
      channel.pausedReason = 'reset';
    }
    this.host.onTimerStateChanged?.();
    if (this.channels.size > 0 || this.ownerStarted || this.ownerTransitionPending > 0) {
      await this.requestOwnerStop();
    } else if (forceStopRtt) {
      await this.enqueueOwnerTransition(() => this.host.stopRtt());
    }
  }

  /** Called after Restart/Flash completes to resume active consumers cleanly. */
  resumeAfterTargetReset(): void {
    if (this.disposed || this.host.isTerminating()) return;
    this.suspendedForReset = false;
    for (const channel of this.channels.values()) {
      channel.pausedReason = 'none';
      channel.transientStartLogged = false;
      this.evaluateBackpressurePause(channel);
      if (channel.pausedReason === 'none') {
        this.ensureChannelTimerScheduled(channel);
      }
    }
    this.host.onTimerStateChanged?.();
  }

  /** Called when XR-DAP probe sampling starts or stops. */
  onXrSamplingStateChanged(): void {
    if (this.disposed || this.suspendedForReset) return;
    const xrActive = this.host.isXrSamplingActive();
    for (const channel of this.channels.values()) {
      if (xrActive) {
        const hasBestEffortBinary = [...channel.consumers.values()]
          .some(c => c.deliveryKind === 'binary' && c.conflictPolicy === 'best-effort');
        if (!hasBestEffortBinary) {
          channel.pausedReason = 'xr-timeline-active';
          this.notifyChannelState(channel);
        } else {
          channel.congested = true;
          this.notifyChannelState(channel);
        }
      } else {
        if (channel.pausedReason === 'xr-timeline-active') {
          channel.pausedReason = 'none';
          this.evaluateBackpressurePause(channel);
          this.notifyChannelState(channel);
        }
        if (channel.pausedReason === 'none') {
          this.ensureChannelTimerScheduled(channel);
        }
      }
    }
  }

  snapshot(): RttCoordinatorSnapshot {
    return {
      identity: this.host.identity(),
      disposed: this.disposed,
      ownerStarted: this.ownerStarted,
      rttAvailable: this.rttAvailable,
      ...(this.controlBlockAddress !== undefined ? { controlBlockAddress: this.controlBlockAddress } : {}),
      xrSamplingActive: this.host.isXrSamplingActive(),
      activeChannelCount: this.channels.size,
      channels: [...this.channels.values()].map(ch => this.channelStatus(ch)),
    };
  }

  getChannelStatus(bufferIndex: number): RttChannelStatus | undefined {
    const channel = this.channels.get(bufferIndex);
    return channel ? this.channelStatus(channel) : undefined;
  }

  dispose(notifyOwner = true): void {
    if (this.disposed) return;
    this.disposed = true;
    this.coordinatorGeneration++;
    const hadChannels = this.channels.size > 0;
    for (const channel of this.channels.values()) {
      this.stopChannelReader(channel, false);
      channel.consumers.clear();
    }
    this.channels.clear();
    this.channelQueue.length = 0;
    const wasStarted = this.ownerStarted;
    if (notifyOwner && (wasStarted || hadChannels || this.ownerTransitionPending > 0)) {
      void this.requestOwnerStop();
    } else {
      this.ownerStarted = false;
    }
    this.host.onTimerStateChanged?.();
  }

  private enqueueOwnerTransition<T>(fn: () => Promise<T>): Promise<T> {
    this.ownerTransitionPending++;
    const run = this.ownerTransitionPending === 1
      ? fn()
      : this.ownerLifecycleQueue.then(fn, fn);
    this.ownerLifecycleQueue = run.then(
      () => {
        this.ownerTransitionPending = Math.max(0, this.ownerTransitionPending - 1);
      },
      () => {
        this.ownerTransitionPending = Math.max(0, this.ownerTransitionPending - 1);
      },
    );
    return run;
  }

  private requestOwnerStart(
    controlBlockAddress: number,
    options?: { ramRanges?: readonly CmsisDapRttMemoryRange[]; memoryBacked?: boolean },
  ): Promise<OzoneCommandResult> {
    return this.enqueueOwnerTransition<OzoneCommandResult>(() => {
      if (this.disposed || this.suspendedForReset || this.host.isTerminating()) {
        return Promise.resolve({ ok: false, errorCode: 'SessionTerminating', error: 'RTT coordinator stopped before startRtt' });
      }
      if (this.ownerStarted) {
        return Promise.resolve({ ok: true, data: { controlBlockAddress } });
      }
      return this.host.startRtt(controlBlockAddress, options).then(res => {
        if (res.ok) {
          this.ownerStarted = true;
          this.host.onTimerStateChanged?.();
        }
        return res;
      });
    });
  }

  private requestOwnerStop(): Promise<OzoneCommandResult> {
    return this.enqueueOwnerTransition<OzoneCommandResult>(() => {
      if (!this.ownerStarted) {
        return Promise.resolve({ ok: true, data: {} });
      }
      this.ownerStarted = false;
      this.host.onTimerStateChanged?.();
      return this.host.stopRtt();
    });
  }

  // --- internals -----------------------------------------------------------

  private channelStatus(channel: ChannelReaderState): RttChannelStatus {
    return {
      bufferIndex: channel.bufferIndex,
      ...(channel.channelName !== undefined ? { channelName: channel.channelName } : {}),
      refCount: channel.consumers.size,
      consumers: [...channel.consumers.values()].map(c => ({
        consumerId: c.consumerId,
        deliveryKind: c.deliveryKind,
        deliveryMode: c.deliveryMode,
        paused: c.paused,
        backpressured: c.backpressured,
        queuedBytes: c.queuedBytes,
        queuedBatches: c.queue.length,
        hostDroppedBytes: c.hostDroppedBytes,
        hostDroppedBatches: c.hostDroppedBatches,
        conflictPolicy: c.conflictPolicy,
        backpressurePolicy: c.backpressurePolicy,
      })),
      polling: channel.timer !== null,
      inFlight: channel.inFlight,
      pausedReason: channel.pausedReason,
      congested: channel.congested,
      batchSequence: channel.batchSequence,
      readCount: channel.readCount,
      totalBytesRead: channel.totalBytesRead,
      targetOverruns: channel.targetOverruns,
      transportDroppedBytes: channel.transportDroppedBytes,
      hostDroppedBytes: channel.hostDroppedBytes,
      ...(channel.lastRdOff !== undefined ? { lastRdOff: channel.lastRdOff } : {}),
      ...(channel.lastWrOff !== undefined ? { lastWrOff: channel.lastWrOff } : {}),
      ...(channel.bufferSize !== undefined ? { bufferSize: channel.bufferSize } : {}),
      ...(channel.lastErrorCode !== undefined ? { lastErrorCode: channel.lastErrorCode } : {}),
      ...(channel.lastErrorMessage !== undefined ? { lastErrorMessage: channel.lastErrorMessage } : {}),
    };
  }

  private effectiveIntervalMs(channel: ChannelReaderState): number {
    let min = 5000;
    for (const c of channel.consumers.values()) {
      if (c.pollIntervalMs < min) min = c.pollIntervalMs;
    }
    return Math.max(1, min);
  }

  private effectiveBatchBytes(channel: ChannelReaderState): number {
    const budget = this.getBudget(channel.bufferIndex, this.memoryBacked);
    let maxBytes = 0;
    for (const c of channel.consumers.values()) {
      if (c.maxBatchBytes > maxBytes) maxBytes = c.maxBatchBytes;
    }
    return Math.min(maxBytes > 0 ? maxBytes : budget.maxBatchBytes, budget.maxBatchBytes);
  }

  private shouldPauseForXr(channel: ChannelReaderState): boolean {
    if (!this.host.isXrSamplingActive()) return false;
    for (const c of channel.consumers.values()) {
      if (c.deliveryKind === 'binary' && c.conflictPolicy === 'best-effort') return false;
    }
    return true;
  }

  private evaluateBackpressurePause(channel: ChannelReaderState): boolean {
    if (channel.consumers.size === 0) return false;
    let allPausedOrBackpressured = true;
    for (const c of channel.consumers.values()) {
      if (!c.paused && !(c.backpressurePolicy === 'pause-reader' && c.backpressured)) {
        allPausedOrBackpressured = false;
        break;
      }
    }
    if (allPausedOrBackpressured) {
      channel.pausedReason = 'backpressure';
      channel.congested = true;
      return true;
    }
    if (channel.pausedReason === 'backpressure') {
      channel.pausedReason = 'none';
    }
    return false;
  }

  private ensureChannelTimerScheduled(channel: ChannelReaderState): void {
    if (this.disposed || this.suspendedForReset || !this.rttAvailable || channel.consumers.size === 0) return;
    if (channel.timer !== null || channel.inFlight) return;
    const interval = this.effectiveIntervalMs(channel);
    const generation = channel.generation;
    const coordinatorGen = this.coordinatorGeneration;
    channel.timer = setTimeout(() => {
      channel.timer = null;
      this.host.onTimerStateChanged?.();
      if (this.disposed || this.suspendedForReset || generation !== channel.generation || coordinatorGen !== this.coordinatorGeneration) {
        return;
      }
      this.enqueueChannelTurn(channel.bufferIndex);
    }, interval);
    this.host.onTimerStateChanged?.();
  }

  private enqueueChannelTurn(bufferIndex: number): void {
    if (!this.channelQueue.includes(bufferIndex)) {
      this.channelQueue.push(bufferIndex);
    }
    void this.pumpChannelQueue();
  }

  private async pumpChannelQueue(): Promise<void> {
    if (this.gateDrainActive || this.disposed) return;
    this.gateDrainActive = true;
    try {
      while (this.channelQueue.length > 0 && !this.disposed && !this.suspendedForReset) {
        // Round-robin pick the next channel after lastServedChannel
        this.channelQueue.sort((a, b) => a - b);
        let idx = this.channelQueue.findIndex(ch => ch > this.lastServedChannel);
        if (idx < 0) idx = 0;
        const [bufferIndex] = this.channelQueue.splice(idx, 1);
        this.lastServedChannel = bufferIndex;

        const channel = this.channels.get(bufferIndex);
        if (!channel || channel.consumers.size === 0) continue;

        const task = this.runSingleChannelCycle(channel);
        channel.inFlightPromise = task;
        await task;
        if (channel.inFlightPromise === task) channel.inFlightPromise = null;
      }
    } finally {
      this.gateDrainActive = false;
    }
  }

  private async runSingleChannelCycle(channel: ChannelReaderState): Promise<void> {
    if (this.disposed || this.suspendedForReset || !this.rttAvailable || channel.consumers.size === 0) return;

    if (this.evaluateBackpressurePause(channel)) {
      this.notifyChannelState(channel);
      return;
    }

    if (this.shouldPauseForXr(channel)) {
      channel.pausedReason = 'xr-timeline-active';
      this.notifyChannelState(channel);
      return;
    }
    if (channel.pausedReason === 'xr-timeline-active') {
      channel.pausedReason = 'none';
    }

    if (this.host.isControlInProgress() || this.host.isTerminating() || !this.host.isTargetAvailable()) {
      if (this.host.isControlInProgress()) channel.pausedReason = 'control';
      return;
    }
    if (channel.pausedReason === 'control') {
      channel.pausedReason = 'none';
    }

    const generation = channel.generation;
    const coordinatorGen = this.coordinatorGeneration;
    const identityBefore = this.host.identity();
    const abortController = new AbortController();
    channel.abortController = abortController;
    this.activeReadAbortController = abortController;
    channel.inFlight = true;
    this.host.onTimerStateChanged?.();

    let gateAcquired = false;
    try {
      const interval = this.effectiveIntervalMs(channel);
      const acquiredOrPromise = this.host.acquireReadGate('background', Math.max(50, Math.min(500, interval)), abortController.signal);
      gateAcquired = typeof acquiredOrPromise === 'boolean' ? acquiredOrPromise : await acquiredOrPromise;
      if (!gateAcquired) {
        if (this.host.isControlInProgress()) {
          channel.pausedReason = 'control';
        }
        return;
      }

      if (this.disposed || this.suspendedForReset || abortController.signal.aborted
        || generation !== channel.generation || coordinatorGen !== this.coordinatorGeneration
        || this.host.isControlInProgress() || this.host.isTerminating()) {
        return;
      }

      if (!this.ownerStarted || this.ownerTransitionPending > 0) {
        if (this.controlBlockAddress === undefined) {
          const resolved = await this.host.ensureControlBlockAddress();
          if (!resolved.ok) {
            this.handleTransportFailure(channel, 'startRtt', {
              ok: false,
              errorCode: resolved.errorCode,
              error: resolved.message,
              diagnostics: resolved.diagnostics,
            });
            return;
          }
          this.controlBlockAddress = resolved.address;
        }
        const startResult = await this.requestOwnerStart(this.controlBlockAddress, {
          ...(this.customRamRanges ? { ramRanges: this.customRamRanges } : {}),
          ...(this.memoryBacked ? { memoryBacked: true } : {}),
        });
        if (this.disposed || this.suspendedForReset || abortController.signal.aborted
          || generation !== channel.generation || coordinatorGen !== this.coordinatorGeneration
          || this.host.isTerminating()) {
          return;
        }
        if (!startResult.ok) {
          const allowTransientRetry = [...channel.consumers.values()].some(c => c.retryInvalidControlBlock);
          if (allowTransientRetry && startResult.errorCode === 'RttInvalidControlBlock') {
            if (!channel.transientStartLogged) {
              channel.transientStartLogged = true;
              this.host.onStartTransientRetry?.(
                startResult.errorCode,
                startResult.error,
                this.effectiveIntervalMs(channel),
                startResult.diagnostics,
              );
            }
            this.ownerStarted = false;
            return;
          }
          this.handleTransportFailure(channel, 'startRtt', startResult);
          this.ownerStarted = false;
          return;
        }
        channel.transientStartLogged = false;
        log.dap('[rtt] startRtt ok');
      }

      if (this.disposed || this.suspendedForReset || abortController.signal.aborted
        || generation !== channel.generation || coordinatorGen !== this.coordinatorGeneration
        || this.host.isControlInProgress() || this.host.isTerminating()) {
        return;
      }

      if (this.shouldPauseForXr(channel)) {
        channel.pausedReason = 'xr-timeline-active';
        return;
      }

      const batchSize = this.effectiveBatchBytes(channel);
      const readResult = await this.host.readRtt(channel.bufferIndex, batchSize, abortController.signal);
      const identityAfter = this.host.identity();

      // Drop stale or late completions after stop, reset, session/boot change, or disposal.
      // Normal control (halt/continue/step/write) pauses subsequent reads but MUST NOT discard
      // an already-dispatched read whose RdOff already committed on target.
      if (this.disposed || this.suspendedForReset || abortController.signal.aborted
        || generation !== channel.generation || coordinatorGen !== this.coordinatorGeneration
        || identityAfter.sessionGeneration !== identityBefore.sessionGeneration
        || identityAfter.bootGeneration !== identityBefore.bootGeneration
        || this.host.isTerminating()) {
        return;
      }

      this.handleReadResult(channel, readResult, batchSize, false);
    } catch (error) {
      if (abortController.signal.aborted || this.disposed || generation !== channel.generation
        || coordinatorGen !== this.coordinatorGeneration) {
        return;
      }
      const errorCode = typeof (error as { errorCode?: unknown })?.errorCode === 'string'
        ? (error as { errorCode: string }).errorCode
        : 'RttPollingException';
      const message = error instanceof Error ? error.message : String(error);
      this.handleTransportFailure(channel, 'polling', {
        ok: false,
        errorCode,
        error: message,
        diagnostics: (error as { diagnostics?: Record<string, unknown> })?.diagnostics,
      });
    } finally {
      if (channel.abortController === abortController) channel.abortController = null;
      if (this.activeReadAbortController === abortController) this.activeReadAbortController = null;
      channel.inFlight = false;
      if (gateAcquired) this.host.releaseReadGate();
      if (!this.disposed && !this.suspendedForReset && this.rttAvailable
        && channel.consumers.size > 0
        && channel.pausedReason === 'none') {
        this.ensureChannelTimerScheduled(channel);
      }
      this.host.onTimerStateChanged?.();
    }
  }

  private handleReadResult(
    channel: ChannelReaderState,
    readResult: OzoneCommandResult,
    requestedBatchSize: number,
    isFinal: boolean,
  ): RttChannelBatch | undefined {
    if (!readResult.ok) {
      this.handleTransportFailure(channel, 'readRtt', readResult);
      if (!isOwnerLossErrorCode(readResult.errorCode) && !isRttUnavailableErrorCode(readResult.errorCode)) {
        // Keep ownerStarted false only if RTT stopped/error requires re-start, mirroring existing behavior.
        if (readResult.errorCode === 'RttStopped' || readResult.errorCode === 'RttBufferOverrun') {
          this.ownerStarted = false;
        }
      }
      return undefined;
    }

    const payload = (readResult.data ?? {}) as Partial<CmsisDapRttReadResult> & {
      bytes?: Uint8Array | number[];
    };
    const rawBytes = payload.bytes instanceof Uint8Array
      ? payload.bytes
      : Array.isArray(payload.bytes)
        ? Uint8Array.from(payload.bytes)
        : new Uint8Array(0);

    channel.readCount++;
    if (typeof payload.rdOff === 'number') channel.lastRdOff = payload.rdOff;
    if (typeof payload.wrOff === 'number') channel.lastWrOff = payload.wrOff;
    if (typeof payload.committedRdOff === 'number') channel.lastRdOff = payload.committedRdOff;
    if (typeof payload.bufferSize === 'number') channel.bufferSize = payload.bufferSize;

    const diagDropTotal = typeof (readResult.diagnostics as { cacheDroppedBytes?: unknown } | undefined)?.cacheDroppedBytes === 'number'
      ? Number((readResult.diagnostics as { cacheDroppedBytes: number }).cacheDroppedBytes)
      : undefined;
    if (diagDropTotal !== undefined && diagDropTotal > channel.lastTransportDropTotal) {
      const delta = diagDropTotal - channel.lastTransportDropTotal;
      channel.lastTransportDropTotal = diagDropTotal;
      channel.transportDroppedBytes += delta;
      channel.congested = true;
      for (const consumer of channel.consumers.values()) {
        consumer.onDrop?.({
          bufferIndex: channel.bufferIndex,
          consumerId: consumer.consumerId,
          reason: 'transport-drop',
          droppedBytes: delta,
          droppedBatches: 0,
          totalHostDroppedBytes: consumer.hostDroppedBytes,
          totalTargetOverruns: channel.targetOverruns,
        });
      }
    }

    const overrun = payload.overrun === true;
    const writerAdvanced = payload.writerAdvanced === true;
    const backlogLikely = rawBytes.length >= requestedBatchSize || writerAdvanced;
    if (overrun) {
      channel.targetOverruns++;
      channel.congested = true;
    } else if (backlogLikely) {
      channel.congested = true;
    } else {
      const anyBackpressured = [...channel.consumers.values()].some(c => c.backpressured || c.paused);
      channel.congested = anyBackpressured || this.host.isXrSamplingActive();
    }

    log.dap('[rtt] readRtt ok bytes=' + rawBytes.length);

    if (rawBytes.length === 0 && !isFinal) {
      return undefined;
    }

    channel.batchSequence++;
    channel.totalBytesRead += rawBytes.length;

    const identity = this.host.identity();
    const nowMs = this.host.nowMs ? this.host.nowMs() : Date.now();
    const baseBatch: RttChannelBatch = {
      sessionId: identity.sessionId,
      sessionGeneration: identity.sessionGeneration,
      bootGeneration: identity.bootGeneration,
      bufferIndex: channel.bufferIndex,
      ...(channel.channelName !== undefined ? { channelName: channel.channelName } : {}),
      batchSequence: channel.batchSequence,
      bytes: rawBytes,
      ...(typeof payload.rdOff === 'number' ? { rdOff: payload.rdOff } : {}),
      ...(typeof payload.wrOff === 'number' ? { wrOff: payload.wrOff } : {}),
      ...(typeof payload.committedRdOff === 'number' ? { committedRdOff: payload.committedRdOff } : {}),
      ...(typeof payload.bufferSize === 'number' ? { bufferSize: payload.bufferSize } : {}),
      ...(typeof payload.wrapped === 'boolean' ? { wrapped: payload.wrapped } : {}),
      ...(typeof payload.overrun === 'boolean' ? { overrun: payload.overrun } : {}),
      ...(typeof payload.writerAdvanced === 'boolean' ? { writerAdvanced: payload.writerAdvanced } : {}),
      congested: channel.congested,
      backlogLikely,
      isFinal,
      timestampMs: nowMs,
    };

    this.deliverBatchToConsumers(channel, baseBatch);
    return baseBatch;
  }

  private flushCallbackQueue(channel: ChannelReaderState, consumer: ConsumerState): boolean {
    if (consumer.deliveryMode !== 'callback') return true;
    while (
      consumer.queue.length > 0
      && !consumer.paused
      && !consumer.backpressured
      && channel.consumers.has(consumer.consumerId)
    ) {
      const next = consumer.queue.shift()!;
      consumer.queuedBytes = Math.max(0, consumer.queuedBytes - next.bytes.length);
      try {
        const keepFlowing = consumer.onBatch?.(next);
        if (keepFlowing === false) {
          consumer.backpressured = true;
          this.evaluateBackpressurePause(channel);
          this.notifyChannelState(channel);
          return false;
        }
      } catch (error) {
        log.dap(`[rtt] callback queue flush failed consumer=${consumer.consumerId} buffer=${channel.bufferIndex} error=${String(error)}`);
      }
    }
    return consumer.queue.length === 0 && !consumer.paused && !consumer.backpressured;
  }

  private handleCallbackUnavailableBatch(
    channel: ChannelReaderState,
    consumer: ConsumerState,
    batch: RttChannelBatch,
  ): void {
    if (consumer.backpressurePolicy === 'pause-reader') {
      this.enqueueForPullConsumer(channel, consumer, batch);
      return;
    }
    consumer.hostDroppedBytes += batch.bytes.length;
    consumer.hostDroppedBatches += 1;
    channel.hostDroppedBytes += batch.bytes.length;
    channel.congested = true;
    consumer.onDrop?.({
      bufferIndex: channel.bufferIndex,
      consumerId: consumer.consumerId,
      reason: 'host-drop',
      droppedBytes: batch.bytes.length,
      droppedBatches: 1,
      totalHostDroppedBytes: consumer.hostDroppedBytes,
      totalTargetOverruns: channel.targetOverruns,
    });
  }

  private deliverBatchToConsumers(channel: ChannelReaderState, baseBatch: RttChannelBatch): void {
    const consumerList = [...channel.consumers.values()];
    const multi = consumerList.length > 1;
    for (const consumer of consumerList) {
      const batch: RttChannelBatch = multi
        ? { ...baseBatch, bytes: Uint8Array.from(baseBatch.bytes) }
        : baseBatch;

      if (consumer.deliveryMode === 'pull') {
        this.enqueueForPullConsumer(channel, consumer, batch);
        continue;
      }

      if (consumer.paused || consumer.backpressured) {
        this.handleCallbackUnavailableBatch(channel, consumer, batch);
        continue;
      }

      if (consumer.queue.length > 0 && !this.flushCallbackQueue(channel, consumer)) {
        this.handleCallbackUnavailableBatch(channel, consumer, batch);
        continue;
      }

      try {
        const keepFlowing = consumer.onBatch?.(batch);
        if (keepFlowing === false) {
          consumer.backpressured = true;
          this.evaluateBackpressurePause(channel);
          this.notifyChannelState(channel);
        }
      } catch (error) {
        log.dap(`[rtt] consumer delivery failed consumer=${consumer.consumerId} buffer=${channel.bufferIndex} error=${String(error)}`);
      }
    }
  }

  private enqueueForPullConsumer(channel: ChannelReaderState, consumer: ConsumerState, batch: RttChannelBatch): void {
    const wouldExceedBytes = consumer.queuedBytes + batch.bytes.length > consumer.maxQueueBytes;
    const wouldExceedBatches = consumer.queue.length >= consumer.maxQueueBatches;

    if (!wouldExceedBytes && !wouldExceedBatches) {
      consumer.queue.push(batch);
      consumer.queuedBytes += batch.bytes.length;
      return;
    }

    if (consumer.backpressurePolicy === 'drop-newest') {
      consumer.hostDroppedBytes += batch.bytes.length;
      consumer.hostDroppedBatches += 1;
      channel.hostDroppedBytes += batch.bytes.length;
      channel.congested = true;
      consumer.onDrop?.({
        bufferIndex: channel.bufferIndex,
        consumerId: consumer.consumerId,
        reason: 'host-drop',
        droppedBytes: batch.bytes.length,
        droppedBatches: 1,
        totalHostDroppedBytes: consumer.hostDroppedBytes,
        totalTargetOverruns: channel.targetOverruns,
      });
      return;
    }

    if (consumer.backpressurePolicy === 'drop-oldest') {
      let droppedBytes = 0;
      let droppedBatches = 0;
      while (consumer.queue.length > 0 && (
        consumer.queuedBytes + batch.bytes.length > consumer.maxQueueBytes
        || consumer.queue.length >= consumer.maxQueueBatches
      )) {
        const evicted = consumer.queue.shift()!;
        consumer.queuedBytes = Math.max(0, consumer.queuedBytes - evicted.bytes.length);
        droppedBytes += evicted.bytes.length;
        droppedBatches += 1;
      }
      if (droppedBatches > 0) {
        consumer.hostDroppedBytes += droppedBytes;
        consumer.hostDroppedBatches += droppedBatches;
        channel.hostDroppedBytes += droppedBytes;
        channel.congested = true;
        consumer.onDrop?.({
          bufferIndex: channel.bufferIndex,
          consumerId: consumer.consumerId,
          reason: 'host-drop',
          droppedBytes,
          droppedBatches,
          totalHostDroppedBytes: consumer.hostDroppedBytes,
          totalTargetOverruns: channel.targetOverruns,
        });
      }
      if (batch.bytes.length <= consumer.maxQueueBytes) {
        consumer.queue.push(batch);
        consumer.queuedBytes += batch.bytes.length;
      } else {
        consumer.hostDroppedBytes += batch.bytes.length;
        consumer.hostDroppedBatches += 1;
        channel.hostDroppedBytes += batch.bytes.length;
      }
      return;
    }

    // 'pause-reader': accept this already-committed batch (never silently drop
    // bytes whose RdOff already advanced) and pause further target reads until drained.
    consumer.queue.push(batch);
    consumer.queuedBytes += batch.bytes.length;
    consumer.backpressured = true;
    channel.congested = true;
    this.evaluateBackpressurePause(channel);
    this.notifyChannelState(channel);
  }

  private async drainChannelLastBatch(
    channel: ChannelReaderState,
    consumerId: string,
    timeoutMs: number,
  ): Promise<RttChannelBatch | undefined> {
    if (channel.timer) {
      clearTimeout(channel.timer);
      channel.timer = null;
      this.host.onTimerStateChanged?.();
    }
    if (channel.inFlightPromise) {
      await Promise.race([
        channel.inFlightPromise,
        new Promise<void>(resolve => setTimeout(resolve, Math.min(timeoutMs, 1000))),
      ]);
    }
    if (this.disposed || this.suspendedForReset || this.host.isTerminating()
      || this.host.isControlInProgress() || !this.host.isTargetAvailable() || !this.ownerStarted) {
      return undefined;
    }
    const consumer = channel.consumers.get(consumerId);
    if (!consumer || consumer.paused || consumer.backpressured) return undefined;

    const generation = channel.generation;
    const identityBefore = this.host.identity();
    const abort = new AbortController();
    const gateAcquired = await this.host.acquireReadGate('background', Math.min(timeoutMs, 500), abort.signal);
    if (!gateAcquired) return undefined;

    try {
      if (this.disposed || this.host.isTerminating() || generation !== channel.generation || this.host.isControlInProgress()) {
        return undefined;
      }
      const batchSize = this.effectiveBatchBytes(channel);
      const readResult = await this.host.readRtt(channel.bufferIndex, batchSize, abort.signal);
      const identityAfter = this.host.identity();
      if (this.disposed || this.host.isTerminating() || generation !== channel.generation
        || identityAfter.sessionGeneration !== identityBefore.sessionGeneration
        || identityAfter.bootGeneration !== identityBefore.bootGeneration) {
        return undefined;
      }
      return this.handleReadResult(channel, readResult, batchSize, true);
    } finally {
      this.host.releaseReadGate();
    }
  }

  private handleTransportFailure(
    channel: ChannelReaderState,
    operation: string,
    result: Extract<OzoneCommandResult, { ok: false }>,
  ): void {
    channel.lastErrorCode = result.errorCode || 'RttFailure';
    channel.lastErrorMessage = result.error;

    if (result.errorCode === 'RttBufferOverrun') {
      channel.targetOverruns++;
      channel.congested = true;
      for (const consumer of channel.consumers.values()) {
        consumer.onDrop?.({
          bufferIndex: channel.bufferIndex,
          consumerId: consumer.consumerId,
          reason: 'target-overflow',
          droppedBytes: 0,
          droppedBatches: 0,
          totalHostDroppedBytes: consumer.hostDroppedBytes,
          totalTargetOverruns: channel.targetOverruns,
        });
      }
    }

    const diagnostics = result.diagnostics ? ' diagnostics=' + JSON.stringify(result.diagnostics) : '';
    log.dap(
      '[rtt] ' + operation
      + ' failed errorCode=' + (result.errorCode || 'Unknown')
      + ' error=' + result.error
      + diagnostics,
    );

    for (const consumer of channel.consumers.values()) {
      consumer.onError?.({
        errorCode: result.errorCode || 'RttFailure',
        message: result.error,
        diagnostics: result.diagnostics,
      });
    }

    if (isOwnerLossErrorCode(result.errorCode)) {
      this.ownerStarted = false;
      this.host.onOwnerLost(result.errorCode || 'RttOwnerLost');
      return;
    }

    if (isRttUnavailableErrorCode(result.errorCode)) {
      this.rttAvailable = false;
      this.ownerStarted = false;
      this.host.onRttUnavailable(result.errorCode || 'RttUnavailable', result.error, result.diagnostics);
    }
  }

  private notifyChannelState(channel: ChannelReaderState): void {
    const status = this.channelStatus(channel);
    for (const consumer of channel.consumers.values()) {
      consumer.onStateChange?.(status);
    }
  }

  private stopChannelReader(channel: ChannelReaderState, _notify: boolean): void {
    channel.generation++;
    if (channel.timer) {
      clearTimeout(channel.timer);
      channel.timer = null;
    }
    if (channel.abortController && !channel.abortController.signal.aborted) {
      channel.abortController.abort('RTT channel stopped');
    }
    channel.abortController = null;
    channel.inFlight = false;
    this.host.onTimerStateChanged?.();
  }
}
