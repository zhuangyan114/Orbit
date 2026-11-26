import { describe, expect, it, vi } from 'vitest';
import {
  CmsisDapTargetChannel,
  SessionTargetOwner,
  SessionTargetSelector,
} from './session-target-channel';
import { ExperimentalCppJLinkChannel } from './cpp-jlink-channel';
import { CmsisDapDeviceInfo, CmsisDapHelperClient } from './cmsis-dap-helper-channel';
import type { FlashAlgorithmRunRequest } from './cmsis-dap-flasher';

const fakeDevice = {
  path: 'MOCK\\1234#5678#MOCK-0001',
  vid: '1234',
  pid: '5678',
  manufacturer: 'MockVendor',
  product: 'Mock CMSIS-DAP',
  serial: 'MOCK-0001',
  inputReportLength: 65,
  outputReportLength: 65,
  reportId: 0,
  usagePage: 0xFF00,
  usage: 1,
  transport: 'mock',
};

/** In-memory helper client that never touches a real process or USB device. */
function fakeCmsisDapHelper(overrides: Partial<CmsisDapHelperClient> = {}): CmsisDapHelperClient {
  return {
    start: vi.fn(async () => ({
      ok: true,
      message: 'hello',
      targetState: 'Disconnected' as const,
      elapsedMs: 0,
      data: { protocol: 1, helperVersion: 'test', platform: 'win32-x64', capabilities: [] },
    })),
    request: vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
      switch (method) {
        case 'enumDevices':
          return {
            ok: true,
            message: 'enumerated',
            targetState: 'Disconnected' as const,
            elapsedMs: 0,
            data: { devices: [fakeDevice] },
          };
        case 'open':
          return {
            ok: true,
            message: 'opened',
            targetState: 'Unknown' as const,
            elapsedMs: 0,
            data: fakeDevice,
          };
        case 'getInfo':
          return {
            ok: true,
            message: 'info',
            targetState: 'Unknown' as const,
            elapsedMs: 0,
            data: {
              vendor: 'MockVendor',
              product: 'Mock CMSIS-DAP',
              serial: 'MOCK-0001',
              firmwareVersion: '1.2.3',
              protocolVersion: '1.0',
              capabilities: [1],
              packetCount: 1,
              packetSize: 64,
              protocolPacketSize: 64,
              effectivePacketSize: 64,
              packetSizeSource: 'protocol-info',
            },
          };
      case 'connect':
        return {
          ok: true,
          message: 'connected',
          targetState: 'Unknown' as const,
          elapsedMs: 0,
          data: { port: 'SWD', connectResponse: 1 },
        };
        case 'getFpbInfo':
          return {
            ok: true,
            message: 'FPB ownership claimed',
            targetState: 'Running' as const,
            elapsedMs: 1,
            data: {
              fpCtrl: 0x260,
              revision: 1,
              codeComparators: 6,
              literalComparators: 0,
              enabled: false,
            },
          };
        case 'getState':
          return {
            ok: true,
            message: 'state',
            targetState: 'Halted' as const,
            elapsedMs: 0,
            data: { state: 'Halted', dhcsr: 0x00030001, pc: 0x080001C0 },
          };
        case 'halt':
        case 'reset':
          return {
            ok: true,
            message: method,
            targetState: 'Halted' as const,
            elapsedMs: 0,
            data: { state: 'Halted', dhcsr: 0x00030001, pc: 0x080001C0 },
          };
        case 'run':
          return {
            ok: true,
            message: 'run',
            targetState: 'Running' as const,
            elapsedMs: 0,
            data: { state: 'Running', dhcsr: 1 },
          };
        case 'stepInstruction':
          return {
            ok: true,
            message: 'step',
            targetState: 'Halted' as const,
            elapsedMs: 0,
            data: { state: 'Halted', dhcsr: 0x00030001, pcBefore: 0x080001C0, pcAfter: 0x080001C2 },
          };
        case 'setBreakpoint':
          return {
            ok: true,
            message: 'breakpoint set',
            targetState: 'Halted' as const,
            elapsedMs: 1,
            data: { slot: 2, address: params.address, fpbRevision: 1, codeComparators: 6 },
          };
        case 'clearBreakpoint':
        case 'clearAllBreakpoints':
          return {
            ok: true,
            message: 'breakpoint cleared',
            targetState: 'Halted' as const,
            elapsedMs: 1,
            data: { slot: params.slot, cleared: 1 },
          };
        case 'stepIntoSourceLine':
        case 'stepOverSourceLine':
        case 'stepOut':
          return {
            ok: true,
            message: method,
            targetState: 'Halted' as const,
            elapsedMs: 1,
            data: {
              pcBefore: 0x080001C0,
              pcAfter: 0x080001C6,
              classification: method,
              instructions: 2,
              cleanupOk: true,
              timings: { haltMs: 0, readPcMs: 0, decodeMs: 0, executeMs: 0, waitMs: 0, cleanupMs: 0, totalMs: 1 },
            },
          };
        case 'readRegister':
          return {
            ok: true,
            message: 'register',
            targetState: 'Halted' as const,
            elapsedMs: 0,
            data: { register: params.index, value: params.index === 15 ? 0x080001C0 : 0x10000000 },
          };
        case 'readMemory':
          return {
            ok: true,
            message: 'memory read',
            targetState: 'Unknown' as const,
            elapsedMs: 0,
            data: {
              address: (params as { address: number }).address,
              size: (params as { size: number }).size,
              bytes: [1, 2, 3, 4],
            },
            diagnostics: {
              chunks: 1,
              packets: 6,
              blockReads: 1,
              blockWrites: 0,
              waitRetries: 0,
              faultClears: 0,
              packetSize: 64,
            },
          };
        case 'readMemoryBatch': {
          const reads = (params as { reads: Array<{ address: number; size: number }> }).reads;
          return {
            ok: true,
            message: 'memory batch read',
            targetState: 'Unknown' as const,
            elapsedMs: 0,
            data: {
              reads: reads.map((read, index) => ({
                address: read.address,
                size: read.size,
                bytes: Array.from({ length: read.size }, (_, byteIndex) => index * 16 + byteIndex + 1),
              })),
            },
            diagnostics: {
              completedReads: reads.length,
              packedReads: reads.length,
              fallbackReads: 0,
            },
          };
        }
        case 'writeMemory':
          return {
            ok: true,
            message: 'memory written',
            targetState: 'Halted' as const,
            elapsedMs: 1,
            data: {
              address: (params as { address: number }).address,
              bytesWritten: (params as { bytes: number[] }).bytes.length,
            },
          };
        case 'startRtt':
          return {
            ok: true,
            message: 'RTT started',
            targetState: 'Running' as const,
            elapsedMs: 2,
            data: { controlBlockAddress: params.controlBlockAddress },
            diagnostics: { ownerKind: 'cmsis-dap', bufferIndex: 0 },
          };
        case 'enumerateRtt':
          return {
            ok: true,
            message: 'RTT channels enumerated',
            targetState: 'Running' as const,
            elapsedMs: 2,
            data: {
              controlBlockAddress: (params.controlBlockAddress as number) ?? 0x20000100,
              maxUpBuffers: 2,
              maxDownBuffers: 1,
              upBuffers: [
                {
                  direction: 'up',
                  index: 0,
                  descriptorAddress: 0x20000118,
                  configured: true,
                  valid: true,
                  status: 'valid',
                  name: 'Terminal',
                  nameAddress: 0x08001000,
                  nameStatus: 'ok',
                  duplicateName: false,
                  bufferAddress: 0x20001000,
                  bufferSize: 1024,
                  wrOff: 0,
                  rdOff: 0,
                  flags: 0,
                  mode: 0,
                },
                {
                  direction: 'up',
                  index: 1,
                  descriptorAddress: 0x20000130,
                  configured: true,
                  valid: true,
                  status: 'valid',
                  name: 'SysView',
                  nameAddress: 0x08001010,
                  nameStatus: 'ok',
                  duplicateName: false,
                  bufferAddress: 0x20001400,
                  bufferSize: 2048,
                  wrOff: 0,
                  rdOff: 0,
                  flags: 0,
                  mode: 0,
                },
              ],
              downBuffers: [
                {
                  direction: 'down',
                  index: 0,
                  descriptorAddress: 0x20000148,
                  configured: true,
                  valid: true,
                  status: 'valid',
                  name: 'SysView',
                  nameAddress: 0x08001010,
                  nameStatus: 'ok',
                  duplicateName: false,
                  bufferAddress: 0x20002000,
                  bufferSize: 128,
                  wrOff: 0,
                  rdOff: 0,
                  flags: 0,
                  mode: 0,
                },
              ],
              duplicateUpNames: [],
              duplicateDownNames: [],
              validUpCount: 2,
              validDownCount: 1,
              corruptCount: 0,
              unusedCount: 0,
            },
            diagnostics: { ownerKind: 'cmsis-dap' },
          };
        case 'readRtt':
          return {
            ok: true,
            message: 'RTT read',
            targetState: 'Running' as const,
            elapsedMs: 3,
            data: {
              bytes: [65, 66],
              descriptorAddress: 0x20000118,
              flags: 2,
              mode: 2,
              readBytes: 2,
              committedRdOff: 2,
            },
            diagnostics: { ownerKind: 'cmsis-dap', readBytes: 2 },
          };
        case 'stopRtt':
          return {
            ok: true,
            message: 'RTT stopped',
            targetState: 'Running' as const,
            elapsedMs: 1,
            data: { started: false },
          };
        case 'writeRtt': {
          const requested = Array.isArray(params.bytes) ? params.bytes.length : 0;
          return {
            ok: true,
            message: 'RTT down write committed',
            targetState: 'Running' as const,
            elapsedMs: 2,
            data: {
              controlBlockAddress: (params.controlBlockAddress as number) ?? 0x20000100,
              bufferIndex: (params.bufferIndex as number) ?? 0,
              descriptorAddress: 0x20000148,
              bufferAddress: 0x20002000,
              bufferSize: 128,
              initialWrOff: 0,
              initialRdOff: 0,
              rdOff: 0,
              committedWrOff: requested,
              flags: 0,
              mode: 0,
              availableSpace: 127,
              requestedBytes: requested,
              writtenBytes: requested,
              committedBytes: requested,
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
            },
            diagnostics: { ownerKind: 'cmsis-dap' },
          };
        }
        case 'disconnect':
        case 'close':
          return {
            ok: true,
            message: 'done',
            targetState: 'Disconnected' as const,
            elapsedMs: 0,
            data: {},
          };
        default:
          throw new Error(`unexpected request ${method}`);
      }
    }),
    controlRequest: vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
      if (overrides.request) {
        return (overrides.request as any)(method, params, { priority: 'control' });
      }
      return (fakeCmsisDapHelper().request as any)(method, params, { priority: 'control' });
    }),
    withControlCriticalSection: vi.fn(async (execute: (request: any) => Promise<unknown>) =>
      execute(async () => ({ ok: true, message: 'fake control request', targetState: 'Halted', elapsedMs: 0, data: {} }))),
    dispose: vi.fn(async () => {}),
    ...overrides,
  } as unknown as CmsisDapHelperClient;
}

