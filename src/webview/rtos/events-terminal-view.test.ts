import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TraceEventDto } from '../../trace/systemview-formatter';
import type { SegmentIndexMetadata } from '../../trace/trace-format';
import { ContextsView } from './contexts-view';
import { doesEventsResponseMatchProvenance, EventsView } from './events-view';
import { doesTerminalResponseMatchProvenance, TerminalView } from './terminal-view';
import { DEFAULT_RTOS_VIEW_SETTINGS, INITIAL_TRACE_PANEL_STATE } from './rtos-view-state';
import {
  computeAxisDomain,
  computeTimelineJumpForEvent,
  computeVirtualScrollMetrics,
  resolveEventTimeStrForUnit,
  rowIndexToScrollTop,
  scrollTopToRowIndex,
  type TraceEventsResponse,
  type TraceRecordSummary,
  type TraceSegmentDto,
  type TraceTerminalResponse,
} from './trace-timeline-state';

function makeSegment(overrides: Partial<SegmentIndexMetadata> = {}): SegmentIndexMetadata {
  return {
    bootGeneration: 1,
    segmentId: 1,
    startByteOffset: 0,
    endByteOffset: 200,
    reliability: 'trusted',
    closed: true,
    packetCount: 100,
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

function makeRecord(recordId: string, seg: TraceSegmentDto): TraceRecordSummary {
  return {
    recordId,
    source: 'offline',
    state: 'completed',
    stateReason: 'done',
    counters: {
      bytesReceived: 200,
      committedRawBytes: 200,
      batchesReceived: 1,
      packetsDecoded: 100,
      sliceCount: 10,
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
  };
}

function makeEventItem(idx: number, overrides: Partial<TraceEventDto> = {}): TraceEventDto {
  return {
    eventKey: `b1:s1:p${idx}@${idx * 10}`,
    bootGeneration: 1,
    segmentId: 1,
    segmentReliability: 'trusted',
    packetIndexInSegment: idx,
    streamByteOffset: idx * 10,
    byteLength: 8,
    eventId: 90,
    eventName: 'OS_xQueueGenericSend',
    category: 'os-freertos',
    schemaReliability: 'known',
    timeDomain: 'anchored-ticks',
    timeAnchorStatus: 'anchored-cycles',
    timestampWrapped: false,
    deltaTicks: 10,
    relTicks: String(idx * 10),
    absTicks: String(1000 + idx * 10),
    ns: String((1000 + idx * 10) * 1000),
    sysFreqHz: 1_000_000,
    contextKind: idx % 2 === 0 ? 'task' : 'isr',
    contextKey: idx % 2 === 0 ? 'task:Worker' : 'isr:18',
    contextLabel: idx % 2 === 0 ? 'Worker' : 'IRQ 18',
    contextLabelSource: idx % 2 === 0 ? 'task-info' : 'sysdesc',
    isrDepth: idx % 2 === 0 ? 0 : 2,
    nestedIsr: idx % 2 !== 0,
    summary: idx === 0 ? 'xQueueGenericSend(queueId=0x20001000, ticksToWait=10)' : 'EVENT_SAMPLE',
    apiDetails: {
      apiId: 58,
      apiName: 'xQueueGenericSend',
      interpretation: 'matched',
      sourceNote: 'FreeRTOSv10 SEGGER_SYSVIEW_FreeRTOS.h',
      params: [
        { name: 'queueId', kind: 'shrunk-id', rawValue: 0x400, rawHex: '0x400', resolvedId: 0x20001000, resolvedHex: '0x20001000', resolvedLabel: 'CmdQ', resolvedLabelSource: 'name-resource' },
        { name: 'itemPtr', kind: 'u32', rawValue: 0x20002000, rawHex: '0x20002000' },
        { name: 'ticksToWait', kind: 'u32', rawValue: 10, rawHex: '0xa', enumNote: '10 ticks' },
        { name: 'copyPosition', kind: 'u32', rawValue: 0, rawHex: '0x0', enumNote: 'queueSEND_TO_BACK' },
      ],
    },
    diagnostics: [],
    ...overrides,
  };
}

describe('Events & Trace Terminal UI 状态、双向跳转与有界渲染 (阶段 5.2)', () => {
  it('在 1,002,005 级行数下将虚拟滚动高度压缩在 2,000,000 px 以内并精确往返映射到首/中/尾行', () => {
    const metrics = computeVirtualScrollMetrics(1_002_005, 26, 520);
    expect(metrics.scrollHeightPx).toBeLessThanOrEqual(2_000_000);
    expect(metrics.totalRows).toBe(1_002_005);

    for (const target of [0, 120, 500_000, 999_000, 1_001_900]) {
      const top = rowIndexToScrollTop(target, metrics);
      const roundTrip = scrollTopToRowIndex(top, metrics);
      expect(Math.abs(roundTrip - target)).toBeLessThanOrEqual(1);
    }
  });

  it('精确处理事件时间域选择与 Timeline 双向聚焦视窗计算', () => {
    const evAnchored = makeEventItem(5);
    expect(resolveEventTimeStrForUnit(evAnchored, 'ns')).toBe('1050000');
    expect(resolveEventTimeStrForUnit(evAnchored, 'relative-ns')).toBe('50000');
    expect(resolveEventTimeStrForUnit(evAnchored, 'absolute-ticks')).toBe('1050');
    expect(resolveEventTimeStrForUnit(evAnchored, 'relative-ticks')).toBe('50');

    const seg = makeSegment({ minNs: '1000000', maxNs: '2000000' });
    const jump = computeTimelineJumpForEvent(evAnchored, [seg], '1:1', 'ns');
    expect(jump.ok).toBe(true);
    expect(jump.timeStr).toBe('1050000');
    expect(BigInt(jump.viewStart) <= 1050000n).toBe(true);
    expect(BigInt(jump.viewEnd) > 1050000n).toBe(true);

    // 单段在 all-anchored 传入时必须归一化为实际有效 scopeKey ('1:1')，防止 app.tsx axisKey 比较失配
    const jumpAllAnchored = computeTimelineJumpForEvent(evAnchored, [seg], 'all-anchored', 'relative-ns');
    expect(jumpAllAnchored.ok).toBe(true);
    expect(jumpAllAnchored.scopeKey).toBe('1:1');
    expect(jumpAllAnchored.unit).toBe('relative-ns');

    // 未锚定事件不能伪造 ns 时间，自动切换为 relative-ticks
    const evUnanchored = makeEventItem(6, { absTicks: undefined, ns: undefined, timeDomain: 'segment-relative-ticks' });
    expect(resolveEventTimeStrForUnit(evUnanchored, 'ns')).toBeUndefined();
    expect(resolveEventTimeStrForUnit(evUnanchored, 'relative-ticks')).toBe('60');
  });

  it('EventsView 即使面对 1,002,005 条命中也仅在 DOM 渲染当前页有界行数并呈现 API 参数与诊断', () => {
    const seg = makeSegment();
    const record = makeRecord('r-1M', seg);
    const axisDomain = computeAxisDomain([seg], 'ns', '1:1');
    const items = Array.from({ length: 120 }, (_, i) =>
      makeEventItem(i, i === 1 ? { schemaReliability: 'unknown-explicit', eventName: 'UNKNOWN_30', category: 'unknown-explicit', rawPayloadHex: 'de ad be' } : {}),
    );
    const resp: TraceEventsResponse = {
      recordId: 'r-1M',
      querySeq: 7,
      scopeKey: '1:1',
      sourceKind: 'viewport',
      unit: 'ns',
      category: 'all',
      searchText: '',
      onlyWithDiagnostics: false,
      queryDurationMs: 12.4,
      result: {
        unit: 'ns',
        start: '1000000',
        end: '2000001',
        offset: 0,
        limit: 120,
        totalMatched: 1_002_005,
        totalKnownExact: true,
        hasMore: true,
        scanTruncated: false,
        items,
        gapsInWindow: [{ kind: 'target-overflow', bootGeneration: 1, segmentId: 1, byteOffset: 900, packetIndex: 99, closedSlicesCount: 0 } as any],
        segmentsInWindow: [seg],
        candidatePagesScanned: 2,
        totalCandidatePages: 300,
        cacheHits: 1,
        cacheMisses: 1,
        skippedUnanchoredSegments: [],
        skippedNoFrequencySegments: [],
      },
    };

    const html = renderToStaticMarkup(
      React.createElement(EventsView, {
        visible: true,
        selectedRecord: record,
        axisDomain,
        resolvedRange: { valid: true, start: '1000000', end: '2000000' },
        rangeSource: 'viewport',
        eventsResult: resp,
        locateResult: null,
        focusedEvent: {
          recordId: 'r-1M',
          bootGeneration: 1,
          segmentId: 1,
          packetIndexInSegment: 0,
          streamByteOffset: 0,
          timeStr: '1000000',
          unit: 'ns',
          eventKey: items[0].eventKey,
        },
        pendingLocateTarget: null,
        contextKeyFilter: null,
        onClearContextKeyFilter: () => {},
        onSelectFocusedEvent: () => {},
        onJumpToTimelineEvent: () => {},
        onQueryEvents: () => {},
        onLocateEvent: () => {},
      }),
    );

    const rowCount = (html.match(/class="events-vrow\b/g) || []).length;
    expect(rowCount).toBe(12);
    expect(html).toContain('1,002,005');
    expect(html).toContain('DOM 12 行');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('OS_xQueueGenericSend');
    expect(html).toContain('xQueueGenericSend(queueId=0x20001000, ticksToWait=10)');
    expect(html).toContain('嵌套d=2');
    expect(html).toContain('target-overflow');
  });

  it('TerminalView 与 ContextsView(terminal) 明确展示 EX_PRINT_ELF 未解析地址、断段破坏拼接、nested ISR 与诊断抽屉', () => {
    const seg = makeSegment();
    const record = makeRecord('r-term', seg);
    const axisDomain = computeAxisDomain([seg], 'relative-ticks', '1:1');
    const termResp: TraceTerminalResponse = {
      recordId: 'r-term',
      querySeq: 3,
      scopeKey: '1:1',
      sourceKind: 'full',
      unit: 'relative-ticks',
      level: 'all',
      searchText: '',
      mergeAppend: true,
      queryDurationMs: 3.2,
      result: {
        unit: 'relative-ticks',
        start: '0',
        end: '1001',
        offset: 0,
        limit: 200,
        totalLines: 2,
        totalKnownExact: true,
        hasMore: false,
        scanTruncated: false,
        lines: [
          {
            lineKey: 'b2:s1:p5@90',
            eventKey: 'b2:s1:p5@90',
            bootGeneration: 2,
            segmentId: 1,
            segmentReliability: 'trusted',
            packetIndexInSegment: 5,
            streamByteOffset: 90,
            relTicks: '25',
            timeDomain: 'anchored-ticks',
            logLevel: 0,
            logLevelLabel: 'LOG',
            append: true,
            mergedPacketCount: 1,
            appendBrokenReason: '跨断段/重启边界（上一条为 b1:s1），已禁止拼接',
            contextKind: 'isr',
            contextKey: 'isr:18',
            contextLabel: 'IRQ 18',
            contextLabelSource: 'irq',
            isrDepth: 2,
            nestedIsr: true,
            renderedText: 'literal=%d %x %%',
            formatSource: 'packet-inline',
            args: [],
            warnings: [],
          },
          {
            lineKey: 'b2:s1:p6@110',
            eventKey: 'b2:s1:p6@110',
            bootGeneration: 2,
            segmentId: 1,
            segmentReliability: 'trusted',
            packetIndexInSegment: 6,
            streamByteOffset: 110,
            relTicks: '30',
            timeDomain: 'anchored-ticks',
            logLevel: 2,
            logLevelLabel: 'ERROR',
            append: false,
            mergedPacketCount: 1,
            contextKind: 'task',
            contextKey: 'task:Ctrl',
            contextLabel: 'Ctrl',
            isrDepth: 0,
            nestedIsr: false,
            renderedText: '<unresolved ELF .rodata @0x0801fff0 (lvl=2, arg=42)>',
            formatSource: 'unresolved-address',
            stringAddress: 0x0801fff0,
            stringAddressHex: '0x0801fff0',
            addressStatus: 'unresolvable-no-elf',
            args: [42],
            warnings: ['缺少可验证 ELF .rodata'],
          },
        ],
        gapsInWindow: [],
        segmentsInWindow: [seg],
        candidatePagesScanned: 1,
        skippedUnanchoredSegments: [],
        skippedNoFrequencySegments: [],
      },
    };

    const diagResp = {
      recordId: 'r-term',
      diagnostics: {
        totalCount: 2,
        truncated: false,
        droppedRecordedDiagnostics: 0,
        countsBySource: { decoder: 1, reconstructor: 1, storage: 0, gap: 0 },
        items: [
          { source: 'decoder' as const, severity: 'warning' as const, code: 'print-arg-count-exceeded', message: '参数个数超限', segmentId: 1, byteOffset: 40 },
          { source: 'reconstructor' as const, severity: 'warning' as const, code: 'orphan-isr-exit', message: '孤立 ISR_EXIT', bootGeneration: 1, segmentId: 1, byteOffset: 60 },
        ],
      },
    };

    const html = renderToStaticMarkup(
      React.createElement(ContextsView, {
        visible: true,
        settings: DEFAULT_RTOS_VIEW_SETTINGS,
        traceState: {
          ...INITIAL_TRACE_PANEL_STATE,
          selectedRecordId: 'r-term',
          records: [record],
        },
        selectedRecord: record,
        axisDomain,
        selectedScopeKey: '1:1',
        viewRange: { start: '0', end: '5000' },
        cursorA: null,
        cursorB: null,
        cursorAInspect: null,
        cursorBInspect: null,
        analysisResult: null,
        rangeSource: 'full',
        onChangeRangeSource: () => {},
        onChangeScopeKey: () => {},
        onUpdateSettings: () => {},
        onSelectRecord: () => {},
        onOpenRecording: () => {},
        onQueryAnalysis: () => {},
        onJumpToTimelineRange: () => {},
        activeSubTab: 'terminal',
        onChangeSubTab: () => {},
        terminalResult: termResp,
        diagnosticsResult: diagResp,
        onQueryTerminal: () => {},
        onGetDiagnostics: () => {},
      }),
    );

    expect(html).toContain('literal=%d %x %%');
    expect(html).toContain('0x0801fff0');
    expect(html).toContain('地址不可解析');
    expect(html).toContain('已禁止拼接');
    expect(html).toContain('嵌套d=2');
    expect(html).toContain('print-arg-count-exceeded');
    expect(html).toContain('orphan-isr-exit');

    const termHtml = renderToStaticMarkup(
      React.createElement(TerminalView, {
        visible: true,
        selectedRecord: record,
        axisDomain,
        resolvedRange: { valid: true, start: '0', end: '1000' },
        rangeSource: 'full',
        terminalResult: termResp,
        diagnosticsResult: diagResp,
        onQueryTerminal: () => {},
        onGetDiagnostics: () => {},
        onLocateLineInEvents: () => {},
        onJumpLineToTimeline: () => {},
      }),
    );
    expect(termHtml).toContain('terminal-line');
    expect(termHtml).toContain('rtos-tone-error');
  });

  it('严格校验 Events/Terminal 响应 provenance：拦截旧筛选(1,002,003 all)在切换到 isr/IRQ 时回填或显示可交互旧行', () => {
    const seg = makeSegment();
    const record = makeRecord('r-1M', seg);
    const axisDomain = computeAxisDomain([seg], 'ns', '1:1');

    const expectedIsrProv = {
      recordId: 'r-1M',
      unit: 'ns' as const,
      scopeKey: '1:1',
      sourceKind: 'full' as const,
      start: '1000000',
      end: '2000001',
      category: 'isr' as const,
      searchText: 'IRQ',
      contextKey: null,
      onlyWithDiagnostics: false,
    };

    const staleAllResp: TraceEventsResponse = {
      recordId: 'r-1M',
      querySeq: 10,
      scopeKey: '1:1',
      sourceKind: 'full',
      unit: 'ns',
      category: 'all',
      searchText: '',
      onlyWithDiagnostics: false,
      queryDurationMs: 12.0,
      result: {
        unit: 'ns',
        start: '1000000',
        end: '2000001',
        offset: 998966,
        limit: 120,
        totalMatched: 1_002_003,
        totalKnownExact: true,
        hasMore: true,
        scanTruncated: false,
        items: [makeEventItem(0)],
        gapsInWindow: [],
        segmentsInWindow: [seg],
        candidatePagesScanned: 2,
        totalCandidatePages: 300,
        cacheHits: 1,
        cacheMisses: 1,
        skippedUnanchoredSegments: [],
        skippedNoFrequencySegments: [],
      },
    };
    expect(doesEventsResponseMatchProvenance(staleAllResp, expectedIsrProv)).toBe(false);

    const matchedIsrResp: TraceEventsResponse = {
      ...staleAllResp,
      querySeq: 16,
      category: 'isr',
      searchText: 'IRQ',
      result: {
        ...staleAllResp.result!,
        offset: 0,
        totalMatched: 167_000,
      },
    };
    expect(doesEventsResponseMatchProvenance(matchedIsrResp, expectedIsrProv)).toBe(true);
    expect(doesEventsResponseMatchProvenance({ ...matchedIsrResp, scopeKey: '2:1' }, expectedIsrProv)).toBe(false);
    expect(doesEventsResponseMatchProvenance({ ...matchedIsrResp, sourceKind: 'viewport' }, expectedIsrProv)).toBe(false);
    expect(doesEventsResponseMatchProvenance({ ...matchedIsrResp, unit: 'relative-ticks' }, expectedIsrProv)).toBe(false);
    expect(
      doesEventsResponseMatchProvenance(
        { ...matchedIsrResp, result: { ...matchedIsrResp.result!, start: '1000100' } },
        expectedIsrProv,
      ),
    ).toBe(false);

    // 当传入的是不匹配当前视图状态（例如旧筛选 isr 响应遗留给新默认 all 面板）时，DOM 不得渲染旧事件行
    const blockedHtml = renderToStaticMarkup(
      React.createElement(EventsView, {
        visible: true,
        selectedRecord: record,
        axisDomain,
        resolvedRange: { valid: true, start: '1000000', end: '2000000' },
        rangeSource: 'full',
        eventsResult: matchedIsrResp,
        locateResult: null,
        focusedEvent: null,
        pendingLocateTarget: null,
        contextKeyFilter: null,
        onClearContextKeyFilter: () => {},
        onSelectFocusedEvent: () => {},
        onJumpToTimelineEvent: () => {},
        onQueryEvents: () => {},
        onLocateEvent: () => {},
      }),
    );
    expect((blockedHtml.match(/class="events-vrow\b/g) || []).length).toBe(0);
    expect(blockedHtml).not.toContain('167,000');
    expect(blockedHtml).toContain('正在按当前筛选查询事件');

    // Terminal provenance 同样阻止旧 level / searchText / mergeAppend 响应
    const termProv = {
      recordId: 'r-term',
      unit: 'relative-ticks' as const,
      scopeKey: '1:1',
      sourceKind: 'full' as const,
      start: '0',
      end: '5001',
      level: 'error' as const,
      searchText: '0x0801FFF0',
      mergeAppend: true,
    };
    const termResp: TraceTerminalResponse = {
      recordId: 'r-term',
      querySeq: 5,
      scopeKey: '1:1',
      sourceKind: 'full',
      unit: 'relative-ticks',
      level: 'error',
      searchText: '0x0801FFF0',
      mergeAppend: true,
      queryDurationMs: 1.5,
      result: {
        unit: 'relative-ticks',
        start: '0',
        end: '5001',
        offset: 0,
        limit: 200,
        totalLines: 1,
        totalKnownExact: true,
        hasMore: false,
        scanTruncated: false,
        lines: [],
        gapsInWindow: [],
        segmentsInWindow: [seg],
        candidatePagesScanned: 1,
        skippedUnanchoredSegments: [],
        skippedNoFrequencySegments: [],
      },
    };
    expect(doesTerminalResponseMatchProvenance(termResp, termProv)).toBe(true);
    expect(doesTerminalResponseMatchProvenance({ ...termResp, level: 'all' }, termProv)).toBe(false);
    expect(doesTerminalResponseMatchProvenance({ ...termResp, mergeAppend: false }, termProv)).toBe(false);
  });
});
