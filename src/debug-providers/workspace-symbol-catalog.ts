import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { findElfFiles } from '../ozone-backend/flasher';
import { buildSymbolCatalog, parseDwarfTypeInfo, readElfSymbols } from '../ozone-backend/jlink-symbols';
import { isOrbitDebugSessionType } from '../utils/debug-session-type';
import type { SymbolCatalog } from '../symbols/symbol-catalog';

const cache = new Map<string, { stamp: string; catalog: Promise<SymbolCatalog> }>();
const manualFiles = new Map<string, string>();

export function resolveSymbolProgram(program: unknown, folder: string | undefined, folders: readonly { name: string; uri: { fsPath: string } }[]): string | undefined {
  if (typeof program !== 'string' || !program.trim()) return;
  let value = program.trim().replace(/\$\{workspaceFolder(?::([^}]+))?\}/g, (_match, name: string | undefined) =>
    (name ? folders.find(candidate => candidate.name === name)?.uri.fsPath : folder) || '${unresolved}');
  value = value.replace(/\$\{env:([^}]+)\}/g, (_match, name: string) => process.env[name] || '${unresolved}');
  // Do not execute ${command:...} or launch preLaunchTask merely to browse symbols.
  if (/\$\{[^}]+\}/.test(value)) return;
  if (!path.isAbsolute(value)) { if (!folder) return; value = path.join(folder, value); }
  return path.normalize(value);
}

async function selectWorkspaceElf(): Promise<string> {
  const folders = vscode.workspace.workspaceFolders || [];
  const workspaceKey = folders.map(folder => folder.uri.fsPath).join('|');
  const launchFiles = new Set<string>();
  const configuredFiles = new Set<string>();
  const add = (set: Set<string>, input: unknown, folder: string | undefined) => {
    const resolved = resolveSymbolProgram(input, folder, folders);
    if (resolved && fs.existsSync(resolved) && fs.statSync(resolved).isFile()) set.add(resolved);
  };
  for (const folder of folders.length ? folders : [undefined]) {
    const configs = vscode.workspace.getConfiguration('launch', folder?.uri).get<any[]>('configurations', []);
    for (const config of Array.isArray(configs) ? configs : []) {
      if (config && isOrbitDebugSessionType(config.type)) add(launchFiles, config.program, folder?.uri.fsPath);
    }
    add(configuredFiles, vscode.workspace.getConfiguration('orbit', folder?.uri).get('defaultProgram'), folder?.uri.fsPath);
  }
  const candidates = launchFiles.size ? launchFiles : configuredFiles;
  if (!candidates.size) for (const folder of folders) for (const candidate of findElfFiles(folder.uri.fsPath)) candidates.add(candidate.path);
  if (candidates.size === 1) return [...candidates][0];
  if (candidates.size > 1) {
    const chosen = await vscode.window.showQuickPick([...candidates].map(elfPath => ({ label: path.basename(elfPath), description: elfPath })), {
      title: '选择用于变量搜索的 ELF', placeHolder: '只读取符号，不连接或烧录目标',
    });
    if (chosen?.description) return chosen.description;
    throw new Error('已取消选择 ELF');
  }
  const previousManual = manualFiles.get(workspaceKey);
  if (previousManual && fs.existsSync(previousManual)) return previousManual;
  const files = await vscode.window.showOpenDialog({ title: '选择用于变量搜索的 ELF', canSelectMany: false,
    filters: { 'ELF / AXF': ['elf', 'axf'] }, openLabel: '解析变量' });
  if (!files?.[0]) throw new Error('没有可用的 ELF，请先编译工程或选择 ELF 文件');
  manualFiles.set(workspaceKey, files[0].fsPath);
  return files[0].fsPath;
}

/** Offline symbol loading deliberately never constructs an OzoneBackend/target owner. */
export async function loadWorkspaceSymbolCatalog(): Promise<SymbolCatalog> {
  const elfPath = await selectWorkspaceElf();
  const stat = fs.statSync(elfPath);
  const stamp = `${stat.mtimeMs}:${stat.size}`;
  const previous = cache.get(elfPath);
  if (previous?.stamp === stamp) return previous.catalog;
  const catalog = (async () => {
    const [symbols, dwarf] = await Promise.all([readElfSymbols(elfPath), parseDwarfTypeInfo(elfPath)]);
    if (!symbols.length) throw new Error(`无法解析 ELF 符号：${elfPath}。请确认文件有效且已安装 ARM GCC 工具链。`);
    const after = fs.statSync(elfPath);
    if (`${after.mtimeMs}:${after.size}` !== stamp) throw new Error('解析期间 ELF 已重新编译，请重新加载变量');
    return { ...buildSymbolCatalog(symbols, dwarf), elfPath };
  })();
  cache.set(elfPath, { stamp, catalog });
  while (cache.size > 2) cache.delete(cache.keys().next().value!);
  try { return await catalog; }
  catch (error) { if (cache.get(elfPath)?.catalog === catalog) cache.delete(elfPath); throw error; }
}
