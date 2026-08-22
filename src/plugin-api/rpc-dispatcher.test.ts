import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  AutomationError,
  AutomationScope,
  ConnectionLease,
  JsonRpcError,
  JsonRpcResponse,
} from './protocol';
import { getMethodCatalogEntry, METHOD_CATALOG } from './schemas';
import { buildMethodDefinition, RpcCallContext, RpcDispatcher, RpcDispatcherOptions } from './rpc-dispatcher';

const TOKEN = 'test-token';
const AUTH = `Bearer ${TOKEN}`;
const INSTANCE = 'instance-1';
const PROJECT = 'sha256:project-1';

const BOOTSTRAP_CONTEXT = { instanceId: INSTANCE, projectId: PROJECT };
const CONNECTION_CONTEXT = { ...BOOTSTRAP_CONTEXT, connectionId: 'conn-1' };
const TARGET_REQUEST_CONTEXT = { ...CONNECTION_CONTEXT, sessionId: 'session-1', sessionGeneration: 3 };
const TARGET_MUTATION_CONTEXT = { ...TARGET_REQUEST_CONTEXT, idempotencyKey: 'key-1' };

function rpc(id: string | number, method: string, params?: unknown): unknown {
  return { jsonrpc: '2.0', id, method, params };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface Harness {
  dispatcher: RpcDispatcher;
  leases: Map<string, ConnectionLease>;
  generations: Map<string, number>;
}

function makeHarness(overrides: Partial<RpcDispatcherOptions> = {}): Harness {
  const leases = new Map<string, ConnectionLease>();
  const generations = new Map<string, number>();
  const dispatcher = new RpcDispatcher({
    instanceId: INSTANCE,
    projectId: PROJECT,
    verifyAuthorization: authorization => authorization === AUTH,
    getConnection: connectionId => leases.get(connectionId),
    getSessionGeneration: sessionId => generations.get(sessionId),
    ...overrides,
  });
  return { dispatcher, leases, generations };
}

function grant(harness: Harness, scopes: AutomationScope[], expiresAt = Date.now() + 60_000): void {
  harness.leases.set('conn-1', {
    connectionId: 'conn-1',
    instanceId: INSTANCE,
    projectId: PROJECT,
    scopes: new Set(scopes),
    expiresAt,
  });
}

interface TestHandlers {
  describeInstance?: (params: unknown, call: RpcCallContext) => Promise<unknown>;
  handshake?: (params: unknown, call: RpcCallContext) => Promise<unknown>;
  sessionList?: (params: unknown, call: RpcCallContext) => Promise<unknown>;
  sessionStart?: (params: unknown, call: RpcCallContext) => Promise<unknown>;
  threads?: (params: unknown, call: RpcCallContext) => Promise<unknown>;
  continueTarget?: (params: unknown, call: RpcCallContext) => Promise<unknown>;
  removeBreakpoint?: (params: unknown, call: RpcCallContext) => Promise<unknown>;
  close?: (params: unknown, call: RpcCallContext) => Promise<unknown>;
}

function registerTestMethods(dispatcher: RpcDispatcher, handlers: TestHandlers = {}) {
  dispatcher.register(
    buildMethodDefinition(
      'orbit.instance.describe',
      handlers.describeInstance ?? (async () => ({ data: { version: '1.0.0' } })),
    ),
  );
  dispatcher.register(
    buildMethodDefinition(
      'orbit.handshake',
      handlers.handshake ?? (async () => ({ data: { connectionId: 'conn-1' } })),
    ),
  );
  dispatcher.register(
    buildMethodDefinition(
      'orbit.session.list',
      handlers.sessionList ?? (async () => ({ data: { items: [] } })),
    ),
  );
  dispatcher.register(
    buildMethodDefinition(
      'orbit.session.start',
      handlers.sessionStart ?? (async () => ({ data: { operationId: 'op-1', accepted: true } })),
    ),
  );
  dispatcher.register(
    buildMethodDefinition(
      'orbit.runtime.threads',
      handlers.threads ?? (async () => ({ data: { items: [] } })),
    ),
  );
  dispatcher.register(
    buildMethodDefinition(
      'orbit.target.continue',
      handlers.continueTarget ?? (async () => ({ data: { accepted: true }, targetState: 'running' })),
    ),
  );
  dispatcher.register(
    buildMethodDefinition(
      'orbit.breakpoints.remove',
      handlers.removeBreakpoint ?? (async () => ({ data: { items: [] } })),
    ),
  );
  dispatcher.register(
    buildMethodDefinition(
      'orbit.connection.close',
      handlers.close ?? (async () => ({ data: { closed: true } })),
    ),
  );
}

function expectRpcError(
  response: JsonRpcResponse,
  code: number,
  message: string,
  id: string | number | null,
): JsonRpcError['error'] {
  expect(response.jsonrpc).toBe('2.0');
  expect('ok' in response).toBe(false);
  expect('result' in response).toBe(false);
  const errorResponse = response as JsonRpcError;
  expect(errorResponse.id).toBe(id);
  expect(errorResponse.error.code).toBe(code);
  expect(errorResponse.error.message).toBe(message);
  return errorResponse.error;
}

const VALID_HANDSHAKE_PARAMS = {
  context: BOOTSTRAP_CONTEXT,
  apiVersion: '1.0',
  client: { name: 'test-client', version: '0.1.0' },
  expected: { projectId: PROJECT },
  requestedScopes: ['read'],
};

describe('RpcDispatcher JSON-RPC envelope', () => {
  it('rejects malformed JSON-RPC requests with InvalidJsonRpcRequest', async () => {
    const { dispatcher } = makeHarness();
    registerTestMethods(dispatcher);
    const malformed = [
      undefined,
      null,
      'request',
      42,
      [],
      {},
      { jsonrpc: '2.0', method: 'orbit.session.list' },
      { jsonrpc: '1.0', id: '1', method: 'orbit.session.list', params: { context: CONNECTION_CONTEXT } },
      { jsonrpc: '2.0', id: '1', method: 'orbit.session.list', params: ['positional'] },
      { jsonrpc: '2.0', id: null, method: 'orbit.session.list', params: { context: CONNECTION_CONTEXT } },
    ];
    for (const request of malformed) {
      const response = await dispatcher.dispatch(request, AUTH);
      expectRpcError(response, -32600, 'InvalidJsonRpcRequest', null);
    }
  });

  it('never returns the legacy {ok,error} top-level envelope', async () => {
    const { dispatcher } = makeHarness();
    registerTestMethods(dispatcher);
    const response = await dispatcher.dispatch(rpc('1', 'orbit.instance.describe', { context: BOOTSTRAP_CONTEXT }), AUTH);
    expect(response).toHaveProperty('jsonrpc', '2.0');
    expect(response).not.toHaveProperty('ok');
    expect(response).not.toHaveProperty('error');
  });

  it('checks the bearer token before method lookup', async () => {
    const { dispatcher } = makeHarness();
    registerTestMethods(dispatcher);
    for (const authorization of [undefined, '', 'Bearer wrong', 'Bearer ' + TOKEN]) {
      if (authorization === AUTH) continue;
      const response = await dispatcher.dispatch(rpc('1', 'orbit.unknown.method', { context: BOOTSTRAP_CONTEXT }), authorization);
      expectRpcError(response, -32001, 'Unauthorized', '1');
    }
  });

  it('rejects unknown methods with MethodNotFound', async () => {
    const { dispatcher } = makeHarness();
    registerTestMethods(dispatcher);
    const response = await dispatcher.dispatch(rpc('7', 'orbit.nope.nothing', { context: BOOTSTRAP_CONTEXT }), AUTH);
    expectRpcError(response, -32601, 'MethodNotFound', '7');
  });

  it('rejects params without context with InvalidParams', async () => {
    const { dispatcher } = makeHarness();
    registerTestMethods(dispatcher);
    const response = await dispatcher.dispatch(rpc('1', 'orbit.session.list', {}), AUTH);
    const error = expectRpcError(response, -32602, 'InvalidParams', '1');
    // ad-hoc diagnostics live under data.details; no invented top-level fields
    expect(error.data).not.toHaveProperty('issues');
    const details = (error.data as { details: { issues: Array<{ path: string }> } }).details;
    expect(details.issues.some(issue => issue.path === 'context')).toBe(true);
  });

  it('rejects schema violations with InvalidParams', async () => {
    const { dispatcher } = makeHarness();
    registerTestMethods(dispatcher);
    // breakpoints.remove requires a non-empty breakpointId
    const response = await dispatcher.dispatch(
      rpc('1', 'orbit.breakpoints.remove', { context: { ...CONNECTION_CONTEXT, idempotencyKey: 'key-1' } }),
      AUTH,
    );
    expectRpcError(response, -32602, 'InvalidParams', '1');
  });

  it('echoes numeric ids as decimal requestId strings in the result envelope', async () => {
    const { dispatcher } = makeHarness();
    registerTestMethods(dispatcher);
    const response = await dispatcher.dispatch(rpc(42, 'orbit.instance.describe', { context: BOOTSTRAP_CONTEXT }), AUTH);
    expect(response.id).toBe(42);
    const result = (response as { result: Record<string, unknown> }).result;
    expect(result.requestId).toBe('42');
    expect(result.instanceId).toBe(INSTANCE);
    expect(result.projectId).toBe(PROJECT);
  });
});

describe('RpcDispatcher fences', () => {
  it('runs bootstrap methods with only token and BootstrapContext', async () => {
    const { dispatcher } = makeHarness();
    const seen: RpcCallContext[] = [];
    registerTestMethods(dispatcher, {
      describeInstance: async (_params, call) => {
        seen.push(call);
        return { data: { version: '1.0.0' } };
      },
    });
    const response = await dispatcher.dispatch(rpc('1', 'orbit.instance.describe', { context: BOOTSTRAP_CONTEXT }), AUTH);
    expect(response).toMatchObject({ jsonrpc: '2.0', id: '1' });
    expect((response as { result: unknown }).result).toMatchObject({ requestId: '1', data: { version: '1.0.0' } });
    expect(seen).toHaveLength(1);
    expect(seen[0].connection).toBeUndefined();
    expect(seen[0].identity).toEqual(BOOTSTRAP_CONTEXT);
  });

  it('runs the bootstrap handshake mutation without requiring an idempotency key', async () => {
    const { dispatcher } = makeHarness();
    const seen: RpcCallContext[] = [];
    registerTestMethods(dispatcher, {
      handshake: async (_params, call) => {
        seen.push(call);
        return { data: { connectionId: 'conn-new' } };
      },
    });
    const response = await dispatcher.dispatch(rpc('1', 'orbit.handshake', VALID_HANDSHAKE_PARAMS), AUTH);
    expect('result' in response).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0].identity).toEqual(BOOTSTRAP_CONTEXT);
    expect(seen[0].operationId).toBeUndefined();
  });

  it('fences bootstrap instance and project identity', async () => {
    const { dispatcher } = makeHarness();
    registerTestMethods(dispatcher);
    const wrongInstance = await dispatcher.dispatch(
      rpc('1', 'orbit.instance.describe', { context: { instanceId: 'instance-9', projectId: PROJECT } }),
      AUTH,
    );
    expectRpcError(wrongInstance, -32006, 'InstanceMismatch', '1');
    const wrongProject = await dispatcher.dispatch(
      rpc('2', 'orbit.instance.describe', { context: { instanceId: INSTANCE, projectId: 'sha256:other' } }),
      AUTH,
    );
    expectRpcError(wrongProject, -32005, 'ProjectMismatch', '2');
  });

  it('requires a live connection lease for non-bootstrap methods', async () => {
    const { dispatcher } = makeHarness();
    registerTestMethods(dispatcher);
    const unknown = await dispatcher.dispatch(rpc('1', 'orbit.session.list', { context: CONNECTION_CONTEXT }), AUTH);
    expectRpcError(unknown, -32008, 'ConnectionExpired', '1');
  });

  it('rejects expired connection leases', async () => {
    const harness = makeHarness();
    registerTestMethods(harness.dispatcher);
    grant(harness, ['read'], Date.now() - 1000);
    const response = await harness.dispatcher.dispatch(rpc('1', 'orbit.session.list', { context: CONNECTION_CONTEXT }), AUTH);
    expectRpcError(response, -32008, 'ConnectionExpired', '1');
  });

  it('fences connection instance and project identity', async () => {
    const harness = makeHarness();
    registerTestMethods(harness.dispatcher);
    grant(harness, ['read']);
    harness.leases.get('conn-1')!.instanceId = 'instance-9';
    const wrongInstance = await harness.dispatcher.dispatch(rpc('1', 'orbit.session.list', { context: CONNECTION_CONTEXT }), AUTH);
    expectRpcError(wrongInstance, -32006, 'InstanceMismatch', '1');
    harness.leases.get('conn-1')!.instanceId = INSTANCE;
    harness.leases.get('conn-1')!.projectId = 'sha256:other';
    const wrongProject = await harness.dispatcher.dispatch(rpc('2', 'orbit.session.list', { context: CONNECTION_CONTEXT }), AUTH);
    expectRpcError(wrongProject, -32005, 'ProjectMismatch', '2');
  });

  it('rejects connections without the required scope', async () => {
    const harness = makeHarness();
    registerTestMethods(harness.dispatcher);
    grant(harness, ['read']);
    harness.generations.set('session-1', 3);
    const denied = await harness.dispatcher.dispatch(
      rpc('1', 'orbit.target.continue', { context: TARGET_MUTATION_CONTEXT }),
      AUTH,
    );
    const error = expectRpcError(denied, -32001, 'Unauthorized', '1');
    expect(error.data).not.toHaveProperty('requiredScopes');
    const details = (error.data as { details: { requiredScopes: string[] } }).details;
    expect(details.requiredScopes).toEqual(['session.control']);
  });

  it('runs the handler when the connection scope is granted', async () => {
    const harness = makeHarness();
    registerTestMethods(harness.dispatcher);
    grant(harness, ['read', 'session.control']);
    harness.generations.set('session-1', 3);
    const response = await harness.dispatcher.dispatch(
      rpc('1', 'orbit.target.continue', { context: TARGET_MUTATION_CONTEXT }),
      AUTH,
    );
    expect('result' in response).toBe(true);
  });

  it('fences session identity and generation for target-bound methods', async () => {
    const harness = makeHarness();
    registerTestMethods(harness.dispatcher);
    grant(harness, ['read']);
    const missing = await harness.dispatcher.dispatch(rpc('1', 'orbit.runtime.threads', { context: TARGET_REQUEST_CONTEXT }), AUTH);
    expectRpcError(missing, -32009, 'NoActiveSession', '1');

    harness.generations.set('session-1', 3);
    const stale = await harness.dispatcher.dispatch(
      rpc('2', 'orbit.runtime.threads', { context: { ...TARGET_REQUEST_CONTEXT, sessionGeneration: 4 } }),
      AUTH,
    );
    const error = expectRpcError(stale, -32012, 'SessionChanged', '2');
    expect(error.data).toMatchObject({ expectedGeneration: 4, actualGeneration: 3 });

    const fresh = await harness.dispatcher.dispatch(rpc('3', 'orbit.runtime.threads', { context: TARGET_REQUEST_CONTEXT }), AUTH);
    expect('result' in fresh).toBe(true);
  });

  it('applies the generation fence before the scope check', async () => {
    const harness = makeHarness();
    registerTestMethods(harness.dispatcher);
    grant(harness, ['read']); // missing session.control, stale generation
    harness.generations.set('session-1', 3);
    const response = await harness.dispatcher.dispatch(
      rpc('1', 'orbit.target.continue', { context: { ...TARGET_MUTATION_CONTEXT, sessionGeneration: 5 } }),
      AUTH,
    );
    expectRpcError(response, -32012, 'SessionChanged', '1');
  });

  it('applies the scope check before idempotency lookup', async () => {
    const harness = makeHarness();
    const handler = vi.fn(async () => ({ data: { accepted: true } }));
    registerTestMethods(harness.dispatcher, { continueTarget: handler });
    grant(harness, ['session.control']);
    harness.generations.set('session-1', 3);

    const first = await harness.dispatcher.dispatch(rpc('1', 'orbit.target.continue', { context: TARGET_MUTATION_CONTEXT }), AUTH);
    expect('result' in first).toBe(true);

    // scope revoked: the replay must be denied before the cached result is consulted
    harness.leases.get('conn-1')!.scopes = new Set(['read']);
    const replay = await harness.dispatcher.dispatch(rpc('2', 'orbit.target.continue', { context: TARGET_MUTATION_CONTEXT }), AUTH);
    expectRpcError(replay, -32001, 'Unauthorized', '2');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('requires an idempotency key when the frozen policy demands one', async () => {
    const harness = makeHarness();
    registerTestMethods(harness.dispatcher);
    grant(harness, ['session.control']);
    harness.generations.set('session-1', 3);
    const response = await harness.dispatcher.dispatch(
      rpc('1', 'orbit.target.continue', { context: TARGET_REQUEST_CONTEXT }),
      AUTH,
    );
    expectRpcError(response, -32602, 'InvalidParams', '1');
  });

  it('rejects handler definitions that drift from the frozen catalog', () => {
    const { dispatcher } = makeHarness();
    expect(() => dispatcher.register(buildMethodDefinition('orbit.unknown.method', async () => ({ data: {} })))).toThrow(/unknown automation method/i);
    const entry = getMethodCatalogEntry('orbit.session.list')!;
    expect(() =>
      dispatcher.register({
        name: 'orbit.session.list',
        bootstrap: entry.bootstrap,
        requiredScopes: [...entry.requiredScopes],
        mutation: entry.mutation,
        requiresIdempotency: entry.requiresIdempotency,
        targetBound: entry.targetBound,
        timeoutMs: entry.timeoutMs + 1,
        paramsSchema: entry.paramsSchema as never,
        handler: async () => ({ data: {} }),
      }),
    ).toThrow(/timeout/i);
    expect(() =>
      dispatcher.register({
        name: 'orbit.session.list',
        bootstrap: entry.bootstrap,
        requiredScopes: [...entry.requiredScopes],
        mutation: entry.mutation,
        requiresIdempotency: entry.requiresIdempotency,
        targetBound: entry.targetBound,
        timeoutMs: entry.timeoutMs,
        paramsSchema: entry.paramsSchema as never,
        handler: async () => ({ data: {} }),
      }),
    ).not.toThrow();
    expect(() =>
      dispatcher.register({
        name: 'orbit.session.list',
        bootstrap: entry.bootstrap,
        requiredScopes: [...entry.requiredScopes],
        mutation: entry.mutation,
        requiresIdempotency: entry.requiresIdempotency,
        targetBound: entry.targetBound,
        timeoutMs: entry.timeoutMs,
        paramsSchema: entry.paramsSchema as never,
        handler: async () => ({ data: {} }),
      }),
    ).toThrow(/already registered/i);
  });
});

describe('RpcDispatcher idempotency and operation store', () => {
  it('replays the cached result for the same key, params and generation', async () => {
    const harness = makeHarness();
    const handler = vi.fn(async () => ({ data: { accepted: true }, targetState: 'running' }));
    registerTestMethods(harness.dispatcher, { continueTarget: handler });
    grant(harness, ['session.control']);
    harness.generations.set('session-1', 3);

    const first = await harness.dispatcher.dispatch(rpc('1', 'orbit.target.continue', { context: TARGET_MUTATION_CONTEXT }), AUTH);
    const second = await harness.dispatcher.dispatch(rpc('2', 'orbit.target.continue', { context: TARGET_MUTATION_CONTEXT }), AUTH);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({ jsonrpc: '2.0', id: '1' });
    expect(second).toMatchObject({ jsonrpc: '2.0', id: '2' });
    expect((second as { result: unknown }).result).toEqual((first as { result: unknown }).result);
    // the replayed result keeps the original requestId
    expect(((second as { result: { requestId: string } }).result).requestId).toBe('1');
  });

  it('rejects the same key with different params as InvalidRequest', async () => {
    const harness = makeHarness();
    const handler = vi.fn(async () => ({ data: { accepted: true } }));
    registerTestMethods(harness.dispatcher, { continueTarget: handler });
    grant(harness, ['session.control']);
    harness.generations.set('session-1', 3);

    const first = await harness.dispatcher.dispatch(rpc('1', 'orbit.target.continue', { context: TARGET_MUTATION_CONTEXT }), AUTH);
    expect('result' in first).toBe(true);
    const conflict = await harness.dispatcher.dispatch(
      rpc('2', 'orbit.target.continue', { context: TARGET_MUTATION_CONTEXT, threadId: 1 }),
      AUTH,
    );
    expectRpcError(conflict, -32002, 'InvalidRequest', '2');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('never replays a mutation across a session generation change', async () => {
    const harness = makeHarness();
    const handler = vi.fn(async () => ({ data: { accepted: true } }));
    registerTestMethods(harness.dispatcher, { continueTarget: handler });
    grant(harness, ['session.control']);
    harness.generations.set('session-1', 3);

    const first = await harness.dispatcher.dispatch(rpc('1', 'orbit.target.continue', { context: TARGET_MUTATION_CONTEXT }), AUTH);
    expect('result' in first).toBe(true);

    harness.generations.set('session-1', 4);
    const staleReplay = await harness.dispatcher.dispatch(
      rpc('2', 'orbit.target.continue', { context: { ...TARGET_MUTATION_CONTEXT, sessionGeneration: 4 } }),
      AUTH,
    );
    expectRpcError(staleReplay, -32002, 'InvalidRequest', '2');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('never replays a session.start across a registry generation change', async () => {
    const harness = makeHarness();
    const handler = vi.fn(async () => ({ data: { operationId: 'op-1', accepted: true } }));
    registerTestMethods(harness.dispatcher, { sessionStart: handler });
    grant(harness, ['session.control']);

    const params = (registryGeneration: number) => ({
      context: { ...CONNECTION_CONTEXT, idempotencyKey: 'key-1', registryGeneration },
      configurationId: 'Orbit Launch',
    });
    const first = await harness.dispatcher.dispatch(rpc('1', 'orbit.session.start', params(0)), AUTH);
    expect('result' in first).toBe(true);

    const staleReplay = await harness.dispatcher.dispatch(rpc('2', 'orbit.session.start', params(1)), AUTH);
    expectRpcError(staleReplay, -32002, 'InvalidRequest', '2');
    expect(handler).toHaveBeenCalledTimes(1);

    // Identical registry generation still replays the cached result.
    const sameGeneration = await harness.dispatcher.dispatch(rpc('3', 'orbit.session.start', params(0)), AUTH);
    expect('result' in sameGeneration).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('merges concurrent same-key requests into one in-flight handler', async () => {
    const harness = makeHarness();
    const gate = deferred<unknown>();
    const handler = vi.fn(async () => gate.promise);
    registerTestMethods(harness.dispatcher, { continueTarget: handler });
    grant(harness, ['session.control']);
    harness.generations.set('session-1', 3);

    const first = harness.dispatcher.dispatch(rpc('1', 'orbit.target.continue', { context: TARGET_MUTATION_CONTEXT }), AUTH);
    const second = harness.dispatcher.dispatch(rpc('2', 'orbit.target.continue', { context: TARGET_MUTATION_CONTEXT }), AUTH);
    await Promise.resolve();
    expect(handler).toHaveBeenCalledTimes(1);

    gate.resolve({ data: { accepted: true }, targetState: 'running' });
    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    expect('result' in firstResponse).toBe(true);
    expect((secondResponse as { result: unknown }).result).toEqual((firstResponse as { result: unknown }).result);
  });

  it('exposes queued and completed mutations through orbit.operation.get', async () => {
    const harness = makeHarness();
    const gate = deferred<unknown>();
    registerTestMethods(harness.dispatcher, {
      continueTarget: async (_params, call) => gate.promise.then(() => ({ data: { accepted: true, operationId: call.operationId } })),
    });
    grant(harness, ['session.control', 'read']);
    harness.generations.set('session-1', 3);

    const responsePromise = harness.dispatcher.dispatch(rpc('1', 'orbit.target.continue', { context: TARGET_MUTATION_CONTEXT }), AUTH);
    const running = await harness.dispatcher.dispatch(
      rpc('2', 'orbit.operation.get', { context: CONNECTION_CONTEXT, operationId: 'unknown-op' }),
      AUTH,
    );
    expectRpcError(running, -32002, 'InvalidRequest', '2');

    gate.resolve({ data: { accepted: true } });
    const response = (await responsePromise) as { result: { data: { operationId: string } } };
    expect('result' in response).toBe(true);
    const operationId = response.result.data.operationId;

    const fetched = await harness.dispatcher.dispatch(
      rpc('3', 'orbit.operation.get', { context: CONNECTION_CONTEXT, operationId }),
      AUTH,
    );
    const data = ((fetched as { result: unknown }).result as { data: Record<string, unknown> }).data;
    expect(data.status).toBe('succeeded');
    expect(data.dispatchedAt).toMatch(/^\d+$/);
    expect(data.completedAt).toMatch(/^\d+$/);
    expect(data.result).toEqual(response.result);
  });

  it('keeps operation results private to their connection', async () => {
    const harness = makeHarness();
    registerTestMethods(harness.dispatcher, {
      continueTarget: async (_params, call) => ({ data: { accepted: true, operationId: call.operationId } }),
    });
    grant(harness, ['session.control', 'read']);
    harness.generations.set('session-1', 3);

    const response = await harness.dispatcher.dispatch(rpc('1', 'orbit.target.continue', { context: TARGET_MUTATION_CONTEXT }), AUTH);
    const operationId = ((response as { result: unknown }).result as { data: { operationId: string } }).data.operationId;

    const otherLease: ConnectionLease = {
      connectionId: 'conn-2',
      instanceId: INSTANCE,
      projectId: PROJECT,
      scopes: new Set(['read']),
      expiresAt: Date.now() + 60_000,
    };
    harness.leases.set('conn-2', otherLease);
    const foreign = await harness.dispatcher.dispatch(
      rpc('2', 'orbit.operation.get', { context: { ...BOOTSTRAP_CONTEXT, connectionId: 'conn-2' }, operationId }),
      AUTH,
    );
    expectRpcError(foreign, -32002, 'InvalidRequest', '2');
  });

  it('maps handler AutomationError values onto the frozen error codes', async () => {
    const harness = makeHarness();
    const handler = vi.fn(async () => {
      throw new AutomationError('TargetRunning', undefined, false, undefined, { targetState: 'running' });
    });
    registerTestMethods(harness.dispatcher, { continueTarget: handler });
    grant(harness, ['session.control']);
    harness.generations.set('session-1', 3);

    const response = await harness.dispatcher.dispatch(rpc('1', 'orbit.target.continue', { context: TARGET_MUTATION_CONTEXT }), AUTH);
    expectRpcError(response, -32015, 'TargetRunning', '1');

    // failures are cached and replayed under the same key
    const replay = await harness.dispatcher.dispatch(rpc('2', 'orbit.target.continue', { context: TARGET_MUTATION_CONTEXT }), AUTH);
    expectRpcError(replay, -32015, 'TargetRunning', '2');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('maps unexpected handler failures onto InternalError', async () => {
    const harness = makeHarness();
    registerTestMethods(harness.dispatcher, {
      sessionList: async () => {
        throw new Error('boom');
      },
    });
    grant(harness, ['read']);
    const response = await harness.dispatcher.dispatch(rpc('1', 'orbit.session.list', { context: CONNECTION_CONTEXT }), AUTH);
    expectRpcError(response, -32028, 'InternalError', '1');
  });

  it('stops accepting requests after dispose and aborts in-flight signals', async () => {
    const harness = makeHarness();
    const gate = deferred<unknown>();
    let signal: AbortSignal | undefined;
    registerTestMethods(harness.dispatcher, {
      sessionList: async (_params, call) => {
        signal = call.signal;
        return gate.promise;
      },
    });
    grant(harness, ['read']);
    const pending = harness.dispatcher.dispatch(rpc('1', 'orbit.session.list', { context: CONNECTION_CONTEXT }), AUTH);
    await Promise.resolve();
    harness.dispatcher.dispose();
    expect(signal!.aborted).toBe(true);
    const afterDispose = await harness.dispatcher.dispatch(rpc('2', 'orbit.session.list', { context: CONNECTION_CONTEXT }), AUTH);
    expectRpcError(afterDispose, -32028, 'InternalError', '2');
    gate.resolve({ data: { items: [] } });
    await pending;
  });
});

describe('RpcDispatcher timeouts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function slowContinueHarness() {
    const harness = makeHarness();
    const gate = deferred<unknown>();
    const handler = vi.fn(async () => gate.promise);
    registerTestMethods(harness.dispatcher, { continueTarget: handler });
    // fake timers also advance Date.now(), so keep the lease well in the future
    grant(harness, ['session.control', 'read'], Date.now() + 3_600_000);
    harness.generations.set('session-1', 3);
    return { harness, gate, handler };
  }

  it('reports outcomeUnknown for a mutation that began but did not finish', async () => {
    const { harness, gate, handler } = slowContinueHarness();
    const pending = harness.dispatcher.dispatch(rpc('1', 'orbit.target.continue', { context: TARGET_MUTATION_CONTEXT }), AUTH);
    await vi.advanceTimersByTimeAsync(30_000);

    const response = await pending;
    const error = expectRpcError(response, -32027, 'RequestTimeout', '1');
    const data = error.data as { timeoutKind: string; operationId: string; retryable: boolean };
    expect(data.timeoutKind).toBe('outcomeUnknown');
    expect(data.operationId).toMatch(/^op_/);
    expect(data.retryable).toBe(false);

    // while the handler is still pending the operation reports outcomeUnknown
    const pendingFetch = await harness.dispatcher.dispatch(
      rpc('2', 'orbit.operation.get', { context: CONNECTION_CONTEXT, operationId: data.operationId }),
      AUTH,
    );
    const pendingStatus = ((pendingFetch as { result: unknown }).result as { data: { status: string } }).data.status;
    expect(pendingStatus).toBe('outcomeUnknown');

    // the timed-out mutation must never be re-executed under the same key
    gate.resolve({ data: { accepted: true }, targetState: 'running' });
    await vi.advanceTimersByTimeAsync(0);
    const replay = await harness.dispatcher.dispatch(rpc('3', 'orbit.target.continue', { context: TARGET_MUTATION_CONTEXT }), AUTH);
    expect('result' in replay).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);

    // the operation store keeps the final outcome for recovery
    const fetched = await harness.dispatcher.dispatch(
      rpc('4', 'orbit.operation.get', { context: CONNECTION_CONTEXT, operationId: data.operationId }),
      AUTH,
    );
    const status = ((fetched as { result: unknown }).result as { data: { status: string } }).data.status;
    expect(status).toBe('succeeded');
  });

  it('reports queueTimeout for a replay whose handler never started', async () => {
    const { harness, gate, handler } = slowContinueHarness();
    const first = harness.dispatcher.dispatch(rpc('1', 'orbit.target.continue', { context: TARGET_MUTATION_CONTEXT }), AUTH);
    await vi.advanceTimersByTimeAsync(30_000);
    await first;

    const replay = harness.dispatcher.dispatch(rpc('2', 'orbit.target.continue', { context: TARGET_MUTATION_CONTEXT }), AUTH);
    await vi.advanceTimersByTimeAsync(30_000);
    const replayResponse = await replay;
    const error = expectRpcError(replayResponse, -32027, 'RequestTimeout', '2');
    expect(error.data).toMatchObject({ timeoutKind: 'queueTimeout', retryable: true });
    expect(handler).toHaveBeenCalledTimes(1);

    // after the original operation completes, the key replays its final result
    gate.resolve({ data: { accepted: true }, targetState: 'running' });
    await vi.advanceTimersByTimeAsync(0);
    const recovered = await harness.dispatcher.dispatch(rpc('3', 'orbit.target.continue', { context: TARGET_MUTATION_CONTEXT }), AUTH);
    expect('result' in recovered).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('times out read-only methods as safe queueTimeout without an operation record', async () => {
    const harness = makeHarness();
    const gate = deferred<unknown>();
    registerTestMethods(harness.dispatcher, { sessionList: async () => gate.promise });
    grant(harness, ['read']);

    const pending = harness.dispatcher.dispatch(rpc('1', 'orbit.session.list', { context: CONNECTION_CONTEXT }), AUTH);
    await vi.advanceTimersByTimeAsync(5_000);
    const response = await pending;
    const error = expectRpcError(response, -32027, 'RequestTimeout', '1');
    expect(error.data).toMatchObject({ timeoutKind: 'queueTimeout', retryable: true });
    gate.resolve({ data: { items: [] } });
  });

  it('times out the bootstrap handshake mutation as retryable queueTimeout without an operationId', async () => {
    // handshake has no connection-scoped operation entry (its context is
    // BootstrapContext), and the frozen contract only allows outcomeUnknown
    // together with an operationId, so a timed-out handshake must fall back
    // to the retryable queueTimeout shape instead.
    const harness = makeHarness();
    const gate = deferred<unknown>();
    registerTestMethods(harness.dispatcher, { handshake: async () => gate.promise });

    const pending = harness.dispatcher.dispatch(rpc('1', 'orbit.handshake', VALID_HANDSHAKE_PARAMS), AUTH);
    await vi.advanceTimersByTimeAsync(2_000);
    const response = await pending;
    const error = expectRpcError(response, -32027, 'RequestTimeout', '1');
    expect(error.data).toMatchObject({ timeoutKind: 'queueTimeout', retryable: true });
    expect(error.data).not.toHaveProperty('operationId');
    gate.resolve({ data: { connectionId: 'conn-new' } });
  });
});

describe('RpcDispatcher method catalog', () => {
  it('mirrors the frozen OpenRPC document exactly', () => {
    const openRpcPath = path.resolve(__dirname, '..', '..', 'docs', 'api', 'orbit-automation-openrpc.json');
    const document = JSON.parse(fs.readFileSync(openRpcPath, 'utf8'));
    expect(document.openrpc).toBe('1.3.2');
    const methods = document.methods as Array<{
      name: string;
      params: Array<{ schema: { $ref: string } }>;
      result: { schema: { $ref: string } };
      'x-orbit-method': {
        bootstrap: boolean;
        requiredScopes: string[];
        mutation: boolean;
        requiresIdempotency: boolean;
        targetBound: boolean;
        defaultTimeoutMs: number;
        paramsSchemaRef: string;
        resultSchemaRef: string;
        errorCodes: string[];
      };
    }>;
    expect(METHOD_CATALOG.size).toBe(methods.length);
    for (const method of methods) {
      const metadata = method['x-orbit-method'];
      const entry = getMethodCatalogEntry(method.name);
      expect(entry, method.name).toBeDefined();
      expect(entry!.bootstrap).toBe(metadata.bootstrap);
      expect([...entry!.requiredScopes]).toEqual(metadata.requiredScopes);
      expect(entry!.mutation).toBe(metadata.mutation);
      expect(entry!.requiresIdempotency).toBe(metadata.requiresIdempotency);
      expect(entry!.targetBound).toBe(metadata.targetBound);
      expect(entry!.timeoutMs).toBe(metadata.defaultTimeoutMs);
      expect(entry!.paramsSchemaRef).toBe(method.params[0].schema.$ref);
      expect(entry!.resultSchemaRef).toBe(method.result.schema.$ref);
      expect([...entry!.errorCodes]).toEqual(metadata.errorCodes);
      // every frozen params schema requires a context object
      const parsed = entry!.paramsSchema.safeParse({});
      expect(parsed.success, `${method.name} params must require context`).toBe(false);
      const issues = parsed.success ? [] : parsed.error.issues;
      expect(issues.some(issue => issue.path[0] === 'context')).toBe(true);
    }
  });
});
