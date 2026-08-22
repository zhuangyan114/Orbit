// Orbit Automation API v1 — byte-oriented memory access service (plan Task 9).
//
// `orbit.memory.read` / `orbit.memory.write` reuse the standard DAP
// readMemory/writeMemory base64 byte contract (never a uint32[] memory model).
// Reads run through the exact active session's `orbitMemorySnapshot` custom
// request, which in turn reuses the MemoryView read handler (same read gate and
// control-cancellation behavior). Writes are mutations: the DAP adapter runs
// them under the step lock + target-write barrier and, when `verify` is set,
// reads back through the same selected owner and compares byte-for-byte.
//
// There is no extension-host backend fallback; a missing/stale session is a
// frozen fence error, and a running target never fabricates stopped memory.
import * as vscode from 'vscode';
import { AutomationError, MemoryBlockData, MemoryWriteReport, SessionRef } from './protocol';
import { SessionRegistry } from './session-registry';
import {
  AUTOMATION_MEMORY_COMMAND,
  AutomationMemoryRequest,
  AutomationMemoryResult,
} from '../debug/dap-automation-protocol';

/** Frozen single-request byte bound (OpenRPC MemoryReadParams.count maximum). */
export const MAX_MEMORY_BYTES = 1048576;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Reconstructs a structured DAP memory failure from a `customRequest`
 * rejection. VS Code rejects a `success: false` response as `Error(message)`
 * and does not reliably attach the response body, so the leading
 * `ErrorCode:` prefix is the fallback when `.body` is absent.
 */
function memoryFailureFromRejection(error: unknown): AutomationMemoryResult | undefined {
  const record = (error && typeof error === 'object') ? error as Record<string, unknown> : {};
  const body = record.body && typeof record.body === 'object' ? record.body as Record<string, unknown> : undefined;
  if (body && typeof body.errorCode === 'string') {
    return {
      errorCode: body.errorCode,
      message: typeof body.message === 'string' ? body.message : undefined,
      targetState: typeof body.targetState === 'string' ? body.targetState : undefined,
    };
  }
  const message = typeof record.message === 'string' ? record.message : '';
  const prefix = /^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/.exec(message.trim());
  if (prefix) {
    return { errorCode: prefix[1], message: prefix[2] || message };
  }
  return undefined;
}

export interface MemoryServiceOptions {
  registry: SessionRegistry;
  /** Pulls one byte-oriented memory operation from an exact active session. */
  snapshotMemoryDap?(session: vscode.DebugSession, request: AutomationMemoryRequest): Promise<AutomationMemoryResult>;
}

export interface MemoryReadParams {
  address: string;
  count: number;
  allowPartial?: boolean;
}

export interface MemoryWriteParams {
  address: string;
  /** Base64-encoded bytes to write. */
  data: string;
  verify?: boolean;
}

export class MemoryService {
  private readonly opts: Required<MemoryServiceOptions>;

  constructor(options: MemoryServiceOptions) {
    const defaults: Required<MemoryServiceOptions> = {
      registry: options.registry,
      snapshotMemoryDap: async (session, request) => {
        try {
          const response: unknown = await session.customRequest(AUTOMATION_MEMORY_COMMAND, request);
          return (isRecord(response) ? response : {}) as AutomationMemoryResult;
        } catch (error) {
          // A DAP `success: false` response rejects `customRequest`; surface the
          // structured errorCode (from the attached body or the message prefix)
          // so the caller maps it to the frozen automation codes. A transport
          // error without a recoverable errorCode is rethrown.
          const structured = memoryFailureFromRejection(error);
          if (structured) return structured;
          throw error;
        }
      },
    };
    const merged: Record<string, unknown> = { ...defaults, ...options };
    for (const [key, value] of Object.entries(defaults)) {
      if (merged[key] === undefined) merged[key] = value;
    }
    this.opts = merged as unknown as Required<MemoryServiceOptions>;
  }

  /** `orbit.memory.read`: one base64 byte block from the exact session. */
  async read(ref: SessionRef, params: MemoryReadParams): Promise<MemoryBlockData> {
    const address = this.parseAddress(params.address);
    const count = params.count;
    if (!Number.isInteger(count) || count < 1 || count > MAX_MEMORY_BYTES) {
      throw new AutomationError('InvalidRequest', 'count must be an integer between 1 and 1048576', false);
    }
    const { session, generation } = this.resolve(ref);
    const result = await this.snapshotMemory(session, {
      kind: 'read',
      sessionGeneration: generation,
      address: this.formatAddress(address),
      count,
      ...(params.allowPartial !== undefined ? { allowPartial: params.allowPartial } : {}),
    });
    const bytesRead = typeof result.bytesRead === 'number' ? result.bytesRead : 0;
    return {
      address: this.formatAddress(address),
      requestedBytes: count,
      bytesRead,
      unreadableBytes: typeof result.unreadableBytes === 'number'
        ? result.unreadableBytes
        : Math.max(0, count - bytesRead),
      data: typeof result.data === 'string' ? result.data : '',
    };
  }

