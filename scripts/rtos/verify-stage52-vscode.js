'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { runTests } = require('@vscode/test-electron');

const workspaceRoot = path.resolve(__dirname, '../..');
const outRoot = path.resolve(
  process.argv.find(arg => arg.startsWith('--output='))?.slice(9)
  || path.join(workspaceRoot, 'out/rtos-stage5/acceptance-5.2/vscode-ui'),
);
const hostTmp = path.join(outRoot, '.vscode-host-tmp');
const workspace = path.join(hostTmp, 'workspace');
const userData = path.join(hostTmp, 'user-data');
const extensionsDir = path.join(hostTmp, 'extensions');
const archivesCopyRoot = path.join(outRoot, 'archives-copy');
const cachedTestCode = path.join(workspaceRoot, '.vscode-test', 'vscode-win32-x64-archive-1.134.0', 'Code.exe');
const executable = process.env.ORBIT_VSCODE_EXECUTABLE
  || (fs.existsSync(cachedTestCode)
    ? cachedTestCode
    : path.join(process.env.LOCALAPPDATA, 'Programs/Microsoft VS Code/Code.exe'));

function copyReadOnlyArchives() {
  const copied = { h723: {} };
  const files = ['manifest.json', 'raw.otbin', 'data.otd', 'journal.otj', 'index.otidx', 'index-spill.otidx'];

  const copyOne = (group, key, srcDir) => {
    if (!srcDir || !fs.existsSync(srcDir)) return;
    const dstDir = path.join(archivesCopyRoot, key);
    fs.mkdirSync(dstDir, { recursive: true });
    for (const f of files) {
      const srcFile = path.join(srcDir, f);
      if (fs.existsSync(srcFile)) {
        fs.copyFileSync(srcFile, path.join(dstDir, f));
      }
    }
    if (group === 'h723') copied.h723[key] = dstDir;
    else copied[key] = dstDir;
  };

  const summaryPath = path.join(workspaceRoot, 'out/rtos-stage4/acceptance-4.4/codex-r4-acceptance-summary.json');
  if (fs.existsSync(summaryPath)) {
    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    for (const [key, info] of Object.entries(summary.hardware || {})) {
      copyOne('h723', `r4-${key}`, info && info.recordingDir);
    }
  }

  const r45CopyPath = path.join(workspaceRoot, 'out/rtos-stage4/acceptance-4.5/codex-stage45-saved-copy.json');
  if (fs.existsSync(r45CopyPath)) {
    const r45 = JSON.parse(fs.readFileSync(r45CopyPath, 'utf8'));
    copyOne('h723', 'r45-saved-copy', r45 && r45.copy);
  }

  const oracleArchiveDir = path.join(workspaceRoot, 'out/rtos-stage5/acceptance-5.2/codex-events-archive-eugWS8');
  if (fs.existsSync(oracleArchiveDir)) {
    copyOne('single', 'codexOracleArchive', oracleArchiveDir);
  }

  const millionExpPath = path.join(workspaceRoot, 'out/rtos-stage5/acceptance-5.2/codex-events-million-expectations.json');
  if (fs.existsSync(millionExpPath)) {
    const millionExp = JSON.parse(fs.readFileSync(millionExpPath, 'utf8'));
    if (millionExp && millionExp.recordingDir && fs.existsSync(millionExp.recordingDir)) {
      copyOne('single', 'codexMillionArchive', millionExp.recordingDir);
      copied.codexMillionExpectations = millionExp;
    }
  }

  const h723StartStopPath = path.join(workspaceRoot, 'out/rtos-stage5/acceptance-5.2/codex-h723-host-start-stopped.json');
  if (fs.existsSync(h723StartStopPath)) {
    const entries = JSON.parse(fs.readFileSync(h723StartStopPath, 'utf8'));
    const completed = Array.isArray(entries)
      ? [...entries].reverse().find(e => e && (e.state === 'stopped' || e.state === 'completed') && e.recordingDir && fs.existsSync(e.recordingDir))
      : null;
    if (completed) {
      copyOne('single', 'h723TerminalReadyArchive', completed.recordingDir);
    }
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

  const copiedArchives = copyReadOnlyArchives();
  const reportPath = path.join(outRoot, 'vscode-ui-report.json');
  process.env.ORBIT_RTOS_STAGE52_REPORT = reportPath;
  process.env.ORBIT_RTOS_STAGE52_ARCHIVES = JSON.stringify(copiedArchives);

  await runTests({
    vscodeExecutablePath: executable,
    extensionDevelopmentPath: workspaceRoot,
    extensionTestsPath: path.join(__dirname, 'vscode-stage52-driver.js'),
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
  console.log('[stage5.2-vscode] PASSED:', JSON.stringify(report, null, 2));
}

main().catch(err => {
  console.error('[stage5.2-vscode] FAILED:', err);
  process.exitCode = 1;
});
