#!/usr/bin/env node

// Orbit Automation API v1 — long-lived session router (plan §5, AI invocation).
//
// Preferred surface is git-style verbs against a local daemon:
//   orbit-automation-session connect --instance <id>
//   orbit-automation-session start "Orbit: J-Link (Flash)"
//   orbit-automation-session continue
//   orbit-automation-session quit
// stdin NDJSON remains when argv has no verb (script/pipe).
//
// Wire contract (stdin -> stdout, one JSON object per line):
//   in:  {"command":"start","params":{...},"action":null,"session":null,"idempotencyKey":null}
//   out (first line): {"ok":true,"data":{"event":"ready","connectionId":"...","grantedScopes":[...],"session":null}}
//   out (per command): {"ok":true,"data":<invoke result>} | {"ok":false,"error":"...","code":null,"errorCode":null,"retryable":null}
//   out (final line):  {"ok":true,"data":{"closed":true,"interrupted":false}}
//
// `start` halts at entry; the caller issues `continue` explicitly. No SSE
// multiplexing — the caller polls `status`/`refresh`. Method names come from
// `resolveCommandSpec`/`client.close()`/`client.refreshSession()`, so this
// file holds no `orbit.*` string literals (the contract validator is satisfied
// by construction).

import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { spawn } from 'child_process';
import {
  OrbitClient,
  OrbitClientError,
  OrbitRpcError,
  enumerateInstances,
  selectInstance,
  type AutomationScope,
  type OrbitEndpoint,
  type RpcContextKind,
} from './index';
import { parseArgv, parseTokens, resolveCommand, resolveCommandSpec, stringFlag, type CliIo } from './cli';

/** Scopes covering a full start→control→read→record debug flow in one handshake. */
const DEFAULT_SESSION_SCOPES: AutomationScope[] = [
  'read',
  'session.control',
  'breakpoints.write',
  'variables.write',
  'record',
];

const QUIT_COMMANDS = new Set(['quit', 'exit', 'close']);

export interface SessionOptions {
  /** Stdin source; defaults to process.stdin. */
  input?: NodeJS.ReadableStream;
  /** Stdout sink; defaults to process.stdout. */
  output?: NodeJS.WritableStream;
  /** Skip endpoint discovery and use this endpoint directly (test seam / forced target). */
  endpoint?: OrbitEndpoint;
  /** Fetch implementation threaded into health checks and OrbitClient. */
  fetchImpl?: typeof fetch;
  /** Deterministic request-id factory for OrbitClient. */
  requestId?: () => string | number;
  /** Directory for the git-style daemon state file. */
  stateDir?: string;
  /** TCP timeout for a daemon request. Defaults to 30s. */
  sendTimeoutMs?: number;
}

interface SessionCommand {
  command?: string;
  action?: string;
  params?: Record<string, unknown>;
  session?: string;
  idempotencyKey?: string;
}

interface ResultLine {
  ok: boolean;
  data?: unknown;
  error?: string;
  code?: number;
  errorCode?: string;
  retryable?: boolean;
}

/** Default action for a command when the caller omits `action`. */
function defaultAction(command: string): string {
  if (command === 'step') return 'into';
  if (command === 'breakpoints' || command === 'record') return 'list';
  return '';
}

