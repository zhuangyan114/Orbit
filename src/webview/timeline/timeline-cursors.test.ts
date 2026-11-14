import { describe, expect, it } from 'vitest';
import { placeTimelineCursor } from './timeline-cursors';

const viewport = { start: 2000, end: 10000 };

describe('Timeline cursor placement', () => {
  it('places A before B and keeps two visible cursors unchanged', () => {
    const a = placeTimelineCursor({ A: null, B: null }, 4400, viewport);
    expect(a).toEqual({ A: 4400, B: null });
    const pair = placeTimelineCursor(a, 7600, viewport);
    expect(pair).toEqual({ A: 4400, B: 7600 });
    expect(placeTimelineCursor(pair, 9000, viewport)).toBe(pair);
  });

  it.each([
    { A: -5000000, B: null },
    { A: 5000000, B: null },
    { A: 5000000, B: 7600 },
    { A: 5000000, B: 6000000 },
    { A: null, B: 7600 },
  ])('starts a new measurement at A when A is absent or offscreen: %j', cursors => {
    expect(placeTimelineCursor(cursors, 4400, viewport)).toEqual({ A: 4400, B: null });
  });

  it.each([null, -5000000, 5000000])('replaces an absent or offscreen B (%s) while retaining A', B => {
    expect(placeTimelineCursor({ A: 4400, B }, 7600, viewport)).toEqual({ A: 4400, B: 7600 });
  });

  it('accepts both viewport boundaries and preserves fractional timestamps and reversed order', () => {
    const pair = { A: viewport.end, B: viewport.start };
    expect(placeTimelineCursor(pair, 4400, viewport)).toBe(pair);
    expect(placeTimelineCursor({ A: 7600.123, B: null }, 4400.456, viewport))
      .toEqual({ A: 7600.123, B: 4400.456 });
  });
});
