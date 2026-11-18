/** RTOS snapshot v1. Unknown fields deliberately have no value. */
export type Field<T> = { source: string; unit: string } &
  ({ available: true; value: T } | { available: false; reason: string });
export const known = <T>(value: T, source: string, unit: string): Field<T> => ({ available: true, value, source, unit });
export const unknown = <T>(reason: string, source: string, unit: string): Field<T> => ({ available: false, reason, source, unit });
export type Consistency = 'halted-consistent' | 'live-best-effort' | 'partial' | 'stale' | 'unavailable';
export interface Capability { available: boolean; reason?: string; evidence: 'source' | 'offline' | 'hardware'; }
export interface SnapshotIdentity {
  sessionId: string;
  sessionGeneration: number;
  operationGeneration: number;
  bootGeneration: number;
  elfSha256: string;
  layoutId: string;
}
export class RtosError extends Error {
  constructor(public readonly errorCode: string, message: string) { super(message); }
}
export interface RtosIssue { errorCode: string; operation: string; message: string; retryable: boolean; completion: 'not-started' | 'completed' | 'unknown'; }

export type ObjectDiscoverySource = 'registry' | 'global' | 'list';
export type QueueObjectKind =
  | 'queue'
  | 'mutex'
  | 'recursive-mutex'
  | 'binary-semaphore'
  | 'counting-semaphore'
  | 'queue-set'
  | 'unknown';
export type ObjectHealth = 'valid' | 'deleting-or-corrupt' | 'incomplete';
export type WaitRelationConfidence = 'halted-verified' | 'live-best-effort' | 'partial-unverified';

export interface TaskWaitSummary {
  taskAddress: number;
  taskName?: string;
  creationNumber?: string;
  taskListVerified: boolean;
}

export interface SyncObjectHolder {
  address: number | null;
  taskName?: string;
  creationNumber?: string;
  recursiveCallCount: Field<number>;
  confidence: WaitRelationConfidence;
  evidence: string;
}

export type HeapBlockLifecycleStatus =
  | 'allocated'
  | 'freed'
  | 'corrupt-header'
  | 'static'
  | 'unverified';

export type ObjectLifecycleStatus =
  | 'confirmed-static'
  | 'confirmed-freed'
  | 'unconfirmed';

export interface SyncObjectSnapshot {
  address: number;
  kind: QueueObjectKind;
  kindSource: string;
  kindUncertain?: boolean;
  name: Field<string>;
  symbolName?: string;
  discoverySources: ObjectDiscoverySource[];
  discoveryNote: string;
  health: ObjectHealth;
  healthReason?: string;
  lifecycle?: ObjectLifecycleStatus;
  lifecycleReason?: string;
  heapBlock?: HeapBlockLifecycleStatus;
  heapBlockReason?: string;
  queueNumber: Field<number>;
  messagesWaiting: Field<number>;
  length: Field<number>;
  itemSize: Field<number>;
  staticallyAllocated: Field<boolean>;
  rxLock: Field<number>;
  txLock: Field<number>;
  holder?: SyncObjectHolder;
  waitingToReceiveCount: Field<number>;
  waitingToSendCount: Field<number>;
  waitingToReceive?: TaskWaitSummary[];
  waitingToSend?: TaskWaitSummary[];
  waitListEvidence: 'summary-only' | 'traversed' | 'corrupt';
}

export interface WaitEdge {
  taskAddress: number;
  taskName?: string;
  objectAddress: number;
  objectName?: string;
  objectKind: QueueObjectKind;
  direction: 'receive' | 'send';
  heldByTaskAddress?: number;
  heldByTaskName?: string;
  confidence: WaitRelationConfidence;
  evidence: string;
}

export interface WaitCycleCandidate {
  tasks: { address: number; name?: string; waitingOnObject: number; objectName?: string }[];
  consistency: Consistency;
  confidence: 'halted-verified' | 'live-best-effort';
  note: string;
}

export interface UnresolvedWaitTarget {
  listAddress: number;
  waitingTaskAddresses: number[];
  reason: string;
}

