import type { SymbolCatalog, SymbolType } from '../symbols/symbol-catalog';

/** Synthetic independent ABI: padding differs from the board fixture on purpose. */
export function testCatalog(): SymbolCatalog {
  const types: Record<string, SymbolType> = {
    u32: { name: 'uint32_t', kind: 'base', byteSize: 4 },
    char: { name: 'char', kind: 'base', byteSize: 1 },
    ptr: { name: '', kind: 'pointer', byteSize: 4, typeOffset: 'u32' },
    taskPtr: { name: '', kind: 'pointer', byteSize: 4, typeOffset: 'volatileTcb' },
    volatileTcb: { name: '', kind: 'volatile', byteSize: 0, typeOffset: 'aliasTcb' },
    aliasTcb: { name: 'TCB_t', kind: 'typedef', byteSize: 0, typeOffset: 'tcb' },
    name: { name: '', kind: 'array', byteSize: 16, arrayCount: 16, typeOffset: 'char' },
    item: { name: 'ListItem_t', kind: 'struct', byteSize: 24, fields: [
      { name: 'pxNext', byteOffset: 8, typeOffset: 'ptr' }, { name: 'pxPrevious', byteOffset: 12, typeOffset: 'ptr' },
      { name: 'pvOwner', byteOffset: 16, typeOffset: 'ptr' }, { name: 'pvContainer', byteOffset: 20, typeOffset: 'ptr' },
    ] },
    mini: { name: 'MiniListItem_t', kind: 'struct', byteSize: 16, fields: [
      { name: 'pxNext', byteOffset: 8, typeOffset: 'ptr' }, { name: 'pxPrevious', byteOffset: 12, typeOffset: 'ptr' },
    ] },
    list: { name: 'List_t', kind: 'struct', byteSize: 32, fields: [
      { name: 'uxNumberOfItems', byteOffset: 4, typeOffset: 'u32' }, { name: 'xListEnd', byteOffset: 16, typeOffset: 'mini' },
    ] },
    ready: { name: '', kind: 'array', byteSize: 64, arrayCount: 2, typeOffset: 'list' },
    tcb: { name: 'tskTaskControlBlock', kind: 'struct', byteSize: 112, fields: [
      { name: 'pxTopOfStack', byteOffset: 4, typeOffset: 'ptr' }, { name: 'xStateListItem', byteOffset: 12, typeOffset: 'item' },
      { name: 'xEventListItem', byteOffset: 36, typeOffset: 'item' }, { name: 'uxPriority', byteOffset: 64, typeOffset: 'u32' },
      { name: 'pxStack', byteOffset: 68, typeOffset: 'ptr' }, { name: 'pcTaskName', byteOffset: 72, typeOffset: 'name' },
      { name: 'pxEndOfStack', byteOffset: 88, typeOffset: 'ptr' }, { name: 'uxTCBNumber', byteOffset: 92, typeOffset: 'u32' },
      { name: 'uxBasePriority', byteOffset: 96, typeOffset: 'u32' }, { name: 'ulRunTimeCounter', byteOffset: 100, typeOffset: 'u32' },
    ] },
    unrelated: { name: 'tskTaskControlBlock', kind: 'struct', byteSize: 4, fields: [] },
  };
  const roots = [
    ['pxCurrentTCB', 0x1000, 'taskPtr', 4], ['uxCurrentNumberOfTasks', 0x1004, 'u32', 4], ['pxReadyTasksLists', 0x1020, 'ready', 64],
    ['xDelayedTaskList1', 0x1060, 'list', 32], ['xDelayedTaskList2', 0x1080, 'list', 32],
    ['xSuspendedTaskList', 0x10a0, 'list', 32], ['xPendingReadyList', 0x10c0, 'list', 32], ['xTasksWaitingTermination', 0x10e0, 'list', 32],
  ].map(([expression, address, typeOffset, size], index) => ({ id: String(index), expression: String(expression), address: Number(address),
    typeOffset: String(typeOffset), size: Number(size), file: 'kernel/tasks.c', pointerDepth: 0 }));
  return { roots, types };
}
