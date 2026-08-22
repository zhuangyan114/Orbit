#!/usr/bin/env node
"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.runSession = runSession;
exports.cliArgsToSessionCommand = cliArgsToSessionCommand;
exports.runSessionCli = runSessionCli;
const fs = __importStar(require("fs"));
const net = __importStar(require("net"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const readline = __importStar(require("readline"));
const child_process_1 = require("child_process");
const index_1 = require("./index");
const cli_1 = require("./cli");
/** Scopes covering a full start→control→read→record debug flow in one handshake. */
const DEFAULT_SESSION_SCOPES = [
    'read',
    'session.control',
    'breakpoints.write',
    'variables.write',
    'record',
];
const QUIT_COMMANDS = new Set(['quit', 'exit', 'close']);
/** Default action for a command when the caller omits `action`. */
function defaultAction(command) {
    if (command === 'step')
        return 'into';
    if (command === 'breakpoints' || command === 'record')
        return 'list';
    return '';
}
async function runSession(argv, options = {}) {
    const out = options.output ?? process.stdout;
    const writeLine = (line) => {
        out.write(`${JSON.stringify(line)}\n`);
    };
    const tokens = (0, cli_1.parseTokens)(argv);
    const registryPath = (0, cli_1.stringFlag)(tokens, 'registry');
    const projectId = (0, cli_1.stringFlag)(tokens, 'project');
    const instanceId = (0, cli_1.stringFlag)(tokens, 'instance');
    const scopeOverride = (0, cli_1.stringFlag)(tokens, 'scopes');
    const requestedScopes = (scopeOverride ? scopeOverride.split(',').filter(Boolean) : DEFAULT_SESSION_SCOPES);
    let client;
    try {
        let endpoint = options.endpoint;
        if (!endpoint) {
            const instances = await (0, index_1.enumerateInstances)({ registryPath, fetchImpl: options.fetchImpl });
            endpoint = (0, index_1.selectInstance)(instances, { projectId, instanceId });
        }
        client = new index_1.OrbitClient(endpoint, { fetchImpl: options.fetchImpl, requestId: options.requestId });
        const handshake = await client.handshake({
            client: { name: 'orbit-automation-session', version: '1.0.0', pid: process.pid },
            requestedScopes,
        });
        const grantedScopes = Array.isArray(handshake.grantedScopes)
            ? handshake.grantedScopes.filter((item) => typeof item === 'string')
            : [];
        writeLine({
            ok: true,
            data: { event: 'ready', connectionId: client.connectionId ?? null, grantedScopes, session: client.session ?? null },
        });
    }
    catch (error) {
        writeLine(toErrorLine(error));
        return 1;
    }
    // Startup threw => returned above; the guard only satisfies the type checker.
    if (!client)
        return 1;
    const session = client;
    const input = options.input ?? process.stdin;
    const lineReader = readline.createInterface({ input, crlfDelay: Infinity });
    let interrupted = false;
    const productionMode = options.input === undefined && options.output === undefined;
    const onSignal = () => {
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
            if (trimmed.length === 0)
                continue;
            let command;
            try {
                command = JSON.parse(trimmed);
            }
            catch (error) {
                writeLine({ ok: false, error: `invalid command line JSON: ${error.message}` });
                continue;
            }
            const name = command.command;
            if (typeof name !== 'string' || name.length === 0) {
                writeLine({ ok: false, error: 'command is required' });
                continue;
            }
            if (QUIT_COMMANDS.has(name))
                break;
            writeLine(await executeSessionCommand(session, command));
        }
    }
    finally {
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
    }
    catch (error) {
        writeLine(toErrorLine(error));
        return 1;
    }
    writeLine({ ok: true, data: { closed, interrupted } });
    return 0;
}
async function executeSessionCommand(session, command) {
    const name = command.command;
    if (typeof name !== 'string' || name.length === 0)
        return { ok: false, error: 'command is required' };
    try {
        if (name === 'refresh') {
            return { ok: true, data: await session.refreshSession(command.session) };
        }
        const spec = (0, cli_1.resolveCommandSpec)(name, command.action ?? defaultAction(name));
        if ((spec.context === 'target' || spec.context === 'targetMutation') && !session.session) {
            await session.refreshSession(command.session);
        }
        const data = await invokeWithSessionRecovery(session, spec.method, command.params ?? {}, {
            context: spec.context,
            idempotencyKey: command.idempotencyKey,
        });
        return { ok: true, data };
    }
    catch (error) {
        return toErrorLine(error);
    }
}
function cliArgsToSessionCommand(argv) {
    const parsed = (0, cli_1.parseArgv)(argv);
    const name = parsed.command;
    if (!name)
        throw new index_1.OrbitClientError('command is required');
    if (QUIT_COMMANDS.has(name) || name === 'refresh') {
        const session = (0, cli_1.stringFlag)(parsed, 'session');
        return session ? { command: name, session } : { command: name };
    }
    const resolved = (0, cli_1.resolveCommand)(parsed);
    const result = { command: name, params: resolved.params };
    if (name === 'step')
        result.action = (0, cli_1.stringFlag)(parsed, 'action') ?? 'into';
    else if (name === 'breakpoints' || name === 'record') {
        result.action = (0, cli_1.stringFlag)(parsed, 'action') ?? parsed.positional[0] ?? 'list';
    }
    const session = (0, cli_1.stringFlag)(parsed, 'session');
    if (session)
        result.session = session;
    const idempotencyKey = (0, cli_1.stringFlag)(parsed, 'idempotency');
    if (idempotencyKey)
        result.idempotencyKey = idempotencyKey;
    return result;
}
function defaultStateDir() {
    return process.env.ORBIT_SESSION_STATE_DIR || path.join(os.tmpdir(), 'orbit-automation-session');
}
function daemonFiles(stateDir) {
    return { portFile: path.join(stateDir, 'daemon.port') };
}
const DEFAULT_SEND_TIMEOUT_MS = 30_000;
async function sendDaemon(port, payload, timeoutMs = DEFAULT_SEND_TIMEOUT_MS) {
    return await new Promise((resolve, reject) => {
        const socket = net.connect({ host: '127.0.0.1', port });
        let buffer = '';
        let settled = false;
        const timer = setTimeout(() => {
            if (settled)
                return;
            settled = true;
            socket.destroy();
            reject(new index_1.OrbitClientError(`session daemon timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        const finish = (fn) => {
            if (settled)
                return;
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
                    resolve(JSON.parse(buffer));
                }
                catch (error) {
                    reject(new Error(`invalid daemon reply: ${buffer} (${error.message})`));
                }
            });
        });
        socket.on('error', error => finish(() => reject(error)));
    });
}
async function waitForPort(portFile, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (fs.existsSync(portFile)) {
            const port = Number(fs.readFileSync(portFile, 'utf8').trim());
            if (Number.isInteger(port) && port > 0)
                return port;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new index_1.OrbitClientError(`session daemon did not publish a port under ${portFile}`);
}
async function serveDaemon(argv, options, stateDir) {
    const files = daemonFiles(stateDir);
    let endpoint = options.endpoint;
    const endpointFile = process.env.ORBIT_SESSION_ENDPOINT_FILE;
    if (!endpoint && endpointFile && fs.existsSync(endpointFile)) {
        endpoint = JSON.parse(fs.readFileSync(endpointFile, 'utf8'));
    }
    const tokens = (0, cli_1.parseTokens)(argv);
    const scopeOverride = (0, cli_1.stringFlag)(tokens, 'scopes');
    const requestedScopes = (scopeOverride ? scopeOverride.split(',').filter(Boolean) : DEFAULT_SESSION_SCOPES);
    if (!endpoint) {
        const instances = await (0, index_1.enumerateInstances)({
            registryPath: (0, cli_1.stringFlag)(tokens, 'registry'),
            fetchImpl: options.fetchImpl,
        });
        endpoint = (0, index_1.selectInstance)(instances, {
            projectId: (0, cli_1.stringFlag)(tokens, 'project'),
            instanceId: (0, cli_1.stringFlag)(tokens, 'instance'),
        });
    }
    const client = new index_1.OrbitClient(endpoint, { fetchImpl: options.fetchImpl, requestId: options.requestId });
    const handshake = await client.handshake({
        client: { name: 'orbit-automation-session', version: '1.0.0', pid: process.pid },
        requestedScopes,
    });
    const grantedScopes = Array.isArray(handshake.grantedScopes)
        ? handshake.grantedScopes.filter((item) => typeof item === 'string')
        : [];
    const ready = {
        ok: true,
        data: { event: 'ready', connectionId: client.connectionId ?? null, grantedScopes, session: client.session ?? null },
    };
    const server = net.createServer(socket => {
        let buffer = '';
        socket.setEncoding('utf8');
        const reply = (body) => {
            if (!socket.destroyed && socket.writable)
                socket.end(`${JSON.stringify(body)}\n`);
        };
        socket.on('data', async (chunk) => {
            buffer += chunk;
            const newline = buffer.indexOf('\n');
            if (newline < 0)
                return;
            const raw = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            let payload;
            try {
                payload = JSON.parse(raw);
            }
            catch (error) {
                reply({ ok: false, error: error.message });
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
                    }
                    catch (error) {
                        reply(toErrorLine(error));
                        server.close();
                        try {
                            fs.unlinkSync(files.portFile);
                        }
                        catch { /* ignore */ }
                        return;
                    }
                    reply({ ok: true, data: { closed, interrupted: false } });
                    server.close();
                    try {
                        fs.unlinkSync(files.portFile);
                    }
                    catch { /* ignore */ }
                    return;
                }
                reply({ ok: false, error: `unknown daemon op ${payload.op ?? ''}` });
            }
            catch (error) {
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
async function runSessionCli(argv, io = {
    stdout: value => process.stdout.write(`${value}\n`),
    stderr: value => process.stderr.write(`${value}\n`),
}, options = {}) {
    const tokens = (0, cli_1.parseArgv)(argv);
    const verb = tokens.command;
    if (!verb)
        throw new index_1.OrbitClientError('command is required');
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
                }
                catch {
                    try {
                        fs.unlinkSync(files.portFile);
                    }
                    catch { /* replace stale daemon state */ }
                }
            }
        }
        if (options.endpoint) {
            void serveDaemon(argv.slice(1), options, stateDir);
        }
        else {
            const child = (0, child_process_1.spawn)(process.execPath, [__filename, 'serve', ...argv.slice(1)], {
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
    let port;
    if (fs.existsSync(files.portFile))
        port = Number(fs.readFileSync(files.portFile, 'utf8').trim());
    if (!port)
        throw new index_1.OrbitClientError('no active session daemon; run orbit-automation-session connect first');
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
async function invokeWithSessionRecovery(client, method, params, options) {
    try {
        return await client.invoke(method, params, options);
    }
    catch (error) {
        if (error instanceof index_1.OrbitRpcError && error.data?.errorCode === 'SessionChanged') {
            await client.refreshSession();
            return await client.invoke(method, params, options);
        }
        throw error;
    }
}
function toErrorLine(error) {
    if (error instanceof index_1.OrbitRpcError) {
        return {
            ok: false,
            error: error.message,
            code: error.code,
            errorCode: error.data?.errorCode,
            retryable: error.data?.retryable,
        };
    }
    if (error instanceof index_1.OrbitClientError) {
        return { ok: false, error: error.message };
    }
    return { ok: false, error: error?.message ?? String(error) };
}
async function main() {
    const argv = process.argv.slice(2);
    try {
        if (argv[0] && argv[0] !== '--' && !argv[0].startsWith('--')) {
            process.exitCode = await runSessionCli(argv);
            return;
        }
        process.exitCode = await runSession(argv);
    }
    catch (error) {
        process.stderr.write(`${JSON.stringify(toErrorLine(error))}\n`);
        process.exitCode = 1;
    }
}
if (require.main === module)
    void main();
//# sourceMappingURL=session.js.map