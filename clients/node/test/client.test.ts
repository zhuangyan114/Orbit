import * as http from 'http';
import * as path from 'path';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AmbiguousInstanceError,
  OrbitClient,
  OrbitRpcError,
  decodeBase64,
  enumerateInstances,
  selectInstance,
  type OrbitEndpoint,
} from '../src/index';
import { CLI_COMMANDS, runCli } from '../src/cli';

const INSTANCE_ID = 'instance-a';
const PROJECT_ID = 'sha256:project-a';
const CONNECTION_ID = 'conn-a';
const SESSION_ID = 'session-a';

interface WireFixtures {
  handshake: unknown;
  sessionSnapshot: unknown;
  operationGet: unknown;
  pollSessionSnapshot: unknown;
  recordGetPage1: unknown;
  recordGetPage2: unknown;
  rpcError: unknown;
}

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(dispose => dispose()));
});

async function fixtures(): Promise<WireFixtures> {
  const file = path.join(process.cwd(), 'clients', 'test-fixtures', 'wire-payloads.json');
  return JSON.parse(await readFile(file, 'utf8')) as WireFixtures;
}

function operationResult(id: string, data: unknown) {
  return {
    jsonrpc: '2.0',
    id,
    result: {
      requestId: id,
      instanceId: INSTANCE_ID,
      projectId: PROJECT_ID,
      data,
    },
  };
}

async function startFakeApi() {
  const requests: unknown[] = [];
  const eventFilterHeaders: Array<string | undefined> = [];
  const session = {
    sessionId: SESSION_ID,
    sessionGeneration: 7,
    registryGeneration: 7,
    name: 'fixture',
    type: 'orbit',
    phase: 'halted',
    targetState: 'halted',
    capabilities: [],
  };
  const server = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, status: 'ok', instanceId: INSTANCE_ID, projectId: PROJECT_ID, apiVersion: '1.0' }));
      return;
    }
    if (request.method === 'GET' && request.url === '/v1/events') {
      expect(request.headers.authorization).toBe('Bearer token-a');
      expect(request.headers['x-orbit-connection-id']).toBe(CONNECTION_ID);
      eventFilterHeaders.push(request.headers['x-orbit-event-type']);
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      const event = {
        eventId: '0000000000000001',
        instanceId: INSTANCE_ID,
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
        sessionGeneration: 7,
        timestamp: '1700000000000',
        type: 'target.stopped',
        data: { reason: 'breakpoint' },
      };
      response.end(`id: ${event.eventId}\r\nevent: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`);
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/rpc') {
      response.writeHead(404).end();
      return;
    }
    if (request.headers.authorization !== 'Bearer token-a') {
      const responseBody = JSON.stringify({ ok: false, error: 'Unauthorized' });
      response.writeHead(401, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(responseBody) });
      response.end(responseBody);
      return;
    }
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id: string; method: string };
      requests.push(body);
      let data: unknown;
      if (body.method === 'orbit.handshake') {
        data = {
          connectionId: CONNECTION_ID,
          expiresAt: '1700000600000',
          grantedScopes: ['read'],
          instance: { instanceId: INSTANCE_ID },
          project: { projectId: PROJECT_ID, registryGeneration: 7 },
          capabilities: { apiVersion: '1.0', capabilities: [] },
          session,
        };
      } else if (body.method === 'orbit.session.snapshot') {
        data = session;
      } else if (body.method === 'orbit.operation.get') {
        data = { operationId: 'op-a', status: 'succeeded', dispatchedAt: '1700000000000' };
      } else if (body.method === 'orbit.session.list') {
        data = { items: [session] };
      } else if (body.method === 'orbit.record.get') {
        const cursor = (body as { params?: { cursor?: string } }).params?.cursor;
        data = cursor
          ? { recording: { recordingId: 'record-a' }, items: [{ frameId: 'frame-2', timestamp: '1700000000002' }] }
          : { recording: { recordingId: 'record-a' }, items: [{ frameId: 'frame-1', timestamp: '1700000000001' }], nextCursor: 'frame-1' };
      } else if (body.method === 'orbit.connection.close') {
        data = { connectionId: CONNECTION_ID, closed: true, releasedSubscriptions: 0 };
      } else if (body.method === 'orbit.expression.writeMany') {
        const responseBody = JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          error: { code: -32015, message: 'InvalidRequest', data: { errorCode: 'InvalidRequest', retryable: false } },
        });
        response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(responseBody) });
        response.end(responseBody);
        return;
      } else if (body.method === 'orbit.expression.evaluate') {
        const responseBody = JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          error: { code: -32015, message: 'InvalidRequest', data: { errorCode: 'InvalidRequest', retryable: false } },
        });
        response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(responseBody) });
        response.end(responseBody);
        return;
      } else {
        response.writeHead(500).end();
        return;
      }
      const responseBody = JSON.stringify(operationResult(body.id, data));
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(responseBody) });
      response.end(responseBody);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake API did not bind');
  cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  return { port: address.port, requests, session, eventFilterHeaders };
}

