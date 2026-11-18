import { createHash } from 'crypto';
import type { SymbolCatalog, SymbolNode, SymbolType } from '../symbols/symbol-catalog';
import { symbolByteSize, symbolType } from '../symbols/symbol-catalog';
import { RtosError } from './model';

export interface Member { offset: number; size: number; typeOffset: string; }
export interface ListRoot { name: string; address: number; state: 'ready' | 'blocked' | 'suspended' | 'termination' | 'pending'; }
export interface FreeRtosLayout {
  elfSha256: string; layoutId: string;
  source: string;
  current: number; taskCount: number; taskCountBytes: number;
  runtimeTotal?: { address: number; size: number };
  lists: ListRoot[];
  list: { size: number; count: Member; end: Member; endNext: Member; endPrevious: Member };
  item: { size: number; next: Member; previous: Member; owner: Member; container: Member };
  tcb: { size: number; typeOffset: string; fields: Record<string, Member>; nameBytes: number; stackWordBytes: number };
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
  for (const name of ['uxBasePriority', 'pxEndOfStack', 'uxTCBNumber', 'ulRunTimeCounter']) {
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
    lists.push({ name, address: node.address!, state });
  }
  const taskCountBytes = symbolByteSize(catalog, count.typeOffset);
  if (![1, 2, 4].includes(taskCountBytes) || count.size !== taskCountBytes) fail('LayoutIncomplete', 'Invalid task count');
  const total = root('ulTotalRunTime', false);
  const totalSize = total ? symbolByteSize(catalog, total.typeOffset) : 0;
  if (total && ![4, 8].includes(totalSize)) fail('LayoutIncomplete', 'Invalid runtime total');
  const plan = { elfSha256, source: `DWARF:${current.file}:${tcbOffset}`, current: current.address!, taskCount: count.address!, taskCountBytes,
    ...(total ? { runtimeTotal: { address: total.address!, size: totalSize } } : {}),
    lists, list, item, tcb: { size: tcbType.byteSize, typeOffset: tcbOffset, fields, nameBytes: fields.pcTaskName.size, stackWordBytes } };
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
