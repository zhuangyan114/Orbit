import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { log } from '../utils/logger';

export interface FlashResult {
  success: boolean;
  message: string;
  elfPath?: string;
}

export interface FlashOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  jlinkPath?: string;
}

interface ActiveFlash {
  process: ChildProcess;
  cancel(reason: string): void;
}

const activeFlashes = new Set<ActiveFlash>();

export function cancelActiveFlashes(reason = 'debug session disposed'): void {
  for (const flash of [...activeFlashes]) flash.cancel(reason);
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
    const config = vscode.workspace.getConfiguration('orbit');
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
  speedKHz: number,
  options: FlashOptions = {},
): Promise<FlashResult> {
  if (!fs.existsSync(elfPath)) {
    return { success: false, message: `ELF file not found: ${elfPath}` };
  }

  const jlinkPath = options.jlinkPath || findJLinkExe();
  if (!fs.existsSync(jlinkPath)) {
    return { success: false, message: `JLink.exe not found at: ${jlinkPath}\nCheck orbit.jlinkPath setting` };
  }

  const normalizedPath = elfPath.replace(/\\/g, '/');
  const scriptContent = [
    `loadfile "${normalizedPath}"`,
    'r',
    'g',
    'exit',
  ].join('\n');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-flash-'));
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
    const proc = spawn(jlinkPath, args, { shell: false, windowsHide: true });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timeout: NodeJS.Timeout | null = null;

    const outputDetail = () => {
      const output = (stdout + stderr).trim();
      if (!output) return '';
      return output.split(/\r?\n/).slice(-8).join('\n').slice(-2000);
    };

    const finish = (result: FlashResult, killProcess = false) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);
      activeFlashes.delete(activeFlash);
      if (killProcess && proc.exitCode === null && !proc.killed) {
        try { proc.kill('SIGKILL'); } catch { }
      }
      cleanup(tmpDir);
      resolve(result);
    };

    const cancel = (reason: string) => {
      const detail = outputDetail();
      log.dap(`flash abort pid=${proc.pid ?? 'unknown'} reason=${reason}${detail ? ` output=${JSON.stringify(detail)}` : ''}`);
      finish({ success: false, message: `Flash cancelled: ${reason}${detail ? `\n${detail}` : ''}` }, true);
    };

    const onAbort = () => cancel(typeof options.signal?.reason === 'string' ? options.signal.reason : 'aborted');
    const activeFlash: ActiveFlash = { process: proc, cancel };
    activeFlashes.add(activeFlash);

    proc.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
    proc.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });

    proc.on('error', (err) => {
      finish({ success: false, message: `Failed to start JLink: ${err.message}` });
    });

    proc.on('exit', (code) => {
      const output = stdout + stderr;
      if (code === 0 && (output.includes('O.K.') || output.includes('Download'))) {
        finish({
          success: true,
          message: `Flash successful: ${path.basename(elfPath)}`,
          elfPath,
        });
      } else {
        const detail = outputDetail() || `JLink exited with code ${code}`;
        finish({ success: false, message: `Flash failed: ${detail}` });
      }
    });

    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
      return;
    }

    const timeoutMs = options.timeoutMs ?? 30000;
    timeout = setTimeout(() => {
      const detail = outputDetail();
      log.dap(`flash timeout pid=${proc.pid ?? 'unknown'} elapsedMs=${timeoutMs}${detail ? ` output=${JSON.stringify(detail)}` : ''}`);
      finish({ success: false, message: `Flash timeout (${Math.round(timeoutMs / 1000)}s)${detail ? `\n${detail}` : ''}` }, true);
    }, timeoutMs);
  });
}

function cleanup(tmpDir: string) {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch { }
}
