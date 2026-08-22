#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { downloadAndUnzipVSCode, runTests } = require('@vscode/test-electron');
const client = require('../../Releases/clients/node/index.js');

const repoRoot = path.resolve(__dirname, '..', '..');
const harnessPath = path.join(__dirname, 'ui-harness.js');

function parseArgs(argv) {
  const options = { skipUi: false, skipDownload: false };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--skip-ui') options.skipUi = true;
    else if (arg === '--skip-download') options.skipDownload = true;
    else if (arg === '--help') options.help = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  return options;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await delay(250);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function writeWorkspace(root, name, sourceLine) {
  const folder = path.join(root, name);
  await fs.promises.mkdir(path.join(folder, '.vscode'), { recursive: true });
  await fs.promises.writeFile(path.join(folder, 'main.c'), `${sourceLine}\n`);
  await fs.promises.writeFile(path.join(folder, 'app.elf'), 'elf');
  await fs.promises.writeFile(path.join(folder, '.vscode', 'settings.json'), `${JSON.stringify({
    'orbit.automation.enabled': true,
    'orbit.automation.allowedScopes': [
      'read', 'session.control', 'breakpoints.write', 'view.write', 'record',
      'rtt.control', 'variables.write', 'memory.write', 'flash',
    ],
  }, null, 2)}\n`);
  await fs.promises.writeFile(path.join(folder, '.vscode', 'launch.json'), `${JSON.stringify({
    version: '0.2.0',
    configurations: [{
      type: 'orbit',
      request: 'launch',
      name: 'Orbit Debug',
      program: '${workspaceFolder}/app.elf',
      flashBeforeDebug: false,
    }],
  }, null, 2)}\n`);
  return folder;
}

function spawnHost(vscodeExecutablePath, workspace, userDataDir, env) {
  const child = spawn(process.execPath, [path.join(__dirname, 'run-test-host.js')], {
    env: {
      ...process.env,
      ...env,
      ORBIT_TEST_HOST_OPTIONS: JSON.stringify({
        vscodeExecutablePath,
        extensionDevelopmentPath: repoRoot,
        extensionTestsPath: harnessPath,
        launchArgs: [
          workspace,
          '--disable-workspace-trust',
          `--user-data-dir=${userDataDir}`,
        ],
      }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.on('data', chunk => process.stdout.write(`[host ${path.basename(userDataDir)}] ${chunk}`));
  child.stderr.on('data', chunk => process.stderr.write(`[host ${path.basename(userDataDir)}] ${chunk}`));
  return child;
}

function closeHost(child) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => resolve();
    child.once('exit', done);
    child.kill();
    setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    }, 3000);
  });
}

async function enumerateLive(registryPath) {
  return client.enumerateInstances({ registryPath, healthTimeoutMs: 1500 });
}

