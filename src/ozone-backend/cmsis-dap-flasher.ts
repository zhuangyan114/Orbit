import * as fs from 'fs';
import * as path from 'path';

/**
 * Helper ceiling for flashAlgorithm timeoutMs. Halt/step stay at 10 s; only
 * Flash Algorithm operations may use this longer bound so 128 KiB H7 sector
 * erase is not rejected as DapInvalidRequest before it even starts.
 */
export const FLASH_ALGORITHM_TIMEOUT_MAX_MS = 60_000;

export type CmsisDapFlashErrorCode =
  | 'InvalidConfiguration'
  | 'FlashAlgorithmUnavailable'
  | 'TargetMismatch'
  | 'AlgorithmTimeout'
  | 'AlgorithmError'
  | 'VerifyFailed'
  | 'DeviceRemoved'
  | 'OutcomeUnknown';

export class CmsisDapFlashError extends Error {
  constructor(
    readonly code: CmsisDapFlashErrorCode,
    message: string,
    readonly diagnostics: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'CmsisDapFlashError';
  }
}

export interface FlashSector {
  number: number;
  address: number;
  size: number;
}

/** A contiguous target RAM window an ELF PT_LOAD segment may occupy. */
export interface RamRegion {
  /** Stable label used in error messages, e.g. 'SRAM' or 'AXI SRAM'. */
  readonly name?: string;
  readonly address: number;
  readonly size: number;
}

/** Read-only identity/capacity registers verified before any erase/program. */
export interface FlashPreflightDefinition {
  /** DBGMCU_IDCODE register address (F4: 0xE0042000, H7: DBGMCU base). */
  readonly idcodeAddress: number;
  /** Expected DEV_ID, the low 12 bits of DBGMCU_IDCODE. */
  readonly deviceId: number;
  /** 16-bit Flash size register address reporting capacity in KiB. */
  readonly flashSizeRegisterAddress: number;
  /** Capacity the size register must report; must equal flashSize / 1024. */
  readonly expectedFlashSizeKiB: number;
}

/**
 * Target Flash controller diagnostic registers read around every flashAlgorithm
 * operation. The helper reads both words in one block read starting at the
 * lower address, so the two registers must be adjacent 32-bit words (they are
 * on every supported target, though the status/control order differs between
 * families). Omitting this leaves the helper's STM32F4 defaults in place.
 */
export interface FlashDiagnosticsDefinition {
  readonly statusAddress: number;
  readonly controlAddress: number;
}

export interface FlashTargetDefinition {
  readonly name: string;
  /** Uppercase aliases that resolve to this target, e.g. STM32F407VE. */
  readonly aliases: readonly string[];
  readonly dpIdcode: number;
  readonly flashBase: number;
  readonly flashSize: number;
  readonly sectors: readonly FlashSector[];
  /** Every RAM window ELF segments may target; the loader uses one region. */
  readonly ramRegions: readonly RamRegion[];
  /** Index into ramRegions hosting the algorithm, page buffer, and stack. */
  readonly loaderRamIndex: number;
  readonly preflight: FlashPreflightDefinition;
  /**
   * Flash controller status/control registers for helper diagnostics. The
   * helper defaults to the STM32F4 addresses when omitted.
   */
  readonly flashDiagnostics?: FlashDiagnosticsDefinition;
  /**
   * Flash Algorithm reference: a built-in algorithm name (see
   * BUILTIN_FLASH_ALGORITHMS) or a user algorithm image/manifest path.
   * CmsisDapFlashOptions.algorithmPath still overrides this per session.
   */
  readonly algorithm: string;
  /**
   * Programming granularity in bytes. Adjacent PT_LOAD Flash ranges that share
   * a flash word must be programmed together; a second write to the same ECC
   * word on STM32H7 is a bus fault, not a 1-to-0 overlay. Omit or 1 for
   * per-byte STM32F4 semantics.
   */
  readonly flashWordSize?: number;
  /** Per-operation timeouts scaled to the target's sector/page timing. */
  readonly eraseTimeoutMs: number;
  readonly programTimeoutMs: number;
}

export const STM32F407VET6: FlashTargetDefinition = Object.freeze({
  name: 'STM32F407VET6',
  // STM32F407VE is the common density/package prefix used by project files;
  // it is accepted only as the unqualified name of this exact 512 KiB target.
  aliases: ['STM32F407VE'],
  dpIdcode: 0x2BA01477,
  flashBase: 0x08000000,
  flashSize: 512 * 1024,
  sectors: [
    { number: 0, address: 0x08000000, size: 0x4000 },
    { number: 1, address: 0x08004000, size: 0x4000 },
    { number: 2, address: 0x08008000, size: 0x4000 },
    { number: 3, address: 0x0800C000, size: 0x4000 },
    { number: 4, address: 0x08010000, size: 0x10000 },
    { number: 5, address: 0x08020000, size: 0x20000 },
    { number: 6, address: 0x08040000, size: 0x20000 },
    { number: 7, address: 0x08060000, size: 0x20000 },
  ],
  ramRegions: [
    // The normal SRAM window used by the loader. CCM RAM is deliberately not
    // modeled because it is not accessible by every debug/loader path.
    { name: 'SRAM', address: 0x20000000, size: 128 * 1024 },
  ],
  loaderRamIndex: 0,
  preflight: {
    idcodeAddress: 0xE0042000,
    deviceId: 0x413,
    flashSizeRegisterAddress: 0x1FFF7A22,
    expectedFlashSizeKiB: 512,
  },
  flashDiagnostics: {
    statusAddress: 0x40023C0C,
    controlAddress: 0x40023C10,
  },
  algorithm: 'stm32f407',
  eraseTimeoutMs: 5000,
  programTimeoutMs: 5000,
});

