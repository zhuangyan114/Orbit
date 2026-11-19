'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { runTests } = require('@vscode/test-electron');

const workspaceRoot = path.resolve(__dirname, '../..');
const outRoot = path.resolve(
  process.argv.find(arg => arg.startsWith('--output='))?.slice(9)
  || path.join(workspaceRoot, 'out/rtos-stage4/acceptance-4.5'),
);
const hostTmp = path.join(outRoot, '.vscode-host-tmp');
const workspace = path.join(hostTmp, 'workspace');
const userData = path.join(hostTmp, 'user-data');
const extensionsDir = path.join(hostTmp, 'extensions');
const archivesCopyRoot = path.join(outRoot, 'h723-archives-copy');
const cachedTestCode = path.join(workspaceRoot, '.vscode-test', 'vscode-win32-x64-archive-1.134.0', 'Code.exe');
const executable = process.env.ORBIT_VSCODE_EXECUTABLE
  || (fs.existsSync(cachedTestCode)
    ? cachedTestCode
    : path.join(process.env.LOCALAPPDATA, 'Programs/Microsoft VS Code/Code.exe'));

function copyReadOnlyH723Archives() {
  const summaryPath = path.join(workspaceRoot, 'out/rtos-stage4/acceptance-4.4/codex-r4-acceptance-summary.json');
  if (!fs.existsSync(summaryPath)) return {};
  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  const copied = {};
  const files = ['manifest.json', 'raw.otbin', 'data.otd', 'journal.otj', 'index.otidx', 'index-spill.otidx'];

  for (const [key, info] of Object.entries(summary.hardware || {})) {
    const srcDir = info && info.recordingDir;
    if (!srcDir || !fs.existsSync(srcDir)) continue;
    const dstDir = path.join(archivesCopyRoot, key);
    fs.mkdirSync(dstDir, { recursive: true });
    for (const f of files) {
      const srcFile = path.join(srcDir, f);
      if (fs.existsSync(srcFile)) {
        fs.copyFileSync(srcFile, path.join(dstDir, f));
      }
    }
    copied[key] = dstDir;
  }
  return copied;
}

async function main() {
  fs.rmSync(hostTmp, { recursive: true, force: true });
  fs.rmSync(archivesCopyRoot, { recursive: true, force: true });
  fs.mkdirSync(path.join(workspace, '.vscode'), { recursive: true });
  fs.mkdirSync(extensionsDir, { recursive: true });
  fs.writeFileSync(path.join(workspace, '.vscode', 'settings.json'), JSON.stringify({
    'security.workspace.trust.enabled': false,
    'orbit.logging.enabled': false,
    'orbit.logging.clearOnStart': false,
    'workbench.colorTheme': 'Default Dark Modern',
  }, null, 2));

  const copiedArchives = copyReadOnlyH723Archives();
  const reportPath = path.join(outRoot, 'vscode-ui-report.json');
  process.env.ORBIT_RTOS_STAGE45_REPORT = reportPath;
  process.env.ORBIT_RTOS_STAGE45_ARCHIVES = JSON.stringify(copiedArchives);

  await runTests({
    vscodeExecutablePath: executable,
    extensionDevelopmentPath: workspaceRoot,
    extensionTestsPath: path.join(__dirname, 'vscode-stage45-driver.js'),
    launchArgs: [
      workspace,
      '--user-data-dir', userData,
      '--extensions-dir', extensionsDir,
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
    ],
  });

  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  fs.rmSync(hostTmp, { recursive: true, force: true });
  fs.rmSync(archivesCopyRoot, { recursive: true, force: true });
  console.log('[stage4.5-vscode] PASSED:', JSON.stringify(report, null, 2));
}

main().catch(err => {
  console.error('[stage4.5-vscode] FAILED:', err);
  process.exitCode = 1;
});
