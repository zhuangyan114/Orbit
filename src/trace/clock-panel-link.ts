import { calibrateClockSegment, mapSegmentTraceTickToHost, hostNsToTicksWithFit, type ClockSegmentMapping } from './clock-mapping';
import type { TimelineLinkClock, TraceClockArrivals } from './clock-link-observations';
import { getSegmentBoundsForUnit, type TraceRecordSummary, type TraceSegmentDto, type TraceTimeUnit } from '../webview/rtos/trace-timeline-state';
import type { SharedTraceCursor } from '../webview/rtos/trace-timeline-view';
import type { TimelineCursors } from '../webview/timeline/timeline-cursors';

const NS_PER_SECOND = 1_000_000_000n;
const APPROXIMATE_NOTICE = '近似联动。RTT 缓冲和采样延迟未知，无法给出精度上界。';
const MANUAL_NOTICE = '手动对齐。误差取决于游标选点与两个时间源的漂移。';
const NO_MAPPING = '没有覆盖选区的时间映射。请在两个面板用 A 选中同一事件，再从 Trace 手动对齐。';

function arrivalNotice(clock: TimelineLinkClock): string {
  const rtt = clock.measuredProbeRoundTripMs;
  return rtt !== undefined && Number.isFinite(rtt) && rtt >= 0
    ? `${APPROXIMATE_NOTICE} XR-DAP 配对请求的最短往返耗时 ${rtt.toFixed(2)} ms。` : APPROXIMATE_NOTICE;
}

export interface TraceLinkSelection {
  readonly A: SharedTraceCursor | null;
  readonly B: SharedTraceCursor | null;
}

export interface TimelineLinkWindow {
  readonly key: string;
  readonly shiftMs: number;
  readonly start: number;
  readonly end: number;
}

export interface TimelineLinkView {
  readonly recordId: string;
  readonly bounds: { readonly start: number; readonly end: number };
  readonly sessionStarts: readonly number[];
  readonly windows: readonly TimelineLinkWindow[];
  readonly cursors: TimelineCursors;
}

export interface TraceLinkView {
  readonly record: TraceRecordSummary;
  readonly arrivals: ReturnType<TraceClockArrivals['getWindows']>;
}

interface TracePoints { segment: TraceSegmentDto; ticks: readonly (bigint | null)[] }
interface ManualAlignment {
  readonly traceRecordId: string;
  readonly timelineRecordId: string;
  readonly bootGeneration: number;
  readonly segmentId: number;
  readonly frequencyHz: number;
  readonly timelineA: number;
  readonly traceA: bigint;
  readonly msPerTick: number;
}

export function readTraceLinkSelection(value: unknown): TraceLinkSelection | null {
  if (!value || typeof value !== 'object') return null;
  const selection = value as Record<string, unknown>;
  const units: readonly string[] = ['ns', 'relative-ns', 'absolute-ticks', 'relative-ticks'];
  const valid = (point: unknown): point is SharedTraceCursor | null => {
    if (point === null) return true;
    if (!point || typeof point !== 'object') return false;
    const cursor = point as Partial<SharedTraceCursor>;
    return typeof cursor.timeStr === 'string' && /^-?\d{1,30}$/.test(cursor.timeStr)
      && typeof cursor.unit === 'string' && units.includes(cursor.unit)
      && (cursor.bootGeneration === undefined || Number.isSafeInteger(cursor.bootGeneration))
      && (cursor.segmentId === undefined || Number.isSafeInteger(cursor.segmentId));
  };
  return valid(selection.A) && valid(selection.B) ? { A: selection.A, B: selection.B } : null;
}

function resolveTracePoints(record: TraceRecordSummary, selection: TraceLinkSelection): TracePoints | undefined {
  const points = [selection.A, selection.B];
  if (!points.some(Boolean)) return;
  const candidates = record.segments.filter(segment => segment.reliability !== 'uncertain' && segment.sysFreqHz
    && points.every(point => {
      if (!point) return true;
      if ((point.bootGeneration !== undefined && point.bootGeneration !== segment.bootGeneration)
        || (point.segmentId !== undefined && point.segmentId !== segment.segmentId)) return false;
      const bounds = getSegmentBoundsForUnit(segment, point.unit);
      const time = BigInt(point.timeStr);
      return bounds && time >= bounds.min && time <= bounds.max;
    }));
  if (candidates.length !== 1) return;
  const segment = candidates[0];
  const relativeMax = BigInt(segment.maxRelativeTicks);
  const offset = segment.lastAbsoluteTicks === undefined ? 0n : BigInt(segment.lastAbsoluteTicks) - relativeMax;
  const ticks = points.map(point => {
    if (!point) return null;
    const value = BigInt(point.timeStr);
    const fromNs = point.unit === 'ns' || point.unit === 'relative-ns';
    const absolute = point.unit === 'ns' || point.unit === 'absolute-ticks';
    const tick = fromNs ? (value * BigInt(segment.sysFreqHz!) + NS_PER_SECOND / 2n) / NS_PER_SECOND : value;
    return absolute ? tick - offset : tick;
  });
  if (ticks.some(tick => tick !== null && (tick < BigInt(segment.minRelativeTicks) || tick > relativeMax))) return;
  return { segment, ticks };
}

