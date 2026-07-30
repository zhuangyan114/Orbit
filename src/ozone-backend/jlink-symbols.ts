import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { log } from '../utils/logger';

function findArmTool(toolName: string): string {
  const pathDirs = (process.env.Path || process.env.PATH || '').split(';');
  for (const dir of pathDirs) {
    const p = path.join(dir, toolName);
    if (fs.existsSync(p)) return p;
  }

  const baseDirs = [
    'C:\\CLionToolchains',
    'C:\\Program Files (x86)\\GNU Arm Embedded Toolchain',
    'C:\\Program Files\\GNU Arm Embedded Toolchain',
    'C:\\SysGCC\\arm-eabi',
    'C:\\Program Files (x86)\\GNU Tools ARM Embedded',
  ];
  for (const base of baseDirs) {
    if (!fs.existsSync(base)) continue;
    try {
      const dirs = fs.readdirSync(base);
      for (const dir of dirs) {
        const binDir = path.join(base, dir, 'bin');
        const p = path.join(binDir, toolName);
        if (fs.existsSync(p)) return p;
      }
    } catch { }
  }

  return toolName;
}

export const NM_EXE = findArmTool('arm-none-eabi-nm.exe');
export const OBJDUMP_EXE = findArmTool('arm-none-eabi-objdump.exe');
export const ADDR2LINE_EXE = findArmTool('arm-none-eabi-addr2line.exe');

export interface SymbolInfo {
  name: string;
  address: number;
  size: number;
  type: string;
}

export function readElfSymbols(elfPath: string): Promise<SymbolInfo[]> {
  return new Promise((resolve) => {
    execFile(NM_EXE, [
      '--defined-only', '-S', '-C', '-p', elfPath,
    ], {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30000,
      windowsHide: true,
    }, (error, stdout) => {
      if (error) {
        log.eval('readElfSymbols error: ' + error);
        resolve([]);
        return;
      }
      const symbols: SymbolInfo[] = [];
      for (const line of stdout.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const parts = trimmed.split(/\s+/);
        if (parts.length < 3) continue;
        const address = parseInt(parts[0], 16);
        if (isNaN(address)) continue;
        let name: string;
        let size = 0;
        let type: string;
        if (parts.length >= 4 && /^[0-9a-fA-F]+$/.test(parts[1]) && /^[A-Za-z]$/.test(parts[2])) {
          type = parts[2];
          size = parseInt(parts[1], 16);
          name = parts.slice(3).join(' ');
        } else {
          type = parts[1] || '?';
          name = parts.slice(2).join(' ');
        }
        symbols.push({ name, address, size, type });
      }
      resolve(symbols);
    });
  });
}

export function findSymbol(symbols: SymbolInfo[], name: string): SymbolInfo | undefined {
  return symbols.find(s => s.name === name);
}

export function findSymbolsByPrefix(symbols: SymbolInfo[], prefix: string): SymbolInfo[] {
  return symbols.filter(s => s.name.startsWith(prefix));
}



export interface DwarfField {
  name: string;
  typeOffset: string;
  byteOffset: number;
}

export interface DwarfRange {
  start: number;
  end: number;
}

export interface DwarfLocationEntry extends DwarfRange {
  expression: string;
}

export interface DwarfLocation {
  expression?: string;
  listOffset?: number;
}

export interface DwarfVariableInfo {
  name: string;
  typeOffset: string;
  location?: DwarfLocation;
  parameter: boolean;
  declarationLine?: number;
}

export interface DwarfLexicalScope {
  ranges: DwarfRange[];
  variables: DwarfVariableInfo[];
  children: DwarfLexicalScope[];
}

export interface DwarfSubprogramInfo extends DwarfLexicalScope {
  name: string;
  frameBase?: DwarfLocation;
}

export interface DwarfRegisterRule {
  kind: 'same' | 'undefined' | 'cfaOffset' | 'register';
  value?: number;
}

