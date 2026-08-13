// Orbit Automation API v1 — unified VS Code breakpoint service (plan Task 6).
//
// `vscode.debug.breakpoints` is the single authoritative requested set: the
// API never calls the backend directly. add/remove/update/replace go through
// `vscode.debug.addBreakpoints`/`removeBreakpoints` only, so API and user
// breakpoints stay indistinguishable in the gutter and Run and Debug view.
//
// When an Orbit session is usable, the service pulls the DAP-side verified
// snapshot (`orbitBreakpointsSnapshot`) with the exact `SessionRef` and merges
// `verified`/`slot` into the requested breakpoints. Without one, every
// breakpoint reports `verified=false` and carries no session identity (§1.8).
//
// `breakpointId` is a stable hash of the normalized path/line/column plus the
// condition/hitCondition/logMessage — never the creation source or `enabled`.
//
// All `vscode`/`crypto` access is injectable so the merge and error mapping are
// unit-testable without the Extension Host.
import * as vscode from 'vscode';
import { createHash } from 'crypto';
import {
  AutomationBreakpoint,
  AutomationError,
  BreakpointInput,
  BreakpointListData,
  BreakpointMutationData,
  SessionRef,
  SourceLocation,
} from './protocol';
import { SessionRegistry } from './session-registry';
import {
  AUTOMATION_BREAKPOINTS_COMMAND,
  AutomationBreakpointsResult,
  AutomationBreakpointSnapshot,
} from '../debug/dap-automation-protocol';

const DEFAULT_VERIFY_WAIT_MS = 5000;
const VERIFY_POLL_INTERVAL_MS = 50;
const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 1000;

export interface BreakpointServiceOptions {
  registry: SessionRegistry;
  /** vscode.debug.breakpoints seam. */
  listBreakpoints?(): readonly vscode.Breakpoint[];
  /** vscode.debug.addBreakpoints seam (receives the normalized public inputs). */
  addBreakpoints?(inputs: readonly BreakpointInput[]): Promise<void>;
  /** vscode.debug.removeBreakpoints seam (receives the exact requested objects). */
  removeBreakpoints?(breakpoints: readonly vscode.Breakpoint[]): Promise<void>;
  /** Pulls the DAP-side verified snapshot from an exact active session. */
  snapshotDap?(session: vscode.DebugSession): Promise<AutomationBreakpointsResult>;
  /** Normalizes a source path for identity/matching (case + separator fold). */
  normalizePath?(path: string): string;
  sleep?(ms: number): Promise<void>;
  now?(): number;
}

