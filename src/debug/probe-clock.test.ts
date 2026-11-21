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

  it('keeps clock offset estimates separate from measured round-trip RTT', () => {
    const clock = new ProbeClock();
    // Probe clock ahead of host by 5000 ms (negative offset estimates) with no explicit RTT passed
    for (let i = 0; i < 8; i++) {
      clock.update(1000 + i * 10, 6000 + i * 10);
    }
    const noRttSnap = clock.snapshot();
    expect(noRttSnap.warmedUp).toBe(true);
    expect(noRttSnap.minOffsetEstimateMs).toBe(-5000);
    expect(noRttSnap.offsetSpreadMs).toBe(0);
    expect(noRttSnap.measuredMinRttMs).toBeNull();
    expect(noRttSnap.measuredLastRttMs).toBeNull();

    // When explicit RTT pairing windows are supplied, measuredMinRttMs tracks RTT independently of offset
    clock.update(1085, 6080, 4.5);
    clock.update(1092, 6090, 2.0);
    const withRttSnap = clock.snapshot();
    expect(withRttSnap.minOffsetEstimateMs).toBe(-5000);
    expect(withRttSnap.offsetSpreadMs).toBe(5);
    expect(withRttSnap.measuredMinRttMs).toBe(2.0);
    expect(withRttSnap.measuredLastRttMs).toBe(2.0);
  });
});
