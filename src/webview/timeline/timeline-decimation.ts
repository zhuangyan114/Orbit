import type { DataPoint } from '../../ozone-backend/types';

function firstPointAtOrAfter(points: readonly DataPoint[], timestamp: number): number {
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (points[middle].timestamp < timestamp) low = middle + 1;
    else high = middle;
  }
  return low;
}

function firstPointAfter(points: readonly DataPoint[], timestamp: number): number {
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (points[middle].timestamp <= timestamp) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Reduces a raw host range to time-ordered per-bucket extrema for display. */
export function decimateTimelineRange(
  points: readonly DataPoint[],
  start: number,
  end: number,
  targetBuckets: number,
): DataPoint[] {
  if (points.length === 0
    || !Number.isFinite(start)
    || !Number.isFinite(end)
    || end < start
    || !Number.isFinite(targetBuckets)
    || targetBuckets < 1) {
    return [];
  }

  const firstVisible = firstPointAtOrAfter(points, start);
  if (firstVisible >= points.length || points[firstVisible].timestamp > end) return [];
  const afterLast = firstPointAfter(points, end);
  const firstIncluded = Math.max(0, firstVisible - 1);
  const bucketCount = Math.max(1, Math.floor(targetBuckets));
  if (afterLast - firstIncluded <= bucketCount * 2 + 2) {
    return points.slice(firstIncluded, afterLast);
  }

  const result: DataPoint[] = [];
  let lastEmittedIndex = -1;
  const emitIndex = (index: number) => {
    if (index === lastEmittedIndex) return;
    result.push(points[index]);
    lastEmittedIndex = index;
  };

  if (firstIncluded < firstVisible) emitIndex(firstIncluded);

  const span = end - start;
  let currentBucket = -1;
  let minIndex = -1;
  let maxIndex = -1;
  let mandatoryIndex = -1;

  const flushBucket = () => {
    const indices = [mandatoryIndex, minIndex, maxIndex]
      .filter(index => index >= 0)
      .sort((left, right) => left - right);
    let previous = -1;
    for (const index of indices) {
      if (index === previous) continue;
      emitIndex(index);
      previous = index;
    }
    minIndex = -1;
    maxIndex = -1;
    mandatoryIndex = -1;
  };

  for (let index = firstVisible; index < afterLast; index++) {
    const point = points[index];
    const bucket = span === 0
      ? 0
      : Math.min(bucketCount - 1, Math.floor(((point.timestamp - start) / span) * bucketCount));
    if (currentBucket !== -1 && (bucket !== currentBucket || point.startsNewSegment)) flushBucket();
    if (bucket !== currentBucket || point.startsNewSegment) currentBucket = bucket;
    if (index === firstVisible || point.startsNewSegment) mandatoryIndex = index;
    if (minIndex < 0 || point.value < points[minIndex].value) minIndex = index;
    if (maxIndex < 0 || point.value > points[maxIndex].value) maxIndex = index;
  }
  flushBucket();
  emitIndex(afterLast - 1);
  return result;
}
