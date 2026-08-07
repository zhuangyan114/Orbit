// CMSIS-DAP helper smoke test.
//
// Modes:
//   default / --mock     exercises the full mock matrix (framing, DAP_Info,
//                        DAP_Connect, DAP_Disconnect, error injection) against
//                        the helper's built-in mock transport. No USB needed.
//   --transport=hid --hardware   runs the low-risk hardware handshake
//                        (enumerate -> open -> getInfo -> connect(SWD) ->
//                        disconnect -> close) against a real HID device,
//                        filtered by --vid/--pid/--serial. No target-mutating
//                        operations are performed.
//
// The helper is spawned as a child process and driven over JSON-lines on
// stdin/stdout, exactly like the TypeScript helper client does.

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const readline = require('readline');
const fpbOracle = require('./cmsis-dap/fpb-oracle');

function argument(name, fallback = undefined) {
  const prefix = `--${name}=`;
  const item = process.argv.slice(2).find(value => value.startsWith(prefix));
  return item ? item.slice(prefix.length) : fallback;
}

const useMock = !process.argv.includes('--hardware') || process.argv.includes('--mock');
const helperPath = path.resolve(
  argument('helper', path.join('out', 'native', 'win32-x64', 'orbit-cmsis-dap-helper.exe')),
);
const transport = argument('transport', useMock ? 'mock' : 'hid');
const vid = argument('vid', '');
const pid = argument('pid', '');
const serial = argument('serial', '');

// Mock target memory pattern (must match mock_transport.cpp mockWordAt):
// the little-endian word at aligned address A is (A ^ 0xA5A5A5A5).
function mockByteAt(address) {
  const word = ((address & ~3) ^ 0xA5A5A5A5) >>> 0;
  return (word >>> (8 * (address & 3))) & 0xFF;
}
function bytesMatchPattern(bytes, startAddress) {
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== mockByteAt(startAddress + i)) return false;
  }
  return true;
}
function wordsMatchPattern(words, startAddress) {
  for (let i = 0; i < words.length; i++) {
    if (words[i] !== (((startAddress + i * 4) ^ 0xA5A5A5A5) >>> 0)) return false;
  }
  return true;
}

const child = spawn(helperPath, [`--transport=${transport}`], {
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'inherit'],
});
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

function check(name, condition, detail) {
  if (condition) {
    console.log(`ok   ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}: ${detail}`);
  }
}

async function openAndInfo(vidValue, pidValue, name) {
  const open = await request('open', {
    transport: 'mock',
    vid: vidValue,
    pid: pidValue,
  });
  check(`${name}: open`, open.ok, JSON.stringify(open));
  if (!open.ok) return null;
  return open;
}

async function closeDevice(name) {
  const closed = await request('close', {});
  check(`${name}: close`, closed.ok, JSON.stringify(closed));
}

async function runMockMatrix() {
  // HID overlapped I/O cancellation outcome classification self-test:
  //  - cancellation confirmed -> control-transfer resend allowed
  //  - original write completed -> resend forbidden
  //  - outcome unknown -> resend forbidden
  const selfTest = spawnSync(helperPath, ['--selftest'], { windowsHide: true, encoding: 'utf8' });
  check('selftest: HID cancellation outcomes', selfTest.status === 0,
    selfTest.stdout || selfTest.stderr);

  const hello = await request('hello', { clientProtocol: 1, extensionVersion: 'cmsis-dap-smoke' });
  check('hello', hello.ok && hello.data.protocol === 1, JSON.stringify(hello));
  check('hello capabilities', Array.isArray(hello.data.capabilities)
    && hello.data.capabilities.includes('dapInfo')
    && hello.data.capabilities.includes('dapConnect')
    && hello.data.capabilities.includes('dapTransfer')
    && hello.data.capabilities.includes('dapTransferBlock')
    && hello.data.capabilities.includes('swDp')
    && hello.data.capabilities.includes('memAp')
    && hello.data.capabilities.includes('readMemory')
    && hello.data.capabilities.includes('readMemoryBlock'), JSON.stringify(hello.data.capabilities));

  const enumAll = await request('enumDevices', { transport: 'mock' });
  check('enumDevices: all', enumAll.ok && enumAll.data.devices.length === 24,
    JSON.stringify(enumAll));

  const enumFiltered = await request('enumDevices', { transport: 'mock', vid: '1234', pid: '9999' });
  check('enumDevices: vid/pid filter', enumFiltered.ok && enumFiltered.data.devices.length === 0,
    JSON.stringify(enumFiltered));

  const noDevice = await request('open', { transport: 'mock', vid: '1234', pid: '9999' });
  check('open: device not found', !noDevice.ok && noDevice.errorCode === 'DeviceNotFound',
    JSON.stringify(noDevice));

  const winusb = await request('open', { transport: 'winusb' });
  check('open: winusb unsupported', !winusb.ok && winusb.errorCode === 'TransportNotSupported',
    JSON.stringify(winusb));

  // --- normal device: official layout happy path ---
  // Covers: official [cmd][len][data] DAP_Info (no info id echo), NUL-
  // terminated strings stripped by the protocol layer, Capabilities 0xF0,
  // Packet Count 0xFE as a single BYTE, Packet Size 0xFF as a little-endian
  // SHORT.
  await openAndInfo('1234', '5678', 'normal');
  const info = await request('getInfo', {});
  check('normal: DAP_Info official layout', info.ok
    && info.data.vendor === 'MockVendor'
    && info.data.product === 'Mock CMSIS-DAP'
    && info.data.serial === 'MOCK-0001'
    && info.data.protocolVersion === '1.0'
    && info.data.firmwareVersion === '1.2.3'
    && info.data.capabilities.length === 1 && info.data.capabilities[0] === 1
    && info.data.packetCount === 1
    && info.data.packetSize === 64
    && info.data.packetSizeSource === 'protocol-info'
    && info.data.effectivePacketSize === 64, JSON.stringify(info));
  const connect = await request('connect', { port: 'SWD' });
  check('normal: DAP_Connect(SWD) [0x02][Port]', connect.ok && connect.data.port === 'SWD'
    && connect.data.connectResponse === 1, JSON.stringify(connect));
  const disconnect = await request('disconnect', {});
  check('normal: DAP_Disconnect [0x03][Status]', disconnect.ok, JSON.stringify(disconnect));
  await closeDevice('normal');

  // --- empty-info device: DAP_Info items not provided ---
  await openAndInfo('1234', '5679', 'empty-info');
  const emptyInfo = await request('getInfo', {});
  check('empty-info: empty items', emptyInfo.ok
    && emptyInfo.data.vendor === ''
    && emptyInfo.data.product === ''
    && emptyInfo.data.serial === ''
    && emptyInfo.data.protocolVersion === ''
    && emptyInfo.data.packetCount === null
    && emptyInfo.data.packetSize === null
    && emptyInfo.data.protocolPacketSize === null
    && emptyInfo.data.packetSizeSource === 'hid-report-capability'
    && emptyInfo.data.effectivePacketSize === 64, JSON.stringify(emptyInfo));
  const emptyConnect = await request('connect', { port: 'SWD' });
  check('empty-info: DAP_Connect(SWD)', emptyConnect.ok && emptyConnect.data.port === 'SWD',
    JSON.stringify(emptyConnect));
  await closeDevice('empty-info');

  // --- corrupt device: command byte 0xFF / invalid port / DAP_ERROR ---
  await openAndInfo('1234', '567A', 'corrupt');
  const corruptInfo = await request('getInfo', {});
  check('corrupt: DAP_Info command byte 0xFF', !corruptInfo.ok
    && corruptInfo.errorCode === 'MalformedResponse', JSON.stringify(corruptInfo));
  const corruptConnect = await request('connect', { port: 'SWD' });
  check('corrupt: DAP_Connect invalid port', !corruptConnect.ok
    && corruptConnect.errorCode === 'MalformedResponse', JSON.stringify(corruptConnect));
  const corruptDisconnect = await request('disconnect', {});
  check('corrupt: DAP_Disconnect DAP_ERROR', !corruptDisconnect.ok
    && corruptDisconnect.errorCode === 'ProtocolError', JSON.stringify(corruptDisconnect));
  await closeDevice('corrupt');

  // --- silent device: read timeout ---
  await openAndInfo('1234', '567B', 'silent');
  const silentInfo = await request('getInfo', { timeoutMs: 150 });
  check('silent: read timeout', !silentInfo.ok && silentInfo.errorCode === 'ReadTimeout',
    JSON.stringify(silentInfo));
  await closeDevice('silent');

  // --- report-id-1 device: non-zero report id, 33-byte reports ---
  await openAndInfo('1234', '567C', 'report-id-1');
  const reportIdInfo = await request('getInfo', {});
  check('report-id-1: DAP_Info', reportIdInfo.ok
    && reportIdInfo.data.vendor === 'MockVendor'
    && reportIdInfo.data.packetSize === 64, JSON.stringify(reportIdInfo));
  const reportIdConnect = await request('connect', { port: 'SWD' });
  check('report-id-1: DAP_Connect(SWD)', reportIdConnect.ok
    && reportIdConnect.data.port === 'SWD', JSON.stringify(reportIdConnect));
  await closeDevice('report-id-1');

  const closedInfo = await request('getInfo', {});
  check('getInfo after close: InvalidState', !closedInfo.ok
    && closedInfo.errorCode === 'InvalidState', JSON.stringify(closedInfo));

  // --- connect-fail device: official port 0 = initialization failed ---
  await openAndInfo('1234', '567E', 'connect-fail');
  const failConnect = await request('connect', { port: 'SWD' });
  check('connect-fail: DAP_Connect port 0', !failConnect.ok
    && failConnect.errorCode === 'ProtocolError', JSON.stringify(failConnect));
  const failInfo = await request('getInfo', {});
  check('connect-fail: DAP_Info still works', failInfo.ok
    && failInfo.data.protocolVersion === '1.0', JSON.stringify(failInfo));
  await closeDevice('connect-fail');

  // --- vendor-echo device (1234:567D): legacy [cmd][infoId][len][data] and
  // [cmd][status][port] layouts. No real device is known to need them, so the
  // smoke suite deliberately does NOT exercise this device; the mock is kept
  // for future compatibility checks once a device proves the need. ---
}

