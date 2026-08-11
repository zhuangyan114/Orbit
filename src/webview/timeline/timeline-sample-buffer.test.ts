import { describe, expect, it } from 'vitest';
import { appendTimelineSamples, TimelineFrameBatcher, type TimelineSampleSnapshot } from './timeline-sample-buffer';

const point = (timestamp: number) => ({ timestamp, value: timestamp, display: String(timestamp) });
const snapshot = (data: ReturnType<typeof point>[]): TimelineSampleSnapshot => ({
  expression: 'counter', color: '#4EC9B0', currentValue: data.at(-1)?.display || '', data,
});
const LARGE_HISTORY_SIZE = 250_000;

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

  it('coalesces out-of-order live and range messages without duplicate timestamps', () => {
    let frame: (() => void) | undefined;
    let flushed: TimelineSampleSnapshot[] | undefined;
    const batcher = new TimelineFrameBatcher(
      callback => { frame = callback; return 1; },
      () => {},
      snapshots => { flushed = snapshots; },
    );

    batcher.enqueue([snapshot([point(30), point(40)])]);
    batcher.enqueue([snapshot([point(10), point(20), point(30)])]);
    frame?.();

    expect(flushed).toEqual([snapshot([point(10), point(20), point(30), point(40)])]);
  });

  it('replays a large retained history without exceeding the JavaScript argument limit', () => {
    let frame: (() => void) | undefined;
    let flushed: TimelineSampleSnapshot[] | undefined;
    const history = Array.from({ length: LARGE_HISTORY_SIZE }, (_, timestamp) => point(timestamp));
    const batcher = new TimelineFrameBatcher(
      callback => { frame = callback; return 1; },
      () => {},
      snapshots => { flushed = snapshots; },
    );

    batcher.enqueue([snapshot(history)]);
    frame?.();

    expect(flushed?.[0].data).toHaveLength(LARGE_HISTORY_SIZE);
    expect(flushed?.[0].data[0]).toEqual(point(0));
    expect(flushed?.[0].data.at(-1)).toEqual(point(LARGE_HISTORY_SIZE - 1));
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

  it('appends a large retained history in place without exceeding the JavaScript argument limit', () => {
    const existing: ReturnType<typeof point>[] = [];
    const data = new Map([['counter', existing]]);
    const history = Array.from({ length: LARGE_HISTORY_SIZE }, (_, timestamp) => point(timestamp));

    const latestTimestamp = appendTimelineSamples(data, [snapshot(history)]);

    expect(data.get('counter')).toBe(existing);
    expect(existing).toHaveLength(LARGE_HISTORY_SIZE);
    expect(existing[0]).toEqual(point(0));
    expect(existing.at(-1)).toEqual(point(LARGE_HISTORY_SIZE - 1));
    expect(latestTimestamp).toBe(LARGE_HISTORY_SIZE - 1);
  });

  it('merges overlapping range and live samples in timestamp order without duplicates', () => {
    const existing = [point(20), point(30), point(40)];
    const data = new Map([['counter', existing]]);

    const latestTimestamp = appendTimelineSamples(data, [snapshot([
      point(0), point(10), point(20), point(30),
    ])]);

    expect(data.get('counter')).toBe(existing);
    expect(existing).toEqual([point(0), point(10), point(20), point(30), point(40)]);
    expect(latestTimestamp).toBe(30);
  });
});
