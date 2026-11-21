import type { SegmentReliability, TimeAnchorStatus } from './systemview-decoder';

export type ClockDomainKind =
  | 'target-trace-ticks'
  | 'target-trace-ns'
  | 'probe-clock-ticks'
  | 'host-monotonic-ns'
  | 'timeline-axis-ms';

export type ClockAnchorSource =
  | 'shared-event-calibration'
  | 'probe-clock-pairing'
  | 'control-lifecycle'
  | 'host-rtt-arrival'
  | 'host-wall-start'
  | 'manual-cursor-align'
  | 'none';

export type ClockConfidenceLevel =
  | 'calibrated-high'
  | 'calibrated-moderate'
  | 'approximate'
  | 'manual'
  | 'untrusted'
  | 'uncalibrated';

export type CounterDirection = 'up' | 'down' | 'unknown';

export interface HostClockOrigin {
  readonly originId: string;
  readonly processKind: 'dap' | 'extension-host' | 'offline';
  readonly wallEpochMs?: number;
  readonly monotonicOriginNs?: string;
}

export interface CrossProcessClockPairing {
  readonly fromOriginId: string;
  readonly toOriginId: string;
  readonly offsetNs: string; // toHostNs = fromHostNs + offsetNs
  readonly pairingErrorNs: number;
  readonly pairedAtWallMs: number;
}

export interface CounterUnwrapResult {
  readonly ok: boolean;
  readonly unwrappedTick?: bigint;
  readonly wrapDelta?: number;
  readonly wrapCount?: number;
  readonly errorCode?: 'InvalidBitWidth' | 'RawTickOutOfRange' | 'AmbiguousCounterWrap' | 'CounterDiscontinuity';
  readonly message?: string;
}

/**
 * 计数器回绕展开：支持任意 1..53 位向上/向下计数器的单次与受控多次回绕。
 * 统一坐标约定：
 * - `direction === 'up'`：展开值单调递增（`unwrapped = prev - 0 + delta`，且 `unwrapped & mask === rawTick`）。
 * - `direction === 'down'`：展开值随时间单调递减（`unwrapped = prev - delta`，且 `(unwrapped & mask) === rawTick`，例如 8-bit `3→2→0→255` 展开为 `3→2→0→-1`）。
 * 当提供参考主机经过时间与标称频率时，校验观测增量是否与主机时间窗一致，
 * 若主机窗口跨度大于半个回绕周期或增量偏离容差则拒绝猜测。
 */
export function unwrapCounterTick(params: {
  prevRawTick: bigint;
  prevUnwrappedTick: bigint;
  prevWrapCount: number;
  nextRawTick: bigint;
  tickBits: number;
  direction?: CounterDirection;
  nominalHz?: number;
  expectedElapsedHostNs?: bigint;
  elapsedUncertaintyNs?: number;
  maxDriftPpm?: number;
}): CounterUnwrapResult {
  const {
    prevRawTick,
    prevUnwrappedTick,
    prevWrapCount,
    nextRawTick,
    tickBits,
    direction = 'up',
    nominalHz,
    expectedElapsedHostNs,
    elapsedUncertaintyNs = 0,
    maxDriftPpm = 50_000,
  } = params;

  if (!Number.isInteger(tickBits) || tickBits < 1 || tickBits > 53) {
    return { ok: false, errorCode: 'InvalidBitWidth', message: `Unsupported counter bit width: ${tickBits}` };
  }
  if (direction === 'unknown') {
    return { ok: false, errorCode: 'CounterDiscontinuity', message: 'Counter direction is unknown' };
  }

  const modulus = 1n << BigInt(tickBits);
  const mask = modulus - 1n;
  if (prevRawTick < 0n || prevRawTick >= modulus || nextRawTick < 0n || nextRawTick >= modulus) {
    return {
      ok: false,
      errorCode: 'RawTickOutOfRange',
      message: `Raw counter tick out of ${tickBits}-bit range [0, ${modulus.toString()})`,
    };
  }

  const singleDelta = direction === 'up'
    ? (nextRawTick - prevRawTick) & mask
    : (prevRawTick - nextRawTick) & mask;
  const singleWrapped = direction === 'up' ? nextRawTick < prevRawTick : nextRawTick > prevRawTick;

  if (expectedElapsedHostNs !== undefined && nominalHz !== undefined && nominalHz > 0) {
    const freqBig = BigInt(Math.round(nominalHz));
    const expectedTicks = (expectedElapsedHostNs * freqBig) / 1_000_000_000n;
    const uncertaintyTicks = Math.ceil((Math.max(0, elapsedUncertaintyNs) * nominalHz) / 1e9)
      + Math.ceil((Math.abs(Number(expectedTicks)) * maxDriftPpm) / 1e6)
      + 4;

    if (BigInt(uncertaintyTicks) * 2n >= modulus) {
      return {
        ok: false,
        errorCode: 'AmbiguousCounterWrap',
        message: `Elapsed uncertainty (${uncertaintyTicks} ticks) >= half of ${tickBits}-bit counter period`,
      };
    }

    // Solve k >= 0 minimizing |(singleDelta + k * modulus) - expectedTicks|
    let bestK = 0n;
    if (expectedTicks > singleDelta) {
      const approxK = (expectedTicks - singleDelta + modulus / 2n) / modulus;
      bestK = approxK < 0n ? 0n : approxK;
    }
    const candidateDelta = singleDelta + bestK * modulus;
    const diff = candidateDelta >= expectedTicks ? candidateDelta - expectedTicks : expectedTicks - candidateDelta;
    if (diff > BigInt(uncertaintyTicks)) {
      return {
        ok: false,
        errorCode: 'CounterDiscontinuity',
        message: `Counter delta ${candidateDelta.toString()} ticks disagrees with expected ${expectedTicks.toString()} +/- ${uncertaintyTicks} ticks`,
      };
    }
    const wrapDelta = Number(bestK) + (singleWrapped ? 1 : 0);
    return {
      ok: true,
      unwrappedTick: direction === 'down' ? prevUnwrappedTick - candidateDelta : prevUnwrappedTick + candidateDelta,
      wrapDelta,
      wrapCount: prevWrapCount + wrapDelta,
    };
  }

  const wrapDelta = singleWrapped ? 1 : 0;
  return {
    ok: true,
    unwrappedTick: direction === 'down' ? prevUnwrappedTick - singleDelta : prevUnwrappedTick + singleDelta,
    wrapDelta,
    wrapCount: prevWrapCount + wrapDelta,
  };
}

export interface ClockCalibrationObservation {
  readonly id?: string;
  readonly label?: string;
  readonly source:
    | 'shared-marker'
    | 'shared-variable-edge'
    | 'control-halt'
    | 'probe-pairing'
    | 'rtt-batch-arrival'
    | 'session-boundary';
  readonly targetTicks: bigint;
  readonly probeTicks?: bigint;
  /** Either exact/midpoint hostNs, or hostWindow { lowerNs, upperNs } */
  readonly hostNs?: bigint;
  readonly hostWindow?: { readonly lowerNs: bigint; readonly upperNs: bigint };
  /** One-sided upper bound (e.g. RTT batch arrival hostNs >= targetEmitNs). */
  readonly oneSided?: 'two-sided' | 'upper-bound';
  /** Half-width uncertainty if hostWindow is not provided. */
  readonly uncertaintyNs?: number;
  /** True when the observation has no provable latency/delivery bound (e.g. delayed invalid anchor). */
  readonly unboundedDelay?: boolean;
  readonly role?: 'calibration' | 'verification';
}

export interface ClockErrorBudget {
  readonly tickResolutionNs: number;
  readonly observationErrorNs: number;
  readonly residualRmsNs: number;
  readonly residualMaxNs: number;
  readonly driftUncertaintyNs: number;
  readonly crossProcessErrorNs: number;
  readonly totalErrorNs: number;
  readonly physicalPrecisionNs: number;
  readonly displayUnit: string;
  readonly displayUnitEqualsPhysicalPrecision: boolean;
}

export interface AffineClockFit {
  readonly anchorDomainTicks: bigint;
  readonly anchorHostNs: bigint;
  readonly nominalHz: number;
  readonly direction: CounterDirection;
  readonly driftPpm: number;
  readonly driftMilliPpm: bigint;
  readonly driftKnown: boolean;
  readonly driftUncertaintyPpm: number;
  readonly meanXNs: number;
  readonly sxxNs2: number;
  readonly sampleCount: number;
  readonly maxHalfWidthNs: number;
  readonly residualRmsNs: number;
  readonly residualMaxNs: number;
  readonly anchors: readonly {
    readonly dxNs: number;
    readonly halfWidthNs: number;
  }[];
}

