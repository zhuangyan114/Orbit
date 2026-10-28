import type { DataSampleSnapshot } from '../../ozone-backend/types';
import { decimateTimelineRange } from './timeline-decimation';

/** Display-only tail; the record store has already retained every raw point. */
export function prepareTimelineLiveSamples(
  snapshots: readonly DataSampleSnapshot[],
  resolutionKey: number | undefined,
): DataSampleSnapshot[] {
  if (resolutionKey === undefined || !Number.isFinite(resolutionKey) || resolutionKey <= 0) return [];
  const output: DataSampleSnapshot[] = [];
  let points = 0;
  for (const snapshot of snapshots) {
    if (!snapshot.data.length) continue;
    const start = snapshot.data[0].timestamp, end = snapshot.data.at(-1)!.timestamp;
    const data = decimateTimelineRange(snapshot.data, start, end, Math.max(1, Math.ceil((end - start) / resolutionKey)));
    points += data.length;
    // Large catch-up/fragmented batches use the bounded host range query.
    // Never advertise coverage for a partially delivered group of channels.
    if (points > 8192) return [];
    output.push({ ...snapshot, data });
  }
  return output;
}
