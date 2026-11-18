import {
  decodeFloatBits,
  DEFAULT_SHORT_SCHEMA_IDS,
  expandShrunkId,
  FREERTOS_API_NAMES,
  FREERTOS_TRACE_MACRO_PARAMS,
  IdExpansionResult,
  IdResolutionStatus,
  ParsedSysDesc,
  parseSystemDescription,
  ShortFieldDef,
  SYSTEMVIEW_EVENT_IDS,
  SYSTEMVIEW_EVENT_NAMES,
  SYSTEMVIEW_EX_IDS,
  SYSTEMVIEW_EX_NAMES,
  SYSTEMVIEW_FREERTOS_API_OFFSET,
  SYSTEMVIEW_MAX_PROTOCOL_STRING_BYTES,
  SYSTEMVIEW_MAX_VARINT_BYTES,
  SYSTEMVIEW_MODULE_EVENT_OFFSET,
  SYSTEMVIEW_PROTOCOL_VERSION,
  SYSTEMVIEW_SHORT_ID_MAX,
  SYSTEMVIEW_SHORT_SCHEMAS,
  SYSTEMVIEW_SYNC_BYTE_COUNT,
  SYSTEMVIEW_USER_EVENT_MAX,
  SYSTEMVIEW_USER_EVENT_MIN,
  SYSTEMVIEW_VARINT_FIFTH_BYTE_MAX,
} from './systemview-protocol';

export type SegmentReliability = 'trusted' | 'uncertain';
export type TimeAnchorStatus = 'unanchored' | 'anchored-cycles' | 'anchored-systime-us' | 'uncertain';
export type SyncProofKind = 'trace-start-init' | 'init' | 'multi-packet' | 'eof-single-packet' | 'initial-aligned';

export type TraceGapKind =
  | 'target-overflow'
  | 'host-drop'
  | 'control-pause'
  | 'decode-sync-loss'
  | 'decode-schema-error'
  | 'transport-gap'
  | 'prefix-overwritten'
  | 'storage-failure'
  | 'truncated';

export type TraceDiagnosticSeverity = 'info' | 'warning' | 'error';

export type TraceDiagnosticCode =
  | 'overlong-varint'
  | 'varint-overflow'
  | 'incomplete-sync'
  | 'unknown-short-event'
  | 'payload-length-exceeded'
  | 'string-length-exceeded'
  | 'chunk-size-exceeded'
  | 'resync-probe-limit-exceeded'
  | 'payload-length-mismatch'
  | 'malformed-payload-varint'
  | 'malformed-payload-string'
  | 'print-arg-count-exceeded'
  | 'metadata-conflict'
  | 'invalid-metadata'
  | 'time-anchor-conflict'
  | 'timestamp-delta-exceeds-bits'
  | 'timestamp-wrap'
  | 'id-resolution-failed'
  | 'truncated-packet'
  | 'truncated-sync'
  | 'unconfirmed-sync-candidate'
  | 'sysdesc-malformed-item'
  | 'os-param-mismatch';

export interface TraceDecoderMetadata {
  readonly sysFreqHz?: number;
  readonly cpuFreqHz?: number;
  readonly ramBaseAddress?: number;
  readonly idShift?: number;
}

export interface SystemViewDecoderOptions {
  /** 目标时间戳有效位宽（1..32，默认 32，对应 SEGGER_SYSVIEW_TIMESTAMP_BITS）。 */
  timestampBits?: number;
  /** 可选期望元数据；与流内 INIT 不一致时登记 metadata-conflict。 */
  expectedMetadata?: TraceDecoderMetadata;
  /** 显式授权的初始元数据兜底；默认留空，不从未知环境猜频率或 RAM 基址。 */
  initialMetadata?: TraceDecoderMetadata;
  /** 允许的短事件 ID（<24）集合；默认使用 3.32.0 的 1..23。 */
  knownShortEventIds?: ReadonlySet<number>;
  /** 单次 push 允许接收的最大输入字节数，默认 16 MiB。 */
  maxChunkBytes?: number;
  /** 显式长度包允许的最大 payload 字节数，默认 8192，协议上限 65535。 */
  maxPayloadBytes?: number;
  /** 短事件或显式事件内字符串允许的最大字节数，默认 4096，协议上限 65535。 */
  maxStringBytes?: number;
  /** PRINT_FORMATTED 允许的最大参数个数，默认 64。 */
  maxPrintArgs?: number;
  /** 重同步确认窗口最大缓冲字节数，默认 16384。 */
  maxResyncProbeBytes?: number;
  /** SYSDESC 跨包冲突检测最多保留的键数量，默认 256（防止海量自定义键无限增长）。 */
  maxSysDescKeys?: number;
  /** 初始同步模式：默认 seeking-sync（需可证明同步序列）；仅已知从包边界开始时可传 synced。 */
  initialSyncMode?: 'seeking-sync' | 'synced';
}

export interface TraceGapInput {
  kind: Exclude<TraceGapKind, 'decode-sync-loss' | 'decode-schema-error' | 'truncated'>;
  reason?: string;
  droppedPackets?: number | 'unknown';
  droppedBytes?: number | 'unknown';
  /** 调用方确认通道字节边界未被破坏时传 true；默认 false 并转入 seeking-sync。 */
  preservesFraming?: boolean;
}

export interface TraceGapRecord {
  readonly kind: TraceGapKind;
  readonly byteOffset: number;
  readonly segmentIdBefore?: number;
  readonly droppedPackets: number | 'unknown';
  readonly droppedBytes: number | 'unknown';
  readonly rawDropCount?: number;
  readonly minDroppedPackets?: number;
  readonly discardedUnsyncedBytes?: number;
  readonly reason: string;
  readonly preservesFraming: boolean;
}

export interface TraceSyncRecord {
  readonly byteOffset: number;
  readonly segmentId: number;
  readonly proof: SyncProofKind;
  readonly inSegment: boolean;
}

export interface TraceSegmentSummary {
  readonly segmentId: number;
  readonly startByteOffset: number;
  readonly endByteOffset?: number;
  readonly reliability: SegmentReliability;
  readonly syncProof?: SyncProofKind;
  readonly closed: boolean;
  readonly endReason?: TraceGapKind | 'eof' | 'metadata-reconfigured' | 'resync';
  readonly packetCount: number;
  readonly syncCount: number;
  readonly timestampBits: number;
  readonly timestampWrapCount: number;
  readonly timeAnchorStatus: TimeAnchorStatus;
  readonly relativeTicksTotal: string;
  readonly firstAbsoluteTicks?: string;
  readonly lastAbsoluteTicks?: string;
  readonly metadata: TraceDecoderMetadata;
}

export interface TraceDiagnostic {
  readonly severity: TraceDiagnosticSeverity;
  readonly code: TraceDiagnosticCode;
  readonly message: string;
  readonly byteOffset: number;
  readonly segmentId: number;
  readonly eventId?: number;
  readonly details?: Record<string, unknown>;
}

export interface DecodedOsParam {
  readonly name: string;
  readonly rawValue: number;
  readonly kind: 'shrunk-id' | 'u32';
  readonly resolvedId?: number;
  readonly idResolution?: IdResolutionStatus;
}

export type DecodedEventPayload =
  | { kind: 'nop' }
  | {
      kind: 'overflow';
      rawDropCount: number;
      incrementalRawDropDelta?: number;
      minDroppedPackets?: number;
      dropCountAnomaly?: boolean;
    }
  | { kind: 'isr-enter'; irqId: number }
  | { kind: 'isr-exit' }
  | { kind: 'task-start-exec'; shrunkTaskId: number; taskId?: number; idResolution: IdResolutionStatus }
  | { kind: 'task-stop-exec' }
  | { kind: 'task-start-ready'; shrunkTaskId: number; taskId?: number; idResolution: IdResolutionStatus }
  | { kind: 'task-stop-ready'; shrunkTaskId: number; taskId?: number; idResolution: IdResolutionStatus; cause: number }
  | { kind: 'task-create'; shrunkTaskId: number; taskId?: number; idResolution: IdResolutionStatus }
  | { kind: 'task-info'; shrunkTaskId: number; taskId?: number; idResolution: IdResolutionStatus; priority: number; name: string }
  | { kind: 'trace-start' }
  | { kind: 'trace-stop' }
  | { kind: 'systime-cycles'; cycles: number }
  | { kind: 'systime-us'; systimeLow: number; systimeHigh: number; systimeUs: string }
  | { kind: 'sysdesc'; rawText: string; parsed: ParsedSysDesc }
  | { kind: 'mark-start'; markerId: number }
  | { kind: 'mark-stop'; markerId: number }
  | { kind: 'idle' }
  | { kind: 'isr-to-scheduler' }
  | { kind: 'timer-enter'; shrunkTimerId: number; timerId?: number; idResolution: IdResolutionStatus }
  | { kind: 'timer-exit' }
  | {
      kind: 'stack-info';
      shrunkTaskId: number;
      taskId?: number;
      idResolution: IdResolutionStatus;
      stackBase: number;
      stackSize: number;
      stackUsage: number;
    }
  | { kind: 'moduledesc'; moduleId: number; eventOffset: number; description: string }
  | { kind: 'data-sample'; dataId: number; rawValueBits: number; floatValue: number }
  | { kind: 'init'; sysFreqHz: number; cpuFreqHz: number; ramBaseAddress: number; idShift: number }
  | { kind: 'name-resource'; shrunkResourceId: number; resourceId?: number; idResolution: IdResolutionStatus; name: string }
  | {
      kind: 'print-formatted';
      text: string;
      options: number;
      logLevel: number;
      append: boolean;
      numArgs: number;
      args: readonly number[];
    }
  | { kind: 'nummodules'; numModules: number }
  | { kind: 'end-call'; apiEventId: number; apiId?: number; apiName?: string; hasReturnValue: boolean; returnValue?: number }
  | { kind: 'task-terminate'; shrunkTaskId: number; taskId?: number; idResolution: IdResolutionStatus }
  | { kind: 'ex-mark'; markerId: number }
  | { kind: 'ex-name-marker'; markerId: number; name: string }
  | {
      kind: 'ex-heap-define';
      shrunkHeapId: number;
      heapId?: number;
      heapIdResolution: IdResolutionStatus;
      shrunkBaseId: number;
      baseAddress?: number;
      baseIdResolution: IdResolutionStatus;
      heapSizeShifted: number;
      heapSizeBytes?: number;
      metadataSize: number;
    }
  | {
      kind: 'ex-heap-alloc';
      shrunkHeapId: number;
      heapId?: number;
      heapIdResolution: IdResolutionStatus;
      shrunkUserDataId: number;
      userDataAddress?: number;
      userDataIdResolution: IdResolutionStatus;
      userDataLenShifted: number;
      userDataLenBytes?: number;
    }
  | {
      kind: 'ex-heap-alloc-ex';
      shrunkHeapId: number;
      heapId?: number;
      heapIdResolution: IdResolutionStatus;
      shrunkUserDataId: number;
      userDataAddress?: number;
      userDataIdResolution: IdResolutionStatus;
      userDataLenShifted: number;
      userDataLenBytes?: number;
      tag: number;
    }
  | {
      kind: 'ex-heap-free';
      shrunkHeapId: number;
      heapId?: number;
      heapIdResolution: IdResolutionStatus;
      shrunkUserDataId: number;
      userDataAddress?: number;
      userDataIdResolution: IdResolutionStatus;
    }
  | {
      kind: 'ex-register-data';
      dataId: number;
      name: string;
      dataType?: number;
      offset?: number;
      rangeMin?: number;
      rangeMax?: number;
      scalingFactorBits?: number;
      scalingFactor?: number;
      unit?: string;
    }
  | { kind: 'ex-print-elf'; stringAddress: number; options: number; rawArgBytes: Uint8Array }
  | { kind: 'ex-unknown'; exId: number; rawPayload: Uint8Array }
  | {
      kind: 'os-freertos';
      apiId: number;
      apiName?: string;
      params?: readonly DecodedOsParam[];
      rawPayload: Uint8Array;
      interpretation: 'matched' | 'unmapped-api' | 'param-mismatch';
    }
  | { kind: 'module-event'; moduleEventOffset: number; rawPayload: Uint8Array }
  | { kind: 'user-event'; rawPayload: Uint8Array }
  | { kind: 'unknown-explicit'; rawPayload: Uint8Array };

export type PacketCategory =
  | 'standard-short'
  | 'standard-explicit'
  | 'extended'
  | 'os-freertos'
  | 'module'
  | 'user'
  | 'unknown-explicit';

export type SchemaReliability = 'known' | 'partial' | 'unknown-explicit';

export interface DecodedSystemViewPacket {
  readonly protocolVersion: typeof SYSTEMVIEW_PROTOCOL_VERSION;
  readonly segmentId: number;
  readonly packetIndexInSegment: number;
  readonly streamByteOffset: number;
  readonly byteLength: number;
  readonly eventId: number;
  readonly eventName: string;
  readonly category: PacketCategory;
  readonly schemaReliability: SchemaReliability;
  readonly segmentReliability: SegmentReliability;
  readonly deltaTicks: number;
  readonly segmentRelativeTicks: string;
  readonly segmentRelativeTicksBigInt: bigint;
  readonly absoluteTicks?: string;
  readonly absoluteTicksBigInt?: bigint;
  readonly rawTimestampMod?: number;
  readonly timestampWrapped: boolean;
  readonly timeAnchorStatus: TimeAnchorStatus;
  readonly sysFreqHz?: number;
  readonly timestampUs?: number;
  readonly timestampNs?: string;
  readonly decoded: DecodedEventPayload;
}

export interface SystemViewDecodeBatch {
  readonly packets: readonly DecodedSystemViewPacket[];
  readonly syncs: readonly TraceSyncRecord[];
  readonly gaps: readonly TraceGapRecord[];
  readonly segments: readonly TraceSegmentSummary[];
  readonly diagnostics: readonly TraceDiagnostic[];
}

export interface SystemViewDecoderSnapshot {
  readonly protocolVersion: typeof SYSTEMVIEW_PROTOCOL_VERSION;
  readonly mode: 'seeking-sync' | 'synced' | 'finished';
  readonly totalBytesProcessed: number;
  readonly totalPacketsDecoded: number;
  readonly totalSyncs: number;
  readonly totalGaps: number;
  readonly totalDiagnostics: number;
  readonly discardedUnsyncedBytes: number;
  readonly truncated: boolean;
  readonly activeSegment?: TraceSegmentSummary;
  readonly pendingBytes: number;
  readonly maxPendingBytesObserved: number;
}

export interface SystemViewDecodeResult extends SystemViewDecodeBatch {
  readonly summary: SystemViewDecoderSnapshot;
}

interface RawAssembledPacket {
  readonly startOffset: number;
  readonly byteLength: number;
  readonly eventId: number;
  readonly deltaTicks: number;
  readonly isExplicit: boolean;
  readonly shortValues?: readonly (number | string)[];
  readonly payload?: Uint8Array;
}

type AssemblerStepResult =
  | { kind: 'need-more' }
  | { kind: 'sync'; startOffset: number; byteLength: number }
  | { kind: 'packet'; packet: RawAssembledPacket }
  | {
      kind: 'error';
      code: TraceDiagnosticCode;
      message: string;
      byteOffset: number;
      packetStartOffset: number;
      eventId?: number;
      syncZeroCountBeforeError?: number;
    };

type AssemblerPhase =
  | 'packet-start'
  | 'reading-sync'
  | 'reading-event-id'
  | 'reading-explicit-len'
  | 'reading-explicit-payload'
  | 'reading-short-field-u32'
  | 'reading-short-str-len1'
  | 'reading-short-str-len-hi'
  | 'reading-short-str-len-lo'
  | 'reading-short-str-bytes'
  | 'reading-delta';

const utf8Decoder = new TextDecoder('utf-8', { fatal: false });

interface AssemblerLimits {
  readonly knownShortEventIds: ReadonlySet<number>;
  readonly maxPayloadBytes: number;
  readonly maxStringBytes: number;
}

