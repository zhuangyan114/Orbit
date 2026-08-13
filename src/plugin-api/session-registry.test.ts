// SessionRegistry: exact DebugSession registration, generation fence,
// replacement/owner-loss transitions and lifecycle event publication
// (plan Task 3, §2.3).
import * as vscode from 'vscode';
import { describe, expect, it } from 'vitest';
import { AutomationError, Capability } from './protocol';
import { EventHub, SessionLifecycleEventType } from './event-hub';
import { SessionRegistry } from './session-registry';

function makeSession(id: string, type: string = 'orbit', name = 'Orbit Debug'): vscode.DebugSession {
  return { id, type, name } as unknown as vscode.DebugSession;
}

function setup(options: { maxTerminatedRecords?: number; now?: () => number } = {}) {
  let clock = 0;
  const now = options.now ?? (() => clock);
  const hub = new EventHub({
    instanceId: () => 'inst-1',
    projectId: () => 'sha256:project-1',
    now,
  });
  const registry = new SessionRegistry({
    eventHub: hub,
    maxTerminatedRecords: options.maxTerminatedRecords,
    now,
  });
  const events = () => hub.eventsAfter(undefined).events;
  const advance = (ms: number) => { clock += ms; };
  return { hub, registry, events, advance };
}

function catchError(fn: () => unknown): AutomationError {
  try {
    fn();
  } catch (error) {
    return error as AutomationError;
  }
  throw new Error('expected the call to throw');
}

