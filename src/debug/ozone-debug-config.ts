import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { getOrbitConfiguration } from '../utils/orbit-settings';
import { ORBIT_DAP_TYPE } from '../utils/debug-session-type';
import { applyNormalizedDapLaunchConfig, normalizeDapLaunchConfig } from './dap-launch-config';

export class OzoneDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
  resolveDebugConfiguration(
    _folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration,
    _token?: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.DebugConfiguration> {
    const cfg = getOrbitConfiguration();

    if (!config.request) {
      config.type = config.type || ORBIT_DAP_TYPE;
      config.request = 'launch';
      config.name = 'Orbit Debug';
    }

    const targetConfig = normalizeDapLaunchConfig({
      ...config,
      flashBeforeDebug: config.flashBeforeDebug === undefined
        ? cfg.get<boolean>('flashBeforeDebug', true)
        : config.flashBeforeDebug,
    });
    applyNormalizedDapLaunchConfig(config, targetConfig);

    if (!config.device) {
      config.device = cfg.get<string>('defaultDevice', 'STM32F407VG');
    }
    if (!config.deviceName) {
      config.deviceName = config.device;
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
    if (config.svdFile === undefined) {
      config.svdFile = cfg.get<string>('defaultSvdFile', '');
    }
    if (config.svdPath === undefined) {
      config.svdPath = config.svdFile || cfg.get<string>('defaultSvdFile', '');
    }
    if (config.rtos === undefined) {
      config.rtos = cfg.get<string>('defaultRtos', '');
    }
    if (config.rttLogEnabled === undefined) {
      config.rttLogEnabled = cfg.get<boolean>('rttLogEnabled', true);
    }
    if (config.loggingEnabled === undefined) {
      config.loggingEnabled = cfg.get<boolean>('logging.enabled', true);
    }
    if (config.clearLogsOnStart === undefined) {
      config.clearLogsOnStart = cfg.get<boolean>('logging.clearOnStart', true);
    }
    if (config.rttBufferIndex === undefined) {
      config.rttBufferIndex = cfg.get<number>('rttBufferIndex', 0);
    }
    if (config.rttPollIntervalMs === undefined) {
      config.rttPollIntervalMs = cfg.get<number>('rttPollIntervalMs', 50);
    }
    if (config.rttReadSize === undefined) {
      config.rttReadSize = cfg.get<number>('rttReadSize', 4096);
    }
    if (config.rttControlBlockAddress === undefined) {
      config.rttControlBlockAddress = cfg.get<string>('rttControlBlockAddress', '');
    }
    if (config.rttStripAnsi === undefined) {
      config.rttStripAnsi = cfg.get<boolean>('rttStripAnsi', true);
    }
    if (config.rttLogTarget === undefined) {
      config.rttLogTarget = cfg.get<string>('rttLogTarget', 'terminal');
    }
    if (config.pRtLogEnabled === undefined) {
      config.pRtLogEnabled = cfg.get<boolean>('pRtLogEnabled', false);
    }
    if (config.pRtLogRoot === undefined) {
      config.pRtLogRoot = cfg.get<string>('pRtLogRoot', '');
    }
    if (config.nativeDebugEngineEnabled === undefined) {
      config.nativeDebugEngineEnabled = cfg.get<boolean>('nativeDebugEngine.enabled', true);
    }
    if (config.nativeDebugEngineMode === undefined) {
      config.nativeDebugEngineMode = cfg.get<'legacy' | 'native' | 'auto'>('nativeDebugEngine.mode', 'auto');
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
