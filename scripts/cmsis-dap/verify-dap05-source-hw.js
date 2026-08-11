// DAP-05-HW breakpoint and source-step acceptance through the real DAP adapter.
// Requires explicit --hardware authorization and always launches with
// flashBeforeDebug=false.

'use strict';

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
  if (!Number.isInteger(value) || value < 1) throw new Error(`--${name} must be a positive integer`);
  return value;
}

if (!process.argv.includes('--hardware')) {
  console.error('verify-dap05-source-hw: refusing to run without --hardware');
  process.exit(2);
}

const workspace = path.resolve(__dirname, '..', '..');
const adapterPath = path.resolve(workspace, argument('adapter', path.join('dist', 'debugadapter.js')));
const projectPath = path.resolve(argument('project', 'D:\\STM32\\project\\vet6_led'));
const elfPath = path.resolve(argument('elf', path.join(projectPath, 'build', 'Debug', 'vet6_led.elf')));
const freertosPath = path.join(projectPath, 'Core', 'Src', 'freertos.c');
const gpioPath = path.join(projectPath, 'Drivers', 'STM32F4xx_HAL_Driver', 'Src', 'stm32f4xx_hal_gpio.c');
const cmsisOsPath = path.join(projectPath, 'Middlewares', 'Third_Party', 'FreeRTOS', 'Source', 'CMSIS_RTOS', 'cmsis_os.c');
const vid = argument('vid', 'C251');
const pid = argument('pid', 'F001');
const serial = argument('serial', 'LU_2022_8888');
const speedKHz = integerArgument('speed-khz', 1000);
const rounds = integerArgument('rounds', 20);

for (const file of [adapterPath, elfPath, freertosPath, gpioPath, cmsisOsPath]) {
  if (!fs.existsSync(file)) throw new Error(`required file not found: ${file}`);
}

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
  schema: 'Orbit DAP-05 source-step hardware verification v1',
  collectedAt: new Date().toISOString(),
  hardware: {
    mcu: 'STM32F407VET6', probe: 'CMSIS-DAP_LU', transport: 'hid',
    vid, pid, serial, speedKHz, elfPath, flashBeforeDebug: false,
  },
  requestedRounds: rounds,
  trace: [],
  checks: [],
  samples: {
    breakpointLifecycle: [], currentPcContinue: [], instructionStep: [],
    sourceStepOver: [], sourceStepIntoOut: [], conditionalBranch: [],
  },
};

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function parseNumber(value) {
  if (typeof value === 'number') return value >>> 0;
  if (typeof value !== 'string') return null;
  const parsed = Number.parseInt(value, value.toLowerCase().startsWith('0x') ? 16 : 10);
  return Number.isFinite(parsed) ? parsed >>> 0 : null;
}

