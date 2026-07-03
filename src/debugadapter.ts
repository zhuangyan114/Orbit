import { OzoneBackend } from './ozone-backend/commander';
import { DapSession, DebugProtocolMessage } from './debug/dap-session';
import * as fs from 'fs';
import * as path from 'path';

console.log = console.error;

const logFile = path.join(__dirname, '..', 'debugadapter.log');
function log(msg: string) {
  try {
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`);
  } catch { }
}

log('debugadapter starting, pid=' + process.pid + ', cwd=' + process.cwd());
log('PATH=' + (process.env.Path || process.env.PATH || 'N/A'));

try {
  const backend = new OzoneBackend();
  log('OzoneBackend created');
  const session = new DapSession(backend);
  log('DapSession created');

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
        log('received: ' + message.command);
        session.handleMessage(message);
      } catch (err: any) {
        log('parse error: ' + err.message);
      }
    }
  });

  session.on('send', (message: DebugProtocolMessage) => {
    log('sending: ' + (message.type === 'response' ? 'response(' + message.command + ')' : message.event));
    const body = JSON.stringify(message);
    const header = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n`;
    process.stdout.write(header + body, 'utf8');
  });

  process.on('uncaughtException', (err: Error) => {
    log('UNCAUGHT: ' + err.message + '\n' + (err.stack || ''));
    process.exit(1);
  });

  process.on('unhandledRejection', (reason: any) => {
    log('UNHANDLED REJECTION: ' + (reason?.stack || reason?.message || reason));
    process.exit(1);
  });

  process.on('exit', (code) => {
    log('exit code=' + code);
    session.dispose();
  });

  log('ready');
} catch (err: any) {
  log('FATAL: ' + err.message + '\n' + (err.stack || ''));
  process.exit(1);
}