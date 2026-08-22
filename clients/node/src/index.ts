import * as path from 'path';
import { lstat, readFile, readdir } from 'fs/promises';

export type AutomationScope =
  | 'read'
  | 'session.control'
  | 'breakpoints.write'
  | 'view.write'
  | 'record'
  | 'rtt.control'
  | 'variables.write'
  | 'memory.write'
  | 'flash';

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

export class OrbitClientError extends Error {}

export class InstanceNotFoundError extends OrbitClientError {}

export class AmbiguousInstanceError extends OrbitClientError {
  constructor(public readonly candidates: OrbitEndpoint[]) {
    super(`multiple Orbit instances match; specify instanceId (${candidates.map(item => item.instanceId).join(', ')})`);
  }
}

export class OrbitRpcError extends OrbitClientError {
  constructor(
    message: string,
    public readonly code: number,
    public readonly data?: RpcErrorData,
  ) {
    super(message);
  }
}

export function decodeBase64(value: string): Uint8Array {
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new OrbitClientError('invalid Base64 payload');
  }
  return Uint8Array.from(Buffer.from(value, 'base64'));
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function defaultRegistryPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (env.ORBIT_AUTOMATION_REGISTRY) return env.ORBIT_AUTOMATION_REGISTRY;
  if (platform === 'win32') {
    return path.join(env.LOCALAPPDATA || path.join(env.USERPROFILE || '', 'AppData', 'Local'), 'Orbit', 'automation', 'registries.json');
  }
  if (platform === 'darwin') {
    return path.join(env.HOME || '~', 'Library', 'Application Support', 'Orbit', 'automation', 'registries.json');
  }
  return path.join(env.XDG_RUNTIME_DIR || path.join(env.HOME || '~', '.local', 'state'), 'orbit', 'automation', 'registries.json');
}

async function readTrustedJson(filePath: string): Promise<unknown> {
  const info = await lstat(filePath);
  if (info.isSymbolicLink() || !info.isFile()) throw new OrbitClientError(`untrusted registry file: ${filePath}`);
  return JSON.parse(await readFile(filePath, 'utf8')) as unknown;
}

function validLoopbackUrl(value: unknown, port: number, pathname: string): value is string {
  if (typeof value !== 'string') return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:'
      && parsed.hostname === '127.0.0.1'
      && Number(parsed.port) === port
      && parsed.pathname === pathname
      && parsed.search === '';
  } catch {
    return false;
  }
}

function parseEndpoint(value: unknown): OrbitEndpoint | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.host !== '127.0.0.1') return undefined;
  const port = value.port;
  if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) return undefined;
  if (
    typeof value.instanceId !== 'string'
    || typeof value.projectId !== 'string'
    || !value.projectId.startsWith('sha256:')
    || typeof value.token !== 'string'
    || value.token.length === 0
    || !validLoopbackUrl(value.rpcUrl, port as number, '/v1/rpc')
    || !validLoopbackUrl(value.eventsUrl, port as number, '/v1/events')
    || !validLoopbackUrl(value.healthUrl, port as number, '/health')
    || !Array.isArray(value.apiVersions)
    || !value.apiVersions.includes('1.0')
  ) return undefined;
  return value as unknown as OrbitEndpoint;
}

