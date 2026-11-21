/** Clock-pairing estimates kept for the probe-to-host offset. */
const WINDOW = 64;
/** Estimates collected before an offset is reported. */
const WARMUP = 8;
/** Largest offset correction per elapsed probe millisecond (0.2 %). */
const SLEW = 0.002;

/**
 * Maps XR-DAP probe timestamps onto the host clock.
 *
 * Each probe read pairs the probe clock with the host clock; the pairing with
 * the lowest round-trip latency gives the most accurate host-minus-probe
 * offset. The first offset is taken once WARMUP pairings exist. Afterwards
 * the applied offset only slews toward the best recent estimate, so a better
 * estimate never shifts plotted points and the probe's own spacing between
 * samples is kept.
 */
export interface ProbeClockSnapshot {
  readonly warmedUp: boolean;
  readonly estimatesCount: number;
  readonly appliedOffsetMs: number | null;
  readonly minOffsetEstimateMs: number | null;
  readonly offsetSpreadMs: number | null;
  /** Minimum measured request-to-reply round-trip window (ms); null unless update() received explicit rttMs. */
  readonly measuredMinRttMs: number | null;
  readonly measuredLastRttMs: number | null;
  readonly lastProbeMs: number;
}

export class ProbeClock {
  private readonly estimatesMs: number[] = [];
  private readonly rttsMs: number[] = [];
  private appliedMs: number | null = null;
  private lastProbeMs = 0;

  reset(): void {
    this.estimatesMs.length = 0;
    this.rttsMs.length = 0;
    this.appliedMs = null;
  }

  snapshot(): ProbeClockSnapshot {
    let minOffsetEstimateMs: number | null = null;
    let offsetSpreadMs: number | null = null;
    if (this.estimatesMs.length > 0) {
      let minVal = this.estimatesMs[0];
      let maxVal = this.estimatesMs[0];
      for (const e of this.estimatesMs) {
        if (e < minVal) minVal = e;
        if (e > maxVal) maxVal = e;
      }
      minOffsetEstimateMs = minVal;
      offsetSpreadMs = maxVal - minVal;
    }
    return {
      warmedUp: this.appliedMs !== null,
      estimatesCount: this.estimatesMs.length,
      appliedOffsetMs: this.appliedMs,
      minOffsetEstimateMs,
      offsetSpreadMs,
      measuredMinRttMs: this.rttsMs.length > 0 ? Math.min(...this.rttsMs) : null,
      measuredLastRttMs: this.rttsMs.length > 0 ? this.rttsMs[this.rttsMs.length - 1] : null,
      lastProbeMs: this.lastProbeMs,
    };
  }

  /**
   * Adds one pairing: the probe clock read `probeNowMs` corresponds to host
   * time `hostMs`. Optional `rttMs` records the measured request/response
   * round-trip window; when omitted, RTT remains unknown (`null`).
   */
  update(hostMs: number, probeNowMs: number, rttMs?: number): number | null {
    this.estimatesMs.push(hostMs - probeNowMs);
    if (this.estimatesMs.length > WINDOW) this.estimatesMs.shift();
    if (typeof rttMs === 'number' && Number.isFinite(rttMs) && rttMs >= 0) {
      this.rttsMs.push(rttMs);
      if (this.rttsMs.length > WINDOW) this.rttsMs.shift();
    }
    const targetMs = Math.min(...this.estimatesMs);
    if (this.appliedMs === null) {
      if (this.estimatesMs.length < WARMUP) return null;
      this.appliedMs = targetMs;
    } else {
      const maxStepMs = Math.max(0, probeNowMs - this.lastProbeMs) * SLEW;
      this.appliedMs += Math.max(-maxStepMs, Math.min(maxStepMs, targetMs - this.appliedMs));
    }
    this.lastProbeMs = probeNowMs;
    return this.appliedMs;
  }
}
