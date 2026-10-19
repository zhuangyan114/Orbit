import { OzoneBackend } from './ozone-backend/commander';
import { DapSession, DebugProtocolMessage } from './debug/dap-session';
import { createAdapterExit } from './debug/adapter-exit';
import { DapFrameDecoder } from './debug/dap-framing';
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
  const disposeSession = () => {
    if (!disposePromise) disposePromise = Promise.resolve().then(() => session.dispose());
    return disposePromise;
  };
  const exitAfterCleanup = createAdapterExit({
    dispose: () => disposeSession(),
    flushStdout: () => new Promise<void>(resolve => process.stdout.write('', () => resolve())),
    exit: code => process.exit(code),
    log: message => log.dap(message),
  });

  const frames = new DapFrameDecoder();
  process.stdin.on('data', (chunk: Buffer) => {
    try {
      for (const bodyStr of frames.push(chunk)) {
        const message: DebugProtocolMessage = JSON.parse(bodyStr);
        session.handleMessage(message);
      }
    } catch (error) {
      log.dap(`[protocol] invalid input: ${error instanceof Error ? error.message : String(error)}`);
      void exitAfterCleanup(1);
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
