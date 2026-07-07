import * as fs from 'fs';

const TOKENIZER_ENTRY_MAGIC = 0xBAA98DEE;

export interface PRtLogTokenLoadResult {
  ok: boolean;
  count: number;
  error?: string;
}

export class PRtLogDecoder {
  private tokenDb = new Map<number, string>();
  private carry: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private messageCount = 0;

  resetFrames(): void {
    this.carry = Buffer.alloc(0);
    this.messageCount = 0;
  }

  loadTokenDatabase(elfPath: string): PRtLogTokenLoadResult {
    this.tokenDb.clear();
    this.resetFrames();

    if (!elfPath) {
      return { ok: false, count: 0, error: 'ELF path is empty' };
    }

    try {
      const elf = fs.readFileSync(elfPath);
      const section = this.findSection(elf, '.pw_tokenizer.entries');
      this.parseTokenEntries(section || elf);
      if (this.tokenDb.size === 0) {
        return { ok: false, count: 0, error: '.pw_tokenizer.entries token database not found' };
      }
      return { ok: true, count: this.tokenDb.size };
    } catch (err: any) {
      return { ok: false, count: 0, error: err?.message || String(err) };
    }
  }

  feed(bytes: Buffer<ArrayBufferLike>): string[] {
    if (bytes.length === 0) return [];

    this.carry = this.carry.length > 0 ? Buffer.concat([this.carry, bytes]) : bytes;
    const lines: string[] = [];
    let offset = 0;

    while (offset + 2 <= this.carry.length) {
      const length = this.carry.readUInt16LE(offset);
      if (offset + 2 + length > this.carry.length) break;

      offset += 2;
      const frame = this.carry.subarray(offset, offset + length);
      offset += length;
      if (length > 0) {
        lines.push(this.decodeFrame(frame));
      }
    }

    this.carry = offset > 0 ? this.carry.subarray(offset) : this.carry;
    return lines;
  }

  flush(): string[] {
    if (this.carry.length === 0) return [];
    const text = `[P-RTLog] truncated frame: ${this.carry.toString('hex')}\r\n`;
    this.carry = Buffer.alloc(0);
    return [text];
  }

  private decodeFrame(frame: Buffer<ArrayBufferLike>): string {
    this.messageCount++;
    if (frame.length < 4) {
      return `[P-RTLog ${this.messageCount}] invalid frame (${frame.length} bytes)\r\n`;
    }

    const token = frame.readUInt32LE(0);
    const format = this.tokenDb.get(token);
    const args = frame.subarray(4);
    const tokenText = `0x${token.toString(16).toUpperCase().padStart(8, '0')}`;

    if (!format) {
      return `[P-RTLog ${this.messageCount}] unknown token ${tokenText} raw=${frame.toString('hex')}\r\n`;
    }

    const fields = this.parseTokenizedFields(format);
    const messageFormat = fields.msg || format;
    const formatted = this.formatPrintfMessage(messageFormat, args);
    const level = this.parseLevel(fields.level) || this.inferLevel(messageFormat);
    const prefix = this.colorizeLevel(level);
    const location = fields.file ? ` ${this.dim(`(${fields.file})`)}` : '';
    const moduleText = fields.module ? ` ${this.dim(`[${fields.module}]`)}` : '';
    const warning = formatted.warning ? ` ${this.dim(formatted.warning)}` : '';

    return `${prefix} ${formatted.text}${moduleText}${location}${warning}\r\n`;
  }

  private parseTokenizedFields(format: string): Record<string, string> {
    const fields: Record<string, string> = {};
    for (const part of format.split('■')) {
      if (!part) continue;
      const separator = part.indexOf('♦');
      if (separator <= 0) continue;
      fields[part.slice(0, separator)] = part.slice(separator + 1);
    }
    return fields;
  }

  private formatPrintfMessage(format: string, args: Buffer<ArrayBufferLike>): { text: string; warning?: string } {
    let offset = 0;
    let text = '';
    let warning = '';

    for (let i = 0; i < format.length; i++) {
      const ch = format[i];
      if (ch !== '%' || i + 1 >= format.length) {
        text += ch;
        continue;
      }

      if (format[i + 1] === '%') {
        text += '%';
        i++;
        continue;
      }

      const spec = this.readPrintfSpecifier(format, i);
      if (!spec) {
        text += ch;
        continue;
      }

      const decoded = this.decodeArgument(spec.conversion, args, offset);
      if (!decoded.ok) {
        text += `%${spec.raw}`;
        warning = warning || `[decode stopped: ${decoded.error}]`;
      } else {
        text += decoded.value;
        offset = decoded.nextOffset;
      }
      i = spec.endIndex;
    }

    if (offset < args.length) {
      warning = warning || `[${args.length - offset} trailing arg byte(s): ${args.subarray(offset).toString('hex')}]`;
    }

    return { text, warning };
  }

