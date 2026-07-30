import type { RttControlBlockResolver } from './rtt-control-block-resolver';

/**
 * Common RTT boundary shared by the Native helper and Legacy koffi owners.
 *
 * This file intentionally contains only the transport contract. The existing
 * owner implementations still expose their current methods until B02/B03 add
 * the corresponding adapters.
 */

export type RttOwnerKind = 'native' | 'legacy';

export type RttTransportState =
  | 'disconnected'
  | 'connected'
  | 'started'
  | 'stopped'
  | 'owner-lost';

export type RttTransportErrorCode =
  | 'NotConnected'
  | 'NotStarted'
  | 'InvalidArgument'
  | 'Unsupported'
  | 'StartFailed'
  | 'StopFailed'
  | 'ReadFailed'
  | 'OwnerLost'
  | 'ChannelGone'
  | 'TargetReset'
  | 'Cancelled'
  | 'Timeout'
  | 'ProtocolError'
  | 'QueueFull'
  | 'QuotaExceeded'
  | 'ControlBlockNotFound';

export type RttTransportErrorCategory =
  | 'connection'
  | 'lifecycle'
  | 'read'
  | 'owner'
  | 'channel'
  | 'protocol'
  | 'cancelled'
  | 'queue';

export class RttTransportError extends Error {
  readonly name = 'RttTransportError';