export interface DwarfCallFrameRow {
  pc: number;
  cfaRegister: number;
  cfaOffset: number;
  registerRules: Map<number, DwarfRegisterRule>;
}

export interface DwarfCallFrameInfo extends DwarfRange {
  rows: DwarfCallFrameRow[];
}

export interface DwarfTypeInfo {
  name: string;
  byteSize: number;
  kind: 'struct' | 'union' | 'typedef' | 'base' | 'pointer' | 'array' | 'enum' | 'const' | 'volatile' | 'restrict' | 'unspecified';
  fields?: DwarfField[];
  typeOffset?: string;
  arrayCount?: number;
  arrayLowerBound?: number;
  encoding?: string;
  enumerators?: Map<number, string>;
}

export interface DwarfInfo {
  varToType: Map<string, string>;
  typeDefs: Map<string, DwarfTypeInfo>;
  subprograms: DwarfSubprogramInfo[];
  locationLists: Map<number, DwarfLocationEntry[]>;
  callFrames: DwarfCallFrameInfo[];
  _diag?: string;
}

interface ParsedDwarfDie {
  offset: string;
  tag: string;
  depth: number;
  attrs: Record<string, string>;
  children: ParsedDwarfDie[];
}

function parseDwarfOutput(stdout: string): { dies: ParsedDwarfDie[]; errors: string[] } {
  const dies: ParsedDwarfDie[] = [];
  const errors: string[] = [];
  const stack: ParsedDwarfDie[] = [];

  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trimEnd();
    const depthMatch = line.match(/^\s*<(\d+)><([0-9a-fA-F]+)>:\s+Abbrev Number:\s+\d+\s+\((.+)\)/);
    if (depthMatch) {
      const depth = parseInt(depthMatch[1]);
      const offset = depthMatch[2];
      const tag = depthMatch[3];
      const die: ParsedDwarfDie = { offset: `0x${offset.toLowerCase()}`, tag, depth, attrs: {}, children: [] };
      while (stack.length > 0 && stack[stack.length - 1].depth >= depth) stack.pop();
      if (stack.length > 0) stack[stack.length - 1].children.push(die);
      else dies.push(die);
      stack.push(die);
      continue;
    }

    if (stack.length === 0) continue;

    const current = stack[stack.length - 1];
    const attrMatch = line.match(/^\s+<[0-9a-fA-F]+>\s+(DW_AT_\w+)\s*:\s*(.+)/);
    if (attrMatch) {
      const attrName = attrMatch[1];
      let attrValue = attrMatch[2].trim();
      const indirectMatch = attrValue.match(/^\(indirect string, offset: 0x[0-9a-fA-F]+\):\s*(.+)$/);
      if (indirectMatch) {
        attrValue = indirectMatch[1];
      } else if (attrValue.startsWith('<') && attrValue.includes('>')) {
        const refMatch = attrValue.match(/<0x([0-9a-fA-F]+)>/);
        if (refMatch) attrValue = `0x${refMatch[1].toLowerCase()}`;
      } else {
        const quoteMatch = attrValue.match(/^"(.+)"\s*(?:\(.+\))?$/);
        if (quoteMatch) attrValue = quoteMatch[1];
      }
      current.attrs[attrName] = attrValue;
    }
  }
  return { dies, errors };
}

function resolveType(offset: string, typeDefs: Map<string, DwarfTypeInfo>, visited: Set<string> = new Set()): DwarfTypeInfo | null {
  if (visited.has(offset)) return null;
  visited.add(offset);
  const info = typeDefs.get(offset);
  if (!info) return null;
  if ((info.kind === 'typedef' || info.kind === 'const' || info.kind === 'volatile' || info.kind === 'restrict') && info.typeOffset) {
    return resolveType(info.typeOffset, typeDefs, visited) || info;
  }
  if (info.kind === 'pointer') return info;
  return info;
}

export type DwarfSectionLoader = (mode: 'info' | 'Ranges' | 'loc' | 'frames-interp') => Promise<string>;

