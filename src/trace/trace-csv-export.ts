import { createHash } from 'node:crypto';
import type { TraceEventDto } from './systemview-formatter';
import {
  streamMatchedEvents,
  type TraceEventFilter,
  type TraceEventsExecutionHost,
} from './trace-events';
import type {
  RecordingLifecycleState,
  RecordingRecoveryDisposition,
  SegmentIndexMetadata,
  StoredGapEntry,
} from './trace-format';
import { ORBIT_TRACE_FORMAT } from './trace-format';
import type { TraceQueryTimeUnit } from './trace-range-index';

export type TraceCsvExportSource = 'trace-viewport' | 'ab-selection' | 'events-page' | 'full';

export interface TraceCsvExportRequest {
  readonly exportSource: TraceCsvExportSource;
  readonly unit: TraceQueryTimeUnit;
  readonly start: bigint | string | number;
  readonly end: bigint | string | number;
  readonly bootGeneration?: number;
  readonly segmentId?: number;
  readonly filter?: TraceEventFilter;
  readonly crossesGap?: boolean;
}

export interface TraceCsvExportResult {
  readonly outputPath: string;
  readonly exportedRows: number;
  readonly exportedBytes: number;
  readonly sha256: string;
  readonly exportSource: TraceCsvExportSource;
  readonly unit: TraceQueryTimeUnit;
  readonly start: string;
  readonly end: string;
  readonly archiveState: RecordingLifecycleState;
  readonly recoveryDisposition: RecordingRecoveryDisposition;
  readonly skippedUnanchoredSegments: readonly number[];
  readonly skippedNoFrequencySegments: readonly number[];
  readonly gapsInWindow: readonly StoredGapEntry[];
  readonly hasTargetOverflow: boolean;
  readonly hasHostDrop: boolean;
}

export const TRACE_CSV_COLUMNS = [
  'recordId',
  'archiveFormat',
  'archiveState',
  'recoveryDisposition',
  'exportSource',
  'queryUnit',
  'rangeStart',
  'rangeEnd',
  'filterSummary',
  'bootGeneration',
  'segmentId',
  'segmentReliability',
  'timeDomain',
  'timeAnchorStatus',
  'sysFreqHz',
  'timestampWrapped',
  'uncertaintyFlags',
  'eventKey',
  'packetIndexInSegment',
  'streamByteOffset',
  'byteLength',
  'eventId',
  'eventName',
  'category',
  'schemaReliability',
  'deltaTicks',
  'relTicks',
  'absTicks',
  'ns',
  'contextKind',
  'contextKey',
  'contextLabel',
  'contextLabelSource',
  'isrDepth',
  'nestedIsr',
  'summary',
  'terminalText',
  'diagnostics',
  'rawPayloadHex',
] as const;

export function sanitizeCsvControlChars(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code === 0x0d) {
      if (i + 1 < raw.length && raw.charCodeAt(i + 1) === 0x0a) {
        i++;
      }
      out += '\n';
    } else if (code === 0x0a || code === 0x09) {
      out += raw[i];
    } else if (code < 0x20 || code === 0x7f) {
      out += `\\x${code.toString(16).padStart(2, '0')}`;
    } else {
      out += raw[i];
    }
  }
  return out;
}

/**
 * CSV 单元格引号转义与公式中和（记录分隔符约定为 `\n` LF；单元格转义遵循 RFC 4180 引号规则）：
 * - 对来自录制流或 manifest/过滤条件等的文本（`neutralizeFormula: true`），
 *   若以 `=`, `+`, `-`, `@`, `\t`, `\r`, `\n` 开头，或在首部空白/BOM 之后紧接 `=`, `+`, `-`, `@`，
 *   前缀单引号 `'` 使其作为纯数据而非电子表格公式执行；
 * - 任何含逗号、换行、双引号、单引号或首尾空白的单元格均使用双引号包裹并将 `"` 转义为 `""`。
 */