function insideTimeline(view: TimelineLinkView, points: readonly (number | null)[]): boolean {
  const times = points.filter((point): point is number => point !== null);
  if (!times.length || times.some(point => !Number.isFinite(point) || point < view.bounds.start || point > view.bounds.end)) return false;
  const low = Math.min(...times);
  const high = Math.max(...times);
  return !view.sessionStarts.some(start => low < start && start <= high);
}

function sameSegment(segment: TraceSegmentDto, boot: number, id: number, frequency?: number): boolean {
  return segment.bootGeneration === boot && segment.segmentId === id && segment.sysFreqHz === frequency && segment.reliability !== 'uncertain';
}

function pointAt(segment: TraceSegmentDto, tick: bigint | null): SharedTraceCursor | null {
  if (tick === null) return null;
  const timeStr = (tick * NS_PER_SECOND / BigInt(segment.sysFreqHz!)).toString();
  return { timeStr, unit: 'relative-ns', bootGeneration: segment.bootGeneration, segmentId: segment.segmentId };
}

function observedMappings(trace: TraceLinkView, timeline: TimelineLinkView) {
  const mappings: { segment: TraceSegmentDto; window: TimelineLinkWindow; map: ClockSegmentMapping; clock: TimelineLinkClock }[] = [];
  for (const { first, last, tightest } of trace.arrivals) {
    if (first.relativeTicks === last.relativeTicks) continue;
    const segment = trace.record.segments.find(seg => sameSegment(seg, first.bootGeneration, first.segmentId, first.frequencyHz));
    if (!segment) continue;
    const startTicks = BigInt(first.relativeTicks);
    const committedEnd = BigInt(segment.maxRelativeTicks);
    const endTicks = BigInt(last.relativeTicks) < committedEnd ? BigInt(last.relativeTicks) : committedEnd;
    if (startTicks >= endTicks || BigInt(tightest.relativeTicks) > endTicks) continue;
    for (const window of timeline.windows) {
      if (window.key !== first.clock.key) continue;
      const map = calibrateClockSegment({
        recordId: trace.record.recordId,
        bootGeneration: segment.bootGeneration,
        segmentId: segment.segmentId,
        reliability: segment.reliability,
        timeAnchorStatus: segment.timeAnchorStatus,
        tickDomain: 'relative-ticks',
        targetClock: { nominalHz: first.frequencyHz, direction: 'up', tickBits: segment.timestampBits, wrapCount: segment.timestampWrapCount, startTicks, endTicks },
        hostOrigin: { originId: first.clock.key, processKind: 'dap' },
        observations: [first, last, tightest].map(anchor => ({
          source: 'rtt-batch-arrival', targetTicks: BigInt(anchor.relativeTicks), oneSided: 'upper-bound',
          // Subtract the store origin before conversion to avoid subtracting epoch-sized nanoseconds in Number.
          hostNs: BigInt(Math.round((anchor.axisMs - window.shiftMs) * 1_000_000)),
        })),
      });
      if (map.targetFit && map.confidence === 'approximate') mappings.push({ segment, window, map, clock: tightest.clock });
    }
  }
  return mappings;
}

/** Commands transfer once, on request. Applying a destination selection never sends it back. */
export class ClockPanelLink {
  private manual?: ManualAlignment;

