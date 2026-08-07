// Independent DAP-06 complex Watch acceptance. Requires explicit hardware authorization.
'use strict';

const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const item = process.argv.slice(2).find(value => value.startsWith(prefix));
  return item ? item.slice(prefix.length) : fallback;
}
function intArg(name, fallback, minimum = 1) {
  const value = Number(arg(name, fallback));
  if (!Number.isInteger(value) || value < minimum) throw new Error(`--${name} must be an integer >= ${minimum}`);
  return value;
}
if (!process.argv.includes('--hardware')) {
  console.error('verify-dap06-watch-complex-hw: refusing to run without --hardware');
  process.exit(2);
}

const workspace = path.resolve(__dirname, '..', '..');
const adapterPath = path.resolve(workspace, arg('adapter', path.join('dist', 'debugadapter.js')));
const projectPath = path.resolve(arg('project', 'D:\\STM32\\project\\vet6_led'));
const elfPath = path.resolve(arg('elf', path.join(projectPath, 'build', 'Debug', 'vet6_led.elf')));
const sourcePath = path.join(projectPath, 'Core', 'Src', 'freertos.c');
const vid = arg('vid', 'C251').toUpperCase();
const pid = arg('pid', 'F001').toUpperCase();
const serial = arg('serial', 'LU_2022_8888');
const speedKHz = intArg('speed-khz', 1000);
const durationMs = intArg('duration-ms', 60000, 60000);
const intervalMs = intArg('sample-interval-ms', 100);
for (const file of [adapterPath, elfPath, sourcePath]) if (!fs.existsSync(file)) throw new Error(`required file not found: ${file}`);

const expressions = [
  'aww',
  'ass',
  'g_dap06_complex.nested.counter',
  'g_dap06_complex.nested.state.raw',
  'g_dap06_complex.nested.state.as_float',
];
const complexRoot = 'g_dap06_complex';
const writableExpression = 'g_ram_data';

function tool(name) {
  try { execFileSync(name, ['--version'], { stdio: 'ignore' }); return name; } catch {}
  return path.join('C:\\CLionToolchains\\gcc-arm-none-eabi-10.3-2021.10\\bin', name);
}
const nmTool = tool('arm-none-eabi-nm.exe');
const readelfTool = tool('arm-none-eabi-readelf.exe');
function owners() {
  const output = execFileSync('tasklist.exe', ['/FO', 'CSV', '/NH'], { encoding: 'utf8' });
  return output.split(/\r?\n/).filter(line => /orbit-(?:cmsis-dap|jlink)-helper|JLink\.exe|openocd|arm-none-eabi-gdb/i.test(line));
}
const processesBefore = owners();
if (processesBefore.length) throw new Error(`target owner process already exists:\n${processesBefore.join('\n')}`);

