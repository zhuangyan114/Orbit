// Stepwise driver for orbit-automation-session (one NDJSON command per call).
//
//   node scripts/automation-api/hw-session-step.js start [--instance ID]
//   node scripts/automation-api/hw-session-step.js send '{"command":"status"}'
//   node scripts/automation-api/hw-session-step.js quit

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

const STATE_DIR = path.join(process.env.TEMP || process.env.TMP || '.', 'orbit-session-drive');
const PORT_FILE = path.join(STATE_DIR, 'port');
const LOG_FILE = path.join(STATE_DIR, 'session.log');
const SESSION_JS = path.join(__dirname, '..', '..', 'clients', 'node', 'dist', 'session.js');
const DEFAULT_INSTANCE = '013889aa-edff-44b1-b830-92db77d1e7cb';

function die(message) {
  console.error(message);
  process.exit(1);
}

function readPort() {
  if (!fs.existsSync(PORT_FILE)) die(`session driver is not running (${PORT_FILE} missing)`);
  return Number(fs.readFileSync(PORT_FILE, 'utf8').trim());
}

function request(payload) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: readPort() });
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on('data', chunk => { buffer += chunk; });
    socket.on('end', () => {
      try {
        resolve(JSON.parse(buffer));
      } catch (error) {
        reject(new Error(`invalid driver reply: ${buffer} (${error.message})`));
      }
    });
    socket.on('error', reject);
  });
}

async function startDriver() {
  if (fs.existsSync(PORT_FILE)) {
    try {
      await request({ op: 'ping' });
      console.log(JSON.stringify({ ok: true, alreadyRunning: true }));
      return;
    } catch {
      // stale state; replace
    }
  }
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const instanceIndex = process.argv.indexOf('--instance');
  const instance = instanceIndex >= 0 ? process.argv[instanceIndex + 1] : DEFAULT_INSTANCE;
  const log = fs.openSync(LOG_FILE, 'w');
  const child = spawn(process.execPath, [__filename, '--serve', '--instance', instance], {
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true,
  });
  child.unref();
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (fs.existsSync(PORT_FILE)) {
      try {
        const ready = await request({ op: 'ready' });
        console.log(JSON.stringify(ready, null, 2));
        return;
      } catch {
        // still starting
      }
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  die(`session driver failed to start; see ${LOG_FILE}`);
}

function serve() {
  const instanceIndex = process.argv.indexOf('--instance');
  const instance = instanceIndex >= 0 ? process.argv[instanceIndex + 1] : DEFAULT_INSTANCE;
  const session = spawn(process.execPath, [SESSION_JS, '--instance', instance], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdoutBuf = '';
  let stderrBuf = '';
  const lines = [];
  const waiters = [];
  session.stdout.setEncoding('utf8');
  session.stderr.setEncoding('utf8');
  session.stdout.on('data', chunk => {
    stdoutBuf += chunk;
    const parts = stdoutBuf.split(/\r?\n/);
    stdoutBuf = parts.pop() ?? '';
    for (const line of parts) {
      if (!line) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        parsed = { raw: line };
      }
      if (waiters.length > 0) waiters.shift()(parsed);
      else lines.push(parsed);
    }
  });
  session.stderr.on('data', chunk => { stderrBuf += chunk; });

  function nextLine(timeoutMs = 30000) {
    if (lines.length > 0) return Promise.resolve(lines.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = waiters.indexOf(resolveWrapped);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error(`timeout waiting for session line; stderr=${stderrBuf}`));
      }, timeoutMs);
      const resolveWrapped = value => {
        clearTimeout(timer);
        resolve(value);
      };
      waiters.push(resolveWrapped);
    });
  }

  const server = net.createServer(socket => {
    let buf = '';
    socket.setEncoding('utf8');
    const reply = body => {
      if (!socket.destroyed && socket.writable) socket.end(`${JSON.stringify(body)}\n`);
    };
    socket.on('data', async chunk => {
      buf += chunk;
      const newline = buf.indexOf('\n');
      if (newline < 0) return;
      const raw = buf.slice(0, newline);
      buf = buf.slice(newline + 1);
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch (error) {
        reply({ ok: false, error: error.message });
        return;
      }
      try {
        if (payload.op === 'ping') {
          reply({ ok: true, pong: true });
          return;
        }
        if (payload.op === 'ready') {
          reply({ ok: true, ready: lastReady, pid: session.pid });
          return;
        }
        if (payload.op === 'send') {
          session.stdin.write(`${JSON.stringify(payload.command)}\n`);
          reply({ ok: true, result: await nextLine() });
          return;
        }
        if (payload.op === 'quit') {
          session.stdin.write(`${JSON.stringify({ command: 'quit' })}\n`);
          const result = await nextLine();
          reply({ ok: true, result });
          server.close();
          try { fs.unlinkSync(PORT_FILE); } catch { /* ignore */ }
          session.stdin.end();
          return;
        }
        reply({ ok: false, error: `unknown op ${payload.op}` });
      } catch (error) {
        reply({ ok: false, error: error.message });
      }
    });
  });

  let lastReady;
  server.listen(0, '127.0.0.1', async () => {
    const address = server.address();
    fs.writeFileSync(PORT_FILE, String(address.port), 'utf8');
    try {
      lastReady = await nextLine();
    } catch (error) {
      lastReady = { ok: false, error: error.message };
    }
  });
}

async function main() {
  const verb = process.argv[2];
  if (verb === '--serve') {
    serve();
    return;
  }
  if (verb === 'start') {
    await startDriver();
    return;
  }
  if (verb === 'send') {
    const raw = process.argv[3];
    if (!raw) die('usage: hw-session-step.js send \'<json>\'');
    const command = JSON.parse(raw);
    const reply = await request({ op: 'send', command });
    console.log(JSON.stringify(reply, null, 2));
    if (!reply.ok || reply.result?.ok === false) process.exitCode = 1;
    return;
  }
  if (verb === 'quit') {
    const reply = await request({ op: 'quit' });
    console.log(JSON.stringify(reply, null, 2));
    return;
  }
  die('usage: hw-session-step.js start|send|quit');
}

void main();
