import { describe, expect, it } from 'vitest';
import { createTimelineEntry, mergeTimelineEntryRefresh } from './timeline-entry-state';

describe('Timeline entry refresh state', () => {
  it('retains dragged order while refreshing, removing, and adding entries', () => {
    const current = ['third', 'first', 'removed', 'second'].map(expression => createTimelineEntry({ expression, color: '#123456' }));
    const updates = ['first', 'second', 'third', 'added'].map(expression => ({ expression, color: '#654321' }));
    const refreshed = mergeTimelineEntryRefresh(current, updates);
    expect(refreshed.map(entry => entry.expression)).toEqual(['third', 'first', 'second', 'added']);
    expect(refreshed.every(entry => entry.color === '#654321')).toBe(true);
  });

  it('uses provider state for a newly added entry', () => {
    expect(createTimelineEntry({
      expression: 'added',
      enabled: false,
      color: '#123456',
      yPerDiv: 2,
      yAutoScale: false,
      yCenter: 4,
    })).toEqual({
      expression: 'added',
      enabled: false,
      color: '#123456',
      yPerDiv: 2,
      yAutoScale: false,
      yCenter: 4,
    });
  });

  it('preserves checkbox and axis state while applying list and color refreshes', () => {
    const current = [
      {
        expression: 'kept',
        enabled: false,
        color: '#old',
        yPerDiv: 5,
        yAutoScale: false,
        yCenter: 3,
      },
      createTimelineEntry({ expression: 'removed', color: '#removed' }),
    ];

    expect(mergeTimelineEntryRefresh(current, [
      { expression: 'kept', enabled: true, color: '#new' },
      { expression: 'added', enabled: true, color: '#added' },
    ])).toEqual([
      {
        expression: 'kept',
        enabled: false,
        color: '#new',
        yPerDiv: 5,
        yAutoScale: false,
        yCenter: 3,
      },
      {
        expression: 'added',
        enabled: true,
        color: '#added',
        yPerDiv: 1,
        yAutoScale: true,
        yCenter: 0,
      },
    ]);
  });
});
