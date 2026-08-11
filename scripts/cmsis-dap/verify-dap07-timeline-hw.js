'use strict';

// DAP-07 real-hardware baseline. This is a diagnostic harness only: it uses
// flashBeforeDebug=false and never creates a second target owner.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const {
  calculateActualSampleRate,
  classifyWatchResponse,
  normalizeProbe,
  validateDap07Summary,
} = require('./dap07-evidence-validation');

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const item = process.argv.slice(2).find(value => value.startsWith(prefix));
  return item ? item.slice(prefix.length) : fallback;
}
function intArg(name, fallback, min = 1) {
  const value = Number(arg(name, fallback));
  if (!Number.isInteger(value) || value < min) throw new Error(`--${name} must be an integer >= ${min}`);
  return value;
}
if (!process.argv.includes('--hardware')) {
  console.error('verify-dap07-timeline-hw: refusing to run without --hardware');
  process.exit(2);
}

const workspace = path.resolve(__dirname, '..', '..');
const adapterPath = path.resolve(workspace, arg('adapter', path.join('dist', 'debugadapter.js')));
const projectPath = path.resolve(arg('project', 'D:\\STM32\\project\\vet6_led'));
const elfPath = path.resolve(arg('elf', path.join(projectPath, 'build', 'Debug', 'vet6_led.elf')));
const probe = normalizeProbe(arg('probe', 'cmsis-dap'));
const isJLink = probe === 'jlink';
const durationMs = intArg('duration-ms', 60000, 1000);
const watchIntervalMs = intArg('watch-interval-ms', 100, 20);
const sampleIntervalMs = Number(arg('sample-interval-ms', 0.2));
const sendIntervalMs = Number(arg('send-interval-ms', 16));
const watchCount = intArg('watch-count', 3, 1);
const vid = arg('vid', 'C251').toUpperCase();
const pid = arg('pid', 'F001').toUpperCase();
const serial = arg('serial', 'LU_2022_8888');
const speedKHz = intArg('speed-khz', 1000);
const rttLogEnabled = arg('rtt-log', 'false') === 'true';
const rttControlBlockAddress = arg('rtt-control', '');
const rttPollIntervalMs = intArg('rtt-poll-ms', 500, 10);
const rttReadSize = intArg('rtt-read-size', 64, 1);
for (const file of [adapterPath, elfPath]) if (!fs.existsSync(file)) throw new Error(`required file not found: ${file}`);
if (!Number.isFinite(sampleIntervalMs) || sampleIntervalMs < 0.1) throw new Error('--sample-interval-ms must be >= 0.1');
if (!Number.isFinite(sendIntervalMs) || sendIntervalMs < 1) throw new Error('--send-interval-ms must be >= 1');

const allExpressions = ['uwTick', 'xTickCount', 'aww', 'ass', 'cnt', 'g_ram_data'];
const expressions = allExpressions.slice(0, Math.min(watchCount, allExpressions.length));
const evidence = {
  schema: 'Orbit DAP-07 Timeline hardware baseline v1',
  collectedAt: new Date().toISOString(),
  authorization: { grantedByUser: true, authorizedOperations: ['reset', 'halt', 'run', 'step'], forbiddenOperations: ['flash', 'erase', 'program', 'verify', 'option bytes'] },
  hardware: isJLink
    ? { mcu: 'STM32F407VET6', probe: 'J-Link', transport: 'native DLL helper', speedKHz, elfPath, flashBeforeDebug: false }
    : { mcu: 'STM32F407VET6', probe: 'CMSIS-DAP_LU', transport: 'hid', vid, pid, serial, speedKHz, elfPath, flashBeforeDebug: false },
  request: {
    durationMs, watchIntervalMs, sampleIntervalMs, sendIntervalMs, expressions,
    rttLogEnabled, rttControlBlockAddress, rttPollIntervalMs, rttReadSize,
  },
  trace: [], samples: [], watchRequests: [], controls: [], errors: [],
};

function targetOwnerProcesses() {
  const output = execFileSync('tasklist.exe', ['/FO', 'CSV', '/NH'], { encoding: 'utf8' });
  return output.split(/\r?\n/).filter(line =>
    /orbit-(?:cmsis-dap|jlink)-helper|JLink\.exe|openocd|arm-none-eabi-gdb/i.test(line));
}

