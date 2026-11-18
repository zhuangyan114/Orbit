import type { FreeRtosHeapLayout, FreeRtosLayout } from './freertos-layout';
import { HeapAllocatorKind, HeapBlockLifecycleStatus, ObjectLifecycleStatus } from './model';
import { isInRam } from './reader-helpers';
import { RtosError } from './model';
import { AddressRange, scalar, SnapshotMemory } from './snapshot-reader';

const MAX_HEAP_FREE_BLOCKS = 256;

export interface HeapLifecycleInput {
  address: number;
  objectSize: number;
  staticallyAllocated?: boolean;
  symbolIsStatic?: boolean;
}

export interface HeapLifecycleVerdict {
  status: ObjectLifecycleStatus;
  reason: string;
  heapBlock: HeapBlockLifecycleStatus;
  heapBlockReason: string;
  corruptBlockHeader?: boolean;
}

export interface HeapLifecycleInspection {
  allocator: HeapAllocatorKind;
  walkComplete: boolean;
  diagnostic?: string;
  freeBlockCount: number;
  verdicts: Map<number, HeapLifecycleVerdict>;
}

interface HeapFreeRange {
  start: number;
  end: number;
  size: number;
}

function alignUp8(addr: number): number {
  const rem = addr % 8;
  return rem === 0 ? addr : addr + (8 - rem);
}

function hasIoBudget(memory: SnapshotMemory, extraBytes: number): boolean {
  return memory.diagnostics.bytes + extraBytes <= memory.limits.bytes
    && memory.diagnostics.batches < memory.limits.batches;
}

function isCancellationError(err: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  return err instanceof RtosError && (err.errorCode === 'SessionChanged' || err.errorCode === 'TargetReadCancelled');
}

function isAddressInsideRange(addr: number, size: number, start: number, end: number): boolean {
  return addr >= start && addr + size <= end;
}

function isStaticOutsideHeap(
  item: HeapLifecycleInput,
  hLayout: FreeRtosHeapLayout | undefined,
): boolean {
  const isStatic = item.staticallyAllocated === true || (item.symbolIsStatic === true && item.staticallyAllocated !== false);
  if (!isStatic) return false;
  if (!hLayout?.ucHeap) return true;
  const ucStart = hLayout.ucHeap.address;
  const ucEnd = ucStart + hLayout.ucHeap.size;
  return item.address + item.objectSize <= ucStart || item.address >= ucEnd;
}

function unconfirmedAllocatorReason(allocator: HeapAllocatorKind, hLayout?: FreeRtosHeapLayout): string {
  switch (allocator) {
    case 'heap_1':
      return 'heap_1 仅支持线性分配且不实现 vPortFree，无释放块链表，仅完成结构校验（生命周期未确认）';
    case 'heap_2':
      return 'heap_2（非合并按大小排序空闲链表）暂未实现块生命周期证明，仅完成结构校验（生命周期未确认）';
    case 'heap_5':
      return 'heap_5（多区域动态堆）暂未实现多区空闲链表证明，仅完成结构校验（生命周期未确认）';
    case 'custom-or-disabled':
      return hLayout?.unavailableReason || '未识别到受支持的内置堆分配器（可能为 heap_3 / 自定义 / 无动态堆），仅完成结构校验（生命周期未确认）';
    case 'heap_4':
      return hLayout?.unavailableReason || 'heap_4 元数据符号不完整，仅完成结构校验（生命周期未确认）';
    default:
      return '未检测到堆布局符号，仅完成结构校验（生命周期未确认）';
  }
}

