// DAP-06 Watch acceptance through the real Orbit DAP adapter and CMSIS-DAP owner.
// Requires explicit --hardware authorization and always uses flashBeforeDebug=false.

'use strict';

const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function argument(name, fallback) {
  const prefix = `--${name}=`;
  const item = process.argv.slice(2).find(value => value.startsWith(prefix));
  return item ? item.slice(prefix.length) : fallback;
}

function integerArgument(name, fallback, minimum = 1) {
  const value = Number(argument(name, fallback));
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`--${name} must be an integer >= ${minimum}`);
  }
  return value;
}

if (!process.argv.includes('--hardware')) {
  console.error('verify-dap06-watch-hw: refusing to run without --hardware');
  process.exit(2);
}

const workspace = path.resolve(__dirname, '..', '..');
const adapterPath = path.resolve(workspace, argument('adapter', path.join('dist', 'debugadapter.js')));
const projectPath = path.resolve(argument('project', 'D:\\STM32\\project\\vet6_led'));
const elfPath = path.resolve(argument('elf', path.join(projectPath, 'build', 'Debug', 'vet6_led.elf')));
const freertosPath = path.join(projectPath, 'Core', 'Src', 'freertos.c');
const vid = argument('vid', 'C251').toUpperCase();
const pid = argument('pid', 'F001').toUpperCase();
const serial = argument('serial', 'LU_2022_8888');
const speedKHz = integerArgument('speed-khz', 1000);
const durationMs = integerArgument('duration-ms', 60000, 60000);
const sampleIntervalMs = integerArgument('sample-interval-ms', 100, 20);
const localScopeLine = integerArgument('local-line', 277);

for (const file of [adapterPath, elfPath, freertosPath]) {
  if (!fs.existsSync(file)) throw new Error(`required file not found: ${file}`);
}

const watchSpecs = [
  { expression: 'uwTick', symbol: 'uwTick', behavior: 'monotonic-1khz-tick' },
  { expression: 'xTickCount', symbol: 'xTickCount', behavior: 'monotonic-freertos-tick' },
  { expression: 'aww', symbol: 'aww', behavior: 'increments-by-one-every-200ms' },
  { expression: 'ass', symbol: 'ass', behavior: 'sinf(aww)' },
  { expression: 'cnt', symbol: 'cnt', behavior: 'task-loop-counter' },
  { expression: 'g_ram_data', symbol: 'g_ram_data', behavior: 'stable-writable-ram-scalar' },
];
const expressions = watchSpecs.map(item => item.expression);
const expandableExpressions = ['pxReadyTasksLists', 'pxCurrentTCB'];
const writableExpression = 'g_ram_data';

function matchingOwners() {
  const output = execFileSync('tasklist.exe', ['/FO', 'CSV', '/NH'], { encoding: 'utf8' });
  return output.split(/\r?\n/).filter(line =>
    /orbit-(?:cmsis-dap|jlink)-helper|JLink\.exe|openocd|arm-none-eabi-gdb/i.test(line));
}

const existingOwners = matchingOwners();
if (existingOwners.length > 0) {
  throw new Error(`target owner process already exists; refusing to create another owner:\n${existingOwners.join('\n')}`);
}

function parseElfSymbols() {
  const output = execFileSync('arm-none-eabi-nm', ['-S', '--defined-only', elfPath], {
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  });
  const byName = new Map();
  for (const line of output.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]+)\s+([0-9a-fA-F]+)\s+(\S)\s+(.+)$/.exec(line.trim());
    if (!match) continue;
    byName.set(match[4], {
      name: match[4], address: Number.parseInt(match[1], 16) >>> 0,
      size: Number.parseInt(match[2], 16) >>> 0, nmType: match[3], nmLine: line.trim(),
    });
  }
  return byName;
}

function collectDwarfProvenance(symbolNames) {
  const output = execFileSync('arm-none-eabi-readelf', ['--debug-dump=info', elfPath], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  return symbolNames.map(name => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const lines = output.split(/\r?\n/);
    const index = lines.findIndex(line => new RegExp(`DW_AT_name.*(?:\\)|:)\\s*${escaped}$`).test(line));
    return {
      name,
      present: index >= 0,
      excerpt: index >= 0 ? lines.slice(Math.max(0, index - 1), index + 8).map(line => line.trim()) : [],
    };
  });
}

const elfSymbols = parseElfSymbols();
const selectedSymbols = watchSpecs.map(spec => ({ ...spec, ...elfSymbols.get(spec.symbol) }));
const missingSymbols = selectedSymbols.filter(item => !Number.isInteger(item.address));
if (missingSymbols.length > 0) {
  throw new Error(`ELF symbols not found: ${missingSymbols.map(item => item.symbol).join(', ')}`);
}
for (const symbol of selectedSymbols) {
  if (symbol.address < 0x20000000 || symbol.address + symbol.size > 0x20020000) {
    throw new Error(`selected Watch symbol is outside STM32F407 SRAM: ${symbol.symbol}`);
  }
}

