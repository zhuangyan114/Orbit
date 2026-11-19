import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TraceTerminalLevelFilter, TraceTerminalLineDto } from '../../trace/trace-events';
import {
  formatTraceTimestamp,
  type TraceAnalysisSourceKind,
  type TraceAxisDomain,
  type TraceDiagnosticsResponse,
  type TraceRecordSummary,
  type TraceTerminalResponse,
  type TraceTimeUnit,
} from './trace-timeline-state';

export interface TerminalViewProps {
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
  terminalResult: TraceTerminalResponse | null;
  diagnosticsResult: TraceDiagnosticsResponse | null;
  onQueryTerminal: (req: {
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
  }) => void;
  onGetDiagnostics: (req: {
    recordId: string;
    bootGeneration?: number;
    segmentId?: number;
  }) => void;
  onLocateLineInEvents: (line: TraceTerminalLineDto) => void;
  onJumpLineToTimeline: (line: TraceTerminalLineDto) => void;
  onPerfReport?: (perf: Record<string, unknown>) => void;
}

export interface TerminalQueryProvenance {
  readonly recordId: string | null;
  readonly unit: TraceTimeUnit;
  readonly scopeKey: string;
  readonly sourceKind: TraceAnalysisSourceKind;
  readonly start: string;
  readonly end: string;
  readonly level: TraceTerminalLevelFilter;
  readonly searchText: string;
  readonly mergeAppend: boolean;
}

export function doesTerminalResponseMatchProvenance(
  resp: TraceTerminalResponse | null,
  expected: TerminalQueryProvenance,
): boolean {
  if (!resp || !expected.recordId || resp.recordId !== expected.recordId) return false;
  if (resp.unit !== expected.unit) return false;
  if (resp.scopeKey !== expected.scopeKey) return false;
  if (resp.sourceKind !== expected.sourceKind) return false;
  if (resp.level !== expected.level) return false;
  if (resp.searchText !== expected.searchText) return false;
  if (Boolean(resp.mergeAppend) !== expected.mergeAppend) return false;
  if (resp.result && (resp.result.start !== expected.start || resp.result.end !== expected.end)) {
    return false;
  }
  return true;
}

const TERMINAL_PAGE_LIMIT = 200;
let nextTerminalQuerySeq = 1;

function formatSourceBadge(line: TraceTerminalLineDto): { label: string; tone: string } {
  if (line.formatSource === 'packet-inline') {
    return { label: 'inline', tone: 'rtos-tone-ok' };
  }
  if (line.formatSource === 'elf-rodata') {
    return { label: `ELF .rodata @${line.stringAddressHex ?? ''}`, tone: 'rtos-tone-ok' };
  }
  return {
    label: `地址不可解析 @${line.stringAddressHex ?? '0x?'} (${line.addressStatus ?? 'unresolved'})`,
    tone: 'rtos-tone-error',
  };
}

