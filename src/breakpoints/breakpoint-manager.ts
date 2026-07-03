import * as vscode from 'vscode';
import { EventEmitter } from 'events';
import { OzoneBackend } from '../ozone-backend/commander';
import { Breakpoint } from '../ozone-backend/types';
import { BreakpointEvent } from './types';

export class BreakpointManager extends EventEmitter implements vscode.TreeDataProvider<BreakpointItem> {
  private breakpoints: Map<string, Breakpoint> = new Map();
  private nextId = 1;
  private _onDidChangeTreeData = new vscode.EventEmitter<BreakpointItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private backend: OzoneBackend) {
    super();
  }

  getTreeItem(element: BreakpointItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: BreakpointItem): BreakpointItem[] {
    if (element) return [];
    return Array.from(this.breakpoints.values()).map(bp => {
      const item = new BreakpointItem(bp);
      if (bp.file) {
        try {
          item.command = {
            command: 'vscode.open',
            title: 'Go to breakpoint',
            arguments: [vscode.Uri.file(bp.file), { selection: new vscode.Range(bp.line - 1, 0, bp.line - 1, 0) }],
          };
        } catch { }
      }
      return item;
    });
  }

  async toggleFromEditor(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const uri = editor.document.uri;
    const line = editor.selection.active.line + 1;
    const key = `${uri.fsPath}:${line}`;

    const existing = this.breakpoints.get(key);
    if (existing) {
      await this.remove(existing.id);
    } else {
      await this.add(uri.fsPath, line);
    }
  }

  async add(file: string, line: number, condition?: string): Promise<boolean> {
    const key = `${file}:${line}`;
    if (this.breakpoints.has(key)) return true;

    const result = await this.backend.execute({
      cmd: 'setBreakpoint', file, line, condition,
    });

    if (!result.ok) {
      vscode.window.showErrorMessage(`Failed to set breakpoint: ${result.error}`);
      return false;
    }

    const bp: Breakpoint = {
      id: this.nextId++,
      file,
      line,
      enabled: true,
      type: condition ? 'conditional' : 'software',
      condition,
      hitCount: 0,
    };

    this.breakpoints.set(key, bp);
    this._onDidChangeTreeData.fire(undefined);
    this.emit('changed', { type: 'added', breakpoint: bp } as BreakpointEvent);

    this.decorateEditor(file, line, true);
    return true;
  }

  async remove(id: number): Promise<boolean> {
    const entries = Array.from(this.breakpoints.entries());
    const entry = entries.find(([, bp]) => bp.id === id);
    if (!entry) return false;

    const [key, bp] = entry;
    await this.backend.execute({ cmd: 'clearBreakpoint', id });
    this.breakpoints.delete(key);
    this._onDidChangeTreeData.fire(undefined);
    this.emit('changed', { type: 'removed', breakpoint: bp } as BreakpointEvent);

    this.decorateEditor(bp.file, bp.line, false);
    return true;
  }

  async enable(id: number): Promise<void> {
    for (const bp of this.breakpoints.values()) {
      if (bp.id === id) {
        bp.enabled = true;
        this._onDidChangeTreeData.fire(undefined);
        break;
      }
    }
  }

  async disable(id: number): Promise<void> {
    for (const bp of this.breakpoints.values()) {
      if (bp.id === id) {
        bp.enabled = false;
        this._onDidChangeTreeData.fire(undefined);
        break;
      }
    }
  }

  private decorateEditor(file: string, line: number, active: boolean) {
    const editors = vscode.window.visibleTextEditors.filter(e => e.document.uri.fsPath === file);
    for (const editor of editors) {
      editor.setDecorations(this.getBreakpointDecoration(), [
        { range: new vscode.Range(line - 1, 0, line - 1, 0) },
      ]);
    }
  }

  private getBreakpointDecoration(): vscode.TextEditorDecorationType {
    const ext = vscode.extensions.getExtension('ozone-debug.ozone-for-vscode');
    const gutterIconPath = ext
      ? vscode.Uri.joinPath(ext.extensionUri, 'resources', 'breakpoint.svg')
      : undefined;
    return vscode.window.createTextEditorDecorationType({
      gutterIconPath,
      gutterIconSize: 'contain',
    });
  }

  getAll(): Breakpoint[] {
    return Array.from(this.breakpoints.values());
  }

  clear() {
    this.breakpoints.clear();
    this._onDidChangeTreeData.fire(undefined);
  }
}

class BreakpointItem extends vscode.TreeItem {
  constructor(public bp: Breakpoint) {
    super(`${bp.file}:${bp.line}`, vscode.TreeItemCollapsibleState.None);
    this.description = bp.type;
    this.tooltip = `${bp.file}:${bp.line}\nType: ${bp.type}\nHits: ${bp.hitCount}`;
    this.contextValue = 'breakpoint';

    this.iconPath = bp.enabled
      ? new vscode.ThemeIcon('circle-filled')
      : new vscode.ThemeIcon('circle-outline');
  }
}