// Orbit Automation API v1 — SSE wire transport (plan §2.5, Task 11).
//
// This module is `vscode`-free so the wire framing and the per-connection
// lifecycle can be unit tested without the Extension Host or a live socket.
// The PluginApiServer owns the connection set and enforces the 8-connection
// cap; each SseConnection owns one socket's replay, filter, heartbeat and the
// 1 MiB slow-consumer cutoff.
//
// Wire contract (§2.5):
// - `id:` and `event:` mirror the event's eventId/type; `data:` carries the
//   full AutomationEvent JSON;
// - a 15 s heartbeat comment (a line starting with `:`) keeps the socket alive;
// - a slow consumer whose unflushed bytes exceed 1 MiB receives one
//   `events.reset` event (built by the server from snapshots) and is closed.

import * as http from 'http';
import { AutomationEvent, EventHubListener } from './event-hub';

export const MAX_SSE_CONNECTIONS = 8;
export const SSE_HEARTBEAT_MS = 15_000;
export const SSE_SLOW_CONSUMER_BYTES = 1024 * 1024;

/** Serializes one event into a complete SSE frame (id/event/data + blank line). */
export function serializeSseEvent(event: AutomationEvent): string {
  const data = JSON.stringify(event);
  return `id: ${event.eventId}\r\nevent: ${event.type}\r\ndata: ${data}\r\n\r\n`;
}

export interface SseConnectionOptions {
  res: http.ServerResponse;
  /** Event types to deliver; `undefined` delivers every event (no filter). */
  filter?: ReadonlySet<string>;
  /** Events to replay immediately before live delivery. */
  replay: AutomationEvent[];
  /** Builds the `events.reset` event (snapshot + latestEventId) on reset/cutoff. */
  buildResetEvent?: () => AutomationEvent | undefined;
  subscribe: (listener: EventHubListener) => () => void;
  heartbeatMs?: number;
  slowConsumerBytes?: number;
}

export class SseConnection {
  private readonly res: http.ServerResponse;
  private readonly filter?: ReadonlySet<string>;
  private readonly subscribe: (listener: EventHubListener) => () => void;
  private readonly heartbeatMs: number;
  private readonly slowConsumerBytes: number;
  private readonly buildResetEvent?: () => AutomationEvent | undefined;
  private unsubscribe: (() => void) | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private unflushedBytes = 0;
  private closed = false;
  private resetSent = false;

  constructor(options: SseConnectionOptions) {
    this.res = options.res;
    this.filter = options.filter;
    this.subscribe = options.subscribe;
    this.heartbeatMs = options.heartbeatMs ?? SSE_HEARTBEAT_MS;
    this.slowConsumerBytes = options.slowConsumerBytes ?? SSE_SLOW_CONSUMER_BYTES;
    this.buildResetEvent = options.buildResetEvent;
    this.writeHead();
    for (const event of options.replay) this.write(event);
  }

  /** Begins live delivery, the heartbeat and disconnect cleanup. */
  start(): void {
    if (this.closed) return;
    this.unsubscribe = this.subscribe(event => this.onEvent(event));
    this.armHeartbeat();
    this.res.on('close', () => this.close());
    this.res.on('drain', () => {
      this.unflushedBytes = 0;
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
    try {
      this.res.end();
    } catch {
      // The socket may already be destroyed; ending again is harmless.
    }
  }

  isClosed(): boolean {
    return this.closed;
  }

  private onEvent(event: AutomationEvent): void {
    if (this.closed) return;
    if (this.filter && !this.filter.has(event.type)) return;
    this.write(event);
  }

  private write(event: AutomationEvent): void {
    if (this.closed) return;
    const frame = serializeSseEvent(event);
    const bytes = Buffer.byteLength(frame, 'utf8');
    this.unflushedBytes += bytes;
    if (this.unflushedBytes > this.slowConsumerBytes) {
      this.sendResetAndClose();
      return;
    }
    this.res.write(frame);
  }

  private sendResetAndClose(): void {
    if (this.resetSent) {
      this.close();
      return;
    }
    this.resetSent = true;
    // §2.5: send `events.reset` only if the socket can still accept a write.
    if (typeof this.res.writable === 'boolean' && !this.res.writable) {
      this.close();
      return;
    }
    const reset = this.buildResetEvent?.();
    if (reset) {
      try {
        this.res.write(serializeSseEvent(reset));
      } catch {
        // A dead socket must not throw out of the event path.
      }
    }
    this.close();
  }

  private writeHead(): void {
    this.res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
  }

  private armHeartbeat(): void {
    if (this.heartbeatMs <= 0) return;
    this.heartbeatTimer = setInterval(() => {
      if (this.closed) return;
      try {
        this.res.write(': heartbeat\n\n');
      } catch {
        this.close();
      }
    }, this.heartbeatMs);
    // A heartbeat interval must not keep the event loop alive during dispose.
    if (typeof this.heartbeatTimer.unref === 'function') this.heartbeatTimer.unref();
  }
}
