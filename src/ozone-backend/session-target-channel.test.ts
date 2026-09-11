import { describe, expect, it, vi } from 'vitest';
import {
  CmsisDapTargetChannel,
  SessionTargetOwner,
  SessionTargetSelector,
} from './session-target-channel';
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
  kind: 'jlink-native' | 'jlink-legacy',
  connect: SessionTargetOwner['connect'],
  dispose: SessionTargetOwner['dispose'] = vi.fn(async () => {}),
): SessionTargetOwner {
  return {
    kind,
    usingNative: kind === 'jlink-native',
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
    }));
    expect(helper.request).toHaveBeenCalledWith('readRtt', expect.anything(), expect.objectContaining({
      priority: 'background',
    }));
  });

  it('exposes the connected device flash target and clears it on disconnect', async () => {
    const channel = new CmsisDapTargetChannel({ helperClient: fakeCmsisDapHelper() });
    const selector = new SessionTargetSelector(vi.fn(), vi.fn(), () => channel);

    expect(channel.flashTarget).toBeNull();
    expect(selector.flashTarget).toBeNull();

    const connected = await selector.connect({
      device: 'STM32H723VGT6',
      interface: 'SWD',
      speedKHz: 1000,
      probe: 'cmsis-dap',
    });
    expect(connected.ok).toBe(true);
    expect(channel.flashTarget).toMatchObject({ name: 'STM32H723VGT6' });
    expect(selector.flashTarget).toMatchObject({ name: 'STM32H723VGT6' });

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
    const createLegacy = vi.fn();
    const selector = new SessionTargetSelector(createNative, createLegacy, () => channel);
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
    expect(createLegacy).not.toHaveBeenCalled();
    await selector.dispose(false);
  });

  it('never constructs or connects legacy when the native owner succeeds', async () => {
    const native = owner('jlink-native', vi.fn(async () => ({
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
    expect(selector.ownerKind).toBe('jlink-native');
    expect(createLegacy).not.toHaveBeenCalled();
  });

  it('waits for native disposal before constructing and connecting legacy fallback', async () => {
    const order: string[] = [];
    let finishDispose!: () => void;
    const disposeGate = new Promise<void>(resolve => { finishDispose = resolve; });
    const native = owner(
      'jlink-native',
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
    const legacy = owner('jlink-legacy', vi.fn(async () => {
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
    expect(selector.ownerKind).toBe('jlink-legacy');
    expect(order).toEqual([
      'native-dispose-start',
      'native-dispose-finished',
      'legacy-constructed',
      'legacy-connect',
    ]);
  });

  it('uses legacy directly when native ownership is not requested', async () => {
    const createNative = vi.fn();
    const legacy = owner('jlink-legacy', vi.fn(async () => ({
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
    expect(selector.ownerKind).toBe('jlink-legacy');
    expect(createNative).not.toHaveBeenCalled();
  });

  it('does not construct a legacy owner after a connected native owner is lost', async () => {
    const order: string[] = [];
    const native = owner('jlink-native', vi.fn(async () => ({
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

    const legacy = owner('jlink-legacy', vi.fn(async () => {
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
    const native = owner('jlink-native', vi.fn(async () => ({
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

  it('routes CMSIS-DAP to its own owner and never falls back to J-Link', async () => {
    const createNative = vi.fn();
    const createLegacy = vi.fn();
    const helper = fakeCmsisDapHelper();
    const cmsisDap = new CmsisDapTargetChannel({ helperClient: helper });
    const selector = new SessionTargetSelector(createNative, createLegacy, () => cmsisDap);

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
    expect(createLegacy).not.toHaveBeenCalled();
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
      const createLegacy = vi.fn();
      const selector = new SessionTargetSelector(createNative, createLegacy, createCmsisDap);
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
      expect(createLegacy).not.toHaveBeenCalled();

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
    const createLegacy = vi.fn();
    const selector = new SessionTargetSelector(createNative, createLegacy, createCmsisDap);

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
    expect(createLegacy).not.toHaveBeenCalled();
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
    const createLegacy = vi.fn();
    const selector = new SessionTargetSelector(createNative, createLegacy, () => cmsisDap);

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
    expect(createLegacy).not.toHaveBeenCalled();
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
      diagnostics: { ownerKind: 'cmsis-dap', supportedTargets: ['STM32F407VET6', 'STM32H723VGT6'] },
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
    const selector = new SessionTargetSelector(vi.fn(), vi.fn(), () => cmsisDap);

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
    const selector = new SessionTargetSelector(vi.fn(), vi.fn(), () => cmsisDap);

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
    const selector = new SessionTargetSelector(vi.fn(), vi.fn(), () => cmsisDap);

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
    const createLegacy = vi.fn();
    const selector = new SessionTargetSelector(
      createNative,
      createLegacy,
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
    expect(createLegacy).not.toHaveBeenCalled();
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
    const createLegacy = vi.fn();
    const channel = new CmsisDapTargetChannel({ helperClient: helper });
    const selector = new SessionTargetSelector(createNative, createLegacy, () => channel);
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
    expect(createLegacy).not.toHaveBeenCalled();
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
});
