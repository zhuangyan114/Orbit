const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { mkdtemp, mkdir, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { afterEach, describe, it } = require('node:test');
const { enumerateInstances, selectInstance, OrbitClient } = require('../../clients/node/dist/index.js');
const { Client } = require('@modelcontextprotocol/sdk/client');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { createOrbitMcpAdapter, createMcpServer, TOOL_NAMES } = require('./orbit-mcp-server');

const INSTANCE_A = 'instance-a';
const INSTANCE_B = 'instance-b';
const PROJECT_ID = 'sha256:project-a';
const CONNECTION_ID = 'conn-a';
const SESSION_ID = 'session-a';

const cleanup = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(dispose => dispose()));
});

function sessionSnapshot(generation = 7) {
  return {
    sessionId: SESSION_ID,
    sessionGeneration: generation,
    registryGeneration: generation,
    name: 'fixture',
    type: 'orbit',
    phase: 'halted',
    targetState: 'halted',
    capabilities: [],
  };
}

function operationResult(id, data, extra = {}) {
  return {
    jsonrpc: '2.0',
    id,
    result: {
      requestId: id,
      instanceId: INSTANCE_A,
      projectId: PROJECT_ID,
      data,
      ...extra,
    },
  };
}

async function startFakeApi(handler, instanceId = INSTANCE_A) {
  const requests = [];
  const server = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        ok: true,
        status: 'ok',
        instanceId,
        projectId: PROJECT_ID,
        apiVersion: '1.0',
      }));
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/rpc') {
      response.writeHead(404).end();
      return;
    }
    const chunks = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push(body);
      const reply = handler(body, request);
      const payload = typeof reply === 'string' ? reply : JSON.stringify(reply);
      response.writeHead(200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      });
      response.end(payload);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake API did not bind');
  cleanup.push(() => new Promise(resolve => server.close(() => resolve())));
  return { port: address.port, requests };
}

