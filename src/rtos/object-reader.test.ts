import { describe, expect, it, vi } from 'vitest';
import { compileFreeRtosLayout } from './freertos-layout';
import { readObjectSnapshot } from './object-reader';
import { readTaskSnapshot } from './snapshot-reader';
import { RtosSnapshotService, SnapshotHost } from './snapshot-service';
import { syntheticTarget } from './target-fixture';
import { testCatalog } from './test-fixture';
import type { SymbolCatalog } from '../symbols/symbol-catalog';

function queueTestCatalog(opts: { registry?: boolean; traceFacility?: boolean } = {}): SymbolCatalog {
  const catalog = testCatalog();
  catalog.types.i8 = { name: 'int8_t', kind: 'base', byteSize: 1 };
  catalog.types.u8 = { name: 'uint8_t', kind: 'base', byteSize: 1 };
  catalog.types.charPtr = { name: '', kind: 'pointer', byteSize: 4, typeOffset: 'char' };
  catalog.types.semStruct = {
    name: '',
    kind: 'struct',
    byteSize: 8,
    fields: [
      { name: 'xMutexHolder', byteOffset: 0, typeOffset: 'taskPtr' },
      { name: 'uxRecursiveCallCount', byteOffset: 4, typeOffset: 'u32' },
    ],
  };
  catalog.types.queueUnion = {
    name: '',
    kind: 'union',
    byteSize: 8,
    fields: [{ name: 'xSemaphore', byteOffset: 0, typeOffset: 'semStruct' }],
  };
  const queueFields = [
    { name: 'pcHead', byteOffset: 0, typeOffset: 'charPtr' },
    { name: 'u', byteOffset: 8, typeOffset: 'queueUnion' },
    { name: 'xTasksWaitingToSend', byteOffset: 16, typeOffset: 'list' },
    { name: 'xTasksWaitingToReceive', byteOffset: 48, typeOffset: 'list' },
    { name: 'uxMessagesWaiting', byteOffset: 80, typeOffset: 'u32' },
    { name: 'uxLength', byteOffset: 84, typeOffset: 'u32' },
    { name: 'uxItemSize', byteOffset: 88, typeOffset: 'u32' },
    { name: 'cRxLock', byteOffset: 92, typeOffset: 'i8' },
    { name: 'cTxLock', byteOffset: 93, typeOffset: 'i8' },
    ...(opts.traceFacility === false ? [] : [
      { name: 'ucQueueType', byteOffset: 94, typeOffset: 'u8' },
      { name: 'uxQueueNumber', byteOffset: 96, typeOffset: 'u32' },
    ]),
    { name: 'ucStaticallyAllocated', byteOffset: 95, typeOffset: 'u8' },
  ];
  catalog.types.queueDef = { name: 'QueueDefinition', kind: 'struct', byteSize: 100, fields: queueFields };
  catalog.types.queuePtr = { name: '', kind: 'pointer', byteSize: 4, typeOffset: 'queueDef' };
  catalog.types.staticQueue = { name: 'xSTATIC_QUEUE', kind: 'struct', byteSize: 100, fields: queueFields };
  catalog.types.regEntry = {
    name: 'xQUEUE_REGISTRY_ITEM',
    kind: 'struct',
    byteSize: 8,
    fields: [
      { name: 'pcQueueName', byteOffset: 0, typeOffset: 'charPtr' },
      { name: 'xHandle', byteOffset: 4, typeOffset: 'queuePtr' },
    ],
  };
  catalog.types.regArr = { name: '', kind: 'array', byteSize: 48, arrayCount: 6, typeOffset: 'regEntry' };

  if (opts.registry !== false) {
    catalog.roots.push({
      id: '90',
      expression: 'xQueueRegistry',
      address: 0x3000,
      typeOffset: 'regArr',
      size: 48,
      file: 'kernel/queue.c',
      pointerDepth: 0,
    });
  }
  catalog.roots.push(
    { id: '91', expression: 'gQueueHandle', address: 0x3100, typeOffset: 'queuePtr', size: 4, file: 'app/main.c', pointerDepth: 0 },
    { id: '92', expression: 'gStaticSem', address: 0x5400, typeOffset: 'staticQueue', size: 100, file: 'app/main.c', pointerDepth: 0 },
  );
  return catalog;
}

