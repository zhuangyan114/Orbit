import type {
  DecodedSystemViewPacket,
  SegmentReliability,
  TimeAnchorStatus,
  TraceGapKind,
} from './systemview-decoder';
import type {
  ContextActivationInterval,
  ExecutionSliceInterval,
  MarkerInterval,
  MarkerPointEvent,
  ReadyWaitInterval,
  TraceTimePoint,
} from './systemview-reconstructor';
import type {
  IndexedPageDescriptor,
  SegmentIndexMetadata,
  StoredGapEntry,
  TracePageKind,
} from './trace-format';

export type TraceQueryTimeUnit =
  | 'relative-ticks'
  | 'absolute-ticks'
  | 'ns'
  | 'relative-ns'
  | 'byte-offset';

export type TraceQueryTarget =
  | 'packets'
  | 'slices'
  | 'activations'
  | 'readyWaits'
  | 'markers'
  | 'markerPoints';

export interface HalfOpenRange {
  readonly start: bigint | string | number;
  readonly end: bigint | string | number;
  readonly unit: TraceQueryTimeUnit;
}

export interface PageLodSummary {
  readonly pageId: number;
  readonly kind: TracePageKind;
  readonly bootGeneration: number;
  readonly segmentId: number;
  readonly minRelativeTicks: string;
  readonly maxRelativeTicks: string;
  readonly minAbsoluteTicks?: string;
  readonly maxAbsoluteTicks?: string;
  readonly sysFreqHz?: number;
  readonly minNs?: string;
  readonly maxNs?: string;
  readonly itemCount: number;
  readonly hasIncomplete: boolean;
  readonly hasUncertain: boolean;
  readonly sliceTicksByKind?: {
    readonly task: string;
    readonly isr: string;
    readonly idle: string;
    readonly scheduler: string;
  };
  readonly dominantContext?: {
    readonly contextKind: string;
    readonly contextKey: string;
    readonly label?: string;
    readonly ticks: string;
  };
}

export interface TraceLodBucket {
  readonly bucketIndex: number;
  readonly bootGeneration: number;
  readonly segmentId: number;
  readonly unit: TraceQueryTimeUnit;
  readonly start: string;
  readonly end: string;
  readonly startBigInt: bigint;
  readonly endBigInt: bigint;
  readonly packetCount: number;
  readonly intervalCount: number;
  readonly markerCount: number;
  readonly hasGap: boolean;
  readonly gapKinds: readonly string[];
  readonly hasIncomplete: boolean;
  readonly hasUncertain: boolean;
  readonly activeTicksByKind: {
    readonly task: string;
    readonly isr: string;
    readonly idle: string;
    readonly scheduler: string;
  };
  readonly dominantContext?: {
    readonly contextKind: string;
    readonly contextKey: string;
    readonly label?: string;
    readonly ticks: string;
  };
}

export interface CompactedDirectoryBlock {
  readonly blockId: number;
  readonly bootGeneration: number;
  readonly segmentId: number;
  readonly kind: TracePageKind;
  readonly minRelativeTicks: string;
  readonly maxRelativeTicks: string;
  readonly hasAbsoluteTicks: boolean;
  readonly minAbsoluteTicks?: string;
  readonly maxAbsoluteTicks?: string;
  readonly sysFreqHz?: number;
  readonly minNs?: string;
  readonly maxNs?: string;
  readonly minByteOffset: number;
  readonly maxByteOffset: number;
  readonly pageCount: number;
  /** 溢写时仅在外部目录文件/持久化快照按需加载，不在常驻内存中持有。 */
  readonly spillOffset: number;
  readonly spillLength: number;
}

export function parseRangeBoundBigInt(value: bigint | string | number, name: string): bigint {
  if (typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      throw new RangeError(`${name} must be an integer, got ${value}`);
    }
    return BigInt(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^-?\d+$/.test(trimmed)) {
      throw new RangeError(`${name} must be a decimal integer string, got "${value}"`);
    }
    return BigInt(trimmed);
  }
  throw new TypeError(`${name} must be bigint, integer number, or decimal string`);
}

export function ticksToNsBigInt(ticks: bigint, sysFreqHz: number): bigint {
  return (ticks * 1_000_000_000n) / BigInt(sysFreqHz);
}

/**
 * 精确半开区间 `[qStart, qEnd)` 相交判定：
 * - 点事件 (`isPoint === true` 或 `itemStart === itemEnd`)：`qStart <= itemStart && itemStart < qEnd`
 * - 闭区间/有效跨度 (`itemEnd > itemStart`)：`itemStart < qEnd && itemEnd > qStart`
 */