function samePath(left, right) {
  return typeof left === 'string' && path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
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
      const entry = { index: evidence.trace.length, at: new Date().toISOString(), direction: 'adapter->client', message };
      evidence.trace.push(entry);
      if (message.type === 'response') {
        const item = this.pending.get(message.request_seq);
        if (item) {
          this.pending.delete(message.request_seq);
          clearTimeout(item.timer);
          item.resolve({ message, traceIndex: entry.index, elapsedMs: Date.now() - item.startedAt });
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

  request(command, args = {}, timeoutMs = 20000) {
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
      this.pending.set(seq, { startedAt: Date.now(), timer, resolve, reject });
    });
  }

  waitEvent(event, afterIndex, timeoutMs = 20000) {
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

let failures = 0;
function check(name, ok, details = {}) {
  const item = { name, ok: !!ok, ...details };
  evidence.checks.push(item);
  if (!item.ok) failures += 1;
  console.log(`${item.ok ? 'ok  ' : 'FAIL'} ${name}`);
  return item.ok;
}

function responseOk(result) { return result?.message?.success === true; }

async function topFrame(client) {
  const result = await client.request('stackTrace', { threadId: 1, startFrame: 0, levels: 4 });
  const frame = result.message.body?.stackFrames?.[0] || {};
  return {
    response: result,
    pc: parseNumber(frame.instructionPointerReference),
    line: frame.line ?? null,
    sourcePath: frame.source?.path ?? null,
    name: frame.name ?? null,
  };
}

async function setBreakpoints(client, sourcePath, lines) {
  return client.request('setBreakpoints', {
    source: { path: sourcePath },
    breakpoints: lines.map(line => ({ line })),
    sourceModified: false,
  });
}

async function controlAndStop(client, command, args = {}, timeoutMs = 20000) {
  const afterIndex = evidence.trace.length - 1;
  const stoppedPromise = client.waitEvent('stopped', afterIndex, timeoutMs);
  const response = await client.request(command, args, timeoutMs);
  const stopped = await stoppedPromise;
  const frame = await topFrame(client);
  return {
    command, response: response.message, responseElapsedMs: response.elapsedMs,
    responseIndex: response.traceIndex, stoppedEvent: stopped.message,
    stoppedIndex: stopped.traceIndex, responseBeforeEvent: response.traceIndex < stopped.traceIndex,
    pc: frame.pc, line: frame.line, sourcePath: frame.sourcePath, frameName: frame.name,
  };
}

async function continueAndStop(client, timeoutMs = 20000) {
  const afterIndex = evidence.trace.length - 1;
  const continuedPromise = client.waitEvent('continued', afterIndex, timeoutMs);
  const stoppedPromise = client.waitEvent('stopped', afterIndex, timeoutMs);
  const startedAt = Date.now();
  const response = await client.request('continue', { threadId: 1 }, timeoutMs);
  const continued = await continuedPromise;
  const stopped = await stoppedPromise;
  const frame = await topFrame(client);
  return {
    command: 'continue', response: response.message, responseElapsedMs: response.elapsedMs,
    elapsedToStopMs: Date.now() - startedAt,
    responseIndex: response.traceIndex, continuedIndex: continued.traceIndex, stoppedIndex: stopped.traceIndex,
    responseBeforeEvents: response.traceIndex < continued.traceIndex && response.traceIndex < stopped.traceIndex,
    pc: frame.pc, line: frame.line, sourcePath: frame.sourcePath, frameName: frame.name,
    stoppedEvent: stopped.message,
  };
}

function verifiedBreakpoints(result) {
  return result.message.body?.breakpoints?.filter(item => item.verified) || [];
}

async function main() {
  const client = new DapClient();
  let launched = false;
  try {
    const initialize = await client.request('initialize', {
      clientID: 'orbit-dap05-hw', adapterID: 'orbit', pathFormat: 'path',
      linesStartAt1: true, columnsStartAt1: true,
    });
    check('initialize preserves DAP memory/source-step surface', responseOk(initialize)
      && initialize.message.body?.supportsReadMemoryRequest === true
      && initialize.message.body?.supportsStepBack !== true, { response: initialize.message });

    const launchIndex = evidence.trace.length - 1;
    const launch = await client.request('launch', {
      program: elfPath,
      device: 'STM32F407VE', deviceName: 'STM32F407VE', interface: 'SWD', speedKHz,
      probe: 'cmsis-dap', cmsisDapTransport: 'hid', cmsisDapVid: vid, cmsisDapPid: pid,
      cmsisDapSerial: serial, flashBeforeDebug: false,
      nativeDebugEngineEnabled: true, nativeDebugEngineMode: 'auto',
      loggingEnabled: true, clearLogsOnStart: true, rttLogEnabled: false,
    }, 30000);
    launched = responseOk(launch);
    check('launch current CMSIS-DAP owner with flashBeforeDebug=false', launched, { response: launch.message });
    if (!launched) return;

    const configurationDone = await client.request('configurationDone');
    const initialStopped = await client.waitEvent('stopped', launchIndex, 10000);
    check('configuration response precedes unique initial stopped event', responseOk(configurationDone)
      && configurationDone.traceIndex < initialStopped.traceIndex, {
      responseIndex: configurationDone.traceIndex, eventIndex: initialStopped.traceIndex,
    });

    // Route six source breakpoints through DWARF and occupy every hardware slot.
    const four = await setBreakpoints(client, freertosPath, [293, 294, 295, 296]);
    const two = await setBreakpoints(client, gpioPath, [447, 451]);
    const seventh = await setBreakpoints(client, cmsisOsPath, [327]);
    const six = [...verifiedBreakpoints(four), ...verifiedBreakpoints(two)];
    const seventhItems = seventh.message.body?.breakpoints || [];
    check('DAP line resolution occupies six distinct hardware slots', responseOk(four) && responseOk(two)
      && six.length === 6 && new Set(six.map(item => item.id)).size === 6, {
      freertos: four.message, gpio: two.message,
    });
    check('DAP seventh breakpoint reports structured resource exhaustion', responseOk(seventh)
      && seventhItems.length === 1 && seventhItems[0].verified === false
      && /BreakpointResourceExhausted/.test(seventhItems[0].message || ''), { response: seventh.message });
    await setBreakpoints(client, freertosPath, []);
    await setBreakpoints(client, gpioPath, []);
    await setBreakpoints(client, cmsisOsPath, []);

    // Set, hit, clear, and re-set the user breakpoint for 20 rounds.
    for (let round = 1; round <= rounds; round++) {
      const set = await setBreakpoints(client, freertosPath, [293]);
      const hit = await continueAndStop(client, 30000);
      const clear = await setBreakpoints(client, freertosPath, []);
      const sample = {
        round, slot: verifiedBreakpoints(set)[0]?.id ?? null,
        pc: hit.pc, line: hit.line, sourcePath: hit.sourcePath,
        targetState: 'Halted', elapsedMs: hit.elapsedToStopMs,
        responseBeforeEvent: hit.responseBeforeEvents,
      };
      evidence.samples.breakpointLifecycle.push(sample);
      check(`breakpoint set/hit/clear/re-set ${round}/${rounds}`, responseOk(set)
        && verifiedBreakpoints(set).length === 1
        && responseOk(hit.response ? { message: hit.response } : null)
        && hit.responseBeforeEvents
        && samePath(hit.sourcePath, freertosPath) && hit.line === 293
        && responseOk(clear) && verifiedBreakpoints(clear).length === 0, sample);
    }

    const active = await setBreakpoints(client, freertosPath, [293]);
    check('user breakpoint restored for control matrix', verifiedBreakpoints(active).length === 1, { response: active.message });

    // Continue while PC is exactly on the user breakpoint; the next stop must
    // be the following loop iteration, not an immediate repeat hit.
    for (let round = 1; round <= rounds; round++) {
      const before = await topFrame(client);
      const result = await continueAndStop(client, 30000);
      const sample = { round, pcBefore: before.pc, pcAfter: result.pc, lineAfter: result.line,
        targetState: 'Halted', elapsedMs: result.elapsedToStopMs,
        responseBeforeEvent: result.responseBeforeEvents };
      evidence.samples.currentPcContinue.push(sample);
      check(`current-PC continue ${round}/${rounds}`, result.response.success === true
        && result.responseBeforeEvents
        && before.pc !== null && result.pc === before.pc
        && samePath(result.sourcePath, freertosPath) && result.line === 293
        && result.elapsedToStopMs >= 100, sample);
    }

    // Instruction step at a user breakpoint, then run to the still-active user breakpoint.
    for (let round = 1; round <= rounds; round++) {
      const before = await topFrame(client);
      const step = await controlAndStop(client, 'stepIn', { threadId: 1, granularity: 'instruction' });
      const nextHit = await continueAndStop(client, 30000);
      const sample = { round, pcBefore: before.pc, pcAfter: step.pc, nextHitPc: nextHit.pc,
        slot: verifiedBreakpoints(active)[0]?.id ?? null, targetState: 'Halted',
        elapsedMs: step.responseElapsedMs, responseBeforeEvent: step.responseBeforeEvent };
      evidence.samples.instructionStep.push(sample);
      check(`instruction step preserves user breakpoint ${round}/${rounds}`, step.response.success === true
        && step.responseBeforeEvent && before.pc !== null && step.pc !== null && step.pc !== before.pc
        && nextHit.response.success === true && nextHit.line === 293
        && samePath(nextHit.sourcePath, freertosPath), sample);
    }

    // Exact regression: line 296 returns to the loop back-edge at 0x08003FEC,
    // which DWARF also maps to line 293. One further Step Over must cross the
    // disjoint same-line range and visibly land on line 294 in one DAP request.
    for (let round = 1; round <= rounds; round++) {
      const s1 = await controlAndStop(client, 'next', { threadId: 1 }, 30000);
      const s2 = await controlAndStop(client, 'next', { threadId: 1 }, 30000);
      const s3 = await controlAndStop(client, 'next', { threadId: 1 }, 30000);
      const backEdge = await controlAndStop(client, 'next', { threadId: 1 }, 30000);
      const crossed = await controlAndStop(client, 'next', { threadId: 1 }, 30000);
      const nextHit = await continueAndStop(client, 30000);
      const sample = {
        round, lines: [s1.line, s2.line, s3.line, backEdge.line, crossed.line],
        pcBackEdge: backEdge.pc, pcAfter: crossed.pc, targetState: 'Halted',
        elapsedMs: crossed.responseElapsedMs, responseBeforeEvent: crossed.responseBeforeEvent,
      };
      evidence.samples.sourceStepOver.push(sample);
      check(`source Step Over disjoint same-line range ${round}/${rounds}`,
        [s1, s2, s3, backEdge, crossed].every(item => item.response.success && item.responseBeforeEvent)
        && s1.line === 294 && s2.line === 295 && s3.line === 296
        && backEdge.line === 293 && backEdge.pc !== null
        && crossed.line === 294 && crossed.pc !== backEdge.pc
        && samePath(crossed.sourcePath, freertosPath)
        && nextHit.line === 293 && samePath(nextHit.sourcePath, freertosPath), sample);
    }

    // Enter HAL_GPIO_TogglePin and step out to the trusted caller PC.
    for (let round = 1; round <= rounds; round++) {
      const into = await controlAndStop(client, 'stepIn', { threadId: 1 }, 30000);
      const out = await controlAndStop(client, 'stepOut', { threadId: 1 }, 30000);
      const nextHit = await continueAndStop(client, 30000);
      const sample = { round, pcInto: into.pc, lineInto: into.line, pcOut: out.pc, lineOut: out.line,
        targetState: 'Halted', elapsedMs: into.responseElapsedMs + out.responseElapsedMs,
        intoResponseBeforeEvent: into.responseBeforeEvent, outResponseBeforeEvent: out.responseBeforeEvent };
      evidence.samples.sourceStepIntoOut.push(sample);
      check(`source Step Into/Out ${round}/${rounds}`, into.response.success === true
        && into.responseBeforeEvent && samePath(into.sourcePath, gpioPath)
        && into.line >= 438 && into.line <= 453
        && out.response.success === true && out.responseBeforeEvent
        && samePath(out.sourcePath, freertosPath) && out.line === 294
        && nextHit.line === 293 && samePath(nextHit.sourcePath, freertosPath), sample);
    }

    // Conditional expression in osDelay: ticks ? ticks : 1.
    await setBreakpoints(client, freertosPath, []);
    const conditionalBp = await setBreakpoints(client, cmsisOsPath, [327]);
    check('conditional-line breakpoint installed', verifiedBreakpoints(conditionalBp).length === 1,
      { response: conditionalBp.message });
    let conditionalHit = await continueAndStop(client, 30000);
    for (let round = 1; round <= rounds; round++) {
      const step = await controlAndStop(client, 'next', { threadId: 1 }, 30000);
      const sample = { round, pcBefore: conditionalHit.pc, pcAfter: step.pc,
        lineBefore: conditionalHit.line, lineAfter: step.line, targetState: 'Halted',
        elapsedMs: step.responseElapsedMs, responseBeforeEvent: step.responseBeforeEvent };
      evidence.samples.conditionalBranch.push(sample);
      check(`conditional branch source Step Over ${round}/${rounds}`, conditionalHit.line === 327
        && samePath(conditionalHit.sourcePath, cmsisOsPath)
        && step.response.success === true && step.responseBeforeEvent
        && step.pc !== conditionalHit.pc, sample);
      if (round < rounds) conditionalHit = await continueAndStop(client, 30000);
    }
    await setBreakpoints(client, cmsisOsPath, []);

    const disconnect = await client.request('disconnect', { restart: false, terminateDebuggee: false }, 20000);
    launched = false;
    check('disconnect clears debug resources', responseOk(disconnect), { response: disconnect.message });
  } finally {
    if (launched) {
      try { await client.request('disconnect', { restart: false, terminateDebuggee: false }, 20000); } catch {}
    }
    await client.stop();
  }
}

function readLog(name) {
  const logPath = path.join(workspace, 'outputs', 'Log', name);
  return fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
}

async function run() {
  let thrown = null;
  try {
    await main();
  } catch (error) {
    thrown = error;
    evidence.fatalError = error.stack || error.message || String(error);
    failures += 1;
    console.error(evidence.fatalError);
  } finally {
    const logs = { dap: readLog('dap.log'), dll: readLog('dll.log'), step: readLog('step.log') };
    const helperPids = [...logs.dll.matchAll(/\[cmsis-dap process\] spawned pid=(\d+)/g)].map(match => Number(match[1]));
    const ownerKinds = [...logs.dll.matchAll(/selected probe=([^ ]+) owner=([^ ]+)/g)]
      .map(match => ({ probe: match[1], owner: match[2] }));
    const jlinkLines = logs.dll.split(/\r?\n/).filter(line =>
      /owner=jlink-(?:native|legacy)|J-Link DLL|JLink\.exe/.test(line));
    const flashLines = [...logs.dap.split(/\r?\n/), ...logs.dll.split(/\r?\n/)].filter(line =>
      /Flashing |flash operation=|ProgramPage|EraseSector|Verify/.test(line));
    evidence.processesAfter = matchingOwners();
    evidence.summary = {
      checks: evidence.checks.length, failures,
      helperPids, distinctHelperPids: [...new Set(helperPids)], ownerKinds,
      jlinkInvolved: jlinkLines.length > 0,
      secondOwnerCreated: ownerKinds.some(item => item.owner !== 'cmsis-dap'),
      flashOperationCount: flashLines.length,
      helpersExited: evidence.processesAfter.length === 0,
    };
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const outputDir = path.join(workspace, 'outputs', 'dap05', stamp, 'source');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'evidence.json'), JSON.stringify(evidence, null, 2), 'utf8');
    for (const [name, content] of Object.entries(logs)) {
      fs.writeFileSync(path.join(outputDir, `${name}.log`), content, 'utf8');
    }
    console.log(`verify-dap05-source-hw: evidence=${outputDir}`);
    console.log(`verify-dap05-source-hw: checks=${evidence.summary.checks} failures=${failures}`
      + ` helpers=${evidence.summary.distinctHelperPids.join(',')}`
      + ` jlink=${evidence.summary.jlinkInvolved} secondOwner=${evidence.summary.secondOwnerCreated}`
      + ` flashOperations=${evidence.summary.flashOperationCount}`
      + ` helpersExited=${evidence.summary.helpersExited}`);
    if (thrown || failures > 0 || evidence.summary.jlinkInvolved || evidence.summary.secondOwnerCreated
      || evidence.summary.flashOperationCount > 0 || !evidence.summary.helpersExited) process.exitCode = 1;
  }
}

run();
