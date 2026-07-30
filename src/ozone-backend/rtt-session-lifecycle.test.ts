import { describe, expect, it, vi } from 'vitest';
import { RttSessionLifecycle, RttPollingController } from './rtt-session-lifecycle';
import { RttTransportAdapter, RttTransportBackend } from './rtt-transport';

function makeLifecycle(enabled = true) {
  const backend: RttTransportBackend = {
    kind: 'native',
    startRtt: vi.fn(async () => ({ ok: true, message: 'RTT started' })),
    stopRtt: vi.fn(async () => ({ ok: true, message: 'RTT stopped' })),
    readRtt: vi.fn(async () => ({ ok: true, data: { bytes: new Uint8Array() } })),
  };
  const polling: RttPollingController = {
    start: vi.fn(),
    stop: vi.fn(),
  };
  const transport = new RttTransportAdapter(backend);
  const lifecycle = new RttSessionLifecycle(transport, polling, enabled);
  return { backend, polling, transport, lifecycle };
}

describe('RttSessionLifecycle', () => {
  it('starts at DAP initialized and keeps the stream across run/halt', async () => {
    const { backend, polling, lifecycle } = makeLifecycle();

    expect(lifecycle.connect()).toBe(true);
    expect(lifecycle.state).toBe('connected');
    await expect(lifecycle.initialized()).resolves.toMatchObject({ ok: true, data: { started: true } });
    lifecycle.run();
    lifecycle.halt();

    expect(lifecycle.state).toBe('halted');
    expect(backend.startRtt).toHaveBeenCalledOnce();
    expect(polling.start).toHaveBeenCalledOnce();
    expect(polling.stop).not.toHaveBeenCalled();
  });

  it('stops before reset and starts again after reset completes', async () => {
    const { backend, polling, lifecycle } = makeLifecycle();
    lifecycle.connect();
    await lifecycle.initialized();

    await expect(lifecycle.resetStarted()).resolves.toMatchObject({ ok: true, data: { wasStarted: true } });
    expect(lifecycle.state).toBe('resetting');
    expect(polling.stop).toHaveBeenCalledOnce();
    await expect(lifecycle.resetCompleted()).resolves.toMatchObject({ ok: true, data: { started: true } });
    expect(lifecycle.state).toBe('initialized');
    expect(backend.startRtt).toHaveBeenCalledTimes(2);
    expect(backend.stopRtt).toHaveBeenCalledOnce();
    expect(polling.start).toHaveBeenCalledTimes(2);
  });

  it('stops polling on owner loss and does not issue a second stop to a lost owner', async () => {
    const { polling, transport, lifecycle } = makeLifecycle();
    lifecycle.connect();
    await lifecycle.initialized();
    transport.markOwnerLost('helper exited');

    expect(lifecycle.state).toBe('owner-lost');
    expect(polling.stop).toHaveBeenCalledOnce();
    await expect(lifecycle.terminate()).resolves.toMatchObject({ ok: true, data: { stopped: false } });
    expect(lifecycle.state).toBe('terminated');
    expect(polling.stop).toHaveBeenCalledTimes(2);
  });

  it('leaves the transport untouched when RTT is disabled', async () => {
    const { backend, polling, lifecycle } = makeLifecycle(false);
    lifecycle.connect();
    await expect(lifecycle.initialized()).resolves.toEqual({ ok: true, data: null });
    await lifecycle.disconnect();

    expect(backend.startRtt).not.toHaveBeenCalled();
    expect(backend.stopRtt).not.toHaveBeenCalled();
    expect(polling.start).not.toHaveBeenCalled();
    expect(polling.stop).toHaveBeenCalledOnce();
  });
});
