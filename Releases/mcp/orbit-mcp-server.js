#!/usr/bin/env node

const path = require('node:path');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const CLIENT_PATH = path.join(__dirname, '..', '..', 'clients', 'node', 'dist', 'index.js');

function loadClient() {
  return require(CLIENT_PATH);
}

const AUTOMATION_SCOPES = [
  'read',
  'session.control',
  'breakpoints.write',
  'view.write',
  'record',
  'rtt.control',
  'variables.write',
  'memory.write',
  'flash',
];

const STEP_METHODS = {
  into: 'orbit.target.stepInto',
  over: 'orbit.target.stepOver',
  out: 'orbit.target.stepOut',
  instruction: 'orbit.target.stepInstruction',
};

const TOOL_SPECS = {
  orbit_instances: { title: 'List Orbit instances', description: 'Lists live Automation API instances. Tokens are never returned.' },
  orbit_handshake: { title: 'Handshake with an Orbit instance', description: 'Validates project/instance identity and requested scopes against Automation API v1.' },
  orbit_session_list: { title: 'List Orbit debug sessions', description: 'Lists Orbit debug sessions in the selected VS Code instance.' },
  orbit_session_snapshot: { title: 'Snapshot an Orbit session', description: 'Returns the exact session identity, generation, phase, and target state.' },
  orbit_session_start: { title: 'Start a visible Orbit session', description: 'Starts a visible VS Code Orbit debug session through vscode.debug.startDebugging().' },
  orbit_session_stop: { title: 'Stop an Orbit session', description: 'Stops the exact Orbit debug session identified by sessionId/generation.' },
  orbit_target_pause: { title: 'Pause the target', description: 'Pauses the bound Orbit session target.' },
  orbit_target_continue: { title: 'Continue the target', description: 'Continues the bound Orbit session target.' },
  orbit_target_reset: { title: 'Reset the target', description: 'Resets the bound Orbit session target.' },
  orbit_target_step: { title: 'Step the target', description: 'Steps the bound Orbit session: into, over, out, or instruction.' },
  orbit_breakpoints_list: { title: 'List breakpoints', description: 'Lists the VS Code breakpoint collection merged with DAP verified state.' },
  orbit_breakpoints_add: { title: 'Add a breakpoint', description: 'Adds a visible VS Code breakpoint.' },
  orbit_memory_read: { title: 'Read target memory', description: 'Reads target memory as Base64 bytes through the selected session owner.' },
  orbit_memory_write: { title: 'Write target memory', description: 'Writes Base64 bytes through the selected session owner.' },
  orbit_record_get: { title: 'Get recording frames', description: 'Reads a page of recording frames. Use cursor to continue; never request unbounded history.' },
  orbit_project_describe: { title: 'Describe the Orbit project', description: 'Returns the selected window project identity and workspace folders.' },
  orbit_expression_evaluate: { title: 'Evaluate an expression', description: 'Evaluates one debugger expression on the bound session.' },
  orbit_diagnostics_snapshot: { title: 'Diagnostics snapshot', description: 'Returns a redacted API/session diagnostics snapshot. Tokens are never included.' },
  orbit_status: { title: 'Get Orbit target status', description: 'Lists Orbit debug sessions after an explicit instance handshake.' },
  orbit_read_many: { title: 'Read target expressions', description: 'Reads one or more debugger expressions through orbit.expression.readMany.' },
  orbit_write_many: { title: 'Write target expressions', description: 'Writes debugger expressions through orbit.expression.writeMany.' },
  orbit_record: { title: 'Record target waveforms', description: 'Starts, pages, stops, and clears an Automation API recording.' },
  orbit_experiment_run: { title: 'Run a generic Orbit experiment', description: 'Runs orbit.experiment.run with type/kind step mapping.' },
};

const TOOL_NAMES = Object.keys(TOOL_SPECS);

const SignalSpec = z.object({
  alias: z.string().optional(),
  expression: z.string(),
  role: z.string().optional(),
  unit: z.string().optional(),
  writable: z.boolean().optional(),
});

