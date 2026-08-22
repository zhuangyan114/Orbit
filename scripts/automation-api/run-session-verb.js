const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const sessionJs = path.join(__dirname, '..', '..', 'clients', 'node', 'dist', 'session.js');
const argv = process.argv.slice(2);
const args = [sessionJs];
for (const token of argv) {
  if (token.startsWith('@')) {
    args.push('--params', fs.readFileSync(token.slice(1), 'utf8').trim());
  } else {
    args.push(token);
  }
}
const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.status ?? 1);