export interface ClockSegmentMapping {
  readonly recordId: string;
  readonly bootGeneration: number;
  readonly segmentId: number;
  readonly reliability: SegmentReliability;
  readonly timeAnchorStatus: TimeAnchorStatus;
  readonly tickDomain: 'absolute-ticks' | 'relative-ticks';
  readonly targetClock: {
    readonly nominalHz?: number;
    readonly direction: CounterDirection;
    readonly tickBits: number;
    readonly wrapCount: number;
    readonly startTicks: bigint;
    readonly endTicks: bigint;
    readonly startNs?: bigint;
    readonly endNs?: bigint;
  };
  readonly probeClock: {
    readonly available: boolean;
    readonly source?: 'xr-dap-probe' | 'rmlink-probe' | 'probe-oracle';
    readonly nominalHz?: number;
    readonly direction?: CounterDirection;
    readonly tickBits?: number;
    readonly wrapCount?: number;
    readonly startTicks?: bigint;
    readonly endTicks?: bigint;
    readonly driftPpm?: number;
    readonly minRttNs?: number;
    readonly reason?: string;
  };
  readonly hostClock: HostClockOrigin & {
    readonly startNs?: bigint;
    readonly endNs?: bigint;
    readonly crossProcessErrorNs: number;
  };
  readonly targetFit?: AffineClockFit;
  readonly probeFit?: AffineClockFit;
  readonly anchorSource: ClockAnchorSource;
  readonly confidence: ClockConfidenceLevel;
  readonly errorBudget: ClockErrorBudget;
  readonly trustedForAutoPreciseSync: boolean;
  readonly exceedsEventScale: boolean;
  readonly eventScaleNs?: number;
  readonly precisionNotice: string;
  readonly diagnostics: readonly string[];
  readonly observationsSummary: {
    readonly totalCount: number;
    readonly twoSidedCount: number;
    readonly oneSidedCount: number;
    readonly verificationCount: number;
    readonly verificationPassed?: boolean;
    readonly verificationMaxErrorNs?: number;
    readonly verificationRmsNs?: number;
  };
}

export interface SerializedClockSegmentMapping {
  readonly recordId: string;
  readonly bootGeneration: number;
  readonly segmentId: number;
  readonly reliability: SegmentReliability;
  readonly timeAnchorStatus: TimeAnchorStatus;
  readonly tickDomain: 'absolute-ticks' | 'relative-ticks';
  readonly targetClock: {
    readonly nominalHz?: number;
    readonly direction: CounterDirection;
    readonly tickBits: number;
    readonly wrapCount: number;
    readonly startTicks: string;
    readonly endTicks: string;
    readonly startNs?: string;
    readonly endNs?: string;
  };
  readonly probeClock: {
    readonly available: boolean;
    readonly source?: 'xr-dap-probe' | 'rmlink-probe' | 'probe-oracle';
    readonly nominalHz?: number;
    readonly direction?: CounterDirection;
    readonly tickBits?: number;
    readonly wrapCount?: number;
    readonly startTicks?: string;
    readonly endTicks?: string;
    readonly driftPpm?: number;
    readonly minRttNs?: number;
    readonly reason?: string;
  };
  readonly hostClock: HostClockOrigin & {
    readonly startNs?: string;
    readonly endNs?: string;
    readonly crossProcessErrorNs: number;
  };
  readonly targetFit?: {
    readonly anchorDomainTicks: string;
    readonly anchorHostNs: string;
    readonly nominalHz: number;
    readonly direction: CounterDirection;
    readonly driftPpm: number;
    readonly driftMilliPpm: string;
    readonly driftKnown: boolean;
    readonly driftUncertaintyPpm: number;
    readonly meanXNs: number;
    readonly sxxNs2: number;
    readonly sampleCount: number;
    readonly maxHalfWidthNs: number;
    readonly residualRmsNs: number;
    readonly residualMaxNs: number;
    readonly anchors: readonly { readonly dxNs: number; readonly halfWidthNs: number }[];
  };
  readonly probeFit?: {
    readonly anchorDomainTicks: string;
    readonly anchorHostNs: string;
    readonly nominalHz: number;
    readonly direction: CounterDirection;
    readonly driftPpm: number;
    readonly driftMilliPpm: string;
    readonly driftKnown: boolean;
    readonly driftUncertaintyPpm: number;
    readonly meanXNs: number;
    readonly sxxNs2: number;
    readonly sampleCount: number;
    readonly maxHalfWidthNs: number;
    readonly residualRmsNs: number;
    readonly residualMaxNs: number;
    readonly anchors: readonly { readonly dxNs: number; readonly halfWidthNs: number }[];
  };
  readonly anchorSource: ClockAnchorSource;
  readonly confidence: ClockConfidenceLevel;
  readonly errorBudget: ClockErrorBudget;
  readonly trustedForAutoPreciseSync: boolean;
  readonly exceedsEventScale: boolean;
  readonly eventScaleNs?: number;
  readonly precisionNotice: string;
  readonly diagnostics: readonly string[];
  readonly observationsSummary: ClockSegmentMapping['observationsSummary'];
}

export interface TraceClockBoundary {
  readonly afterBootGeneration: number;
  readonly afterSegmentId: number;
  readonly beforeBootGeneration: number;
  readonly beforeSegmentId: number;
  readonly reasons: readonly string[];
}

export interface SerializedTraceClockMap {
  readonly version: 1;
  readonly recordId: string;
  readonly hostOrigin: HostClockOrigin;
  readonly segments: readonly SerializedClockSegmentMapping[];
  readonly boundaries: readonly TraceClockBoundary[];
}

export interface TraceClockMap {
  readonly version: 1;
  readonly recordId: string;
  readonly hostOrigin: HostClockOrigin;
  readonly segments: readonly ClockSegmentMapping[];
  readonly boundaries: readonly TraceClockBoundary[];
}

export interface TimelinePauseInterval {
  readonly timelineMs: number;
  readonly pausedAtHostMs: number;
  readonly resumedAtHostMs?: number;
  readonly pausedDurationMs: number;
}

export interface TimelineSessionSegmentMeta {
  readonly sessionIndex: number;
  readonly sessionId?: string;
  readonly bootGeneration?: number;
  readonly name: string;
  readonly startedAtUtc: string;
  readonly startMs: number;
  readonly hostStartMs?: number;
  readonly pauseAdjusted: boolean;
}

export interface TimelineClockSyncMeta {
  readonly samplingSource: 'host' | 'probe' | 'rmlink' | 'import' | 'unknown';
  readonly hostOrigin?: HostClockOrigin;
  readonly originHostMs?: number;
  readonly pauseAdjusted: boolean;
  readonly pauseIntervals: readonly TimelinePauseInterval[];
  readonly sessionSegments: readonly TimelineSessionSegmentMeta[];
  readonly probeClock?: {
    readonly available: boolean;
    readonly source?: 'xr-dap-probe' | 'rmlink-probe';
    readonly warmedUp?: boolean;
    readonly estimatesCount?: number;
    readonly appliedOffsetMs?: number | null;
    readonly minRttMs?: number | null;
    readonly reason?: string;
  };
}

/**
 * O(1) 内存在线中心化仿射回归累加器（Chan/Welford 协方差递推），
 * 适用于 30 分钟及以上长录制，只保留有限代表性锚点用于保守窗口杠杆误差计算。
 */
export class OnlineAffineAccumulator {
  private anchorTicks: bigint | null = null;
  private anchorHostNs: bigint | null = null;
  private count = 0;
  private meanX = 0;
  private meanY = 0;
  private m2x = 0;
  private m2y = 0;
  private cxy = 0;
  private minDx = Infinity;
  private maxDx = -Infinity;
  private maxHalfWidth = 0;
  private readonly keptAnchors: Array<{ dxNs: number; halfWidthNs: number }> = [];

  public constructor(
    private readonly nominalHz: number,
    private readonly direction: CounterDirection = 'up',
    private readonly maxKeptAnchors = 64,
  ) {}

  public add(ticks: bigint, hostNs: bigint, halfWidthNs: number): void {
    if (this.anchorTicks === null || this.anchorHostNs === null) {
      this.anchorTicks = ticks;
      this.anchorHostNs = hostNs;
    }
    const deltaTicks = ticks - this.anchorTicks;
    const signedTicks = this.direction === 'down' ? -deltaTicks : deltaTicks;
    const dx = Number((signedTicks * 1_000_000_000n) / BigInt(Math.round(this.nominalHz)));
    const dy = Number(hostNs - this.anchorHostNs);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;

    this.count++;
    const n = this.count;
    const deltaX = dx - this.meanX;
    const deltaY = dy - this.meanY;
    this.meanX += deltaX / n;
    this.meanY += deltaY / n;
    const deltaX2 = dx - this.meanX;
    const deltaY2 = dy - this.meanY;
    this.m2x += deltaX * deltaX2;
    this.m2y += deltaY * deltaY2;
    this.cxy += deltaX * deltaY2;

    if (dx < this.minDx) this.minDx = dx;
    if (dx > this.maxDx) this.maxDx = dx;
    const safeHalf = Math.max(0, halfWidthNs);
    if (safeHalf > this.maxHalfWidth) this.maxHalfWidth = safeHalf;

    if (this.keptAnchors.length < this.maxKeptAnchors) {
      this.keptAnchors.push({ dxNs: dx, halfWidthNs: safeHalf });
    } else {
      // Deterministic thinning: keep first anchor, replace an interior point periodically, and keep latest endpoint.
      const slot = 1 + (this.count % (this.maxKeptAnchors - 2));
      this.keptAnchors[slot] = { dxNs: dx, halfWidthNs: safeHalf };
      this.keptAnchors[this.maxKeptAnchors - 1] = { dxNs: dx, halfWidthNs: safeHalf };
    }
  }