  private readPrintfSpecifier(format: string, percentIndex: number): { raw: string; conversion: string; endIndex: number } | null {
    let i = percentIndex + 1;
    while (i < format.length && /[-+ #0]/.test(format[i])) i++;
    while (i < format.length && /[0-9]/.test(format[i])) i++;
    if (format[i] === '.') {
      i++;
      while (i < format.length && /[0-9]/.test(format[i])) i++;
    }
    while (i < format.length && /[hljztL]/.test(format[i])) i++;
    if (i >= format.length) return null;
    return {
      raw: format.slice(percentIndex + 1, i + 1),
      conversion: format[i],
      endIndex: i,
    };
  }

  private decodeArgument(conversion: string, args: Buffer<ArrayBufferLike>, offset: number): { ok: true; value: string; nextOffset: number } | { ok: false; error: string } {
    if ('diuoxXc'.includes(conversion)) {
      const decoded = this.decodeVarint(args, offset);
      if (!decoded) return { ok: false, error: 'integer arg truncated' };
      const signed = this.zigZagDecode(decoded.value);
      const unsigned = BigInt.asUintN(32, signed);
      let value: string;
      switch (conversion) {
        case 'x':
          value = unsigned.toString(16);
          break;
        case 'X':
          value = unsigned.toString(16).toUpperCase();
          break;
        case 'o':
          value = unsigned.toString(8);
          break;
        case 'u':
          value = unsigned.toString(10);
          break;
        case 'c':
          value = String.fromCharCode(Number(signed & 0xFFn));
          break;
        default:
          value = signed.toString(10);
          break;
      }
      return { ok: true, value, nextOffset: decoded.nextOffset };
    }

    if ('fFeEgGaA'.includes(conversion)) {
      if (offset + 4 > args.length) return { ok: false, error: 'float arg truncated' };
      const value = args.readFloatLE(offset);
      return { ok: true, value: this.formatFloat(value, conversion), nextOffset: offset + 4 };
    }

    if (conversion === 's') {
      if (offset >= args.length) return { ok: false, error: 'string arg truncated' };
      const lengthAndStatus = args[offset];
      const length = lengthAndStatus & 0x7F;
      if (offset + 1 + length > args.length) return { ok: false, error: 'string arg truncated' };
      const suffix = (lengthAndStatus & 0x80) ? '...' : '';
      return {
        ok: true,
        value: args.subarray(offset + 1, offset + 1 + length).toString('utf8') + suffix,
        nextOffset: offset + 1 + length,
      };
    }

    if (conversion === 'p') {
      const decoded = this.decodeVarint(args, offset);
      if (!decoded) return { ok: false, error: 'pointer arg truncated' };
      const value = BigInt.asUintN(32, this.zigZagDecode(decoded.value));
      return { ok: true, value: `0x${value.toString(16).toUpperCase()}`, nextOffset: decoded.nextOffset };
    }

    return { ok: false, error: `unsupported %${conversion}` };
  }

  private decodeVarint(data: Buffer<ArrayBufferLike>, offset: number): { value: bigint; nextOffset: number } | null {
    let value = 0n;
    let shift = 0n;
    for (let i = offset; i < data.length && i < offset + 10; i++) {
      const byte = data[i];
      value |= BigInt(byte & 0x7F) << shift;
      if ((byte & 0x80) === 0) {
        return { value, nextOffset: i + 1 };
      }
      shift += 7n;
    }
    return null;
  }

  private zigZagDecode(value: bigint): bigint {
    return (value >> 1n) ^ (-(value & 1n));
  }

  private formatFloat(value: number, conversion: string): string {
    if (!Number.isFinite(value)) return String(value);
    switch (conversion) {
      case 'e':
        return value.toExponential(6);
      case 'E':
        return value.toExponential(6).toUpperCase();
      case 'g':
      case 'G':
        return value.toPrecision(6);
      default:
        return value.toFixed(6);
    }
  }

  private inferLevel(message: string): 'I' | 'W' | 'E' {
    if (/^\s*E[:\]]|\berror\b/i.test(message)) return 'E';
    if (/^\s*W[:\]]|\bwarn(?:ing)?\b/i.test(message)) return 'W';
    return 'I';
  }

  private parseLevel(level: string | undefined): 'I' | 'W' | 'E' | null {
    if (!level) return null;
    if (level === '2' || /^error$/i.test(level)) return 'E';
    if (level === '1' || /^warn(?:ing)?$/i.test(level)) return 'W';
    if (level === '0' || /^info$/i.test(level)) return 'I';
    return null;
  }

  private colorizeLevel(level: 'I' | 'W' | 'E'): string {
    if (level === 'E') return '\x1B[1;31mE:\x1B[0m';
    if (level === 'W') return '\x1B[1;33mW:\x1B[0m';
    return '\x1B[1;36mI:\x1B[0m';
  }

