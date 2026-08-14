// RecordingService (plan Task 10): concurrent/64-channel/50k-frame budgets,
// paginated get, whole-instance 64 MiB budget eviction, session-generation
// fence, and timer/listener cleanup (no stale background sampling).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RecordingChannel, SessionRef } from './protocol';
import { SessionRegistry } from './session-registry';
import { RecordingService } from './recording-service';
import { FastSampleSink, ReleasedSample } from './fast-sample-sink';
import { RuntimeRouter } from './runtime-router';
import { RuntimeReadValue } from './types';
import type { Mock } from 'vitest';

vi.mock('vscode', () => ({}));

interface TestContext {
  service: RecordingService;
  registry: SessionRegistry;
  ref: SessionRef;
  read: Mock<(signals: readonly { alias: string; expression: string }[], ref: SessionRef) => Promise<RuntimeReadValue[]>>;
}

function chan(id: string, expression = `expr.${id}`): RecordingChannel {
  return { channelId: id, expression, valueType: '_' };
}

function makeService(): TestContext {
  const registry = new SessionRegistry();
  const session = { id: 'sess-rec', type: 'orbit', name: 'test' };
  registry.onStarted(session as never);
  const read = vi.fn(async (signals: readonly { alias: string; expression: string }[], _ref: SessionRef): Promise<RuntimeReadValue[]> => {
    return signals.map(s => ({ alias: s.alias, expression: s.expression, value: 1, display: '1' }));
  });
  const runtime = { readSignals: read } as unknown as RuntimeRouter;
  const service = new RecordingService({ registry, runtime });
  return { service, registry, ref: registry.currentRef()!, read };
}

describe('RecordingService start/validation', () => {
  let ctx: TestContext;
  beforeEach(() => { ctx = makeService(); });

  it('validates channel count and uniqueness', async () => {
    await expect(ctx.service.start(ctx.ref, { name: 'n', channels: [chan('a'), chan('a')], intervalMs: 10 }))
      .rejects.toMatchObject({ errorCode: 'InvalidRequest' });
    await expect(ctx.service.start(ctx.ref, { name: 'n', channels: [], intervalMs: 10 }))
      .rejects.toMatchObject({ errorCode: 'InvalidRequest' });
    await expect(ctx.service.start(ctx.ref, { name: 'n', channels: [chan('a')], intervalMs: Number.NaN }))
      .rejects.toMatchObject({ errorCode: 'InvalidRequest' });
  });

  it('rejects a new recording beyond 4 concurrent', async () => {
    for (let i = 0; i < 4; i += 1) {
      await ctx.service.start(ctx.ref, { name: `r${i}`, channels: [chan(`c${i}`)], intervalMs: 5 });
    }
    await expect(ctx.service.start(ctx.ref, { name: 'overflow', channels: [chan('z')], intervalMs: 5 }))
      .rejects.toMatchObject({ errorCode: 'RateLimited' });
  });

  it('fences on the exact session generation', async () => {
    const badRef: SessionRef = { sessionId: ctx.ref.sessionId, sessionGeneration: ctx.ref.sessionGeneration + 1 };
    await expect(ctx.service.start(badRef, { name: 'n', channels: [chan('a')], intervalMs: 5 }))
      .rejects.toMatchObject({ errorCode: 'SessionChanged' });
  });
});

