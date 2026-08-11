export interface TimelineRange {
  start: number;
  end: number;
}

export type TimelineHistoryBounds = TimelineRange;

export interface TimelineRangeRequest extends TimelineRange {
  requestId: number;
}

const PREFETCH_RATIO = 0.5;

export function clampTimelineViewportEnd(
  requestedEnd: number,
  viewportWidth: number,
  historyBounds: TimelineHistoryBounds | null,
): number {
  if (!historyBounds || viewportWidth < 0 || !Number.isFinite(requestedEnd)) return requestedEnd;
  const earliestEnd = Math.min(historyBounds.end, historyBounds.start + viewportWidth);
  return Math.min(historyBounds.end, Math.max(earliestEnd, requestedEnd));
}

export function intersectTimelineRange(
  requested: TimelineRange,
  historyBounds: TimelineHistoryBounds | null,
): TimelineRange | null {
  if (!historyBounds
    || !Number.isFinite(requested.start)
    || !Number.isFinite(requested.end)
    || requested.end < requested.start
    || historyBounds.end < historyBounds.start) {
    return null;
  }
  const start = Math.max(requested.start, historyBounds.start);
  const end = Math.min(requested.end, historyBounds.end);
  return start <= end ? { start, end } : null;
}

export function calculateBufferedRange(
  viewStart: number,
  viewEnd: number,
  historyBounds: TimelineHistoryBounds | null,
): TimelineRange | null {
  if (!historyBounds
    || !Number.isFinite(viewStart)
    || !Number.isFinite(viewEnd)
    || !Number.isFinite(historyBounds.start)
    || !Number.isFinite(historyBounds.end)
    || viewEnd < viewStart
    || historyBounds.end < historyBounds.start) {
    return null;
  }

  const width = viewEnd - viewStart;
  const start = Math.max(historyBounds.start, viewStart - width * PREFETCH_RATIO);
  const end = Math.min(historyBounds.end, viewEnd + width * PREFETCH_RATIO);
  return start <= end ? { start, end } : null;
}

function firstPointAtOrAfter<T extends { timestamp: number }>(points: readonly T[], timestamp: number): number {
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (points[middle].timestamp < timestamp) low = middle + 1;
    else high = middle;
  }
  return low;
}

function firstPointAfter<T extends { timestamp: number }>(points: readonly T[], timestamp: number): number {
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (points[middle].timestamp <= timestamp) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function sliceTimelineRange<T extends { timestamp: number }>(
  points: readonly T[],
  start: number,
  end: number,
): T[] {
  if (points.length === 0 || !Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
  const first = firstPointAtOrAfter(points, start);
  if (first >= points.length || points[first].timestamp > end) return [];
  const afterLast = firstPointAfter(points, end);
  return points.slice(Math.max(0, first - 1), afterLast);
}

export function getTimelineHistoryBounds<T extends { timestamp: number }>(
  pointSets: Iterable<readonly T[]>,
): TimelineHistoryBounds | null {
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const points of pointSets) {
    if (points.length === 0) continue;
    start = Math.min(start, points[0].timestamp);
    end = Math.max(end, points[points.length - 1].timestamp);
  }
  return Number.isFinite(start) && Number.isFinite(end) ? { start, end } : null;
}

function mergeRanges(ranges: TimelineRange[]): TimelineRange[] {
  if (ranges.length < 2) return ranges;
  const sorted = [...ranges].sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: TimelineRange[] = [{ ...sorted[0] }];
  for (let index = 1; index < sorted.length; index++) {
    const current = sorted[index];
    const previous = merged[merged.length - 1];
    if (current.start <= previous.end) previous.end = Math.max(previous.end, current.end);
    else merged.push({ ...current });
  }
  return merged;
}

function uncoveredRanges(target: TimelineRange, coverage: TimelineRange[]): TimelineRange[] {
  const gaps: TimelineRange[] = [];
  let cursor = target.start;
  for (const covered of mergeRanges(coverage)) {
    if (covered.end < cursor) continue;
    if (covered.start > target.end) break;
    if (covered.start > cursor) gaps.push({ start: cursor, end: Math.min(covered.start, target.end) });
    cursor = Math.max(cursor, covered.end);
    if (cursor >= target.end) break;
  }
  if (cursor < target.end) gaps.push({ start: cursor, end: target.end });
  return gaps;
}

export class TimelineRangeController {
  private historyBounds: TimelineHistoryBounds | null = null;
  private loaded: TimelineRange[] = [];
  private pending = new Map<number, TimelineRange>();
  private nextRequestId = 1;

  setHistoryBounds(bounds: TimelineHistoryBounds | null) {
    this.historyBounds = bounds;
    if (!bounds) {
      this.clearCoverage();
      return;
    }
    this.loaded = this.loaded
      .map(range => intersectTimelineRange(range, bounds))
      .filter((range): range is TimelineRange => range !== null);
    for (const [requestId, range] of this.pending) {
      const clipped = intersectTimelineRange(range, bounds);
      if (clipped) this.pending.set(requestId, clipped);
      else this.pending.delete(requestId);
    }
  }

  requestViewport(viewStart: number, viewEnd: number): TimelineRangeRequest[] {
    const target = calculateBufferedRange(viewStart, viewEnd, this.historyBounds);
    if (!target) return [];
    const coverage = [...this.loaded, ...this.pending.values()];
    return uncoveredRanges(target, coverage).map(range => {
      const request = { requestId: this.nextRequestId++, ...range };
      this.pending.set(request.requestId, range);
      return request;
    });
  }

  completeRequest(requestId: number, actualRange: TimelineRange | null): boolean {
    if (!this.pending.delete(requestId)) return false;
    if (actualRange) this.markLoadedRange(actualRange);
    return true;
  }

  markLoadedRange(range: TimelineRange) {
    const clipped = intersectTimelineRange(range, this.historyBounds);
    if (clipped) this.loaded = mergeRanges([...this.loaded, clipped]);
  }

  clearCoverage() {
    this.loaded = [];
    this.pending.clear();
  }

  cancelPendingRequests() {
    this.pending.clear();
  }
}
