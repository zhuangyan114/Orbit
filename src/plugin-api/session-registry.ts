// Orbit Automation API v1 — exact DebugSession registration and the
// instance-level generation fence (plan Task 3, §2.3).
//
// One VS Code window has at most one Orbit-compatible session in a usable
// phase. The registry is the only authority that maps `SessionRef` identities
// to `vscode.DebugSession` objects; every comparison uses `DebugSession.id`
// plus object identity, never just `type`.
//
// Generation rules (frozen by §2.3):
// - `registryGeneration` is monotonic, starts at 0, and increments exactly
//   once per lifecycle transition (start, restart, termination, owner loss).
// - A newly started or restarted usable session takes the incremented value
//   as its `sessionGeneration`, so both are equal at creation.
// - Replacement is modeled as old terminated (+1) then new started (+1); the
//   derived `session.replaced` event never increments again.
// - Owner loss increments once and moves the session to `terminating`; the
//   session keeps its old generation and is unusable until a new start.
// - Active editor focus changes (`onActiveChanged`) never increment.
//
// This module is `vscode`-runtime-free (DebugSession is a type only) so the
// fence can be unit tested without the Extension Host.
import * as vscode from 'vscode';
import {
  AutomationError,
  Capability,
  OwnerKind,
  ProbeKind,
  SessionLocation,
  SessionPhase,
  SessionRef,
  SessionSnapshot,
  TargetStateKind,
  TransportKind,
} from './protocol';
import { isOrbitDebugSessionType } from '../utils/debug-session-type';
import { EventHub, SessionLifecycleEventType } from './event-hub';

const DEFAULT_MAX_TERMINATED_RECORDS = 32;

export interface SessionRegistryOptions {
  eventHub?: EventHub;
  maxTerminatedRecords?: number;
  now?(): number;
}

export interface SessionUpdatePatch {
  phase?: SessionPhase;
  targetState?: TargetStateKind;
  ownerKind?: OwnerKind;
  probe?: ProbeKind;
  transport?: TransportKind;
  /** `null` clears a previously recorded halt reason (e.g. when running). */
  stopReason?: string | null;
  /** `null` clears a previously recorded halted PC (e.g. when running). */
  pc?: string | null;
  threadId?: number;
  location?: SessionLocation;
  capabilities?: Capability[];
}

interface SessionRecord {
  session: vscode.DebugSession;
  sessionId: string;
  generation: number;
  name: string;
  type: 'orbit' | 'ozone';
  phase: SessionPhase;
  targetState: TargetStateKind;
  ownerKind?: OwnerKind;
  probe?: ProbeKind;
  transport?: TransportKind;
  stopReason?: string;
  pc?: string;
  threadId?: number;
  location?: SessionLocation;
  capabilities: Capability[];
  ownerLost: boolean;
  /** Monotonic ordering for the terminated history. */
  sequence: number;
}

const USABLE_PHASES: readonly SessionPhase[] = ['starting', 'connected', 'running', 'halted'];

/**
 * DAP-reported target phases `update()` may apply. `starting` is owned by
 * onStarted/onRestarted, `terminating` by markOwnerLost (each increments the
 * registry generation exactly once); a state patch must never smuggle a
 * lifecycle transition through the generation fence (§2.3).
 */
const PATCHABLE_PHASES: readonly SessionPhase[] = ['connected', 'running', 'halted'];

function isUsablePhase(phase: SessionPhase): boolean {
  return (USABLE_PHASES as readonly string[]).includes(phase);
}

function isPatchablePhase(phase: SessionPhase): boolean {
  return (PATCHABLE_PHASES as readonly string[]).includes(phase);
}

export class SessionRegistry {
  private registryGenerationValue = 0;
  private sequence = 0;
  private readonly records = new Map<string, SessionRecord>();
  private readonly terminatedHistory: SessionRecord[] = [];
  private activeRecord: SessionRecord | undefined;
  /** Informational only: last Orbit session the editor focused. Never transitions. */
  private focusedSessionId: string | undefined;
  /** Pairing for the derived `session.replaced` event when VS Code terminates first. */
  private recentlyTerminated: { sessionId: string; at: number } | undefined;
  private nowFn: () => number;

