import { describe, expect, it } from 'vitest';
import { compileFreeRtosLayout } from './freertos-layout';
import { readTaskSnapshot } from './snapshot-reader';
import { RtosSnapshotService, SnapshotHost } from './snapshot-service';
import { syntheticTarget } from './target-fixture';
import { PortContract } from './task-metrics';
import { testCatalog } from './test-fixture';
import { readHeapOverview, readTimerSnapshot } from './timer-heap-reader';
import type { SymbolCatalog } from '../symbols/symbol-catalog';

function timerHeapCatalog(opts: { timers?: boolean; allocator?: 'heap_4' | 'heap_5' | 'heap_1' | 'none' } = {}): SymbolCatalog {
  const catalog = testCatalog();
  catalog.types.i8 = { name: 'int8_t', kind: 'base', byteSize: 1 };
  catalog.types.u8 = { name: 'uint8_t', kind: 'base', byteSize: 1 };
  catalog.types.charPtr = { name: '', kind: 'pointer', byteSize: 4, typeOffset: 'char' };
  catalog.types.voidPtr = { name: '', kind: 'pointer', byteSize: 4, typeOffset: 'u32' };
  catalog.types.listPtr = { name: '', kind: 'pointer', byteSize: 4, typeOffset: 'list' };

  // Extend ListItem_t with xItemValue (at unused byteOffset 0) so active expiry ticks resolve cleanly.
  catalog.types.item.fields!.push({ name: 'xItemValue', byteOffset: 0, typeOffset: 'u32' });

  if (opts.timers !== false) {
    catalog.types.timerStruct = {
      name: 'tmrTimerControl',
      kind: 'struct',
      byteSize: 48,
      fields: [
        { name: 'pcTimerName', byteOffset: 0, typeOffset: 'charPtr' },
        { name: 'xTimerListItem', byteOffset: 4, typeOffset: 'item' },
        { name: 'xTimerPeriodInTicks', byteOffset: 28, typeOffset: 'u32' },
        { name: 'pvTimerID', byteOffset: 32, typeOffset: 'voidPtr' },
        { name: 'pxCallbackFunction', byteOffset: 36, typeOffset: 'voidPtr' },
        { name: 'uxTimerNumber', byteOffset: 40, typeOffset: 'u32' },
        { name: 'ucStatus', byteOffset: 44, typeOffset: 'u8' },
      ],
    };
    catalog.types.timerPtr = { name: '', kind: 'pointer', byteSize: 4, typeOffset: 'timerStruct' };
    catalog.types.staticTimer = { name: 'xSTATIC_TIMER', kind: 'struct', byteSize: 48, fields: [] };
    catalog.roots.push(
      { id: '100', expression: 'xActiveTimerList1', address: 0x3200, typeOffset: 'list', size: 32, file: 'kernel/timers.c', pointerDepth: 0 },
      { id: '101', expression: 'xActiveTimerList2', address: 0x3220, typeOffset: 'list', size: 32, file: 'kernel/timers.c', pointerDepth: 0 },
      { id: '102', expression: 'pxCurrentTimerList', address: 0x3240, typeOffset: 'listPtr', size: 4, file: 'kernel/timers.c', pointerDepth: 0 },
      { id: '103', expression: 'pxOverflowTimerList', address: 0x3244, typeOffset: 'listPtr', size: 4, file: 'kernel/timers.c', pointerDepth: 0 },
      { id: '104', expression: 'xTickCount', address: 0x3248, typeOffset: 'u32', size: 4, file: 'kernel/tasks.c', pointerDepth: 0 },
      { id: '105', expression: 'gActiveTimer', address: 0x3250, typeOffset: 'timerPtr', size: 4, file: 'app/main.c', pointerDepth: 0 },
      { id: '106', expression: 'gStoppedTimer', address: 0x3254, typeOffset: 'timerPtr', size: 4, file: 'app/main.c', pointerDepth: 0 },
      { id: '107', expression: 'gStaticStoppedTimer', address: 0x6200, typeOffset: 'staticTimer', size: 48, file: 'app/main.c', pointerDepth: 0 },
    );
  }

  const alloc = opts.allocator ?? 'heap_4';
  if (alloc === 'heap_4' || alloc === 'heap_5') {
    catalog.types.blockLink = {
      name: 'A_BLOCK_LINK',
      kind: 'struct',
      byteSize: 8,
      fields: [
        { name: 'pxNextFreeBlock', byteOffset: 0, typeOffset: 'voidPtr' },
        { name: 'xBlockSize', byteOffset: 4, typeOffset: 'u32' },
      ],
    };
    catalog.types.blockLinkPtr = { name: '', kind: 'pointer', byteSize: 4, typeOffset: 'blockLink' };
    if (alloc === 'heap_4') {
      catalog.types.heapBuf = { name: '', kind: 'array', byteSize: 4096, arrayCount: 4096, typeOffset: 'char' };
      catalog.roots.push({ id: '110', expression: 'ucHeap', address: 0x7000, typeOffset: 'heapBuf', size: 4096, file: 'heap_4.c', pointerDepth: 0 });
    }
    catalog.roots.push(
      { id: '111', expression: 'xStart', address: 0x3300, typeOffset: 'blockLink', size: 8, file: `${alloc}.c`, pointerDepth: 0 },
      { id: '112', expression: 'pxEnd', address: 0x3308, typeOffset: 'blockLinkPtr', size: 4, file: `${alloc}.c`, pointerDepth: 0 },
      { id: '113', expression: 'xFreeBytesRemaining', address: 0x330c, typeOffset: 'u32', size: 4, file: `${alloc}.c`, pointerDepth: 0 },
      { id: '114', expression: 'xMinimumEverFreeBytesRemaining', address: 0x3310, typeOffset: 'u32', size: 4, file: `${alloc}.c`, pointerDepth: 0 },
      { id: '115', expression: 'xNumberOfSuccessfulAllocations', address: 0x3314, typeOffset: 'u32', size: 4, file: `${alloc}.c`, pointerDepth: 0 },
      { id: '116', expression: 'xNumberOfSuccessfulFrees', address: 0x3318, typeOffset: 'u32', size: 4, file: `${alloc}.c`, pointerDepth: 0 },
    );
  } else if (alloc === 'heap_1') {
    catalog.types.heapBuf = { name: '', kind: 'array', byteSize: 2048, arrayCount: 2048, typeOffset: 'char' };
    catalog.roots.push(
      { id: '110', expression: 'ucHeap', address: 0x7000, typeOffset: 'heapBuf', size: 2048, file: 'heap_1.c', pointerDepth: 0 },
      { id: '117', expression: 'xNextFreeByte', address: 0x3320, typeOffset: 'u32', size: 4, file: 'heap_1.c', pointerDepth: 0 },
    );
  }
  return catalog;
}

