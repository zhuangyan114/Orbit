export const RTTB_MAGIC = new Uint8Array([0x52, 0x54, 0x54, 0x42]); // "RTTB"
export const RTTB_VERSION = 1;
export const RTTB_FRAME_SIZE = 64;
export const RTTB_HEADER_SIZE = 16;
export const RTTB_CHECKSUM_SIZE = 4;
export const RTTB_PAYLOAD_OFFSET = RTTB_HEADER_SIZE;
export const RTTB_PAYLOAD_SIZE = RTTB_FRAME_SIZE - RTTB_HEADER_SIZE - RTTB_CHECKSUM_SIZE;
export const RTTB_CHECKSUM_OFFSET = RTTB_FRAME_SIZE - RTTB_CHECKSUM_SIZE;

export type RttFrameDecodeErrorCode =
  | 'invalid-magic'
  | 'invalid-version'
  | 'invalid-size'
  | 'checksum-mismatch'
  | 'truncated-frame';

export interface RttSampleFrame {
  readonly magic: 'RTTB';
  readonly version: number;
  readonly frameSize: number;
  readonly sequence: number;
  readonly tick: number;
  readonly payload: Uint8Array;
  readonly checksum: number;
}

export interface RttFrameDecodeError {
  readonly code: RttFrameDecodeErrorCode;
  readonly message: string;
  readonly offset?: number;
  readonly discardedBytes?: number;
  readonly receivedBytes?: number;
  readonly expectedBytes?: number;
  readonly version?: number;
  readonly frameSize?: number;
  readonly checksum?: number;
  readonly expectedChecksum?: number;
  readonly endReason?: RttFrameStreamEndReason;
}

export type RttFrameStreamEndReason = 'stream-end' | 'channel-gone' | 'owner-lost' | 'reset';

export interface RttSequenceGap {
  readonly previousSequence: number;
  readonly expectedSequence: number;
  readonly actualSequence: number;
  readonly missingFrames: number;
  readonly outOfOrder: boolean;
}

export interface RttFrameDecodeBatch {
  readonly frames: readonly RttSampleFrame[];
  readonly errors: readonly RttFrameDecodeError[];
  readonly sequenceGaps: readonly RttSequenceGap[];
  readonly bytesConsumed: number;
  readonly bufferedBytes: number;
  readonly decodeLatencyMs: number;
}

export interface RttFrameDecoderOptions {
  readonly clock?: () => number;
  readonly maxFrameSize?: number;
}

/**
 * Incrementally decodes the fixed-width RTTB sample stream emitted by the
 * target-side RTT bench. It owns only byte framing; transport ownership and
 * scheduling stay with RttTransport/RttStreamScheduler.
 */
export class RttFrameDecoder {
  private carry = new Uint8Array();
  private previousSequence: number | null = null;
  private readonly clock: () => number;
  private readonly maxFrameSize: number;

  constructor(options: RttFrameDecoderOptions = {}) {
    this.clock = options.clock || (() => Date.now());
    this.maxFrameSize = options.maxFrameSize || RTTB_FRAME_SIZE;
    if (!Number.isInteger(this.maxFrameSize) || this.maxFrameSize < RTTB_FRAME_SIZE) {
      throw new Error(`RTTB decoder maxFrameSize must be at least ${RTTB_FRAME_SIZE}`);
    }
  }

  get bufferedBytes(): number {
    return this.carry.length;
  }

  get lastSequence(): number | null {
    return this.previousSequence;
  }

