import {
  RttControlBlockAddress,
  RttTransportError,
  RttTransportResult,
  rttFailure,
  rttSuccess,
} from './rtt-transport';

export interface RttSymbolCandidate {
  readonly name: string;
  readonly address: number;
  readonly size?: number;
}

export interface RttMemoryRange {
  readonly start: number;
  /** Exclusive end address. */
  readonly end: number;
}

export interface RttAutoSearchOptions {
  readonly ranges: readonly RttMemoryRange[];
  readonly maxBytes: number;
  readonly chunkSize?: number;
  readonly alignment?: number;
}

export interface RttControlBlockResolverOptions {
  readonly explicitAddress?: number;
  readonly symbols?: readonly RttSymbolCandidate[];
  readonly symbolNames?: readonly string[];
  readonly autoSearch?: RttAutoSearchOptions;
  readonly readMemory?: (address: number, size: number) => Promise<Uint8Array | null>;
}

const DEFAULT_SYMBOL_NAMES = ['_SEGGER_RTT', 'SEGGER_RTT'];
const RTT_SIGNATURE = Uint8Array.from(Buffer.from('SEGGER RTT', 'ascii'));
const MAX_AUTO_SEARCH_BYTES = 16 * 1024 * 1024;
const MAX_AUTO_SEARCH_CHUNK = 64 * 1024;

/**
 * Resolves a SEGGER RTT Control Block without performing an unbounded RAM scan.
 * Explicit address and ELF symbols are deterministic; auto-search requires
 * caller-supplied, bounded memory ranges and a read callback.
 */
export class RttControlBlockResolver {
  constructor(private readonly options: RttControlBlockResolverOptions) {}

  async resolve(): Promise<RttTransportResult<RttControlBlockAddress>> {
    if (this.options.explicitAddress !== undefined) {
      const address = normalizeAddress(this.options.explicitAddress);
      if (address === null) return this.invalid('explicit Control Block address is invalid', { address: this.options.explicitAddress });
      return rttSuccess({ address, source: 'explicit' });
    }

    const symbols = this.options.symbols || [];
    const symbolNames = this.options.symbolNames || DEFAULT_SYMBOL_NAMES;
    const symbol = symbols.find(candidate => symbolNames.includes(candidate.name));
    if (symbol) {
      const address = normalizeAddress(symbol.address);
      if (address === null) return this.invalid(`ELF symbol ${symbol.name} has an invalid address`, { symbol: symbol.name, address: symbol.address });
      return rttSuccess({ address, source: 'elf-symbol', symbol: symbol.name });
    }

    if (!this.options.autoSearch) {
      return rttFailure(new RttTransportError(
        'ControlBlockNotFound',
        `RTT Control Block symbol not found (${symbolNames.join(', ')}) and auto-search is not configured`,
        'protocol',
        { symbolNames },
      ));
    }
    return this.autoSearch(this.options.autoSearch);
  }

  private async autoSearch(search: RttAutoSearchOptions): Promise<RttTransportResult<RttControlBlockAddress>> {
    if (!this.options.readMemory) {
      return this.invalid('RTT Control Block auto-search requires a target memory reader');
    }
    if (!Number.isInteger(search.maxBytes) || search.maxBytes <= 0 || search.maxBytes > MAX_AUTO_SEARCH_BYTES) {
      return this.invalid(`RTT Control Block auto-search maxBytes must be within 1..${MAX_AUTO_SEARCH_BYTES}`, {
        maxBytes: search.maxBytes,
      });
    }
    const chunkSize = search.chunkSize || 4096;
    const alignment = search.alignment || 4;
    if (!Number.isInteger(chunkSize) || chunkSize <= 0 || chunkSize > MAX_AUTO_SEARCH_CHUNK) {
      return this.invalid(`RTT Control Block auto-search chunkSize must be within 1..${MAX_AUTO_SEARCH_CHUNK}`, { chunkSize });
    }
    if (!Number.isInteger(alignment) || alignment <= 0 || alignment > 256) {
      return this.invalid('RTT Control Block auto-search alignment must be within 1..256', { alignment });
    }
    if (search.ranges.length === 0) return this.invalid('RTT Control Block auto-search requires at least one memory range');

    let scannedBytes = 0;
    for (const range of search.ranges) {
      const validation = validateRange(range);
      if (validation) return this.invalid(validation, { range });
      let address = range.start;
      let carry = new Uint8Array();
      while (address < range.end && scannedBytes < search.maxBytes) {
        const requested = Math.min(chunkSize, range.end - address, search.maxBytes - scannedBytes);
        const bytes = await this.options.readMemory(address, requested);
        if (!bytes) {
          return rttFailure(new RttTransportError(
            'ReadFailed',
            `RTT Control Block auto-search could not read 0x${address.toString(16)}`,
            'read',
            { address, requested, scannedBytes },
          ));
        }
        if (bytes.length === 0) {
          return rttFailure(new RttTransportError(
            'ReadFailed',
            `RTT Control Block auto-search received an empty memory response at 0x${address.toString(16)}`,
            'read',
            { address, requested, scannedBytes },
          ));
        }

        const combined = new Uint8Array(carry.length + bytes.length);
        combined.set(carry, 0);
        combined.set(bytes, carry.length);
        const combinedBase = address - carry.length;
        const found = findSignature(combined, alignment, combinedBase);
        if (found !== null) return rttSuccess({ address: found, source: 'auto-search' });

        const carryLength = Math.min(RTT_SIGNATURE.length - 1, combined.length);
        carry = combined.slice(combined.length - carryLength);
        address += bytes.length;
        scannedBytes += bytes.length;
        if (bytes.length < requested) break;
      }
    }

    return rttFailure(new RttTransportError(
      'ControlBlockNotFound',
      'RTT Control Block signature was not found in the bounded search ranges',
      'protocol',
      { scannedBytes, maxBytes: search.maxBytes, ranges: search.ranges },
    ));
  }

  private invalid(message: string, diagnostics: Readonly<Record<string, unknown>> = {}) {
    return rttFailure(new RttTransportError('InvalidArgument', message, 'protocol', diagnostics));
  }
}

function normalizeAddress(value: number): number | null {
  if (!Number.isInteger(value) || value <= 0 || value > 0xFFFFFFFF) return null;
  return value >>> 0;
}

function validateRange(range: RttMemoryRange): string | undefined {
  if (!Number.isInteger(range.start) || !Number.isInteger(range.end)) return 'RTT auto-search range addresses must be integers';
  if (range.start < 0 || range.end <= range.start || range.end > 0x100000000) return 'RTT auto-search range is invalid';
  return undefined;
}

function findSignature(bytes: Uint8Array, alignment: number, baseAddress: number): number | null {
  for (let index = 0; index <= bytes.length - RTT_SIGNATURE.length; index++) {
    const address = baseAddress + index;
    if (address % alignment !== 0) continue;
    let matches = true;
    for (let offset = 0; offset < RTT_SIGNATURE.length; offset++) {
      if (bytes[index + offset] !== RTT_SIGNATURE[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) return address >>> 0;
  }
  return null;
}
