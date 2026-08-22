#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');
const contractPath = path.join(repoRoot, 'docs', 'api', 'orbit-automation-openrpc.json');
const acceptancePath = path.join(repoRoot, 'docs', 'api', 'orbit-automation-acceptance-matrix.md');
const defaultEvidencePath = path.join(repoRoot, 'outputs', 'automation-api', 'task15-evidence.json');

const catalog = `
orbit.instance.describe
orbit.project.describe
orbit.project.listLaunchConfigurations
orbit.handshake
orbit.connection.close
orbit.operation.get
orbit.system.capabilities
orbit.session.list
orbit.session.snapshot
orbit.session.start
orbit.session.stop
orbit.session.restart
orbit.target.pause
orbit.target.continue
orbit.target.reset
orbit.target.stepOver
orbit.target.stepInto
orbit.target.stepOut
orbit.target.stepInstruction
orbit.target.flash
orbit.breakpoints.list
orbit.breakpoints.add
orbit.breakpoints.update
orbit.breakpoints.remove
orbit.breakpoints.replace
orbit.runtime.threads
orbit.runtime.stackTrace
orbit.runtime.scopes
orbit.runtime.variables
orbit.runtime.registers
orbit.expression.evaluate
orbit.expression.readMany
orbit.expression.writeMany
orbit.expression.inspect
orbit.symbol.search
orbit.symbol.resolve
orbit.memory.read
orbit.memory.write
orbit.watch.list
orbit.watch.replace
orbit.watch.add
orbit.watch.remove
orbit.timeline.list
orbit.timeline.replace
orbit.timeline.start
orbit.timeline.stop
orbit.timeline.status
orbit.record.start
orbit.record.stop
orbit.record.list
orbit.record.get
orbit.record.clear
orbit.experiment.run
orbit.rtt.status
orbit.rtt.start
orbit.rtt.stop
orbit.rtt.read
orbit.rttlog.read
orbit.diagnostics.snapshot
`.trim().split(/\s+/);

const errors = [];
function fail(message) { errors.push(message); }

function parseArgs(argv) {
  const options = { evidence: defaultEvidencePath };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--evidence') {
      options.evidence = argv[index + 1];
      index += 1;
    } else if (arg === '--help') {
      options.help = true;
    } else {
      fail(`unknown argument ${arg}`);
    }
  }
  return options;
}

