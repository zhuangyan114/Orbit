import * as vscode from 'vscode';
import { OzoneBackend } from '../ozone-backend/commander';
import { StackFrame } from '../ozone-backend/types';

export class StackFrameProvider implements vscode.TreeDataProvider<StackFrameItem> {
  private frames: StackFrame[] = [];
  private _onDidChangeTreeData = new vscode.EventEmitter<StackFrameItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private backend: OzoneBackend) {}

  getTreeItem(element: StackFrameItem): vscode.TreeItem {
    return element;
  }

  getChildren(): StackFrameItem[] {
    return this.frames.map(f => new StackFrameItem(f));
  }

  async refresh() {
    const result = await this.backend.execute({ cmd: 'getCallStack' });
    if (result.ok) {
      this.frames = result.data as StackFrame[];
      this._onDidChangeTreeData.fire(undefined);
    }
  }
}

class StackFrameItem extends vscode.TreeItem {
  constructor(public frame: StackFrame) {
    super(`${frame.function}`, vscode.TreeItemCollapsibleState.None);

    this.description = frame.file ? `${frame.file}:${frame.line}` : `0x${frame.address.toString(16)}`;
    this.tooltip = `${frame.function}\n${frame.file}:${frame.line}\n0x${frame.address.toString(16)}`;
    this.contextValue = 'stackFrame';

    if (frame.file) {
      try {
        this.command = {
          command: 'vscode.open',
          title: 'Go to frame',
          arguments: [
            vscode.Uri.file(frame.file),
            { selection: new vscode.Range(frame.line - 1, 0, frame.line - 1, 0) },
          ],
        };
      } catch { }
    }
  }
}