import * as vscode from 'vscode';
import { OzoneBackend } from './ozone-backend/commander';
import { WatchProvider } from './debug-providers/watch-provider';
import { WatchWebviewProvider } from './debug-providers/watch-webview-provider';
import { TimelineWebviewProvider } from './webview/timeline/timeline-provider';
import { DataSamplingManager } from './debug-providers/data-sampling-manager';
import { OzoneDebugConfigurationProvider } from './debug/ozone-debug-config';
import { findElfFiles } from './ozone-backend/flasher';
import { PluginApiServer } from './plugin-api/plugin-api-server';
import { EventHub } from './plugin-api/event-hub';
import { SessionRegistry } from './plugin-api/session-registry';
import { SessionService } from './plugin-api/session-service';
import { configureLogger } from './utils/logger';
import { getOrbitConfiguration, migrateLegacyOrbitSettings } from './utils/orbit-settings';
import { isOrbitDebugSessionType, ORBIT_DAP_TYPE } from './utils/debug-session-type';
import { createRtosViewsRefreshHandler } from './debug/rtos-views-tracker';
import * as fs from 'fs';

let backend: OzoneBackend;
let watchProvider: WatchProvider;
let watchWebviewProvider: WatchWebviewProvider;
let dataSamplingManager: DataSamplingManager;
let timelineProvider: TimelineWebviewProvider;
let watchPollTimer: NodeJS.Timeout | null = null;
let watchPollGeneration = 0;
let activeWatchSession: vscode.DebugSession | null = null;
let pluginApiServer: PluginApiServer;
let eventHub: EventHub;
let sessionRegistry: SessionRegistry;
let rttLogTerminal: vscode.Terminal | null = null;
let rttLogPty: RttLogTerminal | null = null;

class RttLogTerminal implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  readonly onDidWrite = this.writeEmitter.event;
  private closed = false;

  constructor(private readonly onClose: () => void) {}

  open(): void {
    this.closed = false;
    this.writeEmitter.fire('\x1B[1;36mOrbit RTT Log\x1B[0m\r\n');
  }

  close(): void {
    this.closed = true;
    this.onClose();
  }

  write(text: string): void {
    if (!this.closed) {
      this.writeEmitter.fire(text);
    }
  }
}

function ensureRttLogTerminal(): { terminal: vscode.Terminal; pty: RttLogTerminal } {
  if (!rttLogTerminal || !rttLogPty) {
    rttLogPty = new RttLogTerminal(() => {
      rttLogTerminal = null;
      rttLogPty = null;
    });
    rttLogTerminal = vscode.window.createTerminal({
      name: 'Orbit RTT Log',
      pty: rttLogPty,
    });
  }
  return { terminal: rttLogTerminal, pty: rttLogPty };
}

function showRttLogTerminal() {
  ensureRttLogTerminal().terminal.show(true);
}

function writeRttLogTerminal(text: string) {
  if (!text) return;
  ensureRttLogTerminal().pty.write(text);
}

function isUsableWatchSession(session: vscode.DebugSession | undefined): session is vscode.DebugSession {
  return !!session && isOrbitDebugSessionType(session.type) && activeWatchSession === session;
}

function setActiveWatchSession(session: vscode.DebugSession | undefined) {
  const next = session && isOrbitDebugSessionType(session.type) ? session : null;
  if (activeWatchSession === next) return;
  activeWatchSession = next;
  if (next) startWatchPolling();
  else stopWatchPolling();
}

function terminateWatchSession(session: vscode.DebugSession) {
  if (activeWatchSession !== session) return;
  activeWatchSession = null;
  stopWatchPolling();
}

