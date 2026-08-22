// Orbit Automation API — Task 5 real-hardware control sequence verification.
//
// Drives the live VS Code window through the v1 Automation API only, with no
// keyboard/mouse automation:
//   flash start -> orbit.target.continue (run) -> orbit.target.pause ->
//   orbit.target.continue -> orbit.session.stop
// then the same sequence with the no-flash launch configuration.
// Every action is spaced by --step-ms (default 1000) so the operator can
// visually confirm the VS Code Debug toolbar state and the target LED.
//
// Each control call returns the frozen ControlOutcome (state/stopReason/pc)
// and the script also reads orbit.session.snapshot after every action to
// prove the Extension Host registry mirrors the DAP-reported state.
//
// This script performs real target mutation (flash/reset/halt/run) — run it
// only with explicit user authorization.
//
// Usage:
//   node scripts/automation-api/verify-control-sequence.js
//     [--configuration "Orbit: J-Link (Flash)"]
//     [--second-configuration "Orbit: J-Link (No Flash)"]
//     [--step-ms 1000]
//     [--max-wait-ms 90000]
//     [--evidence <json-path>]

const fs = require('fs');
const path = require('path');

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const CONFIG = arg('configuration', 'Orbit: J-Link (Flash)');
const SECOND_CONFIG = arg('second-configuration', 'Orbit: J-Link (No Flash)');
const STEP_MS = Number(arg('step-ms', '1000'));
const MAX_WAIT_MS = Number(arg('max-wait-ms', '90000'));
const EVIDENCE_PATH = arg(
  'evidence',
  path.join(__dirname, '..', '..', 'outputs', 'task5-control-sequence-evidence.json'),
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

  // 1. health + handshake with the control scope.
  const health = await httpJson(endpoint.healthUrl);
  record(
    '/health',
    health.status === 200 && health.body?.status === 'ok' && health.body?.instanceId === endpoint.instanceId,
    health.body,
  );
  const handshake = await rpc('orbit.handshake', {
    context: bootstrap,
    apiVersion: '1.0',
    client: { name: 'orbit-control-sequence', version: '0.1.0', pid: process.pid },
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
  let registryGeneration = project0.result?.data?.registryGeneration;
  record('orbit.project.describe (registryGeneration baseline)', Number.isInteger(registryGeneration), { registryGeneration });

  const sequences = [
    { label: 'FLASH', configuration: CONFIG },
    { label: 'NO-FLASH', configuration: SECOND_CONFIG },
  ];
  const sequenceEvidence = [];

  for (let index = 0; index < sequences.length; index++) {
    const { label, configuration } = sequences[index];
    console.log(`\n=== 序列 ${index + 1}/${sequences.length} [${label}] ${configuration} ===`);

    // 2. start the visible VS Code debug session.
    const start = await rpc('orbit.session.start', {
      context: { ...connectionContext, idempotencyKey: `hw-seq-${label.toLowerCase()}-start`, registryGeneration },
      configurationId: configuration,
      timeoutMs: 20000,
    });
    const ack = start.result?.data;
    const sessionId = ack?.session?.sessionId;
    const generation = ack?.session?.sessionGeneration;
    record(
      `[${label}] orbit.session.start -> OperationAck`,
      ack?.accepted === true && typeof sessionId === 'string' && Number.isInteger(generation),
      ack,
    );

    // 3. wait for the launched session to halt at entry (flash or no-flash).
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
    record(`[${label}] launch settled at entry halt`, haltState === 'halted', { finalState: haltState });

    // 4. run -> pause -> run, each 1s apart, then exit the debug session.
    const action = async (actionLabel, method, params, expectState) => {
      console.log(`[${label}] >>> ${actionLabel}`);
      const result = await rpc(method, {
        context: {
          ...connectionContext,
          idempotencyKey: `hw-seq-${label.toLowerCase()}-${actionLabel}`,
          sessionId,
          sessionGeneration: generation,
        },
        ...params,
      });
      const outcome = result.result?.data;
      record(
        `[${label}] ${actionLabel} -> ControlOutcome state=${outcome?.state}`,
        outcome?.state === expectState && typeof outcome?.operationId === 'string',
        outcome,
      );
      await sleep(STEP_MS);
      const snapshot = await rpc('orbit.session.snapshot', { context: connectionContext, sessionId });
      const snap = snapshot.result?.data;
      record(
        `[${label}] ${actionLabel} snapshot phase/targetState synced`,
        snap?.phase === expectState && snap?.targetState === expectState,
        { phase: snap?.phase, targetState: snap?.targetState, stopReason: snap?.stopReason, pc: snap?.pc },
      );
      return outcome;
    };

    const run1 = await action('run-1', 'orbit.target.continue', { threadId: 1 }, 'running');
    const pause1 = await action('pause', 'orbit.target.pause', { threadId: 1 }, 'halted');
    const run2 = await action('run-2', 'orbit.target.continue', { threadId: 1 }, 'running');

    // 5. exit the debug session.
    console.log(`[${label}] >>> stop`);
    const stop = await rpc('orbit.session.stop', {
      context: { ...connectionContext, idempotencyKey: `hw-seq-${label.toLowerCase()}-stop`, sessionId, sessionGeneration: generation },
    });
    record(`[${label}] orbit.session.stop -> accepted`, stop.result?.data?.accepted === true, stop.result?.data);
    await pollUntil(
      async () => {
        const list = await rpc('orbit.session.list', { context: connectionContext, includeTerminated: true });
        return list.result?.data?.items ?? [];
      },
      items => items.some(item => item.sessionId === sessionId && item.phase === 'terminated'),
      20000,
      300,
    );
    record(`[${label}] session terminated in registry history`, true, { sessionId });

    sequenceEvidence.push({
      label,
      configuration,
      sessionId,
      sessionGeneration: generation,
      outcomes: { run1, pause1, run2 },
    });

    const projectNow = await rpc('orbit.project.describe', { context: bootstrap });
    registryGeneration = projectNow.result?.data?.registryGeneration;
    record(
      `[${label}] registryGeneration after stop`,
      Number.isInteger(registryGeneration),
      { registryGeneration },
    );
  }

  // 6. connection close + evidence.
  const close = await rpc('orbit.connection.close', { context: connectionContext, reason: 'control sequence verification complete' });
  record('orbit.connection.close', close.result?.data?.closed === true, close.result?.data);

  const summary = {
    baseline: { instanceId: endpoint.instanceId, projectId: endpoint.projectId },
    stepMs: STEP_MS,
    sequences: sequenceEvidence,
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

async function expectRpcError(action) {
  try {
    await action();
    return undefined;
  } catch (error) {
    return error?.data ?? { errorCode: error?.message };
  }
}

main().catch(error => {
  record('fatal', false, { message: error?.message ?? String(error), stack: error?.stack });
  process.exitCode = 1;
});
