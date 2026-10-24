import { describe, expect, it } from 'vitest';
import { hexToHsv, hsvToHex } from './timeline-color-picker';
import { TIMELINE_COLORS } from './timeline-colors';

describe('Timeline color picker color values', () => {
  it.each([
    ['#000000', 0, 0, 0], ['#FFFFFF', 0, 0, 1],
    ['#FF0000', 0, 1, 1], ['#FFFF00', 60, 1, 1],
    ['#00FF00', 120, 1, 1], ['#00FFFF', 180, 1, 1],
    ['#0000FF', 240, 1, 1], ['#FF00FF', 300, 1, 1],
  ] as const)('maps %s to the expected hue, saturation and brightness', (hex, h, s, v) => {
    expect(hexToHsv(hex)).toEqual({ h, s, v });
    expect(hsvToHex({ h, s, v })).toBe(hex);
  });

  it.each([...TIMELINE_COLORS, '#123456', '#010101', '#FEFEFE', '#808080', '#abcdef'])(
    'preserves every RGB byte when editing %s', hex => {
      expect(hsvToHex(hexToHsv(hex))).toBe(hex.toUpperCase());
    },
  );

  it('handles both ends of the hue slider and black/white plane corners', () => {
    expect(hsvToHex({ h: 360, s: 1, v: 1 })).toBe('#FF0000');
    expect(hsvToHex({ h: 120, s: 0, v: 1 })).toBe('#FFFFFF');
    expect(hsvToHex({ h: 240, s: 1, v: 0 })).toBe('#000000');
    expect(hsvToHex({ h: 240, s: 0, v: 0 })).toBe('#000000');
  });
});
