import { describe, expect, it } from 'vitest';
import { readTaskSnapshot } from './snapshot-reader';
import { syntheticTarget } from './target-fixture';

describe('bounded FreeRTOS task reader', () => {
  it('decodes names, states, current task and independent padded ABI', async () => {
    const target = syntheticTarget(), { snapshot } = await readTaskSnapshot(target.layout, target.request);
    expect(snapshot.consistency).toBe('halted-consistent');
    expect(snapshot.tasks.map(task => [task.name.available && task.name.value, task.state])).toEqual([
      ['idle', 'ready'], ['current', 'running'], ['delayed', 'blocked'], ['suspended', 'suspended'], ['deleted', 'termination'],
    ]);
    expect(snapshot.diagnostics.coveredLists).toHaveLength(7);
    expect(snapshot.diagnostics.bytes).toBeLessThan(1500);
    expect(snapshot.diagnostics.batches).toBeLessThan(15);
  });
  it('handles empty lists, pending-ready membership and indefinite waits', async () => {
    const target = syntheticTarget();
    target.setList('xPendingReadyList', [0x2600], true);
    const { snapshot } = await readTaskSnapshot(target.layout, target.request);
    expect(snapshot.consistency).toBe('halted-consistent');
    expect(snapshot.tasks.find(task => task.tcbAddress === 0x2600)).toMatchObject({ state: 'blocked', lists: ['xSuspendedTaskList', 'xPendingReadyList'] });
  });
  it('walks a deep list in bounded rounds', async () => {
    const target = syntheticTarget(), addresses = Array.from({ length: 40 }, (_, index) => 0x3000 + index * 128);
    for (const [index, address] of addresses.entries()) { target.bytes.copy(target.bytes, address, 0x2200, 0x2200 + 112); target.u32(address + 92, 10 + index); }
    target.setList('ready[0]', addresses); target.u32(0x1004, 44);
    const result = await readTaskSnapshot(target.layout, target.request);
    expect(result.snapshot.tasks).toHaveLength(44);
    expect(result.snapshot.issues).toEqual([]);
    expect(result.snapshot.diagnostics.nodes).toBe(44);
  });
  it.each(['cycle', 'tail', 'owner', 'container', 'invalid-address', 'duplicate'])('reports %s without unbounded reads', async kind => {
    const target = syntheticTarget();
    if (kind === 'cycle') target.u32(0x2200 + 12 + 8, 0x2200 + 12);
    if (kind === 'tail') target.u32(0x1020 + 28, 0x2200);
    if (kind === 'owner') target.u32(0x2200 + 12 + 16, 0x2400);
    if (kind === 'container') target.u32(0x2200 + 12 + 20, 0x10a0);
    if (kind === 'invalid-address') target.u32(0x1020 + 24, 0xdead0000);
    if (kind === 'duplicate') { target.u32(0x1060 + 24, 0x220c); }
    const { snapshot } = await readTaskSnapshot(target.layout, target.request);
    expect(snapshot.consistency).toBe('partial');
    expect(snapshot.issues.length).toBeGreaterThan(0);
    expect(snapshot.diagnostics.batches).toBeLessThan(20);
  });
  it('retains short-read diagnostics and enforces byte/node/time budgets', async () => {
    const target = syntheticTarget(); target.request.read = async () => new Uint8Array(1);
    expect((await readTaskSnapshot(target.layout, target.request)).snapshot.issues[0]).toMatchObject({ errorCode: 'ShortRead' });
    for (const limits of [{ bytes: 4 }, { nodes: 2 }, { batches: 1 }]) {
      const target = syntheticTarget(); target.request.limits = limits;
      expect((await readTaskSnapshot(target.layout, target.request)).snapshot.issues[0].errorCode).toBe('BudgetExceeded');
    }
    const slow = syntheticTarget(); slow.request.limits = { timeMs: 1 };
    slow.request.read = async (a, n) => { await new Promise(resolve => setTimeout(resolve, 5)); return slow.bytes.subarray(a, a + n); };
    expect((await readTaskSnapshot(slow.layout, slow.request)).snapshot.issues[0].errorCode).toBe('BudgetExceeded');
  });
  it('marks changing anchors partial, stable running anchors best effort and cancellation unavailable', async () => {
    const target = syntheticTarget(); target.request.targetState = 'Running';
    expect((await readTaskSnapshot(target.layout, target.request)).snapshot.consistency).toBe('live-best-effort');
    let calls = 0;
    target.request.read = async (a, n) => { if (++calls === 3) target.u32(0x1000, 0x2200); return Buffer.from(target.bytes.subarray(a, a + n)); };
    expect((await readTaskSnapshot(target.layout, target.request)).snapshot.issues[0].errorCode).toBe('SnapshotChanged');
    target.controller.abort();
    const cancelled = (await readTaskSnapshot(target.layout, target.request)).snapshot;
    expect(cancelled.consistency).toBe('unavailable'); expect(cancelled.tasks).toEqual([]);
  });
});
