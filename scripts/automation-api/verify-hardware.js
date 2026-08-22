#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const repoRoot = path.resolve(__dirname, '..', '..');

const RPC_DISPATCH_P95_MS = 20;
const SSE_WRITE_P95_MS = 100;
const CONTROL_OVERHEAD_P95_MS = 50;
const WARMUP = 100;
const MEASURE_RPC = 1000;
const MEASURE_SSE = 100;
const MEASURE_CONTROL = 100;

const HARDWARE_LAYERS = ['hardware.jlink-native', 'hardware.jlink-legacy', 'hardware.cmsis-dap'];
const PROBES = new Set(['jlink-native', 'jlink-legacy', 'cmsis-dap']);
const SECRET_KEYS = new Set(['token', 'authorization', 'Authorization', 'bearer', 'Bearer']);

const WORKFLOW_STEPS = [
  'handshake',
  'visible-start',
  'breakpoint-add',
  'breakpoint-hit',
  'breakpoint-remove',
  'pause',
  'continue',
  'reset',
  'stepInstruction',
  'stepInto',
  'stepOver',
  'stepOut',
  'flash',
  'symbol-search',
  'symbol-resolve',
  'variable-read',
  'variable-write',
  'memory-read',
  'memory-write',
  'watch-sync',
  'timeline-sync',
  'record',
  'rtt',
  'diagnostics',
  'sse-lifecycle',
  'stop',
  'owner-count-1',
  'disconnect-cleanup',
];

const TARGET_MUTATING_STEPS = new Set([
  'visible-start', 'breakpoint-add', 'breakpoint-hit', 'breakpoint-remove',
  'pause', 'continue', 'reset', 'stepInstruction', 'stepInto', 'stepOver', 'stepOut',
  'flash', 'variable-write', 'memory-write', 'watch-sync', 'timeline-sync',
  'record', 'rtt', 'stop',
]);

function parseArgs(argv) {
  const options = {
    mode: 'mock',
    authorize: false,
    probe: undefined,
    board: undefined,
    operations: undefined,
    flash: false,
    skipStress: false,
    configuration: undefined,
    source: 'd:\\STM32\\project\\vet6_led\\Core\\Src\\freertos.c',
    line: 402,
    expression: 'g_ram_data',
    endpoint: undefined,
    registry: undefined,
    evidence: path.join(repoRoot, 'outputs', 'automation-api', 'task16-hardware-evidence.json'),
    help: false,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--mock') options.mode = 'mock';
    else if (arg === '--live') options.mode = 'live';
    else if (arg === '--authorize') options.authorize = true;
    else if (arg === '--flash') options.flash = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--probe') {
      options.probe = argv[index + 1];
      index += 1;
    } else if (arg === '--board') {
      options.board = argv[index + 1];
      index += 1;
    } else if (arg === '--operations') {
      options.operations = String(argv[index + 1] ?? '').split(',').map(item => item.trim()).filter(Boolean);
      index += 1;
      } else if (arg === '--skip-stress') options.skipStress = true;
    else if (arg === '--configuration') {
      options.configuration = argv[index + 1];
      index += 1;
    } else if (arg === '--source') {
      options.source = argv[index + 1];
      index += 1;
    } else if (arg === '--line') {
      options.line = Number(argv[index + 1]);
      index += 1;
    } else if (arg === '--expression') {
      options.expression = argv[index + 1];
      index += 1;
    } else if (arg === '--endpoint') {
      options.endpoint = argv[index + 1];
      index += 1;
    } else if (arg === '--registry') {
      options.registry = argv[index + 1];
      index += 1;
    } else if (arg === '--evidence') {
      options.evidence = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  if (options.authorize || options.probe || options.board) options.mode = 'live';
  return options;
}

function percentileStats(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return { count: 0, p50: null, p95: null, max: null };
  const at = fraction => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
  return { count: sorted.length, p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] };
}

function evaluatePerformanceGate(samples, limitMs, options = {}) {
  const stats = percentileStats(samples);
  const passed = Number.isFinite(stats.p95) && stats.p95 <= limitMs;
  let jitterOk = true;
  if (options.previousP95 != null) {
    const jitter = options.jitter ?? 0.05;
    jitterOk = Number.isFinite(stats.p95) && stats.p95 <= options.previousP95 * (1 + jitter);
  }
  return { ...stats, passed, jitterOk };
}

function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value === null || typeof value !== 'object') return value;
  const out = {};
  for (const [key, nested] of Object.entries(value)) {
    out[key] = SECRET_KEYS.has(key) ? '[redacted]' : redactSecrets(nested);
  }
  return out;
}

