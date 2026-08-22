import * as http from 'http';
import * as net from 'net';
import { PassThrough, Writable } from 'stream';
import { afterEach, describe, expect, it } from 'vitest';
import { cliArgsToSessionCommand, runSession, runSessionCli } from '../src/session';
import { resolveCommandSpec } from '../src/cli';
import type { OrbitEndpoint } from '../src/index';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';

const INSTANCE_ID = 'instance-a';
const PROJECT_ID = 'sha256:project-a';
const CONNECTION_ID = 'conn-a';
const SESSION_ID = 'session-a';
const GRANTED_SCOPES = ['read', 'session.control', 'breakpoints.write', 'variables.write', 'record'];

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(dispose => dispose()));
});

function operationResult(id: string, data: unknown) {
  return {
    jsonrpc: '2.0',
    id,
    result: { requestId: id, instanceId: INSTANCE_ID, projectId: PROJECT_ID, data },
  };
}

function rpcError(id: string, code: number, message: string, data: Record<string, unknown>) {
  return { jsonrpc: '2.0', id, error: { code, message, data } };
}

function respond(response: http.ServerResponse, body: unknown): void {
  const responseBody = JSON.stringify(body);
  response.writeHead(200, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(responseBody),
  });
  response.end(responseBody);
}

interface FakeApi {
  port: number;
  requests: unknown[];
}

// A focused fake API for the long-lived session router. Unlike the client
// harness, the handshake here omits the `session` field so the lazy-refresh
// path is exercised; `orbit.session.start` is what populates the session.
async function startFakeApi(options: { failContinueOnce?: boolean } = {}): Promise<FakeApi> {
  const requests: unknown[] = [];
  let continueCalls = 0;
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
      respond(response, { ok: true, status: 'ok', instanceId: INSTANCE_ID, projectId: PROJECT_ID, apiVersion: '1.0' });
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/rpc') {
      response.writeHead(404).end();
      return;
    }
    if (request.headers.authorization !== 'Bearer token-a') {
      const body = JSON.stringify({ ok: false, error: 'Unauthorized' });
      response.writeHead(401, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      response.end(body);
      return;
    }
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id: string; method: string };
      requests.push(body);
      if (body.method === 'orbit.handshake') {
        respond(response, operationResult(body.id, {
          connectionId: CONNECTION_ID,
          expiresAt: '1700000600000',
          grantedScopes: GRANTED_SCOPES,
          instance: { instanceId: INSTANCE_ID },
          project: { projectId: PROJECT_ID, registryGeneration: 7 },
          capabilities: { apiVersion: '1.0', capabilities: [] },
        }));
      } else if (body.method === 'orbit.session.start' || body.method === 'orbit.session.snapshot') {
        respond(response, operationResult(body.id, session));
      } else if (body.method === 'orbit.session.list') {
        respond(response, operationResult(body.id, { items: [session] }));
      } else if (body.method === 'orbit.target.continue') {
        if (options.failContinueOnce && continueCalls++ === 0) {
          respond(response, rpcError(body.id, -32016, 'SessionChanged', {
            errorCode: 'SessionChanged',
            retryable: true,
            expectedGeneration: 7,
            actualGeneration: 8,
          }));
        } else {
          respond(response, operationResult(body.id, { continued: true }));
        }
      } else if (body.method === 'orbit.target.stepInto' || body.method === 'orbit.target.stepOut') {
        respond(response, operationResult(body.id, { stepped: true }));
      } else if (body.method === 'orbit.target.pause') {
        respond(response, rpcError(body.id, -32015, 'TargetNotHalted', { errorCode: 'TargetNotHalted', retryable: false }));
      } else if (body.method === 'orbit.connection.close') {
        respond(response, operationResult(body.id, { closed: true, releasedSubscriptions: 0 }));
      } else {
        response.writeHead(500).end();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake API did not bind');
  cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  return { port: address.port, requests };
}

function endpoint(port: number): OrbitEndpoint {
  return {
    schemaVersion: 1,
    instanceId: INSTANCE_ID,
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

function outputSink(): { stream: Writable; text: () => string } {
  let buffer = '';
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      buffer += chunk.toString();
      callback();
    },
  });
  return { stream, text: () => buffer };
}

const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

