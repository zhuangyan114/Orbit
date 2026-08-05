import { describe, expect, it, vi } from 'vitest';
import {
  CmsisDapTargetChannel,
  SessionTargetOwner,
  SessionTargetSelector,
} from './session-target-channel';
import { CmsisDapDeviceInfo, CmsisDapHelperClient } from './cmsis-dap-helper-channel';

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

    expect(result).toMatchObject({ ok: true, data: { channel: 'cmsis-dap' } });
    expect(helper.start).toHaveBeenCalledTimes(1);
    expect(createNative).not.toHaveBeenCalled();
    expect(createLegacy).not.toHaveBeenCalled();
    expect(selector.ownerKind).toBe('cmsis-dap');
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

  it('rejects CMSIS-DAP winusb transport with UnsupportedCapability without spawning the helper', async () => {
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

    expect(result).toMatchObject({ ok: false, errorCode: 'UnsupportedCapability' });
    expect(helper.start).not.toHaveBeenCalled();
    expect(selector.ownerKind).toBe('none');
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

  it('returns structured UnsupportedCapability for unimplemented CMSIS-DAP operations', async () => {
    const channel = new CmsisDapTargetChannel({ helperClient: fakeCmsisDapHelper() });

    await expect(channel.stepIntoSourceLine({ lineStart: 1, lineEnd: 2 })).resolves.toMatchObject({
      ok: false,
      errorCode: 'UnsupportedCapability',
      diagnostics: { ownerKind: 'cmsis-dap', capability: 'stepIntoSourceLine' },
    });
    await expect(channel.writeMemory(0x20000000, new Uint8Array([0]))).resolves.toMatchObject({
      ok: false,
      errorCode: 'UnsupportedCapability',
      diagnostics: { ownerKind: 'cmsis-dap', capability: 'writeMemory' },
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

  it('aggregates CMSIS-DAP batch reads and fails the batch on the first error', async () => {
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
    expect(batch.data!.reads[1]).toEqual({ address: 0x20000004, bytes: Uint8Array.from([1, 2, 3, 4]) });

    const failingHelper = fakeCmsisDapHelper({
      request: vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
        if (method === 'readMemory') {
          return {
            ok: false,
            message: 'read failed',
            targetState: 'Error' as const,
            elapsedMs: 0,
            errorCode: 'DapAckWait',
          };
        }
        const base = fakeCmsisDapHelper().request as ReturnType<typeof vi.fn>;
        return base(method, params);
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
