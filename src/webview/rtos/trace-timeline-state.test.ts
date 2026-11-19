import { describe, expect, it } from 'vitest';
import {
  bigIntToPixelX,
  buildSwimlaneLayout,
  computeAxisDomain,
  evaluateCursorSpanContinuity,
  formatTraceTimestamp,
  panBigIntRange,
  pixelXToBigInt,
  resolveGapAnchors,
  zoomBigIntRange,
  type TraceActivationDto,
  type TraceGapDto,
  type TraceMarkerDto,
  type TraceReadyWaitDto,
  type TraceSegmentDto,
  type TraceSliceDto,
} from './trace-timeline-state';

function makeSeg(over: Partial<TraceSegmentDto> & { segmentId: number }): TraceSegmentDto {
  return {
    bootGeneration: over.bootGeneration ?? 1,
    segmentId: over.segmentId,
    startByteOffset: over.startByteOffset ?? 0,
    endByteOffset: over.endByteOffset ?? 100,
    reliability: over.reliability ?? 'trusted',
    closed: over.closed ?? true,
    packetCount: over.packetCount ?? 10,
    syncCount: over.syncCount ?? 1,
    timestampBits: over.timestampBits ?? 32,
    timestampWrapCount: over.timestampWrapCount ?? 0,
    timeAnchorStatus: over.timeAnchorStatus ?? 'anchored-cycles',
    minRelativeTicks: over.minRelativeTicks ?? '0',
    maxRelativeTicks: over.maxRelativeTicks ?? '1000',
    firstAbsoluteTicks: over.firstAbsoluteTicks,
    lastAbsoluteTicks: over.lastAbsoluteTicks,
    sysFreqHz: over.sysFreqHz,
    minNs: over.minNs,
    maxNs: over.maxNs,
  };
}

