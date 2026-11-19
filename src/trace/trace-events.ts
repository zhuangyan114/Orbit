import type {
  DecodedSystemViewPacket,
  TraceDiagnostic,
} from './systemview-decoder';
import type {
  ExecutionSliceInterval,
  ReconstructorDiagnostic,
} from './systemview-reconstructor';
import {
  buildEmptyMetadataContext,
  formatTraceEventDto,
  type TraceEventDto,
  type TraceEventMetadataContext,
  type TraceEventSliceContext,
  type VerifiedElfRodataLookup,
} from './systemview-formatter';
import type {
  DecodedTracePage,
  IndexedPageDescriptor,
  RecordingDiagnostic,
  SegmentIndexMetadata,
  StoredGapEntry,
} from './trace-format';
import {
  getPacketTimeForUnit,
  intersectsHalfOpen,
  SegmentPartition,
  TraceQueryTimeUnit,
  TraceRangeIndex,
} from './trace-range-index';

export type TraceEventCategoryFilter =
  | 'all'
  | 'task'
  | 'isr'
  | 'os-api'
  | 'marker'
  | 'terminal'
  | 'system'
  | 'anomalies';

export type TraceTerminalLevelFilter = 'all' | 'log' | 'warning' | 'error';

export interface TraceEventFilter {
  readonly category?: TraceEventCategoryFilter;
  readonly searchText?: string;
  readonly contextKey?: string;
  readonly eventId?: number;
  readonly onlyWithDiagnostics?: boolean;
}

export interface TraceEventsQueryRequest {
  readonly start: bigint | string | number;
  readonly end: bigint | string | number;
  readonly unit: TraceQueryTimeUnit;
  readonly bootGeneration?: number;
  readonly segmentId?: number;
  readonly offset?: number;
  readonly limit?: number;
  readonly filter?: TraceEventFilter;
  readonly maxScanPages?: number;
}

export interface TraceEventsQueryResult {
  readonly unit: TraceQueryTimeUnit;
  readonly start: string;
  readonly end: string;
  readonly offset: number;
  readonly limit: number;
  readonly totalMatched: number;
  readonly totalKnownExact: boolean;
  readonly hasMore: boolean;
  readonly scanTruncated: boolean;
  readonly items: readonly TraceEventDto[];
  readonly gapsInWindow: readonly StoredGapEntry[];
  readonly segmentsInWindow: readonly SegmentIndexMetadata[];
  readonly candidatePagesScanned: number;
  readonly totalCandidatePages: number;
  readonly cacheHits: number;
  readonly cacheMisses: number;
  readonly skippedUnanchoredSegments: readonly number[];
  readonly skippedNoFrequencySegments: readonly number[];
}

export interface TraceEventLocateRequest {
  readonly start: bigint | string | number;
  readonly end: bigint | string | number;
  readonly unit: TraceQueryTimeUnit;
  readonly bootGeneration?: number;
  readonly segmentId?: number;
  readonly targetTime?: bigint | string | number;
  readonly targetBootGeneration?: number;
  readonly targetSegmentId?: number;
  readonly targetPacketIndex?: number;
  readonly targetByteOffset?: number;
  readonly filter?: TraceEventFilter;
}

export interface TraceEventLocateResult {
  readonly found: boolean;
  readonly exactMatch: boolean;
  readonly rowIndex: number;
  readonly event?: TraceEventDto;
  readonly candidatePagesScanned: number;
}

export interface TraceTerminalQueryRequest {
  readonly start: bigint | string | number;
  readonly end: bigint | string | number;
  readonly unit: TraceQueryTimeUnit;
  readonly bootGeneration?: number;
  readonly segmentId?: number;
  readonly level?: TraceTerminalLevelFilter;
  readonly searchText?: string;
  readonly mergeAppend?: boolean;
  readonly offset?: number;
  readonly limit?: number;
  readonly maxScanPages?: number;
}

export interface TraceTerminalLineDto {
  readonly lineKey: string;
  readonly eventKey: string;
  readonly bootGeneration: number;
  readonly segmentId: number;
  readonly segmentReliability: 'trusted' | 'uncertain';
  readonly packetIndexInSegment: number;
  readonly streamByteOffset: number;
  readonly relTicks: string;
  readonly absTicks?: string;
  readonly ns?: string;
  readonly sysFreqHz?: number;
  readonly timeDomain: 'anchored-ticks' | 'segment-relative-ticks' | 'unknown';
  readonly logLevel: number;
  readonly logLevelLabel: string;
  readonly append: boolean;
  readonly mergedPacketCount: number;
  readonly appendBrokenReason?: string;
  readonly contextKind: string;
  readonly contextKey?: string;
  readonly contextLabel?: string;
  readonly contextLabelSource?: string;
  readonly isrDepth: number;
  readonly nestedIsr: boolean;
  readonly renderedText: string;
  readonly formatSource: 'packet-inline' | 'elf-rodata' | 'unresolved-address';
  readonly rawFormatText?: string;
  readonly stringAddress?: number;
  readonly stringAddressHex?: string;
  readonly addressStatus?: string;
  readonly args: readonly number[];
  readonly warnings: readonly string[];
}

export interface TraceTerminalQueryResult {
  readonly unit: TraceQueryTimeUnit;
  readonly start: string;
  readonly end: string;
  readonly offset: number;
  readonly limit: number;
  readonly totalLines: number;
  readonly totalKnownExact: boolean;
  readonly hasMore: boolean;
  readonly scanTruncated: boolean;
  readonly lines: readonly TraceTerminalLineDto[];
  readonly gapsInWindow: readonly StoredGapEntry[];
  readonly segmentsInWindow: readonly SegmentIndexMetadata[];
  readonly candidatePagesScanned: number;
  readonly skippedUnanchoredSegments: readonly number[];
  readonly skippedNoFrequencySegments: readonly number[];
}

export interface TraceRecordingDiagnosticsItem {
  readonly source: 'decoder' | 'reconstructor' | 'storage' | 'gap';
  readonly severity: 'info' | 'warning' | 'error';
  readonly code: string;
  readonly message: string;
  readonly bootGeneration?: number;
  readonly segmentId?: number;
  readonly byteOffset?: number;
  readonly relativeTicks?: string;
  readonly details?: Record<string, unknown>;
}

