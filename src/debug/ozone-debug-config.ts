import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { getOrbitConfiguration } from '../utils/orbit-settings';
import { ORBIT_DAP_TYPE } from '../utils/debug-session-type';
import { log } from '../utils/logger';
import { applyNormalizedDapLaunchConfig, normalizeDapLaunchConfig } from './dap-launch-config';
import { resolveSvdForDevice } from './svd-resolver';

export class OzoneDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
  private readonly svdCacheRoot: string;

  constructor(svdCacheRoot?: string) {
    this.svdCacheRoot = svdCacheRoot ?? path.join(
      process.env.LOCALAPPDATA ?? process.cwd(),
      'Orbit',
      'svd-cache'
    );
  }

  async resolveDebugConfiguration(
    folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration,
    token?: vscode.CancellationToken
  ): Promise<vscode.DebugConfiguration> {
    // 初始模板留空芯片，避免未填写时连接到默认型号。
    if (typeof config.device === 'string' && !config.device.trim()) {
      throw new Error('请先在 launch.json 的 device 中填写芯片型号，例如 STM32F407VET6。');
    }
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
        program = this.findElf(folder);
        cfg.update('defaultProgram', program, vscode.ConfigurationTarget.Workspace);
      }
      config.program = program;
    }
    const explicitSvd = typeof config.svdFile === 'string' && config.svdFile.trim()
      ? config.svdFile.trim()
      : typeof config.svdPath === 'string' && config.svdPath.trim()
        ? config.svdPath.trim()
        : cfg.get<string>('defaultSvdFile', '').trim();
    if (explicitSvd) {
      config.svdFile = explicitSvd;
      config.svdPath = explicitSvd;
    } else if (!token?.isCancellationRequested) {
      const workspaceRoot = folder?.uri.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const startedAt = Date.now();
      log.dap(`[svd] preparing device=${config.device}`);
      // Launch waits only for local files/cache. Network retrieval starts after
      // the visible debug session has started, and never delays target startup.
      const resolution = await resolveSvdForDevice(String(config.device), {
        workspaceRoot,
        cacheRoot: this.svdCacheRoot,
        allowDownload: false,
      });
      log.dap(`[svd] prepared device=${config.device} source=${resolution.source} elapsedMs=${Date.now() - startedAt}`);
      if (resolution.path && !token?.isCancellationRequested) {
        config.svdFile = resolution.path;
        config.svdPath = resolution.path;
        log.dap(`[svd] ${config.device} -> ${resolution.path} (${resolution.source})`);
      } else if (resolution.warning) {
        const action = cfg.get<boolean>('svdAutoDownload', true)
          ? '先启动调试，SVD 在会话启动后后台获取'
          : 'orbit.svdAutoDownload 已关闭，调试继续';
        log.dap(`[svd] 本地未找到 ${config.device} 的 SVD；${action}`);
      }
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
    if (config.jlinkDllPath === undefined) {
      const dllPath = cfg.get<string>('jlinkDllPath', '').trim();
      if (dllPath) config.jlinkDllPath = dllPath;
    }

    // Pass retired settings to the adapter only when they selected J-Link Legacy.
    const previousEngineMode = config.nativeDebugEngineMode ?? cfg.get<string>('nativeDebugEngine.mode');
    const previousEngineEnabled = config.nativeDebugEngineEnabled ?? cfg.get<boolean>('nativeDebugEngine.enabled');
    if (previousEngineMode === 'legacy' || (previousEngineMode !== 'native' && previousEngineEnabled === false)) {
      config.nativeDebugEngineMode = 'legacy';
    }

    return config;
  }

  private findElf(folder?: vscode.WorkspaceFolder): string {
    const workspaceRoot = folder?.uri.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) return '${workspaceFolder}/build/Debug/frame.elf';
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
