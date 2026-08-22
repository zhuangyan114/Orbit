// Orbit Automation API v1 — runtime inspection service (plan Task 7).
//
// threads/stackTrace/scopes/variables/registers are exact-session reads: the
// service resolves the frozen `SessionRef` through the SessionRegistry and
// drives the active DAP session's `orbitRuntimeSnapshot` custom request. There
// is no extension-host backend fallback, and a running target is reported as
// the frozen `TargetRunning` error instead of fabricating stopped-state data.
//
// The DAP adapter returns adapter-internal integer `variablesReference`
// values; the service stringifies them to the frozen UInt64 wire shape and
// records which session generation issued each reference. Reusing a reference
// after a session restart/replacement (a new generation) returns the frozen
// `SessionChanged` error, mirroring DAP's invalidated-variablesReference rule.
//
// All `vscode` access is injectable so the routing and error mapping are
// unit-testable without the Extension Host.
import * as vscode from 'vscode';
import {
  AutomationError,
  ExpressionContextKind,
  ExpressionErrorData,
  ExpressionInspectData,
  ExpressionReadManyData,
  ExpressionValue,
  ExpressionWrite,
  ExpressionWriteManyData,
  ExpressionWriteOutcome,
  RuntimeListData,
  RuntimeRegister,
  RuntimeScope,
  RuntimeStackFrame,
  RuntimeThread,
  RuntimeVariable,
  SessionRef,
  SymbolDescriptor,
  SymbolKind,
  SymbolResolveData,
  SymbolSearchData,
} from './protocol';
import { SessionRegistry } from './session-registry';
import {
  AUTOMATION_RUNTIME_COMMAND,
  AutomationRegisterGroup,
  AutomationRuntimeRequest,
  AutomationRuntimeResult,
  AUTOMATION_EXPRESSION_COMMAND,
  AutomationExpressionRequest,
  AutomationExpressionResult,
  AutomationExpressionValue,
  AutomationExpressionWriteOutcome,
  AutomationSymbol,
} from '../debug/dap-automation-protocol';
import { normalizeAutomationExpression, parseWriteValue } from '../utils/watch-expression-validation';

const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 1000;
const MAX_REFERENCE_TRACKING = 4096;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export interface RuntimeServiceOptions {
  registry: SessionRegistry;
  /** Pulls one runtime snapshot from an exact active session. */
  snapshotDap?(session: vscode.DebugSession, request: AutomationRuntimeRequest): Promise<AutomationRuntimeResult>;
  /** Pulls one expression/symbol snapshot from an exact active session. */
  snapshotExpressionDap?(session: vscode.DebugSession, request: AutomationExpressionRequest): Promise<AutomationExpressionResult>;
}

export interface RuntimeThreadsParams {
  cursor?: string;
  limit?: number;
}

export interface RuntimeStackTraceParams {
  threadId: number;
  startFrame?: number;
  levels?: number;
  cursor?: string;
}

export interface RuntimeScopesParams {
  frameId: number;
  cursor?: string;
  limit?: number;
}

export interface RuntimeVariablesParams {
  variablesReference: string;
  filter?: 'named' | 'indexed';
  start?: number;
  count?: number;
  cursor?: string;
}

export interface RuntimeRegistersParams {
  groups?: AutomationRegisterGroup[];
  cursor?: string;
  limit?: number;
}

export interface ExpressionEvaluateParams {
  expression: string;
  frameId?: number;
  contextKind?: ExpressionContextKind;
}

export interface ExpressionReadManyParams {
  expressions: string[];
  frameId?: number;
  forceRealtime?: boolean;
}

export interface ExpressionWriteManyParams {
  writes: ExpressionWrite[];
  frameId?: number;
  resumeIntent?: 'preserve' | 'halted' | 'running';
}

export interface ExpressionInspectParams {
  expression: string;
  frameId?: number;
  depth?: number;
  maxChildren?: number;
}

