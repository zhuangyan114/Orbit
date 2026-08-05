// DAP-04-HW: hardware acceptance through the real Orbit DAP adapter.
// This script never requests Flash, target memory writes, or breakpoints.
// It requires flashBeforeDebug=false and an explicit --hardware flag.

const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function argument(name, fallback) {
  const prefix = `--${name}=`;
  const item = process.argv.slice(2).find(value => value.startsWith(prefix));
  return item ? item.slice(prefix.length) : fallback;
}

function integerArgument(name, fallback) {
  const value = Number(argument(name, fallback));
  if (!Number.isInteger(value) || value < 0) throw new Error(`--${name} must be a non-negative integer`);
  return value;
}

if (!process.argv.includes('--hardware')) {
  console.error('verify-dap04-hw: refusing to run without --hardware');
  process.exit(2);
}

const workspace = path.resolve(__dirname, '..', '..');
const adapterPath = path.resolve(workspace, argument('adapter', path.join('dist', 'debugadapter.js')));
const elfPath = path.resolve(argument('elf', ''));
const vid = argument('vid', 'C251');
const pid = argument('pid', 'F001');
const serial = argument('serial', 'LU_2022_8888');
const speedKHz = integerArgument('speed-khz', 1000);
const matrix = process.argv.includes('--matrix');
const counts = {
  launches: integerArgument('launches', matrix ? 5 : 1),
  registerReads: integerArgument('register-reads', matrix ? 20 : 1),
  continuePause: integerArgument('continue-pause', matrix ? 20 : 1),
  resetHalt: integerArgument('reset-halt', matrix ? 20 : 1),
  steps: integerArgument('steps', matrix ? 20 : 1),
  stackTraces: integerArgument('stack-traces', matrix ? 20 : 1),
};

if (!fs.existsSync(adapterPath)) throw new Error(`DAP adapter not found: ${adapterPath}`);
if (!elfPath || !fs.existsSync(elfPath)) throw new Error(`ELF not found: ${elfPath}`);

function matchingProcesses() {
  const output = execFileSync('tasklist.exe', ['/FO', 'CSV', '/NH'], { encoding: 'utf8' });
  return output.split(/\r?\n/).filter(line =>
    /orbit-(?:cmsis-dap|jlink)-helper|JLink\.exe|openocd|arm-none-eabi-gdb/i.test(line));
}

const existingOwners = matchingProcesses();
if (existingOwners.length > 0) {
  throw new Error(`target owner process already exists; refusing to create another owner:\n${existingOwners.join('\n')}`);
}

const evidence = {
  schema: 'Orbit DAP-04-HW verification v1',
  collectedAt: new Date().toISOString(),
  hardwareRequest: {
    mcu: 'STM32F407VET6',
    probe: 'cmsis-dap',
    transport: 'hid',
    vid,
    pid,
    serial,
    speedKHz,
    elfPath,
    flashBeforeDebug: false,
    forbiddenOperations: ['flash', 'targetMemoryWrite', 'breakpoint'],
  },
  requestedCounts: counts,
  sessions: [],
  summary: {},
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseNumber(value) {
  if (typeof value === 'number') return value >>> 0;
  if (typeof value !== 'string') return null;
  const parsed = Number.parseInt(value, value.toLowerCase().startsWith('0x') ? 16 : 10);
  return Number.isFinite(parsed) ? parsed >>> 0 : null;
}

function readU32FromDapMemory(response) {
  const bytes = Buffer.from(response.body?.data || '', 'base64');
  return bytes.length >= 4 ? bytes.readUInt32LE(0) : null;
}

function inFlash(address) {
  return Number.isInteger(address) && address >= 0x08000000 && address <= 0x0807FFFF;
}

function isHaltedDhcsr(value) {
  return Number.isInteger(value) && (value & 0x00020000) !== 0;
}

function stats(values) {
  if (values.length === 0) return { count: 0, min: null, max: null, avg: null, p50: null, p95: null };
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = p => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
  return {
    count: values.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2)),
    p50: percentile(0.5),
    p95: percentile(0.95),
  };
}

