import * as vscode from 'vscode';
import { WatchValue } from '../ozone-backend/types';

const MIN_CHANGE_DISPLAY_MS = 500;

export class WatchProvider implements vscode.TreeDataProvider<WatchItem> {
  private _watches: WatchValue[] = [];
  private _prevValues = new Map<string, string>();
  private _changedTimes = new Map<string, number>();
  private _onDidChangeTreeData = new vscode.EventEmitter<WatchItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
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
    for (const [expr, time] of this._changedTimes) {
      if (now - time >= MIN_CHANGE_DISPLAY_MS) {
        this._changedTimes.delete(expr);
      }
    }
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

    for (const r of allResults) {
      if (r.display && !r.error) {
        const prev = this._prevValues.get(r.expression);
        if (prev !== undefined && prev !== r.display) {
          this._changedTimes.set(r.expression, now);
        }
        this._prevValues.set(r.expression, r.display);
      }
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
    this._onDidChangeTreeData.fire(undefined);
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

    if (changed) {
      this.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('debugIcon.startForeground'));
    } else {
      this.iconPath = new vscode.ThemeIcon('circle-outline');
    }
  }
}