export const STM32H723VGT6: FlashTargetDefinition = Object.freeze({
  name: 'STM32H723VGT6',
  // STM32H723VG is the density/package prefix used by project files; it is
  // accepted only as the unqualified name of this exact 1 MiB target.
  aliases: ['STM32H723VG'],
  // SW-DP v2 DPIDR read back on STM32H723VGT6 hardware during P7-1.
  dpIdcode: 0x6BA02477,
  flashBase: 0x08000000,
  flashSize: 1024 * 1024,
  // 8 uniform 128 KiB sectors (RM0468, single bank).
  sectors: [
    { number: 0, address: 0x08000000, size: 0x20000 },
    { number: 1, address: 0x08020000, size: 0x20000 },
    { number: 2, address: 0x08040000, size: 0x20000 },
    { number: 3, address: 0x08060000, size: 0x20000 },
    { number: 4, address: 0x08080000, size: 0x20000 },
    { number: 5, address: 0x080A0000, size: 0x20000 },
    { number: 6, address: 0x080C0000, size: 0x20000 },
    { number: 7, address: 0x080E0000, size: 0x20000 },
  ],
  // RAM map per RM0468/AN5419. P7-2 confirmed DTCM/D2/D3 are writable over
  // the debug AP on STM32H723VGT6; keep the existing write-error path if a
  // later board cannot reach a region.
  ramRegions: [
    { name: 'ITCM RAM', address: 0x00000000, size: 64 * 1024 },
    { name: 'DTCM RAM', address: 0x20000000, size: 128 * 1024 },
    { name: 'AXI SRAM', address: 0x24000000, size: 320 * 1024 },
    { name: 'SRAM1-3', address: 0x30000000, size: 272 * 1024 },
    { name: 'SRAM4', address: 0x38000000, size: 16 * 1024 },
    { name: 'Backup RAM', address: 0x38800000, size: 4 * 1024 },
  ],
  // The loader runs from AXI SRAM, matching ecosystem convention and keeping
  // it clear of DTCM access uncertainty over the debug AP.
  loaderRamIndex: 2,
  preflight: {
    // DBGMCU_IDCODE at the H7 DBGMCU block; DEV_ID 0x483 covers the RM0468
    // family (H723/H725/H730/H733).
    idcodeAddress: 0x5C001000,
    deviceId: 0x483,
    flashSizeRegisterAddress: 0x1FF1E880,
    expectedFlashSizeKiB: 1024,
  },
  // H723 CR1/SR1 are adjacent words with the opposite order from STM32F4
  // (CR1 at the lower address); the helper's diagnostic block read starts at
  // whichever address is lower.
  flashDiagnostics: {
    statusAddress: 0x52002010,
    controlAddress: 0x5200200C,
  },
  algorithm: 'stm32h723',
  // 256-bit ECC flash word. Adjacent PT_LOAD ranges that share a 32-byte
  // row (typical CubeMX .text/.data LMA split) must be programmed once.
  flashWordSize: 32,
  // 128 KiB sector erase measured ~1.11 s on P7-4; keep generous host
  // defaults under FLASH_ALGORITHM_TIMEOUT_MAX_MS (helper ceiling).
  eraseTimeoutMs: 30000,
  programTimeoutMs: 15000,
});

const FLASH_TARGETS: readonly FlashTargetDefinition[] = [STM32F407VET6, STM32H723VGT6];

/** All registered flash targets, in registration order. */
export function listFlashTargets(): readonly FlashTargetDefinition[] {
  return FLASH_TARGETS;
}

export function normalizeFlashTargetDeviceName(device: string): string {
  return device.trim().toUpperCase();
}

/**
 * Structural invariants every registry entry must satisfy so a malformed
 * target fails with InvalidConfiguration instead of misbehaving mid-flash.
 */
export function validateFlashTargetDefinition(target: FlashTargetDefinition): void {
  if (typeof target.name !== 'string' || target.name === '' || target.name.trim().toUpperCase() !== target.name) {
    fail(`Flash target name must be a non-empty uppercase string: ${JSON.stringify(target.name)}`);
  }
  if (!Number.isSafeInteger(target.flashBase) || target.flashBase < 0
    || !Number.isSafeInteger(target.flashSize) || target.flashSize <= 0 || target.flashSize % 1024 !== 0) {
    fail(`Flash target ${target.name} has an invalid Flash window`);
  }
  const aliasNames = new Set<string>([target.name]);
  for (const alias of target.aliases) {
    const normalized = normalizeFlashTargetDeviceName(alias);
    if (normalized === '' || normalized !== alias) {
      fail(`Flash target ${target.name} alias must be non-empty and uppercase: ${JSON.stringify(alias)}`);
    }
    if (aliasNames.has(normalized)) {
      fail(`Flash target ${target.name} has a duplicate alias: ${alias}`);
    }
    aliasNames.add(normalized);
  }
  if (target.sectors.length === 0) fail(`Flash target ${target.name} has no sectors`);
  let sectorEnd = target.flashBase;
  target.sectors.forEach((sector, index) => {
    if (!Number.isSafeInteger(sector.address) || !Number.isSafeInteger(sector.size) || sector.size <= 0) {
      fail(`Flash target ${target.name} sector ${sector.number} is malformed`);
    }
    if (sector.number !== index) {
      fail(`Flash target ${target.name} sector numbers must be dense and ordered`);
    }
    if (sector.address !== sectorEnd) {
      fail(`Flash target ${target.name} sectors must tile its Flash window without gaps`);
    }
    sectorEnd += sector.size;
  });
  if (sectorEnd !== target.flashBase + target.flashSize) {
    fail(`Flash target ${target.name} sectors do not cover its Flash size`);
  }
  if (target.ramRegions.length === 0) fail(`Flash target ${target.name} has no RAM regions`);
  const sortedRegions = [...target.ramRegions].sort((a, b) => a.address - b.address);
  for (const region of sortedRegions) {
    if (!Number.isSafeInteger(region.address) || !Number.isSafeInteger(region.size)
      || region.address < 0 || region.size <= 0 || region.address + region.size > 0x100000000) {
      fail(`Flash target ${target.name} RAM region ${region.name ?? '(unnamed)'} is malformed`);
    }
  }
  for (let index = 1; index < sortedRegions.length; index += 1) {
    const previous = sortedRegions[index - 1]!;
    const region = sortedRegions[index]!;
    if (region.address < previous.address + previous.size) {
      fail(`Flash target ${target.name} RAM regions overlap at 0x${region.address.toString(16)}`);
    }
  }
  if (!Number.isInteger(target.loaderRamIndex)
    || target.loaderRamIndex < 0 || target.loaderRamIndex >= target.ramRegions.length) {
    fail(`Flash target ${target.name} loaderRamIndex is outside its RAM regions`);
  }
  const preflight = target.preflight;
  if (!Number.isSafeInteger(preflight.idcodeAddress) || preflight.idcodeAddress < 0
    || !Number.isSafeInteger(preflight.flashSizeRegisterAddress) || preflight.flashSizeRegisterAddress < 0
    || !Number.isInteger(preflight.deviceId) || preflight.deviceId < 0 || preflight.deviceId > 0xFFF) {
    fail(`Flash target ${target.name} preflight register model is invalid`);
  }
  if (preflight.expectedFlashSizeKiB !== target.flashSize / 1024) {
    fail(`Flash target ${target.name} preflight capacity does not match its Flash size`);
  }
  if (target.flashDiagnostics !== undefined) {
    const { statusAddress, controlAddress } = target.flashDiagnostics;
    if (!Number.isSafeInteger(statusAddress) || !Number.isSafeInteger(controlAddress)
      || statusAddress < 0 || controlAddress < 0
      || statusAddress % 4 !== 0 || controlAddress % 4 !== 0
      || Math.abs(statusAddress - controlAddress) !== 4) {
      fail(`Flash target ${target.name} flash diagnostics registers must be adjacent aligned words`);
    }
  }
  if (!Number.isSafeInteger(target.eraseTimeoutMs) || target.eraseTimeoutMs <= 0
    || target.eraseTimeoutMs > FLASH_ALGORITHM_TIMEOUT_MAX_MS
    || !Number.isSafeInteger(target.programTimeoutMs) || target.programTimeoutMs <= 0
    || target.programTimeoutMs > FLASH_ALGORITHM_TIMEOUT_MAX_MS) {
    fail(`Flash target ${target.name} Flash Algorithm timeouts must be in 1..${FLASH_ALGORITHM_TIMEOUT_MAX_MS}`);
  }
  if (typeof target.algorithm !== 'string' || target.algorithm.trim() === '') {
    fail(`Flash target ${target.name} has no Flash Algorithm reference`);
  }
  if (target.flashWordSize !== undefined
    && (!Number.isInteger(target.flashWordSize)
      || target.flashWordSize < 1
      || (target.flashWordSize & (target.flashWordSize - 1)) !== 0
      || target.flashWordSize > 0x10000)) {
    fail(`Flash target ${target.name} flashWordSize must be a power of two in 1..65536`);
  }
}