  private dim(text: string): string {
    return `\x1B[2m${text}\x1B[0m`;
  }

  private parseTokenEntries(data: Buffer<ArrayBufferLike>): void {
    let offset = this.findTokenEntryOffset(data, 0);

    while (offset + 16 <= data.length) {
      const magic = data.readUInt32LE(offset);
      const token = data.readUInt32LE(offset + 4);
      const domainLength = data.readUInt32LE(offset + 8);
      const stringLength = data.readUInt32LE(offset + 12);
      offset += 16;

      if (magic !== TOKENIZER_ENTRY_MAGIC) break;
      if (domainLength === 0 || stringLength === 0) break;
      if (offset + domainLength + stringLength > data.length) break;

      offset += domainLength;
      const formatBytes = data.subarray(offset, offset + stringLength - 1);
      offset += stringLength;

      this.tokenDb.set(token, formatBytes.toString('utf8'));
      offset = this.findTokenEntryOffset(data, offset);
    }
  }

  private findTokenEntryOffset(data: Buffer<ArrayBufferLike>, start: number): number {
    for (let offset = Math.max(0, start); offset + 16 <= data.length; offset++) {
      if (data.readUInt32LE(offset) !== TOKENIZER_ENTRY_MAGIC) continue;
      const domainLength = data.readUInt32LE(offset + 8);
      const stringLength = data.readUInt32LE(offset + 12);
      if (domainLength > 0 && stringLength > 0 && offset + 16 + domainLength + stringLength <= data.length) {
        return offset;
      }
    }
    return data.length;
  }

  private findSection(elf: Buffer<ArrayBufferLike>, sectionName: string): Buffer<ArrayBufferLike> | null {
    if (elf.length < 52 || elf[0] !== 0x7F || elf[1] !== 0x45 || elf[2] !== 0x4C || elf[3] !== 0x46) {
      return null;
    }
    if (elf[5] !== 1) {
      return null;
    }

    const elfClass = elf[4];
    const is64 = elfClass === 2;
    if (elfClass !== 1 && elfClass !== 2) {
      return null;
    }

    const sectionHeaderOffset = this.readElfOffset(elf, is64 ? 40 : 32, is64);
    const sectionHeaderEntrySize = elf.readUInt16LE(is64 ? 58 : 46);
    const sectionHeaderCount = elf.readUInt16LE(is64 ? 60 : 48);
    const sectionNameTableIndex = elf.readUInt16LE(is64 ? 62 : 50);
    if (!Number.isFinite(sectionHeaderOffset) || sectionHeaderCount <= 0 || sectionNameTableIndex >= sectionHeaderCount) {
      return null;
    }

    const stringTable = this.readSectionByIndex(elf, sectionHeaderOffset, sectionHeaderEntrySize, sectionNameTableIndex, is64);
    if (!stringTable) {
      return null;
    }

    for (let i = 0; i < sectionHeaderCount; i++) {
      const headerOffset = sectionHeaderOffset + i * sectionHeaderEntrySize;
      if (headerOffset + sectionHeaderEntrySize > elf.length) break;

      const nameOffset = elf.readUInt32LE(headerOffset);
      const name = this.readCString(stringTable, nameOffset);
      if (name !== sectionName) continue;

      const offset = this.readElfOffset(elf, headerOffset + (is64 ? 24 : 16), is64);
      const size = this.readElfOffset(elf, headerOffset + (is64 ? 32 : 20), is64);
      if (offset < 0 || size < 0 || offset + size > elf.length) {
        return null;
      }
      return elf.subarray(offset, offset + size);
    }

    return null;
  }

  private readSectionByIndex(elf: Buffer<ArrayBufferLike>, sectionHeaderOffset: number, sectionHeaderEntrySize: number, index: number, is64: boolean): Buffer<ArrayBufferLike> | null {
    const headerOffset = sectionHeaderOffset + index * sectionHeaderEntrySize;
    if (headerOffset + sectionHeaderEntrySize > elf.length) return null;

    const offset = this.readElfOffset(elf, headerOffset + (is64 ? 24 : 16), is64);
    const size = this.readElfOffset(elf, headerOffset + (is64 ? 32 : 20), is64);
    if (offset < 0 || size < 0 || offset + size > elf.length) return null;
    return elf.subarray(offset, offset + size);
  }

  private readElfOffset(elf: Buffer<ArrayBufferLike>, offset: number, is64: boolean): number {
    return is64 ? Number(elf.readBigUInt64LE(offset)) : elf.readUInt32LE(offset);
  }

  private readCString(data: Buffer<ArrayBufferLike>, offset: number): string {
    if (offset < 0 || offset >= data.length) return '';
    let end = offset;
    while (end < data.length && data[end] !== 0) end++;
    return data.subarray(offset, end).toString('utf8');
  }
}
