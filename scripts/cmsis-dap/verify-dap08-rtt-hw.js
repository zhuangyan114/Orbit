'use strict';

// DAP-08 real-hardware acceptance. Requires the RTTB Channel 1 fixture in
// vet6_led and never flashes the target or creates a second target owner.
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

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
  console.error('verify-dap08-rtt-hw: refusing to run without --hardware');
  process.exit(2);
}

const workspace = path.resolve(__dirname, '..', '..');
const adapterPath = path.resolve(workspace, arg('adapter', path.join('dist', 'debugadapter.js')));
const projectPath = path.resolve(arg('project', 'D:\\STM32\\project\\vet6_led'));
const elfPath = path.resolve(arg('elf', path.join(projectPath, 'build', 'Debug', 'vet6_led.elf')));
const durationMs = intArg('duration-ms', 60000, 60000);
const watchIntervalMs = intArg('watch-interval-ms', 100, 20);
const sampleIntervalMs = Number(arg('sample-interval-ms', 1));
const sendIntervalMs = Number(arg('send-interval-ms', 16));
const speedKHz = intArg('speed-khz', 4000);
const rttBufferIndex = intArg('rtt-buffer-index', 1, 0);
const rttPollIntervalMs = intArg('rtt-poll-ms', 20, 10);
const rttReadSize = intArg('rtt-read-size', 4096);
const vid = arg('vid', 'C251').toUpperCase();
const pid = arg('pid', 'F001').toUpperCase();
const serial = arg('serial', 'LU_2022_8888');
const nmExe = arg('nm', 'arm-none-eabi-nm');
for (const file of [adapterPath, elfPath]) {
  if (!fs.existsSync(file)) throw new Error(`required file not found: ${file}`);
}
if (!Number.isFinite(sampleIntervalMs) || sampleIntervalMs < 0.1) throw new Error('--sample-interval-ms must be >= 0.1');
if (!Number.isFinite(sendIntervalMs) || sendIntervalMs < 1) throw new Error('--send-interval-ms must be >= 1');

const counterNames = [
  'rtt_bench_attempted_frames',
  'rtt_bench_written_bytes',
  'rtt_bench_dropped_frames',
  'rtt_bench_channel_index',
  'rtt_bench_buffered_bytes',
  'rtt_bench_available_bytes',
];
const watchExpressions = ['uwTick', 'xTickCount', 'aww', ...counterNames];
const timelineExpressions = ['uwTick', 'xTickCount', 'aww'];

function readSymbols() {
  const output = execFileSync(nmExe, ['-S', '-n', elfPath], { encoding: 'utf8', windowsHide: true });
  const symbols = new Map();
  for (const line of output.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]+)\s+([0-9a-fA-F]+)\s+\S\s+(.+)$/.exec(line.trim());
    if (match) symbols.set(match[3], { address: Number.parseInt(match[1], 16), size: Number.parseInt(match[2], 16) });
  }
  for (const name of ['_SEGGER_RTT', 'rtt_bench_buffer', ...counterNames]) {
    if (!symbols.has(name)) throw new Error(`required ELF symbol not found: ${name}`);
  }
  return symbols;
}

function targetOwnerProcesses() {
  const output = execFileSync('tasklist.exe', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
  return output.split(/\r?\n/).filter(line =>
    /orbit-(?:cmsis-dap|jlink)-helper|JLink\.exe|openocd|arm-none-eabi-gdb/i.test(line));
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function responseOk(result) { return result?.message?.success === true; }
function u32Delta(after, before) { return (after - before) >>> 0; }
function percentileStats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return { count: 0, p50: null, p95: null, max: null };
  const at = fraction => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
  return { count: sorted.length, p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] };
}