  constructor(
    readonly code: RttTransportErrorCode,
    message: string,
    readonly category: RttTransportErrorCategory,
    readonly diagnostics: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface RttTransportSuccess<T> {
  readonly ok: true;
  readonly data: T;
}

export interface RttTransportFailure {
  readonly ok: false;
  readonly error: RttTransportError;
}

export type RttTransportResult<T> = RttTransportSuccess<T> | RttTransportFailure;

export function rttSuccess<T>(data: T): RttTransportSuccess<T> {
  return { ok: true, data };
}

export function rttFailure(error: RttTransportError): RttTransportFailure {
  return { ok: false, error };
}

export type RttControlBlockAddressSource = 'explicit' | 'elf-symbol' | 'auto-search' | 'unknown';

export interface RttControlBlockAddress {
  readonly address: number;
  readonly source: RttControlBlockAddressSource;
  readonly symbol?: string;
}

export interface RttTransportCapabilities {
  readonly supportsStart: boolean;
  readonly supportsStop: boolean;
  readonly supportsRead: boolean;
  readonly supportsControlBlockAddress: boolean;
  readonly supportsOwnerLoss: boolean;
  readonly supportsReadStatistics: boolean;
  readonly maxReadSize?: number;
  readonly channelCount?: number;
}

export interface RttTransportBackendResult<T = unknown> {
  readonly ok: boolean;
  readonly message?: string;
  readonly data?: T;
  readonly errorCode?: string;
  readonly diagnostics?: Readonly<Record<string, unknown>>;
}

export interface RttReadBackendOptions {
  /** The caller already owns the NativeScheduler serialization slot. */
  readonly scheduledByOwnerScheduler?: boolean;
}

/** Per-owner read counters returned by the Native RTT protocol when available. */
export interface RttReadStatistics {
  readonly requestedSize: number;
  readonly returnedSize: number;
  readonly empty: boolean;
  readonly readCalls: number;
  readonly receivedBytes: number;
  readonly emptyReads: number;
  readonly readErrors: number;
}

/** Low-level RTT methods exposed by either selected target owner. */
export interface RttTransportBackend {
  readonly kind: RttOwnerKind;
  startRtt(controlBlockAddress?: number): Promise<RttTransportBackendResult>;
  stopRtt(): Promise<RttTransportBackendResult>;
  readRtt(bufferIndex: number, size: number, options?: RttReadBackendOptions): Promise<RttTransportBackendResult<{
    bytes: Uint8Array;
    stats?: RttReadStatistics;
  }>>;
}

export interface RttStartOptions {
  readonly controlBlockAddress?: number;
}

export interface RttStartResult {
  readonly started: boolean;
  readonly controlBlockAddress: RttControlBlockAddress | null;
}

export interface RttStopResult {
  readonly stopped: boolean;
  readonly wasStarted: boolean;
}

export interface RttReadRequest {
  readonly channelIndex: number;
  readonly size: number;
  readonly signal?: AbortSignal;
  /** Internal marker used by RttStreamScheduler to prevent nested scheduling. */
  readonly scheduledByOwnerScheduler?: boolean;
}

export interface RttReadResult {
  readonly channelIndex: number;
  readonly requestedSize: number;
  readonly bytes: Uint8Array;
  /** True only when the transport successfully read zero bytes. */
  readonly empty: boolean;
  readonly stats?: RttReadStatistics;
}

export type RttOwnerLossListener = (error: RttTransportError) => void;

/**
 * The only RTT surface that stream consumers should depend on.
 *
 * Implementations must report a zero-byte read as a successful
 * `RttReadResult`; a negative DLL/helper return, a vanished channel, or a
 * lost physical owner must be represented by `RttTransportFailure` instead.
 */
export interface RttTransport {
  readonly ownerKind: RttOwnerKind;
  readonly state: RttTransportState;
  readonly capabilities: RttTransportCapabilities;

  getControlBlockAddress(): Promise<RttTransportResult<RttControlBlockAddress | null>>;
  start(options?: RttStartOptions): Promise<RttTransportResult<RttStartResult>>;
  stop(): Promise<RttTransportResult<RttStopResult>>;
  read(request: RttReadRequest): Promise<RttTransportResult<RttReadResult>>;
  onOwnerLoss(listener: RttOwnerLossListener): () => void;
}

const DEFAULT_CAPABILITIES: RttTransportCapabilities = {
  supportsStart: true,
  supportsStop: true,
  supportsRead: true,
  supportsControlBlockAddress: true,
  supportsOwnerLoss: true,
  supportsReadStatistics: false,
  maxReadSize: 1024 * 1024,
  channelCount: 16,
};

/**
 * Adapts the current owner methods to the B01 contract without changing the
 * owner or DAP command result shape. B02/B03 can later replace the backend
 * methods with protocol-native implementations without changing consumers.
 */
export class RttTransportAdapter implements RttTransport {
  private currentState: RttTransportState = 'connected';
  private controlBlockAddress: RttControlBlockAddress | null = null;
  private readonly ownerLossListeners = new Set<RttOwnerLossListener>();

  constructor(
    private readonly backend: RttTransportBackend,
    readonly capabilities: RttTransportCapabilities = DEFAULT_CAPABILITIES,
    private controlBlockResolver?: RttControlBlockResolver,
  ) {}

  get ownerKind(): RttOwnerKind { return this.backend.kind; }
  get state(): RttTransportState { return this.currentState; }

  async getControlBlockAddress(): Promise<RttTransportResult<RttControlBlockAddress | null>> {
    if (!this.capabilities.supportsControlBlockAddress) {
      return rttFailure(this.error('Unsupported', 'RTT Control Block address is not supported by this owner', 'protocol'));
    }
    if (this.controlBlockAddress) return rttSuccess(this.controlBlockAddress);
    if (this.controlBlockResolver) return this.controlBlockResolver.resolve();
    return rttSuccess(null);
  }

  setControlBlockResolver(resolver: RttControlBlockResolver | undefined) {
    this.controlBlockResolver = resolver;
    this.controlBlockAddress = null;
  }

  async start(options: RttStartOptions = {}): Promise<RttTransportResult<RttStartResult>> {
    if (this.currentState === 'owner-lost' || this.currentState === 'disconnected') {
      return rttFailure(this.error('NotConnected', 'RTT owner is not connected', 'connection'));
    }
    if (!this.capabilities.supportsStart) {
      return rttFailure(this.error('Unsupported', 'RTT start is not supported by this owner', 'protocol'));
    }
    if (this.currentState === 'started') {
      return rttSuccess({ started: true, controlBlockAddress: this.controlBlockAddress });
    }
    const resolved = options.controlBlockAddress === undefined && this.controlBlockResolver
      ? await this.controlBlockResolver.resolve()
      : options.controlBlockAddress === undefined
        ? rttSuccess<RttControlBlockAddress | null>(null)
        : rttSuccess<RttControlBlockAddress | null>({ address: options.controlBlockAddress >>> 0, source: 'explicit' });
    if (!resolved.ok) return resolved;

    const result = await this.backend.startRtt(resolved.data?.address);
    if (!result.ok) return this.failureFor('start', result);

    this.currentState = 'started';
    this.controlBlockAddress = resolved.data;
    return rttSuccess({ started: true, controlBlockAddress: this.controlBlockAddress });
  }

  async stop(): Promise<RttTransportResult<RttStopResult>> {
    if (this.currentState === 'owner-lost') {
      return rttFailure(this.error('OwnerLost', 'RTT owner was lost before stop', 'owner'));
    }
    if (this.currentState === 'disconnected') {
      return rttFailure(this.error('NotConnected', 'RTT owner is not connected', 'connection'));
    }
    if (!this.capabilities.supportsStop) {
      return rttFailure(this.error('Unsupported', 'RTT stop is not supported by this owner', 'protocol'));
    }
    const wasStarted = this.currentState === 'started';
    if (!wasStarted) {
      this.currentState = 'stopped';
      return rttSuccess({ stopped: true, wasStarted: false });
    }

    const result = await this.backend.stopRtt();
    if (!result.ok) return this.failureFor('stop', result);
    this.currentState = 'stopped';
    return rttSuccess({ stopped: true, wasStarted: true });
  }

  async read(request: RttReadRequest): Promise<RttTransportResult<RttReadResult>> {
    if (this.currentState === 'owner-lost') {
      return rttFailure(this.error('OwnerLost', 'RTT owner was lost during read', 'owner'));
    }
    if (this.currentState !== 'started') {
      return rttFailure(this.error('NotStarted', 'RTT must be started before read', 'lifecycle'));
    }
    if (!Number.isInteger(request.channelIndex) || request.channelIndex < 0
      || !Number.isInteger(request.size) || request.size <= 0) {
      return rttFailure(this.error('InvalidArgument', 'RTT read requires a non-negative channel and positive size', 'protocol', {
        channelIndex: request.channelIndex,
        size: request.size,
      }));
    }
    if (!this.capabilities.supportsRead) {
      return rttFailure(this.error('Unsupported', 'RTT read is not supported by this owner', 'protocol'));
    }
    if (this.capabilities.maxReadSize !== undefined && request.size > this.capabilities.maxReadSize) {
      return rttFailure(this.error('InvalidArgument', `RTT read size exceeds owner limit ${this.capabilities.maxReadSize}`, 'protocol', {
        channelIndex: request.channelIndex,
        size: request.size,
        maxReadSize: this.capabilities.maxReadSize,
      }));
    }
    if (request.signal?.aborted) {
      return rttFailure(this.error('Cancelled', 'RTT read was cancelled before dispatch', 'cancelled'));
    }

    const result = await this.backend.readRtt(request.channelIndex, request.size, {
      ...(request.scheduledByOwnerScheduler ? { scheduledByOwnerScheduler: true } : {}),
    });
    if (!result.ok) return this.failureFor('read', result);
    if (request.signal?.aborted) {
      return rttFailure(this.error('Cancelled', 'RTT read was cancelled after dispatch', 'cancelled'));
    }
    const bytes = result.data?.bytes;
    if (!(bytes instanceof Uint8Array)) {
      return rttFailure(this.error('ProtocolError', 'RTT read returned no byte buffer', 'protocol'));
    }
    return rttSuccess({
      channelIndex: request.channelIndex,
      requestedSize: request.size,
      bytes,
      empty: bytes.length === 0,
      ...(result.data?.stats ? { stats: result.data.stats } : {}),
    });
  }

  onOwnerLoss(listener: RttOwnerLossListener): () => void {
    this.ownerLossListeners.add(listener);
    return () => this.ownerLossListeners.delete(listener);
  }

  /** Called by the selected owner boundary when it reports `NativeOwnerLost`. */
  markOwnerLost(message = 'RTT target owner was lost', diagnostics: Readonly<Record<string, unknown>> = {}) {
    if (this.currentState === 'owner-lost') return;
    this.currentState = 'owner-lost';
    const error = this.error('OwnerLost', message, 'owner', diagnostics);
    for (const listener of this.ownerLossListeners) listener(error);
  }

  private failureFor(
    operation: 'start' | 'stop' | 'read',
    result: RttTransportBackendResult,
  ): RttTransportFailure {
    if (result.errorCode === 'NativeOwnerLost') {
      this.markOwnerLost(result.message || 'Native RTT owner was lost', result.diagnostics);
      return rttFailure(this.error('OwnerLost', result.message || 'Native RTT owner was lost', 'owner', result.diagnostics));
    }
    if (result.errorCode === 'TargetDisconnected') {
      this.markOwnerLost(result.message || 'RTT target owner was disconnected', result.diagnostics);
      return rttFailure(this.error('OwnerLost', result.message || 'RTT target owner was disconnected', 'owner', result.diagnostics));
    }

    const code: RttTransportErrorCode = result.errorCode === 'UnsupportedCapability'
      ? 'Unsupported'
      : result.errorCode === 'ProtocolError'
        ? 'ProtocolError'
        : result.errorCode === 'NotStarted'
          ? 'NotStarted'
        : result.errorCode === 'NativeChannelUnavailable' || result.errorCode === 'TargetOwnerUnavailable'
          ? 'NotConnected'
          : result.errorCode === 'TargetDisconnected'
            ? 'ChannelGone'
            : result.errorCode === 'Timeout' || result.errorCode === 'RequestTimeout'
              ? 'Timeout'
              : result.errorCode === 'Cancelled' || result.errorCode === 'NativeSchedulerCancelled'
                ? 'Cancelled'
                : operation === 'start'
                  ? 'StartFailed'
                  : operation === 'stop'
                    ? 'StopFailed'
                    : 'ReadFailed';
    const category: RttTransportErrorCategory = code === 'Unsupported' || code === 'ProtocolError'
      ? 'protocol'
      : code === 'NotConnected'
        ? 'connection'
        : code === 'NotStarted'
          ? 'lifecycle'
        : code === 'ChannelGone'
          ? 'channel'
          : code === 'Timeout' || code === 'Cancelled'
            ? 'cancelled'
            : operation === 'read'
              ? 'read'
              : 'lifecycle';
    return rttFailure(this.error(code, result.message || `RTT ${operation} failed`, category, result.diagnostics));
  }

  private error(
    code: RttTransportErrorCode,
    message: string,
    category: RttTransportErrorCategory,
    diagnostics?: Readonly<Record<string, unknown>>,
  ) {
    return new RttTransportError(code, message, category, diagnostics);
  }
}
