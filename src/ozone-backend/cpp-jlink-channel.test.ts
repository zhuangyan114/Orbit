import * as fs from 'fs';
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

  it('schedules enumerateRtt at watch priority and writeRtt at control priority pausing timeline and background', async () => {
    const helper = new CppJLinkHelperClient('unused-helper.exe');
    const order: string[] = [];
    const pausedDuringWrite: string[][] = [];
    let releaseFirst!: () => void;
    const firstReleased = new Promise<void>(resolve => { releaseFirst = resolve; });
    (helper as any).sendRequest = vi.fn(async (method: string) => {
      order.push(method);
      if (method === 'writeRtt') {
        pausedDuringWrite.push([...helper.getSchedulerSnapshot().pausedPriorities]);
      }
      if (method === 'readRtt') await firstReleased;
      return { ok: true, message: method, targetState: 'Running', elapsedMs: 0, data: {} };
    });

    const runningBackground = helper.request('readRtt');
    const timeline = helper.request('readFastSample', {}, { priority: 'timeline' });
    const enumReq = helper.request('enumerateRtt', { controlBlockAddress: 0x24000100 });
    const downWrite = helper.controlRequest('writeRtt', { bufferIndex: 0, bytesBase64: 'AQID', timeoutMs: 200 });
    await Promise.resolve();
    releaseFirst();
    await Promise.all([runningBackground, timeline, enumReq, downWrite]);

    expect(order).toEqual(['readRtt', 'writeRtt', 'enumerateRtt', 'readFastSample']);
    expect(pausedDuringWrite).toEqual([['timeline', 'background']]);
    expect(helper.getSchedulerSnapshot().pausedPriorities).toEqual([]);
  });
});

function createFakeJLinkHelper(overrides: Partial<CppJLinkHelperClient> = {}): CppJLinkHelperClient {
  const defaultEnum = {
    controlBlockAddress: 0x24000100,
    maxUpBuffers: 2,
    maxDownBuffers: 1,
    upBuffers: [
      {
        direction: 'up',
        index: 0,
        descriptorAddress: 0x24000118,
        configured: true,
        valid: true,
        status: 'valid',
        name: 'Terminal',
        nameAddress: 0x24000400,
        nameStatus: 'ok',
        duplicateName: false,
        bufferAddress: 0x24001000,
        bufferSize: 64,
        wrOff: 0,
        rdOff: 0,
        flags: 0,
        mode: 0,
      },
      {
        direction: 'up',
        index: 1,
        descriptorAddress: 0x24000130,
        configured: true,
        valid: true,
        status: 'valid',
        name: 'SysView',
        nameAddress: 0x24000420,
        nameStatus: 'ok',
        duplicateName: false,
        bufferAddress: 0x24001100,
        bufferSize: 1024,
        wrOff: 4,
        rdOff: 0,
        flags: 0,
        mode: 0,
      },
    ],
    downBuffers: [
      {
        direction: 'down',
        index: 0,
        descriptorAddress: 0x24000148,
        configured: true,
        valid: true,
        status: 'valid',
        name: 'SysView',
        nameAddress: 0x24000420,
        nameStatus: 'ok',
        duplicateName: false,
        bufferAddress: 0x24002000,
        bufferSize: 64,
        wrOff: 0,
        rdOff: 0,
        flags: 1,
        mode: 1,
      },
    ],
    duplicateUpNames: [],
    duplicateDownNames: [],
    validUpCount: 2,
    validDownCount: 1,
    corruptCount: 0,
    unusedCount: 0,
  };
  const defaultWrite = {
    controlBlockAddress: 0x24000100,
    bufferIndex: 0,
    descriptorAddress: 0x24000148,
    bufferAddress: 0x24002000,
    bufferSize: 64,
    initialWrOff: 0,
    initialRdOff: 0,
    rdOff: 0,
    committedWrOff: 3,
    flags: 1,
    mode: 1,
    availableSpace: 63,
    requestedBytes: 3,
    writtenBytes: 3,
    committedBytes: 3,
    wrapped: false,
    shortWrite: false,
    skipped: false,
    firstSegmentWritten: true,
    secondSegmentWritten: false,
    wrOffWriteAttempted: true,
    wrOffCommitted: true,
    completion: 'completed',
    failureStage: 'none',
    retryable: false,
  };
  const request = vi.fn(async (method: string) => {
    switch (method) {
      case 'connect':
        return {
          ok: true,
          message: 'connected',
          targetState: 'Unknown' as const,
          elapsedMs: 1,
          data: {
            device: 'STM32H723VGT6',
            dllPath: 'mock/JLink_x64.dll',
            dllVersion: 99901,
            capabilities: ['probeDiscovery', 'basicDebug', 'readMemory', 'writeMemory', 'rtt', 'rttEnumerate', 'rttWrite'],
            dllApis: { readMem: true, writeMem: true, rttControl: true, rttRead: true, rttWrite: false },
            rttCapabilities: {
              rttStart: { available: true, evidence: 'source' },
              rttEnumerate: { available: true, evidence: 'source' },
              rttUpRead: { available: true, evidence: 'source' },
              rttDownWrite: { available: true, evidence: 'source' },
            },
          },
        };
      case 'enumerateRtt':
        return { ok: true, message: 'RTT channels enumerated', targetState: 'Running' as const, elapsedMs: 1, data: defaultEnum };
      case 'readRtt':
        return {
          ok: true,
          message: 'RTT read',
          targetState: 'Running' as const,
          elapsedMs: 1,
          data: { bytesBase64: Buffer.from([0x53, 0x56]).toString('base64'), bufferIndex: 1, committedRdOff: 2 },
        };
      default:
        return { ok: true, message: method, targetState: 'Running' as const, elapsedMs: 0, data: {} };
    }
  });
  const controlRequest = vi.fn(async (method: string) => {
    if (method === 'writeRtt') {
      return { ok: true, message: 'RTT down write committed', targetState: 'Running' as const, elapsedMs: 1, data: defaultWrite };
    }
    return { ok: true, message: method, targetState: 'Running' as const, elapsedMs: 0, data: {} };
  });
  return {
    started: false,
    start: vi.fn(async () => ({
      ok: true,
      message: 'hello',
      targetState: 'Disconnected' as const,
      elapsedMs: 0,
      data: {
        protocol: 2,
        helperVersion: '0.2.0',
        capabilities: ['probeDiscovery', 'basicDebug', 'readMemory', 'writeMemory', 'rtt', 'rttEnumerate', 'rttWrite'],
      },
    })),
    request,
    controlRequest,
    dispose: vi.fn(async () => {}),
    getSchedulerSnapshot: vi.fn(() => ({ running: false, pausedPriorities: [], queued: { control: 0, watch: 0, timeline: 0, background: 0 } })),
    ...overrides,
  } as unknown as CppJLinkHelperClient;
}

