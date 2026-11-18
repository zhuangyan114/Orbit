'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { runTests } = require('@vscode/test-electron');

const workspaceRoot = path.resolve(__dirname, '../..');
const root = path.resolve(process.argv.find(arg => arg.startsWith('--output='))?.slice(9) || path.join(workspaceRoot, 'out/rtos-stage2/vscode-ui'));
const workspace = path.join(root, 'workspace');
const userData = path.join(root, 'user-data');
const extensionsDir = path.join(root, 'extensions');
const cachedTestCode = path.join(workspaceRoot, '.vscode-test', 'vscode-win32-x64-archive-1.134.0', 'Code.exe');
const executable = process.env.ORBIT_VSCODE_EXECUTABLE || (fs.existsSync(cachedTestCode) ? cachedTestCode : path.join(process.env.LOCALAPPDATA, 'Programs/Microsoft VS Code/Code.exe'));

async function main() {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(workspace, '.vscode'), { recursive: true });
  fs.mkdirSync(extensionsDir, { recursive: true });
  fs.writeFileSync(path.join(workspace, '.vscode', 'settings.json'), JSON.stringify({
    'security.workspace.trust.enabled': false,
    'orbit.logging.enabled': false,
    'orbit.logging.clearOnStart': false,
    'workbench.colorTheme': 'Default Dark Modern',
  }, null, 2));

  process.env.ORBIT_RTOS_STAGE2_REPORT = path.join(root, 'report.json');
  await runTests({
    vscodeExecutablePath: executable,
    extensionDevelopmentPath: workspaceRoot,
    extensionTestsPath: path.join(__dirname, 'vscode-stage2-driver.js'),
    launchArgs: [workspace, '--user-data-dir', userData, '--extensions-dir', extensionsDir, '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes'],
  });

  const report = JSON.parse(fs.readFileSync(path.join(root, 'report.json'), 'utf8'));
  console.log('[stage2-vscode] PASSED:', JSON.stringify(report, null, 2));
}

main().catch(err => {
  console.error('[stage2-vscode] FAILED:', err);
  process.exitCode = 1;
});
