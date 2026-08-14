import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const configuration = vi.hoisted(() => ({ allowedScopes: ['read'] as string[] }));

vi.mock('vscode', () => ({
  env: { appName: 'Visual Studio Code', remoteName: undefined },
  workspace: {
    workspaceFolders: [],
    workspaceFile: undefined,
    getConfiguration: () => ({
      get: (key: string, fallback: unknown) => (
        key === 'automation.allowedScopes' ? configuration.allowedScopes : fallback
      ),
    }),
  },
}));

import { PluginApiServer, PluginApiServerOptions } from './plugin-api-server';
import { EventHub } from './event-hub';

interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

class TestRegistry {
  private bound: import('./instance-registry').BoundServerInfo | undefined;
  disposed = false;

  async start(bound: import('./instance-registry').BoundServerInfo) {
    this.bound = bound;
    return this.describe();
  }

  getInstanceId() { return 'instance-test'; }
  getProjectId() { return 'sha256:project-test'; }
  getRegistryGeneration() { return 0; }

  describe() {
    const port = this.bound?.port ?? 0;
    return {
      instanceId: this.getInstanceId(),
      version: '1.1.0',
      channel: 'stable',
      processId: process.pid,
      startedAt: '1',
      workspaceFolders: [],
      endpoint: {
        schemaVersion: 1 as const,
        host: '127.0.0.1',
        port,
        rpcUrl: `http://127.0.0.1:${port}/v1/rpc`,
        eventsUrl: `http://127.0.0.1:${port}/v1/events`,
        healthUrl: `http://127.0.0.1:${port}/health`,
        apiVersions: ['1.0'],
      },
    };
  }

  getProjectDescription() {
    return {
      projectId: this.getProjectId(),
      workspaceFolders: [],
      elfFiles: [],
      launchConfigurations: [],
      registryGeneration: 0,
    };
  }

  getCapabilitySnapshot() {
    return { apiVersion: '1.0', capabilities: [] };
  }

  async dispose() { this.disposed = true; }
}

function inertServices() {
  return {
    sessionService: {} as never,
    breakpointService: {} as never,
    runtimeService: {} as never,
    memoryService: {} as never,
    viewStateService: { dispose() {} } as never,
    recordingService: { dispose() {}, stats: () => ({}) } as never,
    rttService: {} as never,
    diagnosticsService: {} as never,
  };
}

async function request(port: number, options: http.RequestOptions, body?: string | Buffer): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, ...options }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(Buffer.from(chunk)));
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

