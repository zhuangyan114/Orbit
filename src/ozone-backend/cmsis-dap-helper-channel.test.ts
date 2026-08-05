import { describe, expect, it, vi } from 'vitest';
import { CmsisDapHelperClient } from './cmsis-dap-helper-channel';

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
});
