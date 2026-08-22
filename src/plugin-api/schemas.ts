// Orbit Automation API v1 — Zod request validation and the frozen method catalog.
//
// Every schema here implements docs/api/orbit-automation-openrpc.json verbatim
// (plan §1.8). Field names, constraints, defaults and required sets are the
// frozen contract; rpc-dispatcher.test.ts verifies the catalog below against
// the OpenRPC document so the two cannot drift.
import { z } from 'zod';
import { AutomationScope } from './protocol';

// --- Shared primitives (OpenRPC #/components/schemas) ---

export const automationScopeSchema = z.enum([
  'read',
  'session.control',
  'breakpoints.write',
  'view.write',
  'record',
  'rtt.control',
  'variables.write',
  'memory.write',
  'flash',
]);

/** Expression: Unicode-preserving trim, reject entries that trim to empty. */
export const expressionSchema = z
  .string()
  .transform(value => value.trim())
  .pipe(z.string().min(1));

/** Exact 64-bit value: decimal or 0x-hex string, never a JSON number. */
export const uint64Schema = z.string().regex(/^(0|[1-9][0-9]*|0x[0-9A-Fa-f]+)$/);

export const addressSchema = z.string().regex(/^0x[0-9A-Fa-f]+$/);

export const cursorSchema = z.string().min(1);

export const pageRequestSchema = z
  .object({
    cursor: cursorSchema.optional(),
    limit: z.number().int().min(1).max(1000).default(100),
  })
  .strict();

export function uniqueItems<T>(schema: z.ZodType<T>): z.ZodType<T[]> {
  return z.array(schema).refine(items => new Set(items).size === items.length, {
    message: 'items must be unique',
  });
}

// --- Fixed public contexts (plan §1.8) ---

export const bootstrapContextSchema = z.object({
  instanceId: z.string().min(1),
  projectId: z.string().regex(/^sha256:/),
});

export const connectionContextSchema = z.object({
  instanceId: z.string().min(1),
  projectId: z.string().regex(/^sha256:/),
  connectionId: z.string().min(1),
});

export const connectionMutationContextSchema = z.object({
  instanceId: z.string().min(1),
  projectId: z.string().regex(/^sha256:/),
  connectionId: z.string().min(1),
  idempotencyKey: z.string().min(1).max(256),
});

export const projectMutationContextSchema = z.object({
  instanceId: z.string().min(1),
  projectId: z.string().regex(/^sha256:/),
  connectionId: z.string().min(1),
  idempotencyKey: z.string().min(1).max(256),
  registryGeneration: z.number().int().min(0),
});

export const sessionRefSchema = z.object({
  sessionId: z.string().min(1),
  sessionGeneration: z.number().int().min(1),
});

export const targetRequestContextSchema = z.object({
  instanceId: z.string().min(1),
  projectId: z.string().regex(/^sha256:/),
  connectionId: z.string().min(1),
  sessionId: z.string().min(1),
  sessionGeneration: z.number().int().min(1),
});

export const targetMutationContextSchema = z.object({
  instanceId: z.string().min(1),
  projectId: z.string().regex(/^sha256:/),
  connectionId: z.string().min(1),
  sessionId: z.string().min(1),
  sessionGeneration: z.number().int().min(1),
  idempotencyKey: z.string().min(1).max(256),
});

// --- JSON-RPC envelope ---

export const jsonRpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]),
  method: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional(),
});

export interface ZodIssueInfo {
  path: string;
  message: string;
}

export function zodErrorIssues(error: z.ZodError): ZodIssueInfo[] {
  return error.issues.map(issue => ({
    path: issue.path.map(part => String(part)).join('.') || '(root)',
    message: issue.message,
  }));
}

// --- Shared request DTOs ---

const sourceLocationSchema = z
  .object({
    path: z.string().min(1),
    line: z.number().int().min(1),
    column: z.number().int().min(1).optional(),
    endLine: z.number().int().min(1).optional(),
    endColumn: z.number().int().min(1).optional(),
  })
  .strict();

export const breakpointInputSchema = z
  .object({
    source: sourceLocationSchema,
    enabled: z.boolean().default(true),
    condition: expressionSchema.optional(),
    hitCondition: expressionSchema.optional(),
    logMessage: expressionSchema.optional(),
  })
  .strict();

const expressionWriteSchema = z
  .object({
    expression: expressionSchema,
    value: expressionSchema,
  })
  .strict();

export const experimentStepSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('read'),
      expression: expressionSchema,
      as: z.string().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('write'),
      expression: expressionSchema,
      value: expressionSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('memoryRead'),
      address: addressSchema,
      count: z.number().int().min(1).max(1048576),
    })
    .strict(),
  z
    .object({
      kind: z.literal('memoryWrite'),
      address: addressSchema,
      data: z.string().max(1398104),
    })
    .strict(),
  z
    .object({
      kind: z.literal('wait'),
      durationMs: z.number().int().min(0).max(600000),
    })
    .strict(),
  z
    .object({
      kind: z.literal('record'),
      expressions: z.array(expressionSchema).min(1).max(64),
      durationMs: z.number().int().min(5).max(600000),
      intervalMs: z.number().int().min(5),
    })
    .strict(),
]);

const recordingChannelSchema = z
  .object({
    channelId: z.string(),
    expression: expressionSchema,
    unit: z.string().optional(),
    valueType: z.string(),
  })
  .strict();

const restartArgumentsSchema = z
  .object({
    preserveBreakpoints: z.boolean().default(true),
  })
  .strict();

const integerLimit = z.number().int().min(1).max(1000).default(100);

// --- Per-method params schemas (OpenRPC method.params, in catalog order) ---

export const instanceDescribeParams = z
  .object({
    context: bootstrapContextSchema,
    includeEndpoint: z.boolean().default(true),
  })
  .strict();

export const projectDescribeParams = z
  .object({
    context: bootstrapContextSchema,
    includeLaunchConfigurations: z.boolean().default(true),
  })
  .strict();

export const projectListLaunchConfigurationsParams = z
  .object({
    context: connectionContextSchema,
    page: pageRequestSchema.optional(),
    includeLegacyAlias: z.boolean().default(true),
  })
  .strict();

export const handshakeParams = z
  .object({
    context: bootstrapContextSchema,
    apiVersion: z.literal('1.0'),
    client: z
      .object({
        name: z.string().min(1),
        version: z.string().optional(),
        pid: z.number().int().min(1).optional(),
      })
      .strict(),
    expected: z
      .object({
        projectId: z.string().regex(/^sha256:/),
        instanceId: z.string().optional(),
        workspaceRoot: z.string().optional(),
      })
      .strict(),
    requestedScopes: uniqueItems(automationScopeSchema).optional(),
  })
  .strict();

export const connectionCloseParams = z
  .object({
    context: connectionContextSchema,
    reason: z.string().max(256).optional(),
  })
  .strict();

export const operationGetParams = z
  .object({
    context: connectionContextSchema,
    operationId: z.string().min(1),
  })
  .strict();

export const systemCapabilitiesParams = z
  .object({
    context: bootstrapContextSchema,
    includeUnavailable: z.boolean().default(true),
  })
  .strict();

export const sessionListParams = z
  .object({
    context: connectionContextSchema,
    cursor: cursorSchema.optional(),
    limit: integerLimit,
    includeTerminated: z.boolean().default(false),
  })
  .strict();