function setupQueueTarget(opts: { registry?: boolean; traceFacility?: boolean; targetState?: 'Halted' | 'Running' } = {}) {
  const base = syntheticTarget();
  const catalog = queueTestCatalog(opts);
  const layout = compileFreeRtosLayout(catalog, 'queue-test');
  const bytes = Buffer.from(base.bytes);
  const u32 = (addr: number, val: number) => bytes.writeUInt32LE(val >>> 0, addr);
  const u8 = (addr: number, val: number) => bytes.writeUInt8(val & 0xff, addr);

  const initList = (listAddr: number, taskAddrs: number[] = []) => {
    const sentinel = listAddr + 16;
    const nodes = taskAddrs.map(tcb => tcb + 36); // TCB.xEventListItem
    u32(listAddr + 4, nodes.length);
    u32(listAddr + 24, nodes[0] ?? sentinel);
    u32(listAddr + 28, nodes.at(-1) ?? sentinel);
    nodes.forEach((node, idx) => {
      u32(node + 8, nodes[idx + 1] ?? sentinel);
      u32(node + 12, nodes[idx - 1] ?? sentinel);
      u32(node + 16, taskAddrs[idx]);
      u32(node + 20, listAddr);
    });
  };

  const writeQueue = (addr: number, cfg: {
    pcHead: number;
    holder?: number;
    recCount?: number;
    waitingSend?: number[];
    waitingRecv?: number[];
    messagesWaiting: number;
    length: number;
    itemSize: number;
    rxLock?: number;
    txLock?: number;
    queueType?: number;
    queueNumber?: number;
    staticAlloc?: number;
  }) => {
    u32(addr + 0, cfg.pcHead);
    u32(addr + 8, cfg.holder ?? 0);
    u32(addr + 12, cfg.recCount ?? 0);
    initList(addr + 16, cfg.waitingSend ?? []);
    initList(addr + 48, cfg.waitingRecv ?? []);
    u32(addr + 80, cfg.messagesWaiting);
    u32(addr + 84, cfg.length);
    u32(addr + 88, cfg.itemSize);
    u8(addr + 92, cfg.rxLock ?? 0xff); // -1 unlocked
    u8(addr + 93, cfg.txLock ?? 0xff); // -1 unlocked
    u8(addr + 94, cfg.queueType ?? 0);
    u8(addr + 95, cfg.staticAlloc ?? 0);
    u32(addr + 96, cfg.queueNumber ?? 1);
  };

  const rodata = new Map<number, Buffer>();
  const request = {
    ...base.request,
    targetState: opts.targetState ?? 'Halted',
    identity: { ...base.request.identity, elfSha256: 'queue-test', layoutId: layout.layoutId },
    read: async (address: number, size: number) => bytes.subarray(address, address + size),
  };
  const readRodata = (addr: number, maxBytes: number) => {
    const buf = rodata.get(addr);
    return buf ? buf.subarray(0, Math.min(maxBytes, buf.length)) : undefined;
  };
  return { catalog, layout, bytes, u32, u8, initList, writeQueue, rodata, readRodata, request };
}