export interface SymbolSearchParams {
  query: string;
  kinds?: SymbolKind[];
  cursor?: string;
  limit?: number;
}

export interface SymbolResolveParams {
  name?: string;
  address?: string;
}

export class RuntimeService {
  private readonly opts: Required<RuntimeServiceOptions>;
  /**
   * Generation each issued `variablesReference` (UInt64 string) belongs to.
   * Entries are never reset on generation change so a stale reference can be
   * detected as `SessionChanged`; the map is FIFO-bounded against unbounded
   * growth across many restarts. The 4096 cap is far above the per-session
   * handle count, so a stale marker is effectively never evicted in practice
   * (see `rememberReference` for the theoretical residual).
   */
  private readonly referenceGeneration = new Map<string, number>();

  constructor(options: RuntimeServiceOptions) {
    const defaults: Required<RuntimeServiceOptions> = {
      registry: options.registry,
      snapshotDap: async (session, request) => {
        try {
          const response: unknown = await session.customRequest(AUTOMATION_RUNTIME_COMMAND, request);
          return (isRecord(response) ? response : {}) as AutomationRuntimeResult;
        } catch (error) {
          // A DAP `success: false` response rejects `customRequest` and attaches
          // the structured body as `.body`; surface it so the caller can map its
          // errorCode. A transport error without a body is rethrown.
          const body = (error as { body?: unknown } | undefined)?.body;
          if (isRecord(body)) return body as AutomationRuntimeResult;
          throw error;
        }
      },
      snapshotExpressionDap: async (session, request) => {
        try {
          const response: unknown = await session.customRequest(AUTOMATION_EXPRESSION_COMMAND, request);
          return (isRecord(response) ? response : {}) as AutomationExpressionResult;
        } catch (error) {
          const body = (error as { body?: unknown } | undefined)?.body;
          if (isRecord(body)) return body as AutomationExpressionResult;
          throw error;
        }
      },
    };
    const merged: Record<string, unknown> = { ...defaults, ...options };
    for (const [key, value] of Object.entries(defaults)) {
      if (merged[key] === undefined) merged[key] = value;
    }
    this.opts = merged as unknown as Required<RuntimeServiceOptions>;
  }

  /** `orbit.runtime.threads`: the current thread list (valid while running). */
  async threads(ref: SessionRef, params: RuntimeThreadsParams = {}): Promise<RuntimeListData<RuntimeThread>> {
    const { session, generation } = this.resolve(ref);
    const result = await this.snapshot(session, { kind: 'threads', sessionGeneration: generation });
    const items: RuntimeThread[] = (result.threads ?? []).map(thread => ({
      threadId: thread.threadId,
      name: thread.name,
      state: thread.state,
      stopped: thread.stopped,
    }));
    return this.paginate(items, params.cursor, params.limit, item => String(item.threadId));
  }

  /** `orbit.runtime.stackTrace`: full frames, then startFrame/levels/cursor paging. */
  async stackTrace(ref: SessionRef, params: RuntimeStackTraceParams): Promise<RuntimeListData<RuntimeStackFrame>> {
    const { session, generation } = this.resolve(ref);
    const result = await this.snapshot(session, {
      kind: 'stackTrace',
      sessionGeneration: generation,
      threadId: params.threadId,
    });
    const frames: RuntimeStackFrame[] = (result.stackFrames ?? []).map(frame => {
      const mapped: RuntimeStackFrame = {
        frameId: frame.frameId,
        name: frame.name,
        instructionPointerReference: frame.instructionPointerReference,
      };
      if (frame.source) mapped.source = { path: frame.source.path, line: frame.source.line };
      return mapped;
    });
    const start = params.cursor !== undefined
      ? this.cursorIndex(params.cursor, frames, frame => String(frame.frameId)) + 1
      : (params.startFrame ?? 0);
    const levels = this.clampPage(params.levels ?? DEFAULT_PAGE_LIMIT);
    const slice = frames.slice(start, start + levels);
    const data: RuntimeListData<RuntimeStackFrame> = { items: slice };
    if (start + levels < frames.length) data.nextCursor = String(slice[slice.length - 1].frameId);
    return data;
  }

