import { describe, expect, it } from 'vitest';
import { RttStreamDiagnostics } from './rtt-stream-diagnostics';

describe('RttStreamDiagnostics frame metrics', () => {
  it('keeps transport and decoder counters separate and exposes decode latency', () => {
    let now = 0;
    const diagnostics = new RttStreamDiagnostics('timeline', 1, () => now);
    diagnostics.recordRead(64, false);
    diagnostics.recordFrameDecode({
      decodedFrames: 1,
      decodeErrors: 2,
      checksumErrors: 1,
      sequenceGaps: 1,
      missingFrames: 3,
      truncatedFrames: 1,
      decodeLatencyMs: 0.5,
    });
    now = 1000;

    expect(diagnostics.snapshot()).toMatchObject({
      bytesRead: 64,
      readCalls: 1,
      decodedFrames: 1,
      decodeErrors: 2,
      checksumErrors: 1,
      sequenceGaps: 1,
      missingFrames: 3,
      truncatedFrames: 1,
      averageDecodeLatencyMs: 0.5,
      maxDecodeLatencyMs: 0.5,
    });
  });
});
