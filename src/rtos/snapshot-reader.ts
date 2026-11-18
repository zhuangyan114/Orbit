import type { FreeRtosLayout, Member } from './freertos-layout';
import { Field, known, unknown, RtosError, RtosIssue, RtosSnapshot, SnapshotDiagnostics, SnapshotIdentity, TaskSnapshot } from './model';

export interface AddressRange { start: number; size: number; }
export interface SnapshotLimits { bytes: number; batches: number; nodes: number; timeMs: number; }
export const SNAPSHOT_LIMITS: SnapshotLimits = { bytes: 128 * 1024, batches: 1024, nodes: 256, timeMs: 5000 };
export interface SnapshotRequest {
  identity: SnapshotIdentity; sequence: number; targetState: RtosSnapshot['targetState'];
  ram: AddressRange[]; signal: AbortSignal;
  read(address: number, size: number): Promise<Uint8Array>;
  limits?: Partial<SnapshotLimits>;
}
export const scalar = (bytes: Uint8Array, field: Member): bigint => {
  if (field.offset < 0 || field.offset + field.size > bytes.length || ![1, 2, 4, 8].includes(field.size)) throw new RtosError('ShortRead', 'Scalar exceeds memory block');
  let value = 0n;
  for (let index = field.size - 1; index >= 0; index--) value = (value << 8n) | BigInt(bytes[field.offset + index]);
  return value;
};

/** Each transport slice is <=256 bytes. The DAP gate is released between slices. */
export class SnapshotMemory {
  readonly startedAt = Date.now();
  readonly diagnostics: SnapshotDiagnostics = { bytes: 0, batches: 0, rounds: 0, nodes: 0, coveredLists: [], queueWaitMs: 0, ioMs: 0, parseMs: 0, totalMs: 0 };
  readonly limits: SnapshotLimits;
  constructor(readonly request: SnapshotRequest) {
    this.limits = { ...SNAPSHOT_LIMITS };
    for (const key of Object.keys(this.limits) as (keyof SnapshotLimits)[]) {
      const value = request.limits?.[key];
      if (value !== undefined) {
        if (!Number.isFinite(value) || value <= 0) throw new RtosError('BudgetExceeded', `Invalid ${key} budget`);
        this.limits[key] = Math.min(this.limits[key], Math.floor(value));
      }
    }
  }
  check() {
    if (this.request.signal.aborted) throw new RtosError('TargetReadCancelled', 'Snapshot cancelled');
    if (Date.now() - this.startedAt > this.limits.timeMs) throw new RtosError('BudgetExceeded', 'Snapshot time budget exhausted');
  }
  validate(address: number, size: number) {
    if (!Number.isSafeInteger(address) || !Number.isSafeInteger(size) || address <= 0 || size <= 0 || address + size > 0x1_0000_0000
      || !this.request.ram.some(range => Number.isSafeInteger(range.start) && Number.isSafeInteger(range.size)
        && range.start <= address && address + size <= range.start + range.size)) {
      throw new RtosError('InvalidAddress', `Outside declared RAM: 0x${address.toString(16)} + ${size}`);
    }
  }
  async many(ranges: AddressRange[]): Promise<Uint8Array[]> {
    this.check(); this.diagnostics.rounds++;
    const chunks: AddressRange[] = [];
    for (const range of ranges) {
      this.validate(range.start, range.size);
      for (let offset = 0; offset < range.size; offset += 256) chunks.push({ start: range.start + offset, size: Math.min(256, range.size - offset) });
    }
    chunks.sort((a, b) => a.start - b.start);
    const merged: AddressRange[] = [];
    for (const range of chunks) {
      const last = merged.at(-1), end = range.start + range.size;
      if (last && range.start <= last.start + last.size + 16 && Math.max(end, last.start + last.size) - last.start <= 256
        && this.request.ram.some(r => r.start <= last.start && Math.max(end, last.start + last.size) <= r.start + r.size)) last.size = Math.max(end - last.start, last.size);
      else merged.push({ ...range });
    }
    const blocks: { start: number; bytes: Uint8Array }[] = [];
    for (const range of merged) {
      this.check();
      if (this.diagnostics.bytes + range.size > this.limits.bytes || this.diagnostics.batches >= this.limits.batches) throw new RtosError('BudgetExceeded', 'Snapshot I/O budget exhausted');
      this.diagnostics.bytes += range.size; this.diagnostics.batches++;
      const started = Date.now();
      const bytes = await this.request.read(range.start, range.size);
      this.diagnostics.ioMs += Date.now() - started;
      this.check();
      if (bytes.length !== range.size) throw new RtosError('ShortRead', `Requested ${range.size} bytes at 0x${range.start.toString(16)}, received ${bytes.length}`);
      blocks.push({ start: range.start, bytes });
    }
    return ranges.map(range => {
      const bytes = new Uint8Array(range.size);
      let copied = 0;
      for (const block of blocks) {
        const start = Math.max(range.start, block.start), end = Math.min(range.start + range.size, block.start + block.bytes.length);
        if (end > start) { bytes.set(block.bytes.subarray(start - block.start, end - block.start), start - range.start); copied += end - start; }
      }
      if (copied !== range.size) throw new RtosError('ShortRead', 'Incomplete merged range');
      return bytes;
    });
  }
}

