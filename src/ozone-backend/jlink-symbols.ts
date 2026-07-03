import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

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

const NM_EXE = findArmTool('arm-none-eabi-nm.exe');
const OBJDUMP_EXE = findArmTool('arm-none-eabi-objdump.exe');
const ADDR2LINE_EXE = findArmTool('arm-none-eabi-addr2line.exe');

try {
  const logFile = path.join(__dirname, '..', 'debugadapter.log');
  fs.appendFileSync(logFile, `[${new Date().toISOString()}] tools: nm=${NM_EXE}, objdump=${OBJDUMP_EXE}, addr2line=${ADDR2LINE_EXE}\n`);
} catch { }

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
        console.error('[JLinkSymbols] readElfSymbols error:', error);
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



export async function readDwarfTypes(elfPath: string): Promise<Map<string, { type: string; size: number }>> {
  const typeMap = new Map<string, { type: string; size: number }>();

  try {
    const stdout = await new Promise<string>((resolve) => {
      execFile(OBJDUMP_EXE, [
        '--dwarf=info', elfPath,
      ], {
        maxBuffer: 50 * 1024 * 1024,
        timeout: 30000,
        windowsHide: true,
      }, (error, stdout) => {
        if (error) {
          console.error('[JLinkSymbols] readDwarfTypes error:', error);
          resolve('');
        } else {
          resolve(stdout);
        }
      });
    });

    let currentName = '';
    for (const line of stdout.split('\n')) {
      const nameMatch = line.match(/DW_AT_name\s*:\s*(\w+)/);
      if (nameMatch) currentName = nameMatch[1];

      const typeMatch = line.match(/DW_AT_type\s*:\s*<0x[0-9a-f]+>/);
      const sizeMatch = line.match(/DW_AT_byte_size\s*:\s*(\d+)/);

      if (currentName && sizeMatch) {
        typeMap.set(currentName, { type: '', size: parseInt(sizeMatch[1]) });
      }
    }
  } catch { }

  return typeMap;
}

export interface LineMapping {
  file: string;
  line: number;
  address: number;
}

export async function preloadLineMappings(elfPath: string): Promise<Map<string, Array<{ line: number; address: number }>>> {
  const map = new Map<string, Array<{ line: number; address: number }>>();

  return new Promise((resolve) => {
    execFile(OBJDUMP_EXE, [
      '--dwarf=decodedline', elfPath,
    ], {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30000,
      windowsHide: true,
    }, (error, stdout) => {
      if (error) {
        console.error('[JLinkSymbols] preloadLineMappings error:', error);
        resolve(map);
        return;
      }

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
        entries.push({ line: lNum, address: addr });
      }

      for (const entries of map.values()) {
        entries.sort((a, b) => a.line - b.line);
      }

      resolve(map);
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
        console.error('[JLinkSymbols] preloadAddressMappings error:', error);
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
        console.error('[JLinkSymbols] resolveLineToAddress error:', error);
        resolve(null);
        return;
      }

      const fileName = file.split(/[/\\]/).pop() || file;
      let bestAddress: number | null = null;
      let bestLine = 0;

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

        if ((fName === fileName || file.includes(fName)) && lNum <= line && lNum > bestLine) {
          bestAddress = addr;
          bestLine = lNum;
        }
      }

      resolve(bestAddress);
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
        console.error('[JLinkSymbols] resolveAddressToLine error:', error);
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
