import * as vscode from 'vscode';
import { OzoneBackend } from '../ozone-backend/commander';
import { DebugSessionConfig, TargetState } from '../ozone-backend/types';
import { SessionInfo, RecentSession } from './types';
import { getOrbitConfiguration } from '../utils/orbit-settings';

export class SessionManager {
  private current: SessionInfo | null = null;
  private recent: RecentSession[] = [];
  private statusBar: vscode.StatusBarItem;

  constructor(private backend: OzoneBackend) {
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    this.statusBar.command = 'ozone.startSession';
    this.updateStatusBar();
    this.statusBar.show();

    this.loadRecent();
  }

  async start(config?: DebugSessionConfig): Promise<void> {
    if (vscode.debug.activeDebugSession?.type === 'ozone') {
      vscode.window.showErrorMessage('Orbit: target access is owned by the active debug session');
      return;
    }
    if (this.current) {
      await this.stop();
    }

    const resolvedConfig = config ?? await this.promptConfig();
    if (!resolvedConfig) return;

    const result = await this.backend.execute({ cmd: 'connect', config: resolvedConfig });
    if (!result.ok) {
      vscode.window.showErrorMessage(`Orbit: ${result.error}`);
      return;
    }

    this.current = {
      id: Date.now().toString(36),
      config: resolvedConfig,
      state: TargetState.Connected,
      startedAt: Date.now(),
      label: `${resolvedConfig.device} @ ${resolvedConfig.interface}`,
    };

    this.addRecent(resolvedConfig);
    this.updateStatusBar();
    vscode.window.showInformationMessage(`Orbit: Connected to ${resolvedConfig.device}`);
  }

  async stop(): Promise<void> {
    if (!this.current) return;
    await this.backend.execute({ cmd: 'disconnect' });
    this.current = null;
    this.updateStatusBar();
    vscode.window.showInformationMessage('Orbit: Session ended');
  }

  async restart(): Promise<void> {
    const config = this.current?.config;
    await this.stop();
    if (config) {
      await this.start(config);
    }
  }

  async showQuickPick(): Promise<void> {
    const items: vscode.QuickPickItem[] = [];

    if (this.current) {
      items.push({
        label: `$(debug-stop) ${this.current.label}`,
        description: this.current.state,
        detail: `Started ${new Date(this.current.startedAt).toLocaleTimeString()}`,
      });
    }

    items.push({
      label: '$(plus) New Session',
      description: 'Configure a new debug session',
    });

    for (const recent of this.recent) {
      items.push({
        label: `$(history) ${recent.label}`,
        description: recent.config.device,
        detail: `Last used: ${new Date(recent.lastUsed).toLocaleDateString()}`,
      });
    }

    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: 'Orbit Debug Sessions',
    });

    if (!pick) return;
    // Handle selection...
  }

  private async promptConfig(): Promise<DebugSessionConfig | undefined> {
    const config = getOrbitConfiguration();
    const device = await vscode.window.showInputBox({
      prompt: 'Target device (e.g., STM32F407VG)',
      value: config.get<string>('defaultDevice', 'STM32F407VG'),
    });
    if (!device) return undefined;

    return {
      device,
      interface: config.get<'SWD' | 'JTAG'>('defaultInterface', 'SWD'),
      speedKHz: config.get<number>('defaultSpeed', 4000),
    };
  }

  private updateStatusBar() {
    if (this.current) {
      this.statusBar.text = `$(debug-alt) Orbit: ${this.current.label}`;
      this.statusBar.tooltip = `State: ${this.current.state}\nClick to manage session`;
      this.statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
    } else {
      this.statusBar.text = '$(plug) Orbit: Disconnected';
      this.statusBar.tooltip = 'Click to start a debug session';
      this.statusBar.backgroundColor = undefined;
    }
  }

  private addRecent(config: DebugSessionConfig) {
    const label = `${config.device} @ ${config.interface} ${config.speedKHz}kHz`;
    this.recent = this.recent.filter(r => r.label !== label);
    this.recent.unshift({ config, label, lastUsed: Date.now() });

    const maxRecent = getOrbitConfiguration().get<number>('recentSessions', 10);
    if (this.recent.length > maxRecent) {
      this.recent = this.recent.slice(0, maxRecent);
    }
    this.saveRecent();
  }

  private loadRecent() {
    try {
      const raw = getOrbitConfiguration().get<string>('_recentSessions');
      if (raw) {
        this.recent = JSON.parse(raw);
      }
    } catch { /* ignore */ }
  }

  private saveRecent() {
    getOrbitConfiguration().update('_recentSessions',
      JSON.stringify(this.recent), vscode.ConfigurationTarget.Global);
  }

  onDebugStart() { this.updateStatusBar(); }
  onDebugStop() { this.updateStatusBar(); }

  dispose() {
    this.statusBar.dispose();
    this.backend.dispose();
  }
}