/**
 * 单包有界状态机：逐字节或连续读取一个完整的 Sync 或 Packet，
 * 在不复制整段历史流的前提下严格限制单包内存并检测 varint/长度异常。
 */
class PacketAssembler {
  private phase: AssemblerPhase = 'packet-start';
  private packetStartOffset = 0;
  private syncZeroCount = 0;

  private varintValue = 0;
  private varintLen = 0;

  private eventId = 0;
  private isExplicit = false;

  private payloadLen = 0;
  private payloadBuf: Uint8Array | null = null;
  private payloadFilled = 0;

  private shortFields: readonly ShortFieldDef[] = [];
  private shortFieldIndex = 0;
  private shortValues: (number | string)[] = [];

  private strLen = 0;
  private strHi = 0;
  private strBuf: Uint8Array | null = null;
  private strFilled = 0;

  public constructor(private readonly limits: AssemblerLimits) {}

  public reset(): void {
    this.phase = 'packet-start';
    this.packetStartOffset = 0;
    this.syncZeroCount = 0;
    this.varintValue = 0;
    this.varintLen = 0;
    this.eventId = 0;
    this.isExplicit = false;
    this.payloadLen = 0;
    this.payloadBuf = null;
    this.payloadFilled = 0;
    this.shortFields = [];
    this.shortFieldIndex = 0;
    this.shortValues = [];
    this.strLen = 0;
    this.strHi = 0;
    this.strBuf = null;
    this.strFilled = 0;
  }

  public isAtBoundary(): boolean {
    return this.phase === 'packet-start';
  }

  public getSyncZeroCount(): number {
    return this.phase === 'reading-sync' ? this.syncZeroCount : 0;
  }

  public getPendingBytesCount(currentOffset: number): number {
    if (this.phase === 'packet-start') {
      return 0;
    }
    return Math.max(0, currentOffset - this.packetStartOffset);
  }

  public startNopDelta(nopStartOffset: number): void {
    this.reset();
    this.packetStartOffset = nopStartOffset;
    this.eventId = SYSTEMVIEW_EVENT_IDS.NOP;
    this.isExplicit = false;
    this.shortValues = [];
    this.varintValue = 0;
    this.varintLen = 0;
    this.phase = 'reading-delta';
  }

  public feedByte(byte: number, absOffset: number): AssemblerStepResult {
    switch (this.phase) {
      case 'packet-start': {
        this.packetStartOffset = absOffset;
        if (byte === 0) {
          this.phase = 'reading-sync';
          this.syncZeroCount = 1;
          return { kind: 'need-more' };
        }
        this.varintValue = 0;
        this.varintLen = 0;
        this.phase = 'reading-event-id';
        return this.stepEventId(byte, absOffset);
      }

      case 'reading-sync': {
        if (byte !== 0) {
          const zeros = this.syncZeroCount;
          const startOffset = this.packetStartOffset;
          this.reset();
          return {
            kind: 'error',
            code: 'incomplete-sync',
            message: `包边界出现 ${zeros} 个零字节后遇到非零字节 0x${byte.toString(16).padStart(2, '0')}，未构成完整 10 字节 sync`,
            byteOffset: startOffset,
            packetStartOffset: startOffset,
            syncZeroCountBeforeError: zeros,
          };
        }
        this.syncZeroCount += 1;
        if (this.syncZeroCount === SYSTEMVIEW_SYNC_BYTE_COUNT) {
          const startOffset = this.packetStartOffset;
          this.reset();
          return {
            kind: 'sync',
            startOffset,
            byteLength: SYSTEMVIEW_SYNC_BYTE_COUNT,
          };
        }
        return { kind: 'need-more' };
      }

      case 'reading-event-id':
        return this.stepEventId(byte, absOffset);

      case 'reading-explicit-len':
        return this.stepExplicitLen(byte, absOffset);

      case 'reading-explicit-payload':
        return this.stepExplicitPayload(byte, absOffset);

      case 'reading-short-field-u32':
        return this.stepShortFieldU32(byte, absOffset);

      case 'reading-short-str-len1':
        return this.stepShortStrLen1(byte, absOffset);

      case 'reading-short-str-len-hi':
        this.strHi = byte;
        this.phase = 'reading-short-str-len-lo';
        return { kind: 'need-more' };

      case 'reading-short-str-len-lo':
        return this.stepShortStrLenLo(byte, absOffset);

      case 'reading-short-str-bytes':
        return this.stepShortStrBytes(byte, absOffset);

      case 'reading-delta':
        return this.stepDelta(byte, absOffset);
    }
  }

  private stepVarint(byte: number): { done: true; value: number } | { done: false } | { error: 'overlong-varint' | 'varint-overflow' } {
    if (this.varintLen < 4) {
      this.varintValue |= (byte & 0x7f) << (7 * this.varintLen);
      this.varintLen += 1;
      if ((byte & 0x80) === 0) {
        return { done: true, value: this.varintValue >>> 0 };
      }
      return { done: false };
    }
    if ((byte & 0x80) !== 0) {
      return { error: 'overlong-varint' };
    }
    if (byte > SYSTEMVIEW_VARINT_FIFTH_BYTE_MAX) {
      return { error: 'varint-overflow' };
    }
    const value = (this.varintValue | (byte << 28)) >>> 0;
    this.varintLen += 1;
    return { done: true, value };
  }

  private fail(code: TraceDiagnosticCode, message: string, byteOffset: number, eventId?: number): AssemblerStepResult {
    const packetStartOffset = this.packetStartOffset;
    this.reset();
    return { kind: 'error', code, message, byteOffset, packetStartOffset, eventId };
  }

  private stepEventId(byte: number, absOffset: number): AssemblerStepResult {
    const res = this.stepVarint(byte);
    if ('error' in res) {
      return this.fail(
        res.error,
        res.error === 'overlong-varint' ? '事件 ID varint 超过 5 字节' : '事件 ID varint 第 5 字节溢出 uint32',
        absOffset,
      );
    }
    if (!res.done) {
      return { kind: 'need-more' };
    }
    this.eventId = res.value;
    if (this.eventId <= SYSTEMVIEW_SHORT_ID_MAX) {
      if (!this.limits.knownShortEventIds.has(this.eventId)) {
        return this.fail(
          'unknown-short-event',
          `遇到无长度未知短事件 ID=${this.eventId}，无法确定包边界`,
          this.packetStartOffset,
          this.eventId,
        );
      }
      const schema = SYSTEMVIEW_SHORT_SCHEMAS[this.eventId];
      if (!schema) {
        return this.fail(
          'unknown-short-event',
          `短事件 ID=${this.eventId} 缺少固定 schema 定义`,
          this.packetStartOffset,
          this.eventId,
        );
      }
      this.isExplicit = false;
      this.shortFields = schema.fields;
      this.shortFieldIndex = 0;
      this.shortValues = [];
      this.enterNextShortFieldOrDelta();
      return { kind: 'need-more' };
    }

    this.isExplicit = true;
    this.varintValue = 0;
    this.varintLen = 0;
    this.phase = 'reading-explicit-len';
    return { kind: 'need-more' };
  }

  private enterNextShortFieldOrDelta(): void {
    if (this.shortFieldIndex >= this.shortFields.length) {
      this.varintValue = 0;
      this.varintLen = 0;
      this.phase = 'reading-delta';
      return;
    }
    const field = this.shortFields[this.shortFieldIndex];
    if (field.kind === 'u32') {
      this.varintValue = 0;
      this.varintLen = 0;
      this.phase = 'reading-short-field-u32';
    } else {
      this.phase = 'reading-short-str-len1';
    }
  }

  private stepExplicitLen(byte: number, absOffset: number): AssemblerStepResult {
    const res = this.stepVarint(byte);
    if ('error' in res) {
      return this.fail(
        res.error,
        res.error === 'overlong-varint' ? '显式包长度 varint 超过 5 字节' : '显式包长度 varint 溢出 uint32',
        absOffset,
        this.eventId,
      );
    }
    if (!res.done) {
      return { kind: 'need-more' };
    }
    if (res.value > this.limits.maxPayloadBytes) {
      return this.fail(
        'payload-length-exceeded',
        `事件 ID=${this.eventId} 的显式长度 ${res.value} 超过上限 ${this.limits.maxPayloadBytes}`,
        absOffset,
        this.eventId,
      );
    }
    this.payloadLen = res.value;
    this.payloadFilled = 0;
    if (this.payloadLen === 0) {
      this.payloadBuf = new Uint8Array(0);
      this.varintValue = 0;
      this.varintLen = 0;
      this.phase = 'reading-delta';
    } else {
      // 按需延迟增长，避免截断恶意包按上限预分配过大内存
      this.payloadBuf = new Uint8Array(Math.min(this.payloadLen, 256));
      this.phase = 'reading-explicit-payload';
    }
    return { kind: 'need-more' };
  }

  private stepExplicitPayload(byte: number, _absOffset: number): AssemblerStepResult {
    if (!this.payloadBuf) {
      return this.fail('payload-length-exceeded', '缺少 payload 缓冲区', this.packetStartOffset, this.eventId);
    }
    if (this.payloadFilled >= this.payloadBuf.length) {
      const nextCap = Math.min(this.payloadLen, this.payloadBuf.length * 2);
      const next = new Uint8Array(nextCap);
      next.set(this.payloadBuf);
      this.payloadBuf = next;
    }
    this.payloadBuf[this.payloadFilled++] = byte;
    if (this.payloadFilled === this.payloadLen) {
      this.varintValue = 0;
      this.varintLen = 0;
      this.phase = 'reading-delta';
    }
    return { kind: 'need-more' };
  }

  private stepShortFieldU32(byte: number, absOffset: number): AssemblerStepResult {
    const res = this.stepVarint(byte);
    if ('error' in res) {
      return this.fail(
        res.error,
        res.error === 'overlong-varint' ? '短事件参数 varint 超过 5 字节' : '短事件参数 varint 第 5 字节溢出 uint32',
        absOffset,
        this.eventId,
      );
    }
    if (!res.done) {
      return { kind: 'need-more' };
    }
    this.shortValues.push(res.value);
    this.shortFieldIndex += 1;
    this.enterNextShortFieldOrDelta();
    return { kind: 'need-more' };
  }

  private stepShortStrLen1(byte: number, absOffset: number): AssemblerStepResult {
    if (byte === 255) {
      this.phase = 'reading-short-str-len-hi';
      return { kind: 'need-more' };
    }
    return this.startShortStrBytes(byte, absOffset);
  }

  private stepShortStrLenLo(byte: number, absOffset: number): AssemblerStepResult {
    const len = ((this.strHi << 8) | byte) >>> 0;
    return this.startShortStrBytes(len, absOffset);
  }

  private startShortStrBytes(len: number, absOffset: number): AssemblerStepResult {
    if (len > this.limits.maxStringBytes) {
      return this.fail(
        'string-length-exceeded',
        `短事件 ID=${this.eventId} 字符串长度 ${len} 超过上限 ${this.limits.maxStringBytes}`,
        absOffset,
        this.eventId,
      );
    }
    this.strLen = len;
    this.strFilled = 0;
    if (len === 0) {
      this.strBuf = null;
      this.shortValues.push('');
      this.shortFieldIndex += 1;
      this.enterNextShortFieldOrDelta();
      return { kind: 'need-more' };
    }
    this.strBuf = new Uint8Array(Math.min(len, 256));
    this.phase = 'reading-short-str-bytes';
    return { kind: 'need-more' };
  }

  private stepShortStrBytes(byte: number, _absOffset: number): AssemblerStepResult {
    if (!this.strBuf) {
      return this.fail('string-length-exceeded', '缺少短事件字符串缓冲区', this.packetStartOffset, this.eventId);
    }
    if (this.strFilled >= this.strBuf.length) {
      const nextCap = Math.min(this.strLen, this.strBuf.length * 2);
      const next = new Uint8Array(nextCap);
      next.set(this.strBuf);
      this.strBuf = next;
    }
    this.strBuf[this.strFilled++] = byte;
    if (this.strFilled === this.strLen) {
      const text = utf8Decoder.decode(this.strBuf.subarray(0, this.strLen));
      this.strBuf = null;
      this.shortValues.push(text);
      this.shortFieldIndex += 1;
      this.enterNextShortFieldOrDelta();
    }
    return { kind: 'need-more' };
  }

  private stepDelta(byte: number, absOffset: number): AssemblerStepResult {
    const res = this.stepVarint(byte);
    if ('error' in res) {
      return this.fail(
        res.error,
        res.error === 'overlong-varint' ? 'timestamp delta varint 超过 5 字节' : 'timestamp delta varint 第 5 字节溢出 uint32',
        absOffset,
        this.eventId,
      );
    }
    if (!res.done) {
      return { kind: 'need-more' };
    }
    const packet: RawAssembledPacket = {
      startOffset: this.packetStartOffset,
      byteLength: absOffset - this.packetStartOffset + 1,
      eventId: this.eventId,
      deltaTicks: res.value,
      isExplicit: this.isExplicit,
      shortValues: this.isExplicit ? undefined : this.shortValues,
      payload: this.isExplicit ? (this.payloadBuf ?? new Uint8Array(0)).subarray(0, this.payloadLen) : undefined,
    };
    this.reset();
    return { kind: 'packet', packet };
  }
}

class PayloadReader {
  public offset = 0;

  public constructor(
    private readonly buf: Uint8Array,
    private readonly maxStringBytes: number,
  ) {}

  public get remaining(): number {
    return this.buf.length - this.offset;
  }

  public readU32():
    | { ok: true; value: number }
    | { ok: false; code: TraceDiagnosticCode; message: string } {
    if (this.offset >= this.buf.length) {
      return { ok: false, code: 'payload-length-mismatch', message: 'payload 提前结束，缺少期望的 U32 字段' };
    }
    let val = 0;
    for (let i = 0; i < SYSTEMVIEW_MAX_VARINT_BYTES; i++) {
      if (this.offset >= this.buf.length) {
        return { ok: false, code: 'malformed-payload-varint', message: 'payload 内 varint 在结束字节前截断' };
      }
      const b = this.buf[this.offset++];
      if (i < 4) {
        val |= (b & 0x7f) << (7 * i);
        if ((b & 0x80) === 0) {
          return { ok: true, value: val >>> 0 };
        }
      } else {
        if ((b & 0x80) !== 0) {
          return { ok: false, code: 'overlong-varint', message: 'payload 内 varint 超过 5 字节' };
        }
        if (b > SYSTEMVIEW_VARINT_FIFTH_BYTE_MAX) {
          return { ok: false, code: 'varint-overflow', message: 'payload 内 varint 第 5 字节溢出 uint32' };
        }
        return { ok: true, value: (val | (b << 28)) >>> 0 };
      }
    }
    return { ok: false, code: 'overlong-varint', message: 'payload 内 varint 超过 5 字节' };
  }

  public readString():
    | { ok: true; value: string }
    | { ok: false; code: TraceDiagnosticCode; message: string } {
    if (this.offset >= this.buf.length) {
      return { ok: false, code: 'payload-length-mismatch', message: 'payload 提前结束，缺少字符串长度' };
    }
    const len0 = this.buf[this.offset++];
    let len = len0;
    if (len0 === 255) {
      if (this.remaining < 2) {
        return { ok: false, code: 'malformed-payload-string', message: 'payload 内长字符串长度头不足 2 字节' };
      }
      const hi = this.buf[this.offset++];
      const lo = this.buf[this.offset++];
      len = ((hi << 8) | lo) >>> 0;
    }
    if (len > this.maxStringBytes) {
      return {
        ok: false,
        code: 'string-length-exceeded',
        message: `payload 内字符串长度 ${len} 超过上限 ${this.maxStringBytes}`,
      };
    }
    if (this.remaining < len) {
      return {
        ok: false,
        code: 'malformed-payload-string',
        message: `payload 内字符串声明长度 ${len} 超过剩余字节 ${this.remaining}`,
      };
    }
    const text = utf8Decoder.decode(this.buf.subarray(this.offset, this.offset + len));
    this.offset += len;
    return { ok: true, value: text };
  }
}