describe('FreeRTOS queue/mutex/semaphore/wait-graph reader', () => {
  it('discovers objects via registry, global handle, static handle, and blocked task wait-list without duplicating multi-source handles', async () => {
    const t = setupQueueTarget();
    t.rodata.set(0x08001000, Buffer.from('sensorQueue\0'));
    t.rodata.set(0x08001020, Buffer.from('recLock\0'));

    // 0x5000: Queue in both xQueueRegistry[0] AND gQueueHandle; task 0x2400 waiting to receive
    t.writeQueue(0x5000, {
      pcHead: 0x5800,
      holder: 0x2000, // Garbage in union for a queue — must NEVER surface as a holder
      waitingRecv: [0x2400],
      messagesWaiting: 0,
      length: 4,
      itemSize: 16,
      queueType: 0,
      queueNumber: 10,
    });
    t.u32(0x3000, 0x08001000);
    t.u32(0x3004, 0x5000);
    t.u32(0x3100, 0x5000);

    // 0x5200: Recursive mutex in registry[1], held recursively (x3) by task 0x2000, waited on by 0x2600 (wait-list also points to same)
    t.writeQueue(0x5200, {
      pcHead: 0,
      holder: 0x2000,
      recCount: 3,
      waitingRecv: [0x2600],
      messagesWaiting: 0,
      length: 1,
      itemSize: 0,
      queueType: 4,
      queueNumber: 11,
    });
    t.u32(0x3008, 0x08001020);
    t.u32(0x300c, 0x5200);

    // 0x5400: Static binary semaphore via gStaticSem (unregistered)
    t.writeQueue(0x5400, {
      pcHead: 0x5400,
      messagesWaiting: 1,
      length: 1,
      itemSize: 0,
      queueType: 3,
      staticAlloc: 1,
      queueNumber: 12,
    });

    // 0x5600: Unregistered queue discovered ONLY via blocked task 0x2800 waiting to send
    t.writeQueue(0x5600, {
      pcHead: 0x5900,
      waitingSend: [0x2800],
      messagesWaiting: 2,
      length: 2,
      itemSize: 8,
      queueType: 0,
      queueNumber: 13,
    });

    const taskResult = await readTaskSnapshot(t.layout, t.request);
    const summary = await readObjectSnapshot(t.layout, taskResult, { readRodata: t.readRodata });

    expect(summary.registryCapacity).toBe(6);
    expect(summary.objects).toHaveLength(4);

    const queue = summary.objects.find(o => o.address === 0x5000)!;
    expect(queue.kind).toBe('queue');
    expect(queue.name).toMatchObject({ available: true, value: 'sensorQueue' });
    expect(queue.name.source).toContain('ELF .rodata');
    expect(queue.symbolName).toBe('gQueueHandle');
    expect(queue.discoverySources).toEqual(['registry', 'global']);
    expect(queue.holder).toBeUndefined();
    expect(queue.rxLock).toMatchObject({ available: true, value: -1 });
    expect(queue.txLock).toMatchObject({ available: true, value: -1 });
    expect(queue.waitingToReceive).toHaveLength(1);
    expect(queue.waitingToReceive?.[0]).toMatchObject({ taskAddress: 0x2400, taskName: 'delayed', taskListVerified: true });

    const recMutex = summary.objects.find(o => o.address === 0x5200)!;
    expect(recMutex.kind).toBe('recursive-mutex');
    expect(recMutex.holder).toMatchObject({
      address: 0x2000,
      taskName: 'current',
      confidence: 'halted-verified',
      recursiveCallCount: { available: true, value: 3 },
    });

    const staticSem = summary.objects.find(o => o.address === 0x5400)!;
    expect(staticSem.kind).toBe('binary-semaphore');
    expect(staticSem.symbolName).toBe('gStaticSem');
    expect(staticSem.staticallyAllocated).toMatchObject({ available: true, value: true });
    expect(staticSem.holder).toBeUndefined();

    const listOnly = summary.objects.find(o => o.address === 0x5600)!;
    expect(listOnly.kind).toBe('queue');
    expect(listOnly.discoverySources).toEqual(['list']);
    expect(listOnly.name.available).toBe(false);
    expect(listOnly.waitingToSend?.[0]).toMatchObject({ taskAddress: 0x2800, taskListVerified: true });
  });

  it('infers mutex/semaphore/queue types without ucQueueType when trace facility is disabled and reads RAM strings', async () => {
    const t = setupQueueTarget({ registry: true, traceFacility: false });
    // Put name string in RAM (0x7000) instead of Flash .rodata
    t.bytes.write('ramLock\0', 0x7000, 'utf8');
    t.u32(0x3000, 0x7000);
    t.u32(0x3004, 0x5000);
    // Single-count mutex without ucQueueType => kind='mutex', kindUncertain=true
    t.writeQueue(0x5000, { pcHead: 0, holder: 0x2000, recCount: 1, messagesWaiting: 0, length: 1, itemSize: 0 });
    // Counting semaphore without ucQueueType => itemSize=0 & uxLength=5 => kind='counting-semaphore'
    t.writeQueue(0x5200, { pcHead: 0x5200, messagesWaiting: 2, length: 5, itemSize: 0 });
    t.u32(0x3100, 0x5200);
    // Binary semaphore (itemSize=0, length=1) => kindUncertain=true
    t.writeQueue(0x5400, { pcHead: 0x5400, messagesWaiting: 0, length: 1, itemSize: 0 });

    const taskResult = await readTaskSnapshot(t.layout, t.request);
    const summary = await readObjectSnapshot(t.layout, taskResult, { readRodata: t.readRodata });

    const mtx = summary.objects.find(o => o.address === 0x5000)!;
    expect(mtx.kind).toBe('mutex');
    expect(mtx.kindUncertain).toBe(true);
    expect(mtx.name).toMatchObject({ available: true, value: 'ramLock' });
    expect(mtx.name.source).toContain('RAM');

    const countSem = summary.objects.find(o => o.address === 0x5200)!;
    expect(countSem.kind).toBe('counting-semaphore');
    expect(countSem.kindUncertain).toBeUndefined();

    const binSem = summary.objects.find(o => o.address === 0x5400)!;
    expect(binSem.kind).toBe('binary-semaphore');
    expect(binSem.kindUncertain).toBe(true);
  });

  it('reports corrupt/deleting objects and unresolved non-queue wait lists without fabricating fake queues', async () => {
    const t = setupQueueTarget();
    t.rodata.set(0x08001000, Buffer.from('badQueue\0'));
    t.rodata.set(0x08001020, Buffer.from('freedHandle\0'));
    t.writeQueue(0x5400, { pcHead: 0x5400, messagesWaiting: 0, length: 1, itemSize: 0, queueType: 3 });

    // Slot 0: handle in RAM but corrupt length=0 & messagesWaiting > length
    t.writeQueue(0x5000, { pcHead: 0x5800, messagesWaiting: 9, length: 0, itemSize: 4, queueType: 0 });
    t.u32(0x3000, 0x08001000);
    t.u32(0x3004, 0x5000);

    // Slot 1: dangling handle outside RAM
    t.u32(0x3008, 0x08001020);
    t.u32(0x300c, 0xdead0001);

    // Slot 2: handle with NULL pcQueueName (deleting / unregistering)
    t.writeQueue(0x5200, { pcHead: 0x5900, messagesWaiting: 1, length: 2, itemSize: 4, queueType: 0 });
    t.u32(0x3010, 0);
    t.u32(0x3014, 0x5200);

    // Task 0x2400 waiting on a non-Queue EventGroup_t wait list at 0x6800 (invalid dual Queue wait-list headers)
    t.initList(0x6800, [0x2400]);

    const taskResult = await readTaskSnapshot(t.layout, t.request);
    const summary = await readObjectSnapshot(t.layout, taskResult, { readRodata: t.readRodata });

    const corruptInRam = summary.objects.find(o => o.address === 0x5000)!;
    expect(corruptInRam.health).toBe('deleting-or-corrupt');
    expect(corruptInRam.waitListEvidence).toBe('corrupt');

    const corruptPtr = summary.objects.find(o => o.address === 0xdead0001)!;
    expect(corruptPtr.health).toBe('deleting-or-corrupt');
    expect(corruptPtr.healthReason).toContain('outside declared RAM');

    const unnamedSlot = summary.objects.find(o => o.address === 0x5200)!;
    expect(unnamedSlot.name.available).toBe(false);
    expect(unnamedSlot.healthReason).toContain('without name');

    expect(summary.unresolvedWaits).toHaveLength(1);
    expect(summary.unresolvedWaits[0]).toMatchObject({ listAddress: 0x6800, waitingTaskAddresses: [0x2400] });
    expect(summary.objects.some(o => Math.abs(o.address - 0x6800) < 128)).toBe(false);
  });

  it('detects stable mutex wait cycles in halted/live mode and suppresses cycle claims when snapshot consistency is partial', async () => {
    const setupCycle = (targetState: 'Halted' | 'Running', corruptAnchor = false) => {
      const t = setupQueueTarget({ targetState });
      t.writeQueue(0x5400, { pcHead: 0x5400, messagesWaiting: 1, length: 1, itemSize: 0, queueType: 3 });
      t.rodata.set(0x08001000, Buffer.from('mutexA\0'));
      t.rodata.set(0x08001020, Buffer.from('mutexB\0'));
      // mutexA held by idle(0x2200), waited by current(0x2000)
      t.writeQueue(0x5000, { pcHead: 0, holder: 0x2200, waitingRecv: [0x2000], messagesWaiting: 0, length: 1, itemSize: 0, queueType: 1 });
      // mutexB held by current(0x2000), waited by idle(0x2200)
      t.writeQueue(0x5200, { pcHead: 0, holder: 0x2000, waitingRecv: [0x2200], messagesWaiting: 0, length: 1, itemSize: 0, queueType: 1 });
      t.u32(0x3000, 0x08001000); t.u32(0x3004, 0x5000);
      t.u32(0x3008, 0x08001020); t.u32(0x300c, 0x5200);
      if (corruptAnchor) {
        let reads = 0;
        t.request.read = async (address, size) => {
          reads++;
          // Mutate current task pointer in tail anchor check so readTaskSnapshot downgrades to 'partial'.
          if (address === 0x1000 && reads > 2) return Buffer.from([0x00, 0x22, 0x00, 0x00]);
          return t.bytes.subarray(address, address + size);
        };
      }
      return t;
    };

    const halted = setupCycle('Halted');
    const haltedTasks = await readTaskSnapshot(halted.layout, halted.request);
    const haltedObjects = await readObjectSnapshot(halted.layout, haltedTasks, { readRodata: halted.readRodata });
    expect(haltedObjects.waitCycles).toHaveLength(1);
    expect(haltedObjects.waitCycles[0]).toMatchObject({
      consistency: 'halted-consistent',
      confidence: 'halted-verified',
    });
    expect(haltedObjects.waitCycles[0].tasks.map(x => x.address)).toEqual([0x2000, 0x2200]);

    const live = setupCycle('Running');
    const liveTasks = await readTaskSnapshot(live.layout, live.request);
    const liveObjects = await readObjectSnapshot(live.layout, liveTasks, { readRodata: live.readRodata });
    expect(liveObjects.waitCycles).toHaveLength(1);
    expect(liveObjects.waitCycles[0].confidence).toBe('live-best-effort');

    const partial = setupCycle('Running', true);
    const partialTasks = await readTaskSnapshot(partial.layout, partial.request);
    expect(partialTasks.snapshot.consistency).toBe('partial');
    const partialObjects = await readObjectSnapshot(partial.layout, partialTasks, { readRodata: partial.readRodata });
    expect(partialObjects.waitCycles).toEqual([]);
  });

  it('supports summary-only and selective per-object wait traversal, and preserves task results if object budget overflows', async () => {
    const t = setupQueueTarget();
    t.writeQueue(0x5400, { pcHead: 0x5400, messagesWaiting: 1, length: 1, itemSize: 0, queueType: 3 });
    t.writeQueue(0x5000, { pcHead: 0x5800, waitingRecv: [0x2400], messagesWaiting: 0, length: 4, itemSize: 4, queueType: 0 });
    t.u32(0x3100, 0x5000);

    const taskResult = await readTaskSnapshot(t.layout, t.request);
    const summaryOnly = await readObjectSnapshot(t.layout, taskResult, { includeWaitDetails: false });
    expect(summaryOnly.objects.find(o => o.address === 0x5000)).toMatchObject({
      waitListEvidence: 'summary-only',
      waitingToReceiveCount: { available: true, value: 1 },
    });
    expect(summaryOnly.objects.find(o => o.address === 0x5000)?.waitingToReceive).toBeUndefined();

    const selectedOnly = await readObjectSnapshot(t.layout, taskResult, { includeWaitDetails: false, objectAddresses: [0x5000] });
    expect(selectedOnly.objects.find(o => o.address === 0x5000)?.waitListEvidence).toBe('traversed');
    expect(selectedOnly.objects.find(o => o.address === 0x5400)?.waitListEvidence).toBe('summary-only');

    // Tight byte budget stops object read cleanly while SnapshotService keeps valid tasks and downgrades consistency to partial.
    const host: SnapshotHost = {
      identity: () => ({ sessionId: 's', sessionGeneration: 1, operationGeneration: 1, bootGeneration: 1, elfSha256: 'queue-test' }),
      targetState: () => 'Halted',
      available: () => true,
      catalog: async () => t.catalog,
      ram: [{ start: 0x1000, size: 0xf000 }],
      read: async (address, size) => ({ bytes: t.bytes.subarray(address, address + size), queueWaitMs: 0 }),
    };
    const service = new RtosSnapshotService(host);
    const baseSnap = await service.refresh({ includeObjects: false });
    const snap = await service.refresh({ includeObjects: true, limits: { bytes: baseSnap.diagnostics.bytes + 20, batches: 100 } });
    expect(snap.tasks.length).toBe(5);
    expect(snap.consistency).toBe('partial');
    expect(snap.issues.some(i => i.errorCode === 'BudgetExceeded' && i.operation === 'objectSnapshot')).toBe(true);
    service.dispose();
  });
});

