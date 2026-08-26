'use strict';

// P7-5: STM32H723VGT6 real ELF flash-before-debug through the Orbit DAP adapter.
// Usage:
//   node scripts/cmsis-dap/verify-h723-flash-elf-hw.js --hardware --authorize-flash-elf --elf=<path>

const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const {
  H723,
  WORKSPACE,
  argument,
  integerArgument,
  requireHardware,
  requireAuthorize,
  refuseSecondOwner,
  matchingOwnerProcesses,
  hex,
} = require('./h723-hw-harness');

const SCRIPT = 'verify-h723-flash-elf-hw';
requireHardware(SCRIPT);
requireAuthorize(SCRIPT, '--authorize-flash-elf', ['halt', 'reset', 'erase', 'program', 'verify', 'flashBeforeDebug']);
refuseSecondOwner(SCRIPT);

const adapterPath = path.resolve(WORKSPACE, argument('adapter', path.join('dist', 'debugadapter.js')));
const elfPath = path.resolve(argument('elf', ''));
const vid = argument('vid', 'C251');
const pid = argument('pid', 'F001');
const serial = argument('serial', '');
const transport = argument('transport', 'hid');
const speedKHz = integerArgument('speed-khz', 1000);

if (!fs.existsSync(adapterPath)) throw new Error(`DAP adapter not found: ${adapterPath}`);
if (!elfPath || !fs.existsSync(elfPath)) throw new Error(`ELF not found: ${elfPath || '(missing --elf)'}`);

