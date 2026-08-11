import { describe, expect, it } from 'vitest';
import type { DataPoint } from '../../ozone-backend/types';
import { decimateTimelineRange } from './timeline-decimation';

const point = (timestamp: number, value = timestamp, startsNewSegment = false): DataPoint => ({
  timestamp,
  value,
  display: String(value),
  ...(startsNewSegment ? { startsNewSegment: true } : {}),
});

describe('decimateTimelineRange', () => {
  it('returns an empty result for invalid or disjoint ranges', () => {
    const points = [point(10), point(20)];

    expect(decimateTimelineRange(points, 30, 40, 10)).toEqual([]);
    expect(decimateTimelineRange(points, 20, 10, 10)).toEqual([]);
    expect(decimateTimelineRange(points, 10, 20, 0)).toEqual([]);
  });

  it('returns a small range unchanged with one predecessor', () => {
    const points = [point(0), point(10), point(20), point(30), point(40)];

    expect(decimateTimelineRange(points, 15, 35, 10)).toEqual([
      point(10),
      point(20),
      point(30),
    ]);
  });

  it('keeps bucket extrema in timestamp order and preserves the visible tail', () => {
    const points = [
      point(0, 0),
      point(1, 9),
      point(2, -5),
      point(3, 3),
      point(4, 4),
      point(5, -8),
      point(6, 12),
      point(7, 7),
      point(8, 8),
    ];

    expect(decimateTimelineRange(points, 0, 8, 2)).toEqual([
      point(0, 0),
      point(1, 9),
      point(2, -5),
      point(5, -8),
      point(6, 12),
      point(8, 8),
    ]);
  });

  it('bounds output by bucket count instead of raw sample count', () => {
    const points = Array.from({ length: 100_000 }, (_, timestamp) => (
      point(timestamp, Math.sin(timestamp / 10))
    ));

    const result = decimateTimelineRange(points, 0, 99_999, 1_000);

    expect(result.length).toBeLessThanOrEqual(2_002);
    expect(result[0]).toEqual(points[0]);
    expect(result.at(-1)).toEqual(points.at(-1));
  });

  it('does not aggregate across segment boundaries or drop the segment marker', () => {
    const points = [
      point(0, 0),
      point(1, -10),
      point(2, 10),
      point(3, 100, true),
      point(4, 90),
      point(5, 110),
    ];

    const result = decimateTimelineRange(points, 0, 5, 1);

    expect(result).toEqual([
      point(0, 0),
      point(1, -10),
      point(2, 10),
      point(3, 100, true),
      point(4, 90),
      point(5, 110),
    ]);
  });
});