  /** `orbit.runtime.scopes`: scope list for a halted frame (1=Local, 2=Registers). */
  async scopes(ref: SessionRef, params: RuntimeScopesParams): Promise<RuntimeListData<RuntimeScope>> {
    const { session, generation } = this.resolve(ref);
    const result = await this.snapshot(session, {
      kind: 'scopes',
      sessionGeneration: generation,
      frameId: params.frameId,
    });
    const items: RuntimeScope[] = (result.scopes ?? []).map(scope => {
      const reference = String(scope.variablesReference);
      this.rememberReference(reference, generation);
      return { name: scope.name, variablesReference: reference, expensive: scope.expensive };
    });
    return this.paginate(items, params.cursor, params.limit, item => item.name);
  }

  /**
   * `orbit.runtime.variables`: expand one variablesReference (generation-fenced).
   *
   * `params.filter` is accepted but intentionally not enforced: this adapter
   * returns a flat variable list without DAP `namedVariables`/`indexedVariables`
   * counts, so there is no named/indexed distinction to filter on. The field is
   * preserved on the wire for forward compatibility with adapters that do.
   */
  async variables(ref: SessionRef, params: RuntimeVariablesParams): Promise<RuntimeListData<RuntimeVariable>> {
    const { session, generation } = this.resolve(ref);
    const reference = String(params.variablesReference);
    this.requireReferenceGeneration(reference, generation);
    // We only ever emit decimal references, so clients must round-trip the
    // decimal string verbatim; `Number` accepts a hex UInt64 too, but such a
    // value never appears in our map and is forwarded as a best-effort read.
    const result = await this.snapshot(session, {
      kind: 'variables',
      sessionGeneration: generation,
      variablesReference: Number(reference),
    });
    const items: RuntimeVariable[] = (result.variables ?? []).map(variable => {
      const childReference = variable.variablesReference > 0 ? String(variable.variablesReference) : '0';
      if (variable.variablesReference > 0) this.rememberReference(childReference, generation);
      const mapped: RuntimeVariable = {
        name: variable.name,
        value: variable.value,
        variablesReference: childReference,
      };
      if (variable.type !== undefined) mapped.type = variable.type;
      if (variable.evaluateName !== undefined) mapped.evaluateName = variable.evaluateName;
      if (variable.memoryReference !== undefined) mapped.memoryReference = variable.memoryReference;
      return mapped;
    });
    const start = params.cursor !== undefined
      ? this.cursorIndex(params.cursor, items, item => item.name) + 1
      : (params.start ?? 0);
    const count = this.clampPage(params.count ?? DEFAULT_PAGE_LIMIT);
    const slice = items.slice(start, start + count);
    const data: RuntimeListData<RuntimeVariable> = { items: slice };
    if (start + count < items.length) data.nextCursor = slice[slice.length - 1].name;
    return data;
  }

  /** `orbit.runtime.registers`: core/floating/system registers of the halted target. */
  async registers(ref: SessionRef, params: RuntimeRegistersParams = {}): Promise<RuntimeListData<RuntimeRegister>> {
    const { session, generation } = this.resolve(ref);
    const result = await this.snapshot(session, {
      kind: 'registers',
      sessionGeneration: generation,
      ...(params.groups !== undefined ? { groups: params.groups } : {}),
    });
    const items: RuntimeRegister[] = (result.registers ?? []).map(register => {
      const mapped: RuntimeRegister = {
        name: register.name,
        value: register.value,
        group: register.group,
        bits: register.bits,
      };
      if (register.memoryReference !== undefined) mapped.memoryReference = register.memoryReference;
      return mapped;
    });
    return this.paginate(items, params.cursor, params.limit, item => item.name);
  }

  // --- expression & symbol methods (plan Task 8) ----------------------------

