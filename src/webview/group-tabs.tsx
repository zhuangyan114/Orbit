import React, { useEffect, useRef, useState } from 'react';

interface GroupTab {
  id: string;
  name: string;
  closable?: boolean;
  samplingEnabled?: boolean;
  running?: boolean;
  title?: string;
  warning?: boolean;
}

export function GroupTabs({ label, tabs, activeId, onSelect, onAdd, onRemove, onRename, onReorder, onSamplingChange, children }: {
  label: string;
  tabs: GroupTab[];
  activeId: string;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onReorder: (id: string, index: number) => void;
  onSamplingChange?: (id: string, enabled: boolean) => void;
  children?: React.ReactNode;
}) {
  const [edit, setEdit] = useState<{ id: string; name: string } | null>(null);
  const editRef = useRef(edit);
  const dragRef = useRef<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; before: boolean } | null>(null);
  const dropRef = useRef(dropTarget);
  const finishRename = (save: boolean) => {
    const current = editRef.current;
    editRef.current = null;
    setEdit(null);
    if (save && current?.name.trim()) onRename(current.id, current.name.trim());
  };
  useEffect(() => {
    if (editRef.current && editRef.current.id !== activeId) {
      editRef.current = null;
      setEdit(null);
    }
  }, [activeId]);
  const finishDrag = () => {
    dragRef.current = null;
    dropRef.current = null;
    setDropTarget(null);
  };
  const drop = (event: React.DragEvent) => {
    if (!dragRef.current || !dropRef.current) return;
    event.preventDefault();
    const source = tabs.findIndex(tab => tab.id === dragRef.current);
    let index = tabs.findIndex(tab => tab.id === dropRef.current!.id);
    if (source >= 0 && index >= 0) {
      if (!dropRef.current.before) index++;
      if (source < index) index--;
      onReorder(dragRef.current, index);
    }
    finishDrag();
  };

  return <div role="tablist" aria-label={label} onDrop={drop}
    style={{ display: 'flex', flexShrink: 0, overflowX: 'auto', alignItems: 'center', gap: 3,
      padding: '4px 8px', borderBottom: '1px solid var(--vscode-sideBar-border, #333)' }}>
    {tabs.map(tab => <div key={tab.id} data-group-tab={tab.id} draggable={false}
      onDragStart={event => {
        if ((event.target as Element).closest('input, [data-tab-control]')) { event.preventDefault(); return; }
        dragRef.current = tab.id;
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', tab.id);
      }}
      onDragEnd={finishDrag}
      onDragOver={event => {
        if (!dragRef.current) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        const rect = event.currentTarget.getBoundingClientRect();
        const target = { id: tab.id, before: event.clientX < rect.left + rect.width / 2 };
        dropRef.current = target;
        setDropTarget(target);
      }}
      style={{ display: 'flex', flexShrink: 0, alignItems: 'center', borderRadius: '3px 3px 0 0',
        borderBottom: tab.id === activeId ? '2px solid var(--vscode-focusBorder, #007fd4)' : '2px solid transparent',
        background: tab.id === activeId ? 'var(--vscode-tab-activeBackground, #333)' : 'transparent',
        boxShadow: dropTarget?.id === tab.id ? `${dropTarget.before ? 2 : -2}px 0 0 inset var(--vscode-focusBorder, #007fd4)` : undefined }}>
      {tab.samplingEnabled !== undefined && <input type="checkbox" checked={tab.samplingEnabled}
        aria-label={`采样 ${tab.name}`} title={tab.samplingEnabled ? '已启用采样，取消勾选停止采样' : '勾选后采样'}
        onChange={event => onSamplingChange?.(tab.id, event.target.checked)}
        style={{ cursor: 'pointer', margin: '0 2px 0 5px' }} />}
      {edit?.id === tab.id ? <input autoFocus aria-label="分组名称" value={edit.name} maxLength={128}
        title="回车或失焦保存，Escape 取消" onFocus={event => event.target.select()}
        onChange={event => {
          const current = { id: tab.id, name: event.target.value };
          editRef.current = current;
          setEdit(current);
        }}
        onBlur={() => finishRename(true)}
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); finishRename(true); }
          if (event.key === 'Escape') { event.preventDefault(); finishRename(false); }
        }}
        style={{ width: `${Math.min(24, Math.max(7, edit.name.length + 1))}ch`, padding: '1px 4px', fontSize: 12,
          background: 'var(--vscode-input-background, #3c3c3c)', color: 'var(--vscode-input-foreground, #ccc)',
          border: '1px solid var(--vscode-focusBorder, #007fd4)', borderRadius: 3 }} />
      : <button type="button" role="tab" draggable aria-selected={tab.id === activeId}
        title={tab.title ?? `${tab.name}（双击重命名，拖动排序）`}
        onDoubleClick={() => { editRef.current = { id: tab.id, name: tab.name }; setEdit(editRef.current); }}
        onClick={() => onSelect(tab.id)}
        style={{ ...buttonStyle, fontSize: 12, cursor: 'grab', color: 'var(--vscode-foreground, #ccc)', whiteSpace: 'nowrap' }}>
        {tab.running && <span aria-label="正在调试" style={{ color: 'var(--vscode-charts-green, #4ec9b0)', marginRight: 3 }}>●</span>}
        {tab.name}
        {tab.warning && <span aria-label="记录不完整"> ⚠</span>}
      </button>}
      <button type="button" data-tab-control="" aria-label={`删除 ${tab.name}`} disabled={tab.closable === false}
        title={tab.closable === false ? '至少保留一个分组' : `删除 ${tab.name}`}
        onClick={() => onRemove(tab.id)} style={{ ...buttonStyle, minWidth: 20, padding: '0 3px',
          opacity: tab.closable === false ? 0.3 : 0.7, cursor: tab.closable === false ? 'default' : 'pointer' }}>×</button>
    </div>)}
    <button type="button" aria-label={`添加 ${label}`} title={`添加 ${label}`} onClick={onAdd}
      style={{ ...buttonStyle, flexShrink: 0 }}>+</button>
    {children}
  </div>;
}

const buttonStyle: React.CSSProperties = {
  background: 'none', border: 'none', cursor: 'pointer', padding: '0 6px', minWidth: 24, height: 22,
  color: 'var(--vscode-descriptionForeground, #888)', fontSize: 14,
  fontFamily: 'var(--vscode-editor-font-family, monospace)', lineHeight: '20px',
};
