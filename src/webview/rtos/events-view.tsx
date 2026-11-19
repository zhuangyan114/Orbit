import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TraceEventDto } from '../../trace/systemview-formatter';
import type { TraceEventCategoryFilter } from '../../trace/trace-events';
import { formatHex32 } from './rtos-view-state';
import {
  computeVirtualScrollMetrics,
  formatTraceTimestamp,
  rowIndexToScrollTop,
  scrollTopToRowIndex,
  type TraceAnalysisSourceKind,
  type TraceAxisDomain,
  type TraceEventLocateResponse,
  type TraceEventsResponse,
  type TraceFocusedEventRef,
  type TraceRecordSummary,
  type TraceTimeUnit,
} from './trace-timeline-state';

export interface EventsViewProps {
  visible: boolean;
  selectedRecord: TraceRecordSummary | null;
  axisDomain: TraceAxisDomain;
  resolvedRange: {
    readonly valid: boolean;
    readonly reason?: string;
    readonly start?: string;
    readonly end?: string;
  };
  rangeSource: TraceAnalysisSourceKind;
  eventsResult: TraceEventsResponse | null;
  locateResult: TraceEventLocateResponse | null;
  focusedEvent: TraceFocusedEventRef | null;
  pendingLocateTarget: {
    readonly seq: number;
    readonly recordId: string;
    readonly unit: TraceTimeUnit;
    readonly bootGeneration?: number;
    readonly segmentId?: number;
    readonly timeStr: string;
    readonly packetIndexInSegment?: number;
    readonly streamByteOffset?: number;
  } | null;
  contextKeyFilter: string | null;
  onClearContextKeyFilter: () => void;
  onSelectFocusedEvent: (ev: TraceEventDto) => void;
  onJumpToTimelineEvent: (ev: TraceEventDto) => void;
  onQueryEvents: (req: {
    querySeq: number;
    recordId: string;
    unit: TraceTimeUnit;
    scopeKey: string;
    sourceKind: TraceAnalysisSourceKind;
    bootGeneration?: number;
    segmentId?: number;
    start: string;
    end: string;
    offset: number;
    limit: number;
    category: TraceEventCategoryFilter;
    searchText: string;
    contextKey?: string;
    onlyWithDiagnostics: boolean;
  }) => void;
  onExportCsv?: (req: {
    recordId: string;
    exportSource: 'events-page';
    unit: TraceTimeUnit;
    bootGeneration?: number;
    segmentId?: number;
    start: string;
    end: string;
    filter: {
      category: TraceEventCategoryFilter;
      searchText: string;
      contextKey?: string;
      onlyWithDiagnostics: boolean;
    };
    outputPath?: string;
  }) => void;
  onLocateEvent: (req: {
    querySeq: number;
    recordId: string;
    unit: TraceTimeUnit;
    bootGeneration?: number;
    segmentId?: number;
    start: string;
    end: string;
    targetTime?: string;
    targetBootGeneration?: number;
    targetSegmentId?: number;
    targetPacketIndex?: number;
    targetByteOffset?: number;
    category: TraceEventCategoryFilter;
    searchText: string;
    contextKey?: string;
    onlyWithDiagnostics: boolean;
  }) => void;
  onPerfReport?: (perf: Record<string, unknown>) => void;
}

export interface EventsQueryProvenance {
  readonly recordId: string | null;
  readonly unit: TraceTimeUnit;
  readonly scopeKey: string;
  readonly sourceKind: TraceAnalysisSourceKind;
  readonly start: string;
  readonly end: string;
  readonly category: TraceEventCategoryFilter;
  readonly searchText: string;
  readonly contextKey: string | null;
  readonly onlyWithDiagnostics: boolean;
}

export function doesEventsResponseMatchProvenance(
  resp: TraceEventsResponse | null,
  expected: EventsQueryProvenance,
): boolean {
  if (!resp || !expected.recordId || resp.recordId !== expected.recordId) return false;
  if (resp.unit !== expected.unit) return false;
  if (resp.scopeKey !== expected.scopeKey) return false;
  if (resp.sourceKind !== expected.sourceKind) return false;
  if (resp.category !== expected.category) return false;
  if (resp.searchText !== expected.searchText) return false;
  if ((resp.contextKey ?? null) !== expected.contextKey) return false;
  if (Boolean(resp.onlyWithDiagnostics) !== expected.onlyWithDiagnostics) return false;
  if (resp.result && (resp.result.start !== expected.start || resp.result.end !== expected.end)) {
    return false;
  }
  return true;
}

const ROW_HEIGHT_PX = 26;
const PAGE_WINDOW_LIMIT = 120;
let nextEventsQuerySeq = 1;
let nextLocateQuerySeq = 1;

const CATEGORY_OPTIONS: readonly [TraceEventCategoryFilter, string][] = [
  ['all', '全部'],
  ['task', '任务/调度'],
  ['isr', '中断 (ISR)'],
  ['os-api', 'FreeRTOS API'],
  ['marker', 'Markers'],
  ['terminal', '终端输出'],
  ['system', '系统/资源'],
  ['anomalies', '未知/异常'],
];

