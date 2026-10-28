import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
const state = vi.hoisted(() => ({ folders: [] as any[], configs: [] as any[], defaultProgram: '', candidates: [] as any[],
  choose: vi.fn(), open: vi.fn(), symbols: vi.fn(), dwarf: vi.fn() }));
vi.mock('vscode', () => ({
  workspace: { get workspaceFolders() { return state.folders; }, getConfiguration: (section: string) => ({ get: (key: string, fallback: unknown) =>
    section === 'launch' && key === 'configurations' ? state.configs : key === 'defaultProgram' ? state.defaultProgram : fallback }) },
  window: { showQuickPick: state.choose, showOpenDialog: state.open },
}));
vi.mock('../ozone-backend/flasher', () => ({ findElfFiles: () => state.candidates }));
vi.mock('../ozone-backend/jlink-symbols', async () => {
  const actual = await vi.importActual<typeof import('../ozone-backend/jlink-symbols')>('../ozone-backend/jlink-symbols');
  return { ...actual, readElfSymbols: state.symbols, parseDwarfTypeInfo: state.dwarf };
});
import { loadWorkspaceSymbolCatalog, resolveSymbolProgram } from './workspace-symbol-catalog';

let directory: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-offline-symbols-'));
  state.folders = [{ name: 'firmware', uri: { fsPath: directory } }]; state.configs = []; state.defaultProgram = ''; state.candidates = [];
  state.choose.mockReset(); state.open.mockReset();
  state.symbols.mockReset().mockResolvedValue([{ name: 'speed', size: 4, address: 0x20000000, type: 'B' }]);
  state.dwarf.mockReset().mockResolvedValue({ varToType: new Map(), typeDefs: new Map() });
});
afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); });
const file = (name: string) => { const result = path.join(directory, name); fs.writeFileSync(result, 'elf'); return result; };

describe('offline ELF symbol catalog', () => {
  it('resolves workspace, named-workspace and environment paths without executing commands', () => {
    expect(resolveSymbolProgram('${workspaceFolder}/build/frame.elf', directory, state.folders)).toBe(path.join(directory, 'build', 'frame.elf'));
    expect(resolveSymbolProgram('${workspaceFolder:firmware}/frame.elf', undefined, state.folders)).toBe(path.join(directory, 'frame.elf'));
    expect(resolveSymbolProgram('${command:cmake.launchTargetPath}', directory, state.folders)).toBeUndefined();
    expect(resolveSymbolProgram('${workspaceFolder:missing}/frame.elf', directory, state.folders)).toBeUndefined();
  });
  it('prefers the Orbit launch ELF and caches by file timestamp and size', async () => {
    const elf = file('launch.elf'); state.defaultProgram = file('old.elf');
    state.configs = [{ type: 'orbit', program: '${workspaceFolder}/launch.elf' }];
    expect(await loadWorkspaceSymbolCatalog()).toMatchObject({ elfPath: elf, roots: [expect.objectContaining({ expression: 'speed' })] });
    await loadWorkspaceSymbolCatalog(); expect(state.symbols).toHaveBeenCalledOnce();
    fs.appendFileSync(elf, 'rebuilt'); await loadWorkspaceSymbolCatalog(); expect(state.symbols).toHaveBeenCalledTimes(2);
    expect(state.choose).not.toHaveBeenCalled(); expect(state.open).not.toHaveBeenCalled();
  });
  it('uses the configured ELF or discovers a build artifact without debug configuration', async () => {
    state.defaultProgram = file('configured.elf'); expect((await loadWorkspaceSymbolCatalog()).elfPath).toBe(state.defaultProgram);
    state.defaultProgram = ''; state.candidates = [{ path: file('detected.elf') }];
    expect((await loadWorkspaceSymbolCatalog()).elfPath).toBe(state.candidates[0].path);
  });
  it('lets the user select between multiple firmware files instead of silently using the wrong one', async () => {
    const first = file('one.elf'), second = file('two.elf');
    state.configs = [{ type: 'orbit', program: first }, { type: 'ozone', program: second }];
    state.choose.mockResolvedValue({ description: second }); expect((await loadWorkspaceSymbolCatalog()).elfPath).toBe(second);
    expect(state.choose).toHaveBeenCalledOnce();
  });
  it('allows choosing an ELF when no configured build exists', async () => {
    const elf = file('manual.axf'); state.open.mockResolvedValue([{ fsPath: elf }]);
    expect((await loadWorkspaceSymbolCatalog()).elfPath).toBe(elf);
  });
  it('reports parser failure and retries it rather than caching a failed result', async () => {
    state.defaultProgram = file('bad.elf'); state.symbols.mockResolvedValueOnce([]);
    await expect(loadWorkspaceSymbolCatalog()).rejects.toThrow('无法解析');
    expect((await loadWorkspaceSymbolCatalog()).roots).toHaveLength(1);
    expect(state.symbols).toHaveBeenCalledTimes(2);
  });
});
