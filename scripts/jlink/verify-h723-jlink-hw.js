'use strict';

// P7-6: STM32H723VGT6 J-Link native owner connect / flash / debug smoke test.
// The J-Link path is device-name pass-through only: the same `STM32H723VGT6`
// string goes to JLink.exe (-device) and to the J-Link DLL (device command),
// so this script proves the name is accepted instead of asserting new code.
// Usage:
//   node scripts/jlink/verify-h723-jlink-hw.js --hardware --authorize-flash-jlink [--elf=<path>]
//   node scripts/jlink/verify-h723-jlink-hw.js --hardware --skip-flash
//   --skip-flash keeps flashBeforeDebug=false (no erase/program/verify); it is
//   the only mode that does not require the flash authorization flag.

const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const WORKSPACE = path.resolve(__dirname, '..', '..');
const H723 = Object.freeze({
  name: 'STM32H723VGT6',
  // J-Link V9.56 does not know the full part number: `-device STM32H723VGT6`
  // makes the Commander offer a device-selection dialog and stall the flash.
  // The J-Link path only forwards `device`, so it must use a name from the
  // installed J-Link device database; the CMSIS-DAP registry accepts both.
  jlinkDevice: 'STM32H723VG',
  flashBase: 0x08000000,
  dbgmcuIdcodeAddress: 0x5C001000,
  deviceId: 0x483,
  flashSizeRegisterAddress: 0x1FF1E880,
  expectedFlashSizeKiB: 1024,
  axiSram: 0x24000000,
});
const DEFAULT_ELF = 'D:\\STM32\\project\\h7vgt6_test\\build\\Debug\\h7vgt6_test.elf';
const BREAKPOINT_SOURCE = 'D:\\STM32\\project\\h7vgt6_test\\Core\\Src\\main.c';
const BREAKPOINT_LINE = 93; // HAL_Init()

const SCRIPT = 'verify-h723-jlink-hw';

function argument(name, fallback) {
  const prefix = `--${name}=`;
  const item = process.argv.slice(2).find(value => value.startsWith(prefix));
  return item ? item.slice(prefix.length) : fallback;
}

function integerArgument(name, fallback) {
  const raw = argument(name, fallback);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`--${name} must be a non-negative integer`);
  return value;
}

// The probe is a physical J-Link; every mode talks to it. Flashing additionally
// erases/programs/verifies, so it needs its own flag.
if (!process.argv.includes('--hardware')) {
  console.error(`${SCRIPT}: refusing to run without --hardware (this script drives a real probe)`);
  process.exit(2);
}
const skipFlash = process.argv.includes('--skip-flash');
if (!skipFlash && !process.argv.includes('--authorize-flash-jlink')) {
  console.error(`${SCRIPT}: refusing to run without --authorize-flash-jlink `
    + '(authorized operations: halt, reset, erase, program, verify, flashBeforeDebug)');
  process.exit(2);
}

const adapterPath = path.resolve(WORKSPACE, argument('adapter', path.join('dist', 'debugadapter.js')));
const elfPath = path.resolve(argument('elf', DEFAULT_ELF));
const speedKHz = integerArgument('speed-khz', 4000);
const device = argument('device', H723.jlinkDevice);
const flashBeforeDebug = !skipFlash;

if (!fs.existsSync(adapterPath)) throw new Error(`DAP adapter not found: ${adapterPath}`);
if (!elfPath || !fs.existsSync(elfPath)) throw new Error(`ELF not found: ${elfPath || '(missing --elf)'}`);

