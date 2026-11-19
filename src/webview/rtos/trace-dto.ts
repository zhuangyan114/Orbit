import type { DecodedEventPayload, DecodedSystemViewPacket } from '../../trace/systemview-decoder';
import type {
  ContextActivationInterval,
  ExecutionSliceInterval,
  MarkerInterval,
  MarkerPointEvent,
  ReadyWaitInterval,
  TraceTimePoint,
} from '../../trace/systemview-reconstructor';
import type { SegmentIndexMetadata, StoredGapEntry } from '../../trace/trace-format';
import { ticksToNsBigInt, type TraceLodBucket } from '../../trace/trace-range-index';
import type { TraceRecordingStatus, TraceTargetInspectResult } from '../../trace/trace-recording-coordinator';
import type { OpenRecordingWorkerResult } from '../../trace/trace-worker-protocol';
import type {
  TraceActivationDto,
  TraceGapDto,
  TraceLodBucketDto,
  TraceMarkerDto,
  TraceMarkerPointDto,
  TracePacketSummaryDto,
  TraceReadyWaitDto,
  TraceRecordSummary,
  TraceSegmentDto,
  TraceSliceDto,
  TraceTargetProbeState,
} from './trace-timeline-state';

function computeNsStr(pt: TraceTimePoint | undefined, fallbackFreq?: number): string | undefined {
  if (!pt) return undefined;
  if (pt.timestampNs !== undefined) return pt.timestampNs;
  const freq = pt.sysFreqHz ?? fallbackFreq;
  if (pt.absoluteTicks !== undefined && freq && freq > 0) {
    return ticksToNsBigInt(BigInt(pt.absoluteTicks), freq).toString();
  }
  return undefined;
}

function resolveEndPoint(
  startPt: TraceTimePoint | undefined,
  endPt: TraceTimePoint | undefined,
  observedUntilPt: TraceTimePoint | undefined,
  segMeta?: SegmentIndexMetadata,
): {
  endRelTicks: string;
  endAbsTicks?: string;
  endNs?: string;
  sysFreqHz?: number;
  isEndObservedOnly: boolean;
} {
  const effectiveEnd = endPt ?? observedUntilPt;
  const freq = startPt?.sysFreqHz ?? effectiveEnd?.sysFreqHz ?? segMeta?.sysFreqHz;
  if (effectiveEnd) {
    return {
      endRelTicks: effectiveEnd.relativeTicks,
      endAbsTicks: effectiveEnd.absoluteTicks,
      endNs: computeNsStr(effectiveEnd, freq),
      sysFreqHz: freq,
      isEndObservedOnly: !endPt,
    };
  }
  if (segMeta) {
    const endNs = segMeta.maxNs ?? (segMeta.lastAbsoluteTicks !== undefined && freq && freq > 0
      ? ticksToNsBigInt(BigInt(segMeta.lastAbsoluteTicks), freq).toString()
      : undefined);
    return {
      endRelTicks: segMeta.maxRelativeTicks,
      endAbsTicks: segMeta.lastAbsoluteTicks,
      endNs,
      sysFreqHz: freq,
      isEndObservedOnly: true,
    };
  }
  return {
    endRelTicks: startPt?.relativeTicks ?? '0',
    endAbsTicks: startPt?.absoluteTicks,
    endNs: computeNsStr(startPt, freq),
    sysFreqHz: freq,
    isEndObservedOnly: !endPt,
  };
}

