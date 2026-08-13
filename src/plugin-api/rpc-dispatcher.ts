// Orbit Automation API v1 — RPC method registry, dispatch fences, scope and
// generation checks, idempotency reservation and bounded outcome storage.
//
// Dispatch order is frozen by plan §2.4 and must not be reordered:
//   authentication/connection -> project/instance fence ->
//   session generation fence (targetBound) -> scope ->
//   idempotency lookup/reservation -> handler.
import { randomUUID } from 'crypto';
import { z } from 'zod';
import {
  AutomationError,
  AutomationScope,
  ConnectionLease,
  JsonRpcError,
  JsonRpcResponse,
  JsonRpcSuccess,
  OperationStatus,
  RpcIdentityContext,
} from './protocol';
import { getMethodCatalogEntry, jsonRpcRequestSchema, zodErrorIssues } from './schemas';

export interface RpcMethodDefinition<P, R> {
  name: `orbit.${string}`;
  bootstrap: boolean;
  requiredScopes: AutomationScope[];
  mutation: boolean;
  requiresIdempotency: boolean;
  targetBound: boolean;
  timeoutMs: number;
  paramsSchema: z.ZodType<P>;
  handler(params: P, call: RpcCallContext): Promise<R>;
}

export interface RpcCallContext {
  requestId: string;
  connection?: ConnectionLease;
  identity?: RpcIdentityContext;
  signal: AbortSignal;
  operationId?: string;
}

export interface RpcDispatcherOptions {
  instanceId: string;
  projectId: string;
  verifyAuthorization(authorization: string | undefined): boolean;
  getConnection(connectionId: string): ConnectionLease | undefined;
  getSessionGeneration(sessionId: string): number | undefined;
  now?: () => number;
}

/** Per-connection idempotency retention: 1,024 outcomes, five minutes (plan §2.4). */
const MAX_CACHED_OUTCOMES = 1024;
const IDEMPOTENT_RESULT_TTL_MS = 5 * 60 * 1000;