interface ParsedPayloadResult {
  readonly ok: boolean;
  readonly eventName: string;
  readonly category: PacketCategory;
  readonly schemaReliability: SchemaReliability;
  readonly decoded?: DecodedEventPayload;
  readonly errorCode?: TraceDiagnosticCode;
  readonly errorMessage?: string;
}

interface ActiveSegmentState {
  segmentId: number;
  startByteOffset: number;
  reliability: SegmentReliability;
  syncProof?: SyncProofKind;
  packetCount: number;
  syncCount: number;
  timestampBits: number;
  timestampMask: bigint;
  timestampModulus: bigint;
  timestampWrapCount: number;
  relativeTicks: bigint;
  timeAnchorStatus: TimeAnchorStatus;
  anchoredTicks?: bigint;
  firstAbsoluteTicks?: bigint;
  lastAbsoluteTicks?: bigint;
  rawTimestampMod?: bigint;
  lastSystimeUs?: bigint;
  metadata: {
    sysFreqHz?: number;
    cpuFreqHz?: number;
    ramBaseAddress?: number;
    idShift?: number;
  };
  sysDescKeys: Map<string, string>;
}

interface CandidateProbeState {
  syncStartOffset: number;
  assembler: PacketAssembler;
  bytes: Uint8Array;
  byteLength: number;
  packets: RawAssembledPacket[];
}

interface SyncedSyncProbeState {
  zerosCount: number;
  zeroStartOffset: number;
  syncStartOffset: number;
  assembler: PacketAssembler;
  bytes: Uint8Array;
  byteLength: number;
  packets: RawAssembledPacket[];
}

const DEFAULT_MAX_SYSDESC_KEYS = 256;

/**
 * SEGGER SystemView 3.32.0 有界增量流解码器。
 *
 * 约定：
 * - 不复制整段历史流；仅缓冲当前未完成包或有限重同步确认窗口。
 * - 不制造无法证明起点的绝对时间（无 SYSTIME 锚点前 `absoluteTicks` 保持 undefined；无正数 `sysFreqHz` 前不生成 `timestampUs/Ns`）。
 * - 不越过无长度未知短事件继续制造可信段；遇到 `decode-sync-loss` 或传输缺口后必须经过可证明的 `sync` 才恢复可信段。
 */
export class SystemViewStreamDecoder {
  private readonly timestampBits: number;
  private readonly timestampMask: bigint;
  private readonly timestampModulus: bigint;
  private readonly expectedMetadata?: TraceDecoderMetadata;
  private readonly initialMetadata?: TraceDecoderMetadata;
  private readonly knownShortEventIds: ReadonlySet<number>;
  private readonly maxChunkBytes: number;
  private readonly maxPayloadBytes: number;
  private readonly maxStringBytes: number;
  private readonly maxPrintArgs: number;
  private readonly maxResyncProbeBytes: number;
  private readonly maxSysDescKeys: number;
  private readonly initialSyncMode: 'seeking-sync' | 'synced';

  private readonly assembler: PacketAssembler;

  private mode: 'seeking-sync' | 'synced' | 'finished' = 'seeking-sync';
  private totalBytesProcessed = 0;
  private totalPacketsDecoded = 0;
  private totalSyncs = 0;
  private totalGaps = 0;
  private totalDiagnostics = 0;
  private discardedUnsyncedBytes = 0;
  private truncated = false;
  private maxPendingBytesObserved = 0;

  private zeroRunCount = 0;
  private unsyncedRegionStartOffset: number | null = null;
  private unsyncedRegionBytes = 0;
  private pendingPreSyncGapKind: TraceGapKind = 'prefix-overwritten';
  private pendingPreSyncGapReason = '流起始或失步区存在未同步前置字节';

  private candidateProbe: CandidateProbeState | null = null;
  private syncedZeroCount = 0;
  private syncedZeroStartOffset = 0;
  private syncedSyncProbe: SyncedSyncProbeState | null = null;

  private nextSegmentId = 1;
  private activeSegment: ActiveSegmentState | null = null;
  private lastCumulativeDropCount: number | null = null;
  private streamMetadataBaseline: TraceDecoderMetadata | null = null;

  public constructor(options: SystemViewDecoderOptions = {}) {
    const bits = options.timestampBits ?? 32;
    if (!Number.isInteger(bits) || bits < 1 || bits > 32) {
      throw new RangeError(`timestampBits must be an integer in 1..32, got ${bits}`);
    }
    this.timestampBits = bits;
    this.timestampMask = (1n << BigInt(bits)) - 1n;
    this.timestampModulus = 1n << BigInt(bits);
    this.expectedMetadata = options.expectedMetadata;
    this.initialMetadata = options.initialMetadata;
    this.knownShortEventIds = options.knownShortEventIds ?? DEFAULT_SHORT_SCHEMA_IDS;
    this.maxChunkBytes = this.validatePositiveBound(options.maxChunkBytes ?? 16 * 1024 * 1024, 'maxChunkBytes', 1, 64 * 1024 * 1024);
    this.maxPayloadBytes = this.validatePositiveBound(
      options.maxPayloadBytes ?? 8192,
      'maxPayloadBytes',
      1,
      SYSTEMVIEW_MAX_PROTOCOL_STRING_BYTES,
    );
    this.maxStringBytes = this.validatePositiveBound(
      options.maxStringBytes ?? 4096,
      'maxStringBytes',
      1,
      SYSTEMVIEW_MAX_PROTOCOL_STRING_BYTES,
    );
    this.maxPrintArgs = this.validatePositiveBound(options.maxPrintArgs ?? 64, 'maxPrintArgs', 0, 1024);
    this.maxResyncProbeBytes = this.validatePositiveBound(options.maxResyncProbeBytes ?? 16384, 'maxResyncProbeBytes', 64, 256 * 1024);
    this.maxSysDescKeys = this.validatePositiveBound(
      options.maxSysDescKeys ?? DEFAULT_MAX_SYSDESC_KEYS,
      'maxSysDescKeys',
      1,
      4096,
    );
    this.initialSyncMode = options.initialSyncMode ?? 'seeking-sync';

    this.assembler = new PacketAssembler({
      knownShortEventIds: this.knownShortEventIds,
      maxPayloadBytes: this.maxPayloadBytes,
      maxStringBytes: this.maxStringBytes,
    });

    this.initModeState();
  }