function setupTimerHeapTarget(opts: { timers?: boolean; allocator?: 'heap_4' | 'heap_5' | 'heap_1' | 'none' } = {}) {
  const base = syntheticTarget();
  const catalog = timerHeapCatalog(opts);
  const layout = compileFreeRtosLayout(catalog, 'th-test');
  const bytes = Buffer.from(base.bytes);
  const u32 = (addr: number, val: number) => bytes.writeUInt32LE(val >>> 0, addr);
  const u8 = (addr: number, val: number) => bytes.writeUInt8(val & 0xff, addr);

  const setTimerList = (listAddr: number, entries: { timerAddr: number; expiry: number }[]) => {
    const sentinel = listAddr + 16;
    const items = entries.map(e => e.timerAddr + 4); // xTimerListItem
    u32(listAddr + 4, entries.length);
    u32(listAddr + 24, items[0] ?? sentinel);
    u32(listAddr + 28, items.at(-1) ?? sentinel);
    entries.forEach((entry, idx) => {
      const node = items[idx];
      u32(node + 0, entry.expiry);
      u32(node + 8, items[idx + 1] ?? sentinel);
      u32(node + 12, items[idx - 1] ?? sentinel);
      u32(node + 16, entry.timerAddr);
      u32(node + 20, listAddr);
    });
  };

  const writeTimer = (addr: number, cfg: {
    namePtr: number;
    periodTicks: number;
    timerId: number;
    callback: number;
    timerNumber: number;
    status: number;
    expiry?: number;
  }) => {
    u32(addr + 0, cfg.namePtr);
    u32(addr + 4, cfg.expiry ?? 0);
    u32(addr + 28, cfg.periodTicks);
    u32(addr + 32, cfg.timerId);
    u32(addr + 36, cfg.callback);
    u32(addr + 40, cfg.timerNumber);
    u8(addr + 44, cfg.status);
  };

  const rodata = new Map<number, Buffer>();
  const request = {
    ...base.request,
    identity: { ...base.request.identity, elfSha256: 'th-test', layoutId: layout.layoutId },
    read: async (address: number, size: number) => bytes.subarray(address, address + size),
  };
  const readRodata = (addr: number, maxBytes: number) => {
    const buf = rodata.get(addr);
    return buf ? buf.subarray(0, Math.min(maxBytes, buf.length)) : undefined;
  };
  return { catalog, layout, bytes, u32, u8, setTimerList, writeTimer, rodata, readRodata, request };
}

