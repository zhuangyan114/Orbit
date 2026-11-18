import type { FreeRtosLayout, FreeRtosQueueLayout } from './freertos-layout';
import { inspectHeapObjectLifecycles } from './heap-lifecycle';
import {
  Field,
  known,
  ObjectDiscoverySource,
  ObjectHealth,
  ObjectsDiscoverySummary,
  QueueObjectKind,
  RtosError,
  RtosIssue,
  SyncObjectHolder,
  SyncObjectSnapshot,
  TaskWaitSummary,
  unknown,
  UnresolvedWaitTarget,
  WaitCycleCandidate,
  WaitEdge,
  WaitRelationConfidence,
} from './model';
import { hasValidListHeader, isInRam, resolveCString, signedScalar } from './reader-helpers';
import { AddressRange, scalar, SnapshotMemory, SnapshotReadResult } from './snapshot-reader';

export interface ObjectReadOptions {
  /** Read detailed wait-list chains for all waiting objects (default true) or only selected addresses. */
  includeWaitDetails?: boolean;
  /** Optional subset of object addresses for on-demand wait-list traversal. */
  objectAddresses?: number[];
  /** Optional reader for verified read-only ELF segments (.rodata) to resolve static names with zero bus I/O. */
  readRodata?: (address: number, maxBytes: number) => Uint8Array | undefined;
}

interface CandidateObject {
  address: number;
  sources: Set<ObjectDiscoverySource>;
  notes: string[];
  registryNamePtr?: number;
  registrySlot?: number;
  registryMissingName?: boolean;
  symbolName?: string;
  symbolIsStatic?: boolean;
}

interface TraversedWaitList {
  ok: boolean;
  count: number;
  waiters: TaskWaitSummary[];
  reason?: string;
}

async function traverseEventWaitList(
  listAddress: number,
  listBytes: Uint8Array,
  layout: FreeRtosLayout,
  memory: SnapshotMemory,
  taskResult: SnapshotReadResult,
  seenLimitNodes: Set<number>,
): Promise<TraversedWaitList> {
  const length = Number(scalar(listBytes, layout.list.count));
  const sentinel = listAddress + layout.list.end.offset;
  let next = Number(scalar(listBytes, layout.list.endNext));
  const last = Number(scalar(listBytes, layout.list.endPrevious));

  if (length > memory.limits.nodes) {
    return { ok: false, count: length, waiters: [], reason: `Wait list length ${length} exceeds node budget` };
  }
  if (length === 0) {
    if (next !== sentinel || last !== sentinel) {
      return { ok: false, count: 0, waiters: [], reason: 'Empty wait list sentinel links do not point to sentinel' };
    }
    return { ok: true, count: 0, waiters: [] };
  }

  const eventOffset = layout.tcb.fields.xEventListItem.offset;
  const tasksByAddr = new Map(taskResult.snapshot.tasks.map(t => [t.tcbAddress, t]));
  const waiters: TaskWaitSummary[] = [];
  let previous = sentinel;
  let visited = 0;

  while (next !== sentinel) {
    if (visited >= length || seenLimitNodes.has(next)) {
      return { ok: false, count: length, waiters: [], reason: 'Cycle or length mismatch in wait list' };
    }
    if (++memory.diagnostics.nodes > memory.limits.nodes) {
      throw new RtosError('BudgetExceeded', 'Object wait-list node budget exhausted');
    }
    if (next % 4 !== 0 || !isInRam(next, layout.item.size, memory.request.ram)) {
      return { ok: false, count: length, waiters: [], reason: `Invalid wait list item address 0x${next.toString(16)}` };
    }
    seenLimitNodes.add(next);
    const [itemBytes] = await memory.many([{ start: next, size: layout.item.size }]);
    const itemPrev = Number(scalar(itemBytes, layout.item.previous));
    const itemContainer = Number(scalar(itemBytes, layout.item.container));
    const owner = Number(scalar(itemBytes, layout.item.owner));
    if (itemPrev !== previous || itemContainer !== listAddress) {
      return { ok: false, count: length, waiters: [], reason: 'Broken previous/container link in wait list' };
    }
    if (owner % 4 !== 0 || owner + eventOffset !== next || !isInRam(owner, layout.tcb.size, memory.request.ram)) {
      return { ok: false, count: length, waiters: [], reason: 'Invalid TCB owner in wait list' };
    }

    const tcbBytes = taskResult.taskBytes.get(owner);
    let taskListVerified = false;
    if (tcbBytes) {
      const tcbEventItem = tcbBytes.subarray(eventOffset, eventOffset + layout.item.size);
      const tcbContainer = Number(scalar(tcbEventItem, layout.item.container));
      const tcbOwner = Number(scalar(tcbEventItem, layout.item.owner));
      taskListVerified = tcbContainer === listAddress && tcbOwner === owner;
    }
    const taskInfo = tasksByAddr.get(owner);
    waiters.push({
      taskAddress: owner,
      ...(taskInfo?.name.available ? { taskName: taskInfo.name.value } : {}),
      ...(taskInfo?.creationNumber.available ? { creationNumber: taskInfo.creationNumber.value } : {}),
      taskListVerified,
    });

    previous = next;
    next = Number(scalar(itemBytes, layout.item.next));
    visited++;
  }

  if (visited !== length || last !== previous) {
    return { ok: false, count: length, waiters: [], reason: 'Wait list tail/count mismatch' };
  }
  return { ok: true, count: length, waiters };
}