export async function runSession(argv: string[], options: SessionOptions = {}): Promise<number> {
  const out = options.output ?? process.stdout;
  const writeLine = (line: ResultLine): void => {
    out.write(`${JSON.stringify(line)}\n`);
  };

  const tokens = parseTokens(argv);
  const registryPath = stringFlag(tokens, 'registry');
  const projectId = stringFlag(tokens, 'project');
  const instanceId = stringFlag(tokens, 'instance');
  const scopeOverride = stringFlag(tokens, 'scopes');
  const requestedScopes = (scopeOverride ? scopeOverride.split(',').filter(Boolean) : DEFAULT_SESSION_SCOPES) as AutomationScope[];

  let client: OrbitClient | undefined;
  try {
    let endpoint = options.endpoint;
    if (!endpoint) {
      const instances = await enumerateInstances({ registryPath, fetchImpl: options.fetchImpl });
      endpoint = selectInstance(instances, { projectId, instanceId });
    }
    client = new OrbitClient(endpoint, { fetchImpl: options.fetchImpl, requestId: options.requestId });
    const handshake = await client.handshake({
      client: { name: 'orbit-automation-session', version: '1.0.0', pid: process.pid },
      requestedScopes,
    });
    const grantedScopes = Array.isArray(handshake.grantedScopes)
      ? handshake.grantedScopes.filter((item): item is string => typeof item === 'string')
      : [];
    writeLine({
      ok: true,
      data: { event: 'ready', connectionId: client.connectionId ?? null, grantedScopes, session: client.session ?? null },
    });
  } catch (error) {
    writeLine(toErrorLine(error));
    return 1;
  }
  // Startup threw => returned above; the guard only satisfies the type checker.
  if (!client) return 1;
  const session = client;

  const input = options.input ?? process.stdin;
  const lineReader = readline.createInterface({ input, crlfDelay: Infinity });
  let interrupted = false;
  const productionMode = options.input === undefined && options.output === undefined;
  const onSignal = (): void => {
    interrupted = true;
    lineReader.close();
  };
  if (productionMode) {
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  }

  try {
    for await (const line of lineReader) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let command: SessionCommand;
      try {
        command = JSON.parse(trimmed) as SessionCommand;
      } catch (error) {
        writeLine({ ok: false, error: `invalid command line JSON: ${(error as Error).message}` });
        continue;
      }
      const name = command.command;
      if (typeof name !== 'string' || name.length === 0) {
        writeLine({ ok: false, error: 'command is required' });
        continue;
      }
      if (QUIT_COMMANDS.has(name)) break;
      writeLine(await executeSessionCommand(session, command));
    }
  } finally {
    if (productionMode) {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
    }
    lineReader.close();
  }

  // One connection for the whole flow: release the lease on shutdown.
  let closed = false;
  try {
    closed = await session.close();
  } catch (error) {
    writeLine(toErrorLine(error));
    return 1;
  }
  writeLine({ ok: true, data: { closed, interrupted } });
  return 0;
}

async function executeSessionCommand(session: OrbitClient, command: SessionCommand): Promise<ResultLine> {
  const name = command.command;
  if (typeof name !== 'string' || name.length === 0) return { ok: false, error: 'command is required' };
  try {
    if (name === 'refresh') {
      return { ok: true, data: await session.refreshSession(command.session) };
    }
    const spec = resolveCommandSpec(name, command.action ?? defaultAction(name));
    if ((spec.context === 'target' || spec.context === 'targetMutation') && !session.session) {
      await session.refreshSession(command.session);
    }
    const data = await invokeWithSessionRecovery(session, spec.method, command.params ?? {}, {
      context: spec.context,
      idempotencyKey: command.idempotencyKey,
    });
    return { ok: true, data };
  } catch (error) {
    return toErrorLine(error);
  }
}

export function cliArgsToSessionCommand(argv: string[]): SessionCommand {
  const parsed = parseArgv(argv);
  const name = parsed.command;
  if (!name) throw new OrbitClientError('command is required');
  if (QUIT_COMMANDS.has(name) || name === 'refresh') {
    const session = stringFlag(parsed, 'session');
    return session ? { command: name, session } : { command: name };
  }
  const resolved = resolveCommand(parsed);
  const result: SessionCommand = { command: name, params: resolved.params };
  if (name === 'step') result.action = stringFlag(parsed, 'action') ?? 'into';
  else if (name === 'breakpoints' || name === 'record') {
    result.action = stringFlag(parsed, 'action') ?? parsed.positional[0] ?? 'list';
  }
  const session = stringFlag(parsed, 'session');
  if (session) result.session = session;
  const idempotencyKey = stringFlag(parsed, 'idempotency');
  if (idempotencyKey) result.idempotencyKey = idempotencyKey;
  return result;
}

function defaultStateDir(): string {
  return process.env.ORBIT_SESSION_STATE_DIR || path.join(os.tmpdir(), 'orbit-automation-session');
}

