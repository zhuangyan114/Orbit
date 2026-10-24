import { stripHanCharacters } from '../utils/watch-expression-validation';

export const WATCH_GROUPS_STATE_KEY = 'ozoneWatchGroups';
export interface WatchGroup { id: string; name: string; expressions: string[]; expandedExpressions: string[]; }
export interface WatchGroupsState { version: 1; activeId: string; groups: WatchGroup[]; }

export function normalizeWatchExpressions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === 'string')
    .map(item => stripHanCharacters(item).trim()).filter(Boolean))];
}

/** Workspace-local Watch configurations; only active.expressions are sent to the target. */
export class WatchGroups {
  private state: WatchGroupsState;
  constructor(saved: unknown, legacyExpressions: unknown = [], legacyExpanded: unknown = []) {
    const candidate = saved as Partial<WatchGroupsState> | null;
    const groups: WatchGroup[] = [];
    const ids = new Set<string>();
    if (candidate?.version === 1 && Array.isArray(candidate.groups)) {
      for (const group of candidate.groups) {
        if (!group || typeof group.id !== 'string' || !/^watch[1-9]\d*$/.test(group.id)
          || !Number.isSafeInteger(Number(group.id.slice(5))) || ids.has(group.id)) continue;
        ids.add(group.id);
        groups.push({ id: group.id, name: typeof group.name === 'string' && group.name.trim() ? group.name.trim() : group.id,
          expressions: normalizeWatchExpressions(group.expressions),
          expandedExpressions: normalizeWatchExpressions(group.expandedExpressions) });
      }
    }
    if (groups.length === 0) groups.push({ id: 'watch1', name: 'watch1', expressions: normalizeWatchExpressions(legacyExpressions),
      expandedExpressions: normalizeWatchExpressions(legacyExpanded) });
    this.state = { version: 1, groups, activeId: groups.some(group => group.id === candidate?.activeId)
      ? candidate!.activeId! : groups[0].id };
  }
  get active(): WatchGroup { return this.state.groups.find(group => group.id === this.state.activeId)!; }
  snapshot(): WatchGroupsState { return structuredClone(this.state); }
  select(id: string): boolean {
    if (id === this.state.activeId || !this.state.groups.some(group => group.id === id)) return false;
    this.state.activeId = id;
    return true;
  }
  add(): void {
    const ids = new Set(this.state.groups.map(group => group.id));
    let index = 1;
    while (ids.has('watch' + index)) index++;
    const id = 'watch' + index;
    this.state.groups.push({ id, name: id, expressions: [], expandedExpressions: [] });
    this.state.activeId = id;
  }
  rename(id: string, name: unknown): boolean {
    const group = this.state.groups.find(item => item.id === id);
    if (!group || typeof name !== 'string' || !name.trim() || group.name === name.trim()) return false;
    group.name = name.trim();
    return true;
  }
  remove(id: string): boolean {
    const index = this.state.groups.findIndex(group => group.id === id);
    if (index < 0 || this.state.groups.length === 1) return false;
    this.state.groups.splice(index, 1);
    if (this.state.activeId === id) this.state.activeId = this.state.groups[Math.max(0, index - 1)].id;
    return true;
  }
}
