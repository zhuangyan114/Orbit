'use strict';

function resolveFlashBeforeDebug(argv) {
  return !argv.includes('--no-flash');
}

function requiresLifecycleRestart(flashBeforeDebug) {
  return !flashBeforeDebug;
}

function collectFlashOperationLines(logText) {
  return logText.split(/\r?\n/).filter(line => /\[cmsis-dap\] flash operation=/i.test(line));
}

function compareLifecycleScalarValues(evaluated, direct) {
  const names = new Set([...Object.keys(evaluated || {}), ...Object.keys(direct || {})]);
  return [...names].filter(name => evaluated?.[name] !== direct?.[name]);
}

const lifecycleScalarNames = [
  'g_dap09_lifecycle_round', 'g_dap09_lifecycle_phase', 'g_dap09_lifecycle_create_count',
  'g_dap09_lifecycle_delete_count', 'g_dap09_lifecycle_live', 'g_dap09_lifecycle_worker_counter',
  'g_dap09_lifecycle_worker_tcb',
];

function lifecycleScalarEvidenceStatus(snapshot) {
  const direct = snapshot?.directMemory;
  const evaluated = snapshot?.values;
  if (!direct || !evaluated || direct.byteLength !== 28 || typeof direct.baseAddress !== 'string'
    || typeof direct.data !== 'string' || !direct.values || !direct.fields
    || !Array.isArray(snapshot.scalarMismatches)) return 'incomplete';
  const bytes = Buffer.from(direct.data, 'base64');
  const baseAddress = Number.parseInt(direct.baseAddress, 16);
  if (bytes.length !== 28 || !Number.isInteger(baseAddress)
    || Object.keys(evaluated).length !== lifecycleScalarNames.length
    || Object.keys(direct.values).length !== lifecycleScalarNames.length
    || Object.keys(direct.fields).length !== lifecycleScalarNames.length) return 'incomplete';
  const addresses = new Set();
  for (const name of lifecycleScalarNames) {
    const field = direct.fields[name];
    const address = Number.parseInt(field?.address, 16);
    const offset = address - baseAddress;
    if (!Number.isInteger(evaluated[name]) || !Number.isInteger(direct.values[name])
      || !field || !Number.isInteger(address) || offset < 0 || offset + 4 > bytes.length || offset % 4 !== 0
      || !/^[0-9a-f]{8}$/i.test(field.bytes) || !Number.isInteger(field.value)
      || field.bytes.toUpperCase() !== bytes.subarray(offset, offset + 4).toString('hex').toUpperCase()
      || field.value !== bytes.readUInt32LE(offset) || field.value !== direct.values[name]) return 'incomplete';
    addresses.add(address);
  }
  if (addresses.size !== lifecycleScalarNames.length) return 'incomplete';
  return snapshot.scalarMismatches.length === 0
    && compareLifecycleScalarValues(evaluated, direct.values).length === 0 ? 'ok' : 'mismatched';
}

const expectedFlashOperations = [
  'init',
  'eraseSector', 'eraseSector', 'eraseSector',
  'programPage', 'verify',
  'programPage', 'verify',
  'programPage', 'verify',
  'programPage', 'verify',
  'uninit',
];
const targetReadCommands = new Set([
  'dataSample', 'evaluate', 'getTargetState', 'readMemory', 'rtosInfo', 'variables', 'watchEvaluate',
]);

function parseFlashOperationLine(line) {
  const operation = /flash operation=([^\s]+)/i.exec(line)?.[1] || null;
  const ok = /\bok=(true|false)\b/i.exec(line)?.[1]?.toLowerCase() === 'true';
  return { operation, ok };
}

function validateLifecycleFlashSummary(summary) {
  const violations = [];
  if (typeof summary?.flashBeforeDebug !== 'boolean') violations.push('flashBeforeDebug was not recorded');
  const flashOperationLines = summary?.flashOperationLines || summary?.authorizedFlashLines || [];
  if (summary?.flashBeforeDebug === true) {
    const flashOperations = flashOperationLines.map(parseFlashOperationLine);
    const operationNames = flashOperations.map(item => item.operation);
    if (operationNames.length !== expectedFlashOperations.length
      || operationNames.some((operation, index) => operation !== expectedFlashOperations[index])) {
      violations.push('Flash operation sequence was incomplete or out of order');
    }
    if (flashOperations.some(item => item.ok !== true)) violations.push('Flash operation failed');
  } else if (summary?.unexpectedFlashCount !== 0 || flashOperationLines.length !== 0) {
    violations.push('unexpected Flash activity was detected');
  }
  return violations;
}

