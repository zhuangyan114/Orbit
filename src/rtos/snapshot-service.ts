import type { SymbolCatalog } from '../symbols/symbol-catalog';
import { FreeRtosLayoutCache } from './freertos-layout';
import { Capability, RtosError, RtosSnapshot, SnapshotIdentity } from './model';
import { ObjectReadOptions, readObjectSnapshot } from './object-reader';
import { AddressRange, readTaskSnapshot, SnapshotLimits } from './snapshot-reader';
import { addStackMetrics, PortContract, StackScanOptions, TaskRuntimeTracker } from './task-metrics';
import { readHeapOverview, readTimerSnapshot } from './timer-heap-reader';

export interface SnapshotHost {
  identity(): Omit<SnapshotIdentity, 'layoutId'>;
  targetState(): RtosSnapshot['targetState'];
  available(): boolean;
  catalog(): Promise<SymbolCatalog>;
  ram: AddressRange[];
  port?: PortContract;
  slice?: { blockBytes: number; ranges: number };
  read(address: number, size: number, signal: AbortSignal): Promise<{ bytes: Uint8Array; queueWaitMs: number }>;
  readMany?(ranges: AddressRange[], signal: AbortSignal): Promise<{ bytes: Uint8Array[]; queueWaitMs: number }>;
  readRodata?(address: number, maxBytes: number): Uint8Array | undefined;
}
export interface SnapshotOptions extends StackScanOptions, Omit<ObjectReadOptions, 'readRodata'> {
  limits?: Partial<SnapshotLimits>;
  includeObjects?: boolean;
  includeTimers?: boolean;
  includeHeap?: boolean;
  detailBudgetBytes?: number;
}

