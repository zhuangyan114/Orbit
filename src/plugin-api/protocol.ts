// Orbit Automation API v1 — protocol types, public contexts and error mapping.
//
// Every shape in this file is frozen in docs/api/orbit-automation-openrpc.json
// (plan §1.8). Do not add, rename or change fields here without a new major
// API version. The legacy { ok, error } RPC envelope lives in ./types.ts and
// is only kept for the future compatibility layer; nothing on the v1 path
// may return it.

export const AUTOMATION_SCOPES = [
  'read',
  'session.control',
  'breakpoints.write',
  'view.write',
  'record',
  'rtt.control',
  'variables.write',
  'memory.write',
  'flash',
] as const;

export type AutomationScope = (typeof AUTOMATION_SCOPES)[number];

/** JSON-RPC standard codes plus the frozen business error codes. */
export type AutomationErrorCode =
  | 'ParseError'
  | 'InvalidJsonRpcRequest'
  | 'MethodNotFound'
  | 'InvalidParams'
  | 'JsonRpcInternalError'
  | 'Unauthorized'
  | 'InvalidRequest'
  | 'UnsupportedApiVersion'
  | 'CapabilityUnavailable'
  | 'ProjectMismatch'
  | 'InstanceMismatch'
  | 'AmbiguousInstance'
  | 'ConnectionExpired'
  | 'NoActiveSession'
  | 'SessionAlreadyActive'
  | 'SessionStarting'
  | 'SessionChanged'
  | 'SessionTerminating'
  | 'TargetDisconnected'
  | 'TargetRunning'
  | 'TargetBusy'
  | 'TargetReadCancelled'
  | 'InvalidExpression'
  | 'ExpressionNotWritable'
  | 'InvalidAddress'
  | 'MemoryReadFailed'
  | 'MemoryWriteFailed'
  | 'BreakpointNotFound'
  | 'BreakpointUnverified'
  | 'RecordingNotFound'
  | 'RateLimited'
  | 'RequestTimeout'
  | 'InternalError';

/** JSON-RPC numeric codes for the standard and every frozen business error. */
export const AUTOMATION_ERROR_CODES: Readonly<Record<AutomationErrorCode, number>> = {
  ParseError: -32700,
  InvalidJsonRpcRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  JsonRpcInternalError: -32603,
  Unauthorized: -32001,
  InvalidRequest: -32002,
  UnsupportedApiVersion: -32003,
  CapabilityUnavailable: -32004,
  ProjectMismatch: -32005,
  InstanceMismatch: -32006,
  AmbiguousInstance: -32007,
  ConnectionExpired: -32008,
  NoActiveSession: -32009,
  SessionAlreadyActive: -32010,
  SessionStarting: -32011,
  SessionChanged: -32012,
  SessionTerminating: -32013,
  TargetDisconnected: -32014,
  TargetRunning: -32015,
  TargetBusy: -32016,
  TargetReadCancelled: -32017,
  InvalidExpression: -32018,
  ExpressionNotWritable: -32019,
  InvalidAddress: -32020,
  MemoryReadFailed: -32021,
  MemoryWriteFailed: -32022,
  BreakpointNotFound: -32023,
  BreakpointUnverified: -32024,
  RecordingNotFound: -32025,
  RateLimited: -32026,
  RequestTimeout: -32027,
  InternalError: -32028,
};

/**
 * Typed business error for the v1 automation path.
 *
 * The wire `data` mirrors the frozen OpenRPC error schemas exactly:
 * `errorCode` and `retryable` are always present, `data` carries only the
 * structured fields the contract declares at the top level (ErrorDataBase
 * plus each error's own schema, e.g. `timeoutKind`, `operationId`,
 * `expectedGeneration`, `actualGeneration`), and anything ad-hoc (e.g.
 * `issues`, `requiredScopes`) is nested under `details`, which is the
 * catch-all ErrorDataBase declares for exactly that purpose. No invented
 * top-level fields may reach the wire.
 */
export class AutomationError extends Error {
  constructor(
    public readonly errorCode: AutomationErrorCode,
    message?: string,
    public readonly retryable = false,
    public readonly data?: Record<string, unknown>,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message ?? errorCode);
    this.name = 'AutomationError';
  }

  toJsonRpcErrorObject(): { code: number; message: string; data: Record<string, unknown> } {
    const data: Record<string, unknown> = {
      errorCode: this.errorCode,
      retryable: this.retryable,
      ...this.data,
    };
    if (this.details && Object.keys(this.details).length > 0) {
      data.details = this.details;
    }
    return {
      code: AUTOMATION_ERROR_CODES[this.errorCode],
      message: this.errorCode,
      data,
    };
  }
}