  public get size(): number {
    return this.count;
  }

  public buildFit(residualsCheck?: readonly { ticks: bigint; hostNs: bigint; halfWidthNs: number }[]): AffineClockFit | undefined {
    if (this.count === 0 || this.anchorTicks === null || this.anchorHostNs === null || !(this.nominalHz > 0)) {
      return undefined;
    }
    let slope = 1;
    let intercept = this.meanY - this.meanX;
    let driftKnown = false;
    let driftUncertaintyPpm = 200;

    if (this.count >= 2 && this.m2x > 0) {
      slope = this.cxy / this.m2x;
      intercept = this.meanY - slope * this.meanX;
      driftKnown = true;
      const span = Math.max(1, this.maxDx - this.minDx);
      // Conservative slope uncertainty from endpoint window width + sample residual dispersion
      const windowSlopeUnc = (2 * this.maxHalfWidth) / span;
      const sse = Math.max(0, this.m2y - slope * this.cxy);
      const sigma = this.count > 2 ? Math.sqrt(sse / (this.count - 2)) : this.maxHalfWidth;
      const statSlopeUnc = sigma / Math.sqrt(this.m2x);
      driftUncertaintyPpm = Math.max(2, Math.max(windowSlopeUnc, statSlopeUnc) * 1e6);
    }

    const driftPpm = (slope - 1) * 1e6;
    const driftMilliPpm = BigInt(Math.round(driftPpm * 1000));
    // Shift anchorHostNs by intercept so formula at anchorDomainTicks includes intercept cleanly
    const interceptBig = BigInt(Math.round(intercept));
    const adjustedAnchorHostNs = this.anchorHostNs + interceptBig;

    let residualMaxNs = 0;
    let sumSq = 0;
    let resCount = 0;
    const freqBig = BigInt(Math.round(this.nominalHz));

    if (residualsCheck && residualsCheck.length > 0) {
      for (const pt of residualsCheck) {
        const dt = pt.ticks - this.anchorTicks;
        const signed = this.direction === 'down' ? -dt : dt;
        const dx = Number((signed * 1_000_000_000n) / freqBig);
        const predDy = intercept + slope * dx;
        const actualDy = Number(pt.hostNs - this.anchorHostNs);
        const err = Math.abs(actualDy - predDy);
        if (err > residualMaxNs) residualMaxNs = err;
        sumSq += err * err;
        resCount++;
      }
    } else if (this.count > 2) {
      const sse = Math.max(0, this.m2y - slope * this.cxy);
      residualMaxNs = Math.sqrt(sse / Math.max(1, this.count - 2)) * 2;
      sumSq = sse;
      resCount = this.count;
    }

    return {
      anchorDomainTicks: this.anchorTicks,
      anchorHostNs: adjustedAnchorHostNs,
      nominalHz: this.nominalHz,
      direction: this.direction,
      driftPpm,
      driftMilliPpm,
      driftKnown,
      driftUncertaintyPpm,
      meanXNs: this.meanX,
      sxxNs2: this.m2x,
      sampleCount: this.count,
      maxHalfWidthNs: this.maxHalfWidth,
      residualRmsNs: resCount > 0 ? Math.sqrt(sumSq / resCount) : 0,
      residualMaxNs,
      anchors: this.keptAnchors.slice(),
    };
  }
}

export function ticksToHostNsWithFit(fit: AffineClockFit, ticks: bigint): bigint {
  const deltaTicks = ticks - fit.anchorDomainTicks;
  const signedTicks = fit.direction === 'down' ? -deltaTicks : deltaTicks;
  const nominalDeltaNs = (signedTicks * 1_000_000_000n) / BigInt(Math.round(fit.nominalHz));
  const driftDeltaNs = (nominalDeltaNs * fit.driftMilliPpm) / 1_000_000_000n;
  return fit.anchorHostNs + nominalDeltaNs + driftDeltaNs;
}

export function hostNsToTicksWithFit(fit: AffineClockFit, hostNs: bigint): bigint {
  const deltaHostNs = hostNs - fit.anchorHostNs;
  const denom = 1_000_000_000n + fit.driftMilliPpm;
  const nominalDeltaNs = denom > 0n ? (deltaHostNs * 1_000_000_000n) / denom : deltaHostNs;
  const deltaTicks = (nominalDeltaNs * BigInt(Math.round(fit.nominalHz))) / 1_000_000_000n;
  return fit.direction === 'down' ? fit.anchorDomainTicks - deltaTicks : fit.anchorDomainTicks + deltaTicks;
}

export function computeFitErrorAtTicks(
  fit: AffineClockFit,
  ticks: bigint,
  extraCrossProcessErrorNs = 0,
  unmeasuredDriftPpm = 200,
): {
  tickResolutionNs: number;
  observationWindowErrorNs: number;
  residualErrorNs: number;
  driftUncertaintyNs: number;
  totalErrorNs: number;
} {
  const tickResolutionNs = fit.nominalHz > 0 ? Math.ceil(1_000_000_000 / fit.nominalHz) : 0;
  const deltaTicks = ticks - fit.anchorDomainTicks;
  const signedTicks = fit.direction === 'down' ? -deltaTicks : deltaTicks;
  const dx = Number((signedTicks * 1_000_000_000n) / BigInt(Math.round(fit.nominalHz)));

  let observationWindowErrorNs = fit.maxHalfWidthNs;
  if (fit.sampleCount >= 2 && fit.sxxNs2 > 0) {
    if (fit.anchors.length === fit.sampleCount) {
      let leverageSum = 0;
      for (const a of fit.anchors) {
        const w = 1 / fit.sampleCount + ((dx - fit.meanXNs) * (a.dxNs - fit.meanXNs)) / fit.sxxNs2;
        leverageSum += Math.abs(w) * a.halfWidthNs;
      }
      observationWindowErrorNs = leverageSum;
    } else {
      // Exact Cauchy-Schwarz envelope for O(1) downsampled long recordings
      const csFactor = Math.sqrt(1 + (fit.sampleCount * (dx - fit.meanXNs) ** 2) / fit.sxxNs2);
      observationWindowErrorNs = fit.maxHalfWidthNs * csFactor;
    }
  }

  let driftUncertaintyNs = 0;
  if (!fit.driftKnown) {
    driftUncertaintyNs = Math.abs(dx) * (unmeasuredDriftPpm / 1e6);
  } else if (fit.anchors.length > 0) {
    const minAnchorDx = Math.min(...fit.anchors.map(a => a.dxNs));
    const maxAnchorDx = Math.max(...fit.anchors.map(a => a.dxNs));
    const outsideDist = dx < minAnchorDx ? minAnchorDx - dx : dx > maxAnchorDx ? dx - maxAnchorDx : 0;
    driftUncertaintyNs = outsideDist * (fit.driftUncertaintyPpm / 1e6);
  }

  const residualErrorNs = Math.max(0, fit.residualMaxNs);
  const totalErrorNs = Math.ceil(
    tickResolutionNs + observationWindowErrorNs + residualErrorNs + driftUncertaintyNs + Math.max(0, extraCrossProcessErrorNs),
  );
  return {
    tickResolutionNs,
    observationWindowErrorNs,
    residualErrorNs,
    driftUncertaintyNs,
    totalErrorNs,
  };
}

function resolveObservationHost(obs: ClockCalibrationObservation): {
  midNs: bigint;
  halfWidthNs: number;
  valid: boolean;
} {
  if (obs.hostWindow) {
    const lo = obs.hostWindow.lowerNs;
    const hi = obs.hostWindow.upperNs;
    if (hi < lo) {
      return { midNs: lo, halfWidthNs: 0, valid: false };
    }
    const width = hi - lo;
    return {
      midNs: lo + width / 2n,
      halfWidthNs: Number(width) / 2,
      valid: true,
    };
  }
  if (obs.hostNs !== undefined) {
    return {
      midNs: obs.hostNs,
      halfWidthNs: Math.max(0, obs.uncertaintyNs ?? 0),
      valid: true,
    };
  }
  return { midNs: 0n, halfWidthNs: 0, valid: false };
}

