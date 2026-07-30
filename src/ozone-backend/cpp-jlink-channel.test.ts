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
  it('rejects an already cancelled request before attempting helper I/O', async () => {
    const helper = new CppJLinkHelperClient('unused-helper.exe');
    const controller = new AbortController();
    controller.abort();

    await expect(helper.request('readFastSample', {}, {
      priority: 'timeline',
      signal: controller.signal,
    })).rejects.toBeInstanceOf(NativeSchedulerCancelledError);
  });

  it('can send an RTT request directly when the outer RTT scheduler owns serialization', async () => {
    const helper = new CppJLinkHelperClient('unused-helper.exe');
    const sendRequest = vi.spyOn(helper as any, 'sendRequest').mockResolvedValue({
      ok: true,
      message: 'RTT read',
      targetState: 'Halted',
      elapsedMs: 0,
      data: { bytesBase64: 'UlRU' },
    });

    await expect(helper.request('readRtt', { bufferIndex: 1, size: 16 }, {
      priority: 'timeline',
      bypassScheduler: true,
    })).resolves.toMatchObject({ ok: true, data: { bytesBase64: 'UlRU' } });
    expect(sendRequest).toHaveBeenCalledWith('readRtt', { bufferIndex: 1, size: 16 });
  });
});
