'use strict';
const vscode = require('vscode');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(fn, timeoutMs = 20000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await fn();
    if (val) return val;
    await delay(40);
  }
  const msg = typeof label === 'function' ? label() : label;
  throw new Error(`Timed out waiting for: ${msg}`);
}

class MockTraceSessionAdapter {
  constructor(scenario) {
    this.scenario = scenario;
    this.emitter = new vscode.EventEmitter();
    this.onDidSendMessage = this.emitter.event;
    this.seq = 1;
    this.consumerId = undefined;
    this.enableState = 0;
    this.batchSeq = 1;
    this.haltedOrReset = false;
  }

  sendResponse(req, body = {}, success = true, message) {
    this.emitter.fire({
      type: 'response',
      seq: this.seq++,
      request_seq: req.seq,
      command: req.command,
      success,
      body,
      ...(message ? { message } : {}),
    });
  }

  sendEvent(event, body = {}) {
    this.emitter.fire({ type: 'event', seq: this.seq++, event, body });
  }

  makeEnum() {
    return {
      controlBlockAddress: 0x20001000,
      upBuffers: [
        {
          direction: 'up',
          index: 1,
          bufferAddress: 0x20002000,
          status: 'valid',
          name: 'SysView',
          nameStatus: 'ok',
          valid: true,
          bufferSize: 8192,
          rdOff: 0,
          wrOff: 0,
        },
      ],
      downBuffers: [
        {
          direction: 'down',
          index: 1,
          bufferAddress: 0x20003000,
          status: 'valid',
          name: 'SysView',
          nameStatus: 'ok',
          valid: true,
          bufferSize: 16,
          rdOff: 1,
          wrOff: 1,
        },
      ],
      duplicateUpNames: [],
      duplicateDownNames: [],
    };
  }