// --- Fixed public contexts (plan §1.8). Identity fields must never be
// --- invented here; they are the exact fields of the OpenRPC schemas.

export interface BootstrapContext {
  instanceId: string;
  projectId: string;
}

export interface ConnectionContext extends BootstrapContext {
  connectionId: string;
}

export interface ConnectionMutationContext extends ConnectionContext {
  idempotencyKey: string;
}

export interface ProjectMutationContext extends ConnectionMutationContext {
  registryGeneration: number;
}

export interface SessionRef {
  sessionId: string;
  sessionGeneration: number;
}

export interface TargetRequestContext extends ConnectionContext, SessionRef {}

export interface TargetMutationContext extends TargetRequestContext {
  idempotencyKey: string;
}

/** Flat wire view of a request context, kept for compatibility with the plan. */
export interface AutomationRequestContext {
  connectionId: string;
  projectId: string;
  instanceId: string;
  sessionId?: string;
  sessionGeneration?: number;
  idempotencyKey?: string;
}

export type RpcIdentityContext =
  | BootstrapContext
  | ConnectionContext
  | ConnectionMutationContext
  | ProjectMutationContext
  | TargetRequestContext
  | TargetMutationContext;

/** Fixed result envelope. The outer JSON-RPC wrapper stays { result }/{ error }. */
export interface OperationResult<T> {
  requestId: string;
  instanceId: string;
  projectId: string;
  sessionId?: string;
  sessionGeneration?: number;
  targetState?: string;
  data: T;
  diagnostics?: Record<string, unknown>;
}

export type OperationStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'outcomeUnknown';

/** Live handshake lease. Task 2's HandshakeService produces these. */
export interface ConnectionLease {
  connectionId: string;
  instanceId: string;
  projectId: string;
  scopes: ReadonlySet<AutomationScope>;
  expiresAt: number;
}

// --- Frozen public DTOs (OpenRPC #/components/schemas, plan §1.8). ---
// These are the exact wire shapes of the discovery/handshake methods. Do not
// add, rename or change fields without a new major API version.

/** OpenRPC WorkspaceFolder: display path plus file URI. */
export interface WorkspaceFolderInfo {
  name: string;
  uri: string;
  path: string;
}

/** OpenRPC EndpointInfo + EndpointDescriptor. Never carries the bearer token on the wire. */
export interface EndpointDescriptor {
  schemaVersion: 1;
  host: '127.0.0.1';
  port: number;
  rpcUrl: string;
  eventsUrl: string;
  healthUrl: string;
  apiVersions: string[];
}

/** OpenRPC InstanceDescription (data of orbit.instance.describe). */
export interface InstanceDescription {
  instanceId: string;
  version: string;
  channel: 'stable' | 'insiders' | 'portable' | 'remote';
  processId: number;
  /** UInt64 epoch-ms string on the wire. */
  startedAt: string;
  workspaceFolders: WorkspaceFolderInfo[];
  endpoint: EndpointDescriptor;
}

/** OpenRPC OwnerKind. */
export type OwnerKind = 'jlink-native' | 'jlink-legacy' | 'cmsis-dap';

/** OpenRPC Capability. */
export interface Capability {
  name: string;
  available: boolean;
  reason?: string;
  ownerKinds?: OwnerKind[];
}

/** OpenRPC CapabilitySnapshot. owner/sessionPhase appear once Task 3 exists. */
export interface CapabilitySnapshot {
  apiVersion: '1.0';
  capabilities: Capability[];
  owner?: OwnerKind;
  sessionPhase?: string;
}

/** OpenRPC LaunchConfiguration (items of project.listLaunchConfigurations). */
export interface LaunchConfiguration {
  name: string;
  type: 'orbit' | 'ozone';
  request: 'launch' | 'attach';
  workspaceFolderUri: string;
}

/**
 * Backwards-compatible name for the same frozen shape; the OpenRPC document
 * calls it LaunchConfiguration and uses it for both project.describe and
 * project.listLaunchConfigurations.
 */
export type LaunchConfigurationSummary = LaunchConfiguration;

