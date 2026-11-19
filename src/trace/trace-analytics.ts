import type { SegmentReliability, TimeAnchorStatus } from './systemview-decoder';
import type {
  ContextActivationInterval,
  ExecutionContextKind,
  ExecutionSliceInterval,
  LabelSource,
  MarkerInterval,
  MarkerPointEvent,
  ReadyWaitInterval,
} from './systemview-reconstructor';
import type {
  DecodedTracePage,
  IndexedPageDescriptor,
  SegmentIndexMetadata,
  StoredGapEntry,
  TracePageKind,
} from './trace-format';
import {
  getTimePointValueForUnit,
  PageLodSummary,
  ticksToNsBigInt,
  TraceQueryTimeUnit,
  TraceRangeIndex,
} from './trace-range-index';

export type TraceAnalysisPrecision = 'exact' | 'approx' | 'unavailable';

export interface TraceAnalysisQueryRequest {
  readonly start: bigint | string | number;
  readonly end: bigint | string | number;
  readonly unit: Exclude<TraceQueryTimeUnit, 'byte-offset'> | 'byte-offset';
  readonly bootGeneration?: number;
  readonly segmentId?: number;
  readonly maxBins?: number;
  readonly maxContexts?: number;
  readonly maxMarkers?: number;
  readonly maxCandidatePages?: number;
  readonly includeCpuLoad?: boolean;
  readonly includeContexts?: boolean;
  readonly includeMarkers?: boolean;
}

export interface TraceCpuLoadBin {
  readonly binIndex: number;
  readonly start: string;
  readonly end: string;
  readonly duration: string;
  readonly taskDuration: string;
  readonly isrDuration: string;
  readonly schedulerDuration: string;
  readonly idleDuration: string;
  readonly unknownDuration: string;
  readonly activeDuration: string;
  readonly knownDuration: string;
  readonly activeWindowPct: number | null;
  readonly activeKnownPct: number | null;
  readonly isrWindowPct: number | null;
  readonly idleWindowPct: number | null;
  readonly unknownWindowPct: number | null;
  readonly hasGap: boolean;
  readonly gapKinds: readonly string[];
  readonly hasIncomplete: boolean;
  readonly hasUncertain: boolean;
  readonly dominantContext?: {
    readonly contextKind: ExecutionContextKind;
    readonly contextKey: string;
    readonly label?: string;
    readonly duration: string;
  };
}

export interface TraceDurationStats {
  readonly count: number;
  readonly total: string;
  readonly min: string;
  readonly max: string;
  readonly avg: string;
  readonly avgFloor: string;
}

export interface TraceContextStatsRow {
  readonly contextKind: ExecutionContextKind | 'timer';
  readonly contextKey: string;
  readonly taskInstanceId?: string;
  readonly tcbAddress?: number;
  readonly taskGeneration?: number;
  readonly irqId?: number;
  readonly timerId?: number;
  readonly label?: string;
  readonly labelSource: LabelSource;
  readonly cpuAccounted: boolean;
  readonly clippedExclusiveDuration: string;
  readonly windowPercent: number | null;
  readonly knownPercent: number | null;
  readonly clippedSliceCount: number;
  readonly completeActivationCount: number;
  readonly boundaryActivationCount: number;
  readonly incompleteActivationCount: number;
  readonly exclusiveStats?: TraceDurationStats;
  readonly inclusiveStats?: TraceDurationStats;
  readonly preemptedTotalDuration: string;
  readonly preemptionCountTotal: number;
  readonly readyCompleteCount: number;
  readonly readyBoundaryCount: number;
  readonly readyRemovedCount: number;
  readonly readyIncompleteCount: number;
  readonly readyStats?: TraceDurationStats;
}

export interface TraceMarkerStatsRow {
  readonly markerId: number;
  readonly name?: string;
  readonly nameSource: LabelSource;
  readonly completeCount: number;
  readonly boundaryCount: number;
  readonly incompleteCount: number;
  readonly pointCount: number;
  readonly uncertainPointCount: number;
  readonly durationStats?: TraceDurationStats;
  readonly contextKeys: readonly string[];
}

export interface TraceVerifiableSegmentInfo {
  readonly bootGeneration: number;
  readonly segmentId: number;
  readonly reliability: SegmentReliability;
  readonly timeAnchorStatus: TimeAnchorStatus;
  readonly sysFreqHz?: number;
  readonly start: string;
  readonly end: string;
}

export interface TraceAnalysisQueryResult {
  readonly unit: TraceQueryTimeUnit;
  readonly start: string;
  readonly end: string;
  readonly windowDuration: string;
  readonly precision: TraceAnalysisPrecision;
  readonly approxReason?: string;
  readonly verifiable: boolean;
  readonly verifiableReason?: string;
  readonly timeDomainJump: boolean;
  readonly timeDomainWarnings: readonly string[];
  readonly skippedUnanchoredSegments: readonly number[];
  readonly skippedNoFrequencySegments: readonly number[];
  readonly excludedBootGenerations: readonly number[];
  readonly verifiableSegments: readonly TraceVerifiableSegmentInfo[];
  readonly gapsInWindow: readonly StoredGapEntry[];
  readonly totals: {
    readonly taskDuration: string;
    readonly isrDuration: string;
    readonly schedulerDuration: string;
    readonly idleDuration: string;
    readonly unknownDuration: string;
    readonly activeDuration: string;
    readonly knownDuration: string;
    readonly activeWindowPct: number | null;
    readonly activeKnownPct: number | null;
    readonly unknownWindowPct: number | null;
    readonly excludedIncompleteSlices: number;
    readonly excludedUncertainSlices: number;
    readonly excludedIncompleteActivations: number;
    readonly excludedIncompleteReadyWaits: number;
    readonly excludedIncompleteMarkers: number;
    readonly sliceOverlapDetected: boolean;
  };
  readonly bins: readonly TraceCpuLoadBin[];
  readonly contexts: readonly TraceContextStatsRow[];
  readonly contextsTruncated: boolean;
  readonly markers: readonly TraceMarkerStatsRow[];
  readonly markersTruncated: boolean;
  readonly candidatePagesScanned: number;
  readonly cacheHits: number;
  readonly cacheMisses: number;
}

export interface TraceAnalysisExecutionHost {
  readonly index: TraceRangeIndex;
  loadPage(desc: IndexedPageDescriptor): Promise<DecodedTracePage>;
  getCacheStats(): { readonly hits: number; readonly misses: number };
  isCancelled(): boolean;
  yieldToLoop(): Promise<void>;
  readonly yieldEveryPages?: number;
  readonly yieldEveryItems?: number;
}

const DEFAULT_MAX_BINS = 120;
const HARD_MAX_BINS = 512;
const DEFAULT_MAX_CONTEXTS = 256;
const HARD_MAX_CONTEXTS = 2048;
const DEFAULT_MAX_MARKERS = 256;
const HARD_MAX_MARKERS = 2048;
const DEFAULT_MAX_CANDIDATE_PAGES = 4096;

/**
 * 使用纯 BigInt 缩放计算百分比（保留 4 位小数精度再转为 Number），
 * 避免 >2^53 的 64 位 tick 或纳秒在直接转 Number 时丢失精度。
 */
export function bigIntRatioPct(part: bigint, denom: bigint): number | null {
  if (denom <= 0n || part < 0n) {
    return null;
  }
  const scaled = (part * 1_000_000n + denom / 2n) / denom;
  return Number(scaled) / 10_000;
}

/**
 * 使用纯 BigInt 算术格式化 `total / count` 的定点小数均值字符串。
 */