function flashAlgorithmParams(operation, address, size, data = [], reusePageBuffer = false) {
  const algorithm = new Array(0x600).fill(0xBF);
  algorithm[0x500] = 0x00;
  algorithm[0x501] = 0xBE;
  return {
    operation,
    algorithm,
    algorithmAddress: 0x20000000,
    entry: 0x20000000 + ({ init: 0x000, uninit: 0x100, eraseSector: 0x200, programPage: 0x300, verify: 0x400 }[operation]),
    bkptAddress: 0x20000500,
    stackPointer: 0x20020000,
    stackSize: 0x1000,
    pageBufferAddress: 0x20000600,
    targetAddress: address,
    size,
    data,
    clockHz: 4000000,
    staticBase: 0,
    timeoutMs: 500,
    reusePageBuffer,
  };
}

async function runDap02AMatrix() {
  await openAndInfo('1234', '5678', 'dap02a-normal');
  const connected = await request('connect', { port: 'SWD' });
  check('dap02a-normal: connect', connected.ok, JSON.stringify(connected));
  if (connected.ok) {
    const halted = await request('halt', { timeoutMs: 100 });
    check('dap02a-normal: halt before algorithm', halted.ok, JSON.stringify(halted));
    if (!halted.ok) {
      await closeDevice('dap02a-normal');
      return;
    }
    const init = await request('flashAlgorithm', flashAlgorithmParams('init', 0x08000000, 0));
    check('dap02a: algorithm init', init.ok && init.data.returnCode === 0, JSON.stringify(init));
    check('dap02a: initial algorithm upload recorded', init.ok
      && init.diagnostics.blockWrites > 0, JSON.stringify(init));
    check('dap02a: algorithm BKPT halt', init.ok && init.data.pc === 0x20000500
      && (init.data.dhcsr & 0x20000) !== 0, JSON.stringify(init));
    const erase = await request('flashAlgorithm', flashAlgorithmParams('eraseSector', 0x08000000, 0x4000));
    check('dap02a: sector erase', erase.ok && erase.data.returnCode === 0, JSON.stringify(erase));
    check('dap02a: cached algorithm skips erase code upload', erase.ok
      && erase.diagnostics.blockWrites === 0, JSON.stringify(erase));
    const first = [0x00, 0x01, 0x02, 0x03];
    const program = await request('flashAlgorithm', flashAlgorithmParams('programPage', 0x08000000, first.length, first));
    check('dap02a: 1-to-0 program', program.ok && program.data.returnCode === 0, JSON.stringify(program));
    check('dap02a: cached algorithm writes only program buffer', program.ok
      && program.diagnostics.blockWrites === 1, JSON.stringify(program));
    const verify = await request('flashAlgorithm', flashAlgorithmParams('verify', 0x08000000, first.length, first, true));
    check('dap02a: full verify', verify.ok && verify.data.returnCode === 0, JSON.stringify(verify));
    check('dap02a: validated verify reuses program buffer', verify.ok
      && verify.diagnostics.blockWrites === 0, JSON.stringify(verify));
    const staleReuse = await request('flashAlgorithm', flashAlgorithmParams('verify', 0x08000000, first.length, first, true));
    check('dap02a: page buffer reuse requires an immediately preceding ProgramPage', !staleReuse.ok
      && staleReuse.errorCode === 'DapInvalidRequest', JSON.stringify(staleReuse));
    await request('flashAlgorithm', flashAlgorithmParams('programPage', 0x08000000, first.length, first));
    const wrongAddressReuse = await request('flashAlgorithm', flashAlgorithmParams('verify', 0x08000004, first.length, first, true));
    check('dap02a: page buffer reuse rejects a different Flash address', !wrongAddressReuse.ok
      && wrongAddressReuse.errorCode === 'DapInvalidRequest', JSON.stringify(wrongAddressReuse));
    await request('flashAlgorithm', flashAlgorithmParams('programPage', 0x08000000, first.length, first));
    const wrongSizeReuse = await request('flashAlgorithm', flashAlgorithmParams('verify', 0x08000000, first.length - 1, first, true));
    check('dap02a: page buffer reuse rejects a different size', !wrongSizeReuse.ok
      && wrongSizeReuse.errorCode === 'DapInvalidRequest', JSON.stringify(wrongSizeReuse));
    await request('flashAlgorithm', flashAlgorithmParams('programPage', 0x08000000, first.length, first));
    const wrongDataReuse = await request('flashAlgorithm', flashAlgorithmParams('verify', 0x08000000, first.length, [0x00, 0x01, 0x02, 0x02], true));
    check('dap02a: page buffer reuse rejects different data', !wrongDataReuse.ok
      && wrongDataReuse.errorCode === 'DapInvalidRequest', JSON.stringify(wrongDataReuse));
    await request('flashAlgorithm', flashAlgorithmParams('programPage', 0x08000000, first.length, first));
    const wrongBufferParams = flashAlgorithmParams('verify', 0x08000000, first.length, first, true);
    wrongBufferParams.pageBufferAddress += 4;
    const wrongBufferReuse = await request('flashAlgorithm', wrongBufferParams);
    check('dap02a: page buffer reuse rejects a different RAM address', !wrongBufferReuse.ok
      && wrongBufferReuse.errorCode === 'DapInvalidRequest', JSON.stringify(wrongBufferReuse));
    await request('flashAlgorithm', flashAlgorithmParams('programPage', 0x08000000, first.length, first));
    const wrongAlgorithmParams = flashAlgorithmParams('verify', 0x08000000, first.length, first, true);
    wrongAlgorithmParams.algorithm[0] = 0xBE;
    const wrongAlgorithmReuse = await request('flashAlgorithm', wrongAlgorithmParams);
    check('dap02a: page buffer reuse rejects a different algorithm', !wrongAlgorithmReuse.ok
      && wrongAlgorithmReuse.errorCode === 'DapInvalidRequest', JSON.stringify(wrongAlgorithmReuse));
    await request('flashAlgorithm', flashAlgorithmParams('programPage', 0x08000000, first.length, first));
    const reset = await request('reset', { timeoutMs: 100 });
    check('dap02a: reset invalidation precondition', reset.ok, JSON.stringify(reset));
    const resetReuse = await request('flashAlgorithm', flashAlgorithmParams('verify', 0x08000000, first.length, first, true));
    check('dap02a: reset invalidates page buffer reuse', !resetReuse.ok
      && resetReuse.errorCode === 'DapInvalidRequest', JSON.stringify(resetReuse));
    const haltedAfterReset = await request('halt', { timeoutMs: 100 });
    check('dap02a: halt after reuse invalidation reset', haltedAfterReset.ok, JSON.stringify(haltedAfterReset));
    await request('flashAlgorithm', flashAlgorithmParams('programPage', 0x08000000, first.length, first));
    const oneToOne = await request('flashAlgorithm', flashAlgorithmParams('programPage', 0x08000000, 1, [0xFF]));
    check('dap02a: un-erased program rejected', !oneToOne.ok && oneToOne.errorCode === 'DapAlgorithmError', JSON.stringify(oneToOne));
    const failureReuse = await request('flashAlgorithm', flashAlgorithmParams('verify', 0x08000000, first.length, first, true));
    check('dap02a: algorithm failure invalidates page buffer reuse', !failureReuse.ok
      && failureReuse.errorCode === 'DapInvalidRequest', JSON.stringify(failureReuse));
    const uninit = await request('flashAlgorithm', flashAlgorithmParams('uninit', 0x08000000, 0));
    check('dap02a: algorithm uninit', uninit.ok && uninit.data.returnCode === 0, JSON.stringify(uninit));
  }
  await closeDevice('dap02a-normal');

  async function operationError(pid, name, operation, expectedCode) {
    await openAndInfo('1234', pid, name);
    const connect = await request('connect', { port: 'SWD' });
    check(`${name}: connect`, connect.ok, JSON.stringify(connect));
    if (connect.ok) {
      const halted = await request('halt', { timeoutMs: 100 });
      check(`${name}: halt before algorithm`, halted.ok, JSON.stringify(halted));
      if (!halted.ok) {
        await closeDevice(name);
        return;
      }
      const result = await request('flashAlgorithm', flashAlgorithmParams(operation, 0x08000000, operation === 'verify' ? 4 : 0, operation === 'verify' ? [0, 1, 2, 3] : []));
      check(`${name}: structured ${expectedCode}`, !result.ok && result.errorCode === expectedCode, JSON.stringify(result));
    }
    await closeDevice(name);
  }

  await operationError('5687', 'dap02a-busy', 'eraseSector', 'DapAlgorithmTimeout');
  await operationError('5688', 'dap02a-protected', 'eraseSector', 'FlashProtectionError');
  await operationError('568A', 'dap02a-device-removed', 'eraseSector', 'DeviceRemoved');

  await openAndInfo('1234', '5689', 'dap02a-corrupt');
  const corruptConnect = await request('connect', { port: 'SWD' });
  if (corruptConnect.ok) {
    const corruptHalt = await request('halt', { timeoutMs: 100 });
    check('dap02a-corrupt: halt before algorithm', corruptHalt.ok, JSON.stringify(corruptHalt));
    if (!corruptHalt.ok) {
      await closeDevice('dap02a-corrupt');
      return;
    }
    await request('flashAlgorithm', flashAlgorithmParams('eraseSector', 0x08000000, 0x4000));
    await request('flashAlgorithm', flashAlgorithmParams('programPage', 0x08000000, 4, [0, 1, 2, 3]));
    const corruptVerify = await request('flashAlgorithm', flashAlgorithmParams('verify', 0x08000000, 4, [0, 1, 2, 3]));
    check('dap02a-corrupt: verify corruption', !corruptVerify.ok && corruptVerify.errorCode === 'VerifyFailed', JSON.stringify(corruptVerify));
  }
  await closeDevice('dap02a-corrupt');
}