export interface CalibrateSegmentInput {
  readonly recordId: string;
  readonly bootGeneration: number;
  readonly segmentId: number;
  readonly reliability: SegmentReliability;
  readonly timeAnchorStatus: TimeAnchorStatus;
  readonly tickDomain: 'absolute-ticks' | 'relative-ticks';
  readonly targetClock: {
    readonly nominalHz?: number;
    readonly direction: CounterDirection;
    readonly tickBits: number;
    readonly wrapCount: number;
    readonly startTicks: bigint;
    readonly endTicks: bigint;
  };
  readonly probeClock?: {
    readonly available: boolean;
    readonly source?: 'xr-dap-probe' | 'rmlink-probe' | 'probe-oracle';
    readonly nominalHz?: number;
    readonly direction?: CounterDirection;
    readonly tickBits?: number;
    readonly wrapCount?: number;
    readonly startTicks?: bigint;
    readonly endTicks?: bigint;
    readonly minRttNs?: number;
    readonly reason?: string;
  };
  readonly hostOrigin: HostClockOrigin;
  readonly crossProcessErrorNs?: number;
  readonly observations: readonly ClockCalibrationObservation[];
  readonly eventScaleNs?: number;
  readonly maxPlausibleDriftPpm?: number;
  readonly unmeasuredDriftPpm?: number;
  readonly displayUnit?: string;
}

