// EventHub: bounded ring, monotonic decimal event ids, byte budgets and
// replay semantics (plan Task 3, §2.5).
import { describe, expect, it } from 'vitest';
import {
  AutomationEvent,
  EventHub,
  MAX_EVENT_BYTES,
  MAX_RING_BYTES,
  MAX_RING_EVENTS,
} from './event-hub';

function makeHub(overrides: {
  maxEvents?: number;
  maxRingBytes?: number;
  now?: () => number;
} = {}) {
  const now = overrides.now ?? (() => 1700000000000);
  return {
    hub: new EventHub({
      instanceId: () => 'inst-1',
      projectId: () => 'sha256:project-1',
      maxEvents: overrides.maxEvents,
      maxRingBytes: overrides.maxRingBytes,
      now,
    }),
    now,
  };
}

describe('EventHub bounded ring', () => {
  it('publishes monotonically increasing zero-padded decimal event ids in wire order', () => {
    let clock = 1700000000000;
    const { hub } = makeHub({ now: () => clock });
    const first = hub.publish('session.started', { sessionId: 's1', sessionGeneration: 1, data: { phase: 'starting' } });
    clock += 1;
    const second = hub.publish('session.phaseChanged', { sessionId: 's1', sessionGeneration: 1, data: { phase: 'halted' } });

    expect(first.eventId).toBe('0000000000000001');
    expect(second.eventId).toBe('0000000000000002');
    expect(first.timestamp).toBe(String(1700000000000));
    expect(second.timestamp).toBe(String(1700000000001));
    expect(second.instanceId).toBe('inst-1');
    expect(second.projectId).toBe('sha256:project-1');
    expect(second.type).toBe('session.phaseChanged');
    expect(second.sessionId).toBe('s1');
    expect(second.sessionGeneration).toBe(1);
    expect(second.data).toEqual({ phase: 'halted' });

    // String order equals numeric order for zero-padded ids.
    expect(first.eventId < second.eventId).toBe(true);
  });

  it('omits session fields on non-session events', () => {
    const { hub } = makeHub();
    const event = hub.publish('request.completed', { data: { requestId: 'req-1' } });
    expect(event.sessionId).toBeUndefined();
    expect(event.sessionGeneration).toBeUndefined();
  });

  it('stores a deep copy so later publisher mutations cannot corrupt the ring', () => {
    const { hub } = makeHub();
    const data = { phase: 'starting', nested: { line: 1 } };
    const event = hub.publish('session.started', { sessionId: 's1', data });

    data.phase = 'halted';
    data.nested.line = 99;

    expect(event.data).toEqual({ phase: 'starting', nested: { line: 1 } });
    expect(hub.eventsAfter(undefined).events[0].data).toEqual({ phase: 'starting', nested: { line: 1 } });
  });

  it('rejects an empty event type', () => {
    const { hub } = makeHub();
    expect(() => hub.publish('   ')).toThrowError(/type is required/);
    expect(hub.eventCount()).toBe(0);
  });

  it('evicts the oldest event when the ring exceeds the event-count cap', () => {
    const { hub } = makeHub({ maxEvents: 3 });
    for (let i = 0; i < 5; i += 1) hub.publish('session.phaseChanged', { sessionId: 's1' });

    expect(hub.eventCount()).toBe(3);
    expect(hub.eventsAfter(undefined).events.map(event => event.eventId)).toEqual([
      '0000000000000003',
      '0000000000000004',
      '0000000000000005',
    ]);
    expect(hub.latestEventId()).toBe('0000000000000005');
  });

  it('evicts the oldest event when serialized bytes exceed the ring budget', () => {
    const { hub } = makeHub({ maxRingBytes: 300 });
    const big = { blob: 'x'.repeat(100) };
    hub.publish('session.started', { sessionId: 's1', data: big });
    hub.publish('session.started', { sessionId: 's1', data: big });
    hub.publish('session.started', { sessionId: 's1', data: big });

    // 300-byte budget cannot hold three ~150-byte events; oldest is evicted.
    expect(hub.eventCount()).toBeLessThan(3);
    expect(hub.eventCount()).toBeGreaterThan(0);
    expect(hub.latestEventId()).toBe('0000000000000003');
  });

  it('never evicts the only event even when it alone exceeds the ring budget', () => {
    const { hub } = makeHub({ maxRingBytes: 10 });
    hub.publish('session.started', { sessionId: 's1', data: { blob: 'x'.repeat(200) } });
    expect(hub.eventCount()).toBe(1);
  });

  it('rejects a single event that exceeds the 256 KiB single-event limit', () => {
    const { hub } = makeHub();
    expect(() => hub.publish('session.started', { data: { blob: 'x'.repeat(MAX_EVENT_BYTES) } }))
      .toThrowError(/256 KiB/);
    expect(hub.eventCount()).toBe(0);
    // The rejected event must not consume a sequence number.
    expect(hub.publish('session.started', {}).eventId).toBe('0000000000000001');
  });

  it('replays events after a Last-Event-ID and flags a reset outside the window', () => {
    const { hub } = makeHub({ maxEvents: 2 });
    const a = hub.publish('session.started', { sessionId: 's1' });
    hub.publish('session.phaseChanged', { sessionId: 's1' });
    hub.publish('session.terminated', { sessionId: 's1' }); // evicts a

    const replay = hub.eventsAfter(a.eventId);
    expect(replay.reset).toBe(true);
    expect(replay.events).toEqual([]);
    expect(replay.latestEventId).toBe('0000000000000003');

    const tail = hub.eventsAfter('0000000000000002');
    expect(tail.reset).toBe(false);
    expect(tail.events.map(event => event.type)).toEqual(['session.terminated']);
  });

  it('supports a cursorless full-ring replay and unknown-cursor reset', () => {
    const { hub } = makeHub();
    hub.publish('session.started', { sessionId: 's1' });

    expect(hub.eventsAfter(undefined).events).toHaveLength(1);
    expect(hub.eventsAfter('0000000000000999')).toMatchObject({ reset: true, events: [] });
    expect(hub.hasEvent('0000000000000001')).toBe(true);
    expect(hub.hasEvent('0000000000000999')).toBe(false);
  });

  it('stops publishing after dispose and clears the ring', () => {
    const { hub } = makeHub();
    const event = hub.publish('session.started', { sessionId: 's1' });
    hub.dispose();
    expect(hub.isDisposed()).toBe(true);
    expect(() => hub.publish('session.started', { sessionId: 's1' })).toThrowError(/disposed/);
    expect(hub.eventCount()).toBe(0);
    expect(hub.eventsAfter(undefined)).toEqual({ events: [], reset: false, latestEventId: undefined });
    expect(event.eventId).toBe('0000000000000001');
  });

  it('stays within the frozen production budgets', () => {
    const { hub } = makeHub();
    expect(MAX_RING_EVENTS).toBe(1000);
    expect(MAX_RING_BYTES).toBe(8 * 1024 * 1024);
    expect(MAX_EVENT_BYTES).toBe(256 * 1024);
    // Default construction uses the production caps.
    expect(hub.eventCount()).toBe(0);
    const events: AutomationEvent[] = [];
    for (let i = 0; i < MAX_RING_EVENTS + 5; i += 1) {
      events.push(hub.publish('session.phaseChanged', { sessionId: 's1' }));
    }
    expect(hub.eventCount()).toBe(MAX_RING_EVENTS);
    expect(hub.latestEventId()).toBe(events[events.length - 1].eventId);
  });
});