export function formatCsvCell(value: unknown, neutralizeFormula = false): string {
  if (value === undefined || value === null) {
    return '';
  }
  let str = sanitizeCsvControlChars(String(value));
  if (neutralizeFormula && str.length > 0 && /^(?:[\t\r\n]|[\s\ufeff]*[=+\-@])/.test(str)) {
    str = `'${str}`;
  }
  if (/[,"'\r\n]/.test(str) || /^\s|\s$/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function formatCsvFilterSummary(filter?: TraceEventFilter): string {
  if (!filter) return 'none';
  const parts: string[] = [];
  if (filter.category && filter.category !== 'all') parts.push(`category=${filter.category}`);
  if (filter.searchText && filter.searchText.trim().length > 0) parts.push(`search=${filter.searchText.trim()}`);
  if (filter.contextKey && filter.contextKey.trim().length > 0) parts.push(`context=${filter.contextKey.trim()}`);
  if (filter.eventId !== undefined) parts.push(`eventId=${filter.eventId}`);
  if (filter.onlyWithDiagnostics) parts.push('onlyWithDiagnostics=true');
  return parts.length > 0 ? parts.join(';') : 'none';
}

export function buildCsvRowUncertaintyFlags(params: {
  readonly dto: TraceEventDto;
  readonly archiveState: RecordingLifecycleState;
  readonly recoveryDisposition: RecordingRecoveryDisposition;
  readonly crossesGap?: boolean;
  readonly hasTargetOverflowInSeg: boolean;
  readonly hasHostDropInSeg: boolean;
  readonly hasPrefixOverwrittenInSeg: boolean;
  readonly hasNonTrivialGapInSeg: boolean;
}): string {
  const flags: string[] = [];
  const { dto, archiveState, recoveryDisposition } = params;
  if (archiveState === 'interrupted' || archiveState === 'failed') {
    flags.push('incomplete-archive');
  }
  if (recoveryDisposition === 'recovered-prefix-bad-chunk') {
    flags.push('corrupted-prefix');
  } else if (recoveryDisposition === 'rebuilt-bad-index') {
    flags.push('bad-index-rebuilt');
  }
  if (dto.segmentReliability === 'uncertain') {
    flags.push('uncertain-segment');
  }
  if (dto.timeDomain === 'unknown' || dto.timeAnchorStatus === 'unanchored') {
    flags.push('unanchored-clock');
  } else if (dto.timeDomain === 'segment-relative-ticks') {
    flags.push('relative-time-only');
  }
  if (dto.sysFreqHz === undefined || dto.sysFreqHz <= 0) {
    flags.push('unknown-frequency');
  }
  if (dto.timestampWrapped) {
    flags.push('timestamp-wrapped');
  }
  if (dto.schemaReliability === 'partial') {
    flags.push('partial-schema');
  } else if (dto.schemaReliability === 'unknown-explicit') {
    flags.push('unknown-event');
  }
  if (params.crossesGap || params.hasNonTrivialGapInSeg) {
    flags.push('cross-gap-selection');
  }
  if (params.hasTargetOverflowInSeg || dto.eventId === 1) {
    flags.push('target-overflow-in-window');
  }
  if (params.hasHostDropInSeg) {
    flags.push('host-drop-in-window');
  }
  if (params.hasPrefixOverwrittenInSeg) {
    flags.push('prefix-overwritten');
  }
  return flags.length > 0 ? flags.join(';') : 'none';
}

export async function streamEventsToCsvWriter(params: {
  readonly host: TraceEventsExecutionHost;
  readonly recordId: string;
  readonly archiveState: RecordingLifecycleState;
  readonly recoveryDisposition: RecordingRecoveryDisposition;
  readonly request: TraceCsvExportRequest;
  readonly qStart: bigint;
  readonly qEnd: bigint;
  readonly chunkSizeBytes?: number;
  readonly writeChunk: (chunk: Uint8Array) => Promise<void>;
}): Promise<
  | {
      ok: true;
      data: {
        exportedRows: number;
        exportedBytes: number;
        sha256: string;
        skippedUnanchoredSegments: readonly number[];
        skippedNoFrequencySegments: readonly number[];
        gapsInWindow: readonly StoredGapEntry[];
        hasTargetOverflow: boolean;
        hasHostDrop: boolean;
      };
    }
  | { ok: false; cancelled: true }
> {
  const { host, recordId, archiveState, recoveryDisposition, request, qStart, qEnd, writeChunk } = params;
  const chunkLimit = Math.max(4096, params.chunkSizeBytes ?? 65536);
  const hash = createHash('sha256');
  const rangeStartStr = qStart.toString();
  const rangeEndStr = qEnd.toString();
  const filterSummaryStr = formatCsvFilterSummary(request.filter);

  const allGaps = host.index.getGaps();
  const segGapFlags = new Map<
    string,
    { overflow: boolean; hostDrop: boolean; prefixOverwritten: boolean; nonTrivialGap: boolean }
  >();
  let anyTargetOverflow = false;
  let anyHostDrop = false;
  for (const g of allGaps) {
    if (g.kind === 'target-overflow') anyTargetOverflow = true;
    if (g.kind === 'host-drop' || g.kind === 'transport-gap') anyHostDrop = true;
    if (g.segmentIdBefore === undefined) continue;
    const key = `${g.bootGeneration}:${g.segmentIdBefore}`;
    let st = segGapFlags.get(key);
    if (!st) {
      st = { overflow: false, hostDrop: false, prefixOverwritten: false, nonTrivialGap: false };
      segGapFlags.set(key, st);
    }
    if (g.kind === 'target-overflow') st.overflow = true;
    if (g.kind === 'host-drop' || g.kind === 'transport-gap') st.hostDrop = true;
    if (g.kind === 'prefix-overwritten') st.prefixOverwritten = true;
    if (g.kind !== 'eof' && g.kind !== 'trace-stop') st.nonTrivialGap = true;
  }

  let textBuffer = `${TRACE_CSV_COLUMNS.join(',')}\n`;
  let exportedBytes = 0;
  let exportedRows = 0;
  let sawOverflowEvent = false;

  const flushBuffer = async (force: boolean): Promise<void> => {
    if (!force && Buffer.byteLength(textBuffer, 'utf8') < chunkLimit) {
      return;
    }
    if (textBuffer.length === 0) return;
    const bytes = Buffer.from(textBuffer, 'utf8');
    textBuffer = '';
    hash.update(bytes);
    exportedBytes += bytes.length;
    await writeChunk(bytes);
  };

  const res = await streamMatchedEvents(
    host,
    {
      unit: request.unit,
      bootGeneration: request.bootGeneration,
      segmentId: request.segmentId,
      filter: request.filter,
    },
    qStart,
    qEnd,
    async (dtos: readonly TraceEventDto[], segMeta: SegmentIndexMetadata) => {
      const segKey = `${segMeta.bootGeneration}:${segMeta.segmentId}`;
      const gapInfo = segGapFlags.get(segKey);
      for (const dto of dtos) {
        const diagText =
          dto.diagnostics.length > 0
            ? dto.diagnostics.map(d => `[${d.severity}:${d.code}] ${d.message}`).join(' | ')
            : '';
        const uncertaintyFlags = buildCsvRowUncertaintyFlags({
          dto,
          archiveState,
          recoveryDisposition,
          crossesGap: request.crossesGap,
          hasTargetOverflowInSeg: Boolean(gapInfo?.overflow),
          hasHostDropInSeg: Boolean(gapInfo?.hostDrop),
          hasPrefixOverwrittenInSeg: Boolean(gapInfo?.prefixOverwritten),
          hasNonTrivialGapInSeg: Boolean(gapInfo?.nonTrivialGap),
        });
        if (dto.eventId === 1) {
          sawOverflowEvent = true;
        }
        const rowCells = [
          formatCsvCell(recordId, true),
          formatCsvCell(ORBIT_TRACE_FORMAT, true),
          formatCsvCell(archiveState, true),
          formatCsvCell(recoveryDisposition, true),
          formatCsvCell(request.exportSource, true),
          formatCsvCell(request.unit, true),
          formatCsvCell(rangeStartStr),
          formatCsvCell(rangeEndStr),
          formatCsvCell(filterSummaryStr, true),
          formatCsvCell(dto.bootGeneration),
          formatCsvCell(dto.segmentId),
          formatCsvCell(dto.segmentReliability, true),
          formatCsvCell(dto.timeDomain, true),
          formatCsvCell(dto.timeAnchorStatus, true),
          formatCsvCell(dto.sysFreqHz),
          formatCsvCell(dto.timestampWrapped),
          formatCsvCell(uncertaintyFlags, true),
          formatCsvCell(dto.eventKey, true),
          formatCsvCell(dto.packetIndexInSegment),
          formatCsvCell(dto.streamByteOffset),
          formatCsvCell(dto.byteLength),
          formatCsvCell(dto.eventId),
          formatCsvCell(dto.eventName, true),
          formatCsvCell(dto.category, true),
          formatCsvCell(dto.schemaReliability, true),
          formatCsvCell(dto.deltaTicks),
          formatCsvCell(dto.relTicks),
          formatCsvCell(dto.absTicks),
          formatCsvCell(dto.ns),
          formatCsvCell(dto.contextKind, true),
          formatCsvCell(dto.contextKey, true),
          formatCsvCell(dto.contextLabel, true),
          formatCsvCell(dto.contextLabelSource, true),
          formatCsvCell(dto.isrDepth),
          formatCsvCell(dto.nestedIsr),
          formatCsvCell(dto.summary, true),
          formatCsvCell(dto.terminalEntry?.renderedText, true),
          formatCsvCell(diagText, true),
          formatCsvCell(dto.rawPayloadHex, true),
        ];
        textBuffer += `${rowCells.join(',')}\n`;
        exportedRows++;
        if (Buffer.byteLength(textBuffer, 'utf8') >= chunkLimit) {
          await flushBuffer(true);
        }
      }
    },
  );

  if (!res.ok) {
    return res;
  }

  await flushBuffer(true);

  const gapsInWindow = res.data.gapsInWindow;
  const hasTargetOverflow = anyTargetOverflow || sawOverflowEvent || gapsInWindow.some(g => g.kind === 'target-overflow');
  const hasHostDrop = anyHostDrop || gapsInWindow.some(g => g.kind === 'host-drop' || g.kind === 'transport-gap');

  return {
    ok: true,
    data: {
      exportedRows,
      exportedBytes,
      sha256: hash.digest('hex'),
      skippedUnanchoredSegments: res.data.skippedUnanchoredSegments,
      skippedNoFrequencySegments: res.data.skippedNoFrequencySegments,
      gapsInWindow,
      hasTargetOverflow,
      hasHostDrop,
    },
  };
}
