import { describe, expect, it, vi } from 'vitest';
import { SeggerRttMemoryEngine, SeggerRttMemoryPort } from './segger-rtt-memory';
import { RMLinkTargetChannel } from './rmlink-target-channel';
import type { RMLinkClient } from '../../clients/rmlink/rmlink-client.mjs';
import { isValidRttCapabilities, isValidRttEnumResult, isValidRttWriteResult } from './rtt-contract';

class SimTargetRam {
  readonly base = 0x20000000;
  readonly ram: Buffer;
  readonly roBase = 0x08000000;
  readonly ro: Buffer;
  readonly readSizes: number[] = [];
  readonly writeSizes: number[] = [];
  readonly readPriorities: string[] = [];
  readonly writePriorities: string[] = [];
  failAtWriteCall: number | null = null;
  failErrorCode = 'WriteTimeout';
  writeCalls = 0;

  constructor(size = 4096, roSize = 256) {
    this.ram = Buffer.alloc(size);
    this.ro = Buffer.alloc(roSize);
  }

  writeU32(addr: number, val: number): void {
    this.ram.writeUInt32LE(val >>> 0, addr - this.base);
  }

  readU32(addr: number): number {
    return this.ram.readUInt32LE(addr - this.base);
  }

  writeCStringRo(addr: number, text: string, nullTerminate = true): void {
    const off = addr - this.roBase;
    this.ro.write(text, off, 'ascii');
    if (nullTerminate) this.ro[off + text.length] = 0;
  }

  writeCStringRam(addr: number, text: string, nullTerminate = true): void {
    const off = addr - this.base;
    this.ram.write(text, off, 'ascii');
    if (nullTerminate) this.ram[off + text.length] = 0;
  }

  setupControlBlock(opts: {
    cbAddr?: number;
    maxUp?: number;
    maxDown?: number;
  } = {}): number {
    const cbAddr = opts.cbAddr ?? this.base + 0x100;
    const maxUp = opts.maxUp ?? 2;
    const maxDown = opts.maxDown ?? 1;
    const off = cbAddr - this.base;
    this.ram.fill(0, off, off + 24 + (maxUp + maxDown) * 24);
    this.ram.write('SEGGER RTT\0\0\0\0\0\0', off, 'ascii');
    this.ram.writeUInt32LE(maxUp, off + 16);
    this.ram.writeUInt32LE(maxDown, off + 20);
    return cbAddr;
  }

  setDescriptor(
    cbAddr: number,
    slotIndex: number,
    desc: { nameAddr: number; bufAddr: number; size: number; wrOff: number; rdOff: number; flags: number },
  ): void {
    const addr = cbAddr + 24 + slotIndex * 24;
    this.writeU32(addr + 0, desc.nameAddr);
    this.writeU32(addr + 4, desc.bufAddr);
    this.writeU32(addr + 8, desc.size);
    this.writeU32(addr + 12, desc.wrOff);
    this.writeU32(addr + 16, desc.rdOff);
    this.writeU32(addr + 20, desc.flags);
  }

  createPort(): SeggerRttMemoryPort {
    return {
      read: async (address, size, priority) => {
        this.readSizes.push(size);
        this.readPriorities.push(priority);
        if (address >= this.base && address + size <= this.base + this.ram.length) {
          const off = address - this.base;
          return {
            ok: true,
            message: 'ok',
            targetState: 'Running',
            elapsedMs: 1,
            data: { bytes: new Uint8Array(this.ram.subarray(off, off + size)) },
          };
        }
        if (address >= this.roBase && address + size <= this.roBase + this.ro.length) {
          const off = address - this.roBase;
          return {
            ok: true,
            message: 'ok',
            targetState: 'Running',
            elapsedMs: 1,
            data: { bytes: new Uint8Array(this.ro.subarray(off, off + size)) },
          };
        }
        return {
          ok: false,
          message: 'Out of simulated memory range',
          errorCode: 'MemoryReadFailed',
          targetState: 'Running',
          elapsedMs: 1,
        };
      },
      write: async (address, bytes, priority) => {
        this.writeCalls++;
        this.writeSizes.push(bytes.length);
        this.writePriorities.push(priority);
        if (this.failAtWriteCall !== null && this.writeCalls === this.failAtWriteCall) {
          return {
            ok: false,
            message: `Simulated ${this.failErrorCode}`,
            errorCode: this.failErrorCode,
            targetState: 'Running',
            elapsedMs: 1,
          };
        }
        if (address >= this.base && address + bytes.length <= this.base + this.ram.length) {
          Buffer.from(bytes).copy(this.ram, address - this.base);
          return {
            ok: true,
            message: 'ok',
            targetState: 'Running',
            elapsedMs: 1,
            data: { bytesWritten: bytes.length },
          };
        }
        return {
          ok: false,
          message: 'Out of simulated RAM range',
          errorCode: 'MemoryWriteFailed',
          targetState: 'Running',
          elapsedMs: 1,
        };
      },
    };
  }
}