/** OpenRPC ProjectDescription (data of orbit.project.describe). */
export interface ProjectDescription {
  projectId: string;
  workspaceFileUri?: string;
  workspaceFolders: WorkspaceFolderInfo[];
  elfFiles: string[];
  launchConfigurations: LaunchConfigurationSummary[];
  registryGeneration: number;
}

// --- Session DTOs (OpenRPC, plan Task 3). Frozen shapes; Task 4+ register the
// --- methods that return them, the SessionRegistry owns the runtime values.

/** OpenRPC SessionPhase. */
export type SessionPhase =
  | 'starting'
  | 'connected'
  | 'running'
  | 'halted'
  | 'terminating'
  | 'terminated'
  | 'error';

/** OpenRPC TargetStateKind. */
export type TargetStateKind = 'unknown' | 'disconnected' | 'running' | 'halted' | 'resetting';

/** OpenRPC ProbeKind (launch configuration probe selection). */
export type ProbeKind = 'jlink' | 'cmsis-dap';

/** OpenRPC TransportKind (owner transport / CMSIS-DAP interface). */
export type TransportKind = 'native' | 'legacy' | 'hid' | 'winusb';

/** OpenRPC SourceLocation (`#/components/schemas/SourceLocation`). */
export interface SourceLocation {
  /** Absolute filesystem path (not a `file://` URI). */
  path: string;
  /** 1-based line number. */
  line: number;
  /** 1-based column; omitted means the first character (column 1). */
  column?: number;
  endLine?: number;
  endColumn?: number;
}

/**
 * OpenRPC SourceLocation as used inside SessionSnapshot (`location`). The
 * frozen schema is the same `SourceLocation`; this alias keeps the older
 * session-facing name without a second, driftable shape.
 */
export type SessionLocation = SourceLocation;

/** OpenRPC SessionSnapshot. */
export interface SessionSnapshot {
  sessionId: string;
  sessionGeneration: number;
  registryGeneration: number;
  name: string;
  type: 'orbit' | 'ozone';
  phase: SessionPhase;
  targetState: TargetStateKind;
  owner?: OwnerKind;
  probe?: ProbeKind;
  transport?: TransportKind;
  stopReason?: string;
  /** OpenRPC Address: 0x-prefixed hex string. */
  pc?: string;
  threadId?: number;
  location?: SessionLocation;
  capabilities: Capability[];
}

/** OpenRPC SessionListData (data of orbit.session.list). */
export interface SessionListData {
  items: SessionSnapshot[];
  nextCursor?: string | null;
}

/** OpenRPC OperationAck (data of session.start / session.stop). */
export interface OperationAck {
  operationId: string;
  accepted: boolean;
  session?: SessionSnapshot;
}

/** OpenRPC FlashSegment (inside FlashReport.segments). */
export interface FlashSegment {
  /** Frozen Address: 0x-prefixed hex. */
  startAddress: string;
  endAddress: string;
  bytes: number;
}

/** OpenRPC FlashReport (data of orbit.target.flash). */
export interface FlashReport {
  operationId: string;
  elfPath: string;
  owner: OwnerKind;
  bytesProgrammed: number;
  verified: boolean;
  segments: FlashSegment[];
  elapsedMs: number;
}

/** OpenRPC ControlOutcome (data of every orbit.target.* control method). */
export interface ControlOutcome {
  operationId: string;
  state: string;
  pc?: string;
  stopReason?: string;
  session: SessionSnapshot;
}

/** OpenRPC BreakpointInput (breakpoint being added/updated/replaced). */
export interface BreakpointInput {
  source: SourceLocation;
  enabled: boolean;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
}

/**
 * OpenRPC Breakpoint: the merged requested + DAP-verified view (plan Task 6).
 * `verified` and `sessionId`/`sessionGeneration` come from the exact active
 * Orbit session's DAP snapshot; without one, `verified` is `false` and the
 * session fields are absent. `slot` is the selected owner's hardware slot.
 */
export interface AutomationBreakpoint {
  breakpointId: string;
  source: SourceLocation;
  enabled: boolean;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
  verified: boolean;
  message?: string;
  /** OpenRPC Address: 0x-prefixed hex string, when the owner reports one. */
  address?: string;
  slot?: number;
  sessionId?: string;
  sessionGeneration?: number;
}

/** OpenRPC BreakpointListData (data of orbit.breakpoints.list). */
export interface BreakpointListData {
  items: AutomationBreakpoint[];
  nextCursor?: string | null;
}

/** OpenRPC BreakpointMutationData (data of add/update/remove/replace). */
export interface BreakpointMutationData {
  operationId: string;
  items: AutomationBreakpoint[];
  nextCursor?: string | null;
}