const LegacyWriteSpec = z.object({
  alias: z.string().optional(),
  expression: z.string(),
  value: z.union([z.number(), z.string()]),
  address: z.number().int().min(0).max(0xFFFFFFFF).optional(),
  typeName: z.string().min(1).optional(),
});

const LegacyExperimentStep = z.object({
  type: z.enum(['read', 'write', 'wait', 'record']).optional(),
  kind: z.enum(['read', 'write', 'memoryRead', 'memoryWrite', 'wait', 'record']).optional(),
  signals: z.array(SignalSpec).optional(),
  expression: z.string().optional(),
  writes: z.array(LegacyWriteSpec).optional(),
  value: z.union([z.number(), z.string()]).optional(),
  durationMs: z.number().optional(),
  intervalMs: z.number().optional(),
  recordingId: z.string().optional(),
  channels: z.array(SignalSpec).optional(),
  expressions: z.array(z.string()).optional(),
  address: z.string().optional(),
  count: z.number().int().optional(),
  data: z.string().optional(),
});

function publicEndpoint(endpoint) {
  const { token: _token, ...publicFields } = endpoint;
  return publicFields;
}

function ok(data) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

function fail(payload) {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function toToolError(error) {
  const {
    AmbiguousInstanceError,
    InstanceNotFoundError,
    OrbitRpcError,
    OrbitClientError,
  } = loadClient();
  if (error instanceof AmbiguousInstanceError) {
    return fail({
      errorCode: 'AmbiguousInstance',
      retryable: false,
      message: error.message,
      candidates: error.candidates.map(item => item.instanceId).sort(),
    });
  }
  if (error instanceof InstanceNotFoundError) {
    return fail({ errorCode: 'InstanceNotFound', retryable: false, message: error.message });
  }
  if (error instanceof OrbitRpcError) {
    return fail({
      message: error.message,
      code: error.code,
      ...(error.data && typeof error.data === 'object' ? error.data : { errorCode: 'InternalError', retryable: false }),
    });
  }
  if (error instanceof OrbitClientError) {
    return fail({ errorCode: 'InvalidRequest', retryable: false, message: error.message });
  }
  return fail({ errorCode: 'InternalError', retryable: false, message: error?.message ?? String(error) });
}

function asStringValue(value) {
  return typeof value === 'string' ? value : String(value);
}

function mapLegacySteps(steps) {
  const mapped = [];
  for (const step of steps) {
    const kind = step.kind || step.type;
    if (kind === 'read') {
      const expressions = step.expression
        ? [step.expression]
        : (step.signals || []).map(signal => signal.expression);
      for (const expression of expressions) mapped.push({ kind: 'read', expression });
      continue;
    }
    if (kind === 'write') {
      const writes = step.writes || (step.expression !== undefined ? [{ expression: step.expression, value: step.value }] : []);
      for (const write of writes) mapped.push({ kind: 'write', expression: write.expression, value: asStringValue(write.value) });
      continue;
    }
    if (kind === 'wait') {
      mapped.push({ kind: 'wait', durationMs: step.durationMs });
      continue;
    }
    if (kind === 'record') {
      const expressions = step.expressions || (step.channels || []).map(channel => channel.expression);
      mapped.push({
        kind: 'record',
        expressions,
        durationMs: step.durationMs,
        intervalMs: step.intervalMs,
      });
      continue;
    }
    if (kind === 'memoryRead' || kind === 'memoryWrite') {
      mapped.push(step);
      continue;
    }
    mapped.push(step);
  }
  return mapped;
}

function mapRecordingChannels(channels) {
  return (channels || []).map((channel, index) => ({
    channelId: channel.alias || channel.channelId || channel.expression || `ch-${index}`,
    expression: channel.expression,
    valueType: channel.valueType || 'number',
    ...(channel.unit ? { unit: channel.unit } : {}),
  }));
}

function collectExpressions(args) {
  if (Array.isArray(args.expressions) && args.expressions.length > 0) return args.expressions;
  if (Array.isArray(args.signals)) return args.signals.map(signal => signal.expression);
  return [];
}

function createOrbitMcpAdapter(options = {}) {
  const clientApi = loadClient();
  const enumerate = options.enumerateInstances || clientApi.enumerateInstances;
  const select = options.selectInstance || clientApi.selectInstance;
  const createClient = options.createClient || ((endpoint, clientOptions) => new clientApi.OrbitClient(endpoint, clientOptions));
  const delay = options.delay || ((milliseconds) => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const requestId = options.requestId;
  const registryPath = options.registryPath;

  async function listLive(args = {}) {
    const instances = await enumerate({ registryPath });
    if (args.projectId) return instances.filter(item => item.projectId === args.projectId);
    return instances;
  }

  async function withClient(args, scopes, work) {
    const instances = await listLive(args);
    const endpoint = select(instances, { projectId: args.projectId, instanceId: args.instanceId });
    const client = createClient(endpoint, requestId ? { requestId } : {});
    try {
      const handshake = await client.handshake({
        client: { name: 'orbit-mcp-server', version: '1.0.0', pid: process.pid },
        requestedScopes: [...new Set(scopes)],
        workspaceRoot: args.workspaceRoot,
      });
      return await work(client, handshake);
    } finally {
      try { await client.close(); } catch { /* lease release must not mask the tool result */ }
    }
  }

  async function invokeBound(args, method, params, invokeOptions) {
    return withClient(args, invokeOptions.scopes, async client => {
      if (invokeOptions.context === 'target' || invokeOptions.context === 'targetMutation') {
        if (args.sessionId && Number.isInteger(args.sessionGeneration)) {
          client.session = {
            sessionId: args.sessionId,
            sessionGeneration: args.sessionGeneration,
            registryGeneration: args.sessionGeneration,
            phase: 'unknown',
            targetState: 'unknown',
          };
        } else {
          await client.refreshSession(args.sessionId);
        }
      }
      return client.invoke(method, params, {
        context: invokeOptions.context,
        idempotencyKey: args.idempotencyKey,
      });
    });
  }

  const handlers = {
    async orbit_instances(args = {}) {
      const items = (await listLive(args)).map(publicEndpoint);
      return ok({ items });
    },
    async orbit_handshake(args) {
      return withClient(args, args.requestedScopes || ['read'], async (_client, handshake) => handshake);
    },
    async orbit_project_describe(args) {
      return withClient(args, ['read'], client => client.invoke('orbit.project.describe', {}, { context: 'bootstrap' }));
    },
    async orbit_session_list(args) {
      return invokeBound(args, 'orbit.session.list', {
        includeTerminated: args.includeTerminated,
        limit: args.limit,
        cursor: args.cursor,
      }, { context: 'connection', scopes: ['read'] });
    },
    async orbit_session_snapshot(args) {
      return invokeBound(args, 'orbit.session.snapshot', {
        sessionId: args.sessionId,
        includeCapabilities: args.includeCapabilities ?? true,
      }, { context: 'connection', scopes: ['read'] });
    },
    async orbit_session_start(args) {
      return invokeBound(args, 'orbit.session.start', {
        configurationId: args.configurationId,
        configurationName: args.configurationName,
        noDebug: args.noDebug,
        timeoutMs: args.timeoutMs,
      }, { context: 'projectMutation', scopes: ['read', 'session.control'] });
    },
    async orbit_session_stop(args) {
      return invokeBound(args, 'orbit.session.stop', {
        terminateDebuggee: args.terminateDebuggee,
      }, { context: 'targetMutation', scopes: ['read', 'session.control'] });
    },
    async orbit_target_pause(args) {
      return invokeBound(args, 'orbit.target.pause', { threadId: args.threadId }, {
        context: 'targetMutation',
        scopes: ['read', 'session.control'],
      });
    },
    async orbit_target_continue(args) {
      return invokeBound(args, 'orbit.target.continue', { threadId: args.threadId }, {
        context: 'targetMutation',
        scopes: ['read', 'session.control'],
      });
    },
    async orbit_target_reset(args) {
      return invokeBound(args, 'orbit.target.reset', { mode: args.mode }, {
        context: 'targetMutation',
        scopes: ['read', 'session.control'],
      });
    },
    async orbit_target_step(args) {
      const method = STEP_METHODS[args.action || 'into'];
      if (!method) throw new clientApi.OrbitClientError(`unsupported step action: ${args.action}`);
      return invokeBound(args, method, { threadId: args.threadId }, {
        context: 'targetMutation',
        scopes: ['read', 'session.control'],
      });
    },
    async orbit_breakpoints_list(args) {
      return invokeBound(args, 'orbit.breakpoints.list', { cursor: args.cursor, limit: args.limit }, {
        context: 'connection',
        scopes: ['read'],
      });
    },
    async orbit_breakpoints_add(args) {
      return invokeBound(args, 'orbit.breakpoints.add', {
        breakpoint: args.breakpoint,
        waitForVerificationMs: args.waitForVerificationMs,
      }, { context: 'connectionMutation', scopes: ['read', 'breakpoints.write'] });
    },
    async orbit_memory_read(args) {
      return invokeBound(args, 'orbit.memory.read', {
        address: args.address,
        count: args.count,
        allowPartial: args.allowPartial,
      }, { context: 'target', scopes: ['read'] });
    },
    async orbit_memory_write(args) {
      return invokeBound(args, 'orbit.memory.write', {
        address: args.address,
        data: args.data,
        verify: args.verify,
      }, { context: 'targetMutation', scopes: ['read', 'memory.write'] });
    },
    async orbit_record_get(args) {
      return invokeBound(args, 'orbit.record.get', {
        recordingId: args.recordingId,
        cursor: args.cursor,
        limit: args.limit,
      }, { context: 'target', scopes: ['read'] });
    },
    async orbit_expression_evaluate(args) {
      return invokeBound(args, 'orbit.expression.evaluate', {
        expression: args.expression,
        frameId: args.frameId,
        contextKind: args.contextKind,
      }, { context: 'target', scopes: ['read'] });
    },
    async orbit_diagnostics_snapshot(args) {
      return invokeBound(args, 'orbit.diagnostics.snapshot', {}, { context: 'connection', scopes: ['read'] });
    },
    async orbit_status(args) {
      return handlers.orbit_session_list(args);
    },
    async orbit_read_many(args) {
      return invokeBound(args, 'orbit.expression.readMany', {
        expressions: collectExpressions(args),
        frameId: args.frameId,
        forceRealtime: args.forceRealtime,
      }, { context: 'target', scopes: ['read'] });
    },
    async orbit_write_many(args) {
      return invokeBound(args, 'orbit.expression.writeMany', {
        writes: (args.writes || []).map(write => ({
          expression: write.expression,
          value: asStringValue(write.value),
        })),
        frameId: args.frameId,
      }, { context: 'targetMutation', scopes: ['read', 'variables.write'] });
    },
    async orbit_record(args) {
      return withClient(args, ['read', 'record'], async client => {
        await client.refreshSession(args.sessionId);
        const started = await client.invoke('orbit.record.start', {
          name: args.name || 'mcp-record',
          channels: mapRecordingChannels(args.channels),
          intervalMs: args.intervalMs ?? 10,
        }, { context: 'targetMutation', idempotencyKey: args.idempotencyKey });
        const recordingId = started.recordingId;
        await delay(Math.max(0, args.durationMs || 0));
        const items = [];
        for await (const page of client.paginate('orbit.record.get', { recordingId }, { context: 'target' })) {
          items.push(...page.items);
        }
        await client.invoke('orbit.record.stop', { recordingId }, { context: 'targetMutation' });
        await client.invoke('orbit.record.clear', { recordingId }, { context: 'targetMutation' });
        return { recordingId, items };
      });
    },
    async orbit_experiment_run(args) {
      return invokeBound(args, 'orbit.experiment.run', {
        name: args.name || 'mcp-experiment',
        timeoutMs: args.timeoutMs ?? 60000,
        continueOnError: args.continueOnError,
        steps: mapLegacySteps(args.steps || []),
      }, { context: 'targetMutation', scopes: ['read', 'variables.write', 'record'] });
    },
  };

  async function callTool(name, args = {}) {
    const handler = handlers[name];
    if (!handler) return fail({ errorCode: 'MethodNotFound', retryable: false, message: `unknown tool: ${name}` });
    try {
      const data = await handler(args);
      if (data && typeof data === 'object' && Array.isArray(data.content)) return data;
      return ok(data);
    } catch (error) {
      return toToolError(error);
    }
  }

  return {
    usesNodeClient: true,
    callTool,
  };
}

const identityFields = {
  projectId: z.string().optional(),
  instanceId: z.string().optional(),
  workspaceRoot: z.string().optional(),
};

const sessionFields = {
  ...identityFields,
  sessionId: z.string().optional(),
  sessionGeneration: z.number().int().min(0).optional(),
};

const mutationFields = {
  ...sessionFields,
  idempotencyKey: z.string().min(1),
};

function createMcpServer(options = {}) {
  const adapter = createOrbitMcpAdapter(options);
  const server = new McpServer({
    name: 'orbit-debug-mcp',
    version: '1.0.0',
  });

  const register = (name, inputSchema) => {
    server.registerTool(name, {
      title: TOOL_SPECS[name].title,
      description: TOOL_SPECS[name].description,
      inputSchema,
    }, async args => adapter.callTool(name, args || {}));
  };

  register('orbit_instances', { projectId: z.string().optional() });
  register('orbit_handshake', {
    ...identityFields,
    requestedScopes: z.array(z.enum(AUTOMATION_SCOPES)).optional(),
  });
  register('orbit_project_describe', identityFields);
  register('orbit_session_list', {
    ...identityFields,
    includeTerminated: z.boolean().optional(),
    limit: z.number().int().min(1).max(1000).optional(),
    cursor: z.string().optional(),
  });
  register('orbit_session_snapshot', {
    ...identityFields,
    sessionId: z.string().min(1),
    includeCapabilities: z.boolean().optional(),
  });
  register('orbit_session_start', {
    ...identityFields,
    idempotencyKey: z.string().min(1),
    configurationId: z.string().min(1),
    configurationName: z.string().optional(),
    noDebug: z.boolean().optional(),
    timeoutMs: z.number().int().min(1).max(30000).optional(),
  });
  register('orbit_session_stop', {
    ...mutationFields,
    terminateDebuggee: z.boolean().optional(),
  });
  register('orbit_target_pause', {
    ...mutationFields,
    threadId: z.number().int().min(1).optional(),
  });
  register('orbit_target_continue', {
    ...mutationFields,
    threadId: z.number().int().min(1).optional(),
  });
  register('orbit_target_reset', {
    ...mutationFields,
    mode: z.enum(['halt', 'run']).optional(),
  });
  register('orbit_target_step', {
    ...mutationFields,
    action: z.enum(['into', 'over', 'out', 'instruction']).optional(),
    threadId: z.number().int().min(1).optional(),
  });
  register('orbit_breakpoints_list', identityFields);
  register('orbit_breakpoints_add', {
    ...identityFields,
    idempotencyKey: z.string().min(1),
    breakpoint: z.object({
      source: z.object({
        path: z.string().min(1),
        line: z.number().int().min(1),
        column: z.number().int().min(1).optional(),
      }),
      enabled: z.boolean().optional(),
      condition: z.string().optional(),
      hitCondition: z.string().optional(),
      logMessage: z.string().optional(),
    }),
    waitForVerificationMs: z.number().int().min(0).max(15000).optional(),
  });
  register('orbit_memory_read', {
    ...sessionFields,
    address: z.string().min(1),
    count: z.number().int().min(1).max(1048576),
    allowPartial: z.boolean().optional(),
  });
  register('orbit_memory_write', {
    ...mutationFields,
    address: z.string().min(1),
    data: z.string().min(1),
    verify: z.boolean().optional(),
  });
  register('orbit_record_get', {
    ...sessionFields,
    recordingId: z.string().min(1),
    cursor: z.string().optional(),
    limit: z.number().int().min(1).max(1000).optional(),
  });
  register('orbit_expression_evaluate', {
    ...sessionFields,
    expression: z.string().min(1),
    frameId: z.number().int().min(1).optional(),
    contextKind: z.enum(['watch', 'hover', 'repl', 'clipboard', 'variables']).optional(),
  });
  register('orbit_diagnostics_snapshot', identityFields);
  register('orbit_status', identityFields);
  register('orbit_read_many', {
    ...sessionFields,
    expressions: z.array(z.string()).optional(),
    signals: z.array(SignalSpec).optional(),
    frameId: z.number().int().min(1).optional(),
    forceRealtime: z.boolean().optional(),
  });
  register('orbit_write_many', {
    ...mutationFields,
    writes: z.array(LegacyWriteSpec),
    frameId: z.number().int().min(1).optional(),
  });
  register('orbit_record', {
    ...mutationFields,
    durationMs: z.number(),
    intervalMs: z.number().optional(),
    name: z.string().optional(),
    channels: z.array(SignalSpec),
  });
  register('orbit_experiment_run', {
    ...mutationFields,
    name: z.string().optional(),
    timeoutMs: z.number().int().min(1).max(600000).optional(),
    continueOnError: z.boolean().optional(),
    steps: z.array(LegacyExperimentStep),
  });

  installRequiredShim(server);

  return { server, adapter };
}

/**
 * Recursively ensures every `type: "object"` JSON Schema carries a
 * `required` ARRAY. opencode converts an object schema without `required`
 * into `required: null` (issue #15540, fix PR #15538 never merged); strict
 * OpenAI-compatible gateways that translate to Anthropic reject that payload
 * with `standard_violation /required: got null, want array`. Keeping an
 * explicit empty array survives opencode's conversion unchanged.
 */
function normalizeRequired(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const result = Array.isArray(schema) ? [...schema] : { ...schema };
  if (result.type === 'object' && !Array.isArray(result.required)) {
    result.required = [];
  }
  for (const key of ['properties', 'definitions', '$defs', 'patternProperties']) {
    if (result[key] && typeof result[key] === 'object' && !Array.isArray(result[key])) {
      for (const child of Object.values(result[key])) normalizeRequired(child);
    }
  }
  for (const key of ['items', 'additionalProperties', 'contains', 'propertyNames', 'if', 'then', 'else', 'not', 'unevaluatedItems', 'unevaluatedProperties']) {
    if (Array.isArray(result[key])) {
      result[key].forEach(normalizeRequired);
    } else if (result[key] && typeof result[key] === 'object') {
      normalizeRequired(result[key]);
    }
  }
  for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) {
    if (Array.isArray(result[key])) result[key].forEach(normalizeRequired);
  }
  return result;
}

/**
 * Wraps the SDK tools/list handler so the advertised inputSchema is safe for
 * strict OpenAI-compatible gateways (opencode -> Anthropic translation).
 * `Protocol.setRequestHandler` documents replacement of previous handlers.
 */
function installRequiredShim(server) {
  const { ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
  const original = server.server._requestHandlers?.get('tools/list');
  if (!original) return;
  server.server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
    const result = await original(request, extra);
    result.tools = (result.tools || []).map(tool => ({
      ...tool,
      inputSchema: normalizeRequired(tool.inputSchema),
    }));
    return result;
  });
}

async function startStdio(options = {}) {
  const { server } = createMcpServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (require.main === module) {
  startStdio().catch(err => {
    console.error(`[orbit-mcp] ${err?.stack || err?.message || err}`);
    process.exit(1);
  });
}

module.exports = {
  TOOL_NAMES,
  createOrbitMcpAdapter,
  createMcpServer,
  startStdio,
};
