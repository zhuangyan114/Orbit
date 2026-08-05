import * as fs from 'fs';
import * as path from 'path';

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

export interface FlashTargetDefinition {
  readonly name: string;
  readonly deviceId: number;
  readonly dpIdcode: number;
  readonly flashBase: number;
  readonly flashSize: number;
  readonly sramBase: number;
  readonly sramSize: number;
  readonly sectors: readonly FlashSector[];
}

export const STM32F407VET6: FlashTargetDefinition = Object.freeze({
  name: 'STM32F407VET6',
  deviceId: 0x413,
  dpIdcode: 0x2BA01477,
  flashBase: 0x08000000,
  flashSize: 512 * 1024,
  // The normal SRAM window used by the loader. CCM RAM is deliberately not
  // selected because it is not accessible by every debug/loader path.
  sramBase: 0x20000000,
  sramSize: 128 * 1024,
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
});

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

function validateSegmentTarget(segment: Elf32LoadSegment, target: FlashTargetDefinition): void {
  if (segment.memorySize === 0) return;
  if (isInRange(segment.address, segment.memorySize, target.flashBase, target.flashSize)) return;
  if (isInRange(segment.address, segment.memorySize, target.sramBase, target.sramSize)) return;
  throw new CmsisDapFlashError(
    'TargetMismatch',
    `ELF PT_LOAD at 0x${segment.address.toString(16)} is outside STM32F407VET6 Flash and SRAM`,
    { address: segment.address, size: segment.memorySize },
  );
}

export function calculateEraseSectors(
  segments: readonly Elf32LoadSegment[],
  target: FlashTargetDefinition = STM32F407VET6,
): FlashSector[] {
  const selected = new Map<number, FlashSector>();
  for (const segment of segments) {
    validateSegmentTarget(segment, target);
    if (segment.fileSize === 0) continue;
    if (!isInRange(segment.loadAddress, segment.fileSize, target.flashBase, target.flashSize)) {
      if (isInRange(segment.loadAddress, segment.fileSize, target.sramBase, target.sramSize)) continue;
      throw new CmsisDapFlashError(
        'TargetMismatch',
        `ELF load bytes at 0x${segment.loadAddress.toString(16)} are outside STM32F407VET6 Flash and SRAM`,
        { address: segment.loadAddress, size: segment.fileSize },
      );
    }
    const end = segment.loadAddress + segment.fileSize;
    for (const sector of target.sectors) {
      if (segment.loadAddress < sector.address + sector.size && end > sector.address) selected.set(sector.number, sector);
    }
  }
  return [...selected.values()].sort((a, b) => a.number - b.number);
}

export interface RamRegion {
  address: number;
  size: number;
}

