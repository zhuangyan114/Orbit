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
      // The selected owners have no instruction-level stepOut; the frozen
      // catalog allows the granularity field but the capability is reported
      // unavailable by the caller-facing layer.
      return request.granularity === 'instruction' ? { command: 'stepOut', arguments: { granularity: 'instruction' } } : { command: 'stepOut' };
    case 'stepInstruction':
      return { command: 'stepIn', arguments: { granularity: 'instruction' } };
    case 'reset':
    case 'flash':
      return null;
  }
}