export function formatBigIntMean(total: bigint, count: number, decimals = 2): string {
  if (count <= 0) {
    return '0';
  }
  const c = BigInt(count);
  const scale = 10n ** BigInt(decimals);
  const scaled = (total * scale + c / 2n) / c;
  const whole = scaled / scale;
  const frac = (scaled % scale).toString().padStart(decimals, '0');
  return decimals > 0 ? `${whole.toString()}.${frac}` : whole.toString();
}

function getSegmentBounds(
  seg: SegmentIndexMetadata,
  unit: TraceQueryTimeUnit,
): { start: bigint; end: bigint } | undefined {
  switch (unit) {
    case 'relative-ticks':
      return { start: BigInt(seg.minRelativeTicks), end: BigInt(seg.maxRelativeTicks) };
    case 'relative-ns': {
      if (!seg.sysFreqHz || seg.sysFreqHz <= 0) return undefined;
      const f = seg.sysFreqHz;
      return {
        start: ticksToNsBigInt(BigInt(seg.minRelativeTicks), f),
        end: ticksToNsBigInt(BigInt(seg.maxRelativeTicks), f),
      };
    }
    case 'absolute-ticks':
      if (seg.timeAnchorStatus === 'unanchored' || seg.firstAbsoluteTicks === undefined || seg.lastAbsoluteTicks === undefined) {
        return undefined;
      }
      return { start: BigInt(seg.firstAbsoluteTicks), end: BigInt(seg.lastAbsoluteTicks) };
    case 'ns': {
      if (seg.timeAnchorStatus === 'unanchored') return undefined;
      if (seg.minNs !== undefined && seg.maxNs !== undefined) {
        return { start: BigInt(seg.minNs), end: BigInt(seg.maxNs) };
      }
      if (seg.firstAbsoluteTicks !== undefined && seg.lastAbsoluteTicks !== undefined && seg.sysFreqHz && seg.sysFreqHz > 0) {
        return {
          start: ticksToNsBigInt(BigInt(seg.firstAbsoluteTicks), seg.sysFreqHz),
          end: ticksToNsBigInt(BigInt(seg.lastAbsoluteTicks), seg.sysFreqHz),
        };
      }
      return undefined;
    }
    case 'byte-offset':
      return {
        start: BigInt(seg.startByteOffset),
        end: BigInt(seg.endByteOffset ?? seg.startByteOffset),
      };
  }
}

interface ResolvedGapWindowMatch {
  readonly gap: StoredGapEntry;
  readonly gs: bigint;
  readonly ge: bigint;
  readonly positionKind: 'between-segments' | 'segment-start' | 'segment-end';
}

function resolveWindowGaps(
  segments: readonly SegmentIndexMetadata[],
  gaps: readonly StoredGapEntry[],
  unit: TraceQueryTimeUnit,
  qStart: bigint,
  qEnd: bigint,
  bootGeneration?: number,
  segmentId?: number,
): ResolvedGapWindowMatch[] {
  const segsByBoot = new Map<number, SegmentIndexMetadata[]>();
  for (const s of segments) {
    if (bootGeneration !== undefined && s.bootGeneration !== bootGeneration) continue;
    let list = segsByBoot.get(s.bootGeneration);
    if (!list) {
      list = [];
      segsByBoot.set(s.bootGeneration, list);
    }
    list.push(s);
  }
  for (const list of segsByBoot.values()) {
    list.sort((a, b) => a.segmentId - b.segmentId);
  }

  const matches: ResolvedGapWindowMatch[] = [];
  for (const g of gaps) {
    if (g.kind === 'eof' || g.kind === 'trace-stop') continue;
    if (bootGeneration !== undefined && g.bootGeneration !== bootGeneration) continue;
    const bootSegs = segsByBoot.get(g.bootGeneration);
    if (!bootSegs || bootSegs.length === 0) continue;

    let gs: bigint;
    let ge: bigint;
    let positionKind: 'between-segments' | 'segment-start' | 'segment-end';

    if (g.segmentIdBefore === undefined) {
      const targetSeg = segmentId !== undefined
        ? bootSegs.find(s => s.segmentId === segmentId)
        : bootSegs[0];
      if (!targetSeg || (segmentId !== undefined && targetSeg.segmentId !== bootSegs[0].segmentId)) continue;
      const b = getSegmentBounds(targetSeg, unit);
      if (!b) continue;
      gs = b.start;
      ge = b.start;
      positionKind = 'segment-start';
    } else {
      const idx = bootSegs.findIndex(s => s.segmentId === g.segmentIdBefore);
      const segBefore = idx >= 0 ? bootSegs[idx] : undefined;
      const segAfter = idx >= 0 && idx + 1 < bootSegs.length ? bootSegs[idx + 1] : undefined;

      if (segmentId !== undefined) {
        if (g.segmentIdBefore === segmentId && segBefore) {
          const b = getSegmentBounds(segBefore, unit);
          if (!b) continue;
          gs = b.end;
          ge = b.end;
          positionKind = 'segment-end';
        } else if (segAfter && segAfter.segmentId === segmentId) {
          const b = getSegmentBounds(segAfter, unit);
          if (!b) continue;
          gs = b.start;
          ge = b.start;
          positionKind = 'segment-start';
        } else {
          continue;
        }
      } else {
        if (!segBefore) continue;
        const bBefore = getSegmentBounds(segBefore, unit);
        if (!bBefore) continue;
        const bAfter = segAfter ? getSegmentBounds(segAfter, unit) : undefined;
        if (bAfter && bAfter.start >= bBefore.end) {
          gs = bBefore.end;
          ge = bAfter.start;
          positionKind = 'between-segments';
        } else {
          gs = bBefore.end;
          ge = bBefore.end;
          positionKind = 'segment-end';
        }
      }
    }

    const overlaps =
      ge > gs
        ? gs < qEnd && ge > qStart
        : positionKind === 'segment-end'
          ? gs > qStart && gs <= qEnd
          : gs >= qStart && gs < qEnd;
    if (overlaps) {
      matches.push({ gap: g, gs, ge, positionKind });
    }
  }
  return matches;
}

interface DurationAccumulator {
  count: number;
  total: bigint;
  min?: bigint;
  max?: bigint;
}

function recordDuration(acc: DurationAccumulator, val: bigint): void {
  acc.count += 1;
  acc.total += val;
  if (acc.min === undefined || val < acc.min) acc.min = val;
  if (acc.max === undefined || val > acc.max) acc.max = val;
}

function finalizeDurationStats(acc: DurationAccumulator): TraceDurationStats | undefined {
  if (acc.count === 0 || acc.min === undefined || acc.max === undefined) {
    return undefined;
  }
  const floor = acc.total / BigInt(acc.count);
  return {
    count: acc.count,
    total: acc.total.toString(),
    min: acc.min.toString(),
    max: acc.max.toString(),
    avg: formatBigIntMean(acc.total, acc.count, 2),
    avgFloor: floor.toString(),
  };
}

interface MutableContextAcc {
  contextKind: ExecutionContextKind | 'timer';
  contextKey: string;
  taskInstanceId?: string;
  tcbAddress?: number;
  taskGeneration?: number;
  irqId?: number;
  timerId?: number;
  label?: string;
  labelSource: LabelSource;
  cpuAccounted: boolean;
  clippedExclusiveDuration: bigint;
  clippedSliceCount: number;
  completeActivationCount: number;
  boundaryActivationCount: number;
  incompleteActivationCount: number;
  exclusiveAcc: DurationAccumulator;
  inclusiveAcc: DurationAccumulator;
  preemptedTotalDuration: bigint;
  preemptionCountTotal: number;
  readyCompleteCount: number;
  readyBoundaryCount: number;
  readyRemovedCount: number;
  readyIncompleteCount: number;
  readyAcc: DurationAccumulator;
}

