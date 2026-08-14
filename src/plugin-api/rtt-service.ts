// Orbit Automation API v1 — RTT service (plan Task 11).
//
// `orbit.rtt.status` / `start` / `stop` / `read` route exclusively through the
// exact active session's selected target owner via the `orbitRttSnapshot`
// custom request. RTT is a distinct logical consumer from Watch/Timeline/
// recording and the UI RTT Log even though they share the physical owner:
// reads run at background priority and are paused for a control request's
// critical section by the scheduler. There is no extension-host backend
// fallback; a missing/stale session is a frozen fence error.
import * as vscode from 'vscode';
import { AutomationError, RttReadData, RttSnapshot, SessionRef } from './protocol';
import { SessionRegistry } from './session-registry';
import { EventHub } from './event-hub';
import {
  AUTOMATION_RTT_COMMAND,
  AutomationRttRequest,
  AutomationRttResult,
  AutomationRttSnapshot,
} from '../debug/dap-automation-protocol';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Reconstructs a structured DAP RTT failure from a `customRequest` rejection. */
function rttFailureFromRejection(error: unknown): AutomationRttResult | undefined {
  const record = (error && typeof error === 'object') ? error as Record<string, unknown> : {};
  const body = record.body && typeof record.body === 'object' ? record.body as Record<string, unknown> : undefined;
  if (body && typeof body.errorCode === 'string') {
    return {
      errorCode: body.errorCode,
      message: typeof body.message === 'string' ? body.message : undefined,
      targetState: typeof body.targetState === 'string' ? body.targetState : undefined,
    };
  }
  const message = typeof record.message === 'string' ? record.message : '';
  const prefix = /^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/.exec(message.trim());
  if (prefix) {
    return { errorCode: prefix[1], message: prefix[2] || message };
  }
  return undefined;
}

export interface RttServiceOptions {
  registry: SessionRegistry;
  /** Publishes `rtt.stateChanged` when start/stop changes the owner RTT state. */
  eventHub?: EventHub;
  /** Pulls one RTT operation from an exact active session. */
  snapshotRttDap?(session: vscode.DebugSession, request: AutomationRttRequest): Promise<AutomationRttResult>;
}

interface ResolvedRttOptions {
  registry: SessionRegistry;
  snapshotRttDap: (session: vscode.DebugSession, request: AutomationRttRequest) => Promise<AutomationRttResult>;
}

export interface RttStatusParams {
  bufferIndex?: number;
}

export interface RttStartParams {
  bufferIndex?: number;
  pollIntervalMs?: number;
  targetName?: string;
  ansi?: boolean;
}

export interface RttStopParams {
  bufferIndex?: number;
}

export interface RttReadParams {
  bufferIndex?: number;
  cursor?: string;
  maxBytes?: number;
}

export class RttService {
  private readonly opts: ResolvedRttOptions;
  private readonly eventHub?: EventHub;

  constructor(options: RttServiceOptions) {
    this.eventHub = options.eventHub;
    this.opts = {
      registry: options.registry,
      snapshotRttDap: options.snapshotRttDap ?? (async (session, request) => {
        try {
          const response: unknown = await session.customRequest(AUTOMATION_RTT_COMMAND, request);
          return (isRecord(response) ? response : {}) as AutomationRttResult;
        } catch (error) {
          const structured = rttFailureFromRejection(error);
          if (structured) return structured;
          throw error;
        }
      }),
    };
  }

  /** `orbit.rtt.status`: current RTT state for the exact session owner. */
  async status(ref: SessionRef, params: RttStatusParams = {}): Promise<RttSnapshot> {
    const { session, generation } = this.resolve(ref);
    const result = await this.snapshotRtt(session, {
      kind: 'status',
      sessionGeneration: generation,
      ...(params.bufferIndex !== undefined ? { bufferIndex: params.bufferIndex } : {}),
    });
    return this.toSnapshot(result);
  }

  /** `orbit.rtt.start`: start RTT on the selected owner. */
  async start(ref: SessionRef, params: RttStartParams = {}): Promise<RttSnapshot> {
    const { session, generation } = this.resolve(ref);
    const result = await this.snapshotRtt(session, {
      kind: 'start',
      sessionGeneration: generation,
      ...(params.bufferIndex !== undefined ? { bufferIndex: params.bufferIndex } : {}),
      ...(params.pollIntervalMs !== undefined ? { pollIntervalMs: params.pollIntervalMs } : {}),
      ...(params.targetName !== undefined ? { targetName: params.targetName } : {}),
      ...(params.ansi !== undefined ? { ansi: params.ansi } : {}),
    });
    const snapshot = this.toSnapshot(result);
    this.publish('rtt.stateChanged', { state: snapshot.state });
    return snapshot;
  }

