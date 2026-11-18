import {
  CmsisDapRttChannelDescriptor,
  CmsisDapRttEnumResult,
  CmsisDapRttMemoryRange,
  CmsisDapRttNameStatus,
  CmsisDapRttReadResult,
  CmsisDapRttWriteFailureStage,
  CmsisDapRttWriteResult,
} from './cmsis-dap-helper-channel';
import { CppJLinkResult, CppJLinkTargetState } from './cpp-jlink-channel';
import { MAX_RTT_BUFFERS, validateRttMemoryRanges } from './rtt-contract';

const CONTROL_HEADER_SIZE = 24;
const DESCRIPTOR_SIZE = 24;
const MAX_NAME_BYTES = 64;
const MAX_READ_BYTES = 65536;
const RTT_MODE_MASK = 0x03;
const RTT_MODE_NO_BLOCK_SKIP = 0x00;
const RTT_MODE_NO_BLOCK_TRIM = 0x01;
const RTT_MODE_BLOCK_IF_FIFO_FULL = 0x02;
const MAGIC_BYTES = Buffer.from('SEGGER RTT', 'ascii');

export interface SeggerRttMemoryPort {
  read(address: number, size: number, priority: 'watch' | 'background' | 'control', signal?: AbortSignal): Promise<CppJLinkResult<{ bytes: Uint8Array }>>;
  write(address: number, bytes: Uint8Array, priority: 'background' | 'control'): Promise<CppJLinkResult<{ bytesWritten: number }>>;
}

export interface SeggerRttMemoryOptions {
  maxChunkBytes?: number;
  writeAlignmentBytes?: 1 | 4;
  validateBufferFlags?: boolean;
  nowMs?: () => number;
  sleepMs?: (ms: number) => Promise<void>;
}

function inRanges(address: number, size: number, ranges: readonly CmsisDapRttMemoryRange[]): CmsisDapRttMemoryRange | undefined {
  if (size <= 0) return undefined;
  for (const range of ranges) {
    if (address >= range.address && address - range.address <= range.size && size <= range.size - (address - range.address)) {
      return range;
    }
  }
  return undefined;
}

function rangesOverlap(aAddress: number, aSize: number, bAddress: number, bSize: number): boolean {
  if (aSize <= 0 || bSize <= 0) return false;
  const aEnd = aAddress + aSize;
  const bEnd = bAddress + bSize;
  return aAddress < bEnd && bAddress < aEnd;
}

function readU32LE(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]
    | (bytes[offset + 1] << 8)
    | (bytes[offset + 2] << 16)
    | (bytes[offset + 3] << 24)
  ) >>> 0;
}

function writeU32LE(value: number): Uint8Array {
  const out = new Uint8Array(4);
  out[0] = value & 0xFF;
  out[1] = (value >>> 8) & 0xFF;
  out[2] = (value >>> 16) & 0xFF;
  out[3] = (value >>> 24) & 0xFF;
  return out;
}

function isOwnerOrTransportFatal(errorCode: string | undefined): boolean {
  return errorCode === 'ReadTimeout'
    || errorCode === 'WriteTimeout'
    || errorCode === 'DeviceRemoved'
    || errorCode === 'NativeOwnerLost'
    || errorCode === 'HelperExited'
    || errorCode === 'TargetOwnerUnavailable'
    || errorCode === 'TargetDisconnected'
    || errorCode === 'TargetReadCancelled'
    || errorCode === 'RequestCancelled'
    || errorCode === 'DapAckNoAck';
}

function isUnknownWriteOutcome(errorCode: string | undefined): boolean {
  return errorCode === 'WriteTimeout'
    || errorCode === 'ReadTimeout'
    || errorCode === 'WriteCompletedLate'
    || errorCode === 'OutcomeUnknown'
    || errorCode === 'MalformedResponse'
    || errorCode === 'DeviceRemoved'
    || errorCode === 'NativeOwnerLost'
    || errorCode === 'TargetDisconnected'
    || errorCode === 'DapAckNoAck';
}

/**
 * Pure TypeScript SEGGER RTT control-block / ring-buffer memory protocol
 * engine, matching native/cmsis-dap-helper/src/segger_rtt.cpp semantics for
 * owners that expose bounded readMemory/writeMemory (such as RMLink).
 */
export class SeggerRttMemoryEngine {
  private readonly maxChunkBytes: number;
  private readonly writeAlignmentBytes: 1 | 4;
  private readonly validateBufferFlags: boolean;
  private readonly nowMs: () => number;
  private readonly sleepMs: (ms: number) => Promise<void>;
  private started = false;
  private controlBlockAddress = 0;
  private ramRanges: CmsisDapRttMemoryRange[] = [];

  constructor(private readonly port: SeggerRttMemoryPort, options: SeggerRttMemoryOptions = {}) {
    this.writeAlignmentBytes = options.writeAlignmentBytes === 4 ? 4 : 1;
    const rawChunk = Math.max(4, Math.min(4096, options.maxChunkBytes ?? 128));
    this.maxChunkBytes = this.writeAlignmentBytes === 4 ? Math.max(4, Math.floor(rawChunk / 4) * 4) : rawChunk;
    this.validateBufferFlags = options.validateBufferFlags ?? true;
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.sleepMs = options.sleepMs ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  }

  get isStarted(): boolean {
    return this.started;
  }

  get activeControlBlockAddress(): number {
    return this.controlBlockAddress;
  }

  get activeRamRanges(): readonly CmsisDapRttMemoryRange[] {
    return this.ramRanges;
  }

  async start(
    controlBlockAddress: number,
    ramRanges: readonly CmsisDapRttMemoryRange[],
  ): Promise<CppJLinkResult<{ controlBlockAddress: number; maxUpBuffers: number; maxDownBuffers: number }>> {
    const checked = validateRttMemoryRanges(ramRanges, false, 'ramRanges');
    if (!checked.ok) {
      return this.fail(checked.message, 'DapInvalidRequest');
    }
    if (!Number.isInteger(controlBlockAddress) || controlBlockAddress <= 0 || controlBlockAddress > 0xFFFFFFFF) {
      return this.fail('RTT Control Block address is invalid', 'RttInvalidControlBlock');
    }
    const cb = await this.readControlBlock(controlBlockAddress >>> 0, checked.normalized, 'watch');
    if (!cb.ok || !cb.data) {
      return { ...cb, data: undefined };
    }
    this.started = true;
    this.controlBlockAddress = controlBlockAddress >>> 0;
    this.ramRanges = checked.normalized;
    return {
      ok: true,
      message: 'RTT memory engine started',
      targetState: cb.targetState,
      elapsedMs: cb.elapsedMs,
      data: {
        controlBlockAddress: this.controlBlockAddress,
        maxUpBuffers: cb.data.maxUpBuffers,
        maxDownBuffers: cb.data.maxDownBuffers,
      },
    };
  }

