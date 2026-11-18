import { createHash } from 'crypto';
import type { SymbolCatalog, SymbolNode, SymbolType } from '../symbols/symbol-catalog';
import { symbolByteSize, symbolType } from '../symbols/symbol-catalog';
import { HeapAllocatorKind, RtosError } from './model';

export interface Member { offset: number; size: number; typeOffset: string; }
export interface ListRoot { name: string; address: number; state: 'ready' | 'blocked' | 'suspended' | 'termination' | 'pending'; }
export interface QueueRegistryLayout {
  address: number;
  count: number;
  entrySize: number;
  name: Member;
  handle: Member;
}
export interface QueueGlobalHandle {
  name: string;
  address: number;
  isPointer: boolean;
}
export interface FreeRtosQueueLayout {
  size: number;
  typeOffset: string;
  source: string;
  fields: {
    pcHead: Member;
    xTasksWaitingToSend: Member;
    xTasksWaitingToReceive: Member;
    uxMessagesWaiting: Member;
    uxLength: Member;
    uxItemSize: Member;
    cRxLock: Member;
    cTxLock: Member;
    xMutexHolder?: Member;
    uxRecursiveCallCount?: Member;
    ucQueueType?: Member;
    uxQueueNumber?: Member;
    ucStaticallyAllocated?: Member;
    pxQueueSetContainer?: Member;
  };
}
export interface FreeRtosTimerLayout {
  size: number;
  typeOffset: string;
  source: string;
  activeList1Address: number;
  activeList2Address: number;
  currentListPtrAddress: number;
  overflowListPtrAddress: number;
  tickCount?: { address: number; size: number };
  fields: {
    pcTimerName: Member;
    xTimerListItem: Member;
    xTimerPeriodInTicks: Member;
    pvTimerID: Member;
    pxCallbackFunction: Member;
    ucStatus?: Member;
    uxTimerNumber?: Member;
  };
}
export interface FreeRtosHeapLayout {
  allocator: HeapAllocatorKind;
  supported: boolean;
  unavailableReason?: string;
  source: string;
  ucHeap?: { address: number; size: number };
  blockLinkSize?: number;
  heapStructSize?: number;
  blockLinkNext?: Member;
  blockLinkSizeField?: Member;
  xStartAddress?: number;
  pxEnd?: { address: number; size: number };
  blockAllocatedBit?: { address: number; size: number };
  freeBytesRemaining?: { address: number; size: number };
  minimumEverFreeBytesRemaining?: { address: number; size: number };
  successfulAllocations?: { address: number; size: number };
  successfulFrees?: { address: number; size: number };
}
export interface FreeRtosLayout {
  elfSha256: string; layoutId: string;
  source: string;
  current: number; taskCount: number; taskCountBytes: number;
  runtimeTotal?: { address: number; size: number };
  lists: ListRoot[];
  list: { size: number; count: Member; end: Member; endNext: Member; endPrevious: Member };
  item: { size: number; next: Member; previous: Member; owner: Member; container: Member; itemValue?: Member };
  tcb: { size: number; typeOffset: string; fields: Record<string, Member>; nameBytes: number; stackWordBytes: number };
  queue?: FreeRtosQueueLayout;
  queueRegistry?: QueueRegistryLayout;
  queueGlobals: QueueGlobalHandle[];
  queueUnavailableReason?: string;
  timer?: FreeRtosTimerLayout;
  timerGlobals: QueueGlobalHandle[];
  timerUnavailableReason?: string;
  heap?: FreeRtosHeapLayout;
}

