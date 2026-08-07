// DAP-05-HW FPB acceptance through the native CMSIS-DAP helper.
// Requires explicit --hardware authorization. This script never flashes and
// only uses the helper's constrained FPB/control RPC surface.

'use strict';

const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

function argument(name, fallback) {
  const prefix = `--${name}=`;
  const item = process.argv.slice(2).find(value => value.startsWith(prefix));
  return item ? item.slice(prefix.length) : fallback;
}

function integerArgument(name, fallback) {
  const value = Number(argument(name, fallback));
  if (!Number.isInteger(value) || value < 1) throw new Error(`--${name} must be a positive integer`);
  return value;
}

if (!process.argv.includes('--hardware')) {
  console.error('verify-dap05-fpb-hw: refusing to run without --hardware');
  process.exit(2);
}

const workspace = path.resolve(__dirname, '..', '..');
const helperPath = path.resolve(workspace, argument(
  'helper', path.join('out', 'native', 'win32-x64', 'orbit-cmsis-dap-helper.exe'),
));
const vid = argument('vid', 'C251');
const pid = argument('pid', 'F001');
const serial = argument('serial', 'LU_2022_8888');
const rounds = integerArgument('rounds', 20);
const baseAddress = Number(argument('base-address', '0x08003FB0')) >>> 0;

if (!fs.existsSync(helperPath)) throw new Error(`CMSIS-DAP helper not found: ${helperPath}`);

function matchingOwners() {
  const output = execFileSync('tasklist.exe', ['/FO', 'CSV', '/NH'], { encoding: 'utf8' });
  return output.split(/\r?\n/).filter(line =>
    /orbit-(?:cmsis-dap|jlink)-helper|JLink\.exe|openocd|arm-none-eabi-gdb/i.test(line));
}

const existingOwners = matchingOwners();
if (existingOwners.length > 0) {
  throw new Error(`target owner process already exists; refusing to create another owner:\n${existingOwners.join('\n')}`);
}

const evidence = {
  schema: 'Orbit DAP-05 FPB hardware verification v1',
  collectedAt: new Date().toISOString(),
  hardware: {
    mcu: 'STM32F407VET6', probe: 'CMSIS-DAP_LU', transport: 'hid',
    vid, pid, serial, speedKHz: 1000, flashBeforeDebug: false,
  },
  requestedRounds: rounds,
  helperPid: null,
  fpb: null,
  checks: [],
  operations: [],
  stderr: '',
  processesAfter: [],
};

const child = spawn(helperPath, ['--transport=hid'], {
  cwd: workspace,
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe'],
});
evidence.helperPid = child.pid;
const lines = readline.createInterface({ input: child.stdout });
const pending = new Map();
let nextId = 1;
let failures = 0;

child.stderr.setEncoding('utf8');
child.stderr.on('data', chunk => { evidence.stderr += chunk; });
lines.on('line', line => {
  const response = JSON.parse(line);
  const item = pending.get(response.id);
  if (!item) return;
  pending.delete(response.id);
  clearTimeout(item.timer);
  item.resolve(response.result);
});