evidence.processesBefore = targetOwnerProcesses();
if (evidence.processesBefore.length > 0) {
  throw new Error(`target owner process already exists; refusing to create another owner:\n${evidence.processesBefore.join('\n')}`);
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function ok(result) { return result?.message?.success === true; }
function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return { count: 0, p50: null, p95: null, max: null };
  const at = fraction => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
  return { count: sorted.length, p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] };
}

class DapClient {
  constructor() {
    this.child = spawn(process.execPath, [adapterPath], { cwd: workspace, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    evidence.adapterPid = this.child.pid;
    this.buffer = Buffer.alloc(0); this.nextSeq = 1; this.pending = new Map(); this.waiters = []; this.stderr = '';
    this.child.stdout.on('data', chunk => this.onData(chunk));
    this.child.stderr.on('data', chunk => { this.stderr += chunk.toString('utf8'); });
    this.child.on('exit', (code, signal) => { this.exit = { code, signal }; for (const pending of this.pending.values()) pending.reject(new Error(`adapter exited code=${code}`)); this.pending.clear(); });
  }
  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const end = this.buffer.indexOf('\r\n\r\n'); if (end < 0) return;
      const header = this.buffer.subarray(0, end).toString('ascii'); const match = /Content-Length:\s*(\d+)/i.exec(header); if (!match) throw new Error(`invalid DAP header: ${header}`);
      const length = Number(match[1]); if (this.buffer.length < end + 4 + length) return;
      const message = JSON.parse(this.buffer.subarray(end + 4, end + 4 + length).toString('utf8')); this.buffer = this.buffer.subarray(end + 4 + length);
      const item = { index: evidence.trace.length, at: Date.now(), direction: 'adapter->client', message }; evidence.trace.push(item);
      if (message.type === 'response') { const pending = this.pending.get(message.request_seq); if (pending) { this.pending.delete(message.request_seq); clearTimeout(pending.timer); pending.resolve({ message, elapsedMs: Date.now() - pending.startedAt }); } }
      if (message.type === 'event') {
        if (message.event === 'ozoneDataSamples') evidence.samples.push({ at: Date.now(), body: message.body || {} });
        for (let i = 0; i < this.waiters.length; i++) { const waiter = this.waiters[i]; if (waiter.event === message.event) { this.waiters.splice(i, 1); clearTimeout(waiter.timer); waiter.resolve(message); break; } }
      }
    }
  }
  request(command, args = {}, timeoutMs = 15000) {
    const seq = this.nextSeq++; const body = JSON.stringify({ type: 'request', seq, command, arguments: args });
    evidence.trace.push({ index: evidence.trace.length, at: Date.now(), direction: 'client->adapter', message: { type: 'request', seq, command, arguments: args } });
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    return new Promise((resolve, reject) => { const timer = setTimeout(() => { this.pending.delete(seq); reject(new Error(`timeout waiting for ${command}`)); }, timeoutMs); this.pending.set(seq, { timer, startedAt: Date.now(), resolve, reject }); });
  }
  waitEvent(event, timeoutMs = 15000) { return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs); this.waiters.push({ event, timer, resolve, reject }); }); }
  async stop() { if (this.child.exitCode === null) { this.child.stdin.end(); await Promise.race([new Promise(resolve => this.child.once('exit', resolve)), sleep(3000)]); } if (this.child.exitCode === null) this.child.kill(); evidence.adapterStderr = this.stderr; }
}