export const sessionSnapshotParams = z
  .object({
    context: connectionContextSchema,
    sessionId: z.string().min(1),
    includeCapabilities: z.boolean().default(true),
  })
  .strict();

export const sessionStartParams = z
  .object({
    context: projectMutationContextSchema,
    configurationId: z.string().min(1),
    configurationName: z.string().min(1).optional(),
    noDebug: z.boolean().default(false),
    timeoutMs: z.number().int().min(1).max(30000).default(30000),
  })
  .strict();

export const sessionStopParams = z
  .object({
    context: targetMutationContextSchema,
    terminateDebuggee: z.boolean().default(true),
    restartArguments: restartArgumentsSchema.optional(),
  })
  .strict();

export const sessionRestartParams = z
  .object({
    context: targetMutationContextSchema,
    terminateDebuggee: z.boolean().default(true),
    restartArguments: restartArgumentsSchema.optional(),
  })
  .strict();

export const targetPauseParams = z
  .object({
    context: targetMutationContextSchema,
    threadId: z.number().int().min(1).optional(),
  })
  .strict();

export const targetContinueParams = z
  .object({
    context: targetMutationContextSchema,
    threadId: z.number().int().min(1).optional(),
    singleThread: z.boolean().default(false),
  })
  .strict();

export const targetResetParams = z
  .object({
    context: targetMutationContextSchema,
    mode: z.enum(['halt', 'run']).default('halt'),
  })
  .strict();

const stepGranularity = z.enum(['source', 'instruction']).default('source');

export const targetStepOverParams = z
  .object({
    context: targetMutationContextSchema,
    threadId: z.number().int().min(1),
    granularity: stepGranularity,
  })
  .strict();

export const targetStepIntoParams = z
  .object({
    context: targetMutationContextSchema,
    threadId: z.number().int().min(1),
    granularity: stepGranularity,
  })
  .strict();

export const targetStepOutParams = z
  .object({
    context: targetMutationContextSchema,
    threadId: z.number().int().min(1),
    granularity: stepGranularity,
  })
  .strict();

export const targetStepInstructionParams = z
  .object({
    context: targetMutationContextSchema,
    threadId: z.number().int().min(1),
    granularity: z.enum(['instruction']).default('instruction'),
  })
  .strict();

export const targetFlashParams = z
  .object({
    context: targetMutationContextSchema,
    elfPath: z.string().min(1),
    verify: z.boolean().default(true),
    resetAfter: z.enum(['none', 'halt', 'run']).default('halt'),
    timeoutMs: z.number().int().min(1).max(180000).default(180000),
  })
  .strict();

export const breakpointsListParams = z
  .object({
    context: connectionContextSchema,
    sourcePath: z.string().optional(),
    cursor: cursorSchema.optional(),
    limit: integerLimit,
  })
  .strict();

const waitForVerificationMs = z.number().int().min(0).max(15000).default(5000);

export const breakpointsAddParams = z
  .object({
    context: connectionMutationContextSchema,
    breakpoint: breakpointInputSchema,
    waitForVerificationMs,
  })
  .strict();

export const breakpointsUpdateParams = z
  .object({
    context: connectionMutationContextSchema,
    breakpointId: z.string().min(1),
    breakpoint: breakpointInputSchema,
    waitForVerificationMs,
  })
  .strict();

export const breakpointsRemoveParams = z
  .object({
    context: connectionMutationContextSchema,
    breakpointId: z.string().min(1),
  })
  .strict();

export const breakpointsReplaceParams = z
  .object({
    context: connectionMutationContextSchema,
    sourcePath: z.string().min(1),
    breakpoints: z.array(breakpointInputSchema).max(1000),
    waitForVerificationMs,
  })
  .strict();

export const runtimeThreadsParams = z
  .object({
    context: targetRequestContextSchema,
    cursor: cursorSchema.optional(),
    limit: integerLimit,
  })
  .strict();

export const runtimeStackTraceParams = z
  .object({
    context: targetRequestContextSchema,
    threadId: z.number().int().min(1),
    startFrame: z.number().int().min(0).default(0),
    levels: z.number().int().min(1).max(1000).default(100),
    cursor: cursorSchema.optional(),
  })
  .strict();

export const runtimeScopesParams = z
  .object({
    context: targetRequestContextSchema,
    frameId: z.number().int().min(1),
    cursor: cursorSchema.optional(),
    limit: integerLimit,
  })
  .strict();

export const runtimeVariablesParams = z
  .object({
    context: targetRequestContextSchema,
    variablesReference: uint64Schema,
    filter: z.enum(['named', 'indexed']).optional(),
    start: z.number().int().min(0).optional(),
    count: z.number().int().min(1).max(1000).default(100),
    cursor: cursorSchema.optional(),
  })
  .strict();

export const runtimeRegistersParams = z
  .object({
    context: targetRequestContextSchema,
    groups: uniqueItems(z.enum(['core', 'floating', 'system'])).optional(),
    cursor: cursorSchema.optional(),
    limit: integerLimit,
  })
  .strict();

export const expressionEvaluateParams = z
  .object({
    context: targetRequestContextSchema,
    expression: expressionSchema,
    frameId: z.number().int().min(1).optional(),
    contextKind: z.enum(['watch', 'hover', 'repl', 'clipboard', 'variables']).default('watch'),
  })
  .strict();

export const expressionReadManyParams = z
  .object({
    context: targetRequestContextSchema,
    expressions: z.array(expressionSchema).min(1).max(1000),
    frameId: z.number().int().min(1).optional(),
    forceRealtime: z.boolean().default(false),
  })
  .strict();

export const expressionWriteManyParams = z
  .object({
    context: targetMutationContextSchema,
    writes: z.array(expressionWriteSchema).min(1).max(1000),
    frameId: z.number().int().min(1).optional(),
    resumeIntent: z.enum(['preserve', 'halted', 'running']).default('preserve'),
  })
  .strict();

export const expressionInspectParams = z
  .object({
    context: targetRequestContextSchema,
    expression: expressionSchema,
    frameId: z.number().int().min(1).optional(),
    depth: z.number().int().min(0).max(8).default(2),
    maxChildren: z.number().int().min(1).max(1000).default(100),
  })
  .strict();

export const symbolSearchParams = z
  .object({
    context: targetRequestContextSchema,
    query: z.string().min(1),
    kinds: uniqueItems(z.enum(['function', 'variable', 'type', 'section', 'unknown'])).optional(),
    cursor: cursorSchema.optional(),
    limit: integerLimit,
  })
  .strict();

export const symbolResolveParams = z
  .object({
    context: targetRequestContextSchema,
    name: z.string().min(1).optional(),
    address: addressSchema.optional(),
  })
  .strict()
  .superRefine((params, ctx) => {
    if (params.name === undefined && params.address === undefined) {
      ctx.addIssue({ code: 'custom', path: ['name'], message: 'either name or address must be provided' });
    }
  });

export const memoryReadParams = z
  .object({
    context: targetRequestContextSchema,
    address: addressSchema,
    count: z.number().int().min(1).max(1048576),
    allowPartial: z.boolean().default(true),
  })
  .strict();

export const memoryWriteParams = z
  .object({
    context: targetMutationContextSchema,
    address: addressSchema,
    data: z.string().max(1398104),
    verify: z.boolean().default(true),
  })
  .strict();

export const watchListParams = z
  .object({
    context: connectionContextSchema,
    includeValues: z.boolean().default(true),
  })
  .strict();

