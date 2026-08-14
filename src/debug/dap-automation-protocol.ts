// Internal DAP automation control contract (plan Task 5).
//
// The Extension Host drives real, visible VS Code control through the active
// DAP session with `session.customRequest('orbitAutomationControl', ...)`.
// The adapter executes the SAME handler core as the standard DAP requests
// (`continue`, `pause`, `restart`, `next`, `stepIn`, `stepOut`) and replies
// with a structured outcome. This module stays `vscode`-free so the adapter
// process can import it.
//
// Action-specific fields mirror the frozen public params of the v1 catalog
// (orbit.target.* methods): threadId/singleThread for continue,
// threadId for pause, mode for reset, threadId/granularity for steps, and
// elfPath/verify/resetAfter/timeoutMs for flash.

export const AUTOMATION_CONTROL_COMMAND = 'orbitAutomationControl';
export const AUTOMATION_CONTROL_EVENT = 'orbitAutomationControl';

/** Internal custom request the Extension Host uses to pull the DAP-side verified snapshot (plan Task 6). */
export const AUTOMATION_BREAKPOINTS_COMMAND = 'orbitBreakpointsSnapshot';

/** Internal custom request the Extension Host uses to read runtime state (plan Task 7). */
export const AUTOMATION_RUNTIME_COMMAND = 'orbitRuntimeSnapshot';

export type AutomationControlAction =
  | 'pause' | 'continue' | 'reset' | 'restart'
  | 'stepOver' | 'stepInto' | 'stepOut' | 'stepInstruction'
  | 'flash';

export type AutomationControlState = 'running' | 'halted' | 'unknown';

export interface AutomationControlRequest {
  action: AutomationControlAction;
  sessionGeneration: number;
  /** Frozen params of orbit.target.continue / orbit.target.pause. */
  threadId?: number;
  singleThread?: boolean;
  /** Frozen params of orbit.target.step* (source is the default). */
  granularity?: 'source' | 'instruction';
  /** Frozen params of orbit.target.reset. */
  mode?: 'halt' | 'run';
  /** Frozen params of orbit.target.flash. */
  elfPath?: string;
  verify?: boolean;
  resetAfter?: 'none' | 'halt' | 'run';
  timeoutMs?: number;
}

/** Flash outcome segment: mirrors the frozen FlashSegment schema. */
export interface AutomationFlashSegment {
  /** Frozen Address: 0x-prefixed hex. */
  startAddress: string;
  endAddress: string;
  bytes: number;
}

/** DAP-side flash outcome: mirrors the frozen FlashReport schema. */
export interface AutomationFlashReport {
  elfPath: string;
  owner: 'jlink-native' | 'jlink-legacy' | 'cmsis-dap';
  bytesProgrammed: number;
  verified: boolean;
  segments: AutomationFlashSegment[];
  elapsedMs: number;
  diagnostics?: Record<string, unknown>;
}

/**
 * Outcome of one automation control request. Success responses carry
 * `state` (the state the target settled in when the control completed);
 * failure responses (DAP response `success: false`) carry `errorCode`,
 * `message` and optional `targetState`.
 */
export interface AutomationControlResult {
  state: AutomationControlState;
  stopReason?: string;
  /** Frozen Address: 0x-prefixed hex of the halted PC, when halted. */
  pc?: string;
  source?: { path: string; line: number };
  diagnostics?: Record<string, unknown>;
  flash?: AutomationFlashReport;
  errorCode?: string;
  message?: string;
  targetState?: string;
}

const ACTIONS: readonly AutomationControlAction[] = [
  'pause', 'continue', 'reset', 'restart',
  'stepOver', 'stepInto', 'stepOut', 'stepInstruction', 'flash',
];

const STEP_ACTIONS: readonly AutomationControlAction[] = [
  'stepOver', 'stepInto', 'stepOut', 'stepInstruction',
];

/** Whether an action is a stepping control (the only controls with a frozen `TargetRunning` error). */
export function isStepAction(action: AutomationControlAction): boolean {
  return (STEP_ACTIONS as readonly string[]).includes(action);
}

export interface AutomationParseFailure {
  ok: false;
  errorCode: string;
  message: string;
}