// Opens, connects, runs `fn`, then closes an error-injection device.
async function dap03Device(vidValue, pidValue, name, fn) {
  await openAndInfo(vidValue, pidValue, name);
  const connect = await request('connect', { port: 'SWD' });
  check(`${name}: connect`, connect.ok, JSON.stringify(connect));
  if (connect.ok) await fn(name);
  await closeDevice(name);
}

// DAP-03: SW-DP / MEM-AP registers and Cortex-M 32-bit memory reads against
// the mock SWD target. Covers IDCODE, CTRL/STAT, SELECT, ABORT, CSW/TAR/DRW,
// 1-byte/4-byte reads, 1 KiB boundary reads, packet-crossing reads, WAIT
// retries, FAULT clearing, NO_ACK, malformed responses, device loss and the
// not-connected guard.
async function runDap03Matrix() {
  // --- normal device: DP/AP register surface ---
  await openAndInfo('1234', '5678', 'dap03');
  const connect = await request('connect', { port: 'SWD' });
  check('dap03: connect', connect.ok, JSON.stringify(connect));
  if (connect.ok) {
    const idcode = await request('dpRead', { reg: 0 });
    check('dap03: DP IDCODE', idcode.ok && idcode.data.value === 0x2BA01477, JSON.stringify(idcode));
    const ctrlStat = await request('dpRead', { reg: 4 });
    check('dap03: DP CTRL/STAT initial', ctrlStat.ok && ctrlStat.data.value === 0,
      JSON.stringify(ctrlStat));
    const selectWrite = await request('dpWrite', { reg: 8, value: 0x01000000 });
    check('dap03: DP SELECT write', selectWrite.ok, JSON.stringify(selectWrite));
    const selectRead = await request('dpRead', { reg: 8 });
    check('dap03: DP SELECT read back', selectRead.ok && selectRead.data.value === 0x01000000,
      JSON.stringify(selectRead));
    await request('dpWrite', { reg: 8, value: 0 });
    const abort = await request('dpWrite', { reg: 0, value: 0x1E });
    check('dap03: DP ABORT write', abort.ok, JSON.stringify(abort));

    const csw = await request('apWrite', { addr: 0, value: 0x12 });
    check('dap03: AP CSW write', csw.ok, JSON.stringify(csw));
    const tar = await request('apWrite', { addr: 4, value: 0x20000000 });
    check('dap03: AP TAR write', tar.ok, JSON.stringify(tar));
    const tarRead = await request('apRead', { addr: 4 });
    check('dap03: AP TAR read via RDBUFF', tarRead.ok && tarRead.data.value === 0x20000000,
      JSON.stringify(tarRead));

    // --- Cortex-M memory reads ---
    const memWord = await request('readMemory', { address: 0x20000000, size: 4 });
    check('dap03: readMemory 4 bytes', memWord.ok && memWord.data.size === 4
      && bytesMatchPattern(memWord.data.bytes, 0x20000000), JSON.stringify(memWord));
    const memByte = await request('readMemory', { address: 0x20000003, size: 1 });
    check('dap03: readMemory 1 unaligned byte', memByte.ok && memByte.data.bytes.length === 1
      && memByte.data.bytes[0] === mockByteAt(0x20000003), JSON.stringify(memByte));
    const crossBoundary = await request('readMemory', { address: 0x20000FFC, size: 8 });
    check('dap03: readMemory crosses 1KB boundary', crossBoundary.ok
      && crossBoundary.data.bytes.length === 8
      && crossBoundary.diagnostics.chunks === 2
      && bytesMatchPattern(crossBoundary.data.bytes, 0x20000FFC), JSON.stringify(crossBoundary));
    const crossPacket = await request('readMemory', { address: 0x20000000, size: 512 });
    check('dap03: readMemory crosses packet boundary', crossPacket.ok
      && crossPacket.data.bytes.length === 512
      && crossPacket.diagnostics.chunks === 9
      && crossPacket.diagnostics.blockReads === 9
      && crossPacket.diagnostics.packets === 18
      && bytesMatchPattern(crossPacket.data.bytes, 0x20000000), JSON.stringify({
        ok: crossPacket.ok,
        size: crossPacket.data && crossPacket.data.size,
        chunks: crossPacket.data && crossPacket.data.diagnostics && crossPacket.diagnostics.chunks,
        bytes: crossPacket.data && crossPacket.data.bytes,
      }));
    const block = await request('readMemoryBlock', { address: 0x20000100, wordCount: 16 });
    check('dap03: readMemoryBlock 16 words', block.ok && block.data.words.length === 16
      && block.diagnostics.blockReads === 1
      && wordsMatchPattern(block.data.words, 0x20000100), JSON.stringify(block));
    const unmapped = await request('readMemory', { address: 0x30000000, size: 4 });
    check('dap03: unmapped memory reads zero', unmapped.ok
      && unmapped.data.bytes.length === 4
      && unmapped.data.bytes.every(byte => byte === 0), JSON.stringify(unmapped));

    const badSize = await request('readMemory', { address: 0x20000000, size: 0 });
    check('dap03: readMemory size 0 rejected', !badSize.ok
      && badSize.errorCode === 'DapInvalidRequest', JSON.stringify(badSize));
    const badBlock = await request('readMemoryBlock', { address: 0x20000001, wordCount: 4 });
    check('dap03: readMemoryBlock unaligned rejected', !badBlock.ok
      && badBlock.errorCode === 'DapInvalidRequest', JSON.stringify(badBlock));

    const disconnected = await request('disconnect', {});
    check('dap03: disconnect', disconnected.ok, JSON.stringify(disconnected));
    const afterDisconnect = await request('readMemory', { address: 0x20000000, size: 4 });
    check('dap03: readMemory after disconnect is InvalidState', !afterDisconnect.ok
      && afterDisconnect.errorCode === 'InvalidState', JSON.stringify(afterDisconnect));
    await request('connect', { port: 'SWD' });
  }
  await closeDevice('dap03');

  // --- wait-once: bounded WAIT retry with recorded retry count ---
  await dap03Device('1234', '567F', 'dap03-wait-once', async name => {
    const read = await request('readMemory', { address: 0x20000000, size: 4 });
    check(`${name}: readMemory recovers after WAIT`, read.ok
      && bytesMatchPattern(read.data.bytes, 0x20000000), JSON.stringify(read));
    check(`${name}: WAIT retry count recorded`, read.ok
      && read.diagnostics.waitRetries === 2,
      JSON.stringify({ waitRetries: read.data && read.data.diagnostics && read.diagnostics.waitRetries }));
  });

  // --- fault-once: FAULT must be cleared via DP ABORT before retry ---
  await dap03Device('1234', '5680', 'dap03-fault-once', async name => {
    const read = await request('readMemory', { address: 0x20000000, size: 4 });
    check(`${name}: readMemory recovers after FAULT`, read.ok
      && bytesMatchPattern(read.data.bytes, 0x20000000), JSON.stringify(read));
    check(`${name}: FAULT clears recorded`, read.ok
      && read.diagnostics.faultClears >= 1,
      JSON.stringify({ faultClears: read.data && read.data.diagnostics && read.diagnostics.faultClears }));
    const ctrlStat = await request('dpRead', { reg: 4 });
    check(`${name}: STICKYERR cleared by ABORT`, ctrlStat.ok
      && (ctrlStat.data.value & 0x10) === 0, JSON.stringify(ctrlStat));
  });

  // --- no-ack: protocol break fails immediately ---
  await dap03Device('1234', '5681', 'dap03-no-ack', async name => {
    const read = await request('readMemory', { address: 0x20000000, size: 4 });
    check(`${name}: NO_ACK direct failure`, !read.ok && read.errorCode === 'DapAckNoAck',
      JSON.stringify(read));
  });

  // --- malformed: inconsistent transfer count is rejected, no retry ---
  await dap03Device('1234', '5682', 'dap03-malformed', async name => {
    const read = await request('readMemory', { address: 0x20000000, size: 4 });
    check(`${name}: malformed response rejected`, !read.ok
      && read.errorCode === 'MalformedResponse', JSON.stringify(read));
  });

  // --- busy: WAIT retry budget exhausted with recorded count ---
  await dap03Device('1234', '5683', 'dap03-busy', async name => {
    const read = await request('readMemory', { address: 0x20000000, size: 4 });
    check(`${name}: WAIT budget exhausted`, !read.ok && read.errorCode === 'DapAckWait',
      JSON.stringify(read));
    check(`${name}: retry budget recorded`, read.ok === false
      && read.data && read.diagnostics && read.diagnostics.waitRetries === 8,
      JSON.stringify({ waitRetries: read.data && read.diagnostics && read.diagnostics.waitRetries }));
  });

  // --- write-unknown: reads still work; the write policy is asserted by the
  // helper self-test (a malformed block-write reply is never retried) ---
  await dap03Device('1234', '5684', 'dap03-write-unknown', async name => {
    const read = await request('readMemory', { address: 0x20000000, size: 4 });
    check(`${name}: reads work on write-unknown device`, read.ok, JSON.stringify(read));
  });

  // --- removal: device lost mid-transfer stays lost ---
  await dap03Device('1234', '5685', 'dap03-removal', async name => {
    const first = await request('readMemory', { address: 0x20000000, size: 4 });
    check(`${name}: DeviceRemoved during transfer`, !first.ok
      && first.errorCode === 'DeviceRemoved', JSON.stringify(first));
    const second = await request('readMemory', { address: 0x20000000, size: 4 });
    check(`${name}: stays DeviceRemoved`, !second.ok && second.errorCode === 'DeviceRemoved',
      JSON.stringify(second));
  });
}