describe('SessionRegistry lifecycle and generation fence', () => {
  it('registers a starting session and assigns sessionGeneration = registryGeneration', () => {
    const { registry, events } = setup();
    const s1 = makeSession('s1');

    registry.onStarted(s1);

    expect(registry.registryGeneration).toBe(1);
    expect(registry.getSessionGeneration('s1')).toBe(1);
    expect(registry.currentRef()).toEqual({ sessionId: 's1', sessionGeneration: 1 });
    expect(registry.snapshot()).toEqual([
      expect.objectContaining({
        sessionId: 's1',
        sessionGeneration: 1,
        registryGeneration: 1,
        name: 'Orbit Debug',
        type: 'orbit',
        phase: 'starting',
        targetState: 'unknown',
        capabilities: [],
      }),
    ]);
    expect(registry.requireExact({ sessionId: 's1', sessionGeneration: 1 })).toBe(s1);
    expect(events().map(event => event.type)).toEqual(['session.started']);
    expect(events()[0]).toMatchObject({
      instanceId: 'inst-1',
      projectId: 'sha256:project-1',
      sessionId: 's1',
      sessionGeneration: 1,
    });
  });

  it('ignores duplicate onStarted for the same session object without a transition', () => {
    const { registry, events } = setup();
    const s1 = makeSession('s1');

    registry.onStarted(s1);
    registry.onStarted(s1);

    expect(registry.registryGeneration).toBe(1);
    expect(events()).toHaveLength(1);
  });

  it('ignores non-Orbit sessions everywhere', () => {
    const { registry, events } = setup();
    const node = makeSession('n1', 'node', 'Node Debug');

    registry.onStarted(node);
    registry.onActiveChanged(node);
    registry.onTerminated(node);

    expect(registry.registryGeneration).toBe(0);
    expect(registry.snapshot({ includeTerminated: true })).toEqual([]);
    expect(registry.currentRef()).toBeUndefined();
    expect(events()).toEqual([]);
  });

  it('treats active focus changes as informational and never increments generations', () => {
    const { registry, events } = setup();
    const s1 = makeSession('s1');

    registry.onStarted(s1);
    registry.onActiveChanged(s1);
    registry.onActiveChanged(makeSession('unrelated', 'ozone'));
    registry.onActiveChanged(undefined);
    registry.onActiveChanged(s1);

    expect(registry.registryGeneration).toBe(1);
    expect(registry.lastActiveSessionId).toBe('s1');
    expect(events()).toHaveLength(1); // only session.started
  });

  it('terminates the exact session object and invalidates its references', () => {
    const { registry, events } = setup();
    const s1 = makeSession('s1');

    registry.onStarted(s1);
    registry.onTerminated(s1);

    expect(registry.registryGeneration).toBe(2);
    expect(registry.getSessionGeneration('s1')).toBeUndefined();
    expect(registry.currentRef()).toBeUndefined();
    expect(registry.currentSnapshot()).toBeUndefined();
    expect(registry.snapshot()).toEqual([]);
    const terminated = registry.snapshot({ includeTerminated: true });
    expect(terminated).toHaveLength(1);
    expect(terminated[0]).toMatchObject({ sessionId: 's1', sessionGeneration: 1, phase: 'terminated' });

    expect(catchError(() => registry.requireExact({ sessionId: 's1', sessionGeneration: 1 })).errorCode)
      .toBe('NoActiveSession');

    expect(events().map(event => event.type)).toEqual(['session.started', 'session.terminated']);
    expect(events()[1]).toMatchObject({
      type: 'session.terminated',
      sessionId: 's1',
      sessionGeneration: 1,
      data: expect.objectContaining({ phase: 'terminated' }),
    });

    // Duplicate termination must not increment again.
    registry.onTerminated(s1);
    expect(registry.registryGeneration).toBe(2);
    expect(events()).toHaveLength(2);
  });

  it('requires object identity, not just the session id, for termination', () => {
    const { registry } = setup();
    const s1 = makeSession('s1');

    registry.onStarted(s1);
    registry.onTerminated(makeSession('s1')); // same id, different object

    expect(registry.registryGeneration).toBe(1);
    expect(registry.requireExact({ sessionId: 's1', sessionGeneration: 1 })).toBe(s1);
  });

  it('models replacement as old terminated (+1) then new started (+1) with a derived replaced event', () => {
    const { registry, events } = setup();
    const s1 = makeSession('s1');
    const s2 = makeSession('s2');

    registry.onStarted(s1);
    registry.onStarted(s2); // start-new-first order

    expect(registry.registryGeneration).toBe(3);
    expect(registry.getSessionGeneration('s1')).toBeUndefined();
    expect(registry.getSessionGeneration('s2')).toBe(3);
    expect(registry.requireExact({ sessionId: 's2', sessionGeneration: 3 })).toBe(s2);
    expect(catchError(() => registry.requireExact({ sessionId: 's1', sessionGeneration: 1 })).errorCode)
      .toBe('NoActiveSession');

    const types = events().map(event => event.type as SessionLifecycleEventType);
    expect(types).toEqual(['session.started', 'session.terminated', 'session.started', 'session.replaced']);
    expect(events()[3]).toMatchObject({
      type: 'session.replaced',
      sessionId: 's2',
      sessionGeneration: 3,
      data: { previousSessionId: 's1' },
    });
  });

  it('pairs terminate-first order into one replacement event', () => {
    const { registry, events, advance } = setup();
    const s1 = makeSession('s1');
    const s2 = makeSession('s2');

    registry.onStarted(s1);
    registry.onTerminated(s1);
    advance(50);
    registry.onStarted(s2);

    expect(registry.registryGeneration).toBe(3);
    const types = events().map(event => event.type as SessionLifecycleEventType);
    expect(types).toEqual(['session.started', 'session.terminated', 'session.started', 'session.replaced']);
    expect(events()[3]).toMatchObject({ sessionId: 's2', data: { previousSessionId: 's1' } });
  });

  it('does not pair a termination with a start outside the pairing window', () => {
    const { registry, events, advance } = setup();
    const s1 = makeSession('s1');
    const s2 = makeSession('s2');

    registry.onStarted(s1);
    registry.onTerminated(s1);
    advance(10_001);
    registry.onStarted(s2);

    const types = events().map(event => event.type);
    expect(types).toEqual(['session.started', 'session.terminated', 'session.started']);
  });

  it('invalidates stale async completions after restart with SessionChanged data', () => {
    const { registry } = setup();
    const s1 = makeSession('s1');

    registry.onStarted(s1);
    const staleRef = { sessionId: 's1', sessionGeneration: 1 };
    registry.onRestarted(s1);

    expect(registry.registryGeneration).toBe(2);
    expect(registry.getSessionGeneration('s1')).toBe(2);
    expect(registry.requireExact({ sessionId: 's1', sessionGeneration: 2 })).toBe(s1);

    const error = catchError(() => registry.requireExact(staleRef));
    expect(error.errorCode).toBe('SessionChanged');
    expect(error.data).toEqual({ expectedGeneration: 1, actualGeneration: 2 });

    expect(registry.snapshot()[0]).toMatchObject({ sessionId: 's1', sessionGeneration: 2, phase: 'starting' });
  });

  it('rejects a generation mismatch on a live session without touching the target', () => {
    const { registry } = setup();
    const s1 = makeSession('s1');
    registry.onStarted(s1);

    const error = catchError(() => registry.requireExact({ sessionId: 's1', sessionGeneration: 9 }));
    expect(error.errorCode).toBe('SessionChanged');
    expect(error.data).toEqual({ expectedGeneration: 9, actualGeneration: 1 });
  });

  it('moves the session to terminating on owner loss with exactly one increment', () => {
    const { registry, events } = setup();
    const s1 = makeSession('s1');

    registry.onStarted(s1);
    registry.markOwnerLost(s1);

    expect(registry.registryGeneration).toBe(2);
    expect(registry.getSessionGeneration('s1')).toBeUndefined();
    expect(registry.currentRef()).toBeUndefined();
    expect(catchError(() => registry.requireExact({ sessionId: 's1', sessionGeneration: 1 })).errorCode)
      .toBe('SessionTerminating');
    expect(registry.snapshot()[0]).toMatchObject({ phase: 'terminating' });

    // A second loss report must not double-increment.
    registry.markOwnerLost(s1);
    expect(registry.registryGeneration).toBe(2);

    registry.onTerminated(s1);
    expect(registry.registryGeneration).toBe(3);
    expect(registry.snapshot({ includeTerminated: true })[0]).toMatchObject({
      sessionId: 's1',
      phase: 'terminated',
      sessionGeneration: 1,
    });

    const types = events().map(event => event.type);
    expect(types).toEqual(['session.started', 'session.phaseChanged', 'session.terminated']);
    expect(events()[1].data).toEqual({ phase: 'terminating', previousPhase: 'starting' });
  });

  it('merges DAP state patches without incrementing the generation', () => {
    const { registry, events } = setup();
    const s1 = makeSession('s1');
    const capability: Capability = { name: 'flash', available: true };

    registry.onStarted(s1);
    registry.update(s1, {
      phase: 'halted',
      targetState: 'halted',
      ownerKind: 'jlink-native',
      probe: 'jlink',
      transport: 'native',
      stopReason: 'breakpoint',
      pc: '0x08001234',
      threadId: 1,
      location: { path: 'C:\\work\\main.c', line: 42, column: 3 },
      capabilities: [capability],
    });

    expect(registry.registryGeneration).toBe(1);
    expect(registry.requireExact({ sessionId: 's1', sessionGeneration: 1 })).toBe(s1);
    const snapshot = registry.snapshot()[0];
    expect(snapshot).toMatchObject({
      phase: 'halted',
      targetState: 'halted',
      owner: 'jlink-native',
      probe: 'jlink',
      transport: 'native',
      stopReason: 'breakpoint',
      pc: '0x08001234',
      threadId: 1,
      location: { path: 'C:\\work\\main.c', line: 42, column: 3 },
      capabilities: [{ name: 'flash', available: true }],
    });
    expect(events().map(event => event.type)).toEqual(['session.started', 'session.phaseChanged']);
    expect(events()[1]).toMatchObject({
      sessionGeneration: 1,
      data: { phase: 'halted', previousPhase: 'starting' },
    });

    // A patch without a phase change must not publish another phaseChanged.
    registry.update(s1, { pc: '0x08001238' });
    expect(events()).toHaveLength(2);
  });

  it('clears stale halt metadata when a patch sets stopReason/pc to null', () => {
    const { registry } = setup();
    const s1 = makeSession('s1');
    registry.onStarted(s1);
    registry.update(s1, { phase: 'halted', targetState: 'halted', stopReason: 'pause', pc: '0x08001234' });
    expect(registry.snapshot()[0]).toMatchObject({ stopReason: 'pause', pc: '0x08001234' });

    registry.update(s1, { phase: 'running', targetState: 'running', stopReason: null, pc: null });
    const snapshot = registry.snapshot()[0];
    expect(snapshot).toMatchObject({ phase: 'running', targetState: 'running' });
    expect(snapshot.stopReason).toBeUndefined();
    expect(snapshot.pc).toBeUndefined();
  });

  it('ignores patches for unknown session objects', () => {
    const { registry } = setup();
    const s1 = makeSession('s1');
    registry.onStarted(s1);
    registry.update(makeSession('s1'), { phase: 'halted' }); // different object
    expect(registry.snapshot()[0]).toMatchObject({ phase: 'starting' });
  });

  it('refuses lifecycle phases through update() so transitions stay generation-fenced', () => {
    const { registry, events } = setup();
    const s1 = makeSession('s1');
    registry.onStarted(s1);

    // Target-driven fields still apply, but terminating/terminated/error
    // phases must go through markOwnerLost/onTerminated, which increment.
    registry.update(s1, { phase: 'terminating', targetState: 'disconnected' });
    expect(registry.snapshot()[0]).toMatchObject({ phase: 'starting', targetState: 'disconnected' });
    expect(registry.registryGeneration).toBe(1);
    expect(registry.getSessionGeneration('s1')).toBe(1);
    expect(registry.requireExact({ sessionId: 's1', sessionGeneration: 1 })).toBe(s1);

    registry.update(s1, { phase: 'terminated' });
    registry.update(s1, { phase: 'error' });
    expect(registry.snapshot()[0]).toMatchObject({ phase: 'starting' });
    expect(events()).toHaveLength(1); // only session.started
  });

  it('tolerates a disposed event hub without throwing from lifecycle callbacks', () => {
    const { hub, registry } = setup();
    const s1 = makeSession('s1');

    hub.dispose();
    expect(() => registry.onStarted(s1)).not.toThrow();
    expect(() => registry.onTerminated(s1)).not.toThrow();
    expect(registry.registryGeneration).toBe(2);
    expect(registry.getSessionGeneration('s1')).toBeUndefined();
  });

  it('bounds the terminated history and keeps the newest records', () => {
    const { registry } = setup({ maxTerminatedRecords: 2 });
    for (let i = 1; i <= 3; i += 1) {
      const session = makeSession(`s${i}`);
      registry.onStarted(session);
      registry.onTerminated(session);
    }

    const terminated = registry.snapshot({ includeTerminated: true });
    expect(terminated.map(snapshot => snapshot.sessionId)).toEqual(['s2', 's3']);
    expect(registry.registryGeneration).toBe(6);
    expect(registry.getSessionGeneration('s1')).toBeUndefined();
  });

  it('keeps registryGeneration monotonic across the full lifecycle', () => {
    const { registry } = setup();
    const s1 = makeSession('s1');
    const s2 = makeSession('s2');

    registry.onStarted(s1); // 1
    registry.update(s1, { phase: 'halted', targetState: 'halted' }); // no increment
    registry.markOwnerLost(s1); // 2
    registry.onTerminated(s1); // 3
    registry.onStarted(s2); // 4
    registry.onRestarted(s2); // 5
    registry.onTerminated(s2); // 6

    expect(registry.registryGeneration).toBe(6);
  });

  it('exposes the handshake session snapshot only while a session exists', () => {
    const { registry } = setup();
    expect(registry.currentSnapshot()).toBeUndefined();

    const s1 = makeSession('s1');
    registry.onStarted(s1);
    expect(registry.currentSnapshot()).toMatchObject({ sessionId: 's1', sessionGeneration: 1, phase: 'starting' });

    registry.onTerminated(s1);
    expect(registry.currentSnapshot()).toBeUndefined();
  });
});