export interface AutomationParseSuccess {
  ok: true;
  request: AutomationControlRequest;
}

export type AutomationParseResult = AutomationParseFailure | AutomationParseSuccess;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

/**
 * Validates the wire arguments of an automation control request. Never
 * throws; every rejection carries a machine-readable errorCode that the
 * RuntimeRouter maps to the frozen automation error codes.
 */
export function parseAutomationControlRequest(args: unknown): AutomationParseResult {
  if (!isRecord(args)) {
    return { ok: false, errorCode: 'InvalidRequest', message: 'automation control requires request arguments' };
  }
  if (!isOneOf(args.action, ACTIONS)) {
    return { ok: false, errorCode: 'InvalidRequest', message: `unknown automation action ${String(args.action)}` };
  }
  const action = args.action;
  if (!isPositiveInt(args.sessionGeneration)) {
    return { ok: false, errorCode: 'InvalidRequest', message: 'sessionGeneration must be a positive integer' };
  }
  const request: AutomationControlRequest = {
    action,
    sessionGeneration: args.sessionGeneration,
  };

  if (args.threadId !== undefined) {
    if (!isPositiveInt(args.threadId)) {
      return { ok: false, errorCode: 'InvalidRequest', message: 'threadId must be a positive integer' };
    }
    request.threadId = args.threadId;
  }
  if (args.singleThread !== undefined) {
    if (typeof args.singleThread !== 'boolean') {
      return { ok: false, errorCode: 'InvalidRequest', message: 'singleThread must be a boolean' };
    }
    request.singleThread = args.singleThread;
  }
  if (STEP_ACTIONS.includes(action)) {
    if (!isPositiveInt(args.threadId)) {
      return { ok: false, errorCode: 'InvalidRequest', message: `${action} requires a positive integer threadId` };
    }
    request.threadId = args.threadId;
    if (action === 'stepInstruction') {
      if (args.granularity !== undefined && args.granularity !== 'instruction') {
        return { ok: false, errorCode: 'InvalidRequest', message: 'stepInstruction only supports instruction granularity' };
      }
      request.granularity = 'instruction';
    } else {
      const granularity = args.granularity === undefined ? 'source' : args.granularity;
      if (!isOneOf(granularity, ['source', 'instruction'])) {
        return { ok: false, errorCode: 'InvalidRequest', message: 'granularity must be source or instruction' };
      }
      request.granularity = granularity;
    }
  }
  if (action === 'reset') {
    const mode = args.mode === undefined ? 'halt' : args.mode;
    if (!isOneOf(mode, ['halt', 'run'])) {
      return { ok: false, errorCode: 'InvalidRequest', message: 'reset mode must be halt or run' };
    }
    request.mode = mode;
  }
  if (action === 'flash') {
    if (typeof args.elfPath !== 'string' || args.elfPath.trim().length === 0) {
      return { ok: false, errorCode: 'InvalidRequest', message: 'flash requires an explicit elfPath' };
    }
    request.elfPath = args.elfPath.trim();
    if (args.verify !== undefined && typeof args.verify !== 'boolean') {
      return { ok: false, errorCode: 'InvalidRequest', message: 'verify must be a boolean' };
    }
    request.verify = args.verify ?? true;
    const resetAfter = args.resetAfter === undefined ? 'halt' : args.resetAfter;
    if (!isOneOf(resetAfter, ['none', 'halt', 'run'])) {
      return { ok: false, errorCode: 'InvalidRequest', message: 'resetAfter must be none, halt or run' };
    }
    request.resetAfter = resetAfter;
    if (args.timeoutMs !== undefined && !isPositiveInt(args.timeoutMs)) {
      return { ok: false, errorCode: 'InvalidRequest', message: 'timeoutMs must be a positive integer' };
    }
    request.timeoutMs = args.timeoutMs;
  }
  return { ok: true, request };
}

export interface StandardCommandMapping {
  command: 'continue' | 'pause' | 'restart' | 'next' | 'stepIn' | 'stepOut';
  arguments?: Record<string, unknown>;
}

/**
 * Maps an automation action onto the standard DAP request that exercises the
 * SAME handler core. `null` marks the two actions without a standard DAP
 * counterpart (reset and flash), which have dedicated automation cores.
 */
