'use strict';

// P7-2: STM32H723VGT6 RAM stub. Halt, write/read AXI SRAM, then probe DTCM/D2/D3.
// Usage: node scripts/cmsis-dap/verify-h723-ram-stub-hw.js --hardware --authorize-ram-write

const {
  H723,
  requireHardware,
  requireAuthorize,
  refuseSecondOwner,
  hex,
  bytesToHex,
  createEvidence,
  createHelperSession,
  connectSwd,
  disconnectSession,
  finish,
} = require('./h723-hw-harness');

const SCRIPT = 'verify-h723-ram-stub-hw';
requireHardware(SCRIPT);
requireAuthorize(SCRIPT, '--authorize-ram-write', ['halt', 'AXI SRAM write/read', 'DTCM/D2/D3 probe writes']);
refuseSecondOwner(SCRIPT);

const PATTERN = [0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88];
const AXI_PROBE = H723.axiSram.address + 0x100;
const PROBES = [
  { region: H723.axiSram, address: AXI_PROBE, required: true },
  { region: H723.dtcm, address: H723.dtcm.address + 0x100, required: false },
  { region: H723.d2, address: H723.d2.address, required: false },
  { region: H723.d3, address: H723.d3.address, required: false },
];

const evidence = createEvidence('Orbit H723 P7-2 RAM stub hardware verification v1', {
  grantedByUser: true,
  authorizedOperations: ['halt', 'AXI SRAM write/read', 'DTCM/D2/D3 probe writes'],
  forbiddenOperations: ['flash', 'erase', 'program', 'verify', 'option bytes', 'reset', 'second owner'],
});

function bytesEqual(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

async function probeRegion(session, probe) {
  const original = await session.request('readMemory', { address: probe.address, size: PATTERN.length, timeoutMs: 10000 }, 15000);
  if (!original.ok || !original.data) {
    const result = {
      region: probe.region.name,
      address: hex(probe.address),
      reachable: false,
      restored: false,
      readError: original.errorCode || original.message,
    };
    if (probe.required) session.check(`${probe.region.name} original read`, false, original);
    else session.check(`${probe.region.name} DAP write probe (informational)`, true, result);
    return result;
  }
  const originalBytes = Array.from(original.data.bytes);
  const written = await session.request('writeMemory', {
    address: probe.address, bytes: PATTERN, timeoutMs: 5000,
  }, 10000);
  if (!written.ok) {
    const restored = await session.request('writeMemory', {
      address: probe.address, bytes: originalBytes, timeoutMs: 5000,
    }, 10000).catch(() => ({ ok: false }));
    const result = {
      region: probe.region.name,
      address: hex(probe.address),
      reachable: false,
      writeError: written.errorCode || written.message,
      restored: !!restored.ok,
    };
    if (probe.required) session.check(`${probe.region.name} write`, false, written);
    else session.check(`${probe.region.name} DAP write probe (informational)`, true, result);
    return result;
  }
  const readback = await session.request('readMemory', { address: probe.address, size: PATTERN.length, timeoutMs: 10000 }, 15000);
  const matched = readback.ok && readback.data && bytesEqual(Array.from(readback.data.bytes), PATTERN);
  const restore = await session.request('writeMemory', {
    address: probe.address, bytes: originalBytes, timeoutMs: 5000,
  }, 10000);
  const result = {
    region: probe.region.name,
    address: hex(probe.address),
    reachable: matched,
    original: bytesToHex(originalBytes),
    readback: readback.ok ? bytesToHex(readback.data.bytes) : null,
    restored: !!restore.ok,
  };
  if (probe.required) {
    session.check(`${probe.region.name} write/readback`, matched && restore.ok, result);
  } else {
    session.check(`${probe.region.name} DAP write probe (informational)`, true, result);
  }
  return result;
}

async function run(session) {
  if (!await connectSwd(session, evidence)) return;
  const halt = await session.request('halt', { timeoutMs: 2000 }, 10000);
  session.check('halt target before RAM writes', halt.ok && halt.targetState === 'Halted', halt);
  if (!halt.ok) return;
  evidence.summary.probes = [];
  for (const probe of PROBES) {
    evidence.summary.probes.push(await probeRegion(session, probe));
  }
  const axi = evidence.summary.probes.find(item => item.region === 'AXI SRAM');
  evidence.summary.axiReachable = !!axi?.reachable;
  evidence.summary.dtcmReachable = !!evidence.summary.probes.find(item => item.region === 'DTCM RAM')?.reachable;
  evidence.summary.d2Reachable = !!evidence.summary.probes.find(item => item.region === 'SRAM1-3')?.reachable;
  evidence.summary.d3Reachable = !!evidence.summary.probes.find(item => item.region === 'SRAM4')?.reachable;
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
