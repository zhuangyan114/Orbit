import * as vscode from 'vscode';
import { isOrbitDebugSessionType } from '../utils/debug-session-type';
import type { SymbolCatalog } from '../symbols/symbol-catalog';
import { loadWorkspaceSymbolCatalog } from './workspace-symbol-catalog';

export async function loadActiveSymbolCatalog(canUse: (session: vscode.DebugSession) => boolean = () => true): Promise<SymbolCatalog> {
  const session = vscode.debug.activeDebugSession;
  if (!session || !isOrbitDebugSessionType(session.type)) {
    const catalog = await loadWorkspaceSymbolCatalog();
    if (vscode.debug.activeDebugSession !== session) throw new Error('调试会话已切换，请重新打开变量选择');
    return catalog;
  }
  if (!canUse(session)) {
    throw new Error('请先启动 Orbit 调试并加载 ELF 符号');
  }
  const result = await session.customRequest('getSymbolCatalog');
  if (vscode.debug.activeDebugSession !== session || !canUse(session)) throw new Error('调试会话已切换，请重新打开变量选择');
  if (!result?.ok) throw new Error(result?.error || '无法加载 ELF 符号');
  if (!Array.isArray(result.data?.roots) || !result.data?.types || typeof result.data.types !== 'object') {
    throw new Error('变量符号响应无效');
  }
  return result.data;
}