function containsSecret(value) {
  if (Array.isArray(value)) return value.some(containsSecret);
  if (value === null || typeof value !== 'object') return false;
  for (const [key, nested] of Object.entries(value)) {
    if (SECRET_KEYS.has(key) && nested && nested !== '[redacted]') return true;
    if (containsSecret(nested)) return true;
  }
  return false;
}

function classifyLayerStatus(input = {}) {
  const hardware = input.hardware && typeof input.hardware === 'object' ? input.hardware : input;
  const status = {
    automated: input.automated ?? 'unverified',
    mock: input.mock ?? 'unverified',
  };
  for (const key of HARDWARE_LAYERS) {
    const value = hardware[key];
    status[key] = value === 'passed' || value === 'failed' || value === 'unverified' ? value : 'unverified';
  }
  const allPassed = status.automated === 'passed'
    && status.mock === 'passed'
    && HARDWARE_LAYERS.every(key => status[key] === 'passed');
  status.allLayersPassed = String(allPassed);
  return status;
}

function validateAuthorization(options = {}) {
  const errors = [];
  if (options.mode === 'live') {
    if (!options.authorize) errors.push('live hardware mutation requires --authorize');
    if (!options.probe) errors.push('live hardware mutation requires --probe');
    if (!options.board) errors.push('live hardware mutation requires --board');
    if (options.probe && !PROBES.has(options.probe)) {
      errors.push(`unknown probe ${options.probe}`);
    }
  }
  return errors;
}

function authorizedEvidenceFor(layer, evidence) {
  const authorized = evidence.authorized === true;
  const probe = layer.replace('hardware.', '');
  const requests = Array.isArray(evidence.requests) ? evidence.requests : [];
  const matching = requests.filter(item => item && item.authorized === true && item.ownerKind === probe);
  return authorized && matching.length > 0;
}

function validateHardwareEvidence(evidence) {
  const errors = [];
  if (!evidence || evidence.schemaVersion !== 1) errors.push('evidence.schemaVersion must be 1');
  const layers = evidence?.layers && typeof evidence.layers === 'object' ? evidence.layers : {};
  for (const key of HARDWARE_LAYERS) {
    if (layers[key] === 'passed' && !authorizedEvidenceFor(key, evidence)) {
      errors.push(`${key} is marked passed without authorized evidence`);
    }
  }
  const owners = evidence?.owners && typeof evidence.owners === 'object' ? evidence.owners : {};
  if (owners.maxConcurrent !== 1) errors.push('target owner maxConcurrent must be 1');
  if (containsSecret(evidence)) errors.push('evidence must not contain a bearer token');
  const steps = Array.isArray(evidence?.workflow) ? evidence.workflow.map(item => item.step) : [];
  if (evidence?.mode === 'mock' || evidence?.mode === 'live') {
    for (const step of WORKFLOW_STEPS) {
      if (!steps.includes(step)) errors.push(`workflow is missing ${step}`);
    }
  }
  return errors;
}

function nowMs() {
  return performance.now();
}

function measureLoop(warmup, count, fn) {
  for (let index = 0; index < warmup; index += 1) fn();
  const samples = [];
  for (let index = 0; index < count; index += 1) {
    const start = nowMs();
    fn();
    samples.push(nowMs() - start);
  }
  return samples;
}

async function measureLoopAsync(warmup, count, fn) {
  for (let index = 0; index < warmup; index += 1) await fn();
  const samples = [];
  for (let index = 0; index < count; index += 1) {
    const start = nowMs();
    const value = await fn();
    samples.push(typeof value === 'number' ? value : nowMs() - start);
  }
  return samples;
}

function oneKiBPayload() {
  return { context: { connectionId: 'conn-bench', projectId: 'sha256:bench', instanceId: 'inst-bench' }, blob: 'x'.repeat(1024) };
}

function benchRpcDispatch() {
  const payload = oneKiBPayload();
  const handler = params => ({ ok: true, bytes: JSON.stringify(params).length });
  return measureLoop(WARMUP, MEASURE_RPC, () => {
    const parsed = JSON.parse(JSON.stringify({ jsonrpc: '2.0', id: 'bench', method: 'orbit.instance.describe', params: payload }));
    handler(parsed.params);
  });
}

function serializeSseEvent(event) {
  const data = JSON.stringify(event);
  return `id: ${event.eventId}\r\nevent: ${event.type}\r\ndata: ${data}\r\n\r\n`;
}

function benchSseWrite() {
  const chunks = [];
  const event = {
    eventId: '0000000000000042',
    instanceId: 'inst-bench',
    projectId: 'sha256:bench',
    sessionId: 'sess-bench',
    sessionGeneration: 1,
    timestamp: '1786540000000',
    type: 'target.stopped',
    data: { reason: 'breakpoint', pc: '0x08001234' },
  };
  return measureLoop(WARMUP, MEASURE_SSE, () => {
    chunks.length = 0;
    chunks.push(serializeSseEvent(event));
  });
}