  private validatePositiveBound(value: number, name: string, min: number, max: number): number {
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new RangeError(`${name} must be an integer in ${min}..${max}, got ${value}`);
    }
    return value;
  }

  private initModeState(): void {
    if (this.initialSyncMode === 'synced') {
      this.mode = 'synced';
      this.activeSegment = this.createSegment(0, 'trusted', 'initial-aligned');
    } else {
      this.mode = 'seeking-sync';
      this.activeSegment = null;
    }
  }

  public reset(): void {
    this.assembler.reset();
    this.totalBytesProcessed = 0;
    this.totalPacketsDecoded = 0;
    this.totalSyncs = 0;
    this.totalGaps = 0;
    this.totalDiagnostics = 0;
    this.discardedUnsyncedBytes = 0;
    this.truncated = false;
    this.maxPendingBytesObserved = 0;
    this.zeroRunCount = 0;
    this.unsyncedRegionStartOffset = null;
    this.unsyncedRegionBytes = 0;
    this.pendingPreSyncGapKind = 'prefix-overwritten';
    this.pendingPreSyncGapReason = '流起始或失步区存在未同步前置字节';
    this.candidateProbe = null;
    this.syncedZeroCount = 0;
    this.syncedZeroStartOffset = 0;
    this.syncedSyncProbe = null;
    this.nextSegmentId = 1;
    this.activeSegment = null;
    this.lastCumulativeDropCount = null;
    this.streamMetadataBaseline = null;
    this.initModeState();
  }

  public getState(): SystemViewDecoderSnapshot {
    return {
      protocolVersion: SYSTEMVIEW_PROTOCOL_VERSION,
      mode: this.mode,
      totalBytesProcessed: this.totalBytesProcessed,
      totalPacketsDecoded: this.totalPacketsDecoded,
      totalSyncs: this.totalSyncs,
      totalGaps: this.totalGaps,
      totalDiagnostics: this.totalDiagnostics,
      discardedUnsyncedBytes: this.discardedUnsyncedBytes,
      truncated: this.truncated,
      activeSegment: this.activeSegment ? this.summarizeSegment(this.activeSegment, false) : undefined,
      pendingBytes: this.currentPendingBytes(),
      maxPendingBytesObserved: this.maxPendingBytesObserved,
    };
  }

  private currentPendingBytes(): number {
    if (this.candidateProbe) {
      return SYSTEMVIEW_SYNC_BYTE_COUNT + this.candidateProbe.byteLength;
    }
    if (this.syncedSyncProbe) {
      return this.syncedSyncProbe.zerosCount + this.syncedSyncProbe.byteLength;
    }
    if (this.mode === 'synced') {
      return this.syncedZeroCount + this.assembler.getPendingBytesCount(this.totalBytesProcessed);
    }
    return Math.min(this.zeroRunCount, SYSTEMVIEW_SYNC_BYTE_COUNT);
  }

  private trackPendingMemory(): void {
    const pending = this.currentPendingBytes();
    if (pending > this.maxPendingBytesObserved) {
      this.maxPendingBytesObserved = pending;
    }
  }

  private createSegment(startByteOffset: number, reliability: SegmentReliability, syncProof?: SyncProofKind): ActiveSegmentState {
    const initial = this.initialMetadata;
    const seg: ActiveSegmentState = {
      segmentId: this.nextSegmentId++,
      startByteOffset,
      reliability,
      syncProof,
      packetCount: 0,
      syncCount: syncProof && syncProof !== 'initial-aligned' ? 1 : 0,
      timestampBits: this.timestampBits,
      timestampMask: this.timestampMask,
      timestampModulus: this.timestampModulus,
      timestampWrapCount: 0,
      relativeTicks: 0n,
      timeAnchorStatus: 'unanchored',
      metadata: {
        sysFreqHz: initial?.sysFreqHz,
        cpuFreqHz: initial?.cpuFreqHz,
        ramBaseAddress: initial?.ramBaseAddress,
        idShift: initial?.idShift,
      },
      sysDescKeys: new Map(),
    };
    return seg;
  }

  private summarizeSegment(
    seg: ActiveSegmentState,
    closed: boolean,
    endByteOffset?: number,
    endReason?: TraceSegmentSummary['endReason'],
  ): TraceSegmentSummary {
    return {
      segmentId: seg.segmentId,
      startByteOffset: seg.startByteOffset,
      endByteOffset,
      reliability: seg.reliability,
      syncProof: seg.syncProof,
      closed,
      endReason,
      packetCount: seg.packetCount,
      syncCount: seg.syncCount,
      timestampBits: seg.timestampBits,
      timestampWrapCount: seg.timestampWrapCount,
      timeAnchorStatus: seg.timeAnchorStatus,
      relativeTicksTotal: seg.relativeTicks.toString(),
      firstAbsoluteTicks: seg.firstAbsoluteTicks !== undefined ? seg.firstAbsoluteTicks.toString() : undefined,
      lastAbsoluteTicks: seg.lastAbsoluteTicks !== undefined ? seg.lastAbsoluteTicks.toString() : undefined,
      metadata: { ...seg.metadata },
    };
  }

  private closeActiveSegment(
    batch: MutableDecodeBatch,
    endByteOffset: number,
    endReason: NonNullable<TraceSegmentSummary['endReason']>,
  ): TraceSegmentSummary | undefined {
    if (!this.activeSegment) {
      return undefined;
    }
    const closed = this.summarizeSegment(this.activeSegment, true, endByteOffset, endReason);
    batch.segments.push(closed);
    this.activeSegment = null;
    return closed;
  }

  private addDiagnostic(batch: MutableDecodeBatch, diag: TraceDiagnostic): void {
    this.totalDiagnostics += 1;
    batch.diagnostics.push(diag);
  }

  private addGap(batch: MutableDecodeBatch, gap: TraceGapRecord): void {
    this.totalGaps += 1;
    batch.gaps.push(gap);
  }

  public push(chunk: Uint8Array): SystemViewDecodeBatch {
    const batch = createEmptyMutableBatch();
    if (this.mode === 'finished') {
      throw new Error('Cannot push bytes after finish() has been called');
    }
    if (chunk.length > this.maxChunkBytes) {
      this.addDiagnostic(batch, {
        severity: 'error',
        code: 'chunk-size-exceeded',
        message: `单次输入块长度 ${chunk.length} 超过上限 ${this.maxChunkBytes}`,
        byteOffset: this.totalBytesProcessed,
        segmentId: this.activeSegment?.segmentId ?? 0,
        details: { chunkLength: chunk.length, maxChunkBytes: this.maxChunkBytes },
      });
      throw new RangeError(`Chunk length ${chunk.length} exceeds maxChunkBytes ${this.maxChunkBytes}`);
    }
    if (chunk.length === 0) {
      return batch;
    }

    const baseOffset = this.totalBytesProcessed;
    this.totalBytesProcessed += chunk.length;
    this.processSpan(chunk, baseOffset, batch);
    this.trackPendingMemory();
    return batch;
  }

  public markGap(gap: TraceGapInput): SystemViewDecodeBatch {
    const batch = createEmptyMutableBatch();
    if (this.mode === 'finished') {
      throw new Error('Cannot markGap after finish() has been called');
    }
    const offset = this.totalBytesProcessed;
    let truncatedPending = false;
    if (this.mode === 'synced') {
      if (this.syncedSyncProbe) {
        truncatedPending = true;
        this.syncedSyncProbe = null;
      }
      if (this.syncedZeroCount > 0) {
        if (this.syncedZeroCount < SYSTEMVIEW_SYNC_BYTE_COUNT && this.syncedZeroCount % 2 === 0) {
          const pairs = this.syncedZeroCount / 2;
          for (let i = 0; i < pairs; i++) {
            this.emitShortNopPacket(this.syncedZeroStartOffset + i * 2, 2, 0, batch);
          }
        } else {
          truncatedPending = true;
        }
        this.syncedZeroCount = 0;
        this.syncedZeroStartOffset = 0;
      }
      if (!this.assembler.isAtBoundary() || truncatedPending) {
        truncatedPending = true;
        this.addDiagnostic(batch, {
          severity: 'warning',
          code: 'truncated-packet',
          message: `传输缺口 (${gap.kind}) 截断了未完成的包`,
          byteOffset: offset,
          segmentId: this.activeSegment?.segmentId ?? 0,
        });
      }
    }
    if (this.candidateProbe) {
      this.discardCandidateProbeAsUnsynced();
    }

    const closed = this.closeActiveSegment(batch, offset, gap.kind);
    this.addGap(batch, {
      kind: gap.kind,
      byteOffset: offset,
      segmentIdBefore: closed?.segmentId,
      droppedPackets: gap.droppedPackets ?? 'unknown',
      droppedBytes: gap.droppedBytes ?? 'unknown',
      reason: gap.reason ?? `显式传输/采集缺口: ${gap.kind}`,
      preservesFraming: Boolean(gap.preservesFraming) && !truncatedPending && this.mode === 'synced',
    });

    if (gap.preservesFraming && !truncatedPending && this.mode === 'synced') {
      this.assembler.reset();
      this.activeSegment = this.createSegment(offset, 'trusted');
      // 保留框架对齐时允许继续解码，但时钟可能中断，清空旧时间锚点等待新 SYSTIME
      this.activeSegment.metadata = closed ? { ...closed.metadata } : {};
      this.activeSegment.sysDescKeys = new Map();
    } else {
      this.enterSeekingSync(offset, gap.kind, gap.reason ?? `缺口后等待可证明重同步: ${gap.kind}`);
    }
    this.trackPendingMemory();
    return batch;
  }

  public finish(): SystemViewDecodeBatch {
    const batch = createEmptyMutableBatch();
    if (this.mode === 'finished') {
      return batch;
    }
    const endOffset = this.totalBytesProcessed;

    if (this.mode === 'seeking-sync' && this.candidateProbe) {
      const incomplete = !this.candidateProbe.assembler.isAtBoundary();
      this.discardCandidateProbeAsUnsynced();
      if (incomplete) {
        this.truncated = true;
      }
      this.addDiagnostic(batch, {
        severity: 'warning',
        code: incomplete ? 'truncated-packet' : 'unconfirmed-sync-candidate',
        message: incomplete
          ? '流结束时重同步候选包未完整结束，已按截断丢弃'
          : '流结束时候选 sync 仅包含弱证据（缺少 TRACE_START + INIT），未提升为可信段',
        byteOffset: endOffset,
        segmentId: 0,
      });
    }

    if (this.mode === 'seeking-sync' && this.unsyncedRegionBytes > 0) {
      const discarded = this.unsyncedRegionBytes;
      const startOff = this.unsyncedRegionStartOffset ?? Math.max(0, endOffset - discarded);
      this.discardedUnsyncedBytes += discarded;
      this.unsyncedRegionBytes = 0;
      this.unsyncedRegionStartOffset = null;
      this.zeroRunCount = 0;
      this.addGap(batch, {
        kind: this.pendingPreSyncGapKind,
        byteOffset: startOff,
        droppedPackets: 'unknown',
        droppedBytes: discarded,
        discardedUnsyncedBytes: discarded,
        reason: `${this.pendingPreSyncGapReason}（流结束前未建立同步）`,
        preservesFraming: false,
      });
    }

    if (this.mode === 'synced') {
      if (this.syncedSyncProbe) {
        this.fallbackSyncedSyncProbeToNop(batch, null);
      }
      if (this.mode === 'synced' && this.syncedZeroCount > 0) {
        const zeros = this.syncedZeroCount;
        const zStart = this.syncedZeroStartOffset;
        this.syncedZeroCount = 0;
        this.syncedZeroStartOffset = 0;
        if (zeros >= SYSTEMVIEW_SYNC_BYTE_COUNT) {
          this.truncated = true;
          this.addDiagnostic(batch, {
            severity: 'error',
            code: 'truncated-sync',
            message: `流在 ${zeros} 字节未完成 sync 处截断`,
            byteOffset: endOffset,
            segmentId: this.activeSegment?.segmentId ?? 0,
          });
          const closed = this.closeActiveSegment(batch, endOffset, 'truncated');
          this.addGap(batch, {
            kind: 'truncated',
            byteOffset: endOffset,
            segmentIdBefore: closed?.segmentId,
            droppedPackets: 'unknown',
            droppedBytes: 'unknown',
            reason: '流尾 sync 序列截断',
            preservesFraming: false,
          });
          this.assembler.reset();
          this.mode = 'finished';
          this.trackPendingMemory();
          return batch;
        }
        const pairs = Math.floor(zeros / 2);
        for (let i = 0; i < pairs; i++) {
          this.emitShortNopPacket(zStart + i * 2, 2, 0, batch);
        }
        if (zeros % 2 === 1) {
          this.assembler.startNopDelta(zStart + pairs * 2);
        }
      }
    }

    if (this.mode === 'synced' && !this.assembler.isAtBoundary()) {
      this.truncated = true;
      const syncZeros = this.assembler.getSyncZeroCount();
      const diagCode: TraceDiagnosticCode = syncZeros > 0 ? 'truncated-sync' : 'truncated-packet';
      this.addDiagnostic(batch, {
        severity: 'error',
        code: diagCode,
        message: syncZeros > 0 ? `流在 ${syncZeros} 字节未完成 sync 处截断` : '流在未完成数据包中间截断',
        byteOffset: endOffset,
        segmentId: this.activeSegment?.segmentId ?? 0,
      });
      const closed = this.closeActiveSegment(batch, endOffset, 'truncated');
      this.addGap(batch, {
        kind: 'truncated',
        byteOffset: endOffset,
        segmentIdBefore: closed?.segmentId,
        droppedPackets: 'unknown',
        droppedBytes: 'unknown',
        reason: syncZeros > 0 ? '流尾 sync 序列截断' : '流尾包不完整截断',
        preservesFraming: false,
      });
    } else if (this.activeSegment) {
      this.closeActiveSegment(batch, endOffset, 'eof');
    }

    this.assembler.reset();
    this.mode = 'finished';
    this.trackPendingMemory();
    return batch;
  }

  private enterSeekingSync(
    offset: number,
    gapKind: TraceGapKind,
    reason: string,
    initialZeros = 0,
    regionStartOffset = offset - initialZeros,
    regionBytes = initialZeros,
  ): void {
    this.mode = 'seeking-sync';
    this.assembler.reset();
    this.candidateProbe = null;
    this.syncedZeroCount = 0;
    this.syncedZeroStartOffset = 0;
    this.syncedSyncProbe = null;
    this.zeroRunCount = initialZeros;
    this.unsyncedRegionStartOffset = regionStartOffset;
    this.unsyncedRegionBytes = regionBytes;
    this.pendingPreSyncGapKind = gapKind;
    this.pendingPreSyncGapReason = reason;
  }

  private discardCandidateProbeAsUnsynced(): void {
    if (!this.candidateProbe) {
      return;
    }
    const probe = this.candidateProbe;
    this.candidateProbe = null;
    if (this.unsyncedRegionStartOffset === null) {
      this.unsyncedRegionStartOffset = probe.syncStartOffset;
    }
    this.unsyncedRegionBytes += SYSTEMVIEW_SYNC_BYTE_COUNT + probe.byteLength;
    this.zeroRunCount = 0;
  }

  /**
   * 迭代处理字节跨度，避免候选重同步失败回放时发生深度递归。
   */
  private processSpan(initialBytes: Uint8Array, initialBaseOffset: number, batch: MutableDecodeBatch): void {
    const queue: Array<{ bytes: Uint8Array; baseOffset: number; pos: number }> = [
      { bytes: initialBytes, baseOffset: initialBaseOffset, pos: 0 },
    ];

    while (queue.length > 0) {
      const current = queue[0];
      while (current.pos < current.bytes.length) {
        const b = current.bytes[current.pos];
        const absOffset = current.baseOffset + current.pos;
        current.pos += 1;

        if (this.mode === 'synced') {
          this.handleSyncedByte(b, absOffset, batch, queue);
          continue;
        }

        // seeking-sync 模式
        if (!this.candidateProbe) {
          if (b === 0) {
            if (this.unsyncedRegionStartOffset === null) {
              this.unsyncedRegionStartOffset = absOffset;
            }
            this.unsyncedRegionBytes += 1;
            this.zeroRunCount += 1;
          } else if (this.zeroRunCount >= SYSTEMVIEW_SYNC_BYTE_COUNT) {
            // 仅把紧邻非零字节的最后 10 个 0 作为候选 sync，之前多余的 0 留在 unsyncedRegionBytes 中
            const syncStartOffset = absOffset - SYSTEMVIEW_SYNC_BYTE_COUNT;
            this.unsyncedRegionBytes = Math.max(0, this.unsyncedRegionBytes - SYSTEMVIEW_SYNC_BYTE_COUNT);
            if (this.unsyncedRegionBytes === 0) {
              this.unsyncedRegionStartOffset = null;
            }
            this.zeroRunCount = 0;
            this.startCandidateProbe(syncStartOffset, b, absOffset, batch, queue);
          } else {
            if (this.unsyncedRegionStartOffset === null) {
              this.unsyncedRegionStartOffset = absOffset;
            }
            this.unsyncedRegionBytes += 1;
            this.zeroRunCount = 0;
          }
        } else {
          this.handleCandidateProbeByte(b, absOffset, batch, queue);
        }
      }
      queue.shift();
    }
  }

  private startCandidateProbe(
    syncStartOffset: number,
    firstByte: number,
    absOffset: number,
    batch: MutableDecodeBatch,
    queue: Array<{ bytes: Uint8Array; baseOffset: number; pos: number }>,
  ): void {
    this.candidateProbe = {
      syncStartOffset,
      assembler: new PacketAssembler({
        knownShortEventIds: this.knownShortEventIds,
        maxPayloadBytes: this.maxPayloadBytes,
        maxStringBytes: this.maxStringBytes,
      }),
      bytes: new Uint8Array(64),
      byteLength: 0,
      packets: [],
    };
    this.handleCandidateProbeByte(firstByte, absOffset, batch, queue);
  }

  private handleCandidateProbeByte(
    b: number,
    absOffset: number,
    batch: MutableDecodeBatch,
    queue: Array<{ bytes: Uint8Array; baseOffset: number; pos: number }>,
  ): void {
    const probe = this.candidateProbe;
    if (!probe) {
      return;
    }
    if (probe.byteLength >= this.maxResyncProbeBytes) {
      this.rejectCandidateProbe(
        'resync-probe-limit-exceeded',
        `重同步确认窗口超过 ${this.maxResyncProbeBytes} 字节仍未确认`,
        absOffset,
        batch,
        queue,
      );
      return;
    }
    if (probe.byteLength >= probe.bytes.length) {
      const nextCap = Math.min(this.maxResyncProbeBytes, probe.bytes.length * 2);
      const next = new Uint8Array(nextCap);
      next.set(probe.bytes);
      probe.bytes = next;
    }
    probe.bytes[probe.byteLength++] = b;

    const step = probe.assembler.feedByte(b, absOffset);
    if (step.kind === 'need-more') {
      return;
    }
    if (step.kind === 'error') {
      this.rejectCandidateProbe(step.code, step.message, step.byteOffset, batch, queue);
      return;
    }
    if (step.kind === 'sync') {
      // 若候选窗口尚未确认却再次碰到 sync，回退丢弃候选前缀以便从新 sync 重新扫描
      this.rejectCandidateProbe('incomplete-sync', '候选重同步在确认前遇到新的 sync', step.startOffset, batch, queue);
      return;
    }

    // 校验显式长度包的固定 schema（如 INIT）是否真合法
    const parsed = this.parsePacketPayload(step.packet);
    if (!parsed.ok) {
      this.rejectCandidateProbe(
        parsed.errorCode ?? 'payload-length-mismatch',
        parsed.errorMessage ?? '候选重同步包 payload 校验失败',
        step.packet.startOffset,
        batch,
        queue,
      );
      return;
    }

    probe.packets.push(step.packet);
    if (probe.packets[0].eventId !== SYSTEMVIEW_EVENT_IDS.TRACE_START) {
      this.rejectCandidateProbe(
        'unconfirmed-sync-candidate',
        '候选 sync 后首包不是 TRACE_START，无法证明同步边界',
        step.packet.startOffset,
        batch,
        queue,
      );
      return;
    }

    const proof = this.checkProbeConfirmation(probe.packets);
    if (proof) {
      this.confirmCandidateProbe(proof, batch);
      return;
    }

    if (probe.packets.length >= 5) {
      this.rejectCandidateProbe(
        'unconfirmed-sync-candidate',
        '候选 sync 后连续多包未出现有效 INIT，无法证明同步边界',
        step.packet.startOffset,
        batch,
        queue,
      );
    }
  }

  private checkProbeConfirmation(packets: readonly RawAssembledPacket[]): SyncProofKind | null {
    if (packets.length < 2 || packets[0].eventId !== SYSTEMVIEW_EVENT_IDS.TRACE_START) {
      return null;
    }
    for (let i = 1; i < packets.length && i <= 4; i++) {
      if (packets[i].eventId === SYSTEMVIEW_EVENT_IDS.INIT) {
        const parsed = this.parsePacketPayload(packets[i]);
        if (parsed.ok && parsed.decoded?.kind === 'init' && parsed.decoded.idShift <= 31) {
          return 'trace-start-init';
        }
        return null;
      }
    }
    return null;
  }

  private rejectCandidateProbe(
    _code: TraceDiagnosticCode,
    _reason: string,
    _offset: number,
    _batch: MutableDecodeBatch,
    queue: Array<{ bytes: Uint8Array; baseOffset: number; pos: number }>,
  ): void {
    const probe = this.candidateProbe;
    if (!probe) {
      return;
    }
    this.candidateProbe = null;
    if (this.unsyncedRegionStartOffset === null) {
      this.unsyncedRegionStartOffset = probe.syncStartOffset;
    }
    // 10 个候选 sync 零字节本身计入丢弃字节，紧随其后的 probe.bytes 从首字节起重新扫描
    this.unsyncedRegionBytes += SYSTEMVIEW_SYNC_BYTE_COUNT;
    this.zeroRunCount = 0;

    const replayBytes = probe.bytes.slice(0, probe.byteLength);
    const replayStartOffset = probe.syncStartOffset + SYSTEMVIEW_SYNC_BYTE_COUNT;
    // 在当前 chunk 尚未读完的部分之前插入回放切片，确保严格的字节序
    queue.splice(1, 0, { bytes: replayBytes, baseOffset: replayStartOffset, pos: 0 });
    // 把 current 留在队首并让外层循环先消耗完？不行：必须先处理 replayBytes 再处理 current 剩余字节！
    // 因此把 current 拆分到 replayBytes 之后
    const current = queue[0];
    if (current.pos < current.bytes.length) {
      const rest = { bytes: current.bytes, baseOffset: current.baseOffset, pos: current.pos };
      current.pos = current.bytes.length;
      queue.splice(2, 0, rest);
    }
  }

  private confirmCandidateProbe(proof: SyncProofKind, batch: MutableDecodeBatch): void {
    const probe = this.candidateProbe;
    if (!probe) {
      return;
    }
    this.candidateProbe = null;

    if (this.unsyncedRegionBytes > 0) {
      const discarded = this.unsyncedRegionBytes;
      const gapOffset = this.unsyncedRegionStartOffset ?? Math.max(0, probe.syncStartOffset - discarded);
      this.discardedUnsyncedBytes += discarded;
      this.unsyncedRegionBytes = 0;
      this.unsyncedRegionStartOffset = null;
      this.addGap(batch, {
        kind: this.pendingPreSyncGapKind,
        byteOffset: gapOffset,
        droppedPackets: 'unknown',
        droppedBytes: discarded,
        discardedUnsyncedBytes: discarded,
        reason: this.pendingPreSyncGapReason,
        preservesFraming: false,
      });
    }

    this.zeroRunCount = 0;
    this.mode = 'synced';
    this.assembler.reset();
    this.totalSyncs += 1;

    const segment = this.createSegment(probe.syncStartOffset, 'trusted', proof);
    this.activeSegment = segment;
    batch.syncs.push({
      byteOffset: probe.syncStartOffset,
      segmentId: segment.segmentId,
      proof,
      inSegment: false,
    });

    for (const rawPacket of probe.packets) {
      this.emitDecodedPacket(rawPacket, batch);
    }
  }

  private emitShortNopPacket(startOffset: number, byteLength: number, deltaTicks: number, batch: MutableDecodeBatch): void {
    this.emitDecodedPacket(
      {
        startOffset,
        byteLength,
        eventId: SYSTEMVIEW_EVENT_IDS.NOP,
        deltaTicks,
        isExplicit: false,
        shortValues: [],
      },
      batch,
    );
  }

  private handleSyncedByte(
    b: number,
    absOffset: number,
    batch: MutableDecodeBatch,
    queue: Array<{ bytes: Uint8Array; baseOffset: number; pos: number }>,
  ): void {
    if (this.syncedSyncProbe) {
      this.handleSyncedSyncProbeByte(b, absOffset, batch, queue);
      return;
    }

    if (this.assembler.isAtBoundary()) {
      if (b === 0) {
        if (this.syncedZeroCount === 0) {
          this.syncedZeroStartOffset = absOffset;
        }
        this.syncedZeroCount += 1;
        // 连续 12 个 0：先确认前 2 字节为合法 NOP(delta=0)，保留后 10 字节以识别邻接真 sync
        if (this.syncedZeroCount === SYSTEMVIEW_SYNC_BYTE_COUNT + 2) {
          this.emitShortNopPacket(this.syncedZeroStartOffset, 2, 0, batch);
          this.syncedZeroStartOffset += 2;
          this.syncedZeroCount = SYSTEMVIEW_SYNC_BYTE_COUNT;
        }
        return;
      }

      if (this.syncedZeroCount > 0) {
        const zeros = this.syncedZeroCount;
        const zStart = this.syncedZeroStartOffset;
        this.syncedZeroCount = 0;
        this.syncedZeroStartOffset = 0;

        if (zeros >= SYSTEMVIEW_SYNC_BYTE_COUNT && b === SYSTEMVIEW_EVENT_IDS.TRACE_START) {
          this.syncedSyncProbe = {
            zerosCount: zeros,
            zeroStartOffset: zStart,
            syncStartOffset: absOffset - SYSTEMVIEW_SYNC_BYTE_COUNT,
            assembler: new PacketAssembler({
              knownShortEventIds: this.knownShortEventIds,
              maxPayloadBytes: this.maxPayloadBytes,
              maxStringBytes: this.maxStringBytes,
            }),
            bytes: new Uint8Array(64),
            byteLength: 0,
            packets: [],
          };
          this.handleSyncedSyncProbeByte(b, absOffset, batch, queue);
          return;
        }

        const pairs = Math.floor(zeros / 2);
        for (let i = 0; i < pairs; i++) {
          this.emitShortNopPacket(zStart + i * 2, 2, 0, batch);
        }
        if (zeros % 2 === 1) {
          this.assembler.startNopDelta(zStart + pairs * 2);
        }
      }
    }

    const step = this.assembler.feedByte(b, absOffset);
    if (step.kind === 'need-more') {
      return;
    }
    if (step.kind === 'error') {
      const zeros = step.syncZeroCountBeforeError ?? 0;
      const packetPrefixBytes = Math.max(0, absOffset - step.packetStartOffset);
      this.addDiagnostic(batch, {
        severity: 'error',
        code: step.code,
        message: step.message,
        byteOffset: step.byteOffset,
        segmentId: this.activeSegment?.segmentId ?? 0,
        eventId: step.eventId,
      });
      const closed = this.closeActiveSegment(batch, step.packetStartOffset, 'decode-sync-loss');
      this.addGap(batch, {
        kind: 'decode-sync-loss',
        byteOffset: step.packetStartOffset,
        segmentIdBefore: closed?.segmentId,
        droppedPackets: 'unknown',
        droppedBytes: 'unknown',
        reason: step.message,
        preservesFraming: false,
      });
      // 把已读入但未成包的失败前缀字节精确计入未同步丢弃区，再按 seeking-sync 处理当前字节 b
      this.enterSeekingSync(
        absOffset,
        'decode-sync-loss',
        `解码失步 (${step.code}) 后等待重同步`,
        zeros,
        step.packetStartOffset,
        packetPrefixBytes,
      );
      if (b === 0) {
        this.zeroRunCount += 1;
        this.unsyncedRegionBytes += 1;
      } else if (this.zeroRunCount >= SYSTEMVIEW_SYNC_BYTE_COUNT) {
        const syncStartOffset = absOffset - SYSTEMVIEW_SYNC_BYTE_COUNT;
        this.unsyncedRegionBytes = Math.max(0, this.unsyncedRegionBytes - SYSTEMVIEW_SYNC_BYTE_COUNT);
        if (this.unsyncedRegionBytes === 0) {
          this.unsyncedRegionStartOffset = null;
        }
        this.zeroRunCount = 0;
        this.startCandidateProbe(syncStartOffset, b, absOffset, batch, queue);
      } else {
        if (this.unsyncedRegionStartOffset === null) {
          this.unsyncedRegionStartOffset = absOffset;
        }
        this.unsyncedRegionBytes += 1;
        this.zeroRunCount = 0;
      }
      return;
    }

    if (step.kind === 'sync') {
      if (!this.activeSegment || this.activeSegment.reliability !== 'trusted') {
        this.closeActiveSegment(batch, step.startOffset, 'resync');
        this.enterSeekingSync(
          step.startOffset + SYSTEMVIEW_SYNC_BYTE_COUNT,
          'decode-schema-error',
          '不确定段内遇到 sync，等待 TRACE_START + INIT 验证恢复可信段',
          SYSTEMVIEW_SYNC_BYTE_COUNT,
          step.startOffset,
          SYSTEMVIEW_SYNC_BYTE_COUNT,
        );
      } else {
        this.totalSyncs += 1;
        this.activeSegment.syncCount += 1;
        batch.syncs.push({
          byteOffset: step.startOffset,
          segmentId: this.activeSegment.segmentId,
          proof: this.activeSegment.syncProof ?? 'trace-start-init',
          inSegment: true,
        });
      }
      return;
    }

    this.emitDecodedPacket(step.packet, batch);
  }

  private handleSyncedSyncProbeByte(
    b: number,
    absOffset: number,
    batch: MutableDecodeBatch,
    queue: Array<{ bytes: Uint8Array; baseOffset: number; pos: number }>,
  ): void {
    const probe = this.syncedSyncProbe;
    if (!probe) {
      return;
    }
    if (probe.byteLength >= this.maxResyncProbeBytes) {
      this.fallbackSyncedSyncProbeToNop(batch, queue);
      // 保留当前字节 b，使它随后进入常规队列重放之后？不，先把它并入 queue 队尾之前，只需让当前 byte 退回 1 字节
      const current = queue[0];
      if (current) {
        current.pos -= 1;
      }
      return;
    }
    if (probe.byteLength >= probe.bytes.length) {
      const nextCap = Math.min(this.maxResyncProbeBytes, probe.bytes.length * 2);
      const next = new Uint8Array(nextCap);
      next.set(probe.bytes);
      probe.bytes = next;
    }
    probe.bytes[probe.byteLength++] = b;

    const step = probe.assembler.feedByte(b, absOffset);
    if (step.kind === 'need-more') {
      return;
    }
    if (step.kind === 'error' || step.kind === 'sync') {
      this.fallbackSyncedSyncProbeToNop(batch, queue);
      return;
    }
    const parsed = this.parsePacketPayload(step.packet);
    if (!parsed.ok) {
      this.fallbackSyncedSyncProbeToNop(batch, queue);
      return;
    }
    probe.packets.push(step.packet);
    if (probe.packets[0].eventId !== SYSTEMVIEW_EVENT_IDS.TRACE_START) {
      this.fallbackSyncedSyncProbeToNop(batch, queue);
      return;
    }

    const proof = this.checkProbeConfirmation(probe.packets);
    if (proof) {
      this.syncedSyncProbe = null;
      if (probe.zerosCount > SYSTEMVIEW_SYNC_BYTE_COUNT) {
        const strayBytes = probe.zerosCount - SYSTEMVIEW_SYNC_BYTE_COUNT;
        this.addDiagnostic(batch, {
          severity: 'error',
          code: 'incomplete-sync',
          message: `真 sync 前存在 ${strayBytes} 字节孤立零字节`,
          byteOffset: probe.zeroStartOffset,
          segmentId: this.activeSegment?.segmentId ?? 0,
        });
        const closed = this.closeActiveSegment(batch, probe.zeroStartOffset, 'decode-sync-loss');
        this.addGap(batch, {
          kind: 'decode-sync-loss',
          byteOffset: probe.zeroStartOffset,
          segmentIdBefore: closed?.segmentId,
          droppedPackets: 'unknown',
          droppedBytes: strayBytes,
          discardedUnsyncedBytes: strayBytes,
          reason: `真 sync 前存在 ${strayBytes} 字节未成包零字节`,
          preservesFraming: false,
        });
        this.discardedUnsyncedBytes += strayBytes;
        const seg = this.createSegment(probe.syncStartOffset, 'trusted', proof);
        this.activeSegment = seg;
        this.totalSyncs += 1;
        batch.syncs.push({
          byteOffset: probe.syncStartOffset,
          segmentId: seg.segmentId,
          proof,
          inSegment: false,
        });
      } else if (this.activeSegment && this.activeSegment.reliability === 'trusted') {
        this.totalSyncs += 1;
        this.activeSegment.syncCount += 1;
        batch.syncs.push({
          byteOffset: probe.syncStartOffset,
          segmentId: this.activeSegment.segmentId,
          proof,
          inSegment: true,
        });
      } else {
        this.closeActiveSegment(batch, probe.syncStartOffset, 'resync');
        const seg = this.createSegment(probe.syncStartOffset, 'trusted', proof);
        this.activeSegment = seg;
        this.totalSyncs += 1;
        batch.syncs.push({
          byteOffset: probe.syncStartOffset,
          segmentId: seg.segmentId,
          proof,
          inSegment: false,
        });
      }
      for (const pkt of probe.packets) {
        this.emitDecodedPacket(pkt, batch);
      }
      return;
    }

    if (probe.packets.length >= 5) {
      this.fallbackSyncedSyncProbeToNop(batch, queue);
    }
  }

  private fallbackSyncedSyncProbeToNop(
    batch: MutableDecodeBatch,
    queue: Array<{ bytes: Uint8Array; baseOffset: number; pos: number }> | null,
  ): void {
    const probe = this.syncedSyncProbe;
    if (!probe) {
      return;
    }
    this.syncedSyncProbe = null;
    // 10 个零字节确认为 5 个 NOP(delta=0)；若为 11 个零则把第 11 个零随 probeBytes 一并回放为 NOP(delta=...)
    const pairs = 5;
    for (let i = 0; i < pairs; i++) {
      this.emitShortNopPacket(probe.zeroStartOffset + i * 2, 2, 0, batch);
    }
    const extraZero = probe.zerosCount - pairs * 2;
    let replayBytes: Uint8Array;
    let replayStartOffset: number;
    if (extraZero > 0) {
      replayBytes = new Uint8Array(extraZero + probe.byteLength);
      replayBytes.set(probe.bytes.subarray(0, probe.byteLength), extraZero);
      replayStartOffset = probe.zeroStartOffset + pairs * 2;
    } else {
      replayBytes = probe.bytes.slice(0, probe.byteLength);
      replayStartOffset = probe.syncStartOffset + SYSTEMVIEW_SYNC_BYTE_COUNT;
    }

    if (!queue) {
      if (replayBytes.length > 0) {
        this.processSpan(replayBytes, replayStartOffset, batch);
      }
      return;
    }

    queue.splice(1, 0, { bytes: replayBytes, baseOffset: replayStartOffset, pos: 0 });
    const current = queue[0];
    if (current.pos < current.bytes.length) {
      const rest = { bytes: current.bytes, baseOffset: current.baseOffset, pos: current.pos };
      current.pos = current.bytes.length;
      queue.splice(2, 0, rest);
    }
  }

  private emitDecodedPacket(rawPacket: RawAssembledPacket, batch: MutableDecodeBatch): void {
    const parsed = this.parsePacketPayload(rawPacket);
    if (!parsed.ok || !parsed.decoded) {
      const segBefore = this.activeSegment;
      this.addDiagnostic(batch, {
        severity: 'error',
        code: parsed.errorCode ?? 'payload-length-mismatch',
        message: parsed.errorMessage ?? `事件 ID=${rawPacket.eventId} payload 校验失败`,
        byteOffset: rawPacket.startOffset,
        segmentId: segBefore?.segmentId ?? 0,
        eventId: rawPacket.eventId,
        details: {
          byteLength: rawPacket.byteLength,
          rawPayloadHex: rawPacket.payload ? bytesToHex(rawPacket.payload) : undefined,
        },
      });
      const closed = this.closeActiveSegment(batch, rawPacket.startOffset, 'decode-schema-error');
      this.addGap(batch, {
        kind: 'decode-schema-error',
        byteOffset: rawPacket.startOffset,
        segmentIdBefore: closed?.segmentId,
        droppedPackets: 1,
        droppedBytes: rawPacket.byteLength,
        reason: parsed.errorMessage ?? `事件 ID=${rawPacket.eventId} payload 与固定 schema 不符`,
        preservesFraming: true,
      });
      // 保留框架对齐但打断连续可信段，直到下次 sync 前新段标记 uncertain
      const nextSeg = this.createSegment(rawPacket.startOffset + rawPacket.byteLength, 'uncertain');
      if (closed) {
        nextSeg.metadata = { ...closed.metadata };
      }
      this.activeSegment = nextSeg;
      return;
    }

    if (!this.activeSegment) {
      this.activeSegment = this.createSegment(rawPacket.startOffset, 'trusted', 'initial-aligned');
    }

    // 处理 INIT 元数据及其冲突检测（可能在当前段或新段生效）
    if (parsed.decoded.kind === 'init') {
      this.handleInitMetadata(rawPacket, parsed.decoded, batch);
    }

    const seg = this.activeSegment;
    // 更新时间戳状态
    const timeState = this.advanceSegmentTimestamp(seg, rawPacket, parsed.decoded, batch);

    // 对依赖 RAMBase / ID_SHIFT 的字段做解析（使用当前有效 INIT 元数据）
    const decoded = this.resolveDecodedIds(parsed.decoded, seg, rawPacket.startOffset, batch);

    // 额外处理 SYSDESC 冲突检查
    if (decoded.kind === 'sysdesc') {
      this.handleSysDescMetadata(rawPacket.startOffset, decoded.parsed, seg, batch);
    }

    // 额外处理 OVERFLOW：记录累计丢包增量并在包之后切分可信段
    let finalDecoded = decoded;
    if (decoded.kind === 'overflow') {
      finalDecoded = this.handleOverflowPayload(decoded.rawDropCount, rawPacket.startOffset, seg, batch);
    }

    const packetIndexInSegment = seg.packetCount;
    seg.packetCount += 1;
    this.totalPacketsDecoded += 1;

    const record: DecodedSystemViewPacket = {
      protocolVersion: SYSTEMVIEW_PROTOCOL_VERSION,
      segmentId: seg.segmentId,
      packetIndexInSegment,
      streamByteOffset: rawPacket.startOffset,
      byteLength: rawPacket.byteLength,
      eventId: rawPacket.eventId,
      eventName: parsed.eventName,
      category: parsed.category,
      schemaReliability: parsed.schemaReliability,
      segmentReliability: seg.reliability,
      deltaTicks: rawPacket.deltaTicks,
      segmentRelativeTicks: seg.relativeTicks.toString(),
      segmentRelativeTicksBigInt: seg.relativeTicks,
      absoluteTicks: timeState.absoluteTicks !== undefined ? timeState.absoluteTicks.toString() : undefined,
      absoluteTicksBigInt: timeState.absoluteTicks,
      rawTimestampMod: timeState.rawTimestampMod,
      timestampWrapped: timeState.timestampWrapped,
      timeAnchorStatus: seg.timeAnchorStatus,
      sysFreqHz: seg.metadata.sysFreqHz,
      timestampUs: timeState.timestampUs,
      timestampNs: timeState.timestampNs,
      decoded: finalDecoded,
    };
    batch.packets.push(record);

    // OVERFLOW 表示目标端缓冲满导致中间丢包，必须切断后续区间连续性。
    // 协议 DropCount 仅统计进入丢包态后的失败计数，不包含每次初次进入 EnableState=2 的触发包，
    // 因此无法单独证明精确丢包总数，droppedPackets 保持 unknown 并同时给出下界 minDroppedPackets。
    if (finalDecoded.kind === 'overflow') {
      const endOffset = rawPacket.startOffset + rawPacket.byteLength;
      const closed = this.closeActiveSegment(batch, endOffset, 'target-overflow');
      this.addGap(batch, {
        kind: 'target-overflow',
        byteOffset: endOffset,
        segmentIdBefore: closed?.segmentId,
        droppedPackets: 'unknown',
        droppedBytes: 'unknown',
        rawDropCount: finalDecoded.rawDropCount,
        minDroppedPackets: finalDecoded.minDroppedPackets,
        reason: `目标端发生 OVERFLOW（协议累计 DropCount=${finalDecoded.rawDropCount}${
          finalDecoded.minDroppedPackets !== undefined ? `，至少丢失 ${finalDecoded.minDroppedPackets} 包` : ''
        }）`,
        preservesFraming: true,
      });
      const nextSeg = this.createSegment(endOffset, 'trusted');
      if (closed) {
        nextSeg.metadata = { ...closed.metadata };
        nextSeg.sysDescKeys = new Map(seg.sysDescKeys);
      }
      // OVERFLOW 包自身的 Delta 已把 LastTxTimeStamp 推进到当前时刻，下一段仍可延续当前周期锚点（若存在）
      if (seg.timeAnchorStatus === 'anchored-cycles' && seg.anchoredTicks !== undefined) {
        nextSeg.timeAnchorStatus = 'anchored-cycles';
        nextSeg.anchoredTicks = seg.anchoredTicks;
        nextSeg.firstAbsoluteTicks = seg.anchoredTicks;
        nextSeg.lastAbsoluteTicks = seg.anchoredTicks;
        nextSeg.rawTimestampMod = seg.rawTimestampMod;
      }
      this.activeSegment = nextSeg;
    }
  }

  private handleInitMetadata(
    rawPacket: RawAssembledPacket,
    init: Extract<DecodedEventPayload, { kind: 'init' }>,
    batch: MutableDecodeBatch,
  ): void {
    const seg = this.activeSegment;
    if (!seg) {
      return;
    }

    if (init.idShift > 31) {
      this.addDiagnostic(batch, {
        severity: 'error',
        code: 'invalid-metadata',
        message: `INIT 携带非法 ID_SHIFT=${init.idShift}（必须在 0..31 内）`,
        byteOffset: rawPacket.startOffset,
        segmentId: seg.segmentId,
        eventId: rawPacket.eventId,
      });
    }
    if (init.sysFreqHz === 0) {
      this.addDiagnostic(batch, {
        severity: 'warning',
        code: 'invalid-metadata',
        message: 'INIT 携带 sysFreqHz=0，无法将 tick 换算为时间',
        byteOffset: rawPacket.startOffset,
        segmentId: seg.segmentId,
        eventId: rawPacket.eventId,
      });
    }

    // 与期望元数据核对
    if (this.expectedMetadata) {
      const conflicts = diffMetadata(this.expectedMetadata, init);
      if (conflicts.length > 0) {
        this.addDiagnostic(batch, {
          severity: 'warning',
          code: 'metadata-conflict',
          message: `INIT 与预期配置冲突: ${conflicts.join('; ')}`,
          byteOffset: rawPacket.startOffset,
          segmentId: seg.segmentId,
          eventId: rawPacket.eventId,
          details: { conflicts, expected: this.expectedMetadata, actual: init },
        });
      }
    }

    // 与本流先前的 INIT 元数据核对（周期 sync 重发相同 INIT 不算冲突）
    if (this.streamMetadataBaseline) {
      const conflicts = diffMetadata(this.streamMetadataBaseline, init);
      if (conflicts.length > 0) {
        this.addDiagnostic(batch, {
          severity: 'warning',
          code: 'metadata-conflict',
          message: `流内 INIT 元数据发生变更: ${conflicts.join('; ')}`,
          byteOffset: rawPacket.startOffset,
          segmentId: seg.segmentId,
          eventId: rawPacket.eventId,
          details: { conflicts, previous: this.streamMetadataBaseline, next: init },
        });
        if (seg.packetCount > 0) {
          const closed = this.closeActiveSegment(batch, rawPacket.startOffset, 'metadata-reconfigured');
          const nextSeg = this.createSegment(rawPacket.startOffset, closed?.reliability ?? 'trusted', seg.syncProof);
          this.activeSegment = nextSeg;
        }
      }
    } else if (seg.metadata.sysFreqHz !== undefined || seg.metadata.ramBaseAddress !== undefined || seg.metadata.idShift !== undefined) {
      const conflicts = diffMetadata(seg.metadata, init);
      if (conflicts.length > 0) {
        this.addDiagnostic(batch, {
          severity: 'warning',
          code: 'metadata-conflict',
          message: `INIT 与初始元数据冲突: ${conflicts.join('; ')}`,
          byteOffset: rawPacket.startOffset,
          segmentId: seg.segmentId,
          eventId: rawPacket.eventId,
          details: { conflicts, initial: seg.metadata, actual: init },
        });
      }
    }

    const targetSeg = this.activeSegment!;
    targetSeg.metadata = {
      sysFreqHz: init.sysFreqHz,
      cpuFreqHz: init.cpuFreqHz,
      ramBaseAddress: init.ramBaseAddress,
      idShift: init.idShift <= 31 ? init.idShift : undefined,
    };
    this.streamMetadataBaseline = { ...targetSeg.metadata };
  }

  private handleSysDescMetadata(
    byteOffset: number,
    parsed: ParsedSysDesc,
    seg: ActiveSegmentState,
    batch: MutableDecodeBatch,
  ): void {
    if (parsed.malformedItems.length > 0) {
      this.addDiagnostic(batch, {
        severity: 'warning',
        code: 'sysdesc-malformed-item',
        message: `SYSDESC 含不可解析项: ${parsed.malformedItems.join(', ')}`,
        byteOffset,
        segmentId: seg.segmentId,
        eventId: SYSTEMVIEW_EVENT_IDS.SYSDESC,
      });
    }
    for (const entry of parsed.entries) {
      const existing = seg.sysDescKeys.get(entry.key);
      if (existing !== undefined) {
        if (existing !== entry.value) {
          this.addDiagnostic(batch, {
            severity: 'warning',
            code: 'metadata-conflict',
            message: `SYSDESC 键 ${entry.key} 冲突: "${existing}" -> "${entry.value}"`,
            byteOffset,
            segmentId: seg.segmentId,
            eventId: SYSTEMVIEW_EVENT_IDS.SYSDESC,
            details: { key: entry.key, previous: existing, next: entry.value },
          });
        }
        seg.sysDescKeys.set(entry.key, entry.value);
      } else if (seg.sysDescKeys.size < this.maxSysDescKeys) {
        seg.sysDescKeys.set(entry.key, entry.value);
      } else if (isStandardSysDescKey(entry.key)) {
        // 标准键优先保留：淘汰一个非标准键，保证长时间自定义键不会挤占关键描述冲突检测
        for (const k of seg.sysDescKeys.keys()) {
          if (!isStandardSysDescKey(k)) {
            seg.sysDescKeys.delete(k);
            break;
          }
        }
        if (seg.sysDescKeys.size < this.maxSysDescKeys) {
          seg.sysDescKeys.set(entry.key, entry.value);
        }
      }
    }
  }

  private handleOverflowPayload(
    rawDropCount: number,
    byteOffset: number,
    seg: ActiveSegmentState,
    batch: MutableDecodeBatch,
  ): Extract<DecodedEventPayload, { kind: 'overflow' }> {
    let incrementalRawDropDelta: number | undefined;
    let minDroppedPackets: number | undefined;
    let dropCountAnomaly = false;
    if (this.lastCumulativeDropCount === null) {
      // 首次 OVERFLOW：DropCount 统计进入 EnableState=2 后的失败尝试，至少另有 1 个触发包未计入
      incrementalRawDropDelta = rawDropCount;
      minDroppedPackets = rawDropCount + 1;
    } else if (rawDropCount >= this.lastCumulativeDropCount) {
      incrementalRawDropDelta = rawDropCount - this.lastCumulativeDropCount;
      minDroppedPackets = incrementalRawDropDelta + 1;
    } else {
      dropCountAnomaly = true;
      this.addDiagnostic(batch, {
        severity: 'warning',
        code: 'metadata-conflict',
        message: `连续 OVERFLOW 的累计 DropCount 回退 (${this.lastCumulativeDropCount} -> ${rawDropCount})`,
        byteOffset,
        segmentId: seg.segmentId,
        eventId: SYSTEMVIEW_EVENT_IDS.OVERFLOW,
      });
    }
    this.lastCumulativeDropCount = rawDropCount;
    return {
      kind: 'overflow',
      rawDropCount,
      incrementalRawDropDelta,
      minDroppedPackets,
      dropCountAnomaly: dropCountAnomaly || undefined,
    };
  }

  private advanceSegmentTimestamp(
    seg: ActiveSegmentState,
    rawPacket: RawAssembledPacket,
    decoded: DecodedEventPayload,
    batch: MutableDecodeBatch,
  ): {
    absoluteTicks?: bigint;
    rawTimestampMod?: number;
    timestampWrapped: boolean;
    timestampUs?: number;
    timestampNs?: string;
  } {
    const delta = BigInt(rawPacket.deltaTicks);
    seg.relativeTicks += delta;

    let timestampWrapped = false;
    if (delta >= seg.timestampModulus) {
      this.addDiagnostic(batch, {
        severity: 'warning',
        code: 'timestamp-delta-exceeds-bits',
        message: `timestamp delta (${rawPacket.deltaTicks}) 超出 ${seg.timestampBits}-bit 计数范围`,
        byteOffset: rawPacket.startOffset,
        segmentId: seg.segmentId,
        eventId: rawPacket.eventId,
      });
      seg.timeAnchorStatus = 'uncertain';
      seg.anchoredTicks = undefined;
      seg.rawTimestampMod = undefined;
    }

    if (seg.timeAnchorStatus === 'anchored-cycles' && seg.anchoredTicks !== undefined && seg.rawTimestampMod !== undefined) {
      const nextRaw = seg.rawTimestampMod + delta;
      if (nextRaw >= seg.timestampModulus) {
        timestampWrapped = true;
        seg.timestampWrapCount += 1;
        this.addDiagnostic(batch, {
          severity: 'info',
          code: 'timestamp-wrap',
          message: `检测到 ${seg.timestampBits}-bit 时间戳回绕（第 ${seg.timestampWrapCount} 次）`,
          byteOffset: rawPacket.startOffset,
          segmentId: seg.segmentId,
          eventId: rawPacket.eventId,
        });
      }
      seg.rawTimestampMod = nextRaw & seg.timestampMask;
      seg.anchoredTicks += delta;
      seg.lastAbsoluteTicks = seg.anchoredTicks;
    }

    if (decoded.kind === 'systime-cycles') {
      const maskedCycles = BigInt(decoded.cycles) & seg.timestampMask;
      if (seg.timeAnchorStatus === 'unanchored') {
        seg.timeAnchorStatus = 'anchored-cycles';
        seg.anchoredTicks = BigInt(decoded.cycles);
        seg.firstAbsoluteTicks = seg.anchoredTicks;
        seg.lastAbsoluteTicks = seg.anchoredTicks;
        seg.rawTimestampMod = maskedCycles;
      } else if (seg.timeAnchorStatus === 'anchored-cycles' && seg.rawTimestampMod !== undefined) {
        if (maskedCycles !== seg.rawTimestampMod) {
          this.addDiagnostic(batch, {
            severity: 'warning',
            code: 'time-anchor-conflict',
            message: `SYSTIME_CYCLES (${maskedCycles}) 与累计 delta 期望值 (${seg.rawTimestampMod}) 不一致`,
            byteOffset: rawPacket.startOffset,
            segmentId: seg.segmentId,
            eventId: rawPacket.eventId,
            details: {
              reportedCycles: decoded.cycles,
              maskedCycles: maskedCycles.toString(),
              expectedMod: seg.rawTimestampMod.toString(),
            },
          });
          seg.timeAnchorStatus = 'uncertain';
          seg.anchoredTicks = undefined;
        }
      }
    } else if (decoded.kind === 'systime-us') {
      const systimeUs = (BigInt(decoded.systimeHigh) << 32n) | BigInt(decoded.systimeLow);
      seg.lastSystimeUs = systimeUs;
      if (seg.timeAnchorStatus === 'unanchored') {
        seg.timeAnchorStatus = 'anchored-systime-us';
      }
    }

    let timestampUs: number | undefined;
    let timestampNs: string | undefined;
    const freq = seg.metadata.sysFreqHz;
    if (seg.anchoredTicks !== undefined && freq !== undefined && freq > 0) {
      const freqBig = BigInt(freq);
      const ns = (seg.anchoredTicks * 1_000_000_000n) / freqBig;
      timestampNs = ns.toString();
      timestampUs = Number((seg.anchoredTicks * 1_000_000n) / freqBig);
    }

    return {
      absoluteTicks: seg.anchoredTicks,
      rawTimestampMod: seg.rawTimestampMod !== undefined ? Number(seg.rawTimestampMod) : undefined,
      timestampWrapped,
      timestampUs,
      timestampNs,
    };
  }

  private resolveId(
    shrunkId: number,
    seg: ActiveSegmentState,
    byteOffset: number,
    eventId: number,
    batch: MutableDecodeBatch,
  ): IdExpansionResult {
    const res = expandShrunkId(shrunkId, seg.metadata.ramBaseAddress, seg.metadata.idShift);
    if (res.status === 'address-overflow' || res.status === 'invalid-shift') {
      this.addDiagnostic(batch, {
        severity: 'warning',
        code: 'id-resolution-failed',
        message: `无法还原资源 ID (${res.status}): shrunkId=${shrunkId}`,
        byteOffset,
        segmentId: seg.segmentId,
        eventId,
      });
    }
    return res;
  }

  private resolveDecodedIds(
    decoded: DecodedEventPayload,
    seg: ActiveSegmentState,
    byteOffset: number,
    batch: MutableDecodeBatch,
  ): DecodedEventPayload {
    const idShift = seg.metadata.idShift;
    switch (decoded.kind) {
      case 'task-start-exec':
      case 'task-start-ready':
      case 'task-create':
      case 'task-terminate': {
        const r = this.resolveId(decoded.shrunkTaskId, seg, byteOffset, SYSTEMVIEW_EVENT_IDS.TASK_CREATE, batch);
        return { ...decoded, taskId: r.value, idResolution: r.status };
      }
      case 'task-stop-ready': {
        const r = this.resolveId(decoded.shrunkTaskId, seg, byteOffset, SYSTEMVIEW_EVENT_IDS.TASK_STOP_READY, batch);
        return { ...decoded, taskId: r.value, idResolution: r.status };
      }
      case 'task-info': {
        const r = this.resolveId(decoded.shrunkTaskId, seg, byteOffset, SYSTEMVIEW_EVENT_IDS.TASK_INFO, batch);
        return { ...decoded, taskId: r.value, idResolution: r.status };
      }
      case 'timer-enter': {
        const r = this.resolveId(decoded.shrunkTimerId, seg, byteOffset, SYSTEMVIEW_EVENT_IDS.TIMER_ENTER, batch);
        return { ...decoded, timerId: r.value, idResolution: r.status };
      }
      case 'stack-info': {
        const r = this.resolveId(decoded.shrunkTaskId, seg, byteOffset, SYSTEMVIEW_EVENT_IDS.STACK_INFO, batch);
        return { ...decoded, taskId: r.value, idResolution: r.status };
      }
      case 'name-resource': {
        const r = this.resolveId(decoded.shrunkResourceId, seg, byteOffset, SYSTEMVIEW_EVENT_IDS.NAME_RESOURCE, batch);
        return { ...decoded, resourceId: r.value, idResolution: r.status };
      }
      case 'ex-heap-define': {
        const h = this.resolveId(decoded.shrunkHeapId, seg, byteOffset, SYSTEMVIEW_EVENT_IDS.EX, batch);
        const b = this.resolveId(decoded.shrunkBaseId, seg, byteOffset, SYSTEMVIEW_EVENT_IDS.EX, batch);
        const heapSizeBytes =
          idShift !== undefined && idShift >= 0 && idShift <= 31
            ? safeShiftLeft(decoded.heapSizeShifted, idShift)
            : undefined;
        return {
          ...decoded,
          heapId: h.value,
          heapIdResolution: h.status,
          baseAddress: b.value,
          baseIdResolution: b.status,
          heapSizeBytes,
        };
      }
      case 'ex-heap-alloc': {
        const h = this.resolveId(decoded.shrunkHeapId, seg, byteOffset, SYSTEMVIEW_EVENT_IDS.EX, batch);
        const u = this.resolveId(decoded.shrunkUserDataId, seg, byteOffset, SYSTEMVIEW_EVENT_IDS.EX, batch);
        const userDataLenBytes =
          idShift !== undefined && idShift >= 0 && idShift <= 31
            ? safeShiftLeft(decoded.userDataLenShifted, idShift)
            : undefined;
        return {
          ...decoded,
          heapId: h.value,
          heapIdResolution: h.status,
          userDataAddress: u.value,
          userDataIdResolution: u.status,
          userDataLenBytes,
        };
      }
      case 'ex-heap-alloc-ex': {
        const h = this.resolveId(decoded.shrunkHeapId, seg, byteOffset, SYSTEMVIEW_EVENT_IDS.EX, batch);
        const u = this.resolveId(decoded.shrunkUserDataId, seg, byteOffset, SYSTEMVIEW_EVENT_IDS.EX, batch);
        const userDataLenBytes =
          idShift !== undefined && idShift >= 0 && idShift <= 31
            ? safeShiftLeft(decoded.userDataLenShifted, idShift)
            : undefined;
        return {
          ...decoded,
          heapId: h.value,
          heapIdResolution: h.status,
          userDataAddress: u.value,
          userDataIdResolution: u.status,
          userDataLenBytes,
        };
      }
      case 'ex-heap-free': {
        const h = this.resolveId(decoded.shrunkHeapId, seg, byteOffset, SYSTEMVIEW_EVENT_IDS.EX, batch);
        const u = this.resolveId(decoded.shrunkUserDataId, seg, byteOffset, SYSTEMVIEW_EVENT_IDS.EX, batch);
        return {
          ...decoded,
          heapId: h.value,
          heapIdResolution: h.status,
          userDataAddress: u.value,
          userDataIdResolution: u.status,
        };
      }
      case 'os-freertos': {
        if (!decoded.params) {
          return decoded;
        }
        const resolvedParams: DecodedOsParam[] = decoded.params.map((p) => {
          if (p.kind !== 'shrunk-id') {
            return p;
          }
          const r = this.resolveId(p.rawValue, seg, byteOffset, SYSTEMVIEW_FREERTOS_API_OFFSET + decoded.apiId, batch);
          return { ...p, resolvedId: r.value, idResolution: r.status };
        });
        return { ...decoded, params: resolvedParams };
      }
      default:
        return decoded;
    }
  }

  private parsePacketPayload(raw: RawAssembledPacket): ParsedPayloadResult {
    const id = raw.eventId;
    if (!raw.isExplicit) {
      return this.parseShortPayload(id, raw.shortValues ?? []);
    }
    return this.parseExplicitPayload(id, raw.payload ?? new Uint8Array(0));
  }

  private parseShortPayload(id: number, values: readonly (number | string)[]): ParsedPayloadResult {
    const name = SYSTEMVIEW_EVENT_NAMES[id] ?? `SHORT_${id}`;
    switch (id) {
      case SYSTEMVIEW_EVENT_IDS.NOP:
        return {
          ok: true,
          eventName: name,
          category: 'standard-short',
          schemaReliability: 'known',
          decoded: { kind: 'nop' },
        };
      case SYSTEMVIEW_EVENT_IDS.OVERFLOW:
        return {
          ok: true,
          eventName: name,
          category: 'standard-short',
          schemaReliability: 'known',
          decoded: { kind: 'overflow', rawDropCount: values[0] as number },
        };
      case SYSTEMVIEW_EVENT_IDS.ISR_ENTER:
        return {
          ok: true,
          eventName: name,
          category: 'standard-short',
          schemaReliability: 'known',
          decoded: { kind: 'isr-enter', irqId: values[0] as number },
        };
      case SYSTEMVIEW_EVENT_IDS.ISR_EXIT:
        return { ok: true, eventName: name, category: 'standard-short', schemaReliability: 'known', decoded: { kind: 'isr-exit' } };
      case SYSTEMVIEW_EVENT_IDS.TASK_START_EXEC:
        return {
          ok: true,
          eventName: name,
          category: 'standard-short',
          schemaReliability: 'known',
          decoded: {
            kind: 'task-start-exec',
            shrunkTaskId: values[0] as number,
            idResolution: 'unresolved-missing-init',
          },
        };
      case SYSTEMVIEW_EVENT_IDS.TASK_STOP_EXEC:
        return {
          ok: true,
          eventName: name,
          category: 'standard-short',
          schemaReliability: 'known',
          decoded: { kind: 'task-stop-exec' },
        };
      case SYSTEMVIEW_EVENT_IDS.TASK_START_READY:
        return {
          ok: true,
          eventName: name,
          category: 'standard-short',
          schemaReliability: 'known',
          decoded: {
            kind: 'task-start-ready',
            shrunkTaskId: values[0] as number,
            idResolution: 'unresolved-missing-init',
          },
        };
      case SYSTEMVIEW_EVENT_IDS.TASK_STOP_READY:
        return {
          ok: true,
          eventName: name,
          category: 'standard-short',
          schemaReliability: 'known',
          decoded: {
            kind: 'task-stop-ready',
            shrunkTaskId: values[0] as number,
            idResolution: 'unresolved-missing-init',
            cause: values[1] as number,
          },
        };
      case SYSTEMVIEW_EVENT_IDS.TASK_CREATE:
        return {
          ok: true,
          eventName: name,
          category: 'standard-short',
          schemaReliability: 'known',
          decoded: {
            kind: 'task-create',
            shrunkTaskId: values[0] as number,
            idResolution: 'unresolved-missing-init',
          },
        };
      case SYSTEMVIEW_EVENT_IDS.TASK_INFO:
        return {
          ok: true,
          eventName: name,
          category: 'standard-short',
          schemaReliability: 'known',
          decoded: {
            kind: 'task-info',
            shrunkTaskId: values[0] as number,
            idResolution: 'unresolved-missing-init',
            priority: values[1] as number,
            name: values[2] as string,
          },
        };
      case SYSTEMVIEW_EVENT_IDS.TRACE_START:
        return {
          ok: true,
          eventName: name,
          category: 'standard-short',
          schemaReliability: 'known',
          decoded: { kind: 'trace-start' },
        };
      case SYSTEMVIEW_EVENT_IDS.TRACE_STOP:
        return {
          ok: true,
          eventName: name,
          category: 'standard-short',
          schemaReliability: 'known',
          decoded: { kind: 'trace-stop' },
        };
      case SYSTEMVIEW_EVENT_IDS.SYSTIME_CYCLES:
        return {
          ok: true,
          eventName: name,
          category: 'standard-short',
          schemaReliability: 'known',
          decoded: { kind: 'systime-cycles', cycles: values[0] as number },
        };
      case SYSTEMVIEW_EVENT_IDS.SYSTIME_US: {
        const low = values[0] as number;
        const high = values[1] as number;
        const us = (BigInt(high) << 32n) | BigInt(low);
        return {
          ok: true,
          eventName: name,
          category: 'standard-short',
          schemaReliability: 'known',
          decoded: { kind: 'systime-us', systimeLow: low, systimeHigh: high, systimeUs: us.toString() },
        };
      }
      case SYSTEMVIEW_EVENT_IDS.SYSDESC: {
        const rawText = values[0] as string;
        return {
          ok: true,
          eventName: name,
          category: 'standard-short',
          schemaReliability: 'known',
          decoded: { kind: 'sysdesc', rawText, parsed: parseSystemDescription(rawText) },
        };
      }
      case SYSTEMVIEW_EVENT_IDS.MARK_START:
        return {
          ok: true,
          eventName: name,
          category: 'standard-short',
          schemaReliability: 'known',
          decoded: { kind: 'mark-start', markerId: values[0] as number },
        };
      case SYSTEMVIEW_EVENT_IDS.MARK_STOP:
        return {
          ok: true,
          eventName: name,
          category: 'standard-short',
          schemaReliability: 'known',
          decoded: { kind: 'mark-stop', markerId: values[0] as number },
        };
      case SYSTEMVIEW_EVENT_IDS.IDLE:
        return { ok: true, eventName: name, category: 'standard-short', schemaReliability: 'known', decoded: { kind: 'idle' } };
      case SYSTEMVIEW_EVENT_IDS.ISR_TO_SCHEDULER:
        return {
          ok: true,
          eventName: name,
          category: 'standard-short',
          schemaReliability: 'known',
          decoded: { kind: 'isr-to-scheduler' },
        };
      case SYSTEMVIEW_EVENT_IDS.TIMER_ENTER:
        return {
          ok: true,
          eventName: name,
          category: 'standard-short',
          schemaReliability: 'known',
          decoded: {
            kind: 'timer-enter',
            shrunkTimerId: values[0] as number,
            idResolution: 'unresolved-missing-init',
          },
        };
      case SYSTEMVIEW_EVENT_IDS.TIMER_EXIT:
        return {
          ok: true,
          eventName: name,
          category: 'standard-short',
          schemaReliability: 'known',
          decoded: { kind: 'timer-exit' },
        };
      case SYSTEMVIEW_EVENT_IDS.STACK_INFO:
        return {
          ok: true,
          eventName: name,
          category: 'standard-short',
          schemaReliability: 'known',
          decoded: {
            kind: 'stack-info',
            shrunkTaskId: values[0] as number,
            idResolution: 'unresolved-missing-init',
            stackBase: values[1] as number,
            stackSize: values[2] as number,
            stackUsage: values[3] as number,
          },
        };
      case SYSTEMVIEW_EVENT_IDS.MODULEDESC:
        return {
          ok: true,
          eventName: name,
          category: 'standard-short',
          schemaReliability: 'known',
          decoded: {
            kind: 'moduledesc',
            moduleId: values[0] as number,
            eventOffset: values[1] as number,
            description: values[2] as string,
          },
        };
      case SYSTEMVIEW_EVENT_IDS.DATA_SAMPLE: {
        const rawValueBits = values[1] as number;
        return {
          ok: true,
          eventName: name,
          category: 'standard-short',
          schemaReliability: 'known',
          decoded: {
            kind: 'data-sample',
            dataId: values[0] as number,
            rawValueBits,
            floatValue: decodeFloatBits(rawValueBits),
          },
        };
      }
      default:
        return {
          ok: false,
          eventName: name,
          category: 'standard-short',
          schemaReliability: 'unknown-explicit',
          errorCode: 'unknown-short-event',
          errorMessage: `未知短事件 ID=${id}`,
        };
    }
  }

  private parseExplicitPayload(id: number, payload: Uint8Array): ParsedPayloadResult {
    const reader = new PayloadReader(payload, this.maxStringBytes);
    const stdName = SYSTEMVIEW_EVENT_NAMES[id];

    const mismatch = (eventName: string, category: PacketCategory, errorMessage: string, code: TraceDiagnosticCode = 'payload-length-mismatch'): ParsedPayloadResult => ({
      ok: false,
      eventName,
      category,
      schemaReliability: 'known',
      errorCode: code,
      errorMessage,
    });

    switch (id) {
      case SYSTEMVIEW_EVENT_IDS.INIT: {
        const u32s = readExactU32s(reader, 4);
        if (!u32s.ok) {
          return mismatch(stdName, 'standard-explicit', `INIT payload 长度或编码错误: ${u32s.message}`, u32s.code);
        }
        return {
          ok: true,
          eventName: stdName,
          category: 'standard-explicit',
          schemaReliability: 'known',
          decoded: {
            kind: 'init',
            sysFreqHz: u32s.values[0],
            cpuFreqHz: u32s.values[1],
            ramBaseAddress: u32s.values[2],
            idShift: u32s.values[3],
          },
        };
      }

      case SYSTEMVIEW_EVENT_IDS.NAME_RESOURCE: {
        const resId = reader.readU32();
        if (!resId.ok) {
          return mismatch(stdName, 'standard-explicit', `NAME_RESOURCE 资源 ID 错误: ${resId.message}`, resId.code);
        }
        const resName = reader.readString();
        if (!resName.ok) {
          return mismatch(stdName, 'standard-explicit', `NAME_RESOURCE 名称错误: ${resName.message}`, resName.code);
        }
        if (reader.remaining !== 0) {
          return mismatch(stdName, 'standard-explicit', `NAME_RESOURCE 存在 ${reader.remaining} 字节多余 payload`);
        }
        return {
          ok: true,
          eventName: stdName,
          category: 'standard-explicit',
          schemaReliability: 'known',
          decoded: {
            kind: 'name-resource',
            shrunkResourceId: resId.value,
            idResolution: 'unresolved-missing-init',
            name: resName.value,
          },
        };
      }

      case SYSTEMVIEW_EVENT_IDS.PRINT_FORMATTED: {
        const text = reader.readString();
        if (!text.ok) {
          return mismatch(stdName, 'standard-explicit', `PRINT_FORMATTED 文本错误: ${text.message}`, text.code);
        }
        const options = reader.readU32();
        if (!options.ok) {
          return mismatch(stdName, 'standard-explicit', `PRINT_FORMATTED options 错误: ${options.message}`, options.code);
        }
        const numArgs = reader.readU32();
        if (!numArgs.ok) {
          return mismatch(stdName, 'standard-explicit', `PRINT_FORMATTED numArgs 错误: ${numArgs.message}`, numArgs.code);
        }
        if (numArgs.value > this.maxPrintArgs) {
          return mismatch(
            stdName,
            'standard-explicit',
            `PRINT_FORMATTED 参数个数 ${numArgs.value} 超过上限 ${this.maxPrintArgs}`,
            'print-arg-count-exceeded',
          );
        }
        if (numArgs.value > reader.remaining) {
          return mismatch(
            stdName,
            'standard-explicit',
            `PRINT_FORMATTED 声明 ${numArgs.value} 个参数，但剩余字节只有 ${reader.remaining}`,
          );
        }
        const args: number[] = [];
        for (let i = 0; i < numArgs.value; i++) {
          const arg = reader.readU32();
          if (!arg.ok) {
            return mismatch(stdName, 'standard-explicit', `PRINT_FORMATTED 参数 #${i} 错误: ${arg.message}`, arg.code);
          }
          args.push(arg.value);
        }
        if (reader.remaining !== 0) {
          return mismatch(stdName, 'standard-explicit', `PRINT_FORMATTED 存在 ${reader.remaining} 字节多余 payload`);
        }
        return {
          ok: true,
          eventName: stdName,
          category: 'standard-explicit',
          schemaReliability: 'known',
          decoded: {
            kind: 'print-formatted',
            text: text.value,
            options: options.value,
            logLevel: options.value & 0x3f,
            append: (options.value & (1 << 6)) !== 0,
            numArgs: numArgs.value,
            args,
          },
        };
      }

      case SYSTEMVIEW_EVENT_IDS.NUMMODULES: {
        const u32s = readExactU32s(reader, 1);
        if (!u32s.ok) {
          return mismatch(stdName, 'standard-explicit', `NUMMODULES payload 长度或编码错误: ${u32s.message}`, u32s.code);
        }
        return {
          ok: true,
          eventName: stdName,
          category: 'standard-explicit',
          schemaReliability: 'known',
          decoded: { kind: 'nummodules', numModules: u32s.values[0] },
        };
      }

      case SYSTEMVIEW_EVENT_IDS.END_CALL: {
        const apiEvent = reader.readU32();
        if (!apiEvent.ok) {
          return mismatch(stdName, 'standard-explicit', `END_CALL 缺少 apiEventId: ${apiEvent.message}`, apiEvent.code);
        }
        let hasReturnValue = false;
        let returnValue: number | undefined;
        if (reader.remaining > 0) {
          const ret = reader.readU32();
          if (!ret.ok) {
            return mismatch(stdName, 'standard-explicit', `END_CALL 返回值编码错误: ${ret.message}`, ret.code);
          }
          hasReturnValue = true;
          returnValue = ret.value;
        }
        if (reader.remaining !== 0) {
          return mismatch(stdName, 'standard-explicit', `END_CALL 存在 ${reader.remaining} 字节多余 payload`);
        }
        const apiId =
          apiEvent.value >= SYSTEMVIEW_FREERTOS_API_OFFSET
            ? apiEvent.value - SYSTEMVIEW_FREERTOS_API_OFFSET
            : undefined;
        const apiName = apiId !== undefined ? FREERTOS_API_NAMES[apiId] : undefined;
        return {
          ok: true,
          eventName: stdName,
          category: 'standard-explicit',
          schemaReliability: 'known',
          decoded: {
            kind: 'end-call',
            apiEventId: apiEvent.value,
            apiId,
            apiName,
            hasReturnValue,
            returnValue,
          },
        };
      }

      case SYSTEMVIEW_EVENT_IDS.TASK_TERMINATE: {
        const u32s = readExactU32s(reader, 1);
        if (!u32s.ok) {
          return mismatch(stdName, 'standard-explicit', `TASK_TERMINATE payload 长度或编码错误: ${u32s.message}`, u32s.code);
        }
        return {
          ok: true,
          eventName: stdName,
          category: 'standard-explicit',
          schemaReliability: 'known',
          decoded: {
            kind: 'task-terminate',
            shrunkTaskId: u32s.values[0],
            idResolution: 'unresolved-missing-init',
          },
        };
      }

      case SYSTEMVIEW_EVENT_IDS.EX:
        return this.parseExtendedPayload(reader, payload);

      default:
        break;
    }

    // 32..511: FreeRTOS OS API 事件
    if (id >= SYSTEMVIEW_FREERTOS_API_OFFSET && id < SYSTEMVIEW_MODULE_EVENT_OFFSET) {
      return this.parseFreeRtosOsEvent(id, payload);
    }

    // 512..1023: 中间件模块事件
    if (id >= SYSTEMVIEW_MODULE_EVENT_OFFSET && id < SYSTEMVIEW_USER_EVENT_MIN) {
      return {
        ok: true,
        eventName: `MODULE_${id}`,
        category: 'module',
        schemaReliability: 'unknown-explicit',
        decoded: {
          kind: 'module-event',
          moduleEventOffset: id - SYSTEMVIEW_MODULE_EVENT_OFFSET,
          rawPayload: payload.slice(),
        },
      };
    }

    // 1024..2047: 用户自定义事件
    if (id >= SYSTEMVIEW_USER_EVENT_MIN && id <= SYSTEMVIEW_USER_EVENT_MAX) {
      return {
        ok: true,
        eventName: `USER_${id}`,
        category: 'user',
        schemaReliability: 'unknown-explicit',
        decoded: {
          kind: 'user-event',
          rawPayload: payload.slice(),
        },
      };
    }

    // 其余显式长度未知事件（如 ID=30 或 >=2048）：保留原始字节，不猜测 schema
    return {
      ok: true,
      eventName: `UNKNOWN_${id}`,
      category: 'unknown-explicit',
      schemaReliability: 'unknown-explicit',
      decoded: {
        kind: 'unknown-explicit',
        rawPayload: payload.slice(),
      },
    };
  }

  private parseExtendedPayload(reader: PayloadReader, payload: Uint8Array): ParsedPayloadResult {
    const exIdRes = reader.readU32();
    if (!exIdRes.ok) {
      return {
        ok: false,
        eventName: 'EX',
        category: 'extended',
        schemaReliability: 'known',
        errorCode: exIdRes.code,
        errorMessage: `EX 事件缺少子 ID: ${exIdRes.message}`,
      };
    }
    const exId = exIdRes.value;
    const exName = SYSTEMVIEW_EX_NAMES[exId] ?? `EX_UNKNOWN_${exId}`;
    const failEx = (msg: string, code: TraceDiagnosticCode = 'payload-length-mismatch'): ParsedPayloadResult => ({
      ok: false,
      eventName: exName,
      category: 'extended',
      schemaReliability: 'known',
      errorCode: code,
      errorMessage: `${exName} payload 错误: ${msg}`,
    });

    switch (exId) {
      case SYSTEMVIEW_EX_IDS.MARK: {
        const u = readExactU32s(reader, 1);
        if (!u.ok) return failEx(u.message, u.code);
        return {
          ok: true,
          eventName: exName,
          category: 'extended',
          schemaReliability: 'known',
          decoded: { kind: 'ex-mark', markerId: u.values[0] },
        };
      }
      case SYSTEMVIEW_EX_IDS.NAME_MARKER: {
        const markerId = reader.readU32();
        if (!markerId.ok) return failEx(markerId.message, markerId.code);
        const name = reader.readString();
        if (!name.ok) return failEx(name.message, name.code);
        if (reader.remaining !== 0) return failEx(`存在 ${reader.remaining} 字节多余 payload`);
        return {
          ok: true,
          eventName: exName,
          category: 'extended',
          schemaReliability: 'known',
          decoded: { kind: 'ex-name-marker', markerId: markerId.value, name: name.value },
        };
      }
      case SYSTEMVIEW_EX_IDS.HEAP_DEFINE: {
        const u = readExactU32s(reader, 4);
        if (!u.ok) return failEx(u.message, u.code);
        return {
          ok: true,
          eventName: exName,
          category: 'extended',
          schemaReliability: 'known',
          decoded: {
            kind: 'ex-heap-define',
            shrunkHeapId: u.values[0],
            heapIdResolution: 'unresolved-missing-init',
            shrunkBaseId: u.values[1],
            baseIdResolution: 'unresolved-missing-init',
            heapSizeShifted: u.values[2],
            metadataSize: u.values[3],
          },
        };
      }
      case SYSTEMVIEW_EX_IDS.HEAP_ALLOC: {
        const u = readExactU32s(reader, 3);
        if (!u.ok) return failEx(u.message, u.code);
        return {
          ok: true,
          eventName: exName,
          category: 'extended',
          schemaReliability: 'known',
          decoded: {
            kind: 'ex-heap-alloc',
            shrunkHeapId: u.values[0],
            heapIdResolution: 'unresolved-missing-init',
            shrunkUserDataId: u.values[1],
            userDataIdResolution: 'unresolved-missing-init',
            userDataLenShifted: u.values[2],
          },
        };
      }
      case SYSTEMVIEW_EX_IDS.HEAP_ALLOC_EX: {
        const u = readExactU32s(reader, 4);
        if (!u.ok) return failEx(u.message, u.code);
        return {
          ok: true,
          eventName: exName,
          category: 'extended',
          schemaReliability: 'known',
          decoded: {
            kind: 'ex-heap-alloc-ex',
            shrunkHeapId: u.values[0],
            heapIdResolution: 'unresolved-missing-init',
            shrunkUserDataId: u.values[1],
            userDataIdResolution: 'unresolved-missing-init',
            userDataLenShifted: u.values[2],
            tag: u.values[3],
          },
        };
      }
      case SYSTEMVIEW_EX_IDS.HEAP_FREE: {
        const u = readExactU32s(reader, 2);
        if (!u.ok) return failEx(u.message, u.code);
        return {
          ok: true,
          eventName: exName,
          category: 'extended',
          schemaReliability: 'known',
          decoded: {
            kind: 'ex-heap-free',
            shrunkHeapId: u.values[0],
            heapIdResolution: 'unresolved-missing-init',
            shrunkUserDataId: u.values[1],
            userDataIdResolution: 'unresolved-missing-init',
          },
        };
      }
      case SYSTEMVIEW_EX_IDS.REGISTER_DATA: {
        const dataId = reader.readU32();
        if (!dataId.ok) return failEx(dataId.message, dataId.code);
        const name = reader.readString();
        if (!name.ok) return failEx(name.message, name.code);
        let dataType: number | undefined;
        let offset: number | undefined;
        let rangeMin: number | undefined;
        let rangeMax: number | undefined;
        let scalingFactorBits: number | undefined;
        let scalingFactor: number | undefined;
        let unit: string | undefined;
        if (reader.remaining > 0) {
          const r = reader.readU32();
          if (!r.ok) return failEx(r.message, r.code);
          dataType = r.value;
        }
        if (reader.remaining > 0) {
          const r = reader.readU32();
          if (!r.ok) return failEx(r.message, r.code);
          offset = r.value;
        }
        if (reader.remaining > 0) {
          const r = reader.readU32();
          if (!r.ok) return failEx(r.message, r.code);
          rangeMin = r.value;
        }
        if (reader.remaining > 0) {
          const r = reader.readU32();
          if (!r.ok) return failEx(r.message, r.code);
          rangeMax = r.value;
        }
        if (reader.remaining > 0) {
          const r = reader.readU32();
          if (!r.ok) return failEx(r.message, r.code);
          scalingFactorBits = r.value;
          scalingFactor = decodeFloatBits(r.value);
        }
        if (reader.remaining > 0) {
          const r = reader.readString();
          if (!r.ok) return failEx(r.message, r.code);
          unit = r.value;
        }
        if (reader.remaining !== 0) return failEx(`存在 ${reader.remaining} 字节多余 payload`);
        return {
          ok: true,
          eventName: exName,
          category: 'extended',
          schemaReliability: 'known',
          decoded: {
            kind: 'ex-register-data',
            dataId: dataId.value,
            name: name.value,
            dataType,
            offset,
            rangeMin,
            rangeMax,
            scalingFactorBits,
            scalingFactor,
            unit,
          },
        };
      }
      case SYSTEMVIEW_EX_IDS.PRINT_ELF: {
        const strAddr = reader.readU32();
        if (!strAddr.ok) return failEx(strAddr.message, strAddr.code);
        const options = reader.readU32();
        if (!options.ok) return failEx(options.message, options.code);
        // 变长参数格式串存放在 ELF 中，此处保留剩余参数字节不做猜测
        const rawArgBytes = payload.slice(reader.offset);
        return {
          ok: true,
          eventName: exName,
          category: 'extended',
          schemaReliability: 'partial',
          decoded: {
            kind: 'ex-print-elf',
            stringAddress: strAddr.value,
            options: options.value,
            rawArgBytes,
          },
        };
      }
      default:
        return {
          ok: true,
          eventName: exName,
          category: 'extended',
          schemaReliability: 'unknown-explicit',
          decoded: {
            kind: 'ex-unknown',
            exId,
            rawPayload: payload.slice(reader.offset),
          },
        };
    }
  }

  private parseFreeRtosOsEvent(eventId: number, payload: Uint8Array): ParsedPayloadResult {
    const apiId = eventId - SYSTEMVIEW_FREERTOS_API_OFFSET;
    const apiName = FREERTOS_API_NAMES[apiId];
    const eventName = apiName ? `OS_${apiName}` : `OS_API_${apiId}`;
    const schema = FREERTOS_TRACE_MACRO_PARAMS[apiId];

    if (!schema) {
      return {
        ok: true,
        eventName,
        category: 'os-freertos',
        schemaReliability: apiName ? 'partial' : 'unknown-explicit',
        decoded: {
          kind: 'os-freertos',
          apiId,
          apiName,
          rawPayload: payload.slice(),
          interpretation: 'unmapped-api',
        },
      };
    }

    const reader = new PayloadReader(payload, this.maxStringBytes);
    const u32s = readExactU32s(reader, schema.length);
    if (!u32s.ok) {
      return {
        ok: true,
        eventName,
        category: 'os-freertos',
        schemaReliability: 'partial',
        decoded: {
          kind: 'os-freertos',
          apiId,
          apiName,
          rawPayload: payload.slice(),
          interpretation: 'param-mismatch',
        },
      };
    }

    const params: DecodedOsParam[] = schema.map((def, i) => ({
      name: def.name,
      rawValue: u32s.values[i],
      kind: def.kind,
      idResolution: def.kind === 'shrunk-id' ? 'unresolved-missing-init' : undefined,
    }));

    return {
      ok: true,
      eventName,
      category: 'os-freertos',
      schemaReliability: 'known',
      decoded: {
        kind: 'os-freertos',
        apiId,
        apiName,
        params,
        rawPayload: payload.slice(),
        interpretation: 'matched',
      },
    };
  }
}