  /** `orbit.rtt.stop`: stop RTT on the selected owner. */
  async stop(ref: SessionRef, params: RttStopParams = {}): Promise<RttSnapshot> {
    const { session, generation } = this.resolve(ref);
    const result = await this.snapshotRtt(session, {
      kind: 'stop',
      sessionGeneration: generation,
      ...(params.bufferIndex !== undefined ? { bufferIndex: params.bufferIndex } : {}),
    });
    const snapshot = this.toSnapshot(result);
    this.publish('rtt.stateChanged', { state: snapshot.state });
    return snapshot;
  }

  /** `orbit.rtt.read`: one base64 read block from the selected owner. */
  async read(ref: SessionRef, params: RttReadParams = {}): Promise<RttReadData> {
    const { session, generation } = this.resolve(ref);
    const result = await this.snapshotRtt(session, {
      kind: 'read',
      sessionGeneration: generation,
      ...(params.bufferIndex !== undefined ? { bufferIndex: params.bufferIndex } : {}),
      ...(params.maxBytes !== undefined ? { maxBytes: params.maxBytes } : {}),
    });
    const data: RttReadData = {
      snapshot: this.toSnapshot(result),
      data: typeof result.data === 'string' ? result.data : '',
      bytesRead: typeof result.bytesRead === 'number' ? result.bytesRead : 0,
    };
    if (result.data !== undefined) data.nextCursor = null;
    return data;
  }

  // --- internals -----------------------------------------------------------

  private async snapshotRtt(session: vscode.DebugSession, request: AutomationRttRequest): Promise<AutomationRttResult> {
    let result: AutomationRttResult;
    try {
      result = await this.opts.snapshotRttDap(session, request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new AutomationError('TargetDisconnected', `RTT snapshot failed: ${message}`, false, undefined, {
        dapMessage: message,
      });
    }
    this.throwOnRttFailure(result);
    return result;
  }

  private throwOnRttFailure(result: AutomationRttResult): void {
    if (!result.errorCode) return;
    const code = result.errorCode;
    const message = result.message ?? code;
    const details: Record<string, unknown> = { dapMessage: message };
    if (result.targetState !== undefined) details.targetState = result.targetState;
    if (code === 'CapabilityUnavailable' || code === 'UnsupportedCapability') {
      throw new AutomationError('CapabilityUnavailable', message, false, undefined, details);
    }
    if (code === 'SessionStarting') {
      throw new AutomationError('SessionStarting', message, true, undefined, details);
    }
    if (code === 'SessionTerminating') {
      throw new AutomationError('SessionTerminating', message, false, undefined, details);
    }
    if (code === 'TargetBusy') {
      throw new AutomationError('TargetBusy', message, true, undefined, details);
    }
    if (code === 'TargetReadCancelled' || code === 'TargetReadUnavailable') {
      throw new AutomationError('TargetReadCancelled', message, true, undefined, details);
    }
    if (code === 'TargetDisconnected' || code === 'NativeOwnerLost' || code === 'DeviceRemoved' || code === 'RttOwnerLost') {
      throw new AutomationError('TargetDisconnected', message, false, undefined, details);
    }
    if (code === 'InvalidRequest') {
      throw new AutomationError('InvalidRequest', message, false, undefined, details);
    }
    throw new AutomationError('InternalError', message, false, undefined, details);
  }

  private toSnapshot(result: AutomationRttResult): RttSnapshot {
    const snapshot = result.snapshot;
    if (!snapshot) {
      throw new AutomationError('InternalError', 'RTT snapshot is missing from the DAP result', false);
    }
    return this.mapSnapshot(snapshot);
  }

  private mapSnapshot(snapshot: AutomationRttSnapshot): RttSnapshot {
    const mapped: RttSnapshot = {
      state: snapshot.state,
      owner: snapshot.owner,
      bufferIndex: snapshot.bufferIndex,
      pollIntervalMs: snapshot.pollIntervalMs,
      ansi: snapshot.ansi,
      bytesAvailable: snapshot.bytesAvailable,
      droppedBytes: snapshot.droppedBytes,
    };
    if (snapshot.targetName !== undefined) mapped.targetName = snapshot.targetName;
    return mapped;
  }

  private resolve(ref: SessionRef): { session: vscode.DebugSession; generation: number } {
    const session = this.opts.registry.requireExact(ref);
    return { session, generation: ref.sessionGeneration };
  }

  private publish(type: string, data?: Record<string, unknown>): void {
    const hub = this.eventHub;
    if (!hub || hub.isDisposed()) return;
    try {
      hub.publish(type, { data });
    } catch {
      // A disposed hub must not break an RTT mutation.
    }
  }
}
