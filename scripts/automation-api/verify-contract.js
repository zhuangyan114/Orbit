#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');
const contractPath = path.join(repoRoot, 'docs', 'api', 'orbit-automation-openrpc.json');
const acceptancePath = path.join(repoRoot, 'docs', 'api', 'orbit-automation-acceptance-matrix.md');

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

const scopes = new Set([
  'read', 'session.control', 'breakpoints.write', 'view.write', 'record',
  'rtt.control', 'variables.write', 'memory.write', 'flash',
]);

const standardErrors = new Map([
  ['ParseError', -32700],
  ['InvalidJsonRpcRequest', -32600],
  ['MethodNotFound', -32601],
  ['InvalidParams', -32602],
  ['JsonRpcInternalError', -32603],
]);

const requiredDtos = [
  'BootstrapContext', 'ConnectionContext', 'ConnectionMutationContext',
  'ProjectMutationContext', 'SessionRef', 'TargetRequestContext',
  'TargetMutationContext', 'OperationResult', 'EndpointDescriptor',
  'HandshakeData', 'CapabilitySnapshot', 'SessionSnapshot', 'Breakpoint',
  'Thread', 'StackFrame', 'Scope', 'Variable', 'Register',
  'ExpressionValue', 'Symbol', 'MemoryBlock', 'WatchSnapshot',
  'TimelineSnapshot', 'Recording', 'RecordingFrame', 'ExperimentReport',
  'RttSnapshot', 'RttLogEntry', 'RttLogReadData', 'DiagnosticsSnapshot',
];

function policy(name) {
  const exact = {
    'orbit.handshake': [true, [], true, false, false, 2000],
    'orbit.connection.close': [false, ['read'], true, false, false, 2000],
    'orbit.session.start': [false, ['session.control'], true, true, false, 30000],
    'orbit.target.flash': [false, ['flash'], true, true, true, 180000],
    'orbit.expression.writeMany': [false, ['variables.write'], true, true, true, 15000],
    'orbit.memory.write': [false, ['memory.write'], true, true, true, 30000],
    'orbit.experiment.run': [false, [], true, true, true, 600000],
    'orbit.diagnostics.snapshot': [false, ['read'], false, false, false, 5000],
  };
  if (exact[name]) return exact[name];
  if (/^orbit\.(instance\.describe|project\.describe|system\.capabilities)$/.test(name)) return [true, [], false, false, false, 2000];
  if (/^orbit\.(operation\.get|project\.listLaunchConfigurations|session\.(list|snapshot))$/.test(name)) return [false, ['read'], false, false, false, 5000];
  if (/^orbit\.(session\.(stop|restart)|target\.(pause|continue|reset|stepOver|stepInto|stepOut|stepInstruction))$/.test(name)) return [false, ['session.control'], true, true, true, 30000];
  if (name === 'orbit.breakpoints.list') return [false, ['read'], false, false, false, 5000];
  if (/^orbit\.breakpoints\.(add|update|remove|replace)$/.test(name)) return [false, ['breakpoints.write'], true, true, false, 15000];
  if (/^orbit\.(runtime\.|expression\.(evaluate|readMany|inspect)$|symbol\.|memory\.read$)/.test(name)) return [false, ['read'], false, false, true, 10000];
  if (/^orbit\.watch\.(list)$/.test(name) || /^orbit\.timeline\.list$/.test(name)) return [false, ['read'], false, false, false, 5000];
  if (/^orbit\.watch\.(replace|add|remove)$/.test(name) || name === 'orbit.timeline.replace') return [false, ['view.write'], true, true, false, 10000];
  if (/^orbit\.timeline\.(start|stop)$/.test(name)) return [false, ['view.write'], true, true, true, 10000];
  if (name === 'orbit.timeline.status') return [false, ['read'], false, false, true, 10000];
  if (/^orbit\.record\.(start|stop|clear)$/.test(name)) return [false, ['record'], true, true, true, 15000];
  if (/^orbit\.record\.(list|get)$/.test(name)) return [false, ['read'], false, false, true, 10000];
  if (/^orbit\.rtt\.(status|read)$/.test(name)) return [false, ['read'], false, false, true, 10000];
  if (/^orbit\.rtt\.(start|stop)$/.test(name)) return [false, ['rtt.control'], true, true, true, 15000];
  if (/^orbit\.rttlog\.read$/.test(name)) return [false, ['read'], false, false, true, 10000];
  throw new Error(`No frozen policy for ${name}`);
}

