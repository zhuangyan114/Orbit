import { OzoneBackend } from './ozone-backend/commander';
import { DapSession, DebugProtocolMessage } from './debug/dap-session';
import { ExperimentalCppJLinkChannel } from './ozone-backend/cpp-jlink-channel';
import { CmsisDapTargetChannel, LegacyJLinkTargetChannel, SessionTargetSelector } from './ozone-backend/session-target-channel';
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
    () => new CmsisDapTargetChannel({
      onDiagnostic: message => log.dll(message),
    }),
  );
  const backend = new OzoneBackend(target, target);
  const session = new DapSession(backend);
  let disposePromise: Promise<void> | null = null;
  let exitPromise: Promise<void> | null = null;
  const disposeSession = () => {
    if (!disposePromise) disposePromise = session.dispose();
    return disposePromise;
  };
  const exitAfterCleanup = (code: number) => {
    if (exitPromise) return exitPromise;
    exitPromise = (async () => {
      await disposeSession();
      await new Promise<void>(resolve => process.stdout.write('', () => resolve()));
      process.exit(code);
    })();
    return exitPromise;
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
  process.stdin.on('end', () => { void exitAfterCleanup(0); });

  session.on('send', (message: DebugProtocolMessage) => {
    const body = JSON.stringify(message);
    const header = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n`;
    process.stdout.write(header + body, 'utf8');
  });
  session.on('shutdownRequested', () => { void exitAfterCleanup(0); });

  process.on('unhandledRejection', reason => {
    log.dap(`debugadapter unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}`);
    void exitAfterCleanup(1);
  });
  process.on('uncaughtException', error => {
    log.dap(`debugadapter uncaughtException: ${error.message}`);
    void exitAfterCleanup(1);
  });

  process.on('SIGINT', () => { void exitAfterCleanup(0); });
  process.on('SIGTERM', () => { void exitAfterCleanup(0); });
  process.on('exit', () => { void disposeSession(); });
} catch {
  process.exit(1);
}
