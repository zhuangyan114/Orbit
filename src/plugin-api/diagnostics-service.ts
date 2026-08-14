// Orbit Automation API v1 — redacted diagnostics snapshot (plan Task 11).
//
// `orbit.diagnostics.snapshot` returns only counts, states, elapsed times and
// error codes. It must never include the bearer token, an Authorization header,
// raw memory data or user variable values; `tokenIncluded` is a frozen `false`
// constant so any future regression fails the OpenRPC contract, not silently.
import * as vscode from 'vscode';
import {
  DiagnosticsApi,
  DiagnosticsDap,
  DiagnosticsOwner,
  DiagnosticsSampling,
  DiagnosticsScheduler,
  DiagnosticsSnapshot,
  OwnerKind,
  SessionRef,
} from './protocol';
import { SessionRegistry } from './session-registry';
import {
  AUTOMATION_DIAGNOSTICS_COMMAND,
  AutomationDiagnosticsRequest,
  AutomationDiagnosticsResult,
  normalizeSchedulerSnapshot,
} from '../debug/dap-automation-protocol';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const ZERO_SCHEDULER: DiagnosticsScheduler = { control: 0, watch: 0, timeline: 0, background: 0 };
const ZERO_SAMPLING: DiagnosticsSampling = {
  activeRecordings: 0,
  retainedFrames: 0,
  retainedBytes: 0,
  droppedFrames: 0,
};

export interface DiagnosticsServiceOptions {
  registry: SessionRegistry;
  version: string;
  /** Number of live handshake connections. */
  getConnections?(): number;
  /** Number of live SSE connections. */
  getSseConnections?(): number;
  /** Whole-instance recording/sampling counters. */
  getSamplingStats?(): { activeRecordings: number; retainedFrames: number; retainedBytes: number; droppedFrames: number };
  /** Pulls the adapter-side diagnostics (owner/scheduler/pending) from a session. */
  snapshotDiagnosticsDap?(
    session: vscode.DebugSession,
    request: AutomationDiagnosticsRequest,
  ): Promise<AutomationDiagnosticsResult>;
}

export class DiagnosticsService {
  private readonly opts: Required<DiagnosticsServiceOptions>;

  constructor(options: DiagnosticsServiceOptions) {
    this.opts = {
      registry: options.registry,
      version: options.version,
      getConnections: options.getConnections ?? (() => 0),
      getSseConnections: options.getSseConnections ?? (() => 0),
      getSamplingStats: options.getSamplingStats ?? (() => ({ ...ZERO_SAMPLING })),
      snapshotDiagnosticsDap: options.snapshotDiagnosticsDap ?? (async (session, request) => {
        try {
          const response: unknown = await session.customRequest(AUTOMATION_DIAGNOSTICS_COMMAND, request);
          return (isRecord(response) ? response : {}) as unknown as AutomationDiagnosticsResult;
        } catch {
          // Best-effort: the adapter may be mid-transition; return a redacted
          // fallback without failing the whole snapshot.
          return {
            phase: 'error',
            targetState: 'unknown',
            ownerKind: 'unknown',
            connected: false,
            pendingRequests: 0,
            scheduler: normalizeSchedulerSnapshot(undefined),
          };
        }
      }),
    };
  }

  /** `orbit.diagnostics.snapshot`: redacted API/DAP/owner/scheduler/sampling summary. */
  async snapshot(sessionId?: string): Promise<DiagnosticsSnapshot> {
    const dapResult = await this.captureDap(sessionId);
    const sampling = this.opts.getSamplingStats();
    return {
      api: this.apiSummary(),
      dap: dapResult.dap,
      owner: dapResult.owner,
      scheduler: dapResult.scheduler,
      sampling: {
        activeRecordings: sampling.activeRecordings,
        retainedFrames: sampling.retainedFrames,
        retainedBytes: sampling.retainedBytes,
        droppedFrames: sampling.droppedFrames,
      },
      tokenIncluded: false,
    };
  }

  // --- internals -----------------------------------------------------------

  private apiSummary(): DiagnosticsApi {
    return {
      version: this.opts.version,
      connections: this.opts.getConnections(),
      sseConnections: this.opts.getSseConnections(),
      registryGeneration: this.opts.registry.registryGeneration,
    };
  }

  private async captureDap(sessionId?: string): Promise<{
    dap: DiagnosticsDap;
    owner: DiagnosticsOwner;
    scheduler: DiagnosticsScheduler;
  }> {
    const ref = this.resolveRef(sessionId);
    if (!ref) {
      return {
        dap: { phase: 'none', pendingRequests: 0 },
        owner: { connected: false },
        scheduler: { ...ZERO_SCHEDULER },
      };
    }

    let session: vscode.DebugSession;
    try {
      session = this.opts.registry.requireExact(ref);
    } catch {
      return {
        dap: { phase: 'none', pendingRequests: 0 },
        owner: { connected: false },
        scheduler: { ...ZERO_SCHEDULER },
      };
    }

    const result = await this.opts.snapshotDiagnosticsDap(session, {
      sessionGeneration: ref.sessionGeneration,
    });
    const snapshot = this.opts.registry.getSessionSnapshot(ref.sessionId);
    const phase = typeof result.phase === 'string' && result.phase !== 'unknown'
      ? result.phase
      : snapshot?.phase ?? 'unknown';
    const ownerKind = this.toOwnerKind(result.ownerKind, snapshot?.owner);
    const connected = result.connected === true
      || snapshot?.targetState === 'running'
      || snapshot?.targetState === 'halted';

    const dap: DiagnosticsDap = {
      sessionId: ref.sessionId,
      sessionGeneration: ref.sessionGeneration,
      phase,
      pendingRequests: typeof result.pendingRequests === 'number' ? result.pendingRequests : 0,
    };
    const owner: DiagnosticsOwner = { connected };
    if (ownerKind) owner.kind = ownerKind;
    if (typeof result.transport === 'string') owner.transport = result.transport;
    else if (snapshot?.transport) owner.transport = snapshot.transport;
    const scheduler: DiagnosticsScheduler = result.scheduler
      ? {
          control: result.scheduler.control,
          watch: result.scheduler.watch,
          timeline: result.scheduler.timeline,
          background: result.scheduler.background,
        }
      : { ...ZERO_SCHEDULER };

    return { dap, owner, scheduler };
  }

  private resolveRef(sessionId?: string): SessionRef | undefined {
    if (sessionId !== undefined) {
      const generation = this.opts.registry.getSessionGeneration(sessionId);
      return generation === undefined ? undefined : { sessionId, sessionGeneration: generation };
    }
    return this.opts.registry.currentRef();
  }

  private toOwnerKind(kind: string | undefined, fallback: OwnerKind | undefined): OwnerKind | undefined {
    if (kind === 'jlink-native' || kind === 'jlink-legacy' || kind === 'cmsis-dap') return kind;
    return fallback;
  }
}