export interface TraceRecordingDiagnosticsResult {
  readonly items: readonly TraceRecordingDiagnosticsItem[];
  readonly totalCount: number;
  readonly truncated: boolean;
  readonly droppedRecordedDiagnostics: number;
  readonly countsBySource: {
    readonly decoder: number;
    readonly reconstructor: number;
    readonly storage: number;
    readonly gap: number;
  };
}

export interface TraceEventsExecutionHost {
  readonly index: TraceRangeIndex;
  readonly metadata: TraceEventMetadataContext;
  readonly rodataLookup?: VerifiedElfRodataLookup;
  readonly decoderDiagnostics: readonly TraceDiagnostic[];
  readonly reconstructorDiagnostics: readonly ReconstructorDiagnostic[];
  readonly storageDiagnostics: readonly RecordingDiagnostic[];
  readonly droppedRecordedDiagnostics: number;
  loadPage(desc: IndexedPageDescriptor): Promise<DecodedTracePage>;
  getCacheStats(): { readonly hits: number; readonly misses: number };
  isCancelled(): boolean;
  yieldToLoop(): Promise<void>;
  readonly yieldEveryPages: number;
  readonly yieldEveryItems: number;
}

export function buildRecordingDiagnosticsResult(params: {
  readonly gaps: readonly StoredGapEntry[];
  readonly decoderDiagnostics: readonly TraceDiagnostic[];
  readonly reconstructorDiagnostics: readonly ReconstructorDiagnostic[];
  readonly storageDiagnostics: readonly RecordingDiagnostic[];
  readonly droppedRecordedDiagnostics: number;
  readonly bootGeneration?: number;
  readonly segmentId?: number;
  readonly limit?: number;
}): TraceRecordingDiagnosticsResult {
  const maxItems = Math.max(1, Math.min(1024, params.limit ?? 512));
  const items: TraceRecordingDiagnosticsItem[] = [];
  let decoderCount = 0;
  let reconCount = 0;
  let storageCount = 0;
  let gapCount = 0;

  const matchesSeg = (boot?: number, seg?: number) => {
    if (params.bootGeneration !== undefined && boot !== undefined && boot !== params.bootGeneration) return false;
    if (params.segmentId !== undefined && seg !== undefined && seg !== params.segmentId) return false;
    return true;
  };

  for (const g of params.gaps) {
    if (!matchesSeg(g.bootGeneration, g.segmentIdBefore)) continue;
    gapCount++;
    if (items.length < maxItems) {
      items.push({
        source: 'gap',
        severity: g.kind === 'eof' || g.kind === 'trace-stop' ? 'info' : 'error',
        code: g.kind,
        message: `${g.reason} (droppedPackets=${g.droppedPackets}, droppedBytes=${g.droppedBytes})`,
        bootGeneration: g.bootGeneration,
        ...(g.segmentIdBefore !== undefined ? { segmentId: g.segmentIdBefore } : {}),
        byteOffset: g.byteOffset,
        ...(g.relativeTicks !== undefined ? { relativeTicks: g.relativeTicks } : {}),
      });
    }
  }

  for (const d of params.decoderDiagnostics) {
    if (!matchesSeg(undefined, d.segmentId)) continue;
    decoderCount++;
    if (items.length < maxItems) {
      items.push({
        source: 'decoder',
        severity: d.severity,
        code: d.code,
        message: d.message,
        segmentId: d.segmentId,
        byteOffset: d.byteOffset,
        ...(d.details ? { details: d.details } : {}),
      });
    }
  }

  for (const r of params.reconstructorDiagnostics) {
    if (!matchesSeg(r.bootGeneration, r.segmentId)) continue;
    reconCount++;
    if (items.length < maxItems) {
      items.push({
        source: 'reconstructor',
        severity: r.severity,
        code: r.code,
        message: r.message,
        bootGeneration: r.bootGeneration,
        segmentId: r.segmentId,
        byteOffset: r.streamByteOffset,
        ...(r.relativeTicks !== undefined ? { relativeTicks: r.relativeTicks } : {}),
        ...(r.details ? { details: r.details } : {}),
      });
    }
  }

  for (const s of params.storageDiagnostics) {
    storageCount++;
    if (items.length < maxItems) {
      items.push({
        source: 'storage',
        severity: s.code === 'failure-recorded' || s.code.includes('corrupt') || s.code.includes('mismatch') ? 'error' : 'warning',
        code: s.code,
        message: `${s.file}: ${s.message}`,
        ...(s.offset !== undefined ? { byteOffset: s.offset } : {}),
      });
    }
  }

  const totalCount = gapCount + decoderCount + reconCount + storageCount;
  return {
    items,
    totalCount,
    truncated: totalCount > items.length || params.droppedRecordedDiagnostics > 0,
    droppedRecordedDiagnostics: params.droppedRecordedDiagnostics,
    countsBySource: {
      decoder: decoderCount,
      reconstructor: reconCount,
      storage: storageCount,
      gap: gapCount,
    },
  };
}

function isPacketInCategory(pkt: DecodedSystemViewPacket, cat: TraceEventCategoryFilter): boolean {
  if (cat === 'all') return true;
  const k = pkt.decoded.kind;
  switch (cat) {
    case 'task':
      return (
        k === 'task-start-exec' ||
        k === 'task-stop-exec' ||
        k === 'task-start-ready' ||
        k === 'task-stop-ready' ||
        k === 'task-create' ||
        k === 'task-info' ||
        k === 'task-terminate' ||
        k === 'stack-info' ||
        k === 'idle'
      );
    case 'isr':
      return k === 'isr-enter' || k === 'isr-exit' || k === 'isr-to-scheduler';
    case 'os-api':
      return k === 'os-freertos' || k === 'end-call';
    case 'marker':
      return k === 'mark-start' || k === 'mark-stop' || k === 'ex-mark' || k === 'ex-name-marker';
    case 'terminal':
      return k === 'print-formatted' || k === 'ex-print-elf';
    case 'system':
      return (
        k === 'init' ||
        k === 'sysdesc' ||
        k === 'systime-cycles' ||
        k === 'systime-us' ||
        k === 'trace-start' ||
        k === 'trace-stop' ||
        k === 'moduledesc' ||
        k === 'nummodules' ||
        k === 'name-resource' ||
        k === 'timer-enter' ||
        k === 'timer-exit' ||
        k === 'data-sample' ||
        k === 'ex-register-data' ||
        k === 'ex-heap-define' ||
        k === 'ex-heap-alloc' ||
        k === 'ex-heap-alloc-ex' ||
        k === 'ex-heap-free' ||
        k === 'nop'
      );
    case 'anomalies':
      return (
        pkt.segmentReliability === 'uncertain' ||
        pkt.schemaReliability !== 'known' ||
        k === 'overflow' ||
        k === 'unknown-explicit' ||
        k === 'ex-unknown' ||
        k === 'module-event' ||
        k === 'user-event' ||
        k === 'ex-print-elf' ||
        (k === 'os-freertos' && pkt.decoded.interpretation !== 'matched')
      );
  }
}