describe('ExperimentalCppJLinkChannel RTT Stage 3.3', () => {
  it('routes registered STM32H723VGT6 RTT enumerate, read, and write with capability parity', async () => {
    const helper = createFakeJLinkHelper();
    const channel = new ExperimentalCppJLinkChannel({ helperClient: helper });

    expect(channel.getRttCapabilities()).toMatchObject({
      ownerKind: 'jlink-native',
      rttStart: { available: false },
      rttEnumerate: { available: false },
      rttUpRead: { available: false },
      rttDownWrite: { available: false },
    });

    const connected = await channel.connect({ device: 'STM32H723VGT6', speedKHz: 4000, interface: 'SWD' });
    expect(connected.ok).toBe(true);
    expect(channel.getRttCapabilities()).toMatchObject({
      ownerKind: 'jlink-native',
      rttStart: { available: true, evidence: 'source' },
      rttEnumerate: { available: true, evidence: 'source' },
      rttUpRead: { available: true, evidence: 'source' },
      rttDownWrite: { available: true, evidence: 'source' },
      details: { registeredTarget: true, requiresExplicitRamRanges: false },
    });

    const enumRes = await channel.enumerateRtt(0x24000100);
    expect(enumRes).toMatchObject({
      ok: true,
      data: { validUpCount: 2, validDownCount: 1 },
      diagnostics: { ownerKind: 'jlink-native', method: 'enumerateRtt' },
    });
    expect(helper.request).toHaveBeenCalledWith(
      'enumerateRtt',
      expect.objectContaining({
        controlBlockAddress: 0x24000100,
        ramRanges: expect.arrayContaining([{ address: 0x24000000, size: 327680 }]),
        roRanges: [{ address: 0x08000000, size: 1048576 }],
      }),
      expect.objectContaining({ priority: 'watch' }),
    );

    const readRes = await channel.readRtt(1, 64);
    expect(readRes.ok && Array.from(readRes.data!.bytes)).toEqual([0x53, 0x56]);
    expect(readRes.ok && (readRes.data as any).committedRdOff).toBe(2);

    const writeRes = await channel.writeRtt(0, Uint8Array.from([1, 2, 3]), { timeoutMs: 400 });
    expect(writeRes).toMatchObject({
      ok: true,
      data: { committedBytes: 3, completion: 'completed', wrOffCommitted: true },
      diagnostics: { ownerKind: 'jlink-native', method: 'writeRtt' },
    });
    expect(helper.controlRequest).toHaveBeenCalledWith('writeRtt', {
      bufferIndex: 0,
      bytesBase64: Buffer.from([1, 2, 3]).toString('base64'),
      ramRanges: expect.arrayContaining([{ address: 0x24000000, size: 327680 }]),
      timeoutMs: 400,
    });
    await channel.dispose();
  });

  it('reports per-item RTT capabilities when DLL lacks JLINK_WriteMem and blocks unsupported calls cleanly', async () => {
    const base = createFakeJLinkHelper();
    const helper = createFakeJLinkHelper({
      request: vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
        if (method === 'connect') {
          return {
            ok: true,
            message: 'connected',
            targetState: 'Unknown' as const,
            elapsedMs: 1,
            data: {
              device: 'STM32F407VET6',
              dllPath: 'mock/JLink_x64_no_write.dll',
              dllVersion: 79000,
              capabilities: ['probeDiscovery', 'basicDebug', 'readMemory', 'rttStart', 'rttEnumerate'],
              dllApis: { readMem: true, writeMem: false, rttControl: false, rttRead: false, rttWrite: false },
              rttCapabilities: {
                rttStart: { available: true, evidence: 'source' },
                rttEnumerate: { available: true, evidence: 'source' },
                rttUpRead: { available: false, reason: 'J-Link DLL is missing JLINK_WriteMem required to advance RTT RdOff', evidence: 'source' },
                rttDownWrite: { available: false, reason: 'J-Link DLL is missing JLINK_WriteMem required for RTT Down-buffer writes', evidence: 'source' },
              },
            },
          };
        }
        return (base.request as any)(method, params);
      }) as any,
    });
    const channel = new ExperimentalCppJLinkChannel({ helperClient: helper });
    await channel.connect({ device: 'STM32F407VET6', speedKHz: 4000, interface: 'SWD' });

    expect(channel.getRttCapabilities()).toMatchObject({
      ownerKind: 'jlink-native',
      rttStart: { available: true },
      rttEnumerate: { available: true },
      rttUpRead: { available: false, reason: expect.stringContaining('JLINK_WriteMem') },
      rttDownWrite: { available: false, reason: expect.stringContaining('JLINK_WriteMem') },
    });

    await expect(channel.enumerateRtt(0x20000100)).resolves.toMatchObject({ ok: true });
    await expect(channel.readRtt(0, 16)).resolves.toMatchObject({ ok: false, errorCode: 'UnsupportedCapability' });
    await expect(channel.writeRtt(0, Uint8Array.from([1]))).resolves.toMatchObject({ ok: false, errorCode: 'UnsupportedCapability' });
    expect(helper.controlRequest).not.toHaveBeenCalledWith('writeRtt', expect.anything());
  });

  it('rejects unregistered target without ramRanges, invalid inputs, malformed responses, and surfaces NativeOwnerLost', async () => {
    const base = createFakeJLinkHelper();
    let mode: 'ok' | 'malformed-enum' | 'malformed-write' | 'crash' = 'ok';
    const helper = createFakeJLinkHelper({
      request: vi.fn(async (method: string, params: Record<string, unknown> = {}, schedule?: any) => {
        if (method === 'enumerateRtt') {
          if (mode === 'malformed-enum') {
            return { ok: true, message: 'bad', targetState: 'Running' as const, elapsedMs: 1, data: { controlBlockAddress: 0 } };
          }
          if (mode === 'crash') throw new Error('helper exited unexpectedly');
        }
        return (base.request as any)(method, params, schedule);
      }) as any,
      controlRequest: vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
        if (method === 'writeRtt' && mode === 'malformed-write') {
          return {
            ok: true,
            message: 'bad',
            targetState: 'Running' as const,
            elapsedMs: 1,
            data: { ...((await (base.controlRequest as any)('writeRtt', params)).data), wrOffCommitted: false },
          };
        }
        return (base.controlRequest as any)(method, params);
      }) as any,
    });
    const channel = new ExperimentalCppJLinkChannel({ helperClient: helper });
    await channel.connect({ device: 'UNKNOWN_JLINK_MCU', speedKHz: 4000, interface: 'SWD' });

    await expect(channel.enumerateRtt(0x20000100)).resolves.toMatchObject({ ok: false, errorCode: 'UnsupportedCapability' });
    await expect(channel.writeRtt(0, Uint8Array.from([1]))).resolves.toMatchObject({ ok: false, errorCode: 'UnsupportedCapability' });
    await expect(channel.enumerateRtt(0, { ramRanges: [{ address: 0x20000000, size: 4096 }] }))
      .resolves.toMatchObject({ ok: false, errorCode: 'DapInvalidRequest' });
    await expect(channel.writeRtt(-1, Uint8Array.from([1]), { ramRanges: [{ address: 0x20000000, size: 4096 }] }))
      .resolves.toMatchObject({ ok: false, errorCode: 'DapInvalidRequest' });

    mode = 'malformed-enum';
    await expect(channel.enumerateRtt(0x20000100, { ramRanges: [{ address: 0x20000000, size: 4096 }] }))
      .resolves.toMatchObject({ ok: false, errorCode: 'MalformedResponse' });

    mode = 'malformed-write';
    await expect(channel.writeRtt(0, Uint8Array.from([1, 2, 3]), { ramRanges: [{ address: 0x20000000, size: 4096 }] }))
      .resolves.toMatchObject({ ok: false, errorCode: 'MalformedResponse' });

    mode = 'crash';
    await expect(channel.enumerateRtt(0x20000100, { ramRanges: [{ address: 0x20000000, size: 4096 }] }))
      .resolves.toMatchObject({ ok: false, errorCode: 'NativeOwnerLost' });
    expect(channel.usingNative).toBe(false);
    expect(helper.dispose).toHaveBeenCalledWith(false);
  });

  const helperExe = path.resolve(__dirname, '..', '..', 'out', 'native', 'win32-x64', 'orbit-jlink-helper.exe');
  const fullMockDll = path.resolve(__dirname, '..', '..', 'out', 'native', 'win32-x64', 'test', 'JLink_x64.dll');
  const noWriteMockDll = path.resolve(__dirname, '..', '..', 'out', 'native', 'win32-x64', 'test', 'JLink_x64_no_write.dll');
  const nativeMockReady = fs.existsSync(helperExe) && fs.existsSync(fullMockDll) && fs.existsSync(noWriteMockDll);

  it.skipIf(!nativeMockReady)('exercises ExperimentalCppJLinkChannel end-to-end against independent mock J-Link DLLs', async () => {
    const fullChannel = new ExperimentalCppJLinkChannel({ helperPath: helperExe, requestTimeoutMs: 3000 });
    try {
      const conn = await fullChannel.connect({
        device: 'STM32F407VET6',
        speedKHz: 4000,
        interface: 'SWD',
        dllPath: fullMockDll,
      });
      expect(conn.ok).toBe(true);
      expect(fullChannel.getRttCapabilities()).toMatchObject({
        ownerKind: 'jlink-native',
        rttStart: { available: true },
        rttEnumerate: { available: true },
        rttUpRead: { available: true },
        rttDownWrite: { available: true },
      });
      const started = await fullChannel.startRtt(0x20000100);
      expect(started.ok).toBe(true);
      const enumerated = await fullChannel.enumerateRtt();
      expect(enumerated).toMatchObject({
        ok: true,
        data: { controlBlockAddress: 0x20000100, validUpCount: 1, validDownCount: 0 },
      });
      const read = await fullChannel.readRtt(0, 16);
      expect(read.ok && Buffer.from(read.data!.bytes).toString('utf8')).toBe('MEM');
      await fullChannel.stopRtt();
    } finally {
      await fullChannel.dispose(true);
    }

    const noWriteChannel = new ExperimentalCppJLinkChannel({ helperPath: helperExe, requestTimeoutMs: 3000 });
    try {
      const conn = await noWriteChannel.connect({
        device: 'STM32F407VET6',
        speedKHz: 4000,
        interface: 'SWD',
        dllPath: noWriteMockDll,
      });
      expect(conn.ok).toBe(true);
      expect(noWriteChannel.getRttCapabilities()).toMatchObject({
        ownerKind: 'jlink-native',
        rttStart: { available: true },
        rttEnumerate: { available: true },
        rttUpRead: { available: false },
        rttDownWrite: { available: false },
      });
      await expect(noWriteChannel.enumerateRtt(0x20000100)).resolves.toMatchObject({
        ok: true,
        data: {
          validUpCount: 2,
          validDownCount: 1,
          upBuffers: [
            expect.objectContaining({ direction: 'up', index: 0, name: 'Terminal' }),
            expect.objectContaining({ direction: 'up', index: 1, name: 'SysView' }),
          ],
          downBuffers: [
            expect.objectContaining({ direction: 'down', index: 0, name: 'SysView' }),
          ],
        },
      });
      await expect(noWriteChannel.readRtt(0, 16)).resolves.toMatchObject({ ok: false, errorCode: 'UnsupportedCapability' });
      await expect(noWriteChannel.writeRtt(0, Uint8Array.from([1]))).resolves.toMatchObject({ ok: false, errorCode: 'UnsupportedCapability' });
    } finally {
      await noWriteChannel.dispose(true);
    }
  });
});
