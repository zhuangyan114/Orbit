// File-queue driver for one live orbit-automation-session process.
// Reads inbox.jsonl, writes one result per command to outbox.jsonl.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const DIR = path.join(process.env.TEMP || '.', 'orbit-session-drive');
const INBOX = path.join(DIR, 'inbox.jsonl');
const OUTBOX = path.join(DIR, 'outbox.jsonl');
const SESSION_JS = path.join(__dirname, '..', '..', 'clients', 'node', 'dist', 'session.js');
const INSTANCE = process.argv.includes('--instance')
  ? process.argv[process.argv.indexOf('--instance') + 1]
  : '013889aa-edff-44b1-b830-92db77d1e7cb';

fs.mkdirSync(DIR, { recursive: true });
fs.writeFileSync(INBOX, '');
fs.writeFileSync(OUTBOX, '');

const session = spawn(process.execPath, [SESSION_JS, '--instance', INSTANCE], {
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});
fs.writeFileSync(path.join(DIR, 'pid'), String(session.pid));

let stdoutBuf = '';
const pending = [];
function nextLine(timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for session line')), timeoutMs);
    pending.push(line => {
      clearTimeout(timer);
      resolve(line);
    });
  });
}

session.stdout.setEncoding('utf8');
session.stderr.setEncoding('utf8');
session.stdout.on('data', chunk => {
  stdoutBuf += chunk;
  const parts = stdoutBuf.split(/\r?\n/);
  stdoutBuf = parts.pop() ?? '';
  for (const raw of parts) {
    if (!raw) continue;
    let line;
    try { line = JSON.parse(raw); } catch { line = { raw }; }
    if (pending.length) pending.shift()(line);
    else fs.appendFileSync(OUTBOX, `${JSON.stringify(line)}\n`);
  }
});
session.stderr.on('data', chunk => {
  fs.appendFileSync(path.join(DIR, 'stderr.log'), chunk);
});
session.on('exit', (code, signal) => {
  fs.appendFileSync(OUTBOX, `${JSON.stringify({ event: 'exit', code, signal })}\n`);
  process.exit(code ?? 1);
});

async function main() {
  const ready = await nextLine();
  fs.appendFileSync(OUTBOX, `${JSON.stringify({ step: 'ready', result: ready })}\n`);
  let offset = 0;
  for (;;) {
    await new Promise(resolve => setTimeout(resolve, 80));
    if (!fs.existsSync(INBOX)) continue;
    const text = fs.readFileSync(INBOX, 'utf8');
    if (text.length <= offset) continue;
    const chunk = text.slice(offset);
    const lines = chunk.split(/\r?\n/);
    if (!chunk.endsWith('\n')) {
      lines.pop();
    } else {
      offset = text.length;
    }
    if (!chunk.endsWith('\n')) offset = text.length - (lines.at(-1)?.length ?? 0);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const command = JSON.parse(trimmed);
      session.stdin.write(`${JSON.stringify(command)}\n`);
      const result = await nextLine();
      fs.appendFileSync(OUTBOX, `${JSON.stringify({ step: command.command, result })}\n`);
      if (['quit', 'exit', 'close'].includes(command.command)) {
        session.stdin.end();
        return;
      }
    }
  }
}

void main().catch(error => {
  fs.appendFileSync(OUTBOX, `${JSON.stringify({ step: 'driver-error', error: error.message })}\n`);
  process.exit(1);
});
