'use strict';

// DAP-09 authorized hardware session replacement. The fixture is already
// flashed by the lifecycle run, so both sessions are read/control only.
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { collectFlashOperationLines, validateReplacementSummary } = require('./dap09-lifecycle-evidence-validation');

function arg(name, fallback) { const prefix = `--${name}=`; const item = process.argv.slice(2).find(value => value.startsWith(prefix)); return item ? item.slice(prefix.length) : fallback; }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function ok(result) { return result?.message?.success === true; }
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
function ownerSummary(logs) {
  const combined = `${logs.dap}\n${logs.dll}`;
  return {
    ownerKinds: [...new Set([...logs.dll.matchAll(/selected probe=([^ ]+) owner=([^ ]+)/g)].map(match => match[2]))],
    helperPids: [...new Set([...combined.matchAll(/\[cmsis-dap process\] spawned pid=(\d+)/g)].map(match => Number(match[1])))],
    unexpectedOwnerLines: combined.split(/\r?\n/).filter(line => /owner=jlink-|J-Link DLL|JLink\.exe|openocd|arm-none-eabi-gdb/i.test(line)),
    flashOperationLines: collectFlashOperationLines(combined),
  };
}

if (!process.argv.includes('--hardware')) { console.error('verify-dap09-session-replacement-hw: refusing to run without --hardware'); process.exit(2); }
const workspace = path.resolve(__dirname, '..', '..');
const adapterPath = path.resolve(workspace, arg('adapter', path.join('dist', 'debugadapter.js')));
const elfPath = path.resolve(arg('elf', 'D:\\STM32\\project\\vet6_led\\build\\Debug\\vet6_led.elf'));
const speedKHz = Number(arg('speed-khz', 1000));
const vid = arg('vid', 'C251').toUpperCase(); const pid = arg('pid', 'F001').toUpperCase(); const serial = arg('serial', 'LU_2022_8888');
for (const file of [adapterPath, elfPath]) if (!fs.existsSync(file)) throw new Error(`required file not found: ${file}`);
if (targetOwnerProcesses().length) throw new Error('an existing target owner process was found; refusing to create a second owner');

class SessionClient {
  constructor(session) {
    this.session = session;
    this.child = spawn(process.execPath, [adapterPath], { cwd: workspace, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    session.adapterPid = this.child.pid; session.trace = []; session.pendingSettlements = []; session.forcedKillUsed = false;
    this.buffer = Buffer.alloc(0); this.nextSeq = 1; this.pending = new Map(); this.waiters = []; this.stderr = '';
    this.child.stdout.on('data', chunk => this.onData(chunk)); this.child.stderr.on('data', chunk => { this.stderr += chunk.toString('utf8'); });
    this.child.on('exit', (code, signal) => { session.adapterExit = { code, signal }; for (const pending of this.pending.values()) pending.reject(new Error(`adapter exited code=${code} signal=${signal}`)); this.pending.clear(); });
  }
  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n'); if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString('ascii'); const match = /Content-Length:\s*(\d+)/i.exec(header); if (!match) throw new Error(`invalid DAP header: ${header}`);
      const length = Number(match[1]); const bodyStart = headerEnd + 4; if (this.buffer.length < bodyStart + length) return;
      const message = JSON.parse(this.buffer.subarray(bodyStart, bodyStart + length).toString('utf8')); this.buffer = this.buffer.subarray(bodyStart + length);
      const traceEntry = { index: this.session.trace.length, at: Date.now(), direction: 'adapter->client', message }; this.session.trace.push(traceEntry);
      if (message.type === 'response') { const pending = this.pending.get(message.request_seq); if (pending) { this.pending.delete(message.request_seq); clearTimeout(pending.timer); pending.resolve({ message }); } }
      if (message.type === 'event') { for (let index = 0; index < this.waiters.length; index++) { const waiter = this.waiters[index]; if (waiter.event === message.event && traceEntry.index > waiter.afterIndex) { this.waiters.splice(index, 1); clearTimeout(waiter.timer); waiter.resolve({ message }); break; } } }
    }
  }
  request(command, args = {}, timeoutMs = 15000) {
    const seq = this.nextSeq++; const message = { type: 'request', seq, command, arguments: args }; this.session.trace.push({ index: this.session.trace.length, at: Date.now(), direction: 'client->adapter', message });
    const body = JSON.stringify(message); this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
    const promise = new Promise((resolve, reject) => { const timer = setTimeout(() => { this.pending.delete(seq); reject(new Error(`timeout waiting for ${command}`)); }, timeoutMs); this.pending.set(seq, { seq, command, timer, resolve, reject }); });
    this.session.pendingSettlements.push(promise.catch(error => ({ error: error.message })));
    return promise;
  }
  waitEvent(event, afterIndex, timeoutMs = 15000) {
    const existing = this.session.trace.find(entry => entry.index > afterIndex && entry.message?.type === 'event' && entry.message.event === event); if (existing) return Promise.resolve({ message: existing.message });
    return new Promise((resolve, reject) => { const waiter = { event, afterIndex, resolve, timer: null }; waiter.timer = setTimeout(() => { const index = this.waiters.indexOf(waiter); if (index >= 0) this.waiters.splice(index, 1); reject(new Error(`timeout waiting for event ${event}`)); }, timeoutMs); this.waiters.push(waiter); });
  }
  async stop() {
    const waitForExit = () => this.child.exitCode === null
      ? new Promise(resolve => this.child.once('exit', resolve))
      : Promise.resolve();
    if (this.child.exitCode === null) {
      this.child.stdin.end();
      await Promise.race([waitForExit(), sleep(3000)]);
    }
    if (this.child.exitCode === null) {
      this.session.forcedKillUsed = true;
      this.child.kill();
      await Promise.race([waitForExit(), sleep(3000)]);
    }
    this.session.adapterStderr = this.stderr;
  }
}