export const watchReplaceParams = z
  .object({
    context: connectionMutationContextSchema,
    expressions: z.array(expressionSchema).max(1000),
  })
  .strict();

export const watchAddParams = z
  .object({
    context: connectionMutationContextSchema,
    expressions: z.array(expressionSchema).min(1).max(1000),
  })
  .strict();

export const watchRemoveParams = z
  .object({
    context: connectionMutationContextSchema,
    expressions: z.array(expressionSchema).min(1).max(1000),
  })
  .strict();

export const timelineListParams = z
  .object({
    context: connectionContextSchema,
    includeStatus: z.boolean().default(true),
  })
  .strict();

export const timelineReplaceParams = z
  .object({
    context: connectionMutationContextSchema,
    expressions: z.array(expressionSchema).max(64),
  })
  .strict();

export const timelineStartParams = z
  .object({
    context: targetMutationContextSchema,
    intervalMs: z.number().int().min(5).default(20),
    maxFrames: z.number().int().min(1).max(50000).default(50000),
  })
  .strict();

export const timelineStopParams = z
  .object({
    context: targetMutationContextSchema,
    flush: z.boolean().default(true),
  })
  .strict();

export const timelineStatusParams = z
  .object({
    context: targetRequestContextSchema,
    includePerformance: z.boolean().default(true),
  })
  .strict();

export const recordStartParams = z
  .object({
    context: targetMutationContextSchema,
    name: z.string().min(1),
    channels: z.array(recordingChannelSchema).min(1).max(64),
    intervalMs: z.number().int().min(0),
    maxFrames: z.number().int().min(1).max(50000).default(50000),
  })
  .strict();

export const recordStopParams = z
  .object({
    context: targetMutationContextSchema,
    recordingId: z.string().min(1),
  })
  .strict();

export const recordListParams = z
  .object({
    context: targetRequestContextSchema,
    cursor: cursorSchema.optional(),
    limit: integerLimit,
    status: z.string().optional(),
  })
  .strict();

export const recordGetParams = z
  .object({
    context: targetRequestContextSchema,
    recordingId: z.string(),
    cursor: cursorSchema.optional(),
    limit: integerLimit,
  })
  .strict();

export const recordClearParams = z
  .object({
    context: targetMutationContextSchema,
    recordingId: z.string().min(1),
  })
  .strict();

export const experimentRunParams = z
  .object({
    context: targetMutationContextSchema,
    name: z.string().min(1),
    steps: z.array(experimentStepSchema).min(1).max(1000),
    timeoutMs: z.number().int().min(1).max(600000),
    continueOnError: z.boolean().default(false),
  })
  .strict();

export const rttStatusParams = z
  .object({
    context: targetRequestContextSchema,
    bufferIndex: z.number().int().min(0).default(0),
  })
  .strict();

export const rttStartParams = z
  .object({
    context: targetMutationContextSchema,
    bufferIndex: z.number().int().min(0).default(0),
    pollIntervalMs: z.number().int().min(1).default(50),
    targetName: z.string().optional(),
    ansi: z.boolean().default(true),
  })
  .strict();

export const rttStopParams = z
  .object({
    context: targetMutationContextSchema,
    bufferIndex: z.number().int().min(0).default(0),
  })
  .strict();

export const rttReadParams = z
  .object({
    context: targetRequestContextSchema,
    bufferIndex: z.number().int().min(0).default(0),
    cursor: cursorSchema.optional(),
    maxBytes: z.number().int().min(1).max(1048576).default(65536),
  })
  .strict();

export const rttLogReadParams = z
  .object({
    context: targetRequestContextSchema,
    count: z.number().int().min(1).max(1000),
    cursor: cursorSchema.optional(),
    stripAnsi: z.boolean().default(true),
  })
  .strict();

export const diagnosticsSnapshotParams = z
  .object({
    context: connectionContextSchema,
    sessionId: z.string().optional(),
    includeLogs: z.boolean().default(false),
    includePerformance: z.boolean().default(true),
  })
  .strict();

// --- Frozen method catalog (OpenRPC x-orbit-method metadata) ---

export type AutomationMethodName = `orbit.${string}`;

export interface MethodCatalogEntry {
  name: AutomationMethodName;
  bootstrap: boolean;
  requiredScopes: readonly AutomationScope[];
  mutation: boolean;
  requiresIdempotency: boolean;
  targetBound: boolean;
  timeoutMs: number;
  paramsSchemaRef: string;
  resultSchemaRef: string;
  errorCodes: readonly string[];
  paramsSchema: z.ZodType<unknown>;
}

