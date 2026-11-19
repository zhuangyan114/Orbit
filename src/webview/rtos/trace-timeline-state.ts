import type { SegmentReliability, TimeAnchorStatus, TraceGapKind } from '../../trace/systemview-decoder';
import type { ExecutionContextKind, IntervalCompleteness, LabelSource, ReadyOutcome } from '../../trace/systemview-reconstructor';
import type { TraceAnalysisQueryResult, TraceContextStatsRow, TraceMarkerStatsRow } from '../../trace/trace-analytics';
import type { TraceEventDto } from '../../trace/systemview-formatter';
import type {
  TraceEventCategoryFilter,
  TraceEventLocateResult,
  TraceEventsQueryResult,
  TraceRecordingDiagnosticsResult,
  TraceTerminalLevelFilter,
  TraceTerminalQueryResult,
} from '../../trace/trace-events';
import type { TraceCaptureIntegrity, TraceFreezeEvidence, TraceRecordingMode, TraceRecordingState, TraceTargetState, TraceTransportAdequacy } from '../../trace/trace-recording-coordinator';

export type TraceTimeUnit = 'ns' | 'relative-ns' | 'absolute-ticks' | 'relative-ticks';
export type TraceRecordingSource = 'live' | 'session' | 'offline';
export type TraceAnalysisSourceKind = 'viewport' | 'selection' | 'full';
export type ContextStatsKindFilter = 'all' | 'task' | 'isr' | 'idle' | 'scheduler' | 'timer';
export type ContextStatsSortKey = 'cpu' | 'name' | 'activations' | 'exclMax' | 'readyMax' | 'readyAvg';

export interface TraceSegmentDto {
  readonly bootGeneration: number;
  readonly segmentId: number;
  readonly startByteOffset: number;
  readonly endByteOffset?: number;
  readonly reliability: SegmentReliability;
  readonly closed: boolean;
  readonly endReason?: string;
  readonly packetCount: number;
  readonly syncCount: number;
  readonly timestampBits: number;
  readonly timestampWrapCount: number;
  readonly timeAnchorStatus: TimeAnchorStatus;
  readonly minRelativeTicks: string;
  readonly maxRelativeTicks: string;
  readonly firstAbsoluteTicks?: string;
  readonly lastAbsoluteTicks?: string;
  readonly sysFreqHz?: number;
  readonly minNs?: string;
  readonly maxNs?: string;
}

export interface TraceGapDto {
  readonly seq: number;
  readonly bootGeneration: number;
  readonly kind: TraceGapKind | 'target-reset' | 'trace-stop' | 'eof' | 'metadata-reconfigured' | 'resync';
  readonly segmentIdBefore?: number;
  readonly byteOffset: number;
  readonly droppedPackets: number | 'unknown';
  readonly droppedBytes: number | 'unknown';
  readonly reason: string;
  readonly preservesFraming?: boolean;
  readonly closedOpenCount?: number;
}

export interface TraceGapAnchor {
  readonly gap: TraceGapDto;
  readonly start: string;
  readonly end: string;
  readonly afterSegmentId?: number;
  readonly beforeSegmentId?: number;
  readonly positionKind: 'between-segments' | 'segment-start' | 'segment-end';
}

export interface TraceSliceDto {
  readonly sliceId: string;
  readonly bootGeneration: number;
  readonly segmentId: number;
  readonly segmentReliability: SegmentReliability;
  readonly completeness: IntervalCompleteness;
  readonly contextKind: ExecutionContextKind;
  readonly contextKey: string;
  readonly taskInstanceId?: string;
  readonly tcbAddress?: number;
  readonly irqId?: number;
  readonly isrDepth: number;
  readonly label?: string;
  readonly labelSource: LabelSource;
  readonly startRelTicks: string;
  readonly endRelTicks: string;
  readonly startAbsTicks?: string;
  readonly endAbsTicks?: string;
  readonly startNs?: string;
  readonly endNs?: string;
  readonly sysFreqHz?: number;
  readonly durationTicks?: string;
  readonly durationNs?: string;
  readonly isEndObservedOnly: boolean;
  readonly timeDomain: 'anchored-ticks' | 'segment-relative-ticks' | 'unknown';
  readonly startReason: string;
  readonly endReason?: string;
  readonly streamByteOffset?: number;
}

export interface TraceActivationDto {
  readonly activationId: string;
  readonly bootGeneration: number;
  readonly segmentId: number;
  readonly segmentReliability: SegmentReliability;
  readonly completeness: IntervalCompleteness;
  readonly kind: 'task-exec' | 'isr' | 'timer';
  readonly contextKey: string;
  readonly taskInstanceId?: string;
  readonly irqId?: number;
  readonly isrDepth?: number;
  readonly timerId?: number;
  readonly label?: string;
  readonly labelSource: LabelSource;
  readonly startRelTicks: string;
  readonly endRelTicks: string;
  readonly startAbsTicks?: string;
  readonly endAbsTicks?: string;
  readonly startNs?: string;
  readonly endNs?: string;
  readonly sysFreqHz?: number;
  readonly inclusiveDurationTicks?: string;
  readonly exclusiveDurationTicks?: string;
  readonly preemptedDurationTicks?: string;
  readonly inclusiveDurationNs?: string;
  readonly exclusiveDurationNs?: string;
  readonly preemptionCount: number;
  readonly readyChainStatus?: string;
  readonly matchedReadyWaitId?: string;
  readonly isEndObservedOnly: boolean;
  readonly endReason?: string;
}

export interface TraceReadyWaitDto {
  readonly waitId: string;
  readonly bootGeneration: number;
  readonly segmentId: number;
  readonly segmentReliability: SegmentReliability;
  readonly completeness: IntervalCompleteness;
  readonly outcome: ReadyOutcome;
  readonly taskInstanceId: string;
  readonly tcbAddress?: number;
  readonly label?: string;
  readonly labelSource: LabelSource;
  readonly startRelTicks: string;
  readonly endRelTicks: string;
  readonly startAbsTicks?: string;
  readonly endAbsTicks?: string;
  readonly startNs?: string;
  readonly endNs?: string;
  readonly sysFreqHz?: number;
  readonly durationTicks?: string;
  readonly durationNs?: string;
  readonly readyToRunningTicks?: string;
  readonly stopCause?: number;
  readonly isEndObservedOnly: boolean;
  readonly endReason?: string;
}

export interface TraceMarkerDto {
  readonly markerInstanceId: string;
  readonly bootGeneration: number;
  readonly segmentId: number;
  readonly segmentReliability: SegmentReliability;
  readonly completeness: IntervalCompleteness;
  readonly markerId: number;
  readonly name?: string;
  readonly nameSource: LabelSource;
  readonly startRelTicks: string;
  readonly endRelTicks: string;
  readonly startAbsTicks?: string;
  readonly endAbsTicks?: string;
  readonly startNs?: string;
  readonly endNs?: string;
  readonly sysFreqHz?: number;
  readonly durationTicks?: string;
  readonly durationNs?: string;
  readonly startContextKey?: string;
  readonly endContextKey?: string;
  readonly isEndObservedOnly: boolean;
  readonly endReason?: string;
}

export interface TraceMarkerPointDto {
  readonly bootGeneration: number;
  readonly segmentId: number;
  readonly segmentReliability: SegmentReliability;
  readonly markerId: number;
  readonly name?: string;
  readonly nameSource: LabelSource;
  readonly relTicks: string;
  readonly absTicks?: string;
  readonly ns?: string;
  readonly sysFreqHz?: number;
  readonly contextKey?: string;
  readonly streamByteOffset: number;
}

export interface TracePacketSummaryDto {
  readonly packetIndexInSegment: number;
  readonly bootGeneration?: number;
  readonly segmentId: number;
  readonly eventId: number;
  readonly eventName: string;
  readonly relTicks: string;
  readonly absTicks?: string;
  readonly ns?: string;
  readonly sysFreqHz?: number;
  readonly streamByteOffset: number;
  readonly byteLength: number;
  readonly summary: string;
}