export function projectSegmentDto(seg: SegmentIndexMetadata): TraceSegmentDto {
  return {
    bootGeneration: seg.bootGeneration,
    segmentId: seg.segmentId,
    startByteOffset: seg.startByteOffset,
    ...(seg.endByteOffset !== undefined ? { endByteOffset: seg.endByteOffset } : {}),
    reliability: seg.reliability,
    closed: seg.closed,
    ...(seg.endReason !== undefined ? { endReason: seg.endReason } : {}),
    packetCount: seg.packetCount,
    syncCount: seg.syncCount,
    timestampBits: seg.timestampBits,
    timestampWrapCount: seg.timestampWrapCount,
    timeAnchorStatus: seg.timeAnchorStatus,
    minRelativeTicks: seg.minRelativeTicks,
    maxRelativeTicks: seg.maxRelativeTicks,
    ...(seg.firstAbsoluteTicks !== undefined ? { firstAbsoluteTicks: seg.firstAbsoluteTicks } : {}),
    ...(seg.lastAbsoluteTicks !== undefined ? { lastAbsoluteTicks: seg.lastAbsoluteTicks } : {}),
    ...(seg.sysFreqHz !== undefined ? { sysFreqHz: seg.sysFreqHz } : {}),
    ...(seg.minNs !== undefined ? { minNs: seg.minNs } : {}),
    ...(seg.maxNs !== undefined ? { maxNs: seg.maxNs } : {}),
  };
}

export function projectGapDto(gap: StoredGapEntry): TraceGapDto {
  return {
    seq: gap.seq,
    bootGeneration: gap.bootGeneration,
    kind: gap.kind,
    ...(gap.segmentIdBefore !== undefined ? { segmentIdBefore: gap.segmentIdBefore } : {}),
    byteOffset: gap.byteOffset,
    droppedPackets: gap.droppedPackets,
    droppedBytes: gap.droppedBytes,
    reason: gap.reason,
    ...(gap.preservesFraming !== undefined ? { preservesFraming: gap.preservesFraming } : {}),
    ...(gap.closedOpenCount !== undefined ? { closedOpenCount: gap.closedOpenCount } : {}),
  };
}

export function projectLodBucketDto(b: TraceLodBucket): TraceLodBucketDto {
  return {
    bucketIndex: b.bucketIndex,
    bootGeneration: b.bootGeneration,
    segmentId: b.segmentId,
    unit: b.unit as TraceLodBucketDto['unit'],
    start: b.start,
    end: b.end,
    packetCount: b.packetCount,
    intervalCount: b.intervalCount,
    markerCount: b.markerCount,
    hasGap: b.hasGap,
    gapKinds: b.gapKinds,
    hasIncomplete: b.hasIncomplete,
    hasUncertain: b.hasUncertain,
    activeTicksByKind: b.activeTicksByKind,
    ...(b.dominantContext ? { dominantContext: b.dominantContext } : {}),
  };
}

export function projectSliceDto(
  sl: ExecutionSliceInterval,
  segMap: ReadonlyMap<string, SegmentIndexMetadata>,
): TraceSliceDto {
  const seg = segMap.get(`${sl.bootGeneration}:${sl.segmentId}`);
  const endResolved = resolveEndPoint(sl.start, sl.end, sl.observedUntil, seg);
  return {
    sliceId: sl.sliceId,
    bootGeneration: sl.bootGeneration,
    segmentId: sl.segmentId,
    segmentReliability: sl.segmentReliability,
    completeness: sl.completeness,
    contextKind: sl.contextKind,
    contextKey: sl.contextKey,
    ...(sl.taskInstanceId !== undefined ? { taskInstanceId: sl.taskInstanceId } : {}),
    ...(sl.tcbAddress !== undefined ? { tcbAddress: sl.tcbAddress } : {}),
    ...(sl.irqId !== undefined ? { irqId: sl.irqId } : {}),
    isrDepth: sl.isrDepth,
    ...(sl.label !== undefined ? { label: sl.label } : {}),
    labelSource: sl.labelSource,
    startRelTicks: sl.start?.relativeTicks ?? '0',
    endRelTicks: endResolved.endRelTicks,
    ...(sl.start?.absoluteTicks !== undefined ? { startAbsTicks: sl.start.absoluteTicks } : {}),
    ...(endResolved.endAbsTicks !== undefined ? { endAbsTicks: endResolved.endAbsTicks } : {}),
    ...(computeNsStr(sl.start, endResolved.sysFreqHz) !== undefined
      ? { startNs: computeNsStr(sl.start, endResolved.sysFreqHz) }
      : {}),
    ...(endResolved.endNs !== undefined ? { endNs: endResolved.endNs } : {}),
    ...(endResolved.sysFreqHz !== undefined ? { sysFreqHz: endResolved.sysFreqHz } : {}),
    ...(sl.durationTicks !== undefined ? { durationTicks: sl.durationTicks } : {}),
    ...(sl.durationNs !== undefined ? { durationNs: sl.durationNs } : {}),
    isEndObservedOnly: endResolved.isEndObservedOnly,
    timeDomain: sl.timeDomain,
    startReason: sl.startReason,
    ...(sl.endReason !== undefined ? { endReason: sl.endReason } : {}),
    ...(sl.start?.streamByteOffset !== undefined ? { streamByteOffset: sl.start.streamByteOffset } : {}),
  };
}