export async function parseDwarfTypeInfo(elfPath: string, sectionLoader?: DwarfSectionLoader): Promise<DwarfInfo> {
  const varToType = new Map<string, string>();
  const typeDefs = new Map<string, DwarfTypeInfo>();
  const subprograms: DwarfSubprogramInfo[] = [];
  const diagParts: string[] = [];
  const empty = (): DwarfInfo => ({
    varToType, typeDefs, subprograms,
    locationLists: new Map(), callFrames: [],
    _diag: diagParts.join(' | '),
  });

  const runObjdump = (mode: 'info' | 'Ranges' | 'loc' | 'frames-interp'): Promise<string> => sectionLoader
    ? sectionLoader(mode)
    : new Promise(resolve => {
    execFile(OBJDUMP_EXE, [`--dwarf=${mode}`, elfPath], {
      maxBuffer: 100 * 1024 * 1024,
      timeout: 30000,
      windowsHide: true,
    }, (error, stdout) => {
      if (error && !stdout) {
        log.eval(`readDwarf ${mode} error: ${error}`);
        resolve('');
      } else {
        resolve(stdout || '');
      }
    });
      });

  try {
    const [stdout, rangesStdout, locationsStdout, framesStdout] = await Promise.all([
      runObjdump('info'), runObjdump('Ranges'), runObjdump('loc'), runObjdump('frames-interp'),
    ]);

    if (!stdout) {
      diagParts.push('stdout empty');
      return empty();
    }

    diagParts.push(`len=${stdout.length}, dwTagCount=${(stdout.match(/\(DW_TAG_\w+\)/g) || []).length}`);

    const { dies } = parseDwarfOutput(stdout);
    diagParts.push(`dies=${dies.length}`);
    const rangeLists = parseDwarfRangeLists(rangesStdout);
    const locationLists = parseDwarfLocationLists(locationsStdout);
    const callFrames = parseDwarfCallFrames(framesStdout);
    function visitDie(die: ParsedDwarfDie, collect: (d: ParsedDwarfDie) => void) {
      collect(die);
      for (const child of die.children) visitDie(child, collect);
    }

    const allDies: ParsedDwarfDie[] = [];
    for (const d of dies) visitDie(d, d2 => allDies.push(d2));
    const dieByOffset = new Map(allDies.map(die => [die.offset, die]));
    const inheritedAttrs = (die: ParsedDwarfDie): Record<string, string> => {
      const reference = die.attrs.DW_AT_abstract_origin || die.attrs.DW_AT_specification;
      const inherited = reference ? dieByOffset.get(reference) : undefined;
      return inherited ? { ...inherited.attrs, ...die.attrs } : die.attrs;
    };

    let nStruct = 0, nUnion = 0, nTypedef = 0, nBase = 0, nVar = 0;
    for (const d of allDies) {
      if (d.tag === 'DW_TAG_structure_type') nStruct++;
      else if (d.tag === 'DW_TAG_union_type') nUnion++;
      else if (d.tag === 'DW_TAG_typedef') nTypedef++;
      else if (d.tag === 'DW_TAG_base_type') nBase++;
      else if (d.tag === 'DW_TAG_variable') nVar++;
    }
    diagParts.push(`struct=${nStruct}, union=${nUnion}, typedef=${nTypedef}, base=${nBase}, var=${nVar}`);

    for (const die of allDies) {
      const attrs = inheritedAttrs(die);
      if (die.tag === 'DW_TAG_variable' && attrs.DW_AT_name && attrs.DW_AT_type) {
        varToType.set(attrs.DW_AT_name, attrs.DW_AT_type);
      }

      if (die.tag === 'DW_TAG_structure_type' || die.tag === 'DW_TAG_union_type') {
        const fields: DwarfField[] = [];
        for (const child of die.children) {
          const childAttrs = inheritedAttrs(child);
          if (child.tag === 'DW_TAG_member' && childAttrs.DW_AT_name) {
            fields.push({
              name: childAttrs.DW_AT_name,
              typeOffset: childAttrs.DW_AT_type || '',
              byteOffset: parseMemberOffset(childAttrs.DW_AT_data_member_location),
            });
          }
        }
        typeDefs.set(die.offset, {
          name: attrs.DW_AT_name || '',
          byteSize: parseDwarfNumber(attrs.DW_AT_byte_size) || 0,
          kind: die.tag === 'DW_TAG_structure_type' ? 'struct' : 'union',
          fields,
        });
      }

      if (die.tag === 'DW_TAG_typedef' && attrs.DW_AT_name) {
        typeDefs.set(die.offset, {
          name: attrs.DW_AT_name,
          byteSize: 0,
          kind: 'typedef',
          typeOffset: attrs.DW_AT_type,
        });
      }

      if (die.tag === 'DW_TAG_base_type' && attrs.DW_AT_name) {
        typeDefs.set(die.offset, {
          name: attrs.DW_AT_name,
          byteSize: parseDwarfNumber(attrs.DW_AT_byte_size) || 0,
          kind: 'base',
          encoding: attrs.DW_AT_encoding,
        });
      }

      if (die.tag === 'DW_TAG_pointer_type') {
        typeDefs.set(die.offset, {
          name: '',
          byteSize: parseDwarfNumber(attrs.DW_AT_byte_size) || 4,
          kind: 'pointer',
          typeOffset: attrs.DW_AT_type,
        });
      }

      if (die.tag === 'DW_TAG_const_type' || die.tag === 'DW_TAG_volatile_type' || die.tag === 'DW_TAG_restrict_type') {
        typeDefs.set(die.offset, {
          name: '',
          byteSize: 0,
          kind: die.tag === 'DW_TAG_const_type' ? 'const' : die.tag === 'DW_TAG_volatile_type' ? 'volatile' : 'restrict',
          typeOffset: attrs.DW_AT_type,
        });
      }

      if (die.tag === 'DW_TAG_array_type') {
        let arraySize = 1;
        let lowerBound = 0;
        let hasSubrange = false;
        for (const child of die.children) {
          if (child.tag === 'DW_TAG_subrange_type') {
            const childAttrs = inheritedAttrs(child);
            lowerBound = parseDwarfNumber(childAttrs.DW_AT_lower_bound) || 0;
            const count = parseDwarfNumber(childAttrs.DW_AT_count);
            const upper = parseDwarfNumber(childAttrs.DW_AT_upper_bound);
            const dimension = count ?? (upper === undefined ? 0 : upper - lowerBound + 1);
            if (dimension > 0) {
              hasSubrange = true;
              arraySize *= dimension;
            }
          }
        }
        typeDefs.set(die.offset, {
          name: '',
          byteSize: 0,
          kind: 'array',
          typeOffset: attrs.DW_AT_type,
          arrayCount: hasSubrange ? arraySize : 0,
          arrayLowerBound: lowerBound,
        });
      }

      if (die.tag === 'DW_TAG_enumeration_type') {
        const enumerators = new Map<number, string>();
        for (const child of die.children) {
          if (child.tag !== 'DW_TAG_enumerator') continue;
          const childAttrs = inheritedAttrs(child);
          const value = parseDwarfNumber(childAttrs.DW_AT_const_value);
          if (childAttrs.DW_AT_name && value !== undefined) enumerators.set(value, childAttrs.DW_AT_name);
        }
        typeDefs.set(die.offset, {
          name: attrs.DW_AT_name || '',
          byteSize: parseDwarfNumber(attrs.DW_AT_byte_size) || 4,
          kind: 'enum',
          encoding: attrs.DW_AT_encoding,
          enumerators,
        });
      }
    }

    const makeVariable = (die: ParsedDwarfDie): DwarfVariableInfo | undefined => {
      const attrs = inheritedAttrs(die);
      if (!attrs.DW_AT_name || !attrs.DW_AT_type) return undefined;
      return {
        name: attrs.DW_AT_name,
        typeOffset: attrs.DW_AT_type,
        location: parseLocation(attrs.DW_AT_location),
        parameter: die.tag === 'DW_TAG_formal_parameter',
        declarationLine: parseDwarfNumber(attrs.DW_AT_decl_line),
      };
    };
    const makeScope = (die: ParsedDwarfDie, inheritedRanges: DwarfRange[]): DwarfLexicalScope => {
      const ownRanges = rangesForDie(die, rangeLists);
      const scope: DwarfLexicalScope = {
        ranges: ownRanges.length > 0 ? ownRanges : inheritedRanges,
        variables: [],
        children: [],
      };
      for (const child of die.children) {
        if (child.tag === 'DW_TAG_variable' || child.tag === 'DW_TAG_formal_parameter') {
          const variable = makeVariable(child);
          if (variable) scope.variables.push(variable);
        } else if (child.tag === 'DW_TAG_lexical_block' || child.tag === 'DW_TAG_inlined_subroutine') {
          scope.children.push(makeScope(child, scope.ranges));
        }
      }
      return scope;
    };
    for (const die of allDies) {
      if (die.tag !== 'DW_TAG_subprogram') continue;
      const attrs = inheritedAttrs(die);
      const ranges = rangesForDie(die, rangeLists);
      if (!attrs.DW_AT_name || ranges.length === 0) continue;
      const scope = makeScope(die, ranges);
      subprograms.push({
        name: attrs.DW_AT_name,
        ranges,
        frameBase: parseLocation(attrs.DW_AT_frame_base),
        variables: scope.variables,
        children: scope.children,
      });
    }
    subprograms.sort((a, b) => a.ranges[0].start - b.ranges[0].start);
    diagParts.push(`subprograms=${subprograms.length}, loclists=${locationLists.size}, cfi=${callFrames.length}`);
    return { varToType, typeDefs, subprograms, locationLists, callFrames, _diag: diagParts.join(' | ') };
  } catch (e: any) {
    diagParts.push(`ERROR: ${e.message}`);
  }

  return empty();
}

