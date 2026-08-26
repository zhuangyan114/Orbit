import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  STM32F407VET6,
  STM32H723VGT6,
  calculateEraseSectors,
  CmsisDapFlashError,
  coalesceFlashProgramRanges,
  FlashTargetDefinition,
  flashCmsisDapElf,
  listBuiltinFlashAlgorithms,
  listFlashTargets,
  loadFlashAlgorithm,
  parseElf32LoadSegments,
  planFlashRamLayout,
  resolveFlashTarget,
  validateFlashTargetDefinition,
  validateTargetDeviceName,
} from './cmsis-dap-flasher';

interface TestSegment {
  address: number;
  virtualAddress?: number;
  loadAddress?: number;
  bytes?: number[];
  memorySize?: number;
}

function makeElf(segments: TestSegment[], overrides: Partial<{
  magic: number;
  elfClass: number;
  data: number;
  phoff: number;
  phentsize: number;
  phnum: number;
}> = {}): Uint8Array {
  const phoff = overrides.phoff ?? 0x34;
  const phentsize = overrides.phentsize ?? 32;
  const phnum = overrides.phnum ?? segments.length;
  const fileEnd = Math.max(
    phoff + phentsize * phnum,
    ...segments.map((segment, index) => 0x200 + index * 0x100 + (segment.bytes?.length ?? 0)),
  );
  const bytes = new Uint8Array(fileEnd);
  bytes.fill(0);
  bytes[0] = overrides.magic ?? 0x7f;
  bytes[1] = 0x45;
  bytes[2] = 0x4c;
  bytes[3] = 0x46;
  bytes[4] = overrides.elfClass ?? 1;
  bytes[5] = overrides.data ?? 1;
  bytes[6] = 1;
  const view = new DataView(bytes.buffer);
  view.setUint16(16, 2, true);
  view.setUint16(18, 40, true);
  view.setUint32(20, 1, true);
  view.setUint32(28, phoff, true);
  view.setUint16(42, phentsize, true);
  view.setUint16(44, phnum, true);
  segments.forEach((segment, index) => {
    const offset = 0x200 + index * 0x100;
    const ph = phoff + index * phentsize;
    const payload = segment.bytes ?? [];
    const virtualAddress = segment.virtualAddress ?? segment.address;
    const loadAddress = segment.loadAddress ?? virtualAddress;
    view.setUint32(ph, 1, true);
    view.setUint32(ph + 4, offset, true);
    view.setUint32(ph + 8, virtualAddress, true);
    view.setUint32(ph + 12, loadAddress, true);
    view.setUint32(ph + 16, payload.length, true);
    view.setUint32(ph + 20, segment.memorySize ?? payload.length, true);
    view.setUint32(ph + 24, 5, true);
    view.setUint32(ph + 28, 4, true);
    bytes.set(payload, offset);
  });
  return bytes;
}

