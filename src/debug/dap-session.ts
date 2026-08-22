import { EventEmitter } from 'events';
import * as fs from 'fs';
import { BoundedMetric } from '../utils/bounded-metric';
import { StringDecoder } from 'string_decoder';
import { OzoneBackend } from '../ozone-backend/commander';
import {
  DataPoint, FastDataSamplePlanItem, FastDataSampleSpec, MemoryBlock,
  OzoneCommandResult, StackFrame, TargetState, Variable, WatchValue,
} from '../ozone-backend/types';
import { parseElf32LoadSegments } from '../ozone-backend/cmsis-dap-flasher';
import { PRtLogDecoder } from './p-rtlog-decoder';
import { configureLogger, log } from '../utils/logger';
import { stripHanCharacters } from '../utils/watch-expression-validation';
import { normalizeDapLaunchConfig } from './dap-launch-config';
import { parseConstantExpression } from '../utils/constant-expression';
import {
  AUTOMATION_CONTROL_COMMAND,
  AUTOMATION_CONTROL_EVENT,
  AutomationControlRequest,
  AutomationControlResult,
  AutomationFlashReport,
  parseAutomationControlRequest,
  standardCommandForAction,
  AUTOMATION_BREAKPOINTS_COMMAND,
  AutomationBreakpointSnapshot,
  AUTOMATION_RUNTIME_COMMAND,
  AutomationRuntimeRequest,
  AutomationRuntimeResult,
  AutomationStackFrame,
  AutomationRegister,
  AutomationVariable,
  parseAutomationRuntimeRequest,
  AUTOMATION_EXPRESSION_COMMAND,
  AutomationExpressionRequest,
  AutomationExpressionResult,
  AutomationExpressionValue,
  AutomationExpressionWriteOutcome,
  AutomationSymbol,
  parseAutomationExpressionRequest,
  AUTOMATION_MEMORY_COMMAND,
  AutomationMemoryRequest,
  AutomationMemoryResult,
  parseAutomationMemoryRequest,
  AUTOMATION_LIFECYCLE_EVENT,
  AUTOMATION_RTT_COMMAND,
  AutomationRttRequest,
  AutomationRttResult,
  AutomationRttSnapshot,
  parseAutomationRttRequest,
  AUTOMATION_DIAGNOSTICS_COMMAND,
  AutomationDiagnosticsRequest,
  AutomationDiagnosticsResult,
  parseAutomationDiagnosticsRequest,
  normalizeSchedulerSnapshot,
  AUTOMATION_RTT_LOG_COMMAND,
  AutomationRttLogEntry,
  AutomationRttLogRequest,
  AutomationRttLogResult,
  parseAutomationRttLogRequest,
} from './dap-automation-protocol';

/** Bound on the decoded RTT Log line ring exposed through `orbit.rttlog.read`. */
const MAX_RTT_LOG_LINES = 2000;

export interface DebugProtocolMessage {
  type: 'request' | 'response' | 'event';
  seq: number;
  command?: string;
  arguments?: any;
  success?: boolean;
  body?: any;
  message?: string;
  event?: string;
  request_seq?: number;
}

interface DapSamplingEntry {
  expression: string;
  color: string;
}

type TargetReadPriority = 'foreground' | 'watch' | 'timeline' | 'background';
type TargetReadRequestPriority = TargetReadPriority | 'low';

const targetReadPriorityRank: Record<TargetReadPriority, number> = {
  foreground: 0,
  watch: 1,
  timeline: 2,
  background: 3,
};

function normalizeTargetReadPriority(priority: TargetReadRequestPriority): TargetReadPriority {
  return priority === 'low' ? 'background' : priority;
}

/** Parses a leading `ErrorCode: ...` prefix from a DAP failure message. */
function extractErrorCodePrefix(message: string): string | null {
  const match = /^([A-Za-z][A-Za-z0-9]*):/.exec(String(message ?? '').trim());
  return match ? match[1] : null;
}

interface TargetReadWaiter {
  priority: TargetReadPriority;
  queuedAtMs: number;
  generation: number;
  resolve: (acquired: boolean) => void;
  timer: NodeJS.Timeout | null;
  signal?: AbortSignal;
  abortListener?: () => void;
  settled: boolean;
}

interface TargetReadDrainWaiter {
  resolve: (drained: boolean) => void;
  timer: NodeJS.Timeout | null;
  signal?: AbortSignal;
  abortListener?: () => void;
  settled: boolean;
}

interface TargetReadMetricSet {
  queueWaitMs: BoundedMetric;
  gateHoldMs: BoundedMetric;
  handoffGapMs: BoundedMetric;
}

interface RtosVariableExpansion {
  rootExpression: string;
  expandedExpressions: string[];
  targetEvaluateName: string;
}

interface DapVariableHandle {
  children?: WatchValue[];
  rtosExpansion?: RtosVariableExpansion;
  stopGeneration: number;
}

/**
 * In-flight automation control capture. The synthetic standard request runs
 * through the same handlers as UI control; `sendResponse` records the first
 * response the handler produces instead of emitting it, and the automation
 * entry point translates it into the structured outcome.
 */
interface AutomationCapture {
  synthetic: DebugProtocolMessage;
  recorded: boolean;
  body?: any;
  success: boolean;
  message?: string;
}

function createTargetReadMetricSet(): TargetReadMetricSet {
  return {
    queueWaitMs: new BoundedMetric(8_192),
    gateHoldMs: new BoundedMetric(8_192),
    handoffGapMs: new BoundedMetric(8_192),
  };
}

export class DapSession extends EventEmitter {
  private backend: OzoneBackend;
  private seq = 1;
  private stopGeneration = 0;
  private pollTimer: NodeJS.Timeout | null = null;
  private connectionMonitorTimer: NodeJS.Timeout | null = null;
  private rttPollTimer: NodeJS.Timeout | null = null;
  private rttPollGeneration = 0;
  private rttPollAbortController: AbortController | null = null;
  private rttLogEnabled = true;
  private rttAvailable = true;
  private rttStarted = false;
  private rttBufferIndex = 0;
  private rttPollIntervalMs = 50;
  private rttReadSize = 4096;
  private rttControlBlockAddress: number | undefined;
  private rttControlBlockSource: 'elf-symbol' | 'config' = 'elf-symbol';
  private dapStepProfileSeq = 0;
  private rttStripAnsi = true;
  // Automation RTT is a distinct logical consumer from the UI RTT Log (plan
  // Task 11). It shares the physical owner but tracks its own start/read state
  // so an API `start`/`stop`/`read` never races the terminal polling loop.
  private automationRttStarted = false;
  private automationRttBufferIndex = 0;
  private automationRttPollIntervalMs = 50;
  private automationRttAnsi = true;
  private automationRttTargetName: string | undefined;
  // Decoded terminal-log line ring (plan Task 11 extension, `orbit.rttlog.read`).
  // Each finalized RTT Log line is retained here with its producing decoder kind
  // so the API can distinguish P-RTLog-decoded logs from raw RTT text.
  private rttLogEntries: AutomationRttLogEntry[] = [];
  private rttLogSequence = 0;
  private _rtos = '';
  private rttLogTarget: 'terminal' | 'debugConsole' | 'both' = 'terminal';
  private rttDecoder = new StringDecoder('utf8');
  private rttControlCarry = '';
  private rttLineCarry = '';
  private pRtLogEnabled = false;
  private pRtLogRoot = '';
  private pRtLogDecoder = new PRtLogDecoder();
  private watchExpressions: string[] = [];
  private _watchPollCycle = 0;
  private lastHaltReason: 'entry' | 'breakpoint' | 'step' | 'pause' = 'entry';
  private targetRunning = false;
  private timelineClockPausedAtMs: number | null = null;
  private timelineClockPausedTotalMs = 0;
  private controlInProgress = false;
  private readCancelEpoch = 0;
  private targetReadInProgress = false;
  private lowPriorityReadBlockedUntil = 0;
  private pendingForegroundTargetReads = 0;
  private pendingWatchTargetReads = 0;
  private targetReadWaiters: TargetReadWaiter[] = [];
  private targetReadDrainWaiters: TargetReadDrainWaiter[] = [];
  private targetReadWaiterTimerCount = 0;
  private targetReadDrainWaiterTimerCount = 0;
  private lowPriorityReadBlockTimer: NodeJS.Timeout | null = null;
  private targetReadAcquiredAtMs: number | null = null;
  private targetReadActivePriority: TargetReadPriority | null = null;
  private readonly targetReadQueueWaitMetric = new BoundedMetric();
  private readonly targetReadHoldMetric = new BoundedMetric();
  private readonly targetReadHandoffGapMetric = new BoundedMetric();
  private readonly targetReadPriorityMetrics: Record<TargetReadPriority, TargetReadMetricSet> = {
    foreground: createTargetReadMetricSet(),
    watch: createTargetReadMetricSet(),
    timeline: createTargetReadMetricSet(),
    background: createTargetReadMetricSet(),
  };
  private readonly targetReadAcquisitions: Record<TargetReadPriority, number> = {
    foreground: 0,
    watch: 0,
    timeline: 0,
    background: 0,
  };
  private activeStoppedReadAbortController: AbortController | null = null;
  private activeEvaluateAbortController: AbortController | null = null;
  private activeRtosInfoAbortController: AbortController | null = null;
  private activeRtosVariablesAbortController: AbortController | null = null;
  private activeMemoryReadAbortController: AbortController | null = null;

  private breakpoints = new Map<string, number>();
  /** Resolved instruction address per `${path}:${line}` key, for the automation snapshot. */
  private breakpointAddresses = new Map<string, number>();
  private stepLock: Promise<void> = Promise.resolve();
  private automationCapture: AutomationCapture | null = null;

  private _elfPath = '';
  private _device = '';
  private _interface = 'SWD';
  private _speedKHz = 4000;
  private _probe: 'jlink' | 'cmsis-dap' = 'jlink';
  private _flashEnabled = true;
  private _runToEntryPoint: string | false = false;
  private _cmsisDapFlashAlgorithmPath = '';
  private dataSamplingActive = false;
  private dataSamplingTimer: NodeJS.Immediate | null = null;
  private dataSamplingSendTimer: NodeJS.Timeout | null = null;
  private dataSamplingEntries: DapSamplingEntry[] = [];
  private dataSamplingSpecs: FastDataSampleSpec[] = [];
  private dataSamplingPending = new Map<string, DataPoint[]>();
  private dataSamplingLastDisplay = new Map<string, string>();
  private dataSamplingLastTimestamp = new Map<string, number>();
  private dataSamplingSeenExpressions = new Set<string>();
  private dataSamplingIntervalMs = 0.2;
  private dataSamplingSendIntervalMs = 16;
  private dataSamplingNextSampleMs = 0;
  private readonly highResEpochMs = Date.now();
  private readonly highResStartNs = process.hrtime.bigint();
  private variableHandles = new Map<number, DapVariableHandle | WatchValue[]>();
  private nextVariableHandle = 1000;
  private runtimeWatchReadInFlight = false;
  private runtimeWatchCache = new Map<string, WatchValue>();
  private runtimeWatchCacheTime = new Map<string, number>();
  private readonly runtimeEvaluateCacheMs = 250;
  // A target read cannot be preempted once dispatched. Keep one top-level
  // Watch expression per slice so a slow expression cannot hold Timeline
  // behind a second expression in the same high-priority critical section.
  private readonly watchReadChunkSize = 1;
  private readonly watchReadBudgetMs = 8;
  private phase: 'idle' | 'flashing' | 'connecting' | 'connected' | 'terminating' | 'terminated' = 'idle';
  private targetConnectionEstablished = false;
  private connectionFailureCount = 0;
  private terminationPromise: Promise<void> | null = null;
  private disposePromise: Promise<void> | null = null;
  private flashAbortController: AbortController | null = null;

  constructor(backend: OzoneBackend) {
    super();
    this.backend = backend;
    this.timelineClockPausedAtMs = this.nowMs();
  }

  private startConnectionMonitor() {
    this.stopConnectionMonitor();
    const monitor = async () => {
      if (this.connectionMonitorTimer === null) return;
      if (this.targetConnectionEstablished && !this.targetRunning && !this.controlInProgress) {
        await this.queryTargetState('health-monitor');
      }
      if (this.connectionMonitorTimer !== null) {
        this.connectionMonitorTimer = setTimeout(monitor, 500);
      }
    };
    this.connectionMonitorTimer = setTimeout(monitor, 500);
  }

  private isSessionTerminating(): boolean {
    return this.phase === 'terminating' || this.phase === 'terminated';
  }

  private stopConnectionMonitor() {
    if (this.connectionMonitorTimer) clearTimeout(this.connectionMonitorTimer);
    this.connectionMonitorTimer = null;
  }

  private async queryTargetState(context: string): Promise<OzoneCommandResult> {
    const result = await this.backend.execute({ cmd: 'getTargetState' });
    if (!this.targetConnectionEstablished || this.phase === 'terminating' || this.phase === 'terminated') {
      return result;
    }

    const hardDisconnect = result.ok
      ? result.data === TargetState.Disconnected
      : result.errorCode === 'NativeOwnerLost'
        || result.errorCode === 'TargetOwnerUnavailable'
        || result.errorCode === 'TargetDisconnected';
    const softDisconnect = result.ok
      ? result.data === TargetState.Error
      : result.errorCode === 'JLinkCallFailed'
        || result.errorCode === 'TargetStateReadFailed';

    if (hardDisconnect) {
      log.dap(`connection-monitor state=disconnected context=${context} code=${result.ok ? 'TargetDisconnected' : result.errorCode}`);
      void this.terminateForConnectionLoss(result.ok ? 'TargetDisconnected' : result.errorCode || 'TargetDisconnected');
    } else if (softDisconnect) {
      this.connectionFailureCount++;
      log.dap(`connection-monitor state=error context=${context} consecutiveFailures=${this.connectionFailureCount}`);
      if (this.connectionFailureCount >= 3) {
        void this.terminateForConnectionLoss(result.ok ? 'TargetStateError' : result.errorCode || 'TargetStateReadFailed');
      }
    } else {
      this.connectionFailureCount = 0;
    }
    return result;
  }

  private terminateForConnectionLoss(reason: string): Promise<void> {
    if (this.terminationPromise) return this.terminationPromise;
    this.terminationPromise = (async () => {
      const started = Date.now();
      this.phase = 'terminating';
      this.targetConnectionEstablished = false;
      this.connectionFailureCount = 0;
      this.controlInProgress = true;
      this.advanceReadCancelEpoch();
      this.resetVariableHandles();
      this.cancelTargetReadGateWaiters();
      this.cancelActiveTargetReads('target connection lost');
      this.stopDataSampling();
      this.stopRttLogPolling(false);
      this.stopPolling();
      this.stopConnectionMonitor();
      this.flashAbortController?.abort('target connection lost');
      (this.backend as any).cancelFlash?.('target connection lost');
      log.dap(`session-terminate reason=${reason} phase=connected`);
      this.sendEvent('output', {
        category: 'stderr',
        output: `Target connection lost (${reason}). Ending debug session and cleaning up the selected target owner.\n`,
      });
      try {
        await this.backend.dispose(false);
      } catch (error) {
        log.dap(`session-cleanup error=${error instanceof Error ? error.message : String(error)}`);
      }
      this.phase = 'terminated';
      this.sendEvent('terminated', { reason });
      log.dap(`session-cleanup completed reason=${reason} elapsedMs=${Date.now() - started}`);
      this.emit('shutdownRequested');
    })();
    return this.terminationPromise;
  }

