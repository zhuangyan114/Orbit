import { describe, expect, it } from 'vitest';
import { ProbeClock } from './probe-clock';

/** Feeds `count` pairings 10 ms apart with a given link latency; returns the last offset. */
function feed(clock: ProbeClock, startMs: number, count: number, latencyMs: (i: number) => number) {
  let offset: number | null = null;
  for (let i = 0; i < count; i++) {
    const probeNowMs = startMs + i * 10;
    // The probe clock runs 1000 ms behind the host clock.
    offset = clock.update(probeNowMs + 1000 + latencyMs(i), probeNowMs);
  }
  return offset;
}

describe('ProbeClock', () => {
  it('reports no offset until eight pairings exist, then the lowest-latency one', () => {
    const clock = new ProbeClock();
    expect(feed(clock, 0, 7, i => 5 + (i % 3))).toBeNull();
    expect(clock.update(70 + 1000 + 2, 70)).toBe(1002);
  });

  it('slews toward a better estimate by at most 0.2 % of elapsed probe time', () => {
    const clock = new ProbeClock();
    expect(feed(clock, 0, 8, () => 20)).toBe(1020);
    // A much faster round trip: the best estimate drops by 19 ms, 10 ms later.
    expect(clock.update(80 + 1000 + 1, 80)).toBeCloseTo(1020 - 10 * 0.002, 9);
    // It keeps converging without overshooting.
    const settled = feed(clock, 90, 2000, () => 1)!;
    expect(settled).toBeCloseTo(1001, 6);
  });

  it('starts over after reset', () => {
    const clock = new ProbeClock();
    feed(clock, 0, 8, () => 20);
    clock.reset();
    expect(feed(clock, 1000, 7, () => 3)).toBeNull();
    expect(clock.update(1070 + 1000 + 3, 1070)).toBe(1003);
  });
});