const errors = [];
function fail(message) { errors.push(message); }
function sameArray(a, b) { return Array.isArray(a) && a.length === b.length && a.every((value, index) => value === b[index]); }
function localRefName(ref) { return typeof ref === 'string' && ref.startsWith('#/components/schemas/') ? ref.slice('#/components/schemas/'.length) : undefined; }

function expectedContextName(method) {
  if (method.name === 'orbit.session.start') return 'ProjectMutationContext';
  if (method.name === 'orbit.handshake') return 'BootstrapContext';
  if (method.name === 'orbit.connection.close') return 'ConnectionContext';
  if (method['x-orbit-method']?.targetBound) return method['x-orbit-method'].mutation ? 'TargetMutationContext' : 'TargetRequestContext';
  if (method['x-orbit-method']?.mutation && method['x-orbit-method'].requiresIdempotency) return 'ConnectionMutationContext';
  return method['x-orbit-method']?.bootstrap ? 'BootstrapContext' : 'ConnectionContext';
}

let document;
try {
  document = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
} catch (error) {
  console.error(`Contract validation failed: cannot read ${path.relative(repoRoot, contractPath)}: ${error.message}`);
  process.exit(1);
}

let acceptance = '';
try {
  acceptance = fs.readFileSync(acceptancePath, 'utf8');
} catch (error) {
  fail(`cannot read ${path.relative(repoRoot, acceptancePath)}: ${error.message}`);
}

if (document.openrpc !== '1.3.2') fail('openrpc must be 1.3.2');
if (document.info?.version !== '1.0.0') fail('info.version must be 1.0.0');
if (!Array.isArray(document.methods)) fail('methods must be an array');
if (!document.components?.schemas || typeof document.components.schemas !== 'object') fail('components.schemas must be an object');

const methods = Array.isArray(document.methods) ? document.methods : [];
const methodNames = methods.map((method) => method?.name);
const duplicates = methodNames.filter((name, index) => methodNames.indexOf(name) !== index);
if (duplicates.length) fail(`duplicate method names: ${[...new Set(duplicates)].join(', ')}`);
const missing = catalog.filter((name) => !methodNames.includes(name));
const extra = methodNames.filter((name) => !catalog.includes(name));
if (missing.length) fail(`missing catalog methods: ${missing.join(', ')}`);
if (extra.length) fail(`unexpected methods (catalog drift): ${extra.join(', ')}`);
if (methodNames.length !== catalog.length) fail(`method count must be ${catalog.length}, received ${methodNames.length}`);