export function standardCommandForAction(request: AutomationControlRequest): StandardCommandMapping | null {
  switch (request.action) {
    case 'continue':
      return { command: 'continue' };
    case 'pause':
      return { command: 'pause' };
    case 'restart':
      return { command: 'restart' };
    case 'stepOver':
      return request.granularity === 'instruction'
        ? { command: 'next', arguments: { granularity: 'instruction' } }
        : { command: 'next' };
    case 'stepInto':
      return request.granularity === 'instruction'
        ? { command: 'stepIn', arguments: { granularity: 'instruction' } }
        : { command: 'stepIn' };
    case 'stepOut':
      // The selected owners have no instruction-level stepOut; returning null
      // lets the caller report CapabilityUnavailable instead of silently
      // degrading an instruction step to a source-level stepOut.
      return request.granularity === 'instruction' ? null : { command: 'stepOut' };
    case 'stepInstruction':
      return { command: 'stepIn', arguments: { granularity: 'instruction' } };
    case 'reset':
    case 'flash':
      return null;
  }
}

/**
 * DAP-side verified breakpoint (plan Task 6). The adapter tracks verified
 * hardware breakpoints by normalized source location; unverified breakpoints
 * are simply absent. `slot` is the selected owner's hardware slot id and
 * `address` the resolved instruction address (0x-prefixed hex) when the owner
 * reports it.
 */
export interface AutomationBreakpointSnapshot {
  path: string;
  line: number;
  verified: boolean;
  slot?: number;
  address?: string;
}

/**
 * Adapter capabilities for the breakpoint kinds the frozen public DTO carries.
 * These mirror the adapter's `initialize` response; a `false` value means the
 * corresponding field (condition/hitCondition/logMessage) is accepted by the
 * Extension Host but NOT enforced by the adapter.
 */
export interface AutomationBreakpointCapabilities {
  conditional: boolean;
  hitConditional: boolean;
  logPoints: boolean;
}

/** Result of the `orbitBreakpointsSnapshot` custom request. */
export interface AutomationBreakpointsResult {
  breakpoints: AutomationBreakpointSnapshot[];
  capabilities: AutomationBreakpointCapabilities;
}

// --- runtime snapshot (plan Task 7) ----------------------------------------
// `orbitRuntimeSnapshot` reuses the standard DAP threads/stackTrace/scopes/
// variables data models and adds a dedicated registers core. The Extension Host
// maps these adapter-internal shapes onto the frozen public DTOs, so this
// module stays `vscode`-free.

export type AutomationRuntimeKind =
  | 'threads'
  | 'stackTrace'
  | 'scopes'
  | 'variables'
  | 'registers';

export type AutomationRegisterGroup = 'core' | 'floating' | 'system';

export interface AutomationRuntimeRequest {
  kind: AutomationRuntimeKind;
  sessionGeneration: number;
  /** stackTrace: the thread whose frames are requested. */
  threadId?: number;
  startFrame?: number;
  levels?: number;
  /** scopes: the stack frame whose scopes are requested. */
  frameId?: number;
  /** variables: the variablesReference to expand (adapter-internal integer). */
  variablesReference?: number;
  /** registers: restrict to the requested groups (core is the only populated group). */
  groups?: AutomationRegisterGroup[];
}

/** Adapter-internal thread shape (mirrors the frozen public Thread DTO). */
export interface AutomationThread {
  threadId: number;
  name: string;
  state: string;
  stopped: boolean;
}

/** Adapter-internal stack frame shape (mirrors the frozen public StackFrame DTO). */
export interface AutomationStackFrame {
  frameId: number;
  name: string;
  source?: { path: string; line: number };
  instructionPointerReference: string;
}

/** Adapter-internal scope shape (mirrors the frozen public Scope DTO). */
export interface AutomationScope {
  name: string;
  variablesReference: number;
  expensive: boolean;
}

/** Adapter-internal variable shape (mirrors the frozen public Variable DTO). */
export interface AutomationVariable {
  name: string;
  value: string;
  type?: string;
  variablesReference: number;
  evaluateName?: string;
  memoryReference?: string;
}

