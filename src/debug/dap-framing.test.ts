import { describe, expect, it } from 'vitest';
import { DapFrameDecoder } from './dap-framing';

// The sender independently encodes the wire format in bytes.
function frame(body: string): Buffer {
  const payload = Buffer.from(body, 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, 'ascii'), payload]);
}

describe('DAP UTF-8 framing', () => {
  const body = JSON.stringify({
    seq: 2,
    type: 'request',
    command: 'launch',
    arguments: { name: 'Orbit RMLink 无线', program: 'D:/项目/固件😀.elf' },
  });

  it('decodes a complete Chinese launch request without waiting for another request', () => {
    expect(new DapFrameDecoder().push(frame(body))).toEqual([body]);
  });

  it('preserves Unicode at every possible header/body split, including inside UTF-8 characters', () => {
    const wire = frame(body);
    for (let split = 1; split < wire.length; split++) {
      const decoder = new DapFrameDecoder();
      expect(decoder.push(wire.subarray(0, split))).toEqual([]);
      expect(decoder.push(wire.subarray(split))).toEqual([body]);
    }
  });

  it('handles byte-at-a-time input', () => {
    const decoder = new DapFrameDecoder();
    const messages: string[] = [];
    for (const byte of frame(body)) messages.push(...decoder.push(Buffer.from([byte])));
    expect(messages).toEqual([body]);
  });

  it('keeps coalesced ASCII and Unicode messages separate and retains a partial next frame', () => {
    const decoder = new DapFrameDecoder();
    const initialize = '{"seq":1,"type":"request","command":"initialize"}';
    const configurationDone = frame('{"seq":3,"type":"request","command":"configurationDone"}');
    expect(decoder.push(Buffer.concat([frame(initialize), frame(body), configurationDone.subarray(0, 12)])))
      .toEqual([initialize, body]);
    expect(decoder.push(configurationDone.subarray(12)))
      .toEqual(['{"seq":3,"type":"request","command":"configurationDone"}']);
  });

  it('accepts an additional header without counting it as body data', () => {
    expect(new DapFrameDecoder().push(Buffer.from('Content-Length: 2\r\nContent-Type: application/json\r\n\r\n{}')))
      .toEqual(['{}']);
  });

  it.each(['Missing-Length: 2', 'Content-Length: -1', 'Content-Length: NaN', 'Content-Length: 9007199254740992'])(
    'reports an invalid header: %s', header => {
      expect(() => new DapFrameDecoder().push(Buffer.from(`${header}\r\n\r\n{}`)))
        .toThrow('Invalid DAP Content-Length header');
    },
  );
});
