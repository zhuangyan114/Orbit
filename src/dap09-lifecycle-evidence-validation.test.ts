import { describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  collectFlashOperationLines,
  compareLifecycleScalarValues,
  requiresLifecycleRestart,
  resolveFlashBeforeDebug,
  validateLifecycleFlashSummary,
  validateLifecycleSummary,
  validateReplacementSummary,
} = require('../scripts/cmsis-dap/dap09-lifecycle-evidence-validation.js');

const lifecycleScalarNames = [
  'g_dap09_lifecycle_round', 'g_dap09_lifecycle_phase', 'g_dap09_lifecycle_create_count',
  'g_dap09_lifecycle_delete_count', 'g_dap09_lifecycle_live', 'g_dap09_lifecycle_worker_counter',
  'g_dap09_lifecycle_worker_tcb',
];

function lifecycleScalarSnapshot(seed: number): any {
  const bytes = Buffer.alloc(28);
  const values: Record<string, number> = {};
  const fields: Record<string, { address: string; bytes: string; value: number }> = {};
  lifecycleScalarNames.forEach((name, index) => {
    const value = seed + index;
    const address = 0x200040dc + index * 4;
    bytes.writeUInt32LE(value, index * 4);
    values[name] = value;
    fields[name] = { address: `0x${address.toString(16).toUpperCase()}`, bytes: bytes.subarray(index * 4, index * 4 + 4).toString('hex').toUpperCase(), value };
  });
  return {
    values: { ...values },
    directMemory: { baseAddress: '0x200040DC', byteLength: 28, data: bytes.toString('base64'), values, fields },
    scalarMismatches: [],
  };
}

function completeLifecycleRounds(): any[] {
  return Array.from({ length: 20 }, (_, index) => ({
    round: index + 1,
    createdSeen: true,
    deletedSeen: true,
    createCount: index + 1,
    deleteCount: index + 1,
    activeAfterDelete: false,
    workerCounterBefore: index * 10,
    workerCounterAfter: index * 10 + 5,
    created: {
      ...lifecycleScalarSnapshot(index * 100),
      rootVariablesCount: 7,
      workerTcbPointer: '0x20001520',
      task: { name: `dap09Dyn${String(index + 1).padStart(2, '0')}`, tcbAddress: '0x20001520', tcbNumber: index + 1 },
      rtosInfo: { body: { detected: true } },
    },
    deleted: {
      ...lifecycleScalarSnapshot(index * 100 + 20),
      rootVariablesCount: 7,
      workerTcbPointer: null,
      task: null,
      rtosInfo: { body: { detected: true } },
    },
  }));
}

function validLifecycleSummary(overrides: Record<string, unknown> = {}): any {
  return {
    ownerKinds: ['cmsis-dap'],
    helperPids: [1001],
    processesAfter: [],
    unexpectedOwnerLines: [],
    flashBeforeDebug: false,
    flashOperationLines: [],
    unexpectedFlashCount: 0,
    rtosInfoOk: true,
    rounds: completeLifecycleRounds(),
    disconnectOk: true,
    ...overrides,
  };
}

function validReplacementSummary(): any {
  return {
    first: {
      ownerKinds: ['cmsis-dap'], helperPids: [1001], processesAfter: [], unexpectedOwnerLines: [], flashOperationLines: [],
      pendingRequestsDuringTermination: true,
      pendingTargetRequestsAtDisconnect: [{ seq: 10, command: 'rtosInfo' }],
      trace: [{ message: { type: 'response', request_seq: 10, success: false, body: { errorCode: 'TargetReadCancelled' } } }],
      disconnectOk: true, adapterExit: { code: 0, signal: null }, forcedKillUsed: false, terminated: true,
    },
    second: {
      ownerKinds: ['cmsis-dap'], helperPids: [1002], processesAfter: [], unexpectedOwnerLines: [], flashOperationLines: [],
      rtosInfoOk: true, disconnectOk: true, adapterExit: { code: 0, signal: null }, forcedKillUsed: false, terminated: true,
    },
  };
}

describe('DAP-09 lifecycle hardware mode', () => {
  it('uses an explicit no-flash mode for the formal measurement run', () => {
    expect(resolveFlashBeforeDebug(['--hardware'])).toBe(true);
    expect(resolveFlashBeforeDebug(['--hardware', '--no-flash'])).toBe(false);
  });

  it('restarts the fixture only for a no-flash measurement', () => {
    expect(requiresLifecycleRestart(true)).toBe(false);
    expect(requiresLifecycleRestart(false)).toBe(true);
  });

  it('does not count the flash-skipped diagnostic as a Flash operation', () => {
    const log = [
      '11:05:32.469 [DAP] flash skipped reason=flashBeforeDebug=false',
      '11:05:33.041 [DLL] [cmsis-dap] flash operation=eraseSector address=0x8000000 ok=true',
    ].join('\n');
    expect(collectFlashOperationLines(log)).toEqual([
      '11:05:33.041 [DLL] [cmsis-dap] flash operation=eraseSector address=0x8000000 ok=true',
    ]);
  });

  it('reports lifecycle scalar mismatches by symbol name', () => {
    expect(compareLifecycleScalarValues(
      { round: 3, phase: 1, counter: 15 },
      { round: 3, phase: 2, counter: 15 },
    )).toEqual(['phase']);
  });
});