  constructor(private readonly options: SessionRegistryOptions = {}) {
    this.nowFn = options.now ?? (() => Date.now());
  }

  /** Instance-level fence value. Monotonic; never resets to 0 (§2.3). */
  get registryGeneration(): number {
    return this.registryGenerationValue;
  }

  /** VS Code session identity of the last Orbit session the editor focused. */
  get lastActiveSessionId(): string | undefined {
    return this.focusedSessionId;
  }

  /**
   * Registers a starting session. Duplicate events for the same session
   * object are ignored. A second live session replaces the current one:
   * old terminated (+1), new started (+1), then the derived
   * `session.replaced` event. Non-Orbit sessions are ignored.
   */
  onStarted(session: vscode.DebugSession): void {
    if (!isOrbitDebugSessionType(session.type)) return;
    let replacedSessionId: string | undefined;

    const existing = this.records.get(session.id);
    if (existing && this.activeRecord === existing) {
      if (existing.session === session) return; // duplicate event, same object
      // Same id, different object: terminate the stale object first.
      this.transitionTo(existing, 'terminated');
      this.archive(existing);
      this.publish('session.terminated', existing);
      replacedSessionId = existing.sessionId;
    } else if (existing) {
      // A terminated history record reuses this id: drop the old record.
      this.removeRecord(existing);
    }

    if (this.activeRecord && this.activeRecord.phase !== 'terminated') {
      // A different live session exists: replacement (old terminated +1 first).
      const old = this.activeRecord;
      this.transitionTo(old, 'terminated');
      this.archive(old);
      this.publish('session.terminated', old);
      replacedSessionId = replacedSessionId ?? old.sessionId;
    }

    const generation = this.advance();
    const record: SessionRecord = {
      session,
      sessionId: session.id,
      generation,
      name: session.name,
      type: session.type as 'orbit' | 'ozone',
      phase: 'starting',
      targetState: 'unknown',
      capabilities: [],
      ownerLost: false,
      sequence: this.nextSequence(),
    };
    this.records.set(session.id, record);
    this.activeRecord = record;
    this.publish('session.started', record, this.toSnapshot(record));

    if (replacedSessionId && replacedSessionId !== session.id) {
      this.publish(
        'session.replaced',
        record,
        { previousSessionId: replacedSessionId },
      );
      this.recentlyTerminated = undefined;
      return;
    }
    // VS Code may terminate the old session before starting the new one; pair
    // a closely following start with that termination as a replacement.
    const recent = this.recentlyTerminated;
    if (recent && recent.sessionId !== session.id && this.nowFn() - recent.at <= REPLACEMENT_PAIRING_WINDOW_MS) {
      this.publish('session.replaced', record, { previousSessionId: recent.sessionId });
      this.recentlyTerminated = undefined;
    }
  }

  /** Active editor focus change. Never increments any generation (§2.3). */
  onActiveChanged(session: vscode.DebugSession | undefined): void {
    this.focusedSessionId = session && isOrbitDebugSessionType(session.type) ? session.id : undefined;
  }

  /**
   * Terminates the exact registered session object. Unknown objects, already
   * terminated records (replacement path) and non-Orbit sessions are ignored.
   */
  onTerminated(session: vscode.DebugSession): void {
    if (!isOrbitDebugSessionType(session.type)) return;
    const record = this.records.get(session.id);
    if (!record || record.session !== session) return; // object identity matters
    if (record.phase === 'terminated') return; // replacement already archived it
    this.transitionTo(record, 'terminated');
    this.archive(record);
    this.publish('session.terminated', record, this.toSnapshot(record));
    this.recentlyTerminated = { sessionId: record.sessionId, at: this.nowFn() };
  }

  /**
   * Restart keeps the `sessionId` and increments once: the same session gets
   * the new registry generation and every old reference becomes stale (§2.3).
   */
  onRestarted(session: vscode.DebugSession): void {
    if (!isOrbitDebugSessionType(session.type)) return;
    const record = this.records.get(session.id);
    if (!record || record.session !== session || record.phase === 'terminated') {
      throw new AutomationError(
        'NoActiveSession',
        `cannot restart unknown session ${session.id}`,
        false,
        undefined,
        { sessionId: session.id },
      );
    }
    const previousPhase = record.phase;
    record.generation = this.advance();
    record.phase = 'starting';
    record.ownerLost = false;
    this.publish('session.phaseChanged', record, { phase: 'starting', previousPhase });
  }

