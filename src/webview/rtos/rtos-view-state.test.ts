import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { known, unknown, type ObjectsDiscoverySummary, type SyncObjectSnapshot, type TaskSnapshot, type TimerSnapshot } from '../../rtos/model';
import { ObjectsView } from './objects-view';
import {
  DEFAULT_RTOS_VIEW_SETTINGS,
  describeConsistency,
  describeDiagnosticIssue,
  filterAndSortTasks,
  filterSyncObjects,
  filterTimers,
  formatDurationMs,
  objectKindLabel,
  sanitizeRtosViewSettings,
  stackUsedBytes,
  stackUsedRatio,
  timerStateLabel,
} from './rtos-view-state';

function makeTask(overrides: Partial<TaskSnapshot> & { tcbAddress: number }): TaskSnapshot {
  return {
    tcbAddress: overrides.tcbAddress,
    creationNumber: overrides.creationNumber ?? known('1', 'TCB.uxTCBNumber', 'count'),
    identityCertain: overrides.identityCertain ?? true,
    name: overrides.name ?? known('worker', 'TCB.pcTaskName', 'text'),
    state: overrides.state ?? 'ready',
    lists: overrides.lists ?? ['ready[1]'],
    listEvidence: overrides.listEvidence ?? 'traversed',
    current: overrides.current ?? false,
    priority: overrides.priority ?? known(1, 'TCB.uxPriority', 'priority'),
    basePriority: overrides.basePriority ?? known(1, 'TCB.uxBasePriority', 'priority'),
    stack: overrides.stack ?? {
      base: known(0x20001000, 'TCB.pxStack', 'address'),
      end: known(0x200013fc, 'TCB.pxEndOfStack', 'address'),
      growthDirection: known('down', 'port', 'enum'),
      wordBytes: known(4, 'DWARF', 'bytes'),
      capacityBytes: known(1024, 'TCB', 'bytes'),
      watermarkBytes: unknown('Not requested', 'Stack fill scan', 'bytes'),
      fillByte: known(0xa5, 'port', 'byte'),
      scannedBytes: 0,
      scanComplete: false,
      scanMs: 0,
    },
    runtime: overrides.runtime ?? {
      counter: known('100', 'TCB.ulRunTimeCounter', 'counter-ticks'),
      bits: known(32, 'DWARF', 'bits'),
      percent: unknown('First interval', 'Kernel', 'percent'),
      intervalMs: unknown('No valid interval', 'Host', 'ms'),
    },
  };
}