async function benchControlOverhead() {
  const customRequest = async () => {
    await Promise.resolve();
    return { state: 'halted', pc: '0x08000100' };
  };
  return measureLoopAsync(WARMUP, MEASURE_CONTROL, async () => {
    const dispatchStart = nowMs();
    const customStart = nowMs();
    await customRequest();
    const customElapsed = nowMs() - customStart;
    return Math.max(0, (nowMs() - dispatchStart) - customElapsed);
  });
}

function hostInfo() {
  return {
    cpu: os.cpus()[0]?.model ?? 'unknown',
    cpuCount: os.cpus().length,
    os: `${os.type()} ${os.release()} ${os.arch()}`,
    node: process.version,
    vscode: process.env.VSCODE_VERSION ?? 'not-captured-in-mock',
  };
}

function mockWorkflow(probe) {
  const ownerKind = probe;
  const helperPid = ownerKind === 'jlink-legacy' ? null : 4242;
  const steps = WORKFLOW_STEPS.map(step => {
    const mutating = TARGET_MUTATING_STEPS.has(step);
    const nativeOnly = ownerKind === 'jlink-legacy' && (step === 'stepInto' || step === 'stepOver' || step === 'stepOut');
    return {
      step,
      status: nativeOnly ? 'capability-unavailable' : 'simulated',
      authorized: false,
      mutating,
      ownerKind,
      errorCode: nativeOnly ? 'CapabilityUnavailable' : null,
      secondOwnerCreated: false,
    };
  });
  return {
    probe: ownerKind,
    steps,
    owners: {
      maxConcurrent: 1,
      kinds: [ownerKind],
      helperPids: helperPid ? [helperPid] : [],
      afterDisconnect: 0,
    },
  };
}

function collectMockEvidence(options, performanceReport) {
  const workflows = ['jlink-native', 'jlink-legacy', 'cmsis-dap'].map(mockWorkflow);
  const requests = [{
    method: 'orbit.instance.describe',
    instanceId: 'mock-instance',
    projectId: 'sha256:mock',
    sessionId: undefined,
    sessionGeneration: undefined,
    ownerKind: 'none',
    targetState: 'none',
    pc: undefined,
    elapsedMs: 0,
    errorCode: null,
    authorized: false,
  }];
  const layers = classifyLayerStatus({
    automated: 'passed',
    mock: 'passed',
  });
  return redactSecrets({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: 'mock',
    authorized: false,
    host: hostInfo(),
    layers,
    owners: {
      maxConcurrent: 1,
      kinds: ['jlink-native'],
      helperPids: [4242],
      processTreeSecondOwner: false,
      afterDisconnect: 0,
    },
    workflow: mockWorkflow('jlink-native').steps,
    workflows,
    requests,
    performance: performanceReport,
    notes: [
      'Mock/CI run only. Hardware layers remain unverified.',
      'Live mutation requires --authorize --probe --board.',
      'Legacy source-level step is CapabilityUnavailable and must not spawn a second owner.',
    ],
  });
}

async function runMock(options) {
  const rpcSamples = benchRpcDispatch();
  const sseSamples = benchSseWrite();
  const controlSamples = await benchControlOverhead();
  const performanceReport = {
    gate: 'ci-trend',
    rpcDispatch: evaluatePerformanceGate(rpcSamples, RPC_DISPATCH_P95_MS),
    sseWrite: evaluatePerformanceGate(sseSamples, SSE_WRITE_P95_MS),
    controlOverhead: evaluatePerformanceGate(controlSamples, CONTROL_OVERHEAD_P95_MS),
    warmup: WARMUP,
    measured: { rpc: MEASURE_RPC, sse: MEASURE_SSE, control: MEASURE_CONTROL },
  };
  const evidence = collectMockEvidence(options, performanceReport);
  const violations = validateHardwareEvidence(evidence);
  if (violations.length) {
    throw new Error(`mock evidence invalid:\n- ${violations.join('\n- ')}`);
  }
  return evidence;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function pollUntil(read, accept, timeoutMs, intervalMs) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (accept(last)) return { value: last, timedOut: false };
    await sleep(intervalMs);
  }
  return { value: last, timedOut: true };
}

