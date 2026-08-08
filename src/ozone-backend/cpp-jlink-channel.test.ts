import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { CppJLinkHelperClient, ExperimentalCppJLinkChannel } from './cpp-jlink-channel';
import { NativeSchedulerCancelledError } from './native-scheduler';

describe('ExperimentalCppJLinkChannel', () => {
  it('never opens a hidden koffi fallback when the helper cannot start', async () => {
    const channel = new ExperimentalCppJLinkChannel({
      helperPath: path.join(__dirname, 'missing-orbit-jlink-helper.exe'),
      requestTimeoutMs: 250,
    });

    const connected = await channel.connect({ device: 'STM32F407VG', speedKHz: 4000 });
    expect(connected.ok).toBe(false);
    expect(connected.errorCode).toBe('NativeChannelUnavailable');
    expect(channel.usingNative).toBe(false);

    await channel.dispose();
  });

  it('reports native unavailability without a channel-local fallback option', async () => {
    const channel = new ExperimentalCppJLinkChannel({
      helperPath: path.join(__dirname, 'missing-orbit-jlink-helper.exe'),
      requestTimeoutMs: 250,
    });

    const result = await channel.connect({ device: 'STM32F407VG', speedKHz: 4000 });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('NativeChannelUnavailable');
    expect(channel.usingNative).toBe(false);
  });
});

describe('CppJLinkHelperClient scheduling', () => {
  it('routes RTT lifecycle through control and RTT reads through background', async () => {
    const controlRequest = vi.spyOn(CppJLinkHelperClient.prototype, 'controlRequest').mockResolvedValue({
      ok: true,
      message: 'RTT lifecycle completed',
      targetState: 'Running',
      elapsedMs: 0,
      data: {},
    } as any);
    const request = vi.spyOn(CppJLinkHelperClient.prototype, 'request').mockResolvedValue({
      ok: true,
      message: 'RTT read',
      targetState: 'Running',
      elapsedMs: 0,
      data: { bytesBase64: '' },
    } as any);
    const channel = new ExperimentalCppJLinkChannel({ helperPath: 'unused-helper.exe' });
    (channel as any).nativeConnected = true;
    const controller = new AbortController();

    try {
      await channel.startRtt(0x20000100);
      await channel.stopRtt();
      await channel.readRtt(0, 4096, { signal: controller.signal });

      expect(controlRequest).toHaveBeenNthCalledWith(1, 'startRtt', { controlBlockAddress: 0x20000100 });
      expect(controlRequest).toHaveBeenNthCalledWith(2, 'stopRtt', {});
      expect(request).toHaveBeenCalledWith('readRtt', { bufferIndex: 0, size: 4096 }, {
        priority: 'background',
        coalesceKey: 'rtt-read',
        signal: controller.signal,
      });
    } finally {
      controlRequest.mockRestore();
      request.mockRestore();
    }
  });

  it('rejects an already cancelled request before attempting helper I/O', async () => {
    const helper = new CppJLinkHelperClient('unused-helper.exe');
    const controller = new AbortController();
    controller.abort();

    await expect(helper.request('readFastSample', {}, {
      priority: 'timeline',
      signal: controller.signal,
    })).rejects.toBeInstanceOf(NativeSchedulerCancelledError);
  });
});