async function healthMatches(endpoint: OrbitEndpoint, fetchImpl: typeof fetch, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(endpoint.healthUrl, { signal: controller.signal });
    if (!response.ok) return false;
    const health = await response.json() as unknown;
    return isRecord(health)
      && health.ok === true
      && health.instanceId === endpoint.instanceId
      && health.projectId === endpoint.projectId
      && health.apiVersion === '1.0';
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function enumerateInstances(options: DiscoveryOptions = {}): Promise<OrbitEndpoint[]> {
  const registryPath = options.registryPath ?? defaultRegistryPath(options.env, options.platform);
  let pointer: unknown;
  try {
    pointer = await readTrustedJson(registryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  if (!isRecord(pointer) || pointer.schemaVersion !== 1 || !Array.isArray(pointer.registries)) {
    throw new OrbitClientError(`untrusted registry pointer schema: ${registryPath}`);
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const candidates: OrbitEndpoint[] = [];
  for (const registry of pointer.registries) {
    if (!isRecord(registry) || typeof registry.endpointDirectory !== 'string') continue;
    try {
      const directoryInfo = await lstat(registry.endpointDirectory);
      if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) continue;
      const entries = await readdir(registry.endpointDirectory, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        try {
          const endpoint = parseEndpoint(await readTrustedJson(path.join(registry.endpointDirectory, entry.name)));
          if (endpoint && await healthMatches(endpoint, fetchImpl, options.healthTimeoutMs ?? 2000)) candidates.push(endpoint);
        } catch {
          // One untrusted or partially-written endpoint must not hide healthy instances.
        }
      }
    } catch {
      // A stale registry entry is ignored after its endpoint directory becomes unavailable.
    }
  }

  const byInstance = new Map<string, OrbitEndpoint>();
  for (const endpoint of candidates) {
    const current = byInstance.get(endpoint.instanceId);
    if (!current || endpoint.heartbeatAt > current.heartbeatAt) byInstance.set(endpoint.instanceId, endpoint);
  }
  return [...byInstance.values()].sort((a, b) =>
    a.projectId.localeCompare(b.projectId) || a.instanceId.localeCompare(b.instanceId));
}

export function selectInstance(instances: OrbitEndpoint[], options: SelectionOptions = {}): OrbitEndpoint {
  let candidates = instances;
  if (options.projectId) candidates = candidates.filter(item => item.projectId === options.projectId);
  if (options.instanceId) candidates = candidates.filter(item => item.instanceId === options.instanceId);
  if (candidates.length === 0) throw new InstanceNotFoundError('no live Orbit instance matches the requested identity');
  if (candidates.length > 1) throw new AmbiguousInstanceError(candidates);
  return candidates[0];
}

export type RpcContextKind =
  | 'bootstrap'
  | 'connection'
  | 'connectionMutation'
  | 'projectMutation'
  | 'target'
  | 'targetMutation';

export interface InvokeOptions {
  context?: RpcContextKind;
  idempotencyKey?: string;
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

export class OrbitClient {
  private readonly fetchImpl: typeof fetch;
  private readonly nextRequestId: () => string | number;
  private connectionIdValue?: string;
  private registryGenerationValue?: number;
  session?: SessionSnapshot;

  constructor(public readonly endpoint: OrbitEndpoint, options: OrbitClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    let sequence = 0;
    this.nextRequestId = options.requestId ?? (() => `req-${++sequence}`);
  }

  get connectionId(): string | undefined {
    return this.connectionIdValue;
  }

  async rpc<T = unknown>(method: string, params: Record<string, unknown>): Promise<OperationResult<T>> {
    const id = this.nextRequestId();
    const response = await this.fetchImpl(this.endpoint.rpcUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.endpoint.token}`,
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    let envelope: unknown;
    try {
      envelope = await response.json();
    } catch {
      throw new OrbitClientError(`Orbit RPC returned invalid JSON (HTTP ${response.status})`);
    }
    if (!isRecord(envelope)) throw new OrbitClientError('Orbit RPC returned an invalid response envelope');
    if ('error' in envelope && isRecord(envelope.error)) {
      throw new OrbitRpcError(
        typeof envelope.error.message === 'string' ? envelope.error.message : 'Orbit RPC failed',
        typeof envelope.error.code === 'number' ? envelope.error.code : -32603,
        isRecord(envelope.error.data) ? envelope.error.data as RpcErrorData : undefined,
      );
    }
    if (!response.ok || !isRecord(envelope.result)) {
      const detail = typeof envelope.error === 'string' && envelope.error.length > 0 ? `: ${envelope.error}` : '';
      throw new OrbitClientError(`Orbit RPC failed with HTTP ${response.status}${detail}`);
    }
    return envelope.result as unknown as OperationResult<T>;
  }

  async invoke<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    options: InvokeOptions = {},
  ): Promise<T> {
    const context = this.context(options.context ?? 'connection', options.idempotencyKey);
    const result = await this.rpc<T>(method, { context, ...params });
    this.captureSession(result.data);
    return result.data;
  }

  async handshake(options: {
    client: { name: string; version?: string; pid?: number };
    requestedScopes: AutomationScope[];
    workspaceRoot?: string;
  }): Promise<Record<string, unknown>> {
    const data = await this.invoke<Record<string, unknown>>('orbit.handshake', {
      apiVersion: '1.0',
      client: options.client,
      expected: {
        projectId: this.endpoint.projectId,
        instanceId: this.endpoint.instanceId,
        ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}),
      },
      requestedScopes: [...new Set(options.requestedScopes)],
    }, { context: 'bootstrap' });
    if (typeof data.connectionId !== 'string') throw new OrbitClientError('handshake response omitted connectionId');
    this.connectionIdValue = data.connectionId;
    if (isRecord(data.project) && Number.isInteger(data.project.registryGeneration)) {
      this.registryGenerationValue = data.project.registryGeneration as number;
    }
    this.captureSession(data.session);
    return data;
  }

  async refreshSession(sessionId?: string): Promise<SessionSnapshot> {
    let requestedId = sessionId ?? this.session?.sessionId;
    if (!requestedId) {
      const page = await this.invoke<Record<string, unknown>>('orbit.session.list', { includeTerminated: false });
      const items = Array.isArray(page.items) ? page.items.filter(isRecord) : [];
      if (items.length === 0) throw new OrbitClientError('no active Orbit debug session');
      if (items.length > 1) throw new OrbitClientError('multiple active sessions; specify sessionId');
      requestedId = String(items[0].sessionId);
    }
    const session = await this.invoke<SessionSnapshot>('orbit.session.snapshot', {
      sessionId: requestedId,
      includeCapabilities: true,
    });
    this.session = session;
    return session;
  }

  getOperation(operationId: string): Promise<Record<string, unknown>> {
    return this.invoke<Record<string, unknown>>('orbit.operation.get', { operationId });
  }

  async *pollSnapshots(requests: SnapshotRequest[], options: PollOptions = {}): AsyncGenerator<{
    method: string;
    data: unknown;
  }> {
    const iterations = options.iterations ?? Number.POSITIVE_INFINITY;
    for (let iteration = 0; iteration < iterations && !options.signal?.aborted; iteration += 1) {
      for (const request of requests) {
        const data = await this.invoke(request.method, request.params ?? {}, { context: request.context ?? 'connection' });
        yield { method: request.method, data };
      }
      if (iteration + 1 < iterations) await delay(options.intervalMs ?? 1000, options.signal);
    }
  }

  async *paginate<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    options: InvokeOptions = {},
  ): AsyncGenerator<Record<string, unknown> & { items: T[]; nextCursor?: string }> {
    let cursor = typeof params.cursor === 'string' ? params.cursor : undefined;
    const seen = new Set<string>();
    for (;;) {
      const page = await this.invoke<Record<string, unknown>>(method, {
        ...params,
        ...(cursor ? { cursor } : {}),
      }, options);
      if (!Array.isArray(page.items)) throw new OrbitClientError(`${method} response omitted items`);
      yield page as Record<string, unknown> & { items: T[]; nextCursor?: string };
      const next = typeof page.nextCursor === 'string' && page.nextCursor.length > 0 ? page.nextCursor : undefined;
      if (!next) return;
      if (seen.has(next)) throw new OrbitClientError(`${method} returned a repeated pagination cursor`);
      seen.add(next);
      cursor = next;
    }
  }

  async *events(options: EventOptions = {}): AsyncGenerator<AutomationEvent> {
    const connectionId = this.requireConnection();
    const eventTypes = new Set(options.eventTypes ?? []);
    const headers = new Headers({
      authorization: `Bearer ${this.endpoint.token}`,
      'x-orbit-connection-id': connectionId,
      accept: 'text/event-stream',
    });
    // Fetch combines repeated request headers. The server intentionally treats
    // each X-Orbit-Event-Type value literally, so use server filtering only for
    // one type and apply multi-type filtering locally.
    if (eventTypes.size === 1) headers.set('x-orbit-event-type', [...eventTypes][0]);
    if (options.lastEventId) headers.set('last-event-id', options.lastEventId);
    const response = await this.fetchImpl(this.endpoint.eventsUrl, { headers, signal: options.signal });
    if (!response.ok || !response.body) throw new OrbitClientError(`Orbit event stream failed with HTTP ${response.status}`);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let dataLines: string[] = [];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split(/\r?\n/);
        buffer = done ? '' : lines.pop() ?? '';
        for (const line of lines) {
          if (line === '') {
            if (dataLines.length > 0) {
              const parsed = JSON.parse(dataLines.join('\n')) as unknown;
              if (!isAutomationEvent(parsed)) throw new OrbitClientError('Orbit event stream returned an invalid event');
              if (eventTypes.size === 0 || eventTypes.has(parsed.type)) yield parsed;
            }
            dataLines = [];
          } else if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).trimStart());
          }
        }
        if (done) break;
      }
    } finally {
      reader.releaseLock();
    }
  }

  async close(): Promise<boolean> {
    if (!this.connectionIdValue) return false;
    try {
      const data = await this.invoke<Record<string, unknown>>('orbit.connection.close');
      return data.closed === true;
    } finally {
      this.connectionIdValue = undefined;
      this.session = undefined;
    }
  }

  private context(kind: RpcContextKind, idempotencyKey?: string): Record<string, unknown> {
    const context: Record<string, unknown> = {
      instanceId: this.endpoint.instanceId,
      projectId: this.endpoint.projectId,
    };
    if (kind === 'bootstrap') return context;
    context.connectionId = this.requireConnection();
    if (kind === 'connectionMutation' || kind === 'projectMutation' || kind === 'targetMutation') {
      context.idempotencyKey = idempotencyKey ?? randomKey();
    }
    if (kind === 'projectMutation') {
      if (!Number.isInteger(this.registryGenerationValue)) throw new OrbitClientError('project registry generation is unavailable; handshake again');
      context.registryGeneration = this.registryGenerationValue;
    }
    if (kind === 'target' || kind === 'targetMutation') {
      if (!this.session) throw new OrbitClientError('session context is unavailable; refresh the session first');
      context.sessionId = this.session.sessionId;
      context.sessionGeneration = this.session.sessionGeneration;
    }
    return context;
  }

  private requireConnection(): string {
    if (!this.connectionIdValue) throw new OrbitClientError('client is not handshaken');
    return this.connectionIdValue;
  }

  private captureSession(value: unknown): void {
    if (isSessionSnapshot(value)) this.session = value;
    if (isRecord(value) && isSessionSnapshot(value.session)) this.session = value.session;
  }
}

function isSessionSnapshot(value: unknown): value is SessionSnapshot {
  return isRecord(value)
    && typeof value.sessionId === 'string'
    && Number.isInteger(value.sessionGeneration)
    && typeof value.phase === 'string';
}

function isAutomationEvent(value: unknown): value is AutomationEvent {
  return isRecord(value)
    && typeof value.eventId === 'string'
    && typeof value.instanceId === 'string'
    && typeof value.projectId === 'string'
    && typeof value.timestamp === 'string'
    && typeof value.type === 'string';
}

function randomKey(): string {
  return `idem-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
