import { describe, expect, it, vi } from 'vitest';
import { adapterCommands, parseOpenOcdEndpoint, resolveOpenOcdTarget, RMLinkProbeHandoff, validateOpenOcdImage } from './openocd-flasher';
import { STM32H723VGT6 } from './cmsis-dap-flasher';
import type { RMLinkClient } from '../../clients/rmlink/rmlink-client.mjs';

function imageWithSegments(...addresses: number[]): Uint8Array {
  const headersEnd = 52 + addresses.length * 32;
  const buffer = Buffer.alloc(headersEnd + addresses.length * 4);
  buffer.set([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1]);
  buffer.writeUInt16LE(2, 16);
  buffer.writeUInt16LE(40, 18);
  buffer.writeUInt32LE(1, 20);
  buffer.writeUInt32LE(52, 28);
  buffer.writeUInt16LE(32, 42);
  buffer.writeUInt16LE(addresses.length, 44);
  addresses.forEach((address, index) => {
    const header = 52 + index * 32;
    buffer.writeUInt32LE(1, header);
    buffer.writeUInt32LE(headersEnd + index * 4, header + 4);
    buffer.writeUInt32LE(0x20000000 + index * 4, header + 8);
    buffer.writeUInt32LE(address, header + 12);
    buffer.writeUInt32LE(4, header + 16);
    buffer.writeUInt32LE(4, header + 20);
  });
  return buffer;
}

describe('OpenOCD flash routing', () => {
  it.each(['usb_bulk', 'hid'] as const)('selects the USB VID/PID using the bundled OpenOCD command for %s', transport => {
    expect(adapterCommands({
      kind: 'usb', transport, vid: '0xFAED', pid: '0x4870', serial: '507211371614',
    })).toEqual([
      'cmsis-dap backend ' + transport, 'adapter usb vid_pid 0xFAED 0x4870', 'adapter serial "507211371614"',
    ]);
  });

  it.each([
    [' STM32H723VGT6 ', 'stm32h7x'],
    ['stm32f103c6t6', 'stm32f1x'],
    ['STM32F401CCU6', 'stm32f4x'],
    ['STM32G431CBT6', 'stm32g4x'],
    ['STM32H745ZIT6', undefined],
    ['STM32F103VGT6', undefined],
    ['../../scripts/run.cfg', undefined],
  ])('maps %s to %s', (name, script) => expect(resolveOpenOcdTarget(name)).toBe(script));

  it('accepts load addresses inside Flash and refuses overlapping or out-of-bank sections', () => {
    expect(validateOpenOcdImage(imageWithSegments(0x08000000, 0x080ffffc), STM32H723VGT6))
      .toEqual([{ start: 0x08000000, end: 0x08000004 }, { start: 0x080ffffc, end: 0x08100000 }]);
    for (const address of [0x08000002, 0x080ffffe, 0x20000000, 0x90000000]) {
      expect(() => validateOpenOcdImage(imageWithSegments(0x08000000, address), STM32H723VGT6)).toThrow(/Flash|overlap/);
    }
  });

  it('validates the connector endpoint before producing Tcl arguments', () => {
    expect(parseOpenOcdEndpoint('172.19.2.1')).toEqual({ kind: 'tcp', host: '172.19.2.1', port: 3241 });
    expect(parseOpenOcdEndpoint('[fe80::1]:4441')).toEqual({ kind: 'tcp', host: 'fe80::1', port: 4441 });
    for (const invalid of ['host:0', 'host:65536', 'host; reset', '[host]', 'host\nshutdown']) {
      expect(() => parseOpenOcdEndpoint(invalid)).toThrow();
    }
  });

  it('pins a specific RMLink and restores management after the exclusive stage', async () => {
    const deviceId = 'b81f3fc30470';
    const request = vi.fn().mockResolvedValueOnce({ connected: false }).mockResolvedValueOnce({ connected: true });
    const client = {
      init: vi.fn().mockResolvedValue({ devices: [{ device_id: deviceId, paired: true, connected: true,
        active_transport: 'wifi', address: 'rmlink-probe.local' }] }),
      request,
    } as unknown as RMLinkClient;
    const handoff = await RMLinkProbeHandoff.prepare(undefined, client);
    expect(handoff.debugConfig).toEqual({ cmsisDapTransport: 'tcp', cmsisDapPath: 'rmlink-probe.local' });
    await handoff.acquire();
    await handoff.release();
    expect(request.mock.calls).toEqual([
      ['POST', '/disconnect', { device_id: deviceId }],
      ['POST', '/connect', { device_id: deviceId }],
    ]);
  });
});