describe('SeggerRttMemoryEngine', () => {
  it('enumerates Up/Down channels, resolves RO/RAM names, and detects duplicate or corrupt names', async () => {
    const sim = new SimTargetRam();
    const cb = sim.setupControlBlock({ maxUp: 3, maxDown: 2 });
    sim.writeCStringRo(sim.roBase + 0x10, 'Terminal');
    sim.writeCStringRo(sim.roBase + 0x30, 'SysView');
    sim.writeCStringRam(sim.base + 0x050, 'Terminal');
    sim.writeCStringRam(sim.base + 0x080, 'NoNull', false);

    sim.setDescriptor(cb, 0, { nameAddr: sim.roBase + 0x10, bufAddr: sim.base + 0x400, size: 64, wrOff: 0, rdOff: 0, flags: 0 });
    sim.setDescriptor(cb, 1, { nameAddr: sim.roBase + 0x30, bufAddr: sim.base + 0x500, size: 1024, wrOff: 0, rdOff: 0, flags: 0 });
    sim.setDescriptor(cb, 2, { nameAddr: sim.base + 0x050, bufAddr: sim.base + 0x900, size: 64, wrOff: 0, rdOff: 0, flags: 0 });
    sim.setDescriptor(cb, 3, { nameAddr: sim.roBase + 0x10, bufAddr: sim.base + 0x980, size: 64, wrOff: 0, rdOff: 0, flags: 0 });
    sim.setDescriptor(cb, 4, { nameAddr: sim.base + 0x080, bufAddr: sim.base + 0x9c0, size: 64, wrOff: 0, rdOff: 0, flags: 0 });
    // Fill rest of RAM with non-zero so NoNull doesn't encounter trailing zeros before range end.
    sim.ram.fill(0x41, 0x086, 0x100);

    const engine = new SeggerRttMemoryEngine(sim.createPort(), { maxChunkBytes: 128 });
    const ramRanges = [{ address: sim.base, size: sim.ram.length }];
    const roRanges = [{ address: sim.roBase, size: sim.ro.length }];
    const res = await engine.enumerate(cb, ramRanges, roRanges);

    expect(res.ok).toBe(true);
    expect(isValidRttEnumResult(res.data)).toBe(true);
    expect(res.data?.validUpCount).toBe(3);
    expect(res.data?.duplicateUpNames).toEqual(['Terminal']);
    expect(res.data?.upBuffers[1].name).toBe('SysView');
    expect(res.data?.upBuffers[1].nameStatus).toBe('ok');
    expect(res.data?.downBuffers[0].name).toBe('Terminal');
    expect(res.data?.downBuffers[1].nameStatus).toBe('unterminated');
  });

  it('reads wrap-around raw binary data with 128-byte chunking and advances physical RdOff once', async () => {
    const sim = new SimTargetRam();
    const cb = sim.setupControlBlock({ maxUp: 2, maxDown: 1 });
    const ringAddr = sim.base + 0x400;
    const ringSize = 256;
    sim.setDescriptor(cb, 1, { nameAddr: 0, bufAddr: ringAddr, size: ringSize, wrOff: 60, rdOff: 180, flags: 0 });

    // Available bytes = (256 - 180) + 60 = 136 bytes (> 128 chunk). Include NUL and high bytes.
    const expected = new Uint8Array(136);
    for (let i = 0; i < expected.length; i++) expected[i] = (i * 17 + 0x80) & 0xff;
    expected[5] = 0x00;
    expected[77] = 0x1b;
    expected[78] = 0x0d;
    expected[79] = 0x0a;
    Buffer.from(expected.subarray(0, 76)).copy(sim.ram, (ringAddr + 180) - sim.base);
    Buffer.from(expected.subarray(76)).copy(sim.ram, ringAddr - sim.base);

    const engine = new SeggerRttMemoryEngine(sim.createPort(), { maxChunkBytes: 128 });
    const started = await engine.start(cb, [{ address: sim.base, size: sim.ram.length }]);
    expect(started.ok).toBe(true);

    const readRes = await engine.readUp(1, 512);
    expect(readRes.ok).toBe(true);
    expect(readRes.data?.bytes).toEqual(expected);
    expect(readRes.data?.wrapped).toBe(true);
    expect(readRes.data?.rdOff).toBe(180);
    expect(readRes.data?.wrOff).toBe(60);
    expect(readRes.data?.committedRdOff).toBe(60);
    expect(sim.readU32(cb + 24 + 24 + 16)).toBe(60);
    expect(Math.max(...sim.readSizes)).toBeLessThanOrEqual(128);
    expect(sim.writeSizes).toEqual([4]);
  });

  it('writes Down channel with Mode 0/1/2 and surfaces unknown outcome without blind retry', async () => {
    const sim = new SimTargetRam();
    const cb = sim.setupControlBlock({ maxUp: 1, maxDown: 1 });
    const downAddr = sim.base + 0x600;
    sim.setDescriptor(cb, 1, { nameAddr: 0, bufAddr: downAddr, size: 16, wrOff: 12, rdOff: 2, flags: 1 }); // TRIM

    const engine = new SeggerRttMemoryEngine(sim.createPort(), { maxChunkBytes: 128 });
    const ramRanges = [{ address: sim.base, size: sim.ram.length }];

    // Available space = (16 - 12 + 2 - 1) = 5 bytes -> trim 7 bytes to 5 (wrap: 4 tail + 1 head).
    const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7]);
    const trimRes = await engine.writeDown(cb, ramRanges, 0, payload);
    expect(trimRes.ok).toBe(true);
    expect(isValidRttWriteResult(trimRes.data, payload.length, 0)).toBe(true);
    expect(trimRes.data?.shortWrite).toBe(true);
    expect(trimRes.data?.committedBytes).toBe(5);
    expect(trimRes.data?.wrapped).toBe(true);
    expect(trimRes.data?.committedWrOff).toBe(1);
    expect([...sim.ram.subarray(downAddr - sim.base + 12, downAddr - sim.base + 16)]).toEqual([1, 2, 3, 4]);
    expect(sim.ram[downAddr - sim.base]).toBe(5);

    // Fail at WrOff commit (writeCalls: trim did first(1), second(2), commit(3); next write data=4, commit=5).
    sim.setDescriptor(cb, 1, { nameAddr: 0, bufAddr: downAddr, size: 16, wrOff: 0, rdOff: 0, flags: 0 });
    sim.failAtWriteCall = 5;
    sim.failErrorCode = 'WriteTimeout';
    const callsBefore = sim.writeCalls;
    const failRes = await engine.writeDown(cb, ramRanges, 0, new Uint8Array([9, 10]));
    expect(failRes.ok).toBe(false);
    expect(failRes.errorCode).toBe('WriteTimeout');
    expect((failRes.diagnostics as any)?.rtt?.completion).toBe('unknown');
    expect((failRes.diagnostics as any)?.rtt?.failureStage).toBe('commit-wroff');
    expect(sim.writeCalls - callsBefore).toBe(2); // data + commit attempt, zero blind retry
  });

  it('wires RMLinkTargetChannel capabilities, enumerateRtt, writeRtt, and channel > 0 memory reads', async () => {
    const sim = new SimTargetRam();
    const cb = sim.setupControlBlock({ maxUp: 2, maxDown: 1 });
    sim.writeCStringRo(sim.roBase + 0x20, 'SysView');
    sim.setDescriptor(cb, 0, { nameAddr: 0, bufAddr: sim.base + 0x300, size: 64, wrOff: 0, rdOff: 0, flags: 0 });
    sim.setDescriptor(cb, 1, { nameAddr: sim.base + 0x400, bufAddr: sim.base + 0x440, size: 64, wrOff: 4, rdOff: 0, flags: 0 });
    sim.writeCStringRam(sim.base + 0x400, 'SysView');
    Buffer.from([0xaa, 0x00, 0xff, 0x55]).copy(sim.ram, 0x440);
    sim.setDescriptor(cb, 2, { nameAddr: 0, bufAddr: sim.base + 0x500, size: 32, wrOff: 0, rdOff: 0, flags: 0 });

    const client = {
      init: vi.fn(async () => ({ devices: [{ device_id: 'b81f3fc30470', paired: true, connected: true }] })),
      open: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      target: vi.fn(async (cmd: string, args: any) => {
        if (cmd === 'state') return { state: 'Running' };
        if (cmd === 'read_memory') {
          const off = (args.address >>> 0) - sim.base;
          return { data: sim.ram.subarray(off, off + args.byte_length).toString('hex') };
        }
        if (cmd === 'write_memory') {
          const bytes = Buffer.from(args.data, 'hex');
          // Mirror D:\STM32\RMLink\host\rmlink_connector\target.py word-alignment rule
          if ((args.address % 4) !== 0 || bytes.length === 0 || (bytes.length % 4) !== 0 || bytes.length > 4096) {
            throw Object.assign(new Error('InvalidRequest: Error: invalid_request'), {
              httpStatus: 400,
              errorCode: 'InvalidRequest',
            });
          }
          bytes.copy(sim.ram, (args.address >>> 0) - sim.base);
          return { bytes_written: bytes.length };
        }
        return {};
      }),
      subscribe: vi.fn(async () => ({ subscription_id: 1, capture_id: 1 })),
      unsubscribe: vi.fn(async () => undefined),
      stream: async function* () { return; },
    };

    const channel = new RMLinkTargetChannel(client as unknown as RMLinkClient);
    const conn = await channel.connect({ probe: 'rmlink', rmlinkDeviceId: 'b81f3fc30470', device: 'STM32H723VGT6', speedKHz: 4000 });
    expect(conn.ok).toBe(true);

    const caps = channel.getRttCapabilities();
    expect(isValidRttCapabilities(caps)).toBe(true);
    expect(caps.rttEnumerate.available).toBe(true);
    expect(caps.rttDownWrite.available).toBe(true);
    expect((caps.details as any)?.writeMemoryAlignmentBytes).toBe(4);

    const ram = [{ address: sim.base, size: sim.ram.length }];
    const enumRes = await channel.enumerateRtt(cb, { ramRanges: ram });
    expect(enumRes.ok).toBe(true);
    expect(enumRes.data?.upBuffers[1].name).toBe('SysView');

    const startRes = await channel.startRtt(cb, { ramRanges: ram, memoryBacked: true });
    expect(startRes.ok).toBe(true);

    const read1 = await channel.readRtt(1, 64);
    expect(read1.ok).toBe(true);
    expect(Buffer.from(read1.data!.bytes)).toEqual(Buffer.from([0xaa, 0x00, 0xff, 0x55]));
    expect(read1.data?.committedRdOff).toBe(4);

    // Pre-seed neighbor bytes in the 32-byte Down 0 buffer before 2-byte aligned RMW write
    sim.ram[0x502] = 0xc2;
    sim.ram[0x503] = 0xd3;
    const writeRes = await channel.writeRtt(0, new Uint8Array([0x5a, 0xa5]), { controlBlockAddress: cb, ramRanges: ram });
    expect(writeRes.ok).toBe(true);
    expect(sim.ram[0x500]).toBe(0x5a);
    expect(sim.ram[0x501]).toBe(0xa5);
    expect(sim.ram[0x502]).toBe(0xc2);
    expect(sim.ram[0x503]).toBe(0xd3);
    expect(sim.readU32(cb + 24 + 2 * 24 + 12)).toBe(2);

    // Non-RTT arbitrary unaligned writeMemory is rejected safely before sending write_memory RPC
    const unalignedDirect = await channel.writeMemory(sim.base + 0x501, new Uint8Array([1, 2]));
    expect(unalignedDirect.ok).toBe(false);
    expect(unalignedDirect.errorCode).toBe('UnsupportedCapability');
  });

  it('enforces real RMLink 4-byte alignment via safe edge RMW (11-byte payload, unaligned start, wrap-around, Mode 1 trim, neighbor preservation, and geometry rejection)', async () => {
    const sim = new SimTargetRam();
    const cb = sim.setupControlBlock({ maxUp: 1, maxDown: 2 });
    // Down 0: STM32H723 SysView-style 16-byte aligned buffer at +0x500
    const down0Addr = sim.base + 0x500;
    sim.ram.fill(0xe7, 0x500, 0x510);
    // Guard bytes outside Down 0 ring
    sim.ram[0x4ff] = 0x91;
    sim.ram[0x510] = 0x92;
    sim.setDescriptor(cb, 1, { nameAddr: 0, bufAddr: down0Addr, size: 16, wrOff: 0, rdOff: 0, flags: 1 }); // Mode 1 TRIM
    // Down 1: Unsafe unaligned ring geometry (bufAddr % 4 !== 0, size = 14)
    const down1Addr = sim.base + 0x601;
    sim.ram.fill(0x55, 0x600, 0x614);
    sim.setDescriptor(cb, 2, { nameAddr: 0, bufAddr: down1Addr, size: 14, wrOff: 0, rdOff: 0, flags: 0 });

    const client = {
      init: vi.fn(async () => ({ devices: [{ device_id: 'b81f3fc30470', paired: true, connected: true }] })),
      open: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      target: vi.fn(async (cmd: string, args: any) => {
        if (cmd === 'state') return { state: 'Running' };
        if (cmd === 'read_memory') {
          const off = (args.address >>> 0) - sim.base;
          return { data: sim.ram.subarray(off, off + args.byte_length).toString('hex') };
        }
        if (cmd === 'write_memory') {
          const bytes = Buffer.from(args.data, 'hex');
          if ((args.address % 4) !== 0 || bytes.length === 0 || (bytes.length % 4) !== 0 || bytes.length > 4096) {
            throw Object.assign(new Error('InvalidRequest: Error: invalid_request'), {
              httpStatus: 400,
              errorCode: 'InvalidRequest',
            });
          }
          bytes.copy(sim.ram, (args.address >>> 0) - sim.base);
          return { bytes_written: bytes.length };
        }
        return {};
      }),
      subscribe: vi.fn(async () => ({ subscription_id: 1, capture_id: 1 })),
      unsubscribe: vi.fn(async () => undefined),
      stream: async function* () { return; },
    };

    const channel = new RMLinkTargetChannel(client as unknown as RMLinkClient);
    await channel.connect({ probe: 'rmlink', rmlinkDeviceId: 'b81f3fc30470', device: 'STM32H723VGT6', speedKHz: 4000 });
    const ram = [{ address: sim.base, size: sim.ram.length }];

    // 1) Exact 11-byte real failing payload from H723 Round 1 acceptance:
    const payload11 = Uint8Array.from([0x00, 0xff, 0x80, 0x1b, 0x5b, 0x33, 0x31, 0x6d, 0x00, 0x04, 0x7f]);
    const w1 = await channel.writeRtt(0, payload11, { controlBlockAddress: cb, ramRanges: ram });
    expect(w1.ok).toBe(true);
    expect(w1.data?.committedBytes).toBe(11);
    expect(w1.data?.committedWrOff).toBe(11);
    expect([...sim.ram.subarray(0x500, 0x50b)]).toEqual([...payload11]);
    expect(sim.ram[0x50b]).toBe(0xe7); // Preserved trailing byte in word +0x508..+0x50b!
    expect(sim.ram[0x4ff]).toBe(0x91);
    expect(sim.ram[0x510]).toBe(0x92);

    // Simulate firmware consuming bytes 0..7 -> rdOff = 8, availableSpace = (16 - 11 + 8 - 1) = 12
    sim.writeU32(cb + 24 + 1 * 24 + 16, 8);

    // 2) Unaligned start (wrOff = 11) + wrap-around (5 tail + 3 head = 8 bytes):
    const payloadWrap = Uint8Array.from([0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x70, 0x80]);
    const w2 = await channel.writeRtt(0, payloadWrap, { controlBlockAddress: cb, ramRanges: ram });
    expect(w2.ok).toBe(true);
    expect(w2.data?.wrapped).toBe(true);
    expect(w2.data?.committedBytes).toBe(8);
    expect(w2.data?.committedWrOff).toBe(3); // (11 + 8) % 16 = 3
    expect([...sim.ram.subarray(0x50b, 0x510)]).toEqual([0x10, 0x20, 0x30, 0x40, 0x50]);
    expect([...sim.ram.subarray(0x500, 0x503)]).toEqual([0x60, 0x70, 0x80]);
    expect(sim.ram[0x503]).toBe(0x1b); // Preserved neighbor byte in word +0x500..+0x503!
    expect(sim.ram[0x50a]).toBe(0x7f); // Preserved prefix byte in word +0x508..+0x50b!
    expect(sim.ram[0x4ff]).toBe(0x91);
    expect(sim.ram[0x510]).toBe(0x92);

    // 3) Mode 1 short write with unaligned start (wrOff=3, rdOff=8 -> availableSpace = 4 bytes; send 7 bytes -> trim to 4):
    // Also set byte 7 = 0xAA to verify Mode 1 trim stops at offset 7 without overwriting byte 7
    sim.ram[0x507] = 0xaa;
    const w3 = await channel.writeRtt(0, Uint8Array.from([0xa1, 0xa2, 0xa3, 0xa4, 0xff, 0xff, 0xff]), { controlBlockAddress: cb, ramRanges: ram });
    expect(w3.ok).toBe(true);
    expect(w3.data?.shortWrite).toBe(true);
    expect(w3.data?.committedBytes).toBe(4);
    expect(w3.data?.committedWrOff).toBe(7);
    expect([...sim.ram.subarray(0x503, 0x507)]).toEqual([0xa1, 0xa2, 0xa3, 0xa4]);
    expect(sim.ram[0x507]).toBe(0xaa);

    // 4) Aligned slice fast path (rdOff=0, wrOff=0 -> 8 aligned bytes need ZERO extra pre-reads beyond CB+desc):
    sim.writeU32(cb + 24 + 1 * 24 + 12, 0);
    sim.writeU32(cb + 24 + 1 * 24 + 16, 0);
    client.target.mockClear();
    const w4 = await channel.writeRtt(0, Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]), { controlBlockAddress: cb, ramRanges: ram });
    expect(w4.ok).toBe(true);
    const readMemCalls = client.target.mock.calls.filter(call => call[0] === 'read_memory');
    expect(readMemCalls).toHaveLength(2); // Only CB header + Down descriptor

    // 5) Unsafe unaligned Down buffer geometry (Down 1 @ 0x20000601) rejected explicitly BEFORE any write:
    client.target.mockClear();
    const unsafeRes = await channel.writeRtt(1, Uint8Array.from([1, 2, 3]), { controlBlockAddress: cb, ramRanges: ram });
    expect(unsafeRes.ok).toBe(false);
    expect(unsafeRes.errorCode).toBe('RttInvalidBufferLayout');
    expect((unsafeRes.diagnostics as any)?.rtt?.completion).toBe('not-started');
    expect((unsafeRes.diagnostics as any)?.rtt?.failureStage).toBe('data-first');
    expect(client.target.mock.calls.filter(call => call[0] === 'write_memory')).toHaveLength(0);
    expect(sim.ram[0x600]).toBe(0x55);

    // 6) RMW pre-read failure on data-first vs data-second preserves exact completion semantics without blind retry:
    let writeCalls = 0;
    let readCount = 0;
    const failEngine = new SeggerRttMemoryEngine({
      read: async (addr, size, _prio) => {
        readCount++;
        // Call 1: CB, Call 2: Desc, Call 3: data-first RMW head read -> fail
        if (readCount === 3) {
          return { ok: false, errorCode: 'ReadTimeout', message: 'head pre-read timeout', targetState: 'Running', elapsedMs: 1 };
        }
        const off = addr - sim.base;
        return { ok: true, message: 'ok', targetState: 'Running', elapsedMs: 1, data: { bytes: new Uint8Array(sim.ram.subarray(off, off + size)) } };
      },
      write: async (_addr, b) => {
        writeCalls++;
        return { ok: true, message: 'ok', targetState: 'Running', elapsedMs: 1, data: { bytesWritten: b.length } };
      },
    }, { maxChunkBytes: 128, writeAlignmentBytes: 4 });
    // Put wrOff=1, rdOff=0 on Down 0 so headPad=1 triggers pre-read
    sim.writeU32(cb + 24 + 1 * 24 + 12, 1);
    sim.writeU32(cb + 24 + 1 * 24 + 16, 0);
    const preReadFail = await failEngine.writeDown(cb, ram, 0, Uint8Array.from([0x11, 0x22]));
    expect(preReadFail.ok).toBe(false);
    expect((preReadFail.diagnostics as any)?.rtt?.completion).toBe('not-started');
    expect((preReadFail.diagnostics as any)?.rtt?.failureStage).toBe('data-first');
    expect(writeCalls).toBe(0);
  });
});
