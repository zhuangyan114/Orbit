import { describe, expect, it } from 'vitest';
import { WatchGroups } from './watch-groups';

describe('Watch groups', () => {
  it('migrates the old list and expansions into watch1 and normalizes expressions', () => {
    const groups = new WatchGroups(undefined, [' p6啊 ', '中文', 'a[0]->x', 'p6'], [' root中文.child ', '中文']);
    expect(groups.active).toEqual({ id: 'watch1', name: 'watch1', expressions: ['p6', 'a[0]->x'], expandedExpressions: ['root.child'] });
  });
  it('restores the selected group, including an intentionally empty group', () => {
    const groups = new WatchGroups({ version: 1, activeId: 'watch2', nextIndex: 7, groups: [
      { id: 'watch1', expressions: ['a'], expandedExpressions: ['a.child'] },
      { id: 'watch2', expressions: [], expandedExpressions: [] },
    ] }, ['obsolete']);
    expect(groups.active.id).toBe('watch2');
    expect(groups.active.expressions).toEqual([]);
    groups.add();
    expect(groups.active.id).toBe('watch3');
  });
  it('reuses watch2 after deletion as an empty group and preserves watch1', () => {
    const groups = new WatchGroups(undefined, ['a']);
    groups.add(); groups.active.expressions = ['b']; groups.active.expandedExpressions = ['b.child'];
    groups.select('watch1');
    expect(groups.active.expressions).toEqual(['a']);
    groups.remove('watch2'); groups.add();
    expect(groups.active).toEqual({ id: 'watch2', name: 'watch2', expressions: [], expandedExpressions: [] });
    groups.select('watch1');
    expect(groups.active.expressions).toEqual(['a']);
  });
  it('selects the previous adjacent group on deletion and keeps the final group', () => {
    const groups = new WatchGroups(undefined);
    groups.add(); groups.add();
    expect(groups.remove('watch3')).toBe(true);
    expect(groups.active.id).toBe('watch2');
    groups.select('watch1'); groups.remove('watch1');
    expect(groups.active.id).toBe('watch2');
    expect(groups.remove('watch2')).toBe(false);
    expect(groups.select('missing')).toBe(false);
    expect(groups.snapshot().groups).toHaveLength(1);
  });
  it('recovers from malformed saved groups without losing the legacy list', () => {
    const groups = new WatchGroups({ version: 1, groups: [null, { id: 'bad' }, { id: 'watch0' }] }, ['kept']);
    expect(groups.active.expressions).toEqual(['kept']);
  });
  it('drops duplicate ids and ignores the old counter when filling numbering gaps', () => {
    const groups = new WatchGroups({ version: 1, activeId: 'missing', nextIndex: 1, groups: [
      { id: 'watch4', expressions: ['x'] }, { id: 'watch4', expressions: ['wrong'] }, { id: 'watch8' },
    ] });
    expect(groups.active.expressions).toEqual(['x']);
    expect(groups.snapshot().groups).toHaveLength(2);
    groups.add(); expect(groups.active.id).toBe('watch1');
    groups.add(); expect(groups.active.id).toBe('watch2');
  });
  it('fills the smallest internal gap without renumbering existing groups', () => {
    const groups = new WatchGroups(undefined);
    groups.add(); groups.add(); groups.add();
    groups.remove('watch2'); groups.add();
    expect(groups.active.id).toBe('watch2');
    expect(groups.snapshot().groups.map(group => group.id)).toEqual(['watch1', 'watch3', 'watch4', 'watch2']);
    groups.remove('watch1'); groups.remove('watch3');
    const restored = new WatchGroups(groups.snapshot());
    restored.add(); expect(restored.active.id).toBe('watch1');
    restored.add(); expect(restored.active.id).toBe('watch3');
  });
  it('returns a detached persisted snapshot', () => {
    const groups = new WatchGroups(undefined, ['a']);
    groups.snapshot().groups[0].expressions.push('changed');
    expect(groups.active.expressions).toEqual(['a']);
  });
  it('persists Chinese names while preserving group identity, variables and selection', () => {
    const groups = new WatchGroups(undefined, ['a'], ['a.child']);
    expect(groups.rename('watch1', '  底盘控制  ')).toBe(true);
    const restored = new WatchGroups(groups.snapshot());
    expect(restored.active).toEqual({ id: 'watch1', name: '底盘控制', expressions: ['a'], expandedExpressions: ['a.child'] });
    restored.add(); expect(restored.active.name).toBe('watch2');
  });
  it('ignores blank or invalid rename requests and supports renaming inactive groups', () => {
    const groups = new WatchGroups(undefined);
    expect(groups.rename('watch1', '  ')).toBe(false);
    expect(groups.rename('watch1', null)).toBe(false);
    expect(groups.rename('missing', 'name')).toBe(false);
    groups.add();
    expect(groups.rename('watch1', '云台')).toBe(true);
    expect(groups.active.id).toBe('watch2');
    groups.select('watch1'); expect(groups.active.name).toBe('云台');
  });
  it('restores old unnamed groups and reuses a renamed group number after deletion', () => {
    const groups = new WatchGroups({ version: 1, activeId: 'watch2', groups: [
      { id: 'watch1', expressions: ['a'] }, { id: 'watch2', expressions: ['b'] },
    ] });
    expect(groups.active.name).toBe('watch2');
    groups.rename('watch2', '云台'); groups.remove('watch2'); groups.add();
    expect(groups.active).toEqual({ id: 'watch2', name: 'watch2', expressions: [], expandedExpressions: [] });
  });
});
