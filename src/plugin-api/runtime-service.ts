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
  RuntimeListData,
  RuntimeRegister,
  RuntimeScope,
  RuntimeStackFrame,
  RuntimeThread,
  RuntimeVariable,
  SessionRef,
} from './protocol';
import { SessionRegistry } from './session-registry';
import {
  AUTOMATION_RUNTIME_COMMAND,
  AutomationRegisterGroup,
  AutomationRuntimeRequest,
  AutomationRuntimeResult,
} from '../debug/dap-automation-protocol';

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
