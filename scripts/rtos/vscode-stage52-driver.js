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

function encodeVarint(v) {
  const out = [];
  let x = v >>> 0;
  while (x >= 0x80) {
    out.push((x & 0x7f) | 0x80);
    x >>>= 7;
  }
  out.push(x);
  return out;
}

function makePacket(eventId, payload, deltaTicks, explicit = eventId >= 24) {
  if (explicit) {
    return [...encodeVarint(eventId), ...encodeVarint(payload.length), ...payload, ...encodeVarint(deltaTicks)];
  }
  return [eventId, ...payload, ...encodeVarint(deltaTicks)];
}

function makeInitPacket(sysFreqHz, cpuFreqHz, ramBase, idShift, deltaTicks = 0) {
  return makePacket(
    24,
    [...encodeVarint(sysFreqHz), ...encodeVarint(cpuFreqHz), ...encodeVarint(ramBase), ...encodeVarint(idShift)],
    deltaTicks,
    true,
  );
}

function makePrintPacket(text, options, args, deltaTicks) {
  const bytes = Array.from(Buffer.from(text, 'utf8'));
  const payload = [bytes.length, ...bytes, ...encodeVarint(options), ...encodeVarint(args.length), ...args.flatMap(a => encodeVarint(a))];
  return makePacket(26, payload, deltaTicks, true);
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
      upBuffers: [{ direction: 'up', index: 1, bufferAddress: 0x20002000, status: 'valid', name: 'SysView', nameStatus: 'ok', valid: true, bufferSize: 8192, rdOff: 0, wrOff: 0 }],
      downBuffers: [{ direction: 'down', index: 1, bufferAddress: 0x20003000, status: 'valid', name: 'SysView', nameStatus: 'ok', valid: true, bufferSize: 16, rdOff: 1, wrOff: 1 }],
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
            elfSha256: 'feedface52',
            layoutId: 'layout-52',
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
              elfSha256: 'feedface52',
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
  const reportPath = process.env.ORBIT_RTOS_STAGE52_REPORT;
  const archives = JSON.parse(process.env.ORBIT_RTOS_STAGE52_ARCHIVES || '{}');

  const ext = vscode.extensions.getExtension('orbit-debug.orbit-for-vscode');
  assert.ok(ext, 'orbit-for-vscode extension must be present');
  const api = await ext.activate();
  const provider = api?.rtosProvider;
  const coordinator = api?.traceCoordinator;
  assert.ok(provider && coordinator, 'Test extension mode must expose rtosProvider and traceCoordinator');

  await vscode.commands.executeCommand('workbench.view.extension.ozone-rtos-panel');
  await vscode.commands.executeCommand('ozoneRtos.focus');
  await waitFor(() => provider.isVisible && provider.readyCount >= 1, 15000, 'RTOS webview ready');

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'orbit-vs52-'));
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
    h723TerminalReadyRegression: null,
    stage0Samples: {},
    codexOracle: null,
    h723Archives: {},
    anomalyDiagnostics: null,
    millionEventsUi: null,
    hotRecordingEvents: null,
    themeAndLifecycle: null,
  };

  try {
    const seedClient = coordinator.ensureWorker();
    assert.ok(seedClient, 'TraceWorkerClient available');

    // 0. Real H723 Offline Archive Regression (codex-h723-host-start-stopped: Orbit H723 SystemView ready @b2:s1:p24@254)
    if (archives.h723TerminalReadyArchive) {
      console.log('[stage5.2-driver] step 0: h723 terminal ready + bidirectional DOM regression');
      await provider.handleMessage({ command: 'updateSettings', settings: { activePage: 'contexts', traceTimeUnit: 'ns', traceAutoFollow: true } });
      await provider.handleMessage({ command: 'traceOpenRecording', recordingDir: archives.h723TerminalReadyArchive });
      const h723RecId = provider.currentTraceState.selectedRecordId;
      assert.ok(h723RecId, 'h723TerminalReadyArchive opened');
      await waitFor(async () => {
        const st = await provider.invokeUiAction('contexts.getState').catch(() => null);
        return st && st.recordId === h723RecId;
      }, 15000, 'ContextsView mounted with h723TerminalReadyArchive');

      // Ensure fresh default scope & viewport before entering Trace Terminal first time
      await provider.invokeUiAction('contexts.setScopeKey', { scopeKey: 'all-anchored' });
      await provider.invokeUiAction('contexts.setRangeSource', { source: 'viewport' });
      const termPrev = provider.terminalPerfSeq;
      await provider.invokeUiAction('contexts.setSubTab', { tab: 'terminal' });

      const readyTermState = await waitFor(async () => {
        if (provider.terminalPerfSeq <= termPrev) return null;
        const st = await provider.invokeUiAction('terminal.getState').catch(() => null);
        return st &&
          st.recordId === h723RecId &&
          !st.isStale &&
          Array.isArray(st.domLineTexts) &&
          st.domLineTexts.some(t => t.includes('Orbit H723 SystemView ready'))
          ? st
          : null;
      }, 15000, 'First-entry Trace Terminal rendered Orbit H723 SystemView ready without starvation');

      // Verify static archive does NOT self-excite / loop requests on idle
      const idleStart = readyTermState.perf;
      await delay(600);
      const afterIdleTermState = await provider.invokeUiAction('terminal.getState');
      assert.equal(afterIdleTermState.perf.queriesSent, idleStart.queriesSent, 'static archive must not loop terminal queries');
      assert.equal(afterIdleTermState.perf.diagRequestsSent, idleStart.diagRequestsSent, 'static archive must not self-excite diagnostics queries');
      assert.equal(afterIdleTermState.perf.repliesApplied, idleStart.repliesApplied, 'static archive repliesApplied stays idle');

      // Click the REAL DOM "定位Trace" button on "Orbit H723 SystemView ready"
      const traceBeforeJump = provider.tracePerfSeq;
      const jumpClickRes = await provider.invokeUiAction('terminal.clickJumpToTimelineByText', { text: 'Orbit H723 SystemView ready' });
      assert.equal(jumpClickRes.foundLine, true, 'Found DOM terminal line for Orbit H723 SystemView ready');
      assert.equal(jumpClickRes.clicked, true, 'Clicked DOM 定位Trace button');

      const tlJumpState = await waitFor(async () => {
        if (provider.currentSettings.activePage !== 'trace' || provider.tracePerfSeq <= traceBeforeJump) return null;
        const st = await provider.invokeUiAction('timeline.getState').catch(() => null);
        return st &&
          st.recordId === h723RecId &&
          st.unit === 'relative-ns' &&
          st.scopeKey === '2:1' &&
          st.cursorA &&
          st.jumpToEventsButtonPresent
          ? st
          : null;
      }, 15000, 'Terminal -> Trace Timeline placed Cursor A & showed 在 Events 中定位 button on relative-ns fallback');

      assert.ok(!String(tlJumpState.cursorBarText).includes('点击泳道放置游标 A'), 'Cursor A placeholder must be replaced');
      assert.equal(tlJumpState.cursorA.unit, 'relative-ns');
      assert.equal(tlJumpState.cursorA.timeStr, '100037015');

      // Allow cursorAInspect packets to arrive asynchronously, then click REAL DOM "在 Events 中定位"
      await delay(300);
      const evBackPrev = provider.eventsPerfSeq;
      const backClickRes = await provider.invokeUiAction('timeline.clickJumpToEventsButton');
      assert.equal(backClickRes.clicked, true, 'Clicked DOM 在 Events 中定位 button');

      const evBackState = await waitFor(async () => {
        if (provider.currentSettings.activePage !== 'contexts' || provider.eventsPerfSeq <= evBackPrev) return null;
        const st = await provider.invokeUiAction('events.getState').catch(() => null);
        return st &&
          st.recordId === h723RecId &&
          !st.isStale &&
          st.selectedEventKey === 'b2:s1:p24@254' &&
          st.focusedEventKey === 'b2:s1:p24@254' &&
          st.detailText.includes('Orbit H723 SystemView ready')
          ? st
          : null;
      }, 15000, 'Timeline -> Events preserved exact b2:s1:p24@254 identity');

      report.h723TerminalReadyRegression = {
        terminalFirstEntryLines: readyTermState.domLines,
        staticIdleQueriesDelta: afterIdleTermState.perf.queriesSent - idleStart.queriesSent,
        staticIdleDiagDelta: afterIdleTermState.perf.diagRequestsSent - idleStart.diagRequestsSent,
        timelineUnit: tlJumpState.unit,
        timelineScopeKey: tlJumpState.scopeKey,
        timelineCursorATimeStr: tlJumpState.cursorA.timeStr,
        jumpToEventsButtonPresent: tlJumpState.jumpToEventsButtonPresent,
        roundTripSelectedEventKey: evBackState.selectedEventKey,
        roundTripFocusedEventKey: evBackState.focusedEventKey,
      };
      await provider.handleMessage({ command: 'traceCloseRecording', recordId: h723RecId });
    }

    const openAndWaitEventsAndTerminal = async (recDir, label, expectFullRange = true) => {
      console.log(`[stage5.2-driver] open ${label}`);
      await provider.handleMessage({ command: 'updateSettings', settings: { activePage: 'contexts' } });
      await provider.handleMessage({ command: 'traceOpenRecording', recordingDir: recDir });
      const recId = provider.currentTraceState.selectedRecordId;
      assert.ok(recId, `${label}: recording opened`);
      await waitFor(async () => {
        const st = await provider.invokeUiAction('contexts.getState').catch(() => null);
        return Boolean(st && st.recordId === recId);
      }, 15000, `${label}: ContextsView mounted with ${recId}`);

      await provider.invokeUiAction('contexts.setSubTab', { tab: 'contexts' });
      if (expectFullRange) {
        await provider.invokeUiAction('contexts.setRangeSource', { source: 'full' });
      }
      const evPrev = provider.eventsPerfSeq;
      await provider.invokeUiAction('contexts.setSubTab', { tab: 'events' });
      const evState = await waitFor(async () => {
        if (provider.eventsPerfSeq <= evPrev) return null;
        const st = await provider.invokeUiAction('events.getState').catch(() => null);
        return st && st.recordId === recId && st.domVrows > 0 ? st : null;
      }, 15000, `${label}: EventsView painted`);

      const termPrev = provider.terminalPerfSeq;
      await provider.invokeUiAction('contexts.setSubTab', { tab: 'terminal' });
      const termState = await waitFor(async () => {
        if (provider.terminalPerfSeq <= termPrev) return null;
        const st = await provider.invokeUiAction('terminal.getState').catch(() => null);
        return st && st.recordId === recId ? st : null;
      }, 15000, `${label}: TerminalView painted`);
      return { recId, evState, termState };
    };

    // 1. Stage 0 samples + Bidirectional Events <-> Trace Timeline localization
    const contBin = await fsp.readFile(path.join(workspaceRoot, 'scripts/rtos/fixtures/samples/continuous.bin'));
    for (const sampleName of ['continuous', 'post-mortem', 'continuous-overflow']) {
      const sampleBin = await fsp.readFile(path.join(workspaceRoot, `scripts/rtos/fixtures/samples/${sampleName}.bin`));
      const sDir = path.join(tmpDir, `s0-${sampleName}`);
      await seedClient.createRecording({
        recordingDir: sDir,
        recordId: `seed-52-${sampleName}`,
        identity: { sessionId: `s0-52-${sampleName}`, sessionGeneration: 1, bootGeneration: 1, recordId: `seed-52-${sampleName}` },
        commitOnEachIngest: true,
      });
      await seedClient.ingestChunk({
        recordId: `seed-52-${sampleName}`,
        sessionId: `s0-52-${sampleName}`,
        sessionGeneration: 1,
        bootGeneration: 1,
        batchSequence: 1,
        chunk: sampleBin,
        flush: true,
      });
      await seedClient.finishRecording(`seed-52-${sampleName}`, 'done');
      await seedClient.closeRecording(`seed-52-${sampleName}`);

      const { recId, evState, termState } = await openAndWaitEventsAndTerminal(sDir, `stage0:${sampleName}`);
      assert.ok(evState.totalMatched > 0, `${sampleName}: events totalMatched > 0`);
      assert.ok(evState.domVrows > 0 && evState.domVrows <= 120, `${sampleName}: bounded domVrows`);

      let bidirectionalOk = false;
      if (sampleName === 'continuous') {
        await provider.invokeUiAction('contexts.setSubTab', { tab: 'events' });
        await waitFor(async () => (await provider.invokeUiAction('events.getState')).domVrows > 0, 10000, 'events visible');
        await provider.invokeUiAction('events.clickDomRow', { index: 5 });
        const clickedState = await provider.invokeUiAction('events.getState');
        assert.ok(clickedState.selectedEventKey, 'clicked DOM row selected an event');

        // Jump Events -> Trace Timeline
        const traceBefore = provider.tracePerfSeq;
        await provider.invokeUiAction('events.jumpToSelectedTimeline');
        await waitFor(
          () => provider.currentSettings.activePage === 'trace' && provider.tracePerfSeq > traceBefore,
          15000,
          'Events -> Trace Timeline jump rendered',
        );
        const tlAfterJump = await provider.invokeUiAction('timeline.getState');
        assert.ok(tlAfterJump.cursorA, 'Events jump set Cursor A on Timeline');

        // Jump Trace Timeline -> Events
        const evPrevBack = provider.eventsPerfSeq;
        await provider.invokeUiAction('timeline.setCursorAndJumpToEvents', { timeStr: tlAfterJump.cursorA.timeStr });
        await waitFor(
          () => provider.currentSettings.activePage === 'contexts' && provider.eventsPerfSeq > evPrevBack,
          15000,
          'Trace Timeline -> Events locate rendered',
        );
        const evBack = await provider.invokeUiAction('events.getState');
        assert.ok(evBack.focusedEventKey, 'Timeline jump highlighted focused event in Events');
        bidirectionalOk = true;
      }

      report.stage0Samples[sampleName] = {
        totalMatched: evState.totalMatched,
        domVrows: evState.domVrows,
        terminalLines: termState.totalLines,
        diagnosticsCount: termState.diagnosticsCount,
        ...(bidirectionalOk ? { bidirectionalJumpOk: true } : {}),
      };
      await provider.handleMessage({ command: 'traceCloseRecording', recordId: recId });
    }

    // 2. Codex Independent Oracle Archive (33 events: Queue 4 params, nested IRQ18, literal=%d %x %%, EX_PRINT_ELF unresolved, legacy boot=1)
    if (archives.codexOracleArchive) {
      const { recId, evState, termState } = await openAndWaitEventsAndTerminal(archives.codexOracleArchive, 'codex-oracle');
      assert.ok(evState.totalMatched >= 31 && evState.totalMatched <= 33, `codex oracle UI ns matched >=31 (got ${evState.totalMatched})`);
      const allRelRes = await coordinator.queryEvents(recId, { start: '0', end: '1000000', unit: 'relative-ticks', offset: 0, limit: 50 });
      assert.equal(allRelRes.ok, true);
      assert.equal(allRelRes.data.totalMatched, 33, 'codex oracle relative-ticks must match all 33 events including pre-systime header & TRACE_STOP');
      assert.ok(termState.linesCount >= 4, 'codex oracle must render terminal lines');
      const allTermTexts = termState.lines.map(l => l.renderedText);
      assert.ok(allTermTexts.some(t => t.includes('0x0801FFF0')), 'codex oracle shows unresolved 0x0801FFF0');
      assert.ok(termState.lines.some(l => l.addressStatus === 'no-elf-loaded' && l.formatSource === 'unresolved-address'));

      // Check Filter for OS API (Queue 4 params) & locate packet 23 @182
      await provider.invokeUiAction('contexts.setSubTab', { tab: 'events' });
      await waitFor(async () => {
        const st = await provider.invokeUiAction('events.getState').catch(() => null);
        return st && st.recordId === recId && !st.isStale && st.domVrows > 0;
      }, 10000, 'codex oracle events tab ready');
      await provider.invokeUiAction('events.setFilter', { category: 'os-api', searchText: 'xQueueGenericSend' });
      await waitFor(async () => {
        const st = await provider.invokeUiAction('events.getState').catch(() => null);
        return (
          st &&
          !st.isStale &&
          st.appliedFilter?.category === 'os-api' &&
          st.appliedFilter?.searchText === 'xQueueGenericSend' &&
          st.domVrows >= 1
        );
      }, 15000, 'codex oracle Queue filter applied');
      await provider.invokeUiAction('events.clickDomRow', { index: 0 });
      const apiEvState = await waitFor(async () => {
        const st = await provider.invokeUiAction('events.getState').catch(() => null);
        return st && st.detailText && st.detailText.includes('xQueueGenericSend') ? st : null;
      }, 5000, 'Queue API detail visible in Chromium DOM');
      assert.ok(apiEvState.selectedEventKey && !apiEvState.selectedEventKey.includes('undefined'), 'oracle eventKey has valid boot=1');
      assert.ok(apiEvState.detailText.includes('xQueueGenericSend'), 'Queue API detail visible in Chromium DOM');
      assert.ok(apiEvState.detailText.includes('copyPosition'), 'Queue 4th parameter copyPosition visible');

      const locRes = await coordinator.locateEvent(recId, {
        start: '0',
        end: '1000000',
        unit: 'relative-ticks',
        targetBootGeneration: 1,
        targetSegmentId: 1,
        targetPacketIndex: 23,
        targetByteOffset: 182,
      });
      assert.equal(locRes.ok, true);
      assert.equal(locRes.data.found, true);
      assert.equal(locRes.data.exactMatch, true);

      // TASK_INFO and STACK_INFO share absolute tick 111. Pick the second packet,
      // wait until the inspector shows the first, and verify the DOM button returns the second.
      const stackEventKey = 'b1:s1:p6@52';
      await provider.invokeUiAction('events.setFilter', { category: 'all', searchText: 'STACK_INFO' });
      const stackRow = await waitFor(async () => {
        const st = await provider.invokeUiAction('events.getState');
        if (st.isStale || st.appliedFilter?.searchText !== 'STACK_INFO') return null;
        const index = st.visibleRowSummaries.findIndex(row => row.eventKey === stackEventKey);
        return index >= 0 ? { index } : null;
      }, 10000, 'same-tick STACK_INFO visible');
      assert.equal((await provider.invokeUiAction('events.clickDomRow', stackRow)).clicked, true);
      await waitFor(async () => (await provider.invokeUiAction('events.getState')).selectedEventKey === stackEventKey,
        5000, 'same-tick STACK_INFO selected');
      await provider.invokeUiAction('events.jumpToSelectedTimeline');
      const placed = await waitFor(async () => {
        const state = await provider.invokeUiAction('timeline.getState');
        return state.recordId === recId && state.cursorA && state.jumpToEventsButtonPresent ? state.cursorA : null;
      }, 10000, 'same-tick event placed Cursor A');
      // Deliver a real Worker inspection without moving the cursor by hand, which clears the focused event.
      await provider.handleMessage({
        command: 'traceInspectPoint', targetKind: 'cursorA', querySeq: 1, recordId: recId,
        ...placed, queryTime: placed.timeStr, queryStart: placed.timeStr, queryEnd: (BigInt(placed.timeStr) + 1n).toString(),
      });
      let latestTieCursor;
      const tieCursor = await waitFor(async () => {
        const state = latestTieCursor = await provider.invokeUiAction('timeline.getState');
        return state.recordId === recId && state.jumpToEventsButtonPresent && state.cursorBarText.includes('pkt=TASK_INFO')
          ? state : null;
      }, 10000, 'timeline inspector shows the first of the two same-tick packets').catch(error => {
        throw new Error(`${error.message}: ${JSON.stringify(latestTieCursor)}`);
      });
      assert.equal((await provider.invokeUiAction('timeline.clickJumpToEventsButton')).clicked, true);
      await waitFor(async () => {
        const state = await provider.invokeUiAction('events.getState');
        return state.recordId === recId && !state.isStale && state.focusedEventKey === stackEventKey &&
          state.selectedEventKey === stackEventKey;
      }, 10000, 'timeline return preserves the selected same-tick STACK_INFO packet');

      report.codexOracle = {
        totalMatched: evState.totalMatched,
        terminalLines: termState.totalLines,
        queueEventKey: apiEvState.selectedEventKey,
        locateAt182: { found: locRes.data.found, exactMatch: locRes.data.exactMatch, rowIndex: locRes.data.rowIndex },
        sameTickRoundTrip: { inspectorFirstPacket: 'TASK_INFO', cursorTime: tieCursor.cursorA.timeStr, selectedEventKey: stackEventKey },
      };
      await provider.handleMessage({ command: 'traceCloseRecording', recordId: recId });
    }

    // 3. All 6 H723 real archives verified in real VS Code Chromium UI (Events + Terminal)
    for (const [name, dir] of Object.entries(archives.h723 || {})) {
      const { recId, evState, termState } = await openAndWaitEventsAndTerminal(dir, `h723:${name}`);
      const rec = provider.currentTraceState.records.find(r => r.recordId === recId);
      assert.ok(evState.domVrows > 0 && evState.domVrows <= 120, `${name}: bounded Events DOM`);
      report.h723Archives[name] = {
        status: rec.inspectionStatus,
        rawBytes: rec.counters.committedRawBytes,
        totalMatched: evState.totalMatched,
        domVrows: evState.domVrows,
        terminalLines: termState.totalLines,
        diagnosticsCount: termState.diagnosticsCount,
      };
      await provider.handleMessage({ command: 'traceCloseRecording', recordId: recId });
    }

    // 4. Anomaly, Multi-Boot Reset, Append-Break & Diagnostics recording
    const sync = new Array(10).fill(0);
    const boot1 = new Uint8Array([
      ...sync,
      ...makePacket(10, [], 10, false),
      ...makeInitPacket(1_000_000, 64_000_000, 0x20000000, 2, 0),
      ...makePacket(12, encodeVarint(100), 0, false),
      ...makePacket(2, encodeVarint(17), 5, false),
      ...makePacket(2, encodeVarint(18), 5, false),
      ...makePrintPacket('in_irq=%d', 0, [18], 2),
      ...makePacket(3, [], 3, false),
      ...makePacket(3, [], 5, false),
      ...makePacket(3, [], 2, false), // orphan ISR_EXIT
      ...makePacket(30, [0xde, 0xad], 3, true), // UNKNOWN_30
      ...makePrintPacket('partA', 0, [], 5),
      ...makePacket(31, [...encodeVarint(7), ...encodeVarint(0), ...encodeVarint(2), ...encodeVarint(99)], 5, true), // NULL EX_PRINT_ELF
      ...makePacket(26, [3, 98, 97, 100, 0, ...encodeVarint(200)], 5, true), // print-arg-count-exceeded
    ]);
    const boot2 = new Uint8Array([
      ...sync,
      ...makePacket(10, [], 10, false),
      ...makeInitPacket(1_000_000, 64_000_000, 0x20000000, 2, 0),
      ...makePacket(12, encodeVarint(10), 0, false),
      ...makePrintPacket('partB_after_reset', 64, [], 5), // append=true across reset!
    ]);
    const anomDir = path.join(tmpDir, 'anom-rec');
    const anomStoreId = 'seed-52-anom';
    await seedClient.createRecording({
      recordingDir: anomDir,
      recordId: anomStoreId,
      identity: { sessionId: 's-anom', sessionGeneration: 1, bootGeneration: 1, recordId: anomStoreId },
      commitOnEachIngest: true,
    });
    await seedClient.ingestChunk({ recordId: anomStoreId, sessionId: 's-anom', sessionGeneration: 1, bootGeneration: 1, batchSequence: 1, chunk: boot1, flush: true });
    await seedClient.notifyTargetReset({
      recordId: anomStoreId,
      sessionId: 's-anom',
      sessionGeneration: 1,
      nextBootGeneration: 2,
      reason: 'reset-boundary',
    });
    await seedClient.ingestChunk({ recordId: anomStoreId, sessionId: 's-anom', sessionGeneration: 1, bootGeneration: 2, batchSequence: 2, chunk: boot2, flush: true });
    await seedClient.finishRecording(anomStoreId, 'done');
    await seedClient.closeRecording(anomStoreId);

    const { recId: anomRecId, evState: anomEvState } = await openAndWaitEventsAndTerminal(anomDir, 'anomaly');
    const anomTermBoot2 = await waitFor(async () => {
      const st = await provider.invokeUiAction('terminal.getState').catch(() => null);
      return st && st.recordId === anomRecId && st.diagnosticsCount >= 3 && st.lines.some(l => l.appendBrokenReason) ? st : null;
    }, 10000, 'anomaly Boot2 recording diagnostics & append-break visible');

    // Switch scope to Boot 1 (b1:s1) and verify nested ISR & NULL EX_PRINT_ELF in Terminal
    const boot1TermPrev = provider.terminalPerfSeq;
    await provider.invokeUiAction('contexts.setScopeKey', { scopeKey: '1:1' });
    const anomTermBoot1 = await waitFor(async () => {
      if (provider.terminalPerfSeq <= boot1TermPrev) return null;
      const st = await provider.invokeUiAction('terminal.getState').catch(() => null);
      return st && st.recordId === anomRecId && st.lines.some(l => l.nestedIsr && l.isrDepth === 2) ? st : null;
    }, 10000, 'anomaly Boot1 nested ISR highlighted in Terminal');

    report.anomalyDiagnostics = {
      totalMatched: anomEvState.totalMatched,
      terminalLinesBoot2: anomTermBoot2.totalLines,
      terminalLinesBoot1: anomTermBoot1.totalLines,
      diagnosticsCount: anomTermBoot2.diagnosticsCount,
      domDiagnostics: anomTermBoot2.domDiagnostics,
    };
    await provider.handleMessage({ command: 'traceCloseRecording', recordId: anomRecId });

    // 5. 1,002,005-event Archive Virtual Table Jump + Filter Cancellation in Chromium
    let dir1M = archives.codexMillionArchive;
    if (!dir1M) {
      dir1M = path.join(tmpDir, 'rec-1m');
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
      await seedClient.createRecording({
        recordingDir: dir1M,
        recordId: 'seed-52-1m',
        identity: { sessionId: 's-52-1m', sessionGeneration: 1, bootGeneration: 1, recordId: 'seed-52-1m' },
        commitOnEachIngest: false,
      });
      const chunkBytes = 32 * 1024;
      let seq = 1;
      for (let off = 0; off < raw1M.length; off += chunkBytes) {
        await seedClient.ingestChunk({
          recordId: 'seed-52-1m',
          sessionId: 's-52-1m',
          sessionGeneration: 1,
          bootGeneration: 1,
          batchSequence: seq++,
          chunk: raw1M.subarray(off, Math.min(raw1M.length, off + chunkBytes)),
        });
      }
      await seedClient.finishRecording('seed-52-1m', 'done-1m');
      await seedClient.closeRecording('seed-52-1m');
    }

    console.log('[stage5.2-driver] step 5: 1M archive');
    const { recId: rec1MId, evState: init1M } = await openAndWaitEventsAndTerminal(dir1M, '1M-archive');
    assert.ok(init1M.totalMatched >= 1_000_000, `1M matched >= 1M (got ${init1M.totalMatched})`);
    assert.ok(init1M.domVrows > 0 && init1M.domVrows <= 120, '1M initial DOM rows bounded');

    // Switch back to Events and jump to offset 999,000
    await provider.invokeUiAction('contexts.setSubTab', { tab: 'events' });
    const beforeJumpState = await waitFor(async () => {
      const st = await provider.invokeUiAction('events.getState').catch(() => null);
      return st && st.recordId === rec1MId && !st.isStale && st.domVrows > 0 ? st : null;
    }, 10000, '1M events tab ready before jump');
    const prevJumpSeq = beforeJumpState.appliedQuerySeq || 0;
    const tJump0 = Date.now();
    await provider.invokeUiAction('events.jumpToRow', { rowIndex: 999000 });
    const jumped1MState = await waitFor(
      async () => {
        const st = await provider.invokeUiAction('events.getState').catch(() => null);
        return st &&
          !st.isStale &&
          (st.appliedQuerySeq || 0) > prevJumpSeq &&
          st.appliedFilter?.category === 'all' &&
          st.loadedOffset >= 998000 &&
          st.domVrows > 0 &&
          st.domVrows <= 120
          ? st
          : null;
      },
      20000,
      '1M jump to row 999,000 painted in Chromium',
    );
    const jumpElapsedMs = Date.now() - tJump0;

    // Rapid filter cancellations in Chromium with strict provenance + ISR/IRQ total & row-content assertions
    const prevRapidSeq = jumped1MState.appliedQuerySeq || 0;
    const tRapid0 = Date.now();
    for (let i = 0; i < 6; i++) {
      await provider.invokeUiAction('events.setFilter', { category: i % 2 === 0 ? 'task' : 'isr', searchText: i === 5 ? 'IRQ' : `tmp${i}` });
    }
    let lastSettleDiag = '';
    const settledFilterState = await waitFor(
      async () => {
        const st = await provider.invokeUiAction('events.getState').catch(() => null);
        lastSettleDiag = JSON.stringify({
          isStale: st?.isStale,
          appliedQuerySeq: st?.appliedQuerySeq,
          prevRapidSeq,
          appliedFilter: st?.appliedFilter,
          totalMatched: st?.totalMatched,
          domVrows: st?.domVrows,
          firstRow: st?.visibleRowSummaries?.[0],
        });
        if (!st || st.isStale) return null;
        if ((st.appliedQuerySeq || 0) <= prevRapidSeq) return null;
        if (st.appliedFilter?.category !== 'isr' || st.appliedFilter?.searchText !== 'IRQ') return null;
        if (st.totalMatched !== 167000) return null;
        if (st.domVrows <= 0 || st.domVrows > 120) return null;
        const rows = st.visibleRowSummaries || [];
        if (rows.length === 0) return null;
        const allIsrIrq = rows.every(r =>
          (r.eventName === 'ISR_ENTER' || r.eventName === 'ISR_EXIT' || r.eventName === 'ISR_TO_SCHEDULER') &&
          (r.irqId === 17 || String(r.contextLabel || '').includes('IRQ')),
        );
        return allIsrIrq ? st : null;
      },
      20000,
      () => `1M rapid filter settled cleanly with exact ISR/IRQ provenance and 167000 rows (${lastSettleDiag})`,
    );
    const rapidFilterMs = Date.now() - tRapid0;

    // Verify no delayed stale reply overwrites the settled ISR/IRQ state
    await delay(250);
    const postSettleState = await provider.invokeUiAction('events.getState');
    assert.equal(postSettleState.isStale, false, 'post-settle state must remain non-stale');
    assert.equal(postSettleState.appliedQuerySeq, settledFilterState.appliedQuerySeq, 'no late stale reply may alter appliedQuerySeq');
    assert.equal(postSettleState.appliedFilter?.category, 'isr', 'post-settle provenance category must remain isr');
    assert.equal(postSettleState.appliedFilter?.searchText, 'IRQ', 'post-settle provenance searchText must remain IRQ');
    assert.equal(postSettleState.totalMatched, 167000, 'post-settle ISR/IRQ matched total must remain 167000');

    report.millionEventsUi = {
      totalMatched: init1M.totalMatched,
      initialDomRows: init1M.domVrows,
      jump999kElapsedMs: jumpElapsedMs,
      jumpAppliedQuerySeq: jumped1MState.appliedQuerySeq,
      jumpLoadedOffset: jumped1MState.loadedOffset,
      jumpDomRows: jumped1MState.domVrows,
      rapidFilterMs,
      settledAppliedQuerySeq: settledFilterState.appliedQuerySeq,
      settledAppliedFilter: settledFilterState.appliedFilter,
      settledFilterTotalMatched: settledFilterState.totalMatched,
      settledFilterDomRows: settledFilterState.domVrows,
      settledSampleRows: (settledFilterState.visibleRowSummaries || []).slice(0, 3),
      postSettleStable: true,
      droppedStaleReplies: postSettleState.perf?.droppedStaleReplies ?? 0,
    };
    await provider.handleMessage({ command: 'traceCloseRecording', recordId: rec1MId });

    console.log('[stage5.2-driver] step 6: hot recording + theme');
    // 6. Hot mock DAP recording on Events page without target halt/reset + Light/Dark theme switch
    const folder = vscode.workspace.workspaceFolders[0];
    let liveSession;
    const startTrack = vscode.debug.onDidStartDebugSession(s => {
      if (s.name === 'Hot52Session') liveSession = s;
    });
    try {
      await vscode.debug.startDebugging(folder, {
        type: 'orbit',
        request: 'launch',
        name: 'Hot52Session',
        device: 'STM32H723VGT6',
        traceScenario: { sessionId: 'hot-52-1', initialChunk: Array.from(contBin) },
      });
      await waitFor(() => Boolean(liveSession) && provider.currentState.session.phase === 'connected', 10000, 'Hot52Session connected');
      await vscode.commands.executeCommand('workbench.view.extension.ozone-rtos-panel');
      await vscode.commands.executeCommand('ozoneRtos.focus');
      await waitFor(() => provider.isVisible, 10000, 'RTOS view visible');

      await provider.handleMessage({ command: 'updateSettings', settings: { activePage: 'contexts' } });
      let lastProbeErr = '';
      await waitFor(async () => {
        try {
          const st = await provider.invokeUiAction('contexts.getState', {}, 500);
          lastProbeErr = `st=${JSON.stringify(st)}`;
          return st !== null;
        } catch (err) {
          lastProbeErr = `err=${err && err.message ? err.message : String(err)} visible=${provider.isVisible} ready=${provider.readyCount} page=${provider.currentSettings.activePage}`;
          return false;
        }
      }, 15000, () => `RTOS webview responsive on Contexts after debug launch (${lastProbeErr})`);
      await provider.invokeUiAction('contexts.setSubTab', { tab: 'events' });
      await provider.invokeUiAction('events.setFilter', { category: 'all', searchText: '' });
      const evHotPrev = provider.eventsPerfSeq;
      await provider.handleMessage({ command: 'traceStart', mode: 'continuous' });
      let hotDiag = '';
      await waitFor(
        () => {
          const rec0 = provider.currentTraceState.records[0];
          const rec = provider.currentTraceState.records.find(r => r.state === 'recording');
          hotDiag = `selected=${provider.currentTraceState.selectedRecordId} records=${provider.currentTraceState.records.length} r0=${JSON.stringify({ id: rec0?.recordId, state: rec0?.state, reason: rec0?.stateReason, bytes: rec0?.counters?.committedRawBytes, segs: rec0?.segments?.length })} evSeq=${provider.eventsPerfSeq}/${evHotPrev} actionMsg=${JSON.stringify(provider.currentTraceState.lastActionMessage)}`;
          return Boolean(rec && rec.counters.committedRawBytes >= contBin.length && rec.segments.length >= 1 && provider.eventsPerfSeq > evHotPrev && Number(provider.currentEventsPerf?.domRenderedRows || 0) > 0);
        },
        15000,
        () => `Hot recording committed & rendered in EventsView while live (${hotDiag})`,
      );
      const hotEvState = await provider.invokeUiAction('events.getState');
      const activeRec = provider.currentTraceState.records.find(r => r.state === 'recording');
      await provider.handleMessage({ command: 'traceStop', recordId: activeRec.recordId });
      await waitFor(() => coordinator.getStatus(activeRec.recordId)?.state === 'stopped', 10000, 'Hot52 stopped');
      assert.equal(adapters[0].haltedOrReset, false, 'Hot trace must not halt or reset target');
      await provider.handleMessage({ command: 'traceCloseRecording', recordId: activeRec.recordId });
      report.hotRecordingEvents = {
        totalMatched: hotEvState.totalMatched,
        domVrows: hotEvState.domVrows,
        haltedOrReset: adapters[0].haltedOrReset,
      };
    } finally {
      startTrack.dispose();
      if (liveSession) await vscode.debug.stopDebugging(liveSession);
      await waitFor(() => provider.currentState.session.phase === 'none', 10000, 'Hot52Session terminated');
    }

    const workbenchCfg = vscode.workspace.getConfiguration('workbench');
    await workbenchCfg.update('colorTheme', 'Default Light Modern', vscode.ConfigurationTarget.Workspace);
    await delay(200);
    await workbenchCfg.update('colorTheme', 'Default Dark Modern', vscode.ConfigurationTarget.Workspace);
    await delay(200);
    report.themeAndLifecycle = {
      themesTested: ['Default Light Modern', 'Default Dark Modern'],
      visibleAfterThemeSwitch: provider.isVisible,
      activePage: provider.currentSettings.activePage,
    };

    report.ok = true;
    await fsp.writeFile(reportPath, JSON.stringify(report, null, 2));
  } finally {
    factory.dispose();
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
};