/**
 * Resolves a device name to its registered FlashTargetDefinition, including
 * the alias mechanism (STM32F407VE → STM32F407VET6). An unregistered device
 * throws a structured TargetMismatch listing the supported targets.
 */
export function resolveFlashTarget(device: string): FlashTargetDefinition {
  const normalized = normalizeFlashTargetDeviceName(device);
  const target = FLASH_TARGETS.find(entry => entry.name === normalized || entry.aliases.includes(normalized));
  if (!target) {
    const supported = FLASH_TARGETS.flatMap(entry => [entry.name, ...entry.aliases]).join(', ');
    throw new CmsisDapFlashError(
      'TargetMismatch',
      `CMSIS-DAP DAP-02A target is not registered: ${device} (supported: ${supported})`,
      { device, supportedTargets: FLASH_TARGETS.map(entry => entry.name) },
    );
  }
  validateFlashTargetDefinition(target);
  return target;
}

export interface Elf32LoadSegment {
  /** Runtime address described by ELF p_vaddr. */
  address: number;
  /** Load address described by ELF p_paddr, or p_vaddr when p_paddr is zero. */
  loadAddress: number;
  fileOffset: number;
  fileSize: number;
  memorySize: number;
  flags: number;
  bytes: Uint8Array;
}

const ELF_HEADER_SIZE = 52;
const ELF_PROGRAM_HEADER_SIZE = 32;
const PT_LOAD = 1;

function fail(message: string): never {
  throw new CmsisDapFlashError('InvalidConfiguration', message);
}

function checkedRange(start: number, size: number, limit: number, label: string): void {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(size) || start < 0 || size < 0 || start + size > limit) {
    fail(`${label} is outside the ELF file`);
  }
}

export function parseElf32LoadSegments(input: Uint8Array): Elf32LoadSegment[] {
  if (input.byteLength < ELF_HEADER_SIZE) fail('ELF header is truncated');
  if (input[0] !== 0x7F || input[1] !== 0x45 || input[2] !== 0x4C || input[3] !== 0x46) {
    fail('file is not an ELF image');
  }
  if (input[4] !== 1) fail('ELF image is not 32-bit');
  if (input[5] !== 1) fail('ELF image is not little-endian');
  if (input[6] !== 1) fail('ELF header version is invalid');

  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const type = view.getUint16(16, true);
  const machine = view.getUint16(18, true);
  const version = view.getUint32(20, true);
  const programHeaderOffset = view.getUint32(28, true);
  const programHeaderEntrySize = view.getUint16(42, true);
  const programHeaderCount = view.getUint16(44, true);
  if (type !== 2 || machine !== 40 || version !== 1) fail('ELF is not an ARM executable image');
  if (programHeaderEntrySize < ELF_PROGRAM_HEADER_SIZE) fail('ELF program header entry is too small');
  checkedRange(
    programHeaderOffset,
    programHeaderEntrySize * programHeaderCount,
    input.byteLength,
    'ELF program header table',
  );

  const segments: Elf32LoadSegment[] = [];
  for (let index = 0; index < programHeaderCount; index += 1) {
    const header = programHeaderOffset + index * programHeaderEntrySize;
    const segmentType = view.getUint32(header, true);
    if (segmentType !== PT_LOAD) continue;
    const fileOffset = view.getUint32(header + 4, true);
    const virtualAddress = view.getUint32(header + 8, true);
    const physicalAddress = view.getUint32(header + 12, true);
    const fileSize = view.getUint32(header + 16, true);
    const memorySize = view.getUint32(header + 20, true);
    const flags = view.getUint32(header + 24, true);
    if (fileSize > memorySize) fail(`ELF PT_LOAD ${index} has file size larger than memory size`);
    checkedRange(fileOffset, fileSize, input.byteLength, `ELF PT_LOAD ${index} payload`);
    const address = virtualAddress;
    const loadAddress = physicalAddress !== 0 ? physicalAddress : virtualAddress;
    if (address + memorySize > 0x100000000) fail(`ELF PT_LOAD ${index} address overflows 32-bit space`);
    if (loadAddress + fileSize > 0x100000000) fail(`ELF PT_LOAD ${index} load address overflows 32-bit space`);
    segments.push({
      address,
      loadAddress,
      fileOffset,
      fileSize,
      memorySize,
      flags,
      bytes: Uint8Array.from(input.slice(fileOffset, fileOffset + fileSize)),
    });
  }

  const nonEmpty = segments
    .filter(segment => segment.memorySize > 0)
    .sort((a, b) => a.address - b.address);
  for (let index = 1; index < nonEmpty.length; index += 1) {
    const previous = nonEmpty[index - 1];
    const current = nonEmpty[index];
    if (current.address < previous.address + previous.memorySize) {
      fail(`ELF PT_LOAD segments overlap at 0x${current.address.toString(16)}`);
    }
  }
  const nonEmptyLoad = segments
    .filter(segment => segment.fileSize > 0)
    .sort((a, b) => a.loadAddress - b.loadAddress);
  for (let index = 1; index < nonEmptyLoad.length; index += 1) {
    const previous = nonEmptyLoad[index - 1];
    const current = nonEmptyLoad[index];
    if (current.loadAddress < previous.loadAddress + previous.fileSize) {
      fail(`ELF PT_LOAD load ranges overlap at 0x${current.loadAddress.toString(16)}`);
    }
  }
  return segments;
}