export function getStructTypeName(typeDefs: Map<string, DwarfTypeInfo>, offset: string): string {
  const info = typeDefs.get(offset);
  if (!info) return '';
  if (info.kind === 'typedef' && info.typeOffset) {
    const resolved = resolveType(info.typeOffset, typeDefs);
    return resolved?.name || info.name;
  }
  return info.name;
}

function parseDwarfNumber(value?: string): number | undefined {
  if (!value) return undefined;
  const hex = value.match(/(?:^|\s)0x([0-9a-fA-F]+)/);
  if (hex) return parseInt(hex[1], 16);
  const decimal = value.match(/(?:^|:\s*)(-?\d+)(?:\s|$)/);
  if (decimal) return parseInt(decimal[1], 10);
  return undefined;
}

function parseMemberOffset(value?: string): number {
  if (!value) return 0;
  const plus = value.match(/DW_OP_plus_uconst:\s*(\d+)/);
  if (plus) return parseInt(plus[1], 10);
  return parseDwarfNumber(value) ?? 0;
}

function parseLocation(value?: string): DwarfLocation | undefined {
  if (!value) return undefined;
  const expressionStart = value.indexOf('(DW_OP');
  const expressionEnd = value.lastIndexOf(')');
  if (expressionStart >= 0 && expressionEnd > expressionStart) {
    return { expression: value.slice(expressionStart + 1, expressionEnd) };
  }
  if (/location list|loclist/i.test(value)) {
    const offset = parseDwarfNumber(value);
    if (offset !== undefined) return { listOffset: offset };
  }
  return undefined;
}

