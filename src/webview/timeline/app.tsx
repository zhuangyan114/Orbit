import React, { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import {
  appendTimelineSamples,
  retainTimelineSamples,
  startsTimelineSegment,
  TimelineFrameBatcher,
  type TimelineDataPoint,
  type TimelineSampleSnapshot,
} from './timeline-sample-buffer';
import { buildTimelineTraceCommands, firstPointAtOrAfter } from './timeline-trace-path';
import {
  clampTimelineViewportEnd,
  quantizeTimelineResolution,
  TimelineRangeController,
  type TimelineHistoryBounds,
} from './timeline-range';
import {
  createTimelineEntry,
  mergeTimelineEntryRefresh,
  type TimelineEntryState as Entry,
  type TimelineEntryUpdate,
} from './timeline-entry-state';

import type { TimelineTab } from '../../timeline/timeline-model';
import { calculateBufferedRange } from './timeline-range';
import { clampTimelineTimePerDiv, MAX_TIMELINE_TIME_PER_DIV_MS, parseTimelineTimePerDiv, TIMELINE_TIME_PRESETS_MS } from './timeline-time-scale';
import { TIMELINE_SAMPLE_RATE_STALE_MS } from './timeline-sample-rate';
import { TimelineColorPicker } from './timeline-color-picker';

type DataPoint = TimelineDataPoint;
type SampleSnapshot = TimelineSampleSnapshot;

interface VSCODE_API { postMessage(message: any): void; }
declare function acquireVsCodeApi(): VSCODE_API;
let vscode: VSCODE_API;
try { vscode = typeof acquireVsCodeApi !== 'undefined' ? acquireVsCodeApi() : { postMessage: () => {} }; }
catch { vscode = { postMessage: () => {} }; }

const H_DIV = 8;
const V_DIV = 6;
const SUB_DIV = 5;
const VARIABLE_LIST_WIDTH = 181;
const PLOT_LEFT_MARGIN = 12;
const PLOT_TOP_MARGIN = 8;
const EXPORT_ROW_PADDING = 3;

function autoCalcPerDiv(pts: DataPoint[], firstTimestamp = Number.NEGATIVE_INFINITY): { yPerDiv: number; yCenter: number } {
  if (pts.length === 0) return { yPerDiv: 1, yCenter: 0 };
  let absMax = 0;
  for (let index = firstPointAtOrAfter(pts, firstTimestamp); index < pts.length; index++) {
    const p = pts[index];
    const a = Math.abs(p.value);
    if (a > absMax) absMax = a;
  }
  if (absMax < 1e-10) absMax = 1;
  const perDiv = (absMax * 2) / V_DIV;
  const magnitude = Math.pow(10, Math.floor(Math.log10(perDiv)));
  const rounded = Math.ceil(perDiv / magnitude) * magnitude;
  return { yPerDiv: Math.max(rounded, 1e-6), yCenter: 0 };
}

export function TimelineApp() {
  const [tabs, setTabs] = useState<TimelineTab[]>([]);
  const [active, setActive] = useState<any>(null);
  const [activation, setActivation] = useState(0);
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      if (msg.command === 'tabs') setTabs(msg.tabs || []);
      if (msg.command === 'activate') { setActive(msg); setActivation(n => n + 1); }
    };
    window.addEventListener('message', handler);
    vscode.postMessage({ command: 'init' });
    return () => window.removeEventListener('message', handler);
  }, []);
  const activeInfo = tabs.find(t => t.id === active?.tab?.id) ?? active?.tab;
  return <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
    <div role="tablist" aria-label="Timeline 记录" style={{ display: 'flex', flexShrink: 0, overflowX: 'auto', gap: 3, padding: '4px 8px', borderBottom: '1px solid var(--vscode-sideBar-border, #333)' }}>
      {tabs.map(tab => <div key={tab.id} style={{ display: 'flex', alignItems: 'center', background: tab.id === active?.tab?.id ? 'var(--vscode-tab-activeBackground, #444)' : 'transparent', borderRadius: 3 }}>
        <button role="tab" aria-selected={tab.id === active?.tab?.id} style={{ ...iconBtnStyle, border: 'none', whiteSpace: 'nowrap' }} onClick={() => vscode.postMessage({ command: 'selectTab', tabId: tab.id })} title={tab.error ?? tab.name}>
          {tab.kind === 'live' ? '● ' : ''}{tab.name}{tab.incomplete ? ' ⚠' : ''}
        </button>
        {tab.kind === 'history' && <button aria-label={'关闭 ' + tab.name} style={{ ...iconBtnStyle, border: 'none' }} onClick={() => vscode.postMessage({ command: 'closeTab', tabId: tab.id })}>×</button>}
      </div>)}
      <button style={iconBtnStyle} title="打开 CSV 为新标签" onClick={() => vscode.postMessage({ command: 'openCsv' })}>＋ 打开 CSV</button>
      <button style={iconBtnStyle} onClick={() => vscode.postMessage({ command: 'recoverRecord' })}>恢复记录</button>
    </div>
    {active && <TimelinePlot key={active.tab.id + ':' + activation} boot={active} kind={activeInfo.kind} />}
  </div>;
}