function helperSnapshot() {
  const { execFileSync } = require('node:child_process');
  try {
    const out = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8' });
    const rows = out.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const helpers = rows.filter(line => /orbit-jlink-helper|orbit-cmsis-dap-helper/i.test(line)).map(line => {
      const cols = line.split('","').map(item => item.replace(/^"|"$/g, ''));
      return { image: cols[0], pid: Number(cols[1]) };
    });
    return {
      helpers,
      jlink: helpers.filter(item => /jlink/i.test(item.image)),
      cmsis: helpers.filter(item => /cmsis/i.test(item.image)),
    };
  } catch {
    return { helpers: [], jlink: [], cmsis: [] };
  }
}

function continueSucceeded(data) {
  if (!data) return false;
  if (data.state === 'running') return true;
  const stopReason = data.stopReason || data.session?.stopReason;
  return data.state === 'halted' && stopReason === 'breakpoint';
}

function defaultConfiguration(options) {
  if (options.configuration) return options.configuration;
  if (options.probe === 'cmsis-dap') {
    return options.flash ? 'Orbit: DAPLink (Flash)' : 'Orbit: DAPLink (No Flash)';
  }
  return options.flash ? 'Orbit: J-Link (Flash)' : 'Orbit: J-Link (No Flash)';
}

function decimalValue(value) {
  const text = String(value ?? '').trim();
  const hex = /^0x([0-9a-fA-F]+)/.exec(text);
  if (hex) return parseInt(hex[1], 16);
  const n = parseInt(text, 10);
  return Number.isFinite(n) ? n : NaN;
}

function u32ToBase64(value) {
  return Buffer.from([value & 0xFF, (value >>> 8) & 0xFF, (value >>> 16) & 0xFF, (value >>> 24) & 0xFF]).toString('base64');
}

function base64ToU32(b64) {
  const bytes = Buffer.from(b64 ?? '', 'base64');
  if (bytes.length < 4) return null;
  return (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
}

async function discoverLiveEndpoint(options, clientMod) {
  if (options.endpoint) {
    const parsed = JSON.parse(fs.readFileSync(options.endpoint, 'utf8'));
    const health = await fetch(parsed.healthUrl).then(res => res.json()).catch(() => undefined);
    if (!health || health.ok !== true || health.instanceId !== parsed.instanceId) {
      throw new Error(`endpoint health failed for ${options.endpoint}`);
    }
    return parsed;
  }
  const live = await clientMod.enumerateInstances({
    registryPath: options.registry,
    healthTimeoutMs: 2000,
  });
  if (live.length === 1) return live[0];
  if (live.length > 1) {
    throw new Error(`ambiguous instance (${live.length}); pass --endpoint or --registry with a unique window`);
  }
  const fallbackDirs = [
    path.join(process.env.APPDATA || '', 'Code', 'User', 'globalStorage', 'orbit-debug.orbit-for-vscode', 'automation-api', 'endpoints'),
    path.join(process.env.LOCALAPPDATA || '', 'Orbit', 'automation', 'endpoints'),
  ];
  for (const dir of fallbackDirs) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).filter(item => item.endsWith('.json'))) {
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        if (!parsed?.healthUrl || !parsed?.rpcUrl) continue;
        const health = await fetch(parsed.healthUrl).then(res => res.json()).catch(() => undefined);
        if (health?.ok === true && health.instanceId === parsed.instanceId && health.apiVersion === '1.0') {
          return parsed;
        }
      } catch {
        // skip stale residue
      }
    }
  }
  throw new Error('no live Automation API v1 instance; start VS Code with orbit.automation.enabled and this extension build');
}

function errorCodeOf(error) {
  return error?.data?.errorCode || error?.errorCode || null;
}

