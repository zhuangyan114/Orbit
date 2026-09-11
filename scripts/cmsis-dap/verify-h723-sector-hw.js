'use strict';

// P7-4: STM32H723VGT6 last 128 KiB sector erase/program/verify, then restore 0xFF.
// Usage: node scripts/cmsis-dap/verify-h723-sector-hw.js --hardware --authorize-test-sector

const {
  H723,
  requireHardware,
  requireAuthorize,
  refuseSecondOwner,
  hex,
  bytesToHex,
  loadH723Algorithm,
  flashAlgorithmParams,
  createEvidence,
  createHelperSession,
  connectSwd,
  disconnectSession,
  finish,
} = require('./h723-hw-harness');

const SCRIPT = 'verify-h723-sector-hw';
requireHardware(SCRIPT);
requireAuthorize(SCRIPT, '--authorize-test-sector', ['halt', 'erase last 128 KiB sector', 'program 32 bytes', 'verify', 'erase restore']);
refuseSecondOwner(SCRIPT);

const PAGE = [
  0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77,
  0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF,
  0x10, 0x32, 0x54, 0x76, 0x98, 0xBA, 0xDC, 0xFE,
  0x01, 0x23, 0x45, 0x67, 0x89, 0xAB, 0xCD, 0xEF,
];

const evidence = createEvidence('Orbit H723 P7-4 test-sector hardware verification v1', {
  grantedByUser: true,
  authorizedOperations: ['halt', 'erase last 128 KiB sector', 'program 32 bytes', 'verify', 'erase restore'],
  forbiddenOperations: ['option bytes', 'mass erase', 'second owner'],
});
evidence.hardwareRequest.testSector = hex(H723.lastSectorAddress);

async function runAlgorithm(session, algorithm, operation, address, size, data = [], reusePageBuffer = false) {
  const timeoutMs = flashAlgorithmParams(algorithm, operation, address, size, data, reusePageBuffer).timeoutMs + 10000;
  return session.request(
    'flashAlgorithm',
    flashAlgorithmParams(algorithm, operation, address, size, data, reusePageBuffer),
    timeoutMs,
  );
}

async function run(session) {
  if (!await connectSwd(session, evidence)) return;
  const halt = await session.request('halt', { timeoutMs: 2000 }, 10000);
  session.check('halt target before sector test', halt.ok && halt.targetState === 'Halted', halt);
  if (!halt.ok) return;
  const algorithm = loadH723Algorithm();
  evidence.summary.algorithmPath = algorithm.path;
  const init = await runAlgorithm(session, algorithm, 'init', H723.flashBase, 0);
  session.check('Init', init.ok && init.data && init.data.returnCode === 0, init);
  if (!init.ok) return;
  try {
    const erase = await runAlgorithm(session, algorithm, 'eraseSector', H723.lastSectorAddress, H723.lastSectorSize);
    session.check('erase last 128 KiB sector', erase.ok && erase.data && erase.data.returnCode === 0, erase);
    if (!erase.ok) return;
    const program = await runAlgorithm(session, algorithm, 'programPage', H723.lastSectorAddress, PAGE.length, PAGE);
    session.check('program one 256-bit flash word', program.ok && program.data && program.data.returnCode === 0, program);
    if (!program.ok) return;
    const verify = await runAlgorithm(session, algorithm, 'verify', H723.lastSectorAddress, PAGE.length, PAGE, true);
    session.check('verify programmed flash word', verify.ok && verify.data && verify.data.returnCode === 0, verify);
    const restore = await runAlgorithm(session, algorithm, 'eraseSector', H723.lastSectorAddress, H723.lastSectorSize);
    session.check('restore last sector to 0xFF', restore.ok && restore.data && restore.data.returnCode === 0, restore);
    const blank = await session.request('readMemory', {
      address: H723.lastSectorAddress, size: PAGE.length, timeoutMs: 10000,
    }, 15000);
    const blankOk = blank.ok && blank.data && blank.data.bytes.every(byte => byte === 0xFF);
    session.check('read-back last sector is erased', blankOk,
      blank.ok ? `bytes=0x${bytesToHex(blank.data.bytes)}` : blank);
  } finally {
    const uninit = await runAlgorithm(session, algorithm, 'uninit', H723.flashBase, 0);
    session.check('UnInit', uninit.ok && uninit.data && uninit.data.returnCode === 0, uninit);
  }
}

async function main() {
  const session = createHelperSession(evidence);
  let runFailed = false;
  try {
    await run(session);
  } catch (error) {
    runFailed = true;
    console.error(`${SCRIPT}: ${error.message}`);
  } finally {
    await disconnectSession(session).catch(() => {});
    await finish(SCRIPT, evidence, session, runFailed, 'h723-p7');
  }
}

main();
