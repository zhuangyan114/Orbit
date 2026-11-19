import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TraceAnalysisQueryResult, TraceCpuLoadBin } from '../../trace/trace-analytics';
import { readTimelineTheme } from '../timeline/timeline-theme';
import { formatHex32, type RtosViewSettings } from './rtos-view-state';
import {
  bigIntToPixelX,
  type ContextStatsKindFilter,
  type ContextStatsSortKey,
  filterAndSortContextRows,
  filterMarkerRows,
  formatAnalysisDurationStr,
  formatContextLabel,
  formatTraceDuration,
  formatTraceTimestamp,
  resolveContextsAnalysisRange,
  segmentScopeKey,
  type TraceAnalysisResponse,
  type TraceAnalysisSourceKind,
  type TraceAxisDomain,
  type TracePanelState,
  type TracePointInspectResponse,
  type TraceRecordSummary,
  type TraceTimeUnit,
} from './trace-timeline-state';

export interface ContextsViewProps {
  visible: boolean;
  settings: RtosViewSettings;
  traceState: TracePanelState;
  selectedRecord: TraceRecordSummary | null;
  axisDomain: TraceAxisDomain;
  selectedScopeKey: string;
  viewRange: { start: string; end: string } | null;
  cursorA: { timeStr: string; unit: TraceTimeUnit; bootGeneration?: number; segmentId?: number } | null;
  cursorB: { timeStr: string; unit: TraceTimeUnit; bootGeneration?: number; segmentId?: number } | null;
  cursorAInspect: TracePointInspectResponse | null;
  cursorBInspect: TracePointInspectResponse | null;
  analysisResult: TraceAnalysisResponse | null;
  rangeSource: TraceAnalysisSourceKind;
  onChangeRangeSource: (src: TraceAnalysisSourceKind) => void;
  onChangeScopeKey: (key: string) => void;
  onUpdateSettings: (patch: Partial<RtosViewSettings>) => void;
  onSelectRecord: (recordId: string) => void;
  onOpenRecording: (recordingDir?: string) => void;
  onQueryAnalysis: (req: {
    querySeq: number;
    recordId: string;
    unit: TraceTimeUnit;
    scopeKey: string;
    sourceKind: TraceAnalysisSourceKind;
    bootGeneration?: number;
    segmentId?: number;
    start: string;
    end: string;
    maxBins: number;
  }) => void;
  onJumpToTimelineRange: (start: string, end: string) => void;
  onPerfReport?: (perf: Record<string, unknown>) => void;
}

const CHART_HEIGHT = 112;
const CHART_PAD_TOP = 10;
const CHART_PAD_BOTTOM = 18;
const CHART_PAD_LEFT = 36;
const CHART_PAD_RIGHT = 8;
let nextContextsQuerySeq = 1;

function kindBadgeLabel(kind: string): string {
  switch (kind) {
    case 'task': return 'Task';
    case 'isr': return 'ISR';
    case 'idle': return 'Idle';
    case 'scheduler': return 'Sched';
    case 'timer': return 'Timer';
    default: return kind;
  }
}

function unitLabel(unit: TraceTimeUnit): string {
  switch (unit) {
    case 'ns': return '绝对时间 (ns)';
    case 'relative-ns': return '段内相对 (ns)';
    case 'absolute-ticks': return '绝对 Ticks';
    case 'relative-ticks': return '段内 Ticks';
  }
}

function formatPct(pct: number | null): string {
  if (pct === null || !Number.isFinite(pct)) return 'unknown';
  return `${pct.toFixed(2)}%`;
}

