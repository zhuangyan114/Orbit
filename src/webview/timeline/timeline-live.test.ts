import { describe, expect, it } from 'vitest';
import { prepareTimelineLiveSamples } from './timeline-live';

const snapshot = (length: number) => ({ expression: 'sensor', color: '#123456', currentValue: '0',
  data: Array.from({ length }, (_, timestamp) => ({ timestamp, value: timestamp === 35 ? 100 : timestamp === 40 ? -50 : 0, display: '0' })),
});

describe('Timeline live display tail', () => {
  it('preserves extrema, both sides of a gap and the final timestamp without changing raw data', () => {
    const raw = snapshot(100);
    raw.data[70] = { ...raw.data[70], startsNewSegment: true } as typeof raw.data[number];
    const before = structuredClone(raw);
    const [display] = prepareTimelineLiveSamples([raw], 100);
    expect(display.data.map(point => point.timestamp)).toEqual([0, 35, 40, 69, 70, 99]);
    expect(display.data.find(point => point.timestamp === 70)?.startsNewSegment).toBe(true);
    expect(raw).toEqual(before);
    expect(display.currentValue).toBe(raw.currentValue);
  });

  it('falls back to host queries before the viewport has supplied a resolution', () => {
    for (const resolution of [undefined, NaN, Infinity, 0, -1]) expect(prepareTimelineLiveSamples([snapshot(10)], resolution)).toEqual([]);
  });

  it('falls back atomically for an oversized multi-channel tail', () => {
    const first = snapshot(5000), second = { ...snapshot(5000), expression: 'other' };
    expect(prepareTimelineLiveSamples([first], 0.1)[0].data).toEqual(first.data);
    expect(prepareTimelineLiveSamples([first, second], 0.1)).toEqual([]);
  });

  it('retains every actual segment boundary even at coarse resolution', () => {
    const raw = snapshot(500);
    raw.data = raw.data.map(point => ({ ...point, startsNewSegment: point.timestamp % 10 === 0 }));
    const result = prepareTimelineLiveSamples([raw], 1000)[0].data;
    expect(result.filter(point => point.startsNewSegment)).toHaveLength(50);
    for (let timestamp = 9; timestamp < 500; timestamp += 10) expect(result.some(point => point.timestamp === timestamp)).toBe(true);
  });
});
