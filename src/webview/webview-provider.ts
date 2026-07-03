import * as vscode from 'vscode';
import { OzoneBackend } from '../ozone-backend/commander';
import { TargetState, RegisterValue } from '../ozone-backend/types';

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
          vscode.commands.executeCommand('workbench.action.openSettings', '@ext:ozone-debug.ozone-for-vscode');
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
    const config = vscode.workspace.getConfiguration('ozone');
    const wsFolders = vscode.workspace.workspaceFolders;
    const workspaceRoot = wsFolders?.[0]?.uri.fsPath || '';
    const device = config.get<string>('defaultDevice', 'STM32F407VG');
    const elfPath = config.get<string>('_elfPath', '');
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
    vscode.workspace.getConfiguration('ozone').update('defaultDevice', device, vscode.ConfigurationTarget.Global);
  }

  private setElfPath(elfPath: string) {
    vscode.workspace.getConfiguration('ozone').update('_elfPath', elfPath, vscode.ConfigurationTarget.Workspace);
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
    this.statusBar.text = '$(chip) Ozone Debug';
    this.statusBar.command = 'ozone.startSession';
    this.statusBar.tooltip = 'Ozone Debug Session Manager';
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
  <title>Ozone Debug</title>
</head>
<body>
  <div id="root"><div style="padding:12px;font-size:12px;color:var(--vscode-descriptionForeground)">Loading Ozone Debug...</div></div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose() {
    this.statusBar.dispose();
  }
}