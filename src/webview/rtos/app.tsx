import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TaskSnapshot } from '../../rtos/model';
import type { TraceEventDto } from '../../trace/systemview-formatter';
import type { TraceEventCategoryFilter, TraceTerminalLevelFilter, TraceTerminalLineDto } from '../../trace/trace-events';
import { ContextsView, type ContextsSubTab } from './contexts-view';
import { ObjectsView } from './objects-view';
import { TimersHeapView } from './timers-heap-view';
import { TraceTimelineView, type SharedTraceCursor } from './trace-timeline-view';
import type { TraceLinkSelection } from '../../trace/clock-panel-link';
import {
  computeAxisDomain,
  computeTimelineJumpForEvent,
  resolveEventTimeStrForUnit,
  segmentScopeKey,
  type TraceAnalysisResponse,
  type TraceAnalysisSourceKind,
  type TraceDiagnosticsResponse,
  type TraceEventLocateResponse,
  type TraceEventsResponse,
  type TraceFocusedEventRef,
  type TracePointInspectResponse,
  type TraceRecordSummary,
  type TraceTerminalResponse,
  type TraceTimeUnit,
  type TraceViewportResponse,
} from './trace-timeline-state';
import {
  DEFAULT_RTOS_VIEW_SETTINGS,
  INITIAL_TRACE_PANEL_STATE,
  describeDiagnosticIssue,
  filterAndSortTasks,
  formatDurationMs,
  formatFieldValue,
  formatHex32,
  objectKindLabel,
  RtosPanelState,
  RtosSubPage,
  RtosTasksSubTab,
  RtosTaskSortKey,
  RtosTaskStateFilter,
  RtosViewSettings,
  stackUsedBytes,
  stackUsedRatio,
} from './rtos-view-state';

