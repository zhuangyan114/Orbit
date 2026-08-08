import { afterEach, describe, expect, it, vi } from 'vitest';
import { DapSession } from './dap-session';

function makeSession() {
  return new DapSession({
    async execute(command: { cmd: string }) {
      if (command.cmd === 'stopRtt') return { ok: true, data: 'RTT stopped' };
      throw new Error(`Unexpected target access: ${command.cmd}`);
    },
    async dispose() {},
  } as any);
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('DapSession event-driven target-read gate', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('hands a released Timeline gate directly to a queued Watch', async () => {
    vi.useFakeTimers();
    const session = makeSession();
    (session as any).targetReadInProgress = true;
    let acquired: boolean | undefined;
    const watch = (session as any).beginWatchTargetRead(250).then((value: boolean) => { acquired = value; });

    await flushMicrotasks();
    (session as any).endTargetRead();
    await flushMicrotasks();

    try {
      expect(acquired).toBe(true);
    } finally {
      if (acquired) (session as any).endTargetRead();
      await session.dispose();
      await vi.runAllTimersAsync();
      await watch;
    }
  });

  it('grants queued reads in foreground, Watch, Timeline, background order', async () => {
    vi.useFakeTimers();
    const session = makeSession();
    (session as any).targetReadInProgress = true;
    const granted: string[] = [];
    const waits = [
      ['background', (session as any).beginTargetReadWhenAvailable('background', 1000)],
      ['timeline', (session as any).beginTargetReadWhenAvailable('timeline', 1000)],
      ['watch', (session as any).beginTargetReadWhenAvailable('watch', 1000)],
      ['foreground', (session as any).beginTargetReadWhenAvailable('foreground', 1000)],
    ] as const;
    for (const [priority, wait] of waits) {
      void wait.then((value: boolean) => { if (value) granted.push(priority); });
    }

    await flushMicrotasks();
    (session as any).endTargetRead();
    await flushMicrotasks();

    try {
      expect(granted).toEqual(['foreground']);
      for (const expected of ['watch', 'timeline', 'background']) {
        (session as any).endTargetRead();
        await flushMicrotasks();
        expect(granted.at(-1)).toBe(expected);
      }
      expect(await Promise.all(waits.map(([, wait]) => wait))).toEqual([true, true, true, true]);
    } finally {
      (session as any).endTargetRead();
      await session.dispose();
      await vi.runAllTimersAsync();
    }
  });

  it('blocks new reads for the complete control critical section and drains without polling', async () => {
    vi.useFakeTimers();
    const session = makeSession();
    expect((session as any).beginTargetRead('timeline')).toBe(true);
    let controlAcquired: boolean | undefined;
    const control = (session as any).beginTargetControl(1200).then((value: boolean) => { controlAcquired = value; });

    await flushMicrotasks();
    expect((session as any).beginTargetRead('foreground')).toBe(false);
    (session as any).endTargetRead();
    await flushMicrotasks();

    try {
      expect(controlAcquired).toBe(true);
      expect((session as any).beginTargetRead('foreground')).toBe(false);
      (session as any).endControl();
      expect((session as any).beginTargetRead('watch')).toBe(true);
      (session as any).endTargetRead();
      await control;
    } finally {
      await session.dispose();
      await vi.runAllTimersAsync();
    }
  });

  it('times out at the requested deadline and removes the waiter timer', async () => {
    vi.useFakeTimers();
    const session = makeSession();
    (session as any).targetReadInProgress = true;
    let result: boolean | undefined;
    const wait = (session as any).beginWatchTargetRead(25).then((value: boolean) => { result = value; });

    await vi.advanceTimersByTimeAsync(25);
    await flushMicrotasks();

    try {
      expect(result).toBe(false);
      expect((session as any).targetReadWaiters).toHaveLength(0);
      expect((session as any).targetReadWaiterTimerCount).toBe(0);
      await wait;
    } finally {
      (session as any).targetReadInProgress = false;
      await session.dispose();
      await vi.runAllTimersAsync();
    }
  });

  it('removes an aborted waiter and its listener without acquiring the gate', async () => {
    vi.useFakeTimers();
    const session = makeSession();
    (session as any).targetReadInProgress = true;
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    let result: boolean | undefined;
    const wait = (session as any).beginTargetReadWhenAvailable('watch', 250, controller.signal)
      .then((value: boolean) => { result = value; return value; });

    controller.abort('cancelled by test');
    await flushMicrotasks();

    try {
      expect(result).toBe(false);
      expect((session as any).targetReadInProgress).toBe(true);
      expect((session as any).targetReadWaiters).toHaveLength(0);
      expect((session as any).targetReadWaiterTimerCount).toBe(0);
      expect(removeListener).toHaveBeenCalled();
    } finally {
      (session as any).targetReadInProgress = false;
      await session.dispose();
      await vi.runAllTimersAsync();
      await wait;
    }
  });

  it('invalidates an old-generation Watch waiter when control arrives', async () => {
    vi.useFakeTimers();
    const session = makeSession();
    (session as any).targetReadInProgress = true;
    let result: boolean | undefined;
    const wait = (session as any).beginWatchTargetRead(250)
      .then((value: boolean) => { result = value; return value; });

    await flushMicrotasks();
    (session as any).beginControl();
    await flushMicrotasks();

    try {
      expect(result).toBe(false);
      expect((session as any).targetReadWaiters).toHaveLength(0);
      expect((session as any).pendingWatchTargetReads).toBe(0);
    } finally {
      (session as any).targetReadInProgress = false;
      (session as any).endControl();
      await session.dispose();
      await vi.runAllTimersAsync();
      await wait;
    }
  });

  it('settles queued reads on termination and rejects later hardware acquisition', async () => {
    vi.useFakeTimers();
    const session = makeSession();
    (session as any).targetReadInProgress = true;
    let result: boolean | undefined;
    const wait = (session as any).beginWatchTargetRead(250)
      .then((value: boolean) => { result = value; return value; });

    await flushMicrotasks();
    await session.dispose();
    await flushMicrotasks();

    try {
      expect(result).toBe(false);
      expect((session as any).beginTargetRead('foreground')).toBe(false);
      expect((session as any).targetReadWaiters).toHaveLength(0);
      expect((session as any).targetReadWaiterTimerCount).toBe(0);
    } finally {
      (session as any).targetReadInProgress = false;
      await vi.runAllTimersAsync();
      await wait;
    }
  });

  it('never grants the same released gate to two waiters', async () => {
    vi.useFakeTimers();
    const session = makeSession();
    (session as any).targetReadInProgress = true;
    const results: boolean[] = [];
    const first = (session as any).beginWatchTargetRead(250).then((value: boolean) => { results.push(value); return value; });
    const second = (session as any).beginWatchTargetRead(250).then((value: boolean) => { results.push(value); return value; });

    await flushMicrotasks();
    (session as any).endTargetRead();
    await flushMicrotasks();

    try {
      expect(results).toEqual([true]);
      expect((session as any).targetReadInProgress).toBe(true);
      (session as any).endTargetRead();
      await flushMicrotasks();
      expect(results).toEqual([true, true]);
      await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    } finally {
      (session as any).endTargetRead();
      await session.dispose();
      await vi.runAllTimersAsync();
    }
  });

  it('allows Timeline to resume after a queued Watch completes', async () => {
    vi.useFakeTimers();
    const session = makeSession();
    expect((session as any).beginTargetRead('timeline')).toBe(true);
    let watchAcquired: boolean | undefined;
    const watch = (session as any).beginWatchTargetRead(250)
      .then((value: boolean) => { watchAcquired = value; return value; });

    await flushMicrotasks();
    (session as any).endTargetRead();
    await flushMicrotasks();

    try {
      expect(watchAcquired).toBe(true);
      expect((session as any).beginTargetRead('timeline')).toBe(false);
      (session as any).endTargetRead();
      expect((session as any).beginTargetRead('timeline')).toBe(true);
      (session as any).endTargetRead();
    } finally {
      await session.dispose();
      await vi.runAllTimersAsync();
      await watch;
    }
  });

  it('reports bounded aggregate queue, hold, and handoff diagnostics', async () => {
    let now = 100;
    const session = makeSession();
    vi.spyOn(session as any, 'nowMs').mockImplementation(() => now);
    expect((session as any).beginTargetRead('timeline')).toBe(true);
    const watch = (session as any).beginWatchTargetRead(250);
    now = 104;
    (session as any).endTargetRead();
    await watch;
    now = 107;
    (session as any).endTargetRead();

    const diagnostics = (session as any).snapshotTargetReadGateMetrics();

    expect(diagnostics.gateHoldMs).toMatchObject({ count: 2, p50: 3, p95: 4, max: 4 });
    expect(diagnostics.queueWaitMs).toMatchObject({ count: 2, p50: 0, p95: 4, max: 4 });
    expect(diagnostics.handoffGapMs).toMatchObject({ count: 1, p50: 0, p95: 0, max: 0 });
    expect(diagnostics.byPriority.watch).toMatchObject({
      queueWaitMs: { count: 1, p50: 4, p95: 4, max: 4 },
      gateHoldMs: { count: 1, p50: 3, p95: 3, max: 3 },
      handoffGapMs: { count: 1, p50: 0, p95: 0, max: 0 },
    });
    expect(diagnostics).toMatchObject({ queuedWaiters: 0, activeWaiterTimers: 0 });
  });

  it('publishes one controlled gate and backend performance snapshot when Timeline sampling stops', async () => {
    const performanceMetrics = {
      owner: 'cmsis-dap',
      planner: { planCacheHit: 4, planCacheMiss: 1 },
      cmsisDap: { available: true, usbReports: 12 },
    };
    const session = new DapSession({
      async execute(command: { cmd: string }) {
        if (command.cmd === 'getPerformanceDiagnostics') return { ok: true, data: performanceMetrics };
        if (command.cmd === 'stopRtt') return { ok: true, data: 'RTT stopped' };
        throw new Error(`Unexpected target access: ${command.cmd}`);
      },
      async dispose() {},
    } as any);
    const sent: any[] = [];
    session.on('send', message => sent.push(message));

    await (session as any).handleDataSamplingStop({ type: 'request', seq: 7, command: 'dataSamplingStop' });

    expect(sent).toEqual([expect.objectContaining({
      type: 'response',
      request_seq: 7,
      body: expect.objectContaining({
        ok: true,
        targetReadGate: expect.objectContaining({ queuedWaiters: 0, activeWaiterTimers: 0 }),
        performanceMetrics,
      }),
    })]);
  });
});
