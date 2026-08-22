// Orbit Automation API — Task 5 reset real-hardware verification (session already
// active, target halted). Drives orbit.target.reset in both 'halt' and 'run' modes.
const fs = require('fs');
const path = require('path');

const steps = [];
function record(step, ok, detail) {
  steps.push({ step, ok, at: new Date().toISOString(), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`);
  if (!ok) process.exitCode = 1;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function httpJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}
function discoverEndpointFile() {
  const dir = path.join(process.env.APPDATA, 'Code', 'User', 'globalStorage',
    'orbit-debug.orbit-for-vscode', 'automation-api', 'endpoints');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => n.endsWith('.json')) : [];
  if (files.length !== 1) throw new Error(`expected one endpoint, got ${files.length}`);
  return path.join(dir, files[0]);
}
async function pollUntil(read, accept, maxMs, intervalMs) {
  const deadline = Date.now() + maxMs;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (accept(last)) return { value: last, elapsedMs: maxMs - (deadline - Date.now()) };
    await sleep(intervalMs);
  }
  return { value: last, elapsedMs: maxMs, timedOut: true };
}

async function main() {
  const endpoint = JSON.parse(fs.readFileSync(discoverEndpointFile(), 'utf8'));
  const headers = { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' };
  let nextId = 0;
  const rpc = async (method, params) => {
    const id = `hw-${String(++nextId).padStart(3, '0')}`;
    const { status, body } = await httpJson(endpoint.rpcUrl, {
      method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    if (status !== 200 || body.error) throw new Error(`${method} failed: ${JSON.stringify(body.error ?? body)}`);
    return body.result;
  };
  const legacyRpc = async (method, params) => {
    const url = endpoint.rpcUrl.replace(/\/v1\/rpc$/, '/rpc');
    const { status, body } = await httpJson(url, {
      method: 'POST', headers,
      body: JSON.stringify({ id: `legacy-${++nextId}`, method, params }),
    });
    if (status !== 200 || body?.ok !== true) throw new Error(`legacy ${method} failed`);
    return body.data;
  };

  const bootstrap = { instanceId: endpoint.instanceId, projectId: endpoint.projectId };
  const hs = await rpc('orbit.handshake', {
    context: bootstrap, apiVersion: '1.0',
    client: { name: 'orbit-reset', version: '0.1.0', pid: process.pid },
    expected: { projectId: endpoint.projectId, instanceId: endpoint.instanceId },
    requestedScopes: ['read', 'session.control'],
  });
  const ctx = { ...bootstrap, connectionId: hs.data.connectionId };
  record('handshake', typeof ctx.connectionId === 'string', { grantedScopes: hs.data.grantedScopes });

  const sessions = await rpc('orbit.session.list', { context: ctx });
  const session = (sessions.data.items ?? []).find(s => s.phase !== 'terminated');
  if (!session) throw new Error('no active session');
  const sessionId = session.sessionId;
  const generation = session.sessionGeneration;
  record('active session', true, { sessionId, sessionGeneration: generation });

  // --- reset -> halt ---------------------------------------------------------
  const resetHalt = await rpc('orbit.target.reset', {
    context: { ...ctx, idempotencyKey: 'hw-reset-halt', sessionId, sessionGeneration: generation },
    mode: 'halt',
  });
  const haltOutcome = resetHalt.data;
  record(
    `reset(mode=halt) -> state=${haltOutcome?.state} pc=${haltOutcome?.pc}`,
    haltOutcome?.state === 'halted' && typeof haltOutcome?.pc === 'string',
    haltOutcome,
  );
  const resetPc = haltOutcome?.pc;

  // --- reset -> run ----------------------------------------------------------
  const resetRun = await rpc('orbit.target.reset', {
    context: { ...ctx, idempotencyKey: 'hw-reset-run', sessionId, sessionGeneration: generation },
    mode: 'run',
  });
  record(`reset(mode=run) -> state=${resetRun.data?.state}`, resetRun.data?.state === 'running', resetRun.data);

  const running = await pollUntil(
    async () => { try { return (await legacyRpc('ozone.target.getState', {})).state; } catch { return 'error'; } },
    v => v === 'running', 3000, 50,
  );
  record('target running after reset(mode=run)', running.value === 'running', { state: running.value, elapsedMs: running.elapsedMs });

  const summary = {
    baseline: { instanceId: endpoint.instanceId, projectId: endpoint.projectId },
    sessionId, sessionGeneration: generation,
    resetHalt: haltOutcome,
    resetPc,
    resetRun: resetRun.data,
    running: running.value,
    steps,
  };
  const out = path.join(__dirname, '..', '..', 'outputs', 'task5-reset-evidence.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(summary, null, 2));
  console.log(`\nEvidence saved to ${out}`);
}

main().catch(e => { record('fatal', false, { message: e?.message ?? String(e), stack: e?.stack }); process.exitCode = 1; });