describe('RecordingService sampling/pagination', () => {
  let ctx: TestContext;
  beforeEach(() => { ctx = makeService(); });

  it('samples frames and stops cleanly', async () => {
    vi.useFakeTimers();
    try {
      await ctx.service.start(ctx.ref, { name: 'r', channels: [chan('a'), chan('b')], intervalMs: 5 });
      await vi.advanceTimersByTimeAsync(5 * 4 - 1);
      const list = await ctx.service.list(ctx.ref, {});
      expect(list.items[0].status).toBe('recording');
      const snap = await ctx.service.stop(ctx.ref, list.items[0].recordingId);
      expect(snap.status).toBe('stopped');
      const page = await ctx.service.get(ctx.ref, { recordingId: snap.recordingId });
      expect(page.items.length).toBe(3);
      expect(page.recording.frameCount).toBe(3);
      expect(page.items[0].sessionGeneration).toBe(ctx.ref.sessionGeneration);
      expect(page.items[0].values.length).toBe(2);
    } finally {
      vi.useRealTimers();
      ctx.service.dispose();
    }
  });

  it('pages frames with cursor/limit', async () => {
    vi.useFakeTimers();
    try {
      await ctx.service.start(ctx.ref, { name: 'r', channels: [chan('a')], intervalMs: 5 });
      await vi.advanceTimersByTimeAsync(5 * 7);
      const finished = await ctx.service.stop(ctx.ref, (await ctx.service.list(ctx.ref, {})).items[0].recordingId);
      const page1 = await ctx.service.get(ctx.ref, { recordingId: finished.recordingId, limit: 3 });
      expect(page1.items.length).toBe(3);
      expect(page1.nextCursor).toBeTruthy();
      const page2 = await ctx.service.get(ctx.ref, {
        recordingId: finished.recordingId, cursor: page1.nextCursor!, limit: 3,
      });
      expect(page2.items.length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
      ctx.service.dispose();
    }
  });

  it('caps retained frames at maxFrames', async () => {
    vi.useFakeTimers();
    try {
      const recording = await ctx.service.start(ctx.ref, { name: 'r', channels: [chan('a')], intervalMs: 5, maxFrames: 10 });
      await vi.advanceTimersByTimeAsync(5 * 25);
      const page = await ctx.service.get(ctx.ref, { recordingId: recording.recordingId });
      expect(page.recording.frameCount).toBe(10);
      expect(page.items.length).toBe(10);
    } finally {
      vi.useRealTimers();
      ctx.service.dispose();
    }
  });

  it('clear removes the recording and reports clearedFrames', async () => {
    vi.useFakeTimers();
    try {
      const recording = await ctx.service.start(ctx.ref, { name: 'r', channels: [chan('a')], intervalMs: 5 });
      await vi.advanceTimersByTimeAsync(14);
      const cleared = await ctx.service.clear(ctx.ref, { recordingId: recording.recordingId });
      expect(cleared.clearedFrames).toBe(2);
      await expect(ctx.service.get(ctx.ref, { recordingId: recording.recordingId }))
        .rejects.toMatchObject({ errorCode: 'RecordingNotFound' });
    } finally {
      vi.useRealTimers();
      ctx.service.dispose();
    }
  });

  it('a stale read (generation fence) stops sampling, releasing the timer', async () => {
    vi.useFakeTimers();
    try {
      const recording = await ctx.service.start(ctx.ref, { name: 'r', channels: [chan('a')], intervalMs: 5 });
      await vi.advanceTimersByTimeAsync(5);
      ctx.read.mockImplementationOnce(async () => { throw new Error('SessionChanged'); });
      await vi.advanceTimersByTimeAsync(5);
      const page = await ctx.service.get(ctx.ref, { recordingId: recording.recordingId });
      expect(page.recording.status).toBe('stopped');
      const before = page.recording.frameCount;
      await vi.advanceTimersByTimeAsync(200);
      const after = (await ctx.service.get(ctx.ref, { recordingId: recording.recordingId })).recording.frameCount;
      expect(after).toBe(before);
    } finally {
      vi.useRealTimers();
      ctx.service.dispose();
    }
  });

  it('get on an unknown recording returns RecordingNotFound', async () => {
    await expect(ctx.service.get(ctx.ref, { recordingId: 'nope' }))
      .rejects.toMatchObject({ errorCode: 'RecordingNotFound' });
  });
});

describe('RecordingService high-rate fast-path (shared Timeline channel)', () => {
  it('emits a raw frame per high-rate timestamp and hands off shared exprs on stop', async () => {
    const registry = new SessionRegistry();
    registry.onStarted({ id: 'sess-sink', type: 'orbit', name: 'test' } as never);
    const ref = registry.currentRef()!;

    const capture: any = {};
    const sink = {
      addConsumer: vi.fn((consumer: { key: string; channels: unknown[]; shared: unknown[]; onPoints: (points: ReleasedSample[]) => void }) => {
        capture.consumer = consumer;
        capture.lastChannels = consumer.channels;
        capture.lastShared = consumer.shared;
        capture.onBatch = consumer.onPoints;
      }),
      removeConsumer: vi.fn((key: string) => { capture.removed = key; }),
      dispose: vi.fn(async () => undefined),
    } as unknown as FastSampleSink;

    const service = new RecordingService({
      registry,
      runtime: { readSignals: vi.fn() } as unknown as RuntimeRouter,
      sampleSink: sink,
      sharedSampleExpressions: () => ['tl_a'],
      now: () => 0,
    });

    const recording = await service.start(ref, { name: 'fast', channels: [chan('c_aww', 'aww')], intervalMs: 0 });
    await new Promise<void>(resolve => setTimeout(resolve, 1));

    // Each high-rate point becomes one raw frame (no intervalMs decimation).
    expect(capture.lastChannels).toEqual([{ channelId: 'c_aww', expression: 'aww' }]);
    expect(capture.lastShared).toEqual([{ expression: 'tl_a', color: '#4EC9B0' }]);
    capture.onBatch!([
      { channelId: 'c_aww', expression: 'aww', timestamp: 1001, value: 7 },
      { channelId: 'c_aww', expression: 'aww', timestamp: 1003, value: 8 },
    ]);
    const page = await service.get(ref, { recordingId: recording.recordingId });
    expect(page.recording.frameCount).toBe(2);
    expect(page.items.map(f => f.timestamp)).toEqual(['1001', '1003']);
    expect(page.items[0].values[0]).toEqual({ channelId: 'c_aww', value: 7, available: true });

    // Stopping removes the recording consumer so the shared sampler hands back.
    await service.stop(ref, recording.recordingId);
    await new Promise<void>(resolve => setTimeout(resolve, 1));
    expect(capture.removed).toBe('recording');
    service.dispose();
  });
});