function isInRange(address: number, size: number, base: number, capacity: number): boolean {
  return address >= base && size >= 0 && address + size <= base + capacity;
}

/** Returns the target RAM region that fully contains [address, address+size). */
export function findRamRegion(target: FlashTargetDefinition, address: number, size: number): RamRegion | undefined {
  return target.ramRegions.find(region => isInRange(address, size, region.address, region.size));
}

function validateSegmentTarget(segment: Elf32LoadSegment, target: FlashTargetDefinition): void {
  if (segment.memorySize === 0) return;
  if (isInRange(segment.address, segment.memorySize, target.flashBase, target.flashSize)) return;
  if (findRamRegion(target, segment.address, segment.memorySize)) return;
  throw new CmsisDapFlashError(
    'TargetMismatch',
    `ELF PT_LOAD at 0x${segment.address.toString(16)} is outside ${target.name} Flash and RAM regions`,
    { address: segment.address, size: segment.memorySize, target: target.name },
  );
}

export function calculateEraseSectors(
  segments: readonly Elf32LoadSegment[],
  target: FlashTargetDefinition,
): FlashSector[] {
  const selected = new Map<number, FlashSector>();
  for (const segment of segments) {
    validateSegmentTarget(segment, target);
    if (segment.fileSize === 0) continue;
    if (!isInRange(segment.loadAddress, segment.fileSize, target.flashBase, target.flashSize)) {
      if (findRamRegion(target, segment.loadAddress, segment.fileSize)) continue;
      throw new CmsisDapFlashError(
        'TargetMismatch',
        `ELF load bytes at 0x${segment.loadAddress.toString(16)} are outside ${target.name} Flash and RAM regions`,
        { address: segment.loadAddress, size: segment.fileSize, target: target.name },
      );
    }
    const end = segment.loadAddress + segment.fileSize;
    for (const sector of target.sectors) {
      if (segment.loadAddress < sector.address + sector.size && end > sector.address) selected.set(sector.number, sector);
    }
  }
  return [...selected.values()].sort((a, b) => a.number - b.number);
}

export interface FlashProgramRange {
  address: number;
  bytes: Uint8Array;
}

/**
 * Collapses Flash PT_LOAD payloads into programming ranges. Adjacent ranges
 * that share a flash word (STM32H7 256-bit ECC row) are merged so the
 * algorithm programs that word once. Gaps inside a merged range are filled
 * with 0xFF, matching erased Flash. F4 (flashWordSize omitted/1) keeps one
 * range per PT_LOAD.
 */
export function coalesceFlashProgramRanges(
  segments: readonly Elf32LoadSegment[],
  target: FlashTargetDefinition,
): FlashProgramRange[] {
  const flashWordSize = target.flashWordSize && target.flashWordSize > 1 ? target.flashWordSize : 1;
  const flashLoads = segments
    .filter(segment => segment.fileSize > 0
      && isInRange(segment.loadAddress, segment.fileSize, target.flashBase, target.flashSize))
    .slice()
    .sort((a, b) => a.loadAddress - b.loadAddress);
  const ranges: FlashProgramRange[] = [];
  for (const segment of flashLoads) {
    const previous = ranges[ranges.length - 1];
    const previousWord = previous
      ? Math.floor((previous.address + previous.bytes.length - 1) / flashWordSize)
      : -1;
    const currentWord = Math.floor(segment.loadAddress / flashWordSize);
    if (!previous || currentWord > previousWord) {
      ranges.push({ address: segment.loadAddress, bytes: Uint8Array.from(segment.bytes) });
      continue;
    }
    const end = Math.max(previous.address + previous.bytes.length, segment.loadAddress + segment.fileSize);
    const merged = new Uint8Array(end - previous.address);
    merged.fill(0xFF);
    merged.set(previous.bytes, 0);
    merged.set(segment.bytes, segment.loadAddress - previous.address);
    previous.bytes = merged;
  }
  return ranges;
}

export interface FlashRamLayout {
  algorithm: RamRegion;
  pageBuffer: RamRegion;
  stack: RamRegion;
  stackPointer: number;
  /** The loader RAM region hosting the algorithm, page buffer, and stack. */
  region: RamRegion;
}

function alignUp(value: number, alignment: number): number {
  return (value + alignment - 1) & ~(alignment - 1);
}

export function planFlashRamLayout(
  target: FlashTargetDefinition,
  algorithmSize: number,
  pageBufferSize: number,
  stackSize = 0x1000,
): FlashRamLayout {
  if (!Number.isInteger(algorithmSize) || algorithmSize <= 0) fail('Flash Algorithm is empty');
  if (!Number.isInteger(pageBufferSize) || pageBufferSize <= 0) fail('Flash Algorithm page buffer is empty');
  if (!Number.isInteger(stackSize) || stackSize < 0x100 || stackSize % 8 !== 0) fail('Flash Algorithm stack size is invalid');
  const loaderRegion = target.ramRegions[target.loaderRamIndex];
  if (!loaderRegion) {
    fail(`Flash target ${target.name} has no loader RAM region at index ${target.loaderRamIndex}`);
  }
  const algorithmAddress = loaderRegion.address;
  const pageBufferAddress = alignUp(algorithmAddress + algorithmSize, 4);
  const stackAddress = loaderRegion.address + loaderRegion.size - stackSize;
  if (pageBufferAddress + pageBufferSize > stackAddress || stackAddress < loaderRegion.address) {
    fail(`Flash Algorithm regions do not fit inside ${target.name} ${loaderRegion.name ?? 'loader RAM'} `
      + `(0x${loaderRegion.address.toString(16)}+0x${loaderRegion.size.toString(16)})`);
  }
  return {
    algorithm: { address: algorithmAddress, size: algorithmSize },
    pageBuffer: { address: pageBufferAddress, size: pageBufferSize },
    stack: { address: stackAddress, size: stackSize },
    stackPointer: stackAddress + stackSize,
    region: loaderRegion,
  };
}

export interface FlashAlgorithmEntries {
  init: number;
  uninit: number;
  eraseSector: number;
  programPage: number;
  verify?: number;
  bkpt: number;
}

export interface FlashAlgorithmImage {
  code: Uint8Array;
  entries: FlashAlgorithmEntries;
  /** CMSIS-Pack static_base for R9; zero means this image has no static data. */
  staticBase: number;
  pageSize: number;
  /** The algorithm guarantees ProgramPage leaves the uploaded bytes unchanged. */
  preservesPageBuffer: boolean;
  source: 'built-in' | 'user-provided';
  path: string;
}

/**
 * Entry offsets shared by the built-in algorithms and the conservative
 * default for user binaries: Init/UnInit/EraseSector/ProgramPage/Verify/BKPT
 * at fixed 0x100 strides with a `00 BE` Thumb BKPT sentinel.
 */
