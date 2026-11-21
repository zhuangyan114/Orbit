import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TraceRecordingMode } from '../../trace/trace-recording-coordinator';
import { readTimelineTheme } from '../timeline/timeline-theme';
import type { RtosSessionSummary, RtosViewSettings } from './rtos-view-state';
import {
  bigIntToPixelX,
  buildSwimlaneLayout,
  evaluateCursorSpanContinuity,
  formatTraceDuration,
  formatTraceTimestamp,
  getItemTimeRangeForUnit,
  getPointTimeForUnit,
  panBigIntRange,
  pixelXToBigInt,
  resolveGapAnchors,
  segmentScopeKey,
  TRACE_ARCHIVE_CAPABILITIES,
  type SwimlaneRow,
  type TraceActivationDto,
  type TraceAxisDomain,
  type TraceCursorPoint,
  type TraceFocusedEventRef,
  type TraceGapAnchor,
  type TraceMarkerDto,
  type TraceMarkerPointDto,
  type TracePanelState,
  type TracePointInspectResponse,
  type TraceReadyWaitDto,
  type TraceRecordSummary,
  type TraceSliceDto,
  type TraceTimeUnit,
  type TraceViewportResponse,
  zoomBigIntRange,
} from './trace-timeline-state';

export type SharedTraceCursor = {
  timeStr: string;
  unit: TraceTimeUnit;
  bootGeneration?: number;
  segmentId?: number;
};

export interface TraceTimelineViewProps {
  visible: boolean;
  session: RtosSessionSummary;
  settings: RtosViewSettings;
  traceState: TracePanelState;
  selectedRecord: TraceRecordSummary | null;
  axisDomain: TraceAxisDomain;
  selectedScopeKey: string;
  viewRange: { start: string; end: string } | null;
  cursorA: SharedTraceCursor | null;
  cursorB: SharedTraceCursor | null;
  viewportResult: TraceViewportResponse | null;
  hoverInspect: TracePointInspectResponse | null;
  cursorAInspect: TracePointInspectResponse | null;
  cursorBInspect: TracePointInspectResponse | null;
  onChangeScopeKey: (scopeKey: string) => void;
  onChangeViewRange: (range: { start: string; end: string } | null) => void;
  onChangeCursorA: (cursor: SharedTraceCursor | null) => void;
  onChangeCursorB: (cursor: SharedTraceCursor | null) => void;
  clockLinkNotice?: string;
  onClockLink?: (command: 'traceClockLinkToTimeline' | 'traceClockAlign') => void;
  onUpdateSettings: (patch: Partial<RtosViewSettings>) => void;
  onInspectTarget: () => void;
  onStartRecording: (mode: TraceRecordingMode) => void;
  onStopRecording: (recordId?: string) => void;
  onPauseRecording: (recordId?: string) => void;
  onResumeRecording: (recordId?: string) => void;
  onCancelRecording: (recordId?: string) => void;
  onSelectRecord: (recordId: string) => void;
  onOpenRecording: (recordingDir?: string) => void;
  onSaveRecording: (recordId: string, targetDir?: string) => void;
  onExportRaw?: (recordId: string, outputPath?: string) => void;
  onExportCsv?: (req: {
    recordId: string;
    exportSource: 'trace-viewport' | 'ab-selection' | 'full';
    unit: TraceTimeUnit;
    bootGeneration?: number;
    segmentId?: number;
    start: string;
    end: string;
    crossesGap?: boolean;
    outputPath?: string;
  }) => void;
  onCloseRecording: (recordId: string) => void;
  onQueryViewport: (req: {
    querySeq: number;
    recordId: string;
    unit: TraceTimeUnit;
    scopeKey: string;
    bootGeneration?: number;
    segmentId?: number;
    start: string;
    end: string;
    maxBuckets: number;
    detailLimit: number;
  }) => void;
  onInspectPoint: (req: {
    querySeq: number;
    targetKind: 'hover' | 'cursorA' | 'cursorB';
    recordId: string;
    unit: TraceTimeUnit;
    queryTime: string;
    queryStart: string;
    queryEnd: string;
    bootGeneration?: number;
    segmentId?: number;
  }) => void;
  onPerfReport?: (perf: Record<string, unknown>) => void;
  focusedEvent?: TraceFocusedEventRef | null;
  onTimelinePointClick?: (target: {
    recordId: string;
    unit: TraceTimeUnit;
    timeStr: string;
    bootGeneration?: number;
    segmentId?: number;
  }) => void;
  onJumpToEventInEvents?: (target: {
    recordId: string;
    unit: TraceTimeUnit;
    timeStr: string;
    bootGeneration?: number;
    segmentId?: number;
    packetIndexInSegment?: number;
    streamByteOffset?: number;
  }) => void;
}

const LANE_HEADER_WIDTH = 164;
const RULER_HEIGHT = 24;
const ROW_GAP = 2;

const TASK_PALETTE_DARK = ['#4EC9B0', '#3794FF', '#C586C0', '#DCDCAA', '#CE9178', '#569CD6', '#9CDCFE', '#B5CEA8'];
const TASK_PALETTE_LIGHT = ['#0B7A62', '#0066BF', '#9B2D96', '#8A6700', '#B5471D', '#195E9E', '#0E7490', '#3F7D20'];

function hashColor(key: string, light: boolean): string {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const palette = light ? TASK_PALETTE_LIGHT : TASK_PALETTE_DARK;
  return palette[(h >>> 0) % palette.length];
}

function stateLabel(state: string): { label: string; tone: 'ok' | 'info' | 'warn' | 'error' } {
  switch (state) {
    case 'recording':
      return { label: '录制中', tone: 'ok' };
    case 'preparing':
      return { label: '准备中', tone: 'info' };
    case 'paused':
      return { label: '已暂停接收', tone: 'warn' };
    case 'stopping':
      return { label: '停止排空中', tone: 'info' };
    case 'stopped':
    case 'completed':
      return { label: '已完成', tone: 'ok' };
    case 'incomplete':
    case 'interrupted':
      return { label: '不完整', tone: 'warn' };
    case 'error':
    case 'failed':
    case 'corrupted':
      return { label: '错误/损坏', tone: 'error' };
    default:
      return { label: state, tone: 'info' };
  }
}

function integrityLabel(integrity: string | undefined): { label: string; tone: 'ok' | 'warn' | 'error' | 'info' } {
  switch (integrity) {
    case 'complete':
      return { label: '完整', tone: 'ok' };
    case 'target-overflow':
      return { label: '目标溢出', tone: 'warn' };
    case 'prefix-overwritten':
      return { label: '前缀被覆盖', tone: 'warn' };
    case 'empty':
      return { label: '空缓冲', tone: 'warn' };
    case 'no-sync':
      return { label: '无有效同步', tone: 'error' };
    case 'incomplete':
      return { label: '不完整', tone: 'warn' };
    default:
      return { label: '未知', tone: 'info' };
  }
}

function unitLabel(unit: TraceTimeUnit): string {
  switch (unit) {
    case 'ns':
      return '绝对时间 (ns)';
    case 'relative-ns':
      return '段内相对 (ns)';
    case 'absolute-ticks':
      return '绝对 Ticks';
    case 'relative-ticks':
      return '段内 Ticks';
  }
}

let nextTimelineQuerySeq = 1;