function fnv1a(bytes) {
  let hash = 2166136261 >>> 0;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

function parseRttLog(text, bufferIndex) {
  const entries = [];
  const pattern = new RegExp(`readRtt buffer=${bufferIndex} requested=(\\d+) read=(\\d+) committedRdOff=(\\d+) wrapped=(true|false) overrun=(true|false)`, 'g');
  let match;
  while ((match = pattern.exec(text)) !== null) {
    entries.push({
      requested: Number(match[1]),
      read: Number(match[2]),
      committedRdOff: Number(match[3]),
      wrapped: match[4] === 'true',
      overrun: match[5] === 'true',
    });
  }
  return entries;
}

function parseDescriptor(bytes, index) {
  if (bytes.length < 24 + ((index + 1) * 24)) throw new Error('RTT control block snapshot is too short');
  const offset = 24 + (index * 24);
  return {
    magic: bytes.subarray(0, 10).toString('ascii'),
    maxUpBuffers: bytes.readUInt32LE(16),
    maxDownBuffers: bytes.readUInt32LE(20),
    nameAddress: bytes.readUInt32LE(offset),
    bufferAddress: bytes.readUInt32LE(offset + 4),
    size: bytes.readUInt32LE(offset + 8),
    wrOff: bytes.readUInt32LE(offset + 12),
    rdOff: bytes.readUInt32LE(offset + 16),
    flags: bytes.readUInt32LE(offset + 20),
  };
}

function usedBytes(descriptor) {
  return descriptor.wrOff >= descriptor.rdOff
    ? descriptor.wrOff - descriptor.rdOff
    : descriptor.size - descriptor.rdOff + descriptor.wrOff;
}

function parseRingSnapshot(bytes, wrOff, attemptedFrames) {
  const frameSize = 64;
  if (bytes.length % frameSize !== 0 || wrOff % frameSize !== 0) {
    return { valid: false, reason: 'ring or write offset is not frame aligned', frames: [] };
  }
  const slotCount = bytes.length / frameSize;
  const firstSlot = (wrOff / frameSize) % slotCount;
  const frames = [];
  for (let logical = 0; logical < slotCount; logical++) {
    const slot = (firstSlot + logical) % slotCount;
    const frame = bytes.subarray(slot * frameSize, (slot + 1) * frameSize);
    const magicOk = frame.subarray(0, 4).toString('ascii') === 'RTTB';
    const versionOk = frame[4] === 1;
    const sizeOk = frame.readUInt16LE(6) === frameSize;
    const expectedChecksum = frame.readUInt32LE(60);
    const actualChecksum = fnv1a(frame.subarray(0, 60));
    frames.push({
      logical,
      slot,
      sequence: frame.readUInt32LE(8),
      tick: frame.readUInt32LE(12),
      magicOk,
      versionOk,
      sizeOk,
      checksumOk: expectedChecksum === actualChecksum,
    });
  }
  const validFrames = frames.filter(frame => frame.magicOk && frame.versionOk && frame.sizeOk && frame.checksumOk);
  let sequenceGapCount = 0;
  let outOfOrderCount = 0;
  for (let index = 1; index < validFrames.length; index++) {
    const delta = u32Delta(validFrames[index].sequence, validFrames[index - 1].sequence);
    if (delta === 0 || delta > 0x7fffffff) outOfOrderCount++;
    else sequenceGapCount += delta - 1;
  }
  const finalSequence = validFrames.at(-1)?.sequence;
  const tailGap = finalSequence === undefined ? null : u32Delta((attemptedFrames - 1) >>> 0, finalSequence);
  return {
    valid: validFrames.length === slotCount && outOfOrderCount === 0,
    slotCount,
    validFrameCount: validFrames.length,
    firstSequence: validFrames[0]?.sequence ?? null,
    finalSequence: finalSequence ?? null,
    sequenceGapCount,
    outOfOrderCount,
    tailGap,
    frames,
  };
}

const symbols = readSymbols();
const evidence = {
  schema: 'Orbit DAP-08 CMSIS-DAP RTT hardware acceptance v1',
  collectedAt: new Date().toISOString(),
  authorization: {
    grantedByUser: true,
    authorizedOperations: ['RTT RdOff writes', 'halt', 'run', 'instruction step', 'reset', 'DAP disconnect'],
    forbiddenOperations: ['flash', 'erase', 'program', 'verify', 'option bytes'],
  },
  hardware: {
    mcu: 'STM32F407VET6', probe: 'CMSIS-DAP_LU', transport: 'hid', vid, pid, serial,
    speedKHz, elfPath, flashBeforeDebug: false,
  },
  request: { durationMs, watchIntervalMs, sampleIntervalMs, sendIntervalMs, rttBufferIndex, rttPollIntervalMs, rttReadSize },
  symbols: Object.fromEntries([...symbols].filter(([name]) => name === '_SEGGER_RTT' || name === 'rtt_bench_buffer' || counterNames.includes(name))),
  trace: [],
  samples: [],
  watchRequests: [],
  controls: [],
  rttEvents: [],
  errors: [],
};

evidence.processesBefore = targetOwnerProcesses();
if (evidence.processesBefore.length > 0) {
  throw new Error(`target owner process already exists; refusing to create another owner:\n${evidence.processesBefore.join('\n')}`);
}

function traceMessage(message) {
  if (message.type !== 'event' && message.command === 'readMemory' && message.body?.data) {
    return { ...message, body: { ...message.body, data: `<base64:${message.body.data.length}>` } };
  }
  if (message.type === 'event' && message.event === 'ozoneDataSamples') {
    const snapshots = Array.isArray(message.body?.snapshots) ? message.body.snapshots : [];
    return { ...message, body: { snapshotCounts: snapshots.map(item => ({ expression: item.expression, points: item.data?.length || 0 })) } };
  }
  if (message.type === 'event' && message.event === 'ozoneRttOutput') {
    return { ...message, body: { textLength: String(message.body?.text || '').length } };
  }
  return message;
}

class DapClient {
  constructor() {
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
      this.exit = { code, signal };
      for (const pending of this.pending.values()) pending.reject(new Error(`adapter exited code=${code}`));
      this.pending.clear();
    });
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const end = this.buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      const header = this.buffer.subarray(0, end).toString('ascii');
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) throw new Error(`invalid DAP header: ${header}`);
      const length = Number(match[1]);
      if (this.buffer.length < end + 4 + length) return;
      const message = JSON.parse(this.buffer.subarray(end + 4, end + 4 + length).toString('utf8'));
      this.buffer = this.buffer.subarray(end + 4 + length);
      evidence.trace.push({ index: evidence.trace.length, at: Date.now(), direction: 'adapter->client', message: traceMessage(message) });
      if (message.type === 'response') {
        const pending = this.pending.get(message.request_seq);
        if (pending) {
          this.pending.delete(message.request_seq);
          clearTimeout(pending.timer);
          pending.resolve({ message, elapsedMs: Date.now() - pending.startedAt });
        }
      }
      if (message.type === 'event') {
        if (message.event === 'ozoneDataSamples') {
          const snapshots = Array.isArray(message.body?.snapshots) ? message.body.snapshots : [];
          evidence.samples.push({
            at: Date.now(),
            snapshots: snapshots.map(item => ({ expression: item.expression, points: item.data?.length || 0 })),
          });
        }
        if (message.event === 'ozoneRttOutput') {
          evidence.rttEvents.push({ at: Date.now(), textLength: String(message.body?.text || '').length });
        }
        for (let index = 0; index < this.waiters.length; index++) {
          const waiter = this.waiters[index];
          if (waiter.event !== message.event) continue;
          this.waiters.splice(index, 1);
          clearTimeout(waiter.timer);
          waiter.resolve(message);
          break;
        }
      }
    }
  }

  request(command, args = {}, timeoutMs = 15000) {
    const seq = this.nextSeq++;
    const request = { type: 'request', seq, command, arguments: args };
    const body = JSON.stringify(request);
    evidence.trace.push({ index: evidence.trace.length, at: Date.now(), direction: 'client->adapter', message: request });
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error(`timeout waiting for ${command}`));
      }, timeoutMs);
      this.pending.set(seq, { timer, startedAt: Date.now(), resolve, reject });
    });
  }

  waitEvent(event, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
      this.waiters.push({ event, timer, resolve, reject });
    });
  }

  async stop() {
    if (this.child.exitCode === null) {
      this.child.stdin.end();
      await Promise.race([new Promise(resolve => this.child.once('exit', resolve)), sleep(3000)]);
    }
    if (this.child.exitCode === null) this.child.kill();
    evidence.adapterStderr = this.stderr;
    evidence.adapterExit = this.exit || null;
  }
}