/** Internal requested-breakpoint view: opaque `ref` plus the frozen fields. */
interface RequestedBreakpoint {
  ref: vscode.Breakpoint;
  source: SourceLocation;
  enabled: boolean;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Extracts a normalized source location from a `vscode.Breakpoint` object. */
function sourceLocationOf(bp: unknown): { path: string; line: number; column?: number } | undefined {
  if (!isRecord(bp)) return undefined;
  const location = bp.location;
  if (!isRecord(location)) return undefined;
  const uri = location.uri;
  const range = location.range;
  if (!isRecord(range)) return undefined;
  const path = pathOfUri(uri);
  if (!path) return undefined;
  const start = range.start;
  if (!isRecord(start) || typeof start.line !== 'number' || !Number.isInteger(start.line)) return undefined;
  // VS Code ranges are 0-based; the frozen SourceLocation.line/column are 1-based.
  const line = start.line + 1;
  const column = typeof start.character === 'number' && Number.isInteger(start.character)
    ? start.character + 1
    : undefined;
  return { path, line, ...(column !== undefined ? { column } : {}) };
}

function pathOfUri(uri: unknown): string | undefined {
  if (!isRecord(uri)) return undefined;
  if (typeof uri.fsPath === 'string' && uri.fsPath.length > 0) return uri.fsPath;
  if (typeof uri.path === 'string' && uri.path.length > 0) return uri.path;
  return typeof uri.toString === 'function' ? String(uri.toString()) : undefined;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Constructs a vscode.Location from a frozen SourceLocation (1-based → 0-based). */
function buildLocation(input: BreakpointInput): vscode.Location {
  const source = input.source;
  const startLine = source.line - 1;
  const startChar = (source.column ?? 1) - 1;
  const endLine = (source.endLine ?? source.line) - 1;
  const endChar = (source.endColumn ?? source.column ?? 1) - 1;
  return new vscode.Location(
    vscode.Uri.file(source.path),
    new vscode.Range(new vscode.Position(startLine, startChar), new vscode.Position(endLine, endChar)),
  );
}

export class BreakpointService {
  private readonly opts: Required<BreakpointServiceOptions>;

  constructor(options: BreakpointServiceOptions) {
    const defaults: Required<BreakpointServiceOptions> = {
      registry: options.registry,
      listBreakpoints: () => vscode.debug.breakpoints,
      addBreakpoints: async inputs => {
        await vscode.debug.addBreakpoints(
          inputs.map(input =>
            new vscode.SourceBreakpoint(
              buildLocation(input),
              input.enabled,
              input.condition,
              input.hitCondition,
              input.logMessage,
            ),
          ),
        );
      },
      removeBreakpoints: async breakpoints => {
        if (breakpoints.length > 0) await vscode.debug.removeBreakpoints(breakpoints as vscode.Breakpoint[]);
      },
      snapshotDap: async session => {
        const response: unknown = await session.customRequest(AUTOMATION_BREAKPOINTS_COMMAND, {});
        return (isRecord(response) ? response : { breakpoints: [] }) as unknown as AutomationBreakpointsResult;
      },
      normalizePath: path => path.replace(/\\/g, '/').toLowerCase(),
      sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
      now: () => Date.now(),
    };
    // An explicitly `undefined` seam falls back to the default implementation,
    // so tests can replace just one seam.
    const merged: Record<string, unknown> = { ...defaults, ...options };
    for (const [key, value] of Object.entries(defaults)) {
      if (merged[key] === undefined) merged[key] = value;
    }
    this.opts = merged as unknown as Required<BreakpointServiceOptions>;
  }

  /** `orbit.breakpoints.list`: requested + DAP-verified merge, paged. */
  async list(params: { sourcePath?: string; cursor?: string; limit?: number } = {}): Promise<BreakpointListData> {
    const limit = this.clampLimit(params.limit);
    const items = this.sortItems(await this.mergeItems({ sourcePath: params.sourcePath }));
    const start = this.resolveCursorIndex(params.cursor, items);
    const slice = items.slice(start, start + limit);
    const data: BreakpointListData = { items: slice };
    if (start + limit < items.length) data.nextCursor = slice[slice.length - 1].breakpointId;
    return data;
  }

  /** `orbit.breakpoints.add`: one requested breakpoint via vscode, then DAP verify. */
  async add(
    input: BreakpointInput,
    waitForVerificationMs = DEFAULT_VERIFY_WAIT_MS,
    operationId?: string,
  ): Promise<BreakpointMutationData> {
    this.requireOperationId(operationId);
    await this.opts.addBreakpoints([input]);
    await this.waitForVerification([this.locationKey(input.source.path, input.source.line)], waitForVerificationMs);
    const items = await this.mergeItems({});
    const target = items.find(item => item.breakpointId === this.breakpointIdForInput(input));
    if (!target) {
      throw new AutomationError('InternalError', 'added breakpoint is absent from the requested set', false);
    }
    if (waitForVerificationMs > 0 && !target.verified) {
      throw new AutomationError(
        'BreakpointUnverified',
        `breakpoint ${target.breakpointId} was not verified within ${waitForVerificationMs} ms`,
        false,
        undefined,
        { breakpoint: target },
      );
    }
    return { operationId: operationId!, items: [target] };
  }

  /** `orbit.breakpoints.update`: remove the exact old object, add the new one. */
  async update(
    breakpointId: string,
    input: BreakpointInput,
    waitForVerificationMs = DEFAULT_VERIFY_WAIT_MS,
    operationId?: string,
  ): Promise<BreakpointMutationData> {
    this.requireOperationId(operationId);
    const existing = this.findRequestedById(breakpointId);
    if (!existing) {
      throw new AutomationError('BreakpointNotFound', `no requested breakpoint ${breakpointId}`, false, undefined, { breakpointId });
    }
    await this.opts.removeBreakpoints([existing.ref]);
    await this.opts.addBreakpoints([input]);
    await this.waitForVerification([this.locationKey(input.source.path, input.source.line)], waitForVerificationMs);
    const items = await this.mergeItems({});
    const target = items.find(item => item.breakpointId === this.breakpointIdForInput(input));
    if (!target) {
      throw new AutomationError('InternalError', 'updated breakpoint is absent from the requested set', false);
    }
    if (waitForVerificationMs > 0 && !target.verified) {
      throw new AutomationError(
        'BreakpointUnverified',
        `breakpoint ${target.breakpointId} was not verified within ${waitForVerificationMs} ms`,
        false,
        undefined,
        { breakpoint: target },
      );
    }
    return { operationId: operationId!, items: [target] };
  }

  /** `orbit.breakpoints.remove`: removes only the exact matching requested object. */
  async remove(breakpointId: string, operationId?: string): Promise<BreakpointMutationData> {
    this.requireOperationId(operationId);
    const existing = this.findRequestedById(breakpointId);
    if (!existing) {
      throw new AutomationError('BreakpointNotFound', `no requested breakpoint ${breakpointId}`, false, undefined, { breakpointId });
    }
    const removed = await this.toMerged(existing);
    await this.opts.removeBreakpoints([existing.ref]);
    return { operationId: operationId!, items: [removed] };
  }

  /** `orbit.breakpoints.replace`: atomic replace of one source, others untouched. */
  async replace(
    sourcePath: string,
    inputs: readonly BreakpointInput[],
    waitForVerificationMs = DEFAULT_VERIFY_WAIT_MS,
    operationId?: string,
  ): Promise<BreakpointMutationData> {
    this.requireOperationId(operationId);
    const normalizedSource = this.opts.normalizePath(sourcePath);
    for (const input of inputs) {
      if (this.opts.normalizePath(input.source.path) !== normalizedSource) {
        throw new AutomationError(
          'InvalidRequest',
          `replace input ${input.source.path} does not match sourcePath ${sourcePath}`,
          false,
          undefined,
          { sourcePath, inputPath: input.source.path },
        );
      }
    }

    const existing = this.readRequestedBreakpoints()
      .filter(bp => this.opts.normalizePath(bp.source.path) === normalizedSource);
    if (existing.length > 0) {
      await this.opts.removeBreakpoints(existing.map(bp => bp.ref));
    }
    if (inputs.length > 0) {
      await this.opts.addBreakpoints([...inputs]);
      await this.waitForVerification(
        inputs.map(input => this.locationKey(input.source.path, input.source.line)),
        waitForVerificationMs,
      );
    }

    // `replace` reports per-breakpoint verified results rather than throwing on
    // an individual unverified line (§1.3).
    const items = await this.mergeItems({ sourcePath });
    return { operationId: operationId!, items };
  }

  // --- internals -----------------------------------------------------------

  private requireOperationId(operationId: string | undefined): void {
    if (!operationId) {
      throw new AutomationError('InternalError', 'breakpoint mutation dispatched without an operationId', false);
    }
  }

  private clampLimit(limit: number | undefined): number {
    const value = limit ?? DEFAULT_PAGE_LIMIT;
    if (!Number.isFinite(value)) return DEFAULT_PAGE_LIMIT;
    return Math.max(1, Math.min(Math.floor(value), MAX_PAGE_LIMIT));
  }

  private resolveCursorIndex(cursor: string | undefined, items: AutomationBreakpoint[]): number {
    if (cursor === undefined) return 0;
    const index = items.findIndex(item => item.breakpointId === cursor);
    if (index === -1) {
      throw new AutomationError('InvalidRequest', `unknown cursor ${cursor}`, false);
    }
    return index + 1;
  }

  private sortItems(items: AutomationBreakpoint[]): AutomationBreakpoint[] {
    return [...items].sort((a, b) => {
      const pa = this.opts.normalizePath(a.source.path);
      const pb = this.opts.normalizePath(b.source.path);
      if (pa !== pb) return pa < pb ? -1 : 1;
      if (a.source.line !== b.source.line) return a.source.line - b.source.line;
      const ca = a.source.column ?? 0;
      const cb = b.source.column ?? 0;
      if (ca !== cb) return ca - cb;
      return a.breakpointId < b.breakpointId ? -1 : a.breakpointId > b.breakpointId ? 1 : 0;
    });
  }

  /** Reads and normalizes the requested source breakpoints (function/data ignored). */
  private readRequestedBreakpoints(): RequestedBreakpoint[] {
    const result: RequestedBreakpoint[] = [];
    for (const bp of this.opts.listBreakpoints()) {
      const location = sourceLocationOf(bp);
      if (!location) continue;
      const anyBp = bp as unknown as Record<string, unknown>;
      result.push({
        ref: bp,
        source: {
          path: location.path,
          line: location.line,
          ...(location.column !== undefined ? { column: location.column } : {}),
        },
        enabled: anyBp.enabled !== false,
        condition: optionalText(anyBp.condition),
        hitCondition: optionalText(anyBp.hitCondition),
        logMessage: optionalText(anyBp.logMessage),
      });
    }
    return result;
  }

  private findRequestedById(breakpointId: string): RequestedBreakpoint | undefined {
    return this.readRequestedBreakpoints().find(bp => this.breakpointId(bp) === breakpointId);
  }

  /**
   * Resolves the exact active session (if any) and its DAP verified snapshot.
   * A generation race or a snapshot failure degrades to an empty verified map —
   * reads are never forwarded past the fence.
   */
  private async resolveDap(): Promise<{ ref?: SessionRef; map: Map<string, AutomationBreakpointSnapshot> }> {
    const ref = this.opts.registry.currentRef();
    if (!ref) return { map: new Map() };
    let session: vscode.DebugSession;
    try {
      session = this.opts.registry.requireExact(ref);
    } catch {
      return { map: new Map() };
    }
    try {
      const result = await this.opts.snapshotDap(session);
      const map = new Map<string, AutomationBreakpointSnapshot>();
      for (const item of result?.breakpoints ?? []) {
        if (!item || typeof item.line !== 'number' || !Number.isInteger(item.line)) continue;
        map.set(this.locationKey(item.path, item.line), item);
      }
      return { ref, map };
    } catch {
      return { ref, map: new Map() };
    }
  }

  /** Merges the requested set with the DAP verified snapshot, optionally filtered by source. */
  private async mergeItems(filter: { sourcePath?: string } = {}): Promise<AutomationBreakpoint[]> {
    const requested = this.readRequestedBreakpoints();
    const { ref, map } = await this.resolveDap();
    const items: AutomationBreakpoint[] = [];
    for (const bp of requested) {
      if (
        filter.sourcePath !== undefined &&
        this.opts.normalizePath(bp.source.path) !== this.opts.normalizePath(filter.sourcePath)
      ) {
        continue;
      }
      items.push(this.toAutomationBreakpoint(
        bp,
        map.get(this.locationKey(bp.source.path, bp.source.line)),
        ref?.sessionId,
        ref?.sessionGeneration,
      ));
    }
    return items;
  }

  /** Merged view of a single requested breakpoint against the current DAP state. */
  private async toMerged(bp: RequestedBreakpoint): Promise<AutomationBreakpoint> {
    const { ref, map } = await this.resolveDap();
    return this.toAutomationBreakpoint(
      bp,
      map.get(this.locationKey(bp.source.path, bp.source.line)),
      ref?.sessionId,
      ref?.sessionGeneration,
    );
  }

  private toAutomationBreakpoint(
    bp: RequestedBreakpoint,
    dapEntry: AutomationBreakpointSnapshot | undefined,
    sessionId: string | undefined,
    sessionGeneration: number | undefined,
  ): AutomationBreakpoint {
    const result: AutomationBreakpoint = {
      breakpointId: this.breakpointId(bp),
      source: { ...bp.source },
      enabled: bp.enabled,
      verified: dapEntry?.verified === true,
    };
    if (bp.condition !== undefined) result.condition = bp.condition;
    if (bp.hitCondition !== undefined) result.hitCondition = bp.hitCondition;
    if (bp.logMessage !== undefined) result.logMessage = bp.logMessage;
    if (dapEntry?.slot !== undefined) result.slot = dapEntry.slot;
    if (sessionId !== undefined) result.sessionId = sessionId;
    if (sessionGeneration !== undefined) result.sessionGeneration = sessionGeneration;
    return result;
  }

  /** Polls the DAP snapshot until every target location is verified or the deadline. */
  private async waitForVerification(keys: readonly string[], waitMs: number): Promise<void> {
    if (waitMs <= 0 || keys.length === 0) return;
    const deadline = this.opts.now() + waitMs;
    while (this.opts.now() < deadline) {
      const { map } = await this.resolveDap();
      if (keys.every(key => map.has(key))) return;
      await this.opts.sleep(VERIFY_POLL_INTERVAL_MS);
    }
  }

  private locationKey(path: string, line: number): string {
    return `${this.opts.normalizePath(path)}:${line}`;
  }

  private breakpointId(bp: RequestedBreakpoint): string {
    return this.computeBreakpointId(
      bp.source.path,
      bp.source.line,
      bp.source.column,
      bp.condition,
      bp.hitCondition,
      bp.logMessage,
    );
  }

  private breakpointIdForInput(input: BreakpointInput): string {
    return this.computeBreakpointId(
      input.source.path,
      input.source.line,
      input.source.column,
      input.condition,
      input.hitCondition,
      input.logMessage,
    );
  }

  /**
   * Stable id from the normalized path/line/column plus condition/hitCondition/
   * logMessage — creation source and `enabled` are deliberately excluded.
   */
  private computeBreakpointId(
    path: string,
    line: number,
    column: number | undefined,
    condition: string | undefined,
    hitCondition: string | undefined,
    logMessage: string | undefined,
  ): string {
    const payload = [
      this.opts.normalizePath(path),
      String(line),
      column === undefined ? '' : String(column),
      condition ?? '',
      hitCondition ?? '',
      logMessage ?? '',
    ].join('\n');
    const digest = createHash('sha256').update(payload, 'utf8').digest('hex');
    return `bp_${digest.slice(0, 16)}`;
  }
}
