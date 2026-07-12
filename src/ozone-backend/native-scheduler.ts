export type NativeTaskPriority = 'control' | 'watch' | 'timeline';

export interface NativeScheduleOptions {
  priority: NativeTaskPriority;
  signal?: AbortSignal;
  coalesceKey?: string;
  label?: string;
}

export interface NativeSchedulerSnapshot {
  running: boolean;
  pausedPriorities: NativeTaskPriority[];
  queued: Record<NativeTaskPriority, number>;
}

interface ScheduledTask<T> {
  id: number;
  options: NativeScheduleOptions;
  execute: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  abortListener?: () => void;
}

const PRIORITY_ORDER: NativeTaskPriority[] = ['control', 'watch', 'timeline'];

export class NativeSchedulerCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NativeSchedulerCancelledError';
  }
}

/** Serializes access to the native J-Link owner and applies queue priority. */
export class NativeScheduler {
  private readonly queues: Record<NativeTaskPriority, ScheduledTask<any>[]> = {
    control: [],
    watch: [],
    timeline: [],
  };
  private readonly pauseCounts: Record<NativeTaskPriority, number> = {
    control: 0,
    watch: 0,
    timeline: 0,
  };
  private nextId = 1;
  private running = false;
  private disposed = false;

  schedule<T>(execute: () => Promise<T>, options: NativeScheduleOptions): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new NativeSchedulerCancelledError('Native scheduler is disposed'));
    }
    if (options.signal?.aborted) {
      return Promise.reject(new NativeSchedulerCancelledError(`${options.label || 'Native task'} was cancelled`));
    }

    return new Promise<T>((resolve, reject) => {
      const task: ScheduledTask<T> = {
        id: this.nextId++,
        options,
        execute,
        resolve,
        reject,
      };
      if (options.signal) {
        task.abortListener = () => this.cancelQueuedTask(task, `${options.label || 'Native task'} was cancelled`);
        options.signal.addEventListener('abort', task.abortListener, { once: true });
      }
      if (options.coalesceKey) this.cancelCoalesced(options.priority, options.coalesceKey);
      this.queues[options.priority].push(task);
      this.pump();
    });
  }

  pause(priority: NativeTaskPriority): () => void {
    this.pauseCounts[priority]++;
    let resumed = false;
    return () => {
      if (resumed) return;
      resumed = true;
      this.pauseCounts[priority] = Math.max(0, this.pauseCounts[priority] - 1);
      this.pump();
    };
  }

  async withPaused<T>(priorities: NativeTaskPriority[], execute: () => Promise<T>): Promise<T> {
    const resumes = priorities.map(priority => this.pause(priority));
    try {
      return await execute();
    } finally {
      for (const resume of resumes.reverse()) resume();
    }
  }

  cancel(priority: NativeTaskPriority, reason = `${priority} queue cancelled`) {
    const tasks = this.queues[priority].splice(0);
    for (const task of tasks) this.rejectTask(task, new NativeSchedulerCancelledError(reason));
  }

  dispose(reason = 'Native scheduler disposed') {
    this.disposed = true;
    for (const priority of PRIORITY_ORDER) this.cancel(priority, reason);
  }

  snapshot(): NativeSchedulerSnapshot {
    return {
      running: this.running,
      pausedPriorities: PRIORITY_ORDER.filter(priority => this.pauseCounts[priority] > 0),
      queued: {
        control: this.queues.control.length,
        watch: this.queues.watch.length,
        timeline: this.queues.timeline.length,
      },
    };
  }

  private pump() {
    if (this.running || this.disposed) return;
    const task = this.takeNext();
    if (!task) return;
    this.running = true;
    this.detachAbortListener(task);
    void task.execute().then(task.resolve, task.reject).finally(() => {
      this.running = false;
      this.pump();
    });
  }

  private takeNext(): ScheduledTask<any> | undefined {
    for (const priority of PRIORITY_ORDER) {
      if (this.pauseCounts[priority] === 0 && this.queues[priority].length > 0) {
        return this.queues[priority].shift();
      }
    }
    return undefined;
  }

  private cancelCoalesced(priority: NativeTaskPriority, coalesceKey: string) {
    const queue = this.queues[priority];
    for (let index = queue.length - 1; index >= 0; index--) {
      if (queue[index].options.coalesceKey !== coalesceKey) continue;
      const [task] = queue.splice(index, 1);
      this.rejectTask(task, new NativeSchedulerCancelledError(`Superseded ${coalesceKey}`));
    }
  }

  private cancelQueuedTask(task: ScheduledTask<any>, reason: string) {
    const queue = this.queues[task.options.priority];
    const index = queue.findIndex(candidate => candidate.id === task.id);
    if (index < 0) return;
    queue.splice(index, 1);
    this.rejectTask(task, new NativeSchedulerCancelledError(reason));
  }

  private rejectTask(task: ScheduledTask<any>, error: Error) {
    this.detachAbortListener(task);
    task.reject(error);
  }

  private detachAbortListener(task: ScheduledTask<any>) {
    if (task.abortListener && task.options.signal) {
      task.options.signal.removeEventListener('abort', task.abortListener);
      task.abortListener = undefined;
    }
  }
}
