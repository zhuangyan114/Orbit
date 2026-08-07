import React, { useEffect, useState, useCallback, useRef } from 'react';
import { extractEditableWatchValue, parseWatchValueInput } from './watch-value-input';

interface VSCODE_API {
  postMessage(message: any): void;
}
declare function acquireVsCodeApi(): VSCODE_API;

let vscode: VSCODE_API;
try {
  vscode = typeof acquireVsCodeApi !== 'undefined' ? acquireVsCodeApi() : { postMessage: () => {} };
} catch (err) {
  console.error('[Orbit] failed to acquire vscode API:', err);
  vscode = { postMessage: () => {} };
}

type DebugState = 'disconnected' | 'connected' | 'running' | 'halted' | 'error';

interface FlashConfig {
  device: string;
  elfPath: string;
  jlinkPath: string;
  workspaceRoot: string;
}

interface RegisterValue {
  name: string;
  value: number;
  hex: string;
}

interface MemoryBlock {
  address: number;
  data: number[];
  ascii: string;
}

interface VariableValue {
  name: string;
  address: number;
  value: number;
  display: string;
  hex: string;
}

interface WatchEntry {
  expression: string;
  value?: string;
  typeName?: string;
  address?: number;
  error?: string;
  hasChildren?: boolean;
  children?: WatchEntry[];
}

function mapChildren(children: WatchValue[], parentExpr: string): WatchEntry[] {
  return children.map(c => {
    const fullExpr = c.expression.startsWith('[') ? `${parentExpr}${c.expression}` : `${parentExpr}.${c.expression}`;
    const isCompound = !!(c.children && c.children.length > 0);
    return {
      expression: fullExpr,
      value: isCompound ? `0x${(c.address || 0).toString(16).toUpperCase()}` : c.display,
      typeName: c.typeName,
      address: c.address,
      hasChildren: isCompound,
      children: isCompound ? mapChildren(c.children!, fullExpr) : undefined,
    };
  });
}

interface WatchValue {
  expression: string;
  value: number | string;
  display: string;
  hex: string;
  address?: number;
  error?: string;
  typeName?: string;
  children?: WatchValue[];
}

