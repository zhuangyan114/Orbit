'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { runTests } = require('@vscode/test-electron');
if (!['--hardware', '--authorize-target-control', '--authorize-flash'].every(flag => process.argv.includes(flag))) {
  console.error('Requires --hardware --authorize-target-control --authorize-flash; uses the connected H723 benchmark board.');
  process.exit(2);
}
const workspace = path.resolve(__dirname, '../..');
const root = path.resolve(process.argv.find(arg => arg.startsWith('--output='))?.slice(9) || path.join(workspace, 'out/rtos-stage1/hardware'));
if (fs.existsSync(path.join(root, 'ready.json'))) throw new Error('Use a new evidence directory for each test host');
fs.mkdirSync(path.join(root, 'workspace/.vscode'), { recursive: true });
fs.writeFileSync(path.join(root, 'workspace/.vscode/settings.json'), JSON.stringify({ 'security.workspace.trust.enabled': false, 'orbit.logging.clearOnStart': false }));
process.env.ORBIT_RTOS_HARDWARE_AUTHORIZED = 'yes';
process.env.ORBIT_RTOS_HARDWARE_DIR = root;
const executable = process.env.ORBIT_VSCODE_EXECUTABLE || path.join(process.env.LOCALAPPDATA, 'Programs/Microsoft VS Code/Code.exe');
runTests({ vscodeExecutablePath: executable, extensionDevelopmentPath: workspace,
  extensionTestsPath: path.join(__dirname, 'vscode-hardware-driver.js'),
  launchArgs: [path.join(root, 'workspace'), '--user-data-dir', path.join(root, 'user-data'), '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes'] })
  .catch(error => { console.error(error); process.exitCode = 1; });
