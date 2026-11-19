import * as fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildSymbolCatalog, parseDwarfTypeInfo, readElfSymbols } from '../ozone-backend/jlink-symbols';
import type { SymbolCatalog } from '../symbols/symbol-catalog';
import {
  compileSystemViewTargetMetadata,
  computeRingReadPlan,
  decodeFixtureCapture,
  decodeSystemViewGlobals,
  isRangeInMemoryRanges,
  validateSysViewBufferDescriptor,
} from './systemview-target-metadata';

function createSyntheticCatalog(postMortem: boolean, includeFixtureCapture = true): SymbolCatalog {
  const types: SymbolCatalog['types'] = {
    '0x1': { name: 'unsigned char', kind: 'base', byteSize: 1 },
    '0x2': { name: 'unsigned int', kind: 'base', byteSize: 4 },
    '0x3': { name: 'void *', kind: 'pointer', byteSize: 4 },
    '0x10': {
      name: 'SEGGER_SYSVIEW_CORE_CONTEXT',
      kind: 'struct',
      byteSize: postMortem ? 24 : 28,
      fields: postMortem
        ? [
            { name: 'EnableState', typeOffset: '0x1', byteOffset: 0 },
            { name: 'UpChannel', typeOffset: '0x1', byteOffset: 1 },
            { name: 'RecursionCnt', typeOffset: '0x1', byteOffset: 2 },
            { name: 'SysFreq', typeOffset: '0x2', byteOffset: 4 },
            { name: 'CPUFreq', typeOffset: '0x2', byteOffset: 8 },
            { name: 'LastTxTimeStamp', typeOffset: '0x2', byteOffset: 12 },
            { name: 'RAMBaseAddress', typeOffset: '0x2', byteOffset: 16 },
            { name: 'PacketCount', typeOffset: '0x2', byteOffset: 20 },
          ]
        : [
            { name: 'EnableState', typeOffset: '0x1', byteOffset: 0 },
            { name: 'UpChannel', typeOffset: '0x1', byteOffset: 1 },
            { name: 'RecursionCnt', typeOffset: '0x1', byteOffset: 2 },
            { name: 'SysFreq', typeOffset: '0x2', byteOffset: 4 },
            { name: 'CPUFreq', typeOffset: '0x2', byteOffset: 8 },
            { name: 'LastTxTimeStamp', typeOffset: '0x2', byteOffset: 12 },
            { name: 'RAMBaseAddress', typeOffset: '0x2', byteOffset: 16 },
            { name: 'DropCount', typeOffset: '0x2', byteOffset: 20 },
            { name: 'DownChannel', typeOffset: '0x1', byteOffset: 24 },
          ],
    },
    '0x11': {
      name: 'SEGGER_SYSVIEW_GLOBALS',
      kind: 'struct',
      byteSize: postMortem ? 44 : 48,
      fields: [
        { name: 'MainContext', typeOffset: '0x10', byteOffset: 0 },
        { name: 'DisabledEvents', typeOffset: '0x2', byteOffset: postMortem ? 24 : 28 },
      ],
    },
    '0x20': {
      name: 'FixtureCapture',
      kind: 'struct',
      byteSize: 32,
      fields: [
        { name: 'mode', typeOffset: '0x2', byteOffset: 0 },
        { name: 'frozen', typeOffset: '0x2', byteOffset: 4 },
        { name: 'generation', typeOffset: '0x2', byteOffset: 8 },
        { name: 'size', typeOffset: '0x2', byteOffset: 12 },
        { name: 'wrOff', typeOffset: '0x2', byteOffset: 16 },
        { name: 'rdOff', typeOffset: '0x2', byteOffset: 20 },
        { name: 'enabledBeforeStop', typeOffset: '0x2', byteOffset: 24 },
        { name: 'buffer', typeOffset: '0x3', byteOffset: 28 },
      ],
    },
    '0x21': { name: '', kind: 'volatile', byteSize: 32, typeOffset: '0x20' },
  };

  const roots: SymbolCatalog['roots'] = [
    { id: 'rtt', expression: '_SEGGER_RTT', file: 'SEGGER_RTT.c', typeOffset: '', address: 0x20013474, size: 168, pointerDepth: 0 },
    { id: 'sv', expression: '_SYSVIEW_Globals', file: 'SEGGER_SYSVIEW.c', typeOffset: '0x11', address: 0x20011278, size: postMortem ? 44 : 48, pointerDepth: 0 },
  ];
  if (includeFixtureCapture) {
    roots.push({ id: 'fc', expression: 'fixtureCapture', file: 'main.c', typeOffset: '0x21', address: 0x20000000, size: 32, pointerDepth: 0 });
  }
  return { roots, types };
}

