/** These stamps are emitted by the same DAP instance as the variable samples. */
export interface TimelineLinkClock {
  readonly key: string;
  readonly source: 'host' | 'probe' | 'rmlink';
  readonly measuredProbeRoundTripMs?: number;
}

export interface TraceClockTail {
  readonly segmentId: number;
  readonly relativeTicks: string;
  readonly frequencyHz: number;
}

export interface TraceClockArrival extends TraceClockTail {
  readonly clock: TimelineLinkClock;
  readonly axisMs: number;
  readonly bootGeneration: number;
}

interface ClockWindow {
  readonly first: TraceClockArrival;
  readonly last: TraceClockArrival;
  readonly tightest: TraceClockArrival;
}

const MAX_CLOCK_WINDOWS = 32;

export function isTimelineLinkClock(value: unknown): value is TimelineLinkClock {
  if (!value || typeof value !== 'object') return false;
  const clock = value as Partial<TimelineLinkClock>;
  return typeof clock.key === 'string' && clock.key.length > 0 && clock.key.length <= 128
    && (clock.source === 'host' || clock.source === 'probe' || clock.source === 'rmlink');
}

/** Retain only endpoint observations and the tightest causal arrival per window. */
export class TraceClockArrivals {
  private windows: ClockWindow[] = [];
  private split = false;

  breakWindow(): void {
    this.split = true;
  }

  observe(arrival: TraceClockArrival): void {
    const previous = this.windows.at(-1);
    const last = previous?.last;
    if (this.split || !previous || !last || last.clock.key !== arrival.clock.key
      || last.bootGeneration !== arrival.bootGeneration || last.segmentId !== arrival.segmentId
      || last.frequencyHz !== arrival.frequencyHz || BigInt(last.relativeTicks) > BigInt(arrival.relativeTicks)) {
      this.windows.push({ first: arrival, last: arrival, tightest: arrival });
      if (this.windows.length > MAX_CLOCK_WINDOWS) this.windows.shift();
      this.split = false;
      return;
    }
    const tightest = previous.tightest;
    const elapsedMs = Number(BigInt(arrival.relativeTicks) - BigInt(tightest.relativeTicks)) * 1000 / arrival.frequencyHz;
    this.windows[this.windows.length - 1] = {
      first: previous.first,
      last: arrival,
      tightest: arrival.axisMs - tightest.axisMs < elapsedMs ? arrival : tightest,
    };
  }

  getWindows(): readonly ClockWindow[] {
    return this.windows.slice();
  }
}