  /**
   * Owner loss increments once and moves the session to `terminating`. The
   * session keeps its generation but no target request may use it until a new
   * session is started (§2.3).
   */
  markOwnerLost(session: vscode.DebugSession): void {
    if (!isOrbitDebugSessionType(session.type)) return;
    const record = this.records.get(session.id);
    if (!record || record.session !== session || record.phase === 'terminated') return;
    if (record.ownerLost) return; // a second loss report must not double-increment
    const previousPhase = record.phase;
    this.transitionTo(record, 'terminating');
    record.ownerLost = true;
    this.publish('session.phaseChanged', record, { phase: 'terminating', previousPhase });
  }

  /**
   * Merges a DAP-reported state patch into the exact session record. Phase
   * changes publish `session.phaseChanged` but never increment a generation.
   * Only target-driven phases (connected/running/halted) are accepted;
   * termination and owner loss must go through onTerminated/markOwnerLost.
   */
  update(session: vscode.DebugSession, patch: SessionUpdatePatch): void {
    if (!isOrbitDebugSessionType(session.type)) return;
    const record = this.records.get(session.id);
    if (!record || record.session !== session) return;
    const previousPhase = record.phase;
    const nextPhase = patch.phase;
    let appliedPhase: SessionPhase | undefined;
    if (nextPhase !== undefined && isPatchablePhase(nextPhase)) {
      record.phase = nextPhase;
      appliedPhase = nextPhase;
    }
    if (patch.targetState !== undefined) record.targetState = patch.targetState;
    if (patch.ownerKind !== undefined) record.ownerKind = patch.ownerKind;
    if (patch.probe !== undefined) record.probe = patch.probe;
    if (patch.transport !== undefined) record.transport = patch.transport;
    if (patch.stopReason !== undefined) record.stopReason = patch.stopReason ?? undefined;
    if (patch.pc !== undefined) record.pc = patch.pc ?? undefined;
    if (patch.threadId !== undefined) record.threadId = patch.threadId;
    if (patch.location !== undefined) record.location = patch.location;
    if (patch.capabilities !== undefined) {
      record.capabilities = patch.capabilities.map(capability => ({ ...capability }));
    }
    if (appliedPhase !== undefined && appliedPhase !== previousPhase) {
      this.publish('session.phaseChanged', record, { phase: appliedPhase, previousPhase });
    }
  }

  /**
   * Resolves an exact `SessionRef` to its registered DebugSession. Any
   * identity, generation or phase mismatch throws a frozen `AutomationError`
   * and never selects another window or session.
   */
  requireExact(ref: SessionRef): vscode.DebugSession {
    const record = this.records.get(ref.sessionId);
    if (!record || record.phase === 'terminated') {
      throw new AutomationError(
        'NoActiveSession',
        `no active session ${ref.sessionId}`,
        false,
        undefined,
        { sessionId: ref.sessionId },
      );
    }
    if (record.phase === 'terminating' || record.phase === 'error') {
      throw new AutomationError(
        'SessionTerminating',
        `session ${ref.sessionId} is ${record.phase}`,
        false,
        undefined,
        { sessionId: ref.sessionId, phase: record.phase },
      );
    }
    if (record.generation !== ref.sessionGeneration) {
      throw new AutomationError('SessionChanged', `session ${ref.sessionId} generation changed`, false, {
        expectedGeneration: ref.sessionGeneration,
        actualGeneration: record.generation,
      });
    }
    return record.session;
  }

  /** Dispatcher fence hook: the generation of a usable session, else undefined. */
  getSessionGeneration(sessionId: string): number | undefined {
    const record = this.records.get(sessionId);
    if (!record || !isUsablePhase(record.phase)) return undefined;
    return record.generation;
  }

  /** Current usable session identity for legacy callers without a ref. */
  currentRef(): SessionRef | undefined {
    const record = this.activeRecord;
    if (!record || !isUsablePhase(record.phase)) return undefined;
    return { sessionId: record.sessionId, sessionGeneration: record.generation };
  }

  /** Current session snapshot for the handshake (any phase, informational). */
  currentSnapshot(): SessionSnapshot | undefined {
    return this.activeRecord ? this.toSnapshot(this.activeRecord) : undefined;
  }

