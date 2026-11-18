'use strict';

// Controlled extension-test entry, not a product API. The runner explicitly opts
// into hardware. Commands/results remain in the ignored acceptance directory.
const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

exports.run = async function run() {
  if (process.env.ORBIT_RTOS_HARDWARE_AUTHORIZED !== 'yes') throw new Error('Hardware authorization is required');
  const root = process.env.ORBIT_RTOS_HARDWARE_DIR;
  if (!root) throw new Error('Missing acceptance directory');
  const commands = path.join(root, 'commands'), results = path.join(root, 'results');
  await fs.mkdir(commands, { recursive: true }); await fs.mkdir(results, { recursive: true });
  let session, quit = false;
  const seen = new Set(), trace = [];
  const tracker = vscode.debug.registerDebugAdapterTrackerFactory('orbit', {
    createDebugAdapterTracker: target => ({
      onWillReceiveMessage: message => trace.push({ at: Date.now(), sessionId: target.id, direction: 'request', message }),
      onDidSendMessage: message => {
        if (message.event === 'ozoneDataSamples') {
          trace.push({ at: Date.now(), sessionId: target.id, direction: 'event', event: message.event,
            points: (message.body?.snapshots || []).reduce((sum, item) => sum + (item.data?.length || 0), 0) });
        } else trace.push({ at: Date.now(), sessionId: target.id, direction: 'response', message });
      },
    }),
  });
  const started = vscode.debug.onDidStartDebugSession(value => { if (value.type === 'orbit') session = value; });
  const terminated = vscode.debug.onDidTerminateDebugSession(value => { if (session?.id === value.id) session = undefined; });
  async function stopVisibleSession(target) {
    if (!target) return;
    await vscode.debug.stopDebugging(target);
    const deadline = Date.now() + 15000;
    while ((session?.id === target.id || vscode.debug.activeDebugSession?.id === target.id) && Date.now() < deadline) await delay(50);
    if (session?.id === target.id || vscode.debug.activeDebugSession?.id === target.id) throw new Error('Visible session did not terminate');
  }
  await fs.writeFile(path.join(root, 'ready.json'), JSON.stringify({ vscode: vscode.version, pid: process.pid, workspace: vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath) }));
  try {
    const deadline = Date.now() + 60 * 60 * 1000;
    while (!quit && Date.now() < deadline) {
      for (const file of (await fs.readdir(commands)).filter(file => file.endsWith('.json')).sort()) {
        if (seen.has(file)) continue;
        let request;
        try { request = JSON.parse(await fs.readFile(path.join(commands, file), 'utf8')); } catch { continue; }
        seen.add(file);
        const begin = Date.now(); let result;
        try {
          if (request.action === 'start') {
            if (session || vscode.debug.activeDebugSession) throw new Error('Refusing a second target owner');
            const config = request.configuration;
            if (config.probe !== 'rmlink' || config.device !== 'STM32H723VGT6' || config.rmlinkDeviceId !== 'b81f3fc30470') throw new Error('Unexpected hardware configuration');
            if (!await vscode.debug.startDebugging(vscode.workspace.workspaceFolders[0], config)) throw new Error('VS Code did not start the session');
            await delay(250);
            result = { sessionId: session?.id };
          } else if (request.action === 'stop') {
            if (session) await stopVisibleSession(session);
            await delay(500); result = { stopped: !session };
          } else if (request.action === 'quit') { quit = true; result = { quit: true }; }
          else {
            if (!session || (request.sessionId && session.id !== request.sessionId)) throw new Error('Exact session unavailable');
            if (request.action === 'scenario') {
              const scenario = { name: request.name, startedAt: Date.now(), controls: [], watches: [], errors: [] };
              const index = trace.length;
              let done = false;
              const watch = async () => {
                while (!done) {
                  if (request.watch) {
                    const at = Date.now();
                    try { scenario.watches.push({ at, result: await session.customRequest('watchEvaluate', { expressions: ['fixtureChecksum', 'fixtureState.timerCalls'] }) }); }
                    catch (error) { scenario.errors.push({ operation: 'watch', error: String(error) }); }
                  }
                  await delay(200);
                }
              };
              if (request.timeline) await session.customRequest('dataSamplingStart', { expressions: ['fixtureChecksum', 'fixtureState.timerCalls'], sampleIntervalMs: 1, sendIntervalMs: 50 });
              if (request.snapshot) {
                // Seed address hints in a coherent stopped snapshot before Live.
                await session.customRequest('pause', { threadId: 1 });
                scenario.seed = await session.customRequest('orbitRtosSnapshot');
                await session.customRequest('continue', { threadId: 1 });
                await session.customRequest('orbitRtosSnapshot', { action: 'start', intervalMs: 500 });
              }
              const watcher = watch();
              const control = async (command, args) => {
                const at = Date.now();
                try { const result = await session.customRequest(command, args); scenario.controls.push({ command, at, elapsedMs: Date.now() - at, ok: true, result }); }
                catch (error) { scenario.controls.push({ command, at, elapsedMs: Date.now() - at, ok: false, error: String(error) }); }
              };
              for (let round = 0; round < 30; round++) {
                await delay(Math.max(0, scenario.startedAt + round * 2000 + 800 - Date.now()));
                await control('pause', { threadId: 1 });
                if (round % 5 === 0) await control('stepIn', { threadId: 1, granularity: 'instruction' });
                await control('continue', { threadId: 1 });
              }
              await delay(Math.max(0, scenario.startedAt + 60000 - Date.now()));
              done = true; await watcher;
              if (request.snapshot) {
                await session.customRequest('orbitRtosSnapshot', { action: 'stop' });
                scenario.snapshotStatus = await session.customRequest('orbitRtosSnapshot', { action: 'status' });
              }
              if (request.timeline) await session.customRequest('dataSamplingStop');
              if (request.watch) await session.customRequest('watchEvaluate', { expressions: [] });
              scenario.completedAt = Date.now();
              scenario.events = trace.slice(index).filter(entry => entry.message?.event === 'orbitRtosSnapshot' || entry.event === 'ozoneDataSamples');
              scenario.rttTextLines = trace.slice(index).filter(entry => entry.message?.event === 'output' && String(entry.message.body?.output).includes('orbit-rtos-stage1')).length;
              result = scenario;
            } else if (request.action === 'parallel') {
              const target = session;
              result = await Promise.all(request.requests.map(async item => {
              if (item.delayMs) await delay(item.delayMs);
              try {
                if (item.action === 'stopSession') { await stopVisibleSession(target); return { ok: true }; }
                return { ok: true, result: await target.customRequest(item.command, item.args || {}) };
              }
              catch (error) { return { ok: false, error: String(error) }; }
              }));
            }
            else result = await session.customRequest(request.command, request.args || {});
          }
          await fs.writeFile(path.join(results, file), JSON.stringify({ ok: true, elapsedMs: Date.now() - begin, result }, null, 2));
        } catch (error) {
          await fs.writeFile(path.join(results, file), JSON.stringify({ ok: false, elapsedMs: Date.now() - begin, error: String(error?.stack || error) }, null, 2));
        }
        await fs.writeFile(path.join(root, 'dap-trace.json'), JSON.stringify(trace));
      }
      await delay(20);
    }
  } finally {
    if (session) await vscode.debug.stopDebugging(session);
    tracker.dispose(); started.dispose(); terminated.dispose();
    await fs.writeFile(path.join(root, 'dap-trace.json'), JSON.stringify(trace));
  }
};