  stop(): void {
    this.started = false;
    this.controlBlockAddress = 0;
    this.ramRanges = [];
  }

  async enumerate(
    controlBlockAddress: number,
    ramRanges: readonly CmsisDapRttMemoryRange[],
    roRanges: readonly CmsisDapRttMemoryRange[] = [],
    timeoutMs = 2000,
  ): Promise<CppJLinkResult<CmsisDapRttEnumResult>> {
    const startedAt = this.nowMs();
    const ramChecked = validateRttMemoryRanges(ramRanges, false, 'ramRanges');
    if (!ramChecked.ok) return this.fail(ramChecked.message, 'DapInvalidRequest');
    const roChecked = validateRttMemoryRanges(roRanges, true, 'roRanges');
    if (!roChecked.ok) return this.fail(roChecked.message, 'DapInvalidRequest');
    if (!Number.isInteger(controlBlockAddress) || controlBlockAddress <= 0 || controlBlockAddress > 0xFFFFFFFF) {
      return this.fail('RTT Control Block address is invalid', 'RttInvalidControlBlock');
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 10000) {
      return this.fail('RTT enumeration timeoutMs must be an integer in 1..10000', 'DapInvalidRequest');
    }

    const deadline = startedAt + timeoutMs;
    const cbAddr = controlBlockAddress >>> 0;
    if (this.nowMs() >= deadline) {
      return this.fail(`RTT enumeration exceeded ${timeoutMs} ms deadline before control block header read`, 'ReadTimeout');
    }

    const cb = await this.readControlBlock(cbAddr, ramChecked.normalized, 'watch');
    if (!cb.ok || !cb.data) return cb as unknown as CppJLinkResult<CmsisDapRttEnumResult>;
    if (this.nowMs() >= deadline) {
      return this.fail(`RTT enumeration exceeded ${timeoutMs} ms deadline before descriptor table read`, 'ReadTimeout');
    }

    const { maxUpBuffers, maxDownBuffers } = cb.data;
    const totalBuffers = maxUpBuffers + maxDownBuffers;
    const tableBytes = totalBuffers * DESCRIPTOR_SIZE;
    const tableRead = await this.readChunked(cbAddr + CONTROL_HEADER_SIZE, tableBytes, 'watch');
    if (!tableRead.ok || !tableRead.data) {
      return this.mapReadFailure(tableRead, 'RTT descriptor table read');
    }
    if (tableRead.data.length !== tableBytes) {
      return this.fail('RTT descriptor table response is short', 'RttInvalidBufferLayout');
    }

    const descriptors = tableRead.data;
    const nameCache = new Map<number, { name: string; nameStatus: CmsisDapRttNameStatus; nameError?: string }>();
    const upBuffers: CmsisDapRttChannelDescriptor[] = [];
    const downBuffers: CmsisDapRttChannelDescriptor[] = [];
    let validUpCount = 0;
    let validDownCount = 0;
    let corruptCount = 0;
    let unusedCount = 0;

    const parseSlot = async (
      direction: 'up' | 'down',
      index: number,
      slotOrdinal: number,
    ): Promise<CppJLinkResult<CmsisDapRttChannelDescriptor>> => {
      const offset = slotOrdinal * DESCRIPTOR_SIZE;
      const descriptorAddress = (cbAddr + CONTROL_HEADER_SIZE + offset) >>> 0;
      const nameAddress = readU32LE(descriptors, offset);
      const bufferAddress = readU32LE(descriptors, offset + 4);
      const bufferSize = readU32LE(descriptors, offset + 8);
      const wrOff = readU32LE(descriptors, offset + 12);
      const rdOff = readU32LE(descriptors, offset + 16);
      const flags = readU32LE(descriptors, offset + 20);
      const mode = flags & RTT_MODE_MASK;

      if (nameAddress === 0 && bufferAddress === 0 && bufferSize === 0 && wrOff === 0 && rdOff === 0 && flags === 0) {
        unusedCount += 1;
        return {
          ok: true,
          message: 'ok',
          targetState: 'Unknown',
          elapsedMs: 0,
          data: {
            direction,
            index,
            descriptorAddress,
            configured: false,
            valid: false,
            status: 'unused',
            name: '',
            nameAddress: 0,
            nameStatus: 'none',
            duplicateName: false,
            bufferAddress: 0,
            bufferSize: 0,
            wrOff: 0,
            rdOff: 0,
            flags: 0,
            mode: 0,
          },
        };
      }

      if (this.validateBufferFlags && ((flags & ~RTT_MODE_MASK) !== 0 || mode > RTT_MODE_BLOCK_IF_FIFO_FULL)) {
        corruptCount += 1;
        return {
          ok: true,
          message: 'ok',
          targetState: 'Unknown',
          elapsedMs: 0,
          data: {
            direction,
            index,
            descriptorAddress,
            configured: true,
            valid: false,
            status: 'corrupt',
            name: '',
            nameAddress,
            nameStatus: 'none',
            duplicateName: false,
            bufferAddress,
            bufferSize,
            wrOff,
            rdOff,
            flags,
            mode,
            errorCode: 'RttInvalidBufferFlags',
            errorMessage: 'RTT buffer Flags contain an unknown mode or reserved bits',
          },
        };
      }

      if (bufferAddress === 0 || bufferSize === 0
        || !inRanges(bufferAddress, bufferSize, ramChecked.normalized)
        || wrOff >= bufferSize || rdOff >= bufferSize) {
        corruptCount += 1;
        return {
          ok: true,
          message: 'ok',
          targetState: 'Unknown',
          elapsedMs: 0,
          data: {
            direction,
            index,
            descriptorAddress,
            configured: true,
            valid: false,
            status: 'corrupt',
            name: '',
            nameAddress,
            nameStatus: 'none',
            duplicateName: false,
            bufferAddress,
            bufferSize,
            wrOff,
            rdOff,
            flags,
            mode,
            errorCode: 'RttInvalidBufferLayout',
            errorMessage: 'RTT buffer pointer, size, or offsets are invalid or outside valid RAM ranges',
          },
        };
      }

      if (direction === 'up') validUpCount += 1;
      else validDownCount += 1;

      if (nameAddress !== 0 && !nameCache.has(nameAddress) && this.nowMs() >= deadline) {
        return this.fail(`RTT enumeration exceeded ${timeoutMs} ms deadline during channel name enumeration`, 'ReadTimeout');
      }

      const nameInfo = await this.readChannelName(nameAddress, ramChecked.normalized, roChecked.normalized, nameCache);
      if (!nameInfo.ok || !nameInfo.data) {
        return nameInfo as unknown as CppJLinkResult<CmsisDapRttChannelDescriptor>;
      }

      return {
        ok: true,
        message: 'ok',
        targetState: 'Unknown',
        elapsedMs: 0,
        data: {
          direction,
          index,
          descriptorAddress,
          configured: true,
          valid: true,
          status: 'valid',
          name: nameInfo.data.name,
          nameAddress,
          nameStatus: nameInfo.data.nameStatus,
          ...(nameInfo.data.nameError ? { nameError: nameInfo.data.nameError } : {}),
          duplicateName: false,
          bufferAddress,
          bufferSize,
          wrOff,
          rdOff,
          flags,
          mode,
        },
      };
    };

    for (let i = 0; i < maxUpBuffers; i++) {
      const entry = await parseSlot('up', i, i);
      if (!entry.ok || !entry.data) return entry as unknown as CppJLinkResult<CmsisDapRttEnumResult>;
      upBuffers.push(entry.data);
    }
    for (let j = 0; j < maxDownBuffers; j++) {
      const entry = await parseSlot('down', j, maxUpBuffers + j);
      if (!entry.ok || !entry.data) return entry as unknown as CppJLinkResult<CmsisDapRttEnumResult>;
      downBuffers.push(entry.data);
    }

    if (this.nowMs() >= deadline) {
      return this.fail(`RTT enumeration exceeded ${timeoutMs} ms deadline after descriptor and name reads`, 'ReadTimeout');
    }

    const duplicateUpNames = this.markDuplicateNames(upBuffers);
    const duplicateDownNames = this.markDuplicateNames(downBuffers);

    return {
      ok: true,
      message: 'RTT channels enumerated',
      targetState: cb.targetState,
      elapsedMs: Math.max(0, this.nowMs() - startedAt),
      data: {
        controlBlockAddress: cbAddr,
        maxUpBuffers,
        maxDownBuffers,
        upBuffers,
        downBuffers,
        duplicateUpNames,
        duplicateDownNames,
        validUpCount,
        validDownCount,
        corruptCount,
        unusedCount,
      },
    };
  }

