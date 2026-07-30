import {
  SystemViewEventId,
  type SystemViewDecodeBatch,
  type SystemViewDiagnostic,
  type SystemViewEvent,
} from './systemview-protocol';

export type RtosTaskState = 'unknown' | 'ready' | 'running' | 'blocked' | 'terminated';
export type RtosContextKind = 'unknown' | 'task' | 'isr' | 'idle';

export interface RtosTaskRuntimeState {
  readonly taskId: number;
  readonly state: RtosTaskState;
  readonly ready: boolean;
}

export interface RtosContextSegment {
  readonly kind: Exclude<RtosContextKind, 'unknown'>;
  readonly taskId?: number;
  readonly interruptId?: number;
  readonly startTimestamp: number;
  readonly endTimestamp?: number;
}

export interface RtosReadyInterval {
  readonly taskId: number;
  readonly startTimestamp: number;
  readonly endTimestamp?: number;
}

export interface RtosDataGap {
  readonly startTimestamp?: number;
  readonly endTimestamp?: number;
  readonly reason: string;
}

export interface RtosStateDiagnostic {
  readonly code: 'event-before-trace-start' | 'invalid-sequence' | 'nested-isr-underflow' | 'time-regression' | 'data-gap';
  readonly message: string;
  readonly timestamp?: number;
}

export interface RtosStateSnapshot {
  readonly trusted: boolean;
  readonly currentTaskId?: number;
  readonly currentContext: RtosContextKind;
  readonly isrDepth: number;
  readonly tasks: readonly RtosTaskRuntimeState[];
  readonly contextSegments: readonly RtosContextSegment[];
  readonly readyIntervals: readonly RtosReadyInterval[];
  readonly dataGaps: readonly RtosDataGap[];
  readonly diagnostics: readonly RtosStateDiagnostic[];
}

interface MutableTaskRuntimeState {
  taskId: number;
  state: RtosTaskState;
  ready: boolean;
}

interface OpenContext {
  kind: Exclude<RtosContextKind, 'unknown'>;
  taskId?: number;
  interruptId?: number;
  startTimestamp: number;
}

interface OpenReadyInterval {
  taskId: number;
  startTimestamp: number;
}

interface IsrReturnContext {
  readonly kind: Exclude<RtosContextKind, 'unknown'>;
  readonly taskId?: number;
  readonly interruptId?: number;
}

/**
 * Reconstructs only what the event stream proves. A decoder gap closes all
 * trusted intervals and leaves the state unknown until INIT/TRACE_START
 * establishes a new trusted epoch.
 */
export class SystemViewRtosStateMachine {
  private readonly tasks = new Map<number, MutableTaskRuntimeState>();
  private readonly contextSegments: RtosContextSegment[] = [];
  private readonly readyIntervals: RtosReadyInterval[] = [];
  private readonly dataGaps: RtosDataGap[] = [];
  private readonly diagnostics: RtosStateDiagnostic[] = [];
  private readonly openReady = new Map<number, OpenReadyInterval>();
  private readonly isrStack: Array<{ interruptId: number; returnContext?: IsrReturnContext }> = [];
  private current: OpenContext | undefined;
  private currentTaskId: number | undefined;
  private lastTimestamp: number | undefined;
  private openGap: RtosDataGap | undefined;
  private trusted = false;

  public applyBatch(batch: SystemViewDecodeBatch): void {
    for (const diagnostic of batch.diagnostics) this.applyDecoderDiagnostic(diagnostic);
    for (const event of batch.events) this.apply(event);
  }