export interface ObjectsDiscoverySummary {
  registryCapacity?: number;
  registryCount: number;
  globalCount: number;
  listDiscoveredCount: number;
  coverageNote: string;
  objects: SyncObjectSnapshot[];
  waitEdges: WaitEdge[];
  waitCycles: WaitCycleCandidate[];
  unresolvedWaits: UnresolvedWaitTarget[];
}

export interface TaskSnapshot {
  tcbAddress: number;
  creationNumber: Field<string>;
  identityCertain: boolean;
  name: Field<string>;
  state: 'running' | 'ready' | 'blocked' | 'suspended' | 'termination' | 'unknown';
  lists: string[];
  listEvidence: 'traversed' | 'validated-tcb';
  current: boolean;
  priority: Field<number>;
  basePriority: Field<number>;
  stack: {
    base: Field<number>; end: Field<number>; growthDirection: Field<'down' | 'up'>;
    wordBytes: Field<number>; capacityBytes: Field<number>; watermarkBytes: Field<number>;
    fillByte: Field<number>; scannedBytes: number; scanComplete: boolean; scanMs: number;
  };
  runtime: { counter: Field<string>; bits: Field<number>; percent: Field<number>; intervalMs: Field<number>; readWindowMs?: Field<number>; };
}
export interface DetailRefreshBudget {
  limitBytes: number;
  usedBytes: number;
  stackBytes: number;
  objectBytes: number;
  timerBytes: number;
  heapBytes: number;
  exhausted: boolean;
}

export type TimerListState = 'active-current' | 'active-overflow' | 'stopped-global' | 'unknown';

export interface TimerSnapshot {
  address: number;
  name: Field<string>;
  symbolName?: string;
  discoverySources: ('list' | 'global')[];
  listState: TimerListState;
  active: Field<boolean>;
  autoReload: Field<boolean>;
  staticallyAllocated: Field<boolean>;
  periodTicks: Field<number>;
  expiryTick: Field<number>;
  timerId: Field<number>;
  callbackAddress: Field<number>;
  timerNumber: Field<number>;
  health: ObjectHealth;
  healthReason?: string;
}

export interface TimersDiscoverySummary {
  enabled: boolean;
  unavailableReason?: string;
  tickCount?: Field<number>;
  activeCurrentCount: number;
  activeOverflowCount: number;
  globalStoppedCount: number;
  coverageNote: string;
  timers: TimerSnapshot[];
}

export type HeapAllocatorKind = 'heap_4' | 'heap_1' | 'heap_2' | 'heap_3' | 'heap_5' | 'custom-or-disabled' | 'unknown';

export interface HeapOverview {
  allocator: HeapAllocatorKind;
  supported: boolean;
  initialized: boolean;
  unavailableReason?: string;
  note: string;
  configuredBytes: Field<number>;
  usableBytes: Field<number>;
  usedBytes: Field<number>;
  freeBytes: Field<number>;
  minimumEverFreeBytes: Field<number>;
  successfulAllocations: Field<number>;
  successfulFrees: Field<number>;
}

export interface SnapshotDiagnostics {
  bytes: number; batches: number; rounds: number; nodes: number; coveredLists: string[];
  queueWaitMs: number; ioMs: number; parseMs: number; totalMs: number;
  detailBudget?: DetailRefreshBudget;
}
export interface RtosSnapshot extends SnapshotIdentity {
  version: 1;
  snapshotSequence: number;
  startedAt: number; completedAt: number;
  targetState: 'Running' | 'Halted' | 'Unknown';
  consistency: Consistency;
  reason?: string;
  kernel: { name: 'FreeRTOS'; version: Field<string>; source: string };
  tasks: TaskSnapshot[];
  runtimeTotal: Field<string>;
  runtimeTotalBits: Field<number>;
  objects?: ObjectsDiscoverySummary;
  timers?: TimersDiscoverySummary;
  heap?: HeapOverview;
  issues: RtosIssue[];
  diagnostics: SnapshotDiagnostics;
}
