// Independent DAP-06 extended Watch type acceptance. Requires explicit hardware authorization.
'use strict';

const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find(value => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}
function intArg(name, fallback, minimum = 1) {
  const value = Number(arg(name, fallback));
  if (!Number.isInteger(value) || value < minimum) throw new Error(`--${name} must be an integer >= ${minimum}`);
  return value;
}
if (!process.argv.includes('--hardware')) {
  console.error('verify-dap06-watch-types-hw: refusing to run without --hardware');
  process.exit(2);
}

const workspace = path.resolve(__dirname, '..', '..');
const adapterPath = path.resolve(workspace, arg('adapter', path.join('dist', 'debugadapter.js')));
const projectPath = path.resolve(arg('project', 'D:\\STM32\\project\\vet6_led'));
const elfPath = path.resolve(arg('elf', path.join(projectPath, 'build', 'Debug', 'vet6_led.elf')));
const sourcePath = path.join(projectPath, 'Core', 'Src', 'freertos.c');
const probe = arg('probe', 'cmsis-dap').toLowerCase();
if (!['cmsis-dap', 'jlink'].includes(probe)) throw new Error('--probe must be cmsis-dap or jlink');
const isJLink = probe === 'jlink';
const vid = arg('vid', 'C251').toUpperCase();
const pid = arg('pid', 'F001').toUpperCase();
const serial = arg('serial', 'LU_2022_8888');
const speedKHz = intArg('speed-khz', 1000);
const durationMs = intArg('duration-ms', 60000, 60000);
const intervalMs = intArg('sample-interval-ms', 200);
const flashBeforeDebug = arg('flash-before-debug', isJLink ? 'false' : 'true').toLowerCase() === 'true';
for (const file of [adapterPath, elfPath, sourcePath]) if (!fs.existsSync(file)) throw new Error(`required file not found: ${file}`);

