import {
  RttStartResult,
  RttStartOptions,
  RttStopResult,
  RttTransport,
  RttTransportError,
  RttTransportResult,
  rttFailure,
  rttSuccess,
} from './rtt-transport';

export type RttSessionLifecycleState =
  | 'disconnected'
  | 'connected'
  | 'initialized'
  | 'running'
  | 'halted'
  | 'resetting'
  | 'terminating'
  | 'terminated'
  | 'owner-lost';

export interface RttPollingController {
  start(): void;
  stop(): void;
}

/**
 * Owns RTT start/stop decisions around the DAP session lifecycle.
 *
 * This class does not touch the target itself. The caller remains responsible
 * for the actual reset/run/halt commands and calls `resetStarted`/
 * `resetCompleted` at the corresponding boundaries.
 */
export class RttSessionLifecycle {
  private currentState: RttSessionLifecycleState = 'disconnected';
  private readonly removeOwnerLossListener: () => void;

  constructor(
    private readonly transport: RttTransport,
    private readonly polling: RttPollingController,
    private readonly enabled = true,
    private readonly startOptions: RttStartOptions = {},
  ) {
    this.removeOwnerLossListener = transport.onOwnerLoss(error => this.handleOwnerLoss(error));
  }

  get state(): RttSessionLifecycleState { return this.currentState; }

  connect(): boolean {
    if (this.currentState !== 'disconnected') return false;
    this.currentState = 'connected';
    return true;
  }

  async initialized(): Promise<RttTransportResult<RttStartResult | null>> {
    if (this.currentState !== 'connected' && this.currentState !== 'halted') {
      return rttFailure(this.lifecycleError('NotConnected', `RTT initialized is invalid in state ${this.currentState}`));
    }
    if (!this.enabled) {
      this.currentState = 'initialized';
      return rttSuccess(null);
    }

    const started = await this.transport.start(this.startOptions);
    if (!started.ok) {
      this.polling.stop();
      return started;
    }
    this.currentState = 'initialized';
    this.polling.start();
    return started;
  }

  run() {
    if (this.currentState === 'initialized' || this.currentState === 'halted') {
      this.currentState = 'running';
    }
  }

  halt() {
    if (this.currentState === 'initialized' || this.currentState === 'running') {
      this.currentState = 'halted';
    }
  }

  async resetStarted(): Promise<RttTransportResult<RttStopResult | null>> {
    if (!this.isConnectedState()) {
      return rttFailure(this.lifecycleError('NotConnected', `RTT reset is invalid in state ${this.currentState}`));
    }
    this.currentState = 'resetting';
    this.polling.stop();
    if (!this.enabled) return rttSuccess(null);
    return this.stopTransport();
  }

  async resetCompleted(): Promise<RttTransportResult<RttStartResult | null>> {
    if (this.currentState !== 'resetting') {
      return rttFailure(this.lifecycleError('TargetReset', `RTT reset completion is invalid in state ${this.currentState}`));
    }
    this.currentState = 'connected';
    return this.initialized();
  }

  async disconnect(): Promise<RttTransportResult<RttStopResult>> {
    return this.finish();
  }

  async terminate(): Promise<RttTransportResult<RttStopResult>> {
    return this.finish();
  }

  dispose() {
    this.polling.stop();
    this.removeOwnerLossListener();
  }

  private async finish(): Promise<RttTransportResult<RttStopResult>> {
    if (this.currentState === 'terminated') {
      return rttSuccess({ stopped: true, wasStarted: false });
    }
    const ownerWasLost = this.currentState === 'owner-lost';
    this.currentState = 'terminating';
    this.polling.stop();
    const stopped = ownerWasLost
      ? rttSuccess({ stopped: false, wasStarted: false })
      : await this.stopTransport();
    this.currentState = 'terminated';
    if (!stopped.ok) return stopped;
    return stopped;
  }

  private async stopTransport(): Promise<RttTransportResult<RttStopResult>> {
    if (this.currentState === 'owner-lost') {
      return rttSuccess({ stopped: false, wasStarted: false });
    }
    return this.transport.stop();
  }

  private handleOwnerLoss(_error: RttTransportError) {
    if (this.currentState === 'terminated') return;
    this.polling.stop();
    this.currentState = 'owner-lost';
  }

  private isConnectedState() {
    return this.currentState === 'connected'
      || this.currentState === 'initialized'
      || this.currentState === 'running'
      || this.currentState === 'halted';
  }

  private lifecycleError(code: 'NotConnected' | 'TargetReset', message: string) {
    return new RttTransportError(code, message, 'lifecycle');
  }
}