export function decodeSystemViewStream(
  input: Uint8Array | readonly Uint8Array[],
  options?: SystemViewDecoderOptions,
): SystemViewDecodeResult {
  const decoder = new SystemViewStreamDecoder(options);
  const packets: DecodedSystemViewPacket[] = [];
  const syncs: TraceSyncRecord[] = [];
  const gaps: TraceGapRecord[] = [];
  const segments: TraceSegmentSummary[] = [];
  const diagnostics: TraceDiagnostic[] = [];

  const append = (batch: SystemViewDecodeBatch) => {
    appendAll(packets, batch.packets);
    appendAll(syncs, batch.syncs);
    appendAll(gaps, batch.gaps);
    appendAll(segments, batch.segments);
    appendAll(diagnostics, batch.diagnostics);
  };

  if (input instanceof Uint8Array) {
    append(decoder.push(input));
  } else {
    for (const chunk of input) {
      append(decoder.push(chunk));
    }
  }
  append(decoder.finish());

  return {
    packets,
    syncs,
    gaps,
    segments,
    diagnostics,
    summary: decoder.getState(),
  };
}

interface MutableDecodeBatch {
  packets: DecodedSystemViewPacket[];
  syncs: TraceSyncRecord[];
  gaps: TraceGapRecord[];
  segments: TraceSegmentSummary[];
  diagnostics: TraceDiagnostic[];
}

