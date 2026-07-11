import * as fs from 'fs';
import * as path from 'path';

const LOG_DIR = path.resolve(__dirname, '..', 'outputs', 'Log');

try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
} catch {}

type LogCategory = 'step' | 'eval' | 'dll' | 'dap';

const logFiles: Record<LogCategory, string> = {
  step: path.join(LOG_DIR, 'step.log'),
  eval: path.join(LOG_DIR, 'eval.log'),
  dll: path.join(LOG_DIR, 'dll.log'),
  dap: path.join(LOG_DIR, 'dap.log'),
};

for (const f of Object.values(logFiles)) {
  try { fs.writeFileSync(f, ''); } catch {}
}

const enabled: Record<LogCategory, boolean> = {
  step: true,
  eval: true,
  dll: true,
  dap: true,
};

function write(cat: LogCategory, tag: string, msg: string) {
  if (!enabled[cat]) return;
  const line = new Date().toISOString().slice(11, 23) + ' [' + tag + '] ' + msg + '\n';
  try { fs.appendFileSync(logFiles[cat], line); } catch {}
  process.stderr.write(line);
}

export const log = {
  step: (msg: string) => write('step', 'Step', msg),
  eval: (msg: string) => write('eval', 'Eval', msg),
  dll: (msg: string) => write('dll', 'DLL', msg),
  dap: (msg: string) => write('dap', 'DAP', msg),
};
