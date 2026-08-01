import { describe, expect, it } from 'vitest';
import { NativeScheduler, NativeSchedulerCancelledError } from './native-scheduler';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(next => { resolve = next; });
  return { promise, resolve };
}

describe('NativeScheduler', () => {
  it('serializes native work and keeps background work behind Timeline', async () => {
    const scheduler = new NativeScheduler();
    const gate = deferred<void>();
    const order: string[] = [];
    const running = scheduler.schedule(async () => { order.push('running'); await gate.promise; }, { priority: 'watch' });
    const timeline = scheduler.schedule(async () => { order.push('timeline'); }, { priority: 'timeline' });
    const watch = scheduler.schedule(async () => { order.push('watch'); }, { priority: 'watch' });
    const background = scheduler.schedule(async () => { order.push('background'); }, { priority: 'background' });
    const control = scheduler.schedule(async () => { order.push('control'); }, { priority: 'control' });

    gate.resolve();
    await Promise.all([running, timeline, watch, background, control]);
    expect(order).toEqual(['running', 'control', 'watch', 'timeline', 'background']);
  });

  it('does not let sustained timeline sampling starve a setWatchValue control task', async () => {
    const scheduler = new NativeScheduler();
    const gate = deferred<void>();
    const order: string[] = [];
    const running = scheduler.schedule(async () => {
      order.push('sample-running');
      await gate.promise;
    }, { priority: 'timeline', label: 'timeline sample' });
    const samples = Array.from({ length: 32 }, (_, index) =>
      scheduler.schedule(async () => { order.push(`sample-${index}`); }, {
        priority: 'timeline',
        label: 'timeline sample',
      }),
    );
    const write = scheduler.schedule(async () => { order.push('setWatchValue'); }, {
      priority: 'control',
      label: 'setWatchValue',
    });

    gate.resolve();
    await Promise.all([running, write, ...samples]);
    expect(order.slice(0, 2)).toEqual(['sample-running', 'setWatchValue']);
  });

  it('pauses timeline during a step scope and resumes it afterwards', async () => {
    const scheduler = new NativeScheduler();
    const order: string[] = [];
    const stepGate = deferred<void>();
    const step = scheduler.withPaused(['timeline', 'background'], () =>
      scheduler.schedule(async () => { order.push('step'); await stepGate.promise; }, { priority: 'control' }),
    );
    const timeline = scheduler.schedule(async () => { order.push('timeline'); }, { priority: 'timeline' });
    const background = scheduler.schedule(async () => { order.push('background'); }, { priority: 'background' });
    const watch = scheduler.schedule(async () => { order.push('watch'); }, { priority: 'watch' });

    expect(order).toEqual(['step']);
    expect(scheduler.snapshot().pausedPriorities).toContain('timeline');
    stepGate.resolve();
    await Promise.all([step, watch, timeline, background]);
    expect(order).toEqual(['step', 'watch', 'timeline', 'background']);
    expect(scheduler.snapshot().pausedPriorities).not.toContain('timeline');
  });

  it('releases the timeline pause token when step fails', async () => {
    const scheduler = new NativeScheduler();
    const stepGate = deferred<void>();
    const order: string[] = [];
    const stepError = new Error('step failed');
    const step = scheduler.withPaused(['timeline', 'background'], () =>
      scheduler.schedule(async () => {
        order.push('step');
        await stepGate.promise;
        throw stepError;
      }, { priority: 'control' }),
    );
    const stepAssertion = expect(step).rejects.toBe(stepError);
    const timeline = scheduler.schedule(async () => { order.push('timeline'); }, { priority: 'timeline' });
    const background = scheduler.schedule(async () => { order.push('background'); }, { priority: 'background' });

    expect(scheduler.snapshot().pausedPriorities).toContain('timeline');
    stepGate.resolve();
    await stepAssertion;
    await Promise.all([timeline, background]);
    expect(order).toEqual(['step', 'timeline', 'background']);
    expect(scheduler.snapshot().pausedPriorities).not.toContain('timeline');
  });

  it('rejects every queued task after dispose', async () => {
    const scheduler = new NativeScheduler();
    const gate = deferred<void>();
    const running = scheduler.schedule(() => gate.promise, { priority: 'control' });
    const queued = [
      scheduler.schedule(async () => 'control', { priority: 'control' }),
      scheduler.schedule(async () => 'watch', { priority: 'watch' }),
      scheduler.schedule(async () => 'timeline', { priority: 'timeline' }),
      scheduler.schedule(async () => 'background', { priority: 'background' }),
    ];
    const assertions = queued.map(task => expect(task).rejects.toBeInstanceOf(NativeSchedulerCancelledError));

    scheduler.dispose();
    await Promise.all(assertions);
    expect(scheduler.snapshot().queued).toEqual({ control: 0, watch: 0, timeline: 0, background: 0 });
    gate.resolve();
    await running;
  });

  it('coalesces stale timeline samples and supports queued cancellation', async () => {
    const scheduler = new NativeScheduler();
    const gate = deferred<void>();
    const running = scheduler.schedule(() => gate.promise, { priority: 'control' });
    const stale = scheduler.schedule(async () => 1, { priority: 'timeline', coalesceKey: 'sample:plan-1' });
    const latest = scheduler.schedule(async () => 2, { priority: 'timeline', coalesceKey: 'sample:plan-1' });
    const controller = new AbortController();
    const cancelled = scheduler.schedule(async () => 3, { priority: 'watch', signal: controller.signal });
    controller.abort();

    await expect(stale).rejects.toBeInstanceOf(NativeSchedulerCancelledError);
    await expect(cancelled).rejects.toBeInstanceOf(NativeSchedulerCancelledError);
    gate.resolve();
    await running;
    await expect(latest).resolves.toBe(2);
  });

  it('coalesces timeline tasks only when their keys match', async () => {
    const scheduler = new NativeScheduler();
    const gate = deferred<void>();
    const running = scheduler.schedule(() => gate.promise, { priority: 'control' });
    const staleA = scheduler.schedule(async () => 'a1', { priority: 'timeline', coalesceKey: 'plan-a' });
    const planB = scheduler.schedule(async () => 'b1', { priority: 'timeline', coalesceKey: 'plan-b' });
    const latestA = scheduler.schedule(async () => 'a2', { priority: 'timeline', coalesceKey: 'plan-a' });

    await expect(staleA).rejects.toBeInstanceOf(NativeSchedulerCancelledError);
    gate.resolve();
    await running;
    await expect(planB).resolves.toBe('b1');
    await expect(latestA).resolves.toBe('a2');
  });
});
