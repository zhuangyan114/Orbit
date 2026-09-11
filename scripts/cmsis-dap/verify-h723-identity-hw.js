'use strict';

// P7-1: STM32H723VGT6 read-only identity. No halt/run/reset/write/flash.
// Usage: node scripts/cmsis-dap/verify-h723-identity-hw.js --hardware [--vid=C251] [--pid=F001] [--serial=...]

const {
  H723,
  requireHardware,
  refuseSecondOwner,
  hex,
  bytesToHex,
  readLe16,
  readLe32,
  createEvidence,
  createHelperSession,
  connectSwd,
  disconnectSession,
  finish,
} = require('./h723-hw-harness');

const SCRIPT = 'verify-h723-identity-hw';
requireHardware(SCRIPT);
refuseSecondOwner(SCRIPT);

const evidence = createEvidence('Orbit H723 P7-1 identity hardware verification v1', {
  grantedByUser: true,
  authorizedOperations: ['DAP_Connect', 'DP/AP register access required for memory reads', 'read-only memory'],
  forbiddenOperations: ['halt', 'run', 'reset', 'step', 'breakpoint', 'target memory write', 'flash', 'erase', 'program', 'verify', 'option bytes', 'second owner'],
});

async function run(session) {
  if (!await connectSwd(session, evidence)) return;
  const idcode = await session.request('dpRead', { reg: 0, timeoutMs: 5000 });
  const dpidr = idcode.ok && idcode.data ? idcode.data.value >>> 0 : null;
  evidence.summary.dpidr = dpidr === null ? null : hex(dpidr);
  session.check('SW-DP DPIDR is 0x6BA02477', dpidr === H723.dpIdcode,
    dpidr === null ? idcode : `DPIDR=${hex(dpidr)}`);

  const dbgmcu = await session.request('readMemory', { address: H723.dbgmcuAddress, size: 4, timeoutMs: 10000 }, 15000);
  const deviceIdcode = dbgmcu.ok && dbgmcu.data ? readLe32(dbgmcu.data.bytes) : null;
  const deviceId = deviceIdcode === null ? null : deviceIdcode & 0xFFF;
  evidence.summary.dbgmcu = deviceIdcode === null ? null : hex(deviceIdcode);
  session.check('DBGMCU_IDCODE DEV_ID is 0x483', dbgmcu.ok && deviceId === H723.deviceId,
    deviceIdcode === null ? dbgmcu : `DBGMCU=${hex(deviceIdcode)} DEV_ID=${hex(deviceId)}`);

  const flashSize = await session.request('readMemory', {
    address: H723.flashSizeRegisterAddress, size: 2, timeoutMs: 10000,
  }, 15000);
  const flashSizeKiB = flashSize.ok && flashSize.data ? readLe16(flashSize.data.bytes) : null;
  evidence.summary.flashSizeKiB = flashSizeKiB;
  session.check('Flash size register reports 1024 KiB', flashSize.ok && flashSizeKiB === H723.expectedFlashSizeKiB,
    flashSizeKiB === null ? flashSize : `${flashSizeKiB} KiB`);

  const axi = await session.request('readMemory', { address: H723.axiSram.address, size: 4, timeoutMs: 10000 }, 15000);
  session.check('AXI SRAM sample read', axi.ok && axi.data && axi.data.bytes.length === 4,
    axi.ok ? `bytes=0x${bytesToHex(axi.data.bytes)}` : axi);
  const dtcm = await session.request('readMemory', { address: H723.dtcm.address, size: 4, timeoutMs: 10000 }, 15000);
  session.check('DTCM sample read', dtcm.ok && dtcm.data && dtcm.data.bytes.length === 4,
    dtcm.ok ? `bytes=0x${bytesToHex(dtcm.data.bytes)}` : dtcm);
  const flash = await session.request('readMemory', { address: H723.flashBase, size: 8, timeoutMs: 10000 }, 15000);
  session.check('Flash vector sample read', flash.ok && flash.data && flash.data.bytes.length === 8,
    flash.ok ? `bytes=0x${bytesToHex(flash.data.bytes)}` : flash);
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