function readLogs() {
  const logs = {};
  for (const category of ['dap', 'dll', 'eval', 'step']) {
    const file = path.join(workspace, 'outputs', 'Log', `${category}.log`);
    logs[category] = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  }
  return logs;
}

async function readMemory(client, address, count) {
  const result = await client.request('readMemory', { memoryReference: `0x${address.toString(16)}`, count }, 15000);
  if (!responseOk(result) || typeof result.message.body?.data !== 'string') {
    throw new Error(`readMemory 0x${address.toString(16)} failed: ${JSON.stringify(result.message)}`);
  }
  const bytes = Buffer.from(result.message.body.data, 'base64');
  if (bytes.length !== count) throw new Error(`readMemory 0x${address.toString(16)} returned ${bytes.length}/${count} bytes`);
  return bytes;
}

async function readCounters(client) {
  const result = await client.request('watchEvaluate', { expressions: counterNames }, 15000);
  if (!responseOk(result) || !Array.isArray(result.message.body?.results)) {
    throw new Error(`counter read failed: ${JSON.stringify(result.message)}`);
  }
  const values = {};
  for (const item of result.message.body.results) values[item.expression] = Number(item.value);
  for (const name of counterNames) if (!Number.isFinite(values[name])) throw new Error(`counter ${name} is unavailable`);
  return values;
}