export function projectActivationDto(
  act: ContextActivationInterval,
  segMap: ReadonlyMap<string, SegmentIndexMetadata>,
): TraceActivationDto {
  const seg = segMap.get(`${act.bootGeneration}:${act.segmentId}`);
  const endResolved = resolveEndPoint(act.start, act.end, act.observedUntil, seg);
  return {
    activationId: act.activationId,
    bootGeneration: act.bootGeneration,
    segmentId: act.segmentId,
    segmentReliability: act.segmentReliability,
    completeness: act.completeness,
    kind: act.kind,
    contextKey: act.contextKey,
    ...(act.taskInstanceId !== undefined ? { taskInstanceId: act.taskInstanceId } : {}),
    ...(act.irqId !== undefined ? { irqId: act.irqId } : {}),
    ...(act.isrDepth !== undefined ? { isrDepth: act.isrDepth } : {}),
    ...(act.timerId !== undefined ? { timerId: act.timerId } : {}),
    ...(act.label !== undefined ? { label: act.label } : {}),
    labelSource: act.labelSource,
    startRelTicks: act.start?.relativeTicks ?? '0',
    endRelTicks: endResolved.endRelTicks,
    ...(act.start?.absoluteTicks !== undefined ? { startAbsTicks: act.start.absoluteTicks } : {}),
    ...(endResolved.endAbsTicks !== undefined ? { endAbsTicks: endResolved.endAbsTicks } : {}),
    ...(computeNsStr(act.start, endResolved.sysFreqHz) !== undefined
      ? { startNs: computeNsStr(act.start, endResolved.sysFreqHz) }
      : {}),
    ...(endResolved.endNs !== undefined ? { endNs: endResolved.endNs } : {}),
    ...(endResolved.sysFreqHz !== undefined ? { sysFreqHz: endResolved.sysFreqHz } : {}),
    ...(act.inclusiveDurationTicks !== undefined ? { inclusiveDurationTicks: act.inclusiveDurationTicks } : {}),
    ...(act.exclusiveDurationTicks !== undefined ? { exclusiveDurationTicks: act.exclusiveDurationTicks } : {}),
    ...(act.preemptedDurationTicks !== undefined ? { preemptedDurationTicks: act.preemptedDurationTicks } : {}),
    ...(act.inclusiveDurationNs !== undefined ? { inclusiveDurationNs: act.inclusiveDurationNs } : {}),
    ...(act.exclusiveDurationNs !== undefined ? { exclusiveDurationNs: act.exclusiveDurationNs } : {}),
    preemptionCount: act.preemptionCount,
    ...(act.readyChainStatus !== undefined ? { readyChainStatus: act.readyChainStatus } : {}),
    ...(act.matchedReadyWaitId !== undefined ? { matchedReadyWaitId: act.matchedReadyWaitId } : {}),
    isEndObservedOnly: endResolved.isEndObservedOnly,
    ...(act.endReason !== undefined ? { endReason: act.endReason } : {}),
  };
}