const dwarf = collectDwarfProvenance([...new Set([...watchSpecs.map(item => item.symbol), ...expandableExpressions])]);
const missingDwarf = dwarf.filter(item => !item.present);
if (missingDwarf.length > 0) {
  throw new Error(`DWARF variables not found: ${missingDwarf.map(item => item.name).join(', ')}`);
}

const freertosSource = fs.readFileSync(freertosPath, 'utf8');
const sourceAssertions = [
  { line: 142, text: 'uint32_t cnt = 0;' },
  { line: 250, text: 'float aww = 0;' },
  { line: 251, text: 'float ass = 0;' },
  { line: 256, text: 'volatile uint32_t g_ram_data = 0x11111111U;' },
  { line: 294, text: 'aww++;' },
  { line: 295, text: 'ass = sinf(aww);' },
  { line: 296, text: 'osDelay(200);' },
].map(item => ({ ...item, present: freertosSource.split(/\r?\n/)[item.line - 1]?.includes(item.text) || false }));
if (sourceAssertions.some(item => !item.present)) {
  throw new Error('target source no longer matches the Watch behavior oracle');
}

function readAcceptedDap03Reference() {
  const directory = path.join(workspace, 'outputs', 'dap03');
  if (!fs.existsSync(directory)) return null;
  const files = fs.readdirSync(directory)
    .filter(name => /^verify-dap03-hw-.*\.json$/.test(name))
    .map(name => path.join(directory, name))
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      const idStep = data.steps?.find(step => step.name === 'dpRead(0) IDCODE' && step.ok);
      const infoStep = data.steps?.find(step => step.name === 'getInfo' && step.ok);
      const device = data.device || data.steps?.find(step => step.name === 'open' && step.ok)?.data;
      if (data.summary?.idcodeOk && idStep?.data?.value === 0x2BA01477) {
        return {
          evidencePath: file,
          collectedAt: data.collectedAt,
          serial: data.hardwareRequest?.serial,
          dpidr: idStep.data.value >>> 0,
          dpidrHex: `0x${(idStep.data.value >>> 0).toString(16).toUpperCase()}`,
          packetSize: infoStep?.data?.effectivePacketSize,
          packetCount: infoStep?.data?.packetCount,
          packetSizeSource: infoStep?.data?.packetSizeSource,
          device,
        };
      }
    } catch { }
  }
  return null;
}

const dap03Reference = readAcceptedDap03Reference();

const evidence = {
  schema: 'Orbit DAP-06 Watch hardware verification v1',
  collectedAt: new Date().toISOString(),
  authorization: {
    grantedByUser: true,
    authorizedOperations: ['reset', 'halt', 'run', 'step', 'breakpoint', 'single RAM scalar write and restore'],
    forbiddenOperations: ['flash', 'erase', 'program', 'verify', 'option bytes'],
  },
  hardware: {
    mcu: 'STM32F407VET6', probe: 'CMSIS-DAP_LU', transport: 'hid',
    vid, pid, serial, speedKHz, elfPath, flashBeforeDebug: false,
    dpidrReference: dap03Reference,
  },
  request: { durationMs, sampleIntervalMs, localScopeLine, expressions, expandableExpressions },
  offlineOracle: { selectedSymbols, dwarf, sourceAssertions },
  processesBefore: existingOwners,
  trace: [],
  checks: [],
  stoppedState: {},
  samples: [],
  controls: [],
  writeVerification: {},
  errors: [],
  summary: {},
};

let failures = 0;
function check(name, ok, details = {}) {
  const item = { name, ok: !!ok, ...details };
  evidence.checks.push(item);
  if (!item.ok) failures += 1;
  console.log(`${item.ok ? 'ok  ' : 'FAIL'} ${name}`);
  return item;
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function parseNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const direct = Number(trimmed);
  if (Number.isFinite(direct)) return direct;
  const hex = /0x([0-9a-fA-F]+)/.exec(trimmed);
  if (hex) return Number.parseInt(hex[1], 16) >>> 0;
  const decimal = /\((-?\d+(?:\.\d+)?)\)/.exec(trimmed);
  return decimal ? Number(decimal[1]) : null;
}

function responseOk(result) { return !!result?.message?.success; }

function stats(values) {
  if (values.length === 0) return { count: 0, min: null, max: null, avg: null, p50: null, p95: null };
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = fraction => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
  return {
    count: values.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2)),
    p50: percentile(0.5),
    p95: percentile(0.95),
  };
}

