// Orbit Automation API — Task 7 runtime inspection hardware verification.
// threads / stackTrace / scopes / variables / registers against the halted
// STM32F407 target, with a PC cross-check across three independent read paths.
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
  // Canonical numeric compare: strip the 0x prefix AND leading zeros, so
  // "0x080056C4" (register hex) and "0x80056C4" (memoryReference) are equal.
  const digits = String(value ?? '').trim().replace(/^0x/i, '').toUpperCase();
  return digits.replace(/^0+/, '') || '0';
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
    client: { name: 'orbit-runtime-verify', version: '0.1.0', pid: process.pid },
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
      context: { ...ctx, idempotencyKey: 'hw-runtime-start', registryGeneration: g0 },
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

  // threads
  const threads = await rpc('orbit.runtime.threads', { context: targetCtx });
  const t0 = threads.data.items?.[0];
  record('runtime.threads returns the halted thread', !!t0 && t0.threadId === 1 && t0.stopped === true && t0.state === 'halted', t0);

  // stackTrace
  const stack = await rpc('orbit.runtime.stackTrace', { context: targetCtx, threadId: 1 });
  const f0 = stack.data.items?.[0];
  record('runtime.stackTrace returns a frame with a real PC', !!f0 && /^0x[0-9a-f]+$/i.test(f0.instructionPointerReference ?? '') && !!f0.name, f0);
  record('runtime.stackTrace reports source location', !!f0?.source && typeof f0.source.path === 'string' && f0.source.line >= 1, f0?.source);

  // scopes
  const scopes = await rpc('orbit.runtime.scopes', { context: targetCtx, frameId: f0.frameId });
  const scopeNames = (scopes.data.items ?? []).map(s => s.name);
  const localScope = (scopes.data.items ?? []).find(s => s.name === 'Local');
  const regScope = (scopes.data.items ?? []).find(s => s.name === 'Registers');
  record('runtime.scopes returns Local + Registers', !!localScope && localScope.variablesReference === '1' && !!regScope && regScope.variablesReference === '2', scopeNames);

  // variables — Registers scope (ref 2) is always populated; Locals may be empty at entry
  const regVars = await rpc('orbit.runtime.variables', { context: targetCtx, variablesReference: '2' });
  const regVarPc = (regVars.data.items ?? []).find(v => v.name === 'PC');
  record('runtime.variables(ref 2) returns the PC register', !!regVarPc && /^0x[0-9a-f]+$/i.test(regVarPc.value ?? ''), regVarPc);

  const localVars = await rpc('orbit.runtime.variables', { context: targetCtx, variablesReference: '1' });
  record('runtime.variables(ref 1) returns a well-formed variable list', Array.isArray(localVars.data.items) && (localVars.data.items ?? []).every(v => typeof v.name === 'string' && 'value' in v && 'variablesReference' in v), { count: localVars.data.items?.length });

  // registers
  const regs = await rpc('orbit.runtime.registers', { context: targetCtx });
  const pcReg = (regs.data.items ?? []).find(r => r.name === 'PC');
  const spReg = (regs.data.items ?? []).find(r => r.name === 'SP');
  record('runtime.registers returns PC with group/bits/value/memoryReference',
    !!pcReg && pcReg.group === 'core' && pcReg.bits === 32 && /^0x[0-9a-f]+$/i.test(pcReg.value ?? '') && /^0x[0-9a-f]+$/i.test(pcReg.memoryReference ?? ''),
    pcReg);
  // The J-Link native owner returns R0..R12 + SP + PC + xPSR (LR reads null on
  // this target, a pre-existing backend characteristic, not a Task 7 change).
  record('runtime.registers includes the core set (PC + SP + xPSR)',
    !!pcReg && !!spReg && !!(regs.data.items ?? []).find(r => r.name === 'xPSR'),
    { names: (regs.data.items ?? []).map(r => r.name) });

  // cross-check: three independent read paths converge on the same halted PC
  const pcFromRegisters = hexNorm(pcReg?.value);
  const pcFromVariables = hexNorm(regVarPc?.value);
  const pcFromStack = hexNorm(f0?.instructionPointerReference);
  record('PC cross-check registers == variables', pcFromRegisters.length > 0 && pcFromRegisters === pcFromVariables, { pcFromRegisters, pcFromVariables });
  record('PC cross-check registers == stackTrace frame0', pcFromRegisters.length > 0 && pcFromRegisters === pcFromStack, { pcFromRegisters, pcFromStack });

  const summary = {
    baseline: { instanceId: endpoint.instanceId, projectId: endpoint.projectId, sessionId, sessionGeneration: generation },
    threads: threads.data,
    stackTraceFrame0: f0,
    scopes: scopes.data,
    variablesRegistersPc: regVarPc,
    localVariablesCount: localVars.data.items?.length ?? 0,
    registers: regs.data,
    crossCheck: { pcFromRegisters, pcFromVariables, pcFromStack },
    steps,
  };
  const out = path.join(__dirname, '..', '..', 'outputs', 'task7-runtime-evidence.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(summary, null, 2));
  console.log(`\nEvidence saved to ${out}`);
}

main().catch(e => { record('fatal', false, { message: e?.message ?? String(e), stack: e?.stack }); process.exitCode = 1; });
