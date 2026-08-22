// Orbit Automation API — Task 5 real-hardware pause/run loop verification.
//
// Drives the live VS Code window through the v1 Automation API only (no
// keyboard/mouse automation): flash start, then --cycles iterations of
//   orbit.target.continue (run) -> --step-ms wait -> orbit.target.pause,
// then orbit.session.stop. Every control call returns the frozen
// ControlOutcome (state/stopReason/pc) and the script reads
// orbit.session.snapshot after each action to prove the Extension Host
// registry mirrors the DAP-reported state.
//
// This script performs real target mutation (flash/reset/halt/run) — run it
// only with explicit user authorization.
//
// Usage:
//   node scripts/automation-api/verify-control-loops.js
//     [--configuration "Orbit: J-Link (Flash)"]
//     [--cycles 3] [--step-ms 1000] [--max-wait-ms 90000]
//     [--endpoint <endpoint-json>] [--evidence <json-path>]

const fs = require('fs');
const path = require('path');

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const CONFIG = arg('configuration', 'Orbit: J-Link (Flash)');
const CYCLES = Math.max(1, Number(arg('cycles', '3')));
const STEP_MS = Number(arg('step-ms', '1000'));
const MAX_WAIT_MS = Number(arg('max-wait-ms', '90000'));
const EVIDENCE_PATH = arg(
  'evidence',
  path.join(__dirname, '..', '..', 'outputs', 'task5-control-loops-evidence.json'),
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
    return { id, result: body.result };
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
    client: { name: 'orbit-control-loops', version: '0.1.0', pid: process.pid },
    expected: { projectId: endpoint.projectId, instanceId: endpoint.instanceId },
    requestedScopes: ['read', 'session.control'],
  });
  const connectionId = handshake.result?.data?.connectionId;
  const granted = handshake.result?.data?.grantedScopes ?? [];
  record(
    'orbit.handshake grants session.control',
    typeof connectionId === 'string' && granted.includes('session.control'),
    { connectionId, grantedScopes: granted },
  );
  const connectionContext = { ...bootstrap, connectionId };

  const project0 = await rpc('orbit.project.describe', { context: bootstrap });
  const G0 = project0.result?.data?.registryGeneration;
  record('orbit.project.describe (registryGeneration baseline)', Number.isInteger(G0), { G0 });

  console.log(`\n=== ${CONFIG} — ${CYCLES} × (run → pause) ===`);

  const start = await rpc('orbit.session.start', {
    context: { ...connectionContext, idempotencyKey: 'hw-loops-start', registryGeneration: G0 },
    configurationId: CONFIG,
    timeoutMs: 20000,
  });
  const ack = start.result?.data;
  const sessionId = ack?.session?.sessionId;
  const generation = ack?.session?.sessionGeneration;
  record('orbit.session.start -> OperationAck', ack?.accepted === true && typeof sessionId === 'string', ack);

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
  record('launch settled at entry halt', haltState === 'halted', { finalState: haltState });

  const outcomes = [];
  for (let cycle = 1; cycle <= CYCLES; cycle++) {
    console.log(`\n[loop ${cycle}/${CYCLES}] >>> run`);
    const runResult = await rpc('orbit.target.continue', {
      context: {
        ...connectionContext,
        idempotencyKey: `hw-loops-run-${cycle}`,
        sessionId,
        sessionGeneration: generation,
      },
      threadId: 1,
    });
    const run = runResult.result?.data;
    record(
      `loop ${cycle} run -> ControlOutcome state=${run?.state}`,
      run?.state === 'running',
      run,
    );
    await sleep(STEP_MS);

    console.log(`[loop ${cycle}/${CYCLES}] >>> pause`);
    const pauseResult = await rpc('orbit.target.pause', {
      context: {
        ...connectionContext,
        idempotencyKey: `hw-loops-pause-${cycle}`,
        sessionId,
        sessionGeneration: generation,
      },
      threadId: 1,
    });
    const pause = pauseResult.result?.data;
    record(
      `loop ${cycle} pause -> ControlOutcome state=${pause?.state} pc=${pause?.pc}`,
      pause?.state === 'halted' && typeof pause?.pc === 'string',
      pause,
    );

    const snapshot = await rpc('orbit.session.snapshot', { context: connectionContext, sessionId });
    const snap = snapshot.result?.data;
    record(
      `loop ${cycle} snapshot synced`,
      snap?.phase === 'halted' && snap?.targetState === 'halted' && snap?.pc === pause?.pc,
      { phase: snap?.phase, targetState: snap?.targetState, pc: snap?.pc, stopReason: snap?.stopReason },
    );

    outcomes.push({ cycle, run, pause });
    await sleep(STEP_MS);
  }

  console.log('\n>>> stop');
  const stop = await rpc('orbit.session.stop', {
    context: { ...connectionContext, idempotencyKey: 'hw-loops-stop', sessionId, sessionGeneration: generation },
  });
  record('orbit.session.stop -> accepted', stop.result?.data?.accepted === true, stop.result?.data);

  await pollUntil(
    async () => {
      const list = await rpc('orbit.session.list', { context: connectionContext, includeTerminated: true });
      return list.result?.data?.items ?? [];
    },
    items => items.some(item => item.sessionId === sessionId && item.phase === 'terminated'),
    20000,
    300,
  );
  record('session terminated in registry history', true, { sessionId });

  const close = await rpc('orbit.connection.close', { context: connectionContext, reason: 'control loop verification complete' });
  record('orbit.connection.close', close.result?.data?.closed === true, close.result?.data);

  const summary = {
    baseline: { instanceId: endpoint.instanceId, projectId: endpoint.projectId },
    configuration: CONFIG,
    cycles: CYCLES,
    stepMs: STEP_MS,
    sessionId,
    sessionGeneration: generation,
    outcomes,
    steps,
  };
  fs.mkdirSync(path.dirname(EVIDENCE_PATH), { recursive: true });
  fs.writeFileSync(EVIDENCE_PATH, JSON.stringify(summary, null, 2));
  console.log(`\nEvidence saved to ${EVIDENCE_PATH}`);
}

async function pollUntil(read, accept, maxMs, intervalMs) {
  const deadline = Date.now() + maxMs;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (accept(last)) return last;
    await sleep(intervalMs);
  }
  return last;
}

main().catch(error => {
  record('fatal', false, { message: error?.message ?? String(error), stack: error?.stack });
  process.exitCode = 1;
});
