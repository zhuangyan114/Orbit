// Orbit Automation API — Task 6 real-hardware breakpoint verification.
//
// Drives the live VS Code window through the v1 Automation API only (no
// keyboard/mouse automation):
//   session start (flash) -> orbit.breakpoints.add (freertos.c StartTask02
//   loop) -> orbit.breakpoints.list (verified/slot merge) ->
//   orbit.target.continue -> breakpoint hit (target halts) ->
//   orbit.target.pause (read the halted PC) -> orbit.breakpoints.remove ->
//   orbit.target.continue (runs freely, proving removal) -> session.stop.
//
// This script performs real target mutation (flash/halt/run and hardware
// breakpoint programming) — run it only with explicit user authorization.
//
// Usage:
//   node scripts/automation-api/verify-breakpoints.js
//     [--configuration "Orbit: J-Link (Flash)"]
//     [--file <source-path>] [--line 402]
//     [--max-wait-ms 90000] [--endpoint <endpoint-json>]
//     [--evidence <json-path>]

const fs = require('fs');
const path = require('path');

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const CONFIG = arg('configuration', 'Orbit: J-Link (Flash)');
const SOURCE_PATH = arg('file', 'd:\\STM32\\project\\vet6_led\\Core\\Src\\freertos.c');
const LINE = Number(arg('line', '402'));
const MAX_WAIT_MS = Number(arg('max-wait-ms', '90000'));
const EVIDENCE_PATH = arg(
  'evidence',
  path.join(__dirname, '..', '..', 'outputs', 'task6-breakpoint-evidence.json'),
);

