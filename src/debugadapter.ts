import { OzoneBackend } from './ozone-backend/commander';
import { DapSession, DebugProtocolMessage } from './debug/dap-session';
import { ExperimentalCppJLinkChannel } from './ozone-backend/cpp-jlink-channel';
import { LegacyJLinkTargetChannel, SessionTargetSelector } from './ozone-backend/session-target-channel';
import { log } from './utils/logger';

try {
  const target = new SessionTargetSelector(
    () => new ExperimentalCppJLinkChannel({
      onDiagnostic: message => {
        if (message.startsWith('[cpp-jlink stderr]')) log.dll(message);
        else log.dap(message);
      },
    }),
    () => new LegacyJLinkTargetChannel(),
  );
  const backend = new OzoneBackend(target, target);
  const session = new DapSession(backend);
  let disposed = false;
  const disposeSession = () => {
    if (disposed) return;
    disposed = true;
    session.dispose();
  };

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
  process.stdin.on('end', disposeSession);

  session.on('send', (message: DebugProtocolMessage) => {
    const body = JSON.stringify(message);
    const header = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n`;
    process.stdout.write(header + body, 'utf8');
  });

  process.on('unhandledRejection', () => process.exit(1));

  process.on('SIGINT', () => { disposeSession(); process.exit(0); });
  process.on('SIGTERM', () => { disposeSession(); process.exit(0); });
  process.on('exit', disposeSession);
} catch {
  process.exit(1);
}