export function projectReadyWaitDto(
  rw: ReadyWaitInterval,
  segMap: ReadonlyMap<string, SegmentIndexMetadata>,
): TraceReadyWaitDto {
  const seg = segMap.get(`${rw.bootGeneration}:${rw.segmentId}`);
  const endResolved = resolveEndPoint(rw.start, rw.end, rw.observedUntil, seg);
  return {
    waitId: rw.waitId,
    bootGeneration: rw.bootGeneration,
    segmentId: rw.segmentId,
    segmentReliability: rw.segmentReliability,
    completeness: rw.completeness,
    outcome: rw.outcome,
    taskInstanceId: rw.taskInstanceId,
    ...(rw.tcbAddress !== undefined ? { tcbAddress: rw.tcbAddress } : {}),
    ...(rw.label !== undefined ? { label: rw.label } : {}),
    labelSource: rw.labelSource,
    startRelTicks: rw.start?.relativeTicks ?? '0',
    endRelTicks: endResolved.endRelTicks,
    ...(rw.start?.absoluteTicks !== undefined ? { startAbsTicks: rw.start.absoluteTicks } : {}),
    ...(endResolved.endAbsTicks !== undefined ? { endAbsTicks: endResolved.endAbsTicks } : {}),
    ...(computeNsStr(rw.start, endResolved.sysFreqHz) !== undefined
      ? { startNs: computeNsStr(rw.start, endResolved.sysFreqHz) }
      : {}),
    ...(endResolved.endNs !== undefined ? { endNs: endResolved.endNs } : {}),
    ...(endResolved.sysFreqHz !== undefined ? { sysFreqHz: endResolved.sysFreqHz } : {}),
    ...(rw.durationTicks !== undefined ? { durationTicks: rw.durationTicks } : {}),
    ...(rw.durationNs !== undefined ? { durationNs: rw.durationNs } : {}),
    ...(rw.readyToRunningTicks !== undefined ? { readyToRunningTicks: rw.readyToRunningTicks } : {}),
    ...(rw.stopCause !== undefined ? { stopCause: rw.stopCause } : {}),
    isEndObservedOnly: endResolved.isEndObservedOnly,
    ...(rw.endReason !== undefined ? { endReason: rw.endReason } : {}),
  };
}

export function projectMarkerDto(
  m: MarkerInterval,
  segMap: ReadonlyMap<string, SegmentIndexMetadata>,
): TraceMarkerDto {
  const seg = segMap.get(`${m.bootGeneration}:${m.segmentId}`);
  const endResolved = resolveEndPoint(m.start, m.end, m.observedUntil, seg);
  return {
    markerInstanceId: m.markerInstanceId,
    bootGeneration: m.bootGeneration,
    segmentId: m.segmentId,
    segmentReliability: m.segmentReliability,
    completeness: m.completeness,
    markerId: m.markerId,
    ...(m.name !== undefined ? { name: m.name } : {}),
    nameSource: m.nameSource,
    startRelTicks: m.start?.relativeTicks ?? '0',
    endRelTicks: endResolved.endRelTicks,
    ...(m.start?.absoluteTicks !== undefined ? { startAbsTicks: m.start.absoluteTicks } : {}),
    ...(endResolved.endAbsTicks !== undefined ? { endAbsTicks: endResolved.endAbsTicks } : {}),
    ...(computeNsStr(m.start, endResolved.sysFreqHz) !== undefined
      ? { startNs: computeNsStr(m.start, endResolved.sysFreqHz) }
      : {}),
    ...(endResolved.endNs !== undefined ? { endNs: endResolved.endNs } : {}),
    ...(endResolved.sysFreqHz !== undefined ? { sysFreqHz: endResolved.sysFreqHz } : {}),
    ...(m.durationTicks !== undefined ? { durationTicks: m.durationTicks } : {}),
    ...(m.durationNs !== undefined ? { durationNs: m.durationNs } : {}),
    ...(m.startContextKey !== undefined ? { startContextKey: m.startContextKey } : {}),
    ...(m.endContextKey !== undefined ? { endContextKey: m.endContextKey } : {}),
    isEndObservedOnly: endResolved.isEndObservedOnly,
    ...(m.endReason !== undefined ? { endReason: m.endReason } : {}),
  };
}