export function ContextsView(props: ContextsViewProps) {
  const {
    visible,
    settings,
    traceState,
    selectedRecord,
    axisDomain,
    selectedScopeKey,
    viewRange,
    cursorA,
    cursorB,
    cursorAInspect,
    cursorBInspect,
    analysisResult,
    rangeSource,
    onChangeRangeSource,
    onChangeScopeKey,
    onUpdateSettings,
    onSelectRecord,
    onOpenRecording,
    onQueryAnalysis,
    onJumpToTimelineRange,
    onPerfReport,
  } = props;

  const [subTab, setSubTab] = useState<'contexts' | 'markers'>('contexts');
  const [kindFilter, setKindFilter] = useState<ContextStatsKindFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortKey, setSortKey] = useState<ContextStatsSortKey>('cpu');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [hoveredBinIdx, setHoveredBinIdx] = useState<number | null>(null);
  const [chartWidth, setChartWidth] = useState(640);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartWrapRef = useRef<HTMLDivElement | null>(null);
  const lastDispatchedSeqRef = useRef(0);
  const queryDebounceRef = useRef<number | null>(null);
  const perfRef = useRef({
    queriesSent: 0,
    repliesApplied: 0,
    droppedStaleReplies: 0,
    lastQueryMs: 0,
    lastDrawMs: 0,
    frameCount: 0,
    lastBins: 0,
  });

  const activeRecordId = selectedRecord?.recordId ?? null;
  const activeUnit = axisDomain.unit;
  const activeScopeKey = axisDomain.scopeKey;
  const committedBytes = selectedRecord?.counters.committedRawBytes ?? 0;

  const resolvedRange = useMemo(
    () => resolveContextsAnalysisRange({
      axisDomain,
      viewRange,
      cursorA,
      cursorB,
      cursorAInspect,
      cursorBInspect,
      segments: selectedRecord?.segments ?? [],
      gaps: selectedRecord?.gaps ?? [],
      sourceKind: rangeSource,
    }),
    [axisDomain, viewRange, cursorA, cursorB, cursorAInspect, cursorBInspect, selectedRecord?.segments, selectedRecord?.gaps, rangeSource],
  );

  // Trigger coalesced Worker analysis query when visible & target range changes
  useEffect(() => {
    if (!visible || !activeRecordId || !axisDomain.valid || !resolvedRange.valid || !resolvedRange.start || !resolvedRange.end) {
      if (activeRecordId) {
        onPerfReport?.({
          ...perfRef.current,
          blocked: {
            visible,
            activeRecordId,
            axisValid: axisDomain.valid,
            resolvedValid: resolvedRange.valid,
            reason: resolvedRange.reason ?? axisDomain.reason ?? null,
          },
        });
      }
      return;
    }
    const maxBins = Math.max(24, Math.min(240, Math.floor((chartWidth - CHART_PAD_LEFT - CHART_PAD_RIGHT) / 5) || 120));
    const run = () => {
      const seq = nextContextsQuerySeq++;
      lastDispatchedSeqRef.current = seq;
      perfRef.current.queriesSent++;
      onPerfReport?.({ ...perfRef.current, blocked: null });
      onQueryAnalysis({
        querySeq: seq,
        recordId: activeRecordId,
        unit: activeUnit,
        scopeKey: activeScopeKey,
        sourceKind: rangeSource,
        ...(axisDomain.bootGeneration !== undefined ? { bootGeneration: axisDomain.bootGeneration } : {}),
        ...(axisDomain.segmentId !== undefined ? { segmentId: axisDomain.segmentId } : {}),
        start: resolvedRange.start!,
        end: resolvedRange.end!,
        maxBins,
      });
    };

    if (queryDebounceRef.current !== null) {
      window.clearTimeout(queryDebounceRef.current);
      queryDebounceRef.current = null;
    }
    queryDebounceRef.current = window.setTimeout(run, 24);
    return () => {
      if (queryDebounceRef.current !== null) {
        window.clearTimeout(queryDebounceRef.current);
        queryDebounceRef.current = null;
      }
    };
  }, [
    visible,
    activeRecordId,
    axisDomain.valid,
    axisDomain.bootGeneration,
    axisDomain.segmentId,
    activeUnit,
    activeScopeKey,
    rangeSource,
    resolvedRange.valid,
    resolvedRange.start,
    resolvedRange.end,
    committedBytes,
    chartWidth,
    onQueryAnalysis,
  ]);

  const activeAnalysisResp = useMemo(() => {
    if (!analysisResult || !activeRecordId || analysisResult.recordId !== activeRecordId) return null;
    if (analysisResult.unit !== activeUnit) return null;
    return analysisResult;
  }, [analysisResult, activeRecordId, activeUnit]);

  useEffect(() => {
    if (!analysisResult) return;
    if (analysisResult.querySeq < lastDispatchedSeqRef.current) {
      perfRef.current.droppedStaleReplies++;
      return;
    }
    perfRef.current.repliesApplied++;
    perfRef.current.lastQueryMs = analysisResult.queryDurationMs;
    perfRef.current.lastBins = analysisResult.analysis?.bins.length ?? 0;
    onPerfReport?.({
      ...perfRef.current,
      lastError: analysisResult.error ?? null,
    });
  }, [analysisResult, onPerfReport]);

  const analysis: TraceAnalysisQueryResult | null = activeAnalysisResp?.analysis ?? null;

  // ResizeObserver for CPU Load chart
  useEffect(() => {
    const el = chartWrapRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const update = () => {
      const w = Math.max(240, Math.floor(el.getBoundingClientRect().width));
      setChartWidth(prev => (prev === w ? prev : w));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Paint CPU Load stacked bins canvas
  useEffect(() => {
    if (!visible) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const t0 = performance.now();
    const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const width = chartWidth;
    const height = CHART_HEIGHT;
    if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const theme = readTimelineTheme();
    const isLight = document.body.classList.contains('vscode-light') || document.body.classList.contains('vscode-high-contrast-light');
    ctx.fillStyle = theme.background;
    ctx.fillRect(0, 0, width, height);

    const plotLeft = CHART_PAD_LEFT;
    const plotRight = Math.max(plotLeft + 20, width - CHART_PAD_RIGHT);
    const plotTop = CHART_PAD_TOP;
    const plotBottom = height - CHART_PAD_BOTTOM;
    const plotW = plotRight - plotLeft;
    const plotH = plotBottom - plotTop;

    // Grid lines (0%, 50%, 100%)
    ctx.font = '10px var(--vscode-editor-font-family, monospace)';
    for (const pct of [0, 50, 100]) {
      const y = Math.round(plotBottom - (plotH * pct) / 100) + 0.5;
      ctx.strokeStyle = isLight ? 'rgba(0,0,0,0.10)' : 'rgba(255,255,255,0.10)';
      ctx.beginPath();
      ctx.moveTo(plotLeft, y);
      ctx.lineTo(plotRight, y);
      ctx.stroke();
      ctx.fillStyle = theme.label;
      ctx.fillText(`${pct}%`, 2, y + 3);
    }

    if (!analysis || !analysis.bins.length) {
      ctx.fillStyle = theme.label;
      ctx.font = '11px var(--vscode-font-family, sans-serif)';
      const emptyMsg = !selectedRecord
        ? '请先选择或打开 Trace 录制以查看上下文统计与 CPU Load'
        : !resolvedRange.valid
          ? (resolvedRange.reason || '当前选区不可用')
          : (analysis?.verifiableReason || '正在计算有界 CPU Load 分箱…');
      ctx.fillText(emptyMsg, plotLeft + 8, plotTop + plotH / 2 + 4);
      return;
    }

    const wStart = BigInt(analysis.start);
    const wEnd = BigInt(analysis.end);
    if (wEnd <= wStart) return;

    const cTask = isLight ? '#0066BF' : '#3794FF';
    const cIsr = isLight ? '#C93B2B' : '#F48771';
    const cSched = isLight ? '#7C3AED' : '#C586C0';
    const cIdle = isLight ? 'rgba(100,116,139,0.28)' : 'rgba(148,163,184,0.22)';
    const cUnknown = isLight ? 'rgba(204,167,0,0.38)' : 'rgba(204,167,0,0.30)';

    for (let i = 0; i < analysis.bins.length; i++) {
      const bin = analysis.bins[i];
      const bs = BigInt(bin.start);
      const be = BigInt(bin.end);
      const x0 = plotLeft + bigIntToPixelX(bs, wStart, wEnd, plotW);
      const x1 = plotLeft + bigIntToPixelX(be, wStart, wEnd, plotW);
      const bw = Math.max(1, x1 - x0);
      const dur = BigInt(bin.duration);
      if (dur <= 0n) continue;

      const taskT = BigInt(bin.taskDuration);
      const isrT = BigInt(bin.isrDuration);
      const schedT = BigInt(bin.schedulerDuration);
      const idleT = BigInt(bin.idleDuration);
      const unknownT = BigInt(bin.unknownDuration);

      const segHeight = (part: bigint) => Number((part * BigInt(Math.round(plotH * 100))) / dur) / 100;
      let yCur = plotBottom;

      const drawSeg = (h: number, color: string) => {
        if (h <= 0.1) return;
        const drawH = Math.min(yCur - plotTop, h);
        ctx.fillStyle = color;
        ctx.fillRect(x0, yCur - drawH, Math.max(1, bw - (bw > 3 ? 0.5 : 0)), drawH);
        yCur -= drawH;
      };

      drawSeg(segHeight(taskT), cTask);
      drawSeg(segHeight(isrT), cIsr);
      drawSeg(segHeight(schedT), cSched);
      drawSeg(segHeight(idleT), cIdle);
      drawSeg(segHeight(unknownT), cUnknown);

      if (bin.hasGap || bin.hasIncomplete || bin.hasUncertain) {
        ctx.fillStyle = bin.hasGap ? '#F48771' : '#CCA700';
        ctx.fillRect(x0, plotTop - 4, Math.max(2, bw), 3);
      }

      if (hoveredBinIdx === i) {
        ctx.strokeStyle = theme.foreground;
        ctx.lineWidth = 1;
        ctx.strokeRect(x0 + 0.5, plotTop + 0.5, Math.max(1, bw - 1), plotH - 1);
      }
    }

    // Bottom start/mid/end time labels
    ctx.fillStyle = theme.label;
    ctx.font = '10px var(--vscode-editor-font-family, monospace)';
    const startLbl = formatTraceTimestamp(analysis.start, analysis.unit as TraceTimeUnit);
    const endLbl = formatTraceTimestamp(analysis.end, analysis.unit as TraceTimeUnit);
    ctx.fillText(startLbl, plotLeft, height - 4);
    const endW = ctx.measureText(endLbl).width;
    ctx.fillText(endLbl, Math.max(plotLeft + 80, plotRight - endW), height - 4);

    const drawMs = performance.now() - t0;
    perfRef.current.frameCount++;
    perfRef.current.lastDrawMs = Math.round(drawMs * 1000) / 1000;
    onPerfReport?.({ ...perfRef.current });
  }, [visible, chartWidth, analysis, hoveredBinIdx, selectedRecord, resolvedRange, onPerfReport]);

  const displayedContexts = useMemo(
    () => (analysis ? filterAndSortContextRows(analysis.contexts, kindFilter, searchQuery, sortKey, sortDir) : []),
    [analysis, kindFilter, searchQuery, sortKey, sortDir],
  );

  const displayedMarkers = useMemo(
    () => (analysis ? filterMarkerRows(analysis.markers, searchQuery) : []),
    [analysis, searchQuery],
  );

  const hoveredBin: TraceCpuLoadBin | null = useMemo(() => {
    if (hoveredBinIdx === null || !analysis || hoveredBinIdx < 0 || hoveredBinIdx >= analysis.bins.length) return null;
    return analysis.bins[hoveredBinIdx];
  }, [hoveredBinIdx, analysis]);

  // Expose deterministic test API for Stage 5.1 verification
  useEffect(() => {
    (window as any).__orbitRtosContextsTestApi = {
      getState: () => ({
        recordId: activeRecordId,
        unit: activeUnit,
        scopeKey: activeScopeKey,
        rangeSource,
        resolvedRange,
        analysisSummary: analysis
          ? {
              precision: analysis.precision,
              verifiable: analysis.verifiable,
              windowDuration: analysis.windowDuration,
              totals: analysis.totals,
              binCount: analysis.bins.length,
              contextCount: analysis.contexts.length,
              markerCount: analysis.markers.length,
              gapsInWindowCount: analysis.gapsInWindow.length,
              timeDomainJump: analysis.timeDomainJump,
            }
          : null,
        perf: { ...perfRef.current },
      }),
      setRangeSource: (src: TraceAnalysisSourceKind) => onChangeRangeSource(src),
      setSubTab: (tab: 'contexts' | 'markers') => setSubTab(tab),
    };
  }, [activeRecordId, activeUnit, activeScopeKey, rangeSource, resolvedRange, analysis, onChangeRangeSource]);

  const toggleSort = (key: ContextStatsSortKey) => {
    if (sortKey === key) {
      setSortDir(prev => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'name' ? 'asc' : 'desc');
    }
  };

  const handleChartPointerMove = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    if (!analysis || !analysis.bins.length) {
      setHoveredBinIdx(null);
      return;
    }
    const rect = ev.currentTarget.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const plotLeft = CHART_PAD_LEFT;
    const plotRight = Math.max(plotLeft + 20, rect.width - CHART_PAD_RIGHT);
    if (x < plotLeft || x > plotRight) {
      setHoveredBinIdx(null);
      return;
    }
    const ratio = (x - plotLeft) / (plotRight - plotLeft);
    const idx = Math.max(0, Math.min(analysis.bins.length - 1, Math.floor(ratio * analysis.bins.length)));
    setHoveredBinIdx(idx);
  };

  return (
    <div className="trace-shell contexts-shell" data-contexts-record={activeRecordId ?? 'none'} data-contexts-source={rangeSource}>
      {/* 控制栏：记录选择、范围来源（Trace 视口 / A/B 选区 / 全部范围）、段与单位 */}
      <div className="rtos-sub-bar trace-controls-bar">
        <div className="trace-btn-group">
          <span className="rtos-muted">统计来源:</span>
          {([
            ['viewport', 'Trace 视口'],
            ['selection', 'A/B 选区'],
            ['full', '全部范围'],
          ] as [TraceAnalysisSourceKind, string][]).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={`rtos-chip${rangeSource === id ? ' active' : ''}`}
              onClick={() => onChangeRangeSource(id)}
            >
              {label}
            </button>
          ))}

          {selectedRecord && selectedRecord.segments.length > 0 && (
            <select
              aria-label="统计时间段"
              className="rtos-select"
              value={activeScopeKey}
              onChange={e => onChangeScopeKey(e.target.value)}
            >
              {selectedRecord.segments.length > 1 && (
                <option value="all-anchored">全部锚定段 ({selectedRecord.segments.length})</option>
              )}
              {selectedRecord.segments.map(s => (
                <option key={segmentScopeKey(s.bootGeneration, s.segmentId)} value={segmentScopeKey(s.bootGeneration, s.segmentId)}>
                  Seg #{s.segmentId} (boot {s.bootGeneration}, {s.reliability})
                </option>
              ))}
            </select>
          )}

          <select
            aria-label="统计时间单位"
            className="rtos-select"
            value={activeUnit}
            disabled={!axisDomain.valid}
            onChange={e => onUpdateSettings({ traceTimeUnit: e.target.value as TraceTimeUnit })}
          >
            {(['ns', 'relative-ns', 'absolute-ticks', 'relative-ticks'] as TraceTimeUnit[]).map(u => (
              <option key={u} value={u} disabled={axisDomain.availableUnits.length > 0 && !axisDomain.availableUnits.includes(u)}>
                {unitLabel(u)}
              </option>
            ))}
          </select>
        </div>

        <div className="trace-btn-group">
          <button
            type="button"
            className="rtos-btn rtos-btn-secondary"
            title="无需连接目标，打开已保存的 orbit-trace-v1 录制目录"
            onClick={() => onOpenRecording()}
          >
            打开录制
          </button>
          {traceState.records.length > 0 && (
            <select
              aria-label="当前分析的 Trace 记录"
              className="rtos-select trace-record-select"
              value={activeRecordId ?? ''}
              onChange={e => onSelectRecord(e.target.value)}
            >
              {traceState.records.map(r => (
                <option key={r.recordId} value={r.recordId}>
                  [{r.source === 'offline' ? '离线' : r.mode ?? 'trace'}] {r.recordId} ({r.state})
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      {/* 语义与区间摘要条 */}
      <div className="trace-status-banner">
        {!selectedRecord ? (
          <span className="rtos-muted">暂无已选择 Trace 录制；可在 Trace Timeline 开始录制或点击“打开录制”。</span>
        ) : !resolvedRange.valid ? (
          <>
            <span className="rtos-pill rtos-tone-warn">选区不可用 (unknown)</span>
            <span className="rtos-inline-warn">{resolvedRange.reason}</span>
            {axisDomain.valid && (
              <span className="trace-stat-text rtos-mono">
                可验证全段: [{formatTraceTimestamp(axisDomain.minStr, activeUnit)} .. {formatTraceTimestamp(axisDomain.displayMaxStr, activeUnit)})
              </span>
            )}
          </>
        ) : analysis ? (
          <>
            <span className={`rtos-pill ${analysis.precision === 'exact' && analysis.verifiable ? 'rtos-tone-ok' : 'rtos-tone-warn'}`}>
              {analysis.precision === 'exact' ? '精确聚合 (exact)' : analysis.precision === 'approx' ? '近似 LOD (approx)' : '不可验证'}
            </span>
            <span className="trace-stat-text rtos-mono">
              区间 [{formatTraceTimestamp(analysis.start, activeUnit)} .. {formatTraceTimestamp(analysis.end, activeUnit)}) · 窗长 {formatTraceDuration(BigInt(analysis.windowDuration), activeUnit)}
            </span>
            <span className="trace-stat-text rtos-mono">
              Active {formatPct(analysis.totals.activeWindowPct)}
              {BigInt(analysis.totals.unknownDuration) > 0n ? ` (可信域 ${formatPct(analysis.totals.activeKnownPct)})` : ''}
              {' · '}Task {formatTraceDuration(BigInt(analysis.totals.taskDuration), activeUnit)}
              {' · '}ISR {formatTraceDuration(BigInt(analysis.totals.isrDuration), activeUnit)}
              {' · '}Idle {formatTraceDuration(BigInt(analysis.totals.idleDuration), activeUnit)}
              {' · '}Unknown {formatTraceDuration(BigInt(analysis.totals.unknownDuration), activeUnit)} ({formatPct(analysis.totals.unknownWindowPct)})
            </span>
            <span className="trace-stat-text rtos-mono">
              {activeAnalysisResp?.queryDurationMs ?? 0} ms · {analysis.candidatePagesScanned} 页
            </span>
          </>
        ) : activeAnalysisResp?.error ? (
          <span className="rtos-inline-warn">⚠ 分析失败: {activeAnalysisResp.error}</span>
        ) : (
          <span className="trace-stat-text rtos-mono">正在聚合当前范围…</span>
        )}
      </div>

      {/* 缺口、时间域跳变、不完整样本提示条 */}
      {((resolvedRange.continuity && !resolvedRange.continuity.continuous)
        || analysis?.timeDomainJump
        || (analysis?.timeDomainWarnings.length ?? 0) > 0
        || (analysis?.approxReason)
        || (analysis && (analysis.totals.excludedIncompleteSlices + analysis.totals.excludedUncertainSlices + analysis.totals.excludedIncompleteActivations + analysis.totals.excludedIncompleteReadyWaits + analysis.totals.excludedIncompleteMarkers) > 0)) && (
        <div className="contexts-warn-bar">
          {resolvedRange.continuity && !resolvedRange.continuity.continuous && (
            <div className="rtos-inline-warn">
              ⚠ A/B 选区连续性阻断: {resolvedRange.continuity.blockingReasons.join('；')}（未跨缺口或跨段推算整段连续耗时，可验证子段内已统计，其余计为 unknown）
            </div>
          )}
          {analysis?.approxReason && (
            <div className="rtos-inline-warn">⚠ {analysis.approxReason}</div>
          )}
          {analysis?.timeDomainWarnings.map((w, idx) => (
            <div key={idx} className="rtos-inline-warn">⚠ {w}</div>
          ))}
          {analysis && analysis.verifiableSegments.length > 0 && (analysis.timeDomainJump || analysis.gapsInWindow.length > 0 || !analysis.verifiable) && (
            <div className="rtos-muted rtos-mono">
              可验证段范围: {analysis.verifiableSegments.map(s => `Seg#${s.segmentId}(boot${s.bootGeneration}, ${s.reliability}) [${formatTraceTimestamp(s.start, activeUnit)}..${formatTraceTimestamp(s.end, activeUnit)})`).join(' | ')}
            </div>
          )}
          {analysis && (analysis.totals.excludedIncompleteSlices + analysis.totals.excludedUncertainSlices + analysis.totals.excludedIncompleteActivations + analysis.totals.excludedIncompleteReadyWaits + analysis.totals.excludedIncompleteMarkers) > 0 && (
            <div className="rtos-muted rtos-mono">
              已排除不完整/不确定样本: 切片(incomplete={analysis.totals.excludedIncompleteSlices}, uncertain={analysis.totals.excludedUncertainSlices}) · 激活={analysis.totals.excludedIncompleteActivations} · Ready={analysis.totals.excludedIncompleteReadyWaits} · Marker={analysis.totals.excludedIncompleteMarkers}（不填 0，不计入 Idle）
            </div>
          )}
        </div>
      )}

      {/* CPU Load 有界分箱图表区 */}
      <section className="contexts-cpuload-card" aria-label="CPU Load 分箱图">
        <div className="contexts-cpuload-header">
          <span className="contexts-legend">
            <strong>CPU Load 有界分箱 ({analysis?.bins.length ?? 0} 箱)</strong>
            <span className="contexts-dot-lbl"><i className="contexts-swatch sw-task" />Task</span>
            <span className="contexts-dot-lbl"><i className="contexts-swatch sw-isr" />ISR(独占)</span>
            <span className="contexts-dot-lbl"><i className="contexts-swatch sw-sched" />Scheduler</span>
            <span className="contexts-dot-lbl"><i className="contexts-swatch sw-idle" />Idle</span>
            <span className="contexts-dot-lbl"><i className="contexts-swatch sw-unknown" />Unknown/缺口</span>
          </span>
          <span className="rtos-mono rtos-muted contexts-bin-hover">
            {hoveredBin ? (
              <>
                箱#{hoveredBin.binIndex} [{formatTraceTimestamp(hoveredBin.start, activeUnit)}..{formatTraceTimestamp(hoveredBin.end, activeUnit)})
                {' · '}Active={formatPct(hoveredBin.activeWindowPct)}
                {BigInt(hoveredBin.unknownDuration) > 0n ? ` (可信=${formatPct(hoveredBin.activeKnownPct)})` : ''}
                {' · '}ISR={formatPct(hoveredBin.isrWindowPct)}
                {' · '}Idle={formatPct(hoveredBin.idleWindowPct)}
                {' · '}Unknown={formatPct(hoveredBin.unknownWindowPct)}
                {hoveredBin.dominantContext ? ` · 主上下文=${hoveredBin.dominantContext.label ?? hoveredBin.dominantContext.contextKey}` : ''}
                {hoveredBin.hasGap ? ` · 缺口:${hoveredBin.gapKinds.join(',')}` : ''}
                {' (点击定位 Trace)'}
              </>
            ) : '悬停分箱查看各层耗时；点击分箱定位到 Trace Timeline'}
          </span>
        </div>
        <div className="contexts-canvas-wrap" ref={chartWrapRef}>
          <canvas
            ref={canvasRef}
            className="contexts-cpuload-canvas"
            style={{ width: chartWidth, height: CHART_HEIGHT }}
            onPointerMove={handleChartPointerMove}
            onPointerLeave={() => setHoveredBinIdx(null)}
            onClick={() => {
              if (hoveredBin) {
                onJumpToTimelineRange(hoveredBin.start, hoveredBin.end);
              }
            }}
          />
        </div>
      </section>

      {/* 子视图切换 & 搜索筛选 */}
      <div className="rtos-filter-bar">
        <div className="rtos-filter-chips" role="tablist" aria-label="统计明细表">
          <button
            type="button"
            role="tab"
            aria-selected={subTab === 'contexts'}
            className={`rtos-chip${subTab === 'contexts' ? ' active' : ''}`}
            onClick={() => setSubTab('contexts')}
          >
            上下文统计 ({analysis?.contexts.length ?? 0}{analysis?.contextsTruncated ? '+' : ''})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={subTab === 'markers'}
            className={`rtos-chip${subTab === 'markers' ? ' active' : ''}`}
            onClick={() => setSubTab('markers')}
          >
            Markers ({analysis?.markers.length ?? 0}{analysis?.markersTruncated ? '+' : ''})
          </button>
        </div>

        {subTab === 'contexts' && (
          <div className="rtos-filter-chips" role="group" aria-label="上下文类型筛选">
            {([
              ['all', '全部'],
              ['task', 'Task'],
              ['isr', 'ISR'],
              ['idle', 'Idle'],
              ['scheduler', 'Sched'],
              ['timer', 'Timer'],
            ] as [ContextStatsKindFilter, string][]).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={`rtos-chip${kindFilter === id ? ' active' : ''}`}
                onClick={() => setKindFilter(id)}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        <input
          type="search"
          aria-label="筛选上下文或 Marker"
          className="rtos-search"
          placeholder={subTab === 'contexts' ? '搜索任务名、TCB、IRQ…' : '搜索 Marker ID 或名称…'}
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
        />

        <span className="rtos-muted" title="Events 虚拟事件列表与 Trace Terminal 将在阶段 5.2 接入">
          Events / Terminal: 阶段 5.2 待接入
        </span>
      </div>

      {/* 明细表 */}
      <div className="rtos-table-scroll">
        {subTab === 'contexts' ? (
          <table className="rtos-table">
            <thead>
              <tr>
                <th>类型</th>
                <th>
                  <button type="button" className="rtos-sort-btn" onClick={() => toggleSort('name')}>
                    上下文 / 实例{sortKey === 'name' ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
                  </button>
                </th>
                <th>
                  <button type="button" className="rtos-sort-btn" onClick={() => toggleSort('cpu')}>
                    独占 CPU 时间 / 占比{sortKey === 'cpu' ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
                  </button>
                </th>
                <th>
                  <button type="button" className="rtos-sort-btn" onClick={() => toggleSort('activations')}>
                    完整激活次数{sortKey === 'activations' ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
                  </button>
                </th>
                <th>
                  <button type="button" className="rtos-sort-btn" onClick={() => toggleSort('exclMax')}>
                    独占 Min / Avg / Max{sortKey === 'exclMax' ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
                  </button>
                </th>
                <th>包含耗时 (含嵌套/抢占)</th>
                <th>
                  <button type="button" className="rtos-sort-btn" onClick={() => toggleSort('readyMax')}>
                    Ready 延迟 Min / Avg / Max{sortKey === 'readyMax' ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              {displayedContexts.length === 0 ? (
                <tr>
                  <td colSpan={7} className="rtos-table-empty">
                    {!selectedRecord
                      ? '请先录制或打开 Trace 归档'
                      : !resolvedRange.valid
                        ? (resolvedRange.reason || '当前选区不可统计')
                        : analysis?.precision === 'approx'
                          ? '当前范围超出精确聚合预算（已降级为 CPU Load 近似分箱），请缩放视口后查看上下文明细'
                          : '当前范围内无匹配的上下文记录'}
                  </td>
                </tr>
              ) : displayedContexts.map(row => {
                const lbl = formatContextLabel(row);
                const hasReusedGen = row.contextKind === 'task' && row.taskGeneration !== undefined && row.taskGeneration > 1;
                return (
                  <tr key={row.contextKey} className="rtos-row">
                    <td>
                      <span className={`rtos-evidence contexts-kind-${row.contextKind}`}>{kindBadgeLabel(row.contextKind)}</span>
                    </td>
                    <td>
                      <div className="rtos-task-name">
                        <span title={`${row.contextKey} (${row.labelSource})`}>{lbl}</span>
                        {row.tcbAddress !== undefined && (
                          <span className="rtos-task-id rtos-mono">{formatHex32(row.tcbAddress)}</span>
                        )}
                        {hasReusedGen && (
                          <span className="rtos-evidence rtos-evidence-validated-tcb" title="TCB 地址复用后的独立任务代次">
                            #g{row.taskGeneration}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="rtos-mono">
                      {row.cpuAccounted ? (
                        <div className="rtos-cpu-cell">
                          <span>{formatTraceDuration(BigInt(row.clippedExclusiveDuration), activeUnit)}</span>
                          <span className="rtos-muted">
                            {formatPct(row.windowPercent)}
                            {analysis && BigInt(analysis.totals.unknownDuration) > 0n
                              ? ` (可信 ${formatPct(row.knownPercent)})`
                              : ''}
                          </span>
                        </div>
                      ) : (
                        <span className="rtos-muted" title="Timer 回调运行于宿主任务切片内，不重复计入 CPU%">
                          不计入CPU% (宿主运行)
                        </span>
                      )}
                    </td>
                    <td className="rtos-mono">
                      <span>{row.completeActivationCount}</span>
                      {(row.boundaryActivationCount > 0 || row.incompleteActivationCount > 0) && (
                        <span className="rtos-muted">
                          {row.boundaryActivationCount > 0 ? ` +${row.boundaryActivationCount}跨界` : ''}
                          {row.incompleteActivationCount > 0 ? ` +${row.incompleteActivationCount}不完整` : ''}
                        </span>
                      )}
                      {row.completeActivationCount === 0 && row.clippedSliceCount > 0 && row.contextKind !== 'task' && row.contextKind !== 'isr' && (
                        <span className="rtos-muted"> ({row.clippedSliceCount} 切片)</span>
                      )}
                    </td>
                    <td className="rtos-mono">
                      {row.exclusiveStats ? (
                        <span>
                          {formatAnalysisDurationStr(row.exclusiveStats.min, activeUnit)} / {formatAnalysisDurationStr(row.exclusiveStats.avg, activeUnit)} / {formatAnalysisDurationStr(row.exclusiveStats.max, activeUnit)}
                        </span>
                      ) : (
                        <span className="rtos-muted" title="仅统计完全落入窗口且起止完整的激活">
                          {row.boundaryActivationCount > 0 ? '— (仅跨界)' : row.incompleteActivationCount > 0 ? 'unknown' : '—'}
                        </span>
                      )}
                    </td>
                    <td className="rtos-mono">
                      {row.inclusiveStats && row.preemptionCountTotal > 0 ? (
                        <span title={`含嵌套/抢占 ${row.preemptionCountTotal} 次（累计被抢占 ${formatTraceDuration(BigInt(row.preemptedTotalDuration), activeUnit)}），此耗时不重复计入 CPU%`}>
                          [含嵌套] {formatAnalysisDurationStr(row.inclusiveStats.min, activeUnit)} / {formatAnalysisDurationStr(row.inclusiveStats.avg, activeUnit)} / {formatAnalysisDurationStr(row.inclusiveStats.max, activeUnit)}
                        </span>
                      ) : row.inclusiveStats ? (
                        <span className="rtos-muted">同独占 (无抢占)</span>
                      ) : (
                        <span className="rtos-muted">—</span>
                      )}
                    </td>
                    <td className="rtos-mono">
                      {row.contextKind !== 'task' ? (
                        <span className="rtos-muted">—</span>
                      ) : row.readyStats ? (
                        <div>
                          <span>
                            {formatAnalysisDurationStr(row.readyStats.min, activeUnit)} / {formatAnalysisDurationStr(row.readyStats.avg, activeUnit)} / {formatAnalysisDurationStr(row.readyStats.max, activeUnit)}
                          </span>
                          <span className="rtos-muted"> ({row.readyCompleteCount}次)</span>
                          {(row.readyIncompleteCount > 0 || row.readyRemovedCount > 0 || row.readyBoundaryCount > 0) && (
                            <span className="rtos-muted">
                              {row.readyIncompleteCount > 0 ? ` · unknown:${row.readyIncompleteCount}` : ''}
                              {row.readyRemovedCount > 0 ? ` · 移出:${row.readyRemovedCount}` : ''}
                              {row.readyBoundaryCount > 0 ? ` · 跨界:${row.readyBoundaryCount}` : ''}
                            </span>
                          )}
                        </div>
                      ) : (
                        <span className="rtos-muted" title="缺少完整 Ready→Running 样本时保持 unknown，不填 0">
                          {row.readyIncompleteCount > 0
                            ? `unknown (缺端点/不完整 ${row.readyIncompleteCount})`
                            : row.readyRemovedCount > 0
                              ? `未调度移出 (${row.readyRemovedCount})`
                              : row.readyBoundaryCount > 0
                                ? `— (仅跨界 ${row.readyBoundaryCount})`
                                : '—'}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <table className="rtos-table">
            <thead>
              <tr>
                <th>Marker ID</th>
                <th>名称</th>
                <th>完整区间数</th>
                <th>耗时 Min / Avg / Max</th>
                <th>累计耗时</th>
                <th>点事件 (EX_MARK)</th>
                <th>关联上下文</th>
              </tr>
            </thead>
            <tbody>
              {displayedMarkers.length === 0 ? (
                <tr>
                  <td colSpan={7} className="rtos-table-empty">
                    {!selectedRecord ? '请先录制或打开 Trace 归档' : '当前范围内无 Marker 记录'}
                  </td>
                </tr>
              ) : displayedMarkers.map(m => (
                <tr key={m.markerId} className="rtos-row">
                  <td className="rtos-mono">M#{m.markerId}</td>
                  <td>
                    <span>{m.name && m.nameSource !== 'missing' ? m.name : '(未命名)'}</span>
                    <span className="rtos-muted"> ({m.nameSource})</span>
                  </td>
                  <td className="rtos-mono">
                    <span>{m.completeCount}</span>
                    {(m.boundaryCount > 0 || m.incompleteCount > 0) && (
                      <span className="rtos-muted">
                        {m.boundaryCount > 0 ? ` +${m.boundaryCount}跨界` : ''}
                        {m.incompleteCount > 0 ? ` +${m.incompleteCount}不完整` : ''}
                      </span>
                    )}
                  </td>
                  <td className="rtos-mono">
                    {m.durationStats ? (
                      <span>
                        {formatAnalysisDurationStr(m.durationStats.min, activeUnit)} / {formatAnalysisDurationStr(m.durationStats.avg, activeUnit)} / {formatAnalysisDurationStr(m.durationStats.max, activeUnit)}
                      </span>
                    ) : (
                      <span className="rtos-muted">{m.incompleteCount > 0 ? 'unknown' : '—'}</span>
                    )}
                  </td>
                  <td className="rtos-mono">
                    {m.durationStats ? formatTraceDuration(BigInt(m.durationStats.total), activeUnit) : '—'}
                  </td>
                  <td className="rtos-mono">
                    {m.pointCount}
                    {m.uncertainPointCount > 0 ? ` (uncertain ${m.uncertainPointCount})` : ''}
                  </td>
                  <td className="rtos-mono rtos-muted">
                    {m.contextKeys.length ? m.contextKeys.join(', ') : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