// DAP-04: Cortex-M CoreDebug control and register access through the same
// CMSIS-DAP owner used by the DAP-03 memory pipeline.
async function runDap04Matrix() {
  await openAndInfo('1234', '5678', 'dap04');
  const connect = await request('connect', { port: 'SWD' });
  check('dap04: connect', connect.ok, JSON.stringify(connect));
  if (!connect.ok) return;

  const initial = await request('getState', { timeoutMs: 100 });
  check('dap04: initial running state', initial.ok && initial.data.state === 'Running'
    && initial.targetState === 'Running', JSON.stringify(initial));
  const powerState = await request('dpRead', { reg: 4 });
  check('dap04: control initializes debug power', powerState.ok
    && ((powerState.data.value & 0xA0000000) >>> 0) === 0xA0000000, JSON.stringify(powerState));
  const halted = await request('halt', { timeoutMs: 100 });
  check('dap04: halt confirmed', halted.ok && halted.data.state === 'Halted'
    && halted.data.pc === 0x080001C0, JSON.stringify(halted));
  check('dap04: halt DHCSR diagnostics', halted.ok
    && halted.diagnostics && halted.diagnostics.dhcsrWrite === 0xA05F0003,
  JSON.stringify(halted));

  const r0 = await request('readRegister', { index: 0, timeoutMs: 100 });
  check('dap04: read R0', r0.ok && r0.data.value === 0x10000000, JSON.stringify(r0));
  const sp = await request('readRegister', { index: 13, timeoutMs: 100 });
  check('dap04: read SP', sp.ok && sp.data.value === 0x20001000, JSON.stringify(sp));
  const pc = await request('readRegister', { index: 15, timeoutMs: 100 });
  check('dap04: read PC', pc.ok && pc.data.value === halted.data.pc, JSON.stringify(pc));
  const xpsr = await request('readRegister', { index: 16, timeoutMs: 100 });
  check('dap04: read xPSR', xpsr.ok && xpsr.data.value === 0x01000000, JSON.stringify(xpsr));
  const invalid = await request('readRegister', { index: 17, timeoutMs: 100 });
  check('dap04: invalid register', !invalid.ok && invalid.errorCode === 'DapInvalidRequest',
    JSON.stringify(invalid));

  const stepped = await request('stepInstruction', { timeoutMs: 100 });
  check('dap04: step confirms halted and changes PC', stepped.ok
    && stepped.data.state === 'Halted'
    && stepped.data.pcAfter !== stepped.data.pcBefore, JSON.stringify(stepped));
  const running = await request('run', { timeoutMs: 100 });
  check('dap04: run confirmed', running.ok && running.data.state === 'Running',
    JSON.stringify(running));
  const haltBeforeReset = await request('halt', { timeoutMs: 100 });
  check('dap04: halt before reset', haltBeforeReset.ok, JSON.stringify(haltBeforeReset));
  const reset = await request('reset', { timeoutMs: 100 });
  check('dap04: reset confirmed from current owner', reset.ok
    && reset.data.state === 'Halted' && reset.data.pc === 0x080001C0, JSON.stringify(reset));

  const disconnect = await request('disconnect', {});
  check('dap04: disconnect', disconnect.ok, JSON.stringify(disconnect));
  const afterDisconnect = await request('getState', { timeoutMs: 100 });
  check('dap04: getState after disconnect is InvalidState', !afterDisconnect.ok
    && afterDisconnect.errorCode === 'InvalidState', JSON.stringify(afterDisconnect));
  await closeDevice('dap04');
}

