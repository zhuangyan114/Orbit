'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { runTests } = require('@vscode/test-electron');

const workspaceRoot = path.resolve(__dirname, '../..');
const outRoot = path.resolve(
  process.argv.find(arg => arg.startsWith('--output='))?.slice(9)
  || path.join(workspaceRoot, 'out/rtos-stage5/acceptance-5.3/vscode-ui'),
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

function copyArchiveDir(key, srcDir) {
  if (!srcDir || !fs.existsSync(srcDir)) return null;
  const files = ['manifest.json', 'raw.otbin', 'data.otd', 'journal.otj', 'index.otidx', 'index-spill.otidx'];
  const dstDir = path.join(archivesCopyRoot, key);
  fs.mkdirSync(dstDir, { recursive: true });
  for (const f of files) {
    const srcFile = path.join(srcDir, f);
    if (fs.existsSync(srcFile)) {
      fs.copyFileSync(srcFile, path.join(dstDir, f));
    }
  }
  return dstDir;
}

function prepareIsolatedArchives() {
  const oracleJsonPath = path.join(workspaceRoot, 'out/rtos-stage5/acceptance-5.3/codex-oracles-WIIMu3/oracle.json');
  const oracle52JsonPath = path.join(workspaceRoot, 'out/rtos-stage5/acceptance-5.2/codex-events-oracle-archive.json');
  const millionJsonPath = path.join(workspaceRoot, 'out/rtos-stage5/acceptance-5.2/codex-events-million-expectations.json');
  const h723CopyJsonPath = path.join(workspaceRoot, 'out/rtos-stage5/acceptance-5.2/codex-h723-archive-copy.json');

  const oracle53 = JSON.parse(fs.readFileSync(oracleJsonPath, 'utf8'));
  const oracle52 = JSON.parse(fs.readFileSync(oracle52JsonPath, 'utf8'));
  const millionExp = JSON.parse(fs.readFileSync(millionJsonPath, 'utf8'));
  const h723Copy = JSON.parse(fs.readFileSync(h723CopyJsonPath, 'utf8'));

  return {
    h723Healthy: {
      dir: copyArchiveDir('h723-healthy', h723Copy.copy),
      rawBytes: oracle53.rawBytes,
      sha256: oracle53.sha256,
    },
    corruptIndex: {
      dir: copyArchiveDir('corrupt-index', oracle53.corruptIndex.archive),
      expectedRawBytes: oracle53.corruptIndex.expectedRawBytes,
      expectedSha256: oracle53.corruptIndex.expectedSha256,
    },
    corruptRaw: {
      dir: copyArchiveDir('corrupt-raw', oracle53.corruptRaw.archive),
      byteOffset: oracle53.corruptRaw.byteOffset,
      validPrefixBytes: oracle53.corruptRaw.validPrefixBytes,
      validPrefixSha256: oracle53.corruptRaw.validPrefixSha256,
    },
    truncatedJournal: {
      dir: copyArchiveDir('truncated-journal', oracle53.truncatedJournal.archive),
      expectedRawBytes: oracle53.truncatedJournal.expectedRawBytes,
    },
    unsupportedVersion: {
      dir: copyArchiveDir('unsupported-version', oracle53.unsupportedVersion.archive),
      formatVersion: oracle53.unsupportedVersion.formatVersion,
    },
    oracle33: {
      dir: copyArchiveDir('oracle-33', oracle52.archiveDir),
      sha256: oracle52.sha256,
      packets: oracle52.packets,
    },
    million: {
      dir: copyArchiveDir('million-1m', millionExp.recordingDir),
      expectations: millionExp,
    },
  };
}

async function main() {
  fs.mkdirSync(outRoot, { recursive: true });
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

  const archives = prepareIsolatedArchives();
  const reportPath = path.join(outRoot, 'vscode-ui-report.json');
  process.env.ORBIT_RTOS_STAGE53_REPORT = reportPath;
  process.env.ORBIT_RTOS_STAGE53_ARCHIVES = JSON.stringify(archives);

  await runTests({
    vscodeExecutablePath: executable,
    extensionDevelopmentPath: workspaceRoot,
    extensionTestsPath: path.join(__dirname, 'vscode-stage53-driver.js'),
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
  console.log('[stage5.3-vscode] PASSED:', JSON.stringify(report, null, 2));
}

main().catch(err => {
  console.error('[stage5.3-vscode] FAILED:', err);
  process.exitCode = 1;
});