export function intersectsHalfOpen(
  itemStart: bigint,
  itemEnd: bigint | undefined,
  qStart: bigint,
  qEnd: bigint,
  isPoint = false,
): boolean {
  if (qStart >= qEnd) {
    return false;
  }
  if (isPoint || itemEnd === undefined || itemEnd <= itemStart) {
    return itemStart >= qStart && itemStart < qEnd;
  }
  return itemStart < qEnd && itemEnd > qStart;
}

export function getTimePointValueForUnit(
  point: TraceTimePoint | undefined,
  unit: TraceQueryTimeUnit,
  segmentSysFreqHz?: number,
): bigint | undefined {
  if (!point) {
    return undefined;
  }
  switch (unit) {
    case 'relative-ticks':
      return point.relativeTicksBigInt;
    case 'absolute-ticks':
      return point.absoluteTicksBigInt;
    case 'ns': {
      if (point.timestampNs !== undefined) {
        return BigInt(point.timestampNs);
      }
      const freq = point.sysFreqHz ?? segmentSysFreqHz;
      if (point.absoluteTicksBigInt !== undefined && freq !== undefined && freq > 0) {
        return ticksToNsBigInt(point.absoluteTicksBigInt, freq);
      }
      return undefined;
    }
    case 'relative-ns': {
      const freq = point.sysFreqHz ?? segmentSysFreqHz;
      if (freq !== undefined && freq > 0) {
        return ticksToNsBigInt(point.relativeTicksBigInt, freq);
      }
      return undefined;
    }
    case 'byte-offset':
      return BigInt(point.streamByteOffset);
  }
}

export function getPacketTimeForUnit(
  pkt: DecodedSystemViewPacket,
  unit: TraceQueryTimeUnit,
  segmentSysFreqHz?: number,
): { start: bigint; end?: bigint; isPoint: boolean } | undefined {
  switch (unit) {
    case 'relative-ticks':
      return { start: pkt.segmentRelativeTicksBigInt, isPoint: true };
    case 'absolute-ticks':
      return pkt.absoluteTicksBigInt !== undefined ? { start: pkt.absoluteTicksBigInt, isPoint: true } : undefined;
    case 'ns': {
      if (pkt.timestampNs !== undefined) {
        return { start: BigInt(pkt.timestampNs), isPoint: true };
      }
      const freq = pkt.sysFreqHz ?? segmentSysFreqHz;
      if (pkt.absoluteTicksBigInt !== undefined && freq !== undefined && freq > 0) {
        return { start: ticksToNsBigInt(pkt.absoluteTicksBigInt, freq), isPoint: true };
      }
      return undefined;
    }
    case 'relative-ns': {
      const freq = pkt.sysFreqHz ?? segmentSysFreqHz;
      if (freq !== undefined && freq > 0) {
        return { start: ticksToNsBigInt(pkt.segmentRelativeTicksBigInt, freq), isPoint: true };
      }
      return undefined;
    }
    case 'byte-offset': {
      const s = BigInt(pkt.streamByteOffset);
      const e = s + BigInt(Math.max(1, pkt.byteLength));
      return { start: s, end: e, isPoint: false };
    }
  }
}

export interface IntervalBoundsForUnit {
  readonly start: bigint;
  readonly end?: bigint;
  readonly isPoint: boolean;
}