function setupHeap4QueueTarget(opts: { omitAllocBit?: boolean; targetState?: 'Halted' | 'Running' } = {}) {
  const t = setupQueueTarget({ targetState: opts.targetState });
  t.catalog.types.blockLink = {
    name: 'A_BLOCK_LINK',
    kind: 'struct',
    byteSize: 8,
    fields: [
      { name: 'pxNextFreeBlock', byteOffset: 0, typeOffset: 'blockLinkPtr' },
      { name: 'xBlockSize', byteOffset: 4, typeOffset: 'u32' },
    ],
  };
  t.catalog.types.blockLinkPtr = { name: '', kind: 'pointer', byteSize: 4, typeOffset: 'blockLink' };
  t.catalog.types.ucHeapArr = { name: '', kind: 'array', byteSize: 0x2000, arrayCount: 0x2000, typeOffset: 'u8' };

  // Re-place ucHeap over [0x4000, 0x6000) and metadata at 0x3800..0x3820; static queue lives at 0x6400 outside ucHeap.
  t.catalog.roots = t.catalog.roots.filter(r => r.expression !== 'gStaticSem');
  t.catalog.roots.push(
    { id: '92', expression: 'gStaticSem', address: 0x6400, typeOffset: 'staticQueue', size: 100, file: 'app/main.c', pointerDepth: 0 },
    { id: '93', expression: 'ucHeap', address: 0x4004, typeOffset: 'ucHeapArr', size: 0x2000, file: 'heap_4.c', pointerDepth: 0 }, // Intentionally 4-aligned like Cortex-M BSS
    { id: '94', expression: 'xStart', address: 0x3800, typeOffset: 'blockLink', size: 8, file: 'heap_4.c', pointerDepth: 0 },
    { id: '95', expression: 'pxEnd', address: 0x3808, typeOffset: 'blockLinkPtr', size: 4, file: 'heap_4.c', pointerDepth: 0 },
    { id: '96', expression: 'xFreeBytesRemaining', address: 0x380c, typeOffset: 'u32', size: 4, file: 'heap_4.c', pointerDepth: 0 },
    ...(opts.omitAllocBit ? [] : [
      { id: '97', expression: 'xBlockAllocatedBit', address: 0x3810, typeOffset: 'u32', size: 4, file: 'heap_4.c', pointerDepth: 0 },
    ]),
    { id: '98', expression: 'gDeletedHandle', address: 0x3104, typeOffset: 'queuePtr', size: 4, file: 'app/main.c', pointerDepth: 0 },
  );

  const layout = compileFreeRtosLayout(t.catalog, 'heap4-queue-test');
  const setBlock = (addr: number, nextPtr: number, rawSize: number) => {
    t.u32(addr, nextPtr);
    t.u32(addr + 4, rawSize);
  };
  const setFreeList = (blocks: { addr: number; size: number }[], pxEndAddr = 0x5ff0) => {
    t.u32(0x3808, pxEndAddr);
    t.u32(0x3810, 0x80000000);
    // pxEnd sentinel
    setBlock(pxEndAddr, 0, 0);
    // xStart -> first free or pxEnd
    setBlock(0x3800, blocks[0]?.addr ?? pxEndAddr, 0);
    let totalFree = 0;
    blocks.forEach((b, i) => {
      setBlock(b.addr, blocks[i + 1]?.addr ?? pxEndAddr, b.size);
      totalFree += b.size;
    });
    t.u32(0x380c, totalFree);
  };

  return { ...t, layout, setBlock, setFreeList };
}