const metadataFields = ['bootstrap', 'requiredScopes', 'mutation', 'requiresIdempotency', 'targetBound', 'defaultTimeoutMs', 'paramsSchemaRef', 'resultSchemaRef', 'errorCodes'];
for (const method of methods) {
  if (!method || typeof method !== 'object' || !catalog.includes(method.name)) continue;
  const metadata = method['x-orbit-method'];
  if (!metadata || typeof metadata !== 'object') {
    fail(`${method.name}: missing x-orbit-method metadata`);
    continue;
  }
  for (const field of metadataFields) if (!(field in metadata)) fail(`${method.name}: missing metadata.${field}`);
  const expected = policy(method.name);
  const actualPolicy = [metadata.bootstrap, metadata.requiredScopes, metadata.mutation, metadata.requiresIdempotency, metadata.targetBound, metadata.defaultTimeoutMs];
  expected.forEach((value, index) => {
    const actual = actualPolicy[index];
    if (Array.isArray(value) ? !sameArray(actual, value) : actual !== value) fail(`${method.name}: frozen policy mismatch at ${metadataFields[index]}`);
  });
  if (!Array.isArray(metadata.requiredScopes) || metadata.requiredScopes.some((scope) => !scopes.has(scope))) fail(`${method.name}: invalid requiredScopes`);
  if (method.name === 'orbit.experiment.run' && metadata.scopeResolver !== 'experimentStepUnion') fail(`${method.name}: scopeResolver must be experimentStepUnion`);
  if (!Number.isInteger(metadata.defaultTimeoutMs) || metadata.defaultTimeoutMs <= 0) fail(`${method.name}: defaultTimeoutMs must be a positive integer`);
  if (!Array.isArray(metadata.errorCodes) || metadata.errorCodes.length === 0 || metadata.errorCodes.some((code) => typeof code !== 'string' || !code)) fail(`${method.name}: errorCodes must be a non-empty string array`);
  if (!Array.isArray(method.params) || method.params.length !== 1 || method.params[0]?.name !== 'params' || !method.params[0]?.required || typeof method.params[0]?.schema?.$ref !== 'string') fail(`${method.name}: params must contain one required schema reference`);
  if (!method.result || typeof method.result?.schema?.$ref !== 'string') fail(`${method.name}: result must contain a schema reference`);
  if (!Array.isArray(method.errors) || method.errors.length === 0 || method.errors.some((entry) => typeof entry?.$ref !== 'string')) fail(`${method.name}: errors must contain component references`);
  if (method.params?.[0]?.schema?.$ref !== metadata.paramsSchemaRef) fail(`${method.name}: paramsSchemaRef does not match params schema`);
  if (method.result?.schema?.$ref !== metadata.resultSchemaRef) fail(`${method.name}: resultSchemaRef does not match result schema`);
  const methodErrorCodes = (method.errors || []).map((entry) => entry.$ref?.split('/').pop());
  if (new Set(methodErrorCodes).size !== methodErrorCodes.length) fail(`${method.name}: duplicate method error references`);
  if (!sameArray(methodErrorCodes, metadata.errorCodes)) fail(`${method.name}: errorCodes do not match method.errors`);
  if (metadata.defaultTimeoutMs > 0 && (!methodErrorCodes.includes('RequestTimeout') || !Array.isArray(metadata.errorCodes) || !metadata.errorCodes.includes('RequestTimeout'))) {
    fail(`${method.name}: positive defaultTimeoutMs requires RequestTimeout in method.errors and metadata.errorCodes`);
  }
  const stem = method.name.slice('orbit.'.length).split('.').map((part) => part[0].toUpperCase() + part.slice(1)).join('');
  if (metadata.paramsSchemaRef !== `#/components/schemas/${stem}Params`) fail(`${method.name}: params schema ref must be method-specific (${stem}Params)`);
  if (metadata.resultSchemaRef !== `#/components/schemas/${stem}Result`) fail(`${method.name}: result schema ref must be method-specific (${stem}Result)`);
  const paramsName = localRefName(method.params?.[0]?.schema?.$ref);
  const contextName = localRefName(document.components?.schemas?.[paramsName]?.properties?.context?.$ref);
  const expectedContext = expectedContextName(method);
  if (contextName !== expectedContext) fail(`${method.name}: params context must reference ${expectedContext}, received ${contextName || 'none'}`);
}

const schemas = document.components?.schemas || {};
const componentErrors = document.components?.errors || {};
function visit(value, location) {
  if (!value || typeof value !== 'object') return;
  if (typeof value.$ref === 'string') {
    const schemaName = localRefName(value.$ref);
    if (schemaName && !(schemaName in schemas)) fail(`${location}: undefined schema ref ${value.$ref}`);
    if (value.$ref.startsWith('#/components/errors/')) {
      const errorName = value.$ref.slice('#/components/errors/'.length);
      if (!(errorName in componentErrors)) fail(`${location}: undefined error ref ${value.$ref}`);
    }
  }
  for (const [key, child] of Object.entries(value)) visit(child, `${location}/${key}`);
}
visit(document, '#');

