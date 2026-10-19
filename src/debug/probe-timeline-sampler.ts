import type {
  FastDataSampleSpec,
  OzoneCommand,
  OzoneCommandResult,
  ProbeSampleBatch,
  ProbeSampleFrame,
  ProbeSamplingStarted,
  WatchValue,
} from '../ozone-backend/types';
import type { BoundedMetric } from '../utils/bounded-metric';
import { log } from '../utils/logger';
import { ProbeClock } from './probe-clock';

/** How often the probe frame buffer is drained. */
const POLL_MS = 10;

/** What the sampler needs from the DAP session that owns the Timeline. */
export interface ProbeTimelineSamplerHost {
  execute(command: OzoneCommand): Promise<OzoneCommandResult>;
  nowMs(): number;
  /** Maps a host time onto the Timeline clock, which pauses while the core is stopped. */
  timelineNowMs(hostMs: number): number;
  isTargetRunning(): boolean;
  beginTargetRead(): boolean;
  endTargetRead(): void;
  /** Queues one value; probe timestamps are already monotonic per run. */
  accept(value: WatchValue, timestamp: number): void;
  /** Probe sampling failed after it started; the session polls from the host instead. */
  fallBackToHost(): void;
  readonly counts: { attempts: number; gateDeferred: number; readsCompleted: number };
  readonly commitMs: BoundedMetric;
}

/**
 * Timeline sampling done by an XR-DAP probe: the probe samples on its own
 * timer and buffers timestamped frames; this class drains the buffer and
 * places the values on the Timeline clock.
 */
export class ProbeTimelineSampler {
  private running = false;
  /** Commander run id, so a late stop never ends a newer run. */
  private run: number | undefined;
  /** Bumped by stop(); completions of an older start or poll are dropped. */
  private generation = 0;
  private timer: NodeJS.Timeout | null = null;
  private readonly clock = new ProbeClock();
  /** Frames read while the clock was still warming up. */
  private held: ProbeSampleFrame[] = [];

  constructor(private readonly host: ProbeTimelineSamplerHost) {}

  get active(): boolean {
    return this.running;
  }

  /**
   * Asks the probe to sample `specs` every `intervalMs`. Returns the interval
   * the probe uses (it may lengthen one it cannot keep), or null when the
   * session should poll from the host.
   */
  async start(specs: FastDataSampleSpec[], intervalMs: number): Promise<number | null> {
    this.stop();
    const generation = this.generation;
    const result = await this.host.execute({ cmd: 'startProbeSampling', specs, periodUs: intervalMs * 1000 });
    const started = result.ok ? result.data as ProbeSamplingStarted | undefined : undefined;
    if (generation !== this.generation) {
      if (started) void this.host.execute({ cmd: 'stopProbeSampling', run: started.run });
      return null;
    }
    if (!result.ok) {
      if (result.errorCode !== 'UnsupportedCapability') {
        log.dap(`[timeline] probe sampling unavailable, polling from host: ${result.errorCode || ''} ${result.error}`);
      }
      return null;
    }
    if (!started || !(started.periodUs > 0)) {
      log.dap(`[timeline] probe sampling start returned no period, polling from host: ${JSON.stringify(started)}`);
      void this.host.execute({ cmd: 'stopProbeSampling', run: started?.run });
      return null;
    }
    log.dap(`[timeline] probe sampling periodUs=${started.periodUs} estFrameUs=${started.estFrameUs}`);
    this.running = true;
    this.run = started.run;
    this.clock.reset();
    this.held = [];
    this.schedule(0);
    return started.periodUs / 1000;
  }

  /** Stops probe sampling; safe to call when it is not running. */
  stop(): void {
    this.generation++;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.running) return;
    this.running = false;
    void this.host.execute({ cmd: 'stopProbeSampling', run: this.run }).then(result => {
      if (!result.ok) log.dap(`[timeline] probe sampling stop failed: ${result.errorCode || ''} ${result.error}`);
    });
  }

  private schedule(delayMs: number): void {
    if (!this.running || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.poll();
    }, delayMs);
  }

  /** One drain of the probe buffer. Exposed for tests. */
  async poll(): Promise<void> {
    const host = this.host;
    const generation = this.generation;
    host.counts.attempts++;
    if (!host.beginTargetRead()) {
      host.counts.gateDeferred++;
      this.schedule(POLL_MS);
      return;
    }
    let result: OzoneCommandResult;
    try {
      result = await host.execute({ cmd: 'readProbeSampling' });
    } finally {
      host.endTargetRead();
    }
    const receivedAt = host.nowMs();
    if (generation !== this.generation) return;
    if (!result.ok) {
      if (result.errorCode === 'RequestCancelled') {
        this.schedule(POLL_MS);
        return;
      }
      // E.g. the probe dropped sampling after a link loss: keep the plot alive from the host.
      log.dap(`[timeline] probe sampling failed, polling from host: ${result.errorCode || ''} ${result.error}`);
      this.stop();
      host.fallBackToHost();
      return;
    }
    host.counts.readsCompleted++;
    const batch = result.data as ProbeSampleBatch;
    const probeNowMs = batch.probeNowUs / 1000;
    const offsetMs = this.clock.update(receivedAt - batch.probeNowAgeUs / 1000, probeNowMs);
    if (!host.isTargetRunning()) {
      // Frames sampled while the core is stopped do not advance the Timeline.
      this.held = [];
    } else if (offsetMs === null) {
      this.held.push(...batch.frames);
    } else {
      const commitStartedAt = host.nowMs();
      const frames = this.held.length ? this.held.concat(batch.frames) : batch.frames;
      this.held = [];
      for (const frame of frames) {
        const timestamp = host.timelineNowMs(frame.timestampUs / 1000 + offsetMs);
        for (const value of frame.values) host.accept(value, timestamp);
      }
      host.commitMs.record(host.nowMs() - commitStartedAt);
    }
    this.schedule(batch.pendingBytes > 0 ? 0 : POLL_MS);
  }
}