function endpoint(port: number, instanceId = INSTANCE_ID): OrbitEndpoint {
  return {
    schemaVersion: 1,
    instanceId,
    projectId: PROJECT_ID,
    channel: 'stable',
    profile: '',
    extensionHost: 'local',
    workspaceFolders: ['C:\\project'],
    host: '127.0.0.1',
    port,
    rpcUrl: `http://127.0.0.1:${port}/v1/rpc`,
    eventsUrl: `http://127.0.0.1:${port}/v1/events`,
    healthUrl: `http://127.0.0.1:${port}/health`,
    token: 'token-a',
    processId: 123,
    startedAt: 1700000000000,
    heartbeatAt: 1700000000000,
    apiVersions: ['1.0'],
  };
}

describe('Orbit Node client', () => {
  it('discovers healthy endpoint files and rejects ambiguous project selection', async () => {
    const api = await startFakeApi();
    const root = await mkdtemp(path.join(tmpdir(), 'orbit-node-client-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const endpointDirectory = path.join(root, 'endpoints');
    const registryPath = path.join(root, 'registries.json');
    await mkdir(endpointDirectory, { recursive: true });
    await writeFile(path.join(endpointDirectory, `${INSTANCE_ID}.json`), JSON.stringify(endpoint(api.port)), 'utf8');
    await writeFile(registryPath, JSON.stringify({
      schemaVersion: 1,
      registries: [{ channel: 'stable', profile: '', extensionHost: 'local', endpointDirectory, updatedAt: Date.now() }],
    }), 'utf8');

    const discovered = await enumerateInstances({ registryPath });
    expect(discovered).toEqual([endpoint(api.port)]);
    expect(selectInstance(discovered, { projectId: PROJECT_ID })).toEqual(endpoint(api.port));
    expect(() => selectInstance([endpoint(api.port), endpoint(api.port, 'instance-b')], { projectId: PROJECT_ID }))
      .toThrow(AmbiguousInstanceError);
    expect(selectInstance([endpoint(api.port), endpoint(api.port, 'instance-b')], { instanceId: 'instance-b' }).instanceId)
      .toBe('instance-b');
  });

  it('uses the shared handshake, session, operation, polling, and SSE wire payloads', async () => {
    const api = await startFakeApi();
    let request = 0;
    const client = new OrbitClient(endpoint(api.port), { requestId: () => `req-${++request}` });

    const handshake = await client.handshake({
      client: { name: 'fixture-client', version: '1.0.0' },
      requestedScopes: ['read'],
    });
    expect(handshake.connectionId).toBe(CONNECTION_ID);
    expect(client.session?.sessionId).toBe(SESSION_ID);

    const refreshed = await client.refreshSession(SESSION_ID);
    expect(refreshed.sessionGeneration).toBe(7);
    expect((await client.getOperation('op-a')).status).toBe('succeeded');

    const snapshots = [];
    for await (const snapshot of client.pollSnapshots([
      { method: 'orbit.session.snapshot', params: { sessionId: SESSION_ID, includeCapabilities: true } },
    ], { iterations: 1, intervalMs: 0 })) {
      snapshots.push(snapshot);
    }
    expect(snapshots[0].data).toEqual(api.session);

    const events = [];
    for await (const event of client.events({ eventTypes: ['watch.changed', 'target.stopped'] })) events.push(event);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'target.stopped', eventId: '0000000000000001' });
    expect(api.eventFilterHeaders).toEqual([undefined]);

    const pages = [];
    for await (const page of client.paginate('orbit.record.get', { recordingId: 'record-a' }, { context: 'target' })) {
      pages.push(page);
    }
    expect(pages.map(page => page.items[0])).toEqual([
      { frameId: 'frame-1', timestamp: '1700000000001' },
      { frameId: 'frame-2', timestamp: '1700000000002' },
    ]);
    expect([...decodeBase64('AQID')]).toEqual([1, 2, 3]);
    await expect(client.invoke('orbit.expression.evaluate', { expression: 'missing_symbol' }, { context: 'target' }))
      .rejects.toMatchObject<Partial<OrbitRpcError>>({ code: -32015, data: { errorCode: 'InvalidRequest', retryable: false } });

    const wire = await fixtures();
    expect(api.requests).toEqual([
      wire.handshake,
      wire.sessionSnapshot,
      wire.operationGet,
      wire.pollSessionSnapshot,
      wire.recordGetPage1,
      wire.recordGetPage2,
      wire.rpcError,
    ]);
  });

  it('surfaces the server error body for non-envelope failures', async () => {
    const api = await startFakeApi();
    const client = new OrbitClient({ ...endpoint(api.port), token: 'token-b' });
    await expect(client.handshake({ client: { name: 'fixture-client' }, requestedScopes: ['read'] }))
      .rejects.toThrow(/HTTP 401: Unauthorized/);
  });

  it('publishes every required CLI command', () => {
    expect(Object.keys(CLI_COMMANDS).sort()).toEqual([
      'breakpoints', 'continue', 'instances', 'memory-read', 'operation', 'pause', 'read', 'record',
      'start', 'status', 'step', 'stop', 'write',
    ]);
  });

  it('runs the status CLI through discovery, handshake, and JSON-RPC', async () => {
    const api = await startFakeApi();
    const root = await mkdtemp(path.join(tmpdir(), 'orbit-node-cli-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const endpointDirectory = path.join(root, 'endpoints');
    const registryPath = path.join(root, 'registries.json');
    await mkdir(endpointDirectory, { recursive: true });
    await writeFile(path.join(endpointDirectory, `${INSTANCE_ID}.json`), JSON.stringify(endpoint(api.port)), 'utf8');
    await writeFile(registryPath, JSON.stringify({
      schemaVersion: 1,
      registries: [{ channel: 'stable', profile: '', extensionHost: 'local', endpointDirectory, updatedAt: Date.now() }],
    }), 'utf8');
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runCli(['status', '--registry', registryPath, '--instance', INSTANCE_ID], {
      stdout: value => stdout.push(value),
      stderr: value => stderr.push(value),
    });
    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(JSON.parse(stdout[0])).toEqual({ items: [api.session] });
    expect(api.requests.map((request: any) => request.method)).toEqual([
      'orbit.handshake',
      'orbit.session.list',
      'orbit.connection.close',
    ]);
  });

  it('releases the handshake lease after an RPC error', async () => {
    const api = await startFakeApi();
    const root = await mkdtemp(path.join(tmpdir(), 'orbit-node-cli-close-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const endpointDirectory = path.join(root, 'endpoints');
    const registryPath = path.join(root, 'registries.json');
    await mkdir(endpointDirectory, { recursive: true });
    await writeFile(path.join(endpointDirectory, `${INSTANCE_ID}.json`), JSON.stringify(endpoint(api.port)), 'utf8');
    await writeFile(registryPath, JSON.stringify({
      schemaVersion: 1,
      registries: [{ channel: 'stable', profile: '', extensionHost: 'local', endpointDirectory, updatedAt: Date.now() }],
    }), 'utf8');
    await expect(runCli(
      ['write', '--registry', registryPath, '--instance', INSTANCE_ID, '--params', '{"assignments":[]}'],
      { stdout: () => undefined, stderr: () => undefined },
    )).rejects.toMatchObject({ data: { errorCode: 'InvalidRequest' } });
    expect(api.requests.map((request: { method: string }) => request.method)).toEqual([
      'orbit.handshake',
      'orbit.session.snapshot',
      'orbit.expression.writeMany',
      'orbit.connection.close',
    ]);
  });
});