for (const [name, expectedCode] of standardErrors) {
  if (!componentErrors[name]) fail(`missing JSON-RPC error definition ${name}`);
  else if (componentErrors[name].code !== expectedCode) fail(`#/components/errors/${name}: code must be ${expectedCode}`);
}
const numericErrorCodes = new Map();
for (const [name, definition] of Object.entries(componentErrors)) {
  const validStandardCode = definition?.code === -32700 || [-32600, -32601, -32602, -32603].includes(definition?.code);
  const validServerCode = Number.isInteger(definition?.code) && definition.code >= -32099 && definition.code <= -32000;
  if (!validStandardCode && !validServerCode) fail(`#/components/errors/${name}: code must be a valid JSON-RPC standard or server error code`);
  if (typeof definition?.message !== 'string' || !definition.message.trim()) fail(`#/components/errors/${name}: message must be a non-empty string`);
  if (numericErrorCodes.has(definition?.code)) fail(`#/components/errors/${name}: duplicate numeric error code shared with ${numericErrorCodes.get(definition.code)}`);
  numericErrorCodes.set(definition?.code, name);
  const dataShape = objectShape(definition?.data);
  if (!dataShape) fail(`#/components/errors/${name}: data must reference or compose an object schema`);
  if (dataShape?.properties?.errorCode?.const !== name) fail(`#/components/errors/${name}: data.errorCode must be const ${name}`);
  if (dataShape?.properties?.retryable?.type !== 'boolean') fail(`#/components/errors/${name}: data.retryable must be boolean`);
  if (!dataShape?.required?.has('errorCode') || !dataShape?.required?.has('retryable')) fail(`#/components/errors/${name}: data must require errorCode and retryable`);
}

for (const requiredDto of requiredDtos) {
  if (!schemas[requiredDto]) fail(`missing fixed context/DTO schema ${requiredDto}`);
}

function dereference(schema) {
  const name = localRefName(schema?.$ref);
  return name ? schemas[name] : schema;
}

function objectShape(schema, seen = new Set()) {
  const refName = localRefName(schema?.$ref);
  if (refName) {
    if (seen.has(refName)) return undefined;
    seen = new Set(seen).add(refName);
    schema = schemas[refName];
  }
  if (!schema || typeof schema !== 'object') return undefined;
  const branches = schema.allOf || [schema];
  const properties = {};
  const required = new Set();
  let isObject = schema.type === 'object';
  for (const branch of branches) {
    const shape = branch === schema ? {
      properties: branch.properties || {},
      required: new Set(branch.required || []),
      isObject: branch.type === 'object' || !!branch.properties,
    } : objectShape(branch, seen);
    if (!shape) continue;
    isObject ||= shape.isObject;
    Object.assign(properties, shape.properties);
    for (const name of shape.required) required.add(name);
  }
  return isObject ? { properties, required, isObject: true } : undefined;
}

function requireSchemaProperty(schemaName, propertyName, predicate, expectation) {
  const shape = objectShape(schemas[schemaName]);
  if (!shape?.required.has(propertyName) || !predicate(shape.properties[propertyName])) {
    fail(`#/components/schemas/${schemaName}: must require ${propertyName} ${expectation}`);
  }
}

