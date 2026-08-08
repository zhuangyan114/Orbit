'use strict';

function classifyWatchResponse(result, expectedExpressions) {
  const dapOk = result?.message?.success === true;
  const results = result?.message?.body?.results;
  const itemErrors = Array.isArray(results)
    ? results
      .filter(item => item?.error)
      .map(item => ({ expression: item.expression || '', error: String(item.error) }))
    : [];
  const returnedExpressions = new Set(Array.isArray(results) ? results.map(item => item?.expression) : []);
  const dataOk = dapOk
    && Array.isArray(results)
    && results.length === expectedExpressions.length
    && itemErrors.length === 0
    && expectedExpressions.every(expression => returnedExpressions.has(expression));
  return {
    dapOk,
    dataOk,
    resultCount: Array.isArray(results) ? results.length : 0,
    itemErrors,
  };
}

function calculateActualSampleRate(pointCount, expressionCount, durationMs) {
  if (![pointCount, expressionCount, durationMs].every(Number.isFinite)
      || pointCount < 0 || expressionCount <= 0 || durationMs <= 0) return 0;
  return pointCount / expressionCount / (durationMs / 1000);
}

function normalizeProbe(value) {
  const probe = String(value || '').toLowerCase();
  if (probe !== 'cmsis-dap' && probe !== 'jlink') {
    throw new Error('--probe must be cmsis-dap or jlink');
  }
  return probe;
}

function validateDap07Summary(summary, expectedOwner = 'cmsis-dap') {
  const violations = [];
  if (!summary.watchRequests) violations.push('no Watch requests completed');
  if (summary.watchDataSuccessRate !== 1) {
    violations.push(`Watch data success rate must be 100%, got ${summary.watchDataSuccessRate}`);
  }
  if (!summary.sampleEvents || !summary.pointCount) violations.push('Timeline produced no data points');
  if (summary.missingTimelineExpressions?.length) {
    violations.push(`Timeline expressions missing data: ${summary.missingTimelineExpressions.join(', ')}`);
  }
  if (summary.helperPids?.length !== 1) {
    const helperName = expectedOwner === 'cmsis-dap' ? 'CMSIS-DAP' : expectedOwner;
    violations.push(`expected exactly one ${helperName} helper, got ${summary.helperPids?.length || 0}`);
  }
  if (!summary.selectedOwners?.length) violations.push('no target owner selection was recorded');
  const expectedSelection = expectedOwner === 'jlink-native'
    ? item => item.mode === 'native' && item.owner === 'jlink-native'
    : item => item.probe === 'cmsis-dap' && item.owner === 'cmsis-dap';
  if (summary.selectedOwners?.some(item => !expectedSelection(item))) {
    violations.push(expectedOwner === 'cmsis-dap'
      ? 'non-CMSIS-DAP owner was selected'
      : `selected owner must be ${expectedOwner}`);
  }
  if (summary.flashOperationCount !== 0) {
    violations.push(`Flash activity was detected (${summary.flashOperationCount} log lines)`);
  }
  if (summary.unexpectedOwnerLines?.length) violations.push('unexpected owner activity was detected in logs');
  if (summary.ownerProcessAfter?.length) violations.push('target owner processes remain after disconnect');
  if (!summary.controls?.some(item => item.operation === 'pause' && item.ok)) violations.push('pause control failed');
  if (!summary.disconnectOk) violations.push('disconnect failed');
  if (expectedOwner === 'cmsis-dap') {
    if (!summary.performanceMetrics?.cmsisDap?.available) violations.push('CMSIS-DAP transport metrics are unavailable');
    const planner = summary.performanceMetrics?.planner;
    if (!planner || !planner.planBuildElapsed || !Number.isFinite(planner.planCacheHit)
      || !Number.isFinite(planner.planCacheMiss)) violations.push('planner performance metrics are incomplete');
  }
  return violations;
}

module.exports = {
  calculateActualSampleRate,
  classifyWatchResponse,
  normalizeProbe,
  validateDap07Summary,
};