function rangesForDie(die: ParsedDwarfDie, rangeLists: Map<number, DwarfRange[]>): DwarfRange[] {
  const low = parseDwarfNumber(die.attrs.DW_AT_low_pc);
  const highRaw = parseDwarfNumber(die.attrs.DW_AT_high_pc);
  if (low !== undefined && highRaw !== undefined) {
    const high = highRaw <= low ? low + highRaw : highRaw;
    if (high > low) return [{ start: low, end: high }];
  }
  const rangesOffset = parseDwarfNumber(die.attrs.DW_AT_ranges);
  return rangesOffset === undefined ? [] : (rangeLists.get(rangesOffset) || []);
}

export function parseDwarfRangeLists(stdout: string): Map<number, DwarfRange[]> {
  const result = new Map<number, DwarfRange[]>();
  let entries: Array<{ offset: number; range: DwarfRange }> = [];
  let baseAddress = 0;
  const commit = () => {
    if (entries.length === 0) return;
    const ranges = entries.map(entry => entry.range);
    for (const entry of entries) result.set(entry.offset, ranges);
    entries = [];
    baseAddress = 0;
  };
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (/<End of list>/i.test(line)) {
      commit();
      continue;
    }
    const base = line.match(/^([0-9a-fA-F]+)\s+(?:<Base address>|base address)\s*:?\s*([0-9a-fA-Fx]+)/i);
    if (base) {
      baseAddress = parseInt(base[2].replace(/^0x/i, ''), 16);
      continue;
    }
    const match = line.match(/^([0-9a-fA-F]+)\s+([0-9a-fA-F]{1,16})\s+([0-9a-fA-F]{1,16})(?:\s|$)/);
    if (!match) continue;
    const offset = parseInt(match[1], 16);
    let start = parseInt(match[2], 16);
    let end = parseInt(match[3], 16);
    if (baseAddress && start < baseAddress && end <= 0x01000000) {
      start += baseAddress;
      end += baseAddress;
    }
    if (end > start) entries.push({ offset, range: { start, end } });
  }
  commit();
  return result;
}

