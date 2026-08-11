'use strict';

// DAP-09 authorized real-hardware dynamic task lifecycle acceptance.
// By default this harness flashes the explicitly authorized fixture once.
// Pass --no-flash for the formal read-only measurement run.
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const {
  collectFlashOperationLines,
  compareLifecycleScalarValues,
  requiresLifecycleRestart,
  resolveFlashBeforeDebug,
  validateLifecycleSummary,
} = require('./dap09-lifecycle-evidence-validation');

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const item = process.argv.slice(2).find(value => value.startsWith(prefix));
  return item ? item.slice(prefix.length) : fallback;
}
function intArg(name, fallback, minimum = 1) {
  const value = Number(arg(name, fallback));
  if (!Number.isInteger(value) || value < minimum) throw new Error(`--${name} must be an integer >= ${minimum}`);
  return value;
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function ok(result) { return result?.message?.success === true; }
function parseNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = String(value ?? '').trim();
  const hex = /0x[0-9a-f]+/i.exec(text);
  if (hex) return Number.parseInt(hex[0], 16);
  const decimal = /^-?\d+/.exec(text);
  return decimal ? Number(decimal[0]) : null;
}
function hex(value) { return Number.isFinite(value) ? `0x${Number(value).toString(16).toUpperCase().padStart(8, '0')}` : null; }
function decodeCString(bytes) {
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end < 0 ? bytes.length : end).toString('ascii');
}
function targetOwnerProcesses() {
  const output = execFileSync('tasklist.exe', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
  return output.split(/\r?\n/).filter(line => /orbit-(?:cmsis-dap|jlink)-helper|JLink\.exe|openocd|arm-none-eabi-gdb/i.test(line));
}
function readLogs(workspace) {
  const logs = {};
  for (const category of ['dap', 'dll', 'eval']) {
    const file = path.join(workspace, 'outputs', 'Log', `${category}.log`);
    logs[category] = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  }
  return logs;
}
function resolveSymbols(elfPath, names) {
  const output = execFileSync('arm-none-eabi-nm', ['-n', elfPath], { encoding: 'utf8' });
  const symbols = {};
  for (const line of output.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]+)\s+[A-Za-z]\s+(\S+)$/.exec(line.trim());
    if (match && names.includes(match[2])) symbols[match[2]] = Number.parseInt(match[1], 16);
  }
  for (const name of names) if (!Number.isFinite(symbols[name])) throw new Error(`ELF symbol not found: ${name}`);
  return symbols;
}

if (!process.argv.includes('--hardware')) {
  console.error('verify-dap09-lifecycle-hw: refusing to run without --hardware');
  process.exit(2);
}

const workspace = path.resolve(__dirname, '..', '..');
const adapterPath = path.resolve(workspace, arg('adapter', path.join('dist', 'debugadapter.js')));
const projectPath = path.resolve(arg('project', 'D:\\STM32\\project\\vet6_led'));
const elfPath = path.resolve(arg('elf', path.join(projectPath, 'build', 'Debug', 'vet6_led.elf')));
const pollMs = intArg('poll-ms', 50, 20);
const speedKHz = intArg('speed-khz', 1000);
const vid = arg('vid', 'C251').toUpperCase();
const pid = arg('pid', 'F001').toUpperCase();
const serial = arg('serial', 'LU_2022_8888');
const flashBeforeDebug = resolveFlashBeforeDebug(process.argv.slice(2));
for (const file of [adapterPath, elfPath]) if (!fs.existsSync(file)) throw new Error(`required file not found: ${file}`);
const symbols = resolveSymbols(elfPath, [
  'g_dap09_lifecycle_round', 'g_dap09_lifecycle_phase', 'g_dap09_lifecycle_create_count',
  'g_dap09_lifecycle_delete_count', 'g_dap09_lifecycle_live', 'g_dap09_lifecycle_worker_counter',
  'g_dap09_lifecycle_worker_tcb',
]);
const ownerBefore = targetOwnerProcesses();
if (ownerBefore.length) throw new Error(`target owner process already exists; refusing to create another owner:\n${ownerBefore.join('\n')}`);

const evidence = {
  schema: 'Orbit DAP-09 dynamic lifecycle hardware acceptance v1',
  collectedAt: new Date().toISOString(),
  authorization: flashBeforeDebug
    ? { grantedByUser: true, authorizedOperations: ['flash', 'erase', 'program', 'verify', 'reset', 'halt', 'run', 'continue', 'pause', 'target reads'], forbiddenOperations: ['target memory write', 'breakpoint', 'option bytes', 'second owner'] }
    : { grantedByUser: true, authorizedOperations: ['reset', 'halt', 'run', 'continue', 'pause', 'target reads'], forbiddenOperations: ['flash', 'erase', 'program', 'verify', 'target memory write', 'breakpoint', 'option bytes', 'second owner'] },
  hardwareRequest: { mcu: 'STM32F407VET6', probe: 'cmsis-dap', transport: 'hid', vid, pid, serial, speedKHz, elfPath, flashBeforeDebug },
  symbols,
  trace: [],
  samples: [],
  rounds: [],
  errors: [],
};