/** One in-flight refresh, no queued ticks, and a fence on every asynchronous boundary. */
export class RtosSnapshotService {
  private readonly layouts = new FreeRtosLayoutCache();
  private readonly runtime = new TaskRuntimeTracker();
  private inFlight?: Promise<RtosSnapshot>;
  private controller?: AbortController;
  private last?: RtosSnapshot;
  private sequence = 0;
  private generation = 0;
  private timer?: NodeJS.Timeout;
  private pollingGeneration = 0;
  private live = false;
  private disposed = false;
  private hints: number[] = [];
  private hintsKey = '';
  private readonly counts = { requested: 0, coalesced: 0, completed: 0, published: 0, cancelled: 0, failed: 0, busy: 0 };
  constructor(private readonly host: SnapshotHost) {}
  async capabilities() {
    const identity = this.host.identity();
    if (this.disposed) throw new RtosError('SessionChanged', 'Snapshot session ended');
    const catalog = await this.host.catalog();
    if (this.disposed || JSON.stringify(identity) !== JSON.stringify(this.host.identity())) throw new RtosError('SessionChanged', 'Snapshot metadata changed');
    const layout = this.layouts.get(catalog, identity.elfSha256);
    const capability = (available: boolean, reason: string): Capability => ({ available, ...(!available ? { reason } : {}), evidence: 'source' });
    const bounds = !!layout.tcb.fields.pxEndOfStack && !!this.host.port?.stackGrowth;
    return { ...identity, layoutId: layout.layoutId, capabilities: {
      layout: capability(true, ''), taskSnapshot: capability(this.host.ram.length > 0, 'RAM description unavailable'),
      stackBounds: capability(bounds, 'Stack end or port direction unavailable'),
      stackWatermark: capability(bounds && this.host.port?.stackFillByte !== undefined, 'Stack bounds or verified fill pattern unavailable'),
      runtimeCounters: capability(!!layout.tcb.fields.ulRunTimeCounter, 'Kernel runtime statistics disabled or missing'),
      runtimePercent: capability(!!layout.runtimeTotal && !!layout.tcb.fields.ulRunTimeCounter && !!this.host.port?.runtime, 'Counter total or verified timebase unavailable'),
      objects: capability(!!layout.queue && this.host.ram.length > 0, layout.queueUnavailableReason || 'RAM description unavailable'),
      timers: capability(!!layout.timer && this.host.ram.length > 0, layout.timerUnavailableReason || 'RAM description unavailable'),
      heap: capability(!!layout.heap?.supported && this.host.ram.length > 0, layout.heap?.unavailableReason || 'RAM description unavailable'),
    } };
  }
  invalidate(reason: string) {
    this.generation++;
    this.controller?.abort(reason);
    this.runtime.clear();
  }
  dispose() { this.disposed = true; this.stop(); this.invalidate('Session ended'); this.last = undefined; }
  refresh(options: SnapshotOptions = {}): Promise<RtosSnapshot> {
    this.counts.requested++;
    if (this.disposed || !this.host.available()) { this.counts.busy++; return Promise.reject(new RtosError('SessionChanged', 'Snapshot session is unavailable or busy')); }
    if (this.inFlight) { this.counts.coalesced++; return this.inFlight; }
    const generation = this.generation, controller = new AbortController(), identity = this.host.identity();
    const fence = () => {
      if (controller.signal.aborted || generation !== this.generation || this.disposed || !this.host.available()
        || JSON.stringify(identity) !== JSON.stringify(this.host.identity())) throw new RtosError('SessionChanged', 'Snapshot identity changed');
    };
    this.controller = controller;
    const run = async () => {
      fence();
      const catalog = await this.host.catalog(); fence();
      const layout = this.layouts.get(catalog, identity.elfSha256);
      const hintsKey = JSON.stringify([identity.sessionId, identity.sessionGeneration, identity.bootGeneration, identity.elfSha256, layout.layoutId]);
      if (this.hintsKey !== hintsKey) { this.hintsKey = hintsKey; this.hints = []; }
      let queueWaitMs = 0;
      const result = await readTaskSnapshot(layout, { identity: { ...identity, layoutId: layout.layoutId }, sequence: ++this.sequence,
        targetState: this.host.targetState(), ram: this.host.ram, limits: options.limits, signal: controller.signal, taskHints: this.hints, slice: this.host.slice,
        read: async (address, size) => { fence(); const result = await this.host.read(address, size, controller.signal); fence(); queueWaitMs += result.queueWaitMs; return result.bytes; },
        ...(this.host.readMany ? { readMany: async (ranges: AddressRange[]) => { fence(); const result = await this.host.readMany!(ranges, controller.signal); fence(); queueWaitMs += result.queueWaitMs; return result.bytes; } } : {}) });
      fence();

      // Enforce a unified detail refresh budget across Heap, Stack Scan, Objects, and Timers.
      const baselineBytes = result.snapshot.diagnostics.bytes;
      const detailLimit = options.detailBudgetBytes !== undefined
        ? Math.max(1, Math.min(result.memory.limits.bytes, Math.floor(options.detailBudgetBytes)))
        : Math.min(64 * 1024, result.memory.limits.bytes - Math.min(baselineBytes, result.memory.limits.bytes - 1));
      const originalByteLimit = result.memory.limits.bytes;
      result.memory.limits.bytes = Math.min(originalByteLimit, baselineBytes + detailLimit);

      let heapBytes = 0;
      let stackBytes = 0;
      let objectBytes = 0;
      let timerBytes = 0;
      let detailBudgetExhausted = false;

      const recordDetailIssue = (operation: string, error: unknown) => {
        if (controller.signal.aborted || (error instanceof RtosError && ['SessionChanged', 'TargetReadCancelled'].includes(error.errorCode))) {
          throw error;
        }
        const errorCode = error instanceof RtosError ? error.errorCode : 'MemoryReadFailed';
        const message = error instanceof Error ? error.message : String(error);
        if (errorCode === 'BudgetExceeded') detailBudgetExhausted = true;
        result.snapshot.issues.push({ errorCode, operation, message, retryable: false, completion: 'completed' });
        if (['halted-consistent', 'live-best-effort'].includes(result.snapshot.consistency)) {
          result.snapshot.consistency = 'partial';
          result.snapshot.reason = result.snapshot.reason || message;
        }
      };

      if (options.includeHeap) {
        const before = result.snapshot.diagnostics.bytes;
        try {
          result.snapshot.heap = await readHeapOverview(layout, result.memory);
        } catch (error) {
          recordDetailIssue('heapOverview', error);
        } finally {
          heapBytes = result.snapshot.diagnostics.bytes - before;
        }
        fence();
      }

      const beforeStack = result.snapshot.diagnostics.bytes;
      const stackOutcome = await addStackMetrics(result, this.host.port, options);
      stackBytes = result.snapshot.diagnostics.bytes - beforeStack;
      if (stackOutcome.budgetExceeded) {
        detailBudgetExhausted = true;
        recordDetailIssue('stackScan', new RtosError('BudgetExceeded', stackOutcome.budgetMessage || 'Stack scan budget exhausted'));
      }
      fence();

      if (options.includeObjects || options.objectAddresses?.length) {
        const before = result.snapshot.diagnostics.bytes;
        try {
          result.snapshot.objects = await readObjectSnapshot(layout, result, {
            includeWaitDetails: options.includeWaitDetails,
            objectAddresses: options.objectAddresses,
            readRodata: this.host.readRodata,
          });
        } catch (error) {
          recordDetailIssue('objectSnapshot', error);
        } finally {
          objectBytes = result.snapshot.diagnostics.bytes - before;
        }
        fence();
      }

      if (options.includeTimers) {
        const before = result.snapshot.diagnostics.bytes;
        try {
          result.snapshot.timers = await readTimerSnapshot(layout, result, {
            readRodata: this.host.readRodata,
          });
        } catch (error) {
          recordDetailIssue('timerSnapshot', error);
        } finally {
          timerBytes = result.snapshot.diagnostics.bytes - before;
        }
        fence();
      }

      if (options.includeHeap || (options.taskAddresses?.length ?? 0) > 0 || options.includeObjects || (options.objectAddresses?.length ?? 0) > 0 || options.includeTimers) {
        result.snapshot.diagnostics.detailBudget = {
          limitBytes: detailLimit,
          usedBytes: heapBytes + stackBytes + objectBytes + timerBytes,
          stackBytes,
          objectBytes,
          timerBytes,
          heapBytes,
          exhausted: detailBudgetExhausted,
        };
      }

      result.snapshot.completedAt = Date.now();
      result.snapshot.diagnostics.queueWaitMs = queueWaitMs;
      result.snapshot.diagnostics.ioMs = Math.max(0, result.snapshot.diagnostics.ioMs - queueWaitMs);
      result.snapshot.diagnostics.totalMs = result.snapshot.completedAt - result.snapshot.startedAt;
      result.snapshot.diagnostics.parseMs = Math.max(0, result.snapshot.diagnostics.totalMs - result.snapshot.diagnostics.ioMs - queueWaitMs);
      this.runtime.update(result.snapshot, this.host.port);
      if (result.snapshot.consistency !== 'unavailable' && result.snapshot.tasks.length) this.hints = result.snapshot.tasks.map(task => task.tcbAddress);
      if (['halted-consistent', 'live-best-effort'].includes(result.snapshot.consistency)) {
        this.last = structuredClone(result.snapshot);
      }
      this.counts.completed++;
      return result.snapshot;
    };
    const pending = run().catch(error => {
      if (error instanceof RtosError && ['SessionChanged', 'TargetReadCancelled'].includes(error.errorCode)) this.counts.cancelled++;
      else this.counts.failed++;
      throw error;
    }).finally(() => {
      if (this.inFlight === pending) { this.inFlight = undefined; this.controller = undefined; }
    });
    this.inFlight = pending;
    return pending;
  }
  status() { return { counts: { ...this.counts }, inFlight: !!this.inFlight, polling: this.live, disposed: this.disposed }; }
  stale(reason: string): RtosSnapshot | undefined {
    const identity = this.host.identity();
    if (!this.last || this.last.sessionId !== identity.sessionId || this.last.sessionGeneration !== identity.sessionGeneration
      || this.last.bootGeneration !== identity.bootGeneration || this.last.elfSha256 !== identity.elfSha256) return;
    return { ...structuredClone(this.last), consistency: 'stale', reason };
  }
  start(
    publish: (snapshot: RtosSnapshot) => void,
    intervalMs = 500,
    options: Pick<SnapshotOptions, 'includeObjects' | 'includeWaitDetails' | 'includeTimers' | 'includeHeap' | 'detailBudgetBytes'> = {},
  ) {
    this.stop();
    this.live = true;
    const interval = Math.max(200, Math.min(10000, Number.isFinite(intervalMs) ? intervalMs : 500)), generation = this.pollingGeneration;
    const tick = async () => {
      const started = Date.now();
      try {
        const snapshot = await this.refresh(options);
        if (generation === this.pollingGeneration && !this.disposed) { this.counts.published++; publish(snapshot); }
      } catch { /* Busy/terminated polls do not create work or publish stale data. */ }
      if (generation === this.pollingGeneration && !this.disposed) this.timer = setTimeout(tick, Math.max(0, interval - (Date.now() - started)));
    };
    void tick();
  }
  stop() {
    this.live = false; this.pollingGeneration++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.invalidate('Live refresh stopped');
  }
}