function validateRequestTimeoutAlternatives(schema) {
  const canonicalSchema = {
    allOf: [
      { $ref: '#/components/schemas/ErrorDataBase' },
      {
        type: 'object',
        properties: {
          errorCode: { type: 'string', const: 'RequestTimeout' },
          retryable: { type: 'boolean' },
          timeoutKind: { type: 'string', enum: ['queueTimeout', 'outcomeUnknown'] },
        },
        required: ['errorCode', 'retryable', 'timeoutKind'],
      },
      {
        oneOf: [
          {
            type: 'object',
            properties: {
              timeoutKind: { type: 'string', const: 'queueTimeout' },
            },
            required: ['timeoutKind'],
          },
          {
            type: 'object',
            properties: {
              timeoutKind: { type: 'string', const: 'outcomeUnknown' },
              operationId: { type: 'string', minLength: 1 },
            },
            required: ['timeoutKind', 'operationId'],
          },
        ],
      },
    ],
  };
  const stableJson = (value) => {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    if (value && typeof value === 'object') {
      return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
  };
  if (stableJson(schema) !== stableJson(canonicalSchema)) {
    fail('#/components/schemas/RequestTimeoutErrorData: must exactly match the canonical timeout recovery schema');
  }
}

requireSchemaProperty(
  'SessionAlreadyActiveErrorData',
  'current',
  (property) => localRefName(property?.$ref) === 'SessionSnapshot',
  'as a SessionSnapshot',
);
for (const propertyName of ['expectedGeneration', 'actualGeneration']) {
  requireSchemaProperty(
    'SessionChangedErrorData',
    propertyName,
    (property) => property?.type === 'integer' && property.minimum === 0,
    'as a nonnegative integer',
  );
}
requireSchemaProperty(
  'RequestTimeoutErrorData',
  'timeoutKind',
  (property) => sameArray(property?.enum, ['queueTimeout', 'outcomeUnknown']),
  'with enum queueTimeout|outcomeUnknown',
);
validateRequestTimeoutAlternatives(schemas.RequestTimeoutErrorData);

function hasMeaningfulShape(schema, ignoredProperties = new Set()) {
  const resolved = dereference(schema);
  if (!resolved || typeof resolved !== 'object') return false;
  if (Array.isArray(resolved.oneOf) && resolved.oneOf.some((entry) => hasMeaningfulShape(entry, ignoredProperties))) return true;
  if (Array.isArray(resolved.anyOf) && resolved.anyOf.some((entry) => hasMeaningfulShape(entry, ignoredProperties))) return true;
  if (Array.isArray(resolved.allOf)) {
    for (const entry of resolved.allOf) {
      const refName = localRefName(entry?.$ref);
      if (refName && !['BootstrapContext', 'ConnectionContext', 'ConnectionMutationContext', 'ProjectMutationContext', 'SessionRef', 'TargetRequestContext', 'TargetMutationContext', 'OperationResult'].includes(refName)) return true;
      if (!entry?.$ref && hasMeaningfulShape(entry, ignoredProperties)) return true;
    }
  }
  const properties = Object.keys(resolved.properties || {}).filter((name) => !ignoredProperties.has(name));
  if (properties.length > 0) return true;
  return resolved.type === 'array' && !!resolved.items && hasMeaningfulShape(resolved.items, ignoredProperties);
}

function inspectComposition(schema, location) {
  if (!schema || typeof schema !== 'object') return;
  if (Array.isArray(schema.allOf)) {
    for (const [index, branch] of schema.allOf.entries()) {
      const refName = localRefName(branch?.$ref);
      const target = refName ? schemas[refName] : branch;
      if (target?.additionalProperties === false) fail(`${location}/allOf/${index}: composed object branch must not set additionalProperties=false`);
    }
  }
  for (const [key, child] of Object.entries(schema)) inspectComposition(child, `${location}/${key}`);
}
inspectComposition(document, '#');
for (const method of methods) {
  if (!method?.name) continue;
  const paramsSchema = dereference(method.params?.[0]?.schema);
  const resultSchema = dereference(method.result?.schema);
  if (!hasMeaningfulShape(paramsSchema, new Set(['context']))) fail(`${method.name}: params schema has no meaningful fields beyond context`);
  if (!resultSchema || !Array.isArray(resultSchema.allOf) || !resultSchema.allOf.some((entry) => localRefName(entry?.$ref) === 'OperationResult')) fail(`${method.name}: result schema must extend OperationResult`);
  const resultShape = objectShape(method.result?.schema);
  const dataRef = resultShape?.properties?.data;
  if (!dataRef || !hasMeaningfulShape(dataRef)) fail(`${method.name}: result data schema must declare meaningful fields or alternatives`);
  if (/\.(list|search)$/.test(method.name)) {
    const dataSchema = dereference(dataRef);
    if (!dataSchema?.properties?.items || !dataSchema?.properties?.nextCursor) fail(`${method.name}: list/search result data must define items and nextCursor`);
  }
}

function inspectSchema(schema, location, propertyName, seen = new Set()) {
  if (!schema || typeof schema !== 'object') return;
  const refName = localRefName(schema.$ref);
  if (refName) {
    if (seen.has(refName)) return;
    seen = new Set(seen).add(refName);
    schema = schemas[refName];
  }
  if (propertyName) {
    const exact64 = /^(address|startAddress|endAddress|memoryReference|variablesReference|instructionPointerReference|pc|sp|lr|eventId|timestamp|timestampNs|startedAt|stoppedAt|heartbeatAt|expiresAt|dispatchedAt|completedAt|value64|uint64|int64)$/i.test(propertyName);
    if (exact64 && schema.type !== 'string') fail(`${location}: exact/address field ${propertyName} must be a string`);
  }
  if (propertyName && /^(data|bytes)$/i.test(propertyName) && schema['x-orbit-bytes'] === true && schema.contentEncoding !== 'base64') fail(`${location}: byte field ${propertyName} must use base64`);
  if (propertyName && /(expression|expressions|condition|logMessage)$/i.test(propertyName)) {
    const item = schema.type === 'array' ? dereference(schema.items) : schema;
    if (!item || item.type !== 'string' || item.minLength !== 1 || item['x-orbit-normalization'] !== 'unicode-preserving-trim') fail(`${location}: expression schema must preserve Unicode and reject trimmed empty values`);
  }
  for (const [key, child] of Object.entries(schema.properties || {})) inspectSchema(child, `${location}/properties/${key}`, key, seen);
  if (schema.items) inspectSchema(schema.items, `${location}/items`, propertyName, seen);
  for (const [index, child] of (schema.allOf || []).entries()) inspectSchema(child, `${location}/allOf/${index}`, propertyName, seen);
  for (const [index, child] of (schema.oneOf || []).entries()) inspectSchema(child, `${location}/oneOf/${index}`, propertyName, seen);
  for (const [index, child] of (schema.anyOf || []).entries()) inspectSchema(child, `${location}/anyOf/${index}`, propertyName, seen);
}
for (const [name, schema] of Object.entries(schemas)) inspectSchema(schema, `#/components/schemas/${name}`);

const caseIds = [...acceptance.matchAll(/\bAPI-(\d{3})\b/g)].map((match) => match[0]);
const caseHeadings = [...acceptance.matchAll(/^### (API-\d{3}):/gm)].map((match) => match[1]);
const duplicateCaseHeadings = caseHeadings.filter((id, index) => caseHeadings.indexOf(id) !== index);
if (duplicateCaseHeadings.length) fail(`duplicate acceptance case IDs: ${[...new Set(duplicateCaseHeadings)].join(', ')}`);
if (caseHeadings.length === 0) fail('acceptance matrix must define API-### cases');
for (let index = 0; index < caseHeadings.length; index += 1) {
  const expected = `API-${String(index + 1).padStart(3, '0')}`;
  if (caseHeadings[index] !== expected) fail(`acceptance case sequence mismatch: expected ${expected}, received ${caseHeadings[index]}`);
}
const requiredCategories = ['Discovery', 'Handshake', 'Session', 'Control', 'Breakpoints', 'Variables', 'Memory', 'Recording', 'Events', 'SDK', 'MCP', 'Error injection', 'J-Link hardware', 'CMSIS-DAP hardware'];
for (const category of requiredCategories) if (!acceptance.includes(`Category: ${category}`)) fail(`acceptance matrix missing category ${category}`);
for (const name of catalog) if (!new RegExp(`\\b${name.replace(/\./g, '\\.') }\\b`).test(acceptance)) fail(`acceptance matrix does not map method ${name}`);
for (const block of acceptance.split(/^### /m).slice(1)) {
  if (!/^API-\d{3}:/.test(block)) continue;
  if (!/Status: (Automated|Hardware-only)/.test(block)) fail(`${block.slice(0, 7)}: missing valid Status`);
  if (/Status: Hardware-only/.test(block) && !/Probe: (J-Link|CMSIS-DAP)/.test(block)) fail(`${block.slice(0, 7)}: hardware-only case must identify Probe`);
}
if (new Set(caseIds).size < caseHeadings.length) fail('acceptance matrix case references are malformed');

if (errors.length) {
  console.error(`Contract validation failed with ${errors.length} error(s):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Contract OK: ${catalog.length} unique methods, ${Object.keys(schemas).length} schemas, ${Object.keys(componentErrors).length} error definitions, ${caseHeadings.length} acceptance cases.`);