export function getIntervalBoundsForUnit(
  item: ExecutionSliceInterval | ContextActivationInterval | ReadyWaitInterval | MarkerInterval,
  unit: TraceQueryTimeUnit,
  segmentMeta?: SegmentIndexMetadata,
): IntervalBoundsForUnit | undefined {
  const freq = item.start?.sysFreqHz ?? item.end?.sysFreqHz ?? segmentMeta?.sysFreqHz;
  const s = getTimePointValueForUnit(item.start, unit, freq);
  if (s === undefined) {
    return undefined;
  }
  let e = getTimePointValueForUnit(item.end ?? item.observedUntil, unit, freq);
  if (e === undefined && segmentMeta) {
    // 对不完整区间：若已知该段在对应单位下的结束界限，则作为观察上界，不伪造完整 end
    switch (unit) {
      case 'relative-ticks':
        e = BigInt(segmentMeta.maxRelativeTicks);
        break;
      case 'absolute-ticks':
        if (segmentMeta.lastAbsoluteTicks !== undefined) {
          e = BigInt(segmentMeta.lastAbsoluteTicks);
        }
        break;
      case 'ns':
        if (segmentMeta.maxNs !== undefined) {
          e = BigInt(segmentMeta.maxNs);
        } else if (segmentMeta.lastAbsoluteTicks !== undefined && freq !== undefined && freq > 0) {
          e = ticksToNsBigInt(BigInt(segmentMeta.lastAbsoluteTicks), freq);
        }
        break;
      case 'relative-ns':
        if (freq !== undefined && freq > 0) {
          e = ticksToNsBigInt(BigInt(segmentMeta.maxRelativeTicks), freq);
        }
        break;
      case 'byte-offset':
        if (segmentMeta.endByteOffset !== undefined) {
          e = BigInt(segmentMeta.endByteOffset);
        }
        break;
    }
  }
  if (e === undefined || e <= s) {
    return { start: s, end: s, isPoint: true };
  }
  return { start: s, end: e, isPoint: false };
}

export function getMarkerPointTimeForUnit(
  mp: MarkerPointEvent,
  unit: TraceQueryTimeUnit,
  segmentMeta?: SegmentIndexMetadata,
): { start: bigint; isPoint: true } | undefined {
  const v = getTimePointValueForUnit(mp.time, unit, segmentMeta?.sysFreqHz);
  return v !== undefined ? { start: v, isPoint: true } : undefined;
}

export function descriptorBoundsForUnit(
  desc: IndexedPageDescriptor | CompactedDirectoryBlock,
  unit: TraceQueryTimeUnit,
): { min: bigint; max: bigint; valid: boolean } {
  switch (unit) {
    case 'relative-ticks':
      return {
        min: BigInt(desc.minRelativeTicks),
        max: BigInt(desc.maxRelativeTicks),
        valid: true,
      };
    case 'absolute-ticks':
      if (!desc.hasAbsoluteTicks || desc.minAbsoluteTicks === undefined || desc.maxAbsoluteTicks === undefined) {
        return { min: 0n, max: 0n, valid: false };
      }
      return {
        min: BigInt(desc.minAbsoluteTicks),
        max: BigInt(desc.maxAbsoluteTicks),
        valid: true,
      };
    case 'ns':
      if (desc.minNs !== undefined && desc.maxNs !== undefined) {
        return { min: BigInt(desc.minNs), max: BigInt(desc.maxNs), valid: true };
      }
      if (
        desc.hasAbsoluteTicks &&
        desc.minAbsoluteTicks !== undefined &&
        desc.maxAbsoluteTicks !== undefined &&
        desc.sysFreqHz !== undefined &&
        desc.sysFreqHz > 0
      ) {
        return {
          min: ticksToNsBigInt(BigInt(desc.minAbsoluteTicks), desc.sysFreqHz),
          max: ticksToNsBigInt(BigInt(desc.maxAbsoluteTicks), desc.sysFreqHz),
          valid: true,
        };
      }
      return { min: 0n, max: 0n, valid: false };
    case 'relative-ns':
      if (desc.sysFreqHz === undefined || desc.sysFreqHz <= 0) {
        return { min: 0n, max: 0n, valid: false };
      }
      return {
        min: ticksToNsBigInt(BigInt(desc.minRelativeTicks), desc.sysFreqHz),
        max: ticksToNsBigInt(BigInt(desc.maxRelativeTicks), desc.sysFreqHz),
        valid: true,
      };
    case 'byte-offset':
      return {
        min: BigInt(desc.minByteOffset),
        max: BigInt(desc.maxByteOffset),
        valid: true,
      };
  }
}

export function pageDescriptorIntersectsRange(
  desc: IndexedPageDescriptor | CompactedDirectoryBlock,
  unit: TraceQueryTimeUnit,
  qStart: bigint,
  qEnd: bigint,
  isPointKind: boolean,
): boolean {
  const b = descriptorBoundsForUnit(desc, unit);
  if (!b.valid) {
    return false;
  }
  if (isPointKind || b.max <= b.min) {
    // 对点集合或零长度页：页范围 [min, max] 含端点 max，需与 [qStart, qEnd) 存在交集
    return b.min < qEnd && b.max >= qStart;
  }
  return b.min < qEnd && b.max > qStart;
}

export function segmentKey(bootGeneration: number, segmentId: number): string {
  return `${bootGeneration}:${segmentId}`;
}

