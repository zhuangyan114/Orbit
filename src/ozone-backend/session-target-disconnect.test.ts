import { describe, expect, it, vi } from 'vitest';
import { CmsisDapTargetChannel } from './session-target-channel';

describe('CmsisDapTargetChannel forced disposal', () => {
  function connectedChannel() {
    const helper = {
      dispose: vi.fn(async () => {}),
      request: vi.fn(async () => ({ ok: true, message: 'ok', targetState: 'Disconnected', elapsedMs: 0, data: {} })),
      controlRequest: vi.fn(async () => ({ ok: true, message: 'ok', targetState: 'Disconnected', elapsedMs: 0, data: {} })),
      getPerformanceSnapshot: vi.fn(() => ({})),
    };
    const channel = new CmsisDapTargetChannel({ helperClient: helper as any });
    (channel as any).state = 'connected';
    return { channel, helper };
  }

  it('releases the helper on forced disposal without queueing owner RPCs behind a flash', async () => {
    const { channel, helper } = connectedChannel();

    await channel.dispose(false);

    expect(helper.dispose).toHaveBeenCalledWith(false);
    expect(helper.request).not.toHaveBeenCalled();
    expect(helper.controlRequest).not.toHaveBeenCalled();
  });

  it('keeps the graceful handshake on normal disposal', async () => {
    const { channel, helper } = connectedChannel();

    await channel.dispose(true);

    expect(helper.request).toHaveBeenCalledWith('disconnect', {});
    expect(helper.request).toHaveBeenCalledWith('close', {});
    expect(helper.dispose).toHaveBeenCalledWith(true);
  });
});