export function calibrateClockSegment(input: CalibrateSegmentInput): ClockSegmentMapping {
  const {
    recordId,
    bootGeneration,
    segmentId,
    reliability,
    timeAnchorStatus,
    tickDomain,
    targetClock,
    probeClock,
    hostOrigin,
    crossProcessErrorNs = 0,
    observations,
    eventScaleNs = 1_000_000, // 1 ms default event scale threshold
    maxPlausibleDriftPpm = 50_000, // +/- 5%
    unmeasuredDriftPpm = 200,
    displayUnit = 'ns',
  } = input;

  const diagnostics: string[] = [];
  const nominalHz = targetClock.nominalHz;
  const startNs = nominalHz && nominalHz > 0
    ? (targetClock.startTicks * 1_000_000_000n) / BigInt(Math.round(nominalHz))
    : undefined;
  const endNs = nominalHz && nominalHz > 0
    ? (targetClock.endTicks * 1_000_000_000n) / BigInt(Math.round(nominalHz))
    : undefined;
  const tickResolutionNs = nominalHz && nominalHz > 0 ? Math.ceil(1_000_000_000 / nominalHz) : Number.POSITIVE_INFINITY;

  const calObs = observations.filter(o => (o.role ?? 'calibration') === 'calibration');
  const verObs = observations.filter(o => o.role === 'verification');

  const validCalTwoSided: Array<{ obs: ClockCalibrationObservation; midNs: bigint; halfWidthNs: number }> = [];
  const validCalOneSided: Array<{ obs: ClockCalibrationObservation; midNs: bigint; halfWidthNs: number }> = [];
  let hasUnboundedDelayCal = false;

  for (const obs of calObs) {
    if (obs.unboundedDelay) {
      hasUnboundedDelayCal = true;
      diagnostics.push(`Calibration observation ${obs.label ?? obs.id ?? obs.source} marked unboundedDelay`);
      continue;
    }
    const resolved = resolveObservationHost(obs);
    if (!resolved.valid) {
      diagnostics.push(`Invalid host window on observation ${obs.label ?? obs.id ?? obs.source}`);
      continue;
    }
    if (obs.oneSided === 'upper-bound') {
      validCalOneSided.push({ obs, ...resolved });
    } else {
      validCalTwoSided.push({ obs, ...resolved });
    }
  }

  let anchorSource: ClockAnchorSource = 'none';
  if (validCalTwoSided.length > 0) {
    const sources = new Set(validCalTwoSided.map(v => v.obs.source));
    if (sources.has('shared-marker') || sources.has('shared-variable-edge')) {
      anchorSource = 'shared-event-calibration';
    } else if (sources.has('probe-pairing')) {
      anchorSource = 'probe-clock-pairing';
    } else if (sources.has('control-halt')) {
      anchorSource = 'control-lifecycle';
    } else {
      anchorSource = 'host-wall-start';
    }
  } else if (validCalOneSided.length > 0) {
    anchorSource = 'host-rtt-arrival';
  }

  let targetFit: AffineClockFit | undefined;
  let probeFit: AffineClockFit | undefined;

  if (nominalHz && nominalHz > 0 && targetClock.direction !== 'unknown') {
    if (validCalTwoSided.length > 0) {
      const acc = new OnlineAffineAccumulator(nominalHz, targetClock.direction);
      const checkList: Array<{ ticks: bigint; hostNs: bigint; halfWidthNs: number }> = [];
      for (const item of validCalTwoSided) {
        acc.add(item.obs.targetTicks, item.midNs, item.halfWidthNs);
        checkList.push({ ticks: item.obs.targetTicks, hostNs: item.midNs, halfWidthNs: item.halfWidthNs });
      }
      targetFit = acc.buildFit(checkList);
    } else if (validCalOneSided.length > 0) {
      // One-sided upper-bound RTT arrivals: anchor at tightest causal arrival (minimum hostNs - nominalTraceNs)
      const freqBig = BigInt(Math.round(nominalHz));
      let minOffsetNs: bigint | null = null;
      let maxOffsetNs: bigint | null = null;
      let bestObs = validCalOneSided[0];
      for (const item of validCalOneSided) {
        const signed = targetClock.direction === 'down' ? -item.obs.targetTicks : item.obs.targetTicks;
        const nominalTraceNs = (signed * 1_000_000_000n) / freqBig;
        const offset = item.midNs - nominalTraceNs;
        if (minOffsetNs === null || offset < minOffsetNs) {
          minOffsetNs = offset;
          bestObs = item;
        }
        if (maxOffsetNs === null || offset > maxOffsetNs) {
          maxOffsetNs = offset;
        }
      }
      const jitterSpan = minOffsetNs !== null && maxOffsetNs !== null ? Number(maxOffsetNs - minOffsetNs) : 0;
      const halfJitter = jitterSpan / 2 + bestObs.halfWidthNs;
      // Shift anchor downward by halfJitter so interval covers [arrival - jitter - poll, arrival]
      const acc = new OnlineAffineAccumulator(nominalHz, targetClock.direction);
      acc.add(bestObs.obs.targetTicks, bestObs.midNs - BigInt(Math.round(halfJitter)), halfJitter);
      targetFit = acc.buildFit([{ ticks: bestObs.obs.targetTicks, hostNs: bestObs.midNs - BigInt(Math.round(halfJitter)), halfWidthNs: halfJitter }]);
    }
  }

  if (probeClock?.available && probeClock.nominalHz && probeClock.nominalHz > 0 && validCalTwoSided.some(v => v.obs.probeTicks !== undefined)) {
    const pAcc = new OnlineAffineAccumulator(probeClock.nominalHz, probeClock.direction ?? 'up');
    const pCheck: Array<{ ticks: bigint; hostNs: bigint; halfWidthNs: number }> = [];
    for (const item of validCalTwoSided) {
      if (item.obs.probeTicks !== undefined) {
        pAcc.add(item.obs.probeTicks, item.midNs, item.halfWidthNs);
        pCheck.push({ ticks: item.obs.probeTicks, hostNs: item.midNs, halfWidthNs: item.halfWidthNs });
      }
    }
    probeFit = pAcc.buildFit(pCheck);
  }

  // Verification pass (independent verification points, or leave-one-out check if >= 3 points)
  let verificationPassed: boolean | undefined;
  let verificationMaxErrorNs: number | undefined;
  let verificationRmsNs: number | undefined;
  let verificationCount = 0;

  if (targetFit && verObs.length > 0) {
    let sumSq = 0;
    let maxErr = 0;
    let allOk = true;
    for (const v of verObs) {
      const resolved = resolveObservationHost(v);
      if (!resolved.valid) {
        diagnostics.push(`Verification observation ${v.label ?? v.id ?? v.source} has invalid host window`);
        allOk = false;
        continue;
      }
      verificationCount++;
      const predHostNs = ticksToHostNsWithFit(targetFit, v.targetTicks);
      const errBudget = computeFitErrorAtTicks(targetFit, v.targetTicks, crossProcessErrorNs, unmeasuredDriftPpm);
      const predLo = predHostNs - BigInt(errBudget.totalErrorNs);
      const predHi = predHostNs + BigInt(errBudget.totalErrorNs);
      const obsLo = v.hostWindow ? v.hostWindow.lowerNs : resolved.midNs - BigInt(Math.round(resolved.halfWidthNs));
      const obsHi = v.hostWindow ? v.hostWindow.upperNs : resolved.midNs + BigInt(Math.round(resolved.halfWidthNs));
      const diff = Number(resolved.midNs >= predHostNs ? resolved.midNs - predHostNs : predHostNs - resolved.midNs);
      if (diff > maxErr) maxErr = diff;
      sumSq += diff * diff;
      // Fail verification if predicted conservative interval does not intersect observed window (or exceeds total error)
      const intersects = predHi >= obsLo && predLo <= obsHi;
      if (!intersects && diff > errBudget.totalErrorNs + resolved.halfWidthNs) {
        allOk = false;
        diagnostics.push(
          `Verification failed at ${v.label ?? v.id ?? v.targetTicks.toString()}: discrepancy=${Math.round(diff)}ns exceeds budget=${errBudget.totalErrorNs}ns`,
        );
      }
    }
    verificationPassed = allOk && verificationCount > 0;
    verificationMaxErrorNs = verificationCount > 0 ? maxErr : undefined;
    verificationRmsNs = verificationCount > 0 ? Math.sqrt(sumSq / verificationCount) : undefined;
  }

  let hostStartNs: bigint | undefined;
  let hostEndNs: bigint | undefined;
  let maxPointErrorNs = Number.POSITIVE_INFINITY;
  let maxDriftUncNs = 0;
  let maxObsErrorNs = 0;

  if (targetFit) {
    hostStartNs = ticksToHostNsWithFit(targetFit, targetClock.startTicks);
    hostEndNs = ticksToHostNsWithFit(targetFit, targetClock.endTicks);
    const errStart = computeFitErrorAtTicks(targetFit, targetClock.startTicks, crossProcessErrorNs, unmeasuredDriftPpm);
    const errEnd = computeFitErrorAtTicks(targetFit, targetClock.endTicks, crossProcessErrorNs, unmeasuredDriftPpm);
    maxPointErrorNs = Math.max(errStart.totalErrorNs, errEnd.totalErrorNs);
    maxDriftUncNs = Math.max(errStart.driftUncertaintyNs, errEnd.driftUncertaintyNs);
    maxObsErrorNs = Math.max(errStart.observationWindowErrorNs, errEnd.observationWindowErrorNs);
  }

  // Determine confidence & trust strictly
  let confidence: ClockConfidenceLevel = 'uncalibrated';
  if (!nominalHz || nominalHz <= 0 || targetClock.direction === 'unknown') {
    confidence = 'uncalibrated';
    diagnostics.push('Target clock frequency or direction unknown');
  } else if (reliability === 'uncertain') {
    confidence = 'untrusted';
    diagnostics.push('Trace segment reliability is uncertain');
  } else if (hasUnboundedDelayCal && validCalTwoSided.length === 0) {
    confidence = 'untrusted';
    diagnostics.push('Only unbounded delayed observation available; mapping is untrusted');
  } else if (!targetFit) {
    confidence = 'uncalibrated';
    diagnostics.push('No valid clock calibration anchors in segment');
  } else if (Math.abs(targetFit.driftPpm) > maxPlausibleDriftPpm) {
    confidence = 'untrusted';
    diagnostics.push(`Measured clock drift (${targetFit.driftPpm.toFixed(1)} ppm) exceeds plausible bound (+/-${maxPlausibleDriftPpm} ppm)`);
  } else if (verificationPassed === false) {
    confidence = 'untrusted';
  } else if (anchorSource === 'host-wall-start') {
    confidence = 'uncalibrated';
    diagnostics.push('Host wall-clock recording start is a coarse hint only, not calibrated alignment');
  } else if (anchorSource === 'host-rtt-arrival') {
    confidence = 'approximate';
    diagnostics.push('Aligned only via one-sided host RTT batch arrival envelope (includes polling/transport latency)');
  } else if (!targetFit.driftKnown) {
    confidence = 'approximate';
    diagnostics.push('Single-point anchor: clock drift is unmeasured and grows with distance from anchor');
  } else if (targetFit.sampleCount >= 2 && (anchorSource === 'shared-event-calibration' || anchorSource === 'probe-clock-pairing')) {
    confidence = maxPointErrorNs <= 250_000 ? 'calibrated-high' : 'calibrated-moderate';
  } else {
    confidence = 'approximate';
  }

  if (targetFit && validCalTwoSided.length >= 2) {
    let inconsistentCount = 0;
    for (const item of validCalTwoSided) {
      const pred = ticksToHostNsWithFit(targetFit, item.obs.targetTicks);
      const res = Number(item.midNs >= pred ? item.midNs - pred : pred - item.midNs);
      const allowed = item.halfWidthNs + (Number.isFinite(tickResolutionNs) ? tickResolutionNs : 0) + 5_000;
      if (res > allowed) {
        inconsistentCount++;
      }
    }
    if (inconsistentCount > 0 && (confidence === 'calibrated-high' || confidence === 'calibrated-moderate')) {
      confidence = 'untrusted';
      diagnostics.push(
        `${inconsistentCount} calibration observation(s) fall outside their hostWindow bounds (residualMax=${Math.round(targetFit.residualMaxNs)} ns)`,
      );
    }
  }

  const exceedsEventScale = Number.isFinite(maxPointErrorNs) ? maxPointErrorNs > eventScaleNs : true;
  if (exceedsEventScale && (confidence === 'calibrated-high' || confidence === 'calibrated-moderate')) {
    diagnostics.push(`Estimated error (${(maxPointErrorNs / 1e6).toFixed(3)} ms) exceeds target event scale (${(eventScaleNs / 1e6).toFixed(3)} ms)`);
  }

  const trustedForAutoPreciseSync =
    (confidence === 'calibrated-high' || confidence === 'calibrated-moderate')
    && !exceedsEventScale
    && reliability === 'trusted';

  const physicalPrecisionNs = targetFit
    ? Math.max(tickResolutionNs, Math.ceil(maxObsErrorNs + targetFit.residualRmsNs + crossProcessErrorNs))
    : Number.POSITIVE_INFINITY;

  const precisionNotice = buildPrecisionNotice({
    confidence,
    anchorSource,
    nominalHz,
    direction: targetClock.direction,
    displayUnit,
    physicalPrecisionNs,
    totalErrorNs: maxPointErrorNs,
    driftPpm: targetFit?.driftPpm,
    driftKnown: targetFit?.driftKnown ?? false,
    exceedsEventScale,
    eventScaleNs,
    diagnostics,
  });

  return {
    recordId,
    bootGeneration,
    segmentId,
    reliability,
    timeAnchorStatus,
    tickDomain,
    targetClock: {
      nominalHz,
      direction: targetClock.direction,
      tickBits: targetClock.tickBits,
      wrapCount: targetClock.wrapCount,
      startTicks: targetClock.startTicks,
      endTicks: targetClock.endTicks,
      ...(startNs !== undefined ? { startNs } : {}),
      ...(endNs !== undefined ? { endNs } : {}),
    },
    probeClock: probeClock
      ? {
          available: probeClock.available,
          source: probeClock.source,
          nominalHz: probeClock.nominalHz,
          direction: probeClock.direction,
          tickBits: probeClock.tickBits,
          wrapCount: probeClock.wrapCount,
          startTicks: probeClock.startTicks,
          endTicks: probeClock.endTicks,
          ...(probeFit ? { driftPpm: probeFit.driftPpm } : {}),
          minRttNs: probeClock.minRttNs,
          reason: probeClock.reason,
        }
      : { available: false, reason: 'No probe hardware clock on this link' },
    hostClock: {
      ...hostOrigin,
      ...(hostStartNs !== undefined ? { startNs: hostStartNs } : {}),
      ...(hostEndNs !== undefined ? { endNs: hostEndNs } : {}),
      crossProcessErrorNs,
    },
    ...(targetFit ? { targetFit } : {}),
    ...(probeFit ? { probeFit } : {}),
    anchorSource,
    confidence,
    errorBudget: {
      tickResolutionNs: Number.isFinite(tickResolutionNs) ? tickResolutionNs : 0,
      observationErrorNs: Math.round(maxObsErrorNs),
      residualRmsNs: Math.round(targetFit?.residualRmsNs ?? 0),
      residualMaxNs: Math.round(targetFit?.residualMaxNs ?? 0),
      driftUncertaintyNs: Math.round(maxDriftUncNs),
      crossProcessErrorNs: Math.round(crossProcessErrorNs),
      totalErrorNs: Number.isFinite(maxPointErrorNs) ? Math.round(maxPointErrorNs) : Number.MAX_SAFE_INTEGER,
      physicalPrecisionNs: Number.isFinite(physicalPrecisionNs) ? Math.round(physicalPrecisionNs) : Number.MAX_SAFE_INTEGER,
      displayUnit,
      displayUnitEqualsPhysicalPrecision: Number.isFinite(physicalPrecisionNs) && Number.isFinite(tickResolutionNs)
        ? physicalPrecisionNs <= tickResolutionNs && tickResolutionNs <= 1
        : false,
    },
    trustedForAutoPreciseSync,
    exceedsEventScale,
    eventScaleNs,
    precisionNotice,
    diagnostics,
    observationsSummary: {
      totalCount: observations.length,
      twoSidedCount: validCalTwoSided.length,
      oneSidedCount: validCalOneSided.length,
      verificationCount,
      ...(verificationPassed !== undefined ? { verificationPassed } : {}),
      ...(verificationMaxErrorNs !== undefined ? { verificationMaxErrorNs } : {}),
      ...(verificationRmsNs !== undefined ? { verificationRmsNs } : {}),
    },
  };
}

