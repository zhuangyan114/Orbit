'use strict';

// DAP-09 real-hardware acceptance through the Orbit DAP adapter. The harness
// uses one CMSIS-DAP owner, flashBeforeDebug=false, and no target writes.
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const {
  countDiagnostics,
  percentileStats,
  validateDap09Summary,
} = require('./dap09-evidence-validation');

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

if (!process.argv.includes('--hardware')) {
  console.error('verify-dap09-rtos-hw: refusing to run without --hardware');
  process.exit(2);
}

const workspace = path.resolve(__dirname, '..', '..');
const adapterPath = path.resolve(workspace, arg('adapter', path.join('dist', 'debugadapter.js')));
const projectPath = path.resolve(arg('project', 'D:\\STM32\\project\\vet6_led'));
const elfPath = path.resolve(arg('elf', path.join(projectPath, 'build', 'Debug', 'vet6_led.elf')));
const durationMs = intArg('duration-ms', 60000, 60000);
const watchIntervalMs = intArg('watch-interval-ms', 250, 20);
const rtosIntervalMs = intArg('rtos-interval-ms', 1000, 100);
const sampleIntervalMs = Number(arg('sample-interval-ms', 1));
const sendIntervalMs = Number(arg('send-interval-ms', 16));
const speedKHz = intArg('speed-khz', 1000);
const rttBufferIndex = intArg('rtt-buffer-index', 1, 0);
const rttPollIntervalMs = intArg('rtt-poll-ms', 20, 10);
const rttReadSize = intArg('rtt-read-size', 4096);
const vid = arg('vid', 'C251').toUpperCase();
const pid = arg('pid', 'F001').toUpperCase();
const serial = arg('serial', 'LU_2022_8888');

for (const file of [adapterPath, elfPath]) {
  if (!fs.existsSync(file)) throw new Error(`required file not found: ${file}`);
}
if (!Number.isFinite(sampleIntervalMs) || sampleIntervalMs < 0.1) throw new Error('--sample-interval-ms must be >= 0.1');
if (!Number.isFinite(sendIntervalMs) || sendIntervalMs < 1) throw new Error('--send-interval-ms must be >= 1');

const taskFixtures = [
  { expectedName: 'defaultTask', tcbAddress: 0x20000740 },
  { expectedName: 'myTask02', tcbAddress: 0x200009B8 },
  { expectedName: 'rttBench', tcbAddress: 0x20000E30 },
  { expectedName: 'IDLE', tcbAddress: 0x20003E58 },
];
const tcbOffsets = {
  stackTop: 0,
  stateListContainer: 20,
  priority: 44,
  stackBase: 48,
  taskName: 52,
  stackEnd: 68,
  tcbNumber: 72,
  runtimeCounter: 88,
};
const listAddresses = {
  readyStart: 0x200000E8,
  readyEnd: 0x20000174,
  delayed1: 0x20000174,
  delayed2: 0x20000188,
  pendingReady: 0x200001A4,
  waitingTermination: 0x200001B8,
  suspended: 0x200001D0,
};
const pxCurrentTcbSymbolAddress = 0x200000E4;
const watchExpressions = [
  'uwTick',
  'xTickCount',
  'aww',
  'ass',
  'cnt',
  'g_ram_data',
  'uxCurrentNumberOfTasks',
  'ulTotalRunTime',
];
const timelineExpressions = ['uwTick', 'xTickCount', 'aww'];

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function responseOk(result) { return result?.message?.success === true; }
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
  return output.split(/\r?\n/).filter(line =>
    /orbit-(?:cmsis-dap|jlink)-helper|JLink\.exe|openocd|arm-none-eabi-gdb/i.test(line));
}
function readLogs() {
  const logs = {};
  for (const category of ['dap', 'dll', 'eval', 'step']) {
    const file = path.join(workspace, 'outputs', 'Log', `${category}.log`);
    logs[category] = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  }
  return logs;
}
function rttReadEntries(text) {
  const pattern = new RegExp(`readRtt buffer=${rttBufferIndex} requested=(\\d+) read=(\\d+) committedRdOff=(\\d+) wrapped=(true|false) overrun=(true|false)`, 'g');
  return [...text.matchAll(pattern)].map(match => ({
    requested: Number(match[1]),
    read: Number(match[2]),
    committedRdOff: Number(match[3]),
    wrapped: match[4] === 'true',
    overrun: match[5] === 'true',
  }));
}
function classifyTaskState(tcbAddress, currentTcb, container) {
  if (tcbAddress === currentTcb) return 'Running';
  if (container >= listAddresses.readyStart && container < listAddresses.readyEnd) return 'Ready';
  if (container === listAddresses.delayed1 || container === listAddresses.delayed2) return 'Blocked';
  if (container === listAddresses.pendingReady) return 'PendingReady';
  if (container === listAddresses.waitingTermination) return 'Deleted';
  if (container === listAddresses.suspended) return 'Suspended';
  return `Unknown(${hex(container)})`;
}