const steps = [];
function record(step, ok, detail) {
  steps.push({ step, ok, at: new Date().toISOString(), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`);
  if (!ok) process.exitCode = 1;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function httpJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

function discoverEndpointFile() {
  const explicit = arg('endpoint', '');
  if (explicit) {
    if (!fs.existsSync(explicit)) throw new Error(`endpoint file not found: ${explicit}`);
    return path.resolve(explicit);
  }
  const dir = path.join(
    process.env.APPDATA,
    'Code',
    'User',
    'globalStorage',
    'orbit-debug.orbit-for-vscode',
    'automation-api',
    'endpoints',
  );
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(name => name.endsWith('.json')) : [];
  if (files.length === 0) throw new Error(`no endpoint files under ${dir}`);
  if (files.length > 1) {
    throw new Error(`ambiguous instance: ${files.length} endpoints under ${dir}; specify one explicitly`);
  }
  return path.join(dir, files[0]);
}

async function pollUntil(read, accept, maxMs, intervalMs, label) {
  const deadline = Date.now() + maxMs;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (accept(last)) return { value: last, elapsedMs: maxMs - (deadline - Date.now()) };
    await sleep(intervalMs);
  }
  return { value: last, elapsedMs: maxMs, timedOut: true, label };
}

async function main() {
  const endpointFile = discoverEndpointFile();
  const endpoint = JSON.parse(fs.readFileSync(endpointFile, 'utf8'));
  const token = endpoint.token;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  let nextId = 0;
  const rpc = async (method, params) => {
    const id = `hw-${String(++nextId).padStart(3, '0')}`;
    const { status, body } = await httpJson(endpoint.rpcUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    if (status !== 200) throw new Error(`HTTP ${status} on ${method}: ${JSON.stringify(body)}`);
    if (body.error) {
      const error = new Error(`${method} -> ${body.error.message}`);
      error.data = body.error.data;
      throw error;
    }
    return body.result;
  };
  const legacyRpc = async (method, params) => {
    const url = endpoint.rpcUrl.replace(/\/v1\/rpc$/, '/rpc');
    const { status, body } = await httpJson(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: `legacy-${++nextId}`, method, params }),
    });
    if (status !== 200 || body?.ok !== true) {
      throw new Error(`legacy ${method} failed: HTTP ${status} ${JSON.stringify(body)}`);
    }
    return body.data;
  };

  const bootstrap = { instanceId: endpoint.instanceId, projectId: endpoint.projectId };

  const health = await httpJson(endpoint.healthUrl);
  record(
    '/health',
    health.status === 200 && health.body?.status === 'ok' && health.body?.instanceId === endpoint.instanceId,
    health.body,
  );

  const handshake = await rpc('orbit.handshake', {
    context: bootstrap,
    apiVersion: '1.0',
    client: { name: 'orbit-breakpoints', version: '0.1.0', pid: process.pid },
    expected: { projectId: endpoint.projectId, instanceId: endpoint.instanceId },
    requestedScopes: ['read', 'session.control', 'breakpoints.write'],
  });
  const connectionId = handshake?.data?.connectionId;
  const granted = handshake?.data?.grantedScopes ?? [];
  record(
    'orbit.handshake grants breakpoints.write',
    typeof connectionId === 'string' && granted.includes('breakpoints.write'),
    { connectionId, grantedScopes: granted },
  );
  const connectionContext = { ...bootstrap, connectionId };

  const project0 = await rpc('orbit.project.describe', { context: bootstrap });
  const G0 = project0?.data?.registryGeneration;
  record('orbit.project.describe (registryGeneration baseline)', Number.isInteger(G0), { G0 });

  // --- ensure a visible Orbit session exists ---------------------------------
  const existing = await rpc('orbit.session.list', { context: connectionContext });
  const usable = (existing?.data?.items ?? []).find(item => item.phase !== 'terminated');
  let sessionId;
  let generation;
  if (usable) {
    sessionId = usable.sessionId;
    generation = usable.sessionGeneration;
    record('reusing an already-active session', true, { sessionId, sessionGeneration: generation });
  } else {
    const start = await rpc('orbit.session.start', {
      context: { ...connectionContext, idempotencyKey: 'hw-bp-start', registryGeneration: G0 },
      configurationId: CONFIG,
      timeoutMs: 20000,
    });
    const ack = start?.data;
    sessionId = ack?.session?.sessionId;
    generation = ack?.session?.sessionGeneration;
    record('orbit.session.start -> OperationAck', ack?.accepted === true && typeof sessionId === 'string', ack);
  }

  const haltState = await pollUntil(
    async () => {
      try {
        return (await legacyRpc('ozone.target.getState', {})).state;
      } catch (error) {
        return `error:${error.message}`;
      }
    },
    value => value === 'halted',
    MAX_WAIT_MS,
    500,
  );
  record('launch settled at entry halt', haltState.value === 'halted', { state: haltState.value });

  // --- add the breakpoint -----------------------------------------------------
  const breakpointInput = {
    source: { path: SOURCE_PATH, line: LINE },
    enabled: true,
  };
  const add = await rpc('orbit.breakpoints.add', {
    context: { ...connectionContext, idempotencyKey: 'hw-bp-add' },
    breakpoint: breakpointInput,
    waitForVerificationMs: 8000,
  });
  const added = add?.data;
  record(
    `orbit.breakpoints.add -> verified=${added?.items?.[0]?.verified} slot=${added?.items?.[0]?.slot}`,
    added?.items?.[0]?.verified === true && Number.isInteger(added?.items?.[0]?.slot),
    added,
  );

  const listAfterAdd = await rpc('orbit.breakpoints.list', {
    context: connectionContext,
    sourcePath: SOURCE_PATH,
  });
  const listed = (listAfterAdd?.data?.items ?? []).find(
    item => item.source?.line === LINE && item.source?.path.toLowerCase() === SOURCE_PATH.toLowerCase(),
  );
  record(
    'orbit.breakpoints.list shows the verified breakpoint (merged)',
    !!listed && listed.verified === true && listed.slot === added?.items?.[0]?.slot,
    listed,
  );

  // --- run and wait for the hardware breakpoint to hit -----------------------
  const continue1 = await rpc('orbit.target.continue', {
    context: {
      ...connectionContext,
      idempotencyKey: 'hw-bp-run-1',
      sessionId,
      sessionGeneration: generation,
    },
    threadId: 1,
  });
  record(
    `orbit.target.continue -> state=${continue1?.data?.state}`,
    continue1?.data?.state === 'running',
    continue1?.data,
  );

  const hit = await pollUntil(
    async () => {
      try {
        return (await legacyRpc('ozone.target.getState', {})).state;
      } catch (error) {
        return `error:${error.message}`;
      }
    },
    value => value === 'halted',
    10000,
    20,
  );
  record('breakpoint hit: target halted', hit.value === 'halted', { state: hit.value, elapsedMs: hit.elapsedMs });

  // Read the halted PC through the automation pause core (the target is already
  // halted at the breakpoint; pause reports the settled state and PC).
  const pause = await rpc('orbit.target.pause', {
    context: {
      ...connectionContext,
      idempotencyKey: 'hw-bp-pause',
      sessionId,
      sessionGeneration: generation,
    },
    threadId: 1,
  });
  const pc = pause?.data?.pc;
  record(
    `breakpoint PC read back -> ${pc}`,
    pause?.data?.state === 'halted' && typeof pc === 'string' && /^0x[0-9a-f]+$/.test(pc),
    pause?.data,
  );

  // --- remove the breakpoint and prove the target runs freely ----------------
  const remove = await rpc('orbit.breakpoints.remove', {
    context: { ...connectionContext, idempotencyKey: 'hw-bp-remove' },
    breakpointId: added?.items?.[0]?.breakpointId,
  });
  record(
    'orbit.breakpoints.remove -> removed item reported',
    remove?.data?.items?.[0]?.breakpointId === added?.items?.[0]?.breakpointId,
    remove?.data,
  );

  const listAfterRemove = await rpc('orbit.breakpoints.list', {
    context: connectionContext,
    sourcePath: SOURCE_PATH,
  });
  const remaining = (listAfterRemove?.data?.items ?? []).filter(item => item.source?.line === LINE);
  record('orbit.breakpoints.list is empty after remove', remaining.length === 0, { remaining: remaining.length });

  const continue2 = await rpc('orbit.target.continue', {
    context: {
      ...connectionContext,
      idempotencyKey: 'hw-bp-run-2',
      sessionId,
      sessionGeneration: generation,
    },
    threadId: 1,
  });
  record(
    `orbit.target.continue (after remove) -> state=${continue2?.data?.state}`,
    continue2?.data?.state === 'running',
    continue2?.data,
  );

  await sleep(1500);
  const stillRunning = await pollUntil(
    async () => {
      try {
        return (await legacyRpc('ozone.target.getState', {})).state;
      } catch (error) {
        return `error:${error.message}`;
      }
    },
    value => value === 'running',
    2000,
    100,
  );
  record('target keeps running after breakpoint removal', stillRunning.value === 'running', {
    state: stillRunning.value,
  });

  // --- cleanup: halt and stop the session ------------------------------------
  await rpc('orbit.target.pause', {
    context: {
      ...connectionContext,
      idempotencyKey: 'hw-bp-pause-final',
      sessionId,
      sessionGeneration: generation,
    },
    threadId: 1,
  });
  const stop = await rpc('orbit.session.stop', {
    context: { ...connectionContext, idempotencyKey: 'hw-bp-stop', sessionId, sessionGeneration: generation },
  });
  record('orbit.session.stop -> accepted', stop?.data?.accepted === true, stop?.data);

  const close = await rpc('orbit.connection.close', {
    context: connectionContext,
    reason: 'breakpoint verification complete',
  });
  record('orbit.connection.close', close?.data?.closed === true, close?.data);

  const summary = {
    baseline: { instanceId: endpoint.instanceId, projectId: endpoint.projectId },
    configuration: CONFIG,
    breakpoint: { path: SOURCE_PATH, line: LINE },
    sessionId,
    sessionGeneration: generation,
    add: added,
    listAfterAdd: listed,
    hit: { state: hit.value, elapsedMs: hit.elapsedMs },
    pausePc: pc,
    remove: remove?.data,
    steps,
  };
  fs.mkdirSync(path.dirname(EVIDENCE_PATH), { recursive: true });
  fs.writeFileSync(EVIDENCE_PATH, JSON.stringify(summary, null, 2));
  console.log(`\nEvidence saved to ${EVIDENCE_PATH}`);
}

main().catch(error => {
  record('fatal', false, { message: error?.message ?? String(error), stack: error?.stack, data: error?.data });
  process.exitCode = 1;
});