  /** `orbit.expression.evaluate`: one expression read with a child reference. */
  async evaluate(ref: SessionRef, params: ExpressionEvaluateParams): Promise<ExpressionValue> {
    const normalized = normalizeAutomationExpression(params.expression);
    if (!normalized.ok) throw new AutomationError('InvalidExpression', normalized.reason, false);
    const { session, generation } = this.resolve(ref);
    const result = await this.expressionSnapshot(session, {
      kind: 'evaluate',
      sessionGeneration: generation,
      expression: normalized.expression,
      ...(params.frameId !== undefined ? { frameId: params.frameId } : {}),
      ...(params.contextKind !== undefined ? { contextKind: params.contextKind } : {}),
    });
    return this.mapExpressionValue(result.value, generation);
  }

  /** `orbit.expression.readMany`: ordered reads; a per-item failure never masks others. */
  async readMany(ref: SessionRef, params: ExpressionReadManyParams): Promise<ExpressionReadManyData> {
    const { session, generation } = this.resolve(ref);
    type Normalized = { expression: string } | { original: string; error: ExpressionErrorData };
    const normalized: Normalized[] = [];
    const toSend: string[] = [];
    for (const raw of params.expressions) {
      const result = normalizeAutomationExpression(raw);
      if (!result.ok) {
        normalized.push({
          original: raw,
          error: { errorCode: 'InvalidExpression', retryable: false, details: { reason: result.reason } },
        });
      } else {
        normalized.push({ expression: result.expression });
        toSend.push(result.expression);
      }
    }
    let values: AutomationExpressionValue[] = [];
    if (toSend.length > 0) {
      const result = await this.expressionSnapshot(session, {
        kind: 'readMany',
        sessionGeneration: generation,
        expressions: toSend,
        ...(params.frameId !== undefined ? { frameId: params.frameId } : {}),
        ...(params.forceRealtime !== undefined ? { forceRealtime: params.forceRealtime } : {}),
      });
      values = result.values ?? [];
    }
    let valueCursor = 0;
    const items: ExpressionValue[] = normalized.map(entry => {
      if ('error' in entry) {
        return {
          expression: entry.original,
          value: '',
          variablesReference: '0',
          available: false,
          stale: false,
          error: entry.error,
        };
      }
      return this.mapExpressionValue(values[valueCursor++], generation);
    });
    return { items };
  }

  /**
   * `orbit.expression.writeMany`: whole-batch control-barrier writes, per-item
   * outcomes. `resumeIntent` is accepted but not forwarded: the shared write
   * core already restores the pre-write run state, which is the `preserve`
   * semantics the frozen contract defaults to.
   */
  async writeMany(
    ref: SessionRef,
    params: ExpressionWriteManyParams,
    operationId?: string,
  ): Promise<ExpressionWriteManyData> {
    this.requireOperationId(operationId);
    const { session, generation } = this.resolve(ref);

    type Slot = { outcome?: ExpressionWriteOutcome; expression?: string; value?: number; valueString?: string };
    const slots: Slot[] = params.writes.map(write => {
      const expr = normalizeAutomationExpression(write.expression);
      if (!expr.ok) {
        return {
          outcome: this.invalidWriteOutcome(write.expression, 'InvalidExpression', expr.reason),
        };
      }
      const value = normalizeAutomationExpression(write.value);
      if (!value.ok) {
        return {
          outcome: this.invalidWriteOutcome(expr.expression, 'InvalidExpression', value.reason),
        };
      }
      const numeric = parseWriteValue(value.expression);
      if (numeric === undefined) {
        return {
          outcome: this.invalidWriteOutcome(expr.expression, 'ExpressionNotWritable', `value ${JSON.stringify(write.value)} is not a finite number`),
        };
      }
      return { expression: expr.expression, value: numeric, valueString: value.expression };
    });

    const dapSlots = slots.filter(slot => slot.expression !== undefined);
    let dapOutcomes: AutomationExpressionWriteOutcome[] = [];
    if (dapSlots.length > 0) {
      const result = await this.expressionSnapshot(session, {
        kind: 'writeMany',
        sessionGeneration: generation,
        writes: dapSlots.map(slot => ({ expression: slot.expression!, value: slot.value! })),
        ...(params.frameId !== undefined ? { frameId: params.frameId } : {}),
      });
      dapOutcomes = result.writes ?? [];
    }

    let dapCursor = 0;
    const items: ExpressionWriteOutcome[] = slots.map(slot => {
      if (slot.outcome) return slot.outcome;
      const dap = dapOutcomes[dapCursor++];
      const expression = slot.expression!;
      if (!dap) {
        return { expression, written: false, error: { errorCode: 'InternalError', retryable: false } };
      }
      return {
        expression,
        written: dap.written,
        ...(dap.written ? { value: slot.valueString } : {}),
        ...(dap.error ? { error: this.mapExpressionErrorData(dap.error.errorCode, dap.error.message) } : {}),
      };
    });

    return { operationId: operationId!, items };
  }