const existingOwners = targetOwnerProcesses();
if (existingOwners.length > 0) {
  throw new Error(`target owner process already exists; refusing to create another owner:\n${existingOwners.join('\n')}`);
}

const evidence = {
  schema: 'Orbit DAP-09 RTOS View hardware acceptance v1',
  collectedAt: new Date().toISOString(),
  authorization: {
    grantedByUser: true,
    authorizedOperations: ['reset', 'halt', 'run', 'continue', 'pause', 'step', 'target reads'],
    forbiddenOperations: ['flash', 'erase', 'program', 'verify', 'target memory write', 'breakpoint', 'option bytes'],
  },
  hardwareRequest: {
    mcu: 'STM32F407VET6', probe: 'cmsis-dap', transport: 'hid', vid, pid, serial, speedKHz,
    elfPath, flashBeforeDebug: false, rttBufferIndex,
  },
  workloadRequest: {
    durationMs, watchIntervalMs, rtosIntervalMs, sampleIntervalMs, sendIntervalMs,
    watchExpressions, timelineExpressions,
  },
  trace: [],
  samples: [],
  watchRequests: [],
  rtosRefreshes: [],
  rawControls: [],
  diagnosticResponses: [],
  errors: [],
};

class DapClient {
  constructor() {
    this.child = spawn(process.execPath, [adapterPath], {
      cwd: workspace, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
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
      for (const pending of this.pending.values()) pending.reject(new Error(`adapter exited code=${code} signal=${signal}`));
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
      const traceMessage = message.type === 'event' && message.event === 'ozoneDataSamples'
        ? {
          ...message,
          body: {
            snapshots: (message.body?.snapshots || []).map(snapshot => ({
              expression: snapshot.expression,
              pointCount: Array.isArray(snapshot.data) ? snapshot.data.length : 0,
            })),
          },
        }
        : message;
      const traceEntry = { index: evidence.trace.length, at: Date.now(), direction: 'adapter->client', message: traceMessage };
      evidence.trace.push(traceEntry);
      if (message.type === 'response') {
        const pending = this.pending.get(message.request_seq);
        if (pending) {
          this.pending.delete(message.request_seq);
          clearTimeout(pending.timer);
          pending.resolve({ message, traceIndex: traceEntry.index, elapsedMs: Date.now() - pending.startedAt });
        }
      } else if (message.type === 'event') {
        if (message.event === 'ozoneDataSamples') {
          evidence.samples.push({
            at: Date.now(),
            snapshots: (message.body?.snapshots || []).map(snapshot => ({
              expression: snapshot.expression,
              pointCount: Array.isArray(snapshot.data) ? snapshot.data.length : 0,
            })),
          });
        }
        for (let index = 0; index < this.waiters.length; index++) {
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
    const traceIndex = evidence.trace.length;
    evidence.trace.push({ index: traceIndex, at: Date.now(), direction: 'client->adapter', message });
    const body = JSON.stringify(message);
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error(`timeout waiting for DAP response command=${command} seq=${seq}`));
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
        reject(new Error(`timeout waiting for DAP event=${event}`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  async stop() {
    if (this.child.exitCode === null) {
      this.child.stdin.end();
      await Promise.race([new Promise(resolve => this.child.once('exit', resolve)), sleep(3000)]);
    }
    if (this.child.exitCode === null) this.child.kill();
    evidence.adapterStderr = this.stderr;
  }
}

function recordDiagnostic(source, result) {
  const body = result?.message?.body || {};
  if (!responseOk(result) || body.errorCode) {
    evidence.diagnosticResponses.push({
      at: Date.now(), source, success: result?.message?.success === true,
      errorCode: body.errorCode || result?.message?.message || 'DapRequestFailed',
      diagnostics: body.diagnostics || null,
      message: result?.message?.message || body.message || body.error || null,
    });
  }
}

async function requestWithEvent(client, command, args, event, operation) {
  const startedAt = Date.now();
  const afterIndex = evidence.trace.length - 1;
  const eventPromise = client.waitEvent(event, afterIndex, 15000);
  const result = await client.request(command, args, 15000);
  const receivedEvent = await eventPromise;
  const item = {
    operation, command, ok: responseOk(result), elapsedMs: Date.now() - startedAt,
    responseElapsedMs: result.elapsedMs, event: receivedEvent.message.event,
    eventReason: receivedEvent.message.body?.reason || null,
  };
  evidence.rawControls.push(item);
  recordDiagnostic(operation, result);
  if (!item.ok) throw new Error(`${operation} failed: ${JSON.stringify(result.message)}`);
  return item;
}

async function dapReadMemory(client, address, count) {
  const result = await client.request('readMemory', { memoryReference: hex(address), count }, 15000);
  recordDiagnostic(`readMemory:${hex(address)}`, result);
  if (!responseOk(result) || typeof result.message.body?.data !== 'string') {
    throw new Error(`readMemory ${hex(address)} failed: ${JSON.stringify(result.message)}`);
  }
  const bytes = Buffer.from(result.message.body.data, 'base64');
  if (bytes.length !== count) throw new Error(`readMemory ${hex(address)} returned ${bytes.length}/${count} bytes`);
  return { result, bytes };
}

async function captureStoppedSnapshot(client) {
  const state = await client.request('getTargetState');
  if (!responseOk(state) || state.message.body?.state !== 'halted') throw new Error('snapshot requires a halted target');
  const rtosInfo = await client.request('rtosInfo', {}, 15000);
  recordDiagnostic('snapshot:rtosInfo', rtosInfo);
  const rootEvaluate = await client.request('evaluate', {
    expression: 'pxReadyTasksLists', context: 'hover', frameId: 1,
  }, 15000);
  recordDiagnostic('snapshot:evaluate:pxReadyTasksLists', rootEvaluate);
  const rootReference = rootEvaluate.message.body?.variablesReference || 0;
  const rootVariables = rootReference > 0
    ? await client.request('variables', { variablesReference: rootReference }, 15000)
    : null;
  if (rootVariables) recordDiagnostic('snapshot:variables:pxReadyTasksLists', rootVariables);
  const currentTcbRead = await dapReadMemory(client, pxCurrentTcbSymbolAddress, 4);
  const currentTcb = currentTcbRead.bytes.readUInt32LE(0);
  const countRead = await dapReadMemory(client, 0x200001E4, 4);
  const tickRead = await dapReadMemory(client, 0x200001E8, 4);
  const totalRead = await dapReadMemory(client, 0x20000214, 4);
  const tasks = [];
  for (const task of taskFixtures) {
    const root = `((TCB_t*)0x${task.tcbAddress.toString(16)})`;
    const expressions = {
      runtime: `${root}.ulRunTimeCounter`,
    };
    const tcbRead = await dapReadMemory(client, task.tcbAddress, 100);
    const evaluate = await client.request('evaluate', {
      expression: expressions.runtime, context: 'hover', frameId: 1,
    }, 15000);
    recordDiagnostic(`snapshot:evaluate:${task.expectedName}.ulRunTimeCounter`, evaluate);
    const bytes = tcbRead.bytes;
    const name = decodeCString(bytes.subarray(tcbOffsets.taskName, tcbOffsets.taskName + 16));
    const container = bytes.readUInt32LE(tcbOffsets.stateListContainer);
    const priority = bytes.readUInt32LE(tcbOffsets.priority);
    const stackBase = bytes.readUInt32LE(tcbOffsets.stackBase);
    const stackEnd = bytes.readUInt32LE(tcbOffsets.stackEnd);
    const stackTop = bytes.readUInt32LE(tcbOffsets.stackTop);
    const rawCounter = bytes.readUInt32LE(tcbOffsets.runtimeCounter);
    const tcbNumber = bytes.readUInt32LE(tcbOffsets.tcbNumber);
    const evaluateCounter = parseNumber(evaluate.message.body?.result);
    const stackCapacityBytes = Number.isFinite(stackBase) && Number.isFinite(stackEnd) ? stackEnd - stackBase : null;
    const stackUsedBytes = Number.isFinite(stackTop) && Number.isFinite(stackEnd) ? stackEnd - stackTop : null;
    tasks.push({
      expectedName: task.expectedName, name, tcbAddress: hex(task.tcbAddress),
      state: classifyTaskState(task.tcbAddress, currentTcb, container), stateListContainer: hex(container),
      priority,
      stackBase: hex(stackBase), stackEnd: hex(stackEnd), stackTop: hex(stackTop),
      stackCapacityBytes, stackUsedBytes,
      stackUsedPercent: Number.isFinite(stackCapacityBytes) && stackCapacityBytes > 0 && Number.isFinite(stackUsedBytes)
        ? Number((stackUsedBytes * 100 / stackCapacityBytes).toFixed(1)) : null,
      tcbNumber,
      runtimeCounter: {
        expression: expressions.runtime,
        fieldAddress: hex(task.tcbAddress + tcbOffsets.runtimeCounter),
        dapEvaluate: evaluate.message,
        dapEvaluateValue: evaluateCounter,
        watchEvaluateValue: null,
        directReadMemoryBase64: bytes.subarray(tcbOffsets.runtimeCounter, tcbOffsets.runtimeCounter + 4).toString('base64'),
        directReadMemoryBytes: [...bytes.subarray(tcbOffsets.runtimeCounter, tcbOffsets.runtimeCounter + 4)],
        directReadMemoryResponse: tcbRead.result.message,
        independentUint32Decode: rawCounter,
        crossCheckOk: responseOk(evaluate) && evaluateCounter === rawCounter,
      },
    });
  }
  return {
    targetState: state.message.body.state,
    rtosInfo: rtosInfo.message,
    rootEvaluate: rootEvaluate.message,
    rootVariables: rootVariables?.message || null,
    rootVariablesCount: rootVariables?.message?.body?.variables?.length || 0,
    currentTaskCount: countRead.bytes.readUInt32LE(0),
    currentTcb: hex(currentTcb),
    tickCount: tickRead.bytes.readUInt32LE(0),
    totalRuntime: totalRead.bytes.readUInt32LE(0),
    tasks,
  };
}

async function runWorkload(client) {
  const setWatches = await client.request('setWatches', { expressions: watchExpressions });
  if (!responseOk(setWatches)) throw new Error(`setWatches failed: ${JSON.stringify(setWatches.message)}`);
  await requestWithEvent(client, 'continue', { threadId: 1 }, 'continued', 'workload-initial-continue');
  const sampling = await client.request('dataSamplingStart', {
    entries: timelineExpressions.map((expression, index) => ({
      expression, color: ['#4EC9B0', '#569CD6', '#DCDCA4'][index],
    })),
    sampleIntervalMs,
    sendIntervalMs,
  }, 15000);
  if (!responseOk(sampling)) throw new Error(`dataSamplingStart failed: ${JSON.stringify(sampling.message)}`);
  evidence.samplingStart = sampling.message;
  const startedAt = Date.now();
  const deadline = startedAt + durationMs;

  const watchLoop = (async () => {
    while (Date.now() < deadline) {
      const requestStartedAt = Date.now();
      try {
        const result = await client.request('watchEvaluate', { expressions: watchExpressions }, 15000);
        const items = result.message.body?.results;
        const itemErrors = Array.isArray(items) ? items.filter(item => item?.error) : [];
        const dataOk = responseOk(result) && Array.isArray(items)
          && items.length === watchExpressions.length && itemErrors.length === 0;
        evidence.watchRequests.push({
          startedAt: requestStartedAt, elapsedMs: result.elapsedMs, dapOk: responseOk(result), dataOk,
          resultCount: Array.isArray(items) ? items.length : 0,
          errorCodes: itemErrors.map(item => item.errorCode || item.error),
        });
        recordDiagnostic('workload:watchEvaluate', result);
      } catch (error) {
        evidence.watchRequests.push({ startedAt: requestStartedAt, elapsedMs: Date.now() - requestStartedAt, dapOk: false, dataOk: false, error: error.message });
        evidence.diagnosticResponses.push({ source: 'workload:watchEvaluate', errorCode: 'RequestException', message: error.message });
      }
      await sleep(Math.max(0, watchIntervalMs - (Date.now() - requestStartedAt)));
    }
  })();

  const rtosLoop = (async () => {
    while (Date.now() < deadline) {
      const requestStartedAt = Date.now();
      try {
        const result = await client.request('rtosInfo', {}, 15000);
        evidence.rtosRefreshes.push({
          startedAt: requestStartedAt, elapsedMs: result.elapsedMs, success: responseOk(result),
          detected: result.message.body?.detected === true,
          errorCode: result.message.body?.errorCode || null,
          diagnostics: result.message.body?.diagnostics || null,
        });
        recordDiagnostic('workload:rtosInfo', result);
      } catch (error) {
        evidence.rtosRefreshes.push({ startedAt: requestStartedAt, elapsedMs: Date.now() - requestStartedAt, success: false, errorCode: 'RequestException', error: error.message });
        evidence.diagnosticResponses.push({ source: 'workload:rtosInfo', errorCode: 'RequestException', message: error.message });
      }
      await sleep(Math.max(0, rtosIntervalMs - (Date.now() - requestStartedAt)));
    }
  })();

  const controlLoop = (async () => {
    const waitUntil = async offsetMs => sleep(Math.max(0, startedAt + offsetMs - Date.now()));
    await waitUntil(10000);
    await requestWithEvent(client, 'pause', { threadId: 1 }, 'stopped', 'continue-pause');
    await requestWithEvent(client, 'stepIn', { threadId: 1, granularity: 'instruction' }, 'stopped', 'step');
    await requestWithEvent(client, 'continue', { threadId: 1 }, 'continued', 'continue-pause');
    await waitUntil(20000);
    await requestWithEvent(client, 'restart', {}, 'stopped', 'reset-halt');
    await requestWithEvent(client, 'continue', { threadId: 1 }, 'continued', 'continue-pause');
    await waitUntil(30000);
    await requestWithEvent(client, 'pause', { threadId: 1 }, 'stopped', 'continue-pause');
    await requestWithEvent(client, 'stepIn', { threadId: 1, granularity: 'instruction' }, 'stopped', 'step');
    await requestWithEvent(client, 'continue', { threadId: 1 }, 'continued', 'continue-pause');
    await waitUntil(40000);
    await requestWithEvent(client, 'restart', {}, 'stopped', 'reset-halt');
    await requestWithEvent(client, 'continue', { threadId: 1 }, 'continued', 'continue-pause');
    await waitUntil(50000);
    await requestWithEvent(client, 'pause', { threadId: 1 }, 'stopped', 'continue-pause');
    await requestWithEvent(client, 'stepIn', { threadId: 1, granularity: 'instruction' }, 'stopped', 'step');
    await requestWithEvent(client, 'continue', { threadId: 1 }, 'continued', 'continue-pause');
  })();

  await Promise.all([watchLoop, rtosLoop, controlLoop, sleep(durationMs)]);
  await requestWithEvent(client, 'pause', { threadId: 1 }, 'stopped', 'continue-pause');
  const stopSampling = await client.request('dataSamplingStop', {}, 15000);
  if (!responseOk(stopSampling)) throw new Error(`dataSamplingStop failed: ${JSON.stringify(stopSampling.message)}`);
  evidence.samplingStop = stopSampling.message;
  return { startedAt, endedAt: Date.now(), durationMs: Date.now() - startedAt };
}

async function main() {
  const client = new DapClient();
  let disconnected = false;
  try {
    const initialize = await client.request('initialize', {
      clientID: 'orbit-dap09-acceptance', adapterID: 'orbit', pathFormat: 'path',
      linesStartAt1: true, columnsStartAt1: true,
    });
    if (!responseOk(initialize)) throw new Error(`initialize failed: ${JSON.stringify(initialize.message)}`);
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
      runToEntryPoint: 'osKernelStart',
      rtos: 'FreeRTOS',
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
    const configurationAfter = evidence.trace.length - 1;
    const stopped = client.waitEvent('stopped', configurationAfter, 15000);
    const configuration = await client.request('configurationDone');
    await stopped;
    if (!responseOk(configuration)) throw new Error(`configurationDone failed: ${JSON.stringify(configuration.message)}`);

    await requestWithEvent(client, 'continue', { threadId: 1 }, 'continued', 'fixture-start-continue');
    await sleep(2500);
    await requestWithEvent(client, 'pause', { threadId: 1 }, 'stopped', 'fixture-ready-pause');
    evidence.stoppedSnapshot = await captureStoppedSnapshot(client);
    evidence.workload = await runWorkload(client);

    const disconnect = await client.request('disconnect', { restart: false, terminateDebuggee: false }, 15000);
    disconnected = responseOk(disconnect);
    evidence.disconnect = { ok: disconnected, elapsedMs: disconnect.elapsedMs, response: disconnect.message };
  } catch (error) {
    evidence.errors.push({ message: error.stack || error.message || String(error) });
    process.exitCode = 1;
  } finally {
    if (!disconnected && client.child.exitCode === null) {
      try {
        const cleanup = await client.request('disconnect', { restart: false, terminateDebuggee: false }, 5000);
        evidence.cleanupDisconnect = { ok: responseOk(cleanup), response: cleanup.message };
      } catch (error) {
        evidence.cleanupDisconnectError = error.message || String(error);
      }
    }
    await client.stop();
    await sleep(500);
    const logs = readLogs();
    const combinedLogs = `${logs.dap}\n${logs.dll}`;
    const helperPids = [...new Set([...combinedLogs.matchAll(/\[cmsis-dap process\] spawned pid=(\d+)/g)].map(match => Number(match[1])))];
    const ownerSelections = [...logs.dll.matchAll(/selected probe=([^ ]+) owner=([^ ]+)/g)].map(match => ({ probe: match[1], owner: match[2] }));
    const ownerKinds = [...new Set(ownerSelections.map(item => item.owner))];
    const unexpectedOwnerLines = combinedLogs.split(/\r?\n/).filter(line =>
      /owner=jlink-|J-Link DLL|JLink\.exe|openocd|arm-none-eabi-gdb/i.test(line));
    const flashLines = combinedLogs.split(/\r?\n/).filter(line =>
      /Flashing |flash operation=|ProgramPage|EraseSector|Flash Algorithm operation|flash completed/i.test(line));
    const processesAfter = targetOwnerProcesses();
    const samplePointCount = evidence.samples.reduce((sum, event) =>
      sum + event.snapshots.reduce((points, snapshot) => points + snapshot.pointCount, 0), 0);
    const sampledExpressions = [...new Set(evidence.samples.flatMap(event =>
      event.snapshots.filter(snapshot => snapshot.pointCount > 0).map(snapshot => snapshot.expression)))];
    const successfulWatches = evidence.watchRequests.filter(item => item.dataOk);
    const rttEntries = rttReadEntries(logs.dap);
    const runtimeTasks = evidence.stoppedSnapshot?.tasks || [];
    const rawControlGroups = {
      'continue-pause': evidence.rawControls.filter(item => item.operation === 'continue-pause'),
      step: evidence.rawControls.filter(item => item.operation === 'step'),
      'reset-halt': evidence.rawControls.filter(item => item.operation === 'reset-halt'),
    };
    const controls = Object.entries(rawControlGroups).map(([operation, items]) => ({
      operation,
      attempts: items.length,
      successes: items.filter(item => item.ok).length,
      ok: items.length > 0 && items.every(item => item.ok),
      latencyMs: percentileStats(items.map(item => item.elapsedMs)),
    }));
    const diagnostics = countDiagnostics(evidence.diagnosticResponses);
    const hardwareLinePatterns = /opened device|DPIDR|VTref|inputReportLength|outputReportLength|reportId|packetSize|selected probe=|spawned pid=/i;
    evidence.hardwareTraceSummary = combinedLogs.split(/\r?\n/).filter(line => hardwareLinePatterns.test(line));
    evidence.summary = {
      durationMs: evidence.workload?.durationMs || 0,
      ownerKinds,
      ownerSelections,
      helperPids,
      processesAfter,
      unexpectedOwnerLines,
      flashOperationCount: flashLines.length,
      rtosInfoOk: evidence.stoppedSnapshot?.rtosInfo?.success === true
        && evidence.stoppedSnapshot?.rtosInfo?.body?.detected === true,
      rtosTaskCount: runtimeTasks.length,
      runtimeCounterFields: runtimeTasks.length,
      snapshotCrossChecks: runtimeTasks.filter(task => task.runtimeCounter.crossCheckOk).length,
      taskNamesMatch: runtimeTasks.every(task => task.name === task.expectedName),
      taskStates: runtimeTasks.map(task => ({ name: task.name, state: task.state })),
      rootVariablesCount: evidence.stoppedSnapshot?.rootVariablesCount || 0,
      watchRequests: evidence.watchRequests.length,
      watchDataSuccessRate: evidence.watchRequests.length ? successfulWatches.length / evidence.watchRequests.length : 0,
      watchLatencyMs: percentileStats(successfulWatches.map(item => item.elapsedMs)),
      rtosRefreshes: evidence.rtosRefreshes.length,
      rtosRefreshSuccessRate: evidence.rtosRefreshes.length
        ? evidence.rtosRefreshes.filter(item => item.success && item.detected).length / evidence.rtosRefreshes.length : 0,
      timelineEvents: evidence.samples.length,
      timelinePointCount: samplePointCount,
      sampledExpressions,
      missingTimelineExpressions: timelineExpressions.filter(expression => !sampledExpressions.includes(expression)),
      rttReadCount: rttEntries.length,
      rttNonEmptyReadCount: rttEntries.filter(item => item.read > 0).length,
      rttBytes: rttEntries.reduce((sum, item) => sum + item.read, 0),
      rttOverrunCount: rttEntries.filter(item => item.overrun).length,
      controls,
      diagnostics,
      disconnectOk: evidence.disconnect?.ok === true,
      errors: evidence.errors.length,
    };
    const violations = validateDap09Summary(evidence.summary);
    if (!evidence.summary.taskNamesMatch) violations.push('one or more fixed firmware task names did not match');
    if (evidence.summary.rootVariablesCount <= 0) violations.push('DAP variables expansion produced no RTOS list children');
    if (evidence.summary.missingTimelineExpressions.length) violations.push('Timeline is missing one or more requested expressions');
    if (unexpectedOwnerLines.length) violations.push('unexpected J-Link/OpenOCD/GDB owner activity was detected');
    if (evidence.summary.rttOverrunCount > 0) violations.push('RTT overrun was detected');
    evidence.summary.validation = { ok: violations.length === 0, violations };
    if (violations.length > 0) {
      for (const violation of violations) evidence.errors.push({ message: `validation: ${violation}` });
      process.exitCode = 1;
    }
    evidence.summary.errors = evidence.errors.length;

    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const outputDir = path.join(workspace, 'outputs', 'dap09', 'hardware', stamp);
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'evidence.json'), JSON.stringify(evidence, null, 2), 'utf8');
    for (const [category, content] of Object.entries(logs)) {
      fs.writeFileSync(path.join(outputDir, `${category}.log`), content, 'utf8');
    }
    console.log(`verify-dap09-rtos-hw: evidence written to ${outputDir}`);
    console.log(JSON.stringify(evidence.summary, null, 2));
  }
}

main();