function validateLifecycleSummary(summary) {
  const violations = validateLifecycleFlashSummary(summary);
  if (!Array.isArray(summary?.ownerKinds) || summary.ownerKinds.length !== 1 || summary.ownerKinds[0] !== 'cmsis-dap') {
    violations.push('expected exactly one CMSIS-DAP owner');
  }
  if (!Array.isArray(summary?.helperPids) || summary.helperPids.length !== 1) {
    violations.push('expected exactly one lifecycle helper');
  }
  if (summary?.processesAfter?.length) violations.push('lifecycle helper processes remain after cleanup');
  if (summary?.unexpectedOwnerLines?.length) violations.push('unexpected target owner activity was detected');
  if (!summary?.rtosInfoOk) violations.push('rtosInfo did not detect FreeRTOS');

  const rounds = Array.isArray(summary?.rounds) ? summary.rounds : [];
  const completeRounds = rounds.filter(round =>
    round?.createdSeen === true
    && round?.deletedSeen === true
    && round?.activeAfterDelete !== true
    && round?.workerCounterAfter > round?.workerCounterBefore);
  if (completeRounds.length < 20) violations.push('fewer than 20 complete lifecycle rounds were captured');
  if (rounds.length > 20) violations.push('more than 20 lifecycle rounds were captured');
  if (rounds.some(round => round?.activeAfterDelete === true)) violations.push('a deleted dynamic task remained visible');
  if (rounds.some(round => !Number.isInteger(round?.round) || round.round < 1 || round.round > 20)) {
    violations.push('lifecycle round numbers were invalid');
  }
  for (let index = 0; index < Math.min(20, rounds.length); index++) {
    const round = rounds[index];
    if (round.round !== index + 1 || round.createCount !== index + 1 || round.deleteCount !== index + 1) {
      violations.push(`lifecycle counters were inconsistent at round ${index + 1}`);
      break;
    }
    const expectedName = `dap09Dyn${String(index + 1).padStart(2, '0')}`;
    if (!round.created?.workerTcbPointer
      || round.created?.task?.name !== expectedName
      || round.created?.task?.tcbAddress !== round.created?.workerTcbPointer) {
      violations.push(`dynamic task identity was inconsistent at round ${index + 1}`);
    }
    if (round.created?.rootVariablesCount !== 7 || round.deleted?.rootVariablesCount !== 7) {
      violations.push(`RTOS root variables were incomplete at round ${index + 1}`);
    }
    if (round.created?.rtosInfo?.body?.detected !== true || round.deleted?.rtosInfo?.body?.detected !== true) {
      violations.push(`FreeRTOS was not detected in both snapshots at round ${index + 1}`);
    }
    if (round.deleted?.workerTcbPointer !== null || round.deleted?.task !== null) {
      violations.push(`deleted task state remained published at round ${index + 1}`);
    }
    for (const phase of ['created', 'deleted']) {
      const scalarStatus = lifecycleScalarEvidenceStatus(round[phase]);
      if (scalarStatus === 'incomplete') {
        violations.push(`lifecycle scalar cross-check was incomplete at round ${index + 1} ${phase}`);
      } else if (scalarStatus === 'mismatched') {
        violations.push(`lifecycle scalar values mismatched at round ${index + 1} ${phase}`);
      }
    }
    if (!Number.isInteger(round.created?.task?.tcbNumber)) {
      violations.push(`uxTCBNumber was missing or invalid at round ${index + 1}`);
    }
    if (index > 0 && round.workerCounterBefore < rounds[index - 1].workerCounterAfter) {
      violations.push(`worker counter regressed between rounds ${index} and ${index + 1}`);
    }
  }
  const tcbNumbers = rounds.map(round => round.created?.task?.tcbNumber);
  if (tcbNumbers.length === 20 && tcbNumbers.every(Number.isInteger) && new Set(tcbNumbers).size !== 20) {
    violations.push('uxTCBNumber was reused across lifecycle instances');
  }
  if (!summary?.disconnectOk) violations.push('disconnect failed');
  return violations;
}

