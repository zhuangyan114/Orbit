'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { HardwareClient, delay } = require('./hardware-client');
const root = path.resolve(process.argv[2]), client = new HardwareClient(root);
const elf = path.resolve('out/rtos-stage0/fixtures/arm/snapshot-benchmark.elf');
const configuration = { type: 'orbit', request: 'launch', name: 'RTOS stage1 benchmark', probe: 'rmlink', device: 'STM32H723VGT6',
  rmlinkDeviceId: 'b81f3fc30470', interface: 'SWD', speedKHz: 4000, program: elf, flashBeforeDebug: !process.argv.includes('--no-flash'), runToEntryPoint: 'main',
  rttLogEnabled: true, rttPollIntervalMs: 100, rttLogTarget: 'debugConsole', clearLogsOnStart: false,
  rtosSnapshotPort: { source: 'fixed FreeRTOS 10.3.1 GCC/ARM_CM4F port + fixture FreeRTOSConfig.h', stackGrowth: 'down', stackFillByte: 0xa5,
    runtime: { source: 'fixture DWT CYCCNT, default HSI 64MHz; stopped by WFI', frequencyHz: 64000000, countsDuringSleep: false } } };
async function halted() {
  for (let index = 0; index < 150; index++) {
    const state = await client.request('getTargetState');
    if (/halted/i.test(JSON.stringify(state))) { await delay(800); return; }
    await delay(100);
  }
  throw new Error('Target did not halt');
}
function resolved(catalog, offset) {
  const seen = new Set();
  while (offset && !seen.has(offset)) {
    seen.add(offset); const type = catalog.types[offset];
    if (!type || !['const', 'volatile', 'typedef', 'restrict'].includes(type.kind)) return type;
    offset = type.typeOffset;
  }
}
async function memory(address, count) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await client.request('readMemory', { memoryReference: `0x${address.toString(16)}`, count: Math.ceil(count / 4) * 4 });
      return Buffer.from(response.result.data, 'base64').subarray(0, count);
    } catch (error) {
      if (attempt === 2 || !/Target read cancelled|TargetReadCancelled|Busy|Target is running/.test(String(error))) throw error;
      await delay(200);
    }
  }
}
async function write(address, value) { const data = Buffer.alloc(4); data.writeUInt32LE(value); return client.request('writeMemory', { memoryReference: `0x${address.toString(16)}`, data: data.toString('base64') }); }
const source = path.resolve('scripts/rtos/fixtures/firmware/main.c');
let checkpointLine;
async function resumeToCheckpoint(fromCheckpoint = false) {
  if (fromCheckpoint) {
    // Current Connector does not step past an active FPB at the current PC.
    // Drive the explicit standard-DAP operations and preserve this baseline
    // limitation instead of changing the debugger in the snapshot task.
    await client.request('setBreakpoints', { source: { path: source }, breakpoints: [] });
    await client.request('stepIn', { threadId: 1, granularity: 'instruction' });
    await client.request('setBreakpoints', { source: { path: source }, breakpoints: [{ line: checkpointLine }] });
  }
  try { await client.request('continue', { threadId: 1 }); }
  catch (error) {
    // A 20ms fixture checkpoint can beat the wireless run-state confirmation.
    // Preserve the failed response; the independent phase/oracle check below
    // must still prove that the intended breakpoint was reached.
    if (!/TargetStateInvalid: (run returned Halted|continue returned halted)/i.test(String(error))) throw error;
  }
  await halted();
}
async function capture(catalog, phase) {
  const rootSymbol = name => catalog.roots.find(node => node.expression === name);
  const stateSymbol = rootSymbol('fixtureState'), stateType = resolved(catalog, stateSymbol.typeOffset), stateBytes = await memory(stateSymbol.address, stateType.byteSize);
  const state = Object.fromEntries(stateType.fields.map(field => [field.name, stateBytes.readUInt32LE(field.byteOffset)]));
  if (state.assertLine || state.phase !== phase || state.oracleCount !== 13) throw new Error(`Unexpected fixture state: ${JSON.stringify(state)}`);
  const oracle = rootSymbol('fixtureTaskOracle'), array = resolved(catalog, oracle.typeOffset), type = resolved(catalog, array.typeOffset);
  const bytes = await memory(oracle.address, type.byteSize * state.oracleCount);
  const field = (record, name) => {
    const member = type.fields.find(field => field.name === name);
    if (!member) return;
    const size = resolved(catalog, member.typeOffset).byteSize;
    return size === 2 ? record.readUInt16LE(member.byteOffset) : record.readUInt32LE(member.byteOffset);
  };
  const expected = [];
  for (let index = 0; index < state.oracleCount; index++) {
    const record = bytes.subarray(index * type.byteSize, (index + 1) * type.byteSize), nameAddress = field(record, 'pcTaskName');
    const nameBytes = await memory(nameAddress, 16), zero = nameBytes.indexOf(0);
    expected.push({ address: field(record, 'xHandle'), number: field(record, 'xTaskNumber'), name: nameBytes.subarray(0, zero).toString(),
      state: ['running', 'ready', 'blocked', 'suspended', 'termination'][field(record, 'eCurrentState')], priority: field(record, 'uxCurrentPriority'),
      watermarkWords: field(record, 'usStackHighWaterMark'), counter: field(record, 'ulRunTimeCounter') });
  }
  const response = await client.request('orbitRtosSnapshot', { taskAddresses: expected.map(task => task.address), maxBytesPerTask: 4096 });
  const actual = response.result, mismatches = [];
  if (actual.consistency !== 'halted-consistent' || actual.tasks.length !== expected.length) mismatches.push(`snapshot: ${actual.consistency} count=${actual.tasks?.length}`);
  for (const task of expected) {
    const found = actual.tasks.find(candidate => candidate.tcbAddress === task.address);
    if (!found) { mismatches.push(`missing ${task.name}`); continue; }
    for (const [name, value] of [['name', task.name], ['priority', task.priority], ['creationNumber', String(task.number)]]) {
      if (!found[name]?.available || found[name].value !== value) mismatches.push(`${task.name}.${name}`);
    }
    if (found.state !== task.state) mismatches.push(`${task.name}.state expected=${task.state} actual=${found.state}`);
    if (!found.stack.watermarkBytes.available || found.stack.watermarkBytes.value !== task.watermarkWords * 4) mismatches.push(`${task.name}.watermark expected=${task.watermarkWords * 4} actual=${JSON.stringify(found.stack.watermarkBytes)}`);
    if (!found.runtime.counter.available || found.runtime.counter.value !== String(task.counter)) mismatches.push(`${task.name}.counter`);
  }
  const evidence = { phase, state, expected, actual, dapElapsedMs: response.elapsedMs, mismatches };
  await fs.writeFile(path.join(root, `oracle-phase${phase}.json`), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ phase, count: actual.tasks?.length, consistency: actual.consistency, elapsedMs: response.elapsedMs, mismatches }));
  if (mismatches.length) throw new Error(mismatches.join('; '));
}
async function run() {
  checkpointLine = (await fs.readFile(source, 'utf8')).split('\n').findIndex(line => line.includes('void FixtureSnapshotCheckpoint(void)')) + 1;
  if (!process.argv.includes('--existing')) await client.send({ action: 'start', configuration });
  const restartToCheckpoint = process.argv.includes('--no-flash') && !process.argv.includes('--at-checkpoint');
  if (restartToCheckpoint) {
    // No-flash launch attaches/halt only. An unchanged-firmware Restart runs
    // automatically, so install the checkpoint before that explicit reset.
    await client.request('setBreakpoints', { source: { path: source }, breakpoints: [{ line: checkpointLine }] });
    try { await client.request('restart'); }
    catch (error) { if (!/TargetStateInvalid: (run returned Halted|restart run returned halted)/i.test(String(error))) throw error; }
  }
  await halted();
  const breakpoint = await client.request('setBreakpoints', { source: { path: source }, breakpoints: [{ line: checkpointLine }] });
  await fs.writeFile(path.join(root, 'checkpoint-breakpoint.json'), JSON.stringify(breakpoint, null, 2));
  if (!breakpoint.result.breakpoints?.[0]?.verified) throw new Error('Checkpoint breakpoint not verified');
  if (!process.argv.includes('--at-checkpoint') && !restartToCheckpoint) await resumeToCheckpoint();
  const catalogResponse = await client.request('getSymbolCatalog'), catalog = catalogResponse.result.data;
  await fs.writeFile(path.join(root, 'catalog.json'), JSON.stringify(catalog));
  const fromPhase = Number(process.argv.find(arg => arg.startsWith('--from-phase='))?.split('=')[1] || 1);
  await capture(catalog, fromPhase);
  const command = catalog.roots.find(node => node.expression === 'fixturePhaseCommand').address;
  for (let phase = fromPhase + 1; phase <= 3; phase++) {
    await write(command, phase); await resumeToCheckpoint(true); await capture(catalog, phase);
  }
  await client.request('setBreakpoints', { source: { path: path.resolve('scripts/rtos/fixtures/firmware/main.c') }, breakpoints: [] });
  await client.request('continue', { threadId: 1 });
}
run().catch(error => { console.error(error); process.exitCode = 1; });
