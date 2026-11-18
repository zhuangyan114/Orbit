import { describe, expect, it } from 'vitest';
import { known } from './model';
import { readTaskSnapshot } from './snapshot-reader';
import { syntheticTarget } from './target-fixture';
import { addStackMetrics, counterDelta, PortContract, TaskRuntimeTracker } from './task-metrics';

const port: PortContract = { source: 'test-port', stackGrowth: 'down', stackFillByte: 0xa5,
  runtime: { source: 'test counter; sleep excluded', frequencyHz: 1000, countsDuringSleep: false } };
async function sample() {
  const target = syntheticTarget(), result = await readTaskSnapshot(target.layout, target.request);
  result.snapshot.runtimeTotal = known('1000', 'kernel total', 'ticks');
  result.snapshot.runtimeTotalBits = known(32, 'DWARF', 'bits');
  return result;
}
describe('stack and runtime metrics', () => {
  it('scans only requested tasks, reports unused fill bytes rather than SP delta', async () => {
    const result = await sample();
    await addStackMetrics(result, port, { taskAddresses: [0x2000] });
    const task = result.snapshot.tasks.find(task => task.tcbAddress === 0x2000)!;
    expect(task.stack.capacityBytes).toMatchObject({ available: true, value: 256 });
    expect(task.stack.watermarkBytes).toMatchObject({ available: true, value: 64 });
    expect(task.stack.scannedBytes).toBe(256);
    expect(result.snapshot.tasks.find(task => task.tcbAddress === 0x2200)!.stack.scannedBytes).toBe(0);
  });
  it('keeps missing bounds, unknown fill and partial scans unavailable', async () => {
    const noPort = await sample(); await addStackMetrics(noPort, undefined, { taskAddresses: [0x2000] });
    expect(noPort.snapshot.tasks[0].stack.capacityBytes.available).toBe(false);
    const partial = await sample(); await addStackMetrics(partial, port, { taskAddresses: [0x2000], maxBytesPerTask: 32 });
    const stack = partial.snapshot.tasks.find(task => task.tcbAddress === 0x2000)!.stack;
    expect(stack.scanComplete).toBe(false); expect(stack.watermarkBytes.available).toBe(false);
    const missing = await sample(); missing.snapshot.tasks[0].stack.end = { available: false, reason: 'not recorded', source: 'TCB', unit: 'address' };
    await addStackMetrics(missing, port); expect(missing.snapshot.tasks[0].stack.capacityBytes.available).toBe(false);
  });
  it('calculates settled kernel counter differences and documents sleep/ISR accounting', async () => {
    const tracker = new TaskRuntimeTracker(), first = (await sample()).snapshot;
    tracker.update(first, port, 1000);
    expect(first.tasks[0].runtime.percent.available).toBe(false);
    const next = structuredClone(first); next.runtimeTotal = known('2000', 'kernel total', 'ticks');
    next.tasks[0].runtime.counter = known('350', 'kernel task', 'ticks');
    tracker.update(next, port, 2000);
    expect(next.tasks[0].runtime.percent).toMatchObject({ available: true, value: 25, unit: 'percent' });
    expect(next.tasks[0].runtime.percent.source).toContain('ISR charged');
  });
  it('distinguishes bounded wrap from reset, missing counters and uncertain/multiple wraps', () => {
    expect(counterDelta(0xfffffff0n, 0x20n, 32, 100n)).toBe(48n);
    expect(counterDelta(10000n, 5n, 32, 100n)).toBeUndefined();
    expect(counterDelta(100n, 200n, 32, 1n << 32n)).toBeUndefined();
  });
  it('never carries intervals across address reuse, boot/control/session changes or partial snapshots', async () => {
    for (const change of ['creation', 'boot', 'operation', 'session', 'partial', 'zero', 'reset']) {
      const tracker = new TaskRuntimeTracker(), first = (await sample()).snapshot;
      tracker.update(first, port, 1000);
      const next = structuredClone(first); next.runtimeTotal = known('2000', 'kernel total', 'ticks');
      if (change === 'creation') next.tasks[0].creationNumber = known('900', 'TCB', 'count');
      if (change === 'boot') next.bootGeneration++;
      if (change === 'operation') next.operationGeneration++;
      if (change === 'session') next.sessionId = 'new';
      if (change === 'partial') next.consistency = 'partial';
      if (change === 'zero') next.runtimeTotal = first.runtimeTotal;
      if (change === 'reset') next.runtimeTotal = known('1', 'kernel total', 'ticks');
      tracker.update(next, port, 2000);
      expect(next.tasks[0].runtime.percent.available, change).toBe(false);
    }
  });
  it('requires an explicit timebase even when counters exist', async () => {
    const tracker = new TaskRuntimeTracker(), result = await sample(); tracker.update(result.snapshot);
    const next = structuredClone(result.snapshot); next.runtimeTotal = known('2000', 'kernel total', 'ticks');
    tracker.update(next);
    expect(next.tasks.every(task => !task.runtime.percent.available)).toBe(true);
  });
});