export interface SegmentPartition {
  readonly key: string;
  meta: SegmentIndexMetadata;
  readonly pagesByKind: Map<TracePageKind, IndexedPageDescriptor[]>;
  readonly prefixMaxRelEndByKind: Map<TracePageKind, bigint[]>;
  readonly monotonicMinRelByKind: Map<TracePageKind, boolean>;
  readonly lodSummaries: PageLodSummary[];
}

export interface SpillIndexBlockHandler {
  spillDescriptors(
    bootGeneration: number,
    segmentId: number,
    kind: TracePageKind,
    descriptors: readonly IndexedPageDescriptor[],
  ): Promise<CompactedDirectoryBlock>;
  loadSpilledDescriptors(block: CompactedDirectoryBlock): Promise<readonly IndexedPageDescriptor[]>;
}

export interface RangeIndexOptions {
  readonly maxIndexPagesInMemory?: number;
  readonly maxLodSummariesPerSegment?: number;
  readonly spillHandler?: SpillIndexBlockHandler;
}

export interface RangeIndexStats {
  readonly segmentCount: number;
  readonly inMemoryPageDescriptors: number;
  readonly peakInMemoryPageDescriptors: number;
  readonly compactedDirectoryBlocks: number;
  readonly totalIndexedPages: number;
  readonly inMemoryLodSummaries: number;
  readonly peakInMemoryLodSummaries: number;
  readonly maxIndexPagesInMemory: number;
}

/**
 * Trace 范围与 LOD 索引（阶段 4.3）：
 * - 按 `(bootGeneration, segmentId)` 分区，隔离多段相对 tick 回零；
 * - 常规时间页保留紧致边界并使用前缀 `maxEnd` + 二分定位；跨页/长区间归入 `long*` 专用分页；
 * - 支持 `relative-ticks`、`absolute-ticks`、`ns`、`relative-ns`、`byte-offset` 半开区间 `[start, end)`；
 * - 对内存中的页描述符与 LOD 摘要强制执行可量化上限，超出时按块溢写并保留粗粒度目录边界。
 */
export class TraceRangeIndex {
  private readonly maxIndexPagesInMemory: number;
  private readonly maxLodSummariesPerSegment: number;
  private readonly spillHandler?: SpillIndexBlockHandler;

  private readonly partitions = new Map<string, SegmentPartition>();
  private readonly partitionOrder: string[] = [];
  private readonly compactedBlocks: CompactedDirectoryBlock[] = [];
  private readonly gaps: StoredGapEntry[] = [];

  private inMemoryPageCount = 0;
  private peakInMemoryPageCount = 0;
  private totalIndexedPages = 0;
  private inMemoryLodCount = 0;
  private peakInMemoryLodCount = 0;

  public constructor(options: RangeIndexOptions = {}) {
    this.maxIndexPagesInMemory = options.maxIndexPagesInMemory ?? 16384;
    this.maxLodSummariesPerSegment = options.maxLodSummariesPerSegment ?? 4096;
    this.spillHandler = options.spillHandler;
  }

  public getStats(): RangeIndexStats {
    return {
      segmentCount: this.partitions.size,
      inMemoryPageDescriptors: this.inMemoryPageCount,
      peakInMemoryPageDescriptors: this.peakInMemoryPageCount,
      compactedDirectoryBlocks: this.compactedBlocks.length,
      totalIndexedPages: this.totalIndexedPages,
      inMemoryLodSummaries: this.inMemoryLodCount,
      peakInMemoryLodSummaries: this.peakInMemoryLodCount,
      maxIndexPagesInMemory: this.maxIndexPagesInMemory,
    };
  }

  public upsertSegment(meta: SegmentIndexMetadata): void {
    const key = segmentKey(meta.bootGeneration, meta.segmentId);
    const existing = this.partitions.get(key);
    if (existing) {
      existing.meta = mergeSegmentMetadata(existing.meta, meta);
      return;
    }
    this.partitions.set(key, {
      key,
      meta,
      pagesByKind: new Map(),
      prefixMaxRelEndByKind: new Map(),
      monotonicMinRelByKind: new Map(),
      lodSummaries: [],
    });
    this.partitionOrder.push(key);
  }

  public addGap(gap: StoredGapEntry): void {
    this.gaps.push(gap);
  }

  public getGaps(): readonly StoredGapEntry[] {
    return this.gaps;
  }

