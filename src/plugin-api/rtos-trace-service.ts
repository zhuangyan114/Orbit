import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { AutomationError, type SessionRef } from './protocol';
import type { SessionRegistry } from './session-registry';
import type { traceEventsParams, traceStatisticsParams } from './schemas';
import type { TraceRecordingCoordinator, TraceRecordingMode, TraceRecordingStatus } from '../trace/trace-recording-coordinator';
import type { TraceStorageResult } from '../trace/trace-recording-store';
import type { TraceRecordSummary } from '../webview/rtos/trace-timeline-state';
import type { RtosSnapshot } from '../rtos/model';
import type { RtosCapabilitiesPayload } from '../webview/rtos/rtos-view-state';

const MODES = ['continuous', 'single-shot', 'post-mortem'] as const;
const MAX_QUERY_PAGES = 2048;

function recordSummary(record: TraceRecordingStatus | TraceRecordSummary, source: 'offline' | 'session') {
  return { recordId: record.recordId, mode: record.mode, state: record.state, source,
    integrity: record.integrity, committedRawBytes: record.counters.committedRawBytes,
    packetCount: record.counters.packetsDecoded, gapCount: record.counters.gapCount,
    ...(record.error?.errorCode ? { errorCode: record.error.errorCode } : {}) };
}

function checkWindow(params: z.infer<typeof traceStatisticsParams> | z.infer<typeof traceEventsParams>): void {
  if (BigInt(params.start) >= BigInt(params.end)) throw new AutomationError('InvalidRequest', 'Trace window must be non-empty and half-open', false);
  if (params.unit.startsWith('relative-') && (params.bootGeneration === undefined || params.segmentId === undefined)) {
    throw new AutomationError('InvalidRequest', 'Relative Trace queries require bootGeneration and segmentId', false);
  }
}

function unwrapQuery<T>(result: TraceStorageResult<T>): T {
  if (result.ok) return result.data;
  const code = result.errorCode;
  if (code === 'RecordChanged' || code === 'RecordingClosed') throw new AutomationError('RecordingNotFound', 'Trace recording is no longer open', false);
  if (code === 'QueryCancelled') throw new AutomationError('TargetReadCancelled', 'Trace query was cancelled', true);
  if (code === 'InvalidArgument') throw new AutomationError('InvalidRequest', 'Invalid Trace query', false);
  throw new AutomationError('CapabilityUnavailable', 'Trace query failed', false, { traceErrorCode: code });
}

export class RtosTraceService {
  private inFlightQueries = 0;

  constructor(private readonly registry: SessionRegistry, private readonly coordinator: TraceRecordingCoordinator,
    private readonly getOfflineRecords: () => readonly TraceRecordSummary[]) {}

  private requireSession(ref: SessionRef) {
    const session = this.registry.requireExact(ref);
    if (session !== this.coordinator.activeSession) throw new AutomationError('SessionChanged', 'The requested session is not the active Trace session', false);
    return session;
  }