describe('DAP-09 dynamic lifecycle evidence validation', () => {
  it('accepts twenty complete create/delete rounds', () => {
    expect(validateLifecycleSummary(validLifecycleSummary())).toEqual([]);
  });

  it('rejects a lifecycle instance without an integer uxTCBNumber', () => {
    const rounds = completeLifecycleRounds();
    delete rounds[6].created.task.tcbNumber;
    expect(validateLifecycleSummary(validLifecycleSummary({ rounds })))
      .toContain('uxTCBNumber was missing or invalid at round 7');
  });

  it('rejects a worker counter that regresses between lifecycle instances', () => {
    const rounds = completeLifecycleRounds();
    rounds[1].workerCounterBefore = rounds[0].workerCounterAfter - 1;
    rounds[1].workerCounterAfter = rounds[0].workerCounterAfter + 1;
    expect(validateLifecycleSummary(validLifecycleSummary({ rounds })))
      .toContain('worker counter regressed between rounds 1 and 2');
  });

  it('rejects missing or mismatched raw lifecycle scalar evidence', () => {
    const missing = completeLifecycleRounds();
    delete missing[0].created.directMemory;
    expect(validateLifecycleSummary(validLifecycleSummary({ rounds: missing })))
      .toContain('lifecycle scalar cross-check was incomplete at round 1 created');

    const mismatched = completeLifecycleRounds();
    mismatched[0].created.values.g_dap09_lifecycle_phase += 1;
    expect(validateLifecycleSummary(validLifecycleSummary({ rounds: mismatched })))
      .toContain('lifecycle scalar values mismatched at round 1 created');
  });

  it('requires the exact successful Flash phase sequence in Flash mode', () => {
    const flashOperationLines = [
      'flash operation=init ok=true',
      ...Array.from({ length: 3 }, () => 'flash operation=eraseSector ok=true'),
      ...Array.from({ length: 4 }, () => [
        'flash operation=programPage ok=true',
        'flash operation=verify ok=true',
      ]).flat(),
      'flash operation=uninit ok=true',
    ];
    expect(validateLifecycleFlashSummary({ flashBeforeDebug: true, flashOperationLines })).toEqual([]);
    expect(validateLifecycleSummary(validLifecycleSummary({ flashBeforeDebug: true, flashOperationLines }))).toEqual([]);
    expect(validateLifecycleSummary(validLifecycleSummary({ flashBeforeDebug: true, flashOperationLines: flashOperationLines.slice(0, -1) })))
      .toContain('Flash operation sequence was incomplete or out of order');
    const failedLines = [...flashOperationLines];
    failedLines[5] = 'flash operation=programPage ok=false';
    expect(validateLifecycleSummary(validLifecycleSummary({ flashBeforeDebug: true, flashOperationLines: failedLines })))
      .toContain('Flash operation failed');
  });

  it('recomputes forbidden Flash activity from logs in no-Flash mode', () => {
    expect(validateLifecycleSummary(validLifecycleSummary({
      flashBeforeDebug: false,
      flashOperationLines: ['flash operation=eraseSector ok=true'],
      unexpectedFlashCount: 0,
    }))).toContain('unexpected Flash activity was detected');
  });

  it('requires the lifecycle summary to record the Flash mode explicitly', () => {
    const summary = validLifecycleSummary();
    delete summary.flashBeforeDebug;
    expect(validateLifecycleSummary(summary)).toContain('flashBeforeDebug was not recorded');
  });

  it('rejects missing rounds, stale tasks, and owner violations', () => {
    const violations = validateLifecycleSummary({
      ownerKinds: ['cmsis-dap', 'jlink-native'],
      helperPids: [],
      processesAfter: [1001],
      unexpectedOwnerLines: ['owner=jlink-native'],
      unexpectedFlashCount: 1,
      rtosInfoOk: false,
      rounds: [{ round: 1, createdSeen: true, deletedSeen: false, activeAfterDelete: true }],
      disconnectOk: false,
    });
    expect(violations).toEqual(expect.arrayContaining([
      'expected exactly one CMSIS-DAP owner',
      'expected exactly one lifecycle helper',
      'lifecycle helper processes remain after cleanup',
      'unexpected target owner activity was detected',
      'unexpected Flash activity was detected',
      'rtosInfo did not detect FreeRTOS',
      'fewer than 20 complete lifecycle rounds were captured',
      'a deleted dynamic task remained visible',
      'disconnect failed',
    ]));
  });

  it('rejects stale or incomplete task snapshots', () => {
    const rounds = Array.from({ length: 20 }, (_, index) => ({
      round: index + 1,
      createdSeen: true,
      deletedSeen: true,
      createCount: index + 1,
      deleteCount: index + 1,
      activeAfterDelete: false,
      workerCounterBefore: index,
      workerCounterAfter: index + 1,
      created: {
        rootVariablesCount: index === 0 ? 6 : 7,
        workerTcbPointer: '0x20001520',
        task: { name: index === 0 ? 'staleTask' : `dap09Dyn${String(index + 1).padStart(2, '0')}`, tcbAddress: '0x20001520', tcbNumber: 1 },
        rtosInfo: { body: { detected: true } },
      },
      deleted: {
        rootVariablesCount: 7,
        workerTcbPointer: index === 0 ? '0x20001520' : null,
        task: null,
        rtosInfo: { body: { detected: true } },
      },
    }));
    expect(validateLifecycleSummary({
      ownerKinds: ['cmsis-dap'], helperPids: [1001], processesAfter: [], unexpectedFlashCount: 0,
      rtosInfoOk: true, rounds, disconnectOk: true,
    })).toEqual(expect.arrayContaining([
      'dynamic task identity was inconsistent at round 1',
      'RTOS root variables were incomplete at round 1',
      'deleted task state remained published at round 1',
      'uxTCBNumber was reused across lifecycle instances',
    ]));
  });

  it('requires first-session cleanup and second-session owner uniqueness', () => {
    expect(validateReplacementSummary(validReplacementSummary())).toEqual([]);
    expect(validateReplacementSummary({
      first: { ownerKinds: ['jlink-native'], helperPids: [], processesAfter: [1001], unexpectedOwnerLines: ['owner=jlink-native'], flashOperationLines: ['flash operation=eraseSector'], pendingRequestsDuringTermination: false, trace: [], disconnectOk: false, terminated: false },
      second: { ownerKinds: ['cmsis-dap', 'jlink-native'], helperPids: [], processesAfter: [1002], unexpectedOwnerLines: ['owner=jlink-native'], flashOperationLines: ['flash operation=programPage'], rtosInfoOk: false, disconnectOk: false, terminated: false },
    })).toEqual(expect.arrayContaining([
      'first session did not have exactly one CMSIS-DAP owner',
      'first session did not have exactly one helper process',
      'first session disconnect failed',
      'first session did not terminate cleanly',
      'first session left owner processes behind',
      'second session did not have exactly one CMSIS-DAP owner',
      'second session did not have exactly one helper process',
      'second session left owner processes behind',
      'second session did not detect FreeRTOS',
      'second session disconnect failed',
      'second session did not terminate cleanly',
      'unexpected target owner activity was detected',
      'first session did not capture a pending target read',
      'unexpected Flash activity was detected',
    ]));
  });

  it('requires cancellation to match a target request pending at disconnect', () => {
    const summary = validReplacementSummary();
    summary.first.trace[0].message.request_seq = 11;
    expect(validateReplacementSummary(summary))
      .toContain('first session pending target read was not matched by TargetReadCancelled');
  });

  it('accepts a pending target read that completes normally when another pending read is cancelled', () => {
    const summary = validReplacementSummary();
    summary.first.pendingTargetRequestsAtDisconnect.push({ seq: 11, command: 'watchEvaluate' });
    summary.first.trace.push({ message: { type: 'response', request_seq: 11, command: 'watchEvaluate', success: true } });
    expect(validateReplacementSummary(summary)).toEqual([]);
  });

  it('does not accept a non-target DAP request as the pending target read', () => {
    const summary = validReplacementSummary();
    summary.first.pendingTargetRequestsAtDisconnect[0].command = 'threads';
    expect(validateReplacementSummary(summary)).toContain('first session did not capture a pending target read');
  });

  it('requires both adapters to exit with code zero without a forced kill', () => {
    const nonzeroExit = validReplacementSummary();
    nonzeroExit.first.adapterExit.code = 1;
    expect(validateReplacementSummary(nonzeroExit)).toContain('first adapter did not exit cleanly');

    const forcedKill = validReplacementSummary();
    forcedKill.second.forcedKillUsed = true;
    expect(validateReplacementSummary(forcedKill)).toContain('second session required a forced adapter kill');
  });

  it('requires replacement to use a new helper process', () => {
    expect(validateReplacementSummary({
      first: { ownerKinds: ['cmsis-dap'], helperPids: [1001], processesAfter: [], pendingRequestsDuringTermination: true, trace: [{ message: { body: { errorCode: 'TargetReadCancelled' } } }], disconnectOk: true, terminated: true },
      second: { ownerKinds: ['cmsis-dap'], helperPids: [1001], processesAfter: [], rtosInfoOk: true, disconnectOk: true, terminated: true },
    })).toContain('replacement session reused the first helper process');
  });
});