async function runDap05Matrix() {
  const goldenFpCtrl = 0x00000260;
  const goldenCapabilities = {
    revision: 1,
    codeComparators: 6,
    literalComparators: 2,
    enabled: false,
  };
  check('dap05: FP_CTRL 0x260 hard-coded golden decode',
    JSON.stringify(fpbOracle.decodeFpCtrl(goldenFpCtrl)) === JSON.stringify(goldenCapabilities),
    JSON.stringify(fpbOracle.decodeFpCtrl(goldenFpCtrl)));
  check('dap05: FP_CTRL 0x260 hard-coded golden encode',
    fpbOracle.makeFpCtrl(goldenCapabilities) === goldenFpCtrl,
    `actual=0x${fpbOracle.makeFpCtrl(goldenCapabilities).toString(16)}`);
  check('dap05: legacy NUM_LIT shift=7 fails the golden',
    ((goldenFpCtrl >>> 7) & 0x0F) !== goldenCapabilities.literalComparators,
    `legacyDecoded=${(goldenFpCtrl >>> 7) & 0x0F}`);

  await openAndInfo('1234', '5678', 'dap05');
  const connect = await request('connect', { port: 'SWD' });
  check('dap05: connect', connect.ok, JSON.stringify(connect));
  if (!connect.ok) return;

  const halted = await request('halt', { timeoutMs: 100 });
  check('dap05: halt', halted.ok, JSON.stringify(halted));

  const expectedCtrl = goldenFpCtrl;
  const fpb = await request('getFpbInfo', { timeoutMs: 100 });
  check('dap05: FPB capability probe', fpb.ok
    && fpb.data.revision === 1
    && fpb.data.codeComparators === 6
    && fpb.data.fpCtrl === expectedCtrl
    && fpb.targetState === 'Halted', JSON.stringify(fpb));
  check('dap05: independent FP_CTRL decode', fpb.ok
    && JSON.stringify(fpbOracle.decodeFpCtrl(fpb.data.fpCtrl))
      === JSON.stringify({ revision: 1, codeComparators: 6, literalComparators: 2, enabled: false }),
  JSON.stringify(fpb));

  const addresses = [0x080001C0, 0x080001C2, 0x080001C4, 0x080001C6, 0x080001C8, 0x080001CA];
  const slots = [];
  for (const address of addresses) {
    const set = await request('setBreakpoint', { address, timeoutMs: 100 });
    slots.push(set);
    check(`dap05: set slot ${slots.length - 1}`, set.ok
      && set.data.slot === slots.length - 1
      && set.data.address === address
      && set.data.fpbRevision === 1
      && set.data.comparatorReadback === fpbOracle.encodeComparator(1, address), JSON.stringify(set));
  }
  const duplicate = await request('setBreakpoint', { address: addresses[2], timeoutMs: 100 });
  check('dap05: duplicate preserves slot', duplicate.ok
    && duplicate.data.slot === 2 && duplicate.data.duplicate === true, JSON.stringify(duplicate));
  const exhausted = await request('setBreakpoint', { address: 0x080001CC, timeoutMs: 100 });
  check('dap05: slot exhaustion is structured', !exhausted.ok
    && exhausted.errorCode === 'BreakpointResourceExhausted', JSON.stringify(exhausted));
  const cleared = await request('clearBreakpoint', { slot: 2, timeoutMs: 100 });
  check('dap05: clear verifies comparator zero', cleared.ok
    && cleared.data.slot === 2 && cleared.data.comparatorReadback === 0, JSON.stringify(cleared));
  const resetSlot = await request('setBreakpoint', { address: 0x080001CC, preferredSlot: 2, timeoutMs: 100 });
  check('dap05: cleared slot is reused exactly', resetSlot.ok
    && resetSlot.data.slot === 2 && resetSlot.data.address === 0x080001CC, JSON.stringify(resetSlot));
  const invalid = await request('setBreakpoint', { address: 0x20000000, timeoutMs: 100 });
  check('dap05: FPBv1 range validation', !invalid.ok
    && invalid.errorCode === 'InvalidBreakpointAddress', JSON.stringify(invalid));
  const clearedAll = await request('clearAllBreakpoints', { timeoutMs: 100 });
  check('dap05: clear-all disables FPB', clearedAll.ok
    && clearedAll.data.cleared === 6 && clearedAll.data.enabled === false, JSON.stringify(clearedAll));

  const fastBefore = await request('readRegister', { index: 15, timeoutMs: 100 });
  const fastAddress = fastBefore.ok ? (fastBefore.data.value + 4) >>> 0 : 0;
  const fastBreakpoint = await request('setBreakpoint', {
    address: fastAddress, preferredSlot: 0, timeoutMs: 100,
  });
  const fastRun = await request('run', { timeoutMs: 100 });
  check('dap05: run accepts a breakpoint hit before Running is observed',
    fastBefore.ok && fastBreakpoint.ok && fastRun.ok
      && fastRun.targetState === 'Halted'
      && fastRun.data.state === 'Halted'
      && fastRun.data.pc === fastAddress
      && fastRun.data.breakpointHitBeforeRunningObserved === true,
    JSON.stringify({ fastBefore, fastBreakpoint, fastRun }));
  await request('clearAllBreakpoints', { timeoutMs: 100 });

  let currentPcContinueRoundsOk = true;
  let instructionBreakpointRoundsOk = true;
  for (let round = 0; round < 20; round++) {
    const resetRound = await request('reset', { timeoutMs: 100 });
    const currentRound = await request('setBreakpoint', {
      address: 0x080001C0, preferredSlot: 0, timeoutMs: 100,
    });
    const runRound = await request('run', { timeoutMs: 100 });
    currentPcContinueRoundsOk = currentPcContinueRoundsOk
      && resetRound.ok && currentRound.ok && currentRound.data.slot === 0
      && runRound.ok && runRound.data.pcBefore === 0x080001C0
      && runRound.data.pcAfterStep !== 0x080001C0
      && runRound.data.restoredSlots.includes(0);
    await request('halt', { timeoutMs: 100 });
    const clearRound = await request('clearBreakpoint', { slot: 0, timeoutMs: 100 });
    currentPcContinueRoundsOk = currentPcContinueRoundsOk
      && clearRound.ok && clearRound.data.comparatorReadback === 0;

    await request('reset', { timeoutMs: 100 });
    const instructionBp = await request('setBreakpoint', {
      address: 0x080001C0, preferredSlot: 0, timeoutMs: 100,
    });
    const instructionRound = await request('stepInstruction', { timeoutMs: 100 });
    instructionBreakpointRoundsOk = instructionBreakpointRoundsOk
      && instructionBp.ok && instructionRound.ok
      && instructionRound.data.pcBefore === 0x080001C0
      && instructionRound.data.pcAfter !== 0x080001C0
      && instructionRound.data.restoredSlots.includes(0);
    const clearInstructionBp = await request('clearBreakpoint', { slot: 0, timeoutMs: 100 });
    instructionBreakpointRoundsOk = instructionBreakpointRoundsOk && clearInstructionBp.ok;
  }
  check('dap05: current-PC continue 20 rounds', currentPcContinueRoundsOk);
  check('dap05: instruction step restores user breakpoint 20 rounds', instructionBreakpointRoundsOk);

  const reset = await request('reset', { timeoutMs: 100 });
  check('dap05: reset before current-PC continue', reset.ok, JSON.stringify(reset));
  const current = await request('setBreakpoint', { address: 0x080001C0, timeoutMs: 100 });
  check('dap05: current-PC breakpoint set', current.ok, JSON.stringify(current));
  const continued = await request('run', { timeoutMs: 100 });
  check('dap05: current-PC continue steps over and restores user slot', continued.ok
    && continued.data.state === 'Running'
    && continued.data.pcBefore === 0x080001C0
    && continued.data.pcAfterStep !== 0x080001C0
    && continued.data.restoredSlots.includes(current.data.slot), JSON.stringify(continued));
  await request('halt', { timeoutMs: 100 });
  await request('clearAllBreakpoints', { timeoutMs: 100 });

  await request('reset', { timeoutMs: 100 });
  const stepOver = await request('stepOverSourceLine', {
    lineStart: 0x080001C0, lineEnd: 0x080001C6, maxInstructionSteps: 16, timeoutMs: 100,
  });
  check('dap05: source step over call', stepOver.ok
    && stepOver.data.pcBefore === 0x080001C0
    && stepOver.data.pcAfter === 0x080001C6
    && stepOver.data.cleanupOk === true, JSON.stringify(stepOver));

  await request('reset', { timeoutMs: 100 });
  const stepInto = await request('stepIntoSourceLine', {
    lineStart: 0x080001C0, lineEnd: 0x080001C6, maxInstructionSteps: 16, timeoutMs: 100,
  });
  check('dap05: source step into enters call', stepInto.ok
    && stepInto.data.classification === 'call'
    && stepInto.data.pcAfter === 0x080001E0, JSON.stringify(stepInto));
  const stepOut = await request('stepOut', {
    functionStart: 0x080001E0, functionEnd: 0x08000200, timeoutMs: 100,
  });
  check('dap05: source step out returns through temporary FPB', stepOut.ok
    && stepOut.data.pcBefore === 0x080001E0
    && stepOut.data.pcAfter === 0x080001C6
    && stepOut.data.cleanupOk === true, JSON.stringify(stepOut));

  const toConditional = await request('stepInstruction', { timeoutMs: 100 });
  const conditional = await request('stepOverSourceLine', {
    lineStart: 0x080001C8, lineEnd: 0x080001CA, maxInstructionSteps: 4, timeoutMs: 100,
  });
  check('dap05: conditional branch source step', toConditional.ok
    && toConditional.data.pcAfter === 0x080001C8
    && conditional.ok
    && conditional.data.classification === 'branchSingleStep'
    && conditional.data.pcAfter === 0x080001CA, JSON.stringify(conditional));
  const loop = await request('stepOverSourceLine', {
    lineStart: 0x080001CA, lineEnd: 0x080001CC, maxInstructionSteps: 3, timeoutMs: 100,
  });
  check('dap05: loop remains bounded with structured error', !loop.ok
    && loop.errorCode === 'SourceLineStepLimitExceeded'
    && loop.diagnostics.step.cleanupOk === true, JSON.stringify(loop));

  let sourceStepRoundsOk = true;
  for (let round = 0; round < 20; round++) {
    await request('clearAllBreakpoints', { timeoutMs: 100 });
    await request('reset', { timeoutMs: 100 });
    const startBreakpoint = await request('setBreakpoint', {
      address: 0x080001C0, preferredSlot: 0, timeoutMs: 100,
    });
    const over = await request('stepOverSourceLine', {
      lineStart: 0x080001C0, lineEnd: 0x080001C6, maxInstructionSteps: 16, timeoutMs: 100,
    });
    sourceStepRoundsOk = sourceStepRoundsOk && startBreakpoint.ok && over.ok
      && over.data.pcAfter === 0x080001C6 && over.data.cleanupOk
      && over.data.restoredSlots.includes(0);
    await request('clearAllBreakpoints', { timeoutMs: 100 });
    await request('reset', { timeoutMs: 100 });
    const intoStartBreakpoint = await request('setBreakpoint', {
      address: 0x080001C0, preferredSlot: 0, timeoutMs: 100,
    });
    const into = await request('stepIntoSourceLine', {
      lineStart: 0x080001C0, lineEnd: 0x080001C6, maxInstructionSteps: 16, timeoutMs: 100,
    });
    const outStartBreakpoint = into.ok ? await request('setBreakpoint', {
      address: 0x080001E0, preferredSlot: 1, timeoutMs: 100,
    }) : { ok: false };
    const out = into.ok && outStartBreakpoint.ok ? await request('stepOut', {
      functionStart: 0x080001E0, functionEnd: 0x08000200, timeoutMs: 100,
    }) : { ok: false };
    sourceStepRoundsOk = sourceStepRoundsOk
      && intoStartBreakpoint.ok && into.ok && into.data.pcAfter === 0x080001E0
      && into.data.restoredSlots.includes(0)
      && outStartBreakpoint.ok && out.ok && out.data.pcAfter === 0x080001C6
      && out.data.cleanupOk && out.data.restoredSlots.includes(1);
  }
  check('dap05: source Step Over/Into/Out 20 rounds', sourceStepRoundsOk);

  await request('clearAllBreakpoints', { timeoutMs: 100 });
  const fpbAfterTemporarySteps = await request('getFpbInfo', { timeoutMs: 100 });
  check('dap05: temporary breakpoint cleanup disables unused FPB', fpbAfterTemporarySteps.ok
    && fpbAfterTemporarySteps.data.enabled === false, JSON.stringify(fpbAfterTemporarySteps));

  const disconnect = await request('disconnect', {});
  check('dap05: disconnect cleanup', disconnect.ok, JSON.stringify(disconnect));
  await closeDevice('dap05');
}