export function App() {
  console.log('[Orbit] App rendering');
  const [state, setState] = useState<DebugState>('disconnected');
  const [activePanel, setActivePanel] = useState<string>('control');
  const [config, setConfig] = useState<FlashConfig>({ device: '', elfPath: '', jlinkPath: '', workspaceRoot: '' });
  const [registers, setRegisters] = useState<RegisterValue[]>([]);
  const [memoryBlock, setMemoryBlock] = useState<MemoryBlock | null>(null);
  const [watches, setWatches] = useState<WatchEntry[]>([]);
  const watchesRef = useRef(watches);
  watchesRef.current = watches;

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      switch (msg.command) {
        case 'stateUpdate':
          setState(msg.state);
          break;
        case 'registers':
          setRegisters(msg.registers);
          break;
        case 'memoryData':
          setMemoryBlock(msg.block);
          break;
        case 'showAIPanel':
          setActivePanel('ai');
          break;
        case 'showMemoryPanel':
          setActivePanel('memory');
          break;
        case 'config':
          setConfig({ device: msg.device, elfPath: msg.elfPath, jlinkPath: msg.jlinkPath, workspaceRoot: msg.workspaceRoot });
          break;
        case 'elfSelected':
          setConfig(prev => ({ ...prev, elfPath: msg.elfPath }));
          break;
        case 'watchResults':
          setWatches(prev => {
            const next = prev.map((w, i) => {
              const r = msg.results?.[i];
              if (!r) return w;
              const isCompound = !!(r.children && r.children.length > 0);
              if (r.error === 'running') {
                return { ...w, value: w.value || 'Running...', hasChildren: w.hasChildren };
              }
              if (r.error) {
                return { expression: w.expression, error: r.error, value: undefined, typeName: w.typeName, address: w.address, hasChildren: w.hasChildren };
              }
              return {
                expression: w.expression,
                value: isCompound ? `0x${(r.address || 0).toString(16).toUpperCase()}` : r.display,
                typeName: r.typeName,
                address: r.address,
                error: undefined,
                hasChildren: isCompound,
                children: isCompound ? mapChildren(r.children, w.expression) : undefined,
              };
            });
            return next;
          });
          break;
        case 'watchValueSet':
          if (msg.ok) {
            const exprs = watchesRef.current.map(w => w.expression);
            if (exprs.length > 0) {
              vscode.postMessage({ command: 'evaluateWatches', expressions: exprs });
            }
          }
          break;
      }
    };
    window.addEventListener('message', handler);
    return () => { window.removeEventListener('message', handler); };
  }, []);

  useEffect(() => {
    vscode.postMessage({ command: 'getConfig' });
  }, []);

  useEffect(() => {
    if (watches.length === 0 || state !== 'halted') return;
    const exprs = watches.map(w => w.expression);
    vscode.postMessage({ command: 'evaluateWatches', expressions: exprs });
  }, [state, watches.length]);

  const send = useCallback((command: string) => vscode.postMessage({ command }), []);

  const tabs = [
    { id: 'control', label: 'Control' },
    { id: 'watch', label: 'Watch' },
    { id: 'registers', label: 'Registers' },
    { id: 'memory', label: 'Memory' },
    { id: 'ai', label: 'AI' },
    { id: 'settings', label: 'Settings' },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', height: '100%' }}>
      {/* Session Status */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '8px',
        padding: '6px 8px', borderRadius: '4px',
        background: state === 'disconnected' ? 'var(--vscode-inputValidation-errorBackground)' :
                     state === 'running' ? 'var(--vscode-editorInfo-background)' :
                     'var(--vscode-inputValidation-infoBackground)',
      }}>
        <div style={{
          width: 8, height: 8, borderRadius: '50%',
          background: state === 'disconnected' ? '#f14c4c' :
                      state === 'running' ? '#4ec9b0' :
                      state === 'halted' ? '#dcdcaa' : '#ce9178',
        }} />
        <span style={{ flex: 1, fontWeight: 500, fontSize: '12px' }}>
          {state === 'disconnected' ? 'Disconnected' :
           state === 'connected' ? 'Connected' :
           state === 'running' ? 'Running' :
           state === 'halted' ? 'Halted' : 'Error'}
        </span>
        {state === 'disconnected' ? (
          <button onClick={() => send('debug')}
            style={btnStyle}>🐞 Debug</button>
        ) : (
          <button onClick={() => send('stopSession')}
            style={{ ...btnStyle, background: '#f14c4c' }}>Disconnect</button>
        )}
      </div>

      {/* Tab Bar */}
      <div style={{ display: 'flex', gap: '2px', borderBottom: '1px solid var(--border)' }}>
        {tabs.map(tab => (
          <button key={tab.id} onClick={() => setActivePanel(tab.id)}
            style={{
              ...tabBtnStyle,
              borderBottom: activePanel === tab.id ? '2px solid var(--accent)' : '2px solid transparent',
              color: activePanel === tab.id ? 'var(--accent)' : 'var(--fg)',
            }}>{tab.label}</button>
        ))}
      </div>

      {/* Panels */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        {activePanel === 'control' && <ControlPanel send={send} state={state} config={config} />}
        {activePanel === 'watch' && <WatchPanel watches={watches} setWatches={setWatches} />}
        {activePanel === 'registers' && <RegistersPanel registers={registers} />}
        {activePanel === 'memory' && <MemoryPanel send={send} block={memoryBlock} />}
        {activePanel === 'ai' && <AIPanel />}
        {activePanel === 'settings' && <SettingsPanel send={send} />}
      </div>
    </div>
  );
}

