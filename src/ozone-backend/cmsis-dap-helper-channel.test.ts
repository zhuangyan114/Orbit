import { describe, expect, it, vi } from 'vitest';
import { CmsisDapHelperClient } from './cmsis-dap-helper-channel';
import { NativeSchedulerCancelledError } from './native-scheduler';

describe('CMSIS-DAP helper control critical section', () => {
  it('allows flashAlgorithm RPC overhead beyond the algorithm control timeout', async () => {
    const helper = new CmsisDapHelperClient('unused-helper-path', 20);
    (helper as any).child = {
      stdin: {
        writable: true,
        write: () => {
          setTimeout(() => {
            (helper as any).handleLine(JSON.stringify({
              id: 1,
              result: {
                ok: true,
                message: 'Flash Algorithm operation completed',
                targetState: 'Halted',
                elapsedMs: 30,
                data: { operation: 'init', returnCode: 0, pc: 0x20000502, dhcsr: 0x1010001 },
              },
            }));
          }, 1200);
        },
      },
    };

    await expect(helper.request('flashAlgorithm', { timeoutMs: 50 })).resolves.toMatchObject({
      ok: true,
      data: { operation: 'init', returnCode: 0 },
    });
  });

  it('pauses Watch, Timeline, and background work for the complete scope', async () => {
    const helper = new CmsisDapHelperClient('unused-helper-path');
    let releaseScope!: () => void;
    const scopeReleased = new Promise<void>(resolve => { releaseScope = resolve; });

    const scope = helper.withControlCriticalSection(async () => {
      expect(helper.getSchedulerSnapshot().pausedPriorities)
        .toEqual(['watch', 'timeline', 'background']);
      await scopeReleased;
    });

    expect(helper.getSchedulerSnapshot().pausedPriorities)
      .toEqual(['watch', 'timeline', 'background']);
    releaseScope();
    await scope;
    expect(helper.getSchedulerSnapshot().pausedPriorities).toEqual([]);
  });

  it('does not interleave another control request between Flash operations', async () => {
    const helper = new CmsisDapHelperClient('unused-helper-path');
    const order: string[] = [];
    let releaseScope!: () => void;
    const scopeReleased = new Promise<void>(resolve => { releaseScope = resolve; });
    (helper as any).sendRequest = vi.fn(async (method: string) => {
      order.push(method);
      return { ok: true, message: method, targetState: 'Halted', elapsedMs: 0, data: {} };
    });

    const scope = helper.withControlCriticalSection(async controlRequest => {
      await controlRequest('flash-preflight');
      await scopeReleased;
      await controlRequest('flash-program');
    });
    const competingControl = helper.request('halt');

    await Promise.resolve();
    expect(order).toEqual(['flash-preflight']);
    releaseScope();
    await scope;
    await competingControl;
    expect(order).toEqual(['flash-preflight', 'flash-program', 'halt']);
  });

  it('cancels a queued source step before it can mutate FPB state', async () => {
    const helper = new CmsisDapHelperClient('unused-helper-path');
    const sent: string[] = [];
    let releaseBlocker!: () => void;
    const blockerReleased = new Promise<void>(resolve => { releaseBlocker = resolve; });
    (helper as any).sendRequest = vi.fn(async (method: string) => {
      sent.push(method);
      if (method === 'halt') await blockerReleased;
      return { ok: true, message: method, targetState: 'Halted', elapsedMs: 0, data: {} };
    });

    const blocker = helper.request('halt', {}, { priority: 'control' });
    const abort = new AbortController();
    const sourceStep = helper.request('stepOverSourceLine', {}, {
      priority: 'control', signal: abort.signal,
    });
    abort.abort();

    await expect(sourceStep).rejects.toBeInstanceOf(NativeSchedulerCancelledError);
    expect(sent).toEqual(['halt']);
    releaseBlocker();
    await blocker;
  });

  it('lets an active source step finish helper-side cleanup before observing cancellation', async () => {
    const helper = new CmsisDapHelperClient('unused-helper-path');
    let releaseStep!: () => void;
    const stepReleased = new Promise<void>(resolve => { releaseStep = resolve; });
    (helper as any).sendRequest = vi.fn(async () => {
      await stepReleased;
      return {
        ok: true, message: 'step complete', targetState: 'Halted', elapsedMs: 1,
        data: { cleanupOk: true, restoredSlots: [0] },
      };
    });
    const abort = new AbortController();
    const sourceStep = helper.request('stepOverSourceLine', {}, {
      priority: 'control', signal: abort.signal,
    });
    await Promise.resolve();
    abort.abort();
    releaseStep();

    await expect(sourceStep).resolves.toMatchObject({
      ok: true, data: { cleanupOk: true, restoredSlots: [0] },
    });
  });
});