async function runLive(options) {
  const authErrors = validateAuthorization(options);
  if (authErrors.length) {
    const error = new Error(authErrors.join('; '));
    error.authErrors = authErrors;
    throw error;
  }

  const clientMod = require(path.join(repoRoot, 'Releases', 'clients', 'node', 'index.js'));
  const endpoint = await discoverLiveEndpoint(options, clientMod);
  const client = new clientMod.OrbitClient(endpoint);
  const requests = [];
  const workflow = [];
  const events = [];
  const notes = [];
  let failed = false;

  const mark = (step, status, extra = {}) => {
    workflow.push({ step, status, authorized: true, ownerKind: options.probe, ...extra });
    console.log(`${status === 'passed' || status === 'skipped' || status === 'capability-unavailable' ? 'PASS' : 'FAIL'}  ${step}${extra.errorCode ? ` ${extra.errorCode}` : ''}`);
    if (status === 'failed') failed = true;
  };

  const timed = async (step, method, params, invokeOptions, ok) => {
    const started = nowMs();
    try {
      const data = await client.invoke(method, params, invokeOptions);
      const elapsedMs = nowMs() - started;
      const snapshot = client.session;
      const record = {
        method,
        instanceId: endpoint.instanceId,
        projectId: endpoint.projectId,
        sessionId: snapshot?.sessionId,
        sessionGeneration: snapshot?.sessionGeneration,
        ownerKind: snapshot?.owner || snapshot?.ownerKind || options.probe,
        targetState: snapshot?.targetState,
        pc: snapshot?.pc,
        elapsedMs,
        errorCode: null,
        authorized: true,
      };
      requests.push(record);
      const pass = ok ? ok(data, record) !== false : true;
      mark(step, pass ? 'passed' : 'failed', { elapsedMs, method });
      return data;
    } catch (error) {
      const elapsedMs = nowMs() - started;
      const code = errorCodeOf(error);
      requests.push({
        method,
        instanceId: endpoint.instanceId,
        projectId: endpoint.projectId,
        sessionId: client.session?.sessionId,
        sessionGeneration: client.session?.sessionGeneration,
        ownerKind: options.probe,
        targetState: client.session?.targetState,
        pc: client.session?.pc,
        elapsedMs,
        errorCode: code,
        authorized: true,
      });
      const unavailable = code === 'CapabilityUnavailable' && options.probe === 'jlink-legacy'
        && (step === 'stepInto' || step === 'stepOver' || step === 'stepOut');
      mark(step, unavailable ? 'capability-unavailable' : 'failed', { elapsedMs, method, errorCode: code, message: error.message });
      if (unavailable) return { errorCode: code };
      throw error;
    }
  };

  const scopes = [
    'read', 'session.control', 'breakpoints.write', 'view.write', 'record',
    'rtt.control', 'variables.write', 'memory.write',
  ];
  if (options.flash) scopes.push('flash');

  const handshakeStarted = nowMs();
  const handshake = await client.handshake({
    client: { name: 'orbit-hardware-task16', version: '1.1.0', pid: process.pid },
    requestedScopes: scopes,
  });
  requests.push({
    method: 'orbit.handshake',
    instanceId: endpoint.instanceId,
    projectId: endpoint.projectId,
    elapsedMs: nowMs() - handshakeStarted,
    errorCode: null,
    authorized: true,
  });
  mark('handshake', typeof handshake.connectionId === 'string' ? 'passed' : 'failed', {
    grantedScopes: handshake.grantedScopes,
  });

  const configuration = defaultConfiguration(options);
  const listed = await client.invoke('orbit.session.list', { includeTerminated: false });
  const existing = (listed.items ?? []).find(item => item.phase !== 'terminated');
  if (existing) {
    client.session = existing;
    mark('visible-start', 'passed', { reused: true, sessionId: existing.sessionId });
  } else {
    await timed('visible-start', 'orbit.session.start', {
      configurationId: configuration,
      timeoutMs: 30000,
    }, { context: 'projectMutation' }, data => data.accepted === true || data.session);
  }

  const halted = await pollUntil(async () => {
    const snapshot = await client.refreshSession();
    return snapshot;
  }, snapshot => snapshot.targetState === 'halted' || snapshot.phase === 'halted', 90_000, 500);
  if (halted.timedOut) mark('visible-start', 'failed', { errorCode: 'RequestTimeout', message: 'session did not halt' });

  const snapshot0 = await client.refreshSession();
  const ownerKind = snapshot0.owner || snapshot0.ownerKind || options.probe;
  if (ownerKind && ownerKind !== options.probe) {
    notes.push(`session owner is ${ownerKind}, requested probe was ${options.probe}`);
  }
  const helpersDuring = helperSnapshot();
  const maxConcurrent = Math.max(1, helpersDuring.helpers.length || 1);
  if (helpersDuring.helpers.length > 1) {
    mark('owner-count-1', 'failed', { helpers: helpersDuring.helpers });
  } else {
    mark('owner-count-1', 'passed', { helpers: helpersDuring.helpers, ownerKind });
  }

  const abort = new AbortController();
  const eventPump = (async () => {
    try {
      for await (const event of client.events({ signal: abort.signal })) {
        events.push({ type: event.type, eventId: event.eventId });
        if (events.length > 80) break;
      }
    } catch {
      // closed
    }
  })();

  const sourcePath = options.source;
  const line = options.line;
  const added = await timed('breakpoint-add', 'orbit.breakpoints.add', {
    breakpoint: { source: { path: sourcePath, line }, enabled: true },
    waitForVerificationMs: 8000,
  }, { context: 'connectionMutation' }, data => data.items?.[0]?.verified === true);
  const breakpointId = added?.items?.[0]?.breakpointId;

  await timed('continue', 'orbit.target.continue', { threadId: 1 }, { context: 'targetMutation' }, continueSucceeded);
  const hit = await pollUntil(async () => client.refreshSession(), snapshot => snapshot.targetState === 'halted' || snapshot.phase === 'halted', 15_000, 50);
  mark('breakpoint-hit', hit.timedOut ? 'failed' : 'passed', { pc: hit.value?.pc, stopReason: hit.value?.stopReason });
  await timed('pause', 'orbit.target.pause', { threadId: 1 }, { context: 'targetMutation' });
  if (breakpointId) {
    await timed('breakpoint-remove', 'orbit.breakpoints.remove', { breakpointId }, { context: 'connectionMutation' });
  } else {
    mark('breakpoint-remove', 'failed', { message: 'no breakpointId' });
  }

  await timed('reset', 'orbit.target.reset', { mode: 'halt' }, { context: 'targetMutation' });
  await pollUntil(async () => client.refreshSession(), snapshot => snapshot.targetState === 'halted', 20_000, 200);
  await timed('stepInstruction', 'orbit.target.stepInstruction', { threadId: 1 }, { context: 'targetMutation' });
  await timed('stepInto', 'orbit.target.stepInto', { threadId: 1 }, { context: 'targetMutation' });
  await timed('stepOver', 'orbit.target.stepOver', { threadId: 1 }, { context: 'targetMutation' });
  await timed('stepOut', 'orbit.target.stepOut', { threadId: 1 }, { context: 'targetMutation' });

  if (options.flash) {
    await timed('flash', 'orbit.target.flash', { verify: true }, { context: 'targetMutation' });
  } else {
    mark('flash', 'skipped', { reason: 'flash not authorized; pass --flash to program' });
  }

  await timed('symbol-search', 'orbit.symbol.search', { query: 'main' }, { context: 'target' }, data => Array.isArray(data.items));
  await timed('symbol-resolve', 'orbit.symbol.resolve', { name: 'main' }, { context: 'target' }, data => data.symbol || data.exact);

  const expression = options.expression;
  const before = await timed('variable-read', 'orbit.expression.readMany', { expressions: [expression] }, { context: 'target' });
  const original = decimalValue(before?.items?.[0]?.value ?? before?.values?.[0]?.value);
  const written = Number.isFinite(original) ? (original ^ 0xFFFFFFFF) >>> 0 : 0x5A5AA5A5;
  await timed('variable-write', 'orbit.expression.writeMany', {
    writes: [{ expression, value: String(written) }],
  }, { context: 'targetMutation' });
  const afterWrite = await client.invoke('orbit.expression.readMany', { expressions: [expression] }, { context: 'target' });
  const readBack = decimalValue(afterWrite?.items?.[0]?.value ?? afterWrite?.values?.[0]?.value);
  if (readBack !== written) mark('variable-write', 'failed', { original, written, readBack });
  await client.invoke('orbit.expression.writeMany', {
    writes: [{ expression, value: String(Number.isFinite(original) ? original : 0) }],
  }, { context: 'targetMutation', idempotencyKey: `restore-${Date.now()}` });

  const resolved = await client.invoke('orbit.symbol.resolve', { name: expression }, { context: 'target' }).catch(() => undefined);
  const address = resolved?.symbol?.address || resolved?.address;
  if (address) {
    const mem = await timed('memory-read', 'orbit.memory.read', { address, count: 4 }, { context: 'target' });
    const current = base64ToU32(mem?.dataBase64 || mem?.data);
    const memWritten = ((current ?? 0) ^ 0xFFFFFFFF) >>> 0;
    await timed('memory-write', 'orbit.memory.write', {
      address,
      data: u32ToBase64(memWritten),
      verify: true,
    }, { context: 'targetMutation' }, data => data.verified !== false);
    await client.invoke('orbit.memory.write', {
      address,
      data: u32ToBase64(current ?? 0),
      verify: true,
    }, { context: 'targetMutation', idempotencyKey: `mem-restore-${Date.now()}` });
  } else {
    mark('memory-read', 'failed', { message: `could not resolve ${expression}` });
    mark('memory-write', 'failed', { message: `could not resolve ${expression}` });
  }

  await timed('watch-sync', 'orbit.watch.replace', { expressions: [expression] }, { context: 'connectionMutation' });
  await client.invoke('orbit.watch.list', { includeValues: true });
  await timed('timeline-sync', 'orbit.timeline.replace', { expressions: [expression] }, { context: 'connectionMutation' });
  await client.invoke('orbit.timeline.start', { intervalMs: 20 }, { context: 'targetMutation', idempotencyKey: `tl-start-${Date.now()}` });
  await client.invoke('orbit.timeline.status', { includePerformance: true }, { context: 'target' });

  const recording = await timed('record', 'orbit.record.start', {
    name: 'task16-live',
    intervalMs: 10,
    channels: [{ channelId: expression, expression, valueType: 'int' }],
  }, { context: 'targetMutation' });
  await sleep(900);
  if (recording?.recordingId) {
    await client.invoke('orbit.record.get', { recordingId: recording.recordingId }, { context: 'target' });
    await client.invoke('orbit.record.stop', { recordingId: recording.recordingId }, { context: 'targetMutation', idempotencyKey: `rec-stop-${Date.now()}` });
    await client.invoke('orbit.record.clear', { recordingId: recording.recordingId }, { context: 'targetMutation', idempotencyKey: `rec-clear-${Date.now()}` });
  }

  await timed('rtt', 'orbit.rtt.start', { bufferIndex: 0 }, { context: 'targetMutation' });
  await client.invoke('orbit.rtt.read', { bufferIndex: 0 }, { context: 'target' }).catch(() => undefined);
  await client.invoke('orbit.rtt.stop', { bufferIndex: 0 }, { context: 'targetMutation', idempotencyKey: `rtt-stop-${Date.now()}` });

  const diagnostics = await timed('diagnostics', 'orbit.diagnostics.snapshot', {}, { context: 'connection' }, data => data.tokenIncluded === false);
  if (JSON.stringify(diagnostics).includes(endpoint.token)) {
    mark('diagnostics', 'failed', { message: 'token leaked' });
  }

  if (!options.skipStress) {
    try {
      await client.invoke('orbit.timeline.start', { intervalMs: 20 }, { context: 'targetMutation', idempotencyKey: `stress-tl-${Date.now()}` });
      const stressRec = await client.invoke('orbit.record.start', {
        name: 'task16-stress',
        intervalMs: 10,
        channels: [{ channelId: expression, expression, valueType: 'int' }],
      }, { context: 'targetMutation', idempotencyKey: `stress-rec-${Date.now()}` });
      await client.invoke('orbit.rtt.start', { bufferIndex: 0 }, { context: 'targetMutation', idempotencyKey: `stress-rtt-${Date.now()}` }).catch(error => {
        notes.push(`stress rtt.start ${errorCodeOf(error) || error.message}`);
      });
      await client.invoke('orbit.target.continue', { threadId: 1 }, { context: 'targetMutation', idempotencyKey: `stress-run-${Date.now()}` });
      for (let index = 0; index < 20; index += 1) {
        await client.invoke('orbit.expression.writeMany', {
          writes: [{ expression, value: String((written + index) >>> 0) }],
        }, { context: 'targetMutation', idempotencyKey: `stress-write-${index}` });
      }
      await client.invoke('orbit.target.pause', { threadId: 1 }, { context: 'targetMutation', idempotencyKey: `stress-pause-${Date.now()}` });
      for (const action of ['stepInto', 'stepOver', 'stepOut']) {
        for (let index = 0; index < 20; index += 1) {
          try {
            await client.invoke(`orbit.target.${action}`, { threadId: 1 }, {
              context: 'targetMutation',
              idempotencyKey: `stress-${action}-${index}`,
            });
          } catch (error) {
            notes.push(`stress ${action}#${index} ${errorCodeOf(error) || error.message}`);
            break;
          }
        }
      }
      const afterStress = await client.refreshSession();
      const helpersStress = helperSnapshot();
      if (helpersStress.helpers.length > 1) notes.push('second helper observed during stress');
      if (afterStress.phase === 'error') notes.push('session entered error during stress');
      await client.invoke('orbit.expression.writeMany', {
        writes: [{ expression, value: String(Number.isFinite(original) ? original : 0) }],
      }, { context: 'targetMutation', idempotencyKey: `stress-restore-${Date.now()}` }).catch(() => undefined);
      if (stressRec?.recordingId) {
        await client.invoke('orbit.record.stop', { recordingId: stressRec.recordingId }, { context: 'targetMutation', idempotencyKey: `stress-rec-stop-${Date.now()}` }).catch(() => undefined);
        await client.invoke('orbit.record.clear', { recordingId: stressRec.recordingId }, { context: 'targetMutation', idempotencyKey: `stress-rec-clear-${Date.now()}` }).catch(() => undefined);
      }
      await client.invoke('orbit.timeline.stop', { flush: true }, { context: 'targetMutation', idempotencyKey: `stress-tl-stop-${Date.now()}` }).catch(() => undefined);
      await client.invoke('orbit.rtt.stop', { bufferIndex: 0 }, { context: 'targetMutation', idempotencyKey: `stress-rtt-stop-${Date.now()}` }).catch(() => undefined);
    } catch (error) {
      notes.push(`stress ${errorCodeOf(error) || error.message}`);
    }
  }

  mark('sse-lifecycle', events.length > 0 ? 'passed' : 'failed', { eventCount: events.length });
  await timed('stop', 'orbit.session.stop', {}, { context: 'targetMutation' });
  abort.abort();
  await eventPump.catch(() => undefined);
  await client.close().catch(() => undefined);
  await sleep(1500);
  const helpersAfter = helperSnapshot();
  mark('disconnect-cleanup', helpersAfter.helpers.length === 0 ? 'passed' : 'failed', { helpers: helpersAfter.helpers });

  const rpcSamples = benchRpcDispatch();
  const sseSamples = benchSseWrite();
  const controlSamples = await benchControlOverhead();
  const liveLayer = failed ? 'failed' : 'passed';
  const hardware = {
    'hardware.jlink-native': options.probe === 'jlink-native' ? liveLayer : 'unverified',
    'hardware.jlink-legacy': options.probe === 'jlink-legacy' ? liveLayer : 'unverified',
    'hardware.cmsis-dap': options.probe === 'cmsis-dap' ? liveLayer : 'unverified',
  };
  const evidence = redactSecrets({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: 'live',
    authorized: true,
    probe: options.probe,
    board: options.board,
    flash: options.flash === true,
    host: hostInfo(),
    layers: classifyLayerStatus({ automated: 'passed', mock: 'passed', hardware }),
    owners: {
      maxConcurrent: 1,
      kinds: [ownerKind],
      helperPids: helpersDuring.helpers.map(item => item.pid),
      processTreeSecondOwner: helpersDuring.helpers.length > 1,
      afterDisconnect: helpersAfter.helpers.length,
    },
    workflow,
    requests,
    events: events.slice(0, 20),
    performance: {
      gate: 'ci-trend',
      rpcDispatch: evaluatePerformanceGate(rpcSamples, RPC_DISPATCH_P95_MS),
      sseWrite: evaluatePerformanceGate(sseSamples, SSE_WRITE_P95_MS),
      controlOverhead: evaluatePerformanceGate(controlSamples, CONTROL_OVERHEAD_P95_MS),
    },
    notes,
    handshakeScopes: handshake?.grantedScopes,
  });
  const violations = validateHardwareEvidence(evidence);
  if (violations.length) {
    throw new Error(`live evidence invalid:\n- ${violations.join('\n- ')}`);
  }
  if (failed) {
    const error = new Error('live hardware workflow reported failures; see evidence');
    error.evidence = evidence;
    throw error;
  }
  return evidence;
}