async function runDap06StartupStopMatrix() {
  await openAndInfo('1234', '5678', 'dap06-startup');
  const connect = await request('connect', { port: 'SWD' });
  check('dap06: connect', connect.ok, JSON.stringify(connect));
  if (!connect.ok) return;
  await request('halt', { timeoutMs: 100 });

  const user = await request('setBreakpoint', {
    address: 0x080001C8, preferredSlot: 0, timeoutMs: 100,
  });
  const startup = await request('runToAddress', {
    address: 0x080001E0, reset: true, timeoutMs: 100,
  });
  check('dap06: reset runs through an earlier user breakpoint to the startup entry',
    user.ok && startup.ok
      && startup.targetState === 'Halted'
      && startup.data.state === 'Halted'
      && startup.data.entryAddress === 0x080001E0
      && startup.data.pc === 0x080001E0
      && startup.data.resetPc === 0x080001C0
      && startup.data.cleanupOk === true
      && startup.data.temporarySlot === 1,
    JSON.stringify({ user, startup }));
  const preservedUser = await request('setBreakpoint', {
    address: 0x080001C8, timeoutMs: 100,
  });
  const reusedTemporary = await request('setBreakpoint', {
    address: 0x080001E2, preferredSlot: 1, timeoutMs: 100,
  });
  check('dap06: startup cleanup preserves users and releases its temporary comparator',
    preservedUser.ok && preservedUser.data.duplicate === true && preservedUser.data.slot === 0
      && reusedTemporary.ok && reusedTemporary.data.slot === 1,
    JSON.stringify({ preservedUser, reusedTemporary }));
  await request('clearAllBreakpoints', { timeoutMs: 100 });

  const occupied = [];
  for (const address of [0x080001C0, 0x080001C2, 0x080001C4, 0x080001C6, 0x080001C8, 0x080001CA]) {
    occupied.push(await request('setBreakpoint', { address, timeoutMs: 100 }));
  }
  const exhausted = await request('runToAddress', {
    address: 0x080001E0, reset: true, timeoutMs: 100,
  });
  const stateAfterExhaustion = await request('getState', { timeoutMs: 100 });
  const preservedAfterExhaustion = await request('setBreakpoint', {
    address: 0x080001C8, timeoutMs: 100,
  });
  check('dap06: comparator exhaustion does not run or discard user breakpoints',
    occupied.every(result => result.ok)
      && !exhausted.ok && exhausted.errorCode === 'BreakpointResourceExhausted'
      && stateAfterExhaustion.ok && stateAfterExhaustion.data.state === 'Halted'
      && preservedAfterExhaustion.ok && preservedAfterExhaustion.data.duplicate === true,
    JSON.stringify({ exhausted, stateAfterExhaustion, preservedAfterExhaustion }));

  await request('clearAllBreakpoints', { timeoutMs: 100 });
  await request('disconnect', {});
  await closeDevice('dap06-startup');

  await openAndInfo('1234', '568F', 'dap06-reset-race');
  const raceConnect = await request('connect', { port: 'SWD' });
  check('dap06-reset-race: connect', raceConnect.ok, JSON.stringify(raceConnect));
  if (!raceConnect.ok) return;
  await request('halt', { timeoutMs: 100 });
  const raceUser = await request('setBreakpoint', {
    address: 0x080001C8, preferredSlot: 0, timeoutMs: 100,
  });
  const raceStartup = await request('runToAddress', {
    address: 0x080001E0, reset: true, timeoutMs: 100,
  });
  const racePreservedUser = await request('setBreakpoint', {
    address: 0x080001C8, timeoutMs: 100,
  });
  const raceReusedTemporary = await request('setBreakpoint', {
    address: 0x080001E2, preferredSlot: 1, timeoutMs: 100,
  });
  check('dap06: pre-arms startup comparator before a reset can pass the entry',
    raceUser.ok && raceStartup.ok
      && raceStartup.targetState === 'Halted'
      && raceStartup.data.pc === 0x080001E0
      && raceStartup.data.cleanupOk === true
      && raceStartup.data.temporarySlot === 1
      && racePreservedUser.ok && racePreservedUser.data.duplicate === true
      && racePreservedUser.data.slot === 0
      && raceReusedTemporary.ok && raceReusedTemporary.data.slot === 1,
    JSON.stringify({ raceUser, raceStartup, racePreservedUser, raceReusedTemporary }));
  await request('clearAllBreakpoints', { timeoutMs: 100 });
  await request('disconnect', {});
  await closeDevice('dap06-reset-race');
}

