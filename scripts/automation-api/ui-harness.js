#!/usr/bin/env node

'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

const AUTOMATION_SCOPES = [
  'read', 'session.control', 'breakpoints.write', 'view.write', 'record',
  'rtt.control', 'variables.write', 'memory.write', 'flash',
];

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function workspaceRoot() {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error('UI harness requires a folder workspace');
  return folder.uri.fsPath;
}

function resultDir() {
  const dir = process.env.ORBIT_UI_HARNESS_RESULT;
  if (!dir) throw new Error('ORBIT_UI_HARNESS_RESULT is required');
  return dir;
}

async function enableAutomation() {
  const config = vscode.workspace.getConfiguration('orbit');
  await config.update('automation.enabled', true, vscode.ConfigurationTarget.Workspace);
  await config.update('automation.allowedScopes', AUTOMATION_SCOPES, vscode.ConfigurationTarget.Workspace);
  await delay(800);
}

class MockOrbitAdapter {
  constructor() {
    this.seq = 1;
    this.emitter = new vscode.EventEmitter();
    this.onDidSendMessage = this.emitter.event;
    this.breakpoints = [];
    this.state = 'halted';
    this.generation = 1;
  }

  send(message) {
    if (!message.seq) message.seq = this.seq += 1;
    this.emitter.fire(message);
  }

  respond(request, body) {
    this.send({
      type: 'response',
      request_seq: request.seq,
      success: true,
      command: request.command,
      body: body ?? {},
    });
  }

  event(event, body) {
    this.send({ type: 'event', event, body: body ?? {} });
  }

  handleMessage(message) {
    if (message.type !== 'request') return;
    const command = message.command;

    if (command === 'initialize') {
      this.respond(message, {
        supportsConfigurationDoneRequest: true,
        supportsReadMemoryRequest: true,
        supportsRestartRequest: true,
      });
      this.event('initialized', {});
      return;
    }
    if (command === 'launch' || command === 'configurationDone') {
      if (command === 'launch') {
        this.state = 'halted';
        this.event('stopped', { reason: 'entry', threadId: 1, allThreadsStopped: true });
      }
      this.respond(message, {});
      return;
    }
    if (command === 'disconnect' || command === 'terminate') {
      this.respond(message, {});
      return;
    }
    if (command === 'setBreakpoints') {
      const source = message.arguments?.source ?? {};
      this.breakpoints = (message.arguments?.breakpoints ?? []).map(item => ({
        verified: true,
        line: item.line,
        source,
      }));
      this.respond(message, { breakpoints: this.breakpoints });
      return;
    }
    if (command === 'threads') {
      this.respond(message, { threads: [{ id: 1, name: 'Orbit UI Harness' }] });
      return;
    }
    if (command === 'stackTrace') {
      this.respond(message, {
        stackFrames: [{
          id: 1,
          name: 'main',
          line: 1,
          column: 1,
          source: { name: 'main.c', path: path.join(workspaceRoot(), 'main.c') },
        }],
        totalFrames: 1,
      });
      return;
    }
    if (command === 'continue') {
      this.state = 'running';
      this.respond(message, { allThreadsContinued: true });
      this.event('continued', { threadId: 1, allThreadsContinued: true });
      return;
    }
    if (command === 'pause' || command === 'next' || command === 'stepIn' || command === 'stepOut') {
      this.state = 'halted';
      this.respond(message, {});
      this.event('stopped', { reason: command === 'pause' ? 'pause' : 'step', threadId: 1, allThreadsStopped: true });
      return;
    }
    if (command === 'restart') {
      this.generation += 1;
      this.state = 'halted';
      this.respond(message, {});
      this.event('stopped', { reason: 'restart', threadId: 1, allThreadsStopped: true });
      return;
    }
    if (command === 'orbitAutomationControl') {
      const action = message.arguments?.action;
      if (action === 'continue') {
        this.state = 'running';
        this.respond(message, { state: 'running' });
        this.event('continued', { threadId: 1, allThreadsContinued: true });
        return;
      }
      if (action === 'restart') this.generation += 1;
      this.state = 'halted';
      this.respond(message, {
        state: 'halted',
        stopReason: action === 'restart' ? 'restart' : action,
        pc: '0x08000100',
      });
      this.event('stopped', { reason: action === 'restart' ? 'restart' : action, threadId: 1, allThreadsStopped: true });
      return;
    }
    if (command === 'orbitBreakpointsSnapshot') {
      this.respond(message, {
        breakpoints: this.breakpoints.map(item => ({
          path: item.source?.path ?? path.join(workspaceRoot(), 'main.c'),
          line: item.line,
          verified: true,
          slot: 0,
          address: '0x08001234',
        })),
        capabilities: { conditional: true, hitConditional: true, logPoints: true },
      });
      return;
    }
    this.respond(message, {});
  }

