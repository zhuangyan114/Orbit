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
              objects: ok,
              timers: ok,
              heap: ok,
            },
          });
        }
        if (action === 'start') {
          return this.sendResponse(msg, { started: true, intervalMs: msg.arguments?.intervalMs ?? 500 });
        }
        this.snapshotSeq++;
        const includeObjects = msg.arguments?.includeObjects !== false;
        const includeTimers = msg.arguments?.includeTimers !== false;
        const includeHeap = msg.arguments?.includeHeap !== false;
        const traversedObject = Boolean(msg.arguments?.includeWaitDetails);
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
          ...(includeObjects ? {
            objects: {
              registryCapacity: 12,
              registryCount: 1,
              globalCount: 1,
              listDiscoveredCount: 0,
              coverageNote: '已检查 xQueueRegistry(12 槽位) 与全局队列句柄',
              objects: [{
                address: 0x20005000,
                kind: 'recursive-mutex',
                kindSource: 'Queue_t.ucQueueType=4 (queueQUEUE_TYPE_RECURSIVE_MUTEX)',
                name: { available: true, value: 'busLock', source: 'xQueueRegistry[0].pcQueueName (ELF .rodata)', unit: 'text' },
                symbolName: 'gBusMutex',
                discoverySources: ['registry', 'global'],
                discoveryNote: 'xQueueRegistry[0]; global gBusMutex',
                health: 'valid',
                queueNumber: { available: true, value: 1, source: 'Queue_t.uxQueueNumber', unit: 'count' },
                messagesWaiting: { available: true, value: 0, source: 'Queue_t.uxMessagesWaiting', unit: 'count' },
                length: { available: true, value: 1, source: 'Queue_t.uxLength', unit: 'count' },
                itemSize: { available: true, value: 0, source: 'Queue_t.uxItemSize', unit: 'bytes' },
                staticallyAllocated: { available: true, value: true, source: 'Queue_t.ucStaticallyAllocated', unit: 'boolean' },
                rxLock: { available: true, value: -1, source: 'Queue_t.cRxLock', unit: 'count' },
                txLock: { available: true, value: -1, source: 'Queue_t.cTxLock', unit: 'count' },
                holder: {
                  address: 0x20001000,
                  taskName: this.mode === 'freertos-a' ? 'ctrlA' : 'ctrlB',
                  creationNumber: '1',
                  recursiveCallCount: { available: true, value: 2, source: 'Queue_t.u.xSemaphore.uxRecursiveCallCount', unit: 'count' },
                  confidence: 'halted-verified',
                  evidence: 'xMutexHolder=0x20001000 verified in task snapshot',
                },
                waitingToReceiveCount: { available: true, value: 0, source: 'Queue_t.xTasksWaitingToReceive.uxNumberOfItems', unit: 'count' },
                waitingToSendCount: { available: true, value: 0, source: 'Queue_t.xTasksWaitingToSend.uxNumberOfItems', unit: 'count' },
                ...(traversedObject ? { waitingToReceive: [], waitingToSend: [] } : {}),
                waitListEvidence: traversedObject ? 'traversed' : 'summary-only',
              }],
              waitEdges: [],
              waitCycles: [],
              unresolvedWaits: [],
            },
          } : {}),
          ...(includeTimers ? {
            timers: {
              enabled: true,
              tickCount: { available: true, value: 420, source: 'xTickCount', unit: 'ticks' },
              activeCurrentCount: 1,
              activeOverflowCount: 0,
              globalStoppedCount: 0,
              coverageNote: '已扫描 xActiveTimerList1/2 与全局定时器句柄',
              timers: [{
                address: 0x20006000,
                name: { available: true, value: 'fixtureTimer', source: 'Timer_t.pcTimerName (ELF .rodata)', unit: 'text' },
                symbolName: 'fixtureTimer',
                discoverySources: ['list', 'global'],
                listState: 'active-current',
                active: { available: true, value: true, source: 'Timer_t.ucStatus (bit 0)', unit: 'boolean' },
                autoReload: { available: true, value: true, source: 'Timer_t.ucStatus (bit 2)', unit: 'boolean' },
                staticallyAllocated: { available: true, value: false, source: 'Timer_t.ucStatus (bit 1)', unit: 'boolean' },
                periodTicks: { available: true, value: 100, source: 'Timer_t.xTimerPeriodInTicks', unit: 'ticks' },
                expiryTick: { available: true, value: 520, source: 'xActiveTimerList1.xTimerListItem.xItemValue', unit: 'ticks' },
                timerId: { available: true, value: 1, source: 'Timer_t.pvTimerID', unit: 'address' },
                callbackAddress: { available: true, value: 0x08000501, source: 'Timer_t.pxCallbackFunction', unit: 'address' },
                timerNumber: { available: true, value: 1, source: 'Timer_t.uxTimerNumber', unit: 'count' },
                health: 'valid',
              }],
            },
          } : {}),
          ...(includeHeap ? {
            heap: {
              allocator: 'heap_4',
              supported: true,
              initialized: true,
              note: '已核对 heap_4 元数据（不基于块链表猜测碎片率或内存泄漏）。',
              configuredBytes: { available: true, value: 65536, source: 'ucHeap ELF array', unit: 'bytes' },
              usableBytes: { available: true, value: 65528, source: 'heap_4.pxEnd - ucHeap', unit: 'bytes' },
              usedBytes: { available: true, value: 8192, source: 'usableBytes - xFreeBytesRemaining', unit: 'bytes' },
              freeBytes: { available: true, value: 57336, source: 'heap_4.xFreeBytesRemaining', unit: 'bytes' },
              minimumEverFreeBytes: { available: true, value: 56000, source: 'heap_4.xMinimumEverFreeBytesRemaining', unit: 'bytes' },
              successfulAllocations: { available: true, value: 12, source: 'heap_4.xNumberOfSuccessfulAllocations', unit: 'count' },
              successfulFrees: { available: true, value: 2, source: 'heap_4.xNumberOfSuccessfulFrees', unit: 'count' },
            },
          } : {}),
          issues: [],
          diagnostics: {
            bytes: 256,
            batches: 2,
            rounds: 2,
            nodes: 1,
            coveredLists: ['ready[2]'],
            queueWaitMs: 0,
            ioMs: 5,
            parseMs: 1,
            totalMs: 8,
            detailBudget: { limitBytes: msg.arguments?.detailBudgetBytes ?? 65536, usedBytes: 96, stackBytes: 0, objectBytes: 48, timerBytes: 32, heapBytes: 16, exhausted: false },
          },
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

      // 7. Persist settings & verify Objects sub-tab + on-demand object inspection in real VS Code host.
      await provider.handleMessage({
        command: 'updateSettings',
        settings: { sortBy: 'cpu', sortDir: 'desc', stateFilter: 'ready', liveIntervalMs: 200, activePage: 'tasks', tasksSubTab: 'objects' },
      });
      await waitFor(() => provider.currentState.snapshot?.objects?.objects?.[0]?.waitListEvidence === 'traversed', 10000, 'objects wait details auto-loaded on subtab switch');
      await provider.handleMessage({ command: 'inspectObject', address: 0x20005000 });
      await provider.handleMessage({ command: 'updateSettings', settings: { tasksSubTab: 'timers', detailBudgetBytes: 32768 } });
      await provider.handleMessage({ command: 'inspectTimersHeap' });
      const stored = extensionContext.workspaceState.get('orbitRtosViewSettings');
      assert.equal(stored?.sortBy, 'cpu');
      assert.equal(stored?.sortDir, 'desc');
      assert.equal(stored?.stateFilter, 'ready');
      assert.equal(stored?.liveIntervalMs, 200);
      assert.equal(stored?.tasksSubTab, 'timers');
      assert.equal(stored?.detailBudgetBytes, 32768);
      assert.equal(provider.currentState.snapshot?.objects?.objects?.[0]?.name?.value, 'busLock');
      assert.equal(provider.currentState.snapshot?.timers?.timers?.[0]?.name?.value, 'fixtureTimer');
      assert.equal(provider.currentState.snapshot?.heap?.allocator, 'heap_4');

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
      objectsVerified: ['busLock'],
      timersVerified: ['fixtureTimer'],
      heapVerified: 'heap_4',
      themesTested: ['Default Light Modern', 'Default Dark Modern'],
      hideShowRecreateVerified: true,
      persistedSettings: provider.currentSettings,
    }, null, 2));
  } finally {
    factory.dispose();
  }
};
