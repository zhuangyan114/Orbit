// Orbit Automation API — Task 3/4 real-hardware session verification client.
//
// Drives the live VS Code window through the v1 Automation API only:
//   instance.describe -> handshake -> project.describe / listLaunchConfigurations
//   -> session.list -> session.start (flash) -> halt poll -> duplicate-start and
//   generation fences -> session.stop -> terminated history -> second session
//   (no-flash) -> stop.
//
// Hardware evidence (halt after flash) is collected through the legacy
// `/rpc` `ozone.target.getState` channel, which routes through the same
// SessionRegistry/RuntimeRouter fencing added in Task 3. This script performs
// real target mutation (flash/reset) — run it only with explicit user
// authorization.
//
// Usage:
//   node scripts/automation-api/verify-session-hardware.js
//     [--configuration "Orbit: J-Link (Flash)"]
//     [--second-configuration "Orbit: J-Link (No Flash)"]
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
const MAX_WAIT_MS = Number(arg('max-wait-ms', '90000'));
const HOLD_HALTED_MS = Number(arg('hold-halted-ms', '8000'));
const OBSERVE_MS = Number(arg('observation-ms', '90000'));
const EVIDENCE_PATH = arg(
  'evidence',
  path.join(__dirname, '..', '..', 'outputs', 'task4-hardware-evidence.json'),
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

  // 1. health
  const health = await httpJson(endpoint.healthUrl);
  record(
    '/health',
    health.status === 200 && health.body?.status === 'ok' && health.body?.instanceId === endpoint.instanceId,
    health.body,
  );

  // 2. instance.describe
  const describe = await rpc('orbit.instance.describe', { context: bootstrap });
  record(
    'orbit.instance.describe',
    describe.result?.data?.instanceId === endpoint.instanceId &&
      Array.isArray(describe.result?.data?.workspaceFolders),
    describe.result?.data,
  );

  // 3. handshake with session.control
  const handshake = await rpc('orbit.handshake', {
    context: bootstrap,
    apiVersion: '1.0',
    client: { name: 'orbit-hw-verify', version: '0.1.0', pid: process.pid },
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

  // 4. project.describe -> registryGeneration G0
  const project0 = await rpc('orbit.project.describe', { context: bootstrap });
  const G0 = project0.result?.data?.registryGeneration;
  record('orbit.project.describe (registryGeneration baseline)', Number.isInteger(G0), { G0 });

  // 5. listLaunchConfigurations
  const configs = await rpc('orbit.project.listLaunchConfigurations', {
    context: connectionContext,
    includeLegacyAlias: true,
  });
  const names = (configs.result?.data?.items ?? []).map(item => item.name);
  record(
    'orbit.project.listLaunchConfigurations',
    names.includes(CONFIG) && names.includes(SECOND_CONFIG),
    { names },
  );

  // 6. session.list baseline
  const list0 = await rpc('orbit.session.list', { context: connectionContext });
  record('orbit.session.list (empty baseline)', Array.isArray(list0.result?.data?.items) && list0.result.data.items.length === 0, list0.result?.data);

  // 7. session.start with the flash configuration (authorized hardware write)
  const start1 = await rpc('orbit.session.start', {
    context: { ...connectionContext, idempotencyKey: 'hw-verify-start-1', registryGeneration: G0 },
    configurationId: CONFIG,
    timeoutMs: 20000,
  });
  const ack1 = start1.result?.data;
  const S1 = ack1?.session?.sessionId;
  const G1 = ack1?.session?.sessionGeneration;
  record(
    `orbit.session.start ("${CONFIG}") -> OperationAck`,
    ack1?.accepted === true && typeof ack1?.operationId === 'string' && typeof S1 === 'string',
    ack1,
  );
  record('sessionGeneration = registryGeneration + 1', Number.isInteger(G1) && G1 === G0 + 1, { G0, G1 });

  // 8. poll the real target state through the legacy channel (same SessionRegistry fence)
  const haltState = await pollUntil(
    async () => {
      try {
        const state = await legacyRpc('ozone.target.getState', {});
        return typeof state?.state === 'string' ? state.state : 'error';
      } catch (error) {
        return `error:${error.message}`;
      }
    },
    value => value === 'halted',
    MAX_WAIT_MS,
    500,
  );
  record(
    'target halted after flash (legacy channel through SessionRegistry fence)',
    haltState === 'halted',
    { finalState: haltState },
  );

  // --- human observation window: hold the pause, then let the user drive ---
  // --- F5 (run) / F6 (pause) while the script records the state timeline. ---
  console.log(`\n>>> 目标已暂停在 main，保持 ${HOLD_HALTED_MS / 1000}s 供人工观察暂停状态`);
  await sleep(HOLD_HALTED_MS);
  const logLines = collectFlashLogLines();
  record('flash/connect log evidence captured at halt', Object.keys(logLines).length > 0, { files: Object.keys(logLines) });

  console.log(`>>> 观察窗口 ${OBSERVE_MS / 1000}s：请在 VS Code 中按 F5 继续运行（观察 LED），再按 F6 暂停`);
  const legacyState = () => legacyRpc('ozone.target.getState', {});
  const sawRun = await waitForState(legacyState, 'running', OBSERVE_MS, 'waiting for run (F5)…');
  const sawPauseAgain = sawRun ? await waitForState(legacyState, 'halted', OBSERVE_MS, 'waiting for pause (F6)…') : false;
  record('observed run then pause (user-driven F5/F6)', sawRun && sawPauseAgain, { sawRun, sawPauseAgain });

  // 9. session.snapshot of the started session
  const snapshot1 = await rpc('orbit.session.snapshot', { context: connectionContext, sessionId: S1 });
  record(
    'orbit.session.snapshot (started session)',
    snapshot1.result?.data?.sessionId === S1 &&
      snapshot1.result?.data?.sessionGeneration === G1 &&
      typeof snapshot1.result?.data?.phase === 'string',
    snapshot1.result?.data,
  );

  // 10. duplicate start fences
  const projectAfterStart = await rpc('orbit.project.describe', { context: bootstrap });
  const GNow = projectAfterStart.result?.data?.registryGeneration;
  record('registryGeneration incremented once after start', GNow === G0 + 1, { G0, GNow });

  const staleGenError = await expectRpcError(() =>
    rpc('orbit.session.start', {
      context: { ...connectionContext, idempotencyKey: 'hw-verify-start-stale', registryGeneration: G0 },
      configurationId: CONFIG,
    }),
  );
  record(
    'duplicate start with stale registryGeneration -> InvalidRequest',
    staleGenError?.errorCode === 'InvalidRequest',
    staleGenError,
  );

  const alreadyActiveError = await expectRpcError(() =>
    rpc('orbit.session.start', {
      context: { ...connectionContext, idempotencyKey: 'hw-verify-start-dup', registryGeneration: GNow },
      configurationId: CONFIG,
    }),
  );
  record(
    'duplicate start at current generation -> SessionAlreadyActive with current snapshot',
    alreadyActiveError?.errorCode === 'SessionAlreadyActive' && alreadyActiveError?.current?.sessionId === S1,
    alreadyActiveError,
  );

  const projectAfterDup = await rpc('orbit.project.describe', { context: bootstrap });
  record(
    'duplicate starts perform no transition',
    projectAfterDup.result?.data?.registryGeneration === GNow,
    { GNow, afterDup: projectAfterDup.result?.data?.registryGeneration },
  );

  // 11. stop fences: sessionGeneration below 1 is rejected by the frozen
  // schema before any target interaction; a valid-but-stale generation is
  // exercised against the second session below.
  const belowOneError = await expectRpcError(() =>
    rpc('orbit.session.stop', {
      context: { ...connectionContext, idempotencyKey: 'hw-verify-stop-zero', sessionId: S1, sessionGeneration: 0 },
    }),
  );
  record(
    'session.stop with sessionGeneration < 1 -> InvalidParams',
    belowOneError?.errorCode === 'InvalidParams',
    belowOneError,
  );
  const stillHalted = await legacyRpc('ozone.target.getState', {});
  record('rejected stop left the session untouched', stillHalted?.state === 'halted', stillHalted);

  // 12. stop the exact session
  const stop1 = await rpc('orbit.session.stop', {
    context: { ...connectionContext, idempotencyKey: 'hw-verify-stop-1', sessionId: S1, sessionGeneration: G1 },
  });
  record(
    'orbit.session.stop (exact session) -> OperationAck accepted',
    stop1.result?.data?.accepted === true,
    stop1.result?.data,
  );

  await pollUntil(
    async () => {
      const list = await rpc('orbit.session.list', {
        context: connectionContext,
        includeTerminated: true,
      });
      return list.result?.data?.items ?? [];
    },
    items => items.some(item => item.sessionId === S1 && item.phase === 'terminated'),
    20000,
    300,
  );
  const listAfterStop = await rpc('orbit.session.list', { context: connectionContext, includeTerminated: true });
  record(
    'terminated session appears in includeTerminated history',
    listAfterStop.result?.data?.items?.some(item => item.sessionId === S1 && item.phase === 'terminated'),
    listAfterStop.result?.data,
  );

  const snapshotGone = await expectRpcError(() =>
    rpc('orbit.session.snapshot', { context: connectionContext, sessionId: S1 }),
  );
  record('session.snapshot of terminated session -> NoActiveSession', snapshotGone?.errorCode === 'NoActiveSession', snapshotGone);

  const projectAfterStop = await rpc('orbit.project.describe', { context: bootstrap });
  record(
    'registryGeneration incremented once more after stop',
    projectAfterStop.result?.data?.registryGeneration === GNow + 1,
    { GNow, afterStop: projectAfterStop.result?.data?.registryGeneration },
  );

  // 13. second session (no-flash configuration): replacement-history sanity
  const start2 = await rpc('orbit.session.start', {
    context: {
      ...connectionContext,
      idempotencyKey: 'hw-verify-start-2',
      registryGeneration: projectAfterStop.result?.data?.registryGeneration,
    },
    configurationId: SECOND_CONFIG,
    timeoutMs: 20000,
  });
  const ack2 = start2.result?.data;
  const S2 = ack2?.session?.sessionId;
  const G2 = ack2?.session?.sessionGeneration;
  record(
    `orbit.session.start ("${SECOND_CONFIG}") -> OperationAck`,
    ack2?.accepted === true && typeof S2 === 'string' && G2 === projectAfterStop.result?.data?.registryGeneration + 1,
    ack2,
  );
  const halt2 = await pollUntil(
    async () => {
      try {
        return (await legacyRpc('ozone.target.getState', {})).state;
      } catch (error) {
        return `error:${error.message}`;
      }
    },
    value => value === 'halted',
    45000,
    500,
  );
  record('second session halted without flashing', halt2 === 'halted', { finalState: halt2 });

  console.log(`>>> 第二个会话已暂停，保持 ${HOLD_HALTED_MS / 1000}s 供人工观察`);
  await sleep(HOLD_HALTED_MS);

  // Valid-but-stale generation: S2 exists with generation 3, the caller
  // still holds 2 -> SessionChanged, target untouched.
  const staleStopError = await expectRpcError(() =>
    rpc('orbit.session.stop', {
      context: { ...connectionContext, idempotencyKey: 'hw-verify-stop-stale', sessionId: S2, sessionGeneration: 2 },
    }),
  );
  record(
    'session.stop with valid stale generation -> SessionChanged',
    staleStopError?.errorCode === 'SessionChanged' &&
      staleStopError?.expectedGeneration === 2 &&
      staleStopError?.actualGeneration === G2,
    staleStopError,
  );
  const stillHalted2 = await legacyRpc('ozone.target.getState', {});
  record('stale stop left the second session untouched', stillHalted2?.state === 'halted', stillHalted2);

  const stop2 = await rpc('orbit.session.stop', {
    context: { ...connectionContext, idempotencyKey: 'hw-verify-stop-2', sessionId: S2, sessionGeneration: G2 },
  });
  record('orbit.session.stop (second session) -> accepted', stop2.result?.data?.accepted === true, stop2.result?.data);

  await pollUntil(
    async () => {
      const list = await rpc('orbit.session.list', {
        context: connectionContext,
        includeTerminated: true,
      });
      return list.result?.data?.items ?? [];
    },
    items =>
      items.every(item => item.phase === 'terminated') &&
      items.some(item => item.sessionId === S1) &&
      items.some(item => item.sessionId === S2),
    20000,
    300,
  );
  const finalList = await rpc('orbit.session.list', { context: connectionContext, includeTerminated: true });
  const finalItems = finalList.result?.data?.items ?? [];
  record(
    'both sessions retained in terminated history',
    finalItems.some(item => item.sessionId === S1 && item.phase === 'terminated') &&
      finalItems.some(item => item.sessionId === S2 && item.phase === 'terminated'),
    finalList.result?.data,
  );

  // 14. connection close
  const close = await rpc('orbit.connection.close', { context: connectionContext, reason: 'hardware verification complete' });
  record('orbit.connection.close', close.result?.data?.closed === true, close.result?.data);

  const summary = {
    baseline: { instanceId: endpoint.instanceId, projectId: endpoint.projectId, G0 },
    session1: { sessionId: S1, sessionGeneration: G1, configuration: CONFIG, haltState },
    session2: { sessionId: S2, sessionGeneration: G2, configuration: SECOND_CONFIG, haltState: halt2 },
    finalRegistryGeneration: (await rpc('orbit.project.describe', { context: bootstrap })).result?.data?.registryGeneration,
    logs: logLines,
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

/** Waits until the legacy channel reports the exact target state (user-driven run/pause observation). */
async function waitForState(read, target, maxMs, label) {
  const deadline = Date.now() + maxMs;
  let last = 'unknown';
  console.log(`[observe] ${label}`);
  while (Date.now() < deadline) {
    try {
      last = (await read()).state;
    } catch (error) {
      last = `error:${error.message}`;
    }
    if (last === target) {
      console.log(`[observe] state=${target} OK`);
      return true;
    }
    await sleep(300);
  }
  console.log(`[observe] timeout waiting for ${target}; last=${last}`);
  return false;
}

/** Flash/connect/halt lines from this session's DAP/DLL logs (cleared at session start). */
function collectFlashLogLines() {
  const logDir = path.join(__dirname, '..', '..', 'outputs', 'Log');
  const filter = /flash|program|verify|connect|halt|reset/i;
  const logs = {};
  for (const name of ['dll.log', 'dap.log']) {
    const file = path.join(logDir, name);
    if (!fs.existsSync(file)) continue;
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(line => filter.test(line));
    if (lines.length > 0) logs[name] = lines.slice(-40);
  }
  return logs;
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
