import type { TimelineEntryState } from '../webview/timeline/timeline-entry-state';
import type { TimelineDataPoint } from '../webview/timeline/timeline-sample-buffer';

export interface TimelineChannel extends TimelineEntryState { id: number; active: boolean; }
export interface TimelineViewState {
  autoFollow: boolean;
  timePerDiv: number;
  viewportEndMs?: number;
  cursorA_ms?: number | null;
  cursorB_ms?: number | null;
  entries: TimelineEntryState[];
}
export interface TimelineMeta {
  recordId: string;
  originalRecordId?: string;
  name: string;
  timeUnit: 'ms';
  timeOriginUtc: string;
  debugStartedAtUtc?: string;
  source: 'debug' | 'import';
  complete: boolean;
  exportRange?: { startMs: number; endMs: number };
}
export interface TimelineRow extends TimelineDataPoint {
  channelId: number; segmentId: number; sequence?: number;
  /** Rebuildable summary metadata; raw CSV remains unchanged. */
  summaryVersion?: 2; summaryNeedsRefine?: boolean;
}
export interface TimelineTab {
  id: string;
  recordId: string;
  name: string;
  kind: 'live' | 'history' | 'template';
  incomplete: boolean;
  error?: string;
}
export const DEFAULT_TIMELINE_VIEW: TimelineViewState = { autoFollow: true, timePerDiv: 100, entries: [] };

export function validTimelineView(value: unknown): value is TimelineViewState {
  if (!value || typeof value !== 'object') return false;
  const v = value as TimelineViewState;
  return typeof v.autoFollow === 'boolean' && Number.isFinite(v.timePerDiv) && v.timePerDiv > 0
    && Array.isArray(v.entries) && v.entries.length <= 1024
    && v.entries.every(e => e && typeof e.expression === 'string' && e.expression.length <= 4096
      && /^#[0-9a-f]{6}$/i.test(e.color) && typeof e.enabled === 'boolean'
      && typeof e.yAutoScale === 'boolean' && Number.isFinite(e.yPerDiv) && e.yPerDiv > 0 && Number.isFinite(e.yCenter))
    && [v.viewportEndMs, v.cursorA_ms, v.cursorB_ms].every(t => t == null || Number.isFinite(t));
}
