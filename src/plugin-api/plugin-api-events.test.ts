// SSE transport and event ring (plan Task 11, §2.5): wire framing, live
// subscribe/unsubscribe, per-connection filter, slow-consumer reset+close, and
// disconnect cleanup. All of this is `vscode`-free.
import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import { AutomationEvent, EventHub } from './event-hub';
import {
  MAX_SSE_CONNECTIONS,
  SseConnection,
  serializeSseEvent,
} from './sse-stream';

function makeHub() {
  return new EventHub({
    instanceId: () => 'inst-1',
    projectId: () => 'sha256:project-1',
    now: () => 1700000000000,
  });
}

function makeEvent(hub: EventHub, type: string, data?: Record<string, unknown>): AutomationEvent {
  return hub.publish(type, { sessionId: 's1', sessionGeneration: 1, data });
}

class FakeResponse extends EventEmitter {
  writable = true;
  statusCode = 0;
  headers: Record<string, unknown> = {};
  chunks: string[] = [];

  writeHead(code: number, headers: Record<string, unknown>) {
    this.statusCode = code;
    this.headers = headers;
  }

  write(chunk: string) {
    this.chunks.push(String(chunk));
    return true;
  }

  end() {
    this.writable = false;
  }
}

function makeConnection(overrides: {
  filter?: ReadonlySet<string>;
  replay?: AutomationEvent[];
  slowConsumerBytes?: number;
  buildResetEvent?: () => AutomationEvent;
} = {}) {
  const hub = makeHub();
  const res = new FakeResponse();
  let unsubscribed = 0;
  const connection = new SseConnection({
    res: res as unknown as import('http').ServerResponse,
    filter: overrides.filter,
    replay: overrides.replay ?? [],
    slowConsumerBytes: overrides.slowConsumerBytes,
    buildResetEvent: overrides.buildResetEvent,
    subscribe: () => {
      unsubscribed += 1;
      return () => {};
    },
  });
  connection.start();
  return { hub, res, connection, unsubscribed: () => unsubscribed };
}

describe('serializeSseEvent', () => {
  it('frames id/event/data lines with the full AutomationEvent JSON', () => {
    const hub = makeHub();
    const event = makeEvent(hub, 'target.stopped', { reason: 'breakpoint' });
    const frame = serializeSseEvent(event);
    expect(frame).toBe(
      `id: ${event.eventId}\r\n`
      + `event: target.stopped\r\n`
      + `data: ${JSON.stringify(event)}\r\n\r\n`,
    );
  });
});

describe('EventHub live subscription', () => {
  it('delivers newly published events to subscribers and stops after unsubscribe', () => {
    const hub = makeHub();
    const seen: string[] = [];
    const unsubscribe = hub.subscribe(event => seen.push(event.type));
    hub.publish('watch.changed', { data: {} });
    hub.publish('timeline.changed', { data: {} });
    unsubscribe();
    hub.publish('record.started', { data: {} });
    expect(seen).toEqual(['watch.changed', 'timeline.changed']);
    expect(hub.subscriberCount()).toBe(0);
  });

  it('isolates a throwing subscriber from other subscribers', () => {
    const hub = makeHub();
    const seen: string[] = [];
    hub.subscribe(() => { throw new Error('boom'); });
    hub.subscribe(event => seen.push(event.type));
    expect(() => hub.publish('watch.changed', { data: {} })).not.toThrow();
    expect(seen).toEqual(['watch.changed']);
  });
});

describe('SseConnection', () => {
  it('writes SSE headers and replays the initial events in order', () => {
    const hub = makeHub();
    const a = makeEvent(hub, 'session.started');
    const b = makeEvent(hub, 'target.stopped');
    const { res } = makeConnection({ replay: [a, b] });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(res.chunks).toEqual([serializeSseEvent(a), serializeSseEvent(b)]);
  });

  it('filters live events by type when a filter set is provided', () => {
    const hub = makeHub();
    const seen: string[] = [];
    const res = new FakeResponse();
    const connection = new SseConnection({
      res: res as unknown as import('http').ServerResponse,
      filter: new Set(['watch.changed']),
      replay: [],
      subscribe: listener => hub.subscribe(listener),
    });
    connection.start();
    hub.publish('watch.changed', { data: {} });
    hub.publish('timeline.changed', { data: {} });
    seen.push(...res.chunks.map(chunk => (JSON.parse(chunk.split('\ndata: ')[1]) as AutomationEvent).type));
    expect(seen).toEqual(['watch.changed']);
  });

  it('filters replayed events too, not only live events', () => {
    const hub = makeHub();
    const a = makeEvent(hub, 'session.started');
    const b = makeEvent(hub, 'watch.changed');
    const c = makeEvent(hub, 'rtt.stateChanged');
    const { res } = makeConnection({ replay: [a, b, c], filter: new Set(['watch.changed']) });
    const types = res.chunks.map(chunk => (JSON.parse(chunk.split('\ndata: ')[1]) as AutomationEvent).type);
    expect(types).toEqual(['watch.changed']);
  });

  it('closes on socket close and clears the subscription', () => {
    const hub = makeHub();
    const res = new FakeResponse();
    const connection = new SseConnection({
      res: res as unknown as import('http').ServerResponse,
      replay: [],
      subscribe: listener => hub.subscribe(listener),
    });
    connection.start();
    res.emit('close');
    expect(connection.isClosed()).toBe(true);
    expect(hub.subscriberCount()).toBe(0);
  });

  it('sends one events.reset and closes when a slow consumer exceeds the byte budget', () => {
    const hub = makeHub();
    const event = makeEvent(hub, 'session.started', { blob: 'x'.repeat(200) });
    const reset = {
      eventId: event.eventId,
      instanceId: 'inst-1',
      projectId: 'sha256:project-1',
      timestamp: '1700000000000',
      type: 'events.reset',
      data: { latestEventId: event.eventId },
    } as AutomationEvent;
    const res = new FakeResponse();
    const connection = new SseConnection({
      res: res as unknown as import('http').ServerResponse,
      replay: [event],
      slowConsumerBytes: 10,
      buildResetEvent: () => reset,
      subscribe: () => () => {},
    });
    connection.start();
    expect(res.chunks.some(chunk => chunk.includes('event: events.reset'))).toBe(true);
    expect(connection.isClosed()).toBe(true);
  });

  it('freezes the production SSE limits', () => {
    expect(MAX_SSE_CONNECTIONS).toBe(8);
  });
});