export async function activate(context: vscode.ExtensionContext) {
  try {
    await migrateLegacyOrbitSettings();
    const logConfig = getOrbitConfiguration();
    const updateLoggerConfiguration = () => {
      configureLogger({
        enabled: logConfig.get<boolean>('logging.enabled', true),
        clearOnStart: logConfig.get<boolean>('logging.clearOnStart', true),
      });
    };
    updateLoggerConfiguration();
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('orbit.logging.enabled') || event.affectsConfiguration('orbit.logging.clearOnStart') ||
          event.affectsConfiguration('ozone.logging.enabled') || event.affectsConfiguration('ozone.logging.clearOnStart')) {
        updateLoggerConfiguration();
      }
    }));

    const b = new OzoneBackend(undefined, undefined, () => isOrbitDebugSessionType(vscode.debug.activeDebugSession?.type));
    backend = b;
    const initialSession = vscode.debug.activeDebugSession;
    activeWatchSession = initialSession && isOrbitDebugSessionType(initialSession.type) ? initialSession : null;

    const wp = new WatchProvider();
    watchProvider = wp;

    const wvp = new WatchWebviewProvider(context, backend, isUsableWatchSession);
    watchWebviewProvider = wvp;
    wvp.onExpressionsChanged = (exprs) => {
      wp.setExpressions(exprs);
      context.workspaceState.update('ozoneWatchExpressions', exprs);
    };
    const saved = context.workspaceState.get<string[]>('ozoneWatchExpressions', []);
    if (saved.length > 0) {
      wvp.setExpressions(saved);
      wp.setExpressions(saved);
    }

    const dsm = new DataSamplingManager(b);
    dataSamplingManager = dsm;
    dsm.onExpressionsChanged = (exprs) => {
      context.workspaceState.update('ozoneDataSamplingExpressions', exprs);
      timelineProvider?.refreshEntries();
    };
    wvp.onSendToTimeline = (exprs) => {
      for (const e of exprs) dsm.addExpression(e);
      vscode.commands.executeCommand('workbench.view.ozone-timeline-panel');
    };
    const dsSaved = context.workspaceState.get<any[]>('ozoneDataSamplingExpressions', []);
    if (dsSaved.length > 0) {
      try { dsm.setExpressions(dsSaved); } catch { dsm.setExpressions([]); }
    }

    const tl = new TimelineWebviewProvider(context, dsm);
    timelineProvider = tl;

    // Bounded automation event ring and the exact DebugSession registry with
    // the instance-level generation fence (plan Task 3). The ring pulls its
    // identity from the API server so events published after startup carry the
    // real instanceId/projectId.
    eventHub = new EventHub({
      instanceId: () => pluginApiServer?.getInstanceId() ?? '',
      projectId: () => pluginApiServer?.getProjectId() ?? '',
    });
    sessionRegistry = new SessionRegistry({ eventHub });
    const sessionService = new SessionService({ registry: sessionRegistry });

    pluginApiServer = new PluginApiServer(context, backend, { sessionRegistry, sessionService });
    const apiEndpoint = await pluginApiServer.start();
    context.subscriptions.push(pluginApiServer);
      console.log(`[Orbit] Plugin API listening on ${apiEndpoint.url}`);

    // Adopt a session that was already running when this Extension Host
    // activated; its start event fired before the registry existed.
    if (initialSession && isOrbitDebugSessionType(initialSession.type)) {
      sessionRegistry.onStarted(initialSession);
    }

    // Track both the canonical Orbit DAP type and the legacy ozone alias.
    for (const section of ['memory-view', 'mcu-debug.rtos-views', 'mcu-debug.debug-tracker-vscode']) {
      for (const debuggerType of [ORBIT_DAP_TYPE, 'ozone'] as const) {
        appendWorkspaceArraySetting(section, 'trackDebuggers', debuggerType).catch((err) => {
          console.error(`[Orbit] Failed to register ${debuggerType} with ${section}.trackDebuggers:`, err);
        });
      }
    }

    if (getOrbitConfiguration().get<boolean>('rtosViewsAutoRefresh', false)) {
      setupRtosViewsAutoRefresh(context);
    }

    // 激活时自动检测 .elf/.axf，写入设置
    const orbitCfg = getOrbitConfiguration();
    if (!orbitCfg.get<string>('defaultProgram') || !fs.existsSync(orbitCfg.get<string>('defaultProgram', ''))) {
      const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (wsRoot) {
        const candidates = findElfFiles(wsRoot);
        if (candidates.length >= 1) {
          orbitCfg.update('defaultProgram', candidates[0].path, vscode.ConfigurationTarget.Workspace);
        }
      }
    }

    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider('ozoneWatch', wvp),
      vscode.window.registerWebviewViewProvider('ozoneTimeline', timelineProvider, {
        webviewOptions: { retainContextWhenHidden: true },
      }),
      vscode.debug.registerDebugConfigurationProvider('orbit', new OzoneDebugConfigurationProvider()),
      vscode.debug.registerDebugConfigurationProvider('ozone', new OzoneDebugConfigurationProvider()),
      vscode.debug.onDidReceiveDebugSessionCustomEvent((event) => {
        if (isOrbitDebugSessionType(event.session.type) && event.event === 'ozoneClearDebugConsole') {
          vscode.commands.executeCommand('workbench.debug.action.clearRepl');
        } else if (isOrbitDebugSessionType(event.session.type) && event.event === 'ozoneRttStarted') {
          showRttLogTerminal();
        } else if (isOrbitDebugSessionType(event.session.type) && event.event === 'ozoneRttOutput') {
          writeRttLogTerminal(String(event.body?.text || ''));
        }
      }),
      vscode.debug.onDidStartDebugSession((session) => {
        if (isOrbitDebugSessionType(session.type)) setActiveWatchSession(session);
        sessionRegistry.onStarted(session);
      }),
      vscode.debug.onDidChangeActiveDebugSession((session) => {
        setActiveWatchSession(session);
        sessionRegistry.onActiveChanged(session);
      }),
      vscode.debug.onDidTerminateDebugSession((session) => {
        terminateWatchSession(session);
        sessionRegistry.onTerminated(session);
      }),

      vscode.commands.registerCommand('ozone.addWatch', async () => {
        const expr = await vscode.window.showInputBox({
          prompt: '输入要监视的变量名或表达式',
          placeHolder: '例如: myVar',
        });
        if (!expr) return;
        const current = wvp.expressionList;
        if (current.includes(expr)) return;
        wvp.addExpression(expr);
      }),

      vscode.commands.registerCommand('ozone.removeWatch', async (item) => {
        const expr = item?.watch?.expression;
        if (!expr) return;
        const current = wvp.expressionList;
        wvp.setExpressions(current.filter(e => e !== expr));
        wp.setExpressions(current.filter(e => e !== expr));
      }),

      vscode.commands.registerCommand('ozone.openTimeline', () => {
        vscode.commands.executeCommand('workbench.view.ozone-timeline-panel');
      }),

      vscode.commands.registerCommand('ozone.openSettings', () => {
        vscode.commands.executeCommand('workbench.action.openSettings', '@ext:orbit-debug.orbit-for-vscode');
      }),

      vscode.commands.registerCommand('ozone.enableMcuDebugViews', enableMcuDebugViewsIntegration),

      vscode.commands.registerCommand('ozone.api.getEndpoint', () => {
        return pluginApiServer?.getEndpointInfo();
      }),

      vscode.commands.registerCommand('ozone.addToDataSampling', async (item) => {
        const expr = item?.watch?.expression || item;
        if (!expr || typeof expr !== 'string') return;
        dataSamplingManager.addExpression(expr);
        vscode.commands.executeCommand('workbench.view.ozone-timeline-panel');
        vscode.commands.executeCommand('workbench.view.extension.ozone-timeline-panel');
      }),

      vscode.commands.registerCommand('ozone.debug', async () => {
        const config = getOrbitConfiguration();
        let elfPath = config.get<string>('defaultProgram', '');
        const device = config.get<string>('defaultDevice', 'STM32F407VG');
        const interface_ = config.get<'SWD' | 'JTAG'>('defaultInterface', 'SWD');
        const speedKHz = config.get<number>('defaultSpeed', 4000);

        if (!elfPath || !fs.existsSync(elfPath)) {
          const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          if (workspaceRoot) {
            const candidates = findElfFiles(workspaceRoot);
            if (candidates.length === 1) {
              elfPath = candidates[0].path;
              config.update('defaultProgram', elfPath, vscode.ConfigurationTarget.Workspace);
            } else if (candidates.length > 1) {
              const pick = await vscode.window.showQuickPick(
                candidates.map(c => ({ label: c.label, description: c.description, detail: c.path })),
                { title: 'Select ELF for debug', placeHolder: 'Choose an ELF file' }
              );
              if (pick) {
                elfPath = (pick as any).detail;
                config.update('defaultProgram', elfPath, vscode.ConfigurationTarget.Workspace);
              }
            }
          }
        }
        if (!elfPath || !fs.existsSync(elfPath)) {
          vscode.window.showErrorMessage('Orbit: No ELF file found. Configure it in the settings panel first.');
          return;
        }

        // Release any pre-existing extension-host legacy session before the DAP
        // process selects its sole session owner.
        await backend.execute({ cmd: 'disconnect' });
        await vscode.debug.startDebugging(vscode.workspace.workspaceFolders?.[0], {
          type: ORBIT_DAP_TYPE,
          request: 'launch',
          name: 'Orbit Debug',
          program: elfPath,
          device,
          interface: interface_,
          speedKHz,
        });
      }),
    );

    if (activeWatchSession) startWatchPolling();
  } catch (e: any) {
    console.error('[Orbit] activate FAILED:', e.message);
    console.error('[Orbit] stack:', e.stack);
    vscode.window.showErrorMessage(`Orbit activation failed: ${e.message}`);
  }
}

