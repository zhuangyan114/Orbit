import type { FreeRtosLayout } from './freertos-layout';
import {
  Field,
  HeapOverview,
  known,
  TimerListState,
  TimerSnapshot,
  TimersDiscoverySummary,
  unknown,
} from './model';
import { hasValidListHeader, isInRam, resolveCString } from './reader-helpers';
import { scalar, SnapshotMemory, SnapshotReadResult } from './snapshot-reader';

export interface TimerReadOptions {
  readRodata?: (address: number, maxBytes: number) => Uint8Array | undefined;
}

interface CandidateTimer {
  address: number;
  sources: Set<'list' | 'global'>;
  listState: TimerListState;
  expiryTick?: number;
  expiryTickSource?: string;
  symbolName?: string;
  note?: string;
}

export async function readTimerSnapshot(
  layout: FreeRtosLayout,
  taskResult: SnapshotReadResult,
  options: TimerReadOptions = {},
): Promise<TimersDiscoverySummary> {
  const { memory, snapshot } = taskResult;
  const tLayout = layout.timer;
  if (!tLayout) {
    return {
      enabled: false,
      unavailableReason: layout.timerUnavailableReason || 'configUSE_TIMERS 未启用或缺少 timers.c DWARF 布局',
      activeCurrentCount: 0,
      activeOverflowCount: 0,
      globalStoppedCount: 0,
      coverageNote: layout.timerUnavailableReason || 'Software timers 未启用，无法读取定时器列表。',
      timers: [],
    };
  }

  const fixedRanges = [
    { start: tLayout.currentListPtrAddress, size: 4 },
    { start: tLayout.overflowListPtrAddress, size: 4 },
    { start: tLayout.activeList1Address, size: layout.list.size },
    { start: tLayout.activeList2Address, size: layout.list.size },
    ...(tLayout.tickCount && isInRam(tLayout.tickCount.address, tLayout.tickCount.size, memory.request.ram)
      ? [{ start: tLayout.tickCount.address, size: tLayout.tickCount.size }]
      : []),
  ];
  for (const r of fixedRanges.slice(0, 4)) {
    if (!isInRam(r.start, r.size, memory.request.ram)) {
      snapshot.issues.push({
        errorCode: 'InvalidAddress',
        operation: 'timerSnapshot',
        message: `Timer kernel symbol at 0x${r.start.toString(16)} outside declared RAM`,
        retryable: false,
        completion: 'completed',
      });
      return {
        enabled: true,
        unavailableReason: `定时器内核符号 0x${r.start.toString(16)} 位于已声明 RAM 之外`,
        activeCurrentCount: 0,
        activeOverflowCount: 0,
        globalStoppedCount: 0,
        coverageNote: '定时器内核链表地址无效。',
        timers: [],
      };
    }
  }

  const fixedBytes = await memory.many(fixedRanges);
  const curPtr = Number(scalar(fixedBytes[0], { offset: 0, size: 4, typeOffset: '' }));
  const ovfPtr = Number(scalar(fixedBytes[1], { offset: 0, size: 4, typeOffset: '' }));
  const list1Bytes = fixedBytes[2];
  const list2Bytes = fixedBytes[3];
  const tickCountField: Field<number> | undefined = tLayout.tickCount && fixedBytes[4]
    ? known(Number(scalar(fixedBytes[4], { offset: 0, size: tLayout.tickCount.size, typeOffset: '' })), 'xTickCount', 'ticks')
    : undefined;

  const validListPtrs = (curPtr === tLayout.activeList1Address || curPtr === tLayout.activeList2Address)
    && (ovfPtr === tLayout.activeList1Address || ovfPtr === tLayout.activeList2Address)
    && curPtr !== ovfPtr;

  const candidates = new Map<number, CandidateTimer>();
  const addCandidate = (address: number, source: 'list' | 'global', info: Partial<CandidateTimer>) => {
    const existing = candidates.get(address);
    if (existing) {
      existing.sources.add(source);
      if (existing.listState === 'stopped-global' || existing.listState === 'unknown') {
        if (info.listState) existing.listState = info.listState;
      }
      if (info.expiryTick !== undefined && existing.expiryTick === undefined) {
        existing.expiryTick = info.expiryTick;
        existing.expiryTickSource = info.expiryTickSource;
      }
      if (info.symbolName && !existing.symbolName) existing.symbolName = info.symbolName;
      if (info.note && !existing.note) existing.note = info.note;
      return;
    }
    candidates.set(address, {
      address,
      sources: new Set([source]),
      listState: info.listState ?? 'unknown',
      expiryTick: info.expiryTick,
      expiryTickSource: info.expiryTickSource,
      symbolName: info.symbolName,
      note: info.note,
    });
  };

  const traverseTimerList = async (listAddr: number, listBytes: Uint8Array, listLabel: string) => {
    if (!hasValidListHeader(listBytes, listAddr, layout, memory.request.ram, memory.limits.nodes)) {
      snapshot.issues.push({
        errorCode: 'CorruptList',
        operation: 'timerSnapshot',
        message: `${listLabel} header sentinel/count invalid`,
        retryable: false,
        completion: 'completed',
      });
      return;
    }
    const listState: TimerListState = !validListPtrs
      ? 'unknown'
      : listAddr === curPtr ? 'active-current' : listAddr === ovfPtr ? 'active-overflow' : 'unknown';

    const count = Number(scalar(listBytes, layout.list.count));
    if (count === 0) return;

    const sentinel = listAddr + layout.list.end.offset;
    let next = Number(scalar(listBytes, layout.list.endNext));
    let previous = sentinel;
    const seen = new Set<number>();
    let visited = 0;

    while (next !== sentinel && visited < count) {
      if (next % 4 !== 0 || !isInRam(next, layout.item.size, memory.request.ram) || seen.has(next)) {
        snapshot.issues.push({
          errorCode: 'CorruptList',
          operation: 'timerSnapshot',
          message: `${listLabel} contains invalid or cyclic timer list node at 0x${next.toString(16)}`,
          retryable: false,
          completion: 'completed',
        });
        return;
      }
      seen.add(next);
      memory.diagnostics.nodes++;
      if (memory.diagnostics.nodes > memory.limits.nodes) {
        snapshot.issues.push({
          errorCode: 'BudgetExceeded',
          operation: 'timerSnapshot',
          message: `Timer node traversal exceeded node budget (${memory.limits.nodes})`,
          retryable: false,
          completion: 'completed',
        });
        return;
      }

      const [itemBytes] = await memory.many([{ start: next, size: layout.item.size }]);
      const back = Number(scalar(itemBytes, layout.item.previous));
      const container = Number(scalar(itemBytes, layout.item.container));
      const owner = Number(scalar(itemBytes, layout.item.owner));
      if (back !== previous || container !== listAddr || owner === 0) {
        snapshot.issues.push({
          errorCode: 'CorruptList',
          operation: 'timerSnapshot',
          message: `${listLabel} item back/container/owner mismatch at 0x${next.toString(16)}`,
          retryable: false,
          completion: 'completed',
        });
        return;
      }

      const expiryTick = layout.item.itemValue ? Number(scalar(itemBytes, layout.item.itemValue)) : undefined;
      addCandidate(owner, 'list', {
        listState,
        expiryTick,
        expiryTickSource: `${listLabel}.xTimerListItem.xItemValue`,
        note: validListPtrs ? undefined : 'pxCurrentTimerList/pxOverflowTimerList pointers did not match xActiveTimerList1/2',
      });

      previous = next;
      next = Number(scalar(itemBytes, layout.item.next));
      visited++;
    }
  };

  await traverseTimerList(tLayout.activeList1Address, list1Bytes, 'xActiveTimerList1');
  await traverseTimerList(tLayout.activeList2Address, list2Bytes, 'xActiveTimerList2');

  const validGlobals = layout.timerGlobals.filter(g => isInRam(g.address, g.isPointer ? 4 : tLayout.size, memory.request.ram));
  const ptrGlobals = validGlobals.filter(g => g.isPointer);
  if (ptrGlobals.length > 0) {
    const ptrBytes = await memory.many(ptrGlobals.map(g => ({ start: g.address, size: 4 })));
    ptrGlobals.forEach((g, idx) => {
      const handle = Number(scalar(ptrBytes[idx], { offset: 0, size: 4, typeOffset: '' }));
      if (handle !== 0) addCandidate(handle, 'global', { symbolName: g.name, listState: 'stopped-global' });
    });
  }
  for (const g of validGlobals.filter(item => !item.isPointer)) {
    addCandidate(g.address, 'global', { symbolName: g.name, listState: 'stopped-global' });
  }

  const timers: TimerSnapshot[] = [];
  const validAddresses: number[] = [];
  for (const [address, cand] of candidates) {
    if (address % 4 !== 0 || !isInRam(address, tLayout.size, memory.request.ram)) {
      timers.push({
        address,
        name: cand.symbolName ? known(cand.symbolName, 'ELF symbol', 'text') : unknown('Invalid timer address', 'Timer discovery', 'text'),
        ...(cand.symbolName ? { symbolName: cand.symbolName } : {}),
        discoverySources: [...cand.sources],
        listState: cand.listState,
        active: unknown('Invalid timer address', 'Timer_t', 'boolean'),
        autoReload: unknown('Invalid timer address', 'Timer_t', 'boolean'),
        staticallyAllocated: unknown('Invalid timer address', 'Timer_t', 'boolean'),
        periodTicks: unknown('Invalid timer address', 'Timer_t', 'ticks'),
        expiryTick: unknown('Invalid timer address', 'Timer_t', 'ticks'),
        timerId: unknown('Invalid timer address', 'Timer_t', 'address'),
        callbackAddress: unknown('Invalid timer address', 'Timer_t', 'address'),
        timerNumber: unknown('Invalid timer address', 'Timer_t', 'count'),
        health: 'deleting-or-corrupt',
        healthReason: `Timer address 0x${address.toString(16)} is unaligned or outside declared RAM`,
      });
    } else {
      validAddresses.push(address);
    }
  }

  if (validAddresses.length > 0) {
    const blocks = await memory.many(validAddresses.map(start => ({ start, size: tLayout.size })));
    for (let idx = 0; idx < validAddresses.length; idx++) {
      const addr = validAddresses[idx];
      const bytes = blocks[idx];
      const cand = candidates.get(addr)!;
      const f = tLayout.fields;

      const namePtr = Number(scalar(bytes, f.pcTimerName));
      const nameField = namePtr !== 0
        ? await resolveCString(namePtr, 'Timer_t.pcTimerName', memory, options.readRodata)
        : (cand.symbolName ? known(cand.symbolName, 'ELF symbol (NULL pcTimerName)', 'text') : unknown<string>('NULL pcTimerName', 'Timer_t', 'text'));

      const periodTicks = Number(scalar(bytes, f.xTimerPeriodInTicks));
      const timerIdVal = Number(scalar(bytes, f.pvTimerID));
      const callbackVal = Number(scalar(bytes, f.pxCallbackFunction));
      const timerNumberField = f.uxTimerNumber
        ? known(Number(scalar(bytes, f.uxTimerNumber)), 'Timer_t.uxTimerNumber', 'count')
        : unknown<number>('uxTimerNumber not in DWARF', 'Timer_t', 'count');

      let activeField: Field<boolean>;
      let staticField: Field<boolean>;
      let autoReloadField: Field<boolean>;
      let listState = cand.listState;
      let health: TimerSnapshot['health'] = 'valid';
      const healthReasons: string[] = [];
      if (cand.note) healthReasons.push(cand.note);

      if (f.ucStatus) {
        const status = Number(scalar(bytes, f.ucStatus));
        const isActive = (status & 0x01) !== 0;
        const isStatic = (status & 0x02) !== 0;
        const isAutoReload = (status & 0x04) !== 0;
        activeField = known(isActive, 'Timer_t.ucStatus (bit 0)', 'boolean');
        staticField = known(isStatic, 'Timer_t.ucStatus (bit 1)', 'boolean');
        autoReloadField = known(isAutoReload, 'Timer_t.ucStatus (bit 2)', 'boolean');
        if (cand.sources.has('list') && !isActive) {
          health = 'incomplete';
          healthReasons.push('Timer present in active list while ucStatus active bit is cleared (transient)');
        } else if (!cand.sources.has('list') && isActive) {
          listState = 'unknown';
          health = 'incomplete';
          healthReasons.push('Global timer ucStatus has active bit set but handle not found in active lists (pending command or transient)');
        }
      } else {
        activeField = cand.sources.has('list')
          ? known(true, 'Active timer list membership (ucStatus absent in DWARF)', 'boolean')
          : unknown('Timer_t.ucStatus not in DWARF', 'Timer_t', 'boolean');
        staticField = unknown('Timer_t.ucStatus not in DWARF', 'Timer_t', 'boolean');
        autoReloadField = unknown('Timer_t.ucStatus not in DWARF', 'Timer_t', 'boolean');
      }

      if (periodTicks === 0) {
        health = 'deleting-or-corrupt';
        healthReasons.push('xTimerPeriodInTicks==0 (invalid or deleted timer)');
      }
      if (callbackVal === 0) {
        health = 'deleting-or-corrupt';
        healthReasons.push('pxCallbackFunction==NULL');
      }

      const itemOffset = f.xTimerListItem.offset;
      const fallbackExpiry = !cand.sources.has('list')
        ? unknown<number>('Timer is stopped / not in active expiry list', 'Timer_t', 'ticks')
        : layout.item.itemValue
          ? known(
              cand.expiryTick ?? Number(scalar(bytes.subarray(itemOffset, itemOffset + layout.item.size), layout.item.itemValue)),
              cand.expiryTickSource || 'Timer_t.xTimerListItem.xItemValue',
              'ticks',
            )
          : unknown<number>('ListItem_t.xItemValue not in DWARF', 'Timer_t', 'ticks');

      timers.push({
        address: addr,
        name: nameField,
        ...(cand.symbolName ? { symbolName: cand.symbolName } : {}),
        discoverySources: [...cand.sources],
        listState,
        active: activeField,
        autoReload: autoReloadField,
        staticallyAllocated: staticField,
        periodTicks: known(periodTicks, 'Timer_t.xTimerPeriodInTicks', 'ticks'),
        expiryTick: fallbackExpiry,
        timerId: known(timerIdVal, 'Timer_t.pvTimerID', 'address'),
        callbackAddress: known(callbackVal, 'Timer_t.pxCallbackFunction', 'address'),
        timerNumber: timerNumberField,
        health,
        ...(healthReasons.length ? { healthReason: healthReasons.join('; ') } : {}),
      });
    }
  }

  return {
    enabled: true,
    ...(tickCountField ? { tickCount: tickCountField } : {}),
    activeCurrentCount: timers.filter(t => t.listState === 'active-current').length,
    activeOverflowCount: timers.filter(t => t.listState === 'active-overflow').length,
    globalStoppedCount: timers.filter(t => t.listState === 'stopped-global').length,
    coverageNote: `已扫描 xActiveTimerList1/2（当前/溢出活动定时器）与 ${layout.timerGlobals.length} 个全局定时器句柄；未引用且处于停止态的动态定时器不进入内核列表，不会伪造全量列表。`,
    timers,
  };
}

