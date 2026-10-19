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
export class ProbeClock {
  private readonly estimatesMs: number[] = [];
  private appliedMs: number | null = null;
  private lastProbeMs = 0;

  reset(): void {
    this.estimatesMs.length = 0;
    this.appliedMs = null;
  }

  /**
   * Adds one pairing: the probe clock read `probeNowMs` corresponds to host
   * time `hostMs`. Returns the offset to add to probe times, or null while
   * the clock is still warming up.
   */
  update(hostMs: number, probeNowMs: number): number | null {
    this.estimatesMs.push(hostMs - probeNowMs);
    if (this.estimatesMs.length > WINDOW) this.estimatesMs.shift();
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