describe('heap lifecycle verification for sync objects', () => {
  it('confirms active dynamic and static queues under heap_4 while catching freed, coalesced, and shrunk dynamic blocks', async () => {
    const h = setupHeap4QueueTarget();
    h.rodata.set(0x08001000, Buffer.from('regQueue\0'));

    // ucHeap starts at 0x4004 -> alignedUcStart is 0x4008.
    // 0x4008..0x4108: Lower adjacent free block [0x4008, 0x4108), size 0x100 (NOT containing 0x4108!).
    // 0x4108..0x4188: Active registered Queue_t payload at 0x4110 (block header @ 0x4108, size 0x80 | 0x80000000).
    h.u32(0x3000, 0x08001000);
    h.u32(0x3004, 0x4110);
    h.setBlock(0x4108, 0, 0x80000080);
    h.writeQueue(0x4110, { pcHead: 0x4174, messagesWaiting: 1, length: 4, itemSize: 4, queueType: 0 });

    // 0x4188..0x4208: Normal unregistered global queue payload at 0x4190.
    h.u32(0x3100, 0x4190);
    h.setBlock(0x4188, 0, 0x80000080);
    h.writeQueue(0x4190, { pcHead: 0x41f4, messagesWaiting: 0, length: 2, itemSize: 4, queueType: 0 });

    // 0x4208..0x4288: Normal unregistered list-only queue payload at 0x4210 (task 0x2400 waiting).
    h.setBlock(0x4208, 0, 0x80000080);
    h.writeQueue(0x4210, { pcHead: 0x4274, waitingRecv: [0x2400], messagesWaiting: 0, length: 2, itemSize: 4, queueType: 0 });

    // 0x4308..0x4388: Deleted dynamic queue (dangling gDeletedHandle=0x4310, Queue_t bytes INTACT, vPortFree cleared allocBit and inserted in free list).
    h.u32(0x3104, 0x4310);
    h.writeQueue(0x4310, { pcHead: 0x4374, messagesWaiting: 0, length: 2, itemSize: 4, queueType: 0 });

    // 0x6400: StaticQueue_t outside ucHeap.
    h.writeQueue(0x6400, { pcHead: 0x6400, messagesWaiting: 1, length: 1, itemSize: 0, queueType: 3, staticAlloc: 1 });

    // Free blocks: [0x4008, 0x4108) (touches 0x4108, must NOT mark 0x4110 freed) AND [0x4308, 0x5ff0) (covers deleted 0x4310!).
    h.setFreeList([
      { addr: 0x4008, size: 0x100 },
      { addr: 0x4308, size: 0x5ff0 - 0x4308 },
    ]);

    const tasks = await readTaskSnapshot(h.layout, h.request);
    const snap = await readObjectSnapshot(h.layout, tasks, { readRodata: h.readRodata });

    expect(snap.objects.find(o => o.address === 0x4110)).toMatchObject({
      health: 'valid',
      heapBlock: 'allocated',
      lifecycle: 'unconfirmed',
    });
    expect(snap.objects.find(o => o.address === 0x4190)).toMatchObject({
      health: 'valid',
      heapBlock: 'allocated',
      lifecycle: 'unconfirmed',
      discoverySources: ['global'],
    });
    expect(snap.objects.find(o => o.address === 0x4210)).toMatchObject({
      health: 'valid',
      heapBlock: 'allocated',
      lifecycle: 'unconfirmed',
      discoverySources: ['list'],
    });
    expect(snap.objects.find(o => o.address === 0x6400)).toMatchObject({
      health: 'valid',
      heapBlock: 'static',
      lifecycle: 'confirmed-static',
    });

    const deleted = snap.objects.find(o => o.address === 0x4310)!;
    expect(deleted.health).toBe('deleting-or-corrupt');
    expect(deleted.heapBlock).toBe('freed');
    expect(deleted.lifecycle).toBe('confirmed-freed');
    expect(deleted.waitListEvidence).toBe('corrupt');
    expect(deleted.healthReason).toContain('heap_4');

    // Scenario 2: Coalesced lower free block [0x4288, 0x5ff0) subsumes header @ 0x4308,
    // even when untouched/stale allocated-looking header bytes sit inside [0x4308..0x4388).
    h.setBlock(0x4308, 0, 0x80000080);
    h.setFreeList([
      { addr: 0x4008, size: 0x100 },
      { addr: 0x4288, size: 0x5ff0 - 0x4288 },
    ]);

    const tasksCoalesced = await readTaskSnapshot(h.layout, h.request);
    const snapCoalesced = await readObjectSnapshot(h.layout, tasksCoalesced, { readRodata: h.readRodata });
    expect(snapCoalesced.objects.find(o => o.address === 0x4210)).toMatchObject({
      health: 'valid',
      heapBlock: 'allocated',
      lifecycle: 'unconfirmed',
    });
    expect(snapCoalesced.objects.find(o => o.address === 0x4310)).toMatchObject({
      health: 'deleting-or-corrupt',
      heapBlock: 'freed',
      lifecycle: 'confirmed-freed',
    });

    // Scenario 3: Deleted mutex at 0x4310 reallocated as tiny 32-byte block (size=0x20 < 8+100) while stale Mutex bytes survive -> caught as freed & excluded from lock/cycle!
    h.setBlock(0x4308, 0, 0x80000020);
    h.writeQueue(0x4310, { pcHead: 0, holder: 0x2000, recCount: 2, waitingRecv: [0x2600], messagesWaiting: 0, length: 1, itemSize: 0, queueType: 4 });
    h.setFreeList([
      { addr: 0x4008, size: 0x100 },
      { addr: 0x4328, size: 0x5ff0 - 0x4328 },
    ]);

    const tasksShrunk = await readTaskSnapshot(h.layout, h.request);
    const snapShrunk = await readObjectSnapshot(h.layout, tasksShrunk, { readRodata: h.readRodata });
    const shrunk = snapShrunk.objects.find(o => o.address === 0x4310)!;
    expect(shrunk.health).toBe('deleting-or-corrupt');
    expect(shrunk.heapBlock).toBe('freed');
    expect(shrunk.lifecycle).toBe('confirmed-freed');
    expect(shrunk.holder).toBeUndefined();
    expect(snapShrunk.waitCycles).toEqual([]);

    // Scenario 4: All-zero corrupted BlockLink_t outside free list (e.g. DMA/stack overflow zeroing header) marks deleting-or-corrupt without claiming confirmed-freed.
    h.setBlock(0x4308, 0, 0);
    h.setFreeList([
      { addr: 0x4008, size: 0x100 },
      { addr: 0x4388, size: 0x5ff0 - 0x4388 },
    ]);
    const tasksZeroHdr = await readTaskSnapshot(h.layout, h.request);
    const snapZeroHdr = await readObjectSnapshot(h.layout, tasksZeroHdr, { readRodata: h.readRodata });
    const zeroHdr = snapZeroHdr.objects.find(o => o.address === 0x4310)!;
    expect(zeroHdr.health).toBe('deleting-or-corrupt');
    expect(zeroHdr.heapBlock).toBe('corrupt-header');
    expect(zeroHdr.lifecycle).toBe('unconfirmed');
    expect(zeroHdr.healthReason).toContain('全零');

    // Scenario 5: Same-address reuse after vQueueDelete (pvPortMalloc(sameSize) gets 0x4310 before gDeletedHandle is cleared, leaving intact Queue_t bytes).
    // Block is genuinely allocated again, but object identity MUST remain unconfirmed (distinguishing heapBlock='allocated' from lifecycle='unconfirmed').
    h.setBlock(0x4308, 0, 0x80000080);
    h.writeQueue(0x4310, { pcHead: 0x4374, messagesWaiting: 0, length: 2, itemSize: 4, queueType: 0 });
    h.setFreeList([
      { addr: 0x4008, size: 0x100 },
      { addr: 0x4388, size: 0x5ff0 - 0x4388 },
    ]);
    const tasksReused = await readTaskSnapshot(h.layout, h.request);
    const snapReused = await readObjectSnapshot(h.layout, tasksReused, { readRodata: h.readRodata });
    const reused = snapReused.objects.find(o => o.address === 0x4310)!;
    expect(reused.health).toBe('valid');
    expect(reused.heapBlock).toBe('allocated');
    expect(reused.lifecycle).toBe('unconfirmed');
    expect(reused.lifecycleReason).toContain('复用');
    expect(reused.heapBlockReason).toContain('已分配');
  });

  it('reports lifecycle as unconfirmed when heap_4 evidence is incomplete or under non-heap_4 allocators while preserving global and wait-list discovery', async () => {
    // 1) heap_4 uninitialized (pxEnd == 0)
    const uninit = setupHeap4QueueTarget();
    uninit.u32(0x3100, 0x4190);
    uninit.writeQueue(0x4190, { pcHead: 0x4500, messagesWaiting: 0, length: 2, itemSize: 4, queueType: 0 });
    uninit.writeQueue(0x6400, { pcHead: 0x6400, messagesWaiting: 1, length: 1, itemSize: 0, queueType: 3, staticAlloc: 1 });
    uninit.u32(0x3808, 0); // pxEnd == NULL
    const tUninit = await readTaskSnapshot(uninit.layout, uninit.request);
    const sUninit = await readObjectSnapshot(uninit.layout, tUninit, { readRodata: uninit.readRodata });
    expect(sUninit.objects.find(o => o.address === 0x4190)).toMatchObject({
      health: 'valid',
      lifecycle: 'unconfirmed',
    });
    expect(sUninit.objects.find(o => o.address === 0x6400)?.lifecycle).toBe('confirmed-static');

    // 2) heap_4 free-list sum != xFreeBytesRemaining (transient live mutation) -> non-freed objects degrade to unconfirmed
    const partialHeap = setupHeap4QueueTarget();
    partialHeap.u32(0x3100, 0x4190);
    partialHeap.setBlock(0x4188, 0, 0x80000080);
    partialHeap.writeQueue(0x4190, { pcHead: 0x41f4, messagesWaiting: 0, length: 2, itemSize: 4, queueType: 0 });
    partialHeap.setFreeList([{ addr: 0x4288, size: 0x5ff0 - 0x4288 }]);
    partialHeap.u32(0x380c, 128); // mismatch xFreeBytesRemaining
    const tPartial = await readTaskSnapshot(partialHeap.layout, partialHeap.request);
    const sPartial = await readObjectSnapshot(partialHeap.layout, tPartial, { readRodata: partialHeap.readRodata });
    expect(sPartial.objects.find(o => o.address === 0x4190)).toMatchObject({
      health: 'valid',
      lifecycle: 'unconfirmed',
    });

    // 3) heap_2 / heap_5 / heap_1: preserve global & list-only queues with lifecycle = 'unconfirmed'
    for (const [file, extraRoots] of [
      ['heap_2.c', [{ id: '99', expression: 'xEnd', address: 0x3808, typeOffset: 'u32', size: 4, file: 'heap_2.c', pointerDepth: 0 }]],
      ['heap_5.c', [
        { id: '99', expression: 'pxEnd', address: 0x3808, typeOffset: 'u32', size: 4, file: 'heap_5.c', pointerDepth: 0 },
        { id: '9a', expression: 'xStart', address: 0x3800, typeOffset: 'u32', size: 4, file: 'heap_5.c', pointerDepth: 0 },
        { id: '9b', expression: 'xFreeBytesRemaining', address: 0x380c, typeOffset: 'u32', size: 4, file: 'heap_5.c', pointerDepth: 0 },
      ]],
    ] as const) {
      const other = setupQueueTarget();
      other.catalog.roots.push(...extraRoots.map(r => ({ ...r })));
      const otherLayout = compileFreeRtosLayout(other.catalog, `alloc-${file}`);
      other.u32(0x3100, 0x5000);
      other.writeQueue(0x5000, { pcHead: 0x5800, messagesWaiting: 0, length: 4, itemSize: 4, queueType: 0 });
      other.writeQueue(0x5200, { pcHead: 0x5900, waitingRecv: [0x2400], messagesWaiting: 0, length: 2, itemSize: 4, queueType: 0 });
      other.writeQueue(0x5400, { pcHead: 0x5400, messagesWaiting: 1, length: 1, itemSize: 0, queueType: 3, staticAlloc: 1 });
      const tasksOther = await readTaskSnapshot(otherLayout, other.request);
      const snapOther = await readObjectSnapshot(otherLayout, tasksOther, { readRodata: other.readRodata });
      expect(snapOther.objects.find(o => o.address === 0x5000)).toMatchObject({
        health: 'valid',
        lifecycle: 'unconfirmed',
        discoverySources: ['global'],
      });
      expect(snapOther.objects.find(o => o.address === 0x5200)).toMatchObject({
        health: 'valid',
        lifecycle: 'unconfirmed',
        discoverySources: ['list'],
      });
      expect(snapOther.objects.find(o => o.address === 0x5400)).toMatchObject({
        health: 'valid',
        lifecycle: 'confirmed-static',
      });
    }
  });
});
