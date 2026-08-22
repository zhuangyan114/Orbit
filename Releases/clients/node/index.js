"use strict";
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
exports.OrbitClient = exports.OrbitRpcError = exports.AmbiguousInstanceError = exports.InstanceNotFoundError = exports.OrbitClientError = void 0;
exports.decodeBase64 = decodeBase64;
exports.defaultRegistryPath = defaultRegistryPath;
exports.enumerateInstances = enumerateInstances;
exports.selectInstance = selectInstance;
const path = __importStar(require("path"));
const promises_1 = require("fs/promises");
class OrbitClientError extends Error {
}
exports.OrbitClientError = OrbitClientError;
class InstanceNotFoundError extends OrbitClientError {
}
exports.InstanceNotFoundError = InstanceNotFoundError;
class AmbiguousInstanceError extends OrbitClientError {
    candidates;
    constructor(candidates) {
        super(`multiple Orbit instances match; specify instanceId (${candidates.map(item => item.instanceId).join(', ')})`);
        this.candidates = candidates;
    }
}
exports.AmbiguousInstanceError = AmbiguousInstanceError;
class OrbitRpcError extends OrbitClientError {
    code;
    data;
    constructor(message, code, data) {
        super(message);
        this.code = code;
        this.data = data;
    }
}
exports.OrbitRpcError = OrbitRpcError;
function decodeBase64(value) {
    if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
        throw new OrbitClientError('invalid Base64 payload');
    }
    return Uint8Array.from(Buffer.from(value, 'base64'));
}
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function defaultRegistryPath(env = process.env, platform = process.platform) {
    if (env.ORBIT_AUTOMATION_REGISTRY)
        return env.ORBIT_AUTOMATION_REGISTRY;
    if (platform === 'win32') {
        return path.join(env.LOCALAPPDATA || path.join(env.USERPROFILE || '', 'AppData', 'Local'), 'Orbit', 'automation', 'registries.json');
    }
    if (platform === 'darwin') {
        return path.join(env.HOME || '~', 'Library', 'Application Support', 'Orbit', 'automation', 'registries.json');
    }
    return path.join(env.XDG_RUNTIME_DIR || path.join(env.HOME || '~', '.local', 'state'), 'orbit', 'automation', 'registries.json');
}
async function readTrustedJson(filePath) {
    const info = await (0, promises_1.lstat)(filePath);
    if (info.isSymbolicLink() || !info.isFile())
        throw new OrbitClientError(`untrusted registry file: ${filePath}`);
    return JSON.parse(await (0, promises_1.readFile)(filePath, 'utf8'));
}
function validLoopbackUrl(value, port, pathname) {
    if (typeof value !== 'string')
        return false;
    try {
        const parsed = new URL(value);
        return parsed.protocol === 'http:'
            && parsed.hostname === '127.0.0.1'
            && Number(parsed.port) === port
            && parsed.pathname === pathname
            && parsed.search === '';
    }
    catch {
        return false;
    }
}
function parseEndpoint(value) {
    if (!isRecord(value) || value.schemaVersion !== 1 || value.host !== '127.0.0.1')
        return undefined;
    const port = value.port;
    if (!Number.isInteger(port) || port < 1 || port > 65535)
        return undefined;
    if (typeof value.instanceId !== 'string'
        || typeof value.projectId !== 'string'
        || !value.projectId.startsWith('sha256:')
        || typeof value.token !== 'string'
        || value.token.length === 0
        || !validLoopbackUrl(value.rpcUrl, port, '/v1/rpc')
        || !validLoopbackUrl(value.eventsUrl, port, '/v1/events')
        || !validLoopbackUrl(value.healthUrl, port, '/health')
        || !Array.isArray(value.apiVersions)
        || !value.apiVersions.includes('1.0'))
        return undefined;
    return value;
}
async function healthMatches(endpoint, fetchImpl, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
        const response = await fetchImpl(endpoint.healthUrl, { signal: controller.signal });
        if (!response.ok)
            return false;
        const health = await response.json();
        return isRecord(health)
            && health.ok === true
            && health.instanceId === endpoint.instanceId
            && health.projectId === endpoint.projectId
            && health.apiVersion === '1.0';
    }
    catch {
        return false;
    }
    finally {
        clearTimeout(timer);
    }
}
async function enumerateInstances(options = {}) {
    const registryPath = options.registryPath ?? defaultRegistryPath(options.env, options.platform);
    let pointer;
    try {
        pointer = await readTrustedJson(registryPath);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return [];
        throw error;
    }
    if (!isRecord(pointer) || pointer.schemaVersion !== 1 || !Array.isArray(pointer.registries)) {
        throw new OrbitClientError(`untrusted registry pointer schema: ${registryPath}`);
    }
    const fetchImpl = options.fetchImpl ?? fetch;
    const candidates = [];
    for (const registry of pointer.registries) {
        if (!isRecord(registry) || typeof registry.endpointDirectory !== 'string')
            continue;
        try {
            const directoryInfo = await (0, promises_1.lstat)(registry.endpointDirectory);
            if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory())
                continue;
            const entries = await (0, promises_1.readdir)(registry.endpointDirectory, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isFile() || !entry.name.endsWith('.json'))
                    continue;
                try {
                    const endpoint = parseEndpoint(await readTrustedJson(path.join(registry.endpointDirectory, entry.name)));
                    if (endpoint && await healthMatches(endpoint, fetchImpl, options.healthTimeoutMs ?? 2000))
                        candidates.push(endpoint);
                }
                catch {
                    // One untrusted or partially-written endpoint must not hide healthy instances.
                }
            }
        }
        catch {
            // A stale registry entry is ignored after its endpoint directory becomes unavailable.
        }
    }
    const byInstance = new Map();
    for (const endpoint of candidates) {
        const current = byInstance.get(endpoint.instanceId);
        if (!current || endpoint.heartbeatAt > current.heartbeatAt)
            byInstance.set(endpoint.instanceId, endpoint);
    }
    return [...byInstance.values()].sort((a, b) => a.projectId.localeCompare(b.projectId) || a.instanceId.localeCompare(b.instanceId));
}
function selectInstance(instances, options = {}) {
    let candidates = instances;
    if (options.projectId)
        candidates = candidates.filter(item => item.projectId === options.projectId);
    if (options.instanceId)
        candidates = candidates.filter(item => item.instanceId === options.instanceId);
    if (candidates.length === 0)
        throw new InstanceNotFoundError('no live Orbit instance matches the requested identity');
    if (candidates.length > 1)
        throw new AmbiguousInstanceError(candidates);
    return candidates[0];
}
class OrbitClient {
    endpoint;
    fetchImpl;
    nextRequestId;
    connectionIdValue;
    registryGenerationValue;
    session;
    constructor(endpoint, options = {}) {
        this.endpoint = endpoint;
        this.fetchImpl = options.fetchImpl ?? fetch;
        let sequence = 0;
        this.nextRequestId = options.requestId ?? (() => `req-${++sequence}`);
    }
    get connectionId() {
        return this.connectionIdValue;
    }
    async rpc(method, params) {
        const id = this.nextRequestId();
        const response = await this.fetchImpl(this.endpoint.rpcUrl, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${this.endpoint.token}`,
                'content-type': 'application/json; charset=utf-8',
            },
            body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        });
        let envelope;
        try {
            envelope = await response.json();
        }
        catch {
            throw new OrbitClientError(`Orbit RPC returned invalid JSON (HTTP ${response.status})`);
        }
        if (!isRecord(envelope))
            throw new OrbitClientError('Orbit RPC returned an invalid response envelope');
        if ('error' in envelope && isRecord(envelope.error)) {
            throw new OrbitRpcError(typeof envelope.error.message === 'string' ? envelope.error.message : 'Orbit RPC failed', typeof envelope.error.code === 'number' ? envelope.error.code : -32603, isRecord(envelope.error.data) ? envelope.error.data : undefined);
        }
        if (!response.ok || !isRecord(envelope.result)) {
            const detail = typeof envelope.error === 'string' && envelope.error.length > 0 ? `: ${envelope.error}` : '';
            throw new OrbitClientError(`Orbit RPC failed with HTTP ${response.status}${detail}`);
        }
        return envelope.result;
    }
    async invoke(method, params = {}, options = {}) {
        const context = this.context(options.context ?? 'connection', options.idempotencyKey);
        const result = await this.rpc(method, { context, ...params });
        this.captureSession(result.data);
        return result.data;
    }
    async handshake(options) {
        const data = await this.invoke('orbit.handshake', {
            apiVersion: '1.0',
            client: options.client,
            expected: {
                projectId: this.endpoint.projectId,
                instanceId: this.endpoint.instanceId,
                ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}),
            },
            requestedScopes: [...new Set(options.requestedScopes)],
        }, { context: 'bootstrap' });
        if (typeof data.connectionId !== 'string')
            throw new OrbitClientError('handshake response omitted connectionId');
        this.connectionIdValue = data.connectionId;
        if (isRecord(data.project) && Number.isInteger(data.project.registryGeneration)) {
            this.registryGenerationValue = data.project.registryGeneration;
        }
        this.captureSession(data.session);
        return data;
    }
    async refreshSession(sessionId) {
        let requestedId = sessionId ?? this.session?.sessionId;
        if (!requestedId) {
            const page = await this.invoke('orbit.session.list', { includeTerminated: false });
            const items = Array.isArray(page.items) ? page.items.filter(isRecord) : [];
            if (items.length === 0)
                throw new OrbitClientError('no active Orbit debug session');
            if (items.length > 1)
                throw new OrbitClientError('multiple active sessions; specify sessionId');
            requestedId = String(items[0].sessionId);
        }
        const session = await this.invoke('orbit.session.snapshot', {
            sessionId: requestedId,
            includeCapabilities: true,
        });
        this.session = session;
        return session;
    }
    getOperation(operationId) {
        return this.invoke('orbit.operation.get', { operationId });
    }
    async *pollSnapshots(requests, options = {}) {
        const iterations = options.iterations ?? Number.POSITIVE_INFINITY;
        for (let iteration = 0; iteration < iterations && !options.signal?.aborted; iteration += 1) {
            for (const request of requests) {
                const data = await this.invoke(request.method, request.params ?? {}, { context: request.context ?? 'connection' });
                yield { method: request.method, data };
            }
            if (iteration + 1 < iterations)
                await delay(options.intervalMs ?? 1000, options.signal);
        }
    }
    async *paginate(method, params = {}, options = {}) {
        let cursor = typeof params.cursor === 'string' ? params.cursor : undefined;
        const seen = new Set();
        for (;;) {
            const page = await this.invoke(method, {
                ...params,
                ...(cursor ? { cursor } : {}),
            }, options);
            if (!Array.isArray(page.items))
                throw new OrbitClientError(`${method} response omitted items`);
            yield page;
            const next = typeof page.nextCursor === 'string' && page.nextCursor.length > 0 ? page.nextCursor : undefined;
            if (!next)
                return;
            if (seen.has(next))
                throw new OrbitClientError(`${method} returned a repeated pagination cursor`);
            seen.add(next);
            cursor = next;
        }
    }
    async *events(options = {}) {
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
        if (eventTypes.size === 1)
            headers.set('x-orbit-event-type', [...eventTypes][0]);
        if (options.lastEventId)
            headers.set('last-event-id', options.lastEventId);
        const response = await this.fetchImpl(this.endpoint.eventsUrl, { headers, signal: options.signal });
        if (!response.ok || !response.body)
            throw new OrbitClientError(`Orbit event stream failed with HTTP ${response.status}`);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let dataLines = [];
        try {
            for (;;) {
                const { done, value } = await reader.read();
                buffer += decoder.decode(value, { stream: !done });
                const lines = buffer.split(/\r?\n/);
                buffer = done ? '' : lines.pop() ?? '';
                for (const line of lines) {
                    if (line === '') {
                        if (dataLines.length > 0) {
                            const parsed = JSON.parse(dataLines.join('\n'));
                            if (!isAutomationEvent(parsed))
                                throw new OrbitClientError('Orbit event stream returned an invalid event');
                            if (eventTypes.size === 0 || eventTypes.has(parsed.type))
                                yield parsed;
                        }
                        dataLines = [];
                    }
                    else if (line.startsWith('data:')) {
                        dataLines.push(line.slice(5).trimStart());
                    }
                }
                if (done)
                    break;
            }
        }
        finally {
            reader.releaseLock();
        }
    }
    async close() {
        if (!this.connectionIdValue)
            return false;
        try {
            const data = await this.invoke('orbit.connection.close');
            return data.closed === true;
        }
        finally {
            this.connectionIdValue = undefined;
            this.session = undefined;
        }
    }
    context(kind, idempotencyKey) {
        const context = {
            instanceId: this.endpoint.instanceId,
            projectId: this.endpoint.projectId,
        };
        if (kind === 'bootstrap')
            return context;
        context.connectionId = this.requireConnection();
        if (kind === 'connectionMutation' || kind === 'projectMutation' || kind === 'targetMutation') {
            context.idempotencyKey = idempotencyKey ?? randomKey();
        }
        if (kind === 'projectMutation') {
            if (!Number.isInteger(this.registryGenerationValue))
                throw new OrbitClientError('project registry generation is unavailable; handshake again');
            context.registryGeneration = this.registryGenerationValue;
        }
        if (kind === 'target' || kind === 'targetMutation') {
            if (!this.session)
                throw new OrbitClientError('session context is unavailable; refresh the session first');
            context.sessionId = this.session.sessionId;
            context.sessionGeneration = this.session.sessionGeneration;
        }
        return context;
    }
    requireConnection() {
        if (!this.connectionIdValue)
            throw new OrbitClientError('client is not handshaken');
        return this.connectionIdValue;
    }
    captureSession(value) {
        if (isSessionSnapshot(value))
            this.session = value;
        if (isRecord(value) && isSessionSnapshot(value.session))
            this.session = value.session;
    }
}
exports.OrbitClient = OrbitClient;
function isSessionSnapshot(value) {
    return isRecord(value)
        && typeof value.sessionId === 'string'
        && Number.isInteger(value.sessionGeneration)
        && typeof value.phase === 'string';
}
function isAutomationEvent(value) {
    return isRecord(value)
        && typeof value.eventId === 'string'
        && typeof value.instanceId === 'string'
        && typeof value.projectId === 'string'
        && typeof value.timestamp === 'string'
        && typeof value.type === 'string';
}
function randomKey() {
    return `idem-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
function delay(milliseconds, signal) {
    if (milliseconds <= 0 || signal?.aborted)
        return Promise.resolve();
    return new Promise(resolve => {
        const timer = setTimeout(resolve, milliseconds);
        signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
        }, { once: true });
    });
}
//# sourceMappingURL=index.js.map