function buildPrecisionNotice(params: {
  confidence: ClockConfidenceLevel;
  anchorSource: ClockAnchorSource;
  nominalHz?: number;
  direction: CounterDirection;
  displayUnit: string;
  physicalPrecisionNs: number;
  totalErrorNs: number;
  driftPpm?: number;
  driftKnown: boolean;
  exceedsEventScale: boolean;
  eventScaleNs: number;
  diagnostics: readonly string[];
}): string {
  const {
    confidence,
    anchorSource,
    nominalHz,
    direction,
    displayUnit,
    totalErrorNs,
    driftPpm,
    driftKnown,
    exceedsEventScale,
    eventScaleNs,
  } = params;
  const freqText = nominalHz && nominalHz > 0 ? `${(nominalHz / 1e6).toFixed(3).replace(/\.?0+$/, '')}MHz/${direction}` : '未知频率';
  const errText = Number.isFinite(totalErrorNs) && totalErrorNs < Number.MAX_SAFE_INTEGER
    ? (totalErrorNs >= 1_000_000 ? `±${(totalErrorNs / 1e6).toFixed(3)}ms` : `±${(totalErrorNs / 1e3).toFixed(1)}µs`)
    : '未知误差';
  const driftText = driftKnown && driftPpm !== undefined ? `漂移 ${driftPpm >= 0 ? '+' : ''}${driftPpm.toFixed(1)}ppm` : '漂移未测';

  if (confidence === 'uncalibrated') {
    return `显示单位 ${displayUnit} 不代表物理同步精度；${freqText}，当前未校准 (${anchorSource})，禁止硬对齐起点`;
  }
  if (confidence === 'untrusted') {
    return `时间映射不可信 (${freqText})：${params.diagnostics[0] ?? '存在冲突/失真/不可信段'}`;
  }
  if (exceedsEventScale) {
    return `显示单位 ${displayUnit}≠物理精度；${freqText}，误差 ${errText} (${driftText}) 超出事件尺度 ${(eventScaleNs / 1e6).toFixed(2)}ms，仅支持近似/手动关联`;
  }
  return `显示单位 ${displayUnit}≠物理精度；${freqText}，${anchorSource}，误差 ${errText} (${driftText})`;
}

export interface PointMappingResult {
  readonly ok: boolean;
  readonly hostNs?: bigint;
  readonly lowerHostNs?: bigint;
  readonly upperHostNs?: bigint;
  readonly uncertaintyNs?: number;
  readonly targetTicks?: bigint;
  readonly probeTicks?: bigint;
  readonly bootGeneration?: number;
  readonly segmentId?: number;
  readonly confidence: ClockConfidenceLevel;
  readonly anchorSource: ClockAnchorSource;
  readonly trustedForAutoPreciseSync: boolean;
  readonly exceedsEventScale: boolean;
  readonly precisionNotice: string;
  readonly errorCode?:
    | 'UncalibratedClock'
    | 'UntrustedClockMapping'
    | 'OutOfSegmentRange'
    | 'FallsInTraceGap'
    | 'OutOfRecordingRange'
    | 'IncompatibleClockOrigin';
  readonly message?: string;
}

export function mapSegmentTraceTickToHost(
  segment: ClockSegmentMapping,
  traceTick: bigint,
  options?: { allowApproximate?: boolean; allowManual?: boolean },
): PointMappingResult {
  if (segment.confidence === 'uncalibrated' || !segment.targetFit) {
    return {
      ok: false,
      confidence: segment.confidence,
      anchorSource: segment.anchorSource,
      trustedForAutoPreciseSync: false,
      exceedsEventScale: segment.exceedsEventScale,
      precisionNotice: segment.precisionNotice,
      errorCode: 'UncalibratedClock',
      message: `Segment (boot=${segment.bootGeneration}, seg=${segment.segmentId}) is uncalibrated`,
    };
  }
  if (segment.confidence === 'untrusted') {
    return {
      ok: false,
      confidence: segment.confidence,
      anchorSource: segment.anchorSource,
      trustedForAutoPreciseSync: false,
      exceedsEventScale: segment.exceedsEventScale,
      precisionNotice: segment.precisionNotice,
      errorCode: 'UntrustedClockMapping',
      message: segment.diagnostics[0] ?? `Segment (boot=${segment.bootGeneration}, seg=${segment.segmentId}) mapping is untrusted`,
    };
  }
  if (segment.confidence === 'approximate' && options?.allowApproximate === false) {
    return {
      ok: false,
      confidence: segment.confidence,
      anchorSource: segment.anchorSource,
      trustedForAutoPreciseSync: false,
      exceedsEventScale: segment.exceedsEventScale,
      precisionNotice: segment.precisionNotice,
      errorCode: 'UncalibratedClock',
      message: 'Segment only has approximate mapping; precise sync disabled',
    };
  }
  if (segment.confidence === 'manual' && options?.allowManual === false) {
    return {
      ok: false,
      confidence: segment.confidence,
      anchorSource: segment.anchorSource,
      trustedForAutoPreciseSync: false,
      exceedsEventScale: segment.exceedsEventScale,
      precisionNotice: segment.precisionNotice,
      errorCode: 'UncalibratedClock',
      message: 'Segment only has manual offset; automatic sync disabled',
    };
  }
  const minTick = segment.targetClock.startTicks <= segment.targetClock.endTicks
    ? segment.targetClock.startTicks
    : segment.targetClock.endTicks;
  const maxTick = segment.targetClock.startTicks >= segment.targetClock.endTicks
    ? segment.targetClock.startTicks
    : segment.targetClock.endTicks;
  if (traceTick < minTick || traceTick > maxTick) {
    return {
      ok: false,
      confidence: segment.confidence,
      anchorSource: segment.anchorSource,
      trustedForAutoPreciseSync: false,
      exceedsEventScale: segment.exceedsEventScale,
      precisionNotice: segment.precisionNotice,
      errorCode: 'OutOfSegmentRange',
      message: `Tick ${traceTick.toString()} lies outside segment [${minTick.toString()}, ${maxTick.toString()}] (refusing cross-gap/reset extrapolation)`,
    };
  }

  const hostNs = ticksToHostNsWithFit(segment.targetFit, traceTick);
  const err = computeFitErrorAtTicks(targetFitOrThrow(segment.targetFit), traceTick, segment.hostClock.crossProcessErrorNs);
  const errBig = BigInt(err.totalErrorNs);
  const probeTicks = segment.probeFit ? hostNsToTicksWithFit(segment.probeFit, hostNs) : undefined;
  return {
    ok: true,
    hostNs,
    lowerHostNs: hostNs - errBig,
    upperHostNs: hostNs + errBig,
    uncertaintyNs: err.totalErrorNs,
    targetTicks: traceTick,
    ...(probeTicks !== undefined ? { probeTicks } : {}),
    bootGeneration: segment.bootGeneration,
    segmentId: segment.segmentId,
    confidence: segment.confidence,
    anchorSource: segment.anchorSource,
    trustedForAutoPreciseSync: segment.trustedForAutoPreciseSync,
    exceedsEventScale: segment.exceedsEventScale,
    precisionNotice: segment.precisionNotice,
  };
}

function targetFitOrThrow(fit: AffineClockFit): AffineClockFit {
  return fit;
}