function classifyQueueKind(
  qLayout: FreeRtosQueueLayout,
  bytes: Uint8Array,
): { kind: QueueObjectKind; kindSource: string; kindUncertain?: boolean; inconsistent?: string } {
  const pcHead = Number(scalar(bytes, qLayout.fields.pcHead));
  const length = Number(scalar(bytes, qLayout.fields.uxLength));
  const itemSize = Number(scalar(bytes, qLayout.fields.uxItemSize));
  const recCount = qLayout.fields.uxRecursiveCallCount ? Number(scalar(bytes, qLayout.fields.uxRecursiveCallCount)) : 0;

  if (qLayout.fields.ucQueueType) {
    const code = Number(scalar(bytes, qLayout.fields.ucQueueType));
    switch (code) {
      case 0:
        if (itemSize === 0 && pcHead !== 0) {
          return { kind: length > 1 ? 'counting-semaphore' : 'binary-semaphore', kindSource: 'Queue_t.ucQueueType=0 (uxItemSize=0)' };
        }
        return { kind: 'queue', kindSource: 'Queue_t.ucQueueType=0 (queueQUEUE_TYPE_BASE)' };
      case 1:
        return {
          kind: 'mutex',
          kindSource: 'Queue_t.ucQueueType=1 (queueQUEUE_TYPE_MUTEX)',
          ...(pcHead !== 0 ? { inconsistent: 'Mutex ucQueueType=1 has non-null pcHead' } : {}),
        };
      case 2:
        return { kind: 'counting-semaphore', kindSource: 'Queue_t.ucQueueType=2 (queueQUEUE_TYPE_COUNTING_SEMAPHORE)' };
      case 3:
        return { kind: 'binary-semaphore', kindSource: 'Queue_t.ucQueueType=3 (queueQUEUE_TYPE_BINARY_SEMAPHORE)' };
      case 4:
        return {
          kind: 'recursive-mutex',
          kindSource: 'Queue_t.ucQueueType=4 (queueQUEUE_TYPE_RECURSIVE_MUTEX)',
          ...(pcHead !== 0 ? { inconsistent: 'Recursive mutex ucQueueType=4 has non-null pcHead' } : {}),
        };
      default:
        return { kind: 'unknown', kindSource: `Queue_t.ucQueueType=${code}`, kindUncertain: true };
    }
  }

  // Fallback when configUSE_TRACE_FACILITY == 0 (ucQueueType absent from DWARF).
  if (pcHead === 0) {
    if (recCount > 1) {
      return { kind: 'recursive-mutex', kindSource: 'Queue_t.pcHead==NULL & uxRecursiveCallCount>1 (trace facility disabled)' };
    }
    return {
      kind: 'mutex',
      kindSource: 'Queue_t.pcHead==NULL (configUSE_TRACE_FACILITY=0; recursive subtype indistinguishable when count<=1)',
      kindUncertain: true,
    };
  }
  if (itemSize === 0) {
    if (length > 1) {
      return { kind: 'counting-semaphore', kindSource: 'Queue_t.uxItemSize==0 & uxLength>1 (trace facility disabled)' };
    }
    return {
      kind: 'binary-semaphore',
      kindSource: 'Queue_t.uxItemSize==0 & uxLength==1 (configUSE_TRACE_FACILITY=0; binary vs counting(max=1) indistinguishable)',
      kindUncertain: true,
    };
  }
  return { kind: 'queue', kindSource: 'Queue_t.pcHead!=NULL & uxItemSize>0 (trace facility disabled)' };
}

