// DAP-06-HW startup-stop acceptance through the real DAP adapter.
// Requires explicit --hardware authorization and refuses to create a second owner.

'use strict';

const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function argument(name, fallback) {
  const prefix = `--${name}=`;
  const item = process.argv.slice(2).find(value => value.startsWith(prefix));
  return item ? item.slice(prefix.length) : fallback;
}

if (!process.argv.includes('--hardware')) {
  console.error('verify-dap06-startup-hw: refusing to run without --hardware');
  process.exit(2);
}

const workspace = path.resolve(__dirname, '..', '..');
const adapterPath = path.resolve(workspace, argument('adapter', path.join('dist', 'debugadapter.js')));
const projectPath = path.resolve(argument('project', 'D:\\STM32\\project\\vet6_led'));
const elfPath = path.resolve(argument('elf', path.join(projectPath, 'build', 'Debug', 'vet6_led.elf')));
const mainPath = path.join(projectPath, 'Core', 'Src', 'main.c');
const freertosPath = path.join(projectPath, 'Core', 'Src', 'freertos.c');
const vid = argument('vid', 'C251');
const pid = argument('pid', 'F001');
const serial = argument('serial', 'LU_2022_8888');
const speedKHz = Number(argument('speed-khz', '1000'));

for (const file of [adapterPath, elfPath, mainPath, freertosPath]) {
  if (!fs.existsSync(file)) throw new Error(`required file not found: ${file}`);
}

const nm = execFileSync('arm-none-eabi-nm', ['-S', '--defined-only', elfPath], { encoding: 'utf8' });
const mainMatch = nm.split(/\r?\n/).map(line =>
  /^([0-9a-fA-F]+)\s+([0-9a-fA-F]+)\s+[Tt]\s+main$/.exec(line)).find(Boolean);
if (!mainMatch) throw new Error(`main symbol not found in ${elfPath}`);
const mainAddress = Number.parseInt(mainMatch[1], 16) >>> 0;
const mainSize = Number.parseInt(mainMatch[2], 16) >>> 0;

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
  schema: 'Orbit DAP-06 startup-stop hardware verification v1',
  collectedAt: new Date().toISOString(),
  hardware: {
    mcu: 'STM32F407VET6', probe: 'CMSIS-DAP_LU', transport: 'hid',
    vid, pid, serial, speedKHz, elfPath, mainAddress, mainSize,
  },
  checks: [], scenarios: [], processesBefore: existingOwners,
};
let failures = 0;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function parseNumber(value) {
  if (typeof value === 'number') return value >>> 0;
  if (typeof value !== 'string') return null;
  const parsed = Number.parseInt(value, value.toLowerCase().startsWith('0x') ? 16 : 10);
  return Number.isFinite(parsed) ? parsed >>> 0 : null;
}
function samePath(left, right) {
  return typeof left === 'string'
    && path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}
function check(name, ok, details = {}) {
  const item = { name, ok: !!ok, ...details };
  evidence.checks.push(item);
  if (!item.ok) failures += 1;
  console.log(`${item.ok ? 'ok  ' : 'FAIL'} ${name}`);
}

class DapClient {
  constructor(trace) {
    this.trace = trace;
    this.child = spawn(process.execPath, [adapterPath], {
      cwd: workspace, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.nextSeq = 1;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.stderr = '';
    this.child.stdout.on('data', chunk => this.onData(chunk));
    this.child.stderr.on('data', chunk => { this.stderr += chunk.toString('utf8'); });
    this.child.once('exit', (code, signal) => {
      this.exit = { code, signal };
      for (const pending of this.pending.values()) pending.reject(new Error(`adapter exited code=${code}`));
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
      const entry = { index: this.trace.length, direction: 'adapter->client', message };
      this.trace.push(entry);
      if (message.type === 'response') {
        const pending = this.pending.get(message.request_seq);
        if (pending) {
          this.pending.delete(message.request_seq);
          clearTimeout(pending.timer);
          pending.resolve({ message, traceIndex: entry.index });
        }
      }
    }
  }

  request(command, args = {}, timeoutMs = 30000) {
    const seq = this.nextSeq++;
    const message = { type: 'request', seq, command, arguments: args };
    const traceIndex = this.trace.length;
    this.trace.push({ index: traceIndex, direction: 'client->adapter', message });
    const body = JSON.stringify(message);
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error(`timeout waiting for DAP response command=${command}`));
      }, timeoutMs);
      this.pending.set(seq, { timer, resolve, reject });
    });
  }

  async eventAfter(event, afterIndex, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const entry = this.trace.find(item => item.index > afterIndex
        && item.message.type === 'event' && item.message.event === event);
      if (entry) return entry;
      if (Date.now() >= deadline) throw new Error(`timeout waiting for DAP event=${event}`);
      await sleep(10);
    }
  }

  async stop() {
    if (this.child.exitCode === null) {
      this.child.stdin.end();
      await Promise.race([new Promise(resolve => this.child.once('exit', resolve)), sleep(3000)]);
    }
    if (this.child.exitCode === null) this.child.kill();
  }
}