function validateReplacementSummary(summary) {
  const violations = [];
  const first = summary?.first || {};
  const second = summary?.second || {};
  if (!Array.isArray(first.ownerKinds) || first.ownerKinds.length !== 1 || first.ownerKinds[0] !== 'cmsis-dap') {
    violations.push('first session did not have exactly one CMSIS-DAP owner');
  }
  if (!Array.isArray(first.helperPids) || first.helperPids.length !== 1) {
    violations.push('first session did not have exactly one helper process');
  }
  if (first.disconnectOk !== true) violations.push('first session disconnect failed');
  if (first.terminated !== true) violations.push('first session did not terminate cleanly');
  if (first.adapterExit?.code !== 0) violations.push('first adapter did not exit cleanly');
  if (first.forcedKillUsed !== false) violations.push('first session required a forced adapter kill');
  if (first.processesAfter?.length) violations.push('first session left owner processes behind');
  if (!Array.isArray(second.ownerKinds) || second.ownerKinds.length !== 1 || second.ownerKinds[0] !== 'cmsis-dap') {
    violations.push('second session did not have exactly one CMSIS-DAP owner');
  }
  if (!Array.isArray(second.helperPids) || second.helperPids.length !== 1) {
    violations.push('second session did not have exactly one helper process');
  }
  if (second.processesAfter?.length) violations.push('second session left owner processes behind');
  if (!second.rtosInfoOk) violations.push('second session did not detect FreeRTOS');
  if (second.disconnectOk !== true) violations.push('second session disconnect failed');
  if (second.terminated !== true) violations.push('second session did not terminate cleanly');
  if (second.adapterExit?.code !== 0) violations.push('second adapter did not exit cleanly');
  if (second.forcedKillUsed !== false) violations.push('second session required a forced adapter kill');
  if (first.unexpectedOwnerLines?.length || second.unexpectedOwnerLines?.length) {
    violations.push('unexpected target owner activity was detected');
  }
  const pendingTargetRequests = Array.isArray(first.pendingTargetRequestsAtDisconnect)
    ? first.pendingTargetRequestsAtDisconnect.filter(request => Number.isInteger(request?.seq) && targetReadCommands.has(request?.command))
    : [];
  const cancelledRequestSeqs = new Set((first.trace || []).filter(entry =>
    entry?.message?.type === 'response'
    && entry.message.success === false
    && entry.message.body?.errorCode === 'TargetReadCancelled')
    .map(entry => entry.message.request_seq));
  if (first.pendingRequestsDuringTermination !== true || pendingTargetRequests.length === 0) {
    violations.push('first session did not capture a pending target read');
  } else if (!pendingTargetRequests.some(request => cancelledRequestSeqs.has(request.seq))) {
    violations.push('first session pending target read was not matched by TargetReadCancelled');
  }
  const firstFlashLines = first.flashOperationLines
    || collectFlashOperationLines(`${first.logs?.dap || ''}\n${first.logs?.dll || ''}`);
  const secondFlashLines = second.flashOperationLines
    || collectFlashOperationLines(`${second.logs?.dap || ''}\n${second.logs?.dll || ''}`);
  if (firstFlashLines.length || secondFlashLines.length) violations.push('unexpected Flash activity was detected');
  if (first.helperPids?.length === 1 && second.helperPids?.length === 1 && first.helperPids[0] === second.helperPids[0]) {
    violations.push('replacement session reused the first helper process');
  }
  return violations;
}

module.exports = {
  collectFlashOperationLines,
  compareLifecycleScalarValues,
  requiresLifecycleRestart,
  resolveFlashBeforeDebug,
  validateLifecycleFlashSummary,
  validateLifecycleSummary,
  validateReplacementSummary,
};
