import * as vscode from 'vscode';
import { OzoneBackend } from '../ozone-backend/commander';
import { TargetState, RegisterValue, WatchValue } from '../ozone-backend/types';
import { getOrbitConfiguration } from '../utils/orbit-settings';

export class DebugWebviewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private statusBar: vscode.StatusBarItem;

  constructor(private context: vscode.ExtensionContext, private backend: OzoneBackend) {
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
  }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(message => {
      switch (message.command) {
        case 'startSession':
          vscode.commands.executeCommand('ozone.startSession');
          break;
        case 'stopSession':
          vscode.commands.executeCommand('ozone.stopSession');
          break;
        case 'restartSession':
          vscode.commands.executeCommand('ozone.restartSession');
          break;
        case 'flash':
          vscode.commands.executeCommand('ozone.flash');
          break;
        case 'debug':
          vscode.commands.executeCommand('ozone.debug');
          break;
        case 'halt':
          vscode.commands.executeCommand('ozone.halt');
          break;
        case 'run':
          vscode.commands.executeCommand('ozone.run');
          break;
        case 'stepInto':
          vscode.commands.executeCommand('ozone.stepInto');
          break;
        case 'stepOver':
          vscode.commands.executeCommand('ozone.stepOver');
          break;
        case 'stepOut':
          vscode.commands.executeCommand('ozone.stepOut');
          break;
        case 'reset':
          vscode.commands.executeCommand('ozone.reset');
          break;
        case 'openAIChat':
          vscode.commands.executeCommand('ozone.openAIChat');
          break;
        case 'openMemoryBrowser':
          vscode.commands.executeCommand('ozone.openMemoryBrowser');
          break;
        case 'openSettings':
          vscode.commands.executeCommand('workbench.action.openSettings', '@ext:orbit-debug.orbit-for-vscode');
          break;
        case 'getConfig':
          this.sendConfig();
          break;
        case 'setDevice':
          this.setDevice(message.device);
          break;
        case 'setElfPath':
          this.setElfPath(message.elfPath);
          break;
        case 'browseElf':
          this.browseElf();
          break;
        case 'getState':
          this.getState();
          break;
        case 'getRegisters':
          this.getRegisters();
          break;
        case 'readMemory':
          this.readMemory(message.address, message.size);
          break;
        case 'readVariableRuntime':
          this.readVariableRuntime(message.name);
          break;
        case 'evaluateWatches':
          this.evaluateWatches(message.expressions);
          break;
        case 'setWatchValue':
          this.setWatchValue(message.expression, message.value);
          break;
      }
    });
  }

  private async getState() {
    const result = await this.backend.execute({ cmd: 'getTargetState' });
    if (result.ok) {
      this.view?.webview.postMessage({ command: 'stateUpdate', state: result.data });
    }
  }

  private async getRegisters() {
    const result = await this.backend.execute({ cmd: 'getRegisters' });
    if (result.ok) {
      this.view?.webview.postMessage({ command: 'registers', registers: result.data });
    }
  }

  private async readMemory(address: number, size: number) {
    const session = vscode.debug.activeDebugSession;
    if (session && session.type === 'ozone') {
      try {
        const result = await session.customRequest('readMemory', {
          memoryReference: `0x${(address >>> 0).toString(16).toUpperCase()}`,
          count: size,
        });
        if (result && result.data) {
          const bytes = Buffer.from(result.data, 'base64');
          const data = Array.from(bytes);
          const ascii = data.map((b: number) => (b >= 0x20 && b <= 0x7E) ? String.fromCharCode(b) : '.').join('');
          this.view?.webview.postMessage({
            command: 'memoryData',
            block: { address, data, ascii, unreadableBytes: result.unreadableBytes ?? 0 },
          });
          return;
        }
      } catch { }
    }
    const result = await this.backend.execute({ cmd: 'readMemory', address, size });
    if (result.ok) {
      this.view?.webview.postMessage({ command: 'memoryData', block: result.data });
    } else {
      this.view?.webview.postMessage({ command: 'memoryError', error: result.error });
    }
  }

  private async readVariableRuntime(name: string) {
    const result = await this.backend.execute({ cmd: 'readVariableRuntime', name });
    if (result.ok) {
      this.view?.webview.postMessage({ command: 'variableValue', variable: result.data });
    } else {
      this.view?.webview.postMessage({ command: 'variableError', error: result.error });
    }
  }

  async evaluateWatches(expressions: string[]) {
    const session = vscode.debug.activeDebugSession;
    if (session && session.type === 'ozone') {
      try {
        const result = await session.customRequest('watchEvaluate', { expressions });
        if (result && result.results) {
          this.view?.webview.postMessage({ command: 'watchResults', results: result.results });
        }
        return;
      } catch { }
    }
    const isRunning = await this.ensureHalted();
    const results: WatchValue[] = [];
    for (const expr of expressions) {
      const result = await this.backend.execute({ cmd: 'evaluateExpression', expression: expr });
      if (result.ok) {
        results.push(result.data as WatchValue);
      } else {
        results.push({ expression: expr, value: 0, display: '', hex: '', error: result.error });
      }
    }
    if (isRunning) {
      await this.backend.execute({ cmd: 'run' });
    }
    this.view?.webview.postMessage({ command: 'watchResults', results });
  }

  private async setWatchValue(expression: string, value: number) {
    const result = await this.backend.execute({ cmd: 'setWatchValue', expression, value });
    this.view?.webview.postMessage({
      command: 'watchValueSet',
      expression,
      ok: result.ok,
      error: result.ok ? undefined : result.error,
    });
  }

  private async ensureHalted(): Promise<boolean> {
    const stateResult = await this.backend.execute({ cmd: 'getTargetState' });
    const wasAlreadyHalted = stateResult.ok && stateResult.data === 'halted';
    if (wasAlreadyHalted) return false;
    await this.backend.execute({ cmd: 'halt' });
    await new Promise<void>(r => setTimeout(r, 100));
    return true;
  }

  refresh() {
    this.getState();
    this.getRegisters();
  }

  showAIPanel() {
    this.view?.webview.postMessage({ command: 'showAIPanel' });
  }

  showMemoryPanel() {
    this.view?.webview.postMessage({ command: 'showMemoryPanel' });
  }

  private sendConfig() {
    const config = getOrbitConfiguration();
    const wsFolders = vscode.workspace.workspaceFolders;
    const workspaceRoot = wsFolders?.[0]?.uri.fsPath || '';
    const device = config.get<string>('defaultDevice', 'STM32F407VG');
    const elfPath = config.get<string>('defaultProgram', '');
    const jlinkPath = config.get<string>('jlinkPath', '');

    this.view?.webview.postMessage({
      command: 'config',
      device,
      elfPath,
      jlinkPath,
      workspaceRoot,
    });
  }

  private setDevice(device: string) {
      getOrbitConfiguration().update('defaultDevice', device, vscode.ConfigurationTarget.Global);
  }

  private setElfPath(elfPath: string) {
      getOrbitConfiguration().update('defaultProgram', elfPath, vscode.ConfigurationTarget.Workspace);
  }

  private async browseElf() {
    const result = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      filters: { 'ELF Files': ['elf'] },
      title: 'Select ELF file for flashing',
    });
    if (result && result[0]) {
      const elfPath = result[0].fsPath;
      this.setElfPath(elfPath);
      this.view?.webview.postMessage({ command: 'elfSelected', elfPath });
    }
  }

  createStatusBar() {
    this.statusBar.text = '$(chip) Orbit Debug';
    this.statusBar.command = 'ozone.startSession';
    this.statusBar.tooltip = 'Orbit Debug Session Manager';
    this.statusBar.show();
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js')
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-eval' ${webview.cspSource}; script-src-elem ${webview.cspSource};">
  <style>
    :root {
      --bg: var(--vscode-sideBar-background);
      --fg: var(--vscode-sideBar-foreground);
      --border: var(--vscode-sideBar-border);
      --accent: var(--vscode-focusBorder);
    }
    body { margin: 0; padding: 8px; font-family: var(--vscode-font-family); background: var(--bg); color: var(--fg); }
    #root { height: 100%; }
  </style>
  <title>Orbit Debug</title>
</head>
<body>
  <div id="root"><div style="padding:12px;font-size:12px;color:var(--vscode-descriptionForeground)">Loading Orbit Debug...</div></div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose() {
    this.statusBar.dispose();
  }
}
