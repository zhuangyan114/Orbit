import React, { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import {
  appendTimelineSamples,
  TimelineFrameBatcher,
  type TimelineDataPoint,
  type TimelineSampleSnapshot,
} from './timeline-sample-buffer';
import { buildTimelineTraceCommands, firstPointAtOrAfter } from './timeline-trace-path';
import {
  clampTimelineViewportEnd,
<<<<<<< HEAD
  quantizeTimelineResolution,
=======
>>>>>>> 6d9ed73 (perf(timeline): lazily load retained sample ranges)
  TimelineRangeController,
  type TimelineHistoryBounds,
} from './timeline-range';
import {
  createTimelineEntry,
  mergeTimelineEntryRefresh,
  type TimelineEntryState as Entry,
  type TimelineEntryUpdate,
} from './timeline-entry-state';

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
const TIME_PRESETS = [2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 30000, 60000, 75000];

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
  const [entries, setEntries] = useState<Entry[]>([]);
  const allDataRef = useRef<Map<string, DataPoint[]>>(new Map());
  const [timePerDiv, setTimePerDiv] = useState(100);
  const timePerDivRef = useRef(timePerDiv);
  timePerDivRef.current = timePerDiv;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [renderTick, setRenderTick] = useState(0);
  const [newExpr, setNewExpr] = useState('');
  const [autoFollow, setAutoFollow] = useState(true);
  const autoFollowRef = useRef(true);
  const tEndRef = useRef(Date.now());
  const latestSampleTimestampRef = useRef(0);
  const isDraggingRef = useRef(false);
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

  applySamplesRef.current = (snapshots) => {
    const map = allDataRef.current;
    const latestTimestamp = appendTimelineSamples(map, snapshots);
    if (latestTimestamp !== undefined) {
      latestSampleTimestampRef.current = Math.max(latestSampleTimestampRef.current, latestTimestamp);
      if (autoFollowRef.current) tEndRef.current = latestSampleTimestampRef.current;
    }
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
<<<<<<< HEAD
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
    for (const request of controller.requestViewport(tStart, tEnd)) {
      const targetBuckets = Math.min(
        100_000,
        Math.max(1, Math.ceil((request.end - request.start) / resolutionKey)),
      );
      vscode.postMessage({
        command: 'loadRange',
        ...request,
        generation: controller.generation,
        resolutionKey,
        targetBuckets,
      });
=======
    for (const request of rangeControllerRef.current!.requestViewport(tStart, tEnd)) {
      vscode.postMessage({ command: 'loadRange', ...request });
>>>>>>> 6d9ed73 (perf(timeline): lazily load retained sample ranges)
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
    vscode.postMessage({
      command: 'saveState',
      state: {
        autoFollow: autoFollowRef.current,
        timePerDiv,
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
            setTimePerDiv(msg.timePerDiv);
            timePerDivRef.current = msg.timePerDiv;
          }
          const m = new Map<string, DataPoint[]>();
          for (const e of eList) m.set(e.expression, []);
          allDataRef.current = m;
          rangeControllerRef.current!.clearCoverage();
          updateHistoryBounds(msg.historyBounds ?? null);
          if (msg.historyBounds) tEndRef.current = msg.historyBounds.end;
          setRenderTick(t => t + 1);
          initedRef.current = true;
          requestVisibleRange();
          break;
        }
        case 'entries': {
          const updates: TimelineEntryUpdate[] = msg.entries || [];
          setEntries(prev => mergeTimelineEntryRefresh(prev, updates));
          setRenderTick(t => t + 1);
          break;
        }
        case 'samples': {
          const snapshots: SampleSnapshot[] = msg.snapshots || [];
          if (msg.historyBounds !== undefined) updateHistoryBounds(msg.historyBounds);
          let start = Number.POSITIVE_INFINITY;
          let end = Number.NEGATIVE_INFINITY;
          for (const snapshot of snapshots) {
            if (snapshot.data.length === 0) continue;
            start = Math.min(start, snapshot.data[0].timestamp);
            end = Math.max(end, snapshot.data[snapshot.data.length - 1].timestamp);
          }
          if (Number.isFinite(start) && Number.isFinite(end)) {
            rangeControllerRef.current!.markLoadedRange({ start, end });
          }
          sampleBatcherRef.current?.enqueue(snapshots);
          break;
        }
        case 'rangeSamples': {
          if (msg.historyBounds !== undefined) updateHistoryBounds(msg.historyBounds);
<<<<<<< HEAD
          if (!rangeControllerRef.current!.completeRequest(
            msg.requestId,
            msg.range ?? null,
            msg.generation,
            msg.resolutionKey,
          )) break;
=======
          if (!rangeControllerRef.current!.completeRequest(msg.requestId, msg.range ?? null)) break;
>>>>>>> 6d9ed73 (perf(timeline): lazily load retained sample ranges)
          sampleBatcherRef.current?.enqueue(msg.snapshots || []);
          requestVisibleRange();
          break;
        }
        case 'historyBounds': {
          rangeControllerRef.current!.cancelPendingRequests();
          updateHistoryBounds(msg.bounds ?? null);
          if (msg.bounds && autoFollowRef.current) tEndRef.current = msg.bounds.end;
          setRenderTick(t => t + 1);
          requestVisibleRange();
          break;
        }
      }
    };
    window.addEventListener('message', handler);
    vscode.postMessage({ command: 'init' });
    return () => window.removeEventListener('message', handler);
  }, []);

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

    const margin = { top: 8, right: 12, bottom: 28, left: 12 };
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

  }, [entries, timePerDiv, renderTick, mousePos]);

  useEffect(() => { draw(); }, [draw]);

  useEffect(() => {
    if (!initedRef.current) return;
    const width = timePerDiv * H_DIV;
    tEndRef.current = clampTimelineViewportEnd(tEndRef.current, width, historyBoundsRef.current);
    scheduleVisibleRangeRequest();
  }, [timePerDiv]);

  // Save state to extension whenever entries or timePerDiv change (after init)
  useEffect(() => {
    if (initedRef.current) saveState();
  }, [entries, timePerDiv, saveState]);

  // Save autoFollow changes
  useEffect(() => {
    if (initedRef.current) {
      vscode.postMessage({
        command: 'saveState',
        state: {
          autoFollow,
          timePerDiv,
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
    }
  }, [autoFollow]);

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
    vscode.postMessage({ command: 'addExpression', expression: expr });
    setNewExpr('');
  };

  const toggle = (expr: string, enabled: boolean) => {
    setEntries(prev => prev.map(e => e.expression === expr ? { ...e, enabled } : e));
    vscode.postMessage({ command: 'toggleExpression', expression: expr, enabled });
  };

  const remove = (expr: string) => {
    setEntries(prev => prev.filter(e => e.expression !== expr));
    allDataRef.current.delete(expr);
    setRenderTick(t => t + 1);
    vscode.postMessage({ command: 'removeExpression', expression: expr });
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
    vscode.postMessage({ command: 'setColor', expression: expr, color });
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
    vscode.postMessage({ command: 'clearData' });
  };

  const zoomIn = () => setTimePerDiv(t => {
    const idx = TIME_PRESETS.indexOf(t);
    if (idx > 0) return TIME_PRESETS[idx - 1];
    return t / 2;
  });
  const zoomOut = () => setTimePerDiv(t => {
    const idx = TIME_PRESETS.indexOf(t);
    if (idx < TIME_PRESETS.length - 1) return TIME_PRESETS[idx + 1];
    return t * 2;
  });

  // hover — compute cursor time + values per variable
  const computeHover = useCallback((clientX: number, clientY?: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const margin = { top: 8, right: 12, bottom: 28, left: 12 };
    const plotW = rect.width - margin.left - margin.right;
    const plotH = rect.height - margin.top - margin.bottom;
    if (plotW <= 0) return;
    const relX = clientX - rect.left - margin.left;
    if (relX < 0 || relX > plotW) { setMousePos(null); setHoverVals(null); return; }

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
      // Find the actual data value at cursor time by interpolating between nearest points
      let display = '';
      let lo = 0, hi = pts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (pts[mid].timestamp < cursorTime) lo = mid + 1; else hi = mid;
      }
      // lo is now the first point with timestamp >= cursorTime
      if (lo === 0) {
        display = formatNum(pts[0].value);
      } else if (lo >= pts.length) {
        display = formatNum(pts[pts.length - 1].value);
      } else {
        // Interpolate between pts[lo-1] and pts[lo]
        const p0 = pts[lo - 1], p1 = pts[lo];
        const t = (cursorTime - p0.timestamp) / (p1.timestamp - p0.timestamp || 1);
        const interpVal = p0.value + t * (p1.value - p0.value);
        display = formatNum(interpVal);
      }
      vals.push({ label: entry.expression, value: display, color: entry.color });
    }
    setHoverVals(vals.length > 0 ? vals : null);
  }, [entries, timePerDiv]);
  const computeHoverRef = useRef(computeHover);
  computeHoverRef.current = computeHover;

  // mouse drag to pan
  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    isDraggingRef.current = true;
    dragStartXRef.current = e.clientX;
    dragStartTEndRef.current = tEndRef.current;
    setAutoFollow(false);
    autoFollowRef.current = false;
  };

  const handleCanvasMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (isDraggingRef.current) {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const margin = { top: 8, right: 12, bottom: 28, left: 12 };
      const plotW = rect.width - margin.left - margin.right;
      if (plotW <= 0) return;
      const deltaX = e.clientX - dragStartXRef.current;
      const deltaTime = (deltaX / plotW) * timePerDiv * H_DIV;
      const viewportWidth = timePerDivRef.current * H_DIV;
      tEndRef.current = clampTimelineViewportEnd(
        dragStartTEndRef.current - deltaTime,
        viewportWidth,
        historyBoundsRef.current,
      );
      setRenderTick(t => t + 1);
      scheduleVisibleRangeRequest();
    }
    computeHover(e.clientX, e.clientY);
  };

  const handleMouseUp = () => {
    isDraggingRef.current = false;
    if (rangeRequestTimerRef.current !== null) {
      window.clearTimeout(rangeRequestTimerRef.current);
      rangeRequestTimerRef.current = null;
    }
    requestVisibleRange();
  };
  const handleCanvasMouseLeave = () => {
    handleMouseUp();
    setMousePos(null);
    setHoverVals(null);
  };

  // handle auto-follow toggle
  const onToggleFollow = (follow: boolean) => {
    setAutoFollow(follow);
    autoFollowRef.current = follow;
    if (follow && latestSampleTimestampRef.current > 0) {
      tEndRef.current = latestSampleTimestampRef.current;
    }
    requestVisibleRange();
  };

  // wheel + drag via ref (passive:false for preventDefault)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const dir = e.deltaY > 0 ? 1 : -1;
      setTimePerDiv(t => {
        const idx = TIME_PRESETS.indexOf(t);
        if (dir > 0 && idx < TIME_PRESETS.length - 1) return TIME_PRESETS[idx + 1];
        if (dir < 0 && idx > 0) return TIME_PRESETS[idx - 1];
        return t;
      });
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, []);

  const onSetTimePerDiv = (val: number) => {
    if (val > 0 && val <= 30000) setTimePerDiv(val);
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
        newExpr={newExpr} onNewExpr={setNewExpr} onAdd={addExpr}
        onClear={clearAll} onZoomIn={zoomIn} onZoomOut={zoomOut}
        timePerDiv={timePerDiv} autoFollow={autoFollow} onToggleFollow={onToggleFollow}
        onSetTimePerDiv={onSetTimePerDiv}
      />
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <VariableList
          entries={entries} allDataRef={allDataRef} onToggle={toggle} onRemove={remove}
          onSetYPerDiv={setYPerDiv} onSetYAutoScale={setYAutoScale}
          onSetColor={setColor}
        />
        <div style={{ flex: 1, position: 'relative', minWidth: 0 }}>
          <canvas ref={canvasRef}
            style={{ width: '100%', height: '100%', display: 'block' }}
            onMouseDown={handleMouseDown} onMouseMove={handleCanvasMouseMove}
            onMouseUp={handleMouseUp} onMouseLeave={handleCanvasMouseLeave}
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

function Toolbar({ newExpr, onNewExpr, onAdd, onClear, onZoomIn, onZoomOut, timePerDiv, autoFollow, onToggleFollow, onSetTimePerDiv }: {
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
    const v = parseFloat(raw);
    if (!isNaN(v) && v > 0 && v <= 30000) onSetTimePerDiv(v);
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
      <button onClick={onZoomOut} style={iconBtnStyle} title="放大时间">−</button>
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
        title="输入时间/div (ms)"
      />
      <span style={{ fontSize: 9, color: 'var(--vscode-descriptionForeground, #888)' }}>/div</span>
      <button onClick={onZoomIn} style={iconBtnStyle} title="缩小时间">+</button>
      <label style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 10, cursor: 'pointer', color: 'var(--vscode-sideBar-foreground, #ccc)' }}>
        <input type="checkbox" checked={autoFollow}
          onChange={e => onToggleFollow(e.target.checked)}
          style={{ cursor: 'pointer', margin: 0 }} />
        追踪
      </label>
      <button onClick={onClear} style={iconBtnStyle} title="清除数据">清除</button>
    </div>
  );
}