class DapClient {
  constructor() {
    this.child = spawn(process.execPath, [adapterPath], { cwd: workspace, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    evidence.adapterPid = this.child.pid;
    this.buffer = Buffer.alloc(0); this.nextSeq = 1; this.pending = new Map(); this.waiters = []; this.stderr = '';
    this.child.stdout.on('data', chunk => this.onData(chunk));
    this.child.stderr.on('data', chunk => { this.stderr += chunk.toString('utf8'); });
    this.child.on('exit', (code, signal) => { evidence.adapterExit = { code, signal }; for (const pending of this.pending.values()) pending.reject(new Error(`adapter exited code=${code} signal=${signal}`)); this.pending.clear(); });
  }
  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n'); if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString('ascii'); const match = /Content-Length:\s*(\d+)/i.exec(header); if (!match) throw new Error(`invalid DAP header: ${header}`);
      const length = Number(match[1]); const bodyStart = headerEnd + 4; if (this.buffer.length < bodyStart + length) return;
      const message = JSON.parse(this.buffer.subarray(bodyStart, bodyStart + length).toString('utf8')); this.buffer = this.buffer.subarray(bodyStart + length);
      const traceEntry = { index: evidence.trace.length, at: Date.now(), direction: 'adapter->client', message }; evidence.trace.push(traceEntry);
      if (message.type === 'response') {
        const pending = this.pending.get(message.request_seq); if (pending) { this.pending.delete(message.request_seq); clearTimeout(pending.timer); pending.resolve({ message, elapsedMs: Date.now() - pending.startedAt }); }
      } else if (message.type === 'event') {
        for (let index = 0; index < this.waiters.length; index++) { const waiter = this.waiters[index]; if (waiter.event === message.event && traceEntry.index > waiter.afterIndex) { this.waiters.splice(index, 1); clearTimeout(waiter.timer); waiter.resolve({ message }); break; } }
      }
    }
  }
  request(command, args = {}, timeoutMs = 15000) {
    const seq = this.nextSeq++; const message = { type: 'request', seq, command, arguments: args }; evidence.trace.push({ index: evidence.trace.length, at: Date.now(), direction: 'client->adapter', message });
    const body = JSON.stringify(message); this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
    return new Promise((resolve, reject) => { const timer = setTimeout(() => { this.pending.delete(seq); reject(new Error(`timeout waiting for ${command}`)); }, timeoutMs); this.pending.set(seq, { timer, startedAt: Date.now(), resolve, reject }); });
  }
  waitEvent(event, afterIndex, timeoutMs = 15000) {
    const existing = evidence.trace.find(entry => entry.index > afterIndex && entry.message?.type === 'event' && entry.message.event === event); if (existing) return Promise.resolve({ message: existing.message });
    return new Promise((resolve, reject) => { const waiter = { event, afterIndex, resolve, timer: null }; waiter.timer = setTimeout(() => { const index = this.waiters.indexOf(waiter); if (index >= 0) this.waiters.splice(index, 1); reject(new Error(`timeout waiting for event ${event}`)); }, timeoutMs); this.waiters.push(waiter); });
  }
  async stop() { if (this.child.exitCode === null) { this.child.stdin.end(); await Promise.race([new Promise(resolve => this.child.once('exit', resolve)), sleep(3000)]); } if (this.child.exitCode === null) this.child.kill(); evidence.adapterStderr = this.stderr; }
}