function detectWaitCycles(
  edges: WaitEdge[],
  objects: SyncObjectSnapshot[],
  consistency: SnapshotReadResult['snapshot']['consistency'],
): WaitCycleCandidate[] {
  if (consistency !== 'halted-consistent' && consistency !== 'live-best-effort') return [];
  const objMap = new Map(objects.map(o => [o.address, o]));

  // Build directed task -> task dependencies only via mutexes with verified holder & wait edge.
  const nextByTask = new Map<number, { toTask: number; edge: WaitEdge; object: SyncObjectSnapshot }[]>();
  for (const edge of edges) {
    if (edge.confidence === 'partial-unverified') continue;
    if (edge.heldByTaskAddress === undefined) continue;
    const obj = objMap.get(edge.objectAddress);
    if (!obj || obj.health !== 'valid') continue;
    if (obj.kind !== 'mutex' && obj.kind !== 'recursive-mutex') continue;
    if (!obj.holder || obj.holder.confidence === 'partial-unverified' || obj.holder.address !== edge.heldByTaskAddress) continue;
    const list = nextByTask.get(edge.taskAddress) || [];
    list.push({ toTask: edge.heldByTaskAddress, edge, object: obj });
    nextByTask.set(edge.taskAddress, list);
  }

  const cycles: WaitCycleCandidate[] = [];
  const seenKeys = new Set<string>();
  const visiting = new Set<number>();
  const visited = new Set<number>();
  const stack: { task: number; edge: WaitEdge }[] = [];

  const dfs = (task: number) => {
    visiting.add(task);
    for (const step of nextByTask.get(task) || []) {
      if (visiting.has(step.toTask)) {
        const startIdx = stack.findIndex(s => s.edge.taskAddress === step.toTask);
        const loopEdges = startIdx >= 0 ? [...stack.slice(startIdx).map(s => s.edge), step.edge] : [step.edge];
        const minAddr = Math.min(...loopEdges.map(e => e.taskAddress));
        const rotateIdx = loopEdges.findIndex(e => e.taskAddress === minAddr);
        const canonical = [...loopEdges.slice(rotateIdx), ...loopEdges.slice(0, rotateIdx)];
        const key = canonical.map(e => `${e.taskAddress}:${e.objectAddress}`).join('->');
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          const allHalted = canonical.every(e => e.confidence === 'halted-verified');
          cycles.push({
            tasks: canonical.map(e => ({
              address: e.taskAddress,
              ...(e.taskName ? { name: e.taskName } : {}),
              waitingOnObject: e.objectAddress,
              ...(e.objectName ? { objectName: e.objectName } : {}),
            })),
            consistency,
            confidence: allHalted ? 'halted-verified' : 'live-best-effort',
            note: allHalted
              ? '暂停态一致性校验通过的候选互斥等待环；是否永久死锁仍取决于各任务是否带有阻塞超时。'
              : '运行态单帧观察到的候选互斥等待环；目标未暂停，不能据此判定死锁。',
          });
        }
      } else if (!visited.has(step.toTask)) {
        stack.push({ task, edge: step.edge });
        dfs(step.toTask);
        stack.pop();
      }
    }
    visiting.delete(task);
    visited.add(task);
  };

  for (const startTask of nextByTask.keys()) {
    if (!visited.has(startTask)) dfs(startTask);
  }
  return cycles;
}