async function waitForRttReadCount(count, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entries = parseRttLog(readLogs().dap, rttBufferIndex);
    if (entries.length > count) return { count: entries.length, elapsedMs: timeoutMs - (deadline - Date.now()) };
    await sleep(50);
  }
  return { count: parseRttLog(readLogs().dap, rttBufferIndex).length, elapsedMs: timeoutMs, timeout: true };
}

async function runControl(client, operation, command, args, event) {
  const beforeCount = parseRttLog(readLogs().dap, rttBufferIndex).length;
  const startedAt = Date.now();
  const eventPromise = event ? client.waitEvent(event, 15000) : null;
  const result = await client.request(command, args, 15000);
  const receivedEvent = eventPromise ? await eventPromise : null;
  const control = {
    operation,
    command,
    startedAt,
    elapsedMs: result.elapsedMs,
    ok: responseOk(result),
    event: receivedEvent?.event || null,
    eventReason: receivedEvent?.body?.reason || null,
  };
  if (control.ok && operation !== 'disconnect') {
    const recovery = await waitForRttReadCount(beforeCount, 5000);
    control.rttRecoveryMs = recovery.elapsedMs;
    control.rttRecovered = !recovery.timeout;
  }
  evidence.controls.push(control);
  if (!control.ok) throw new Error(`${operation} failed: ${JSON.stringify(result.message)}`);
  return control;
}

async function continueTarget(client, operation = 'continue') {
  return runControl(client, operation, 'continue', { threadId: 1 }, 'continued');
}

async function pauseTarget(client, operation = 'pause') {
  return runControl(client, operation, 'pause', { threadId: 1 }, 'stopped');
}

