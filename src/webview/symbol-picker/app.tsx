import React, { useEffect, useMemo, useRef, useState } from 'react';
import { canSelectSymbol, symbolByteSize, symbolChildCount, symbolChildren, symbolMatches, symbolTypeName,
  type SymbolCatalog, type SymbolNode } from '../../symbols/symbol-catalog';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };
const vscode = acquireVsCodeApi();

export function SymbolPickerApp() {
  const [catalog, setCatalog] = useState<SymbolCatalog | null>(null);
  const [mode, setMode] = useState<'watch' | 'timeline'>('watch');
  const [title, setTitle] = useState('选择变量');
  const [existing, setExisting] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(new Map<string, SymbolNode>());
  const selectedRef = useRef(selected);
  const [removed, setRemoved] = useState(new Set<string>());
  const removedRef = useRef(removed);
  const token = useRef(0);
  const closing = useRef(false);
  const filter = useRef<HTMLInputElement>(null);
  const [expansion, setExpansion] = useState<Record<string, boolean>>({});
  const [fileExpansion, setFileExpansion] = useState<Record<string, boolean>>({});
  const [limits, setLimits] = useState<Record<string, number>>({});
  const [rootLimit, setRootLimit] = useState(300);
  const existingSet = new Set(existing);
  const sendSelection = (command: 'add' | 'close') => {
    if (!token.current || closing.current) return;
    closing.current = true;
    vscode.postMessage({ command, token: token.current, ...(command === 'add'
      ? { selectedIds: [...selectedRef.current.keys()], removedExpressions: [...removedRef.current] } : {}) });
  };

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const msg = event.data;
      if (msg?.command === 'init') {
        token.current = msg.token; closing.current = false;
        setCatalog(msg.catalog); setMode(msg.mode); setTitle(msg.title); setExisting(msg.existing || []);
        selectedRef.current = new Map(); setSelected(selectedRef.current);
        removedRef.current = new Set(); setRemoved(removedRef.current);
        setQuery(''); setExpansion({}); setLimits({}); setFileExpansion({}); setRootLimit(300);
        requestAnimationFrame(() => filter.current?.focus());
      }
    };
    const handleBlur = () => sendSelection('close');
    const handleKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); sendSelection('close'); } };
    window.addEventListener('message', handleMessage);
    window.addEventListener('blur', handleBlur);
    window.addEventListener('keydown', handleKey);
    vscode.postMessage({ command: 'ready' });
    return () => { window.removeEventListener('message', handleMessage); window.removeEventListener('blur', handleBlur); window.removeEventListener('keydown', handleKey); };
  }, []);

  const matches = useMemo(() => catalog?.roots.filter(node => symbolMatches(catalog, node, query)) || [], [catalog, query]);
  const groups = new Map<string, SymbolNode[]>();
  for (const node of matches.slice(0, rootLimit)) {
    const group = groups.get(node.file) || []; group.push(node); groups.set(node.file, group);
  }
  const choose = (node: SymbolNode) => {
    if (existingSet.has(node.expression)) {
      const next = new Set(removedRef.current);
      if (next.has(node.expression)) next.delete(node.expression); else next.add(node.expression);
      removedRef.current = next; setRemoved(next);
      return;
    }
    const next = new Map(selectedRef.current);
    if (next.has(node.id)) next.delete(node.id); else next.set(node.id, node);
    selectedRef.current = next; setSelected(next);
  };
  let rowBudget = 1500;
  const renderNode = (node: SymbolNode, depth: number, parentExpression?: string, branches: boolean[] = []): React.ReactNode => {
    if (!catalog || rowBudget-- <= 0) return null;
    const count = depth < 12 ? symbolChildCount(catalog, node) : 0;
    const normalizedQuery = query.trim().toLowerCase().replace(/->/g, '.');
    const directMatch = !normalizedQuery || `${node.expression} ${node.file} ${symbolTypeName(catalog, node.typeOffset)}`.toLowerCase().replace(/->/g, '.').includes(normalizedQuery);
    const open = expansion[node.id] ?? (!!normalizedQuery && !directMatch && depth < 10);
    const added = existingSet.has(node.expression);
    const selectable = canSelectSymbol(catalog, node, mode);
    const reason = added ? removed.has(node.expression) ? '将移除；勾选可保留此变量' : '已添加；取消勾选并点击“添加”可移除'
      : node.unavailable || node.unsupportedTimeline || (!selectable ? 'Timeline 仅支持数值叶子，请展开后选择成员或数组元素' : '');
    const limit = limits[node.id] || 100;
    const prefix = node.expression.toLowerCase().replace(/->/g, '.');
    const searchedIndex = normalizedQuery.startsWith(prefix) ? normalizedQuery.slice(prefix.length).match(/^\[(\d+)\]/)?.[1] : undefined;
    const start = searchedIndex !== undefined && count > Number(searchedIndex) ? Number(searchedIndex) : 0;
    const children = open && count ? symbolChildren(catalog, node, start, limit).filter(child => symbolMatches(catalog, child, query)) : [];
    const hasMore = start + limit < count;
    const label = parentExpression && node.expression.startsWith(parentExpression)
      ? node.expression.slice(parentExpression.length).replace(/^(?:->|\.)/, '') : node.expression;
    const toggle = () => setExpansion(previous => ({ ...previous, [node.id]: !open }));
    return <React.Fragment key={node.id}>
      <tr className={selected.has(node.id) ? 'symbol-selected' : !selectable ? 'symbol-unavailable' : ''}>
        <td title={node.expression}><div className="symbol-name" onDoubleClick={count ? toggle : undefined}>
          {branches.map((continues, index) => <span key={index} aria-hidden="true"
            className={`symbol-indent${continues ? ' symbol-continues' : ''}${index === branches.length - 1 ? ' symbol-branch' : ''}`} />)}
          {count ? <button type="button" className="symbol-toggle" aria-label={`${open ? '折叠' : '展开'} ${node.expression}`}
            aria-expanded={open} title={`${open ? '折叠' : '展开'} ${count} 个子项`} onClick={toggle}
            onDoubleClick={event => event.stopPropagation()}><Chevron open={open} /></button> : <span className="symbol-toggle-space" aria-hidden="true" />}
          <span className="symbol-name-text">{label}</span>
        </div></td>
        <td title={symbolTypeName(catalog, node.typeOffset)}>{symbolTypeName(catalog, node.typeOffset)}</td>
        <td className="symbol-number">{node.size || symbolByteSize(catalog, node.typeOffset) || '—'}</td>
        <td className="symbol-address" title={node.address === undefined ? node.pointerDepth ? '指针成员地址在运行时确定' : '没有记录地址' : ''}>
          {node.address === undefined ? '—' : `0x${node.address.toString(16).toUpperCase().padStart(8, '0')}`}</td>
        <td title={reason}><input type="checkbox" aria-label={`选择 ${node.expression}`}
          disabled={!selectable && !added} checked={added ? !removed.has(node.expression) : selected.has(node.id)} onChange={() => choose(node)} /></td>
      </tr>
      {children.map((child, index) => renderNode(child, depth + 1, node.expression, [...branches, index < children.length - 1 || hasMore]))}
      {open && hasMore && <tr><td colSpan={5}><button className="symbol-more" type="button"
        onClick={() => setLimits(previous => ({ ...previous, [node.id]: limit + 100 }))}>继续加载 {node.expression}（{start + limit}/{count}）</button></td></tr>}
    </React.Fragment>;
  };

  return <main className="symbol-picker" aria-label="变量选择">
    <style>{styles}</style>
    <div className="symbol-heading"><h2>{title}</h2><button type="button" className="symbol-close" aria-label="关闭变量选择" title="关闭，不保存本次勾选" onClick={() => sendSelection('close')}>×</button></div>
    <input ref={filter} className="symbol-filter" aria-label="筛选变量" placeholder="筛选变量、类型或源文件" value={query}
      onChange={event => { setQuery(event.target.value); setRootLimit(300); setExpansion({}); setFileExpansion({}); }} />
    <div className="symbol-table-wrap"><table className="symbol-table"><colgroup>
      <col style={{ width: '43%' }} /><col style={{ width: '27%' }} /><col style={{ width: '8%' }} /><col style={{ width: '15%' }} /><col style={{ width: '7%' }} />
    </colgroup><thead><tr><th>Name</th><th>Type</th><th>Size</th><th>Address</th><th>Select</th></tr></thead>
      <tbody>{catalog && [...groups].map(([file, nodes]) => {
        const open = fileExpansion[file] ?? (file !== '其他符号' || !!query.trim());
        return <React.Fragment key={file}>
          <tr className="symbol-file"><td colSpan={5}><button type="button" aria-expanded={open}
            aria-label={`${open ? '折叠' : '展开'} ${file}`} title={file}
            onClick={() => setFileExpansion(previous => ({ ...previous, [file]: !open }))}>
            <Chevron open={open} /><span className="symbol-file-name">{file}</span></button></td></tr>
          {open && nodes.map(node => renderNode(node, 0))}
        </React.Fragment>;
      })}</tbody></table>
      {!catalog && <div className="symbol-status" role="status">正在加载 ELF 变量…</div>}
      {catalog && !matches.length && <div className="symbol-status" role="status">{query ? '没有匹配的变量' : 'ELF 中没有可用变量，请确认已启用调试信息（-g）'}</div>}
      {matches.length > rootLimit && <button type="button" className="symbol-more" onClick={() => setRootLimit(value => value + 300)}>继续加载变量（{rootLimit}/{matches.length}）</button>}
      {rowBudget <= 0 && <div className="symbol-status">展开项较多，请输入更具体的名称筛选</div>}
    </div>
    <div className="symbol-hint"><span>{catalog?.source === 'recording' ? '当前记录：选择已记录的通道。' : mode === 'timeline' ? 'Timeline：选择数值叶子；结构体、数组和指针请先展开。' : 'Watch：可选择整个变量，也可展开后选择成员。'} 新增 {selected.size} 项 · 移除 {removed.size} 项 · 关闭不保存</span>
      <span className="symbol-legend"><i className="symbol-legend-box" aria-hidden="true" />可选<i className="symbol-legend-box symbol-legend-disabled" aria-hidden="true">−</i>不可选</span></div>
    <div className="symbol-footer"><button type="button" className="symbol-ok" title="应用本次新增和移除并关闭" disabled={!selected.size && !removed.size} onClick={() => sendSelection('add')}>添加</button>
      <button type="button" className="symbol-cancel" onClick={() => sendSelection('close')}>关闭</button></div>
  </main>;
}