export interface TraceLodBucketDto {
  readonly bucketIndex: number;
  readonly bootGeneration: number;
  readonly segmentId: number;
  readonly unit: TraceTimeUnit;
  readonly start: string;
  readonly end: string;
  readonly packetCount: number;
  readonly intervalCount: number;
  readonly markerCount: number;
  readonly hasGap: boolean;
  readonly gapKinds: readonly string[];
  readonly hasIncomplete: boolean;
  readonly hasUncertain: boolean;
  readonly activeTicksByKind: {
    readonly task: string;
    readonly isr: string;
    readonly idle: string;
    readonly scheduler: string;
  };
  readonly dominantContext?: {
    readonly contextKind: string;
    readonly contextKey: string;
    readonly label?: string;
    readonly ticks: string;
  };
}

export interface TraceRecordCountersDto {
  readonly bytesReceived: number;
  readonly committedRawBytes: number;
  readonly batchesReceived: number;
  readonly packetsDecoded: number;
  readonly sliceCount: number;
  readonly gapCount: number;
  readonly segmentCount: number;
  readonly targetOverruns: number;
  readonly targetDropCount?: number;
  readonly hostDroppedBytes: number;
  readonly transportDroppedBytes: number;
  readonly backpressurePauses: number;
  readonly preStartDrainedBytes: number;
}

export interface TraceRecordSummary {
  readonly recordId: string;
  readonly source: TraceRecordingSource;
  readonly mode?: TraceRecordingMode;
  readonly recordingDir?: string;
  readonly state: TraceRecordingState | 'completed' | 'interrupted' | 'failed' | 'corrupted';
  readonly inspectionStatus?: 'recording' | 'completed' | 'interrupted' | 'failed' | 'corrupted';
  readonly phaseDetail?: string;
  readonly stateReason: string;
  readonly targetState?: TraceTargetState;
  readonly integrity?: TraceCaptureIntegrity;
  readonly transportAdequacy?: TraceTransportAdequacy;
  readonly channelInfo?: {
    readonly controlBlockAddress: number;
    readonly upChannelIndex: number;
    readonly upChannelName: string;
    readonly downChannelIndex?: number;
    readonly bufferAddress: number;
    readonly bufferSize: number;
    readonly initialRdOff: number;
    readonly initialWrOff: number;
    readonly finalRdOff?: number;
    readonly finalWrOff?: number;
  };
  readonly freezeEvidence?: TraceFreezeEvidence;
  readonly counters: TraceRecordCountersDto;
  readonly error?: {
    readonly errorCode: string;
    readonly message: string;
    readonly completion?: 'not-started' | 'partial' | 'completed' | 'unknown';
    readonly diagnostics?: Record<string, unknown>;
  };
  readonly startedAtMs?: number;
  readonly stoppedAtMs?: number;
  readonly nonStandardNotice?: string;
  readonly formatVersion?: number;
  readonly recoverableRawBytes?: number;
  readonly uncommittedTailBytes?: number;
  readonly segments: readonly TraceSegmentDto[];
  readonly gaps: readonly TraceGapDto[];
}

export interface TraceTargetProbeState {
  readonly ok: boolean;
  readonly errorCode?: string;
  readonly message?: string;
  readonly targetState?: 'Running' | 'Halted' | 'Unknown';
  readonly ownerKind?: string;
  readonly transportKind?: string;
  readonly sysViewUpFound?: boolean;
  readonly sysViewDownFound?: boolean;
  readonly upChannelIndex?: number;
  readonly downChannelIndex?: number;
  readonly upBufferSize?: number;
  readonly postMortemCompiled?: boolean | 'unknown';
  readonly enableState?: number;
  readonly dropCount?: number;
  readonly ramRangesAvailable?: boolean;
  readonly rttDownWriteAvailable?: boolean;
  readonly transportAdequacy?: TraceTransportAdequacy;
  readonly inspectedAtMs: number;
}

export interface TracePanelState {
  readonly targetProbe: TraceTargetProbeState | null;
  readonly probing: boolean;
  readonly selectedRecordId: string | null;
  readonly records: readonly TraceRecordSummary[];
  readonly lastActionMessage: { readonly tone: 'info' | 'ok' | 'warn' | 'error'; readonly text: string } | null;
}

export interface TraceViewportResponse {
  readonly querySeq: number;
  readonly recordId: string;
  readonly unit: TraceTimeUnit;
  readonly scopeKey: string;
  readonly bootGeneration?: number;
  readonly segmentId?: number;
  readonly start: string;
  readonly end: string;
  readonly lodBuckets: readonly TraceLodBucketDto[];
  readonly usedFineItems: boolean;
  readonly slices: readonly TraceSliceDto[];
  readonly activations: readonly TraceActivationDto[];
  readonly readyWaits: readonly TraceReadyWaitDto[];
  readonly markers: readonly TraceMarkerDto[];
  readonly markerPoints: readonly TraceMarkerPointDto[];
  readonly truncated: boolean;
  readonly skippedUnanchoredSegments: readonly number[];
  readonly skippedNoFrequencySegments: readonly number[];
  readonly queryDurationMs: number;
  readonly cancelled?: boolean;
  readonly error?: string;
}

export interface TracePointInspectResponse {
  readonly querySeq: number;
  readonly targetKind: 'hover' | 'cursorA' | 'cursorB';
  readonly recordId: string;
  readonly unit: TraceTimeUnit;
  readonly queryTime: string;
  readonly queryStart: string;
  readonly queryEnd: string;
  readonly bootGeneration?: number;
  readonly segmentId?: number;
  readonly segmentReliability?: SegmentReliability;
  readonly timeAnchorStatus?: TimeAnchorStatus;
  readonly sysFreqHz?: number;
  readonly slices: readonly TraceSliceDto[];
  readonly activations: readonly TraceActivationDto[];
  readonly readyWaits: readonly TraceReadyWaitDto[];
  readonly markers: readonly TraceMarkerDto[];
  readonly markerPoints: readonly TraceMarkerPointDto[];
  readonly packets: readonly TracePacketSummaryDto[];
  readonly gaps: readonly TraceGapDto[];
  readonly queryDurationMs: number;
  readonly cancelled?: boolean;
  readonly error?: string;
}

export interface TraceAxisDomain {
  readonly valid: boolean;
  readonly reason?: string;
  readonly scopeKey: string;
  readonly bootGeneration?: number;
  readonly segmentId?: number;
  readonly unit: TraceTimeUnit;
  readonly availableUnits: readonly TraceTimeUnit[];
  readonly minStr: string;
  readonly maxStr: string;
  readonly displayMaxStr: string;
  readonly sysFreqHz?: number;
  readonly includedSegments: readonly TraceSegmentDto[];
  readonly skippedSegments: readonly TraceSegmentDto[];
  readonly hasUncertainSegments: boolean;
  readonly hasMultiBootWarning: boolean;
  readonly hasFrequencyChangeWarning: boolean;
}

export interface TraceCursorPoint {
  readonly timeStr: string;
  readonly unit: TraceTimeUnit;
  readonly bootGeneration?: number;
  readonly segmentId?: number;
  readonly inspect: TracePointInspectResponse | null;
}

export interface TraceCursorSpanEvaluation {
  readonly continuous: boolean;
  readonly deltaRaw: string;
  readonly deltaFormatted: string;
  readonly blockingReasons: readonly string[];
  readonly warnings: readonly string[];
}

export interface SwimlaneRow {
  readonly id: string;
  readonly kind: 'overview' | 'isr' | 'scheduler' | 'task' | 'markers';
  readonly label: string;
  readonly subLabel?: string;
  readonly irqId?: number;
  readonly taskInstanceId?: string;
  readonly contextKey?: string;
  readonly heightPx: number;
}

export function segmentScopeKey(bootGeneration: number, segmentId: number): string {
  return `${bootGeneration}:${segmentId}`;
}