async function runDap06StartupTimeoutMatrix() {
  await openAndInfo('1234', '568C', 'dap06-startup-timeout');
  const connect = await request('connect', { port: 'SWD' });
  check('dap06-timeout: connect', connect.ok, JSON.stringify(connect));
  if (!connect.ok) return;
  await request('halt', { timeoutMs: 100 });
  const user = await request('setBreakpoint', {
    address: 0x080001C8, preferredSlot: 0, timeoutMs: 100,
  });
  const timedOut = await request('runToAddress', {
    address: 0x080001E0, reset: true, timeoutMs: 10,
  });
  const state = await request('getState', { timeoutMs: 100 });
  const reusedTemporary = await request('setBreakpoint', {
    address: 0x080001E2, preferredSlot: 1, timeoutMs: 100,
  });
  check('dap06-timeout: timeout halts and cleans the temporary comparator',
    user.ok && !timedOut.ok && timedOut.errorCode === 'StartupStopTimeout'
      && timedOut.diagnostics.startup.cleanupOk === true
      && state.ok && state.data.state === 'Halted'
      && reusedTemporary.ok && reusedTemporary.data.slot === 1,
    JSON.stringify({ timedOut, state, reusedTemporary }));
  await request('clearAllBreakpoints', { timeoutMs: 100 });
  await request('disconnect', {});
  await closeDevice('dap06-startup-timeout');
}