interface MutableMarkerAcc {
  markerId: number;
  name?: string;
  nameSource: LabelSource;
  completeCount: number;
  boundaryCount: number;
  incompleteCount: number;
  pointCount: number;
  uncertainPointCount: number;
  durationAcc: DurationAccumulator;
  contextKeys: Set<string>;
}

interface MutableBinAcc {
  bStart: bigint;
  bEnd: bigint;
  task: bigint;
  isr: bigint;
  scheduler: bigint;
  idle: bigint;
  hasGap: boolean;
  gapKinds: Set<string>;
  hasIncomplete: boolean;
  hasUncertain: boolean;
  contextTicks: Map<string, { contextKind: ExecutionContextKind; label?: string; duration: bigint }>;
}

function buildEmptyBins(qStart: bigint, qEnd: bigint, binCount: number): MutableBinAcc[] {
  const span = qEnd - qStart;
  return Array.from({ length: binCount }, (_, idx) => {
    const bStart = qStart + (span * BigInt(idx)) / BigInt(binCount);
    const bEnd = idx === binCount - 1 ? qEnd : qStart + (span * BigInt(idx + 1)) / BigInt(binCount);
    return {
      bStart,
      bEnd,
      task: 0n,
      isr: 0n,
      scheduler: 0n,
      idle: 0n,
      hasGap: false,
      gapKinds: new Set<string>(),
      hasIncomplete: false,
      hasUncertain: false,
      contextTicks: new Map(),
    };
  });
}

function distributeToBins(
  bins: MutableBinAcc[],
  qStart: bigint,
  qEnd: bigint,
  cs: bigint,
  ce: bigint,
  cb: (bin: MutableBinAcc, overlap: bigint) => void,
): void {
  if (bins.length === 0 || ce <= cs || ce <= qStart || cs >= qEnd) {
    return;
  }
  const span = qEnd - qStart;
  const n = BigInt(bins.length);
  const clampedStart = cs < qStart ? qStart : cs;
  const clampedEnd = ce > qEnd ? qEnd : ce;
  if (clampedEnd <= clampedStart) return;

  let i0 = Number(((clampedStart - qStart) * n) / span);
  let i1 = Number(((clampedEnd - qStart) * n) / span);
  if (i0 < 0) i0 = 0;
  if (i0 >= bins.length) i0 = bins.length - 1;
  if (i1 < i0) i1 = i0;
  if (i1 >= bins.length) i1 = bins.length - 1;

  for (let i = i0; i <= i1; i++) {
    const bin = bins[i];
    const os = clampedStart > bin.bStart ? clampedStart : bin.bStart;
    const oe = clampedEnd < bin.bEnd ? clampedEnd : bin.bEnd;
    if (oe > os) {
      cb(bin, oe - os);
    }
  }
}

function markPointOnBin(
  bins: MutableBinAcc[],
  qStart: bigint,
  qEnd: bigint,
  t: bigint,
  cb: (bin: MutableBinAcc) => void,
): void {
  if (bins.length === 0 || t < qStart || t >= qEnd) return;
  const span = qEnd - qStart;
  const idx = Math.min(bins.length - 1, Math.max(0, Number(((t - qStart) * BigInt(bins.length)) / span)));
  cb(bins[idx]);
}

function getLodSummaryBoundsForAnalysis(
  sum: PageLodSummary,
  unit: TraceQueryTimeUnit,
): { min: bigint; max: bigint } | undefined {
  switch (unit) {
    case 'relative-ticks':
      return { min: BigInt(sum.minRelativeTicks), max: BigInt(sum.maxRelativeTicks) };
    case 'absolute-ticks':
      if (sum.minAbsoluteTicks === undefined || sum.maxAbsoluteTicks === undefined) return undefined;
      return { min: BigInt(sum.minAbsoluteTicks), max: BigInt(sum.maxAbsoluteTicks) };
    case 'ns':
      if (sum.minNs !== undefined && sum.maxNs !== undefined) {
        return { min: BigInt(sum.minNs), max: BigInt(sum.maxNs) };
      }
      if (sum.minAbsoluteTicks !== undefined && sum.maxAbsoluteTicks !== undefined && sum.sysFreqHz && sum.sysFreqHz > 0) {
        return {
          min: ticksToNsBigInt(BigInt(sum.minAbsoluteTicks), sum.sysFreqHz),
          max: ticksToNsBigInt(BigInt(sum.maxAbsoluteTicks), sum.sysFreqHz),
        };
      }
      return undefined;
    case 'relative-ns':
      if (!sum.sysFreqHz || sum.sysFreqHz <= 0) return undefined;
      return {
        min: ticksToNsBigInt(BigInt(sum.minRelativeTicks), sum.sysFreqHz),
        max: ticksToNsBigInt(BigInt(sum.maxRelativeTicks), sum.sysFreqHz),
      };
    case 'byte-offset':
      return undefined;
  }
}

function isCompletelyInsideWindow(s: bigint, e: bigint, qStart: bigint, qEnd: bigint): boolean {
  if (e > s) {
    return s >= qStart && e <= qEnd;
  }
  return s >= qStart && s < qEnd;
}

function intersectsWindowInterval(
  s: bigint | undefined,
  e: bigint | undefined,
  obs: bigint | undefined,
  qStart: bigint,
  qEnd: bigint,
): boolean {
  const effEnd = e ?? obs;
  if (s !== undefined && effEnd !== undefined && effEnd > s) {
    return s < qEnd && effEnd > qStart;
  }
  if (s !== undefined) {
    return s >= qStart && s < qEnd;
  }
  if (obs !== undefined) {
    return obs >= qStart && obs < qEnd;
  }
  return false;
}

function finalizeBin(bin: MutableBinAcc, binIndex: number): { bin: TraceCpuLoadBin; overlap: boolean } {
  const duration = bin.bEnd > bin.bStart ? bin.bEnd - bin.bStart : 0n;
  const active = bin.task + bin.isr + bin.scheduler;
  const rawKnown = active + bin.idle;
  const overlap = rawKnown > duration;
  const unknown = overlap ? 0n : duration - rawKnown;
  const known = overlap ? duration : rawKnown;

  let dominant: TraceCpuLoadBin['dominantContext'];
  let bestDur = -1n;
  for (const [ctxKey, info] of bin.contextTicks.entries()) {
    if (info.duration > bestDur) {
      bestDur = info.duration;
      dominant = {
        contextKind: info.contextKind,
        contextKey: ctxKey,
        label: info.label,
        duration: info.duration.toString(),
      };
    }
  }

  return {
    overlap,
    bin: {
      binIndex,
      start: bin.bStart.toString(),
      end: bin.bEnd.toString(),
      duration: duration.toString(),
      taskDuration: bin.task.toString(),
      isrDuration: bin.isr.toString(),
      schedulerDuration: bin.scheduler.toString(),
      idleDuration: bin.idle.toString(),
      unknownDuration: unknown.toString(),
      activeDuration: active.toString(),
      knownDuration: known.toString(),
      activeWindowPct: bigIntRatioPct(active, duration),
      activeKnownPct: bigIntRatioPct(active, known),
      isrWindowPct: bigIntRatioPct(bin.isr, duration),
      idleWindowPct: bigIntRatioPct(bin.idle, duration),
      unknownWindowPct: bigIntRatioPct(unknown, duration),
      hasGap: bin.hasGap,
      gapKinds: Array.from(bin.gapKinds),
      hasIncomplete: bin.hasIncomplete,
      hasUncertain: bin.hasUncertain,
      ...(dominant ? { dominantContext: dominant } : {}),
    },
  };
}

/**
 * 在 Worker 内执行有界、可取消的上下文统计、Ready 延迟、基础 Marker 统计与 CPU Load 分箱聚合（阶段 5.1）。
 */