  /** `orbit.expression.inspect`: root value plus its expanded direct children. */
  async inspect(ref: SessionRef, params: ExpressionInspectParams): Promise<ExpressionInspectData> {
    const normalized = normalizeAutomationExpression(params.expression);
    if (!normalized.ok) throw new AutomationError('InvalidExpression', normalized.reason, false);
    const { session, generation } = this.resolve(ref);
    const result = await this.expressionSnapshot(session, {
      kind: 'inspect',
      sessionGeneration: generation,
      expression: normalized.expression,
      ...(params.frameId !== undefined ? { frameId: params.frameId } : {}),
      ...(params.depth !== undefined ? { depth: params.depth } : {}),
      ...(params.maxChildren !== undefined ? { maxChildren: params.maxChildren } : {}),
    });
    const root = this.mapExpressionValue(result.value, generation);
    const items: RuntimeVariable[] = (result.inspectItems ?? []).map(variable => {
      const childReference = variable.variablesReference > 0 ? String(variable.variablesReference) : '0';
      if (variable.variablesReference > 0) this.rememberReference(childReference, generation);
      const mapped: RuntimeVariable = {
        name: variable.name,
        value: variable.value,
        variablesReference: childReference,
      };
      if (variable.type !== undefined) mapped.type = variable.type;
      if (variable.evaluateName !== undefined) mapped.evaluateName = variable.evaluateName;
      if (variable.memoryReference !== undefined) mapped.memoryReference = variable.memoryReference;
      return mapped;
    });
    return { root, items };
  }

  /** `orbit.symbol.search`: name-substring search over the loaded ELF cache. */
  async symbolSearch(ref: SessionRef, params: SymbolSearchParams): Promise<SymbolSearchData> {
    const query = params.query.trim();
    if (!query) throw new AutomationError('InvalidRequest', 'symbol query must not be empty', false);
    const { session, generation } = this.resolve(ref);
    const result = await this.expressionSnapshot(session, {
      kind: 'symbolSearch',
      sessionGeneration: generation,
      query,
    });
    let descriptors: SymbolDescriptor[] = (result.symbols ?? []).map(symbol => this.mapSymbol(symbol));
    if (params.kinds && params.kinds.length > 0) {
      const allowed = new Set<string>(params.kinds);
      descriptors = descriptors.filter(symbol => allowed.has(symbol.kind));
    }
    return this.paginate(descriptors, params.cursor, params.limit, item => item.name);
  }