  handleMessage(msg) {
    if (msg.type !== 'request') return;
    const args = msg.arguments || {};
    if (msg.command === 'pause' || msg.command === 'reset' || msg.command === 'restart') {
      this.haltedOrReset = true;
    }

    switch (msg.command) {
      case 'initialize':
        this.sendResponse(msg, { supportsConfigurationDoneRequest: true });
        break;
      case 'launch':
        this.sendResponse(msg, {});
        this.sendEvent('initialized', {});
        this.sendEvent('continued', { threadId: 1, allThreadsContinued: true });
        break;
      case 'configurationDone':
        this.sendResponse(msg, {});
        break;
      case 'threads':
        this.sendResponse(msg, { threads: [{ id: 1, name: 'Main' }] });
        break;
      case 'disconnect':
      case 'terminate':
        this.sendResponse(msg, {});
        this.sendEvent('terminated', {});
        break;
      case 'orbitRtosSnapshot':
        if (args.action === 'capabilities') {
          const ok = { available: true, evidence: 'offline' };
          this.sendResponse(msg, {
            sessionId: this.scenario.sessionId,
            sessionGeneration: 1,
            operationGeneration: 1,
            bootGeneration: 1,
            elfSha256: 'feedface51',
            layoutId: 'layout-51',
            capabilities: {
              layout: ok,
              taskSnapshot: { available: false, reason: 'Trace-only mock', evidence: 'offline' },
              stackBounds: ok,
              stackWatermark: ok,
              runtimeCounters: ok,
              runtimePercent: ok,
            },
          });
        } else {
          this.sendResponse(msg, { stopped: true });
        }
        break;
      case 'orbitTraceTarget':
        if (args.action === 'readState') {
          this.sendResponse(msg, {
            ok: true,
            sessionGeneration: 1,
            bootGeneration: 1,
            targetState: 'Running',
            globalsValues: { enableState: this.enableState, dropCount: 0 },
            enumerate: this.makeEnum(),
          });
        } else {
          this.sendResponse(msg, {
            ok: true,
            identity: {
              sessionId: this.scenario.sessionId,
              sessionGeneration: 1,
              bootGeneration: 1,
              operationGeneration: 1,
              elfSha256: 'feedface51',
              elfPath: 'mock.elf',
              device: 'STM32H723VGT6',
            },
            ownerKind: 'cmsis-dap',
            transportKind: 'winusb',
            targetState: 'Running',
            controlInProgress: false,
            ramRangesAvailable: true,
            ramRanges: [{ address: 0x20000000, size: 0x20000 }],
            rttControlBlockAddress: 0x20001000,
            rttCapabilities: {
              ownerKind: 'cmsis-dap',
              rttStart: { available: true, evidence: 'offline' },
              rttEnumerate: { available: true, evidence: 'offline' },
              rttUpRead: { available: true, evidence: 'offline' },
              rttDownWrite: { available: true, evidence: 'offline' },
            },
            rttBudgets: {
              channel0: { ownerKind: 'cmsis-dap', transport: 'winusb', maxBatchBytes: 512, minPollIntervalMs: 10, defaultPollIntervalMs: 20, maxBatchesPerTurn: 4, source: 'test' },
              binaryChannel: { ownerKind: 'cmsis-dap', transport: 'winusb', maxBatchBytes: 512, minPollIntervalMs: 10, defaultPollIntervalMs: 20, maxBatchesPerTurn: 4, source: 'test' },
            },
            metadataLayout: {
              rttControlBlockAddress: 0x20001000,
              globals: {
                symbolName: '_SYSVIEW_Globals',
                baseAddress: 0x20000100,
                size: 32,
                postMortemCompiled: false,
                fields: {},
              },
            },
            globalsValues: { enableState: this.enableState, dropCount: 0 },
          });
        }
        break;
      case 'orbitRttTransport':
        if (args.action === 'enumerate') {
          this.sendResponse(msg, { ok: true, data: this.makeEnum() });
        } else if (args.action === 'subscribe') {
          this.consumerId = args.consumerId;
          this.sendResponse(msg, {
            ok: true,
            bufferIndex: 1,
            budget: { ownerKind: 'cmsis-dap', transport: 'winusb', maxBatchBytes: 512, minPollIntervalMs: 10, defaultPollIntervalMs: 20, maxBatchesPerTurn: 4, source: 'test' },
          });
        } else if (args.action === 'writeDown') {
          const cmd = Buffer.from(args.dataBase64, 'base64')[0];
          this.enableState = cmd === 1 ? 1 : 0;
          this.sendResponse(msg, { ok: true, data: { committedBytes: 1, committedWrOff: 1 } });
          if (cmd === 1 && this.scenario.initialChunk) {
            this.sendEvent('orbitRttData', {
              consumerId: this.consumerId,
              sessionId: this.scenario.sessionId,
              sessionGeneration: 1,
              bootGeneration: 1,
              bufferIndex: 1,
              batchSequence: this.batchSeq++,
              dataBase64: Buffer.from(this.scenario.initialChunk).toString('base64'),
            });
          }
        } else if (args.action === 'drain') {
          this.sendResponse(msg, { ok: true, drained: true, batchesDrained: 0, bytesDrained: 0, lastRdOff: 0, lastWrOff: 0, bufferSize: 8192 });
        } else {
          this.sendResponse(msg, { ok: true });
        }
        break;
      default:
        this.sendResponse(msg, {});
    }
  }

  dispose() {
    this.emitter.dispose();
  }
}