async function driveSession(
  commands: object[],
  options: { failContinueOnce?: boolean } = {},
): Promise<{ exitCode: number; results: Array<Record<string, unknown>>; requests: unknown[] }> {
  const api = await startFakeApi(options);
  const input = new PassThrough();
  for (const command of commands) input.write(`${JSON.stringify(command)}\n`);
  input.end();
  const out = outputSink();
  const exitCode = await runSession([], {
    endpoint: endpoint(api.port),
    input,
    output: out.stream,
  });
  await flush();
  const results = out.text().split('\n').filter(line => line.length > 0).map(line => JSON.parse(line) as Record<string, unknown>);
  return { exitCode, results, requests: api.requests };
}

describe('orbit-automation-session (long-lived router)', () => {
  it('reuses one handshake across many commands and closes the connection last', async () => {
    const { exitCode, results, requests } = await driveSession([
      { command: 'start' },
      { command: 'continue' },
      { command: 'step', action: 'into' },
      { command: 'step', action: 'out' },
      { command: 'status' },
    ]);

    expect(exitCode).toBe(0);
    // ready, start, continue, stepInto, stepOut, status, close = 7 result lines.
    expect(results).toHaveLength(7);
    expect(results[0]).toEqual({ ok: true, data: { event: 'ready', connectionId: CONNECTION_ID, grantedScopes: GRANTED_SCOPES, session: null } });
    expect(results.at(-1)).toEqual({ ok: true, data: { closed: true, interrupted: false } });
    // Exactly one handshake; `start` populates the session so later target ops skip the lazy refresh.
    expect(requests.map((request: { method: string }) => request.method)).toEqual([
      'orbit.handshake',
      'orbit.session.start',
      'orbit.target.continue',
      'orbit.target.stepInto',
      'orbit.target.stepOut',
      'orbit.session.list',
      'orbit.connection.close',
    ]);
  });

  it('calls orbit.connection.close on quit and reports the closed flag', async () => {
    const { exitCode, results, requests } = await driveSession([
      { command: 'start' },
      { command: 'quit' },
    ]);

    expect(exitCode).toBe(0);
    expect(requests.map((request: { method: string }) => request.method)).toEqual([
      'orbit.handshake',
      'orbit.session.start',
      'orbit.connection.close',
    ]);
    expect(results.at(-1)).toEqual({ ok: true, data: { closed: true, interrupted: false } });
  });

  it('lazily refreshes the session before the first target op when none was captured', async () => {
    const { exitCode, requests } = await driveSession([
      { command: 'continue' },
    ]);

    expect(exitCode).toBe(0);
    // No session from handshake/start, so the first targetMutation op runs session.list + snapshot first.
    expect(requests.map((request: { method: string }) => request.method)).toEqual([
      'orbit.handshake',
      'orbit.session.list',
      'orbit.session.snapshot',
      'orbit.target.continue',
      'orbit.connection.close',
    ]);
  });

  it('recovers from a SessionChanged error by refreshing and retrying once', async () => {
    const { exitCode, results, requests } = await driveSession(
      [{ command: 'start' }, { command: 'continue' }],
      { failContinueOnce: true },
    );

    expect(exitCode).toBe(0);
    // start captures the session; the cached sessionId is reused for the recovery snapshot (no session.list).
    expect(requests.map((request: { method: string }) => request.method)).toEqual([
      'orbit.handshake',
      'orbit.session.start',
      'orbit.target.continue',
      'orbit.session.snapshot',
      'orbit.target.continue',
      'orbit.connection.close',
    ]);
    // ready, start, continue (retried ok), close = 4 result lines.
    expect(results).toHaveLength(4);
    expect(results[2]).toEqual({ ok: true, data: { continued: true } });
  });

  it('keeps the loop alive after an RPC error and serves the next command', async () => {
    const { exitCode, results } = await driveSession([
      { command: 'start' },
      { command: 'pause' },
      { command: 'status' },
    ]);

    expect(exitCode).toBe(0);
    // ready, start, pause(error), status(ok), close = 5 result lines.
    expect(results).toHaveLength(5);
    expect(results[2].ok).toBe(false);
    expect(results[2].errorCode).toBe('TargetNotHalted');
    expect(results[2].code).toBe(-32015);
    expect(results[3].ok).toBe(true);
  });

  it('resolves step/breakpoints/record action fan-out via resolveCommandSpec', () => {
    expect(resolveCommandSpec('step', 'out')).toEqual({
      method: 'orbit.target.stepOut',
      context: 'targetMutation',
      scopes: ['read', 'session.control'],
    });
    expect(resolveCommandSpec('breakpoints', 'add')).toEqual({
      method: 'orbit.breakpoints.add',
      context: 'connectionMutation',
      scopes: ['read', 'breakpoints.write'],
    });
    expect(resolveCommandSpec('record', 'start')).toEqual({
      method: 'orbit.record.start',
      context: 'targetMutation',
      scopes: ['read', 'record'],
    });
    expect(resolveCommandSpec('status', '')).toEqual({
      method: 'orbit.session.list',
      context: 'connection',
      scopes: ['read'],
    });
  });
});

