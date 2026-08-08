export interface MetricStats {
  count: number;
  retainedCount: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
}

/** Fixed-size numeric sample ring used by on-demand performance snapshots. */
export class BoundedMetric {
  private readonly values: Float64Array;
  private nextIndex = 0;
  private retainedCount = 0;
  private totalCount = 0;

  constructor(capacity = 32_768) {
    this.values = new Float64Array(Math.max(1, capacity));
  }

  record(value: number) {
    if (!Number.isFinite(value)) return;
    this.values[this.nextIndex] = Math.max(0, value);
    this.nextIndex = (this.nextIndex + 1) % this.values.length;
    this.retainedCount = Math.min(this.retainedCount + 1, this.values.length);
    this.totalCount++;
  }

  snapshot(): MetricStats {
    if (this.retainedCount === 0) {
      return { count: this.totalCount, retainedCount: 0, p50: null, p95: null, max: null };
    }
    const sorted = Array.from(this.values.subarray(0, this.retainedCount)).sort((a, b) => a - b);
    const percentile = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
    return {
      count: this.totalCount,
      retainedCount: this.retainedCount,
      p50: percentile(0.5),
      p95: percentile(0.95),
      max: sorted[sorted.length - 1],
    };
  }
}
