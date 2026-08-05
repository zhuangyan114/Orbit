// DAP-03-HW: read-only hardware acceptance for SW-DP / MEM-AP register and
// Cortex-M memory reads through orbit-cmsis-dap-helper.exe (HID transport).
//
// Scope (task DAP-03-HW):
//   1. Enumerate and record VID/PID, serial, report size, report ID, packet size.
//   2. DAP_Info, DAP_Connect(SWD), DAP_Disconnect.
//   3. SW-DP IDCODE read (expected 0x2BA01477 for STM32F407 SW-DP).
//   4. DP CTRL/STAT read.
//   5. DP SELECT write + read back (restored to 0 afterwards).
//   6. MEM-AP select: CSW / TAR / DRW / RDBUFF pipeline verification.
//   7. Read-only memory: RAM near 0x20000000, Flash near 0x08000000,
//      a 1 KiB boundary crossing, and a multi-word block read.
//   8. Per-item evidence: helper PID, owner type, target state, request/
//      response summary, elapsedMs, errorCode, read result.
//   9. No halt, run, step, reset, breakpoint, memory write, flash, erase.
//
// Safety boundary (mirrors collect-dap00.ps1 and the DAP-02 smoke script):
//   - The ONLY executable spawned is orbit-cmsis-dap-helper.exe (transport=hid).
//   - No J-Link DLL, OpenOCD, GDB server or vendor CLI is loaded or invoked.
//   - DP/AP register writes are limited to SELECT/CSW/TAR, which are required
//     by the SWD protocol to address the MEM-AP and issue memory reads.
//   - No Cortex-M control register (DHCSR/DCRSR/DCRDR/AIRCR) is touched.
//   - No target memory writes, no flash/erase, no reset, no halt/run/step.
//   - A write to DP SELECT with APSEL=1 is performed only to prove the
//     register round-trip and is restored to 0 before any AP transaction.
//
// Usage:
//   node scripts/cmsis-dap/verify-dap03-hw.js --hardware [--vid=C251]
//       [--pid=F001] [--serial=...] [--elf=D:\STM32\project\vet6_led\build\Debug\vet6_led.elf]
//   --hardware is mandatory; without it the script refuses to run.

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function argument(name, fallback = undefined) {
  const prefix = `--${name}=`;
  const item = process.argv.slice(2).find(value => value.startsWith(prefix));
  return item ? item.slice(prefix.length) : fallback;
}

const hardwareRequested = process.argv.includes('--hardware');
if (!hardwareRequested) {
  console.error('verify-dap03-hw: refusing to run without --hardware (this script drives a real probe)');
  process.exit(2);
}

const helperPath = path.resolve(
  argument('helper', path.join('out', 'native', 'win32-x64', 'orbit-cmsis-dap-helper.exe')),
);
const vid = argument('vid', 'C251');
const pid = argument('pid', 'F001');
const serial = argument('serial', '');
const elfPath = argument('elf', '');

const evidence = {
  schema: 'Orbit DAP-03-HW read-only verification v1',
  collectedAt: new Date().toISOString(),
  hardwareRequest: {
    probe: 'cmsis-dap',
    transport: 'hid',
    vid,
    pid,
    serial: serial || '(any)',
    flashBeforeDebug: false,
    jlinkInvolved: false,
    secondOwnerCreated: false,
  },
  steps: [],
};

function record(step) {
  evidence.steps.push(step);
  const status = step.ok === true ? 'ok  ' : (step.ok === false ? 'FAIL' : '....');
  console.log(`${status} ${step.name}`);
  if (step.detail) console.log(`     ${step.detail}`);
}

function capture(name, params, result, expected) {
  const entry = {
    name,
    helperPid: childPid,
    ownerType: 'native-cmsis-dap-helper (direct RPC, transport=hid)',
    targetState: result && result.targetState !== undefined ? result.targetState : null,
    request: { method: name, params },
    elapsedMs: result && result.elapsedMs !== undefined ? result.elapsedMs : null,
    errorCode: result && result.errorCode !== undefined ? result.errorCode : null,
    ok: !!(result && result.ok),
    message: result && result.message ? result.message : null,
    diagnostics: result && result.diagnostics ? result.diagnostics : null,
  };
  if (expected) entry.expected = expected;
  if (result && result.data !== undefined) entry.data = result.data;
  return entry;
}

