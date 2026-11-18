import { Field, known, unknown, RtosSnapshot } from './model';
import { SnapshotReadResult } from './snapshot-reader';

/** Explicit port evidence; neither DWARF nor CPU model proves a fill pattern/timebase. */
export interface PortContract {
  source: string;
  stackGrowth?: 'down' | 'up';
  stackFillByte?: number;
  runtime?: { frequencyHz: number; countsDuringSleep: boolean; source: string };
}
export interface StackScanOptions { taskAddresses?: number[]; maxBytesPerTask?: number; }

export async function addStackMetrics(result: SnapshotReadResult, port: PortContract | undefined, options: StackScanOptions = {}) {
  const { snapshot, memory } = result;
  if (!port?.stackGrowth || !port.source || snapshot.consistency === 'unavailable') return;
  for (const task of snapshot.tasks) {
    const stack = task.stack;
    stack.growthDirection = known(port.stackGrowth, port.source, 'enum');
    if (port.stackFillByte !== undefined && Number.isInteger(port.stackFillByte) && port.stackFillByte >= 0 && port.stackFillByte <= 255)
      stack.fillByte = known(port.stackFillByte, port.source, 'byte');
    if (!stack.base.available || !stack.end.available || !stack.wordBytes.available) continue;
    const base = stack.base.value, end = stack.end.value, word = stack.wordBytes.value;
    // pxEndOfStack is the last StackType_t, not a one-past pointer.
    const low = Math.min(base, end), high = Math.max(base, end) + word, capacity = high - low;
    try { memory.validate(low, capacity); } catch {
      stack.capacityBytes = unknown('Stack bounds outside declared RAM', 'TCB stack bounds', 'bytes'); continue;
    }
    if (base % word || end % word || capacity % word || (port.stackGrowth === 'down' ? end < base : end > base)) {
      stack.capacityBytes = unknown('Invalid stack bounds/direction', 'TCB stack bounds', 'bytes'); continue;
    }
    stack.capacityBytes = known(capacity, `TCB.pxStack/pxEndOfStack; ${port.source}`, 'bytes');
    if (!options.taskAddresses?.includes(task.tcbAddress) || !stack.fillByte.available) continue;
    const started = Date.now(), fill = stack.fillByte.value;
    const maxBytes = Math.min(capacity, 16384, Math.max(1, options.maxBytesPerTask ?? 4096));
    let untouched = 0, done = false;
    try {
      while (stack.scannedBytes < maxBytes) {
        const count = Math.min(256, maxBytes - stack.scannedBytes);
        const address = port.stackGrowth === 'down' ? low + stack.scannedBytes : high - stack.scannedBytes - count;
        const [bytes] = await memory.many([{ start: address, size: count }]);
        stack.scannedBytes += bytes.length;
        const ordered = port.stackGrowth === 'down' ? bytes : Uint8Array.from(bytes).reverse();
        for (const byte of ordered) { if (byte !== fill) { done = true; break; } untouched++; }
        if (done) break;
      }
      stack.scanComplete = done || stack.scannedBytes === capacity;
      stack.watermarkBytes = stack.scanComplete
        ? known(Math.floor(untouched / word) * word, `FreeRTOS unused stack fill scan; ${port.source}`, 'bytes')
        : unknown(`Scan budget reached after ${stack.scannedBytes} bytes; unused prefix >= ${untouched}`, 'Stack fill scan', 'bytes');
    } catch (error) {
      stack.watermarkBytes = unknown(error instanceof Error ? error.message : String(error), 'Stack fill scan', 'bytes');
      if (memory.request.signal.aborted) throw error;
    } finally { stack.scanMs = Date.now() - started; }
  }
}

export function counterDelta(previous: bigint, current: bigint, bits: number, maxDelta: bigint): bigint | undefined {
  if (!Number.isInteger(bits) || bits < 1 || bits > 64 || maxDelta < 0n) return;
  const modulus = 1n << BigInt(bits);
  if (maxDelta >= modulus || previous < 0n || current < 0n || previous >= modulus || current >= modulus) return;
  const delta = (current - previous + modulus) % modulus;
  return delta <= maxDelta ? delta : undefined;
}

/** Settled kernel time, including ISR charged to the task; not sampling hit counts. */
export class TaskRuntimeTracker {
  private previous?: { snapshot: RtosSnapshot; monotonicMs: number; key: string };
  clear() { this.previous = undefined; }
  update(snapshot: RtosSnapshot, port?: PortContract, monotonicMs = performance.now()) {
    const contract = port?.runtime;
    const key = JSON.stringify([snapshot.sessionId, snapshot.sessionGeneration, snapshot.bootGeneration, snapshot.operationGeneration,
      snapshot.elfSha256, snapshot.layoutId, contract]);
    const previous = this.previous;
    const valid = ['halted-consistent', 'live-best-effort'].includes(snapshot.consistency);
    this.previous = valid ? { snapshot: structuredClone(snapshot), monotonicMs, key } : undefined;
    if (!valid || !contract || !contract.source || !Number.isFinite(contract.frequencyHz) || contract.frequencyHz <= 0) return;
    const unavailable = (reason: string): Field<number> => unknown(reason, contract.source, 'percent');
    if (!previous || previous.key !== key) { for (const task of snapshot.tasks) task.runtime.percent = unavailable('First interval or identity changed'); return; }
    const elapsed = monotonicMs - previous.monotonicMs;
    if (elapsed <= 0 || !snapshot.runtimeTotal.available || !previous.snapshot.runtimeTotal.available || !snapshot.runtimeTotalBits.available
      || !previous.snapshot.runtimeTotalBits.available || snapshot.runtimeTotalBits.value !== previous.snapshot.runtimeTotalBits.value) return;
    // A small timing margin includes the acquisition endpoints. A full source wrap is never inferred.
    const bound = BigInt(Math.ceil(contract.frequencyHz * (elapsed + snapshot.diagnostics.totalMs + previous.snapshot.diagnostics.totalMs + 10) / 1000));
    const total = counterDelta(BigInt(previous.snapshot.runtimeTotal.value), BigInt(snapshot.runtimeTotal.value), snapshot.runtimeTotalBits.value, bound);
    for (const task of snapshot.tasks) {
      const old = previous.snapshot.tasks.find(candidate => candidate.tcbAddress === task.tcbAddress);
      const same = task.creationNumber.available && old?.creationNumber.available && task.creationNumber.value === old.creationNumber.value;
      if (!same || !task.runtime.counter.available || !old?.runtime.counter.available || !task.runtime.bits.available || !old.runtime.bits.available
        || task.runtime.bits.value !== old.runtime.bits.value || total === undefined || total === 0n) {
        task.runtime.percent = unavailable(total === 0n ? 'Zero settled interval' : 'Missing identity, reset, wrap ambiguity or counter'); continue;
      }
      const delta = counterDelta(BigInt(old.runtime.counter.value), BigInt(task.runtime.counter.value), task.runtime.bits.value, bound);
      if (delta === undefined || delta > total) { task.runtime.percent = unavailable('Counter reset or inconsistent accounting interval'); continue; }
      task.runtime.percent = known(Number(delta * 1000000n / total) / 10000,
        `${contract.source}; settled kernel counters, ISR charged to current task, sleep=${contract.countsDuringSleep ? 'counted' : 'excluded'}`, 'percent');
      task.runtime.intervalMs = known(elapsed, 'Host monotonic interval; denominator=ulTotalRunTime delta', 'ms');
    }
  }
}
