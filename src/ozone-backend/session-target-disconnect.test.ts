import { describe, expect, it, vi } from 'vitest';
import { CmsisDapTargetChannel, LegacyJLinkTargetChannel } from './session-target-channel';
import { JLinkDLL } from './jlink-dll';

describe('LegacyJLinkTargetChannel disconnect state', () => {
  it('reports an explicit disconnected state instead of stale running state', async () => {
    const jlink = {
      state: 'running',
      isTargetConnected: vi.fn(() => false),
      isHalted: vi.fn(() => false),
      abandon: vi.fn(function (this: { state: string }) { this.state = 'disconnected'; }),
    };
    const channel = new LegacyJLinkTargetChannel(jlink as any);

    const result = await channel.getState();

    expect(result).toMatchObject({
      ok: true,
      data: { state: 'Disconnected' },
      targetState: 'Disconnected',
    });
  });

  it('avoids target calls during forced disposal', async () => {
    const jlink = {
      disconnect: vi.fn(),
      abandon: vi.fn(),
    };
    const channel = new LegacyJLinkTargetChannel(jlink as any);

    await channel.dispose(false);

    expect(jlink.abandon).toHaveBeenCalledOnce();
    expect(jlink.disconnect).not.toHaveBeenCalled();
  });

  it('propagates a JLINK_IsHalted communication error for retry-based termination', async () => {
    const jlink = {
      state: 'running',
      isTargetConnected: vi.fn(() => true),
      probeTargetLink: vi.fn(() => true),
      getHaltState: vi.fn(() => null),
    };
    const channel = new LegacyJLinkTargetChannel(jlink as any);

    const result = await channel.getState();

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'TargetStateReadFailed',
    });
  });

  it('propagates a failed SW-DP health probe before trusting a cached halt state', async () => {
    const getHaltState = vi.fn(() => true);
    const jlink = {
      state: 'running',
      isTargetConnected: vi.fn(() => true),
      probeTargetLink: vi.fn(() => false),
      getHaltState,
    };
    const channel = new LegacyJLinkTargetChannel(jlink as any);

    const result = await channel.getState();

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'TargetStateReadFailed',
    });
    expect(getHaltState).not.toHaveBeenCalled();
  });
});

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

describe('JLinkDLL target cable health', () => {
  function connectedJLink(targetVoltageMv: number) {
    const jlink = new JLinkDLL();
    (jlink as any)._state = 'running';
    (jlink as any).lib = {
      func: vi.fn((signature: string) => {
        if (signature.includes('IsConnected')) return () => 1;
        if (signature.includes('GetHWStatus')) {
          return (status: Uint8Array) => {
            status[0] = targetVoltageMv & 0xFF;
            status[1] = (targetVoltageMv >>> 8) & 0xFF;
            return 0;
          };
        }
        throw new Error(`unexpected signature: ${signature}`);
      }),
    };
    return jlink;
  }

  it('treats a lost VTref as a disconnected target cable', () => {
    expect(connectedJLink(0).isTargetConnected()).toBe(false);
  });

  it('keeps a normally powered target connected', () => {
    expect(connectedJLink(3300).isTargetConnected()).toBe(true);
  });

  it('does not misclassify a negative JLINK_IsHalted result as halted', () => {
    const jlink = connectedJLink(3300);
    (jlink as any).lib.func = vi.fn((signature: string) => {
      if (signature.includes('IsHalted')) return () => -1;
      throw new Error(`unexpected signature: ${signature}`);
    });

    expect(jlink.getHaltState()).toBeNull();
    expect(jlink.isHalted()).toBe(false);
  });
});
