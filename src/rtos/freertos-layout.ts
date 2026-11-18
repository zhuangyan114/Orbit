import { createHash } from 'crypto';
import type { SymbolCatalog, SymbolNode, SymbolType } from '../symbols/symbol-catalog';
import { symbolByteSize, symbolType } from '../symbols/symbol-catalog';
import { RtosError } from './model';

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
export interface FreeRtosLayout {
  elfSha256: string; layoutId: string;
  source: string;
  current: number; taskCount: number; taskCountBytes: number;
  runtimeTotal?: { address: number; size: number };
  lists: ListRoot[];
  list: { size: number; count: Member; end: Member; endNext: Member; endPrevious: Member };
  item: { size: number; next: Member; previous: Member; owner: Member; container: Member };
  tcb: { size: number; typeOffset: string; fields: Record<string, Member>; nameBytes: number; stackWordBytes: number };
  queue?: FreeRtosQueueLayout;
  queueRegistry?: QueueRegistryLayout;
  queueGlobals: QueueGlobalHandle[];
  queueUnavailableReason?: string;
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
  const item = { size: type(itemOffset).byteSize, next: member(itemOffset, 'pxNext'), previous: member(itemOffset, 'pxPrevious'),
    owner: member(itemOffset, 'pvOwner'), container: member(itemOffset, 'pvContainer') };
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

  const plan = { elfSha256, source: `DWARF:${current.file}:${tcbOffset}`, current: current.address!, taskCount: count.address!, taskCountBytes,
    ...(total ? { runtimeTotal: { address: total.address!, size: totalSize } } : {}),
    lists, list, item, tcb: { size: tcbType.byteSize, typeOffset: tcbOffset, fields, nameBytes: fields.pcTaskName.size, stackWordBytes },
    ...(queue ? { queue } : {}),
    ...(queueRegistry ? { queueRegistry } : {}),
    queueGlobals,
    ...(queueUnavailableReason ? { queueUnavailableReason } : {}) };
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
