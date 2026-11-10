import * as fs from 'fs';
import * as path from 'path';

const LOG_DIR = path.resolve(__dirname, '..', 'outputs', 'Log');

type LogCategory = 'step' | 'eval' | 'dll' | 'dap';

export interface LoggerOptions {
  enabled?: boolean;
  clearOnStart?: boolean;
}

const logFiles: Record<LogCategory, string> = {
  step: path.join(LOG_DIR, 'step.log'),
  eval: path.join(LOG_DIR, 'eval.log'),
  dll: path.join(LOG_DIR, 'dll.log'),
  dap: path.join(LOG_DIR, 'dap.log'),
};

let loggingEnabled = true;
let clearOnStart = true;
let configured = false;

function ensureLogDirectory() {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch {}
}

function clearLogFiles() {
  for (const f of Object.values(logFiles)) {
    try { fs.writeFileSync(f, ''); } catch {}
  }
}

export function configureLogger(options: LoggerOptions = {}) {
  if (options.enabled !== undefined) loggingEnabled = options.enabled;
  if (options.clearOnStart !== undefined) clearOnStart = options.clearOnStart;

  if (!configured) {
    ensureLogDirectory();
    if (clearOnStart) clearLogFiles();
    configured = true;
  }
}

function write(cat: LogCategory, tag: string, msg: string, persist = false) {
  if (!configured) configureLogger();
  if (!loggingEnabled) return;
  ensureLogDirectory();
  const timestamp = new Date().toISOString();
  const line = timestamp.slice(11, 23) + ' [' + tag + '] ' + msg + '\n';
  try { fs.appendFileSync(logFiles[cat], line); } catch {}
  if (persist) {
    try { fs.appendFileSync(path.join(LOG_DIR, `${cat}-history.log`), `${timestamp} [${tag}] ${msg}\n`); } catch {}
  }
  process.stderr.write(line);
}

export const log = {
  step: (msg: string) => write('step', 'Step', msg),
  eval: (msg: string) => write('eval', 'Eval', msg),
  dll: (msg: string, options?: { persist?: boolean }) => write('dll', 'DLL', msg, options?.persist),
  dap: (msg: string) => write('dap', 'DAP', msg),
};
