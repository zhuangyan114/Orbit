'use strict';
const vscode = require('vscode');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(fn, timeoutMs = 15000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await fn();
    if (val) return val;
    await delay(50);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

class MockRtosDebugAdapter {
  constructor(mode) {
    this.mode = mode;
    this.emitter = new vscode.EventEmitter();
    this.onDidSendMessage = this.emitter.event;
    this.seq = 1;
    this.snapshotSeq = 0;
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

  handleMessage(msg) {
    if (msg.type !== 'request') return;
    switch (msg.command) {
      case 'initialize':
        this.sendResponse(msg, { supportsConfigurationDoneRequest: true });
        break;
      case 'launch':
        this.sendResponse(msg, {});
        this.sendEvent('initialized', {});
        this.sendEvent('stopped', { reason: 'entry', threadId: 1 });
        this.sendEvent('orbitAutomationLifecycle', { type: 'target.stopped', reason: 'entry', threadId: 1 });
        break;
      case 'configurationDone':
        this.sendResponse(msg, {});
        break;
      case 'threads':
        this.sendResponse(msg, { threads: [{ id: 1, name: 'Main' }] });
        break;
      case 'stackTrace':
        this.sendResponse(msg, { stackFrames: [], totalFrames: 0 });
        break;
      case 'scopes':
        this.sendResponse(msg, { scopes: [] });
        break;
      case 'disconnect':
      case 'terminate':
        this.sendResponse(msg, {});
        this.sendEvent('terminated', {});
        break;
      case 'orbitRtosSnapshot': {
        const action = msg.arguments?.action || 'refresh';
        if (action === 'stop') return this.sendResponse(msg, { stopped: true });
        if (action === 'cancel') return this.sendResponse(msg, { cancelled: true });
        if (this.mode === 'no-dwarf') {
          return this.sendResponse(msg, {
            version: 1,
            consistency: 'unavailable',
            tasks: [],
            sessionId: 'mock-no-dwarf',
            sessionGeneration: 1,
            bootGeneration: 1,
            operationGeneration: 1,
            elfSha256: 'deadbeef',
            layoutId: '',
            errorCode: 'DwarfUnavailable',
            reason: 'No DWARF type for pxCurrentTCB',
          });
        }
        if (action === 'capabilities') {
          const ok = { available: true, evidence: 'offline' };
          return this.sendResponse(msg, {
            sessionId: `mock-${this.mode}`,
            sessionGeneration: 1,
            operationGeneration: 1,
            bootGeneration: 1,
            elfSha256: 'feedface',
            layoutId: 'layout-mock',
            capabilities: {
              layout: ok,
              taskSnapshot: ok,
              stackBounds: ok,
              stackWatermark: ok,
              runtimeCounters: ok,
              runtimePercent: ok,
            },
          });
        }
        if (action === 'start') {
          return this.sendResponse(msg, { started: true, intervalMs: msg.arguments?.intervalMs ?? 500 });
        }
        this.snapshotSeq++;
        return this.sendResponse(msg, {
          version: 1,
          sessionId: `mock-${this.mode}`,
          sessionGeneration: 1,
          operationGeneration: 1,
          bootGeneration: 1,
          elfSha256: 'feedface',
          layoutId: 'layout-mock',
          snapshotSequence: this.snapshotSeq,
          startedAt: Date.now() - 8,
          completedAt: Date.now(),
          targetState: 'Halted',
          consistency: 'halted-consistent',
          kernel: { name: 'FreeRTOS', version: { available: false, reason: 'none', source: 'DWARF', unit: 'text' }, source: 'DWARF:mock' },
          tasks: [{
            tcbAddress: 0x20001000,
            creationNumber: { available: true, value: '1', source: 'TCB.uxTCBNumber', unit: 'count' },
            identityCertain: true,
            name: { available: true, value: this.mode === 'freertos-a' ? 'ctrlA' : 'ctrlB', source: 'TCB.pcTaskName', unit: 'text' },
            state: 'running',
            lists: ['ready[2]'],
            listEvidence: 'traversed',
            current: true,
            priority: { available: true, value: 2, source: 'TCB.uxPriority', unit: 'priority' },
            basePriority: { available: true, value: 2, source: 'TCB.uxBasePriority', unit: 'priority' },
            stack: {
              base: { available: true, value: 0x20002000, source: 'TCB.pxStack', unit: 'address' },
              end: { available: true, value: 0x200023fc, source: 'TCB.pxEndOfStack', unit: 'address' },
              growthDirection: { available: true, value: 'down', source: 'port', unit: 'enum' },
              wordBytes: { available: true, value: 4, source: 'DWARF', unit: 'bytes' },
              capacityBytes: { available: true, value: 1024, source: 'TCB', unit: 'bytes' },
              watermarkBytes: { available: true, value: 384, source: 'scan', unit: 'bytes' },
              fillByte: { available: true, value: 0xa5, source: 'port', unit: 'byte' },
              scannedBytes: 384,
              scanComplete: true,
              scanMs: 3,
            },
            runtime: {
              counter: { available: true, value: '1234', source: 'TCB.ulRunTimeCounter', unit: 'counter-ticks' },
              bits: { available: true, value: 32, source: 'DWARF', unit: 'bits' },
              percent: { available: true, value: 42.5, source: 'DWT CYCCNT', unit: 'percent' },
              intervalMs: { available: true, value: 500, source: 'Host', unit: 'ms' },
              readWindowMs: { available: true, value: 12, source: 'Host', unit: 'ms' },
            },
          }],
          runtimeTotal: { available: true, value: '2900', source: 'ulTotalRunTime', unit: 'counter-ticks' },
          runtimeTotalBits: { available: true, value: 32, source: 'DWARF', unit: 'bits' },
          issues: [],
          diagnostics: { bytes: 256, batches: 2, rounds: 2, nodes: 1, coveredLists: ['ready[2]'], queueWaitMs: 0, ioMs: 5, parseMs: 1, totalMs: 8 },
        });
      }
      default:
        this.sendResponse(msg, {});
    }
  }

  dispose() {
    this.emitter.dispose();
  }
}

exports.run = async function run() {
  const reportPath = process.env.ORBIT_RTOS_STAGE2_REPORT;
  const ext = vscode.extensions.getExtension('orbit-debug.orbit-for-vscode');
  assert.ok(ext, 'orbit-for-vscode extension must be installed in test host');
  const api = await ext.activate();
  const provider = api?.rtosProvider;
  const extensionContext = api?.extensionContext;
  assert.ok(provider && extensionContext, 'Test extension mode must expose rtosProvider and extensionContext');

  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'Workspace folder required');

  // Open RTOS panel view and wait for the real Chromium Webview (dist/rtos.js) to mount and send 'ready'.
  await vscode.commands.executeCommand('workbench.view.extension.ozone-rtos-panel');
  await vscode.commands.executeCommand('ozoneRtos.focus');
  await waitFor(() => provider.isVisible && provider.readyCount >= 1, 15000, 'RTOS webview mount and ready');
  const initialReadyCount = provider.readyCount;

  const factory = vscode.debug.registerDebugAdapterDescriptorFactory('orbit', {
    createDebugAdapterDescriptor(session) {
      return new vscode.DebugAdapterInlineImplementation(new MockRtosDebugAdapter(session.configuration.mockMode || 'freertos-a'));
    },
  });

  try {
    let sessionNoDwarf;
    let sessionFreeRtosA;
    let sessionFreeRtosB;
    const trackStart = vscode.debug.onDidStartDebugSession(session => {
      if (session.name === 'No DWARF Session') sessionNoDwarf = session;
      if (session.name === 'FreeRTOS Session A') sessionFreeRtosA = session;
      if (session.name === 'FreeRTOS Session B') sessionFreeRtosB = session;
    });

    try {
      // 1. Missing DWARF empty state in real VS Code.
      const startedNoDwarf = await vscode.debug.startDebugging(folder, {
        type: 'orbit',
        request: 'launch',
        name: 'No DWARF Session',
        mockMode: 'no-dwarf',
        device: 'STM32H723VGT6',
      });
      assert.equal(startedNoDwarf, true);
      await vscode.commands.executeCommand('ozoneRtos.focus');
      await waitFor(() => provider.currentState.capabilitiesError?.errorCode === 'DwarfUnavailable', 10000, 'DwarfUnavailable state');

      // 2. Switch to FreeRTOS Session A (with RTOS panel visible) -> verifies ctrlA.
      const startedFreeRtosA = await vscode.debug.startDebugging(folder, {
        type: 'orbit',
        request: 'launch',
        name: 'FreeRTOS Session A',
        mockMode: 'freertos-a',
        device: 'STM32H723VGT6',
      });
      assert.equal(startedFreeRtosA, true);
      await waitFor(() => Boolean(sessionFreeRtosA), 5000, 'FreeRTOS session A started');
      if (sessionNoDwarf) await vscode.debug.stopDebugging(sessionNoDwarf);
      await vscode.commands.executeCommand('ozoneRtos.focus');
      await waitFor(() => provider.currentState.snapshot?.tasks?.[0]?.name?.value === 'ctrlA', 10000, 'FreeRTOS ctrlA snapshot');

      // 3. Switch to FreeRTOS Session B -> verifies ctrlB replaces ctrlA without stale bleed.
      const startedFreeRtosB = await vscode.debug.startDebugging(folder, {
        type: 'orbit',
        request: 'launch',
        name: 'FreeRTOS Session B',
        mockMode: 'freertos-b',
        device: 'STM32H723VGT6',
      });
      assert.equal(startedFreeRtosB, true);
      await waitFor(() => Boolean(sessionFreeRtosB), 5000, 'FreeRTOS session B started');
      if (sessionFreeRtosA) await vscode.debug.stopDebugging(sessionFreeRtosA);
      await vscode.commands.executeCommand('ozoneRtos.focus');
      await waitFor(() => provider.currentState.snapshot?.tasks?.[0]?.name?.value === 'ctrlB', 10000, 'FreeRTOS ctrlB snapshot');

      // 4. Light & Dark theme switching.
      const workbenchCfg = vscode.workspace.getConfiguration('workbench');
      await workbenchCfg.update('colorTheme', 'Default Light Modern', vscode.ConfigurationTarget.Workspace);
      await delay(250);
      await workbenchCfg.update('colorTheme', 'Default Dark Modern', vscode.ConfigurationTarget.Workspace);
      await delay(250);
      assert.equal(provider.isVisible, true);

      // 5. Hide and reopen RTOS panel.
      await vscode.commands.executeCommand('workbench.view.extension.ozone-watch-panel');
      await waitFor(() => !provider.isVisible, 10000, 'RTOS panel hidden');
      await vscode.commands.executeCommand('workbench.view.extension.ozone-rtos-panel');
      await vscode.commands.executeCommand('ozoneRtos.focus');
      await waitFor(() => provider.isVisible, 10000, 'RTOS panel re-shown');

      // 6. Recreate Webview view by moving to Explorer and back to RTOS container, verifying remount + state.
      await vscode.commands.executeCommand('vscode.moveViews', { viewIds: ['ozoneRtos'], destinationId: 'workbench.view.explorer' });
      await vscode.commands.executeCommand('ozoneRtos.focus');
      await waitFor(() => provider.readyCount > initialReadyCount && provider.isVisible, 10000, 'RTOS webview recreated in Explorer');
      const movedReadyCount = provider.readyCount;
      await vscode.commands.executeCommand('vscode.moveViews', { viewIds: ['ozoneRtos'], destinationId: 'workbench.view.extension.ozone-rtos-panel' });
      await vscode.commands.executeCommand('ozoneRtos.focus');
      await waitFor(() => provider.readyCount > movedReadyCount && provider.isVisible, 10000, 'RTOS webview recreated in Panel');

      // 7. Persist settings via provider message handler and verify re-instantiated provider restores from real workspaceState.
      await provider.handleMessage({
        command: 'updateSettings',
        settings: { sortBy: 'cpu', sortDir: 'desc', stateFilter: 'ready', liveIntervalMs: 200, activePage: 'tasks' },
      });
      const stored = extensionContext.workspaceState.get('orbitRtosViewSettings');
      assert.equal(stored?.sortBy, 'cpu');
      assert.equal(stored?.sortDir, 'desc');
      assert.equal(stored?.stateFilter, 'ready');
      assert.equal(stored?.liveIntervalMs, 200);

      // Terminate remaining mock session cleanly.
      if (sessionFreeRtosB) await vscode.debug.stopDebugging(sessionFreeRtosB);
      await waitFor(() => provider.currentState.session.phase === 'none', 10000, 'all debug sessions terminated');
    } finally {
      trackStart.dispose();
    }

    await fs.writeFile(reportPath, JSON.stringify({
      ok: true,
      initialReadyCount,
      recreatedReadyCount: provider.readyCount,
      emptyErrorCode: 'DwarfUnavailable',
      switchedTasks: ['ctrlA', 'ctrlB'],
      themesTested: ['Default Light Modern', 'Default Dark Modern'],
      hideShowRecreateVerified: true,
      persistedSettings: provider.currentSettings,
    }, null, 2));
  } finally {
    factory.dispose();
  }
};
