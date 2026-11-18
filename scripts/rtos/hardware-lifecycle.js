'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { HardwareClient, delay } = require('./hardware-client');
const root = path.resolve(process.argv[2]), client = new HardwareClient(root);
const report = { startedAt: Date.now(), checks: [], warmSnapshots: [], interleavings: [] };
function check(name, ok, detail) { report.checks.push({ name, ok, detail }); if (!ok) throw new Error(name + ': ' + JSON.stringify(detail)); }
async function run() {
  const starts = [];
  for (const file of (await fs.readdir(path.join(root, 'commands'))).filter(file => file.endsWith('.json')).sort()) {
    const command = JSON.parse(await fs.readFile(path.join(root, 'commands', file), 'utf8'));
    if (command.action === 'start') starts.push(command.configuration);
  }
  const configFile = process.argv.find(arg => arg.startsWith('--configuration='))?.slice(16);
  const supplied = configFile ? JSON.parse(await fs.readFile(configFile, 'utf8')) : undefined;
  const configuration = { ...(supplied?.configuration || supplied || starts.at(-1)), name: 'RTOS stage1 lifecycle', flashBeforeDebug: false, runToEntryPoint: '', rttLogEnabled: false };
  await client.send({ action: 'stop' }); await client.send({ action: 'start', configuration }); await delay(1000);
  report.capabilities = (await client.request('orbitRtosSnapshot', { action: 'capabilities' })).result;
  check('metadata capabilities', report.capabilities.capabilities.taskSnapshot.available && report.capabilities.capabilities.stackBounds.available, report.capabilities);
  for (let index = 0; index < 21; index++) {
    const response = await client.request('orbitRtosSnapshot');
    report.warmSnapshots.push({ elapsedMs: response.elapsedMs, consistency: response.result.consistency, diagnostics: response.result.diagnostics });
    check(`halted snapshot ${index}`, response.result.consistency === 'halted-consistent' && response.result.tasks.length === 13, response.result.reason);
    report.last = response.result;
  }
  const stack = await client.request('orbitRtosSnapshot', { taskAddresses: report.last.tasks.map(task => task.tcbAddress), maxBytesPerTask: 4096 });
  report.stack = { elapsedMs: stack.elapsedMs, snapshot: stack.result };
  check('all 13 stack scans', stack.result.tasks.every(task => task.stack.watermarkBytes.available && task.stack.scanComplete), stack.elapsedMs);
  const catalog = (await client.request('getSymbolCatalog')).result.data;
  report.identity = {};
  for (const [name, address] of [['cpuid', 0xe000ed00], ['dbgmcu', 0x5c001000], ['flashSize', 0x1ff1e880],
    ['SystemCoreClock', catalog.roots.find(node => node.expression === 'SystemCoreClock').address]]) {
    const raw = (await client.request('readMemory', { memoryReference: `0x${address.toString(16)}`, count: 4 })).result.data;
    report.identity[name] = { address, raw, value: Buffer.from(raw, 'base64').readUInt32LE() };
  }
  check('H723 identity and declared clock', report.identity.cpuid.value === 0x411fc272 && (report.identity.dbgmcu.value & 0xfff) === 0x483
    && (report.identity.flashSize.value & 0xffff) === 1024 && report.identity.SystemCoreClock.value === 64000000, report.identity);
  const address = catalog.roots.find(node => node.expression === 'fixtureChecksum').address;
  const oldBytes = (await client.request('readMemory', { memoryReference: `0x${address.toString(16)}`, count: 4 })).result.data;
  for (const [name, command, args] of [
    ['step', 'stepIn', { threadId: 1, granularity: 'instruction' }],
    ['write', 'writeMemory', { memoryReference: `0x${address.toString(16)}`, data: oldBytes }],
    ['restart', 'restart', {}],
  ]) {
    const result = await client.send({ action: 'parallel', requests: [{ command: 'orbitRtosSnapshot' }, { command, args, delayMs: 20 }] });
    report.interleavings.push({ name, ...result });
    const [snapshot, control] = result.result;
    check(`${name} succeeds`, control.ok, control);
    check(`${name} discards in-flight snapshot`, !snapshot.ok || snapshot.result.consistency === 'unavailable', snapshot);
  }
  // The explicit restart above reset the target without programming it.
  await client.request('continue', { threadId: 1 }); await delay(500);
  await client.request('pause', { threadId: 1 }); await delay(800);
  const phaseCommand = catalog.roots.find(node => node.expression === 'fixturePhaseCommand').address;
  const value = Buffer.alloc(4); value.writeUInt32LE(3);
  await client.request('writeMemory', { memoryReference: `0x${phaseCommand.toString(16)}`, data: value.toString('base64') });
  await client.request('continue', { threadId: 1 }); await delay(500);
  const before = (await client.request('orbitRtosSnapshot')).result;
  await client.request('orbitRtosSnapshot', { action: 'start', intervalMs: 500 }); await delay(40);
  const stoppedAt = Date.now(); await client.request('orbitRtosSnapshot', { action: 'stop' }); await delay(300);
  report.stoppedAt = stoppedAt;
  report.status = (await client.request('orbitRtosSnapshot', { action: 'status' })).result;
  check('live stop drains its bounded read', !report.status.inFlight && !report.status.polling, report.status);
  report.termination = await client.send({ action: 'parallel', requests: [{ command: 'orbitRtosSnapshot' }, { action: 'stopSession', delayMs: 20 }] });
  check('visible session terminates', report.termination.result[1].ok, report.termination.result[1]);
  check('termination discards pending data', !report.termination.result[0].ok || report.termination.result[0].result.consistency === 'unavailable', report.termination.result);
  await client.send({ action: 'stop' });
  await delay(500);
  await client.send({ action: 'start', configuration }); await delay(800);
  const next = (await client.request('orbitRtosSnapshot', { action: 'capabilities' })).result;
  report.nextSession = next;
  check('replacement session has a new adapter identity', next.sessionId !== before.sessionId, { before: before.sessionId, after: next.sessionId });
  const coalesced = await client.send({ action: 'parallel', requests: [{ command: 'orbitRtosSnapshot' }, { command: 'orbitRtosSnapshot' }, { command: 'orbitRtosSnapshot' }] });
  report.coalesced = coalesced;
  check('concurrent refreshes coalesce', coalesced.result.every(item => item.ok && Number.isInteger(item.result.snapshotSequence)) && new Set(coalesced.result.map(item => item.result.snapshotSequence)).size === 1, coalesced.result.map(item => item.result?.snapshotSequence));
  report.finalState = (await client.request('getTargetState')).result;
  await client.request('continue', { threadId: 1 }); await client.send({ action: 'stop' });
}
run().catch(error => { report.error = String(error.stack || error); console.error(report.error); process.exitCode = 1; })
  .finally(async () => { report.completedAt = Date.now(); await fs.writeFile(path.join(root, 'lifecycle.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report.checks)); });