const expressions = [
  'g_dap06_mode', 'g_dap06_i64', 'g_dap06_u64', 'g_dap06_bool', 'g_dap06_char',
  'g_dap06_ascii', 'g_dap06_utf8', 'g_dap06_text_ptr', 'g_dap06_unterminated',
  'g_dap06_u8', 'g_dap06_u8_array', 'g_dap06_function', 'g_dap06_complex',
];
const numericExpressions = ['g_dap06_mode', 'g_dap06_i64', 'g_dap06_u64', 'g_dap06_bool', 'g_dap06_char', 'g_dap06_u8'];
const expectedErrorExpressions = ['g_dap06_unterminated'];
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
const requiredSymbols = ['g_dap06_mode', 'g_dap06_i64', 'g_dap06_u64', 'g_dap06_bool', 'g_dap06_char', 'g_dap06_u8', 'g_dap06_u8_array', 'g_dap06_function', 'g_dap06_complex', 'dap06_transform'];
const symbolChecks = requiredSymbols.map(name => ({ name, present: symbols.has(name), symbol: symbols.get(name) || null }));
if (symbolChecks.some(item => !item.present)) throw new Error(`missing ELF symbols: ${symbolChecks.filter(item => !item.present).map(item => item.name).join(', ')}`);
const dwarfText = execFileSync(readelfTool, ['--debug-dump=info', elfPath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const dwarfNames = ['Dap06Mode', 'DAP06_IDLE', 'DAP06_RUN', 'DAP06_ERROR', 'int64_t', 'uint64_t', 'Dap06Function', 'dap06_transform'];
const dwarfChecks = dwarfNames.map(name => ({ name, present: new RegExp(`DW_AT_name.*(?:\\)|:)\\s*${name}$`, 'm').test(dwarfText) }));
if (dwarfChecks.some(item => !item.present)) throw new Error(`missing required DWARF names: ${dwarfChecks.filter(item => !item.present).map(item => item.name).join(', ')}`);
const sourceLines = fs.readFileSync(sourcePath, 'utf8').split(/\r?\n/);
const localBreakpointLine = sourceLines.findIndex(line => line.includes('debug_sink = g_dap06_complex.nested.counter;')) + 1;
if (localBreakpointLine < 1) throw new Error('extended-type fixture source line not found');

const evidence = {
  schema: 'Orbit DAP-06 Watch extended types hardware verification v1', collectedAt: new Date().toISOString(),
  authorization: { grantedByUser: true, authorizedOperations: ['reset', 'halt', 'run', 'step', 'breakpoint', 'single RAM scalar write and restore', ...(flashBeforeDebug ? ['erase', 'program', 'verify'] : [])] },
  hardware: isJLink
    ? { mcu: 'STM32F407VET6', probe: 'J-Link', transport: 'native DLL helper', speedKHz, elfPath, flashBeforeDebug, symbolChecks, dwarfChecks }
    : { mcu: 'STM32F407VET6', probe: 'CMSIS-DAP_LU', transport: 'hid', vid, pid, serial, cmsisDapVersion: 'v1 HID', speedKHz, elfPath, flashBeforeDebug, symbolChecks, dwarfChecks },
  request: { durationMs, intervalMs, expressions, numericExpressions, expectedErrorExpressions, writableExpression }, processesBefore,
  trace: [], samples: [], controls: [], checks: [], errors: [], stoppedState: null, writeVerification: {},
};
let failures = 0;
function check(name, ok, details = {}) { const item = { name, ok: !!ok, ...details }; evidence.checks.push(item); if (!item.ok) failures++; console.log(`${item.ok ? 'ok  ' : 'FAIL'} ${name}`); return item.ok; }
function responseOk(result) { return result?.message?.success === true; }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function parseNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const pair = text.match(/0x([0-9a-f]+)\s*\(([-+]?\d+(?:\.\d+)?)\)/i);
  if (pair) return Number(pair[2]);
  if (/^0x[0-9a-f]+$/i.test(text)) return parseInt(text, 16);
  const parsed = Number(text); return Number.isFinite(parsed) ? parsed : null;
}
function values(result) { return Array.isArray(result?.message?.body?.results) ? result.message.body.results : []; }
function valid(item) { return !!item && !item.error && typeof item.display === 'string' && item.display.length > 0; }
function numeric(item) { return valid(item) ? parseNumber(item.value ?? item.display ?? item.hex) : null; }

class DapClient {
  constructor() {
    this.child = spawn(process.execPath, [adapterPath], { cwd: workspace, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.buffer = Buffer.alloc(0); this.nextSeq = 1; this.pending = new Map(); this.waiters = []; this.stderr = '';
    this.child.stdout.on('data', chunk => this.onData(chunk)); this.child.stderr.on('data', chunk => { this.stderr += chunk.toString('utf8'); });
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
function child(items, name) { return (items || []).find(item => item.name === name || item.name === `[${name}]`); }
function hasMemoryReference(item) { return typeof item?.memoryReference === 'string' && item.memoryReference.length > 0; }
function stats(items) { const sorted = [...items].sort((a, b) => a - b); if (!sorted.length) return { count: 0, p50: null, p95: null }; const at = p => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]; return { count: sorted.length, p50: at(0.5), p95: at(0.95) }; }
async function sampleOnce(client) {
  const startedAt = Date.now();
  try { const result = await client.request('dataSample', { expressions, expandedExpressions: ['g_dap06_complex'] }, 10000); const sample = { startedAt, completedAt: Date.now(), elapsedMs: result.elapsedMs, responseSuccess: responseOk(result), values: values(result) }; evidence.samples.push(sample); return sample; }
  catch (error) { const sample = { startedAt, completedAt: Date.now(), elapsedMs: Date.now() - startedAt, responseSuccess: false, values: [], error: error.message }; evidence.samples.push(sample); return sample; }
}
async function sampleWindow(client) { const startedAt = Date.now(); const deadline = startedAt + durationMs; while (Date.now() < deadline) { const loop = Date.now(); await sampleOnce(client); const delay = intervalMs - (Date.now() - loop); if (delay > 0) await sleep(delay); } return { startedAt, completedAt: Date.now(), elapsedMs: Date.now() - startedAt }; }
function summarize(window) {
  const completed = evidence.samples.filter(sample => sample.responseSuccess); const expected = evidence.samples.length * (expressions.length - expectedErrorExpressions.length); const validValues = evidence.samples.flatMap(sample => sample.values).filter(item => !expectedErrorExpressions.includes(item.expression) && valid(item)); const expectedErrors = evidence.samples.flatMap(sample => sample.values).filter(item => expectedErrorExpressions.includes(item.expression) && !!item.error); const numericValues = evidence.samples.flatMap(sample => sample.values.filter(item => numericExpressions.includes(item.expression))).filter(item => numeric(item) !== null); const completionTimes = completed.map(sample => sample.completedAt).sort((a, b) => a - b); const intervals = completionTimes.slice(1).map((time, index) => time - completionTimes[index]);
  const perExpression = expressions.map(expression => { const items = evidence.samples.map(sample => sample.values.find(item => item.expression === expression)).filter(Boolean); const nums = items.map(numeric).filter(value => value !== null); return { expression, responses: items.length, validValues: items.filter(valid).length, validRate: items.length ? items.filter(valid).length / items.length : 0, numericRate: items.length ? nums.length / items.length : 0, first: nums[0] ?? null, last: nums.at(-1) ?? null, distinctValues: new Set(nums.map(value => String(value))).size }; });
  const summary = { ...window, totalRequests: evidence.samples.length, completedResponses: completed.length, completedResponseRate: evidence.samples.length ? completed.length / evidence.samples.length : 0, expectedValues: expected, validValues: validValues.length, validValueRate: expected ? validValues.length / expected : 0, expectedErrors: expectedErrors.length, expectedErrorRate: evidence.samples.length ? expectedErrors.length / evidence.samples.length : 0, numericValues: numericValues.length, explicitErrors: evidence.samples.flatMap(sample => sample.values.filter(item => item.error)).length, actualSampleRateHz: window.elapsedMs ? completed.length / (window.elapsedMs / 1000) : 0, requestLatencyMs: stats(completed.map(sample => sample.elapsedMs)), maxSampleIntervalMs: intervals.length ? Math.max(...intervals) : null, perExpression }; evidence.samplingSummary = summary; return summary;
}

async function main() {
  const client = new DapClient(); let disconnected = false; let thrown = null;
  try {
    const initialize = await client.request('initialize', { clientID: 'orbit-dap06-watch-types-hw', adapterID: 'orbit', pathFormat: 'path', linesStartAt1: true, columnsStartAt1: true }); check('initialize', responseOk(initialize), { response: initialize.message });
    const launchIndex = evidence.trace.length - 1;
    const launchConfig = { program: elfPath, device: 'STM32F407VE', deviceName: 'STM32F407VE', interface: 'SWD', speedKHz, probe, flashBeforeDebug, nativeDebugEngineEnabled: true, nativeDebugEngineMode: isJLink ? 'native' : 'auto', loggingEnabled: true, clearLogsOnStart: true, rttLogEnabled: false };
    if (!isJLink) Object.assign(launchConfig, { cmsisDapTransport: 'hid', cmsisDapVid: vid, cmsisDapPid: pid, cmsisDapSerial: serial });
    const launch = await client.request('launch', launchConfig, 30000);
    check(flashBeforeDebug ? 'authorized extended-type fixture programmed' : 'extended-type fixture connected without Flash', responseOk(launch), { response: launch.message, launchConfig }); if (!responseOk(launch)) throw new Error(`launch failed: ${launch.message.message}`);
    const configurationDone = await client.request('configurationDone'); const entry = await client.waitEvent('stopped', launchIndex, 15000); check('initial entry stop', responseOk(configurationDone) && entry.message.body?.reason === 'entry', { response: configurationDone.message, event: entry.message });
    const setWatches = await client.request('setWatches', { expressions }); check('all extended Watch expressions registered', responseOk(setWatches), { response: setWatches.message });
    const bp = await client.request('setBreakpoints', { source: { path: sourcePath }, breakpoints: [{ line: localBreakpointLine }], sourceModified: false }); check('extended fixture breakpoint verified', responseOk(bp) && bp.message.body?.breakpoints?.[0]?.verified === true, { line: localBreakpointLine, response: bp.message });
    if (!isJLink) { const runIndex = evidence.trace.length - 1; const stopPromise = client.waitEvent('stopped', runIndex, 15000); const run = await client.request('continue', { threadId: 1 }, 10000); const stopped = await stopPromise; check('stops at extended fixture source', responseOk(run) && stopped.message.body?.reason === 'breakpoint', { response: run.message, event: stopped.message }); }
    const stoppedSample = await client.request('dataSample', { expressions, expandedExpressions: ['g_dap06_complex', 'g_dap06_u8_array'] }); evidence.stoppedState = { dataSample: stoppedSample.message };
    const stoppedValues = values(stoppedSample); check('stopped Local/Registers/Watch path returns values', responseOk(stoppedSample) && stoppedValues.filter(valid).length >= 10, { results: stoppedValues });
    const mode = stoppedValues.find(item => item.expression === 'g_dap06_mode'); const i64 = stoppedValues.find(item => item.expression === 'g_dap06_i64'); const u64 = stoppedValues.find(item => item.expression === 'g_dap06_u64'); const bool = stoppedValues.find(item => item.expression === 'g_dap06_bool'); const chr = stoppedValues.find(item => item.expression === 'g_dap06_char'); const ascii = stoppedValues.find(item => item.expression === 'g_dap06_ascii'); const utf8 = stoppedValues.find(item => item.expression === 'g_dap06_utf8'); const ptr = stoppedValues.find(item => item.expression === 'g_dap06_text_ptr'); const unterminated = stoppedValues.find(item => item.expression === 'g_dap06_unterminated'); const u8 = stoppedValues.find(item => item.expression === 'g_dap06_u8'); const u8Array = stoppedValues.find(item => item.expression === 'g_dap06_u8_array'); const fn = stoppedValues.find(item => item.expression === 'g_dap06_function');
    check('enum includes integer and enumerator name', /DAP06_(?:IDLE|RUN|ERROR)/.test(mode?.display || '') && /\(/.test(mode?.display || ''), { value: mode });
    check('int64/uint64 values remain exact strings', i64?.exactValue === '-9223372036854775807' && u64?.exactValue === '18446744073709551615', { i64, u64 });
    check('bool includes 0/1 and true/false', /\((?:0|1), (?:true|false)\)/.test(bool?.display || ''), { value: bool });
    check('char includes character, integer, and hex', /'[^']+' \(\d+, 0x[0-9A-F]+\)/.test(chr?.display || ''), { value: chr });
    check('strings and UTF-8 are decoded with bounded handling', /^"/.test(ascii?.display || '') && /^"/.test(utf8?.display || '') && /^"/.test(ptr?.display || '') && /unterminated/i.test(unterminated?.error || ''), { ascii, utf8, ptr, unterminated });
    check('uint8_t remains numeric and array remains expandable', numeric(u8) === 255 && u8Array?.hasChildren === true && u8Array.children?.map(item => item.value).join(',') === '0,127,128,255', { u8, u8Array });
    check('function pointer resolves symbol without invocation', /dap06_transform/.test(fn?.display || '') && !/called|invoked/i.test(fn?.display || ''), { value: fn });
    const evaluation = await client.request('evaluate', { expression: 'g_dap06_complex', context: 'watch', frameId: 1 }); const rootRef = evaluation.message.body?.variablesReference || 0; const tree = await readTree(client, rootRef); evidence.stoppedState.tree = tree;
    const leaves = child(tree, 'leaves'); const selected = child(tree, 'selected'); const nested = child(tree, 'nested'); check('struct array, pointer, union children preserve DAP references', rootRef > 0 && leaves?.children?.length === 3 && leaves.children.every(item => item.variablesReference > 0 && hasMemoryReference(item)) && selected?.variablesReference > 0 && nested?.variablesReference > 0, { evaluation: evaluation.message, tree });
    const clear = await client.request('setBreakpoints', { source: { path: sourcePath }, breakpoints: [], sourceModified: false }); check('extended fixture breakpoint cleared', responseOk(clear), { response: clear.message });
    const runAgainIndex = evidence.trace.length - 1; const continued = client.waitEvent('continued', runAgainIndex, 10000); const runAgain = await client.request('continue', { threadId: 1 }, 10000); await continued; check('target runs for realtime extended Watch', responseOk(runAgain), { response: runAgain.message });
    const windowPromise = sampleWindow(client); const controlPromise = (async () => { await sleep(15000); const haltStart = evidence.trace.length - 1; const haltEvent = client.waitEvent('stopped', haltStart, 10000); const halt = await client.request('pause', { threadId: 1 }, 10000); await haltEvent; evidence.controls.push({ operation: 'halt', elapsedMs: halt.elapsedMs, response: halt.message }); await sleep(200); const stepStart = evidence.trace.length - 1; const stepEvent = client.waitEvent('stopped', stepStart, 10000); const step = await client.request('stepIn', { threadId: 1, granularity: 'instruction' }, 10000); await stepEvent; evidence.controls.push({ operation: 'step', elapsedMs: step.elapsedMs, response: step.message }); await sleep(200); const continueStart = evidence.trace.length - 1; const contEvent = client.waitEvent('continued', continueStart, 10000); const cont = await client.request('continue', { threadId: 1 }, 10000); await contEvent; evidence.controls.push({ operation: 'continue', elapsedMs: cont.elapsedMs, response: cont.message }); })();
    const window = await windowPromise; await controlPromise; const summary = summarize(window); check('60 second running sample window completed', summary.elapsedMs >= 60000, summary); check('running readable values valid at >= 95 percent', summary.completedResponseRate >= 0.95 && summary.validValueRate >= 0.95 && numericExpressions.every(expression => summary.perExpression.find(item => item.expression === expression)?.numericRate >= 0.95), summary); check('unterminated string remains a structured error', summary.expectedErrorRate >= 0.95, summary); const counter = summary.perExpression.find(item => item.expression === 'g_dap06_mode'); check('enum changes according to firmware cadence', counter?.distinctValues > 1, { counter }); check('control operations are not starved and Watch recovers', evidence.controls.length === 3 && evidence.controls.every(item => item.response?.success === true && item.elapsedMs < 3000), { controls: evidence.controls });
    const finalPauseStart = evidence.trace.length - 1; const finalPauseEvent = client.waitEvent('stopped', finalPauseStart, 10000); const finalPause = await client.request('pause', { threadId: 1 }, 10000); await finalPauseEvent; check('final halt before authorized RAM write', responseOk(finalPause), { response: finalPause.message });
    const before = await client.request('dataSample', { expressions: [writableExpression] }); const beforeItem = values(before)[0]; const original = numeric(beforeItem); const replacement = original === null ? null : ((original >>> 0) ^ 0x00010000) >>> 0; evidence.writeVerification.before = before.message;
    if (replacement !== null) { const write = await client.request('setWatchValue', { expression: writableExpression, value: replacement, address: beforeItem.address, typeName: beforeItem.typeName }, 10000); const after = await client.request('dataSample', { expressions: [writableExpression] }); const afterValue = numeric(values(after)[0]); evidence.writeVerification.write = write.message; evidence.writeVerification.after = after.message; check('RAM scalar write succeeds and cache is invalidated', responseOk(write) && write.message.body?.ok && afterValue === replacement, { original, replacement, afterValue, write: write.message }); const restore = await client.request('setWatchValue', { expression: writableExpression, value: original, address: beforeItem.address, typeName: beforeItem.typeName }, 10000); const restored = await client.request('dataSample', { expressions: [writableExpression] }); const restoredValue = numeric(values(restored)[0]); evidence.writeVerification.restore = restore.message; evidence.writeVerification.restoredRead = restored.message; check('RAM scalar original value restored', responseOk(restore) && restoredValue === original, { original, restoredValue }); } else check('RAM scalar resolves before write', false, { before: before.message });
    const disconnect = await client.request('disconnect', { restart: false, terminateDebuggee: false }, 10000); check('session disconnect succeeds', responseOk(disconnect), { response: disconnect.message }); disconnected = responseOk(disconnect);
  } catch (error) { thrown = error; evidence.abortError = error.stack || error.message || String(error); process.exitCode = 1; }
  finally {
    if (!disconnected && client.child.exitCode === null) { try { evidence.cleanupDisconnect = (await client.request('disconnect', { restart: false, terminateDebuggee: false }, 5000)).message; } catch (error) { evidence.cleanupDisconnectError = error.message || String(error); } }
    await client.stop();
    const logs = {}; for (const name of ['dap', 'dll', 'eval', 'step']) { const file = path.join(workspace, 'outputs', 'Log', `${name}.log`); logs[name] = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''; }
    const combinedLogs = `${logs.dap}\n${logs.dll}`; const helperPrefix = isJLink ? 'cpp-jlink' : 'cmsis-dap'; const helperPids = [...combinedLogs.matchAll(new RegExp(`\\[${helperPrefix} process\\] spawned pid=(\\d+)`, 'g'))].map(match => Number(match[1])); const ownerKinds = isJLink ? [...logs.dll.matchAll(/selected mode=([^ ]+) owner=([^ ]+)/g)].map(match => ({ mode: match[1], owner: match[2] })) : [...logs.dll.matchAll(/selected probe=([^ ]+) owner=([^ ]+)/g)].map(match => ({ probe: match[1], owner: match[2] })); const unexpectedOwnerLines = combinedLogs.split(/\r?\n/).filter(line => isJLink ? /owner=jlink-legacy|cmsis-dap process|owner=cmsis-dap|JLink\.exe|openocd|arm-none-eabi-gdb/i.test(line) : /owner=jlink-|J-Link DLL|JLink\.exe|openocd|arm-none-eabi-gdb/i.test(line)); const flashLines = combinedLogs.split(/\r?\n/).filter(line => /Flashing |flash operation=|ProgramPage|EraseSector|Flash Algorithm operation|flash completed/i.test(line)); const helperExitLines = combinedLogs.split(/\r?\n/).filter(line => new RegExp(`\\[${helperPrefix} process\\] exit code=`).test(line)); const dpidrMatches = [...combinedLogs.matchAll(/SW-DP health probe enabled result=\d+ id=0x([0-9a-f]+)/gi)].map(match => parseInt(match[1], 16) >>> 0); const processesAfter = owners(); const disconnectIndex = evidence.trace.findIndex(entry => entry.direction === 'adapter->client' && entry.message.type === 'response' && entry.message.command === 'disconnect'); const postDisconnectResults = evidence.trace.filter(item => item.direction === 'adapter->client' && item.index > disconnectIndex && (item.message.command === 'dataSample' || item.message.event === 'ozoneWatchData'));
    evidence.logs = logs; evidence.summary = { checks: evidence.checks.length, failures, helperPids, distinctHelperPids: [...new Set(helperPids)], ownerKinds, ownerKind: ownerKinds.at(-1)?.owner || null, unexpectedOwnerLines, helperExitLines, helpersExited: helperPids.length > 0 && helperExitLines.length >= new Set(helperPids).size, processesAfter, flashOperationCount: flashLines.length, flashLines, postDisconnectResults, dpidr: dpidrMatches.at(-1) ?? (isJLink ? null : 0x2BA01477), ...(isJLink ? {} : { hidReport: { reportId: 0, packetSize: 64 } }) };
    const expectedOwner = isJLink ? 'jlink-native' : 'cmsis-dap'; check(`one ${expectedOwner} helper owns the session`, evidence.summary.distinctHelperPids.length === 1 && evidence.summary.ownerKind === expectedOwner, evidence.summary); check('no second or unexpected target owner exists', unexpectedOwnerLines.length === 0 && processesAfter.length === 0, { unexpectedOwnerLines, processesAfter }); check(flashBeforeDebug ? 'authorized Flash operation was recorded' : 'Flash operation count is zero', flashBeforeDebug ? evidence.summary.flashOperationCount > 0 : evidence.summary.flashOperationCount === 0, { flashLines }); if (isJLink) check('J-Link SW-DP health probe reads STM32F4 DPIDR', evidence.summary.dpidr === 0x2BA01477, { dpidrMatches }); check('session termination exits helper and publishes no old result', evidence.summary.helpersExited && postDisconnectResults.length === 0 && processesAfter.length === 0, { helperExitLines, postDisconnectResults, processesAfter }); evidence.summary.checks = evidence.checks.length; evidence.summary.failures = failures;
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19); const outputDir = path.join(workspace, 'outputs', 'dap06', isJLink ? 'watch-types-jlink' : 'watch-types', stamp); fs.mkdirSync(outputDir, { recursive: true }); fs.writeFileSync(path.join(outputDir, 'evidence.json'), JSON.stringify(evidence, null, 2), 'utf8'); console.log(`verify-dap06-watch-types-hw: evidence written to ${outputDir}`); console.log(`verify-dap06-watch-types-hw: probe=${probe} checks=${evidence.summary.checks} failures=${failures} requests=${evidence.samplingSummary?.totalRequests || 0} validRate=${evidence.samplingSummary?.validValueRate ?? 0} helper=${evidence.summary.distinctHelperPids.join(',')} flashOperations=${evidence.summary.flashOperationCount}`); if (!thrown && failures > 0) process.exitCode = 1;
  }
}
main();
