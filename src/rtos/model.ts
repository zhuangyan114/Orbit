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
export interface SnapshotDiagnostics {
  bytes: number; batches: number; rounds: number; nodes: number; coveredLists: string[];
  queueWaitMs: number; ioMs: number; parseMs: number; totalMs: number;
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
  issues: RtosIssue[];
  diagnostics: SnapshotDiagnostics;
}