describe('FreeRTOS software timers, heap overview, and unified detail budget', () => {
  it('reads current active, overflow active, and global stopped timers with honest coverage bounds', async () => {
    const t = setupTimerHeapTarget();
    t.rodata.set(0x08002000, Buffer.from('hbTimer\0'));
    t.rodata.set(0x08002020, Buffer.from('ovfTimer\0'));
    t.bytes.write('stoppedRam\0', 0x6800, 'utf8');

    t.u32(0x3240, 0x3200); // pxCurrentTimerList = xActiveTimerList1
    t.u32(0x3244, 0x3220); // pxOverflowTimerList = xActiveTimerList2
    t.u32(0x3248, 420); // xTickCount = 420

    // Active-current auto-reload timer at 0x6000 referenced by gActiveTimer too
    t.writeTimer(0x6000, { namePtr: 0x08002000, periodTicks: 100, timerId: 1, callback: 0x08000501, timerNumber: 1, status: 0x05 });
    t.u32(0x3250, 0x6000);
    t.setTimerList(0x3200, [{ timerAddr: 0x6000, expiry: 520 }]);

    // Active-overflow one-shot static timer at 0x6100
    t.writeTimer(0x6100, { namePtr: 0x08002020, periodTicks: 500, timerId: 2, callback: 0x08000601, timerNumber: 2, status: 0x03 });
    t.setTimerList(0x3220, [{ timerAddr: 0x6100, expiry: 100 }]);

    // Stopped dynamic timer via gStoppedTimer handle at 0x6300 (RAM name string)
    t.writeTimer(0x6300, { namePtr: 0x6800, periodTicks: 50, timerId: 3, callback: 0x08000701, timerNumber: 3, status: 0x00 });
    t.u32(0x3254, 0x6300);

    // Stopped static timer via gStaticStoppedTimer at 0x6200 (NULL name -> ELF symbol fallback)
    t.writeTimer(0x6200, { namePtr: 0, periodTicks: 25, timerId: 4, callback: 0x08000801, timerNumber: 4, status: 0x02 });

    const taskResult = await readTaskSnapshot(t.layout, t.request);
    const timers = await readTimerSnapshot(t.layout, taskResult, { readRodata: t.readRodata });

    expect(timers.enabled).toBe(true);
    expect(timers.tickCount).toMatchObject({ available: true, value: 420 });
    expect(timers.activeCurrentCount).toBe(1);
    expect(timers.activeOverflowCount).toBe(1);
    expect(timers.globalStoppedCount).toBe(2);
    expect(timers.timers).toHaveLength(4);

    const active = timers.timers.find(x => x.address === 0x6000)!;
    expect(active.listState).toBe('active-current');
    expect(active.discoverySources).toEqual(['list', 'global']);
    expect(active.name).toMatchObject({ available: true, value: 'hbTimer' });
    expect(active.autoReload).toMatchObject({ available: true, value: true });
    expect(active.expiryTick).toMatchObject({ available: true, value: 520 });

    const ovf = timers.timers.find(x => x.address === 0x6100)!;
    expect(ovf.listState).toBe('active-overflow');
    expect(ovf.staticallyAllocated).toMatchObject({ available: true, value: true });
    expect(ovf.expiryTick).toMatchObject({ available: true, value: 100 });

    const stoppedDyn = timers.timers.find(x => x.address === 0x6300)!;
    expect(stoppedDyn.listState).toBe('stopped-global');
    expect(stoppedDyn.name).toMatchObject({ available: true, value: 'stoppedRam' });
    expect(stoppedDyn.expiryTick.available).toBe(false);

    const stoppedStatic = timers.timers.find(x => x.address === 0x6200)!;
    expect(stoppedStatic.symbolName).toBe('gStaticStoppedTimer');
    expect(stoppedStatic.name).toMatchObject({ available: true, value: 'gStaticStoppedTimer' });
  });

  it('reports configUSE_TIMERS disabled state and corrupt timer pointers cleanly', async () => {
    const disabled = setupTimerHeapTarget({ timers: false });
    const disabledTasks = await readTaskSnapshot(disabled.layout, disabled.request);
    const disabledTimers = await readTimerSnapshot(disabled.layout, disabledTasks);
    expect(disabledTimers.enabled).toBe(false);
    expect(disabledTimers.timers).toEqual([]);
    expect(disabledTimers.unavailableReason).toContain('Software timers disabled');

    const bad = setupTimerHeapTarget();
    bad.u32(0x3240, 0x3200);
    bad.u32(0x3244, 0x3220);
    bad.setTimerList(0x3200, []);
    bad.setTimerList(0x3220, []);
    // Dangling global handle outside RAM + zeroed static period
    bad.u32(0x3250, 0xdead0001);
    bad.writeTimer(0x6200, { namePtr: 0, periodTicks: 0, timerId: 0, callback: 0, timerNumber: 0, status: 0x02 });

    const badTasks = await readTaskSnapshot(bad.layout, bad.request);
    const badTimers = await readTimerSnapshot(bad.layout, badTasks);
    const dangling = badTimers.timers.find(x => x.address === 0xdead0001)!;
    expect(dangling.health).toBe('deleting-or-corrupt');
    const zeroPeriod = badTimers.timers.find(x => x.address === 0x6200)!;
    expect(zeroPeriod.health).toBe('deleting-or-corrupt');
    expect(zeroPeriod.healthReason).toContain('xTimerPeriodInTicks==0');
  });

  it('decodes initialized/uninitialized heap_4 accurately and degrades unsupported allocators without guessing', async () => {
    const t = setupTimerHeapTarget({ allocator: 'heap_4' });
    // Before prvHeapInit: pxEnd == 0
    let taskRes = await readTaskSnapshot(t.layout, t.request);
    const uninit = await readHeapOverview(t.layout, taskRes.memory);
    expect(uninit.allocator).toBe('heap_4');
    expect(uninit.supported).toBe(true);
    expect(uninit.initialized).toBe(false);
    expect(uninit.configuredBytes).toMatchObject({ available: true, value: 4096 });
    expect(uninit.freeBytes.available).toBe(false);

    // Initialized heap_4: ucHeap = 0x7000..0x8000, pxEnd = 0x7ff8 -> usable = 4088 B
    t.u32(0x3308, 0x7ff8);
    t.u32(0x330c, 3000);
    t.u32(0x3310, 2500);
    t.u32(0x3314, 14);
    t.u32(0x3318, 3);
    taskRes = await readTaskSnapshot(t.layout, t.request);
    const init = await readHeapOverview(t.layout, taskRes.memory);
    expect(init.initialized).toBe(true);
    expect(init.usableBytes).toMatchObject({ available: true, value: 4088 });
    expect(init.freeBytes).toMatchObject({ available: true, value: 3000 });
    expect(init.usedBytes).toMatchObject({ available: true, value: 1088 });
    expect(init.minimumEverFreeBytes).toMatchObject({ available: true, value: 2500 });
    expect(init.successfulAllocations).toMatchObject({ available: true, value: 14 });
    expect(init.successfulFrees).toMatchObject({ available: true, value: 3 });

    // Non-heap_4 allocators remain explicitly unsupported without guessing fragmentation/totals.
    for (const allocator of ['heap_5', 'heap_1', 'none'] as const) {
      const other = setupTimerHeapTarget({ allocator });
      const res = await readTaskSnapshot(other.layout, other.request);
      const heap = await readHeapOverview(other.layout, res.memory);
      expect(heap.supported).toBe(false);
      expect(heap.freeBytes.available).toBe(false);
      expect(heap.unavailableReason).toBeTruthy();
    }
  });

  it('enforces unified detail refresh budget across stack scan, timers, objects, and heap', async () => {
    const t = setupTimerHeapTarget({ allocator: 'heap_4' });
    t.u32(0x3240, 0x3200);
    t.u32(0x3244, 0x3220);
    t.setTimerList(0x3200, []);
    t.setTimerList(0x3220, []);
    t.u32(0x3308, 0x7ff8);
    t.u32(0x330c, 3000);

    const port: PortContract = { source: 'test-port', stackGrowth: 'down', stackFillByte: 0xa5 };
    const host: SnapshotHost = {
      identity: () => ({ sessionId: 's', sessionGeneration: 1, operationGeneration: 1, bootGeneration: 1, elfSha256: 'th-test' }),
      targetState: () => 'Halted',
      available: () => true,
      catalog: async () => t.catalog,
      port,
      ram: [{ start: 0x1000, size: 0xf000 }],
      read: async (address, size) => ({ bytes: t.bytes.subarray(address, address + size), queueWaitMs: 0 }),
      readRodata: t.readRodata,
    };
    const service = new RtosSnapshotService(host);

    // Within healthy unified budget, all sections populate and diagnostics.detailBudget sums accurately.
    const full = await service.refresh({
      taskAddresses: [0x2000, 0x2200],
      maxBytesPerTask: 256,
      includeObjects: true,
      includeTimers: true,
      includeHeap: true,
      detailBudgetBytes: 8192,
    });
    expect(full.consistency).toBe('halted-consistent');
    expect(full.heap?.initialized).toBe(true);
    expect(full.timers?.enabled).toBe(true);
    expect(full.diagnostics.detailBudget).toMatchObject({
      limitBytes: 8192,
      exhausted: false,
    });
    expect(full.diagnostics.detailBudget!.usedBytes).toBe(
      full.diagnostics.detailBudget!.heapBytes
      + full.diagnostics.detailBudget!.stackBytes
      + full.diagnostics.detailBudget!.objectBytes
      + full.diagnostics.detailBudget!.timerBytes,
    );

    // Tight unified budget (320 B for details) exhausts during stack scan + blocks subsequent heavy detail reads while keeping all core tasks + heap!
    const bounded = await service.refresh({
      taskAddresses: [0x2000, 0x2200],
      maxBytesPerTask: 256,
      includeObjects: true,
      includeTimers: true,
      includeHeap: true,
      detailBudgetBytes: 320,
    });
    expect(bounded.tasks).toHaveLength(5);
    expect(bounded.heap?.initialized).toBe(true);
    expect(bounded.consistency).toBe('partial');
    expect(bounded.diagnostics.detailBudget?.exhausted).toBe(true);
    expect(bounded.diagnostics.detailBudget!.usedBytes).toBeLessThanOrEqual(320);
    expect(bounded.issues.some(i => i.errorCode === 'BudgetExceeded')).toBe(true);
    service.dispose();
  });
});