export function projectMarkerPointDto(
  mp: MarkerPointEvent,
  segMap: ReadonlyMap<string, SegmentIndexMetadata>,
): TraceMarkerPointDto {
  const seg = segMap.get(`${mp.bootGeneration}:${mp.segmentId}`);
  const freq = mp.time.sysFreqHz ?? seg?.sysFreqHz;
  const ns = computeNsStr(mp.time, freq);
  return {
    bootGeneration: mp.bootGeneration,
    segmentId: mp.segmentId,
    segmentReliability: mp.segmentReliability,
    markerId: mp.markerId,
    ...(mp.name !== undefined ? { name: mp.name } : {}),
    nameSource: mp.nameSource,
    relTicks: mp.time.relativeTicks,
    ...(mp.time.absoluteTicks !== undefined ? { absTicks: mp.time.absoluteTicks } : {}),
    ...(ns !== undefined ? { ns } : {}),
    ...(freq !== undefined ? { sysFreqHz: freq } : {}),
    ...(mp.contextKey !== undefined ? { contextKey: mp.contextKey } : {}),
    streamByteOffset: mp.time.streamByteOffset,
  };
}

function summarizePacketPayload(decoded: DecodedEventPayload): string {
  switch (decoded.kind) {
    case 'isr-enter':
      return `irqId=${decoded.irqId}`;
    case 'task-start-exec':
    case 'task-start-ready':
    case 'task-create':
    case 'task-terminate':
      return decoded.taskId !== undefined ? `task=0x${decoded.taskId.toString(16)}` : `shrunk=${decoded.shrunkTaskId}`;
    case 'task-stop-ready':
      return `${decoded.taskId !== undefined ? `0x${decoded.taskId.toString(16)}` : `shrunk=${decoded.shrunkTaskId}`} cause=${decoded.cause}`;
    case 'task-info':
      return `${decoded.name} (prio=${decoded.priority})`;
    case 'mark-start':
    case 'mark-stop':
    case 'ex-mark':
      return `markerId=${decoded.markerId}`;
    case 'ex-name-marker':
      return `markerId=${decoded.markerId} name=${decoded.name}`;
    case 'overflow':
      return `rawDropCount=${decoded.rawDropCount}${decoded.minDroppedPackets ? ` minDropped=${decoded.minDroppedPackets}` : ''}`;
    case 'init':
      return `sysFreq=${decoded.sysFreqHz}Hz ramBase=0x${decoded.ramBaseAddress.toString(16)}`;
    case 'systime-cycles':
      return `cycles=${decoded.cycles}`;
    case 'systime-us':
      return `us=${decoded.systimeUs}`;
    case 'os-freertos':
      return decoded.apiName ?? `apiId=${decoded.apiId}`;
    case 'print-formatted':
      return decoded.text.slice(0, 80);
    case 'sysdesc':
      return decoded.rawText.slice(0, 80);
    default:
      return decoded.kind;
  }
}