function daemonFiles(stateDir: string): { portFile: string } {
  return { portFile: path.join(stateDir, 'daemon.port') };
}

const DEFAULT_SEND_TIMEOUT_MS = 30_000;

async function sendDaemon(
  port: number,
  payload: Record<string, unknown>,
  timeoutMs = DEFAULT_SEND_TIMEOUT_MS,
): Promise<ResultLine> {
  return await new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let buffer = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new OrbitClientError(`session daemon timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on('data', chunk => { buffer += chunk; });
    socket.on('end', () => {
      finish(() => {
        try {
          resolve(JSON.parse(buffer) as ResultLine);
        } catch (error) {
          reject(new Error(`invalid daemon reply: ${buffer} (${(error as Error).message})`));
        }
      });
    });
    socket.on('error', error => finish(() => reject(error)));
  });
}

async function waitForPort(portFile: string, timeoutMs = 15000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(portFile)) {
      const port = Number(fs.readFileSync(portFile, 'utf8').trim());
      if (Number.isInteger(port) && port > 0) return port;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new OrbitClientError(`session daemon did not publish a port under ${portFile}`);
}

async function serveDaemon(argv: string[], options: SessionOptions, stateDir: string): Promise<number> {
  const files = daemonFiles(stateDir);
  let endpoint = options.endpoint;
  const endpointFile = process.env.ORBIT_SESSION_ENDPOINT_FILE;
  if (!endpoint && endpointFile && fs.existsSync(endpointFile)) {
    endpoint = JSON.parse(fs.readFileSync(endpointFile, 'utf8')) as OrbitEndpoint;
  }
  const tokens = parseTokens(argv);
  const scopeOverride = stringFlag(tokens, 'scopes');
  const requestedScopes = (scopeOverride ? scopeOverride.split(',').filter(Boolean) : DEFAULT_SESSION_SCOPES) as AutomationScope[];
  if (!endpoint) {
    const instances = await enumerateInstances({
      registryPath: stringFlag(tokens, 'registry'),
      fetchImpl: options.fetchImpl,
    });
    endpoint = selectInstance(instances, {
      projectId: stringFlag(tokens, 'project'),
      instanceId: stringFlag(tokens, 'instance'),
    });
  }
  const client = new OrbitClient(endpoint, { fetchImpl: options.fetchImpl, requestId: options.requestId });
  const handshake = await client.handshake({
    client: { name: 'orbit-automation-session', version: '1.0.0', pid: process.pid },
    requestedScopes,
  });
  const grantedScopes = Array.isArray(handshake.grantedScopes)
    ? handshake.grantedScopes.filter((item): item is string => typeof item === 'string')
    : [];
  const ready: ResultLine = {
    ok: true,
    data: { event: 'ready', connectionId: client.connectionId ?? null, grantedScopes, session: client.session ?? null },
  };

  const server = net.createServer(socket => {
    let buffer = '';
    socket.setEncoding('utf8');
    const reply = (body: ResultLine): void => {
      if (!socket.destroyed && socket.writable) socket.end(`${JSON.stringify(body)}\n`);
    };
    socket.on('data', async chunk => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const raw = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let payload: { op?: string; command?: SessionCommand };
      try {
        payload = JSON.parse(raw) as { op?: string; command?: SessionCommand };
      } catch (error) {
        reply({ ok: false, error: (error as Error).message });
        return;
      }
      try {
        if (payload.op === 'ready') {
          reply(ready);
          return;
        }
        if (payload.op === 'send') {
          reply(await executeSessionCommand(client, payload.command ?? {}));
          return;
        }
        if (payload.op === 'quit') {
          let closed = false;
          try {
            closed = await client.close();
          } catch (error) {
            reply(toErrorLine(error));
            server.close();
            try { fs.unlinkSync(files.portFile); } catch { /* ignore */ }
            return;
          }
          reply({ ok: true, data: { closed, interrupted: false } });
          server.close();
          try { fs.unlinkSync(files.portFile); } catch { /* ignore */ }
          return;
        }
        reply({ ok: false, error: `unknown daemon op ${payload.op ?? ''}` });
      } catch (error) {
        reply(toErrorLine(error));
      }
    });
  });

  return await new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        resolve(1);
        return;
      }
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(files.portFile, String(address.port), 'utf8');
    });
    server.on('close', () => resolve(0));
  });
}

export async function runSessionCli(
  argv: string[],
  io: CliIo = {
    stdout: value => process.stdout.write(`${value}\n`),
    stderr: value => process.stderr.write(`${value}\n`),
  },
  options: SessionOptions = {},
): Promise<number> {
  const tokens = parseArgv(argv);
  const verb = tokens.command;
  if (!verb) throw new OrbitClientError('command is required');
  const stateDir = options.stateDir ?? defaultStateDir();
  fs.mkdirSync(stateDir, { recursive: true });
  const files = daemonFiles(stateDir);

  if (verb === 'serve') {
    return await serveDaemon(argv.slice(1), options, stateDir);
  }

  const timeoutMs = options.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;

  if (verb === 'connect') {
    if (fs.existsSync(files.portFile)) {
      const existing = Number(fs.readFileSync(files.portFile, 'utf8').trim());
      if (Number.isInteger(existing) && existing > 0) {
        try {
          const ready = await sendDaemon(existing, { op: 'ready' }, timeoutMs);
          if (ready.ok) {
            io.stdout(JSON.stringify(ready, null, 2));
            return 0;
          }
        } catch {
          try { fs.unlinkSync(files.portFile); } catch { /* replace stale daemon state */ }
        }
      }
    }
    if (options.endpoint) {
      void serveDaemon(argv.slice(1), options, stateDir);
    } else {
      const child = spawn(process.execPath, [__filename, 'serve', ...argv.slice(1)], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, ORBIT_SESSION_STATE_DIR: stateDir },
      });
      child.unref();
    }
    const port = await waitForPort(files.portFile);
    const ready = await sendDaemon(port, { op: 'ready' }, timeoutMs);
    io.stdout(JSON.stringify(ready, null, 2));
    return ready.ok ? 0 : 1;
  }

  let port: number | undefined;
  if (fs.existsSync(files.portFile)) port = Number(fs.readFileSync(files.portFile, 'utf8').trim());
  if (!port) throw new OrbitClientError('no active session daemon; run orbit-automation-session connect first');
  const command = cliArgsToSessionCommand(argv);
  const result = await sendDaemon(port, QUIT_COMMANDS.has(verb) ? { op: 'quit' } : { op: 'send', command }, timeoutMs);
  io.stdout(JSON.stringify(result, null, 2));
  return result.ok ? 0 : 1;
}

/**
 * Invokes a method, refreshing the cached session once on a `SessionChanged`
 * error (the generation the client cached no longer matches — e.g. after a
 * non-API stop/restart bumped the generation) and retrying. Targets exactly
 * the session-staleness class; every other RPC error surfaces to the caller.
 */
async function invokeWithSessionRecovery(
  client: OrbitClient,
  method: string,
  params: Record<string, unknown>,
  options: { context: RpcContextKind; idempotencyKey?: string },
): Promise<unknown> {
  try {
    return await client.invoke(method, params, options);
  } catch (error) {
    if (error instanceof OrbitRpcError && error.data?.errorCode === 'SessionChanged') {
      await client.refreshSession();
      return await client.invoke(method, params, options);
    }
    throw error;
  }
}

function toErrorLine(error: unknown): ResultLine {
  if (error instanceof OrbitRpcError) {
    return {
      ok: false,
      error: error.message,
      code: error.code,
      errorCode: error.data?.errorCode,
      retryable: error.data?.retryable,
    };
  }
  if (error instanceof OrbitClientError) {
    return { ok: false, error: error.message };
  }
  return { ok: false, error: (error as Error)?.message ?? String(error) };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  try {
    if (argv[0] && argv[0] !== '--' && !argv[0].startsWith('--')) {
      process.exitCode = await runSessionCli(argv);
      return;
    }
    process.exitCode = await runSession(argv);
  } catch (error) {
    process.stderr.write(`${JSON.stringify(toErrorLine(error))}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) void main();
