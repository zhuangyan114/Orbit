import { describe, expect, it, vi } from 'vitest';
import { createAdapterExit } from './adapter-exit';

function exitDeps(overrides: Partial<Parameters<typeof createAdapterExit>[0]> = {}) {
  return {
    dispose: vi.fn(async () => {}),
    flushStdout: vi.fn(async () => {}),
    exit: vi.fn(),
    log: vi.fn(),
    ...overrides,
  };
}

describe('createAdapterExit', () => {
  it('disposes, flushes stdout, then exits', async () => {
    const deps = exitDeps();

    await createAdapterExit(deps)(0);

    expect(deps.dispose).toHaveBeenCalledOnce();
    expect(deps.flushStdout).toHaveBeenCalledOnce();
    expect(deps.exit).toHaveBeenCalledWith(0);
  });

  it('still exits when session disposal rejects', async () => {
    const deps = exitDeps({
      dispose: vi.fn(async () => {
        throw new Error('C++ J-Link helper did not exit after termination request (pid=3844)');
      }),
    });

    await createAdapterExit(deps)(0);

    expect(deps.exit).toHaveBeenCalledWith(0);
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('helper did not exit'));
  });

  it('force-exits when session disposal never settles', async () => {
    vi.useFakeTimers();
    try {
      const deps = exitDeps({ dispose: vi.fn(() => new Promise<void>(() => {})) });

      void createAdapterExit(deps)(0);
      expect(deps.exit).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(4000);

      expect(deps.exit).toHaveBeenCalledWith(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reuses the first exit sequence for every later shutdown trigger', async () => {
    const deps = exitDeps();
    const exit = createAdapterExit(deps);

    const first = exit(0);
    const second = exit(1);

    expect(second).toBe(first);
    await first;
    expect(deps.dispose).toHaveBeenCalledOnce();
    expect(deps.exit).toHaveBeenCalledTimes(1);
  });
});
