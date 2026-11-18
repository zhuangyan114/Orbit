import { describe, expect, it } from 'vitest';
import { existsSync } from 'fs';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { buildSymbolCatalog, parseDwarfTypeInfo, readElfSymbols } from '../ozone-backend/jlink-symbols';
import { compileFreeRtosLayout, FreeRtosLayoutCache } from './freertos-layout';
import { testCatalog } from './test-fixture';

describe('FreeRTOS layout compiler', () => {
  it('follows the root DIE through qualifiers, ignoring unrelated same-named types', () => {
    const plan = compileFreeRtosLayout(testCatalog(), 'a');
    expect(plan.tcb.fields.xStateListItem.offset).toBe(12);
    expect(plan.list.endNext.offset).toBe(24);
    expect(plan.tcb.stackWordBytes).toBe(4);
    expect(plan.lists).toHaveLength(7);
  });
  it('reports absent kernels, missing DWARF and ambiguous global roots', () => {
    const catalog = testCatalog();
    catalog.roots = [];
    expect(() => compileFreeRtosLayout(catalog, 'a')).toThrow('Missing kernel root');
    const missing = testCatalog(); missing.roots[0].typeOffset = '';
    expect(() => compileFreeRtosLayout(missing, 'a')).toThrow('No DWARF');
    const ambiguous = testCatalog(); ambiguous.roots.push({ ...ambiguous.roots[0], address: 0x2000 });
    expect(() => compileFreeRtosLayout(ambiguous, 'a')).toThrow('Multiple globals');
  });
  it('rejects truncated/bitfield members and unknown pointer ABIs', () => {
    for (const corrupt of [(c: ReturnType<typeof testCatalog>) => { c.types.tcb.byteSize = 20; },
      (c: ReturnType<typeof testCatalog>) => { c.types.taskPtr.byteSize = 8; },
      (c: ReturnType<typeof testCatalog>) => { c.types.list.fields![0].bitSize = 2; }]) {
      const c = testCatalog(); corrupt(c); expect(() => compileFreeRtosLayout(c, 'a')).toThrow();
    }
  });
  it('degrades optional fields and keys layouts by ELF contents', () => {
    const c = testCatalog(); c.types.tcb.fields = c.types.tcb.fields!.filter(f => f.name !== 'ulRunTimeCounter');
    const cache = new FreeRtosLayoutCache(), a = cache.get(c, 'a');
    expect(a.tcb.fields.ulRunTimeCounter).toBeUndefined();
    expect(cache.get(c, 'a')).toBe(a);
    expect(cache.get(c, 'b').layoutId).not.toBe(a.layoutId);
  });

  it('compiles QueueDefinition from registry, globals or concrete struct and degrades queue-only ambiguity without failing task layout', () => {
    const withQueue = testCatalog();
    withQueue.types.i8 = { name: 'int8_t', kind: 'base', byteSize: 1 };
    withQueue.types.u8 = { name: 'uint8_t', kind: 'base', byteSize: 1 };
    withQueue.types.charPtr = { name: '', kind: 'pointer', byteSize: 4, typeOffset: 'char' };
    withQueue.types.semStruct = { name: '', kind: 'struct', byteSize: 8, fields: [
      { name: 'xMutexHolder', byteOffset: 0, typeOffset: 'taskPtr' },
      { name: 'uxRecursiveCallCount', byteOffset: 4, typeOffset: 'u32' },
    ] };
    withQueue.types.queueUnion = { name: '', kind: 'union', byteSize: 8, fields: [
      { name: 'xSemaphore', byteOffset: 0, typeOffset: 'semStruct' },
    ] };
    withQueue.types.queueDef = { name: 'QueueDefinition', kind: 'struct', byteSize: 96, fields: [
      { name: 'pcHead', byteOffset: 0, typeOffset: 'charPtr' },
      { name: 'u', byteOffset: 8, typeOffset: 'queueUnion' },
      { name: 'xTasksWaitingToSend', byteOffset: 16, typeOffset: 'list' },
      { name: 'xTasksWaitingToReceive', byteOffset: 48, typeOffset: 'list' },
      { name: 'uxMessagesWaiting', byteOffset: 80, typeOffset: 'u32' },
      { name: 'uxLength', byteOffset: 84, typeOffset: 'u32' },
      { name: 'uxItemSize', byteOffset: 88, typeOffset: 'u32' },
      { name: 'cRxLock', byteOffset: 92, typeOffset: 'i8' },
      { name: 'cTxLock', byteOffset: 93, typeOffset: 'i8' },
      { name: 'ucQueueType', byteOffset: 94, typeOffset: 'u8' },
    ] };
    withQueue.types.queuePtr = { name: '', kind: 'pointer', byteSize: 4, typeOffset: 'queueDef' };
    withQueue.types.regEntry = { name: 'xQUEUE_REGISTRY_ITEM', kind: 'struct', byteSize: 8, fields: [
      { name: 'pcQueueName', byteOffset: 0, typeOffset: 'charPtr' },
      { name: 'xHandle', byteOffset: 4, typeOffset: 'queuePtr' },
    ] };
    withQueue.types.regArr = { name: '', kind: 'array', byteSize: 32, arrayCount: 4, typeOffset: 'regEntry' };
    withQueue.roots.push(
      { id: '90', expression: 'xQueueRegistry', address: 0x3000, typeOffset: 'regArr', size: 32, file: 'kernel/queue.c', pointerDepth: 0 },
      { id: '91', expression: 'appQueue', address: 0x3040, typeOffset: 'queuePtr', size: 4, file: 'app/main.c', pointerDepth: 0 },
    );

    const layoutWithReg = compileFreeRtosLayout(withQueue, 'q1');
    expect(layoutWithReg.queueRegistry).toMatchObject({ address: 0x3000, count: 4, entrySize: 8 });
    expect(layoutWithReg.queue?.fields.xMutexHolder?.offset).toBe(8);
    expect(layoutWithReg.queue?.fields.uxRecursiveCallCount?.offset).toBe(12);
    expect(layoutWithReg.queueGlobals).toEqual([{ name: 'appQueue', address: 0x3040, isPointer: true }]);

    // Fallback when configQUEUE_REGISTRY_SIZE == 0 (no xQueueRegistry symbol).
    const noReg = structuredClone(withQueue);
    noReg.roots = noReg.roots.filter(r => r.expression !== 'xQueueRegistry');
    const layoutNoReg = compileFreeRtosLayout(noReg, 'q2');
    expect(layoutNoReg.queueRegistry).toBeUndefined();
    expect(layoutNoReg.queue?.fields.uxLength.offset).toBe(84);
    expect(layoutNoReg.queueGlobals).toEqual([{ name: 'appQueue', address: 0x3040, isPointer: true }]);

    // Multiple conflicting xQueueRegistry symbols must disable queues without breaking tasks.
    const dupReg = structuredClone(withQueue);
    dupReg.roots.push({ id: '92', expression: 'xQueueRegistry', address: 0x3100, typeOffset: 'regArr', size: 32, file: 'other.c', pointerDepth: 0 });
    const degraded = compileFreeRtosLayout(dupReg, 'q3');
    expect(degraded.tcb.fields.pcTaskName.offset).toBe(72);
    expect(degraded.queue).toBeUndefined();
    expect(degraded.queueUnavailableReason).toContain('xQueueRegistry');

    // Conflicting concrete QueueDefinition DIEs must disable queues without breaking tasks.
    const conflictingDef = structuredClone(noReg);
    conflictingDef.types.queueDefAlt = { ...conflictingDef.types.queueDef, byteSize: 100 };
    const degradedDef = compileFreeRtosLayout(conflictingDef, 'q4');
    expect(degradedDef.queue).toBeUndefined();
    expect(degradedDef.queueUnavailableReason).toContain('Conflicting QueueDefinition');
  });

  it('discriminates heap allocators (heap_1/heap_2/heap_5/custom/disabled) and disables timers when symbols are absent', () => {
    const noTimers = testCatalog();
    const noTimerLayout = compileFreeRtosLayout(noTimers, 'nt');
    expect(noTimerLayout.timer).toBeUndefined();
    expect(noTimerLayout.timerUnavailableReason).toContain('Software timers disabled');
    expect(noTimerLayout.heap).toMatchObject({ allocator: 'custom-or-disabled', supported: false });

    const heap1 = testCatalog();
    heap1.types.heapBuf = { name: '', kind: 'array', byteSize: 4096, arrayCount: 4096, typeOffset: 'char' };
    heap1.roots.push(
      { id: '91', expression: 'ucHeap', address: 0x4000, typeOffset: 'heapBuf', size: 4096, file: 'heap_1.c', pointerDepth: 0 },
      { id: '92', expression: 'xNextFreeByte', address: 0x3f00, typeOffset: 'u32', size: 4, file: 'heap_1.c', pointerDepth: 0 },
    );
    expect(compileFreeRtosLayout(heap1, 'h1').heap).toMatchObject({ allocator: 'heap_1', supported: false });

    const heap2 = testCatalog();
    heap2.types.heapBuf = { name: '', kind: 'array', byteSize: 4096, arrayCount: 4096, typeOffset: 'char' };
    heap2.roots.push(
      { id: '91', expression: 'ucHeap', address: 0x4000, typeOffset: 'heapBuf', size: 4096, file: 'heap_2.c', pointerDepth: 0 },
      { id: '92', expression: 'xEnd', address: 0x3f00, typeOffset: 'u32', size: 4, file: 'heap_2.c', pointerDepth: 0 },
    );
    expect(compileFreeRtosLayout(heap2, 'h2').heap).toMatchObject({ allocator: 'heap_2', supported: false });

    const heap5 = testCatalog();
    heap5.roots.push(
      { id: '91', expression: 'xFreeBytesRemaining', address: 0x3f00, typeOffset: 'u32', size: 4, file: 'heap_5.c', pointerDepth: 0 },
      { id: '92', expression: 'pxEnd', address: 0x3f04, typeOffset: 'ptr', size: 4, file: 'heap_5.c', pointerDepth: 0 },
      { id: '93', expression: 'xStart', address: 0x3f08, typeOffset: 'u32', size: 4, file: 'heap_5.c', pointerDepth: 0 },
    );
    expect(compileFreeRtosLayout(heap5, 'h5').heap).toMatchObject({ allocator: 'heap_5', supported: false });
  });
});