export async function inspectHeapObjectLifecycles(
  layout: FreeRtosLayout,
  memory: SnapshotMemory,
  items: HeapLifecycleInput[],
): Promise<HeapLifecycleInspection> {
  const verdicts = new Map<number, HeapLifecycleVerdict>();
  const hLayout = layout.heap;
  const allocator: HeapAllocatorKind = hLayout?.allocator ?? 'custom-or-disabled';

  if (items.length === 0) {
    return { allocator, walkComplete: true, freeBlockCount: 0, verdicts };
  }

  // Non-heap_4 allocators (or unsupported heap metadata): preserve static detection, mark dynamic objects unconfirmed.
  if (
    !hLayout
    || !hLayout.supported
    || hLayout.allocator !== 'heap_4'
    || !hLayout.ucHeap
    || !hLayout.pxEnd
    || !hLayout.xStartAddress
    || !hLayout.freeBytesRemaining
    || !hLayout.blockLinkNext
    || !hLayout.blockLinkSizeField
  ) {
    const reason = unconfirmedAllocatorReason(allocator, hLayout);
    for (const item of items) {
      if (isStaticOutsideHeap(item, hLayout)) {
        const staticReason = '静态对象（StaticQueue_t / ucStaticallyAllocated = true，不通过动态堆释放）';
        verdicts.set(item.address, {
          status: 'confirmed-static',
          reason: staticReason,
          heapBlock: 'static',
          heapBlockReason: staticReason,
        });
      } else {
        verdicts.set(item.address, {
          status: 'unconfirmed',
          reason,
          heapBlock: 'unverified',
          heapBlockReason: reason,
        });
      }
    }
    return { allocator, walkComplete: false, diagnostic: reason, freeBlockCount: 0, verdicts };
  }

  const ucStart = hLayout.ucHeap.address;
  const ucEnd = ucStart + hLayout.ucHeap.size;
  const itemsInUcHeap = items.filter(item => item.address < ucEnd && item.address + item.objectSize > ucStart);

  // Zero target I/O when every candidate object resides strictly outside ucHeap.
  if (itemsInUcHeap.length === 0) {
    for (const item of items) {
      if (item.staticallyAllocated === true || (item.symbolIsStatic === true && item.staticallyAllocated !== false)) {
        const staticReason = '静态对象（StaticQueue_t / ucStaticallyAllocated = true，位于 ucHeap 之外）';
        verdicts.set(item.address, {
          status: 'confirmed-static',
          reason: staticReason,
          heapBlock: 'static',
          heapBlockReason: staticReason,
        });
      } else {
        const outsideReason = `对象地址 0x${item.address.toString(16)} 位于 heap_4 ucHeap 之外且未标记为静态分配，仅完成结构校验（身份与堆块状态未确认）`;
        verdicts.set(item.address, {
          status: 'unconfirmed',
          reason: outsideReason,
          heapBlock: 'unverified',
          heapBlockReason: outsideReason,
        });
      }
    }
    return { allocator, walkComplete: true, freeBlockCount: 0, verdicts };
  }

  const ram: AddressRange[] = memory.request.ram;
  const blockLinkSize = hLayout.blockLinkSize ?? 8;
  const heapStructSize = hLayout.heapStructSize ?? blockLinkSize;
  const alignedUcStart = alignUp8(ucStart);

  const scalarReads = [
    { key: 'pxEnd', start: hLayout.pxEnd.address, size: hLayout.pxEnd.size },
    { key: 'xStart', start: hLayout.xStartAddress, size: blockLinkSize },
    { key: 'freeBytes', start: hLayout.freeBytesRemaining.address, size: hLayout.freeBytesRemaining.size },
    ...(hLayout.blockAllocatedBit
      ? [{ key: 'allocBit', start: hLayout.blockAllocatedBit.address, size: hLayout.blockAllocatedBit.size }]
      : []),
  ];

  let pxEndVal = 0;
  let pxEndValid = false;
  let freeBytesRemainingVal = 0;
  let xStartBuf: Uint8Array | undefined;
  let allocBit = 0n;
  let walkComplete = true;
  let diagnostic: string | undefined;
  const freeRanges: HeapFreeRange[] = [];

  for (const r of scalarReads) {
    if (!isInRam(r.start, r.size, ram)) {
      walkComplete = false;
      diagnostic = `heap_4 元数据 ${r.key} (0x${r.start.toString(16)}) 超出已声明 RAM 范围`;
      break;
    }
  }

  const scalarTotalBytes = scalarReads.reduce((sum, r) => sum + r.size, 0);
  if (walkComplete && !hasIoBudget(memory, scalarTotalBytes)) {
    walkComplete = false;
    diagnostic = '快照 I/O 预算不足，跳过 heap_4 元数据校验（生命周期未确认）';
  }

  if (walkComplete) {
    try {
      const bufs = await memory.many(scalarReads.map(({ start, size }) => ({ start, size })));
      const byKey = new Map<string, Uint8Array>();
      scalarReads.forEach((r, idx) => byKey.set(r.key, bufs[idx]));

      pxEndVal = Number(scalar(byKey.get('pxEnd')!, { offset: 0, size: hLayout.pxEnd.size, typeOffset: '' }));
      freeBytesRemainingVal = Number(scalar(byKey.get('freeBytes')!, { offset: 0, size: hLayout.freeBytesRemaining.size, typeOffset: '' }));
      xStartBuf = byKey.get('xStart')!;
      if (byKey.has('allocBit')) {
        allocBit = scalar(byKey.get('allocBit')!, { offset: 0, size: hLayout.blockAllocatedBit!.size, typeOffset: '' });
      }
    } catch (err) {
      if (isCancellationError(err, memory.request.signal)) throw err;
      walkComplete = false;
      diagnostic = `读取 heap_4 元数据失败：${err instanceof Error ? err.message : String(err)}`;
    }
  }

  if (walkComplete) {
    if (pxEndVal === 0) {
      walkComplete = false;
      diagnostic = 'heap_4 pxEnd == NULL（堆尚未通过 pvPortMalloc 初始化），无法确认动态对象生命周期';
    } else if (
      pxEndVal < alignedUcStart
      || pxEndVal + blockLinkSize > ucEnd
      || !isInRam(pxEndVal, blockLinkSize, ram)
    ) {
      walkComplete = false;
      diagnostic = `heap_4 pxEnd=0x${pxEndVal.toString(16)} 超出 ucHeap [0x${alignedUcStart.toString(16)}, 0x${ucEnd.toString(16)}) 合法范围`;
    } else {
      pxEndValid = true;
    }
  }

  if (walkComplete && pxEndValid && xStartBuf) {
    let curr = Number(scalar(xStartBuf, hLayout.blockLinkNext));
    let sumFree = 0;
    const visited = new Set<number>();

    while (curr !== pxEndVal) {
      if (freeRanges.length >= MAX_HEAP_FREE_BLOCKS) {
        walkComplete = false;
        diagnostic = `heap_4 空闲链表超过 ${MAX_HEAP_FREE_BLOCKS} 个节点上限，未完整遍历`;
        break;
      }
      if (curr < alignedUcStart || curr >= pxEndVal || visited.has(curr) || !isInRam(curr, blockLinkSize, ram)) {
        walkComplete = false;
        diagnostic = `heap_4 空闲链表节点 0x${curr.toString(16)} 越界或成环，未能完整遍历`;
        break;
      }
      if (!hasIoBudget(memory, blockLinkSize)) {
        walkComplete = false;
        diagnostic = '快照 I/O 预算不足，未能完成 heap_4 空闲链表遍历';
        break;
      }

      let nodeBuf: Uint8Array;
      try {
        [nodeBuf] = await memory.many([{ start: curr, size: blockLinkSize }]);
      } catch (err) {
        if (isCancellationError(err, memory.request.signal)) throw err;
        walkComplete = false;
        diagnostic = `读取 heap_4 空闲块 @0x${curr.toString(16)} 失败：${err instanceof Error ? err.message : String(err)}`;
        break;
      }

      const nextFree = Number(scalar(nodeBuf, hLayout.blockLinkNext));
      const rawBlockSize = scalar(nodeBuf, hLayout.blockLinkSizeField);
      if (allocBit > 0n && (rawBlockSize & allocBit) !== 0n) {
        walkComplete = false;
        diagnostic = `heap_4 空闲块 @0x${curr.toString(16)} 的 xBlockAllocatedBit 异常置位（可能正在释放或已损坏）`;
        break;
      }

      const blockSize = Number(allocBit > 0n ? (rawBlockSize & ~allocBit) : rawBlockSize);
      if (
        blockSize < heapStructSize
        || curr + blockSize > pxEndVal
        || (nextFree !== pxEndVal && nextFree < curr + blockSize)
      ) {
        walkComplete = false;
        diagnostic = `heap_4 空闲块 @0x${curr.toString(16)} 大小 (${blockSize}) 或升序后继 (0x${nextFree.toString(16)}) 异常`;
        break;
      }

      visited.add(curr);
      freeRanges.push({ start: curr, end: curr + blockSize, size: blockSize });
      sumFree += blockSize;
      curr = nextFree;
    }

    if (walkComplete && sumFree !== freeBytesRemainingVal) {
      walkComplete = false;
      diagnostic = `heap_4 空闲链表累计字节 (${sumFree}) 与 xFreeBytesRemaining (${freeBytesRemainingVal}) 不一致`;
    }
  }

  // Batch read BlockLink_t headers (address - heapStructSize) for in-bounds candidate objects inside usable heap.
  const headerByObjAddr = new Map<number, Uint8Array>();
  if (pxEndValid) {
    const headerQueries: { objAddr: number; start: number; size: number }[] = [];
    for (const item of itemsInUcHeap) {
      const blockStart = item.address - heapStructSize;
      if (
        item.address >= alignedUcStart + heapStructSize
        && item.address + item.objectSize <= pxEndVal
        && blockStart >= alignedUcStart
        && isInRam(blockStart, blockLinkSize, ram)
      ) {
        headerQueries.push({ objAddr: item.address, start: blockStart, size: blockLinkSize });
      }
    }

    const totalHeaderBytes = headerQueries.reduce((sum, q) => sum + q.size, 0);
    if (headerQueries.length > 0 && hasIoBudget(memory, totalHeaderBytes)) {
      try {
        const bufs = await memory.many(headerQueries.map(q => ({ start: q.start, size: q.size })));
        headerQueries.forEach((q, idx) => headerByObjAddr.set(q.objAddr, bufs[idx]));
      } catch (err) {
        if (isCancellationError(err, memory.request.signal)) throw err;
        walkComplete = false;
        diagnostic = diagnostic || `读取对象 BlockLink_t 块头失败：${err instanceof Error ? err.message : String(err)}`;
      }
    } else if (headerQueries.length > 0) {
      walkComplete = false;
      diagnostic = diagnostic || '快照 I/O 预算不足，未能读取对象 BlockLink_t 块头';
    }
  }

  if (walkComplete && allocBit === 0n) {
    walkComplete = false;
    diagnostic = diagnostic || 'ELF 缺少有效 xBlockAllocatedBit 符号，无法确认已分配标志位';
  }

  for (const item of items) {
    const addr = item.address;
    const objEnd = addr + item.objectSize;
    const inUcHeap = addr < ucEnd && objEnd > ucStart;
    const isStatic = item.staticallyAllocated === true || (item.symbolIsStatic === true && item.staticallyAllocated !== false);

    if (!inUcHeap) {
      if (isStatic) {
        const staticReason = '静态对象（StaticQueue_t / ucStaticallyAllocated = true，位于 ucHeap 之外）';
        verdicts.set(addr, {
          status: 'confirmed-static',
          reason: staticReason,
          heapBlock: 'static',
          heapBlockReason: staticReason,
        });
      } else {
        const outsideReason = `对象地址 0x${addr.toString(16)} 位于 heap_4 ucHeap [0x${ucStart.toString(16)}, 0x${ucEnd.toString(16)}) 之外且未标记为静态分配`;
        verdicts.set(addr, {
          status: 'unconfirmed',
          reason: outsideReason,
          heapBlock: 'unverified',
          heapBlockReason: outsideReason,
        });
      }
      continue;
    }

    if (!pxEndValid) {
      const pxEndReason = diagnostic || 'heap_4 pxEnd 未就绪或异常，无法确认对象生命周期';
      verdicts.set(addr, {
        status: 'unconfirmed',
        reason: pxEndReason,
        heapBlock: 'unverified',
        heapBlockReason: pxEndReason,
      });
      continue;
    }

    const blockStart = addr - heapStructSize;
    const hitFree = freeRanges.find(f => f.start < objEnd && f.end > blockStart);
    if (hitFree) {
      const freeReason = `对象区间 [0x${blockStart.toString(16)}, 0x${objEnd.toString(16)}) 落入 heap_4 空闲块 [0x${hitFree.start.toString(16)}, 0x${hitFree.end.toString(16)})（已通过 vPortFree 释放或合并）`;
      verdicts.set(addr, {
        status: 'confirmed-freed',
        reason: freeReason,
        heapBlock: 'freed',
        heapBlockReason: freeReason,
      });
      continue;
    }

    if (item.staticallyAllocated === true) {
      if (walkComplete && isAddressInsideRange(addr, item.objectSize, alignedUcStart, pxEndVal)) {
        const staticInHeapReason = 'ucStaticallyAllocated = true 且完整 heap_4 空闲链表无重叠（静态对象）';
        verdicts.set(addr, {
          status: 'confirmed-static',
          reason: staticInHeapReason,
          heapBlock: 'static',
          heapBlockReason: staticInHeapReason,
        });
      } else {
        const partialStaticReason = diagnostic || '对象位于 ucHeap 内且声明为静态分配，但 heap_4 校验未完整完成';
        verdicts.set(addr, {
          status: 'unconfirmed',
          reason: partialStaticReason,
          heapBlock: 'unverified',
          heapBlockReason: partialStaticReason,
        });
      }
      continue;
    }

    if (addr < alignedUcStart + heapStructSize || objEnd > pxEndVal) {
      const boundaryReason = `对象位于 ucHeap 保留边界/pxEnd (0x${pxEndVal.toString(16)}) 之外，不可能为有效动态分配块`;
      verdicts.set(addr, {
        status: 'confirmed-freed',
        reason: boundaryReason,
        heapBlock: 'freed',
        heapBlockReason: boundaryReason,
      });
      continue;
    }

    const headerBuf = headerByObjAddr.get(addr);
    if (!headerBuf) {
      const noHeaderReason = diagnostic || '未能读取对象前置 BlockLink_t 块头，生命周期未确认';
      verdicts.set(addr, {
        status: 'unconfirmed',
        reason: noHeaderReason,
        heapBlock: 'unverified',
        heapBlockReason: noHeaderReason,
      });
      continue;
    }

    const headerNext = Number(scalar(headerBuf, hLayout.blockLinkNext));
    const rawBlockSize = scalar(headerBuf, hLayout.blockLinkSizeField);

    if (rawBlockSize === 0n && headerNext === 0) {
      const zeroHdrReason = `heap_4 BlockLink_t @0x${blockStart.toString(16)} 块头全零（xBlockSize=0、pxNextFreeBlock=NULL，且不在空闲链表中；疑遭内存踩踏或重用覆盖）`;
      verdicts.set(addr, {
        status: 'unconfirmed',
        corruptBlockHeader: true,
        reason: zeroHdrReason,
        heapBlock: 'corrupt-header',
        heapBlockReason: zeroHdrReason,
      });
      continue;
    }

    if (allocBit > 0n && (rawBlockSize & allocBit) === 0n) {
      const clearedBitReason = `heap_4 BlockLink_t @0x${blockStart.toString(16)} 的 xBlockAllocatedBit 已清零（块已释放或被合并重用）`;
      verdicts.set(addr, {
        status: 'confirmed-freed',
        reason: clearedBitReason,
        heapBlock: 'freed',
        heapBlockReason: clearedBitReason,
      });
      continue;
    }

    if (headerNext !== 0) {
      const nonNullNextReason = `heap_4 BlockLink_t @0x${blockStart.toString(16)} 的 pxNextFreeBlock=0x${headerNext.toString(16)} 非空（已进入空闲链表或块头被重用覆盖）`;
      verdicts.set(addr, {
        status: 'confirmed-freed',
        reason: nonNullNextReason,
        heapBlock: 'freed',
        heapBlockReason: nonNullNextReason,
      });
      continue;
    }

    if (allocBit === 0n) {
      const missingBitReason = diagnostic || 'ELF 缺少有效 xBlockAllocatedBit 符号，无法确认 heap_4 块状态';
      verdicts.set(addr, {
        status: 'unconfirmed',
        reason: missingBitReason,
        heapBlock: 'unverified',
        heapBlockReason: missingBitReason,
      });
      continue;
    }

    const actualBlockSize = Number(rawBlockSize & ~allocBit);
    if (actualBlockSize < heapStructSize + item.objectSize || blockStart + actualBlockSize > pxEndVal) {
      const shrunkReason = `heap_4 块大小 (${actualBlockSize} B) 小于对象所需 (${heapStructSize + item.objectSize} B) 或超出 pxEnd（原块已释放并被重分配）`;
      verdicts.set(addr, {
        status: 'confirmed-freed',
        reason: shrunkReason,
        heapBlock: 'freed',
        heapBlockReason: shrunkReason,
      });
      continue;
    }

    const spanHitFree = freeRanges.find(f => f.start < blockStart + actualBlockSize && f.end > blockStart);
    if (spanHitFree) {
      const spanOverlapReason = `heap_4 声称块区间与空闲块 [0x${spanHitFree.start.toString(16)}, 0x${spanHitFree.end.toString(16)}) 重叠（原块已释放/重用）`;
      verdicts.set(addr, {
        status: 'confirmed-freed',
        reason: spanOverlapReason,
        heapBlock: 'freed',
        heapBlockReason: spanOverlapReason,
      });
      continue;
    }

    if (walkComplete) {
      const blockAllocatedReason = `heap_4 BlockLink_t @0x${blockStart.toString(16)} 当前处于已分配状态（块大小 ${actualBlockSize} B，pxNextFreeBlock=NULL），且完整空闲链表无重叠`;
      verdicts.set(addr, {
        status: 'unconfirmed',
        reason: `${blockAllocatedReason}；但分配器不含队列代数/类型标识，若旧队列释放后在同址被 pvPortMalloc 复用仍可能保留残留 Queue_t 结构，队列身份未确认`,
        heapBlock: 'allocated',
        heapBlockReason: blockAllocatedReason,
      });
    } else {
      const incompleteReason = diagnostic || 'heap_4 空闲链表未完整校验，对象生命周期标记为未确认';
      verdicts.set(addr, {
        status: 'unconfirmed',
        reason: incompleteReason,
        heapBlock: 'unverified',
        heapBlockReason: incompleteReason,
      });
    }
  }

  return {
    allocator,
    walkComplete,
    ...(diagnostic ? { diagnostic } : {}),
    freeBlockCount: freeRanges.length,
    verdicts,
  };
}