function ControlPanel({ send, state, config }: {
  send: (cmd: string) => void;
  state: DebugState;
  config: FlashConfig;
}) {
  const halted = state === 'halted';
  const connected = state !== 'disconnected';
  const [editing, setEditing] = useState(false);
  const [editDevice, setEditDevice] = useState(config.device);
  const [editElf, setEditElf] = useState(config.elfPath);

  useEffect(() => {
    setEditDevice(config.device);
    setEditElf(config.elfPath);
  }, [config]);

  const saveConfig = () => {
    vscode.postMessage({ command: 'setDevice', device: editDevice });
    vscode.postMessage({ command: 'setElfPath', elfPath: editElf });
    setEditing(false);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      {/* Flash / Debug / Edit buttons */}
      <div style={{ display: 'flex', gap: '4px' }}>
        <button onClick={() => send('flash')} style={actionBtnStyle}>
          🔥 烧录
        </button>
        {!connected && (
          <button onClick={() => send('debug')} style={actionBtnStyle}>
            🐞 调试
          </button>
        )}
        <button onClick={() => setEditing(!editing)} style={{
          ...actionBtnStyle,
          background: editing ? 'var(--vscode-button-secondaryBackground)' : 'var(--vscode-button-background)',
        }}>
          ⚙ 编辑
        </button>
      </div>

      {/* Edit panel */}
      {editing && (
        <div style={{
          padding: '8px', borderRadius: '4px',
          background: 'var(--vscode-editorWidget-background)',
          border: '1px solid var(--border)',
          fontSize: '12px',
          display: 'flex', flexDirection: 'column', gap: '6px',
        }}>
          <div>
            <label style={{ display: 'block', marginBottom: '2px', color: 'var(--vscode-descriptionForeground)' }}>
              芯片型号
            </label>
            <input value={editDevice} onChange={e => setEditDevice(e.target.value)}
              placeholder="e.g. STM32F407IG"
              style={{ width: '100%', boxSizing: 'border-box', ...inputStyle }} />
          </div>
          <div>
            <label style={{ display: 'block', marginBottom: '2px', color: 'var(--vscode-descriptionForeground)' }}>
              .elf 文件路径
            </label>
            <div style={{ display: 'flex', gap: '4px' }}>
              <input value={editElf} onChange={e => setEditElf(e.target.value)}
                placeholder="Auto-detect or browse..."
                style={{ flex: 1, ...inputStyle }} />
              <button onClick={() => vscode.postMessage({ command: 'browseElf' })}
                style={btnStyle}>浏览</button>
            </div>
          </div>
          <div style={{ display: 'flex', gap: '4px', justifyContent: 'flex-end' }}>
            <button onClick={() => setEditing(false)} style={{ ...btnStyle, background: 'transparent', border: '1px solid var(--border)' }}>
              取消
            </button>
            <button onClick={saveConfig} style={btnStyle}>保存</button>
          </div>
        </div>
      )}

      {/* Debug controls */}
      {connected && (
        <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
          {!halted ? (
            <button onClick={() => send('halt')} style={iconBtnStyle}>⏸ Halt</button>
          ) : (
            <button onClick={() => send('run')} style={iconBtnStyle}>▶ Run</button>
          )}
          <button onClick={() => send('stepInto')} disabled={!halted} style={iconBtnStyle}>↘ Step Into</button>
          <button onClick={() => send('stepOver')} disabled={!halted} style={iconBtnStyle}>→ Step Over</button>
          <button onClick={() => send('stepOut')} disabled={!halted} style={iconBtnStyle}>↖ Step Out</button>
          <button onClick={() => send('reset')} style={iconBtnStyle}>⟳ Reset</button>
          <button onClick={() => send('stopSession')} style={{ ...iconBtnStyle, background: '#f14c4c' }}>✕ 断开</button>
        </div>
      )}
    </div>
  );
}

function RegistersPanel({ registers }: { registers: RegisterValue[] }) {
  return (
    <div style={{ fontSize: '12px', fontFamily: 'var(--vscode-editor-font-family)' }}>
      {registers.length === 0 ? (
        <div style={{ opacity: 0.5, textAlign: 'center', padding: '20px' }}>
          Halt the target to read registers
        </div>
      ) : (
        registers.map(r => (
          <div key={r.name} style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 4px' }}>
            <span style={{ color: 'var(--vscode-symbolIcon-variableForeground)' }}>{r.name}</span>
            <span style={{ color: 'var(--vscode-editor-foreground)', fontFamily: 'monospace' }}>{r.hex}</span>
          </div>
        ))
      )}
    </div>
  );
}