function isFilterEmpty(filter?: TraceEventFilter): boolean {
  if (!filter) return true;
  if (filter.category && filter.category !== 'all') return false;
  if (filter.searchText && filter.searchText.trim().length > 0) return false;
  if (filter.contextKey && filter.contextKey.trim().length > 0) return false;
  if (filter.eventId !== undefined) return false;
  if (filter.onlyWithDiagnostics) return false;
  return true;
}

function pageFullyInsideRange(
  desc: IndexedPageDescriptor,
  unit: TraceQueryTimeUnit,
  qStart: bigint,
  qEnd: bigint,
): boolean {
  switch (unit) {
    case 'relative-ticks':
      return BigInt(desc.minRelativeTicks) >= qStart && BigInt(desc.maxRelativeTicks) < qEnd;
    case 'absolute-ticks':
      return (
        desc.allAbsoluteTicks &&
        desc.minAbsoluteTicks !== undefined &&
        desc.maxAbsoluteTicks !== undefined &&
        BigInt(desc.minAbsoluteTicks) >= qStart &&
        BigInt(desc.maxAbsoluteTicks) < qEnd
      );
    case 'ns':
      return (
        desc.allAbsoluteTicks &&
        desc.minNs !== undefined &&
        desc.maxNs !== undefined &&
        BigInt(desc.minNs) >= qStart &&
        BigInt(desc.maxNs) < qEnd
      );
    case 'relative-ns': {
      if (!desc.sysFreqHz || desc.sysFreqHz <= 0) return false;
      const minNs = (BigInt(desc.minRelativeTicks) * 1_000_000_000n) / BigInt(desc.sysFreqHz);
      const maxNs = (BigInt(desc.maxRelativeTicks) * 1_000_000_000n) / BigInt(desc.sysFreqHz);
      return minNs >= qStart && maxNs < qEnd;
    }
    case 'byte-offset':
      return BigInt(desc.minByteOffset) >= qStart && BigInt(desc.maxByteOffset) <= qEnd;
  }
}

async function loadSlicesForPacketRange(
  host: TraceEventsExecutionHost,
  part: SegmentPartition,
  minRelTicks: bigint,
  maxRelTicks: bigint,
): Promise<ExecutionSliceInterval[]> {
  const queryEnd = maxRelTicks + 1n;
  const [regDescs, longDescs] = await Promise.all([
    host.index.findCandidatePages(part, 'slices', 'relative-ticks', minRelTicks, queryEnd),
    host.index.findCandidatePages(part, 'longSlices', 'relative-ticks', minRelTicks, queryEnd),
  ]);
  const slices: ExecutionSliceInterval[] = [];
  for (const desc of [...regDescs, ...longDescs]) {
    const page = await host.loadPage(desc);
    for (const item of page.items as readonly ExecutionSliceInterval[]) {
      slices.push(item);
    }
  }
  slices.sort((a, b) => {
    const pa = a.start?.packetIndexInSegment ?? 0;
    const pb = b.start?.packetIndexInSegment ?? 0;
    if (pa !== pb) return pa - pb;
    const ta = a.start?.relativeTicksBigInt ?? 0n;
    const tb = b.start?.relativeTicksBigInt ?? 0n;
    if (ta < tb) return -1;
    if (ta > tb) return 1;
    return 0;
  });
  return slices;
}