const DEFAULT_ALGORITHM_ENTRIES: FlashAlgorithmEntries = {
  init: 0x000,
  uninit: 0x100,
  eraseSector: 0x200,
  programPage: 0x300,
  verify: 0x400,
  bkpt: 0x500,
};

export interface BuiltinFlashAlgorithmMetadata {
  /** File name shipped under out/native/win32-x64/. */
  readonly fileName: string;
  readonly entries: FlashAlgorithmEntries;
  /** CMSIS-Pack static_base for R9; zero means the image has no static data. */
  readonly staticBase: number;
  readonly pageSize: number;
  /** Whether ProgramPage leaves the uploaded bytes unchanged for Verify. */
  readonly preservesPageBuffer: boolean;
}

/** Built-in RAM Flash Algorithms referenced by FlashTargetDefinition.algorithm. */
const BUILTIN_FLASH_ALGORITHMS: ReadonlyMap<string, BuiltinFlashAlgorithmMetadata> = new Map([
  [
    'stm32f407',
    Object.freeze({
      fileName: 'orbit-stm32f407-flash-algorithm.bin',
      entries: DEFAULT_ALGORITHM_ENTRIES,
      staticBase: 0,
      // The built-in algorithm accepts up to 64 KiB per ProgramPage. A 16 KiB
      // buffer matches STM32F4's smallest erase sector and avoids paying the
      // CMSIS-DAP register/RAM-upload overhead once per 1 KiB slice.
      pageSize: 0x4000,
      preservesPageBuffer: true,
    } satisfies BuiltinFlashAlgorithmMetadata),
  ],
  [
    'stm32h723',
    Object.freeze({
      fileName: 'orbit-stm32h723-flash-algorithm.bin',
      entries: DEFAULT_ALGORITHM_ENTRIES,
      staticBase: 0,
      // 64 KiB per ProgramPage, the host-side page cap. Each call is padded
      // by the algorithm to whole 256-bit flash words; two calls cover one
      // 128 KiB H723 sector.
      pageSize: 0x10000,
      preservesPageBuffer: true,
    } satisfies BuiltinFlashAlgorithmMetadata),
  ],
]);

function builtinFlashAlgorithmPath(fileName: string): string {
  const relative = path.join('out', 'native', 'win32-x64', fileName);
  const candidates = [
    path.resolve(__dirname, '..', relative),
    path.resolve(__dirname, '..', '..', relative),
    path.resolve(process.cwd(), relative),
  ];
  return candidates.find(candidate => fs.existsSync(candidate)) || candidates[0];
}

/** Registered built-in Flash Algorithms and their metadata contract. */
export function listBuiltinFlashAlgorithms(): ReadonlyMap<string, BuiltinFlashAlgorithmMetadata> {
  return BUILTIN_FLASH_ALGORITHMS;
}

export function loadFlashAlgorithm(target: FlashTargetDefinition, explicitPath?: string): FlashAlgorithmImage {
  const reference = explicitPath || target.algorithm;
  // An explicit user path never resolves to a built-in image; a target's
  // algorithm reference does when it names a registered built-in algorithm.
  const builtin = explicitPath ? undefined : BUILTIN_FLASH_ALGORITHMS.get(reference);
  if (!builtin && !explicitPath && !/[\\/]/.test(reference) && path.extname(reference) === '') {
    // The reference is a bare algorithm name, so an unknown one is a registry
    // gap rather than a missing file.
    throw new CmsisDapFlashError(
      'FlashAlgorithmUnavailable',
      `Flash target ${target.name} references unknown built-in Flash Algorithm '${reference}'`,
      { target: target.name, algorithm: reference },
    );
  }
  let binaryPath = builtin ? builtinFlashAlgorithmPath(builtin.fileName) : reference;
  let entries: FlashAlgorithmEntries = builtin ? builtin.entries : DEFAULT_ALGORITHM_ENTRIES;
  let staticBase = builtin ? builtin.staticBase : 0;
  // Built-in images declare their page contract through metadata. User
  // supplied images retain the conservative 1 KiB default unless their
  // manifest declares a different page size.
  let pageSize = builtin ? builtin.pageSize : 1024;
  let preservesPageBuffer = builtin ? builtin.preservesPageBuffer : false;
  let source: FlashAlgorithmImage['source'] = builtin ? 'built-in' : 'user-provided';
  if (!builtin && reference.toLowerCase().endsWith('.json')) {
    let manifest: {
      binary?: string;
      entries?: Partial<FlashAlgorithmEntries> & { verify?: number | null };
      staticBase?: number;
      pageSize?: number;
      preservesPageBuffer?: boolean;
    };
    try {
      manifest = JSON.parse(fs.readFileSync(reference, 'utf8')) as typeof manifest;
    } catch (error) {
      throw new CmsisDapFlashError('FlashAlgorithmUnavailable', `Flash Algorithm manifest is invalid: ${String(error)}`);
    }
    if (!manifest.binary) throw new CmsisDapFlashError('FlashAlgorithmUnavailable', 'Flash Algorithm manifest has no binary');
    binaryPath = path.resolve(path.dirname(reference), manifest.binary);
    const manifestEntries = manifest.entries || {};
    const requiredEntries: Array<keyof FlashAlgorithmEntries> = [
      'init', 'uninit', 'eraseSector', 'programPage', 'bkpt',
    ];
    if (requiredEntries.some(name => manifestEntries[name] === undefined)) {
      throw new CmsisDapFlashError(
        'FlashAlgorithmUnavailable',
        'Flash Algorithm manifest is missing a required entry offset',
      );
    }
    entries = {
      init: manifestEntries.init!,
      uninit: manifestEntries.uninit!,
      eraseSector: manifestEntries.eraseSector!,
      programPage: manifestEntries.programPage!,
      bkpt: manifestEntries.bkpt!,
      ...(manifestEntries.verify === undefined || manifestEntries.verify === null
        ? {}
        : { verify: manifestEntries.verify }),
    };
    staticBase = manifest.staticBase ?? 0;
    if (!Number.isSafeInteger(staticBase) || staticBase < 0 || staticBase > 0xFFFFFFFF) {
      throw new CmsisDapFlashError('FlashAlgorithmUnavailable', 'Flash Algorithm static_base is invalid');
    }
    pageSize = manifest.pageSize || pageSize;
    if (manifest.preservesPageBuffer !== undefined && typeof manifest.preservesPageBuffer !== 'boolean') {
      throw new CmsisDapFlashError('FlashAlgorithmUnavailable', 'Flash Algorithm preservesPageBuffer flag is invalid');
    }
    preservesPageBuffer = manifest.preservesPageBuffer === true;
  }
  if (!fs.existsSync(binaryPath)) throw new CmsisDapFlashError('FlashAlgorithmUnavailable', `Flash Algorithm binary is missing: ${binaryPath}`);
  const code = Uint8Array.from(fs.readFileSync(binaryPath));
  const entryOffsets = [entries.init, entries.uninit, entries.eraseSector, entries.programPage, entries.verify, entries.bkpt]
    .filter((offset): offset is number => offset !== undefined);
  if (entryOffsets.some(offset => !Number.isInteger(offset) || offset < 0 || offset + 1 >= code.length)) {
    throw new CmsisDapFlashError('FlashAlgorithmUnavailable', 'Flash Algorithm entry offset is outside its image');
  }
  if (code.length <= entries.bkpt + 1
    || code[entries.bkpt] !== 0x00
    || code[entries.bkpt + 1] !== 0xBE) {
    throw new CmsisDapFlashError('FlashAlgorithmUnavailable', 'Flash Algorithm does not contain a Thumb BKPT sentinel');
  }
  if (!Number.isInteger(pageSize) || pageSize <= 0 || pageSize > 0x10000) {
    throw new CmsisDapFlashError('FlashAlgorithmUnavailable', 'Flash Algorithm page size is invalid');
  }
  return { code, entries, staticBase, pageSize, preservesPageBuffer, source, path: binaryPath };
}

