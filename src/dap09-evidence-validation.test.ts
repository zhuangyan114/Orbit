import { describe, expect, it } from 'vitest';

// The validator is intentionally CommonJS because the hardware harness runs directly in Node.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { countDiagnostics, percentileStats, validateDap09Summary } = require('../scripts/cmsis-dap/dap09-evidence-validation.js');

describe('DAP-09 hardware evidence validation', () => {
  it('calculates deterministic P50, P95, and max latency', () => {
    expect(percentileStats([5, 1, 9, 3])).toEqual({ count: 4, p50: 3, p95: 9, max: 9 });
  });

  it('counts stale and target-read-gate diagnostics without counting unrelated errors', () => {
    expect(countDiagnostics([
      { errorCode: 'TargetReadCancelled', diagnostics: { phase: 'cancelled' } },
      { errorCode: 'TargetReadUnavailable', diagnostics: { phase: 'targetReadGate' } },
      { errorCode: 'TargetRunning' },
      { errorCode: 'OtherFailure' },
    ])).toEqual({ staleResultCount: 1, gateUnavailableCount: 1, otherErrorCount: 2 });
  });

  it('rejects an incomplete summary and accepts a complete single-owner summary', () => {
    const base = {
      ownerKinds: ['cmsis-dap'],
      helperPids: [1234],
      processesAfter: [],
      flashOperationCount: 0,
      rtosInfoOk: true,
      runtimeCounterFields: 4,
      snapshotCrossChecks: 4,
      watchDataSuccessRate: 1,
      timelinePointCount: 10,
      rttReadCount: 1,
      controls: [
        { operation: 'continue-pause', ok: true },
        { operation: 'step', ok: true },
        { operation: 'reset-halt', ok: true },
      ],
      disconnectOk: true,
      durationMs: 60000,
      diagnostics: { staleResultCount: 0, gateUnavailableCount: 0 },
    };
    expect(validateDap09Summary({ ...base, helperPids: [] })).toContain('expected exactly one CMSIS-DAP helper');
    expect(validateDap09Summary(base)).toEqual([]);
  });
});