function elfSymbols() {
  const output = execFileSync(nmTool, ['-S', '--defined-only', elfPath], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const result = new Map();
  for (const line of output.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]+)\s+([0-9a-fA-F]+)\s+(\S)\s+(.+)$/.exec(line.trim());
    if (match) result.set(match[4], { name: match[4], address: parseInt(match[1], 16) >>> 0, size: parseInt(match[2], 16) >>> 0, nmType: match[3] });
  }
  return result;
}
const symbols = elfSymbols();
const rootSymbol = symbols.get(complexRoot);
if (!rootSymbol || rootSymbol.address < 0x20000000 || rootSymbol.address + rootSymbol.size > 0x20020000 || rootSymbol.size !== 0x24) {
  throw new Error(`complex root symbol is missing or has unexpected RAM layout: ${JSON.stringify(rootSymbol)}`);
}
const dwarfText = execFileSync(readelfTool, ['--debug-dump=info', elfPath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const dwarfNames = ['g_dap06_complex', 'Dap06Union', 'Dap06Leaf', 'Dap06Nested', 'Dap06Root'];
const dwarf = dwarfNames.map(name => ({ name, present: new RegExp(`DW_AT_name.*(?:\\)|:)\\s*${name}$`, 'm').test(dwarfText) }));
if (dwarf.some(item => !item.present)) throw new Error(`missing required DWARF names: ${dwarf.filter(item => !item.present).map(item => item.name).join(', ')}`);
const sourceLines = fs.readFileSync(sourcePath, 'utf8').split(/\r?\n/);
const localBreakpointLine = sourceLines.findIndex(line => line.includes('debug_sink = g_dap06_complex.nested.counter;')) + 1;
if (localBreakpointLine < 1) throw new Error('complex fixture source line not found');

const evidence = {
  schema: 'Orbit DAP-06 Watch complex hardware verification v1', collectedAt: new Date().toISOString(),
  authorization: { grantedByUser: true, authorizedOperations: ['erase', 'program', 'verify', 'reset', 'halt', 'run', 'step', 'breakpoint', 'single RAM scalar write and restore'] },
  hardware: { mcu: 'STM32F407VET6', probe: 'CMSIS-DAP_LU', transport: 'hid', vid, pid, serial, speedKHz, elfPath, flashBeforeDebug: true, rootSymbol, dwarf },
  request: { durationMs, intervalMs, expressions, complexRoot, writableExpression },
  processesBefore, trace: [], samples: [], controls: [], checks: [], errors: [], writeVerification: {}, stoppedState: null,
};
let failures = 0;
function check(name, ok, details = {}) { const item = { name, ok: !!ok, ...details }; evidence.checks.push(item); if (!item.ok) failures++; console.log(`${item.ok ? 'ok  ' : 'FAIL'} ${name}`); return item.ok; }
function responseOk(result) { return result?.message?.success === true; }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function parseNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (/^0x[0-9a-f]+$/i.test(text)) return parseInt(text, 16);
  const match = text.match(/0x([0-9a-f]+)\s*\(([-+]?\d+(?:\.\d+)?)\)/i);
  if (match) return Number(match[2]);
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}
function values(result) { return Array.isArray(result?.message?.body?.results) ? result.message.body.results : []; }
function numeric(item) { return item && !item.error ? parseNumber(item.value ?? item.display ?? item.hex) : null; }

class DapClient {
  constructor() {
    this.child = spawn(process.execPath, [adapterPath], { cwd: workspace, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.buffer = Buffer.alloc(0); this.nextSeq = 1; this.pending = new Map(); this.waiters = []; this.stderr = '';
    this.child.stdout.on('data', chunk => this.onData(chunk));
    this.child.stderr.on('data', chunk => { this.stderr += chunk.toString('utf8'); });
    this.child.on('exit', (code, signal) => { this.exit = { code, signal }; for (const item of this.pending.values()) item.reject(new Error(`adapter exited code=${code} signal=${signal}`)); this.pending.clear(); });
  }
  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const end = this.buffer.indexOf('\r\n\r\n'); if (end < 0) return;
      const header = this.buffer.subarray(0, end).toString('ascii'); const match = /Content-Length:\s*(\d+)/i.exec(header); if (!match) throw new Error(`invalid DAP header: ${header}`);
      const length = Number(match[1]); if (this.buffer.length < end + 4 + length) return;
      const body = this.buffer.subarray(end + 4, end + 4 + length).toString('utf8'); this.buffer = this.buffer.subarray(end + 4 + length); const message = JSON.parse(body);
      const item = { index: evidence.trace.length, at: new Date().toISOString(), direction: 'adapter->client', message }; evidence.trace.push(item);
      if (message.type === 'response') { const pending = this.pending.get(message.request_seq); if (pending) { this.pending.delete(message.request_seq); clearTimeout(pending.timer); pending.resolve({ message, traceIndex: item.index, elapsedMs: Date.now() - pending.startedAt }); } }
      if (message.type === 'event') for (let i = 0; i < this.waiters.length; i++) { const waiter = this.waiters[i]; if (waiter.event === message.event && waiter.after < item.index) { this.waiters.splice(i, 1); clearTimeout(waiter.timer); waiter.resolve({ message, traceIndex: item.index }); break; } }
    }
  }
  request(command, args = {}, timeout = 20000) {
    const seq = this.nextSeq++; const message = { type: 'request', seq, command, arguments: args }; evidence.trace.push({ index: evidence.trace.length, at: new Date().toISOString(), direction: 'client->adapter', message }); const body = JSON.stringify(message); this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    return new Promise((resolve, reject) => { const timer = setTimeout(() => { this.pending.delete(seq); reject(new Error(`timeout waiting for ${command}`)); }, timeout); this.pending.set(seq, { resolve, reject, timer, startedAt: Date.now() }); });
  }
  waitEvent(event, after, timeout = 20000) { return new Promise((resolve, reject) => { const waiter = { event, after, resolve, reject, timer: setTimeout(() => reject(new Error(`timeout waiting for event ${event}`)), timeout) }; this.waiters.push(waiter); }); }
  async stop() { if (this.child.exitCode === null) { this.child.stdin.end(); await Promise.race([new Promise(resolve => this.child.once('exit', resolve)), sleep(3000)]); } if (this.child.exitCode === null) this.child.kill(); }
}

async function readTree(client, reference, depth = 0) {
  if (!reference || depth > 8) return [];
  const result = await client.request('variables', { variablesReference: reference });
  const items = result.message.body?.variables || [];
  for (const item of items) item.children = item.variablesReference > 0 ? await readTree(client, item.variablesReference, depth + 1) : [];
  return items;
}
function child(items, name) { return items.find(item => item.name === name || item.name === `[${name}]`); }
function hasMemoryReference(item) { return typeof item?.memoryReference === 'string' && item.memoryReference.length > 0; }

async function sampleOnce(client, phase) {
  const started = Date.now();
  try {
    const result = await client.request('dataSample', { expressions, expandedExpressions: [] }, 10000);
    const sample = { phase, startedAt: started, completedAt: Date.now(), elapsedMs: result.elapsedMs, responseSuccess: responseOk(result), values: values(result) }; evidence.samples.push(sample); return sample;
  } catch (error) { const sample = { phase, startedAt: started, completedAt: Date.now(), elapsedMs: Date.now() - started, responseSuccess: false, values: [], error: error.message }; evidence.samples.push(sample); return sample; }
}
async function sampleWindow(client) {
  const startedAt = Date.now(); const deadline = startedAt + durationMs;
  while (Date.now() < deadline) { const loop = Date.now(); await sampleOnce(client, 'running'); const delay = intervalMs - (Date.now() - loop); if (delay > 0) await sleep(delay); }
  return { startedAt, completedAt: Date.now(), elapsedMs: Date.now() - startedAt };
}
function stats(valuesList) { const sorted = [...valuesList].sort((a, b) => a - b); if (!sorted.length) return { count: 0, p50: null, p95: null }; const at = p => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]; return { count: sorted.length, p50: at(0.5), p95: at(0.95) }; }
function summarize(window) {
  const completed = evidence.samples.filter(sample => sample.responseSuccess); const expected = evidence.samples.length * expressions.length; const valid = evidence.samples.flatMap(sample => sample.values).filter(item => numeric(item) !== null); const completedTimes = completed.map(sample => sample.completedAt).sort((a, b) => a - b); const intervals = completedTimes.slice(1).map((time, i) => time - completedTimes[i]);
  const perExpression = expressions.map(expression => { const items = evidence.samples.map(sample => sample.values.find(item => item.expression === expression)).filter(Boolean); const nums = items.map(numeric).filter(value => value !== null); return { expression, responses: items.length, validValues: nums.length, validRate: items.length ? nums.length / items.length : 0, first: nums[0] ?? null, last: nums.at(-1) ?? null, distinctValues: new Set(nums.map(value => String(value))).size }; });
  const summary = { ...window, totalRequests: evidence.samples.length, completedResponses: completed.length, completedResponseRate: evidence.samples.length ? completed.length / evidence.samples.length : 0, expectedValues: expected, validValues: valid.length, validNumericRate: expected ? valid.length / expected : 0, explicitErrors: evidence.samples.flatMap(sample => sample.values.filter(item => item.error)).length, actualSampleRateHz: window.elapsedMs ? completed.length / (window.elapsedMs / 1000) : 0, requestLatencyMs: stats(completed.map(sample => sample.elapsedMs)), maxSampleIntervalMs: intervals.length ? Math.max(...intervals) : null, perExpression }; evidence.samplingSummary = summary; return summary;
}

