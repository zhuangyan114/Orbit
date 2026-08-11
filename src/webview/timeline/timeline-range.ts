export interface TimelineRange {
  start: number;
  end: number;
}

export type TimelineHistoryBounds = TimelineRange;

export interface TimelineRangeRequest extends TimelineRange {
  requestId: number;
}

export interface TimelineRangeLoadRequest extends TimelineRangeRequest {
  generation: number;
  resolutionKey: number;
  targetBuckets: number;
}

interface PendingTimelineRange {
  range: TimelineRange;
  generation: number;
  resolutionKey: number | null;
}

const PREFETCH_RATIO = 2;
const REFRESH_THRESHOLD_RATIO = 0.5;
const MAX_TARGET_BUCKETS = 100_000;

export function parseTimelineRangeLoadRequest(value: unknown): TimelineRangeLoadRequest | null {
  if (!value || typeof value !== 'object') return null;
  const request = value as Partial<TimelineRangeLoadRequest>;
  if (!Number.isSafeInteger(request.requestId)
    || !Number.isSafeInteger(request.generation)
    || (request.generation as number) < 0
    || typeof request.start !== 'number'
    || !Number.isFinite(request.start)
    || typeof request.end !== 'number'
    || !Number.isFinite(request.end)
    || request.end < request.start
    || typeof request.resolutionKey !== 'number'
    || !Number.isFinite(request.resolutionKey)
    || request.resolutionKey <= 0
    || !Number.isSafeInteger(request.targetBuckets)
    || (request.targetBuckets as number) < 1
    || (request.targetBuckets as number) > MAX_TARGET_BUCKETS) {
    return null;
  }
  return request as TimelineRangeLoadRequest;
}

export function quantizeTimelineResolution(viewportWidthMs: number, plotWidthPx: number): number | null {
  if (!Number.isFinite(viewportWidthMs)
    || !Number.isFinite(plotWidthPx)
    || viewportWidthMs <= 0
    || plotWidthPx <= 0) {
    return null;
  }
  const millisecondsPerPixel = viewportWidthMs / plotWidthPx;
  return 2 ** Math.round(Math.log2(millisecondsPerPixel));
}

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

function calculateRangeWithMargin(
  viewStart: number,
  viewEnd: number,
  historyBounds: TimelineHistoryBounds | null,
  marginRatio: number,
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
  if (viewEnd < historyBounds.start || viewStart > historyBounds.end) return null;

  const width = viewEnd - viewStart;
  const start = Math.max(historyBounds.start, viewStart - width * marginRatio);
  const end = Math.min(historyBounds.end, viewEnd + width * marginRatio);
  return start <= end ? { start, end } : null;
}

export function calculateBufferedRange(
  viewStart: number,
  viewEnd: number,
  historyBounds: TimelineHistoryBounds | null,
): TimelineRange | null {
  return calculateRangeWithMargin(viewStart, viewEnd, historyBounds, PREFETCH_RATIO);
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
  private pending = new Map<number, PendingTimelineRange>();
  private nextRequestId = 1;
  private activeResolutionKey: number | null = null;
  private activeGeneration = 0;

  get generation(): number {
    return this.activeGeneration;
  }

  get resolutionKey(): number | null {
    return this.activeResolutionKey;
  }

  setResolution(resolutionKey: number): boolean {
    if (!Number.isFinite(resolutionKey) || resolutionKey <= 0 || resolutionKey === this.activeResolutionKey) {
      return false;
    }
    this.activeResolutionKey = resolutionKey;
    this.activeGeneration++;
    this.clearCoverage();
    return true;
  }

  setHistoryBounds(bounds: TimelineHistoryBounds | null) {
    this.historyBounds = bounds;
    if (!bounds) {
      this.clearCoverage();
      return;
    }
    this.loaded = this.loaded
      .map(range => intersectTimelineRange(range, bounds))
      .filter((range): range is TimelineRange => range !== null);
    for (const [requestId, pending] of this.pending) {
      const clipped = intersectTimelineRange(pending.range, bounds);
      if (clipped) this.pending.set(requestId, { ...pending, range: clipped });
      else this.pending.delete(requestId);
    }
  }

  requestViewport(viewStart: number, viewEnd: number): TimelineRangeRequest[] {
    const target = calculateBufferedRange(viewStart, viewEnd, this.historyBounds);
    if (!target) return [];
    const coverage = [...this.loaded, ...[...this.pending.values()].map(pending => pending.range)];
    const refreshRange = calculateRangeWithMargin(
      viewStart,
      viewEnd,
      this.historyBounds,
      REFRESH_THRESHOLD_RATIO,
    );
    if (refreshRange && uncoveredRanges(refreshRange, coverage).length === 0) return [];
    return uncoveredRanges(target, coverage).map(range => {
      const request = { requestId: this.nextRequestId++, ...range };
      this.pending.set(request.requestId, {
        range,
        generation: this.activeGeneration,
        resolutionKey: this.activeResolutionKey,
      });
      return request;
    });
  }

  completeRequest(
    requestId: number,
    actualRange: TimelineRange | null,
    generation?: number,
    resolutionKey?: number | null,
  ): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    if ((generation ?? pending.generation) !== pending.generation
      || (resolutionKey ?? pending.resolutionKey) !== pending.resolutionKey) {
      return false;
    }
    this.pending.delete(requestId);
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
