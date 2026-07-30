import { describe, expect, it, vi } from 'vitest';
import {
  RttTransport,
  RttTransportAdapter,
  RttTransportBackend,
  RttTransportBackendResult,
  RttTransportError,
  RttTransportResult,
  rttFailure,
  rttSuccess,
} from './rtt-transport';

function transportDouble(): { transport: RttTransport; notifyOwnerLoss: (error: RttTransportError) => void } {
  const listeners = new Set<(error: RttTransportError) => void>();

  const transport: RttTransport = {
    ownerKind: 'native',
    state: 'connected',
    capabilities: {
      supportsStart: true,
      supportsStop: true,
      supportsRead: true,
      supportsControlBlockAddress: true,
      supportsOwnerLoss: true,
      supportsReadStatistics: false,
      maxReadSize: 65536,
      channelCount: 16,
    },
    getControlBlockAddress: async () => rttSuccess({
      address: 0x20001000,
      source: 'elf-symbol',
      symbol: '_SEGGER_RTT',
    }),
    start: async () => rttSuccess({
      started: true,
      controlBlockAddress: {
        address: 0x20001000,
        source: 'elf-symbol',
        symbol: '_SEGGER_RTT',
      },
    }),
    stop: async () => rttSuccess({ stopped: true, wasStarted: true }),
    read: async request => rttSuccess({
      channelIndex: request.channelIndex,
      requestedSize: request.size,
      bytes: new Uint8Array(),
      empty: true,
    }),
    onOwnerLoss: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    transport,
    notifyOwnerLoss: error => listeners.forEach(listener => listener(error)),
  };
}

function backendDouble() {
  let nextRead: RttTransportBackendResult<{ bytes: Uint8Array }> = {
    ok: true,
    data: { bytes: new Uint8Array([0x52, 0x54, 0x54]) },
  };
  const backend: RttTransportBackend = {
    kind: 'native',
    startRtt: vi.fn(async () => ({ ok: true, message: 'RTT started' })),
    stopRtt: vi.fn(async () => ({ ok: true, message: 'RTT stopped' })),
    readRtt: vi.fn(async () => nextRead),
  };
  return {
    backend,
    setReadResult: (result: RttTransportBackendResult<{ bytes: Uint8Array }>) => { nextRead = result; },
  };
}

describe('RttTransport contract', () => {
  it('keeps Native/Legacy-facing operations and capability metadata in one shape', async () => {
    const { transport } = transportDouble();

    expect(transport.ownerKind).toBe('native');
    expect(transport.capabilities.maxReadSize).toBe(65536);
    await expect(transport.getControlBlockAddress()).resolves.toMatchObject({
      ok: true,
      data: { address: 0x20001000, source: 'elf-symbol' },
    });
    await expect(transport.start()).resolves.toMatchObject({ ok: true, data: { started: true } });
    await expect(transport.stop()).resolves.toMatchObject({
      ok: true,
      data: { stopped: true, wasStarted: true },
    });
  });

  it('represents a successful empty read separately from a read failure', async () => {
    const { transport } = transportDouble();
    const read = await transport.read({ channelIndex: 1, size: 4096 });

    expect(read).toMatchObject({
      ok: true,
      data: { channelIndex: 1, requestedSize: 4096, empty: true },
    });
    if (read.ok) expect(read.data.bytes).toHaveLength(0);

    const error = new RttTransportError('ReadFailed', 'negative RTT read return', 'read', {
      returnValue: -1,
      channelIndex: 1,
    });
    const failed: RttTransportResult<never> = rttFailure(error);
    expect(failed).toEqual({ ok: false, error });
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error.code).toBe('ReadFailed');
  });

  it('allows consumers to unsubscribe from owner-loss notifications', () => {
    const { transport, notifyOwnerLoss } = transportDouble();
    const listener = vi.fn();
    const unsubscribe = transport.onOwnerLoss(listener);

    const ownerLoss = new RttTransportError('OwnerLost', 'native helper exited', 'owner', {
      ownerKind: 'native',
    });
    notifyOwnerLoss(ownerLoss);
    expect(listener).toHaveBeenCalledWith(ownerLoss);

    unsubscribe();
    notifyOwnerLoss(ownerLoss);
    expect(listener).toHaveBeenCalledOnce();
    expect(new RttTransportError('ChannelGone', 'RTT channel disappeared', 'channel').category).toBe('channel');
  });

  it('adapts owner results and keeps stop idempotent', async () => {
    const { backend } = backendDouble();
    const transport = new RttTransportAdapter(backend);

    await expect(transport.stop()).resolves.toMatchObject({
      ok: true,
      data: { stopped: true, wasStarted: false },
    });
    expect(backend.stopRtt).not.toHaveBeenCalled();

    await expect(transport.start({ controlBlockAddress: 0x20001000 })).resolves.toMatchObject({
      ok: true,
      data: { started: true, controlBlockAddress: { address: 0x20001000, source: 'explicit' } },
    });
    await expect(transport.read({ channelIndex: 1, size: 16 })).resolves.toMatchObject({
      ok: true,
      data: { channelIndex: 1, requestedSize: 16, empty: false },
    });
    await expect(transport.stop()).resolves.toMatchObject({ ok: true, data: { wasStarted: true } });
    await expect(transport.stop()).resolves.toMatchObject({ ok: true, data: { wasStarted: false } });
    expect(backend.stopRtt).toHaveBeenCalledOnce();
  });

  it('maps low-level read failures and NativeOwnerLost without falling back', async () => {
    const { backend, setReadResult } = backendDouble();
    const transport = new RttTransportAdapter(backend);
    const ownerLoss = vi.fn();
    transport.onOwnerLoss(ownerLoss);
    await transport.start();

    setReadResult({ ok: false, errorCode: 'NotStarted', message: 'RTT must be started before read' });
    const notStarted = await transport.read({ channelIndex: 1, size: 16 });
    expect(notStarted).toMatchObject({ ok: false, error: { code: 'NotStarted', category: 'lifecycle' } });

    setReadResult({ ok: false, errorCode: 'JLinkCallFailed', message: 'negative RTT read return' });
    const readFailure = await transport.read({ channelIndex: 1, size: 16 });
    expect(readFailure).toMatchObject({ ok: false, error: { code: 'ReadFailed', category: 'read' } });
    expect(transport.state).toBe('started');

    setReadResult({ ok: false, errorCode: 'NativeOwnerLost', message: 'helper exited' });
    const ownerFailure = await transport.read({ channelIndex: 1, size: 16 });
    expect(ownerFailure).toMatchObject({ ok: false, error: { code: 'OwnerLost', category: 'owner' } });
    expect(transport.state).toBe('owner-lost');
    expect(ownerLoss).toHaveBeenCalledOnce();
  });

  it('maps synchronous Legacy target loss to OwnerLost and notifies stream consumers', async () => {
    const { backend, setReadResult } = backendDouble();
    const transport = new RttTransportAdapter({ ...backend, kind: 'legacy' });
    const ownerLoss = vi.fn();
    transport.onOwnerLoss(ownerLoss);
    await transport.start();

    setReadResult({ ok: false, errorCode: 'TargetDisconnected', message: 'target cable removed' });
    const result = await transport.read({ channelIndex: 1, size: 16 });

    expect(result).toMatchObject({ ok: false, error: { code: 'OwnerLost', category: 'owner' } });
    expect(transport.state).toBe('owner-lost');
    expect(ownerLoss).toHaveBeenCalledOnce();
  });
});
