// Orbit Automation API — Task 8 writeMany hardware verification.
// Writes a distinctive value to a dedicated RAM test global (g_ram_data),
// reads it back through readMany to verify, then restores the original value.
// This is a write -> verify -> restore round-trip on a user-owned test global.
const fs = require('fs');
const path = require('path');

const steps = [];
function record(step, ok, detail) {
  steps.push({ step, ok, at: new Date().toISOString(), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`);
  if (!ok) process.exitCode = 1;
}
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
function decimalValue(value) {
  // Scalar display is "0xHEX (DECIMAL)"; parse the hex prefix for exactness,
  // falling back to a plain decimal for register/other reads.
  const text = String(value ?? '').trim();
  const hex = /^0x([0-9a-fA-F]+)/.exec(text);
  if (hex) return parseInt(hex[1], 16);
  const n = parseInt(text, 10);
  return Number.isFinite(n) ? n : NaN;
}
const TEST_VALUE = 0x5A5AA5A5; // distinctive pattern, non-trivial bits

async function main() {
  const endpoint = JSON.parse(fs.readFileSync(discoverEndpointFile(), 'utf8'));
  const headers = { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' };
  let nextId = 0;
  const rpc = async (method, params) => {
    const id = `w-${String(++nextId).padStart(3, '0')}`;
    const { status, body } = await httpJson(endpoint.rpcUrl, {
      method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    if (status !== 200 || body.error) throw new Error(`${method} failed: ${JSON.stringify(body.error ?? body)}`);
    return body.result;
  };

  const bootstrap = { instanceId: endpoint.instanceId, projectId: endpoint.projectId };
  const hs = await rpc('orbit.handshake', {
    context: bootstrap, apiVersion: '1.0',
    client: { name: 'orbit-write-verify', version: '0.1.0', pid: process.pid },
    expected: { projectId: endpoint.projectId, instanceId: endpoint.instanceId },
    requestedScopes: ['read', 'session.control', 'variables.write'],
  });
  const ctx = { ...bootstrap, connectionId: hs.data.connectionId };
  record('handshake grants variables.write', hs.data.grantedScopes.includes('variables.write'), { grantedScopes: hs.data.grantedScopes });

  const sessions = await rpc('orbit.session.list', { context: ctx });
  const session = (sessions.data.items ?? []).find(s => s.phase !== 'terminated');
  if (!session) throw new Error('no active session');
  const targetCtx = { ...ctx, sessionId: session.sessionId, sessionGeneration: session.sessionGeneration };

  // locate a writable RAM test global
  const search = await rpc('orbit.symbol.search', { context: targetCtx, query: 'g_ram_data' });
  const symbol = (search.data.items ?? []).find(s => s.name === 'g_ram_data');
  record('g_ram_data is a RAM variable', !!symbol && symbol.kind === 'variable' && parseInt(symbol.address, 16) >= 0x20000000 && parseInt(symbol.address, 16) < 0x20020000 && (symbol.size ?? '4') === '4', symbol);
  if (!symbol) throw new Error('g_ram_data not found');

  // 1) read the original value
  const before = await rpc('orbit.expression.readMany', { context: targetCtx, expressions: ['g_ram_data'] });
  const beforeValue = before.data.items?.[0];
  record('readMany reads the original value', beforeValue?.available === true && typeof beforeValue.value === 'string', beforeValue);
  const original = decimalValue(beforeValue?.value);

  // 2) write the test value
  const write1 = await rpc('orbit.expression.writeMany', {
    context: { ...targetCtx, idempotencyKey: 'hw-write-test' },
    writes: [{ expression: 'g_ram_data', value: `0x${TEST_VALUE.toString(16).toUpperCase()}` }],
  });
  const w1 = write1.data.items?.[0];
  record('writeMany writes the test value (written=true)', w1?.written === true, write1.data);

  // 3) read back and verify
  const after = await rpc('orbit.expression.readMany', { context: targetCtx, expressions: ['g_ram_data'] });
  const afterValue = after.data.items?.[0];
  const afterDecimal = decimalValue(afterValue?.value);
  record('readMany verifies the written value', afterDecimal === TEST_VALUE, { expected: `0x${TEST_VALUE.toString(16).toUpperCase()}`, actualDecimal: afterValue?.value });

  // 4) restore the original value
  const restore = await rpc('orbit.expression.writeMany', {
    context: { ...targetCtx, idempotencyKey: 'hw-write-restore' },
    writes: [{ expression: 'g_ram_data', value: String(original) }],
  });
  const r1 = restore.data.items?.[0];
  record('writeMany restores the original value (written=true)', r1?.written === true, restore.data);

  // 5) verify restoration
  const afterRestore = await rpc('orbit.expression.readMany', { context: targetCtx, expressions: ['g_ram_data'] });
  const restoredValue = afterRestore.data.items?.[0];
  record('readMany verifies the restore', decimalValue(restoredValue?.value) === original, { original, restored: restoredValue?.value });

  // per-item isolation: one unwritable symbol must not mask a writable one
  const mixed = await rpc('orbit.expression.writeMany', {
    context: { ...targetCtx, idempotencyKey: 'hw-write-mixed' },
    writes: [
      { expression: '__definitely_not_a_symbol__', value: '1' },
      { expression: 'g_ram_data', value: String(original) },
    ],
  });
  record('writeMany isolates an unwritable item', mixed.data.items?.length === 2 && mixed.data.items[0].written === false && mixed.data.items[1].written === true, mixed.data.items?.map(i => ({ expression: i.expression, written: i.written, errorCode: i.error?.errorCode })));

  const summary = {
    baseline: { instanceId: endpoint.instanceId, projectId: endpoint.projectId, sessionId: session.sessionId, sessionGeneration: session.sessionGeneration },
    target: symbol,
    testValue: `0x${TEST_VALUE.toString(16).toUpperCase()}`,
    original,
    writeTest: write1.data,
    readBackAfterWrite: afterValue,
    restore: restore.data,
    readBackAfterRestore: restoredValue,
    mixedIsolation: mixed.data.items,
    steps,
  };
  const out = path.join(__dirname, '..', '..', 'outputs', 'task8-write-evidence.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(summary, null, 2));
  console.log(`\nEvidence saved to ${out}`);
}

main().catch(e => { record('fatal', false, { message: e?.message ?? String(e), stack: e?.stack }); process.exitCode = 1; });
