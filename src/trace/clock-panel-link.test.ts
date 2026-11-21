import { describe, expect, it } from 'vitest';
import { ClockPanelLink, type TimelineLinkView, type TraceLinkView, type TraceLinkSelection } from './clock-panel-link';
import { TraceClockArrivals } from './clock-link-observations';
import type { TraceRecordSummary, TraceSegmentDto } from '../webview/rtos/trace-timeline-state';

const origin = 1777777777000.25;
const clock = { key: 'dap-A:1:2:host:4', source: 'host' as const };
const segment: TraceSegmentDto = {
  bootGeneration: 2, segmentId: 3, startByteOffset: 12, reliability: 'trusted', closed: true,
  packetCount: 100, syncCount: 1, timestampBits: 32, timestampWrapCount: 0,
  timeAnchorStatus: 'unanchored', minRelativeTicks: '0', maxRelativeTicks: '10000000', sysFreqHz: 1_000_000,
};
const record = { recordId: 'trace-1', source: 'session', segments: [segment], gaps: [] } as unknown as TraceRecordSummary;
const at = (ticks: number, identity = segment) => ({ timeStr: `${ticks}`, unit: 'relative-ticks' as const,
  bootGeneration: identity.bootGeneration, segmentId: identity.segmentId });
const timeline: TimelineLinkView = { recordId: 'variable-1', bounds: { start: 0, end: 15000 }, sessionStarts: [],
  windows: [{ key: clock.key, shiftMs: origin, start: 0, end: 15000 }], cursors: { A: 3000, B: 5000 } };
const arrival = (ticks: number, ms: number) => ({ clock, bootGeneration: 2, segmentId: 3,
  relativeTicks: `${ticks}`, frequencyHz: 1_000_000, axisMs: origin + ms });

describe('cross-panel time selection', () => {
  it('requires actual arrivals from the same DAP epoch and maps both directions without changing order', () => {
    const arrivals = new TraceClockArrivals();
    arrivals.observe(arrival(1_000_000, 3000));
    arrivals.observe(arrival(8_000_000, 10000));
    const trace = { record, arrivals: arrivals.getWindows() };
    const link = new ClockPanelLink();
    const output = link.toTimeline(trace, { A: at(3_000_000), B: at(2_000_000) }, timeline);
    expect(output.cursors).toEqual({ A: 5000, B: 4000 });
    expect(output.notice).toContain('无法给出精度上界');
    expect(link.toTrace(trace, { ...timeline, cursors: output.cursors }).cursors).toEqual({
      A: { ...at(3_000_000), unit: 'relative-ns', timeStr: '3000000000' },
      B: { ...at(2_000_000), unit: 'relative-ns', timeStr: '2000000000' },
    });
    const nextBoot = { ...timeline, windows: [{ ...timeline.windows[0], key: 'dap-A:1:3:host:7' }] };
    expect(() => link.toTimeline(trace, { A: at(2_000_000), B: null }, nextBoot)).toThrow('没有覆盖');
    expect(() => link.toTimeline(trace, { A: at(10_000), B: null }, timeline)).toThrow('没有覆盖');
  });

  it('does not bridge a transport drop, boot change or sampler pause', () => {
    const arrivals = new TraceClockArrivals();
    arrivals.observe(arrival(1_000_000, 3000));
    arrivals.observe(arrival(2_000_000, 4000));
    arrivals.breakWindow();
    arrivals.observe(arrival(5_000_000, 7000));
    arrivals.observe(arrival(8_000_000, 10000));
    const trace = { record, arrivals: arrivals.getWindows() };
    const link = new ClockPanelLink();
    expect(() => link.toTimeline(trace, { A: at(1_500_000), B: at(6_000_000) }, timeline)).toThrow('没有覆盖');
    expect(() => link.toTrace(trace, { ...timeline, cursors: { A: 6000, B: null } })).toThrow('没有覆盖');
    const otherBoot = { ...segment, bootGeneration: 3 };
    expect(() => link.toTimeline({ ...trace, record: { ...record, segments: [segment, otherBoot] } },
      { A: at(1_500_000), B: at(6_000_000, otherBoot) }, timeline)).toThrow('同一个');
    expect(() => link.toTrace(trace, { ...timeline, sessionStarts: [0, 4000] })).toThrow('同一段');
  });

  it('allows explicit offline alignment by two shared event positions and fences record replacement', () => {
    const trace: TraceLinkView = { record: { ...record, source: 'offline' }, arrivals: [] };
    const selections: TraceLinkSelection = { A: at(1_000_000), B: at(2_900_000) };
    const link = new ClockPanelLink();
    expect(() => link.toTimeline(trace, selections, timeline)).toThrow('没有覆盖');
    expect(link.align(trace, selections, timeline)).toContain('手动');
    expect(link.toTimeline(trace, { A: at(1_950_000), B: null }, timeline).cursors).toEqual({ A: 4000, B: null });
    expect(link.toTrace(trace, { ...timeline, cursors: { A: null, B: 4000 } }).cursors.B?.timeStr).toBe('1950000000');
    expect(() => link.toTrace(trace, { ...timeline, recordId: 'other' })).toThrow('没有覆盖');
  });
});