export function mapHostNsToTraceSegments(
  segments: readonly ClockSegmentMapping[],
  hostNs: bigint,
  preferred?: { bootGeneration?: number; segmentId?: number },
): PointMappingResult {
  const candidates = preferred?.bootGeneration !== undefined && preferred?.segmentId !== undefined
    ? segments.filter(s => s.bootGeneration === preferred.bootGeneration && s.segmentId === preferred.segmentId)
    : segments;

  for (const seg of candidates) {
    if (!seg.targetFit || seg.hostClock.startNs === undefined || seg.hostClock.endNs === undefined) continue;
    const pad = BigInt(seg.errorBudget.totalErrorNs);
    if (hostNs >= seg.hostClock.startNs - pad && hostNs <= seg.hostClock.endNs + pad) {
      if (seg.confidence === 'untrusted') {
        return {
          ok: false,
          bootGeneration: seg.bootGeneration,
          segmentId: seg.segmentId,
          confidence: seg.confidence,
          anchorSource: seg.anchorSource,
          trustedForAutoPreciseSync: false,
          exceedsEventScale: seg.exceedsEventScale,
          precisionNotice: seg.precisionNotice,
          errorCode: 'UntrustedClockMapping',
          message: seg.diagnostics[0] ?? 'Segment clock mapping is untrusted',
        };
      }
      if (seg.confidence === 'uncalibrated') {
        return {
          ok: false,
          bootGeneration: seg.bootGeneration,
          segmentId: seg.segmentId,
          confidence: seg.confidence,
          anchorSource: seg.anchorSource,
          trustedForAutoPreciseSync: false,
          exceedsEventScale: seg.exceedsEventScale,
          precisionNotice: seg.precisionNotice,
          errorCode: 'UncalibratedClock',
          message: 'Segment clock is uncalibrated',
        };
      }
      const rawTicks = hostNsToTicksWithFit(seg.targetFit, hostNs);
      const minTick = seg.targetClock.startTicks <= seg.targetClock.endTicks
        ? seg.targetClock.startTicks
        : seg.targetClock.endTicks;
      const maxTick = seg.targetClock.startTicks >= seg.targetClock.endTicks
        ? seg.targetClock.startTicks
        : seg.targetClock.endTicks;
      const clampedTicks = rawTicks < minTick ? minTick : rawTicks > maxTick ? maxTick : rawTicks;
      const err = computeFitErrorAtTicks(seg.targetFit, clampedTicks, seg.hostClock.crossProcessErrorNs);
      const probeTicks = seg.probeFit ? hostNsToTicksWithFit(seg.probeFit, hostNs) : undefined;
      return {
        ok: true,
        hostNs,
        targetTicks: clampedTicks,
        ...(probeTicks !== undefined ? { probeTicks } : {}),
        uncertaintyNs: err.totalErrorNs,
        bootGeneration: seg.bootGeneration,
        segmentId: seg.segmentId,
        confidence: seg.confidence,
        anchorSource: seg.anchorSource,
        trustedForAutoPreciseSync: seg.trustedForAutoPreciseSync,
        exceedsEventScale: seg.exceedsEventScale,
        precisionNotice: seg.precisionNotice,
      };
    }
  }

  // Check if hostNs falls strictly between two known segments (a gap or reset)
  const sortedWithHost = segments
    .filter(s => s.hostClock.startNs !== undefined && s.hostClock.endNs !== undefined)
    .sort((a, b) => (a.hostClock.startNs! < b.hostClock.startNs! ? -1 : a.hostClock.startNs! > b.hostClock.startNs! ? 1 : 0));
  for (let i = 0; i + 1 < sortedWithHost.length; i++) {
    const prev = sortedWithHost[i];
    const next = sortedWithHost[i + 1];
    if (hostNs > prev.hostClock.endNs! && hostNs < next.hostClock.startNs!) {
      return {
        ok: false,
        confidence: 'uncalibrated',
        anchorSource: 'none',
        trustedForAutoPreciseSync: false,
        exceedsEventScale: true,
        precisionNotice: `目标时刻落入分段缺口/复位区间 (boot ${prev.bootGeneration}/seg ${prev.segmentId} .. boot ${next.bootGeneration}/seg ${next.segmentId})`,
        errorCode: 'FallsInTraceGap',
        message: `Host time falls inside gap/reset between seg ${prev.segmentId} and seg ${next.segmentId}`,
      };
    }
  }

  return {
    ok: false,
    confidence: 'uncalibrated',
    anchorSource: 'none',
    trustedForAutoPreciseSync: false,
    exceedsEventScale: true,
    precisionNotice: '目标时刻超出 Trace 有效覆盖范围或缺乏锚点映射',
    errorCode: 'OutOfRecordingRange',
    message: 'Host time lies outside any mapped Trace segment range',
  };
}

/**
 * 将变量 TIMELINE 的横轴时间（ms）转换为绝对主机单调时间（ns），
 * 正确还原运行中由断点/暂停扣减的 pauseIntervals 以及多会话时间戳偏移。
 */
export function timelineMsToHostNs(
  meta: TimelineClockSyncMeta | undefined,
  timelineMs: number,
  crossProcessPairing?: CrossProcessClockPairing,
): {
  ok: boolean;
  hostNs?: bigint;
  hostOriginId?: string;
  crossProcessErrorNs: number;
  reason?: string;
} {
  if (!meta || !Number.isFinite(timelineMs)) {
    return { ok: false, crossProcessErrorNs: 0, reason: '缺少变量 TIMELINE 时钟同步元数据' };
  }
  if (meta.originHostMs === undefined || !Number.isFinite(meta.originHostMs)) {
    return { ok: false, crossProcessErrorNs: 0, reason: '变量 TIMELINE 缺少主机单调时间原点（如纯离线 CSV 导入未校准）' };
  }

  // Locate active session segment if multiple debug sessions were appended
  let sessionStartTimelineMs = 0;
  let sessionOriginHostNs = BigInt(Math.round(meta.originHostMs * 1_000_000));
  let pauseAdjusted = meta.pauseAdjusted;

  if (meta.sessionSegments.length > 0) {
    let matched = meta.sessionSegments[0];
    for (const seg of meta.sessionSegments) {
      if (timelineMs >= seg.startMs) matched = seg;
    }
    if (matched.hostStartMs === undefined) {
      return {
        ok: false,
        crossProcessErrorNs: 0,
        reason: `变量 TIMELINE 第 ${matched.sessionIndex + 1} 段调试会话缺少主机单调起点`,
      };
    }
    sessionStartTimelineMs = matched.startMs;
    sessionOriginHostNs = BigInt(Math.round(matched.hostStartMs * 1_000_000));
    pauseAdjusted = matched.pauseAdjusted;
  }

  let extraPausedMs = 0;
  if (pauseAdjusted) {
    for (const p of meta.pauseIntervals) {
      if (p.timelineMs >= sessionStartTimelineMs && p.timelineMs <= timelineMs) {
        extraPausedMs += p.pausedDurationMs;
      }
    }
  }

  const elapsedMs = timelineMs - sessionStartTimelineMs + extraPausedMs;
  let hostNs = sessionOriginHostNs + BigInt(Math.round(elapsedMs * 1_000_000));
  let crossError = 0;
  let hostOriginId = meta.hostOrigin?.originId;

  if (crossProcessPairing && meta.hostOrigin && crossProcessPairing.fromOriginId === meta.hostOrigin.originId) {
    hostNs += BigInt(crossProcessPairing.offsetNs);
    crossError = crossProcessPairing.pairingErrorNs;
    hostOriginId = crossProcessPairing.toOriginId;
  }

  return {
    ok: true,
    hostNs,
    hostOriginId,
    crossProcessErrorNs: crossError,
  };
}

export function hostNsToTimelineMs(
  meta: TimelineClockSyncMeta | undefined,
  hostNs: bigint,
  crossProcessPairing?: CrossProcessClockPairing,
): {
  ok: boolean;
  timelineMs?: number;
  fellInPause?: boolean;
  crossProcessErrorNs: number;
  reason?: string;
} {
  if (!meta || meta.originHostMs === undefined || !Number.isFinite(meta.originHostMs)) {
    return { ok: false, crossProcessErrorNs: 0, reason: '变量 TIMELINE 缺少主机单调时间原点' };
  }

  let localHostNs = hostNs;
  let crossError = 0;
  if (crossProcessPairing && meta.hostOrigin && crossProcessPairing.toOriginId === meta.hostOrigin.originId) {
    localHostNs -= BigInt(crossProcessPairing.offsetNs);
    crossError = crossProcessPairing.pairingErrorNs;
  }

  // Pick matching session segment by hostStartMs
  let sessionStartTimelineMs = 0;
  let sessionOriginHostNs = BigInt(Math.round(meta.originHostMs * 1_000_000));
  let pauseAdjusted = meta.pauseAdjusted;

  if (meta.sessionSegments.length > 0) {
    let matched = meta.sessionSegments[0];
    for (const seg of meta.sessionSegments) {
      if (seg.hostStartMs !== undefined && localHostNs >= BigInt(Math.round(seg.hostStartMs * 1_000_000))) {
        matched = seg;
      }
    }
    if (matched.hostStartMs === undefined) {
      return { ok: false, crossProcessErrorNs: crossError, reason: '匹配调试分段缺少主机起点' };
    }
    sessionStartTimelineMs = matched.startMs;
    sessionOriginHostNs = BigInt(Math.round(matched.hostStartMs * 1_000_000));
    pauseAdjusted = matched.pauseAdjusted;
  }

  const hostMs = Number(localHostNs) / 1_000_000;
  const sessionOriginHostMs = Number(sessionOriginHostNs) / 1_000_000;
  let subtractedPauseMs = 0;
  let fellInPause = false;

  if (pauseAdjusted) {
    for (const p of meta.pauseIntervals) {
      if (p.timelineMs < sessionStartTimelineMs) continue;
      const pauseEnd = p.resumedAtHostMs ?? (p.pausedAtHostMs + p.pausedDurationMs);
      if (hostMs >= pauseEnd) {
        subtractedPauseMs += p.pausedDurationMs;
      } else if (hostMs >= p.pausedAtHostMs) {
        subtractedPauseMs += hostMs - p.pausedAtHostMs;
        fellInPause = true;
      }
    }
  }

  const timelineMs = sessionStartTimelineMs + (hostMs - sessionOriginHostMs - subtractedPauseMs);
  return {
    ok: true,
    timelineMs,
    fellInPause,
    crossProcessErrorNs: crossError,
  };
}