function MemoryPanel({ send, block }: { send: (cmd: string) => void; block: MemoryBlock | null }) {
  const [address, setAddress] = useState('0x20000000');
  const [size, setSize] = useState(128);

  const doRead = () => {
    const addr = parseInt(address, 16);
    if (isNaN(addr)) return;
    vscode.postMessage({ command: 'readMemory', address: addr, size });
  };

  const hexDump = block ? block.data.map((b, i) => {
    const offset = block.address + i;
    if (i % 16 === 0) {
      const hexBytes = block.data.slice(i, i + 16).map(b => b.toString(16).padStart(2, '0')).join(' ');
      const asciiBytes = block.data.slice(i, i + 16).map(b => (b >= 0x20 && b <= 0x7E) ? String.fromCharCode(b) : '.').join('');
      return (
        <div key={i} style={{ display: 'flex', gap: '8px', fontFamily: 'monospace', whiteSpace: 'pre' }}>
          <span style={{ color: 'var(--vscode-textPreformat-foreground)' }}>
            {offset.toString(16).padStart(8, '0')}
          </span>
          <span>{hexBytes.padEnd(47)}</span>
          <span style={{ color: 'var(--vscode-descriptionForeground)' }}>{asciiBytes}</span>
        </div>
      );
    }
    return null;
  }) : null;

  return (
    <div style={{ fontSize: '12px', fontFamily: 'var(--vscode-editor-font-family)' }}>
      <div style={{ display: 'flex', gap: '4px', marginBottom: '8px' }}>
        <input value={address} onChange={e => setAddress(e.target.value)}
          placeholder="Address (e.g., 0x20000000)"
          style={{ flex: 1, ...inputStyle }} />
        <input value={size} onChange={e => setSize(Number(e.target.value))}
          type="number" min={1} max={1024}
          style={{ width: 60, ...inputStyle }} />
        <button onClick={doRead} style={btnStyle}>Read</button>
      </div>
      <div>
        {block ? (
          <div style={{ fontSize: '11px', lineHeight: '1.6' }}>
            {hexDump?.filter(Boolean)}
          </div>
        ) : (
          <div style={{ opacity: 0.5, textAlign: 'center', padding: '20px' }}>
            Enter an address and click Read
          </div>
        )}
      </div>
    </div>
  );
}

const CHANGE_HIGHLIGHT_MS = 500;