describe('orbit-automation-session git-style verbs', () => {
  it('maps one-shot argv into a session command object', () => {
    expect(cliArgsToSessionCommand(['status'])).toEqual({ command: 'status', params: {} });
    expect(cliArgsToSessionCommand(['start', 'Orbit: J-Link (Flash)'])).toEqual({
      command: 'start',
      params: { configurationId: 'Orbit: J-Link (Flash)' },
    });
    expect(cliArgsToSessionCommand(['step', '1', '--action', 'out'])).toEqual({
      command: 'step',
      action: 'out',
      params: { threadId: 1 },
    });
    expect(cliArgsToSessionCommand(['read', 'aww', 'ass'])).toEqual({
      command: 'read',
      params: { expressions: ['aww', 'ass'] },
    });
    expect(cliArgsToSessionCommand(['breakpoints', 'add', '--params', '{"breakpoint":{"source":{"path":"a.c","line":1}}}'])).toEqual({
      command: 'breakpoints',
      action: 'add',
      params: { breakpoint: { source: { path: 'a.c', line: 1 } } },
    });
    expect(cliArgsToSessionCommand(['quit'])).toEqual({ command: 'quit' });
  });

  it('connects once then reuses the handshake for later verb invocations', async () => {
    const api = await startFakeApi();
    const home = await mkdtemp(path.join(tmpdir(), 'orbit-session-cli-'));
    cleanup.push(() => rm(home, { recursive: true, force: true }));
    const collected: string[] = [];
    const io = { stdout: (value: string) => collected.push(value), stderr: () => undefined };
    const sessionOpts = { endpoint: endpoint(api.port), stateDir: home };

    expect(await runSessionCli(['connect'], io, sessionOpts)).toBe(0);
    const ready = JSON.parse(collected.at(-1) ?? '{}') as { data?: { event?: string; connectionId?: string } };
    expect(ready.data?.event).toBe('ready');
    expect(ready.data?.connectionId).toBe(CONNECTION_ID);

    collected.length = 0;
    expect(await runSessionCli(['start'], io, sessionOpts)).toBe(0);
    expect(await runSessionCli(['continue'], io, sessionOpts)).toBe(0);
    expect(await runSessionCli(['quit'], io, sessionOpts)).toBe(0);
    expect(JSON.parse(collected.at(-1) ?? '{}')).toMatchObject({ ok: true, data: { closed: true } });
    expect(api.requests.map((request: { method: string }) => request.method)).toEqual([
      'orbit.handshake',
      'orbit.session.start',
      'orbit.target.continue',
      'orbit.connection.close',
    ]);
  });

  it('times out instead of hanging when the daemon never replies', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'orbit-session-timeout-'));
    cleanup.push(() => rm(home, { recursive: true, force: true }));
    const server = net.createServer(socket => {
      socket.resume();
    });
    cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('silent daemon did not bind');
    await writeFile(path.join(home, 'daemon.port'), String(address.port), 'utf8');

    const started = Date.now();
    await expect(runSessionCli(['status'], { stdout: () => undefined, stderr: () => undefined }, {
      stateDir: home,
      sendTimeoutMs: 80,
    })).rejects.toThrow(/timed out/i);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('reuses a healthy daemon on a second connect without another handshake', async () => {
    const api = await startFakeApi();
    const home = await mkdtemp(path.join(tmpdir(), 'orbit-session-reuse-'));
    cleanup.push(() => rm(home, { recursive: true, force: true }));
    const io = { stdout: () => undefined, stderr: () => undefined };
    const sessionOpts = { endpoint: endpoint(api.port), stateDir: home };
    expect(await runSessionCli(['connect'], io, sessionOpts)).toBe(0);
    expect(await runSessionCli(['connect'], io, sessionOpts)).toBe(0);
    expect(api.requests.map((request: { method: string }) => request.method)).toEqual(['orbit.handshake']);
    await runSessionCli(['quit'], io, sessionOpts);
  });
});