  public getSegments(): readonly SegmentIndexMetadata[] {
    return this.partitionOrder.map((k) => this.partitions.get(k)!.meta);
  }

  public getSegment(bootGeneration: number, segmentId: number): SegmentIndexMetadata | undefined {
    return this.partitions.get(segmentKey(bootGeneration, segmentId))?.meta;
  }

  public getAllInMemoryPages(): IndexedPageDescriptor[] {
    const out: IndexedPageDescriptor[] = [];
    for (const key of this.partitionOrder) {
      const p = this.partitions.get(key)!;
      for (const list of p.pagesByKind.values()) {
        for (const d of list) {
          out.push(d);
        }
      }
    }
    return out;
  }

  public addPage(desc: IndexedPageDescriptor, lodSummary?: PageLodSummary): void {
    const key = segmentKey(desc.bootGeneration, desc.segmentId);
    let part = this.partitions.get(key);
    if (!part) {
      part = {
        key,
        meta: {
          bootGeneration: desc.bootGeneration,
          segmentId: desc.segmentId,
          startByteOffset: desc.minByteOffset,
          endByteOffset: desc.maxByteOffset,
          reliability: desc.hasUncertain ? 'uncertain' : 'trusted',
          closed: false,
          packetCount: desc.kind === 'packets' ? desc.itemCount : 0,
          syncCount: 0,
          timestampBits: 32,
          timestampWrapCount: 0,
          timeAnchorStatus: desc.hasAbsoluteTicks ? 'anchored-cycles' : 'unanchored',
          minRelativeTicks: desc.minRelativeTicks,
          maxRelativeTicks: desc.maxRelativeTicks,
          firstAbsoluteTicks: desc.minAbsoluteTicks,
          lastAbsoluteTicks: desc.maxAbsoluteTicks,
          sysFreqHz: desc.sysFreqHz,
          minNs: desc.minNs,
          maxNs: desc.maxNs,
        },
        pagesByKind: new Map(),
        prefixMaxRelEndByKind: new Map(),
        monotonicMinRelByKind: new Map(),
        lodSummaries: [],
      };
      this.partitions.set(key, part);
      this.partitionOrder.push(key);
    }

    let list = part.pagesByKind.get(desc.kind);
    let prefixMax = part.prefixMaxRelEndByKind.get(desc.kind);
    if (!list || !prefixMax) {
      list = [];
      prefixMax = [];
      part.pagesByKind.set(desc.kind, list);
      part.prefixMaxRelEndByKind.set(desc.kind, prefixMax);
      part.monotonicMinRelByKind.set(desc.kind, true);
    }

    const minRel = BigInt(desc.minRelativeTicks);
    const maxRel = BigInt(desc.maxRelativeTicks);
    if (list.length > 0) {
      const prevMinRel = BigInt(list[list.length - 1].minRelativeTicks);
      if (minRel < prevMinRel) {
        part.monotonicMinRelByKind.set(desc.kind, false);
      }
    }
    const prevPrefixMax = prefixMax.length > 0 ? prefixMax[prefixMax.length - 1] : maxRel;
    prefixMax.push(maxRel > prevPrefixMax ? maxRel : prevPrefixMax);
    list.push(desc);

    this.inMemoryPageCount += 1;
    this.totalIndexedPages += 1;
    if (this.inMemoryPageCount > this.peakInMemoryPageCount) {
      this.peakInMemoryPageCount = this.inMemoryPageCount;
    }

    if (lodSummary) {
      this.addLodSummary(part, lodSummary);
    }
  }

