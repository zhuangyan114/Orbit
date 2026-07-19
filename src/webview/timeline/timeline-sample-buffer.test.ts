import { describe, expect, it } from 'vitest';
import { appendTimelineSamples, TimelineFrameBatcher, type TimelineSampleSnapshot } from './timeline-sample-buffer';

const point = (timestamp: number) => ({ timestamp, value: timestamp, display: String(timestamp) });
const snapshot = (data: ReturnType<typeof point>[]): TimelineSampleSnapshot => ({
  expression: 'counter', color: '#4EC9B0', currentValue: data.at(-1)?.display || '', data,
});

describe('TimelineFrameBatcher', () => {
  it('coalesces multiple host messages into one animation-frame UI update', () => {
    let frame: (() => void) | undefined;
    const flushed: TimelineSampleSnapshot[][] = [];
    const batcher = new TimelineFrameBatcher(
      callback => { frame = callback; return 1; },
      () => {},
      snapshots => flushed.push(snapshots),
    );

    batcher.enqueue([snapshot([point(1)])]);
    batcher.enqueue([snapshot([point(2), point(3)])]);

    expect(flushed).toEqual([]);
    frame?.();
    expect(flushed).toEqual([[snapshot([point(1), point(2), point(3)])]]);
  });

  it('appends in place and retains at least ten minutes of Timeline history', () => {
    const existing = [point(0), point(30_000), point(31_000), point(600_000)];
    const data = new Map([['counter', existing]]);

    const latestTimestamp = appendTimelineSamples(data, [snapshot([point(631_001)])]);

    expect(data.get('counter')).toBe(existing);
    expect(existing).toEqual([point(31_000), point(600_000), point(631_001)]);
    expect(existing.at(-1)!.timestamp - existing[0].timestamp).toBeGreaterThanOrEqual(600_000);
    expect(latestTimestamp).toBe(631_001);
  });
});
