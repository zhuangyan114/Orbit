'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const root = path.resolve(__dirname, '../..');

async function waitFor(check) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await delay(100);
  }
  throw new Error('Timed out awaiting linked cursors');
}

exports.run = async function run() {
  const vscode = require('vscode');
  const { rtosProvider, timelineProvider, traceCoordinator } = await vscode.extensions.getExtension('orbit-debug.orbit-for-vscode').activate();
  const notices = [];
  const showNotice = rtosProvider.showClockLinkNotice.bind(rtosProvider);
  rtosProvider.showClockLinkNotice = notice => { notices.push(notice); showNotice(notice); };
  const output = process.env.ORBIT_RTOS_STAGE54_REPORT_DIR;
  const directory = path.join(output, 'archive');
  const recordId = 'stage54-test';
  const identity = { sessionId: 'stage54-test', sessionGeneration: 1, bootGeneration: 1, recordId };
  const worker = traceCoordinator.ensureWorker();
  assert.equal((await worker.createRecording({ recordingDir: directory, recordId, identity })).ok, true);
  const raw = await fs.readFile(path.join(__dirname, 'fixtures/samples/continuous.bin'));
  assert.equal((await worker.ingestChunk({ ...identity, chunk: raw, batchSequence: 1, flush: true })).ok, true);
  assert.equal((await worker.finishRecording(recordId, 'fixture end')).ok, true);
  await worker.closeRecording(recordId);

  await vscode.commands.executeCommand('ozoneRtos.focus');
  await waitFor(() => rtosProvider.isVisible && rtosProvider.readyCount >= 1);
  await rtosProvider.handleMessage({ command: 'updateSettings', settings: { activePage: 'trace', traceAutoFollow: true, traceTimeUnit: 'relative-ns' } });
  await rtosProvider.handleMessage({ command: 'traceOpenRecording', recordingDir: directory });
  const opened = rtosProvider.getClockLinkView().record;
  const segment = opened.segments.find(seg => seg.sysFreqHz && seg.reliability === 'trusted');
  assert.ok(segment, 'independent capture must include a known timestamp frequency');
  const min = BigInt(segment.minRelativeTicks);
  const max = BigInt(segment.maxRelativeTicks);
  const anchorTicks = min + (max - min) / 4n;
  const deltaTicks = (max - min) / 8n;
  const toNs = ticks => ticks * 1000000000n / BigInt(segment.sysFreqHz);
  const a = toNs(anchorTicks);
  const b = toNs(anchorTicks + 2n * deltaTicks);
  const c = toNs(anchorTicks + deltaTicks);
  await waitFor(async () => (await rtosProvider.invokeUiAction('trace.getState'))?.recordId === opened.recordId);

  const csv = path.join(output, 'variables.csv');
  const entry = { expression: 'counter', color: '#336699', enabled: true, yAutoScale: true, yCenter: 0, yPerDiv: 1 };
  const view = { autoFollow: true, timePerDiv: 10, cursorA_ms: 15, cursorB_ms: 30, entries: [entry] };
  await fs.writeFile(csv, [
    '# orbit-timeline-version=1',
    '# meta=' + JSON.stringify({ timeUnit: 'ms', name: 'Independent variable record', timeOriginUtc: '2026-01-01T00:00:00Z', complete: true }),
    '# channels=' + JSON.stringify([{ ...entry, id: 0 }]),
    '# view=' + JSON.stringify(view),
    'time_ms,channel_id,value,segment_id', '0,0,0,0', '15,0,1,0', '30,0,2,0', '50,0,2,0',
    '# orbit.end=' + JSON.stringify({ fileFinalized: true, rows: 4, recordComplete: true, rangeComplete: true }),
  ].join('\r\n') + '\r\n');
  await vscode.commands.executeCommand('ozoneTimeline.focus');
  await timelineProvider.importCsv(csv);
  const variables = timelineProvider.getClockLinkView();
  assert.deepEqual(variables.cursors, { A: 15, B: 30 });
  await vscode.commands.executeCommand('ozoneRtos.focus');
  await waitFor(() => rtosProvider.isVisible);

  await rtosProvider.invokeUiAction('trace.setCursor', { kind: 'A', timeStr: a.toString() });
  await rtosProvider.invokeUiAction('trace.setCursor', { kind: 'B', timeStr: b.toString() });
  const first = await rtosProvider.invokeUiAction('trace.getState');
  assert.equal(first.cursorA?.timeStr, a.toString());
  assert.equal(first.cursorB?.timeStr, b.toString());
  assert.equal((await rtosProvider.invokeUiAction('trace.clickClockLink', { align: true })).clicked, true);
  assert.match(await waitFor(() => notices.at(-1)), /手动对齐/);
  await rtosProvider.invokeUiAction('trace.setCursor', { kind: 'A', timeStr: c.toString() });
  const beforeForward = await rtosProvider.invokeUiAction('trace.getState');
  assert.equal(beforeForward.cursorA?.timeStr, c.toString());
  assert.equal(beforeForward.cursorB?.timeStr, b.toString());
  const forward = await rtosProvider.invokeUiAction('trace.clickClockLink', {});
  assert.equal(forward.clicked, true);
  await waitFor(() => notices.length > 1);
  assert.match(notices.at(-1), /^手动对齐。/);
  assert.ok(Math.abs(timelineProvider.getClockLinkView().cursors.A - 22.5) < 0.1,
    JSON.stringify({ a: a.toString(), b: b.toString(), c: c.toString(), cursors: timelineProvider.getClockLinkView().cursors }));
  const middle = await waitFor(() => {
    const cursors = timelineProvider.getClockLinkView().cursors;
    return Math.abs(cursors.A - 22.5) < 0.1 && Math.abs(cursors.B - 30) < 0.1 && cursors;
  });
  const tab = timelineProvider.tabs.get(timelineProvider.activeId);
  assert.equal(tab.view.autoFollow, false, 'Import starts with Auto-Follow off, and linked cursors preserve it');
  await waitFor(() => timelineProvider.view?.visible);

  await timelineProvider.handleMessage({ command: 'clockLinkToTrace', tabId: tab.info.id, recordId: variables.recordId, cursors: { A: 15, B: 30 } });
  await waitFor(() => rtosProvider.isVisible);
  const reverse = await waitFor(async () => {
    const state = await rtosProvider.invokeUiAction('trace.getState');
    return state?.cursorA && state.cursorB
      && Math.abs(Number(state.cursorA.timeStr) - Number(a)) < 1000
      && Math.abs(Number(state.cursorB.timeStr) - Number(b)) < 1000 && state;
  });
  assert.equal(reverse.autoFollow, true);
  assert.equal(reverse.scopeKey, `${segment.bootGeneration}:${segment.segmentId}`);
  assert.equal(vscode.debug.activeDebugSession, undefined);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ ok: true, vscodeVersion: vscode.version,
    forward: middle, reverse: { A: reverse.cursorA, B: reverse.cursorB, scopeKey: reverse.scopeKey },
    traceAutoFollow: reverse.autoFollow, variablesAutoFollow: tab.view.autoFollow }, null, 2));
};

async function main() {
  const { runTests } = require('@vscode/test-electron');
  const parent = path.join(root, 'out/rtos-stage5/acceptance-5.4');
  await fs.mkdir(parent, { recursive: true });
  const output = await fs.mkdtemp(path.join(parent, 'link-ui-'));
  const workspace = path.join(output, 'workspace');
  await fs.mkdir(workspace);
  process.env.ORBIT_RTOS_STAGE54_REPORT_DIR = output;
  const installed = path.join(process.env.LOCALAPPDATA, 'Programs/Microsoft VS Code/Code.exe');
  const cached = path.join(root, '.vscode-test/vscode-win32-x64-archive-1.134.0/Code.exe');
  const executable = await fs.access(cached).then(() => cached).catch(() => installed);
  console.log(`Stage 5.4 report directory: ${output}`);
  await runTests({ vscodeExecutablePath: executable, extensionDevelopmentPath: root, extensionTestsPath: __filename,
    launchArgs: [workspace, '--user-data-dir', path.join(output, 'profile'), '--extensions-dir', path.join(output, 'extensions'),
      '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes'] });
  console.log(await fs.readFile(path.join(output, 'report.json'), 'utf8'));
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
