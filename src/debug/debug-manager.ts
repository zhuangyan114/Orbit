import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { spawn } from 'child_process';

function getOzonePath(): string {
  const config = vscode.workspace.getConfiguration('ozone');
  const configured = config.get<string>('ozonePath', '');
  if (configured && fs.existsSync(configured)) return configured;

  const defaultPath = 'C:\\Program Files\\SEGGER\\Ozone\\Ozone.exe';
  if (fs.existsSync(defaultPath)) return defaultPath;

  return defaultPath;
}

function resolveElfPath(): string | null {
  const config = vscode.workspace.getConfiguration('ozone');
  let elfPath = config.get<string>('defaultProgram', '');
  if (elfPath && fs.existsSync(elfPath)) return elfPath;

  const wsFolders = vscode.workspace.workspaceFolders;
  if (!wsFolders) return null;

  const workspaceRoot = wsFolders[0].uri.fsPath;
  const buildDirs = ['build/Debug', 'build/Release', 'build'];
  for (const dir of buildDirs) {
    const fullDir = path.join(workspaceRoot, dir);
    if (!fs.existsSync(fullDir)) continue;
    const files = fs.readdirSync(fullDir).filter(f => f.endsWith('.elf') || f.endsWith('.axf'));
    if (files.length > 0) {
      return path.join(fullDir, files[0]);
    }
  }

  return null;
}

function generateJdebugScript(elfPath: string, device: string, interface_: string, speedKHz: number): string {
  const normalizedPath = elfPath.replace(/\\/g, '/');
  return [
    `Project.SetDevice("${device}")`,
    `Project.SetHostIF("${interface_}")`,
    `Project.SetSpeed(${speedKHz})`,
    `Project.Open("${normalizedPath}")`,
    'Target.Connect()',
  ].join('\n');
}

export async function startDebugSession(): Promise<boolean> {
  const config = vscode.workspace.getConfiguration('ozone');
  const wsFolders = vscode.workspace.workspaceFolders;

  if (!wsFolders) {
    vscode.window.showErrorMessage('Ozone: 没有打开的工作区');
    return false;
  }

  const ozonePath = getOzonePath();
  if (!fs.existsSync(ozonePath)) {
    vscode.window.showErrorMessage(`Ozone: 未找到 ${ozonePath}`);
    return false;
  }

  const device = config.get<string>('defaultDevice', 'STM32F407VG');
  const interface_ = config.get<'SWD' | 'JTAG'>('defaultInterface', 'SWD');
  const speedKHz = config.get<number>('defaultSpeed', 4000);

  const elfPath = resolveElfPath();
  if (!elfPath) {
    vscode.window.showErrorMessage('Ozone: 未找到 .elf/.axf 文件，请先在编辑面板中设置');
    return false;
  }

  const jdebugContent = generateJdebugScript(elfPath, device, interface_, speedKHz);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ozone-debug-'));
  const jdebugPath = path.join(tmpDir, 'debug.jdebug');
  fs.writeFileSync(jdebugPath, jdebugContent, 'utf-8');

  vscode.window.showInformationMessage(`Ozone: 启动调试... ${path.basename(elfPath)}`);

  try {
    const proc = spawn(`"${ozonePath}"`, ['--jdebug', jdebugPath], {
      shell: true,
      windowsHide: false,
    });

    proc.on('error', (err) => {
      vscode.window.showErrorMessage(`Ozone: 启动失败: ${err.message}`);
      cleanup(tmpDir);
    });

    proc.on('exit', () => {
      cleanup(tmpDir);
    });

    setTimeout(() => cleanup(tmpDir), 5000);

    return true;
  } catch (err: any) {
    vscode.window.showErrorMessage(`Ozone: 启动失败: ${err.message}`);
    cleanup(tmpDir);
    return false;
  }
}

function cleanup(tmpDir: string) {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch { }
}