describe('systemview-target-metadata', () => {
  it('compiles DWARF layout for normal and post-mortem _SYSVIEW_Globals and fixtureCapture without hardcoded offsets', () => {
    const normal = compileSystemViewTargetMetadata(createSyntheticCatalog(false), 'sha-normal');
    expect(normal.rttControlBlockAddress).toBe(0x20013474);
    expect(normal.globals?.postMortemCompiled).toBe(false);
    expect(normal.globals?.fields.downChannel).toEqual({ offset: 24, size: 1 });
    expect(normal.globals?.fields.dropCount).toEqual({ offset: 20, size: 4 });
    expect(normal.globals?.fields.packetCount).toBeUndefined();
    expect(normal.fixtureCapture?.fields.buffer).toEqual({ offset: 28, size: 4 });

    const pm = compileSystemViewTargetMetadata(createSyntheticCatalog(true, false), 'sha-pm');
    expect(pm.globals?.postMortemCompiled).toBe(true);
    expect(pm.globals?.fields.packetCount).toEqual({ offset: 20, size: 4 });
    expect(pm.globals?.fields.downChannel).toBeUndefined();
    expect(pm.fixtureCapture).toBeUndefined();
    expect(pm.fixtureCaptureUnavailableReason).toContain('fixtureCapture');
  });

  it('decodes _SYSVIEW_Globals and fixtureCapture little-endian bytes cleanly', () => {
    const meta = compileSystemViewTargetMetadata(createSyntheticCatalog(false), 'sha-dec');
    const gBuf = Buffer.alloc(meta.globals!.size);
    gBuf.writeUInt8(1, 0); // EnableState
    gBuf.writeUInt8(2, 1); // UpChannel
    gBuf.writeUInt32LE(64_000_000, 4);
    gBuf.writeUInt32LE(64_000_000, 8);
    gBuf.writeUInt32LE(0x12345678, 12);
    gBuf.writeUInt32LE(0x20000000, 16);
    gBuf.writeUInt32LE(5, 20); // DropCount
    gBuf.writeUInt8(2, 24); // DownChannel
    expect(decodeSystemViewGlobals(gBuf, meta.globals!)).toEqual({
      enableState: 1,
      upChannel: 2,
      sysFreq: 64_000_000,
      cpuFreq: 64_000_000,
      ramBaseAddress: 0x20000000,
      lastTxTimeStamp: 0x12345678,
      dropCount: 5,
      downChannel: 2,
    });

    const fBuf = Buffer.alloc(meta.fixtureCapture!.size);
    fBuf.writeUInt32LE(3, 0);
    fBuf.writeUInt32LE(1, 4);
    fBuf.writeUInt32LE(4, 8);
    fBuf.writeUInt32LE(8192, 12);
    fBuf.writeUInt32LE(5317, 16);
    fBuf.writeUInt32LE(5318, 20);
    fBuf.writeUInt32LE(1, 24);
    fBuf.writeUInt32LE(0x200112b0, 28);
    expect(decodeFixtureCapture(fBuf, meta.fixtureCapture!)).toEqual({
      mode: 3,
      frozen: 1,
      generation: 4,
      size: 8192,
      wrOff: 5317,
      rdOff: 5318,
      enabledBeforeStop: 1,
      buffer: 0x200112b0,
    });
  });

  it('computes chronological ring read slices without modifying RdOff and validates geometry', () => {
    const ram = [{ address: 0x20000000, size: 0x20000 }];
    expect(isRangeInMemoryRanges(0x200112b0, 8192, ram)).toBe(true);
    expect(isRangeInMemoryRanges(0x2001f000, 8192, ram)).toBe(false);

    const empty = computeRingReadPlan('single-shot', 0x200112b0, 8192, 0, 0);
    expect(empty.ok && empty.plan.empty).toBe(true);

    const linear = computeRingReadPlan('single-shot', 0x200112b0, 8192, 68, 0);
    expect(linear).toEqual({
      ok: true,
      plan: {
        empty: false,
        wrapped: false,
        prefixOverwritten: false,
        retainedBytes: 68,
        slices: [{ address: 0x200112b0, size: 68, ringOffset: 0 }],
      },
    });

    const wrappedPm = computeRingReadPlan('post-mortem', 0x200112b0, 8192, 5317, 5318);
    expect(wrappedPm).toEqual({
      ok: true,
      plan: {
        empty: false,
        wrapped: true,
        prefixOverwritten: true,
        retainedBytes: 8191,
        slices: [
          { address: 0x200112b0 + 5318, size: 8192 - 5318, ringOffset: 5318 },
          { address: 0x200112b0, size: 5317, ringOffset: 0 },
        ],
      },
    });

    const badDesc = validateSysViewBufferDescriptor({
      direction: 'up',
      index: 2,
      descriptorAddress: 0x200134b0,
      configured: true,
      valid: true,
      status: 'valid',
      name: 'SysView',
      nameAddress: 0x08004000,
      nameStatus: 'ok',
      duplicateName: false,
      bufferAddress: 0x200112b0,
      bufferSize: 8192,
      wrOff: 8192,
      rdOff: 0,
      flags: 0,
      mode: 0,
    }, ram);
    expect(badDesc.ok).toBe(false);
  });

  const acceptanceDir = 'D:\\STM32\\project\\h7vgt6_test\\build\\OrbitSystemViewAcceptance';
  const hasElfs = fs.existsSync(`${acceptanceDir}\\trace-continuous.elf`)
    && fs.existsSync(`${acceptanceDir}\\trace-single-shot.elf`)
    && fs.existsSync(`${acceptanceDir}\\trace-post-mortem.elf`);

  it.skipIf(!hasElfs)('compiles real DWARF metadata from the three Stage 0 acceptance ELFs', async () => {
    for (const entry of [
      { file: 'trace-continuous.elf', expectedPm: false },
      { file: 'trace-single-shot.elf', expectedPm: false },
      { file: 'trace-post-mortem.elf', expectedPm: true },
    ]) {
      const elfPath = `${acceptanceDir}\\${entry.file}`;
      const [syms, dwarf] = await Promise.all([readElfSymbols(elfPath), parseDwarfTypeInfo(elfPath)]);
      const catalog = buildSymbolCatalog(syms, dwarf);
      const meta = compileSystemViewTargetMetadata(catalog, entry.file);
      expect(meta.rttControlBlockAddress).toBeGreaterThan(0x20000000);
      expect(meta.globals?.postMortemCompiled).toBe(entry.expectedPm);
      expect(meta.fixtureCapture?.address).toBe(0x20000000);
      expect(meta.fixtureCapture?.fields.mode.offset).toBe(0);
      expect(meta.fixtureCapture?.fields.frozen.offset).toBe(4);
      expect(meta.fixtureCapture?.fields.generation.offset).toBe(8);
    }
  });
});