interface OperationEntry {
  operationId: string;
  connectionId: string;
  method: string;
  status: OperationStatus;
  dispatchedAt: number;
  completedAt?: number;
  result?: unknown;
  error?: JsonRpcError['error'];
  /** Settles when the handler finishes, even after an outcomeUnknown timeout. */
  promise: Promise<void>;
  paramsFingerprint: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return value === undefined ? 'null' : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

function arrayEqual(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function toRpcErrorObject(error: unknown): JsonRpcError['error'] {
  if (error instanceof AutomationError) return error.toJsonRpcErrorObject();
  return new AutomationError('InternalError', undefined, false).toJsonRpcErrorObject();
}

function errorResponse(id: string | number | null, error: unknown): JsonRpcError {
  return { jsonrpc: '2.0', id, error: toRpcErrorObject(error) };
}

function successResponse(id: string | number, result: unknown): JsonRpcSuccess {
  return { jsonrpc: '2.0', id, result };
}

/** Stamps the fixed result envelope; identity fields always win over handler output. */
function stampResult(
  raw: unknown,
  requestId: string,
  options: RpcDispatcherOptions,
  identity: Record<string, unknown>,
): Record<string, unknown> {
  const rest = isPlainObject(raw) ? raw : { data: raw };
  const stamped: Record<string, unknown> = {
    requestId,
    instanceId: options.instanceId,
    projectId: options.projectId,
  };
  if (typeof identity.sessionId === 'string' && identity.sessionId.length > 0) {
    stamped.sessionId = identity.sessionId;
    stamped.sessionGeneration = identity.sessionGeneration;
  }
  return { ...rest, ...stamped };
}

/**
 * Builds a registration-ready method definition straight from the frozen
 * OpenRPC catalog so no service can invent drift. Handlers are attached by
 * later tasks; `P`/`R` are inferred from the handler signature.
 */
export function buildMethodDefinition<P, R>(
  name: `orbit.${string}`,
  handler: RpcMethodDefinition<P, R>['handler'],
): RpcMethodDefinition<P, R> {
  const catalog = getMethodCatalogEntry(name);
  if (!catalog) {
    throw new Error(`Unknown automation method ${name}: every registered method must exist in the frozen OpenRPC catalog`);
  }
  return {
    name,
    bootstrap: catalog.bootstrap,
    requiredScopes: [...catalog.requiredScopes],
    mutation: catalog.mutation,
    requiresIdempotency: catalog.requiresIdempotency,
    targetBound: catalog.targetBound,
    timeoutMs: catalog.timeoutMs,
    paramsSchema: catalog.paramsSchema as z.ZodType<P>,
    handler,
  };
}

interface OperationGetParams {
  context: { connectionId: string };
  operationId: string;
}

export class RpcDispatcher {
  private readonly methods = new Map<string, RpcMethodDefinition<unknown, unknown>>();
  private readonly idempotency = new Map<string, OperationEntry>();
  private readonly operations = new Map<string, OperationEntry>();
  private readonly controllers = new Set<AbortController>();
  private disposed = false;

  constructor(private readonly options: RpcDispatcherOptions) {
    // orbit.operation.get is implemented by the dispatcher itself because it
    // queries the operation store that the dispatcher owns (plan Task 1).
    this.register(
      buildMethodDefinition<OperationGetParams, unknown>('orbit.operation.get', async (params, call) => {
        const operation = this.operations.get(params.operationId);
        if (!operation || operation.connectionId !== params.context.connectionId) {
          throw new AutomationError('InvalidRequest', `unknown operation ${params.operationId}`, false);
        }
        const data: Record<string, unknown> = {
          operationId: operation.operationId,
          status: operation.status,
          dispatchedAt: String(operation.dispatchedAt),
        };
        if (operation.completedAt !== undefined) data.completedAt = String(operation.completedAt);
        if (operation.result !== undefined) data.result = operation.result;
        if (operation.error) data.error = operation.error.data;
        return { data };
      }),
    );
  }

  register<P, R>(definition: RpcMethodDefinition<P, R>): void {
    if (this.disposed) throw new Error('RpcDispatcher is disposed');
    const catalog = getMethodCatalogEntry(definition.name);
    if (!catalog) {
      throw new Error(`Unknown automation method ${definition.name}: every registered method must exist in the frozen OpenRPC catalog`);
    }
    if (this.methods.has(definition.name)) {
      throw new Error(`Automation method ${definition.name} is already registered`);
    }
    if (definition.bootstrap !== catalog.bootstrap) {
      throw new Error(`${definition.name}: bootstrap must match the frozen catalog`);
    }
    if (!arrayEqual(definition.requiredScopes, catalog.requiredScopes)) {
      throw new Error(`${definition.name}: requiredScopes must match the frozen catalog`);
    }
    if (definition.mutation !== catalog.mutation) {
      throw new Error(`${definition.name}: mutation must match the frozen catalog`);
    }
    if (definition.requiresIdempotency !== catalog.requiresIdempotency) {
      throw new Error(`${definition.name}: requiresIdempotency must match the frozen catalog`);
    }
    if (definition.targetBound !== catalog.targetBound) {
      throw new Error(`${definition.name}: targetBound must match the frozen catalog`);
    }
    if (definition.timeoutMs !== catalog.timeoutMs) {
      throw new Error(`${definition.name}: timeoutMs must match the frozen catalog`);
    }
    if (definition.paramsSchema !== catalog.paramsSchema) {
      throw new Error(`${definition.name}: paramsSchema must be the frozen catalog schema`);
    }
    this.methods.set(definition.name, definition as RpcMethodDefinition<unknown, unknown>);
  }

  async dispatch(request: unknown, authorization: string | undefined): Promise<JsonRpcResponse> {
    const envelope = jsonRpcRequestSchema.safeParse(request);
    if (!envelope.success) {
      return errorResponse(null, new AutomationError('InvalidJsonRpcRequest', 'invalid JSON-RPC 2.0 request', false));
    }
    const id = envelope.data.id;
    try {
      if (this.disposed) throw new AutomationError('InternalError', 'RpcDispatcher is disposed', false);
      if (!this.options.verifyAuthorization(authorization)) {
        throw new AutomationError('Unauthorized', 'missing or invalid bearer token', false);
      }
      const definition = this.methods.get(envelope.data.method);
      if (!definition) {
        throw new AutomationError('MethodNotFound', `unknown method ${envelope.data.method}`, false);
      }
      const parsed = definition.paramsSchema.safeParse(envelope.data.params ?? {});
      if (!parsed.success) {
        throw new AutomationError('InvalidParams', `invalid params for ${definition.name}`, false, {
          issues: zodErrorIssues(parsed.error),
        });
      }
      const params = parsed.data as Record<string, unknown>;
      const context = params.context;
      if (!isPlainObject(context)) {
        throw new AutomationError('InvalidParams', `missing context for ${definition.name}`, false);
      }

      // --- identity fences (plan §2.4, order frozen) ---
      const lease = this.resolveConnection(definition, context);
      const identity = context as unknown as RpcIdentityContext;

      // --- idempotency lookup/reservation ---
      let entry: OperationEntry | undefined;
      if (definition.requiresIdempotency) {
        const key = context.idempotencyKey;
        if (typeof key !== 'string') {
          throw new AutomationError('InvalidParams', `missing idempotencyKey for ${definition.name}`, false);
        }
        const storeKey = `${context.connectionId}\u0000${key}`;
        const fingerprint = this.computeFingerprint(params, context);
        const existing = this.idempotency.get(storeKey);
        if (existing) {
          if (this.isExpired(existing)) {
            this.idempotency.delete(storeKey);
          } else {
            if (existing.paramsFingerprint !== fingerprint) {
              throw new AutomationError(
                'InvalidRequest',
                `idempotency key ${key} was already used with different params or identity`,
                false,
              );
            }
            return this.replayOrWait(existing, id, definition.timeoutMs);
          }
        }
        entry = this.createEntry(definition, context, fingerprint);
        this.insertBounded(this.idempotency, storeKey, entry);
        this.insertBounded(this.operations, entry.operationId, entry);
      } else if (definition.mutation && !definition.bootstrap) {
        entry = this.createEntry(definition, context, '');
        this.insertBounded(this.operations, entry.operationId, entry);
      }

      // --- handler execution with timeout ---
      return this.runHandler(definition, params, identity, lease, entry, id);
    } catch (error) {
      return errorResponse(id, error);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    this.methods.clear();
    this.idempotency.clear();
    this.operations.clear();
  }

  /** Bootstrap identity fence or connection + instance/project + generation fence. */
  private resolveConnection(
    definition: RpcMethodDefinition<unknown, unknown>,
    context: Record<string, unknown>,
  ): ConnectionLease | undefined {
    if (definition.bootstrap) {
      if (context.instanceId !== this.options.instanceId) {
        throw new AutomationError('InstanceMismatch', 'request instanceId does not match this instance', false);
      }
      if (context.projectId !== this.options.projectId) {
        throw new AutomationError('ProjectMismatch', 'request projectId does not match this project', false);
      }
      return undefined;
    }
    const connectionId = typeof context.connectionId === 'string' ? context.connectionId : '';
    const lease = this.options.getConnection(connectionId);
    if (!lease) throw new AutomationError('ConnectionExpired', `unknown or closed connection ${connectionId}`, false);
    if (lease.expiresAt <= this.now()) {
      throw new AutomationError('ConnectionExpired', `connection ${connectionId} lease expired`, false);
    }
    if (lease.instanceId !== context.instanceId) {
      throw new AutomationError('InstanceMismatch', 'connection instanceId does not match this instance', false);
    }
    if (lease.projectId !== context.projectId) {
      throw new AutomationError('ProjectMismatch', 'connection projectId does not match this project', false);
    }
    if (definition.targetBound) {
      const sessionId = typeof context.sessionId === 'string' ? context.sessionId : '';
      const sessionGeneration = typeof context.sessionGeneration === 'number' ? context.sessionGeneration : undefined;
      const actualGeneration = this.options.getSessionGeneration(sessionId);
      if (actualGeneration === undefined) {
        throw new AutomationError('NoActiveSession', `no active session ${sessionId}`, false);
      }
      if (actualGeneration !== sessionGeneration) {
        throw new AutomationError('SessionChanged', `session ${sessionId} generation changed`, false, {
          expectedGeneration: sessionGeneration,
          actualGeneration,
        });
      }
    }
    for (const scope of definition.requiredScopes) {
      if (!lease.scopes.has(scope)) {
        throw new AutomationError('Unauthorized', `connection lacks required scope ${scope}`, false, {
          requiredScopes: [...definition.requiredScopes],
        });
      }
    }
    return lease;
  }

  private createEntry(
    definition: RpcMethodDefinition<unknown, unknown>,
    context: Record<string, unknown>,
    paramsFingerprint: string,
  ): OperationEntry {
    return {
      operationId: `op_${randomUUID()}`,
      connectionId: typeof context.connectionId === 'string' ? context.connectionId : '',
      method: definition.name,
      status: 'queued',
      dispatchedAt: this.now(),
      paramsFingerprint,
      promise: Promise.resolve(),
    };
  }

  private insertBounded(store: Map<string, OperationEntry>, key: string, entry: OperationEntry): void {
    store.set(key, entry);
    if (store.size <= MAX_CACHED_OUTCOMES) return;
    // Oldest completed data is evicted first; active operations are never silently cancelled.
    const completed = [...store.entries()]
      .filter(([, value]) => value.status === 'succeeded' || value.status === 'failed')
      .sort((a, b) => (a[1].completedAt ?? a[1].dispatchedAt) - (b[1].completedAt ?? b[1].dispatchedAt));
    for (const [candidate] of completed) {
      store.delete(candidate);
      if (store.size <= MAX_CACHED_OUTCOMES) break;
    }
  }

  private isExpired(entry: OperationEntry): boolean {
    if (entry.completedAt === undefined) return false;
    return this.now() - entry.completedAt > IDEMPOTENT_RESULT_TTL_MS;
  }

  private computeFingerprint(params: Record<string, unknown>, context: Record<string, unknown>): string {
    const { context: _context, ...rest } = params;
    const identity: Record<string, unknown> = {
      instanceId: context.instanceId,
      projectId: context.projectId,
    };
    if (typeof context.sessionId === 'string') {
      identity.sessionId = context.sessionId;
      identity.sessionGeneration = context.sessionGeneration;
    }
    return `${stableStringify(rest)}\u0000${stableStringify(identity)}`;
  }

  private replayOrWait(entry: OperationEntry, id: string | number, timeoutMs: number): Promise<JsonRpcResponse> {
    if (entry.status === 'succeeded') return Promise.resolve(successResponse(id, entry.result));
    if (entry.status === 'failed') return Promise.resolve({ jsonrpc: '2.0', id, error: entry.error! });
    // queued / running / outcomeUnknown: join the single in-flight operation.
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        // this request's handler never started, so a retry is safe
        resolve(errorResponse(id, new AutomationError('RequestTimeout', undefined, true, { timeoutKind: 'queueTimeout' })));
      }, timeoutMs);
      void entry.promise.then(() => {
        clearTimeout(timer);
        if (entry.status === 'succeeded') resolve(successResponse(id, entry.result));
        else if (entry.status === 'failed') resolve({ jsonrpc: '2.0', id, error: entry.error! });
        else resolve(errorResponse(id, new AutomationError('InternalError', `unexpected operation state ${entry.status}`, false)));
      });
    });
  }

  private async runHandler(
    definition: RpcMethodDefinition<unknown, unknown>,
    params: Record<string, unknown>,
    identity: RpcIdentityContext,
    lease: ConnectionLease | undefined,
    entry: OperationEntry | undefined,
    id: string | number,
  ): Promise<JsonRpcResponse> {
    const controller = new AbortController();
    this.controllers.add(controller);
    const requestId = String(id);
    const call: RpcCallContext = {
      requestId,
      connection: lease,
      identity,
      signal: controller.signal,
      operationId: entry?.operationId,
    };
    if (entry) entry.status = 'running';
    const handlerPromise = Promise.resolve().then(() => definition.handler(params, call));
    let timedOutMutation = false;
    if (entry) {
      entry.promise = handlerPromise.then(
        raw => {
          entry.status = 'succeeded';
          entry.completedAt = this.now();
          entry.result = stampResult(raw, requestId, this.options, identity as unknown as Record<string, unknown>);
        },
        error => {
          entry.status = 'failed';
          entry.completedAt = this.now();
          entry.error = toRpcErrorObject(error);
        },
      );
    } else {
      handlerPromise.catch(() => undefined);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await new Promise<'settled' | 'timeout'>(resolve => {
        timer = setTimeout(() => resolve('timeout'), definition.timeoutMs);
        void handlerPromise.then(
          () => {
            if (timer) clearTimeout(timer);
            resolve('settled');
          },
          () => {
            if (timer) clearTimeout(timer);
            resolve('settled');
          },
        );
      });
      if (outcome === 'timeout') {
        if (definition.mutation) {
          // The mutation was dispatched and cannot be proven complete: keep the
          // handler running, record the outcome for orbit.operation.get, and
          // never let the same key execute again (plan §2.4).
          timedOutMutation = true;
          if (entry) entry.status = 'outcomeUnknown';
          throw new AutomationError('RequestTimeout', `operation ${entry?.operationId ?? ''} outcome unknown`, false, {
            timeoutKind: 'outcomeUnknown',
            ...(entry ? { operationId: entry.operationId } : {}),
          });
        }
        // Read-only work is safe to retry and has no operation record.
        throw new AutomationError('RequestTimeout', undefined, true, { timeoutKind: 'queueTimeout' });
      }
      const rawResult = await handlerPromise;
      return successResponse(id, stampResult(rawResult, requestId, this.options, identity as unknown as Record<string, unknown>));
    } catch (error) {
      return errorResponse(id, error);
    } finally {
      if (timer) clearTimeout(timer);
      if (!timedOutMutation) {
        controller.abort();
        this.controllers.delete(controller);
      } else if (entry) {
        // release the controller once the background mutation settles
        void entry.promise.then(() => {
          controller.abort();
          this.controllers.delete(controller);
        });
      }
    }
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }
}
