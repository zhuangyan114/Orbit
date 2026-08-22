// BreakpointService: unified VS Code breakpoint merge, mutation and DAP
// verification (plan Task 6).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BreakpointInput, SessionRef } from './protocol';
import { SessionRegistry } from './session-registry';
import { BreakpointService, BreakpointServiceOptions } from './breakpoint-service';
import { AutomationBreakpointCapabilities } from '../debug/dap-automation-protocol';

// The service only touches vscode values inside its default seams; every seam
// is overridden in these tests, so an empty module mock is enough for the
// (otherwise) real `import * as vscode` to resolve.
vi.mock('vscode', () => ({}));

interface FakeBreakpoint {
  location: { uri: { fsPath: string }; range: { start: { line: number; character?: number } } };
  enabled: boolean;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
}

interface DapEntry {
  path: string;
  line: number;
  verified: boolean;
  slot?: number;
  address?: string;
}

function bp(path: string, line0: number, opts: {
  column0?: number;
  enabled?: boolean;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
} = {}): FakeBreakpoint {
  const result: FakeBreakpoint = {
    location: {
      uri: { fsPath: path },
      range: {
        start: { line: line0, ...(opts.column0 !== undefined ? { character: opts.column0 } : {}) },
      },
    },
    enabled: opts.enabled !== false,
  };
  if (opts.condition !== undefined) result.condition = opts.condition;
  if (opts.hitCondition !== undefined) result.hitCondition = opts.hitCondition;
  if (opts.logMessage !== undefined) result.logMessage = opts.logMessage;
  return result;
}

function input(path: string, line: number, opts: {
  column?: number;
  enabled?: boolean;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
} = {}): BreakpointInput {
  return {
    source: { path, line, ...(opts.column !== undefined ? { column: opts.column } : {}) },
    enabled: opts.enabled !== false,
    ...(opts.condition !== undefined ? { condition: opts.condition } : {}),
    ...(opts.hitCondition !== undefined ? { hitCondition: opts.hitCondition } : {}),
    ...(opts.logMessage !== undefined ? { logMessage: opts.logMessage } : {}),
  };
}

interface TestContext {
  service: BreakpointService;
  registry: SessionRegistry;
  requested: FakeBreakpoint[];
  dap: DapEntry[];
  caps: AutomationBreakpointCapabilities;
  addCalls: BreakpointInput[][];
  removeCalls: unknown[][];
  advance: (ms: number) => void;
  startSession: () => void;
  lastSessionRef: () => SessionRef | undefined;
}

function makeService(overrides: Partial<BreakpointServiceOptions> = {}): TestContext {
  const registry = new SessionRegistry();
  const requested: FakeBreakpoint[] = [];
  const dap: DapEntry[] = [];
  const caps: AutomationBreakpointCapabilities = { conditional: false, hitConditional: false, logPoints: false };
  const addCalls: BreakpointInput[][] = [];
  const removeCalls: unknown[][] = [];
  let clock = 0;

  const service = new BreakpointService({
    registry,
    listBreakpoints: () => requested as unknown as never[],
    addBreakpoints: async inputs => {
      addCalls.push([...inputs]);
      for (const item of inputs) {
        // Mirror buildLocation: VS Code always materializes a character, so an
        // unspecified column becomes character 0 and reads back as column 1.
        // VS Code also dedupes a same-location breakpoint instead of adding a
        // second gutter marker.
        const line0 = item.source.line - 1;
        if (requested.some(b => b.location.uri.fsPath === item.source.path && b.location.range.start.line === line0)) {
          continue;
        }
        requested.push(bp(item.source.path, line0, {
          column0: (item.source.column ?? 1) - 1,
          enabled: item.enabled,
          condition: item.condition,
          hitCondition: item.hitCondition,
          logMessage: item.logMessage,
        }));
      }
    },
    removeBreakpoints: async breakpoints => {
      removeCalls.push([...breakpoints]);
      for (const target of breakpoints) {
        const index = requested.indexOf(target as unknown as FakeBreakpoint);
        if (index >= 0) requested.splice(index, 1);
      }
    },
    snapshotDap: async () => ({ breakpoints: dap.map(entry => ({ ...entry })), capabilities: { ...caps } }),
    sleep: async ms => {
      clock += ms;
    },
    now: () => clock,
    normalizePath: path => path.replace(/\\/g, '/').toLowerCase(),
    ...overrides,
  });

  return {
    service,
    registry,
    requested,
    dap,
    caps,
    addCalls,
    removeCalls,
    advance: ms => {
      clock += ms;
    },
    startSession: () => {
      registry.onStarted({ id: 'sess-1', type: 'orbit', name: 'test' } as never);
    },
    lastSessionRef: () => registry.currentRef(),
  };
}