export function parseDwarfLocationLists(stdout: string): Map<number, DwarfLocationEntry[]> {
  const result = new Map<number, DwarfLocationEntry[]>();
  let entries: Array<{ offset: number; entry: DwarfLocationEntry }> = [];
  const commit = () => {
    if (entries.length === 0) return;
    const list = entries.map(item => item.entry);
    for (const item of entries) result.set(item.offset, list);
    entries = [];
  };
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (/<End of list>/i.test(line)) {
      commit();
      continue;
    }
    const match = line.match(/^([0-9a-fA-F]+)\s+([0-9a-fA-F]{1,16})\s+([0-9a-fA-F]{1,16})\s+\((DW_OP.+)\)\s*$/);
    if (!match) continue;
    const start = parseInt(match[2], 16);
    const end = parseInt(match[3], 16);
    if (end > start) {
      entries.push({
        offset: parseInt(match[1], 16),
        entry: { start, end, expression: match[4] },
      });
    }
  }
  commit();
  return result;
}

function dwarfRegisterNumber(name: string): number | undefined {
  if (name === 'ra') return 14;
  const match = name.match(/^r(\d+)$/);
  return match ? parseInt(match[1], 10) : undefined;
}

export function parseDwarfCallFrames(stdout: string): DwarfCallFrameInfo[] {
  const frames: DwarfCallFrameInfo[] = [];
  let current: DwarfCallFrameInfo | null = null;
  let columns: string[] = [];
  for (const raw of stdout.split('\n')) {
    const fde = raw.match(/\bFDE\b.*\bpc=([0-9a-fA-F]+)\.\.([0-9a-fA-F]+)/);
    if (fde) {
      current = { start: parseInt(fde[1], 16), end: parseInt(fde[2], 16), rows: [] };
      frames.push(current);
      columns = [];
      continue;
    }
    if (!current) continue;
    const trimmed = raw.trim();
    if (/^LOC\s+CFA(?:\s|$)/.test(trimmed)) {
      columns = trimmed.split(/\s+/);
      continue;
    }
    if (columns.length < 2) continue;
    const values = trimmed.split(/\s+/);
    if (!/^[0-9a-fA-F]+$/.test(values[0] || '') || values.length < 2) continue;
    const cfa = values[1].match(/^r(\d+)([+-]\d+)$/);
    if (!cfa) continue;
    const rules = new Map<number, DwarfRegisterRule>();
    for (let index = 2; index < Math.min(columns.length, values.length); index++) {
      const register = dwarfRegisterNumber(columns[index]);
      if (register === undefined) continue;
      const value = values[index];
      if (value === 'u') rules.set(register, { kind: 'undefined' });
      else if (value === 's') rules.set(register, { kind: 'same' });
      else if (/^c[+-]\d+$/.test(value)) rules.set(register, { kind: 'cfaOffset', value: parseInt(value.slice(1), 10) });
      else if (/^r\d+$/.test(value)) rules.set(register, { kind: 'register', value: parseInt(value.slice(1), 10) });
    }
    current.rows.push({
      pc: parseInt(values[0], 16),
      cfaRegister: parseInt(cfa[1], 10),
      cfaOffset: parseInt(cfa[2], 10),
      registerRules: rules,
    });
  }
  return frames.filter(frame => frame.end > frame.start && frame.rows.length > 0);
}

