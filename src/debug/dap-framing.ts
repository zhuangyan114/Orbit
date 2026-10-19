/** DAP Content-Length counts UTF-8 bytes, including across pipe chunk boundaries. */
export class DapFrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): string[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages: string[] = [];

    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) break;
      const header = this.buffer.subarray(0, headerEnd).toString('ascii');
      const match = /^Content-Length: (\d+)$/im.exec(header);
      const contentLength = match ? Number(match[1]) : NaN;
      if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
        throw new Error('Invalid DAP Content-Length header');
      }
      const bodyStart = headerEnd + 4;
      if (this.buffer.length - bodyStart < contentLength) break;

      messages.push(this.buffer.subarray(bodyStart, bodyStart + contentLength).toString('utf8'));
      this.buffer = this.buffer.subarray(bodyStart + contentLength);
    }

    return messages;
  }
}
