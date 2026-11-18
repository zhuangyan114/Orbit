'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { HardwareClient, delay } = require('./hardware-client');
const root = path.resolve(process.argv[2]), client = new HardwareClient(root);
const reportDir = path.resolve(process.argv.find(arg => arg.startsWith('--report-dir='))?.slice(13) || root);
const percentile = (values, p) => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1] : null;
async function run() {
  await fs.mkdir(reportDir, { recursive: true });
  const files = (await fs.readdir(path.join(root, 'commands'))).filter(file => file.endsWith('.json')).sort();
  const starts = [];
  for (const file of files) { const request = JSON.parse(await fs.readFile(path.join(root, 'commands', file), 'utf8')); if (request.action === 'start') starts.push(request.configuration); }
  const original = starts.at(-1);
  if (!original?.program) throw new Error('Run the independent oracle first');
  const report = { source: 'visible VS Code / selected RMLink owner', elf: original.program,
    elfSha256: crypto.createHash('sha256').update(await fs.readFile(original.program)).digest('hex'), configuration: original, scenarios: [] };
  const allModes = [
    { name: 'debug' }, { name: 'watch', watch: true }, { name: 'timeline', timeline: true }, { name: 'rtt', rtt: true },
    { name: 'combined', watch: true, timeline: true, rtt: true }, { name: 'combined-snapshot', watch: true, timeline: true, rtt: true, snapshot: true },
  ];
  const selection = process.argv.find(arg => arg.startsWith('--modes='))?.slice(8).split(',');
  const modes = selection ? allModes.filter(mode => selection.includes(mode.name)) : allModes;
  for (const mode of modes) {
    await client.send({ action: 'stop' });
    await client.send({ action: 'start', configuration: { ...original, name: `RTOS stage1 ${mode.name}`, flashBeforeDebug: false, runToEntryPoint: '', rttLogEnabled: !!mode.rtt } });
    await delay(800); await client.request('continue', { threadId: 1 });
    console.log(`BEGIN ${mode.name}`);
    const { result } = await client.send({ action: 'scenario', ...mode }, 150000);
    await fs.writeFile(path.join(reportDir, `benchmark-${mode.name}.json`), JSON.stringify(result, null, 2));
    const controls = result.controls, snapshots = result.events.filter(entry => entry.message?.event === 'orbitRtosSnapshot').map(entry => entry.message.body);
    const valid = snapshots.filter(snapshot => ['halted-consistent', 'live-best-effort'].includes(snapshot.consistency));
    const numeric = result.watches.flatMap(entry => entry.result.results || []).filter(value => typeof value.value === 'number');
    const summary = { name: mode.name, durationMs: result.completedAt - result.startedAt, controls: controls.length,
      controlErrors: controls.filter(control => !control.ok),
      timings: Object.fromEntries(['pause', 'stepIn', 'continue'].map(command => {
        const values = controls.filter(control => control.command === command && control.ok).map(control => control.elapsedMs);
        return [command, { n: values.length, p50: percentile(values, .5), p95: percentile(values, .95), max: Math.max(...values) }];
      })), watchPolls: result.watches.length, numericWatchResults: numeric.length,
      timelinePoints: result.events.filter(entry => entry.event === 'ozoneDataSamples').reduce((sum, entry) => sum + entry.points, 0), rttTextLines: result.rttTextLines,
      snapshots: { status: result.snapshotStatus, published: snapshots.length, valid: valid.length, partial: snapshots.filter(snapshot => snapshot.consistency === 'partial').length,
        usableTaskFrames: snapshots.filter(snapshot => snapshot.tasks.length === 13 && snapshot.tasks.every(task => task.name.available && task.priority.available && task.creationNumber.available)).length,
        states: [...new Set(snapshots.map(snapshot => snapshot.consistency))], tasks: [...new Set(valid.map(snapshot => snapshot.tasks.length))],
        p50: percentile(valid.map(snapshot => snapshot.diagnostics.totalMs), .5), p95: percentile(valid.map(snapshot => snapshot.diagnostics.totalMs), .95),
        bytes: snapshots.reduce((sum, snapshot) => sum + snapshot.diagnostics.bytes, 0),
        queueWaitP95: percentile(valid.map(snapshot => snapshot.diagnostics.queueWaitMs), .95),
        runtimePercentFields: snapshots.flatMap(snapshot => snapshot.tasks).filter(task => task.runtime.percent.available).length }, errors: result.errors };
    report.scenarios.push(summary);
    await fs.writeFile(path.join(reportDir, 'benchmark-summary.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(summary));
    if (summary.controlErrors.length || summary.errors.length) throw new Error(`Control/watch error in ${mode.name}`);
  }
  await client.send({ action: 'stop' });
}
run().catch(error => { console.error(error); process.exitCode = 1; });