export function parseScopeKey(scopeKey: string): { mode: 'all-anchored' } | { mode: 'segment'; bootGeneration: number; segmentId: number } {
  if (!scopeKey || scopeKey === 'all-anchored') {
    return { mode: 'all-anchored' };
  }
  const parts = scopeKey.split(':');
  if (parts.length === 2) {
    const bootGeneration = Number(parts[0]);
    const segmentId = Number(parts[1]);
    if (Number.isInteger(bootGeneration) && Number.isInteger(segmentId)) {
      return { mode: 'segment', bootGeneration, segmentId };
    }
  }
  return { mode: 'all-anchored' };
}

export function getSegmentBoundsForUnit(
  seg: TraceSegmentDto,
  unit: TraceTimeUnit,
): { min: bigint; max: bigint } | null {
  switch (unit) {
    case 'relative-ticks':
      return { min: BigInt(seg.minRelativeTicks), max: BigInt(seg.maxRelativeTicks) };
    case 'relative-ns': {
      if (!seg.sysFreqHz || seg.sysFreqHz <= 0) return null;
      const f = BigInt(seg.sysFreqHz);
      return {
        min: (BigInt(seg.minRelativeTicks) * 1_000_000_000n) / f,
        max: (BigInt(seg.maxRelativeTicks) * 1_000_000_000n) / f,
      };
    }
    case 'absolute-ticks':
      if (seg.timeAnchorStatus === 'unanchored' || seg.firstAbsoluteTicks === undefined || seg.lastAbsoluteTicks === undefined) {
        return null;
      }
      return { min: BigInt(seg.firstAbsoluteTicks), max: BigInt(seg.lastAbsoluteTicks) };
    case 'ns': {
      if (seg.timeAnchorStatus === 'unanchored') return null;
      if (seg.minNs !== undefined && seg.maxNs !== undefined) {
        return { min: BigInt(seg.minNs), max: BigInt(seg.maxNs) };
      }
      if (seg.firstAbsoluteTicks !== undefined && seg.lastAbsoluteTicks !== undefined && seg.sysFreqHz && seg.sysFreqHz > 0) {
        const f = BigInt(seg.sysFreqHz);
        return {
          min: (BigInt(seg.firstAbsoluteTicks) * 1_000_000_000n) / f,
          max: (BigInt(seg.lastAbsoluteTicks) * 1_000_000_000n) / f,
        };
      }
      return null;
    }
  }
}

export function getItemTimeRangeForUnit(
  item: {
    startRelTicks: string;
    endRelTicks: string;
    startAbsTicks?: string;
    endAbsTicks?: string;
    startNs?: string;
    endNs?: string;
    sysFreqHz?: number;
  },
  unit: TraceTimeUnit,
): { start: bigint; end: bigint } | null {
  switch (unit) {
    case 'relative-ticks':
      return { start: BigInt(item.startRelTicks), end: BigInt(item.endRelTicks) };
    case 'relative-ns': {
      if (!item.sysFreqHz || item.sysFreqHz <= 0) return null;
      const f = BigInt(item.sysFreqHz);
      return {
        start: (BigInt(item.startRelTicks) * 1_000_000_000n) / f,
        end: (BigInt(item.endRelTicks) * 1_000_000_000n) / f,
      };
    }
    case 'absolute-ticks':
      if (item.startAbsTicks === undefined || item.endAbsTicks === undefined) return null;
      return { start: BigInt(item.startAbsTicks), end: BigInt(item.endAbsTicks) };
    case 'ns': {
      if (item.startNs !== undefined && item.endNs !== undefined) {
        return { start: BigInt(item.startNs), end: BigInt(item.endNs) };
      }
      if (item.startAbsTicks !== undefined && item.endAbsTicks !== undefined && item.sysFreqHz && item.sysFreqHz > 0) {
        const f = BigInt(item.sysFreqHz);
        return {
          start: (BigInt(item.startAbsTicks) * 1_000_000_000n) / f,
          end: (BigInt(item.endAbsTicks) * 1_000_000_000n) / f,
        };
      }
      return null;
    }
  }
}

export function getPointTimeForUnit(
  pt: { relTicks: string; absTicks?: string; ns?: string; sysFreqHz?: number },
  unit: TraceTimeUnit,
): bigint | null {
  switch (unit) {
    case 'relative-ticks':
      return BigInt(pt.relTicks);
    case 'relative-ns': {
      if (!pt.sysFreqHz || pt.sysFreqHz <= 0) return null;
      return (BigInt(pt.relTicks) * 1_000_000_000n) / BigInt(pt.sysFreqHz);
    }
    case 'absolute-ticks':
      return pt.absTicks !== undefined ? BigInt(pt.absTicks) : null;
    case 'ns': {
      if (pt.ns !== undefined) return BigInt(pt.ns);
      if (pt.absTicks !== undefined && pt.sysFreqHz && pt.sysFreqHz > 0) {
        return (BigInt(pt.absTicks) * 1_000_000_000n) / BigInt(pt.sysFreqHz);
      }
      return null;
    }
  }
}

export function computeAxisDomain(
  segments: readonly TraceSegmentDto[],
  preferredUnit: TraceTimeUnit,
  preferredScopeKey = 'all-anchored',
): TraceAxisDomain {
  if (segments.length === 0) {
    return {
      valid: false,
      reason: '当前录制尚无可用已解码时间段',
      scopeKey: 'all-anchored',
      unit: preferredUnit,
      availableUnits: [],
      minStr: '0',
      maxStr: '0',
      displayMaxStr: '100',
      includedSegments: [],
      skippedSegments: [],
      hasUncertainSegments: false,
      hasMultiBootWarning: false,
      hasFrequencyChangeWarning: false,
    };
  }

  const parsedScope = parseScopeKey(preferredScopeKey);
  const distinctBoots = Array.from(new Set(segments.map(s => s.bootGeneration)));
  const hasMultiBootWarning = distinctBoots.length > 1;
  const latestBoot = distinctBoots[distinctBoots.length - 1];

  let targetSegments: TraceSegmentDto[] = [];
  let effectiveScopeKey = 'all-anchored';
  let bootGeneration: number | undefined;
  let segmentId: number | undefined;

  if (parsedScope.mode === 'segment') {
    const found = segments.find(
      s => s.bootGeneration === parsedScope.bootGeneration && s.segmentId === parsedScope.segmentId,
    );
    if (found) {
      targetSegments = [found];
      effectiveScopeKey = segmentScopeKey(found.bootGeneration, found.segmentId);
      bootGeneration = found.bootGeneration;
      segmentId = found.segmentId;
    }
  }

  if (targetSegments.length === 0) {
    if (segments.length === 1) {
      const only = segments[0];
      targetSegments = [only];
      effectiveScopeKey = segmentScopeKey(only.bootGeneration, only.segmentId);
      bootGeneration = only.bootGeneration;
      segmentId = only.segmentId;
    } else {
      const sameLatestBoot = segments.filter(s => s.bootGeneration === latestBoot);
      const anchoredInBoot = sameLatestBoot.filter(s => getSegmentBoundsForUnit(s, 'absolute-ticks') !== null);
      if (anchoredInBoot.length > 0 && (preferredUnit === 'ns' || preferredUnit === 'absolute-ticks')) {
        targetSegments = anchoredInBoot;
        effectiveScopeKey = 'all-anchored';
        bootGeneration = latestBoot;
      } else if (anchoredInBoot.length > 0 && preferredScopeKey === 'all-anchored') {
        targetSegments = anchoredInBoot;
        effectiveScopeKey = 'all-anchored';
        bootGeneration = latestBoot;
      } else {
        // Multi-segment unanchored or user explicitly chose relative units: scope to latest segment so t=0 segments don't overlap.
        const fallback = sameLatestBoot[sameLatestBoot.length - 1] ?? segments[segments.length - 1];
        targetSegments = [fallback];
        effectiveScopeKey = segmentScopeKey(fallback.bootGeneration, fallback.segmentId);
        bootGeneration = fallback.bootGeneration;
        segmentId = fallback.segmentId;
      }
    }
  }

  const singleSeg = targetSegments.length === 1;
  const availableUnits: TraceTimeUnit[] = [];
  if (targetSegments.every(s => getSegmentBoundsForUnit(s, 'ns') !== null)) {
    availableUnits.push('ns');
  }
  if (singleSeg && targetSegments.every(s => getSegmentBoundsForUnit(s, 'relative-ns') !== null)) {
    availableUnits.push('relative-ns');
  }
  if (targetSegments.every(s => getSegmentBoundsForUnit(s, 'absolute-ticks') !== null)) {
    availableUnits.push('absolute-ticks');
  }
  if (singleSeg) {
    availableUnits.push('relative-ticks');
  }

  // Fallback if all-anchored had no valid units
  if (availableUnits.length === 0) {
    const fallback = targetSegments[targetSegments.length - 1] ?? segments[segments.length - 1];
    targetSegments = [fallback];
    effectiveScopeKey = segmentScopeKey(fallback.bootGeneration, fallback.segmentId);
    bootGeneration = fallback.bootGeneration;
    segmentId = fallback.segmentId;
    if (getSegmentBoundsForUnit(fallback, 'relative-ns') !== null) {
      availableUnits.push('relative-ns');
    }
    availableUnits.push('relative-ticks');
  }

  const unit = availableUnits.includes(preferredUnit) ? preferredUnit : availableUnits[0];
  let minVal: bigint | undefined;
  let maxVal: bigint | undefined;
  const freqs = new Set<number>();
  for (const seg of targetSegments) {
    const b = getSegmentBoundsForUnit(seg, unit);
    if (!b) continue;
    if (minVal === undefined || b.min < minVal) minVal = b.min;
    if (maxVal === undefined || b.max > maxVal) maxVal = b.max;
    if (seg.sysFreqHz && seg.sysFreqHz > 0) freqs.add(seg.sysFreqHz);
  }

  const includedSet = new Set(targetSegments.map(s => segmentScopeKey(s.bootGeneration, s.segmentId)));
  const skippedSegments = segments.filter(s => !includedSet.has(segmentScopeKey(s.bootGeneration, s.segmentId)));
  const minBig = minVal ?? 0n;
  const maxBig = maxVal ?? minBig;
  const displayMaxBig = maxBig > minBig ? maxBig : minBig + 100n;

  return {
    valid: true,
    scopeKey: effectiveScopeKey,
    bootGeneration,
    segmentId,
    unit,
    availableUnits,
    minStr: minBig.toString(),
    maxStr: maxBig.toString(),
    displayMaxStr: displayMaxBig.toString(),
    sysFreqHz: freqs.size === 1 ? Array.from(freqs)[0] : undefined,
    includedSegments: targetSegments,
    skippedSegments,
    hasUncertainSegments: targetSegments.some(s => s.reliability === 'uncertain'),
    hasMultiBootWarning,
    hasFrequencyChangeWarning: freqs.size > 1,
  };
}