export interface FlashRamLayout {
  algorithm: RamRegion;
  pageBuffer: RamRegion;
  stack: RamRegion;
  stackPointer: number;
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
  const algorithmAddress = target.sramBase;
  const pageBufferAddress = alignUp(algorithmAddress + algorithmSize, 4);
  const stackAddress = target.sramBase + target.sramSize - stackSize;
  if (pageBufferAddress + pageBufferSize > stackAddress || stackAddress < target.sramBase) {
    fail('Flash Algorithm regions do not fit inside target SRAM');
  }
  return {
    algorithm: { address: algorithmAddress, size: algorithmSize },
    pageBuffer: { address: pageBufferAddress, size: pageBufferSize },
    stack: { address: stackAddress, size: stackSize },
    stackPointer: stackAddress + stackSize,
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

const BUILTIN_ENTRIES: FlashAlgorithmEntries = {
  init: 0x000,
  uninit: 0x100,
  eraseSector: 0x200,
  programPage: 0x300,
  verify: 0x400,
  bkpt: 0x500,
};

export function defaultFlashAlgorithmPath(): string {
  const relative = path.join('out', 'native', 'win32-x64', 'orbit-stm32f407-flash-algorithm.bin');
  const candidates = [
    path.resolve(__dirname, '..', relative),
    path.resolve(__dirname, '..', '..', relative),
    path.resolve(process.cwd(), relative),
  ];
  return candidates.find(candidate => fs.existsSync(candidate)) || candidates[0];
}

export function loadFlashAlgorithm(explicitPath?: string): FlashAlgorithmImage {
  const candidate = explicitPath || defaultFlashAlgorithmPath();
  if (!fs.existsSync(candidate)) {
    throw new CmsisDapFlashError(
      'FlashAlgorithmUnavailable',
      `CMSIS-Pack/RAM Flash Algorithm is unavailable: ${candidate}`,
      { path: candidate },
    );
  }
  let binaryPath = candidate;
  let entries = BUILTIN_ENTRIES;
  let staticBase = 0;
  // The built-in algorithm accepts up to 64 KiB per ProgramPage. A 16 KiB
  // buffer matches STM32F4's smallest erase sector and avoids paying the
  // CMSIS-DAP register/RAM-upload overhead once per 1 KiB slice. User
  // supplied images retain the conservative 1 KiB default unless their
  // manifest declares a different page size.
  let pageSize = explicitPath ? 1024 : 0x4000;
  let preservesPageBuffer = !explicitPath;
  let source: FlashAlgorithmImage['source'] = explicitPath ? 'user-provided' : 'built-in';
  if (candidate.toLowerCase().endsWith('.json')) {
    let manifest: {
      binary?: string;
      entries?: Partial<FlashAlgorithmEntries> & { verify?: number | null };
      staticBase?: number;
      pageSize?: number;
      preservesPageBuffer?: boolean;
    };
    try {
      manifest = JSON.parse(fs.readFileSync(candidate, 'utf8')) as typeof manifest;
    } catch (error) {
      throw new CmsisDapFlashError('FlashAlgorithmUnavailable', `Flash Algorithm manifest is invalid: ${String(error)}`);
    }
    if (!manifest.binary) throw new CmsisDapFlashError('FlashAlgorithmUnavailable', 'Flash Algorithm manifest has no binary');
    binaryPath = path.resolve(path.dirname(candidate), manifest.binary);
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

export function validateTargetDeviceName(device: string, target: FlashTargetDefinition = STM32F407VET6): void {
  const normalized = device.trim().toUpperCase();
  // STM32F407VE is the common density/package prefix used by project files;
  // it is accepted only as the unqualified name of this exact 512 KiB target.
  const isV407VeAlias = target.name === STM32F407VET6.name && normalized === 'STM32F407VE';
  if (normalized !== target.name && !isV407VeAlias) {
    throw new CmsisDapFlashError('TargetMismatch', `CMSIS-DAP DAP-02A only supports ${target.name}, received ${device}`);
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

export async function flashCmsisDapElf(
  transport: CmsisDapFlashTransport,
  elfPath: string,
  device: string,
  options: CmsisDapFlashOptions = {},
  target: FlashTargetDefinition = STM32F407VET6,
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
    const flashSegments = segments.filter(segment => segment.fileSize > 0 && segment.loadAddress >= target.flashBase
      && segment.loadAddress + segment.fileSize <= target.flashBase + target.flashSize);
    const algorithm = loadFlashAlgorithm(options.algorithmPath);
    const pageSize = options.pageSize || algorithm.pageSize;
    const pageBufferSize = options.pageBufferSize || pageSize;
    if (pageBufferSize < pageSize) {
      throw new CmsisDapFlashError(
        'InvalidConfiguration',
        `Flash Algorithm page buffer (${pageBufferSize} bytes) is smaller than its page size (${pageSize} bytes)`,
      );
    }
    const layout = planFlashRamLayout(target, algorithm.code.length, pageBufferSize, options.stackSize);
    const timeoutMs = options.timeoutMs ?? 5000;
    const clockHz = options.clockHz ?? 4000000;
    let skipUninit = false;

    const dp = await transport.readDp(0);
    if (!dp.ok || dp.value === undefined) throwReadFailure('SW-DP IDCODE preflight', dp);
    if ((dp.value >>> 0) !== target.dpIdcode) {
      throw new CmsisDapFlashError('TargetMismatch',
        `SW-DP IDCODE mismatch: expected 0x${target.dpIdcode.toString(16)}, got 0x${(dp.value >>> 0).toString(16)}`,
        { expected: target.dpIdcode, actual: dp.value >>> 0 });
    }
    const idcode = await transport.readMemory(0xE0042000, 4);
    if (!idcode.ok || !idcode.bytes) throwReadFailure('DBGMCU_IDCODE preflight', idcode);
    const deviceIdcode = readLe32(asBytes(idcode.bytes));
    if ((deviceIdcode & 0xFFF) !== target.deviceId) {
      throw new CmsisDapFlashError('TargetMismatch',
        `DBGMCU_IDCODE mismatch: expected device ID 0x${target.deviceId.toString(16)}, got 0x${(deviceIdcode & 0xFFF).toString(16)}`,
        { expected: target.deviceId, actual: deviceIdcode });
    }
    const flashSize = await transport.readMemory(0x1FFF7A22, 2);
    if (!flashSize.ok || !flashSize.bytes) throwReadFailure('Flash size preflight', flashSize);
    const flashSizeKiB = readLe16(asBytes(flashSize.bytes));
    if (flashSizeKiB !== target.flashSize / 1024) {
      throw new CmsisDapFlashError('TargetMismatch',
        `Flash capacity mismatch: expected ${target.flashSize / 1024} KiB, got ${flashSizeKiB} KiB`,
        { expectedKiB: target.flashSize / 1024, actualKiB: flashSizeKiB });
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
        timeoutMs,
        reusePageBuffer,
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
      for (const segment of flashSegments) {
        for (let offset = 0; offset < segment.fileSize; offset += pageSize) {
          const size = Math.min(pageSize, segment.fileSize - offset);
          const page = segment.bytes.slice(offset, offset + size);
          await run('programPage', segment.loadAddress + offset, size, page);
          if (algorithm.preservesPageBuffer && algorithm.entries.verify !== undefined) {
            await run('verify', segment.loadAddress + offset, size, page, true);
          }
        }
      }
      const verificationAlreadyComplete = algorithm.preservesPageBuffer
        && algorithm.entries.verify !== undefined;
      for (const segment of flashSegments) {
        if (verificationAlreadyComplete) continue;
        if (algorithm.entries.verify !== undefined) {
          for (let offset = 0; offset < segment.fileSize; offset += pageSize) {
            const size = Math.min(pageSize, segment.fileSize - offset);
            await run(
              'verify',
              segment.loadAddress + offset,
              size,
              segment.bytes.slice(offset, offset + size),
            );
          }
          continue;
        }
        const started = Date.now();
        const read = await transport.readMemory(segment.loadAddress, segment.fileSize);
        const actual = asBytes(read.bytes);
        let mismatch = !read.ok || actual.length !== segment.fileSize;
        if (!mismatch) {
          for (let index = 0; index < segment.fileSize; index += 1) {
            if (actual[index] !== segment.bytes[index]) { mismatch = true; break; }
          }
        }
        const elapsedMs = Date.now() - started;
        if (mismatch) {
          report({ operation: 'verify', address: segment.loadAddress, size: segment.fileSize, elapsedMs, ok: false, errorCode: 'VerifyFailed', message: 'complete Flash read-back comparison failed' });
          throw new CmsisDapFlashError('VerifyFailed', `Flash read-back mismatch at 0x${segment.loadAddress.toString(16)}`);
        }
        report({ operation: 'verify', address: segment.loadAddress, size: segment.fileSize, elapsedMs, ok: true, message: 'complete Flash read-back comparison passed' });
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
