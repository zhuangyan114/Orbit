import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import type { RtosSnapshot } from '../../rtos/model';
import { AUTOMATION_CONTROL_EVENT, AUTOMATION_LIFECYCLE_EVENT } from '../../debug/dap-automation-protocol';
import { isOrbitDebugSessionType } from '../../utils/debug-session-type';
import { log } from '../../utils/logger';
import {
  DEFAULT_RTOS_VIEW_SETTINGS,
  RTOS_VIEW_SETTINGS_KEY,
  RtosCapabilitiesPayload,
  RtosErrorSummary,
  RtosPanelState,
  RtosSessionPhase,
  RtosViewSettings,
  sanitizeRtosViewSettings,
} from './rtos-view-state';

export class RtosWebviewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | null = null;
  private viewDisposables: vscode.Disposable[] = [];
  private readonly disposables: vscode.Disposable[] = [];
  private settings: RtosViewSettings;
  private activeSession: vscode.DebugSession | undefined;
  private liveStartedSession: vscode.DebugSession | undefined;
  private readonly endedSessions = new WeakSet<vscode.DebugSession>();
  private sessionGeneration = 0;
  private hostVersion = 0;
  private disposed = false;

  private sessionPhase: RtosSessionPhase = 'none';
  private targetState: 'Running' | 'Halted' | 'Unknown' = 'Unknown';
  private capabilities: RtosCapabilitiesPayload | null = null;
  private capabilitiesError: RtosErrorSummary | null = null;
  private snapshot: RtosSnapshot | null = null;
  private lastError: RtosErrorSummary | null = null;
  private loading = { refresh: false, stackScan: false, capabilities: false };
  private liveActive = false;
  private resyncCapabilities = false;

  private expectedRtosSessionId: string | undefined;
  private expectedRtosSessionGeneration: number | undefined;
  private lastSnapshotSequence = 0;
  private _readyCount = 0;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.settings = sanitizeRtosViewSettings(context.workspaceState.get(RTOS_VIEW_SETTINGS_KEY));
    this.disposables.push(
      vscode.debug.onDidStartDebugSession(session => {
        if (isOrbitDebugSessionType(session.type) && (!this.activeSession || vscode.debug.activeDebugSession === session)) {
          this.bindSession(session);
        }
      }),
      vscode.debug.onDidChangeActiveDebugSession(session => {
        if (session && isOrbitDebugSessionType(session.type) && !this.endedSessions.has(session)) {
          this.bindSession(session);
        } else {
          this.bindSession(undefined);
        }
      }),
      vscode.debug.onDidTerminateDebugSession(session => {
        this.endedSessions.add(session);
        if (this.liveStartedSession === session) {
          this.liveStartedSession = undefined;
          this.liveActive = false;
        }
        if (session === this.activeSession) {
          const next = vscode.debug.activeDebugSession;
          const validNext = next && next !== session && !this.endedSessions.has(next) && isOrbitDebugSessionType(next.type) ? next : undefined;
          this.bindSession(validNext);
        }
      }),
      vscode.debug.onDidReceiveDebugSessionCustomEvent(event => this.handleCustomEvent(event)),
    );

    const initial = vscode.debug.activeDebugSession;
    if (initial && isOrbitDebugSessionType(initial.type)) {
      this.bindSession(initial);
    }
  }

  get isVisible(): boolean {
    return this.view?.visible ?? false;
  }

  get readyCount(): number {
    return this._readyCount;
  }

  get currentSettings(): RtosViewSettings {
    return structuredClone(this.settings);
  }

  get currentState(): RtosPanelState {
    return {
      hostVersion: this.hostVersion,
      visible: this.isVisible,
      session: this.activeSession ? {
        phase: this.sessionPhase,
        sessionId: this.activeSession.id,
        sessionName: this.activeSession.name,
        sessionType: this.activeSession.type,
        device: typeof this.activeSession.configuration?.device === 'string' ? this.activeSession.configuration.device : undefined,
        targetState: this.targetState,
      } : { phase: 'none' },
      settings: structuredClone(this.settings),
      capabilities: this.capabilities,
      capabilitiesError: this.capabilitiesError,
      snapshot: this.snapshot,
      loading: { ...this.loading },
      liveActive: this.liveActive,
      lastError: this.lastError,
    };
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.disposeViewListeners();
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);
    this.viewDisposables.push(
      webviewView.webview.onDidReceiveMessage(msg => { void this.handleMessage(msg); }),
      webviewView.onDidChangeVisibility(() => this.handleVisibilityChange()),
      webviewView.onDidDispose(() => {
        if (this.view === webviewView) {
          this.view = null;
          this.disposeViewListeners();
          void this.stopLivePolling();
        }
      }),
    );
  }

  private disposeViewListeners(): void {
    while (this.viewDisposables.length > 0) {
      this.viewDisposables.pop()?.dispose();
    }
  }

  private handleVisibilityChange(): void {
    if (!this.view) return;
    if (!this.view.visible) {
      void this.stopLivePolling();
      this.postMessage({ command: 'visibility', visible: false });
      return;
    }
    this.postState();
    if (this.activeSession) {
      if (!this.capabilities) {
        void this.syncSessionConnection(this.sessionGeneration);
      } else if (this.settings.liveEnabled && !this.liveActive && this.capabilities.capabilities.taskSnapshot.available) {
        void this.startLiveOnSession(this.sessionGeneration);
      }
    }
  }

  private bindSession(session: vscode.DebugSession | undefined): void {
    const valid = session && isOrbitDebugSessionType(session.type) && !this.endedSessions.has(session) ? session : undefined;
    if (valid === this.activeSession && (valid || this.sessionPhase === 'none')) return;

    void this.stopLivePolling();
    this.sessionGeneration++;
    this.activeSession = valid;
    this.sessionPhase = valid ? 'starting' : 'none';
    this.targetState = 'Unknown';
    this.capabilities = null;
    this.capabilitiesError = null;
    this.snapshot = null;
    this.lastError = null;
    this.loading = { refresh: false, stackScan: false, capabilities: false };
    this.liveActive = false;
    this.resyncCapabilities = false;
    this.expectedRtosSessionId = undefined;
    this.expectedRtosSessionGeneration = undefined;
    this.lastSnapshotSequence = 0;

    this.postState();
    if (valid && this.isVisible) {
      void this.syncSessionConnection(this.sessionGeneration);
    }
  }

  private handleCustomEvent(event: vscode.DebugSessionCustomEvent): void {
    if (this.disposed || !this.activeSession || event.session !== this.activeSession || this.endedSessions.has(event.session)) return;
    if (event.event === 'orbitRtosSnapshot') {
      if (!this.liveActive || !this.isVisible || !event.body || typeof event.body !== 'object') return;
      const incoming = event.body as RtosSnapshot;
      if (this.expectedRtosSessionId && incoming.sessionId !== this.expectedRtosSessionId) return;
      if (this.expectedRtosSessionGeneration !== undefined && incoming.sessionGeneration !== this.expectedRtosSessionGeneration) return;
      if (typeof incoming.snapshotSequence === 'number' && incoming.snapshotSequence < this.lastSnapshotSequence) return;
      this.applySnapshot(incoming, this.sessionGeneration);
      return;
    }

    if (event.event === AUTOMATION_LIFECYCLE_EVENT || event.event === AUTOMATION_CONTROL_EVENT) {
      const body = event.body || {};
      if (body.type === 'target.connectionLost') {
        this.liveActive = false;
        this.liveStartedSession = undefined;
        this.sessionPhase = 'terminating';
        this.lastError = { errorCode: 'ConnectionLost', message: '目标调试连接已断开', at: Date.now() };
        this.postState();
        return;
      }
      let stateChanged = false;
      if (body.state === 'running' || body.type === 'target.running') {
        if (this.targetState !== 'Running') { this.targetState = 'Running'; stateChanged = true; }
      } else if (body.state === 'halted' || body.type === 'target.stopped') {
        if (this.targetState !== 'Halted') { this.targetState = 'Halted'; stateChanged = true; }
      }
      if (this.sessionPhase === 'starting' && this.isVisible) {
        void this.syncSessionConnection(this.sessionGeneration);
      } else if (stateChanged) {
        this.postState();
      }
    }
  }

  private isCurrentBinding(generation: number, session: vscode.DebugSession): boolean {
    return !this.disposed && generation === this.sessionGeneration && this.activeSession === session && !this.endedSessions.has(session);
  }

  private async syncSessionConnection(generation: number): Promise<void> {
    const session = this.activeSession;
    if (!session || !this.isCurrentBinding(generation, session)) return;
    if (this.loading.capabilities) {
      this.resyncCapabilities = true;
      return;
    }
    this.loading.capabilities = true;
    this.resyncCapabilities = false;
    this.postState();
    try {
      const response = await session.customRequest('orbitRtosSnapshot', { action: 'capabilities' });
      if (!this.isCurrentBinding(generation, session)) return;
      if (response && response.capabilities) {
        this.sessionPhase = 'connected';
        this.expectedRtosSessionId = response.sessionId;
        this.expectedRtosSessionGeneration = response.sessionGeneration;
        this.capabilities = response as RtosCapabilitiesPayload;
        this.capabilitiesError = null;
        this.loading.capabilities = false;
        this.resyncCapabilities = false;
        this.postState();

        if (this.isVisible && response.capabilities.taskSnapshot?.available) {
          if (this.settings.liveEnabled) {
            await this.startLiveOnSession(generation);
          } else if (!this.snapshot) {
            await this.refreshSnapshot({ generation });
          }
        }
        return;
      }
      const errorCode = typeof response?.errorCode === 'string' ? response.errorCode : undefined;
      const reason = typeof response?.reason === 'string' ? response.reason : 'FreeRTOS 布局不可用';
      if (errorCode === 'SessionChanged' && /No connected session/i.test(reason)) {
        this.sessionPhase = 'starting';
      } else {
        this.sessionPhase = 'connected';
        this.capabilities = null;
        this.capabilitiesError = { errorCode, message: reason, at: Date.now() };
        this.snapshot = null;
      }
    } catch (error) {
      if (!this.isCurrentBinding(generation, session)) return;
      const message = error instanceof Error ? error.message : String(error);
      this.capabilitiesError = { message, at: Date.now() };
    } finally {
      if (this.isCurrentBinding(generation, session)) {
        this.loading.capabilities = false;
        this.postState();
        if (this.resyncCapabilities && !this.capabilities) {
          this.resyncCapabilities = false;
          void this.syncSessionConnection(generation);
        }
      }
    }
  }

  private async startLiveOnSession(generation: number): Promise<void> {
    const session = this.activeSession;
    if (!session || !this.isCurrentBinding(generation, session) || !this.isVisible) return;
    if (this.capabilities && !this.capabilities.capabilities.taskSnapshot.available) return;
    try {
      const includeObjects = this.settings.includeObjectsInLive;
      const response = await session.customRequest('orbitRtosSnapshot', {
        action: 'start',
        intervalMs: this.settings.liveIntervalMs,
        detailBudgetBytes: this.settings.detailBudgetBytes,
        ...(includeObjects ? {
          includeObjects: true,
          includeWaitDetails: this.settings.tasksSubTab === 'objects',
          includeTimers: true,
          includeHeap: true,
        } : {}),
      });
      if (!this.isCurrentBinding(generation, session) || !this.settings.liveEnabled || !this.isVisible) {
        void session.customRequest('orbitRtosSnapshot', { action: 'stop' }).then(undefined, () => {});
        return;
      }
      if (response?.started) {
        this.liveStartedSession = session;
        this.liveActive = true;
        this.lastError = null;
        this.postState();
      } else if (response?.consistency === 'unavailable') {
        this.liveActive = false;
        this.handleUnavailableResponse(response);
      }
    } catch (error) {
      if (!this.isCurrentBinding(generation, session)) return;
      this.liveActive = false;
      this.lastError = { message: error instanceof Error ? error.message : String(error), at: Date.now() };
      this.postState();
    }
  }

  private async stopLivePolling(): Promise<void> {
    const session = this.liveStartedSession;
    const wasActive = this.liveActive;
    this.liveActive = false;
    this.liveStartedSession = undefined;
    if (wasActive && this.view) this.postState();
    if (session && !this.endedSessions.has(session)) {
      try {
        await session.customRequest('orbitRtosSnapshot', { action: 'stop' });
      } catch {
        // Session may already be terminating.
      }
    }
  }

  private async refreshSnapshot(options: {
    generation?: number;
    taskAddresses?: number[];
    maxBytesPerTask?: number;
    includeObjects?: boolean;
    includeWaitDetails?: boolean;
    objectAddresses?: number[];
    includeTimers?: boolean;
    includeHeap?: boolean;
    retryOnCoalescedScan?: boolean;
  } = {}): Promise<void> {
    const generation = options.generation ?? this.sessionGeneration;
    const session = this.activeSession;
    if (!session || !this.isCurrentBinding(generation, session)) return;
    if (!this.capabilities && !this.loading.capabilities) {
      await this.syncSessionConnection(generation);
      if (!this.isCurrentBinding(generation, session) || !this.capabilities) return;
    }

    const isStackScan = Array.isArray(options.taskAddresses) && options.taskAddresses.length > 0;
    const isObjectDetail = Array.isArray(options.objectAddresses) && options.objectAddresses.length > 0;
    const includeObjects = options.includeObjects ?? true;
    const includeWaitDetails = options.includeWaitDetails ?? (this.settings.tasksSubTab === 'objects' || isObjectDetail);
    const includeTimers = options.includeTimers ?? !isStackScan;
    const includeHeap = options.includeHeap ?? !isStackScan;
    this.loading.refresh = true;
    if (isStackScan) this.loading.stackScan = true;
    this.postState();

    try {
      const args: Record<string, unknown> = {
        action: 'refresh',
        detailBudgetBytes: this.settings.detailBudgetBytes,
        ...(includeObjects ? { includeObjects: true, includeWaitDetails } : {}),
        ...(includeTimers ? { includeTimers: true } : {}),
        ...(includeHeap ? { includeHeap: true } : {}),
      };
      if (isStackScan) {
        args.taskAddresses = options.taskAddresses;
        args.maxBytesPerTask = options.maxBytesPerTask ?? this.settings.maxStackScanBytes;
      }
      if (isObjectDetail) {
        args.objectAddresses = options.objectAddresses;
      }
      const response = await session.customRequest('orbitRtosSnapshot', args);
      if (!this.isCurrentBinding(generation, session)) return;
      if (response && response.version === 1) {
        if (response.consistency === 'unavailable') {
          this.handleUnavailableResponse(response);
          return;
        }
        this.applySnapshot(response as RtosSnapshot, generation);
        // An explicit on-demand stack scan or object detail request may coalesce
        // onto an already in-flight lightweight Live refresh. Re-issue once if needed.
        const coalescedStack = isStackScan && Array.isArray(response.tasks)
          && (response.tasks as RtosSnapshot['tasks']).some(task =>
            options.taskAddresses!.includes(task.tcbAddress)
            && !task.stack.watermarkBytes.available
            && task.stack.watermarkBytes.reason === 'Not requested');
        const coalescedObject = isObjectDetail && (!response.objects
          || response.objects.objects.some((obj: any) => options.objectAddresses!.includes(obj.address) && obj.waitListEvidence === 'summary-only'));
        if ((coalescedStack || coalescedObject) && options.retryOnCoalescedScan !== false) {
          await new Promise(resolve => setTimeout(resolve, 25));
          if (this.isCurrentBinding(generation, session)) {
            await this.refreshSnapshot({ ...options, generation, retryOnCoalescedScan: false });
          }
        }
      }
    } catch (error) {
      if (!this.isCurrentBinding(generation, session)) return;
      this.lastError = { message: error instanceof Error ? error.message : String(error), at: Date.now() };
      log.dap(`[rtos] refresh failed session=${session.id} error=${this.lastError.message}`);
    } finally {
      if (this.isCurrentBinding(generation, session)) {
        this.loading.refresh = false;
        this.loading.stackScan = false;
        this.postState();
      }
    }
  }

  private handleUnavailableResponse(response: any): void {
    const errorCode = typeof response.errorCode === 'string' ? response.errorCode : undefined;
    const message = typeof response.reason === 'string' ? response.reason : '快照不可用';
    if (errorCode && ['RtosNotDetected', 'DwarfUnavailable', 'LayoutIncomplete', 'LayoutAmbiguous', 'UnsupportedCapability'].includes(errorCode)) {
      this.sessionPhase = 'connected';
      this.capabilities = null;
      this.capabilitiesError = { errorCode, message, at: Date.now() };
      this.snapshot = null;
    } else if (errorCode === 'SessionChanged' && /No connected session/i.test(message)) {
      this.sessionPhase = 'starting';
    } else {
      this.lastError = { errorCode, message, at: Date.now() };
    }
    this.postState();
  }

  private applySnapshot(snapshot: RtosSnapshot, generation: number): void {
    if (generation !== this.sessionGeneration) return;
    this.sessionPhase = 'connected';
    this.expectedRtosSessionId = snapshot.sessionId || this.expectedRtosSessionId;
    this.expectedRtosSessionGeneration = snapshot.sessionGeneration ?? this.expectedRtosSessionGeneration;
    if (typeof snapshot.snapshotSequence === 'number') {
      this.lastSnapshotSequence = Math.max(this.lastSnapshotSequence, snapshot.snapshotSequence);
    }
    if (snapshot.targetState) this.targetState = snapshot.targetState;
    this.snapshot = snapshot;
    if (snapshot.issues?.length) {
      this.lastError = { errorCode: snapshot.issues[0].errorCode, message: snapshot.issues[0].message, at: Date.now() };
    } else if (snapshot.consistency === 'stale' && snapshot.reason) {
      this.lastError = { message: snapshot.reason, at: Date.now() };
    } else {
      this.lastError = null;
    }
    this.postState();
  }

  private async handleMessage(msg: any): Promise<void> {
    if (this.disposed || !msg || typeof msg !== 'object') return;
    switch (msg.command) {
      case 'ready':
        this._readyCount++;
        this.postState();
        if (this.activeSession && this.isVisible) {
          if (!this.capabilities) await this.syncSessionConnection(this.sessionGeneration);
          else if (this.settings.liveEnabled && !this.liveActive) await this.startLiveOnSession(this.sessionGeneration);
        }
        break;
      case 'refresh':
        this.capabilitiesError = null;
        await this.refreshSnapshot();
        break;
      case 'cancel':
        if (this.activeSession && !this.endedSessions.has(this.activeSession)) {
          try { await this.activeSession.customRequest('orbitRtosSnapshot', { action: 'cancel' }); } catch {}
        }
        this.loading.refresh = false;
        this.loading.stackScan = false;
        this.postState();
        break;
      case 'scanStack': {
        const addresses = msg.all
          ? (this.snapshot?.tasks.map(task => task.tcbAddress) || [])
          : Array.isArray(msg.taskAddresses)
            ? msg.taskAddresses.filter((address: unknown): address is number => typeof address === 'number' && Number.isSafeInteger(address) && address > 0)
            : [];
        if (addresses.length > 0) {
          await this.refreshSnapshot({
            taskAddresses: addresses,
            maxBytesPerTask: this.settings.maxStackScanBytes,
            includeObjects: false,
            includeTimers: false,
            includeHeap: false,
          });
        }
        break;
      }
      case 'inspectObject': {
        const addresses = msg.all
          ? undefined
          : Array.isArray(msg.objectAddresses)
            ? msg.objectAddresses.filter((address: unknown): address is number => typeof address === 'number' && Number.isSafeInteger(address) && address > 0)
            : (typeof msg.address === 'number' && Number.isSafeInteger(msg.address) && msg.address > 0 ? [msg.address] : undefined);
        await this.refreshSnapshot({
          includeObjects: true,
          includeWaitDetails: true,
          includeTimers: false,
          includeHeap: false,
          ...(addresses?.length ? { objectAddresses: addresses } : {}),
        });
        break;
      }
      case 'inspectTimersHeap':
        await this.refreshSnapshot({ includeObjects: false, includeTimers: true, includeHeap: true });
        break;
      case 'setLive': {
        const nextLive = Boolean(msg.enabled);
        const nextInterval = msg.intervalMs !== undefined ? msg.intervalMs : this.settings.liveIntervalMs;
        await this.updateSettings({ liveEnabled: nextLive, liveIntervalMs: nextInterval });
        if (nextLive && this.activeSession && this.isVisible) {
          if (!this.capabilities) await this.syncSessionConnection(this.sessionGeneration);
          else if (this.capabilities.capabilities.taskSnapshot.available) await this.startLiveOnSession(this.sessionGeneration);
        } else {
          await this.stopLivePolling();
        }
        break;
      }
      case 'updateSettings': {
        const previousInterval = this.settings.liveIntervalMs;
        const previousIncludeObjects = this.settings.includeObjectsInLive;
        const previousSubTab = this.settings.tasksSubTab;
        const previousBudget = this.settings.detailBudgetBytes;
        await this.updateSettings(msg.settings);
        if (this.liveActive && this.settings.liveEnabled && this.activeSession && this.isVisible
          && (this.settings.liveIntervalMs !== previousInterval
            || this.settings.includeObjectsInLive !== previousIncludeObjects
            || this.settings.detailBudgetBytes !== previousBudget
            || (this.settings.includeObjectsInLive && this.settings.tasksSubTab !== previousSubTab))) {
          await this.startLiveOnSession(this.sessionGeneration);
        } else if (this.settings.tasksSubTab === 'objects' && previousSubTab !== 'objects' && this.activeSession && this.isVisible
          && (!this.snapshot?.objects || this.snapshot.objects.objects.every(o => o.waitListEvidence === 'summary-only'))) {
          await this.refreshSnapshot({ includeObjects: true, includeWaitDetails: true, includeTimers: false, includeHeap: false });
        } else if (this.settings.tasksSubTab === 'timers' && previousSubTab !== 'timers' && this.activeSession && this.isVisible
          && (!this.snapshot?.timers || !this.snapshot?.heap)) {
          await this.refreshSnapshot({ includeObjects: false, includeTimers: true, includeHeap: true });
        }
        break;
      }
    }
  }

  private async updateSettings(patch: unknown): Promise<void> {
    const merged = patch && typeof patch === 'object'
      ? { ...this.settings, ...(patch as Record<string, unknown>) }
      : DEFAULT_RTOS_VIEW_SETTINGS;
    this.settings = sanitizeRtosViewSettings(merged, this.settings);
    this.postState();
    await this.context.workspaceState.update(RTOS_VIEW_SETTINGS_KEY, this.settings);
  }

  private postState(): void {
    this.hostVersion++;
    this.postMessage({ command: 'state', state: this.currentState });
  }

  private postMessage(msg: unknown): void {
    try {
      void this.view?.webview.postMessage(msg);
    } catch {
      // Ignore postMessage errors when webview is closing.
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'rtos.js'));
    const nonce = randomBytes(16).toString('hex');
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <style>
    body {
      margin: 0;
      padding: 0;
      font-family: var(--vscode-font-family, sans-serif);
      font-size: 12px;
      background: var(--vscode-panel-background, var(--vscode-editor-background));
      color: var(--vscode-foreground);
      overflow: hidden;
    }
    body.vscode-dark, body.vscode-high-contrast { color-scheme: dark; }
    body.vscode-light, body.vscode-high-contrast-light { color-scheme: light; }
    #root { height: 100vh; display: flex; flex-direction: column; }
  </style>
  <title>Orbit RTOS</title>
</head>
<body>
  <div id="root">正在加载 RTOS 视图…</div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.sessionGeneration++;
    void this.stopLivePolling();
    this.disposeViewListeners();
    this.view = null;
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
  }
}
