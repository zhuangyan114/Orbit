import type { Capability } from '../rtos/model';
import type {
  CmsisDapRttChannelDescriptor,
  CmsisDapRttEnumResult,
  CmsisDapRttMemoryRange,
  CmsisDapRttWriteResult,
} from './cmsis-dap-helper-channel';

export type RttCapabilityOwnerKind = 'none' | 'jlink-native' | 'cmsis-dap';

export interface RttCapabilities {
  ownerKind: RttCapabilityOwnerKind;
  rttStart: Capability;
  rttEnumerate: Capability;
  rttUpRead: Capability;
  rttDownWrite: Capability;
  details?: Record<string, unknown>;
}

export function rttCapability(
  available: boolean,
  reason?: string,
  evidence: Capability['evidence'] = 'source',
): Capability {
  return available
    ? { available: true, evidence }
    : { available: false, reason: reason || 'capability is unavailable', evidence };
}

export function unavailableRttCapabilities(
  ownerKind: RttCapabilityOwnerKind,
  reason: string,
  details?: Record<string, unknown>,
): RttCapabilities {
  return {
    ownerKind,
    rttStart: rttCapability(false, reason),
    rttEnumerate: rttCapability(false, reason),
    rttUpRead: rttCapability(false, reason),
    rttDownWrite: rttCapability(false, reason),
    ...(details ? { details } : {}),
  };
}

export const MAX_RTT_MEMORY_RANGES = 32;
export const MAX_RTT_BUFFERS = 64;
const VALID_RTT_STATUS = new Set(['valid', 'unused', 'corrupt']);
const VALID_RTT_NAME_STATUS = new Set([
  'ok', 'null', 'empty', 'short-read', 'unterminated', 'invalid-address', 'read-failed', 'none',
]);
const VALID_RTT_WRITE_COMPLETION = new Set(['not-started', 'partial', 'completed', 'unknown']);
const VALID_RTT_WRITE_STAGE = new Set([
  'none', 'validation', 'control-block', 'descriptor', 'data-first', 'data-second', 'commit-wroff', 'poll-wait',
]);

export function validateRttMemoryRanges(
  ranges: unknown,
  allowEmpty: boolean,
  label: string,
): { ok: true; normalized: CmsisDapRttMemoryRange[] } | { ok: false; message: string } {
  if (!Array.isArray(ranges)) {
    return { ok: false, message: `${label} must be an array of {address, size}` };
  }
  if (!allowEmpty && ranges.length === 0) {
    return { ok: false, message: `${label} must not be empty` };
  }
  if (ranges.length > MAX_RTT_MEMORY_RANGES) {
    return { ok: false, message: `${label} exceeds maximum of ${MAX_RTT_MEMORY_RANGES} entries` };
  }
  const normalized: CmsisDapRttMemoryRange[] = [];
  for (const rawEntry of ranges) {
    const entry = rawEntry as { address?: unknown; size?: unknown } | null;
    if (!entry || typeof entry !== 'object'
      || typeof entry.address !== 'number' || !Number.isSafeInteger(entry.address) || entry.address < 0 || entry.address > 0xFFFFFFFF
      || typeof entry.size !== 'number' || !Number.isSafeInteger(entry.size) || entry.size <= 0 || entry.address + entry.size > 0x100000000) {
      return { ok: false, message: `${label} entries require uint32 address and positive size within 32-bit space` };
    }
    normalized.push({ address: entry.address, size: entry.size });
  }
  const sorted = [...normalized].sort((a, b) => a.address - b.address);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].address < sorted[i - 1].address + sorted[i - 1].size) {
      return { ok: false, message: `${label} entries must not overlap` };
    }
  }
  return { ok: true, normalized };
}

export function isValidRttDescriptor(
  entry: unknown,
  expectedDirection: 'up' | 'down',
  expectedIndex: number,
): entry is CmsisDapRttChannelDescriptor {
  if (!entry || typeof entry !== 'object') return false;
  const item = entry as Partial<CmsisDapRttChannelDescriptor>;
  return item.direction === expectedDirection
    && item.index === expectedIndex
    && typeof item.descriptorAddress === 'number' && Number.isInteger(item.descriptorAddress)
    && typeof item.configured === 'boolean'
    && typeof item.valid === 'boolean'
    && typeof item.status === 'string' && VALID_RTT_STATUS.has(item.status)
    && typeof item.name === 'string'
    && typeof item.nameAddress === 'number' && Number.isInteger(item.nameAddress)
    && typeof item.nameStatus === 'string' && VALID_RTT_NAME_STATUS.has(item.nameStatus)
    && typeof item.duplicateName === 'boolean'
    && typeof item.bufferAddress === 'number' && Number.isInteger(item.bufferAddress)
    && typeof item.bufferSize === 'number' && Number.isInteger(item.bufferSize)
    && typeof item.wrOff === 'number' && Number.isInteger(item.wrOff)
    && typeof item.rdOff === 'number' && Number.isInteger(item.rdOff)
    && typeof item.flags === 'number' && Number.isInteger(item.flags)
    && typeof item.mode === 'number' && Number.isInteger(item.mode);
}