  private async requestSnapshot<T extends RtosCapabilitiesPayload | RtosSnapshot>(ref: SessionRef, args: Record<string, unknown>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) throw new AutomationError('TargetReadCancelled', 'RTOS request was cancelled', true);
    const session = this.requireSession(ref);
    const value = await session.customRequest('orbitRtosSnapshot', args);
    if (signal.aborted) throw new AutomationError('TargetReadCancelled', 'RTOS request was cancelled', true);
    if (this.requireSession(ref) !== session) throw new AutomationError('SessionChanged', 'Session changed during RTOS request', false);
    if (!value || typeof value !== 'object' || (args.action === 'refresh' ? !Array.isArray(value.tasks) : !value.capabilities)) {
      throw new AutomationError('CapabilityUnavailable', 'RTOS snapshot capability is unavailable', false,
        typeof value?.errorCode === 'string' ? { rtosErrorCode: value.errorCode } : undefined);
    }
    return value as T;
  }

  async capabilities(ref: SessionRef, includeTrace: boolean, signal: AbortSignal) {
    const rtos = await this.requestSnapshot<RtosCapabilitiesPayload>(ref, { action: 'capabilities' }, signal);
    return { ...rtos, ...(includeTrace ? { trace: { modes: [...MODES], archiveFormat: 'orbit', svdat: false, maxEventPage: 200, maxBins: 256 } } : {}) };
  }

  async snapshot(ref: SessionRef, options: { includeObjects: boolean; includeTimers: boolean; includeHeap: boolean }, signal: AbortSignal) {
    const { startedAt, completedAt, ...data } = await this.requestSnapshot<RtosSnapshot>(ref, { action: 'refresh', ...options }, signal);
    return { ...data,
      ...(Number.isFinite(startedAt) ? { startedAt: String(Math.trunc(startedAt)) } : {}),
      ...(Number.isFinite(completedAt) ? { completedAt: String(Math.trunc(completedAt)) } : {}),
    };
  }

  list(source: 'all' | 'session' | 'offline' = 'all') {
    const offline = this.getOfflineRecords().filter(record => record.source === 'offline');
    const live = this.coordinator.listRecordings().filter(record => !offline.some(opened => opened.recordId === record.recordId));
    const records = [...offline.map(record => recordSummary(record, 'offline')), ...live.map(record => recordSummary(record, 'session'))];
    return { items: source === 'all' ? records : records.filter(record => record.source === source), nextCursor: null };
  }

  status(recordId: string) {
    const record = this.list().items.find(record => record.recordId === recordId);
    if (!record) throw new AutomationError('RecordingNotFound', 'Trace recording is not open in this Orbit instance', false);
    return record;
  }

  async describe(recordId: string, includeSegments: boolean) {
    const record = this.status(recordId);
    if (!includeSegments) return record;
    const segments = await this.query(recordId, () => this.coordinator.getSegments(recordId));
    return { ...record, segments: segments.slice(0, 128), segmentsTruncated: segments.length > 128 };
  }

  async start(ref: SessionRef, mode: TraceRecordingMode, signal: AbortSignal) {
    const session = this.requireSession(ref);
    const recordId = `trace-api-${randomUUID()}`;
    const cancel = () => {
      if (this.coordinator.activeSession === session) void this.coordinator.cancelRecording(recordId).catch(() => {});
    };
    if (signal.aborted) throw new AutomationError('TargetReadCancelled', 'Trace start was cancelled', true);
    signal.addEventListener('abort', cancel, { once: true });
    try {
      const record = await this.coordinator.startRecording({ recordId, mode, freezeTimeoutMs: 10000 });
      this.requireSession(ref);
      if (record.error?.errorCode === 'RecordingAlreadyActive') throw new AutomationError('TargetBusy', 'A Trace recording is already active', false);
      if (signal.aborted) throw new AutomationError('TargetReadCancelled', 'Trace start was cancelled', false);
      return recordSummary(record, 'session');
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  }

  async stop(ref: SessionRef, recordId: string) {
    const session = this.requireSession(ref);
    if (!this.coordinator.isActiveRecordingOwnedBy(recordId, session)) {
      throw new AutomationError('RecordingNotFound', 'There is no active Trace recording with that ID', false);
    }
    const stopped = await this.coordinator.stopRecording(recordId);
    if (this.requireSession(ref) !== session) throw new AutomationError('SessionChanged', 'Session changed while stopping Trace', false);
    if (!stopped) throw new AutomationError('RecordingNotFound', 'Trace recording is no longer active', false);
    return recordSummary(stopped, 'session');
  }

  private async query<T>(recordId: string, operation: () => Promise<TraceStorageResult<T>>): Promise<T> {
    this.status(recordId);
    if (this.inFlightQueries >= 4) throw new AutomationError('RateLimited', 'Too many active Trace queries', true);
    this.inFlightQueries++;
    try { return unwrapQuery(await operation()); }
    finally { this.inFlightQueries--; }
  }

  async events(params: z.infer<typeof traceEventsParams>, signal: AbortSignal) {
    checkWindow(params);
    const { recordId, unit, start, end, bootGeneration, segmentId, offset, limit, category, searchText } = params;
    const page = await this.query(recordId, () => this.coordinator.queryEvents(recordId, { unit, start, end, bootGeneration, segmentId,
      offset, limit, filter: { category, searchText }, maxScanPages: MAX_QUERY_PAGES }, { signal }));
    const items = page.items.map(({ eventKey, eventName, eventId, deltaTicks, relTicks, absTicks, ns, bootGeneration, segmentId,
      packetIndexInSegment, streamByteOffset, contextKind, contextKey, irqId, summary, timeAnchorStatus }) => ({
      eventKey, eventName, eventId: String(eventId), deltaTicks, relTicks, absTicks, ns, bootGeneration, segmentId,
      packetIndexInSegment, streamByteOffset, contextKind, contextKey, irqId, summary: summary.slice(0, 2048), timeAnchorStatus,
    }));
    return { recordId, unit, start, end, offset, limit, items, totalMatched: page.totalMatched,
      totalKnownExact: page.totalKnownExact, scanTruncated: page.scanTruncated,
      nextOffset: page.hasMore && items.length ? offset + items.length : null };
  }

  async statistics(params: z.infer<typeof traceStatisticsParams>, signal: AbortSignal) {
    checkWindow(params);
    const { recordId, unit, start, end, bootGeneration, segmentId, maxBins } = params;
    const stats = await this.query(recordId, () => this.coordinator.queryAnalysis(recordId, { unit, start, end, bootGeneration, segmentId,
      maxBins, maxContexts: 64, maxMarkers: 64, maxCandidatePages: MAX_QUERY_PAGES }, { signal }));
    const { precision, approxReason, verifiable, verifiableReason, windowDuration, timeDomainJump, totals, bins, contexts,
      contextsTruncated, markers, markersTruncated } = stats;
    return { recordId, unit, start, end, precision, approxReason, verifiable, verifiableReason, windowDuration, timeDomainJump,
      totals, bins, contexts, contextsTruncated, markers, markersTruncated, gapCount: stats.gapsInWindow.length };
  }
}
