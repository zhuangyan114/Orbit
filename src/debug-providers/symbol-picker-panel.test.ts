import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SymbolCatalog } from '../symbols/symbol-catalog';
const state = vi.hoisted(() => ({ panels: [] as any[], errors: vi.fn(), changed: new Set<Function>(), terminated: new Set<Function>(), create: vi.fn() }));
function event<T>() {
  const callbacks = new Set<(value: T) => void>();
  return { on: (callback: (value: T) => void) => { callbacks.add(callback); return { dispose: () => callbacks.delete(callback) }; },
    emit: (value: T) => { for (const callback of [...callbacks]) callback(value); } };
}
class FakePanel {
  active = true; disposed = false;
  messages = event<any>(); disposedEvent = event<void>(); viewState = event<any>();
  onDidDispose = this.disposedEvent.on; onDidChangeViewState = this.viewState.on;
  webview = { html: '', cspSource: 'webview-source', asWebviewUri: (uri: any) => String(uri),
    postMessage: vi.fn(async (_message: any) => true), onDidReceiveMessage: this.messages.on };
  dispose() { this.disposed = true; this.disposedEvent.emit(); }
  send(message: any) { this.messages.emit(message); }
  init() { this.send({ command: 'ready' }); return this.webview.postMessage.mock.calls.at(-1)![0]; }
  loseActive() { this.active = false; this.viewState.emit({ webviewPanel: this }); }
}
vi.mock('vscode', () => ({
  window: { createWebviewPanel: (...args: any[]) => { state.create(...args); const panel = new FakePanel(); state.panels.push(panel); return panel; }, showErrorMessage: state.errors },
  ViewColumn: { Active: -1 }, Uri: { joinPath: (...parts: any[]) => parts.join('/') },
  debug: {
    onDidChangeActiveDebugSession: (callback: Function) => { state.changed.add(callback); return { dispose: () => state.changed.delete(callback) }; },
    onDidTerminateDebugSession: (callback: Function) => { state.terminated.add(callback); return { dispose: () => state.terminated.delete(callback) }; },
  },
}));
import { SymbolPickerPanel, type SymbolPickerRequest } from './symbol-picker-panel';
const catalog: SymbolCatalog = { roots: [
  { id: 'motor', expression: 'motor', file: 'motor.c', typeOffset: 'struct', address: 0x20000000, size: 4, pointerDepth: 0 },
  { id: 'counter', expression: 'counter', file: 'main.c', typeOffset: 'int', address: 0x20000004, size: 1, pointerDepth: 0 },
], types: {
  struct: { kind: 'struct', name: 'Motor', byteSize: 4, fields: [{ name: 'speed', typeOffset: 'float', byteOffset: 0 }] },
  float: { kind: 'base', name: 'float', byteSize: 4 }, int: { kind: 'base', name: 'int8_t', byteSize: 1 },
} };
function request(overrides: Partial<SymbolPickerRequest> = {}) {
  return { mode: 'watch' as const, title: 'Watch', existing: [], loadCatalog: vi.fn(async () => catalog), canOpen: () => true, commit: vi.fn(), ...overrides };
}
function service() { return new SymbolPickerPanel({ extensionUri: 'extension-uri' as any }); }
const latest = () => state.panels.at(-1) as FakePanel;
beforeEach(() => { state.panels = []; state.errors.mockReset(); state.create.mockReset(); state.changed.clear(); state.terminated.clear(); });
afterEach(() => vi.useRealTimers());