export function resolveGapAnchors(
  segments: readonly TraceSegmentDto[],
  gaps: readonly TraceGapDto[],
  unit: TraceTimeUnit,
  scopeBoot?: number,
  scopeSegmentId?: number,
): TraceGapAnchor[] {
  const segsByBoot = new Map<number, TraceSegmentDto[]>();
  for (const s of segments) {
    let arr = segsByBoot.get(s.bootGeneration);
    if (!arr) {
      arr = [];
      segsByBoot.set(s.bootGeneration, arr);
    }
    arr.push(s);
  }
  for (const arr of segsByBoot.values()) {
    arr.sort((a, b) => a.segmentId - b.segmentId);
  }

  const out: TraceGapAnchor[] = [];
  for (const g of gaps) {
    if (scopeBoot !== undefined && g.bootGeneration !== scopeBoot) continue;
    const bootSegs = segsByBoot.get(g.bootGeneration) ?? [];
    if (bootSegs.length === 0) continue;

    if (g.segmentIdBefore === undefined) {
      const firstSeg = scopeSegmentId !== undefined
        ? bootSegs.find(s => s.segmentId === scopeSegmentId)
        : bootSegs[0];
      if (!firstSeg || (scopeSegmentId !== undefined && firstSeg.segmentId !== bootSegs[0].segmentId)) continue;
      const b = getSegmentBoundsForUnit(firstSeg, unit);
      if (!b) continue;
      out.push({
        gap: g,
        start: b.min.toString(),
        end: b.min.toString(),
        beforeSegmentId: firstSeg.segmentId,
        positionKind: 'segment-start',
      });
      continue;
    }

    const idx = bootSegs.findIndex(s => s.segmentId === g.segmentIdBefore);
    const segBefore = idx >= 0 ? bootSegs[idx] : undefined;
    const segAfter = idx >= 0 && idx + 1 < bootSegs.length ? bootSegs[idx + 1] : undefined;

    if (scopeSegmentId !== undefined) {
      if (g.segmentIdBefore === scopeSegmentId && segBefore) {
        const b = getSegmentBoundsForUnit(segBefore, unit);
        if (!b) continue;
        out.push({
          gap: g,
          start: b.max.toString(),
          end: b.max.toString(),
          afterSegmentId: segBefore.segmentId,
          beforeSegmentId: segAfter?.segmentId,
          positionKind: 'segment-end',
        });
      } else if (segAfter && segAfter.segmentId === scopeSegmentId) {
        const b = getSegmentBoundsForUnit(segAfter, unit);
        if (!b) continue;
        out.push({
          gap: g,
          start: b.min.toString(),
          end: b.min.toString(),
          afterSegmentId: segBefore?.segmentId,
          beforeSegmentId: segAfter.segmentId,
          positionKind: 'segment-start',
        });
      }
      continue;
    }

    if (!segBefore) continue;
    const bBefore = getSegmentBoundsForUnit(segBefore, unit);
    if (!bBefore) continue;
    const bAfter = segAfter ? getSegmentBoundsForUnit(segAfter, unit) : null;
    if (bAfter && bAfter.min >= bBefore.max) {
      out.push({
        gap: g,
        start: bBefore.max.toString(),
        end: bAfter.min.toString(),
        afterSegmentId: segBefore.segmentId,
        beforeSegmentId: segAfter!.segmentId,
        positionKind: 'between-segments',
      });
    } else {
      out.push({
        gap: g,
        start: bBefore.max.toString(),
        end: bBefore.max.toString(),
        afterSegmentId: segBefore.segmentId,
        beforeSegmentId: segAfter?.segmentId,
        positionKind: 'segment-end',
      });
    }
  }
  return out;
}

const MAX_SAFE_BIGINT_SPAN = 9_007_199_254_740_991n; // 2^53 - 1

export function bigIntToPixelX(t: bigint, viewStart: bigint, viewEnd: bigint, widthPx: number): number {
  if (widthPx <= 0 || viewEnd <= viewStart) return 0;
  const span = viewEnd - viewStart;
  const offset = t - viewStart;
  if (span <= MAX_SAFE_BIGINT_SPAN && offset >= -MAX_SAFE_BIGINT_SPAN && offset <= MAX_SAFE_BIGINT_SPAN) {
    return (Number(offset) / Number(span)) * widthPx;
  }
  // Exact BigInt scaling for >2^53 spans
  const scaled = (offset * BigInt(Math.round(widthPx * 1024))) / span;
  return Number(scaled) / 1024;
}

export function pixelXToBigInt(x: number, viewStart: bigint, viewEnd: bigint, widthPx: number): bigint {
  if (widthPx <= 0 || viewEnd <= viewStart) return viewStart;
  const clamped = Math.max(0, Math.min(widthPx, x));
  const span = viewEnd - viewStart;
  const PRECISION = 1_000_000;
  const ratioScaled = BigInt(Math.round((clamped / widthPx) * PRECISION));
  return viewStart + (span * ratioScaled) / BigInt(PRECISION);
}

