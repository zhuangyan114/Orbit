import * as vscode from 'vscode';
import { OzoneBackend } from '../ozone-backend/commander';
import { WatchValue } from '../ozone-backend/types';

export class WatchWebviewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null;
  private _expressions: string[] = [];
  private _onExpressionsChanged: ((exprs: string[]) => void) | null = null;
  onSendToTimeline: ((exprs: string[]) => void) | null = null;

  get isVisible(): boolean {
    return this.view?.visible ?? false;
  }

  constructor(
    private context: vscode.ExtensionContext,
    private backend: OzoneBackend,
  ) {}

  get expressionList(): string[] {
    return this._expressions;
  }

  set onExpressionsChanged(cb: ((exprs: string[]) => void) | null) {
    this._onExpressionsChanged = cb;
  }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(msg => {
      switch (msg.command) {
        case 'init':
          this.postMessage({ command: 'init', watches: this._expressions.map(e => ({ expression: e })) });
          if (this._expressions.length > 0) {
            this.evaluateWatches(this._expressions);
          }
          break;
        case 'addExpression':
          this.addExpression(msg.expression);
          break;
        case 'removeExpression':
          this.removeExpression(msg.expression);
          break;
        case 'evaluateWatches':
          this.evaluateWatches(msg.expressions);
          break;
        case 'setWatchValue':
          this.setWatchValue(msg.expression, msg.value);
          break;
        case 'sendToTimeline':
          if (this.onSendToTimeline && msg.expressions?.length > 0) {
            this.onSendToTimeline(msg.expressions);
          }
          break;
      }
    });

    webviewView.onDidDispose(() => {
      this.view = null;
    });
  }

  setExpressions(expressions: string[]) {
    this._expressions = [...expressions];
    this.postMessage({ command: 'init', watches: this._expressions.map(e => ({ expression: e })) });
    if (this._onExpressionsChanged) {
      this._onExpressionsChanged(this._expressions);
    }
    if (this._expressions.length > 0) {
      this.evaluateWatches(this._expressions);
    }
  }

  addExpression(expr: string) {
    if (!expr || this._expressions.includes(expr)) return;
    this._expressions = [...this._expressions, expr];
    this.postMessage({ command: 'init', watches: this._expressions.map(e => ({ expression: e })) });
    if (this._onExpressionsChanged) {
      this._onExpressionsChanged(this._expressions);
    }
  }

  removeExpression(expr: string) {
    this._expressions = this._expressions.filter(e => e !== expr);
    this.postMessage({ command: 'init', watches: this._expressions.map(e => ({ expression: e })) });
    if (this._onExpressionsChanged) {
      this._onExpressionsChanged(this._expressions);
    }
  }

  sendWatchResults(results: WatchValue[]) {
    this.postMessage({ command: 'watchResults', results });
  }

  private async evaluateWatches(expressions: string[]) {
    let results: WatchValue[] | null = null;
    const session = vscode.debug.activeDebugSession;
    if (session && session.type === 'ozone') {
      try {
        const r: any = await session.customRequest('dataSample', { expressions });
        if (r && r.results) {
          results = r.results as WatchValue[];
        }
      } catch {}
    }

    if (!results) {
      results = [];
      for (const expr of expressions) {
        const result = await this.backend.execute({ cmd: 'evaluateExpression', expression: expr, force: true });
        if (result.ok) {
          results.push(result.data as WatchValue);
        } else {
          results.push({ expression: expr, value: 0, display: '', hex: '', error: result.error });
        }
      }
    }
    this.postMessage({ command: 'watchResults', results });
  }

  private async setWatchValue(expression: string, value: number) {
    let result: any;
    // Route through active DAP session when debugging, same as readWatchValues
    const session = vscode.debug.activeDebugSession;
    if (session && session.type === 'ozone') {
      try {
        const r: any = await session.customRequest('setWatchValue', { expression, value });
        result = r && r.ok !== undefined ? r : { ok: true, data: r };
      } catch (e: any) {
        result = { ok: false, error: e.message || 'DAP setWatchValue failed' };
      }
    } else {
      result = await this.backend.execute({ cmd: 'setWatchValue', expression, value });
    }
    this.postMessage({
      command: 'watchValueSet',
      expression,
      ok: result.ok,
      error: result.ok ? undefined : result.error,
    });
  }

  private postMessage(msg: any) {
    try {
      this.view?.webview.postMessage(msg);
    } catch { }
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'watch.js')
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-eval' ${webview.cspSource}; script-src-elem ${webview.cspSource};">
  <style>
    :root {
      --bg: var(--vscode-sideBar-background, #1e1e1e);
      --fg: var(--vscode-sideBar-foreground, #cccccc);
      --border: var(--vscode-sideBar-border, #333333);
    }
    body { margin: 0; padding: 0; font-family: var(--vscode-font-family, sans-serif); background: var(--bg); color: var(--fg); font-size: 12px; overflow: hidden; }
    #root { height: 100vh; display: flex; flex-direction: column; }
    .watch-row:hover .watch-actions { opacity: 1 !important; }
    .watch-row:hover { background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.06)); border-left: 2px solid var(--vscode-focusBorder, #007acc); }
    .watch-row { border-left: 2px solid transparent; transition: background 0.1s, border-color 0.1s; }
  </style>
  <title>Ozone Watch</title>
</head>
<body>
  <div id="root">Loading...</div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
  }
}
