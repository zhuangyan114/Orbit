'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
class HardwareClient {
  constructor(root) { this.root = path.resolve(root); this.counter = 0; }
  async send(request, timeoutMs = 180000) {
    const file = `${Date.now()}-${String(++this.counter).padStart(4, '0')}.json`;
    const target = path.join(this.root, 'commands', file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(`${target}.tmp`, JSON.stringify(request)); await fs.rename(`${target}.tmp`, target);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      let result;
      try { result = JSON.parse(await fs.readFile(path.join(this.root, 'results', file), 'utf8')); } catch { await delay(20); continue; }
      if (!result.ok) throw new Error(result.error);
      return result;
    }
    throw new Error(`Hardware driver timeout: ${request.action || request.command}`);
  }
  request(command, args = {}) { return this.send({ command, args }); }
}
module.exports = { HardwareClient, delay };
