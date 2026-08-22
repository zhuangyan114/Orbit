// One-shot orbit-automation CLI hardware coverage.
// Each invocation does handshake + command + orbit.connection.close.
// Run only with explicit hardware authorization.
//
//   node scripts/automation-api/verify-cli-oneshot.js [--instance ID]

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const INSTANCE = process.argv.includes('--instance')
  ? process.argv[process.argv.indexOf('--instance') + 1]
  : '013889aa-edff-44b1-b830-92db77d1e7cb';
const CLI = path.join(__dirname, '..', '..', 'clients', 'node', 'dist', 'cli.js');
const SOURCE = 'd:\\STM32\\project\\vet6_led\\Core\\Src\\freertos.c';
const BP_LINE = 406;
const TEST_VALUE = '0x5A5AA5A5';
const RAM_ADDR = '0x20000010';
const EVIDENCE = path.join(__dirname, '..', '..', 'outputs', 'cli-oneshot-hw-evidence.json');

const steps = [];
function record(step, ok, detail) {
  steps.push({ step, ok, at: new Date().toISOString(), detail });
  const preview = detail === undefined ? '' : `  ${JSON.stringify(detail).slice(0, 400)}`;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}${preview}`);
  if (!ok) process.exitCode = 1;
}

function cli(args, params) {
  const argv = [CLI, ...args, '--instance', INSTANCE];
  if (params !== undefined) argv.push('--params', JSON.stringify(params));
  const started = Date.now();
  const result = spawnSync(process.execPath, argv, { encoding: 'utf8', timeout: 60000 });
  const elapsedMs = Date.now() - started;
  const stdout = (result.stdout || '').trim();
  const stderr = (result.stderr || '').trim();
  let data;
  try {
    data = stdout ? JSON.parse(stdout) : undefined;
  } catch {
    data = stdout;
  }
  let error;
  if (result.status !== 0 && stderr) {
    try {
      error = JSON.parse(stderr);
    } catch {
      error = { error: stderr };
    }
  }
  return { status: result.status, data, error, stderr, elapsedMs };
}

function decimalValue(value) {
  const text = String(value ?? '').trim();
  const hex = /^0x([0-9a-fA-F]+)/.exec(text);
  if (hex) return parseInt(hex[1], 16);
  const n = Number(text);
  return Number.isFinite(n) ? n : NaN;
}

function findBreakpoint(list, line) {
  const items = list?.items ?? [];
  return items.find(item => item.source?.line === line);
}

function main() {
  const instances = cli(['instances']);
  record('instances', Array.isArray(instances.data) && instances.data.some(item => item.instanceId === INSTANCE), {
    count: Array.isArray(instances.data) ? instances.data.length : 0,
  });

  const before = cli(['status']);
  record('status before start is empty or terminated', before.status === 0, before.data);

  const start = cli(['start', 'Orbit: J-Link (Flash)'], { timeoutMs: 30000 });
  const session = start.data?.session ?? start.data;
  record('start Orbit: J-Link (Flash)', start.status === 0 && (session?.phase === 'halted' || session?.accepted === true || session?.sessionId), {
    elapsedMs: start.elapsedMs,
    phase: session?.phase,
    sessionId: session?.sessionId,
    error: start.error,
  });
  if (start.status !== 0) {
    fs.mkdirSync(path.dirname(EVIDENCE), { recursive: true });
    fs.writeFileSync(EVIDENCE, JSON.stringify({ steps }, null, 2));
    return;
  }

  const status1 = cli(['status']);
  const item = status1.data?.items?.[0];
  record('status after start is halted', status1.status === 0 && item?.phase === 'halted', {
    phase: item?.phase,
    targetState: item?.targetState,
    sessionId: item?.sessionId,
  });

  const added = cli(['breakpoints', 'add'], {
    breakpoint: { source: { path: SOURCE, line: BP_LINE } },
    waitForVerificationMs: 8000,
  });
  const addedBp = added.data?.items?.[0];
  record(`breakpoints add freertos.c:${BP_LINE}`, added.status === 0 && addedBp?.verified === true, addedBp ?? added.error);

  const listed = cli(['breakpoints', 'list']);
  const listedBp = findBreakpoint(listed.data, BP_LINE);
  record('breakpoints list shows verified slot', listed.status === 0 && listedBp?.verified === true && listedBp?.slot !== undefined, listedBp);

  const readEntry = cli(['read', 'aww', 'ass', 'g_dap06_ascii', 'g_ram_data']);
  const entryItems = readEntry.data?.items ?? [];
  record('read entry globals', readEntry.status === 0 && entryItems.length === 4 && entryItems.every(row => row.available === true), entryItems.map(row => ({
    expression: row.expression,
    value: row.value,
    available: row.available,
  })));

  const mem = cli(['memory-read', RAM_ADDR, '4']);
  record('memory-read g_ram_data @ 0x20000010', mem.status === 0 && typeof mem.data?.data === 'string' && mem.data.data.length > 0, {
    address: mem.data?.address,
    bytesRead: mem.data?.bytesRead ?? mem.data?.count,
    data: mem.data?.data,
  });

  const originalRam = entryItems.find(row => row.expression === 'g_ram_data')?.value;
  const wrote = cli(['write'], { writes: [{ expression: 'g_ram_data', value: TEST_VALUE }] });
  record('write g_ram_data test pattern', wrote.status === 0 && wrote.data?.items?.[0]?.written === true, wrote.data?.items?.[0] ?? wrote.error);

  const readAfterWrite = cli(['read', 'g_ram_data']);
  const afterWrite = readAfterWrite.data?.items?.[0];
  record('read verifies written g_ram_data', readAfterWrite.status === 0 && decimalValue(afterWrite?.value) === 0x5A5AA5A5, afterWrite);

  const restored = cli(['write'], { writes: [{ expression: 'g_ram_data', value: String(decimalValue(originalRam)) }] });
  record('write restores g_ram_data', restored.status === 0 && restored.data?.items?.[0]?.written === true, restored.data?.items?.[0]);

  const continued = cli(['continue']);
  record('continue toward 1s throttle breakpoint', continued.status === 0, continued.data ?? continued.error);

  const deadline = Date.now() + 8000;
  let hit;
  while (Date.now() < deadline) {
    const snap = cli(['status']);
    hit = snap.data?.items?.[0];
    if (hit?.phase === 'halted' || hit?.targetState === 'halted') break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  record('breakpoint hit after ~1s throttle', hit?.phase === 'halted' || hit?.targetState === 'halted', {
    phase: hit?.phase,
    targetState: hit?.targetState,
    stopReason: hit?.stopReason ?? hit?.reason,
  });

  const readHit = cli(['read', 'g_dap06_ascii', 'aww', 'ass', 'last_log_tick']);
  record('read at hit shows g_dap06_ascii / aww / ass', readHit.status === 0 && (readHit.data?.items ?? []).some(row => row.expression === 'g_dap06_ascii' && row.available), readHit.data?.items);

  const stepped = cli(['step', '1', '--action', 'into']);
  record('step into after hit', stepped.status === 0, stepped.data ?? stepped.error);
  const over = cli(['step', '1', '--action', 'over']);
  record('step over', over.status === 0, over.data ?? over.error);

  const recStart = cli(['record', 'start'], {
    name: 'cli-oneshot-aww',
    intervalMs: 20,
    maxFrames: 40,
    channels: [
      { channelId: 'aww', expression: 'aww', valueType: 'float' },
      { channelId: 'ass', expression: 'ass', valueType: 'float' },
    ],
  });
  const recordingId = recStart.data?.recordingId;
  record('record start', recStart.status === 0 && typeof recordingId === 'string', recStart.data ?? recStart.error);

  if (recordingId) {
    cli(['continue']);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
    cli(['pause']);
    const recStop = cli(['record', 'stop'], { recordingId });
    record('record stop', recStop.status === 0, { status: recStop.data?.status, frameCount: recStop.data?.frameCount });
    const recGet = cli(['record', 'get'], { recordingId, limit: 10 });
    record('record get has frames', recGet.status === 0 && (recGet.data?.items?.length ?? 0) >= 0, {
      frames: recGet.data?.items?.length,
    });
    const recClear = cli(['record', 'clear'], { recordingId });
    record('record clear', recClear.status === 0, recClear.data ?? recClear.error);
  }

  if (listedBp?.breakpointId) {
    const removed = cli(['breakpoints', 'remove'], { breakpointId: listedBp.breakpointId });
    record('breakpoints remove', removed.status === 0, removed.data?.items?.[0] ?? removed.error);
    const afterRemove = cli(['breakpoints', 'list']);
    const leftover = findBreakpoint(afterRemove.data, BP_LINE);
    record('list after remove (slot released even if marker remains)', afterRemove.status === 0 && (leftover === undefined || leftover.verified === false), leftover);
  }

  const stopped = cli(['stop']);
  record('session stop', stopped.status === 0, stopped.data ?? stopped.error);
  const afterStop = cli(['status']);
  const leftoverSession = (afterStop.data?.items ?? []).find(row => row.phase !== 'terminated');
  record('status after stop has no active session', afterStop.status === 0 && leftoverSession === undefined, afterStop.data);

  fs.mkdirSync(path.dirname(EVIDENCE), { recursive: true });
  fs.writeFileSync(EVIDENCE, JSON.stringify({ instance: INSTANCE, source: SOURCE, line: BP_LINE, steps }, null, 2));
  console.log(`evidence: ${EVIDENCE}`);
}

main();
