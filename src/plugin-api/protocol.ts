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

/** OpenRPC LaunchConfiguration summary (data of project.describe / listLaunchConfigurations). */
export interface LaunchConfigurationSummary {
  name: string;
  type: 'orbit' | 'ozone';
  request: 'launch' | 'attach';
  workspaceFolderUri: string;
}

/** OpenRPC ProjectDescription (data of orbit.project.describe). */
export interface ProjectDescription {
  projectId: string;
  workspaceFileUri?: string;
  workspaceFolders: WorkspaceFolderInfo[];
  elfFiles: string[];
  launchConfigurations: LaunchConfigurationSummary[];
  registryGeneration: number;
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