describe('Trace Timeline 状态与 BigInt 几何计算 (阶段 4.5)', () => {
  it('在 > 2^53 大整数时间戳下保持 pixel <-> bigint 映射与缩放平移精度', () => {
    const base = 18_000_000_000_000_000n; // > Number.MAX_SAFE_INTEGER (9.007e15)
    const viewStart = base;
    const viewEnd = base + 1000n;
    const width = 1000;

    const midX = bigIntToPixelX(base + 250n, viewStart, viewEnd, width);
    expect(midX).toBeCloseTo(250, 2);

    const roundTrip = pixelXToBigInt(250, viewStart, viewEnd, width);
    expect(roundTrip).toBe(base + 250n);

    const zoomed = zoomBigIntRange(viewStart, viewEnd, base + 500n, 0.5, { min: base, max: base + 2000n }, 10n);
    expect(zoomed.end - zoomed.start).toBe(500n);
    expect(zoomed.start).toBe(base + 250n);
    expect(zoomed.end).toBe(base + 750n);

    const panned = panBigIntRange(zoomed.start, zoomed.end, -400n, { min: base, max: base + 2000n });
    expect(panned.start).toBe(base);
    expect(panned.end).toBe(base + 500n);
  });

  it('隔离未锚定段与跨复位段，绝不将归零相对时间戳误并到同一连续轴', () => {
    const seg1 = makeSeg({
      bootGeneration: 1,
      segmentId: 1,
      timeAnchorStatus: 'unanchored',
      minRelativeTicks: '0',
      maxRelativeTicks: '500',
      sysFreqHz: 1_000_000,
    });
    const seg2 = makeSeg({
      bootGeneration: 1,
      segmentId: 2,
      timeAnchorStatus: 'unanchored',
      minRelativeTicks: '0',
      maxRelativeTicks: '800',
      sysFreqHz: 1_000_000,
    });

    const domain = computeAxisDomain([seg1, seg2], 'ns', 'all-anchored');
    expect(domain.valid).toBe(true);
    // Unanchored multi-segment must scope to single segment instead of overlapping both at t=0
    expect(domain.includedSegments).toHaveLength(1);
    expect(domain.includedSegments[0].segmentId).toBe(2);
    expect(domain.skippedSegments).toHaveLength(1);
    expect(domain.unit).toBe('relative-ns');

    // Anchored segments in same boot can share continuous ns axis
    const anchored1 = makeSeg({
      bootGeneration: 1,
      segmentId: 1,
      firstAbsoluteTicks: '1000',
      lastAbsoluteTicks: '2000',
      sysFreqHz: 1_000_000,
      minNs: '1000000',
      maxNs: '2000000',
    });
    const anchored2 = makeSeg({
      bootGeneration: 1,
      segmentId: 2,
      firstAbsoluteTicks: '3000',
      lastAbsoluteTicks: '4000',
      sysFreqHz: 1_000_000,
      minNs: '3000000',
      maxNs: '4000000',
    });
    const anchoredDomain = computeAxisDomain([anchored1, anchored2], 'ns', 'all-anchored');
    expect(anchoredDomain.includedSegments).toHaveLength(2);
    expect(anchoredDomain.unit).toBe('ns');
    expect(anchoredDomain.minStr).toBe('1000000');
    expect(anchoredDomain.maxStr).toBe('4000000');
  });

  it('解析缺口锚点并拒绝跨缺口、跨段或不可信段计算 A/B 连续区间', () => {
    const seg1 = makeSeg({
      bootGeneration: 1,
      segmentId: 1,
      firstAbsoluteTicks: '100',
      lastAbsoluteTicks: '500',
      sysFreqHz: 1_000_000,
      minNs: '100000',
      maxNs: '500000',
    });
    const seg2 = makeSeg({
      bootGeneration: 1,
      segmentId: 2,
      firstAbsoluteTicks: '900',
      lastAbsoluteTicks: '1500',
      sysFreqHz: 1_000_000,
      minNs: '900000',
      maxNs: '1500000',
    });
    const gap: TraceGapDto = {
      seq: 1,
      bootGeneration: 1,
      kind: 'target-overflow',
      segmentIdBefore: 1,
      byteOffset: 200,
      droppedPackets: 12,
      droppedBytes: 'unknown',
      reason: 'buffer full',
    };

    const anchors = resolveGapAnchors([seg1, seg2], [gap], 'ns', 1);
    expect(anchors).toHaveLength(1);
    expect(anchors[0].positionKind).toBe('between-segments');
    expect(anchors[0].start).toBe('500000');
    expect(anchors[0].end).toBe('900000');

    // Same segment continuous Δt succeeds
    const sameSeg = evaluateCursorSpanContinuity(
      { timeStr: '150000', unit: 'ns', bootGeneration: 1, segmentId: 1, inspect: null },
      { timeStr: '400000', unit: 'ns', bootGeneration: 1, segmentId: 1, inspect: null },
      [seg1, seg2],
      [gap],
      'ns',
    );
    expect(sameSeg.continuous).toBe(true);
    expect(sameSeg.deltaRaw).toBe('250000');
    expect(sameSeg.deltaFormatted).toBe('250.000 µs');

    // Cross-gap / cross-segment Δt is explicitly rejected
    const crossGap = evaluateCursorSpanContinuity(
      { timeStr: '200000', unit: 'ns', bootGeneration: 1, segmentId: 1, inspect: null },
      { timeStr: '1100000', unit: 'ns', bootGeneration: 1, segmentId: 2, inspect: null },
      [seg1, seg2],
      [gap],
      'ns',
    );
    expect(crossGap.continuous).toBe(false);
    expect(crossGap.deltaFormatted).toBe('不可计算连续区间');
    expect(crossGap.blockingReasons.some(r => r.includes('target-overflow'))).toBe(true);
    expect(crossGap.blockingReasons.some(r => r.includes('seg 1 → seg 2'))).toBe(true);

    // Uncertain segment Δt is also rejected
    const uncertainSeg = makeSeg({
      bootGeneration: 1,
      segmentId: 1,
      reliability: 'uncertain',
      firstAbsoluteTicks: '100',
      lastAbsoluteTicks: '500',
      sysFreqHz: 1_000_000,
      minNs: '100000',
      maxNs: '500000',
    });
    const uncertainEval = evaluateCursorSpanContinuity(
      { timeStr: '150000', unit: 'ns', bootGeneration: 1, segmentId: 1, inspect: null },
      { timeStr: '300000', unit: 'ns', bootGeneration: 1, segmentId: 1, inspect: null },
      [uncertainSeg],
      [],
      'ns',
    );
    expect(uncertainEval.continuous).toBe(false);
    expect(uncertainEval.blockingReasons.some(r => r.includes('uncertain'))).toBe(true);
  });

  it('按 ISR、Scheduler、Task/Idle、Ready 与 Marker 正确构建泳道并格式化时间', () => {
    const slices: TraceSliceDto[] = [
      {
        sliceId: 's1',
        bootGeneration: 1,
        segmentId: 1,
        segmentReliability: 'trusted',
        completeness: 'complete',
        contextKind: 'task',
        contextKey: 'task:1',
        taskInstanceId: 'task-1',
        tcbAddress: 0x20001000,
        isrDepth: 0,
        label: 'worker',
        labelSource: 'task-info',
        startRelTicks: '10',
        endRelTicks: '50',
        isEndObservedOnly: false,
        timeDomain: 'anchored-ticks',
        startReason: 'task-start-exec',
      },
      {
        sliceId: 's2',
        bootGeneration: 1,
        segmentId: 1,
        segmentReliability: 'trusted',
        completeness: 'complete',
        contextKind: 'idle',
        contextKey: 'idle',
        isrDepth: 0,
        label: 'IDLE',
        labelSource: 'fixed-idle',
        startRelTicks: '50',
        endRelTicks: '100',
        isEndObservedOnly: false,
        timeDomain: 'anchored-ticks',
        startReason: 'idle',
      },
    ];
    const acts: TraceActivationDto[] = [
      {
        activationId: 'a1',
        bootGeneration: 1,
        segmentId: 1,
        segmentReliability: 'trusted',
        completeness: 'complete',
        kind: 'isr',
        contextKey: 'isr:18',
        irqId: 18,
        isrDepth: 2,
        label: 'DMA1',
        labelSource: 'sysdesc',
        startRelTicks: '20',
        endRelTicks: '25',
        preemptionCount: 0,
        isEndObservedOnly: false,
      },
      {
        activationId: 'a2',
        bootGeneration: 1,
        segmentId: 1,
        segmentReliability: 'trusted',
        completeness: 'complete',
        kind: 'isr',
        contextKey: 'isr:17',
        irqId: 17,
        isrDepth: 1,
        label: 'SysTick',
        labelSource: 'sysdesc',
        startRelTicks: '15',
        endRelTicks: '35',
        preemptionCount: 1,
        isEndObservedOnly: false,
      },
    ];
    const readyWaits: TraceReadyWaitDto[] = [
      {
        waitId: 'rw1',
        bootGeneration: 1,
        segmentId: 1,
        segmentReliability: 'trusted',
        completeness: 'complete',
        outcome: 'dispatched',
        taskInstanceId: 'task-1',
        label: 'worker',
        labelSource: 'task-info',
        startRelTicks: '5',
        endRelTicks: '10',
        isEndObservedOnly: false,
      },
    ];
    const markers: TraceMarkerDto[] = [
      {
        markerInstanceId: 'm1',
        bootGeneration: 1,
        segmentId: 1,
        segmentReliability: 'trusted',
        completeness: 'complete',
        markerId: 3,
        name: 'frame',
        nameSource: 'ex-name-marker',
        startRelTicks: '12',
        endRelTicks: '40',
        isEndObservedOnly: false,
      },
    ];

    const rows = buildSwimlaneLayout(slices, acts, readyWaits, markers, []);
    expect(rows.map(r => r.kind)).toEqual(['overview', 'isr', 'isr', 'task', 'task', 'markers']);
    expect(rows[1].irqId).toBe(17);
    expect(rows[2].irqId).toBe(18);
    expect(rows[3].label).toBe('worker');
    expect(rows[4].label).toBe('IDLE');
    expect(formatTraceTimestamp('1500000', 'ns')).toBe('1.500 ms');
    expect(formatTraceTimestamp('4200', 'relative-ticks')).toBe('4200 ticks');
  });
});
