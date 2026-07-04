import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

export interface FlashResult {
  success: boolean;
  message: string;
  elfPath?: string;
}

export interface ElfCandidate {
  path: string;
  label: string;
  description: string;
}

export function findElfFiles(workspaceRoot: string): ElfCandidate[] {
  const candidates: ElfCandidate[] = [];
  const searchDirs = ['build/Debug', 'build/Release', 'build'];

  for (const dir of searchDirs) {
    const fullDir = path.join(workspaceRoot, dir);
    if (!fs.existsSync(fullDir)) continue;
    try {
      const files = fs.readdirSync(fullDir);
      for (const f of files) {
        if (f.endsWith('.elf') || f.endsWith('.axf')) {
          const fullPath = path.join(fullDir, f);
          const stat = fs.statSync(fullPath);
          const mtime = stat.mtime.toLocaleString();
          const sizeKB = (stat.size / 1024).toFixed(1);
          candidates.push({
            path: fullPath,
            label: `${dir}/${f}`,
            description: `${sizeKB} KB, modified ${mtime}`,
          });
        }
      }
    } catch { }
  }

  return candidates;
}

export function findJLinkExe(): string {
  try {
    const vscode = require('vscode') as typeof import('vscode');
    const config = vscode.workspace.getConfiguration('ozone');
    const configured = config.get<string>('jlinkPath', '');
    if (configured && fs.existsSync(configured)) return configured;
  } catch { }

  const base = 'C:\\Program Files\\SEGGER';
  if (!fs.existsSync(base)) return 'JLink.exe';

  try {
    const dirs = fs.readdirSync(base).filter(d => d.startsWith('JLink_V'));
    dirs.sort().reverse();
    for (const dir of dirs) {
      const candidate = path.join(base, dir, 'JLink.exe');
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch { }

  return 'JLink.exe';
}

export async function flashElf(
  elfPath: string,
  device: string,
  interface_: string,
  speedKHz: number
): Promise<FlashResult> {
  if (!fs.existsSync(elfPath)) {
    return { success: false, message: `ELF file not found: ${elfPath}` };
  }

  const jlinkPath = findJLinkExe();
  if (!fs.existsSync(jlinkPath)) {
    return { success: false, message: `JLink.exe not found at: ${jlinkPath}\nCheck ozone.jlinkPath setting` };
  }

  const normalizedPath = elfPath.replace(/\\/g, '/');
  const scriptContent = [
    `loadfile "${normalizedPath}"`,
    'r',
    'g',
    'exit',
  ].join('\n');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ozone-flash-'));
  const scriptPath = path.join(tmpDir, 'flash.jlink');
  fs.writeFileSync(scriptPath, scriptContent, 'utf-8');

  const args = [
    '-device', device,
    '-if', interface_,
    '-speed', String(speedKHz),
    '-autoconnect', '1',
    '-CommanderScript', scriptPath,
  ];

  return new Promise<FlashResult>((resolve) => {
    const proc = spawn(`"${jlinkPath}"`, args, { shell: true, windowsHide: true });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
    proc.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });

    proc.on('error', (err) => {
      cleanup(tmpDir);
      resolve({ success: false, message: `Failed to start JLink: ${err.message}` });
    });

    proc.on('exit', (code) => {
      cleanup(tmpDir);
      const output = stdout + stderr;
      if (code === 0 && (output.includes('O.K.') || output.includes('Download'))) {
        resolve({
          success: true,
          message: `Flash successful: ${path.basename(elfPath)}`,
          elfPath,
        });
      } else {
        const detail = output.split('\n').slice(-3).join('\n').trim() || `JLink exited with code ${code}`;
        resolve({ success: false, message: `Flash failed: ${detail}` });
      }
    });

    setTimeout(() => {
      proc.kill();
      cleanup(tmpDir);
      resolve({ success: false, message: 'Flash timeout (30s)' });
    }, 30000);
  });
}

function cleanup(tmpDir: string) {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch { }
}