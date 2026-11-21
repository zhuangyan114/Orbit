'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const root = path.resolve(__dirname, '../..');
const clientPackage = path.join(root, 'Releases/clients/node/index.js');

exports.run = async function run() {
  const vscode = require('vscode');
  const { OrbitClient, enumerateInstances } = require(clientPackage);
  const ext = vscode.extensions.getExtension('orbit-debug.orbit-for-vscode');
  assert(ext);
  const { rtosProvider, traceCoordinator } = await ext.activate();
  const output = process.env.ORBIT_RTOS_STAGE55_REPORT_DIR;
  const recordingDir = path.join(output, 'archive');
  const recordId = 'stage55-fixture';
  const identity = { sessionId: 'stage55-seed', sessionGeneration: 1, bootGeneration: 1, recordId };
  const worker = traceCoordinator.ensureWorker();
  const raw = await fs.readFile(path.join(__dirname, 'fixtures/samples/continuous.bin'));
  assert.equal((await worker.createRecording({ recordingDir, recordId, identity })).ok, true);
  assert.equal((await worker.ingestChunk({ ...identity, chunk: raw, batchSequence: 1, flush: true })).ok, true);
  assert.equal((await worker.finishRecording(recordId, 'offline fixture closed')).ok, true);
  await worker.closeRecording(recordId);
  await vscode.commands.executeCommand('ozoneRtos.focus');
  await rtosProvider.handleMessage({ command: 'traceOpenRecording', recordingDir });
  const opened = rtosProvider.currentTraceState.selectedRecordId;
  assert(opened);
  assert.equal(vscode.debug.activeDebugSession, undefined);
  let endpoint;
  for (let attempt = 0; attempt < 40 && !endpoint; ++attempt) {
    const matches = (await enumerateInstances()).filter(item => item.workspaceFolders.some(folder =>
      path.resolve(folder).toLowerCase() === path.join(output, 'workspace').toLowerCase()));
    assert(matches.length <= 1, 'test workspace must have a unique API endpoint');
    endpoint = matches[0];
    if (!endpoint) await delay(100);
  }
  assert(endpoint, 'isolated automation endpoint is available');
  const client = new OrbitClient(endpoint);
  try {
    const unauthorized = await fetch(endpoint.rpcUrl, { method: 'POST', body: '{}' });
    assert.equal(unauthorized.status, 401);
    await client.handshake({ client: { name: 'stage55-vscode-acceptance' }, requestedScopes: ['read'] });
    const list = await client.traceRecordings('offline');
    assert.deepEqual(list.items.map(item => item.recordId), [opened]);
    const summary = await client.traceStatus(opened, true);
    assert.equal(summary.committedRawBytes, raw.length);
    assert(summary.segments.length && !summary.segmentsTruncated);
    assert(!('recordingDir' in summary));
    const request = { recordId: opened, unit: 'byte-offset', start: '0', end: String(raw.length), limit: 3 };
    const first = await client.traceEvents(request);
    assert.equal(first.items.length, 3);
    assert.equal(first.nextOffset, 3);
    assert.equal(first.totalKnownExact, true);
    const second = await client.traceEvents({ ...request, offset: first.nextOffset });
    assert.equal(second.items.length, 3);
    assert(!second.items.some(item => first.items.some(old => item.eventKey === old.eventKey)));
    await assert.rejects(client.traceEvents({ ...request, limit: 201 }), error => error.data?.errorCode === 'InvalidParams');
    const segment = summary.segments[0];
    const stats = await client.traceStatistics({ recordId: opened, unit: 'relative-ticks', bootGeneration: segment.bootGeneration,
      segmentId: segment.segmentId, start: segment.minRelativeTicks, end: String(BigInt(segment.maxRelativeTicks) + 1n), maxBins: 8 });
    assert.equal(stats.precision, 'exact');
    assert(stats.bins.length > 0 && stats.bins.length <= 8);
    await rtosProvider.handleMessage({ command: 'traceCloseRecording', recordId: opened });
    await assert.rejects(client.traceStatus(opened), error => error.data?.errorCode === 'RecordingNotFound');
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ ok: true, vscode: vscode.version, extensionVersion: ext.packageJSON.version,
      extensionPath: ext.extensionPath, offline: true, unauthorizedHttp: unauthorized.status, rawBytes: raw.length,
      first: first.items.map(item => item.eventKey), second: second.items.map(item => item.eventKey), bins: stats.bins.length, precision: stats.precision }, null, 2));
  } finally {
    await client.close().catch(() => {});
  }
};

async function main() {
  const { runTests } = require('@vscode/test-electron');
  const parent = path.join(root, 'out/rtos-stage5/acceptance-5.5');
  await fs.mkdir(parent, { recursive: true });
  const output = await fs.mkdtemp(path.join(parent, 'api-ui-'));
  const workspace = path.join(output, 'workspace');
  const settings = path.join(workspace, '.vscode');
  await fs.mkdir(settings, { recursive: true });
  await fs.writeFile(path.join(settings, 'settings.json'), JSON.stringify({ 'orbit.automation.enabled': true, 'orbit.automation.allowedScopes': ['read'] }));
  process.env.ORBIT_RTOS_STAGE55_REPORT_DIR = output;
  process.env.ORBIT_AUTOMATION_REGISTRY = path.join(output, 'registry.json');
  const installed = path.join(process.env.LOCALAPPDATA, 'Programs/Microsoft VS Code/Code.exe');
  const cached = path.join(root, '.vscode-test/vscode-win32-x64-archive-1.134.0/Code.exe');
  const executable = await fs.access(cached).then(() => cached).catch(() => installed);
  const developmentPath = process.argv.find(arg => arg.startsWith('--extension='))?.slice('--extension='.length) || root;
  console.log(`Stage 5.5 report directory: ${output}`);
  await runTests({ vscodeExecutablePath: executable, extensionDevelopmentPath: developmentPath, extensionTestsPath: __filename,
    launchArgs: [workspace, '--user-data-dir', path.join(output, 'profile'), '--extensions-dir', path.join(output, 'extensions'),
      '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes'] });
  console.log(await fs.readFile(path.join(output, 'report.json'), 'utf8'));
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