export function validateTargetDeviceName(device: string, target: FlashTargetDefinition): void {
  const normalized = normalizeFlashTargetDeviceName(device);
  if (normalized !== target.name && !target.aliases.includes(normalized)) {
    throw new CmsisDapFlashError(
      'TargetMismatch',
      `CMSIS-DAP DAP-02A only supports ${target.name}, received ${device}`,
      { device, target: target.name },
    );
  }
}

export type FlashAlgorithmOperation = 'init' | 'uninit' | 'eraseSector' | 'programPage' | 'verify';

export interface FlashAlgorithmRunRequest {
  operation: FlashAlgorithmOperation;
  algorithm: number[];
  algorithmAddress: number;
  entry: number;
  bkptAddress: number;
  stackPointer: number;
  stackSize: number;
  pageBufferAddress: number;
  targetAddress: number;
  size: number;
  data: number[];
  clockHz: number;
  staticBase: number;
  timeoutMs: number;
  /** Reuse only the immediately preceding, helper-validated ProgramPage data. */
  reusePageBuffer: boolean;
  /**
   * Flash controller diagnostic registers for this operation. Omitted for
   * targets without a flashDiagnostics model; the helper then reads its
   * STM32F4 defaults.
   */
  flashStatusAddress?: number;
  flashControlAddress?: number;
  /**
   * Loader RAM window the algorithm image, page buffer, and stack live in.
   * Omitted for targets without a modeled loader region; the helper then
   * validates against its STM32F407 128 KiB SRAM defaults.
   */
  ramBase?: number;
  ramSize?: number;
}

export interface FlashAlgorithmRunData {
  returnCode: number;
  pc: number;
  dhcsr: number;
  flashStatusBefore?: number;
  flashControlBefore?: number;
  flashStatus?: number;
  flashControl?: number;
}

export interface CmsisDapFlashRpcResult<T = FlashAlgorithmRunData> {
  ok: boolean;
  message: string;
  errorCode?: string;
  data?: T;
  elapsedMs?: number;
  diagnostics?: Record<string, unknown>;
}

export interface CmsisDapFlashTransport {
  readDp(reg: number): Promise<{ ok: boolean; value?: number; message?: string; errorCode?: string }>;
  readMemory(address: number, size: number): Promise<{ ok: boolean; bytes?: Uint8Array | number[]; message?: string; errorCode?: string }>;
  runAlgorithm(request: FlashAlgorithmRunRequest): Promise<CmsisDapFlashRpcResult>;
}

export interface FlashOperationReport {
  operation: FlashAlgorithmOperation;
  address: number;
  size: number;
  elapsedMs: number;
  ok: boolean;
  errorCode?: string;
  message?: string;
}

export interface CmsisDapFlashOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  clockHz?: number;
  algorithmPath?: string;
  pageSize?: number;
  pageBufferSize?: number;
  stackSize?: number;
  /** When false, skip the verify algorithm/read-back step after programming. */
  verify?: boolean;
  onOperation?: (report: FlashOperationReport) => void;
}

export interface CmsisDapFlashResult {
  success: boolean;
  message: string;
  errorCode?: CmsisDapFlashErrorCode;
  reports: FlashOperationReport[];
  erasedSectors: FlashSector[];
  target: FlashTargetDefinition;
  algorithmPath?: string;
  diagnostics?: Record<string, unknown>;
}

function asBytes(value: Uint8Array | number[] | undefined): Uint8Array {
  return value instanceof Uint8Array ? value : Uint8Array.from(value || []);
}

function readLe16(bytes: Uint8Array): number {
  if (bytes.length < 2) throw new CmsisDapFlashError('TargetMismatch', 'Flash size register read was truncated');
  return bytes[0] | (bytes[1] << 8);
}

function readLe32(bytes: Uint8Array): number {
  if (bytes.length < 4) throw new CmsisDapFlashError('TargetMismatch', 'Target identity register read was truncated');
  return (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
}

function throwRpcFailure(operation: FlashAlgorithmOperation, result: CmsisDapFlashRpcResult): never {
  const code = result.errorCode || 'AlgorithmError';
  const mapped = code === 'DeviceRemoved'
    ? 'DeviceRemoved'
    : code === 'OutcomeUnknown' || code === 'WriteCompletedLate' || code === 'DapAlgorithmHaltUnknown'
      ? 'OutcomeUnknown'
      : code === 'DapAlgorithmTimeout' || code === 'DapControlTimeout'
        ? 'AlgorithmTimeout'
        : operation === 'verify'
          ? 'VerifyFailed'
          : 'AlgorithmError';
  const details: string[] = [];
  if (result.data && typeof result.data.returnCode === 'number') {
    details.push(`returnCode=${result.data.returnCode}`);
  }
  if (result.data && typeof result.data.flashStatus === 'number') {
    details.push(`FLASH_SR=0x${result.data.flashStatus.toString(16)}`);
  }
  if (result.data && typeof result.data.flashControl === 'number') {
    details.push(`FLASH_CR=0x${result.data.flashControl.toString(16)}`);
  }
  if (result.data && typeof result.data.flashStatusBefore === 'number') {
    details.push(`FLASH_SR_before=0x${result.data.flashStatusBefore.toString(16)}`);
  }
  if (result.data && typeof result.data.flashControlBefore === 'number') {
    details.push(`FLASH_CR_before=0x${result.data.flashControlBefore.toString(16)}`);
  }
  const message = `${result.message || `${operation} failed`}${details.length ? ` (${details.join(' ')})` : ''}`;
  throw new CmsisDapFlashError(mapped, message, {
    operation,
    helperErrorCode: code,
    helperDiagnostics: result.diagnostics,
  });
}

function throwReadFailure(stage: string, result: { message?: string; errorCode?: string }): never {
  const code = result.errorCode === 'DeviceRemoved' ? 'DeviceRemoved' : 'TargetMismatch';
  throw new CmsisDapFlashError(code, `${stage} failed: ${result.message || result.errorCode || 'unknown error'}`, {
    stage,
    helperErrorCode: result.errorCode,
  });
}

function ensureNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new CmsisDapFlashError('OutcomeUnknown', `CMSIS-DAP Flash cancelled: ${String(signal.reason || 'aborted')}`);
  }
}

