// ViewStateService (plan Task 10): Watch/Timeline expression store synced with
// the UI workspace-state keys, Unicode-preserving normalization, timeline
// sampling through the exact session, and no stale samples after replacement.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ViewStateService, ViewStateStore } from './view-state-service';
import { SessionRef } from './protocol';
import { SessionRegistry } from './session-registry';
import { RuntimeRouter } from './runtime-router';
import { RuntimeReadValue } from './types';
import type { Mock } from 'vitest';

vi.mock('vscode', () => ({}));

interface TestContext {
  service: ViewStateService;
  registry: SessionRegistry;
  ref: SessionRef;
  store: ViewStateStore;
  data: Record<string, unknown>;
  read: Mock<(signals: readonly { alias: string; expression: string }[], ref: SessionRef) => Promise<RuntimeReadValue[]>>;
}

function makeService(seed?: { watch?: string[]; timeline?: unknown[] }): TestContext {
  const registry = new SessionRegistry();
  const session = { id: 'sess-view', type: 'orbit', name: 'test' };
  registry.onStarted(session as never);
  const data: Record<string, unknown> = {
    'ozoneWatchExpressions': seed?.watch ?? [],
    'ozoneDataSamplingExpressions': seed?.timeline ?? [],
  };
  const store: ViewStateStore = {
    get: <T>(key: string, defaultValue: T): T => (data[key] === undefined ? defaultValue : (data[key] as T)),
    update: (key, value) => { data[key] = value; return Promise.resolve(); },
  };
  const read = vi.fn(async (signals: readonly { alias: string; expression: string }[], _ref: SessionRef): Promise<RuntimeReadValue[]> => {
    return signals.map((s, i) => ({
      alias: s.alias,
      expression: s.expression,
      value: 10 + i,
      display: String(10 + i),
    }));
  });
  const runtime = { readSignals: read } as unknown as RuntimeRouter;
  const service = new ViewStateService({ registry, runtime, store });
  return { service, registry, ref: registry.currentRef()!, store, data, read };
}

describe('ViewStateService watch', () => {
  let ctx: TestContext;
  beforeEach(() => { ctx = makeService(); });

  it('hydrates the persisted watch list and reports revision 0', async () => {
    const ctx2 = makeService({ watch: ['mot.1', 'mot.2'] });
    const snap = await ctx2.service.watchSnapshot(false);
    expect(snap.expressions).toEqual(['mot.1', 'mot.2']);
    expect(snap.revision).toBe(0);
    expect(snap.values).toEqual([]);
    expect(snap.nextCursor).toBeNull();
  });

  it('replaceWatch trims, drops empties and dedupes', async () => {
    const snap = await ctx.service.replaceWatch(['  a  ', '', 'b', 'b', 'c']);
    expect(snap.expressions).toEqual(['a', 'b', 'c']);
    expect(ctx.data['ozoneWatchExpressions']).toEqual(['a', 'b', 'c']);
  });

  it('addWatch appends new expressions only', async () => {
    await ctx.service.replaceWatch(['a']);
    const snap = await ctx.service.addWatch(['a', 'b', 'b']);
    expect(snap.expressions).toEqual(['a', 'b']);
  });

  it('removeWatch drops exact expressions and persists', async () => {
    await ctx.service.replaceWatch(['a', 'b', 'c']);
    const snap = await ctx.service.removeWatch(['b', 'a', 'x']);
    expect(snap.expressions).toEqual(['c']);
  });

  it('setWatchFromUi adopts and persists a UI change', async () => {
    ctx.service.setWatchFromUi(['x', 'y']);
    expect(ctx.data['ozoneWatchExpressions']).toEqual(['x', 'y']);
    const snap = await ctx.service.watchSnapshot(false);
    expect(snap.expressions).toEqual(['x', 'y']);
    expect(snap.revision).toBeGreaterThan(0);
  });

  it('watchSnapshot with includeValues reads through the current session', async () => {
    await ctx.service.replaceWatch(['v']);
    const snap = await ctx.service.watchSnapshot(true);
    expect(ctx.read).toHaveBeenCalled();
    expect(snap.items.length).toBe(1);
    expect(snap.items[0].expression).toBe('v');
  });
});

describe('ViewStateService timeline', () => {
  let ctx: TestContext;
  beforeEach(() => { ctx = makeService(); });

  it('replaceTimeline stores entries and reflects them in list', async () => {
    const snap = await ctx.service.replaceTimeline(['t1', 't2']);
    expect(snap.expressions).toEqual(['t1', 't2']);
    expect(snap.sampling).toBe(false);
  });

  it('hydrates timeline expressions preserving simple entries', () => {
    const c = makeService({ timeline: ['t1', { expression: 't2', color: '#fff' }] });
    expect(c.service.timelineEntries.map(e => e.expression)).toEqual(['t1', 't2']);
    expect(c.service.timelineEntries).toEqual([
      { expression: 't1', enabled: true },
      { expression: 't2', color: '#fff', enabled: true },
    ]);
  });

  it('starts sampling and accumulates frames, then stop halts it', async () => {
    vi.useFakeTimers();
    try {
      await ctx.service.replaceTimeline(['t1']);
      const started = await ctx.service.startTimeline(ctx.ref, 20, 100);
      expect(started.sampling).toBe(true);
      await vi.advanceTimersByTimeAsync(60);
      const mid = await ctx.service.timelineStatus(ctx.ref);
      expect(mid.framesRetained).toBe(3);
      await vi.advanceTimersByTimeAsync(20);
      const stopped = await ctx.service.stopTimeline(ctx.ref);
      expect(stopped.sampling).toBe(false);
      const after = stopped.framesRetained;
      await vi.advanceTimersByTimeAsync(500);
      expect((await ctx.service.timelineStatus(ctx.ref)).framesRetained).toBe(after);
    } finally {
      vi.useRealTimers();
      ctx.service.dispose();
    }
  });

  it('caps retained frames at maxFrames and drops the oldest', async () => {
    vi.useFakeTimers();
    try {
      await ctx.service.replaceTimeline(['t1']);
      await ctx.service.startTimeline(ctx.ref, 5, 2);
      await vi.advanceTimersByTimeAsync(5 * 10);
      const snap = await ctx.service.timelineStatus(ctx.ref);
      expect(snap.framesRetained).toBe(2);
      expect(snap.droppedFrames).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
      ctx.service.dispose();
    }
  });

  it('a stale read (generation fence) stops sampling without growing frames', async () => {
    vi.useFakeTimers();
    try {
      await ctx.service.replaceTimeline(['t1']);
      const started = await ctx.service.startTimeline(ctx.ref, 10, 100);
      expect(started.sampling).toBe(true);
      await vi.advanceTimersByTimeAsync(5);
      ctx.read.mockImplementationOnce(async () => {
        throw Object.assign(new Error('SessionChanged'), { data: { errorCode: 'SessionChanged' } });
      });
      await vi.advanceTimersByTimeAsync(10);
      expect(await ctx.service.timelineSnapshot(true)).toMatchObject({ sampling: false });
    } finally {
      vi.useRealTimers();
      ctx.service.dispose();
    }
  });

  it('startTimeline rejects a stale generation', async () => {
    const badRef: SessionRef = { sessionId: ctx.ref.sessionId, sessionGeneration: ctx.ref.sessionGeneration + 1 };
    await expect(ctx.service.startTimeline(badRef, 5)).rejects.toMatchObject({ errorCode: 'SessionChanged' });
  });
});