export async function readHeapOverview(
  layout: FreeRtosLayout,
  memory: SnapshotMemory,
): Promise<HeapOverview> {
  const hLayout = layout.heap;
  if (!hLayout || !hLayout.supported || !hLayout.ucHeap || !hLayout.pxEnd || !hLayout.freeBytesRemaining) {
    const reason = hLayout?.unavailableReason || '未检测到已验证的 FreeRTOS heap_4 布局';
    return {
      allocator: hLayout?.allocator ?? 'custom-or-disabled',
      supported: false,
      initialized: false,
      unavailableReason: reason,
      note: reason,
      configuredBytes: unknown(reason, hLayout?.source || 'SymbolCatalog', 'bytes'),
      usableBytes: unknown(reason, hLayout?.source || 'SymbolCatalog', 'bytes'),
      usedBytes: unknown(reason, hLayout?.source || 'SymbolCatalog', 'bytes'),
      freeBytes: unknown(reason, hLayout?.source || 'SymbolCatalog', 'bytes'),
      minimumEverFreeBytes: unknown(reason, hLayout?.source || 'SymbolCatalog', 'bytes'),
      successfulAllocations: unknown(reason, hLayout?.source || 'SymbolCatalog', 'count'),
      successfulFrees: unknown(reason, hLayout?.source || 'SymbolCatalog', 'count'),
    };
  }

  const scalarReads = [
    { key: 'pxEnd', start: hLayout.pxEnd.address, size: hLayout.pxEnd.size },
    { key: 'free', start: hLayout.freeBytesRemaining.address, size: hLayout.freeBytesRemaining.size },
    ...(hLayout.minimumEverFreeBytesRemaining ? [{ key: 'minEver', start: hLayout.minimumEverFreeBytesRemaining.address, size: hLayout.minimumEverFreeBytesRemaining.size }] : []),
    ...(hLayout.successfulAllocations ? [{ key: 'allocs', start: hLayout.successfulAllocations.address, size: hLayout.successfulAllocations.size }] : []),
    ...(hLayout.successfulFrees ? [{ key: 'frees', start: hLayout.successfulFrees.address, size: hLayout.successfulFrees.size }] : []),
  ];

  for (const item of scalarReads) {
    if (!isInRam(item.start, item.size, memory.request.ram)) {
      const reason = `Heap metadata ${item.key} at 0x${item.start.toString(16)} outside declared RAM`;
      return {
        allocator: 'heap_4',
        supported: false,
        initialized: false,
        unavailableReason: reason,
        note: reason,
        configuredBytes: known(hLayout.ucHeap.size, 'ucHeap ELF array (configTOTAL_HEAP_SIZE)', 'bytes'),
        usableBytes: unknown(reason, 'heap_4.c', 'bytes'),
        usedBytes: unknown(reason, 'heap_4.c', 'bytes'),
        freeBytes: unknown(reason, 'heap_4.c', 'bytes'),
        minimumEverFreeBytes: unknown(reason, 'heap_4.c', 'bytes'),
        successfulAllocations: unknown(reason, 'heap_4.c', 'count'),
        successfulFrees: unknown(reason, 'heap_4.c', 'count'),
      };
    }
  }

  const bufs = await memory.many(scalarReads.map(({ start, size }) => ({ start, size })));
  const values = new Map<string, number>();
  scalarReads.forEach((item, idx) => {
    values.set(item.key, Number(scalar(bufs[idx], { offset: 0, size: item.size, typeOffset: '' })));
  });

  const configuredBytes = known(hLayout.ucHeap.size, 'ucHeap ELF array (configTOTAL_HEAP_SIZE)', 'bytes');
  const pxEndVal = values.get('pxEnd')!;
  const allocsField = hLayout.successfulAllocations
    ? known(values.get('allocs')!, 'heap_4.xNumberOfSuccessfulAllocations', 'count')
    : unknown<number>('xNumberOfSuccessfulAllocations not present', 'heap_4.c', 'count');
  const freesField = hLayout.successfulFrees
    ? known(values.get('frees')!, 'heap_4.xNumberOfSuccessfulFrees', 'count')
    : unknown<number>('xNumberOfSuccessfulFrees not present', 'heap_4.c', 'count');

  if (pxEndVal === 0) {
    const reason = 'pxEnd == NULL（堆尚未通过 pvPortMalloc 初始化）';
    return {
      allocator: 'heap_4',
      supported: true,
      initialized: false,
      note: 'heap_4 尚未初始化（pxEnd == NULL）；已识别 configTOTAL_HEAP_SIZE，首次分配后可显示已用/空余容量。',
      configuredBytes,
      usableBytes: unknown(reason, 'heap_4.c', 'bytes'),
      usedBytes: unknown(reason, 'heap_4.c', 'bytes'),
      freeBytes: unknown(reason, 'heap_4.c', 'bytes'),
      minimumEverFreeBytes: unknown(reason, 'heap_4.c', 'bytes'),
      successfulAllocations: allocsField,
      successfulFrees: freesField,
    };
  }

  const ucStart = hLayout.ucHeap.address;
  const ucEnd = ucStart + hLayout.ucHeap.size;
  const freeVal = values.get('free')!;
  const freeBytes = known(freeVal, 'heap_4.xFreeBytesRemaining', 'bytes');
  const minimumEverFreeBytes = hLayout.minimumEverFreeBytesRemaining
    ? known(values.get('minEver')!, 'heap_4.xMinimumEverFreeBytesRemaining', 'bytes')
    : unknown<number>('xMinimumEverFreeBytesRemaining not present', 'heap_4.c', 'bytes');

  let usableBytes: Field<number>;
  let usedBytes: Field<number>;
  let note = '已核对 heap_4 元数据（不基于块链表猜测碎片率或内存泄漏）。';

  if (pxEndVal <= ucStart || pxEndVal > ucEnd) {
    const reason = `pxEnd=0x${pxEndVal.toString(16)} outside ucHeap [0x${ucStart.toString(16)}, 0x${ucEnd.toString(16)})`;
    usableBytes = unknown(reason, 'heap_4.c', 'bytes');
    usedBytes = unknown(reason, 'heap_4.c', 'bytes');
    note = reason;
  } else {
    const alignedStart = (ucStart & 7) === 0 ? ucStart : (ucStart + 7) & ~7;
    const usableVal = Math.max(0, pxEndVal - alignedStart);
    const usableSrc = (ucStart & 7) === 0 ? 'heap_4.pxEnd - ucHeap' : 'heap_4.pxEnd - aligned(ucHeap, 8)';
    usableBytes = known(usableVal, usableSrc, 'bytes');
    if (freeVal > usableVal) {
      const reason = `xFreeBytesRemaining (${freeVal}) > usable heap capacity (${usableVal})`;
      usedBytes = unknown(reason, 'heap_4.c', 'bytes');
      note = `堆计数瞬态不一致：${reason}`;
    } else {
      usedBytes = known(usableVal - freeVal, 'usableBytes - xFreeBytesRemaining', 'bytes');
    }
  }

  return {
    allocator: 'heap_4',
    supported: true,
    initialized: true,
    note,
    configuredBytes,
    usableBytes,
    usedBytes,
    freeBytes,
    minimumEverFreeBytes,
    successfulAllocations: allocsField,
    successfulFrees: freesField,
  };
}