async function runSession(label, clearLogsOnStart, terminateWithPending) {
  const session = { label, errors: [] }; const client = new SessionClient(session); let disconnected = false;
  try {
    const init = await client.request('initialize', { clientID: `orbit-dap09-replacement-${label}`, adapterID: 'orbit', pathFormat: 'path', linesStartAt1: true, columnsStartAt1: true }); if (!ok(init)) throw new Error('initialize failed');
    const launch = await client.request('launch', { program: elfPath, device: 'STM32F407VE', deviceName: 'STM32F407VE', interface: 'SWD', speedKHz, probe: 'cmsis-dap', cmsisDapTransport: 'hid', cmsisDapVid: vid, cmsisDapPid: pid, cmsisDapSerial: serial, flashBeforeDebug: false, runToEntryPoint: 'osKernelStart', rtos: 'FreeRTOS', nativeDebugEngineEnabled: true, nativeDebugEngineMode: 'auto', loggingEnabled: true, clearLogsOnStart, rttLogEnabled: false }); if (!ok(launch)) throw new Error(`launch failed: ${JSON.stringify(launch.message)}`);
    const stopped = client.waitEvent('stopped', session.trace.length - 1); const configuration = await client.request('configurationDone'); if (!ok(configuration)) throw new Error('configurationDone failed'); await stopped;
    const after = session.trace.length - 1; const continued = client.waitEvent('continued', after); const cont = await client.request('continue', { threadId: 1 }); if (!ok(cont)) throw new Error('continue failed'); await continued;
    const watch = client.request('watchEvaluate', { expressions: ['g_dap09_lifecycle_round', 'g_dap09_lifecycle_phase', 'uxCurrentNumberOfTasks'] });
    const rtos = client.request('rtosInfo');
    if (terminateWithPending) {
      await sleep(10);
      session.pendingTargetRequestsAtDisconnect = [...client.pending.values()].map(({ seq, command }) => ({ seq, command }));
      session.pendingRequestsDuringTermination = session.pendingTargetRequestsAtDisconnect.length > 0;
    } else {
      const rtosResult = await rtos;
      session.rtosInfoOk = ok(rtosResult) && rtosResult.message.body?.detected === true;
      await watch;
    }
    const disconnect = await client.request('disconnect', { restart: false, terminateDebuggee: false }, 15000); disconnected = ok(disconnect); session.disconnect = { ok: disconnected, response: disconnect.message }; session.disconnectOk = disconnected;
    await Promise.allSettled([watch, rtos]);
    session.targetReadCancellationResponses = session.trace.filter(entry => entry?.message?.type === 'response'
      && entry.message.success === false
      && entry.message.body?.errorCode === 'TargetReadCancelled')
      .map(entry => ({ requestSeq: entry.message.request_seq, errorCode: entry.message.body.errorCode }));
  } catch (error) { session.errors.push(error.stack || error.message || String(error)); }
  finally {
    if (!disconnected && client.child.exitCode === null) { try { const cleanup = await client.request('disconnect', { restart: false, terminateDebuggee: false }, 5000); session.cleanupDisconnect = { ok: ok(cleanup), response: cleanup.message }; } catch (error) { session.cleanupDisconnectError = error.message || String(error); } }
    await client.stop();
    session.terminated = session.adapterExit?.code === 0 && session.forcedKillUsed === false;
    await sleep(500); session.logs = readLogs(workspace); Object.assign(session, ownerSummary(session.logs)); session.processesAfter = targetOwnerProcesses(); session.errors = session.errors || [];
  }
  return session;
}

async function main() {
  const evidence = { schema: 'Orbit DAP-09 session replacement hardware acceptance v1', collectedAt: new Date().toISOString(), authorization: { grantedByUser: true, authorizedOperations: ['reset', 'halt', 'run', 'continue', 'pause', 'target reads'], forbiddenOperations: ['flash', 'erase', 'program', 'verify', 'target memory write', 'breakpoint', 'option bytes', 'second owner'] }, hardwareRequest: { mcu: 'STM32F407VET6', probe: 'cmsis-dap', transport: 'hid', vid, pid, serial, speedKHz, elfPath, flashBeforeDebug: false } };
  try {
    evidence.first = await runSession('first', true, true);
    if (evidence.first.processesAfter.length) throw new Error('first session did not release the owner before replacement');
    evidence.second = await runSession('second', true, false);
  } catch (error) { evidence.errors = [error.stack || error.message || String(error)]; }
  const violations = validateReplacementSummary({ first: evidence.first, second: evidence.second }); evidence.validation = { ok: violations.length === 0, violations }; evidence.errors = [...(evidence.errors || []), ...violations.map(message => `validation: ${message}`)];
  const outputDir = path.join(workspace, 'outputs', 'dap09', 'hardware', new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)); fs.mkdirSync(outputDir, { recursive: true }); fs.writeFileSync(path.join(outputDir, 'replacement-evidence.json'), JSON.stringify(evidence, null, 2));
  for (const [label, session] of Object.entries({ first: evidence.first, second: evidence.second })) { if (session?.logs) for (const [category, content] of Object.entries(session.logs)) fs.writeFileSync(path.join(outputDir, `${label}-${category}.log`), content); }
  console.log(`verify-dap09-session-replacement-hw: evidence written to ${outputDir}`); console.log(JSON.stringify(evidence.validation, null, 2)); if (!evidence.validation.ok) process.exitCode = 1;
}
main();