export function projectPacketDto(
  pkt: DecodedSystemViewPacket,
  segMap: ReadonlyMap<string, SegmentIndexMetadata>,
  bootGeneration?: number,
): TracePacketSummaryDto {
  const seg = bootGeneration !== undefined ? segMap.get(`${bootGeneration}:${pkt.segmentId}`) : undefined;
  const freq = pkt.sysFreqHz ?? seg?.sysFreqHz;
  const ns = pkt.timestampNs ?? (pkt.absoluteTicks !== undefined && freq && freq > 0
    ? ticksToNsBigInt(BigInt(pkt.absoluteTicks), freq).toString()
    : undefined);
  return {
    packetIndexInSegment: pkt.packetIndexInSegment,
    ...(bootGeneration !== undefined ? { bootGeneration } : {}),
    segmentId: pkt.segmentId,
    eventId: pkt.eventId,
    eventName: pkt.eventName,
    relTicks: pkt.segmentRelativeTicks,
    ...(pkt.absoluteTicks !== undefined ? { absTicks: pkt.absoluteTicks } : {}),
    ...(ns !== undefined ? { ns } : {}),
    ...(freq !== undefined ? { sysFreqHz: freq } : {}),
    streamByteOffset: pkt.streamByteOffset,
    byteLength: pkt.byteLength,
    summary: summarizePacketPayload(pkt.decoded),
  };
}

export function projectTargetProbeState(res: TraceTargetInspectResult, nowMs = Date.now()): TraceTargetProbeState {
  const up = res.enumerate?.upBuffers.find(b => b.valid && b.nameStatus === 'ok' && b.name === 'SysView');
  const down = res.enumerate?.downBuffers.find(b => b.valid && b.nameStatus === 'ok' && b.name === 'SysView');
  const binaryBudget = res.rttBudgets?.binaryChannel;
  const adequacy = binaryBudget
    ? (binaryBudget.transport === 'hid' || binaryBudget.transport === 'rmlink-service' || binaryBudget.maxBatchBytes <= 512
      ? 'limited'
      : 'adequate')
    : 'unknown';
  return {
    ok: res.ok,
    ...(res.errorCode ? { errorCode: res.errorCode } : {}),
    ...(res.message ? { message: res.message } : {}),
    ...(res.targetState ? { targetState: res.targetState } : {}),
    ...(res.ownerKind ? { ownerKind: res.ownerKind } : {}),
    ...(res.transportKind ? { transportKind: res.transportKind } : {}),
    ...(res.enumerate ? {
      sysViewUpFound: Boolean(up),
      sysViewDownFound: Boolean(down),
      upChannelIndex: up?.index,
      downChannelIndex: down?.index,
      upBufferSize: up?.bufferSize,
    } : {}),
    ...(res.metadataLayout?.globals?.postMortemCompiled !== undefined
      ? { postMortemCompiled: res.metadataLayout.globals.postMortemCompiled }
      : {}),
    ...(res.globalsValues?.enableState !== undefined ? { enableState: res.globalsValues.enableState } : {}),
    ...(res.globalsValues?.dropCount !== undefined ? { dropCount: res.globalsValues.dropCount } : {}),
    ...(res.ramRangesAvailable !== undefined ? { ramRangesAvailable: res.ramRangesAvailable } : {}),
    ...(res.rttCapabilities ? { rttDownWriteAvailable: res.rttCapabilities.rttDownWrite.available } : {}),
    transportAdequacy: adequacy,
    inspectedAtMs: nowMs,
  };
}

export function projectRecordFromStatus(
  status: TraceRecordingStatus,
  source: 'live' | 'session',
  segments: readonly SegmentIndexMetadata[],
  gaps: readonly StoredGapEntry[],
): TraceRecordSummary {
  return {
    recordId: status.recordId,
    source,
    mode: status.mode,
    ...(status.recordingDir ? { recordingDir: status.recordingDir } : {}),
    state: status.state,
    ...(status.phaseDetail ? { phaseDetail: status.phaseDetail } : {}),
    stateReason: status.stateReason,
    targetState: status.targetState,
    integrity: status.integrity,
    transportAdequacy: status.transportAdequacy,
    ...(status.channelInfo ? { channelInfo: status.channelInfo } : {}),
    ...(status.freezeEvidence ? { freezeEvidence: status.freezeEvidence } : {}),
    counters: status.counters,
    ...(status.error ? { error: status.error } : {}),
    ...(status.startedAtMs !== undefined ? { startedAtMs: status.startedAtMs } : {}),
    ...(status.stoppedAtMs !== undefined ? { stoppedAtMs: status.stoppedAtMs } : {}),
    ...(status.manifest?.nonStandardNotice ? { nonStandardNotice: status.manifest.nonStandardNotice } : {}),
    ...(status.manifest?.formatVersion ? { formatVersion: status.manifest.formatVersion } : {}),
    segments: segments.map(projectSegmentDto),
    gaps: gaps.map(projectGapDto),
  };
}