function findSliceForPacket(
  pkt: DecodedSystemViewPacket,
  slices: readonly ExecutionSliceInterval[],
): TraceEventSliceContext | undefined {
  if (slices.length === 0) return undefined;
  const pIdx = pkt.packetIndexInSegment;
  const isExit = pkt.decoded.kind === 'isr-exit' || pkt.decoded.kind === 'isr-to-scheduler';

  // 若是 ISR_EXIT / ISR_TO_SCHEDULER，优先匹配以此包结束的中断切片以保留嵌套深度信息
  if (isExit) {
    for (let i = slices.length - 1; i >= 0; i--) {
      const sl = slices[i];
      if (sl.contextKind === 'isr' && sl.end?.packetIndexInSegment === pIdx) {
        return {
          contextKind: sl.contextKind,
          contextKey: sl.contextKey,
          taskInstanceId: sl.taskInstanceId,
          tcbAddress: sl.tcbAddress,
          irqId: sl.irqId,
          isrDepth: sl.isrDepth,
          label: sl.label,
          labelSource: sl.labelSource,
        };
      }
    }
  }

  // 二分查找最后一个 start.packetIndexInSegment <= pIdx 的切片
  let lo = 0;
  let hi = slices.length - 1;
  let candidate = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const sIdx = slices[mid].start?.packetIndexInSegment ?? 0;
    if (sIdx <= pIdx) {
      candidate = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  for (let i = candidate; i >= 0; i--) {
    const sl = slices[i];
    const sIdx = sl.start?.packetIndexInSegment ?? 0;
    const eIdx = sl.end?.packetIndexInSegment;
    if (sIdx <= pIdx && (eIdx === undefined || pIdx < eIdx)) {
      return {
        contextKind: sl.contextKind,
        contextKey: sl.contextKey,
        taskInstanceId: sl.taskInstanceId,
        tcbAddress: sl.tcbAddress,
        irqId: sl.irqId,
        isrDepth: sl.isrDepth,
        label: sl.label,
        labelSource: sl.labelSource,
      };
    }
    if (eIdx !== undefined && pIdx >= eIdx) {
      // 越过较早切片，继续向前检查是否存在跨越此包的长切片
      continue;
    }
  }
  return undefined;
}

function absorbPacketMetadata(
  meta: TraceEventMetadataContext,
  bootGeneration: number,
  pkt: DecodedSystemViewPacket,
): void {
  const d = pkt.decoded;
  if (d.kind === 'sysdesc') {
    let irqMap = meta.irqNamesByBoot.get(bootGeneration) as Map<number, string> | undefined;
    if (!irqMap) {
      irqMap = new Map();
      (meta.irqNamesByBoot as Map<number, Map<number, string>>).set(bootGeneration, irqMap);
    }
    for (const [k, v] of Object.entries(d.parsed.interrupts)) {
      const id = Number(k);
      if (Number.isInteger(id)) irqMap.set(id, v);
    }
  } else if (d.kind === 'ex-name-marker') {
    let mMap = meta.markerNamesByBoot.get(bootGeneration) as Map<number, string> | undefined;
    if (!mMap) {
      mMap = new Map();
      (meta.markerNamesByBoot as Map<number, Map<number, string>>).set(bootGeneration, mMap);
    }
    mMap.set(d.markerId, d.name);
  } else if (d.kind === 'name-resource' && d.resourceId !== undefined) {
    let rMap = meta.resourceNamesByBoot.get(bootGeneration) as Map<number, string> | undefined;
    if (!rMap) {
      rMap = new Map();
      (meta.resourceNamesByBoot as Map<number, Map<number, string>>).set(bootGeneration, rMap);
    }
    rMap.set(d.resourceId >>> 0, d.name);
  } else if (d.kind === 'ex-register-data') {
    let dMap = meta.dataNamesByBoot.get(bootGeneration) as Map<number, { name: string; unit?: string }> | undefined;
    if (!dMap) {
      dMap = new Map();
      (meta.dataNamesByBoot as Map<number, Map<number, { name: string; unit?: string }>>).set(bootGeneration, dMap);
    }
    dMap.set(d.dataId, { name: d.name, unit: d.unit });
  } else if (d.kind === 'task-info' && d.taskId !== undefined) {
    const key = `${bootGeneration}:${d.taskId >>> 0}`;
    if (!meta.tasksByBootAddr.has(key)) {
      (meta.tasksByBootAddr as Map<string, any>).set(key, {
        taskInstanceId: `pkt-${bootGeneration}-${d.taskId >>> 0}`,
        bootGeneration,
        firstSeenSegmentId: pkt.segmentId,
        lastSeenSegmentId: pkt.segmentId,
        tcbAddress: d.taskId >>> 0,
        addressStatus: 'resolved',
        shrunkTaskId: d.shrunkTaskId,
        generation: 1,
        name: d.name,
        nameSource: 'task-info',
        priority: d.priority,
        createdInTrace: false,
        terminated: false,
        identityConfidence: 'task-info-in-boot',
      });
    }
  }
}

function eventMatchesFilter(dto: TraceEventDto, filter: TraceEventFilter, searchLower: string): boolean {
  if (filter.contextKey && dto.contextKey !== filter.contextKey) {
    return false;
  }
  if (filter.onlyWithDiagnostics && dto.diagnostics.length === 0) {
    return false;
  }
  if (searchLower.length > 0) {
    const haystackParts: string[] = [
      dto.eventName,
      dto.summary,
      dto.contextLabel ?? '',
      dto.contextKey ?? '',
      `#${dto.eventId}`,
      `b${dto.bootGeneration}`,
      `s${dto.segmentId}`,
    ];
    if (dto.terminalEntry) {
      haystackParts.push(dto.terminalEntry.renderedText);
      if (dto.terminalEntry.stringAddressHex) haystackParts.push(dto.terminalEntry.stringAddressHex);
    }
    if (dto.apiDetails) {
      if (dto.apiDetails.apiName) haystackParts.push(dto.apiDetails.apiName);
      for (const p of dto.apiDetails.params) {
        haystackParts.push(p.name, p.rawHex, p.resolvedHex ?? '', p.resolvedLabel ?? '', p.enumNote ?? '');
      }
    }
    for (const diag of dto.diagnostics) {
      haystackParts.push(diag.code, diag.message);
    }
    const joined = haystackParts.join(' ').toLowerCase();
    if (!joined.includes(searchLower)) {
      return false;
    }
  }
  return true;
}

function collectWindowGaps(
  host: TraceEventsExecutionHost,
  partitions: readonly SegmentPartition[],
  unit: TraceQueryTimeUnit,
  qStart: bigint,
  qEnd: bigint,
): StoredGapEntry[] {
  const partMap = new Map<string, SegmentIndexMetadata>();
  for (const p of partitions) {
    partMap.set(`${p.meta.bootGeneration}:${p.meta.segmentId}`, p.meta);
  }
  const allGaps = host.index.getGaps();
  const out: StoredGapEntry[] = [];
  for (const g of allGaps) {
    if (g.segmentIdBefore === undefined) continue;
    const segMeta = partMap.get(`${g.bootGeneration}:${g.segmentIdBefore}`);
    if (!segMeta) continue;
    if (unit === 'byte-offset') {
      const b = BigInt(g.byteOffset);
      if (b >= qStart && b <= qEnd) out.push(g);
      continue;
    }
    if (g.relativeTicks !== undefined && unit === 'relative-ticks') {
      const t = BigInt(g.relativeTicks);
      if (t >= qStart && t <= qEnd) out.push(g);
      continue;
    }
    out.push(g);
  }
  return out;
}

export async function executeEventsQuery(
  host: TraceEventsExecutionHost,
  request: TraceEventsQueryRequest,
  qStart: bigint,
  qEnd: bigint,
): Promise<{ ok: true; data: TraceEventsQueryResult } | { ok: false; cancelled: true }> {
  if (host.isCancelled()) return { ok: false, cancelled: true };

  const offset = Math.max(0, Math.floor(request.offset ?? 0));
  const limit = Math.max(1, Math.min(500, Math.floor(request.limit ?? 150)));
  const filter = request.filter;
  const filterEmpty = isFilterEmpty(filter);
  const category = filter?.category ?? 'all';
  const searchLower = (filter?.searchText ?? '').trim().slice(0, 128).toLowerCase();
  const maxScanPages = request.maxScanPages ?? Number.MAX_SAFE_INTEGER;

  const { partitions, skippedUnanchoredSegments, skippedNoFrequencySegments } = host.index.getMatchingPartitions({
    bootGeneration: request.bootGeneration,
    segmentId: request.segmentId,
    unit: request.unit,
    start: qStart,
    end: qEnd,
  });

  const hitsBefore = host.getCacheStats().hits;
  const missesBefore = host.getCacheStats().misses;

  if (qStart >= qEnd || partitions.length === 0) {
    return {
      ok: true,
      data: {
        unit: request.unit,
        start: qStart.toString(),
        end: qEnd.toString(),
        offset,
        limit,
        totalMatched: 0,
        totalKnownExact: true,
        hasMore: false,
        scanTruncated: false,
        items: [],
        gapsInWindow: [],
        segmentsInWindow: [],
        candidatePagesScanned: 0,
        totalCandidatePages: 0,
        cacheHits: 0,
        cacheMisses: 0,
        skippedUnanchoredSegments,
        skippedNoFrequencySegments,
      },
    };
  }

  const pageEntries: Array<{ part: SegmentPartition; desc: IndexedPageDescriptor }> = [];
  for (const part of partitions) {
    const pages = await host.index.findCandidatePages(part, 'packets', request.unit, qStart, qEnd);
    for (const desc of pages) {
      pageEntries.push({ part, desc });
    }
  }

  const totalCandidatePages = pageEntries.length;
  const segmentsInWindow = partitions.map(p => p.meta);
  const gapsInWindow = collectWindowGaps(host, partitions, request.unit, qStart, qEnd);

  if (totalCandidatePages === 0) {
    return {
      ok: true,
      data: {
        unit: request.unit,
        start: qStart.toString(),
        end: qEnd.toString(),
        offset,
        limit,
        totalMatched: 0,
        totalKnownExact: true,
        hasMore: false,
        scanTruncated: false,
        items: [],
        gapsInWindow,
        segmentsInWindow,
        candidatePagesScanned: 0,
        totalCandidatePages: 0,
        cacheHits: host.getCacheStats().hits - hitsBefore,
        cacheMisses: host.getCacheStats().misses - missesBefore,
        skippedUnanchoredSegments,
        skippedNoFrequencySegments,
      },
    };
  }

  let candidatePagesScanned = 0;
  let itemsCheckedSinceYield = 0;
  const collected: TraceEventDto[] = [];
  let matchedCount = 0;
  let scanTruncated = false;

  if (filterEmpty) {
    // 无过滤快速虚拟窗口定位：对于完全落入区间的中间页，直接累加 desc.itemCount 跳过读盘
    let runningCount = 0;
    for (let pIdx = 0; pIdx < pageEntries.length; pIdx++) {
      if (host.isCancelled()) return { ok: false, cancelled: true };
      const { part, desc } = pageEntries[pIdx];
      const bootGen = part.meta.bootGeneration ?? desc.bootGeneration;
      const fullInside = pageFullyInsideRange(desc, request.unit, qStart, qEnd);
      const maxItemsInPage = desc.itemCount;

      if (fullInside && (runningCount + maxItemsInPage <= offset || runningCount >= offset + limit)) {
        runningCount += maxItemsInPage;
        continue;
      }

      if (candidatePagesScanned >= maxScanPages) {
        scanTruncated = true;
        break;
      }

      const page = await host.loadPage(desc);
      candidatePagesScanned++;
      const pkts = page.items as readonly DecodedSystemViewPacket[];

      // 若完全落入区间，无需逐包范围判断；否则按区间过滤边界页
      let pageMatchCount = 0;
      const pageWindowIndices: number[] = [];
      for (let i = 0; i < pkts.length; i++) {
        const pkt = pkts[i];
        absorbPacketMetadata(host.metadata, bootGen, pkt);
        let inRange = fullInside;
        if (!inRange) {
          const pt = getPacketTimeForUnit(pkt, request.unit, part.meta.sysFreqHz);
          inRange = Boolean(pt && intersectsHalfOpen(pt.start, pt.end, qStart, qEnd, pt.isPoint));
        }
        if (inRange) {
          const globalIdx = runningCount + pageMatchCount;
          if (globalIdx >= offset && globalIdx < offset + limit) {
            pageWindowIndices.push(i);
          }
          pageMatchCount++;
        }
      }

      if (pageWindowIndices.length > 0) {
        const firstPkt = pkts[pageWindowIndices[0]];
        const lastPkt = pkts[pageWindowIndices[pageWindowIndices.length - 1]];
        const slices = await loadSlicesForPacketRange(
          host,
          part,
          firstPkt.segmentRelativeTicksBigInt,
          lastPkt.segmentRelativeTicksBigInt,
        );
        for (const i of pageWindowIndices) {
          const pkt = pkts[i];
          const sliceCtx = findSliceForPacket(pkt, slices);
          collected.push(
            formatTraceEventDto({
              pkt,
              bootGeneration: bootGen,
              meta: host.metadata,
              sliceCtx,
              rodataLookup: host.rodataLookup,
              segmentSysFreqHz: part.meta.sysFreqHz,
            }),
          );
        }
      }

      runningCount += pageMatchCount;
      if (candidatePagesScanned % host.yieldEveryPages === 0) {
        await host.yieldToLoop();
        if (host.isCancelled()) return { ok: false, cancelled: true };
      }
    }
    matchedCount = runningCount;
  } else {
    // 过滤扫描路径：支持类型/上下文/关键字/诊断过滤、流式让步与快速取消
    const needSliceForFilter = Boolean(filter?.contextKey) || searchLower.length > 0;
    for (let pIdx = 0; pIdx < pageEntries.length; pIdx++) {
      if (host.isCancelled()) return { ok: false, cancelled: true };
      if (candidatePagesScanned >= maxScanPages) {
        scanTruncated = true;
        break;
      }

      const { part, desc } = pageEntries[pIdx];
      const bootGen = part.meta.bootGeneration ?? desc.bootGeneration;
      const page = await host.loadPage(desc);
      candidatePagesScanned++;
      const pkts = page.items as readonly DecodedSystemViewPacket[];
      const fullInside = pageFullyInsideRange(desc, request.unit, qStart, qEnd);

      // 先做轻量级预筛以尽量跳过不必要的 slices 加载
      const preMatchedIndices: number[] = [];
      for (let i = 0; i < pkts.length; i++) {
        itemsCheckedSinceYield++;
        if (itemsCheckedSinceYield >= host.yieldEveryItems) {
          itemsCheckedSinceYield = 0;
          if (host.isCancelled()) return { ok: false, cancelled: true };
          await host.yieldToLoop();
          if (host.isCancelled()) return { ok: false, cancelled: true };
        }
        const pkt = pkts[i];
        absorbPacketMetadata(host.metadata, bootGen, pkt);
        if (filter?.eventId !== undefined && pkt.eventId !== filter.eventId) continue;
        if (!isPacketInCategory(pkt, category)) continue;
        if (!fullInside) {
          const pt = getPacketTimeForUnit(pkt, request.unit, part.meta.sysFreqHz);
          if (!pt || !intersectsHalfOpen(pt.start, pt.end, qStart, qEnd, pt.isPoint)) continue;
        }
        preMatchedIndices.push(i);
      }

      if (preMatchedIndices.length > 0) {
        let slices: ExecutionSliceInterval[] = [];
        const needSlicesNow = needSliceForFilter || (matchedCount + preMatchedIndices.length > offset && collected.length < limit);
        if (needSlicesNow) {
          const firstPkt = pkts[preMatchedIndices[0]];
          const lastPkt = pkts[preMatchedIndices[preMatchedIndices.length - 1]];
          slices = await loadSlicesForPacketRange(
            host,
            part,
            firstPkt.segmentRelativeTicksBigInt,
            lastPkt.segmentRelativeTicksBigInt,
          );
        }

        for (const i of preMatchedIndices) {
          const pkt = pkts[i];
          const sliceCtx = slices.length > 0 ? findSliceForPacket(pkt, slices) : undefined;
          const dto = formatTraceEventDto({
            pkt,
            bootGeneration: bootGen,
            meta: host.metadata,
            sliceCtx,
            rodataLookup: host.rodataLookup,
            segmentSysFreqHz: part.meta.sysFreqHz,
          });
          if (!eventMatchesFilter(dto, filter!, searchLower)) continue;

          if (matchedCount >= offset && collected.length < limit) {
            collected.push(dto);
          }
          matchedCount++;
        }
      }

      if (candidatePagesScanned % host.yieldEveryPages === 0) {
        await host.yieldToLoop();
        if (host.isCancelled()) return { ok: false, cancelled: true };
      }
    }
  }

  const cacheAfter = host.getCacheStats();
  return {
    ok: true,
    data: {
      unit: request.unit,
      start: qStart.toString(),
      end: qEnd.toString(),
      offset,
      limit,
      totalMatched: matchedCount,
      totalKnownExact: !scanTruncated,
      hasMore: offset + collected.length < matchedCount || scanTruncated,
      scanTruncated,
      items: collected,
      gapsInWindow,
      segmentsInWindow,
      candidatePagesScanned,
      totalCandidatePages,
      cacheHits: cacheAfter.hits - hitsBefore,
      cacheMisses: cacheAfter.misses - missesBefore,
      skippedUnanchoredSegments,
      skippedNoFrequencySegments,
    },
  };
}

export async function executeEventLocate(
  host: TraceEventsExecutionHost,
  request: TraceEventLocateRequest,
  qStart: bigint,
  qEnd: bigint,
  targetTimeBig?: bigint,
): Promise<{ ok: true; data: TraceEventLocateResult } | { ok: false; cancelled: true }> {
  if (host.isCancelled()) return { ok: false, cancelled: true };

  const filter = request.filter;
  const filterEmpty = isFilterEmpty(filter);
  const category = filter?.category ?? 'all';
  const searchLower = (filter?.searchText ?? '').trim().slice(0, 128).toLowerCase();

  const { partitions } = host.index.getMatchingPartitions({
    bootGeneration: request.bootGeneration,
    segmentId: request.segmentId,
    unit: request.unit,
    start: qStart,
    end: qEnd,
  });

  if (qStart >= qEnd || partitions.length === 0) {
    return { ok: true, data: { found: false, exactMatch: false, rowIndex: 0, candidatePagesScanned: 0 } };
  }

  const pageEntries: Array<{ part: SegmentPartition; desc: IndexedPageDescriptor }> = [];
  for (const part of partitions) {
    const pages = await host.index.findCandidatePages(part, 'packets', request.unit, qStart, qEnd);
    for (const desc of pages) {
      pageEntries.push({ part, desc });
    }
  }

  let candidatePagesScanned = 0;
  let runningRowIndex = 0;
  let nearestFallback: { rowIndex: number; event: TraceEventDto } | undefined;

  const isExactTarget = (part: SegmentPartition, desc: IndexedPageDescriptor, pkt: DecodedSystemViewPacket): boolean => {
    const bootGen = part.meta.bootGeneration ?? desc.bootGeneration;
    if (request.targetBootGeneration !== undefined && bootGen !== request.targetBootGeneration) return false;
    if (request.targetSegmentId !== undefined && pkt.segmentId !== request.targetSegmentId) return false;
    if (request.targetPacketIndex !== undefined && pkt.packetIndexInSegment === request.targetPacketIndex) return true;
    if (request.targetByteOffset !== undefined && pkt.streamByteOffset === request.targetByteOffset) return true;
    if (targetTimeBig !== undefined && request.targetPacketIndex === undefined && request.targetByteOffset === undefined) {
      const pt = getPacketTimeForUnit(pkt, request.unit, part.meta.sysFreqHz);
      if (pt && pt.start === targetTimeBig) return true;
    }
    return false;
  };

  for (let pIdx = 0; pIdx < pageEntries.length; pIdx++) {
    if (host.isCancelled()) return { ok: false, cancelled: true };
    const { part, desc } = pageEntries[pIdx];
    const bootGen = part.meta.bootGeneration ?? desc.bootGeneration;
    const fullInside = filterEmpty && pageFullyInsideRange(desc, request.unit, qStart, qEnd);

    // 若无过滤且目标落点确定在本页之后，O(1) 累加页计数跳过读盘
    if (fullInside) {
      let skipPage = false;
      if (request.targetBootGeneration !== undefined && bootGen !== request.targetBootGeneration) {
        skipPage = true;
      } else if (request.targetSegmentId !== undefined && part.meta.segmentId !== request.targetSegmentId) {
        skipPage = true;
      } else if (request.targetByteOffset !== undefined && desc.maxByteOffset < request.targetByteOffset) {
        skipPage = true;
      } else if (targetTimeBig !== undefined && request.targetPacketIndex === undefined && request.targetByteOffset === undefined) {
        const descMaxForUnit = (() => {
          switch (request.unit) {
            case 'relative-ticks': return BigInt(desc.maxRelativeTicks);
            case 'absolute-ticks': return desc.maxAbsoluteTicks ? BigInt(desc.maxAbsoluteTicks) : undefined;
            case 'ns': return desc.maxNs ? BigInt(desc.maxNs) : undefined;
            case 'relative-ns':
              return desc.sysFreqHz ? (BigInt(desc.maxRelativeTicks) * 1_000_000_000n) / BigInt(desc.sysFreqHz) : undefined;
            case 'byte-offset': return BigInt(desc.maxByteOffset);
          }
        })();
        if (descMaxForUnit !== undefined && descMaxForUnit < targetTimeBig) {
          skipPage = true;
        }
      }
      if (skipPage) {
        runningRowIndex += desc.itemCount;
        continue;
      }
    }

    const page = await host.loadPage(desc);
    candidatePagesScanned++;
    const pkts = page.items as readonly DecodedSystemViewPacket[];

    const matchedIndices: number[] = [];
    for (let i = 0; i < pkts.length; i++) {
      const pkt = pkts[i];
      absorbPacketMetadata(host.metadata, bootGen, pkt);
      if (!filterEmpty) {
        if (filter?.eventId !== undefined && pkt.eventId !== filter.eventId) continue;
        if (!isPacketInCategory(pkt, category)) continue;
      }
      if (!fullInside) {
        const pt = getPacketTimeForUnit(pkt, request.unit, part.meta.sysFreqHz);
        if (!pt || !intersectsHalfOpen(pt.start, pt.end, qStart, qEnd, pt.isPoint)) continue;
      }
      matchedIndices.push(i);
    }

    if (matchedIndices.length > 0) {
      const firstPkt = pkts[matchedIndices[0]];
      const lastPkt = pkts[matchedIndices[matchedIndices.length - 1]];
      const slices = await loadSlicesForPacketRange(
        host,
        part,
        firstPkt.segmentRelativeTicksBigInt,
        lastPkt.segmentRelativeTicksBigInt,
      );

      for (const i of matchedIndices) {
        const pkt = pkts[i];
        const sliceCtx = findSliceForPacket(pkt, slices);
        const dto = formatTraceEventDto({
          pkt,
          bootGeneration: bootGen,
          meta: host.metadata,
          sliceCtx,
          rodataLookup: host.rodataLookup,
          segmentSysFreqHz: part.meta.sysFreqHz,
        });
        if (!filterEmpty && !eventMatchesFilter(dto, filter!, searchLower)) {
          continue;
        }

        const currentRowIdx = runningRowIndex++;
        if (isExactTarget(part, desc, pkt)) {
          return {
            ok: true,
            data: {
              found: true,
              exactMatch: true,
              rowIndex: currentRowIdx,
              event: dto,
              candidatePagesScanned,
            },
          };
        }

        if (targetTimeBig !== undefined && !nearestFallback) {
          const sameSeg =
            (request.targetBootGeneration === undefined || bootGen === request.targetBootGeneration) &&
            (request.targetSegmentId === undefined || part.meta.segmentId === request.targetSegmentId);
          if (sameSeg) {
            const pt = getPacketTimeForUnit(pkt, request.unit, part.meta.sysFreqHz);
            if (pt && pt.start >= targetTimeBig) {
              nearestFallback = { rowIndex: currentRowIdx, event: dto };
              if (request.targetPacketIndex === undefined && request.targetByteOffset === undefined) {
                return {
                  ok: true,
                  data: {
                    found: true,
                    exactMatch: pt.start === targetTimeBig,
                    rowIndex: currentRowIdx,
                    event: dto,
                    candidatePagesScanned,
                  },
                };
              }
            }
          }
        }
      }
    }

    if (candidatePagesScanned % host.yieldEveryPages === 0) {
      await host.yieldToLoop();
      if (host.isCancelled()) return { ok: false, cancelled: true };
    }
  }

  if (nearestFallback) {
    return {
      ok: true,
      data: {
        found: true,
        exactMatch: false,
        rowIndex: nearestFallback.rowIndex,
        event: nearestFallback.event,
        candidatePagesScanned,
      },
    };
  }

  return {
    ok: true,
    data: {
      found: false,
      exactMatch: false,
      rowIndex: 0,
      candidatePagesScanned,
    },
  };
}

export async function executeTerminalQuery(
  host: TraceEventsExecutionHost,
  request: TraceTerminalQueryRequest,
  qStart: bigint,
  qEnd: bigint,
): Promise<{ ok: true; data: TraceTerminalQueryResult } | { ok: false; cancelled: true }> {
  if (host.isCancelled()) return { ok: false, cancelled: true };

  const offset = Math.max(0, Math.floor(request.offset ?? 0));
  const limit = Math.max(1, Math.min(500, Math.floor(request.limit ?? 200)));
  const level = request.level ?? 'all';
  const searchLower = (request.searchText ?? '').trim().slice(0, 128).toLowerCase();
  const mergeAppend = request.mergeAppend ?? true;
  const maxScanPages = request.maxScanPages ?? Number.MAX_SAFE_INTEGER;

  const { partitions, skippedUnanchoredSegments, skippedNoFrequencySegments } = host.index.getMatchingPartitions({
    bootGeneration: request.bootGeneration,
    segmentId: request.segmentId,
    unit: request.unit,
    start: qStart,
    end: qEnd,
  });

  if (qStart >= qEnd || partitions.length === 0) {
    return {
      ok: true,
      data: {
        unit: request.unit,
        start: qStart.toString(),
        end: qEnd.toString(),
        offset,
        limit,
        totalLines: 0,
        totalKnownExact: true,
        hasMore: false,
        scanTruncated: false,
        lines: [],
        gapsInWindow: [],
        segmentsInWindow: [],
        candidatePagesScanned: 0,
        skippedUnanchoredSegments,
        skippedNoFrequencySegments,
      },
    };
  }

  const segmentsInWindow = partitions.map(p => p.meta);
  const gapsInWindow = collectWindowGaps(host, partitions, request.unit, qStart, qEnd);
  const paged: TraceTerminalLineDto[] = [];
  let totalFilteredLines = 0;
  let pendingLine: TraceTerminalLineDto | null = null;
  let candidatePagesScanned = 0;
  let scanTruncated = false;

  const lineMatches = (line: TraceTerminalLineDto): boolean => {
    if (level === 'log' && line.logLevel !== 0) return false;
    if (level === 'warning' && line.logLevel !== 1) return false;
    if (level === 'error' && line.logLevel !== 2) return false;
    if (searchLower.length > 0) {
      const hay = [
        line.renderedText,
        line.contextLabel ?? '',
        line.stringAddressHex ?? '',
        line.logLevelLabel,
        line.warnings.join(' '),
      ].join(' ').toLowerCase();
      if (!hay.includes(searchLower)) return false;
    }
    return true;
  };

  const commitPendingLine = () => {
    if (!pendingLine) return;
    if (lineMatches(pendingLine)) {
      if (totalFilteredLines >= offset && paged.length < limit) {
        paged.push(pendingLine);
      }
      totalFilteredLines++;
    }
    pendingLine = null;
  };

  for (const part of partitions) {
    const pages = await host.index.findCandidatePages(part, 'packets', request.unit, qStart, qEnd);
    for (const desc of pages) {
      if (host.isCancelled()) return { ok: false, cancelled: true };
      if (candidatePagesScanned >= maxScanPages) {
        scanTruncated = true;
        break;
      }

      const bootGen = part.meta.bootGeneration ?? desc.bootGeneration;
      const page = await host.loadPage(desc);
      candidatePagesScanned++;
      const pkts = page.items as readonly DecodedSystemViewPacket[];
      const fullInside = pageFullyInsideRange(desc, request.unit, qStart, qEnd);

      const termIndices: number[] = [];
      for (let i = 0; i < pkts.length; i++) {
        const pkt = pkts[i];
        absorbPacketMetadata(host.metadata, bootGen, pkt);
        if (pkt.decoded.kind !== 'print-formatted' && pkt.decoded.kind !== 'ex-print-elf') continue;
        if (!fullInside) {
          const pt = getPacketTimeForUnit(pkt, request.unit, part.meta.sysFreqHz);
          if (!pt || !intersectsHalfOpen(pt.start, pt.end, qStart, qEnd, pt.isPoint)) continue;
        }
        termIndices.push(i);
      }

      if (termIndices.length > 0) {
        const firstPkt = pkts[termIndices[0]];
        const lastPkt = pkts[termIndices[termIndices.length - 1]];
        const slices = await loadSlicesForPacketRange(
          host,
          part,
          firstPkt.segmentRelativeTicksBigInt,
          lastPkt.segmentRelativeTicksBigInt,
        );

        for (const i of termIndices) {
          const pkt = pkts[i];
          const sliceCtx = findSliceForPacket(pkt, slices);
          const dto = formatTraceEventDto({
            pkt,
            bootGeneration: bootGen,
            meta: host.metadata,
            sliceCtx,
            rodataLookup: host.rodataLookup,
            segmentSysFreqHz: part.meta.sysFreqHz,
          });
          const te = dto.terminalEntry;
          if (!te) continue;

          const curPending = pendingLine as TraceTerminalLineDto | null;
          const canMerge =
            mergeAppend &&
            te.append &&
            curPending !== null &&
            curPending.bootGeneration === dto.bootGeneration &&
            curPending.segmentId === dto.segmentId &&
            curPending.contextKey === dto.contextKey;

          if (canMerge && curPending !== null) {
            const combinedText: string = (curPending.renderedText + te.renderedText).slice(0, 8192);
            pendingLine = {
              ...curPending,
              mergedPacketCount: curPending.mergedPacketCount + 1,
              renderedText: combinedText,
              warnings: [...curPending.warnings, ...te.warnings],
            };
          } else {
            const hadPrev: boolean = curPending !== null;
            const prevBoot: number | undefined = curPending?.bootGeneration;
            const prevSeg: number | undefined = curPending?.segmentId;
            commitPendingLine();

            const appendBrokenReason: string | undefined = te.append
              ? hadPrev
                ? prevBoot !== dto.bootGeneration || prevSeg !== dto.segmentId
                  ? '跨断段/启动代次不可合并追加'
                  : '上下文切换，未自动拼接'
                : dto.bootGeneration > 1 || dto.segmentId > 1
                  ? '跨断段/重启边界或起始位置缺少可合并前驱，未自动拼接'
                  : undefined
              : undefined;

            pendingLine = {
              lineKey: `term:${dto.eventKey}`,
              eventKey: dto.eventKey,
              bootGeneration: dto.bootGeneration,
              segmentId: dto.segmentId,
              segmentReliability: dto.segmentReliability,
              packetIndexInSegment: dto.packetIndexInSegment,
              streamByteOffset: dto.streamByteOffset,
              relTicks: dto.relTicks,
              ...(dto.absTicks !== undefined ? { absTicks: dto.absTicks } : {}),
              ...(dto.ns !== undefined ? { ns: dto.ns } : {}),
              ...(dto.sysFreqHz !== undefined ? { sysFreqHz: dto.sysFreqHz } : {}),
              timeDomain: dto.timeDomain,
              logLevel: te.logLevel,
              logLevelLabel: te.logLevelLabel,
              append: te.append,
              mergedPacketCount: 1,
              ...(appendBrokenReason ? { appendBrokenReason } : {}),
              contextKind: dto.contextKind,
              ...(dto.contextKey ? { contextKey: dto.contextKey } : {}),
              ...(dto.contextLabel ? { contextLabel: dto.contextLabel } : {}),
              ...(dto.contextLabelSource ? { contextLabelSource: dto.contextLabelSource } : {}),
              isrDepth: dto.isrDepth,
              nestedIsr: dto.nestedIsr,
              renderedText: te.renderedText,
              formatSource: te.formatSource,
              ...(te.rawFormatText !== undefined ? { rawFormatText: te.rawFormatText } : {}),
              ...(te.stringAddress !== undefined ? { stringAddress: te.stringAddress } : {}),
              ...(te.stringAddressHex ? { stringAddressHex: te.stringAddressHex } : {}),
              ...(te.addressStatus ? { addressStatus: te.addressStatus } : {}),
              args: te.args,
              warnings: te.warnings,
            };
          }
        }
      }

      if (candidatePagesScanned % host.yieldEveryPages === 0) {
        await host.yieldToLoop();
        if (host.isCancelled()) return { ok: false, cancelled: true };
      }
    }
    if (scanTruncated) break;
  }

  commitPendingLine();

  return {
    ok: true,
    data: {
      unit: request.unit,
      start: qStart.toString(),
      end: qEnd.toString(),
      offset,
      limit,
      totalLines: totalFilteredLines,
      totalKnownExact: !scanTruncated,
      hasMore: offset + paged.length < totalFilteredLines || scanTruncated,
      scanTruncated,
      lines: paged,
      gapsInWindow,
      segmentsInWindow,
      candidatePagesScanned,
      skippedUnanchoredSegments,
      skippedNoFrequencySegments,
    },
  };
}

export function createTraceEventMetadataContext(): TraceEventMetadataContext {
  return buildEmptyMetadataContext();
}
