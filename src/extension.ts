import * as vscode from 'vscode';
import { OzoneBackend } from './ozone-backend/commander';
import { SessionManager } from './session/session-manager';
import { BreakpointManager } from './breakpoints/breakpoint-manager';
import { VariableProvider } from './debug-providers/variable-provider';
import { StackFrameProvider } from './debug-providers/stack-frame-provider';
import { MemoryProvider } from './debug-providers/memory-provider';
import { AIProviderManager } from './ai/ai-provider-manager';
import { DebugWebviewProvider } from './webview/webview-provider';
import { findElfFiles } from './ozone-backend/flasher';
import { OzoneDebugConfigurationProvider } from './debug/ozone-debug-config';
import * as path from 'path';
import * as fs from 'fs';

let backend: OzoneBackend;
let sessionManager: SessionManager;
let breakpointManager: BreakpointManager;
let variableProvider: VariableProvider;
let stackFrameProvider: StackFrameProvider;
let memoryProvider: MemoryProvider;
let aiProviderManager: AIProviderManager;
let webviewProvider: DebugWebviewProvider;

function refreshAllViews() {
  variableProvider.refresh();
  stackFrameProvider.refresh();
  webviewProvider.refresh();
}

async function openTopFrameFromFile(file?: string, line?: number) {
  if (!file || !line || line <= 0) return;
  try {
    const uri = vscode.Uri.file(file);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, {
      selection: new vscode.Range(line - 1, 0, line - 1, 0),
      preserveFocus: false,
    });
  } catch { }
}

async function openTopFrame() {
  const result = await backend.execute({ cmd: 'getCallStack' });
  if (!result.ok) return;
  const frames = result.data as import('./ozone-backend/types').StackFrame[];
  const top = frames[0];
  if (!top || !top.file || top.line <= 0) return;
  try {
    const uri = vscode.Uri.file(top.file);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, {
      selection: new vscode.Range(top.line - 1, 0, top.line - 1, 0),
      preserveFocus: true,
    });
  } catch { }
}

