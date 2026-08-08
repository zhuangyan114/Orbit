import { describe, expect, it } from 'vitest';

const {
  calculateActualSampleRate,
  classifyWatchResponse,
  normalizeProbe,
  validateDap07Summary,
} = require('../../scripts/cmsis-dap/dap07-evidence-validation');

const validSummary = {
  watchRequests: 10,
  watchDataSuccessRate: 1,
  sampleEvents: 20,
  pointCount: 60,
  missingTimelineExpressions: [],
  helperPids: [1234],
  selectedOwners: [{ probe: 'cmsis-dap', owner: 'cmsis-dap' }],
  flashOperationCount: 0,
  unexpectedOwnerLines: [],
  ownerProcessAfter: [],
  controls: [{ operation: 'pause', ok: true }],
  disconnectOk: true,
  performanceMetrics: {
    planner: { planCacheHit: 1, planCacheMiss: 1, planBuildElapsed: { count: 1 } },
    cmsisDap: { available: true },
  },
};

describe('DAP-07 hardware evidence validation', () => {
  it('rejects a successful DAP response when a Watch item has an error', () => {
    const result = {
      message: {
        success: true,
        body: {
          results: [
            { expression: 'a', value: 1, display: '1' },
            { expression: 'b', value: 0, display: '', error: 'read failed' },
          ],
        },
      },
    };

    expect(classifyWatchResponse(result, ['a', 'b'])).toEqual({
      dapOk: true,
      dataOk: false,
      resultCount: 2,
      itemErrors: [{ expression: 'b', error: 'read failed' }],
    });
  });

  it('accepts evidence only when data, Timeline, owner, Flash, and cleanup checks pass', () => {
    expect(validateDap07Summary(validSummary, 'cmsis-dap')).toEqual([]);
    expect(validateDap07Summary({
      ...validSummary,
      watchDataSuccessRate: 0.9,
      pointCount: 0,
      missingTimelineExpressions: ['uwTick'],
      helperPids: [],
      selectedOwners: [{ probe: 'jlink', owner: 'jlink-native' }],
      flashOperationCount: 1,
      unexpectedOwnerLines: ['owner=jlink-native'],
      ownerProcessAfter: ['orbit-cmsis-dap-helper.exe'],
      controls: [{ operation: 'pause', ok: false }],
      disconnectOk: false,
      performanceMetrics: null,
    }, 'cmsis-dap')).toEqual(expect.arrayContaining([
      expect.stringContaining('Watch data success rate'),
      expect.stringContaining('Timeline produced no data points'),
      expect.stringContaining('Timeline expressions missing data'),
      expect.stringContaining('exactly one CMSIS-DAP helper'),
      expect.stringContaining('non-CMSIS-DAP owner'),
      expect.stringContaining('Flash activity'),
      expect.stringContaining('unexpected owner'),
      expect.stringContaining('owner processes remain'),
      expect.stringContaining('pause control failed'),
      expect.stringContaining('disconnect failed'),
    ]));
  });

  it('calculates the actual per-expression Timeline sample rate', () => {
    expect(calculateActualSampleRate(11253, 3, 60511)).toBeCloseTo(61.99, 2);
  });

  it('accepts exactly one J-Link native owner', () => {
    expect(validateDap07Summary({
      ...validSummary,
      selectedOwners: [{ mode: 'native', owner: 'jlink-native' }],
    }, 'jlink-native')).toEqual([]);

    expect(validateDap07Summary({
      ...validSummary,
      selectedOwners: [{ mode: 'auto', owner: 'jlink-legacy' }],
    }, 'jlink-native')).toEqual(expect.arrayContaining([
      expect.stringContaining('jlink-native'),
    ]));
  });

  it('normalizes supported probes and rejects unsupported probes', () => {
    expect(normalizeProbe('jlink')).toBe('jlink');
    expect(normalizeProbe('cmsis-dap')).toBe('cmsis-dap');
    expect(() => normalizeProbe('openocd')).toThrow(/cmsis-dap or jlink/);
  });
});
