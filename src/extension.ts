import * as vscode from 'vscode';
import { OzoneBackend } from './ozone-backend/commander';
import { WatchProvider } from './debug-providers/watch-provider';
import { WatchWebviewProvider } from './debug-providers/watch-webview-provider';
import { TimelineWebviewProvider } from './webview/timeline/timeline-provider';
import { DataSamplingManager } from './debug-providers/data-sampling-manager';
import { findElfFiles } from './ozone-backend/flasher';
import * as fs from 'fs';

let backend: OzoneBackend;
let watchProvider: WatchProvider;
let watchWebviewProvider: WatchWebviewProvider;
let dataSamplingManager: DataSamplingManager;
let timelineProvider: TimelineWebviewProvider;
let watchPollTimer: NodeJS.Timeout | null = null;

export function activate(context: vscode.ExtensionContext) {
  try {
    const b = new OzoneBackend();
    backend = b;

    const wp = new WatchProvider();
    watchProvider = wp;

    const wvp = new WatchWebviewProvider(context, backend);
    watchWebviewProvider = wvp;
    wvp.onExpressionsChanged = (exprs) => {
      wp.setExpressions(exprs);
      context.workspaceState.update('ozoneWatchExpressions', exprs);
    };
    const saved = context.workspaceState.get<string[]>('ozoneWatchExpressions', []);
    if (saved.length > 0) {
      wvp.setExpressions(saved);
      wp.setExpressions(saved);
    }

    const dsm = new DataSamplingManager(b);
    dataSamplingManager = dsm;
    dsm.onExpressionsChanged = (exprs) => {
      context.workspaceState.update('ozoneDataSamplingExpressions', exprs);
    };
    wvp.onSendToTimeline = (exprs) => {
      for (const e of exprs) dsm.addExpression(e);
      vscode.commands.executeCommand('workbench.view.ozone-timeline-panel');
    };
    const dsSaved = context.workspaceState.get<any[]>('ozoneDataSamplingExpressions', []);
    if (dsSaved.length > 0) {
      try { dsm.setExpressions(dsSaved); } catch { dsm.setExpressions([]); }
    }

    const tl = new TimelineWebviewProvider(context, dsm);
    timelineProvider = tl;

    // 激活时自动检测 .elf/.axf，写入设置
    const ozCfg = vscode.workspace.getConfiguration('ozone');
    if (!ozCfg.get<string>('defaultProgram') || !fs.existsSync(ozCfg.get<string>('defaultProgram', ''))) {
      const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (wsRoot) {
        const candidates = findElfFiles(wsRoot);
        if (candidates.length >= 1) {
          ozCfg.update('defaultProgram', candidates[0].path, vscode.ConfigurationTarget.Workspace);
        }
      }
    }

    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider('ozoneWatch', wvp),
      vscode.window.registerWebviewViewProvider('ozoneTimeline', timelineProvider),

      vscode.commands.registerCommand('ozone.addWatch', async () => {
        const expr = await vscode.window.showInputBox({
          prompt: '输入要监视的变量名或表达式',
          placeHolder: '例如: myVar',
        });
        if (!expr) return;
        const current = wvp.expressionList;
        if (current.includes(expr)) return;
        wvp.setExpressions([...current, expr]);
        wp.setExpressions([...current, expr]);
      }),

      vscode.commands.registerCommand('ozone.removeWatch', async (item) => {
        const expr = item?.watch?.expression;
        if (!expr) return;
        const current = wvp.expressionList;
        wvp.setExpressions(current.filter(e => e !== expr));
        wp.setExpressions(current.filter(e => e !== expr));
      }),

      vscode.commands.registerCommand('ozone.openTimeline', () => {
        vscode.commands.executeCommand('workbench.view.ozone-timeline-panel');
      }),

      vscode.commands.registerCommand('ozone.openSettings', () => {
        vscode.commands.executeCommand('workbench.action.openSettings', '@ext:ozone-debug.ozone-for-vscode');
      }),

      vscode.commands.registerCommand('ozone.addToDataSampling', async (item) => {
        const expr = item?.watch?.expression || item;
        if (!expr || typeof expr !== 'string') return;
        dataSamplingManager.addExpression(expr);
        vscode.commands.executeCommand('workbench.view.ozone-timeline-panel');
        vscode.commands.executeCommand('workbench.view.extension.ozone-timeline-panel');
      }),

      vscode.commands.registerCommand('ozone.debug', async () => {
        const config = vscode.workspace.getConfiguration('ozone');
        let elfPath = config.get<string>('defaultProgram', '');
        const device = config.get<string>('defaultDevice', 'STM32F407VG');
        const interface_ = config.get<'SWD' | 'JTAG'>('defaultInterface', 'SWD');
        const speedKHz = config.get<number>('defaultSpeed', 4000);

        if (!elfPath || !fs.existsSync(elfPath)) {
          const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          if (workspaceRoot) {
            const candidates = findElfFiles(workspaceRoot);
            if (candidates.length === 1) {
              elfPath = candidates[0].path;
              config.update('defaultProgram', elfPath, vscode.ConfigurationTarget.Workspace);
            } else if (candidates.length > 1) {
              const pick = await vscode.window.showQuickPick(
                candidates.map(c => ({ label: c.label, description: c.description, detail: c.path })),
                { title: 'Select ELF for debug', placeHolder: 'Choose an ELF file' }
              );
              if (pick) {
                elfPath = (pick as any).detail;
                config.update('defaultProgram', elfPath, vscode.ConfigurationTarget.Workspace);
              }
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
          startWatchPolling();
        });
      }),
    );

    startWatchPolling();
  } catch (e: any) {
    console.error('[Ozone] activate FAILED:', e.message);
    console.error('[Ozone] stack:', e.stack);
    vscode.window.showErrorMessage(`Ozone activation failed: ${e.message}`);
  }
}

async function readWatchValues(exprs: string[]): Promise<any[]> {
  const session = vscode.debug.activeDebugSession;
  if (session && session.type === 'ozone') {
    try {
      const r: any = await session.customRequest('dataSample', { expressions: exprs });
      if (r && r.results) return r.results;
    } catch {}
  }
  const results: any[] = [];
  for (const expr of exprs) {
    try {
      const r = await backend.execute({ cmd: 'evaluateExpression', expression: expr, force: true });
      if (r.ok) results.push(r.data);
      else results.push({ expression: expr, value: 0, display: '', hex: '', error: r.error });
    } catch { results.push({ expression: expr, value: 0, display: '', hex: '', error: 'err' }); }
  }
  return results;
}

function startWatchPolling() {
  stopWatchPolling();
  const loop = async () => {
    if (watchPollTimer === null) return;
    try {
      const expressions = watchProvider?.watches.map(w => w.expression) || [];
      if (expressions.length === 0) { watchPollTimer = setTimeout(loop, 200); return; }
      const results = await readWatchValues(expressions);
      if (results.length > 0) {
        watchProvider?.updateResults(results);
        watchWebviewProvider?.sendWatchResults(results as any);
      }
    } catch {}
    if (watchPollTimer !== null) watchPollTimer = setTimeout(loop, 200);
  };
  watchPollTimer = setTimeout(loop, 200);
}

function stopWatchPolling() {
  if (watchPollTimer) { clearTimeout(watchPollTimer); watchPollTimer = null; }
}

export function deactivate() {
  stopWatchPolling();
  dataSamplingManager?.dispose();
}