function createEmptyMutableBatch(): MutableDecodeBatch {
  return {
    packets: [],
    syncs: [],
    gaps: [],
    segments: [],
    diagnostics: [],
  };
}

function readExactU32s(
  reader: PayloadReader,
  count: number,
): { ok: true; values: number[] } | { ok: false; code: TraceDiagnosticCode; message: string } {
  const values: number[] = [];
  for (let i = 0; i < count; i++) {
    const r = reader.readU32();
    if (!r.ok) {
      return r;
    }
    values.push(r.value);
  }
  if (reader.remaining !== 0) {
    return {
      ok: false,
      code: 'payload-length-mismatch',
      message: `期望 ${count} 个 U32 参数，但存在 ${reader.remaining} 字节多余 payload`,
    };
  }
  return { ok: true, values };
}

function diffMetadata(a: TraceDecoderMetadata, b: TraceDecoderMetadata): string[] {
  const diffs: string[] = [];
  if (a.sysFreqHz !== undefined && b.sysFreqHz !== undefined && a.sysFreqHz !== b.sysFreqHz) {
    diffs.push(`sysFreqHz ${a.sysFreqHz} !== ${b.sysFreqHz}`);
  }
  if (a.cpuFreqHz !== undefined && b.cpuFreqHz !== undefined && a.cpuFreqHz !== b.cpuFreqHz) {
    diffs.push(`cpuFreqHz ${a.cpuFreqHz} !== ${b.cpuFreqHz}`);
  }
  if (a.ramBaseAddress !== undefined && b.ramBaseAddress !== undefined && a.ramBaseAddress !== b.ramBaseAddress) {
    diffs.push(`ramBaseAddress 0x${a.ramBaseAddress.toString(16)} !== 0x${b.ramBaseAddress.toString(16)}`);
  }
  if (a.idShift !== undefined && b.idShift !== undefined && a.idShift !== b.idShift) {
    diffs.push(`idShift ${a.idShift} !== ${b.idShift}`);
  }
  return diffs;
}

function safeShiftLeft(value: number, shift: number): number | undefined {
  const shifted = BigInt(value) << BigInt(shift);
  if (shifted > BigInt(Number.MAX_SAFE_INTEGER)) {
    return undefined;
  }
  return Number(shifted);
}

function isStandardSysDescKey(key: string): boolean {
  return key === 'N' || key === 'D' || key === 'O' || key === 'C' || key === 'V' || key.startsWith('I#');
}

function appendAll<T>(target: T[], source: readonly T[]): void {
  for (let i = 0; i < source.length; i++) {
    target.push(source[i]);
  }
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}