function endpoint(port, instanceId = INSTANCE_A) {
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

async function writeRegistry(entries) {
  const root = await mkdtemp(path.join(tmpdir(), 'orbit-mcp-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const endpointDirectory = path.join(root, 'endpoints');
  const registryPath = path.join(root, 'registries.json');
  await mkdir(endpointDirectory, { recursive: true });
  for (const item of entries) {
    await writeFile(path.join(endpointDirectory, `${item.instanceId}.json`), JSON.stringify(item), 'utf8');
  }
  await writeFile(registryPath, JSON.stringify({
    schemaVersion: 1,
    registries: [{ channel: 'stable', profile: '', extensionHost: 'local', endpointDirectory, updatedAt: Date.now() }],
  }), 'utf8');
  return registryPath;
}

function defaultHandler(body) {
  const session = sessionSnapshot();
  if (body.method === 'orbit.handshake') {
    return operationResult(body.id, {
      connectionId: CONNECTION_ID,
      expiresAt: '1700000600000',
      grantedScopes: body.params.requestedScopes,
      instance: { instanceId: INSTANCE_A },
      project: { projectId: PROJECT_ID, registryGeneration: 7 },
      capabilities: { apiVersion: '1.0', capabilities: [] },
      session,
    });
  }
  if (body.method === 'orbit.session.list') {
    return operationResult(body.id, { items: [session] });
  }
  if (body.method === 'orbit.session.snapshot') {
    if (body.params.sessionId && body.params.sessionId !== SESSION_ID) {
      return {
        jsonrpc: '2.0',
        id: body.id,
        error: {
          code: -32012,
          message: 'SessionChanged',
          data: { errorCode: 'SessionChanged', expectedGeneration: 7, actualGeneration: 8, retryable: false },
        },
      };
    }
    return operationResult(body.id, session);
  }
  if (body.method === 'orbit.expression.readMany') {
    return operationResult(body.id, {
      items: (body.params.expressions || []).map(expression => ({
        expression,
        display: '1',
        exactValue: '1',
        available: true,
      })),
    });
  }
  if (body.method === 'orbit.expression.writeMany') {
    return operationResult(body.id, {
      operationId: 'op-write',
      items: (body.params.writes || []).map(write => ({
        expression: write.expression,
        written: true,
        value: write.value,
      })),
    }, { sessionId: SESSION_ID, sessionGeneration: 7 });
  }
  if (body.method === 'orbit.record.start') {
    return operationResult(body.id, { recordingId: 'record-a', name: body.params.name, channels: body.params.channels });
  }
  if (body.method === 'orbit.record.get') {
    return operationResult(body.id, body.params.cursor
      ? { recording: { recordingId: 'record-a' }, items: [{ frameId: 'frame-2', timestamp: '2' }] }
      : { recording: { recordingId: 'record-a' }, items: [{ frameId: 'frame-1', timestamp: '1' }], nextCursor: 'frame-1' });
  }
  if (body.method === 'orbit.record.stop' || body.method === 'orbit.record.clear') {
    return operationResult(body.id, { recordingId: 'record-a', stopped: true });
  }
  if (body.method === 'orbit.experiment.run') {
    return operationResult(body.id, { name: body.params.name, steps: body.params.steps });
  }
  if (body.method === 'orbit.memory.read') {
    return operationResult(body.id, { address: body.params.address, dataBase64: 'AQID', bytesRead: 3, unreadableBytes: 0 });
  }
  if (body.method === 'orbit.memory.write') {
    return operationResult(body.id, { address: body.params.address, bytesWritten: 3, verified: true, operationId: 'op-mem' });
  }
  if (body.method === 'orbit.target.pause') {
    if (body.params.context.sessionGeneration !== 7) {
      return {
        jsonrpc: '2.0',
        id: body.id,
        error: {
          code: -32012,
          message: 'SessionChanged',
          data: {
            errorCode: 'SessionChanged',
            expectedGeneration: body.params.context.sessionGeneration,
            actualGeneration: 7,
            retryable: false,
          },
        },
      };
    }
    return operationResult(body.id, { state: 'halted', operationId: 'op-pause' }, {
      sessionId: SESSION_ID,
      sessionGeneration: 7,
    });
  }
  if (body.method === 'orbit.breakpoints.list') {
    return operationResult(body.id, { items: [{ breakpointId: 'bp-1', source: { path: 'main.c', line: 10 }, enabled: true, verified: false }] });
  }
  if (body.method === 'orbit.breakpoints.add') {
    return operationResult(body.id, { breakpoint: { breakpointId: 'bp-1', ...body.params.breakpoint, enabled: true, verified: false } });
  }
  if (body.method === 'orbit.connection.close') {
    return operationResult(body.id, { connectionId: CONNECTION_ID, closed: true, releasedSubscriptions: 0 });
  }
  if (body.method === 'orbit.session.start') {
    return operationResult(body.id, { operationId: 'op-start', accepted: true });
  }
  if (body.method === 'orbit.project.describe') {
    return operationResult(body.id, { projectId: PROJECT_ID, workspaceFolders: ['C:\\project'] });
  }
  if (body.method === 'orbit.expression.evaluate') {
    return operationResult(body.id, { expression: body.params.expression, display: '1', exactValue: '1' });
  }
  if (body.method === 'orbit.diagnostics.snapshot') {
    return operationResult(body.id, { api: { version: '1.0' }, session: sessionSnapshot() });
  }
  return {
    jsonrpc: '2.0',
    id: body.id,
    error: {
      code: -32001,
      message: 'CapabilityUnavailable',
      data: { errorCode: 'CapabilityUnavailable', retryable: false },
    },
  };
}

function successData(result) {
  assert.notEqual(result.isError, true);
  assert.ok(result.structuredContent);
  return result.structuredContent;
}

describe('Orbit MCP adapter', () => {
  it('registers v1 tools including convenience status/read/write/record names', () => {
    for (const name of [
      'orbit_instances',
      'orbit_handshake',
      'orbit_session_list',
      'orbit_session_snapshot',
      'orbit_session_start',
      'orbit_session_stop',
      'orbit_target_pause',
      'orbit_target_continue',
      'orbit_target_reset',
      'orbit_target_step',
      'orbit_breakpoints_list',
      'orbit_breakpoints_add',
      'orbit_memory_read',
      'orbit_memory_write',
      'orbit_record_get',
      'orbit_status',
      'orbit_read_many',
      'orbit_write_many',
      'orbit_record',
      'orbit_experiment_run',
    ]) {
      assert.ok(TOOL_NAMES.includes(name), `missing tool ${name}`);
    }
  });

  it('lists instances without selecting a recent window', async () => {
    const apiA = await startFakeApi(defaultHandler, INSTANCE_A);
    const apiB = await startFakeApi(defaultHandler, INSTANCE_B);
    const registryPath = await writeRegistry([endpoint(apiA.port, INSTANCE_A), endpoint(apiB.port, INSTANCE_B)]);
    const adapter = createOrbitMcpAdapter({ registryPath });
    const listed = successData(await adapter.callTool('orbit_instances', { projectId: PROJECT_ID }));
    assert.deepEqual(listed.items.map(item => item.instanceId).sort(), [INSTANCE_A, INSTANCE_B]);
    assert.equal(listed.items.every(item => !('token' in item)), true);
  });

  it('rejects ambiguous mutation selection instead of picking the latest window', async () => {
    const apiA = await startFakeApi(defaultHandler, INSTANCE_A);
    const apiB = await startFakeApi(defaultHandler, INSTANCE_B);
    const registryPath = await writeRegistry([endpoint(apiA.port, INSTANCE_A), endpoint(apiB.port, INSTANCE_B)]);
    const adapter = createOrbitMcpAdapter({ registryPath });
    const result = await adapter.callTool('orbit_target_pause', {
      projectId: PROJECT_ID,
      idempotencyKey: 'pause-1',
    });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.errorCode, 'AmbiguousInstance');
    assert.deepEqual(result.structuredContent.candidates, [INSTANCE_A, INSTANCE_B]);
    assert.deepEqual(apiA.requests, []);
    assert.deepEqual(apiB.requests, []);
  });

  it('maps orbit_status through a handshake and session list', async () => {
    const api = await startFakeApi(defaultHandler);
    const registryPath = await writeRegistry([endpoint(api.port)]);
    let n = 0;
    const adapter = createOrbitMcpAdapter({
      registryPath,
      requestId: () => `req-${++n}`,
    });
    const data = successData(await adapter.callTool('orbit_status', { instanceId: INSTANCE_A }));
    assert.equal(data.items[0].sessionId, SESSION_ID);
    assert.deepEqual(api.requests.map(request => request.method), [
      'orbit.handshake',
      'orbit.session.list',
      'orbit.connection.close',
    ]);
    assert.ok(api.requests[0].params.requestedScopes.includes('read'));
  });

  it('maps orbit_read_many / orbit_write_many over Automation API v1', async () => {
    const api = await startFakeApi(defaultHandler);
    const registryPath = await writeRegistry([endpoint(api.port)]);
    const adapter = createOrbitMcpAdapter({ registryPath });
    const read = successData(await adapter.callTool('orbit_read_many', {
      instanceId: INSTANCE_A,
      expressions: ['cnt'],
    }));
    assert.equal(read.items[0].expression, 'cnt');
    const written = successData(await adapter.callTool('orbit_write_many', {
      instanceId: INSTANCE_A,
      idempotencyKey: 'write-1',
      writes: [{ expression: 'cnt', value: 3 }],
    }));
    assert.deepEqual(written.items[0], { expression: 'cnt', written: true, value: '3' });
    assert.deepEqual(api.requests.map(request => request.method), [
      'orbit.handshake',
      'orbit.session.snapshot',
      'orbit.expression.readMany',
      'orbit.connection.close',
      'orbit.handshake',
      'orbit.session.snapshot',
      'orbit.expression.writeMany',
      'orbit.connection.close',
    ]);
    assert.equal(
      api.requests.find(request => request.method === 'orbit.expression.writeMany').params.writes[0].value,
      '3',
    );
  });

  it('paginates orbit_record instead of returning a single unbounded page', async () => {
    const api = await startFakeApi(defaultHandler);
    const registryPath = await writeRegistry([endpoint(api.port)]);
    const adapter = createOrbitMcpAdapter({
      registryPath,
      delay: async () => undefined,
    });
    const recording = successData(await adapter.callTool('orbit_record', {
      instanceId: INSTANCE_A,
      idempotencyKey: 'record-1',
      durationMs: 10,
      intervalMs: 5,
      channels: [{ alias: 'cnt', expression: 'cnt' }],
    }));
    assert.deepEqual(recording.items.map(item => item.frameId), ['frame-1', 'frame-2']);
    assert.deepEqual(api.requests.map(request => request.method), [
      'orbit.handshake',
      'orbit.session.snapshot',
      'orbit.record.start',
      'orbit.record.get',
      'orbit.record.get',
      'orbit.record.stop',
      'orbit.record.clear',
      'orbit.connection.close',
    ]);
    assert.deepEqual(
      api.requests.filter(request => request.method === 'orbit.record.get').map(request => request.params.cursor),
      [undefined, 'frame-1'],
    );
  });

  it('returns SessionChanged as structured JSON and does not retry the mutation', async () => {
    const api = await startFakeApi(defaultHandler);
    const registryPath = await writeRegistry([endpoint(api.port)]);
    const adapter = createOrbitMcpAdapter({ registryPath });
    const result = await adapter.callTool('orbit_target_pause', {
      instanceId: INSTANCE_A,
      sessionId: SESSION_ID,
      sessionGeneration: 3,
      idempotencyKey: 'pause-stale',
    });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.errorCode, 'SessionChanged');
    assert.equal(result.structuredContent.expectedGeneration, 3);
    assert.equal(result.structuredContent.actualGeneration, 7);
    assert.equal(result.structuredContent.retryable, false);
    assert.equal(JSON.parse(result.content[0].text).errorCode, 'SessionChanged');
    assert.equal(api.requests.filter(request => request.method === 'orbit.target.pause').length, 1);
  });

  it('returns capability/scope denial as structured JSON, not a text success', async () => {
    const api = await startFakeApi(body => {
      if (body.method === 'orbit.handshake') {
        return operationResult(body.id, {
          connectionId: CONNECTION_ID,
          expiresAt: '1700000600000',
          grantedScopes: ['read'],
          instance: { instanceId: INSTANCE_A },
          project: { projectId: PROJECT_ID, registryGeneration: 7 },
          capabilities: { apiVersion: '1.0', capabilities: [] },
          session: sessionSnapshot(),
        });
      }
      return {
        jsonrpc: '2.0',
        id: body.id,
        error: {
          code: -32001,
          message: 'CapabilityUnavailable',
          data: { errorCode: 'CapabilityUnavailable', retryable: false, requiredScope: 'session.control' },
        },
      };
    });
    const registryPath = await writeRegistry([endpoint(api.port)]);
    const adapter = createOrbitMcpAdapter({ registryPath });
    const result = await adapter.callTool('orbit_session_start', {
      instanceId: INSTANCE_A,
      configurationId: 'orbit-jlink',
      idempotencyKey: 'start-1',
    });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.errorCode, 'CapabilityUnavailable');
    assert.equal(result.structuredContent.requiredScope, 'session.control');
  });

  it('maps orbit_experiment_run onto orbit.experiment.run', async () => {
    const api = await startFakeApi(defaultHandler);
    const registryPath = await writeRegistry([endpoint(api.port)]);
    const adapter = createOrbitMcpAdapter({ registryPath });
    const report = successData(await adapter.callTool('orbit_experiment_run', {
      instanceId: INSTANCE_A,
      idempotencyKey: 'exp-1',
      name: 'trial',
      timeoutMs: 1000,
      steps: [
        { type: 'read', signals: [{ expression: 'cnt' }] },
        { type: 'write', writes: [{ expression: 'cnt', value: 4 }] },
        { type: 'wait', durationMs: 5 },
      ],
    }));
    const experiment = api.requests.find(request => request.method === 'orbit.experiment.run');
    assert.deepEqual(experiment.params.steps, [
      { kind: 'read', expression: 'cnt' },
      { kind: 'write', expression: 'cnt', value: '4' },
      { kind: 'wait', durationMs: 5 },
    ]);
    assert.equal(report.name, 'trial');
  });

  it('advertises required arrays for every tool input schema', async () => {
    const { server } = createMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'wire-probe', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const result = await client.listTools();
      assert.ok(result.tools.length >= TOOL_NAMES.length);
      for (const tool of result.tools) {
        assert.ok(
          Array.isArray(tool.inputSchema?.required),
          `${tool.name}: inputSchema.required must be an array, got ${JSON.stringify(tool.inputSchema?.required)}`,
        );
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('does not implement its own RPC envelope or endpoint parser', async () => {
    const registryPath = await writeRegistry([endpoint(1)]);
    const adapter = createOrbitMcpAdapter({
      registryPath,
      enumerateInstances,
      selectInstance,
      createClient: selected => new OrbitClient(selected),
    });
    assert.equal(adapter.usesNodeClient, true);
    assert.equal(typeof adapter.readEndpoint, 'undefined');
    assert.equal(typeof adapter.callOrbit, 'undefined');
  });
});