const issue = (error: unknown, operation: string): RtosIssue => ({
  errorCode: error instanceof RtosError ? error.errorCode : 'MemoryReadFailed', operation,
  message: error instanceof Error ? error.message : String(error), retryable: false, completion: 'completed',
});
const missing = <T>(name: string, unit: string): Field<T> => unknown(`${name} not present in DWARF`, name, unit);

export interface SnapshotReadResult { snapshot: RtosSnapshot; memory: SnapshotMemory; taskBytes: Map<number, Uint8Array>; }

export async function readTaskSnapshot(layout: FreeRtosLayout, request: SnapshotRequest): Promise<SnapshotReadResult> {
  const memory = new SnapshotMemory(request), tasks: TaskSnapshot[] = [], issues: RtosIssue[] = [], taskBytes = new Map<number, Uint8Array>();
  let anchorsEqual = false;
  let runtimeTotal: Field<string> = unknown('Kernel total counter unavailable', 'ulTotalRunTime', 'counter-ticks');
  const anchors = [{ start: layout.current, size: 4 }, { start: layout.taskCount, size: layout.taskCountBytes },
    ...layout.lists.map(list => ({ start: list.address, size: layout.list.size })),
    ...(layout.runtimeTotal ? [{ start: layout.runtimeTotal.address, size: layout.runtimeTotal.size }] : [])];
  try {
    const before = await memory.many(anchors);
    const current = Number(scalar(before[0], { offset: 0, size: 4, typeOffset: '' }));
    const count = Number(scalar(before[1], { offset: 0, size: layout.taskCountBytes, typeOffset: '' }));
    if (count > memory.limits.nodes) throw new RtosError('BudgetExceeded', `Task count ${count} exceeds node budget`);
    const cursors = layout.lists.map((list, index) => {
      const bytes = before[index + 2], length = Number(scalar(bytes, layout.list.count));
      const sentinel = list.address + layout.list.end.offset;
      return { list, length, sentinel, next: Number(scalar(bytes, layout.list.endNext)), last: Number(scalar(bytes, layout.list.endPrevious)), previous: sentinel, visited: 0 };
    });
    const seen = new Set<number>(), memberships = new Map<number, { list: typeof layout.lists[number]; node: number }[]>();
    for (;;) {
      const active = cursors.filter(cursor => cursor.next !== cursor.sentinel);
      if (!active.length) break;
      for (const cursor of active) {
        if (cursor.length > memory.limits.nodes || cursor.visited >= cursor.length || seen.has(cursor.next)) throw new RtosError('CorruptList', `Cycle/count mismatch in ${cursor.list.name}`);
        if (++memory.diagnostics.nodes > memory.limits.nodes) throw new RtosError('BudgetExceeded', 'List node budget exhausted');
        if (cursor.next % 4) throw new RtosError('InvalidAddress', 'Unaligned list item');
        seen.add(cursor.next);
      }
      const nodes = await memory.many(active.map(cursor => ({ start: cursor.next, size: layout.item.size })));
      nodes.forEach((bytes, index) => {
        const cursor = active[index], owner = Number(scalar(bytes, layout.item.owner));
        if (Number(scalar(bytes, layout.item.previous)) !== cursor.previous || Number(scalar(bytes, layout.item.container)) !== cursor.list.address)
          throw new RtosError('CorruptList', `Broken links in ${cursor.list.name}`);
        const expected = cursor.list.state === 'pending' ? layout.tcb.fields.xEventListItem : layout.tcb.fields.xStateListItem;
        if (owner % 4 || owner + expected.offset !== cursor.next) throw new RtosError('CorruptList', `Invalid owner in ${cursor.list.name}`);
        memory.validate(owner, layout.tcb.size);
        const membership = memberships.get(owner) || [];
        if (membership.some(entry => entry.list.state !== 'pending' && cursor.list.state !== 'pending')) throw new RtosError('CorruptList', 'Task belongs to multiple state lists');
        membership.push({ list: cursor.list, node: cursor.next }); memberships.set(owner, membership);
        cursor.previous = cursor.next; cursor.next = Number(scalar(bytes, layout.item.next)); cursor.visited++;
      });
    }
    for (const cursor of cursors) {
      if (cursor.visited !== cursor.length || cursor.last !== cursor.previous) throw new RtosError('CorruptList', `Tail/count mismatch in ${cursor.list.name}`);
      memory.diagnostics.coveredLists.push(cursor.list.name);
    }
    const addresses = [...memberships.keys()];
    const blocks = await memory.many(addresses.map(start => ({ start, size: layout.tcb.size })));
    addresses.forEach((address, index) => {
      const bytes = blocks[index], fields = layout.tcb.fields, entries = memberships.get(address)!;
      taskBytes.set(address, bytes);
      const value = (name: string, unit: string): Field<number> => fields[name] ? known(Number(scalar(bytes, fields[name])), `TCB.${name}`, unit) : missing(name, unit);
      const runtime = fields.ulRunTimeCounter ? known(scalar(bytes, fields.ulRunTimeCounter).toString(), 'TCB.ulRunTimeCounter', 'counter-ticks') : missing<string>('ulRunTimeCounter', 'counter-ticks');
      const number = fields.uxTCBNumber ? known(scalar(bytes, fields.uxTCBNumber).toString(), 'TCB.uxTCBNumber', 'count') : missing<string>('uxTCBNumber', 'count');
      const name = bytes.subarray(fields.pcTaskName.offset, fields.pcTaskName.offset + layout.tcb.nameBytes);
      const zero = name.indexOf(0);
      const membership = entries.find(entry => entry.list.state !== 'pending');
      let state: TaskSnapshot['state'] = membership && membership.list.state !== 'pending' ? membership.list.state : 'unknown';
      if (state === 'suspended') {
        const event = bytes.subarray(fields.xEventListItem.offset, fields.xEventListItem.offset + layout.item.size);
        if (scalar(event, layout.item.container) !== 0n) state = 'blocked';
      }
      if (address === current) state = 'running';
      for (const entry of entries) {
        const field = entry.list.state === 'pending' ? fields.xEventListItem : fields.xStateListItem;
        const item = bytes.subarray(field.offset, field.offset + layout.item.size);
        if (Number(scalar(item, layout.item.container)) !== entry.list.address || Number(scalar(item, layout.item.owner)) !== address) throw new RtosError('SnapshotChanged', 'TCB membership changed while reading');
      }
      tasks.push({ tcbAddress: address, creationNumber: number, identityCertain: number.available,
        name: zero < 0 ? unknown('Task name is not terminated', 'TCB.pcTaskName', 'text') : known(Buffer.from(name.subarray(0, zero)).toString('utf8'), 'TCB.pcTaskName', 'text'),
        state, lists: entries.map(entry => entry.list.name), current: address === current,
        priority: value('uxPriority', 'priority'), basePriority: value('uxBasePriority', 'priority'),
        stack: { base: value('pxStack', 'address'), end: value('pxEndOfStack', 'address'),
          growthDirection: unknown('Port contract required', 'portSTACK_GROWTH', 'enum'), wordBytes: known(layout.tcb.stackWordBytes, 'DWARF StackType_t', 'bytes'),
          capacityBytes: unknown('Port contract required', 'TCB stack bounds', 'bytes'), watermarkBytes: unknown('Not requested', 'Stack fill scan', 'bytes'),
          fillByte: unknown('Port contract required', 'tskSTACK_FILL_BYTE', 'byte'), scannedBytes: 0, scanComplete: false, scanMs: 0 },
        runtime: { counter: runtime, bits: fields.ulRunTimeCounter ? known(fields.ulRunTimeCounter.size * 8, 'DWARF ulRunTimeCounter', 'bits') : missing('ulRunTimeCounter', 'bits'),
          percent: unknown('First interval or counter contract required', 'Kernel counter difference', 'percent'), intervalMs: unknown('No valid interval', 'Host monotonic interval', 'ms') },
      });
    });
    if (tasks.length !== count || (count > 0 && !tasks.some(task => task.current))) throw new RtosError('SnapshotChanged', 'Task count/current task does not match lists');
    const after = await memory.many(anchors);
    if (layout.runtimeTotal) runtimeTotal = known(scalar(after.at(-1)!, { offset: 0, size: layout.runtimeTotal.size, typeOffset: '' }).toString(), 'ulTotalRunTime (last context switch)', 'counter-ticks');
    anchorsEqual = before.slice(0, 2 + layout.lists.length).every((bytes, index) => Buffer.from(bytes).equals(Buffer.from(after[index])));
    if (!anchorsEqual) throw new RtosError('SnapshotChanged', 'Kernel anchors changed during snapshot');
  } catch (error) { issues.push(issue(error, 'taskSnapshot')); }
  const completedAt = Date.now();
  memory.diagnostics.totalMs = completedAt - memory.startedAt;
  memory.diagnostics.parseMs = Math.max(0, memory.diagnostics.totalMs - memory.diagnostics.ioMs);
  const cancelled = issues.some(entry => entry.errorCode === 'TargetReadCancelled' || entry.errorCode === 'SessionChanged');
  const snapshot: RtosSnapshot = { ...request.identity, version: 1, snapshotSequence: request.sequence,
    startedAt: memory.startedAt, completedAt, targetState: request.targetState,
    consistency: cancelled ? 'unavailable' : issues.length ? 'partial' : request.targetState === 'Halted' && anchorsEqual ? 'halted-consistent' : 'live-best-effort',
    ...(issues.length ? { reason: issues[0].message } : {}),
    kernel: { name: 'FreeRTOS', version: unknown('Version not encoded in kernel roots', layout.source, 'text'), source: layout.source },
    tasks: cancelled ? [] : tasks, runtimeTotal,
    runtimeTotalBits: layout.runtimeTotal ? known(layout.runtimeTotal.size * 8, 'DWARF ulTotalRunTime', 'bits') : unknown('Counter unavailable', 'ulTotalRunTime', 'bits'),
    issues, diagnostics: memory.diagnostics };
  return { snapshot, memory, taskBytes };
}