export function zoomBigIntRange(
  viewStart: bigint,
  viewEnd: bigint,
  anchorTime: bigint,
  factor: number,
  bounds?: { min: bigint; max: bigint },
  minSpan = 10n,
): { start: bigint; end: bigint } {
  const curSpan = viewEnd > viewStart ? viewEnd - viewStart : minSpan;
  const PRECISION = 10_000;
  const factorNum = BigInt(Math.max(100, Math.min(100_000, Math.round(factor * PRECISION))));
  let nextSpan = (curSpan * factorNum) / BigInt(PRECISION);
  if (nextSpan < minSpan) nextSpan = minSpan;
  if (bounds) {
    const fullSpan = bounds.max > bounds.min ? bounds.max - bounds.min : minSpan;
    if (nextSpan > fullSpan) nextSpan = fullSpan;
  }

  const clampedAnchor = anchorTime < viewStart ? viewStart : anchorTime > viewEnd ? viewEnd : anchorTime;
  const anchorOffset = clampedAnchor - viewStart;
  let nextStart = clampedAnchor - (anchorOffset * nextSpan) / curSpan;
  let nextEnd = nextStart + nextSpan;

  if (bounds) {
    if (nextStart < bounds.min) {
      nextStart = bounds.min;
      nextEnd = nextStart + nextSpan;
    }
    if (nextEnd > bounds.max) {
      nextEnd = bounds.max;
      nextStart = nextEnd - nextSpan;
      if (nextStart < bounds.min) nextStart = bounds.min;
    }
  }
  if (nextEnd <= nextStart) nextEnd = nextStart + minSpan;
  return { start: nextStart, end: nextEnd };
}

export function panBigIntRange(
  viewStart: bigint,
  viewEnd: bigint,
  delta: bigint,
  bounds?: { min: bigint; max: bigint },
): { start: bigint; end: bigint } {
  const span = viewEnd > viewStart ? viewEnd - viewStart : 10n;
  let nextStart = viewStart + delta;
  let nextEnd = nextStart + span;
  if (bounds) {
    const total = bounds.max > bounds.min ? bounds.max - bounds.min : span;
    if (span >= total) {
      return { start: bounds.min, end: bounds.max > bounds.min ? bounds.max : bounds.min + span };
    }
    if (nextStart < bounds.min) {
      nextStart = bounds.min;
      nextEnd = nextStart + span;
    }
    if (nextEnd > bounds.max) {
      nextEnd = bounds.max;
      nextStart = nextEnd - span;
      if (nextStart < bounds.min) nextStart = bounds.min;
    }
  }
  return { start: nextStart, end: nextEnd };
}

export function formatTraceTimestamp(valueStr: string, unit: TraceTimeUnit): string {
  let val: bigint;
  try {
    val = BigInt(valueStr);
  } catch {
    return valueStr;
  }
  if (unit === 'ns' || unit === 'relative-ns') {
    const abs = val < 0n ? -val : val;
    const sign = val < 0n ? '-' : '';
    if (abs >= 1_000_000_000n) {
      const whole = abs / 1_000_000_000n;
      const frac = ((abs % 1_000_000_000n) / 1_000n).toString().padStart(6, '0');
      return `${sign}${whole}.${frac} s`;
    }
    if (abs >= 1_000_000n) {
      const whole = abs / 1_000_000n;
      const frac = ((abs % 1_000_000n) / 1_000n).toString().padStart(3, '0');
      return `${sign}${whole}.${frac} ms`;
    }
    if (abs >= 1_000n) {
      const whole = abs / 1_000n;
      const frac = (abs % 1_000n).toString().padStart(3, '0');
      return `${sign}${whole}.${frac} µs`;
    }
    return `${sign}${abs.toString()} ns`;
  }
  return `${val.toString()} ticks`;
}

export function formatTraceDuration(deltaBig: bigint, unit: TraceTimeUnit): string {
  const abs = deltaBig < 0n ? -deltaBig : deltaBig;
  return formatTraceTimestamp(abs.toString(), unit);
}

function findSegmentAtPoint(
  point: TraceCursorPoint,
  segments: readonly TraceSegmentDto[],
  unit: TraceTimeUnit,
): TraceSegmentDto | undefined {
  if (point.bootGeneration !== undefined && point.segmentId !== undefined) {
    const exact = segments.find(s => s.bootGeneration === point.bootGeneration && s.segmentId === point.segmentId);
    if (exact) return exact;
  }
  const inspectSeg = point.inspect?.segmentId;
  const inspectBoot = point.inspect?.bootGeneration;
  if (inspectBoot !== undefined && inspectSeg !== undefined) {
    const exact = segments.find(s => s.bootGeneration === inspectBoot && s.segmentId === inspectSeg);
    if (exact) return exact;
  }
  const t = BigInt(point.timeStr);
  for (const s of segments) {
    const b = getSegmentBoundsForUnit(s, unit);
    if (b && t >= b.min && t <= b.max) {
      return s;
    }
  }
  return undefined;
}

export function evaluateCursorSpanContinuity(
  cursorA: TraceCursorPoint,
  cursorB: TraceCursorPoint,
  segments: readonly TraceSegmentDto[],
  gaps: readonly TraceGapDto[],
  unit: TraceTimeUnit,
): TraceCursorSpanEvaluation {
  const tA = BigInt(cursorA.timeStr);
  const tB = BigInt(cursorB.timeStr);
  const lo = tA <= tB ? tA : tB;
  const hi = tA <= tB ? tB : tA;
  const delta = hi - lo;

  const blockingReasons: string[] = [];
  const warnings: string[] = [];

  if (cursorA.unit !== cursorB.unit || cursorA.unit !== unit) {
    blockingReasons.push(`游标时间单位不一致 (${cursorA.unit} / ${cursorB.unit} vs ${unit})`);
  }

  const segA = findSegmentAtPoint(cursorA, segments, unit);
  const segB = findSegmentAtPoint(cursorB, segments, unit);

  if (!segA || !segB) {
    blockingReasons.push('游标未落在有效已解码时间段内');
  } else {
    if (segA.bootGeneration !== segB.bootGeneration) {
      blockingReasons.push(`跨越不同启动代次 (boot ${segA.bootGeneration} → boot ${segB.bootGeneration})`);
    }
    if (segA.segmentId !== segB.segmentId) {
      blockingReasons.push(`跨越不连续时间段 (seg ${segA.segmentId} → seg ${segB.segmentId})`);
    }
    if (segA.reliability === 'uncertain' || segB.reliability === 'uncertain') {
      blockingReasons.push(`包含不可信段 (reliability=uncertain)`);
    }
    if (segA.timeAnchorStatus === 'unanchored' && (unit === 'ns' || unit === 'absolute-ticks')) {
      blockingReasons.push('缺少 SYSTIME_CYCLES 绝对时间锚点');
    }
    if ((unit === 'ns' || unit === 'relative-ns') && (!segA.sysFreqHz || segA.sysFreqHz <= 0)) {
      blockingReasons.push('缺少有效系统时钟频率 (sysFreqHz)');
    }
  }

  // Check if any non-EOF gap falls strictly inside (lo, hi) or separates segments between lo and hi
  const anchors = resolveGapAnchors(
    segments,
    gaps,
    unit,
    segA?.bootGeneration,
    segA && segB && segA.segmentId === segB.segmentId ? segA.segmentId : undefined,
  );
  for (const anchor of anchors) {
    const g = anchor.gap;
    if (g.kind === 'eof' || g.kind === 'trace-stop') continue;
    const gs = BigInt(anchor.start);
    const ge = BigInt(anchor.end);
    const crossesGap = (gs > lo && gs < hi) || (ge > lo && ge < hi) || (gs <= lo && ge >= hi && lo < hi && anchor.positionKind === 'between-segments');
    if (crossesGap) {
      blockingReasons.push(
        `跨越缺口 #${g.seq} (${g.kind}, droppedPackets=${String(g.droppedPackets)}, droppedBytes=${String(g.droppedBytes)})`,
      );
    }
  }

  // Also check explicit gaps returned on exact point inspect
  for (const pt of [cursorA, cursorB]) {
    if (pt.inspect?.slices.some(s => s.completeness !== 'complete')) {
      warnings.push('端点命中 incomplete/uncertain 区间');
    }
  }

  const continuous = blockingReasons.length === 0;
  return {
    continuous,
    deltaRaw: delta.toString(),
    deltaFormatted: continuous ? formatTraceDuration(delta, unit) : '不可计算连续区间',
    blockingReasons,
    warnings,
  };
}

