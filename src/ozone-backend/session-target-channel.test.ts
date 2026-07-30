import { describe, expect, it, vi } from 'vitest';
import {
  LegacyJLinkTargetChannel,
  SessionTargetOwner,
  SessionTargetSelector,
} from './session-target-channel';
import { JLinkDLL } from './jlink-dll';

function owner(
  kind: 'native' | 'legacy',
  connect: SessionTargetOwner['connect'],
  dispose: SessionTargetOwner['dispose'] = vi.fn(async () => {}),
): SessionTargetOwner {
  return {
    kind,
    usingNative: kind === 'native',
    connect,
    disconnect: vi.fn(async () => ({
      ok: true,
      message: 'disconnected',
      targetState: 'Disconnected' as const,
      elapsedMs: 0,
      data: {},
    })),
    dispose,
  } as unknown as SessionTargetOwner;
}

describe('SessionTargetSelector owner lifecycle', () => {
  it('never constructs or connects legacy when the native owner succeeds', async () => {
    const native = owner('native', vi.fn(async () => ({
      ok: true,
      message: 'native connected',
      targetState: 'Halted' as const,
      elapsedMs: 1,
      data: { channel: 'cpp' as const },
    })));
    const createLegacy = vi.fn();
    const selector = new SessionTargetSelector(() => native, createLegacy);

    const result = await selector.connect({
      device: 'STM32F407VG',
      interface: 'SWD',
      speedKHz: 4000,
    });

    expect(result.ok).toBe(true);
    expect(selector.ownerKind).toBe('native');
    expect(createLegacy).not.toHaveBeenCalled();
  });

  it('waits for native disposal before constructing and connecting legacy fallback', async () => {
    const order: string[] = [];
    let finishDispose!: () => void;
    const disposeGate = new Promise<void>(resolve => { finishDispose = resolve; });
    const native = owner(
      'native',
      vi.fn(async () => ({
        ok: false,
        message: 'native connect failed',
        errorCode: 'JLinkConnectFailed',
        targetState: 'Error' as const,
        elapsedMs: 1,
      })),
      vi.fn(async () => {
        order.push('native-dispose-start');
        await disposeGate;
        order.push('native-dispose-finished');
      }),
    );
    const legacy = owner('legacy', vi.fn(async () => {
      order.push('legacy-connect');
      return {
        ok: true,
        message: 'legacy connected',
        targetState: 'Halted' as const,
        elapsedMs: 1,
        data: { channel: 'koffi' as const },
      };
    }));
    const createLegacy = vi.fn(() => {
      order.push('legacy-constructed');
      return legacy;
    });
    const selector = new SessionTargetSelector(() => native, createLegacy);

    const connecting = selector.connect({
      device: 'STM32F407VG',
      interface: 'SWD',
      speedKHz: 4000,
    }, true);
    await vi.waitFor(() => expect(order).toEqual(['native-dispose-start']));
    expect(createLegacy).not.toHaveBeenCalled();

    finishDispose();
    const result = await connecting;

    expect(result.ok).toBe(true);
    expect(selector.ownerKind).toBe('legacy');
    expect(order).toEqual([
      'native-dispose-start',
      'native-dispose-finished',
      'legacy-constructed',
      'legacy-connect',
    ]);
  });

  it('uses legacy directly when native ownership is not requested', async () => {
    const createNative = vi.fn();
    const legacy = owner('legacy', vi.fn(async () => ({
      ok: true,
      message: 'legacy connected',
      targetState: 'Halted' as const,
      elapsedMs: 1,
      data: { channel: 'koffi' as const },
    })));
    const selector = new SessionTargetSelector(createNative, () => legacy);

    const result = await selector.connect({
      device: 'STM32F407VG',
      interface: 'SWD',
      speedKHz: 4000,
    }, 'legacy');

    expect(result.ok).toBe(true);
    expect(selector.ownerKind).toBe('legacy');
    expect(createNative).not.toHaveBeenCalled();
    expect(selector.getRttTransport()?.capabilities.supportsOwnerLoss).toBe(true);
    expect(selector.getRttTransport()?.capabilities.supportsReadStatistics).toBe(false);
  });

  it('reports Legacy RTT reads before start with the shared NotStarted error code', async () => {
    const jlink = {
      connected: true,
      state: 'halted',
      isRttStarted: () => false,
    } as unknown as JLinkDLL;
    const channel = new LegacyJLinkTargetChannel(jlink);

    await expect(channel.readRtt(1, 16)).resolves.toMatchObject({
      ok: false,
      errorCode: 'NotStarted',
    });
  });

  it('lets Legacy synchronously report target loss after a failed RTT read', async () => {
    const jlink = {
      connected: true,
      state: 'halted',
      isRttStarted: () => true,
      readRtt: vi.fn(() => null),
      isTargetConnected: vi.fn(() => false),
      abandon: vi.fn(),
    } as unknown as JLinkDLL;
    const channel = new LegacyJLinkTargetChannel(jlink);

    await expect(channel.readRtt(1, 16)).resolves.toMatchObject({
      ok: false,
      errorCode: 'TargetDisconnected',
    });
    expect(jlink.abandon).toHaveBeenCalledOnce();
  });

  it('does not construct a legacy owner after a connected native owner is lost', async () => {
    const order: string[] = [];
    const native = owner('native', vi.fn(async () => ({
      ok: true,
      message: 'native connected',
      targetState: 'Halted' as const,
      elapsedMs: 0,
      data: { channel: 'cpp' as const },
    })));
    native.halt = vi.fn(async () => {
      order.push('native-halt');
      return {
        ok: false,
        message: 'helper exited',
        errorCode: 'NativeOwnerLost',
        targetState: 'Error' as const,
        elapsedMs: 0,
      };
    });
    native.dispose = vi.fn(async () => { order.push('native-disposed'); });

    const legacy = owner('legacy', vi.fn(async () => {
      order.push('legacy-connect');
      return {
        ok: true,
        message: 'legacy connected',
        targetState: 'Halted' as const,
        elapsedMs: 0,
        data: { channel: 'koffi' as const },
      };
    }));
    const selector = new SessionTargetSelector(() => native, () => {
      order.push('legacy-constructed');
      return legacy;
    });
    await selector.connect({ device: 'STM32F407VG', interface: 'SWD', speedKHz: 4000 }, true);

    const failed = await selector.halt();
    expect(failed.ok).toBe(false);
    expect(native.halt).toHaveBeenCalledOnce();
    expect(failed.message).toContain('restart the debug session in legacy mode');
    expect(order).toEqual(['native-halt', 'native-disposed']);
    expect(selector.ownerKind).toBe('none');
    expect(legacy.connect).not.toHaveBeenCalled();

    const next = await selector.run();
    expect(next).toMatchObject({ ok: false, errorCode: 'TargetOwnerUnavailable' });
  });

  it('returns a diagnostic error without constructing legacy in explicit native mode', async () => {
    const native = owner('native', vi.fn(async () => ({
      ok: false,
      message: 'helper handshake failed',
      errorCode: 'NativeChannelUnavailable',
      targetState: 'Error' as const,
      elapsedMs: 1,
    })));
    const createLegacy = vi.fn();
    const selector = new SessionTargetSelector(() => native, createLegacy);

    const result = await selector.connect({ device: 'STM32F407VG', interface: 'SWD', speedKHz: 4000 }, 'native');

    expect(result).toMatchObject({ ok: false, errorCode: 'NativeInitializationFailed' });
    expect(result.message).toContain('restart the debug session in legacy mode');
    expect(native.dispose).toHaveBeenCalledWith(false);
    expect(createLegacy).not.toHaveBeenCalled();
    expect(selector.ownerKind).toBe('none');
  });
});