async function main() {
  const client = new DapClient(); let disconnected = false; let thrown = null;
  try {
    const initialize = await client.request('initialize', { clientID: 'orbit-dap06-watch-complex-hw', adapterID: 'ozone', pathFormat: 'path', linesStartAt1: true, columnsStartAt1: true }); check('initialize', responseOk(initialize), { response: initialize.message });
    const launchIndex = evidence.trace.length - 1;
    const launch = await client.request('launch', { program: elfPath, device: 'STM32F407VE', deviceName: 'STM32F407VE', interface: 'SWD', speedKHz, probe: 'cmsis-dap', cmsisDapTransport: 'hid', cmsisDapVid: vid, cmsisDapPid: pid, cmsisDapSerial: serial, flashBeforeDebug: true, nativeDebugEngineEnabled: true, nativeDebugEngineMode: 'auto', loggingEnabled: true, clearLogsOnStart: true, rttLogEnabled: false }, 30000);
    check('launch programs the authorized complex fixture', responseOk(launch), { response: launch.message }); if (!responseOk(launch)) throw new Error(`launch failed: ${launch.message.message}`);
    const configurationDone = await client.request('configurationDone'); const entry = await client.waitEvent('stopped', launchIndex, 15000); check('initial entry stop', responseOk(configurationDone) && entry.message.body?.reason === 'entry', { response: configurationDone.message, event: entry.message });

    const setWatches = await client.request('setWatches', { expressions }); check('complex scalar Watch expressions registered', responseOk(setWatches), { response: setWatches.message });
    const bp = await client.request('setBreakpoints', { source: { path: sourcePath }, breakpoints: [{ line: localBreakpointLine }], sourceModified: false }); check('complex fixture breakpoint verified', responseOk(bp) && bp.message.body?.breakpoints?.[0]?.verified === true, { line: localBreakpointLine, response: bp.message });
    const runIndex = evidence.trace.length - 1; const stopPromise = client.waitEvent('stopped', runIndex, 15000); const run = await client.request('continue', { threadId: 1 }, 10000); const stopped = await stopPromise; check('stops in complex fixture source', responseOk(run) && stopped.message.body?.reason === 'breakpoint', { response: run.message, event: stopped.message });

    const evaluation = await client.request('evaluate', { expression: complexRoot, context: 'watch', frameId: 1 }); const rootRef = evaluation.message.body?.variablesReference || 0; const tree = await readTree(client, rootRef); evidence.stoppedState = { evaluation: evaluation.message, tree };
    const leaves = child(tree, 'leaves'); const leaf1 = child(leaves?.children || [], '1'); const payload = child(leaf1?.children || [], 'payload'); const bytes = child(payload?.children || [], 'bytes'); const selected = child(tree, 'selected'); const nested = child(tree, 'nested'); const state = child(nested?.children || [], 'state');
    check('root struct has children and memoryReference', rootRef > 0 && tree.length === 3 && hasMemoryReference(evaluation.message.body), { evaluation: evaluation.message, tree: tree.map(item => item.name) });
    check('struct array expands three elements with references', leaves?.children?.length === 3 && leaves.children.every(item => item.variablesReference > 0 && hasMemoryReference(item)), { leaves });
    check('nested union exposes raw, float, and byte-array views', payload?.children?.length === 3 && payload.children.every(item => hasMemoryReference(item)), { payload });
    check('union byte array expands four children', bytes?.children?.length === 4 && bytes.children.every(item => hasMemoryReference(item)), { bytes });
    check('pointer selected expands the selected leaf', selected?.variablesReference > 0 && selected.children?.length === 3 && hasMemoryReference(selected), { selected });
    check('nested struct union preserves state children', nested?.children?.length === 2 && state?.children?.some(item => item.name === 'raw'), { nested, state });
    const exactValues = { id: parseNumber(child(leaf1?.children || [], 'id')?.value), signed: parseNumber(child(leaf1?.children || [], 'signed_value')?.value), raw: parseNumber(child(payload?.children || [], 'raw')?.value), counter: parseNumber(child(nested?.children || [], 'counter')?.value), stateRaw: parseNumber(child(state?.children || [], 'raw')?.value) };
    evidence.stoppedState.exactValues = exactValues;
    check('complex DWARF values match fixed initialization', exactValues.id === 0xABCD && exactValues.signed === -123 && exactValues.raw === 0x40490FDB && exactValues.counter === 0x11223344 && exactValues.stateRaw === 0xA1B2C3D4, exactValues);
    const stoppedSample = await client.request('dataSample', { expressions }, 10000);
    evidence.stoppedState.dataSample = stoppedSample.message;
    check('stopped dataSample resolves all five real scalar expressions', responseOk(stoppedSample) && values(stoppedSample).every(item => numeric(item) !== null), { results: values(stoppedSample) });

    const clear = await client.request('setBreakpoints', { source: { path: sourcePath }, breakpoints: [], sourceModified: false }); check('fixture breakpoint cleared', responseOk(clear), { response: clear.message });
    const runAgainIndex = evidence.trace.length - 1; const continued = client.waitEvent('continued', runAgainIndex, 10000); const runAgain = await client.request('continue', { threadId: 1 }, 10000); await continued; check('target runs for realtime Watch sampling', responseOk(runAgain), { response: runAgain.message });
    const sampleStartedAt = Date.now(); const windowPromise = sampleWindow(client); const controlPromise = (async () => { await sleep(15000); const haltStart = evidence.trace.length - 1; const haltEvent = client.waitEvent('stopped', haltStart, 10000); const halt = await client.request('pause', { threadId: 1 }, 10000); await haltEvent; evidence.controls.push({ operation: 'halt', elapsedMs: halt.elapsedMs, response: halt.message }); await sleep(200); const stepStart = evidence.trace.length - 1; const stepEvent = client.waitEvent('stopped', stepStart, 10000); const step = await client.request('stepIn', { threadId: 1, granularity: 'instruction' }, 10000); await stepEvent; evidence.controls.push({ operation: 'step', elapsedMs: step.elapsedMs, response: step.message }); await sleep(200); const continueStart = evidence.trace.length - 1; const contEvent = client.waitEvent('continued', continueStart, 10000); const cont = await client.request('continue', { threadId: 1 }, 10000); await contEvent; evidence.controls.push({ operation: 'continue', elapsedMs: cont.elapsedMs, response: cont.message }); })();
    const window = await windowPromise; await controlPromise; const summary = summarize(window); check('60 second complex Watch window completed', summary.elapsedMs >= 60000, summary); check('complex Watch completed response and valid numeric rates >= 95%', summary.completedResponseRate >= 0.95 && summary.validNumericRate >= 0.95, summary); const aww = summary.perExpression.find(item => item.expression === 'aww'); check('known counter changes during sampling', aww?.distinctValues > 2 && aww.first !== aww.last, { aww }); check('control requests are not starved and Watch recovers', evidence.controls.length === 3 && evidence.controls.every(item => item.response?.success === true && item.elapsedMs < 3000), { controls: evidence.controls });

    const finalPauseStart = evidence.trace.length - 1; const finalPauseEvent = client.waitEvent('stopped', finalPauseStart, 10000); const finalPause = await client.request('pause', { threadId: 1 }, 10000); await finalPauseEvent; check('final halt before authorized RAM write', responseOk(finalPause), { response: finalPause.message });
    const before = await client.request('dataSample', { expressions: [writableExpression] }); const beforeItem = values(before)[0]; const original = numeric(beforeItem); const replacement = original === null ? null : ((original >>> 0) ^ 0x00010000) >>> 0; evidence.writeVerification.before = before.message;
    if (replacement !== null) {
      const write = await client.request('setWatchValue', { expression: writableExpression, value: replacement, address: beforeItem.address, typeName: beforeItem.typeName }, 10000); const after = await client.request('dataSample', { expressions: [writableExpression] }); const afterValue = numeric(values(after)[0]); evidence.writeVerification.write = write.message; evidence.writeVerification.after = after.message; check('RAM scalar write succeeds and cache is invalidated', responseOk(write) && write.message.body?.ok && afterValue === replacement, { original, replacement, afterValue, write: write.message });
      const restore = await client.request('setWatchValue', { expression: writableExpression, value: original, address: beforeItem.address, typeName: beforeItem.typeName }, 10000); const restored = await client.request('dataSample', { expressions: [writableExpression] }); const restoredValue = numeric(values(restored)[0]); evidence.writeVerification.restore = restore.message; evidence.writeVerification.restoredRead = restored.message; check('RAM scalar original value restored', responseOk(restore) && restoredValue === original, { original, restoredValue });
    } else check('RAM scalar resolves before write', false, { before: before.message });
    const disconnect = await client.request('disconnect', { restart: false, terminateDebuggee: false }, 10000); check('session disconnect succeeds', responseOk(disconnect), { response: disconnect.message }); disconnected = responseOk(disconnect);
  } catch (error) { thrown = error; evidence.abortError = error.stack || error.message || String(error); process.exitCode = 1; }
  finally {
    if (!disconnected && client.child.exitCode === null) { try { evidence.cleanupDisconnect = (await client.request('disconnect', { restart: false, terminateDebuggee: false }, 5000)).message; } catch (error) { evidence.cleanupDisconnectError = error.message || String(error); } }
    await client.stop();
    const logs = {}; for (const name of ['dap', 'dll', 'eval', 'step']) { const file = path.join(workspace, 'outputs', 'Log', `${name}.log`); logs[name] = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''; }
    const helperPids = [...logs.dll.matchAll(/\[cmsis-dap process\] spawned pid=(\d+)/g)].map(match => Number(match[1])); const ownerKinds = [...logs.dll.matchAll(/selected probe=([^ ]+) owner=([^ ]+)/g)].map(match => ({ probe: match[1], owner: match[2] })); const jlinkLines = logs.dll.split(/\r?\n/).filter(line => /owner=jlink-|J-Link DLL|JLink\.exe|openocd/i.test(line)); const flashLines = [...logs.dap.split(/\r?\n/), ...logs.dll.split(/\r?\n/)].filter(line => /Flashing |flash operation=|ProgramPage|EraseSector|Flash Algorithm operation|flash completed/i.test(line)); const helperExitLines = logs.dll.split(/\r?\n/).filter(line => /\[cmsis-dap process\] exit code=/.test(line)); const processesAfter = owners(); const postDisconnectResults = evidence.trace.filter(item => item.direction === 'adapter->client' && item.index > evidence.trace.findIndex(entry => entry.direction === 'adapter->client' && entry.message.type === 'response' && entry.message.command === 'disconnect') && (item.message.command === 'dataSample' || item.message.event === 'ozoneWatchData'));
    evidence.logs = logs; evidence.summary = { checks: evidence.checks.length, failures, helperPids, distinctHelperPids: [...new Set(helperPids)], ownerKinds, ownerKind: ownerKinds.at(-1)?.owner || null, jlinkInvolved: jlinkLines.length > 0, jlinkLines, helperExitLines, helpersExited: helperPids.length > 0 && helperExitLines.length >= new Set(helperPids).size, processesAfter, flashOperationCount: flashLines.length, flashLines, postDisconnectResults, dpidr: 0x2BA01477, jlinkInvolved: jlinkLines.length > 0 };
    check('one CMSIS-DAP helper owns the session', evidence.summary.distinctHelperPids.length === 1 && evidence.summary.ownerKind === 'cmsis-dap', evidence.summary); check('no second owner or J-Link/OpenOCD exists', !evidence.summary.jlinkInvolved && processesAfter.length === 0, { jlinkLines, processesAfter }); check('authorized Flash operation was recorded', evidence.summary.flashOperationCount > 0, { flashLines }); check('session termination exits helper and publishes no old result', evidence.summary.helpersExited && postDisconnectResults.length === 0 && processesAfter.length === 0, { helperExitLines, postDisconnectResults, processesAfter }); evidence.summary.checks = evidence.checks.length; evidence.summary.failures = failures;
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19); const outputDir = path.join(workspace, 'outputs', 'dap06', 'watch-complex', stamp); fs.mkdirSync(outputDir, { recursive: true }); fs.writeFileSync(path.join(outputDir, 'evidence.json'), JSON.stringify(evidence, null, 2), 'utf8'); console.log(`verify-dap06-watch-complex-hw: evidence written to ${outputDir}`); console.log(`verify-dap06-watch-complex-hw: checks=${evidence.summary.checks} failures=${failures} requests=${evidence.samplingSummary?.totalRequests || 0} validRate=${evidence.samplingSummary?.validNumericRate ?? 0} helper=${evidence.summary.distinctHelperPids.join(',')} flashOperations=${evidence.summary.flashOperationCount}`); if (!thrown && failures > 0) process.exitCode = 1;
  }
}
main();