describe('shared symbol editor panel', () => {
  it('opens a shared editor webview and initializes its source, mode and saved checkboxes', async () => {
    const picker = service(); const source = request({ existing: ['counter'] }); await picker.open(source); const panel = latest();
    expect(state.create).toHaveBeenCalledWith('orbit.symbolPicker', 'Watch', { viewColumn: -1, preserveFocus: false }, expect.objectContaining({ enableScripts: true }));
    expect(panel.init()).toMatchObject({ command: 'init', catalog, mode: 'watch', existing: ['counter'] });
    expect(panel.webview.html).toContain('dist/symbol-picker.js'); expect(panel.webview.html).toContain("script-src 'nonce-");
    picker.dispose();
  });
  it('commits the final checkbox snapshot only on explicit Add and only once', async () => {
    const picker = service(); const source = request(); await picker.open(source); const panel = latest(), { token } = panel.init();
    panel.send({ command: 'selectionChanged', token, selectedIds: ['counter'] });
    panel.send({ command: 'add', token, selectedIds: ['counter', 'motor/0'] });
    panel.send({ command: 'add', token, selectedIds: ['counter', 'motor/0'] });
    expect(source.commit).toHaveBeenCalledWith(['counter', 'motor.speed'], []); expect(panel.disposed).toBe(true);
    picker.dispose(); expect(source.commit).toHaveBeenCalledOnce();
  });
  it('discards the draft when changing editor tabs', async () => {
    const picker = service(); const source = request(); await picker.open(source); const panel = latest(), { token } = panel.init();
    panel.send({ command: 'selectionChanged', token, selectedIds: ['counter'] }); panel.loseActive();
    expect(panel.disposed).toBe(true);
    panel.send({ command: 'add', token, selectedIds: ['motor/0', 'counter'] });
    expect(source.commit).not.toHaveBeenCalled(); picker.dispose();
  });
  it('never treats Close, including an old close-with-selection payload, as Add', async () => {
    const picker = service(); const source = request({ existing: ['counter'] }); await picker.open(source); const panel = latest(), { token } = panel.init();
    panel.send({ command: 'close', token, selectedIds: ['motor/0'], removedExpressions: ['counter'] });
    expect(panel.disposed).toBe(true); expect(source.commit).not.toHaveBeenCalled(); picker.dispose();
  });
  it('discards choices on the editor close button and disposes session listeners', async () => {
    const picker = service(); const source = request(); await picker.open(source); const panel = latest(), { token } = panel.init();
    panel.send({ command: 'selectionChanged', token, selectedIds: ['motor'] }); panel.dispose();
    expect(source.commit).not.toHaveBeenCalled(); expect(state.changed.size).toBe(0); expect(state.terminated.size).toBe(0); picker.dispose();
  });
  it('uses at most one shared panel when switching from Watch to Timeline', async () => {
    const picker = service(); const watch = request(); await picker.open(watch); const previous = latest(), { token } = previous.init();
    previous.send({ command: 'selectionChanged', token, selectedIds: ['motor'] });
    await picker.open(request({ mode: 'timeline', title: 'Timeline' }));
    expect(watch.commit).not.toHaveBeenCalled(); expect(previous.disposed).toBe(true);
    expect(state.panels.filter(panel => !panel.disposed)).toHaveLength(1); expect(latest().init().mode).toBe('timeline'); picker.dispose();
  });
  it('validates selected ids and Timeline scalar eligibility using host ELF metadata', async () => {
    const picker = service(); const source = request({ mode: 'timeline' }); await picker.open(source); const panel = latest(), { token } = panel.init();
    panel.send({ command: 'add', token, selectedIds: ['motor', 'motor/0', 'counter', 'motor/-1', 'motor/99999999999', 'missing', { expression: 'injected' }] });
    expect(source.commit).toHaveBeenCalledWith(['motor.speed', 'counter'], []); picker.dispose();
  });
  it('commits explicit removals together with additions without replacing unlisted existing expressions', async () => {
    const picker = service(); const source = request({ existing: ['counter', 'manual_expression + 1'] });
    await picker.open(source); const panel = latest(), { token } = panel.init();
    panel.send({ command: 'add', token, selectedIds: ['motor/0', 'counter'],
      removedExpressions: ['counter', 'counter', 'not_in_original_group', null, { expression: 'manual_expression + 1' }] });
    expect(source.commit).toHaveBeenCalledOnce(); expect(source.commit).toHaveBeenCalledWith(['motor.speed'], ['counter']);
    expect(panel.disposed).toBe(true); picker.dispose();
  });
  it('accepts removal-only changes including a previously added unsupported Timeline variable', async () => {
    const picker = service(); const source = request({ mode: 'timeline', existing: ['motor'] });
    await picker.open(source); const panel = latest(), { token } = panel.init();
    panel.send({ command: 'add', token, selectedIds: [], removedExpressions: ['motor'] });
    expect(source.commit).toHaveBeenCalledOnce(); expect(source.commit).toHaveBeenCalledWith([], ['motor']); picker.dispose();
  });
  it('does not add existing choices again and honors explicit deselection before closing', async () => {
    const picker = service(); const source = request({ existing: ['counter'] }); await picker.open(source); const panel = latest(), { token } = panel.init();
    panel.send({ command: 'selectionChanged', token, selectedIds: ['motor/0', 'counter'] });
    panel.send({ command: 'add', token, selectedIds: ['counter'] }); expect(source.commit).not.toHaveBeenCalled(); picker.dispose();
  });
  it('rejects stale messages and pending loads after replacement, destination changes or disposal', async () => {
    const picker = service(); let resolve!: (catalog: SymbolCatalog) => void;
    const pending = picker.open(request({ loadCatalog: () => new Promise(next => { resolve = next; }) }));
    await picker.open(request({ title: 'new' })); const panel = latest(), { token } = panel.init(); resolve(catalog); await pending;
    panel.send({ command: 'close', token: token - 1, selectedIds: ['counter'] }); expect(panel.disposed).toBe(false);
    await picker.open(request({ canOpen: () => false })); expect(state.panels.filter(item => !item.disposed)).toHaveLength(0);
    picker.dispose(); await picker.open(request()); expect(state.panels).toHaveLength(1);
  });
  it('captures parse and persistence errors without leaving a second panel', async () => {
    const picker = service(); await picker.open(request({ loadCatalog: async () => { throw new Error('no ELF'); } }));
    expect(state.errors).toHaveBeenCalledWith(expect.stringContaining('no ELF'));
    await picker.open(request({ commit: async () => { throw new Error('save failed'); } }));
    const panel = latest(), { token } = panel.init(); panel.send({ command: 'add', token, selectedIds: ['counter'] });
    await Promise.resolve(); expect(state.errors).toHaveBeenCalledWith(expect.stringContaining('save failed')); picker.dispose();
  });
  it('discards drafts on session termination and extension disposal', async () => {
    const picker = service(); const source = request(); await picker.open(source); let panel = latest(), init = panel.init();
    panel.send({ command: 'selectionChanged', token: init.token, selectedIds: ['counter'] });
    for (const callback of [...state.terminated]) callback();
    expect(panel.disposed).toBe(true); expect(source.commit).not.toHaveBeenCalled();
    await picker.open(source); panel = latest(); init = panel.init();
    panel.send({ command: 'selectionChanged', token: init.token, selectedIds: ['motor'] }); picker.dispose();
    expect(panel.disposed).toBe(true); expect(source.commit).not.toHaveBeenCalled();
  });
});