export async function computeTraceAnalysis(
  host: TraceAnalysisExecutionHost,
  request: TraceAnalysisQueryRequest,
  qStart: bigint,
  qEnd: bigint,
): Promise<{ ok: true; data: TraceAnalysisQueryResult } | { ok: false; cancelled: true }> {
  const unit = request.unit;
  const includeCpuLoad = request.includeCpuLoad !== false;
  const includeContexts = request.includeContexts !== false;
  const includeMarkers = request.includeMarkers !== false;
  const maxBins = Math.max(1, Math.min(HARD_MAX_BINS, request.maxBins ?? DEFAULT_MAX_BINS));
  const maxContexts = Math.max(1, Math.min(HARD_MAX_CONTEXTS, request.maxContexts ?? DEFAULT_MAX_CONTEXTS));
  const maxMarkers = Math.max(1, Math.min(HARD_MAX_MARKERS, request.maxMarkers ?? DEFAULT_MAX_MARKERS));
  const maxCandidatePages = Math.max(1, request.maxCandidatePages ?? DEFAULT_MAX_CANDIDATE_PAGES);
  const yieldEveryPages = host.yieldEveryPages ?? 2;
  const yieldEveryItems = host.yieldEveryItems ?? 512;

  const cacheBefore = host.getCacheStats();
  const allSegments = host.index.getSegments();
  const allGaps = host.index.getGaps();

  const { partitions: rawPartitions, skippedUnanchoredSegments, skippedNoFrequencySegments } =
    host.index.getMatchingPartitions({
      bootGeneration: request.bootGeneration,
      segmentId: request.segmentId,
      unit,
      start: qStart,
      end: qEnd,
    });

  const span = qEnd > qStart ? qEnd - qStart : 0n;
  const timeDomainWarnings: string[] = [];
  let timeDomainJump = false;

  // Boot 隔离：未显式指定 bootGeneration 时仅保留最新启动代次，防止跨复位叠加
  const distinctBoots = Array.from(new Set(rawPartitions.map(p => p.meta.bootGeneration))).sort((a, b) => a - b);
  const excludedBootGenerations: number[] = [];
  let activeBoot = request.bootGeneration;
  let scopedPartitions = rawPartitions;
  if (activeBoot === undefined && distinctBoots.length > 1) {
    activeBoot = distinctBoots[distinctBoots.length - 1];
    for (const b of distinctBoots) {
      if (b !== activeBoot) excludedBootGenerations.push(b);
    }
    scopedPartitions = rawPartitions.filter(p => p.meta.bootGeneration === activeBoot);
    timeDomainJump = true;
    timeDomainWarnings.push(`检测到多个启动代次 (${distinctBoots.join(', ')})，已隔离并仅统计最新 boot ${activeBoot}`);
  } else if (distinctBoots.length === 1) {
    activeBoot = distinctBoots[0];
  }

  const verifiableSegments: TraceVerifiableSegmentInfo[] = [];
  for (const p of scopedPartitions) {
    const b = getSegmentBounds(p.meta, unit);
    if (b) {
      verifiableSegments.push({
        bootGeneration: p.meta.bootGeneration,
        segmentId: p.meta.segmentId,
        reliability: p.meta.reliability,
        timeAnchorStatus: p.meta.timeAnchorStatus,
        sysFreqHz: p.meta.sysFreqHz,
        start: b.start.toString(),
        end: b.end.toString(),
      });
    }
  }
  verifiableSegments.sort((a, b) => (a.bootGeneration - b.bootGeneration) || (a.segmentId - b.segmentId));

  const buildUnavailableResult = (
    reason: string,
    precision: TraceAnalysisPrecision = 'unavailable',
    gapsInWindow: readonly StoredGapEntry[] = [],
  ): TraceAnalysisQueryResult => {
    const binCount = span > 0n ? (span < BigInt(maxBins) ? Number(span) : maxBins) : 0;
    const emptyBins = binCount > 0 ? buildEmptyBins(qStart, qEnd, binCount) : [];
    for (const g of resolveWindowGaps(allSegments, allGaps, unit, qStart, qEnd, activeBoot, request.segmentId)) {
      if (g.ge > g.gs) {
        distributeToBins(emptyBins, qStart, qEnd, g.gs, g.ge, bin => {
          bin.hasGap = true;
          bin.gapKinds.add(g.gap.kind);
        });
      } else {
        const pt = g.gs >= qEnd && qEnd > qStart ? qEnd - 1n : g.gs;
        markPointOnBin(emptyBins, qStart, qEnd, pt, bin => {
          bin.hasGap = true;
          bin.gapKinds.add(g.gap.kind);
        });
      }
    }
    const cacheAfter = host.getCacheStats();
    return {
      unit,
      start: qStart.toString(),
      end: qEnd.toString(),
      windowDuration: span.toString(),
      precision,
      verifiable: false,
      verifiableReason: reason,
      timeDomainJump,
      timeDomainWarnings,
      skippedUnanchoredSegments,
      skippedNoFrequencySegments,
      excludedBootGenerations,
      verifiableSegments,
      gapsInWindow,
      totals: {
        taskDuration: '0',
        isrDuration: '0',
        schedulerDuration: '0',
        idleDuration: '0',
        unknownDuration: span.toString(),
        activeDuration: '0',
        knownDuration: '0',
        activeWindowPct: span > 0n ? 0 : null,
        activeKnownPct: null,
        unknownWindowPct: span > 0n ? 100 : null,
        excludedIncompleteSlices: 0,
        excludedUncertainSlices: 0,
        excludedIncompleteActivations: 0,
        excludedIncompleteReadyWaits: 0,
        excludedIncompleteMarkers: 0,
        sliceOverlapDetected: false,
      },
      bins: includeCpuLoad ? emptyBins.map((b, idx) => finalizeBin(b, idx).bin) : [],
      contexts: [],
      contextsTruncated: false,
      markers: [],
      markersTruncated: false,
      candidatePagesScanned: 0,
      cacheHits: cacheAfter.hits - cacheBefore.hits,
      cacheMisses: cacheAfter.misses - cacheBefore.misses,
    };
  };

  if (qStart >= qEnd) {
    return { ok: true, data: buildUnavailableResult('选区长度为零或反向，无法统计时间范围') };
  }

  if (scopedPartitions.length === 0) {
    const reason = skippedUnanchoredSegments.length > 0
      ? `所选时间段缺少 SYSTIME_CYCLES 绝对时间锚点（已跳过 Seg ${skippedUnanchoredSegments.join(', ')}）`
      : skippedNoFrequencySegments.length > 0
        ? `所选时间段缺少系统时钟频率 sysFreqHz（已跳过 Seg ${skippedNoFrequencySegments.join(', ')}）`
        : '当前录制或选定范围内没有可验证的已解码时间段';
    return { ok: true, data: buildUnavailableResult(reason) };
  }

  const windowGapMatches = resolveWindowGaps(allSegments, allGaps, unit, qStart, qEnd, activeBoot, request.segmentId);
  const gapsInWindow = windowGapMatches.map(m => m.gap);

  // 多段相对时间冲突检查（每个段 relativeTicks 均从 0 起算）
  if ((unit === 'relative-ticks' || unit === 'relative-ns') && request.segmentId === undefined && scopedPartitions.length > 1) {
    timeDomainJump = true;
    const msg = '多段相对时间均从 0 起算，禁止跨段混合统计；请选择单个 Segment 或切换至 ns / absolute-ticks';
    timeDomainWarnings.push(msg);
    return { ok: true, data: buildUnavailableResult(msg, 'unavailable', gapsInWindow) };
  }

  // 检查时钟频率跳变与段间单调重叠
  const sortedSegParts = [...scopedPartitions].sort((a, b) => a.meta.segmentId - b.meta.segmentId);
  const distinctFreqs = new Set<number>();
  let prevMax: bigint | undefined;
  for (const p of sortedSegParts) {
    if (p.meta.sysFreqHz && p.meta.sysFreqHz > 0) {
      distinctFreqs.add(p.meta.sysFreqHz);
    }
    const b = getSegmentBounds(p.meta, unit);
    if (b) {
      if (prevMax !== undefined && b.start < prevMax) {
        timeDomainJump = true;
        const msg = `时间域跳变：段 Seg #${p.meta.segmentId} 起点 (${b.start}) 早于前一段终点 (${prevMax})，不可直接跨段叠加`;
        timeDomainWarnings.push(msg);
        return { ok: true, data: buildUnavailableResult(msg, 'unavailable', gapsInWindow) };
      }
      if (b.end > (prevMax ?? b.start)) {
        prevMax = b.end;
      }
    }
  }

  if (distinctFreqs.size > 1) {
    timeDomainJump = true;
    const freqsText = Array.from(distinctFreqs).join(' Hz → ');
    if (unit === 'absolute-ticks') {
      const msg = `时间域跳变：时钟频率发生变化 (${freqsText} Hz)，不同频率的 ticks 不可直接合并；请切换至 ns 或选择单一时间段`;
      timeDomainWarnings.push(msg);
      return { ok: true, data: buildUnavailableResult(msg, 'unavailable', gapsInWindow) };
    }
    timeDomainWarnings.push(`窗口跨越时钟频率变化 (${freqsText} Hz)，已按各段各自频率换算为 ns`);
  }

  if (skippedUnanchoredSegments.length > 0) {
    timeDomainWarnings.push(`已排除 ${skippedUnanchoredSegments.length} 个未锚定绝对时间的段 (Seg ${skippedUnanchoredSegments.join(', ')})`);
  }
  if (skippedNoFrequencySegments.length > 0) {
    timeDomainWarnings.push(`已排除 ${skippedNoFrequencySegments.length} 个缺少时钟频率的段 (Seg ${skippedNoFrequencySegments.join(', ')})`);
  }
  if (gapsInWindow.length > 0) {
    timeDomainWarnings.push(`窗口包含或紧邻 ${gapsInWindow.length} 处录制缺口，缺口区间计入 unknown（不计为空闲）`);
  }

  const binCount = span < BigInt(maxBins) ? Number(span) : maxBins;
  const bins = includeCpuLoad ? buildEmptyBins(qStart, qEnd, binCount) : [];
  for (const g of windowGapMatches) {
    if (g.ge > g.gs) {
      distributeToBins(bins, qStart, qEnd, g.gs, g.ge, bin => {
        bin.hasGap = true;
        bin.gapKinds.add(g.gap.kind);
      });
    } else {
      const pt = g.gs >= qEnd && qEnd > qStart ? qEnd - 1n : g.gs;
      markPointOnBin(bins, qStart, qEnd, pt, bin => {
        bin.hasGap = true;
        bin.gapKinds.add(g.gap.kind);
      });
    }
  }

  // 收集候选页以校验预算
  const targetKinds: TracePageKind[] = [];
  if (includeCpuLoad || includeContexts) {
    targetKinds.push('slices', 'longSlices');
  }
  if (includeContexts) {
    targetKinds.push('activations', 'longActivations', 'readyWaits', 'longReadyWaits');
  }
  if (includeMarkers) {
    targetKinds.push('markers', 'longMarkers', 'markerPoints');
  }

  const candidatePlan: Array<{
    part: (typeof sortedSegParts)[number];
    kind: TracePageKind;
    pages: IndexedPageDescriptor[];
  }> = [];
  let totalCandidatePages = 0;

  for (const part of sortedSegParts) {
    if (host.isCancelled()) {
      return { ok: false, cancelled: true };
    }
    for (const kind of targetKinds) {
      const pages = await host.index.findCandidatePages(part, kind, unit, qStart, qEnd);
      if (pages.length > 0) {
        candidatePlan.push({ part, kind, pages });
        totalCandidatePages += pages.length;
      }
    }
  }

  // 候选页超出预算时降级为页级 LOD 近似分箱（显式标 approx，绝不谎称 exact）
  if (totalCandidatePages > maxCandidatePages) {
    let lodTask = 0n;
    let lodIsr = 0n;
    let lodSched = 0n;
    let lodIdle = 0n;
    let hasKnownLodSummary = false;

    for (let pIdx = 0; pIdx < sortedSegParts.length; pIdx++) {
      const part = sortedSegParts[pIdx];
      if (part.meta.reliability === 'uncertain') {
        for (const bin of bins) bin.hasUncertain = true;
        continue;
      }
      for (let sIdx = 0; sIdx < part.lodSummaries.length; sIdx++) {
        if (sIdx > 0 && sIdx % 256 === 0) {
          await host.yieldToLoop();
          if (host.isCancelled()) return { ok: false, cancelled: true };
        }
        const sum = part.lodSummaries[sIdx];
        if (sum.kind !== 'slices' && sum.kind !== 'longSlices') continue;
        if (!sum.sliceTicksByKind) continue;
        const bounds = getLodSummaryBoundsForAnalysis(sum, unit);
        if (!bounds || bounds.max <= bounds.min) continue;
        hasKnownLodSummary = true;
        const dur = bounds.max - bounds.min;
        const taskSum = BigInt(sum.sliceTicksByKind.task);
        const isrSum = BigInt(sum.sliceTicksByKind.isr);
        const idleSum = BigInt(sum.sliceTicksByKind.idle);
        const schedSum = BigInt(sum.sliceTicksByKind.scheduler);
        const cs = bounds.min > qStart ? bounds.min : qStart;
        const ce = bounds.max < qEnd ? bounds.max : qEnd;
        if (ce > cs) {
          const share = ce - cs;
          lodTask += (taskSum * share) / dur;
          lodIsr += (isrSum * share) / dur;
          lodIdle += (idleSum * share) / dur;
          lodSched += (schedSum * share) / dur;
          distributeToBins(bins, qStart, qEnd, cs, ce, (bin, overlap) => {
            if (sum.hasIncomplete) bin.hasIncomplete = true;
            if (sum.hasUncertain) bin.hasUncertain = true;
            bin.task += (taskSum * overlap) / dur;
            bin.isr += (isrSum * overlap) / dur;
            bin.scheduler += (schedSum * overlap) / dur;
            bin.idle += (idleSum * overlap) / dur;
          });
        }
      }
    }

    const finalizedBins: TraceCpuLoadBin[] = [];
    let overlapDetected = false;
    for (let i = 0; i < bins.length; i++) {
      const res = finalizeBin(bins[i], i);
      if (res.overlap) overlapDetected = true;
      finalizedBins.push(res.bin);
    }
    const active = lodTask + lodIsr + lodSched;
    const rawKnown = active + lodIdle;
    if (rawKnown > span) overlapDetected = true;
    const known = rawKnown > span ? span : rawKnown;
    const unknown = span - known;
    const cacheAfter = host.getCacheStats();

    return {
      ok: true,
      data: {
        unit,
        start: qStart.toString(),
        end: qEnd.toString(),
        windowDuration: span.toString(),
        precision: 'approx',
        approxReason: hasKnownLodSummary
          ? `候选页数 (${totalCandidatePages}) 超过精确聚合预算 (${maxCandidatePages})，CPU Load 已退化为页级 LOD 近似分箱，Contexts/Markers 明细需缩小时间范围`
          : `候选页数 (${totalCandidatePages}) 超过精确聚合预算 (${maxCandidatePages})，且当前重开归档缺少页级 CPU 摘要，请缩小时间范围以执行精确聚合`,
        verifiable: hasKnownLodSummary,
        verifiableReason: hasKnownLodSummary ? undefined : '超出页预算且无页级摘要，无法验证分箱 CPU 占比',
        timeDomainJump,
        timeDomainWarnings,
        skippedUnanchoredSegments,
        skippedNoFrequencySegments,
        excludedBootGenerations,
        verifiableSegments,
        gapsInWindow,
        totals: {
          taskDuration: lodTask.toString(),
          isrDuration: lodIsr.toString(),
          schedulerDuration: lodSched.toString(),
          idleDuration: lodIdle.toString(),
          unknownDuration: unknown.toString(),
          activeDuration: active.toString(),
          knownDuration: known.toString(),
          activeWindowPct: bigIntRatioPct(active, span),
          activeKnownPct: bigIntRatioPct(active, known),
          unknownWindowPct: bigIntRatioPct(unknown, span),
          excludedIncompleteSlices: 0,
          excludedUncertainSlices: 0,
          excludedIncompleteActivations: 0,
          excludedIncompleteReadyWaits: 0,
          excludedIncompleteMarkers: 0,
          sliceOverlapDetected: overlapDetected,
        },
        bins: finalizedBins,
        contexts: [],
        contextsTruncated: true,
        markers: [],
        markersTruncated: true,
        candidatePagesScanned: 0,
        cacheHits: cacheAfter.hits - cacheBefore.hits,
        cacheMisses: cacheAfter.misses - cacheBefore.misses,
      },
    };
  }

  // -------------------------------------------------------------------------
  // 精确单遍流式聚合
  // -------------------------------------------------------------------------
  const contextMap = new Map<string, MutableContextAcc>();
  const markerMap = new Map<number, MutableMarkerAcc>();
  const internalContextCap = Math.max(maxContexts * 4, 2048);
  const internalMarkerCap = Math.max(maxMarkers * 4, 2048);
  let contextsMapCapped = false;
  let markersMapCapped = false;

  const ensureContext = (init: {
    contextKind: ExecutionContextKind | 'timer';
    contextKey: string;
    taskInstanceId?: string;
    tcbAddress?: number;
    taskGeneration?: number;
    irqId?: number;
    timerId?: number;
    label?: string;
    labelSource: LabelSource;
    cpuAccounted: boolean;
  }): MutableContextAcc | undefined => {
    const existing = contextMap.get(init.contextKey);
    if (existing) {
      if (init.label && init.labelSource !== 'missing' && (existing.labelSource === 'missing' || !existing.label)) {
        existing.label = init.label;
        existing.labelSource = init.labelSource;
      }
      if (existing.tcbAddress === undefined && init.tcbAddress !== undefined) {
        existing.tcbAddress = init.tcbAddress;
      }
      if (existing.taskGeneration === undefined && init.taskGeneration !== undefined) {
        existing.taskGeneration = init.taskGeneration;
      }
      if (existing.irqId === undefined && init.irqId !== undefined) {
        existing.irqId = init.irqId;
      }
      if (existing.timerId === undefined && init.timerId !== undefined) {
        existing.timerId = init.timerId;
      }
      return existing;
    }
    if (contextMap.size >= internalContextCap) {
      contextsMapCapped = true;
      return undefined;
    }
    const created: MutableContextAcc = {
      contextKind: init.contextKind,
      contextKey: init.contextKey,
      taskInstanceId: init.taskInstanceId,
      tcbAddress: init.tcbAddress,
      taskGeneration: init.taskGeneration,
      irqId: init.irqId,
      timerId: init.timerId,
      label: init.label,
      labelSource: init.labelSource,
      cpuAccounted: init.cpuAccounted,
      clippedExclusiveDuration: 0n,
      clippedSliceCount: 0,
      completeActivationCount: 0,
      boundaryActivationCount: 0,
      incompleteActivationCount: 0,
      exclusiveAcc: { count: 0, total: 0n },
      inclusiveAcc: { count: 0, total: 0n },
      preemptedTotalDuration: 0n,
      preemptionCountTotal: 0,
      readyCompleteCount: 0,
      readyBoundaryCount: 0,
      readyRemovedCount: 0,
      readyIncompleteCount: 0,
      readyAcc: { count: 0, total: 0n },
    };
    contextMap.set(init.contextKey, created);
    return created;
  };

  const ensureMarker = (
    markerId: number,
    name: string | undefined,
    nameSource: LabelSource,
  ): MutableMarkerAcc | undefined => {
    const existing = markerMap.get(markerId);
    if (existing) {
      if (name && nameSource !== 'missing' && (existing.nameSource === 'missing' || !existing.name)) {
        existing.name = name;
        existing.nameSource = nameSource;
      }
      return existing;
    }
    if (markerMap.size >= internalMarkerCap) {
      markersMapCapped = true;
      return undefined;
    }
    const created: MutableMarkerAcc = {
      markerId,
      name,
      nameSource,
      completeCount: 0,
      boundaryCount: 0,
      incompleteCount: 0,
      pointCount: 0,
      uncertainPointCount: 0,
      durationAcc: { count: 0, total: 0n },
      contextKeys: new Set<string>(),
    };
    markerMap.set(markerId, created);
    return created;
  };

  let totalTask = 0n;
  let totalIsr = 0n;
  let totalScheduler = 0n;
  let totalIdle = 0n;
  let excludedIncompleteSlices = 0;
  let excludedUncertainSlices = 0;
  let excludedIncompleteActivations = 0;
  let excludedIncompleteReadyWaits = 0;
  let excludedIncompleteMarkers = 0;
  let pagesScanned = 0;
  let itemsCheckedSinceYield = 0;

  for (const entry of candidatePlan) {
    const segMeta = entry.part.meta;
    const segFreq = segMeta.sysFreqHz;

    for (const desc of entry.pages) {
      if (host.isCancelled()) {
        return { ok: false, cancelled: true };
      }
      const page = await host.loadPage(desc);
      pagesScanned += 1;
      const items = page.items as readonly any[];

      for (let i = 0; i < items.length; i++) {
        itemsCheckedSinceYield += 1;
        if (itemsCheckedSinceYield >= yieldEveryItems) {
          itemsCheckedSinceYield = 0;
          await host.yieldToLoop();
          if (host.isCancelled()) {
            return { ok: false, cancelled: true };
          }
        }

        if (entry.kind === 'slices' || entry.kind === 'longSlices') {
          const sl = items[i] as ExecutionSliceInterval;
          const freq = sl.start?.sysFreqHz ?? sl.end?.sysFreqHz ?? sl.observedUntil?.sysFreqHz ?? segFreq;
          const s = getTimePointValueForUnit(sl.start, unit, freq);
          const e = getTimePointValueForUnit(sl.end, unit, freq);
          const obs = getTimePointValueForUnit(sl.observedUntil, unit, freq);

          if (!intersectsWindowInterval(s, e, obs, qStart, qEnd)) {
            continue;
          }

          if (sl.completeness !== 'complete' || sl.segmentReliability !== 'trusted' || s === undefined || e === undefined || e < s) {
            if (sl.completeness === 'uncertain' || sl.segmentReliability === 'uncertain') {
              excludedUncertainSlices += 1;
              if (s !== undefined && (e ?? obs) !== undefined && (e ?? obs)! > s) {
                distributeToBins(bins, qStart, qEnd, s, (e ?? obs)!, bin => { bin.hasUncertain = true; });
              } else {
                const pt = s ?? obs;
                if (pt !== undefined) markPointOnBin(bins, qStart, qEnd, pt, bin => { bin.hasUncertain = true; });
              }
            } else {
              excludedIncompleteSlices += 1;
              if (s !== undefined && (e ?? obs) !== undefined && (e ?? obs)! > s) {
                distributeToBins(bins, qStart, qEnd, s, (e ?? obs)!, bin => { bin.hasIncomplete = true; });
              } else {
                const pt = s ?? obs;
                if (pt !== undefined) markPointOnBin(bins, qStart, qEnd, pt, bin => { bin.hasIncomplete = true; });
              }
            }
            continue;
          }

          const cs = s > qStart ? s : qStart;
          const ce = e < qEnd ? e : qEnd;
          const overlap = ce > cs ? ce - cs : 0n;

          if (includeContexts) {
            const ctx = ensureContext({
              contextKind: sl.contextKind,
              contextKey: sl.contextKey,
              taskInstanceId: sl.taskInstanceId,
              tcbAddress: sl.tcbAddress,
              taskGeneration: sl.taskGeneration,
              irqId: sl.irqId,
              label: sl.label,
              labelSource: sl.labelSource,
              cpuAccounted: true,
            });
            if (ctx) {
              ctx.clippedExclusiveDuration += overlap;
              ctx.clippedSliceCount += 1;
            }
          }

          if (overlap > 0n) {
            if (sl.contextKind === 'task') totalTask += overlap;
            else if (sl.contextKind === 'isr') totalIsr += overlap;
            else if (sl.contextKind === 'scheduler') totalScheduler += overlap;
            else totalIdle += overlap;

            if (includeCpuLoad) {
              distributeToBins(bins, qStart, qEnd, cs, ce, (bin, binOverlap) => {
                if (sl.contextKind === 'task') bin.task += binOverlap;
                else if (sl.contextKind === 'isr') bin.isr += binOverlap;
                else if (sl.contextKind === 'scheduler') bin.scheduler += binOverlap;
                else bin.idle += binOverlap;

                const prev = bin.contextTicks.get(sl.contextKey);
                if (prev) {
                  prev.duration += binOverlap;
                  if (sl.label && !prev.label) prev.label = sl.label;
                } else if (bin.contextTicks.size < 256) {
                  bin.contextTicks.set(sl.contextKey, {
                    contextKind: sl.contextKind,
                    label: sl.label,
                    duration: binOverlap,
                  });
                }
              });
            }
          }
        } else if (entry.kind === 'activations' || entry.kind === 'longActivations') {
          const act = items[i] as ContextActivationInterval;
          const freq = act.start?.sysFreqHz ?? act.end?.sysFreqHz ?? act.observedUntil?.sysFreqHz ?? segFreq;
          const s = getTimePointValueForUnit(act.start, unit, freq);
          const e = getTimePointValueForUnit(act.end, unit, freq);
          const obs = getTimePointValueForUnit(act.observedUntil, unit, freq);

          if (!intersectsWindowInterval(s, e, obs, qStart, qEnd)) {
            continue;
          }

          const ctxKind: ExecutionContextKind | 'timer' = act.kind === 'task-exec' ? 'task' : act.kind;
          const ctx = ensureContext({
            contextKind: ctxKind,
            contextKey: act.contextKey,
            taskInstanceId: act.taskInstanceId,
            tcbAddress: act.tcbAddress,
            taskGeneration: act.taskGeneration,
            irqId: act.irqId,
            timerId: act.timerId,
            label: act.label,
            labelSource: act.labelSource,
            cpuAccounted: act.kind !== 'timer',
          });

          if (act.completeness !== 'complete' || act.segmentReliability !== 'trusted' || s === undefined || e === undefined || e < s) {
            excludedIncompleteActivations += 1;
            if (ctx) {
              ctx.incompleteActivationCount += 1;
              if (act.kind === 'task-exec' && act.readyChainStatus && act.readyChainStatus !== 'matched-ready') {
                ctx.readyIncompleteCount += 1;
              }
            }
            continue;
          }

          if (!isCompletelyInsideWindow(s, e, qStart, qEnd)) {
            if (ctx) ctx.boundaryActivationCount += 1;
            continue;
          }

          if (ctx) {
            ctx.completeActivationCount += 1;
            const inclusive = e - s;
            let exclusive: bigint;
            if (unit === 'relative-ticks' || unit === 'absolute-ticks') {
              exclusive = act.exclusiveDurationTicksBigInt ?? inclusive;
            } else if (act.preemptionCount === 0) {
              exclusive = inclusive;
            } else if (act.exclusiveDurationNs !== undefined) {
              exclusive = BigInt(act.exclusiveDurationNs);
            } else if (act.exclusiveDurationTicksBigInt !== undefined && freq && freq > 0) {
              exclusive = ticksToNsBigInt(act.exclusiveDurationTicksBigInt, freq);
            } else {
              exclusive = inclusive;
            }
            if (exclusive > inclusive) exclusive = inclusive;
            const preempted = inclusive - exclusive;
            recordDuration(ctx.inclusiveAcc, inclusive);
            recordDuration(ctx.exclusiveAcc, exclusive);
            ctx.preemptedTotalDuration += preempted;
            ctx.preemptionCountTotal += act.preemptionCount;
            if (act.kind === 'task-exec' && act.readyChainStatus && act.readyChainStatus !== 'matched-ready') {
              ctx.readyIncompleteCount += 1;
            }
          }
        } else if (entry.kind === 'readyWaits' || entry.kind === 'longReadyWaits') {
          const rw = items[i] as ReadyWaitInterval;
          const freq = rw.start?.sysFreqHz ?? rw.end?.sysFreqHz ?? rw.observedUntil?.sysFreqHz ?? segFreq;
          const s = getTimePointValueForUnit(rw.start, unit, freq);
          const e = getTimePointValueForUnit(rw.end, unit, freq);
          const obs = getTimePointValueForUnit(rw.observedUntil, unit, freq);

          if (!intersectsWindowInterval(s, e, obs, qStart, qEnd)) {
            continue;
          }

          const ctx = ensureContext({
            contextKind: 'task',
            contextKey: rw.taskInstanceId,
            taskInstanceId: rw.taskInstanceId,
            tcbAddress: rw.tcbAddress,
            taskGeneration: rw.taskGeneration,
            label: rw.label,
            labelSource: rw.labelSource,
            cpuAccounted: true,
          });

          if (rw.completeness !== 'complete' || rw.segmentReliability !== 'trusted' || rw.outcome === 'incomplete' || s === undefined || e === undefined || e < s) {
            excludedIncompleteReadyWaits += 1;
            if (ctx) ctx.readyIncompleteCount += 1;
            continue;
          }

          if (rw.outcome === 'removed-from-ready') {
            if (ctx) {
              if (isCompletelyInsideWindow(s, e, qStart, qEnd)) {
                ctx.readyRemovedCount += 1;
              } else {
                ctx.readyBoundaryCount += 1;
              }
            }
            continue;
          }

          if (!isCompletelyInsideWindow(s, e, qStart, qEnd)) {
            if (ctx) ctx.readyBoundaryCount += 1;
            continue;
          }

          if (ctx) {
            ctx.readyCompleteCount += 1;
            recordDuration(ctx.readyAcc, e - s);
          }
        } else if (entry.kind === 'markers' || entry.kind === 'longMarkers') {
          const mk = items[i] as MarkerInterval;
          const freq = mk.start?.sysFreqHz ?? mk.end?.sysFreqHz ?? mk.observedUntil?.sysFreqHz ?? segFreq;
          const s = getTimePointValueForUnit(mk.start, unit, freq);
          const e = getTimePointValueForUnit(mk.end, unit, freq);
          const obs = getTimePointValueForUnit(mk.observedUntil, unit, freq);

          if (!intersectsWindowInterval(s, e, obs, qStart, qEnd)) {
            continue;
          }

          const row = ensureMarker(mk.markerId, mk.name, mk.nameSource);
          if (row && mk.startContextKey && row.contextKeys.size < 8) {
            row.contextKeys.add(mk.startContextKey);
          }

          if (mk.completeness !== 'complete' || mk.segmentReliability !== 'trusted' || s === undefined || e === undefined || e < s) {
            excludedIncompleteMarkers += 1;
            if (row) row.incompleteCount += 1;
            continue;
          }

          if (!isCompletelyInsideWindow(s, e, qStart, qEnd)) {
            if (row) row.boundaryCount += 1;
            continue;
          }

          if (row) {
            row.completeCount += 1;
            recordDuration(row.durationAcc, e - s);
          }
        } else if (entry.kind === 'markerPoints') {
          const mp = items[i] as MarkerPointEvent;
          const freq = mp.time.sysFreqHz ?? segFreq;
          const t = getTimePointValueForUnit(mp.time, unit, freq);
          if (t === undefined || t < qStart || t >= qEnd) {
            continue;
          }
          const row = ensureMarker(mp.markerId, mp.name, mp.nameSource);
          if (row) {
            row.pointCount += 1;
            if (mp.segmentReliability === 'uncertain') {
              row.uncertainPointCount += 1;
            }
            if (mp.contextKey && row.contextKeys.size < 8) {
              row.contextKeys.add(mp.contextKey);
            }
          }
        }
      }

      if (pagesScanned % yieldEveryPages === 0) {
        await host.yieldToLoop();
        if (host.isCancelled()) {
          return { ok: false, cancelled: true };
        }
      }
    }
  }

  let sliceOverlapDetected = false;
  const finalizedBins: TraceCpuLoadBin[] = [];
  if (includeCpuLoad) {
    for (let i = 0; i < bins.length; i++) {
      const res = finalizeBin(bins[i], i);
      if (res.overlap) sliceOverlapDetected = true;
      finalizedBins.push(res.bin);
    }
  }

  const totalActive = totalTask + totalIsr + totalScheduler;
  const rawKnown = totalActive + totalIdle;
  if (rawKnown > span) {
    sliceOverlapDetected = true;
  }
  const totalKnown = rawKnown > span ? span : rawKnown;
  const totalUnknown = span - totalKnown;

  const contextRowsAll: TraceContextStatsRow[] = Array.from(contextMap.values()).map(acc => {
    const exclStats = finalizeDurationStats(acc.exclusiveAcc);
    const inclStats = finalizeDurationStats(acc.inclusiveAcc);
    const readyStats = finalizeDurationStats(acc.readyAcc);
    return {
      contextKind: acc.contextKind,
      contextKey: acc.contextKey,
      ...(acc.taskInstanceId !== undefined ? { taskInstanceId: acc.taskInstanceId } : {}),
      ...(acc.tcbAddress !== undefined ? { tcbAddress: acc.tcbAddress } : {}),
      ...(acc.taskGeneration !== undefined ? { taskGeneration: acc.taskGeneration } : {}),
      ...(acc.irqId !== undefined ? { irqId: acc.irqId } : {}),
      ...(acc.timerId !== undefined ? { timerId: acc.timerId } : {}),
      ...(acc.label !== undefined ? { label: acc.label } : {}),
      labelSource: acc.labelSource,
      cpuAccounted: acc.cpuAccounted,
      clippedExclusiveDuration: acc.clippedExclusiveDuration.toString(),
      windowPercent: acc.cpuAccounted ? bigIntRatioPct(acc.clippedExclusiveDuration, span) : null,
      knownPercent: acc.cpuAccounted ? bigIntRatioPct(acc.clippedExclusiveDuration, totalKnown) : null,
      clippedSliceCount: acc.clippedSliceCount,
      completeActivationCount: acc.completeActivationCount,
      boundaryActivationCount: acc.boundaryActivationCount,
      incompleteActivationCount: acc.incompleteActivationCount,
      ...(exclStats ? { exclusiveStats: exclStats } : {}),
      ...(inclStats ? { inclusiveStats: inclStats } : {}),
      preemptedTotalDuration: acc.preemptedTotalDuration.toString(),
      preemptionCountTotal: acc.preemptionCountTotal,
      readyCompleteCount: acc.readyCompleteCount,
      readyBoundaryCount: acc.readyBoundaryCount,
      readyRemovedCount: acc.readyRemovedCount,
      readyIncompleteCount: acc.readyIncompleteCount,
      ...(readyStats ? { readyStats } : {}),
    };
  });

  contextRowsAll.sort((a, b) => {
    const da = BigInt(a.clippedExclusiveDuration);
    const db = BigInt(b.clippedExclusiveDuration);
    if (da !== db) return db > da ? 1 : -1;
    if (a.completeActivationCount !== b.completeActivationCount) {
      return b.completeActivationCount - a.completeActivationCount;
    }
    return a.contextKey.localeCompare(b.contextKey);
  });

  const contextsTruncated = contextsMapCapped || contextRowsAll.length > maxContexts;
  const contexts = contextRowsAll.slice(0, maxContexts);

  const markerRowsAll: TraceMarkerStatsRow[] = Array.from(markerMap.values()).map(acc => {
    const durationStats = finalizeDurationStats(acc.durationAcc);
    return {
      markerId: acc.markerId,
      ...(acc.name !== undefined ? { name: acc.name } : {}),
      nameSource: acc.nameSource,
      completeCount: acc.completeCount,
      boundaryCount: acc.boundaryCount,
      incompleteCount: acc.incompleteCount,
      pointCount: acc.pointCount,
      uncertainPointCount: acc.uncertainPointCount,
      ...(durationStats ? { durationStats } : {}),
      contextKeys: Array.from(acc.contextKeys),
    };
  });

  markerRowsAll.sort((a, b) => {
    const ta = a.durationStats ? BigInt(a.durationStats.total) : -1n;
    const tb = b.durationStats ? BigInt(b.durationStats.total) : -1n;
    if (ta !== tb) return tb > ta ? 1 : -1;
    const ca = a.completeCount + a.pointCount;
    const cb = b.completeCount + b.pointCount;
    if (ca !== cb) return cb - ca;
    return a.markerId - b.markerId;
  });

  const markersTruncated = markersMapCapped || markerRowsAll.length > maxMarkers;
  const markers = markerRowsAll.slice(0, maxMarkers);

  const cacheAfter = host.getCacheStats();
  return {
    ok: true,
    data: {
      unit,
      start: qStart.toString(),
      end: qEnd.toString(),
      windowDuration: span.toString(),
      precision: 'exact',
      verifiable: true,
      timeDomainJump,
      timeDomainWarnings,
      skippedUnanchoredSegments,
      skippedNoFrequencySegments,
      excludedBootGenerations,
      verifiableSegments,
      gapsInWindow,
      totals: {
        taskDuration: totalTask.toString(),
        isrDuration: totalIsr.toString(),
        schedulerDuration: totalScheduler.toString(),
        idleDuration: totalIdle.toString(),
        unknownDuration: totalUnknown.toString(),
        activeDuration: totalActive.toString(),
        knownDuration: totalKnown.toString(),
        activeWindowPct: bigIntRatioPct(totalActive, span),
        activeKnownPct: bigIntRatioPct(totalActive, totalKnown),
        unknownWindowPct: bigIntRatioPct(totalUnknown, span),
        excludedIncompleteSlices,
        excludedUncertainSlices,
        excludedIncompleteActivations,
        excludedIncompleteReadyWaits,
        excludedIncompleteMarkers,
        sliceOverlapDetected,
      },
      bins: finalizedBins,
      contexts,
      contextsTruncated,
      markers,
      markersTruncated,
      candidatePagesScanned: pagesScanned,
      cacheHits: cacheAfter.hits - cacheBefore.hits,
      cacheMisses: cacheAfter.misses - cacheBefore.misses,
    },
  };
}