export function activate(context: vscode.ExtensionContext) {
  try {
    console.log('[Ozone] activate start');
    const b = new OzoneBackend();
    backend = b;
    console.log('[Ozone] backend ok');
    const sm = new SessionManager(b);
    sessionManager = sm;
    console.log('[Ozone] sessionManager ok');
    const bm = new BreakpointManager(b);
    breakpointManager = bm;
    console.log('[Ozone] breakpointManager ok');
    const vp = new VariableProvider(b);
    variableProvider = vp;
    console.log('[Ozone] variableProvider ok');
    const sf = new StackFrameProvider(b);
    stackFrameProvider = sf;
    console.log('[Ozone] stackFrameProvider ok');
    const mp = new MemoryProvider(b);
    memoryProvider = mp;
    console.log('[Ozone] memoryProvider ok');
    const ai = new AIProviderManager(context);
    aiProviderManager = ai;
    console.log('[Ozone] aiProviderManager ok');
    const wv = new DebugWebviewProvider(context, b);
    webviewProvider = wv;
    console.log('[Ozone] webviewProvider ok');

    context.subscriptions.push(
    vscode.commands.registerCommand('ozone.startSession', async () => {
      await sessionManager.start();
      refreshAllViews();
    }),
vscode.commands.registerCommand('ozone.stopSession', async () => {
    await sessionManager.stop();
    await backend.execute({ cmd: 'disconnect' });
    refreshAllViews();
  }),
    vscode.commands.registerCommand('ozone.restartSession', () => sessionManager.restart()),

    vscode.commands.registerCommand('ozone.halt', async () => {
      const result = await backend.execute({ cmd: 'halt' });
      if (result.ok) {
        refreshAllViews();
        openTopFrame();
      }
    }),
    vscode.commands.registerCommand('ozone.run', async () => {
      const result = await backend.execute({ cmd: 'run' });
      if (result.ok) refreshAllViews();
    }),
    vscode.commands.registerCommand('ozone.stepInto', async () => {
      const result = await backend.execute({ cmd: 'stepInto' });
      if (result.ok) {
        refreshAllViews();
        openTopFrame();
      }
    }),
    vscode.commands.registerCommand('ozone.stepOver', async () => {
      const result = await backend.execute({ cmd: 'stepOver' });
      if (result.ok) {
        refreshAllViews();
        openTopFrame();
      }
    }),
    vscode.commands.registerCommand('ozone.stepOut', async () => {
      const result = await backend.execute({ cmd: 'stepOut' });
      if (result.ok) {
        refreshAllViews();
        openTopFrame();
      }
    }),
vscode.commands.registerCommand('ozone.reset', async () => {
    const result = await backend.execute({ cmd: 'reset' });
    if (result.ok) {
      await backend.execute({ cmd: 'run' });
      refreshAllViews();
    }
  }),

    vscode.commands.registerCommand('ozone.toggleBreakpoint', () => breakpointManager.toggleFromEditor()),
    vscode.commands.registerCommand('ozone.openAIChat', () => webviewProvider.showAIPanel()),
    vscode.commands.registerCommand('ozone.openMemoryBrowser', () => webviewProvider.showMemoryPanel()),

    vscode.window.registerTreeDataProvider('ozoneBreakpoints', breakpointManager),
    vscode.window.registerTreeDataProvider('ozoneVariables', variableProvider),
    vscode.window.registerTreeDataProvider('ozoneCallStack', stackFrameProvider),
    vscode.window.registerTreeDataProvider('ozoneRegisters', variableProvider),

    vscode.commands.registerCommand('ozone.debug', async () => {
      const config = vscode.workspace.getConfiguration('ozone');
      let elfPath = config.get<string>('_elfPath', '');
      const device = config.get<string>('defaultDevice', 'STM32F407VG');
      const interface_ = config.get<'SWD' | 'JTAG'>('defaultInterface', 'SWD');
      const speedKHz = config.get<number>('defaultSpeed', 4000);

      if (!elfPath || !fs.existsSync(elfPath)) {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (workspaceRoot) {
          const candidates = findElfFiles(workspaceRoot);
          if (candidates.length === 1) {
            elfPath = candidates[0].path;
          } else if (candidates.length > 1) {
            const pick = await vscode.window.showQuickPick(
              candidates.map(c => ({ label: c.label, description: c.description, detail: c.path })),
              { title: 'Select ELF for debug', placeHolder: 'Choose an ELF file' }
            );
            if (pick) elfPath = (pick as any).detail;
          }
        }
      }
      if (!elfPath || !fs.existsSync(elfPath)) {
        vscode.window.showErrorMessage('Ozone: No ELF file found. Configure it in the settings panel first.');
        return;
      }

      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Ozone: Connecting to ${device}...`,
        cancellable: false,
      }, async () => {
        const connectResult = await backend.execute({ cmd: 'connect', config: { device, interface: interface_, speedKHz } });
        if (!connectResult.ok) {
          vscode.window.showErrorMessage(`Ozone: ${connectResult.error}`);
          return;
        }
        const loadResult = await backend.execute({ cmd: 'loadSymbols', elfPath });
        if (loadResult.ok) {
          vscode.window.showInformationMessage(`Ozone: Connected to ${device}, loaded ${(loadResult.data as string)}`);
        }
        webviewProvider.refresh();
      });
    }),

    vscode.commands.registerCommand('ozone.flash', async () => {
      const config = vscode.workspace.getConfiguration('ozone');
      let elfPath = config.get<string>('_elfPath', '');
      const device = config.get<string>('defaultDevice', 'STM32F407VG');
      const interface_ = config.get<'SWD' | 'JTAG'>('defaultInterface', 'SWD');
      const speedKHz = config.get<number>('defaultSpeed', 4000);

      if (!elfPath || !fs.existsSync(elfPath)) {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
          vscode.window.showErrorMessage('Ozone: No workspace folder open');
          return;
        }

        const candidates = findElfFiles(workspaceRoot);
        if (candidates.length === 0) {
          const pick = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            filters: { 'ELF Files': ['elf'] },
            title: 'Select ELF file to flash',
          });
          if (!pick) return;
          elfPath = pick[0].fsPath;
        } else if (candidates.length === 1) {
          elfPath = candidates[0].path;
        } else {
          const pick = await vscode.window.showQuickPick(
            candidates.map(c => ({ label: c.label, description: c.description, detail: c.path })),
            { title: 'Select ELF to flash', placeHolder: 'Choose an ELF file' }
          );
          if (!pick) return;
          elfPath = (pick as any).detail;
        }
      }

      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Ozone: Flashing ${path.basename(elfPath)}...`,
        cancellable: false,
      }, async () => {
        const result = await backend.execute({ cmd: 'flash', elfPath, device, interface: interface_, speedKHz });
        if (result.ok) {
          vscode.window.showInformationMessage(`$(check) Ozone: ${(result.data as any).message}`);
        } else {
          vscode.window.showErrorMessage(`Ozone: ${result.error}`);
        }
      });
    }),

    vscode.window.registerWebviewViewProvider('ozoneDebugSession', webviewProvider),
  );

  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider('ozone', new OzoneDebugConfigurationProvider()),
    vscode.debug.registerDebugAdapterTrackerFactory('ozone', {
      createDebugAdapterTracker(session) {
        let waitingForStackTrace = false;

        return {
          onDidSendMessage(message: any) {
            if (message.type === 'event' && message.event === 'stopped') {
              waitingForStackTrace = true;
            }

            if (waitingForStackTrace && message.type === 'response' && message.command === 'stackTrace' && message.success) {
              const frames = message.body?.stackFrames || [];
              if (frames.length > 0) {
                const topFrame = frames[0];
                const file = topFrame.source?.path;
                const line = topFrame.line;
                if (file && line && line > 0) {
                  waitingForStackTrace = false;
                  openTopFrameFromFile(file, line);
                }
              }
            }
          },
        };
      },
    }),
  );

  webviewProvider.createStatusBar();
  } catch (e: any) {
    console.error('[Ozone] activate FAILED:', e.message);
    console.error('[Ozone] stack:', e.stack);
    vscode.window.showErrorMessage(`Ozone activation failed: ${e.message}`);
    return;
  }
}

export function deactivate() {
  sessionManager?.dispose();
  aiProviderManager?.dispose();
  webviewProvider?.dispose();
}