describe('RTOS view state helpers', () => {
  it('sanitizes and clamps persisted view settings', () => {
    const parsed = sanitizeRtosViewSettings({
      activePage: 'trace',
      liveEnabled: true,
      liveIntervalMs: 50,
      sortBy: 'cpu',
      sortDir: 'desc',
      stateFilter: 'blocked',
      searchQuery: 'motor',
      selectedTaskAddress: 0x20002000,
      maxStackScanBytes: 999999,
      showDiagnostics: true,
    });
    expect(parsed).toEqual({
      version: 1,
      activePage: 'trace',
      tasksSubTab: 'tasks',
      liveEnabled: true,
      liveIntervalMs: 200,
      includeObjectsInLive: false,
      sortBy: 'cpu',
      sortDir: 'desc',
      stateFilter: 'blocked',
      searchQuery: 'motor',
      objectKindFilter: 'all',
      objectSearchQuery: '',
      timerFilter: 'all',
      timerSearchQuery: '',
      selectedTaskAddress: 0x20002000,
      selectedObjectAddress: null,
      maxStackScanBytes: 16384,
      detailBudgetBytes: 65536,
      showDiagnostics: true,
      traceMode: 'continuous',
      traceAutoFollow: true,
      traceTimeUnit: 'ns',
    });

    const withTraceFields = sanitizeRtosViewSettings({
      traceMode: 'post-mortem',
      traceAutoFollow: false,
      traceTimeUnit: 'relative-ticks',
    });
    expect(withTraceFields.traceMode).toBe('post-mortem');
    expect(withTraceFields.traceAutoFollow).toBe(false);
    expect(withTraceFields.traceTimeUnit).toBe('relative-ticks');

    const withObjectFields = sanitizeRtosViewSettings({
      tasksSubTab: 'timers',
      includeObjectsInLive: true,
      objectKindFilter: 'mutex',
      objectSearchQuery: 'bus',
      timerFilter: 'active',
      timerSearchQuery: 'heartbeat',
      detailBudgetBytes: 1000,
      selectedObjectAddress: 0x20004000,
    });
    expect(withObjectFields.tasksSubTab).toBe('timers');
    expect(withObjectFields.includeObjectsInLive).toBe(true);
    expect(withObjectFields.objectKindFilter).toBe('mutex');
    expect(withObjectFields.objectSearchQuery).toBe('bus');
    expect(withObjectFields.timerFilter).toBe('active');
    expect(withObjectFields.timerSearchQuery).toBe('heartbeat');
    expect(withObjectFields.detailBudgetBytes).toBe(4096);
    expect(withObjectFields.selectedObjectAddress).toBe(0x20004000);

    expect(sanitizeRtosViewSettings({
      activePage: 'invalid',
      tasksSubTab: 'bogus',
      liveIntervalMs: Number.NaN,
      selectedTaskAddress: -5,
      selectedObjectAddress: 0,
      objectKindFilter: 'unknown-kind',
      timerFilter: 'bad',
      sortBy: 'bogus',
    })).toEqual(DEFAULT_RTOS_VIEW_SETTINGS);
  });

  it('filters timers by activity and text/address/callback query', () => {
    const activeTimer: TimerSnapshot = {
      address: 0x20006000,
      name: known('heartbeat', 'Timer_t', 'text'),
      symbolName: 'fixtureTimer',
      discoverySources: ['list', 'global'],
      listState: 'active-current',
      active: known(true, 'ucStatus', 'boolean'),
      autoReload: known(true, 'ucStatus', 'boolean'),
      staticallyAllocated: known(false, 'ucStatus', 'boolean'),
      periodTicks: known(100, 'Timer_t', 'ticks'),
      expiryTick: known(1500, 'xTimerListItem', 'ticks'),
      timerId: known(1, 'Timer_t', 'address'),
      callbackAddress: known(0x08001234, 'Timer_t', 'address'),
      timerNumber: known(2, 'Timer_t', 'count'),
      health: 'valid',
    };
    const stoppedTimer: TimerSnapshot = {
      ...activeTimer,
      address: 0x20006100,
      name: known('oneShotTimeout', 'Timer_t', 'text'),
      symbolName: 'gStoppedTimer',
      discoverySources: ['global'],
      listState: 'stopped-global',
      active: known(false, 'ucStatus', 'boolean'),
      autoReload: known(false, 'ucStatus', 'boolean'),
      callbackAddress: known(0x08005678, 'Timer_t', 'address'),
      expiryTick: unknown('stopped', 'Timer_t', 'ticks'),
    };
    expect(timerStateLabel('active-overflow')).toBe('溢出列表');
    expect(filterTimers([activeTimer, stoppedTimer], 'active', '').map(t => t.address)).toEqual([0x20006000]);
    expect(filterTimers([activeTimer, stoppedTimer], 'stopped', '').map(t => t.address)).toEqual([0x20006100]);
    expect(filterTimers([activeTimer, stoppedTimer], 'all', '08001234').map(t => t.address)).toEqual([0x20006000]);
    expect(filterTimers([activeTimer, stoppedTimer], 'all', 'gstoppedtimer').map(t => t.address)).toEqual([0x20006100]);
  });

  it('filters sync objects by kind, issue status, symbol, name, address and holder', () => {
    const baseObj = (over: Partial<SyncObjectSnapshot> & { address: number }): SyncObjectSnapshot => ({
      address: over.address,
      kind: over.kind ?? 'queue',
      kindSource: 'ucQueueType',
      name: over.name ?? known('qCmd', 'xQueueRegistry', 'text'),
      symbolName: over.symbolName,
      discoverySources: over.discoverySources ?? ['registry'],
      discoveryNote: 'registry',
      health: over.health ?? 'valid',
      healthReason: over.healthReason,
      queueNumber: known(1, 'Queue_t', 'count'),
      messagesWaiting: known(1, 'Queue_t', 'count'),
      length: known(4, 'Queue_t', 'count'),
      itemSize: known(16, 'Queue_t', 'bytes'),
      staticallyAllocated: known(false, 'Queue_t', 'boolean'),
      rxLock: known(-1, 'Queue_t', 'count'),
      txLock: known(-1, 'Queue_t', 'count'),
      holder: over.holder,
      waitingToReceiveCount: known(0, 'Queue_t', 'count'),
      waitingToSendCount: known(0, 'Queue_t', 'count'),
      waitListEvidence: over.waitListEvidence ?? 'traversed',
    });
    const queue = baseObj({ address: 0x20004100, kind: 'queue', name: known('cmdQueue', 'reg', 'text') });
    const mutex = baseObj({
      address: 0x20004200,
      kind: 'recursive-mutex',
      name: unknown('unregistered', 'obj', 'text'),
      symbolName: 'spiLock',
      holder: {
        address: 0x20001000,
        taskName: 'motorTask',
        recursiveCallCount: known(2, 'Queue_t', 'count'),
        confidence: 'halted-verified',
        evidence: 'verified',
      },
    });
    const badSem = baseObj({ address: 0x20004300, kind: 'counting-semaphore', health: 'deleting-or-corrupt', waitListEvidence: 'corrupt' });

    expect(objectKindLabel('recursive-mutex')).toBe('Recursive Mutex');
    expect(filterSyncObjects([queue, mutex, badSem], 'mutex', '').map(o => o.address)).toEqual([0x20004200]);
    expect(filterSyncObjects([queue, mutex, badSem], 'semaphore', '').map(o => o.address)).toEqual([0x20004300]);
    expect(filterSyncObjects([queue, mutex, badSem], 'issues', '').map(o => o.address)).toEqual([0x20004300]);
    expect(filterSyncObjects([queue, mutex, badSem], 'all', 'motortask').map(o => o.address)).toEqual([0x20004200]);
    expect(filterSyncObjects([queue, mutex, badSem], 'all', '20004100').map(o => o.address)).toEqual([0x20004100]);
  });

  it('filters by state or text and sorts safely when optional fields are unavailable', () => {
    const t1 = makeTask({
      tcbAddress: 0x20001000,
      name: known('idle', 'TCB', 'text'),
      state: 'ready',
      priority: known(0, 'TCB', 'priority'),
    });
    const t2 = makeTask({
      tcbAddress: 0x20002000,
      name: known('ctrl', 'TCB', 'text'),
      state: 'running',
      current: true,
      priority: known(3, 'TCB', 'priority'),
      runtime: {
        counter: known('400', 'TCB', 'counter-ticks'),
        bits: known(32, 'DWARF', 'bits'),
        percent: known(25.5, 'DWT', 'percent'),
        intervalMs: known(500, 'Host', 'ms'),
        readWindowMs: known(12, 'Host', 'ms'),
      },
    });
    const t3 = makeTask({
      tcbAddress: 0x20003000,
      name: unknown('stripped', 'TCB', 'text'),
      state: 'blocked',
      lists: ['xDelayedTaskList1'],
      listEvidence: 'validated-tcb',
    });

    const byState = filterAndSortTasks([t1, t3, t2], {
      stateFilter: 'all',
      searchQuery: '',
      sortBy: 'state',
      sortDir: 'asc',
    });
    expect(byState.map(t => t.tcbAddress)).toEqual([0x20002000, 0x20001000, 0x20003000]);

    const byHex = filterAndSortTasks([t1, t2, t3], {
      stateFilter: 'blocked',
      searchQuery: '20003000',
      sortBy: 'cpu',
      sortDir: 'desc',
    });
    expect(byHex.map(t => t.tcbAddress)).toEqual([0x20003000]);

    const byCpu = filterAndSortTasks([t1, t2], {
      stateFilter: 'all',
      searchQuery: '',
      sortBy: 'cpu',
      sortDir: 'desc',
    });
    expect(byCpu.map(t => t.tcbAddress)).toEqual([0x20002000, 0x20001000]);
  });

  it('computes stack usage only when capacity and watermark are available', () => {
    const unscanned = makeTask({ tcbAddress: 0x20001000 });
    expect(stackUsedBytes(unscanned)).toBeUndefined();
    expect(stackUsedRatio(unscanned)).toBeUndefined();

    const scanned = makeTask({
      tcbAddress: 0x20001000,
      stack: {
        ...unscanned.stack,
        capacityBytes: known(1000, 'TCB', 'bytes'),
        watermarkBytes: known(250, 'scan', 'bytes'),
      },
    });
    expect(stackUsedBytes(scanned)).toBe(750);
    expect(stackUsedRatio(scanned)).toBe(0.75);
  });

  it('maps consistency and missing-symbol errors to clear diagnostic text', () => {
    expect(describeConsistency('partial').tone).toBe('warn');
    expect(describeConsistency('halted-consistent').tone).toBe('ok');
    expect(describeDiagnosticIssue({ errorCode: 'DwarfUnavailable', message: 'No DWARF' })?.title).toContain('DWARF');
    expect(describeDiagnosticIssue({ errorCode: 'RtosNotDetected', message: 'Missing pxCurrentTCB' })?.title).toContain('FreeRTOS');
  });

  it('formats timing durations compactly without raw float noise and keeps anti-jump layout CSS rules intact', () => {
    expect(formatDurationMs(262.96435546875, 1)).toBe('263.0');
    expect(formatDurationMs(0.03564453125, 1)).toBe('0.0');
    expect(formatDurationMs(265.4, 0)).toBe('265');
    expect(formatDurationMs(-5, 1)).toBe('0.0');
    expect(formatDurationMs(Number.NaN, 1)).toBe('—');
    expect(formatDurationMs(undefined, 0)).toBe('—');

    const appSrc = readFileSync(resolve(__dirname, 'app.tsx'), 'utf8');
    expect(appSrc).toContain('.rtos-status-strip { display:flex; flex-direction:column;');
    expect(appSrc).toContain('.rtos-timing { display:flex; flex-wrap:nowrap;');
    expect(appSrc).toContain('.rtos-inline-warn { flex:1 1 0; min-width:0;');
    expect(appSrc).toContain('white-space:nowrap; }');
    expect(appSrc).toContain('.rtos-toolbar { display:flex; flex-wrap:nowrap;');
    expect(appSrc).toContain('.rtos-sub-bar { display:flex; flex-wrap:nowrap;');
    expect(appSrc).toContain('.rtos-filter-bar { display:flex; flex-wrap:nowrap;');
    expect(appSrc).toContain('.rtos-coverage-bar { display:flex; flex-wrap:nowrap;');
    expect(appSrc).toContain('.rtos-diagnostics { border-top:1px solid var(--vscode-panel-border); padding:8px 10px; font-size:11px; background:var(--vscode-editorWidget-background, var(--vscode-panel-background)); height:88px;');
  });

  it('renders lifecycle status labels accurately in ObjectsView without marking freed or unconfirmed objects as valid', () => {
    const baseObj = (overrides: Partial<SyncObjectSnapshot> & { address: number }): SyncObjectSnapshot => ({
      address: overrides.address,
      kind: overrides.kind ?? 'queue',
      kindSource: 'Queue_t.ucQueueType',
      name: overrides.name ?? known('q', 'symbol', 'text'),
      discoverySources: overrides.discoverySources ?? ['global'],
      discoveryNote: 'test',
      health: overrides.health ?? 'valid',
      ...(overrides.healthReason ? { healthReason: overrides.healthReason } : {}),
      ...(overrides.lifecycle ? { lifecycle: overrides.lifecycle } : {}),
      ...(overrides.lifecycleReason ? { lifecycleReason: overrides.lifecycleReason } : {}),
      ...(overrides.heapBlock ? { heapBlock: overrides.heapBlock } : {}),
      ...(overrides.heapBlockReason ? { heapBlockReason: overrides.heapBlockReason } : {}),
      queueNumber: known(1, 'Queue_t', 'count'),
      messagesWaiting: known(0, 'Queue_t', 'count'),
      length: known(4, 'Queue_t', 'count'),
      itemSize: known(4, 'Queue_t', 'bytes'),
      staticallyAllocated: known(false, 'Queue_t', 'boolean'),
      rxLock: known(-1, 'Queue_t', 'count'),
      txLock: known(-1, 'Queue_t', 'count'),
      waitingToReceiveCount: known(0, 'Queue_t', 'count'),
      waitingToSendCount: known(0, 'Queue_t', 'count'),
      waitListEvidence: 'traversed',
    });

    const summary: ObjectsDiscoverySummary = {
      registryCount: 1,
      globalCount: 4,
      listDiscoveredCount: 1,
      coverageNote: 'test coverage',
      objects: [
        baseObj({
          address: 0x20001000,
          name: known('staticObj', 'sym', 'text'),
          health: 'valid',
          heapBlock: 'static',
          heapBlockReason: 'StaticQueue_t',
          lifecycle: 'confirmed-static',
          lifecycleReason: 'StaticQueue_t confirmed',
        }),
        baseObj({
          address: 0x20001400,
          name: known('reusedOrDyn', 'sym', 'text'),
          health: 'valid',
          heapBlock: 'allocated',
          heapBlockReason: 'heap_4 chunk allocated',
          lifecycle: 'unconfirmed',
          lifecycleReason: 'same-address reuse cannot be ruled out',
        }),
        baseObj({
          address: 0x20002000,
          name: known('freedGlobal', 'sym', 'text'),
          health: 'deleting-or-corrupt',
          heapBlock: 'freed',
          heapBlockReason: 'freed in heap_4',
          lifecycle: 'confirmed-freed',
          healthReason: 'freed in heap_4',
          lifecycleReason: 'freed in heap_4',
        }),
        baseObj({
          address: 0x20003000,
          name: known('heap2Global', 'sym', 'text'),
          health: 'valid',
          heapBlock: 'unverified',
          heapBlockReason: 'heap_2 unverified',
          lifecycle: 'unconfirmed',
          lifecycleReason: 'heap_2 unverified',
        }),
      ],
      waitEdges: [],
      waitCycles: [],
      unresolvedWaits: [],
    };

    expect(filterSyncObjects(summary.objects, 'issues', '').map(o => o.address)).toEqual([0x20002000]);

    const htmlWithReusedSelected = renderToStaticMarkup(React.createElement(ObjectsView, {
      summary,
      settings: { ...DEFAULT_RTOS_VIEW_SETTINGS, selectedObjectAddress: 0x20001400 },
      canInspect: true,
      refreshing: false,
      onUpdateSettings: () => {},
      onInspectObject: () => {},
      onSelectTask: () => {},
    }));
    expect(htmlWithReusedSelected).toContain('>正常<');
    expect(htmlWithReusedSelected).toContain('未确认（块已分配）');
    expect(htmlWithReusedSelected).toContain('已释放:');
    expect(htmlWithReusedSelected).toContain('生命周期未确认');
    expect(htmlWithReusedSelected).toContain('堆块状态');
    expect(htmlWithReusedSelected).toContain('块当前已分配 (allocated)');
    expect(htmlWithReusedSelected).toContain('生命周期验证');
    expect(htmlWithReusedSelected).toContain('same-address reuse cannot be ruled out');

    const htmlOnlyDynamic = renderToStaticMarkup(React.createElement(ObjectsView, {
      summary: { ...summary, objects: [summary.objects[1]] },
      settings: DEFAULT_RTOS_VIEW_SETTINGS,
      canInspect: true,
      refreshing: false,
      onUpdateSettings: () => {},
      onInspectObject: () => {},
      onSelectTask: () => {},
    }));
    expect(htmlOnlyDynamic).not.toContain('>正常<');
    expect(htmlOnlyDynamic).toContain('未确认（块已分配）');
  });
});
