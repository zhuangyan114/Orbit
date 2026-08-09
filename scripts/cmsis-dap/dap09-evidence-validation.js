'use strict';

function percentileStats(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return { count: 0, p50: null, p95: null, max: null };
  const at = fraction => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
  return { count: sorted.length, p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] };
}

function countDiagnostics(items) {
  let staleResultCount = 0;
  let gateUnavailableCount = 0;
  let otherErrorCount = 0;
  for (const item of Array.isArray(items) ? items : []) {
    const code = String(item?.errorCode || '');
    const phase = String(item?.diagnostics?.phase || '');
    if (code === 'TargetReadCancelled' || code === 'RtosReadCancelled' || phase === 'cancelled') staleResultCount++;
    else if (code === 'TargetReadUnavailable' || phase === 'targetReadGate') gateUnavailableCount++;
    else otherErrorCount++;
  }
  return { staleResultCount, gateUnavailableCount, otherErrorCount };
}

function validateDap09Summary(summary) {
  const violations = [];
  if (!Array.isArray(summary?.ownerKinds) || summary.ownerKinds.length !== 1 || summary.ownerKinds[0] !== 'cmsis-dap') {
    violations.push('expected exactly one CMSIS-DAP owner');
  }
  if (!Array.isArray(summary?.helperPids) || summary.helperPids.length !== 1) {
    violations.push('expected exactly one CMSIS-DAP helper');
  }
  if (summary?.processesAfter?.length) violations.push('target owner processes remain after disconnect');
  if (summary?.flashOperationCount !== 0) violations.push('Flash activity was detected');
  if (!summary?.rtosInfoOk) violations.push('rtosInfo did not detect FreeRTOS');
  if ((summary?.runtimeCounterFields || 0) < 4) violations.push('fewer than four runtime-counter fields were captured');
  if ((summary?.snapshotCrossChecks || 0) < 4) violations.push('runtime-counter byte cross-checks are incomplete');
  if (summary?.watchDataSuccessRate !== 1) violations.push('Watch data success rate was below 100%');
  if ((summary?.timelinePointCount || 0) <= 0) violations.push('Timeline produced no data points');
  if ((summary?.rttReadCount || 0) <= 0) violations.push('RTT produced no reads');
  if (summary?.durationMs < 60000) violations.push('hardware workload was shorter than 60 seconds');
  for (const operation of ['continue-pause', 'step', 'reset-halt']) {
    if (!summary?.controls?.some(item => item.operation === operation && item.ok)) violations.push(`${operation} control failed`);
  }
  if (!summary?.disconnectOk) violations.push('disconnect failed');
  return violations;
}

module.exports = { countDiagnostics, percentileStats, validateDap09Summary };