async function requestWatchValues(client, expressions) {
  const result = await client.request('watchEvaluate', { expressions }, 15000);
  if (!ok(result)) throw new Error(`watchEvaluate failed: ${JSON.stringify(result.message)}`);
  const values = {};
  for (const item of result.message.body?.results || []) {
    values[item.expression] = parseNumber(item.value ?? item.numericValue ?? item.display ?? item.hex);
  }
  return values;
}
async function readMemory(client, address, count) {
  const result = await client.request('readMemory', { memoryReference: hex(address), count }, 15000);
  if (!ok(result) || typeof result.message.body?.data !== 'string') throw new Error(`readMemory ${hex(address)} failed: ${JSON.stringify(result.message)}`);
  return Buffer.from(result.message.body.data, 'base64');
}
async function requestHaltedValues(client) {
  const values = {};
  for (const name of Object.keys(symbols)) {
    const result = await client.request('evaluate', { expression: name, context: 'hover', frameId: 1 }, 15000);
    if (!ok(result)) throw new Error(`evaluate ${name} failed: ${JSON.stringify(result.message)}`);
    values[name] = parseNumber(result.message.body?.result);
  }
  return values;
}
async function readLifecycleScalarSnapshot(client) {
  const entries = Object.entries(symbols).sort((left, right) => left[1] - right[1]);
  const baseAddress = entries[0][1];
  const byteLength = entries.at(-1)[1] - baseAddress + 4;
  const bytes = await readMemory(client, baseAddress, byteLength);
  const values = {};
  const fields = {};
  for (const [name, address] of entries) {
    const offset = address - baseAddress;
    const fieldBytes = bytes.subarray(offset, offset + 4);
    values[name] = fieldBytes.readUInt32LE(0);
    fields[name] = { address: hex(address), bytes: fieldBytes.toString('hex').toUpperCase(), value: values[name] };
  }
  return { baseAddress: hex(baseAddress), byteLength, data: bytes.toString('base64'), values, fields };
}
async function captureRound(client, round, phase, values) {
  const snapshotValues = await requestHaltedValues(client);
  const directMemory = await readLifecycleScalarSnapshot(client);
  const scalarMismatches = compareLifecycleScalarValues(snapshotValues, directMemory.values);
  if (scalarMismatches.length) throw new Error(`lifecycle scalar readMemory mismatch: ${scalarMismatches.join(', ')}`);
  const rtosInfo = await client.request('rtosInfo');
  const rootEvaluate = await client.request('evaluate', { expression: 'pxReadyTasksLists', context: 'hover', frameId: 1 });
  const rootReference = rootEvaluate.message.body?.variablesReference || 0;
  const rootVariables = rootReference ? await client.request('variables', { variablesReference: rootReference }) : null;
  const workerTcb = await readMemory(client, symbols.g_dap09_lifecycle_worker_tcb, 4);
  const tcbAddress = workerTcb.readUInt32LE(0);
  let task = null;
  if (tcbAddress) {
    const bytes = await readMemory(client, tcbAddress, 100);
    task = { tcbAddress: hex(tcbAddress), name: decodeCString(bytes.subarray(52, 68)), tcbNumber: bytes.readUInt32LE(72) };
  }
  return {
    round, phase, values: snapshotValues, directMemory, scalarMismatches, rtosInfo: rtosInfo.message, rootEvaluate: rootEvaluate.message,
    rootVariables: rootVariables?.message || null, rootVariablesCount: rootVariables?.message?.body?.variables?.length || 0,
    workerTcbPointer: tcbAddress ? hex(tcbAddress) : null, task,
  };
}
async function control(client, command, event) {
  const after = evidence.trace.length - 1; const waiter = client.waitEvent(event, after); const result = await client.request(command, command === 'continue' || command === 'pause' ? { threadId: 1 } : {}); await waiter; if (!ok(result)) throw new Error(`${command} failed: ${JSON.stringify(result.message)}`);
}

