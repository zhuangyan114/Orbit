import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export class OzoneDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
  resolveDebugConfiguration(
    _folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration,
    _token?: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.DebugConfiguration> {
    const cfg = vscode.workspace.getConfiguration('ozone');

    if (!config.request) {
      config.type = 'ozone';
      config.request = 'launch';
      config.name = 'Ozone Debug';
    }

    if (!config.device) {
      config.device = cfg.get<string>('defaultDevice', 'STM32F407VG');
    }
    if (!config.interface) {
      config.interface = cfg.get<string>('defaultInterface', 'SWD');
    }
    if (!config.speedKHz) {
      config.speedKHz = cfg.get<number>('defaultSpeed', 4000);
    }
    if (!config.program) {
      let program = cfg.get<string>('defaultProgram', '');
      if (!program) {
        program = this.findElf();
        cfg.update('defaultProgram', program, vscode.ConfigurationTarget.Workspace);
      }
      config.program = program;
    }
    if (config.flashBeforeDebug === undefined) {
      config.flashBeforeDebug = cfg.get<boolean>('flashBeforeDebug', true);
    }

    return config;
  }

  private findElf(): string {
    const wsFolders = vscode.workspace.workspaceFolders;
    if (!wsFolders) return '${workspaceFolder}/build/Debug/frame.elf';

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
    return '${workspaceFolder}/build/Debug/frame.elf';
  }
}