function VariableList({ entries, allDataRef, onToggle, onRemove, onSetYPerDiv, onSetYAutoScale, onSetColor }: {
  entries: Entry[];
  allDataRef: React.MutableRefObject<Map<string, DataPoint[]>>;
  onToggle: (expr: string, en: boolean) => void;
  onRemove: (expr: string) => void;
  onSetYPerDiv: (expr: string, val: number) => void;
  onSetYAutoScale: (expr: string) => void;
  onSetColor: (expr: string, color: string) => void;
}) {
  const [pendingInputs, setPendingInputs] = useState<Record<string, string>>({});

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
        width: 180, flexShrink: 0, fontSize: 11, padding: 8,
        borderRight: '1px solid var(--vscode-sideBar-border, #333)',
        color: 'var(--vscode-descriptionForeground, #888)', textAlign: 'center', paddingTop: 20,
      }}>
        暂无变量<br/>从 Watch 添加或输入变量名
      </div>
    );
  }
  return (
    <div style={{
      width: 180, flexShrink: 0, fontSize: 11, overflow: 'auto',
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
          <div style={{
            width: 16, height: 16, borderRadius: 3, cursor: 'pointer',
            flexShrink: 0, background: e.color,
            border: '1px solid var(--vscode-sideBar-border, #555)',
          }} onClick={() => document.getElementById(`cp-${CSS.escape(e.expression)}`)?.click()} />
          <input id={`cp-${CSS.escape(e.expression)}`} type="color" value={e.color}
            onChange={ev => onSetColor(e.expression, ev.target.value)}
            style={{ display: 'none' }} />
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
          <button onClick={() => onRemove(e.expression)}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'var(--vscode-errorForeground, #f48771)',
              fontSize: 11, padding: '0 2px', flexShrink: 0,
            }}>×</button>
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