async function main() {
  const client = new DapClient();
  let disconnected = false;
  let watchLoop;
  let samplingStartedAt = 0;
  let soakEndedAt = 0;
  try {
    const init = await client.request('initialize', {
      clientID: 'orbit-dap08-acceptance', adapterID: 'orbit', pathFormat: 'path', linesStartAt1: true, columnsStartAt1: true,
    });
    if (!responseOk(init)) throw new Error(`initialize failed: ${JSON.stringify(init.message)}`);
    const launch = await client.request('launch', {
      program: elfPath,
      device: 'STM32F407VE',
      deviceName: 'STM32F407VE',
      interface: 'SWD',
      speedKHz,
      probe: 'cmsis-dap',
      cmsisDapTransport: 'hid',
      cmsisDapVid: vid,
      cmsisDapPid: pid,
      cmsisDapSerial: serial,
      flashBeforeDebug: false,
      nativeDebugEngineEnabled: true,
      nativeDebugEngineMode: 'auto',
      loggingEnabled: true,
      clearLogsOnStart: true,
      rttLogEnabled: true,
      rttBufferIndex,
      rttPollIntervalMs,
      rttReadSize,
      rttLogTarget: 'terminal',
      pRtLogEnabled: false,
    }, 30000);
    if (!responseOk(launch)) throw new Error(`launch failed: ${launch.message?.message || JSON.stringify(launch.message)}`);
    const initialStop = client.waitEvent('stopped', 15000);
    const config = await client.request('configurationDone');
    await initialStop;
    if (!responseOk(config)) throw new Error(`configurationDone failed: ${JSON.stringify(config.message)}`);

    const setWatches = await client.request('setWatches', { expressions: watchExpressions });
    if (!responseOk(setWatches)) throw new Error(`setWatches failed: ${JSON.stringify(setWatches.message)}`);
    await continueTarget(client, 'initial-continue');
    await sleep(2000);
    await pauseTarget(client, 'baseline-pause');
    await sleep(500);

    const controlBlockSize = 24 + ((rttBufferIndex + 1) * 24);
    const controlAddress = symbols.get('_SEGGER_RTT').address;
    const baselineCounters = await readCounters(client);
    const baselineControl = await readMemory(client, controlAddress, controlBlockSize);
    const baselineDescriptor = parseDescriptor(baselineControl, rttBufferIndex);
    const baselineRttEntries = parseRttLog(readLogs().dap, rttBufferIndex);
    evidence.baseline = { counters: baselineCounters, descriptor: baselineDescriptor, rttReadCount: baselineRttEntries.length };
    if (baselineCounters.rtt_bench_channel_index !== rttBufferIndex) {
      throw new Error(`RTTB channel mismatch: target=${baselineCounters.rtt_bench_channel_index} requested=${rttBufferIndex}`);
    }

    await continueTarget(client, 'soak-continue');
    const sampling = await client.request('dataSamplingStart', {
      entries: timelineExpressions.map((expression, index) => ({ expression, color: ['#4EC9B0', '#569CD6', '#DCDCA4'][index] })),
      sampleIntervalMs,
      sendIntervalMs,
    });
    if (!responseOk(sampling)) throw new Error(`dataSamplingStart failed: ${JSON.stringify(sampling.message)}`);
    samplingStartedAt = Date.now();

    watchLoop = (async () => {
      const deadline = samplingStartedAt + durationMs;
      while (Date.now() < deadline) {
        const startedAt = Date.now();
        try {
          const result = await client.request('watchEvaluate', { expressions: watchExpressions }, 10000);
          const items = result.message.body?.results;
          const itemErrors = Array.isArray(items) ? items.filter(item => item.error) : [];
          evidence.watchRequests.push({
            startedAt,
            elapsedMs: result.elapsedMs,
            dapOk: responseOk(result),
            dataOk: responseOk(result) && Array.isArray(items) && items.length === watchExpressions.length && itemErrors.length === 0,
            resultCount: Array.isArray(items) ? items.length : 0,
            itemErrors,
          });
        } catch (error) {
          evidence.watchRequests.push({ startedAt, elapsedMs: Date.now() - startedAt, dapOk: false, dataOk: false, error: error.message });
        }
        await sleep(Math.max(0, watchIntervalMs - (Date.now() - startedAt)));
      }
    })();

    const stepControl = (async () => {
      await sleep(15000);
      await pauseTarget(client, 'soak-pause-before-step');
      const beforeStack = await client.request('stackTrace', { threadId: 1, startFrame: 0, levels: 1 });
      const beforePc = beforeStack.message.body?.stackFrames?.[0]?.instructionPointerReference || null;
      const step = await runControl(client, 'instruction-step', 'stepIn', { threadId: 1, granularity: 'instruction' }, 'stopped');
      const afterStack = await client.request('stackTrace', { threadId: 1, startFrame: 0, levels: 1 });
      step.pcBefore = beforePc;
      step.pcAfter = afterStack.message.body?.stackFrames?.[0]?.instructionPointerReference || null;
      await continueTarget(client, 'continue-after-step');
    })();

    const pauseControl = (async () => {
      await sleep(35000);
      await pauseTarget(client, 'soak-pause');
      await continueTarget(client, 'soak-continue-after-pause');
    })();

    await sleep(durationMs);
    await Promise.all([stepControl, pauseControl, watchLoop]);
    soakEndedAt = Date.now();
    await pauseTarget(client, 'soak-end-pause');
    await sleep(500);
    const stopSampling = await client.request('dataSamplingStop', {});
    evidence.samplingStop = {
      ok: responseOk(stopSampling), elapsedMs: stopSampling.elapsedMs,
      targetReadGate: stopSampling.message.body?.targetReadGate || null,
      performanceMetrics: stopSampling.message.body?.performanceMetrics || null,
    };
    if (!evidence.samplingStop.ok) throw new Error(`dataSamplingStop failed: ${JSON.stringify(stopSampling.message)}`);

    const endCounters = await readCounters(client);
    const endControl = await readMemory(client, controlAddress, controlBlockSize);
    const endDescriptor = parseDescriptor(endControl, rttBufferIndex);
    const ringBytes = await readMemory(client, endDescriptor.bufferAddress, endDescriptor.size);
    const soakLogs = readLogs();
    const allRttEntries = parseRttLog(soakLogs.dap, rttBufferIndex);
    const soakRttEntries = allRttEntries.slice(baselineRttEntries.length);
    const attemptedDelta = u32Delta(endCounters.rtt_bench_attempted_frames, baselineCounters.rtt_bench_attempted_frames);
    const writtenBytesDelta = u32Delta(endCounters.rtt_bench_written_bytes, baselineCounters.rtt_bench_written_bytes);
    const droppedDelta = u32Delta(endCounters.rtt_bench_dropped_frames, baselineCounters.rtt_bench_dropped_frames);
    const hostReadBytes = soakRttEntries.reduce((sum, item) => sum + item.read, 0);
    const baselineUsed = usedBytes(baselineDescriptor);
    const endUsed = usedBytes(endDescriptor);
    const ring = parseRingSnapshot(ringBytes, endDescriptor.wrOff, endCounters.rtt_bench_attempted_frames);
    evidence.soak = {
      startedAt: samplingStartedAt,
      endedAt: soakEndedAt,
      requestedDurationMs: durationMs,
      counters: { baseline: baselineCounters, end: endCounters, attemptedDelta, writtenBytesDelta, writtenFrameDelta: writtenBytesDelta / 64, droppedDelta },
      descriptor: { baseline: baselineDescriptor, end: endDescriptor, baselineUsed, endUsed },
      host: {
        reads: soakRttEntries.length,
        nonEmptyReads: soakRttEntries.filter(item => item.read > 0).length,
        bytes: hostReadBytes,
        wrappedReads: soakRttEntries.filter(item => item.wrapped).length,
        overrunReads: soakRttEntries.filter(item => item.overrun).length,
        conservationResidualBytes: writtenBytesDelta - hostReadBytes - (endUsed - baselineUsed),
      },
      ring,
    };

    await continueTarget(client, 'continue-before-reset');
    const beforeResetEntries = parseRttLog(readLogs().dap, rttBufferIndex).length;
    const restart = await runControl(client, 'reset-restart', 'restart', {}, 'stopped');
    await continueTarget(client, 'continue-after-reset');
    const resetRecovery = await waitForRttReadCount(beforeResetEntries, 10000);
    restart.rttRestartRecovered = !resetRecovery.timeout;
    restart.rttRestartRecoveryMs = resetRecovery.elapsedMs;
    await sleep(2000);

    const disconnect = await client.request('disconnect', { restart: false, terminateDebuggee: false }, 15000);
    disconnected = responseOk(disconnect);
    evidence.disconnect = { ok: disconnected, elapsedMs: disconnect.elapsedMs, at: Date.now() };
    const rttEventsAfterDisconnectResponse = evidence.rttEvents.length;
    await sleep(500);
    evidence.cleanup = {
      rttEventsAfterDisconnect: evidence.rttEvents.length - rttEventsAfterDisconnectResponse,
    };
  } catch (error) {
    evidence.errors.push({ message: error.stack || error.message || String(error) });
    process.exitCode = 1;
  } finally {
    if (!disconnected && client.child.exitCode === null) {
      try {
        const cleanup = await client.request('disconnect', { restart: false, terminateDebuggee: false }, 5000);
        evidence.cleanupDisconnect = { ok: responseOk(cleanup), message: cleanup.message };
      } catch (error) {
        evidence.cleanupDisconnectError = error.message || String(error);
      }
    }
    await client.stop();
    await sleep(300);
    const logs = readLogs();
    const combinedLogs = `${logs.dap}\n${logs.dll}`;
    const helperPids = [...combinedLogs.matchAll(/\[cmsis-dap process\] spawned pid=(\d+)/g)].map(match => Number(match[1]));
    const selectedOwners = [...logs.dll.matchAll(/selected probe=([^ ]+) owner=([^ ]+)/g)].map(match => ({ probe: match[1], owner: match[2] }));
    const unexpectedOwnerLines = combinedLogs.split(/\r?\n/).filter(line => /owner=jlink-|J-Link DLL|JLink\.exe|openocd|arm-none-eabi-gdb/i.test(line));
    const flashLines = combinedLogs.split(/\r?\n/).filter(line => /Flashing |flash operation=|ProgramPage|EraseSector|Flash Algorithm operation|flash completed/i.test(line));
    const sampleTimes = evidence.samples.map(item => item.at);
    const sampleGaps = sampleTimes.slice(1).map((time, index) => time - sampleTimes[index]);
    const samplePoints = evidence.samples.reduce((sum, item) => sum + item.snapshots.reduce((count, snapshot) => count + snapshot.points, 0), 0);
    const sampledExpressions = [...new Set(evidence.samples.flatMap(item => item.snapshots.filter(snapshot => snapshot.points > 0).map(snapshot => snapshot.expression)))];
    const watchSuccesses = evidence.watchRequests.filter(item => item.dataOk);
    const ownerProcessAfter = targetOwnerProcesses();
    const device = /opened device vid=([^ ]+) pid=([^ ]+) product=([^ ]+) serial=([^ ]+) transport=([^ ]+) inputReportLength=(\d+) outputReportLength=(\d+) reportId=(\d+)/.exec(logs.dll);
    const validation = [];
    const check = (condition, message) => { if (!condition) validation.push(message); };
    check(evidence.soak && evidence.soak.endedAt - evidence.soak.startedAt >= durationMs, '60-second soak duration was not reached');
    check(evidence.soak?.host.reads > 0 && evidence.soak?.host.bytes > 0, 'RTT produced no host reads');
    check(evidence.soak?.host.wrappedReads > 0, 'no wrapped RTT read was observed');
    check(evidence.soak?.host.overrunReads === 0, 'RTT reader reported overrun');
    check(evidence.soak?.ring.valid === true, 'RTTB ring snapshot failed frame/order/checksum validation');
    check(evidence.soak?.counters.attemptedDelta === evidence.soak?.counters.writtenFrameDelta + evidence.soak?.counters.droppedDelta, 'producer attempted/written/dropped counters do not balance');
    check(evidence.soak?.host.conservationResidualBytes === 0, 'producer/host/buffer byte conservation failed');
    check(evidence.watchRequests.length > 0 && watchSuccesses.length === evidence.watchRequests.length, 'Watch data success rate is not 100%');
    check(evidence.samples.length > 0 && samplePoints > 0, 'Timeline produced no data');
    check(timelineExpressions.every(expression => sampledExpressions.includes(expression)), 'Timeline is missing one or more expressions');
    for (const operation of ['soak-pause-before-step', 'instruction-step', 'continue-after-step', 'soak-pause', 'soak-continue-after-pause', 'reset-restart', 'continue-after-reset']) {
      check(evidence.controls.some(item => item.operation === operation && item.ok), `${operation} did not succeed`);
    }
    check(evidence.controls.filter(item => item.operation !== 'reset-restart').every(item => item.rttRecovered !== false), 'RTT did not recover after a control operation');
    check(evidence.controls.find(item => item.operation === 'reset-restart')?.rttRestartRecovered === true, 'RTT did not restart after reset');
    check(new Set(helperPids).size === 1, `expected one CMSIS-DAP helper, got ${new Set(helperPids).size}`);
    check(selectedOwners.length > 0 && selectedOwners.every(item => item.probe === 'cmsis-dap' && item.owner === 'cmsis-dap'), 'non-CMSIS-DAP owner was selected');
    check(unexpectedOwnerLines.length === 0, 'unexpected J-Link/OpenOCD/GDB owner activity was detected');
    check(flashLines.length === 0, 'flash activity was detected');
    check(evidence.disconnect?.ok === true, 'DAP disconnect failed');
    check(evidence.cleanup?.rttEventsAfterDisconnect === 0, 'stale RTT output was emitted after disconnect');
    check(ownerProcessAfter.length === 0, 'target owner process remains after disconnect');
    evidence.summary = {
      durationMs: evidence.soak ? evidence.soak.endedAt - evidence.soak.startedAt : 0,
      rtt: evidence.soak?.host || null,
      producer: evidence.soak?.counters || null,
      ring: evidence.soak?.ring ? {
        valid: evidence.soak.ring.valid,
        validFrameCount: evidence.soak.ring.validFrameCount,
        firstSequence: evidence.soak.ring.firstSequence,
        finalSequence: evidence.soak.ring.finalSequence,
        sequenceGapCount: evidence.soak.ring.sequenceGapCount,
        outOfOrderCount: evidence.soak.ring.outOfOrderCount,
        tailGap: evidence.soak.ring.tailGap,
      } : null,
      timeline: {
        events: evidence.samples.length,
        points: samplePoints,
        flushRateHz: evidence.soak ? evidence.samples.length / ((evidence.soak.endedAt - evidence.soak.startedAt) / 1000) : 0,
        sampleRateHzPerExpression: evidence.soak ? samplePoints / timelineExpressions.length / ((evidence.soak.endedAt - evidence.soak.startedAt) / 1000) : 0,
        intervalMs: percentileStats(sampleGaps),
        sampledExpressions,
      },
      watch: {
        requests: evidence.watchRequests.length,
        successRate: evidence.watchRequests.length ? watchSuccesses.length / evidence.watchRequests.length : 0,
        latencyMs: percentileStats(watchSuccesses.map(item => item.elapsedMs)),
      },
      controls: evidence.controls,
      owner: {
        helperPids: [...new Set(helperPids)],
        selectedOwners,
        unexpectedOwnerLines,
        processesBefore: evidence.processesBefore,
        processesAfter: ownerProcessAfter,
      },
      device: device ? {
        vid: device[1], pid: device[2], product: device[3], serial: device[4], transport: device[5],
        inputReportLength: Number(device[6]), outputReportLength: Number(device[7]), reportId: Number(device[8]),
      } : null,
      flashOperationCount: flashLines.length,
      disconnect: evidence.disconnect || null,
      cleanup: evidence.cleanup || null,
      validation: { ok: validation.length === 0, violations: validation },
    };
    for (const violation of validation) evidence.errors.push({ message: `validation: ${violation}` });
    evidence.summary.errors = evidence.errors.length;
    if (validation.length > 0) process.exitCode = 1;

    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const outputDir = path.join(workspace, 'outputs', 'dap08', stamp);
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'evidence.json'), JSON.stringify(evidence, null, 2), 'utf8');
    for (const [category, content] of Object.entries(logs)) fs.writeFileSync(path.join(outputDir, `${category}.log`), content, 'utf8');
    console.log(`verify-dap08-rtt-hw: evidence written to ${outputDir}`);
    console.log(JSON.stringify(evidence.summary, null, 2));
  }
}

main();
