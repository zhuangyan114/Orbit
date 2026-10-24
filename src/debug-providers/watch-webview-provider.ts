import * as vscode from 'vscode';
import { OzoneBackend } from '../ozone-backend/commander';
import { WatchValue } from '../ozone-backend/types';
import { stripHanCharacters } from '../utils/watch-expression-validation';
import { isOrbitDebugSessionType } from '../utils/debug-session-type';
import { normalizeWatchExpressions, WatchGroups, WATCH_GROUPS_STATE_KEY } from './watch-groups';

const WATCH_EXPANDED_STATE_KEY = 'ozoneWatchExpandedExpressions';

export class WatchWebviewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null;
  private groups: WatchGroups;
  private groupGeneration = 0;
  private _onExpressionsChanged: ((exprs: string[]) => void) | null = null;
  onSendToTimeline: ((exprs: string[]) => void) | null = null;

  get isVisible(): boolean {
    return this.view?.visible ?? false;
  }

  constructor(
    private context: vscode.ExtensionContext,
    private backend: OzoneBackend,
    private canUseDapSession: (session: vscode.DebugSession) => boolean = () => true,
  ) {
    this.groups = new WatchGroups(
      context.workspaceState.get<unknown>(WATCH_GROUPS_STATE_KEY),
      context.workspaceState.get<unknown>('ozoneWatchExpressions', []),
      context.workspaceState.get<unknown>(WATCH_EXPANDED_STATE_KEY, []),
    );
  }

  get expressionList(): string[] {
    return [...this.groups.active.expressions];
  }

  get expandedExpressions(): string[] {
    return [...this.groups.active.expandedExpressions];
  }

  get generation(): number { return this.groupGeneration; }
  get activeGroupId(): string { return this.groups.active.id; }

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

    webviewView.webview.onDidReceiveMessage(msg => this.handleMessage(msg));

    webviewView.onDidDispose(() => {
      this.view = null;
    });
  }

  private handleMessage(msg: any) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.command !== 'init' && msg.groupId !== undefined
      && (msg.groupId !== this.activeGroupId || msg.watchGeneration !== this.generation)) return;
    switch (msg.command) {
      case 'init':
        this.postInit();
        if (this.expressionList.length > 0) void this.evaluateWatches(this.expressionList);
        break;
      case 'addGroup': this.addGroup(); break;
      case 'selectGroup': this.selectGroup(msg.id); break;
      case 'removeGroup': this.removeGroup(msg.id); break;
      case 'renameGroup': this.renameGroup(msg.id, msg.name); break;
      case 'addExpression':
        this.addExpression(msg.expression);
        break;
      case 'removeExpression':
        this.removeExpression(msg.expression);
        break;
      case 'evaluateWatches':
        void this.evaluateWatches(msg.expressions);
        break;
      case 'setWatchValue':
        void this.setWatchValue(msg.expression, msg.value, msg.address, msg.typeName);
        break;
      case 'setExpandedExpressions':
        this.setExpandedExpressions(msg.expressions);
        break;
      case 'sendToTimeline':
        if (this.onSendToTimeline && msg.expressions?.length > 0) this.onSendToTimeline(msg.expressions);
        break;
    }
  }

  setExpressions(expressions: string[]) {
    this.groups.active.expressions = normalizeWatchExpressions(expressions);
    this.publishActiveGroup();
  }

  addExpression(expr: string) {
    const sanitized = stripHanCharacters(String(expr || '')).trim();
    if (!sanitized || this.expressionList.includes(sanitized)) return;
    this.groups.active.expressions.push(sanitized);
    this.publishActiveGroup();
  }

  removeExpression(expr: string) {
    if (!this.expressionList.includes(expr)) return;
    this.groups.active.expressions = this.expressionList.filter(e => e !== expr);
    this.publishActiveGroup();
  }

  addGroup() { this.groups.add(); this.publishActiveGroup(); }
  selectGroup(id: string) { if (this.groups.select(id)) this.publishActiveGroup(); }
  removeGroup(id: string) {
    const previous = this.activeGroupId;
    if (!this.groups.remove(id)) return;
    if (previous !== this.activeGroupId) this.publishActiveGroup();
    else { this.persistGroups(); this.postMessage({ command: 'watchGroups', ...this.groupMetadata() }); }
  }
  renameGroup(id: string, name: unknown) {
    if (!this.groups.rename(id, name)) return;
    this.persistGroups();
    this.postMessage({ command: 'watchGroups', ...this.groupMetadata() });
  }
  private persistGroups() {
    void this.context.workspaceState.update(WATCH_GROUPS_STATE_KEY, this.groups.snapshot());
    // Keep the active group's legacy keys compatible with existing integrations.
    void this.context.workspaceState.update('ozoneWatchExpressions', this.expressionList);
    void this.context.workspaceState.update(WATCH_EXPANDED_STATE_KEY, this.expandedExpressions);
  }
  private publishActiveGroup() {
    this.groupGeneration++;
    this.persistGroups();
    this.postInit();
    this._onExpressionsChanged?.(this.expressionList);
    if (this.expressionList.length > 0) void this.evaluateWatches(this.expressionList);
  }
  private groupMetadata() {
    return { groups: this.groups.snapshot().groups.map(group => ({ id: group.id, name: group.name })),
      activeGroupId: this.activeGroupId, watchGeneration: this.generation };
  }
  sendWatchResults(results: WatchValue[], generation = this.generation) {
    if (generation !== this.generation) return;
    this.postMessage({ command: 'watchResults', results, groupId: this.activeGroupId, watchGeneration: generation });
  }

  private async evaluateWatches(expressions: string[]) {
    const generation = this.generation;
    expressions = normalizeWatchExpressions(expressions);
    let results: WatchValue[] | null = null;
    const session = vscode.debug.activeDebugSession;
    if (session && isOrbitDebugSessionType(session.type)) {
      if (!this.canUseDapSession(session)) {
        results = expressions.map(expression => ({
          expression,
          value: 0,
          display: '',
          hex: '',
          error: 'Debug session is not available',
        }));
      } else {
        try {
          const r: any = await session.customRequest('dataSample', {
            expressions,
            expandedExpressions: this.expandedExpressions,
          });
          if (generation !== this.generation || vscode.debug.activeDebugSession !== session || !this.canUseDapSession(session)) return;
          if (r && r.results) {
            results = r.results as WatchValue[];
          } else {
            results = expressions.map(expression => ({ expression, value: 0, display: '', hex: '', error: 'DAP dataSample returned no results' }));
          }
        } catch (err: any) {
          const error = err?.message || 'DAP dataSample failed';
          results = expressions.map(expression => ({ expression, value: 0, display: '', hex: '', error }));
        }
      }
    }

    if (!results && !this.backend.hasTargetConnection) {
      results = expressions.map(expression => ({
        expression,
        value: 0,
        display: '',
        hex: '',
        error: 'No active Orbit debug session',
      }));
    }

    if (!results) {
      results = [];
      for (const expr of expressions) {
        if (generation !== this.generation) return;
        const result = await this.backend.execute({
          cmd: 'evaluateExpression',
          expression: expr,
          force: true,
          expandedExpressions: this.expandedExpressions,
        });
        if (result.ok) {
          results.push(result.data as WatchValue);
        } else {
          results.push({ expression: expr, value: 0, display: '', hex: '', error: result.error });
        }
      }
    }
    if (vscode.debug.activeDebugSession !== session) return;
    if (session && isOrbitDebugSessionType(session.type) && !this.canUseDapSession(session)) return;
    this.sendWatchResults(results, generation);
  }

  private setExpandedExpressions(expressions: unknown) {
    this.groups.active.expandedExpressions = normalizeWatchExpressions(expressions);
    this.persistGroups();
    if (this.expressionList.length > 0) void this.evaluateWatches(this.expressionList);
  }

  private async setWatchValue(expression: string, value: number, address?: number, typeName?: string) {
    const generation = this.generation;
    let result: any;
    // Route through active DAP session when debugging, same as readWatchValues
    const session = vscode.debug.activeDebugSession;
    if (session && isOrbitDebugSessionType(session.type)) {
      if (!this.canUseDapSession(session)) {
        result = { ok: false, error: 'Debug session is not available' };
      } else {
        try {
          const r: any = await session.customRequest('setWatchValue', { expression, value, address, typeName });
          if (generation !== this.generation || vscode.debug.activeDebugSession !== session || !this.canUseDapSession(session)) return;
          result = r && r.ok !== undefined ? r : { ok: true, data: r };
        } catch (e: any) {
          if (generation !== this.generation || vscode.debug.activeDebugSession !== session || !this.canUseDapSession(session)) return;
          result = { ok: false, error: e.message || 'DAP setWatchValue failed' };
        }
      }
    } else if (this.backend.hasTargetConnection) {
      result = await this.backend.execute({ cmd: 'setWatchValue', expression, value, address, typeName });
    } else {
      result = { ok: false, error: 'No active Orbit debug session' };
    }
    if (generation !== this.generation) return;
    this.postMessage({
      command: 'watchValueSet',
      groupId: this.activeGroupId,
      watchGeneration: generation,
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

  private postInit() {
    this.postMessage({
      command: 'init',
      ...this.groupMetadata(),
      watches: this.expressionList.map(e => ({ expression: e })),
      expandedExpressions: this.expandedExpressions,
    });
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
  <title>Orbit Watch</title>
</head>
<body>
  <div id="root">Loading...</div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
  }
}