export function findDwarfCallFrameRow(callFrames: DwarfCallFrameInfo[], pc: number): DwarfCallFrameRow | undefined {
  const frame = callFrames.find(candidate => pc >= candidate.start && pc < candidate.end);
  if (!frame) return undefined;
  let selected: DwarfCallFrameRow | undefined;
  for (const row of frame.rows) {
    if (row.pc > pc) break;
    selected = row;
  }
  return selected;
}

export function dwarfLocationExpressionAt(
  location: DwarfLocation | undefined,
  pc: number,
  locationLists: Map<number, DwarfLocationEntry[]>,
): string | undefined {
  if (location?.expression) return location.expression;
  if (location?.listOffset === undefined) return undefined;
  return locationLists.get(location.listOffset)?.find(entry => pc >= entry.start && pc < entry.end)?.expression;
}

export function dwarfRangeContains(ranges: DwarfRange[], pc: number): boolean {
  return ranges.some(range => pc >= range.start && pc < range.end);
}

export function findDwarfSubprogram(info: DwarfInfo, pc: number): DwarfSubprogramInfo | undefined {
  return info.subprograms.find(subprogram => dwarfRangeContains(subprogram.ranges, pc));
}

export function activeDwarfVariables(subprogram: DwarfSubprogramInfo, pc: number): DwarfVariableInfo[] {
  const visible = new Map<string, DwarfVariableInfo>();
  for (const variable of subprogram.variables) visible.set(variable.name, variable);
  const visit = (scope: DwarfLexicalScope) => {
    if (scope.ranges.length > 0 && !dwarfRangeContains(scope.ranges, pc)) return;
    for (const variable of scope.variables) visible.set(variable.name, variable);
    for (const child of scope.children) visit(child);
  };
  for (const child of subprogram.children) visit(child);
  return Array.from(visible.values());
}

export interface LineMapping {
  file: string;
  line: number;
  address: number;
  isStatement: boolean;
}

export type LineMappingByFile = Map<string, Array<{ line: number; address: number; isStatement: boolean }>>;

export function parseDecodedLineMappings(stdout: string): LineMappingByFile {
  const map: LineMappingByFile = new Map();
  const hasStmtColumn = stdout.split('\n').some(line => /\bFile name\b/.test(line) && /\bStmt\b/.test(line));

  for (const lineStr of stdout.split('\n')) {
    const match = lineStr.match(/^\s*(\S+)\s+(\d+)\s+(0x[0-9a-fA-F]+|\d+)/);
    if (!match) continue;
    const fName = match[1];
    const lNum = parseInt(match[2], 10);
    if (isNaN(lNum)) continue;
    const addrStr = match[3];
    const addr = addrStr.startsWith('0x') || addrStr.startsWith('0X')
      ? parseInt(addrStr, 16)
      : parseInt(addrStr, 10);
    if (isNaN(addr)) continue;

    let entries = map.get(fName);
    if (!entries) {
      entries = [];
      map.set(fName, entries);
    }
    entries.push({ line: lNum, address: addr, isStatement: hasStmtColumn ? lineStr.trim().endsWith(' x') : true });
  }

  for (const entries of map.values()) {
    entries.sort((a, b) => a.line - b.line);
  }

  return map;
}