function request(method, params = {}, timeoutMs = 5000) {
  const id = nextId++;
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout waiting for ${method}`));
    }, timeoutMs);
    pending.set(id, {
      timer,
      resolve: result => {
        const operation = { method, params, elapsedMs: Date.now() - startedAt, result };
        evidence.operations.push(operation);
        resolve(result);
      },
    });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
}

function check(name, ok, details = {}) {
  const item = { name, ok: !!ok, ...details };
  evidence.checks.push(item);
  if (!item.ok) failures += 1;
  console.log(`${item.ok ? 'ok  ' : 'FAIL'} ${name}`);
}

async function waitForExit(timeoutMs = 3000) {
  if (child.exitCode !== null) return;
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, timeoutMs)),
  ]);
}

async function main() {
  let opened = false;
  let connected = false;
  try {
    const hello = await request('hello', { clientProtocol: 1, extensionVersion: 'dap05-fpb-hw' });
    check('helper handshake', hello.ok && hello.data?.capabilities?.includes('hardwareBreakpoints'), { result: hello });

    const open = await request('open', { transport: 'hid', vid, pid, serial }, 10000);
    opened = open.ok;
    check('open selected CMSIS-DAP HID probe', open.ok, { result: open });
    if (!open.ok) return;

    const connect = await request('connect', { port: 'SWD', speedKHz: 1000, timeoutMs: 2000 }, 10000);
    connected = connect.ok;
    check('connect SWD 1000 kHz', connect.ok, { result: connect });
    if (!connect.ok) return;

    const halt = await request('halt', { timeoutMs: 2000 }, 10000);
    check('halt target', halt.ok && halt.targetState === 'Halted', { result: halt });

    const fpb = await request('getFpbInfo', { timeoutMs: 2000 }, 10000);
    evidence.fpb = fpb;
    const comparatorCount = fpb.data?.codeComparators;
    check('probe FPB revision and comparator count', fpb.ok
      && Number.isInteger(fpb.data?.revision)
      && Number.isInteger(comparatorCount)
      && comparatorCount >= 1, { result: fpb });
    if (!fpb.ok || !Number.isInteger(comparatorCount) || comparatorCount < 1) return;

    const addresses = Array.from({ length: comparatorCount }, (_, slot) => (baseAddress + slot * 2) >>> 0);
    for (let slot = 0; slot < comparatorCount; slot++) {
      const set = await request('setBreakpoint', {
        address: addresses[slot], preferredSlot: slot, timeoutMs: 2000,
      }, 10000);
      check(`set/readback comparator slot ${slot}`, set.ok
        && set.data?.slot === slot
        && set.data?.address === addresses[slot]
        && set.data?.comparatorReadback === set.data?.comparatorValue
        && set.data?.codeComparators === comparatorCount, { result: set });
    }

    const duplicate = await request('setBreakpoint', { address: addresses[0], timeoutMs: 2000 }, 10000);
    check('duplicate preserves original slot', duplicate.ok
      && duplicate.data?.slot === 0 && duplicate.data?.duplicate === true, { result: duplicate });

    const exhausted = await request('setBreakpoint', {
      address: (baseAddress + comparatorCount * 2) >>> 0, timeoutMs: 2000,
    }, 10000);
    check('slot exhaustion is structured', !exhausted.ok
      && exhausted.errorCode === 'BreakpointResourceExhausted', { result: exhausted });

    const clearAll = await request('clearAllBreakpoints', { timeoutMs: 2000 }, 10000);
    check('clear all disables FPB', clearAll.ok
      && clearAll.data?.cleared === comparatorCount
      && clearAll.data?.enabled === false, { result: clearAll });

    for (let round = 1; round <= rounds; round++) {
      const set = await request('setBreakpoint', {
        address: baseAddress, preferredSlot: 0, timeoutMs: 2000,
      }, 10000);
      const clear = set.ok
        ? await request('clearBreakpoint', { slot: 0, timeoutMs: 2000 }, 10000)
        : { ok: false };
      check(`set/clear/reuse round ${round}`, set.ok
        && set.data?.slot === 0
        && set.data?.address === baseAddress
        && set.data?.comparatorReadback === set.data?.comparatorValue
        && clear.ok
        && clear.data?.slot === 0
        && clear.data?.comparatorReadback === 0, { set, clear });
    }
  } finally {
    if (connected) {
      try { await request('clearAllBreakpoints', { timeoutMs: 2000 }, 10000); } catch {}
      try { await request('disconnect', {}, 10000); } catch {}
    }
    if (opened) {
      try { await request('close', {}, 10000); } catch {}
    }
    try { await request('shutdown', {}, 10000); } catch {}
    child.stdin.end();
    await waitForExit();
    if (child.exitCode === null) child.kill();
    await waitForExit();
    evidence.processesAfter = matchingOwners();
    evidence.summary = {
      checks: evidence.checks.length,
      failures,
      fpbRevision: evidence.fpb?.data?.revision ?? null,
      codeComparators: evidence.fpb?.data?.codeComparators ?? null,
      jlinkInvolved: /jlink/i.test(evidence.stderr),
      secondOwnerCreated: false,
      helperExited: child.exitCode !== null,
    };
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const outputDir = path.join(workspace, 'outputs', 'dap05', stamp, 'fpb');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'evidence.json'), JSON.stringify(evidence, null, 2), 'utf8');
    console.log(`verify-dap05-fpb-hw: evidence=${outputDir}`);
    console.log(`verify-dap05-fpb-hw: checks=${evidence.summary.checks} failures=${failures}`
      + ` revision=${evidence.summary.fpbRevision} comparators=${evidence.summary.codeComparators}`
      + ` helperExited=${evidence.summary.helperExited}`);
    if (failures > 0 || evidence.processesAfter.length > 0 || !evidence.summary.helperExited) process.exitCode = 1;
  }
}

main().catch(error => {
  failures += 1;
  evidence.fatalError = error.stack || error.message || String(error);
  process.exitCode = 1;
});