async function main() {
  const client = new DapClient(); let disconnected = false;
  try {
    const init = await client.request('initialize', { clientID: 'orbit-dap09-lifecycle', adapterID: 'orbit', pathFormat: 'path', linesStartAt1: true, columnsStartAt1: true });
    if (!ok(init)) throw new Error('initialize failed');
    const launch = await client.request('launch', { program: elfPath, device: 'STM32F407VE', deviceName: 'STM32F407VE', interface: 'SWD', speedKHz, probe: 'cmsis-dap', cmsisDapTransport: 'hid', cmsisDapVid: vid, cmsisDapPid: pid, cmsisDapSerial: serial, flashBeforeDebug, runToEntryPoint: 'osKernelStart', rtos: 'FreeRTOS', nativeDebugEngineEnabled: true, nativeDebugEngineMode: 'auto', loggingEnabled: true, clearLogsOnStart: true, rttLogEnabled: false }, 30000);
    if (!ok(launch)) throw new Error(`launch failed: ${JSON.stringify(launch.message)}`);
    const stopped = client.waitEvent('stopped', evidence.trace.length - 1); const configuration = await client.request('configurationDone'); if (!ok(configuration)) throw new Error('configurationDone failed'); await stopped;
    if (requiresLifecycleRestart(flashBeforeDebug)) await control(client, 'restart', 'stopped');
    await control(client, 'continue', 'continued');

    const started = Date.now(); const seen = new Map(); let complete = false;
    while (Date.now() - started < 30000 && !complete) {
      const values = await requestWatchValues(client, Object.keys(symbols));
      const round = values.g_dap09_lifecycle_round; const phase = values.g_dap09_lifecycle_phase;
      if (Number.isInteger(round) && round >= 1 && round <= 20) {
        const record = seen.get(round) || { round, createdSeen: false, deletedSeen: false, activeAfterDelete: false, createCount: null, deleteCount: null, workerCounterBefore: null, workerCounterAfter: null, samples: [] };
        record.samples.push({ at: Date.now(), phase, live: values.g_dap09_lifecycle_live, workerTcb: values.g_dap09_lifecycle_worker_tcb });
        if (phase === 1 && !record.createdSeen) {
          await control(client, 'pause', 'stopped');
          const snapshot = await captureRound(client, round, 'created', values);
          record.createdSeen = true;
          record.workerCounterBefore = snapshot.values.g_dap09_lifecycle_worker_counter;
          record.createCount = snapshot.values.g_dap09_lifecycle_create_count;
          record.deleteCount = snapshot.values.g_dap09_lifecycle_delete_count;
          record.created = snapshot;
          await control(client, 'continue', 'continued');
        }
        if (phase === 2 && !record.deletedSeen) {
          await control(client, 'pause', 'stopped');
          const snapshot = await captureRound(client, round, 'deleted', values);
          record.deletedSeen = true;
          record.createCount = snapshot.values.g_dap09_lifecycle_create_count;
          record.deleteCount = snapshot.values.g_dap09_lifecycle_delete_count;
          record.deleted = snapshot;
          record.activeAfterDelete = snapshot.workerTcbPointer !== null;
          record.workerCounterAfter = snapshot.values.g_dap09_lifecycle_worker_counter;
          await control(client, 'continue', 'continued');
        }
        seen.set(round, record);
      }
      if (phase === 3) complete = true;
      await sleep(pollMs);
    }
    evidence.rounds = [...seen.values()].sort((a, b) => a.round - b.round);
    await control(client, 'pause', 'stopped');
    const disconnect = await client.request('disconnect', { restart: false, terminateDebuggee: false }); disconnected = ok(disconnect); evidence.disconnect = { ok: disconnected, response: disconnect.message };
  } catch (error) { evidence.errors.push({ message: error.stack || error.message || String(error) }); process.exitCode = 1; }
  finally {
    if (!disconnected && client.child.exitCode === null) { try { const cleanup = await client.request('disconnect', { restart: false, terminateDebuggee: false }, 5000); evidence.cleanupDisconnect = { ok: ok(cleanup), response: cleanup.message }; } catch (error) { evidence.cleanupDisconnectError = error.message || String(error); } }
    await client.stop(); await sleep(500);
    const logs = readLogs(workspace); const combined = `${logs.dap}\n${logs.dll}`;
    const helperPids = [...new Set([...combined.matchAll(/\[cmsis-dap process\] spawned pid=(\d+)/g)].map(match => Number(match[1])))];
    const ownerKinds = [...new Set([...logs.dll.matchAll(/selected probe=([^ ]+) owner=([^ ]+)/g)].map(match => match[2]))];
    const unexpectedOwnerLines = combined.split(/\r?\n/).filter(line => /owner=jlink-|J-Link DLL|JLink\.exe|openocd|arm-none-eabi-gdb/i.test(line));
    const flashLines = collectFlashOperationLines(combined);
    evidence.summary = { ownerKinds, helperPids, processesAfter: targetOwnerProcesses(), flashBeforeDebug, flashOperationLines: flashLines, unexpectedFlashCount: flashBeforeDebug ? 0 : flashLines.length, authorizedFlashLines: flashBeforeDebug ? flashLines : [], unexpectedOwnerLines, rtosInfoOk: evidence.rounds.some(round => round.created?.rtosInfo?.body?.detected === true), rounds: evidence.rounds, disconnectOk: evidence.disconnect?.ok === true };
    const violations = validateLifecycleSummary(evidence.summary); evidence.summary.validation = { ok: violations.length === 0, violations }; if (violations.length) { for (const violation of violations) evidence.errors.push({ message: `validation: ${violation}` }); process.exitCode = 1; }
    evidence.summary.errors = evidence.errors.length;
    const outputDir = path.join(workspace, 'outputs', 'dap09', 'hardware', new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)); fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'lifecycle-evidence.json'), JSON.stringify(evidence, null, 2)); for (const [category, content] of Object.entries(logs)) fs.writeFileSync(path.join(outputDir, `${category}.log`), content);
    console.log(`verify-dap09-lifecycle-hw: evidence written to ${outputDir}`); console.log(JSON.stringify(evidence.summary, null, 2));
  }
}
main();