  async readUp(
    bufferIndex: number,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<CppJLinkResult<Omit<CmsisDapRttReadResult, 'bytes'> & { bytes: Uint8Array }>> {
    const startedAt = this.nowMs();
    if (!this.started) {
      return this.fail('RTT is not started', 'RttStopped');
    }
    if (!Number.isInteger(bufferIndex) || bufferIndex < 0) {
      return this.fail('RTT Up Buffer index is invalid', 'RttInvalidBufferIndex');
    }
    if (!Number.isInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_READ_BYTES) {
      return this.fail('RTT read size is outside 1..65536', 'RttInvalidBufferLayout');
    }

    const cb = await this.readControlBlock(this.controlBlockAddress, this.ramRanges, 'background', signal);
    if (!cb.ok || !cb.data) return cb as unknown as CppJLinkResult<Omit<CmsisDapRttReadResult, 'bytes'> & { bytes: Uint8Array }>;

    if (bufferIndex >= cb.data.maxUpBuffers) {
      return this.fail('RTT Up Buffer index is out of range', 'RttInvalidBufferIndex');
    }
    const descriptorAddress = (this.controlBlockAddress + CONTROL_HEADER_SIZE + bufferIndex * DESCRIPTOR_SIZE) >>> 0;
    if (!inRanges(descriptorAddress, DESCRIPTOR_SIZE, this.ramRanges)) {
      return this.fail('RTT Up Buffer descriptor exceeds valid target RAM ranges', 'RttInvalidBufferLayout');
    }

    const descRead = await this.readChunked(descriptorAddress, DESCRIPTOR_SIZE, 'background', signal);
    if (!descRead.ok || !descRead.data) {
      return this.mapReadFailure(descRead, 'RTT Up Buffer descriptor read');
    }
    if (descRead.data.length !== DESCRIPTOR_SIZE) {
      return this.fail('RTT Up Buffer descriptor response is short', 'RttInvalidBufferLayout');
    }

    const desc = descRead.data;
    const bufferAddress = readU32LE(desc, 4);
    const bufferSize = readU32LE(desc, 8);
    const wrOff = readU32LE(desc, 12);
    const rdOff = readU32LE(desc, 16);
    const flags = readU32LE(desc, 20);
    const mode = flags & RTT_MODE_MASK;

    if (this.validateBufferFlags && ((flags & ~RTT_MODE_MASK) !== 0 || mode > RTT_MODE_BLOCK_IF_FIFO_FULL)) {
      return this.fail(
        `RTT Up Buffer Flags contain an unknown mode or reserved bits flags=${flags} mode=${mode} bufferIndex=${bufferIndex}`,
        'RttInvalidBufferFlags',
      );
    }
    if (bufferAddress === 0 || bufferSize === 0
      || !inRanges(bufferAddress, bufferSize, this.ramRanges)
      || wrOff >= bufferSize || rdOff >= bufferSize) {
      return this.fail(
        `RTT Up Buffer pointer, size, or offsets are invalid address=${bufferAddress} size=${bufferSize} wrOff=${wrOff} rdOff=${rdOff}`,
        'RttInvalidBufferLayout',
      );
    }

    const baseResult = {
      controlBlockAddress: this.controlBlockAddress,
      bufferIndex,
      descriptorAddress,
      bufferAddress,
      bufferSize,
      wrOff,
      rdOff,
      flags,
      mode,
      committedRdOff: rdOff,
      requestedBytes: maxBytes,
      readBytes: 0,
      committedBytes: 0,
      wrapped: false,
      overrun: false,
      writerAdvanced: false,
      bytes: new Uint8Array(0),
    };

    if (wrOff === rdOff) {
      return {
        ok: true,
        message: 'RTT read empty',
        targetState: descRead.targetState,
        elapsedMs: Math.max(0, this.nowMs() - startedAt),
        data: baseResult,
      };
    }

    const available = wrOff > rdOff ? wrOff - rdOff : bufferSize - rdOff + wrOff;
    if (available > bufferSize) {
      return this.fail('RTT Up Buffer available range exceeds its size', 'RttBufferOverrun');
    }

    const requested = Math.min(maxBytes, available);
    const tail = bufferSize - rdOff;
    const firstSize = Math.min(requested, tail);
    const secondSize = requested - firstSize;
    const wrapped = secondSize > 0;

    const firstRead = await this.readChunked((bufferAddress + rdOff) >>> 0, firstSize, 'background', signal);
    if (!firstRead.ok || !firstRead.data || firstRead.data.length !== firstSize) {
      return firstRead.ok
        ? this.fail('RTT data read was short', 'RttMemoryReadFailed')
        : this.mapReadFailure(firstRead, 'RTT data read');
    }

    let bytes: Uint8Array;
    if (secondSize > 0) {
      const secondRead = await this.readChunked(bufferAddress, secondSize, 'background', signal);
      if (!secondRead.ok || !secondRead.data || secondRead.data.length !== secondSize) {
        return secondRead.ok
          ? this.fail('RTT wrapped data read was short', 'RttMemoryReadFailed')
          : this.mapReadFailure(secondRead, 'RTT wrapped data read');
      }
      bytes = new Uint8Array(firstSize + secondSize);
      bytes.set(firstRead.data, 0);
      bytes.set(secondRead.data, firstSize);
    } else {
      bytes = firstRead.data;
    }

    const afterRead = await this.readChunked(descriptorAddress, DESCRIPTOR_SIZE, 'background', signal);
    if (!afterRead.ok || !afterRead.data || afterRead.data.length !== DESCRIPTOR_SIZE) {
      return afterRead.ok
        ? this.fail('RTT descriptor confirmation was short', 'RttMemoryReadFailed')
        : this.mapReadFailure(afterRead, 'RTT descriptor confirmation');
    }

    const afterWrOff = readU32LE(afterRead.data, 12);
    const afterRdOff = readU32LE(afterRead.data, 16);
    const afterFlags = readU32LE(afterRead.data, 20);
    const writerAdvanced = afterWrOff !== wrOff;
    if (afterRdOff !== rdOff) {
      return this.fail('RTT RdOff changed while data was being read', 'RttBufferOverrun', {
        rtt: { ...baseResult, overrun: true, writerAdvanced },
      });
    }
    if (this.validateBufferFlags) {
      const afterMode = afterFlags & RTT_MODE_MASK;
      if ((afterFlags & ~RTT_MODE_MASK) !== 0 || afterMode > RTT_MODE_BLOCK_IF_FIFO_FULL) {
        return this.fail('RTT Up Buffer Flags became invalid while data was being read', 'RttInvalidBufferFlags');
      }
      if (afterFlags !== flags) {
        return this.fail('RTT Up Buffer Flags changed while data was being read', 'RttInvalidBufferLayout');
      }
    }

    const nextRdOff = (rdOff + bytes.length) % bufferSize;
    const commitWrite = await this.writeChunked((descriptorAddress + 16) >>> 0, writeU32LE(nextRdOff), 'background');
    if (!commitWrite.ok) {
      return this.mapWriteFailure(commitWrite, 'RTT RdOff write failed');
    }

    return {
      ok: true,
      message: 'RTT read completed',
      targetState: afterRead.targetState,
      elapsedMs: Math.max(0, this.nowMs() - startedAt),
      data: {
        ...baseResult,
        wrapped,
        writerAdvanced,
        committedRdOff: nextRdOff,
        readBytes: bytes.length,
        committedBytes: bytes.length,
        bytes,
      },
    };
  }

  async writeDown(
    controlBlockAddress: number,
    ramRanges: readonly CmsisDapRttMemoryRange[],
    bufferIndex: number,
    bytes: Uint8Array,
    timeoutMs = 2000,
  ): Promise<CppJLinkResult<CmsisDapRttWriteResult>> {
    const startedAt = this.nowMs();
    const result: CmsisDapRttWriteResult = {
      controlBlockAddress: controlBlockAddress >>> 0,
      bufferIndex,
      descriptorAddress: 0,
      bufferAddress: 0,
      bufferSize: 0,
      initialWrOff: 0,
      initialRdOff: 0,
      rdOff: 0,
      committedWrOff: 0,
      flags: 0,
      mode: 0,
      availableSpace: 0,
      requestedBytes: bytes.length,
      writtenBytes: 0,
      committedBytes: 0,
      wrapped: false,
      shortWrite: false,
      skipped: false,
      firstSegmentWritten: false,
      secondSegmentWritten: false,
      wrOffWriteAttempted: false,
      wrOffCommitted: false,
      completion: 'not-started',
      failureStage: 'none',
      retryable: false,
    };

    const failWithStage = (
      stage: CmsisDapRttWriteFailureStage,
      errorCode: string,
      message: string,
      completion = result.completion,
    ): CppJLinkResult<CmsisDapRttWriteResult> => {
      result.failureStage = stage;
      result.completion = completion;
      result.retryable = false;
      return this.fail(message, errorCode, { rtt: { ...result } });
    };

    const ramChecked = validateRttMemoryRanges(ramRanges, false, 'ramRanges');
    if (!ramChecked.ok) return failWithStage('validation', 'DapInvalidRequest', ramChecked.message);
    if (!Number.isInteger(controlBlockAddress) || controlBlockAddress <= 0 || controlBlockAddress > 0xFFFFFFFF) {
      return failWithStage('validation', 'RttInvalidControlBlock', 'RTT Control Block address is invalid');
    }
    if (!Number.isInteger(bufferIndex) || bufferIndex < 0 || bufferIndex > 0xFFFFFFFF) {
      return failWithStage('validation', 'DapInvalidRequest', 'RTT Down Buffer index must be a uint32');
    }
    if (bytes.length === 0 || bytes.length > MAX_READ_BYTES) {
      return failWithStage('validation', 'DapInvalidRequest', 'RTT write size is outside 1..65536');
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 10000) {
      return failWithStage('validation', 'DapInvalidRequest', 'RTT write timeoutMs must be an integer in 1..10000');
    }

    const deadline = startedAt + timeoutMs;
    if (this.nowMs() >= deadline) {
      return failWithStage('control-block', 'WriteTimeout', `RTT write exceeded ${timeoutMs} ms deadline before control block read`);
    }

    const cbAddr = controlBlockAddress >>> 0;
    const cb = await this.readControlBlock(cbAddr, ramChecked.normalized, 'control');
    if (!cb.ok || !cb.data) {
      return failWithStage('control-block', cb.errorCode || 'RttInvalidControlBlock', cb.message);
    }
    if (bufferIndex >= cb.data.maxDownBuffers) {
      return failWithStage('descriptor', 'RttInvalidBufferIndex', 'RTT Down Buffer index is out of range');
    }

    const descriptorsTotal = CONTROL_HEADER_SIZE + (cb.data.maxUpBuffers + cb.data.maxDownBuffers) * DESCRIPTOR_SIZE;
    const descriptorAddress = (cbAddr + CONTROL_HEADER_SIZE + (cb.data.maxUpBuffers + bufferIndex) * DESCRIPTOR_SIZE) >>> 0;
    result.descriptorAddress = descriptorAddress;
    if (!inRanges(descriptorAddress, DESCRIPTOR_SIZE, ramChecked.normalized)) {
      return failWithStage('descriptor', 'RttInvalidBufferLayout', 'RTT Down Buffer descriptor exceeds valid target RAM ranges');
    }

    const readDescriptor = async (stage: CmsisDapRttWriteFailureStage): Promise<CppJLinkResult<{
      bufferAddress: number; bufferSize: number; wrOff: number; rdOff: number; flags: number; mode: number;
    }>> => {
      const descRead = await this.readChunked(descriptorAddress, DESCRIPTOR_SIZE, 'control');
      if (!descRead.ok || !descRead.data || descRead.data.length !== DESCRIPTOR_SIZE) {
        const mapped = descRead.ok
          ? this.fail('RTT Down Buffer descriptor response is short', 'RttInvalidBufferLayout')
          : this.mapReadFailure(descRead, 'RTT Down Buffer descriptor read');
        return failWithStage(stage, mapped.errorCode || 'RttMemoryReadFailed', mapped.message) as unknown as CppJLinkResult<any>;
      }
      const bufferAddress = readU32LE(descRead.data, 4);
      const bufferSize = readU32LE(descRead.data, 8);
      const wrOff = readU32LE(descRead.data, 12);
      const rdOff = readU32LE(descRead.data, 16);
      const flags = readU32LE(descRead.data, 20);
      const mode = flags & RTT_MODE_MASK;

      if (this.validateBufferFlags && ((flags & ~RTT_MODE_MASK) !== 0 || mode > RTT_MODE_BLOCK_IF_FIFO_FULL)) {
        return failWithStage(stage, 'RttInvalidBufferFlags', 'RTT Down Buffer Flags contain an unknown mode or reserved bits') as unknown as CppJLinkResult<any>;
      }
      if (bufferAddress === 0 || bufferSize < 2
        || !inRanges(bufferAddress, bufferSize, ramChecked.normalized)
        || rangesOverlap(bufferAddress, bufferSize, cbAddr, descriptorsTotal)
        || wrOff >= bufferSize || rdOff >= bufferSize) {
        return failWithStage(stage, 'RttInvalidBufferLayout', 'RTT Down Buffer pointer, size, or offsets are invalid or overlap RTT control block') as unknown as CppJLinkResult<any>;
      }
      return {
        ok: true,
        message: 'ok',
        targetState: descRead.targetState,
        elapsedMs: 0,
        data: { bufferAddress, bufferSize, wrOff, rdOff, flags, mode },
      };
    };

    const initial = await readDescriptor('descriptor');
    if (!initial.ok || !initial.data) return initial as unknown as CppJLinkResult<CmsisDapRttWriteResult>;

    result.bufferAddress = initial.data.bufferAddress;
    result.bufferSize = initial.data.bufferSize;
    result.initialWrOff = initial.data.wrOff;
    result.initialRdOff = initial.data.rdOff;
    result.rdOff = initial.data.rdOff;
    result.committedWrOff = initial.data.wrOff;
    result.flags = initial.data.flags;
    result.mode = initial.data.mode;

    const spaceFor = (wrOff: number, rdOff: number, bufferSize: number): number => {
      return rdOff > wrOff ? rdOff - wrOff - 1 : bufferSize - wrOff + rdOff - 1;
    };

    let currentWrOff = initial.data.wrOff;
    let currentRdOff = initial.data.rdOff;
    let availableSpace = spaceFor(currentWrOff, currentRdOff, initial.data.bufferSize);
    result.availableSpace = availableSpace;

    if (initial.data.mode === RTT_MODE_NO_BLOCK_SKIP) {
      if (availableSpace < bytes.length) {
        result.skipped = true;
        result.shortWrite = true;
        result.completion = 'completed';
        return {
          ok: true,
          message: 'RTT down-buffer skipped (insufficient space)',
          targetState: initial.targetState,
          elapsedMs: Math.max(0, this.nowMs() - startedAt),
          data: result,
        };
      }
    } else if (initial.data.mode === RTT_MODE_NO_BLOCK_TRIM) {
      if (availableSpace === 0) {
        result.skipped = true;
        result.shortWrite = true;
        result.completion = 'completed';
        return {
          ok: true,
          message: 'RTT down-buffer trimmed to 0 bytes',
          targetState: initial.targetState,
          elapsedMs: Math.max(0, this.nowMs() - startedAt),
          data: result,
        };
      }
    } else if (initial.data.mode === RTT_MODE_BLOCK_IF_FIFO_FULL) {
      while (availableSpace < bytes.length) {
        if (this.nowMs() >= deadline) {
          return failWithStage('poll-wait', 'WriteTimeout', `RTT down-buffer Mode 2 waited ${timeoutMs} ms without enough free space`);
        }
        await this.sleepMs(5);
        if (this.nowMs() >= deadline) {
          return failWithStage('poll-wait', 'WriteTimeout', `RTT down-buffer Mode 2 waited ${timeoutMs} ms without enough free space`);
        }
        const refreshed = await readDescriptor('poll-wait');
        if (!refreshed.ok || !refreshed.data) return refreshed as unknown as CppJLinkResult<CmsisDapRttWriteResult>;
        if (refreshed.data.bufferAddress !== initial.data.bufferAddress
          || refreshed.data.bufferSize !== initial.data.bufferSize
          || refreshed.data.mode !== initial.data.mode
          || refreshed.data.wrOff !== currentWrOff) {
          return failWithStage('poll-wait', 'RttInvalidBufferLayout', 'RTT Down Buffer layout or WrOff changed while waiting for space');
        }
        currentRdOff = refreshed.data.rdOff;
        result.rdOff = currentRdOff;
        availableSpace = spaceFor(currentWrOff, currentRdOff, initial.data.bufferSize);
        result.availableSpace = availableSpace;
      }
    }

    const bytesToWrite = initial.data.mode === RTT_MODE_NO_BLOCK_TRIM
      ? Math.min(bytes.length, availableSpace)
      : bytes.length;
    result.shortWrite = bytesToWrite < bytes.length;

    const tail = initial.data.bufferSize - currentWrOff;
    const firstSize = Math.min(bytesToWrite, tail);
    const secondSize = bytesToWrite - firstSize;
    result.wrapped = secondSize > 0;

    const firstAddr = (initial.data.bufferAddress + currentWrOff) >>> 0;
    const planAlignedEnvelope = (segAddr: number, segLen: number) => {
      const alignedStart = (segAddr - (segAddr % 4)) >>> 0;
      const rawEnd = segAddr + segLen;
      const endRem = rawEnd % 4;
      const alignedEnd = endRem === 0 ? rawEnd : rawEnd + (4 - endRem);
      const alignedSize = alignedEnd - alignedStart;
      return { alignedStart, alignedEnd, alignedSize };
    };
    const validateAlignedEnvelope = (segAddr: number, segLen: number): string | null => {
      if (this.writeAlignmentBytes !== 4) return null;
      const { alignedStart, alignedEnd, alignedSize } = planAlignedEnvelope(segAddr, segLen);
      const ringEnd = initial.data!.bufferAddress + initial.data!.bufferSize;
      if (alignedStart < initial.data!.bufferAddress || alignedEnd > ringEnd) {
        return `RTT Down Buffer 4-byte aligned write envelope [0x${alignedStart.toString(16)}, 0x${alignedEnd.toString(16)}) extends outside Down ring [0x${initial.data!.bufferAddress.toString(16)}, 0x${ringEnd.toString(16)})`;
      }
      if (!inRanges(alignedStart, alignedSize, ramChecked.normalized)) {
        return 'RTT Down Buffer 4-byte aligned write envelope exceeds valid target RAM ranges';
      }
      if (rangesOverlap(alignedStart, alignedSize, cbAddr, descriptorsTotal)) {
        return 'RTT Down Buffer 4-byte aligned write envelope overlaps RTT control block or descriptors';
      }
      return null;
    };

    const firstGeomError = validateAlignedEnvelope(firstAddr, firstSize);
    if (firstGeomError) {
      return failWithStage('data-first', 'RttInvalidBufferLayout', firstGeomError, 'not-started');
    }
    if (secondSize > 0) {
      const secondGeomError = validateAlignedEnvelope(initial.data.bufferAddress, secondSize);
      if (secondGeomError) {
        return failWithStage('data-first', 'RttInvalidBufferLayout', secondGeomError, 'not-started');
      }
    }

    const writeSegment = async (
      stage: 'data-first' | 'data-second',
      segAddr: number,
      slice: Uint8Array,
      priorSegmentWritten: boolean,
    ): Promise<CppJLinkResult<CmsisDapRttWriteResult> | null> => {
      if (this.writeAlignmentBytes !== 4 || ((segAddr % 4) === 0 && (slice.length % 4) === 0)) {
        const res = await this.writeChunked(segAddr, slice, 'control');
        if (!res.ok) {
          return failWithStage(
            stage,
            res.errorCode || 'RttMemoryWriteFailed',
            res.message,
            isUnknownWriteOutcome(res.errorCode) ? 'unknown' : (priorSegmentWritten ? 'partial' : 'not-started'),
          );
        }
        return null;
      }

      const { alignedStart, alignedSize } = planAlignedEnvelope(segAddr, slice.length);
      const headPad = segAddr - alignedStart;
      const tailPad = alignedSize - headPad - slice.length;
      const alignedBuf = new Uint8Array(alignedSize);
      alignedBuf.set(slice, headPad);

      if (headPad > 0) {
        const headRead = await this.readChunked(alignedStart, 4, 'control');
        if (!headRead.ok || !headRead.data || headRead.data.length !== 4) {
          const code = headRead.ok
            ? 'RttMemoryReadFailed'
            : (isOwnerOrTransportFatal(headRead.errorCode) ? headRead.errorCode! : 'RttMemoryReadFailed');
          const msg = headRead.ok
            ? 'RTT aligned edge pre-read returned short word'
            : headRead.message;
          return failWithStage(stage, code, msg, priorSegmentWritten ? 'partial' : 'not-started');
        }
        alignedBuf.set(headRead.data.subarray(0, headPad), 0);
        if (tailPad > 0 && alignedSize === 4) {
          alignedBuf.set(headRead.data.subarray(headPad + slice.length, 4), headPad + slice.length);
        }
      }

      if (tailPad > 0 && !(headPad > 0 && alignedSize === 4)) {
        const tailWordAddr = (alignedStart + alignedSize - 4) >>> 0;
        const tailRead = await this.readChunked(tailWordAddr, 4, 'control');
        if (!tailRead.ok || !tailRead.data || tailRead.data.length !== 4) {
          const code = tailRead.ok
            ? 'RttMemoryReadFailed'
            : (isOwnerOrTransportFatal(tailRead.errorCode) ? tailRead.errorCode! : 'RttMemoryReadFailed');
          const msg = tailRead.ok
            ? 'RTT aligned tail pre-read returned short word'
            : tailRead.message;
          return failWithStage(stage, code, msg, priorSegmentWritten ? 'partial' : 'not-started');
        }
        const tailKeepStart = 4 - tailPad;
        alignedBuf.set(tailRead.data.subarray(tailKeepStart, 4), alignedSize - tailPad);
      }

      const writeRes = await this.writeChunked(alignedStart, alignedBuf, 'control');
      if (!writeRes.ok) {
        return failWithStage(
          stage,
          writeRes.errorCode || 'RttMemoryWriteFailed',
          writeRes.message,
          isUnknownWriteOutcome(writeRes.errorCode) ? 'unknown' : (priorSegmentWritten ? 'partial' : 'not-started'),
        );
      }
      return null;
    };

    const firstFailure = await writeSegment('data-first', firstAddr, bytes.subarray(0, firstSize), false);
    if (firstFailure) return firstFailure;
    result.firstSegmentWritten = true;

    if (secondSize > 0) {
      const secondFailure = await writeSegment(
        'data-second',
        initial.data.bufferAddress,
        bytes.subarray(firstSize, firstSize + secondSize),
        true,
      );
      if (secondFailure) return secondFailure;
      result.secondSegmentWritten = true;
    }

    result.writtenBytes = bytesToWrite;
    const nextWrOff = (currentWrOff + bytesToWrite) % initial.data.bufferSize;
    result.wrOffWriteAttempted = true;

    const commitWrite = await this.writeChunked((descriptorAddress + 12) >>> 0, writeU32LE(nextWrOff), 'control');
    if (!commitWrite.ok) {
      const unknown = isUnknownWriteOutcome(commitWrite.errorCode);
      return failWithStage(
        'commit-wroff',
        commitWrite.errorCode || 'RttMemoryWriteFailed',
        commitWrite.message,
        unknown ? 'unknown' : 'partial',
      );
    }

    result.wrOffCommitted = true;
    result.committedWrOff = nextWrOff;
    result.committedBytes = bytesToWrite;
    result.completion = 'completed';
    result.failureStage = 'none';

    return {
      ok: true,
      message: 'RTT down-buffer write completed',
      targetState: initial.targetState,
      elapsedMs: Math.max(0, this.nowMs() - startedAt),
      data: result,
    };
  }

  private async readControlBlock(
    controlBlockAddress: number,
    ramRanges: readonly CmsisDapRttMemoryRange[],
    priority: 'watch' | 'background' | 'control',
    signal?: AbortSignal,
  ): Promise<CppJLinkResult<{ maxUpBuffers: number; maxDownBuffers: number }>> {
    if (controlBlockAddress === 0 || (controlBlockAddress & 0x03) !== 0
      || !inRanges(controlBlockAddress, CONTROL_HEADER_SIZE, ramRanges)) {
      return this.fail('RTT Control Block address is outside valid target RAM ranges', 'RttInvalidControlBlock');
    }
    const read = await this.readChunked(controlBlockAddress, CONTROL_HEADER_SIZE, priority, signal);
    if (!read.ok || !read.data) {
      return this.mapReadFailure(read, 'RTT Control Block read');
    }
    if (read.data.length !== CONTROL_HEADER_SIZE
      || Buffer.compare(Buffer.from(read.data.subarray(0, MAGIC_BYTES.length)), MAGIC_BYTES) !== 0) {
      return this.fail('RTT Control Block magic is not SEGGER RTT', 'RttInvalidControlBlock');
    }
    const maxUpBuffers = readU32LE(read.data, 16);
    const maxDownBuffers = readU32LE(read.data, 20);
    if (maxUpBuffers === 0 || maxUpBuffers > MAX_RTT_BUFFERS || maxDownBuffers > MAX_RTT_BUFFERS) {
      return this.fail('RTT Control Block buffer counts are invalid', 'RttInvalidControlBlock');
    }
    const descriptorsTotal = CONTROL_HEADER_SIZE + (maxUpBuffers + maxDownBuffers) * DESCRIPTOR_SIZE;
    if (!inRanges(controlBlockAddress, descriptorsTotal, ramRanges)) {
      return this.fail('RTT Control Block descriptors exceed valid target RAM ranges', 'RttInvalidControlBlock');
    }
    return {
      ok: true,
      message: 'ok',
      targetState: read.targetState,
      elapsedMs: read.elapsedMs,
      data: { maxUpBuffers, maxDownBuffers },
    };
  }

  private async readChannelName(
    nameAddress: number,
    ramRanges: readonly CmsisDapRttMemoryRange[],
    roRanges: readonly CmsisDapRttMemoryRange[],
    cache: Map<number, { name: string; nameStatus: CmsisDapRttNameStatus; nameError?: string }>,
  ): Promise<CppJLinkResult<{ name: string; nameStatus: CmsisDapRttNameStatus; nameError?: string }>> {
    if (nameAddress === 0) {
      return { ok: true, message: 'ok', targetState: 'Unknown', elapsedMs: 0, data: { name: '', nameStatus: 'null' } };
    }
    const cached = cache.get(nameAddress);
    if (cached) {
      return { ok: true, message: 'ok', targetState: 'Unknown', elapsedMs: 0, data: cached };
    }
    const range = inRanges(nameAddress, 1, ramRanges) ?? inRanges(nameAddress, 1, roRanges);
    if (!range) {
      const resolved = {
        name: '',
        nameStatus: 'invalid-address' as const,
        nameError: 'RTT buffer name address is outside valid RAM and RO ranges',
      };
      cache.set(nameAddress, resolved);
      return { ok: true, message: 'ok', targetState: 'Unknown', elapsedMs: 0, data: resolved };
    }
    const remaining = Math.min(MAX_NAME_BYTES, range.address + range.size - nameAddress);
    const read = await this.readChunked(nameAddress, remaining, 'watch');
    if (!read.ok || !read.data) {
      if (isOwnerOrTransportFatal(read.errorCode)) {
        return read as unknown as CppJLinkResult<any>;
      }
      const resolved = {
        name: '',
        nameStatus: 'read-failed' as const,
        nameError: `RTT buffer name read failed: ${read.errorCode || 'MemoryReadFailed'}: ${read.message}`,
      };
      cache.set(nameAddress, resolved);
      return { ok: true, message: 'ok', targetState: 'Unknown', elapsedMs: 0, data: resolved };
    }

    const nulIdx = read.data.indexOf(0);
    if (nulIdx >= 0) {
      const resolved = nulIdx === 0
        ? { name: '', nameStatus: 'empty' as const }
        : { name: Buffer.from(read.data.subarray(0, nulIdx)).toString('utf8'), nameStatus: 'ok' as const };
      cache.set(nameAddress, resolved);
      return { ok: true, message: 'ok', targetState: 'Unknown', elapsedMs: 0, data: resolved };
    }

    const resolved = read.data.length < remaining
      ? {
        name: '',
        nameStatus: 'short-read' as const,
        nameError: `RTT buffer name read was short before NUL terminator (requested=${remaining} received=${read.data.length})`,
      }
      : {
        name: '',
        nameStatus: 'unterminated' as const,
        nameError: remaining < MAX_NAME_BYTES
          ? 'RTT buffer name reached memory region boundary without NUL terminator'
          : `RTT buffer name exceeded ${MAX_NAME_BYTES} bytes without NUL terminator`,
      };
    cache.set(nameAddress, resolved);
    return { ok: true, message: 'ok', targetState: 'Unknown', elapsedMs: 0, data: resolved };
  }

  private markDuplicateNames(descriptors: CmsisDapRttChannelDescriptor[]): string[] {
    const counts = new Map<string, number>();
    for (const entry of descriptors) {
      if (entry.valid && entry.nameStatus === 'ok' && entry.name.length > 0) {
        counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
      }
    }
    const duplicates: string[] = [];
    for (const entry of descriptors) {
      if (entry.valid && entry.nameStatus === 'ok' && entry.name.length > 0 && (counts.get(entry.name) ?? 0) > 1) {
        entry.duplicateName = true;
        if (!duplicates.includes(entry.name)) duplicates.push(entry.name);
      }
    }
    return duplicates;
  }

  private async readChunked(
    address: number,
    size: number,
    priority: 'watch' | 'background' | 'control',
    signal?: AbortSignal,
  ): Promise<CppJLinkResult<Uint8Array>> {
    const out = new Uint8Array(size);
    let offset = 0;
    let lastState: CppJLinkTargetState = 'Unknown';
    let elapsedMs = 0;
    while (offset < size) {
      const chunk = Math.min(this.maxChunkBytes, size - offset);
      const res = await this.port.read((address + offset) >>> 0, chunk, priority, signal);
      elapsedMs += res.elapsedMs;
      if (!res.ok || !res.data) {
        return {
          ok: false,
          message: res.message,
          errorCode: res.errorCode,
          targetState: res.targetState,
          elapsedMs,
          diagnostics: res.diagnostics,
        };
      }
      lastState = res.targetState;
      const chunkBytes = res.data.bytes;
      if (chunkBytes.length === 0) {
        return {
          ok: true,
          message: 'short read',
          targetState: lastState,
          elapsedMs,
          data: out.subarray(0, offset),
        };
      }
      const copyLen = Math.min(chunkBytes.length, size - offset);
      out.set(chunkBytes.subarray(0, copyLen), offset);
      offset += copyLen;
      if (chunkBytes.length < chunk) {
        return {
          ok: true,
          message: 'short read',
          targetState: lastState,
          elapsedMs,
          data: out.subarray(0, offset),
        };
      }
    }
    return {
      ok: true,
      message: 'ok',
      targetState: lastState,
      elapsedMs,
      data: out,
    };
  }

  private async writeChunked(
    address: number,
    bytes: Uint8Array,
    priority: 'background' | 'control',
  ): Promise<CppJLinkResult<void>> {
    let offset = 0;
    let elapsedMs = 0;
    let lastState: CppJLinkTargetState = 'Unknown';
    while (offset < bytes.length) {
      const chunk = Math.min(this.maxChunkBytes, bytes.length - offset);
      const slice = bytes.subarray(offset, offset + chunk);
      const res = await this.port.write((address + offset) >>> 0, slice, priority);
      elapsedMs += res.elapsedMs;
      if (!res.ok) {
        return {
          ok: false,
          message: res.message,
          errorCode: res.errorCode,
          targetState: res.targetState,
          elapsedMs,
          diagnostics: res.diagnostics,
        };
      }
      if (!res.data || res.data.bytesWritten !== slice.length) {
        return {
          ok: false,
          message: `RTT memory short write: requested=${slice.length} written=${res.data?.bytesWritten ?? 0}`,
          errorCode: 'OutcomeUnknown',
          targetState: res.targetState,
          elapsedMs,
        };
      }
      lastState = res.targetState;
      offset += chunk;
    }
    return {
      ok: true,
      message: 'ok',
      targetState: lastState,
      elapsedMs,
    };
  }

  private mapReadFailure<T>(result: CppJLinkResult<unknown>, operation: string): CppJLinkResult<T> {
    if (isOwnerOrTransportFatal(result.errorCode)) {
      return result as CppJLinkResult<T>;
    }
    return this.fail(`${operation} failed: ${result.errorCode || 'MemoryReadFailed'}: ${result.message}`, 'RttMemoryReadFailed');
  }

  private mapWriteFailure<T>(result: CppJLinkResult<unknown>, operation: string): CppJLinkResult<T> {
    if (isUnknownWriteOutcome(result.errorCode)) {
      return result as CppJLinkResult<T>;
    }
    return this.fail(`${operation} failed: ${result.errorCode || 'MemoryWriteFailed'}: ${result.message}`, 'RttMemoryWriteFailed');
  }

  private fail<T>(
    message: string,
    errorCode: string,
    diagnostics?: Record<string, unknown>,
  ): CppJLinkResult<T> {
    return {
      ok: false,
      message,
      errorCode,
      targetState: 'Error',
      elapsedMs: 0,
      ...(diagnostics ? { diagnostics } : {}),
    };
  }
}
