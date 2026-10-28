import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ activeDebugSession: undefined as any, offline: vi.fn() }));
vi.mock('vscode', () => ({ debug: state }));
vi.mock('./workspace-symbol-catalog', () => ({ loadWorkspaceSymbolCatalog: state.offline }));
import { loadActiveSymbolCatalog } from './symbol-catalog-loader';
afterEach(() => { state.activeDebugSession = undefined; });
beforeEach(() => { state.offline.mockReset().mockResolvedValue({ roots: [], types: {}, elfPath: 'firmware.elf' }); });
describe('symbol catalog DAP routing', () => {
  it('uses only the exact active Orbit session', async () => {
    const catalog = { roots: [], types: {} };
    const session = { type: 'orbit', customRequest: vi.fn(async () => ({ ok: true, data: catalog })) };
    state.activeDebugSession = session;
    expect(await loadActiveSymbolCatalog()).toEqual(catalog);
    expect(session.customRequest).toHaveBeenCalledOnce();
    expect(session.customRequest).toHaveBeenCalledWith('getSymbolCatalog');
  });
  it.each([undefined, { type: 'cppdbg' }])('loads the workspace ELF without an Orbit session', async session => {
    state.activeDebugSession = session;
    expect(await loadActiveSymbolCatalog()).toMatchObject({ elfPath: 'firmware.elf' });
    expect(state.offline).toHaveBeenCalledOnce();
  });
  it('does not query a starting or ended session', async () => {
    const session = { type: 'orbit', customRequest: vi.fn() }; state.activeDebugSession = session;
    await expect(loadActiveSymbolCatalog(() => false)).rejects.toThrow('Orbit');
    expect(session.customRequest).not.toHaveBeenCalled();
  });
  it('rejects a late reply after switching sessions', async () => {
    const session = { type: 'orbit', customRequest: vi.fn(async () => {
      state.activeDebugSession = { type: 'orbit' }; return { ok: true, data: { roots: [], types: {} } };
    }) }; state.activeDebugSession = session;
    await expect(loadActiveSymbolCatalog()).rejects.toThrow('会话已切换');
  });
  it.each([{ ok: false, error: 'ELF missing' }, { ok: true, data: {} }, null])('surfaces failed or malformed replies', async reply => {
    state.activeDebugSession = { type: 'orbit', customRequest: vi.fn(async () => reply) };
    await expect(loadActiveSymbolCatalog()).rejects.toThrow();
    expect(state.offline).not.toHaveBeenCalled();
  });
});
