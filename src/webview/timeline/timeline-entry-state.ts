export interface TimelineEntryState {
  expression: string;
  enabled: boolean;
  color: string;
  yPerDiv: number;
  yAutoScale: boolean;
  yCenter: number;
}

export interface TimelineEntryUpdate {
  expression: string;
  enabled?: boolean;
  color: string;
  yPerDiv?: number;
  yAutoScale?: boolean;
  yCenter?: number;
}

export function createTimelineEntry(update: TimelineEntryUpdate): TimelineEntryState {
  const yAutoScale = update.yAutoScale ?? true;
  return {
    expression: update.expression,
    enabled: update.enabled ?? true,
    color: update.color,
    yPerDiv: update.yPerDiv ?? 1,
    yAutoScale,
    yCenter: yAutoScale ? 0 : (update.yCenter ?? 0),
  };
}

export function mergeTimelineEntryRefresh(
  current: TimelineEntryState[],
  updates: TimelineEntryUpdate[],
): TimelineEntryState[] {
  const currentByExpression = new Map(current.map(entry => [entry.expression, entry]));
  return updates.map(update => {
    const refreshed = createTimelineEntry(update);
    const existing = currentByExpression.get(update.expression);
    if (!existing) return refreshed;
    return {
      ...refreshed,
      enabled: existing.enabled,
      yPerDiv: existing.yPerDiv,
      yAutoScale: existing.yAutoScale,
      yCenter: existing.yAutoScale ? 0 : existing.yCenter,
    };
  });
}
