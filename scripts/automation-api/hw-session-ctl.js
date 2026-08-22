const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DIR = path.join(process.env.TEMP || '.', 'orbit-session-drive');
const INBOX = path.join(DIR, 'inbox.jsonl');
const OUTBOX = path.join(DIR, 'outbox.jsonl');
const verb = process.argv[2];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function outboxLines() {
  if (!fs.existsSync(OUTBOX)) return [];
  return fs.readFileSync(OUTBOX, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lines = outboxLines();
    const hit = lines.find(predicate);
    if (hit) return hit;
    await sleep(80);
  }
  throw new Error('timeout');
}

async function main() {
  if (verb === 'boot') {
    fs.mkdirSync(DIR, { recursive: true });
    const log = fs.openSync(path.join(DIR, 'loop.log'), 'w');
    const child = spawn(process.execPath, [
      path.join(__dirname, 'hw-session-loop.js'),
      '--instance',
      process.argv.includes('--instance') ? process.argv[process.argv.indexOf('--instance') + 1] : '013889aa-edff-44b1-b830-92db77d1e7cb',
    ], { detached: true, stdio: ['ignore', log, log], windowsHide: true });
    child.unref();
    const ready = await waitFor(item => item.step === 'ready', 20000);
    console.log(JSON.stringify(ready, null, 2));
    return;
  }
  if (verb === 'send') {
    const command = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
    const before = outboxLines().length;
    fs.appendFileSync(INBOX, `${JSON.stringify(command)}\n`);
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      const lines = outboxLines();
      if (lines.length > before) {
        console.log(JSON.stringify(lines.at(-1), null, 2));
        if (lines.at(-1).result?.ok === false) process.exitCode = 1;
        return;
      }
      await sleep(80);
    }
    throw new Error(`timeout waiting for ${command.command}`);
  }
  throw new Error('usage: hw-session-ctl.js boot|send <file>');
}

void main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