async function main() {
  const client = new DapClient(); let disconnected = false; let samplingStartedAt = 0; let watchLoop = null;
  try {
    const init = await client.request('initialize', { clientID: 'orbit-dap07-baseline', adapterID: 'orbit', pathFormat: 'path', linesStartAt1: true, columnsStartAt1: true });
    if (!ok(init)) throw new Error(`initialize failed: ${JSON.stringify(init.message)}`);
    const launchArgs = {
      program: elfPath, device: 'STM32F407VE', deviceName: 'STM32F407VE', interface: 'SWD', speedKHz, probe,
      flashBeforeDebug: false, nativeDebugEngineEnabled: true, nativeDebugEngineMode: isJLink ? 'native' : 'auto',
      loggingEnabled: true, clearLogsOnStart: true, rttLogEnabled,
      rttPollIntervalMs, rttReadSize,
    };
    if (rttControlBlockAddress) launchArgs.rttControlBlockAddress = Number(rttControlBlockAddress);
    if (!isJLink) Object.assign(launchArgs, { cmsisDapTransport: 'hid', cmsisDapVid: vid, cmsisDapPid: pid, cmsisDapSerial: serial });
    const launch = await client.request('launch', launchArgs, 30000);
    if (!ok(launch)) throw new Error(`launch failed: ${launch.message?.message || JSON.stringify(launch.message)}`);
    const config = await client.request('configurationDone'); await client.waitEvent('stopped', 15000);
    if (!ok(config)) throw new Error(`configurationDone failed: ${JSON.stringify(config.message)}`);
    const setWatches = await client.request('setWatches', { expressions });
    if (!ok(setWatches)) throw new Error(`setWatches failed: ${JSON.stringify(setWatches.message)}`);
    const continued = client.waitEvent('continued'); const run = await client.request('continue', { threadId: 1 }); await continued;
    if (!ok(run)) throw new Error(`continue failed: ${JSON.stringify(run.message)}`);
    const sampling = await client.request('dataSamplingStart', { entries: expressions.slice(0, 3).map((expression, index) => ({ expression, color: ['#4EC9B0', '#569CD6', '#DCDCA4'][index] })), sampleIntervalMs, sendIntervalMs });
    if (!ok(sampling)) throw new Error(`dataSamplingStart failed: ${JSON.stringify(sampling.message)}`);
    samplingStartedAt = Date.now();
    watchLoop = (async () => { const deadline = samplingStartedAt + durationMs; while (Date.now() < deadline) { const startedAt = Date.now(); try { const result = await client.request('watchEvaluate', { expressions }, 10000); const outcome = classifyWatchResponse(result, expressions); evidence.watchRequests.push({ startedAt, completedAt: Date.now(), elapsedMs: result.elapsedMs, ok: outcome.dataOk, ...outcome }); } catch (error) { evidence.watchRequests.push({ startedAt, completedAt: Date.now(), elapsedMs: Date.now() - startedAt, ok: false, dapOk: false, dataOk: false, error: error.message }); } await sleep(Math.max(0, watchIntervalMs - (Date.now() - startedAt))); } })();
    await sleep(durationMs);
    const pauseEvent = client.waitEvent('stopped'); const pause = await client.request('pause', { threadId: 1 }); await pauseEvent; evidence.controls.push({ operation: 'pause', elapsedMs: pause.elapsedMs, ok: ok(pause) });
    await watchLoop;
    const stopSampling = await client.request('dataSamplingStop', {});
    evidence.samplingStop = { ok: ok(stopSampling), elapsedMs: stopSampling.elapsedMs };
    evidence.gateMetrics = stopSampling.message?.body?.targetReadGate || null;
    evidence.performanceMetrics = stopSampling.message?.body?.performanceMetrics || null;
    const disconnect = await client.request('disconnect', { restart: false, terminateDebuggee: false }); disconnected = ok(disconnect); evidence.disconnect = { ok: disconnected, elapsedMs: disconnect.elapsedMs };
  } catch (error) { evidence.errors.push({ message: error.stack || error.message || String(error) }); process.exitCode = 1; }
  finally {
    if (!disconnected && client.child.exitCode === null) { try { evidence.cleanupDisconnect = (await client.request('disconnect', { restart: false, terminateDebuggee: false }, 5000)).message; } catch (error) { evidence.cleanupDisconnectError = error.message || String(error); } }
    await client.stop();
    const sampleTimes = evidence.samples.map(item => item.at); const gaps = sampleTimes.slice(1).map((time, index) => time - sampleTimes[index]);
    const watchLatencies = evidence.watchRequests.filter(item => item.dataOk).map(item => item.elapsedMs);
    const pointCount = evidence.samples.reduce((sum, item) => sum + (Array.isArray(item.body?.snapshots) ? item.body.snapshots.reduce((n, snapshot) => n + (snapshot.data?.length || 0), 0) : 0), 0);
    const timelineExpressions = expressions.slice(0, 3);
    const sampledExpressions = [...new Set(evidence.samples.flatMap(item => Array.isArray(item.body?.snapshots)
      ? item.body.snapshots.filter(snapshot => snapshot.data?.length).map(snapshot => snapshot.expression)
      : []).filter(Boolean))];
    const logs = {};
    for (const category of ['dap', 'dll', 'eval', 'step']) {
      const file = path.join(workspace, 'outputs', 'Log', `${category}.log`);
      logs[category] = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    }
    const combinedLogs = `${logs.dap}\n${logs.dll}`;
    const helperPids = [...combinedLogs.matchAll(isJLink
      ? /\[cpp-jlink process\] spawned pid=(\d+)/g
      : /\[cmsis-dap process\] spawned pid=(\d+)/g)].map(match => Number(match[1]));
    const selectedOwners = isJLink
      ? [...logs.dll.matchAll(/selected mode=([^ ]+) owner=([^ ]+)/g)].map(match => ({ mode: match[1], owner: match[2] }))
      : [...logs.dll.matchAll(/selected probe=([^ ]+) owner=([^ ]+)/g)].map(match => ({ probe: match[1], owner: match[2] }));
    const flashLines = combinedLogs.split(/\r?\n/).filter(line => /Flashing |flash operation=|ProgramPage|EraseSector|Flash Algorithm operation|flash completed/i.test(line));
    const unexpectedOwnerLines = combinedLogs.split(/\r?\n/).filter(line => isJLink
      ? /owner=jlink-legacy|cmsis-dap process|owner=cmsis-dap|JLink\.exe|openocd|arm-none-eabi-gdb/i.test(line)
      : /owner=jlink-|J-Link DLL|JLink\.exe|openocd|arm-none-eabi-gdb/i.test(line));
    const ownerProcessAfter = targetOwnerProcesses();
    const effectiveDurationMs = samplingStartedAt ? Date.now() - samplingStartedAt : 0;
    evidence.summary = {
      durationMs: effectiveDurationMs,
      sampleEvents: evidence.samples.length,
      pointCount,
      actualFlushRateHz: effectiveDurationMs ? evidence.samples.length / (effectiveDurationMs / 1000) : 0,
      actualSampleRateHz: calculateActualSampleRate(pointCount, timelineExpressions.length, effectiveDurationMs),
      sampleEventIntervalMs: stats(gaps),
      watchRequests: evidence.watchRequests.length,
      watchDapSuccessRate: evidence.watchRequests.length ? evidence.watchRequests.filter(item => item.dapOk).length / evidence.watchRequests.length : 0,
      watchDataSuccessRate: evidence.watchRequests.length ? evidence.watchRequests.filter(item => item.dataOk).length / evidence.watchRequests.length : 0,
      watchSuccessRate: evidence.watchRequests.length ? evidence.watchRequests.filter(item => item.dataOk).length / evidence.watchRequests.length : 0,
      watchLatencyMs: stats(watchLatencies),
      gateMetrics: evidence.gateMetrics,
      performanceMetrics: evidence.performanceMetrics,
      sampledExpressions,
      missingTimelineExpressions: timelineExpressions.filter(expression => !sampledExpressions.includes(expression)),
      controls: evidence.controls,
      errors: evidence.errors.length,
      helperPids: [...new Set(helperPids)],
      selectedOwners,
      flashOperationCount: flashLines.length,
      unexpectedOwnerLines,
      ownerProcessAfter,
      disconnectOk: evidence.disconnect?.ok === true,
    };
    const violations = validateDap07Summary(evidence.summary, isJLink ? 'jlink-native' : 'cmsis-dap');
    evidence.summary.validation = { ok: violations.length === 0, violations };
    for (const violation of violations) evidence.errors.push({ message: `validation: ${violation}` });
    evidence.summary.errors = evidence.errors.length;
    if (violations.length > 0) process.exitCode = 1;
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19); const outputDir = path.join(workspace, 'outputs', 'dap07', ...(isJLink ? ['jlink'] : []), `watch-${watchCount}`, stamp); fs.mkdirSync(outputDir, { recursive: true }); fs.writeFileSync(path.join(outputDir, 'evidence.json'), JSON.stringify(evidence, null, 2), 'utf8'); console.log(`verify-dap07-timeline-hw: evidence written to ${outputDir}`); console.log(JSON.stringify(evidence.summary, null, 2));
    for (const [category, content] of Object.entries(logs)) fs.writeFileSync(path.join(outputDir, `${category}.log`), content, 'utf8');
  }
}
main();
