import { describe, expect, it } from 'vitest';
import { known, unknown, type TaskSnapshot } from '../../rtos/model';
import {
  DEFAULT_RTOS_VIEW_SETTINGS,
  describeConsistency,
  describeDiagnosticIssue,
  filterAndSortTasks,
  sanitizeRtosViewSettings,
  stackUsedBytes,
  stackUsedRatio,
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
      liveEnabled: true,
      liveIntervalMs: 200,
      sortBy: 'cpu',
      sortDir: 'desc',
      stateFilter: 'blocked',
      searchQuery: 'motor',
      selectedTaskAddress: 0x20002000,
      maxStackScanBytes: 16384,
      showDiagnostics: true,
    });

    expect(sanitizeRtosViewSettings({
      activePage: 'invalid',
      liveIntervalMs: Number.NaN,
      selectedTaskAddress: -5,
      sortBy: 'bogus',
    })).toEqual(DEFAULT_RTOS_VIEW_SETTINGS);
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
});
