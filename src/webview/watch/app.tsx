import React, { useEffect, useState, useRef, useCallback } from 'react';

interface VSCODE_API { postMessage(message: any): void; }
declare function acquireVsCodeApi(): VSCODE_API;
let vscode: VSCODE_API;
try { vscode = typeof acquireVsCodeApi !== 'undefined' ? acquireVsCodeApi() : { postMessage: () => {} }; }
catch { vscode = { postMessage: () => {} }; }

interface WatchEntry {
  expression: string;
  label?: string;
  value?: string;
  typeName?: string;
  address?: number;
  error?: string;
  hasChildren?: boolean;
  children?: WatchEntry[];
}

function extractValue(display: string): string {
  const m = display.match(/^(0x[0-9A-Fa-f]+)/);
  if (m) return m[1];
  const d = display.match(/^\(?(-?\d+)/);
  if (d) return d[1];
  return display;
}

function mapResult(r: any, parentExpr?: string): WatchEntry {
  const isCompound = !!(r.children && r.children.length > 0);
  const label = String(r.expression ?? '');
  const fullExpr = parentExpr
    ? (label.startsWith('[') ? `${parentExpr}${label}` : `${parentExpr}.${label}`)
    : label;
  return {
    expression: fullExpr,
    label,
    value: r.error
      ? (r.error === 'running' ? 'Running...' : r.error)
      : (isCompound ? `0x${(r.address || 0).toString(16).toUpperCase()}` : r.display),
    typeName: r.typeName,
    address: r.address,
    error: r.error,
    hasChildren: isCompound,
    children: isCompound ? r.children.map((c: any) => mapResult(c, fullExpr)) : undefined,
  };
}

const CHANGE_HIGHLIGHT_MS = 500;

export function WatchApp() {
  const [watches, setWatches] = useState<WatchEntry[]>([]);
  const [newExpr, setNewExpr] = useState('');
  const [editingIndex, setEditingIndex] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [changedValues, setChangedValues] = useState<Set<string>>(new Set());
  const watchesRef = useRef(watches);
  watchesRef.current = watches;
  const editValueRef = useRef('');
  editValueRef.current = editValue;
  const prevValuesRef = useRef<Map<string, string>>(new Map());
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      switch (msg.command) {
        case 'init':
          prevValuesRef.current.clear();
          setWatches(msg.watches || []);
          setExpanded(new Set((msg.expandedExpressions || []).map((e: unknown) => String(e))));
          break;
        case 'watchResults': {
          const incoming: WatchEntry[] = (msg.results || []).map((r: any) => mapResult(r));
          const incomingMap = new Map(incoming.map(r => [r.expression, r]));
          const changed = new Set<string>();
          const walk = (entries: WatchEntry[]) => {
            for (const e of entries) {
              const prev = prevValuesRef.current.get(e.expression);
              if (prev !== undefined && prev !== e.value && !e.hasChildren) {
                changed.add(e.expression);
              }
              prevValuesRef.current.set(e.expression, e.value || '');
              if (e.children) walk(e.children);
            }
          };
          walk(incoming);
          setChangedValues(changed);
          setWatches(prev => {
            if (incomingMap.size === prev.length) return incoming;
            return prev.map(w => incomingMap.get(w.expression) || w);
          });
          if (changed.size > 0) {
            if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
            highlightTimerRef.current = setTimeout(() => {
              setChangedValues(new Set());
              highlightTimerRef.current = null;
            }, CHANGE_HIGHLIGHT_MS);
          }
          break;
        }
        case 'watchValueSet':
          if (msg.ok) {
            vscode.postMessage({ command: 'evaluateWatches', expressions: [msg.expression] });
          }
          break;
      }
    };
    window.addEventListener('message', handler);
    vscode.postMessage({ command: 'init' });
    return () => window.removeEventListener('message', handler);
  }, []);

  const addWatch = () => {
    const expr = newExpr.trim();
    if (!expr) return;
    vscode.postMessage({ command: 'addExpression', expression: expr });
    setNewExpr('');
  };

  const removeWatch = (index: number) => {
    const w = watches[index];
    if (w) {
      vscode.postMessage({ command: 'removeExpression', expression: w.expression });
      setWatches(prev => prev.filter((_, i) => i !== index));
    }
  };

  const startEditing = useCallback((key: string, currentValue: string) => {
    setEditingIndex(key);
    setEditValue(extractValue(currentValue));
  }, []);

  const commitEdit = useCallback((key: string) => {
    setEditingIndex(null);
    // Navigate the tree to find the entry by its dot-separated key path
    const parts = key.split('.');
    let entry: WatchEntry | undefined;
    let cur: WatchEntry[] | undefined = watchesRef.current;
    for (const p of parts) {
      const idx = parseInt(p, 10);
      if (isNaN(idx) || !cur || idx >= cur.length) { entry = undefined; break; }
      entry = cur[idx];
      cur = entry.children;
    }
    if (!entry) return;
    const raw = editValueRef.current.trim();
    if (raw === '') return;
    let num: number;
    if (raw.startsWith('0x') || raw.startsWith('0X')) num = parseInt(raw, 16);
    else num = parseInt(raw, 10);
    if (isNaN(num)) return;
    vscode.postMessage({
      command: 'setWatchValue',
      expression: entry.expression,
      value: num,
      address: entry.address,
      typeName: entry.typeName,
    });
  }, []);

  const cancelEdit = useCallback(() => setEditingIndex(null), []);

  const toggleExpand = (expression: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(expression)) next.delete(expression);
      else next.add(expression);
      vscode.postMessage({ command: 'setExpandedExpressions', expressions: [...next] });
      return next;
    });
  };

  const renderRow = (w: WatchEntry, key: string, depth: number): React.ReactNode[] => {
    const expandId = w.expression;
    const isExpanded = expanded.has(expandId);
    const showToggle = w.hasChildren && w.children && w.children.length > 0;
    const canEdit = !w.hasChildren && (!w.error || w.error === 'running');
    const indent = depth * 18;

    const rows: React.ReactNode[] = [
      <div key={key} className="watch-row" title={`${w.expression}${w.typeName ? ' (' + w.typeName + ')' : ''} = ${w.value || '...'}`}
        style={{
        display: 'grid', gridTemplateColumns: `${indent + 18}px minmax(96px, 1fr) minmax(120px, 1.5fr) minmax(72px, 1fr) ${depth === 0 ? '48px' : '0px'}`,
        borderBottom: '1px solid var(--vscode-sideBar-border, #333)',
        alignItems: 'center',
        background: depth > 0 ? 'rgba(127, 127, 127, 0.035)' : 'transparent',
      }}>
        {/* Toggle */}
        <div style={{
          width: '100%', height: 18, display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
          paddingRight: 3, boxSizing: 'border-box',
          borderLeft: depth > 0 ? '1px solid var(--vscode-tree-indentGuidesStroke, rgba(128,128,128,0.35))' : 'none',
          cursor: showToggle ? 'pointer' : 'default', userSelect: 'none',
        }}
          onClick={() => showToggle && toggleExpand(expandId)}>
          {showToggle ? (
            <div style={{
              width: 0, height: 0,
              borderTop: '4px solid transparent', borderBottom: '4px solid transparent',
              borderLeft: '5px solid var(--vscode-descriptionForeground, #888)',
              transition: 'transform 0.15s ease',
              transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
            }} />
          ) : ''}
        </div>

        {/* Name */}
        <div style={{
          padding: '2px 4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          color: 'var(--vscode-symbolIcon-variableForeground, #569cd6)',
          fontSize: depth > 0 ? '11px' : '12px',
        }}>
          {w.label || w.expression}
        </div>

        {/* Value */}
        <div style={{
          padding: '2px 4px', fontFamily: 'monospace', fontSize: depth > 0 ? '11px' : '12px',
          cursor: canEdit ? 'text' : 'default',
          color: changedValues.has(w.expression) ? 'var(--vscode-charts-green, #4ec9b0)' :
                 w.value === 'Running...' ? 'var(--vscode-descriptionForeground, #888)' :
                 w.error ? 'var(--vscode-errorForeground, #f48771)' : 'var(--vscode-editor-foreground, #ccc)',
        }}
          onClick={() => {
            if (canEdit) startEditing(key, w.value === 'Running...' ? '' : (w.value || ''));
          }}>
          {editingIndex === key ? (
            <input value={editValue}
              onChange={e => setEditValue(e.target.value)}
              onFocus={e => e.target.select()}
              onKeyDown={e => {
                if (e.key === 'Enter') { e.preventDefault(); commitEdit(key); }
                if (e.key === 'Escape') cancelEdit();
              }}
              onBlur={cancelEdit}
              autoFocus
              style={{ width: '100%', boxSizing: 'border-box', padding: '1px 4px', fontSize: '12px', ...inputStyle }} />
          ) : (
            <span style={{
              borderBottom: canEdit && w.value && w.value !== '...'
                ? '1px dashed var(--vscode-input-placeholderForeground, #666)' : 'none',
            }}>
              {w.value || '...'}
            </span>
          )}
        </div>

        {/* Type */}
        <div style={{
          padding: '2px 4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          color: 'var(--vscode-descriptionForeground, #888)', fontSize: depth > 0 ? '10px' : '11px',
        }}>
          {w.typeName || ''}
        </div>

        {/* Actions */}
        {depth === 0 && (
          <div style={{ display: 'flex', gap: 2, justifyContent: 'flex-end', opacity: 0.4, transition: 'opacity 0.15s' }}
            className="watch-actions">
            <button onClick={() => removeWatch(parseInt(key, 10))}
              style={{ ...actionBtnStyle, color: 'var(--vscode-errorForeground, #f48771)' }} title="删除">×</button>
          </div>
        )}
      </div>,
    ];

    if (showToggle && isExpanded && w.children) {
      for (let ci = 0; ci < w.children.length; ci++) {
        rows.push(...renderRow(w.children[ci], `${key}.${ci}`, depth + 1));
      }
    }

    return rows;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', fontSize: '12px' }}>
      <div style={{ display: 'flex', gap: '4px', padding: '4px 8px', borderBottom: '1px solid var(--vscode-sideBar-border, #333)' }}>
        <input value={newExpr} onChange={e => setNewExpr(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') addWatch(); }}
          placeholder="变量名或表达式"
          style={{ flex: 1, ...inputStyle }} />
        <button onClick={addWatch} style={btnStyle}>+</button>
      </div>

      {watches.length > 0 && (
        <div style={{
          display: 'grid', gridTemplateColumns: '16px 1fr 1.5fr 1fr 48px',
          borderBottom: '2px solid var(--vscode-sideBar-border, #555)',
          padding: '4px 8px 4px 4px', fontSize: '11px', fontWeight: 600,
          color: 'var(--vscode-descriptionForeground, #888)',
          userSelect: 'none',
        }}>
          <span />
          <span>Name</span>
          <span>Value</span>
          <span>Type</span>
          <span />
        </div>
      )}

      <div style={{ flex: 1, overflow: 'auto' }}>
        {watches.length === 0 ? (
          <div style={{ opacity: 0.5, textAlign: 'center', padding: '20px', color: 'var(--vscode-descriptionForeground, #888)' }}>
            输入变量名后点击 + 添加监视
          </div>
        ) : (
          watches.map((w, i) => renderRow(w, String(i), 0))
        )}
      </div>

    </div>
  );
}

const btnStyle: React.CSSProperties = {
  padding: '3px 8px', border: 'none', borderRadius: 3,
  background: 'var(--vscode-button-background, #0e639c)',
  color: 'var(--vscode-button-foreground, #fff)',
  cursor: 'pointer', fontSize: 12, fontFamily: 'inherit',
};

const inputStyle: React.CSSProperties = {
  padding: '3px 6px', border: '1px solid var(--vscode-sideBar-border, #333)',
  borderRadius: 3, background: 'var(--vscode-input-background, #3c3c3c)',
  color: 'var(--vscode-input-foreground, #ccc)', fontSize: 12,
  fontFamily: 'var(--vscode-editor-font-family, monospace)',
};

const actionBtnStyle: React.CSSProperties = {
  background: 'none', border: 'none', cursor: 'pointer', padding: '0 6px',
  minWidth: 24, height: 22,
  color: 'var(--vscode-descriptionForeground, #888)', fontSize: 14,
  fontFamily: 'var(--vscode-editor-font-family, monospace)',
  lineHeight: '20px',
};
