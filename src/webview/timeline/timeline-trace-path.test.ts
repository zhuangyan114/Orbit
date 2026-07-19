import { describe, expect, it } from 'vitest';
import { appendTimelineSamples, type TimelineDataPoint, type TimelineSampleSnapshot } from './timeline-sample-buffer';
import { buildTimelineTraceCommands } from './timeline-trace-path';

const point = (timestamp: number, value = timestamp): TimelineDataPoint => ({
  timestamp, value, display: String(value),
});

const viewport = (tStart: number, tEnd: number) => ({
  tStart,
  tEnd,
  plotLeft: 12,
  plotWidth: 160,
  projectY: (sample: TimelineDataPoint) => sample.value,
});

describe('buildTimelineTraceCommands', () => {
  it('interpolates the retained predecessor at the left edge without flushing its negative column', () => {
    const commands = buildTimelineTraceCommands([
      point(0, 0),
      point(100, 100),
      point(150, 150),
    ], viewport(50, 150));

    expect(commands).toEqual([
      { command: 'moveTo', x: 12, y: 50 },
      { command: 'lineTo', x: 92.5, y: 100 },
      { command: 'lineTo', x: 172.5, y: 150 },
    ]);
    expect(commands.every(command => command.x >= 12)).toBe(true);
  });

  it('keeps the first segment anchored at the left edge while auto-follow advances tStart', () => {
    const points = [point(0, 0), point(100, 100), point(190, 190)];
    const firstFrame = buildTimelineTraceCommands(points, viewport(40, 140));
    const nextFrame = buildTimelineTraceCommands(points, viewport(60, 160));

    expect(firstFrame[0]).toEqual({ command: 'moveTo', x: 12, y: 40 });
    expect(nextFrame[0]).toEqual({ command: 'moveTo', x: 12, y: 60 });
    expect(firstFrame.slice(1).every(command => command.command === 'lineTo')).toBe(true);
    expect(nextFrame.slice(1).every(command => command.command === 'lineTo')).toBe(true);
  });

  it('retains the ten-minute predecessor but draws it only as a clipped boundary intersection', () => {
    const existing = [point(0), point(30_000), point(31_000), point(600_000)];
    const snapshots: TimelineSampleSnapshot[] = [{
      expression: 'counter', color: '#4EC9B0', currentValue: '631001', data: [point(631_001)],
    }];
    appendTimelineSamples(new Map([['counter', existing]]), snapshots);

    expect(existing.map(sample => sample.timestamp)).toEqual([31_000, 600_000, 631_001]);
    const commands = buildTimelineTraceCommands(existing, viewport(600_001, 631_001));
    expect(commands[0]).toMatchObject({ command: 'moveTo', x: 12 });
    expect(commands.every(command => command.x >= 12)).toBe(true);
  });

  it('preserves equal timestamps, uneven spacing, and min/max aggregation within one pixel column', () => {
    const commands = buildTimelineTraceCommands([
      point(100, 1),
      point(100, 4),
      point(100.4, -2),
      point(160, 8),
    ], viewport(100, 200));

    expect(commands).toEqual([
      { command: 'moveTo', x: 12.5, y: -2 },
      { command: 'lineTo', x: 12.5, y: 4 },
      { command: 'lineTo', x: 108.5, y: 8 },
    ]);
  });

  it('starts a new Canvas subpath instead of connecting old and new debug sessions', () => {
    const commands = buildTimelineTraceCommands([
      point(20, 1),
      { ...point(100, 8), startsNewSegment: true },
      point(120, 9),
    ], viewport(0, 150));

    expect(commands).toEqual([
      { command: 'moveTo', x: 33.5, y: 1 },
      { command: 'moveTo', x: 118.5, y: 8 },
      { command: 'lineTo', x: 140.5, y: 9 },
    ]);
  });

  it('does not interpolate a moving left-edge point across a debug-session gap', () => {
    const points = [
      point(0, -10),
      { ...point(100, 8), startsNewSegment: true },
      point(120, 9),
    ];
    const firstFrame = buildTimelineTraceCommands(points, viewport(40, 140));
    const nextFrame = buildTimelineTraceCommands(points, viewport(60, 160));

    expect(firstFrame[0]).toEqual({ command: 'moveTo', x: 108.5, y: 8 });
    expect(nextFrame[0]).toEqual({ command: 'moveTo', x: 76.5, y: 8 });
    expect(firstFrame.some(command => command.x === 12)).toBe(false);
    expect(nextFrame.some(command => command.x === 12)).toBe(false);
  });
});
