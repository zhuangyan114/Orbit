import * as vscode from 'vscode';
import { WatchValue } from '../ozone-backend/types';

const MIN_CHANGE_DISPLAY_MS = 500;

function exprToUri(expr: string): vscode.Uri {
  return vscode.Uri.parse(`ozone-watch:/watch/${encodeURIComponent(expr)}`);
}

function uriToExpr(uri: vscode.Uri): string | null {
  if (uri.scheme !== 'ozone-watch') return null;
  const m = uri.path.match(/^\/watch\/(.+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

export class WatchProvider implements vscode.TreeDataProvider<WatchItem>, vscode.FileDecorationProvider {
  private _watches: WatchValue[] = [];
  private _prevValues = new Map<string, string>();
  private _changedTimes = new Map<string, number>();
  private _onDidChangeTreeData = new vscode.EventEmitter<WatchItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;
  onExpressionsChanged: ((exprs: string[]) => void) | null = null;

  private _getChangedSet(): Set<string> {
    const now = Date.now();
    const active = new Set<string>();
    for (const [expr, time] of this._changedTimes) {
      if (now - time < MIN_CHANGE_DISPLAY_MS) {
        active.add(expr);
      }
    }
    return active;
  }

  private _pruneChangedTimes(now: number) {
    const pruned: string[] = [];
    for (const [expr, time] of this._changedTimes) {
      if (now - time >= MIN_CHANGE_DISPLAY_MS) {
        this._changedTimes.delete(expr);
        pruned.push(expr);
      }
    }
    if (pruned.length > 0) {
      this._fireDecorationChangeForExprs(pruned);
    }
  }

  private _fireDecorationChangeForExprs(exprs: string[]) {
    if (exprs.length === 0) return;
    const uris = exprs.map(e => exprToUri(e));
    this._onDidChangeFileDecorations.fire(uris);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.ProviderResult<vscode.FileDecoration> {
    const expr = uriToExpr(uri);
    if (!expr) return undefined;
    const now = Date.now();
    const t = this._changedTimes.get(expr);
    if (t !== undefined && now - t < MIN_CHANGE_DISPLAY_MS) {
      return { color: new vscode.ThemeColor('charts.green') };
    }
    return undefined;
  }

  get watches(): ReadonlyArray<WatchValue> {
    return this._watches;
  }

  get expressionList(): string[] {
    return this._watches.map(w => w.expression);
  }

  getTreeItem(element: WatchItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: WatchItem): WatchItem[] {
    if (element) {
      const w = element.watch;
      if (w.children && w.children.length > 0) {
        const parentPath = w.expression;
        const changedSet = this._getChangedSet();
        return w.children.map(c => {
          const sep = c.expression.startsWith('[') ? '' : '.';
          const fullExpr = `${parentPath}${sep}${c.expression}`;
          const childWatch = { ...c, expression: fullExpr };
          const childChanged = changedSet.has(fullExpr);
          return new WatchItem(childWatch, this._prevValues.get(fullExpr), childChanged, c.expression);
        });
      }
      return [];
    }
    const changedSet = this._getChangedSet();
    return this._watches.map(w => {
      const changed = changedSet.has(w.expression);
      return new WatchItem(w, this._prevValues.get(w.expression), changed);
    });
  }

  updateResults(results: WatchValue[]) {
    const now = Date.now();
    const allResults: WatchValue[] = [];
    for (const r of results) {
      allResults.push(r);
      if (r.children) {
        const stack = [...r.children];
        while (stack.length > 0) {
          const c = stack.pop()!;
          const fullExpr = this.makeFullExpr(r.expression, c.expression, results);
          allResults.push({ ...c, expression: fullExpr });
          if (c.children) stack.push(...c.children);
        }
      }
    }

    const changedUris: vscode.Uri[] = [];
    for (const r of allResults) {
      if (r.display && !r.error) {
        const prev = this._prevValues.get(r.expression);
        if (prev !== undefined && prev !== r.display) {
          this._changedTimes.set(r.expression, now);
          changedUris.push(exprToUri(r.expression));
        }
        this._prevValues.set(r.expression, r.display);
      }
    }
    if (changedUris.length > 0) {
      this._onDidChangeFileDecorations.fire(changedUris);
    }

    this._pruneChangedTimes(now);
    let changed = false;
    const existing = new Set(this._watches.map(w => w.expression));
    for (const r of results) {
      if (!existing.has(r.expression) && !r.error) {
        this._watches.push({ expression: r.expression, value: 0, display: '', hex: '' });
        changed = true;
      }
    }
    const resultMap = new Map(results.map(r => [r.expression, r]));
    this._watches = this._watches.map(w => resultMap.get(w.expression) || w);
    this._onDidChangeTreeData.fire(undefined);
    if (changed && this.onExpressionsChanged) {
      this.onExpressionsChanged(this.expressionList);
    }
  }

  private makeFullExpr(parent: string, child: string, allResults: WatchValue[]): string {
    for (const r of allResults) {
      if (r.children) {
        for (const c of r.children) {
          if (c.expression === child) {
            const sep = child.startsWith('[') ? '' : '.';
            return `${r.expression}${sep}${child}`;
          }
        }
      }
    }
    return child;
  }

  setExpressions(expressions: string[]) {
    this._watches = expressions.map(expr => ({
      expression: expr, value: 0, display: '', hex: '',
    }));
    this._prevValues.clear();
    this._changedTimes.clear();
    this._onDidChangeTreeData.fire(undefined);
    this._onDidChangeFileDecorations.fire(undefined);
    if (this.onExpressionsChanged) {
      this.onExpressionsChanged(expressions);
    }
  }
}

function truncatedValue(display: string, maxLen = 40): string {
  return display.length > maxLen ? display.slice(0, maxLen) + '…' : display;
}

class WatchItem extends vscode.TreeItem {
  constructor(public watch: WatchValue, prevValue?: string, changed?: boolean, displayLabel?: string) {
    const label = displayLabel || watch.expression;
    const hasChildren = !!(watch.children && watch.children.length > 0);

    super(label, hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);

    this.resourceUri = exprToUri(watch.expression);

    const typePart = watch.typeName ? ` (${watch.typeName})` : '';

    if (watch.error && prevValue) {
      this.description = `${truncatedValue(prevValue)}${typePart}`;
      this.tooltip = `${watch.expression} = ${prevValue}`;
    } else if (watch.error) {
      this.description = `Running...${typePart}`;
      this.tooltip = 'Target is running';
    } else if (watch.display) {
      this.description = `${truncatedValue(watch.display)}${typePart}`;
      this.tooltip = `${watch.expression} = ${watch.display}`;
    } else {
      this.description = `…${typePart}`;
      this.tooltip = 'Waiting...';
    }

    this.contextValue = 'watchItem';
    this.iconPath = undefined;
  }
}
