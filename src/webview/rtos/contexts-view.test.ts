import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TraceAnalysisQueryResult } from '../../trace/trace-analytics';
import { ContextsView } from './contexts-view';
import { DEFAULT_RTOS_VIEW_SETTINGS, INITIAL_TRACE_PANEL_STATE } from './rtos-view-state';
import {
  computeAxisDomain,
  filterAndSortContextRows,
  filterMarkerRows,
  formatAnalysisDurationStr,
  resolveContextsAnalysisRange,
  type TraceGapDto,
  type TraceSegmentDto,
} from './trace-timeline-state';

function makeSegment(overrides: Partial<TraceSegmentDto> = {}): TraceSegmentDto {
  return {
    bootGeneration: 1,
    segmentId: 1,
    startByteOffset: 0,
    endByteOffset: 200,
    reliability: 'trusted',
    closed: true,
    packetCount: 10,
    syncCount: 1,
    timestampBits: 32,
    timestampWrapCount: 0,
    timeAnchorStatus: 'anchored-cycles',
    minRelativeTicks: '0',
    maxRelativeTicks: '1000',
    firstAbsoluteTicks: '1000',
    lastAbsoluteTicks: '2000',
    sysFreqHz: 1_000_000,
    minNs: '1000000',
    maxNs: '2000000',
    ...overrides,
  };
}

