'use strict';
const vscode = require('vscode');
const fs = require('node:fs');
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
    this.commands = [];
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
      downBuffers: this.scenario.postMortemCompiled
        ? []
        : [
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
    this.commands.push(`${msg.command}:${args.action || ''}`);
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
            elfSha256: 'feedface',
            layoutId: 'layout-45',
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
      case 'orbitTraceTarget': {
        const body = {
          ok: true,
          identity: {
            sessionId: this.scenario.sessionId,
            sessionGeneration: 1,
            bootGeneration: 1,
            operationGeneration: 1,
            elfSha256: 'feedface',
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
              postMortemCompiled: Boolean(this.scenario.postMortemCompiled),
              fields: {},
            },
          },
          globalsValues: { enableState: this.enableState, dropCount: 0 },
        };
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
          this.sendResponse(msg, body);
        }
        break;
      }
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
  const reportPath = process.env.ORBIT_RTOS_STAGE45_REPORT;
  const archives = JSON.parse(process.env.ORBIT_RTOS_STAGE45_ARCHIVES || '{}');

  const ext = vscode.extensions.getExtension('orbit-debug.orbit-for-vscode');
  assert.ok(ext, 'orbit-for-vscode extension must be present');
  const api = await ext.activate();
  const provider = api?.rtosProvider;
  const coordinator = api?.traceCoordinator;
  assert.ok(provider && coordinator, 'Test extension mode must expose rtosProvider and traceCoordinator');

  await vscode.commands.executeCommand('workbench.view.extension.ozone-rtos-panel');
  await vscode.commands.executeCommand('ozoneRtos.focus');
  await waitFor(() => provider.isVisible && provider.readyCount >= 1, 15000, 'RTOS webview ready');

  await provider.handleMessage({ command: 'updateSettings', settings: { activePage: 'trace' } });
  assert.equal(provider.currentSettings.activePage, 'trace');

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'orbit-vs45-'));
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
    stage0Offline: {},
    h723Archives: {},
    hotRecording: {},
    millionEvents: {},
    themeAndLifecycle: {},
  };

  try {
    // 1. Offline Stage 0 sample (continuous.bin) with NO active debug session -> save copy -> reopen
    const s0Dir = path.join(tmpDir, 's0-cont');
    const contBin = await fsp.readFile(path.join(workspaceRoot, 'scripts/rtos/fixtures/samples/continuous.bin'));
    const seedClient = coordinator.ensureWorker ? coordinator.ensureWorker() : null;
    assert.ok(seedClient, 'TraceWorkerClient available through coordinator');

    await seedClient.createRecording({
      recordingDir: s0Dir,
      recordId: 'seed-s0-cont',
      identity: { sessionId: 's0', sessionGeneration: 1, bootGeneration: 1, recordId: 'seed-s0-cont' },
      commitOnEachIngest: true,
    });
    await seedClient.ingestChunk({
      recordId: 'seed-s0-cont',
      sessionId: 's0',
      sessionGeneration: 1,
      batchSequence: 1,
      chunk: contBin,
      flush: true,
    });
    await seedClient.finishRecording('seed-s0-cont', 'stage0-done');
    await seedClient.closeRecording('seed-s0-cont');

    assert.equal(provider.currentState.session.phase, 'none');
    await provider.handleMessage({ command: 'traceOpenRecording', recordingDir: s0Dir });
    const s0RecId = provider.currentTraceState.selectedRecordId;
    assert.ok(s0RecId, 'Offline Stage 0 recording opened without debug session');
    const s0Rec = provider.currentTraceState.records.find(r => r.recordId === s0RecId);
    assert.equal(s0Rec.source, 'offline');
    assert.ok(s0Rec.counters.packetsDecoded >= 10, 'Stage 0 continuous.bin must decode packets');

    const s0SaveDir = path.join(tmpDir, 's0-cont-saved');
    await provider.handleMessage({ command: 'traceSaveRecording', recordId: s0RecId, targetDir: s0SaveDir });
    assert.equal(provider.currentTraceState.lastActionMessage?.tone, 'ok');
    await provider.handleMessage({ command: 'traceCloseRecording', recordId: s0RecId });
    await provider.handleMessage({ command: 'traceOpenRecording', recordingDir: s0SaveDir });
    const reopenedId = provider.currentTraceState.selectedRecordId;
    assert.ok(reopenedId && reopenedId !== s0RecId);

    // Exact query on reopened Stage 0 recording
    await provider.handleMessage({
      command: 'traceQueryViewport',
      querySeq: 1,
      recordId: reopenedId,
      unit: 'relative-ticks',
      scopeKey: '1:1',
      bootGeneration: 1,
      segmentId: 1,
      start: '0',
      end: '1000',
      maxBuckets: 128,
    });
    await provider.handleMessage({
      command: 'traceInspectPoint',
      querySeq: 1,
      targetKind: 'cursorA',
      recordId: reopenedId,
      unit: 'relative-ticks',
      queryTime: '20',
      queryStart: '20',
      queryEnd: '21',
      bootGeneration: 1,
      segmentId: 1,
    });
    report.stage0Offline = {
      openedWithoutSession: true,
      savedAndReopened: true,
      packetsDecoded: s0Rec.counters.packetsDecoded,
      segments: s0Rec.segments.length,
    };
    await provider.handleMessage({ command: 'traceCloseRecording', recordId: reopenedId });

    // 2. Real H723 archives (copies) verification in VS Code host
    for (const [name, dir] of Object.entries(archives)) {
      await provider.handleMessage({ command: 'traceOpenRecording', recordingDir: dir });
      const recId = provider.currentTraceState.selectedRecordId;
      const rec = provider.currentTraceState.records.find(r => r.recordId === recId);
      assert.ok(rec && rec.segments.length > 0, `H723 archive ${name} must have segments`);
      const firstSeg = rec.segments[0];
      await provider.handleMessage({
        command: 'traceQueryViewport',
        querySeq: 10,
        recordId: recId,
        unit: 'relative-ticks',
        scopeKey: `${firstSeg.bootGeneration}:${firstSeg.segmentId}`,
        bootGeneration: firstSeg.bootGeneration,
        segmentId: firstSeg.segmentId,
        start: firstSeg.minRelativeTicks,
        end: (BigInt(firstSeg.maxRelativeTicks) > BigInt(firstSeg.minRelativeTicks) ? firstSeg.maxRelativeTicks : (BigInt(firstSeg.minRelativeTicks) + 100n).toString()),
        maxBuckets: 256,
      });
      report.h723Archives[name] = {
        status: rec.inspectionStatus,
        integrity: rec.integrity,
        rawBytes: rec.counters.committedRawBytes,
        packets: rec.counters.packetsDecoded,
        segments: rec.segments.length,
        gaps: rec.gaps.length,
      };
      await provider.handleMessage({ command: 'traceCloseRecording', recordId: recId });
    }

    // 3. Hot Continuous Recording + Auto-Follow + Hide/Recreate survival + Mode Mismatch (no auto halt/reset)
    const folder = vscode.workspace.workspaceFolders[0];
    let liveSession;
    const startTrack = vscode.debug.onDidStartDebugSession(s => {
      if (s.name === 'HotTraceSession') liveSession = s;
    });
    try {
      await vscode.debug.startDebugging(folder, {
        type: 'orbit',
        request: 'launch',
        name: 'HotTraceSession',
        device: 'STM32H723VGT6',
        traceScenario: {
          sessionId: 'hot-vs-1',
          postMortemCompiled: false,
          initialChunk: Array.from(contBin),
        },
      });
      await waitFor(() => Boolean(liveSession) && provider.currentState.session.phase === 'connected', 10000, 'HotTraceSession connected');
      // VS Code switches to the Debug sidebar on first debug launch; focus RTOS view to simulate visible Trace panel.
      await vscode.commands.executeCommand('workbench.view.extension.ozone-rtos-panel');
      await vscode.commands.executeCommand('ozoneRtos.focus');
      await waitFor(() => provider.isVisible, 10000, 'RTOS view visible for hot trace');
      await provider.handleMessage({ command: 'traceInspectTarget' });
      await waitFor(() => provider.currentTraceState.targetProbe?.sysViewUpFound === true, 10000, 'SysView channel probed');

      await provider.handleMessage({ command: 'traceStart', mode: 'continuous' });
      await waitFor(() => {
        const rec = provider.currentTraceState.records.find(r => r.state === 'recording');
        return Boolean(rec && rec.counters.committedRawBytes >= contBin.length);
      }, 10000, () => `Hot continuous recording committed bytes; state=${JSON.stringify({ records: provider.currentTraceState.records.map(r => ({ id: r.recordId, state: r.state, phase: r.phaseDetail, err: r.error, counters: r.counters })), msg: provider.currentTraceState.lastActionMessage })}`);

      const activeRec = provider.currentTraceState.records.find(r => r.state === 'recording');
      assert.equal(provider.currentSettings.traceAutoFollow, true);

      // Hide and recreate view while recording is active -> recording MUST stay active!
      const prevReady = provider.readyCount;
      await vscode.commands.executeCommand('workbench.view.extension.ozone-watch-panel');
      await waitFor(() => !provider.isVisible, 10000, 'RTOS view hidden');
      assert.equal(coordinator.getStatus(activeRec.recordId)?.state, 'recording');

      await vscode.commands.executeCommand('vscode.moveViews', { viewIds: ['ozoneRtos'], destinationId: 'workbench.view.explorer' });
      await vscode.commands.executeCommand('ozoneRtos.focus');
      await waitFor(() => provider.readyCount > prevReady && provider.isVisible, 10000, 'RTOS view recreated in Explorer');
      const explorerReadyCount = provider.readyCount;
      assert.equal(coordinator.getStatus(activeRec.recordId)?.state, 'recording');

      // Wait for real Chromium Webview render/data message while hosted in Explorer before restoring.
      const perfSeqBeforeRestore = provider.tracePerfSeq;
      await waitFor(() => provider.tracePerfSeq > perfSeqBeforeRestore || Boolean(provider.currentTracePerf?.frameCount >= 1), 10000, 'Explorer hosted Trace Webview render proof');

      // Use VS Code's built-in view-location reset command (restores empty hideIfEmpty container + expanded visible view + openView)
      const registeredCommands = await vscode.commands.getCommands(true);
      assert.ok(registeredCommands.includes('ozoneRtos.resetViewLocation'), 'Built-in ozoneRtos.resetViewLocation command must exist');
      const prevPerfSeqRestore = provider.tracePerfSeq;
      await vscode.commands.executeCommand('ozoneRtos.resetViewLocation');
      await waitFor(() => provider.isVisible, 10000, () => `RTOS view restored to panel (visible=${provider.isVisible}, ready=${provider.readyCount}, perfSeq=${provider.tracePerfSeq})`);

      // Verify restored view really lives back in Panel (switching Panel to Watch hides it, switching back shows it)
      // and proves genuine restored Webview rendering + active recording continuity without forcing fake ready counts.
      await waitFor(() => provider.tracePerfSeq > prevPerfSeqRestore && Number(provider.currentTracePerf?.frameCount || 0) >= 1, 10000, () => `Restored RTOS Webview render/message proof (visible=${provider.isVisible}, ready=${provider.readyCount}, perfSeq=${provider.tracePerfSeq}/${prevPerfSeqRestore})`);
      assert.equal(coordinator.getStatus(activeRec.recordId)?.state, 'recording');

      await vscode.commands.executeCommand('workbench.view.extension.ozone-watch-panel');
      await waitFor(() => !provider.isVisible, 10000, 'Restored RTOS view hidden when Panel switches to Watch');
      await vscode.commands.executeCommand('workbench.view.extension.ozone-rtos-panel');
      await vscode.commands.executeCommand('ozoneRtos.focus');
      await waitFor(() => provider.isVisible, 10000, 'Restored RTOS view visible again in RTOS Panel');
      assert.equal(coordinator.getStatus(activeRec.recordId)?.state, 'recording');

      // Manual pan exits Auto-Follow
      await provider.handleMessage({ command: 'updateSettings', settings: { traceAutoFollow: false } });
      assert.equal(provider.currentSettings.traceAutoFollow, false);

      // Stop recording cleanly
      await provider.handleMessage({ command: 'traceStop', recordId: activeRec.recordId });
      await waitFor(() => coordinator.getStatus(activeRec.recordId)?.state === 'stopped', 10000, 'Hot recording stopped');
      assert.equal(adapters[0].haltedOrReset, false);

      report.hotRecording = {
        probedUpChannel: provider.currentTraceState.targetProbe?.upChannelIndex,
        committedRawBytes: coordinator.getStatus(activeRec.recordId)?.counters.committedRawBytes,
        explorerReadyCount,
        restoredReadyCount: provider.readyCount,
        restoredPerfSeq: provider.tracePerfSeq,
        restoredPanelHideShowVerified: true,
        survivedHideAndRecreate: true,
        haltedOrReset: adapters[0].haltedOrReset,
      };
    } finally {
      startTrack.dispose();
      if (liveSession) await vscode.debug.stopDebugging(liveSession);
      await waitFor(() => provider.currentState.session.phase === 'none', 10000, 'HotTraceSession terminated');
    }

    // 4. 1,002,005-event recording in real VS Code + rapid consecutive range switching + Chromium frame metrics
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
    const tCreate0 = Date.now();
    await seedClient.createRecording({
      recordingDir: dir1M,
      recordId: 'seed-1m',
      identity: { sessionId: 's-1m', sessionGeneration: 1, bootGeneration: 1, recordId: 'seed-1m' },
      commitOnEachIngest: false,
    });
    const chunkBytes = 32 * 1024;
    let seq = 1;
    for (let off = 0; off < raw1M.length; off += chunkBytes) {
      const r = await seedClient.ingestChunk({
        recordId: 'seed-1m',
        sessionId: 's-1m',
        sessionGeneration: 1,
        batchSequence: seq++,
        chunk: raw1M.subarray(off, Math.min(raw1M.length, off + chunkBytes)),
      });
      assert.equal(r.ok, true);
    }
    const fin1M = await seedClient.finishRecording('seed-1m', 'done-1m');
    assert.equal(fin1M.ok, true);
    const ingestTotalMs = Date.now() - tCreate0;
    const workerStats1M = await seedClient.getStats('seed-1m');
    const hostStats1M = seedClient.getHostStats();
    await seedClient.closeRecording('seed-1m');

    const tOpen0 = Date.now();
    await provider.handleMessage({ command: 'traceOpenRecording', recordingDir: dir1M });
    const openMs = Date.now() - tOpen0;
    const rec1MId = provider.currentTraceState.selectedRecordId;
    const rec1M = provider.currentTraceState.records.find(r => r.recordId === rec1MId);
    const seg1M = rec1M?.segments?.[0];
    assert.ok(seg1M && seg1M.minNs && seg1M.maxNs, '1M recording must have anchored ns bounds');
    await delay(250);

    // Rapid consecutive range switches inside real VS Code + Chromium Webview (concurrent firing to exercise cancellation)
    const minNs1M = BigInt(seg1M.minNs);
    const maxNs1M = BigInt(seg1M.maxNs);
    const span1M = maxNs1M > minNs1M ? maxNs1M - minNs1M : 1_000_000n;
    const tRapid0 = Date.now();
    const rapidPromises = [];
    for (let i = 1; i <= 10; i++) {
      const sliceStart = minNs1M + (span1M * BigInt(i)) / 20n;
      const sliceEnd = sliceStart + (span1M / 4n > 1000n ? span1M / 4n : 1000n);
      rapidPromises.push(provider.handleMessage({
        command: 'traceQueryViewport',
        querySeq: 100 + i,
        recordId: rec1MId,
        unit: 'ns',
        scopeKey: '1:1',
        bootGeneration: 1,
        segmentId: 1,
        start: sliceStart.toString(),
        end: sliceEnd.toString(),
        maxBuckets: 256,
      }));
    }
    await Promise.all(rapidPromises);
    const rapidSwitchTotalMs = Date.now() - tRapid0;
    const midNs1M = (minNs1M + maxNs1M) / 2n;
    await provider.handleMessage({
      command: 'traceInspectPoint',
      querySeq: 200,
      targetKind: 'cursorA',
      recordId: rec1MId,
      unit: 'ns',
      queryTime: midNs1M.toString(),
      queryStart: midNs1M.toString(),
      queryEnd: (midNs1M + 1000n).toString(),
      bootGeneration: 1,
      segmentId: 1,
    });
    await waitFor(() => Boolean(provider.currentTracePerf && provider.currentTracePerf.frameCount >= 1 && provider.currentTracePerf.viewportRepliesApplied >= 1), 10000, 'Chromium Trace canvas perf report');

    // Mode mismatch guard: continuous start on Post-Mortem firmware must fail without halt/reset
    let pmMismatchSession;
    const pmTrack = vscode.debug.onDidStartDebugSession(s => {
      if (s.name === 'PostMortemMismatchSession') pmMismatchSession = s;
    });
    try {
      await vscode.debug.startDebugging(folder, {
        type: 'orbit',
        request: 'launch',
        name: 'PostMortemMismatchSession',
        device: 'STM32H723VGT6',
        traceScenario: {
          sessionId: 'pm-mismatch-1',
          postMortemCompiled: true,
        },
      });
      await waitFor(() => Boolean(pmMismatchSession), 10000, 'PostMortemMismatchSession started');
      await vscode.commands.executeCommand('ozoneRtos.focus');
      await waitFor(() => provider.isVisible && provider.currentState.session.phase === 'connected', 10000, 'PostMortemMismatchSession connected');
      await provider.handleMessage({ command: 'traceStart', mode: 'continuous' });
      const errRec = provider.currentTraceState.records.find(r => r.error?.errorCode === 'TraceModeMismatch');
      assert.ok(errRec, 'Must surface TraceModeMismatch without halting/resetting target');
      assert.equal(adapters[adapters.length - 1].haltedOrReset, false);
      report.hotRecording.modeMismatchBlockedWithoutHalt = true;
    } finally {
      pmTrack.dispose();
      if (pmMismatchSession) await vscode.debug.stopDebugging(pmMismatchSession);
      await waitFor(() => provider.currentState.session.phase === 'none', 10000, 'PostMortemMismatchSession terminated');
    }

    report.millionEvents = {
      packets: fin1M.data.committed.packetCount,
      rawBytes: fin1M.data.committed.rawBytes,
      ingestTotalMs,
      openMs,
      rapid10SwitchesMs: rapidSwitchTotalMs,
      webviewPerf: provider.currentTracePerf,
      workerStats: workerStats1M.ok ? workerStats1M.data.records['seed-1m'] : null,
      hostClientStats: hostStats1M,
    };

    // 5. Light & Dark theme switch
    const workbenchCfg = vscode.workspace.getConfiguration('workbench');
    await workbenchCfg.update('colorTheme', 'Default Light Modern', vscode.ConfigurationTarget.Workspace);
    await delay(250);
    await workbenchCfg.update('colorTheme', 'Default Dark Modern', vscode.ConfigurationTarget.Workspace);
    await delay(250);
    report.themeAndLifecycle = { themesTested: ['Default Light Modern', 'Default Dark Modern'], visibleAfterThemeSwitch: provider.isVisible };

    await provider.handleMessage({ command: 'traceCloseRecording', recordId: rec1MId });
    report.ok = true;
    await fsp.writeFile(reportPath, JSON.stringify(report, null, 2));
  } finally {
    factory.dispose();
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
};