const fixtureRoot = process.env.ORBIT_RTOS_FIXTURES || 'out/rtos-stage0/fixtures/arm';
const variants = ['native-debug', 'cmsis-v1', 'cmsis-v2', 'native-optimized', 'native-no-stats', 'native-no-stack-bound', 'native-tickless', 'native-no-dwarf'];
describe('fixed stage-0 ELF layouts (requires offline fixture build)', () => {
  for (const variant of variants) {
    const file = `${fixtureRoot}/${variant}.elf`;
    it.runIf(existsSync(file))(`compiles ${variant}`, async () => {
      const [symbols, dwarf] = await Promise.all([readElfSymbols(file), parseDwarfTypeInfo(file)]);
      const compile = () => compileFreeRtosLayout(buildSymbolCatalog(symbols, dwarf), createHash('sha256').update(readFileSync(file)).digest('hex'));
      if (variant === 'native-no-dwarf') { expect(compile).toThrow('No DWARF'); return; }
      const layout = compile();
      expect(layout.lists.filter(list => list.state === 'ready')).toHaveLength(variant === 'cmsis-v2' ? 56 : 8);
      expect(!!layout.tcb.fields.ulRunTimeCounter).toBe(variant !== 'native-no-stats');
      expect(!!layout.tcb.fields.pxEndOfStack).toBe(variant !== 'native-no-stack-bound');
      expect(layout.tcb.size).toBe(variant === 'native-no-stats' || variant === 'native-no-stack-bound' ? 96 : 100);
      expect(layout.queue).toBeDefined();
      expect(layout.queue?.fields.uxMessagesWaiting.size).toBe(4);
      expect(layout.queue?.fields.ucQueueType).toBeDefined();
      expect(layout.queueRegistry?.count).toBe(12);
      expect(layout.item.itemValue).toBeDefined();
      expect(layout.timer).toBeDefined();
      expect(layout.timer?.fields.ucStatus).toBeDefined();
      expect(layout.timerGlobals.some(g => g.name === 'fixtureTimer')).toBe(true);
      expect(layout.heap).toMatchObject({ allocator: 'heap_4', supported: true, heapStructSize: 8, blockLinkSize: 8 });
      expect(layout.heap?.blockLinkNext).toBeDefined();
      expect(layout.heap?.blockLinkSizeField).toBeDefined();
      expect(layout.heap?.blockAllocatedBit?.address).toBeGreaterThan(0);
      expect(layout.heap?.ucHeap?.size).toBe(65536);
    }, 30000);
  }
});