  public apply(event: SystemViewEvent): void {
    if (this.lastTimestamp !== undefined && event.timestamp < this.lastTimestamp && this.current) {
      this.diagnostics.push({
        code: 'time-regression',
        message: `SystemView timestamp moved from ${this.lastTimestamp} to ${event.timestamp}; treating the epoch as uncertain`,
        timestamp: event.timestamp,
      });
    }
    this.lastTimestamp = event.timestamp;

    if (event.eventId === SystemViewEventId.OVERFLOW) {
      this.markGap(event.timestamp, 'SystemView overflow');
      return;
    }
    if (event.eventId === SystemViewEventId.INIT || event.eventId === SystemViewEventId.TRACE_START) {
      this.recover(event.timestamp);
      return;
    }
    if (!this.trusted) {
      this.diagnostics.push({
        code: 'event-before-trace-start',
        message: `Ignored ${event.eventId} before a trusted SystemView INIT/TRACE_START epoch`,
        timestamp: event.timestamp,
      });
      return;
    }
    if (this.openGap) return;

    const payload = event.payload;
    switch (payload.kind) {
      case 'task':
        if (payload.role === 'create') {
          this.ensureTask(payload.taskId);
        } else if (payload.role === 'terminate') {
          this.terminateTask(payload.taskId, event.timestamp);
        } else if (payload.role === 'start-exec') {
          this.startTaskExecution(payload.taskId, event.timestamp);
        } else if (payload.role === 'start-ready') {
          this.startReady(payload.taskId, event.timestamp);
        }
        return;
      case 'task-stop-ready':
        this.stopReady(payload.taskId, event.timestamp);
        return;
      case 'task-stop-exec':
        this.stopTaskExecution(event.timestamp);
        return;
      case 'isr-enter':
        this.enterIsr(payload.interruptId, event.timestamp);
        return;
      default:
        break;
    }

    switch (event.eventId) {
      case SystemViewEventId.ISR_EXIT:
        this.exitIsr(event.timestamp);
        break;
      case SystemViewEventId.ISR_TO_SCHEDULER:
        this.closeContext(event.timestamp);
        this.currentTaskId = undefined;
        break;
      case SystemViewEventId.IDLE:
        this.closeContext(event.timestamp);
        this.currentTaskId = undefined;
        this.openContext({ kind: 'idle', startTimestamp: event.timestamp });
        break;
      case SystemViewEventId.TRACE_STOP:
        this.closeContext(event.timestamp);
        this.closeAllReady(event.timestamp);
        break;
      default:
        break;
    }
  }

  public finish(
    reason: 'stream-end' | 'channel-gone' | 'owner-lost' | 'reset' = 'stream-end',
    timestamp = this.lastTimestamp,
  ): void {
    if (reason !== 'stream-end' && reason !== 'reset') {
      this.markGap(timestamp, `SystemView ${reason}`);
    } else if (timestamp !== undefined) {
      this.closeContext(timestamp);
      this.closeAllReady(timestamp);
    }
    if (reason === 'reset') this.reset();
  }

  public snapshot(): RtosStateSnapshot {
    const activeContext: RtosContextSegment[] = this.current
      ? [{
          kind: this.current.kind,
          ...(this.current.taskId === undefined ? {} : { taskId: this.current.taskId }),
          ...(this.current.interruptId === undefined ? {} : { interruptId: this.current.interruptId }),
          startTimestamp: this.current.startTimestamp,
        }]
      : [];
    const activeReady = [...this.openReady.values()].map(interval => ({ ...interval }));
    return {
      trusted: this.trusted && this.openGap === undefined,
      ...(this.currentTaskId === undefined ? {} : { currentTaskId: this.currentTaskId }),
      currentContext: this.current?.kind ?? (this.openGap ? 'unknown' : 'unknown'),
      isrDepth: this.isrStack.length,
      tasks: [...this.tasks.values()]
        .sort((left, right) => left.taskId - right.taskId)
        .map(task => ({ ...task })),
      contextSegments: [...this.contextSegments, ...activeContext],
      readyIntervals: [...this.readyIntervals, ...activeReady],
      dataGaps: [...this.dataGaps],
      diagnostics: [...this.diagnostics],
    };
  }

  public reset(): void {
    this.tasks.clear();
    this.contextSegments.length = 0;
    this.readyIntervals.length = 0;
    this.dataGaps.length = 0;
    this.diagnostics.length = 0;
    this.openReady.clear();
    this.isrStack.length = 0;
    this.current = undefined;
    this.currentTaskId = undefined;
    this.lastTimestamp = undefined;
    this.openGap = undefined;
    this.trusted = false;
  }

  private applyDecoderDiagnostic(diagnostic: SystemViewDiagnostic): void {
    if (diagnostic.code === 'overflow') return;
    if (diagnostic.code === 'sync' || diagnostic.code === 'stream-end') return;
    if (diagnostic.code === 'truncated-packet'
      || diagnostic.code === 'invalid-varint'
      || diagnostic.code === 'invalid-length'
      || diagnostic.code === 'malformed-event'
      || diagnostic.code === 'resynchronized'
      || diagnostic.code === 'channel-gone'
      || diagnostic.code === 'owner-lost'
      || diagnostic.code === 'reset') {
      this.markGap(this.lastTimestamp, `Decoder ${diagnostic.code}`);
      this.diagnostics.push({
        code: 'data-gap',
        message: diagnostic.message,
        timestamp: this.lastTimestamp,
      });
    }
  }

  private recover(timestamp: number): void {
    if (this.openGap) {
      const gap = this.openGap;
      this.dataGaps[this.dataGaps.length - 1] = {
        ...gap,
        endTimestamp: timestamp,
      };
      this.openGap = undefined;
    }
    this.trusted = true;
    this.current = undefined;
    this.currentTaskId = undefined;
    this.isrStack.length = 0;
  }