function parseCaseBlocks(acceptance) {
  return acceptance.split(/^### /m).slice(1).map((block) => {
    const heading = block.match(/^(API-\d{3}):\s*(.+)$/m);
    const status = block.match(/^Status:\s*(Automated|Hardware-only)\s*$/m)?.[1];
    const methods = [...(block.match(/^Methods:\s*(.+)$/m)?.[1] ?? '').matchAll(/`([^`]+)`/g)].map((match) => match[1]);
    return {
      id: heading?.[1],
      title: heading?.[2]?.trim(),
      status,
      methods,
      raw: block,
    };
  }).filter((entry) => entry.id);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function validateEvidenceShape(evidence) {
  if (!isRecord(evidence) || evidence.schemaVersion !== 1) fail('evidence.schemaVersion must be 1');
  if (!Array.isArray(evidence.cases) || evidence.cases.length === 0) fail('evidence.cases must be a non-empty array');
  return Array.isArray(evidence.cases) ? evidence.cases : [];
}

function validateIdentities(caseEntry) {
  const instances = Array.isArray(caseEntry.instances) ? caseEntry.instances : [];
  const seen = new Set();
  for (const instance of instances) {
    if (!isRecord(instance) || typeof instance.instanceId !== 'string' || typeof instance.projectId !== 'string') {
      fail(`${caseEntry.id}: instance entries must include instanceId and projectId`);
      continue;
    }
    if (seen.has(instance.instanceId)) fail(`${caseEntry.id}: duplicate instanceId ${instance.instanceId}`);
    seen.add(instance.instanceId);
  }
}

function validateGenerations(caseEntry) {
  const generations = Array.isArray(caseEntry.generations) ? caseEntry.generations : [];
  const bySession = new Map();
  for (const entry of generations) {
    if (!isRecord(entry) || typeof entry.sessionId !== 'string' || !Number.isInteger(entry.sessionGeneration)) {
      fail(`${caseEntry.id}: generation entries must include sessionId and sessionGeneration`);
      continue;
    }
    const previous = bySession.get(entry.sessionId);
    if (previous !== undefined && entry.sessionGeneration < previous) {
      fail(`${caseEntry.id}: session ${entry.sessionId} generation moved backwards (${previous} -> ${entry.sessionGeneration})`);
    }
    bySession.set(entry.sessionId, entry.sessionGeneration);
  }
}

function validateEventOrder(caseEntry) {
  const events = Array.isArray(caseEntry.events) ? caseEntry.events : [];
  let previousId;
  for (const event of events) {
    if (!isRecord(event) || typeof event.type !== 'string' || typeof event.eventId !== 'string') {
      fail(`${caseEntry.id}: events must include type and eventId`);
      continue;
    }
    if (!/^[0-9]{16,20}$/.test(event.eventId)) fail(`${caseEntry.id}: eventId ${event.eventId} is not a decimal uint64 string`);
    if (previousId && event.eventId <= previousId) fail(`${caseEntry.id}: events are not strictly increasing (${previousId} then ${event.eventId})`);
    previousId = event.eventId;
  }
}

function requireUiEvidence(caseEntry) {
  const ui = caseEntry.ui;
  if (!isRecord(ui)) {
    fail(`${caseEntry.id}: UI case is missing official debug/session evidence`);
    return;
  }
  if (ui.debugToolbarActive !== true) fail(`${caseEntry.id}: debug toolbar context must be active`);
  if (typeof ui.callStackSessionId !== 'string' || ui.callStackSessionId.length === 0) {
    fail(`${caseEntry.id}: Call Stack session must be associated via the official debug session API`);
  }
  if (!Array.isArray(ui.breakpoints) || ui.breakpoints.length === 0) {
    fail(`${caseEntry.id}: vscode.debug.breakpoints source locations must be recorded`);
  }
  if (ui.dapEventOnly === true) fail(`${caseEntry.id}: DAP events alone are not UI evidence`);
}

const options = parseArgs(process.argv);
if (options.help) {
  console.log('usage: node scripts/automation-api/acceptance-validator.js [--evidence <path>]');
  process.exit(0);
}

let contract;
let acceptance = '';
try {
  contract = readJson(contractPath);
} catch (error) {
  fail(`cannot read OpenRPC contract: ${error.message}`);
}
try {
  acceptance = fs.readFileSync(acceptancePath, 'utf8');
} catch (error) {
  fail(`cannot read acceptance matrix: ${error.message}`);
}

const contractMethods = Array.isArray(contract?.methods) ? contract.methods.map((method) => method?.name).filter(Boolean) : [];
for (const name of catalog) {
  if (!contractMethods.includes(name)) fail(`OpenRPC is missing catalog method ${name}`);
}
for (const name of contractMethods) {
  if (!catalog.includes(name)) fail(`OpenRPC contains unexpected method ${name}`);
}

const cases = parseCaseBlocks(acceptance);
const methodsWithAutomated = new Set();
const methodsWithHardware = new Set();
for (const acceptanceCase of cases) {
  if (!acceptanceCase.status) fail(`${acceptanceCase.id}: missing Status`);
  if (acceptanceCase.methods.length === 0) fail(`${acceptanceCase.id}: missing Methods`);
  for (const method of acceptanceCase.methods) {
    if (!catalog.includes(method)) fail(`${acceptanceCase.id}: unknown method ${method}`);
    if (acceptanceCase.status === 'Automated') methodsWithAutomated.add(method);
    if (acceptanceCase.status === 'Hardware-only') methodsWithHardware.add(method);
  }
}
for (const method of catalog) {
  if (!methodsWithAutomated.has(method) && !methodsWithHardware.has(method)) {
    fail(`catalog method ${method} has neither an Automated case nor a Hardware-only case`);
  }
}

let evidenceCases = [];
try {
  evidenceCases = validateEvidenceShape(readJson(options.evidence));
} catch (error) {
  fail(`cannot read evidence ${path.relative(repoRoot, options.evidence)}: ${error.message}`);
}

const evidenceById = new Map();
const evidencedMethods = new Set();
for (const evidenceCase of evidenceCases) {
  if (!isRecord(evidenceCase) || typeof evidenceCase.id !== 'string') {
    fail('evidence case is missing id');
    continue;
  }
  if (evidenceById.has(evidenceCase.id)) fail(`duplicate evidence case ${evidenceCase.id}`);
  evidenceById.set(evidenceCase.id, evidenceCase);
  if (evidenceCase.status !== 'passed' && evidenceCase.status !== 'hardware-only' && evidenceCase.status !== 'skipped') {
    fail(`${evidenceCase.id}: evidence status must be passed, hardware-only, or skipped`);
  }
  validateIdentities(evidenceCase);
  validateGenerations(evidenceCase);
  validateEventOrder(evidenceCase);
  for (const method of Array.isArray(evidenceCase.methods) ? evidenceCase.methods : []) evidencedMethods.add(method);
  if (evidenceCase.requiresUi === true || evidenceCase.id === 'API-021') requireUiEvidence(evidenceCase);
}

for (const acceptanceCase of cases) {
  if (acceptanceCase.status !== 'Automated') continue;
  const evidence = evidenceById.get(acceptanceCase.id);
  if (!evidence) {
    fail(`${acceptanceCase.id}: Automated case has no evidence`);
    continue;
  }
  if (evidence.status !== 'passed') fail(`${acceptanceCase.id}: Automated case evidence status is ${evidence.status}`);
}

for (const method of methodsWithAutomated) {
  if (!evidencedMethods.has(method)) fail(`Automated method ${method} has no evidence coverage`);
}

if (errors.length) {
  console.error(`Acceptance validation failed with ${errors.length} error(s):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Acceptance OK: ${catalog.length} methods, ${cases.length} matrix cases, ${evidenceCases.length} evidence cases.`);