  /**
   * 当内存中的页描述符达到上限时，将最早分区的部分页描述符溢写为粗粒度目录块。
   */
  public async enforceMemoryBounds(): Promise<void> {
    if (this.inMemoryPageCount <= this.maxIndexPagesInMemory || !this.spillHandler) {
      return;
    }
    const target = Math.max(1, Math.floor(this.maxIndexPagesInMemory * 0.75));

    const spillKindList = async (
      part: SegmentPartition,
      kind: TracePageKind,
      list: IndexedPageDescriptor[],
      minKeep: number,
    ): Promise<void> => {
      if (list.length <= minKeep) {
        return;
      }
      const spillCount = Math.min(list.length - minKeep, Math.max(1, list.length - minKeep));
      const spilled = list.slice(0, spillCount);
      const block = await this.spillHandler!.spillDescriptors(
        part.meta.bootGeneration,
        part.meta.segmentId,
        kind,
        spilled,
      );
      this.compactedBlocks.push(block);
      const remaining = list.slice(spillCount);
      part.pagesByKind.set(kind, remaining);
      const rebuiltPrefix: bigint[] = [];
      let running = 0n;
      for (let i = 0; i < remaining.length; i++) {
        const m = BigInt(remaining[i].maxRelativeTicks);
        running = i === 0 || m > running ? m : running;
        rebuiltPrefix.push(running);
      }
      part.prefixMaxRelEndByKind.set(kind, rebuiltPrefix);
      this.inMemoryPageCount -= spillCount;
    };

    // 第 1 轮：每个分区每种类型优先保留最新 1 页
    for (const key of this.partitionOrder) {
      if (this.inMemoryPageCount <= target) {
        break;
      }
      const part = this.partitions.get(key)!;
      for (const [kind, list] of part.pagesByKind.entries()) {
        if (this.inMemoryPageCount <= target) {
          break;
        }
        await spillKindList(part, kind, list, 1);
      }
    }

    // 第 2 轮：若类目过多导致仍超过硬上限，则彻底溢写较早条目直到不超过 maxIndexPagesInMemory
    if (this.inMemoryPageCount > this.maxIndexPagesInMemory) {
      for (const key of this.partitionOrder) {
        if (this.inMemoryPageCount <= this.maxIndexPagesInMemory) {
          break;
        }
        const part = this.partitions.get(key)!;
        for (const [kind, list] of part.pagesByKind.entries()) {
          if (this.inMemoryPageCount <= this.maxIndexPagesInMemory) {
            break;
          }
          await spillKindList(part, kind, list, 0);
        }
      }
    }
  }

  private addLodSummary(part: SegmentPartition, summary: PageLodSummary): void {
    part.lodSummaries.push(summary);
    this.inMemoryLodCount += 1;
    if (part.lodSummaries.length > this.maxLodSummariesPerSegment) {
      // 合并最早相邻两条 LOD 摘要，保持时间覆盖连续且总数有界
      const merged = mergeTwoLodSummaries(part.lodSummaries[0], part.lodSummaries[1]);
      part.lodSummaries.splice(0, 2, merged);
      this.inMemoryLodCount -= 1;
    }
    if (this.inMemoryLodCount > this.peakInMemoryLodCount) {
      this.peakInMemoryLodCount = this.inMemoryLodCount;
    }
  }

  public getMatchingPartitions(filter: {
    bootGeneration?: number;
    segmentId?: number;
    unit: TraceQueryTimeUnit;
    start: bigint;
    end: bigint;
  }): {
    partitions: SegmentPartition[];
    skippedUnanchoredSegments: number[];
    skippedNoFrequencySegments: number[];
  } {
    const matched: SegmentPartition[] = [];
    const skippedUnanchoredSegments: number[] = [];
    const skippedNoFrequencySegments: number[] = [];

    for (const key of this.partitionOrder) {
      const part = this.partitions.get(key)!;
      if (filter.bootGeneration !== undefined && part.meta.bootGeneration !== filter.bootGeneration) {
        continue;
      }
      if (filter.segmentId !== undefined && part.meta.segmentId !== filter.segmentId) {
        continue;
      }
      if (filter.unit === 'absolute-ticks' || filter.unit === 'ns') {
        if (part.meta.firstAbsoluteTicks === undefined || part.meta.lastAbsoluteTicks === undefined) {
          skippedUnanchoredSegments.push(part.meta.segmentId);
          continue;
        }
      }
      if (filter.unit === 'ns' || filter.unit === 'relative-ns') {
        if (part.meta.sysFreqHz === undefined || part.meta.sysFreqHz <= 0) {
          skippedNoFrequencySegments.push(part.meta.segmentId);
          continue;
        }
      }
      matched.push(part);
    }

    return {
      partitions: matched,
      skippedUnanchoredSegments,
      skippedNoFrequencySegments,
    };
  }