export async function readObjectSnapshot(
  layout: FreeRtosLayout,
  taskResult: SnapshotReadResult,
  options: ObjectReadOptions = {},
): Promise<ObjectsDiscoverySummary> {
  const { memory, snapshot } = taskResult;
  const qLayout = layout.queue;
  if (!qLayout) {
    return {
      registryCount: 0,
      globalCount: 0,
      listDiscoveredCount: 0,
      coverageNote: layout.queueUnavailableReason || 'FreeRTOS Queue_t DWARF 布局不可用，无法发现队列与同步对象。',
      objects: [],
      waitEdges: [],
      waitCycles: [],
      unresolvedWaits: [],
    };
  }

  const candidates = new Map<number, CandidateObject>();
  const corruptEntries: SyncObjectSnapshot[] = [];
  const addCandidate = (address: number, source: ObjectDiscoverySource, note: string, extra?: Partial<CandidateObject>) => {
    const existing = candidates.get(address);
    if (existing) {
      existing.sources.add(source);
      existing.notes.push(note);
      if (extra?.registryNamePtr !== undefined) existing.registryNamePtr = extra.registryNamePtr;
      if (extra?.registrySlot !== undefined) existing.registrySlot = extra.registrySlot;
      if (extra?.registryMissingName) existing.registryMissingName = true;
      if (extra?.symbolName && !existing.symbolName) existing.symbolName = extra.symbolName;
      return;
    }
    candidates.set(address, {
      address,
      sources: new Set([source]),
      notes: [note],
      ...extra,
    });
  };

  let registrySlotsActive = 0;
  if (layout.queueRegistry) {
    const reg = layout.queueRegistry;
    const totalBytes = reg.count * reg.entrySize;
    if (isInRam(reg.address, totalBytes, memory.request.ram)) {
      const [regBytes] = await memory.many([{ start: reg.address, size: totalBytes }]);
      for (let i = 0; i < reg.count; i++) {
        const slot = regBytes.subarray(i * reg.entrySize, (i + 1) * reg.entrySize);
        const namePtr = Number(scalar(slot, reg.name));
        const handle = Number(scalar(slot, reg.handle));
        if (handle === 0 && namePtr === 0) continue;
        if (handle === 0 && namePtr !== 0) {
          snapshot.issues.push({
            errorCode: 'CorruptList',
            operation: 'queueRegistry',
            message: `xQueueRegistry[${i}] has non-null name pointer without handle`,
            retryable: false,
            completion: 'completed',
          });
          continue;
        }
        registrySlotsActive++;
        addCandidate(handle, 'registry', `xQueueRegistry[${i}]`, {
          registryNamePtr: namePtr,
          registrySlot: i,
          registryMissingName: namePtr === 0,
        });
      }
    } else {
      snapshot.issues.push({
        errorCode: 'InvalidAddress',
        operation: 'queueRegistry',
        message: `xQueueRegistry at 0x${reg.address.toString(16)} outside declared RAM`,
        retryable: false,
        completion: 'completed',
      });
    }
  }

  const validGlobals = layout.queueGlobals.filter(g => isInRam(g.address, g.isPointer ? 4 : qLayout.size, memory.request.ram));
  const pointerGlobals = validGlobals.filter(g => g.isPointer);
  if (pointerGlobals.length > 0) {
    const ptrBytes = await memory.many(pointerGlobals.map(g => ({ start: g.address, size: 4 })));
    pointerGlobals.forEach((g, idx) => {
      const handle = Number(scalar(ptrBytes[idx], { offset: 0, size: 4, typeOffset: '' }));
      if (handle !== 0) addCandidate(handle, 'global', `global ${g.name}`, { symbolName: g.name });
    });
  }
  for (const g of validGlobals.filter(item => !item.isPointer)) {
    addCandidate(g.address, 'global', `static global ${g.name}`, { symbolName: g.name, symbolIsStatic: true });
  }

  // Filter valid RAM addresses vs dangling/corrupt handles.
  const validAddresses: number[] = [];
  for (const [address, cand] of candidates) {
    if (address % 4 !== 0 || !isInRam(address, qLayout.size, memory.request.ram)) {
      corruptEntries.push({
        address,
        kind: 'unknown',
        kindSource: 'Invalid handle address',
        name: cand.symbolName ? known(cand.symbolName, 'ELF symbol', 'text') : unknown('Invalid object address', 'Object discovery', 'text'),
        ...(cand.symbolName ? { symbolName: cand.symbolName } : {}),
        discoverySources: [...cand.sources],
        discoveryNote: cand.notes.join('; '),
        health: 'deleting-or-corrupt',
        healthReason: `Object address 0x${address.toString(16)} is unaligned or outside declared RAM (deleted or uninitialized)`,
        queueNumber: unknown('Invalid object address', 'Queue_t', 'count'),
        messagesWaiting: unknown('Invalid object address', 'Queue_t', 'count'),
        length: unknown('Invalid object address', 'Queue_t', 'count'),
        itemSize: unknown('Invalid object address', 'Queue_t', 'bytes'),
        staticallyAllocated: unknown('Invalid object address', 'Queue_t', 'boolean'),
        rxLock: unknown('Invalid object address', 'Queue_t', 'count'),
        txLock: unknown('Invalid object address', 'Queue_t', 'count'),
        waitingToReceiveCount: unknown('Invalid object address', 'Queue_t', 'count'),
        waitingToSendCount: unknown('Invalid object address', 'Queue_t', 'count'),
        waitListEvidence: 'corrupt',
      });
    } else {
      validAddresses.push(address);
    }
  }

  const queueBytesMap = new Map<number, Uint8Array>();
  if (validAddresses.length > 0) {
    const blocks = await memory.many(validAddresses.map(start => ({ start, size: qLayout.size })));
    validAddresses.forEach((addr, idx) => queueBytesMap.set(addr, blocks[idx]));
  }

  // Step 2: Check blocked tasks' xEventListItem.pvContainer for unregistered objects not in registry/globals.
  const knownWaitLists = new Set<number>();
  const pendingListAddress = layout.lists.find(l => l.state === 'pending')?.address;
  const sendOff = qLayout.fields.xTasksWaitingToSend.offset;
  const recvOff = qLayout.fields.xTasksWaitingToReceive.offset;
  for (const addr of validAddresses) {
    knownWaitLists.add(addr + sendOff);
    knownWaitLists.add(addr + recvOff);
  }

  const eventWaitersByList = new Map<number, number[]>();
  const eventOffset = layout.tcb.fields.xEventListItem.offset;
  for (const task of snapshot.tasks) {
    const tcb = taskResult.taskBytes.get(task.tcbAddress);
    if (!tcb) continue;
    const eventItem = tcb.subarray(eventOffset, eventOffset + layout.item.size);
    const container = Number(scalar(eventItem, layout.item.container));
    const owner = Number(scalar(eventItem, layout.item.owner));
    if (!container || container === pendingListAddress || knownWaitLists.has(container)) continue;
    if (owner !== task.tcbAddress) continue;
    const list = eventWaitersByList.get(container) || [];
    list.push(task.tcbAddress);
    eventWaitersByList.set(container, list);
  }

  const unresolvedWaits: UnresolvedWaitTarget[] = [];
  for (const [listAddr, waitingTasks] of eventWaitersByList) {
    let matchedQueue = false;
    for (const candidateBase of [listAddr - recvOff, listAddr - sendOff]) {
      if (candidateBase % 4 !== 0 || !isInRam(candidateBase, qLayout.size, memory.request.ram)) continue;
      if (queueBytesMap.has(candidateBase)) { matchedQueue = true; break; }
      try {
        const [qBytes] = await memory.many([{ start: candidateBase, size: qLayout.size }]);
        const sendBytes = qBytes.subarray(sendOff, sendOff + layout.list.size);
        const recvBytes = qBytes.subarray(recvOff, recvOff + layout.list.size);
        const len = Number(scalar(qBytes, qLayout.fields.uxLength));
        const waiting = Number(scalar(qBytes, qLayout.fields.uxMessagesWaiting));
        const rx = signedScalar(qBytes, qLayout.fields.cRxLock);
        const tx = signedScalar(qBytes, qLayout.fields.cTxLock);
        const qType = qLayout.fields.ucQueueType ? Number(scalar(qBytes, qLayout.fields.ucQueueType)) : 0;
        if (len === 0 || waiting > len || rx < -1 || tx < -1 || qType > 4) continue;
        if (!hasValidListHeader(sendBytes, candidateBase + sendOff, layout, memory.request.ram, memory.limits.nodes)) continue;
        if (!hasValidListHeader(recvBytes, candidateBase + recvOff, layout, memory.request.ram, memory.limits.nodes)) continue;
        const targetListBytes = listAddr === candidateBase + sendOff ? sendBytes : recvBytes;
        const traversed = await traverseEventWaitList(listAddr, targetListBytes, layout, memory, taskResult, new Set<number>());
        if (!traversed.ok || !traversed.waiters.some(w => waitingTasks.includes(w.taskAddress))) continue;

        queueBytesMap.set(candidateBase, qBytes);
        validAddresses.push(candidateBase);
        knownWaitLists.add(candidateBase + sendOff);
        knownWaitLists.add(candidateBase + recvOff);
        addCandidate(candidateBase, 'list', `task xEventListItem (0x${listAddr.toString(16)})`);
        matchedQueue = true;
        break;
      } catch {
        // Ignore candidate failure and continue checking or mark unresolved.
      }
    }
    if (!matchedQueue) {
      unresolvedWaits.push({
        listAddress: listAddr,
        waitingTaskAddresses: waitingTasks,
        reason: '等待列表不属于已知 Queue_t，且未通过双列表结构校验（可能为 EventGroup 或非队列同步对象）',
      });
    }
  }

  // Step 3: Verify heap lifecycle where supported, decode every Queue_t, optionally traverse wait lists, and resolve edges.
  const lifecycleInspection = await inspectHeapObjectLifecycles(
    layout,
    memory,
    validAddresses.map(addr => {
      const bytes = queueBytesMap.get(addr)!;
      const cand = candidates.get(addr)!;
      const staticVal = qLayout.fields.ucStaticallyAllocated
        ? Number(scalar(bytes, qLayout.fields.ucStaticallyAllocated)) !== 0
        : undefined;
      return {
        address: addr,
        objectSize: qLayout.size,
        ...(staticVal !== undefined ? { staticallyAllocated: staticVal } : {}),
        ...(cand.symbolIsStatic ? { symbolIsStatic: true } : {}),
      };
    }),
  );

  const tasksByAddr = new Map(snapshot.tasks.map(t => [t.tcbAddress, t]));
  const detailFilter = options.objectAddresses ? new Set(options.objectAddresses) : undefined;
  const shouldTraverseDetails = (addr: number) => detailFilter ? detailFilter.has(addr) : options.includeWaitDetails !== false;

  const objects: SyncObjectSnapshot[] = [...corruptEntries];
  const waitEdges: WaitEdge[] = [];
  const seenListNodes = new Set<number>();

  for (const addr of validAddresses) {
    const bytes = queueBytesMap.get(addr)!;
    const cand = candidates.get(addr)!;
    const f = qLayout.fields;

    const length = Number(scalar(bytes, f.uxLength));
    const messagesWaiting = Number(scalar(bytes, f.uxMessagesWaiting));
    const itemSize = Number(scalar(bytes, f.uxItemSize));
    const rxLock = signedScalar(bytes, f.cRxLock);
    const txLock = signedScalar(bytes, f.cTxLock);

    const sendListBytes = bytes.subarray(sendOff, sendOff + layout.list.size);
    const recvListBytes = bytes.subarray(recvOff, recvOff + layout.list.size);
    const sendHeaderOk = hasValidListHeader(sendListBytes, addr + sendOff, layout, memory.request.ram, memory.limits.nodes);
    const recvHeaderOk = hasValidListHeader(recvListBytes, addr + recvOff, layout, memory.request.ram, memory.limits.nodes);
    const sendCount = Number(scalar(sendListBytes, layout.list.count));
    const recvCount = Number(scalar(recvListBytes, layout.list.count));

    const kindInfo = classifyQueueKind(qLayout, bytes);
    const lifecycle = lifecycleInspection.verdicts.get(addr);
    let health: ObjectHealth = 'valid';
    const healthReasons: string[] = [];
    if (lifecycle?.status === 'confirmed-freed' || lifecycle?.corruptBlockHeader) {
      health = 'deleting-or-corrupt';
      healthReasons.push(lifecycle.reason);
    }
    if (length === 0 || messagesWaiting > length || rxLock < -1 || txLock < -1) {
      health = 'deleting-or-corrupt';
      healthReasons.push(`Invalid queue counters (uxLength=${length}, uxMessagesWaiting=${messagesWaiting}, rxLock=${rxLock}, txLock=${txLock})`);
    }
    if (!sendHeaderOk || !recvHeaderOk) {
      health = 'deleting-or-corrupt';
      healthReasons.push('Wait list header sentinel/count invalid (object may be deleted or overwritten)');
    }
    if (cand.registryMissingName && health === 'valid') {
      healthReasons.push('xQueueRegistry entry has handle without name (unregistering or registered with NULL)');
    }
    if (kindInfo.inconsistent) {
      health = 'deleting-or-corrupt';
      healthReasons.push(kindInfo.inconsistent);
    }

    let nameField: Field<string>;
    if (cand.registryNamePtr) {
      nameField = await resolveCString(cand.registryNamePtr, `xQueueRegistry[${cand.registrySlot}].pcQueueName`, memory, options.readRodata);
    } else if (cand.symbolName) {
      nameField = known(cand.symbolName, 'ELF symbol (unregistered)', 'text');
    } else if (cand.registryMissingName) {
      nameField = unknown('xQueueRegistry slot pcQueueName is NULL (deleting or unnamed)', 'xQueueRegistry', 'text');
    } else {
      nameField = unknown('Unregistered (not in xQueueRegistry and no global handle)', 'Object discovery', 'text');
    }

    // Holder only applies to mutexes / recursive mutexes.
    let holder: SyncObjectHolder | undefined;
    if (health !== 'deleting-or-corrupt' && (kindInfo.kind === 'mutex' || kindInfo.kind === 'recursive-mutex')) {
      if (f.xMutexHolder) {
        const holderAddr = Number(scalar(bytes, f.xMutexHolder));
        const recField = f.uxRecursiveCallCount
          ? known(Number(scalar(bytes, f.uxRecursiveCallCount)), 'Queue_t.u.xSemaphore.uxRecursiveCallCount', 'count')
          : unknown<number>('uxRecursiveCallCount not in DWARF', 'Queue_t', 'count');
        if (holderAddr === 0) {
          const inconsistentUnheld = messagesWaiting === 0;
          holder = {
            address: null,
            recursiveCallCount: recField,
            confidence: inconsistentUnheld || snapshot.consistency === 'partial'
              ? 'partial-unverified'
              : snapshot.consistency === 'halted-consistent' ? 'halted-verified' : 'live-best-effort',
            evidence: inconsistentUnheld
              ? 'xMutexHolder==0 while uxMessagesWaiting==0 (transient or corrupt state)'
              : 'xMutexHolder==NULL (unheld)',
          };
          if (inconsistentUnheld && health === 'valid') {
            health = 'incomplete';
            healthReasons.push('Mutex has NULL holder while uxMessagesWaiting==0');
          }
        } else {
          const holderTask = tasksByAddr.get(holderAddr);
          const consistentHold = !!holderTask && messagesWaiting === 0;
          const confidence: WaitRelationConfidence = !consistentHold || snapshot.consistency === 'partial'
            ? 'partial-unverified'
            : snapshot.consistency === 'halted-consistent' ? 'halted-verified' : 'live-best-effort';
          holder = {
            address: holderAddr,
            ...(holderTask?.name.available ? { taskName: holderTask.name.value } : {}),
            ...(holderTask?.creationNumber.available ? { creationNumber: holderTask.creationNumber.value } : {}),
            recursiveCallCount: recField,
            confidence,
            evidence: holderTask
              ? (consistentHold ? `xMutexHolder=0x${holderAddr.toString(16)} verified in task snapshot` : `xMutexHolder=0x${holderAddr.toString(16)} inconsistent with uxMessagesWaiting=${messagesWaiting}`)
              : `xMutexHolder=0x${holderAddr.toString(16)} missing from task snapshot`,
          };
        }
      }
    }

    let waitListEvidence: SyncObjectSnapshot['waitListEvidence'] = health === 'deleting-or-corrupt' ? 'corrupt' : 'summary-only';
    let waitingToReceive: TaskWaitSummary[] | undefined;
    let waitingToSend: TaskWaitSummary[] | undefined;

    if (health !== 'deleting-or-corrupt' && shouldTraverseDetails(addr)) {
      const recvTraversed = recvCount > 0
        ? await traverseEventWaitList(addr + recvOff, recvListBytes, layout, memory, taskResult, seenListNodes)
        : { ok: true, count: 0, waiters: [] };
      const sendTraversed = sendCount > 0
        ? await traverseEventWaitList(addr + sendOff, sendListBytes, layout, memory, taskResult, seenListNodes)
        : { ok: true, count: 0, waiters: [] };

      if (!recvTraversed.ok || !sendTraversed.ok) {
        waitListEvidence = 'corrupt';
        health = 'deleting-or-corrupt';
        healthReasons.push(recvTraversed.reason || sendTraversed.reason || 'Corrupt wait list');
      } else {
        waitListEvidence = 'traversed';
        waitingToReceive = recvTraversed.waiters;
        waitingToSend = sendTraversed.waiters;

        for (const [direction, waiters] of [['receive', waitingToReceive], ['send', waitingToSend]] as const) {
          for (const w of waiters) {
            const conf: WaitRelationConfidence = !w.taskListVerified || snapshot.consistency === 'partial'
              ? 'partial-unverified'
              : snapshot.consistency === 'halted-consistent' ? 'halted-verified' : 'live-best-effort';
            waitEdges.push({
              taskAddress: w.taskAddress,
              ...(w.taskName ? { taskName: w.taskName } : {}),
              objectAddress: addr,
              ...(nameField.available ? { objectName: nameField.value } : {}),
              objectKind: kindInfo.kind,
              direction,
              ...(holder?.address ? { heldByTaskAddress: holder.address, ...(holder.taskName ? { heldByTaskName: holder.taskName } : {}) } : {}),
              confidence: conf,
              evidence: w.taskListVerified
                ? `${direction === 'receive' ? 'xTasksWaitingToReceive' : 'xTasksWaitingToSend'} 双向链表与 TCB.xEventListItem 互相校验`
                : '仅队列等待链表发现（TCB.xEventListItem.pvContainer 未匹配）',
            });
          }
        }
      }
    }

    objects.push({
      address: addr,
      kind: kindInfo.kind,
      kindSource: kindInfo.kindSource,
      ...(kindInfo.kindUncertain ? { kindUncertain: true } : {}),
      name: nameField,
      ...(cand.symbolName ? { symbolName: cand.symbolName } : {}),
      discoverySources: [...cand.sources],
      discoveryNote: cand.notes.join('; '),
      health,
      ...(healthReasons.length ? { healthReason: healthReasons.join('; ') } : {}),
      ...(lifecycle ? {
        lifecycle: lifecycle.status,
        lifecycleReason: lifecycle.reason,
        heapBlock: lifecycle.heapBlock,
        heapBlockReason: lifecycle.heapBlockReason,
      } : {}),
      queueNumber: f.uxQueueNumber ? known(Number(scalar(bytes, f.uxQueueNumber)), 'Queue_t.uxQueueNumber', 'count') : unknown('uxQueueNumber not in DWARF', 'Queue_t', 'count'),
      messagesWaiting: known(messagesWaiting, 'Queue_t.uxMessagesWaiting', 'count'),
      length: known(length, 'Queue_t.uxLength', 'count'),
      itemSize: known(itemSize, 'Queue_t.uxItemSize', 'bytes'),
      staticallyAllocated: f.ucStaticallyAllocated
        ? known(Number(scalar(bytes, f.ucStaticallyAllocated)) !== 0, 'Queue_t.ucStaticallyAllocated', 'boolean')
        : unknown('ucStaticallyAllocated not in DWARF', 'Queue_t', 'boolean'),
      rxLock: known(rxLock, 'Queue_t.cRxLock', 'count'),
      txLock: known(txLock, 'Queue_t.cTxLock', 'count'),
      ...(holder ? { holder } : {}),
      waitingToReceiveCount: known(recvCount, 'Queue_t.xTasksWaitingToReceive.uxNumberOfItems', 'count'),
      waitingToSendCount: known(sendCount, 'Queue_t.xTasksWaitingToSend.uxNumberOfItems', 'count'),
      ...(waitingToReceive ? { waitingToReceive } : {}),
      ...(waitingToSend ? { waitingToSend } : {}),
      waitListEvidence,
    });
  }

  const waitCycles = detectWaitCycles(waitEdges, objects, snapshot.consistency);
  const registryCount = objects.filter(o => o.discoverySources.includes('registry')).length;
  const globalCount = objects.filter(o => o.discoverySources.includes('global')).length;
  const listDiscoveredCount = objects.filter(o => o.discoverySources.includes('list')).length;

  const lifecycleNote = validAddresses.length === 0
    ? ''
    : lifecycleInspection.allocator === 'heap_4'
      ? (lifecycleInspection.walkComplete
        ? '；已通过 heap_4 BlockLink_t 与空闲链表核对堆块状态（块已分配不代表队列身份已确认，同址重用对象仍标为未确认）。'
        : `；heap_4 堆块状态核对未完整完成（${lifecycleInspection.diagnostic || '未确认'}）。`)
      : `；当前堆 (${lifecycleInspection.allocator}) 仅完成结构校验，对象生命周期与堆块状态未确认。`;

  return {
    ...(layout.queueRegistry ? { registryCapacity: layout.queueRegistry.count } : {}),
    registryCount,
    globalCount,
    listDiscoveredCount,
    coverageNote: (layout.queueRegistry
      ? `已检查 xQueueRegistry(${layout.queueRegistry.count} 槽位)、${layout.queueGlobals.length} 个全局队列句柄及阻塞任务等待链表；未注册且无全局/等待引用的堆队列不会显示`
      : `xQueueRegistry 未启用；仅通过 ${layout.queueGlobals.length} 个全局队列句柄与阻塞任务等待链表发现对象，未引用堆对象不会显示`) + (lifecycleNote || '。'),
    objects,
    waitEdges,
    waitCycles,
    unresolvedWaits,
  };
}