  align(trace: TraceLinkView, selection: TraceLinkSelection, timeline: TimelineLinkView): string {
    const resolved = resolveTracePoints(trace.record, selection);
    const traceA = resolved?.ticks[0];
    const timelineA = timeline.cursors.A;
    if (!resolved || traceA === undefined || traceA === null || timelineA === null) throw new Error('请在两个面板用游标 A 标出同一事件。');
    const { segment, ticks } = resolved;
    const freq = segment.sysFreqHz!;
    let msPerTick = 1000 / freq;
    const traceB = ticks[1];
    const timelineB = timeline.cursors.B;
    if (traceB !== null && timelineB !== null) {
      if (!insideTimeline(timeline, [timelineA, timelineB]) || traceA === traceB) throw new Error('第二对游标必须位于同一连续区间。');
      msPerTick = (timelineB - timelineA) / Number(traceB - traceA);
      if (!Number.isFinite(msPerTick) || msPerTick <= 0) throw new Error('两个面板的 A/B 顺序必须一致，且时间不能相同。');
    }
    if (!insideTimeline(timeline, [timelineA])) throw new Error('变量游标 A 超出记录范围。');
    this.manual = { traceRecordId: trace.record.recordId, timelineRecordId: timeline.recordId,
      bootGeneration: segment.bootGeneration, segmentId: segment.segmentId, frequencyHz: freq, timelineA, traceA, msPerTick };
    return MANUAL_NOTICE;
  }

  private alignment(trace: TraceLinkView, timeline: TimelineLinkView) {
    const manual = this.manual;
    if (!manual || manual.traceRecordId !== trace.record.recordId || manual.timelineRecordId !== timeline.recordId) return;
    const segment = trace.record.segments.find(seg => sameSegment(seg, manual.bootGeneration, manual.segmentId, manual.frequencyHz));
    if (segment) return { manual, segment };
  }

  toTimeline(trace: TraceLinkView, selection: TraceLinkSelection, timeline: TimelineLinkView) {
    const points = resolveTracePoints(trace.record, selection);
    if (!points) throw new Error('Trace 游标必须落在同一个可用时间段。');
    const aligned = this.alignment(trace, timeline);
    if (aligned && points.segment === aligned.segment) {
      const { manual } = aligned;
      const [A, B] = points.ticks.map(tick => tick === null ? null : manual.timelineA + Number(tick - manual.traceA) * manual.msPerTick);
      if (insideTimeline(timeline, [A, B, manual.timelineA])) return { cursors: { A, B }, notice: MANUAL_NOTICE };
    }
    const candidates = observedMappings(trace, timeline).flatMap(({ segment, window, map, clock }) => {
      if (segment !== points.segment) return [];
      const [A, B] = points.ticks.map(tick => {
        const mapped = tick === null ? null : mapSegmentTraceTickToHost(map, tick, { allowApproximate: true });
        return mapped === null ? null : mapped.ok ? Number(mapped.hostNs) / 1_000_000 : NaN;
      });
      if (!insideTimeline(timeline, [A, B]) || [A, B].some(time => time !== null && (time < window.start || time > window.end))) return [];
      return [{ cursors: { A, B }, notice: arrivalNotice(clock) }];
    });
    if (candidates.length !== 1) throw new Error(NO_MAPPING);
    return candidates[0];
  }

  toTrace(trace: TraceLinkView, timeline: TimelineLinkView) {
    const points = [timeline.cursors.A, timeline.cursors.B];
    if (!insideTimeline(timeline, points)) throw new Error('变量游标必须落在同一段记录内。');
    const aligned = this.alignment(trace, timeline);
    if (aligned && insideTimeline(timeline, [...points, aligned.manual.timelineA])) {
      const { manual, segment } = aligned;
      const ticks = points.map(point => point === null ? null : manual.traceA + BigInt(Math.round((point - manual.timelineA) / manual.msPerTick)));
      if (ticks.every(tick => tick === null || (tick >= BigInt(segment.minRelativeTicks) && tick <= BigInt(segment.maxRelativeTicks)))) {
        const [A, B] = ticks.map(tick => pointAt(segment, tick));
        return { cursors: { A, B }, notice: MANUAL_NOTICE };
      }
    }
    const candidates = observedMappings(trace, timeline).flatMap(({ segment, map, window, clock }) => {
      if (points.some(point => point !== null && (point < window.start || point > window.end))) return [];
      const ticks = points.map(point => point === null ? null : hostNsToTicksWithFit(map.targetFit!, BigInt(Math.round(point * 1_000_000))));
      if (ticks.some(tick => tick !== null && (tick < map.targetClock.startTicks || tick > map.targetClock.endTicks))) return [];
      const [A, B] = ticks.map(tick => pointAt(segment, tick));
      return [{ cursors: { A, B }, notice: arrivalNotice(clock) }];
    });
    if (candidates.length !== 1) throw new Error(NO_MAPPING);
    return candidates[0];
  }
}
