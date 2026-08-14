// Orbit Automation API — Task 8 expression/symbol hardware verification.
// evaluate / readMany / inspect / symbol.search / symbol.resolve against the
// halted STM32F407 target. All steps here are READ-ONLY (no target writes):
// the register-expression reads ($PC/$SP) cross-check against runtime.registers,
// and symbol resolution/search cross-check against the loaded ELF cache.
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
function hexNorm(value) {
  const digits = String(value ?? '').trim().replace(/^0x/i, '').toUpperCase();
  return digits.replace(/^0+/, '') || '0';
}
function decimalToHexNorm(value) {
  const n = parseInt(String(value).trim(), 10);
  if (!Number.isFinite(n)) return '';
  return hexNorm(`0x${n.toString(16).toUpperCase()}`);
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
    client: { name: 'orbit-expression-verify', version: '0.1.0', pid: process.pid },
    expected: { projectId: endpoint.projectId, instanceId: endpoint.instanceId },
    requestedScopes: ['read', 'session.control'],
  });
  const ctx = { ...bootstrap, connectionId: hs.data.connectionId };
  record('handshake grants read + session.control', hs.data.grantedScopes.includes('read') && hs.data.grantedScopes.includes('session.control'), { grantedScopes: hs.data.grantedScopes });

  // ensure a halted session
  const sessions = await rpc('orbit.session.list', { context: ctx });
  let session = (sessions.data.items ?? []).find(s => s.phase !== 'terminated');
  if (!session) {
    const g0 = (await rpc('orbit.project.describe', { context: bootstrap })).data.registryGeneration;
    const start = await rpc('orbit.session.start', {
      context: { ...ctx, idempotencyKey: 'hw-expr-start', registryGeneration: g0 },
      configurationId: 'Orbit: J-Link (Flash)', timeoutMs: 30000,
    });
    session = start.data.session;
    record('orbit.session.start', start.data.accepted === true, start.data);
    const halted = await pollUntil(async () => {
      try { return (await legacyRpc('ozone.target.getState', {})).state; } catch { return 'error'; }
    }, v => v === 'halted', 90000, 500);
    record('target halted at entry', !halted.timedOut, { state: halted.value, elapsedMs: halted.elapsedMs });
  }
  const sessionId = session.sessionId;
  const generation = session.sessionGeneration;
  const targetCtx = { ...ctx, sessionId, sessionGeneration: generation };

  // --- symbol.resolve -------------------------------------------------------
  const main = await rpc('orbit.symbol.resolve', { context: targetCtx, name: 'main' });
  record('symbol.resolve(main) is an exact function', main.data.exact === true && main.data.symbol.kind === 'function' && /^0x[0-9a-f]+$/i.test(main.data.symbol.address ?? ''), main.data);

  const reset = await rpc('orbit.symbol.resolve', { context: targetCtx, name: 'Reset_Handler' });
  record('symbol.resolve(Reset_Handler) is a function', reset.data.symbol.kind === 'function' && /^0x[0-9a-f]+$/i.test(reset.data.symbol.address ?? ''), reset.data);

  const byAddr = await rpc('orbit.symbol.resolve', { context: targetCtx, address: main.data.symbol.address });
  record('symbol.resolve(address) resolves back to main', byAddr.data.symbol.name === 'main' && hexNorm(byAddr.data.symbol.address) === hexNorm(main.data.symbol.address), byAddr.data);

  // --- symbol.search --------------------------------------------------------
  const searchMain = await rpc('orbit.symbol.search', { context: targetCtx, query: 'main' });
  const mainHit = (searchMain.data.items ?? []).find(s => s.name === 'main');
  record('symbol.search(main) contains main as a function', !!mainHit && mainHit.kind === 'function' && /^0x[0-9a-f]+$/i.test(mainHit.address ?? ''), mainHit);

  const searchHandler = await rpc('orbit.symbol.search', { context: targetCtx, query: 'Handler', limit: 100 });
  const resetHit = (searchHandler.data.items ?? []).find(s => s.name === 'Reset_Handler');
  record('symbol.search(Handler) contains Reset_Handler', !!resetHit && resetHit.kind === 'function', { count: searchHandler.data.items?.length, resetHit });

  const searchKinds = await rpc('orbit.symbol.search', { context: targetCtx, query: 'Handler', kinds: ['function'], limit: 100 });
  record('symbol.search kinds filter returns only functions', (searchKinds.data.items ?? []).length > 0 && (searchKinds.data.items ?? []).every(s => s.kind === 'function'), { count: searchKinds.data.items?.length });

  const page1 = await rpc('orbit.symbol.search', { context: targetCtx, query: 'Handler', limit: 2 });
  record('symbol.search paginates by cursor', Array.isArray(page1.data.items) && page1.data.items.length === 2 && !!page1.data.nextCursor, { page1: page1.data.items?.map(s => s.name), nextCursor: page1.data.nextCursor });
  if (page1.data.nextCursor) {
    const page2 = await rpc('orbit.symbol.search', { context: targetCtx, query: 'Handler', cursor: page1.data.nextCursor, limit: 2 });
    const overlap = (page2.data.items ?? []).some(s => (page1.data.items ?? []).some(p => p.name === s.name));
    record('symbol.search page 2 advances without overlap', Array.isArray(page2.data.items) && page2.data.items.length > 0 && !overlap, { page2: page2.data.items?.map(s => s.name) });
  }

  // --- expression.evaluate --------------------------------------------------
  const evalPc = await rpc('orbit.expression.evaluate', { context: targetCtx, expression: '$PC' });
  record('expression.evaluate($PC) is available with a string value', evalPc.data.available === true && evalPc.data.stale === false && typeof evalPc.data.value === 'string' && evalPc.data.value.length > 0 && evalPc.data.variablesReference === '0', evalPc.data);

  const evalSp = await rpc('orbit.expression.evaluate', { context: targetCtx, expression: '$SP' });
  record('expression.evaluate($SP) is available', evalSp.data.available === true && typeof evalSp.data.value === 'string' && evalSp.data.value.length > 0, evalSp.data);

  // cross-check evaluate($PC) against the register read path
  const regs = await rpc('orbit.runtime.registers', { context: targetCtx });
  const pcReg = (regs.data.items ?? []).find(r => r.name === 'PC');
  const evalPcHex = decimalToHexNorm(evalPc.data.value);
  record('expression.evaluate($PC) == runtime.registers.PC', !!pcReg && evalPcHex.length > 0 && evalPcHex === hexNorm(pcReg.value), { evalValue: evalPc.data.value, evalPcHex, registerPc: pcReg?.value });

  // --- expression.readMany --------------------------------------------------
  const readMany = await rpc('orbit.expression.readMany', { context: targetCtx, expressions: ['$PC', '$SP'] });
  const rm0 = readMany.data.items?.[0];
  const rm1 = readMany.data.items?.[1];
  record('expression.readMany preserves order with two available items', Array.isArray(readMany.data.items) && readMany.data.items.length === 2 && rm0?.expression === '$PC' && rm1?.expression === '$SP' && rm0?.available === true && rm1?.available === true, readMany.data.items?.map(i => ({ expression: i.expression, available: i.available })));
  record('expression.readMany($PC) == expression.evaluate($PC)', rm0?.value === evalPc.data.value, { readMany: rm0?.value, evaluate: evalPc.data.value });

  // a missing symbol is a per-item error, not a whole-request failure
  const readMixed = await rpc('orbit.expression.readMany', { context: targetCtx, expressions: ['$PC', '__definitely_not_a_symbol__'] });
  record('expression.readMany isolates a missing-symbol item', readMixed.data.items?.length === 2 && readMixed.data.items[0].available === true && readMixed.data.items[1].available === false && !!readMixed.data.items[1].error, readMixed.data.items?.map(i => ({ expression: i.expression, available: i.available, errorCode: i.error?.errorCode })));

  // --- expression.inspect ---------------------------------------------------
  const inspect = await rpc('orbit.expression.inspect', { context: targetCtx, expression: '$PC' });
  record('expression.inspect($PC) returns a root and a well-formed item list', inspect.data.root?.available === true && Array.isArray(inspect.data.items) && inspect.data.items.every(v => typeof v.name === 'string' && 'value' in v && 'variablesReference' in v), { root: inspect.data.root, itemCount: inspect.data.items?.length });

  const summary = {
    baseline: { instanceId: endpoint.instanceId, projectId: endpoint.projectId, sessionId, sessionGeneration: generation },
    symbol: {
      main: main.data,
      resetHandler: reset.data,
      resolveByAddress: byAddr.data,
      searchMain: mainHit,
      searchHandlerCount: searchHandler.data.items?.length,
      searchKindsCount: searchKinds.data.items?.length,
    },
    expression: {
      evaluatePc: evalPc.data,
      evaluateSp: evalSp.data,
      readMany: readMany.data.items,
      readMixed: readMixed.data.items,
      inspect: inspect.data,
      crossCheck: { evalPcHex, registerPc: pcReg?.value },
    },
    steps,
  };
  const out = path.join(__dirname, '..', '..', 'outputs', 'task8-expression-evidence.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(summary, null, 2));
  console.log(`\nEvidence saved to ${out}`);
}

main().catch(e => { record('fatal', false, { message: e?.message ?? String(e), stack: e?.stack }); process.exitCode = 1; });