async function readWatchValues(exprs: string[], expandedExpressions: string[] = []): Promise<any[]> {
  const session = vscode.debug.activeDebugSession;
  if (session && isOrbitDebugSessionType(session.type)) {
    if (!isUsableWatchSession(session)) {
      return exprs.map(expression => ({
        expression,
        value: 0,
        display: '',
        hex: '',
        error: 'Debug session is not available',
      }));
    }
    try {
      const r: any = await session.customRequest('dataSample', { expressions: exprs, expandedExpressions });
      if (r && r.results) return r.results;
      return exprs.map(expression => ({ expression, value: 0, display: '', hex: '', error: 'DAP dataSample returned no results' }));
    } catch (err: any) {
      const error = err?.message || 'DAP dataSample failed';
      return exprs.map(expression => ({ expression, value: 0, display: '', hex: '', error }));
    }
  }
  if (!backend.hasTargetConnection) {
    return exprs.map(expression => ({
      expression,
      value: 0,
      display: '',
      hex: '',
      error: 'No active Orbit debug session',
    }));
  }
  const results: any[] = [];
  for (const expr of exprs) {
    try {
      const r = await backend.execute({ cmd: 'evaluateExpression', expression: expr, force: true, expandedExpressions });
      if (r.ok) results.push(r.data);
      else results.push({ expression: expr, value: 0, display: '', hex: '', error: r.error });
    } catch { results.push({ expression: expr, value: 0, display: '', hex: '', error: 'err' }); }
  }
  return results;
}

