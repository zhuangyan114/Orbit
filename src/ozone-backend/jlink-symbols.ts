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

export interface DwarfTypeInfo {
  name: string;
  byteSize: number;
  kind: 'struct' | 'typedef' | 'base' | 'pointer' | 'array' | 'enum' | 'const' | 'volatile' | 'restrict' | 'unspecified';
  fields?: DwarfField[];
  typeOffset?: string;
  arrayCount?: number;
  encoding?: string;
}

export interface DwarfInfo {
  varToType: Map<string, string>;
  typeDefs: Map<string, DwarfTypeInfo>;
  _diag?: string;
}

function parseDwarfOutput(stdout: string): { dies: any[]; errors: string[] } {
  const dies: any[] = [];
  const errors: string[] = [];
  const stack: any[] = [];

  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trimEnd();
    const depthMatch = line.match(/^\s*<(\d+)><([0-9a-fA-F]+)>:\s+Abbrev Number:\s+\d+\s+\((.+)\)/);
    if (depthMatch) {
      const depth = parseInt(depthMatch[1]);
      const offset = depthMatch[2];
      const tag = depthMatch[3];
      const die: any = { offset: `0x${offset.toLowerCase()}`, tag, depth, attrs: {}, children: [] };
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

export async function parseDwarfTypeInfo(elfPath: string): Promise<DwarfInfo> {
  const varToType = new Map<string, string>();
  const typeDefs = new Map<string, DwarfTypeInfo>();
  const dwarfErrors: string[] = [];
  const diagParts: string[] = [];

  try {
    const stdout = await new Promise<string>((resolve) => {
      execFile(OBJDUMP_EXE, [
        '--dwarf=info', elfPath,
      ], {
        maxBuffer: 50 * 1024 * 1024,
        timeout: 30000,
        windowsHide: true,
      }, (error, stdout) => {
        if (error) { log.eval('readDwarfTypes error: ' + error); resolve(''); }
        else { resolve(stdout); }
      });
    });

    if (!stdout) {
      diagParts.push('stdout empty');
      return { varToType, typeDefs, _diag: diagParts.join(' | ') };
    }
    
    diagParts.push(`len=${stdout.length}, dwTagCount=${(stdout.match(/\(DW_TAG_\w+\)/g) || []).length}`);

    const { dies } = parseDwarfOutput(stdout);
    diagParts.push(`dies=${dies.length}`);
    if (dies.length > 0) {
      const topLevel = dies.filter((d: any) => d.depth === 0 || d.depth === 1);
      diagParts.push(`topDies=${topLevel.length}`);
    }
    function visitDie(die: any, collect: (d: any) => void) {
      collect(die);
      for (const child of (die.children || [])) visitDie(child, collect);
    }

    const allDies: any[] = [];
    for (const d of dies) visitDie(d, d2 => allDies.push(d2));

    let nStruct = 0, nTypedef = 0, nBase = 0, nVar = 0;
    for (const d of allDies) {
      if (d.tag === 'DW_TAG_structure_type') nStruct++;
      else if (d.tag === 'DW_TAG_typedef') nTypedef++;
      else if (d.tag === 'DW_TAG_base_type') nBase++;
      else if (d.tag === 'DW_TAG_variable') nVar++;
    }
    diagParts.push(`struct=${nStruct}, typedef=${nTypedef}, base=${nBase}, var=${nVar}`);

    for (const die of allDies) {
      if (die.tag === 'DW_TAG_variable' && die.attrs.DW_AT_name && die.attrs.DW_AT_type) {
        varToType.set(die.attrs.DW_AT_name, die.attrs.DW_AT_type);
      }

      if (die.tag === 'DW_TAG_structure_type') {
        const fields: DwarfField[] = [];
        for (const child of die.children) {
          if (child.tag === 'DW_TAG_member' && child.attrs.DW_AT_name) {
            let offset = 0;
            if (child.attrs.DW_AT_data_member_location) {
              offset = parseInt(child.attrs.DW_AT_data_member_location, 10);
              if (isNaN(offset)) offset = 0;
            }
            fields.push({
              name: child.attrs.DW_AT_name,
              typeOffset: child.attrs.DW_AT_type || '',
              byteOffset: offset,
            });
          }
        }
        typeDefs.set(die.offset, {
          name: die.attrs.DW_AT_name || '',
          byteSize: parseInt(die.attrs.DW_AT_byte_size) || 0,
          kind: 'struct',
          fields,
        });
      }

      if (die.tag === 'DW_TAG_typedef' && die.attrs.DW_AT_name) {
        typeDefs.set(die.offset, {
          name: die.attrs.DW_AT_name,
          byteSize: 0,
          kind: 'typedef',
          typeOffset: die.attrs.DW_AT_type,
        });
      }

      if (die.tag === 'DW_TAG_base_type' && die.attrs.DW_AT_name) {
        typeDefs.set(die.offset, {
          name: die.attrs.DW_AT_name,
          byteSize: parseInt(die.attrs.DW_AT_byte_size) || 0,
          kind: 'base',
          encoding: die.attrs.DW_AT_encoding,
        });
      }

      if (die.tag === 'DW_TAG_pointer_type') {
        typeDefs.set(die.offset, {
          name: '',
          byteSize: parseInt(die.attrs.DW_AT_byte_size) || 4,
          kind: 'pointer',
          typeOffset: die.attrs.DW_AT_type,
        });
      }

      if (die.tag === 'DW_TAG_const_type' || die.tag === 'DW_TAG_volatile_type' || die.tag === 'DW_TAG_restrict_type') {
        typeDefs.set(die.offset, {
          name: '',
          byteSize: 0,
          kind: die.tag === 'DW_TAG_const_type' ? 'const' : die.tag === 'DW_TAG_volatile_type' ? 'volatile' : 'restrict',
          typeOffset: die.attrs.DW_AT_type,
        });
      }

      if (die.tag === 'DW_TAG_array_type') {
        let arraySize = 0;
        for (const child of die.children) {
          if (child.tag === 'DW_TAG_subrange_type' && child.attrs.DW_AT_upper_bound) {
            const ub = parseInt(child.attrs.DW_AT_upper_bound, 10);
            arraySize = Math.max(arraySize, ub + 1);
          }
        }
        typeDefs.set(die.offset, {
          name: '',
          byteSize: 0,
          kind: 'array',
          typeOffset: die.attrs.DW_AT_type,
          arrayCount: arraySize,
        });
      }
    }
  } catch (e: any) {
    diagParts.push(`ERROR: ${e.message}`);
  }

  return { varToType, typeDefs, _diag: diagParts.join(' | ') };
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
