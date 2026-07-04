import { OzoneBackend } from './ozone-backend/commander';
import { DapSession, DebugProtocolMessage } from './debug/dap-session';

try {
  const backend = new OzoneBackend();
  const session = new DapSession(backend);

  let buffer = '';

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    while (true) {
      const headerMatch = buffer.match(/^Content-Length: (\d+)\r\n\r\n/);
      if (!headerMatch) break;

      const contentLength = parseInt(headerMatch[1], 10);
      const headerEnd = headerMatch[0].length;
      if (buffer.length < headerEnd + contentLength) break;

      const bodyStr = buffer.substring(headerEnd, headerEnd + contentLength);
      buffer = buffer.substring(headerEnd + contentLength);

      try {
        const message: DebugProtocolMessage = JSON.parse(bodyStr);
        session.handleMessage(message);
      } catch {}
    }
  });

  session.on('send', (message: DebugProtocolMessage) => {
    const body = JSON.stringify(message);
    const header = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n`;
    process.stdout.write(header + body, 'utf8');
  });

  process.on('unhandledRejection', () => process.exit(1));

  process.on('exit', () => session.dispose());
} catch {
  process.exit(1);
}