export function TraceTimelineView(props: TraceTimelineViewProps) {
  const {
    visible,
    session,
    settings,
    traceState,
    selectedRecord,
    axisDomain,
    selectedScopeKey,
    viewRange,
    cursorA,
    cursorB,
    viewportResult,
    hoverInspect,
    cursorAInspect,
    cursorBInspect,
    onChangeScopeKey: setSelectedScopeKey,
    onChangeViewRange: setViewRange,
    onChangeCursorA: setCursorA,
    onChangeCursorB: setCursorB,
    onUpdateSettings,
    onInspectTarget,
    onStartRecording,
    onStopRecording,
    onPauseRecording,
    onResumeRecording,
    onCancelRecording,
    onSelectRecord,
    onOpenRecording,
    onSaveRecording,
    onExportRaw,
    onExportCsv,
    onCloseRecording,
    onQueryViewport,
    onInspectPoint,
    onPerfReport,
    focusedEvent = null,
    onTimelinePointClick,
    onJumpToEventInEvents,
  } = props;

  const [hoverInfo, setHoverInfo] = useState<{ x: number; y: number; timeStr: string } | null>(null);
  const [canvasSize, setCanvasSize] = useState<{ width: number; height: number }>({ width: 640, height: 260 });

  const activeUnit = axisDomain.unit;
  const activeScopeKey = axisDomain.scopeKey;
  const activeRecordId = selectedRecord?.recordId ?? null;

  const gapAnchors = useMemo<TraceGapAnchor[]>(() => {
    if (!selectedRecord || !axisDomain.valid) return [];
    return resolveGapAnchors(
      selectedRecord.segments,
      selectedRecord.gaps,
      activeUnit,
      axisDomain.bootGeneration,
      axisDomain.segmentId,
    );
  }, [selectedRecord, axisDomain, activeUnit]);

  const activeViewport = useMemo(() => {
    if (!viewportResult || !activeRecordId || viewportResult.recordId !== activeRecordId) return null;
    if (viewportResult.unit !== activeUnit) return null;
    return viewportResult;
  }, [viewportResult, activeRecordId, activeUnit]);

  const lanes = useMemo<SwimlaneRow[]>(() => {
    if (!activeViewport) {
      return [
        { id: 'overview', kind: 'overview', label: '概览 / LOD', subLabel: '等待查询', heightPx: 28 },
        { id: 'markers', kind: 'markers', label: 'Markers', subLabel: '—', heightPx: 28 },
      ];
    }
    return buildSwimlaneLayout(
      activeViewport.slices,
      activeViewport.activations,
      activeViewport.readyWaits,
      activeViewport.markers,
      activeViewport.markerPoints,
    );
  }, [activeViewport]);

  const totalCanvasContentHeight = useMemo(
    () => RULER_HEIGHT + lanes.reduce((sum, r) => sum + r.heightPx + ROW_GAP, 0) + 12,
    [lanes],
  );

  // Refs for rAF painting & coalesced queries without unnecessary re-renders
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const canvasWrapRef = useRef<HTMLDivElement | null>(null);
  const querySeqRef = useRef(0);
  const lastDispatchedQuerySeqRef = useRef(0);
  const inspectSeqRef = useRef(0);
  const queryDebounceRef = useRef<number | null>(null);
  const hoverDebounceRef = useRef<number | null>(null);
  const paintRafRef = useRef<number | null>(null);
  const dragStateRef = useRef<{
    kind: 'none' | 'pan' | 'cursorA' | 'cursorB';
    pointerId: number;
    startX: number;
    moved: boolean;
    origStart: bigint;
    origEnd: bigint;
  } | null>(null);

  const perfRef = useRef({
    frameCount: 0,
    lastDrawMs: 0,
    maxDrawMs: 0,
    over16msFrames: 0,
    over50msDrawFrames: 0,
    longTasksOver50ms: 0,
    maxLongTaskMs: 0,
    viewportQueriesSent: 0,
    viewportRepliesApplied: 0,
    droppedStaleReplies: 0,
    lastViewportQueryMs: 0,
    lastPointInspectMs: 0,
  });
  const lastReportedRepliesRef = useRef(-1);

  // Track Chromium Long Tasks (>50ms) when PerformanceObserver supports it
  useEffect(() => {
    if (typeof PerformanceObserver === 'undefined') return;
    try {
      const obs = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration > 50) {
            perfRef.current.longTasksOver50ms++;
            if (entry.duration > perfRef.current.maxLongTaskMs) {
              perfRef.current.maxLongTaskMs = Math.round(entry.duration * 100) / 100;
            }
          }
        }
      });
      obs.observe({ entryTypes: ['longtask'] });
      return () => obs.disconnect();
    } catch {
      return undefined;
    }
  }, []);

  // Track dropped stale replies & query latency
  useEffect(() => {
    if (!viewportResult) return;
    if (viewportResult.querySeq < lastDispatchedQuerySeqRef.current) {
      perfRef.current.droppedStaleReplies++;
      return;
    }
    perfRef.current.viewportRepliesApplied++;
    perfRef.current.lastViewportQueryMs = viewportResult.queryDurationMs;
  }, [viewportResult]);

  useEffect(() => {
    const pt = hoverInspect || cursorAInspect || cursorBInspect;
    if (pt) {
      perfRef.current.lastPointInspectMs = pt.queryDurationMs;
    }
  }, [hoverInspect, cursorAInspect, cursorBInspect]);

  const prevAxisClearRef = useRef<string>('');
  useEffect(() => {
    const axisKey = `${activeRecordId ?? ''}::${activeScopeKey}::${activeUnit}`;
    if (prevAxisClearRef.current !== axisKey) {
      prevAxisClearRef.current = axisKey;
      setHoverInfo(null);
    }
  }, [activeRecordId, activeScopeKey, activeUnit]);

  // Trigger coalesced Worker viewport query whenever visible & record/viewRange/commitSeq updates
  const committedBytes = selectedRecord?.counters.committedRawBytes ?? 0;
  const triggerViewportQuery = useCallback((
    recordId: string,
    startStr: string,
    endStr: string,
    immediate = false,
  ) => {
    if (!visible || !axisDomain.valid) return;
    const run = () => {
      const seq = nextTimelineQuerySeq++;
      lastDispatchedQuerySeqRef.current = seq;
      perfRef.current.viewportQueriesSent++;
      const maxBuckets = Math.max(64, Math.min(512, Math.floor(canvasSize.width / 2) || 256));
      onQueryViewport({
        querySeq: seq,
        recordId,
        unit: activeUnit,
        scopeKey: activeScopeKey,
        ...(axisDomain.bootGeneration !== undefined ? { bootGeneration: axisDomain.bootGeneration } : {}),
        ...(axisDomain.segmentId !== undefined ? { segmentId: axisDomain.segmentId } : {}),
        start: startStr,
        end: endStr,
        maxBuckets,
        detailLimit: 1200,
      });
    };
    if (queryDebounceRef.current !== null) {
      window.clearTimeout(queryDebounceRef.current);
      queryDebounceRef.current = null;
    }
    if (immediate) {
      run();
    } else {
      queryDebounceRef.current = window.setTimeout(run, 24);
    }
  }, [visible, axisDomain, canvasSize.width, activeUnit, activeScopeKey, onQueryViewport]);

  useEffect(() => {
    if (!visible || !activeRecordId || !axisDomain.valid || !viewRange) return;
    triggerViewportQuery(activeRecordId, viewRange.start, viewRange.end, false);
    return () => {
      if (queryDebounceRef.current !== null) {
        window.clearTimeout(queryDebounceRef.current);
        queryDebounceRef.current = null;
      }
    };
  }, [visible, activeRecordId, axisDomain.valid, viewRange, committedBytes, triggerViewportQuery]);

  // ResizeObserver for crisp DPR-aware canvas sizing
  useEffect(() => {
    const el = canvasWrapRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const updateSize = () => {
      const rect = el.getBoundingClientRect();
      const w = Math.max(120, Math.floor(rect.width));
      const h = Math.max(160, Math.floor(rect.height));
      setCanvasSize(prev => (prev.width === w && prev.height === h ? prev : { width: w, height: h }));
    };
    updateSize();
    const ro = new ResizeObserver(updateSize);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Canvas Painter
  const paintCanvas = useCallback(() => {
    if (!visible) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const t0 = performance.now();
    const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const width = canvasSize.width;
    const height = Math.max(canvasSize.height, totalCanvasContentHeight);
    if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const theme = readTimelineTheme();
    const isLight = document.body.classList.contains('vscode-light') || document.body.classList.contains('vscode-high-contrast-light');

    ctx.fillStyle = theme.background;
    ctx.fillRect(0, 0, width, height);

    if (!axisDomain.valid || !viewRange) {
      ctx.fillStyle = theme.label;
      ctx.font = '12px var(--vscode-font-family, sans-serif)';
      ctx.fillText(selectedRecord ? (axisDomain.reason || '无可用时间数据') : '请选择录制或打开离线录制目录', 16, 40);
      return;
    }

    const vStart = BigInt(viewRange.start);
    const vEnd = BigInt(viewRange.end);
    if (vEnd <= vStart) return;

    // 1. Time grid & top ruler
    ctx.fillStyle = isLight ? 'rgba(0,0,0,0.03)' : 'rgba(255,255,255,0.03)';
    ctx.fillRect(0, 0, width, RULER_HEIGHT);
    ctx.strokeStyle = isLight ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, RULER_HEIGHT - 0.5);
    ctx.lineTo(width, RULER_HEIGHT - 0.5);
    ctx.stroke();

    const divs = Math.max(4, Math.min(10, Math.floor(width / 110)));
    const span = vEnd - vStart;
    ctx.font = '10px var(--vscode-editor-font-family, monospace)';
    ctx.fillStyle = theme.label;
    for (let i = 0; i <= divs; i++) {
      const t = vStart + (span * BigInt(i)) / BigInt(divs);
      const x = Math.round((i / divs) * width) + 0.5;
      ctx.strokeStyle = isLight ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.06)';
      ctx.beginPath();
      ctx.moveTo(x, RULER_HEIGHT);
      ctx.lineTo(x, height);
      ctx.stroke();
      const label = formatTraceTimestamp(t.toString(), activeUnit);
      const textX = i === divs ? Math.max(2, x - ctx.measureText(label).width - 4) : x + 3;
      ctx.fillText(label, textX, 16);
    }

    // Build row Y map
    let curY = RULER_HEIGHT;
    const rowY = new Map<string, { y: number; h: number }>();
    for (const r of lanes) {
      rowY.set(r.id, { y: curY, h: r.heightPx });
      ctx.strokeStyle = isLight ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.06)';
      ctx.beginPath();
      ctx.moveTo(0, curY + r.heightPx + 0.5);
      ctx.lineTo(width, curY + r.heightPx + 0.5);
      ctx.stroke();
      curY += r.heightPx + ROW_GAP;
    }

    // 2. Uncertain segment shading
    for (const seg of axisDomain.includedSegments) {
      if (seg.reliability !== 'uncertain') continue;
      const sb = activeUnit === 'ns' && seg.minNs && seg.maxNs
        ? { s: BigInt(seg.minNs), e: BigInt(seg.maxNs) }
        : activeUnit === 'absolute-ticks' && seg.firstAbsoluteTicks && seg.lastAbsoluteTicks
          ? { s: BigInt(seg.firstAbsoluteTicks), e: BigInt(seg.lastAbsoluteTicks) }
          : activeUnit === 'relative-ticks'
            ? { s: BigInt(seg.minRelativeTicks), e: BigInt(seg.maxRelativeTicks) }
            : null;
      if (!sb) continue;
      const x0 = Math.max(0, bigIntToPixelX(sb.s, vStart, vEnd, width));
      const x1 = Math.min(width, bigIntToPixelX(sb.e, vStart, vEnd, width));
      if (x1 > x0) {
        ctx.fillStyle = 'rgba(204, 167, 0, 0.08)';
        ctx.fillRect(x0, RULER_HEIGHT, x1 - x0, height - RULER_HEIGHT);
      }
    }

    // 3. Overview LOD Track
    const ovBox = rowY.get('overview');
    if (ovBox && activeViewport?.lodBuckets.length) {
      for (const b of activeViewport.lodBuckets) {
        const bs = BigInt(b.start);
        const be = BigInt(b.end);
        const x0 = bigIntToPixelX(bs, vStart, vEnd, width);
        const x1 = Math.max(x0 + 1, bigIntToPixelX(be, vStart, vEnd, width));
        const bw = x1 - x0;
        const taskT = BigInt(b.activeTicksByKind.task);
        const isrT = BigInt(b.activeTicksByKind.isr);
        const schedT = BigInt(b.activeTicksByKind.scheduler);
        const idleT = BigInt(b.activeTicksByKind.idle);
        const totalT = taskT + isrT + schedT + idleT;

        if (totalT > 0n) {
          const activeRatio = Number(((taskT + isrT + schedT) * 1000n) / totalT) / 1000;
          const isrRatio = Number((isrT * 1000n) / totalT) / 1000;
          const barH = Math.max(2, Math.round((ovBox.h - 6) * activeRatio));
          ctx.fillStyle = isLight ? 'rgba(0,102,191,0.55)' : 'rgba(55,148,255,0.65)';
          ctx.fillRect(x0, ovBox.y + ovBox.h - 3 - barH, bw, barH);
          if (isrRatio > 0) {
            const isrH = Math.max(2, Math.round((ovBox.h - 6) * isrRatio));
            ctx.fillStyle = isLight ? '#C93B2B' : '#F48771';
            ctx.fillRect(x0, ovBox.y + ovBox.h - 3 - isrH, bw, isrH);
          }
        } else if (b.intervalCount > 0 || b.packetCount > 0) {
          // Reopened basic LOD summary (density fallback)
          const density = Math.min(1, (b.intervalCount + b.packetCount * 0.25) / 64);
          const barH = Math.max(3, Math.round((ovBox.h - 6) * density));
          ctx.fillStyle = isLight ? 'rgba(11,122,98,0.45)' : 'rgba(78,201,176,0.5)';
          ctx.fillRect(x0, ovBox.y + ovBox.h - 3 - barH, bw, barH);
        }

        if (b.hasGap || b.hasUncertain) {
          ctx.fillStyle = b.hasGap ? '#F48771' : '#CCA700';
          ctx.fillRect(x0, ovBox.y + 1, Math.max(2, bw), 3);
        }
      }
    }

    if (!activeViewport) return;

    // 4. ISR Activations (inclusive outline for preempted nested ISRs) & Slices (exclusive fill)
    for (const act of activeViewport.activations) {
      if (act.kind !== 'isr') continue;
      const box = rowY.get(`isr:${act.contextKey}`);
      if (!box) continue;
      const r = getItemTimeRangeForUnit(act, activeUnit);
      if (!r) continue;
      const x0 = bigIntToPixelX(r.start, vStart, vEnd, width);
      const x1 = bigIntToPixelX(r.end, vStart, vEnd, width);
      const w = Math.max(2, x1 - x0);
      if (x1 < 0 || x0 > width) continue;
      ctx.fillStyle = isLight ? 'rgba(201,59,43,0.18)' : 'rgba(244,135,113,0.20)';
      ctx.fillRect(x0, box.y + 3, w, box.h - 6);
      ctx.strokeStyle = isLight ? '#C93B2B' : '#F48771';
      if (act.completeness !== 'complete' || act.isEndObservedOnly) ctx.setLineDash([3, 2]);
      ctx.strokeRect(x0 + 0.5, box.y + 3.5, Math.max(1, w - 1), box.h - 7);
      ctx.setLineDash([]);
    }

    // 5. Execution Slices (Task, Idle, ISR exclusive, Scheduler)
    for (const sl of activeViewport.slices) {
      const rowId = sl.contextKind === 'isr'
        ? `isr:${sl.contextKey}`
        : sl.contextKind === 'scheduler'
          ? 'scheduler'
          : `task:${sl.taskInstanceId ?? sl.contextKey}`;
      const box = rowY.get(rowId);
      if (!box) continue;
      const r = getItemTimeRangeForUnit(sl, activeUnit);
      if (!r) continue;
      const x0 = bigIntToPixelX(r.start, vStart, vEnd, width);
      const x1 = bigIntToPixelX(r.end, vStart, vEnd, width);
      const w = Math.max(1.5, x1 - x0);
      if (x1 < 0 || x0 > width) continue;

      const isTaskWithReady = sl.contextKind === 'task';
      const barY = box.y + 3;
      const barH = isTaskWithReady ? Math.floor((box.h - 6) * 0.65) : box.h - 6;

      if (sl.contextKind === 'isr') {
        ctx.fillStyle = isLight ? '#C93B2B' : '#F48771';
      } else if (sl.contextKind === 'scheduler') {
        ctx.fillStyle = isLight ? '#7C3AED' : '#C586C0';
      } else if (sl.contextKind === 'idle') {
        ctx.fillStyle = isLight ? 'rgba(100,116,139,0.45)' : 'rgba(148,163,184,0.38)';
      } else {
        ctx.fillStyle = hashColor(sl.taskInstanceId ?? sl.contextKey, isLight);
      }

      if (sl.completeness === 'uncertain' || sl.segmentReliability === 'uncertain') {
        ctx.globalAlpha = 0.72;
      }
      ctx.fillRect(x0, barY, w, barH);
      ctx.globalAlpha = 1;

      if (sl.completeness !== 'complete' || sl.isEndObservedOnly) {
        ctx.strokeStyle = '#CCA700';
        ctx.setLineDash([3, 2]);
        ctx.strokeRect(x0 + 0.5, barY + 0.5, Math.max(1, w - 1), barH - 1);
        ctx.setLineDash([]);
      }
    }

    // 6. Ready Wait sub-bars inside each task row
    for (const rw of activeViewport.readyWaits) {
      const box = rowY.get(`task:${rw.taskInstanceId}`);
      if (!box) continue;
      const r = getItemTimeRangeForUnit(rw, activeUnit);
      if (!r) continue;
      const x0 = bigIntToPixelX(r.start, vStart, vEnd, width);
      const x1 = bigIntToPixelX(r.end, vStart, vEnd, width);
      const w = Math.max(1.5, x1 - x0);
      if (x1 < 0 || x0 > width) continue;

      const readyY = box.y + box.h - 9;
      const readyH = 6;
      ctx.fillStyle = rw.outcome === 'dispatched'
        ? (isLight ? '#0284C7' : '#38BDF8')
        : rw.outcome === 'removed-from-ready'
          ? (isLight ? '#D97706' : '#FBBF24')
          : (isLight ? '#9CA3AF' : '#64748B');
      ctx.fillRect(x0, readyY, w, readyH);
      if (rw.completeness !== 'complete' || rw.isEndObservedOnly) {
        ctx.strokeStyle = '#CCA700';
        ctx.setLineDash([2, 2]);
        ctx.strokeRect(x0 + 0.5, readyY + 0.5, Math.max(1, w - 1), readyH - 1);
        ctx.setLineDash([]);
      }
    }

    // 7. Markers lane (intervals + point markers)
    const mkBox = rowY.get('markers');
    if (mkBox) {
      for (const mk of activeViewport.markers) {
        const r = getItemTimeRangeForUnit(mk, activeUnit);
        if (!r) continue;
        const x0 = bigIntToPixelX(r.start, vStart, vEnd, width);
        const x1 = bigIntToPixelX(r.end, vStart, vEnd, width);
        const w = Math.max(3, x1 - x0);
        if (x1 < 0 || x0 > width) continue;
        ctx.fillStyle = isLight ? 'rgba(217,119,6,0.3)' : 'rgba(255,209,102,0.32)';
        ctx.fillRect(x0, mkBox.y + 4, w, mkBox.h - 12);
        ctx.strokeStyle = isLight ? '#B45309' : '#FFD166';
        if (mk.completeness !== 'complete' || mk.isEndObservedOnly) ctx.setLineDash([3, 2]);
        ctx.strokeRect(x0 + 0.5, mkBox.y + 4.5, Math.max(2, w - 1), mkBox.h - 13);
        ctx.setLineDash([]);
        if (w > 28) {
          ctx.fillStyle = theme.foreground;
          ctx.font = '10px var(--vscode-editor-font-family, monospace)';
          const lbl = mk.name && mk.nameSource !== 'missing' ? mk.name : `M#${mk.markerId}`;
          ctx.fillText(lbl, x0 + 3, mkBox.y + 15, w - 6);
        }
      }
      for (const mp of activeViewport.markerPoints) {
        const pt = getPointTimeForUnit(mp, activeUnit);
        if (pt === null) continue;
        const x = bigIntToPixelX(pt, vStart, vEnd, width);
        if (x < -6 || x > width + 6) continue;
        const cy = mkBox.y + mkBox.h - 7;
        ctx.fillStyle = isLight ? '#B45309' : '#FFD166';
        ctx.beginPath();
        ctx.moveTo(x, cy - 5);
        ctx.lineTo(x + 4, cy);
        ctx.lineTo(x, cy + 5);
        ctx.lineTo(x - 4, cy);
        ctx.closePath();
        ctx.fill();
      }
    }

    // 8. Gap vertical bands & labels
    for (const anchor of gapAnchors) {
      const gs = BigInt(anchor.start);
      const ge = BigInt(anchor.end);
      const x0 = bigIntToPixelX(gs, vStart, vEnd, width);
      const x1 = bigIntToPixelX(ge, vStart, vEnd, width);
      if (x1 < -12 || x0 > width + 12) continue;
      const bw = Math.max(2, x1 - x0);
      if (bw > 2) {
        ctx.fillStyle = 'rgba(244, 135, 113, 0.16)';
        ctx.fillRect(x0, RULER_HEIGHT, bw, height - RULER_HEIGHT);
      }
      ctx.strokeStyle = anchor.gap.kind === 'eof' || anchor.gap.kind === 'trace-stop' ? '#808080' : '#F48771';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(x0, RULER_HEIGHT);
      ctx.lineTo(x0, height);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineWidth = 1;
      ctx.fillStyle = anchor.gap.kind === 'eof' || anchor.gap.kind === 'trace-stop' ? theme.label : '#F48771';
      ctx.font = '10px var(--vscode-editor-font-family, monospace)';
      const badgeX = Math.max(2, Math.min(width - 70, x0 + 3));
      ctx.fillText(anchor.gap.kind, badgeX, RULER_HEIGHT + 11);
    }

    // 9. Cursor A & B span shading and lines
    const xA = cursorA ? bigIntToPixelX(BigInt(cursorA.timeStr), vStart, vEnd, width) : null;
    const xB = cursorB ? bigIntToPixelX(BigInt(cursorB.timeStr), vStart, vEnd, width) : null;
    if (xA !== null && xB !== null) {
      const loX = Math.max(0, Math.min(xA, xB));
      const hiX = Math.min(width, Math.max(xA, xB));
      if (hiX > loX) {
        const continuity = evaluateCursorSpanContinuity(
          { ...cursorA!, inspect: cursorAInspect },
          { ...cursorB!, inspect: cursorBInspect },
          selectedRecord?.segments ?? [],
          selectedRecord?.gaps ?? [],
          activeUnit,
        );
        ctx.fillStyle = continuity.continuous
          ? 'rgba(78, 201, 176, 0.10)'
          : 'rgba(244, 135, 113, 0.14)';
        ctx.fillRect(loX, RULER_HEIGHT, hiX - loX, height - RULER_HEIGHT);
      }
    }

    const drawCursorLine = (x: number | null, color: string, tag: string) => {
      if (x === null || x < -4 || x > width + 4) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
      ctx.lineWidth = 1;
      ctx.fillStyle = color;
      ctx.fillRect(x - 7, 1, 14, 14);
      ctx.fillStyle = '#000000';
      ctx.font = 'bold 10px sans-serif';
      ctx.fillText(tag, x - 3.5, 11.5);
    };
    drawCursorLine(xA, theme.cursorA, 'A');
    drawCursorLine(xB, theme.cursorB, 'B');

    // 9b. Focused Event highlight marker from Events / Terminal bidirectional jump
    if (
      focusedEvent &&
      activeRecordId &&
      focusedEvent.recordId === activeRecordId &&
      focusedEvent.unit === activeUnit
    ) {
      const xf = bigIntToPixelX(BigInt(focusedEvent.timeStr), vStart, vEnd, width);
      if (xf >= 0 && xf <= width) {
        ctx.save();
        ctx.strokeStyle = isLight ? '#007ACC' : '#4FC1FF';
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(xf, RULER_HEIGHT);
        ctx.lineTo(xf, height);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = isLight ? '#007ACC' : '#4FC1FF';
        ctx.beginPath();
        ctx.arc(xf, RULER_HEIGHT + 5, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }

    // 10. Hover hairline
    if (hoverInfo) {
      const hx = hoverInfo.x;
      ctx.strokeStyle = isLight ? 'rgba(0,0,0,0.45)' : 'rgba(255,255,255,0.45)';
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(hx, RULER_HEIGHT);
      ctx.lineTo(hx, height);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    const drawMs = performance.now() - t0;
    const p = perfRef.current;
    p.frameCount++;
    p.lastDrawMs = Math.round(drawMs * 1000) / 1000;
    if (p.lastDrawMs > p.maxDrawMs) p.maxDrawMs = p.lastDrawMs;
    if (drawMs > 16.6) p.over16msFrames++;
    if (drawMs > 50) p.over50msDrawFrames++;
    if (onPerfReport && (p.frameCount <= 5 || p.frameCount % 10 === 0 || p.viewportRepliesApplied !== lastReportedRepliesRef.current)) {
      lastReportedRepliesRef.current = p.viewportRepliesApplied;
      onPerfReport({ ...p });
    }
  }, [
    visible,
    canvasSize,
    totalCanvasContentHeight,
    axisDomain,
    viewRange,
    selectedRecord,
    activeUnit,
    lanes,
    activeViewport,
    gapAnchors,
    cursorA,
    cursorB,
    cursorAInspect,
    cursorBInspect,
    focusedEvent,
    hoverInfo,
    onPerfReport,
  ]);

  const schedulePaint = useCallback(() => {
    if (!visible || paintRafRef.current !== null) return;
    paintRafRef.current = window.requestAnimationFrame(() => {
      paintRafRef.current = null;
      paintCanvas();
    });
  }, [visible, paintCanvas]);

  useEffect(() => {
    schedulePaint();
  }, [schedulePaint]);

  useEffect(() => {
    return () => {
      if (paintRafRef.current !== null) {
        window.cancelAnimationFrame(paintRafRef.current);
      }
      if (hoverDebounceRef.current !== null) {
        window.clearTimeout(hoverDebounceRef.current);
      }
    };
  }, []);

  const issueExactPointQuery = useCallback((
    targetKind: 'hover' | 'cursorA' | 'cursorB',
    timeBig: bigint,
    hitRadiusBig: bigint,
  ) => {
    if (!activeRecordId || !axisDomain.valid) return;
    const seq = ++inspectSeqRef.current;
    const half = hitRadiusBig > 0n ? hitRadiusBig : 0n;
    const qStart = timeBig >= half ? timeBig - half : 0n;
    const qEnd = timeBig + half + 1n;
    onInspectPoint({
      querySeq: seq,
      targetKind,
      recordId: activeRecordId,
      unit: activeUnit,
      queryTime: timeBig.toString(),
      queryStart: qStart.toString(),
      queryEnd: qEnd.toString(),
      ...(axisDomain.bootGeneration !== undefined ? { bootGeneration: axisDomain.bootGeneration } : {}),
      ...(axisDomain.segmentId !== undefined ? { segmentId: axisDomain.segmentId } : {}),
    });
  }, [activeRecordId, axisDomain, activeUnit, onInspectPoint]);

  const placeOrUpdateCursor = useCallback((kind: 'A' | 'B', timeBig: bigint) => {
    const point = {
      timeStr: timeBig.toString(),
      unit: activeUnit,
      bootGeneration: axisDomain.bootGeneration,
      segmentId: axisDomain.segmentId,
    };
    if (kind === 'A') {
      setCursorA(point);
      issueExactPointQuery('cursorA', timeBig, 0n);
      if (activeRecordId) {
        onTimelinePointClick?.({
          recordId: activeRecordId,
          unit: activeUnit,
          timeStr: timeBig.toString(),
          bootGeneration: axisDomain.bootGeneration,
          segmentId: axisDomain.segmentId,
        });
      }
    } else {
      setCursorB(point);
      issueExactPointQuery('cursorB', timeBig, 0n);
    }
  }, [activeRecordId, activeUnit, axisDomain.bootGeneration, axisDomain.segmentId, issueExactPointQuery, onTimelinePointClick]);

  const buildJumpToEventsTarget = useCallback(() => {
    if (!activeRecordId || !cursorA) return null;
    const matchesFocused = Boolean(
      focusedEvent &&
      focusedEvent.recordId === activeRecordId &&
      focusedEvent.unit === cursorA.unit &&
      focusedEvent.timeStr === cursorA.timeStr &&
      (cursorA.bootGeneration === undefined || focusedEvent.bootGeneration === cursorA.bootGeneration) &&
      (cursorA.segmentId === undefined || focusedEvent.segmentId === cursorA.segmentId),
    );
    if (matchesFocused && focusedEvent) {
      return {
        recordId: activeRecordId,
        unit: cursorA.unit,
        timeStr: cursorA.timeStr,
        bootGeneration: focusedEvent.bootGeneration,
        segmentId: focusedEvent.segmentId,
        packetIndexInSegment: focusedEvent.packetIndexInSegment,
        streamByteOffset: focusedEvent.streamByteOffset,
      };
    }
    const firstPkt = cursorAInspect?.packets[0];
    return {
      recordId: activeRecordId,
      unit: cursorA.unit,
      timeStr: cursorA.timeStr,
      bootGeneration: cursorAInspect?.bootGeneration ?? firstPkt?.bootGeneration ?? cursorA.bootGeneration,
      segmentId: cursorAInspect?.segmentId ?? firstPkt?.segmentId ?? cursorA.segmentId,
      packetIndexInSegment: firstPkt?.packetIndexInSegment,
      streamByteOffset: firstPkt?.streamByteOffset,
    };
  }, [activeRecordId, cursorA, focusedEvent, cursorAInspect]);

  const cursorContinuity = useMemo(() => {
    if (!cursorA || !cursorB || !selectedRecord) return null;
    const ptA: TraceCursorPoint = { ...cursorA, inspect: cursorAInspect };
    const ptB: TraceCursorPoint = { ...cursorB, inspect: cursorBInspect };
    return evaluateCursorSpanContinuity(ptA, ptB, selectedRecord.segments, selectedRecord.gaps, activeUnit);
  }, [cursorA, cursorB, cursorAInspect, cursorBInspect, selectedRecord, activeUnit]);

  const activeAnyLive = traceState.records.some(
    r => r.state === 'recording' || r.state === 'preparing' || r.state === 'paused' || r.state === 'stopping',
  );
  const canStart = (session.phase === 'connected' || session.phase === 'starting') && !activeAnyLive;
  const activeRecordingRecord = traceState.records.find(
    r => r.state === 'recording' || r.state === 'preparing' || r.state === 'paused' || r.state === 'stopping',
  );
  const canSaveSelected = Boolean(
    selectedRecord
    && selectedRecord.recordingDir
    && selectedRecord.state !== 'recording'
    && selectedRecord.state !== 'preparing'
    && selectedRecord.state !== 'paused'
    && selectedRecord.state !== 'stopping',
  );
  const canExportRawSelected = Boolean(
    onExportRaw
    && selectedRecord
    && selectedRecord.state !== 'recording'
    && selectedRecord.state !== 'preparing'
    && selectedRecord.state !== 'paused'
    && selectedRecord.state !== 'stopping',
  );
  const canExportViewportCsv = Boolean(
    onExportCsv
    && activeRecordId
    && axisDomain.valid
    && viewRange
    && BigInt(viewRange.end) > BigInt(viewRange.start),
  );
  const canExportSelectionCsv = Boolean(
    onExportCsv
    && activeRecordId
    && axisDomain.valid
    && cursorA
    && cursorB
    && cursorA.unit === activeUnit
    && cursorB.unit === activeUnit
    && BigInt(cursorA.timeStr) !== BigInt(cursorB.timeStr),
  );

  const triggerExportViewportCsv = useCallback((outputPath?: string): boolean => {
    if (!onExportCsv || !activeRecordId || !axisDomain.valid || !viewRange) return false;
    const startStr = viewRange.start;
    const endStr = viewRange.end === axisDomain.displayMaxStr
      ? (BigInt(viewRange.end) + 1n).toString()
      : viewRange.end;
    if (BigInt(endStr) <= BigInt(startStr)) return false;
    onExportCsv({
      recordId: activeRecordId,
      exportSource: 'trace-viewport',
      unit: activeUnit,
      ...(axisDomain.bootGeneration !== undefined ? { bootGeneration: axisDomain.bootGeneration } : {}),
      ...(axisDomain.segmentId !== undefined ? { segmentId: axisDomain.segmentId } : {}),
      start: startStr,
      end: endStr,
      ...(outputPath ? { outputPath } : {}),
    });
    return true;
  }, [onExportCsv, activeRecordId, axisDomain, viewRange, activeUnit]);

  const triggerExportSelectionCsv = useCallback((outputPath?: string): boolean => {
    if (!onExportCsv || !activeRecordId || !axisDomain.valid || !cursorA || !cursorB) return false;
    if (cursorA.unit !== activeUnit || cursorB.unit !== activeUnit) return false;
    const tA = BigInt(cursorA.timeStr);
    const tB = BigInt(cursorB.timeStr);
    if (tA === tB) return false;
    const lo = tA < tB ? tA : tB;
    const hi = tA < tB ? tB : tA;
    const endStr = hi.toString() === axisDomain.displayMaxStr ? (hi + 1n).toString() : hi.toString();
    onExportCsv({
      recordId: activeRecordId,
      exportSource: 'ab-selection',
      unit: activeUnit,
      ...(axisDomain.bootGeneration !== undefined ? { bootGeneration: axisDomain.bootGeneration } : {}),
      ...(axisDomain.segmentId !== undefined ? { segmentId: axisDomain.segmentId } : {}),
      start: lo.toString(),
      end: endStr,
      crossesGap: cursorContinuity ? !cursorContinuity.continuous : false,
      ...(outputPath ? { outputPath } : {}),
    });
    return true;
  }, [onExportCsv, activeRecordId, axisDomain, cursorA, cursorB, activeUnit, cursorContinuity]);

  // Expose deterministic test/benchmark hooks on window when running in browser
  useEffect(() => {
    (window as any).__orbitTraceTimelineTestApi = {
      getState: () => ({
        recordId: activeRecordId,
        unit: activeUnit,
        scopeKey: activeScopeKey,
        autoFollow: settings.traceAutoFollow,
        viewRange,
        cursorA,
        cursorB,
        selectedRecord: selectedRecord
          ? {
              recordId: selectedRecord.recordId,
              source: selectedRecord.source,
              state: selectedRecord.state,
              inspectionStatus: selectedRecord.inspectionStatus ?? null,
              indexStatus: selectedRecord.indexStatus ?? null,
              recoveryDisposition: selectedRecord.recoveryDisposition ?? null,
              recoverableRawBytes: selectedRecord.recoverableRawBytes ?? selectedRecord.counters.committedRawBytes,
              actualRawFileBytes: selectedRecord.actualRawFileBytes ?? null,
              rawSha256Verified: selectedRecord.rawSha256Verified ?? null,
              integrity: selectedRecord.integrity ?? null,
            }
          : null,
        lastActionMessage: traceState.lastActionMessage,
        svdatSupported: TRACE_ARCHIVE_CAPABILITIES.svdat.available,
        lanes: lanes.map(l => ({ id: l.id, kind: l.kind, label: l.label })),
        perf: { ...perfRef.current },
      }),
      panByFactor: (fraction: number) => {
        if (!viewRange || !axisDomain.valid) return;
        const s = BigInt(viewRange.start);
        const e = BigInt(viewRange.end);
        const delta = ((e - s) * BigInt(Math.round(fraction * 1000))) / 1000n;
        if (settings.traceAutoFollow) onUpdateSettings({ traceAutoFollow: false });
        const next = panBigIntRange(s, e, delta, { min: BigInt(axisDomain.minStr), max: BigInt(axisDomain.displayMaxStr) });
        setViewRange({ start: next.start.toString(), end: next.end.toString() });
      },
      zoomByFactor: (factor: number) => {
        if (!viewRange || !axisDomain.valid) return;
        const s = BigInt(viewRange.start);
        const e = BigInt(viewRange.end);
        const mid = (s + e) / 2n;
        const next = zoomBigIntRange(s, e, mid, factor, { min: BigInt(axisDomain.minStr), max: BigInt(axisDomain.displayMaxStr) });
        if (next.end < BigInt(axisDomain.displayMaxStr) && settings.traceAutoFollow) {
          onUpdateSettings({ traceAutoFollow: false });
        }
        setViewRange({ start: next.start.toString(), end: next.end.toString() });
      },
      setRange: (startStr: string, endStr: string) => {
        if (settings.traceAutoFollow) onUpdateSettings({ traceAutoFollow: false });
        setViewRange({ start: startStr, end: endStr });
      },
      setCursor: (kind: 'A' | 'B', timeStr: string) => {
        placeOrUpdateCursor(kind, BigInt(timeStr));
      },
      inspectAt: (timeStr: string) => {
        issueExactPointQuery('hover', BigInt(timeStr), 0n);
      },
      jumpToEventsAtCursorA: () => {
        const target = buildJumpToEventsTarget();
        if (!target) return false;
        onJumpToEventInEvents?.(target);
        return true;
      },
      exportCsvViewport: (outputPath?: string) => triggerExportViewportCsv(outputPath),
      exportCsvSelection: (outputPath?: string) => triggerExportSelectionCsv(outputPath),
      exportRaw: (outputPath?: string) => {
        if (!activeRecordId || !onExportRaw) return false;
        onExportRaw(activeRecordId, outputPath);
        return true;
      },
      saveRecording: (targetDir?: string) => {
        if (!activeRecordId) return false;
        onSaveRecording(activeRecordId, targetDir);
        return true;
      },
      openRecording: (recordingDir?: string) => {
        onOpenRecording(recordingDir);
        return true;
      },
      reportPerfNow: () => {
        onPerfReport?.({ ...perfRef.current });
        return { ...perfRef.current };
      },
    };
  }, [
    activeRecordId,
    activeUnit,
    activeScopeKey,
    settings.traceAutoFollow,
    viewRange,
    cursorA,
    cursorB,
    cursorAInspect,
    selectedRecord,
    traceState.lastActionMessage,
    lanes,
    axisDomain,
    onUpdateSettings,
    placeOrUpdateCursor,
    issueExactPointQuery,
    buildJumpToEventsTarget,
    onJumpToEventInEvents,
    triggerExportViewportCsv,
    triggerExportSelectionCsv,
    onExportRaw,
    onSaveRecording,
    onOpenRecording,
    onPerfReport,
  ]);

  // Pointer handlers
  const handlePointerDown = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    if (ev.button !== 0 || !viewRange || !axisDomain.valid) return;
    const rect = ev.currentTarget.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const vStart = BigInt(viewRange.start);
    const vEnd = BigInt(viewRange.end);

    const xA = cursorA ? bigIntToPixelX(BigInt(cursorA.timeStr), vStart, vEnd, rect.width) : null;
    const xB = cursorB ? bigIntToPixelX(BigInt(cursorB.timeStr), vStart, vEnd, rect.width) : null;
    let kind: 'pan' | 'cursorA' | 'cursorB' = 'pan';
    if (xA !== null && Math.abs(x - xA) <= 7) kind = 'cursorA';
    else if (xB !== null && Math.abs(x - xB) <= 7) kind = 'cursorB';

    ev.currentTarget.setPointerCapture(ev.pointerId);
    dragStateRef.current = {
      kind,
      pointerId: ev.pointerId,
      startX: x,
      moved: false,
      origStart: vStart,
      origEnd: vEnd,
    };
  };

  const handlePointerMove = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    if (!viewRange || !axisDomain.valid) return;
    const rect = ev.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, ev.clientX - rect.left));
    const y = Math.max(0, Math.min(rect.height, ev.clientY - rect.top));
    const vStart = BigInt(viewRange.start);
    const vEnd = BigInt(viewRange.end);
    const tAtX = pixelXToBigInt(x, vStart, vEnd, rect.width);

    const drag = dragStateRef.current;
    if (drag && drag.pointerId === ev.pointerId) {
      const dx = x - drag.startX;
      if (Math.abs(dx) >= 3) drag.moved = true;
      if (drag.kind === 'pan' && drag.moved) {
        if (settings.traceAutoFollow) onUpdateSettings({ traceAutoFollow: false });
        const span = drag.origEnd - drag.origStart;
        const delta = -(span * BigInt(Math.round((dx / Math.max(1, rect.width)) * 10000))) / 10000n;
        const next = panBigIntRange(
          drag.origStart,
          drag.origEnd,
          delta,
          { min: BigInt(axisDomain.minStr), max: BigInt(axisDomain.displayMaxStr) },
        );
        setViewRange({ start: next.start.toString(), end: next.end.toString() });
        return;
      }
      if ((drag.kind === 'cursorA' || drag.kind === 'cursorB') && drag.moved) {
        placeOrUpdateCursor(drag.kind === 'cursorA' ? 'A' : 'B', tAtX);
        return;
      }
    }

    setHoverInfo({ x, y, timeStr: tAtX.toString() });
    if (hoverDebounceRef.current !== null) window.clearTimeout(hoverDebounceRef.current);
    const pixelSpan = ((vEnd - vStart) * 3n) / BigInt(Math.max(1, Math.floor(rect.width)));
    hoverDebounceRef.current = window.setTimeout(() => {
      hoverDebounceRef.current = null;
      issueExactPointQuery('hover', tAtX, pixelSpan);
    }, 35);
  };

  const handlePointerUp = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragStateRef.current;
    if (!drag || drag.pointerId !== ev.pointerId) return;
    dragStateRef.current = null;
    if (ev.currentTarget.hasPointerCapture(ev.pointerId)) {
      ev.currentTarget.releasePointerCapture(ev.pointerId);
    }
    if (!drag.moved && viewRange && axisDomain.valid) {
      const rect = ev.currentTarget.getBoundingClientRect();
      const x = Math.max(0, Math.min(rect.width, ev.clientX - rect.left));
      const vStart = BigInt(viewRange.start);
      const vEnd = BigInt(viewRange.end);
      const tAtX = pixelXToBigInt(x, vStart, vEnd, rect.width);

      if (ev.shiftKey) {
        placeOrUpdateCursor('B', tAtX);
        return;
      }
      const aVisible = cursorA !== null && BigInt(cursorA.timeStr) >= vStart && BigInt(cursorA.timeStr) <= vEnd;
      const bVisible = cursorB !== null && BigInt(cursorB.timeStr) >= vStart && BigInt(cursorB.timeStr) <= vEnd;
      if (!aVisible || (aVisible && bVisible)) {
        setCursorB(null);
        placeOrUpdateCursor('A', tAtX);
      } else {
        placeOrUpdateCursor('B', tAtX);
      }
    }
  };

  const handleWheel = (ev: React.WheelEvent<HTMLCanvasElement>) => {
    if (!viewRange || !axisDomain.valid) return;
    ev.preventDefault();
    const rect = ev.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, ev.clientX - rect.left));
    const vStart = BigInt(viewRange.start);
    const vEnd = BigInt(viewRange.end);
    const anchor = pixelXToBigInt(x, vStart, vEnd, rect.width);
    const factor = ev.deltaY < 0 ? 0.72 : 1.38;
    const next = zoomBigIntRange(
      vStart,
      vEnd,
      anchor,
      factor,
      { min: BigInt(axisDomain.minStr), max: BigInt(axisDomain.displayMaxStr) },
    );
    if (next.end < BigInt(axisDomain.displayMaxStr) && settings.traceAutoFollow) {
      onUpdateSettings({ traceAutoFollow: false });
    }
    setViewRange({ start: next.start.toString(), end: next.end.toString() });
  };

  const zoomStep = (factor: number) => {
    if (!viewRange || !axisDomain.valid) return;
    const s = BigInt(viewRange.start);
    const e = BigInt(viewRange.end);
    const anchor = settings.traceAutoFollow ? e : (s + e) / 2n;
    const next = zoomBigIntRange(s, e, anchor, factor, { min: BigInt(axisDomain.minStr), max: BigInt(axisDomain.displayMaxStr) });
    if (next.end < BigInt(axisDomain.displayMaxStr) && settings.traceAutoFollow) {
      onUpdateSettings({ traceAutoFollow: false });
    }
    setViewRange({ start: next.start.toString(), end: next.end.toString() });
  };

  const panStep = (fraction: number) => {
    if (!viewRange || !axisDomain.valid) return;
    const s = BigInt(viewRange.start);
    const e = BigInt(viewRange.end);
    const delta = ((e - s) * BigInt(Math.round(fraction * 1000))) / 1000n;
    if (settings.traceAutoFollow) onUpdateSettings({ traceAutoFollow: false });
    const next = panBigIntRange(s, e, delta, { min: BigInt(axisDomain.minStr), max: BigInt(axisDomain.displayMaxStr) });
    setViewRange({ start: next.start.toString(), end: next.end.toString() });
  };

  const fitAll = () => {
    if (!axisDomain.valid) return;
    setViewRange({ start: axisDomain.minStr, end: axisDomain.displayMaxStr });
  };

  const jumpToLatest = () => {
    if (!axisDomain.valid) return;
    onUpdateSettings({ traceAutoFollow: true });
    const minB = BigInt(axisDomain.minStr);
    const maxB = BigInt(axisDomain.displayMaxStr);
    const curSpan = viewRange ? BigInt(viewRange.end) - BigInt(viewRange.start) : maxB - minB;
    const nextStart = maxB - curSpan > minB ? maxB - curSpan : minB;
    setViewRange({ start: nextStart.toString(), end: maxB.toString() });
  };

  const probe = traceState.targetProbe;
  const recStateBadge = selectedRecord ? stateLabel(selectedRecord.state) : null;
  const recIntegrityBadge = selectedRecord?.integrity ? integrityLabel(selectedRecord.integrity) : null;

  return (
    <div className="trace-shell" data-trace-record={activeRecordId ?? 'none'} data-trace-unit={activeUnit}>
      {/* 第一行：录制模式、目标控制、归档保存与离线重开 */}
      <div className="rtos-sub-bar trace-controls-bar">
        <div className="trace-btn-group">
          <select
            aria-label="Trace 录制模式"
            className="rtos-select"
            value={settings.traceMode}
            disabled={activeAnyLive}
            onChange={e => onUpdateSettings({ traceMode: e.target.value as TraceRecordingMode })}
          >
            <option value="continuous">Continuous (流式)</option>
            <option value="single-shot">Single-Shot (单次)</option>
            <option value="post-mortem">Post-Mortem (回卷)</option>
          </select>

          {!activeRecordingRecord ? (
            <button
              type="button"
              className="rtos-btn"
              disabled={!canStart}
              title={canStart ? '显式启动目标 SystemView 录制（不自动 halt/reset）' : '需要活动 Orbit 调试会话'}
              onClick={() => onStartRecording(settings.traceMode)}
            >
              开始录制
            </button>
          ) : (
            <>
              <button
                type="button"
                className="rtos-btn"
                disabled={activeRecordingRecord.state === 'stopping'}
                onClick={() => onStopRecording(activeRecordingRecord.recordId)}
              >
                {activeRecordingRecord.state === 'stopping' ? '停止中…' : '停止录制'}
              </button>
              {activeRecordingRecord.mode === 'continuous' && activeRecordingRecord.state === 'recording' && (
                <button
                  type="button"
                  className="rtos-btn rtos-btn-secondary"
                  title="仅暂停主机接收，目标端继续记录"
                  onClick={() => onPauseRecording(activeRecordingRecord.recordId)}
                >
                  暂停接收
                </button>
              )}
              {activeRecordingRecord.mode === 'continuous' && activeRecordingRecord.state === 'paused' && (
                <button
                  type="button"
                  className="rtos-btn rtos-btn-secondary"
                  onClick={() => onResumeRecording(activeRecordingRecord.recordId)}
                >
                  恢复接收
                </button>
              )}
              {(activeRecordingRecord.state === 'preparing' || activeRecordingRecord.state === 'stopping') && (
                <button
                  type="button"
                  className="rtos-btn rtos-btn-secondary"
                  onClick={() => onCancelRecording(activeRecordingRecord.recordId)}
                >
                  取消
                </button>
              )}
            </>
          )}

          <button
            type="button"
            className="rtos-btn rtos-btn-secondary"
            disabled={session.phase === 'none' || traceState.probing}
            title="只读探测目标 RTT SysView 通道与模式元数据"
            onClick={onInspectTarget}
          >
            {traceState.probing ? '探测中…' : '探测通道'}
          </button>
        </div>

        <div className="trace-btn-group">
          <button
            type="button"
            className="rtos-btn rtos-btn-secondary"
            disabled={!canSaveSelected}
            title={`保存 orbit-trace-v1 归档副本供离线查看（${TRACE_ARCHIVE_CAPABILITIES.svdat.reason}）`}
            onClick={() => selectedRecord && onSaveRecording(selectedRecord.recordId)}
          >
            保存录制
          </button>
          <button
            type="button"
            className="rtos-btn rtos-btn-secondary"
            title="无需连接目标，打开已保存的 orbit-trace-v1 录制目录"
            onClick={() => onOpenRecording()}
          >
            打开录制
          </button>
          <button
            type="button"
            className="rtos-btn rtos-btn-secondary"
            disabled={!canExportRawSelected}
            title="流式导出原始 SystemView 字节流 (.bin，非 SEGGER .SVDat)"
            onClick={() => selectedRecord && onExportRaw?.(selectedRecord.recordId)}
          >
            导出 .bin
          </button>
          <button
            type="button"
            className="rtos-btn rtos-btn-secondary"
            disabled={!canExportViewportCsv}
            title="从 Worker 流式导出当前 Trace 视口事件 CSV"
            onClick={() => { triggerExportViewportCsv(); }}
          >
            导出视口 CSV
          </button>
          <button
            type="button"
            className="rtos-btn rtos-btn-secondary"
            disabled={!canExportSelectionCsv}
            title="从 Worker 流式导出游标 A-B 选区事件 CSV"
            onClick={() => { triggerExportSelectionCsv(); }}
          >
            导出选区 CSV
          </button>
          <span
            className="rtos-cap off"
            title={TRACE_ARCHIVE_CAPABILITIES.svdat.reason}
          >
            − .SVDat 未支持
          </span>

          {traceState.records.length > 0 && (
            <select
              aria-label="当前查看的 Trace 记录"
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
          {selectedRecord && selectedRecord.source === 'offline' && (
            <button
              type="button"
              className="rtos-mini-btn"
              onClick={() => onCloseRecording(selectedRecord.recordId)}
            >
              关闭离线
            </button>
          )}
        </div>
      </div>

      {/* 第二行：时间段、单位、缩放、平移、Auto-Follow 与清除游标 */}
      <div className="rtos-filter-bar trace-nav-bar">
        {selectedRecord && selectedRecord.segments.length > 0 && (
          <select
            aria-label="时间段范围"
            className="rtos-select"
            value={activeScopeKey}
            onChange={e => setSelectedScopeKey(e.target.value)}
          >
            {selectedRecord.segments.length > 1 && (
              <option value="all-anchored">全部锚定段 ({selectedRecord.segments.length})</option>
            )}
            {selectedRecord.segments.map(s => (
              <option key={segmentScopeKey(s.bootGeneration, s.segmentId)} value={segmentScopeKey(s.bootGeneration, s.segmentId)}>
                Seg #{s.segmentId} (boot {s.bootGeneration}, {s.reliability}, {s.packetCount} 包)
              </option>
            ))}
          </select>
        )}

        <select
          aria-label="时间轴单位"
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

        <div className="trace-btn-group">
          <button type="button" className="rtos-mini-btn" disabled={!axisDomain.valid} onClick={() => panStep(-0.25)}>◀</button>
          <button type="button" className="rtos-mini-btn" disabled={!axisDomain.valid} onClick={() => panStep(0.25)}>▶</button>
          <button type="button" className="rtos-mini-btn" disabled={!axisDomain.valid} onClick={() => zoomStep(0.65)}>放大 +</button>
          <button type="button" className="rtos-mini-btn" disabled={!axisDomain.valid} onClick={() => zoomStep(1.5)}>缩小 −</button>
          <button type="button" className="rtos-mini-btn" disabled={!axisDomain.valid} onClick={fitAll}>全览</button>
          <button type="button" className="rtos-mini-btn" disabled={!axisDomain.valid} onClick={jumpToLatest}>跳到最新</button>
        </div>

        <label className="rtos-live-toggle" title="热录制期间视口保持跟随最新提交时间">
          <input
            type="checkbox"
            checked={settings.traceAutoFollow}
            onChange={e => onUpdateSettings({ traceAutoFollow: e.target.checked })}
          />
          <span>Auto-Follow</span>
        </label>

        <button
          type="button"
          className="rtos-mini-btn"
          disabled={!cursorA && !cursorB}
          onClick={() => { setCursorA(null); setCursorB(null); }}
        >
          清除 A/B
        </button>
        {props.onClockLink && <>
          <button type="button" className="rtos-mini-btn" disabled={!cursorA && !cursorB}
            onClick={() => props.onClockLink?.('traceClockLinkToTimeline')}>定位到变量 TIMELINE</button>
          <button type="button" className="rtos-mini-btn" disabled={!cursorA}
            title="在两个面板用 A 选中同一事件。若 B 也选中同一事件，可用第二对游标计算时间比例。"
            onClick={() => props.onClockLink?.('traceClockAlign')}>手动对齐</button>
        </>}
        {props.clockLinkNotice && <span role="status" className="rtos-inline-warn">{props.clockLinkNotice}</span>}

        {activeViewport && (
          <span className="rtos-count">
            {activeViewport.truncated ? 'LOD 概览+截断' : '完整区间'} · {activeViewport.slices.length} 切片 · {activeViewport.queryDurationMs} ms
          </span>
        )}
      </div>

      {/* 第三行：目标探测与录制状态 / 完整性 / 缺口 / 错误提示 */}
      <div className="trace-status-banner">
        {probe && (
          <span className={`rtos-pill ${probe.ok && probe.sysViewUpFound ? 'rtos-tone-ok' : 'rtos-tone-warn'}`}>
            {probe.ok
              ? `目标 ${probe.targetState ?? 'Unknown'} · Up=${probe.sysViewUpFound ? `ch${probe.upChannelIndex}(${probe.upBufferSize}B)` : '未发现'} · Down=${probe.sysViewDownFound ? `ch${probe.downChannelIndex}` : '无'}${probe.postMortemCompiled === true ? ' · Post-Mortem固件' : ''}`
              : `通道探测: ${probe.errorCode ?? 'Error'} - ${probe.message ?? ''}`}
          </span>
        )}
        {selectedRecord && recStateBadge && (
          <>
            <span className={`rtos-pill rtos-tone-${recStateBadge.tone}`}>
              {selectedRecord.source === 'offline' ? '离线' : selectedRecord.mode}: {recStateBadge.label}
            </span>
            {recIntegrityBadge && (
              <span className={`rtos-pill rtos-tone-${recIntegrityBadge.tone}`}>
                完整性: {recIntegrityBadge.label}
              </span>
            )}
            {selectedRecord.recoveryDisposition === 'rebuilt-bad-index' && (
              <span className="rtos-pill rtos-tone-warn" title="index.otidx 校验失败，已由 journal.otj 权威重建，原始流完整">
                坏索引已重建
              </span>
            )}
            {selectedRecord.recoveryDisposition === 'recovered-prefix-bad-chunk' && (
              <span className="rtos-pill rtos-tone-error" title="已提交分块存在校验损坏，仅加载损坏点之前的有效前缀">
                坏分块前缀恢复 ({selectedRecord.recoverableRawBytes ?? 0}/{selectedRecord.actualRawFileBytes ?? 0} B)
              </span>
            )}
            {selectedRecord.recoveryDisposition === 'recovered-interrupted' && (
              <span className="rtos-pill rtos-tone-warn" title="录制未完整关闭或尾部帧截断，已恢复全部已提交前缀">
                合法中断恢复 ({selectedRecord.recoverableRawBytes ?? 0} B)
              </span>
            )}
            <span className="trace-stat-text rtos-mono">
              已提交 {selectedRecord.counters.committedRawBytes} B · {selectedRecord.counters.packetsDecoded} 包 · {selectedRecord.counters.sliceCount} 切片 · {selectedRecord.counters.segmentCount} 段 · {selectedRecord.counters.gapCount} 缺口
              {selectedRecord.counters.targetDropCount ? ` · 目标丢包 ${selectedRecord.counters.targetDropCount}` : ''}
              {selectedRecord.counters.hostDroppedBytes ? ` · 主机丢弃 ${selectedRecord.counters.hostDroppedBytes} B` : ''}
            </span>
            {selectedRecord.freezeEvidence && (
              <span className="trace-stat-text rtos-mono">
                冻结({selectedRecord.freezeEvidence.source}): {selectedRecord.freezeEvidence.retainedBytes ?? 0} B, wrapped={String(Boolean(selectedRecord.freezeEvidence.wrapped))}, rdOff不变
              </span>
            )}
            {selectedRecord.error && (
              <span className="rtos-inline-warn" title={selectedRecord.error.message}>
                ⚠ {selectedRecord.error.errorCode}{selectedRecord.error.completion ? `(${selectedRecord.error.completion})` : ''}: {selectedRecord.error.message}
              </span>
            )}
          </>
        )}
        {traceState.lastActionMessage && (
          <span className={`trace-action-msg rtos-tone-${traceState.lastActionMessage.tone}`}>
            {traceState.lastActionMessage.text}
          </span>
        )}
        {axisDomain.skippedSegments.length > 0 && (
          <span className="rtos-inline-warn">
            ⚠ 已隔离 {axisDomain.skippedSegments.length} 个未锚定/跨复位段（请用段选择器单独查看）
          </span>
        )}
      </div>

      {/* 主泳道绘图区 */}
      <div className="trace-viewport-body">
        <div className="trace-lane-headers" style={{ width: LANE_HEADER_WIDTH }}>
          <div className="trace-ruler-corner" style={{ height: RULER_HEIGHT }}>
            泳道 / {activeUnit}
          </div>
          {lanes.map(lane => (
            <div key={lane.id} className="trace-lane-header" style={{ height: lane.heightPx, marginBottom: ROW_GAP }}>
              <span className="trace-lane-title" title={lane.label}>{lane.label}</span>
              {lane.subLabel && <span className="trace-lane-sub">{lane.subLabel}</span>}
            </div>
          ))}
        </div>

        <div className="trace-canvas-wrap" ref={canvasWrapRef}>
          <canvas
            ref={canvasRef}
            className="trace-canvas"
            style={{ width: canvasSize.width, height: Math.max(canvasSize.height, totalCanvasContentHeight) }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerLeave={() => {
              if (hoverDebounceRef.current !== null) {
                window.clearTimeout(hoverDebounceRef.current);
                hoverDebounceRef.current = null;
              }
              setHoverInfo(null);
            }}
            onWheel={handleWheel}
          />
          {activeViewport?.truncated && (
            <div className="trace-dense-hud">
              LOD 抽稀视图（放大可查看完整泳道；悬停与 A/B 游标始终走 Worker 精确查询）
            </div>
          )}
        </div>
      </div>

      {/* 底部精确游标与悬停检视区 */}
      <div className="trace-inspector-bar" aria-label="A/B 游标与精确悬停检视">
        <div className="trace-cursor-summary">
          <div className="trace-cursor-row rtos-mono">
            <span className="trace-tag trace-tag-a">A</span>
            <span>{cursorA ? `${formatTraceTimestamp(cursorA.timeStr, cursorA.unit)} (${cursorA.timeStr})` : '点击泳道放置游标 A'}</span>
            {cursorAInspect && (
              <span className="rtos-muted">
                {describeInspectCompact(cursorAInspect)}
              </span>
            )}
            {cursorA && activeRecordId && onJumpToEventInEvents && (
              <button
                type="button"
                className="rtos-mini-btn"
                title="在 Contexts & Events 事件列表中定位该时刻/事件"
                onClick={() => {
                  const target = buildJumpToEventsTarget();
                  if (target) onJumpToEventInEvents(target);
                }}
              >
                在 Events 中定位
              </button>
            )}
          </div>
          <div className="trace-cursor-row rtos-mono">
            <span className="trace-tag trace-tag-b">B</span>
            <span>{cursorB ? `${formatTraceTimestamp(cursorB.timeStr, cursorB.unit)} (${cursorB.timeStr})` : '再次点击或 Shift+点击放置游标 B'}</span>
            {cursorBInspect && (
              <span className="rtos-muted">
                {describeInspectCompact(cursorBInspect)}
              </span>
            )}
          </div>
          {cursorContinuity && (
            <div className="trace-cursor-row rtos-mono">
              <span className="trace-tag trace-tag-dt">Δt</span>
              {cursorContinuity.continuous ? (
                <span>
                  {cursorContinuity.deltaFormatted} (raw={cursorContinuity.deltaRaw})
                  {cursorContinuity.warnings.length > 0 ? ` · ⚠ ${cursorContinuity.warnings.join('; ')}` : ''}
                </span>
              ) : (
                <span className="rtos-inline-warn">
                  ⚠ {cursorContinuity.deltaFormatted} — {cursorContinuity.blockingReasons.join('；')}
                </span>
              )}
            </div>
          )}
        </div>

        <div className="trace-hover-detail rtos-mono">
          {hoverInspect ? (
            <>
              <div>
                <strong>精确悬停 @ {formatTraceTimestamp(hoverInspect.queryTime, hoverInspect.unit)}</strong>
                {hoverInspect.segmentId !== undefined && ` · Seg#${hoverInspect.segmentId} (${hoverInspect.segmentReliability ?? 'unknown'})`}
                {hoverInspect.queryDurationMs !== undefined && ` · ${hoverInspect.queryDurationMs} ms`}
              </div>
              <div>{describeInspectFull(hoverInspect)}</div>
            </>
          ) : hoverInfo ? (
            <div>时间 {formatTraceTimestamp(hoverInfo.timeStr, activeUnit)} (raw={hoverInfo.timeStr}) · 正在查询精确区间…</div>
          ) : (
            <div className="rtos-muted">移动鼠标查看精确原始事件、嵌套 ISR 包含/独占耗时、Ready 延迟与缺口诊断。</div>
          )}
        </div>
      </div>
    </div>
  );
}

function describeInspectCompact(inspect: TracePointInspectResponse): string {
  const parts: string[] = [];
  if (inspect.slices.length > 0) {
    const s = inspect.slices[0];
    parts.push(`${s.contextKind}:${s.label ?? s.contextKey}[${s.completeness}]`);
  }
  if (inspect.markers.length > 0) {
    const m = inspect.markers[0];
    parts.push(`Marker:${m.name ?? `#${m.markerId}`}`);
  }
  if (inspect.packets.length > 0) {
    parts.push(`pkt=${inspect.packets[0].eventName}`);
  }
  return parts.join(' | ') || '无匹配区间';
}

function describeInspectFull(inspect: TracePointInspectResponse): string {
  const lines: string[] = [];
  for (const s of inspect.slices.slice(0, 2)) {
    const lbl = s.label && s.labelSource !== 'missing' ? `${s.label} (${s.labelSource})` : `${s.contextKey} (${s.labelSource})`;
    lines.push(
      `切片[${s.contextKind}] ${lbl} [${s.startRelTicks}..${s.endRelTicks}${s.isEndObservedOnly ? ' 观测上界' : ''}] dur=${s.durationTicks ?? '未知'} ticks (${s.completeness})`,
    );
  }
  for (const a of inspect.activations.filter(x => x.kind === 'isr').slice(0, 2)) {
    lines.push(
      `ISR#${a.irqId ?? '?'} depth=${a.isrDepth ?? 1} incl=${a.inclusiveDurationTicks ?? '?'} excl=${a.exclusiveDurationTicks ?? '?'} preempt=${a.preemptedDurationTicks ?? '0'} ticks`,
    );
  }
  for (const rw of inspect.readyWaits.slice(0, 2)) {
    lines.push(
      `Ready[${rw.outcome}] ${rw.label ?? rw.taskInstanceId} wait=${rw.readyToRunningTicks ?? rw.durationTicks ?? '未知'} ticks`,
    );
  }
  for (const m of inspect.markers.slice(0, 2)) {
    lines.push(`Marker[${m.markerId}] ${m.name ?? '未命名'} dur=${m.durationTicks ?? '未知'} ticks (${m.completeness})`);
  }
  for (const mp of inspect.markerPoints.slice(0, 2)) {
    lines.push(`MarkerPt[${mp.markerId}] ${mp.name ?? ''} @ ${mp.relTicks}`);
  }
  if (inspect.packets.length > 0) {
    const p = inspect.packets[0];
    lines.push(`包#${p.packetIndexInSegment} ${p.eventName} (${p.summary}) @off=${p.streamByteOffset}`);
  }
  return lines.join(' · ') || '该时刻无已记录事件或切片';
}
