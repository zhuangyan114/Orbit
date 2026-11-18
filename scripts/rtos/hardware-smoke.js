'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const { HardwareClient, delay } = require('./hardware-client');
const root = path.resolve(process.argv[2]);
const client = new HardwareClient(root);
async function run() {
  const configuration = { type: 'orbit', request: 'launch', name: 'RTOS stage1 identity (no flash)', probe: 'rmlink',
    device: 'STM32H723VGT6', rmlinkDeviceId: 'b81f3fc30470', interface: 'SWD', speedKHz: 4000,
    program: path.resolve('out/rtos-stage0/fixtures/arm/snapshot-benchmark.elf'), flashBeforeDebug: false, runToEntryPoint: '', rttLogEnabled: false,
    clearLogsOnStart: false };
  await client.send({ action: 'start', configuration });
  let state;
  for (let index = 0; index < 100; index++) {
    state = await client.request('getTargetState');
    if (/halted/i.test(JSON.stringify(state))) break;
    await delay(200);
  }
  const identity = { configuration, state, registers: {} };
  for (const [name, address, count] of [['cpuid', 0xe000ed00, 4], ['dbgmcu', 0x5c001000, 4], ['flashKiB', 0x1ff1e880, 2]]) {
    const result = await client.request('readMemory', { memoryReference: `0x${address.toString(16)}`, count: 4 });
    const bytes = Buffer.from(result.result.data, 'base64');
    identity.registers[name] = { address, bytes: bytes.toString('hex'), value: count === 4 ? bytes.readUInt32LE() : bytes.readUInt16LE() };
  }
  await fs.writeFile(path.join(root, 'identity.json'), JSON.stringify(identity, null, 2));
  if ((identity.registers.dbgmcu.value & 0xfff) !== 0x483 || identity.registers.flashKiB.value !== 1024) throw new Error('H723 target identity mismatch');
  console.log(JSON.stringify(identity.registers));
  await client.send({ action: 'stop' });
}
run().catch(async error => { console.error(error); process.exitCode = 1; await client.send({ action: 'stop' }).catch(() => {}); });