class DapClient {
  constructor(sessionEvidence) {
    this.sessionEvidence = sessionEvidence;
    this.child = spawn(process.execPath, [adapterPath], {
      cwd: workspace,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.sessionEvidence.adapterPid = this.child.pid;
    this.nextSeq = 1;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.eventWaiters = [];
    this.stderr = '';
    this.child.stdout.on('data', chunk => this.onData(chunk));
    this.child.stderr.on('data', chunk => { this.stderr += chunk.toString('utf8'); });
    this.child.on('exit', (code, signal) => {
      this.sessionEvidence.adapterExit = { code, signal };
      for (const item of this.pending.values()) item.reject(new Error(`adapter exited code=${code} signal=${signal}`));
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
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString('utf8');
      this.buffer = this.buffer.subarray(bodyStart + length);
      const message = JSON.parse(body);
      const traceEntry = { index: this.sessionEvidence.trace.length, at: new Date().toISOString(), direction: 'adapter->client', message };
      this.sessionEvidence.trace.push(traceEntry);
      if (message.type === 'response') {
        const pending = this.pending.get(message.request_seq);
        if (pending) {
          this.pending.delete(message.request_seq);
          pending.resolve({ message, traceIndex: traceEntry.index, elapsedMs: Date.now() - pending.startedAt });
        }
      } else if (message.type === 'event') {
        for (let index = 0; index < this.eventWaiters.length; index++) {
          const waiter = this.eventWaiters[index];
          if (waiter.event === message.event && waiter.afterIndex < traceEntry.index) {
            this.eventWaiters.splice(index, 1);
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
    const traceIndex = this.sessionEvidence.trace.length;
    this.sessionEvidence.trace.push({ index: traceIndex, at: new Date().toISOString(), direction: 'client->adapter', message });
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
    const existing = this.sessionEvidence.trace.find(entry =>
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
      await Promise.race([
        new Promise(resolve => this.child.once('exit', resolve)),
        sleep(3000),
      ]);
    }
    if (this.child.exitCode === null) this.child.kill();
    this.sessionEvidence.adapterStderr = this.stderr;
  }
}

function addCheck(session, name, ok, details = {}) {
  const check = { name, ok: !!ok, ...details };
  session.checks.push(check);
  console.log(`${check.ok ? 'ok  ' : 'FAIL'} session=${session.index} ${name}`);
  if (!check.ok && check.message) console.log(`     ${check.message}`);
  return check;
}

function responseOk(result) {
  return !!result?.message?.success;
}

function findRegister(response, name) {
  const item = response.message.body?.variables?.find(register => register.name === name);
  return item ? parseNumber(item.value) : null;
}

async function snapshot(client, session, label) {
  const state = await client.request('getTargetState');
  const registers = await client.request('variables', { variablesReference: 2 });
  const dhcsrRead = await client.request('readMemory', { memoryReference: '0xE000EDF0', count: 4 });
  const result = {
    label,
    targetState: state.message.body?.state ?? state.message.body,
    pc: findRegister(registers, 'PC'),
    sp: findRegister(registers, 'SP'),
    lr: findRegister(registers, 'LR'),
    xpsr: findRegister(registers, 'xPSR'),
    r0: findRegister(registers, 'R0'),
    dhcsr: responseOk(dhcsrRead) ? readU32FromDapMemory(dhcsrRead.message) : null,
    elapsedMs: {
      state: state.elapsedMs,
      registers: registers.elapsedMs,
      dhcsr: dhcsrRead.elapsedMs,
    },
    responses: {
      state: state.message,
      registers: registers.message,
      dhcsr: dhcsrRead.message,
    },
  };
  session.snapshots.push(result);
  return result;
}

async function runSession(index) {
  const session = { index, trace: [], checks: [], snapshots: [], latencies: {}, eventOrder: [], owner: {} };
  evidence.sessions.push(session);
  const client = new DapClient(session);
  try {
    const initialize = await client.request('initialize', {
      clientID: 'orbit-dap04-hw', adapterID: 'ozone', pathFormat: 'path', linesStartAt1: true, columnsStartAt1: true,
    });
    addCheck(session, 'initialize', responseOk(initialize), { elapsedMs: initialize.elapsedMs, body: initialize.message.body });

    const launchStart = session.trace.length - 1;
    const launch = await client.request('launch', {
      program: elfPath,
      device: 'STM32F407VE',
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
      clearLogsOnStart: index === 1,
      rttLogEnabled: false,
    }, 30000);
    addCheck(session, 'launch flashBeforeDebug=false', responseOk(launch), { elapsedMs: launch.elapsedMs, message: launch.message.message });
    if (!responseOk(launch)) throw new Error(`launch failed: ${launch.message.message}`);

    const configurationDone = await client.request('configurationDone');
    const entryStopped = await client.waitEvent('stopped', launchStart, 5000);
    session.eventOrder.push({ operation: 'configurationDone', responseIndex: configurationDone.traceIndex, eventIndex: entryStopped.traceIndex });
    const configurationOrderingOk = configurationDone.traceIndex < entryStopped.traceIndex;
    addCheck(session, 'initial stopped event', entryStopped.message.body?.reason === 'entry' && configurationOrderingOk, {
      responseBeforeEvent: configurationOrderingOk,
      responseIndex: configurationDone.traceIndex,
      eventIndex: entryStopped.traceIndex,
    });

    const initial = await snapshot(client, session, 'initial');
    addCheck(session, 'initial halted at Flash PC', initial.targetState === 'halted'
      && initial.pc >= 0x08000000 && initial.pc <= 0x0807ffff, initial);

    const threads = await client.request('threads');
    addCheck(session, 'threads', responseOk(threads) && threads.message.body?.threads?.length === 1, { elapsedMs: threads.elapsedMs, body: threads.message.body });

    const stack = await client.request('stackTrace', { threadId: 1, startFrame: 0, levels: 20 });
    const framePc = parseNumber(stack.message.body?.stackFrames?.[0]?.instructionPointerReference);
    addCheck(session, 'stackTrace frame0 matches PC', responseOk(stack) && framePc === initial.pc, {
      elapsedMs: stack.elapsedMs, framePc, pc: initial.pc, body: stack.message.body,
    });

    const flashRead = await client.request('readMemory', { memoryReference: '0x08000000', count: 8 });
    const ramRead = await client.request('readMemory', { memoryReference: '0x20000000', count: 8 });
    addCheck(session, 'Flash read', responseOk(flashRead) && Buffer.from(flashRead.message.body?.data || '', 'base64').length === 8, { elapsedMs: flashRead.elapsedMs, response: flashRead.message });
    addCheck(session, 'RAM read', responseOk(ramRead) && Buffer.from(ramRead.message.body?.data || '', 'base64').length === 8, { elapsedMs: ramRead.elapsedMs, response: ramRead.message });

    const invalidRead = await client.request('readMemory', { memoryReference: '0x20020000', count: 4 });
    const invalidBody = invalidRead.message.body || {};
    addCheck(session, 'invalid memory read returns structured DapAckFault',
      !responseOk(invalidRead)
        && invalidBody.errorCode === 'DapAckFault'
        && typeof invalidBody.targetState === 'string'
        && Number.isFinite(invalidBody.elapsedMs)
        && invalidBody.diagnostics?.operation === 'readMemory'
        && typeof invalidBody.diagnostics?.phase === 'string',
      { elapsedMs: invalidRead.elapsedMs, response: invalidRead.message });
    const afterInvalidRead = await snapshot(client, session, 'after-invalid-memory-read');
    addCheck(session, 'invalid memory failure preserves halted target context',
      afterInvalidRead.targetState === 'halted'
        && inFlash(afterInvalidRead.pc)
        && isHaltedDhcsr(afterInvalidRead.dhcsr),
      afterInvalidRead);
    const recoveryRead = await client.request('readMemory', { memoryReference: '0x08000000', count: 4 });
    addCheck(session, 'memory session recovers after fault', responseOk(recoveryRead), { elapsedMs: recoveryRead.elapsedMs, response: recoveryRead.message });

    if (index === 1) {
      session.latencies.registerReads = [];
      for (let i = 0; i < counts.registerReads; i++) {
        const registers = await client.request('variables', { variablesReference: 2 });
        session.latencies.registerReads.push(registers.elapsedMs);
        const values = ['PC', 'SP', 'LR', 'xPSR', 'R0'].map(name => findRegister(registers, name));
        addCheck(session, `register read ${i + 1}`, responseOk(registers) && values.every(value => value !== null), { elapsedMs: registers.elapsedMs, values });
      }

      session.latencies.continuePause = [];
      for (let i = 0; i < counts.continuePause; i++) {
        const startIndex = session.trace.length - 1;
        const continuedPromise = client.waitEvent('continued', startIndex, 5000);
        const continuedResponse = await client.request('continue', { threadId: 1 });
        const continuedEvent = await continuedPromise;
        await sleep(50);
        const pauseStart = session.trace.length - 1;
        const stoppedPromise = client.waitEvent('stopped', pauseStart, 5000);
        const pauseResponse = await client.request('pause', { threadId: 1 });
        const stoppedEvent = await stoppedPromise;
        const after = await snapshot(client, session, `continue-pause-${i + 1}`);
        const orderingOk = continuedResponse.traceIndex < continuedEvent.traceIndex
          && pauseResponse.traceIndex < stoppedEvent.traceIndex;
        const elapsedMs = continuedResponse.elapsedMs + pauseResponse.elapsedMs;
        session.latencies.continuePause.push(elapsedMs);
        session.eventOrder.push({ operation: `continue-pause-${i + 1}`, continuedResponse: continuedResponse.traceIndex, continuedEvent: continuedEvent.traceIndex, pauseResponse: pauseResponse.traceIndex, stoppedEvent: stoppedEvent.traceIndex });
        addCheck(session, `continue-pause ${i + 1}`, responseOk(continuedResponse) && responseOk(pauseResponse)
          && after.targetState === 'halted' && orderingOk, { elapsedMs, orderingOk, after });
      }

      session.latencies.resetHalt = [];
      for (let i = 0; i < counts.resetHalt; i++) {
        const startIndex = session.trace.length - 1;
        const stoppedPromise = client.waitEvent('stopped', startIndex, 5000);
        const restartResponse = await client.request('restart', {}, 15000);
        const stoppedEvent = await stoppedPromise;
        const after = await snapshot(client, session, `reset-halt-${i + 1}`);
        session.latencies.resetHalt.push(restartResponse.elapsedMs);
        const orderingOk = restartResponse.traceIndex < stoppedEvent.traceIndex;
        session.eventOrder.push({ operation: `reset-halt-${i + 1}`, responseIndex: restartResponse.traceIndex, eventIndex: stoppedEvent.traceIndex });
        addCheck(session, `reset-halt ${i + 1}`, responseOk(restartResponse) && after.targetState === 'halted'
          && after.pc >= 0x08000000 && after.pc <= 0x0807ffff && orderingOk, { elapsedMs: restartResponse.elapsedMs, orderingOk, after });
      }

      session.latencies.steps = [];
      for (let i = 0; i < counts.steps; i++) {
        const before = await snapshot(client, session, `step-${i + 1}-before`);
        const startIndex = session.trace.length - 1;
        const stoppedPromise = client.waitEvent('stopped', startIndex, 5000);
        const stepResponse = await client.request('stepIn', { threadId: 1, granularity: 'instruction' }, 10000);
        const stoppedEvent = await stoppedPromise;
        const after = await snapshot(client, session, `step-${i + 1}-after`);
        session.latencies.steps.push(stepResponse.elapsedMs);
        const orderingOk = stepResponse.traceIndex < stoppedEvent.traceIndex;
        session.eventOrder.push({ operation: `step-${i + 1}`, responseIndex: stepResponse.traceIndex, eventIndex: stoppedEvent.traceIndex });
        addCheck(session, `instruction step ${i + 1}`, responseOk(stepResponse) && after.targetState === 'halted'
          && before.pc !== null && after.pc !== null && before.pc !== after.pc && orderingOk,
        { elapsedMs: stepResponse.elapsedMs, orderingOk, pcBefore: before.pc, pcAfter: after.pc, response: stepResponse.message });
      }

      session.latencies.stackTraces = [];
      for (let i = 0; i < counts.stackTraces; i++) {
        const before = await snapshot(client, session, `stack-${i + 1}`);
        const trace = await client.request('stackTrace', { threadId: 1, startFrame: 0, levels: 20 });
        const currentFramePc = parseNumber(trace.message.body?.stackFrames?.[0]?.instructionPointerReference);
        session.latencies.stackTraces.push(trace.elapsedMs);
        addCheck(session, `stackTrace ${i + 1}`, responseOk(trace) && currentFramePc === before.pc,
          { elapsedMs: trace.elapsedMs, pc: before.pc, framePc: currentFramePc, body: trace.message.body });
      }
    }

    const disconnect = await client.request('disconnect', { restart: false, terminateDebuggee: false }, 10000);
    addCheck(session, 'disconnect', responseOk(disconnect), { elapsedMs: disconnect.elapsedMs, response: disconnect.message });
  } finally {
    await client.stop();
  }
  for (const [name, values] of Object.entries(session.latencies)) session.latencies[name] = stats(values);
}

function readLog(name) {
  const logPath = path.join(workspace, 'outputs', 'Log', name);
  return fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
}

async function main() {
  let thrown = null;
  try {
    for (let index = 1; index <= counts.launches; index++) await runSession(index);
  } catch (error) {
    thrown = error;
    evidence.abortError = error.stack || error.message || String(error);
    process.exitCode = 1;
  } finally {
    const logs = {
      dap: readLog('dap.log'),
      dll: readLog('dll.log'),
      step: readLog('step.log'),
    };
    const helperPids = [...logs.dll.matchAll(/\[cmsis-dap process\] spawned pid=(\d+)/g)].map(match => Number(match[1]));
    const ownerKinds = [...logs.dll.matchAll(/selected probe=([^ ]+) owner=([^ ]+)/g)].map(match => ({ probe: match[1], owner: match[2] }));
    const jlinkLines = logs.dll.split(/\r?\n/).filter(line => /owner=jlink-(?:native|legacy)|J-Link DLL|JLink\.exe/.test(line));
    const flashLines = [...logs.dap.split(/\r?\n/), ...logs.dll.split(/\r?\n/)].filter(line => /Flashing |flash operation=|ProgramPage|EraseSector|Verify/.test(line));
    const flashSkippedLines = logs.dap.split(/\r?\n/).filter(line => /flash skipped reason=flashBeforeDebug=false/.test(line));
    const failedChecks = evidence.sessions.flatMap(session => session.checks.filter(check => !check.ok));
    evidence.summary = {
      sessions: evidence.sessions.length,
      checks: evidence.sessions.reduce((sum, session) => sum + session.checks.length, 0),
      failedChecks: failedChecks.length,
      helperPids,
      distinctHelperPids: [...new Set(helperPids)],
      ownerKinds,
      jlinkInvolved: jlinkLines.length > 0,
      jlinkLines,
      secondOwnerCreated: ownerKinds.some(item => item.owner !== 'cmsis-dap'),
      flashSkippedCount: flashSkippedLines.length,
      flashOperationCount: flashLines.length,
      flashLines,
      processesAfter: matchingProcesses(),
    };

    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const outputDir = path.join(workspace, 'outputs', 'dap04', stamp);
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'evidence.json'), JSON.stringify(evidence, null, 2), 'utf8');
    for (const [name, content] of Object.entries(logs)) fs.writeFileSync(path.join(outputDir, `${name}.log`), content, 'utf8');
    console.log(`verify-dap04-hw: evidence written to ${outputDir}`);
    console.log(`verify-dap04-hw: checks=${evidence.summary.checks} failed=${evidence.summary.failedChecks} helpers=${evidence.summary.distinctHelperPids.join(',')} jlink=${evidence.summary.jlinkInvolved} flashOperations=${evidence.summary.flashOperationCount}`);
    if (!thrown && (failedChecks.length > 0 || evidence.summary.jlinkInvolved || evidence.summary.secondOwnerCreated
      || evidence.summary.flashOperationCount > 0 || evidence.summary.processesAfter.length > 0)) {
      process.exitCode = 1;
    }
  }
}

main();
