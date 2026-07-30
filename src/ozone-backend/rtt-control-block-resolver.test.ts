import { describe, expect, it, vi } from 'vitest';
import { RttControlBlockResolver } from './rtt-control-block-resolver';

describe('RttControlBlockResolver', () => {
  it('prefers explicit address, then ELF symbol', async () => {
    const explicit = new RttControlBlockResolver({
      explicitAddress: 0x20001000,
      symbols: [{ name: '_SEGGER_RTT', address: 0x20002000 }],
    });
    await expect(explicit.resolve()).resolves.toMatchObject({
      ok: true,
      data: { address: 0x20001000, source: 'explicit' },
    });

    const symbol = new RttControlBlockResolver({
      symbols: [{ name: '_SEGGER_RTT', address: 0x20002000 }],
    });
    await expect(symbol.resolve()).resolves.toMatchObject({
      ok: true,
      data: { address: 0x20002000, source: 'elf-symbol', symbol: '_SEGGER_RTT' },
    });
  });

  it('finds a signature across bounded read chunks with alignment', async () => {
    const start = 0x20000000;
    const memory = new Uint8Array(40);
    memory.set(Uint8Array.from(Buffer.from('SEGGER RTT', 'ascii')), 8);
    const readMemory = vi.fn(async (address: number, size: number) => {
      const offset = address - start;
      return memory.slice(offset, offset + size);
    });
    const resolver = new RttControlBlockResolver({
      autoSearch: {
        ranges: [{ start, end: start + memory.length }],
        maxBytes: memory.length,
        chunkSize: 8,
        alignment: 4,
      },
      readMemory,
    });

    await expect(resolver.resolve()).resolves.toMatchObject({
      ok: true,
      data: { address: start + 8, source: 'auto-search' },
    });
    expect(readMemory).toHaveBeenCalledTimes(3);
  });

  it('rejects unbounded or unsuccessful searches with diagnosable errors', async () => {
    const missing = new RttControlBlockResolver({
      symbols: [],
      autoSearch: { ranges: [{ start: 0x20000000, end: 0x20000020 }], maxBytes: 0x20 },
      readMemory: async () => new Uint8Array(0x20),
    });
    await expect(missing.resolve()).resolves.toMatchObject({
      ok: false,
      error: { code: 'ControlBlockNotFound', category: 'protocol' },
    });

    const invalid = new RttControlBlockResolver({
      autoSearch: { ranges: [{ start: 0x20000000, end: 0x20000020 }], maxBytes: 17 * 1024 * 1024 },
      readMemory: async () => new Uint8Array(),
    });
    await expect(invalid.resolve()).resolves.toMatchObject({
      ok: false,
      error: { code: 'InvalidArgument', category: 'protocol' },
    });
  });
});