// --- Runtime DTOs (OpenRPC, plan Task 7). Frozen shapes returned by the
// --- orbit.runtime.* methods. `variablesReference` is a UInt64 string on the
// --- wire (the adapter-internal integer is stringified by RuntimeService).

/** OpenRPC Thread (items of orbit.runtime.threads). */
export interface RuntimeThread {
  threadId: number;
  name: string;
  state: string;
  stopped: boolean;
}

/** OpenRPC StackFrame (items of orbit.runtime.stackTrace). */
export interface RuntimeStackFrame {
  frameId: number;
  name: string;
  source?: SourceLocation;
  instructionPointerReference: string;
}

/** OpenRPC Scope (items of orbit.runtime.scopes). */
export interface RuntimeScope {
  name: string;
  /** UInt64 string of the adapter-internal variablesReference. */
  variablesReference: string;
  expensive: boolean;
}

/** OpenRPC Variable (items of orbit.runtime.variables). */
export interface RuntimeVariable {
  name: string;
  value: string;
  type?: string;
  /** UInt64 string of the adapter-internal variablesReference (0 for a leaf). */
  variablesReference: string;
  evaluateName?: string;
  memoryReference?: string;
}

/** OpenRPC Register (items of orbit.runtime.registers). */
export interface RuntimeRegister {
  name: string;
  /** UInt64 exact value (0x-prefixed hex for this adapter). */
  value: string;
  group: 'core' | 'floating' | 'system';
  bits: number;
  memoryReference?: string;
}

/** Generic runtime list data envelope (data of every orbit.runtime.* method). */
export interface RuntimeListData<T> {
  items: T[];
  nextCursor?: string | null;
}

// --- Expression & symbol DTOs (OpenRPC, plan Task 8). Frozen shapes returned
// --- by orbit.expression.* and orbit.symbol.*. `variablesReference` is a
// --- UInt64 string (the adapter-internal integer is stringified by the
// --- service), addresses are 0x-prefixed hex strings, and per-item errors
// --- carry the frozen ErrorDataBase subset (errorCode + retryable).

/** OpenRPC ExpressionContextKind (orbit.expression.evaluate contextKind). */
export type ExpressionContextKind = 'watch' | 'hover' | 'repl' | 'clipboard' | 'variables';