function TimelinePlot({ boot, kind }: { boot: any; kind: TimelineTab['kind'] }) {
  const sendMessage = (message: any) => vscode.postMessage({ ...message, tabId: boot.tab.id, recordId: boot.tab.recordId });
  const [cursorA, setCursorA] = useState<number | null>(boot.cursorA_ms ?? null);
  const [cursorB, setCursorB] = useState<number | null>(boot.cursorB_ms ?? null);
  const cursorRef = useRef({ A: cursorA, B: cursorB });
  cursorRef.current = { A: cursorA, B: cursorB };
  const cursorDragRef = useRef<'A' | 'B' | null>(null);
  const [rangeError, setRangeError] = useState(boot.tab.error ?? '');
  const [sampleRateHz, setSampleRateHz] = useState<number>(boot.sampleRateHz ?? 0);
  const [averageSampleRateHz, setAverageSampleRateHz] = useState<number | null>(boot.averageSampleRateHz ?? null);
  const sampleRateReceivedAt = useRef(performance.now());
  const debugEditable = kind === 'live' || kind === 'template';
  const [entries, setEntries] = useState<Entry[]>((boot.entries || []).map(createTimelineEntry));
  const allDataRef = useRef<Map<string, DataPoint[]>>(new Map());
  const [timePerDiv, setTimePerDiv] = useState<number>(clampTimelineTimePerDiv(boot.timePerDiv ?? 100));
  const timePerDivRef = useRef(timePerDiv);
  timePerDivRef.current = timePerDiv;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [renderTick, setRenderTick] = useState(0);
  const [newExpr, setNewExpr] = useState('');
  const [autoFollow, setAutoFollow] = useState(boot.autoFollow ?? true);
  const autoFollowRef = useRef(boot.autoFollow ?? true);
  const tEndRef = useRef(Date.now());
  const latestSampleTimestampRef = useRef(0);
  const isDraggingRef = useRef(false);
  const pointerDownRef = useRef(false);
  const capturedPointerRef = useRef<number | null>(null);
  const dragStartXRef = useRef(0);
  const dragStartTEndRef = useRef(0);
  const [mousePos, setMousePos] = useState<{ x: number; y: number } | null>(null);
  const [hoverVals, setHoverVals] = useState<{ label: string; value: string; color: string }[] | null>(null);
  const [hoverTooltipWidth, setHoverTooltipWidth] = useState(0);
  const lastHoverClientX = useRef(0);
  const lastHoverClientY = useRef(0);
  const hoverTooltipRef = useRef<HTMLDivElement>(null);
  const initedRef = useRef(false);
  const applySamplesRef = useRef<(snapshots: SampleSnapshot[]) => void>(() => {});
  const sampleBatcherRef = useRef<TimelineFrameBatcher | null>(null);
  const rangeControllerRef = useRef<TimelineRangeController | null>(null);
  const historyBoundsRef = useRef<TimelineHistoryBounds | null>(null);
  const rangeRequestTimerRef = useRef<number | null>(null);

  if (!rangeControllerRef.current) rangeControllerRef.current = new TimelineRangeController();

  const retainViewportSamples = () => {
    const end = tEndRef.current;
    const buffer = calculateBufferedRange(end - timePerDivRef.current * H_DIV, end, historyBoundsRef.current);
    retainTimelineSamples(allDataRef.current, buffer);
    if (buffer) rangeControllerRef.current!.retainCoverage(buffer);
    else rangeControllerRef.current!.clearCoverage();
  };

  applySamplesRef.current = (snapshots) => {
    const map = allDataRef.current;
    const latestTimestamp = appendTimelineSamples(map, snapshots);
    if (latestTimestamp !== undefined) {
      latestSampleTimestampRef.current = Math.max(latestSampleTimestampRef.current, latestTimestamp);
      if (autoFollowRef.current) tEndRef.current = historyBoundsRef.current?.end ?? latestSampleTimestampRef.current;
    }
    // Range acceptance, point merging and coverage eviction share one frame.
    retainViewportSamples();
    if (autoFollowRef.current) {
      setEntries(prev => {
        let changed = false;
        const next = prev.map(e => {
          if (!e.yAutoScale) return e;
          const pts = map.get(e.expression);
          if (!pts || pts.length < 2) return e;
          const visibleStart = latestSampleTimestampRef.current - timePerDivRef.current * H_DIV;
          const { yPerDiv, yCenter } = autoCalcPerDiv(pts, visibleStart);
          if (e.yPerDiv !== yPerDiv || e.yCenter !== yCenter) changed = true;
          return { ...e, yPerDiv, yCenter };
        });
        return changed ? next : prev;
      });
    }
    setRenderTick(t => t + 1);
    scheduleVisibleRangeRequest();
    if (lastHoverClientX.current > 0) {
      computeHoverRef.current(lastHoverClientX.current, lastHoverClientY.current);
    }
  };

  if (!sampleBatcherRef.current) {
    sampleBatcherRef.current = new TimelineFrameBatcher(
      callback => requestAnimationFrame(callback),
      handle => cancelAnimationFrame(handle),
      snapshots => applySamplesRef.current(snapshots),
    );
  }

  const requestVisibleRange = () => {
    if (!initedRef.current) return;
    const tEnd = tEndRef.current;
    const tStart = tEnd - timePerDivRef.current * H_DIV;
    const canvasWidth = canvasRef.current?.getBoundingClientRect().width ?? 0;
    const plotWidth = canvasWidth - 24;
    if (plotWidth <= 0) return;
    const resolutionKey = quantizeTimelineResolution(tEnd - tStart, plotWidth);
    if (resolutionKey === null) return;
    const controller = rangeControllerRef.current!;
    if (controller.setResolution(resolutionKey)) {
      for (const expression of allDataRef.current.keys()) allDataRef.current.set(expression, []);
      setRenderTick(tick => tick + 1);
    }
    // Pan/zoom can evict data even before a new range reply arrives.
    retainViewportSamples();
    for (const request of controller.requestViewport(tStart, tEnd)) {
      const targetBuckets = Math.min(
        100_000,
        Math.max(1, Math.ceil((request.end - request.start) / resolutionKey)),
      );
      sendMessage({
        command: 'loadRange',
        ...request,
        generation: controller.generation,
        resolutionKey,
        targetBuckets,
      });
    }
  };

  const scheduleVisibleRangeRequest = () => {
    if (rangeRequestTimerRef.current !== null) return;
    rangeRequestTimerRef.current = window.setTimeout(() => {
      rangeRequestTimerRef.current = null;
      requestVisibleRange();
    }, 40);
  };

  const updateHistoryBounds = (bounds: TimelineHistoryBounds | null) => {
    historyBoundsRef.current = bounds;
    rangeControllerRef.current!.setHistoryBounds(bounds);
    latestSampleTimestampRef.current = bounds?.end ?? 0;
  };

  const saveState = useCallback(() => {
    sendMessage({
      command: 'saveState',
      state: {
        autoFollow: autoFollowRef.current,
        timePerDiv,
        viewportEndMs: tEndRef.current,
        cursorA_ms: cursorRef.current.A,
        cursorB_ms: cursorRef.current.B,
        entries: entries.map(e => ({
          expression: e.expression,
          enabled: e.enabled,
          color: e.color,
          yPerDiv: e.yPerDiv,
          yAutoScale: e.yAutoScale,
          yCenter: e.yCenter,
        })),
      },
    });
  }, [entries, timePerDiv]);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      if (msg.tabId !== boot.tab.id || msg.recordId !== boot.tab.recordId) return;
      switch (msg.command) {
        case 'init': {
          const eList: Entry[] = (msg.entries || []).map((e: TimelineEntryUpdate) => createTimelineEntry(e));
          setEntries(eList);
          // Apply saved global state
          if (msg.autoFollow !== undefined) {
            setAutoFollow(msg.autoFollow);
            autoFollowRef.current = msg.autoFollow;
          }
          if (msg.timePerDiv !== undefined) {
            const restoredTimePerDiv = clampTimelineTimePerDiv(msg.timePerDiv);
            setTimePerDiv(restoredTimePerDiv);
            timePerDivRef.current = restoredTimePerDiv;
          }
          const m = new Map<string, DataPoint[]>();
          for (const e of eList) m.set(e.expression, []);
          allDataRef.current = m;
          rangeControllerRef.current!.clearCoverage();
          updateHistoryBounds(msg.historyBounds ?? null);
          if (msg.historyBounds) tEndRef.current = msg.viewportEndMs ?? msg.historyBounds.end;
          setRenderTick(t => t + 1);
          initedRef.current = true;
          requestVisibleRange();
          break;
        }
        case 'entries': {
          const updates: TimelineEntryUpdate[] = msg.entries || [];
          setEntries(prev => mergeTimelineEntryRefresh(prev, updates));
          rangeControllerRef.current!.clearCoverage();
          scheduleVisibleRangeRequest();
          setRenderTick(t => t + 1);
          break;
        }
        case 'sampleRate': {
          if (Number.isFinite(msg.averageSampleRateHz) && msg.averageSampleRateHz >= 0) setAverageSampleRateHz(msg.averageSampleRateHz);
          break;
        }
        case 'samples': {
          if (Number.isFinite(msg.sampleRateHz) && msg.sampleRateHz >= 0) {
            setSampleRateHz(msg.sampleRateHz);
            sampleRateReceivedAt.current = performance.now();
          }
          const snapshots: SampleSnapshot[] = msg.snapshots || [];
          if (msg.historyBounds !== undefined) updateHistoryBounds(msg.historyBounds);
          rangeControllerRef.current!.markLiveSamples(snapshots);
          if (autoFollowRef.current && historyBoundsRef.current) tEndRef.current = historyBoundsRef.current.end;
          scheduleVisibleRangeRequest();
          break;
        }
        case 'rangeSamples': {
          sampleBatcherRef.current?.enqueue(msg.snapshots || [], () => {
            if (!rangeControllerRef.current!.completeRequest(
              msg.requestId,
              msg.error ? null : msg.range ?? null,
              msg.generation,
              msg.resolutionKey,
            )) return false;
            setRangeError(msg.error ?? '');
            if (msg.historyBounds !== undefined) updateHistoryBounds(msg.historyBounds);
            return !msg.error;
          });
          break;
        }
        case 'historyBounds': {
          rangeControllerRef.current!.cancelPendingRequests();
          rangeControllerRef.current!.resetLiveContinuity();
          updateHistoryBounds(msg.bounds ?? null);
          if (msg.bounds && autoFollowRef.current) tEndRef.current = msg.bounds.end;
          setRenderTick(t => t + 1);
          requestVisibleRange();
          break;
        }
      }
    };
    window.addEventListener('message', handler);
    handler({ data: { ...boot, command: 'init', tabId: boot.tab.id, recordId: boot.tab.recordId } } as MessageEvent);
    return () => window.removeEventListener('message', handler);
  }, []);

  useEffect(() => {
    if (kind !== 'live') return;
    const timer = window.setInterval(() => {
      if (performance.now() - sampleRateReceivedAt.current >= TIMELINE_SAMPLE_RATE_STALE_MS) setSampleRateHz(0);
    }, 250);
    return () => window.clearInterval(timer);
  }, [kind]);

  useEffect(() => () => {
    sampleBatcherRef.current?.dispose();
    if (rangeRequestTimerRef.current !== null) window.clearTimeout(rangeRequestTimerRef.current);
  }, []);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const W = rect.width;
    const H = rect.height;
    if (W < 50 || H < 50) return;
    const pixelWidth = Math.round(W * dpr);
    const pixelHeight = Math.round(H * dpr);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const margin = { top: PLOT_TOP_MARGIN, right: 12, bottom: 28, left: PLOT_LEFT_MARGIN };
    const plotW = W - margin.left - margin.right;
    const plotH = H - margin.top - margin.bottom;
    if (plotW < 20 || plotH < 20) return;

    const divW = plotW / H_DIV;
    const divH = plotH / V_DIV;

    if (autoFollowRef.current && latestSampleTimestampRef.current > 0) {
      tEndRef.current = latestSampleTimestampRef.current;
    }
    const tEnd = tEndRef.current;
    const tStart = tEnd - timePerDiv * H_DIV;
    const map = allDataRef.current;

    ctx.clearRect(0, 0, W, H);

    const active = entries.filter(e => e.enabled);

    // -- grid background --
    ctx.fillStyle = 'rgba(0,0,0,0.15)';
    ctx.fillRect(margin.left, margin.top, plotW, plotH);

    const centerX = margin.left + divW * (H_DIV / 2);
    const centerY = margin.top + divH * (V_DIV / 2);

    const drawSubLines = (start: number, len: number, step: number, isHorizontal: boolean) => {
      for (let i = 1; i < step; i++) {
        const offset = len / step * i;
        ctx.strokeStyle = 'rgba(128,128,128,0.06)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        if (isHorizontal) {
          const y = start + offset;
          ctx.moveTo(margin.left, y); ctx.lineTo(margin.left + plotW, y);
        } else {
          const x = start + offset;
          ctx.moveTo(x, margin.top); ctx.lineTo(x, margin.top + plotH);
        }
        ctx.stroke();
      }
    };

    // sub-grid lines
    for (let i = 0; i < H_DIV; i++) drawSubLines(margin.left + divW * i, divW, SUB_DIV, false);
    for (let i = 0; i < V_DIV; i++) drawSubLines(margin.top + divH * i, divH, SUB_DIV, true);

    // division grid lines (more visible)
    ctx.strokeStyle = 'rgba(128,128,128,0.4)';
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= H_DIV; i++) {
      const x = margin.left + divW * i;
      if (x === centerX) continue;
      ctx.beginPath(); ctx.moveTo(x, margin.top); ctx.lineTo(x, margin.top + plotH); ctx.stroke();
    }
    for (let i = 0; i <= V_DIV; i++) {
      const y = margin.top + divH * i;
      if (y === centerY) continue;
      ctx.beginPath(); ctx.moveTo(margin.left, y); ctx.lineTo(margin.left + plotW, y); ctx.stroke();
    }

    // center axes (thicker, brighter)
    ctx.strokeStyle = 'rgba(200,200,200,0.6)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(margin.left, centerY); ctx.lineTo(margin.left + plotW, centerY); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(centerX, margin.top); ctx.lineTo(centerX, margin.top + plotH); ctx.stroke();

    // -- X-axis labels (centered on horizontal axis, shifted down) --
    ctx.fillStyle = '#999';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let i = 0; i <= H_DIV; i++) {
      const x = margin.left + divW * i;
      const ts = tStart + timePerDiv * i;
      const ms = tEnd - ts;
      let label: string;
      if (Math.abs(ms) < 0.5) label = '0';
      else if (ms >= 1000) label = `-${(ms / 1000).toFixed(1)}s`;
      else if (ms >= 100) label = `-${ms.toFixed(0)}ms`;
      else label = `-${ms.toFixed(1)}ms`;
      ctx.fillText(label, x, centerY + 3);
    }

    // -- traces --
    const clipRegion = (cx: CanvasRenderingContext2D) => {
      cx.save();
      cx.beginPath();
      cx.rect(margin.left, margin.top, plotW, plotH);
      cx.clip();
    };

    clipRegion(ctx);

    for (const entry of active) {
      const pts = map.get(entry.expression);
      if (!pts || pts.length === 0) continue;
      const commands = buildTimelineTraceCommands(pts, {
        tStart,
        tEnd,
        plotLeft: margin.left,
        plotWidth: plotW,
        projectY: point => {
          const yNorm = (point.value - entry.yCenter) / entry.yPerDiv;
          return margin.top + plotH / 2 - yNorm * divH;
        },
      });
      if (commands.length === 0) continue;

      ctx.strokeStyle = entry.color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (const command of commands) {
        if (command.command === 'moveTo') ctx.moveTo(command.x, command.y);
        else ctx.lineTo(command.x, command.y);
      }
      ctx.stroke();
    }

    ctx.restore();

    for (const [label, time] of Object.entries(cursorRef.current)) {
      if (time === null) continue;
      const x = margin.left + (time - tStart) / (tEnd - tStart) * plotW;
      if (x < margin.left || x > margin.left + plotW) continue;
      ctx.save(); ctx.strokeStyle = label === 'A' ? '#FFD166' : '#79C0FF'; ctx.fillStyle = ctx.strokeStyle;
      ctx.lineWidth = 1.5; ctx.setLineDash([6, 3]); ctx.beginPath(); ctx.moveTo(x, margin.top); ctx.lineTo(x, margin.top + plotH); ctx.stroke();
      ctx.font = 'bold 12px sans-serif'; ctx.fillText(label, x + 4, margin.top + 12); ctx.restore();
    }
    const { A, B } = cursorRef.current;
    if (A !== null && B !== null) {
      const left = margin.left + (Math.min(A, B) - tStart) / (tEnd - tStart) * plotW;
      const right = margin.left + (Math.max(A, B) - tStart) / (tEnd - tStart) * plotW;
      if (right >= margin.left && left <= margin.left + plotW) {
        const x1 = Math.max(margin.left, left), x2 = Math.min(margin.left + plotW, right);
        const distance = Math.abs(B - A);
        const label = 'Δt = ' + (distance >= 1000 ? (distance / 1000).toFixed(3) + ' s' : distance.toFixed(3) + ' ms');
        const y = margin.top + 34;
        ctx.save();
        ctx.strokeStyle = 'rgba(220,220,220,0.8)'; ctx.lineWidth = 1; ctx.setLineDash([]);
        ctx.beginPath(); ctx.moveTo(x1, y); ctx.lineTo(x2, y);
        ctx.moveTo(x1, y - 4); ctx.lineTo(x1, y + 4);
        ctx.moveTo(x2, y - 4); ctx.lineTo(x2, y + 4); ctx.stroke();
        ctx.font = '11px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        const halfWidth = ctx.measureText(label).width / 2 + 6;
        const center = Math.max(margin.left + halfWidth, Math.min(margin.left + plotW - halfWidth, (x1 + x2) / 2));
        ctx.fillStyle = 'rgba(30,30,30,0.9)'; ctx.fillRect(center - halfWidth, y - 9, halfWidth * 2, 18);
        ctx.fillStyle = '#ddd'; ctx.fillText(label, center, y); ctx.restore();
      }
    }
    // -- crosshair (mouse hover) --
    if (mousePos) {
      const cx = mousePos.x;
      if (cx >= margin.left && cx <= margin.left + plotW) {
        ctx.save();
        ctx.strokeStyle = 'rgba(255,255,255,0.6)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(cx, margin.top);
        ctx.lineTo(cx, margin.top + plotH);
        ctx.stroke();
        ctx.restore();
      }
    }

  }, [entries, timePerDiv, renderTick, mousePos, cursorA, cursorB]);

  useEffect(() => { draw(); }, [draw]);

  useEffect(() => {
    if (!initedRef.current) return;
    scheduleVisibleRangeRequest();
    if (lastHoverClientX.current > 0) {
      computeHoverRef.current(lastHoverClientX.current, lastHoverClientY.current);
    }
  }, [timePerDiv]);

  const saveLatestRef = useRef(saveState);
  saveLatestRef.current = saveState;
  const stateSaveTimer = useRef<number | null>(null);
  useEffect(() => {
    if (!initedRef.current || stateSaveTimer.current !== null) return;
    stateSaveTimer.current = window.setTimeout(() => { stateSaveTimer.current = null; saveLatestRef.current(); }, 400);
  }, [entries, timePerDiv, autoFollow, cursorA, cursorB]);
  useEffect(() => () => { if (stateSaveTimer.current !== null) window.clearTimeout(stateSaveTimer.current); if (initedRef.current) saveLatestRef.current(); }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => {
      setRenderTick(t => t + 1);
      scheduleVisibleRangeRequest();
    });
    ro.observe(canvas.parentElement!);
    return () => ro.disconnect();
  }, []);

  const addExpr = () => {
    const expr = newExpr.trim();
    if (!expr) return;
    sendMessage({ command: 'addExpression', expression: expr });
    setNewExpr('');
  };

  const toggle = (expr: string, enabled: boolean) => {
    setEntries(prev => prev.map(e => e.expression === expr ? { ...e, enabled } : e));
    sendMessage({ command: 'toggleExpression', expression: expr, enabled });
  };

  const remove = (expr: string) => {
    if (!debugEditable) return;
    setEntries(prev => prev.filter(e => e.expression !== expr));
    allDataRef.current.delete(expr);
    setRenderTick(t => t + 1);
    sendMessage({ command: 'removeExpression', expression: expr });
  };

  const setYPerDiv = (expr: string, value: number) => {
    setEntries(prev => prev.map(e =>
      e.expression === expr ? { ...e, yPerDiv: Math.max(value, 1e-6), yAutoScale: false } : e
    ));
  };

  const setColor = (expr: string, color: string) => {
    setEntries(prev => prev.map(e =>
      e.expression === expr ? { ...e, color } : e
    ));
    sendMessage({ command: 'setColor', expression: expr, color });
  };

  const setYAutoScale = (expr: string) => {
    setEntries(prev => prev.map(e => {
      if (e.expression !== expr) return e;
      const pts = allDataRef.current.get(expr);
      if (!pts || pts.length < 2) return { ...e, yAutoScale: true };
      const { yPerDiv, yCenter } = autoCalcPerDiv(pts);
      return { ...e, yPerDiv, yCenter, yAutoScale: true };
    }));
  };

  const clearAll = () => {
    const map = allDataRef.current;
    for (const key of map.keys()) map.set(key, []);
    updateHistoryBounds(null);
    setRenderTick(t => t + 1);
    sendMessage({ command: 'clearData' });
  };

  const applyTimeZoom = (nextTimePerDiv: number, anchorFraction = 0.5) => {
    if (!Number.isFinite(nextTimePerDiv) || nextTimePerDiv <= 0) return;
    nextTimePerDiv = clampTimelineTimePerDiv(nextTimePerDiv);
    const previousTimePerDiv = timePerDivRef.current;
    if (nextTimePerDiv === previousTimePerDiv) return;
    // Preserve the time under the anchor, including at recording boundaries.
    // Clamping here would shift that time when zooming out near an edge.
    tEndRef.current += (nextTimePerDiv - previousTimePerDiv) * H_DIV * (1 - anchorFraction);
    timePerDivRef.current = nextTimePerDiv;
    autoFollowRef.current = false;
    setAutoFollow(false);
    rangeControllerRef.current!.cancelPendingRequests();
    setTimePerDiv(nextTimePerDiv);
    setRenderTick(t => t + 1);
    scheduleVisibleRangeRequest();
  };
  const zoomBy = (direction: -1 | 1, anchorFraction = 0.5) => {
    const current = timePerDivRef.current;
    const nextPreset = direction > 0
      ? TIMELINE_TIME_PRESETS_MS.find(preset => preset > current)
      : [...TIMELINE_TIME_PRESETS_MS].reverse().find(preset => preset < current);
    applyTimeZoom(nextPreset ?? (direction > 0 ? current * 2 : current / 2), anchorFraction);
  };
  const zoomIn = () => zoomBy(-1);
  const zoomOut = () => zoomBy(1);
  const zoomByRef = useRef(zoomBy);
  zoomByRef.current = zoomBy;

  // hover — compute cursor time + values per variable
  const computeHover = useCallback((clientX: number, clientY?: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const margin = { top: PLOT_TOP_MARGIN, right: 12, bottom: 28, left: PLOT_LEFT_MARGIN };
    const plotW = rect.width - margin.left - margin.right;
    const plotH = rect.height - margin.top - margin.bottom;
    if (plotW <= 0) return;
    const relX = clientX - rect.left - margin.left;
    if (relX < 0 || relX > plotW || (clientY !== undefined && (clientY < rect.top + margin.top || clientY > rect.bottom - margin.bottom))) { setMousePos(null); setHoverVals(null); return; }

    const tEnd = tEndRef.current;
    const tStart = tEnd - timePerDiv * H_DIV;
    const cursorTime = tStart + (relX / plotW) * timePerDiv * H_DIV;

    const relY = clientY !== undefined ? clientY - rect.top - margin.top : undefined;

    setMousePos({ x: clientX - rect.left, y: clientY !== undefined ? clientY - rect.top : 0 });
    lastHoverClientX.current = clientX;
    lastHoverClientY.current = clientY ?? lastHoverClientY.current;

    const vals: { label: string; value: string; color: string }[] = [];
    const map = allDataRef.current;
    const active = entries.filter(e => e.enabled);
    for (const entry of active) {
      const pts = map.get(entry.expression);
      if (!pts || pts.length === 0) continue;
      const index = firstPointAtOrAfter(pts, cursorTime);
      const left = pts[index - 1], right = pts[index];
      let display = '';
      if (left && right && !startsTimelineSegment(right, left)) {
        const nearest = cursorTime - left.timestamp <= right.timestamp - cursorTime ? left : right;
        display = formatNum(nearest.value);
      } else if (right?.timestamp === cursorTime) display = formatNum(right.value);
      vals.push({ label: entry.expression, value: display, color: entry.color });
    }
    setHoverVals(vals.length > 0 ? vals : null);
  }, [entries, timePerDiv]);
  const computeHoverRef = useRef(computeHover);
  computeHoverRef.current = computeHover;

  const cursorAt = (clientX: number, clientY: number): 'A' | 'B' | null => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect || clientY < rect.top + 8 || clientY > rect.bottom - 28 || rect.width <= 24) return null;
    const start = tEndRef.current - timePerDivRef.current * H_DIV;
    const hits = Object.entries(cursorRef.current)
      .filter(([, time]) => time !== null)
      .map(([label, time]) => ({ label, distance: Math.abs(clientX - rect.left - 12 - (time! - start) / (timePerDivRef.current * H_DIV) * (rect.width - 24)) }))
      .filter(hit => hit.distance <= 8)
      .sort((a, b) => a.distance - b.distance);
    return (hits[0]?.label as 'A' | 'B' | undefined) ?? null;
  };

  // A click places a cursor; movement past the threshold pans the viewport.
  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0 || capturedPointerRef.current !== null) return;
    e.preventDefault();
    capturedPointerRef.current = e.pointerId;
    e.currentTarget.setPointerCapture(e.pointerId);
    cursorDragRef.current = cursorAt(e.clientX, e.clientY);
    isDraggingRef.current = false;
    pointerDownRef.current = cursorDragRef.current === null;
    dragStartXRef.current = e.clientX;
    dragStartTEndRef.current = tEndRef.current;
    if (cursorDragRef.current) {
      setAutoFollow(false);
      autoFollowRef.current = false;
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (capturedPointerRef.current !== null && e.pointerId !== capturedPointerRef.current) return;
    if (cursorDragRef.current) {
      const rect = canvasRef.current!.getBoundingClientRect();
      const fraction = Math.min(1, Math.max(0, (e.clientX - rect.left - 12) / (rect.width - 24)));
      const time = tEndRef.current - timePerDivRef.current * H_DIV * (1 - fraction);
      if (cursorDragRef.current === 'A') setCursorA(time); else setCursorB(time);
      computeHover(e.clientX, e.clientY);
      return;
    }
    if (pointerDownRef.current && !isDraggingRef.current && Math.abs(e.clientX - dragStartXRef.current) > 4) {
      // Follow may advance while the button is held still. Anchor at the
      // viewport that is actually visible when panning begins.
      dragStartTEndRef.current = tEndRef.current;
      isDraggingRef.current = true;
      setAutoFollow(false);
      autoFollowRef.current = false;
    }
    if (isDraggingRef.current) {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const plotW = canvas.getBoundingClientRect().width - 24;
      if (plotW <= 0) return;
      const viewportWidth = timePerDivRef.current * H_DIV;
      const deltaTime = (e.clientX - dragStartXRef.current) / plotW * viewportWidth;
      const bounds = historyBoundsRef.current;
      // Keep empty space introduced by zoom instead of snapping on the first drag.
      const panBounds = bounds ? {
        start: Math.min(bounds.start, dragStartTEndRef.current),
        end: Math.max(bounds.end, dragStartTEndRef.current),
      } : null;
      tEndRef.current = clampTimelineViewportEnd(
        dragStartTEndRef.current - deltaTime, viewportWidth, panBounds, true,
      );
      setRenderTick(t => t + 1);
      scheduleVisibleRangeRequest();
    }
    computeHover(e.clientX, e.clientY);
  };

  const finishPointerGesture = (e?: React.PointerEvent<HTMLCanvasElement>) => {
    const pointerId = capturedPointerRef.current;
    if (pointerId === null || (e && e.pointerId !== pointerId)) return;
    if (e?.button === 0 && pointerDownRef.current && !isDraggingRef.current && !cursorDragRef.current) {
      const rect = canvasRef.current!.getBoundingClientRect();
      const fraction = (e.clientX - rect.left - 12) / (rect.width - 24);
      if (fraction >= 0 && fraction <= 1 && e.clientY >= rect.top + 8 && e.clientY <= rect.bottom - 28) {
        const time = tEndRef.current - timePerDivRef.current * H_DIV * (1 - fraction);
        if (cursorRef.current.A === null) setCursorA(time);
        else if (cursorRef.current.B === null) setCursorB(time);
      }
    }
    capturedPointerRef.current = null;
    cursorDragRef.current = null;
    pointerDownRef.current = false;
    isDraggingRef.current = false;
    const canvas = canvasRef.current;
    if (canvas?.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId);
    saveState();
    if (rangeRequestTimerRef.current !== null) {
      window.clearTimeout(rangeRequestTimerRef.current);
      rangeRequestTimerRef.current = null;
    }
    requestVisibleRange();
  };
  const finishGestureRef = useRef(finishPointerGesture);
  finishGestureRef.current = finishPointerGesture;
  useEffect(() => {
    const cancel = () => finishGestureRef.current();
    window.addEventListener('blur', cancel);
    return () => window.removeEventListener('blur', cancel);
  }, []);
  const handleContextMenu = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const cursor = cursorAt(e.clientX, e.clientY);
    if (!cursor) {
      onToggleFollow(true);
      computeHover(e.clientX, e.clientY);
      return;
    }
    if (cursor === 'A') setCursorA(null); else setCursorB(null);
    cursorDragRef.current = null;
    pointerDownRef.current = false;
    isDraggingRef.current = false;
  };
  const handlePointerLeave = () => {
    setMousePos(null);
    setHoverVals(null);
  };

  // handle auto-follow toggle
  const onToggleFollow = (follow: boolean) => {
    if (rangeRequestTimerRef.current !== null) {
      window.clearTimeout(rangeRequestTimerRef.current);
      rangeRequestTimerRef.current = null;
    }
    rangeControllerRef.current!.cancelPendingRequests();
    setAutoFollow(follow);
    autoFollowRef.current = follow;
    if (follow && latestSampleTimestampRef.current > 0) {
      tEndRef.current = latestSampleTimestampRef.current;
    }
    setRenderTick(t => t + 1);
    requestVisibleRange();
  };

  // Zoom around the pointer; keep the installed listener current through a ref.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.deltaY === 0) return;
      const rect = canvas.getBoundingClientRect();
      const plotWidth = rect.width - 24;
      if (plotWidth <= 0) return;
      const anchorFraction = Math.min(1, Math.max(0, (e.clientX - rect.left - 12) / plotWidth));
      zoomByRef.current(e.deltaY > 0 ? 1 : -1, anchorFraction);
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, []);

  const onSetTimePerDiv = (val: number) => {
    applyTimeZoom(val);
  };

  useLayoutEffect(() => {
    const width = hoverTooltipRef.current?.getBoundingClientRect().width ?? 0;
    setHoverTooltipWidth(previousWidth => previousWidth === width ? previousWidth : width);
  }, [hoverVals]);

  const canvasWidth = canvasRef.current?.getBoundingClientRect().width ?? 0;
  const showHoverTooltipOnLeft = mousePos !== null
    && mousePos.x + 14 + hoverTooltipWidth > canvasWidth;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <Toolbar
        debugEditable={debugEditable}
        newExpr={newExpr} onNewExpr={setNewExpr} onAdd={addExpr}
        onClear={clearAll} onZoomIn={zoomIn} onZoomOut={zoomOut}
        timePerDiv={timePerDiv} autoFollow={autoFollow} onToggleFollow={onToggleFollow}
        onSetTimePerDiv={onSetTimePerDiv}
      />
      <div style={{ display: 'grid', gridTemplateColumns: `${VARIABLE_LIST_WIDTH}px minmax(0, 1fr)`, alignItems: 'center', padding: `${EXPORT_ROW_PADDING}px 0`, fontSize: 11 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, paddingLeft: 8, whiteSpace: 'nowrap' }}>
          <button style={iconBtnStyle} onClick={() => { saveState(); sendMessage({ command: 'saveCsv', scope: 'all' }); }}>保存全部 CSV</button>
          <button style={iconBtnStyle} disabled={cursorA === null || cursorB === null} onClick={() => { saveState(); sendMessage({ command: 'saveCsv', scope: 'selection' }); }}>保存 A/B 区间</button>
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', alignSelf: 'end', gap: 8, paddingLeft: PLOT_LEFT_MARGIN, minWidth: 0 }}>
          <span title={kind === 'history' ? '平均采样率' : '实时采样率'} aria-label={kind === 'history' ? '平均采样率' : '实时采样率'} style={{ display: 'inline-flex', flexShrink: 0, gap: 0, position: 'relative', top: PLOT_TOP_MARGIN + EXPORT_ROW_PADDING - 3, zIndex: 1, color: 'var(--vscode-descriptionForeground, #aaa)', fontFamily: 'monospace', fontSize: 12, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
            <span style={{ display: 'inline-block', minWidth: '4ch' }}>{kind === 'live' ? sampleRateHz.toFixed(0) : kind === 'history' ? averageSampleRateHz?.toFixed(0) ?? '—' : '—'}</span>
            <span>Hz</span>
          </span>
          {rangeError && <span role="alert" style={{ color: 'var(--vscode-errorForeground)' }}>{rangeError}</span>}
        </div>
      </div>
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <VariableList
          entries={entries} allDataRef={allDataRef} onToggle={toggle} onRemove={remove}
          onSetYPerDiv={setYPerDiv} onSetYAutoScale={setYAutoScale}
          onSetColor={setColor} removable={debugEditable}
        />
        <div style={{ flex: 1, position: 'relative', minWidth: 0 }}>
          <canvas ref={canvasRef}
            style={{ width: '100%', height: '100%', display: 'block', touchAction: 'none' }}
            onPointerDown={handlePointerDown} onPointerMove={handlePointerMove}
            onPointerUp={finishPointerGesture} onPointerLeave={handlePointerLeave}
            onPointerCancel={() => finishPointerGesture()} onLostPointerCapture={() => finishPointerGesture()}
            onContextMenu={handleContextMenu}
          />
          {mousePos && hoverVals && hoverVals.length > 0 && (
            <div ref={hoverTooltipRef} style={{
              position: 'absolute',
              left: showHoverTooltipOnLeft ? undefined : mousePos.x + 14,
              right: showHoverTooltipOnLeft ? canvasWidth - mousePos.x + 14 : undefined,
              top: mousePos.y - 8,
              background: 'rgba(30,30,30,0.92)', border: '1px solid var(--vscode-sideBar-border, #555)',
              borderRadius: 4, padding: '4px 8px', fontSize: 11,
              pointerEvents: 'none', whiteSpace: 'nowrap', zIndex: 10,
              boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
            }}>
              {hoverVals.map(v => (
                <div key={v.label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ color: v.color, fontWeight: 'bold' }}>{v.label}</span>
                  <span style={{ color: '#fff', fontFamily: 'monospace' }}>{v.value}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Toolbar({ debugEditable, newExpr, onNewExpr, onAdd, onClear, onZoomIn, onZoomOut, timePerDiv, autoFollow, onToggleFollow, onSetTimePerDiv }: {
  debugEditable: boolean;
  newExpr: string; onNewExpr: (v: string) => void; onAdd: () => void;
  onClear: () => void; onZoomIn: () => void; onZoomOut: () => void;
  timePerDiv: number; autoFollow: boolean; onToggleFollow: (v: boolean) => void;
  onSetTimePerDiv: (v: number) => void;
}) {
  const [pending, setPending] = useState('');

  const displayTime = timePerDiv >= 1000
    ? `${(timePerDiv / 1000).toFixed(1)}s`
    : `${timePerDiv}ms`;

  const commitTime = (raw: string) => {
    setPending('');
    const value = parseTimelineTimePerDiv(raw);
    if (value !== undefined) onSetTimePerDiv(value);
  };

  return (
    <div style={{
      display: 'flex', gap: 4, padding: '4px 8px',
      borderBottom: '1px solid var(--vscode-sideBar-border, #333)',
      alignItems: 'center', flexShrink: 0,
    }}>
      <input value={newExpr} onChange={e => onNewExpr(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') onAdd(); if (e.key === ' ') e.preventDefault(); }}
        placeholder="变量名" style={inputStyle} />
      <button onClick={onAdd} style={btnStyle}>+</button>
      <div style={{ flex: 1 }} />
      <button onClick={onZoomOut} disabled={timePerDiv >= MAX_TIMELINE_TIME_PER_DIV_MS} style={iconBtnStyle} title="放大时间">−</button>
      <input type="text" inputMode="decimal"
        value={pending || displayTime}
        onChange={e => setPending(e.target.value)}
        onBlur={e => commitTime(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') commitTime((e.target as HTMLInputElement).value);
          if (e.key === ' ') e.preventDefault();
        }}
        style={{
          ...miniInputStyle, width: 55, textAlign: 'center', fontSize: 10,
          color: '#fff',
        }}
        title="输入时间/div（ms 或 s，最大 100s）"
      />
      <span style={{ fontSize: 9, color: 'var(--vscode-descriptionForeground, #888)' }}>/div</span>
      <button onClick={onZoomIn} style={iconBtnStyle} title="缩小时间">+</button>
      <label style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 10, cursor: 'pointer', color: 'var(--vscode-sideBar-foreground, #ccc)' }}>
        <input type="checkbox" checked={autoFollow}
          onChange={e => onToggleFollow(e.target.checked)}
          style={{ cursor: 'pointer', margin: 0 }} />
        追踪
      </label>
      {debugEditable && <button onClick={onClear} style={iconBtnStyle} title="结束当前记录并开始新记录">新记录</button>}
    </div>
  );
}

function VariableList({ removable, entries, allDataRef, onToggle, onRemove, onSetYPerDiv, onSetYAutoScale, onSetColor }: {
  removable: boolean;
  entries: Entry[];
  allDataRef: React.MutableRefObject<Map<string, DataPoint[]>>;
  onToggle: (expr: string, en: boolean) => void;
  onRemove: (expr: string) => void;
  onSetYPerDiv: (expr: string, val: number) => void;
  onSetYAutoScale: (expr: string) => void;
  onSetColor: (expr: string, color: string) => void;
}) {
  const [pendingInputs, setPendingInputs] = useState<Record<string, string>>({});
  const [colorExpression, setColorExpression] = useState<string | null>(null);
  const colorPickerRef = useRef<HTMLDivElement>(null);
  const colorButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (colorExpression === null) return;
    const dismissOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      // Let another color button switch pickers, and avoid moving rows before an outside click completes.
      if (target instanceof Element && target.closest('[data-timeline-color-trigger]')) return;
      if (!colorPickerRef.current?.contains(target) && !colorButtonRef.current?.contains(target)) setColorExpression(null);
    };
    const dismissEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setColorExpression(null); };
    document.addEventListener('click', dismissOutside);
    document.addEventListener('keydown', dismissEscape);
    return () => {
      document.removeEventListener('click', dismissOutside);
      document.removeEventListener('keydown', dismissEscape);
    };
  }, [colorExpression]);

  const getDisplay = (e: Entry): string => {
    if (e.expression in pendingInputs) return pendingInputs[e.expression];
    if (e.yAutoScale) return '';
    return String(e.yPerDiv);
  };

  const commitInput = (expr: string, raw: string) => {
    setPendingInputs(prev => { const n = { ...prev }; delete n[expr]; return n; });
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed === '0') {
      onSetYAutoScale(expr);
      return;
    }
    const v = parseFloat(trimmed);
    if (!isNaN(v) && v > 0) onSetYPerDiv(expr, v);
  };

  if (entries.length === 0) {
    return (
      <div style={{
        width: VARIABLE_LIST_WIDTH, boxSizing: 'border-box', flexShrink: 0, fontSize: 11, padding: 8,
        borderRight: '1px solid var(--vscode-sideBar-border, #333)',
        color: 'var(--vscode-descriptionForeground, #888)', textAlign: 'center', paddingTop: 20,
      }}>
        暂无变量<br/>从 Watch 添加或输入变量名
      </div>
    );
  }
  return (
    <div style={{
      width: VARIABLE_LIST_WIDTH, boxSizing: 'border-box', flexShrink: 0, fontSize: 11, overflow: 'auto',
      borderRight: '1px solid var(--vscode-sideBar-border, #333)',
    }}>
      {entries.map(e => (
        <div key={e.expression} style={{
          display: 'flex', alignItems: 'center', gap: 3, padding: '3px 4px',
          borderBottom: '1px solid var(--vscode-sideBar-border, #333)',
          flexWrap: 'wrap',
        }}>
          <input type="checkbox" checked={e.enabled}
            onChange={ev => onToggle(e.expression, ev.target.checked)}
            style={{ cursor: 'pointer', flexShrink: 0 }} />
          <button type="button" aria-label={`设置 ${e.expression} 颜色`}
            data-timeline-color-trigger=""
            ref={colorExpression === e.expression ? colorButtonRef : undefined}
            title="选择曲线颜色" aria-expanded={colorExpression === e.expression}
            style={{
            width: 16, height: 16, borderRadius: 3, cursor: 'pointer',
            flexShrink: 0, background: e.color, padding: 0,
            border: '1px solid var(--vscode-sideBar-border, #555)',
          }} onClick={() => setColorExpression(current => current === e.expression ? null : e.expression)} />
          <span style={{
            flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            color: e.enabled ? 'var(--vscode-sideBar-foreground, #ccc)' : 'var(--vscode-descriptionForeground, #888)',
            fontSize: 10,
          }} title={e.expression}>{e.expression}</span>
          {(() => {
            const pts = allDataRef.current.get(e.expression);
            const raw = pts && pts.length > 0 ? pts[pts.length - 1].display : '';
            if (!raw) return null;
            // Handle "0xFF (255)" format — extract decimal from parentheses
            const hexMatch = raw.match(/^0x[0-9a-fA-F]+\s*\((\d+)\)$/i);
            const num = hexMatch ? Number(hexMatch[1]) : Number(raw);
            const latest = isNaN(num) ? raw : formatNum(num);
            return (
              <span style={{
                fontSize: 11, color: e.color, fontFamily: 'monospace',
                flexShrink: 0, maxWidth: 60, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }} title={raw}>{latest}</span>
            );
          })()}
          {removable && <button onClick={() => onRemove(e.expression)}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'var(--vscode-errorForeground, #f48771)',
              fontSize: 11, padding: '0 2px', flexShrink: 0,
            }}>×</button>}
          <div style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 2, marginTop: 1 }}>
            <input type="text" inputMode="decimal"
              value={getDisplay(e)}
              placeholder={e.yAutoScale ? `${formatNum(e.yPerDiv)}` : ''}
              onChange={ev => setPendingInputs(prev => ({ ...prev, [e.expression]: ev.target.value }))}
              onBlur={ev => commitInput(e.expression, ev.target.value)}
              onKeyDown={ev => {
                if (ev.key === 'Enter') commitInput(e.expression, (ev.target as HTMLInputElement).value);
                if (ev.key === ' ') ev.preventDefault();
              }}
              onDoubleClick={() => onSetYAutoScale(e.expression)}
              style={{
                ...miniInputStyle,
                width: 50,
                color: e.yAutoScale ? 'var(--vscode-descriptionForeground, #888)' : 'var(--vscode-input-foreground, #ccc)',
                fontStyle: e.yAutoScale ? 'italic' : 'normal',
              }}
              title={e.yAutoScale ? '双击切换自动' : '输入 /div 后回车或失焦确认'}
            />
            <span style={{ fontSize: 9, color: 'var(--vscode-descriptionForeground, #888)' }}>/div</span>
          </div>
          {colorExpression === e.expression && <div ref={colorPickerRef} role="group" aria-label={`${e.expression} 颜色选择`}
            style={{ width: '100%', padding: 6, boxSizing: 'border-box', borderRadius: 3,
              background: 'var(--vscode-editorWidget-background, var(--vscode-sideBar-background, #1e1e1e))',
              color: 'var(--vscode-editorWidget-foreground, var(--vscode-foreground, #ccc))',
              border: '1px solid var(--vscode-widget-border, var(--vscode-sideBar-border, #555))' }}>
            <TimelineColorPicker expression={e.expression} color={e.color}
              onChange={color => onSetColor(e.expression, color)} onClose={() => setColorExpression(null)} />
          </div>}
        </div>
      ))}
    </div>
  );
}