const METHOD_ENTRIES: MethodCatalogEntry[] = [
  { name: 'orbit.instance.describe', bootstrap: true, requiredScopes: [], mutation: false, requiresIdempotency: false, targetBound: false, timeoutMs: 2000, paramsSchemaRef: '#/components/schemas/InstanceDescribeParams', resultSchemaRef: '#/components/schemas/InstanceDescribeResult', errorCodes: ['Unauthorized', 'InvalidRequest', 'RequestTimeout', 'InternalError'], paramsSchema: instanceDescribeParams },
  { name: 'orbit.project.describe', bootstrap: true, requiredScopes: [], mutation: false, requiresIdempotency: false, targetBound: false, timeoutMs: 2000, paramsSchemaRef: '#/components/schemas/ProjectDescribeParams', resultSchemaRef: '#/components/schemas/ProjectDescribeResult', errorCodes: ['Unauthorized', 'InvalidRequest', 'RequestTimeout', 'InternalError'], paramsSchema: projectDescribeParams },
  { name: 'orbit.project.listLaunchConfigurations', bootstrap: false, requiredScopes: ['read'], mutation: false, requiresIdempotency: false, targetBound: false, timeoutMs: 5000, paramsSchemaRef: '#/components/schemas/ProjectListLaunchConfigurationsParams', resultSchemaRef: '#/components/schemas/ProjectListLaunchConfigurationsResult', errorCodes: ['Unauthorized', 'InvalidRequest', 'RequestTimeout', 'InternalError'], paramsSchema: projectListLaunchConfigurationsParams },
  { name: 'orbit.handshake', bootstrap: true, requiredScopes: [], mutation: true, requiresIdempotency: false, targetBound: false, timeoutMs: 2000, paramsSchemaRef: '#/components/schemas/HandshakeParams', resultSchemaRef: '#/components/schemas/HandshakeResult', errorCodes: ['Unauthorized', 'UnsupportedApiVersion', 'ProjectMismatch', 'InstanceMismatch', 'AmbiguousInstance', 'RateLimited', 'RequestTimeout', 'InternalError'], paramsSchema: handshakeParams },
  { name: 'orbit.connection.close', bootstrap: false, requiredScopes: ['read'], mutation: true, requiresIdempotency: false, targetBound: false, timeoutMs: 2000, paramsSchemaRef: '#/components/schemas/ConnectionCloseParams', resultSchemaRef: '#/components/schemas/ConnectionCloseResult', errorCodes: ['Unauthorized', 'InvalidRequest', 'RequestTimeout', 'InternalError'], paramsSchema: connectionCloseParams },
  { name: 'orbit.operation.get', bootstrap: false, requiredScopes: ['read'], mutation: false, requiresIdempotency: false, targetBound: false, timeoutMs: 5000, paramsSchemaRef: '#/components/schemas/OperationGetParams', resultSchemaRef: '#/components/schemas/OperationGetResult', errorCodes: ['Unauthorized', 'InvalidRequest', 'RequestTimeout', 'InternalError'], paramsSchema: operationGetParams },
  { name: 'orbit.system.capabilities', bootstrap: true, requiredScopes: [], mutation: false, requiresIdempotency: false, targetBound: false, timeoutMs: 2000, paramsSchemaRef: '#/components/schemas/SystemCapabilitiesParams', resultSchemaRef: '#/components/schemas/SystemCapabilitiesResult', errorCodes: ['Unauthorized', 'InvalidRequest', 'RequestTimeout', 'InternalError'], paramsSchema: systemCapabilitiesParams },
  { name: 'orbit.session.list', bootstrap: false, requiredScopes: ['read'], mutation: false, requiresIdempotency: false, targetBound: false, timeoutMs: 5000, paramsSchemaRef: '#/components/schemas/SessionListParams', resultSchemaRef: '#/components/schemas/SessionListResult', errorCodes: ['Unauthorized', 'ConnectionExpired', 'ProjectMismatch', 'InstanceMismatch', 'InvalidRequest', 'RequestTimeout', 'InternalError'], paramsSchema: sessionListParams },
  { name: 'orbit.session.snapshot', bootstrap: false, requiredScopes: ['read'], mutation: false, requiresIdempotency: false, targetBound: false, timeoutMs: 5000, paramsSchemaRef: '#/components/schemas/SessionSnapshotParams', resultSchemaRef: '#/components/schemas/SessionSnapshotResult', errorCodes: ['Unauthorized', 'ConnectionExpired', 'ProjectMismatch', 'InstanceMismatch', 'NoActiveSession', 'InvalidRequest', 'RequestTimeout', 'InternalError'], paramsSchema: sessionSnapshotParams },
  { name: 'orbit.session.start', bootstrap: false, requiredScopes: ['session.control'], mutation: true, requiresIdempotency: true, targetBound: false, timeoutMs: 30000, paramsSchemaRef: '#/components/schemas/SessionStartParams', resultSchemaRef: '#/components/schemas/SessionStartResult', errorCodes: ['Unauthorized', 'ConnectionExpired', 'ProjectMismatch', 'InstanceMismatch', 'SessionAlreadyActive', 'CapabilityUnavailable', 'InvalidRequest', 'RateLimited', 'RequestTimeout', 'InternalError'], paramsSchema: sessionStartParams },
  { name: 'orbit.session.stop', bootstrap: false, requiredScopes: ['session.control'], mutation: true, requiresIdempotency: true, targetBound: true, timeoutMs: 30000, paramsSchemaRef: '#/components/schemas/SessionStopParams', resultSchemaRef: '#/components/schemas/SessionStopResult', errorCodes: ['Unauthorized', 'ConnectionExpired', 'ProjectMismatch', 'InstanceMismatch', 'NoActiveSession', 'SessionStarting', 'SessionChanged', 'SessionTerminating', 'InvalidRequest', 'RequestTimeout', 'InternalError'], paramsSchema: sessionStopParams },
  { name: 'orbit.session.restart', bootstrap: false, requiredScopes: ['session.control'], mutation: true, requiresIdempotency: true, targetBound: true, timeoutMs: 30000, paramsSchemaRef: '#/components/schemas/SessionRestartParams', resultSchemaRef: '#/components/schemas/SessionRestartResult', errorCodes: ['Unauthorized', 'ConnectionExpired', 'ProjectMismatch', 'InstanceMismatch', 'NoActiveSession', 'SessionStarting', 'SessionChanged', 'SessionTerminating', 'TargetDisconnected', 'CapabilityUnavailable', 'InvalidRequest', 'RequestTimeout', 'InternalError'], paramsSchema: sessionRestartParams },
  { name: 'orbit.target.pause', bootstrap: false, requiredScopes: ['session.control'], mutation: true, requiresIdempotency: true, targetBound: true, timeoutMs: 30000, paramsSchemaRef: '#/components/schemas/TargetPauseParams', resultSchemaRef: '#/components/schemas/TargetPauseResult', errorCodes: ['Unauthorized', 'ConnectionExpired', 'ProjectMismatch', 'InstanceMismatch', 'NoActiveSession', 'SessionStarting', 'SessionChanged', 'SessionTerminating', 'TargetDisconnected', 'TargetBusy', 'CapabilityUnavailable', 'InvalidRequest', 'RequestTimeout', 'InternalError'], paramsSchema: targetPauseParams },
  { name: 'orbit.target.continue', bootstrap: false, requiredScopes: ['session.control'], mutation: true, requiresIdempotency: true, targetBound: true, timeoutMs: 30000, paramsSchemaRef: '#/components/schemas/TargetContinueParams', resultSchemaRef: '#/components/schemas/TargetContinueResult', errorCodes: ['Unauthorized', 'ConnectionExpired', 'ProjectMismatch', 'InstanceMismatch', 'NoActiveSession', 'SessionStarting', 'SessionChanged', 'SessionTerminating', 'TargetDisconnected', 'TargetBusy', 'CapabilityUnavailable', 'InvalidRequest', 'RequestTimeout', 'InternalError'], paramsSchema: targetContinueParams },
  { name: 'orbit.target.reset', bootstrap: false, requiredScopes: ['session.control'], mutation: true, requiresIdempotency: true, targetBound: true, timeoutMs: 30000, paramsSchemaRef: '#/components/schemas/TargetResetParams', resultSchemaRef: '#/components/schemas/TargetResetResult', errorCodes: ['Unauthorized', 'ConnectionExpired', 'ProjectMismatch', 'InstanceMismatch', 'NoActiveSession', 'SessionStarting', 'SessionChanged', 'SessionTerminating', 'TargetDisconnected', 'TargetBusy', 'CapabilityUnavailable', 'InvalidRequest', 'RequestTimeout', 'InternalError'], paramsSchema: targetResetParams },
  { name: 'orbit.target.stepOver', bootstrap: false, requiredScopes: ['session.control'], mutation: true, requiresIdempotency: true, targetBound: true, timeoutMs: 30000, paramsSchemaRef: '#/components/schemas/TargetStepOverParams', resultSchemaRef: '#/components/schemas/TargetStepOverResult', errorCodes: ['Unauthorized', 'ConnectionExpired', 'ProjectMismatch', 'InstanceMismatch', 'NoActiveSession', 'SessionStarting', 'SessionChanged', 'SessionTerminating', 'TargetDisconnected', 'TargetRunning', 'TargetBusy', 'CapabilityUnavailable', 'InvalidRequest', 'RequestTimeout', 'InternalError'], paramsSchema: targetStepOverParams },
  { name: 'orbit.target.stepInto', bootstrap: false, requiredScopes: ['session.control'], mutation: true, requiresIdempotency: true, targetBound: true, timeoutMs: 30000, paramsSchemaRef: '#/components/schemas/TargetStepIntoParams', resultSchemaRef: '#/components/schemas/TargetStepIntoResult', errorCodes: ['Unauthorized', 'ConnectionExpired', 'ProjectMismatch', 'InstanceMismatch', 'NoActiveSession', 'SessionStarting', 'SessionChanged', 'SessionTerminating', 'TargetDisconnected', 'TargetRunning', 'TargetBusy', 'CapabilityUnavailable', 'InvalidRequest', 'RequestTimeout', 'InternalError'], paramsSchema: targetStepIntoParams },
  { name: 'orbit.target.stepOut', bootstrap: false, requiredScopes: ['session.control'], mutation: true, requiresIdempotency: true, targetBound: true, timeoutMs: 30000, paramsSchemaRef: '#/components/schemas/TargetStepOutParams', resultSchemaRef: '#/components/schemas/TargetStepOutResult', errorCodes: ['Unauthorized', 'ConnectionExpired', 'ProjectMismatch', 'InstanceMismatch', 'NoActiveSession', 'SessionStarting', 'SessionChanged', 'SessionTerminating', 'TargetDisconnected', 'TargetRunning', 'TargetBusy', 'CapabilityUnavailable', 'InvalidRequest', 'RequestTimeout', 'InternalError'], paramsSchema: targetStepOutParams },
  { name: 'orbit.target.stepInstruction', bootstrap: false, requiredScopes: ['session.control'], mutation: true, requiresIdempotency: true, targetBound: true, timeoutMs: 30000, paramsSchemaRef: '#/components/schemas/TargetStepInstructionParams', resultSchemaRef: '#/components/schemas/TargetStepInstructionResult', errorCodes: ['Unauthorized', 'ConnectionExpired', 'ProjectMismatch', 'InstanceMismatch', 'NoActiveSession', 'SessionStarting', 'SessionChanged', 'SessionTerminating', 'TargetDisconnected', 'TargetRunning', 'TargetBusy', 'CapabilityUnavailable', 'InvalidRequest', 'RequestTimeout', 'InternalError'], paramsSchema: targetStepInstructionParams },
  { name: 'orbit.target.flash', bootstrap: false, requiredScopes: ['flash'], mutation: true, requiresIdempotency: true, targetBound: true, timeoutMs: 180000, paramsSchemaRef: '#/components/schemas/TargetFlashParams', resultSchemaRef: '#/components/schemas/TargetFlashResult', errorCodes: ['Unauthorized', 'ConnectionExpired', 'ProjectMismatch', 'InstanceMismatch', 'NoActiveSession', 'SessionStarting', 'SessionChanged', 'SessionTerminating', 'TargetDisconnected', 'TargetBusy', 'CapabilityUnavailable', 'InvalidRequest', 'RequestTimeout', 'InternalError'], paramsSchema: targetFlashParams },
  { name: 'orbit.breakpoints.list', bootstrap: false, requiredScopes: ['read'], mutation: false, requiresIdempotency: false, targetBound: false, timeoutMs: 5000, paramsSchemaRef: '#/components/schemas/BreakpointsListParams', resultSchemaRef: '#/components/schemas/BreakpointsListResult', errorCodes: ['Unauthorized', 'ConnectionExpired', 'ProjectMismatch', 'InstanceMismatch', 'InvalidRequest', 'RequestTimeout', 'InternalError'], paramsSchema: breakpointsListParams },
  { name: 'orbit.breakpoints.add', bootstrap: false, requiredScopes: ['breakpoints.write'], mutation: true, requiresIdempotency: true, targetBound: false, timeoutMs: 15000, paramsSchemaRef: '#/components/schemas/BreakpointsAddParams', resultSchemaRef: '#/components/schemas/BreakpointsAddResult', errorCodes: ['Unauthorized', 'ConnectionExpired', 'ProjectMismatch', 'InstanceMismatch', 'BreakpointUnverified', 'InvalidRequest', 'RequestTimeout', 'InternalError'], paramsSchema: breakpointsAddParams },
  { name: 'orbit.breakpoints.update', bootstrap: false, requiredScopes: ['breakpoints.write'], mutation: true, requiresIdempotency: true, targetBound: false, timeoutMs: 15000, paramsSchemaRef: '#/components/schemas/BreakpointsUpdateParams', resultSchemaRef: '#/components/schemas/BreakpointsUpdateResult', errorCodes: ['Unauthorized', 'ConnectionExpired', 'ProjectMismatch', 'InstanceMismatch', 'BreakpointNotFound', 'BreakpointUnverified', 'InvalidRequest', 'RequestTimeout', 'InternalError'], paramsSchema: breakpointsUpdateParams },
  { name: 'orbit.breakpoints.remove', bootstrap: false, requiredScopes: ['breakpoints.write'], mutation: true, requiresIdempotency: true, targetBound: false, timeoutMs: 15000, paramsSchemaRef: '#/components/schemas/BreakpointsRemoveParams', resultSchemaRef: '#/components/schemas/BreakpointsRemoveResult', errorCodes: ['Unauthorized', 'ConnectionExpired', 'ProjectMismatch', 'InstanceMismatch', 'BreakpointNotFound', 'InvalidRequest', 'RequestTimeout', 'InternalError'], paramsSchema: breakpointsRemoveParams },
  { name: 'orbit.breakpoints.replace', bootstrap: false, requiredScopes: ['breakpoints.write'], mutation: true, requiresIdempotency: true, targetBound: false, timeoutMs: 15000, paramsSchemaRef: '#/components/schemas/BreakpointsReplaceParams', resultSchemaRef: '#/components/schemas/BreakpointsReplaceResult', errorCodes: ['Unauthorized', 'ConnectionExpired', 'ProjectMismatch', 'InstanceMismatch', 'BreakpointUnverified', 'InvalidRequest', 'RequestTimeout', 'InternalError'], paramsSchema: breakpointsReplaceParams },
  { name: 'orbit.runtime.threads', bootstrap: false, requiredScopes: ['read'], mutation: false, requiresIdempotency: false, targetBound: true, timeoutMs: 10000, paramsSchemaRef: '#/components/schemas/RuntimeThreadsParams', resultSchemaRef: '#/components/schemas/RuntimeThreadsResult', errorCodes: ['Unauthorized', 'ConnectionExpired', 'ProjectMismatch', 'InstanceMismatch', 'NoActiveSession', 'SessionStarting', 'SessionChanged', 'SessionTerminating', 'TargetDisconnected', 'TargetRunning', 'TargetReadCancelled', 'InvalidRequest', 'RequestTimeout', 'InternalError'], paramsSchema: runtimeThreadsParams },
  { name: 'orbit.runtime.stackTrace', bootstrap: false, requiredScopes: ['read'], mutation: false, requiresIdempotency: false, targetBound: true, timeoutMs: 10000, paramsSchemaRef: '#/components/schemas/RuntimeStackTraceParams', resultSchemaRef: '#/components/schemas/RuntimeStackTraceResult', errorCodes: ['Unauthorized', 'ConnectionExpired', 'ProjectMismatch', 'InstanceMismatch', 'NoActiveSession', 'SessionStarting', 'SessionChanged', 'SessionTerminating', 'TargetDisconnected', 'TargetRunning', 'TargetReadCancelled', 'InvalidRequest', 'RequestTimeout', 'InternalError'], paramsSchema: runtimeStackTraceParams },
  { name: 'orbit.runtime.scopes', bootstrap: false, requiredScopes: ['read'], mutation: false, requiresIdempotency: false, targetBound: true, timeoutMs: 10000, paramsSchemaRef: '#/components/schemas/RuntimeScopesParams', resultSchemaRef: '#/components/schemas/RuntimeScopesResult', errorCodes: ['Unauthorized', 'ConnectionExpired', 'ProjectMismatch', 'InstanceMismatch', 'NoActiveSession', 'SessionStarting', 'SessionChanged', 'SessionTerminating', 'TargetDisconnected', 'TargetRunning', 'TargetReadCancelled', 'InvalidRequest', 'RequestTimeout', 'InternalError'], paramsSchema: runtimeScopesParams },
  { name: 'orbit.runtime.variables', bootstrap: false, requiredScopes: ['read'], mutation: false, requiresIdempotency: false, targetBound: true, timeoutMs: 10000, paramsSchemaRef: '#/components/schemas/RuntimeVariablesParams', resultSchemaRef: '#/components/schemas/RuntimeVariablesResult', errorCodes: ['Unauthorized', 'ConnectionExpired', 'ProjectMismatch', 'InstanceMismatch', 'NoActiveSession', 'SessionStarting', 'SessionChanged', 'SessionTerminating', 'TargetDisconnected', 'TargetRunning', 'TargetReadCancelled', 'InvalidRequest', 'RequestTimeout', 'InternalError'], paramsSchema: runtimeVariablesParams },
  { name: 'orbit.runtime.registers', bootstrap: false, requiredScopes: ['read'], mutation: false, requiresIdempotency: false, targetBound: true, timeoutMs: 10000, paramsSchemaRef: '#/components/schemas/RuntimeRegistersParams', resultSchemaRef: '#/components/schemas/RuntimeRegistersResult', errorCodes: ['Unauthorized', 'ConnectionExpired', 'ProjectMismatch', 'InstanceMismatch', 'NoActiveSession', 'SessionStarting', 'SessionChanged', 'SessionTerminating', 'TargetDisconnected', 'TargetRunning', 'TargetReadCancelled', 'InvalidRequest', 'RequestTimeout', 'InternalError'], paramsSchema: runtimeRegistersParams },
  { name: 'orbit.expression.evaluate', bootstrap: false, requiredScopes: ['read'], mutation: false, requiresIdempotency: false, targetBound: true, timeoutMs: 10000, paramsSchemaRef: '#/components/schemas/ExpressionEvaluateParams', resultSchemaRef: '#/components/schemas/ExpressionEvaluateResult', errorCodes: ['Unauthorized', 'ConnectionExpired', 'ProjectMismatch', 'InstanceMismatch', 'NoActiveSession', 'SessionStarting', 'SessionChanged', 'SessionTerminating', 'TargetDisconnected', 'TargetRunning', 'TargetReadCancelled', 'InvalidExpression', 'InvalidRequest', 'RequestTimeout', 'InternalError'], paramsSchema: expressionEvaluateParams },
  { name: 'orbit.expression.readMany', bootstrap: false, requiredScopes: ['read'], mutation: false, requiresIdempotency: false, targetBound: true, timeoutMs: 10000, paramsSchemaRef: '#/components/schemas/ExpressionReadManyParams', resultSchemaRef: '#/components/schemas/ExpressionReadManyResult', errorCodes: ['Unauthorized', 'ConnectionExpired', 'ProjectMismatch', 'InstanceMismatch', 'NoActiveSession', 'SessionStarting', 'SessionChanged', 'SessionTerminating', 'TargetDisconnected', 'TargetRunning', 'TargetReadCancelled', 'InvalidExpression', 'InvalidRequest', 'RequestTimeout', 'InternalError'], paramsSchema: expressionReadManyParams },
  { name: 'orbit.expression.writeMany', bootstrap: false, requiredScopes: ['variables.write'], mutation: true, requiresIdempotency: true, targetBound: true, timeoutMs: 15000, paramsSchemaRef: '#/components/schemas/ExpressionWriteManyParams', resultSchemaRef: '#/components/schemas/ExpressionWriteManyResult', errorCodes: ['Unauthorized', 'ConnectionExpired', 'ProjectMismatch', 'InstanceMismatch', 'NoActiveSession', 'SessionStarting', 'SessionChanged', 'SessionTerminating', 'TargetDisconnected', 'TargetRunning', 'TargetBusy', 'InvalidExpression', 'ExpressionNotWritable', 'InvalidRequest', 'RequestTimeout', 'InternalError'], paramsSchema: expressionWriteManyParams },
  { name: 'orbit.expression.inspect', bootstrap: false, requiredScopes: ['read'], mutation: false, requiresIdempotency: false, targetBound: true, timeoutMs: 10000, paramsSchemaRef: '#/components/schemas/ExpressionInspectParams', resultSchemaRef: '#/components/schemas/ExpressionInspectResult', errorCodes: ['Unauthorized', 'ConnectionExpired', 'ProjectMismatch', 'InstanceMismatch', 'NoActiveSession', 'SessionStarting', 'SessionChanged', 'SessionTerminating', 'TargetDisconnected', 'TargetRunning', 'TargetReadCancelled', 'InvalidExpression', 'InvalidRequest', 'RequestTimeout', 'InternalError'], paramsSchema: expressionInspectParams },
  { name: 'orbit.symbol.search', bootstrap: false, requiredScopes: ['read'], mutation: false, requiresIdempotency: false, targetBound: true, timeoutMs: 10000, paramsSchemaRef: '#/components/schemas/SymbolSearchParams', resultSchemaRef: '#/components/schemas/SymbolSearchResult', errorCodes: ['Unauthorized', 'ConnectionExpired', 'ProjectMismatch', 'InstanceMismatch', 'NoActiveSession', 'SessionStarting', 'SessionChanged', 'SessionTerminating', 'TargetDisconnected', 'CapabilityUnavailable', 'InvalidRequest', 'RequestTimeout', 'InternalError'], paramsSchema: symbolSearchParams },
  { name: 'orbit.symbol.resolve', bootstrap: false, requiredScopes: ['read'], mutation: false, requiresIdempotency: false, targetBound: true, timeoutMs: 10000, paramsSchemaRef: '#/components/schemas/SymbolResolveParams', resultSchemaRef: '#/components/schemas/SymbolResolveResult', errorCodes: ['Unauthorized', 'ConnectionExpired', 'ProjectMismatch', 'InstanceMismatch', 'NoActiveSession', 'SessionStarting', 'SessionChanged', 'SessionTerminating', 'TargetDisconnected', 'CapabilityUnavailable', 'InvalidRequest', 'RequestTimeout', 'InternalError'], paramsSchema: symbolResolveParams },
  { name: 'orbit.memory.read', bootstrap: false, requiredScopes: ['read'], mutation: false, requiresIdempotency: false, targetBound: true, timeoutMs: 10000, paramsSchemaRef: '#/components/schemas/MemoryReadParams', resultSchemaRef: '#/components/schemas/MemoryReadResult', errorCodes: ['Unauthorized', 'ConnectionExpired', 'ProjectMismatch', 'InstanceMismatch', 'NoActiveSession', 'SessionStarting', 'SessionChanged', 'SessionTerminating', 'TargetDisconnected', 'TargetReadCancelled', 'InvalidAddress', 'MemoryReadFailed', 'InvalidRequest', 'RequestTimeout', 'InternalError'], paramsSchema: memoryReadParams },
  { name: 'orbit.memory.write', bootstrap: false, requiredScopes: ['memory.write'], mutation: true, requiresIdempotency: true, targetBound: true, timeoutMs: 30000, paramsSchemaRef: '#/components/schemas/MemoryWriteParams', resultSchemaRef: '#/components/schemas/MemoryWriteResult', errorCodes: ['Unauthorized', 'ConnectionExpired', 'ProjectMismatch', 'InstanceMismatch', 'NoActiveSession', 'SessionStarting', 'SessionChanged', 'SessionTerminating', 'TargetDisconnected', 'TargetBusy', 'InvalidAddress', 'MemoryWriteFailed', 'InvalidRequest', 'RequestTimeout', 'InternalError'], paramsSchema: memoryWriteParams },
  { name: 'orbit.watch.list', bootstrap: false, requiredScopes: ['read'], mutation: false, requiresIdempotency: false, targetBound: false, timeoutMs: 5000, paramsSchemaRef: '#/components/schemas/WatchListParams', resultSchemaRef: '#/components/schemas/WatchListResult', errorCodes: ['Unauthorized', 'ConnectionExpired', 'ProjectMismatch', 'InstanceMismatch', 'InvalidRequest', 'RateLimited', 'RequestTimeout', 'InternalError'], paramsSchema: watchListParams },
  { name: 'orbit.watch.replace', bootstrap: false, requiredScopes: ['view.write'], mutation: true, requiresIdempotency: true, targetBound: false, timeoutMs: 10000, paramsSchemaRef: '#/components/schemas/WatchReplaceParams', resultSchemaRef: '#/components/schemas/WatchReplaceResult', errorCodes: ['Unauthorized', 'ConnectionExpired', 'ProjectMismatch', 'InstanceMismatch', 'InvalidRequest', 'RateLimited', 'RequestTimeout', 'InternalError'], paramsSchema: watchReplaceParams },
  { name: 'orbit.watch.add', bootstrap: false, requiredScopes: ['view.write'], mutation: true, requiresIdempotency: true, targetBound: false, timeoutMs: 10000, paramsSchemaRef: '#/components/schemas/WatchAddParams', resultSchemaRef: '#/components/schemas/WatchAddResult', errorCodes: ['Unauthorized', 'ConnectionExpired', 'ProjectMismatch', 'InstanceMismatch', 'InvalidRequest', 'RateLimited', 'RequestTimeout', 'InternalError'], paramsSchema: watchAddParams },
  { name: 'orbit.watch.remove', bootstrap: false, requiredScopes: ['view.write'], mutation: true, requiresIdempotency: true, targetBound: false, timeoutMs: 10000, paramsSchemaRef: '#/components/schemas/WatchRemoveParams', resultSchemaRef: '#/components/schemas/WatchRemoveResult', errorCodes: ['Unauthorized', 'ConnectionExpired', 'ProjectMismatch', 'InstanceMismatch', 'InvalidRequest', 'RateLimited', 'RequestTimeout', 'InternalError'], paramsSchema: watchRemoveParams },
  { name: 'orbit.timeline.list', bootstrap: false, requiredScopes: ['read'], mutation: false, requiresIdempotency: false, targetBound: false, timeoutMs: 5000, paramsSchemaRef: '#/components/schemas/TimelineListParams', resultSchemaRef: '#/components/schemas/TimelineListResult', errorCodes: ['Unauthorized', 'ConnectionExpired', 'ProjectMismatch', 'InstanceMismatch', 'InvalidRequest', 'RateLimited', 'RequestTimeout', 'InternalError'], paramsSchema: timelineListParams },
  { name: 'orbit.timeline.replace', bootstrap: false, requiredScopes: ['view.write'], mutation: true, requiresIdempotency: true, targetBound: false, timeoutMs: 10000, paramsSchemaRef: '#/components/schemas/TimelineReplaceParams', resultSchemaRef: '#/components/schemas/TimelineReplaceResult', errorCodes: ['Unauthorized', 'ConnectionExpired', 'ProjectMismatch', 'InstanceMismatch', 'InvalidRequest', 'RateLimited', 'RequestTimeout', 'InternalError'], paramsSchema: timelineReplaceParams },
  { name: 'orbit.timeline.start', bootstrap: false, requiredScopes: ['view.write'], mutation: true, requiresIdempotency: true, targetBound: true, timeoutMs: 10000, paramsSchemaRef: '#/components/schemas/TimelineStartParams', resultSchemaRef: '#/components/schemas/TimelineStartResult', errorCodes: ['Unauthorized', 'ConnectionExpired', 'ProjectMismatch', 'InstanceMismatch', 'NoActiveSession', 'SessionStarting', 'SessionChanged', 'SessionTerminating', 'TargetDisconnected', 'TargetBusy', 'TargetReadCancelled', 'InvalidRequest', 'RateLimited', 'RequestTimeout', 'InternalError'], paramsSchema: timelineStartParams },
  { name: 'orbit.timeline.stop', bootstrap: false, requiredScopes: ['view.write'], mutation: true, requiresIdempotency: true, targetBound: true, timeoutMs: 10000, paramsSchemaRef: '#/components/schemas/TimelineStopParams', resultSchemaRef: '#/components/schemas/TimelineStopResult', errorCodes: ['Unauthorized', 'ConnectionExpired', 'ProjectMismatch', 'InstanceMismatch', 'NoActiveSession', 'SessionStarting', 'SessionChanged', 'SessionTerminating', 'TargetDisconnected', 'TargetBusy', 'TargetReadCancelled', 'InvalidRequest', 'RateLimited', 'RequestTimeout', 'InternalError'], paramsSchema: timelineStopParams },
  { name: 'orbit.timeline.status', bootstrap: false, requiredScopes: ['read'], mutation: false, requiresIdempotency: false, targetBound: true, timeoutMs: 10000, paramsSchemaRef: '#/components/schemas/TimelineStatusParams', resultSchemaRef: '#/components/schemas/TimelineStatusResult', errorCodes: ['Unauthorized', 'ConnectionExpired', 'ProjectMismatch', 'InstanceMismatch', 'NoActiveSession', 'SessionStarting', 'SessionChanged', 'SessionTerminating', 'TargetDisconnected', 'TargetBusy', 'TargetReadCancelled', 'InvalidRequest', 'RateLimited', 'RequestTimeout', 'InternalError'], paramsSchema: timelineStatusParams },
  { name: 'orbit.record.start', bootstrap: false, requiredScopes: ['record'], mutation: true, requiresIdempotency: true, targetBound: true, timeoutMs: 15000, paramsSchemaRef: '#/components/schemas/RecordStartParams', resultSchemaRef: '#/components/schemas/RecordStartResult', errorCodes: ['Unauthorized', 'ConnectionExpired', 'ProjectMismatch', 'InstanceMismatch', 'NoActiveSession', 'SessionStarting', 'SessionChanged', 'SessionTerminating', 'TargetDisconnected', 'TargetBusy', 'TargetReadCancelled', 'InvalidRequest', 'RateLimited', 'RequestTimeout', 'InternalError'], paramsSchema: recordStartParams },
  { name: 'orbit.record.stop', bootstrap: false, requiredScopes: ['record'], mutation: true, requiresIdempotency: true, targetBound: true, timeoutMs: 15000, paramsSchemaRef: '#/components/schemas/RecordStopParams', resultSchemaRef: '#/components/schemas/RecordStopResult', errorCodes: ['Unauthorized', 'ConnectionExpired', 'ProjectMismatch', 'InstanceMismatch', 'NoActiveSession', 'SessionStarting', 'SessionChanged', 'SessionTerminating', 'TargetDisconnected', 'TargetBusy', 'TargetReadCancelled', 'InvalidRequest', 'RateLimited', 'RequestTimeout', 'InternalError'], paramsSchema: recordStopParams },
  { name: 'orbit.record.list', bootstrap: false, requiredScopes: ['read'], mutation: false, requiresIdempotency: false, targetBound: true, timeoutMs: 10000, paramsSchemaRef: '#/components/schemas/RecordListParams', resultSchemaRef: '#/components/schemas/RecordListResult', errorCodes: ['Unauthorized', 'ConnectionExpired', 'ProjectMismatch', 'InstanceMismatch', 'NoActiveSession', 'SessionStarting', 'SessionChanged', 'SessionTerminating', 'TargetDisconnected', 'TargetBusy', 'TargetReadCancelled', 'InvalidRequest', 'RateLimited', 'RequestTimeout', 'InternalError'], paramsSchema: recordListParams },
  { name: 'orbit.record.get', bootstrap: false, requiredScopes: ['read'], mutation: false, requiresIdempotency: false, targetBound: true, timeoutMs: 10000, paramsSchemaRef: '#/components/schemas/RecordGetParams', resultSchemaRef: '#/components/schemas/RecordGetResult', errorCodes: ['Unauthorized', 'ConnectionExpired', 'ProjectMismatch', 'InstanceMismatch', 'NoActiveSession', 'SessionStarting', 'SessionChanged', 'SessionTerminating', 'TargetDisconnected', 'RecordingNotFound', 'InvalidRequest', 'RateLimited', 'RequestTimeout', 'InternalError'], paramsSchema: recordGetParams },
  { name: 'orbit.record.clear', bootstrap: false, requiredScopes: ['record'], mutation: true, requiresIdempotency: true, targetBound: true, timeoutMs: 15000, paramsSchemaRef: '#/components/schemas/RecordClearParams', resultSchemaRef: '#/components/schemas/RecordClearResult', errorCodes: ['Unauthorized', 'ConnectionExpired', 'ProjectMismatch', 'InstanceMismatch', 'NoActiveSession', 'SessionStarting', 'SessionChanged', 'SessionTerminating', 'TargetDisconnected', 'RecordingNotFound', 'InvalidRequest', 'RateLimited', 'RequestTimeout', 'InternalError'], paramsSchema: recordClearParams },
  { name: 'orbit.experiment.run', bootstrap: false, requiredScopes: [], mutation: true, requiresIdempotency: true, targetBound: true, timeoutMs: 600000, paramsSchemaRef: '#/components/schemas/ExperimentRunParams', resultSchemaRef: '#/components/schemas/ExperimentRunResult', errorCodes: ['Unauthorized', 'ConnectionExpired', 'ProjectMismatch', 'InstanceMismatch', 'NoActiveSession', 'SessionStarting', 'SessionChanged', 'SessionTerminating', 'TargetDisconnected', 'TargetBusy', 'InvalidExpression', 'ExpressionNotWritable', 'InvalidAddress', 'MemoryReadFailed', 'MemoryWriteFailed', 'RecordingNotFound', 'CapabilityUnavailable', 'InvalidRequest', 'RateLimited', 'RequestTimeout', 'InternalError'], paramsSchema: experimentRunParams },
  { name: 'orbit.rtt.status', bootstrap: false, requiredScopes: ['read'], mutation: false, requiresIdempotency: false, targetBound: true, timeoutMs: 10000, paramsSchemaRef: '#/components/schemas/RttStatusParams', resultSchemaRef: '#/components/schemas/RttStatusResult', errorCodes: ['Unauthorized', 'ConnectionExpired', 'ProjectMismatch', 'InstanceMismatch', 'NoActiveSession', 'SessionStarting', 'SessionChanged', 'SessionTerminating', 'TargetDisconnected', 'CapabilityUnavailable', 'InvalidRequest', 'RateLimited', 'RequestTimeout', 'InternalError'], paramsSchema: rttStatusParams },
  { name: 'orbit.rtt.start', bootstrap: false, requiredScopes: ['rtt.control'], mutation: true, requiresIdempotency: true, targetBound: true, timeoutMs: 15000, paramsSchemaRef: '#/components/schemas/RttStartParams', resultSchemaRef: '#/components/schemas/RttStartResult', errorCodes: ['Unauthorized', 'ConnectionExpired', 'ProjectMismatch', 'InstanceMismatch', 'NoActiveSession', 'SessionStarting', 'SessionChanged', 'SessionTerminating', 'TargetDisconnected', 'TargetBusy', 'CapabilityUnavailable', 'InvalidRequest', 'RateLimited', 'RequestTimeout', 'InternalError'], paramsSchema: rttStartParams },
  { name: 'orbit.rtt.stop', bootstrap: false, requiredScopes: ['rtt.control'], mutation: true, requiresIdempotency: true, targetBound: true, timeoutMs: 15000, paramsSchemaRef: '#/components/schemas/RttStopParams', resultSchemaRef: '#/components/schemas/RttStopResult', errorCodes: ['Unauthorized', 'ConnectionExpired', 'ProjectMismatch', 'InstanceMismatch', 'NoActiveSession', 'SessionStarting', 'SessionChanged', 'SessionTerminating', 'TargetDisconnected', 'TargetBusy', 'CapabilityUnavailable', 'InvalidRequest', 'RateLimited', 'RequestTimeout', 'InternalError'], paramsSchema: rttStopParams },
  { name: 'orbit.rtt.read', bootstrap: false, requiredScopes: ['read'], mutation: false, requiresIdempotency: false, targetBound: true, timeoutMs: 10000, paramsSchemaRef: '#/components/schemas/RttReadParams', resultSchemaRef: '#/components/schemas/RttReadResult', errorCodes: ['Unauthorized', 'ConnectionExpired', 'ProjectMismatch', 'InstanceMismatch', 'NoActiveSession', 'SessionStarting', 'SessionChanged', 'SessionTerminating', 'TargetDisconnected', 'TargetReadCancelled', 'CapabilityUnavailable', 'InvalidRequest', 'RateLimited', 'RequestTimeout', 'InternalError'], paramsSchema: rttReadParams },
  { name: 'orbit.rttlog.read', bootstrap: false, requiredScopes: ['read'], mutation: false, requiresIdempotency: false, targetBound: true, timeoutMs: 10000, paramsSchemaRef: '#/components/schemas/RttlogReadParams', resultSchemaRef: '#/components/schemas/RttlogReadResult', errorCodes: ['Unauthorized', 'ConnectionExpired', 'ProjectMismatch', 'InstanceMismatch', 'NoActiveSession', 'SessionStarting', 'SessionChanged', 'SessionTerminating', 'TargetDisconnected', 'CapabilityUnavailable', 'InvalidRequest', 'RateLimited', 'RequestTimeout', 'InternalError'], paramsSchema: rttLogReadParams },
  { name: 'orbit.diagnostics.snapshot', bootstrap: false, requiredScopes: ['read'], mutation: false, requiresIdempotency: false, targetBound: false, timeoutMs: 5000, paramsSchemaRef: '#/components/schemas/DiagnosticsSnapshotParams', resultSchemaRef: '#/components/schemas/DiagnosticsSnapshotResult', errorCodes: ['Unauthorized', 'ConnectionExpired', 'ProjectMismatch', 'InstanceMismatch', 'InvalidRequest', 'RateLimited', 'RequestTimeout', 'InternalError'], paramsSchema: diagnosticsSnapshotParams },
];

export const METHOD_CATALOG: ReadonlyMap<string, MethodCatalogEntry> = new Map(
  METHOD_ENTRIES.map(entry => [entry.name, entry]),
);

export function getMethodCatalogEntry(name: string): MethodCatalogEntry | undefined {
  return METHOD_CATALOG.get(name);
}
