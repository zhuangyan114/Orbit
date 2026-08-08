import { describe, expect, it, vi } from 'vitest';
import { createRtosViewsRefreshHandler } from './rtos-views-tracker';

describe('RTOS Views tracker callback', () => {
  it('returns a Promise and schedules the first stack refresh once', async () => {
    const schedule = vi.fn();
    const handler = createRtosViewsRefreshHandler(schedule);

    const result = handler({ event: 'first-stack-trace', sessionId: 'session-a' });
    expect(result).toBeInstanceOf(Promise);
    await result;
    await handler({ event: 'first-stack-trace', sessionId: 'session-a' });

    expect(schedule).toHaveBeenCalledTimes(1);
  });

  it('schedules again when a replacement session emits its first stack trace', async () => {
    const schedule = vi.fn();
    const handler = createRtosViewsRefreshHandler(schedule);

    await handler({ event: 'first-stack-trace', sessionId: 'session-a' });
    await handler({ event: 'first-stack-trace', sessionId: 'session-b' });

    expect(schedule).toHaveBeenCalledTimes(2);
  });

  it('ignores unrelated tracker events', async () => {
    const schedule = vi.fn();
    const handler = createRtosViewsRefreshHandler(schedule);

    await handler({ event: 'stopped', sessionId: 'session-a' });

    expect(schedule).not.toHaveBeenCalled();
  });
});