function breakpointIdOf(item: { breakpointId: string }): string {
  return item.breakpointId;
}

describe('BreakpointService', () => {
  let ctx: TestContext;
  beforeEach(() => {
    ctx = makeService();
  });

  it('lists requested breakpoints with verified=false and no session identity when no session exists', async () => {
    ctx.requested.push(bp('C:\\ws\\main.c', 9));
    const data = await ctx.service.list();
    expect(data.items).toHaveLength(1);
    expect(data.items[0]).toMatchObject({
      source: { path: 'C:\\ws\\main.c', line: 10 },
      enabled: true,
      verified: false,
    });
    expect(data.items[0].sessionId).toBeUndefined();
    expect(data.items[0].sessionGeneration).toBeUndefined();
    expect(breakpointIdOf(data.items[0])).toMatch(/^bp_[0-9a-f]{16}$/);
  });

  it('merges the DAP verified snapshot (verified/slot/session identity) case-insensitively', async () => {
    ctx.startSession();
    ctx.requested.push(bp('C:\\ws\\Main.c', 9));
    ctx.dap.push({ path: 'c:/ws/main.c', line: 10, verified: true, slot: 2 });
    const data = await ctx.service.list();
    expect(data.items[0]).toMatchObject({
      verified: true,
      slot: 2,
      sessionId: 'sess-1',
      sessionGeneration: 1,
    });
  });

  it('reports unresolved DAP breakpoints as verified=false while verified ones carry slots (six-slot style)', async () => {
    ctx.startSession();
    for (let i = 0; i < 6; i += 1) {
      ctx.requested.push(bp('C:\\ws\\main.c', 9 + i));
      ctx.dap.push({ path: 'c:/ws/main.c', line: 10 + i, verified: true, slot: i });
    }
    ctx.requested.push(bp('C:\\ws\\main.c', 15)); // 7th: no DAP entry
    const data = await ctx.service.list();
    expect(data.items).toHaveLength(7);
    expect(data.items.slice(0, 6).every(item => item.verified)).toBe(true);
    expect(data.items[6]).toMatchObject({ verified: false, source: { line: 16 } });
    expect(data.items[6].slot).toBeUndefined();
  });

  it('add goes through the add seam and returns the merged item', async () => {
    const result = await ctx.service.add(input('C:\\ws\\main.c', 10), 0, 'op1');
    expect(ctx.addCalls).toHaveLength(1);
    expect(ctx.addCalls[0]).toHaveLength(1);
    expect(ctx.requested).toHaveLength(1);
    expect(ctx.requested[0].location.range.start.line).toBe(9);
    expect(result.operationId).toBe('op1');
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ source: { line: 10 }, verified: false });
  });

  it('add returns verified=true when the DAP verifies within the window', async () => {
    ctx.startSession();
    ctx.dap.push({ path: 'c:/ws/main.c', line: 10, verified: true, slot: 0 });
    const result = await ctx.service.add(input('C:\\ws\\main.c', 10), 1000, 'op1');
    expect(result.items[0]).toMatchObject({ verified: true, slot: 0, sessionId: 'sess-1' });
  });

  it('keeps the breakpointId stable across the add -> list round-trip (column canonicalization)', async () => {
    // Regression: an unspecified column is materialized by VS Code as character
    // 0 (column 1 on read-back), which must not change the derived id.
    ctx.startSession();
    ctx.dap.push({ path: 'c:/ws/main.c', line: 10, verified: true, slot: 0 });
    const added = await ctx.service.add(input('C:\\ws\\main.c', 10), 0, 'op1');
    const listed = await ctx.service.list({ sourcePath: 'C:\\ws\\main.c' });
    expect(added.items[0].breakpointId).toBe(listed.items[0].breakpointId);
    expect(added.items[0].source.column).toBeUndefined();
    expect(listed.items[0].source.column).toBeUndefined();
  });

  it('add throws BreakpointUnverified when verification times out', async () => {
    ctx.startSession();
    await expect(ctx.service.add(input('C:\\ws\\main.c', 10), 1000, 'op1'))
      .rejects.toMatchObject({ errorCode: 'BreakpointUnverified' });
  });

  it('add does not throw for an unverified breakpoint when waitForVerificationMs is 0', async () => {
    ctx.startSession();
    const result = await ctx.service.add(input('C:\\ws\\main.c', 10), 0, 'op1');
    expect(result.items[0].verified).toBe(false);
  });

  it('requires an operationId for every mutation', async () => {
    await expect(ctx.service.add(input('C:\\ws\\main.c', 10), 0, undefined))
      .rejects.toMatchObject({ errorCode: 'InternalError' });
  });

  it('update removes the exact old object and adds the new condition', async () => {
    ctx.requested.push(bp('C:\\ws\\main.c', 9, { condition: 'x == 1' }));
    const oldId = breakpointIdOf((await ctx.service.list()).items[0]);

    const result = await ctx.service.update(
      oldId,
      input('C:\\ws\\main.c', 10, { condition: 'x == 2' }),
      0,
      'op2',
    );

    expect(ctx.removeCalls).toHaveLength(1);
    expect(ctx.addCalls).toHaveLength(1);
    expect(ctx.requested).toHaveLength(1);
    expect(ctx.requested[0].condition).toBe('x == 2');
    expect(result.items[0].condition).toBe('x == 2');
    expect(breakpointIdOf(result.items[0])).not.toBe(oldId);
  });

  it('update throws BreakpointNotFound for an unknown id', async () => {
    await expect(ctx.service.update('bp_missing', input('C:\\ws\\main.c', 10), 0, 'op'))
      .rejects.toMatchObject({ errorCode: 'BreakpointNotFound' });
  });

  it('remove removes only the exact matching object and returns its last snapshot', async () => {
    ctx.requested.push(bp('C:\\ws\\main.c', 9));
    ctx.requested.push(bp('C:\\ws\\main.c', 19));
    const ids = (await ctx.service.list()).items.map(breakpointIdOf);

    const result = await ctx.service.remove(ids[0], 'op3');

    expect(ctx.removeCalls).toHaveLength(1);
    expect(ctx.removeCalls[0]).toHaveLength(1);
    expect(ctx.requested).toHaveLength(1);
    expect(ctx.requested[0].location.range.start.line).toBe(19);
    expect(result.items[0].breakpointId).toBe(ids[0]);
  });

  it('remove throws BreakpointNotFound for an unknown id', async () => {
    await expect(ctx.service.remove('bp_missing', 'op')).rejects.toMatchObject({ errorCode: 'BreakpointNotFound' });
  });

  it('list reflects a breakpoint added by the user (bidirectional sync)', async () => {
    expect((await ctx.service.list()).items).toHaveLength(0);
    ctx.requested.push(bp('C:\\ws\\main.c', 4));
    const data = await ctx.service.list();
    expect(data.items).toHaveLength(1);
    expect(data.items[0]).toMatchObject({ source: { line: 5 } });
  });

  it('replace swaps only the specified source and leaves other sources untouched', async () => {
    ctx.requested.push(bp('C:\\ws\\main.c', 9));
    ctx.requested.push(bp('C:\\ws\\other.c', 19));

    const result = await ctx.service.replace(
      'C:\\ws\\main.c',
      [input('C:\\ws\\main.c', 11)],
      0,
      'op4',
    );

    expect(ctx.removeCalls).toHaveLength(1);
    expect(ctx.removeCalls[0]).toHaveLength(1);
    expect(ctx.addCalls).toHaveLength(1);
    expect(ctx.requested).toHaveLength(2);
    expect(ctx.requested.some(b => b.location.uri.fsPath === 'C:\\ws\\main.c' && b.location.range.start.line === 10)).toBe(true);
    expect(ctx.requested.some(b => b.location.uri.fsPath === 'C:\\ws\\other.c')).toBe(true);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ source: { path: 'C:\\ws\\main.c', line: 11 } });
  });

  it('replace rejects inputs for a different source', async () => {
    await expect(
      ctx.service.replace('C:\\ws\\main.c', [input('C:\\ws\\other.c', 10)], 0, 'op'),
    ).rejects.toMatchObject({ errorCode: 'InvalidRequest' });
  });

  it('replace reports per-breakpoint verified results without throwing on an unverified line', async () => {
    ctx.startSession();
    ctx.dap.push({ path: 'c:/ws/main.c', line: 11, verified: true, slot: 0 });
    const result = await ctx.service.replace(
      'C:\\ws\\main.c',
      [input('C:\\ws\\main.c', 11), input('C:\\ws\\main.c', 12)],
      0,
      'op',
    );
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({ source: { line: 11 }, verified: true });
    expect(result.items[1]).toMatchObject({ source: { line: 12 }, verified: false });
  });

  it('derives distinct breakpoint ids for different conditions and stable ids for toggled enabled', async () => {
    ctx.requested.push(bp('C:\\ws\\main.c', 9, { condition: 'a == 1', enabled: true }));
    ctx.requested.push(bp('C:\\ws\\main.c', 9, { condition: 'a == 1', enabled: false }));
    ctx.requested.push(bp('C:\\ws\\main.c', 9, { condition: 'a == 2' }));
    const items = (await ctx.service.list()).items;
    expect(items).toHaveLength(3);

    const idsFor = (condition: string): string[] =>
      items.filter(item => item.condition === condition).map(item => item.breakpointId);

    expect(idsFor('a == 1')).toHaveLength(2);
    expect(idsFor('a == 1')[0]).toBe(idsFor('a == 1')[1]); // enabled not part of id
    expect(idsFor('a == 2')).toHaveLength(1);
    expect(idsFor('a == 1')[0]).not.toBe(idsFor('a == 2')[0]); // condition is
    expect(items.find(item => item.condition === 'a == 1' && item.enabled === false)).toBeTruthy();
  });

  it('pages by breakpointId cursor', async () => {
    for (let i = 0; i < 3; i += 1) ctx.requested.push(bp('C:\\ws\\main.c', i));
    const first = await ctx.service.list({ limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBe(first.items[1].breakpointId);

    const second = await ctx.service.list({ cursor: first.nextCursor!, limit: 2 });
    expect(second.items).toHaveLength(1);
    expect(second.items[0].breakpointId).not.toBe(first.items[0].breakpointId);
    expect(second.nextCursor).toBeUndefined();
  });

  it('rejects an unknown cursor', async () => {
    ctx.requested.push(bp('C:\\ws\\main.c', 0));
    await expect(ctx.service.list({ cursor: 'bp_unknown' })).rejects.toMatchObject({ errorCode: 'InvalidRequest' });
  });

  it('annotates condition/hit/log breakpoints the adapter does not enforce (M1)', async () => {
    ctx.startSession();
    ctx.requested.push(bp('C:\\ws\\main.c', 9, { condition: 'x > 5', logMessage: 'hit {x}' }));
    const data = await ctx.service.list();
    expect(data.items[0].message).toContain('condition is not enforced');
    expect(data.items[0].message).toContain('log message is not enforced');
  });

  it('does not annotate when the adapter reports the capability as supported', async () => {
    ctx.startSession();
    ctx.caps.conditional = true;
    ctx.caps.logPoints = true;
    ctx.requested.push(bp('C:\\ws\\main.c', 9, { condition: 'x > 5', logMessage: 'hit {x}' }));
    const data = await ctx.service.list();
    expect(data.items[0].message).toBeUndefined();
  });

  it('surfaces the resolved breakpoint address from the DAP snapshot (L2)', async () => {
    ctx.startSession();
    ctx.requested.push(bp('C:\\ws\\main.c', 9));
    ctx.dap.push({ path: 'c:/ws/main.c', line: 10, verified: true, slot: 0, address: '0x8004e9c' });
    const data = await ctx.service.list();
    expect(data.items[0]).toMatchObject({ verified: true, slot: 0, address: '0x8004e9c' });
  });

  it('restores the previous set when replace add fails (M2 rollback)', async () => {
    const registry = new SessionRegistry();
    const requested: FakeBreakpoint[] = [bp('C:\\ws\\main.c', 9), bp('C:\\ws\\main.c', 19)];
    const service = new BreakpointService({
      registry,
      listBreakpoints: () => requested as unknown as never[],
      addBreakpoints: async inputs => {
        if (inputs.some(i => i.source.line === 11)) throw new Error('add failed');
        for (const i of inputs) {
          requested.push(bp(i.source.path, i.source.line - 1, {
            column0: (i.source.column ?? 1) - 1, enabled: i.enabled,
            condition: i.condition, hitCondition: i.hitCondition, logMessage: i.logMessage,
          }));
        }
      },
      removeBreakpoints: async bps => {
        for (const t of bps) {
          const idx = requested.indexOf(t as unknown as FakeBreakpoint);
          if (idx >= 0) requested.splice(idx, 1);
        }
      },
      snapshotDap: async () => ({ breakpoints: [], capabilities: { conditional: false, hitConditional: false, logPoints: false } }),
      sleep: async () => {},
      now: () => 0,
      normalizePath: p => p.replace(/\\/g, '/').toLowerCase(),
    });

    await expect(
      service.replace('C:\\ws\\main.c', [input('C:\\ws\\main.c', 11)], 0, 'op'),
    ).rejects.toThrow('add failed');
    // The previous set (lines 10 and 20) was restored.
    expect(requested.map(b => b.location.range.start.line).sort((a, b) => a - b)).toEqual([9, 19]);
  });

  it('treats a duplicate add as idempotent and returns the existing breakpoint (L5)', async () => {
    ctx.requested.push(bp('C:\\ws\\main.c', 9));
    const first = await ctx.service.add(input('C:\\ws\\main.c', 10), 0, 'op1');
    const second = await ctx.service.add(input('C:\\ws\\main.c', 10), 0, 'op2');
    expect(ctx.requested).toHaveLength(1);
    expect(first.items[0].breakpointId).toBe(second.items[0].breakpointId);
  });
});
