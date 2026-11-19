import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'crypto';
import type { RtosSnapshot } from '../../rtos/model';
import { AUTOMATION_CONTROL_EVENT, AUTOMATION_LIFECYCLE_EVENT } from '../../debug/dap-automation-protocol';
import { ORBIT_TRACE_FILES, type SegmentIndexMetadata } from '../../trace/trace-format';
import type { DecodedSystemViewPacket } from '../../trace/systemview-decoder';
import type {
  ContextActivationInterval,
  ExecutionSliceInterval,
  MarkerInterval,
  MarkerPointEvent,
  ReadyWaitInterval,
} from '../../trace/systemview-reconstructor';
import type { TraceRecordingCoordinator, TraceRecordingMode, TraceRecordingStatus } from '../../trace/trace-recording-coordinator';
import { isOrbitDebugSessionType } from '../../utils/debug-session-type';
import { log } from '../../utils/logger';
import {
  DEFAULT_RTOS_VIEW_SETTINGS,
  INITIAL_TRACE_PANEL_STATE,
  RTOS_VIEW_SETTINGS_KEY,
  RtosCapabilitiesPayload,
  RtosErrorSummary,
  RtosPanelState,
  RtosSessionPhase,
  RtosViewSettings,
  sanitizeRtosViewSettings,
} from './rtos-view-state';
import {
  projectActivationDto,
  projectGapDto,
  projectLodBucketDto,
  projectMarkerDto,
  projectMarkerPointDto,
  projectPacketDto,
  projectRecordFromOpened,
  projectRecordFromStatus,
  projectReadyWaitDto,
  projectSegmentDto,
  projectSliceDto,
  projectTargetProbeState,
} from './trace-dto';
import type { TraceEventCategoryFilter, TraceTerminalLevelFilter } from '../../trace/trace-events';
import type {
  TraceAnalysisResponse,
  TraceAnalysisSourceKind,
  TraceDiagnosticsResponse,
  TraceEventLocateResponse,
  TraceEventsResponse,
  TracePanelState,
  TracePointInspectResponse,
  TraceRecordSummary,
  TraceTargetProbeState,
  TraceTerminalResponse,
  TraceTimeUnit,
  TraceViewportResponse,
} from './trace-timeline-state';

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

  // Stage 4.5 Trace Timeline coordinator & query cancellation state
  private traceRecords = new Map<string, TraceRecordSummary>();
  private traceSegmentsByRecord = new Map<string, readonly SegmentIndexMetadata[]>();
  private selectedTraceRecordId: string | null = null;
  private traceTargetProbe: TraceTargetProbeState | null = null;
  private traceProbing = false;
  private traceActionMessage: TracePanelState['lastActionMessage'] = null;
  private traceProbeGen = 0;
  private traceOfflineSeq = 0;
  private traceLiveTimer: NodeJS.Timeout | null = null;
  private traceLiveInFlight = false;
  private inFlightViewportAbort: AbortController | null = null;
  private latestViewportQuerySeq = 0;
  private viewportRequestEpoch = 0;
  private inFlightAnalysisAbort: AbortController | null = null;
  private latestAnalysisQuerySeq = 0;
  private analysisRequestEpoch = 0;
  private inFlightEventsAbort: AbortController | null = null;
  private latestEventsQuerySeq = 0;
  private eventsRequestEpoch = 0;
  private inFlightLocateAbort: AbortController | null = null;
  private latestLocateQuerySeq = 0;
  private locateRequestEpoch = 0;
  private inFlightTerminalAbort: AbortController | null = null;
  private latestTerminalQuerySeq = 0;
  private terminalRequestEpoch = 0;
  private readonly inFlightInspectAborts = new Map<'hover' | 'cursorA' | 'cursorB', AbortController>();
  private readonly latestInspectSeq = new Map<'hover' | 'cursorA' | 'cursorB', number>();
  private readonly inspectRequestEpoch = new Map<'hover' | 'cursorA' | 'cursorB', number>();
  private lastWebviewTracePerf: Record<string, unknown> | null = null;
  private _tracePerfSeq = 0;
  private lastWebviewContextsPerf: Record<string, unknown> | null = null;
  private _contextsPerfSeq = 0;
  private lastWebviewEventsPerf: Record<string, unknown> | null = null;
  private _eventsPerfSeq = 0;
  private lastWebviewTerminalPerf: Record<string, unknown> | null = null;
  private _terminalPerfSeq = 0;
  private uiTestActionSeq = 0;
  private readonly pendingUiTestActions = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (reason?: unknown) => void;
    timer: NodeJS.Timeout;
  }>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly traceCoordinator?: TraceRecordingCoordinator,
  ) {
    this.settings = sanitizeRtosViewSettings(context.workspaceState.get(RTOS_VIEW_SETTINGS_KEY));
    if (this.traceCoordinator) {
      const sub = this.traceCoordinator.onDidChangeStatus(status => {
        this.handleTraceStatusChange(status);
      });
      this.disposables.push(sub);
      for (const existing of this.traceCoordinator.listRecordings()) {
        this.traceRecords.set(
          existing.recordId,
          projectRecordFromStatus(existing, existing.state === 'recording' || existing.state === 'preparing' || existing.state === 'paused' || existing.state === 'stopping' ? 'live' : 'session', [], []),
        );
      }
      if (this.traceRecords.size > 0) {
        const lastKey = Array.from(this.traceRecords.keys()).pop() ?? null;
        this.selectedTraceRecordId = lastKey;
      }
    }
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

  get currentTraceState(): TracePanelState {
    if (!this.traceCoordinator && this.traceRecords.size === 0 && !this.traceTargetProbe && !this.traceActionMessage) {
      return INITIAL_TRACE_PANEL_STATE;
    }
    return {
      targetProbe: this.traceTargetProbe,
      probing: this.traceProbing,
      selectedRecordId: this.selectedTraceRecordId,
      records: Array.from(this.traceRecords.values()),
      lastActionMessage: this.traceActionMessage,
    };
  }

  get currentTracePerf(): Record<string, unknown> | null {
    return this.lastWebviewTracePerf;
  }

  get tracePerfSeq(): number {
    return this._tracePerfSeq;
  }

  get currentContextsPerf(): Record<string, unknown> | null {
    return this.lastWebviewContextsPerf;
  }

  get contextsPerfSeq(): number {
    return this._contextsPerfSeq;
  }

  get currentEventsPerf(): Record<string, unknown> | null {
    return this.lastWebviewEventsPerf;
  }

  get eventsPerfSeq(): number {
    return this._eventsPerfSeq;
  }

  get currentTerminalPerf(): Record<string, unknown> | null {
    return this.lastWebviewTerminalPerf;
  }

  get terminalPerfSeq(): number {
    return this._terminalPerfSeq;
  }

  public invokeUiAction(action: string, payload?: Record<string, unknown>, timeoutMs = 10000): Promise<unknown> {
    if (this.disposed || !this.view) {
      return Promise.reject(new Error('RTOS webview is not available'));
    }
    const requestId = ++this.uiTestActionSeq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingUiTestActions.delete(requestId);
        reject(new Error(`UI test action timed out: ${action}`));
      }, timeoutMs);
      this.pendingUiTestActions.set(requestId, { resolve, reject, timer });
      this.postMessage({ command: 'rtosUiTestAction', requestId, action, payload });
    });
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
      trace: this.currentTraceState,
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
          this.stopTraceLiveTimer();
          this.cancelAllTraceQueries();
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
      this.stopTraceLiveTimer();
      this.cancelAllTraceQueries();
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
      if (this.settings.activePage === 'trace' && this.traceCoordinator && !this.traceTargetProbe && !this.traceProbing) {
        void this.probeTraceTarget(this.sessionGeneration);
      }
    }
    this.syncTraceLiveTimer();
  }

  private bindSession(session: vscode.DebugSession | undefined): void {
    const valid = session && isOrbitDebugSessionType(session.type) && !this.endedSessions.has(session) ? session : undefined;
    if (valid === this.activeSession && (valid || this.sessionPhase === 'none')) return;

    void this.stopLivePolling();
    this.stopTraceLiveTimer();
    this.cancelAllTraceQueries();
    this.sessionGeneration++;
    this.traceProbeGen++;
    this.traceTargetProbe = null;
    this.traceProbing = false;
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
      if (this.settings.activePage === 'trace' && this.traceCoordinator) {
        void this.probeTraceTarget(this.sessionGeneration);
      }
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
        this.latestViewportQuerySeq = 0;
        this.latestAnalysisQuerySeq = 0;
        this.latestEventsQuerySeq = 0;
        this.latestLocateQuerySeq = 0;
        this.latestTerminalQuerySeq = 0;
        this.latestInspectSeq.clear();
        this.postState();
        if (this.activeSession && this.isVisible) {
          if (!this.capabilities) await this.syncSessionConnection(this.sessionGeneration);
          else if (this.settings.liveEnabled && !this.liveActive) await this.startLiveOnSession(this.sessionGeneration);
          if (this.settings.activePage === 'trace' && this.traceCoordinator && !this.traceTargetProbe && !this.traceProbing) {
            void this.probeTraceTarget(this.sessionGeneration);
          }
        }
        this.syncTraceLiveTimer();
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
        const previousPage = this.settings.activePage;
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
        if ((this.settings.activePage === 'trace' || this.settings.activePage === 'contexts') && previousPage !== this.settings.activePage) {
          if (this.activeSession && this.isVisible && this.traceCoordinator && !this.traceTargetProbe && !this.traceProbing) {
            void this.probeTraceTarget(this.sessionGeneration);
          }
          if (this.selectedTraceRecordId) {
            void this.refreshTraceRecordMeta(this.selectedTraceRecordId);
          }
        }
        this.syncTraceLiveTimer();
        break;
      }
      case 'traceInspectTarget':
        await this.probeTraceTarget(this.sessionGeneration);
        break;
      case 'traceStart':
        await this.handleTraceStart(msg.mode);
        break;
      case 'traceStop':
        await this.handleTraceStop(typeof msg.recordId === 'string' ? msg.recordId : undefined);
        break;
      case 'tracePause':
        await this.handleTracePauseResume(true, typeof msg.recordId === 'string' ? msg.recordId : undefined);
        break;
      case 'traceResume':
        await this.handleTracePauseResume(false, typeof msg.recordId === 'string' ? msg.recordId : undefined);
        break;
      case 'traceCancel':
        await this.handleTraceCancel(typeof msg.recordId === 'string' ? msg.recordId : undefined);
        break;
      case 'traceSelectRecord':
        await this.handleTraceSelectRecord(typeof msg.recordId === 'string' ? msg.recordId : '');
        break;
      case 'traceOpenRecording':
        await this.handleTraceOpenRecording(typeof msg.recordingDir === 'string' ? msg.recordingDir : undefined);
        break;
      case 'traceSaveRecording':
        await this.handleTraceSaveRecording(
          typeof msg.recordId === 'string' ? msg.recordId : (this.selectedTraceRecordId || ''),
          typeof msg.targetDir === 'string' ? msg.targetDir : undefined,
        );
        break;
      case 'traceCloseRecording':
        await this.handleTraceCloseRecording(typeof msg.recordId === 'string' ? msg.recordId : '');
        break;
      case 'traceQueryViewport':
        await this.handleTraceQueryViewport(msg);
        break;
      case 'traceQueryAnalysis':
        await this.handleTraceQueryAnalysis(msg);
        break;
      case 'traceQueryEvents':
        await this.handleTraceQueryEvents(msg);
        break;
      case 'traceLocateEvent':
        await this.handleTraceLocateEvent(msg);
        break;
      case 'traceQueryTerminal':
        await this.handleTraceQueryTerminal(msg);
        break;
      case 'traceGetDiagnostics':
        await this.handleTraceGetDiagnostics(msg);
        break;
      case 'traceInspectPoint':
        await this.handleTraceInspectPoint(msg);
        break;
      case 'tracePerfReport':
        if (msg.perf && typeof msg.perf === 'object') {
          this.lastWebviewTracePerf = msg.perf as Record<string, unknown>;
          this._tracePerfSeq++;
        }
        break;
      case 'contextsPerfReport':
        if (msg.perf && typeof msg.perf === 'object') {
          this.lastWebviewContextsPerf = msg.perf as Record<string, unknown>;
          this._contextsPerfSeq++;
        }
        break;
      case 'eventsPerfReport':
        if (msg.perf && typeof msg.perf === 'object') {
          this.lastWebviewEventsPerf = msg.perf as Record<string, unknown>;
          this._eventsPerfSeq++;
        }
        break;
      case 'terminalPerfReport':
        if (msg.perf && typeof msg.perf === 'object') {
          this.lastWebviewTerminalPerf = msg.perf as Record<string, unknown>;
          this._terminalPerfSeq++;
        }
        break;
      case 'rtosUiTestActionResult': {
        const requestId = typeof msg.requestId === 'number' ? msg.requestId : -1;
        const pending = this.pendingUiTestActions.get(requestId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingUiTestActions.delete(requestId);
          if (msg.ok) {
            pending.resolve(msg.data);
          } else {
            pending.reject(new Error(typeof msg.error === 'string' ? msg.error : 'UI action failed'));
          }
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
    this.traceProbeGen++;
    void this.stopLivePolling();
    this.stopTraceLiveTimer();
    this.cancelAllTraceQueries();
    this.disposeViewListeners();
    this.view = null;
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
  }

  // --- Stage 4.5 Trace Timeline coordinator & query methods ----------------

  private cancelAllTraceQueries(): void {
    this.inFlightViewportAbort?.abort();
    this.inFlightViewportAbort = null;
    this.inFlightAnalysisAbort?.abort();
    this.inFlightAnalysisAbort = null;
    this.inFlightEventsAbort?.abort();
    this.inFlightEventsAbort = null;
    this.inFlightLocateAbort?.abort();
    this.inFlightLocateAbort = null;
    this.inFlightTerminalAbort?.abort();
    this.inFlightTerminalAbort = null;
    for (const ctrl of this.inFlightInspectAborts.values()) {
      ctrl.abort();
    }
    this.inFlightInspectAborts.clear();
  }

  private handleTraceStatusChange(status: TraceRecordingStatus): void {
    if (this.disposed) return;
    const isActive = status.state === 'preparing' || status.state === 'recording' || status.state === 'paused' || status.state === 'stopping';
    const existing = this.traceRecords.get(status.recordId);
    const segs = this.traceSegmentsByRecord.get(status.recordId) ?? [];
    const gaps = existing?.gaps ?? [];
    const summary = projectRecordFromStatus(status, isActive ? 'live' : 'session', segs, []);
    const merged: TraceRecordSummary = existing && segs.length === 0 && existing.segments.length > 0
      ? { ...summary, segments: existing.segments, gaps }
      : { ...summary, gaps };

    this.traceRecords.set(status.recordId, merged);
    if (status.state === 'preparing' || status.state === 'recording') {
      this.selectedTraceRecordId = status.recordId;
    } else if (!this.selectedTraceRecordId) {
      this.selectedTraceRecordId = status.recordId;
    }

    if (status.state === 'stopped' || status.state === 'incomplete' || status.state === 'error') {
      this.stopTraceLiveTimer();
      if (status.counters.committedRawBytes > 0) {
        void this.refreshTraceRecordMeta(status.recordId);
      }
    } else if (status.state === 'recording') {
      this.syncTraceLiveTimer();
    }
    this.postState();
  }

  private syncTraceLiveTimer(): void {
    const hasRecordingActive = Array.from(this.traceRecords.values()).some(r => r.state === 'recording');
    const onTracePage = this.settings.activePage === 'trace' || this.settings.activePage === 'contexts';
    if (this.disposed || !this.isVisible || !onTracePage || !hasRecordingActive || !this.traceCoordinator) {
      this.stopTraceLiveTimer();
      return;
    }
    if (this.traceLiveTimer) return;
    this.traceLiveTimer = setInterval(() => {
      void this.tickTraceLiveRefresh();
    }, 350);
  }

  private stopTraceLiveTimer(): void {
    if (this.traceLiveTimer) {
      clearInterval(this.traceLiveTimer);
      this.traceLiveTimer = null;
    }
  }

  private async tickTraceLiveRefresh(): Promise<void> {
    const onTracePage = this.settings.activePage === 'trace' || this.settings.activePage === 'contexts';
    if (this.disposed || !this.isVisible || !onTracePage || !this.traceCoordinator) {
      this.stopTraceLiveTimer();
      return;
    }
    if (this.traceLiveInFlight) return;
    const activeLive = Array.from(this.traceRecords.values()).find(r => r.state === 'recording');
    if (!activeLive) {
      this.stopTraceLiveTimer();
      return;
    }
    this.traceLiveInFlight = true;
    try {
      const status = this.traceCoordinator.getStatus(activeLive.recordId);
      if (!status || status.state !== 'recording') {
        if (status) this.handleTraceStatusChange(status);
        this.stopTraceLiveTimer();
        return;
      }
      if (status.counters.bytesReceived > status.counters.committedRawBytes) {
        await this.traceCoordinator.flushRecording(status.recordId).catch(() => {});
      }
      await this.refreshTraceRecordMeta(status.recordId);
    } finally {
      this.traceLiveInFlight = false;
    }
  }

  private async refreshTraceRecordMeta(recordId: string): Promise<void> {
    if (!this.traceCoordinator || this.disposed) return;
    const existing = this.traceRecords.get(recordId);
    if (!existing) return;
    try {
      const [segsRes, gapsRes] = await Promise.all([
        this.traceCoordinator.getSegments(recordId),
        this.traceCoordinator.getGaps(recordId),
      ]);
      if (this.disposed) return;
      const latestStatus = this.traceCoordinator.getStatus(recordId);
      const current = this.traceRecords.get(recordId) ?? existing;
      const rawSegs = segsRes.ok ? segsRes.data : (this.traceSegmentsByRecord.get(recordId) ?? []);
      if (segsRes.ok) {
        this.traceSegmentsByRecord.set(recordId, segsRes.data);
      }
      const nextSegDtos = segsRes.ok ? segsRes.data.map(projectSegmentDto) : current.segments;
      const nextGapDtos = gapsRes.ok ? gapsRes.data.map(projectGapDto) : current.gaps;

      let updated: TraceRecordSummary;
      if (latestStatus && current.source !== 'offline') {
        const isActive = latestStatus.state === 'preparing' || latestStatus.state === 'recording'
          || latestStatus.state === 'paused' || latestStatus.state === 'stopping';
        updated = projectRecordFromStatus(
          latestStatus,
          isActive ? 'live' : 'session',
          rawSegs,
          gapsRes.ok ? gapsRes.data : [],
        );
        if (!gapsRes.ok) updated = { ...updated, gaps: nextGapDtos };
      } else {
        updated = {
          ...current,
          segments: nextSegDtos,
          gaps: nextGapDtos,
        };
      }
      this.traceRecords.set(recordId, updated);
      this.postMessage({ command: 'traceRecordMeta', record: updated });
    } catch {
      // Ignore metadata refresh failures while closing/terminating.
    }
  }

  private async probeTraceTarget(generation: number): Promise<void> {
    const session = this.activeSession;
    if (!this.traceCoordinator || !session || !this.isCurrentBinding(generation, session)) {
      this.traceTargetProbe = null;
      this.traceProbing = false;
      this.postState();
      return;
    }
    const probeGen = ++this.traceProbeGen;
    this.traceProbing = true;
    this.postState();
    try {
      const res = await this.traceCoordinator.inspectTarget({ includeEnumerate: true, timeoutMs: 2500 });
      if (this.disposed || probeGen !== this.traceProbeGen || !this.isCurrentBinding(generation, session)) return;
      this.traceTargetProbe = projectTargetProbeState(res);
    } catch (err) {
      if (this.disposed || probeGen !== this.traceProbeGen || !this.isCurrentBinding(generation, session)) return;
      this.traceTargetProbe = {
        ok: false,
        errorCode: 'InspectFailed',
        message: err instanceof Error ? err.message : String(err),
        inspectedAtMs: Date.now(),
      };
    } finally {
      if (!this.disposed && probeGen === this.traceProbeGen) {
        this.traceProbing = false;
        this.postState();
      }
    }
  }

  private async handleTraceStart(modeRaw: unknown): Promise<void> {
    if (!this.traceCoordinator) {
      this.setTraceActionMessage('error', 'Trace 协调器未初始化');
      return;
    }
    const mode: TraceRecordingMode = modeRaw === 'single-shot' || modeRaw === 'post-mortem' ? modeRaw : 'continuous';
    await this.updateSettings({ traceMode: mode });
    this.traceActionMessage = null;
    try {
      const status = await this.traceCoordinator.startRecording({ mode });
      this.handleTraceStatusChange(status);
      if (status.state === 'error' || status.state === 'incomplete') {
        this.setTraceActionMessage('error', `${status.error?.errorCode ?? status.state}: ${status.error?.message ?? status.stateReason}`);
      } else {
        this.setTraceActionMessage('ok', status.stateReason);
      }
      if (status.counters.committedRawBytes > 0) {
        await this.refreshTraceRecordMeta(status.recordId);
      }
    } catch (err) {
      this.setTraceActionMessage('error', err instanceof Error ? err.message : String(err));
    }
  }

  private async handleTraceStop(recordId?: string): Promise<void> {
    if (!this.traceCoordinator) return;
    try {
      const status = await this.traceCoordinator.stopRecording(recordId);
      if (status) {
        this.handleTraceStatusChange(status);
        const tone = status.state === 'stopped' ? 'ok' : status.state === 'incomplete' ? 'warn' : 'error';
        this.setTraceActionMessage(tone, status.error ? `${status.error.errorCode}: ${status.error.message}` : status.stateReason);
      }
    } catch (err) {
      this.setTraceActionMessage('error', err instanceof Error ? err.message : String(err));
    }
  }

  private async handleTracePauseResume(pause: boolean, recordId?: string): Promise<void> {
    if (!this.traceCoordinator) return;
    try {
      const status = pause
        ? await this.traceCoordinator.pauseReceiving(recordId)
        : await this.traceCoordinator.resumeReceiving(recordId);
      if (status) {
        this.handleTraceStatusChange(status);
        this.setTraceActionMessage('info', status.stateReason);
      }
    } catch (err) {
      this.setTraceActionMessage('error', err instanceof Error ? err.message : String(err));
    }
  }

  private async handleTraceCancel(recordId?: string): Promise<void> {
    if (!this.traceCoordinator) return;
    try {
      const status = await this.traceCoordinator.cancelRecording(recordId);
      if (status) {
        this.handleTraceStatusChange(status);
        this.setTraceActionMessage('warn', status.stateReason);
      }
    } catch (err) {
      this.setTraceActionMessage('error', err instanceof Error ? err.message : String(err));
    }
  }

  private async handleTraceSelectRecord(recordId: string): Promise<void> {
    if (!recordId || !this.traceRecords.has(recordId)) return;
    if (this.selectedTraceRecordId !== recordId) {
      this.cancelAllTraceQueries();
      this.selectedTraceRecordId = recordId;
      this.postState();
    }
    await this.refreshTraceRecordMeta(recordId);
  }

  private async handleTraceOpenRecording(explicitDir?: string): Promise<void> {
    if (!this.traceCoordinator) {
      this.setTraceActionMessage('error', 'Trace 协调器未初始化');
      return;
    }
    let dir = explicitDir?.trim();
    if (!dir) {
      const picked = await vscode.window?.showOpenDialog?.({
        canSelectFiles: true,
        canSelectFolders: true,
        canSelectMany: false,
        filters: { 'Orbit Trace Manifest': ['json'] },
        openLabel: '打开 Orbit Trace 录制目录或 manifest.json',
      });
      if (!picked || picked.length === 0) return;
      const fsPath = picked[0].fsPath;
      try {
        const st = await fs.stat(fsPath);
        dir = st.isDirectory() ? fsPath : path.dirname(fsPath);
      } catch {
        dir = fsPath;
      }
    }
    const resolvedDir = path.resolve(dir);

    // If this exact offline directory is already open, reuse/focus it cleanly.
    for (const [id, rec] of this.traceRecords.entries()) {
      if (rec.source === 'offline' && rec.recordingDir && path.resolve(rec.recordingDir) === resolvedDir) {
        await this.handleTraceSelectRecord(id);
        this.setTraceActionMessage('info', `已切换到已打开的离线录制: ${resolvedDir}`);
        return;
      }
    }

    const baseName = path.basename(resolvedDir).replace(/[^A-Za-z0-9._-]/g, '_') || 'recording';
    const viewRecordId = `offline-${++this.traceOfflineSeq}-${baseName}`;
    const openRes = await this.traceCoordinator.openRecording(resolvedDir, viewRecordId, true);
    if (!openRes.ok) {
      this.setTraceActionMessage('error', `打开离线录制失败 (${openRes.errorCode}): ${openRes.message}`);
      this.postMessage({ command: 'traceActionResult', ok: false, action: 'open', errorCode: openRes.errorCode, message: openRes.message });
      return;
    }
    const [segsRes, gapsRes] = await Promise.all([
      this.traceCoordinator.getSegments(viewRecordId),
      this.traceCoordinator.getGaps(viewRecordId),
    ]);
    if (this.disposed) return;
    const rawSegs = segsRes.ok ? segsRes.data : [];
    const rawGaps = gapsRes.ok ? gapsRes.data : [];
    this.traceSegmentsByRecord.set(viewRecordId, rawSegs);

    const summary = projectRecordFromOpened(openRes.data, resolvedDir, rawSegs, rawGaps);
    this.traceRecords.set(viewRecordId, summary);
    this.cancelAllTraceQueries();
    this.selectedTraceRecordId = viewRecordId;
    const tone = summary.inspectionStatus === 'completed' ? 'ok' : summary.inspectionStatus === 'corrupted' ? 'error' : 'warn';
    this.setTraceActionMessage(tone, `已打开离线录制 (${summary.inspectionStatus}): ${resolvedDir}`);
    this.postMessage({ command: 'traceRecordMeta', record: summary });
    this.postMessage({
      command: 'traceActionResult',
      ok: true,
      action: 'open',
      recordId: viewRecordId,
      recordingDir: resolvedDir,
      inspectionStatus: summary.inspectionStatus,
    });
  }

  private async handleTraceSaveRecording(recordId: string, explicitTargetDir?: string): Promise<void> {
    if (!this.traceCoordinator) return;
    const rec = this.traceRecords.get(recordId);
    if (!rec || !rec.recordingDir) {
      this.setTraceActionMessage('error', '当前选中的录制没有可保存的归档目录');
      return;
    }
    if (rec.state === 'recording' || rec.state === 'preparing' || rec.state === 'stopping' || rec.state === 'paused') {
      this.setTraceActionMessage('warn', '请先停止当前录制，待归档封存完成后再保存副本');
      return;
    }
    let targetDir = explicitTargetDir?.trim();
    if (!targetDir) {
      const defaultUri = vscode.Uri.file(path.join(path.dirname(rec.recordingDir), `${rec.recordId}-saved`));
      const picked = await vscode.window?.showSaveDialog?.({
        defaultUri,
        saveLabel: '保存 Orbit Trace 归档目录',
        title: '选择保存 Orbit Trace 录制的目标目录',
      });
      if (!picked) return;
      targetDir = picked.fsPath;
    }
    const srcDir = path.resolve(rec.recordingDir);
    const dstDir = path.resolve(targetDir);
    if (srcDir.toLowerCase() === dstDir.toLowerCase()) {
      this.setTraceActionMessage('warn', '目标目录与源录制目录相同，无需复制');
      return;
    }

    try {
      try {
        const entries = await fs.readdir(dstDir);
        if (entries.length > 0) {
          this.setTraceActionMessage('error', `目标目录非空，拒绝覆盖既有文件: ${dstDir}`);
          this.postMessage({ command: 'traceActionResult', ok: false, action: 'save', errorCode: 'RecordingDirectoryNotEmpty', message: `目标目录非空: ${dstDir}` });
          return;
        }
      } catch (err: any) {
        if (err?.code !== 'ENOENT') throw err;
        await fs.mkdir(dstDir, { recursive: true });
      }

      const candidateFiles = [
        ORBIT_TRACE_FILES.manifest,
        ORBIT_TRACE_FILES.raw,
        ORBIT_TRACE_FILES.data,
        ORBIT_TRACE_FILES.journal,
        ORBIT_TRACE_FILES.index,
        'index-spill.otidx',
      ];
      for (const name of candidateFiles) {
        const srcFile = path.join(srcDir, name);
        try {
          await fs.access(srcFile);
          await fs.copyFile(srcFile, path.join(dstDir, name));
        } catch (err: any) {
          if (err?.code !== 'ENOENT') throw err;
        }
      }

      const inspectRes = await this.traceCoordinator.inspectRecordingDirectory(dstDir, true);
      if (!inspectRes.ok) {
        this.setTraceActionMessage('error', `保存后校验失败 (${inspectRes.errorCode}): ${inspectRes.message}`);
        this.postMessage({ command: 'traceActionResult', ok: false, action: 'save', errorCode: inspectRes.errorCode, message: inspectRes.message });
        return;
      }
      const st = inspectRes.data.status;
      this.setTraceActionMessage(
        st === 'completed' ? 'ok' : 'warn',
        `已保存录制归档到 ${dstDir}（校验=${st}, ${inspectRes.data.recoverableRawBytes} B）`,
      );
      this.postMessage({
        command: 'traceActionResult',
        ok: true,
        action: 'save',
        recordId,
        targetDir: dstDir,
        inspectionStatus: st,
        recoverableRawBytes: inspectRes.data.recoverableRawBytes,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.setTraceActionMessage('error', `保存录制失败: ${message}`);
      this.postMessage({ command: 'traceActionResult', ok: false, action: 'save', errorCode: 'SaveFailed', message });
    }
  }

  private async handleTraceCloseRecording(recordId: string): Promise<void> {
    if (!this.traceCoordinator || !recordId) return;
    const rec = this.traceRecords.get(recordId);
    if (!rec) return;
    if (rec.state === 'recording' || rec.state === 'preparing' || rec.state === 'paused' || rec.state === 'stopping') {
      this.setTraceActionMessage('warn', '活动录制请使用“停止录制”');
      return;
    }
    if (this.selectedTraceRecordId === recordId) {
      this.cancelAllTraceQueries();
    }
    await this.traceCoordinator.closeRecording(recordId).catch(() => {});
    this.traceRecords.delete(recordId);
    this.traceSegmentsByRecord.delete(recordId);
    if (this.selectedTraceRecordId === recordId) {
      const next = Array.from(this.traceRecords.keys()).pop() ?? null;
      this.selectedTraceRecordId = next;
    }
    this.postState();
  }

  private async handleTraceQueryViewport(msg: any): Promise<void> {
    if (!this.traceCoordinator || this.disposed) return;
    const querySeq = Number(msg.querySeq);
    const recordId = typeof msg.recordId === 'string' ? msg.recordId : '';
    const unit: TraceTimeUnit = msg.unit === 'relative-ns' || msg.unit === 'absolute-ticks' || msg.unit === 'relative-ticks' ? msg.unit : 'ns';
    const scopeKey = typeof msg.scopeKey === 'string' ? msg.scopeKey : 'all-anchored';
    const bootGeneration = typeof msg.bootGeneration === 'number' ? msg.bootGeneration : undefined;
    const segmentId = typeof msg.segmentId === 'number' ? msg.segmentId : undefined;
    const start = String(msg.start ?? '0');
    const end = String(msg.end ?? '0');
    const maxBuckets = Math.max(32, Math.min(1024, Number(msg.maxBuckets) || 256));
    const detailLimit = Math.max(100, Math.min(2000, Number(msg.detailLimit) || 1200));

    if (!recordId || !this.traceRecords.has(recordId)) return;
    if (Number.isFinite(querySeq)) {
      this.latestViewportQuerySeq = querySeq;
    }
    const myEpoch = ++this.viewportRequestEpoch;

    this.inFlightViewportAbort?.abort();
    const controller = new AbortController();
    this.inFlightViewportAbort = controller;
    const t0 = performance.now();

    try {
      const lodRes = await this.traceCoordinator.queryLod(
        recordId,
        {
          start,
          end,
          unit,
          maxBuckets,
          ...(bootGeneration !== undefined ? { bootGeneration } : {}),
          ...(segmentId !== undefined ? { segmentId } : {}),
        },
        { signal: controller.signal },
      );

      if (controller.signal.aborted || this.disposed || this.selectedTraceRecordId !== recordId) {
        return;
      }
      if (!lodRes.ok) {
        if (lodRes.cancelled) return;
        const result: TraceViewportResponse = {
          querySeq,
          recordId,
          unit,
          scopeKey,
          bootGeneration,
          segmentId,
          start,
          end,
          lodBuckets: [],
          usedFineItems: false,
          slices: [],
          activations: [],
          readyWaits: [],
          markers: [],
          markerPoints: [],
          truncated: false,
          skippedUnanchoredSegments: [],
          skippedNoFrequencySegments: [],
          queryDurationMs: Math.round((performance.now() - t0) * 100) / 100,
          error: `${lodRes.errorCode}: ${lodRes.message}`,
        };
        this.postMessage({ command: 'traceViewportResult', result });
        return;
      }

      const lodBuckets = lodRes.data.buckets.map(projectLodBucketDto);
      const totalEstimatedIntervals = lodBuckets.reduce((acc, b) => acc + b.intervalCount, 0);
      const isVeryDense = !lodRes.data.usedFineItems && totalEstimatedIntervals > detailLimit * 4;
      const effectiveLimit = isVeryDense ? Math.min(400, detailLimit) : detailLimit;

      const commonRange = {
        start,
        end,
        unit,
        ...(bootGeneration !== undefined ? { bootGeneration } : {}),
        ...(segmentId !== undefined ? { segmentId } : {}),
        limit: effectiveLimit,
      } as const;

      const [slicesRes, actsRes, readyRes, markersRes, markerPtsRes, segsRes] = await Promise.all([
        this.traceCoordinator.queryRange<ExecutionSliceInterval>(recordId, { ...commonRange, target: 'slices' }, { signal: controller.signal }),
        this.traceCoordinator.queryRange<ContextActivationInterval>(recordId, { ...commonRange, target: 'activations' }, { signal: controller.signal }),
        this.traceCoordinator.queryRange<ReadyWaitInterval>(recordId, { ...commonRange, target: 'readyWaits' }, { signal: controller.signal }),
        this.traceCoordinator.queryRange<MarkerInterval>(recordId, { ...commonRange, target: 'markers' }, { signal: controller.signal }),
        this.traceCoordinator.queryRange<MarkerPointEvent>(recordId, { ...commonRange, target: 'markerPoints' }, { signal: controller.signal }),
        this.traceCoordinator.getSegments(recordId),
      ]);

      if (controller.signal.aborted || this.disposed || this.selectedTraceRecordId !== recordId) {
        return;
      }
      if (myEpoch !== this.viewportRequestEpoch) {
        return;
      }

      const segList = segsRes.ok ? segsRes.data : (this.traceSegmentsByRecord.get(recordId) ?? []);
      if (segsRes.ok) this.traceSegmentsByRecord.set(recordId, segsRes.data);
      const segMap = new Map<string, SegmentIndexMetadata>();
      for (const s of segList) segMap.set(`${s.bootGeneration}:${s.segmentId}`, s);

      const slices = slicesRes.ok ? slicesRes.data.items.map(s => projectSliceDto(s, segMap)) : [];
      const activations = actsRes.ok ? actsRes.data.items.map(a => projectActivationDto(a, segMap)) : [];
      const readyWaits = readyRes.ok ? readyRes.data.items.map(r => projectReadyWaitDto(r, segMap)) : [];
      const markers = markersRes.ok ? markersRes.data.items.map(m => projectMarkerDto(m, segMap)) : [];
      const markerPoints = markerPtsRes.ok ? markerPtsRes.data.items.map(mp => projectMarkerPointDto(mp, segMap)) : [];
      const truncated = Boolean(
        (slicesRes.ok && slicesRes.data.hasMore)
        || (actsRes.ok && actsRes.data.hasMore)
        || (readyRes.ok && readyRes.data.hasMore)
        || (markersRes.ok && markersRes.data.hasMore)
        || (markerPtsRes.ok && markerPtsRes.data.hasMore)
        || isVeryDense,
      );

      const result: TraceViewportResponse = {
        querySeq,
        recordId,
        unit,
        scopeKey,
        bootGeneration,
        segmentId,
        start: lodRes.data.start,
        end: lodRes.data.end,
        lodBuckets,
        usedFineItems: lodRes.data.usedFineItems,
        slices,
        activations,
        readyWaits,
        markers,
        markerPoints,
        truncated,
        skippedUnanchoredSegments: lodRes.data.skippedUnanchoredSegments,
        skippedNoFrequencySegments: lodRes.data.skippedNoFrequencySegments,
        queryDurationMs: Math.round((performance.now() - t0) * 100) / 100,
      };
      this.postMessage({ command: 'traceViewportResult', result });
    } catch (err) {
      if (controller.signal.aborted || this.disposed) return;
      const result: TraceViewportResponse = {
        querySeq,
        recordId,
        unit,
        scopeKey,
        bootGeneration,
        segmentId,
        start,
        end,
        lodBuckets: [],
        usedFineItems: false,
        slices: [],
        activations: [],
        readyWaits: [],
        markers: [],
        markerPoints: [],
        truncated: false,
        skippedUnanchoredSegments: [],
        skippedNoFrequencySegments: [],
        queryDurationMs: Math.round((performance.now() - t0) * 100) / 100,
        error: err instanceof Error ? err.message : String(err),
      };
      this.postMessage({ command: 'traceViewportResult', result });
    } finally {
      if (this.inFlightViewportAbort === controller) {
        this.inFlightViewportAbort = null;
      }
    }
  }

  private async handleTraceQueryAnalysis(msg: any): Promise<void> {
    if (!this.traceCoordinator || this.disposed) return;
    const querySeq = Number(msg.querySeq);
    const recordId = typeof msg.recordId === 'string' ? msg.recordId : '';
    const unit: TraceTimeUnit = msg.unit === 'relative-ns' || msg.unit === 'absolute-ticks' || msg.unit === 'relative-ticks' ? msg.unit : 'ns';
    const scopeKey = typeof msg.scopeKey === 'string' ? msg.scopeKey : 'all-anchored';
    const sourceKind: TraceAnalysisSourceKind = msg.sourceKind === 'selection' || msg.sourceKind === 'full' ? msg.sourceKind : 'viewport';
    const bootGeneration = typeof msg.bootGeneration === 'number' ? msg.bootGeneration : undefined;
    const segmentId = typeof msg.segmentId === 'number' ? msg.segmentId : undefined;
    const start = String(msg.start ?? '0');
    const end = String(msg.end ?? '0');
    const maxBins = Math.max(1, Math.min(512, Number(msg.maxBins) || 120));

    if (!recordId || !this.traceRecords.has(recordId)) return;
    if (Number.isFinite(querySeq)) {
      this.latestAnalysisQuerySeq = querySeq;
    }
    const myEpoch = ++this.analysisRequestEpoch;

    this.inFlightAnalysisAbort?.abort();
    const controller = new AbortController();
    this.inFlightAnalysisAbort = controller;
    const t0 = performance.now();

    try {
      const anaRes = await this.traceCoordinator.queryAnalysis(
        recordId,
        {
          start,
          end,
          unit,
          maxBins,
          maxContexts: 256,
          maxMarkers: 256,
          ...(bootGeneration !== undefined ? { bootGeneration } : {}),
          ...(segmentId !== undefined ? { segmentId } : {}),
        },
        { signal: controller.signal },
      );

      if (controller.signal.aborted || this.disposed || this.selectedTraceRecordId !== recordId) {
        return;
      }
      if (myEpoch !== this.analysisRequestEpoch) {
        return;
      }

      if (!anaRes.ok) {
        if (anaRes.cancelled) return;
        const result: TraceAnalysisResponse = {
          querySeq,
          recordId,
          unit,
          scopeKey,
          sourceKind,
          start,
          end,
          queryDurationMs: Math.round((performance.now() - t0) * 100) / 100,
          error: `${anaRes.errorCode}: ${anaRes.message}`,
        };
        this.postMessage({ command: 'traceAnalysisResult', result });
        return;
      }

      const result: TraceAnalysisResponse = {
        querySeq,
        recordId,
        unit,
        scopeKey,
        sourceKind,
        start: anaRes.data.start,
        end: anaRes.data.end,
        analysis: anaRes.data,
        queryDurationMs: Math.round((performance.now() - t0) * 100) / 100,
      };
      this.postMessage({ command: 'traceAnalysisResult', result });
    } catch (err) {
      if (controller.signal.aborted || this.disposed) return;
      const result: TraceAnalysisResponse = {
        querySeq,
        recordId,
        unit,
        scopeKey,
        sourceKind,
        start,
        end,
        queryDurationMs: Math.round((performance.now() - t0) * 100) / 100,
        error: err instanceof Error ? err.message : String(err),
      };
      this.postMessage({ command: 'traceAnalysisResult', result });
    } finally {
      if (this.inFlightAnalysisAbort === controller) {
        this.inFlightAnalysisAbort = null;
      }
    }
  }

  private async handleTraceQueryEvents(msg: any): Promise<void> {
    if (!this.traceCoordinator || this.disposed) return;
    const querySeq = Number(msg.querySeq);
    const recordId = typeof msg.recordId === 'string' ? msg.recordId : '';
    const unit: TraceTimeUnit = msg.unit === 'relative-ns' || msg.unit === 'absolute-ticks' || msg.unit === 'relative-ticks' ? msg.unit : 'ns';
    const scopeKey = typeof msg.scopeKey === 'string' ? msg.scopeKey : 'all-anchored';
    const sourceKind: TraceAnalysisSourceKind = msg.sourceKind === 'selection' || msg.sourceKind === 'full' ? msg.sourceKind : 'viewport';
    const bootGeneration = typeof msg.bootGeneration === 'number' ? msg.bootGeneration : undefined;
    const segmentId = typeof msg.segmentId === 'number' ? msg.segmentId : undefined;
    const start = String(msg.start ?? '0');
    const end = String(msg.end ?? '0');
    const offset = Math.max(0, Math.floor(Number(msg.offset) || 0));
    const limit = Math.max(1, Math.min(500, Math.floor(Number(msg.limit) || 150)));
    const category: TraceEventCategoryFilter = typeof msg.category === 'string' ? (msg.category as TraceEventCategoryFilter) : 'all';
    const searchText = typeof msg.searchText === 'string' ? msg.searchText.slice(0, 128) : '';
    const contextKey = typeof msg.contextKey === 'string' && msg.contextKey ? msg.contextKey : undefined;
    const onlyWithDiagnostics = Boolean(msg.onlyWithDiagnostics);
    const maxScanPages = typeof msg.maxScanPages === 'number' && msg.maxScanPages > 0 ? Math.floor(msg.maxScanPages) : undefined;

    if (!recordId || !this.traceRecords.has(recordId)) return;
    if (Number.isFinite(querySeq)) {
      this.latestEventsQuerySeq = querySeq;
    }
    const myEpoch = ++this.eventsRequestEpoch;

    this.inFlightEventsAbort?.abort();
    const controller = new AbortController();
    this.inFlightEventsAbort = controller;
    const t0 = performance.now();

    const makeErrorResult = (error: string): TraceEventsResponse => ({
      querySeq,
      recordId,
      unit,
      scopeKey,
      sourceKind,
      category,
      searchText,
      ...(contextKey ? { contextKey } : {}),
      onlyWithDiagnostics,
      queryDurationMs: Math.round((performance.now() - t0) * 100) / 100,
      error,
    });

    try {
      const evRes = await this.traceCoordinator.queryEvents(
        recordId,
        {
          start,
          end,
          unit,
          offset,
          limit,
          ...(bootGeneration !== undefined ? { bootGeneration } : {}),
          ...(segmentId !== undefined ? { segmentId } : {}),
          ...(maxScanPages !== undefined ? { maxScanPages } : {}),
          filter: {
            category,
            searchText,
            ...(contextKey ? { contextKey } : {}),
            ...(onlyWithDiagnostics ? { onlyWithDiagnostics: true } : {}),
          },
        },
        { signal: controller.signal },
      );

      if (controller.signal.aborted || this.disposed || this.selectedTraceRecordId !== recordId) return;
      if (myEpoch !== this.eventsRequestEpoch) return;

      if (!evRes.ok) {
        if (evRes.cancelled) return;
        this.postMessage({ command: 'traceEventsResult', result: makeErrorResult(`${evRes.errorCode}: ${evRes.message}`) });
        return;
      }

      const result: TraceEventsResponse = {
        querySeq,
        recordId,
        unit,
        scopeKey,
        sourceKind,
        category,
        searchText,
        ...(contextKey ? { contextKey } : {}),
        onlyWithDiagnostics,
        result: evRes.data,
        queryDurationMs: Math.round((performance.now() - t0) * 100) / 100,
      };
      this.postMessage({ command: 'traceEventsResult', result });
    } catch (err) {
      if (controller.signal.aborted || this.disposed) return;
      this.postMessage({
        command: 'traceEventsResult',
        result: makeErrorResult(err instanceof Error ? err.message : String(err)),
      });
    } finally {
      if (this.inFlightEventsAbort === controller) {
        this.inFlightEventsAbort = null;
      }
    }
  }

  private async handleTraceLocateEvent(msg: any): Promise<void> {
    if (!this.traceCoordinator || this.disposed) return;
    const querySeq = Number(msg.querySeq);
    const recordId = typeof msg.recordId === 'string' ? msg.recordId : '';
    const unit: TraceTimeUnit = msg.unit === 'relative-ns' || msg.unit === 'absolute-ticks' || msg.unit === 'relative-ticks' ? msg.unit : 'ns';
    const bootGeneration = typeof msg.bootGeneration === 'number' ? msg.bootGeneration : undefined;
    const segmentId = typeof msg.segmentId === 'number' ? msg.segmentId : undefined;
    const start = String(msg.start ?? '0');
    const end = String(msg.end ?? '0');
    const targetTime = msg.targetTime !== undefined ? String(msg.targetTime) : undefined;
    const targetBootGeneration = typeof msg.targetBootGeneration === 'number' ? msg.targetBootGeneration : undefined;
    const targetSegmentId = typeof msg.targetSegmentId === 'number' ? msg.targetSegmentId : undefined;
    const targetPacketIndex = typeof msg.targetPacketIndex === 'number' ? msg.targetPacketIndex : undefined;
    const targetByteOffset = typeof msg.targetByteOffset === 'number' ? msg.targetByteOffset : undefined;
    const category: TraceEventCategoryFilter = typeof msg.category === 'string' ? (msg.category as TraceEventCategoryFilter) : 'all';
    const searchText = typeof msg.searchText === 'string' ? msg.searchText.slice(0, 128) : '';
    const contextKey = typeof msg.contextKey === 'string' && msg.contextKey ? msg.contextKey : undefined;
    const onlyWithDiagnostics = Boolean(msg.onlyWithDiagnostics);

    if (!recordId || !this.traceRecords.has(recordId)) return;
    if (Number.isFinite(querySeq)) {
      this.latestLocateQuerySeq = querySeq;
    }
    const myEpoch = ++this.locateRequestEpoch;

    this.inFlightLocateAbort?.abort();
    const controller = new AbortController();
    this.inFlightLocateAbort = controller;
    const t0 = performance.now();

    try {
      const locRes = await this.traceCoordinator.locateEvent(
        recordId,
        {
          start,
          end,
          unit,
          ...(bootGeneration !== undefined ? { bootGeneration } : {}),
          ...(segmentId !== undefined ? { segmentId } : {}),
          ...(targetTime !== undefined ? { targetTime } : {}),
          ...(targetBootGeneration !== undefined ? { targetBootGeneration } : {}),
          ...(targetSegmentId !== undefined ? { targetSegmentId } : {}),
          ...(targetPacketIndex !== undefined ? { targetPacketIndex } : {}),
          ...(targetByteOffset !== undefined ? { targetByteOffset } : {}),
          filter: {
            category,
            searchText,
            ...(contextKey ? { contextKey } : {}),
            ...(onlyWithDiagnostics ? { onlyWithDiagnostics: true } : {}),
          },
        },
        { signal: controller.signal },
      );

      if (controller.signal.aborted || this.disposed || this.selectedTraceRecordId !== recordId) return;
      if (myEpoch !== this.locateRequestEpoch) return;

      if (!locRes.ok) {
        if (locRes.cancelled) return;
        const result: TraceEventLocateResponse = {
          querySeq,
          recordId,
          unit,
          queryDurationMs: Math.round((performance.now() - t0) * 100) / 100,
          error: `${locRes.errorCode}: ${locRes.message}`,
        };
        this.postMessage({ command: 'traceEventLocateResult', result });
        return;
      }

      const result: TraceEventLocateResponse = {
        querySeq,
        recordId,
        unit,
        result: locRes.data,
        queryDurationMs: Math.round((performance.now() - t0) * 100) / 100,
      };
      this.postMessage({ command: 'traceEventLocateResult', result });
    } catch (err) {
      if (controller.signal.aborted || this.disposed) return;
      const result: TraceEventLocateResponse = {
        querySeq,
        recordId,
        unit,
        queryDurationMs: Math.round((performance.now() - t0) * 100) / 100,
        error: err instanceof Error ? err.message : String(err),
      };
      this.postMessage({ command: 'traceEventLocateResult', result });
    } finally {
      if (this.inFlightLocateAbort === controller) {
        this.inFlightLocateAbort = null;
      }
    }
  }

  private async handleTraceQueryTerminal(msg: any): Promise<void> {
    if (!this.traceCoordinator || this.disposed) return;
    const querySeq = Number(msg.querySeq);
    const recordId = typeof msg.recordId === 'string' ? msg.recordId : '';
    const unit: TraceTimeUnit = msg.unit === 'relative-ns' || msg.unit === 'absolute-ticks' || msg.unit === 'relative-ticks' ? msg.unit : 'ns';
    const scopeKey = typeof msg.scopeKey === 'string' ? msg.scopeKey : 'all-anchored';
    const sourceKind: TraceAnalysisSourceKind = msg.sourceKind === 'selection' || msg.sourceKind === 'full' ? msg.sourceKind : 'viewport';
    const bootGeneration = typeof msg.bootGeneration === 'number' ? msg.bootGeneration : undefined;
    const segmentId = typeof msg.segmentId === 'number' ? msg.segmentId : undefined;
    const start = String(msg.start ?? '0');
    const end = String(msg.end ?? '0');
    const offset = Math.max(0, Math.floor(Number(msg.offset) || 0));
    const limit = Math.max(1, Math.min(500, Math.floor(Number(msg.limit) || 200)));
    const level: TraceTerminalLevelFilter = msg.level === 'log' || msg.level === 'warning' || msg.level === 'error' ? msg.level : 'all';
    const searchText = typeof msg.searchText === 'string' ? msg.searchText.slice(0, 128) : '';
    const mergeAppend = msg.mergeAppend !== false;

    if (!recordId || !this.traceRecords.has(recordId)) return;
    if (Number.isFinite(querySeq)) {
      this.latestTerminalQuerySeq = querySeq;
    }
    const myEpoch = ++this.terminalRequestEpoch;

    this.inFlightTerminalAbort?.abort();
    const controller = new AbortController();
    this.inFlightTerminalAbort = controller;
    const t0 = performance.now();

    const makeErrorResult = (error: string): TraceTerminalResponse => ({
      querySeq,
      recordId,
      unit,
      scopeKey,
      sourceKind,
      level,
      searchText,
      mergeAppend,
      queryDurationMs: Math.round((performance.now() - t0) * 100) / 100,
      error,
    });

    try {
      const termRes = await this.traceCoordinator.queryTerminal(
        recordId,
        {
          start,
          end,
          unit,
          offset,
          limit,
          level,
          searchText,
          mergeAppend,
          ...(bootGeneration !== undefined ? { bootGeneration } : {}),
          ...(segmentId !== undefined ? { segmentId } : {}),
        },
        { signal: controller.signal },
      );

      if (controller.signal.aborted || this.disposed || this.selectedTraceRecordId !== recordId) return;
      if (myEpoch !== this.terminalRequestEpoch) return;

      if (!termRes.ok) {
        if (termRes.cancelled) return;
        this.postMessage({ command: 'traceTerminalResult', result: makeErrorResult(`${termRes.errorCode}: ${termRes.message}`) });
        return;
      }

      const result: TraceTerminalResponse = {
        querySeq,
        recordId,
        unit,
        scopeKey,
        sourceKind,
        level,
        searchText,
        mergeAppend,
        result: termRes.data,
        queryDurationMs: Math.round((performance.now() - t0) * 100) / 100,
      };
      this.postMessage({ command: 'traceTerminalResult', result });
    } catch (err) {
      if (controller.signal.aborted || this.disposed) return;
      this.postMessage({
        command: 'traceTerminalResult',
        result: makeErrorResult(err instanceof Error ? err.message : String(err)),
      });
    } finally {
      if (this.inFlightTerminalAbort === controller) {
        this.inFlightTerminalAbort = null;
      }
    }
  }

  private async handleTraceGetDiagnostics(msg: any): Promise<void> {
    if (!this.traceCoordinator || this.disposed) return;
    const recordId = typeof msg.recordId === 'string' ? msg.recordId : '';
    const bootGeneration = typeof msg.bootGeneration === 'number' ? msg.bootGeneration : undefined;
    const segmentId = typeof msg.segmentId === 'number' ? msg.segmentId : undefined;
    if (!recordId || !this.traceRecords.has(recordId)) return;
    try {
      const res = await this.traceCoordinator.getDiagnostics(recordId, { bootGeneration, segmentId, limit: 512 });
      if (this.disposed || this.selectedTraceRecordId !== recordId) return;
      const payload: TraceDiagnosticsResponse = res.ok
        ? { recordId, diagnostics: res.data }
        : { recordId, error: `${res.errorCode}: ${res.message}` };
      this.postMessage({ command: 'traceDiagnosticsResult', result: payload });
    } catch (err) {
      if (this.disposed || this.selectedTraceRecordId !== recordId) return;
      this.postMessage({
        command: 'traceDiagnosticsResult',
        result: { recordId, error: err instanceof Error ? err.message : String(err) } satisfies TraceDiagnosticsResponse,
      });
    }
  }

  private async handleTraceInspectPoint(msg: any): Promise<void> {
    if (!this.traceCoordinator || this.disposed) return;
    const targetKind: 'hover' | 'cursorA' | 'cursorB' = msg.targetKind === 'cursorA' || msg.targetKind === 'cursorB' ? msg.targetKind : 'hover';
    const querySeq = Number(msg.querySeq);
    const recordId = typeof msg.recordId === 'string' ? msg.recordId : '';
    const unit: TraceTimeUnit = msg.unit === 'relative-ns' || msg.unit === 'absolute-ticks' || msg.unit === 'relative-ticks' ? msg.unit : 'ns';
    const queryTime = String(msg.queryTime ?? '0');
    const queryStart = String(msg.queryStart ?? queryTime);
    let queryEnd = String(msg.queryEnd ?? queryStart);
    try {
      if (BigInt(queryEnd) <= BigInt(queryStart)) {
        queryEnd = (BigInt(queryStart) + 1n).toString();
      }
    } catch {
      return;
    }
    const bootGeneration = typeof msg.bootGeneration === 'number' ? msg.bootGeneration : undefined;
    const segmentId = typeof msg.segmentId === 'number' ? msg.segmentId : undefined;
    if (!recordId || !this.traceRecords.has(recordId)) return;

    if (Number.isFinite(querySeq)) {
      this.latestInspectSeq.set(targetKind, querySeq);
    }
    const myEpoch = (this.inspectRequestEpoch.get(targetKind) ?? 0) + 1;
    this.inspectRequestEpoch.set(targetKind, myEpoch);
    this.inFlightInspectAborts.get(targetKind)?.abort();
    const controller = new AbortController();
    this.inFlightInspectAborts.set(targetKind, controller);
    const t0 = performance.now();

    try {
      const rangeBase = {
        start: queryStart,
        end: queryEnd,
        unit,
        ...(bootGeneration !== undefined ? { bootGeneration } : {}),
        ...(segmentId !== undefined ? { segmentId } : {}),
        limit: 64,
      } as const;

      const [slicesRes, actsRes, readyRes, markersRes, markerPtsRes, packetsRes, segsRes, gapsRes] = await Promise.all([
        this.traceCoordinator.queryRange<ExecutionSliceInterval>(recordId, { ...rangeBase, target: 'slices' }, { signal: controller.signal }),
        this.traceCoordinator.queryRange<ContextActivationInterval>(recordId, { ...rangeBase, target: 'activations' }, { signal: controller.signal }),
        this.traceCoordinator.queryRange<ReadyWaitInterval>(recordId, { ...rangeBase, target: 'readyWaits' }, { signal: controller.signal }),
        this.traceCoordinator.queryRange<MarkerInterval>(recordId, { ...rangeBase, target: 'markers' }, { signal: controller.signal }),
        this.traceCoordinator.queryRange<MarkerPointEvent>(recordId, { ...rangeBase, target: 'markerPoints' }, { signal: controller.signal }),
        this.traceCoordinator.queryRange<DecodedSystemViewPacket>(recordId, { ...rangeBase, target: 'packets' }, { signal: controller.signal }),
        this.traceCoordinator.getSegments(recordId),
        this.traceCoordinator.getGaps(recordId),
      ]);

      if (controller.signal.aborted || this.disposed || this.selectedTraceRecordId !== recordId) return;
      if (myEpoch !== (this.inspectRequestEpoch.get(targetKind) ?? 0)) return;

      const segList = segsRes.ok ? segsRes.data : (this.traceSegmentsByRecord.get(recordId) ?? []);
      if (segsRes.ok) this.traceSegmentsByRecord.set(recordId, segsRes.data);
      const segMap = new Map<string, SegmentIndexMetadata>();
      for (const s of segList) segMap.set(`${s.bootGeneration}:${s.segmentId}`, s);

      const slices = slicesRes.ok ? slicesRes.data.items.map(s => projectSliceDto(s, segMap)) : [];
      const activations = actsRes.ok ? actsRes.data.items.map(a => projectActivationDto(a, segMap)) : [];
      const readyWaits = readyRes.ok ? readyRes.data.items.map(r => projectReadyWaitDto(r, segMap)) : [];
      const markers = markersRes.ok ? markersRes.data.items.map(m => projectMarkerDto(m, segMap)) : [];
      const markerPoints = markerPtsRes.ok ? markerPtsRes.data.items.map(mp => projectMarkerPointDto(mp, segMap)) : [];
      const resolvedBoot = slices[0]?.bootGeneration ?? activations[0]?.bootGeneration ?? readyWaits[0]?.bootGeneration ?? markers[0]?.bootGeneration ?? bootGeneration;
      const resolvedSeg = slices[0]?.segmentId ?? activations[0]?.segmentId ?? readyWaits[0]?.segmentId ?? markers[0]?.segmentId ?? (packetsRes.ok ? packetsRes.data.items[0]?.segmentId : undefined) ?? segmentId;
      const matchedSeg = resolvedSeg !== undefined
        ? (resolvedBoot !== undefined
          ? segMap.get(`${resolvedBoot}:${resolvedSeg}`)
          : segList.find(s => s.segmentId === resolvedSeg))
        : undefined;
      const packets = packetsRes.ok
        ? packetsRes.data.items.map(p => projectPacketDto(p, segMap, resolvedBoot ?? matchedSeg?.bootGeneration))
        : [];
      const gaps = gapsRes.ok
        ? gapsRes.data
            .filter(g => (resolvedSeg === undefined || g.segmentIdBefore === resolvedSeg || g.segmentIdBefore === resolvedSeg - 1 || g.segmentIdBefore === undefined))
            .map(projectGapDto)
        : [];

      const result: TracePointInspectResponse = {
        querySeq,
        targetKind,
        recordId,
        unit,
        queryTime,
        queryStart,
        queryEnd,
        bootGeneration: resolvedBoot ?? matchedSeg?.bootGeneration,
        segmentId: resolvedSeg,
        segmentReliability: matchedSeg?.reliability,
        timeAnchorStatus: matchedSeg?.timeAnchorStatus,
        sysFreqHz: matchedSeg?.sysFreqHz,
        slices,
        activations,
        readyWaits,
        markers,
        markerPoints,
        packets,
        gaps,
        queryDurationMs: Math.round((performance.now() - t0) * 100) / 100,
      };
      this.postMessage({ command: 'tracePointInspectResult', result });
    } catch (err) {
      if (controller.signal.aborted || this.disposed) return;
      this.postMessage({
        command: 'tracePointInspectResult',
        result: {
          querySeq,
          targetKind,
          recordId,
          unit,
          queryTime,
          queryStart,
          queryEnd,
          slices: [],
          activations: [],
          readyWaits: [],
          markers: [],
          markerPoints: [],
          packets: [],
          gaps: [],
          queryDurationMs: Math.round((performance.now() - t0) * 100) / 100,
          error: err instanceof Error ? err.message : String(err),
        } satisfies TracePointInspectResponse,
      });
    } finally {
      if (this.inFlightInspectAborts.get(targetKind) === controller) {
        this.inFlightInspectAborts.delete(targetKind);
      }
    }
  }

  private setTraceActionMessage(tone: 'info' | 'ok' | 'warn' | 'error', text: string): void {
    this.traceActionMessage = { tone, text };
    this.postState();
  }
}