/** Adapter-internal register shape (mirrors the frozen public Register DTO). */
export interface AutomationRegister {
  name: string;
  /** Exact value as a 0x-prefixed hex string. */
  value: string;
  group: AutomationRegisterGroup;
  bits: number;
  memoryReference?: string;
}

/** Outcome of `orbitRuntimeSnapshot`: one kind-specific payload or a failure. */
export interface AutomationRuntimeResult {
  threads?: AutomationThread[];
  stackFrames?: AutomationStackFrame[];
  scopes?: AutomationScope[];
  variables?: AutomationVariable[];
  registers?: AutomationRegister[];
  errorCode?: string;
  message?: string;
  targetState?: string;
  elapsedMs?: number;
}

export type AutomationRuntimeParseResult =
  | { ok: true; request: AutomationRuntimeRequest }
  | { ok: false; errorCode: string; message: string };

const RUNTIME_KINDS: readonly AutomationRuntimeKind[] = [
  'threads', 'stackTrace', 'scopes', 'variables', 'registers',
];

const REGISTER_GROUPS: readonly AutomationRegisterGroup[] = ['core', 'floating', 'system'];

/**
 * Validates the wire arguments of `orbitRuntimeSnapshot`. Never throws; every
 * rejection carries a machine-readable errorCode the RuntimeService maps to the
 * frozen automation error codes.
 */
export function parseAutomationRuntimeRequest(args: unknown): AutomationRuntimeParseResult {
  if (!isRecord(args)) {
    return { ok: false, errorCode: 'InvalidRequest', message: 'automation runtime requires request arguments' };
  }
  if (!isOneOf(args.kind, RUNTIME_KINDS)) {
    return { ok: false, errorCode: 'InvalidRequest', message: `unknown automation runtime kind ${String(args.kind)}` };
  }
  if (!isPositiveInt(args.sessionGeneration)) {
    return { ok: false, errorCode: 'InvalidRequest', message: 'sessionGeneration must be a positive integer' };
  }
  const request: AutomationRuntimeRequest = {
    kind: args.kind,
    sessionGeneration: args.sessionGeneration,
  };

  if (args.kind === 'stackTrace') {
    if (!isPositiveInt(args.threadId)) {
      return { ok: false, errorCode: 'InvalidRequest', message: 'stackTrace requires a positive integer threadId' };
    }
    request.threadId = args.threadId;
    if (args.startFrame !== undefined) {
      if (typeof args.startFrame !== 'number' || !Number.isInteger(args.startFrame) || args.startFrame < 0) {
        return { ok: false, errorCode: 'InvalidRequest', message: 'startFrame must be a non-negative integer' };
      }
      request.startFrame = args.startFrame;
    }
    if (args.levels !== undefined) {
      if (typeof args.levels !== 'number' || !Number.isInteger(args.levels) || args.levels < 1) {
        return { ok: false, errorCode: 'InvalidRequest', message: 'levels must be a positive integer' };
      }
      request.levels = args.levels;
    }
  }
  if (args.kind === 'scopes') {
    if (!isPositiveInt(args.frameId)) {
      return { ok: false, errorCode: 'InvalidRequest', message: 'scopes requires a positive integer frameId' };
    }
    request.frameId = args.frameId;
  }
  if (args.kind === 'variables') {
    // A leaf variable carries variablesReference 0; expanding it is a valid
    // empty read, so 0 is accepted (any other non-integer is rejected).
    if (typeof args.variablesReference !== 'number'
      || !Number.isInteger(args.variablesReference)
      || args.variablesReference < 0) {
      return { ok: false, errorCode: 'InvalidRequest', message: 'variables requires a non-negative integer variablesReference' };
    }
    request.variablesReference = args.variablesReference;
  }
  if (args.kind === 'registers' && args.groups !== undefined) {
    if (!Array.isArray(args.groups) || args.groups.some(group => !isOneOf(group, REGISTER_GROUPS))) {
      return { ok: false, errorCode: 'InvalidRequest', message: 'groups must be a subset of core/floating/system' };
    }
    request.groups = [...args.groups];
  }
  return { ok: true, request };
}
