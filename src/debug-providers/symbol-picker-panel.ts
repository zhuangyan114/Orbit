import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { canSelectSymbol, symbolChildren, type SymbolCatalog, type SymbolNode } from '../symbols/symbol-catalog';

export interface SymbolPickerRequest {
  mode: 'watch' | 'timeline';
  title: string;
  existing: string[];
  loadCatalog: () => Promise<SymbolCatalog>;
  canOpen: () => boolean;
  commit: (expressions: string[], removedExpressions?: string[]) => void | Promise<void>;
}
interface SelectionPanel {
  panel: vscode.WebviewPanel;
  request: SymbolPickerRequest;
  catalog: SymbolCatalog;
  token: number;
  listeners: vscode.Disposable[];
  closed: boolean;
}

/** One shared editor panel. Only an explicit Add action commits the current selection. */
export class SymbolPickerPanel implements vscode.Disposable {
  private current?: SelectionPanel;
  private generation = 0;
  private disposed = false;

  constructor(private context: Pick<vscode.ExtensionContext, 'extensionUri'>) {}

  async open(request: SymbolPickerRequest): Promise<void> {
    if (this.disposed) return;
    const token = ++this.generation;
    if (this.current) this.close(this.current);
    try {
      const catalog = await request.loadCatalog();
      if (this.disposed || token !== this.generation || !request.canOpen()) return;
      const panel = vscode.window.createWebviewPanel('orbit.symbolPicker', request.title,
        { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
        { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [this.context.extensionUri] });
      const state: SelectionPanel = { panel, request, catalog, token, listeners: [], closed: false };
      this.current = state;
      state.listeners.push(
        panel.webview.onDidReceiveMessage(message => this.handleMessage(state, message)),
        panel.onDidDispose(() => this.finish(state)),
        panel.onDidChangeViewState(event => { if (!event.webviewPanel.active) this.close(state); }),
        vscode.debug.onDidChangeActiveDebugSession(() => { if (catalog.source !== 'recording') this.close(state); }),
        vscode.debug.onDidTerminateDebugSession(() => { if (catalog.source !== 'recording') this.close(state); }),
      );
      panel.webview.html = this.getHtml(panel.webview);
    } catch (error) {
      if (!this.disposed && token === this.generation && request.canOpen()) {
        void vscode.window.showErrorMessage('变量选择：' + (error instanceof Error ? error.message : String(error)));
      }
    }
  }

  private handleMessage(state: SelectionPanel, message: any) {
    if (state.closed || this.current !== state || !message || typeof message !== 'object') return;
    if (message.command === 'ready') {
      void state.panel.webview.postMessage({ command: 'init', token: state.token, catalog: state.catalog,
        mode: state.request.mode, title: state.request.title, existing: state.request.existing });
      return;
    }
    if (message.token !== state.token) return;
    if (message.command === 'close') {
      this.close(state);
      return;
    }
    if (message.command === 'add') {
      const expressions = this.validateSelection(state, Array.isArray(message.selectedIds) ? message.selectedIds : []);
      // Apply only explicit removals from the opening snapshot. Filtering, lazy loading,
      // and expressions not represented in ELF metadata must never imply deletion.
      const existing = new Set(state.request.existing);
      const removedExpressions = [...new Set<string>((Array.isArray(message.removedExpressions) ? message.removedExpressions : [])
        .slice(0, 10000).filter((expression: unknown): expression is string => typeof expression === 'string' && existing.has(expression)))];
      this.close(state);
      if (!expressions.length && !removedExpressions.length) return;
      try {
        void Promise.resolve(state.request.commit(expressions, removedExpressions)).catch(error => {
          void vscode.window.showErrorMessage('更新变量失败：' + String(error));
        });
      } catch (error) { void vscode.window.showErrorMessage('更新变量失败：' + String(error)); }
    }
  }

  private validateSelection(state: SelectionPanel, ids: unknown[]): string[] {
    const selected = new Map<string, SymbolNode>();
    const roots = new Map(state.catalog.roots.map(node => [node.id, node]));
    for (const id of ids.slice(0, 10000)) {
      if (typeof id !== 'string') continue;
      const parts = id.split('/');
      if (parts.length > 13) continue;
      let node = roots.get(parts[0]);
      for (const part of parts.slice(1)) {
        if (!node || !/^(0|[1-9]\d*)$/.test(part) || !Number.isSafeInteger(Number(part))) { node = undefined; break; }
        node = symbolChildren(state.catalog, node, Number(part), 1)[0];
      }
      if (node && node.id === id && canSelectSymbol(state.catalog, node, state.request.mode)
        && !state.request.existing.includes(node.expression)) selected.set(node.expression, node);
    }
    return [...selected.keys()];
  }

  private close(state: SelectionPanel) {
    if (state.closed) return;
    this.finish(state);
    state.panel.dispose();
  }

  private finish(state: SelectionPanel) {
    if (state.closed) return;
    state.closed = true;
    if (this.current === state) this.current = undefined;
    for (const listener of state.listeners) listener.dispose();
  }

  private getHtml(webview: vscode.Webview): string {
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'symbol-picker.js'));
    const nonce = randomBytes(16).toString('hex');
    return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>body{margin:0;padding:0;background:var(--vscode-editor-background);color:var(--vscode-foreground);font:12px var(--vscode-font-family,sans-serif);overflow:hidden}
body.vscode-dark,body.vscode-high-contrast{color-scheme:dark}body.vscode-light,body.vscode-high-contrast-light{color-scheme:light}#root{height:100vh}</style>
<title>选择变量</title></head><body><div id="root"></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.generation++;
    if (this.current) this.close(this.current);
  }
}
