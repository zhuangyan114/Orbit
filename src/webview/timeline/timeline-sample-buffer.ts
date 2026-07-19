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
      pending.currentValue = snapshot.currentValue;
      pending.data.push(...snapshot.data);
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
    existing.push(...snapshot.data);
    trimTimelineHistory(existing);
    dataByExpression.set(snapshot.expression, existing);
    const timestamp = snapshot.data[snapshot.data.length - 1].timestamp;
    if (latestTimestamp === undefined || timestamp > latestTimestamp) latestTimestamp = timestamp;
  }
  return latestTimestamp;
}
import { trimTimelineHistory } from '../../utils/timeline-history';