export function TerminalView(props: TerminalViewProps) {
  const {
    visible,
    selectedRecord,
    axisDomain,
    resolvedRange,
    rangeSource,
    terminalResult,
    diagnosticsResult,
    onQueryTerminal,
    onGetDiagnostics,
    onLocateLineInEvents,
    onJumpLineToTimeline,
    onPerfReport,
  } = props;

  const [level, setLevel] = useState<TraceTerminalLevelFilter>('all');
  const [searchText, setSearchText] = useState('');
  const [mergeAppend, setMergeAppend] = useState(true);
  const [offset, setOffset] = useState(0);
  const [showDiagnosticsDrawer, setShowDiagnosticsDrawer] = useState(true);

  const queryDebounceRef = useRef<number | null>(null);
  const lastDispatchedSeqRef = useRef(0);
  const minValidSeqRef = useRef(0);
  const appliedTermKeyRef = useRef('');
  const onQueryTerminalRef = useRef(onQueryTerminal);
  onQueryTerminalRef.current = onQueryTerminal;
  const onGetDiagnosticsRef = useRef(onGetDiagnostics);
  onGetDiagnosticsRef.current = onGetDiagnostics;
  const onPerfReportRef = useRef(onPerfReport);
  onPerfReportRef.current = onPerfReport;
  const perfRef = useRef({
    queriesSent: 0,
    repliesApplied: 0,
    droppedStaleReplies: 0,
    diagRequestsSent: 0,
    lastQueryMs: 0,
    lastTotalLines: 0,
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

  const currentProvenance = useMemo<TerminalQueryProvenance>(() => ({
    recordId: activeRecordId,
    unit: activeUnit,
    scopeKey: axisDomain.scopeKey,
    sourceKind: rangeSource,
    start: resolvedRange.start ?? '',
    end: expectedQueryEnd,
    level,
    searchText,
    mergeAppend: Boolean(mergeAppend),
  }), [
    activeRecordId,
    activeUnit,
    axisDomain.scopeKey,
    rangeSource,
    resolvedRange.start,
    expectedQueryEnd,
    level,
    searchText,
    mergeAppend,
  ]);

  // Reset pagination and invalidate pre-change in-flight queries when filter/range changes
  const filterKey = `${activeRecordId ?? ''}::${axisDomain.scopeKey}::${activeUnit}::${resolvedRange.start ?? ''}::${expectedQueryEnd}::${rangeSource}::${level}::${searchText}::${mergeAppend}`;
  const prevFilterKeyRef = useRef('');
  useEffect(() => {
    if (prevFilterKeyRef.current !== filterKey) {
      prevFilterKeyRef.current = filterKey;
      minValidSeqRef.current = nextTerminalQuerySeq;
      setOffset(0);
    }
  }, [filterKey]);

  const dispatchTerminalQuery = useCallback((targetOffset: number) => {
    if (!visible || !activeRecordId || !axisDomain.valid || !resolvedRange.valid || !resolvedRange.start || !expectedQueryEnd) {
      return;
    }
    const run = () => {
      const seq = nextTerminalQuerySeq++;
      lastDispatchedSeqRef.current = seq;
      perfRef.current.queriesSent++;
      onPerfReportRef.current?.({ ...perfRef.current });
      onQueryTerminalRef.current({
        querySeq: seq,
        recordId: activeRecordId,
        unit: activeUnit,
        scopeKey: axisDomain.scopeKey,
        sourceKind: rangeSource,
        ...(axisDomain.bootGeneration !== undefined ? { bootGeneration: axisDomain.bootGeneration } : {}),
        ...(axisDomain.segmentId !== undefined ? { segmentId: axisDomain.segmentId } : {}),
        start: resolvedRange.start!,
        end: expectedQueryEnd,
        offset: targetOffset,
        limit: TERMINAL_PAGE_LIMIT,
        level,
        searchText,
        mergeAppend,
      });
    };
    if (queryDebounceRef.current !== null) {
      window.clearTimeout(queryDebounceRef.current);
      queryDebounceRef.current = null;
    }
    queryDebounceRef.current = window.setTimeout(run, 24);
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
    level,
    searchText,
    mergeAppend,
  ]);

  useEffect(() => {
    dispatchTerminalQuery(offset);
    return () => {
      if (queryDebounceRef.current !== null) {
        window.clearTimeout(queryDebounceRef.current);
        queryDebounceRef.current = null;
      }
    };
  }, [dispatchTerminalQuery, offset, committedBytes]);

  // Fetch recording-level decoder/reconstructor/storage/gap diagnostics across all boots/segments
  useEffect(() => {
    if (!visible || !activeRecordId) return;
    perfRef.current.diagRequestsSent++;
    onGetDiagnosticsRef.current({
      recordId: activeRecordId,
    });
  }, [visible, activeRecordId, committedBytes]);

  const activeTermResp = useMemo(() => {
    if (!doesTerminalResponseMatchProvenance(terminalResult, currentProvenance)) return null;
    if (terminalResult && terminalResult.querySeq < minValidSeqRef.current) return null;
    return terminalResult;
  }, [terminalResult, currentProvenance]);

  useEffect(() => {
    if (!terminalResult) return;
    if (
      terminalResult.querySeq < minValidSeqRef.current ||
      terminalResult.querySeq < lastDispatchedSeqRef.current ||
      !doesTerminalResponseMatchProvenance(terminalResult, currentProvenance)
    ) {
      perfRef.current.droppedStaleReplies++;
      return;
    }
    const dedupKey = `${terminalResult.recordId}::${terminalResult.querySeq}`;
    if (appliedTermKeyRef.current === dedupKey) {
      return;
    }
    appliedTermKeyRef.current = dedupKey;
    perfRef.current.repliesApplied++;
    perfRef.current.lastQueryMs = terminalResult.queryDurationMs;
    perfRef.current.lastTotalLines = terminalResult.result?.totalLines ?? 0;
    onPerfReportRef.current?.({ ...perfRef.current });
  }, [terminalResult, currentProvenance]);

  const data = activeTermResp?.result ?? null;
  const diagData = diagnosticsResult && diagnosticsResult.recordId === activeRecordId ? diagnosticsResult.diagnostics : null;

  useEffect(() => {
    (window as any).__orbitRtosTerminalTestApi = {
      getState: () => ({
        recordId: activeRecordId,
        unit: activeUnit,
        level,
        searchText,
        mergeAppend,
        totalLines: data?.totalLines ?? 0,
        linesCount: data?.lines.length ?? 0,
        lines: data?.lines ?? [],
        diagnosticsCount: diagData?.totalCount ?? 0,
        diagnosticsItems: diagData?.items ?? [],
        isStale: !activeTermResp,
        appliedQuerySeq: activeTermResp?.querySeq ?? null,
        appliedFilter: activeTermResp
          ? {
              recordId: activeTermResp.recordId,
              unit: activeTermResp.unit,
              scopeKey: activeTermResp.scopeKey,
              sourceKind: activeTermResp.sourceKind,
              level: activeTermResp.level,
              searchText: activeTermResp.searchText,
              mergeAppend: activeTermResp.mergeAppend,
              start: activeTermResp.result?.start ?? null,
              end: activeTermResp.result?.end ?? null,
            }
          : null,
        perf: { ...perfRef.current },
      }),
      setLevel: (lvl: TraceTerminalLevelFilter) => setLevel(lvl),
      setSearchText: (txt: string) => setSearchText(txt),
      setMergeAppend: (val: boolean) => setMergeAppend(val),
    };
  }, [activeRecordId, activeUnit, level, searchText, mergeAppend, data, diagData, activeTermResp]);

  return (
    <div className="terminal-shell" data-terminal-record={activeRecordId ?? 'none'}>
      <div className="rtos-filter-bar">
        <div className="rtos-filter-chips" role="group" aria-label="日志级别过滤">
          {([
            ['all', '全部'],
            ['log', 'LOG'],
            ['warning', 'WARNING'],
            ['error', 'ERROR'],
          ] as [TraceTerminalLevelFilter, string][]).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={`rtos-chip${level === id ? ' active' : ''}`}
              onClick={() => setLevel(id)}
            >
              {label}
            </button>
          ))}
        </div>

        <input
          type="search"
          aria-label="搜索 Trace 终端"
          className="rtos-search"
          placeholder="搜索输出文本、上下文、地址或警告…"
          value={searchText}
          onChange={e => setSearchText(e.target.value)}
        />

        <label className="rtos-live-toggle" title="按上下文与段连续性合并 SEGGER_SYSVIEW_FLAG_APPEND 续行（不跨断段或启动代次拼接）">
          <input
            type="checkbox"
            checked={mergeAppend}
            onChange={e => setMergeAppend(e.target.checked)}
          />
          <span>合并追加</span>
        </label>

        <button
          type="button"
          className={`rtos-chip${showDiagnosticsDrawer ? ' active' : ''}`}
          onClick={() => setShowDiagnosticsDrawer(prev => !prev)}
        >
          异常与坏包诊断 ({diagData?.totalCount ?? 0})
        </button>
      </div>

      <div className="trace-status-banner">
        <span className="rtos-mono trace-stat-text">
          {data
            ? `终端共 ${data.totalLines} 行${data.totalKnownExact ? '' : '+'} · 显示 [${data.offset}..${data.offset + data.lines.length}) · ${activeTermResp?.queryDurationMs ?? 0} ms`
            : activeTermResp?.error
              ? `⚠ 终端查询失败: ${activeTermResp.error}`
              : resolvedRange.valid
                ? '正在加载 Trace 终端输出…'
                : (resolvedRange.reason ?? '当前选区不可查询')}
        </span>

        {data && data.totalLines > TERMINAL_PAGE_LIMIT && (
          <div className="trace-btn-group">
            <button type="button" className="rtos-mini-btn" disabled={offset <= 0} onClick={() => setOffset(Math.max(0, offset - TERMINAL_PAGE_LIMIT))}>上一页</button>
            <button type="button" className="rtos-mini-btn" disabled={!data.hasMore} onClick={() => setOffset(offset + TERMINAL_PAGE_LIMIT)}>下一页</button>
          </div>
        )}
      </div>

      {/* 有限词法终端输出区（纯文本安全渲染，绝不执行表达式或 HTML） */}
      <div className="terminal-body">
        <div className="terminal-log-list" role="log" aria-label="Trace Terminal 输出">
          {!data || data.lines.length === 0 ? (
            <div className="rtos-table-empty">
              {!selectedRecord
                ? '请先录制或打开 Trace 归档'
                : !resolvedRange.valid
                  ? (resolvedRange.reason || '当前范围不可查询')
                  : !activeTermResp
                    ? '正在按当前筛选查询 Trace 终端…'
                    : '当前范围内无 PRINT_FORMATTED / EX_PRINT_ELF 终端输出'}
            </div>
          ) : data.lines.map(line => {
            const timeStr = activeUnit === 'ns' && line.ns !== undefined
              ? formatTraceTimestamp(line.ns, 'ns')
              : activeUnit === 'absolute-ticks' && line.absTicks !== undefined
                ? formatTraceTimestamp(line.absTicks, 'absolute-ticks')
                : formatTraceTimestamp(line.relTicks, 'relative-ticks');
            const srcBadge = formatSourceBadge(line);
            const lvlClass = line.logLevel === 2 ? 'term-lvl-error' : line.logLevel === 1 ? 'term-lvl-warn' : 'term-lvl-log';

            return (
              <div key={line.lineKey} className={`terminal-line ${lvlClass}`}>
                <div className="terminal-line-meta rtos-mono">
                  <span className="term-time">{timeStr}</span>
                  <span className="term-seg">b{line.bootGeneration}:s{line.segmentId}</span>
                  <span className={`rtos-pill ${line.logLevel === 2 ? 'rtos-tone-error' : line.logLevel === 1 ? 'rtos-tone-warn' : 'rtos-tone-info'}`}>
                    {line.logLevelLabel}
                  </span>
                  <span className="term-ctx" title={line.contextKey ?? ''}>
                    {line.contextLabel ?? line.contextKind}
                    {line.nestedIsr ? ` [嵌套d=${line.isrDepth}]` : ''}
                  </span>
                  <span className={`rtos-pill ${srcBadge.tone}`}>{srcBadge.label}</span>
                  {line.mergedPacketCount > 1 && (
                    <span className="rtos-evidence">合并×{line.mergedPacketCount}</span>
                  )}
                  {line.appendBrokenReason && (
                    <span className="rtos-inline-warn">[{line.appendBrokenReason}]</span>
                  )}
                  <span className="term-actions">
                    <button type="button" className="rtos-mini-btn" onClick={() => onLocateLineInEvents(line)}>事件详情</button>
                    <button type="button" className="rtos-mini-btn" onClick={() => onJumpLineToTimeline(line)}>定位Trace</button>
                  </span>
                </div>
                <pre className="terminal-line-text">{line.renderedText}</pre>
                {line.warnings.length > 0 && (
                  <div className="terminal-line-warnings rtos-mono">
                    {line.warnings.map((w, i) => (
                      <span key={i} className="rtos-inline-warn">⚠ {w}</span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* 坏包、超限、嵌套 ISR、地址与断段诊断区 */}
        {showDiagnosticsDrawer && (
          <aside className="terminal-diag-pane" aria-label="录制与协议诊断">
            <div className="events-detail-subtitle">
              解码 / 重建 / 存储 / 断段诊断
              {diagData && (
                <span className="rtos-muted rtos-mono">
                  {' '}(decoder={diagData.countsBySource.decoder} · recon={diagData.countsBySource.reconstructor} · gap={diagData.countsBySource.gap} · storage={diagData.countsBySource.storage}
                  {diagData.droppedRecordedDiagnostics > 0 ? ` · 截断丢弃=${diagData.droppedRecordedDiagnostics}` : ''})
                </span>
              )}
            </div>
            {!diagData || diagData.items.length === 0 ? (
              <div className="rtos-muted">当前录制未记录解码坏包、超限、嵌套 ISR 异常或存储错误。</div>
            ) : (
              <div className="terminal-diag-list rtos-mono">
                {diagData.items.map((item, idx) => (
                  <div
                    key={idx}
                    className={`terminal-diag-item ${item.severity === 'error' ? 'rtos-inline-error' : item.severity === 'warning' ? 'rtos-inline-warn' : 'rtos-muted'}`}
                  >
                    [{item.source}/{item.severity}] {item.code}: {item.message}
                    {item.bootGeneration !== undefined ? ` · boot=${item.bootGeneration}` : ''}
                    {item.segmentId !== undefined ? ` seg=${item.segmentId}` : ''}
                    {item.byteOffset !== undefined ? ` @off=${item.byteOffset}` : ''}
                  </div>
                ))}
              </div>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}
