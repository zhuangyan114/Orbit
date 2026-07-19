export const TIMELINE_HISTORY_DURATION_MS = 10 * 60 * 1000;

const HISTORY_TRIM_HYSTERESIS_MS = 30 * 1000;

export function trimTimelineHistory<T extends { timestamp: number }>(
  points: T[],
  historyDurationMs = TIMELINE_HISTORY_DURATION_MS,
) {
  if (points.length < 2) return;
  const cutoff = points[points.length - 1].timestamp - historyDurationMs;
  if (points[0].timestamp >= cutoff - HISTORY_TRIM_HYSTERESIS_MS) return;

  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (points[middle].timestamp < cutoff) low = middle + 1;
    else high = middle;
  }

  // Keep one predecessor so the trace remains connected at the window edge.
  const removeCount = Math.max(0, low - 1);
  if (removeCount > 0) points.splice(0, removeCount);
}