function startWatchPolling() {
  stopWatchPolling();
  const generation = watchPollGeneration;
  const cfg = getOrbitConfiguration();
  const baseInterval = cfg.get<number>('watchPollIntervalMs', 500);

  const loop = async () => {
    if (watchPollTimer === null || generation !== watchPollGeneration) return;
    try {
      const expressions = watchProvider?.watches.map(w => w.expression) || [];
      if (expressions.length === 0) {
        watchPollTimer = setTimeout(loop, baseInterval);
        return;
      }
      if (!watchWebviewProvider?.isVisible) {
        watchPollTimer = setTimeout(loop, baseInterval);
        return;
      }
      const results = await readWatchValues(expressions, watchWebviewProvider?.expandedExpressions || []);
      if (watchPollTimer === null || generation !== watchPollGeneration) return;
      if (results.length > 0) {
        watchProvider?.updateResults(results);
        watchWebviewProvider?.sendWatchResults(results as any);
      }
    } catch {}
    if (watchPollTimer !== null && generation === watchPollGeneration) {
      watchPollTimer = setTimeout(loop, baseInterval);
    }
  };
  watchPollTimer = setTimeout(loop, baseInterval);
}

function stopWatchPolling() {
  watchPollGeneration++;
  if (watchPollTimer) { clearTimeout(watchPollTimer); watchPollTimer = null; }
}

