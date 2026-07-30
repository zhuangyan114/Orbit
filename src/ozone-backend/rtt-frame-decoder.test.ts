import { describe, expect, it } from 'vitest';
import {
  RTTB_CHECKSUM_OFFSET,
  RTTB_FRAME_SIZE,
  RTTB_PAYLOAD_SIZE,
  RttFrameDecoder,
  fnv1a,
} from './rtt-frame-decoder';

function frame(sequence: number, tick = sequence): Uint8Array {
  const bytes = new Uint8Array(RTTB_FRAME_SIZE);
  bytes.set([0x52, 0x54, 0x54, 0x42]);
  const view = new DataView(bytes.buffer);
  view.setUint16(4, 1, true);
  view.setUint16(6, RTTB_FRAME_SIZE, true);
  view.setUint32(8, sequence >>> 0, true);
  view.setUint32(12, tick >>> 0, true);
  for (let index = 16; index < RTTB_CHECKSUM_OFFSET; index++) {
    bytes[index] = (index + sequence) & 0xFF;
  }
  view.setUint32(RTTB_CHECKSUM_OFFSET, fnv1a(bytes.subarray(0, RTTB_CHECKSUM_OFFSET)), true);
  return bytes;
}

describe('RttFrameDecoder', () => {
  it('decodes a split header and split frame without emitting a partial sample', () => {
    const decoder = new RttFrameDecoder();
    const bytes = frame(7, 1234);

    expect(decoder.feed(bytes.subarray(0, 3))).toMatchObject({
      frames: [],
      errors: [],
      bufferedBytes: 3,
    });
    expect(decoder.feed(bytes.subarray(3, 16))).toMatchObject({
      frames: [],
      errors: [],
      bufferedBytes: 16,
    });
    const result = decoder.feed(bytes.subarray(16));
    expect(result.errors).toEqual([]);
    expect(result.frames).toHaveLength(1);
    expect(result.frames[0]).toMatchObject({
      version: 1,
      frameSize: RTTB_FRAME_SIZE,
      sequence: 7,
      tick: 1234,
    });
    expect(result.frames[0].payload).toEqual(bytes.slice(16, 60));
    expect(result.frames[0].payload).toHaveLength(RTTB_PAYLOAD_SIZE);
    expect(decoder.bufferedBytes).toBe(0);
  });

  it('decodes multiple frames and reports forward sequence gaps', () => {
    const decoder = new RttFrameDecoder();
    const input = new Uint8Array([...frame(10), ...frame(12)]);
    const result = decoder.feed(input);

    expect(result.frames.map(item => item.sequence)).toEqual([10, 12]);
    expect(result.sequenceGaps).toEqual([{
      previousSequence: 10,
      expectedSequence: 11,
      actualSequence: 12,
      missingFrames: 1,
      outOfOrder: false,
    }]);
  });

  it('resynchronizes after invalid magic, version, size, and checksum', () => {
    const invalidVersion = frame(1);
    new DataView(invalidVersion.buffer).setUint16(4, 2, true);
    const invalidSize = frame(2);
    new DataView(invalidSize.buffer).setUint16(6, 63, true);
    const invalidChecksum = frame(3);
    invalidChecksum[20] ^= 0xFF;
    const valid = frame(4);
    const decoder = new RttFrameDecoder();

    const result = decoder.feed(new Uint8Array([
      0x00, 0x01, 0x02,
      ...invalidVersion,
      ...invalidSize,
      ...invalidChecksum,
      ...valid,
    ]));

    expect(result.frames.map(item => item.sequence)).toEqual([4]);
    expect(result.errors.map(error => error.code)).toEqual(expect.arrayContaining([
      'invalid-magic',
      'invalid-version',
      'invalid-size',
      'checksum-mismatch',
    ]));
  });

  it('reports truncated bytes with the stream end reason and resets cleanly', () => {
    const decoder = new RttFrameDecoder();
    decoder.feed(frame(1).subarray(0, 20));
    const ended = decoder.finish('owner-lost');

    expect(ended.errors).toEqual([expect.objectContaining({
      code: 'truncated-frame',
      receivedBytes: 20,
      endReason: 'owner-lost',
    })]);
    expect(decoder.bufferedBytes).toBe(0);
    decoder.reset();
    expect(decoder.feed(frame(0)).frames[0].sequence).toBe(0);
  });

  it('handles empty reads and unsigned sequence wraparound', () => {
    const decoder = new RttFrameDecoder();
    expect(decoder.feed(new Uint8Array())).toMatchObject({ frames: [], errors: [], bufferedBytes: 0 });
    expect(decoder.feed(new Uint8Array([...frame(0xFFFFFFFF), ...frame(0)])).sequenceGaps).toEqual([]);
  });

  it('reports backward sequence movement as out-of-order without inflating missing frames', () => {
    const decoder = new RttFrameDecoder();
    const result = decoder.feed(new Uint8Array([...frame(100), ...frame(99)]));

    expect(result.sequenceGaps).toEqual([{
      previousSequence: 100,
      expectedSequence: 101,
      actualSequence: 99,
      missingFrames: 0,
      outOfOrder: true,
    }]);
  });
});