describe('STM32F407VET6 CMSIS-DAP flash model', () => {
  it('rejects an algorithm whose completion entry is not a Thumb BKPT', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-cmsis-algorithm-entry-'));
    try {
      const algorithmPath = path.join(tempDir, 'algorithm.bin');
      fs.writeFileSync(algorithmPath, Buffer.alloc(0x600, 0xBF));
      expect(() => loadFlashAlgorithm(STM32F407VET6, algorithmPath)).toThrow(/BKPT/);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('loads CMSIS-Pack static_base metadata for the R9 ABI argument', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-cmsis-static-base-'));
    try {
      const binaryPath = path.join(tempDir, 'algorithm.bin');
      const manifestPath = path.join(tempDir, 'algorithm.json');
      const algorithm = Buffer.alloc(0x600, 0xBF);
      algorithm[0x500] = 0x00;
      algorithm[0x501] = 0xBE;
      fs.writeFileSync(binaryPath, algorithm);
      fs.writeFileSync(manifestPath, JSON.stringify({
        binary: 'algorithm.bin',
        staticBase: 0x20001000,
        entries: { init: 0, uninit: 0x100, eraseSector: 0x200, programPage: 0x300, verify: 0x400, bkpt: 0x500 },
      }));
      expect(loadFlashAlgorithm(STM32F407VET6, manifestPath).staticBase).toBe(0x20001000);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('requires an explicit user manifest opt-in before reusing the page buffer', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-cmsis-page-buffer-'));
    try {
      const binaryPath = path.join(tempDir, 'algorithm.bin');
      const manifestPath = path.join(tempDir, 'algorithm.json');
      const algorithm = Buffer.alloc(0x600, 0xBF);
      algorithm[0x500] = 0x00;
      algorithm[0x501] = 0xBE;
      fs.writeFileSync(binaryPath, algorithm);
      fs.writeFileSync(manifestPath, JSON.stringify({
        binary: 'algorithm.bin',
        preservesPageBuffer: true,
        entries: { init: 0, uninit: 0x100, eraseSector: 0x200, programPage: 0x300, verify: 0x400, bkpt: 0x500 },
      }));

      expect(loadFlashAlgorithm(STM32F407VET6, binaryPath).preservesPageBuffer).toBe(false);
      expect(loadFlashAlgorithm(STM32F407VET6, manifestPath).preservesPageBuffer).toBe(true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('freezes the device identity, 512 KiB range, and exact sector boundaries', () => {
    expect(STM32F407VET6.preflight.deviceId).toBe(0x413);
    expect(STM32F407VET6.flashBase).toBe(0x08000000);
    expect(STM32F407VET6.flashSize).toBe(512 * 1024);
    expect(STM32F407VET6.sectors.map(sector => [sector.number, sector.address, sector.size])).toEqual([
      [0, 0x08000000, 0x4000],
      [1, 0x08004000, 0x4000],
      [2, 0x08008000, 0x4000],
      [3, 0x0800c000, 0x4000],
      [4, 0x08010000, 0x10000],
      [5, 0x08020000, 0x20000],
      [6, 0x08040000, 0x20000],
      [7, 0x08060000, 0x20000],
    ]);
    const lastSector = STM32F407VET6.sectors[STM32F407VET6.sectors.length - 1]!;
    expect(lastSector.address + lastSector.size).toBe(0x08080000);
  });

  it('describes the loader RAM window, preflight registers, algorithm, and timeouts', () => {
    expect(STM32F407VET6.ramRegions).toEqual([
      { name: 'SRAM', address: 0x20000000, size: 128 * 1024 },
    ]);
    expect(STM32F407VET6.loaderRamIndex).toBe(0);
    expect(STM32F407VET6.preflight).toEqual({
      idcodeAddress: 0xE0042000,
      deviceId: 0x413,
      flashSizeRegisterAddress: 0x1FFF7A22,
      expectedFlashSizeKiB: 512,
    });
    expect(STM32F407VET6.algorithm).toBe('stm32f407');
    expect(STM32F407VET6.eraseTimeoutMs).toBe(5000);
    expect(STM32F407VET6.programTimeoutMs).toBe(5000);
  });

  it('accepts the unqualified STM32F407VE alias but rejects other densities', () => {
    expect(() => validateTargetDeviceName('STM32F407VE', STM32F407VET6)).not.toThrow();
    expect(() => validateTargetDeviceName('stm32f407ve', STM32F407VET6)).not.toThrow();
    expect(() => validateTargetDeviceName('STM32F407VG', STM32F407VET6)).toThrow(/only supports STM32F407VET6/);
  });

  it('parses multiple load segments and preserves empty and RAM segments', () => {
    const elf = makeElf([
      { address: 0x08000000, bytes: [1, 2, 3, 4] },
      { address: 0x20000000, bytes: [5, 6], memorySize: 16 },
      { address: 0x08004000, bytes: [], memorySize: 0 },
    ]);
    const parsed = parseElf32LoadSegments(elf);
    expect(parsed.map(segment => ({ address: segment.address, fileSize: segment.fileSize, memorySize: segment.memorySize })))
      .toEqual([
        { address: 0x08000000, fileSize: 4, memorySize: 4 },
        { address: 0x20000000, fileSize: 2, memorySize: 16 },
        { address: 0x08004000, fileSize: 0, memorySize: 0 },
      ]);
    expect(Array.from(parsed[0].bytes)).toEqual([1, 2, 3, 4]);
  });

  it('keeps SRAM runtime addresses separate from Flash load addresses', () => {
    const elf = makeElf([
      { address: 0x08000000, bytes: [1, 2, 3, 4] },
      { address: 0x20000000, loadAddress: 0x08000004, bytes: [5, 6], memorySize: 16 },
      { address: 0x20000010, loadAddress: 0x08000006, bytes: [], memorySize: 0x100 },
    ]);
    const parsed = parseElf32LoadSegments(elf);
    expect(parsed.map(segment => ({
      address: segment.address,
      loadAddress: segment.loadAddress,
      fileSize: segment.fileSize,
      memorySize: segment.memorySize,
    }))).toEqual([
      { address: 0x08000000, loadAddress: 0x08000000, fileSize: 4, memorySize: 4 },
      { address: 0x20000000, loadAddress: 0x08000004, fileSize: 2, memorySize: 16 },
      { address: 0x20000010, loadAddress: 0x08000006, fileSize: 0, memorySize: 0x100 },
    ]);
    expect(calculateEraseSectors(parsed, STM32F407VET6).map(sector => sector.number)).toEqual([0]);
  });

  it('rejects malformed, truncated, overflowing, and overlapping ELF segments', () => {
    expect(() => parseElf32LoadSegments(makeElf([{ address: 0x08000000, bytes: [1] }], { magic: 0 })))
      .toThrow(/ELF/);
    expect(() => parseElf32LoadSegments(makeElf([{ address: 0x08000000, bytes: [1] }], { elfClass: 2 })))
      .toThrow(/32-bit/);
    expect(() => parseElf32LoadSegments(makeElf([{ address: 0x08000000, bytes: [1] }], { phentsize: 16 })))
      .toThrow(/program header/);
    const truncated = makeElf([{ address: 0x08000000, bytes: [1] }]);
    expect(() => parseElf32LoadSegments(truncated.slice(0, 0x200))).toThrow(/outside|truncated/);
    expect(() => parseElf32LoadSegments(makeElf([
      { address: 0x08000000, bytes: [1, 2], memorySize: 8 },
      { address: 0x08000004, bytes: [3], memorySize: 4 },
    ]))).toThrow(/overlap/);
    expect(() => parseElf32LoadSegments(makeElf([
      { address: 0x08000000, loadAddress: 0x08010000, bytes: [1, 2] },
      { address: 0x20000000, loadAddress: 0x08010001, bytes: [3] },
    ]))).toThrow(/load ranges overlap/);
  });

  it('rejects a VMA or LMA outside the supported Flash and SRAM windows', () => {
    const invalidVma = parseElf32LoadSegments(makeElf([
      { address: 0x10000000, loadAddress: 0x08000000, bytes: [1] },
    ]));
    expect(() => calculateEraseSectors(invalidVma, STM32F407VET6)).toThrow(/outside STM32F407VET6 Flash and RAM regions/);

    const invalidLma = parseElf32LoadSegments(makeElf([
      { address: 0x20000000, loadAddress: 0x10000000, bytes: [1] },
    ]));
    expect(() => calculateEraseSectors(invalidLma, STM32F407VET6)).toThrow(/load bytes/);
  });

  it('selects only sectors intersecting flash load bytes', () => {
    const segments = parseElf32LoadSegments(makeElf([
      { address: 0x08003ffc, bytes: [1, 2, 3, 4, 5] },
      { address: 0x20000000, bytes: [9, 9, 9, 9] },
    ]));
    expect(calculateEraseSectors(segments, STM32F407VET6).map(sector => sector.number)).toEqual([0, 1]);
  });

  it('keeps algorithm, page buffer, and stack inside the target SRAM', () => {
    const loaderRegion = STM32F407VET6.ramRegions[STM32F407VET6.loaderRamIndex]!;
    const layout = planFlashRamLayout(STM32F407VET6, 0x123, 0x1000, 0x1000);
    expect(layout.algorithm.address % 4).toBe(0);
    expect(layout.pageBuffer.address % 4).toBe(0);
    expect(layout.stack.address + layout.stack.size).toBe(loaderRegion.address + loaderRegion.size);
    for (const region of [layout.algorithm, layout.pageBuffer, layout.stack]) {
      expect(region.address).toBeGreaterThanOrEqual(loaderRegion.address);
      expect(region.address + region.size).toBeLessThanOrEqual(loaderRegion.address + loaderRegion.size);
    }
    expect(() => planFlashRamLayout(STM32F407VET6, loaderRegion.size, 0x1000, 0x1000))
      .toThrow(/SRAM/);
  });

  it('runs only the intersecting erase sectors after every preflight succeeds', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-cmsis-flash-test-'));
    try {
      const elfPath = path.join(tempDir, 'image.elf');
      const algorithmPath = path.join(tempDir, 'algorithm.bin');
      fs.writeFileSync(elfPath, makeElf([{ address: 0x08003ffc, bytes: [1, 2, 3, 4, 5, 6, 7, 8] }]));
      const algorithm = Buffer.alloc(0x600, 0xBF);
      algorithm[0x500] = 0x00;
      algorithm[0x501] = 0xBE;
      fs.writeFileSync(algorithmPath, algorithm);
      const calls: Array<{ operation: string; address: number; size: number; stackSize: number; staticBase: number; reusePageBuffer: boolean; flashStatusAddress?: number; flashControlAddress?: number; ramBase?: number; ramSize?: number }> = [];
      const transport = {
        async readDp(reg: number) {
          return reg === 0
            ? { ok: true, value: STM32F407VET6.dpIdcode }
            : { ok: false, errorCode: 'DapInvalidRequest', message: 'bad register' };
        },
        async readMemory(address: number, size: number) {
          if (address === 0xE0042000) return { ok: true, bytes: [0x13, 0x64, 0x00, 0x10].slice(0, size) };
          if (address === 0x1FFF7A22) return { ok: true, bytes: [0x00, 0x02].slice(0, size) };
          return { ok: false, errorCode: 'DapInvalidRequest', message: 'unexpected read' };
        },
        async runAlgorithm(request: { operation: string; targetAddress: number; size: number; stackSize: number; staticBase: number; reusePageBuffer: boolean; flashStatusAddress?: number; flashControlAddress?: number; ramBase?: number; ramSize?: number }) {
          calls.push({ operation: request.operation, address: request.targetAddress, size: request.size, stackSize: request.stackSize, staticBase: request.staticBase, reusePageBuffer: request.reusePageBuffer, flashStatusAddress: request.flashStatusAddress, flashControlAddress: request.flashControlAddress, ramBase: request.ramBase, ramSize: request.ramSize });
          return { ok: true, message: 'algorithm complete', data: { returnCode: 0, pc: 0x20000502, dhcsr: 0x00030003 } };
        },
      };
      const result = await flashCmsisDapElf(transport, elfPath, 'STM32F407VET6', {
        algorithmPath,
        pageSize: 4,
      }, STM32F407VET6);
      expect(result.success).toBe(true);
      expect(calls.map(call => call.operation)).toEqual([
        'init', 'eraseSector', 'eraseSector', 'programPage', 'programPage', 'verify', 'verify', 'uninit',
      ]);
      expect(calls.filter(call => call.operation === 'eraseSector').map(call => call.address)).toEqual([
        0x08000000, 0x08004000,
      ]);
      expect(calls.filter(call => call.operation === 'verify').map(call => call.size)).toEqual([4, 4]);
      expect(calls.every(call => call.stackSize === 0x1000 && call.staticBase === 0)).toBe(true);
      expect(calls.every(call => call.reusePageBuffer === false)).toBe(true);
      expect(calls.every(call => call.flashStatusAddress === 0x40023C0C
        && call.flashControlAddress === 0x40023C10)).toBe(true);
      expect(calls.every(call => call.ramBase === 0x20000000 && call.ramSize === 128 * 1024)).toBe(true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('verifies each programmed page from the preserved built-in-compatible page buffer', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-cmsis-page-buffer-flow-'));
    try {
      const elfPath = path.join(tempDir, 'image.elf');
      const binaryPath = path.join(tempDir, 'algorithm.bin');
      const manifestPath = path.join(tempDir, 'algorithm.json');
      fs.writeFileSync(elfPath, makeElf([{ address: 0x08000000, bytes: [1, 2, 3, 4, 5, 6, 7, 8] }]));
      const algorithm = Buffer.alloc(0x600, 0xBF);
      algorithm[0x500] = 0x00;
      algorithm[0x501] = 0xBE;
      fs.writeFileSync(binaryPath, algorithm);
      fs.writeFileSync(manifestPath, JSON.stringify({
        binary: 'algorithm.bin',
        pageSize: 4,
        preservesPageBuffer: true,
        entries: { init: 0, uninit: 0x100, eraseSector: 0x200, programPage: 0x300, verify: 0x400, bkpt: 0x500 },
      }));
      const calls: Array<{ operation: string; address: number; size: number; reusePageBuffer?: boolean }> = [];
      const transport = {
        async readDp() { return { ok: true, value: STM32F407VET6.dpIdcode }; },
        async readMemory(address: number, size: number) {
          if (address === 0xE0042000) return { ok: true, bytes: [0x13, 0x64, 0x00, 0x10].slice(0, size) };
          if (address === 0x1FFF7A22) return { ok: true, bytes: [0x00, 0x02].slice(0, size) };
          return { ok: false, errorCode: 'DapInvalidRequest', message: 'unexpected read' };
        },
        async runAlgorithm(request: { operation: string; targetAddress: number; size: number; reusePageBuffer?: boolean }) {
          calls.push({
            operation: request.operation,
            address: request.targetAddress,
            size: request.size,
            reusePageBuffer: request.reusePageBuffer,
          });
          return { ok: true, message: 'algorithm complete', data: { returnCode: 0, pc: 0x20000500, dhcsr: 0x00030003 } };
        },
      };

      const result = await flashCmsisDapElf(transport, elfPath, 'STM32F407VET6', { algorithmPath: manifestPath }, STM32F407VET6);

      expect(result.success).toBe(true);
      expect(calls.filter(call => call.operation === 'programPage' || call.operation === 'verify')).toEqual([
        { operation: 'programPage', address: 0x08000000, size: 4, reusePageBuffer: false },
        { operation: 'verify', address: 0x08000000, size: 4, reusePageBuffer: true },
        { operation: 'programPage', address: 0x08000004, size: 4, reusePageBuffer: false },
        { operation: 'verify', address: 0x08000004, size: 4, reusePageBuffer: true },
      ]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('skips verification entirely when verify is false', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-cmsis-no-verify-'));
    try {
      const elfPath = path.join(tempDir, 'image.elf');
      const binaryPath = path.join(tempDir, 'algorithm.bin');
      const manifestPath = path.join(tempDir, 'algorithm.json');
      fs.writeFileSync(elfPath, makeElf([{ address: 0x08000000, bytes: [1, 2, 3, 4, 5, 6, 7, 8] }]));
      const algorithm = Buffer.alloc(0x600, 0xBF);
      algorithm[0x500] = 0x00;
      algorithm[0x501] = 0xBE;
      fs.writeFileSync(binaryPath, algorithm);
      fs.writeFileSync(manifestPath, JSON.stringify({
        binary: 'algorithm.bin',
        pageSize: 4,
        preservesPageBuffer: true,
        entries: { init: 0, uninit: 0x100, eraseSector: 0x200, programPage: 0x300, verify: 0x400, bkpt: 0x500 },
      }));
      const calls: Array<{ operation: string }> = [];
      const transport = {
        async readDp() { return { ok: true, value: STM32F407VET6.dpIdcode }; },
        async readMemory(address: number, size: number) {
          if (address === 0xE0042000) return { ok: true, bytes: [0x13, 0x64, 0x00, 0x10].slice(0, size) };
          if (address === 0x1FFF7A22) return { ok: true, bytes: [0x00, 0x02].slice(0, size) };
          return { ok: false, errorCode: 'DapInvalidRequest', message: 'unexpected read' };
        },
        async runAlgorithm(request: { operation: string; targetAddress: number; size: number }) {
          calls.push({ operation: request.operation });
          return { ok: true, message: 'algorithm complete', data: { returnCode: 0, pc: 0x20000500, dhcsr: 0x00030003 } };
        },
      };

      const result = await flashCmsisDapElf(transport, elfPath, 'STM32F407VET6', {
        algorithmPath: manifestPath,
        verify: false,
      }, STM32F407VET6);

      expect(result.success).toBe(true);
      expect(calls.some(call => call.operation === 'verify')).toBe(false);
      expect(result.reports.some(report => report.operation === 'verify')).toBe(false);
      expect(calls.map(call => call.operation)).toContain('programPage');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('programs initialized SRAM data at its Flash LMA and ignores RAM-only segments', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-cmsis-flash-lma-'));
    try {
      const elfPath = path.join(tempDir, 'image.elf');
      const algorithmPath = path.join(tempDir, 'algorithm.bin');
      fs.writeFileSync(elfPath, makeElf([
        { address: 0x08000000, bytes: [1, 2, 3, 4] },
        { address: 0x20000000, loadAddress: 0x08000004, bytes: [5, 6], memorySize: 0x10 },
        { address: 0x20000010, loadAddress: 0x08000006, bytes: [], memorySize: 0x100 },
      ]));
      const algorithm = Buffer.alloc(0x600, 0xBF);
      algorithm[0x500] = 0x00;
      algorithm[0x501] = 0xBE;
      fs.writeFileSync(algorithmPath, algorithm);
      const calls: Array<{ operation: string; address: number; size: number }> = [];
      const transport = {
        async readDp() { return { ok: true, value: STM32F407VET6.dpIdcode }; },
        async readMemory(address: number, size: number) {
          if (address === 0xE0042000) return { ok: true, bytes: [0x13, 0x64, 0x00, 0x10].slice(0, size) };
          if (address === 0x1FFF7A22) return { ok: true, bytes: [0x00, 0x02].slice(0, size) };
          return { ok: false, errorCode: 'DapInvalidRequest', message: 'unexpected read' };
        },
        async runAlgorithm(request: { operation: string; targetAddress: number; size: number }) {
          calls.push({ operation: request.operation, address: request.targetAddress, size: request.size });
          return { ok: true, message: 'algorithm complete', data: { returnCode: 0, pc: 0x20000500, dhcsr: 0x00030003 } };
        },
      };
      const result = await flashCmsisDapElf(transport, elfPath, 'STM32F407VET6', {
        algorithmPath,
        pageSize: 4,
      }, STM32F407VET6);
      expect(result.success).toBe(true);
      expect(calls.filter(call => call.operation === 'eraseSector').map(call => call.address)).toEqual([0x08000000]);
      expect(calls.filter(call => call.operation === 'programPage').map(call => [call.address, call.size])).toEqual([
        [0x08000000, 4],
        [0x08000004, 2],
      ]);
      expect(calls.filter(call => call.operation === 'verify').map(call => [call.address, call.size])).toEqual([
        [0x08000000, 4],
        [0x08000004, 2],
      ]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('uses complete read-back verification when a user manifest has no Verify entry', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-cmsis-flash-readback-'));
    try {
      const elfPath = path.join(tempDir, 'image.elf');
      const algorithmPath = path.join(tempDir, 'algorithm.bin');
      const manifestPath = path.join(tempDir, 'algorithm.json');
      fs.writeFileSync(elfPath, makeElf([{ address: 0x08000000, bytes: [1, 2, 3, 4] }]));
      const algorithm = Buffer.alloc(0x600, 0xBF);
      algorithm[0x500] = 0x00;
      algorithm[0x501] = 0xBE;
      fs.writeFileSync(algorithmPath, algorithm);
      fs.writeFileSync(manifestPath, JSON.stringify({
        binary: 'algorithm.bin',
        pageSize: 4,
        entries: { init: 0, uninit: 0x100, eraseSector: 0x200, programPage: 0x300, bkpt: 0x500 },
      }));
      const calls: string[] = [];
      const transport = {
        async readDp() { return { ok: true, value: STM32F407VET6.dpIdcode }; },
        async readMemory(address: number, size: number) {
          if (address === 0xE0042000) return { ok: true, bytes: [0x13, 0x64, 0x00, 0x10].slice(0, size) };
          if (address === 0x1FFF7A22) return { ok: true, bytes: [0x00, 0x02].slice(0, size) };
          if (address === 0x08000000) return { ok: true, bytes: [1, 2, 3, 4].slice(0, size) };
          return { ok: false, errorCode: 'DapInvalidRequest', message: 'unexpected read' };
        },
        async runAlgorithm(request: { operation: string }) {
          calls.push(request.operation);
          if (request.operation === 'verify') throw new Error('manifest without Verify must use read-back');
          return { ok: true, message: 'algorithm complete', data: { returnCode: 0, pc: 0x20000500, dhcsr: 0x00030003 } };
        },
      };
      const result = await flashCmsisDapElf(transport, elfPath, 'STM32F407VET6', { algorithmPath: manifestPath }, STM32F407VET6);
      expect(result.success).toBe(true);
      expect(calls).toEqual(['init', 'eraseSector', 'programPage', 'uninit']);
      expect(result.reports.find(report => report.operation === 'verify')).toMatchObject({
        ok: true,
        message: 'complete Flash read-back comparison passed',
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does not erase when target identity or capacity preflight fails', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-cmsis-flash-preflight-'));
    try {
      const elfPath = path.join(tempDir, 'image.elf');
      const algorithmPath = path.join(tempDir, 'algorithm.bin');
      fs.writeFileSync(elfPath, makeElf([{ address: 0x08000000, bytes: [1, 2, 3, 4] }]));
      const algorithm = Buffer.alloc(0x600, 0xBF);
      algorithm[0x500] = 0x00;
      algorithm[0x501] = 0xBE;
      fs.writeFileSync(algorithmPath, algorithm);
      let eraseCalls = 0;
      const result = await flashCmsisDapElf({
        async readDp() { return { ok: true, value: STM32F407VET6.dpIdcode }; },
        async readMemory(address: number) {
          if (address === 0xE0042000) return { ok: true, bytes: [0x12, 0x64, 0x00, 0x10] };
          return { ok: true, bytes: [0x00, 0x02] };
        },
        async runAlgorithm(request: { operation: string }) {
          if (request.operation === 'eraseSector') eraseCalls += 1;
          return { ok: true, message: 'unexpected', data: { returnCode: 0, pc: 0x20000500, dhcsr: 0x00030003 } };
        },
      }, elfPath, 'STM32F407VET6', { algorithmPath }, STM32F407VET6);
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('TargetMismatch');
      expect(eraseCalls).toBe(0);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does not retry a ProgramPage whose completion state is unknown', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-cmsis-flash-unknown-'));
    try {
      const elfPath = path.join(tempDir, 'image.elf');
      const algorithmPath = path.join(tempDir, 'algorithm.bin');
      fs.writeFileSync(elfPath, makeElf([{ address: 0x08000000, bytes: [1, 2, 3, 4] }]));
      const algorithm = Buffer.alloc(0x600, 0xBF);
      algorithm[0x500] = 0x00;
      algorithm[0x501] = 0xBE;
      fs.writeFileSync(algorithmPath, algorithm);
      let programCalls = 0;
      const operations: string[] = [];
      const result = await flashCmsisDapElf({
        async readDp() { return { ok: true, value: STM32F407VET6.dpIdcode }; },
        async readMemory(address: number) {
          if (address === 0xE0042000) return { ok: true, bytes: [0x13, 0x64, 0x00, 0x10] };
          return { ok: true, bytes: [0x00, 0x02] };
        },
        async runAlgorithm(request: { operation: string }) {
          operations.push(request.operation);
          if (request.operation === 'programPage') {
            programCalls += 1;
            return { ok: false, errorCode: 'OutcomeUnknown', message: 'write outcome is unknown' };
          }
          return { ok: true, message: 'algorithm complete', data: { returnCode: 0, pc: 0x20000500, dhcsr: 0x00030003 } };
        },
      }, elfPath, 'STM32F407VET6', { algorithmPath }, STM32F407VET6);
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('OutcomeUnknown');
      expect(programCalls).toBe(1);
      expect(operations).toEqual(['init', 'eraseSector', 'programPage']);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does not call UnInit when the helper request rejects with unknown completion', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-cmsis-flash-rejected-'));
    try {
      const elfPath = path.join(tempDir, 'image.elf');
      const algorithmPath = path.join(tempDir, 'algorithm.bin');
      fs.writeFileSync(elfPath, makeElf([{ address: 0x08000000, bytes: [1, 2, 3, 4] }]));
      const algorithm = Buffer.alloc(0x600, 0xBF);
      algorithm[0x500] = 0x00;
      algorithm[0x501] = 0xBE;
      fs.writeFileSync(algorithmPath, algorithm);
      const operations: string[] = [];
      const result = await flashCmsisDapElf({
        async readDp() { return { ok: true, value: STM32F407VET6.dpIdcode }; },
        async readMemory(address: number) {
          if (address === 0xE0042000) return { ok: true, bytes: [0x13, 0x64, 0x00, 0x10] };
          return { ok: true, bytes: [0x00, 0x02] };
        },
        async runAlgorithm(request: { operation: string }) {
          operations.push(request.operation);
          if (request.operation === 'init') throw new Error('helper request timed out');
          return { ok: true, message: 'unexpected', data: { returnCode: 0, pc: 0x20000500, dhcsr: 0x00030003 } };
        },
      }, elfPath, 'STM32F407VET6', { algorithmPath }, STM32F407VET6);
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('OutcomeUnknown');
      expect(result.message).toContain('init');
      expect(operations).toEqual(['init']);
      expect(result.reports).toEqual([expect.objectContaining({
        operation: 'init',
        ok: false,
        errorCode: 'OutcomeUnknown',
      })]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('surfaces algorithm return code and Flash controller diagnostics', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-cmsis-flash-error-diagnostics-'));
    try {
      const elfPath = path.join(tempDir, 'image.elf');
      const algorithmPath = path.join(tempDir, 'algorithm.bin');
      fs.writeFileSync(elfPath, makeElf([{ address: 0x08000000, bytes: [1, 2, 3, 4] }]));
      const algorithm = Buffer.alloc(0x600, 0xBF);
      algorithm[0x500] = 0x00;
      algorithm[0x501] = 0xBE;
      fs.writeFileSync(algorithmPath, algorithm);
      const operations: string[] = [];
      const result = await flashCmsisDapElf({
        async readDp() { return { ok: true, value: STM32F407VET6.dpIdcode }; },
        async readMemory(address: number) {
          if (address === 0xE0042000) return { ok: true, bytes: [0x13, 0x64, 0x00, 0x10] };
          return { ok: true, bytes: [0x00, 0x02] };
        },
        async runAlgorithm(request: { operation: string }) {
          operations.push(request.operation);
          if (request.operation === 'init') {
            return {
              ok: false,
              errorCode: 'DapAlgorithmTimeout',
              message: 'Flash Algorithm init returned error code 1 (FLASH_SR=0x10000 FLASH_CR=0x80000000)',
              data: {
                returnCode: 1,
                pc: 0x20000502,
                dhcsr: 0x00030001,
                flashStatus: 0x10000,
                flashControl: 0x80000000,
              },
              diagnostics: { algorithmOperation: 'init' },
            };
          }
          return { ok: true, message: 'unexpected', data: { returnCode: 0, pc: 0x20000500, dhcsr: 0x00030003 } };
        },
      }, elfPath, 'STM32F407VET6', { algorithmPath }, STM32F407VET6);
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('AlgorithmTimeout');
      expect(result.message).toContain('returnCode=1');
      expect(result.message).toContain('FLASH_SR=0x10000');
      expect(result.diagnostics?.operation).toBe('init');
      expect(operations).toEqual(['init', 'uninit']);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('fails the Flash flow when UnInit reports an error', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-cmsis-flash-uninit-'));
    try {
      const elfPath = path.join(tempDir, 'image.elf');
      const algorithmPath = path.join(tempDir, 'algorithm.bin');
      fs.writeFileSync(elfPath, makeElf([{ address: 0x08000000, bytes: [1, 2, 3, 4] }]));
      const algorithm = Buffer.alloc(0x600, 0xBF);
      algorithm[0x500] = 0x00;
      algorithm[0x501] = 0xBE;
      fs.writeFileSync(algorithmPath, algorithm);
      const operations: string[] = [];
      const result = await flashCmsisDapElf({
        async readDp() { return { ok: true, value: STM32F407VET6.dpIdcode }; },
        async readMemory(address: number) {
          if (address === 0xE0042000) return { ok: true, bytes: [0x13, 0x64, 0x00, 0x10] };
          return { ok: true, bytes: [0x00, 0x02] };
        },
        async runAlgorithm(request: { operation: string }) {
          operations.push(request.operation);
          if (request.operation === 'uninit') {
            return { ok: false, errorCode: 'DapControlTimeout', message: 'UnInit did not return' };
          }
          return { ok: true, message: 'algorithm complete', data: { returnCode: 0, pc: 0x20000500, dhcsr: 0x00030003 } };
        },
      }, elfPath, 'STM32F407VET6', { algorithmPath }, STM32F407VET6);
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('AlgorithmTimeout');
      expect(result.message).toContain('UnInit did not return');
      expect(operations.at(-1)).toBe('uninit');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('preserves helper diagnostics when an algorithm returns a non-zero code', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-cmsis-flash-helper-diagnostics-'));
    try {
      const elfPath = path.join(tempDir, 'image.elf');
      const algorithmPath = path.join(tempDir, 'algorithm.bin');
      fs.writeFileSync(elfPath, makeElf([{ address: 0x08000000, bytes: [1, 2, 3, 4] }]));
      const algorithm = Buffer.alloc(0x600, 0xBF);
      algorithm[0x500] = 0x00;
      algorithm[0x501] = 0xBE;
      fs.writeFileSync(algorithmPath, algorithm);
      const result = await flashCmsisDapElf({
        async readDp() { return { ok: true, value: STM32F407VET6.dpIdcode }; },
        async readMemory(address: number) {
          if (address === 0xE0042000) return { ok: true, bytes: [0x13, 0x64, 0x00, 0x10] };
          return { ok: true, bytes: [0x00, 0x02] };
        },
        async runAlgorithm(request: { operation: string }) {
          if (request.operation === 'init') {
            return {
              ok: true,
              message: 'Flash Algorithm init returned error code 1 (FLASH_SR=0x10000 FLASH_CR=0x80000000)',
              data: {
                operation: 'init' as const,
                address: 0x08000000,
                size: 0,
                returnCode: 1,
                pc: 0x20000502,
                dhcsr: 0x00030001,
                flashStatus: 0x10000,
                flashControl: 0x80000000,
              },
            };
          }
          return { ok: true, message: 'unexpected', data: { returnCode: 0, pc: 0x20000500, dhcsr: 0x00030003 } };
        },
      }, elfPath, 'STM32F407VET6', { algorithmPath }, STM32F407VET6);
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('AlgorithmTimeout');
      expect(result.message).toContain('Flash Algorithm init returned error code 1');
      expect(result.message).toContain('FLASH_SR=0x10000');
      expect(result.message).toContain('returnCode=1');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

// H723 registry entry proving the flash model is device-agnostic. Register
// facts were verified against ST cmsis-device-h7/stm32h723xx.h and the H7 HAL
// flash driver; DPIDR and timing defaults stay provisional until P7 hardware
// acceptance.

describe('CMSIS-DAP flash target registry', () => {
  it('resolves registered names and aliases from normalized device input', () => {
    expect(resolveFlashTarget('STM32F407VET6')).toBe(STM32F407VET6);
    expect(resolveFlashTarget(' stm32f407vet6 ')).toBe(STM32F407VET6);
    expect(resolveFlashTarget('stm32f407ve')).toBe(STM32F407VET6);
    expect(resolveFlashTarget('STM32F407VE')).toBe(STM32F407VET6);
    expect(resolveFlashTarget('STM32H723VGT6')).toBe(STM32H723VGT6);
    expect(resolveFlashTarget(' stm32h723vgt6 ')).toBe(STM32H723VGT6);
    expect(resolveFlashTarget('stm32h723vg')).toBe(STM32H723VGT6);
    const targets = listFlashTargets();
    expect(targets).toContain(STM32F407VET6);
    expect(targets).toContain(STM32H723VGT6);
  });

  it('rejects an unregistered device with a structured TargetMismatch', () => {
    try {
      resolveFlashTarget('STM32F429VGT6');
      expect.unreachable('resolveFlashTarget must throw for an unregistered device');
    } catch (error) {
      const mismatch = error as CmsisDapFlashError;
      expect(mismatch).toBeInstanceOf(CmsisDapFlashError);
      expect(mismatch.code).toBe('TargetMismatch');
      expect(mismatch.message).toContain('STM32F429VGT6');
      expect(mismatch.message).toContain('STM32F407VET6');
      expect(mismatch.diagnostics).toMatchObject({
        device: 'STM32F429VGT6',
        supportedTargets: ['STM32F407VET6', 'STM32H723VGT6'],
      });
    }
  });

  it('keeps every registered target structurally valid', () => {
    expect(listFlashTargets().length).toBeGreaterThan(0);
    for (const target of listFlashTargets()) {
      expect(() => validateFlashTargetDefinition(target)).not.toThrow();
    }
  });

  it('rejects structurally invalid target definitions', () => {
    const variant = (patch: Partial<FlashTargetDefinition>): FlashTargetDefinition =>
      ({ ...STM32F407VET6, ...patch });
    expect(() => validateFlashTargetDefinition(variant({
      sectors: STM32F407VET6.sectors.slice(0, 7),
    }))).toThrow(/cover its Flash size/);
    expect(() => validateFlashTargetDefinition(variant({
      ramRegions: [
        { name: 'SRAM', address: 0x20000000, size: 128 * 1024 },
        { name: 'SRAM2', address: 0x20010000, size: 64 * 1024 },
      ],
    }))).toThrow(/overlap/);
    expect(() => validateFlashTargetDefinition(variant({ loaderRamIndex: 4 }))).toThrow(/loaderRamIndex/);
    expect(() => validateFlashTargetDefinition(variant({
      preflight: { ...STM32F407VET6.preflight, expectedFlashSizeKiB: 256 },
    }))).toThrow(/capacity/);
    expect(() => validateFlashTargetDefinition(variant({
      flashDiagnostics: { statusAddress: 0x40023C0C, controlAddress: 0x40023C14 },
    }))).toThrow(/adjacent aligned words/);
    expect(() => validateFlashTargetDefinition(variant({
      flashDiagnostics: { statusAddress: 0x40023C0E, controlAddress: 0x40023C12 },
    }))).toThrow(/adjacent aligned words/);
    expect(() => validateFlashTargetDefinition(variant({ eraseTimeoutMs: 60_001 })))
      .toThrow(/timeouts must be in 1\.\.60000/);
    expect(() => validateFlashTargetDefinition(variant({ programTimeoutMs: 0 })))
      .toThrow(/timeouts must be in 1\.\.60000/);
    expect(() => validateFlashTargetDefinition(variant({ flashWordSize: 24 })))
      .toThrow(/flashWordSize must be a power of two/);
  });
});

describe('built-in flash algorithm metadata', () => {
  it('registers the F407 algorithm with its page contract', () => {
    const algorithms = listBuiltinFlashAlgorithms();
    expect([...algorithms.keys()]).toContain('stm32f407');
    const f407 = algorithms.get('stm32f407')!;
    expect(f407.fileName).toBe('orbit-stm32f407-flash-algorithm.bin');
    expect(f407.pageSize).toBe(0x4000);
    expect(f407.preservesPageBuffer).toBe(true);
    expect(f407.staticBase).toBe(0);
    expect(f407.entries).toEqual({
      init: 0x000,
      uninit: 0x100,
      eraseSector: 0x200,
      programPage: 0x300,
      verify: 0x400,
      bkpt: 0x500,
    });
    expect(STM32F407VET6.algorithm).toBe('stm32f407');
  });

  it('registers the H723 algorithm with its page contract', () => {
    const algorithms = listBuiltinFlashAlgorithms();
    expect([...algorithms.keys()]).toContain('stm32h723');
    const h723 = algorithms.get('stm32h723')!;
    expect(h723.fileName).toBe('orbit-stm32h723-flash-algorithm.bin');
    expect(h723.pageSize).toBe(0x10000);
    expect(h723.preservesPageBuffer).toBe(true);
    expect(h723.staticBase).toBe(0);
    expect(h723.entries).toEqual({
      init: 0x000,
      uninit: 0x100,
      eraseSector: 0x200,
      programPage: 0x300,
      verify: 0x400,
      bkpt: 0x500,
    });
    expect(STM32H723VGT6.algorithm).toBe('stm32h723');
  });

  it('rejects a target whose built-in algorithm name is not registered', () => {
    const target: FlashTargetDefinition = { ...STM32H723VGT6, algorithm: 'stm32f429' };
    expect(() => loadFlashAlgorithm(target))
      .toThrow(/unknown built-in Flash Algorithm 'stm32f429'/);
  });

  it('resolves a user algorithm path stored in the target algorithm field', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-cmsis-target-algorithm-path-'));
    try {
      const binaryPath = path.join(tempDir, 'algorithm.bin');
      const manifestPath = path.join(tempDir, 'algorithm.json');
      const algorithm = Buffer.alloc(0x600, 0xBF);
      algorithm[0x500] = 0x00;
      algorithm[0x501] = 0xBE;
      fs.writeFileSync(binaryPath, algorithm);
      fs.writeFileSync(manifestPath, JSON.stringify({
        binary: 'algorithm.bin',
        pageSize: 4,
        entries: { init: 0, uninit: 0x100, eraseSector: 0x200, programPage: 0x300, verify: 0x400, bkpt: 0x500 },
      }));
      const target: FlashTargetDefinition = { ...STM32H723VGT6, algorithm: manifestPath };
      const image = loadFlashAlgorithm(target);
      expect(image.source).toBe('user-provided');
      expect(image.pageSize).toBe(4);
      expect(image.path).toBe(binaryPath);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('multi-target flash model (H723-shaped)', () => {
  it('validates structurally and computes 8 x 128 KiB erase sectors', () => {
    expect(() => validateFlashTargetDefinition(STM32H723VGT6)).not.toThrow();
    const boundary = parseElf32LoadSegments(makeElf([
      { address: 0x0801FFFC, bytes: [1, 2, 3, 4, 5, 6, 7, 8] },
    ]));
    expect(calculateEraseSectors(boundary, STM32H723VGT6).map(sector => sector.number))
      .toEqual([0, 1]);
    const lastSector = parseElf32LoadSegments(makeElf([
      { address: 0x080E0000, bytes: [1] },
    ]));
    const sectors = calculateEraseSectors(lastSector, STM32H723VGT6);
    expect(sectors.map(sector => sector.number)).toEqual([7]);
    expect(sectors[0]!.address + sectors[0]!.size).toBe(0x08100000);
  });

  it('accepts segments in any RAM region and rejects cross-region segments', () => {
    const spread = parseElf32LoadSegments(makeElf([
      { address: 0x20000000, bytes: [1], memorySize: 16 },
      { address: 0x24000000, bytes: [2], memorySize: 16 },
      { address: 0x30000000, bytes: [3], memorySize: 16 },
      { address: 0x38000000, bytes: [4], memorySize: 16 },
    ]));
    expect(calculateEraseSectors(spread, STM32H723VGT6)).toEqual([]);
    const straddling = parseElf32LoadSegments(makeElf([
      { address: 0x20000000, bytes: [1, 2, 3, 4], memorySize: 128 * 1024 + 4 },
    ]));
    expect(() => calculateEraseSectors(straddling, STM32H723VGT6))
      .toThrow(/outside STM32H723VGT6 Flash and RAM regions/);
  });

  it('merges adjacent Flash PT_LOAD ranges that share a 32-byte ECC word', () => {
    const segments = parseElf32LoadSegments(makeElf([
      { address: 0x08000000, bytes: Array.from({ length: 0x1d98 }, (_, index) => index & 0xFF) },
      { address: 0x20000000, loadAddress: 0x08001d98, bytes: [0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF, 0x00] },
    ]));
    const ranges = coalesceFlashProgramRanges(segments, STM32H723VGT6);
    expect(ranges).toHaveLength(1);
    expect(ranges[0]!.address).toBe(0x08000000);
    expect(ranges[0]!.bytes.length).toBe(0x1da8);
    expect(Array.from(ranges[0]!.bytes.slice(0x1d98, 0x1da8)))
      .toEqual([0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF, 0x00]);
    expect(STM32H723VGT6.flashWordSize).toBe(32);
    expect(STM32F407VET6.flashWordSize).toBeUndefined();
    const f4 = coalesceFlashProgramRanges(segments, STM32F407VET6);
    expect(f4.map(range => [range.address, range.bytes.length])).toEqual([
      [0x08000000, 0x1d98],
      [0x08001d98, 16],
    ]);
  });

  it('programs a CubeMX-style .text/.data LMA split as one H723 page', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-cmsis-h723-ecc-merge-'));
    try {
      const elfPath = path.join(tempDir, 'image.elf');
      const manifestPath = path.join(tempDir, 'algorithm.json');
      fs.writeFileSync(elfPath, makeElf([
        { address: 0x08000000, bytes: Array.from({ length: 0x1d98 }, () => 0xAA) },
        { address: 0x20000000, loadAddress: 0x08001d98, bytes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16] },
      ]));
      const algorithm = Buffer.alloc(0x600, 0xBF);
      algorithm[0x500] = 0x00;
      algorithm[0x501] = 0xBE;
      fs.writeFileSync(path.join(tempDir, 'algorithm.bin'), algorithm);
      fs.writeFileSync(manifestPath, JSON.stringify({
        binary: 'algorithm.bin',
        pageSize: 0x10000,
        preservesPageBuffer: true,
        entries: { init: 0, uninit: 0x100, eraseSector: 0x200, programPage: 0x300, verify: 0x400, bkpt: 0x500 },
      }));
      const calls: Array<{ operation: string; address: number; size: number }> = [];
      const result = await flashCmsisDapElf({
        async readDp() { return { ok: true, value: STM32H723VGT6.dpIdcode }; },
        async readMemory(address: number, size: number) {
          if (address === 0x5C001000) return { ok: true, bytes: [0x83, 0x04, 0x00, 0x10].slice(0, size) };
          if (address === 0x1FF1E880) return { ok: true, bytes: [0x00, 0x04].slice(0, size) };
          return { ok: false, errorCode: 'DapInvalidRequest', message: 'unexpected read' };
        },
        async runAlgorithm(request: { operation: string; targetAddress: number; size: number; bkptAddress: number }) {
          calls.push({ operation: request.operation, address: request.targetAddress, size: request.size });
          return { ok: true, message: 'algorithm complete', data: { returnCode: 0, pc: request.bkptAddress, dhcsr: 0x00030003 } };
        },
      }, elfPath, 'STM32H723VGT6', { algorithmPath: manifestPath }, STM32H723VGT6);
      expect(result.success).toBe(true);
      expect(calls.filter(call => call.operation === 'programPage')).toEqual([
        { operation: 'programPage', address: 0x08000000, size: 0x1da8 },
      ]);
      expect(calls.filter(call => call.operation === 'verify')).toEqual([
        { operation: 'verify', address: 0x08000000, size: 0x1da8 },
      ]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('places the loader in the AXI SRAM region selected by loaderRamIndex', () => {
    const layout = planFlashRamLayout(STM32H723VGT6, 0x123, 0x800, 0x1000);
    const axiBase = 0x24000000;
    const axiEnd = axiBase + 320 * 1024;
    expect(layout.algorithm.address).toBe(axiBase);
    expect(layout.stack.address + layout.stack.size).toBe(axiEnd);
    for (const region of [layout.algorithm, layout.pageBuffer, layout.stack]) {
      expect(region.address).toBeGreaterThanOrEqual(axiBase);
      expect(region.address + region.size).toBeLessThanOrEqual(axiEnd);
    }
    expect(() => planFlashRamLayout(STM32H723VGT6, 320 * 1024, 0x800, 0x1000))
      .toThrow(/STM32H723VGT6 AXI SRAM/);
  });

  it('reads H7 identity registers and applies per-target operation timeouts', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-cmsis-h723-flash-'));
    try {
      const elfPath = path.join(tempDir, 'image.elf');
      const binaryPath = path.join(tempDir, 'algorithm.bin');
      const manifestPath = path.join(tempDir, 'algorithm.json');
      fs.writeFileSync(elfPath, makeElf([{ address: 0x08000000, bytes: [1, 2, 3, 4] }]));
      const algorithm = Buffer.alloc(0x600, 0xBF);
      algorithm[0x500] = 0x00;
      algorithm[0x501] = 0xBE;
      fs.writeFileSync(binaryPath, algorithm);
      fs.writeFileSync(manifestPath, JSON.stringify({
        binary: 'algorithm.bin',
        pageSize: 4,
        entries: { init: 0, uninit: 0x100, eraseSector: 0x200, programPage: 0x300, verify: 0x400, bkpt: 0x500 },
      }));
      const calls: Array<{ operation: string; timeoutMs: number; algorithmAddress: number; stackPointer: number; flashStatusAddress?: number; flashControlAddress?: number; ramBase?: number; ramSize?: number }> = [];
      const readAddresses: number[] = [];
      const transport = {
        async readDp() { return { ok: true, value: STM32H723VGT6.dpIdcode }; },
        async readMemory(address: number, size: number) {
          readAddresses.push(address);
          if (address === 0x5C001000) return { ok: true, bytes: [0x83, 0x04, 0x00, 0x10].slice(0, size) };
          if (address === 0x1FF1E880) return { ok: true, bytes: [0x00, 0x04].slice(0, size) };
          return { ok: false, errorCode: 'DapInvalidRequest', message: `unexpected read at 0x${address.toString(16)}` };
        },
        async runAlgorithm(request: { operation: string; timeoutMs: number; algorithmAddress: number; stackPointer: number; bkptAddress: number; flashStatusAddress?: number; flashControlAddress?: number; ramBase?: number; ramSize?: number }) {
          calls.push({
            operation: request.operation,
            timeoutMs: request.timeoutMs,
            algorithmAddress: request.algorithmAddress,
            stackPointer: request.stackPointer,
            flashStatusAddress: request.flashStatusAddress,
            flashControlAddress: request.flashControlAddress,
            ramBase: request.ramBase,
            ramSize: request.ramSize,
          });
          return { ok: true, message: 'algorithm complete', data: { returnCode: 0, pc: request.bkptAddress, dhcsr: 0x00030003 } };
        },
      };
      const result = await flashCmsisDapElf(transport, elfPath, 'STM32H723VGT6', {
        algorithmPath: manifestPath,
      }, STM32H723VGT6);
      expect(result.success).toBe(true);
      expect(readAddresses).toEqual(expect.arrayContaining([0x5C001000, 0x1FF1E880]));
      expect(readAddresses).not.toContain(0xE0042000);
      expect(readAddresses).not.toContain(0x1FFF7A22);
      const timeouts = Object.fromEntries(calls.map(call => [call.operation, call.timeoutMs]));
      expect(timeouts).toEqual({ init: 5000, eraseSector: 30000, programPage: 15000, verify: 15000, uninit: 5000 });
      expect(calls.every(call => call.algorithmAddress === 0x24000000)).toBe(true);
      expect(calls.every(call => call.stackPointer === 0x24050000)).toBe(true);
      expect(calls.every(call => call.flashStatusAddress === 0x52002010
        && call.flashControlAddress === 0x5200200C)).toBe(true);
      expect(calls.every(call => call.ramBase === 0x24000000 && call.ramSize === 320 * 1024)).toBe(true);
      expect(result.erasedSectors.map(sector => sector.number)).toEqual([0]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('honors an explicit timeoutMs override for every operation', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-cmsis-h723-timeout-override-'));
    try {
      const elfPath = path.join(tempDir, 'image.elf');
      const manifestPath = path.join(tempDir, 'algorithm.json');
      fs.writeFileSync(elfPath, makeElf([{ address: 0x08000000, bytes: [1, 2, 3, 4] }]));
      const algorithm = Buffer.alloc(0x600, 0xBF);
      algorithm[0x500] = 0x00;
      algorithm[0x501] = 0xBE;
      fs.writeFileSync(path.join(tempDir, 'algorithm.bin'), algorithm);
      fs.writeFileSync(manifestPath, JSON.stringify({
        binary: 'algorithm.bin',
        pageSize: 4,
        entries: { init: 0, uninit: 0x100, eraseSector: 0x200, programPage: 0x300, verify: 0x400, bkpt: 0x500 },
      }));
      const timeouts: number[] = [];
      const transport = {
        async readDp() { return { ok: true, value: STM32H723VGT6.dpIdcode }; },
        async readMemory(address: number, size: number) {
          if (address === 0x5C001000) return { ok: true, bytes: [0x83, 0x04, 0x00, 0x10].slice(0, size) };
          if (address === 0x1FF1E880) return { ok: true, bytes: [0x00, 0x04].slice(0, size) };
          return { ok: false, errorCode: 'DapInvalidRequest', message: 'unexpected read' };
        },
        async runAlgorithm(request: { operation: string; timeoutMs: number; bkptAddress: number }) {
          timeouts.push(request.timeoutMs);
          return { ok: true, message: 'algorithm complete', data: { returnCode: 0, pc: request.bkptAddress, dhcsr: 0x00030003 } };
        },
      };
      const result = await flashCmsisDapElf(transport, elfPath, 'STM32H723VGT6', {
        algorithmPath: manifestPath,
        timeoutMs: 1234,
      }, STM32H723VGT6);
      expect(result.success).toBe(true);
      expect(timeouts.length).toBeGreaterThan(0);
      expect(new Set(timeouts)).toEqual(new Set([1234]));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects an explicit timeoutMs above the helper flashAlgorithm ceiling', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-cmsis-h723-timeout-cap-'));
    try {
      const elfPath = path.join(tempDir, 'image.elf');
      const manifestPath = path.join(tempDir, 'algorithm.json');
      fs.writeFileSync(elfPath, makeElf([{ address: 0x08000000, bytes: [1, 2, 3, 4] }]));
      const algorithm = Buffer.alloc(0x600, 0xBF);
      algorithm[0x500] = 0x00;
      algorithm[0x501] = 0xBE;
      fs.writeFileSync(path.join(tempDir, 'algorithm.bin'), algorithm);
      fs.writeFileSync(manifestPath, JSON.stringify({
        binary: 'algorithm.bin',
        pageSize: 4,
        entries: { init: 0, uninit: 0x100, eraseSector: 0x200, programPage: 0x300, verify: 0x400, bkpt: 0x500 },
      }));
      let algorithmCalls = 0;
      const result = await flashCmsisDapElf({
        async readDp() { return { ok: true, value: STM32H723VGT6.dpIdcode }; },
        async readMemory(address: number, size: number) {
          if (address === 0x5C001000) return { ok: true, bytes: [0x83, 0x04, 0x00, 0x10].slice(0, size) };
          if (address === 0x1FF1E880) return { ok: true, bytes: [0x00, 0x04].slice(0, size) };
          return { ok: false, errorCode: 'DapInvalidRequest', message: 'unexpected read' };
        },
        async runAlgorithm() {
          algorithmCalls += 1;
          return { ok: true, message: 'unexpected', data: { returnCode: 0, pc: 0x24000500, dhcsr: 0x00030003 } };
        },
      }, elfPath, 'STM32H723VGT6', {
        algorithmPath: manifestPath,
        timeoutMs: 60_001,
      }, STM32H723VGT6);
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('InvalidConfiguration');
      expect(result.message).toContain('1..60000');
      expect(algorithmCalls).toBe(0);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('reports structured H7 preflight mismatches without erasing', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-cmsis-h723-preflight-'));
    try {
      const elfPath = path.join(tempDir, 'image.elf');
      const manifestPath = path.join(tempDir, 'algorithm.json');
      fs.writeFileSync(elfPath, makeElf([{ address: 0x08000000, bytes: [1, 2, 3, 4] }]));
      const algorithm = Buffer.alloc(0x600, 0xBF);
      algorithm[0x500] = 0x00;
      algorithm[0x501] = 0xBE;
      fs.writeFileSync(path.join(tempDir, 'algorithm.bin'), algorithm);
      fs.writeFileSync(manifestPath, JSON.stringify({
        binary: 'algorithm.bin',
        pageSize: 4,
        entries: { init: 0, uninit: 0x100, eraseSector: 0x200, programPage: 0x300, verify: 0x400, bkpt: 0x500 },
      }));
      let eraseCalls = 0;
      const transport = {
        async readDp() { return { ok: true, value: STM32H723VGT6.dpIdcode }; },
        async readMemory(address: number, size: number) {
          // An F4 DEV_ID on the H7 DBGMCU register must fail the preflight.
          if (address === 0x5C001000) return { ok: true, bytes: [0x13, 0x64, 0x00, 0x10].slice(0, size) };
          return { ok: true, bytes: [0x00, 0x04].slice(0, size) };
        },
        async runAlgorithm(request: { operation: string; bkptAddress: number }) {
          if (request.operation === 'eraseSector') eraseCalls += 1;
          return { ok: true, message: 'unexpected', data: { returnCode: 0, pc: request.bkptAddress, dhcsr: 0x00030003 } };
        },
      };
      const result = await flashCmsisDapElf(transport, elfPath, 'STM32H723VGT6', {
        algorithmPath: manifestPath,
      }, STM32H723VGT6);
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('TargetMismatch');
      expect(result.message).toContain('0x483');
      expect(result.diagnostics).toMatchObject({ expected: 0x483 });
      expect(eraseCalls).toBe(0);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('reports a structured H7 DPIDR mismatch without erasing', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-cmsis-h723-dpidr-'));
    try {
      const elfPath = path.join(tempDir, 'image.elf');
      const manifestPath = path.join(tempDir, 'algorithm.json');
      fs.writeFileSync(elfPath, makeElf([{ address: 0x08000000, bytes: [1, 2, 3, 4] }]));
      const algorithm = Buffer.alloc(0x600, 0xBF);
      algorithm[0x500] = 0x00;
      algorithm[0x501] = 0xBE;
      fs.writeFileSync(path.join(tempDir, 'algorithm.bin'), algorithm);
      fs.writeFileSync(manifestPath, JSON.stringify({
        binary: 'algorithm.bin',
        pageSize: 4,
        entries: { init: 0, uninit: 0x100, eraseSector: 0x200, programPage: 0x300, verify: 0x400, bkpt: 0x500 },
      }));
      let eraseCalls = 0;
      const result = await flashCmsisDapElf({
        async readDp() { return { ok: true, value: 0x2BA01477 }; },
        async readMemory() { return { ok: true, bytes: [0x83, 0x04, 0x00, 0x10] }; },
        async runAlgorithm(request: { operation: string; bkptAddress: number }) {
          if (request.operation === 'eraseSector') eraseCalls += 1;
          return { ok: true, message: 'unexpected', data: { returnCode: 0, pc: request.bkptAddress, dhcsr: 0x00030003 } };
        },
      }, elfPath, 'STM32H723VGT6', { algorithmPath: manifestPath }, STM32H723VGT6);
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('TargetMismatch');
      expect(result.message).toMatch(/SW-DP IDCODE mismatch/i);
      expect(result.diagnostics).toMatchObject({ expected: 0x6BA02477, actual: 0x2BA01477 });
      expect(eraseCalls).toBe(0);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('reports a structured H7 Flash capacity mismatch without erasing', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-cmsis-h723-capacity-'));
    try {
      const elfPath = path.join(tempDir, 'image.elf');
      const manifestPath = path.join(tempDir, 'algorithm.json');
      fs.writeFileSync(elfPath, makeElf([{ address: 0x08000000, bytes: [1, 2, 3, 4] }]));
      const algorithm = Buffer.alloc(0x600, 0xBF);
      algorithm[0x500] = 0x00;
      algorithm[0x501] = 0xBE;
      fs.writeFileSync(path.join(tempDir, 'algorithm.bin'), algorithm);
      fs.writeFileSync(manifestPath, JSON.stringify({
        binary: 'algorithm.bin',
        pageSize: 4,
        entries: { init: 0, uninit: 0x100, eraseSector: 0x200, programPage: 0x300, verify: 0x400, bkpt: 0x500 },
      }));
      let eraseCalls = 0;
      const result = await flashCmsisDapElf({
        async readDp() { return { ok: true, value: STM32H723VGT6.dpIdcode }; },
        async readMemory(address: number, size: number) {
          if (address === 0x5C001000) return { ok: true, bytes: [0x83, 0x04, 0x00, 0x10].slice(0, size) };
          if (address === 0x1FF1E880) return { ok: true, bytes: [0x00, 0x02].slice(0, size) };
          return { ok: false, errorCode: 'DapInvalidRequest', message: `unexpected read at 0x${address.toString(16)}` };
        },
        async runAlgorithm(request: { operation: string; bkptAddress: number }) {
          if (request.operation === 'eraseSector') eraseCalls += 1;
          return { ok: true, message: 'unexpected', data: { returnCode: 0, pc: request.bkptAddress, dhcsr: 0x00030003 } };
        },
      }, elfPath, 'STM32H723VGT6', { algorithmPath: manifestPath }, STM32H723VGT6);
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('TargetMismatch');
      expect(result.message).toMatch(/Flash capacity mismatch/i);
      expect(result.diagnostics).toMatchObject({ expectedKiB: 1024, actualKiB: 512 });
      expect(eraseCalls).toBe(0);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