  private markGap(timestamp: number | undefined, reason: string): void {
    if (timestamp !== undefined) {
      this.closeContext(timestamp);
      this.closeAllReady(timestamp);
    } else {
      this.current = undefined;
      this.openReady.clear();
      this.isrStack.length = 0;
    }
    this.currentTaskId = undefined;
    for (const task of this.tasks.values()) {
      task.state = 'unknown';
      task.ready = false;
    }
    this.isrStack.length = 0;
    if (!this.openGap) {
      const gap: RtosDataGap = {
        ...(timestamp === undefined ? {} : { startTimestamp: timestamp }),
        reason,
      };
      this.dataGaps.push(gap);
      this.openGap = gap;
    }
    this.trusted = false;
  }

  private ensureTask(taskId: number): MutableTaskRuntimeState {
    const existing = this.tasks.get(taskId);
    if (existing) return existing;
    const task: MutableTaskRuntimeState = { taskId, state: 'unknown', ready: false };
    this.tasks.set(taskId, task);
    return task;
  }

  private startTaskExecution(taskId: number, timestamp: number): void {
    if (this.currentTaskId !== undefined && this.currentTaskId !== taskId) {
      const previous = this.ensureTask(this.currentTaskId);
      previous.state = previous.ready ? 'ready' : 'blocked';
    }
    this.closeContext(timestamp);
    const task = this.ensureTask(taskId);
    task.state = 'running';
    this.currentTaskId = taskId;
    this.openContext({ kind: 'task', taskId, startTimestamp: timestamp });
  }

  private stopTaskExecution(timestamp: number): void {
    this.closeContext(timestamp);
    if (this.currentTaskId !== undefined) {
      const task = this.ensureTask(this.currentTaskId);
      task.state = task.ready ? 'ready' : 'blocked';
    }
    this.currentTaskId = undefined;
  }

  private startReady(taskId: number, timestamp: number): void {
    const task = this.ensureTask(taskId);
    task.ready = true;
    if (task.state !== 'running') task.state = 'ready';
    if (!this.openReady.has(taskId)) this.openReady.set(taskId, { taskId, startTimestamp: timestamp });
  }

  private stopReady(taskId: number, timestamp: number): void {
    const task = this.ensureTask(taskId);
    task.ready = false;
    if (task.state !== 'running' && task.state !== 'terminated') task.state = 'blocked';
    const interval = this.openReady.get(taskId);
    if (interval) {
      this.readyIntervals.push({ ...interval, endTimestamp: timestamp });
      this.openReady.delete(taskId);
    }
  }

  private terminateTask(taskId: number, timestamp: number): void {
    const task = this.ensureTask(taskId);
    const wasCurrent = this.currentTaskId === taskId;
    if (wasCurrent) {
      this.closeContext(timestamp);
      this.currentTaskId = undefined;
    }
    this.stopReady(taskId, timestamp);
    task.state = 'terminated';
  }

  private enterIsr(interruptId: number, timestamp: number): void {
    const returnContext = this.current
      ? { kind: this.current.kind, taskId: this.current.taskId, interruptId: this.current.interruptId }
      : undefined;
    this.closeContext(timestamp);
    this.isrStack.push({ interruptId, returnContext });
    this.openContext({ kind: 'isr', interruptId, startTimestamp: timestamp });
  }

  private exitIsr(timestamp: number): void {
    if (this.isrStack.length === 0) {
      this.diagnostics.push({
        code: 'nested-isr-underflow',
        message: 'ISR_EXIT occurred without a matching ISR_ENTER',
        timestamp,
      });
      return;
    }
    this.closeContext(timestamp);
    const frame = this.isrStack.pop();
    if (!frame?.returnContext) {
      this.currentTaskId = undefined;
      return;
    }
    this.currentTaskId = frame.returnContext.taskId;
    this.openContext({ ...frame.returnContext, startTimestamp: timestamp });
  }

  private openContext(context: OpenContext): void {
    this.current = context;
  }

  private closeContext(timestamp: number): void {
    if (!this.current) return;
    const segment: RtosContextSegment = {
      kind: this.current.kind,
      ...(this.current.taskId === undefined ? {} : { taskId: this.current.taskId }),
      ...(this.current.interruptId === undefined ? {} : { interruptId: this.current.interruptId }),
      startTimestamp: this.current.startTimestamp,
      endTimestamp: timestamp,
    };
    if (segment.endTimestamp === undefined || segment.endTimestamp >= segment.startTimestamp) {
      this.contextSegments.push(segment);
    }
    this.current = undefined;
  }

  private closeAllReady(timestamp: number): void {
    for (const interval of this.openReady.values()) {
      this.readyIntervals.push({ ...interval, endTimestamp: timestamp });
    }
    this.openReady.clear();
  }
}