function owner(
  connect: SessionTargetOwner['connect'],
  dispose: SessionTargetOwner['dispose'] = vi.fn(async () => {}),
): SessionTargetOwner {
  return {
    kind: 'jlink-native',
    usingNative: true,
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
  it('auto discovery selects J-Link first without constructing CMSIS-DAP', async () => {
    const jlink = owner(vi.fn());
    jlink.detectProbe = vi.fn(async () => ({
      ok: true,
      message: 'J-Link probe found',
      targetState: 'Disconnected' as const,
      elapsedMs: 1,
      data: { available: true },
    }));
    const createCmsisDap = vi.fn();
    const selector = new SessionTargetSelector(() => jlink, createCmsisDap);

    await expect(selector.resolveProbe({
      probe: 'auto', device: 'STM32F407VG', interface: 'SWD', speedKHz: 4000,
    })).resolves.toMatchObject({ ok: true, data: { probe: 'jlink' } });
    expect(createCmsisDap).not.toHaveBeenCalled();
    expect(jlink.dispose).toHaveBeenCalledWith(false);
    expect(selector.ownerKind).toBe('none');
  });

  it('auto discovery selects CMSIS-DAP only when J-Link is unavailable', async () => {
    const jlink = owner(vi.fn());
    jlink.detectProbe = vi.fn(async () => ({
      ok: true,
      message: 'no J-Link probe found',
      targetState: 'Disconnected' as const,
      elapsedMs: 1,
      data: { available: false },
    }));
    const cmsisDap = {
      ...owner(vi.fn()),
      kind: 'cmsis-dap' as const,
      detectProbe: vi.fn(async () => ({
        ok: true,
        message: 'CMSIS-DAP probe found',
        targetState: 'Disconnected' as const,
        elapsedMs: 1,
        data: { available: true, count: 1 },
      })),
    } as unknown as SessionTargetOwner;
    const selector = new SessionTargetSelector(() => jlink, () => cmsisDap);

    await expect(selector.resolveProbe({
      probe: 'auto', device: 'STM32F407VG', interface: 'SWD', speedKHz: 4000,
    })).resolves.toMatchObject({ ok: true, data: { probe: 'cmsis-dap' } });
    expect(jlink.dispose).toHaveBeenCalledWith(false);
    expect(cmsisDap.dispose).toHaveBeenCalledWith(false);
    expect(selector.ownerKind).toBe('none');
  });

  it.each(['hid', 'winusb', 'tcp'] as const)('keeps XR disabled for ordinary %s connections and direct sampling requests', async transport => {
    const helper = fakeCmsisDapHelper();
    const channel = new CmsisDapTargetChannel({ helperClient: helper });
    expect((await channel.connect({ device: 'STM32F407VET6', interface: 'SWD', speedKHz: 1000,
      probe: 'cmsis-dap', cmsisDapTransport: transport })).ok).toBe(true);
    expect(await channel.supportsProbeSampling()).toBe(false);
    expect(await channel.startProbeSampling(1000, [])).toMatchObject({ ok: false, errorCode: 'UnsupportedCapability' });
    expect(await channel.readProbeSampling()).toMatchObject({ ok: false, errorCode: 'UnsupportedCapability' });
    expect(await channel.stopProbeSampling()).toMatchObject({ ok: false, errorCode: 'UnsupportedCapability' });
    expect((helper.request as any).mock.calls.some(([method]: [string]) => method.startsWith('xr'))).toBe(false);
    expect((helper.controlRequest as any).mock.calls.some(([method]: [string]) => method.startsWith('xr'))).toBe(false);
    const open = (helper.request as any).mock.calls.find(([method]: [string]) => method === 'open');
    expect(open[1]).not.toHaveProperty('xrSampling');
    await channel.disconnect();
  });

  it('passes explicit XR opt-in to the same helper and clears it when reconnecting normally', async () => {
    const base = fakeCmsisDapHelper();
    const helper = fakeCmsisDapHelper({ request: vi.fn(async (method: string, params: any, options: any) => {
      if (method === 'xrInfo') return { ok: true, data: { features: 4 } };
      return base.request(method, params, options);
    }) as any });
    const channel = new CmsisDapTargetChannel({ helperClient: helper });
    const config = { device: 'STM32F407VET6', interface: 'SWD' as const, speedKHz: 1000, probe: 'cmsis-dap' as const };
    expect((await channel.connect({ ...config, cmsisDapXrSampling: true })).ok).toBe(true);
    expect(helper.request).toHaveBeenCalledWith('open', expect.objectContaining({ xrSampling: true }));
    expect(await channel.supportsProbeSampling()).toBe(true);
    expect(await channel.supportsProbeSampling()).toBe(true);
    expect((helper.request as any).mock.calls.filter(([method]: [string]) => method === 'xrInfo')).toHaveLength(1);
    await channel.disconnect();
    expect((await channel.connect(config)).ok).toBe(true);
    expect(await channel.supportsProbeSampling()).toBe(false);
    expect((helper.request as any).mock.calls.filter(([method]: [string]) => method === 'xrInfo')).toHaveLength(1);
    await channel.disconnect();
  });

  it('routes CMSIS-DAP RTT through the helper owner with structured results', async () => {
    const helper = fakeCmsisDapHelper();
    const channel = new CmsisDapTargetChannel({ helperClient: helper });
    const connected = await channel.connect({
      device: 'STM32F407VET6',
      interface: 'SWD',
      speedKHz: 1000,
      probe: 'cmsis-dap',
    });
    expect(connected.ok).toBe(true);

    const started = await channel.startRtt(0x20000100);
    const read = await channel.readRtt(0, 128);
    const stopped = await channel.stopRtt();

    expect(started).toMatchObject({
      ok: true,
      data: { controlBlockAddress: 0x20000100 },
      diagnostics: { ownerKind: 'cmsis-dap' },
    });
    expect(read).toMatchObject({
      ok: true,
      data: {
        descriptorAddress: 0x20000118,
        flags: 2,
        mode: 2,
        readBytes: 2,
        committedRdOff: 2,
      },
      diagnostics: { readBytes: 2 },
    });
    expect(read.ok && read.data?.bytes).toBeInstanceOf(Uint8Array);
    expect(stopped.ok).toBe(true);
    expect(helper.controlRequest).toHaveBeenCalledWith('startRtt', expect.objectContaining({
      controlBlockAddress: 0x20000100,
      ramRanges: [{ address: 0x20000000, size: 131072 }],
    }));
    expect(helper.request).toHaveBeenCalledWith('readRtt', expect.anything(), expect.objectContaining({
      priority: 'background',
    }));
  });

  it('forwards registered STM32H723 RAM/RO ranges to startRtt and enumerateRtt and preserves single owner', async () => {
    const helper = fakeCmsisDapHelper();
    const channel = new CmsisDapTargetChannel({ helperClient: helper });
    const createNative = vi.fn();
    const selector = new SessionTargetSelector(createNative, () => channel);

    const connected = await selector.connect({
      device: 'STM32H723VGT6',
      interface: 'SWD',
      speedKHz: 1000,
      probe: 'cmsis-dap',
    });
    expect(connected.ok).toBe(true);

    const started = await selector.startRtt(0x24000100);
    expect(started.ok).toBe(true);
    expect(helper.controlRequest).toHaveBeenCalledWith('startRtt', expect.objectContaining({
      controlBlockAddress: 0x24000100,
      ramRanges: expect.arrayContaining([
        { address: 0x00000000, size: 65536 },
        { address: 0x20000000, size: 131072 },
        { address: 0x24000000, size: 327680 },
      ]),
    }));

    const enumerated = await selector.enumerateRtt(0x24000100);
    expect(enumerated).toMatchObject({
      ok: true,
      data: {
        controlBlockAddress: 0x24000100,
        validUpCount: 2,
        validDownCount: 1,
      },
      diagnostics: { ownerKind: 'cmsis-dap', method: 'enumerateRtt' },
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
    expect(createNative).not.toHaveBeenCalled();
    await selector.dispose(false);
  });

  it('rejects invalid RAM ranges and unregistered enumerateRtt without explicit ranges, while keeping legacy startRtt', async () => {
    const helper = fakeCmsisDapHelper();
    const channel = new CmsisDapTargetChannel({ helperClient: helper });
    await channel.connect({
      device: 'STM32F429VGT6',
      interface: 'SWD',
      speedKHz: 1000,
      probe: 'cmsis-dap',
    });

    // Unregistered device without explicit ramRanges: startRtt omits ramRanges for legacy compatibility
    const legacyStart = await channel.startRtt(0x20000100);
    expect(legacyStart.ok).toBe(true);
    const startParams = (helper.controlRequest as any).mock.calls[1][1];
    expect(startParams).not.toHaveProperty('ramRanges');

    // Unregistered device without explicit ramRanges: enumerateRtt reports UnsupportedCapability
    await expect(channel.enumerateRtt(0x20000100)).resolves.toMatchObject({
      ok: false,
      errorCode: 'UnsupportedCapability',
    });

    // Explicit invalid ramRanges rejected before helper RPC
    await expect(channel.startRtt(0x20000100, { ramRanges: [] })).resolves.toMatchObject({
      ok: false,
      errorCode: 'DapInvalidRequest',
    });
    await expect(channel.enumerateRtt(0x20000100, {
      ramRanges: [{ address: 0x20000000, size: 0x2000 }, { address: 0x20001000, size: 0x1000 }],
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'DapInvalidRequest',
    });

    // Unregistered device WITH explicit ramRanges succeeds (omitted timeoutMs defaults to 2000)
    await expect(channel.enumerateRtt(0x20000100, {
      ramRanges: [{ address: 0x20000000, size: 0x10000 }],
    })).resolves.toMatchObject({ ok: true });

    // Explicit invalid controlBlockAddress and timeoutMs fail with DapInvalidRequest without calling helper
    const requestsBeforeInvalid = (helper.request as any).mock.calls.length;
    for (const badAddr of [null, -1, '0x20000100', 0, 1.5] as unknown[]) {
      await expect(channel.enumerateRtt(badAddr as number, {
        ramRanges: [{ address: 0x20000000, size: 0x10000 }],
      })).resolves.toMatchObject({ ok: false, errorCode: 'DapInvalidRequest' });
    }
    for (const badTimeout of [null, 0, -5, '1000', 1.5, 10001] as unknown[]) {
      await expect(channel.enumerateRtt(0x20000100, {
        ramRanges: [{ address: 0x20000000, size: 0x10000 }],
        timeoutMs: badTimeout as number,
      })).resolves.toMatchObject({ ok: false, errorCode: 'DapInvalidRequest' });
    }
    expect((helper.request as any).mock.calls.length).toBe(requestsBeforeInvalid);

    // Omitted controlBlockAddress forwards without controlBlockAddress property
    await expect(channel.enumerateRtt(undefined, {
      ramRanges: [{ address: 0x20000000, size: 0x10000 }],
    })).resolves.toMatchObject({ ok: true });
    const omittedCall = (helper.request as any).mock.calls.at(-1);
    expect(omittedCall[0]).toBe('enumerateRtt');
    expect(omittedCall[1]).not.toHaveProperty('controlBlockAddress');
    expect(omittedCall[1].timeoutMs).toBe(2000);

    await channel.disconnect();
  });

  it('propagates enumerateRtt ReadTimeout without terminating or replacing the single CMSIS-DAP owner', async () => {
    const base = fakeCmsisDapHelper();
    const request = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'enumerateRtt') {
        return {
          ok: false,
          message: 'RTT enumeration exceeded 1 ms deadline during channel name enumeration',
          errorCode: 'ReadTimeout',
          targetState: 'Running' as const,
          elapsedMs: 1,
        };
      }
      return (base.request as any)(method, params);
    });
    const channel = new CmsisDapTargetChannel({ helperClient: fakeCmsisDapHelper({ request: request as any }) });
    const createNative = vi.fn();
    const selector = new SessionTargetSelector(createNative, () => channel);
    await selector.connect({
      device: 'STM32H723VGT6',
      interface: 'SWD',
      speedKHz: 1000,
      probe: 'cmsis-dap',
    });

    await expect(selector.enumerateRtt(0x24000100, { timeoutMs: 1 })).resolves.toMatchObject({
      ok: false,
      errorCode: 'ReadTimeout',
    });
    expect(selector.ownerKind).toBe('cmsis-dap');
    expect(createNative).not.toHaveBeenCalled();
    await expect(selector.startRtt(0x24000100)).resolves.toMatchObject({ ok: true });
    await selector.dispose(false);
  });

  it('rejects malformed enumerateRtt helper responses with MalformedResponse', async () => {
    const base = fakeCmsisDapHelper();
    const request = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'enumerateRtt') {
        return {
          ok: true,
          message: 'bad enum',
          targetState: 'Running' as const,
          elapsedMs: 1,
          data: { controlBlockAddress: 0x20000100, maxUpBuffers: 2, maxDownBuffers: 0, upBuffers: [], downBuffers: [] },
        };
      }
      return (base.request as any)(method, params);
    });
    const channel = new CmsisDapTargetChannel({ helperClient: fakeCmsisDapHelper({ request: request as any }) });
    await channel.connect({
      device: 'STM32F407VET6',
      interface: 'SWD',
      speedKHz: 1000,
      probe: 'cmsis-dap',
    });

    await expect(channel.enumerateRtt(0x20000100)).resolves.toMatchObject({
      ok: false,
      errorCode: 'MalformedResponse',
    });
    await channel.disconnect();
  });

  it('returns UnsupportedCapability when SessionTargetSelector owner does not support enumerateRtt', async () => {
    const nativeOwner = {
      kind: 'jlink-native',
      usingNative: false,
      connect: vi.fn(async () => ({ ok: true, message: 'ok', targetState: 'Halted', elapsedMs: 0, data: { channel: 'cpp' } })),
      disconnect: vi.fn(async () => ({ ok: true, message: 'ok', targetState: 'Disconnected', elapsedMs: 0, data: {} })),
      dispose: vi.fn(async () => {}),
    } as unknown as SessionTargetOwner;
    const selector = new SessionTargetSelector(() => nativeOwner);
    await selector.connect({ device: 'STM32F407VG', interface: 'SWD', speedKHz: 4000 });

    await expect(selector.enumerateRtt(0x20000100)).resolves.toMatchObject({
      ok: false,
      errorCode: 'UnsupportedCapability',
    });
    await selector.dispose(false);
  });

  it.each(['STM32H723VGT6', 'STM32F407IG', 'STM32F103C8T6'])('exposes the %s flash target and clears it on disconnect', async device => {
    const channel = new CmsisDapTargetChannel({ helperClient: fakeCmsisDapHelper() });
    const selector = new SessionTargetSelector(vi.fn(), () => channel);

    expect(channel.flashTarget).toBeNull();
    expect(selector.flashTarget).toBeNull();

    const connected = await selector.connect({
      device,
      interface: 'SWD',
      speedKHz: 1000,
      probe: 'cmsis-dap',
    });
    expect(connected.ok).toBe(true);
    expect(channel.flashTarget).toMatchObject({ name: device });
    expect(selector.flashTarget).toMatchObject({ name: device });

    await channel.disconnect();
    expect(channel.flashTarget).toBeNull();
    expect(selector.flashTarget).toBeNull();
  });

  it('connects an unregistered device without a flash target entry', async () => {
    const channel = new CmsisDapTargetChannel({ helperClient: fakeCmsisDapHelper() });

    const connected = await channel.connect({
      device: 'STM32F429VGT6',
      interface: 'SWD',
      speedKHz: 1000,
      probe: 'cmsis-dap',
    });
    expect(connected.ok).toBe(true);
    expect(channel.flashTarget).toBeNull();
  });

  it('preserves an RTT Flags error without replacing the CMSIS-DAP owner or creating J-Link fallback', async () => {
    const base = fakeCmsisDapHelper();
    const request = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'readRtt') {
        return {
          ok: false,
          message: 'RTT Up Buffer Flags contain reserved bits',
          errorCode: 'RttInvalidBufferFlags',
          targetState: 'Running' as const,
          elapsedMs: 2,
          diagnostics: {
            rtt: {
              bufferIndex: 0,
              descriptorAddress: 0x20000118,
              bufferAddress: 0x20001000,
              bufferSize: 8,
              wrOff: 3,
              rdOff: 0,
              flags: 4,
              mode: 0,
              bytes: [],
            },
          },
        };
      }
      return (base.request as any)(method, params);
    });
    const helper = fakeCmsisDapHelper({ request: request as any });
    const channel = new CmsisDapTargetChannel({ helperClient: helper });
    const createNative = vi.fn();
    const selector = new SessionTargetSelector(createNative, () => channel);
    await selector.connect({
      probe: 'cmsis-dap', device: 'STM32F407VET6', interface: 'SWD', speedKHz: 1000,
    });

    await expect(selector.readRtt(0, 8)).resolves.toMatchObject({
      ok: false,
      errorCode: 'RttInvalidBufferFlags',
      diagnostics: {
        rtt: {
          flags: 4,
          mode: 0,
          bufferIndex: 0,
          descriptorAddress: 0x20000118,
          bytes: [],
        },
      },
    });
    expect(selector.ownerKind).toBe('cmsis-dap');
    expect(createNative).not.toHaveBeenCalled();
    await selector.dispose(false);
  });

  it('forwards registered target RAM ranges to writeRtt at control priority and coexists with RTT Log', async () => {
    const helper = fakeCmsisDapHelper({
      start: vi.fn(async () => ({
        ok: true,
        message: 'hello',
        targetState: 'Disconnected' as const,
        elapsedMs: 0,
        data: {
          protocol: 1,
          helperVersion: 'test',
          platform: 'win32-x64',
          capabilities: ['rtt', 'rttEnumerate', 'rttWrite'],
        },
      })),
    });
    const channel = new CmsisDapTargetChannel({ helperClient: helper });
    const createNative = vi.fn();
    const selector = new SessionTargetSelector(createNative, () => channel);
    await selector.connect({
      probe: 'cmsis-dap', device: 'STM32H723VGT6', interface: 'SWD', speedKHz: 1000,
    });

    expect(channel.getHelperCapabilities()).toEqual(['rtt', 'rttEnumerate', 'rttWrite']);
    const started = await selector.startRtt(0x24000100);
    const written = await selector.writeRtt(0, Uint8Array.from([1, 2, 3]), { timeoutMs: 500 });
    const readUp = await selector.readRtt(0, 8);
    await selector.stopRtt();

    expect(started.ok).toBe(true);
    expect(written).toMatchObject({
      ok: true,
      data: {
        controlBlockAddress: 0x20000100,
        committedBytes: 3,
        wrOffCommitted: true,
        completion: 'completed',
      },
      diagnostics: { ownerKind: 'cmsis-dap', method: 'writeRtt' },
    });
    expect(readUp.ok).toBe(true);
    expect(helper.controlRequest).toHaveBeenCalledWith('writeRtt', {
      bufferIndex: 0,
      bytes: [1, 2, 3],
      ramRanges: [
        { address: 0x00000000, size: 65536 },
        { address: 0x20000000, size: 131072 },
        { address: 0x24000000, size: 327680 },
        { address: 0x30000000, size: 278528 },
        { address: 0x38000000, size: 16384 },
        { address: 0x38800000, size: 4096 },
      ],
      timeoutMs: 500,
    });
    expect(createNative).not.toHaveBeenCalled();
    await selector.dispose(false);
  });

  it('rejects invalid writeRtt inputs, missing capability, and malformed helper results', async () => {
    // Missing rttWrite capability advertised by helper
    const noCapHelper = fakeCmsisDapHelper({
      start: vi.fn(async () => ({
        ok: true,
        message: 'hello',
        targetState: 'Disconnected' as const,
        elapsedMs: 0,
        data: { protocol: 1, helperVersion: 'test', platform: 'win32-x64', capabilities: ['rtt', 'rttEnumerate'] },
      })),
    });
    const noCapChannel = new CmsisDapTargetChannel({ helperClient: noCapHelper });
    await noCapChannel.connect({
      probe: 'cmsis-dap', device: 'STM32F407VET6', interface: 'SWD', speedKHz: 1000,
    });
    await expect(noCapChannel.writeRtt(0, Uint8Array.from([1]))).resolves.toMatchObject({
      ok: false,
      errorCode: 'UnsupportedCapability',
    });
    await noCapChannel.disconnect();

    // Unregistered device without explicit ramRanges -> UnsupportedCapability
    const unregChannel = new CmsisDapTargetChannel({ helperClient: fakeCmsisDapHelper() });
    await unregChannel.connect({
      probe: 'cmsis-dap', device: 'UNKNOWN_MCU', interface: 'SWD', speedKHz: 1000,
    });
    await expect(unregChannel.writeRtt(0, Uint8Array.from([1]), { controlBlockAddress: 0x20000100 }))
      .resolves.toMatchObject({ ok: false, errorCode: 'UnsupportedCapability' });

    // Invalid bufferIndex, empty bytes, invalid controlBlockAddress, invalid timeoutMs, invalid ramRanges
    await expect(unregChannel.writeRtt(-1, Uint8Array.from([1]), { ramRanges: [{ address: 0x20000000, size: 4096 }] }))
      .resolves.toMatchObject({ ok: false, errorCode: 'DapInvalidRequest' });
    await expect(unregChannel.writeRtt(0, new Uint8Array(0), { ramRanges: [{ address: 0x20000000, size: 4096 }] }))
      .resolves.toMatchObject({ ok: false, errorCode: 'DapInvalidRequest' });
    await expect(unregChannel.writeRtt(0, Uint8Array.from([1]), {
      controlBlockAddress: 0, ramRanges: [{ address: 0x20000000, size: 4096 }],
    })).resolves.toMatchObject({ ok: false, errorCode: 'DapInvalidRequest' });
    await expect(unregChannel.writeRtt(0, Uint8Array.from([1]), {
      ramRanges: [{ address: 0x20000000, size: 4096 }], timeoutMs: 0,
    })).resolves.toMatchObject({ ok: false, errorCode: 'DapInvalidRequest' });
    await expect(unregChannel.writeRtt(0, Uint8Array.from([1]), { ramRanges: [] }))
      .resolves.toMatchObject({ ok: false, errorCode: 'DapInvalidRequest' });

    // Malformed helper success (committedBytes > 0 while wrOffCommitted=false)
    const base = fakeCmsisDapHelper();
    const tamperedHelper = fakeCmsisDapHelper({
      request: vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
        if (method === 'writeRtt') {
          const okRes = await (base.request as any)(method, params);
          okRes.data.wrOffCommitted = false;
          return okRes;
        }
        return (base.request as any)(method, params);
      }) as any,
    });
    const tamperedChannel = new CmsisDapTargetChannel({ helperClient: tamperedHelper });
    await tamperedChannel.connect({
      probe: 'cmsis-dap', device: 'STM32F407VET6', interface: 'SWD', speedKHz: 1000,
    });
    await expect(tamperedChannel.writeRtt(0, Uint8Array.from([1, 2]))).resolves.toMatchObject({
      ok: false,
      errorCode: 'MalformedResponse',
    });

    // Selector owner without writeRtt returns UnsupportedCapability
    const jlink = owner(vi.fn(async () => ({
      ok: true, message: 'connected', targetState: 'Halted' as const, elapsedMs: 0, data: { channel: 'cpp' as const },
    })));
    const selector = new SessionTargetSelector(() => jlink, vi.fn());
    await selector.connect({ device: 'STM32F407VG', interface: 'SWD', speedKHz: 4000 });
    await expect(selector.writeRtt(0, Uint8Array.from([1]))).resolves.toMatchObject({
      ok: false,
      errorCode: 'UnsupportedCapability',
    });
  });

  it('preserves writeRtt unknown-completion diagnostics and terminates cleanly on DeviceRemoved without creating a J-Link owner', async () => {
    const base = fakeCmsisDapHelper();
    let mode: 'unknown' | 'removed' = 'unknown';
    const helper = fakeCmsisDapHelper({
      request: vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
        if (method === 'writeRtt') {
          if (mode === 'unknown') {
            return {
              ok: false,
              message: 'DAP_TransferBlock write failed (completion state unknown)',
              errorCode: 'WriteCompletedLate',
              targetState: 'Running' as const,
              elapsedMs: 12,
              diagnostics: {
                rtt: {
                  controlBlockAddress: 0x20000100,
                  bufferIndex: 0,
                  committedBytes: 0,
                  writtenBytes: 4,
                  firstSegmentWritten: true,
                  secondSegmentWritten: true,
                  wrOffWriteAttempted: true,
                  wrOffCommitted: false,
                  completion: 'unknown',
                  failureStage: 'commit-wroff',
                  retryable: false,
                },
              },
            };
          }
          return {
            ok: false,
            message: 'CMSIS-DAP device removed during writeRtt',
            errorCode: 'DeviceRemoved',
            targetState: 'Error' as const,
            elapsedMs: 4,
            diagnostics: {
              rtt: {
                committedBytes: 0,
                completion: 'unknown',
                failureStage: 'data-second',
                firstSegmentWritten: true,
                secondSegmentWritten: false,
                wrOffCommitted: false,
              },
            },
          };
        }
        return (base.request as any)(method, params);
      }) as any,
    });
    const createNative = vi.fn();
    const channel = new CmsisDapTargetChannel({ helperClient: helper });
    const selector = new SessionTargetSelector(createNative, () => channel);
    await selector.connect({
      probe: 'cmsis-dap', device: 'STM32F407VET6', interface: 'SWD', speedKHz: 1000,
    });

    // WriteCompletedLate keeps the single owner alive and preserves completion=unknown diagnostics
    await expect(selector.writeRtt(0, Uint8Array.from([1, 2, 3, 4]))).resolves.toMatchObject({
      ok: false,
      errorCode: 'WriteCompletedLate',
      diagnostics: {
        ownerKind: 'cmsis-dap',
        method: 'writeRtt',
        rtt: {
          wrOffWriteAttempted: true,
          wrOffCommitted: false,
          committedBytes: 0,
          completion: 'unknown',
          failureStage: 'commit-wroff',
          retryable: false,
        },
      },
    });
    expect(selector.ownerKind).toBe('cmsis-dap');

    // DeviceRemoved triggers single-owner termination (NativeOwnerLost) with preserved diagnostics and no J-Link fallback
    mode = 'removed';
    await expect(selector.writeRtt(0, Uint8Array.from([1, 2]))).resolves.toMatchObject({
      ok: false,
      errorCode: 'NativeOwnerLost',
      diagnostics: {
        causeErrorCode: 'DeviceRemoved',
        rtt: {
          completion: 'unknown',
          failureStage: 'data-second',
          firstSegmentWritten: true,
          secondSegmentWritten: false,
          wrOffCommitted: false,
        },
      },
    });
    expect(selector.ownerKind).toBe('none');
    expect(helper.dispose).toHaveBeenCalledWith(false);
    expect(createNative).not.toHaveBeenCalled();
  });

  it('selects the native owner for J-Link', async () => {
    const native = owner(vi.fn(async () => ({
      ok: true,
      message: 'native connected',
      targetState: 'Halted' as const,
      elapsedMs: 1,
      data: { channel: 'cpp' as const },
    })));
    const selector = new SessionTargetSelector(() => native);

    const result = await selector.connect({
      device: 'STM32F407VG',
      interface: 'SWD',
      speedKHz: 4000,
    });

    expect(result.ok).toBe(true);
    expect(selector.ownerKind).toBe('jlink-native');
  });

  it('waits for native disposal and preserves the startup error', async () => {
    const order: string[] = [];
    let finishDispose!: () => void;
    const disposeGate = new Promise<void>(resolve => { finishDispose = resolve; });
    const native = owner(vi.fn(async () => ({
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
    const createCmsisDap = vi.fn();
    const selector = new SessionTargetSelector(() => native, createCmsisDap);

    const connecting = selector.connect({
      device: 'STM32F407VG',
      interface: 'SWD',
      speedKHz: 4000,
    });
    await vi.waitFor(() => expect(order).toEqual(['native-dispose-start']));
    expect(selector.ownerKind).toBe('none');
    expect(createCmsisDap).not.toHaveBeenCalled();

    finishDispose();
    const result = await connecting;

    expect(result).toMatchObject({ ok: false, errorCode: 'JLinkConnectFailed', message: 'native connect failed' });
    expect(selector.ownerKind).toBe('none');
    expect(order).toEqual(['native-dispose-start', 'native-dispose-finished']);
    expect(createCmsisDap).not.toHaveBeenCalled();
  });

  it('disposes a lost native owner and leaves the selector disconnected', async () => {
    const order: string[] = [];
    const native = owner(vi.fn(async () => ({
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

    const createCmsisDap = vi.fn();
    const selector = new SessionTargetSelector(() => native, createCmsisDap);
    await selector.connect({ device: 'STM32F407VG', interface: 'SWD', speedKHz: 4000 });

    const failed = await selector.halt();
    expect(failed.ok).toBe(false);
    expect(native.halt).toHaveBeenCalledOnce();
    expect(failed.message).toContain('start a new debug session to reconnect');
    expect(order).toEqual(['native-halt', 'native-disposed']);
    expect(selector.ownerKind).toBe('none');
    expect(createCmsisDap).not.toHaveBeenCalled();

    const next = await selector.run();
    expect(next).toMatchObject({ ok: false, errorCode: 'TargetOwnerUnavailable' });
  });

  it('routes CMSIS-DAP to its own owner and never creates a J-Link owner', async () => {
    const createNative = vi.fn();
    const helper = fakeCmsisDapHelper();
    const cmsisDap = new CmsisDapTargetChannel({ helperClient: helper });
    const selector = new SessionTargetSelector(createNative, () => cmsisDap);

    const result = await selector.connect({
      probe: 'cmsis-dap',
      cmsisDapTransport: 'hid',
      cmsisDapSerial: 'CMSIS-123',
      cmsisDapVid: 'C251',
      cmsisDapPid: 'F001',
      flashBeforeDebug: false,
      device: 'STM32F407VET6',
      interface: 'SWD',
      speedKHz: 4000,
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        channel: 'cmsis-dap',
        diagnostics: {
          fpb: { revision: 1, codeComparators: 6, enabled: false },
        },
      },
    });
    expect(helper.start).toHaveBeenCalledTimes(1);
    expect(helper.controlRequest).toHaveBeenCalledWith('getFpbInfo', { timeoutMs: 1000 });
    expect(createNative).not.toHaveBeenCalled();
    expect(selector.ownerKind).toBe('cmsis-dap');
  });

  it.each(['DeviceRemoved', 'MalformedResponse'])(
    'abandons a CMSIS-DAP owner after %s and requires the next owner to claim FPB again',
    async causeErrorCode => {
      const makeHelper = (failStep: boolean) => {
        const controlRequest = vi.fn(async (method: string) => {
          if (method === 'getFpbInfo') {
            return {
              ok: true,
              message: 'FPB ownership claimed and comparators sanitized',
              targetState: 'Running' as const,
              elapsedMs: 1,
              data: {
                fpCtrl: 0x260,
                revision: 1,
                codeComparators: 6,
                literalComparators: 2,
                enabled: false,
              },
            };
          }
          if (failStep && method === 'stepOverSourceLine') {
            return {
              ok: false,
              message: `${causeErrorCode} while cleaning a temporary comparator`,
              errorCode: causeErrorCode,
              targetState: 'Error' as const,
              elapsedMs: 3,
              diagnostics: { phase: 'temporaryBreakpointCleanup' },
            };
          }
          throw new Error(`unexpected control request ${method}`);
        });
        return fakeCmsisDapHelper({ controlRequest: controlRequest as any });
      };
      const firstHelper = makeHelper(true);
      const secondHelper = makeHelper(false);
      const owners = [
        new CmsisDapTargetChannel({ helperClient: firstHelper }),
        new CmsisDapTargetChannel({ helperClient: secondHelper }),
      ];
      const createCmsisDap = vi.fn(() => owners.shift()!);
      const createNative = vi.fn();
      const selector = new SessionTargetSelector(createNative, createCmsisDap);
      const config = {
        probe: 'cmsis-dap' as const,
        device: 'STM32F407VET6',
        interface: 'SWD' as const,
        speedKHz: 1000,
        flashBeforeDebug: false,
      };
      expect((await selector.connect(config)).ok).toBe(true);

      const failed = await selector.stepOverSourceLine({
        lineStart: 0x080001C0,
        lineEnd: 0x080001C6,
      });

      expect(failed).toMatchObject({
        ok: false,
        errorCode: 'NativeOwnerLost',
        diagnostics: {
          causeErrorCode,
          phase: 'temporaryBreakpointCleanup',
        },
      });
      expect(selector.ownerKind).toBe('none');
      expect(firstHelper.dispose).toHaveBeenCalledWith(false);
      expect(createNative).not.toHaveBeenCalled();

      expect((await selector.connect(config)).ok).toBe(true);
      expect(secondHelper.controlRequest).toHaveBeenCalledWith('getFpbInfo', { timeoutMs: 1000 });
      expect(selector.ownerKind).toBe('cmsis-dap');
      await selector.dispose(false);
    },
  );

  it('abandons a CMSIS-DAP owner when a successful control response has no data', async () => {
    const controlRequest = vi.fn(async (method: string) => {
      if (method === 'getFpbInfo') {
        return {
          ok: true,
          message: 'FPB ownership claimed and comparators sanitized',
          targetState: 'Running' as const,
          elapsedMs: 1,
          data: {
            fpCtrl: 0x260,
            revision: 1,
            codeComparators: 6,
            literalComparators: 2,
            enabled: false,
          },
        };
      }
      if (method === 'stepOverSourceLine') {
        return {
          ok: true,
          message: 'step response body omitted',
          targetState: 'Halted' as const,
          elapsedMs: 37,
          diagnostics: { phase: 'decode', rawLength: 0 },
        };
      }
      throw new Error(`unexpected control request ${method}`);
    });
    const helper = fakeCmsisDapHelper({ controlRequest: controlRequest as any });
    const channel = new CmsisDapTargetChannel({ helperClient: helper });
    const createCmsisDap = vi.fn(() => channel);
    const createNative = vi.fn();
    const selector = new SessionTargetSelector(createNative, createCmsisDap);

    expect((await selector.connect({
      probe: 'cmsis-dap',
      device: 'STM32F407VET6',
      interface: 'SWD',
      speedKHz: 1000,
      flashBeforeDebug: false,
    })).ok).toBe(true);

    const failed = await selector.stepOverSourceLine({
      lineStart: 0x080001C0,
      lineEnd: 0x080001C6,
    });

    expect(failed).toMatchObject({
      ok: false,
      errorCode: 'NativeOwnerLost',
      targetState: 'Error',
      elapsedMs: 37,
      diagnostics: {
        phase: 'decode',
        rawLength: 0,
        ownerKind: 'cmsis-dap',
        method: 'stepOverSourceLine',
        causeErrorCode: 'MalformedResponse',
      },
    });
    expect(selector.ownerKind).toBe('none');
    expect(helper.dispose).toHaveBeenCalledWith(false);
    expect(createCmsisDap).toHaveBeenCalledTimes(1);
    expect(createNative).not.toHaveBeenCalled();
    await expect(channel.getState()).resolves.toMatchObject({
      ok: false,
      errorCode: 'InvalidState',
      diagnostics: { ownerKind: 'cmsis-dap', state: 'failed' },
    });
  });

  it('uses the one selected CMSIS-DAP owner for the flash-before-debug flow', async () => {
    const cmsisDap = {
      kind: 'cmsis-dap' as const,
      usingNative: false,
      connect: vi.fn(async () => ({
        ok: true,
        message: 'connected',
        targetState: 'Unknown' as const,
        elapsedMs: 0,
        data: { channel: 'cmsis-dap' as const },
      })),
      flash: vi.fn(async () => ({
        ok: true,
        message: 'flashed',
        targetState: 'Halted' as const,
        elapsedMs: 1,
        data: { success: true },
      })),
      dispose: vi.fn(async () => {}),
    } as unknown as SessionTargetOwner;
    const createNative = vi.fn();
    const selector = new SessionTargetSelector(createNative, () => cmsisDap);

    const connected = await selector.connect({
      probe: 'cmsis-dap',
      flashBeforeDebug: true,
      device: 'STM32F407VET6',
      interface: 'SWD',
      speedKHz: 4000,
    });
    const flashed = await selector.flash('firmware.elf', 'STM32F407VET6');

    expect(connected.ok).toBe(true);
    expect(flashed).toMatchObject({ ok: true, data: { success: true } });
    expect(cmsisDap.connect).toHaveBeenCalledOnce();
    expect(cmsisDap.flash).toHaveBeenCalledOnce();
    expect(createNative).not.toHaveBeenCalled();
  });

  it('resolves flash devices through the registry before touching the helper', async () => {
    const helper = fakeCmsisDapHelper();
    const channel = new CmsisDapTargetChannel({ helperClient: helper });
    expect((await channel.connect({
      device: 'STM32F407VET6',
      interface: 'SWD',
      speedKHz: 1000,
      probe: 'cmsis-dap',
    })).ok).toBe(true);

    const mismatch = await channel.flash('image.elf', 'STM32F429VGT6');
    expect(mismatch).toMatchObject({
      ok: false,
      errorCode: 'TargetMismatch',
      diagnostics: { ownerKind: 'cmsis-dap', supportedTargets: ['STM32F407VET6', 'STM32F407IG', 'STM32H723VGT6', 'STM32F103C8T6'] },
    });
    expect(mismatch.message).toContain('STM32F429VGT6');
    expect(helper.withControlCriticalSection).not.toHaveBeenCalled();

    // A registered alias passes registry resolution and proceeds into the
    // flash flow, which then fails on the missing ELF file.
    const alias = await channel.flash('does-not-exist.elf', 'stm32f407ve');
    expect(alias.ok).toBe(false);
    expect(alias.errorCode).toBe('InvalidConfiguration');
    expect(alias.message).toContain('does-not-exist.elf');
    expect(helper.withControlCriticalSection).toHaveBeenCalled();
  });

  it('passes Flash Algorithm diagnostic and RAM window fields through the helper RPC', async () => {
    const flashRequests: Array<Record<string, unknown>> = [];
    const helper = fakeCmsisDapHelper({
      request: vi.fn(async (method: string, params: Record<string, unknown> = {}): Promise<any> => {
        if (method === 'flashAlgorithm') {
          flashRequests.push(params);
          return {
            ok: true,
            message: 'algorithm complete',
            targetState: 'Halted' as const,
            elapsedMs: 1,
            data: {
              returnCode: 0,
              pc: (params as { bkptAddress: number }).bkptAddress,
              dhcsr: 0x00030003,
            },
          };
        }
        return (fakeCmsisDapHelper().request as unknown as (method: string, params: Record<string, unknown>) => Promise<any>)(method, params);
      }),
    });
    const channel = new CmsisDapTargetChannel({ helperClient: helper });
    expect((await channel.connect({
      device: 'STM32H723VGT6',
      interface: 'SWD',
      speedKHz: 1000,
      probe: 'cmsis-dap',
    })).ok).toBe(true);

    const baseRequest = {
      operation: 'eraseSector',
      algorithm: [0xbf, 0xbf],
      algorithmAddress: 0x24000000,
      entry: 0x24000200,
      bkptAddress: 0x24000500,
      stackPointer: 0x24050000,
      stackSize: 0x1000,
      pageBufferAddress: 0x24000600,
      targetAddress: 0x080E0000,
      size: 0x20000,
      data: [] as number[],
      clockHz: 4000000,
      staticBase: 0,
      timeoutMs: 100,
      reusePageBuffer: false,
    };
    const result = await channel.runAlgorithm({
      ...baseRequest,
      flashStatusAddress: 0x52002010,
      flashControlAddress: 0x5200200C,
      ramBase: 0x24000000,
      ramSize: 320 * 1024,
    } as FlashAlgorithmRunRequest);
    expect(result.ok).toBe(true);
    expect(flashRequests).toHaveLength(1);
    expect(flashRequests[0]).toMatchObject({
      operation: 'eraseSector',
      targetAddress: 0x080E0000,
      size: 0x20000,
      flashStatusAddress: 0x52002010,
      flashControlAddress: 0x5200200C,
      ramBase: 0x24000000,
      ramSize: 320 * 1024,
    });

    // Requests without the optional fields must reach the helper untouched;
    // the helper then applies its STM32F4 defaults.
    const legacy = await channel.runAlgorithm(baseRequest as FlashAlgorithmRunRequest);
    expect(legacy.ok).toBe(true);
    expect(flashRequests).toHaveLength(2);
    const legacyWire = JSON.stringify(flashRequests[1]);
    expect(legacyWire).not.toContain('flashStatusAddress');
    expect(legacyWire).not.toContain('ramBase');
  });

  it('routes CMSIS-DAP WinUSB through the same single helper owner', async () => {
    const helper = fakeCmsisDapHelper();
    const cmsisDap = new CmsisDapTargetChannel({ helperClient: helper });
    const selector = new SessionTargetSelector(vi.fn(), () => cmsisDap);

    const result = await selector.connect({
      probe: 'cmsis-dap',
      cmsisDapTransport: 'winusb',
      flashBeforeDebug: false,
      device: 'STM32F407VET6',
      interface: 'SWD',
      speedKHz: 4000,
    });

    expect(result).toMatchObject({ ok: true });
    expect(helper.start).toHaveBeenCalledWith('winusb');
    expect(helper.request).toHaveBeenCalledWith('enumDevices', expect.objectContaining({ transport: 'winusb' }));
    expect(selector.ownerKind).toBe('cmsis-dap');
  });

  it('cleans the CMSIS-DAP owner to none when the helper start fails', async () => {
    const helper = fakeCmsisDapHelper({
      start: vi.fn(async () => ({
        ok: false,
        message: 'spawn failed',
        errorCode: 'HelperStartFailed',
        targetState: 'Error' as const,
        elapsedMs: 0,
      })),
    });
    const cmsisDap = new CmsisDapTargetChannel({ helperClient: helper });
    const selector = new SessionTargetSelector(vi.fn(), () => cmsisDap);

    const result = await selector.connect({
      probe: 'cmsis-dap',
      flashBeforeDebug: false,
      device: 'STM32F407VET6',
      interface: 'SWD',
      speedKHz: 4000,
    });

    expect(result).toMatchObject({ ok: false, errorCode: 'HelperStartFailed' });
    expect(helper.dispose).toHaveBeenCalledWith(false);
    expect(selector.ownerKind).toBe('none');
  });

  it('disposes the helper and keeps no owner when enumeration finds no device', async () => {
    const helper = fakeCmsisDapHelper({
    request: vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
        if (method === 'enumDevices') {
          return {
            ok: true,
            message: 'none',
            targetState: 'Disconnected' as const,
            elapsedMs: 0,
            data: { devices: [] as CmsisDapDeviceInfo[] },
          };
        }
        throw new Error(`unexpected request ${method}`);
      }) as unknown as CmsisDapHelperClient['request'],
    });
    const cmsisDap = new CmsisDapTargetChannel({ helperClient: helper });
    const selector = new SessionTargetSelector(vi.fn(), () => cmsisDap);

    const result = await selector.connect({
      probe: 'cmsis-dap',
      cmsisDapTransport: 'auto',
      flashBeforeDebug: false,
      device: 'STM32F407VET6',
      interface: 'SWD',
      speedKHz: 4000,
    });

    expect(result).toMatchObject({ ok: false, errorCode: 'DeviceNotFound' });
    expect(helper.dispose).toHaveBeenCalledWith(false);
    expect(selector.ownerKind).toBe('none');
  });

  it('disconnects CMSIS-DAP symmetrically: DAP_Disconnect, close, then helper exit', async () => {
    const helper = fakeCmsisDapHelper();
    const channel = new CmsisDapTargetChannel({ helperClient: helper });

    const connected = await channel.connect({
      probe: 'cmsis-dap',
      cmsisDapTransport: 'hid',
      flashBeforeDebug: false,
      device: 'STM32F407VET6',
      interface: 'SWD',
      speedKHz: 4000,
    });
    expect(connected.ok).toBe(true);

    const result = await channel.disconnect();
    expect(result.ok).toBe(true);
    const requestCalls = (helper.request as ReturnType<typeof vi.fn>).mock.calls.map(call => call[0]);
    expect(requestCalls).toEqual(expect.arrayContaining(['connect', 'getInfo', 'disconnect', 'close']));
    expect(helper.dispose).toHaveBeenCalledWith(true);
  });

  it('routes DAP-05 breakpoints and all source-step primitives through the control scheduler', async () => {
    const helper = fakeCmsisDapHelper();
    const channel = new CmsisDapTargetChannel({ helperClient: helper });
    await channel.connect({
      probe: 'cmsis-dap', cmsisDapTransport: 'hid', flashBeforeDebug: false,
      device: 'STM32F407VET6', interface: 'SWD', speedKHz: 1000,
    });

    await expect(channel.setBreakpoint(0x080001C4, 2)).resolves.toMatchObject({
      ok: true, data: { id: 2, address: 0x080001C4, fpbRevision: 1 },
    });
    await expect(channel.clearBreakpoint(2)).resolves.toMatchObject({ ok: true });
    await expect(channel.stepIntoSourceLine({ lineStart: 0x080001C0, lineEnd: 0x080001C6 }))
      .resolves.toMatchObject({ ok: true, data: { cleanupOk: true } });
    await expect(channel.stepOverSourceLine({ lineStart: 0x080001C0, lineEnd: 0x080001C6 }))
      .resolves.toMatchObject({ ok: true, data: { cleanupOk: true } });
    await expect(channel.stepOut({ functionStart: 0x080001E0, functionEnd: 0x08000200 }))
      .resolves.toMatchObject({ ok: true, data: { cleanupOk: true } });
    expect((helper.controlRequest as ReturnType<typeof vi.fn>).mock.calls.map(call => call[0]))
      .toEqual(expect.arrayContaining([
        'setBreakpoint', 'clearBreakpoint', 'stepIntoSourceLine', 'stepOverSourceLine', 'stepOut',
      ]));
  });

  it('runs to a startup address through one control request on the selected CMSIS-DAP owner', async () => {
    const base = fakeCmsisDapHelper();
    const controlRequest = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'runToAddress') {
        return {
          ok: true,
          message: 'startup entry reached',
          targetState: 'Halted' as const,
          elapsedMs: 12,
          data: {
            state: 'Halted' as const,
            requestedAddress: 0x08003a2d,
            entryAddress: 0x08003a2c,
            resetRequested: true,
            resetPcValid: true,
            resetDhcsr: 0x03010003,
            resetPc: 0x08004518,
            resetLr: 0xffffffff,
            pc: 0x08003a2c,
            lr: 0x08004541,
            dhcsr: 0x00030003,
            cleanupOk: true,
            sharedUserSlot: false,
            temporaryBreakpointCount: 1,
            temporarySlot: 5,
            ignoredUserSlots: [0],
          },
        };
      }
      return (base.controlRequest as any)(method, params);
    });
    const helper = fakeCmsisDapHelper({ controlRequest: controlRequest as any });
    const channel = new CmsisDapTargetChannel({ helperClient: helper });
    await channel.connect({
      probe: 'cmsis-dap', cmsisDapTransport: 'hid', flashBeforeDebug: false,
      device: 'STM32F407VET6', interface: 'SWD', speedKHz: 1000,
    });

    await expect(channel.runToAddress(0x08003a2d, true)).resolves.toMatchObject({
      ok: true,
      targetState: 'Halted',
      data: { entryAddress: 0x08003a2c, pc: 0x08003a2c, cleanupOk: true },
    });
    expect(controlRequest).toHaveBeenCalledWith('runToAddress', {
      address: 0x08003a2d,
      reset: true,
      timeoutMs: 5000,
    });
    expect(controlRequest.mock.calls.filter(call => call[0] === 'runToAddress')).toHaveLength(1);
  });

  it('keeps the CMSIS-DAP owner and user resources on startup comparator exhaustion', async () => {
    const base = fakeCmsisDapHelper();
    const helper = fakeCmsisDapHelper({
      controlRequest: vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
        if (method === 'runToAddress') {
          return {
            ok: false,
            message: 'all FPB comparators are occupied',
            errorCode: 'BreakpointResourceExhausted',
            targetState: 'Halted' as const,
            elapsedMs: 2,
            diagnostics: { startup: { cleanupOk: true, temporaryBreakpointCount: 0 } },
          };
        }
        return (base.controlRequest as any)(method, params);
      }) as any,
    });
    const createNative = vi.fn();
    const selector = new SessionTargetSelector(
      createNative,
      () => new CmsisDapTargetChannel({ helperClient: helper }),
    );
    await selector.connect({
      probe: 'cmsis-dap', device: 'STM32F407VET6', interface: 'SWD', speedKHz: 1000,
    });

    await expect(selector.runToAddress(0x08003a2d, true)).resolves.toMatchObject({
      ok: false,
      errorCode: 'BreakpointResourceExhausted',
      targetState: 'Halted',
    });
    expect(selector.ownerKind).toBe('cmsis-dap');
    expect(createNative).not.toHaveBeenCalled();
  });

  it('terminates a lost CMSIS-DAP startup owner without constructing a J-Link fallback', async () => {
    const base = fakeCmsisDapHelper();
    const helper = fakeCmsisDapHelper({
      controlRequest: vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
        if (method === 'runToAddress') {
          return {
            ok: false,
            message: 'recovery halt failed after startup timeout',
            errorCode: 'StartupRecoveryFailed',
            targetState: 'Error' as const,
            elapsedMs: 5001,
            diagnostics: { startup: { cleanupOk: true } },
          };
        }
        return (base.controlRequest as any)(method, params);
      }) as any,
    });
    const createNative = vi.fn();
    const channel = new CmsisDapTargetChannel({ helperClient: helper });
    const selector = new SessionTargetSelector(createNative, () => channel);
    await selector.connect({
      probe: 'cmsis-dap', device: 'STM32F407VET6', interface: 'SWD', speedKHz: 1000,
    });

    await expect(selector.runToAddress(0x08003a2d, true)).resolves.toMatchObject({
      ok: false,
      errorCode: 'NativeOwnerLost',
      diagnostics: {
        causeErrorCode: 'StartupRecoveryFailed',
        startup: { cleanupOk: true },
      },
    });
    expect(selector.ownerKind).toBe('none');
    expect(helper.dispose).toHaveBeenCalledWith(false);
    expect(createNative).not.toHaveBeenCalled();
  });

  it('routes CMSIS-DAP RAM writes through one control request on the selected owner', async () => {
    const helper = fakeCmsisDapHelper();
    const channel = new CmsisDapTargetChannel({ helperClient: helper });
    await channel.connect({
      probe: 'cmsis-dap', cmsisDapTransport: 'hid', flashBeforeDebug: false,
      device: 'STM32F407VET6', interface: 'SWD', speedKHz: 1000,
    });

    await expect(channel.writeMemory(0x20000001, new Uint8Array([0x11, 0x22])))
      .resolves.toMatchObject({
        ok: true,
        data: { address: 0x20000001, bytesWritten: 2 },
      });
    expect(helper.controlRequest).toHaveBeenCalledWith('writeMemory', {
      address: 0x20000001,
      bytes: [0x11, 0x22],
    });
  });

  it('routes CMSIS-DAP Cortex-M controls at control priority and preserves owner errors', async () => {
    const helper = fakeCmsisDapHelper();
    const channel = new CmsisDapTargetChannel({ helperClient: helper });
    await channel.connect({
      probe: 'cmsis-dap',
      cmsisDapTransport: 'hid',
      flashBeforeDebug: false,
      device: 'STM32F407VET6',
      interface: 'SWD',
      speedKHz: 4000,
    });

    const state = await channel.getState();
    expect(state).toMatchObject({ ok: true, targetState: 'Halted', data: { state: 'Halted', pc: 0x080001C0 } });
    const step = await channel.stepIntoInstruction();
    expect(step).toMatchObject({ ok: true, targetState: 'Halted', data: { pcBefore: 0x080001C0, pcAfter: 0x080001C2 } });
    const register = await channel.readRegister(15);
    expect(register).toMatchObject({ ok: true, data: { value: 0x080001C0 } });

    expect((helper.controlRequest as ReturnType<typeof vi.fn>).mock.calls.map(call => call[0]))
      .toEqual(expect.arrayContaining(['getState', 'stepInstruction', 'readRegister']));
    expect((helper.request as ReturnType<typeof vi.fn>).mock.calls
      .filter(call => ['getState', 'stepInstruction', 'readRegister'].includes(call[0]))).toHaveLength(0);
  });

  it('does not fall back to J-Link when CMSIS-DAP control fails', async () => {
    const base = fakeCmsisDapHelper();
    const helper = fakeCmsisDapHelper({
      controlRequest: vi.fn(async (method: string) => {
        if (method === 'halt') {
          return {
            ok: false,
            message: 'SWD WAIT exhausted during DHCSR write',
            targetState: 'Error' as const,
            elapsedMs: 10,
            errorCode: 'DapAckWait',
            diagnostics: { operation: 'halt', phase: 'writeDhcsr' },
          };
        }
        return (base.controlRequest as any)(method);
      }),
    });
    const channel = new CmsisDapTargetChannel({ helperClient: helper });
    await channel.connect({
      probe: 'cmsis-dap',
      cmsisDapTransport: 'hid',
      flashBeforeDebug: false,
      device: 'STM32F407VET6',
      interface: 'SWD',
      speedKHz: 4000,
    });

    await expect(channel.halt()).resolves.toMatchObject({
      ok: false,
      errorCode: 'DapAckWait',
      diagnostics: { operation: 'halt', phase: 'writeDhcsr' },
    });
  });

  it('guards CMSIS-DAP memory reads until the owner is connected', async () => {
    const helper = fakeCmsisDapHelper();
    const channel = new CmsisDapTargetChannel({ helperClient: helper });

    const read = await channel.readMemory(0x20000000, 4);
    expect(read).toMatchObject({
      ok: false,
      errorCode: 'InvalidState',
      diagnostics: { ownerKind: 'cmsis-dap', capability: 'readMemory', state: 'idle' },
    });
    const batch = await channel.readMemoryBatch([{ address: 0x20000000, size: 4 }]);
    expect(batch).toMatchObject({ ok: false, errorCode: 'InvalidState' });
    expect(helper.request).not.toHaveBeenCalled();
  });

  it('reads memory through the connected CMSIS-DAP helper with watch priority', async () => {
    const helper = fakeCmsisDapHelper();
    const channel = new CmsisDapTargetChannel({ helperClient: helper });
    await channel.connect({
      probe: 'cmsis-dap',
      cmsisDapTransport: 'hid',
      flashBeforeDebug: false,
      device: 'STM32F407VET6',
      interface: 'SWD',
      speedKHz: 4000,
    });

    const read = await channel.readMemory(0x20000000, 4);
    expect(read.ok).toBe(true);
    expect(Array.from(read.data!.bytes)).toEqual([1, 2, 3, 4]);
    const requestCalls = (helper.request as ReturnType<typeof vi.fn>).mock.calls;
    const readCall = requestCalls.find(call => call[0] === 'readMemory');
    expect(readCall).toBeDefined();
    expect(readCall![1]).toEqual({ address: 0x20000000, size: 4 });
    expect(readCall![2]).toMatchObject({ priority: 'watch' });
  });

  it('preserves structured helper errors for CMSIS-DAP memory reads', async () => {
    const baseRequest = fakeCmsisDapHelper().request as ReturnType<typeof vi.fn>;
    const helper = fakeCmsisDapHelper({
      request: vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
        if (method === 'readMemory') {
          return {
            ok: false,
            message: 'DAP_Transfer item 0 ACK=FAULT (data of this and later items is not usable)',
            targetState: 'Error' as const,
            elapsedMs: 0,
            errorCode: 'DapAckFault',
            diagnostics: { waitRetries: 2, faultClears: 1 },
          };
        }
        return baseRequest(method, params);
      }),
    });
    const channel = new CmsisDapTargetChannel({ helperClient: helper });
    await channel.connect({
      probe: 'cmsis-dap',
      cmsisDapTransport: 'hid',
      flashBeforeDebug: false,
      device: 'STM32F407VET6',
      interface: 'SWD',
      speedKHz: 4000,
    });

    const read = await channel.readMemory(0x20000000, 4);
    expect(read.ok).toBe(false);
    expect(read.errorCode).toBe('DapAckFault');
    expect(read.message).toContain('ACK=FAULT');
  });

  it('surfaces helper exits as HelperExited for CMSIS-DAP memory reads', async () => {
    const baseRequest = fakeCmsisDapHelper().request as ReturnType<typeof vi.fn>;
    const helper = fakeCmsisDapHelper({
      request: vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
        if (method === 'readMemory') throw new Error('helper exited');
        return baseRequest(method, params);
      }),
    });
    const channel = new CmsisDapTargetChannel({ helperClient: helper });
    await channel.connect({
      probe: 'cmsis-dap',
      cmsisDapTransport: 'hid',
      flashBeforeDebug: false,
      device: 'STM32F407VET6',
      interface: 'SWD',
      speedKHz: 4000,
    });

    const read = await channel.readMemory(0x20000000, 4);
    expect(read).toMatchObject({ ok: false, errorCode: 'HelperExited' });
    expect(read.message).toContain('helper exited');
  });

  it('uses one CMSIS-DAP helper RPC for an ordered memory batch', async () => {
    const helper = fakeCmsisDapHelper();
    const channel = new CmsisDapTargetChannel({ helperClient: helper });
    await channel.connect({
      probe: 'cmsis-dap',
      cmsisDapTransport: 'hid',
      flashBeforeDebug: false,
      device: 'STM32F407VET6',
      interface: 'SWD',
      speedKHz: 4000,
    });

    const batch = await channel.readMemoryBatch([
      { address: 0x20000000, size: 4 },
      { address: 0x20000004, size: 4 },
    ]);
    expect(batch.ok).toBe(true);
    expect(batch.data!.reads).toHaveLength(2);
    expect(batch.data!.reads).toEqual([
      { address: 0x20000000, bytes: Uint8Array.from([1, 2, 3, 4]) },
      { address: 0x20000004, bytes: Uint8Array.from([17, 18, 19, 20]) },
    ]);
    const batchCalls = (helper.request as ReturnType<typeof vi.fn>).mock.calls
      .filter(call => call[0] === 'readMemoryBatch');
    expect(batchCalls).toHaveLength(1);
    expect(batchCalls[0][1]).toEqual({
      reads: [
        { address: 0x20000000, size: 4 },
        { address: 0x20000004, size: 4 },
      ],
    });
    expect(batchCalls[0][2]).toMatchObject({ priority: 'watch' });
    expect((helper.request as ReturnType<typeof vi.fn>).mock.calls
      .filter(call => call[0] === 'readMemory')).toHaveLength(0);
  });

  it('preserves structured CMSIS-DAP batch failures without consuming partial data', async () => {
    const baseRequest = fakeCmsisDapHelper().request as ReturnType<typeof vi.fn>;

    const failingHelper = fakeCmsisDapHelper({
      request: vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
        if (method === 'readMemoryBatch') {
          return {
            ok: false,
            message: 'batch read failed at index 1',
            targetState: 'Error' as const,
            elapsedMs: 0,
            errorCode: 'DapAckWait',
            data: {
              reads: [{ address: 0x20000000, size: 4, bytes: [1, 2, 3, 4] }],
            },
            diagnostics: {
              failedIndex: 1,
              failedAddress: 0x20000004,
              completedReads: 1,
              packedReads: 0,
              fallbackReads: 2,
            },
          };
        }
        return baseRequest(method, params);
      }),
    });
    const failingChannel = new CmsisDapTargetChannel({ helperClient: failingHelper });
    await failingChannel.connect({
      probe: 'cmsis-dap',
      cmsisDapTransport: 'hid',
      flashBeforeDebug: false,
      device: 'STM32F407VET6',
      interface: 'SWD',
      speedKHz: 4000,
    });
    const failed = await failingChannel.readMemoryBatch([
      { address: 0x20000000, size: 4 },
      { address: 0x20000004, size: 4 },
    ]);
    expect(failed.ok).toBe(false);
    expect(failed.errorCode).toBe('DapAckWait');
    expect(failed.data).toBeUndefined();
    expect(failed.diagnostics).toMatchObject({
      failedIndex: 1,
      failedAddress: 0x20000004,
      completedReads: 1,
    });
  });

  it('rejects malformed or reordered CMSIS-DAP batch success responses', async () => {
    const baseRequest = fakeCmsisDapHelper().request as ReturnType<typeof vi.fn>;
    const helper = fakeCmsisDapHelper({
      request: vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
        if (method === 'readMemoryBatch') {
          return {
            ok: true,
            message: 'malformed batch success',
            targetState: 'Unknown' as const,
            elapsedMs: 0,
            data: {
              reads: [{ address: 0x20000004, size: 4, bytes: [1, 2, 3, 4] }],
            },
          };
        }
        return baseRequest(method, params);
      }),
    });
    const channel = new CmsisDapTargetChannel({ helperClient: helper });
    await channel.connect({
      probe: 'cmsis-dap',
      cmsisDapTransport: 'hid',
      flashBeforeDebug: false,
      device: 'STM32F407VET6',
      interface: 'SWD',
      speedKHz: 4000,
    });

    const result = await channel.readMemoryBatch([
      { address: 0x20000000, size: 4 },
      { address: 0x20000004, size: 4 },
    ]);
    expect(result).toMatchObject({ ok: false, errorCode: 'MalformedResponse' });
  });

  it('returns InvalidState for CMSIS-DAP reads after disconnect', async () => {
    const helper = fakeCmsisDapHelper();
    const channel = new CmsisDapTargetChannel({ helperClient: helper });
    await channel.connect({
      probe: 'cmsis-dap',
      cmsisDapTransport: 'hid',
      flashBeforeDebug: false,
      device: 'STM32F407VET6',
      interface: 'SWD',
      speedKHz: 4000,
    });
    await channel.disconnect();

    const read = await channel.readMemory(0x20000000, 4);
    expect(read).toMatchObject({
      ok: false,
      errorCode: 'InvalidState',
      diagnostics: { capability: 'readMemory', state: 'idle' },
    });
  });

  it('reports matching RTT capabilities before connection and with the CMSIS-DAP owner', async () => {
    // 1. Disconnected selector reports ownerKind='none' with all capabilities unavailable
    const disconnectedSelector = new SessionTargetSelector(vi.fn());
    expect(disconnectedSelector.getRttCapabilities()).toMatchObject({
      ownerKind: 'none',
      rttStart: { available: false },
      rttEnumerate: { available: false },
      rttUpRead: { available: false },
      rttDownWrite: { available: false },
    });

    const cmsisHelper = fakeCmsisDapHelper({
      start: vi.fn(async () => ({
        ok: true,
        message: 'hello',
        targetState: 'Disconnected' as const,
        elapsedMs: 0,
        data: { protocol: 1, helperVersion: 'test', platform: 'win32-x64', capabilities: ['rtt', 'rttEnumerate'] },
      })),
    });
    const cmsisSelector = new SessionTargetSelector(
      vi.fn(),
      () => new CmsisDapTargetChannel({ helperClient: cmsisHelper }),
    );
    await cmsisSelector.connect({ probe: 'cmsis-dap', device: 'STM32F407VET6', interface: 'SWD', speedKHz: 1000 });
    expect(cmsisSelector.getRttCapabilities()).toMatchObject({
      ownerKind: 'cmsis-dap',
      rttStart: { available: true },
      rttEnumerate: { available: true },
      rttUpRead: { available: true },
      rttDownWrite: { available: false, reason: expect.stringContaining('rttWrite') },
    });
    await cmsisSelector.dispose(false);
  });

  it('does not select another owner when J-Link Native is lost during RTT', async () => {
    const helper = {
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
      request: vi.fn(async (method: string) => {
        if (method === 'connect') {
          return {
            ok: true,
            message: 'connected',
            targetState: 'Unknown' as const,
            elapsedMs: 1,
            data: {
              dllPath: 'mock/JLink_x64.dll',
              dllVersion: 99901,
              rttCapabilities: {
                rttStart: { available: true, evidence: 'source' },
                rttEnumerate: { available: true, evidence: 'source' },
                rttUpRead: { available: true, evidence: 'source' },
                rttDownWrite: { available: true, evidence: 'source' },
              },
            },
          };
        }
        return { ok: true, message: method, targetState: 'Running' as const, elapsedMs: 0, data: {} };
      }),
      controlRequest: vi.fn(async (method: string) => {
        if (method === 'writeRtt') {
          throw new Error('C++ J-Link helper exited during writeRtt');
        }
        return { ok: true, message: method, targetState: 'Running' as const, elapsedMs: 0, data: {} };
      }),
      dispose: vi.fn(async () => {}),
    };
    const createNative = vi.fn(() => new ExperimentalCppJLinkChannel({ helperClient: helper as any }));
    const createCmsis = vi.fn();
    const selector = new SessionTargetSelector(createNative, createCmsis);

    await selector.connect({ device: 'STM32H723VGT6', interface: 'SWD', speedKHz: 4000 });
    expect(createNative).toHaveBeenCalledTimes(1);
    expect(createCmsis).not.toHaveBeenCalled();

    const lost = await selector.writeRtt(0, Uint8Array.from([0x01, 0x02]));
    expect(lost).toMatchObject({ ok: false, errorCode: 'NativeOwnerLost' });
    expect(selector.ownerKind).toBe('none');
    expect(selector.getRttCapabilities()).toMatchObject({
      ownerKind: 'none',
      rttStart: { available: false },
      rttEnumerate: { available: false },
      rttUpRead: { available: false },
      rttDownWrite: { available: false },
    });
    await expect(selector.enumerateRtt(0x24000100)).resolves.toMatchObject({
      ok: false,
      errorCode: 'TargetOwnerUnavailable',
    });
    expect(createNative).toHaveBeenCalledTimes(1);
    expect(createCmsis).not.toHaveBeenCalled();
  });
});