function reliabilityBadgeText(ev: TraceEventDto): string {
  if (ev.segmentReliability === 'uncertain') return '断段/不可信';
  if (ev.schemaReliability === 'unknown-explicit') return '未知事件';
  if (ev.schemaReliability === 'partial') return '部分解码';
  return '';
}

function timeDomainShortLabel(td: TraceEventDto['timeDomain']): string {
  switch (td) {
    case 'anchored-ticks': return 'anchored';
    case 'segment-relative-ticks': return 'rel-only';
    case 'unknown': return 'unknown';
  }
}

export function EventsView(props: EventsViewProps) {
  const {
    visible,
    selectedRecord,
    axisDomain,
    resolvedRange,
    rangeSource,
    eventsResult,
    locateResult,
    focusedEvent,
    pendingLocateTarget,
    contextKeyFilter,
    onClearContextKeyFilter,
    onSelectFocusedEvent,
    onJumpToTimelineEvent,
    onQueryEvents,
    onExportCsv,
    onLocateEvent,
    onPerfReport,
  } = props;

  const [category, setCategory] = useState<TraceEventCategoryFilter>('all');
  const [searchText, setSearchText] = useState('');
  const [onlyWithDiagnostics, setOnlyWithDiagnostics] = useState(false);
  const [windowOffset, setWindowOffset] = useState(0);
  const [scrollTopPx, setScrollTopPx] = useState(0);
  const [viewportHeightPx, setViewportHeightPx] = useState(260);
  const [selectedEvent, setSelectedEvent] = useState<TraceEventDto | null>(null);
  const [jumpInput, setJumpInput] = useState('');

  const scrollWrapRef = useRef<HTMLDivElement | null>(null);
  const queryDebounceRef = useRef<number | null>(null);
  const lastDispatchedSeqRef = useRef(0);
  const minValidSeqRef = useRef(0);
  const immediateQueryStateRef = useRef<{ filterKey: string; offset: number; committedBytes: number } | null>(null);
  const lastLocateSeqRef = useRef(0);
  const appliedLocateSeqRef = useRef(0);
  const handledLocateTriggerRef = useRef(0);
  const pendingHighlightEventKeyRef = useRef<string | null>(null);
  const onQueryEventsRef = useRef(onQueryEvents);
  onQueryEventsRef.current = onQueryEvents;
  const onLocateEventRef = useRef(onLocateEvent);
  onLocateEventRef.current = onLocateEvent;
  const onPerfReportRef = useRef(onPerfReport);
  onPerfReportRef.current = onPerfReport;
  const onSelectFocusedEventRef = useRef(onSelectFocusedEvent);
  onSelectFocusedEventRef.current = onSelectFocusedEvent;
  const perfRef = useRef({
    queriesSent: 0,
    repliesApplied: 0,
    droppedStaleReplies: 0,
    locateSent: 0,
    locateApplied: 0,
    lastQueryMs: 0,
    lastTotalMatched: 0,
    domRenderedRows: 0,
  });

  const activeRecordId = selectedRecord?.recordId ?? null;
  const activeUnit = axisDomain.unit;
  const committedBytes = selectedRecord?.counters.committedRawBytes ?? 0;
  const expectedQueryEnd = useMemo(() => {
    if (!resolvedRange.valid || !resolvedRange.end) return '';
    return resolvedRange.end === axisDomain.displayMaxStr
      ? (BigInt(resolvedRange.end) + 1n).toString()
      : resolvedRange.end;
  }, [resolvedRange.valid, resolvedRange.end, axisDomain.displayMaxStr]);

  const currentProvenance = useMemo<EventsQueryProvenance>(() => ({
    recordId: activeRecordId,
    unit: activeUnit,
    scopeKey: axisDomain.scopeKey,
    sourceKind: rangeSource,
    start: resolvedRange.start ?? '',
    end: expectedQueryEnd,
    category,
    searchText,
    contextKey: contextKeyFilter ?? null,
    onlyWithDiagnostics: Boolean(onlyWithDiagnostics),
  }), [
    activeRecordId,
    activeUnit,
    axisDomain.scopeKey,
    rangeSource,
    resolvedRange.start,
    expectedQueryEnd,
    category,
    searchText,
    contextKeyFilter,
    onlyWithDiagnostics,
  ]);

  // Measure virtual scroll viewport height
  useEffect(() => {
    const el = scrollWrapRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const update = () => {
      const h = Math.max(140, Math.floor(el.clientHeight));
      setViewportHeightPx(prev => (prev === h ? prev : h));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Reset offset and reject pre-change in-flight replies immediately when filter or record/range changes
  const filterKey = `${activeRecordId ?? ''}::${axisDomain.scopeKey}::${activeUnit}::${resolvedRange.start ?? ''}::${expectedQueryEnd}::${rangeSource}::${category}::${searchText}::${contextKeyFilter ?? ''}::${onlyWithDiagnostics}`;
  const prevFilterKeyRef = useRef('');
  useEffect(() => {
    if (prevFilterKeyRef.current !== filterKey) {
      prevFilterKeyRef.current = filterKey;
      minValidSeqRef.current = nextEventsQuerySeq;
      immediateQueryStateRef.current = null;
      setWindowOffset(0);
      setScrollTopPx(0);
      setSelectedEvent(null);
      if (scrollWrapRef.current) {
        scrollWrapRef.current.scrollTop = 0;
      }
    }
  }, [filterKey]);

  const dispatchEventsQuery = useCallback((offsetToLoad: number, immediate = false) => {
    if (!visible || !activeRecordId || !axisDomain.valid || !resolvedRange.valid || !resolvedRange.start || !expectedQueryEnd) {
      return;
    }
    const normalizedOffset = Math.max(0, offsetToLoad);
    const run = () => {
      const seq = nextEventsQuerySeq++;
      lastDispatchedSeqRef.current = seq;
      perfRef.current.queriesSent++;
      onPerfReportRef.current?.({ ...perfRef.current });
      onQueryEventsRef.current({
        querySeq: seq,
        recordId: activeRecordId,
        unit: activeUnit,
        scopeKey: axisDomain.scopeKey,
        sourceKind: rangeSource,
        ...(axisDomain.bootGeneration !== undefined ? { bootGeneration: axisDomain.bootGeneration } : {}),
        ...(axisDomain.segmentId !== undefined ? { segmentId: axisDomain.segmentId } : {}),
        start: resolvedRange.start!,
        end: expectedQueryEnd,
        offset: normalizedOffset,
        limit: PAGE_WINDOW_LIMIT,
        category,
        searchText,
        ...(contextKeyFilter ? { contextKey: contextKeyFilter } : {}),
        onlyWithDiagnostics,
      });
    };
    if (queryDebounceRef.current !== null) {
      window.clearTimeout(queryDebounceRef.current);
      queryDebounceRef.current = null;
    }
    if (immediate) {
      immediateQueryStateRef.current = { filterKey, offset: normalizedOffset, committedBytes };
      run();
    } else {
      queryDebounceRef.current = window.setTimeout(run, 24);
    }
  }, [
    visible,
    activeRecordId,
    axisDomain.valid,
    axisDomain.scopeKey,
    axisDomain.bootGeneration,
    axisDomain.segmentId,
    activeUnit,
    rangeSource,
    resolvedRange.valid,
    resolvedRange.start,
    expectedQueryEnd,
    filterKey,
    committedBytes,
    category,
    searchText,
    contextKeyFilter,
    onlyWithDiagnostics,
  ]);

  useEffect(() => {
    const imm = immediateQueryStateRef.current;
    if (imm && imm.filterKey === filterKey && imm.offset === windowOffset && imm.committedBytes === committedBytes) {
      immediateQueryStateRef.current = null;
      return;
    }
    dispatchEventsQuery(windowOffset, false);
    return () => {
      if (queryDebounceRef.current !== null) {
        window.clearTimeout(queryDebounceRef.current);
        queryDebounceRef.current = null;
      }
    };
  }, [dispatchEventsQuery, filterKey, windowOffset, committedBytes]);

  // Apply Events query response with strict provenance + monotonic sequence protection
  const activeEventsResp = useMemo(() => {
    if (!doesEventsResponseMatchProvenance(eventsResult, currentProvenance)) return null;
    if (eventsResult && eventsResult.querySeq < minValidSeqRef.current) return null;
    return eventsResult;
  }, [eventsResult, currentProvenance]);

  const appliedEventsKeyRef = useRef('');
  useEffect(() => {
    if (!eventsResult) return;
    if (
      eventsResult.querySeq < minValidSeqRef.current ||
      eventsResult.querySeq < lastDispatchedSeqRef.current ||
      !doesEventsResponseMatchProvenance(eventsResult, currentProvenance)
    ) {
      perfRef.current.droppedStaleReplies++;
      return;
    }
    const dedupKey = `${eventsResult.recordId}::${eventsResult.querySeq}`;
    if (appliedEventsKeyRef.current === dedupKey) {
      return;
    }
    appliedEventsKeyRef.current = dedupKey;
    perfRef.current.repliesApplied++;
    perfRef.current.lastQueryMs = eventsResult.queryDurationMs;
    perfRef.current.lastTotalMatched = eventsResult.result?.totalMatched ?? 0;

    if (eventsResult.result && pendingHighlightEventKeyRef.current) {
      const hit = eventsResult.result.items.find(it => it.eventKey === pendingHighlightEventKeyRef.current);
      if (hit) {
        setSelectedEvent(hit);
        pendingHighlightEventKeyRef.current = null;
      }
    }
    onPerfReportRef.current?.({ ...perfRef.current });
  }, [eventsResult, currentProvenance]);

  // Handle locate trigger from Trace Timeline click/selection
  useEffect(() => {
    if (!visible || !pendingLocateTarget || !activeRecordId || pendingLocateTarget.recordId !== activeRecordId) return;
    if (!axisDomain.valid || !resolvedRange.valid || !resolvedRange.start || !resolvedRange.end) return;
    if (pendingLocateTarget.seq === handledLocateTriggerRef.current) return;
    handledLocateTriggerRef.current = pendingLocateTarget.seq;

    const seq = nextLocateQuerySeq++;
    lastLocateSeqRef.current = seq;
    perfRef.current.locateSent++;
    const queryEnd =
      resolvedRange.end === axisDomain.displayMaxStr
        ? (BigInt(resolvedRange.end) + 1n).toString()
        : resolvedRange.end;
    onLocateEventRef.current({
      querySeq: seq,
      recordId: activeRecordId,
      unit: activeUnit,
      ...(axisDomain.bootGeneration !== undefined ? { bootGeneration: axisDomain.bootGeneration } : {}),
      ...(axisDomain.segmentId !== undefined ? { segmentId: axisDomain.segmentId } : {}),
      start: resolvedRange.start,
      end: queryEnd,
      targetTime: pendingLocateTarget.timeStr,
      ...(pendingLocateTarget.bootGeneration !== undefined ? { targetBootGeneration: pendingLocateTarget.bootGeneration } : {}),
      ...(pendingLocateTarget.segmentId !== undefined ? { targetSegmentId: pendingLocateTarget.segmentId } : {}),
      ...(pendingLocateTarget.packetIndexInSegment !== undefined ? { targetPacketIndex: pendingLocateTarget.packetIndexInSegment } : {}),
      ...(pendingLocateTarget.streamByteOffset !== undefined ? { targetByteOffset: pendingLocateTarget.streamByteOffset } : {}),
      category,
      searchText,
      ...(contextKeyFilter ? { contextKey: contextKeyFilter } : {}),
      onlyWithDiagnostics,
    });
  }, [
    visible,
    pendingLocateTarget,
    activeRecordId,
    activeUnit,
    axisDomain.valid,
    axisDomain.bootGeneration,
    axisDomain.segmentId,
    axisDomain.displayMaxStr,
    resolvedRange.valid,
    resolvedRange.start,
    resolvedRange.end,
    category,
    searchText,
    contextKeyFilter,
    onlyWithDiagnostics,
  ]);

  const data = activeEventsResp?.result ?? null;
  const totalRows = data?.totalMatched ?? 0;
  const metrics = useMemo(
    () => computeVirtualScrollMetrics(totalRows, ROW_HEIGHT_PX, viewportHeightPx),
    [totalRows, viewportHeightPx],
  );

  // Apply locate response -> jump virtual scrollbar & highlight matched event
  useEffect(() => {
    if (!locateResult || !activeRecordId || locateResult.recordId !== activeRecordId) return;
    if (locateResult.querySeq < lastLocateSeqRef.current) return;
    if (locateResult.querySeq === appliedLocateSeqRef.current) return;
    appliedLocateSeqRef.current = locateResult.querySeq;
    perfRef.current.locateApplied++;
    const res = locateResult.result;
    if (res?.found && res.event) {
      pendingHighlightEventKeyRef.current = res.event.eventKey;
      setSelectedEvent(res.event);
      onSelectFocusedEventRef.current(res.event);
      const targetOffset = Math.min(metrics.maxStartRow, Math.max(0, res.rowIndex - 3));
      setWindowOffset(targetOffset);
      const targetScroll = rowIndexToScrollTop(targetOffset, metrics);
      setScrollTopPx(targetScroll);
      if (scrollWrapRef.current) {
        scrollWrapRef.current.scrollTop = targetScroll;
      }
      dispatchEventsQuery(targetOffset, true);
    }
    onPerfReportRef.current?.({ ...perfRef.current });
  }, [locateResult, activeRecordId, metrics, dispatchEventsQuery]);

  const loadedItems = data?.items ?? [];
  const loadedOffset = data?.offset ?? 0;
  const approxTopRow = scrollTopToRowIndex(scrollTopPx, metrics);
  const renderStartRow = Math.max(0, Math.min(approxTopRow, Math.max(0, totalRows - 1)));
  const renderEndRow = Math.min(totalRows, renderStartRow + metrics.visibleRowCount);

  const visibleItems: Array<{ rowIndex: number; item: TraceEventDto | null }> = useMemo(() => {
    const rows: Array<{ rowIndex: number; item: TraceEventDto | null }> = [];
    for (let idx = renderStartRow; idx < renderEndRow; idx++) {
      const localIdx = idx - loadedOffset;
      const item = localIdx >= 0 && localIdx < loadedItems.length ? loadedItems[localIdx] : null;
      rows.push({ rowIndex: idx, item });
    }
    return rows;
  }, [renderStartRow, renderEndRow, loadedOffset, loadedItems]);

  useEffect(() => {
    perfRef.current.domRenderedRows = visibleItems.length;
    if (visibleItems.length > 0 && perfRef.current.repliesApplied > 0) {
      onPerfReport?.({ ...perfRef.current });
    }
  }, [visibleItems.length, onPerfReport]);

  const handleScroll = (ev: React.UIEvent<HTMLDivElement>) => {
    const st = ev.currentTarget.scrollTop;
    setScrollTopPx(st);
    const nextTop = scrollTopToRowIndex(st, metrics);
    const needFetch =
      nextTop < loadedOffset + 10 ||
      nextTop + metrics.visibleRowCount > loadedOffset + loadedItems.length - 10;
    if (needFetch) {
      const targetOff = Math.max(0, nextTop - Math.floor(PAGE_WINDOW_LIMIT / 4));
      if (targetOff !== windowOffset) {
        setWindowOffset(targetOff);
      }
    }
  };

  const jumpToRow = (targetRow: number) => {
    if (totalRows <= 0) return;
    const clamped = Math.max(0, Math.min(totalRows - 1, Math.floor(targetRow)));
    const targetOff = Math.min(metrics.maxStartRow, Math.max(0, clamped - 4));
    setWindowOffset(targetOff);
    const st = rowIndexToScrollTop(targetOff, metrics);
    setScrollTopPx(st);
    if (scrollWrapRef.current) {
      scrollWrapRef.current.scrollTop = st;
    }
    dispatchEventsQuery(targetOff, true);
  };

  const selectRow = (ev: TraceEventDto) => {
    setSelectedEvent(ev);
    onSelectFocusedEvent(ev);
  };

  // Expose deterministic test API for Stage 5.2 verification
  useEffect(() => {
    (window as any).__orbitRtosEventsTestApi = {
      getState: () => ({
        recordId: activeRecordId,
        unit: activeUnit,
        category,
        searchText,
        onlyWithDiagnostics,
        contextKeyFilter,
        windowOffset,
        loadedOffset,
        loadedCount: loadedItems.length,
        totalMatched: totalRows,
        totalKnownExact: data?.totalKnownExact ?? false,
        domRenderedRows: visibleItems.length,
        selectedEventKey: selectedEvent?.eventKey ?? null,
        focusedEventKey: focusedEvent?.eventKey ?? null,
        isStale: !activeEventsResp,
        appliedQuerySeq: activeEventsResp?.querySeq ?? null,
        appliedFilter: activeEventsResp
          ? {
              recordId: activeEventsResp.recordId,
              unit: activeEventsResp.unit,
              scopeKey: activeEventsResp.scopeKey,
              sourceKind: activeEventsResp.sourceKind,
              category: activeEventsResp.category,
              searchText: activeEventsResp.searchText,
              contextKey: activeEventsResp.contextKey ?? null,
              onlyWithDiagnostics: activeEventsResp.onlyWithDiagnostics,
              start: activeEventsResp.result?.start ?? null,
              end: activeEventsResp.result?.end ?? null,
            }
          : null,
        visibleRowSummaries: visibleItems
          .filter((r): r is { rowIndex: number; item: TraceEventDto } => r.item !== null)
          .map(r => ({
            rowIndex: r.rowIndex,
            eventKey: r.item.eventKey,
            eventName: r.item.eventName,
            category: r.item.category,
            contextLabel: r.item.contextLabel ?? null,
            irqId: r.item.irqId ?? null,
          })),
        perf: { ...perfRef.current },
      }),
      setCategory: (cat: TraceEventCategoryFilter) => setCategory(cat),
      setSearchText: (txt: string) => setSearchText(txt),
      jumpToRow,
      jumpToSelectedTimeline: () => {
        if (selectedEvent) onJumpToTimelineEvent(selectedEvent);
      },
      exportCsv: (outputPath?: string) => {
        if (!onExportCsv || !activeRecordId || !axisDomain.valid || !resolvedRange.valid || !resolvedRange.start || !expectedQueryEnd) {
          return false;
        }
        onExportCsv({
          recordId: activeRecordId,
          exportSource: 'events-page',
          unit: activeUnit,
          ...(axisDomain.bootGeneration !== undefined ? { bootGeneration: axisDomain.bootGeneration } : {}),
          ...(axisDomain.segmentId !== undefined ? { segmentId: axisDomain.segmentId } : {}),
          start: resolvedRange.start,
          end: expectedQueryEnd,
          filter: {
            category,
            searchText,
            ...(contextKeyFilter ? { contextKey: contextKeyFilter } : {}),
            onlyWithDiagnostics,
          },
          ...(outputPath ? { outputPath } : {}),
        });
        return true;
      },
    };
  }, [
    activeRecordId,
    activeUnit,
    category,
    searchText,
    onlyWithDiagnostics,
    contextKeyFilter,
    windowOffset,
    loadedOffset,
    loadedItems.length,
    totalRows,
    data?.totalKnownExact,
    visibleItems,
    selectedEvent,
    focusedEvent,
    activeEventsResp,
    onJumpToTimelineEvent,
    onExportCsv,
    axisDomain.valid,
    axisDomain.bootGeneration,
    axisDomain.segmentId,
    resolvedRange.valid,
    resolvedRange.start,
    expectedQueryEnd,
  ]);

  const effectiveSelectedKey = selectedEvent?.eventKey ?? focusedEvent?.eventKey ?? null;

  return (
    <div className="events-shell" data-events-record={activeRecordId ?? 'none'} data-events-total={totalRows}>
      {/* 过滤栏 */}
      <div className="rtos-filter-bar events-filter-bar">
        <div className="rtos-filter-chips" role="group" aria-label="事件分类过滤">
          {CATEGORY_OPTIONS.map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={`rtos-chip${category === id ? ' active' : ''}`}
              onClick={() => setCategory(id)}
            >
              {label}
            </button>
          ))}
        </div>

        <input
          type="search"
          aria-label="搜索事件"
          className="rtos-search"
          placeholder="搜索事件名、任务/IRQ、API、地址、终端文本…"
          value={searchText}
          onChange={e => setSearchText(e.target.value)}
        />

        <label className="rtos-live-toggle" title="仅显示包含未知事件、地址不可解析、参数不匹配或断段警告的事件">
          <input
            type="checkbox"
            checked={onlyWithDiagnostics}
            onChange={e => setOnlyWithDiagnostics(e.target.checked)}
          />
          <span>仅看诊断</span>
        </label>

        {contextKeyFilter && (
          <span className="rtos-pill rtos-tone-info">
            上下文: {contextKeyFilter}
            <button type="button" className="rtos-mini-btn" onClick={onClearContextKeyFilter} title="清除上下文筛选">×</button>
          </span>
        )}
      </div>

      {/* 状态与虚拟表跳行控制 */}
      <div className="trace-status-banner events-meta-bar">
        <span className="rtos-mono trace-stat-text">
          {data
            ? `匹配 ${data.totalMatched.toLocaleString()}${data.totalKnownExact ? '' : '+'} 条 · 窗口 [${loadedOffset}..${loadedOffset + loadedItems.length}) · DOM ${visibleItems.length} 行 · ${activeEventsResp?.queryDurationMs ?? 0} ms (${data.candidatePagesScanned}/${data.totalCandidatePages} 页)`
            : activeEventsResp?.error
              ? `⚠ 查询失败: ${activeEventsResp.error}`
              : resolvedRange.valid
                ? '正在加载有界事件窗口…'
                : (resolvedRange.reason ?? '当前选区不可查询')}
        </span>

        <div className="trace-btn-group">
          <button type="button" className="rtos-mini-btn" disabled={totalRows === 0} onClick={() => jumpToRow(0)}>首行</button>
          <button type="button" className="rtos-mini-btn" disabled={totalRows === 0} onClick={() => jumpToRow(Math.max(0, totalRows - 1))}>末行</button>
          <input
            type="number"
            aria-label="跳转到事件行号"
            className="rtos-search events-jump-input"
            placeholder="行号 #"
            min={0}
            max={Math.max(0, totalRows - 1)}
            value={jumpInput}
            onChange={e => setJumpInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                const n = Number(jumpInput);
                if (Number.isFinite(n)) jumpToRow(n);
              }
            }}
          />
          <button
            type="button"
            className="rtos-mini-btn"
            disabled={totalRows === 0 || !jumpInput.trim()}
            onClick={() => {
              const n = Number(jumpInput);
              if (Number.isFinite(n)) jumpToRow(n);
            }}
          >
            跳行
          </button>
          <button
            type="button"
            className="rtos-mini-btn"
            disabled={!onExportCsv || !activeRecordId || !axisDomain.valid || !resolvedRange.valid || !resolvedRange.start || !expectedQueryEnd}
            title="从 Worker 流式导出当前范围与筛选条件的全部匹配事件 CSV（支持百万级记录）"
            onClick={() => {
              if (!onExportCsv || !activeRecordId || !axisDomain.valid || !resolvedRange.valid || !resolvedRange.start || !expectedQueryEnd) return;
              onExportCsv({
                recordId: activeRecordId,
                exportSource: 'events-page',
                unit: activeUnit,
                ...(axisDomain.bootGeneration !== undefined ? { bootGeneration: axisDomain.bootGeneration } : {}),
                ...(axisDomain.segmentId !== undefined ? { segmentId: axisDomain.segmentId } : {}),
                start: resolvedRange.start,
                end: expectedQueryEnd,
                filter: {
                  category,
                  searchText,
                  ...(contextKeyFilter ? { contextKey: contextKeyFilter } : {}),
                  onlyWithDiagnostics,
                },
              });
            }}
          >
            导出 CSV
          </button>
        </div>
      </div>

      {/* 断段 / 未锚定段 / 启动代次提示 */}
      {data && (data.gapsInWindow.length > 0 || data.skippedUnanchoredSegments.length > 0 || data.scanTruncated) && (
        <div className="contexts-warn-bar">
          {data.gapsInWindow.length > 0 && (
            <div className="rtos-inline-warn">
              ⚠ 当前范围含 {data.gapsInWindow.length} 处数据断段/边界: {data.gapsInWindow.slice(0, 4).map(g => `[boot${g.bootGeneration} ${g.kind} @off=${g.byteOffset} drop=${g.droppedPackets}]`).join(' ')}
            </div>
          )}
          {data.skippedUnanchoredSegments.length > 0 && (
            <div className="rtos-inline-warn">
              ⚠ 已跳过 {data.skippedUnanchoredSegments.length} 个未锚定绝对时间的段 (Seg #{data.skippedUnanchoredSegments.join(', #')})；请在上方段选择器切换至对应段或 relative-ticks 查看。
            </div>
          )}
          {data.scanTruncated && (
            <div className="rtos-inline-warn">
              ⚠ 搜索扫描达到页上限，当前仅展示已扫描部分匹配结果。
            </div>
          )}
        </div>
      )}

      {/* 虚拟事件表 + 右侧/底部详情面板 */}
      <div className="events-workspace">
        <div className="events-table-wrap">
          <div className="events-thead rtos-mono" role="row">
            <span className="ev-col-idx">#</span>
            <span className="ev-col-time">时间 / 域</span>
            <span className="ev-col-seg">Boot:Seg</span>
            <span className="ev-col-ctx">执行上下文</span>
            <span className="ev-col-name">事件</span>
            <span className="ev-col-summary">详情 / 参数 / 输出</span>
            <span className="ev-col-act">定位</span>
          </div>

          <div
            ref={scrollWrapRef}
            className="events-vscroll"
            onScroll={handleScroll}
          >
            {totalRows === 0 ? (
              <div className="rtos-table-empty">
                {!selectedRecord
                  ? '请先录制或打开 Trace 归档'
                  : !resolvedRange.valid
                    ? (resolvedRange.reason || '当前范围不可查询')
                    : !activeEventsResp
                      ? '正在按当前筛选查询事件…'
                      : '当前筛选条件下无匹配事件'}
              </div>
            ) : (
              <div className="events-vspacer" style={{ height: `${metrics.scrollHeightPx}px` }}>
                <div
                  className="events-vwindow"
                  style={{
                    transform: `translateY(${Math.max(0, Math.min(metrics.maxScrollTopPx, scrollTopPx))}px)`,
                  }}
                >
                  {visibleItems.map(({ rowIndex, item }) => {
                    if (!item) {
                      return (
                        <div key={`pending-${rowIndex}`} className="events-vrow events-vrow-loading rtos-mono">
                          <span className="ev-col-idx">{rowIndex}</span>
                          <span className="ev-col-summary rtos-muted">加载中…</span>
                        </div>
                      );
                    }
                    const isSelected = effectiveSelectedKey === item.eventKey;
                    const timeStr = activeUnit === 'ns' && item.ns !== undefined
                      ? formatTraceTimestamp(item.ns, 'ns')
                      : activeUnit === 'absolute-ticks' && item.absTicks !== undefined
                        ? formatTraceTimestamp(item.absTicks, 'absolute-ticks')
                        : formatTraceTimestamp(item.relTicks, 'relative-ticks');
                    const relBadge = reliabilityBadgeText(item);
                    const hasWarn = item.diagnostics.some(d => d.severity === 'error' || d.severity === 'warning');

                    return (
                      <div
                        key={item.eventKey}
                        className={`events-vrow${isSelected ? ' selected' : ''}${hasWarn ? ' has-warn' : ''}`}
                        role="row"
                        aria-selected={isSelected}
                        tabIndex={0}
                        onClick={() => selectRow(item)}
                        onDoubleClick={() => {
                          selectRow(item);
                          onJumpToTimelineEvent(item);
                        }}
                        onKeyDown={e => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            selectRow(item);
                          }
                        }}
                      >
                        <span className="ev-col-idx rtos-mono">{rowIndex}</span>
                        <span className="ev-col-time rtos-mono" title={`rel=${item.relTicks} abs=${item.absTicks ?? '—'} ns=${item.ns ?? '—'} domain=${item.timeDomain}`}>
                          {timeStr} <em className="ev-domain-tag">{timeDomainShortLabel(item.timeDomain)}</em>
                        </span>
                        <span className="ev-col-seg rtos-mono" title={`boot=${item.bootGeneration} seg=${item.segmentId} (${item.segmentReliability}) @off=${item.streamByteOffset}`}>
                          b{item.bootGeneration}:s{item.segmentId}{item.segmentReliability === 'uncertain' ? '?' : ''}
                        </span>
                        <span className="ev-col-ctx" title={`${item.contextKey ?? ''} (${item.contextLabelSource ?? 'unknown'}) depth=${item.isrDepth}`}>
                          {item.contextLabel ?? item.contextKind}
                          {item.nestedIsr && <span className="rtos-evidence rtos-tone-warn">嵌套d={item.isrDepth}</span>}
                        </span>
                        <span className="ev-col-name rtos-mono">
                          {item.eventName}
                          {relBadge && <span className="ev-rel-pill">{relBadge}</span>}
                        </span>
                        <span className="ev-col-summary" title={item.summary}>
                          {item.summary}
                        </span>
                        <span className="ev-col-act">
                          <button
                            type="button"
                            className="rtos-mini-btn"
                            title="跳转到本记录 Trace Timeline 对应时刻"
                            onClick={e => {
                              e.stopPropagation();
                              selectRow(item);
                              onJumpToTimelineEvent(item);
                            }}
                          >
                            定位Trace
                          </button>
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* 事件详情与 FreeRTOS API / 诊断检视区 */}
        <aside className="events-detail-pane" aria-label="选中事件详情">
          {!selectedEvent ? (
            <div className="rtos-muted">点击左侧事件查看身份、时间域、FreeRTOS API 参数、格式化来源与诊断详情；双击或点击「定位Trace」可双向定位至 Trace Timeline。</div>
          ) : (
            <div className="events-detail-content">
              <div className="events-detail-header">
                <strong className="rtos-mono">{selectedEvent.eventName} (ID={selectedEvent.eventId})</strong>
                <button
                  type="button"
                  className="rtos-btn rtos-btn-secondary"
                  onClick={() => onJumpToTimelineEvent(selectedEvent)}
                >
                  定位 Trace Timeline
                </button>
              </div>

              <dl className="rtos-kv-grid rtos-mono">
                <dt>身份</dt>
                <dd>boot={selectedEvent.bootGeneration} · seg=#{selectedEvent.segmentId} ({selectedEvent.segmentReliability}) · pkt=#{selectedEvent.packetIndexInSegment} · off={selectedEvent.streamByteOffset} B ({selectedEvent.byteLength} B)</dd>
                <dt>时间域</dt>
                <dd>{selectedEvent.timeDomain} ({selectedEvent.timeAnchorStatus}) · delta=+{selectedEvent.deltaTicks} ticks{selectedEvent.timestampWrapped ? ' [wrap]' : ''}</dd>
                <dt>时间戳</dt>
                <dd>rel={selectedEvent.relTicks} · abs={selectedEvent.absTicks ?? 'unknown'} · ns={selectedEvent.ns ?? 'unknown'}{selectedEvent.sysFreqHz ? ` @${selectedEvent.sysFreqHz}Hz` : ''}</dd>
                <dt>上下文</dt>
                <dd>{selectedEvent.contextKind} · {selectedEvent.contextLabel ?? '—'} (来源: {selectedEvent.contextLabelSource ?? 'unknown'}){selectedEvent.isrDepth > 0 ? ` · ISR深度=${selectedEvent.isrDepth}${selectedEvent.nestedIsr ? ' (嵌套)' : ''}` : ''}</dd>
                <dt>Schema</dt>
                <dd>{selectedEvent.category} / {selectedEvent.schemaReliability}</dd>
              </dl>

              {selectedEvent.apiDetails && (
                <div className="events-detail-section">
                  <div className="events-detail-subtitle">
                    FreeRTOS API 参数说明 · <span className="rtos-mono">{selectedEvent.apiDetails.apiName ?? `API#${selectedEvent.apiDetails.apiId}`}</span>
                    <span className="rtos-muted"> ({selectedEvent.apiDetails.sourceNote})</span>
                  </div>
                  {selectedEvent.apiDetails.missingReason && (
                    <div className="rtos-inline-warn">⚠ {selectedEvent.apiDetails.missingReason}</div>
                  )}
                  {selectedEvent.apiDetails.params.length > 0 && (
                    <table className="rtos-table">
                      <thead>
                        <tr>
                          <th>参数</th>
                          <th>类型</th>
                          <th>原始值</th>
                          <th>解析 / 名称 / 语义</th>
                          <th>来源 / 状态</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selectedEvent.apiDetails.params.map((p, idx) => (
                          <tr key={idx}>
                            <td className="rtos-mono">{p.name}</td>
                            <td className="rtos-mono">{p.kind}</td>
                            <td className="rtos-mono">{p.rawValue} ({p.rawHex})</td>
                            <td className="rtos-mono">
                              {p.resolvedLabel ? `${p.resolvedLabel} ` : ''}
                              {p.resolvedHex ?? ''}
                              {p.enumNote ? ` [${p.enumNote}]` : ''}
                              {p.pointerNote ? ` [${p.pointerNote}]` : ''}
                            </td>
                            <td className="rtos-mono">
                              {p.resolvedLabelSource ?? p.idResolution ?? 'raw-u32'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  {selectedEvent.apiDetails.rawPayloadHex && (
                    <div className="rtos-mono rtos-muted">rawPayload: {selectedEvent.apiDetails.rawPayloadHex}</div>
                  )}
                </div>
              )}

              {selectedEvent.terminalEntry && (
                <div className="events-detail-section">
                  <div className="events-detail-subtitle">
                    Trace Terminal 解释 · {selectedEvent.terminalEntry.logLevelLabel}{selectedEvent.terminalEntry.append ? ' +APPEND' : ''} · 来源: {selectedEvent.terminalEntry.formatSource}
                  </div>
                  <div className="rtos-mono events-terminal-preview">{selectedEvent.terminalEntry.renderedText}</div>
                  <div className="rtos-mono rtos-muted">
                    {selectedEvent.terminalEntry.stringAddressHex ? `addr=${selectedEvent.terminalEntry.stringAddressHex} (${selectedEvent.terminalEntry.addressStatus}) · ` : ''}
                    {selectedEvent.terminalEntry.rawFormatText !== undefined ? `fmt="${selectedEvent.terminalEntry.rawFormatText}" · ` : ''}
                    args=[{selectedEvent.terminalEntry.args.join(', ')}]
                  </div>
                </div>
              )}

              {selectedEvent.resolvedReferences && selectedEvent.resolvedReferences.length > 0 && (
                <div className="events-detail-section">
                  <div className="events-detail-subtitle">资源 / 任务引用解析</div>
                  {selectedEvent.resolvedReferences.map((ref, idx) => (
                    <div key={idx} className="rtos-mono">
                      {ref.role}: raw={ref.rawValue} · {ref.addressHex ?? formatHex32(0)} · {ref.label ?? '(无名称)'} · 状态/来源={ref.idStatus} / {ref.source ?? '—'}
                    </div>
                  ))}
                </div>
              )}

              {selectedEvent.rawPayloadHex && (
                <div className="events-detail-section rtos-mono">
                  <div className="events-detail-subtitle">未知 / 原始载荷预览</div>
                  <div>{selectedEvent.rawPayloadHex}</div>
                </div>
              )}

              {selectedEvent.diagnostics.length > 0 && (
                <div className="events-detail-section">
                  <div className="events-detail-subtitle">事件诊断 ({selectedEvent.diagnostics.length})</div>
                  {selectedEvent.diagnostics.map((diag, idx) => (
                    <div key={idx} className={diag.severity === 'error' ? 'rtos-inline-error' : 'rtos-inline-warn'}>
                      [{diag.severity}] {diag.code}: {diag.message}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