interface VsCodeApi {
  postMessage(message: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

let vscodeApi: VsCodeApi;
try {
  vscodeApi = typeof acquireVsCodeApi !== 'undefined' ? acquireVsCodeApi() : { postMessage: () => {} };
} catch {
  vscodeApi = { postMessage: () => {} };
}

const INITIAL_STATE: RtosPanelState = {
  hostVersion: 0,
  visible: true,
  session: { phase: 'none' },
  settings: DEFAULT_RTOS_VIEW_SETTINGS,
  capabilities: null,
  capabilitiesError: null,
  snapshot: null,
  loading: { refresh: false, stackScan: false, capabilities: false },
  liveActive: false,
  lastError: null,
  trace: INITIAL_TRACE_PANEL_STATE,
};

const STATE_LABELS: Record<TaskSnapshot['state'], string> = {
  running: 'Running',
  ready: 'Ready',
  blocked: 'Blocked',
  suspended: 'Suspended',
  termination: 'Termination',
  unknown: 'Unknown',
};

const FILTER_OPTIONS: { id: RtosTaskStateFilter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'running', label: 'Running' },
  { id: 'ready', label: 'Ready' },
  { id: 'blocked', label: 'Blocked' },
  { id: 'suspended', label: 'Suspended' },
  { id: 'termination', label: 'Termination' },
];

const INTERVAL_OPTIONS = [
  { value: 200, label: '200 ms (5 Hz)' },
  { value: 500, label: '500 ms (2 Hz)' },
  { value: 1000, label: '1000 ms (1 Hz)' },
  { value: 2000, label: '2000 ms (0.5 Hz)' },
];

function detectThemeKind(): 'dark' | 'light' | 'hc' {
  const cls = document.body.classList;
  if (cls.contains('vscode-high-contrast') || cls.contains('vscode-high-contrast-light')) return 'hc';
  if (cls.contains('vscode-light')) return 'light';
  return 'dark';
}

function formatTime(timestamp: number): string {
  try {
    return new Date(timestamp).toLocaleTimeString('zh-CN', { hour12: false });
  } catch {
    return String(timestamp);
  }
}

export function RtosApp() {
  const [panel, setPanel] = useState<RtosPanelState>(INITIAL_STATE);
  const [themeKind, setThemeKind] = useState<'dark' | 'light' | 'hc'>(() => detectThemeKind());
  const [traceViewport, setTraceViewport] = useState<TraceViewportResponse | null>(null);
  const [traceAnalysis, setTraceAnalysis] = useState<TraceAnalysisResponse | null>(null);
  const [traceEvents, setTraceEvents] = useState<TraceEventsResponse | null>(null);
  const [traceEventLocate, setTraceEventLocate] = useState<TraceEventLocateResponse | null>(null);
  const [traceTerminal, setTraceTerminal] = useState<TraceTerminalResponse | null>(null);
  const [traceDiagnostics, setTraceDiagnostics] = useState<TraceDiagnosticsResponse | null>(null);
  const [hoverInspect, setHoverInspect] = useState<TracePointInspectResponse | null>(null);
  const [cursorAInspect, setCursorAInspect] = useState<TracePointInspectResponse | null>(null);
  const [cursorBInspect, setCursorBInspect] = useState<TracePointInspectResponse | null>(null);
  const [traceScopeKey, setTraceScopeKey] = useState<string>('all-anchored');
  const [traceViewRange, setTraceViewRange] = useState<{ start: string; end: string } | null>(null);
  const [cursorA, setCursorA] = useState<SharedTraceCursor | null>(null);
  const [cursorB, setCursorB] = useState<SharedTraceCursor | null>(null);
  const [clockLinkMessage, setClockLinkMessage] = useState<{ recordId: string; notice: string } | null>(null);
  const [clockLinkSelection, setClockLinkSelection] = useState<{ recordId: string; cursors: TraceLinkSelection } | null>(null);
  const [contextsRangeSource, setContextsRangeSource] = useState<TraceAnalysisSourceKind>('viewport');
  const [contextsSubTab, setContextsSubTab] = useState<ContextsSubTab>('contexts');
  const [focusedEvent, setFocusedEvent] = useState<TraceFocusedEventRef | null>(null);
  const [pendingLocateTarget, setPendingLocateTarget] = useState<{
    readonly seq: number;
    readonly recordId: string;
    readonly unit: TraceTimeUnit;
    readonly bootGeneration?: number;
    readonly segmentId?: number;
    readonly timeStr: string;
    readonly packetIndexInSegment?: number;
    readonly streamByteOffset?: number;
  } | null>(null);
  const locateTriggerSeqRef = useRef(0);
  const hostVersionRef = useRef(-1);
  const selectedTraceIdRef = useRef<string | null>(null);
  const prevTraceRecordRef = useRef<string | null>(null);
  const prevTraceAxisKeyRef = useRef<string>('');
  const pendingTimelineJumpRef = useRef<{
    axisKey: string;
    viewRange: { start: string; end: string };
    cursorA: SharedTraceCursor;
  } | null>(null);

  useEffect(() => {
    const refreshTheme = () => setThemeKind(detectThemeKind());
    const observer = new MutationObserver(refreshTheme);
    observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'style', 'data-vscode-color-theme'] });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });

    const onMessage = (event: MessageEvent) => {
      const msg = event.data;
      if (!msg || typeof msg !== 'object') return;
      if (msg.command === 'clockLinkSelection' || msg.command === 'clockLinkNotice') {
        setClockLinkMessage({ recordId: msg.recordId, notice: msg.notice });
        if (msg.command === 'clockLinkSelection') setClockLinkSelection({ recordId: msg.recordId, cursors: msg.cursors });
        return;
      }
      if (msg.command === 'state' && msg.state && typeof msg.state === 'object') {
        const next = msg.state as RtosPanelState;
        if (next.hostVersion < hostVersionRef.current) return;
        hostVersionRef.current = next.hostVersion;
        const nextRecId = next.trace?.selectedRecordId ?? null;
        if (nextRecId !== selectedTraceIdRef.current) {
          selectedTraceIdRef.current = nextRecId;
          setTraceViewport(null);
          setTraceAnalysis(null);
          setTraceEvents(null);
          setTraceEventLocate(null);
          setTraceTerminal(null);
          setTraceDiagnostics(null);
          setFocusedEvent(null);
          setPendingLocateTarget(null);
          setHoverInspect(null);
          setCursorAInspect(null);
          setCursorBInspect(null);
        }
        setPanel(next);
      } else if (msg.command === 'visibility') {
        setPanel(prev => ({ ...prev, visible: Boolean(msg.visible) }));
      } else if (msg.command === 'traceRecordMeta' && msg.record && typeof msg.record === 'object') {
        const rec = msg.record as TraceRecordSummary;
        setPanel(prev => {
          const curTrace = prev.trace ?? INITIAL_TRACE_PANEL_STATE;
          const exists = curTrace.records.some(r => r.recordId === rec.recordId);
          const records = exists
            ? curTrace.records.map(r => (r.recordId === rec.recordId ? rec : r))
            : [...curTrace.records, rec];
          return { ...prev, trace: { ...curTrace, records } };
        });
      } else if (msg.command === 'traceViewportResult' && msg.result && typeof msg.result === 'object') {
        const res = msg.result as TraceViewportResponse;
        if (res.recordId === selectedTraceIdRef.current) {
          setTraceViewport(prev => (prev && res.querySeq < prev.querySeq ? prev : res));
        }
      } else if (msg.command === 'traceAnalysisResult' && msg.result && typeof msg.result === 'object') {
        const res = msg.result as TraceAnalysisResponse;
        if (res.recordId === selectedTraceIdRef.current) {
          setTraceAnalysis(prev => (prev && res.querySeq < prev.querySeq ? prev : res));
        }
      } else if (msg.command === 'traceEventsResult' && msg.result && typeof msg.result === 'object') {
        const res = msg.result as TraceEventsResponse;
        if (res.recordId === selectedTraceIdRef.current) {
          setTraceEvents(prev => (prev && res.querySeq < prev.querySeq ? prev : res));
        }
      } else if (msg.command === 'traceEventLocateResult' && msg.result && typeof msg.result === 'object') {
        const res = msg.result as TraceEventLocateResponse;
        if (res.recordId === selectedTraceIdRef.current) {
          setTraceEventLocate(prev => (prev && res.querySeq < prev.querySeq ? prev : res));
        }
      } else if (msg.command === 'traceTerminalResult' && msg.result && typeof msg.result === 'object') {
        const res = msg.result as TraceTerminalResponse;
        if (res.recordId === selectedTraceIdRef.current) {
          setTraceTerminal(prev => (prev && res.querySeq < prev.querySeq ? prev : res));
        }
      } else if (msg.command === 'traceDiagnosticsResult' && msg.result && typeof msg.result === 'object') {
        const res = msg.result as TraceDiagnosticsResponse;
        if (res.recordId === selectedTraceIdRef.current) {
          setTraceDiagnostics(res);
        }
      } else if (msg.command === 'tracePointInspectResult' && msg.result && typeof msg.result === 'object') {
        const res = msg.result as TracePointInspectResponse;
        if (res.recordId === selectedTraceIdRef.current) {
          if (res.targetKind === 'hover') setHoverInspect(res);
          else if (res.targetKind === 'cursorA') setCursorAInspect(res);
          else if (res.targetKind === 'cursorB') setCursorBInspect(res);
        }
      } else if (msg.command === 'rtosUiTestAction' && typeof msg.requestId === 'number') {
        const requestId = msg.requestId as number;
        const action = String(msg.action ?? '');
        const payload = (msg.payload && typeof msg.payload === 'object' ? msg.payload : {}) as Record<string, any>;
        try {
          const w = window as any;
          let data: unknown = null;
          if (action === 'tasks.getState') {
            const rowTexts = Array.from(document.querySelectorAll('.rtos-table tbody tr.rtos-row')).map(tr => (tr.textContent ?? '').replace(/\s+/g, ' ').trim());
            const activeSubTabText = (document.querySelector('.rtos-subtab.active')?.textContent ?? '').trim();
            const activePageText = (document.querySelector('.rtos-nav-btn.active')?.textContent ?? '').trim();
            data = {
              domTaskRows: rowTexts.length,
              rowTexts,
              activeSubTabText,
              activePageText,
              hostVersion: hostVersionRef.current,
            };
          } else if (action === 'contexts.setSubTab') {
            w.__orbitRtosContextsTestApi?.setSubTab?.(payload.tab);
            data = { ok: true };
          } else if (action === 'contexts.setRangeSource') {
            w.__orbitRtosContextsTestApi?.setRangeSource?.(payload.source);
            data = { ok: true };
          } else if (action === 'contexts.setScopeKey') {
            w.__orbitRtosContextsTestApi?.setScopeKey?.(payload.scopeKey);
            data = { ok: true };
          } else if (action === 'contexts.getState') {
            data = w.__orbitRtosContextsTestApi?.getState?.() ?? null;
          } else if (action === 'events.getState') {
            data = {
              ...(w.__orbitRtosEventsTestApi?.getState?.() ?? {}),
              domVrows: document.querySelectorAll('.events-vrow').length,
              detailText: document.querySelector('.events-detail-pane')?.textContent ?? '',
            };
          } else if (action === 'events.setFilter') {
            if (payload.category !== undefined) w.__orbitRtosEventsTestApi?.setCategory?.(payload.category);
            if (payload.searchText !== undefined) w.__orbitRtosEventsTestApi?.setSearchText?.(payload.searchText);
            data = { ok: true };
          } else if (action === 'events.jumpToRow') {
            w.__orbitRtosEventsTestApi?.jumpToRow?.(Number(payload.rowIndex) || 0);
            data = { ok: true };
          } else if (action === 'events.clickDomRow') {
            const rows = document.querySelectorAll('.events-vrow');
            const idx = Math.max(0, Math.min(rows.length - 1, Number(payload.index) || 0));
            const el = rows[idx] as HTMLElement | undefined;
            el?.click();
            data = { clicked: Boolean(el), totalDomRows: rows.length };
          } else if (action === 'events.jumpToSelectedTimeline') {
            w.__orbitRtosEventsTestApi?.jumpToSelectedTimeline?.();
            data = { ok: true };
          } else if (action === 'terminal.getState') {
            const diagItems = Array.from(document.querySelectorAll('.terminal-diag-item')).map(e => e.textContent ?? '');
            const lineTexts = Array.from(document.querySelectorAll('.terminal-line-text')).map(e => e.textContent ?? '');
            data = {
              ...(w.__orbitRtosTerminalTestApi?.getState?.() ?? {}),
              domLines: document.querySelectorAll('.terminal-line').length,
              domLineTexts: lineTexts,
              domDiagnostics: diagItems,
            };
          } else if (action === 'terminal.clickJumpToTimelineByText') {
            const needle = String(payload.text ?? '');
            const lineEls = Array.from(document.querySelectorAll('.terminal-line'));
            const matchLine = lineEls.find(el => (el.querySelector('.terminal-line-text')?.textContent ?? '').includes(needle));
            const btns = matchLine ? Array.from(matchLine.querySelectorAll('button')) : [];
            const jumpBtn = btns.find(b => (b.textContent ?? '').includes('定位Trace')) as HTMLElement | undefined;
            jumpBtn?.click();
            data = { foundLine: Boolean(matchLine), clicked: Boolean(jumpBtn) };
          } else if (action === 'terminal.setFilter') {
            if (payload.level !== undefined) w.__orbitRtosTerminalTestApi?.setLevel?.(payload.level);
            if (payload.searchText !== undefined) w.__orbitRtosTerminalTestApi?.setSearchText?.(payload.searchText);
            if (payload.mergeAppend !== undefined) w.__orbitRtosTerminalTestApi?.setMergeAppend?.(Boolean(payload.mergeAppend));
            data = { ok: true };
          } else if (action === 'timeline.getState') {
            const jumpBtn = Array.from(document.querySelectorAll('.trace-cursor-row button')).find(b => (b.textContent ?? '').includes('在 Events 中定位'));
            const firstCursorRowText = document.querySelector('.trace-cursor-row')?.textContent ?? '';
            data = {
              ...(w.__orbitTraceTimelineTestApi?.getState?.() ?? {}),
              cursorBarText: firstCursorRowText,
              jumpToEventsButtonPresent: Boolean(jumpBtn),
            };
          } else if (action === 'trace.getState') {
            data = w.__orbitTraceTimelineTestApi?.getState?.() ?? null;
          } else if (action === 'trace.clickClockLink') {
            const label = payload.align ? '手动对齐' : '定位到变量 TIMELINE';
            const button = Array.from(document.querySelectorAll('button')).find(el => el.textContent === label && !el.disabled);
            button?.click();
            data = { clicked: Boolean(button) };
          } else if (action === 'trace.exportCsvViewport') {
            data = { triggered: Boolean(w.__orbitTraceTimelineTestApi?.exportCsvViewport?.(payload.outputPath)) };
          } else if (action === 'trace.exportCsvSelection') {
            data = { triggered: Boolean(w.__orbitTraceTimelineTestApi?.exportCsvSelection?.(payload.outputPath)) };
          } else if (action === 'trace.exportRaw') {
            data = { triggered: Boolean(w.__orbitTraceTimelineTestApi?.exportRaw?.(payload.outputPath)) };
          } else if (action === 'trace.saveRecording') {
            data = { triggered: Boolean(w.__orbitTraceTimelineTestApi?.saveRecording?.(payload.targetDir)) };
          } else if (action === 'trace.openRecording') {
            data = { triggered: Boolean(w.__orbitTraceTimelineTestApi?.openRecording?.(payload.recordingDir)) };
          } else if (action === 'trace.setRange') {
            w.__orbitTraceTimelineTestApi?.setRange?.(String(payload.startStr), String(payload.endStr));
            data = { ok: true };
          } else if (action === 'trace.setCursor') {
            w.__orbitTraceTimelineTestApi?.setCursor?.(payload.kind === 'B' ? 'B' : 'A', String(payload.timeStr));
            data = { ok: true };
          } else if (action === 'events.exportCsv') {
            data = { triggered: Boolean(w.__orbitRtosEventsTestApi?.exportCsv?.(payload.outputPath)) };
          } else if (action === 'timeline.clickJumpToEventsButton') {
            const jumpBtn = Array.from(document.querySelectorAll('.trace-cursor-row button')).find(b => (b.textContent ?? '').includes('在 Events 中定位')) as HTMLElement | undefined;
            jumpBtn?.click();
            data = { clicked: Boolean(jumpBtn) };
          } else if (action === 'timeline.setCursorAndJumpToEvents') {
            if (payload.startStr && payload.endStr) {
              w.__orbitTraceTimelineTestApi?.setRange?.(String(payload.startStr), String(payload.endStr));
            }
            if (payload.timeStr) {
              w.__orbitTraceTimelineTestApi?.setCursor?.('A', String(payload.timeStr));
            }
            setTimeout(() => {
              const ok = Boolean(w.__orbitTraceTimelineTestApi?.jumpToEventsAtCursorA?.());
              vscodeApi.postMessage({ command: 'rtosUiTestActionResult', requestId, ok: true, data: { jumped: ok } });
            }, 350);
            return;
          } else {
            throw new Error(`Unknown UI action: ${action}`);
          }
          vscodeApi.postMessage({ command: 'rtosUiTestActionResult', requestId, ok: true, data });
        } catch (err) {
          vscodeApi.postMessage({
            command: 'rtosUiTestActionResult',
            requestId,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    };
    window.addEventListener('message', onMessage);
    vscodeApi.postMessage({ command: 'ready' });

    return () => {
      observer.disconnect();
      window.removeEventListener('message', onMessage);
    };
  }, []);

  const settings = panel.settings;
  const updateSettings = useCallback((patch: Partial<RtosViewSettings>) => {
    setPanel(prev => ({ ...prev, settings: { ...prev.settings, ...patch } }));
    vscodeApi.postMessage({ command: 'updateSettings', settings: patch });
  }, []);

  const handleQueryViewport = useCallback((req: {
    querySeq: number;
    recordId: string;
    unit: 'ns' | 'relative-ns' | 'absolute-ticks' | 'relative-ticks';
    scopeKey: string;
    bootGeneration?: number;
    segmentId?: number;
    start: string;
    end: string;
    maxBuckets: number;
    detailLimit: number;
  }) => {
    vscodeApi.postMessage({ command: 'traceQueryViewport', ...req });
  }, []);

  const handleInspectPoint = useCallback((req: {
    querySeq: number;
    targetKind: 'hover' | 'cursorA' | 'cursorB';
    recordId: string;
    unit: 'ns' | 'relative-ns' | 'absolute-ticks' | 'relative-ticks';
    queryTime: string;
    queryStart: string;
    queryEnd: string;
    bootGeneration?: number;
    segmentId?: number;
  }) => {
    vscodeApi.postMessage({ command: 'traceInspectPoint', ...req });
  }, []);

  const handlePerfReport = useCallback((perf: Record<string, unknown>) => {
    vscodeApi.postMessage({ command: 'tracePerfReport', perf });
  }, []);

  const handleQueryAnalysis = useCallback((req: {
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
  }) => {
    vscodeApi.postMessage({ command: 'traceQueryAnalysis', ...req });
  }, []);

  const handleContextsPerfReport = useCallback((perf: Record<string, unknown>) => {
    vscodeApi.postMessage({ command: 'contextsPerfReport', perf });
  }, []);

  const handleQueryEvents = useCallback((req: {
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
  }) => {
    vscodeApi.postMessage({ command: 'traceQueryEvents', ...req });
  }, []);

  const handleLocateEvent = useCallback((req: {
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
  }) => {
    vscodeApi.postMessage({ command: 'traceLocateEvent', ...req });
  }, []);

  const handleQueryTerminal = useCallback((req: {
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
    level: TraceTerminalLevelFilter;
    searchText: string;
    mergeAppend: boolean;
  }) => {
    vscodeApi.postMessage({ command: 'traceQueryTerminal', ...req });
  }, []);

  const handleGetDiagnostics = useCallback((req: {
    recordId: string;
    bootGeneration?: number;
    segmentId?: number;
  }) => {
    vscodeApi.postMessage({ command: 'traceGetDiagnostics', ...req });
  }, []);

  const handleEventsPerfReport = useCallback((perf: Record<string, unknown>) => {
    vscodeApi.postMessage({ command: 'eventsPerfReport', perf });
  }, []);

  const handleTerminalPerfReport = useCallback((perf: Record<string, unknown>) => {
    vscodeApi.postMessage({ command: 'terminalPerfReport', perf });
  }, []);

  const traceState = panel.trace ?? INITIAL_TRACE_PANEL_STATE;
  const selectedTraceRecord: TraceRecordSummary | null = useMemo(() => {
    if (!traceState.records.length) return null;
    if (traceState.selectedRecordId) {
      const hit = traceState.records.find(r => r.recordId === traceState.selectedRecordId);
      if (hit) return hit;
    }
    return traceState.records[traceState.records.length - 1];
  }, [traceState.records, traceState.selectedRecordId]);

  const traceAxisDomain = useMemo(() => {
    const segs = selectedTraceRecord?.segments ?? [];
    return computeAxisDomain(segs, settings.traceTimeUnit, traceScopeKey);
  }, [selectedTraceRecord?.segments, settings.traceTimeUnit, traceScopeKey]);

  const activeTraceRecordId = selectedTraceRecord?.recordId ?? null;
  const isSelectedTraceLive = selectedTraceRecord?.state === 'recording';

  useEffect(() => {
    const axisKey = `${activeTraceRecordId ?? ''}::${traceAxisDomain.scopeKey}::${traceAxisDomain.unit}`;
    if (prevTraceRecordRef.current !== activeTraceRecordId) {
      prevTraceRecordRef.current = activeTraceRecordId;
      setTraceScopeKey('all-anchored');
      setCursorA(null);
      setCursorB(null);
      setTraceViewRange(null);
      setTraceAnalysis(null);
      setFocusedEvent(null);
      setPendingLocateTarget(null);
    }
    if (prevTraceAxisKeyRef.current !== axisKey) {
      prevTraceAxisKeyRef.current = axisKey;
      const pendingJump = pendingTimelineJumpRef.current;
      if (pendingJump && pendingJump.axisKey === axisKey) {
        pendingTimelineJumpRef.current = null;
        setCursorA(pendingJump.cursorA);
        setCursorB(null);
        setTraceAnalysis(null);
        setTraceViewRange(pendingJump.viewRange);
      } else {
        setCursorA(null);
        setCursorB(null);
        setTraceAnalysis(null);
        if (traceAxisDomain.valid) {
          setTraceViewRange({ start: traceAxisDomain.minStr, end: traceAxisDomain.displayMaxStr });
        } else {
          setTraceViewRange(null);
        }
      }
    } else if (pendingTimelineJumpRef.current && pendingTimelineJumpRef.current.axisKey === axisKey) {
      const pendingJump = pendingTimelineJumpRef.current;
      pendingTimelineJumpRef.current = null;
      setCursorA(pendingJump.cursorA);
      setCursorB(null);
      setTraceAnalysis(null);
      setTraceViewRange(pendingJump.viewRange);
    }
  }, [activeTraceRecordId, traceAxisDomain.scopeKey, traceAxisDomain.unit, traceAxisDomain.valid, traceAxisDomain.minStr, traceAxisDomain.displayMaxStr]);

  useEffect(() => {
    if (!clockLinkSelection || clockLinkSelection.recordId !== activeTraceRecordId) return;
    const { A, B } = clockLinkSelection.cursors;
    const point = A ?? B;
    if (point?.bootGeneration === undefined || point.segmentId === undefined) return;
    const scope = segmentScopeKey(point.bootGeneration, point.segmentId);
    if (traceScopeKey !== scope || settings.traceTimeUnit !== point.unit || settings.activePage !== 'trace') {
      pendingTimelineJumpRef.current = null;
      setTraceScopeKey(scope);
      updateSettings({ traceTimeUnit: point.unit, activePage: 'trace' });
      return;
    }
    setClockLinkSelection(null);
    setFocusedEvent(null);
    setCursorA(A);
    setCursorB(B);
    if (!settings.traceAutoFollow && traceAxisDomain.valid) {
      const min = BigInt(traceAxisDomain.minStr);
      const max = BigInt(traceAxisDomain.displayMaxStr);
      const left = BigInt((A ?? point).timeStr);
      const right = BigInt((B ?? point).timeStr);
      const low = left < right ? left : right;
      const high = left < right ? right : left;
      const padding = (max - min) / 10n + 1n;
      setTraceViewRange({ start: (low - padding > min ? low - padding : min).toString(),
        end: (high + padding < max ? high + padding : max).toString() });
    }
  }, [clockLinkSelection, activeTraceRecordId, settings.traceTimeUnit, settings.activePage, settings.traceAutoFollow,
    traceScopeKey, traceAxisDomain, updateSettings]);

  useEffect(() => {
    if (!traceAxisDomain.valid) return;
    const minB = BigInt(traceAxisDomain.minStr);
    const maxB = BigInt(traceAxisDomain.displayMaxStr);
    setTraceViewRange(prev => {
      if (!prev) {
        return { start: minB.toString(), end: maxB.toString() };
      }
      const prevStart = BigInt(prev.start);
      const prevEnd = BigInt(prev.end);
      const span = prevEnd > prevStart ? prevEnd - prevStart : maxB - minB;
      if (settings.traceAutoFollow && isSelectedTraceLive) {
        const nextEnd = maxB;
        const nextStart = nextEnd - span > minB ? nextEnd - span : minB;
        if (nextStart === prevStart && nextEnd === prevEnd) return prev;
        return { start: nextStart.toString(), end: nextEnd.toString() };
      }
      if (prevStart < minB && prevEnd > maxB) {
        return { start: minB.toString(), end: maxB.toString() };
      }
      return prev;
    });
  }, [traceAxisDomain.valid, traceAxisDomain.minStr, traceAxisDomain.displayMaxStr, settings.traceAutoFollow, isSelectedTraceLive]);

  const handleJumpToTimelineRange = useCallback((start: string, end: string) => {
    if (traceAxisDomain.valid && BigInt(end) < BigInt(traceAxisDomain.displayMaxStr) && settings.traceAutoFollow) {
      updateSettings({ traceAutoFollow: false, activePage: 'trace' });
    } else {
      updateSettings({ activePage: 'trace' });
    }
    setTraceViewRange({ start, end });
  }, [traceAxisDomain.valid, traceAxisDomain.displayMaxStr, settings.traceAutoFollow, updateSettings]);

  const handleSelectFocusedEvent = useCallback((ev: TraceEventDto) => {
    if (!activeTraceRecordId) return;
    const tStr = resolveEventTimeStrForUnit(ev, traceAxisDomain.unit) ?? ev.relTicks;
    const tUnit: TraceTimeUnit = resolveEventTimeStrForUnit(ev, traceAxisDomain.unit) !== undefined
      ? traceAxisDomain.unit
      : 'relative-ticks';
    setFocusedEvent({
      recordId: activeTraceRecordId,
      eventKey: ev.eventKey,
      bootGeneration: ev.bootGeneration,
      segmentId: ev.segmentId,
      packetIndexInSegment: ev.packetIndexInSegment,
      streamByteOffset: ev.streamByteOffset,
      timeStr: tStr,
      unit: tUnit,
      label: ev.eventName,
    });
  }, [activeTraceRecordId, traceAxisDomain.unit]);

  const handleJumpToTimelineEvent = useCallback((ev: {
    bootGeneration: number;
    segmentId: number;
    packetIndexInSegment: number;
    streamByteOffset: number;
    relTicks: string;
    absTicks?: string;
    ns?: string;
    sysFreqHz?: number;
    eventKey: string;
    eventName?: string;
  }) => {
    if (!selectedTraceRecord) return;
    const plan = computeTimelineJumpForEvent(
      ev,
      selectedTraceRecord.segments,
      traceScopeKey,
      settings.traceTimeUnit,
    );
    if (!plan.ok) return;

    const nextCursorA: SharedTraceCursor = {
      timeStr: plan.timeStr,
      unit: plan.unit,
      bootGeneration: plan.bootGeneration,
      segmentId: plan.segmentId,
    };
    setFocusedEvent({
      recordId: selectedTraceRecord.recordId,
      eventKey: ev.eventKey,
      bootGeneration: ev.bootGeneration,
      segmentId: ev.segmentId,
      packetIndexInSegment: ev.packetIndexInSegment,
      streamByteOffset: ev.streamByteOffset,
      timeStr: plan.timeStr,
      unit: plan.unit,
      label: ev.eventName,
    });

    const targetAxisKey = `${selectedTraceRecord.recordId}::${plan.scopeKey}::${plan.unit}`;
    const currentEffectiveAxisKey = `${selectedTraceRecord.recordId}::${traceAxisDomain.scopeKey}::${traceAxisDomain.unit}`;
    if (targetAxisKey !== currentEffectiveAxisKey) {
      pendingTimelineJumpRef.current = {
        axisKey: targetAxisKey,
        viewRange: { start: plan.viewStart, end: plan.viewEnd },
        cursorA: nextCursorA,
      };
    } else {
      pendingTimelineJumpRef.current = null;
      setCursorA(nextCursorA);
      setCursorB(null);
      setTraceViewRange({ start: plan.viewStart, end: plan.viewEnd });
    }
    if (plan.scopeKey !== traceScopeKey) {
      setTraceScopeKey(plan.scopeKey);
    }

    const patch: Partial<RtosViewSettings> = { activePage: 'trace' };
    if (plan.unit !== settings.traceTimeUnit) {
      patch.traceTimeUnit = plan.unit;
    }
    if (settings.traceAutoFollow) {
      patch.traceAutoFollow = false;
    }
    updateSettings(patch);
  }, [
    selectedTraceRecord,
    traceScopeKey,
    traceAxisDomain.scopeKey,
    traceAxisDomain.unit,
    settings.traceTimeUnit,
    settings.traceAutoFollow,
    updateSettings,
  ]);

  const handleTimelinePointClick = useCallback((target: {
    recordId: string;
    unit: TraceTimeUnit;
    timeStr: string;
    bootGeneration?: number;
    segmentId?: number;
  }) => {
    setFocusedEvent(null);
    const seq = ++locateTriggerSeqRef.current;
    setPendingLocateTarget({
      seq,
      recordId: target.recordId,
      unit: target.unit,
      bootGeneration: target.bootGeneration,
      segmentId: target.segmentId,
      timeStr: target.timeStr,
    });
  }, []);

  const handleJumpToEventInEvents = useCallback((target: {
    recordId: string;
    unit: TraceTimeUnit;
    timeStr: string;
    bootGeneration?: number;
    segmentId?: number;
    packetIndexInSegment?: number;
    streamByteOffset?: number;
  }) => {
    setTraceEventLocate(null);
    const seq = ++locateTriggerSeqRef.current;
    setPendingLocateTarget({
      seq,
      ...target,
    });
    setContextsSubTab('events');
    updateSettings({ activePage: 'contexts' });
  }, [updateSettings]);

  const handleLocateLineInEvents = useCallback((line: TraceTerminalLineDto) => {
    if (!activeTraceRecordId) return;
    const tStr = resolveEventTimeStrForUnit(line, traceAxisDomain.unit) ?? line.relTicks;
    const tUnit: TraceTimeUnit = resolveEventTimeStrForUnit(line, traceAxisDomain.unit) !== undefined
      ? traceAxisDomain.unit
      : 'relative-ticks';
    const seq = ++locateTriggerSeqRef.current;
    setPendingLocateTarget({
      seq,
      recordId: activeTraceRecordId,
      unit: tUnit,
      bootGeneration: line.bootGeneration,
      segmentId: line.segmentId,
      timeStr: tStr,
      packetIndexInSegment: line.packetIndexInSegment,
      streamByteOffset: line.streamByteOffset,
    });
  }, [activeTraceRecordId, traceAxisDomain.unit]);

  const toggleLive = (enabled: boolean) => {
    setPanel(prev => ({ ...prev, settings: { ...prev.settings, liveEnabled: enabled } }));
    vscodeApi.postMessage({ command: 'setLive', enabled, intervalMs: settings.liveIntervalMs });
  };

  const toggleSort = (key: RtosTaskSortKey) => {
    const nextDir = settings.sortBy === key ? (settings.sortDir === 'asc' ? 'desc' : 'asc') : (key === 'priority' || key === 'cpu' || key === 'stack' ? 'desc' : 'asc');
    updateSettings({ sortBy: key, sortDir: nextDir });
  };

  const snapshot = panel.snapshot;
  const tasks = snapshot?.tasks ?? [];
  const objectsSummary = snapshot?.objects;
  const objectsCount = objectsSummary?.objects.length ?? 0;
  const timersSummary = snapshot?.timers;
  const timersCount = timersSummary?.timers.length ?? 0;
  const heapOverview = snapshot?.heap;
  const displayedTasks = useMemo(
    () => (panel.visible ? filterAndSortTasks(tasks, settings) : []),
    [panel.visible, tasks, settings.stateFilter, settings.searchQuery, settings.sortBy, settings.sortDir],
  );

  const selectedTask = useMemo(
    () => (settings.selectedTaskAddress !== null ? tasks.find(task => task.tcbAddress === settings.selectedTaskAddress) ?? null : null),
    [tasks, settings.selectedTaskAddress],
  );

  const selectedTaskWaits = useMemo(
    () => (selectedTask && objectsSummary
      ? objectsSummary.waitEdges.filter(edge => edge.taskAddress === selectedTask.tcbAddress)
      : []),
    [selectedTask, objectsSummary],
  );

  const selectedTaskHolds = useMemo(
    () => (selectedTask && objectsSummary
      ? objectsSummary.objects.filter(obj => obj.holder?.address === selectedTask.tcbAddress)
      : []),
    [selectedTask, objectsSummary],
  );

  const diagnosticError = useMemo(() => {
    if (panel.capabilitiesError) return describeDiagnosticIssue(panel.capabilitiesError);
    if (snapshot && snapshot.consistency === 'unavailable' && snapshot.reason) {
      return describeDiagnosticIssue({ errorCode: (snapshot as any).errorCode, message: snapshot.reason });
    }
    return null;
  }, [panel.capabilitiesError, snapshot]);

  const canQueryTarget = panel.session.phase === 'connected' || panel.session.phase === 'starting';
  const canScanStacks = !!panel.capabilities?.capabilities.stackWatermark.available && tasks.length > 0 && !panel.loading.stackScan;
  const canInspectObjects = canQueryTarget && !panel.loading.capabilities && (panel.capabilities?.capabilities.objects?.available ?? true);
  const caps = panel.capabilities?.capabilities;

  return (
    <div
      className="rtos-root"
      data-theme-kind={themeKind}
      data-session-phase={panel.session.phase}
      data-consistency={snapshot?.consistency ?? 'none'}
      data-live={panel.liveActive ? 'on' : 'off'}
    >
      <style>{STYLES}</style>

      {/* 公共工具栏 */}
      <header className="rtos-toolbar" aria-label="RTOS 工具栏">
        <div className="rtos-toolbar-group">
          <span className="rtos-pill rtos-pill-session" title={panel.session.sessionId ? `会话 ID: ${panel.session.sessionId}` : '未连接调试会话'}>
            <span className={`rtos-dot rtos-dot-${panel.session.phase}`} aria-hidden="true" />
            {panel.session.phase === 'none' && '无活动会话'}
            {panel.session.phase === 'starting' && `连接中 · ${panel.session.sessionName || 'Orbit'}`}
            {panel.session.phase === 'terminating' && `已断开 · ${panel.session.sessionName || 'Orbit'}`}
            {panel.session.phase === 'connected' && `FreeRTOS${panel.session.device ? ` · ${panel.session.device}` : ''}`}
          </span>
        </div>

        <nav className="rtos-subtabs" role="tablist" aria-label="RTOS 子视图">
          {([
            ['tasks', 'Tasks & Objects'],
            ['trace', 'Trace Timeline'],
            ['contexts', 'Contexts & Events'],
          ] as [RtosSubPage, string][]).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={settings.activePage === id}
              className={`rtos-subtab${settings.activePage === id ? ' active' : ''}`}
              onClick={() => updateSettings({ activePage: id })}
            >
              {label}
            </button>
          ))}
        </nav>

        <div className="rtos-toolbar-group rtos-toolbar-actions">
          {panel.loading.refresh ? (
            <button type="button" className="rtos-btn rtos-btn-secondary rtos-btn-action" onClick={() => vscodeApi.postMessage({ command: 'cancel' })}>
              取消
            </button>
          ) : (
            <button
              type="button"
              className="rtos-btn rtos-btn-action"
              disabled={!canQueryTarget || panel.loading.capabilities}
              title="立即执行一次快照刷新"
              onClick={() => vscodeApi.postMessage({ command: 'refresh' })}
            >
              刷新
            </button>
          )}

          <label className="rtos-live-toggle" title="按固定间隔请求只读后台快照（不阻塞调试控制）">
            <input
              type="checkbox"
              checked={settings.liveEnabled}
              onChange={event => toggleLive(event.target.checked)}
            />
            <span>Live</span>
            <span className={`rtos-live-dot${panel.liveActive ? ' active' : ''}`} aria-hidden="true">●</span>
          </label>

          <label className="rtos-live-toggle" title="Live 轮询时同步读取队列、互斥锁、信号量、定时器与堆（会增加每轮总线读取量）">
            <input
              type="checkbox"
              checked={settings.includeObjectsInLive}
              onChange={event => updateSettings({ includeObjectsInLive: event.target.checked })}
            />
            <span>Live含扩展</span>
          </label>

          <select
            aria-label="Live 刷新周期"
            className="rtos-select"
            value={settings.liveIntervalMs}
            onChange={event => updateSettings({ liveIntervalMs: Number(event.target.value) })}
          >
            {INTERVAL_OPTIONS.map(option => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>

          <button
            type="button"
            className="rtos-btn rtos-btn-secondary rtos-btn-scan"
            disabled={!canScanStacks}
            title={caps?.stackWatermark.available ? `按需扫描全部任务栈填充区（每任务上限 ${settings.maxStackScanBytes} B）` : (caps?.stackWatermark.reason || '当前配置不支持栈水位扫描')}
            onClick={() => vscodeApi.postMessage({ command: 'scanStack', all: true })}
          >
            {panel.loading.stackScan ? '扫描中…' : '扫描全部栈'}
          </button>

          <button
            type="button"
            className={`rtos-btn rtos-btn-secondary${settings.showDiagnostics ? ' active' : ''}`}
            aria-expanded={settings.showDiagnostics}
            onClick={() => updateSettings({ showDiagnostics: !settings.showDiagnostics })}
          >
            诊断
          </button>
        </div>
      </header>

      {/* 能力与状态提示条（固定两行布局，防止实时刷新时换行跳动） */}
      {(caps || snapshot || panel.lastError) && (
        <div className="rtos-status-strip">
          {caps && (
            <div className="rtos-caps">
              <CapabilityChip label="任务快照" cap={caps.taskSnapshot} />
              <CapabilityChip label="栈边界" cap={caps.stackBounds} />
              <CapabilityChip label="栈水位" cap={caps.stackWatermark} />
              <CapabilityChip label="运行计数" cap={caps.runtimeCounters} />
              <CapabilityChip label="CPU%" cap={caps.runtimePercent} />
              {caps.objects && <CapabilityChip label="队列与锁" cap={caps.objects} />}
              {caps.timers && <CapabilityChip label="定时器" cap={caps.timers} />}
              {caps.heap && <CapabilityChip label="堆概览" cap={caps.heap} />}
            </div>
          )}
          <div className="rtos-timing">
            {snapshot ? (
              <>
                <span className="rtos-timing-item">#{snapshot.snapshotSequence} · {formatTime(snapshot.completedAt)}</span>
                <span className="rtos-timing-item">
                  总耗时 {formatDurationMs(snapshot.diagnostics.totalMs, 0)} ms（I/O {formatDurationMs(snapshot.diagnostics.ioMs, 1)} / 排队 {formatDurationMs(snapshot.diagnostics.queueWaitMs, 1)}）
                </span>
                <span className="rtos-timing-item">读取 {snapshot.diagnostics.bytes} B / {snapshot.diagnostics.batches} 批</span>
              </>
            ) : (
              <span className="rtos-timing-item rtos-muted">等待快照…</span>
            )}
            {panel.lastError && (
              <span className="rtos-inline-warn" title={panel.lastError.message}>
                ⚠ {panel.lastError.errorCode ? `${panel.lastError.errorCode}: ` : ''}{panel.lastError.message}
              </span>
            )}
          </div>
        </div>
      )}

      {/* 主区域 */}
      <main className="rtos-main">
        {!panel.visible ? (
          <div className="rtos-empty" role="status">RTOS 视图已隐藏，暂停刷新与渲染。</div>
        ) : settings.activePage === 'trace' ? (
          <TraceTimelineView
            visible={panel.visible}
            session={panel.session}
            settings={settings}
            traceState={traceState}
            selectedRecord={selectedTraceRecord}
            axisDomain={traceAxisDomain}
            selectedScopeKey={traceScopeKey}
            viewRange={traceViewRange}
            cursorA={cursorA}
            cursorB={cursorB}
            viewportResult={traceViewport}
            hoverInspect={hoverInspect}
            cursorAInspect={cursorAInspect}
            cursorBInspect={cursorBInspect}
            onChangeScopeKey={setTraceScopeKey}
            onChangeViewRange={setTraceViewRange}
            onChangeCursorA={setCursorA}
            onChangeCursorB={setCursorB}
            clockLinkNotice={clockLinkMessage?.recordId === activeTraceRecordId ? clockLinkMessage.notice : undefined}
            onClockLink={command => vscodeApi.postMessage({ command, recordId: activeTraceRecordId, cursors: { A: cursorA, B: cursorB } })}
            onUpdateSettings={updateSettings}
            onInspectTarget={() => vscodeApi.postMessage({ command: 'traceInspectTarget' })}
            onStartRecording={mode => vscodeApi.postMessage({ command: 'traceStart', mode })}
            onStopRecording={recordId => vscodeApi.postMessage({ command: 'traceStop', recordId })}
            onPauseRecording={recordId => vscodeApi.postMessage({ command: 'tracePause', recordId })}
            onResumeRecording={recordId => vscodeApi.postMessage({ command: 'traceResume', recordId })}
            onCancelRecording={recordId => vscodeApi.postMessage({ command: 'traceCancel', recordId })}
            onSelectRecord={recordId => vscodeApi.postMessage({ command: 'traceSelectRecord', recordId })}
            onOpenRecording={recordingDir => vscodeApi.postMessage({ command: 'traceOpenRecording', ...(recordingDir ? { recordingDir } : {}) })}
            onSaveRecording={(recordId, targetDir) => vscodeApi.postMessage({ command: 'traceSaveRecording', recordId, ...(targetDir ? { targetDir } : {}) })}
            onExportRaw={(recordId, outputPath) => vscodeApi.postMessage({ command: 'traceExportRaw', recordId, ...(outputPath ? { outputPath } : {}) })}
            onExportCsv={req => vscodeApi.postMessage({ command: 'traceExportCsv', ...req })}
            onCloseRecording={recordId => vscodeApi.postMessage({ command: 'traceCloseRecording', recordId })}
            onQueryViewport={handleQueryViewport}
            onInspectPoint={handleInspectPoint}
            onPerfReport={handlePerfReport}
            focusedEvent={focusedEvent}
            onTimelinePointClick={handleTimelinePointClick}
            onJumpToEventInEvents={handleJumpToEventInEvents}
          />
        ) : settings.activePage === 'contexts' ? (
          <ContextsView
            visible={panel.visible}
            settings={settings}
            traceState={traceState}
            selectedRecord={selectedTraceRecord}
            axisDomain={traceAxisDomain}
            selectedScopeKey={traceScopeKey}
            viewRange={traceViewRange}
            cursorA={cursorA}
            cursorB={cursorB}
            cursorAInspect={cursorAInspect}
            cursorBInspect={cursorBInspect}
            analysisResult={traceAnalysis}
            rangeSource={contextsRangeSource}
            onChangeRangeSource={setContextsRangeSource}
            onChangeScopeKey={setTraceScopeKey}
            onUpdateSettings={updateSettings}
            onSelectRecord={recordId => vscodeApi.postMessage({ command: 'traceSelectRecord', recordId })}
            onOpenRecording={recordingDir => vscodeApi.postMessage({ command: 'traceOpenRecording', ...(recordingDir ? { recordingDir } : {}) })}
            onQueryAnalysis={handleQueryAnalysis}
            onJumpToTimelineRange={handleJumpToTimelineRange}
            onPerfReport={handleContextsPerfReport}
            activeSubTab={contextsSubTab}
            onChangeSubTab={setContextsSubTab}
            eventsResult={traceEvents}
            locateResult={traceEventLocate}
            terminalResult={traceTerminal}
            diagnosticsResult={traceDiagnostics}
            focusedEvent={focusedEvent}
            pendingLocateTarget={pendingLocateTarget}
            onSelectFocusedEvent={handleSelectFocusedEvent}
            onJumpToTimelineEvent={handleJumpToTimelineEvent}
            onLocateLineInEvents={handleLocateLineInEvents}
            onQueryEvents={handleQueryEvents}
            onLocateEvent={handleLocateEvent}
            onQueryTerminal={handleQueryTerminal}
            onGetDiagnostics={handleGetDiagnostics}
            onEventsPerfReport={handleEventsPerfReport}
            onTerminalPerfReport={handleTerminalPerfReport}
            onExportCsv={req => vscodeApi.postMessage({ command: 'traceExportCsv', ...req })}
          />
        ) : panel.session.phase === 'none' ? (
          <div className="rtos-empty" role="status">
            <h3>尚未连接 Orbit 调试会话</h3>
            <p>启动 Orbit 调试会话后，RTOS 面板会自动检查 ELF/DWARF 符号并展示 FreeRTOS 任务快照。</p>
            <p className="rtos-muted">当前快照能力：FreeRTOS 任务列表、状态与证据、按需栈边界/水位、基于内核运行计数的 CPU% 估算。</p>
          </div>
        ) : panel.session.phase === 'starting' && !snapshot && !diagnosticError ? (
          <div className="rtos-empty" role="status">
            <h3>正在等待目标调试连接…</h3>
            <p>目标连接并完成符号加载后将自动获取 FreeRTOS 能力；也可稍后点击“刷新”。</p>
          </div>
        ) : diagnosticError && !snapshot?.tasks.length ? (
          <div className="rtos-empty rtos-empty-error" role="status">
            <h3>{diagnosticError.title}</h3>
            <ul>
              {diagnosticError.hints.map((hint, idx) => <li key={idx}>{hint}</li>)}
            </ul>
            <button type="button" className="rtos-btn" onClick={() => vscodeApi.postMessage({ command: 'refresh' })}>
              重新检测
            </button>
          </div>
        ) : (
          <div className="rtos-subview-shell">
            <div className="rtos-sub-bar" role="tablist" aria-label="Tasks & Objects 子页签">
              {([
                ['tasks', `任务 (${tasks.length})`],
                ['objects', `队列与锁 (${objectsCount})`],
                ['timers', `定时器与堆 (${timersCount})`],
              ] as [RtosTasksSubTab, string][]).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={settings.tasksSubTab === id}
                  className={`rtos-chip${settings.tasksSubTab === id ? ' active' : ''}`}
                  onClick={() => updateSettings({ tasksSubTab: id })}
                >
                  {label}
                </button>
              ))}
              {objectsSummary?.waitCycles.length ? (
                <span className="rtos-pill rtos-tone-warn" title="检测到候选互斥等待环">
                  ⚠ 候选等待环 {objectsSummary.waitCycles.length}
                </span>
              ) : null}
            </div>

            {settings.tasksSubTab === 'objects' ? (
              <ObjectsView
                summary={objectsSummary}
                settings={settings}
                canInspect={canInspectObjects}
                refreshing={panel.loading.refresh}
                onUpdateSettings={updateSettings}
                onInspectObject={address => vscodeApi.postMessage(address ? { command: 'inspectObject', address } : { command: 'inspectObject', all: true })}
                onSelectTask={taskAddress => updateSettings({ tasksSubTab: 'tasks', selectedTaskAddress: taskAddress })}
              />
            ) : settings.tasksSubTab === 'timers' ? (
              <TimersHeapView
                timers={timersSummary}
                heap={heapOverview}
                settings={settings}
                canRefresh={canQueryTarget && !panel.loading.capabilities}
                refreshing={panel.loading.refresh}
                onUpdateSettings={updateSettings}
                onRefreshTimersHeap={() => vscodeApi.postMessage({ command: 'inspectTimersHeap' })}
              />
            ) : (
              <div className="rtos-workspace">
                <div className="rtos-table-pane">
              {/* 筛选栏 */}
              <div className="rtos-filter-bar">
                <input
                  type="search"
                  aria-label="筛选任务"
                  className="rtos-search"
                  placeholder="搜索任务名、TCB 地址或列表…"
                  value={settings.searchQuery}
                  onChange={event => updateSettings({ searchQuery: event.target.value })}
                />
                <div className="rtos-filter-chips" role="group" aria-label="按任务状态筛选">
                  {FILTER_OPTIONS.map(opt => (
                    <button
                      key={opt.id}
                      type="button"
                      className={`rtos-chip${settings.stateFilter === opt.id ? ' active' : ''}`}
                      onClick={() => updateSettings({ stateFilter: opt.id })}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                <span className="rtos-count">{displayedTasks.length} / {tasks.length} 任务</span>
              </div>

              {/* 任务表 */}
              <div className="rtos-table-scroll">
                <table className="rtos-table rtos-tasks-table">
                  <colgroup>
                    <col className="rtos-col-state" />
                    <col className="rtos-col-name" />
                    <col className="rtos-col-tcb" />
                    <col className="rtos-col-prio" />
                    <col className="rtos-col-stack" />
                    <col className="rtos-col-cpu" />
                  </colgroup>
                  <thead>
                    <tr>
                      <SortHeader label="状态" sortKey="state" settings={settings} onSort={toggleSort} />
                      <SortHeader label="任务名" sortKey="name" settings={settings} onSort={toggleSort} />
                      <SortHeader label="TCB" sortKey="address" settings={settings} onSort={toggleSort} />
                      <SortHeader label="优先级" sortKey="priority" settings={settings} onSort={toggleSort} />
                      <SortHeader label="栈水位 / 容量" sortKey="stack" settings={settings} onSort={toggleSort} />
                      <SortHeader label="CPU% / 计数" sortKey="cpu" settings={settings} onSort={toggleSort} />
                    </tr>
                  </thead>
                  <tbody>
                    {displayedTasks.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="rtos-table-empty">
                          {tasks.length === 0
                            ? (panel.loading.refresh ? '正在读取任务快照…' : '当前快照未包含任务（或点击“刷新”采集）')
                            : '没有符合筛选条件的任务'}
                        </td>
                      </tr>
                    ) : displayedTasks.map(task => {
                      const selected = settings.selectedTaskAddress === task.tcbAddress;
                      const used = stackUsedBytes(task);
                      const ratio = stackUsedRatio(task);
                      const prioText = task.priority.available
                        ? (task.basePriority.available && task.basePriority.value !== task.priority.value
                          ? `${task.priority.value} (base ${task.basePriority.value})`
                          : String(task.priority.value))
                        : '—';
                      return (
                        <tr
                          key={task.tcbAddress}
                          className={`rtos-row${selected ? ' selected' : ''}`}
                          tabIndex={0}
                          aria-selected={selected}
                          onClick={() => updateSettings({ selectedTaskAddress: selected ? null : task.tcbAddress })}
                          onKeyDown={event => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              updateSettings({ selectedTaskAddress: selected ? null : task.tcbAddress });
                            }
                          }}
                        >
                          <td>
                            <span className={`rtos-state-badge rtos-state-${task.state}`}>
                              {task.current ? '● ' : ''}{STATE_LABELS[task.state]}
                            </span>
                          </td>
                          <td>
                            <div className="rtos-task-name">
                              <span className="rtos-task-name-text" title={task.name.available ? task.name.value : task.name.reason}>
                                {task.name.available ? task.name.value : '(名称不可用)'}
                              </span>
                              <span className="rtos-task-id">
                                {task.creationNumber.available ? `#${task.creationNumber.value}` : '身份不确定'}
                              </span>
                            </div>
                          </td>
                          <td className="rtos-mono rtos-cell-ellipsis">{formatHex32(task.tcbAddress)}</td>
                          <td className="rtos-mono rtos-cell-ellipsis" title={prioText}>{prioText}</td>
                          <td>
                            <div className="rtos-stack-cell">
                              {task.stack.capacityBytes.available ? (
                                <>
                                  <span className="rtos-mono rtos-stack-text" title={task.stack.watermarkBytes.available ? task.stack.watermarkBytes.source : task.stack.watermarkBytes.reason}>
                                    {used !== undefined
                                      ? `${used} / ${task.stack.capacityBytes.value} B`
                                      : `未扫 / ${task.stack.capacityBytes.value} B`}
                                  </span>
                                  {ratio !== undefined && (
                                    <span className="rtos-bar" aria-hidden="true">
                                      <span
                                        className={`rtos-bar-fill${ratio > 0.85 ? ' warn' : ''}`}
                                        style={{ width: `${Math.round(ratio * 100)}%` }}
                                      />
                                    </span>
                                  )}
                                </>
                              ) : (
                                <span className="rtos-muted" title={task.stack.capacityBytes.reason}>
                                  不可用
                                </span>
                              )}
                              {caps?.stackWatermark.available && (
                                <button
                                  type="button"
                                  className="rtos-mini-btn"
                                  disabled={panel.loading.stackScan}
                                  title="扫描此任务栈水位"
                                  onClick={event => {
                                    event.stopPropagation();
                                    vscodeApi.postMessage({ command: 'scanStack', taskAddresses: [task.tcbAddress] });
                                  }}
                                >
                                  扫描
                                </button>
                              )}
                            </div>
                          </td>
                          <td>
                            <div className="rtos-cpu-cell">
                              <span
                                className="rtos-mono rtos-cpu-pct"
                                title={task.runtime.percent.available
                                  ? `${task.runtime.percent.source}${task.runtime.readWindowMs?.available ? `；窗口 ${task.runtime.readWindowMs.value} ms` : ''}`
                                  : task.runtime.percent.reason}
                              >
                                {task.runtime.percent.available ? `${task.runtime.percent.value.toFixed(2)}%` : '—'}
                              </span>
                              <span className="rtos-muted rtos-mono rtos-cpu-cnt" title={task.runtime.counter.available ? task.runtime.counter.source : task.runtime.counter.reason}>
                                {task.runtime.counter.available ? task.runtime.counter.value : '无计数'}
                              </span>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* 任务详情侧栏 */}
            {selectedTask && (
              <aside className="rtos-detail-pane" aria-label="任务详情">
                <div className="rtos-detail-header">
                  <strong>{selectedTask.name.available ? selectedTask.name.value : formatHex32(selectedTask.tcbAddress)}</strong>
                  <button type="button" className="rtos-mini-btn" onClick={() => updateSettings({ selectedTaskAddress: null })}>关闭</button>
                </div>
                <div className="rtos-detail-grid">
                  <DetailItem label="TCB 地址" value={formatHex32(selectedTask.tcbAddress)} />
                  <DetailItem
                    label="创建编号"
                    value={selectedTask.creationNumber.available ? `#${selectedTask.creationNumber.value}` : `不可用 (${selectedTask.creationNumber.reason})`}
                  />
                  <DetailItem label="状态 / 当前" value={`${STATE_LABELS[selectedTask.state]}${selectedTask.current ? '（当前运行任务）' : ''}`} />
                  <DetailItem
                    label="列表证据"
                    value={`${selectedTask.lists.join(', ') || '—'} · ${selectedTask.listEvidence === 'traversed' ? '链表遍历' : 'TCB 单独校验'}`}
                  />
                  <DetailItem label="栈起点 / 终点" value={`${formatFieldValue(selectedTask.stack.base, formatHex32)} .. ${formatFieldValue(selectedTask.stack.end, formatHex32)}`} />
                  <DetailItem
                    label="栈容量 / 未用峰值"
                    value={`${formatFieldValue(selectedTask.stack.capacityBytes, v => `${v} B`)} / ${selectedTask.stack.watermarkBytes.available ? `${selectedTask.stack.watermarkBytes.value} B` : `未获取 (${selectedTask.stack.watermarkBytes.reason})`}`}
                  />
                  <DetailItem
                    label="栈扫描详情"
                    value={`方向=${formatFieldValue(selectedTask.stack.growthDirection)} · 填充=${formatFieldValue(selectedTask.stack.fillByte, v => `0x${v.toString(16).toUpperCase()}`)} · 已扫 ${selectedTask.stack.scannedBytes} B (${selectedTask.stack.scanComplete ? '完整' : '受限/未扫'}, ${selectedTask.stack.scanMs} ms)`}
                  />
                  <DetailItem
                    label="运行计数"
                    value={selectedTask.runtime.counter.available
                      ? `${selectedTask.runtime.counter.value} (${formatFieldValue(selectedTask.runtime.bits, v => `${v} bit`)})`
                      : `不可用 (${selectedTask.runtime.counter.reason})`}
                  />
                  <DetailItem
                    label="CPU% 与窗口"
                    value={selectedTask.runtime.percent.available
                      ? `${selectedTask.runtime.percent.value.toFixed(2)}% · 间隔 ${formatFieldValue(selectedTask.runtime.intervalMs, v => `${v.toFixed(1)} ms`)} · 双帧窗口 ${selectedTask.runtime.readWindowMs?.available ? `${selectedTask.runtime.readWindowMs.value} ms` : '—'}`
                      : `不可用 (${selectedTask.runtime.percent.reason})`}
                  />
                  {selectedTask.runtime.percent.available && (
                    <DetailItem label="统计口径" value={selectedTask.runtime.percent.source} />
                  )}
                  {(selectedTaskHolds.length > 0 || selectedTaskWaits.length > 0) && (
                    <div className="rtos-detail-item">
                      <span className="rtos-detail-label">对象等待 / 持有</span>
                      <span className="rtos-detail-value">
                        {selectedTaskHolds.map(obj => (
                          <div key={`hold-${obj.address}`} className="rtos-waiter-row">
                            <span>持有 {objectKindLabel(obj.kind)}:</span>
                            <button
                              type="button"
                              className="rtos-link-btn"
                              onClick={() => updateSettings({ tasksSubTab: 'objects', selectedObjectAddress: obj.address })}
                            >
                              {obj.name.available ? obj.name.value : (obj.symbolName || formatHex32(obj.address))}
                            </button>
                          </div>
                        ))}
                        {selectedTaskWaits.map((edge, idx) => (
                          <div key={`wait-${edge.objectAddress}-${idx}`} className="rtos-waiter-row">
                            <span>等待 ({edge.direction === 'receive' ? '获取' : '发送'}):</span>
                            <button
                              type="button"
                              className="rtos-link-btn"
                              onClick={() => updateSettings({ tasksSubTab: 'objects', selectedObjectAddress: edge.objectAddress })}
                            >
                              {edge.objectName || formatHex32(edge.objectAddress)}
                            </button>
                          </div>
                        ))}
                      </span>
                    </div>
                  )}
                </div>
                {caps?.stackWatermark.available && (
                  <button
                    type="button"
                    className="rtos-btn"
                    disabled={panel.loading.stackScan}
                    onClick={() => vscodeApi.postMessage({ command: 'scanStack', taskAddresses: [selectedTask.tcbAddress] })}
                  >
                    {panel.loading.stackScan ? '正在扫描栈…' : '扫描该任务栈水位'}
                  </button>
                )}
              </aside>
            )}
              </div>
            )}
          </div>
        )}

        {/* 诊断折叠区 */}
        {settings.showDiagnostics && (
          <section className="rtos-diagnostics" aria-label="快照诊断信息">
            {snapshot ? (
              <div className="rtos-diag-grid">
                <div><strong>一致性：</strong>{snapshot.consistency}{snapshot.reason ? ` (${snapshot.reason})` : ''}</div>
                <div><strong>内核来源：</strong>{snapshot.kernel.source}</div>
                <div><strong>会话/代次：</strong>{snapshot.sessionId.slice(0, 8)} · seg={snapshot.sessionGeneration} · boot={snapshot.bootGeneration} · op={snapshot.operationGeneration}</div>
                <div><strong>ELF / Layout：</strong>{snapshot.elfSha256.slice(0, 12)} / {snapshot.layoutId.slice(0, 12)}</div>
                <div><strong>读取统计：</strong>{snapshot.diagnostics.rounds} 轮 / {snapshot.diagnostics.batches} 批 / {snapshot.diagnostics.nodes} 节点 / {snapshot.diagnostics.bytes} B</div>
                {snapshot.diagnostics.detailBudget && (
                  <div>
                    <strong>详情预算：</strong>
                    {snapshot.diagnostics.detailBudget.usedBytes} / {snapshot.diagnostics.detailBudget.limitBytes} B
                    {snapshot.diagnostics.detailBudget.exhausted ? '（已达上限）' : ''}
                    （栈 {snapshot.diagnostics.detailBudget.stackBytes} / 对象 {snapshot.diagnostics.detailBudget.objectBytes} / 定时器 {snapshot.diagnostics.detailBudget.timerBytes} / 堆 {snapshot.diagnostics.detailBudget.heapBytes}）
                  </div>
                )}
                <div><strong>覆盖列表：</strong>{snapshot.diagnostics.coveredLists.join(', ') || '—'}</div>
                <div><strong>问题清单：</strong>{snapshot.issues.length ? snapshot.issues.map(i => `${i.errorCode}(${i.completion}): ${i.message}`).join(' | ') : '无'}</div>
              </div>
            ) : (
              <div className="rtos-muted">暂无快照诊断记录。</div>
            )}
          </section>
        )}
      </main>
    </div>
  );
}

function CapabilityChip({ label, cap }: { label: string; cap: { available: boolean; reason?: string } }) {
  return (
    <span
      className={`rtos-cap${cap.available ? ' ok' : ' off'}`}
      title={cap.available ? `${label}：可用` : `${label}：不可用（${cap.reason || '缺少前置条件'}）`}
    >
      {cap.available ? '✓' : '−'} {label}
    </span>
  );
}

function SortHeader({
  label,
  sortKey,
  settings,
  onSort,
}: {
  label: string;
  sortKey: RtosTaskSortKey;
  settings: RtosViewSettings;
  onSort: (key: RtosTaskSortKey) => void;
}) {
  const active = settings.sortBy === sortKey;
  const arrow = active ? (settings.sortDir === 'asc' ? ' ▲' : ' ▼') : '';
  return (
    <th aria-sort={active ? (settings.sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className="rtos-sort-btn" onClick={() => onSort(sortKey)}>
        {label}{arrow}
      </button>
    </th>
  );
}

function DetailItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="rtos-detail-item">
      <span className="rtos-detail-label">{label}</span>
      <span className="rtos-detail-value">{value}</span>
    </div>
  );
}

const STYLES = `
.rtos-root { display:flex; flex-direction:column; height:100%; min-height:0; background:var(--vscode-panel-background, var(--vscode-editor-background)); color:var(--vscode-foreground); }
.rtos-root button, .rtos-root input, .rtos-root select { font-family:inherit; font-size:12px; }
.rtos-root button:focus-visible, .rtos-root input:focus-visible, .rtos-root select:focus-visible, .rtos-row:focus-visible { outline:1px solid var(--vscode-focusBorder, #007fd4); outline-offset:-1px; }
.rtos-toolbar { display:flex; flex-wrap:nowrap; align-items:center; justify-content:space-between; gap:8px; padding:6px 10px; min-height:36px; border-bottom:1px solid var(--vscode-panel-border, var(--vscode-sideBar-border)); background:var(--vscode-editorWidget-background, var(--vscode-panel-background)); flex-shrink:0; overflow-x:auto; scrollbar-width:none; }
.rtos-toolbar-group { display:flex; flex-wrap:nowrap; align-items:center; gap:6px; flex-shrink:0; }
.rtos-pill { display:inline-flex; align-items:center; gap:5px; padding:2px 8px; border-radius:10px; font-size:11px; border:1px solid var(--vscode-panel-border, transparent); background:var(--vscode-badge-background); color:var(--vscode-badge-foreground); white-space:nowrap; }
.rtos-dot { width:7px; height:7px; border-radius:50%; background:var(--vscode-descriptionForeground); }
.rtos-dot-connected { background:var(--vscode-charts-green, #4ec9b0); }
.rtos-dot-starting { background:var(--vscode-charts-yellow, #cca700); }
.rtos-dot-terminating { background:var(--vscode-charts-red, #f48771); }
.rtos-tone-ok { border-color:var(--vscode-charts-green, #4ec9b0); }
.rtos-tone-info { border-color:var(--vscode-charts-blue, #3794ff); }
.rtos-tone-warn { border-color:var(--vscode-charts-yellow, #cca700); color:var(--vscode-editorWarning-foreground, inherit); }
.rtos-tone-error { border-color:var(--vscode-errorForeground, #f48771); color:var(--vscode-errorForeground, #f48771); }
.rtos-subtabs { display:flex; align-items:center; gap:2px; flex-shrink:0; }
.rtos-subtab { border:0; border-bottom:2px solid transparent; background:transparent; color:var(--vscode-descriptionForeground); padding:4px 8px; cursor:pointer; white-space:nowrap; }
.rtos-subtab.active { color:var(--vscode-foreground); border-bottom-color:var(--vscode-focusBorder, #007fd4); font-weight:600; }
.rtos-subtab:hover { color:var(--vscode-foreground); background:var(--vscode-list-hoverBackground); }
.rtos-btn { border:1px solid var(--vscode-button-border, transparent); border-radius:3px; padding:3px 9px; background:var(--vscode-button-background); color:var(--vscode-button-foreground); cursor:pointer; white-space:nowrap; }
.rtos-btn-action { box-sizing:border-box; width:54px; min-width:54px; text-align:center; }
.rtos-btn-scan { box-sizing:border-box; width:88px; min-width:88px; text-align:center; }
.rtos-btn:hover:not(:disabled) { background:var(--vscode-button-hoverBackground); }
.rtos-btn:disabled { opacity:.45; cursor:default; }
.rtos-btn-secondary { background:var(--vscode-button-secondaryBackground); color:var(--vscode-button-secondaryForeground); }
.rtos-btn-secondary:hover:not(:disabled) { background:var(--vscode-button-secondaryHoverBackground); }
.rtos-btn-secondary.active { border-color:var(--vscode-focusBorder, #007fd4); }
.rtos-live-toggle { display:inline-flex; align-items:center; gap:4px; cursor:pointer; user-select:none; white-space:nowrap; }
.rtos-live-dot { font-size:10px; line-height:1; opacity:.25; transition:opacity .12s; }
.rtos-live-dot.active { opacity:1; color:var(--vscode-charts-green, #4ec9b0); }
.rtos-select, .rtos-search { border:1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius:3px; padding:2px 6px; background:var(--vscode-input-background); color:var(--vscode-input-foreground); }
.rtos-status-strip { display:flex; flex-direction:column; gap:4px; padding:5px 10px; border-bottom:1px solid var(--vscode-panel-border); font-size:11px; color:var(--vscode-descriptionForeground); flex-shrink:0; }
.rtos-caps { display:flex; flex-wrap:nowrap; align-items:center; gap:6px; min-height:20px; overflow-x:auto; scrollbar-width:none; white-space:nowrap; }
.rtos-cap { padding:1px 6px; border-radius:3px; border:1px solid var(--vscode-panel-border); flex-shrink:0; }
.rtos-cap.ok { color:var(--vscode-foreground); }
.rtos-cap.off { opacity:.65; }
.rtos-timing { display:flex; flex-wrap:nowrap; gap:10px; align-items:center; min-height:20px; height:20px; overflow:hidden; white-space:nowrap; font-variant-numeric:tabular-nums; }
.rtos-timing-item { flex-shrink:0; white-space:nowrap; }
.rtos-inline-warn { flex:1 1 0; min-width:0; color:var(--vscode-editorWarning-foreground, var(--vscode-errorForeground)); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.rtos-main { flex:1; min-height:0; display:flex; flex-direction:column; }
.rtos-workspace { flex:1; min-height:0; display:flex; overflow:hidden; }
.rtos-table-pane { flex:1; min-width:0; min-height:0; display:flex; flex-direction:column; }
.rtos-filter-bar { display:flex; flex-wrap:nowrap; align-items:center; gap:8px; padding:6px 10px; min-height:33px; border-bottom:1px solid var(--vscode-panel-border); flex-shrink:0; overflow-x:auto; scrollbar-width:none; }
.rtos-search { min-width:160px; flex:1 1 180px; max-width:300px; }
.rtos-filter-chips { display:flex; flex-wrap:nowrap; gap:4px; flex-shrink:0; }
.rtos-chip { border:1px solid var(--vscode-panel-border); border-radius:10px; padding:2px 8px; background:transparent; color:var(--vscode-foreground); cursor:pointer; font-size:11px; white-space:nowrap; flex-shrink:0; }
.rtos-chip.active { background:var(--vscode-button-background); color:var(--vscode-button-foreground); border-color:var(--vscode-button-background); }
.rtos-count { margin-left:auto; color:var(--vscode-descriptionForeground); font-size:11px; white-space:nowrap; flex-shrink:0; font-variant-numeric:tabular-nums; }
.rtos-table-scroll { flex:1; min-height:0; overflow:auto; }
.rtos-table { width:100%; border-collapse:collapse; table-layout:auto; font-size:12px; font-variant-numeric:tabular-nums; }
.rtos-tasks-table { table-layout:fixed; min-width:940px; }
.rtos-tasks-table th, .rtos-tasks-table td { box-sizing:border-box; }
.rtos-col-state { width:112px; }
.rtos-col-name { width:auto; }
.rtos-col-tcb { width:116px; }
.rtos-col-prio { width:88px; }
.rtos-col-stack { width:auto; }
.rtos-col-cpu { width:auto; }
.rtos-cell-ellipsis { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.rtos-table th { position:sticky; top:0; z-index:1; text-align:left; font-weight:600; padding:5px 8px; background:var(--vscode-editorWidget-background, var(--vscode-panel-background)); border-bottom:1px solid var(--vscode-panel-border); white-space:nowrap; }
.rtos-sort-btn { border:0; background:transparent; color:inherit; font:inherit; font-weight:600; cursor:pointer; padding:0; }
.rtos-table td { padding:4px 8px; border-bottom:1px solid var(--vscode-panel-border); vertical-align:middle; }
.rtos-row { cursor:pointer; }
.rtos-row:hover { background:var(--vscode-list-hoverBackground); }
.rtos-row.selected { background:var(--vscode-list-activeSelectionBackground); color:var(--vscode-list-activeSelectionForeground); }
.rtos-table-empty { text-align:center; padding:24px !important; color:var(--vscode-descriptionForeground); }
.rtos-mono { font-family:var(--vscode-editor-font-family, monospace); font-variant-numeric:tabular-nums; }
.rtos-muted { color:var(--vscode-descriptionForeground); }
.rtos-state-badge { display:inline-block; min-width:84px; text-align:center; padding:1px 6px; border-radius:3px; font-size:11px; font-weight:600; white-space:nowrap; border:1px solid var(--vscode-panel-border); }
.rtos-tasks-table .rtos-state-badge { box-sizing:border-box; width:92px; min-width:92px; }
.rtos-state-running { border-color:var(--vscode-charts-green, #4ec9b0); color:var(--vscode-charts-green, #4ec9b0); }
.rtos-state-ready { border-color:var(--vscode-charts-blue, #3794ff); }
.rtos-state-blocked { border-color:var(--vscode-charts-yellow, #cca700); }
.rtos-state-suspended, .rtos-state-termination, .rtos-state-unknown { opacity:.8; }
.rtos-row.selected .rtos-state-badge { color:inherit; border-color:currentColor; }
.rtos-task-name { display:flex; align-items:center; gap:6px; min-width:110px; }
.rtos-tasks-table .rtos-task-name { min-width:0; }
.rtos-task-name-text { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; }
.rtos-task-id { font-size:11px; color:var(--vscode-descriptionForeground); flex-shrink:0; white-space:nowrap; }
.rtos-row.selected .rtos-task-id, .rtos-row.selected .rtos-muted { color:inherit; opacity:.85; }
.rtos-list-cell, .rtos-stack-cell, .rtos-cpu-cell { display:flex; align-items:center; gap:6px; white-space:nowrap; min-width:0; }
.rtos-evidence { font-size:10px; min-width:48px; text-align:center; padding:0 5px; border-radius:3px; border:1px solid var(--vscode-panel-border); }
.rtos-evidence-validated-tcb { border-color:var(--vscode-charts-yellow, #cca700); }
.rtos-stack-text { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; }
.rtos-cpu-pct { display:inline-block; width:56px; text-align:right; flex-shrink:0; }
.rtos-cpu-cnt { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; }
.rtos-bar { display:inline-block; width:48px; height:6px; border-radius:3px; background:var(--vscode-progressBar-background, rgba(127,127,127,.25)); background:color-mix(in srgb, var(--vscode-foreground) 15%, transparent); overflow:hidden; flex-shrink:0; }
.rtos-bar-fill { display:block; height:100%; background:var(--vscode-charts-blue, #3794ff); }
.rtos-bar-fill.warn { background:var(--vscode-charts-red, #f48771); }
.rtos-mini-btn { border:1px solid var(--vscode-panel-border); border-radius:3px; padding:1px 6px; background:transparent; color:inherit; cursor:pointer; font-size:11px; white-space:nowrap; flex-shrink:0; }
.rtos-mini-btn:hover:not(:disabled) { background:var(--vscode-list-hoverBackground); }
.rtos-mini-btn:disabled { opacity:.45; cursor:default; }
.rtos-detail-pane { width:310px; max-width:42%; border-left:1px solid var(--vscode-panel-border); padding:10px; overflow:auto; display:flex; flex-direction:column; gap:10px; background:var(--vscode-sideBar-background, var(--vscode-panel-background)); flex-shrink:0; }
.rtos-detail-header { display:flex; align-items:center; justify-content:space-between; gap:8px; }
.rtos-detail-grid { display:flex; flex-direction:column; gap:6px; }
.rtos-detail-item { display:flex; flex-direction:column; gap:2px; border-bottom:1px solid var(--vscode-panel-border); padding-bottom:4px; }
.rtos-detail-label { font-size:11px; color:var(--vscode-descriptionForeground); }
.rtos-detail-value { font-size:12px; word-break:break-word; }
.rtos-empty { padding:24px; max-width:680px; margin:auto; text-align:left; line-height:1.6; }
.rtos-empty h3 { margin:0 0 8px; font-size:14px; }
.rtos-empty p { margin:4px 0; }
.rtos-empty ul { margin:8px 0 12px; padding-left:18px; }
.rtos-empty-error h3 { color:var(--vscode-errorForeground, #f48771); }
.rtos-diagnostics { border-top:1px solid var(--vscode-panel-border); padding:8px 10px; font-size:11px; background:var(--vscode-editorWidget-background, var(--vscode-panel-background)); height:88px; min-height:88px; max-height:88px; overflow:auto; flex-shrink:0; }
.rtos-diag-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(240px, 1fr)); gap:4px 12px; }
.rtos-subview-shell { flex:1; min-height:0; display:flex; flex-direction:column; overflow:hidden; }
.rtos-sub-bar { display:flex; flex-wrap:nowrap; align-items:center; gap:6px; padding:5px 10px; min-height:30px; border-bottom:1px solid var(--vscode-panel-border); background:var(--vscode-editorWidget-background, var(--vscode-panel-background)); flex-shrink:0; overflow-x:auto; scrollbar-width:none; }
.rtos-coverage-bar { display:flex; flex-wrap:nowrap; align-items:center; justify-content:space-between; gap:8px; padding:4px 10px; min-height:24px; border-bottom:1px solid var(--vscode-panel-border); font-size:11px; color:var(--vscode-descriptionForeground); flex-shrink:0; overflow:hidden; white-space:nowrap; }
.rtos-coverage-bar > span:first-child { flex:1 1 0; min-width:0; overflow:hidden; text-overflow:ellipsis; }
.rtos-cycle-banner { padding:6px 10px; max-height:84px; overflow:auto; border-bottom:1px solid var(--vscode-charts-yellow, #cca700); background:color-mix(in srgb, var(--vscode-charts-yellow, #cca700) 12%, transparent); font-size:11px; flex-shrink:0; display:flex; flex-direction:column; gap:4px; }
.rtos-cycle-item { display:flex; flex-direction:column; gap:2px; }
.rtos-unresolved-bar { padding:4px 10px; max-height:72px; overflow:auto; border-bottom:1px solid var(--vscode-panel-border); font-size:11px; color:var(--vscode-editorWarning-foreground, var(--vscode-descriptionForeground)); flex-shrink:0; }
.rtos-source-chips { display:flex; flex-wrap:wrap; gap:4px; }
.rtos-link-btn { border:0; padding:0; background:transparent; color:var(--vscode-textLink-foreground, #3794ff); cursor:pointer; font:inherit; text-decoration:underline; }
.rtos-link-btn:hover { color:var(--vscode-textLink-activeForeground, #4fc1ff); }
.rtos-waiter-row { display:flex; flex-wrap:wrap; align-items:center; gap:6px; }
.rtos-heap-card { display:flex; flex-direction:column; gap:6px; padding:8px 10px; border-bottom:1px solid var(--vscode-panel-border); background:var(--vscode-sideBar-background, var(--vscode-panel-background)); flex-shrink:0; }
.rtos-heap-header { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:8px; }
.rtos-heap-metrics { display:grid; grid-template-columns:repeat(auto-fit, minmax(170px, 1fr)); gap:8px 12px; }
.rtos-heap-stat { display:flex; flex-direction:column; gap:1px; }
.rtos-heap-bar-wrap { display:flex; align-items:center; gap:8px; }
.rtos-heap-bar { width:100%; max-width:360px; height:7px; }
.trace-shell { flex:1; min-height:0; display:flex; flex-direction:column; overflow:hidden; }
.trace-controls-bar { justify-content:space-between; }
.trace-nav-bar { gap:6px; }
.trace-btn-group { display:flex; align-items:center; gap:5px; flex-shrink:0; }
.trace-record-select { max-width:260px; }
.trace-status-banner { display:flex; flex-wrap:nowrap; align-items:center; gap:8px; padding:4px 10px; min-height:24px; border-bottom:1px solid var(--vscode-panel-border); font-size:11px; overflow-x:auto; scrollbar-width:none; flex-shrink:0; white-space:nowrap; }
.trace-stat-text { color:var(--vscode-descriptionForeground); flex-shrink:0; }
.trace-action-msg { padding:1px 6px; border-radius:3px; border:1px solid var(--vscode-panel-border); flex-shrink:0; }
.trace-viewport-body { flex:1; min-height:0; display:flex; align-items:flex-start; overflow-y:auto; overflow-x:hidden; position:relative; }
.trace-lane-headers { flex-shrink:0; border-right:1px solid var(--vscode-panel-border); background:var(--vscode-sideBar-background, var(--vscode-panel-background)); user-select:none; }
.trace-ruler-corner { display:flex; align-items:center; padding:0 8px; font-size:10px; color:var(--vscode-descriptionForeground); border-bottom:1px solid var(--vscode-panel-border); font-family:var(--vscode-editor-font-family, monospace); }
.trace-lane-header { display:flex; flex-direction:column; justify-content:center; padding:0 8px; border-bottom:1px solid var(--vscode-panel-border); overflow:hidden; }
.trace-lane-title { font-size:11px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.trace-lane-sub { font-size:10px; color:var(--vscode-descriptionForeground); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.trace-canvas-wrap { flex:1; min-width:0; min-height:100%; position:relative; }
.trace-canvas { display:block; cursor:crosshair; touch-action:none; }
.trace-dense-hud { position:sticky; top:28px; float:right; margin:4px 8px 0 0; padding:2px 8px; border-radius:3px; font-size:10px; background:var(--vscode-editorHoverWidget-background, #252526); color:var(--vscode-editorHoverWidget-foreground, #cccccc); border:1px solid var(--vscode-panel-border); pointer-events:none; }
.trace-inspector-bar { border-top:1px solid var(--vscode-panel-border); background:var(--vscode-editorWidget-background, var(--vscode-panel-background)); padding:5px 10px; height:84px; min-height:84px; max-height:84px; overflow:auto; flex-shrink:0; display:flex; flex-direction:column; gap:3px; font-size:11px; }
.trace-cursor-summary { display:flex; flex-wrap:wrap; gap:4px 14px; align-items:center; }
.trace-cursor-row { display:flex; align-items:center; gap:5px; }
.trace-tag { display:inline-block; min-width:16px; text-align:center; border-radius:3px; font-size:10px; font-weight:700; padding:0 4px; color:#000; }
.trace-tag-a { background:var(--vscode-charts-yellow, #FFD166); }
.trace-tag-b { background:var(--vscode-charts-blue, #79C0FF); }
.trace-tag-dt { background:var(--vscode-charts-green, #4EC9B0); }
.trace-hover-detail { color:var(--vscode-foreground); line-height:1.35; }
.contexts-warn-bar { display:flex; flex-direction:column; gap:2px; padding:4px 10px; border-bottom:1px solid var(--vscode-panel-border); background:color-mix(in srgb, var(--vscode-charts-yellow, #cca700) 8%, transparent); font-size:11px; flex-shrink:0; max-height:76px; overflow:auto; }
.contexts-cpuload-card { display:flex; flex-direction:column; gap:4px; padding:6px 10px; border-bottom:1px solid var(--vscode-panel-border); background:var(--vscode-sideBar-background, var(--vscode-panel-background)); flex-shrink:0; }
.contexts-cpuload-header { display:flex; flex-wrap:nowrap; align-items:center; justify-content:space-between; gap:10px; height:18px; min-height:18px; line-height:18px; font-size:11px; overflow:hidden; }
.contexts-legend { display:inline-flex; flex-wrap:nowrap; align-items:center; gap:8px; flex-shrink:0; white-space:nowrap; }
.contexts-dot-lbl { display:inline-flex; align-items:center; gap:4px; color:var(--vscode-descriptionForeground); }
.contexts-swatch { display:inline-block; width:9px; height:9px; border-radius:2px; }
.contexts-swatch.sw-task { background:#3794FF; }
.contexts-swatch.sw-isr { background:#F48771; }
.contexts-swatch.sw-sched { background:#C586C0; }
.contexts-swatch.sw-idle { background:rgba(148,163,184,0.45); }
.contexts-swatch.sw-unknown { background:rgba(204,167,0,0.45); }
.contexts-bin-hover { flex:1 1 0; min-width:0; text-align:right; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-variant-numeric:tabular-nums; }
.contexts-canvas-wrap { width:100%; height:112px; overflow:hidden; }
.contexts-cpuload-canvas { display:block; cursor:pointer; }
.contexts-kind-isr { border-color:var(--vscode-charts-red, #f48771); color:var(--vscode-charts-red, #f48771); }
.contexts-kind-task { border-color:var(--vscode-charts-blue, #3794ff); }
.contexts-kind-idle { opacity:.75; }
.contexts-kind-scheduler { border-color:var(--vscode-charts-purple, #c586c0); }
.contexts-kind-timer { border-color:var(--vscode-charts-green, #4ec9b0); }
.rtos-inline-error { color:var(--vscode-errorForeground, #f48771); font-size:11px; }
.events-shell { flex:1; min-height:0; display:flex; flex-direction:column; overflow:hidden; }
.events-filter-bar { gap:6px; }
.events-meta-bar { justify-content:space-between; }
.events-jump-input { width:84px; min-width:72px; flex:0 0 auto; }
.events-workspace { flex:1; min-height:0; display:flex; overflow:hidden; }
.events-table-wrap { flex:1; min-width:0; display:flex; flex-direction:column; overflow:hidden; }
.events-thead { display:grid; grid-template-columns:64px 128px 64px 126px 150px minmax(180px, 1fr) 74px; gap:6px; padding:4px 8px; border-bottom:1px solid var(--vscode-panel-border); background:var(--vscode-editorWidget-background, var(--vscode-panel-background)); font-size:11px; font-weight:600; color:var(--vscode-descriptionForeground); flex-shrink:0; }
.events-vscroll { flex:1; min-height:0; overflow-y:auto; overflow-x:auto; position:relative; }
.events-vspacer { position:relative; width:100%; }
.events-vwindow { position:absolute; top:0; left:0; right:0; will-change:transform; }
.events-vrow { display:grid; grid-template-columns:64px 128px 64px 126px 150px minmax(180px, 1fr) 74px; gap:6px; align-items:center; height:26px; padding:0 8px; border-bottom:1px solid color-mix(in srgb, var(--vscode-panel-border) 55%, transparent); cursor:pointer; font-size:11px; }
.events-vrow:hover { background:var(--vscode-list-hoverBackground); }
.events-vrow.selected { background:var(--vscode-list-activeSelectionBackground); color:var(--vscode-list-activeSelectionForeground); }
.events-vrow.has-warn { border-left:2px solid var(--vscode-charts-yellow, #cca700); padding-left:6px; }
.events-vrow > span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ev-domain-tag { font-style:normal; font-size:9px; opacity:.75; }
.ev-rel-pill { margin-left:4px; padding:0 4px; border-radius:2px; font-size:9px; border:1px solid var(--vscode-charts-yellow, #cca700); color:var(--vscode-charts-yellow, #cca700); }
.events-detail-pane { width:340px; min-width:260px; max-width:44%; border-left:1px solid var(--vscode-panel-border); padding:8px 10px; overflow:auto; background:var(--vscode-sideBar-background, var(--vscode-panel-background)); flex-shrink:0; }
.events-detail-content { display:flex; flex-direction:column; gap:8px; }
.events-detail-header { display:flex; align-items:center; justify-content:space-between; gap:6px; flex-wrap:wrap; }
.events-detail-section { border-top:1px solid var(--vscode-panel-border); padding-top:6px; display:flex; flex-direction:column; gap:4px; }
.events-detail-subtitle { font-size:11px; font-weight:600; color:var(--vscode-foreground); }
.events-terminal-preview { padding:4px 6px; border-radius:3px; border:1px solid var(--vscode-panel-border); background:var(--vscode-editor-background, var(--vscode-panel-background)); white-space:pre-wrap; word-break:break-word; }
.terminal-shell { flex:1; min-height:0; display:flex; flex-direction:column; overflow:hidden; }
.terminal-body { flex:1; min-height:0; display:flex; overflow:hidden; }
.terminal-log-list { flex:1; min-width:0; overflow:auto; padding:6px 10px; display:flex; flex-direction:column; gap:6px; }
.terminal-line { border:1px solid var(--vscode-panel-border); border-radius:3px; padding:5px 8px; background:var(--vscode-editor-background, var(--vscode-panel-background)); display:flex; flex-direction:column; gap:3px; }
.terminal-line.term-lvl-warn { border-left:3px solid var(--vscode-charts-yellow, #cca700); }
.terminal-line.term-lvl-error { border-left:3px solid var(--vscode-charts-red, #f48771); }
.terminal-line-meta { display:flex; flex-wrap:wrap; align-items:center; gap:6px; font-size:10px; }
.term-actions { margin-left:auto; display:inline-flex; gap:4px; }
.terminal-line-text { margin:0; font-family:var(--vscode-editor-font-family, monospace); font-size:12px; white-space:pre-wrap; word-break:break-word; }
.terminal-line-warnings { display:flex; flex-direction:column; gap:2px; font-size:10px; }
.terminal-diag-pane { width:340px; min-width:260px; max-width:44%; border-left:1px solid var(--vscode-panel-border); padding:8px 10px; overflow:auto; background:var(--vscode-sideBar-background, var(--vscode-panel-background)); flex-shrink:0; display:flex; flex-direction:column; gap:6px; }
.terminal-diag-list { display:flex; flex-direction:column; gap:4px; font-size:11px; }
.terminal-diag-item { padding:3px 5px; border-radius:2px; border:1px solid color-mix(in srgb, var(--vscode-panel-border) 70%, transparent); word-break:break-word; }
`;
