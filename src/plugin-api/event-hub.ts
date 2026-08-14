// Orbit Automation API v1 — bounded event ring (plan §2.5, Task 3).
//
// Task 3 connects only session lifecycle publications. The SSE transport
// (GET /v1/events, Last-Event-ID replay, slow-consumer cutoff, 15 s heartbeat)
// lands in Task 11 and consumes this ring. The ring itself is frozen here:
//
// - event ids are instance-local, monotonically increasing 64-bit decimal
//   strings, zero-padded so string order equals numeric order;
// - publication order is the wire order;
// - the ring retains at most 1,000 events and at most 8 MiB of serialized
//   events; the oldest event is evicted first;
// - a single event may not exceed 256 KiB.
//
// The hub is `vscode`-free: instance/project identity is injected so unit
// tests do not need the Extension Host.

export const MAX_RING_EVENTS = 1000;
export const MAX_RING_BYTES = 8 * 1024 * 1024;
export const MAX_EVENT_BYTES = 256 * 1024;
const EVENT_ID_DIGITS = 16;

export interface EventHubOptions {
  instanceId(): string;
  projectId(): string;
  maxEvents?: number;
  maxRingBytes?: number;
  now?(): number;
}

/**
 * Wire shape of one published event (plan §2.5 `data:` line). Timestamps and
 * event ids are decimal strings, never JSON numbers; session fields appear
 * only on session-scoped events.
 */
export interface AutomationEvent {
  /** Monotonic instance-local 64-bit decimal id, zero-padded to 16 digits. */
  eventId: string;
  instanceId: string;
  projectId: string;
  sessionId?: string;
  sessionGeneration?: number;
  /** Epoch-ms decimal string. */
  timestamp: string;
  type: string;
  data?: Record<string, unknown>;
}

/** Session lifecycle event types Task 3 publishes (§1.6). */
export type SessionLifecycleEventType =
  | 'session.started'
  | 'session.phaseChanged'
  | 'session.terminated'
  | 'session.replaced';

export interface EventHubPublishPayload {
  sessionId?: string;
  sessionGeneration?: number;
  data?: Record<string, unknown>;
}

export interface EventReplay {
  events: AutomationEvent[];
  /** True when the requested Last-Event-ID has left the ring (§2.5 events.reset). */
  reset: boolean;
  latestEventId: string | undefined;
}

export type EventHubListener = (event: AutomationEvent) => void;

export class EventHub {
  private readonly ring: AutomationEvent[] = [];
  private ringBytes = 0;
  private sequence = 0n;
  private disposed = false;
  private readonly listeners = new Set<EventHubListener>();

  constructor(private readonly options: EventHubOptions) {}

  /** Appends one event to the ring and returns it. Throws when the hub is disposed. */
  publish(type: string, payload: EventHubPublishPayload = {}): AutomationEvent {
    if (this.disposed) throw new Error('EventHub is disposed');
    if (typeof type !== 'string' || type.trim() === '') {
      throw new Error('Automation event type is required');
    }
    this.sequence += 1n;
    const event: AutomationEvent = {
      eventId: this.sequence.toString().padStart(EVENT_ID_DIGITS, '0'),
      instanceId: this.options.instanceId(),
      projectId: this.options.projectId(),
      timestamp: String(this.now()),
      type,
    };
    if (payload.sessionId !== undefined) event.sessionId = payload.sessionId;
    if (payload.sessionGeneration !== undefined) event.sessionGeneration = payload.sessionGeneration;
    if (payload.data !== undefined) {
      // The ring is the durable history (SSE replay reads it later): store a
      // deep copy so a publisher mutating its own object cannot corrupt
      // already-published events.
      event.data = JSON.parse(JSON.stringify(payload.data)) as Record<string, unknown>;
    }

    const bytes = Buffer.byteLength(JSON.stringify(event), 'utf8');
    if (bytes > MAX_EVENT_BYTES) {
      this.sequence -= 1n;
      throw new Error(`Automation event ${type} exceeds the 256 KiB single-event limit`);
    }
    this.ring.push(event);
    this.ringBytes += bytes;
    this.evictOverBudget();

    // Deliver to live subscribers (SSE connections) after the ring append, so
    // a subscriber can safely call eventsAfter() with the same event id. A
    // listener that throws must not break other listeners or the publisher.
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(event);
      } catch {
        // A faulty subscriber is isolated; the ring is already durable.
      }
    }
    return event;
  }

  /**
   * Subscribes to newly published events and returns an idempotent unsubscribe
   * function. Live delivery is best-effort: the ring remains the durable source
   * of truth, so a dropped live event is still recoverable via replay.
   */
  subscribe(listener: EventHubListener): () => void {
    this.listeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.listeners.delete(listener);
    };
  }

  /** Number of live subscribers (diagnostics/SSE connection accounting). */
  subscriberCount(): number {
    return this.listeners.size;
  }

  /**
   * Replays events after the given event id (exclusive). Without a cursor it
   * returns the whole ring. `reset: true` means the cursor left the retention
   * window and the caller must resynchronize from snapshots (§2.5).
   */
  eventsAfter(lastEventId?: string): EventReplay {
    if (this.disposed) {
      return { events: [], reset: false, latestEventId: this.latestEventId() };
    }
    if (lastEventId === undefined) {
      return { events: [...this.ring], reset: false, latestEventId: this.latestEventId() };
    }
    const index = this.ring.findIndex(event => event.eventId === lastEventId);
    if (index === -1) {
      return { events: [], reset: true, latestEventId: this.latestEventId() };
    }
    return { events: this.ring.slice(index + 1), reset: false, latestEventId: this.latestEventId() };
  }

  latestEventId(): string | undefined {
    return this.ring.length > 0 ? this.ring[this.ring.length - 1].eventId : undefined;
  }

  eventCount(): number {
    return this.ring.length;
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  /** True when the cursor is still inside the retention window. */
  hasEvent(eventId: string): boolean {
    return this.ring.some(event => event.eventId === eventId);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.ring.length = 0;
    this.ringBytes = 0;
  }

  private evictOverBudget(): void {
    const maxEvents = this.options.maxEvents ?? MAX_RING_EVENTS;
    const maxBytes = this.options.maxRingBytes ?? MAX_RING_BYTES;
    while (this.ring.length > maxEvents || (this.ringBytes > maxBytes && this.ring.length > 1)) {
      const oldest = this.ring.shift()!;
      this.ringBytes -= Buffer.byteLength(JSON.stringify(oldest), 'utf8');
    }
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }
}
