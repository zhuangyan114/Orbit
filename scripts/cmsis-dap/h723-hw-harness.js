'use strict';

// Shared CMSIS-DAP helper session for STM32H723VGT6 P7 hardware scripts.
// Scripts must refuse without --hardware, and mutating levels must refuse
// without their own --authorize-* flag before this module spawns a helper.

const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const WORKSPACE = path.resolve(__dirname, '..', '..');
const H723 = Object.freeze({
  name: 'STM32H723VGT6',
  probe: 'cmsis-dap',
  dpIdcode: 0x6BA02477,
  dbgmcuAddress: 0x5C001000,
  deviceId: 0x483,
  flashSizeRegisterAddress: 0x1FF1E880,
  expectedFlashSizeKiB: 1024,
  flashBase: 0x08000000,
  flashSize: 1024 * 1024,
  lastSectorAddress: 0x080E0000,
  lastSectorSize: 0x20000,
  flashStatusAddress: 0x52002010,
  flashControlAddress: 0x5200200C,
  axiSram: { name: 'AXI SRAM', address: 0x24000000, size: 320 * 1024 },
  dtcm: { name: 'DTCM RAM', address: 0x20000000, size: 128 * 1024 },
  d2: { name: 'SRAM1-3', address: 0x30000000, size: 272 * 1024 },
  d3: { name: 'SRAM4', address: 0x38000000, size: 16 * 1024 },
  algorithmFileName: 'orbit-stm32h723-flash-algorithm.bin',
  stackSize: 0x1000,
  eraseTimeoutMs: 30000,
  programTimeoutMs: 15000,
  initTimeoutMs: 5000,
});

function argument(name, fallback) {
  const prefix = `--${name}=`;
  const item = process.argv.slice(2).find(value => value.startsWith(prefix));
  return item ? item.slice(prefix.length) : fallback;
}

function integerArgument(name, fallback) {
  const raw = argument(name, fallback);
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`--${name} must be a non-negative integer`);
  }
  return value;
}

function requireHardware(scriptName) {
  if (!process.argv.includes('--hardware')) {
    console.error(`${scriptName}: refusing to run without --hardware (this script drives a real probe)`);
    process.exit(2);
  }
}

function requireAuthorize(scriptName, flag, operations) {
  if (!process.argv.includes(flag)) {
    console.error(`${scriptName}: refusing to run without ${flag} (authorized operations: ${operations.join(', ')})`);
    process.exit(2);
  }
}