function classifyError(error) {
  const text = String(error || 'UnknownError');
  const known = [
    'DapAckFault', 'DapAckWait', 'DapNoAck', 'DeviceRemoved', 'HelperExited',
    'MalformedResponse', 'InvalidWatchWriteAddress', 'InvalidState', 'TargetBusy',
    'SymbolNotFound', 'TargetDisconnected', 'EvaluateCancelled',
  ];
  return known.find(code => text.includes(code)) || text.split(/[:\s]/)[0] || 'UnknownError';
}

class DapClient {
  constructor() {
    this.child = spawn(process.execPath, [adapterPath], {
      cwd: workspace, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    evidence.adapterPid = this.child.pid;
    this.nextSeq = 1;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.eventWaiters = [];
    this.stderr = '';
    this.child.stdout.on('data', chunk => this.onData(chunk));
    this.child.stderr.on('data', chunk => { this.stderr += chunk.toString('utf8'); });
    this.child.once('exit', (code, signal) => {
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
      const entry = { index: evidence.trace.length, at: new Date().toISOString(), direction: 'adapter->client', message };
      evidence.trace.push(entry);
      if (message.type === 'response') {
        const pending = this.pending.get(message.request_seq);
        if (pending) {
          this.pending.delete(message.request_seq);
          pending.resolve({ message, traceIndex: entry.index, elapsedMs: Date.now() - pending.startedAt });
        }
      } else if (message.type === 'event') {
        for (let index = 0; index < this.eventWaiters.length; index++) {
          const waiter = this.eventWaiters[index];
          if (waiter.event === message.event && waiter.afterIndex < entry.index) {
            this.eventWaiters.splice(index, 1);
            clearTimeout(waiter.timer);
            waiter.resolve({ message, traceIndex: entry.index });
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
    evidence.trace.push({ index: traceIndex, at: new Date().toISOString(), direction: 'client->adapter', message });
    const body = JSON.stringify(message);
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error(`timeout waiting for DAP response command=${command} seq=${seq}`));
      }, timeoutMs);
      this.pending.set(seq, {
        startedAt: Date.now(),
        resolve: result => { clearTimeout(timer); resolve({ ...result, requestSeq: seq, requestTraceIndex: traceIndex }); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
    });
  }

  waitEvent(event, afterIndex, timeoutMs = 5000) {
    const existing = evidence.trace.find(entry =>
      entry.index > afterIndex && entry.message.type === 'event' && entry.message.event === event);
    if (existing) return Promise.resolve({ message: existing.message, traceIndex: existing.index });
    return new Promise((resolve, reject) => {
      const waiter = { event, afterIndex, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const index = this.eventWaiters.indexOf(waiter);
        if (index >= 0) this.eventWaiters.splice(index, 1);
        reject(new Error(`timeout waiting for DAP event=${event}`));
      }, timeoutMs);
      this.eventWaiters.push(waiter);
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

function valuesFromDataSample(result) {
  return Array.isArray(result?.message?.body?.results) ? result.message.body.results : [];
}

function numericWatchValue(item) {
  if (!item || item.error) return null;
  return parseNumber(item.value ?? item.display ?? item.hex);
}

async function sampleOnce(client, phase = 'running') {
  const startedAt = Date.now();
  try {
    const result = await client.request('dataSample', { expressions, expandedExpressions: [] }, 10000);
    const values = valuesFromDataSample(result);
    const sample = {
      index: evidence.samples.length,
      phase,
      startedAt,
      completedAt: Date.now(),
      elapsedMs: result.elapsedMs,
      responseSuccess: responseOk(result),
      values,
    };
    evidence.samples.push(sample);
    return sample;
  } catch (error) {
    const sample = {
      index: evidence.samples.length,
      phase,
      startedAt,
      completedAt: Date.now(),
      elapsedMs: Date.now() - startedAt,
      responseSuccess: false,
      requestError: error.message || String(error),
      values: [],
    };
    evidence.samples.push(sample);
    evidence.errors.push({ operation: 'dataSample', phase, error: sample.requestError, errorCode: classifyError(sample.requestError) });
    return sample;
  }
}

async function sampleForDuration(client) {
  const startedAt = Date.now();
  const deadline = startedAt + durationMs;
  while (Date.now() < deadline) {
    const loopStarted = Date.now();
    await sampleOnce(client, 'running-window');
    const remaining = sampleIntervalMs - (Date.now() - loopStarted);
    if (remaining > 0) await sleep(remaining);
  }
  return { startedAt, completedAt: Date.now(), elapsedMs: Date.now() - startedAt };
}

async function controlWhileSampling(client, sampleStartedAt) {
  await sleep(Math.max(0, sampleStartedAt + 15000 - Date.now()));

  const haltStart = evidence.trace.length - 1;
  const haltEventPromise = client.waitEvent('stopped', haltStart, 10000);
  const haltWallStarted = Date.now();
  const haltResponse = await client.request('pause', { threadId: 1 }, 10000);
  const haltEvent = await haltEventPromise;
  evidence.controls.push({ operation: 'halt', elapsedMs: Date.now() - haltWallStarted, responseElapsedMs: haltResponse.elapsedMs, response: haltResponse.message, event: haltEvent.message });

  await sleep(200);
  const stepStart = evidence.trace.length - 1;
  const stepEventPromise = client.waitEvent('stopped', stepStart, 10000);
  const stepWallStarted = Date.now();
  const stepResponse = await client.request('stepIn', { threadId: 1, granularity: 'instruction' }, 10000);
  const stepEvent = await stepEventPromise;
  evidence.controls.push({ operation: 'step', elapsedMs: Date.now() - stepWallStarted, responseElapsedMs: stepResponse.elapsedMs, response: stepResponse.message, event: stepEvent.message });

  await sleep(200);
  const continueStart = evidence.trace.length - 1;
  const continuedPromise = client.waitEvent('continued', continueStart, 10000);
  const continueWallStarted = Date.now();
  const continueResponse = await client.request('continue', { threadId: 1 }, 10000);
  const continuedEvent = await continuedPromise;
  const completedAt = Date.now();
  evidence.controls.push({ operation: 'continue', elapsedMs: completedAt - continueWallStarted, responseElapsedMs: continueResponse.elapsedMs, response: continueResponse.message, event: continuedEvent.message, completedAt });
}

async function collectStoppedState(client) {
  const stack = await client.request('stackTrace', { threadId: 1, startFrame: 0, levels: 20 });
  const frame = stack.message.body?.stackFrames?.[0];
  const scopes = await client.request('scopes', { frameId: frame?.id || 1 });
  const scopeList = scopes.message.body?.scopes || [];
  const localsReference = scopeList.find(scope => scope.name === 'Local')?.variablesReference || 1;
  const registersReference = scopeList.find(scope => scope.name === 'Registers')?.variablesReference || 2;
  const locals = await client.request('variables', { variablesReference: localsReference });
  const registers = await client.request('variables', { variablesReference: registersReference });
  const haltedWatch = await client.request('dataSample', { expressions, expandedExpressions: [] });
  const expandable = {};
  for (const expression of expandableExpressions) {
    const evaluated = await client.request('evaluate', { expression, context: 'watch', frameId: frame?.id || 1 });
    const body = evaluated.message.body || {};
    let children = null;
    const descendants = [];
    if (responseOk(evaluated) && body.variablesReference > 0) {
      children = await client.request('variables', { variablesReference: body.variablesReference });
      let expandableChild = (children.message.body?.variables || [])
        .find(item => item.variablesReference > 0);
      for (let depth = 0; depth < 2 && expandableChild; depth++) {
        const expanded = await client.request('variables', {
          variablesReference: expandableChild.variablesReference,
        });
        descendants.push({ parent: expandableChild, response: expanded.message });
        expandableChild = (expanded.message.body?.variables || [])
          .find(item => item.variablesReference > 0);
      }
    }
    expandable[expression] = {
      response: evaluated.message,
      children: children?.message || null,
      descendants,
    };
  }
  evidence.stoppedState = {
    stack: stack.message,
    frame,
    scopes: scopes.message,
    locals: locals.message,
    registers: registers.message,
    watch: haltedWatch.message,
    expandable,
  };

  const localNames = (locals.message.body?.variables || []).map(item => item.name);
  const localData = (locals.message.body?.variables || []).find(item => item.name === 'local_data');
  const registerNames = (registers.message.body?.variables || []).map(item => item.name);
  check('halted Local is read at a source location where local_data is in scope',
    responseOk(locals) && /freertos\.c$/i.test(frame?.source?.path || '')
      && frame?.line >= 270 && frame?.line <= 278
      && localNames.includes('local_data')
      && parseNumber(localData?.value) === 0x44444444,
    { frame, localNames, localData });
  check('halted Registers are readable', responseOk(registers)
    && ['PC', 'SP', 'LR', 'xPSR'].every(name => registerNames.includes(name)), { registerNames });
  check('halted Watch values are readable', responseOk(haltedWatch)
    && valuesFromDataSample(haltedWatch).length === expressions.length
    && valuesFromDataSample(haltedWatch).every(item => numericWatchValue(item) !== null),
  { results: valuesFromDataSample(haltedWatch) });

  const array = expandable.pxReadyTasksLists;
  const pointer = expandable.pxCurrentTCB;
  const arrayChildren = array.children?.body?.variables || [];
  const nestedStruct = array.descendants?.[0];
  const nestedStructChildren = nestedStruct?.response?.body?.variables || [];
  check('expanded array preserves variablesReference, children, and memoryReference',
    array.response.success && array.response.body?.variablesReference > 0
      && typeof array.response.body?.memoryReference === 'string'
      && arrayChildren.length === 7
      && arrayChildren.every(item => item.variablesReference > 0
        && typeof item.memoryReference === 'string'), array);
  check('expanded nested struct preserves variablesReference, children, and memoryReference',
    nestedStruct?.parent?.variablesReference > 0
      && typeof nestedStruct?.parent?.memoryReference === 'string'
      && nestedStruct?.response?.success === true
      && nestedStructChildren.length > 0
      && nestedStructChildren.some(item => item.variablesReference > 0
        && typeof item.memoryReference === 'string'), nestedStruct);
  check('expanded pointer preserves variablesReference, children, and memoryReference',
    pointer.response.success && pointer.response.body?.variablesReference > 0
      && typeof pointer.response.body?.memoryReference === 'string'
      && (pointer.children?.body?.variables || []).length > 0, pointer);
}

async function verifyWriteAndErrors(client) {
  const before = await client.request('dataSample', { expressions: [writableExpression] });
  const beforeItem = valuesFromDataSample(before)[0];
  const original = numericWatchValue(beforeItem);
  const replacement = original === null ? null : ((original >>> 0) ^ 0x00010000) >>> 0;
  evidence.writeVerification.before = before.message;
  if (original === null || replacement === null) {
    check('writable RAM scalar resolves before write', false, { before: before.message });
    return;
  }

  let writeApplied = false;
  try {
    const write = await client.request('setWatchValue', {
      expression: writableExpression,
      value: replacement,
      address: beforeItem.address,
      typeName: beforeItem.typeName,
    }, 10000);
    evidence.writeVerification.write = write.message;
    writeApplied = !!write.message.body?.ok;
    check('setWatchValue writes the explicit RAM scalar', responseOk(write) && writeApplied, {
      original, replacement, address: beforeItem.address, typeName: beforeItem.typeName, response: write.message,
    });

    const after = await client.request('dataSample', { expressions: [writableExpression] });
    const afterValue = numericWatchValue(valuesFromDataSample(after)[0]);
    evidence.writeVerification.after = after.message;
    check('next Watch read observes the new value without stale cache', responseOk(after) && afterValue === replacement,
      { original, replacement, afterValue, response: after.message });
  } finally {
    if (writeApplied) {
      const restore = await client.request('setWatchValue', {
        expression: writableExpression,
        value: original,
        address: beforeItem.address,
        typeName: beforeItem.typeName,
      }, 10000);
      const restored = await client.request('dataSample', { expressions: [writableExpression] });
      const restoredValue = numericWatchValue(valuesFromDataSample(restored)[0]);
      evidence.writeVerification.restore = restore.message;
      evidence.writeVerification.restoredRead = restored.message;
      check('writable RAM scalar is restored before acceptance exits', responseOk(restore)
        && restore.message.body?.ok && restoredValue === original,
      { original, restoredValue, restore: restore.message, read: restored.message });
    }
  }

  const invalidExpression = await client.request('dataSample', { expressions: ['definitely_missing_watch_symbol'] });
  const invalidItem = valuesFromDataSample(invalidExpression)[0];
  evidence.errors.push({ operation: 'invalidExpression', response: invalidExpression.message, errorCode: classifyError(invalidItem?.error) });
  check('invalid expression returns a structured per-expression error without ending the session',
    responseOk(invalidExpression) && typeof invalidItem?.error === 'string', { response: invalidExpression.message });

  const invalidRead = await client.request('readMemory', { memoryReference: '0x20020000', count: 4 });
  evidence.errors.push({ operation: 'unreadableAddress', response: invalidRead.message, errorCode: invalidRead.message.body?.errorCode });
  check('unreadable address returns structured DapAckFault without fallback',
    !responseOk(invalidRead) && invalidRead.message.body?.errorCode === 'DapAckFault', { response: invalidRead.message });

  const recovery = await client.request('dataSample', { expressions: [writableExpression] });
  check('Watch session remains usable after structured errors', responseOk(recovery)
    && numericWatchValue(valuesFromDataSample(recovery)[0]) === original, { response: recovery.message });
}

function summarizeSamples(window) {
  const samples = evidence.samples;
  const expectedValues = samples.length * expressions.length;
  const completed = samples.filter(sample => sample.responseSuccess);
  const validValues = samples.flatMap(sample => sample.values).filter(item => numericWatchValue(item) !== null);
  const errors = [];
  for (const sample of samples) {
    if (sample.requestError) errors.push(sample.requestError);
    for (const item of sample.values) if (item.error) errors.push(item.error);
  }
  const errorCodes = {};
  for (const error of errors) {
    const code = classifyError(error);
    errorCodes[code] = (errorCodes[code] || 0) + 1;
  }
  const completedTimes = completed.map(sample => sample.completedAt).sort((a, b) => a - b);
  const intervals = completedTimes.slice(1).map((time, index) => time - completedTimes[index]);
  const perExpression = expressions.map(expression => {
    const items = samples.map(sample => sample.values.find(item => item.expression === expression)).filter(Boolean);
    const values = items.map(numericWatchValue).filter(value => value !== null);
    return {
      expression,
      responses: items.length,
      validValues: values.length,
      validRate: items.length > 0 ? values.length / items.length : 0,
      first: values[0] ?? null,
      last: values[values.length - 1] ?? null,
      min: values.length ? Math.min(...values) : null,
      max: values.length ? Math.max(...values) : null,
      distinctValues: new Set(values.map(value => Number(value).toPrecision(12))).size,
    };
  });
  const summary = {
    startedAt: new Date(window.startedAt).toISOString(),
    completedAt: new Date(window.completedAt).toISOString(),
    elapsedMs: window.elapsedMs,
    totalRequests: samples.length,
    completedResponses: completed.length,
    completedResponseRate: samples.length > 0 ? completed.length / samples.length : 0,
    expectedValues,
    validValues: validValues.length,
    validNumericRate: expectedValues > 0 ? validValues.length / expectedValues : 0,
    explicitErrors: errors.length,
    explicitErrorRate: expectedValues > 0 ? errors.length / expectedValues : 0,
    errorCodes,
    actualSampleRateHz: window.elapsedMs > 0 ? Number((completed.length / (window.elapsedMs / 1000)).toFixed(3)) : 0,
    requestLatencyMs: stats(completed.map(sample => sample.elapsedMs)),
    maxSampleIntervalMs: intervals.length ? Math.max(...intervals) : null,
    perExpression,
  };
  evidence.summary.sampling = summary;
  return summary;
}

function verifyKnownChanges(summary) {
  const valuesFor = expression => evidence.samples
    .map(sample => sample.values.find(item => item.expression === expression))
    .map(numericWatchValue)
    .filter(value => value !== null);
  const monotonic = values => values.length > 1 && values.every((value, index) => index === 0 || value >= values[index - 1]);
  const uwTick = valuesFor('uwTick');
  const xTickCount = valuesFor('xTickCount');
  const aww = valuesFor('aww');
  const assPairs = evidence.samples.map(sample => ({
    aww: numericWatchValue(sample.values.find(item => item.expression === 'aww')),
    ass: numericWatchValue(sample.values.find(item => item.expression === 'ass')),
  })).filter(pair => pair.aww !== null && pair.ass !== null);
  const sineMatches = assPairs.filter(pair => {
    const current = Math.abs(pair.ass - Math.sin(pair.aww));
    const previous = Math.abs(pair.ass - Math.sin(pair.aww - 1));
    return Math.min(current, previous) <= 0.08;
  }).length;
  const sineMatchRate = assPairs.length ? sineMatches / assPairs.length : 0;

  check('60 second Watch window completed', summary.elapsedMs >= 60000, { elapsedMs: summary.elapsedMs });
  check('completed response rate is at least 95%', summary.completedResponseRate >= 0.95, summary);
  check('valid numeric rate is at least 95%', summary.validNumericRate >= 0.95, summary);
  check('uwTick follows a monotonic changing counter', monotonic(uwTick) && new Set(uwTick).size > 1,
    { first: uwTick[0], last: uwTick.at(-1), samples: uwTick.length });
  check('xTickCount follows a monotonic changing counter', monotonic(xTickCount) && new Set(xTickCount).size > 1,
    { first: xTickCount[0], last: xTickCount.at(-1), samples: xTickCount.length });
  check('aww follows its known 200 ms increment behavior', monotonic(aww) && new Set(aww).size > 2,
    { first: aww[0], last: aww.at(-1), samples: aww.length });
  check('ass follows sinf(aww)', sineMatchRate >= 0.8, { pairs: assPairs.length, sineMatches, sineMatchRate });
}

function readLog(name) {
  const file = path.join(workspace, 'outputs', 'Log', name);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

async function main() {
  const client = new DapClient();
  let thrown = null;
  let disconnected = false;
  try {
    const initialize = await client.request('initialize', {
      clientID: 'orbit-dap06-watch-hw', adapterID: 'orbit', pathFormat: 'path',
      linesStartAt1: true, columnsStartAt1: true,
    });
    check('initialize', responseOk(initialize), { response: initialize.message });

    const launchStart = evidence.trace.length - 1;
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
      rttLogEnabled: false,
    }, 30000);
    check('launch uses flashBeforeDebug=false', responseOk(launch), { response: launch.message });
    if (!responseOk(launch)) throw new Error(`launch failed: ${launch.message.message}`);

    const configurationDone = await client.request('configurationDone');
    const entryStopped = await client.waitEvent('stopped', launchStart, 10000);
    check('initial entry stop', responseOk(configurationDone) && entryStopped.message.body?.reason === 'entry', {
      response: configurationDone.message, event: entryStopped.message,
    });

    const setWatches = await client.request('setWatches', { expressions });
    check('Watch expressions registered in DAP session', responseOk(setWatches), { response: setWatches.message });

    const breakpoint = await client.request('setBreakpoints', {
      source: { path: freertosPath }, breakpoints: [{ line: localScopeLine }], sourceModified: false,
    });
    const bp = breakpoint.message.body?.breakpoints?.[0];
    check('local-scope breakpoint is verified', responseOk(breakpoint) && bp?.verified, { response: breakpoint.message });

    const restartIndex = evidence.trace.length - 1;
    const restartedEventPromise = client.waitEvent('stopped', restartIndex, 15000);
    const restart = await client.request('restart', {}, 15000);
    const restartedEvent = await restartedEventPromise;
    check('reset returns to the ELF entry without Flash', responseOk(restart)
      && restartedEvent.message.body?.reason === 'entry', { response: restart.message, event: restartedEvent.message });

    const continueIndex = evidence.trace.length - 1;
    const localStoppedPromise = client.waitEvent('stopped', continueIndex, 15000);
    const runToLocal = await client.request('continue', { threadId: 1 }, 10000);
    const localStopped = await localStoppedPromise;
    check('target stops at local-scope breakpoint', responseOk(runToLocal)
      && localStopped.message.body?.reason === 'breakpoint', { response: runToLocal.message, event: localStopped.message });
    await sleep(250);
    await collectStoppedState(client);

    const clearBreakpoint = await client.request('setBreakpoints', {
      source: { path: freertosPath }, breakpoints: [], sourceModified: false,
    });
    check('local-scope breakpoint is cleared', responseOk(clearBreakpoint), { response: clearBreakpoint.message });

    const startRunningIndex = evidence.trace.length - 1;
    const runningEventPromise = client.waitEvent('continued', startRunningIndex, 10000);
    const startRunning = await client.request('continue', { threadId: 1 }, 10000);
    const runningEvent = await runningEventPromise;
    check('target enters running state before realtime sampling', responseOk(startRunning), {
      response: startRunning.message, event: runningEvent.message,
    });

    const sampleStartedAt = Date.now();
    const samplePromise = sampleForDuration(client);
    const controlPromise = controlWhileSampling(client, sampleStartedAt);
    const [window] = await Promise.all([samplePromise, controlPromise]);
    const samplingSummary = summarizeSamples(window);
    verifyKnownChanges(samplingSummary);

    const controlOk = evidence.controls.length === 3
      && evidence.controls.every(control => control.response?.success && control.elapsedMs < 3000);
    check('Watch does not starve Halt, Step, or Continue control requests', controlOk, { controls: evidence.controls });
    const continuedAt = evidence.controls.find(control => control.operation === 'continue')?.completedAt;
    const recoveredSample = evidence.samples.find(sample => continuedAt && sample.completedAt > continuedAt && sample.responseSuccess);
    check('Watch resumes after the control critical section', !!recoveredSample
      && recoveredSample.completedAt - continuedAt < 3000, { continuedAt, recoveredSample });

    const finalPauseIndex = evidence.trace.length - 1;
    const finalStoppedPromise = client.waitEvent('stopped', finalPauseIndex, 10000);
    const finalPause = await client.request('pause', { threadId: 1 }, 10000);
    const finalStopped = await finalStoppedPromise;
    check('target halted for the authorized RAM write', responseOk(finalPause), { response: finalPause.message, event: finalStopped.message });
    await sleep(250);
    await verifyWriteAndErrors(client);

    const disconnect = await client.request('disconnect', { restart: false, terminateDebuggee: false }, 10000);
    disconnected = responseOk(disconnect);
    evidence.disconnect = disconnect.message;
    check('session disconnect succeeds', disconnected, { response: disconnect.message });
  } catch (error) {
    thrown = error;
    evidence.abortError = error.stack || error.message || String(error);
    process.exitCode = 1;
  } finally {
    if (!disconnected && client.child.exitCode === null) {
      try {
        const disconnect = await client.request('disconnect', { restart: false, terminateDebuggee: false }, 5000);
        evidence.cleanupDisconnect = disconnect.message;
      } catch (error) {
        evidence.cleanupDisconnectError = error.message || String(error);
      }
    }
    await client.stop();

    const logs = { dap: readLog('dap.log'), dll: readLog('dll.log'), eval: readLog('eval.log'), step: readLog('step.log') };
    const helperPids = [...logs.dll.matchAll(/\[cmsis-dap process\] spawned pid=(\d+)/g)].map(match => Number(match[1]));
    const ownerKinds = [...logs.dll.matchAll(/selected probe=([^ ]+) owner=([^ ]+)/g)].map(match => ({ probe: match[1], owner: match[2] }));
    const jlinkLines = logs.dll.split(/\r?\n/).filter(line => /owner=jlink-(?:native|legacy)|J-Link DLL|JLink\.exe/.test(line));
    const flashLines = [...logs.dap.split(/\r?\n/), ...logs.dll.split(/\r?\n/)]
      .filter(line => /Flashing |flash operation=|ProgramPage|EraseSector|Flash Algorithm operation/.test(line));
    const flashSkippedLines = logs.dap.split(/\r?\n/).filter(line => /flash skipped reason=flashBeforeDebug=false/.test(line));
    const helperExitLines = logs.dll.split(/\r?\n/).filter(line => /\[cmsis-dap process\] exit code=/.test(line));
    const openedLine = logs.dll.split(/\r?\n/).find(line => /\[cmsis-dap\] opened device/.test(line));
    const processAfter = matchingOwners();
    const postDisconnectResults = evidence.trace.filter(entry => {
      const disconnectResponseIndex = evidence.trace.findIndex(item =>
        item.direction === 'adapter->client' && item.message.type === 'response' && item.message.command === 'disconnect');
      return disconnectResponseIndex >= 0 && entry.index > disconnectResponseIndex
        && entry.direction === 'adapter->client'
        && (entry.message.command === 'dataSample' || entry.message.event === 'ozoneWatchData');
    });
    evidence.summary = {
      ...evidence.summary,
      checks: evidence.checks.length,
      failures,
      helperPids,
      distinctHelperPids: [...new Set(helperPids)],
      ownerKinds,
      ownerKind: ownerKinds.at(-1)?.owner || null,
      secondOwnerCreated: ownerKinds.some(item => item.owner !== 'cmsis-dap'),
      jlinkInvolved: jlinkLines.length > 0,
      jlinkLines,
      helperExitLines,
      helpersExited: helperPids.length > 0 && helperExitLines.length >= new Set(helperPids).size,
      openedDeviceLog: openedLine || null,
      flashSkippedCount: flashSkippedLines.length,
      flashOperationCount: flashLines.length,
      flashLines,
      postDisconnectWatchResults: postDisconnectResults,
      processesAfter: processAfter,
      dpidr: dap03Reference?.dpidr ?? null,
      dpidrSource: dap03Reference?.evidencePath ?? null,
      hardwareErrorCodes: [...new Set(evidence.errors.map(item => item.errorCode).filter(Boolean))],
    };

    check('one CMSIS-DAP helper owns the DAP session', evidence.summary.distinctHelperPids.length === 1
      && evidence.summary.ownerKind === 'cmsis-dap' && !evidence.summary.secondOwnerCreated,
    { helperPids: evidence.summary.distinctHelperPids, ownerKinds });
    check('J-Link, OpenOCD, GDB server, and a second owner are absent',
      !evidence.summary.jlinkInvolved && processAfter.length === 0, { jlinkLines, processAfter });
    check('Flash operation count is zero', evidence.summary.flashOperationCount === 0
      && evidence.summary.flashSkippedCount >= 1,
    { flashOperationCount: evidence.summary.flashOperationCount, flashSkippedCount: evidence.summary.flashSkippedCount, flashLines });
    check('session termination exits helper and publishes no old Watch result',
      evidence.summary.helpersExited && postDisconnectResults.length === 0 && processAfter.length === 0,
    { helperExitLines, postDisconnectResults, processAfter });
    check('accepted DAP-03 evidence records the same probe DPIDR and packet size',
      dap03Reference?.serial === serial && dap03Reference?.dpidr === 0x2BA01477
        && dap03Reference?.packetSize === 64,
    { dap03Reference });

    evidence.summary.checks = evidence.checks.length;
    evidence.summary.failures = failures;
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const outputDir = path.join(workspace, 'outputs', 'dap06', 'watch', stamp);
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'evidence.json'), JSON.stringify(evidence, null, 2), 'utf8');
    for (const [name, content] of Object.entries(logs)) {
      fs.writeFileSync(path.join(outputDir, `${name}.log`), content, 'utf8');
    }
    console.log(`verify-dap06-watch-hw: evidence written to ${outputDir}`);
    console.log(`verify-dap06-watch-hw: checks=${evidence.summary.checks} failures=${failures} requests=${evidence.summary.sampling?.totalRequests || 0} validRate=${evidence.summary.sampling?.validNumericRate ?? 0} helper=${evidence.summary.distinctHelperPids.join(',')} flashOperations=${evidence.summary.flashOperationCount}`);
    if (!thrown && failures > 0) process.exitCode = 1;
  }
}

main();