/** Resolve from the variable DIE (name + address), never from a same-named type. */
export function compileFreeRtosLayout(catalog: SymbolCatalog, elfSha256: string): FreeRtosLayout {
  const fail = (code: string, message: string): never => { throw new RtosError(code, message); };
  const root = (name: string, required = true): SymbolNode | undefined => {
    const matches = catalog.roots.filter(node => node.expression === name);
    if (matches.length > 1) fail('LayoutAmbiguous', `Multiple globals named ${name}`);
    if (!matches.length) { if (required) fail('RtosNotDetected', `Missing kernel root ${name}`); return; }
    const node = matches[0];
    if (node.address === undefined || node.unavailable) fail('LayoutAmbiguous', `Unresolved root ${name}`);
    if (!node.typeOffset) fail('DwarfUnavailable', `No DWARF type for ${name}`);
    return node;
  };
  const type = (offset: string): SymbolType => symbolType(catalog, offset) || fail('LayoutIncomplete', `Missing type ${offset}`);
  const member = (offset: string, name: string): Member => {
    const parent = type(offset);
    const fields = parent.fields?.filter(field => field.name === name) || [];
    if (fields.length !== 1) fail(fields.length ? 'LayoutAmbiguous' : 'LayoutIncomplete', `Missing/ambiguous ${parent.name}.${name}`);
    const field = fields[0];
    const size = symbolByteSize(catalog, field.typeOffset);
    if (field.bitSize || !Number.isSafeInteger(field.byteOffset) || field.byteOffset < 0 || size <= 0
      || field.byteOffset + size > parent.byteSize) fail('LayoutIncomplete', `Invalid member ${parent.name}.${name}`);
    return { offset: field.byteOffset, size, typeOffset: field.typeOffset };
  };
  const integer = (field: Member, name: string) => {
    if (!['base', 'enum'].includes(type(field.typeOffset).kind) || ![1, 2, 4, 8].includes(field.size)) fail('LayoutIncomplete', `Invalid scalar ${name}`);
    return field;
  };
  const pointer = (offset: string): SymbolType => {
    const info = type(offset);
    if (info.kind !== 'pointer' || info.byteSize !== 4) fail('LayoutIncomplete', 'Only 32-bit pointers are supported');
    return info;
  };
  const current = root('pxCurrentTCB')!;
  const count = root('uxCurrentNumberOfTasks')!;
  const ready = root('pxReadyTasksLists')!;
  const readyType = type(ready.typeOffset);
  if (readyType.kind !== 'array' || !readyType.arrayCount || readyType.arrayCount > 256 || !readyType.typeOffset) fail('LayoutIncomplete', 'Invalid ready-list array');
  const listOffset = readyType.typeOffset!;
  const listType = type(listOffset);
  if (listType.kind !== 'struct' || listType.byteSize > 1024 || ready.size !== listType.byteSize * readyType.arrayCount!) fail('LayoutIncomplete', 'Ready-list size mismatch');
  const tcbOffset = pointer(current.typeOffset).typeOffset!;
  const tcbType = type(tcbOffset);
  if (tcbType.kind !== 'struct' || !tcbType.byteSize || tcbType.byteSize > 4096) fail('LayoutIncomplete', 'Invalid TCB type');
  const fields: Record<string, Member> = {};
  for (const name of ['pxTopOfStack', 'xStateListItem', 'xEventListItem', 'uxPriority', 'pcTaskName', 'pxStack']) fields[name] = member(tcbOffset, name);
  for (const name of ['uxBasePriority', 'pxEndOfStack', 'uxTCBNumber', 'ulRunTimeCounter', 'ucNotifyState']) {
    if (tcbType.fields?.some(field => field.name === name)) fields[name] = member(tcbOffset, name);
  }
  for (const name of ['uxPriority', 'uxBasePriority', 'uxTCBNumber', 'ulRunTimeCounter']) if (fields[name]) integer(fields[name], name);
  pointer(fields.pxTopOfStack.typeOffset);
  const stackWordBytes = symbolByteSize(catalog, pointer(fields.pxStack.typeOffset).typeOffset!);
  if (![1, 2, 4, 8].includes(stackWordBytes)) fail('LayoutIncomplete', 'Invalid stack element size');
  if (fields.pxEndOfStack) pointer(fields.pxEndOfStack.typeOffset);
  const nameType = type(fields.pcTaskName.typeOffset);
  if (nameType.kind !== 'array' || fields.pcTaskName.size > 256 || symbolByteSize(catalog, nameType.typeOffset!) !== 1) fail('LayoutIncomplete', 'Invalid task name');
  const itemOffset = fields.xStateListItem.typeOffset;
  const itemType = type(itemOffset);
  const item = {
    size: itemType.byteSize,
    next: member(itemOffset, 'pxNext'),
    previous: member(itemOffset, 'pxPrevious'),
    owner: member(itemOffset, 'pvOwner'),
    container: member(itemOffset, 'pvContainer'),
    ...(itemType.fields?.some(f => f.name === 'xItemValue') ? { itemValue: integer(member(itemOffset, 'xItemValue'), 'xItemValue') } : {}),
  };
  for (const field of [item.next, item.previous, item.owner, item.container]) pointer(field.typeOffset);
  if (symbolByteSize(catalog, fields.xEventListItem.typeOffset) !== item.size) fail('LayoutIncomplete', 'Event item size mismatch');
  for (const [name, expected] of [['pxNext', item.next], ['pxPrevious', item.previous], ['pvOwner', item.owner], ['pvContainer', item.container]] as const) {
    const actual = member(fields.xEventListItem.typeOffset, name);
    pointer(actual.typeOffset);
    if (actual.offset !== expected.offset || actual.size !== expected.size) fail('LayoutAmbiguous', 'State/event item layouts differ');
  }
  const end = member(listOffset, 'xListEnd');
  const endNext = member(end.typeOffset, 'pxNext'), endPrevious = member(end.typeOffset, 'pxPrevious');
  pointer(endNext.typeOffset); pointer(endPrevious.typeOffset);
  const list = { size: listType.byteSize, count: integer(member(listOffset, 'uxNumberOfItems'), 'uxNumberOfItems'), end,
    endNext: { ...endNext, offset: end.offset + endNext.offset }, endPrevious: { ...endPrevious, offset: end.offset + endPrevious.offset } };
  const lists: ListRoot[] = Array.from({ length: readyType.arrayCount! }, (_, index) => ({ name: `ready[${index}]`, address: ready.address! + index * list.size, state: 'ready' }));
  for (const [name, state] of [['xDelayedTaskList1', 'blocked'], ['xDelayedTaskList2', 'blocked'], ['xSuspendedTaskList', 'suspended'],
    ['xPendingReadyList', 'pending'], ['xTasksWaitingTermination', 'termination']] as const) {
    const node = root(name, false);
    if (!node) {
      if (name.startsWith('xDelayed')) fail('LayoutIncomplete', `Missing ${name}`);
      continue;
    }
    // Compare concrete member plans: separate CUs may contain equivalent DIEs.
    for (const [fieldName, expected] of [['uxNumberOfItems', list.count], ['xListEnd', list.end]] as const) {
      const actual = member(node.typeOffset, fieldName);
      if (actual.offset !== expected.offset || actual.size !== expected.size || node.size !== list.size) fail('LayoutAmbiguous', `Conflicting list layout ${name}`);
    }
    const actualEnd = member(node.typeOffset, 'xListEnd');
    for (const [name, expected] of [['pxNext', endNext], ['pxPrevious', endPrevious]] as const) {
      const actual = member(actualEnd.typeOffset, name);
      pointer(actual.typeOffset);
      if (actual.offset !== expected.offset || actual.size !== expected.size) fail('LayoutAmbiguous', `Conflicting sentinel layout ${node.expression}`);
    }
    lists.push({ name, address: node.address!, state });
  }
  const verifyListType = (listTypeOffset: string, label: string, expectedByteSize = list.size) => {
    const t = type(listTypeOffset);
    if (t.byteSize !== expectedByteSize) fail('LayoutAmbiguous', `Conflicting list size in ${label}`);
    for (const [fieldName, expected] of [['uxNumberOfItems', list.count], ['xListEnd', list.end]] as const) {
      const actual = member(listTypeOffset, fieldName);
      if (actual.offset !== expected.offset || actual.size !== expected.size) fail('LayoutAmbiguous', `Conflicting ${label}.${fieldName}`);
    }
    const actualEnd = member(listTypeOffset, 'xListEnd');
    for (const [subName, expected] of [['pxNext', endNext], ['pxPrevious', endPrevious]] as const) {
      const actual = member(actualEnd.typeOffset, subName);
      pointer(actual.typeOffset);
      if (actual.offset !== expected.offset || actual.size !== expected.size) fail('LayoutAmbiguous', `Conflicting ${label} sentinel.${subName}`);
    }
  };
  const taskCountBytes = symbolByteSize(catalog, count.typeOffset);
  if (!['base', 'enum'].includes(type(count.typeOffset).kind) || ![1, 2, 4].includes(taskCountBytes) || count.size !== taskCountBytes) fail('LayoutIncomplete', 'Invalid task count');
  // An optional total-counter DIE may be stripped/ambiguous independently of
  // the kernel lists. That disables percentages, not task discovery.
  const totalCandidates = catalog.roots.filter(node => node.expression === 'ulTotalRunTime' && node.address !== undefined && node.typeOffset && !node.unavailable);
  let total = totalCandidates.length === 1 ? totalCandidates[0] : undefined;
  const totalSize = total ? symbolByteSize(catalog, total.typeOffset) : 0;
  if (![4, 8].includes(totalSize)) total = undefined;

  const compileQueueStruct = (queueTypeOffset: string, source: string): FreeRtosQueueLayout => {
    const queueType = type(queueTypeOffset);
    if (queueType.kind !== 'struct' || queueType.byteSize <= 0 || queueType.byteSize > 1024) {
      fail('LayoutIncomplete', 'Invalid QueueDefinition type');
    }
    const verifyQueueList = (fieldName: string) => {
      const listField = member(queueTypeOffset, fieldName);
      if (listField.size !== list.size) fail('LayoutAmbiguous', `Conflicting list size in ${fieldName}`);
      for (const [subName, expected] of [['uxNumberOfItems', list.count], ['xListEnd', list.end]] as const) {
        const actual = member(listField.typeOffset, subName);
        if (actual.offset !== expected.offset || actual.size !== expected.size) fail('LayoutAmbiguous', `Conflicting ${fieldName}.${subName}`);
      }
      const actualEnd = member(listField.typeOffset, 'xListEnd');
      for (const [subName, expected] of [['pxNext', endNext], ['pxPrevious', endPrevious]] as const) {
        const actual = member(actualEnd.typeOffset, subName);
        pointer(actual.typeOffset);
        if (actual.offset !== expected.offset || actual.size !== expected.size) fail('LayoutAmbiguous', `Conflicting ${fieldName} sentinel.${subName}`);
      }
      return listField;
    };
    const pcHead = member(queueTypeOffset, 'pcHead');
    pointer(pcHead.typeOffset);
    const xTasksWaitingToSend = verifyQueueList('xTasksWaitingToSend');
    const xTasksWaitingToReceive = verifyQueueList('xTasksWaitingToReceive');
    const uxMessagesWaiting = integer(member(queueTypeOffset, 'uxMessagesWaiting'), 'uxMessagesWaiting');
    const uxLength = integer(member(queueTypeOffset, 'uxLength'), 'uxLength');
    const uxItemSize = integer(member(queueTypeOffset, 'uxItemSize'), 'uxItemSize');
    const cRxLock = integer(member(queueTypeOffset, 'cRxLock'), 'cRxLock');
    const cTxLock = integer(member(queueTypeOffset, 'cTxLock'), 'cTxLock');

    let xMutexHolder: Member | undefined;
    let uxRecursiveCallCount: Member | undefined;
    if (queueType.fields?.some(f => f.name === 'u')) {
      const unionMember = member(queueTypeOffset, 'u');
      const unionType = type(unionMember.typeOffset);
      if (unionType.kind === 'union' && unionType.fields?.some(f => f.name === 'xSemaphore')) {
        const semField = member(unionMember.typeOffset, 'xSemaphore');
        const semType = type(semField.typeOffset);
        if (semType.kind === 'struct' && semType.fields?.some(f => f.name === 'xMutexHolder')) {
          const holderField = member(semField.typeOffset, 'xMutexHolder');
          pointer(holderField.typeOffset);
          xMutexHolder = { ...holderField, offset: unionMember.offset + semField.offset + holderField.offset };
        }
        if (semType.kind === 'struct' && semType.fields?.some(f => f.name === 'uxRecursiveCallCount')) {
          const recField = integer(member(semField.typeOffset, 'uxRecursiveCallCount'), 'uxRecursiveCallCount');
          uxRecursiveCallCount = { ...recField, offset: unionMember.offset + semField.offset + recField.offset };
        }
      }
    }

    const optInt = (name: string) => (queueType.fields?.some(f => f.name === name) ? integer(member(queueTypeOffset, name), name) : undefined);
    const ucQueueType = optInt('ucQueueType');
    const uxQueueNumber = optInt('uxQueueNumber');
    const ucStaticallyAllocated = optInt('ucStaticallyAllocated');
    let pxQueueSetContainer: Member | undefined;
    if (queueType.fields?.some(f => f.name === 'pxQueueSetContainer')) {
      pxQueueSetContainer = member(queueTypeOffset, 'pxQueueSetContainer');
      pointer(pxQueueSetContainer.typeOffset);
    }
    return {
      size: queueType.byteSize,
      typeOffset: queueTypeOffset,
      source,
      fields: {
        pcHead,
        xTasksWaitingToSend,
        xTasksWaitingToReceive,
        uxMessagesWaiting,
        uxLength,
        uxItemSize,
        cRxLock,
        cTxLock,
        ...(xMutexHolder ? { xMutexHolder } : {}),
        ...(uxRecursiveCallCount ? { uxRecursiveCallCount } : {}),
        ...(ucQueueType ? { ucQueueType } : {}),
        ...(uxQueueNumber ? { uxQueueNumber } : {}),
        ...(ucStaticallyAllocated ? { ucStaticallyAllocated } : {}),
        ...(pxQueueSetContainer ? { pxQueueSetContainer } : {}),
      },
    };
  };

  let queue: FreeRtosQueueLayout | undefined;
  let queueRegistry: QueueRegistryLayout | undefined;
  let queueUnavailableReason: string | undefined;
  const queueGlobals: QueueGlobalHandle[] = [];

  try {
    const regMatches = catalog.roots.filter(node => node.expression === 'xQueueRegistry');
    if (regMatches.length > 1) {
      queueUnavailableReason = 'Multiple globals named xQueueRegistry';
    } else if (regMatches.length === 1) {
      const reg = regMatches[0];
      if (reg.address === undefined || reg.unavailable || !reg.typeOffset) {
        queueUnavailableReason = 'xQueueRegistry symbol or DWARF type unavailable';
      } else {
        const regType = type(reg.typeOffset);
        if (regType.kind !== 'array' || !regType.arrayCount || regType.arrayCount > 1024 || !regType.typeOffset) {
          queueUnavailableReason = 'Invalid xQueueRegistry array type';
        } else {
          const itemOffset = regType.typeOffset;
          const itemType = type(itemOffset);
          const nameField = member(itemOffset, 'pcQueueName');
          const handleField = member(itemOffset, 'xHandle');
          pointer(nameField.typeOffset);
          const handlePtr = pointer(handleField.typeOffset);
          if (itemType.byteSize <= 0 || reg.size !== itemType.byteSize * regType.arrayCount) {
            queueUnavailableReason = 'xQueueRegistry element size mismatch';
          } else {
            queueRegistry = {
              address: reg.address,
              count: regType.arrayCount,
              entrySize: itemType.byteSize,
              name: nameField,
              handle: handleField,
            };
            queue = compileQueueStruct(handlePtr.typeOffset!, `DWARF:${reg.file}:${handlePtr.typeOffset}`);
          }
        }
      }
    }

    // When configQUEUE_REGISTRY_SIZE == 0, xQueueRegistry is absent; discover
    // QueueDefinition from concrete structs only if all concrete definitions agree.
    if (!queue && !queueUnavailableReason) {
      const candidates = Object.entries(catalog.types)
        .filter(([, def]) => def.kind === 'struct' && def.name === 'QueueDefinition' && def.byteSize > 0
          && def.fields?.some(f => f.name === 'xTasksWaitingToSend')
          && def.fields?.some(f => f.name === 'xTasksWaitingToReceive'));
      if (!candidates.length) {
        queueUnavailableReason = 'QueueDefinition DWARF type unavailable (no queue registry or concrete QueueDefinition DIE)';
      } else {
        const compiled = candidates.map(([offset]) => compileQueueStruct(offset, `DWARF:QueueDefinition:${offset}`));
        const signature = (q: FreeRtosQueueLayout) => JSON.stringify({ size: q.size, fields: Object.fromEntries(Object.entries(q.fields).map(([k, v]) => [k, v ? { offset: v.offset, size: v.size } : undefined])) });
        const firstSig = signature(compiled[0]);
        if (compiled.some(c => signature(c) !== firstSig)) {
          queueUnavailableReason = 'Conflicting QueueDefinition layouts across compilation units';
        } else {
          queue = compiled[0];
        }
      }
    }

    if (queue) {
      for (const node of catalog.roots) {
        if (node.address === undefined || node.unavailable || !node.typeOffset) continue;
        const t = symbolType(catalog, node.typeOffset);
        if (!t) continue;
        if (t.kind === 'pointer' && t.byteSize === 4 && t.typeOffset) {
          const pointee = symbolType(catalog, t.typeOffset);
          if (pointee?.kind === 'struct' && (pointee.name === 'QueueDefinition' || pointee.name === 'xQUEUE')) {
            queueGlobals.push({ name: node.expression, address: node.address, isPointer: true });
          }
        } else if (t.kind === 'struct' && t.name === 'xSTATIC_QUEUE' && t.byteSize === queue.size) {
          queueGlobals.push({ name: node.expression, address: node.address, isPointer: false });
        }
      }
    }
  } catch (err) {
    queue = undefined;
    queueRegistry = undefined;
    queueUnavailableReason = err instanceof Error ? err.message : String(err);
  }

  let timer: FreeRtosTimerLayout | undefined;
  let timerUnavailableReason: string | undefined;
  const timerGlobals: QueueGlobalHandle[] = [];
  try {
    const active1 = root('xActiveTimerList1', false);
    const active2 = root('xActiveTimerList2', false);
    const curPtr = root('pxCurrentTimerList', false);
    const ovfPtr = root('pxOverflowTimerList', false);
    if (!active1 || !active2 || !curPtr || !ovfPtr) {
      timerUnavailableReason = 'Software timers disabled (missing xActiveTimerList1/2 or pxCurrentTimerList/pxOverflowTimerList)';
    } else {
      verifyListType(active1.typeOffset, 'xActiveTimerList1', active1.size);
      verifyListType(active2.typeOffset, 'xActiveTimerList2', active2.size);
      for (const listPtr of [curPtr, ovfPtr]) {
        const ptrType = pointer(listPtr.typeOffset);
        verifyListType(ptrType.typeOffset!, listPtr.expression);
      }
      const compileTimerStruct = (timerTypeOffset: string, source: string): FreeRtosTimerLayout => {
        const timerType = type(timerTypeOffset);
        if (timerType.kind !== 'struct' || timerType.byteSize <= 0 || timerType.byteSize > 512) {
          fail('LayoutIncomplete', 'Invalid tmrTimerControl type');
        }
        const pcTimerName = member(timerTypeOffset, 'pcTimerName');
        pointer(pcTimerName.typeOffset);
        const xTimerListItem = member(timerTypeOffset, 'xTimerListItem');
        if (xTimerListItem.size !== item.size) fail('LayoutAmbiguous', 'Timer list item size mismatch');
        for (const [subName, expected] of [['pxNext', item.next], ['pxPrevious', item.previous], ['pvOwner', item.owner], ['pvContainer', item.container]] as const) {
          const actual = member(xTimerListItem.typeOffset, subName);
          pointer(actual.typeOffset);
          if (actual.offset !== expected.offset || actual.size !== expected.size) fail('LayoutAmbiguous', `Conflicting Timer.xTimerListItem.${subName}`);
        }
        const xTimerPeriodInTicks = integer(member(timerTypeOffset, 'xTimerPeriodInTicks'), 'xTimerPeriodInTicks');
        const pvTimerID = member(timerTypeOffset, 'pvTimerID');
        pointer(pvTimerID.typeOffset);
        const pxCallbackFunction = member(timerTypeOffset, 'pxCallbackFunction');
        pointer(pxCallbackFunction.typeOffset);
        const ucStatus = timerType.fields?.some(f => f.name === 'ucStatus') ? integer(member(timerTypeOffset, 'ucStatus'), 'ucStatus') : undefined;
        const uxTimerNumber = timerType.fields?.some(f => f.name === 'uxTimerNumber') ? integer(member(timerTypeOffset, 'uxTimerNumber'), 'uxTimerNumber') : undefined;

        const tickCandidates = catalog.roots.filter(node => node.expression === 'xTickCount' && node.address !== undefined && node.typeOffset && !node.unavailable);
        let tickNode = tickCandidates.length === 1 ? tickCandidates[0] : undefined;
        const tickSize = tickNode ? symbolByteSize(catalog, tickNode.typeOffset) : 0;
        if (tickNode && (!['base', 'enum'].includes(type(tickNode.typeOffset).kind) || ![2, 4, 8].includes(tickSize))) {
          tickNode = undefined;
        }
        return {
          size: timerType.byteSize,
          typeOffset: timerTypeOffset,
          source,
          activeList1Address: active1.address!,
          activeList2Address: active2.address!,
          currentListPtrAddress: curPtr.address!,
          overflowListPtrAddress: ovfPtr.address!,
          ...(tickNode ? { tickCount: { address: tickNode.address!, size: tickSize } } : {}),
          fields: {
            pcTimerName,
            xTimerListItem,
            xTimerPeriodInTicks,
            pvTimerID,
            pxCallbackFunction,
            ...(ucStatus ? { ucStatus } : {}),
            ...(uxTimerNumber ? { uxTimerNumber } : {}),
          },
        };
      };

      const candidates = Object.entries(catalog.types).filter(([, def]) =>
        def.kind === 'struct' && def.name === 'tmrTimerControl' && def.byteSize > 0
        && def.fields?.some(f => f.name === 'pcTimerName')
        && def.fields?.some(f => f.name === 'xTimerListItem'));
      if (!candidates.length) {
        timerUnavailableReason = 'tmrTimerControl DWARF type unavailable';
      } else {
        const compiled = candidates.map(([offset]) => compileTimerStruct(offset, `DWARF:tmrTimerControl:${offset}`));
        const sig = (t: FreeRtosTimerLayout) => JSON.stringify({ size: t.size, fields: Object.fromEntries(Object.entries(t.fields).map(([k, v]) => [k, v ? { offset: v.offset, size: v.size } : undefined])) });
        if (compiled.some(c => sig(c) !== sig(compiled[0]))) {
          timerUnavailableReason = 'Conflicting tmrTimerControl layouts across compilation units';
        } else {
          timer = compiled[0];
          for (const node of catalog.roots) {
            if (node.address === undefined || node.unavailable || !node.typeOffset) continue;
            const t = symbolType(catalog, node.typeOffset);
            if (!t) continue;
            if (t.kind === 'pointer' && t.byteSize === 4 && t.typeOffset) {
              const pointee = symbolType(catalog, t.typeOffset);
              if (pointee?.kind === 'struct' && (pointee.name === 'tmrTimerControl' || pointee.name === 'xTIMER')) {
                timerGlobals.push({ name: node.expression, address: node.address, isPointer: true });
              }
            } else if (t.kind === 'struct' && t.name === 'xSTATIC_TIMER' && t.byteSize === timer.size) {
              timerGlobals.push({ name: node.expression, address: node.address, isPointer: false });
            }
          }
        }
      }
    }
  } catch (err) {
    timer = undefined;
    timerUnavailableReason = err instanceof Error ? err.message : String(err);
  }

  let heap: FreeRtosHeapLayout;
  try {
    const singleScalarRoot = (name: string) => {
      const node = root(name, false);
      if (!node) return undefined;
      const t = type(node.typeOffset);
      const sz = symbolByteSize(catalog, node.typeOffset);
      if (!['base', 'enum'].includes(t.kind) || ![4, 8].includes(sz) || node.size !== sz) {
        fail('LayoutIncomplete', `Invalid scalar ${name}`);
      }
      return { address: node.address!, size: sz, node };
    };
    const ucHeapMatches = catalog.roots.filter(node => node.expression === 'ucHeap');
    const freeMatches = catalog.roots.filter(node => node.expression === 'xFreeBytesRemaining');
    const endMatches = catalog.roots.filter(node => node.expression === 'pxEnd');
    const startMatches = catalog.roots.filter(node => node.expression === 'xStart');
    const nextFreeMatches = catalog.roots.filter(node => node.expression === 'xNextFreeByte');
    const xEndMatches = catalog.roots.filter(node => node.expression === 'xEnd');

    if (ucHeapMatches.length > 1 || freeMatches.length > 1 || endMatches.length > 1 || startMatches.length > 1) {
      heap = {
        allocator: 'unknown',
        supported: false,
        unavailableReason: 'Ambiguous multiple heap symbols found in ELF',
        source: 'SymbolCatalog',
      };
    } else if (ucHeapMatches.length === 1 && nextFreeMatches.length > 0 && endMatches.length === 0 && freeMatches.length === 0) {
      heap = {
        allocator: 'heap_1',
        supported: false,
        unavailableReason: '检测到 heap_1（仅支持递增分配，无释放/标准 heap_4 结构）；首版仅验证 heap_4',
        source: `DWARF:${ucHeapMatches[0].file}`,
      };
    } else if (ucHeapMatches.length === 1 && xEndMatches.length > 0 && endMatches.length === 0) {
      heap = {
        allocator: 'heap_2',
        supported: false,
        unavailableReason: '检测到 heap_2（使用静态尾块 xEnd）；首版仅验证 heap_4',
        source: `DWARF:${ucHeapMatches[0].file}`,
      };
    } else if (ucHeapMatches.length === 0 && freeMatches.length === 1 && endMatches.length === 1 && startMatches.length === 1) {
      heap = {
        allocator: 'heap_5',
        supported: false,
        unavailableReason: '检测到 heap_5（多非连续区域动态配置，无固定 ucHeap 缓冲）；首版仅支持已验证的 heap_4',
        source: `DWARF:${freeMatches[0].file}`,
      };
    } else if (ucHeapMatches.length === 1 && freeMatches.length === 1 && endMatches.length === 1 && startMatches.length === 1) {
      const ucHeapNode = ucHeapMatches[0];
      if (ucHeapNode.address === undefined || ucHeapNode.unavailable || !ucHeapNode.typeOffset) {
        fail('LayoutIncomplete', 'ucHeap symbol or DWARF type unavailable');
      }
      const ucHeapType = type(ucHeapNode.typeOffset);
      if (ucHeapType.kind !== 'array' || !ucHeapType.typeOffset || symbolByteSize(catalog, ucHeapType.typeOffset) !== 1 || !ucHeapNode.size || ucHeapNode.size <= 0) {
        fail('LayoutIncomplete', 'Invalid ucHeap array layout');
      }
      const ucHeapSize = ucHeapNode.size!;
      const freeInfo = singleScalarRoot('xFreeBytesRemaining')!;
      const endNode = root('pxEnd', true)!;
      const startNode = root('xStart', true)!;
      const endPtr = pointer(endNode.typeOffset);
      const blockLinkType = type(endPtr.typeOffset!);
      if (blockLinkType.kind !== 'struct' || blockLinkType.byteSize < 8 || startNode.size !== blockLinkType.byteSize) {
        fail('LayoutIncomplete', 'Invalid BlockLink_t layout in heap_4');
      }
      pointer(member(endPtr.typeOffset!, 'pxNextFreeBlock').typeOffset);
      const blockLinkNext = member(endPtr.typeOffset!, 'pxNextFreeBlock');
      const blockLinkSizeField = integer(member(endPtr.typeOffset!, 'xBlockSize'), 'BlockLink_t.xBlockSize');

      const minEver = singleScalarRoot('xMinimumEverFreeBytesRemaining');
      const allocs = singleScalarRoot('xNumberOfSuccessfulAllocations');
      const frees = singleScalarRoot('xNumberOfSuccessfulFrees');
      const blockAllocatedBit = singleScalarRoot('xBlockAllocatedBit');
      heap = {
        allocator: 'heap_4',
        supported: true,
        source: `DWARF:${freeInfo.node.file}`,
        ucHeap: { address: ucHeapNode.address!, size: ucHeapSize },
        blockLinkSize: blockLinkType.byteSize,
        ...(blockLinkType.byteSize === 8 ? { heapStructSize: 8 } : {}),
        blockLinkNext,
        blockLinkSizeField,
        xStartAddress: startNode.address!,
        pxEnd: { address: endNode.address!, size: 4 },
        ...(blockAllocatedBit ? { blockAllocatedBit: { address: blockAllocatedBit.address, size: blockAllocatedBit.size } } : {}),
        freeBytesRemaining: { address: freeInfo.address, size: freeInfo.size },
        ...(minEver ? { minimumEverFreeBytesRemaining: { address: minEver.address, size: minEver.size } } : {}),
        ...(allocs ? { successfulAllocations: { address: allocs.address, size: allocs.size } } : {}),
        ...(frees ? { successfulFrees: { address: frees.address, size: frees.size } } : {}),
      };
    } else if (ucHeapMatches.length === 0 && freeMatches.length === 0 && endMatches.length === 0 && startMatches.length === 0) {
      heap = {
        allocator: 'custom-or-disabled',
        supported: false,
        unavailableReason: '未检测到 FreeRTOS heap_4 符号（可能使用 heap_3、标准库 malloc 或已关闭动态堆）',
        source: 'SymbolCatalog',
      };
    } else {
      heap = {
        allocator: 'unknown',
        supported: false,
        unavailableReason: 'Heap symbols incomplete (missing one of ucHeap, xStart, pxEnd, or xFreeBytesRemaining)',
        source: 'SymbolCatalog',
      };
    }
  } catch (err) {
    heap = {
      allocator: 'unknown',
      supported: false,
      unavailableReason: err instanceof Error ? err.message : String(err),
      source: 'SymbolCatalog',
    };
  }

  const plan = { elfSha256, source: `DWARF:${current.file}:${tcbOffset}`, current: current.address!, taskCount: count.address!, taskCountBytes,
    ...(total ? { runtimeTotal: { address: total.address!, size: totalSize } } : {}),
    lists, list, item, tcb: { size: tcbType.byteSize, typeOffset: tcbOffset, fields, nameBytes: fields.pcTaskName.size, stackWordBytes },
    ...(queue ? { queue } : {}),
    ...(queueRegistry ? { queueRegistry } : {}),
    queueGlobals,
    ...(queueUnavailableReason ? { queueUnavailableReason } : {}),
    ...(timer ? { timer } : {}),
    timerGlobals,
    ...(timerUnavailableReason ? { timerUnavailableReason } : {}),
    heap };
  return { ...plan, layoutId: createHash('sha256').update(JSON.stringify(plan)).digest('hex') };
}

/** Content identity prevents a rebuilt ELF at the same path reusing old offsets. */
export class FreeRtosLayoutCache {
  private readonly entries = new Map<string, FreeRtosLayout>();
  get(catalog: SymbolCatalog, elfSha256: string): FreeRtosLayout {
    const existing = this.entries.get(elfSha256);
    if (existing) return existing;
    const layout = compileFreeRtosLayout(catalog, elfSha256);
    this.entries.set(elfSha256, layout);
    if (this.entries.size > 8) this.entries.delete(this.entries.keys().next().value!);
    return layout;
  }
}
