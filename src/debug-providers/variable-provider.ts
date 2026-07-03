import * as vscode from 'vscode';
import { OzoneBackend } from '../ozone-backend/commander';
import { Variable } from '../ozone-backend/types';

export class VariableProvider implements vscode.TreeDataProvider<VariableItem> {
  private variables: Variable[] = [];
  private _onDidChangeTreeData = new vscode.EventEmitter<VariableItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private backend: OzoneBackend) {}

  getTreeItem(element: VariableItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: VariableItem): VariableItem[] {
    if (element?.variable.children) {
      return element.variable.children.map(v => new VariableItem(v));
    }
    return this.variables.map(v => new VariableItem(v));
  }

  async refresh(frame?: number) {
    const result = await this.backend.execute({ cmd: 'getLocals', frame });
    if (result.ok) {
      this.variables = result.data as Variable[];
      this._onDidChangeTreeData.fire(undefined);
    }
  }
}

class VariableItem extends vscode.TreeItem {
  constructor(public variable: Variable) {
    super(variable.name, variable.children
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None);

    this.description = variable.value;
    this.tooltip = `${variable.type} ${variable.name} = ${variable.value}`;
    this.contextValue = 'variable';
  }
}