export function isValidRttEnumResult(data: unknown): data is CmsisDapRttEnumResult {
  if (!data || typeof data !== 'object') return false;
  const value = data as Partial<CmsisDapRttEnumResult>;
  if (!Number.isInteger(value.controlBlockAddress) || (value.controlBlockAddress as number) <= 0) return false;
  if (!Number.isInteger(value.maxUpBuffers) || (value.maxUpBuffers as number) <= 0 || (value.maxUpBuffers as number) > MAX_RTT_BUFFERS) {
    return false;
  }
  if (!Number.isInteger(value.maxDownBuffers) || (value.maxDownBuffers as number) < 0 || (value.maxDownBuffers as number) > MAX_RTT_BUFFERS) {
    return false;
  }
  if (!Array.isArray(value.upBuffers) || value.upBuffers.length !== value.maxUpBuffers) return false;
  if (!Array.isArray(value.downBuffers) || value.downBuffers.length !== value.maxDownBuffers) return false;
  if (!Array.isArray(value.duplicateUpNames) || !value.duplicateUpNames.every(name => typeof name === 'string')) return false;
  if (!Array.isArray(value.duplicateDownNames) || !value.duplicateDownNames.every(name => typeof name === 'string')) return false;
  if (!Number.isInteger(value.validUpCount) || !Number.isInteger(value.validDownCount)
    || !Number.isInteger(value.corruptCount) || !Number.isInteger(value.unusedCount)) {
    return false;
  }
  return value.upBuffers.every((item, index) => isValidRttDescriptor(item, 'up', index))
    && value.downBuffers.every((item, index) => isValidRttDescriptor(item, 'down', index));
}

export function isValidRttWriteResult(
  data: unknown,
  expectedRequestedBytes: number,
  expectedBufferIndex: number,
): data is CmsisDapRttWriteResult {
  if (!data || typeof data !== 'object') return false;
  const value = data as Partial<CmsisDapRttWriteResult>;
  if (!Number.isInteger(value.controlBlockAddress) || (value.controlBlockAddress as number) <= 0) return false;
  if (value.bufferIndex !== expectedBufferIndex) return false;
  if (!Number.isInteger(value.descriptorAddress) || !Number.isInteger(value.bufferAddress)) return false;
  if (!Number.isInteger(value.bufferSize) || (value.bufferSize as number) <= 0) return false;
  if (!Number.isInteger(value.initialWrOff) || (value.initialWrOff as number) < 0 || (value.initialWrOff as number) >= (value.bufferSize as number)) return false;
  if (!Number.isInteger(value.initialRdOff) || (value.initialRdOff as number) < 0 || (value.initialRdOff as number) >= (value.bufferSize as number)) return false;
  if (!Number.isInteger(value.rdOff) || (value.rdOff as number) < 0 || (value.rdOff as number) >= (value.bufferSize as number)) return false;
  if (!Number.isInteger(value.committedWrOff) || (value.committedWrOff as number) < 0 || (value.committedWrOff as number) >= (value.bufferSize as number)) return false;
  if (!Number.isInteger(value.flags) || !Number.isInteger(value.mode)) return false;
  if (!Number.isInteger(value.availableSpace) || (value.availableSpace as number) < 0) return false;
  if (value.requestedBytes !== expectedRequestedBytes) return false;
  if (!Number.isInteger(value.writtenBytes) || (value.writtenBytes as number) < 0 || (value.writtenBytes as number) > expectedRequestedBytes) return false;
  if (!Number.isInteger(value.committedBytes) || (value.committedBytes as number) < 0 || (value.committedBytes as number) > (value.writtenBytes as number)) return false;
  if (typeof value.wrapped !== 'boolean' || typeof value.shortWrite !== 'boolean' || typeof value.skipped !== 'boolean') return false;
  if (typeof value.firstSegmentWritten !== 'boolean' || typeof value.secondSegmentWritten !== 'boolean') return false;
  if (typeof value.wrOffWriteAttempted !== 'boolean' || typeof value.wrOffCommitted !== 'boolean') return false;
  if (typeof value.completion !== 'string' || !VALID_RTT_WRITE_COMPLETION.has(value.completion)) return false;
  if (typeof value.failureStage !== 'string' || !VALID_RTT_WRITE_STAGE.has(value.failureStage)) return false;
  if (typeof value.retryable !== 'boolean') return false;
  if ((value.committedBytes as number) > 0 && !value.wrOffCommitted) return false;
  if (value.committedBytes === 0 && value.committedWrOff !== value.initialWrOff) return false;
  return true;
}

export function isValidRttCapabilities(data: unknown): data is RttCapabilities {
  if (!data || typeof data !== 'object') return false;
  const value = data as Partial<RttCapabilities>;
  const validCap = (cap: unknown): cap is Capability => {
    if (!cap || typeof cap !== 'object') return false;
    const item = cap as Partial<Capability>;
    if (typeof item.available !== 'boolean') return false;
    if (!item.available && (typeof item.reason !== 'string' || item.reason.length === 0)) return false;
    return item.evidence === 'source' || item.evidence === 'offline' || item.evidence === 'hardware';
  };
  return (value.ownerKind === 'none'
    || value.ownerKind === 'jlink-native'
    || value.ownerKind === 'cmsis-dap')
    && validCap(value.rttStart)
    && validCap(value.rttEnumerate)
    && validCap(value.rttUpRead)
    && validCap(value.rttDownWrite);
}