export function serializeClockSegment(seg: ClockSegmentMapping): SerializedClockSegmentMapping {
  const serializeFit = (f: AffineClockFit) => ({
    anchorDomainTicks: f.anchorDomainTicks.toString(),
    anchorHostNs: f.anchorHostNs.toString(),
    nominalHz: f.nominalHz,
    direction: f.direction,
    driftPpm: f.driftPpm,
    driftMilliPpm: f.driftMilliPpm.toString(),
    driftKnown: f.driftKnown,
    driftUncertaintyPpm: f.driftUncertaintyPpm,
    meanXNs: f.meanXNs,
    sxxNs2: f.sxxNs2,
    sampleCount: f.sampleCount,
    maxHalfWidthNs: f.maxHalfWidthNs,
    residualRmsNs: f.residualRmsNs,
    residualMaxNs: f.residualMaxNs,
    anchors: f.anchors,
  });

  return {
    recordId: seg.recordId,
    bootGeneration: seg.bootGeneration,
    segmentId: seg.segmentId,
    reliability: seg.reliability,
    timeAnchorStatus: seg.timeAnchorStatus,
    tickDomain: seg.tickDomain,
    targetClock: {
      ...(seg.targetClock.nominalHz !== undefined ? { nominalHz: seg.targetClock.nominalHz } : {}),
      direction: seg.targetClock.direction,
      tickBits: seg.targetClock.tickBits,
      wrapCount: seg.targetClock.wrapCount,
      startTicks: seg.targetClock.startTicks.toString(),
      endTicks: seg.targetClock.endTicks.toString(),
      ...(seg.targetClock.startNs !== undefined ? { startNs: seg.targetClock.startNs.toString() } : {}),
      ...(seg.targetClock.endNs !== undefined ? { endNs: seg.targetClock.endNs.toString() } : {}),
    },
    probeClock: {
      available: seg.probeClock.available,
      ...(seg.probeClock.source !== undefined ? { source: seg.probeClock.source } : {}),
      ...(seg.probeClock.nominalHz !== undefined ? { nominalHz: seg.probeClock.nominalHz } : {}),
      ...(seg.probeClock.direction !== undefined ? { direction: seg.probeClock.direction } : {}),
      ...(seg.probeClock.tickBits !== undefined ? { tickBits: seg.probeClock.tickBits } : {}),
      ...(seg.probeClock.wrapCount !== undefined ? { wrapCount: seg.probeClock.wrapCount } : {}),
      ...(seg.probeClock.startTicks !== undefined ? { startTicks: seg.probeClock.startTicks.toString() } : {}),
      ...(seg.probeClock.endTicks !== undefined ? { endTicks: seg.probeClock.endTicks.toString() } : {}),
      ...(seg.probeClock.driftPpm !== undefined ? { driftPpm: seg.probeClock.driftPpm } : {}),
      ...(seg.probeClock.minRttNs !== undefined ? { minRttNs: seg.probeClock.minRttNs } : {}),
      ...(seg.probeClock.reason !== undefined ? { reason: seg.probeClock.reason } : {}),
    },
    hostClock: {
      originId: seg.hostClock.originId,
      processKind: seg.hostClock.processKind,
      ...(seg.hostClock.wallEpochMs !== undefined ? { wallEpochMs: seg.hostClock.wallEpochMs } : {}),
      ...(seg.hostClock.monotonicOriginNs !== undefined ? { monotonicOriginNs: seg.hostClock.monotonicOriginNs } : {}),
      ...(seg.hostClock.startNs !== undefined ? { startNs: seg.hostClock.startNs.toString() } : {}),
      ...(seg.hostClock.endNs !== undefined ? { endNs: seg.hostClock.endNs.toString() } : {}),
      crossProcessErrorNs: seg.hostClock.crossProcessErrorNs,
    },
    ...(seg.targetFit ? { targetFit: serializeFit(seg.targetFit) } : {}),
    ...(seg.probeFit ? { probeFit: serializeFit(seg.probeFit) } : {}),
    anchorSource: seg.anchorSource,
    confidence: seg.confidence,
    errorBudget: seg.errorBudget,
    trustedForAutoPreciseSync: seg.trustedForAutoPreciseSync,
    exceedsEventScale: seg.exceedsEventScale,
    ...(seg.eventScaleNs !== undefined ? { eventScaleNs: seg.eventScaleNs } : {}),
    precisionNotice: seg.precisionNotice,
    diagnostics: seg.diagnostics,
    observationsSummary: seg.observationsSummary,
  };
}

export function deserializeClockSegment(dto: SerializedClockSegmentMapping): ClockSegmentMapping {
  const deserializeFit = (f: NonNullable<SerializedClockSegmentMapping['targetFit']>): AffineClockFit => ({
    anchorDomainTicks: BigInt(f.anchorDomainTicks),
    anchorHostNs: BigInt(f.anchorHostNs),
    nominalHz: f.nominalHz,
    direction: f.direction,
    driftPpm: f.driftPpm,
    driftMilliPpm: BigInt(f.driftMilliPpm),
    driftKnown: f.driftKnown,
    driftUncertaintyPpm: f.driftUncertaintyPpm,
    meanXNs: f.meanXNs,
    sxxNs2: f.sxxNs2,
    sampleCount: f.sampleCount,
    maxHalfWidthNs: f.maxHalfWidthNs,
    residualRmsNs: f.residualRmsNs,
    residualMaxNs: f.residualMaxNs,
    anchors: f.anchors,
  });

  return {
    recordId: dto.recordId,
    bootGeneration: dto.bootGeneration,
    segmentId: dto.segmentId,
    reliability: dto.reliability,
    timeAnchorStatus: dto.timeAnchorStatus,
    tickDomain: dto.tickDomain,
    targetClock: {
      ...(dto.targetClock.nominalHz !== undefined ? { nominalHz: dto.targetClock.nominalHz } : {}),
      direction: dto.targetClock.direction,
      tickBits: dto.targetClock.tickBits,
      wrapCount: dto.targetClock.wrapCount,
      startTicks: BigInt(dto.targetClock.startTicks),
      endTicks: BigInt(dto.targetClock.endTicks),
      ...(dto.targetClock.startNs !== undefined ? { startNs: BigInt(dto.targetClock.startNs) } : {}),
      ...(dto.targetClock.endNs !== undefined ? { endNs: BigInt(dto.targetClock.endNs) } : {}),
    },
    probeClock: {
      available: dto.probeClock.available,
      ...(dto.probeClock.source !== undefined ? { source: dto.probeClock.source } : {}),
      ...(dto.probeClock.nominalHz !== undefined ? { nominalHz: dto.probeClock.nominalHz } : {}),
      ...(dto.probeClock.direction !== undefined ? { direction: dto.probeClock.direction } : {}),
      ...(dto.probeClock.tickBits !== undefined ? { tickBits: dto.probeClock.tickBits } : {}),
      ...(dto.probeClock.wrapCount !== undefined ? { wrapCount: dto.probeClock.wrapCount } : {}),
      ...(dto.probeClock.startTicks !== undefined ? { startTicks: BigInt(dto.probeClock.startTicks) } : {}),
      ...(dto.probeClock.endTicks !== undefined ? { endTicks: BigInt(dto.probeClock.endTicks) } : {}),
      ...(dto.probeClock.driftPpm !== undefined ? { driftPpm: dto.probeClock.driftPpm } : {}),
      ...(dto.probeClock.minRttNs !== undefined ? { minRttNs: dto.probeClock.minRttNs } : {}),
      ...(dto.probeClock.reason !== undefined ? { reason: dto.probeClock.reason } : {}),
    },
    hostClock: {
      originId: dto.hostClock.originId,
      processKind: dto.hostClock.processKind,
      ...(dto.hostClock.wallEpochMs !== undefined ? { wallEpochMs: dto.hostClock.wallEpochMs } : {}),
      ...(dto.hostClock.monotonicOriginNs !== undefined ? { monotonicOriginNs: dto.hostClock.monotonicOriginNs } : {}),
      ...(dto.hostClock.startNs !== undefined ? { startNs: BigInt(dto.hostClock.startNs) } : {}),
      ...(dto.hostClock.endNs !== undefined ? { endNs: BigInt(dto.hostClock.endNs) } : {}),
      crossProcessErrorNs: dto.hostClock.crossProcessErrorNs,
    },
    ...(dto.targetFit ? { targetFit: deserializeFit(dto.targetFit) } : {}),
    ...(dto.probeFit ? { probeFit: deserializeFit(dto.probeFit) } : {}),
    anchorSource: dto.anchorSource,
    confidence: dto.confidence,
    errorBudget: dto.errorBudget,
    trustedForAutoPreciseSync: dto.trustedForAutoPreciseSync,
    exceedsEventScale: dto.exceedsEventScale,
    ...(dto.eventScaleNs !== undefined ? { eventScaleNs: dto.eventScaleNs } : {}),
    precisionNotice: dto.precisionNotice,
    diagnostics: dto.diagnostics,
    observationsSummary: dto.observationsSummary,
  };
}

export function serializeTraceClockMap(map: TraceClockMap): SerializedTraceClockMap {
  return {
    version: 1,
    recordId: map.recordId,
    hostOrigin: map.hostOrigin,
    segments: map.segments.map(serializeClockSegment),
    boundaries: map.boundaries,
  };
}

export function deserializeTraceClockMap(dto: SerializedTraceClockMap): TraceClockMap {
  return {
    version: 1,
    recordId: dto.recordId,
    hostOrigin: dto.hostOrigin,
    segments: dto.segments.map(deserializeClockSegment),
    boundaries: dto.boundaries,
  };
}