function Chevron({ open }: { open: boolean }) {
  return <svg className="symbol-chevron" data-open={open} width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <path d="m6 3.5 4.5 4.5-4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
}

const styles = `
.symbol-picker { box-sizing:border-box; width:100%; height:100%; padding:12px; display:flex; flex-direction:column; gap:10px; color:var(--vscode-foreground); background:var(--vscode-editorWidget-background,var(--vscode-editor-background)); }
.symbol-heading { display:flex; justify-content:space-between; align-items:center; flex-shrink:0; }
.symbol-heading h2 { margin:0; font-size:14px; font-weight:500; }
.symbol-picker button { font:inherit; cursor:pointer; }
.symbol-close,.symbol-toggle { color:inherit; border:0; background:transparent; }
.symbol-close { font-size:20px !important; padding:0 5px; }
.symbol-filter { box-sizing:border-box; width:100%; padding:5px 7px; border:1px solid var(--vscode-input-border,var(--vscode-panel-border)); border-radius:3px; background:var(--vscode-input-background); color:var(--vscode-input-foreground); font:inherit; flex-shrink:0; }
.symbol-filter::placeholder { color:var(--vscode-input-placeholderForeground); }
.symbol-table-wrap { flex:1; min-height:0; overflow:auto; border:1px solid var(--vscode-panel-border,var(--vscode-input-border)); background:var(--vscode-editor-background); }
.symbol-table { width:100%; min-width:620px; border-collapse:separate; border-spacing:0; table-layout:fixed; font:12px var(--vscode-editor-font-family,monospace); }
.symbol-table th { position:sticky; top:0; z-index:1; text-align:left; font-weight:400; background:var(--vscode-editorWidget-background,var(--vscode-editor-background)); border-bottom:1px solid var(--vscode-panel-border); border-right:1px solid var(--vscode-panel-border); }
.symbol-table th,.symbol-table td { padding:3px 6px; height:26px; box-sizing:border-box; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.symbol-table td:first-child { padding-top:0; padding-bottom:0; }
.symbol-table tr:not(.symbol-file):hover { background:var(--vscode-list-hoverBackground); }
.symbol-table .symbol-selected { background:var(--vscode-list-activeSelectionBackground); color:var(--vscode-list-activeSelectionForeground); outline:1px solid var(--vscode-contrastActiveBorder,transparent); outline-offset:-1px; }
.symbol-table .symbol-selected:hover { background:var(--vscode-list-activeSelectionBackground) !important; }
.symbol-unavailable td { color:var(--vscode-descriptionForeground); }
.symbol-name { display:flex; align-items:center; height:26px; min-width:0; }
.symbol-name-text,.symbol-file-name { overflow:hidden; text-overflow:ellipsis; }
.symbol-toggle,.symbol-toggle-space { display:inline-flex; align-items:center; justify-content:center; flex:0 0 20px; width:20px; height:20px; box-sizing:border-box; }
.symbol-toggle { padding:0; border-radius:3px; }
.symbol-toggle:hover { background:var(--vscode-toolbar-hoverBackground,var(--vscode-list-hoverBackground)); }
.symbol-chevron { flex-shrink:0; color:var(--vscode-icon-foreground,var(--vscode-foreground)); transition:transform 120ms ease; }
.symbol-chevron[data-open=true] { transform:rotate(90deg); }
.symbol-toggle[aria-expanded=true] .symbol-chevron { color:var(--vscode-textLink-foreground,var(--vscode-foreground)); }
.symbol-selected .symbol-chevron { color:inherit !important; }
.symbol-indent { position:relative; align-self:stretch; flex:0 0 20px; }
.symbol-continues::before,.symbol-branch::before { content:''; position:absolute; top:0; bottom:0; left:9px; border-left:1px solid var(--vscode-tree-indentGuidesStroke,var(--vscode-descriptionForeground)); opacity:.65; }
.symbol-branch:not(.symbol-continues)::before { bottom:50%; }
.symbol-branch::after { content:''; position:absolute; top:50%; left:9px; width:10px; border-top:1px solid var(--vscode-tree-indentGuidesStroke,var(--vscode-descriptionForeground)); opacity:.65; }
.symbol-name:hover .symbol-indent::before,.symbol-name:hover .symbol-indent::after { border-color:var(--vscode-tree-inactiveIndentGuidesStroke,var(--vscode-tree-indentGuidesStroke,var(--vscode-descriptionForeground))); opacity:1; }
/* Keep file groups distinct even when a theme uses nearly identical header and editor backgrounds. */
.symbol-file { background:var(--vscode-list-inactiveSelectionBackground); background:color-mix(in srgb,var(--vscode-editor-background) 76%,var(--vscode-foreground)); color:var(--vscode-foreground); }
.symbol-file td { padding:0; border-block:1px solid var(--vscode-contrastBorder,color-mix(in srgb,var(--vscode-editor-background) 68%,var(--vscode-foreground))); }
.symbol-file button { display:flex; align-items:center; gap:4px; width:100%; height:26px; text-align:left; border:0; padding:0 8px; background:transparent; color:inherit; font-weight:600; white-space:nowrap; overflow:hidden; }
.symbol-file button:hover { background:color-mix(in srgb,var(--vscode-foreground) 8%,transparent); }
@media (prefers-reduced-motion:reduce) { .symbol-chevron { transition:none; } }
.symbol-number { text-align:right; font-variant-numeric:tabular-nums; }
.symbol-address { font-variant-numeric:tabular-nums; }
.symbol-picker input[type=checkbox],.symbol-legend-box { appearance:none; display:inline-grid; place-content:center; box-sizing:border-box; width:16px; height:16px; margin:0; border:2px solid var(--vscode-textLink-foreground,var(--vscode-focusBorder,#007fd4)); border-radius:3px; background:var(--vscode-input-background); vertical-align:middle; cursor:pointer; }
.symbol-picker input[type=checkbox]::before { content:''; width:4px; height:8px; border:solid currentColor; border-width:0 2px 2px 0; transform:translateY(-1px) rotate(45deg); visibility:hidden; }
.symbol-picker input[type=checkbox]:not(:disabled):hover { box-shadow:0 0 0 1px var(--vscode-focusBorder); }
.symbol-picker input[type=checkbox]:checked { background:var(--vscode-button-background); border-color:var(--vscode-button-background); color:var(--vscode-button-foreground); }
.symbol-picker input[type=checkbox]:checked::before { visibility:visible; }
.symbol-picker input[type=checkbox]:disabled:not(:checked),.symbol-legend-disabled { border:1px dashed var(--vscode-disabledForeground,var(--vscode-descriptionForeground)); background:transparent; color:var(--vscode-disabledForeground,var(--vscode-descriptionForeground)); cursor:not-allowed; }
.symbol-picker input[type=checkbox]:disabled:not(:checked)::before { width:7px; height:0; border:0; border-top:1px solid currentColor; transform:none; visibility:visible; }
.symbol-picker input[type=checkbox]:disabled:checked { opacity:.65; cursor:default; }
.symbol-picker button:focus-visible,.symbol-picker input:focus-visible { outline:1px solid var(--vscode-focusBorder); outline-offset:-1px; }
.symbol-status { padding:24px 12px; text-align:center; color:var(--vscode-descriptionForeground); }
.symbol-more { border:0; background:transparent; color:var(--vscode-textLink-foreground); padding:6px; }
.symbol-hint { display:flex; flex-wrap:wrap; align-items:center; gap:8px; font-size:11px; color:var(--vscode-descriptionForeground); flex-shrink:0; }
.symbol-legend { display:inline-flex; align-items:center; gap:5px; white-space:nowrap; }
.symbol-legend-box { width:13px; height:13px; cursor:default; font-style:normal; line-height:10px; }
.symbol-footer { display:flex; justify-content:space-evenly; gap:12px; flex-shrink:0; }
.symbol-footer button { width:28%; min-width:100px; padding:5px 12px; border:1px solid var(--vscode-button-border,var(--vscode-contrastBorder,transparent)); border-radius:3px; }
.symbol-ok { background:var(--vscode-button-background); color:var(--vscode-button-foreground); }
.symbol-ok:hover { background:var(--vscode-button-hoverBackground); }
.symbol-ok:disabled { opacity:.45; cursor:default; }
.symbol-cancel { background:var(--vscode-button-secondaryBackground); color:var(--vscode-button-secondaryForeground); }
.symbol-cancel:hover { background:var(--vscode-button-secondaryHoverBackground); }
`;