describe('Contexts & CPU Load 视图状态与渲染 (阶段 5.1)', () => {
  it('在缺少任一游标、零长度选区或跨缺口时正确拒绝默认零等待并保留阻断原因', () => {
    const seg1 = makeSegment({ segmentId: 1, minNs: '1000000', maxNs: '1500000', firstAbsoluteTicks: '1000', lastAbsoluteTicks: '1500' });
    const seg2 = makeSegment({ segmentId: 2, minNs: '1600000', maxNs: '2000000', firstAbsoluteTicks: '1600', lastAbsoluteTicks: '2000' });
    const gap: TraceGapDto = {
      seq: 1,
      bootGeneration: 1,
      kind: 'target-overflow',
      segmentIdBefore: 1,
      byteOffset: 100,
      droppedPackets: 'unknown',
      droppedBytes: 'unknown',
      reason: 'overflow',
    };
    const domain = computeAxisDomain([seg1, seg2], 'ns', 'all-anchored');

    const noCursors = resolveContextsAnalysisRange({
      axisDomain: domain,
      viewRange: { start: '1000000', end: '2000000' },
      cursorA: null,
      cursorB: null,
      segments: [seg1, seg2],
      gaps: [gap],
      sourceKind: 'selection',
    });
    expect(noCursors.valid).toBe(false);
    expect(noCursors.missingEndpoint).toBe('both');

    const onlyA = resolveContextsAnalysisRange({
      axisDomain: domain,
      viewRange: { start: '1000000', end: '2000000' },
      cursorA: { timeStr: '1200000', unit: 'ns', bootGeneration: 1, segmentId: 1 },
      cursorB: null,
      segments: [seg1, seg2],
      gaps: [gap],
      sourceKind: 'selection',
    });
    expect(onlyA.valid).toBe(false);
    expect(onlyA.missingEndpoint).toBe('B');

    const zeroSpan = resolveContextsAnalysisRange({
      axisDomain: domain,
      viewRange: null,
      cursorA: { timeStr: '1200000', unit: 'ns', bootGeneration: 1, segmentId: 1 },
      cursorB: { timeStr: '1200000', unit: 'ns', bootGeneration: 1, segmentId: 1 },
      segments: [seg1, seg2],
      gaps: [gap],
      sourceKind: 'selection',
    });
    expect(zeroSpan.valid).toBe(false);

    const crossGap = resolveContextsAnalysisRange({
      axisDomain: domain,
      viewRange: null,
      cursorA: { timeStr: '1200000', unit: 'ns', bootGeneration: 1, segmentId: 1 },
      cursorB: { timeStr: '1800000', unit: 'ns', bootGeneration: 1, segmentId: 2 },
      segments: [seg1, seg2],
      gaps: [gap],
      sourceKind: 'selection',
    });
    expect(crossGap.valid).toBe(true);
    expect(crossGap.start).toBe('1200000');
    expect(crossGap.end).toBe('1800000');
    expect(crossGap.continuity?.continuous).toBe(false);
    expect(crossGap.continuity?.blockingReasons.length).toBeGreaterThan(0);

    const viewportLinked = resolveContextsAnalysisRange({
      axisDomain: domain,
      viewRange: { start: '1100000', end: '1400000' },
      cursorA: null,
      cursorB: null,
      segments: [seg1, seg2],
      gaps: [gap],
      sourceKind: 'viewport',
    });
    expect(viewportLinked.valid).toBe(true);
    expect(viewportLinked.start).toBe('1100000');
    expect(viewportLinked.end).toBe('1400000');
  });

  it('支持 64 位时长格式化以及上下文/Marker 过滤排序', () => {
    expect(formatAnalysisDurationStr('18014398509481984', 'relative-ticks')).toBe('18014398509481984 ticks');
    expect(formatAnalysisDurationStr('1250.50', 'ns')).toBe('1.250 µs');
    expect(formatAnalysisDurationStr('1251.00', 'ns')).toBe('1.251 µs');

    const rows: TraceAnalysisQueryResult['contexts'] = [
      {
        contextKind: 'task',
        contextKey: 'b1:tcb0x20001000#g1:i1',
        taskInstanceId: 'b1:tcb0x20001000#g1:i1',
        tcbAddress: 0x20001000,
        taskGeneration: 1,
        label: 'Alpha',
        labelSource: 'task-info',
        cpuAccounted: true,
        clippedExclusiveDuration: '400',
        windowPercent: 40,
        knownPercent: 50,
        clippedSliceCount: 2,
        completeActivationCount: 2,
        boundaryActivationCount: 0,
        incompleteActivationCount: 0,
        preemptedTotalDuration: '0',
        preemptionCountTotal: 0,
        readyCompleteCount: 1,
        readyBoundaryCount: 0,
        readyRemovedCount: 0,
        readyIncompleteCount: 0,
        readyStats: { count: 1, total: '20', min: '20', max: '20', avg: '20.00', avgFloor: '20' },
      },
      {
        contextKind: 'isr',
        contextKey: 'b1:isr:17',
        irqId: 17,
        label: 'SysTick',
        labelSource: 'sysdesc',
        cpuAccounted: true,
        clippedExclusiveDuration: '100',
        windowPercent: 10,
        knownPercent: 12.5,
        clippedSliceCount: 2,
        completeActivationCount: 1,
        boundaryActivationCount: 0,
        incompleteActivationCount: 0,
        exclusiveStats: { count: 1, total: '100', min: '100', max: '100', avg: '100.00', avgFloor: '100' },
        inclusiveStats: { count: 1, total: '150', min: '150', max: '150', avg: '150.00', avgFloor: '150' },
        preemptedTotalDuration: '50',
        preemptionCountTotal: 1,
        readyCompleteCount: 0,
        readyBoundaryCount: 0,
        readyRemovedCount: 0,
        readyIncompleteCount: 0,
      },
    ];

    expect(filterAndSortContextRows(rows, 'isr', '', 'cpu', 'desc').map(r => r.irqId)).toEqual([17]);
    expect(filterAndSortContextRows(rows, 'all', 'alpha', 'cpu', 'desc').length).toBe(1);
    expect(filterMarkerRows([{ markerId: 10, name: 'Loop', nameSource: 'ex-name-marker', completeCount: 1, boundaryCount: 0, incompleteCount: 0, pointCount: 0, uncertainPointCount: 0, contextKeys: [] }], 'loop').length).toBe(1);
  });

  it('在服务端静态渲染下正确显示嵌套标识、复用代数徽章与缺口/unknown 语义', () => {
    const seg = makeSegment();
    const domain = computeAxisDomain([seg], 'relative-ticks', '1:1');
    const analysis: TraceAnalysisQueryResult = {
      unit: 'relative-ticks',
      start: '0',
      end: '1000',
      windowDuration: '1000',
      precision: 'exact',
      verifiable: true,
      timeDomainJump: false,
      timeDomainWarnings: [],
      skippedUnanchoredSegments: [],
      skippedNoFrequencySegments: [],
      excludedBootGenerations: [],
      verifiableSegments: [{ bootGeneration: 1, segmentId: 1, reliability: 'trusted', timeAnchorStatus: 'anchored-cycles', start: '0', end: '1000' }],
      gapsInWindow: [],
      totals: {
        taskDuration: '500',
        isrDuration: '100',
        schedulerDuration: '0',
        idleDuration: '200',
        unknownDuration: '200',
        activeDuration: '600',
        knownDuration: '800',
        activeWindowPct: 60,
        activeKnownPct: 75,
        unknownWindowPct: 20,
        excludedIncompleteSlices: 1,
        excludedUncertainSlices: 0,
        excludedIncompleteActivations: 1,
        excludedIncompleteReadyWaits: 1,
        excludedIncompleteMarkers: 0,
        sliceOverlapDetected: false,
      },
      bins: [
        {
          binIndex: 0,
          start: '0',
          end: '1000',
          duration: '1000',
          taskDuration: '500',
          isrDuration: '100',
          schedulerDuration: '0',
          idleDuration: '200',
          unknownDuration: '200',
          activeDuration: '600',
          knownDuration: '800',
          activeWindowPct: 60,
          activeKnownPct: 75,
          isrWindowPct: 10,
          idleWindowPct: 20,
          unknownWindowPct: 20,
          hasGap: true,
          gapKinds: ['target-overflow'],
          hasIncomplete: true,
          hasUncertain: false,
        },
      ],
      contexts: [
        {
          contextKind: 'task',
          contextKey: 'b1:tcb0x20001000#g2:i2',
          taskInstanceId: 'b1:tcb0x20001000#g2:i2',
          tcbAddress: 0x20001000,
          taskGeneration: 2,
          label: 'Beta',
          labelSource: 'task-info',
          cpuAccounted: true,
          clippedExclusiveDuration: '500',
          windowPercent: 50,
          knownPercent: 62.5,
          clippedSliceCount: 1,
          completeActivationCount: 1,
          boundaryActivationCount: 0,
          incompleteActivationCount: 0,
          exclusiveStats: { count: 1, total: '500', min: '500', max: '500', avg: '500.00', avgFloor: '500' },
          inclusiveStats: { count: 1, total: '500', min: '500', max: '500', avg: '500.00', avgFloor: '500' },
          preemptedTotalDuration: '0',
          preemptionCountTotal: 0,
          readyCompleteCount: 0,
          readyBoundaryCount: 0,
          readyRemovedCount: 0,
          readyIncompleteCount: 1,
        },
        {
          contextKind: 'isr',
          contextKey: 'b1:isr:17',
          irqId: 17,
          label: 'SysTick',
          labelSource: 'sysdesc',
          cpuAccounted: true,
          clippedExclusiveDuration: '100',
          windowPercent: 10,
          knownPercent: 12.5,
          clippedSliceCount: 2,
          completeActivationCount: 1,
          boundaryActivationCount: 0,
          incompleteActivationCount: 0,
          exclusiveStats: { count: 1, total: '100', min: '100', max: '100', avg: '100.00', avgFloor: '100' },
          inclusiveStats: { count: 1, total: '180', min: '180', max: '180', avg: '180.00', avgFloor: '180' },
          preemptedTotalDuration: '80',
          preemptionCountTotal: 1,
          readyCompleteCount: 0,
          readyBoundaryCount: 0,
          readyRemovedCount: 0,
          readyIncompleteCount: 0,
        },
      ],
      contextsTruncated: false,
      markers: [],
      markersTruncated: false,
      candidatePagesScanned: 4,
      cacheHits: 0,
      cacheMisses: 4,
    };

    const html = renderToStaticMarkup(
      React.createElement(ContextsView, {
        visible: true,
        settings: DEFAULT_RTOS_VIEW_SETTINGS,
        traceState: {
          ...INITIAL_TRACE_PANEL_STATE,
          selectedRecordId: 'rec-1',
          records: [
            {
              recordId: 'rec-1',
              source: 'offline',
              state: 'completed',
              stateReason: 'done',
              counters: {
                bytesReceived: 100,
                committedRawBytes: 100,
                batchesReceived: 1,
                packetsDecoded: 10,
                sliceCount: 2,
                gapCount: 0,
                segmentCount: 1,
                targetOverruns: 0,
                hostDroppedBytes: 0,
                transportDroppedBytes: 0,
                backpressurePauses: 0,
                preStartDrainedBytes: 0,
              },
              segments: [seg],
              gaps: [],
            },
          ],
        },
        selectedRecord: {
          recordId: 'rec-1',
          source: 'offline',
          state: 'completed',
          stateReason: 'done',
          counters: {
            bytesReceived: 100,
            committedRawBytes: 100,
            batchesReceived: 1,
            packetsDecoded: 10,
            sliceCount: 2,
            gapCount: 0,
            segmentCount: 1,
            targetOverruns: 0,
            hostDroppedBytes: 0,
            transportDroppedBytes: 0,
            backpressurePauses: 0,
            preStartDrainedBytes: 0,
          },
          segments: [seg],
          gaps: [],
        },
        axisDomain: domain,
        selectedScopeKey: '1:1',
        viewRange: { start: '0', end: '1000' },
        cursorA: null,
        cursorB: null,
        cursorAInspect: null,
        cursorBInspect: null,
        analysisResult: {
          querySeq: 1,
          recordId: 'rec-1',
          unit: 'relative-ticks',
          scopeKey: '1:1',
          sourceKind: 'viewport',
          start: '0',
          end: '1000',
          analysis,
          queryDurationMs: 2.5,
        },
        rangeSource: 'viewport',
        onChangeRangeSource: () => {},
        onChangeScopeKey: () => {},
        onUpdateSettings: () => {},
        onSelectRecord: () => {},
        onOpenRecording: () => {},
        onQueryAnalysis: () => {},
        onJumpToTimelineRange: () => {},
      }),
    );

    expect(html).toContain('精确聚合 (exact)');
    expect(html).toContain('Beta');
    expect(html).toContain('#g2');
    expect(html).toContain('[含嵌套]');
    expect(html).toContain('unknown (缺端点/不完整 1)');
    expect(html).toContain('Events / Terminal: 阶段 5.2 待接入');
  });
});
