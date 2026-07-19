import type { TimelineDataPoint } from './timeline-sample-buffer';

export interface TimelineTraceViewport {
  tStart: number;
  tEnd: number;
  plotLeft: number;
  plotWidth: number;
  projectY: (point: TimelineDataPoint) => number;
}

export interface TimelineTraceCommand {
  command: 'moveTo' | 'lineTo';
  x: number;
  y: number;
}

export function firstPointAtOrAfter(points: TimelineDataPoint[], timestamp: number): number {
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (points[middle].timestamp < timestamp) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * Reduces a visible trace to Canvas path commands without allowing the one
 * retained pre-window predecessor to become a negative pixel column.
 */
export function buildTimelineTraceCommands(
  points: TimelineDataPoint[],
  viewport: TimelineTraceViewport,
): TimelineTraceCommand[] {
  if (points.length === 0 || viewport.tEnd < viewport.tStart || viewport.plotWidth <= 0) return [];

  const firstVisible = firstPointAtOrAfter(points, viewport.tStart);
  if (firstVisible >= points.length || points[firstVisible].timestamp > viewport.tEnd) return [];

  const commands: TimelineTraceCommand[] = [];
  const predecessor = firstVisible > 0 ? points[firstVisible - 1] : undefined;
  const firstVisiblePoint = points[firstVisible];
  let hasPathStart = false;

  if (predecessor && predecessor.timestamp < viewport.tStart && !firstVisiblePoint.startsNewSegment) {
    const span = firstVisiblePoint.timestamp - predecessor.timestamp;
    const predecessorY = viewport.projectY(predecessor);
    const firstVisibleY = viewport.projectY(firstVisiblePoint);
    const fraction = span > 0 ? (viewport.tStart - predecessor.timestamp) / span : 0;
    commands.push({
      command: 'moveTo',
      x: viewport.plotLeft,
      y: predecessorY + (firstVisibleY - predecessorY) * fraction,
    });
    hasPathStart = true;
  }

  let column = Number.NaN;
  let minY = 0;
  let maxY = 0;
  const flushColumn = () => {
    if (!Number.isFinite(column)) return;
    const x = column + 0.5;
    if (!hasPathStart) {
      commands.push({ command: 'moveTo', x, y: minY });
      hasPathStart = true;
    } else {
      commands.push({ command: 'lineTo', x, y: minY });
    }
    if (maxY !== minY) commands.push({ command: 'lineTo', x, y: maxY });
  };

  for (let index = firstVisible; index < points.length; index++) {
    const point = points[index];
    if (point.timestamp > viewport.tEnd) break;
    if (point.startsNewSegment) {
      flushColumn();
      column = Number.NaN;
      hasPathStart = false;
    }
    const x = viewport.plotLeft
      + ((point.timestamp - viewport.tStart) / (viewport.tEnd - viewport.tStart)) * viewport.plotWidth;
    const y = viewport.projectY(point);
    const nextColumn = Math.floor(x);
    if (nextColumn !== column) {
      flushColumn();
      column = nextColumn;
      minY = y;
      maxY = y;
    } else {
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  flushColumn();
  return commands;
}
