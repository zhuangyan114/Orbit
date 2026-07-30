import {
  readSystemViewVarUint,
  type SystemViewEvent,
} from './systemview-protocol';

export interface SystemViewApiSpan {
  readonly functionId: number;
  readonly contextKey: string;
  readonly startTimestamp: number;
  readonly endTimestamp?: number;
  readonly arguments: readonly number[];
  readonly argumentsRaw: Uint8Array;
  readonly returnValue?: number;
  readonly complete: boolean;
}

export interface SystemViewApiDiagnostic {
  readonly code: 'unmatched-end' | 'missing-exit' | 'incomplete-at-gap' | 'incomplete-at-end';
  readonly message: string;
  readonly timestamp?: number;
  readonly functionId?: number;
}

export interface SystemViewApiSnapshot {
  readonly spans: readonly SystemViewApiSpan[];
  readonly diagnostics: readonly SystemViewApiDiagnostic[];
}

interface OpenApiSpan {
  readonly functionId: number;
  readonly contextKey: string;
  readonly startTimestamp: number;
  readonly arguments: readonly number[];
  readonly argumentsRaw: Uint8Array;
}

export interface SystemViewApiSpanTrackerOptions {
  /** Defaults to all OS-defined event IDs (32..1023). */
  readonly isApiEnter?: (event: SystemViewEvent) => boolean;
}

/**
 * Tracks API enter/END_CALL pairs without assuming a private OS event schema.
 * Raw arguments are retained; scalar varuint arguments are additionally
 * exposed when the complete payload consists of varuints.
 */
export class SystemViewApiSpanTracker {
  private readonly stacks = new Map<string, OpenApiSpan[]>();
  private readonly spans: SystemViewApiSpan[] = [];
  private readonly diagnostics: SystemViewApiDiagnostic[] = [];
  private readonly isApiEnter: (event: SystemViewEvent) => boolean;

  public constructor(options: SystemViewApiSpanTrackerOptions = {}) {
    this.isApiEnter = options.isApiEnter ?? (event => event.eventClass === 'os');
  }

  public apply(event: SystemViewEvent, contextKey = 'unknown'): void {
    if (this.isApiEnter(event)) {
      const stack = this.stacks.get(contextKey) ?? [];
      const decoded = decodeVarUintList(event.rawData);
      stack.push({
        functionId: event.eventId,
        contextKey,
        startTimestamp: event.timestamp,
        arguments: decoded ?? [],
        argumentsRaw: event.rawData.slice(),
      });
      this.stacks.set(contextKey, stack);
      return;
    }

    if (event.payload.kind !== 'end-call') return;
    const endCall = event.payload;
    const stack = this.stacks.get(contextKey) ?? [];
    const matchingIndex = findLastIndex(stack, span => span.functionId === endCall.functionId);
    if (matchingIndex < 0) {
      this.diagnostics.push({
        code: 'unmatched-end',
        message: `END_CALL for function ${endCall.functionId} has no open API span`,
        timestamp: event.timestamp,
        functionId: endCall.functionId,
      });
      return;
    }

    for (let index = stack.length - 1; index > matchingIndex; index -= 1) {
      const missing = stack.pop();
      if (!missing) continue;
      this.spans.push({
        ...missing,
        endTimestamp: event.timestamp,
        complete: false,
      });
      this.diagnostics.push({
        code: 'missing-exit',
        message: `API ${missing.functionId} was closed by a non-top END_CALL`,
        timestamp: event.timestamp,
        functionId: missing.functionId,
      });
    }
    const matched = stack.pop();
    if (!matched) return;
    this.spans.push({
      ...matched,
      endTimestamp: event.timestamp,
      ...(endCall.returnValue === undefined ? {} : { returnValue: endCall.returnValue }),
      complete: true,
    });
    if (stack.length === 0) this.stacks.delete(contextKey);
  }

  public markGap(timestamp: number | undefined, reason: string): void {
    this.closeOpen(timestamp, reason, 'incomplete-at-gap');
  }

  public finish(timestamp?: number): void {
    this.closeOpen(timestamp, 'stream end', 'incomplete-at-end');
  }

  public snapshot(): SystemViewApiSnapshot {
    return {
      spans: [...this.spans],
      diagnostics: [...this.diagnostics],
    };
  }

  public reset(): void {
    this.stacks.clear();
    this.spans.length = 0;
    this.diagnostics.length = 0;
  }

  private closeOpen(
    timestamp: number | undefined,
    reason: string,
    code: 'incomplete-at-gap' | 'incomplete-at-end',
  ): void {
    for (const [contextKey, stack] of this.stacks) {
      while (stack.length > 0) {
        const open = stack.pop();
        if (!open) continue;
        this.spans.push({
          ...open,
          ...(timestamp === undefined ? {} : { endTimestamp: timestamp }),
          complete: false,
        });
        this.diagnostics.push({
          code,
          message: `API ${open.functionId} ended at data gap: ${reason}`,
          timestamp,
          functionId: open.functionId,
        });
      }
      this.stacks.delete(contextKey);
    }
  }
}

function decodeVarUintList(bytes: Uint8Array): readonly number[] | undefined {
  const values: number[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const value = readSystemViewVarUint(bytes, offset);
    if (!value.ok || value.nextOffset > bytes.length) return undefined;
    values.push(value.value);
    offset = value.nextOffset;
  }
  return values;
}

function findLastIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index])) return index;
  }
  return -1;
}
