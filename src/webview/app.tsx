import React, { useEffect, useState, useCallback } from 'react';

interface VSCODE_API {
  postMessage(message: any): void;
}
declare function acquireVsCodeApi(): VSCODE_API;

let vscode: VSCODE_API;
try {
  vscode = typeof acquireVsCodeApi !== 'undefined' ? acquireVsCodeApi() : { postMessage: () => {} };
} catch (err) {
  console.error('[Ozone] failed to acquire vscode API:', err);
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
  error?: string;
}

interface WatchValue {
  expression: string;
  value: number;
  display: string;
  hex: string;
  address?: number;
  error?: string;
}

export function App() {
  console.log('[Ozone] App rendering');
  const [state, setState] = useState<DebugState>('disconnected');
  const [activePanel, setActivePanel] = useState<string>('control');
  const [config, setConfig] = useState<FlashConfig>({ device: '', elfPath: '', jlinkPath: '', workspaceRoot: '' });
  const [registers, setRegisters] = useState<RegisterValue[]>([]);
  const [memoryBlock, setMemoryBlock] = useState<MemoryBlock | null>(null);
  const [watches, setWatches] = useState<WatchEntry[]>([]);

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
          setWatches(prev => prev.map((w, i) => {
            const r = msg.results?.[i];
            if (!r) return w;
            if (r.error === 'running') {
              return { ...w, value: w.value || 'Running...' };
            }
            if (r.error) {
              return { expression: w.expression, error: r.error, value: undefined };
            }
            return { expression: w.expression, value: r.display, error: undefined };
          }));
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

function WatchPanel({ watches, setWatches }: {
  watches: WatchEntry[];
  setWatches: React.Dispatch<React.SetStateAction<WatchEntry[]>>;
}) {
  const [newExpr, setNewExpr] = useState('');
  const [polling, setPolling] = useState(false);

  const addWatch = () => {
    const expr = newExpr.trim();
    if (!expr) return;
    setWatches(prev => [...prev, { expression: expr }]);
    setNewExpr('');
  };

  const removeWatch = (index: number) => {
    setWatches(prev => prev.filter((_, i) => i !== index));
  };

  const refreshAll = () => {
    const exprs = watches.map(w => w.expression);
    if (exprs.length > 0) {
      vscode.postMessage({ command: 'evaluateWatches', expressions: exprs });
    }
  };

  useEffect(() => {
    if (watches.length === 0 || polling === false) return;
    const interval = setInterval(() => {
      const exprs = watches.map(w => w.expression);
      vscode.postMessage({ command: 'evaluateWatches', expressions: exprs });
    }, 200);
    return () => clearInterval(interval);
  }, [polling, watches.length]);

  return (
    <div style={{ fontSize: '12px' }}>
      <div style={{ display: 'flex', gap: '4px', marginBottom: '8px' }}>
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
      {watches.length === 0 ? (
        <div style={{ opacity: 0.5, textAlign: 'center', padding: '20px' }}>
          输入变量名后点击 + 添加监视
        </div>
      ) : (
        watches.map((w, i) => (
          <div key={i} style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            padding: '3px 4px', borderBottom: '1px solid var(--border)',
          }}>
            <span style={{ color: 'var(--vscode-symbolIcon-variableForeground)', fontWeight: 500 }}>
              {w.expression}
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{
                color: w.value === 'Running...' ? 'var(--vscode-descriptionForeground)' :
                       w.error ? 'var(--vscode-errorForeground)' : 'var(--vscode-editor-foreground)',
                fontFamily: 'monospace',
              }}>
                {w.value || '...'}
              </span>
              <button onClick={() => removeWatch(i)}
                style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  color: 'var(--vscode-errorForeground)', fontSize: '12px', padding: '0 2px',
                }}>✕</button>
            </div>
          </div>
        ))
      )}
      <div style={{ fontSize: '10px', color: 'var(--vscode-descriptionForeground)', marginTop: '8px', textAlign: 'center' }}>
        按 ▶ 开启 5Hz 运行中轮询 · 暂停时自动更新
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
      <p>Configure Ozone paths, AI provider, and debug defaults in VS Code settings.</p>
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