  /**
   * 定位指定分区与类型下可能与 `[qStart, qEnd)` 相交的所有页描述符（包括常规页、长区间页及已溢写目录块）。
   */
  public async findCandidatePages(
    part: SegmentPartition,
    kind: TracePageKind,
    unit: TraceQueryTimeUnit,
    qStart: bigint,
    qEnd: bigint,
  ): Promise<IndexedPageDescriptor[]> {
    if (qStart >= qEnd) {
      return [];
    }
    const isPointKind = kind === 'packets' || kind === 'markerPoints';
    const candidates: IndexedPageDescriptor[] = [];

    // 1. 先检查属于此分区的已溢写粗粒度目录块
    if (this.compactedBlocks.length > 0 && this.spillHandler) {
      for (const block of this.compactedBlocks) {
        if (
          block.bootGeneration === part.meta.bootGeneration &&
          block.segmentId === part.meta.segmentId &&
          block.kind === kind &&
          pageDescriptorIntersectsRange(block, unit, qStart, qEnd, isPointKind)
        ) {
          const loaded = await this.spillHandler.loadSpilledDescriptors(block);
          for (const desc of loaded) {
            if (pageDescriptorIntersectsRange(desc, unit, qStart, qEnd, isPointKind)) {
              candidates.push(desc);
            }
          }
        }
      }
    }

    // 2. 检查常驻内存的页描述符（relative-ticks 且单调时走 O(log P) 二分剪枝，其余走精确边界扫描）
    const list = part.pagesByKind.get(kind);
    if (!list || list.length === 0) {
      return candidates;
    }

    const isMonotonicRel = part.monotonicMinRelByKind.get(kind) === true;
    const prefixMax = part.prefixMaxRelEndByKind.get(kind);

    if (unit === 'relative-ticks' && isMonotonicRel && prefixMax) {
      // 二分找最大下标 rightIdx 使得 list[rightIdx].minRelativeTicks < qEnd
      let lo = 0;
      let hi = list.length - 1;
      let rightIdx = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        const minRel = BigInt(list[mid].minRelativeTicks);
        if (minRel < qEnd) {
          rightIdx = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      for (let i = rightIdx; i >= 0; i--) {
        if (isPointKind) {
          if (prefixMax[i] < qStart) {
            break;
          }
        } else if (prefixMax[i] < qStart) {
          break;
        }
        if (pageDescriptorIntersectsRange(list[i], unit, qStart, qEnd, isPointKind)) {
          candidates.push(list[i]);
        }
      }
      // 恢复升序页序
      candidates.sort((a, b) => a.pageId - b.pageId);
      return candidates;
    }

    for (let i = 0; i < list.length; i++) {
      if (pageDescriptorIntersectsRange(list[i], unit, qStart, qEnd, isPointKind)) {
        candidates.push(list[i]);
      }
    }
    return candidates;
  }

  public getCompactedBlocks(): readonly CompactedDirectoryBlock[] {
    return this.compactedBlocks;
  }
}

export function getPageKindsForQueryTarget(target: TraceQueryTarget): readonly TracePageKind[] {
  switch (target) {
    case 'packets':
      return ['packets'];
    case 'slices':
      return ['slices', 'longSlices'];
    case 'activations':
      return ['activations', 'longActivations'];
    case 'readyWaits':
      return ['readyWaits', 'longReadyWaits'];
    case 'markers':
      return ['markers', 'longMarkers'];
    case 'markerPoints':
      return ['markerPoints'];
  }
}

function mergeSegmentMetadata(a: SegmentIndexMetadata, b: SegmentIndexMetadata): SegmentIndexMetadata {
  const minRelA = BigInt(a.minRelativeTicks);
  const minRelB = BigInt(b.minRelativeTicks);
  const maxRelA = BigInt(a.maxRelativeTicks);
  const maxRelB = BigInt(b.maxRelativeTicks);

  let firstAbs = a.firstAbsoluteTicks;
  if (b.firstAbsoluteTicks !== undefined) {
    if (firstAbs === undefined || BigInt(b.firstAbsoluteTicks) < BigInt(firstAbs)) {
      firstAbs = b.firstAbsoluteTicks;
    }
  }
  let lastAbs = a.lastAbsoluteTicks;
  if (b.lastAbsoluteTicks !== undefined) {
    if (lastAbs === undefined || BigInt(b.lastAbsoluteTicks) > BigInt(lastAbs)) {
      lastAbs = b.lastAbsoluteTicks;
    }
  }

  let minNs = a.minNs;
  if (b.minNs !== undefined && (minNs === undefined || BigInt(b.minNs) < BigInt(minNs))) {
    minNs = b.minNs;
  }
  let maxNs = a.maxNs;
  if (b.maxNs !== undefined && (maxNs === undefined || BigInt(b.maxNs) > BigInt(maxNs))) {
    maxNs = b.maxNs;
  }

  return {
    bootGeneration: b.bootGeneration,
    segmentId: b.segmentId,
    startByteOffset: Math.min(a.startByteOffset, b.startByteOffset),
    endByteOffset:
      a.endByteOffset !== undefined && b.endByteOffset !== undefined
        ? Math.max(a.endByteOffset, b.endByteOffset)
        : b.endByteOffset ?? a.endByteOffset,
    reliability: a.reliability === 'uncertain' || b.reliability === 'uncertain' ? 'uncertain' : 'trusted',
    closed: a.closed || b.closed,
    endReason: b.endReason ?? a.endReason,
    packetCount: Math.max(a.packetCount, b.packetCount),
    syncCount: Math.max(a.syncCount, b.syncCount),
    timestampBits: b.timestampBits,
    timestampWrapCount: Math.max(a.timestampWrapCount, b.timestampWrapCount),
    timeAnchorStatus: b.timeAnchorStatus !== 'unanchored' ? b.timeAnchorStatus : a.timeAnchorStatus,
    minRelativeTicks: (minRelA < minRelB ? minRelA : minRelB).toString(),
    maxRelativeTicks: (maxRelA > maxRelB ? maxRelA : maxRelB).toString(),
    firstAbsoluteTicks: firstAbs,
    lastAbsoluteTicks: lastAbs,
    sysFreqHz: b.sysFreqHz ?? a.sysFreqHz,
    minNs,
    maxNs,
  };
}

function mergeTwoLodSummaries(a: PageLodSummary, b: PageLodSummary): PageLodSummary {
  const minRel = BigInt(a.minRelativeTicks) < BigInt(b.minRelativeTicks) ? a.minRelativeTicks : b.minRelativeTicks;
  const maxRel = BigInt(a.maxRelativeTicks) > BigInt(b.maxRelativeTicks) ? a.maxRelativeTicks : b.maxRelativeTicks;

  let minAbs = a.minAbsoluteTicks;
  if (b.minAbsoluteTicks !== undefined && (minAbs === undefined || BigInt(b.minAbsoluteTicks) < BigInt(minAbs))) {
    minAbs = b.minAbsoluteTicks;
  }
  let maxAbs = a.maxAbsoluteTicks;
  if (b.maxAbsoluteTicks !== undefined && (maxAbs === undefined || BigInt(b.maxAbsoluteTicks) > BigInt(maxAbs))) {
    maxAbs = b.maxAbsoluteTicks;
  }

  let minNs = a.minNs;
  if (b.minNs !== undefined && (minNs === undefined || BigInt(b.minNs) < BigInt(minNs))) {
    minNs = b.minNs;
  }
  let maxNs = a.maxNs;
  if (b.maxNs !== undefined && (maxNs === undefined || BigInt(b.maxNs) > BigInt(maxNs))) {
    maxNs = b.maxNs;
  }

  const taskTicks = BigInt(a.sliceTicksByKind?.task ?? '0') + BigInt(b.sliceTicksByKind?.task ?? '0');
  const isrTicks = BigInt(a.sliceTicksByKind?.isr ?? '0') + BigInt(b.sliceTicksByKind?.isr ?? '0');
  const idleTicks = BigInt(a.sliceTicksByKind?.idle ?? '0') + BigInt(b.sliceTicksByKind?.idle ?? '0');
  const schedTicks = BigInt(a.sliceTicksByKind?.scheduler ?? '0') + BigInt(b.sliceTicksByKind?.scheduler ?? '0');

  const domA = a.dominantContext ? BigInt(a.dominantContext.ticks) : -1n;
  const domB = b.dominantContext ? BigInt(b.dominantContext.ticks) : -1n;

  return {
    pageId: a.pageId,
    kind: a.kind,
    bootGeneration: a.bootGeneration,
    segmentId: a.segmentId,
    minRelativeTicks: minRel,
    maxRelativeTicks: maxRel,
    minAbsoluteTicks: minAbs,
    maxAbsoluteTicks: maxAbs,
    sysFreqHz: a.sysFreqHz ?? b.sysFreqHz,
    minNs,
    maxNs,
    itemCount: a.itemCount + b.itemCount,
    hasIncomplete: a.hasIncomplete || b.hasIncomplete,
    hasUncertain: a.hasUncertain || b.hasUncertain,
    sliceTicksByKind: {
      task: taskTicks.toString(),
      isr: isrTicks.toString(),
      idle: idleTicks.toString(),
      scheduler: schedTicks.toString(),
    },
    dominantContext: domA >= domB ? a.dominantContext : b.dominantContext,
  };
}