  /** `orbit.memory.write`: one base64 byte write with optional read-back verify. */
  async write(
    ref: SessionRef,
    params: MemoryWriteParams,
    operationId?: string,
  ): Promise<MemoryWriteReport> {
    this.requireOperationId(operationId);
    const address = this.parseAddress(params.address);
    const bytes = this.decodeBase64(params.data);
    if (bytes.length > MAX_MEMORY_BYTES) {
      throw new AutomationError('InvalidRequest', `memory write exceeds the ${MAX_MEMORY_BYTES}-byte limit`, false);
    }
    const { session, generation } = this.resolve(ref);
    const result = await this.snapshotMemory(session, {
      kind: 'write',
      sessionGeneration: generation,
      address: this.formatAddress(address),
      data: params.data,
      ...(params.verify !== undefined ? { verify: params.verify } : {}),
    });
    return {
      operationId: operationId!,
      address: this.formatAddress(address),
      bytesWritten: typeof result.bytesWritten === 'number' ? result.bytesWritten : bytes.length,
      verified: result.verified ?? false,
      ...(typeof result.data === 'string' ? { verifyData: result.data } : {}),
    };
  }

  // --- internals -----------------------------------------------------------

  private async snapshotMemory(session: vscode.DebugSession, request: AutomationMemoryRequest): Promise<AutomationMemoryResult> {
    let result: AutomationMemoryResult;
    try {
      result = await this.opts.snapshotMemoryDap(session, request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new AutomationError('TargetDisconnected', `memory snapshot failed: ${message}`, false, undefined, {
        dapMessage: message,
      });
    }
    this.throwOnMemoryFailure(result);
    return result;
  }

  /** Maps a structured DAP memory failure onto the frozen automation codes. */
  private throwOnMemoryFailure(result: AutomationMemoryResult): void {
    if (!result.errorCode) return;
    const code = result.errorCode;
    const message = result.message ?? code;
    const details: Record<string, unknown> = { dapMessage: message };
    if (result.targetState !== undefined) details.targetState = result.targetState;
    if (code === 'TargetRunning') {
      // The read gate was not acquired while control was in progress; memory
      // reads surface the frozen retryable TargetReadCancelled (memory.read has
      // no TargetRunning error in the frozen catalog).
      throw new AutomationError('TargetReadCancelled', message, true, undefined, details);
    }
    if (code === 'TargetReadCancelled' || code === 'TargetReadUnavailable') {
      throw new AutomationError('TargetReadCancelled', message, true, undefined, details);
    }
    if (code === 'TargetBusy') {
      throw new AutomationError('TargetBusy', message, true, undefined, details);
    }
    if (code === 'SessionStarting') {
      throw new AutomationError('SessionStarting', message, true, undefined, details);
    }
    if (code === 'SessionTerminating') {
      throw new AutomationError('SessionTerminating', message, false, undefined, details);
    }
    if (code === 'TargetDisconnected' || code === 'NativeOwnerLost' || code === 'DeviceRemoved') {
      throw new AutomationError('TargetDisconnected', message, false, undefined, details);
    }
    if (code === 'MemoryReadFailed') {
      throw new AutomationError('MemoryReadFailed', message, false, undefined, details);
    }
    if (code === 'MemoryWriteFailed') {
      throw new AutomationError('MemoryWriteFailed', message, false, undefined, details);
    }
    if (code === 'InvalidAddress') {
      throw new AutomationError('InvalidAddress', message, false, undefined, details);
    }
    if (code === 'InvalidRequest') {
      throw new AutomationError('InvalidRequest', message, false, undefined, details);
    }
    throw new AutomationError('InternalError', message, false, undefined, details);
  }

  private resolve(ref: SessionRef): { session: vscode.DebugSession; generation: number } {
    const session = this.opts.registry.requireExact(ref);
    return { session, generation: ref.sessionGeneration };
  }

  private requireOperationId(operationId: string | undefined): void {
    if (!operationId) {
      throw new AutomationError('InternalError', 'memory write dispatched without an operationId', false);
    }
  }

  /**
   * Parses a frozen 0x-prefixed Address into a 32-bit unsigned integer. The
   * frozen schema only requires the 0x-hex shape; the service additionally
   * rejects anything outside the 32-bit address space (plan Task 9).
   */
  private parseAddress(input: string): number {
    if (typeof input !== 'string' || !/^0x[0-9A-Fa-f]+$/.test(input)) {
      throw new AutomationError('InvalidAddress', `invalid memory address ${JSON.stringify(input)}`, false);
    }
    const value = Number.parseInt(input.slice(2), 16);
    if (!Number.isFinite(value) || value < 0 || value > 0xFFFFFFFF) {
      throw new AutomationError('InvalidAddress', `memory address ${input} exceeds the 32-bit address space`, false);
    }
    return value >>> 0;
  }

  private formatAddress(address: number): string {
    return `0x${(address >>> 0).toString(16).toUpperCase()}`;
  }

  /**
   * Decodes and validates a base64 memory payload. `Buffer.from` is lenient
   * (it skips invalid characters), so the payload is round-tripped to reject
   * non-canonical input before any target access happens.
   */
  private decodeBase64(input: string): Uint8Array {
    if (typeof input !== 'string' || input.length === 0) {
      throw new AutomationError('InvalidRequest', 'memory write requires non-empty base64 data', false);
    }
    let bytes: Buffer;
    try {
      bytes = Buffer.from(input, 'base64');
    } catch {
      throw new AutomationError('InvalidRequest', 'invalid base64 memory payload', false);
    }
    if (bytes.length === 0) {
      throw new AutomationError('InvalidRequest', 'memory write data decodes to zero bytes', false);
    }
    if (bytes.toString('base64').replace(/=+$/, '') !== input.replace(/=+$/, '')) {
      throw new AutomationError('InvalidRequest', 'invalid base64 memory payload', false);
    }
    return new Uint8Array(bytes);
  }
}
