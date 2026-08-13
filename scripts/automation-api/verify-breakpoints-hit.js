// Orbit Automation API — Task 6 hardware follow-up: read -> remove (line 402)
// -> run -> hit the user's log breakpoint (line 412) -> read the halted PC.
const fs = require('fs');
const path = require('path');

const SOURCE_PATH = 'd:\\STM32\\project\\vet6_led\\Core\\Src\\freertos.c';
const REMOVE_LINE = 402;
const HIT_LINE = 412;

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
    client: { name: 'orbit-bp-hit', version: '0.1.0', pid: process.pid },
    expected: { projectId: endpoint.projectId, instanceId: endpoint.instanceId },
    requestedScopes: ['read', 'session.control', 'breakpoints.write'],
  });
  const connectionId = hs.data.connectionId;
  const ctx = { ...bootstrap, connectionId };
  record('handshake', typeof connectionId === 'string', { grantedScopes: hs.data.grantedScopes });

  const sessions = await rpc('orbit.session.list', { context: ctx });
  const session = (sessions.data.items ?? []).find(s => s.phase !== 'terminated');
  if (!session) throw new Error('no active session');
  const sessionId = session.sessionId;
  const generation = session.sessionGeneration;
  record('active session', true, { sessionId, sessionGeneration: generation });

  // --- 1. read -------------------------------------------------------------
  const before = await rpc('orbit.breakpoints.list', { context: ctx, sourcePath: SOURCE_PATH });
  const beforeItems = before.data.items ?? [];
  record('read: breakpoints.list shows both breakpoints', beforeItems.length === 2, beforeItems);

  // --- 2. remove my line-402 breakpoint ------------------------------------
  const target = beforeItems.find(item => item.source.line === REMOVE_LINE);
  record('found line-402 breakpoint to remove', !!target, target && { breakpointId: target.breakpointId });
  if (target) {
    const removed = await rpc('orbit.breakpoints.remove', {
      context: { ...ctx, idempotencyKey: 'hw-bp-remove-402' },
      breakpointId: target.breakpointId,
    });
    record('remove: orbit.breakpoints.remove(line 402)', removed.data?.items?.[0]?.breakpointId === target.breakpointId, removed.data);
  }

  const after = await rpc('orbit.breakpoints.list', { context: ctx, sourcePath: SOURCE_PATH });
  const afterItems = after.data.items ?? [];
  const hitBp = afterItems.find(item => item.source.line === HIT_LINE);
  record('read: only the line-412 breakpoint remains', afterItems.length === 1 && !!hitBp, afterItems);

  // --- 3. run and hit the line-412 log breakpoint --------------------------
  const cont = await rpc('orbit.target.continue', {
    context: { ...ctx, idempotencyKey: 'hw-bp-run-hit', sessionId, sessionGeneration: generation },
    threadId: 1,
  });
  record(`run: orbit.target.continue -> ${cont.data?.state}`, cont.data?.state === 'running', cont.data);

  const hit = await pollUntil(
    async () => { try { return (await legacyRpc('ozone.target.getState', {})).state; } catch { return 'error'; } },
    v => v === 'halted', 10000, 20,
  );
  record('hit: target halted at the log breakpoint', hit.value === 'halted', { state: hit.value, elapsedMs: hit.elapsedMs });

  const pause = await rpc('orbit.target.pause', {
    context: { ...ctx, idempotencyKey: 'hw-bp-pause-read', sessionId, sessionGeneration: generation },
    threadId: 1,
  });
  const pc = pause.data?.pc;
  record(`hit: halted PC = ${pc}`, typeof pc === 'string' && /^0x[0-9a-f]+$/.test(pc), pause.data);

  const summary = {
    baseline: { instanceId: endpoint.instanceId, projectId: endpoint.projectId },
    sessionId, sessionGeneration: generation,
    before: beforeItems,
    removed: target && { breakpointId: target.breakpointId, line: REMOVE_LINE },
    after: afterItems,
    hit: { state: hit.value, elapsedMs: hit.elapsedMs, pc },
    steps,
  };
  const out = path.join(__dirname, '..', '..', 'outputs', 'task6-breakpoint-hit-evidence.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(summary, null, 2));
  console.log(`\nEvidence saved to ${out}`);
}

main().catch(e => { record('fatal', false, { message: e?.message ?? String(e), stack: e?.stack }); process.exitCode = 1; });
