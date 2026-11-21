export type AutomationScope = 'read' | 'session.control' | 'breakpoints.write' | 'view.write' | 'record' | 'rtt.control' | 'variables.write' | 'memory.write' | 'flash';
export interface OrbitEndpoint {
    schemaVersion: 1;
    instanceId: string;
    projectId: string;
    channel: string;
    profile: string;
    extensionHost: string;
    workspaceFolders: string[];
    host: '127.0.0.1';
    port: number;
    rpcUrl: string;
    eventsUrl: string;
    healthUrl: string;
    token: string;
    processId: number;
    startedAt: number;
    heartbeatAt: number;
    apiVersions: string[];
}
export interface SessionSnapshot {
    sessionId: string;
    sessionGeneration: number;
    registryGeneration: number;
    phase: string;
    targetState: string;
    [key: string]: unknown;
}
export interface AutomationEvent {
    eventId: string;
    instanceId: string;
    projectId: string;
    sessionId?: string;
    sessionGeneration?: number;
    timestamp: string;
    type: string;
    data?: Record<string, unknown>;
}
export interface OperationResult<T = unknown> {
    requestId: string;
    instanceId: string;
    projectId: string;
    sessionId?: string;
    sessionGeneration?: number;
    operationId?: string;
    data: T;
}
export interface RpcErrorData {
    errorCode?: string;
    retryable?: boolean;
    [key: string]: unknown;
}
export declare class OrbitClientError extends Error {
}
export declare class InstanceNotFoundError extends OrbitClientError {
}
export declare class AmbiguousInstanceError extends OrbitClientError {
    readonly candidates: OrbitEndpoint[];
    constructor(candidates: OrbitEndpoint[]);
}
export declare class OrbitRpcError extends OrbitClientError {
    readonly code: number;
    readonly data?: RpcErrorData | undefined;
    constructor(message: string, code: number, data?: RpcErrorData | undefined);
}
export declare function decodeBase64(value: string): Uint8Array;
export interface DiscoveryOptions {
    registryPath?: string;
    healthTimeoutMs?: number;
    fetchImpl?: typeof fetch;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
}
export interface SelectionOptions {
    projectId?: string;
    instanceId?: string;
}
export declare function defaultRegistryPath(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): string;
export declare function enumerateInstances(options?: DiscoveryOptions): Promise<OrbitEndpoint[]>;
export declare function selectInstance(instances: OrbitEndpoint[], options?: SelectionOptions): OrbitEndpoint;
export type RpcContextKind = 'bootstrap' | 'connection' | 'connectionMutation' | 'projectMutation' | 'target' | 'targetMutation';
export interface InvokeOptions {
    context?: RpcContextKind;
    idempotencyKey?: string;
    signal?: AbortSignal;
}
export type TraceMode = 'continuous' | 'single-shot' | 'post-mortem';
export type TraceSource = 'all' | 'session' | 'offline';
export interface TraceWindow {
    recordId: string;
    unit: 'ns' | 'relative-ns' | 'absolute-ticks' | 'relative-ticks' | 'byte-offset';
    start: string;
    end: string;
    bootGeneration?: number;
    segmentId?: number;
}
export interface TraceRecordingHeader {
    recordId: string;
    source: Exclude<TraceSource, 'all'>;
    mode?: TraceMode;
    state: string;
    integrity?: string;
    committedRawBytes: number;
    packetCount: number;
    gapCount: number;
    errorCode?: string;
}
export interface TraceEventsPage extends TraceWindow {
    items: {
        eventKey: string;
        eventName: string;
        eventId: string;
        bootGeneration: number;
        segmentId: number;
        relTicks: string;
        summary: string;
    }[];
    offset: number;
    limit: number;
    totalMatched: number;
    totalKnownExact: boolean;
    scanTruncated: boolean;
    nextOffset: number | null;
}
export interface OrbitClientOptions {
    fetchImpl?: typeof fetch;
    requestId?: () => string | number;
}
export interface SnapshotRequest {
    method: string;
    params?: Record<string, unknown>;
    context?: RpcContextKind;
}
export interface PollOptions {
    intervalMs?: number;
    iterations?: number;
    signal?: AbortSignal;
}
export interface EventOptions {
    eventTypes?: string[];
    lastEventId?: string;
    signal?: AbortSignal;
}
export declare class OrbitClient {
    readonly endpoint: OrbitEndpoint;
    private readonly fetchImpl;
    private readonly nextRequestId;
    private connectionIdValue?;
    private registryGenerationValue?;
    session?: SessionSnapshot;
    constructor(endpoint: OrbitEndpoint, options?: OrbitClientOptions);
    get connectionId(): string | undefined;
    rpc<T = unknown>(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<OperationResult<T>>;
    invoke<T = unknown>(method: string, params?: Record<string, unknown>, options?: InvokeOptions): Promise<T>;
    handshake(options: {
        client: {
            name: string;
            version?: string;
            pid?: number;
        };
        requestedScopes: AutomationScope[];
        workspaceRoot?: string;
    }): Promise<Record<string, unknown>>;
    refreshSession(sessionId?: string): Promise<SessionSnapshot>;
    getOperation(operationId: string): Promise<Record<string, unknown>>;
    pollSnapshots(requests: SnapshotRequest[], options?: PollOptions): AsyncGenerator<{
        method: string;
        data: unknown;
    }>;
    rtosCapabilities(includeTrace?: boolean, signal?: AbortSignal): Promise<unknown>;
    rtosSnapshot(options?: {
        includeObjects?: boolean;
        includeTimers?: boolean;
        includeHeap?: boolean;
    }, signal?: AbortSignal): Promise<unknown>;
    traceRecordings(source?: TraceSource, signal?: AbortSignal): Promise<{
        items: TraceRecordingHeader[];
        nextCursor: null;
    }>;
    traceStatus(recordId: string, includeSegments?: boolean, signal?: AbortSignal): Promise<TraceRecordingHeader & {
        segments?: Record<string, unknown>[];
        segmentsTruncated?: boolean;
    }>;
    startTrace(idempotencyKey: string, mode?: TraceMode, signal?: AbortSignal): Promise<TraceRecordingHeader>;
    stopTrace(recordId: string, idempotencyKey: string, signal?: AbortSignal): Promise<TraceRecordingHeader>;
    traceEvents(window: TraceWindow & {
        offset?: number;
        limit?: number;
        category?: string;
        searchText?: string;
    }, signal?: AbortSignal): Promise<TraceEventsPage>;
    traceStatistics(window: TraceWindow & {
        maxBins?: number;
    }, signal?: AbortSignal): Promise<unknown>;
    paginate<T = unknown>(method: string, params?: Record<string, unknown>, options?: InvokeOptions): AsyncGenerator<Record<string, unknown> & {
        items: T[];
        nextCursor?: string;
    }>;
    events(options?: EventOptions): AsyncGenerator<AutomationEvent>;
    close(): Promise<boolean>;
    private context;
    private requireConnection;
    private captureSession;
}