function WatchPanel({ watches, setWatches }: {
  watches: WatchEntry[];
  setWatches: React.Dispatch<React.SetStateAction<WatchEntry[]>>;
}) {
  const [newExpr, setNewExpr] = useState('');
  const [polling, setPolling] = useState(false);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [changedValues, setChangedValues] = useState<Set<string>>(new Set());
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const watchesRef = useRef(watches);
  watchesRef.current = watches;
  const editValueRef = useRef('');
  editValueRef.current = editValue;
  const prevValuesRef = useRef<Map<string, string>>(new Map());

  // Track value changes on each watches update
  useEffect(() => {
    if (watches.length === 0) { prevValuesRef.current.clear(); return; }
    const changed = new Set<string>();
    const walk = (entries: WatchEntry[], prefix = '') => {
      for (let i = 0; i < entries.length; i++) {
        const key = prefix ? `${prefix}.${i}` : String(i);
        const e = entries[i];
        const prev = prevValuesRef.current.get(e.expression);
        if (prev !== undefined && prev !== e.value && !e.hasChildren) {
          changed.add(key);
        }
        prevValuesRef.current.set(e.expression, e.value || '');
        if (e.children) walk(e.children, key);
      }
    };
    walk(watches);
    if (changed.size > 0) {
      setChangedValues(changed);
      setTimeout(() => setChangedValues(new Set()), CHANGE_HIGHLIGHT_MS);
    }
  }, [watches]);

  const addWatch = () => {
    const expr = newExpr.trim();
    if (!expr) return;
    setWatches(prev => [...prev, { expression: expr }]);
    setNewExpr('');
  };

  const removeWatch = (key: string) => {
    const parts = key.split('.');
    const idx = parseInt(parts[0], 10);
    if (isNaN(idx)) return;
    setWatches(prev => prev.filter((_, i) => i !== idx));
  };

  const refreshAll = () => {
    const exprs = watchesRef.current.map(w => w.expression);
    if (exprs.length > 0) {
      vscode.postMessage({ command: 'evaluateWatches', expressions: exprs });
    }
  };

  const startEditing = (key: string, currentValue: string) => {
    setEditingKey(key);
    setEditValue(extractEditableWatchValue(currentValue));
  };

  const commitEdit = (key: string) => {
    setEditingKey(null);
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
    const value = parseWatchValueInput(raw);
    if (value === null) return;
    vscode.postMessage({
      command: 'setWatchValue',
      expression: entry.expression,
      value,
      address: entry.address,
      typeName: entry.typeName,
    });
  };

  const cancelEdit = () => setEditingKey(null);

  const toggleExpand = (key: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const renderRow = (w: WatchEntry, key: string, depth: number): React.ReactNode[] => {
    const isExpanded = expandedRef.current.has(key);
    const showToggle = w.hasChildren && w.children && w.children.length > 0;
    const indent = depth * 18;

    const rows: React.ReactNode[] = [
      <div key={key} style={{
        display: 'grid', gridTemplateColumns: `${indent + 18}px minmax(96px, 1fr) minmax(120px, 1.5fr) minmax(72px, 1fr)`,
        borderBottom: '1px solid var(--border)',
        alignItems: 'center',
        background: depth > 0 ? 'rgba(127, 127, 127, 0.035)' : 'transparent',
      }}>
        <div style={{
          width: '100%', height: 18, display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
          paddingRight: 3, boxSizing: 'border-box',
          borderLeft: depth > 0 ? '1px solid var(--vscode-tree-indentGuidesStroke, rgba(128,128,128,0.35))' : 'none',
          cursor: showToggle ? 'pointer' : 'default', userSelect: 'none',
        }}
          onClick={() => showToggle && toggleExpand(key)}>
          {showToggle ? (isExpanded ? '▼' : '▶') : ''}
        </div>

        <div style={{
          padding: '2px 4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          color: 'var(--vscode-symbolIcon-variableForeground)',
          fontSize: depth > 0 ? '11px' : '12px',
        }}>
          {w.expression.includes('.') ? w.expression.split('.').pop() : w.expression}
        </div>

        <div style={{
          padding: '2px 4px', fontFamily: 'monospace', fontSize: depth > 0 ? '11px' : '12px',
          cursor: w.hasChildren ? 'default' : 'text',
          color: changedValues.has(key) ? 'var(--vscode-charts-green)' :
                 w.value === 'Running...' ? 'var(--vscode-descriptionForeground)' :
                 w.error ? 'var(--vscode-errorForeground)' : 'var(--vscode-editor-foreground)',
        }}
          onClick={() => {
            if (!w.hasChildren && w.value && w.value !== 'Running...' && !w.error) startEditing(key, w.value);
          }}>
          {editingKey === key ? (
            <input value={editValue}
              onChange={e => setEditValue(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') { e.preventDefault(); commitEdit(key); }
                if (e.key === 'Escape') cancelEdit();
              }}
              onBlur={cancelEdit}
              autoFocus
              style={{
                width: '100%', boxSizing: 'border-box', ...inputStyle,
                padding: '1px 4px', fontSize: '12px',
              }} />
          ) : (
            <span style={{
              borderBottom: !w.hasChildren && w.value && w.value !== '...' && w.value !== 'Running...'
                ? '1px dashed var(--vscode-input-placeholderForeground)' : 'none',
            }}>
              {w.value || '...'}
            </span>
          )}
        </div>

        <div style={{
          padding: '2px 4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          color: 'var(--vscode-descriptionForeground)', fontSize: depth > 0 ? '10px' : '11px',
        }}>
          {w.typeName || ''}
        </div>
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
    <div style={{ fontSize: '12px', display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ display: 'flex', gap: '4px', marginBottom: '4px' }}>
        <input value={newExpr} onChange={e => setNewExpr(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') addWatch(); }}
          placeholder="变量名或表达式"
          style={{ flex: 1, ...inputStyle }} />
        <button onClick={addWatch} style={btnStyle}>+</button>
        <button onClick={refreshAll} style={btnStyle}>⟳</button>
        <button onClick={() => setPolling(!polling)} style={{
          ...btnStyle,
          background: polling ? 'var(--vscode-button-secondaryBackground)' : 'var(--vscode-button-background)',
        }}>
          {polling ? '⏹' : '▶'}
        </button>
      </div>

      {watches.length > 0 && (
        <div style={{
          display: 'grid', gridTemplateColumns: '16px 1fr 1.5fr 1fr',
          borderBottom: '2px solid var(--border)',
          padding: '4px 16px 4px 4px', fontSize: '11px', fontWeight: 600,
          color: 'var(--vscode-descriptionForeground)',
          userSelect: 'none',
        }}>
          <span />
          <span>Name</span>
          <span>Value</span>
          <span>Type</span>
        </div>
      )}

      <div style={{ flex: 1, overflow: 'auto' }}>
        {watches.length === 0 ? (
          <div style={{ opacity: 0.5, textAlign: 'center', padding: '20px' }}>
            输入变量名后点击 + 添加监视
          </div>
        ) : (
          watches.map((w, i) => renderRow(w, String(i), 0))
        )}
      </div>

      <div style={{ fontSize: '10px', color: 'var(--vscode-descriptionForeground)', padding: '4px', textAlign: 'center' }}>
        点击 ▶ 展开 · 点击数值可编辑 · Enter 确认
      </div>
    </div>
  );
}

function AIPanel() {
  const [messages, setMessages] = useState<{role: string; text: string}[]>([]);
  const [input, setInput] = useState('');

  const sendMessage = () => {
    if (!input.trim()) return;
    setMessages(prev => [...prev, { role: 'user', text: input }]);
    setMessages(prev => [...prev, { role: 'assistant', text: 'AI analysis will appear here... (connect to Ollama or OpenAI)' }]);
    setInput('');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', height: '100%' }}>
      <div style={{ flex: 1, overflow: 'auto', fontSize: '12px' }}>
        {messages.length === 0 && (
          <div style={{ textAlign: 'center', padding: '20px', opacity: 0.5 }}>
            <div style={{ fontSize: '24px', marginBottom: '8px' }}>🤖</div>
            <div>Ask the AI assistant about your debug session</div>
            <div style={{ fontSize: '11px', marginTop: '4px' }}>
              Configure AI provider in settings
            </div>
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} style={{
            padding: '6px 8px', marginBottom: '4px', borderRadius: '4px',
            background: msg.role === 'user'
              ? 'var(--vscode-textBlockQuote-background)'
              : 'transparent',
            borderLeft: msg.role === 'assistant' ? '2px solid var(--accent)' : 'none',
          }}>
            <div style={{ fontWeight: 600, fontSize: '11px', marginBottom: '2px' }}>
              {msg.role === 'user' ? 'You' : 'AI'}
            </div>
            <div>{msg.text}</div>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: '4px' }}>
        <input value={input} onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && sendMessage()}
          placeholder="Ask about registers, code, or crashes..."
          style={{ flex: 1, ...inputStyle }} />
        <button onClick={sendMessage} style={btnStyle}>Send</button>
      </div>
    </div>
  );
}

function SettingsPanel({ send }: { send: (cmd: string) => void }) {
  return (
    <div style={{ fontSize: '12px' }}>
      <p>Configure Orbit paths, AI provider, and debug defaults in VS Code settings.</p>
      <button onClick={() => send('openSettings')} style={btnStyle}>
        Open Settings
      </button>
    </div>
  );
}

const actionBtnStyle: React.CSSProperties = {
  flex: 1, padding: '6px 4px', border: 'none', borderRadius: '3px',
  background: 'var(--vscode-button-background)', color: 'var(--vscode-button-foreground)',
  cursor: 'pointer', fontSize: '12px', fontFamily: 'inherit', fontWeight: 500,
};

const btnStyle: React.CSSProperties = {
  padding: '4px 10px', border: 'none', borderRadius: '3px',
  background: 'var(--vscode-button-background)', color: 'var(--vscode-button-foreground)',
  cursor: 'pointer', fontSize: '12px', fontFamily: 'inherit',
};

const iconBtnStyle: React.CSSProperties = {
  ...btnStyle,
  padding: '4px 8px',
  fontSize: '11px',
};

const tabBtnStyle: React.CSSProperties = {
  padding: '4px 10px', border: 'none', background: 'transparent',
  cursor: 'pointer', fontSize: '11px', fontFamily: 'inherit',
};

const inputStyle: React.CSSProperties = {
  padding: '3px 6px', border: '1px solid var(--border)',
  borderRadius: '3px', background: 'var(--vscode-input-background)',
  color: 'var(--vscode-input-foreground)', fontSize: '12px',
  fontFamily: 'var(--vscode-editor-font-family)',
};