export function resolveMappedStatementAddress(map: LineMappingByFile, file: string, line: number): number | null {
  const fileName = file.split(/[/\\]/).pop() || file;

  const fNameMatch = (fName: string): boolean =>
    fName === fileName || fName === file || file.endsWith(fName);

  for (const [fName, entries] of map) {
    if (!fNameMatch(fName)) continue;
    const match = entries.find(entry => entry.line === line && entry.isStatement);
    if (match && match.address >= 0x08000000) return match.address;
  }

  return null;
}

export async function preloadLineMappings(elfPath: string): Promise<LineMappingByFile> {
  const map: LineMappingByFile = new Map();

  return new Promise((resolve) => {
    execFile(OBJDUMP_EXE, [
      '--dwarf=decodedline', elfPath,
    ], {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30000,
      windowsHide: true,
    }, (error, stdout) => {
      if (error) {
        log.eval('preloadLineMappings error: ' + error);
        resolve(map);
        return;
      }

      resolve(parseDecodedLineMappings(stdout));
    });
  });
}

export async function preloadAddressMappings(elfPath: string, addresses: number[]): Promise<Map<number, { file: string; line: number; func: string }>> {
  const map = new Map<number, { file: string; line: number; func: string }>();

  if (addresses.length === 0) return map;

  const addrArgs = addresses.map(a => `0x${a.toString(16).padStart(8, '0')}`);

  return new Promise((resolve) => {
    execFile(ADDR2LINE_EXE, [
      '-e', elfPath, '-f', ...addrArgs,
    ], {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30000,
      windowsHide: true,
    }, (error, stdout) => {
      if (error) {
        log.eval('preloadAddressMappings error: ' + error);
        resolve(map);
        return;
      }

      const lines = stdout.trim().split('\n');
      for (let i = 0; i < addresses.length && i * 2 + 1 < lines.length; i++) {
        const func = lines[i * 2].trim();
        const loc = lines[i * 2 + 1].trim();
        const match = loc.match(/^(.+):(\d+)/);
        if (func !== '??' && match) {
          map.set(addresses[i], { file: match[1], line: parseInt(match[2], 10), func });
        }
      }

      resolve(map);
    });
  });
}

export async function resolveLineToAddress(elfPath: string, file: string, line: number): Promise<number | null> {
  return new Promise((resolve) => {
    execFile(OBJDUMP_EXE, [
      '--dwarf=decodedline', elfPath,
    ], {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30000,
      windowsHide: true,
    }, (error, stdout) => {
      if (error) {
        log.eval('resolveLineToAddress error: ' + error);
        resolve(null);
        return;
      }

      const map = parseDecodedLineMappings(stdout);
      resolve(resolveMappedStatementAddress(map, file, line));
    });
  });
}

export async function resolveAddressToLine(elfPath: string, address: number): Promise<{ file: string; line: number; func: string } | null> {
  return new Promise((resolve) => {
    execFile(ADDR2LINE_EXE, [
      '-e', elfPath, '-f', `0x${address.toString(16).padStart(8, '0')}`,
    ], {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30000,
      windowsHide: true,
    }, (error, stdout) => {
      if (error) {
        log.eval('resolveAddressToLine error: ' + error);
        resolve(null);
        return;
      }

      const lines = stdout.trim().split('\n');
      if (lines.length < 2 || lines[0] === '??') {
        resolve(null);
        return;
      }
      const func = lines[0].trim();
      const loc = lines[1].trim();
      const match = loc.match(/^(.+):(\d+)/);
      if (match) {
        resolve({ file: match[1], line: parseInt(match[2], 10), func });
      } else {
        resolve({ file: '', line: 0, func });
      }
    });
  });
}