/** Fallback timeout for algorithm operations without a per-target field. */
const DEFAULT_FLASH_ALGORITHM_TIMEOUT_MS = 5000;

export async function flashCmsisDapElf(
  transport: CmsisDapFlashTransport,
  elfPath: string,
  device: string,
  options: CmsisDapFlashOptions = {},
  target: FlashTargetDefinition,
): Promise<CmsisDapFlashResult> {
  const reports: FlashOperationReport[] = [];
  let erasedSectors: FlashSector[] = [];
  const report = (value: FlashOperationReport) => {
    reports.push(value);
    options.onOperation?.(value);
  };
  const failed = (error: unknown): CmsisDapFlashResult => {
    const flashError = error instanceof CmsisDapFlashError
      ? error
      : new CmsisDapFlashError('AlgorithmError', error instanceof Error ? error.message : String(error));
    return {
      success: false,
      message: flashError.message,
      errorCode: flashError.code,
      reports,
      erasedSectors,
      target,
      diagnostics: flashError.diagnostics,
    };
  };

  try {
    ensureNotAborted(options.signal);
    validateTargetDeviceName(device, target);
    if (!elfPath || !fs.existsSync(elfPath)) {
      throw new CmsisDapFlashError('InvalidConfiguration', `ELF file not found: ${elfPath || '(empty)'}`);
    }
    let elfBytes: Uint8Array;
    try {
      elfBytes = Uint8Array.from(fs.readFileSync(elfPath));
    } catch (error) {
      throw new CmsisDapFlashError('InvalidConfiguration', `ELF file could not be read: ${String(error)}`);
    }
    const segments = parseElf32LoadSegments(elfBytes);
    erasedSectors = calculateEraseSectors(segments, target);
    if (erasedSectors.length === 0) throw new CmsisDapFlashError('InvalidConfiguration', 'ELF has no Flash PT_LOAD bytes');
    const programRanges = coalesceFlashProgramRanges(segments, target);
    const algorithm = loadFlashAlgorithm(target, options.algorithmPath);
    const pageSize = options.pageSize || algorithm.pageSize;
    const pageBufferSize = options.pageBufferSize || pageSize;
    if (pageBufferSize < pageSize) {
      throw new CmsisDapFlashError(
        'InvalidConfiguration',
        `Flash Algorithm page buffer (${pageBufferSize} bytes) is smaller than its page size (${pageSize} bytes)`,
      );
    }
    const layout = planFlashRamLayout(target, algorithm.code.length, pageBufferSize, options.stackSize);
    if (options.timeoutMs !== undefined
      && (!Number.isSafeInteger(options.timeoutMs)
        || options.timeoutMs <= 0
        || options.timeoutMs > FLASH_ALGORITHM_TIMEOUT_MAX_MS)) {
      throw new CmsisDapFlashError(
        'InvalidConfiguration',
        `Flash Algorithm timeoutMs must be an integer in 1..${FLASH_ALGORITHM_TIMEOUT_MAX_MS}`,
      );
    }
    // Per-target defaults keep slow sectors (e.g. future 128 KiB H7 sectors)
    // from being reported as timeouts; options.timeoutMs still overrides
    // every operation for compatibility.
    const operationTimeoutMs = (operation: FlashAlgorithmOperation): number => {
      if (options.timeoutMs !== undefined) return options.timeoutMs;
      if (operation === 'eraseSector') return target.eraseTimeoutMs;
      if (operation === 'programPage' || operation === 'verify') return target.programTimeoutMs;
      return DEFAULT_FLASH_ALGORITHM_TIMEOUT_MS;
    };
    const clockHz = options.clockHz ?? 4000000;
    const verify = options.verify !== false;
    let skipUninit = false;

    const dp = await transport.readDp(0);
    if (!dp.ok || dp.value === undefined) throwReadFailure('SW-DP IDCODE preflight', dp);
    if ((dp.value >>> 0) !== target.dpIdcode) {
      throw new CmsisDapFlashError('TargetMismatch',
        `SW-DP IDCODE mismatch: expected 0x${target.dpIdcode.toString(16)}, got 0x${(dp.value >>> 0).toString(16)}`,
        { expected: target.dpIdcode, actual: dp.value >>> 0 });
    }
    const idcode = await transport.readMemory(target.preflight.idcodeAddress, 4);
    if (!idcode.ok || !idcode.bytes) throwReadFailure('DBGMCU_IDCODE preflight', idcode);
    const deviceIdcode = readLe32(asBytes(idcode.bytes));
    if ((deviceIdcode & 0xFFF) !== target.preflight.deviceId) {
      throw new CmsisDapFlashError('TargetMismatch',
        `DBGMCU_IDCODE mismatch: expected device ID 0x${target.preflight.deviceId.toString(16)}, got 0x${(deviceIdcode & 0xFFF).toString(16)}`,
        { expected: target.preflight.deviceId, actual: deviceIdcode });
    }
    const flashSize = await transport.readMemory(target.preflight.flashSizeRegisterAddress, 2);
    if (!flashSize.ok || !flashSize.bytes) throwReadFailure('Flash size preflight', flashSize);
    const flashSizeKiB = readLe16(asBytes(flashSize.bytes));
    if (flashSizeKiB !== target.preflight.expectedFlashSizeKiB) {
      throw new CmsisDapFlashError('TargetMismatch',
        `Flash capacity mismatch: expected ${target.preflight.expectedFlashSizeKiB} KiB, got ${flashSizeKiB} KiB`,
        { expectedKiB: target.preflight.expectedFlashSizeKiB, actualKiB: flashSizeKiB });
    }

    const run = async (
      operation: FlashAlgorithmOperation,
      address: number,
      size: number,
      data: Uint8Array = new Uint8Array(),
      reusePageBuffer = false,
    ): Promise<FlashAlgorithmRunData> => {
      ensureNotAborted(options.signal);
      const started = Date.now();
      const request: FlashAlgorithmRunRequest = {
        operation,
        algorithm: Array.from(algorithm.code),
        algorithmAddress: layout.algorithm.address,
        entry: layout.algorithm.address + (algorithm.entries[operation === 'init' ? 'init' : operation === 'uninit' ? 'uninit' : operation === 'eraseSector' ? 'eraseSector' : operation === 'programPage' ? 'programPage' : 'verify'] || 0),
      bkptAddress: layout.algorithm.address + algorithm.entries.bkpt,
      stackPointer: layout.stackPointer,
        stackSize: layout.stack.size,
        pageBufferAddress: layout.pageBuffer.address,
        targetAddress: address,
        size,
        data: Array.from(data),
        clockHz,
        staticBase: algorithm.staticBase,
        timeoutMs: operationTimeoutMs(operation),
        reusePageBuffer,
        ...(target.flashDiagnostics
          ? {
              flashStatusAddress: target.flashDiagnostics.statusAddress,
              flashControlAddress: target.flashDiagnostics.controlAddress,
            }
          : {}),
        ramBase: layout.region.address,
        ramSize: layout.region.size,
      };
      let result: CmsisDapFlashRpcResult;
      try {
        result = await transport.runAlgorithm(request);
      } catch (error) {
        skipUninit = true;
        const elapsedMs = Date.now() - started;
        const message = `${operation} helper request failed: ${error instanceof Error ? error.message : String(error)}`;
        report({ operation, address, size, elapsedMs, ok: false, errorCode: 'OutcomeUnknown', message });
        throw new CmsisDapFlashError('OutcomeUnknown', message, {
          operation,
          helperErrorCode: 'HelperRequestFailed',
        });
      }
      const elapsedMs = result.elapsedMs ?? (Date.now() - started);
      if (!result.ok) {
        if (result.errorCode === 'OutcomeUnknown'
          || result.errorCode === 'WriteCompletedLate'
          || result.errorCode === 'DapControlTimeout'
          || result.errorCode === 'DapAlgorithmHaltUnknown'
          || result.errorCode === 'DeviceRemoved') {
          skipUninit = true;
        }
        report({ operation, address, size, elapsedMs, ok: false, errorCode: result.errorCode, message: result.message });
        throwRpcFailure(operation, result);
      }
      if (!result.data) {
        skipUninit = true;
        const failure: CmsisDapFlashRpcResult = { ...result, ok: false, errorCode: 'MalformedResponse', message: `${operation} returned no completion state` };
        report({ operation, address, size, elapsedMs, ok: false, errorCode: failure.errorCode, message: failure.message });
        throwRpcFailure(operation, failure);
      }
      const stoppedAtBkpt = result.data.pc === request.bkptAddress
        || result.data.pc === request.bkptAddress + 2;
      if (!stoppedAtBkpt || (result.data.dhcsr & (1 << 17)) === 0) {
        skipUninit = true;
        const failure: CmsisDapFlashRpcResult = { ...result, ok: false, errorCode: 'OutcomeUnknown', message: `${operation} did not stop at its trusted BKPT` };
        report({ operation, address, size, elapsedMs, ok: false, errorCode: failure.errorCode, message: failure.message });
        throwRpcFailure(operation, failure);
      }
      if (result.data.returnCode !== 0) {
        const failureCode = result.data.returnCode === 1
          ? 'DapAlgorithmTimeout'
          : operation === 'verify'
            ? 'VerifyFailed'
            : 'AlgorithmError';
        const helperMessage = result.message || `${operation} returned algorithm error 0x${result.data.returnCode.toString(16)}`;
        const failure: CmsisDapFlashRpcResult = {
          ...result,
          ok: false,
          errorCode: failureCode,
          message: helperMessage,
        };
        report({ operation, address, size, elapsedMs, ok: false, errorCode: failure.errorCode, message: failure.message });
        throwRpcFailure(operation, failure);
      }
      report({ operation, address, size, elapsedMs, ok: true, message: result.message });
      return result.data;
    };

    let primaryError: unknown;
    try {
      await run('init', target.flashBase, 0);
      for (const sector of erasedSectors) await run('eraseSector', sector.address, sector.size);
      for (const range of programRanges) {
        for (let offset = 0; offset < range.bytes.length; offset += pageSize) {
          const size = Math.min(pageSize, range.bytes.length - offset);
          const page = range.bytes.slice(offset, offset + size);
          await run('programPage', range.address + offset, size, page);
          if (verify && algorithm.preservesPageBuffer && algorithm.entries.verify !== undefined) {
            await run('verify', range.address + offset, size, page, true);
          }
        }
      }
      if (verify) {
        const verificationAlreadyComplete = algorithm.preservesPageBuffer
          && algorithm.entries.verify !== undefined;
        for (const range of programRanges) {
          if (verificationAlreadyComplete) continue;
          if (algorithm.entries.verify !== undefined) {
            for (let offset = 0; offset < range.bytes.length; offset += pageSize) {
              const size = Math.min(pageSize, range.bytes.length - offset);
              await run(
                'verify',
                range.address + offset,
                size,
                range.bytes.slice(offset, offset + size),
              );
            }
            continue;
          }
          const started = Date.now();
          const read = await transport.readMemory(range.address, range.bytes.length);
          const actual = asBytes(read.bytes);
          let mismatch = !read.ok || actual.length !== range.bytes.length;
          if (!mismatch) {
            for (let index = 0; index < range.bytes.length; index += 1) {
              if (actual[index] !== range.bytes[index]) { mismatch = true; break; }
            }
          }
          const elapsedMs = Date.now() - started;
          if (mismatch) {
            report({ operation: 'verify', address: range.address, size: range.bytes.length, elapsedMs, ok: false, errorCode: 'VerifyFailed', message: 'complete Flash read-back comparison failed' });
            throw new CmsisDapFlashError('VerifyFailed', `Flash read-back mismatch at 0x${range.address.toString(16)}`);
          }
          report({ operation: 'verify', address: range.address, size: range.bytes.length, elapsedMs, ok: true, message: 'complete Flash read-back comparison passed' });
        }
      }
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      // An operation with unknown completion must not be followed by another
      // algorithm call that could obscure the target state.
      if (!skipUninit) {
        try {
          await run('uninit', target.flashBase, 0);
        } catch (error) {
          // Preserve the original operation failure when completion was known;
          // a successful main flow must still fail if UnInit cannot return.
          if (primaryError === undefined) throw error;
        }
      }
    }
    return {
      success: true,
      message: `CMSIS-DAP Flash successful: ${path.basename(elfPath)}`,
      reports,
      erasedSectors,
      target,
      algorithmPath: algorithm.path,
      diagnostics: { deviceIdcode, flashSizeKiB, dpIdcode: dp.value, algorithmSource: algorithm.source, ramLayout: layout },
    };
  } catch (error) {
    return failed(error);
  }
}