export function buildSwimlaneLayout(
  slices: readonly TraceSliceDto[],
  activations: readonly TraceActivationDto[],
  readyWaits: readonly TraceReadyWaitDto[],
  markers: readonly TraceMarkerDto[],
  markerPoints: readonly TraceMarkerPointDto[],
): SwimlaneRow[] {
  const rows: SwimlaneRow[] = [
    { id: 'overview', kind: 'overview', label: '概览 / LOD', subLabel: '负载与缺口', heightPx: 28 },
  ];

  // 1. ISRs sorted by irqId
  const isrMap = new Map<string, { irqId: number; label: string }>();
  for (const act of activations) {
    if (act.kind !== 'isr') continue;
    const irqId = act.irqId ?? 0;
    const key = act.contextKey || `isr:${irqId}`;
    const label = act.label && act.labelSource !== 'missing' ? `${act.label} (#${irqId})` : `ISR #${irqId}`;
    const prev = isrMap.get(key);
    if (!prev || (act.label && prev.label.startsWith('ISR #'))) {
      isrMap.set(key, { irqId, label });
    }
  }
  for (const sl of slices) {
    if (sl.contextKind !== 'isr') continue;
    const irqId = sl.irqId ?? 0;
    const key = sl.contextKey || `isr:${irqId}`;
    const label = sl.label && sl.labelSource !== 'missing' ? `${sl.label} (#${irqId})` : `ISR #${irqId}`;
    if (!isrMap.has(key)) {
      isrMap.set(key, { irqId, label });
    }
  }
  const sortedIsrs = Array.from(isrMap.entries()).sort((a, b) => a[1].irqId - b[1].irqId);
  for (const [contextKey, info] of sortedIsrs) {
    rows.push({
      id: `isr:${contextKey}`,
      kind: 'isr',
      label: info.label,
      subLabel: `IRQ ${info.irqId}`,
      irqId: info.irqId,
      contextKey,
      heightPx: 26,
    });
  }

  // 2. Scheduler lane (when scheduler slices appear)
  if (slices.some(s => s.contextKind === 'scheduler')) {
    rows.push({
      id: 'scheduler',
      kind: 'scheduler',
      label: 'Scheduler',
      subLabel: '内核调度',
      contextKey: 'scheduler',
      heightPx: 22,
    });
  }

  // 3. Tasks (including IDLE; running + ready sub-track per task)
  const taskMap = new Map<string, { label: string; isIdle: boolean; tcbAddress?: number; firstOrder: number }>();
  let order = 0;
  const registerTask = (
    id: string,
    label: string | undefined,
    labelSource: LabelSource,
    tcbAddress?: number,
    isIdle = false,
  ) => {
    const existing = taskMap.get(id);
    const resolved = label && labelSource !== 'missing'
      ? label
      : isIdle
        ? 'IDLE'
        : tcbAddress !== undefined
          ? `Task 0x${(tcbAddress >>> 0).toString(16).toUpperCase()}`
          : id;
    if (!existing) {
      taskMap.set(id, { label: resolved, isIdle, tcbAddress, firstOrder: order++ });
    } else if (label && labelSource !== 'missing' && (existing.label.startsWith('Task ') || existing.label === id)) {
      existing.label = label;
    }
  };

  for (const sl of slices) {
    if (sl.contextKind === 'task' || sl.contextKind === 'idle') {
      const id = sl.taskInstanceId ?? sl.contextKey;
      registerTask(id, sl.label, sl.labelSource, sl.tcbAddress, sl.contextKind === 'idle');
    }
  }
  for (const act of activations) {
    if (act.kind === 'task-exec') {
      const id = act.taskInstanceId ?? act.contextKey;
      registerTask(id, act.label, act.labelSource, undefined, false);
    }
  }
  for (const rw of readyWaits) {
    registerTask(rw.taskInstanceId, rw.label, rw.labelSource, rw.tcbAddress, false);
  }

  const sortedTasks = Array.from(taskMap.entries()).sort((a, b) => {
    if (a[1].isIdle !== b[1].isIdle) return a[1].isIdle ? 1 : -1;
    return a[1].firstOrder - b[1].firstOrder;
  });
  for (const [taskId, info] of sortedTasks) {
    rows.push({
      id: `task:${taskId}`,
      kind: 'task',
      label: info.label,
      subLabel: info.isIdle ? '空闲' : '运行 / Ready',
      taskInstanceId: taskId,
      contextKey: taskId,
      heightPx: info.isIdle ? 24 : 34,
    });
  }

  // 4. Markers lane
  const hasMarkers = markers.length > 0 || markerPoints.length > 0;
  rows.push({
    id: 'markers',
    kind: 'markers',
    label: 'Markers',
    subLabel: hasMarkers ? `${markers.length} 区间 · ${markerPoints.length} 点` : '无当前视口标记',
    heightPx: 28,
  });

  return rows;
}

export interface TraceAnalysisResponse {
  readonly querySeq: number;
  readonly recordId: string;
  readonly unit: TraceTimeUnit;
  readonly scopeKey: string;
  readonly sourceKind: TraceAnalysisSourceKind;
  readonly start: string;
  readonly end: string;
  readonly analysis?: TraceAnalysisQueryResult;
  readonly queryDurationMs: number;
  readonly cancelled?: boolean;
  readonly error?: string;
}

export interface TraceEventsResponse {
  readonly querySeq: number;
  readonly recordId: string;
  readonly unit: TraceTimeUnit;
  readonly scopeKey: string;
  readonly sourceKind: TraceAnalysisSourceKind;
  readonly category: TraceEventCategoryFilter;
  readonly searchText: string;
  readonly contextKey?: string;
  readonly onlyWithDiagnostics?: boolean;
  readonly result?: TraceEventsQueryResult;
  readonly queryDurationMs: number;
  readonly cancelled?: boolean;
  readonly error?: string;
}

export interface TraceEventLocateResponse {
  readonly querySeq: number;
  readonly recordId: string;
  readonly unit: TraceTimeUnit;
  readonly result?: TraceEventLocateResult;
  readonly queryDurationMs: number;
  readonly cancelled?: boolean;
  readonly error?: string;
}

export interface TraceTerminalResponse {
  readonly querySeq: number;
  readonly recordId: string;
  readonly unit: TraceTimeUnit;
  readonly scopeKey: string;
  readonly sourceKind: TraceAnalysisSourceKind;
  readonly level: TraceTerminalLevelFilter;
  readonly searchText: string;
  readonly mergeAppend: boolean;
  readonly result?: TraceTerminalQueryResult;
  readonly queryDurationMs: number;
  readonly cancelled?: boolean;
  readonly error?: string;
}

export interface TraceDiagnosticsResponse {
  readonly recordId: string;
  readonly diagnostics?: TraceRecordingDiagnosticsResult;
  readonly error?: string;
}

export interface TraceFocusedEventRef {
  readonly recordId: string;
  readonly eventKey: string;
  readonly bootGeneration: number;
  readonly segmentId: number;
  readonly packetIndexInSegment: number;
  readonly streamByteOffset: number;
  readonly timeStr: string;
  readonly unit: TraceTimeUnit;
  readonly label?: string;
}

export interface ResolvedAnalysisRange {
  readonly valid: boolean;
  readonly sourceKind: TraceAnalysisSourceKind;
  readonly start?: string;
  readonly end?: string;
  readonly reason?: string;
  readonly missingEndpoint?: 'A' | 'B' | 'both';
  readonly continuity?: TraceCursorSpanEvaluation;
}