async function main() {
  const options = parseArgs(process.argv);
  if (options.help) {
    console.log('usage: node scripts/automation-api/verify-multi-window.js [--skip-ui]');
    process.exit(0);
  }

  const vscodeExecutablePath = options.skipDownload
    ? process.env.VSCODE_EXECUTABLE
    : await downloadAndUnzipVSCode({ version: 'stable' });
  if (!vscodeExecutablePath) throw new Error('VS Code executable path is unavailable');

  const scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'orbit-multi-window-'));
  const resultDir = path.join(scratch, 'results');
  await fs.promises.mkdir(resultDir, { recursive: true });
  const registryPath = path.join(scratch, 'registries.json');
  const robot = await writeWorkspace(scratch, 'robot', 'int robot(void) { return 0; }');
  const motor = await writeWorkspace(scratch, 'motor', 'int motor(void) { return 1; }');
  const hosts = [];

  try {
    const aReady = path.join(resultDir, 'window-a.ready');
    const bReady = path.join(resultDir, 'window-b.ready');
    hosts.push(spawnHost(vscodeExecutablePath, robot, path.join(scratch, 'edh-a'), {
      ORBIT_UI_HARNESS_MODE: 'discover',
      ORBIT_UI_HARNESS_ROLE: 'window-a',
      ORBIT_UI_HARNESS_RESULT: resultDir,
      ORBIT_AUTOMATION_REGISTRY: registryPath,
    }));
    hosts.push(spawnHost(vscodeExecutablePath, motor, path.join(scratch, 'edh-b'), {
      ORBIT_UI_HARNESS_MODE: 'discover',
      ORBIT_UI_HARNESS_ROLE: 'window-b',
      ORBIT_UI_HARNESS_RESULT: resultDir,
      ORBIT_AUTOMATION_REGISTRY: registryPath,
    }));
    await waitFor(() => fs.existsSync(aReady) && fs.existsSync(bReady), 180_000, 'two discover hosts');
    const different = await waitFor(async () => {
      const live = await enumerateLive(registryPath);
      return live.length >= 2 ? live : undefined;
    }, 30_000, 'two live endpoints');
    if (new Set(different.map(item => item.instanceId)).size < 2) {
      throw new Error('two windows did not publish distinct instanceIds');
    }
    if (new Set(different.map(item => item.projectId)).size < 2) {
      throw new Error('different projects unexpectedly shared a projectId');
    }
    try {
      client.selectInstance(different);
      throw new Error('expected AmbiguousInstance when two instances are live');
    } catch (error) {
      if (error.constructor.name !== 'AmbiguousInstanceError') throw error;
    }

    const cReady = path.join(resultDir, 'window-c.ready');
    hosts.push(spawnHost(vscodeExecutablePath, robot, path.join(scratch, 'edh-c'), {
      ORBIT_UI_HARNESS_MODE: 'discover',
      ORBIT_UI_HARNESS_ROLE: 'window-c',
      ORBIT_UI_HARNESS_RESULT: resultDir,
      ORBIT_AUTOMATION_REGISTRY: registryPath,
    }));
    await waitFor(() => fs.existsSync(cReady), 180_000, 'same-project discover host');
    const sameProject = await waitFor(async () => {
      const live = await enumerateLive(registryPath);
      const robotWindows = live.filter(item => item.workspaceFolders?.some(folder => /robot$/i.test(folder)));
      return robotWindows.length >= 2 ? robotWindows : undefined;
    }, 30_000, 'two robot project instances');
    if (new Set(sameProject.map(item => item.projectId)).size !== 1) {
      throw new Error('same-project windows did not share a projectId');
    }
    if (new Set(sameProject.map(item => item.instanceId)).size < 2) {
      throw new Error('same-project windows did not have distinct instanceIds');
    }
    try {
      client.selectInstance(sameProject, { projectId: sameProject[0].projectId });
      throw new Error('expected AmbiguousInstance for same-project windows');
    } catch (error) {
      if (error.constructor.name !== 'AmbiguousInstanceError') throw error;
    }
    const picked = client.selectInstance(sameProject, { instanceId: sameProject[0].instanceId });
    const handshakeClient = new client.OrbitClient(picked);
    await handshakeClient.handshake({ client: { name: 'multi-window-same' }, requestedScopes: ['read'] });
    await handshakeClient.close();

    await fs.promises.writeFile(path.join(resultDir, 'quit'), '1');
    await Promise.all(hosts.splice(0).map(closeHost));

    if (!options.skipUi) {
      const uiResult = path.join(resultDir, 'ui');
      await fs.promises.mkdir(uiResult, { recursive: true });
      await runTests({
        vscodeExecutablePath,
        extensionDevelopmentPath: repoRoot,
        extensionTestsPath: harnessPath,
        launchArgs: [robot, '--disable-workspace-trust', `--user-data-dir=${path.join(scratch, 'edh-ui')}`],
        extensionTestsEnv: {
          ORBIT_UI_HARNESS_MODE: 'ui',
          ORBIT_UI_HARNESS_RESULT: uiResult,
          ORBIT_AUTOMATION_REGISTRY: registryPath,
        },
      });
      const uiEvidencePath = path.join(uiResult, 'ui-evidence.json');
      const uiEvidence = JSON.parse(await fs.promises.readFile(uiEvidencePath, 'utf8'));
      if (uiEvidence.debugToolbarActive !== true || !uiEvidence.callStackSessionId) {
        throw new Error('UI harness did not produce official debug/session evidence');
      }
      if (!Array.isArray(uiEvidence.breakpoints) || uiEvidence.breakpoints.length === 0) {
        throw new Error('UI harness did not record vscode.debug.breakpoints');
      }
      if (uiEvidence.dapEventOnly === true || !uiEvidence.sawInitialized || !uiEvidence.sawStopped || !uiEvidence.sawContinued) {
        throw new Error('UI harness lacked official DAP initialized/stopped/continued evidence');
      }
      if (uiEvidence.staleRejected !== true) {
        throw new Error('UI harness did not prove SessionChanged on stale generation');
      }
      console.log(`UI evidence OK session=${uiEvidence.callStackSessionId} screenshot=${uiEvidence.screenshotCaptured}`);
    }

    console.log(`Multi-window verification passed under ${scratch}`);
  } finally {
    await fs.promises.writeFile(path.join(resultDir, 'quit'), '1').catch(() => undefined);
    await Promise.all(hosts.map(closeHost));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
