export interface TimelineDataPoint {
  timestamp: number;
  value: number;
  display: string;
  startsNewSegment?: boolean;
}

export interface TimelineSampleSnapshot {
  expression: string;
  color: string;
  currentValue: string;
  data: TimelineDataPoint[];
}

type FrameScheduler = (callback: () => void) => number;
type FrameCanceller = (handle: number) => void;

function appendItems<T>(target: T[], source: readonly T[]) {
  for (const item of source) target.push(item);
}

function mergePointsInPlace(target: TimelineDataPoint[], source: readonly TimelineDataPoint[]) {
  if (source.length === 0) return;
  if (target.length === 0 || target[target.length - 1].timestamp < source[0].timestamp) {
    appendItems(target, source);
    return;
  }

  const merged: TimelineDataPoint[] = [];
  let targetIndex = 0;
  let sourceIndex = 0;
  while (targetIndex < target.length || sourceIndex < source.length) {
    const targetPoint = target[targetIndex];
    const sourcePoint = source[sourceIndex];
    if (sourcePoint === undefined || (targetPoint !== undefined && targetPoint.timestamp < sourcePoint.timestamp)) {
      merged.push(targetPoint);
      targetIndex++;
    } else if (targetPoint === undefined || sourcePoint.timestamp < targetPoint.timestamp) {
      merged.push(sourcePoint);
      sourceIndex++;
    } else {
      merged.push(sourcePoint);
      targetIndex++;
      sourceIndex++;
    }
  }
  target.length = 0;
  appendItems(target, merged);
}

/** Coalesces host messages so React and canvas update at most once per frame. */
export class TimelineFrameBatcher {
  private pending = new Map<string, TimelineSampleSnapshot>();
  private frameHandle: number | null = null;

  constructor(
    private scheduleFrame: FrameScheduler,
    private cancelFrame: FrameCanceller,
    private onFlush: (snapshots: TimelineSampleSnapshot[]) => void,
  ) {}

  enqueue(snapshots: TimelineSampleSnapshot[]) {
    for (const snapshot of snapshots) {
      if (!snapshot.expression || snapshot.data.length === 0) continue;
      let pending = this.pending.get(snapshot.expression);
      if (!pending) {
        pending = {
          expression: snapshot.expression,
          color: snapshot.color,
          currentValue: snapshot.currentValue,
          data: [],
        };
        this.pending.set(snapshot.expression, pending);
      }
      pending.color = snapshot.color;
      const previousLatestTimestamp = pending.data.at(-1)?.timestamp ?? Number.NEGATIVE_INFINITY;
      mergePointsInPlace(pending.data, snapshot.data);
      if (snapshot.data.at(-1)!.timestamp >= previousLatestTimestamp) {
        pending.currentValue = snapshot.currentValue;
      }
    }

    if (this.pending.size > 0 && this.frameHandle === null) {
      this.frameHandle = this.scheduleFrame(() => {
        this.frameHandle = null;
        const flushed = [...this.pending.values()];
        this.pending.clear();
        this.onFlush(flushed);
      });
    }
  }

  dispose() {
    if (this.frameHandle !== null) this.cancelFrame(this.frameHandle);
    this.frameHandle = null;
    this.pending.clear();
  }
}

export function appendTimelineSamples(
  dataByExpression: Map<string, TimelineDataPoint[]>,
  snapshots: TimelineSampleSnapshot[],
): number | undefined {
  let latestTimestamp: number | undefined;
  for (const snapshot of snapshots) {
    if (snapshot.data.length === 0) continue;
    const existing = dataByExpression.get(snapshot.expression) || [];
    mergePointsInPlace(existing, snapshot.data);
    trimTimelineHistory(existing);
    dataByExpression.set(snapshot.expression, existing);
    const timestamp = snapshot.data[snapshot.data.length - 1].timestamp;
    if (latestTimestamp === undefined || timestamp > latestTimestamp) latestTimestamp = timestamp;
  }
  return latestTimestamp;
}
import { trimTimelineHistory } from '../../utils/timeline-history';