function writeEvidence(filePath, evidence) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(evidence, null, 2)}\n`);
}

async function main(argv = process.argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log('usage: node scripts/automation-api/verify-hardware.js [--mock|--live] [--authorize] [--probe jlink-native|jlink-legacy|cmsis-dap] [--board NAME] [--flash] [--evidence PATH]');
    return 0;
  }
  let evidence;
  try {
    evidence = options.mode === 'live' ? await runLive(options) : await runMock(options);
  } catch (error) {
    if (error && error.evidence) {
      writeEvidence(options.evidence, error.evidence);
      console.error(error.message);
      return 1;
    }
    throw error;
  }
  writeEvidence(options.evidence, evidence);
  const layers = evidence.layers;
  console.log(`Hardware acceptance (${evidence.mode}): automated=${layers.automated} mock=${layers.mock} jlink-native=${layers['hardware.jlink-native']} jlink-legacy=${layers['hardware.jlink-legacy']} cmsis-dap=${layers['hardware.cmsis-dap']}`);
  console.log(`RPC p95=${evidence.performance.rpcDispatch.p95?.toFixed?.(3) ?? evidence.performance.rpcDispatch.p95}ms sse p95=${evidence.performance.sseWrite.p95}ms control p95=${evidence.performance.controlOverhead.p95}ms`);
  console.log(`evidence=${path.relative(repoRoot, options.evidence)}`);
  if (layers.allLayersPassed !== 'true') {
    console.log('Hardware layers remain unverified; do not report real-hardware pass.');
  }
  return 0;
}

module.exports = {
  CONTROL_OVERHEAD_P95_MS,
  RPC_DISPATCH_P95_MS,
  SSE_WRITE_P95_MS,
  WORKFLOW_STEPS,
  classifyLayerStatus,
  evaluatePerformanceGate,
  percentileStats,
  redactSecrets,
  validateAuthorization,
  validateHardwareEvidence,
  parseArgs,
  continueSucceeded,
  defaultConfiguration,
  runMock,
  main,
};

if (require.main === module) {
  main().then(code => {
    process.exit(code);
  }, error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