function matchingOwnerProcesses() {
  const output = execFileSync('tasklist.exe', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
  return output.split(/\r?\n/).filter(line =>
    /orbit-(?:cmsis-dap|jlink)-helper|JLink\.exe|openocd|arm-none-eabi-gdb/i.test(line));
}

function refuseSecondOwner(scriptName) {
  const existing = matchingOwnerProcesses();
  if (existing.length > 0) {
    throw new Error(`${scriptName}: target owner process already exists; refusing to create another owner:\n${existing.join('\n')}`);
  }
}

function hex(value) {
  return `0x${(value >>> 0).toString(16).toUpperCase()}`;
}

function bytesToHex(bytes) {
  return Array.from(bytes || []).map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function readLe16(bytes) {
  return (bytes[0] | (bytes[1] << 8)) >>> 0;
}

function readLe32(bytes) {
  return (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
}

function alignUp(value, alignment) {
  return (value + alignment - 1) & ~(alignment - 1);
}

function loadH723Algorithm() {
  const imagePath = path.resolve(WORKSPACE, 'out', 'native', 'win32-x64', H723.algorithmFileName);
  if (!fs.existsSync(imagePath)) {
    throw new Error(`H723 Flash Algorithm is missing: ${imagePath}`);
  }
  const code = Uint8Array.from(fs.readFileSync(imagePath));
  if (code.length <= 0x501 || code[0x500] !== 0x00 || code[0x501] !== 0xBE) {
    throw new Error(`H723 Flash Algorithm BKPT sentinel is missing: ${imagePath}`);
  }
  const algorithmAddress = H723.axiSram.address;
  const pageBufferAddress = alignUp(algorithmAddress + code.length, 4);
  const stackAddress = H723.axiSram.address + H723.axiSram.size - H723.stackSize;
  if (pageBufferAddress + 32 > stackAddress) {
    throw new Error('H723 Flash Algorithm does not fit in AXI SRAM with a 32-byte page buffer');
  }
  return {
    path: imagePath,
    code: Array.from(code),
    algorithmAddress,
    pageBufferAddress,
    stackPointer: stackAddress + H723.stackSize,
    stackSize: H723.stackSize,
    ramBase: H723.axiSram.address,
    ramSize: H723.axiSram.size,
    entries: {
      init: 0x000,
      uninit: 0x100,
      eraseSector: 0x200,
      programPage: 0x300,
      verify: 0x400,
      bkpt: 0x500,
    },
  };
}

function flashAlgorithmParams(algorithm, operation, address, size, data = [], reusePageBuffer = false) {
  const timeoutMs = operation === 'eraseSector'
    ? H723.eraseTimeoutMs
    : (operation === 'programPage' || operation === 'verify')
      ? H723.programTimeoutMs
      : H723.initTimeoutMs;
  return {
    operation,
    algorithm: algorithm.code,
    algorithmAddress: algorithm.algorithmAddress,
    entry: algorithm.algorithmAddress + algorithm.entries[operation],
    bkptAddress: algorithm.algorithmAddress + algorithm.entries.bkpt,
    stackPointer: algorithm.stackPointer,
    stackSize: algorithm.stackSize,
    pageBufferAddress: algorithm.pageBufferAddress,
    targetAddress: address,
    size,
    data: Array.from(data),
    clockHz: 4000000,
    staticBase: 0,
    timeoutMs,
    reusePageBuffer,
    flashStatusAddress: H723.flashStatusAddress,
    flashControlAddress: H723.flashControlAddress,
    ramBase: algorithm.ramBase,
    ramSize: algorithm.ramSize,
  };
}

function createEvidence(schema, authorization) {
  const vid = argument('vid', 'C251');
  const pid = argument('pid', 'F001');
  const serial = argument('serial', '');
  const transport = argument('transport', 'hid');
  const speedKHz = integerArgument('speed-khz', 1000);
  return {
    schema,
    collectedAt: new Date().toISOString(),
    authorization,
    hardwareRequest: {
      mcu: H723.name,
      probe: H723.probe,
      transport,
      vid,
      pid,
      serial: serial || '(any)',
      speedKHz,
      jlinkInvolved: false,
      secondOwnerCreated: false,
    },
    helperPid: null,
    device: null,
    operations: [],
    steps: [],
    summary: {},
  };
}

function createHelperSession(evidence) {
  const helperPath = path.resolve(
    WORKSPACE,
    argument('helper', path.join('out', 'native', 'win32-x64', 'orbit-cmsis-dap-helper.exe')),
  );
  if (!fs.existsSync(helperPath)) {
    throw new Error(`CMSIS-DAP helper not found: ${helperPath}`);
  }
  const transport = evidence.hardwareRequest.transport;
  const child = spawn(helperPath, [`--transport=${transport}`], {
    cwd: WORKSPACE,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  evidence.helperPid = child.pid;
  evidence.helperPath = helperPath;
  const lines = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  let nextId = 1;
  let failures = 0;
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  lines.on('line', line => {
    let response;
    try {
      response = JSON.parse(line);
    } catch {
      throw new Error(`helper printed a non-JSON line: ${line}`);
    }
    const item = pending.get(response.id);
    if (!item) return;
    pending.delete(response.id);
    clearTimeout(item.timer);
    item.resolve(response.result);
  });

  function request(method, params = {}, timeoutMs = 5000) {
    const id = nextId++;
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, timeoutMs);
      pending.set(id, {
        timer,
        resolve: result => {
          evidence.operations.push({
            method,
            helperPid: child.pid,
            ownerType: 'native-cmsis-dap-helper',
            targetState: result && result.targetState !== undefined ? result.targetState : null,
            request: { method, params: sanitizeParams(params) },
            elapsedMs: result && result.elapsedMs !== undefined ? result.elapsedMs : Date.now() - startedAt,
            errorCode: result && result.errorCode !== undefined ? result.errorCode : null,
            ok: !!(result && result.ok),
            message: result && result.message ? result.message : null,
            data: result && result.data !== undefined ? result.data : undefined,
            diagnostics: result && result.diagnostics ? result.diagnostics : null,
          });
          resolve(result);
        },
      });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  function check(name, ok, detail) {
    const passed = !!ok;
    if (!passed) failures += 1;
    const step = {
      name,
      helperPid: child.pid,
      ownerType: 'native-cmsis-dap-helper',
      ok: passed,
      detail: detail || null,
    };
    evidence.steps.push(step);
    console.log(`${passed ? 'ok  ' : 'FAIL'} ${name}`);
    if (detail) console.log(`     ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
    return passed;
  }

  function sanitizeParams(params) {
    if (!params || typeof params !== 'object') return params;
    const copy = { ...params };
    if (Array.isArray(copy.algorithm)) copy.algorithm = `[${copy.algorithm.length} bytes]`;
    if (Array.isArray(copy.data) && copy.data.length > 64) copy.data = `[${copy.data.length} bytes]`;
    if (Array.isArray(copy.bytes) && copy.bytes.length > 64) copy.bytes = `[${copy.bytes.length} bytes]`;
    return copy;
  }

  async function waitForExit(timeoutMs = 3000) {
    if (child.exitCode !== null) return;
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, timeoutMs)),
    ]);
    if (child.exitCode === null) child.kill();
  }

  return {
    child,
    request,
    check,
    failures: () => failures,
    stderr: () => stderr,
    waitForExit,
  };
}

async function connectSwd(session, evidence) {
  const { vid, pid, serial, transport, speedKHz } = evidence.hardwareRequest;
  const hello = await session.request('hello', { clientProtocol: 1, extensionVersion: 'verify-h723-hw' });
  session.check('helper handshake', hello.ok && hello.data && hello.data.protocol === 1, hello);
  const selector = { transport, vid, pid };
  if (serial && serial !== '(any)') selector.serial = serial;
  const enumerated = await session.request('enumDevices', selector, 10000);
  const devices = enumerated.ok && enumerated.data ? enumerated.data.devices : [];
  session.check('enumerate CMSIS-DAP probe', enumerated.ok && devices.length > 0,
    devices[0]
      ? `vid=${devices[0].vid} pid=${devices[0].pid} serial=${devices[0].serial} transport=${devices[0].transport}`
      : enumerated);
  if (!devices[0]) return false;
  evidence.device = {
    vid: devices[0].vid,
    pid: devices[0].pid,
    serial: devices[0].serial,
    product: devices[0].product,
    manufacturer: devices[0].manufacturer,
    transport: devices[0].transport,
    inputReportLength: devices[0].inputReportLength,
    outputReportLength: devices[0].outputReportLength,
    reportId: devices[0].reportId,
  };
  const opened = await session.request('open', selector, 10000);
  session.check('open selected CMSIS-DAP probe', opened.ok, opened);
  if (!opened.ok) return false;
  const connected = await session.request('connect', { port: 'SWD', speedKHz, timeoutMs: 4000 }, 10000);
  session.check('connect SWD', connected.ok && connected.data && connected.data.port === 'SWD', connected);
  if (!connected.ok) return false;
  const abort = await session.request('dpWrite', { reg: 0, value: 0x1E, timeoutMs: 5000 });
  session.check('DP ABORT clears sticky errors', abort.ok, abort);
  const powerup = await session.request('dpWrite', { reg: 4, value: 0x50000000, timeoutMs: 5000 });
  session.check('DP CTRL/STAT power-up request', powerup.ok, powerup);
  let poweredUp = false;
  for (let attempt = 1; attempt <= 10 && !poweredUp; attempt += 1) {
    const poll = await session.request('dpRead', { reg: 4, timeoutMs: 5000 });
    const value = poll.ok && poll.data ? poll.data.value : 0;
    poweredUp = ((value & 0xF0000000) >>> 0) === 0xF0000000;
    if (!poweredUp) await new Promise(resolve => setTimeout(resolve, 50));
  }
  session.check('DP debug/system domains powered', poweredUp, poweredUp ? 'CDBGPWRUPACK|CSYSPWRUPACK' : 'power ACK missing');
  return poweredUp;
}

async function disconnectSession(session) {
  await session.request('disconnect', { timeoutMs: 4000 }).catch(() => {});
  await session.request('close', {}).catch(() => {});
  await session.request('shutdown', {}).catch(() => {});
  await session.waitForExit();
}

function writeEvidence(scriptName, evidence, outDirName) {
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const outDir = path.join(WORKSPACE, 'outputs', outDirName);
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${scriptName}-${stamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify(evidence, null, 2), 'utf8');
  console.log(`${scriptName}: evidence written to ${outPath}`);
  return outPath;
}

async function finish(scriptName, evidence, session, runFailed, outDirName) {
  evidence.summary.stepsTotal = evidence.steps.length;
  evidence.summary.stepsFailed = session ? session.failures() : (runFailed ? 1 : 0);
  evidence.summary.runFailed = !!runFailed;
  evidence.summary.processesAfter = matchingOwnerProcesses();
  if (session) evidence.stderr = session.stderr();
  writeEvidence(scriptName, evidence, outDirName);
  const failed = evidence.steps.filter(step => step.ok === false).length;
  if (runFailed) {
    console.error(`${scriptName}: aborted before completing all checks`);
    process.exitCode = 1;
  } else if (failed > 0) {
    console.error(`${scriptName}: ${failed} check(s) failed`);
    process.exitCode = 1;
  } else {
    console.log(`${scriptName}: all checks passed`);
  }
}

module.exports = {
  H723,
  WORKSPACE,
  argument,
  integerArgument,
  requireHardware,
  requireAuthorize,
  matchingOwnerProcesses,
  refuseSecondOwner,
  hex,
  bytesToHex,
  readLe16,
  readLe32,
  loadH723Algorithm,
  flashAlgorithmParams,
  createEvidence,
  createHelperSession,
  connectSwd,
  disconnectSession,
  finish,
};