function readLog(name) {
  const file = path.join(workspace, 'outputs', 'Log', name);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

async function topFrame(client) {
  const result = await client.request('stackTrace', { threadId: 1, startFrame: 0, levels: 1 });
  const frame = result.message.body?.stackFrames?.[0] || {};
  return {
    pc: parseNumber(frame.instructionPointerReference),
    name: frame.name ?? null, line: frame.line ?? null, sourcePath: frame.source?.path ?? null,
  };
}

function launchArguments(flashBeforeDebug) {
  return {
    program: elfPath,
    device: 'STM32F407VE', deviceName: 'STM32F407VE', interface: 'SWD', speedKHz,
    probe: 'cmsis-dap', cmsisDapTransport: 'hid', cmsisDapVid: vid, cmsisDapPid: pid,
    cmsisDapSerial: serial, flashBeforeDebug, runToEntryPoint: 'main',
    nativeDebugEngineEnabled: true, nativeDebugEngineMode: 'auto',
    loggingEnabled: true, clearLogsOnStart: true, rttLogEnabled: false,
  };
}

function frameIsMain(frame) {
  return frame.pc !== null && frame.pc >= mainAddress && frame.pc < mainAddress + mainSize
    && samePath(frame.sourcePath, mainPath);
}

async function runScenario(name, flashBeforeDebug, verifyRestart, restartWhileRunning = false) {
  const owners = matchingOwners();
  if (owners.length > 0) throw new Error(`${name}: owner already active:\n${owners.join('\n')}`);
  const scenario = { name, flashBeforeDebug, restartWhileRunning, trace: [], logs: {}, adapterPid: null };
  evidence.scenarios.push(scenario);
  const client = new DapClient(scenario.trace);
  scenario.adapterPid = client.child.pid;
  let launched = false;
  try {
    const initialize = await client.request('initialize', {
      clientID: 'orbit-dap06-hw', adapterID: 'ozone', pathFormat: 'path', linesStartAt1: true,
    });
    check(`${name}: initialize`, initialize.message.success === true);

    const launchStart = scenario.trace.length - 1;
    const launch = await client.request('launch', launchArguments(flashBeforeDebug), 60000);
    launched = launch.message.success === true;
    const configurationDone = await client.request('configurationDone');
    const launchStopped = await client.eventAfter('stopped', launchStart, 10000);
    const launchFrame = await topFrame(client);
    const launchDllLog = readLog('dll.log');
    const launchStartupControls = launchDllLog.split(/\r?\n/)
      .filter(line => /control method=(?:reset|runToAddress)\b/.test(line));
    scenario.launch = { response: launch.message, responseIndex: launch.traceIndex,
      configurationDone: configurationDone.message,
      configurationDoneIndex: configurationDone.traceIndex,
      stopped: launchStopped.message, stoppedIndex: launchStopped.index, frame: launchFrame,
      startupControls: launchStartupControls };
    check(`${name}: launch response precedes one entry stop at ${flashBeforeDebug ? 'main' : 'the current PC'}`, launched
      && launch.traceIndex < launchStopped.index
      && configurationDone.message.success === true
      && configurationDone.traceIndex < launchStopped.index
      && launchStopped.message.body?.reason === 'entry'
      && (flashBeforeDebug ? frameIsMain(launchFrame) : launchFrame.pc !== null), scenario.launch);
    check(`${name}: launch startup control matches flashBeforeDebug`, flashBeforeDebug
      ? launchStartupControls.some(line => /control method=runToAddress\b/.test(line))
      : launchStartupControls.length === 0, { launchStartupControls });

    if (verifyRestart) {
      if (restartWhileRunning) {
        const continued = await client.request('continue', { threadId: 1 }, 30000);
        scenario.runningBeforeRestart = { response: continued.message, responseIndex: continued.traceIndex };
        check(`${name}: target is running before restart`, continued.message.success === true,
          scenario.runningBeforeRestart);
      } else {
        const set = await client.request('setBreakpoints', {
          source: { path: freertosPath }, breakpoints: [{ line: 293 }], sourceModified: false,
        });
        const user = set.message.body?.breakpoints?.[0];
        check(`${name}: user breakpoint installed before restart`, set.message.success === true
          && user?.verified === true, { response: set.message });
      }

      const restartStart = scenario.trace.length - 1;
      const restart = await client.request('restart', {}, 30000);
      const restartStopped = await client.eventAfter('stopped', restartStart, 10000);
      const restartFrame = await topFrame(client);
      scenario.restart = { response: restart.message, responseIndex: restart.traceIndex,
        stopped: restartStopped.message, stoppedIndex: restartStopped.index, frame: restartFrame };
      check(`${name}: restart response precedes one entry stop at main`, restart.message.success === true
        && restart.traceIndex < restartStopped.index
        && restartStopped.message.body?.reason === 'entry' && frameIsMain(restartFrame), scenario.restart);

      if (!restartWhileRunning) {
        const continueStart = scenario.trace.length - 1;
        const continued = await client.request('continue', { threadId: 1 }, 30000);
        const userStopped = await client.eventAfter('stopped', continueStart, 30000);
        const userFrame = await topFrame(client);
        scenario.userBreakpointAfterRestart = { response: continued.message,
          stopped: userStopped.message, frame: userFrame };
        check(`${name}: restart preserves the user breakpoint`, continued.message.success === true
          && userStopped.message.body?.reason === 'breakpoint'
          && samePath(userFrame.sourcePath, freertosPath) && userFrame.line === 293,
        scenario.userBreakpointAfterRestart);
        await client.request('setBreakpoints', {
          source: { path: freertosPath }, breakpoints: [], sourceModified: false,
        });
      }
    }

    const disconnect = await client.request('disconnect', { restart: false, terminateDebuggee: false });
    launched = false;
    check(`${name}: disconnect`, disconnect.message.success === true);
  } finally {
    if (launched) {
      try { await client.request('disconnect', { restart: false, terminateDebuggee: false }); } catch {}
    }
    await client.stop();
    await sleep(250);
    scenario.adapterStderr = client.stderr;
    scenario.logs = { dap: readLog('dap.log'), dll: readLog('dll.log'), step: readLog('step.log') };
    scenario.helperPids = [...scenario.logs.dll.matchAll(/spawned pid=(\d+)/g)].map(match => Number(match[1]));
    scenario.ownerKinds = [...scenario.logs.dll.matchAll(/selected probe=([^ ]+) owner=([^ ]+)/g)]
      .map(match => ({ probe: match[1], owner: match[2] }));
    scenario.startupResults = [...scenario.logs.dll.matchAll(/control method=runToAddress[^\n]+/g)]
      .map(match => match[0]);
    scenario.flashOperations = scenario.logs.dll.split(/\r?\n/).filter(line => /flash operation=/.test(line));
    scenario.processesAfter = matchingOwners();
    check(`${name}: exactly one CMSIS-DAP helper and no fallback`,
      new Set(scenario.helperPids).size === 1
      && scenario.ownerKinds.length === 1
      && scenario.ownerKinds[0].owner === 'cmsis-dap'
      && !/owner=jlink-|JLink\.exe|openocd|arm-none-eabi-gdb/i.test(scenario.logs.dll));
    check(`${name}: startup comparator cleanup reported success`, scenario.startupResults.length >= 1
      && scenario.startupResults.every(line => /ok=true/.test(line) && /"cleanupOk":true/.test(line)));
    check(`${name}: Flash operation count matches configuration`, flashBeforeDebug
      ? scenario.flashOperations.length > 0 : scenario.flashOperations.length === 0,
    { count: scenario.flashOperations.length });
    if (restartWhileRunning) {
      const runIndex = scenario.logs.dll.lastIndexOf('control method=run ok=true');
      const haltIndex = scenario.logs.dll.indexOf('control method=halt ok=true', runIndex + 1);
      const flashIndex = scenario.logs.dll.indexOf('flash operation=init', haltIndex + 1);
      const entryIndex = scenario.logs.dll.indexOf('control method=runToAddress ok=true', flashIndex + 1);
      scenario.restartControlOrder = { runIndex, haltIndex, flashIndex, entryIndex };
      check(`${name}: running Restart halts before Flash and then reaches main`,
        runIndex >= 0 && haltIndex > runIndex && flashIndex > haltIndex && entryIndex > flashIndex,
      scenario.restartControlOrder);
    }
    check(`${name}: helper exited`, scenario.processesAfter.length === 0,
      { processesAfter: scenario.processesAfter });
  }
}

async function run() {
  try {
    await runScenario('no-flash launch/restart', false, true);
    await runScenario('flash launch/running restart', true, true, true);
  } catch (error) {
    evidence.fatalError = error.stack || error.message || String(error);
    failures += 1;
    console.error(evidence.fatalError);
  } finally {
    evidence.processesAfter = matchingOwners();
    evidence.summary = { checks: evidence.checks.length, failures,
      secondOwnerCreated: evidence.scenarios.some(item => item.ownerKinds?.some(owner => owner.owner !== 'cmsis-dap')),
      helperPids: evidence.scenarios.flatMap(item => item.helperPids || []),
      helpersExited: evidence.processesAfter.length === 0 };
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const outputDir = path.join(workspace, 'outputs', 'dap06', stamp, 'hardware');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'evidence.json'), JSON.stringify(evidence, null, 2), 'utf8');
    for (const scenario of evidence.scenarios) {
      const prefix = scenario.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
      for (const [name, content] of Object.entries(scenario.logs || {})) {
        fs.writeFileSync(path.join(outputDir, `${prefix}-${name}.log`), content, 'utf8');
      }
    }
    console.log(`verify-dap06-startup-hw: evidence=${outputDir}`);
    console.log(`verify-dap06-startup-hw: checks=${evidence.summary.checks} failures=${failures}`
      + ` helpers=${evidence.summary.helperPids.join(',')}`
      + ` secondOwner=${evidence.summary.secondOwnerCreated}`
      + ` helpersExited=${evidence.summary.helpersExited}`);
    if (failures > 0 || evidence.summary.secondOwnerCreated || !evidence.summary.helpersExited) {
      process.exitCode = 1;
    }
  }
}

run();