describe('PluginApiServer HTTP security', () => {
  const servers: PluginApiServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => server.dispose()));
  });

  async function startServer(options: Partial<PluginApiServerOptions> = {}, execute?: (command: unknown) => Promise<any>) {
    const registry = new TestRegistry();
    const backend = { execute: vi.fn(execute ?? (async () => ({ ok: true, data: 'halted' }))) };
    const server = new PluginApiServer(
      { globalStorageUri: { fsPath: 'C:\\orbit-test' }, extension: { packageJSON: { version: '1.1.0' } } } as never,
      backend as never,
      { registry: registry as never, ...inertServices(), ...options },
    );
    servers.push(server);
    const endpoint = await server.start();
    return { server, endpoint, registry, backend };
  }

  it('does not grant browser CORS access by default', async () => {
    const { endpoint } = await startServer();
    const response = await request(endpoint.port, {
      method: 'GET',
      path: '/health',
      headers: { origin: 'http://127.0.0.1:3000' },
    });

    expect(response.status).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('resets a shared event hub when a new API instance starts', async () => {
    const eventHub = new EventHub({
      instanceId: () => 'instance-test',
      projectId: () => 'sha256:project-test',
    });
    eventHub.publish('session.started', { sessionId: 'old-session' });

    await startServer({ eventHub });

    expect(eventHub.eventCount()).toBe(0);
    expect(eventHub.publish('session.started', { sessionId: 'new-session' }).eventId)
      .toBe('0000000000000001');
  });

  it('requires the exact bearer token on every v1 RPC request', async () => {
    const { endpoint } = await startServer();
    const body = JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'orbit.instance.describe',
      params: { context: { instanceId: 'instance-test', projectId: 'sha256:project-test' } },
    });
    const missing = await request(endpoint.port, { method: 'POST', path: '/v1/rpc' }, body);
    const wrong = await request(endpoint.port, {
      method: 'POST', path: '/v1/rpc', headers: { authorization: 'Bearer wrong' },
    }, body);
    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
  });

  it('keeps health output non-sensitive', async () => {
    const { endpoint } = await startServer();
    const response = await request(endpoint.port, { method: 'GET', path: '/health' });
    const payload = JSON.parse(response.body) as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ ok: true, instanceId: 'instance-test', projectId: 'sha256:project-test' });
    expect(JSON.stringify(payload)).not.toContain(endpoint.token);
    expect(payload).not.toHaveProperty('rpcUrl');
    expect(payload).not.toHaveProperty('workspaceFolders');
  });

  it('rejects an oversized body from Content-Length without waiting for upload', async () => {
    const { endpoint } = await startServer();
    const response = await request(endpoint.port, {
      method: 'POST', path: '/v1/rpc',
      headers: {
        authorization: `Bearer ${endpoint.token}`,
        'content-length': String(1024 * 1024 + 1),
      },
    });
    expect(response.status).toBe(413);
  });

  it('rejects invalid UTF-8 before JSON parsing can replace bytes', async () => {
    const { endpoint } = await startServer();
    const bytes = Buffer.concat([
      Buffer.from('{"jsonrpc":"2.0","id":1,"method":"orbit.'),
      Buffer.from([0xc3]),
      Buffer.from('","params":{}}'),
    ]);
    const response = await request(endpoint.port, {
      method: 'POST', path: '/v1/rpc', headers: { authorization: `Bearer ${endpoint.token}` },
    }, bytes);
    expect(response.status).toBe(400);
    expect(response.body).toContain('UTF-8');
  });

  it('returns a JSON-RPC ParseError for malformed JSON', async () => {
    const { endpoint } = await startServer();
    const response = await request(endpoint.port, {
      method: 'POST', path: '/v1/rpc', headers: { authorization: `Bearer ${endpoint.token}` },
    }, '{');
    const payload = JSON.parse(response.body) as any;
    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ jsonrpc: '2.0', id: null });
    expect(payload.error.data.errorCode).toBe('ParseError');
  });

  it('recovers after a client aborts a partial upload', async () => {
    const { server, endpoint } = await startServer({ bodyTimeoutMs: 100 });
    await new Promise<void>(resolve => {
      const req = http.request({
        host: '127.0.0.1', port: endpoint.port, method: 'POST', path: '/v1/rpc',
        headers: { authorization: `Bearer ${endpoint.token}` },
      });
      req.on('error', () => resolve());
      req.write('{');
      setTimeout(() => req.destroy(), 5);
    });
    const health = await request(endpoint.port, { method: 'GET', path: '/health' });
    expect(health.status).toBe(200);
    await expect(server.dispose()).resolves.toBeUndefined();
  });

  it('times out a slow request body and closes the upload boundary', async () => {
    const { endpoint } = await startServer({ bodyTimeoutMs: 30 } as Partial<PluginApiServerOptions>);
    const response = await new Promise<HttpResult>((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: endpoint.port, method: 'POST', path: '/v1/rpc',
        headers: { authorization: `Bearer ${endpoint.token}` },
      }, res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(Buffer.from(chunk)));
        res.on('end', () => {
          clearTimeout(safety);
          req.destroy();
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      });
      const safety = setTimeout(() => {
        req.destroy();
        reject(new Error('slow upload was not bounded'));
      }, 250);
      req.on('error', error => {
        clearTimeout(safety);
        reject(error);
      });
      req.write('{');
    });
    expect(response.status).toBe(408);
  });

  it('uses the real handshake policy to trim and confirm configured scopes', async () => {
    configuration.allowedScopes = ['read'];
    const { endpoint } = await startServer();
    const response = await request(endpoint.port, {
      method: 'POST', path: '/v1/rpc', headers: { authorization: `Bearer ${endpoint.token}` },
    }, JSON.stringify({
      jsonrpc: '2.0', id: 'handshake-1', method: 'orbit.handshake',
      params: {
        context: { instanceId: 'instance-test', projectId: 'sha256:project-test' },
        apiVersion: '1.0',
        client: { name: 'server-test' },
        expected: { instanceId: 'instance-test', projectId: 'sha256:project-test' },
        requestedScopes: ['read', 'session.control'],
      },
    }));
    const payload = JSON.parse(response.body) as any;
    expect(payload.result.data.grantedScopes).toEqual(['read']);
    expect(payload.result.data.connectionId).toMatch(/^conn_/);
  });

  it('honors an explicitly empty allowedScopes policy without granting read', async () => {
    configuration.allowedScopes = [];
    const { endpoint } = await startServer();
    const response = await request(endpoint.port, {
      method: 'POST', path: '/v1/rpc', headers: { authorization: `Bearer ${endpoint.token}` },
    }, JSON.stringify({
      jsonrpc: '2.0', id: 'handshake-deny-all', method: 'orbit.handshake',
      params: {
        context: { instanceId: 'instance-test', projectId: 'sha256:project-test' },
        apiVersion: '1.0', client: { name: 'server-test' },
        expected: { projectId: 'sha256:project-test' },
        requestedScopes: ['read'],
      },
    }));
    const payload = JSON.parse(response.body) as any;
    expect(payload.result.data.grantedScopes).toEqual([]);
  });

  it('adds deprecation metadata to legacy responses and rejects new v1 methods', async () => {
    const { endpoint } = await startServer();
    const headers = { authorization: `Bearer ${endpoint.token}` };
    const legacy = await request(endpoint.port, { method: 'POST', path: '/rpc', headers }, JSON.stringify({
      id: 'legacy-1', method: 'ozone.status', params: {},
    }));
    const forbidden = await request(endpoint.port, { method: 'POST', path: '/rpc', headers }, JSON.stringify({
      id: 'legacy-2', method: 'orbit.target.continue', params: {},
    }));
    expect(JSON.parse(legacy.body)).toMatchObject({
      id: 'legacy-1', ok: true,
      deprecation: { deprecated: true, replacement: '/v1/rpc' },
    });
    expect(JSON.parse(forbidden.body)).toMatchObject({ id: 'legacy-2', ok: false });
  });

  it('adds deprecation metadata to every exact legacy RPC error response only', async () => {
    const { endpoint } = await startServer({ bodyTimeoutMs: 20, shutdownTimeoutMs: 10 });
    const authorized = { authorization: `Bearer ${endpoint.token}` };
    const within = <T>(label: string, pending: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} request was not bounded`)), 300);
      void pending.then(
        value => { clearTimeout(timer); resolve(value); },
        error => { clearTimeout(timer); reject(error); },
      );
    });
    const unauthorized = await within('unauthorized', request(endpoint.port, { method: 'POST', path: '/rpc' }, '{}'));
    const invalidUtf8Body = Buffer.concat([
      Buffer.from('{"id":"legacy-utf8","method":"ozone.'),
      Buffer.from([0xc3]),
      Buffer.from('","params":{}}'),
    ]);
    const invalidUtf8 = await within('invalid UTF-8', request(endpoint.port, {
      method: 'POST', path: '/rpc', headers: authorized,
    }, invalidUtf8Body));
    const invalidJson = await within('invalid JSON', request(endpoint.port, {
      method: 'POST', path: '/rpc', headers: authorized,
    }, '{'));
    const handlerFailure = await within('handler failure', request(endpoint.port, {
      method: 'POST', path: '/rpc', headers: authorized,
    }, JSON.stringify({ id: 'legacy-failure', method: 'orbit.target.continue', params: {} })));
    const slowUpload = await new Promise<HttpResult>((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: endpoint.port, method: 'POST', path: '/rpc', headers: authorized,
      }, res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(Buffer.from(chunk)));
        res.on('end', () => {
          clearTimeout(safety);
          req.destroy();
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      });
      const safety = setTimeout(() => {
        req.destroy();
        reject(new Error('legacy slow upload was not bounded'));
      }, 250);
      req.on('error', error => {
        clearTimeout(safety);
        reject(error);
      });
      req.write('{');
    });
    const v1Unauthorized = await request(endpoint.port, { method: 'POST', path: '/v1/rpc' }, '{}');
    const notFound = await request(endpoint.port, { method: 'GET', path: '/rpc' });
    const oversized = await within('oversized', request(endpoint.port, {
      method: 'POST', path: '/rpc',
      headers: { ...authorized, 'content-length': String(1024 * 1024 + 1) },
    }));

    for (const response of [unauthorized, oversized, invalidUtf8, invalidJson, handlerFailure, slowUpload]) {
      expect(JSON.parse(response.body)).toMatchObject({
        ok: false,
        deprecation: { deprecated: true, replacement: '/v1/rpc' },
      });
    }

    expect(JSON.parse(v1Unauthorized.body)).not.toHaveProperty('deprecation');
    expect(JSON.parse(notFound.body)).not.toHaveProperty('deprecation');
  });

  it('bounds legacy handlers and safely consumes a late rejection', async () => {
    let rejectHandler!: (error: Error) => void;
    const handler = new Promise<never>((_, reject) => { rejectHandler = reject; });
    const { endpoint } = await startServer(
      { legacyHandlerTimeoutMs: 20, shutdownTimeoutMs: 10 },
      async () => handler,
    );
    const pending = request(endpoint.port, {
      method: 'POST', path: '/rpc', headers: { authorization: `Bearer ${endpoint.token}` },
    }, JSON.stringify({ id: 'legacy-timeout', method: 'ozone.status', params: {} }));

    const response = await Promise.race([
      pending,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('legacy handler was not bounded')), 200)),
    ]);
    expect(JSON.parse(response.body)).toMatchObject({
      id: 'legacy-timeout',
      ok: false,
      deprecation: { deprecated: true, replacement: '/v1/rpc' },
    });
    expect(JSON.parse(response.body).error).toMatch(/timed out/i);

    rejectHandler(new Error('late handler failure'));
    await new Promise(resolve => setTimeout(resolve, 10));
  });

  it('retains a timed-out legacy mutation id until the underlying handler settles', async () => {
    let releaseFirst!: (result: { ok: true; data: boolean }) => void;
    const firstHandler = new Promise<{ ok: true; data: boolean }>(resolve => { releaseFirst = resolve; });
    const execute = vi.fn(() => (
      execute.mock.calls.length === 1
        ? firstHandler
        : Promise.resolve({ ok: true as const, data: true })
    ));
    const { endpoint } = await startServer(
      { legacyHandlerTimeoutMs: 20, shutdownTimeoutMs: 10 },
      execute,
    );
    const headers = { authorization: `Bearer ${endpoint.token}` };
    const body = JSON.stringify({
      id: 'legacy-write-timeout',
      method: 'ozone.expr.writeMany',
      params: { writes: [{ expression: 'counter', value: 1 }] },
    });

    const timedOut = await request(endpoint.port, { method: 'POST', path: '/rpc', headers }, body);
    expect(JSON.parse(timedOut.body)).toMatchObject({
      id: 'legacy-write-timeout',
      ok: false,
      outcomeUnknown: true,
      deprecation: { deprecated: true, replacement: '/v1/rpc' },
    });

    const duplicate = await request(endpoint.port, { method: 'POST', path: '/rpc', headers }, body);
    expect(JSON.parse(duplicate.body)).toMatchObject({ id: 'legacy-write-timeout', ok: false });
    expect(JSON.parse(duplicate.body).error).toMatch(/already in flight/i);
    expect(execute).toHaveBeenCalledTimes(1);

    releaseFirst({ ok: true, data: true });
    await firstHandler;
    await Promise.resolve();

    const afterSettlement = await request(endpoint.port, { method: 'POST', path: '/rpc', headers }, body);
    expect(JSON.parse(afterSettlement.body)).toMatchObject({ id: 'legacy-write-timeout', ok: true });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('rejects a duplicate request id while the first handler is still in flight', async () => {
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const { endpoint } = await startServer({}, async () => {
      entered();
      await blocked;
      return { ok: true, data: 'halted' };
    });
    const headers = { authorization: `Bearer ${endpoint.token}` };
    const body = JSON.stringify({ id: 'same-id', method: 'ozone.status', params: {} });
    const first = request(endpoint.port, { method: 'POST', path: '/rpc', headers }, body);
    await enteredPromise;
    const second = request(endpoint.port, { method: 'POST', path: '/rpc', headers }, body);
    const duplicate = await Promise.race([
      second,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('duplicate id was not bounded')), 150)),
    ]).finally(release);
    await first;
    expect(JSON.parse(duplicate.body)).toMatchObject({ id: 'same-id', ok: false });
    expect(JSON.parse(duplicate.body).error).toMatch(/already in flight/i);
  });

  it('waits for in-flight reads before removing discovery state on dispose', async () => {
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const { server, endpoint, registry } = await startServer({}, async () => {
      entered();
      await blocked;
      return { ok: true, data: 'halted' };
    });
    const pendingRead = request(endpoint.port, {
      method: 'POST', path: '/rpc', headers: { authorization: `Bearer ${endpoint.token}` },
    }, JSON.stringify({ id: 'read-before-dispose', method: 'ozone.status', params: {} }));
    await enteredPromise;
    const disposing = server.dispose();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(registry.disposed).toBe(false);
    release();
    await Promise.all([pendingRead, disposing]);
    expect(registry.disposed).toBe(true);
  });
});

describe('Automation API configuration', () => {
  it('is disabled by default and grants only read scope by default', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as any;
    const properties = packageJson.contributes.configuration.properties;
    expect(properties['orbit.automation.enabled']).toMatchObject({ type: 'boolean', default: false });
    expect(properties['orbit.automation.allowedScopes']).toMatchObject({
      type: 'array',
      default: ['read'],
    });
    expect(properties['orbit.automation.allowedScopes'].items).toMatchObject({ type: 'string' });
  });
});
