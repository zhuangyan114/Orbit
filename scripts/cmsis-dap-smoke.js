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
  check('enumDevices: all', enumAll.ok && enumAll.data.devices.length === 20,
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