export function resolveContextsAnalysisRange(params: {
  axisDomain: TraceAxisDomain;
  viewRange: { start: string; end: string } | null;
  cursorA: { timeStr: string; unit: TraceTimeUnit; bootGeneration?: number; segmentId?: number } | null;
  cursorB: { timeStr: string; unit: TraceTimeUnit; bootGeneration?: number; segmentId?: number } | null;
  cursorAInspect?: TracePointInspectResponse | null;
  cursorBInspect?: TracePointInspectResponse | null;
  segments: readonly TraceSegmentDto[];
  gaps: readonly TraceGapDto[];
  sourceKind: TraceAnalysisSourceKind;
}): ResolvedAnalysisRange {
  const { axisDomain, viewRange, cursorA, cursorB, cursorAInspect, cursorBInspect, segments, gaps, sourceKind } = params;
  if (!axisDomain.valid) {
    return {
      valid: false,
      sourceKind,
      reason: axisDomain.reason || '当前录制尚无可用时间范围',
    };
  }

  if (sourceKind === 'selection') {
    if (!cursorA || !cursorB) {
      const missingEndpoint = !cursorA && !cursorB ? 'both' : !cursorA ? 'A' : 'B';
      return {
        valid: false,
        sourceKind,
        missingEndpoint,
        reason: missingEndpoint === 'both'
          ? '未放置游标 A 与 B（请在 Trace Timeline 点击设置双游标，或切换“Trace 视口 / 全部范围”）'
          : `选区缺少游标 ${missingEndpoint}（不能默认从 0 起算，请补齐游标 ${missingEndpoint}）`,
      };
    }
    if (cursorA.unit !== axisDomain.unit || cursorB.unit !== axisDomain.unit) {
      return {
        valid: false,
        sourceKind,
        reason: `游标单位 (${cursorA.unit}/${cursorB.unit}) 与当前时间轴单位 (${axisDomain.unit}) 不一致，请重新放置游标`,
      };
    }
    const tA = BigInt(cursorA.timeStr);
    const tB = BigInt(cursorB.timeStr);
    const lo = tA <= tB ? tA : tB;
    const hi = tA <= tB ? tB : tA;
    const continuity = evaluateCursorSpanContinuity(
      { ...cursorA, inspect: cursorAInspect ?? null },
      { ...cursorB, inspect: cursorBInspect ?? null },
      segments,
      gaps,
      axisDomain.unit,
    );
    if (hi <= lo) {
      return {
        valid: false,
        sourceKind,
        reason: `游标 A 与 B 重合于 ${formatTraceTimestamp(lo.toString(), axisDomain.unit)}（零长度区间）`,
        continuity,
      };
    }
    return {
      valid: true,
      sourceKind,
      start: lo.toString(),
      end: hi.toString(),
      continuity,
    };
  }

  const target = sourceKind === 'viewport' && viewRange
    ? viewRange
    : { start: axisDomain.minStr, end: axisDomain.displayMaxStr };

  try {
    const s = BigInt(target.start);
    const e = BigInt(target.end);
    if (e <= s) {
      return { valid: false, sourceKind, reason: '目标区间长度为零或反向' };
    }
    return {
      valid: true,
      sourceKind,
      start: s.toString(),
      end: e.toString(),
    };
  } catch {
    return { valid: false, sourceKind, reason: '非法时间范围边界' };
  }
}

export function formatAnalysisDurationStr(valueStr: string | undefined, unit: TraceTimeUnit): string {
  if (valueStr === undefined) return '—';
  const trimmed = valueStr.trim();
  if (/^-?\d+$/.test(trimmed)) {
    return formatTraceDuration(BigInt(trimmed), unit);
  }
  const m = trimmed.match(/^(-?\d+)\.(\d+)$/);
  if (m) {
    const wholeBig = BigInt(m[1]);
    const absWhole = wholeBig < 0n ? -wholeBig : wholeBig;
    if (absWhole > 9_000_000_000_000n) {
      return formatTraceDuration(wholeBig, unit);
    }
  }
  const num = Number(trimmed);
  if (!Number.isFinite(num)) return valueStr;
  if (unit === 'ns' || unit === 'relative-ns') {
    if (num >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(3)} s`;
    if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(3)} ms`;
    if (num >= 1_000) return `${(num / 1_000).toFixed(3)} µs`;
    return `${num.toFixed(2)} ns`;
  }
  return `${num.toFixed(2)} ticks`;
}

export function formatContextLabel(row: Pick<TraceContextStatsRow, 'contextKind' | 'contextKey' | 'label' | 'labelSource' | 'tcbAddress' | 'taskGeneration' | 'irqId' | 'timerId'>): string {
  if (row.contextKind === 'idle') return row.label || 'IDLE';
  if (row.contextKind === 'scheduler') return 'Scheduler';
  if (row.contextKind === 'isr') {
    const base = row.label && row.labelSource !== 'missing' ? row.label : `ISR #${row.irqId ?? '?'}`;
    return row.irqId !== undefined && row.label && row.labelSource !== 'missing' ? `${base} (#${row.irqId})` : base;
  }
  if (row.contextKind === 'timer') {
    if (row.label && row.labelSource !== 'missing') return row.label;
    return row.timerId !== undefined ? `Timer 0x${(row.timerId >>> 0).toString(16).toUpperCase()}` : row.contextKey;
  }
  if (row.label && row.labelSource !== 'missing') return row.label;
  if (row.tcbAddress !== undefined) return `Task 0x${(row.tcbAddress >>> 0).toString(16).toUpperCase()}`;
  return row.contextKey;
}

export function filterAndSortContextRows(
  rows: readonly TraceContextStatsRow[],
  kindFilter: ContextStatsKindFilter,
  query: string,
  sortKey: ContextStatsSortKey,
  sortDir: 'asc' | 'desc',
): TraceContextStatsRow[] {
  const needle = query.trim().toLowerCase();
  const filtered = rows.filter(r => {
    if (kindFilter !== 'all' && r.contextKind !== kindFilter) return false;
    if (!needle) return true;
    const lbl = formatContextLabel(r).toLowerCase();
    const key = r.contextKey.toLowerCase();
    const tcb = r.tcbAddress !== undefined ? `0x${(r.tcbAddress >>> 0).toString(16)}` : '';
    const irq = r.irqId !== undefined ? `irq${r.irqId} #${r.irqId}` : '';
    return lbl.includes(needle) || key.includes(needle) || tcb.includes(needle) || irq.includes(needle);
  });

  const dir = sortDir === 'asc' ? 1 : -1;
  return [...filtered].sort((a, b) => {
    let cmp = 0;
    switch (sortKey) {
      case 'cpu': {
        const va = BigInt(a.clippedExclusiveDuration);
        const vb = BigInt(b.clippedExclusiveDuration);
        cmp = va < vb ? -1 : va > vb ? 1 : 0;
        break;
      }
      case 'name':
        cmp = formatContextLabel(a).localeCompare(formatContextLabel(b), undefined, { numeric: true });
        break;
      case 'activations':
        cmp = a.completeActivationCount - b.completeActivationCount;
        break;
      case 'exclMax': {
        const va = a.exclusiveStats ? BigInt(a.exclusiveStats.max) : -1n;
        const vb = b.exclusiveStats ? BigInt(b.exclusiveStats.max) : -1n;
        cmp = va < vb ? -1 : va > vb ? 1 : 0;
        break;
      }
      case 'readyMax': {
        const va = a.readyStats ? BigInt(a.readyStats.max) : -1n;
        const vb = b.readyStats ? BigInt(b.readyStats.max) : -1n;
        cmp = va < vb ? -1 : va > vb ? 1 : 0;
        break;
      }
      case 'readyAvg': {
        const va = a.readyStats ? BigInt(a.readyStats.avgFloor) : -1n;
        const vb = b.readyStats ? BigInt(b.readyStats.avgFloor) : -1n;
        cmp = va < vb ? -1 : va > vb ? 1 : 0;
        break;
      }
    }
    if (cmp !== 0) return cmp * dir;
    return a.contextKey.localeCompare(b.contextKey);
  });
}