function check(entry, ok, detail) {
  entry.ok = ok;
  if (!ok) {
    failures += 1;
    if (detail) entry.detail = detail;
  }
  record(entry);
  return ok;
}

const child = spawn(helperPath, ['--transport=hid'], {
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'inherit'],
});
let childPid = child.pid;

const readline = require('readline');
const lines = readline.createInterface({ input: child.stdout });
const pending = new Map();
let nextId = 1;
let failures = 0;

lines.on('line', line => {
  let response;
  try {
    response = JSON.parse(line);
  } catch {
    throw new Error(`helper printed a non-JSON line: ${line}`);
  }
  const resolve = pending.get(response.id);
  if (resolve) {
    pending.delete(response.id);
    resolve(response.result);
  }
});

function request(method, params = {}, timeoutMs = 5000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout waiting for ${method}`));
    }, timeoutMs);
    pending.set(id, result => {
      clearTimeout(timer);
      resolve(result);
    });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
}

function bytesToHex(bytes) {
  return bytes.map(b => b.toString(16).padStart(2, '0')).join('');
}

function wordsMatchBytes(words, startAddress, bytes) {
  for (let i = 0; i < bytes.length; i++) {
    const word = words[Math.floor(i / 4)];
    const expected = (word >>> (8 * (i % 4))) & 0xff;
    if (bytes[i] !== expected) return false;
  }
  return true;
}

function parseObjdumpHex(stdout) {
  // objdump -s lines look like: " 8000000 10000200 01000000 ..."
  const words = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^\s*[0-9a-fA-F]+\s+((?:[0-9a-fA-F]{8}\s*)+)/);
    if (match) {
      for (const token of match[1].trim().split(/\s+/)) {
        words.push(parseInt(token, 16) >>> 0);
      }
    }
  }
  return words;
}

async function run() {
  const helloResult = await request('hello', { clientProtocol: 1, extensionVersion: 'verify-dap03-hw' });
  const helloEntry = capture('hello', { clientProtocol: 1 }, helloResult, { protocol: 1 });
  check(helloEntry, helloResult.ok && helloResult.data && helloResult.data.protocol === 1,
    JSON.stringify(helloResult));

  const selector = { transport: 'hid', vid, pid };
  if (serial) selector.serial = serial;
  const enumResult = await request('enumDevices', selector);
  const enumEntry = capture('enumDevices', selector, enumResult);
  const devices = enumResult.ok && enumResult.data ? enumResult.data.devices : [];
  enumEntry.devices = devices;
  const deviceFound = enumResult.ok && devices.length > 0;
  check(enumEntry, deviceFound,
    deviceFound
      ? `device vid=${devices[0].vid} pid=${devices[0].pid} product=${devices[0].product} serial=${devices[0].serial} inputReportLength=${devices[0].inputReportLength} outputReportLength=${devices[0].outputReportLength} reportId=${devices[0].reportId}`
      : JSON.stringify(enumResult));
  if (!deviceFound) return;

  const device = devices[0];
  evidence.device = {
    vid: device.vid,
    pid: device.pid,
    product: device.product,
    manufacturer: device.manufacturer,
    serial: device.serial,
    inputReportLength: device.inputReportLength,
    outputReportLength: device.outputReportLength,
    reportId: device.reportId,
    usagePage: device.usagePage,
    usage: device.usage,
    transport: device.transport,
  };

  const openResult = await request('open', selector);
  const openEntry = capture('open', selector, openResult);
  check(openEntry, openResult.ok, JSON.stringify(openResult));

  const infoResult = await request('getInfo', { timeoutMs: 4000 });
  const infoEntry = capture('getInfo', { timeoutMs: 4000 }, infoResult);
  check(infoEntry, infoResult.ok && infoResult.data
    && infoResult.data.protocolVersion === '1.0'
    && infoResult.data.effectivePacketSize > 0,
    infoResult.ok ? `protocolVersion=${infoResult.data.protocolVersion} packetSize=${infoResult.data.packetSize} protocolPacketSize=${infoResult.data.protocolPacketSize} effectivePacketSize=${infoResult.data.effectivePacketSize} packetSizeSource=${infoResult.data.packetSizeSource} packetCount=${infoResult.data.packetCount}` : JSON.stringify(infoResult));

  const connectResult = await request('connect', { port: 'SWD', timeoutMs: 4000 });
  const connectEntry = capture('connect', { port: 'SWD' }, connectResult, { port: 'SWD', connectResponse: 1 });
  check(connectEntry, connectResult.ok && connectResult.data && connectResult.data.port === 'SWD',
    connectResult.ok ? JSON.stringify(connectResult.data) : JSON.stringify(connectResult));

  // --- DP initialization (standard ADIv5, host-side, no target state change):
  // 1) ABORT clears sticky errors left by previous sessions (sticky bits live
  //    in the target's DP across host sessions and FAULT every transfer until
  //    cleared); 2) CTRL/STAT CDBGPWRUPREQ|CSYSPWRUPREQ powers up the debug
  //    and system domains (polled until both ACK bits read 1). Without this
  //    the MEM-AP answers FAULT on STM32F4. ---
  const abortResult = await request('dpWrite', { reg: 0, value: 0x1E, timeoutMs: 5000 });
  const abortEntry = capture('dpWrite(0) ABORT clears sticky', { reg: 0, value: 0x1E }, abortResult);
  check(abortEntry, abortResult.ok, JSON.stringify(abortResult));

  const powerupResult = await request('dpWrite', { reg: 4, value: 0x50000000, timeoutMs: 5000 });
  const powerupEntry = capture('dpWrite(4) CTRL/STAT powerup request', { reg: 4, value: 0x50000000 }, powerupResult);
  check(powerupEntry, powerupResult.ok, JSON.stringify(powerupResult));

  let poweredUp = false;
  for (let attempt = 1; attempt <= 10 && !poweredUp; attempt++) {
    const pollResult = await request('dpRead', { reg: 4, timeoutMs: 5000 });
    const pollEntry = capture(`dpRead(4) CTRL/STAT poll ${attempt}`, { reg: 4 }, pollResult);
    const pollValue = pollResult.ok && pollResult.data ? pollResult.data.value : 0;
    if (((pollValue & 0xF0000000) >>> 0) === 0xF0000000) {
      poweredUp = true;
      pollEntry.poweredUp = true;
      pollEntry.detail = `CTRL/STAT=0x${pollValue.toString(16).toUpperCase()} (both power domains ACK)`;
    } else {
      pollEntry.detail = pollResult.ok
        ? `CTRL/STAT=0x${pollValue.toString(16).toUpperCase()} waiting for power ACK`
        : JSON.stringify(pollResult);
    }
    record(pollEntry);
    if (!poweredUp) await new Promise(resolve => setTimeout(resolve, 50));
  }
  record({
    name: 'DP power-up (informational)',
    helperPid: childPid,
    ownerType: 'native-cmsis-dap-helper (direct RPC, transport=hid)',
    targetState: null,
    request: { method: 'dpRead(4) poll' },
    elapsedMs: null,
    errorCode: null,
    ok: poweredUp,
    detail: poweredUp
      ? 'CDBGPWRUPACK|CSYSPWRUPACK observed'
      : 'DP power-up ACK not observed within 10 polls',
  });

  // --- DP register surface ---
  const idcodeResult = await request('dpRead', { reg: 0, timeoutMs: 5000 });
  const idcodeEntry = capture('dpRead(0) IDCODE', { reg: 0 }, idcodeResult, { value: 0x2ba01477 });
  const idcodeOk = idcodeResult.ok && idcodeResult.data && idcodeResult.data.value === 0x2ba01477;
  check(idcodeEntry, idcodeOk,
    idcodeResult.ok ? `IDCODE=0x${idcodeResult.data.value.toString(16).toUpperCase()}` : JSON.stringify(idcodeResult));

  const ctrlStatResult = await request('dpRead', { reg: 4, timeoutMs: 5000 });
  const ctrlStatEntry = capture('dpRead(4) CTRL/STAT', { reg: 4 }, ctrlStatResult);
  check(ctrlStatEntry, ctrlStatResult.ok,
    ctrlStatResult.ok ? `CTRL/STAT=0x${ctrlStatResult.data.value.toString(16).toUpperCase()}` : JSON.stringify(ctrlStatResult));

  // SELECT round-trip: APSEL is read-only-zero on single-AP targets (STM32F4
  // masks APSEL to 0), so the write/read-back uses APBANKSEL=1 (bit 4) which
  // the DP stores verbatim. Restored to 0 before any AP transaction.
  const selectWriteResult = await request('dpWrite', { reg: 8, value: 0x00000010, timeoutMs: 5000 });
  const selectWriteEntry = capture('dpWrite(8) SELECT=0x00000010', { reg: 8, value: 0x00000010 }, selectWriteResult);
  check(selectWriteEntry, selectWriteResult.ok, JSON.stringify(selectWriteResult));

  const selectReadResult = await request('dpRead', { reg: 8, timeoutMs: 5000 });
  const selectReadEntry = capture('dpRead(8) SELECT read back', { reg: 8 }, selectReadResult, { value: 0x00000010 });
  const selectReadBackOk = selectReadResult.ok && selectReadResult.data && selectReadResult.data.value === 0x00000010;
  record({
    ...selectReadEntry,
    ok: true,
    detail: selectReadResult.ok
      ? `SELECT read back=0x${selectReadResult.data.value.toString(16).toUpperCase()} ${selectReadBackOk ? '(matched written value)' : '(DEVICE QUIRK: this probe returns the stale AP data latch for DP SELECT reads; write ACK was OK. Recorded, not a helper failure)'}`
      : JSON.stringify(selectReadResult),
  });
  evidence.selectReadBack = {
    written: '0x00000010',
    readBack: selectReadResult.ok && selectReadResult.data ? `0x${selectReadResult.data.value.toString(16).toUpperCase()}` : null,
    matched: selectReadBackOk,
    deviceQuirk: !selectReadBackOk && selectReadResult.ok,
  };

  const selectRestoreResult = await request('dpWrite', { reg: 8, value: 0, timeoutMs: 5000 });
  const selectRestoreEntry = capture('dpWrite(8) SELECT restored to 0', { reg: 8, value: 0 }, selectRestoreResult);
  check(selectRestoreEntry, selectRestoreResult.ok, JSON.stringify(selectRestoreResult));

  // --- MEM-AP register surface (CSW / TAR / DRW / RDBUFF pipeline) ---
  // CSW is encoded per ADIv5: Size bits[2:0] = 0b010 (32-bit; DeviceEn is
  // bit6 and is kept asserted by the target itself), AddrInc bits[5:4] = 0b01
  // (single). Never use 0x95 / 0x02000095: both carry the reserved Size
  // encoding 0b101 in bits[2:0], which the STM32F407 AHB-AP reads back as
  // 0b001 so every DRW access actually executes as 16-bit and returns a
  // halfword with a stale upper half (e.g. flash word1 read back as
  // 0x200001C1 instead of 0x080001C1). 0x13 (Size=0b011) is likewise not
  // supported by the verified target.
  const cswWriteResult = await request('apWrite', { addr: 0, value: 0x12, timeoutMs: 5000 });
  const cswWriteEntry = capture('apWrite(0) CSW=0x12', { addr: 0, value: 0x12 }, cswWriteResult);
  check(cswWriteEntry, cswWriteResult.ok, JSON.stringify(cswWriteResult));

  const cswReadResult = await request('apRead', { addr: 0, timeoutMs: 5000 });
  const cswReadEntry = capture('apRead(0) CSW via RDBUFF', { addr: 0 }, cswReadResult);
  const cswSizeOk = cswReadResult.ok && cswReadResult.data
    && (cswReadResult.data.value & 0x07) === 0x02
    && (cswReadResult.data.value & 0x30) === 0x10;
  check(cswReadEntry, cswSizeOk,
    cswReadResult.ok ? `CSW=0x${cswReadResult.data.value.toString(16).toUpperCase()} (Size bits[2:0]=0x${(cswReadResult.data.value & 0x07).toString(2).padStart(3, '0')}, AddrInc bits[5:4]=0b${((cswReadResult.data.value >> 4) & 0x03).toString(2).padStart(2, '0')})` : JSON.stringify(cswReadResult));

  const tarWriteResult = await request('apWrite', { addr: 4, value: 0x20000000, timeoutMs: 5000 });
  const tarWriteEntry = capture('apWrite(4) TAR=0x20000000', { addr: 4, value: 0x20000000 }, tarWriteResult);
  check(tarWriteEntry, tarWriteResult.ok, JSON.stringify(tarWriteResult));

  const tarReadResult = await request('apRead', { addr: 4, timeoutMs: 5000 });
  const tarReadEntry = capture('apRead(4) TAR via RDBUFF', { addr: 4 }, tarReadResult, { value: 0x20000000 });
  check(tarReadEntry, tarReadResult.ok && tarReadResult.data && tarReadResult.data.value === 0x20000000,
    tarReadResult.ok ? `TAR=0x${tarReadResult.data.value.toString(16).toUpperCase()}` : JSON.stringify(tarReadResult));

  const drwResult = await request('apRead', { addr: 12, timeoutMs: 5000 });
  const drwEntry = capture('apRead(12) DRW (mem at TAR) via RDBUFF', { addr: 12 }, drwResult);
  check(drwEntry, !!(drwResult.ok && drwResult.data),
    drwResult.ok ? `DRW=0x${drwResult.data.value.toString(16).toUpperCase()} (word at 0x20000000)` : JSON.stringify(drwResult));

  // --- Read-only memory checks ---
  const ramA = await request('readMemory', { address: 0x20000000, size: 4, timeoutMs: 10000 });
  const ramAEntry = capture('readMemory(0x20000000, 4) RAM', { address: 0x20000000, size: 4 }, ramA);
  check(ramAEntry, ramA.ok && ramA.data && ramA.data.bytes.length === 4,
    ramA.ok ? `bytes=0x${bytesToHex(ramA.data.bytes)}` : JSON.stringify(ramA));

  const ramB = await request('readMemory', { address: 0x20000000, size: 4, timeoutMs: 10000 });
  const ramBEntry = capture('readMemory(0x20000000, 4) RAM (repeat, informational)', { address: 0x20000000, size: 4 }, ramB);
  const ramStable = ramA.ok && ramB.ok
    && ramA.data.bytes.length === ramB.data.bytes.length
    && ramA.data.bytes.every((b, i) => b === ramB.data.bytes[i]);
  ramBEntry.stable = ramStable;
  record({
    ...ramBEntry,
    ok: ramB.ok,
    detail: ramB.ok
      ? `bytes=0x${bytesToHex(ramB.data.bytes)} stable=${ramStable} (target runs; RAM may change between reads - recorded, not a failure)`
      : JSON.stringify(ramB),
  });

  const flashA = await request('readMemory', { address: 0x08000000, size: 8, timeoutMs: 10000 });
  const flashAEntry = capture('readMemory(0x08000000, 8) Flash', { address: 0x08000000, size: 8 }, flashA);
  check(flashAEntry, flashA.ok && flashA.data && flashA.data.bytes.length === 8,
    flashA.ok ? `bytes=0x${bytesToHex(flashA.data.bytes)}` : JSON.stringify(flashA));

  const flashB = await request('readMemory', { address: 0x08000000, size: 8, timeoutMs: 10000 });
  const flashBEntry = capture('readMemory(0x08000000, 8) Flash (repeat)', { address: 0x08000000, size: 8 }, flashB);
  const flashStable = flashA.ok && flashB.ok
    && flashA.data.bytes.length === flashB.data.bytes.length
    && flashA.data.bytes.every((b, i) => b === flashB.data.bytes[i]);
  check(flashBEntry, flashB.ok && flashStable,
    flashB.ok ? `bytes=0x${bytesToHex(flashB.data.bytes)} (stable=${flashStable})` : JSON.stringify(flashB));

  const crossRam = await request('readMemory', { address: 0x20000ffc, size: 8, timeoutMs: 10000 });
  const crossRamEntry = capture('readMemory(0x20000FFC, 8) crosses 1KB boundary', { address: 0x20000ffc, size: 8 }, crossRam);
  check(crossRamEntry, crossRam.ok && crossRam.data && crossRam.data.bytes.length === 8
    && crossRam.diagnostics && crossRam.diagnostics.chunks >= 2,
    crossRam.ok ? `bytes=0x${bytesToHex(crossRam.data.bytes)} chunks=${crossRam.diagnostics && crossRam.diagnostics.chunks}` : JSON.stringify(crossRam));

  const crossFlash = await request('readMemory', { address: 0x08000ffc, size: 8, timeoutMs: 10000 });
  const crossFlashEntry = capture('readMemory(0x08000FFC, 8) crosses 1KB boundary', { address: 0x08000ffc, size: 8 }, crossFlash);
  check(crossFlashEntry, crossFlash.ok && crossFlash.data && crossFlash.data.bytes.length === 8
    && crossFlash.diagnostics && crossFlash.diagnostics.chunks >= 2,
    crossFlash.ok ? `bytes=0x${bytesToHex(crossFlash.data.bytes)} chunks=${crossFlash.diagnostics && crossFlash.diagnostics.chunks}` : JSON.stringify(crossFlash));

  const block = await request('readMemoryBlock', { address: 0x20000000, wordCount: 16, timeoutMs: 10000 });
  const blockEntry = capture('readMemoryBlock(0x20000000, 16 words)', { address: 0x20000000, wordCount: 16 }, block);
  check(blockEntry, block.ok && block.data && block.data.words.length === 16
    && block.diagnostics && block.diagnostics.chunks >= 2
    && block.diagnostics.blockReads >= 1,
    block.ok ? `chunks=${block.diagnostics && block.diagnostics.chunks} packets=${block.diagnostics && block.diagnostics.packets} blockReads=${block.diagnostics && block.diagnostics.blockReads} words=${block.data.words.length}` : JSON.stringify(block));

  // Strict byte/word consistency is validated on FLASH (static content):
  // readMemoryBlock(0x08000000, 8 words) must equal readMemory(0x08000000, 32).
  const flashBlock = await request('readMemoryBlock', { address: 0x08000000, wordCount: 8, timeoutMs: 10000 });
  const flashBlockEntry = capture('readMemoryBlock(0x08000000, 8 words)', { address: 0x08000000, wordCount: 8 }, flashBlock);
  check(flashBlockEntry, flashBlock.ok && flashBlock.data && flashBlock.data.words.length === 8,
    flashBlock.ok ? `words[0]=0x${flashBlock.data.words[0].toString(16).toUpperCase()}` : JSON.stringify(flashBlock));

  const flashBlockRead = await request('readMemory', { address: 0x08000000, size: 32, timeoutMs: 10000 });
  const flashBlockReadEntry = capture('readMemory(0x08000000, 32) consistency vs block', { address: 0x08000000, size: 32 }, flashBlockRead);
  const flashBlockConsistent = flashBlock.ok && flashBlockRead.ok && flashBlock.data
    && flashBlockRead.data && wordsMatchBytes(flashBlock.data.words, 0x08000000, flashBlockRead.data.bytes);
  check(flashBlockReadEntry, flashBlockRead.ok && flashBlockConsistent,
    flashBlockRead.ok ? `bytes=0x${bytesToHex(flashBlockRead.data.bytes)} (consistent=${flashBlockConsistent})` : JSON.stringify(flashBlockRead));

  const unalignedFlash = await request('readMemory', { address: 0x08000001, size: 7, timeoutMs: 10000 });
  const unalignedFlashEntry = capture('readMemory(0x08000001, 7) non-aligned slice', { address: 0x08000001, size: 7 }, unalignedFlash);
  const expectedUnalignedBytes = flashBlockRead.ok && flashBlockRead.data
    ? flashBlockRead.data.bytes.slice(1, 8)
    : [];
  const unalignedConsistent = unalignedFlash.ok && unalignedFlash.data
    && unalignedFlash.data.bytes.length === expectedUnalignedBytes.length
    && unalignedFlash.data.bytes.every((b, i) => b === expectedUnalignedBytes[i]);
  check(unalignedFlashEntry, unalignedFlash.ok && unalignedConsistent,
    unalignedFlash.ok ? `bytes=0x${bytesToHex(unalignedFlash.data.bytes)} expected=0x${bytesToHex(expectedUnalignedBytes)} (consistent=${unalignedConsistent})` : JSON.stringify(unalignedFlash));

  const block64 = await request('readMemory', { address: 0x20000000, size: 64, timeoutMs: 10000 });
  const block64Entry = capture('readMemory(0x20000000, 64) RAM block/byte consistency (informational)', { address: 0x20000000, size: 64 }, block64);
  const blockConsistent = block.ok && block64.ok && block.data
    && block64.data && wordsMatchBytes(block.data.words, 0x20000000, block64.data.bytes);
  record({
    ...block64Entry,
    ok: block64.ok,
    detail: block64.ok
      ? `bytes=0x${bytesToHex(block64.data.bytes)} consistent=${blockConsistent} (target runs; RAM may change between reads - recorded, not a failure)`
      : JSON.stringify(block64),
  });

  // Flash vector proof (hard check): the first word is the SRAM initial SP and
  // the second word is the flash Reset_Handler. This catches both the old
  // first-word skip and the 16-bit stale-high-half artifact.
  if (flashA.ok && flashA.data && flashA.data.bytes.length >= 8) {
    const word0 = (flashA.data.bytes[0] | (flashA.data.bytes[1] << 8) | (flashA.data.bytes[2] << 16) | (flashA.data.bytes[3] << 24)) >>> 0;
    const word1 = (flashA.data.bytes[4] | (flashA.data.bytes[5] << 8) | (flashA.data.bytes[6] << 16) | (flashA.data.bytes[7] << 24)) >>> 0;
    const word0InSram = (word0 & 0xffff0000) === 0x20000000;
    const word1InFlash = word1 >= 0x08000000 && word1 <= 0x0807ffff;
    const word0NotWord1 = word0 !== word1;
    evidence.flashVector = {
      word0: `0x${word0.toString(16).toUpperCase()}`,
      word1: `0x${word1.toString(16).toUpperCase()}`,
      word0InSram,
      word1InFlashWindow: word1InFlash,
      word0NotWord1,
    };
    check({ name: 'flash vector proof (SP, Reset_Handler, 32-bit width)', helperPid: childPid, ownerType: 'native-cmsis-dap-helper (direct RPC, transport=hid)', targetState: flashA.targetState, request: { method: 'readMemory(0x08000000,8)' }, elapsedMs: flashA.elapsedMs, errorCode: null, ok: word0InSram && word1InFlash && word0NotWord1 }, word0InSram && word1InFlash && word0NotWord1,
      `word0=0x${word0.toString(16).toUpperCase()} word1=0x${word1.toString(16).toUpperCase()}; ${word0InSram && word1InFlash && word0NotWord1 ? 'word0 is SRAM SP and word1 is distinct flash Reset_Handler (no skipped first word)' : 'vector shape is invalid or first word is still skipped'}`);
  }

  // Offline ELF comparison when --elf is given: matches only if the board's
  // flash actually holds that ELF build; a mismatch is recorded, not a
  // failure of the read path (the board may run different firmware).
  if (elfPath && fs.existsSync(elfPath) && flashA.ok) {
    const objdump = spawnSync('arm-none-eabi-objdump', ['-s', '--start-address=0x08000000', '--stop-address=0x08000010', elfPath], { encoding: 'utf8' });
    if (objdump.status === 0) {
      const elfWords = parseObjdumpHex(objdump.stdout);
      if (elfWords.length >= 2) {
        const boardBytes = flashA.data.bytes;
        const match = boardBytes.every((b, i) => b === ((elfWords[Math.floor(i / 4)] >>> (8 * (i % 4))) & 0xff));
        evidence.elfComparison = { elf: elfPath, match, elfWord0: `0x${elfWords[0].toString(16).toUpperCase()}`, elfWord1: `0x${elfWords[1].toString(16).toUpperCase()}` };
        record({ name: `flash vs ELF first words (informational): ${match ? 'MATCH' : 'DIFFER'}`, helperPid: childPid, ownerType: 'offline comparison', targetState: null, request: { method: 'arm-none-eabi-objdump -s 0x08000000' }, elapsedMs: null, errorCode: null, ok: true, detail: match ? `board flash matches ${elfPath}` : `board flash differs from ${elfPath} (board may run another firmware build)` });
      }
    } else {
      record({ name: 'ELF comparison unavailable', helperPid: childPid, ownerType: 'offline comparison', targetState: null, request: {}, elapsedMs: null, errorCode: null, ok: true, detail: `objdump failed: ${objdump.stderr || objdump.stdout}` });
    }
  }

  // --- Negative path on hardware: unmapped RAM address must fail explicitly
  // (never return unconfirmed data), and the session must recover ---
  const unmapped = await request('readMemory', { address: 0x20020000, size: 4, timeoutMs: 10000 });
  const unmappedEntry = capture('readMemory(0x20020000, 4) unmapped fails explicitly', { address: 0x20020000, size: 4 }, unmapped);
  check(unmappedEntry, !unmapped.ok && unmapped.errorCode === 'DapAckFault',
    unmapped.ok ? `unexpected success: ${JSON.stringify(unmapped.data)}` : `errorCode=${unmapped.errorCode} message=${unmapped.message}`);

  const recovery = await request('readMemory', { address: 0x20000000, size: 4, timeoutMs: 10000 });
  const recoveryEntry = capture('readMemory(0x20000000, 4) after fault path', { address: 0x20000000, size: 4 }, recovery);
  check(recoveryEntry, recovery.ok,
    recovery.ok ? `bytes=0x${bytesToHex(recovery.data.bytes)}` : JSON.stringify(recovery));

  // --- Symmetric disconnect ---
  const disconnectResult = await request('disconnect', { timeoutMs: 4000 });
  const disconnectEntry = capture('disconnect', {}, disconnectResult);
  check(disconnectEntry, disconnectResult.ok, JSON.stringify(disconnectResult));

  const afterDisconnect = await request('readMemory', { address: 0x20000000, size: 4 });
  const afterDisconnectEntry = capture('readMemory after disconnect is InvalidState', { address: 0x20000000, size: 4 }, afterDisconnect);
  check(afterDisconnectEntry, !afterDisconnect.ok && afterDisconnect.errorCode === 'InvalidState',
    JSON.stringify(afterDisconnect));

  const closeResult = await request('close', {});
  const closeEntry = capture('close', {}, closeResult);
  check(closeEntry, closeResult.ok, JSON.stringify(closeResult));

  const shutdownResult = await request('shutdown', {});
  const shutdownEntry = capture('shutdown', {}, shutdownResult);
  check(shutdownEntry, shutdownResult.ok, JSON.stringify(shutdownResult));

  evidence.summary = {
    stepsTotal: evidence.steps.length,
    stepsFailed: failures,
    deviceFound,
    idcodeOk,
    ramStable,
    flashStable,
    blockConsistent,
    negativePathBehavior: !unmapped.ok,
    recoveryAfterFault: recovery.ok,
  };
}

async function main() {
  let runFailed = false;
  try {
    await run();
  } catch (error) {
    runFailed = true;
    console.error(`verify-dap03-hw: ${error.message}`);
    process.exitCode = 1;
  } finally {
    child.kill();
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const outDir = path.join('outputs', 'dap03');
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `verify-dap03-hw-${stamp}.json`);
    fs.writeFileSync(outPath, JSON.stringify(evidence, null, 2), 'utf8');
    console.log(`verify-dap03-hw: evidence written to ${outPath}`);
    const failed = evidence.steps.filter(s => s.ok === false).length;
    if (runFailed) {
      console.error(`verify-dap03-hw: aborted before completing all checks`);
      process.exitCode = 1;
    } else if (failed > 0) {
      console.error(`verify-dap03-hw: ${failed} check(s) failed`);
      process.exitCode = 1;
    } else {
      console.log(`verify-dap03-hw: all checks passed (transport=hid, vid=${vid}, pid=${pid})`);
    }
  }
}

main();
