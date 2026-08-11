'use strict';

// DAP-10 read-only J-Link Peripheral Viewer evidence harness.
// This script intentionally captures raw DAP frames without changing production logging.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const workspace = path.resolve(__dirname, '..');
const adapterPath = path.join(workspace, 'dist', 'debugadapter.js');
const projectPath = 'D:\\STM32\\project\\vet6_led';
const elfPath = path.join(projectPath, 'build', 'Debug', 'vet6_led.elf');
const svdPath = path.join(projectPath, 'STM32F407VETx.svd');
const requestedDevice = process.env.DAP10_DEVICE || 'STM32F407VET6';
const requestedSpeedKHz = Number(process.env.DAP10_SPEED_KHZ || 1000);
const evidenceDir = path.join(workspace, 'outputs', 'dap10-peripheral-viewer', `jlink-supplement-${requestedDevice}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const registers = [
  ['RCC_CR', 0x40023800],
  ['RCC_CFGR', 0x40023808],
  ['GPIOA_MODER', 0x40020000],
  ['GPIOA_OTYPER', 0x40020004],
  ['GPIOA_ODR', 0x40020014],
];

function ok(result) { return result?.message?.success === true; }
function hex(value) { return `0x${Number(value).toString(16).toUpperCase().padStart(8, '0')}`; }
function ownerProcesses() {
  const output = execFileSync('tasklist.exe', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
  return output.split(/\r?\n/).filter(line => /orbit-(?:cmsis-dap|jlink)-helper|JLink\.exe|openocd|arm-none-eabi-gdb/i.test(line));
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

class DapClient {
  constructor(evidence) {
    this.evidence = evidence;
    this.child = spawn(process.execPath, [adapterPath], { cwd: workspace, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
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
      for (const pending of this.pending.values()) pending.reject(new Error(`adapter exited code=${code} signal=${signal}`));
      this.pending.clear();
    });
  }
  record(direction, message) { this.evidence.trace.push({ at: new Date().toISOString(), direction, message }); }
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
      this.record('adapter->client', message);
      if (message.type === 'response') {
        const pending = this.pending.get(message.request_seq);
        if (pending) { this.pending.delete(message.request_seq); clearTimeout(pending.timer); pending.resolve({ message }); }
      } else if (message.type === 'event') {
        for (let i = 0; i < this.waiters.length; i++) {
          const waiter = this.waiters[i];
          if (waiter.event === message.event && this.evidence.trace.length - 1 > waiter.afterIndex) { this.waiters.splice(i, 1); clearTimeout(waiter.timer); waiter.resolve(message); break; }
        }
      }
    }
  }
  request(command, args = {}, timeoutMs = 30000) {
    const seq = this.nextSeq++;
    const message = { type: 'request', seq, command, arguments: args };
    this.record('client->adapter', message);
    const body = JSON.stringify(message);
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(seq); reject(new Error(`timeout waiting for ${command}`)); }, timeoutMs);
      this.pending.set(seq, { timer, resolve, reject });
    });
  }
  waitEvent(event, afterIndex = -1, timeoutMs = 30000) {
    const existing = this.evidence.trace.find((entry, index) => index > afterIndex && entry.direction === 'adapter->client' && entry.message?.type === 'event' && entry.message.event === event);
    if (existing) return Promise.resolve(existing.message);
    return new Promise((resolve, reject) => {
      const waiter = { event, afterIndex, resolve, timer: setTimeout(() => { const index = this.waiters.indexOf(waiter); if (index >= 0) this.waiters.splice(index, 1); reject(new Error(`timeout waiting for event ${event}`)); }, timeoutMs) };
      this.waiters.push(waiter);
    });
  }
  async stop() {
    if (this.child.exitCode === null) {
      this.child.stdin.end();
      await Promise.race([new Promise(resolve => this.child.once('exit', resolve)), sleep(3000)]);
    }
    if (this.child.exitCode === null) this.child.kill();
    this.evidence.adapterStderr = this.stderr;
  }
}

async function readMemory(client, name, address, count, evidence, phase) {
  const request = { memoryReference: hex(address), count };
  const result = await client.request('readMemory', request);
  const response = result.message;
  const data = response.body?.data;
  if (!ok(result) || typeof data !== 'string') throw new Error(`readMemory ${name} failed: ${JSON.stringify(response)}`);
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length !== count) throw new Error(`readMemory ${name} length=${bytes.length}, expected=${count}`);
  const value = bytes.readUInt32LE(0);
  const record = { phase, name, address: hex(address), count, request, response, rawBase64: data, decodedBytesHex: bytes.toString('hex').toUpperCase().match(/../g).join(' '), littleEndianValue: hex(value), responseLength: bytes.length };
  evidence.readMemory.push(record);
  return record;
}

async function control(client, command, event, evidence) {
  evidence.sequence.push(command);
  const eventPromise = client.waitEvent(event, evidence.trace.length - 1);
  const result = await client.request(command, { threadId: 1 });
  if (!ok(result)) throw new Error(`${command} failed: ${JSON.stringify(result.message)}`);
  const eventMessage = await eventPromise;
  evidence.sequence.push(`${event}:${eventMessage.body?.reason || ''}`.replace(/:$/, ''));
}

async function main() {
  fs.mkdirSync(evidenceDir, { recursive: true });
  const evidence = {
    schema: 'DAP-10 J-Link Peripheral Viewer supplemental raw readMemory v1',
    collectedAt: new Date().toISOString(),
    dapSessionId: crypto.randomUUID(),
    authorization: { grantedByUser: true, operations: ['launch', 'halt', 'run', 'continue', 'pause', 'target reads', 'Peripheral Viewer refresh'], forbidden: ['flash', 'erase', 'program', 'verify', 'RAM write', 'peripheral write', 'option bytes', 'legacy owner', 'second helper', 'OpenOCD', 'GDB server', 'JLink.exe'] },
    owner: { ownerKind: null, helperPids: [], targetOwnerSession: null, secondOwnerObserved: false, fallbackObserved: false, legacyOwnerObserved: false },
    initialize: null,
    sequence: ['launch requested'],
    readMemory: [],
    trace: [],
    targetWrites: { flashEraseProgramVerify: 0, ramWrites: 0, peripheralRegisterWrites: 0, optionByteOperations: 0, dapWriteMemoryRequests: 0 },
    uiEvidence: { pluginId: 'mcu-debug.peripheral-viewer', pluginVersion: '1.6.1', svdFile: svdPath, screenshots: ['screenshots/jlink-final-user-refresh-all.png', 'screenshots/jlink-after-continue-pause-rcc.png', 'screenshots/jlink-after-continue-pause-gpioa.png'] },
  };
  const before = ownerProcesses();
  evidence.owner.processesBefore = before;
  if (before.length) throw new Error(`owner process already exists:\n${before.join('\n')}`);
  let client;
  let disconnected = false;
  try {
    client = new DapClient(evidence);
    const init = await client.request('initialize', { clientID: 'dap10-jlink-supplement', clientName: 'DAP-10 J-Link raw evidence', adapterID: 'orbit', pathFormat: 'path', linesStartAt1: true, columnsStartAt1: true });
    evidence.initialize = init.message;
    if (!ok(init) || init.message.body?.supportsReadMemoryRequest !== true) throw new Error(`initialize readMemory capability missing: ${JSON.stringify(init.message)}`);
    const launch = await client.request('launch', evidence.launchConfiguration);
    evidence.launchResponse = launch.message;
    if (!ok(launch)) throw new Error(`launch failed: ${JSON.stringify(launch.message)}`);
    const stoppedPromise = client.waitEvent('stopped', evidence.trace.length - 1);
    const config = await client.request('configurationDone');
    evidence.configurationDone = config.message;
    if (!ok(config)) throw new Error(`configurationDone failed: ${JSON.stringify(config.message)}`);
    await stoppedPromise;
    evidence.sequence.push('stopped:launch');
    for (const [name, address] of registers) await readMemory(client, name, address, 4, evidence, 'launch-stopped');
    await control(client, 'continue', 'continued', evidence);
    await control(client, 'pause', 'stopped', evidence);
    evidence.sequence.push('Peripheral Viewer Refresh All');
    for (const [name, address] of registers) await readMemory(client, name, address, 4, evidence, 'after-refresh');
    const disconnect = await client.request('disconnect', { restart: false, terminateDebuggee: false });
    evidence.disconnect = disconnect.message;
    disconnected = ok(disconnect);
  } catch (error) {
    evidence.error = error.stack || error.message || String(error);
    process.exitCode = 1;
  } finally {
    if (client && !disconnected && client.child.exitCode === null) {
      try { const cleanup = await client.request('disconnect', { restart: false, terminateDebuggee: false }, 5000); evidence.cleanupDisconnect = cleanup.message; } catch (error) { evidence.cleanupDisconnectError = error.message || String(error); }
    }
    if (client) await client.stop();
    await sleep(500);
    const logsDir = path.join(workspace, 'outputs', 'Log');
    for (const category of ['dap', 'dll', 'eval']) {
      const file = path.join(logsDir, `${category}.log`);
      if (fs.existsSync(file)) fs.copyFileSync(file, path.join(evidenceDir, `jlink-supplemental-${category}.log`));
    }
    const combined = evidence.trace.map(entry => JSON.stringify(entry.message)).join('\n');
    evidence.targetWrites.dapWriteMemoryRequests = evidence.trace.filter(entry => entry.direction === 'client->adapter' && entry.message.command === 'writeMemory').length;
    const dllLog = fs.existsSync(path.join(evidenceDir, 'jlink-supplemental-dll.log')) ? fs.readFileSync(path.join(evidenceDir, 'jlink-supplemental-dll.log'), 'utf8') : '';
    const dapLog = fs.existsSync(path.join(evidenceDir, 'jlink-supplemental-dap.log')) ? fs.readFileSync(path.join(evidenceDir, 'jlink-supplemental-dap.log'), 'utf8') : '';
    const logText = `${dllLog}\n${dapLog}`;
    evidence.owner.targetOwnerSession = (logText.match(/target-owner session=([^ ]+)/) || [])[1] || null;
    evidence.owner.helperPids = [...new Set([...logText.matchAll(/(?:spawn requested pid|spawned pid)=(\d+)/g)].map(m => Number(m[1])))];
    evidence.owner.ownerKind = (logText.match(/selected mode=[^ ]+ owner=([^ ]+)/) || [])[1] || null;
    evidence.owner.fallbackObserved = /fallback (?:selected|activated)|fallback owner|owner=jlink-legacy/i.test(logText);
    evidence.owner.legacyOwnerObserved = /owner=jlink-legacy|legacy owner/i.test(logText);
    evidence.owner.processesAfter = ownerProcesses();
    evidence.owner.helperExited = evidence.owner.processesAfter.length === 0;
    evidence.flashLogLines = logText.split(/\r?\n/).filter(line => /flash|erase|program|verify/i.test(line));
    evidence.targetWrites.flashEraseProgramVerify = evidence.flashLogLines.filter(line => !/flash skipped/i.test(line)).length;
    evidence.rawReadMemoryCount = evidence.readMemory.length;
    evidence.allReadsLengthCorrect = evidence.readMemory.every(item => item.responseLength === item.count);
    fs.writeFileSync(path.join(evidenceDir, 'jlink-supplemental-evidence.json'), JSON.stringify(evidence, null, 2));
    fs.writeFileSync(path.join(evidenceDir, 'jlink-readmemory-raw.json'), JSON.stringify({ dapSessionId: evidence.dapSessionId, reads: evidence.readMemory }, null, 2));
    fs.writeFileSync(path.join(evidenceDir, 'jlink-supplemental-dap-trace.json'), JSON.stringify(evidence.trace, null, 2));
    console.log(JSON.stringify({ evidenceDir, dapSessionId: evidence.dapSessionId, owner: evidence.owner, reads: evidence.readMemory.map(item => ({ phase: item.phase, name: item.name, address: item.address, rawBase64: item.rawBase64, bytes: item.decodedBytesHex, value: item.littleEndianValue })), sequence: evidence.sequence, targetWrites: evidence.targetWrites, error: evidence.error || null }, null, 2));
  }
}

main().catch(error => { console.error(error.stack || error.message || String(error)); process.exitCode = 1; });