export function filterMarkerRows(
  rows: readonly TraceMarkerStatsRow[],
  query: string,
): TraceMarkerStatsRow[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...rows];
  return rows.filter(m => {
    const idStr = String(m.markerId);
    const name = (m.name || '').toLowerCase();
    return idStr.includes(needle) || `m#${idStr}`.includes(needle) || name.includes(needle);
  });
}

export interface VirtualScrollMetrics {
  readonly totalRows: number;
  readonly rowHeightPx: number;
  readonly viewportHeightPx: number;
  readonly visibleRowCount: number;
  readonly scrollHeightPx: number;
  readonly maxScrollTopPx: number;
  readonly maxStartRow: number;
}

export const MAX_VIRTUAL_SCROLL_HEIGHT_PX = 2_000_000;

export function computeVirtualScrollMetrics(
  totalRows: number,
  rowHeightPx: number,
  viewportHeightPx: number,
  maxScrollHeightPx = MAX_VIRTUAL_SCROLL_HEIGHT_PX,
): VirtualScrollMetrics {
  const safeTotal = Math.max(0, Math.floor(totalRows));
  const safeRowH = Math.max(12, Math.floor(rowHeightPx));
  const safeVpH = Math.max(safeRowH, Math.floor(viewportHeightPx));
  const visibleRowCount = Math.max(1, Math.ceil(safeVpH / safeRowH) + 2);
  const rawHeight = safeTotal * safeRowH;
  const scrollHeightPx = Math.max(safeVpH, Math.min(maxScrollHeightPx, rawHeight));
  const maxScrollTopPx = Math.max(0, scrollHeightPx - safeVpH);
  const exactVisible = Math.max(1, Math.floor(safeVpH / safeRowH));
  const maxStartRow = Math.max(0, safeTotal - exactVisible);
  return {
    totalRows: safeTotal,
    rowHeightPx: safeRowH,
    viewportHeightPx: safeVpH,
    visibleRowCount,
    scrollHeightPx,
    maxScrollTopPx,
    maxStartRow,
  };
}

export function scrollTopToRowIndex(scrollTop: number, metrics: VirtualScrollMetrics): number {
  if (metrics.maxStartRow <= 0 || metrics.maxScrollTopPx <= 0) return 0;
  const clamped = Math.max(0, Math.min(metrics.maxScrollTopPx, scrollTop));
  const ratio = clamped / metrics.maxScrollTopPx;
  return Math.max(0, Math.min(metrics.maxStartRow, Math.round(ratio * metrics.maxStartRow)));
}

export function rowIndexToScrollTop(rowIndex: number, metrics: VirtualScrollMetrics): number {
  if (metrics.maxStartRow <= 0 || metrics.maxScrollTopPx <= 0) return 0;
  const clamped = Math.max(0, Math.min(metrics.maxStartRow, Math.floor(rowIndex)));
  return Math.round((clamped / metrics.maxStartRow) * metrics.maxScrollTopPx);
}

export function resolveEventTimeStrForUnit(
  ev: Pick<TraceEventDto, 'relTicks' | 'absTicks' | 'ns' | 'sysFreqHz'>,
  unit: TraceTimeUnit,
): string | undefined {
  switch (unit) {
    case 'ns':
      if (ev.ns !== undefined) return ev.ns;
      if (ev.absTicks !== undefined && ev.sysFreqHz && ev.sysFreqHz > 0) {
        return ((BigInt(ev.absTicks) * 1_000_000_000n) / BigInt(ev.sysFreqHz)).toString();
      }
      return undefined;
    case 'relative-ns':
      if (ev.sysFreqHz && ev.sysFreqHz > 0) {
        return ((BigInt(ev.relTicks) * 1_000_000_000n) / BigInt(ev.sysFreqHz)).toString();
      }
      return undefined;
    case 'absolute-ticks':
      return ev.absTicks;
    case 'relative-ticks':
      return ev.relTicks;
  }
}

export interface EventToTimelineJumpPlan {
  readonly ok: boolean;
  readonly reason?: string;
  readonly scopeKey: string;
  readonly unit: TraceTimeUnit;
  readonly timeStr: string;
  readonly viewStart: string;
  readonly viewEnd: string;
  readonly bootGeneration: number;
  readonly segmentId: number;
}

export function computeTimelineJumpForEvent(
  ev: Pick<TraceEventDto, 'bootGeneration' | 'segmentId' | 'relTicks' | 'absTicks' | 'ns' | 'sysFreqHz'>,
  segments: readonly TraceSegmentDto[],
  currentScopeKey: string,
  currentUnit: TraceTimeUnit,
): EventToTimelineJumpPlan {
  const segKey = segmentScopeKey(ev.bootGeneration, ev.segmentId);
  const currentDomain = computeAxisDomain(segments, currentUnit, currentScopeKey);
  const segIncludedInCurrent =
    currentDomain.valid &&
    currentDomain.includedSegments.some(s => s.bootGeneration === ev.bootGeneration && s.segmentId === ev.segmentId);

  let targetScopeKey = segIncludedInCurrent ? currentScopeKey : segKey;
  let targetUnit = currentUnit;
  let targetTimeStr = resolveEventTimeStrForUnit(ev, targetUnit);

  if (!segIncludedInCurrent || targetTimeStr === undefined) {
    targetScopeKey = segKey;
    const segDomain = computeAxisDomain(segments, targetUnit, targetScopeKey);
    if (!segDomain.valid || resolveEventTimeStrForUnit(ev, targetUnit) === undefined) {
      const candidates: TraceTimeUnit[] = ['ns', 'relative-ns', 'absolute-ticks', 'relative-ticks'];
      for (const cand of candidates) {
        const t = resolveEventTimeStrForUnit(ev, cand);
        const d = computeAxisDomain(segments, cand, targetScopeKey);
        if (t !== undefined && d.valid) {
          targetUnit = cand;
          targetTimeStr = t;
          break;
        }
      }
    } else {
      targetTimeStr = resolveEventTimeStrForUnit(ev, targetUnit);
    }
  }

  const finalDomain = computeAxisDomain(segments, targetUnit, targetScopeKey);
  if (!finalDomain.valid || targetTimeStr === undefined) {
    return {
      ok: false,
      reason: finalDomain.reason ?? '无法解析该事件所在段的时间轴坐标',
      scopeKey: targetScopeKey,
      unit: targetUnit,
      timeStr: ev.relTicks,
      viewStart: '0',
      viewEnd: '1',
      bootGeneration: ev.bootGeneration,
      segmentId: ev.segmentId,
    };
  }

  const t = BigInt(targetTimeStr);
  const dMin = BigInt(finalDomain.minStr);
  const dMax = BigInt(finalDomain.displayMaxStr);
  const dSpan = dMax > dMin ? dMax - dMin : 1n;

  const isNs = targetUnit === 'ns' || targetUnit === 'relative-ns';
  const minZoom = isNs ? 20_000n : 20n;
  const maxZoom = isNs ? 5_000_000n : 5_000n;
  let desiredSpan = dSpan / 10n;
  if (desiredSpan < minZoom) desiredSpan = minZoom;
  if (desiredSpan > maxZoom) desiredSpan = maxZoom;
  if (desiredSpan > dSpan) desiredSpan = dSpan;
  if (desiredSpan < 1n) desiredSpan = 1n;

  const half = desiredSpan / 2n;
  let vStart = t - half;
  let vEnd = vStart + desiredSpan;
  if (vStart < dMin) {
    vStart = dMin;
    vEnd = vStart + desiredSpan <= dMax ? vStart + desiredSpan : dMax;
  }
  if (vEnd > dMax) {
    vEnd = dMax;
    vStart = vEnd - desiredSpan >= dMin ? vEnd - desiredSpan : dMin;
  }
  if (vEnd <= vStart) {
    vEnd = vStart + 1n;
  }

  return {
    ok: true,
    scopeKey: finalDomain.scopeKey,
    unit: finalDomain.unit,
    timeStr: t.toString(),
    viewStart: vStart.toString(),
    viewEnd: vEnd.toString(),
    bootGeneration: ev.bootGeneration,
    segmentId: ev.segmentId,
  };
}
