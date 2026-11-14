import type { TimelineRange } from './timeline-range';

export interface TimelineCursors {
  A: number | null;
  B: number | null;
}

export function placeTimelineCursor(
  cursors: TimelineCursors,
  time: number,
  viewport: TimelineRange,
): TimelineCursors {
  const visible = (value: number | null) => value !== null && value >= viewport.start && value <= viewport.end;
  // An old, offscreen A must not make a new measurement start with B.
  if (!visible(cursors.A)) return { A: time, B: null };
  if (!visible(cursors.B)) return { A: cursors.A, B: time };
  return cursors;
}