  private cleanupFailedLaunch(reason: string): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposePromise = (async () => {
      const started = Date.now();
      this.phase = 'terminating';
      this.targetConnectionEstablished = false;
      this.connectionFailureCount = 0;
      this.controlInProgress = true;
      this.advanceReadCancelEpoch();
      this.cancelTargetReadGateWaiters();
      this.cancelActiveTargetReads('launch failed');
      this.stopDataSampling();
      this.stopRttLogPolling(false);
      this.stopPolling();
      this.stopConnectionMonitor();
      this.flashAbortController?.abort('launch failed');
      this.flashAbortController = null;
      (this.backend as any).cancelFlash?.('launch failed');
      log.dap(`launch-cleanup reason=${reason} ownerDispose=forced`);
      try {
        await this.backend.dispose(false);
      } catch (error) {
        log.dap(`launch-cleanup error=${error instanceof Error ? error.message : String(error)}`);
      }
      this.backend.configureNativeSteps(false);
      this.controlInProgress = false;
      this.phase = 'idle';
      log.dap(`launch-cleanup completed reason=${reason} elapsedMs=${Date.now() - started}`);
    })();
    return this.disposePromise;
  }

  private async failLaunchAfterConnect(
    msg: DebugProtocolMessage,
    result: OzoneCommandResult,
    fallbackCode: string,
  ): Promise<void> {
    const reason = result.ok ? fallbackCode : result.errorCode || fallbackCode;
    if (!result.ok && this.isOwnerLossErrorCode(result.errorCode)) {
      this.sendCommandFailure(msg, result, fallbackCode);
      await this.terminateForConnectionLoss(reason);
      return;
    }
    await this.cleanupFailedLaunch(reason);
    this.sendCommandFailure(msg, result, fallbackCode);
  }

  private async withStepLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.stepLock;
    let resolve: () => void;
    this.stepLock = new Promise<void>(r => { resolve = r; });
    await prev;
    try {
      return await fn();
    } finally {
      resolve!();
    }
  }

  private beginControl() {
    this.controlInProgress = true;
    this.advanceReadCancelEpoch();
    this.variableHandles.clear();
    this.cancelActiveTargetReads('DAP control request started');
  }

  private advanceReadCancelEpoch() {
    this.readCancelEpoch++;
    this.cancelInvalidTargetReadWaiters();
  }

  private cancelActiveTargetReads(reason: string) {
    const stoppedController = this.activeStoppedReadAbortController;
    if (stoppedController && !stoppedController.signal.aborted) {
      log.dap(`cancel stopped target read reason=control readEpoch=${this.readCancelEpoch}`);
      stoppedController.abort(reason);
    }
    const evaluateController = this.activeEvaluateAbortController;
    if (evaluateController && !evaluateController.signal.aborted) {
      log.dap(`cancel evaluate target read reason=control readEpoch=${this.readCancelEpoch}`);
      evaluateController.abort(reason);
    }
    const rtosInfoController = this.activeRtosInfoAbortController;
    if (rtosInfoController && !rtosInfoController.signal.aborted) {
      log.dap(`cancel RTOS info target read reason=control readEpoch=${this.readCancelEpoch}`);
      rtosInfoController.abort(reason);
    }
    const rtosVariablesController = this.activeRtosVariablesAbortController;
    if (rtosVariablesController && !rtosVariablesController.signal.aborted) {
      log.dap(`cancel RTOS variables target read reason=control readEpoch=${this.readCancelEpoch}`);
      rtosVariablesController.abort(reason);
    }
    const memoryController = this.activeMemoryReadAbortController;
    if (memoryController && !memoryController.signal.aborted) {
      log.dap(`cancel memory target read reason=control readEpoch=${this.readCancelEpoch}`);
      memoryController.abort(reason);
    }
  }

  private endControl() {
    this.controlInProgress = false;
    this.dispatchTargetReadWaiters();
  }

  private shouldDeferTargetRead(): boolean {
    return this.controlInProgress || this.isSessionTerminating();
  }

  private isLowPriorityTargetRead(priority: TargetReadPriority): boolean {
    return priority === 'timeline' || priority === 'background';
  }

  private hasQueuedTargetReadAtOrAbove(priority: TargetReadPriority): boolean {
    const rank = targetReadPriorityRank[priority];
    return this.targetReadWaiters.some(waiter => !waiter.settled
      && waiter.generation === this.readCancelEpoch
      && !waiter.signal?.aborted
      && targetReadPriorityRank[waiter.priority] <= rank);
  }

  private canAcquireTargetRead(priority: TargetReadPriority, ignoreQueue = false): boolean {
    if (this.shouldDeferTargetRead() || this.targetReadInProgress) return false;
    if (this.isLowPriorityTargetRead(priority) && Date.now() < this.lowPriorityReadBlockedUntil) return false;
    if (!ignoreQueue && this.hasQueuedTargetReadAtOrAbove(priority)) return false;
    return true;
  }

  private acquireTargetRead(priority: TargetReadPriority, queuedAtMs: number, handoffReadyAtMs?: number) {
    const acquiredAtMs = this.nowMs();
    this.targetReadInProgress = true;
    this.targetReadAcquiredAtMs = acquiredAtMs;
    this.targetReadActivePriority = priority;
    this.targetReadQueueWaitMetric.record(acquiredAtMs - queuedAtMs);
    this.targetReadPriorityMetrics[priority].queueWaitMs.record(acquiredAtMs - queuedAtMs);
    if (handoffReadyAtMs !== undefined) {
      this.targetReadHandoffGapMetric.record(acquiredAtMs - handoffReadyAtMs);
      this.targetReadPriorityMetrics[priority].handoffGapMs.record(acquiredAtMs - handoffReadyAtMs);
    }
    this.targetReadAcquisitions[priority]++;
  }

  private beginTargetRead(priority: TargetReadPriority = 'timeline'): boolean {
    priority = normalizeTargetReadPriority(priority as TargetReadRequestPriority);
    this.cancelInvalidTargetReadWaiters();
    if (!this.canAcquireTargetRead(priority)) return false;
    const now = this.nowMs();
    this.acquireTargetRead(priority, now);
    return true;
  }

  private beginTargetReadWhenAvailable(
    priority: TargetReadRequestPriority = 'timeline',
    timeoutMs = 0,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const normalizedPriority = normalizeTargetReadPriority(priority);
    if (signal?.aborted || this.isSessionTerminating()) return Promise.resolve(false);
    if (this.beginTargetRead(normalizedPriority)) return Promise.resolve(true);
    if (timeoutMs <= 0 || (this.controlInProgress && normalizedPriority !== 'foreground')) return Promise.resolve(false);

    return new Promise<boolean>(resolve => {
      const waiter: TargetReadWaiter = {
        priority: normalizedPriority,
        queuedAtMs: this.nowMs(),
        generation: this.readCancelEpoch,
        resolve,
        timer: null,
        signal,
        settled: false,
      };
      if (normalizedPriority === 'foreground') this.pendingForegroundTargetReads++;
      if (normalizedPriority === 'watch') this.pendingWatchTargetReads++;
      this.targetReadWaiters.push(waiter);

      waiter.timer = setTimeout(() => {
        this.settleTargetReadWaiter(waiter, false);
        this.dispatchTargetReadWaiters();
      }, timeoutMs);
      this.targetReadWaiterTimerCount++;

      if (signal) {
        waiter.abortListener = () => {
          this.settleTargetReadWaiter(waiter, false);
          this.dispatchTargetReadWaiters();
        };
        signal.addEventListener('abort', waiter.abortListener, { once: true });
      }

      // Re-check after registration so a release immediately before enqueue
      // cannot be lost. Dispatch grants at most one waiter synchronously.
      this.dispatchTargetReadWaiters();
    });
  }

  private beginWatchTargetRead(timeoutMs = 250, signal?: AbortSignal): Promise<boolean> {
    return this.beginTargetReadWhenAvailable('watch', timeoutMs, signal);
  }

  private settleTargetReadWaiter(waiter: TargetReadWaiter, acquired: boolean) {
    if (waiter.settled) return;
    waiter.settled = true;
    const index = this.targetReadWaiters.indexOf(waiter);
    if (index >= 0) this.targetReadWaiters.splice(index, 1);
    if (waiter.timer) {
      clearTimeout(waiter.timer);
      waiter.timer = null;
      this.targetReadWaiterTimerCount--;
    }
    if (waiter.signal && waiter.abortListener) {
      waiter.signal.removeEventListener('abort', waiter.abortListener);
      waiter.abortListener = undefined;
    }
    if (waiter.priority === 'foreground') this.pendingForegroundTargetReads--;
    if (waiter.priority === 'watch') this.pendingWatchTargetReads--;
    if (!this.targetReadWaiters.some(item => this.isLowPriorityTargetRead(item.priority)) && this.lowPriorityReadBlockTimer) {
      clearTimeout(this.lowPriorityReadBlockTimer);
      this.lowPriorityReadBlockTimer = null;
    }
    waiter.resolve(acquired);
  }

  private cancelInvalidTargetReadWaiters() {
    const terminating = this.isSessionTerminating();
    for (const waiter of [...this.targetReadWaiters]) {
      if (terminating || waiter.generation !== this.readCancelEpoch || waiter.signal?.aborted) {
        this.settleTargetReadWaiter(waiter, false);
      }
    }
  }

  private scheduleLowPriorityReadUnblock() {
    if (this.lowPriorityReadBlockTimer || this.controlInProgress || this.isSessionTerminating()) return;
    const hasBlockedWaiter = this.targetReadWaiters.some(waiter => this.isLowPriorityTargetRead(waiter.priority));
    if (!hasBlockedWaiter) return;
    const delayMs = this.lowPriorityReadBlockedUntil - Date.now();
    if (delayMs <= 0) return;
    this.lowPriorityReadBlockTimer = setTimeout(() => {
      this.lowPriorityReadBlockTimer = null;
      this.dispatchTargetReadWaiters();
    }, delayMs);
  }

  private dispatchTargetReadWaiters(handoffReadyAtMs?: number) {
    this.cancelInvalidTargetReadWaiters();
    if (this.targetReadInProgress || this.controlInProgress || this.isSessionTerminating()) return;

    let next: TargetReadWaiter | undefined;
    for (const priority of ['foreground', 'watch', 'timeline', 'background'] as TargetReadPriority[]) {
      if (this.isLowPriorityTargetRead(priority) && Date.now() < this.lowPriorityReadBlockedUntil) continue;
      next = this.targetReadWaiters.find(waiter => waiter.priority === priority);
      if (next) break;
    }
    if (!next) {
      this.scheduleLowPriorityReadUnblock();
      return;
    }

    this.acquireTargetRead(next.priority, next.queuedAtMs, handoffReadyAtMs);
    this.settleTargetReadWaiter(next, true);
  }

  private endTargetRead() {
    const releasedAtMs = this.nowMs();
    if (this.targetReadAcquiredAtMs !== null) {
      this.targetReadHoldMetric.record(releasedAtMs - this.targetReadAcquiredAtMs);
      if (this.targetReadActivePriority) {
        this.targetReadPriorityMetrics[this.targetReadActivePriority].gateHoldMs.record(
          releasedAtMs - this.targetReadAcquiredAtMs,
        );
      }
    }
    this.targetReadAcquiredAtMs = null;
    this.targetReadActivePriority = null;
    this.targetReadInProgress = false;
    for (const waiter of [...this.targetReadDrainWaiters]) {
      this.settleTargetReadDrainWaiter(waiter, true);
    }
    this.dispatchTargetReadWaiters(releasedAtMs);
  }

  private waitForTargetReadDrain(timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    if (!this.targetReadInProgress) return Promise.resolve(true);
    if (this.isSessionTerminating() || signal?.aborted || timeoutMs <= 0) return Promise.resolve(false);
    return new Promise<boolean>(resolve => {
      const waiter: TargetReadDrainWaiter = { resolve, timer: null, signal, settled: false };
      this.targetReadDrainWaiters.push(waiter);
      waiter.timer = setTimeout(() => this.settleTargetReadDrainWaiter(waiter, false), timeoutMs);
      this.targetReadDrainWaiterTimerCount++;
      if (signal) {
        waiter.abortListener = () => this.settleTargetReadDrainWaiter(waiter, false);
        signal.addEventListener('abort', waiter.abortListener, { once: true });
      }
      if (!this.targetReadInProgress) this.settleTargetReadDrainWaiter(waiter, true);
    });
  }

  private settleTargetReadDrainWaiter(waiter: TargetReadDrainWaiter, drained: boolean) {
    if (waiter.settled) return;
    waiter.settled = true;
    const index = this.targetReadDrainWaiters.indexOf(waiter);
    if (index >= 0) this.targetReadDrainWaiters.splice(index, 1);
    if (waiter.timer) {
      clearTimeout(waiter.timer);
      waiter.timer = null;
      this.targetReadDrainWaiterTimerCount--;
    }
    if (waiter.signal && waiter.abortListener) {
      waiter.signal.removeEventListener('abort', waiter.abortListener);
      waiter.abortListener = undefined;
    }
    waiter.resolve(drained);
  }

  private cancelTargetReadGateWaiters() {
    for (const waiter of [...this.targetReadWaiters]) this.settleTargetReadWaiter(waiter, false);
    for (const waiter of [...this.targetReadDrainWaiters]) this.settleTargetReadDrainWaiter(waiter, false);
    if (this.lowPriorityReadBlockTimer) clearTimeout(this.lowPriorityReadBlockTimer);
    this.lowPriorityReadBlockTimer = null;
  }

  private async beginTargetControl(timeoutMs = 1200, signal?: AbortSignal): Promise<boolean> {
    if (this.isSessionTerminating() || signal?.aborted) return false;
    this.beginControl();
    const drained = await this.waitForTargetReadDrain(timeoutMs, signal);
    if (!drained && !this.isSessionTerminating()) {
      this.endControl();
    }
    return drained;
  }

  private async beginTargetWrite(timeoutMs = 1200): Promise<boolean> {
    if (!(await this.beginTargetControl(timeoutMs))) return false;
    this.targetReadInProgress = true;
    return true;
  }

  private endTargetWrite() {
    this.endTargetRead();
    this.endControl();
  }

  private snapshotTargetReadGateMetrics() {
    return {
      queueWaitMs: this.targetReadQueueWaitMetric.snapshot(),
      gateHoldMs: this.targetReadHoldMetric.snapshot(),
      handoffGapMs: this.targetReadHandoffGapMetric.snapshot(),
      byPriority: Object.fromEntries(
        (Object.keys(this.targetReadPriorityMetrics) as TargetReadPriority[]).map(priority => [priority, {
          queueWaitMs: this.targetReadPriorityMetrics[priority].queueWaitMs.snapshot(),
          gateHoldMs: this.targetReadPriorityMetrics[priority].gateHoldMs.snapshot(),
          handoffGapMs: this.targetReadPriorityMetrics[priority].handoffGapMs.snapshot(),
        }]),
      ),
      acquisitionsByPriority: { ...this.targetReadAcquisitions },
      queuedWaiters: this.targetReadWaiters.length,
      activeWaiterTimers: this.targetReadWaiterTimerCount + this.targetReadDrainWaiterTimerCount,
      controlWaiters: this.targetReadDrainWaiters.length,
      gateOwned: this.targetReadInProgress,
      activePriority: this.targetReadActivePriority,
    };
  }

  private cachedOrRunningWatchValue(expression: string): WatchValue {
    return this.runtimeWatchCache.get(expression) || this.makeRunningWatchValue(expression);
  }

  private normalizeWatchExpressions(expressions: unknown): string[] {
    return Array.isArray(expressions)
      ? expressions.map(expression => stripHanCharacters(String(expression)).trim()).filter(Boolean)
      : [];
  }

  private sendEvaluateValue(
    msg: DebugProtocolMessage,
    value: WatchValue,
    allowChildren: boolean,
    rtosExpansion?: RtosVariableExpansion,
  ) {
    this.sendResponse(msg, {
      result: value.display || value.hex || value.error || `${value.value}`,
      type: value.typeName || undefined,
      variablesReference: allowChildren ? this.allocateVariableHandle(value, rtosExpansion) : 0,
      memoryReference: this.memoryReferenceForWatch(value),
    });
  }

  private sendRtosEvaluateFailure(
    msg: DebugProtocolMessage,
    errorCode: string,
    message: string,
    startedAtMs: number,
    result?: OzoneCommandResult,
  ) {
    const dapMessage = this.isRetryableRtosReadError(errorCode) ? 'Busy' : `${errorCode}: ${message}`;
    this.sendResponse(msg, {
      result: message,
      variablesReference: 0,
      errorCode,
      targetState: result?.targetState || (this.targetRunning ? 'Running' : 'Halted'),
      elapsedMs: result?.elapsedMs ?? Math.max(0, this.nowMs() - startedAtMs),
      diagnostics: result?.diagnostics || { targetReadGate: this.snapshotTargetReadGateMetrics() },
    }, false, dapMessage);
  }

  private isRetryableRtosReadError(errorCode: string): boolean {
    return errorCode === 'TargetReadUnavailable'
      || errorCode === 'TargetReadCancelled'
      || errorCode === 'RtosReadCancelled'
      || errorCode === 'TargetRunning';
  }

  private sendRtosVariablesFailure(
    msg: DebugProtocolMessage,
    errorCode: string,
    message: string,
    startedAtMs: number,
    handle: DapVariableHandle,
    result?: OzoneCommandResult,
  ) {
    const dapMessage = this.isRetryableRtosReadError(errorCode) ? 'Busy' : `${errorCode}: ${message}`;
    const targetState = result?.targetState
      || (!this.targetConnectionEstablished || this.isSessionTerminating()
        ? 'Disconnected'
        : this.targetRunning ? 'Running' : 'Halted');
    this.sendResponse(msg, {
      variables: [],
      errorCode,
      message,
      targetState,
      elapsedMs: result?.elapsedMs ?? Math.max(0, this.nowMs() - startedAtMs),
      diagnostics: {
        ...result?.diagnostics,
        readEpoch: this.readCancelEpoch,
        stopGeneration: this.stopGeneration,
        handleStopGeneration: handle.stopGeneration,
      },
    }, false, dapMessage);
  }

  private markStoppedForUi() {
    this.setTargetRunning(false);
    this.advanceReadCancelEpoch();
    this.lowPriorityReadBlockedUntil = Date.now() + 150;
  }

  private setTargetRunning(running: boolean) {
    const now = this.nowMs();
    if (running && this.timelineClockPausedAtMs !== null) {
      this.timelineClockPausedTotalMs += Math.max(0, now - this.timelineClockPausedAtMs);
      this.timelineClockPausedAtMs = null;
    } else if (!running && this.timelineClockPausedAtMs === null) {
      this.timelineClockPausedAtMs = now;
    }
    this.targetRunning = running;
  }

  private timelineNowMs(now = this.nowMs()): number {
    const activePauseMs = this.timelineClockPausedAtMs === null
      ? 0
      : Math.max(0, now - this.timelineClockPausedAtMs);
    return now - this.timelineClockPausedTotalMs - activePauseMs;
  }

  private isRtosEvaluateExpression(expression: string): boolean {
    return expression === 'uxCurrentNumberOfTasks'
      || expression === 'pxCurrentTCB'
      || expression === 'pxCurrentTCBs'
      || expression === 'pxReadyTasksLists'
      || expression === 'ulTotalRunTime'
      || expression === 'uxTopReadyPriority'
      || expression.includes('xDelayed')
      || expression.includes('xPending')
      || expression.includes('xSuspended')
      || expression.includes('xTasksWaitingTermination')
      || expression.includes('xQueueRegistry')
      || expression.includes('xTimerQueue')
      || expression.includes('pxCurrentTCBs')
      || expression.includes('ulTotalRunTime')
      || expression.includes('TCB_t')
      || expression.includes('tskTaskControlBlock')
      || expression.includes('Queue_t')
      || expression.includes('List_t')
      || expression.includes('ListItem_t')
      || expression.includes('ulRunTimeCounter')
      || expression.includes('pcTaskName')
      || expression.includes('pxTopOfStack')
      || expression.includes('pxStack');
  }

  handleMessage(message: DebugProtocolMessage): void {
    if (message.type === 'request') {
      this.handleRequest(message);
    }
  }

  private sendResponse(msg: DebugProtocolMessage, body?: any, success = true, message?: string) {
    const capture = this.automationCapture;
    if (capture && capture.synthetic === msg) {
      // Automation requests run the same handlers; the handler's first
      // response is recorded and translated into the structured outcome
      // instead of being emitted as a raw standard DAP response.
      if (!capture.recorded) {
        capture.recorded = true;
        capture.body = body;
        capture.success = success;
        capture.message = message;
      }
      return;
    }
    const response = {
      type: 'response', seq: this.seq++,
      request_seq: msg.seq, success, command: msg.command || '', body, message,
    } as DebugProtocolMessage;
    if (msg.command === 'stackTrace') {
      const stackFrames = Array.isArray(body?.stackFrames) ? body.stackFrames : [];
      const frame0 = stackFrames[0];
      const frame0Source = frame0?.source?.path
        ? `${frame0.source.path}:${frame0.line ?? 0}`
        : 'unknown';
      log.dap(
        `[protocol] response seq=${response.seq} requestSeq=${msg.seq}`
        + ` command=stackTrace success=${success} stopGeneration=${this.stopGeneration}`
        + ` frameCount=${stackFrames.length} frame0Id=${frame0?.id ?? 'none'}`
        + ` pc=${frame0?.instructionPointerReference ?? 'unknown'} source=${frame0Source}`,
      );
    }
    this.emit('send', response);
  }

  private sendCommandFailure(
    msg: DebugProtocolMessage,
    result: OzoneCommandResult,
    fallbackCode: string,
  ) {
    if (result.ok) return;
    const errorCode = result.errorCode || fallbackCode;
    const message = result.error.includes(errorCode)
      ? result.error
      : `${errorCode}: ${result.error}`;
    this.sendResponse(msg, {
      errorCode,
      message: result.error,
      diagnostics: result.diagnostics,
      targetState: result.targetState,
      elapsedMs: result.elapsedMs,
    }, false, message);
  }

  private sendEvent(event: string, body?: any) {
    if (event === 'stopped') this.stopGeneration++;
    const message = { type: 'event', seq: this.seq++, event, body } as DebugProtocolMessage;
    if (event === 'stopped') {
      log.dap(
        `[protocol] event seq=${message.seq} event=stopped stopGeneration=${this.stopGeneration}`
        + ` reason=${body?.reason ?? 'unknown'} threadId=${body?.threadId ?? 'unknown'}`
        + ` allThreadsStopped=${body?.allThreadsStopped ?? false}`,
      );
    } else if (event === 'continued') {
      log.dap(
        `[protocol] event seq=${message.seq} event=continued stopGeneration=${this.stopGeneration}`
        + ` threadId=${body?.threadId ?? 'unknown'}`
        + ` allThreadsContinued=${body?.allThreadsContinued ?? false}`,
      );
    }
    this.emit('send', message);
    // Companion sanitized lifecycle event for the Automation API (plan Task 11):
    // only states/reasons, no memory or variable values. The Extension Host
    // resolves the exact session identity and generation before publishing.
    this.emitAutomationLifecycle(event, body);
  }

  private emitAutomationLifecycle(event: string, body?: any) {
    let type: string | undefined;
    if (event === 'stopped') type = 'target.stopped';
    else if (event === 'continued') type = 'target.running';
    else if (event === 'terminated' && typeof body?.reason === 'string') type = 'target.connectionLost';
    if (!type) return;
    const payload: Record<string, unknown> = { type };
    if (body?.reason !== undefined) payload.reason = body.reason;
    if (body?.threadId !== undefined) payload.threadId = body.threadId;
    this.sendEvent(AUTOMATION_LIFECYCLE_EVENT, payload);
  }

  private resetVariableHandles() {
    this.variableHandles.clear();
    this.nextVariableHandle = 1000;
  }

  private allocateVariableHandle(value: WatchValue, rtosExpansion?: RtosVariableExpansion): number {
    const children = value.children;
    if ((!children || children.length === 0) && !(rtosExpansion && value.hasChildren)) return 0;
    const ref = this.nextVariableHandle++;
    this.variableHandles.set(ref, {
      children,
      rtosExpansion: rtosExpansion
        ? {
          ...rtosExpansion,
          targetEvaluateName: value.evaluateName || value.expression,
        }
        : undefined,
      stopGeneration: this.stopGeneration,
    });
    return ref;
  }

  private findWatchValueByEvaluateName(value: WatchValue, evaluateName: string): WatchValue | undefined {
    if ((value.evaluateName || value.expression) === evaluateName) return value;
    for (const child of value.children || []) {
      const match = this.findWatchValueByEvaluateName(child, evaluateName);
      if (match) return match;
    }
    return undefined;
  }

  private formatMemoryReference(address: number): string {
    return `0x${Math.max(0, address >>> 0).toString(16).toUpperCase()}`;
  }

  private parseMemoryReference(memoryReference: unknown, offset: unknown = 0): number | null {
    if (typeof memoryReference !== 'string' && typeof memoryReference !== 'number') return null;
    const refText = String(memoryReference).trim();
    const match = refText.match(/0x[0-9a-fA-F]+|\b\d+\b/);
    if (!match) return null;
    const base = match[0].toLowerCase().startsWith('0x') ? parseInt(match[0], 16) : parseInt(match[0], 10);
    if (!Number.isFinite(base)) return null;
    const off = typeof offset === 'number' && Number.isFinite(offset) ? offset : 0;
    return (base + off) >>> 0;
  }

  private memoryReferenceForWatch(value: WatchValue): string | undefined {
    if (value.typeName?.includes('*') && typeof value.value === 'number' && value.value) {
      return this.formatMemoryReference(value.value);
    }
    if (typeof value.address === 'number') {
      return this.formatMemoryReference(value.address);
    }
    if ((value.expression.startsWith('&') || /^0x[0-9a-fA-F]+$/.test(value.expression)) && typeof value.value === 'number' && Number.isFinite(value.value)) {
      return this.formatMemoryReference(value.value);
    }
    return undefined;
  }

  private toDapVariable(value: WatchValue, rtosExpansion?: RtosVariableExpansion) {
    return {
      name: value.expression,
      value: value.error || value.display || value.hex || `${value.value}`,
      type: value.typeName || undefined,
      variablesReference: this.allocateVariableHandle(value, rtosExpansion),
      memoryReference: this.memoryReferenceForWatch(value),
      evaluateName: value.evaluateName || value.expression,
    };
  }

  private startPolling() {
    this.stopPolling();
    log.dap(`startPolling: started, ${this.watchExpressions.length} watch expressions`);
    const pollLoop = async () => {
      if (this.pollTimer === null) return;
      try {
        if (this.pollTimer === null) return;
        const stateResult = await this.queryTargetState('run-poll');
        if (stateResult.ok && stateResult.data === 'halted') {
          this.markStoppedForUi();
          this.sendEvent('stopped', {
            reason: this.lastHaltReason,
            threadId: 1,
            allThreadsStopped: true,
          });
          this.stopPolling();
          if (this.watchExpressions.length > 0) {
            setTimeout(() => {
              void this.readWatchExpressions(this.watchExpressions, false)
                .then(results => this.sendWatchUpdate(results))
                .catch(err => log.dap(`pollLoop: deferred watch read error ${err}`));
            }, 150);
          }
          return;
        }
      } catch (err) {
        log.dap(`startPolling: error ${err}`);
      }
      if (this.pollTimer !== null) {
        this.pollTimer = setTimeout(pollLoop, 200);
      }
    };
    this.pollTimer = setTimeout(pollLoop, 200);
  }

  private sendWatchUpdate(results: any[]) {
    this.sendEvent('ozoneWatchData', { results });
  }

  private makeRunningWatchValue(expression: string): WatchValue {
    return { expression, value: 0, display: '', hex: '', error: 'running' };
  }

  private makeRunningWatchValues(expressions: string[]): WatchValue[] {
    return expressions.map(expression => this.makeRunningWatchValue(expression));
  }

  private cacheRuntimeWatchValue(expression: string, value: WatchValue) {
    this.runtimeWatchCache.set(expression, value);
    this.runtimeWatchCacheTime.set(expression, Date.now());
  }

  private getFreshRuntimeWatchValue(expression: string, maxAgeMs = this.runtimeEvaluateCacheMs): WatchValue | undefined {
    const cached = this.runtimeWatchCache.get(expression);
    const timestamp = this.runtimeWatchCacheTime.get(expression);
    if (!cached || timestamp === undefined || Date.now() - timestamp > maxAgeMs) return undefined;
    return cached;
  }

  private async isTargetHalted(): Promise<boolean> {
    const result = await this.queryTargetState('halt-check');
    return result.ok && result.data === 'halted';
  }

  private async readWatchExpressions(
    expressions: string[],
    forceRuntimeRead: boolean,
    expandedExpressions?: string[],
  ): Promise<WatchValue[]> {
    if (expressions.length === 0) return [];
    if (this.isSessionTerminating()) {
      return expressions.map(expr => this.cachedOrRunningWatchValue(expr));
    }
    if (forceRuntimeRead && this.runtimeWatchReadInFlight) {
      return expressions.map(expr => this.cachedOrRunningWatchValue(expr));
    }

    const epoch = this.readCancelEpoch;
    const results: WatchValue[] = [];
    const batchStarted = Date.now();
    let chunks = 0;
    let maxChunkElapsedMs = 0;
    let index = 0;
    const fastValues = new Map<string, WatchValue>();
    if (forceRuntimeRead) this.runtimeWatchReadInFlight = true;

    try {
      // Runtime Watch/Timeline sampling is explicitly allowed while the target
      // is running. Do not perform a state query for that path: the query is a
      // serialized native-owner operation and, if it waits behind a Timeline
      // read, holding the Watch read gate here would pause Timeline as well.
      // The halted check is only needed for the non-forced DAP Watch refresh.
      if (!forceRuntimeRead) {
        if (this.shouldDeferTargetRead() || !(await this.isTargetHalted())) {
          while (index < expressions.length) results.push(this.cachedOrRunningWatchValue(expressions[index++]));
          return results;
        }
      }

      const expanded = new Set(expandedExpressions || []);
      const fastCandidates = forceRuntimeRead
        ? expressions.filter(expression => !expanded.has(expression))
        : [];
      if (fastCandidates.length >= 2 && !this.shouldDeferTargetRead()) {
        const planResult = await this.backend.execute({
          cmd: 'prepareFastDataSampling',
          expressions: fastCandidates,
        });
        const plan = planResult.ok ? planResult.data as FastDataSamplePlanItem[] : [];
        const specs = plan
          .map(item => item.spec)
          .filter((spec): spec is FastDataSampleSpec => !!spec && spec.format?.kind !== 'pointer');
        if (specs.length >= 2 && await this.beginWatchTargetRead()) {
          const fastStarted = Date.now();
          try {
            const readResult = await this.backend.execute({
              cmd: 'readFastDataSampling',
              specs,
              priority: 'watch',
            });
            if (readResult.ok && epoch === this.readCancelEpoch && !this.shouldDeferTargetRead()) {
              for (const result of readResult.data as WatchValue[]) {
                const expression = result.expression;
                if (!expression || result.error) continue;
                const value = {
                  ...result,
                  expression,
                  evaluateName: result.evaluateName || expression,
                } as WatchValue;
                fastValues.set(expression, value);
                this.cacheRuntimeWatchValue(expression, value);
              }
            }
          } finally {
            this.endTargetRead();
          }
          chunks++;
          maxChunkElapsedMs = Math.max(maxChunkElapsedMs, Date.now() - fastStarted);
          if (fastValues.size > 0 && fastValues.size < expressions.length) {
            await new Promise<void>(resolve => setImmediate(resolve));
          }
        }
      }

      while (index < expressions.length) {
        const fastValue = fastValues.get(expressions[index]);
        if (fastValue) {
          results.push(fastValue);
          index++;
          continue;
        }
        if (epoch !== this.readCancelEpoch || this.shouldDeferTargetRead()) {
          while (index < expressions.length) results.push(this.cachedOrRunningWatchValue(expressions[index++]));
          break;
        }
        if (!(await this.beginWatchTargetRead())) {
          while (index < expressions.length) results.push(this.cachedOrRunningWatchValue(expressions[index++]));
          break;
        }

        const chunkStarted = Date.now();
        let chunkCount = 0;
        try {
          while (index < expressions.length) {
            const expr = expressions[index++];
            if (epoch !== this.readCancelEpoch || this.shouldDeferTargetRead()) {
              results.push(this.cachedOrRunningWatchValue(expr));
            } else {
              const controller = new AbortController();
              this.activeEvaluateAbortController = controller;
              try {
                const result = await this.backend.execute({
                  cmd: 'evaluateExpression',
                  expression: expr,
                  force: forceRuntimeRead,
                  expandedExpressions,
                  signal: controller.signal,
                });
                if (controller.signal.aborted || epoch !== this.readCancelEpoch || this.shouldDeferTargetRead()) {
                  log.dap(`[watch] discarded stale evaluate expression=${expr} readEpoch=${epoch} currentEpoch=${this.readCancelEpoch}`);
                  results.push(this.cachedOrRunningWatchValue(expr));
                } else if (result.ok) {
                  const value = {
                    ...(result.data as WatchValue),
                    expression: expr,
                    evaluateName: (result.data as WatchValue).evaluateName || expr,
                  } as WatchValue;
                  this.cacheRuntimeWatchValue(expr, value);
                  results.push(value);
                } else {
                  results.push({
                    expression: expr,
                    value: 0,
                    display: '',
                    hex: '',
                    error: result.error,
                    errorCode: result.errorCode,
                  });
                }
              } finally {
                if (this.activeEvaluateAbortController === controller) {
                  this.activeEvaluateAbortController = null;
                }
              }
            }
            chunkCount++;
            if (chunkCount >= this.watchReadChunkSize || Date.now() - chunkStarted >= this.watchReadBudgetMs) break;
          }
        } finally {
          this.endTargetRead();
        }
        chunks++;
        maxChunkElapsedMs = Math.max(maxChunkElapsedMs, Date.now() - chunkStarted);

        if (index < expressions.length) {
          // Keep each Watch slice finite. Releasing the DAP barrier and yielding
          // here lets the already-scheduled Timeline loop claim one low-priority read.
          await new Promise<void>(resolve => setImmediate(resolve));
        }
      }

      const elapsed = Date.now() - batchStarted;
      if (elapsed >= 16) {
        log.dap(
          `[watch] batch expressions=${expressions.length}`
          + ` expanded=${expandedExpressions?.length || 0}`
          + ` chunks=${chunks} maxChunkMs=${maxChunkElapsedMs} elapsedMs=${elapsed}`,
        );
      }
      return results;
    } finally {
      if (forceRuntimeRead) this.runtimeWatchReadInFlight = false;
    }
  }

  private stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private startRttLogPolling(options: { retryInvalidControlBlock?: boolean } = {}) {
    if (!this.rttLogEnabled || !this.rttAvailable) return;
    this.stopRttLogPolling();
    const generation = this.rttPollGeneration;
    const retryInvalidControlBlock = options.retryInvalidControlBlock === true;
    let transientStartFailureLogged = false;
    const abortController = new AbortController();
    this.rttPollAbortController = abortController;
    const signal = abortController.signal;
    this.rttStarted = false;
    this.rttDecoder = new StringDecoder('utf8');
    this.rttControlCarry = '';
    this.rttLineCarry = '';
    this.pRtLogDecoder.resetFrames();
    this.emitRttTerminalStarted();

    const pollLoop = async () => {
      if (this.rttPollTimer === null || generation !== this.rttPollGeneration || signal.aborted) return;
      try {
        if (!this.rttStarted) {
          const startResult = await this.backend.execute({
            cmd: 'startRtt',
            controlBlockAddress: this.rttControlBlockAddress,
          });
          if (this.rttPollTimer === null || generation !== this.rttPollGeneration || signal.aborted) return;
          if (!startResult.ok) {
            if (retryInvalidControlBlock && startResult.errorCode === 'RttInvalidControlBlock') {
              if (!transientStartFailureLogged) {
                transientStartFailureLogged = true;
                const diagnostics = startResult.diagnostics
                  ? ' diagnostics=' + JSON.stringify(startResult.diagnostics)
                  : '';
                log.dap(
                  '[rtt] startRtt transient errorCode=RttInvalidControlBlock'
                  + ' error=' + startResult.error
                  + ' action=retry'
                  + ' intervalMs=' + this.rttPollIntervalMs
                  + diagnostics,
                );
              }
            } else {
              this.handleRttFailure('startRtt', startResult);
            }
            this.rttStarted = false;
          } else {
            this.rttStarted = true;
            log.dap('[rtt] startRtt ok');
          }
        }

        if (this.rttStarted) {
          const readResult = await this.backend.execute({
            cmd: 'readRtt',
            bufferIndex: this.rttBufferIndex,
            size: this.rttReadSize,
            signal,
          });
          if (this.rttPollTimer === null || generation !== this.rttPollGeneration || signal.aborted) return;
          if (readResult.ok) {
            const bytes = (readResult.data as any)?.bytes;
            log.dap('[rtt] readRtt ok bytes=' + (Array.isArray(bytes) || bytes instanceof Uint8Array ? bytes.length : 0));
            if ((Array.isArray(bytes) || bytes instanceof Uint8Array) && bytes.length > 0) {
              this.emitRttBytes(Buffer.from(bytes));
            }
          } else {
            this.handleRttFailure('readRtt', readResult);
            this.rttStarted = false;
          }
        }
      } catch (error) {
        if (signal.aborted || generation !== this.rttPollGeneration || this.rttPollTimer === null) return;
        const errorCode = typeof (error as any)?.errorCode === 'string'
          ? (error as any).errorCode
          : 'RttPollingException';
        const failure: OzoneCommandResult = {
          ok: false,
          errorCode,
          error: error instanceof Error ? error.message : String(error),
          diagnostics: (error as any)?.diagnostics,
        };
        this.handleRttFailure('polling', failure);
        this.rttStarted = false;
      }

      if (this.rttPollTimer !== null && generation === this.rttPollGeneration && !signal.aborted) {
        this.rttPollTimer = setTimeout(pollLoop, this.rttPollIntervalMs);
      }
    };

    this.rttPollTimer = setTimeout(pollLoop, this.rttPollIntervalMs);
  }

  private stopRttLogPolling(notifyOwner = true) {
    this.rttPollGeneration++;
    this.rttPollAbortController?.abort();
    this.rttPollAbortController = null;
    if (this.rttPollTimer) {
      clearTimeout(this.rttPollTimer);
      this.rttPollTimer = null;
    }
    const trailing = this.rttDecoder.end();
    if (trailing) {
      this.emitRttOutput(trailing);
    }
    if (this.pRtLogEnabled) {
      for (const line of this.pRtLogDecoder.flush()) {
        this.emitRttOutput(line);
      }
    }
    if (this.rttControlCarry) {
      this.emitRttText(this.rttControlCarry);
    }
    if (this.rttLineCarry) {
      this.emitRttLine(this.rttLineCarry);
    }
    this.rttDecoder = new StringDecoder('utf8');
    this.rttControlCarry = '';
    this.rttLineCarry = '';
    this.rttStarted = false;
    if (notifyOwner) void this.backend.execute({ cmd: 'stopRtt' });
  }

  private handleRttFailure(operation: string, result: OzoneCommandResult) {
    if (result.ok) return;
    if (this.isOwnerLossErrorCode(result.errorCode)) {
      this.logRttFailure(operation, result);
      void this.terminateForConnectionLoss(result.errorCode || 'RttOwnerLost');
      return;
    }
    if (this.isRttUnavailableErrorCode(result.errorCode)) {
      this.disableRttForSession(result, this.rttControlBlockSource);
      return;
    }
    this.logRttFailure(operation, result);
  }

  private disableRttForSession(
    result: Extract<OzoneCommandResult, { ok: false }>,
    source: 'elf-symbol' | 'config',
  ) {
    if (!this.rttAvailable) return;
    this.rttAvailable = false;
    this.stopRttLogPolling(false);
    const diagnostics = result.diagnostics ? ' diagnostics=' + JSON.stringify(result.diagnostics) : '';
    log.dap(
      '[rtt] unavailable errorCode=' + (result.errorCode || 'RttUnavailable')
      + ' error=' + result.error
      + ' source=' + source
      + ' action=disabled debugContinues=true'
      + diagnostics,
    );
    this.sendEvent('output', {
      category: 'stderr',
      output: `RTT unavailable (${result.errorCode || 'RttUnavailable'}): ${result.error}. RTT disabled; debugging continues.\n`,
    });
  }

  private isRttUnavailableErrorCode(errorCode: string | undefined): boolean {
    return errorCode === 'RttControlBlockUnavailable'
      || errorCode === 'RttInvalidControlBlock'
      || errorCode === 'RttInvalidBufferIndex'
      || errorCode === 'RttInvalidBufferLayout'
      || errorCode === 'RttInvalidBufferFlags';
  }

  private isOwnerLossErrorCode(errorCode: string | undefined): boolean {
    return errorCode === 'DeviceRemoved'
      || errorCode === 'HelperExited'
      || errorCode === 'NativeOwnerLost'
      || errorCode === 'RttOwnerLost'
      || errorCode === 'TargetOwnerUnavailable'
      || errorCode === 'TargetDisconnected';
  }

  private logRttFailure(operation: string, result: OzoneCommandResult) {
    if (result.ok) return;
    const diagnostics = result.diagnostics ? ' diagnostics=' + JSON.stringify(result.diagnostics) : '';
    log.dap(
      '[rtt] ' + operation
      + ' failed errorCode=' + (result.errorCode || 'Unknown')
      + ' error=' + result.error
      + diagnostics,
    );
  }

  private stripAnsi(text: string): string {
    return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
  }

  private emitRttBytes(bytes: Buffer) {
    if (this.pRtLogEnabled) {
      for (const line of this.pRtLogDecoder.feed(bytes)) {
        this.emitRttOutput(line);
      }
      return;
    }

    this.emitRttOutput(this.rttDecoder.write(bytes));
  }

  private emitRttOutput(text: string) {
    text = this.rttControlCarry + text;
    this.rttControlCarry = this.takeTrailingClearPrefix(text);
    if (this.rttControlCarry) {
      text = text.slice(0, -this.rttControlCarry.length);
    }

    const clearPattern = /\x1B\[2J/g;
    let cursor = 0;
    let match: RegExpExecArray | null;
    while ((match = clearPattern.exec(text)) !== null) {
      const beforeClear = text.slice(cursor, match.index).replace(/[ \t]+$/g, '');
      this.emitRttText(beforeClear);
      this.sendEvent('ozoneClearDebugConsole', {});
      this.sendRttClearMarker();
      cursor = match.index + match[0].length;
    }
    this.emitRttText(text.slice(cursor));
  }

  private sendRttClearMarker() {
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    this.emitRttTerminalText(`\x1B[2J\x1B[H\x1B[1;36m========== RTT Log_Clear() ${time} ==========\x1B[0m\r\n`);
    this.emitRttDebugConsoleLine(`\n========== RTT Log_Clear() ${time} ==========\n`, 'stdout');
  }

  private takeTrailingClearPrefix(text: string): string {
    const clearSequence = '\x1B[2J';
    for (let len = clearSequence.length - 1; len > 0; len--) {
      const suffix = text.slice(-len);
      if (clearSequence.startsWith(suffix)) return suffix;
    }
    return '';
  }

  private emitRttText(text: string) {
    if (text.length === 0) return;

    text = this.rttLineCarry + text;
    this.rttLineCarry = '';

    let cursor = 0;
    const linePattern = /\r\n|\n|\r/g;
    let match: RegExpExecArray | null;
    while ((match = linePattern.exec(text)) !== null) {
      this.emitRttLine(text.slice(cursor, match.index + match[0].length));
      cursor = match.index + match[0].length;
    }

    const rest = text.slice(cursor);
    if (rest.length > 0) {
      this.rttLineCarry = rest;
    }
  }

  private emitRttLine(text: string) {
    if (text.length > 0) {
      this.emitRttTerminalText(text);
    }
    const output = this.rttStripAnsi ? this.stripAnsi(text) : text;
    if (output.length <= 0) return;
    this.appendRttLogLine(text);
    const category = this.isWarningOrErrorRttLine(text) ? 'stderr' : 'stdout';
    this.emitRttDebugConsoleLine(output, category);
  }

  /** Retains one finalized RTT Log line for `orbit.rttlog.read` (raw text, ANSI intact). */
  private appendRttLogLine(text: string): void {
    const line = text.replace(/[\r\n]+$/, '');
    this.rttLogSequence += 1;
    this.rttLogEntries.push({
      id: String(this.rttLogSequence),
      timestamp: String(Date.now()),
      kind: this.pRtLogEnabled ? 'decoded' : 'text',
      text: line,
    });
    while (this.rttLogEntries.length > MAX_RTT_LOG_LINES) this.rttLogEntries.shift();
  }

  private isWarningOrErrorRttLine(text: string): boolean {
    if (/\x1B\[1;3[13]m\s*[WE]:/.test(text)) return true;
    return /^\s*[WE]:/.test(this.stripAnsi(text));
  }

  private emitRttTerminalText(text: string) {
    if (this.rttLogTarget === 'terminal' || this.rttLogTarget === 'both') {
      this.sendEvent('ozoneRttOutput', { text });
    }
  }

  private emitRttTerminalStarted() {
    if (this.rttLogTarget === 'terminal' || this.rttLogTarget === 'both') {
      this.sendEvent('ozoneRttStarted', {});
    }
  }

  private emitRttDebugConsoleLine(output: string, category: 'stdout' | 'stderr') {
    if (this.rttLogTarget === 'debugConsole' || this.rttLogTarget === 'both') {
      this.sendEvent('output', { category, output });
    }
  }

  private parseRttLogTarget(value: unknown): 'terminal' | 'debugConsole' | 'both' {
    return value === 'debugConsole' || value === 'both' ? value : 'terminal';
  }

  private async handleRequest(msg: DebugProtocolMessage) {
    try {
      if ((this.phase === 'terminating' || this.phase === 'terminated') && msg.command !== 'disconnect') {
        this.sendResponse(msg, undefined, false, 'Debug session is terminating');
        return;
      }
      await this.dispatchRequest(msg);
    } catch (err: any) {
      this.sendResponse(msg, undefined, false, err.message);
    }
  }

  /**
   * Single dispatch table shared by standard DAP requests and automation
   * control requests (plan Task 5): automation requests run through the same
   * cases, so the same handler core drives both paths.
   */
  private async dispatchRequest(msg: DebugProtocolMessage) {
    switch (msg.command) {
        case 'initialize':
          return this.sendResponse(msg, {
            supportsConfigurationDoneRequest: true,
            supportsConditionalBreakpoints: false,
            supportsHitConditionalBreakpoints: false,
            supportsEvaluateForHovers: true,
            supportsStepBack: false,
            supportsSetVariable: false,
            supportsRestartFrame: false,
            supportsGotoTargetsRequest: false,
            supportsStepInTargetsRequest: false,
            supportsCompletionsRequest: false,
            supportsRestartRequest: true,
            supportsExceptionOptions: false,
            supportTerminateDebuggee: false,
            supportsLogPoints: false,
            supportsDataBreakpoints: false,
            supportsReadMemoryRequest: true,
            supportsWriteMemoryRequest: true,
            supportsDisassembleRequest: false,
            supportsCancelRequest: false,
            supportsBreakpointLocationsRequest: false,
            supportsSteppingGranularity: true,
            supportsInstructionBreakpoints: false,
            supportsRTOS: true,
            rtosName: this._rtos || '',
          });
        case 'launch':
          return this.handleLaunch(msg);
        case 'disconnect':
          return this.handleDisconnect(msg);
        case 'setBreakpoints':
          return this.handleSetBreakpoints(msg);
        case 'setExceptionBreakpoints':
          return this.sendResponse(msg);
        case 'configurationDone':
          return this.handleConfigurationDone(msg);
        case 'threads':
          return this.sendResponse(msg, {
            threads: [{
              id: 1,
              name: this._rtos ? `${this._device} (${this._rtos})` : this._device || 'Cortex-M4',
            }]
          });
        case 'stackTrace':
          return this.handleStackTrace(msg);
        case 'scopes':
          return this.sendResponse(msg, {
            scopes: [
              { name: 'Local', variablesReference: 1, expensive: false },
              { name: 'Registers', variablesReference: 2, expensive: false },
            ],
          });
        case 'variables':
          return this.handleVariables(msg);
        case 'readMemory':
          return this.handleReadMemory(msg);
        case 'writeMemory':
          return this.handleWriteMemory(msg);
        case 'continue':
          return this.handleContinue(msg);
        case 'next':
          return this.handleStep(msg, msg.arguments?.granularity === 'instruction' ? 'stepIntoInstruction' : 'stepOver');
        case 'stepIn':
          return this.handleStep(msg, msg.arguments?.granularity === 'instruction' ? 'stepIntoInstruction' : 'stepInto');
        case 'stepOut':
          return this.handleStep(msg, 'stepOut');
        case 'pause':
          return this.handlePause(msg);
        case 'restart':
          return this.handleRestart(msg);
        case 'evaluate':
          return this.handleEvaluate(msg);
        case 'watchEvaluate':
          return this.handleWatchEvaluate(msg);
        case 'setWatches':
          this.watchExpressions = this.normalizeWatchExpressions(msg.arguments?.expressions);
          return this.sendResponse(msg);
        case 'dataSample':
          return this.handleDataSample(msg);
        case 'dataSamplingStart':
          return this.handleDataSamplingStart(msg);
        case 'dataSamplingStop':
          return this.handleDataSamplingStop(msg);
        case 'setWatchValue':
          return this.handleSetWatchValue(msg);
        case 'getTargetState':
          return this.handleGetTargetState(msg);
        case 'rtosInfo':
          return this.handleRtosInfo(msg);
        case AUTOMATION_CONTROL_COMMAND:
          return this.handleAutomationControl(msg);
        case AUTOMATION_BREAKPOINTS_COMMAND:
          return this.handleAutomationBreakpoints(msg);
        case AUTOMATION_RUNTIME_COMMAND:
          return this.handleAutomationRuntime(msg);
        case AUTOMATION_EXPRESSION_COMMAND:
          return this.handleAutomationExpression(msg);
        case AUTOMATION_MEMORY_COMMAND:
          return this.handleAutomationMemory(msg);
        case AUTOMATION_RTT_COMMAND:
          return this.handleAutomationRtt(msg);
        case AUTOMATION_RTT_LOG_COMMAND:
          return this.handleAutomationRttLog(msg);
        case AUTOMATION_DIAGNOSTICS_COMMAND:
          return this.handleAutomationDiagnostics(msg);
        default:
          this.sendResponse(msg, undefined, false, `Unsupported: ${msg.command}`);
    }
  }

  private async handleRtosInfo(msg: DebugProtocolMessage) {
    const configuredRtos = this._rtos.trim();
    const readEpoch = this.readCancelEpoch;
    const controller = new AbortController();
    const previousController = this.activeRtosInfoAbortController;
    if (previousController && !previousController.signal.aborted) {
      previousController.abort('superseded by a newer rtosInfo request');
    }
    this.activeRtosInfoAbortController = controller;
    let gateAcquired = false;
    const base = {
      rtos: configuredRtos,
      device: this._device,
      detected: false,
    };
    try {
      gateAcquired = await this.beginTargetReadWhenAvailable('background', 700, controller.signal);
      if (!gateAcquired) {
        const cancelled = controller.signal.aborted || readEpoch !== this.readCancelEpoch
          || this.controlInProgress || this.isSessionTerminating();
        const errorCode = cancelled ? 'TargetReadCancelled' : 'TargetReadUnavailable';
        this.sendResponse(msg, {
          ...base,
          errorCode,
          targetState: this.targetRunning ? 'Running' : 'Unknown',
          elapsedMs: 0,
          diagnostics: { operation: 'rtosInfo', phase: cancelled ? 'cancelled' : 'targetReadGate' },
        }, !cancelled, cancelled ? 'Busy' : undefined);
        return;
      }
      if (readEpoch !== this.readCancelEpoch || this.controlInProgress || this.isSessionTerminating()) {
        this.sendResponse(msg, {
          ...base,
          errorCode: 'TargetReadCancelled',
          targetState: this.targetRunning ? 'Running' : 'Halted',
          elapsedMs: 0,
          diagnostics: { operation: 'rtosInfo', phase: 'cancelled' },
        }, false, 'Busy');
        return;
      }
      const result = await this.backend.execute({
        cmd: 'evaluateExpression',
        expression: 'uxCurrentNumberOfTasks',
        force: true,
        signal: controller.signal,
        priority: 'background',
      });
      const stale = controller.signal.aborted || readEpoch !== this.readCancelEpoch
        || this.controlInProgress || this.isSessionTerminating();
      if (stale) {
        this.sendResponse(msg, {
          ...base,
          errorCode: 'TargetReadCancelled',
          targetState: this.targetRunning ? 'Running' : 'Halted',
          elapsedMs: result.elapsedMs ?? 0,
          diagnostics: { ...result.diagnostics, operation: 'rtosInfo', phase: 'cancelled' },
        }, false, 'Busy');
        return;
      }
      if (!result.ok) {
        const errorCode = result.errorCode || 'RtosNotDetected';
        const cancelled = errorCode === 'TargetReadCancelled' || errorCode === 'RtosReadCancelled';
        this.sendResponse(msg, {
          ...base,
          errorCode,
          targetState: result.targetState,
          elapsedMs: result.elapsedMs,
          diagnostics: { ...result.diagnostics, operation: 'rtosInfo', phase: 'symbolProbe' },
          error: result.error,
        }, !cancelled, cancelled ? 'Busy' : undefined);
        return;
      }
      this._rtos = configuredRtos || 'FreeRTOS';
      this.sendResponse(msg, {
        ...base,
        rtos: this._rtos,
        detected: true,
        targetState: result.targetState,
        elapsedMs: result.elapsedMs,
        diagnostics: { ...result.diagnostics, operation: 'rtosInfo', phase: 'symbolProbe' },
      });
    } finally {
      if (this.activeRtosInfoAbortController === controller) {
        this.activeRtosInfoAbortController = null;
      }
      if (gateAcquired) this.endTargetRead();
    }
  }

  private async handleLaunch(msg: DebugProtocolMessage) {
    try {
      const args = msg.arguments || {};
      const targetConfig = normalizeDapLaunchConfig(args);
      configureLogger({
        enabled: args.loggingEnabled !== false,
        clearOnStart: args.clearLogsOnStart !== false,
      });
      const device = args.device || args.deviceName || 'STM32F407VG';
      const interface_ = args.interface || 'SWD';
      const speedKHz = args.speedKHz || 4000;
      this._rtos = args.rtos || args.defaultRtos || '';
      const elfPath = args.program || args.elfPath || '';
      const flashEnabled = targetConfig.flashBeforeDebug;
      this.rttLogEnabled = args.rttLogEnabled !== false;
      this.rttAvailable = true;
      this.rttBufferIndex = Math.floor(this.clampNumber(args.rttBufferIndex, 0, 0, 15));
      this.rttPollIntervalMs = Math.floor(this.clampNumber(args.rttPollIntervalMs, 50, 10, 5000));
      this.rttReadSize = Math.floor(this.clampNumber(args.rttReadSize, 4096, 64, 65536));
      this.rttControlBlockAddress = this.parseOptionalAddress(args.rttControlBlockAddress);
      this.rttControlBlockSource = this.rttControlBlockAddress === undefined ? 'elf-symbol' : 'config';
      this.rttStripAnsi = args.rttStripAnsi !== false;
      this.rttLogTarget = this.parseRttLogTarget(args.rttLogTarget);
      this.pRtLogEnabled = args.pRtLogEnabled === true;
      this.pRtLogRoot = typeof args.pRtLogRoot === 'string' && args.pRtLogRoot.trim()
        ? args.pRtLogRoot.trim()
        : '';
      this._elfPath = elfPath;
      this._device = device;
      this._interface = interface_;
      this._speedKHz = speedKHz;
      this._probe = targetConfig.probe;
      this._flashEnabled = flashEnabled;
      this._runToEntryPoint = targetConfig.runToEntryPoint ?? false;
      this._cmsisDapFlashAlgorithmPath = targetConfig.cmsisDapFlashAlgorithmPath || '';
      this.phase = elfPath && this._flashEnabled ? 'flashing' : 'connecting';
      log.dap(`Launch: device=${device} rtos=${this._rtos || '(none)'} elf=${elfPath}`);
      this.resetVariableHandles();
      if (flashEnabled && !elfPath) {
        this.phase = 'idle';
        const error = 'InvalidConfiguration: flashBeforeDebug=true requires an ELF/AXF program path';
        log.dap(`Launch rejected capability=flashBeforeDebug errorCode=InvalidConfiguration`);
        this.sendEvent('output', { category: 'stderr', output: `${error}\n` });
        this.sendResponse(msg, undefined, false, error);
        return;
      }
      if (!flashEnabled) {
        log.dap('flash skipped reason=flashBeforeDebug=false');
        this.sendEvent('output', { category: 'console', output: 'Flash skipped: flashBeforeDebug=false\n' });
      }
      if (this.pRtLogEnabled) {
        const tokenLoad = this.pRtLogDecoder.loadTokenDatabase(elfPath);
        const output = tokenLoad.ok
          ? `P-RTLog enabled (${tokenLoad.count} token strings loaded from ${elfPath}).\n`
          : `P-RTLog enabled, but token database was not loaded: ${tokenLoad.error}. Root: ${this.pRtLogRoot}\n`;
        this.sendEvent('output', { category: tokenLoad.ok ? 'console' : 'stderr', output });
      }

      if (elfPath && this._flashEnabled && targetConfig.probe !== 'cmsis-dap') {
        this.sendEvent('output', { category: 'console', output: `Flashing ${elfPath}...\n` });
        const flashAbortController = new AbortController();
        this.flashAbortController = flashAbortController;
        const flashResult = await this.backend.execute({
          cmd: 'flash', elfPath, device, interface: interface_, speedKHz,
          probe: targetConfig.probe,
          flashBeforeDebug: targetConfig.flashBeforeDebug,
          cmsisDapFlashAlgorithmPath: targetConfig.cmsisDapFlashAlgorithmPath,
          signal: flashAbortController.signal,
        });
        if (this.flashAbortController === flashAbortController) this.flashAbortController = null;
        if (this.isSessionTerminating()) return;
        if (flashResult.ok) {
          this.sendEvent('output', { category: 'console', output: `Flash successful: ${(flashResult.data as any).message}\n` });
        } else {
          this.phase = 'idle';
          this.sendEvent('output', { category: 'stderr', output: `Flash failed: ${flashResult.error}\n` });
          this.sendResponse(msg, undefined, false, flashResult.error);
          return;
        }
        await new Promise<void>(r => setTimeout(r, 500));
      }

      this.phase = 'connecting';
      const connectResult = await this.backend.execute({
        cmd: 'connect', config: {
          device,
          interface: interface_,
          speedKHz,
          probe: targetConfig.probe,
          cmsisDapTransport: targetConfig.cmsisDapTransport,
          cmsisDapSerial: targetConfig.cmsisDapSerial,
          cmsisDapVid: targetConfig.cmsisDapVid,
          cmsisDapPid: targetConfig.cmsisDapPid,
          cmsisDapPath: targetConfig.cmsisDapPath,
          cmsisDapFlashAlgorithmPath: targetConfig.cmsisDapFlashAlgorithmPath,
          flashBeforeDebug: targetConfig.flashBeforeDebug,
          nativeDebugEngineMode: args.nativeDebugEngineMode === 'native' || args.nativeDebugEngineMode === 'legacy' || args.nativeDebugEngineMode === 'auto'
            ? args.nativeDebugEngineMode
            : 'auto',
          nativeDebugEngineEnabled: args.nativeDebugEngineEnabled !== false,
        },
      });
      if (!connectResult.ok) {
        this.phase = 'idle';
        this.sendEvent('output', { category: 'stderr', output: `Connect failed: ${connectResult.error}\n` });
        this.sendResponse(msg, undefined, false, connectResult.error);
        return;
      }
      this.targetConnectionEstablished = true;
      this.connectionFailureCount = 0;
      this.phase = elfPath && this._flashEnabled ? 'flashing' : 'connected';

      if (elfPath && this._flashEnabled && targetConfig.probe === 'cmsis-dap') {
        this.sendEvent('output', { category: 'console', output: `Flashing ${elfPath} through the connected CMSIS-DAP owner...\n` });
        const flashAbortController = new AbortController();
        this.flashAbortController = flashAbortController;
        const flashResult = await this.backend.execute({
          cmd: 'flash', elfPath, device, interface: interface_, speedKHz,
          probe: targetConfig.probe,
          flashBeforeDebug: targetConfig.flashBeforeDebug,
          cmsisDapFlashAlgorithmPath: targetConfig.cmsisDapFlashAlgorithmPath,
          signal: flashAbortController.signal,
        });
        if (this.flashAbortController === flashAbortController) this.flashAbortController = null;
        if (this.isSessionTerminating()) return;
        if (!flashResult.ok) {
          this.sendEvent('output', { category: 'stderr', output: `Flash failed: ${flashResult.error}\n` });
          await this.failLaunchAfterConnect(msg, flashResult, 'FlashFailed');
          return;
        }
        this.sendEvent('output', { category: 'console', output: `Flash successful: ${(flashResult.data as any)?.message || 'CMSIS-DAP Flash Algorithm completed'}\n` });
      }
      this.phase = 'connected';
      this.startConnectionMonitor();

      let loadResult: OzoneCommandResult | undefined;
      if (elfPath) loadResult = await this.backend.execute({ cmd: 'loadSymbols', elfPath });

      if (this.rttLogEnabled && this.rttControlBlockAddress === undefined) {
        const symbolResult = await this.backend.execute({ cmd: 'resolveSymbol', name: '_SEGGER_RTT' });
        const address = symbolResult.ok && Number.isInteger((symbolResult.data as any)?.address)
          ? Number((symbolResult.data as any).address)
          : undefined;
        if (address === undefined || address <= 0 || address > 0xFFFFFFFF) {
          const failure: OzoneCommandResult = symbolResult.ok
            ? {
              ok: false,
              errorCode: 'RttControlBlockUnavailable',
              error: 'RttControlBlockUnavailable: _SEGGER_RTT has an invalid ELF address',
            }
            : {
              ok: false,
              errorCode: 'RttControlBlockUnavailable',
              error: `RttControlBlockUnavailable: ${symbolResult.error}`,
            };
          this.disableRttForSession(failure, 'elf-symbol');
        } else {
          this.rttControlBlockAddress = address;
          this.rttControlBlockSource = 'elf-symbol';
          log.dap(`[rtt] control block address=0x${address.toString(16)} source=elf-symbol`);
        }
      } else if (this.rttControlBlockAddress !== undefined) {
        log.dap(`[rtt] control block address=0x${this.rttControlBlockAddress.toString(16)} source=config`);
      }

      if (this._probe === 'cmsis-dap' && this._flashEnabled && this._runToEntryPoint !== false) {
        if (!elfPath || !loadResult?.ok) {
          const haltResult = await this.backend.execute({ cmd: 'halt' });
          if (!haltResult.ok) {
            await this.failLaunchAfterConnect(msg, haltResult, 'EntryPointRecoveryFailed');
            return;
          }
          const failure: OzoneCommandResult = {
            ok: false,
            errorCode: 'EntryPointUnavailable',
            error: !elfPath
              ? 'EntryPointUnavailable: runToEntryPoint requires an ELF/AXF program path'
              : `EntryPointUnavailable: failed to load symbols from ${elfPath}${loadResult && !loadResult.ok ? `: ${loadResult.error}` : ''}`,
            targetState: 'Halted',
          };
          await this.failLaunchAfterConnect(msg, failure, 'EntryPointUnavailable');
          return;
        }
        const startupResult = await this.backend.execute({
          cmd: 'runToEntryPoint',
          symbol: this._runToEntryPoint,
          reset: true,
        });
        if (!startupResult.ok) {
          await this.failLaunchAfterConnect(msg, startupResult, 'StartupStopFailed');
          return;
        }
      } else {
        if (elfPath && this._flashEnabled) {
          this.sendEvent('output', { category: 'console', output: 'Resetting target after flash...\n' });
          await this.backend.execute({ cmd: 'reset' });
          await new Promise<void>(r => setTimeout(r, 200));
        }
        const initialHalt = await this.backend.execute({ cmd: 'halt' });
        if (!initialHalt.ok && this._probe === 'cmsis-dap') {
          this.sendEvent('output', { category: 'stderr', output: `Initial halt failed: ${initialHalt.error}\n` });
          await this.failLaunchAfterConnect(msg, initialHalt, 'TargetControlFailed');
          return;
        }
        if (this._probe === 'cmsis-dap') {
          const stateResult = await this.queryTargetState('launch-halt-confirm');
          if (!stateResult.ok || stateResult.data !== TargetState.Halted) {
            const failure: OzoneCommandResult = stateResult.ok
              ? {
                ok: false,
                errorCode: 'TargetStateInvalid',
                error: `TargetStateInvalid: launch halt returned ${stateResult.data}`,
                targetState: String(stateResult.data),
              }
              : stateResult;
            await this.failLaunchAfterConnect(msg, failure, 'TargetStateReadFailed');
            return;
          }
        }
        // The legacy path still uses its existing settle delay after halt.
        await new Promise<void>(r => setTimeout(r, 200));
      }
      this.markStoppedForUi();
      this.lastHaltReason = 'entry';
      if (this.rttLogEnabled && this.rttAvailable) {
        this.startRttLogPolling();
      } else {
        this.stopRttLogPolling(false);
      }

      this.sendEvent('initialized', {});
      this.sendResponse(msg);
    } catch (err: any) {
      this.backend.configureNativeSteps(false);
      this.flashAbortController = null;
      if (this.phase !== 'terminating' && this.phase !== 'terminated') {
        if (this.targetConnectionEstablished) {
          await this.cleanupFailedLaunch('LaunchException');
        } else {
          this.phase = 'idle';
        }
        this.sendResponse(msg, undefined, false, err.message);
      }
    }
  }

  private async handleDisconnect(msg: DebugProtocolMessage) {
    if (this.phase === 'terminated') {
      this.sendResponse(msg);
      return;
    }
    if (this.disposePromise) {
      await this.disposePromise;
      this.sendResponse(msg);
      this.sendEvent('terminated', {});
      this.phase = 'terminated';
      this.emit('shutdownRequested');
      return;
    }
    this.phase = 'terminating';
    this.targetConnectionEstablished = false;
    this.beginControl();
    this.cancelTargetReadGateWaiters();
    this.stopRttLogPolling();
    this.stopPolling();
    this.stopConnectionMonitor();
    this.stopDataSampling();
    this.flashAbortController?.abort('DAP disconnect requested');
    (this.backend as any).cancelFlash?.('DAP disconnect requested');
    try {
      this.forgetAllBreakpoints();
      await this.backend.execute({ cmd: 'disconnect' });
      await this.backend.dispose(true);
      this.backend.configureNativeSteps(false);
      this.setTargetRunning(true);
      this.sendResponse(msg);
      this.sendEvent('terminated', {});
      this.phase = 'terminated';
      this.disposePromise = Promise.resolve();
      this.emit('shutdownRequested');
    } finally {
      this.endControl();
    }
  }

  /**
   * Records one verified breakpoint entry. `address` is optional because some
   * legacy owners report only a slot id; both maps stay in sync so the
   * automation snapshot can expose resolved addresses.
   */
  private rememberBreakpoint(key: string, id: number, address?: number): void {
    this.breakpoints.set(key, id);
    if (typeof address === 'number' && Number.isFinite(address)) {
      this.breakpointAddresses.set(key, address);
    } else {
      this.breakpointAddresses.delete(key);
    }
  }

  private forgetBreakpoint(key: string): void {
    this.breakpoints.delete(key);
    this.breakpointAddresses.delete(key);
  }

  private forgetAllBreakpoints(): void {
    this.breakpoints.clear();
    this.breakpointAddresses.clear();
  }

  private async handleSetBreakpoints(msg: DebugProtocolMessage) {
    this.beginControl();
    try {
      const args = msg.arguments || {};
      const source = args.source || {};
      const filePath = source.path || '';
      const lines: number[] = args.lines || (args.breakpoints || []).map((b: any) => b.line);
      type DapBreakpointResult = {
        verified: boolean;
        line?: number;
        id?: number;
        message?: string;
        errorCode?: string;
      };
      type BreakpointFailure = {
        error?: string;
        message?: string;
        errorCode?: string;
        diagnostics?: Record<string, unknown>;
        targetState?: string;
        elapsedMs?: number;
      };
      const results: DapBreakpointResult[] = [];
      const normalizeThrownFailure = (error: unknown): BreakpointFailure => {
        if (!(error instanceof Error)) {
          return { error: String(error), errorCode: 'BackendException' };
        }
        const structured = error as Error & BreakpointFailure;
        return {
          error: structured.error || error.message,
          errorCode: structured.errorCode || 'BackendException',
          diagnostics: structured.diagnostics,
          targetState: structured.targetState,
          elapsedMs: structured.elapsedMs,
        };
      };
      const sendFailure = (failure: BreakpointFailure, remainingLines: number[]) => {
        const errorCode = failure.errorCode || 'BreakpointOperationFailed';
        const message = failure.error || failure.message || 'breakpoint operation failed';
        for (const line of remainingLines) {
          results.push({
            verified: false,
            line,
            message: `Not attempted after ${errorCode}: ${message}`,
            errorCode: 'NotAttempted',
          });
        }
        this.sendResponse(msg, {
          breakpoints: results,
          errorCode,
          message,
          diagnostics: failure.diagnostics,
          targetState: failure.targetState,
          elapsedMs: failure.elapsedMs,
        }, false, `${errorCode}: ${message}`);
      };

      const sourcePrefix = `${filePath}:`;
      const oldSlots = new Map<number, string[]>();
      for (const [key, bpIndex] of this.breakpoints) {
        if (!key.startsWith(sourcePrefix)) continue;
        const keys = oldSlots.get(bpIndex) || [];
        keys.push(key);
        oldSlots.set(bpIndex, keys);
      }
      for (const [bpIndex, sourceKeys] of oldSlots) {
        const referencedByAnotherSource = Array.from(this.breakpoints.entries())
          .some(([key, mappedIndex]) => !key.startsWith(sourcePrefix) && mappedIndex === bpIndex);
        if (referencedByAnotherSource) {
          for (const key of sourceKeys) this.forgetBreakpoint(key);
          continue;
        }
        log.dap(`handleSetBreakpoints: clearing old slot index=${bpIndex} source=${filePath}`);
        let clearResult;
        try {
          clearResult = await this.backend.execute({ cmd: 'clearBreakpoint', id: bpIndex });
        } catch (error) {
          sendFailure(normalizeThrownFailure(error), lines);
          return;
        }
        if (!clearResult.ok) {
          sendFailure(clearResult, lines);
          return;
        }
        for (const key of sourceKeys) this.forgetBreakpoint(key);
      }

      for (let index = 0; index < lines.length; ++index) {
        const line = lines[index];
        let result;
        try {
          result = await this.backend.execute({
            cmd: 'setBreakpoint', file: filePath, line,
          });
        } catch (error) {
          const failure = normalizeThrownFailure(error);
          const errorCode = failure.errorCode || 'BackendException';
          const message = failure.error || failure.message || 'backend exception';
          results.push({ verified: false, line, message, errorCode });
          sendFailure(failure, lines.slice(index + 1));
          return;
        }
        if (!result.ok) {
          results.push({
            verified: false,
            line,
            message: result.error,
            errorCode: result.errorCode || 'BreakpointSetFailed',
          });
          sendFailure(result, lines.slice(index + 1));
          return;
        }
        const data = result.data as { id?: unknown; address?: unknown } | undefined;
        if (!data || !Number.isInteger(data.id) || (data.id as number) < 0) {
          const failure = {
            error: 'setBreakpoint returned no valid hardware slot id',
            errorCode: 'MalformedResponse',
          };
          results.push({ verified: false, line, message: failure.error, errorCode: failure.errorCode });
          sendFailure(failure, lines.slice(index + 1));
          return;
        }
        const id = data.id as number;
        const key = `${filePath}:${line}`;
        this.rememberBreakpoint(key, id, typeof data.address === 'number' ? data.address : undefined);
        results.push({ verified: true, line, id });
      }

      this.sendResponse(msg, { breakpoints: results });
    } finally {
      this.endControl();
    }
  }

  private async handleConfigurationDone(msg: DebugProtocolMessage) {
    // Wait for CPU to be halted before sending stopped event
    await new Promise<void>(r => setTimeout(r, 100));
    this.lastHaltReason = 'entry';
    this.markStoppedForUi();
    this.sendResponse(msg);
    this.sendEvent('stopped', { reason: 'entry', threadId: 1 });
  }

  private async handleStackTrace(msg: DebugProtocolMessage) {
    log.dap(
      `[protocol] request seq=${msg.seq} command=stackTrace stopGeneration=${this.stopGeneration}`
      + ` threadId=${msg.arguments?.threadId ?? 'unknown'}`,
    );
    try {
      const readEpoch = this.readCancelEpoch;
      if (!(await this.beginTargetReadWhenAvailable('foreground', 700))) {
        this.sendResponse(msg, { stackFrames: [] });
        return;
      }
      const controller = new AbortController();
      try {
        if (readEpoch !== this.readCancelEpoch || this.controlInProgress) {
          // A control operation (continue/step) started while this read was
          // waiting on the gate: the target may be running now, so the queued
          // register reads must never reach the native owner.
          log.dap(`stackTrace cancelled before dispatch readEpoch=${readEpoch} currentEpoch=${this.readCancelEpoch}`);
          this.sendResponse(msg, { stackFrames: [] });
          return;
        }
        this.activeStoppedReadAbortController = controller;
        const result = await this.backend.execute({ cmd: 'getCallStack', signal: controller.signal });
        if (!result.ok || controller.signal.aborted || readEpoch !== this.readCancelEpoch) {
          log.dap(`stackTrace discarded stale result readEpoch=${readEpoch} currentEpoch=${this.readCancelEpoch} aborted=${controller.signal.aborted}`);
          this.sendResponse(msg, { stackFrames: [] });
          return;
        }
        const frames = result.data as StackFrame[];
        const stackFrames = frames.map((f) => ({
          id: f.id,
          name: f.function,
          source: f.file ? { path: f.file } : undefined,
          line: f.line > 0 ? f.line : 0,
          column: 0,
          instructionPointerReference: this.formatMemoryReference(f.address),
        }));
        this.sendResponse(msg, { stackFrames });
      } finally {
        if (this.activeStoppedReadAbortController === controller) {
          this.activeStoppedReadAbortController = null;
        }
        this.endTargetRead();
      }
    } catch (err: any) {
      this.sendResponse(msg, { stackFrames: [] });
    }
  }

  private async handleRtosVariableExpansion(msg: DebugProtocolMessage, handle: DapVariableHandle) {
    const startedAtMs = this.nowMs();
    const expansion = handle.rtosExpansion;
    if (!expansion) {
      this.sendResponse(msg, { variables: [] });
      return;
    }
    if (handle.stopGeneration !== this.stopGeneration || this.shouldDeferTargetRead()) {
      this.sendRtosVariablesFailure(
        msg,
        'RtosReadCancelled',
        'RTOS variable reference is no longer valid for the active stopped target',
        startedAtMs,
        handle,
      );
      return;
    }

    const expandedExpressions = expansion.expandedExpressions.includes(expansion.targetEvaluateName)
      ? expansion.expandedExpressions
      : [...expansion.expandedExpressions, expansion.targetEvaluateName];
    const childExpansion = { ...expansion, expandedExpressions };
    if (handle.children) {
      this.sendResponse(msg, {
        variables: handle.children.map(value => this.toDapVariable(value, childExpansion)),
      });
      return;
    }

    const readEpoch = this.readCancelEpoch;
    if (!(await this.beginTargetReadWhenAvailable('background', 1200))) {
      const error = 'RTOS variable expansion could not acquire the stopped-target read gate';
      this.sendResponse(msg, {
        variables: [],
        errorCode: 'TargetReadUnavailable',
        message: error,
        targetState: this.targetRunning ? 'Running' : 'Halted',
        elapsedMs: Math.max(0, this.nowMs() - startedAtMs),
        diagnostics: { targetReadGate: this.snapshotTargetReadGateMetrics() },
      }, false, `TargetReadUnavailable: ${error}`);
      return;
    }

    const controller = new AbortController();
    this.activeRtosVariablesAbortController = controller;
    try {
      if (readEpoch !== this.readCancelEpoch
        || handle.stopGeneration !== this.stopGeneration
        || this.shouldDeferTargetRead()) {
        this.sendRtosVariablesFailure(
          msg,
          'RtosReadCancelled',
          'RTOS variable expansion was cancelled before target access',
          startedAtMs,
          handle,
        );
        return;
      }
      const result = await this.backend.execute({
        cmd: 'evaluateExpression',
        expression: expansion.rootExpression,
        force: true,
        expandedExpressions,
        signal: controller.signal,
        priority: 'background',
      });
      if (controller.signal.aborted
        || readEpoch !== this.readCancelEpoch
        || handle.stopGeneration !== this.stopGeneration
        || this.shouldDeferTargetRead()) {
        log.dap(
          `RTOS variables discarded stale result expression=${expansion.rootExpression}`
          + ` readEpoch=${readEpoch} currentEpoch=${this.readCancelEpoch}`,
        );
        this.sendRtosVariablesFailure(
          msg,
          'RtosReadCancelled',
          'RTOS variable expansion result became stale',
          startedAtMs,
          handle,
          result,
        );
        return;
      }
      if (!result.ok) {
        const errorCode = result.errorCode || 'RtosVariableExpansionFailed';
        this.sendResponse(msg, {
          variables: [],
          errorCode,
          message: result.error,
          targetState: result.targetState,
          elapsedMs: result.elapsedMs,
          diagnostics: result.diagnostics,
        }, false, `${errorCode}: ${result.error}`);
        return;
      }

      const root = result.data as WatchValue;
      const expandedNode = this.findWatchValueByEvaluateName(root, expansion.targetEvaluateName);
      if (!expandedNode) {
        const error = `RTOS variable ${expansion.targetEvaluateName} was not present in the refreshed snapshot`;
        this.sendResponse(msg, {
          variables: [],
          errorCode: 'RtosVariableUnavailable',
          message: error,
          targetState: result.targetState,
          elapsedMs: result.elapsedMs,
          diagnostics: result.diagnostics,
        }, false, `RtosVariableUnavailable: ${error}`);
        return;
      }

      handle.children = expandedNode.children || [];
      handle.rtosExpansion = childExpansion;
      this.sendResponse(msg, {
        variables: handle.children.map(value => this.toDapVariable(value, childExpansion)),
      });
    } finally {
      if (this.activeRtosVariablesAbortController === controller) {
        this.activeRtosVariablesAbortController = null;
      }
      this.endTargetRead();
    }
  }

  private async handleVariables(msg: DebugProtocolMessage) {
    try {
      const args = msg.arguments || {};
      const ref = args.variablesReference;

      if (ref === 1) {
        const readEpoch = this.readCancelEpoch;
        if (!(await this.beginTargetReadWhenAvailable('foreground', 1200))) {
          log.dap('variables scope=locals target read unavailable');
          this.sendResponse(msg, { variables: [] });
          return;
        }
        const controller = new AbortController();
        try {
          if (readEpoch !== this.readCancelEpoch || this.controlInProgress) {
            log.dap(`variables scope=locals cancelled before dispatch readEpoch=${readEpoch} currentEpoch=${this.readCancelEpoch}`);
            this.sendResponse(msg, { variables: [] });
            return;
          }
          this.activeStoppedReadAbortController = controller;
          const result = await this.backend.execute({ cmd: 'getLocals', signal: controller.signal });
          if (result.ok && !controller.signal.aborted && readEpoch === this.readCancelEpoch) {
            const vars = (result.data as Variable[]).map((v) => ({
              name: v.name, value: v.value, type: v.type, variablesReference: 0,
            }));
            this.sendResponse(msg, { variables: vars });
          } else {
            if (controller.signal.aborted || readEpoch !== this.readCancelEpoch) {
              log.dap(`variables scope=locals discarded stale result readEpoch=${readEpoch} currentEpoch=${this.readCancelEpoch}`);
            }
            this.sendResponse(msg, { variables: [] });
          }
        } finally {
          if (this.activeStoppedReadAbortController === controller) {
            this.activeStoppedReadAbortController = null;
          }
          this.endTargetRead();
        }
      } else if (ref === 2) {
        const readEpoch = this.readCancelEpoch;
        if (!(await this.beginTargetReadWhenAvailable('foreground', 1200))) {
          log.dap('variables scope=registers target read unavailable');
          this.sendResponse(msg, { variables: [] });
          return;
        }
        const controller = new AbortController();
        try {
          if (readEpoch !== this.readCancelEpoch || this.controlInProgress) {
            log.dap(`variables scope=registers cancelled before dispatch readEpoch=${readEpoch} currentEpoch=${this.readCancelEpoch}`);
            this.sendResponse(msg, { variables: [] });
            return;
          }
          this.activeStoppedReadAbortController = controller;
          const regResult = await this.backend.execute({ cmd: 'getRegisters', signal: controller.signal });
          if (regResult.ok && !controller.signal.aborted && readEpoch === this.readCancelEpoch) {
            const regs = (regResult.data as any[]).map((r: any) => ({
              name: r.name,
              value: r.hex,
              type: 'uint32',
              variablesReference: 0,
              memoryReference: this.formatMemoryReference(r.value),
            }));
            this.sendResponse(msg, { variables: regs });
          } else {
            if (controller.signal.aborted || readEpoch !== this.readCancelEpoch) {
              log.dap(`variables scope=registers discarded stale result readEpoch=${readEpoch} currentEpoch=${this.readCancelEpoch}`);
            }
            this.sendResponse(msg, { variables: [] });
          }
        } finally {
          if (this.activeStoppedReadAbortController === controller) {
            this.activeStoppedReadAbortController = null;
          }
          this.endTargetRead();
        }
      } else if (this.variableHandles.has(ref)) {
        const handle = this.variableHandles.get(ref)!;
        if (Array.isArray(handle)) {
          this.sendResponse(msg, { variables: handle.map(value => this.toDapVariable(value)) });
        } else if (!handle.rtosExpansion) {
          this.sendResponse(msg, {
            variables: (handle.children || []).map(value => this.toDapVariable(value)),
          });
        } else {
          await this.handleRtosVariableExpansion(msg, handle);
        }
      } else {
        this.sendResponse(msg, { variables: [] });
      }
    } catch (err: any) {
      log.dap(`variables request failed: ${err?.message || String(err)}`);
      this.sendResponse(msg, { variables: [] });
    }
  }

  private async handleReadMemory(msg: DebugProtocolMessage, liveAccess = false) {
    const args = msg.arguments || {};
    const address = this.parseMemoryReference(args.memoryReference, args.offset);
    const count = Math.max(0, Math.min(Number(args.count) || 0, 1024 * 1024));
    if (address === null || count <= 0) {
      this.sendResponse(msg, undefined, false, 'Invalid memoryReference or count');
      return;
    }

    const readEpoch = this.readCancelEpoch;
    const controller = new AbortController();
    if (!(await this.beginTargetReadWhenAvailable('background', 700, controller.signal))) {
      this.sendResponse(msg, { address: this.formatMemoryReference(address), unreadableBytes: count }, false, 'Target is running');
      return;
    }

    try {
      if (readEpoch !== this.readCancelEpoch || this.controlInProgress || this.isSessionTerminating()) {
        this.sendResponse(msg, { address: this.formatMemoryReference(address), unreadableBytes: count }, false, 'Target read cancelled');
        return;
      }
      this.activeMemoryReadAbortController = controller;
      let result: OzoneCommandResult;
      try {
        result = await this.backend.execute({
          cmd: 'readMemory', address, size: count, signal: controller.signal, ...(liveAccess ? { liveAccess: true } : {}),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const cancelled = controller.signal.aborted || readEpoch !== this.readCancelEpoch;
        const errorCode = cancelled ? 'TargetReadCancelled' : 'MemoryReadFailed';
        this.sendResponse(msg, {
          address: this.formatMemoryReference(address),
          unreadableBytes: count,
          errorCode,
          targetState: this.targetRunning ? 'Running' : 'Halted',
          elapsedMs: 0,
          diagnostics: { operation: 'readMemory', phase: 'backend', error: message },
        }, false, `${errorCode}: ${message}`);
        return;
      }
      const stale = controller.signal.aborted || readEpoch !== this.readCancelEpoch || this.controlInProgress || this.isSessionTerminating();
      if (stale) {
        this.sendResponse(msg, {
          address: this.formatMemoryReference(address),
          unreadableBytes: count,
          errorCode: 'TargetReadCancelled',
          targetState: this.targetRunning ? 'Running' : 'Halted',
        }, false, 'Target read cancelled');
        return;
      }
      if (!result.ok) {
        this.sendResponse(msg, {
          address: this.formatMemoryReference(address),
          unreadableBytes: count,
          errorCode: result.errorCode,
          targetState: result.targetState,
          elapsedMs: result.elapsedMs,
          diagnostics: result.diagnostics,
        }, false, result.error);
        return;
      }

      const block = result.data as MemoryBlock;
      const bytes = Uint8Array.from(block.data);
      this.sendResponse(msg, {
        address: this.formatMemoryReference(address),
        data: Buffer.from(bytes).toString('base64'),
        unreadableBytes: block.unreadableBytes ?? Math.max(0, count - bytes.length),
      });
    } finally {
      if (this.activeMemoryReadAbortController === controller) {
        this.activeMemoryReadAbortController = null;
      }
      this.endTargetRead();
    }
  }

  private async handleWriteMemory(msg: DebugProtocolMessage) {
    const args = msg.arguments || {};
    const address = this.parseMemoryReference(args.memoryReference, args.offset);
    if (address === null || typeof args.data !== 'string') {
      this.sendResponse(msg, undefined, false, 'Invalid memoryReference or data');
      return;
    }

    let data: number[];
    try {
      data = Array.from(Buffer.from(args.data, 'base64'));
    } catch {
      this.sendResponse(msg, undefined, false, 'Invalid base64 memory payload');
      return;
    }

    const result = await this.backend.execute({ cmd: 'writeMemory', address, data });
    if (!result.ok) {
      this.sendResponse(msg, { offset: 0, bytesWritten: 0 }, false, result.error);
      return;
    }

    this.sendResponse(msg, { offset: 0, bytesWritten: data.length });
  }

  private async handleContinue(msg: DebugProtocolMessage) {
    await this.withStepLock(async () => {
      this.beginControl();
      this.stopPolling();
      try {
        if (this._probe !== 'cmsis-dap') {
          log.dap('handleContinue: reading PC');
          const pcResult = await this.backend.execute({ cmd: 'readRegister', name: 'PC' });
          let bpAddr: number | null = null;
          if (pcResult.ok) {
            const pcData = pcResult.data as any;
            bpAddr = pcData.value as number;
            log.dap(`handleContinue: pc=0x${bpAddr.toString(16)}`);
          }

          if (bpAddr !== null) {
            const clearResult = await this.backend.execute({ cmd: 'clearBreakpointAtAddr', addr: bpAddr });
            log.dap(`handleContinue: clear bp result ok=${clearResult.ok}`);
            if (clearResult.ok) {
              await this.backend.execute({ cmd: 'stepIntoInstruction' });
              await this.backend.execute({ cmd: 'setBreakpointAtAddr', addr: bpAddr });
              log.dap('handleContinue: re-set bp after step');
            }
          }
        }

        const runResult = await this.backend.execute({ cmd: 'run' });
        log.dap(`handleContinue: run result ok=${runResult.ok}`);
        const runData = runResult.ok && runResult.data !== null && typeof runResult.data === 'object'
          ? runResult.data as { state?: unknown; breakpointHitBeforeRunningObserved?: unknown }
          : null;
        const breakpointHitBeforeRunningObserved = this._probe === 'cmsis-dap'
          && runResult.ok
          && runData?.state === 'Halted'
          && runData.breakpointHitBeforeRunningObserved === true;
        if (!runResult.ok && this._probe === 'cmsis-dap') {
          this.sendResponse(msg, undefined, false, runResult.error);
          const stateResult = await this.queryTargetState('continue-failed-confirm');
          if (stateResult.ok && stateResult.data === TargetState.Halted) {
            this.markStoppedForUi();
            this.sendEvent('stopped', { reason: 'breakpoint', threadId: 1 });
          }
          return;
        }
        if (this._probe === 'cmsis-dap' && !breakpointHitBeforeRunningObserved) {
          const stateResult = await this.queryTargetState('continue-confirm');
          if (!stateResult.ok || stateResult.data !== TargetState.Running) {
            this.sendResponse(msg, undefined, false,
              stateResult.ok
                ? `TargetStateInvalid: continue returned ${stateResult.data}`
                : stateResult.error);
            if (stateResult.ok && stateResult.data === TargetState.Halted) {
              this.markStoppedForUi();
              this.sendEvent('stopped', { reason: 'breakpoint', threadId: 1 });
            }
            return;
          }
        }
        this.setTargetRunning(runResult.ok);
        if (runResult.ok) this.advanceReadCancelEpoch();
        this.sendResponse(msg, { allThreadsContinued: true });
        this.sendEvent('continued', { threadId: 1, allThreadsContinued: true });
        this.lastHaltReason = 'breakpoint';
        if (breakpointHitBeforeRunningObserved) {
          log.dap('handleContinue: breakpoint hit before Running was observed');
          this.markStoppedForUi();
          this.sendEvent('stopped', { reason: 'breakpoint', threadId: 1, allThreadsStopped: true });
          return;
        }
        if (!runResult.ok) {
          log.dap('handleContinue: run failed, sending stopped');
          this.markStoppedForUi();
          this.sendEvent('stopped', { reason: 'breakpoint', threadId: 1 });
          return;
        }
        this.startPolling();
      } finally {
        this.endControl();
      }
    });
  }

  private async handleStep(
    msg: DebugProtocolMessage,
    cmd: 'stepOver' | 'stepInto' | 'stepOut' | 'stepIntoInstruction',
  ) {
    const requestReceivedAt = Date.now();
    await this.withStepLock(async () => {
      const profileId = ++this.dapStepProfileSeq;
      const lockWaitMs = Date.now() - requestReceivedAt;
      const profileStart = Date.now();
      if (!(await this.beginTargetControl())) {
        log.dap(
          `[stepProfile#${profileId}] ${cmd} phase=targetControl lockWait=${lockWaitMs}ms`
          + ` controlDrain=${Date.now() - profileStart}ms outcome=busy`,
        );
        this.sendResponse(msg, undefined, false, 'Target busy');
        return;
      }
      const controlDrainMs = Date.now() - profileStart;
      const pollingStopStarted = Date.now();
      this.stopPolling();
      const pollingStopMs = Date.now() - pollingStopStarted;
      this.setTargetRunning(false);
      try {
        let responseSent = false;
        let responseSentAt = 0;
        let responseSendMs = 0;
        for (let attempt = 0; attempt < 3; attempt++) {
          log.dap(`handleStep: ${cmd} attempt ${attempt + 1}/3 start`);
          const tBackendStep = Date.now();
          const result = await this.backend.execute({ cmd });
          const backendMs = Date.now() - tBackendStep;
          log.dap(`handleStep: ${cmd} attempt ${attempt + 1} result=${result.ok} ${result.ok ? '' : result.error}`);
          log.dap(`[stepProfile#${profileId}] ${cmd} backend=${backendMs}ms attempt=${attempt + 1} ok=${result.ok}`);
          if (!result.ok) {
            // The CMSIS-DAP owner already reports the bounded transfer/control
            // outcome. Reissuing a failed control request can duplicate a
            // command whose completion is no longer knowable.
            if (attempt < 2 && !(this._probe === 'cmsis-dap' && result.errorCode)) {
              await new Promise<void>(r => setTimeout(r, 50));
              continue;
            }
            if (!responseSent) {
              this.sendResponse(msg, undefined, false, result.error);
              responseSent = true;
            }
            return;
          }

          const stepData = result.data as {
            mode?: string;
            pcBefore?: number;
            pcAfter?: number;
            classification?: string;
            helperElapsedMs?: number;
            targetState?: string;
            timings?: { totalMs?: number };
          } | undefined;
          if (stepData?.mode === 'cmsis-dap') {
            if (stepData.targetState !== 'Halted') {
              const stateResult = await this.queryTargetState('step-confirm');
              if (!stateResult.ok || stateResult.data !== TargetState.Halted) {
                this.sendResponse(msg, undefined, false,
                  stateResult.ok
                    ? `TargetStateInvalid: instruction step returned ${stateResult.data}`
                    : stateResult.error);
                responseSent = true;
                return;
              }
            }
          }

          if (!responseSent) {
            const tResponse = Date.now();
            this.sendResponse(msg);
            responseSent = true;
            responseSentAt = Date.now();
            responseSendMs = responseSentAt - tResponse;
            log.dap(`handleStep: ${cmd} response sent, starting poll`);
            log.dap(`[stepProfile#${profileId}] ${cmd} DAP response=${responseSendMs}ms sinceStart=${Date.now() - profileStart}ms`);
          }
          this.lastHaltReason = 'step';

          if (stepData?.mode === 'cmsis-dap') {
            this.markStoppedForUi();
            this.sendEvent('stopped', {
              reason: 'step',
              threadId: 1,
              allThreadsStopped: true,
            });
            log.dap(
              `[stepProfile#${profileId}] ${cmd} cmsis-dap halted`
              + ` pc=0x${stepData.pcBefore?.toString(16) ?? 'unknown'}->0x${stepData.pcAfter?.toString(16) ?? 'unknown'}`,
            );
            return;
          }
          if (stepData?.mode === 'native') {
            const helperElapsedMs = stepData.helperElapsedMs;
            const nativeStateMachineMs = stepData.timings?.totalMs;
            const transportAndBackendMs = helperElapsedMs === undefined
              ? undefined
              : Math.max(0, backendMs - helperElapsedMs);
            const budgetMs = cmd === 'stepOut'
              ? 100
              : stepData.classification === 'singleStep' || stepData.classification === 'branchSingleStep'
                ? 50
                : undefined;
            this.markStoppedForUi();
            this.sendEvent('stopped', { reason: 'step', threadId: 1 });
            const responseToStoppedMs = Date.now() - responseSentAt;
            const totalMs = Date.now() - profileStart;
            const budgetStatus = budgetMs === undefined ? 'unclassified' : totalMs <= budgetMs ? 'within' : 'exceeded';
            log.dap(
              `[stepProfile#${profileId}] ${cmd} native`
              + ` lockWait=${lockWaitMs}ms controlDrain=${controlDrainMs}ms pollingStop=${pollingStopMs}ms`
              + ` backend=${Date.now() - tBackendStep}ms helper=${helperElapsedMs ?? 'unknown'}ms`
              + ` nativeStateMachine=${nativeStateMachineMs ?? 'unknown'}ms`
              + ` transportAndBackend=${transportAndBackendMs ?? 'unknown'}ms`
              + ` response=${responseSendMs}ms responseToStopped=${responseToStoppedMs}ms total=${totalMs}ms`
              + ` budget=${budgetMs ?? 'none'}ms budgetStatus=${budgetStatus}`
              + ` classification=${stepData.classification ?? 'unknown'}`
              + ` pc=0x${stepData.pcBefore?.toString(16) ?? 'unknown'}->0x${stepData.pcAfter?.toString(16) ?? 'unknown'}`,
            );
            return;
          }

          for (let i = 0; i < 200; i++) {
            if (i > 0) await new Promise<void>(r => setTimeout(r, 10));
            const stateResult = await this.queryTargetState('step-settle');
            if (stateResult.ok && stateResult.data === 'halted') {
              this.markStoppedForUi();
              const tStoppedEvent = Date.now();
              this.sendEvent('stopped', { reason: 'step', threadId: 1 });
              log.dap(`[stepProfile#${profileId}] ${cmd} DAP stopped event=${Date.now() - tStoppedEvent}ms poll=${i + 1} sinceStart=${Date.now() - profileStart}ms`);
              return;
            }
            if (i > 50 && (i % 25 === 0)) {
              await this.backend.execute({ cmd: 'halt' });
            }
          }
          log.dap(`handleStep: not halted after 2000ms (soft settle attempts may have halted CPU), starting polling`);
          this.setTargetRunning(true);
          this.advanceReadCancelEpoch();
          this.startPolling();
          return;
        }
        log.dap(`handleStep: ${cmd} failed after 3 attempts`);
        if (!responseSent) {
          this.sendResponse(msg, undefined, false, 'Step failed after 3 attempts');
        }
      } finally {
        this.endControl();
      }
    });
  }

  private async handlePause(msg: DebugProtocolMessage) {
    await this.withStepLock(async () => {
      this.beginControl();
      this.stopPolling();
      try {
        const haltResult = await this.backend.execute({ cmd: 'halt' });
        if (!haltResult.ok && this._probe === 'cmsis-dap') {
          this.sendResponse(msg, undefined, false, haltResult.error);
          return;
        }
        if (this._probe === 'cmsis-dap') {
          const stateResult = await this.queryTargetState('pause-confirm');
          if (!stateResult.ok || stateResult.data !== TargetState.Halted) {
            this.sendResponse(msg, undefined, false,
              stateResult.ok
                ? `TargetStateInvalid: pause returned ${stateResult.data}`
                : stateResult.error);
            return;
          }
        }
        this.markStoppedForUi();
        this.lastHaltReason = 'pause';
        this.sendResponse(msg);
        this.sendEvent('stopped', { reason: 'pause', threadId: 1 });
      } finally {
        this.endControl();
      }
    });
  }

  private async handleRestart(msg: DebugProtocolMessage) {
    await this.withStepLock(async () => {
      this.beginControl();
      this.stopRttLogPolling();
      this.stopPolling();
      this.setTargetRunning(false);

      try {
        const savedBps: Array<{ file: string; line: number }> = [];
        for (const [key] of this.breakpoints) {
          const colonIdx = key.lastIndexOf(':');
          if (colonIdx > 0) {
            savedBps.push({ file: key.substring(0, colonIdx), line: parseInt(key.substring(colonIdx + 1)) });
          }
        }

        if (this._elfPath && this._flashEnabled) {
          if (this._probe === 'cmsis-dap') {
            const haltResult = await this.backend.execute({ cmd: 'halt' });
            if (!haltResult.ok) {
              this.sendCommandFailure(msg, haltResult, 'TargetControlFailed');
              return;
            }
            const stateResult = await this.queryTargetState('restart-flash-halt-confirm');
            if (!stateResult.ok || stateResult.data !== TargetState.Halted) {
              const failure: OzoneCommandResult = stateResult.ok
                ? {
                  ok: false,
                  errorCode: 'TargetStateInvalid',
                  error: `TargetStateInvalid: restart pre-flash halt returned ${stateResult.data}`,
                  targetState: String(stateResult.data),
                }
                : stateResult;
              this.sendCommandFailure(msg, failure, 'TargetStateReadFailed');
              return;
            }
          }
          this.sendEvent('output', { category: 'console', output: `Restart: flashing ${this._elfPath}...\n` });
          const flashResult = await this.backend.execute({
            cmd: 'flash', elfPath: this._elfPath, device: this._device,
            interface: this._interface as 'SWD' | 'JTAG', speedKHz: this._speedKHz,
            probe: this._probe,
            flashBeforeDebug: this._flashEnabled,
          });
          if (flashResult.ok) {
            this.sendEvent('output', { category: 'console', output: `Restart: flash successful\n` });
          } else {
            this.sendEvent('output', { category: 'stderr', output: `Restart: flash failed: ${flashResult.error}\n` });
            if (this._probe === 'cmsis-dap') {
              const stateResult = await this.queryTargetState('restart-flash-failure-recovery');
              const failure: OzoneCommandResult = stateResult.ok
                ? {
                  ...flashResult,
                  targetState: stateResult.data === TargetState.Halted
                    ? 'Halted'
                    : stateResult.data === TargetState.Running
                      ? 'Running'
                      : String(stateResult.data),
                }
                : flashResult;
              this.sendCommandFailure(msg, failure, 'FlashFailed');
              if (stateResult.ok && stateResult.data === TargetState.Halted) {
                this.markStoppedForUi();
                this.lastHaltReason = 'pause';
                if (this.rttLogEnabled) this.startRttLogPolling();
                this.sendEvent('stopped', { reason: 'pause', threadId: 1 });
              } else if (stateResult.ok && stateResult.data === TargetState.Running) {
                this.setTargetRunning(true);
                this.startPolling();
              }
            } else {
              this.sendResponse(msg, undefined, false, flashResult.error);
            }
            return;
          }
          await new Promise<void>(r => setTimeout(r, 500));
        }
        if (this._probe === 'cmsis-dap' && this._runToEntryPoint !== false) {
          const startupResult = await this.backend.execute({
            cmd: 'runToEntryPoint',
            symbol: this._runToEntryPoint,
            reset: true,
          });
          if (!startupResult.ok) {
            this.sendCommandFailure(msg, startupResult, 'StartupStopFailed');
            return;
          }
        } else {
          const resetResult = await this.backend.execute({ cmd: 'reset' });
          if (!resetResult.ok && this._probe === 'cmsis-dap') {
            this.sendCommandFailure(msg, resetResult, 'TargetControlFailed');
            return;
          }
          const haltResult = await this.backend.execute({ cmd: 'halt' });
          if (!haltResult.ok && this._probe === 'cmsis-dap') {
            this.sendCommandFailure(msg, haltResult, 'TargetControlFailed');
            return;
          }
          await new Promise<void>(r => setTimeout(r, 200));
        }
        if (this._probe !== 'cmsis-dap') {
          await this.backend.execute({ cmd: 'clearAllBreakpoints' });
          this.forgetAllBreakpoints();
        }

        if (this._probe !== 'cmsis-dap') {
          for (const bp of savedBps) {
            const result = await this.backend.execute({ cmd: 'setBreakpoint', file: bp.file, line: bp.line });
            if (result.ok) {
              const data = result.data as any;
              this.rememberBreakpoint(`${bp.file}:${bp.line}`, data.id, typeof data.address === 'number' ? data.address : undefined);
            }
          }
        }

        this.markStoppedForUi();
        this.lastHaltReason = 'entry';
        if (this.rttLogEnabled) {
          this.startRttLogPolling({ retryInvalidControlBlock: true });
        }
        this.sendResponse(msg);
        this.sendEvent('stopped', { reason: 'entry', threadId: 1 });
      } finally {
        this.endControl();
      }
    });
  }

  // --- automation control bridge (plan Task 5) -----------------------------
  // `session.customRequest('orbitAutomationControl', ...)` drives the same
  // handler cores as the standard DAP requests, so the VS Code UI updates
  // through the standard continued/stopped events while the caller receives a
  // structured outcome and the Extension Host a sanitized custom event.

  /**
   * Read-only `orbitBreakpointsSnapshot` (plan Task 6): exposes the adapter's
   * verified hardware-breakpoint map so the Extension Host can merge the
   * VS Code requested set with DAP verified/address/slot state. Reading the
   * in-memory map needs no target access, so no control/read barrier applies.
   */
  private handleAutomationBreakpoints(msg: DebugProtocolMessage) {
    const breakpoints: AutomationBreakpointSnapshot[] = [];
    for (const [key, slot] of this.breakpoints) {
      const separator = key.lastIndexOf(':');
      if (separator <= 0) continue;
      const path = key.slice(0, separator);
      const line = Number(key.slice(separator + 1));
      if (!Number.isInteger(line) || line <= 0) continue;
      const address = this.breakpointAddresses.get(key);
      breakpoints.push({
        path,
        line,
        verified: true,
        slot,
        ...(typeof address === 'number' ? { address: `0x${(address >>> 0).toString(16)}` } : {}),
      });
    }
    // These mirror the adapter's `initialize` capabilities (all unsupported in
    // this build): the Extension Host uses them to annotate condition/hit/log
    // breakpoints that are accepted but not enforced.
    this.sendResponse(msg, {
      breakpoints,
      capabilities: { conditional: false, hitConditional: false, logPoints: false },
    });
  }

  // --- runtime snapshot bridge (plan Task 7) --------------------------------
  // `session.customRequest('orbitRuntimeSnapshot', ...)` reuses the standard DAP
  // threads/stackTrace/scopes/variables handlers through the same capture
  // mechanism as automation control, plus a dedicated registers core. The
  // adapter reports the target state and any read-gate failure as a structured
  // errorCode; running targets never fabricate stopped-state data.

  private async handleAutomationRuntime(msg: DebugProtocolMessage) {
    const startedAt = Date.now();
    const parsed = parseAutomationRuntimeRequest(msg.arguments);
    if (!parsed.ok) {
      this.sendAutomationRuntimeFailure(msg, parsed.errorCode, parsed.message, this.automationTargetState(), startedAt);
      return;
    }
    const request = parsed.request;
    if (this.phase !== 'connected') {
      const errorCode = this.isSessionTerminating() ? 'SessionTerminating' : 'SessionStarting';
      this.sendAutomationRuntimeFailure(msg, errorCode, `session phase ${this.phase} cannot read runtime state`, this.automationTargetState(), startedAt);
      return;
    }
    switch (request.kind) {
      case 'threads':
        await this.handleAutomationThreads(msg, request, startedAt);
        return;
      case 'stackTrace':
        await this.handleAutomationStackTrace(msg, request, startedAt);
        return;
      case 'scopes':
        await this.handleAutomationScopes(msg, request, startedAt);
        return;
      case 'variables':
        await this.handleAutomationVariables(msg, request, startedAt);
        return;
      case 'registers':
        await this.handleAutomationRegisters(msg, request, startedAt);
        return;
    }
  }

  private automationTargetState(): string {
    return this.targetRunning ? 'Running' : 'Halted';
  }

  private sendAutomationRuntimeFailure(
    msg: DebugProtocolMessage,
    errorCode: string,
    message: string,
    targetState: string,
    startedAt: number,
  ): void {
    const result: AutomationRuntimeResult = {
      errorCode,
      message,
      targetState,
      elapsedMs: Date.now() - startedAt,
    };
    this.sendResponse(msg, result, false, `${errorCode}: ${message}`);
  }

  /**
   * Runs one standard DAP read handler through the capture mechanism and
   * returns its first recorded response, so automation runtime reads share the
   * exact handlers (and read gates) of the UI path.
   */
  private async runAutomationRead(
    msg: DebugProtocolMessage,
    command: string,
    args: Record<string, unknown>,
    options: { liveMemoryAccess?: boolean } = {},
  ): Promise<{ body?: any; success: boolean; message?: string }> {
    const synthetic: DebugProtocolMessage = {
      type: 'request',
      seq: msg.seq,
      command,
      arguments: args,
    };
    const capture: AutomationCapture = { synthetic, recorded: false, success: false };
    this.automationCapture = capture;
    try {
      if (command === 'readMemory' && options.liveMemoryAccess === true) {
        await this.handleReadMemory(synthetic, true);
      } else {
        await this.dispatchRequest(synthetic);
      }
    } catch (error) {
      if (!capture.recorded) {
        capture.recorded = true;
        capture.success = false;
        capture.message = error instanceof Error ? error.message : String(error);
      }
    } finally {
      this.automationCapture = null;
    }
    return { body: capture.body, success: capture.success, message: capture.message };
  }

  private async handleAutomationThreads(
    msg: DebugProtocolMessage,
    _request: AutomationRuntimeRequest,
    startedAt: number,
  ): Promise<void> {
    const captured = await this.runAutomationRead(msg, 'threads', {});
    if (!captured.success) {
      this.sendAutomationRuntimeFailure(msg, 'InternalError', captured.message ?? 'threads read failed', this.automationTargetState(), startedAt);
      return;
    }
    const stopped = !this.targetRunning;
    const state = this.targetRunning ? 'running' : 'halted';
    const threads = (captured.body?.threads ?? []).map((thread: any) => ({
      threadId: thread.id,
      name: thread.name,
      state,
      stopped,
    }));
    this.sendResponse(msg, { threads, targetState: this.automationTargetState(), elapsedMs: Date.now() - startedAt });
  }

  private async handleAutomationStackTrace(
    msg: DebugProtocolMessage,
    request: AutomationRuntimeRequest,
    startedAt: number,
  ): Promise<void> {
    if (this.targetRunning) {
      this.sendAutomationRuntimeFailure(msg, 'TargetRunning', 'target is running; halt before reading the call stack', 'Running', startedAt);
      return;
    }
    const captured = await this.runAutomationRead(msg, 'stackTrace', { threadId: request.threadId });
    if (!captured.success) {
      this.sendAutomationRuntimeFailure(msg, this.readFailureCode(captured), captured.message ?? 'stack trace read failed', this.automationTargetState(), startedAt);
      return;
    }
    const stackFrames: AutomationStackFrame[] = (captured.body?.stackFrames ?? []).map((frame: any) => {
      const result: AutomationStackFrame = {
        frameId: frame.id,
        name: frame.name,
        instructionPointerReference: frame.instructionPointerReference ?? '0x0',
      };
      if (typeof frame.source?.path === 'string' && frame.source.path.length > 0 && frame.line > 0) {
        result.source = { path: frame.source.path, line: frame.line };
      }
      return result;
    });
    this.sendResponse(msg, { stackFrames, targetState: this.automationTargetState(), elapsedMs: Date.now() - startedAt });
  }

  private async handleAutomationScopes(
    msg: DebugProtocolMessage,
    request: AutomationRuntimeRequest,
    startedAt: number,
  ): Promise<void> {
    if (this.targetRunning) {
      this.sendAutomationRuntimeFailure(msg, 'TargetRunning', 'target is running; halt before reading scopes', 'Running', startedAt);
      return;
    }
    const captured = await this.runAutomationRead(msg, 'scopes', { frameId: request.frameId });
    if (!captured.success) {
      this.sendAutomationRuntimeFailure(msg, 'InternalError', captured.message ?? 'scopes read failed', this.automationTargetState(), startedAt);
      return;
    }
    const scopes = (captured.body?.scopes ?? []).map((scope: any) => ({
      name: scope.name,
      variablesReference: scope.variablesReference ?? 0,
      expensive: scope.expensive ?? false,
    }));
    this.sendResponse(msg, { scopes, targetState: this.automationTargetState(), elapsedMs: Date.now() - startedAt });
  }

  private async handleAutomationVariables(
    msg: DebugProtocolMessage,
    request: AutomationRuntimeRequest,
    startedAt: number,
  ): Promise<void> {
    if (this.targetRunning) {
      this.sendAutomationRuntimeFailure(msg, 'TargetRunning', 'target is running; halt before reading variables', 'Running', startedAt);
      return;
    }
    const captured = await this.runAutomationRead(msg, 'variables', { variablesReference: request.variablesReference });
    if (!captured.success) {
      this.sendAutomationRuntimeFailure(msg, this.readFailureCode(captured), captured.message ?? 'variables read failed', this.automationTargetState(), startedAt);
      return;
    }
    const variables: AutomationVariable[] = (captured.body?.variables ?? []).map((variable: any) => {
      const result: AutomationVariable = {
        name: variable.name,
        value: variable.value ?? '',
        variablesReference: variable.variablesReference ?? 0,
      };
      if (typeof variable.type === 'string' && variable.type.length > 0) result.type = variable.type;
      if (typeof variable.evaluateName === 'string' && variable.evaluateName.length > 0) result.evaluateName = variable.evaluateName;
      if (typeof variable.memoryReference === 'string' && variable.memoryReference.length > 0) result.memoryReference = variable.memoryReference;
      return result;
    });
    this.sendResponse(msg, { variables, targetState: this.automationTargetState(), elapsedMs: Date.now() - startedAt });
  }

  private async handleAutomationRegisters(
    msg: DebugProtocolMessage,
    request: AutomationRuntimeRequest,
    startedAt: number,
  ): Promise<void> {
    if (this.targetRunning) {
      this.sendAutomationRuntimeFailure(msg, 'TargetRunning', 'target is running; halt before reading registers', 'Running', startedAt);
      return;
    }
    const readEpoch = this.readCancelEpoch;
    if (!(await this.beginTargetReadWhenAvailable('foreground', 1200))) {
      this.sendAutomationRuntimeFailure(msg, 'TargetReadCancelled', 'could not acquire the stopped-target read gate for registers', this.automationTargetState(), startedAt);
      return;
    }
    const controller = new AbortController();
    try {
      if (readEpoch !== this.readCancelEpoch || this.controlInProgress || this.isSessionTerminating()) {
        this.sendAutomationRuntimeFailure(msg, 'TargetReadCancelled', 'registers read was cancelled before dispatch', this.automationTargetState(), startedAt);
        return;
      }
      this.activeStoppedReadAbortController = controller;
      const regResult = await this.backend.execute({ cmd: 'getRegisters', signal: controller.signal });
      const stale = controller.signal.aborted || readEpoch !== this.readCancelEpoch
        || this.controlInProgress || this.isSessionTerminating();
      if (stale) {
        this.sendAutomationRuntimeFailure(msg, 'TargetReadCancelled', 'registers read was cancelled', this.automationTargetState(), startedAt);
        return;
      }
      if (!regResult.ok) {
        this.sendAutomationRuntimeFailure(msg, regResult.errorCode ?? 'TargetReadUnavailable', regResult.error, regResult.targetState ?? this.automationTargetState(), startedAt);
        return;
      }
      const requestedGroups = new Set<string>(request.groups ?? ['core']);
      const registers: AutomationRegister[] = [];
      for (const register of (regResult.data as any[] | undefined) ?? []) {
        // REG_INDEXES only exposes the 32-bit core integer/control registers,
        // so every reported register belongs to the core group in this build.
        const group: AutomationRegister['group'] = 'core';
        if (!requestedGroups.has(group)) continue;
        registers.push({
          name: register.name,
          // `hex` keeps the exact 8-digit value; `memoryReference` reuses the
          // existing formatMemoryReference (no leading-zero padding) so it stays
          // consistent with the standard variables/Registers view.
          value: typeof register.hex === 'string' ? register.hex : `0x${(Number(register.value) >>> 0).toString(16)}`,
          group,
          bits: 32,
          memoryReference: this.formatMemoryReference(register.value),
        });
      }
      this.sendResponse(msg, { registers, targetState: this.automationTargetState(), elapsedMs: Date.now() - startedAt });
    } finally {
      if (this.activeStoppedReadAbortController === controller) {
        this.activeStoppedReadAbortController = null;
      }
      this.endTargetRead();
    }
  }

  private readFailureCode(captured: { message?: string }): string {
    return extractErrorCodePrefix(captured.message ?? '') ?? 'InternalError';
  }

  // --- expression & symbol bridge (plan Task 8) ------------------------------
  // `session.customRequest('orbitExpressionSnapshot', ...)` reuses the standard
  // DAP evaluate/watch-read/setWatchValue cores and the loaded ELF symbol cache
  // so automation expressions and symbol discovery share the exact handlers
  // (and read gates) of the UI path. Reads map `readWatchExpressions` results
  // onto the frozen ExpressionValue shape; writes go through the same
  // `withStepLock` + target-write barrier as `setWatchValue`.

  private async handleAutomationExpression(msg: DebugProtocolMessage) {
    const startedAt = Date.now();
    const parsed = parseAutomationExpressionRequest(msg.arguments);
    if (!parsed.ok) {
      this.sendAutomationExpressionFailure(msg, parsed.errorCode, parsed.message, this.automationTargetState(), startedAt);
      return;
    }
    const request = parsed.request;
    if (this.phase !== 'connected') {
      const errorCode = this.isSessionTerminating() ? 'SessionTerminating' : 'SessionStarting';
      this.sendAutomationExpressionFailure(msg, errorCode, `session phase ${this.phase} cannot evaluate expressions`, this.automationTargetState(), startedAt);
      return;
    }
    switch (request.kind) {
      case 'evaluate':
        await this.handleAutomationEvaluate(msg, request, startedAt);
        return;
      case 'readMany':
        await this.handleAutomationReadMany(msg, request, startedAt);
        return;
      case 'writeMany':
        await this.handleAutomationWriteMany(msg, request, startedAt);
        return;
      case 'inspect':
        await this.handleAutomationInspect(msg, request, startedAt);
        return;
      case 'symbolSearch':
        await this.handleAutomationSymbolSearch(msg, request, startedAt);
        return;
      case 'symbolResolve':
        await this.handleAutomationSymbolResolve(msg, request, startedAt);
        return;
    }
  }

  private sendAutomationExpressionFailure(
    msg: DebugProtocolMessage,
    errorCode: string,
    message: string,
    targetState: string,
    startedAt: number,
  ): void {
    const result: AutomationExpressionResult = {
      errorCode,
      message,
      targetState,
      elapsedMs: Date.now() - startedAt,
    };
    this.sendResponse(msg, result, false, `${errorCode}: ${message}`);
  }

  /** One expression read through the shared stopped/realtime watch-read core. */
  private async handleAutomationEvaluate(
    msg: DebugProtocolMessage,
    request: AutomationExpressionRequest,
    startedAt: number,
  ): Promise<void> {
    const results = await this.readWatchExpressions([request.expression!], false);
    const value = this.mapWatchValueToAutomationRoot(results[0]);
    this.sendResponse(msg, { value, targetState: this.automationTargetState(), elapsedMs: Date.now() - startedAt });
  }

  private async handleAutomationReadMany(
    msg: DebugProtocolMessage,
    request: AutomationExpressionRequest,
    startedAt: number,
  ): Promise<void> {
    const results = await this.readWatchExpressions(request.expressions!, request.forceRealtime ?? false);
    const values = results.map(value => this.mapWatchValueToAutomationValue(value));
    this.sendResponse(msg, { values, targetState: this.automationTargetState(), elapsedMs: Date.now() - startedAt });
  }

  private async handleAutomationWriteMany(
    msg: DebugProtocolMessage,
    request: AutomationExpressionRequest,
    startedAt: number,
  ): Promise<void> {
    const writes: AutomationExpressionWriteOutcome[] = [];
    for (const write of request.writes ?? []) {
      const result = await this.writeWatchValueCore(write.expression, write.value);
      writes.push(result.ok
        ? { expression: write.expression, written: true }
        : {
            expression: write.expression,
            written: false,
            error: { errorCode: result.errorCode ?? 'InternalError', message: result.error },
          });
    }
    this.sendResponse(msg, { writes, targetState: this.automationTargetState(), elapsedMs: Date.now() - startedAt });
  }

  private async handleAutomationInspect(
    msg: DebugProtocolMessage,
    request: AutomationExpressionRequest,
    startedAt: number,
  ): Promise<void> {
    const results = await this.readWatchExpressions([request.expression!], false);
    const rootWatch = results[0];
    const value = this.mapWatchValueToAutomationRoot(rootWatch);
    const inspectItems: AutomationVariable[] = [];
    if (value.available && (request.depth ?? 2) > 0 && rootWatch.children) {
      const maxChildren = request.maxChildren ?? 100;
      for (const child of rootWatch.children.slice(0, maxChildren)) {
        inspectItems.push(this.automationVariableFromWatch(child));
      }
    }
    this.sendResponse(msg, { value, inspectItems, targetState: this.automationTargetState(), elapsedMs: Date.now() - startedAt });
  }

  private async handleAutomationSymbolSearch(
    msg: DebugProtocolMessage,
    request: AutomationExpressionRequest,
    startedAt: number,
  ): Promise<void> {
    const result = await this.backend.execute({ cmd: 'searchSymbols', query: request.query!, maxResults: 2000 });
    if (!result.ok) {
      const errorCode = result.errorCode === 'SymbolsUnavailable' ? 'CapabilityUnavailable' : (result.errorCode ?? 'InternalError');
      this.sendAutomationExpressionFailure(msg, errorCode, result.error, this.automationTargetState(), startedAt);
      return;
    }
    const symbols: AutomationSymbol[] = ((result.data as any[]) ?? []).map((symbol: any) => ({
      name: symbol.name,
      address: symbol.address,
      size: symbol.size ?? 0,
      typeChar: symbol.type ?? '?',
    }));
    this.sendResponse(msg, { symbols, targetState: this.automationTargetState(), elapsedMs: Date.now() - startedAt });
  }

  private async handleAutomationSymbolResolve(
    msg: DebugProtocolMessage,
    request: AutomationExpressionRequest,
    startedAt: number,
  ): Promise<void> {
    const result = request.expression !== undefined
      ? await this.backend.execute({ cmd: 'resolveSymbol', name: request.expression })
      : await this.backend.execute({ cmd: 'resolveSymbol', address: Number.parseInt(request.address!.replace(/^0x/i, ''), 16) });
    if (!result.ok) {
      const errorCode = result.errorCode === 'SymbolsUnavailable'
        ? 'CapabilityUnavailable'
        : result.errorCode === 'SymbolNotFound'
          ? 'InvalidRequest'
          : (result.errorCode ?? 'InternalError');
      this.sendAutomationExpressionFailure(msg, errorCode, result.error, this.automationTargetState(), startedAt);
      return;
    }
    const raw = result.data as any;
    const symbol: AutomationSymbol = {
      name: raw.name,
      address: raw.address,
      size: raw.size ?? 0,
      typeChar: raw.type ?? '?',
      exact: raw.exact ?? false,
    };
    this.sendResponse(msg, {
      symbol,
      exact: raw.exact ?? false,
      targetState: this.automationTargetState(),
      elapsedMs: Date.now() - startedAt,
    });
  }

  // --- byte-oriented memory access (plan Task 9) ----------------------------
  // `read` reuses the standard DAP readMemory handler (base64 byte contract +
  // the same read gate/control-cancel behavior as MemoryView). `write` runs
  // under the step lock + target-write barrier (control work) and optionally
  // verifies by reading back through the same selected owner.

  private async handleAutomationMemory(msg: DebugProtocolMessage) {
    const startedAt = Date.now();
    const parsed = parseAutomationMemoryRequest(msg.arguments);
    if (!parsed.ok) {
      this.sendAutomationMemoryFailure(msg, parsed.errorCode, parsed.message, this.automationTargetState(), startedAt);
      return;
    }
    const request = parsed.request;
    if (this.phase !== 'connected') {
      const errorCode = this.isSessionTerminating() ? 'SessionTerminating' : 'SessionStarting';
      this.sendAutomationMemoryFailure(msg, errorCode, `session phase ${this.phase} cannot access memory`, this.automationTargetState(), startedAt);
      return;
    }
    if (request.kind === 'read') {
      await this.handleAutomationMemoryRead(msg, request, startedAt);
      return;
    }
    await this.handleAutomationMemoryWrite(msg, request, startedAt);
  }

  private sendAutomationMemoryFailure(
    msg: DebugProtocolMessage,
    errorCode: string,
    message: string,
    targetState: string,
    startedAt: number,
  ): void {
    const result: AutomationMemoryResult = {
      errorCode,
      message,
      targetState,
      elapsedMs: Date.now() - startedAt,
    };
    this.sendResponse(msg, result, false, `${errorCode}: ${message}`);
  }

  private parseAutomationAddress(address: string): number {
    return Number.parseInt(address.replace(/^0x/i, ''), 16) >>> 0;
  }

  private async handleAutomationMemoryRead(
    msg: DebugProtocolMessage,
    request: AutomationMemoryRequest,
    startedAt: number,
  ): Promise<void> {
    const address = this.parseAutomationAddress(request.address);
    // Reuse the DAP read gate, but keep the Automation API operation live so
    // the target and Timeline continue running throughout the memory access.
    const captured = await this.runAutomationRead(msg, 'readMemory', {
      memoryReference: request.address,
      count: request.count,
    }, { liveMemoryAccess: true });
    if (!captured.success) {
      const code = this.memoryReadFailureCode(captured);
      this.sendAutomationMemoryFailure(msg, code, captured.message ?? 'memory read failed', this.automationTargetState(), startedAt);
      return;
    }
    const body = (captured.body ?? {}) as { data?: string; unreadableBytes?: number };
    const dataBase64 = typeof body.data === 'string' ? body.data : '';
    const bytesRead = dataBase64.length > 0 ? Buffer.from(dataBase64, 'base64').length : 0;
    this.sendResponse(msg, {
      address: this.formatMemoryReference(address),
      requestedBytes: request.count ?? 0,
      bytesRead,
      unreadableBytes: typeof body.unreadableBytes === 'number'
        ? body.unreadableBytes
        : Math.max(0, (request.count ?? 0) - bytesRead),
      data: dataBase64,
      targetState: this.automationTargetState(),
      elapsedMs: Date.now() - startedAt,
    });
  }

  private memoryReadFailureCode(captured: { body?: any; message?: string }): string {
    const code = typeof captured.body?.errorCode === 'string' ? captured.body.errorCode : '';
    if (code === 'TargetReadCancelled' || code === 'TargetReadUnavailable') return 'TargetReadCancelled';
    if (code === 'MemoryReadFailed' || code === 'MalformedResponse') return 'MemoryReadFailed';
    // The readMemory handler replies 'Target is running' when the read gate is
    // not acquired (control in progress); surface the frozen retryable code.
    if (!code && /target is running/i.test(captured.message ?? '')) return 'TargetReadCancelled';
    return code || 'InternalError';
  }

  private async handleAutomationMemoryWrite(
    msg: DebugProtocolMessage,
    request: AutomationMemoryRequest,
    startedAt: number,
  ): Promise<void> {
    const address = this.parseAutomationAddress(request.address);
    let data: number[];
    try {
      data = Array.from(Buffer.from(request.data ?? '', 'base64'));
    } catch {
      this.sendAutomationMemoryFailure(msg, 'InvalidRequest', 'invalid base64 memory payload', this.automationTargetState(), startedAt);
      return;
    }
    if (data.length === 0) {
      this.sendAutomationMemoryFailure(msg, 'InvalidRequest', 'memory write data decodes to zero bytes', this.automationTargetState(), startedAt);
      return;
    }

    const outcome = await this.withStepLock(async () => {
      if (!(await this.beginTargetWrite())) {
        return { ok: false as const, errorCode: 'TargetBusy', error: 'Target busy' };
      }
      try {
        this.flushDataSampling();
        const writeResult = await this.backend.execute({ cmd: 'writeMemory', address, data, liveAccess: true });
        if (!writeResult.ok) {
          return { ok: false as const, errorCode: writeResult.errorCode ?? 'MemoryWriteFailed', error: writeResult.error };
        }
        if (request.verify === false) {
          return { ok: true as const, bytesWritten: data.length, verified: false };
        }
        const readResult = await this.backend.execute({ cmd: 'readMemory', address, size: data.length, liveAccess: true });
        if (!readResult.ok) {
          return {
            ok: false as const,
            errorCode: 'MemoryWriteFailed',
            error: `verify read failed: ${readResult.errorCode ?? 'MemoryReadFailed'}: ${readResult.error}`,
          };
        }
        const block = readResult.data as MemoryBlock;
        const readBack = Array.from(block.data ?? []);
        const verified = readBack.length === data.length && readBack.every((byte, index) => byte === data[index]);
        return {
          ok: true as const,
          bytesWritten: data.length,
          verified,
          verifyData: Buffer.from(readBack).toString('base64'),
        };
      } finally {
        this.endTargetWrite();
      }
    });

    if (!outcome.ok) {
      this.sendAutomationMemoryFailure(msg, outcome.errorCode, outcome.error, this.automationTargetState(), startedAt);
      return;
    }
    this.sendResponse(msg, {
      address: this.formatMemoryReference(address),
      bytesWritten: outcome.bytesWritten,
      verified: outcome.verified,
      ...(outcome.verifyData !== undefined ? { data: outcome.verifyData } : {}),
      targetState: this.automationTargetState(),
      elapsedMs: Date.now() - startedAt,
    });
  }

  // --- RTT snapshot bridge (plan Task 11) ------------------------------------
  // `session.customRequest('orbitRttSnapshot', ...)` drives status/start/stop/
  // read through the selected session owner. RTT remains a distinct logical
  // consumer from the UI RTT Log and Timeline; reads run at background priority
  // and are paused for a control request's critical section by the scheduler.

  private async handleAutomationRtt(msg: DebugProtocolMessage) {
    const startedAt = Date.now();
    const parsed = parseAutomationRttRequest(msg.arguments);
    if (!parsed.ok) {
      this.sendAutomationRttFailure(msg, parsed.errorCode, parsed.message, startedAt);
      return;
    }
    const request = parsed.request;
    if (this.phase !== 'connected') {
      const errorCode = this.isSessionTerminating() ? 'SessionTerminating' : 'SessionStarting';
      this.sendAutomationRttFailure(msg, errorCode, `session phase ${this.phase} cannot drive RTT`, startedAt);
      return;
    }
    switch (request.kind) {
      case 'status':
        await this.handleAutomationRttStatus(msg, request, startedAt);
        return;
      case 'start':
        await this.handleAutomationRttStart(msg, request, startedAt);
        return;
      case 'stop':
        await this.handleAutomationRttStop(msg, request, startedAt);
        return;
      case 'read':
        await this.handleAutomationRttRead(msg, request, startedAt);
        return;
    }
  }

  private sendAutomationRttFailure(
    msg: DebugProtocolMessage,
    errorCode: string,
    message: string,
    startedAt: number,
  ): void {
    const result: AutomationRttResult = {
      errorCode,
      message,
      targetState: this.automationTargetState(),
      elapsedMs: Date.now() - startedAt,
    };
    this.sendResponse(msg, result, false, `${errorCode}: ${message}`);
  }

  private async automationRttOwnerKind(): Promise<AutomationRttSnapshot['owner']> {
    return this.currentOwnerKind();
  }

  private automationRttState(): AutomationRttSnapshot['state'] {
    if (!this.rttAvailable) return 'unavailable';
    return this.automationRttStarted ? 'running' : 'stopped';
  }

  /** Resolves `_SEGGER_RTT` on demand when the launch did not (RTT Log disabled). */
  private async ensureRttControlBlockAddress(): Promise<boolean> {
    if (this.rttControlBlockAddress !== undefined) return true;
    const symbolResult = await this.backend.execute({ cmd: 'resolveSymbol', name: '_SEGGER_RTT' });
    const address = symbolResult.ok && Number.isInteger((symbolResult.data as any)?.address)
      ? Number((symbolResult.data as any).address)
      : undefined;
    if (address === undefined || address <= 0 || address > 0xFFFFFFFF) return false;
    this.rttControlBlockAddress = address;
    this.rttControlBlockSource = 'elf-symbol';
    log.dap(`[rtt] control block address=0x${address.toString(16)} source=elf-symbol (automation)`);
    return true;
  }

  private async buildAutomationRttSnapshot(
    bufferIndex: number,
  ): Promise<AutomationRttSnapshot> {
    return {
      state: this.automationRttState(),
      owner: await this.automationRttOwnerKind(),
      bufferIndex,
      pollIntervalMs: this.automationRttPollIntervalMs,
      ...(this.automationRttTargetName !== undefined ? { targetName: this.automationRttTargetName } : {}),
      ansi: this.automationRttAnsi,
      bytesAvailable: 0,
      droppedBytes: 0,
    };
  }

  private async handleAutomationRttStatus(
    msg: DebugProtocolMessage,
    request: AutomationRttRequest,
    startedAt: number,
  ): Promise<void> {
    const snapshot = await this.buildAutomationRttSnapshot(request.bufferIndex ?? this.automationRttBufferIndex);
    this.sendResponse(msg, { snapshot, targetState: this.automationTargetState(), elapsedMs: Date.now() - startedAt });
  }

  private async handleAutomationRttStart(
    msg: DebugProtocolMessage,
    request: AutomationRttRequest,
    startedAt: number,
  ): Promise<void> {
    if (!this.rttAvailable) {
      this.sendAutomationRttFailure(msg, 'CapabilityUnavailable', 'RTT is unavailable (no control block resolved)', startedAt);
      return;
    }
    // The launch only resolves `_SEGGER_RTT` when the RTT Log is enabled; an
    // automation start must resolve it on demand so `startRtt` never receives
    // an undefined control-block address.
    if (this.rttControlBlockAddress === undefined && !(await this.ensureRttControlBlockAddress())) {
      this.sendAutomationRttFailure(msg, 'CapabilityUnavailable', 'RTT control block could not be resolved', startedAt);
      return;
    }
    const bufferIndex = request.bufferIndex ?? this.automationRttBufferIndex;
    this.automationRttBufferIndex = bufferIndex;
    this.automationRttPollIntervalMs = request.pollIntervalMs ?? this.automationRttPollIntervalMs;
    this.automationRttAnsi = request.ansi ?? this.automationRttAnsi;
    if (request.targetName !== undefined) this.automationRttTargetName = request.targetName;
    const result = await this.backend.execute({ cmd: 'startRtt', controlBlockAddress: this.rttControlBlockAddress });
    if (!result.ok) {
      this.sendAutomationRttFailure(msg, result.errorCode ?? 'InternalError', result.error, startedAt);
      return;
    }
    this.automationRttStarted = true;
    const snapshot = await this.buildAutomationRttSnapshot(bufferIndex);
    this.sendResponse(msg, { snapshot, targetState: this.automationTargetState(), elapsedMs: Date.now() - startedAt });
  }

  private async handleAutomationRttStop(
    msg: DebugProtocolMessage,
    request: AutomationRttRequest,
    startedAt: number,
  ): Promise<void> {
    const bufferIndex = request.bufferIndex ?? this.automationRttBufferIndex;
    const result = await this.backend.execute({ cmd: 'stopRtt' });
    this.automationRttStarted = false;
    if (!result.ok) {
      this.sendAutomationRttFailure(msg, result.errorCode ?? 'InternalError', result.error, startedAt);
      return;
    }
    const snapshot = await this.buildAutomationRttSnapshot(bufferIndex);
    this.sendResponse(msg, { snapshot, targetState: this.automationTargetState(), elapsedMs: Date.now() - startedAt });
  }

  private async handleAutomationRttRead(
    msg: DebugProtocolMessage,
    request: AutomationRttRequest,
    startedAt: number,
  ): Promise<void> {
    if (!this.rttAvailable) {
      this.sendAutomationRttFailure(msg, 'CapabilityUnavailable', 'RTT is unavailable (no control block resolved)', startedAt);
      return;
    }
    const bufferIndex = request.bufferIndex ?? this.automationRttBufferIndex;
    const size = Math.max(1, Math.min(request.maxBytes ?? this.rttReadSize, 1048576));
    const result = await this.backend.execute({
      cmd: 'readRtt',
      bufferIndex,
      size,
      signal: undefined,
    });
    if (!result.ok) {
      this.sendAutomationRttFailure(msg, result.errorCode ?? 'InternalError', result.error, startedAt);
      return;
    }
    const bytes = (result.data as any)?.bytes;
    const buffer = Array.isArray(bytes)
      ? Buffer.from(bytes)
      : bytes instanceof Uint8Array
        ? Buffer.from(bytes)
        : Buffer.alloc(0);
    const snapshot = await this.buildAutomationRttSnapshot(bufferIndex);
    this.sendResponse(msg, {
      snapshot,
      data: buffer.toString('base64'),
      bytesRead: buffer.length,
      targetState: this.automationTargetState(),
      elapsedMs: Date.now() - startedAt,
    });
  }

  // --- RTT log snapshot bridge (plan Task 11 extension) ----------------------
  // `session.customRequest('orbitRttLogSnapshot', ...)` returns the decoded
  // terminal log lines the RTT Log path already produces. It carries only the
  // line text and its producing decoder kind; the Extension Host strips ANSI.

  private handleAutomationRttLog(msg: DebugProtocolMessage) {
    const startedAt = Date.now();
    const parsed = parseAutomationRttLogRequest(msg.arguments);
    if (!parsed.ok) {
      this.sendAutomationRttLogFailure(msg, parsed.errorCode, parsed.message, startedAt);
      return;
    }
    const request = parsed.request;
    if (this.phase !== 'connected') {
      const errorCode = this.isSessionTerminating() ? 'SessionTerminating' : 'SessionStarting';
      this.sendAutomationRttLogFailure(msg, errorCode, `session phase ${this.phase} cannot read the RTT log`, startedAt);
      return;
    }
    const entries = this.rttLogEntries;
    let window: AutomationRttLogEntry[];
    if (request.cursor !== undefined) {
      const cursorNum = Number(request.cursor);
      const after = entries.filter(entry => Number(entry.id) > cursorNum);
      if (after.length === 0 && entries.length > 0) {
        // No new lines: an evicted cursor predating the ring resets to the tail.
        const oldest = Number(entries[0].id);
        window = cursorNum < oldest ? entries.slice(-request.count) : [];
      } else {
        window = after.slice(0, request.count);
      }
    } else {
      window = entries.slice(-request.count);
    }
    const result: AutomationRttLogResult = {
      entries: window,
      retained: entries.length,
      nextCursor: window.length > 0 ? window[window.length - 1].id : null,
      targetState: this.automationTargetState(),
      elapsedMs: Date.now() - startedAt,
    };
    this.sendResponse(msg, result);
  }

  private sendAutomationRttLogFailure(
    msg: DebugProtocolMessage,
    errorCode: string,
    message: string,
    startedAt: number,
  ): void {
    const result: AutomationRttLogResult = {
      entries: [],
      retained: 0,
      errorCode,
      message,
      targetState: this.automationTargetState(),
      elapsedMs: Date.now() - startedAt,
    };
    this.sendResponse(msg, result, false, `${errorCode}: ${message}`);
  }

  // --- diagnostics snapshot bridge (plan Task 11) ----------------------------
  // `session.customRequest('orbitDiagnosticsSnapshot', ...)` returns only
  // counts, states, elapsed times and error codes. No token, Authorization,
  // raw memory data or user variable values are ever included.

  private async handleAutomationDiagnostics(msg: DebugProtocolMessage) {
    const startedAt = Date.now();
    const parsed = parseAutomationDiagnosticsRequest(msg.arguments);
    if (!parsed.ok) {
      const result: AutomationDiagnosticsResult = {
        phase: this.phase,
        targetState: this.automationTargetState(),
        ownerKind: 'unknown',
        connected: false,
        pendingRequests: 0,
        scheduler: normalizeSchedulerSnapshot(undefined),
        errorCode: parsed.errorCode,
        message: parsed.message,
        elapsedMs: Date.now() - startedAt,
      };
      this.sendResponse(msg, result, false, `${parsed.errorCode}: ${parsed.message}`);
      return;
    }
    let scheduler = normalizeSchedulerSnapshot(undefined);
    let ownerKind = 'unknown';
    let transport: string | undefined;
    let connected = false;
    try {
      const perf = await this.backend.execute({ cmd: 'getPerformanceDiagnostics' });
      if (perf.ok && perf.data && typeof perf.data === 'object') {
        const owner = String((perf.data as { owner?: unknown }).owner ?? '');
        if (owner.includes('cmsis-dap')) ownerKind = 'cmsis-dap';
        else if (owner.includes('jlink-native')) ownerKind = 'jlink-native';
        else if (owner.includes('legacy')) ownerKind = 'jlink-legacy';
      }
    } catch {
      // Best-effort owner reporting; the probe remains the fallback authority.
    }
    try {
      const sched = await this.backend.execute({ cmd: 'getSchedulerSnapshot' });
      if (sched.ok) scheduler = normalizeSchedulerSnapshot(sched.data);
    } catch {
      // Scheduler snapshot is best-effort; zero counts remain the fallback.
    }
    if (ownerKind === 'unknown') {
      ownerKind = this._probe === 'cmsis-dap' ? 'cmsis-dap' : 'jlink-legacy';
    }
    if (ownerKind === 'cmsis-dap') transport = 'winusb';
    else if (ownerKind === 'jlink-native') transport = 'native';
    else if (ownerKind === 'jlink-legacy') transport = 'legacy';
    connected = this.phase === 'connected';
    this.sendResponse(msg, {
      sessionGeneration: parsed.request.sessionGeneration,
      phase: this.phase,
      targetState: this.automationTargetState(),
      ownerKind,
      ...(transport !== undefined ? { transport } : {}),
      connected,
      pendingRequests: 0,
      scheduler,
      elapsedMs: Date.now() - startedAt,
    });
  }

  /** Maps a shared watch-read value onto the frozen ExpressionValue shape. */
  private mapWatchValueToAutomationValue(watch: WatchValue): AutomationExpressionValue {
    if (watch.error && watch.error !== 'running') {
      return {
        expression: watch.expression,
        value: watch.display || watch.hex || String(watch.value),
        variablesReference: 0,
        available: false,
        stale: false,
        error: { errorCode: watch.errorCode ?? 'InternalError', message: watch.error },
      };
    }
    if (watch.error === 'running') {
      return {
        expression: watch.expression,
        value: '',
        variablesReference: 0,
        available: false,
        stale: true,
        error: { errorCode: 'TargetRunning', message: 'target is running' },
      };
    }
    return {
      expression: watch.expression,
      value: watch.display || watch.hex || String(watch.value),
      type: watch.typeName,
      variablesReference: 0,
      memoryReference: this.memoryReferenceForWatch(watch),
      available: true,
      stale: false,
    };
  }

  /** As above, but allocates a DAP variablesReference for expandable values. */
  private mapWatchValueToAutomationRoot(watch: WatchValue): AutomationExpressionValue {
    const mapped = this.mapWatchValueToAutomationValue(watch);
    if (mapped.available) mapped.variablesReference = this.allocateVariableHandle(watch);
    return mapped;
  }

  /** Maps an already-expanded child onto the frozen Variable shape. */
  private automationVariableFromWatch(watch: WatchValue): AutomationVariable {
    const dap = this.toDapVariable(watch);
    const result: AutomationVariable = {
      name: dap.name,
      value: dap.value,
      variablesReference: dap.variablesReference,
    };
    if (dap.type !== undefined) result.type = dap.type;
    if (dap.evaluateName !== undefined) result.evaluateName = dap.evaluateName;
    if (dap.memoryReference !== undefined) result.memoryReference = dap.memoryReference;
    return result;
  }

  private async handleAutomationControl(msg: DebugProtocolMessage) {
    const startedAt = Date.now();
    const parsed = parseAutomationControlRequest(msg.arguments);
    if (!parsed.ok) {
      const result: AutomationControlResult = {
        state: 'unknown',
        errorCode: parsed.errorCode,
        message: parsed.message,
      };
      this.sendResponse(msg, result, false, `${parsed.errorCode}: ${parsed.message}`);
      this.sendAutomationEvent({
        action: typeof msg.arguments?.action === 'string' ? msg.arguments.action : 'unknown',
        ok: false,
        state: 'unknown',
        errorCode: parsed.errorCode,
        elapsedMs: Date.now() - startedAt,
      });
      return;
    }
    const request = parsed.request;
    const eventBase = {
      action: request.action,
      sessionGeneration: request.sessionGeneration,
      elapsedMs: Date.now() - startedAt,
    };
    if (this.automationCapture) {
      const result: AutomationControlResult = {
        state: 'unknown',
        errorCode: 'TargetBusy',
        message: 'another automation control is in progress',
      };
      this.sendResponse(msg, result, false, 'TargetBusy: another automation control is in progress');
      this.sendAutomationEvent({ ...eventBase, ok: false, state: 'unknown', errorCode: 'TargetBusy' });
      return;
    }
    if (this.phase !== 'connected') {
      const errorCode = this.isSessionTerminating() ? 'SessionTerminating' : 'SessionStarting';
      const result: AutomationControlResult = {
        state: 'unknown',
        errorCode,
        message: `session phase ${this.phase} cannot run automation control`,
      };
      this.sendResponse(msg, result, false, `${errorCode}: session phase ${this.phase} cannot run automation control`);
      this.sendAutomationEvent({ ...eventBase, ok: false, state: 'unknown', errorCode });
      return;
    }

    const standard = standardCommandForAction(request);
    if (standard === null) {
      // reset / flash have dedicated automation cores; instruction-granularity
      // stepOut has no selected-owner capability (no standard mapping either).
      if (request.action === 'reset') {
        await this.handleAutomationReset(msg, request, startedAt);
        return;
      }
      if (request.action === 'flash') {
        await this.handleAutomationFlash(msg, request, startedAt);
        return;
      }
      const result: AutomationControlResult = {
        state: 'unknown',
        errorCode: 'CapabilityUnavailable',
        message: `${request.action} is not available on the selected owner`,
      };
      this.sendResponse(msg, result, false, `CapabilityUnavailable: ${request.action} is not available on the selected owner`);
      this.sendAutomationEvent({ ...eventBase, ok: false, state: 'unknown', errorCode: 'CapabilityUnavailable' });
      return;
    }

    // The synthetic standard request exercises exactly the same dispatch
    // cases as a UI request; `sendResponse` records the handler's first
    // response instead of emitting it.
    const synthetic: DebugProtocolMessage = {
      type: 'request',
      seq: msg.seq,
      command: standard.command,
      arguments: standard.arguments,
    };
    const capture: AutomationCapture = { synthetic, recorded: false, success: false };
    this.automationCapture = capture;
    try {
      await this.dispatchRequest(synthetic);
    } catch (error) {
      if (!capture.recorded) {
        capture.recorded = true;
        capture.success = false;
        capture.message = error instanceof Error ? error.message : String(error);
      }
    } finally {
      this.automationCapture = null;
    }
    await this.completeAutomation(msg, request, capture, startedAt);
  }

  private async handleAutomationReset(
    msg: DebugProtocolMessage,
    request: AutomationControlRequest,
    startedAt: number,
  ): Promise<void> {
    const mode = request.mode ?? 'halt';
    const capture: AutomationCapture = { synthetic: msg, recorded: false, success: false };
    await this.withStepLock(async () => {
      this.beginControl();
      this.stopPolling();
      this.setTargetRunning(false);
      try {
        const resetResult = await this.backend.execute({ cmd: 'reset' });
        if (!resetResult.ok) {
          this.recordAutomationFailure(capture, this.failureBodyFromResult(resetResult), resetResult.error);
          return;
        }
        if (mode === 'run') {
          const runResult = await this.backend.execute({ cmd: 'run' });
          if (!runResult.ok) {
            this.recordAutomationFailure(capture, this.failureBodyFromResult(runResult), runResult.error);
            return;
          }
          if (this._probe === 'cmsis-dap') {
            const stateResult = await this.queryTargetState('automation-reset-run-confirm');
            if (!stateResult.ok || stateResult.data !== TargetState.Running) {
              this.recordAutomationFailure(capture, this.stateConfirmFailureBody('reset-run', stateResult), stateResult.ok
                ? `TargetStateInvalid: reset-run returned ${stateResult.data}`
                : stateResult.error);
              return;
            }
          }
          this.setTargetRunning(true);
          this.advanceReadCancelEpoch();
          this.lastHaltReason = 'entry';
          this.recordAutomationSuccess(capture);
          this.sendEvent('continued', { threadId: 1, allThreadsContinued: true });
          this.startPolling();
          return;
        }
        const haltResult = await this.backend.execute({ cmd: 'halt' });
        if (!haltResult.ok) {
          this.recordAutomationFailure(capture, this.failureBodyFromResult(haltResult), haltResult.error);
          return;
        }
        if (this._probe === 'cmsis-dap') {
          const stateResult = await this.queryTargetState('automation-reset-halt-confirm');
          if (!stateResult.ok || stateResult.data !== TargetState.Halted) {
            this.recordAutomationFailure(capture, this.stateConfirmFailureBody('reset-halt', stateResult), stateResult.ok
              ? `TargetStateInvalid: reset-halt returned ${stateResult.data}`
              : stateResult.error);
            return;
          }
        }
        this.markStoppedForUi();
        this.lastHaltReason = 'entry';
        this.recordAutomationSuccess(capture);
        this.sendEvent('stopped', { reason: 'entry', threadId: 1 });
      } finally {
        this.endControl();
      }
    });
    await this.completeAutomation(msg, request, capture, startedAt);
  }

  private async handleAutomationFlash(
    msg: DebugProtocolMessage,
    request: AutomationControlRequest,
    startedAt: number,
  ): Promise<void> {
    const elfPath = request.elfPath!;
    const resetAfter = request.resetAfter ?? 'halt';
    const capture: AutomationCapture = { synthetic: msg, recorded: false, success: false };
    let flashReport: AutomationFlashReport | undefined;
    await this.withStepLock(async () => {
      this.beginControl();
      // Mirror handleRestart: a re-flash invalidates the RTT control-block
      // state, so background RTT polling is paused for the whole critical
      // section and restored afterwards.
      this.stopRttLogPolling();
      this.stopPolling();
      this.setTargetRunning(false);
      try {
        if (this._probe === 'cmsis-dap') {
          const haltResult = await this.backend.execute({ cmd: 'halt' });
          if (!haltResult.ok) {
            this.recordAutomationFailure(capture, this.failureBodyFromResult(haltResult), haltResult.error);
            return;
          }
          const stateResult = await this.queryTargetState('automation-flash-halt-confirm');
          if (!stateResult.ok || stateResult.data !== TargetState.Halted) {
            this.recordAutomationFailure(capture, this.stateConfirmFailureBody('flash-pre-halt', stateResult), stateResult.ok
              ? `TargetStateInvalid: flash pre-halt returned ${stateResult.data}`
              : stateResult.error);
            return;
          }
        }
        this.sendEvent('output', { category: 'console', output: `Automation flash: ${elfPath}...\n` });
        // The flash executes only through the session's selected owner; the
        // explicit action always programs (never the launch skip path). The
        // per-request timeout aborts the owner operation, and `verify: false`
        // is honored by owners that can skip verification (CMSIS-DAP); owners
        // that always verify (J-Link) still do, and the report reflects that.
        const flashTimeoutMs = request.timeoutMs ?? 180000;
        const flashController = new AbortController();
        const flashTimer = setTimeout(
          () => flashController.abort(`automation flash timed out after ${flashTimeoutMs}ms`),
          flashTimeoutMs,
        );
        let flashResult: OzoneCommandResult = { ok: false, error: 'automation flash produced no result' };
        try {
          flashResult = await this.backend.execute({
            cmd: 'flash',
            elfPath,
            device: this._device,
            interface: this._interface as 'SWD' | 'JTAG',
            speedKHz: this._speedKHz,
            probe: this._probe,
            flashBeforeDebug: true,
            verify: request.verify ?? true,
            signal: flashController.signal,
            ...(this._cmsisDapFlashAlgorithmPath
              ? { cmsisDapFlashAlgorithmPath: this._cmsisDapFlashAlgorithmPath }
              : {}),
          });
        } finally {
          clearTimeout(flashTimer);
        }
        if (!flashResult.ok) {
          this.sendEvent('output', { category: 'stderr', output: `Automation flash failed: ${flashResult.error}\n` });
          if (this._probe === 'cmsis-dap') {
            // Reconcile the post-failure target state exactly like
            // handleRestart: a halt re-syncs the UI and a running target
            // resumes polling instead of leaving the session stuck "halted".
            const stateResult = await this.queryTargetState('automation-flash-failure-recovery');
            const failure: OzoneCommandResult = stateResult.ok
              ? {
                  ...flashResult,
                  targetState: stateResult.data === TargetState.Halted
                    ? 'halted'
                    : stateResult.data === TargetState.Running
                      ? 'running'
                      : String(stateResult.data),
                }
              : flashResult;
            this.recordAutomationFailure(capture, this.failureBodyFromResult(failure), failure.error);
            if (stateResult.ok && stateResult.data === TargetState.Halted) {
              this.markStoppedForUi();
              this.lastHaltReason = 'pause';
              if (this.rttLogEnabled) this.startRttLogPolling();
              this.sendEvent('stopped', { reason: 'pause', threadId: 1 });
            } else if (stateResult.ok && stateResult.data === TargetState.Running) {
              this.setTargetRunning(true);
              this.startPolling();
            }
          } else {
            this.recordAutomationFailure(capture, this.failureBodyFromResult(flashResult), flashResult.error);
          }
          return;
        }
        this.sendEvent('output', { category: 'console', output: 'Automation flash: flash successful\n' });
        flashReport = await this.buildFlashReport(elfPath, flashResult.data, request, startedAt);

        if (resetAfter === 'none') {
          const stateResult = await this.queryTargetState('automation-flash-state');
          if (stateResult.ok && stateResult.data === TargetState.Halted) {
            this.markStoppedForUi();
            this.lastHaltReason = 'entry';
            if (this.rttLogEnabled) this.startRttLogPolling({ retryInvalidControlBlock: true });
            this.recordAutomationSuccess(capture);
            this.sendEvent('stopped', { reason: 'entry', threadId: 1 });
          } else if (stateResult.ok && stateResult.data === TargetState.Running) {
            this.setTargetRunning(true);
            this.advanceReadCancelEpoch();
            if (this.rttLogEnabled) this.startRttLogPolling({ retryInvalidControlBlock: true });
            this.recordAutomationSuccess(capture);
            this.sendEvent('continued', { threadId: 1, allThreadsContinued: true });
            this.startPolling();
          } else {
            this.recordAutomationFailure(capture, this.failureBodyFromResult(stateResult), stateResult.ok
              ? `TargetStateInvalid: flash state ${stateResult.data}`
              : stateResult.error);
          }
          return;
        }

        const resetResult = await this.backend.execute({ cmd: 'reset' });
        if (!resetResult.ok) {
          this.recordAutomationFailure(capture, this.failureBodyFromResult(resetResult), resetResult.error);
          return;
        }
        if (resetAfter === 'run') {
          const runResult = await this.backend.execute({ cmd: 'run' });
          if (!runResult.ok) {
            this.recordAutomationFailure(capture, this.failureBodyFromResult(runResult), runResult.error);
            return;
          }
          if (this._probe === 'cmsis-dap') {
            const stateResult = await this.queryTargetState('automation-flash-run-confirm');
            if (!stateResult.ok || stateResult.data !== TargetState.Running) {
              this.recordAutomationFailure(capture, this.stateConfirmFailureBody('flash-run', stateResult), stateResult.ok
                ? `TargetStateInvalid: flash-run returned ${stateResult.data}`
                : stateResult.error);
              return;
            }
          }
          this.setTargetRunning(true);
          this.advanceReadCancelEpoch();
          if (this.rttLogEnabled) this.startRttLogPolling({ retryInvalidControlBlock: true });
          this.recordAutomationSuccess(capture);
          this.sendEvent('continued', { threadId: 1, allThreadsContinued: true });
          this.startPolling();
          return;
        }
        const haltResult = await this.backend.execute({ cmd: 'halt' });
        if (!haltResult.ok) {
          this.recordAutomationFailure(capture, this.failureBodyFromResult(haltResult), haltResult.error);
          return;
        }
        if (this._probe === 'cmsis-dap') {
          const stateResult = await this.queryTargetState('automation-flash-halt-confirm');
          if (!stateResult.ok || stateResult.data !== TargetState.Halted) {
            this.recordAutomationFailure(capture, this.stateConfirmFailureBody('flash-halt', stateResult), stateResult.ok
              ? `TargetStateInvalid: flash-halt returned ${stateResult.data}`
              : stateResult.error);
            return;
          }
        }
        await new Promise<void>(r => setTimeout(r, 200));
        this.markStoppedForUi();
        this.lastHaltReason = 'entry';
        if (this.rttLogEnabled) this.startRttLogPolling({ retryInvalidControlBlock: true });
        this.recordAutomationSuccess(capture);
        this.sendEvent('stopped', { reason: 'entry', threadId: 1 });
      } finally {
        this.endControl();
      }
    });
    await this.completeAutomation(msg, request, capture, startedAt, flashReport ? { flash: flashReport } : undefined);
  }

  private recordAutomationSuccess(capture: AutomationCapture, body?: any) {
    if (capture.recorded) return;
    capture.recorded = true;
    capture.success = true;
    capture.body = body;
  }

  private recordAutomationFailure(capture: AutomationCapture, body: any, message?: string) {
    if (capture.recorded) return;
    capture.recorded = true;
    capture.success = false;
    capture.body = body;
    capture.message = message;
  }

  private failureBodyFromResult(result: OzoneCommandResult): Record<string, unknown> {
    if (!('error' in result) || !result.error) {
      return { message: 'target control failed' };
    }
    const body: Record<string, unknown> = { message: result.error };
    if (result.errorCode) body.errorCode = result.errorCode;
    if (result.targetState) body.targetState = result.targetState;
    if (result.diagnostics) body.diagnostics = result.diagnostics;
    return body;
  }

  private stateConfirmFailureBody(operation: string, result: OzoneCommandResult): Record<string, unknown> {
    return {
      errorCode: 'TargetStateInvalid',
      message: `TargetStateInvalid: ${operation} returned ${result.ok ? result.data : result.error}`,
    };
  }

  /**
   * Maps a DAP handler failure onto a frozen automation error code. A
   * structured `body.errorCode` always wins; otherwise known DAP messages
   * (e.g. the step-lock "Target busy") map to their frozen code before
   * falling back to a leading `Code:` prefix or InternalError.
   */
  private normalizeAutomationErrorCode(body: Record<string, unknown>, message: string): string {
    if (typeof body.errorCode === 'string' && body.errorCode.length > 0) return body.errorCode;
    if (/target busy/i.test(message)) return 'TargetBusy';
    return extractErrorCodePrefix(message) ?? 'InternalError';
  }

  private async completeAutomation(
    msg: DebugProtocolMessage,
    request: AutomationControlRequest,
    capture: AutomationCapture,
    startedAt: number,
    extra?: { flash?: AutomationFlashReport },
  ): Promise<void> {
    const elapsedMs = Date.now() - startedAt;
    const eventBase = {
      action: request.action,
      sessionGeneration: request.sessionGeneration,
      elapsedMs,
    };
    if (!capture.recorded) {
      capture.recorded = true;
      capture.success = false;
      capture.message = 'control handler produced no response';
    }
    if (capture.success) {
      // The handler completed; the target state the core settled in drives
      // the outcome (halted stop reasons come from the same lastHaltReason
      // the UI events used).
      const state: AutomationControlResult['state'] = this.targetRunning ? 'running' : 'halted';
      const stopReason = state === 'halted' ? this.lastHaltReason : undefined;
      const pc = state === 'halted' ? await this.readCurrentPc() : undefined;
      const result: AutomationControlResult = {
        state,
        ...(stopReason ? { stopReason } : {}),
        ...(pc ? { pc } : {}),
        diagnostics: { action: request.action, elapsedMs, sessionGeneration: request.sessionGeneration },
        ...(extra?.flash ? { flash: extra.flash } : {}),
      };
      this.sendResponse(msg, result);
      this.sendAutomationEvent({
        ...eventBase,
        ok: true,
        state,
        ...(stopReason ? { stopReason } : {}),
        ...(pc ? { pc } : {}),
        ...(extra?.flash ? {
          flash: {
            elfPath: extra.flash.elfPath,
            owner: extra.flash.owner,
            bytesProgrammed: extra.flash.bytesProgrammed,
            verified: extra.flash.verified,
            segments: extra.flash.segments,
          },
        } : {}),
      });
      return;
    }

    const body = capture.body && typeof capture.body === 'object' ? capture.body : {};
    const fallbackMessage = capture.message ?? 'automation control failed';
    const errorCode = this.normalizeAutomationErrorCode(body, fallbackMessage);
    const failureMessage = typeof body.message === 'string' && body.message.length > 0
      ? body.message
      : fallbackMessage;
    const result: AutomationControlResult = {
      state: 'unknown',
      errorCode,
      message: failureMessage,
      ...(typeof body.targetState === 'string' ? { targetState: body.targetState } : {}),
      diagnostics: {
        action: request.action,
        elapsedMs,
        sessionGeneration: request.sessionGeneration,
        ...(body.diagnostics && typeof body.diagnostics === 'object' ? body.diagnostics : {}),
      },
    };
    const responseMessage = failureMessage.startsWith(`${errorCode}:`) || failureMessage === errorCode
      ? failureMessage
      : `${errorCode}: ${failureMessage}`;
    this.sendResponse(msg, result, false, responseMessage);
    this.sendAutomationEvent({
      ...eventBase,
      ok: false,
      state: 'unknown',
      errorCode,
    });
  }

  private sendAutomationEvent(payload: Record<string, unknown>) {
    // Sanitized event for the Extension Host: states, counts, error codes and
    // elapsed times only — no diagnostics details, memory or variable values.
    this.sendEvent(AUTOMATION_CONTROL_EVENT, payload);
  }

  private async readCurrentPc(): Promise<string | undefined> {
    try {
      const result = await this.backend.execute({ cmd: 'readRegister', name: 'PC' });
      if (result.ok && result.data && typeof result.data === 'object') {
        const value = (result.data as { value?: unknown }).value;
        if (typeof value === 'number' && Number.isFinite(value)) {
          return `0x${(value >>> 0).toString(16)}`;
        }
      }
    } catch (error) {
      log.dap(`automation readCurrentPc failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return undefined;
  }

  private async currentOwnerKind(): Promise<AutomationFlashReport['owner']> {
    try {
      const result = await this.backend.execute({ cmd: 'getPerformanceDiagnostics' });
      if (result.ok && result.data && typeof result.data === 'object') {
        const owner = String((result.data as { owner?: unknown }).owner ?? '');
        if (owner.includes('cmsis-dap')) return 'cmsis-dap';
        if (owner.includes('jlink-native')) return 'jlink-native';
        if (owner.includes('legacy')) return 'jlink-legacy';
      }
    } catch (_) {
      // Owner reporting is best-effort; the probe is the fallback authority.
    }
    return this._probe === 'cmsis-dap' ? 'cmsis-dap' : 'jlink-legacy';
  }

  private async buildFlashReport(
    elfPath: string,
    flashData: unknown,
    request: AutomationControlRequest,
    startedAt: number,
  ): Promise<AutomationFlashReport> {
    const diagnostics: Record<string, unknown> = { verifyRequested: request.verify ?? true };
    const segments: AutomationFlashReport['segments'] = [];
    let bytesProgrammed = 0;
    try {
      const bytes = await fs.promises.readFile(elfPath);
      const parsed = parseElf32LoadSegments(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      for (const segment of parsed) {
        if (segment.fileSize <= 0) continue;
        segments.push({
          startAddress: `0x${(segment.loadAddress >>> 0).toString(16)}`,
          endAddress: `0x${((segment.loadAddress + segment.fileSize) >>> 0).toString(16)}`,
          bytes: segment.fileSize,
        });
        bytesProgrammed += segment.fileSize;
      }
    } catch (error) {
      diagnostics.elfSegmentParseError = error instanceof Error ? error.message : String(error);
    }
    let verified = false;
    if (flashData && typeof flashData === 'object') {
      const data = flashData as { reports?: Array<{ operation?: string; ok?: boolean }>; message?: string };
      if (Array.isArray(data.reports)) {
        verified = data.reports.some(report => report.operation === 'verify' && report.ok === true);
      } else if (typeof data.message === 'string' && /verified|verif/i.test(data.message)) {
        verified = true;
      }
    }
    const owner = await this.currentOwnerKind();
    return {
      elfPath,
      owner,
      bytesProgrammed,
      verified,
      segments,
      elapsedMs: Date.now() - startedAt,
      diagnostics,
    };
  }

  private async handleEvaluate(msg: DebugProtocolMessage) {
    const args = msg.arguments || {};
    const expr = args.expression;
    const context = args.context;
    const frameId = args.frameId;
    const isRTOS = this.isRtosEvaluateExpression(expr);
    const startedAtMs = this.nowMs();
    if (!expr) {
      this.sendResponse(msg, { result: '', variablesReference: 0 });
      return;
    }

    // MemoryView evaluates its default address/size expressions while the
    // target is running. Pure integer expressions are independent of target
    // state, so answer them before acquiring the target-read gate.
    if (this.targetRunning) {
      const constantValue = parseConstantExpression(expr);
      if (constantValue !== undefined) {
        this.sendResponse(msg, { result: String(constantValue), variablesReference: 0 });
        return;
      }
    }

    const force = context === 'watch' || context === 'hover';
    const waitForConsistentEvaluate = context === 'hover' || isRTOS;
    const readEpoch = this.readCancelEpoch;
    if (context === 'watch' && !this.watchExpressions.includes(expr)) {
      this.watchExpressions.push(expr);
    }

    if (this.shouldDeferTargetRead()) {
      if (isRTOS) {
        this.sendRtosEvaluateFailure(msg, 'RtosReadCancelled', 'RTOS evaluate was cancelled by target control', startedAtMs);
      } else {
        this.sendEvaluateValue(msg, this.cachedOrRunningWatchValue(expr), false);
      }
      return;
    }

    // Running-target evaluate requests can arrive in bursts from RTOS Views and hovers.
    // Reuse very recent values so those bursts do not monopolize J-Link.
    if (force && this.targetReadInProgress && !waitForConsistentEvaluate) {
      const wv = this.runtimeWatchReadInFlight
        ? this.cachedOrRunningWatchValue(expr)
        : this.getFreshRuntimeWatchValue(expr);
      if (wv) {
        this.sendEvaluateValue(msg, wv, false);
        return;
      }
    }

    const acquiredRead = force
      ? (isRTOS
        ? await this.beginTargetReadWhenAvailable('background', 1200)
        : await this.beginWatchTargetRead(waitForConsistentEvaluate ? 700 : 250))
      : await this.beginTargetReadWhenAvailable('background', 0);
    if (!acquiredRead) {
      if (isRTOS) {
        this.sendRtosEvaluateFailure(
          msg,
          'TargetReadUnavailable',
          'RTOS evaluate could not acquire the stopped-target read gate',
          startedAtMs,
        );
      } else {
        this.sendEvaluateValue(msg, this.cachedOrRunningWatchValue(expr), false);
      }
      return;
    }
    const controller = new AbortController();
    this.activeEvaluateAbortController = controller;
    try {
      if (readEpoch !== this.readCancelEpoch || this.shouldDeferTargetRead()) {
        if (isRTOS) {
          this.sendRtosEvaluateFailure(msg, 'RtosReadCancelled', 'RTOS evaluate was cancelled before dispatch', startedAtMs);
        } else {
          this.sendEvaluateValue(msg, this.cachedOrRunningWatchValue(expr), false);
        }
        return;
      }
      const targetHalted = force
        ? (isRTOS ? !this.targetRunning : await this.isTargetHalted())
        : true;
      if (controller.signal.aborted || readEpoch !== this.readCancelEpoch || this.shouldDeferTargetRead()) {
        log.dap(`evaluate discarded before dispatch expression=${expr} readEpoch=${readEpoch} currentEpoch=${this.readCancelEpoch}`);
        if (isRTOS) {
          this.sendRtosEvaluateFailure(msg, 'RtosReadCancelled', 'RTOS evaluate was cancelled before target access', startedAtMs);
        } else {
          this.sendEvaluateValue(msg, this.cachedOrRunningWatchValue(expr), false);
        }
        return;
      }
      if (!targetHalted) {
        if (isRTOS) {
          this.sendRtosEvaluateFailure(msg, 'TargetRunning', 'RTOS evaluate requires a stopped target', startedAtMs);
        } else {
          this.sendEvaluateValue(msg, this.cachedOrRunningWatchValue(expr), false);
        }
        return;
      }

      const result = await this.backend.execute({
        cmd: 'evaluateExpression',
        expression: expr,
        force,
        expandedExpressions: isRTOS ? [] : undefined,
        signal: controller.signal,
        priority: isRTOS ? 'background' : undefined,
      });
      if (controller.signal.aborted || readEpoch !== this.readCancelEpoch || this.shouldDeferTargetRead()) {
        log.dap(`evaluate discarded stale result expression=${expr} readEpoch=${readEpoch} currentEpoch=${this.readCancelEpoch}`);
        if (isRTOS) {
          this.sendRtosEvaluateFailure(msg, 'RtosReadCancelled', 'RTOS evaluate result became stale', startedAtMs, result);
        } else {
          this.sendEvaluateValue(msg, this.cachedOrRunningWatchValue(expr), false);
        }
      } else if (result.ok) {
        const wv = result.data as WatchValue;
        this.cacheRuntimeWatchValue(expr, wv);
        this.sendEvaluateValue(msg, wv, true, isRTOS
          ? {
            rootExpression: expr,
            expandedExpressions: [],
            targetEvaluateName: wv.evaluateName || wv.expression,
          }
          : undefined);
      } else {
        if (isRTOS) {
          this.sendRtosEvaluateFailure(
            msg,
            result.errorCode || 'RtosEvaluateFailed',
            result.error,
            startedAtMs,
            result,
          );
        } else {
          this.sendResponse(msg, { result: result.error, variablesReference: 0 }, false, result.error);
        }
      }
    } finally {
      if (this.activeEvaluateAbortController === controller) {
        this.activeEvaluateAbortController = null;
      }
      this.endTargetRead();
    }
  }

  private async handleWatchEvaluate(msg: DebugProtocolMessage) {
    const args = msg.arguments || {};
    const expressions = this.normalizeWatchExpressions(args.expressions);
    if (this.shouldDeferTargetRead()) {
      this.sendResponse(msg, { results: expressions.map(expr => this.cachedOrRunningWatchValue(expr)) });
      return;
    }
    const results = await this.readWatchExpressions(expressions, true, args.expandedExpressions);
    this.sendResponse(msg, { results });
  }

  private async handleDataSample(msg: DebugProtocolMessage) {
    const args = msg.arguments || {};
    const expressions = this.normalizeWatchExpressions(args.expressions);
    const results = await this.readWatchExpressions(expressions, true, args.expandedExpressions);
    this.sendResponse(msg, { results });
  }

  private async handleDataSamplingStart(msg: DebugProtocolMessage) {
    const args = msg.arguments || {};
    const entries: DapSamplingEntry[] = Array.isArray(args.entries)
      ? args.entries
        .map((entry: any) => ({ expression: String(entry.expression || '').trim(), color: String(entry.color || '#4EC9B0') }))
        .filter((entry: DapSamplingEntry) => entry.expression)
      : (Array.isArray(args.expressions) ? args.expressions.map((expression: string) => ({ expression, color: '#4EC9B0' })) : []);

    this.stopDataSampling();
    if (entries.length === 0) {
      this.sendResponse(msg, { ok: true, planned: [] });
      return;
    }

    const planResult = await this.backend.execute({
      cmd: 'prepareFastDataSampling',
      expressions: entries.map(entry => entry.expression),
    });
    if (!planResult.ok) {
      this.sendResponse(msg, undefined, false, planResult.error);
      return;
    }

    const plan = planResult.data as FastDataSamplePlanItem[];
    const specs = plan.map(item => item.spec).filter((spec): spec is FastDataSampleSpec => !!spec);
    if (specs.length === 0) {
      this.sendResponse(msg, { ok: false, planned: plan }, false, 'No expressions can use fast data sampling');
      return;
    }

    const supported = new Set(specs.map(spec => spec.expression));
    this.dataSamplingEntries = entries.filter(entry => supported.has(entry.expression));
    this.dataSamplingSpecs = specs;
    this.dataSamplingPending.clear();
    this.dataSamplingLastDisplay.clear();
    for (const entry of this.dataSamplingEntries) {
      this.dataSamplingPending.set(entry.expression, []);
    }
    this.dataSamplingIntervalMs = this.clampNumber(args.sampleIntervalMs, 0.2, 0.1, 10000);
    this.dataSamplingSendIntervalMs = this.clampNumber(args.sendIntervalMs, 16, 1, 10000);
    const now = this.nowMs();
    this.dataSamplingNextSampleMs = now;
    this.dataSamplingActive = true;
    const rejected = plan.filter(item => !item.spec).map(item => item.expression);
    log.dap(
      `[timeline] start fast=${this.dataSamplingEntries.map(entry => entry.expression).join(',')}`
      + ` rejected=${rejected.join(',') || 'none'} sampleMs=${this.dataSamplingIntervalMs} sendMs=${this.dataSamplingSendIntervalMs}`,
    );
    this.startDataSamplingFlushTimer();
    this.scheduleDataSamplingLoop();
    this.sendResponse(msg, {
      ok: true,
      planned: plan,
      activeExpressions: this.dataSamplingEntries.map(entry => entry.expression),
      intervalMs: this.dataSamplingIntervalMs,
    });
  }

  private async handleDataSamplingStop(msg: DebugProtocolMessage) {
    this.stopDataSampling();
    const performanceResult = await this.backend.execute({ cmd: 'getPerformanceDiagnostics' });
    this.sendResponse(msg, {
      ok: true,
      targetReadGate: this.snapshotTargetReadGateMetrics(),
      performanceMetrics: performanceResult.ok ? performanceResult.data : null,
    });
  }

  private scheduleDataSamplingLoop() {
    if (!this.dataSamplingActive || this.dataSamplingTimer) return;
    this.dataSamplingTimer = setImmediate(() => {
      this.dataSamplingTimer = null;
      void this.dataSamplingLoop();
    });
  }

  private async dataSamplingLoop() {
    if (!this.dataSamplingActive) return;
    if (this.shouldDeferTargetRead() || !this.targetRunning) {
      const now = this.nowMs();
      // Do not accumulate elapsed sampling slots while the target is stopped.
      // Continuing starts from the next live target read instead of backfilling time.
      this.dataSamplingNextSampleMs = now + this.dataSamplingIntervalMs;
      await new Promise<void>(resolve => setTimeout(resolve, 10));
      this.scheduleDataSamplingLoop();
      return;
    }
    const budgetEndMs = this.nowMs() + 4;
    let samplesThisTurn = 0;

    while (this.dataSamplingActive && this.nowMs() >= this.dataSamplingNextSampleMs && this.nowMs() < budgetEndMs && samplesThisTurn < 512) {
      const captured = await this.captureFastDataSample();
      if (!captured) {
        // Watch/control owns the in-flight target read. Do not burn the whole
        // sampling budget spinning on a rejected low-priority read.
        this.dataSamplingNextSampleMs = this.nowMs() + this.dataSamplingIntervalMs;
        await new Promise<void>(resolve => setTimeout(resolve, 1));
        break;
      }
      this.dataSamplingNextSampleMs += this.dataSamplingIntervalMs;
      const now = this.nowMs();
      if (this.dataSamplingNextSampleMs < now - this.dataSamplingIntervalMs * 256) {
        this.dataSamplingNextSampleMs = now;
      }
      samplesThisTurn++;
    }

    this.scheduleDataSamplingLoop();
  }

  private startDataSamplingFlushTimer() {
    if (this.dataSamplingSendTimer) clearInterval(this.dataSamplingSendTimer);
    this.dataSamplingSendTimer = setInterval(() => {
      if (!this.dataSamplingActive) return;
      this.flushDataSampling();
    }, this.dataSamplingSendIntervalMs);
  }

  private async captureFastDataSample(): Promise<boolean> {
    if (!this.targetRunning) return false;
    if (!this.beginTargetRead()) return false;
    try {
      const result = await this.backend.execute({ cmd: 'readFastDataSampling', specs: this.dataSamplingSpecs });
      // A stopped event can win the race while the batch was in flight. Those
      // bytes are not a post-stop Timeline sample and must not advance the plot.
      if (!this.targetRunning || !result.ok) return true;
      const values = result.data as WatchValue[];
      const timestamp = this.timelineNowMs();
      const gapThresholdMs = Math.max(
        this.dataSamplingIntervalMs * 3,
        this.dataSamplingSendIntervalMs * 2,
      );
      for (const value of values) {
        if (!value || value.error) continue;
        if (typeof value.value !== 'number' || !Number.isFinite(value.value)) continue;
        const pending = this.dataSamplingPending.get(value.expression);
        if (!pending) continue;
        const lastTimestamp = this.dataSamplingLastTimestamp.get(value.expression);
        const startsNewSegment = !this.dataSamplingSeenExpressions.has(value.expression)
          || (lastTimestamp !== undefined && timestamp - lastTimestamp > gapThresholdMs);
        pending.push({
          timestamp,
          value: value.value,
          display: value.display,
          ...(startsNewSegment ? { startsNewSegment: true } : {}),
        });
        this.dataSamplingSeenExpressions.add(value.expression);
        this.dataSamplingLastTimestamp.set(value.expression, timestamp);
        this.dataSamplingLastDisplay.set(value.expression, value.display);
      }
      return true;
    } finally {
      this.endTargetRead();
    }
  }

  private flushDataSampling() {
    const snapshots = [];
    for (const entry of this.dataSamplingEntries) {
      const pending = this.dataSamplingPending.get(entry.expression);
      if (!pending || pending.length === 0) continue;
      snapshots.push({
        expression: entry.expression,
        color: entry.color,
        currentValue: this.dataSamplingLastDisplay.get(entry.expression) || '',
        data: pending.splice(0),
      });
    }
    if (snapshots.length > 0) {
      this.sendEvent('ozoneDataSamples', {
        snapshots,
        intervalMs: this.dataSamplingIntervalMs,
      });
    }
  }

  private stopDataSampling() {
    this.dataSamplingActive = false;
    if (this.dataSamplingTimer) {
      clearImmediate(this.dataSamplingTimer);
      this.dataSamplingTimer = null;
    }
    if (this.dataSamplingSendTimer) {
      clearInterval(this.dataSamplingSendTimer);
      this.dataSamplingSendTimer = null;
    }
    this.flushDataSampling();
    this.dataSamplingEntries = [];
    this.dataSamplingSpecs = [];
    this.dataSamplingPending.clear();
    this.dataSamplingLastDisplay.clear();
    this.dataSamplingLastTimestamp.clear();
    this.dataSamplingSeenExpressions.clear();
  }

  private nowMs(): number {
    return this.highResEpochMs + Number(process.hrtime.bigint() - this.highResStartNs) / 1_000_000;
  }

  private clampNumber(value: unknown, fallback: number, min: number, max: number): number {
    const numeric = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.max(min, Math.min(max, numeric));
  }

  private parseOptionalAddress(value: unknown): number | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    const numeric = typeof value === 'number' ? value : Number(String(value).trim());
    if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
    return numeric >>> 0;
  }

  private async handleSetWatchValue(msg: DebugProtocolMessage) {
    const args = msg.arguments || {};
    const expression: string = args.expression || '';
    const value: number = args.value ?? 0;
    const address = this.parseOptionalAddress(args.address);
    const typeName = typeof args.typeName === 'string' ? args.typeName : undefined;
    if (!expression || !Number.isFinite(value)) {
      this.sendResponse(msg, { ok: false, error: 'Invalid watch value request' });
      return;
    }
    const result = await this.writeWatchValueCore(expression, value, address, typeName);
    this.sendResponse(msg, result);
  }

  /**
   * Shared write core used by the standard DAP `setWatchValue` request and the
   * automation `writeMany` handler. The whole write runs under the step lock
   * and the target-write barrier so automation writes are control work, never
   * a bypass of the read/control handoff.
   */
  private async writeWatchValueCore(
    expression: string,
    value: number,
    address?: number,
    typeName?: string,
  ): Promise<OzoneCommandResult> {
    return this.withStepLock(async () => {
      if (!(await this.beginTargetWrite())) {
        return { ok: false, error: 'Target busy', errorCode: 'TargetBusy' };
      }
      try {
        // Preserve timestamp order: publish samples captured before the write before acknowledging it.
        this.flushDataSampling();
        const result = await this.backend.execute({ cmd: 'setWatchValue', expression, value, address, typeName });
        if (result.ok) {
          this.runtimeWatchCache.delete(expression);
          this.runtimeWatchCacheTime.delete(expression);
        }
        return result;
      } finally {
        this.endTargetWrite();
      }
    });
  }

  private async handleGetTargetState(msg: DebugProtocolMessage) {
    const r = await this.queryTargetState('custom-request');
    this.sendResponse(msg, r.ok ? { state: r.data } : { state: 'error', error: r.error, errorCode: r.errorCode });
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    if (this.terminationPromise) {
      this.disposePromise = this.terminationPromise;
      return this.disposePromise;
    }
    this.disposePromise = (async () => {
      this.phase = 'terminating';
      this.targetConnectionEstablished = false;
      this.controlInProgress = true;
      this.advanceReadCancelEpoch();
      this.resetVariableHandles();
      this.cancelTargetReadGateWaiters();
      this.cancelActiveTargetReads('DAP session disposed');
      this.stopDataSampling();
      this.stopRttLogPolling();
      this.stopPolling();
      this.stopConnectionMonitor();
      this.flashAbortController?.abort('DAP session disposed');
      (this.backend as any).cancelFlash?.('DAP session disposed');
      await this.backend.dispose(false);
      this.phase = 'terminated';
    })();
    return this.disposePromise;
  }
}