  feed(bytes: Uint8Array): RttFrameDecodeBatch {
    const startedAt = this.clock();
    if (bytes.length > 0) {
      const combined = new Uint8Array(this.carry.length + bytes.length);
      combined.set(this.carry);
      combined.set(bytes, this.carry.length);
      this.carry = combined;
    }

    const frames: RttSampleFrame[] = [];
    const errors: RttFrameDecodeError[] = [];
    const sequenceGaps: RttSequenceGap[] = [];
    let bytesConsumed = 0;

    while (this.carry.length > 0) {
      if (this.carry.length < RTTB_MAGIC.length) break;

      if (!hasMagicAt(this.carry, 0)) {
        const nextMagic = findMagic(this.carry);
        if (nextMagic >= 0) {
          errors.push({
            code: 'invalid-magic',
            message: `discarded ${nextMagic} byte(s) before RTTB magic`,
            offset: bytesConsumed,
            discardedBytes: nextMagic,
          });
          this.discard(nextMagic);
          bytesConsumed += nextMagic;
          continue;
        }

        const keep = magicPrefixLength(this.carry);
        const discard = this.carry.length - keep;
        if (discard > 0) {
          errors.push({
            code: 'invalid-magic',
            message: `discarded ${discard} byte(s) while searching for RTTB magic`,
            offset: bytesConsumed,
            discardedBytes: discard,
          });
          this.discard(discard);
          bytesConsumed += discard;
        }
        break;
      }

      if (this.carry.length < RTTB_HEADER_SIZE) break;

      const view = new DataView(this.carry.buffer, this.carry.byteOffset, this.carry.byteLength);
      const version = view.getUint16(4, true);
      const frameSize = view.getUint16(6, true);
      if (version !== RTTB_VERSION) {
        errors.push({
          code: 'invalid-version',
          message: `unsupported RTTB version ${version}`,
          offset: bytesConsumed,
          version,
          frameSize,
        });
        this.discard(1);
        bytesConsumed += 1;
        continue;
      }
      if (frameSize !== RTTB_FRAME_SIZE || frameSize > this.maxFrameSize) {
        errors.push({
          code: 'invalid-size',
          message: `invalid RTTB frame size ${frameSize}; expected ${RTTB_FRAME_SIZE}`,
          offset: bytesConsumed,
          version,
          frameSize,
          expectedBytes: RTTB_FRAME_SIZE,
        });
        this.discard(1);
        bytesConsumed += 1;
        continue;
      }
      if (this.carry.length < frameSize) break;

      const expectedChecksum = fnv1a(this.carry.subarray(0, RTTB_CHECKSUM_OFFSET));
      const checksum = view.getUint32(RTTB_CHECKSUM_OFFSET, true);
      if (checksum !== expectedChecksum) {
        errors.push({
          code: 'checksum-mismatch',
          message: `RTTB checksum mismatch: got 0x${checksum.toString(16)}, expected 0x${expectedChecksum.toString(16)}`,
          offset: bytesConsumed,
          version,
          frameSize,
          checksum,
          expectedChecksum,
        });
        this.discard(1);
        bytesConsumed += 1;
        continue;
      }

      const sequence = view.getUint32(8, true);
      const tick = view.getUint32(12, true);
      const frame: RttSampleFrame = {
        magic: 'RTTB',
        version,
        frameSize,
        sequence,
        tick,
        payload: new Uint8Array(this.carry.slice(RTTB_PAYLOAD_OFFSET, RTTB_CHECKSUM_OFFSET)),
        checksum,
      };
      if (this.previousSequence !== null) {
        const expectedSequence = (this.previousSequence + 1) >>> 0;
        if (sequence !== expectedSequence) {
          const delta = (sequence - expectedSequence) >>> 0;
          sequenceGaps.push({
            previousSequence: this.previousSequence,
            expectedSequence,
            actualSequence: sequence,
            missingFrames: delta < 0x80000000 ? delta : 0,
            outOfOrder: delta >= 0x80000000,
          });
        }
      }
      this.previousSequence = sequence;
      frames.push(frame);
      this.discard(frameSize);
      bytesConsumed += frameSize;
    }

    return {
      frames,
      errors,
      sequenceGaps,
      bytesConsumed,
      bufferedBytes: this.carry.length,
      decodeLatencyMs: Math.max(0, this.clock() - startedAt),
    };
  }

  finish(reason: RttFrameStreamEndReason = 'stream-end'): RttFrameDecodeBatch {
    const startedAt = this.clock();
    const errors: RttFrameDecodeError[] = [];
    if (this.carry.length > 0) {
      errors.push({
        code: 'truncated-frame',
        message: `RTTB stream ended with ${this.carry.length} byte(s) buffered`,
        receivedBytes: this.carry.length,
        expectedBytes: RTTB_FRAME_SIZE,
        endReason: reason,
      });
    }
    const bytesConsumed = this.carry.length;
    this.carry = new Uint8Array();
    return {
      frames: [],
      errors,
      sequenceGaps: [],
      bytesConsumed,
      bufferedBytes: 0,
      decodeLatencyMs: Math.max(0, this.clock() - startedAt),
    };
  }

  reset() {
    this.carry = new Uint8Array();
    this.previousSequence = null;
  }

  private discard(count: number) {
    this.carry = this.carry.slice(Math.max(0, count));
  }
}

export function fnv1a(bytes: Uint8Array): number {
  let hash = 2166136261;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function hasMagicAt(bytes: Uint8Array, offset: number): boolean {
  return offset >= 0
    && offset + RTTB_MAGIC.length <= bytes.length
    && RTTB_MAGIC.every((byte, index) => bytes[offset + index] === byte);
}

function findMagic(bytes: Uint8Array): number {
  for (let index = 1; index <= bytes.length - RTTB_MAGIC.length; index++) {
    if (hasMagicAt(bytes, index)) return index;
  }
  return -1;
}

function magicPrefixLength(bytes: Uint8Array): number {
  for (let length = Math.min(RTTB_MAGIC.length - 1, bytes.length); length > 0; length--) {
    let matches = true;
    for (let index = 0; index < length; index++) {
      if (bytes[bytes.length - length + index] !== RTTB_MAGIC[index]) {
        matches = false;
        break;
      }
    }
    if (matches) return length;
  }
  return 0;
}