exports.run = async function run() {
  const workspaceRoot = path.resolve(__dirname, '../..');
  const reportPath = process.env.ORBIT_RTOS_STAGE51_REPORT;
  const archives = JSON.parse(process.env.ORBIT_RTOS_STAGE51_ARCHIVES || '{}');

  const ext = vscode.extensions.getExtension('orbit-debug.orbit-for-vscode');
  assert.ok(ext, 'orbit-for-vscode extension must be present');
  const api = await ext.activate();
  const provider = api?.rtosProvider;
  const coordinator = api?.traceCoordinator;
  assert.ok(provider && coordinator, 'Test extension mode must expose rtosProvider and traceCoordinator');

  await vscode.commands.executeCommand('workbench.view.extension.ozone-rtos-panel');
  await vscode.commands.executeCommand('ozoneRtos.focus');
  await waitFor(() => provider.isVisible && provider.readyCount >= 1, 15000, 'RTOS webview ready');

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'orbit-vs51-'));
  const adapters = [];
  const factory = vscode.debug.registerDebugAdapterDescriptorFactory('orbit', {
    createDebugAdapterDescriptor(session) {
      const adapter = new MockTraceSessionAdapter(session.configuration.traceScenario);
      adapters.push(adapter);
      return new vscode.DebugAdapterInlineImplementation(adapter);
    },
  });

  const report = {
    ok: false,
    stage0OfflineContexts: {},
    h723Archives: {},
    hotRecordingContexts: {},
    millionEventsContexts: {},
    themeAndLifecycle: {},
  };

  try {
    const contBin = await fsp.readFile(path.join(workspaceRoot, 'scripts/rtos/fixtures/samples/continuous.bin'));
    const seedClient = coordinator.ensureWorker();
    assert.ok(seedClient, 'TraceWorkerClient available');

    // 1. Offline Stage 0 sample -> Trace Timeline <-> Contexts & CPU Load linkage
    const s0Dir = path.join(tmpDir, 's0-cont');
    await seedClient.createRecording({
      recordingDir: s0Dir,
      recordId: 'seed-51-s0',
      identity: { sessionId: 's0-51', sessionGeneration: 1, bootGeneration: 1, recordId: 'seed-51-s0' },
      commitOnEachIngest: true,
    });
    await seedClient.ingestChunk({
      recordId: 'seed-51-s0',
      sessionId: 's0-51',
      sessionGeneration: 1,
      batchSequence: 1,
      chunk: contBin,
      flush: true,
    });
    await seedClient.finishRecording('seed-51-s0', 'done');
    await seedClient.closeRecording('seed-51-s0');

    await provider.handleMessage({ command: 'updateSettings', settings: { activePage: 'contexts' } });
    assert.equal(provider.currentSettings.activePage, 'contexts');
    await provider.handleMessage({ command: 'traceOpenRecording', recordingDir: s0Dir });
    const s0RecId = provider.currentTraceState.selectedRecordId;
    assert.ok(s0RecId, 'Offline Stage 0 recording opened on contexts page');

    // Wait for real Chromium ContextsView to query analysis and draw CPU Load canvas
    await waitFor(
      () => provider.contextsPerfSeq >= 1 && Number(provider.currentContextsPerf?.frameCount || 0) >= 1 && Number(provider.currentContextsPerf?.repliesApplied || 0) >= 1,
      15000,
      'ContextsView initial Chromium render and analysis query',
    );
    report.stage0OfflineContexts = {
      openedOnContextsPage: true,
      contextsPerf: provider.currentContextsPerf,
    };
    await provider.handleMessage({ command: 'traceCloseRecording', recordId: s0RecId });

    // 2. All H723 real archives (4.4 + 4.5 saved copy) verified in real VS Code Contexts page
    for (const [name, dir] of Object.entries(archives)) {
      const prevSeq = provider.contextsPerfSeq;
      const prevReplies = Number(provider.currentContextsPerf?.repliesApplied || 0);
      await provider.handleMessage({ command: 'traceOpenRecording', recordingDir: dir });
      const recId = provider.currentTraceState.selectedRecordId;
      const rec = provider.currentTraceState.records.find(r => r.recordId === recId);
      assert.ok(rec && rec.segments.length > 0, `H723 archive ${name} must have segments`);
      await waitFor(
        () => provider.contextsPerfSeq > prevSeq && Number(provider.currentContextsPerf?.repliesApplied || 0) > prevReplies,
        15000,
        `ContextsView Chromium auto-query & paint for ${name}`,
      );
      report.h723Archives[name] = {
        status: rec.inspectionStatus,
        rawBytes: rec.counters.committedRawBytes,
        segments: rec.segments.length,
        gaps: rec.gaps.length,
        contextsPerf: provider.currentContextsPerf,
      };
      await provider.handleMessage({ command: 'traceCloseRecording', recordId: recId });
    }

    // 3. Hot recording while staying on Contexts page (verifies live timer works on Contexts page too!)
    const folder = vscode.workspace.workspaceFolders[0];
    let liveSession;
    const startTrack = vscode.debug.onDidStartDebugSession(s => {
      if (s.name === 'Hot51Session') liveSession = s;
    });
    try {
      await vscode.debug.startDebugging(folder, {
        type: 'orbit',
        request: 'launch',
        name: 'Hot51Session',
        device: 'STM32H723VGT6',
        traceScenario: {
          sessionId: 'hot-51-1',
          initialChunk: Array.from(contBin),
        },
      });
      await waitFor(() => Boolean(liveSession) && provider.currentState.session.phase === 'connected', 10000, 'Hot51Session connected');
      await vscode.commands.executeCommand('workbench.view.extension.ozone-rtos-panel');
      await vscode.commands.executeCommand('ozoneRtos.focus');
      await waitFor(() => provider.isVisible, 10000, 'RTOS view visible');

      await provider.handleMessage({ command: 'updateSettings', settings: { activePage: 'contexts' } });
      const hotPrevPerfSeq = provider.contextsPerfSeq;
      await provider.handleMessage({ command: 'traceStart', mode: 'continuous' });
      await waitFor(() => {
        const rec = provider.currentTraceState.records.find(r => r.state === 'recording');
        return Boolean(rec && rec.counters.committedRawBytes >= contBin.length && rec.segments.length >= 1);
      }, 15000, 'Hot recording committed & segment refreshed while on Contexts page');
      await waitFor(
        () => provider.contextsPerfSeq > hotPrevPerfSeq
          && Number(provider.currentContextsPerf?.repliesApplied || 0) >= 1
          && Number(provider.currentContextsPerf?.frameCount || 0) >= 1
          && Number(provider.currentContextsPerf?.lastBins || 0) >= 1,
        15000,
        () => `ContextsView painted hot recording stats while live (perf=${JSON.stringify(provider.currentContextsPerf)})`,
      );

      const activeRec = provider.currentTraceState.records.find(r => r.state === 'recording');
      await provider.handleMessage({ command: 'traceStop', recordId: activeRec.recordId });
      await waitFor(() => coordinator.getStatus(activeRec.recordId)?.state === 'stopped', 10000, 'Hot recording stopped');
      assert.equal(adapters[0].haltedOrReset, false);

      report.hotRecordingContexts = {
        committedRawBytes: coordinator.getStatus(activeRec.recordId)?.counters.committedRawBytes,
        haltedOrReset: adapters[0].haltedOrReset,
        contextsPerf: provider.currentContextsPerf,
      };
    } finally {
      startTrack.dispose();
      if (liveSession) await vscode.debug.stopDebugging(liveSession);
      await waitFor(() => provider.currentState.session.phase === 'none', 10000, 'Hot51Session terminated');
    }

    // 4. 1,002,005-event recording in real VS Code + rapid range switches on Contexts page + Trace A/B retention check
    const preamble = contBin.subarray(0, 31);
    const taskCreate = Uint8Array.from([8, 0x40, 1]);
    const cycle = Uint8Array.from([6, 0x40, 2, 4, 0x40, 3, 2, 17, 5, 3, 7, 5, 11, 17, 2]);
    const cycles = 167_000;
    const raw1M = new Uint8Array(preamble.length + taskCreate.length + cycles * cycle.length + 2);
    raw1M.set(preamble, 0);
    raw1M.set(taskCreate, preamble.length);
    let pos = preamble.length + taskCreate.length;
    for (let i = 0; i < cycles; i++) {
      raw1M.set(cycle, pos);
      pos += cycle.length;
    }
    raw1M[pos] = 11;
    raw1M[pos + 1] = 1;

    const dir1M = path.join(tmpDir, 'rec-1m');
    await seedClient.createRecording({
      recordingDir: dir1M,
      recordId: 'seed-51-1m',
      identity: { sessionId: 's-51-1m', sessionGeneration: 1, bootGeneration: 1, recordId: 'seed-51-1m' },
      commitOnEachIngest: false,
    });
    const chunkBytes = 32 * 1024;
    let seq = 1;
    for (let off = 0; off < raw1M.length; off += chunkBytes) {
      const r = await seedClient.ingestChunk({
        recordId: 'seed-51-1m',
        sessionId: 's-51-1m',
        sessionGeneration: 1,
        batchSequence: seq++,
        chunk: raw1M.subarray(off, Math.min(raw1M.length, off + chunkBytes)),
      });
      assert.equal(r.ok, true);
    }
    const fin1M = await seedClient.finishRecording('seed-51-1m', 'done-1m');
    assert.equal(fin1M.ok, true);
    await seedClient.closeRecording('seed-51-1m');

    const pre1MReplies = Number(provider.currentContextsPerf?.repliesApplied || 0);
    await provider.handleMessage({ command: 'traceOpenRecording', recordingDir: dir1M });
    await waitFor(
      () => Number(provider.currentContextsPerf?.repliesApplied || 0) > pre1MReplies,
      15000,
      '1M-event initial Chromium query painted',
    );
    const rec1MId = provider.currentTraceState.selectedRecordId;
    const rec1M = provider.currentTraceState.records.find(r => r.recordId === rec1MId);
    const seg1M = rec1M?.segments?.[0];
    assert.ok(seg1M && seg1M.minNs && seg1M.maxNs);

    const minNs = BigInt(seg1M.minNs);
    const maxNs = BigInt(seg1M.maxNs);
    const spanNs = maxNs - minNs;
    const rapidPrevSeq = provider.contextsPerfSeq;
    const tRapid0 = Date.now();
    const rapidPromises = [];
    for (let i = 1; i <= 10; i++) {
      const s = minNs + (spanNs * BigInt(i)) / 20n;
      const e = s + spanNs / 4n;
      rapidPromises.push(provider.handleMessage({
        command: 'traceQueryAnalysis',
        querySeq: 500 + i,
        recordId: rec1MId,
        unit: 'ns',
        scopeKey: '1:1',
        sourceKind: i === 10 ? 'selection' : 'viewport',
        bootGeneration: 1,
        segmentId: 1,
        start: s.toString(),
        end: e.toString(),
        maxBins: 120,
      }));
    }
    await Promise.all(rapidPromises);
    await waitFor(
      () => provider.contextsPerfSeq > rapidPrevSeq
        && Number(provider.currentContextsPerf?.lastBins || 0) === 120,
      15000,
      () => `1M-event settled analysis reply (120 bins) painted in ContextsView (perf=${JSON.stringify(provider.currentContextsPerf)})`,
    );
    const rapid10SwitchesMs = Date.now() - tRapid0;
    const settled1MContextsPerf = provider.currentContextsPerf;

    // Also switch back to Trace Timeline and verify A/B + canvas still works seamlessly
    const tracePerfBefore = provider.tracePerfSeq;
    await provider.handleMessage({ command: 'updateSettings', settings: { activePage: 'trace' } });
    await waitFor(() => provider.tracePerfSeq > tracePerfBefore, 10000, 'Trace Timeline still paints after Contexts');
    await provider.handleMessage({
      command: 'traceInspectPoint',
      targetKind: 'cursorA',
      querySeq: 901,
      recordId: rec1MId,
      unit: 'ns',
      queryTime: (minNs + spanNs / 4n).toString(),
      queryStart: (minNs + spanNs / 8n).toString(),
      queryEnd: (minNs + spanNs / 3n).toString(),
      bootGeneration: 1,
      segmentId: 1,
    });

    report.millionEventsContexts = {
      packets: fin1M.data.committed.packetCount,
      rapid10SwitchesMs,
      contextsPerf: settled1MContextsPerf,
      tracePerf: provider.currentTracePerf,
    };

    // 5. Light & Dark theme switch while on Contexts
    await provider.handleMessage({ command: 'updateSettings', settings: { activePage: 'contexts' } });
    const workbenchCfg = vscode.workspace.getConfiguration('workbench');
    await workbenchCfg.update('colorTheme', 'Default Light Modern', vscode.ConfigurationTarget.Workspace);
    await delay(250);
    await workbenchCfg.update('colorTheme', 'Default Dark Modern', vscode.ConfigurationTarget.Workspace);
    await delay(250);
    report.themeAndLifecycle = {
      themesTested: ['Default Light Modern', 'Default Dark Modern'],
      visibleAfterThemeSwitch: provider.isVisible,
      activePage: provider.currentSettings.activePage,
    };

    await provider.handleMessage({ command: 'traceCloseRecording', recordId: rec1MId });
    report.ok = true;
    await fsp.writeFile(reportPath, JSON.stringify(report, null, 2));
  } finally {
    factory.dispose();
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
};