  /** Snapshot of any tracked session by id, including terminated history. */
  getSessionSnapshot(sessionId: string): SessionSnapshot | undefined {
    const record = this.records.get(sessionId);
    return record ? this.toSnapshot(record) : undefined;
  }

  /**
   * The registered `vscode.DebugSession` object for a session id, regardless
   * of phase (including terminated). Used by the automation lifecycle handler
   * to gate events on object identity without the phase/generation fence that
   * `requireExact` imposes — so a `target.connectionLost` event that arrives
   * after the session already terminated is still published.
   */
  getSessionObject(sessionId: string): vscode.DebugSession | undefined {
    const record = this.records.get(sessionId);
    return record ? record.session : undefined;
  }

  /** Active session first, then terminated history (most recent first). */
  snapshot(options: { includeTerminated?: boolean } = {}): SessionSnapshot[] {
    const items: SessionSnapshot[] = [];
    if (this.activeRecord) items.push(this.toSnapshot(this.activeRecord));
    if (options.includeTerminated) {
      for (const record of this.terminatedHistory) {
        if (record !== this.activeRecord) items.push(this.toSnapshot(record));
      }
    }
    return items;
  }

  dispose(): void {
    this.records.clear();
    this.terminatedHistory.length = 0;
    this.activeRecord = undefined;
    this.recentlyTerminated = undefined;
  }

  // --- internals -----------------------------------------------------------

  /** Every lifecycle transition increments exactly once (§2.3). */
  private advance(): number {
    this.registryGenerationValue += 1;
    return this.registryGenerationValue;
  }

  private transitionTo(record: SessionRecord, phase: SessionPhase): void {
    this.advance();
    record.phase = phase;
  }

  private archive(record: SessionRecord): void {
    if (this.activeRecord === record) this.activeRecord = undefined;
    if (this.terminatedHistory.includes(record)) return;
    this.terminatedHistory.push(record);
    const max = this.options.maxTerminatedRecords ?? DEFAULT_MAX_TERMINATED_RECORDS;
    while (this.terminatedHistory.length > max) {
      const oldest = this.terminatedHistory.shift()!;
      this.removeRecord(oldest);
    }
  }

  private removeRecord(record: SessionRecord): void {
    const index = this.terminatedHistory.indexOf(record);
    if (index >= 0) this.terminatedHistory.splice(index, 1);
    if (this.records.get(record.sessionId) === record) this.records.delete(record.sessionId);
  }

  private nextSequence(): number {
    this.sequence += 1;
    return this.sequence;
  }

  private toSnapshot(record: SessionRecord): SessionSnapshot {
    const snapshot: SessionSnapshot = {
      sessionId: record.sessionId,
      sessionGeneration: record.generation,
      registryGeneration: this.registryGenerationValue,
      name: record.name,
      type: record.type,
      phase: record.phase,
      targetState: record.targetState,
      capabilities: record.capabilities.map(capability => ({ ...capability })),
    };
    if (record.ownerKind !== undefined) snapshot.owner = record.ownerKind;
    if (record.probe !== undefined) snapshot.probe = record.probe;
    if (record.transport !== undefined) snapshot.transport = record.transport;
    if (record.stopReason !== undefined) snapshot.stopReason = record.stopReason;
    if (record.pc !== undefined) snapshot.pc = record.pc;
    if (record.threadId !== undefined) snapshot.threadId = record.threadId;
    if (record.location !== undefined) snapshot.location = { ...record.location };
    return snapshot;
  }

  private publish(
    type: SessionLifecycleEventType,
    record: SessionRecord,
    data?: unknown,
  ): void {
    const hub = this.options.eventHub;
    // A disposed hub (extension deactivate) must not turn a late VS Code
    // debug-session event into an unhandled throw inside the event callback.
    if (!hub || hub.isDisposed()) return;
    hub.publish(type, {
      sessionId: record.sessionId,
      sessionGeneration: record.generation,
      data: data === undefined ? undefined : (data as Record<string, unknown>),
    });
  }
}

/** Window in which a termination followed by a start counts as one replacement. */
const REPLACEMENT_PAIRING_WINDOW_MS = 10_000;