async function runDap05CleanupMatrix() {
  await openAndInfo('1234', '568C', 'dap05-cleanup');
  const connect = await request('connect', { port: 'SWD' });
  check('dap05-cleanup: connect', connect.ok, JSON.stringify(connect));
  if (!connect.ok) return;
  await request('halt', { timeoutMs: 100 });
  await request('getFpbInfo', { timeoutMs: 100 });
  const user = await request('setBreakpoint', {
    address: 0x080001C0, preferredSlot: 0, timeoutMs: 100,
  });
  const timedOut = await request('stepOverSourceLine', {
    lineStart: 0x080001C0, lineEnd: 0x080001C6, maxInstructionSteps: 16, timeoutMs: 10,
  });
  check('dap05-cleanup: timeout restores user and clears temporary slot', user.ok
    && !timedOut.ok && timedOut.errorCode === 'StepTimeout'
    && timedOut.diagnostics.step.cleanupOk === true
    && timedOut.diagnostics.step.temporaryBreakpointCount === 1, JSON.stringify(timedOut));
  const duplicate = await request('setBreakpoint', { address: 0x080001C0, timeoutMs: 100 });
  const reusedTemporarySlot = await request('setBreakpoint', {
    address: 0x080001C2, preferredSlot: 1, timeoutMs: 100,
  });
  check('dap05-cleanup: timeout preserves original slot and makes temporary slot reusable',
    duplicate.ok && duplicate.data.duplicate === true && duplicate.data.slot === 0
      && reusedTemporarySlot.ok && reusedTemporarySlot.data.slot === 1,
    JSON.stringify({ duplicate, reusedTemporarySlot }));

  const disconnect = await request('disconnect', {});
  const reconnect = await request('connect', { port: 'SWD' });
  await request('halt', { timeoutMs: 100 });
  const afterReconnect = await request('getFpbInfo', { timeoutMs: 100 });
  check('dap05-cleanup: disconnect clears all FPB comparators', disconnect.ok && reconnect.ok
    && afterReconnect.ok && afterReconnect.data.enabled === false, JSON.stringify(afterReconnect));
  await request('disconnect', {});
  await closeDevice('dap05-cleanup');
}

async function runDap05StepRetireLagMatrix() {
  await openAndInfo('1234', '568D', 'dap05-step-retire-lag');
  const connect = await request('connect', { port: 'SWD' });
  check('dap05-step-retire-lag: connect', connect.ok, JSON.stringify(connect));
  if (!connect.ok) return;
  await request('halt', { timeoutMs: 100 });
  await request('getFpbInfo', { timeoutMs: 100 });
  const user = await request('setBreakpoint', {
    address: 0x080001C0, preferredSlot: 0, timeoutMs: 100,
  });
  // Eight intentionally stale DHCSR reads require a ninth transfer to observe
  // retirement; keep this success oracle above mock pipe/DP-AP round-trip cost.
  const continued = await request('run', { timeoutMs: 250 });
  check('dap05-step-retire-lag: current-PC continue waits for instruction retirement',
    user.ok && continued.ok
      && continued.data.state === 'Running'
      && continued.data.pcBefore === 0x080001C0
      && continued.data.pcAfterStep === 0x080001C2
      && continued.data.restoredSlots.includes(0),
    JSON.stringify(continued));
  await request('disconnect', {});
  await closeDevice('dap05-step-retire-lag');
}

async function runDap05InterruptMaskedStepMatrix() {
  await openAndInfo('1234', '568E', 'dap05-step-interrupt');
  const connect = await request('connect', { port: 'SWD' });
  check('dap05-step-interrupt: connect', connect.ok, JSON.stringify(connect));
  if (!connect.ok) return;
  await request('halt', { timeoutMs: 100 });
  await request('getFpbInfo', { timeoutMs: 100 });
  const user = await request('setBreakpoint', {
    address: 0x080001C0, preferredSlot: 0, timeoutMs: 100,
  });
  const continued = await request('run', { timeoutMs: 100 });
  check('dap05-step-interrupt: current-PC continue masks interrupts during C_STEP',
    user.ok && continued.ok
      && continued.data.state === 'Running'
      && continued.data.pcBefore === 0x080001C0
      && continued.data.pcAfterStep === 0x080001C2
      && continued.data.interruptMaskApplied === true
      && continued.data.interruptMaskCleared === true
      && continued.data.restoredSlots.includes(0),
    JSON.stringify(continued));
  await request('disconnect', {});
  await closeDevice('dap05-step-interrupt');
}

async function runHardwareHandshake() {
  console.log('hardware: low-risk handshake only (enumerate/open/getInfo/connect(SWD)/disconnect/close)');
  console.log(`hardware: helper pid=${child.pid ?? 'unknown'}`);
  const hello = await request('hello', { clientProtocol: 1, extensionVersion: 'cmsis-dap-smoke' });
  check('hello', hello.ok && hello.data.protocol === 1, JSON.stringify(hello));

  const selector = { transport: 'hid' };
  if (vid) selector.vid = vid;
  if (pid) selector.pid = pid;
  if (serial) selector.serial = serial;
  const devices = await request('enumDevices', selector);
  check('enumDevices: hid', devices.ok, JSON.stringify(devices));
  if (!devices.ok) return;
  console.log(`hardware: found ${devices.data.devices.length} device(s)`);
  for (const device of devices.data.devices) {
    console.log(`hardware: device vid=${device.vid} pid=${device.pid} product=${device.product}`
      + ` serial=${device.serial} inputReportLength=${device.inputReportLength}`
      + ` outputReportLength=${device.outputReportLength} reportId=${device.reportId}`);
  }
  if (devices.data.devices.length === 0) {
    check('hardware: no matching device', false, 'no CMSIS-DAP HID device matched the selector');
    return;
  }
  const open = await request('open', selector);
  check('hardware: open', open.ok, JSON.stringify(open));
  if (!open.ok) return;
  // Some low-cost v1 firmware only answers DAP_Info after DAP_Connect; try the
  // connect handshake first, then read DAP_Info.
  const connect = await request('connect', { port: 'SWD', timeoutMs: 2000 });
  check('hardware: DAP_Connect(SWD)', connect.ok, JSON.stringify(connect));
  const info = await request('getInfo', { timeoutMs: 2000 });
  check('hardware: DAP_Info', info.ok, JSON.stringify(info));
  if (info.ok) {
    console.log(`hardware: protocolVersion=${info.data.protocolVersion}`
      + ` packetSize=${info.data.packetSize} protocolPacketSize=${info.data.protocolPacketSize}`
      + ` packetSizeSource=${info.data.packetSizeSource}`
      + ` effectivePacketSize=${info.data.effectivePacketSize}`);
  }
  const disconnect = await request('disconnect', {});
  check('hardware: DAP_Disconnect', disconnect.ok, JSON.stringify(disconnect));
  const closed = await request('close', {});
  check('hardware: close', closed.ok, JSON.stringify(closed));
}

async function main() {
  try {
    if (useMock) {
    await runMockMatrix();
    await runDap03Matrix();
    await runDap02AMatrix();
      await runDap04Matrix();
      await runDap05Matrix();
      await runDap05CleanupMatrix();
      await runDap05StepRetireLagMatrix();
      await runDap05InterruptMaskedStepMatrix();
      await runDap06StartupStopMatrix();
      await runDap06StartupTimeoutMatrix();
    } else {
      await runHardwareHandshake();
    }
    const shutdown = await request('shutdown', {});
    check('shutdown', shutdown.ok, JSON.stringify(shutdown));
  } finally {
    child.kill();
  }
  if (failures > 0) {
    console.error(`cmsis-dap-smoke: ${failures} check(s) failed`);
    process.exitCode = 1;
  } else {
    console.log(`cmsis-dap-smoke: all checks passed (transport=${transport})`);
  }
}

main().catch(error => {
  console.error(`cmsis-dap-smoke: ${error.message}`);
  process.exitCode = 1;
});