export function projectRecordFromOpened(
  opened: OpenRecordingWorkerResult,
  recordingDir: string,
  segments: readonly SegmentIndexMetadata[],
  gaps: readonly StoredGapEntry[],
): TraceRecordSummary {
  const { inspection, stats } = opened;
  const manifest = inspection.manifest;
  const diagText = inspection.diagnostics.map(d => `${d.code}: ${d.message}`).join('; ');
  const stateReason = manifest?.closeReason
    || (inspection.status === 'completed'
      ? `离线打开 (${stats.committed.rawBytes} B, ${stats.committed.packetCount} 包)`
      : diagText || `状态: ${inspection.status}`);
  return {
    recordId: opened.recordId,
    source: 'offline',
    recordingDir,
    state: inspection.status,
    inspectionStatus: inspection.status,
    stateReason,
    integrity: gaps.some(g => g.kind === 'target-overflow')
      ? 'target-overflow'
      : gaps.some(g => g.kind === 'prefix-overwritten')
        ? 'prefix-overwritten'
        : inspection.status === 'completed' || inspection.recoveryDisposition === 'rebuilt-bad-index'
          ? 'complete'
          : 'incomplete',
    counters: {
      bytesReceived: stats.committed.rawBytes,
      committedRawBytes: stats.committed.rawBytes,
      batchesReceived: stats.committed.commitSeq,
      packetsDecoded: stats.committed.packetCount,
      sliceCount: stats.committed.sliceCount,
      gapCount: stats.committed.gapCount,
      segmentCount: stats.committed.segmentCount,
      targetOverruns: gaps.filter(g => g.kind === 'target-overflow').length,
      hostDroppedBytes: 0,
      transportDroppedBytes: 0,
      backpressurePauses: 0,
      preStartDrainedBytes: 0,
    },
    ...(manifest?.failureCode ? {
      error: {
        errorCode: manifest.failureCode,
        message: manifest.closeReason || diagText || manifest.failureCode,
        diagnostics: manifest.failureDiagnostics,
      },
    } : inspection.diagnostics.length > 0 ? {
      error: {
        errorCode: inspection.diagnostics[0].code,
        message: diagText,
      },
    } : {}),
    ...(manifest?.createdAtMs ? { startedAtMs: manifest.createdAtMs } : {}),
    ...(manifest?.closedAtMs ? { stoppedAtMs: manifest.closedAtMs } : {}),
    ...(manifest?.nonStandardNotice ? { nonStandardNotice: manifest.nonStandardNotice } : {}),
    ...(manifest?.formatVersion ? { formatVersion: manifest.formatVersion } : {}),
    indexStatus: inspection.indexStatus,
    recoveryDisposition: inspection.recoveryDisposition,
    hasCommittedChunkCorruption: inspection.hasCommittedChunkCorruption,
    rawSha256Verified: inspection.rawSha256Verified,
    actualRawFileBytes: inspection.actualRawFileBytes,
    ...(inspection.diagnostics.length > 0
      ? {
          inspectionDiagnostics: inspection.diagnostics.map(d => ({
            code: d.code,
            file: d.file,
            ...(d.offset !== undefined ? { offset: d.offset } : {}),
            message: d.message,
          })),
        }
      : {}),
    recoverableRawBytes: inspection.recoverableRawBytes,
    uncommittedTailBytes: inspection.uncommittedTrailingRawBytes,
    segments: segments.map(projectSegmentDto),
    gaps: gaps.map(projectGapDto),
  };
}