function formatNum(n: number): string {
  if (Math.abs(n) < 1e-6) return '0';
  const abs = Math.abs(n);
  if (abs >= 100) return n.toFixed(1);
  if (abs >= 1) return n.toFixed(2);
  if (abs >= 0.01) return n.toFixed(3);
  if (abs >= 1e-6) return n.toFixed(6);
  return n.toExponential(2);
}

const btnStyle: React.CSSProperties = {
  padding: '3px 8px', border: 'none', borderRadius: 3,
  background: 'var(--vscode-button-background, #0e639c)',
  color: 'var(--vscode-button-foreground, #fff)',
  cursor: 'pointer', fontSize: 12, fontFamily: 'inherit',
};

const iconBtnStyle: React.CSSProperties = {
  padding: '2px 6px', border: '1px solid var(--vscode-sideBar-border, #333)',
  borderRadius: 3, background: 'var(--vscode-button-secondaryBackground, #3a3d41)',
  color: 'var(--vscode-sideBar-foreground, #ccc)', cursor: 'pointer',
  fontSize: 11, fontFamily: 'inherit',
};

const inputStyle: React.CSSProperties = {
  padding: '3px 6px', border: '1px solid var(--vscode-sideBar-border, #333)',
  borderRadius: 3, background: 'var(--vscode-input-background, #3c3c3c)',
  color: 'var(--vscode-input-foreground, #ccc)', fontSize: 12, width: 100,
  fontFamily: 'inherit',
};

const miniInputStyle: React.CSSProperties = {
  padding: '1px 3px', border: '1px solid var(--vscode-sideBar-border, #333)',
  borderRadius: 2, background: 'var(--vscode-input-background, #3c3c3c)',
  fontSize: 10, fontFamily: 'inherit', outline: 'none',
};
