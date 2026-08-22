import { describe, expect, it, vi } from 'vitest';
import { AutomationApiLifecycle } from './automation-api-lifecycle';

interface TestServer {
  start(): Promise<void>;
  dispose(): Promise<void>;
}

describe('AutomationApiLifecycle', () => {
  it('stays disabled by default and toggles one server instance idempotently', async () => {
    const start = vi.fn(async () => undefined);
    const dispose = vi.fn(async () => undefined);
    const create = vi.fn((): TestServer => ({ start, dispose }));
    const lifecycle = new AutomationApiLifecycle(create);

    await lifecycle.setEnabled(false);
    expect(create).not.toHaveBeenCalled();
    await lifecycle.setEnabled(true);
    await lifecycle.setEnabled(true);
    expect(create).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(lifecycle.isEnabled()).toBe(true);

    await lifecycle.setEnabled(false);
    await lifecycle.setEnabled(false);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(lifecycle.isEnabled()).toBe(false);
  });

  it('serializes hot toggles and disposes an instance that finishes starting after disable', async () => {
    let releaseStart!: () => void;
    const started = new Promise<void>(resolve => { releaseStart = resolve; });
    const dispose = vi.fn(async () => undefined);
    const lifecycle = new AutomationApiLifecycle<TestServer>(() => ({
      start: () => started,
      dispose,
    }));

    const enabling = lifecycle.setEnabled(true);
    const disabling = lifecycle.setEnabled(false);
    releaseStart();
    await Promise.all([enabling, disabling]);

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(lifecycle.isEnabled()).toBe(false);
  });

  it('keeps the active instance visible until asynchronous disposal completes', async () => {
    let releaseDispose!: () => void;
    const disposing = new Promise<void>(resolve => { releaseDispose = resolve; });
    let markDisposeStarted!: () => void;
    const disposeStarted = new Promise<void>(resolve => { markDisposeStarted = resolve; });
    const server: TestServer = {
      start: async () => undefined,
      dispose: () => {
        markDisposeStarted();
        return disposing;
      },
    };
    const lifecycle = new AutomationApiLifecycle(() => server);
    await lifecycle.setEnabled(true);

    const disabling = lifecycle.setEnabled(false);
    await disposeStarted;

    expect(lifecycle.getActive()).toBe(server);
    expect(lifecycle.isEnabled()).toBe(true);
    releaseDispose();
    await disabling;
    expect(lifecycle.getActive()).toBeUndefined();
    expect(lifecycle.isEnabled()).toBe(false);
  });

  it('runs the activation hook after start and before publishing each active instance', async () => {
    const order: string[] = [];
    const servers: TestServer[] = [];
    let lifecycle!: AutomationApiLifecycle<TestServer>;
    lifecycle = new AutomationApiLifecycle<TestServer>(
      () => {
        const server: TestServer = {
          start: async () => { order.push('start'); },
          dispose: async () => undefined,
        };
        servers.push(server);
        return server;
      },
      () => {
        order.push('reset');
        expect(lifecycle.getActive()).toBeUndefined();
      },
    );

    await lifecycle.setEnabled(true);
    expect(order).toEqual(['start', 'reset']);
    expect(lifecycle.getActive()).toBe(servers[0]);
    await lifecycle.setEnabled(false);
    await lifecycle.setEnabled(true);
    expect(order).toEqual(['start', 'reset', 'start', 'reset']);
    expect(lifecycle.getActive()).toBe(servers[1]);
  });

  it('cleans up a failed start and permits a later enable retry', async () => {
    const firstDispose = vi.fn(async () => undefined);
    const secondDispose = vi.fn(async () => undefined);
    let attempt = 0;
    const lifecycle = new AutomationApiLifecycle<TestServer>(() => {
      attempt += 1;
      return attempt === 1
        ? { start: async () => { throw new Error('bind failed'); }, dispose: firstDispose }
        : { start: async () => undefined, dispose: secondDispose };
    });

    await expect(lifecycle.setEnabled(true)).rejects.toThrow('bind failed');
    expect(firstDispose).toHaveBeenCalledTimes(1);
    expect(lifecycle.isEnabled()).toBe(false);
    await lifecycle.setEnabled(true);
    expect(lifecycle.isEnabled()).toBe(true);
  });
});