function setupRtosViewsAutoRefresh(context: vscode.ExtensionContext) {
  const diagChannel = vscode.window.createOutputChannel('Orbit RTOS Views');

  vscode.extensions.getExtension("mcu-debug.debug-tracker-vscode")?.activate().then((trackerApi: any) => {
    if (!trackerApi || typeof trackerApi.subscribe !== 'function') {
      diagChannel.appendLine('Debug tracker API has no subscribe method');
      return;
    }
    try {
      const result = trackerApi.subscribe({
        version: 1,
        body: {
          debuggers: [ORBIT_DAP_TYPE, 'ozone'],
          handler: createRtosViewsRefreshHandler(() => {
              // Trigger RTOS Views detection: the 'refresh' command calls
              // RTOSTracker.update() → updateRTOSInfo() → rtosSession.refresh()
              // → onStopped(lastFrameId) → tryDetect()
              //
              // Optional compatibility path only; normal debug flow should not
              // wait for RTOS Views detection.
            setTimeout(() => {
              vscode.commands.executeCommand('rtos-views.rtos.focus').then(() => {
                  // Wait for resolveWebviewView to render the panel
                setTimeout(() => {
                  vscode.commands.executeCommand('mcu-debug.rtos-views.refresh').then(undefined, (e2: any) => {
                    diagChannel.appendLine(`RTOS Views refresh failed: ${e2?.message || e2}`);
                  });
                }, 500);
              }, () => {
                diagChannel.appendLine('RTOS Views panel not found (not installed?)');
              });
            }, 1000);
          }),
          wantCurrentStatus: true,
          notifyAllEvents: false,
        }
      });
      diagChannel.appendLine(`Subscribed: clientId=${result?.clientId || 'unknown'}`);
    } catch (e: any) {
      diagChannel.appendLine(`Subscribe failed: ${e.message}`);
    }
  }, (e: any) => {
    diagChannel.appendLine(`Activation failed: ${e.message}`);
  });
}

async function appendWorkspaceArraySetting(section: string, key: string, value: string): Promise<boolean> {
  const cfg = vscode.workspace.getConfiguration(section);
  const current = cfg.get<unknown>(key);
  const list = Array.isArray(current) ? current.filter((item): item is string => typeof item === 'string') : [];
  if (list.includes(value)) {
    console.log(`[Orbit] ${section}.${key} already includes "${value}"`);
    return false;
  }
  await cfg.update(key, [...list, value], vscode.ConfigurationTarget.Workspace);
  console.log(`[Orbit] Added "${value}" to ${section}.${key}`);
  return true;
}

async function enableMcuDebugViewsIntegration() {
  const changed: string[] = [];
  for (const section of ['memory-view', 'mcu-debug.rtos-views', 'mcu-debug.debug-tracker-vscode']) {
    for (const debuggerType of [ORBIT_DAP_TYPE, 'ozone'] as const) {
      if (await appendWorkspaceArraySetting(section, 'trackDebuggers', debuggerType)) {
        changed.push(`${section}.trackDebuggers`);
      }
    }
  }

  if (changed.length > 0) {
    const choice = await vscode.window.showInformationMessage(
      `Orbit: MCU Debug Views integration enabled (${changed.join(', ')}). Reload window to activate.`,
      'Reload Window',
    );
    if (choice === 'Reload Window') {
      vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  } else {
    vscode.window.showInformationMessage('Orbit: MCU Debug Views integration is already enabled for this workspace.');
  }
}

export function deactivate() {
  stopWatchPolling();
  rttLogTerminal?.dispose();
  dataSamplingManager?.dispose();
  sessionRegistry?.dispose();
  eventHub?.dispose();
  pluginApiServer?.dispose();
}