  dispose() {
    this.emitter.dispose();
  }
}

async function captureScreenshot(targetPath) {
  try {
    const electron = require('electron');
    const windows = electron.BrowserWindow?.getAllWindows?.() ?? [];
    if (windows.length === 0) return false;
    const image = await windows[0].webContents.capturePage();
    await fs.writeFile(targetPath, image.toPNG());
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await delay(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function createTracker() {
  const events = [];
  const adapter = { onAdapter() {} };
  const disposable = vscode.debug.registerDebugAdapterTrackerFactory('orbit', {
    createDebugAdapterTracker() {
      return {
        onDidSendMessage(message) {
          if (message?.type === 'event' && typeof message.event === 'string') {
            events.push({ event: message.event, body: message.body ?? {} });
          }
        },
      };
    },
  });
  return {
    events,
    disposable,
    saw(name) { return events.some(item => item.event === name); },
  };
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function runDiscover() {
  await enableAutomation();
  const role = process.env.ORBIT_UI_HARNESS_ROLE ?? 'window';
  await waitFor(async () => {
    try {
      await fs.access(process.env.ORBIT_AUTOMATION_REGISTRY);
      return true;
    } catch {
      return false;
    }
  }, 20_000, 'registry pointer');
  await writeJson(path.join(resultDir(), `${role}.ready`), {
    role,
    workspace: workspaceRoot(),
    pid: process.pid,
    readyAt: Date.now(),
  });
  const quitFile = path.join(resultDir(), 'quit');
  await waitFor(async () => {
    try {
      await fs.access(quitFile);
      return true;
    } catch {
      return false;
    }
  }, 180_000, 'orchestrator quit signal');
}

async function runUiAndSession() {
  const dir = resultDir();
  await enableAutomation();
  const tracker = createTracker();
  const factory = vscode.debug.registerDebugAdapterDescriptorFactory('orbit', {
    createDebugAdapterDescriptor() {
      return new vscode.DebugAdapterInlineImplementation(new MockOrbitAdapter());
    },
  });

  const sourcePath = path.join(workspaceRoot(), 'main.c');
  await fs.writeFile(sourcePath, 'int main(void) { return 0; }\n', 'utf8');
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(sourcePath));
  await vscode.window.showTextDocument(document, { preview: false });
  await vscode.commands.executeCommand('workbench.view.debug');
  await vscode.commands.executeCommand('workbench.debug.action.focusCallStack').then(() => undefined, () => undefined);

  const clientMod = require(path.join(__dirname, '..', '..', 'Releases', 'clients', 'node', 'index.js'));
  const instances = await waitFor(async () => {
    const found = await clientMod.enumerateInstances({
      registryPath: process.env.ORBIT_AUTOMATION_REGISTRY,
    });
    return found.length === 1 ? found : undefined;
  }, 20_000, 'exactly one live Automation API instance');
  const endpoint = clientMod.selectInstance(instances);
  const client = new clientMod.OrbitClient(endpoint);
  await client.handshake({
    client: { name: 'task15-electron', version: '1.0.0' },
    requestedScopes: AUTOMATION_SCOPES,
  });

  const started = await client.invoke('orbit.session.start', {
    configurationId: 'Orbit Debug',
    timeoutMs: 15000,
  }, { context: 'projectMutation' });
  const session = await waitFor(
    () => vscode.debug.activeDebugSession && vscode.debug.activeDebugSession.type === 'orbit'
      ? vscode.debug.activeDebugSession
      : undefined,
    10_000,
    'active Orbit debug session',
  );
  await waitFor(() => tracker.saw('initialized') && tracker.saw('stopped'), 5_000, 'initialized/stopped DAP events');

  client.session = started.session;
  await client.invoke('orbit.target.continue', {}, { context: 'targetMutation' });
  await waitFor(() => tracker.saw('continued'), 5_000, 'continued DAP event');
  await client.invoke('orbit.target.pause', {}, { context: 'targetMutation' });
  await client.invoke('orbit.target.stepOver', { threadId: 1 }, { context: 'targetMutation' });

  const apiAdded = await client.invoke('orbit.breakpoints.add', {
    breakpoint: { source: { path: sourcePath, line: 1 }, enabled: true },
    waitForVerificationMs: 0,
  }, { context: 'connectionMutation' });
  const vscodeAfterApi = vscode.debug.breakpoints.filter(item => item instanceof vscode.SourceBreakpoint);
  if (vscodeAfterApi.length === 0) throw new Error('API add did not appear in vscode.debug.breakpoints');

  const extra = new vscode.SourceBreakpoint(new vscode.Location(
    vscode.Uri.file(sourcePath),
    new vscode.Position(1, 0),
  ), true);
  vscode.debug.addBreakpoints([extra]);
  await delay(200);
  const listed = await client.invoke('orbit.breakpoints.list', {});
  if (!Array.isArray(listed.items) || listed.items.length < 1) {
    throw new Error('API list did not see the VS Code breakpoint set');
  }

  const firstGeneration = started.session.sessionGeneration;
  const restarted = await client.invoke('orbit.session.restart', {}, { context: 'targetMutation' });
  if (restarted.session.sessionId !== started.session.sessionId) {
    throw new Error('restart replaced the VS Code sessionId');
  }
  if (!(restarted.session.sessionGeneration > firstGeneration)) {
    throw new Error('restart did not increment sessionGeneration');
  }
  client.session = {
    sessionId: started.session.sessionId,
    sessionGeneration: firstGeneration,
    registryGeneration: firstGeneration,
    phase: 'halted',
    targetState: 'halted',
  };
  let staleRejected = false;
  try {
    await client.invoke('orbit.target.pause', {}, { context: 'targetMutation', idempotencyKey: 'stale-electron-pause' });
  } catch (error) {
    staleRejected = error?.data?.errorCode === 'SessionChanged';
  }
  if (!staleRejected) throw new Error('stale generation did not return SessionChanged');
  client.session = restarted.session;

  const screenshotPath = path.join(dir, 'debug-toolbar.png');
  const captured = await captureScreenshot(screenshotPath);
  const official = await vscode.commands.executeCommand('orbit.automation.captureUiEvidence');
  const breakpoints = (official?.breakpoints?.length ? official.breakpoints : vscodeAfterApi.map(item => ({
    path: item.location.uri.fsPath,
    line: item.location.range.start.line + 1,
  })));

  await client.invoke('orbit.session.stop', {}, { context: 'targetMutation' });
  await client.close();
  factory.dispose();
  tracker.disposable.dispose();

  const evidence = {
    schemaVersion: 1,
    debugToolbarActive: official?.debugToolbarActive === true,
    inDebugMode: official?.inDebugMode === true,
    callStackSessionId: official?.callStackSessionId || session.id,
    sessionType: official?.sessionType || session.type,
    sessionName: official?.sessionName || session.name,
    breakpoints,
    screenshotPath: captured ? screenshotPath : undefined,
    screenshotCaptured: captured,
    dapEventOnly: false,
    dapEvents: tracker.events.map(item => item.event),
    sawInitialized: tracker.saw('initialized'),
    sawStopped: tracker.saw('stopped'),
    sawContinued: tracker.saw('continued'),
    apiAddedBreakpointId: apiAdded.items?.[0]?.breakpointId,
    vsCodeBreakpointCount: vscode.debug.breakpoints.length,
    firstGeneration,
    restartedGeneration: restarted.session.sessionGeneration,
    staleRejected,
    instanceId: endpoint.instanceId,
    projectId: endpoint.projectId,
    sessionId: started.session.sessionId,
  };
  await writeJson(path.join(dir, 'ui-evidence.json'), evidence);
}

async function run() {
  const mode = process.env.ORBIT_UI_HARNESS_MODE ?? 'ui';
  if (mode === 'discover') await runDiscover();
  else await runUiAndSession();
}

module.exports = { run };