/** OpenRPC error payload carried inside ExpressionValue / ExpressionWriteOutcome. */
export interface ExpressionErrorData {
  errorCode: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

/** OpenRPC ExpressionValue (data of evaluate / items of readMany / root of inspect). */
export interface ExpressionValue {
  expression: string;
  value: string;
  type?: string;
  /** UInt64 string of the adapter-internal variablesReference (0 for a leaf). */
  variablesReference: string;
  /** OpenRPC Address: 0x-prefixed hex string, when the owner reports one. */
  memoryReference?: string;
  available: boolean;
  stale: boolean;
  error?: ExpressionErrorData;
}

/** OpenRPC ExpressionWrite (one item of expression.writeMany writes). */
export interface ExpressionWrite {
  expression: string;
  /** Frozen `Expression` string: a numeric literal for this adapter's backend. */
  value: string;
}

/** OpenRPC ExpressionWriteOutcome (one item of expression.writeMany result). */
export interface ExpressionWriteOutcome {
  expression: string;
  written: boolean;
  value?: string;
  error?: ExpressionErrorData;
}

/** OpenRPC SymbolKind. */
export type SymbolKind = 'function' | 'variable' | 'type' | 'section' | 'unknown';

/** OpenRPC Symbol (items of orbit.symbol.search / data of orbit.symbol.resolve). */
export interface SymbolDescriptor {
  name: string;
  kind: SymbolKind;
  /** OpenRPC Address: 0x-prefixed hex string. */
  address: string;
  /** UInt64 string, when the ELF symbol table reports a size. */
  size?: string;
  file?: string;
  line?: number;
}

/** OpenRPC ExpressionReadManyResult data. */
export interface ExpressionReadManyData {
  items: ExpressionValue[];
  nextCursor?: string | null;
}

/** OpenRPC ExpressionWriteManyResult data. */
export interface ExpressionWriteManyData {
  operationId: string;
  items: ExpressionWriteOutcome[];
  nextCursor?: string | null;
}

/** OpenRPC ExpressionInspectResult data. */
export interface ExpressionInspectData {
  root: ExpressionValue;
  items: RuntimeVariable[];
  nextCursor?: string | null;
}

/** OpenRPC SymbolSearchResult data. */
export interface SymbolSearchData {
  items: SymbolDescriptor[];
  nextCursor?: string | null;
}

/** OpenRPC SymbolResolveResult data. */
export interface SymbolResolveData {
  symbol: SymbolDescriptor;
  exact: boolean;
}

// --- Memory DTOs (OpenRPC, plan Task 9). Frozen shapes returned by
// --- orbit.memory.read and orbit.memory.write. Addresses are 0x-prefixed hex
// --- strings; memory payloads are Base64 (never JSON numbers/uint32 arrays).

/** OpenRPC MemoryBlock (data of orbit.memory.read). */
export interface MemoryBlockData {
  /** OpenRPC Address: 0x-prefixed hex string. */
  address: string;
  requestedBytes: number;
  bytesRead: number;
  unreadableBytes: number;
  /** Base64-encoded bytes (`contentEncoding: base64`, `x-orbit-bytes`). */
  data: string;
}

/** OpenRPC MemoryWriteReport (data of orbit.memory.write). */
export interface MemoryWriteReport {
  operationId: string;
  /** OpenRPC Address: 0x-prefixed hex string. */
  address: string;
  bytesWritten: number;
  /** `true` only when verify was requested and the read-back matched. */
  verified: boolean;
  /** Base64-encoded bytes read back for verification, when verify ran. */
  verifyData?: string;
}

// --- View-state, sampling and experiment DTOs (OpenRPC, plan Task 10). Frozen
// --- shapes returned by the orbit.watch.* / orbit.timeline.* / orbit.record.*
// --- and orbit.experiment.run methods. Timestamps and frame ids are UInt64
// --- decimal strings (never JSON numbers).

/** OpenRPC ErrorDataBase — the shared error payload embedded in results. */
export interface ErrorDataBase {
  errorCode: string;
  retryable: boolean;
  requestId?: string;
  operationId?: string;
  expectedGeneration?: number;
  actualGeneration?: number;
  details?: Record<string, unknown>;
}

/** OpenRPC WatchSnapshot (data of every orbit.watch.* method). */
export interface WatchSnapshot {
  expressions: string[];
  values: ExpressionValue[];
  uiSynchronized: boolean;
  revision: number;
  items: ExpressionValue[];
  nextCursor?: string | null;
}

/** OpenRPC TimelineSnapshot (data of every orbit.timeline.* method). */
export interface TimelineSnapshot {
  expressions: string[];
  sampling: boolean;
  intervalMs: number;
  generation: number;
  framesRetained: number;
  droppedFrames: number;
  revision: number;
  items: string[];
  nextCursor?: string | null;
}

/** OpenRPC RecordingChannel (items of RecordStartParams.channels). */
export interface RecordingChannel {
  channelId: string;
  expression: string;
  unit?: string;
  valueType: string;
}

/** OpenRPC RecordingFrameValue (items of RecordingFrame.values). */
export interface RecordingFrameValue {
  channelId: string;
  value: number | string | boolean | null;
  available: boolean;
}

/** OpenRPC RecordingFrame (items of RecordingFramesPage.items). */
export interface RecordingFrame {
  frameId: string;
  timestamp: string;
  timestampNs?: string;
  sessionGeneration: number;
  values: RecordingFrameValue[];
}

/** OpenRPC RecordingStatus. */
export type RecordingStatus = 'starting' | 'recording' | 'stopped' | 'failed';

/** OpenRPC Recording (data of record.start/stop, items of list). */
export interface Recording {
  recordingId: string;
  name: string;
  status: RecordingStatus;
  startedAt: string;
  stoppedAt?: string;
  intervalMs: number;
  channels: RecordingChannel[];
  frameCount: number;
  bytesRetained: number;
  failure?: ErrorDataBase;
}

/** OpenRPC RecordingListData (data of orbit.record.list). */
export interface RecordingListData {
  items: Recording[];
  nextCursor?: string | null;
}

/** OpenRPC RecordingFramesPage (data of orbit.record.get). */
export interface RecordingFramesPage {
  recording: Recording;
  items: RecordingFrame[];
  nextCursor?: string | null;
}

/** OpenRPC RecordClearData (data of orbit.record.clear). */
export interface RecordClearData {
  operationId: string;
  recordingId: string;
  clearedFrames: number;
}

/** OpenRPC ExperimentStep (items of ExperimentRunParams.steps). */
export type ExperimentStep =
  | { kind: 'read'; expression: string; as?: string }
  | { kind: 'write'; expression: string; value: string }
  | { kind: 'memoryRead'; address: string; count: number }
  | { kind: 'memoryWrite'; address: string; data: string }
  | { kind: 'wait'; durationMs: number }
  | { kind: 'record'; expressions: string[]; durationMs: number; intervalMs: number };

/** OpenRPC ExperimentStepOutcome (items of ExperimentReport.steps). */
export interface ExperimentStepOutcome {
  index: number;
  kind: string;
  status: 'succeeded' | 'failed' | 'cancelled' | 'skipped';
  startedAt: string;
  completedAt?: string;
  value?: string | number | boolean | null;
  error?: ErrorDataBase;
}

/** OpenRPC ExperimentReport (data of orbit.experiment.run). */
export interface ExperimentReport {
  operationId: string;
  status: 'succeeded' | 'failed' | 'cancelled' | 'outcomeUnknown';
  steps: ExperimentStepOutcome[];
  recordingIds: string[];
  elapsedMs: number;
}

// --- RTT and diagnostics DTOs (OpenRPC, plan Task 11). Frozen shapes returned
// --- by orbit.rtt.* and orbit.diagnostics.snapshot. Byte payloads are Base64;
// --- addresses and exact integers are strings; diagnostics never carry tokens,
// --- Authorization headers, raw memory data or user variable values.

/** OpenRPC RttState (RttSnapshot.state). */
export type RttState =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'unavailable'
  | 'error';

/** OpenRPC RttSnapshot (data of orbit.rtt.status / start / stop / read). */
export interface RttSnapshot {
  state: RttState;
  owner?: OwnerKind;
  bufferIndex: number;
  pollIntervalMs: number;
  targetName?: string;
  ansi: boolean;
  bytesAvailable: number;
  droppedBytes: number;
}

/** OpenRPC RttReadData (data of orbit.rtt.read). */
export interface RttReadData {
  snapshot: RttSnapshot;
  /** Base64-encoded bytes (`contentEncoding: base64`, `x-orbit-bytes`). */
  data: string;
  bytesRead: number;
  nextCursor?: string | null;
}

/** OpenRPC DiagnosticsApi (DiagnosticsSnapshot.api). */
export interface DiagnosticsApi {
  version: string;
  connections: number;
  sseConnections: number;
  registryGeneration: number;
}

/** OpenRPC DiagnosticsDap (DiagnosticsSnapshot.dap). */
export interface DiagnosticsDap {
  sessionId?: string;
  sessionGeneration?: number;
  phase: string;
  pendingRequests: number;
}

/** OpenRPC DiagnosticsOwner (DiagnosticsSnapshot.owner). */
export interface DiagnosticsOwner {
  kind?: OwnerKind;
  transport?: string;
  connected: boolean;
  helperPid?: number;
}

/** OpenRPC DiagnosticsScheduler (DiagnosticsSnapshot.scheduler). */
export interface DiagnosticsScheduler {
  control: number;
  watch: number;
  timeline: number;
  background: number;
}

/** OpenRPC DiagnosticsSampling (DiagnosticsSnapshot.sampling). */
export interface DiagnosticsSampling {
  activeRecordings: number;
  retainedFrames: number;
  retainedBytes: number;
  droppedFrames: number;
}

/** OpenRPC DiagnosticsSnapshot (data of orbit.diagnostics.snapshot). */
export interface DiagnosticsSnapshot {
  api: DiagnosticsApi;
  dap: DiagnosticsDap;
  owner: DiagnosticsOwner;
  scheduler: DiagnosticsScheduler;
  sampling: DiagnosticsSampling;
  /** Frozen const false: the snapshot must never contain the bearer token. */
  tokenIncluded: false;
}

/** OpenRPC HandshakeData (data of orbit.handshake). `session` is added by Task 3. */
export interface HandshakeData {
  connectionId: string;
  /** UInt64 epoch-ms string on the wire. */
  expiresAt: string;
  grantedScopes: AutomationScope[];
  instance: InstanceDescription;
  project: ProjectDescription;
  capabilities: CapabilitySnapshot;
  session?: unknown;
}

// --- JSON-RPC 2.0 wire envelope for the /v1/rpc transport.

export interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: string | number | null;
  result: unknown;
}

export interface JsonRpcError {
  jsonrpc: '2.0';
  id: string | number | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;