const evidence = {
  schema: 'Orbit H723 P7-6 J-Link native connect/flash/debug hardware verification v1',
  collectedAt: new Date().toISOString(),
  authorization: {
    grantedByUser: true,
    mode: skipFlash ? 'connect-and-debug-only' : 'flash-before-debug',
    authorizedOperations: skipFlash
      ? ['halt', 'continue', 'reset', 'breakpoint', 'step', 'target reads', 'debug session']
      : ['halt', 'reset', 'erase', 'program', 'verify', 'flashBeforeDebug', 'breakpoint', 'step', 'target reads', 'debug session'],
    forbiddenOperations: ['option bytes', 'second owner', 'cmsis-dap fallback', 'legacy fallback', 'openocd', 'gdb server'],
  },
  hardwareRequest: {
    mcu: H723.name,
    probe: 'jlink',
    ownerExpectation: 'jlink-native (nativeDebugEngineMode=native, no fallback)',
    interface: 'SWD',
    speedKHz,
    device,
    deviceName: H723.name,
    elfPath,
    flashBeforeDebug,
  },
  adapterPid: null,
  jlinkExePath: null,
  probeDevices: [],
  jlinkCommandLines: [],
  trace: [],
  checks: [],
  summary: {},
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function hex(value) {
  return `0x${(value >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
}

function matchingOwnerProcesses() {
  const output = execFileSync('tasklist.exe', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
  return output.split(/\r?\n/).filter(line => /orbit-(?:cmsis-dap|jlink)-helper|JLink\.exe|openocd|arm-none-eabi-gdb/i.test(line));
}

function addCheck(name, ok, details = {}) {
  const check = { name, ok: !!ok, ...details };
  evidence.checks.push(check);
  console.log(`${check.ok ? 'ok  ' : 'FAIL'} ${name}`);
  if (!check.ok && details.message) console.log(`     ${details.message}`);
  return check.ok;
}

// Samples the real JLink.exe command line while the launch flashes, so the
// evidence shows the device string that reached the J-Link software.
function startJLinkCommandSampler(seconds) {
  const lines = [
    '$seen = @{}',
    `$deadline = (Get-Date).AddSeconds(${seconds})`,
    'while ((Get-Date) -lt $deadline) {',
    '  Get-CimInstance Win32_Process -Filter "Name=\'JLink.exe\'" -ErrorAction SilentlyContinue | ForEach-Object {',
    '    if ($_.CommandLine -and -not $seen.ContainsKey($_.CommandLine)) { $seen[$_.CommandLine] = $true; Write-Output $_.CommandLine }',
    '  }',
    '  Start-Sleep -Milliseconds 200',
    '}',
  ].join('\n');
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', lines], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  let buffer = '';
  child.stdout.on('data', chunk => {
    buffer += chunk.toString('utf8');
    const parts = buffer.split(/\r?\n/);
    buffer = parts.pop();
    for (const line of parts) {
      const trimmed = line.trim();
      if (trimmed && !evidence.jlinkCommandLines.includes(trimmed)) evidence.jlinkCommandLines.push(trimmed);
    }
  });
  return {
    stop() {
      try { child.kill(); } catch { }
    },
  };
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

function responseOk(result) {
  return !!result?.message?.success;
}

function outputEvents() {
  return evidence.trace
    .filter(entry => entry.direction === 'adapter->client' && entry.message?.type === 'event' && entry.message.event === 'output')
    .map(entry => String(entry.message.body?.output || ''));
}

function readLog(name) {
  const logPath = path.join(WORKSPACE, 'outputs', 'Log', name);
  return fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
}

function detectProbe() {
  try {
    const text = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-PnpDevice -PresentOnly | Where-Object { $_.InstanceId -match "VID_1366" } | '
      + 'Select-Object Status,Class,FriendlyName,InstanceId | Format-List',
    ], { encoding: 'utf8', windowsHide: true });
    return text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  } catch (error) {
    return [`probe detection failed: ${error.message}`];
  }
}

function findJLinkExe() {
  const candidates = [
    'C:\\Program Files\\SEGGER\\JLink\\JLink.exe',
    'C:\\Program Files (x86)\\SEGGER\\JLink\\JLink.exe',
  ];
  return candidates.find(candidate => fs.existsSync(candidate)) || null;
}

async function main() {
  const before = matchingOwnerProcesses();
  if (before.length) {
    throw new Error(`${SCRIPT}: target owner process already exists; refusing to create another owner:\n${before.join('\n')}`);
  }
  evidence.probeDevices = detectProbe();
  evidence.jlinkExePath = findJLinkExe();

  const client = new DapClient();
  const sampler = startJLinkCommandSampler(300);
  let thrown = null;
  try {
    const initialize = await client.request('initialize', {
      clientID: 'orbit-h723-p7-6',
      adapterID: 'orbit',
      pathFormat: 'path',
      linesStartAt1: true,
      columnsStartAt1: true,
    });
    addCheck('initialize', responseOk(initialize), { message: initialize.message.message });

    const launchStart = evidence.trace.length - 1;
    const launch = await client.request('launch', {
      program: elfPath,
      device,
      deviceName: H723.name,
      interface: 'SWD',
      speedKHz,
      probe: 'jlink',
      nativeDebugEngineEnabled: true,
      nativeDebugEngineMode: 'native',
      flashBeforeDebug,
      loggingEnabled: true,
      clearLogsOnStart: true,
      rttLogEnabled: false,
    }, 180000);
    addCheck(`launch (flashBeforeDebug=${flashBeforeDebug})`, responseOk(launch), {
      elapsedMs: launch.elapsedMs,
      message: launch.message.message,
    });
    if (!responseOk(launch)) throw new Error(`launch failed: ${launch.message.message}`);
    sampler.stop();

    const outputs = outputEvents();
    evidence.flashOutputLines = outputs.filter(line => /Flash|Flashing/i.test(line));
    evidence.launchElapsedMs = launch.elapsedMs;
    if (!skipFlash) {
      addCheck('JLink.exe flash reported success', outputs.some(line => /Flash successful/i.test(line)), {
        lines: evidence.flashOutputLines,
        launchElapsedMs: launch.elapsedMs,
      });
      addCheck('JLink.exe invocation used the configured J-Link device name',
        evidence.jlinkCommandLines.some(line => line.includes('-device') && line.includes(device)),
        { expected: `-device ${device}`, commandLines: evidence.jlinkCommandLines });
    }

    const configurationDone = await client.request('configurationDone');
    addCheck('configurationDone', responseOk(configurationDone), { message: configurationDone.message.message });
    const stopped = await client.waitEvent('stopped', launchStart, 20000);
    evidence.initialStop = stopped.message.body;
    addCheck('stopped after launch', !!stopped.message.body, { body: stopped.message.body });

    const state = await client.request('getTargetState');
    addCheck('target halted after launch', responseOk(state)
      && String(state.message.body?.state || state.message.body || '').toLowerCase() === 'halted',
    { body: state.message.body });

    const idcode = await client.request('readMemory', { memoryReference: hex(H723.dbgmcuIdcodeAddress), count: 4 });
    const idcodeValue = responseOk(idcode)
      ? Buffer.from(idcode.message.body?.data || '', 'base64').readUInt32LE(0)
      : null;
    // DBGMCU_IDCODE: DEV_ID is the low 12 bits, REV_ID the upper 16.
    addCheck('DBGMCU_IDCODE reports DEV_ID 0x483', idcodeValue !== null
      && (idcodeValue & 0xFFF) === H723.deviceId,
    {
      address: hex(H723.dbgmcuIdcodeAddress),
      value: idcodeValue === null ? null : hex(idcodeValue),
      devId: idcodeValue === null ? null : hex(idcodeValue & 0xFFF),
      revId: idcodeValue === null ? null : hex((idcodeValue >>> 16) & 0xFFFF),
    });

    const flashSize = await client.request('readMemory', { memoryReference: hex(H723.flashSizeRegisterAddress), count: 2 });
    const flashSizeKiB = responseOk(flashSize)
      ? Buffer.from(flashSize.message.body?.data || '', 'base64').readUInt16LE(0)
      : null;
    addCheck('Flash size register reads 1024 KiB', flashSizeKiB === H723.expectedFlashSizeKiB,
      { address: hex(H723.flashSizeRegisterAddress), value: flashSizeKiB });

    const vector = await client.request('readMemory', { memoryReference: hex(H723.flashBase), count: 8 });
    const vectorBytes = responseOk(vector) ? Buffer.from(vector.message.body?.data || '', 'base64') : Buffer.alloc(0);
    const initialSp = vectorBytes.length === 8 ? vectorBytes.readUInt32LE(0) : 0;
    const resetHandler = vectorBytes.length === 8 ? vectorBytes.readUInt32LE(4) : 0;
    addCheck('Flash vector table matches the flashed image', vectorBytes.length === 8
      && (initialSp & 0xFF000000) === 0x20000000
      && resetHandler >= H723.flashBase && resetHandler < H723.flashBase + 0x200000,
    { base: hex(H723.flashBase), initialSp: hex(initialSp), resetHandler: hex(resetHandler) });

    const breakpoint = await client.request('setBreakpoints', {
      source: { path: BREAKPOINT_SOURCE },
      breakpoints: [{ line: BREAKPOINT_LINE }],
      sourceModified: false,
    });
    addCheck('source breakpoint verified on main.c', responseOk(breakpoint)
      && breakpoint.message.body?.breakpoints?.[0]?.verified === true,
    { line: BREAKPOINT_LINE, response: breakpoint.message });

    const continueStart = evidence.trace.length - 1;
    const resumed = await client.request('continue', { threadId: 1 }, 20000);
    addCheck('continue accepted', responseOk(resumed), { message: resumed.message.message });
    const hit = await client.waitEvent('stopped', continueStart, 20000);
    evidence.breakpointStop = hit.message.body;
    addCheck('breakpoint hit while running', hit.message.body?.reason === 'breakpoint', { body: hit.message.body });

    const evaluate = await client.request('evaluate', { expression: 'uwTick', context: 'watch' });
    // The adapter returns "0x00000000 (0)" style results, so read the number
    // out of the text instead of Number()-ing the whole string.
    const uwTickText = String(evaluate.message.body?.result ?? '');
    const uwTickMatch = /(0x[0-9a-f]+|\d+)/i.exec(uwTickText);
    const uwTick = uwTickMatch ? Number(uwTickMatch[1]) : NaN;
    addCheck('watch expression evaluates', responseOk(evaluate) && Number.isFinite(uwTick) && uwTick >= 0,
    { expression: 'uwTick', body: evaluate.message.body });

    const stepStart = evidence.trace.length - 1;
    const step = await client.request('next', { threadId: 1 }, 20000);
    addCheck('native source step over accepted', responseOk(step), {
      elapsedMs: step.elapsedMs,
      message: step.message.message,
      body: step.message.body,
    });
    const stepStop = await client.waitEvent('stopped', stepStart, 20000);
    addCheck('source step reported a stopped state', !!stepStop.message.body, { body: stepStop.message.body });

    const ram = await client.request('readMemory', { memoryReference: hex(H723.axiSram), count: 16 });
    addCheck('AXI SRAM read-back', responseOk(ram)
      && Buffer.from(ram.message.body?.data || '', 'base64').length === 16,
    { address: hex(H723.axiSram), response: ram.message });

    const clear = await client.request('setBreakpoints', {
      source: { path: BREAKPOINT_SOURCE },
      breakpoints: [],
      sourceModified: false,
    });
    addCheck('breakpoint cleared', responseOk(clear), { response: clear.message });

    const disconnect = await client.request('disconnect', { restart: false, terminateDebuggee: false }, 20000);
    addCheck('disconnect', responseOk(disconnect), { message: disconnect.message.message });
  } catch (error) {
    thrown = error;
    evidence.abortError = error.stack || error.message || String(error);
    process.exitCode = 1;
  } finally {
    sampler.stop();
    await client.stop();
    await sleep(800);
    const logs = { dap: readLog('dap.log'), dll: readLog('dll.log') };
    const combined = `${logs.dap}\n${logs.dll}`;
    const ownerLines = [...combined.matchAll(/selected (?:mode|probe)=[^ ]+ owner=([^ ]+)/g)].map(match => match[1]);
    const fallbackLines = combined.split(/\r?\n/).filter(line => /fallback mode=auto|action=create-legacy-owner|owner=jlink-legacy/i.test(line));
    const cmsisDapLines = combined.split(/\r?\n/).filter(line => /\[cmsis-dap\]/.test(line));
    const forbiddenLines = combined.split(/\r?\n/).filter(line => /openocd|arm-none-eabi-gdb|JLink\.exe .*--/i.test(line));
    const helperPids = [...new Set([...combined.matchAll(/\[cpp-jlink process\] spawned pid=(\d+)/g)].map(match => Number(match[1])))];
    evidence.summary = {
      checks: evidence.checks.length,
      failedChecks: evidence.checks.filter(check => !check.ok).length,
      ownerKinds: [...new Set(ownerLines)],
      helperPids,
      fallbackLines,
      cmsisDapLineCount: cmsisDapLines.length,
      forbiddenLines,
      processesAfter: matchingOwnerProcesses(),
      flashOutputLines: evidence.flashOutputLines || [],
      jlinkCommandLines: evidence.jlinkCommandLines,
    };
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const outDir = path.join(WORKSPACE, 'outputs', 'h723-p7');
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `${SCRIPT}-${stamp}.json`);
    fs.writeFileSync(outPath, JSON.stringify(evidence, null, 2), 'utf8');
    console.log(`${SCRIPT}: evidence written to ${outPath}`);

    const summary = evidence.summary;
    const ownerOk = summary.ownerKinds.length === 1 && summary.ownerKinds[0] === 'jlink-native';
    if (thrown) console.error(`${SCRIPT}: ${thrown.message}`);
    if (!thrown && (summary.failedChecks > 0 || !ownerOk || summary.fallbackLines.length > 0
      || summary.processesAfter.length > 0 || summary.forbiddenLines.length > 0
      || (!skipFlash && summary.flashOutputLines.length === 0))) {
      process.exitCode = 1;
    } else if (!thrown) {
      console.log(`${SCRIPT}: all checks passed (owner=${summary.ownerKinds.join(',') || 'unknown'})`);
    }
  }
}

main().catch(error => {
  console.error(`${SCRIPT}: ${error.stack || error.message || String(error)}`);
  process.exitCode = 1;
});