const evidence = {
  schema: 'Orbit H723 P7-5 ELF flash hardware verification v1',
  collectedAt: new Date().toISOString(),
  authorization: {
    grantedByUser: true,
    authorizedOperations: ['halt', 'reset', 'erase', 'program', 'verify', 'flashBeforeDebug'],
    forbiddenOperations: ['option bytes', 'second owner', 'jlink fallback'],
  },
  hardwareRequest: {
    mcu: H723.name,
    probe: H723.probe,
    transport,
    vid,
    pid,
    serial: serial || '(any)',
    speedKHz,
    elfPath,
    flashBeforeDebug: true,
  },
  adapterPid: null,
  trace: [],
  checks: [],
  summary: {},
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function responseOk(result) {
  return !!result?.message?.success;
}

function addCheck(name, ok, details = {}) {
  const check = { name, ok: !!ok, ...details };
  evidence.checks.push(check);
  console.log(`${check.ok ? 'ok  ' : 'FAIL'} ${name}`);
  if (!check.ok && details.message) console.log(`     ${details.message}`);
  return check.ok;
}

class DapClient {
  constructor() {
    this.child = spawn(process.execPath, [adapterPath], {
      cwd: WORKSPACE,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    evidence.adapterPid = this.child.pid;
    this.buffer = Buffer.alloc(0);
    this.nextSeq = 1;
    this.pending = new Map();
    this.waiters = [];
    this.stderr = '';
    this.child.stdout.on('data', chunk => this.onData(chunk));
    this.child.stderr.on('data', chunk => { this.stderr += chunk.toString('utf8'); });
    this.child.on('exit', (code, signal) => {
      evidence.adapterExit = { code, signal };
      for (const pending of this.pending.values()) {
        pending.reject(new Error(`adapter exited code=${code} signal=${signal}`));
      }
      this.pending.clear();
    });
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString('ascii');
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) throw new Error(`invalid DAP header: ${header}`);
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) return;
      const message = JSON.parse(this.buffer.subarray(bodyStart, bodyStart + length).toString('utf8'));
      this.buffer = this.buffer.subarray(bodyStart + length);
      const traceEntry = { index: evidence.trace.length, at: Date.now(), direction: 'adapter->client', message };
      evidence.trace.push(traceEntry);
      if (message.type === 'response') {
        const pending = this.pending.get(message.request_seq);
        if (pending) {
          this.pending.delete(message.request_seq);
          clearTimeout(pending.timer);
          pending.resolve({ message, elapsedMs: Date.now() - pending.startedAt, traceIndex: traceEntry.index });
        }
      } else if (message.type === 'event') {
        for (let index = 0; index < this.waiters.length; index += 1) {
          const waiter = this.waiters[index];
          if (waiter.event === message.event && traceEntry.index > waiter.afterIndex) {
            this.waiters.splice(index, 1);
            clearTimeout(waiter.timer);
            waiter.resolve({ message, traceIndex: traceEntry.index });
            break;
          }
        }
      }
    }
  }

  request(command, args = {}, timeoutMs = 15000) {
    const seq = this.nextSeq++;
    const message = { type: 'request', seq, command, arguments: args };
    evidence.trace.push({ index: evidence.trace.length, at: Date.now(), direction: 'client->adapter', message });
    const body = JSON.stringify(message);
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error(`timeout waiting for ${command}`));
      }, timeoutMs);
      this.pending.set(seq, { timer, startedAt: Date.now(), resolve, reject });
    });
  }

  waitEvent(event, afterIndex, timeoutMs = 15000) {
    const existing = evidence.trace.find(entry =>
      entry.index > afterIndex && entry.message?.type === 'event' && entry.message.event === event);
    if (existing) return Promise.resolve({ message: existing.message, traceIndex: existing.index });
    return new Promise((resolve, reject) => {
      const waiter = { event, afterIndex, resolve, timer: null };
      waiter.timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`timeout waiting for event ${event}`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  async stop() {
    if (this.child.exitCode === null) {
      this.child.stdin.end();
      await Promise.race([
        new Promise(resolve => this.child.once('exit', resolve)),
        sleep(3000),
      ]);
    }
    if (this.child.exitCode === null) this.child.kill();
    evidence.adapterStderr = this.stderr;
  }
}

function readLog(name) {
  const logPath = path.join(WORKSPACE, 'outputs', 'Log', name);
  return fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
}

async function main() {
  const client = new DapClient();
  let thrown = null;
  try {
    const initialize = await client.request('initialize', {
      clientID: 'orbit-h723-p7-5',
      adapterID: 'orbit',
      pathFormat: 'path',
      linesStartAt1: true,
      columnsStartAt1: true,
    });
    addCheck('initialize', responseOk(initialize), { message: initialize.message.message });

    const launchStart = evidence.trace.length - 1;
    const launchArgs = {
      program: elfPath,
      device: H723.name,
      deviceName: H723.name,
      interface: 'SWD',
      speedKHz,
      probe: 'cmsis-dap',
      cmsisDapTransport: transport,
      cmsisDapVid: vid,
      cmsisDapPid: pid,
      flashBeforeDebug: true,
      nativeDebugEngineEnabled: true,
      nativeDebugEngineMode: 'auto',
      loggingEnabled: true,
      clearLogsOnStart: true,
      rttLogEnabled: false,
    };
    if (serial) launchArgs.cmsisDapSerial = serial;
    const launch = await client.request('launch', launchArgs, 120000);
    addCheck('launch flashBeforeDebug=true', responseOk(launch), { elapsedMs: launch.elapsedMs, message: launch.message.message });
    if (!responseOk(launch)) throw new Error(`launch failed: ${launch.message.message}`);

    const configurationDone = await client.request('configurationDone');
    const stopped = await client.waitEvent('stopped', launchStart, 15000);
    addCheck('configurationDone', responseOk(configurationDone), { message: configurationDone.message.message });
    addCheck('stopped after authorized flash', !!stopped.message.body, { reason: stopped.message.body?.reason });

    const state = await client.request('getTargetState');
    addCheck('target halted after flash', responseOk(state)
      && String(state.message.body?.state || state.message.body || '').toLowerCase() === 'halted',
    { body: state.message.body });

    const vector = await client.request('readMemory', { memoryReference: hex(H723.flashBase), count: 8 });
    addCheck('Flash vector readable after program', responseOk(vector)
      && Buffer.from(vector.message.body?.data || '', 'base64').length === 8,
    { response: vector.message });

    const disconnect = await client.request('disconnect', { restart: false, terminateDebuggee: false }, 10000);
    addCheck('disconnect', responseOk(disconnect), { message: disconnect.message.message });
  } catch (error) {
    thrown = error;
    evidence.abortError = error.stack || error.message || String(error);
    process.exitCode = 1;
  } finally {
    await client.stop();
    await sleep(500);
    const logs = { dap: readLog('dap.log'), dll: readLog('dll.log') };
    const combined = `${logs.dap}\n${logs.dll}`;
    const helperPids = [...combined.matchAll(/\[cmsis-dap process\] spawned pid=(\d+)/g)].map(match => Number(match[1]));
    const ownerKinds = [...logs.dll.matchAll(/selected probe=([^ ]+) owner=([^ ]+)/g)].map(match => match[2]);
    const jlinkLines = combined.split(/\r?\n/).filter(line => /owner=jlink-|J-Link DLL|JLink\.exe|openocd|arm-none-eabi-gdb/i.test(line));
    const flashLines = combined.split(/\r?\n/).filter(line => /Flashing |flash operation=|CMSIS-DAP Flash successful/.test(line));
    const failedChecks = evidence.checks.filter(check => !check.ok);
    evidence.summary = {
      checks: evidence.checks.length,
      failedChecks: failedChecks.length,
      helperPids: [...new Set(helperPids)],
      ownerKinds: [...new Set(ownerKinds)],
      jlinkInvolved: jlinkLines.length > 0,
      jlinkLines,
      flashOperationLines: flashLines,
      flashOperationCount: flashLines.length,
      processesAfter: matchingOwnerProcesses(),
    };
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const outDir = path.join(WORKSPACE, 'outputs', 'h723-p7');
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `${SCRIPT}-${stamp}.json`);
    fs.writeFileSync(outPath, JSON.stringify(evidence, null, 2), 'utf8');
    console.log(`${SCRIPT}: evidence written to ${outPath}`);
    if (thrown) console.error(`${SCRIPT}: ${thrown.message}`);
    if (!thrown && (failedChecks.length > 0
      || evidence.summary.jlinkInvolved
      || evidence.summary.flashOperationCount === 0
      || evidence.summary.processesAfter.length > 0
      || (evidence.summary.ownerKinds.length > 0 && evidence.summary.ownerKinds.some(owner => owner !== 'cmsis-dap')))) {
      process.exitCode = 1;
    } else if (!thrown) {
      console.log(`${SCRIPT}: all checks passed`);
    }
  }
}

main();