  /** `orbit.symbol.resolve`: resolve by exact name or by address over the ELF cache. */
  async symbolResolve(ref: SessionRef, params: SymbolResolveParams): Promise<SymbolResolveData> {
    const name = params.name !== undefined ? params.name.trim() : undefined;
    const address = params.address;
    if (!name && !address) throw new AutomationError('InvalidRequest', 'symbol resolve requires a name or an address', false);
    if (name !== undefined && !name) throw new AutomationError('InvalidRequest', 'symbol name must not be empty', false);
    const { session, generation } = this.resolve(ref);
    const result = await this.expressionSnapshot(session, {
      kind: 'symbolResolve',
      sessionGeneration: generation,
      ...(name !== undefined ? { expression: name } : {}),
      ...(address !== undefined ? { address } : {}),
    });
    const symbol = result.symbol;
    if (!symbol) throw new AutomationError('InvalidRequest', 'symbol resolve returned no symbol', false);
    return { symbol: this.mapSymbol(symbol), exact: result.exact ?? false };
  }

  // --- expression/symbol internals ------------------------------------------

  private async expressionSnapshot(session: vscode.DebugSession, request: AutomationExpressionRequest): Promise<AutomationExpressionResult> {
    let result: AutomationExpressionResult;
    try {
      result = await this.opts.snapshotExpressionDap(session, request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new AutomationError('TargetDisconnected', `expression snapshot failed: ${message}`, false, undefined, {
        dapMessage: message,
      });
    }
    this.throwOnExpressionFailure(result);
    return result;
  }

  /** Maps a structured DAP expression failure onto the frozen automation codes. */
  private throwOnExpressionFailure(result: AutomationExpressionResult): void {
    if (!result.errorCode) return;
    const code = result.errorCode;
    const message = result.message ?? code;
    const details: Record<string, unknown> = { dapMessage: message };
    if (result.targetState !== undefined) details.targetState = result.targetState;
    if (code === 'TargetRunning') {
      throw new AutomationError('TargetRunning', message, true, undefined, details);
    }
    if (code === 'TargetReadCancelled' || code === 'TargetReadUnavailable'
      || code === 'EvaluateCancelled' || code === 'RtosReadCancelled'
      || code === 'RtosVariableUnavailable' || code === 'RtosVariableExpansionFailed') {
      throw new AutomationError('TargetReadCancelled', message, true, undefined, details);
    }
    if (code === 'TargetBusy') {
      throw new AutomationError('TargetBusy', message, true, undefined, details);
    }
    if (code === 'SessionStarting') {
      throw new AutomationError('SessionStarting', message, true, undefined, details);
    }
    if (code === 'SessionTerminating') {
      throw new AutomationError('SessionTerminating', message, false, undefined, details);
    }
    if (code === 'TargetDisconnected' || code === 'NativeOwnerLost' || code === 'DeviceRemoved') {
      throw new AutomationError('TargetDisconnected', message, false, undefined, details);
    }
    if (code === 'CapabilityUnavailable' || code === 'SymbolsUnavailable') {
      throw new AutomationError('CapabilityUnavailable', message, false, undefined, details);
    }
    if (code === 'SymbolNotFound') {
      throw new AutomationError('InvalidRequest', message, false, undefined, details);
    }
    if (code === 'InvalidExpression') {
      throw new AutomationError('InvalidExpression', message, false, undefined, details);
    }
    throw new AutomationError('InternalError', message, false, undefined, details);
  }

  private mapExpressionValue(value: AutomationExpressionValue | undefined, generation: number): ExpressionValue {
    if (!value) {
      return {
        expression: '',
        value: '',
        variablesReference: '0',
        available: false,
        stale: false,
        error: { errorCode: 'InternalError', retryable: false },
      };
    }
    const reference = value.variablesReference > 0 ? String(value.variablesReference) : '0';
    if (value.variablesReference > 0) this.rememberReference(reference, generation);
    const mapped: ExpressionValue = {
      expression: value.expression,
      value: value.value,
      variablesReference: reference,
      available: value.available,
      stale: value.stale,
    };
    if (value.type !== undefined) mapped.type = value.type;
    if (value.memoryReference !== undefined) mapped.memoryReference = value.memoryReference;
    if (value.error) mapped.error = this.mapExpressionErrorData(value.error.errorCode, value.error.message);
    return mapped;
  }

  private mapExpressionErrorData(errorCode: string, message?: string): ExpressionErrorData {
    const mapped = this.mapExpressionErrorCode(errorCode);
    return {
      errorCode: mapped.code,
      retryable: mapped.retryable,
      ...(message !== undefined ? { details: { dapMessage: message } } : {}),
    };
  }

  private mapExpressionErrorCode(errorCode: string): { code: string; retryable: boolean } {
    switch (errorCode) {
      case 'TargetRunning': return { code: 'TargetRunning', retryable: true };
      case 'TargetBusy': return { code: 'TargetBusy', retryable: true };
      case 'TargetReadCancelled':
      case 'TargetReadUnavailable':
      case 'EvaluateCancelled':
      case 'RtosReadCancelled':
      case 'RtosVariableUnavailable':
      case 'RtosVariableExpansionFailed':
        return { code: 'TargetReadCancelled', retryable: true };
      case 'TargetDisconnected':
      case 'NativeOwnerLost':
      case 'DeviceRemoved':
        return { code: 'TargetDisconnected', retryable: false };
      case 'SessionStarting': return { code: 'SessionStarting', retryable: true };
      case 'SessionTerminating': return { code: 'SessionTerminating', retryable: false };
      case 'CapabilityUnavailable': return { code: 'CapabilityUnavailable', retryable: false };
      case 'ExpressionNotWritable': return { code: 'ExpressionNotWritable', retryable: false };
      case 'InvalidExpression': return { code: 'InvalidExpression', retryable: false };
      default: return { code: 'InternalError', retryable: false };
    }
  }

  private mapSymbol(symbol: AutomationSymbol): SymbolDescriptor {
    const mapped: SymbolDescriptor = {
      name: symbol.name,
      kind: this.symbolKindFromNmType(symbol.typeChar),
      // 8-digit zero-padded hex matches the register `hex` convention so symbol
      // addresses stay string-comparable/sortable on the wire.
      address: `0x${(symbol.address >>> 0).toString(16).toUpperCase().padStart(8, '0')}`,
    };
    if (symbol.size > 0) mapped.size = String(symbol.size);
    return mapped;
  }

  private symbolKindFromNmType(typeChar: string): SymbolKind {
    if (/^[TtWw]$/.test(typeChar)) return 'function';
    if (/^[BbDdGgRrSsVvCc]$/.test(typeChar)) return 'variable';
    return 'unknown';
  }

  private invalidWriteOutcome(expression: string, errorCode: 'InvalidExpression' | 'ExpressionNotWritable', reason: string): ExpressionWriteOutcome {
    return {
      expression,
      written: false,
      error: { errorCode, retryable: false, details: { reason } },
    };
  }

  private requireOperationId(operationId: string | undefined): void {
    if (!operationId) {
      throw new AutomationError('InternalError', 'expression writeMany dispatched without an operationId', false);
    }
  }

  // --- internals -----------------------------------------------------------

  private resolve(ref: SessionRef): { session: vscode.DebugSession; generation: number } {
    const session = this.opts.registry.requireExact(ref);
    return { session, generation: ref.sessionGeneration };
  }

  private async snapshot(session: vscode.DebugSession, request: AutomationRuntimeRequest): Promise<AutomationRuntimeResult> {
    let result: AutomationRuntimeResult;
    try {
      result = await this.opts.snapshotDap(session, request);
    } catch (error) {
      // A bodiless rejection here means the transport (not the target read)
      // failed — a vanished/replaced session or a DAP protocol error. `resolve`
      // already fenced generation/phase before this point, so the conservative
      // frozen TargetDisconnected is the honest fallback for the remaining race.
      const message = error instanceof Error ? error.message : String(error);
      throw new AutomationError('TargetDisconnected', `runtime snapshot failed: ${message}`, false, undefined, {
        dapMessage: message,
      });
    }
    this.throwOnFailure(result);
    return result;
  }

  /** Maps a structured DAP runtime failure onto the frozen automation codes. */
  private throwOnFailure(result: AutomationRuntimeResult): void {
    if (!result.errorCode) return;
    const code = result.errorCode;
    const message = result.message ?? code;
    const details: Record<string, unknown> = { dapMessage: message };
    if (result.targetState !== undefined) details.targetState = result.targetState;
    if (code === 'TargetRunning') {
      throw new AutomationError('TargetRunning', message, true, undefined, details);
    }
    if (
      code === 'TargetReadCancelled'
      || code === 'TargetReadUnavailable'
      // Adapter read-gate failures from the RTOS variable-expansion path. They
      // are surfaced here (rather than falling through to InternalError) so a
      // cancelled/resumed read keeps the frozen retryable TargetReadCancelled.
      || code === 'RtosReadCancelled'
      || code === 'RtosVariableUnavailable'
      || code === 'RtosVariableExpansionFailed'
    ) {
      throw new AutomationError('TargetReadCancelled', message, true, undefined, details);
    }
    if (code === 'TargetBusy') {
      throw new AutomationError('TargetBusy', message, true, undefined, details);
    }
    if (code === 'SessionStarting') {
      throw new AutomationError('SessionStarting', message, true, undefined, details);
    }
    if (code === 'SessionTerminating') {
      throw new AutomationError('SessionTerminating', message, false, undefined, details);
    }
    if (code === 'TargetDisconnected' || code === 'NativeOwnerLost' || code === 'DeviceRemoved') {
      throw new AutomationError('TargetDisconnected', message, false, undefined, details);
    }
    if (code === 'CapabilityUnavailable') {
      throw new AutomationError('CapabilityUnavailable', message, false, undefined, details);
    }
    throw new AutomationError('InternalError', message, false, undefined, details);
  }

  private requireReferenceGeneration(reference: string, generation: number): void {
    const recorded = this.referenceGeneration.get(reference);
    if (recorded === undefined) return;
    if (recorded !== generation) {
      throw new AutomationError(
        'SessionChanged',
        `variablesReference ${reference} belongs to a previous session generation`,
        false,
        { variablesReference: reference, expectedGeneration: recorded, actualGeneration: generation },
      );
    }
  }

  private rememberReference(reference: string, generation: number): void {
    this.referenceGeneration.set(reference, generation);
    if (this.referenceGeneration.size <= MAX_REFERENCE_TRACKING) return;
    // FIFO eviction keeps the map bounded. In the theoretical case of >4096
    // distinct references across restarts, evicting the oldest could drop a
    // stale marker and let a reused reference resolve against a reallocated
    // handle; at realistic per-session scale this is unreachable.
    const oldest = this.referenceGeneration.keys().next().value;
    if (oldest !== undefined) this.referenceGeneration.delete(oldest);
  }

  private paginate<T>(
    items: T[],
    cursor: string | undefined,
    limit: number | undefined,
    keyOf: (item: T) => string,
  ): RuntimeListData<T> {
    const effectiveLimit = this.clampPage(limit);
    const start = cursor === undefined ? 0 : this.cursorIndex(cursor, items, keyOf) + 1;
    const slice = items.slice(start, start + effectiveLimit);
    const data: RuntimeListData<T> = { items: slice };
    if (start + effectiveLimit < items.length) data.nextCursor = keyOf(slice[slice.length - 1]);
    return data;
  }

  private cursorIndex<T>(cursor: string, items: T[], keyOf: (item: T) => string): number {
    const index = items.findIndex(item => keyOf(item) === cursor);
    if (index === -1) {
      throw new AutomationError('InvalidRequest', `unknown cursor ${cursor}`, false);
    }
    return index;
  }

  private clampPage(value: number | undefined): number {
    const page = value ?? DEFAULT_PAGE_LIMIT;
    if (!Number.isFinite(page)) return DEFAULT_PAGE_LIMIT;
    return Math.max(1, Math.min(Math.floor(page), MAX_PAGE_LIMIT));
  }
}
