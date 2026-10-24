/** Shared by the color picker and automatic channel colors. */
export const TIMELINE_COLORS = [
  '#4EC9B0', '#569CD6', '#FFD166', '#C586F0', '#F16D7A', '#A8D65C',
  '#FF9F43', '#42D9F3', '#F58DCE', '#EEE8D5', '#8C8CFF', '#D16969',
] as const;

type Lab = readonly [number, number, number];

function toOklab(color: string): Lab | null {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return null;
  const [r, g, b] = [1, 3, 5].map(offset => {
    const value = parseInt(color.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}

function hslColor(hue: number, lightness: number): string {
  const amplitude = 0.75 * Math.min(lightness, 1 - lightness);
  const rgb = [0, 8, 4].map(offset => {
    const k = (offset + hue / 30) % 12;
    const value = lightness - amplitude * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(value * 255).toString(16).padStart(2, '0');
  });
  return ('#' + rgb.join('')).toUpperCase();
}

const EXTRA_COLORS = [0.5, 0.65, 0.8].flatMap(lightness =>
  Array.from({ length: 36 }, (_, index) => hslColor(index * 10, lightness)),
);

/** Maximize the perceptual distance to the closest existing color, including custom colors. */
export function pickTimelineColor(existingColors: Iterable<string>): string {
  const colors = [...existingColors];
  const used = new Set(colors.map(color => color.toUpperCase()));
  const labs = colors.map(toOklab).filter((lab): lab is Lab => lab !== null);
  let best: string = TIMELINE_COLORS[0];
  let bestDistance = -1;
  const consider = (color: string) => {
    if (used.has(color)) return;
    const lab = toOklab(color)!;
    const distance = Math.min(...labs.map(other =>
      (lab[0] - other[0]) ** 2 + (lab[1] - other[1]) ** 2 + (lab[2] - other[2]) ** 2,
    ));
    if (distance > bestDistance) { best = color; bestDistance = distance; }
  };
  TIMELINE_COLORS.forEach(consider);
  // Expand the candidates when every preset is already close to an existing curve.
  if (bestDistance < 0.12 ** 2) EXTRA_COLORS.forEach(consider);
  return best;
}
