// Orbit Automation API — Task 9 byte-oriented memory read/write hardware
// verification (real J-Link / STM32F407VE).
//
// Plan: locate the g_ram_data RAM test global, read it via orbit.memory.read,
// then exercise write -> verify -> restore while the target is RUNNING
// (Automation memory access must leave the CPU running; standard MemoryView
// retains its separate halt/resume path), and finally halt to a clean state.
// Negative cases (invalid address / invalid base64) are checked last and never
// touch the target.
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
function u32ToBase64(v) {
  return Buffer.from([v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF]).toString('base64');
}
function base64ToU32(b64) {
  const b = Buffer.from(b64 ?? '', 'base64');
  if (b.length < 4) return null;
  return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
}
// The write test value is derived from the live original so it always differs
// (a leftover from a previous interrupted run would otherwise make the write a
// no-op and defeat the verification).
function testValueFor(original) {
  return (original ^ 0xFFFFFFFF) >>> 0;
}

async function main() {
  const endpoint = JSON.parse(fs.readFileSync(discoverEndpointFile(), 'utf8'));
  const headers = { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' };
  let nextId = 0;
  const rpc = async (method, params) => {
    const id = `m-${String(++nextId).padStart(3, '0')}`;
    const { status, body } = await httpJson(endpoint.rpcUrl, {
      method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    if (status !== 200 || body.error) throw new Error(`${method} failed: ${JSON.stringify(body.error ?? body)}`);
    return body.result;
  };
  const rawRpc = async (method, params) => {
    const id = `m-${String(++nextId).padStart(3, '0')}`;
    const { status, body } = await httpJson(endpoint.rpcUrl, {
      method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    if (status !== 200) return { transportError: `status ${status}` };
    return { result: body.result, error: body.error };
  };

  const bootstrap = { instanceId: endpoint.instanceId, projectId: endpoint.projectId };
  const hs = await rpc('orbit.handshake', {
    context: bootstrap, apiVersion: '1.0',
    client: { name: 'orbit-memory-verify', version: '0.1.0', pid: process.pid },
    expected: { projectId: endpoint.projectId, instanceId: endpoint.instanceId },
    requestedScopes: ['read', 'session.control', 'memory.write'],
  });
  const ctx = { ...bootstrap, connectionId: hs.data.connectionId };
  record('handshake grants memory.write', hs.data.grantedScopes.includes('memory.write'), { grantedScopes: hs.data.grantedScopes });

  let sessions = await rpc('orbit.session.list', { context: ctx });
  let session = (sessions.data.items ?? []).find(s => s.phase !== 'terminated');
  if (!session) {
    // No visible debug session after a VS Code restart: start one through the
    // exact same vscode.debug.startDebugging() path (plan Task 4), using the
    // non-flashing launch so existing firmware is preserved.
    const registryGeneration = hs.data.project?.registryGeneration ?? 0;
    const startAck = await rpc('orbit.session.start', {
      context: { ...ctx, idempotencyKey: 'hw-mem-session-start', registryGeneration },
      configurationId: 'Orbit: J-Link (No Flash)',
    });
    record('session started via API', startAck.data?.accepted === true, { phase: startAck.data?.session?.phase });
    session = startAck.data?.session;
    // The registry labels a freshly-started session 'starting' until the first
    // automation control; the DAP adapter is already connected and usable, so
    // give the adapter a beat to finish its No-Flash connect.
    await new Promise(r => setTimeout(r, 1000));
    sessions = await rpc('orbit.session.list', { context: ctx });
    session = (sessions.data.items ?? []).find(s => s.phase !== 'terminated') ?? session;
  }
  if (!session) throw new Error('no active session');
  const targetCtx = { ...ctx, sessionId: session.sessionId, sessionGeneration: session.sessionGeneration };
  record('active session found', !!session, { phase: session.phase, targetState: session.targetState, pc: session.pc });

  // locate the RAM test global (and a flash symbol for a read-only region)
  const search = await rpc('orbit.symbol.search', { context: targetCtx, query: 'g_ram_data' });
  const symbol = (search.data.items ?? []).find(s => s.name === 'g_ram_data');
  record('g_ram_data is a 4-byte RAM variable', !!symbol && symbol.kind === 'variable' && parseInt(symbol.address, 16) >= 0x20000000 && parseInt(symbol.address, 16) < 0x20020000 && (symbol.size ?? '4') === '4', symbol);
  if (!symbol) throw new Error('g_ram_data not found');
  const ramAddr = symbol.address;

  const mainSearch = await rpc('orbit.symbol.search', { context: targetCtx, query: 'main' });
  const mainSym = (mainSearch.data.items ?? []).find(s => s.name === 'main');
  record('main symbol found (flash read target)', !!mainSym, mainSym);

  // 1) read the original 4 bytes from RAM (current state, normally halted)
  const before = await rpc('orbit.memory.read', { context: targetCtx, address: ramAddr, count: 4 });
  const original = base64ToU32(before.data?.data);
  record('memory.read reads the original RAM value', before.data?.bytesRead === 4 && original !== null, { requested: before.data?.requestedBytes, read: before.data?.bytesRead, data: before.data?.data, value: original !== null ? `0x${original.toString(16).toUpperCase()}` : null });
  const testValue = testValueFor(original);

  // 2) read flash (read-only region) — must be byte-oriented base64
  if (mainSym) {
    const flash = await rpc('orbit.memory.read', { context: targetCtx, address: mainSym.address, count: 8 });
    record('memory.read reads flash bytes', flash.data?.bytesRead === 8 && typeof flash.data?.data === 'string' && flash.data.data.length > 0, { address: mainSym.address, read: flash.data?.bytesRead, data: flash.data?.data });
  }

  // 3) continue (run the target) to exercise running-state read/write
  const cont = await rpc('orbit.target.continue', {
    context: { ...targetCtx, idempotencyKey: 'hw-mem-continue' },
  });
  record('target.continue leaves the target running', cont.data?.state === 'running', { state: cont.data?.state });

  // 4) read while running without halting the target
  const runningRead = await rpc('orbit.memory.read', { context: targetCtx, address: ramAddr, count: 4 });
  const runningValue = base64ToU32(runningRead.data?.data);
  record('memory.read succeeds while running', runningRead.data?.bytesRead === 4 && runningValue === original, { read: runningRead.data?.bytesRead, value: runningValue !== null ? `0x${runningValue.toString(16).toUpperCase()}` : null });

  // 5) write + verify while running
  const write1 = await rpc('orbit.memory.write', {
    context: { ...targetCtx, idempotencyKey: 'hw-mem-write-test' },
    address: ramAddr,
    data: u32ToBase64(testValue),
    verify: true,
  });
  record('memory.write writes+verifies while running', write1.data?.bytesWritten === 4 && write1.data?.verified === true, write1.data);

  // 6) read back to confirm the written value
  const afterWrite = await rpc('orbit.memory.read', { context: targetCtx, address: ramAddr, count: 4 });
  const afterWriteValue = base64ToU32(afterWrite.data?.data);
  record('memory.read confirms the written value', afterWriteValue === testValue, { expected: `0x${testValue.toString(16).toUpperCase()}`, actual: afterWriteValue !== null ? `0x${afterWriteValue.toString(16).toUpperCase()}` : null });

  // 7) restore the original value (write + verify while running)
  const restore = await rpc('orbit.memory.write', {
    context: { ...targetCtx, idempotencyKey: 'hw-mem-restore' },
    address: ramAddr,
    data: u32ToBase64(original),
    verify: true,
  });
  record('memory.write restores the original (verified)', restore.data?.bytesWritten === 4 && restore.data?.verified === true, restore.data);

  // 8) confirm restoration while running
  const afterRestore = await rpc('orbit.memory.read', { context: targetCtx, address: ramAddr, count: 4 });
  const restoredValue = base64ToU32(afterRestore.data?.data);
  record('memory.read confirms the restore', restoredValue === original, { original: `0x${original.toString(16).toUpperCase()}`, restored: restoredValue !== null ? `0x${restoredValue.toString(16).toUpperCase()}` : null });

  // 8b) hold the RUNNING state so the operator can watch the VS Code UI
  // (toolbar must stay "running", watch keeps refreshing, timeline keeps
  // loading). A light running-state read every 2s keeps the fixed path
  // exercised so any spurious stop would surface here.
  const holdMs = Number(process.env.ORBIT_HOLD_MS ?? 10000);
  record(`holding running for ${holdMs}ms — observe toolbar/watch/timeline`, holdMs > 0);
  const holdDeadline = Date.now() + holdMs;
  let holdReads = 0;
  let holdValueStable = true;
  while (Date.now() < holdDeadline) {
    await new Promise(r => setTimeout(r, 2000));
    const holdRead = await rpc('orbit.memory.read', { context: targetCtx, address: ramAddr, count: 4 });
    holdReads += 1;
    const holdValue = base64ToU32(holdRead.data?.data);
    if (holdRead.data?.bytesRead !== 4 || holdValue !== original) holdValueStable = false;
    console.log(`      hold running read #${holdReads} value=${holdValue !== null ? `0x${holdValue.toString(16).toUpperCase()}` : 'null'} bytes=${holdRead.data?.bytesRead}`);
  }
  record('hold completed with running reads', holdReads > 0 && holdValueStable, { holdReads, valueStable: holdValueStable });

  // 9) halt to a clean state
  const pause = await rpc('orbit.target.pause', { context: { ...targetCtx, idempotencyKey: 'hw-mem-pause' } });
  record('target.pause halts to a clean state', pause.data?.state === 'halted', { state: pause.data?.state, pc: pause.data?.pc });

  // final halted read to confirm the restored value persists
  const finalRead = await rpc('orbit.memory.read', { context: targetCtx, address: ramAddr, count: 4 });
  const finalValue = base64ToU32(finalRead.data?.data);
  record('memory.read (halted) confirms final restore', finalValue === original, { value: finalValue !== null ? `0x${finalValue.toString(16).toUpperCase()}` : null });

  // 10) negative cases — never touch the target
  const badAddr = await rawRpc('orbit.memory.read', { context: targetCtx, address: '0x1FFFFFFFF', count: 4 });
  record('memory.read rejects a >32-bit address (InvalidAddress)', badAddr.error?.data?.errorCode === 'InvalidAddress', badAddr.error?.data);

  const badB64 = await rawRpc('orbit.memory.write', {
    context: { ...targetCtx, idempotencyKey: 'hw-mem-badb64' },
    address: ramAddr, data: '!!!!', verify: true,
  });
  record('memory.write rejects invalid base64 (InvalidRequest)', badB64.error?.data?.errorCode === 'InvalidRequest', badB64.error?.data);

  const summary = {
    baseline: { instanceId: endpoint.instanceId, projectId: endpoint.projectId, sessionId: session.sessionId, sessionGeneration: session.sessionGeneration },
    target: symbol,
    original: `0x${original.toString(16).toUpperCase()}`,
    testValue: `0x${testValue.toString(16).toUpperCase()}`,
    readBefore: before.data,
    runningRead: runningRead.data,
    writeTest: write1.data,
    readAfterWrite: afterWrite.data,
    restore: restore.data,
    readAfterRestore: afterRestore.data,
    finalHaltedRead: finalRead.data,
    steps,
  };
  const out = path.join(__dirname, '..', '..', 'outputs', 'task9-memory-evidence.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(summary, null, 2));
  console.log(`\nEvidence saved to ${out}`);
}

main().catch(e => { record('fatal', false, { message: e?.message ?? String(e), stack: e?.stack }); process.exitCode = 1; });
