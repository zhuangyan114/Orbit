import * as http from 'http';
import * as path from 'path';
import * as vscode from 'vscode';
import { randomBytes, randomUUID } from 'crypto';
import { OzoneBackend } from '../ozone-backend/commander';
import { findElfFiles } from '../ozone-backend/flasher';
import { getOrbitConfiguration } from '../utils/orbit-settings';
import { ExperimentService } from './experiment-service';
import { RuntimeRouter } from './runtime-router';
import { WaveRecorder } from './wave-recorder';
import {
  ApiEndpointInfo,
  JsonRpcRequest,
  JsonRpcResponse,
  ReadManyParams,
  RecordClearParams,
  RecordGetParams,
  RecordStartParams,
  RecordStopParams,
  SignalSpec,
  WriteManyParams,
} from './types';
import {
  AUTOMATION_SCOPES,
  AutomationError,
  AutomationScope,
  BootstrapContext,
  BreakpointInput,
  ConnectionContext,
  ConnectionMutationContext,
  ProjectMutationContext,
  TargetMutationContext,
} from './protocol';
import { buildMethodDefinition, RpcDispatcher } from './rpc-dispatcher';
import {
  BoundServerInfo,
  InstanceRegistry,
  WorkspaceSnapshot,
  defaultRegistryPointerPath,
  detectChannel,
  detectExtensionHost,
  detectProfile,
} from './instance-registry';
import { HandshakeService } from './handshake-service';
import { WorkspaceFolderInfo } from './protocol';
import { SessionRegistry, SessionUpdatePatch } from './session-registry';
import { SessionService, listOrbitLaunchConfigurations } from './session-service';
import { BreakpointService } from './breakpoint-service';
import { RuntimeService } from './runtime-service';
import { MemoryService } from './memory-service';
import { ViewStateService } from './view-state-service';
import { RecordingService } from './recording-service';
import { RttService } from './rtt-service';
import { DiagnosticsService } from './diagnostics-service';
import { AutomationEvent, EventHub } from './event-hub';
import { MAX_SSE_CONNECTIONS, SseConnection } from './sse-stream';
import {
  AutomationControlRequest,
  AutomationControlResult,
  AutomationRegisterGroup,
} from '../debug/dap-automation-protocol';
import { ControlOutcome, ExperimentStep, ExpressionContextKind, ExpressionWrite, FlashReport, RecordingChannel, SessionRef, SymbolKind, TargetRequestContext } from './protocol';

const HOST = '127.0.0.1';
const MAX_BODY_BYTES = 1024 * 1024;
const LEGACY_ENDPOINT_FILE = 'plugin-api-endpoint.json';
const API_VERSION = '1.0';

interface InstanceDescribeParams {
  context: BootstrapContext;
  includeEndpoint?: boolean;
}

interface ProjectDescribeParams {
  context: BootstrapContext;
  includeLaunchConfigurations?: boolean;
}

interface SystemCapabilitiesParams {
  context: BootstrapContext;
  includeUnavailable?: boolean;
}

interface HandshakeWireParams {
  context: BootstrapContext;
  apiVersion: '1.0';
  client: { name: string; version?: string; pid?: number };
  expected: { projectId: string; instanceId?: string; workspaceRoot?: string };
  requestedScopes?: AutomationScope[];
}

interface ConnectionCloseWireParams {
  context: ConnectionContext;
  reason?: string;
}

interface ProjectListLaunchConfigurationsWireParams {
  context: ConnectionContext;
  page?: { cursor?: string; limit?: number };
  includeLegacyAlias?: boolean;
}

interface SessionListWireParams {
  context: ConnectionContext;
  cursor?: string;
  limit?: number;
  includeTerminated?: boolean;
}

interface SessionSnapshotWireParams {
  context: ConnectionContext;
  sessionId: string;
  includeCapabilities?: boolean;
}

interface SessionStartWireParams {
  context: ProjectMutationContext;
  configurationId: string;
  configurationName?: string;
  noDebug?: boolean;
  timeoutMs?: number;
}

interface SessionStopWireParams {
  context: TargetMutationContext;
  terminateDebuggee?: boolean;
  restartArguments?: { preserveBreakpoints?: boolean };
}

interface SessionRestartWireParams {
  context: TargetMutationContext;
  terminateDebuggee?: boolean;
  restartArguments?: { preserveBreakpoints?: boolean };
}

interface TargetPauseWireParams {
  context: TargetMutationContext;
  threadId?: number;
}

interface TargetContinueWireParams {
  context: TargetMutationContext;
  threadId?: number;
  singleThread?: boolean;
}

interface TargetResetWireParams {
  context: TargetMutationContext;
  mode?: 'halt' | 'run';
}

interface TargetStepWireParams {
  context: TargetMutationContext;
  threadId: number;
  granularity?: 'source' | 'instruction';
}

interface TargetFlashWireParams {
  context: TargetMutationContext;
  elfPath: string;
  verify?: boolean;
  resetAfter?: 'none' | 'halt' | 'run';
  timeoutMs?: number;
}

interface BreakpointsListWireParams {
  context: ConnectionContext;
  sourcePath?: string;
  cursor?: string;
  limit?: number;
}

interface BreakpointsAddWireParams {
  context: ConnectionMutationContext;
  breakpoint: BreakpointInput;
  waitForVerificationMs?: number;
}

interface BreakpointsUpdateWireParams {
  context: ConnectionMutationContext;
  breakpointId: string;
  breakpoint: BreakpointInput;
  waitForVerificationMs?: number;
}

interface BreakpointsRemoveWireParams {
  context: ConnectionMutationContext;
  breakpointId: string;
}

interface BreakpointsReplaceWireParams {
  context: ConnectionMutationContext;
  sourcePath: string;
  breakpoints: BreakpointInput[];
  waitForVerificationMs?: number;
}

interface RuntimeThreadsWireParams {
  context: TargetRequestContext;
  cursor?: string;
  limit?: number;
}

interface RuntimeStackTraceWireParams {
  context: TargetRequestContext;
  threadId: number;
  startFrame?: number;
  levels?: number;
  cursor?: string;
}

interface RuntimeScopesWireParams {
  context: TargetRequestContext;
  frameId: number;
  cursor?: string;
  limit?: number;
}

interface RuntimeVariablesWireParams {
  context: TargetRequestContext;
  variablesReference: string;
  filter?: 'named' | 'indexed';
  start?: number;
  count?: number;
  cursor?: string;
}

interface RuntimeRegistersWireParams {
  context: TargetRequestContext;
  groups?: AutomationRegisterGroup[];
  cursor?: string;
  limit?: number;
}

interface ExpressionEvaluateWireParams {
  context: TargetRequestContext;
  expression: string;
  frameId?: number;
  contextKind?: ExpressionContextKind;
}

interface ExpressionReadManyWireParams {
  context: TargetRequestContext;
  expressions: string[];
  frameId?: number;
  forceRealtime?: boolean;
}

interface ExpressionWriteManyWireParams {
  context: TargetMutationContext;
  writes: ExpressionWrite[];
  frameId?: number;
  resumeIntent?: 'preserve' | 'halted' | 'running';
}

interface ExpressionInspectWireParams {
  context: TargetRequestContext;
  expression: string;
  frameId?: number;
  depth?: number;
  maxChildren?: number;
}

interface SymbolSearchWireParams {
  context: TargetRequestContext;
  query: string;
  kinds?: SymbolKind[];
  cursor?: string;
  limit?: number;
}

interface SymbolResolveWireParams {
  context: TargetRequestContext;
  name?: string;
  address?: string;
}

interface MemoryReadWireParams {
  context: TargetRequestContext;
  address: string;
  count: number;
  allowPartial?: boolean;
}

interface MemoryWriteWireParams {
  context: TargetMutationContext;
  address: string;
  data: string;
  verify?: boolean;
}

interface WatchListWireParams {
  context: ConnectionContext;
  includeValues?: boolean;
}

interface WatchMutationWireParams {
  context: ConnectionMutationContext;
  expressions: string[];
}

interface TimelineListWireParams {
  context: ConnectionContext;
  includeStatus?: boolean;
}

interface TimelineReplaceWireParams {
  context: ConnectionMutationContext;
  expressions: string[];
}

interface TimelineStartWireParams {
  context: TargetMutationContext;
  intervalMs: number;
  maxFrames?: number;
}

interface TimelineStopWireParams {
  context: TargetMutationContext;
  flush?: boolean;
}

interface TimelineStatusWireParams {
  context: TargetRequestContext;
  includePerformance?: boolean;
}

interface RecordStartWireParams {
  context: TargetMutationContext;
  name: string;
  channels: RecordingChannel[];
  intervalMs: number;
  maxFrames?: number;
}

interface RecordStopWireParams {
  context: TargetMutationContext;
  recordingId: string;
}

interface RecordListWireParams {
  context: TargetRequestContext;
  cursor?: string;
  limit?: number;
  status?: string;
}

interface RecordGetWireParams {
  context: TargetRequestContext;
  recordingId: string;
  cursor?: string;
  limit?: number;
}

interface RecordClearWireParams {
  context: TargetMutationContext;
  recordingId: string;
}

interface ExperimentRunWireParams {
  context: TargetMutationContext;
  name: string;
  steps: ExperimentStep[];
  timeoutMs?: number;
  continueOnError?: boolean;
}

interface RttStatusWireParams {
  context: TargetRequestContext;
  bufferIndex?: number;
}

interface RttStartWireParams {
  context: TargetMutationContext;
  bufferIndex?: number;
  pollIntervalMs?: number;
  targetName?: string;
  ansi?: boolean;
}

interface RttStopWireParams {
  context: TargetMutationContext;
  bufferIndex?: number;
}

interface RttReadWireParams {
  context: TargetRequestContext;
  bufferIndex?: number;
  cursor?: string;
  maxBytes?: number;
}

interface DiagnosticsSnapshotWireParams {
  context: ConnectionContext;
  sessionId?: string;
  includeLogs?: boolean;
  includePerformance?: boolean;
}

export interface PluginApiServerOptions {
  /** Injected for tests; defaults to an Extension-Host-backed registry. */
  registry?: InstanceRegistry;
  /** Injected for tests; defaults to a registry-backed HandshakeService. */
  handshakeFactory?: (registry: InstanceRegistry) => HandshakeService;
  /** Exact DebugSession registration and generation fence (plan Task 3). */
  sessionRegistry?: SessionRegistry;
  /** Visible session start/stop and launch configuration service (plan Task 4). */
  sessionService?: SessionService;
  /** Unified VS Code breakpoint service (plan Task 6). */
  breakpointService?: BreakpointService;
  /** Runtime inspection service (plan Task 7). */
  runtimeService?: RuntimeService;
  /** Byte-oriented memory access service (plan Task 9). */
  memoryService?: MemoryService;
  /** Watch/Timeline view-state service (plan Task 10). */
  viewStateService?: ViewStateService;
  /** Unified automation recording service (plan Task 10). */
  recordingService?: RecordingService;
  /** RTT status/start/stop/read service (plan Task 11). */
  rttService?: RttService;
  /** Redacted diagnostics snapshot service (plan Task 11). */
  diagnosticsService?: DiagnosticsService;
  /** High-rate sampler (UI Timeline channel) for recording frames (plan Task 10). */
  fastSampleSink?: import('./fast-sample-sink').FastSampleSink;
  /** Expressions (UI Timeline) that must keep sampling while recordings run. */
  sharedSampleExpressions?: () => string[];
  /** Bounded event ring Task 11's SSE stream consumes (plan §2.5). */
  eventHub?: EventHub;
}

/** Snapshot of the VS Code workspace used for projectId hashing (plan §2.1). */
export function snapshotWorkspace(): WorkspaceSnapshot {
  const folders: WorkspaceFolderInfo[] = (vscode.workspace.workspaceFolders ?? []).map(folder => ({
    name: folder.name,
    uri: folder.uri.toString(),
    path: folder.uri.fsPath,
  }));
  const workspaceFile = vscode.workspace.workspaceFile;
  const isCodeWorkspace =
    workspaceFile?.scheme === 'file' && workspaceFile.fsPath.toLowerCase().endsWith('.code-workspace');
  return {
    workspaceFileUri: isCodeWorkspace ? workspaceFile.toString() : undefined,
    workspaceFilePath: isCodeWorkspace ? workspaceFile.fsPath : undefined,
    folders,
  };
}

/** Configured default program plus ELF/AXF candidates under the workspace roots. */
export function collectElfFiles(): string[] {
  const paths: string[] = [];
  const configured = getOrbitConfiguration().get<string>('defaultProgram', '');
  if (configured) paths.push(configured);
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    for (const candidate of findElfFiles(folder.uri.fsPath)) {
      if (!paths.includes(candidate.path)) paths.push(candidate.path);
      if (paths.length >= 64) break;
    }
    if (paths.length >= 64) break;
  }
  return paths;
}

/** `orbit`/`ozone` launch configurations of this workspace, normalized. */
export { listOrbitLaunchConfigurations } from './session-service';

export class PluginApiServer implements vscode.Disposable {
  private server: http.Server | null = null;
  private token = randomBytes(24).toString('hex');
  private runtime: RuntimeRouter;
  private recorder: WaveRecorder;
  private experiment: ExperimentService;
  private registry: InstanceRegistry;
  private handshake: HandshakeService | null = null;
  private dispatcher: RpcDispatcher | null = null;
  private sessionService: SessionService;
  private breakpointService: BreakpointService;
  private runtimeService: RuntimeService;
  private memoryService: MemoryService;
  private viewState: ViewStateService;
  private recording: RecordingService;
  private rtt: RttService;
  private diagnostics: DiagnosticsService;
  private readonly sseConnections = new Set<SseConnection>();
  private startedAtMs = 0;

  constructor(
    private context: vscode.ExtensionContext,
    backend: OzoneBackend,
    private readonly options: PluginApiServerOptions = {},
  ) {
    const sessionRegistry = this.options.sessionRegistry;
    this.runtime = new RuntimeRouter(
      backend,
      sessionRegistry
        ? {
            resolveSession: ref => sessionRegistry.requireExact(ref),
            currentRef: () => sessionRegistry.currentRef(),
          }
        : undefined,
    );
    this.recorder = new WaveRecorder(this.runtime);
    this.registry = this.options.registry ?? this.buildRegistry();
    this.sessionService =
      this.options.sessionService ??
      new SessionService({ registry: sessionRegistry ?? new SessionRegistry() });
    this.breakpointService =
      this.options.breakpointService ??
      new BreakpointService({ registry: sessionRegistry ?? new SessionRegistry() });
    this.runtimeService =
      this.options.runtimeService ??
      new RuntimeService({ registry: sessionRegistry ?? new SessionRegistry() });
    this.memoryService =
      this.options.memoryService ??
      new MemoryService({ registry: sessionRegistry ?? new SessionRegistry() });
    this.recording =
      this.options.recordingService ??
      new RecordingService({
        registry: sessionRegistry ?? new SessionRegistry(),
        runtime: this.runtime,
        eventHub: this.options.eventHub,
        sampleSink: this.options.fastSampleSink,
        sharedSampleExpressions: this.options.sharedSampleExpressions,
      });
    this.viewState =
      this.options.viewStateService ??
      new ViewStateService({
        registry: sessionRegistry ?? new SessionRegistry(),
        runtime: this.runtime,
        eventHub: this.options.eventHub,
        sampleSink: this.options.fastSampleSink,
      });
    this.rtt =
      this.options.rttService ??
      new RttService({
        registry: sessionRegistry ?? new SessionRegistry(),
        eventHub: this.options.eventHub,
      });
    this.diagnostics =
      this.options.diagnosticsService ??
      new DiagnosticsService({
        registry: sessionRegistry ?? new SessionRegistry(),
        version: API_VERSION,
        getConnections: () => this.handshake ? Array.from(this.handshake.connections()).length : 0,
        getSseConnections: () => this.sseConnections.size,
        getSamplingStats: () => this.recording.stats(),
      });
    this.experiment = new ExperimentService(this.runtime, this.recorder, this.recording, this.memoryService);
    if (this.options.handshakeFactory) {
      this.handshake = this.options.handshakeFactory(this.registry);
    }
  }

  async start(): Promise<ApiEndpointInfo> {
    if (this.server) return this.endpointInfo();

    this.server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, HOST, () => resolve());
    });

    this.startedAtMs = Date.now();
    const address = this.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Plugin API server address unavailable');
    }
    const bound: BoundServerInfo = {
      host: HOST,
      port: address.port,
      rpcUrl: `http://${HOST}:${address.port}/v1/rpc`,
      eventsUrl: `http://${HOST}:${address.port}/v1/events`,
      token: this.token,
      processId: process.pid,
      startedAt: this.startedAtMs,
      apiVersions: [API_VERSION],
    };
    try {
      await this.registry.start(bound);
    } catch (error) {
      this.server.close();
      this.server = null;
      throw error;
    }
    if (!this.handshake) {
      this.handshake = new HandshakeService({
        instanceId: () => this.registry.getInstanceId(),
        projectId: () => this.registry.getProjectId(),
        allowedScopes: () => this.readAllowedScopes(),
        getInstanceDescription: () => this.registry.describe(),
        getProjectDescription: () => this.registry.getProjectDescription(),
        getCapabilitySnapshot: () => this.registry.getCapabilitySnapshot(),
        getWorkspaceFolders: () => this.registry.getProjectDescription().workspaceFolders,
        getSessionSnapshot: () => this.options.sessionRegistry?.currentSnapshot(),
      });
    }
    this.dispatcher = new RpcDispatcher({
      instanceId: this.registry.getInstanceId(),
      projectId: this.registry.getProjectId(),
      verifyAuthorization: authorization => authorization === `Bearer ${this.token}`,
      getConnection: connectionId => this.handshake!.get(connectionId),
      getSessionGeneration: sessionId => this.options.sessionRegistry?.getSessionGeneration(sessionId),
    });
    this.registerV1Methods();
    return this.endpointInfo();
  }

  getEndpointInfo(): ApiEndpointInfo {
    return this.endpointInfo();
  }

  /** Instance identity of the running API registry (for the event ring). */
  getInstanceId(): string {
    return this.registry.getInstanceId();
  }

  /** Stable project identity of the running API registry (for the event ring). */
  getProjectId(): string {
    return this.registry.getProjectId();
  }

  dispose() {
    for (const connection of this.sseConnections) connection.close();
    this.sseConnections.clear();
    this.recorder.dispose();
    this.recording.dispose();
    this.viewState.dispose();
    this.dispatcher?.dispose();
    this.dispatcher = null;
    void this.registry.dispose();
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  private buildRegistry(): InstanceRegistry {
    return new InstanceRegistry({
      endpointDirectory: path.join(this.context.globalStorageUri.fsPath, 'automation-api', 'endpoints'),
      registryPointerPath: defaultRegistryPointerPath(process.env, process.platform),
      legacyPointerPath: path.join(this.context.globalStorageUri.fsPath, LEGACY_ENDPOINT_FILE),
      identity: {
        channel: detectChannel({
          remoteName: vscode.env.remoteName,
          appName: vscode.env.appName,
          portableEnv: process.env.VSCODE_PORTABLE,
        }),
        profile: detectProfile(this.context.globalStorageUri.fsPath),
        extensionHost: detectExtensionHost(vscode.env.remoteName),
      },
      extensionVersion: String(this.context.extension.packageJSON?.version ?? '0.0.0'),
      processId: process.pid,
      getWorkspace: () => snapshotWorkspace(),
      listElfFiles: () => collectElfFiles(),
      listLaunchConfigurations: () => listOrbitLaunchConfigurations(),
      getRegistryGeneration: () => this.options.sessionRegistry?.registryGeneration ?? 0,
    });
  }

  private readAllowedScopes(): AutomationScope[] {
    const configured = getOrbitConfiguration().get<unknown>('automation.allowedScopes', ['read']);
    const scopes = (Array.isArray(configured) ? configured : []).filter(
      (scope): scope is AutomationScope =>
        typeof scope === 'string' && (AUTOMATION_SCOPES as readonly string[]).includes(scope),
    );
    return scopes.length > 0 ? scopes : ['read'];
  }

  private registerV1Methods(): void {
    const dispatcher = this.dispatcher!;
    dispatcher.register(
      buildMethodDefinition('orbit.instance.describe', async (params: InstanceDescribeParams) => ({
        data: this.registry.describe(),
      })),
    );
    dispatcher.register(
      buildMethodDefinition('orbit.project.describe', async (params: ProjectDescribeParams) => ({
        data: this.registry.getProjectDescription(),
      })),
    );
    dispatcher.register(
      buildMethodDefinition('orbit.handshake', async (params: HandshakeWireParams) => ({
        data: this.handshake!.handshake(params, params.context),
      })),
    );
    dispatcher.register(
      buildMethodDefinition('orbit.connection.close', async (params: ConnectionCloseWireParams) => ({
        data: this.handshake!.close(params.context.connectionId),
      })),
    );
    dispatcher.register(
      buildMethodDefinition('orbit.system.capabilities', async (params: SystemCapabilitiesParams) => ({
        data: this.registry.getCapabilitySnapshot(params.includeUnavailable ?? true),
      })),
    );
    dispatcher.register(
      buildMethodDefinition(
        'orbit.project.listLaunchConfigurations',
        async (params: ProjectListLaunchConfigurationsWireParams) => ({
          data: this.sessionService.listLaunchConfigurationsPage(
            params.page,
            params.includeLegacyAlias ?? true,
          ),
        }),
      ),
    );
    dispatcher.register(
      buildMethodDefinition('orbit.session.list', async (params: SessionListWireParams) => ({
        data: this.sessionService.list({
          includeTerminated: params.includeTerminated ?? false,
          cursor: params.cursor,
          limit: params.limit,
        }),
      })),
    );
    dispatcher.register(
      buildMethodDefinition('orbit.session.snapshot', async (params: SessionSnapshotWireParams) => ({
        data: this.sessionService.snapshot(params.sessionId, params.includeCapabilities ?? true),
      })),
    );
    dispatcher.register(
      buildMethodDefinition('orbit.session.start', async (params: SessionStartWireParams, call) => ({
        data: await this.sessionService.start(
          {
            context: params.context,
            configurationId: params.configurationId,
            configurationName: params.configurationName,
            noDebug: params.noDebug ?? false,
            timeoutMs: params.timeoutMs,
          },
          call.operationId,
        ),
      })),
    );
    dispatcher.register(
      buildMethodDefinition('orbit.session.stop', async (params: SessionStopWireParams, call) => ({
        data: await this.sessionService.stop(
          {
            sessionId: params.context.sessionId,
            sessionGeneration: params.context.sessionGeneration,
          },
          call.operationId,
        ),
      })),
    );
    // --- plan Task 5: automation control routed through the DAP session ---
    dispatcher.register(
      buildMethodDefinition('orbit.session.restart', async (params: SessionRestartWireParams, call) => ({
        data: await this.restartOutcome(params.context, call.operationId),
      })),
    );
    dispatcher.register(
      buildMethodDefinition('orbit.target.pause', async (params: TargetPauseWireParams, call) => ({
        data: await this.controlOutcome(params.context, {
          action: 'pause',
          sessionGeneration: params.context.sessionGeneration,
          threadId: params.threadId,
        }, call.operationId),
      })),
    );
    dispatcher.register(
      buildMethodDefinition('orbit.target.continue', async (params: TargetContinueWireParams, call) => ({
        data: await this.controlOutcome(params.context, {
          action: 'continue',
          sessionGeneration: params.context.sessionGeneration,
          threadId: params.threadId,
          singleThread: params.singleThread,
        }, call.operationId),
      })),
    );
    dispatcher.register(
      buildMethodDefinition('orbit.target.reset', async (params: TargetResetWireParams, call) => ({
        data: await this.controlOutcome(params.context, {
          action: 'reset',
          sessionGeneration: params.context.sessionGeneration,
          mode: params.mode,
        }, call.operationId),
      })),
    );
    dispatcher.register(
      buildMethodDefinition('orbit.target.stepOver', async (params: TargetStepWireParams, call) => ({
        data: await this.controlOutcome(params.context, {
          action: 'stepOver',
          sessionGeneration: params.context.sessionGeneration,
          threadId: params.threadId,
          granularity: params.granularity,
        }, call.operationId),
      })),
    );
    dispatcher.register(
      buildMethodDefinition('orbit.target.stepInto', async (params: TargetStepWireParams, call) => ({
        data: await this.controlOutcome(params.context, {
          action: 'stepInto',
          sessionGeneration: params.context.sessionGeneration,
          threadId: params.threadId,
          granularity: params.granularity,
        }, call.operationId),
      })),
    );
    dispatcher.register(
      buildMethodDefinition('orbit.target.stepOut', async (params: TargetStepWireParams, call) => ({
        data: await this.controlOutcome(params.context, {
          action: 'stepOut',
          sessionGeneration: params.context.sessionGeneration,
          threadId: params.threadId,
          granularity: params.granularity,
        }, call.operationId),
      })),
    );
    dispatcher.register(
      buildMethodDefinition('orbit.target.stepInstruction', async (params: TargetStepWireParams, call) => ({
        data: await this.controlOutcome(params.context, {
          action: 'stepInstruction',
          sessionGeneration: params.context.sessionGeneration,
          threadId: params.threadId,
          granularity: params.granularity,
        }, call.operationId),
      })),
    );
    dispatcher.register(
      buildMethodDefinition('orbit.target.flash', async (params: TargetFlashWireParams, call) => ({
        data: await this.flashOutcome(params, call.operationId),
      })),
    );
    // --- plan Task 6: unified VS Code breakpoint API ---
    dispatcher.register(
      buildMethodDefinition('orbit.breakpoints.list', async (params: BreakpointsListWireParams) => ({
        data: await this.breakpointService.list({
          sourcePath: params.sourcePath,
          cursor: params.cursor,
          limit: params.limit,
        }),
      })),
    );
    dispatcher.register(
      buildMethodDefinition('orbit.breakpoints.add', async (params: BreakpointsAddWireParams, call) => ({
        data: await this.breakpointService.add(
          params.breakpoint,
          params.waitForVerificationMs,
          call.operationId,
        ),
      })),
    );
    dispatcher.register(
      buildMethodDefinition('orbit.breakpoints.update', async (params: BreakpointsUpdateWireParams, call) => ({
        data: await this.breakpointService.update(
          params.breakpointId,
          params.breakpoint,
          params.waitForVerificationMs,
          call.operationId,
        ),
      })),
    );
    dispatcher.register(
      buildMethodDefinition('orbit.breakpoints.remove', async (params: BreakpointsRemoveWireParams, call) => ({
        data: await this.breakpointService.remove(params.breakpointId, call.operationId),
      })),
    );
    dispatcher.register(
      buildMethodDefinition('orbit.breakpoints.replace', async (params: BreakpointsReplaceWireParams, call) => ({
        data: await this.breakpointService.replace(
          params.sourcePath,
          params.breakpoints,
          params.waitForVerificationMs,
          call.operationId,
        ),
      })),
    );
    // --- plan Task 7: runtime inspection through the exact DAP session ---
    dispatcher.register(
      buildMethodDefinition('orbit.runtime.threads', async (params: RuntimeThreadsWireParams) => ({
        data: await this.runtimeService.threads(this.sessionRef(params.context), {
          cursor: params.cursor,
          limit: params.limit,
        }),
      })),
    );
    dispatcher.register(
      buildMethodDefinition('orbit.runtime.stackTrace', async (params: RuntimeStackTraceWireParams) => ({
        data: await this.runtimeService.stackTrace(this.sessionRef(params.context), {
          threadId: params.threadId,
          startFrame: params.startFrame,
          levels: params.levels,
          cursor: params.cursor,
        }),
      })),
    );
    dispatcher.register(
      buildMethodDefinition('orbit.runtime.scopes', async (params: RuntimeScopesWireParams) => ({
        data: await this.runtimeService.scopes(this.sessionRef(params.context), {
          frameId: params.frameId,
          cursor: params.cursor,
          limit: params.limit,
        }),
      })),
    );
    dispatcher.register(
      buildMethodDefinition('orbit.runtime.variables', async (params: RuntimeVariablesWireParams) => ({
        data: await this.runtimeService.variables(this.sessionRef(params.context), {
          variablesReference: params.variablesReference,
          filter: params.filter,
          start: params.start,
          count: params.count,
          cursor: params.cursor,
        }),
      })),
    );
    dispatcher.register(
      buildMethodDefinition('orbit.runtime.registers', async (params: RuntimeRegistersWireParams) => ({
        data: await this.runtimeService.registers(this.sessionRef(params.context), {
          groups: params.groups,
          cursor: params.cursor,
          limit: params.limit,
        }),
      })),
    );
    // --- plan Task 8: expressions, variable writes and symbol discovery ---
    dispatcher.register(
      buildMethodDefinition('orbit.expression.evaluate', async (params: ExpressionEvaluateWireParams) => ({
        data: await this.runtimeService.evaluate(this.sessionRef(params.context), {
          expression: params.expression,
          frameId: params.frameId,
          contextKind: params.contextKind,
        }),
      })),
    );
    dispatcher.register(
      buildMethodDefinition('orbit.expression.readMany', async (params: ExpressionReadManyWireParams) => ({
        data: await this.runtimeService.readMany(this.sessionRef(params.context), {
          expressions: params.expressions,
          frameId: params.frameId,
          forceRealtime: params.forceRealtime,
        }),
      })),
    );
    dispatcher.register(
      buildMethodDefinition('orbit.expression.writeMany', async (params: ExpressionWriteManyWireParams, call) => ({
        data: await this.runtimeService.writeMany(
          this.sessionRef(params.context),
          {
            writes: params.writes,
            frameId: params.frameId,
            resumeIntent: params.resumeIntent,
          },
          call.operationId,
        ),
      })),
    );
    dispatcher.register(
      buildMethodDefinition('orbit.expression.inspect', async (params: ExpressionInspectWireParams) => ({
        data: await this.runtimeService.inspect(this.sessionRef(params.context), {
          expression: params.expression,
          frameId: params.frameId,
          depth: params.depth,
          maxChildren: params.maxChildren,
        }),
      })),
    );
    dispatcher.register(
      buildMethodDefinition('orbit.symbol.search', async (params: SymbolSearchWireParams) => ({
        data: await this.runtimeService.symbolSearch(this.sessionRef(params.context), {
          query: params.query,
          kinds: params.kinds,
          cursor: params.cursor,
          limit: params.limit,
        }),
      })),
    );
    dispatcher.register(
      buildMethodDefinition('orbit.symbol.resolve', async (params: SymbolResolveWireParams) => ({
        data: await this.runtimeService.symbolResolve(this.sessionRef(params.context), {
          name: params.name,
          address: params.address,
        }),
      })),
    );
    // --- plan Task 9: byte-oriented memory read/write ---
    dispatcher.register(
      buildMethodDefinition('orbit.memory.read', async (params: MemoryReadWireParams) => ({
        data: await this.memoryService.read(this.sessionRef(params.context), {
          address: params.address,
          count: params.count,
          allowPartial: params.allowPartial,
        }),
      })),
    );
    dispatcher.register(
      buildMethodDefinition('orbit.memory.write', async (params: MemoryWriteWireParams, call) => ({
        data: await this.memoryService.write(
          this.sessionRef(params.context),
          {
            address: params.address,
            data: params.data,
            verify: params.verify,
          },
          call.operationId,
        ),
      })),
    );
    // --- plan Task 10: Watch / Timeline view state and unified recording ---
    dispatcher.register(
      buildMethodDefinition('orbit.watch.list', async (params: WatchListWireParams) => ({
        data: await this.viewState.watchSnapshot(params.includeValues ?? true),
      })),
    );
    dispatcher.register(
      buildMethodDefinition('orbit.watch.replace', async (params: WatchMutationWireParams) => ({
        data: await this.viewState.replaceWatch(params.expressions),
      })),
    );
    dispatcher.register(
      buildMethodDefinition('orbit.watch.add', async (params: WatchMutationWireParams) => ({
        data: await this.viewState.addWatch(params.expressions),
      })),
    );
    dispatcher.register(
      buildMethodDefinition('orbit.watch.remove', async (params: WatchMutationWireParams) => ({
        data: await this.viewState.removeWatch(params.expressions),
      })),
    );
    dispatcher.register(
      buildMethodDefinition('orbit.timeline.list', async (params: TimelineListWireParams) => ({
        data: this.viewState.timelineSnapshot(params.includeStatus ?? true),
      })),
    );
    dispatcher.register(
      buildMethodDefinition('orbit.timeline.replace', async (params: TimelineReplaceWireParams) => ({
        data: await this.viewState.replaceTimeline(params.expressions),
      })),
    );
    dispatcher.register(
      buildMethodDefinition('orbit.timeline.start', async (params: TimelineStartWireParams) => ({
        data: await this.viewState.startTimeline(
          this.sessionRef(params.context),
          params.intervalMs,
          params.maxFrames,
        ),
      })),
    );
    dispatcher.register(
      buildMethodDefinition('orbit.timeline.stop', async (params: TimelineStopWireParams) => ({
        data: await this.viewState.stopTimeline(this.sessionRef(params.context)),
      })),
    );
    dispatcher.register(
      buildMethodDefinition('orbit.timeline.status', async (params: TimelineStatusWireParams) => ({
        data: await this.viewState.timelineStatus(this.sessionRef(params.context)),
      })),
    );
    dispatcher.register(
      buildMethodDefinition('orbit.record.start', async (params: RecordStartWireParams) => ({
        data: await this.recording.start(this.sessionRef(params.context), {
          name: params.name,
          channels: params.channels,
          intervalMs: params.intervalMs,
          maxFrames: params.maxFrames,
        }),
      })),
    );
    dispatcher.register(
      buildMethodDefinition('orbit.record.stop', async (params: RecordStopWireParams) => ({
        data: await this.recording.stop(this.sessionRef(params.context), params.recordingId),
      })),
    );
    dispatcher.register(
      buildMethodDefinition('orbit.record.list', async (params: RecordListWireParams) => ({
        data: await this.recording.list(this.sessionRef(params.context), {
          cursor: params.cursor,
          limit: params.limit,
          status: params.status,
        }),
      })),
    );
    dispatcher.register(
      buildMethodDefinition('orbit.record.get', async (params: RecordGetWireParams) => ({
        data: await this.recording.get(this.sessionRef(params.context), {
          recordingId: params.recordingId,
          cursor: params.cursor,
          limit: params.limit,
        }),
      })),
    );
    dispatcher.register(
      buildMethodDefinition('orbit.record.clear', async (params: RecordClearWireParams) => ({
        data: await this.recording.clear(this.sessionRef(params.context), {
          recordingId: params.recordingId,
        }),
      })),
    );
    dispatcher.register(
      buildMethodDefinition('orbit.experiment.run', async (params: ExperimentRunWireParams, call) => ({
        data: await this.experiment.runV1(
          this.sessionRef(params.context),
          {
            steps: params.steps,
            timeoutMs: params.timeoutMs,
            continueOnError: params.continueOnError,
          },
          {
            operationId: call.operationId ?? `op_${randomUUID()}`,
            scopes: call.connection?.scopes ?? new Set<string>(),
          },
        ),
      })),
    );
    // --- plan Task 11: RTT and redacted diagnostics -------------------------
    dispatcher.register(
      buildMethodDefinition('orbit.rtt.status', async (params: RttStatusWireParams) => ({
        data: await this.rtt.status(this.sessionRef(params.context), {
          bufferIndex: params.bufferIndex,
        }),
      })),
    );
    dispatcher.register(
      buildMethodDefinition('orbit.rtt.start', async (params: RttStartWireParams) => ({
        data: await this.rtt.start(this.sessionRef(params.context), {
          bufferIndex: params.bufferIndex,
          pollIntervalMs: params.pollIntervalMs,
          targetName: params.targetName,
          ansi: params.ansi,
        }),
      })),
    );
    dispatcher.register(
      buildMethodDefinition('orbit.rtt.stop', async (params: RttStopWireParams) => ({
        data: await this.rtt.stop(this.sessionRef(params.context), {
          bufferIndex: params.bufferIndex,
        }),
      })),
    );
    dispatcher.register(
      buildMethodDefinition('orbit.rtt.read', async (params: RttReadWireParams) => ({
        data: await this.rtt.read(this.sessionRef(params.context), {
          bufferIndex: params.bufferIndex,
          cursor: params.cursor,
          maxBytes: params.maxBytes,
        }),
      })),
    );
    dispatcher.register(
      buildMethodDefinition('orbit.diagnostics.snapshot', async (params: DiagnosticsSnapshotWireParams) => ({
        data: await this.diagnostics.snapshot(params.sessionId),
      })),
    );
  }

  private sessionRef(context: TargetRequestContext): SessionRef {
    return { sessionId: context.sessionId, sessionGeneration: context.sessionGeneration };
  }

  /**
   * One `orbit.target.*` control call: exact-session DAP control, registry
   * state patch from the settled outcome, and the frozen ControlOutcome data.
   */
  private async controlOutcome(
    context: TargetMutationContext,
    request: AutomationControlRequest,
    operationId: string | undefined,
  ): Promise<ControlOutcome> {
    const ref: SessionRef = { sessionId: context.sessionId, sessionGeneration: context.sessionGeneration };
    const session = this.runtime.resolveSession(ref);
    const result = await this.runtime.controlSession(session, request);
    this.applyControlPatch(session, result);
    return this.controlOutcomeData(ref.sessionId, result, operationId);
  }

  /**
   * `orbit.session.restart`: the same DAP restart core as the UI restart
   * request. The VS Code sessionId never changes; exactly one registry
   * generation increment invalidates every old reference/context (§2.3).
   */
  private async restartOutcome(
    context: TargetMutationContext,
    operationId: string | undefined,
  ): Promise<ControlOutcome> {
    const ref: SessionRef = { sessionId: context.sessionId, sessionGeneration: context.sessionGeneration };
    const registry = this.requireSessionRegistry();
    const session = this.runtime.resolveSession(ref);
    const result = await this.runtime.controlSession(session, {
      action: 'restart',
      sessionGeneration: ref.sessionGeneration,
    });
    registry.onRestarted(session);
    this.applyControlPatch(session, result);
    return this.controlOutcomeData(ref.sessionId, result, operationId);
  }

  /**
   * `orbit.target.flash`: explicit ELF path through the current session's
   * selected owner only; the frozen FlashReport mirrors what the owner
   * actually programmed and verified.
   */
  private async flashOutcome(
    params: TargetFlashWireParams,
    operationId: string | undefined,
  ): Promise<FlashReport> {
    const context = params.context;
    const ref: SessionRef = { sessionId: context.sessionId, sessionGeneration: context.sessionGeneration };
    const session = this.runtime.resolveSession(ref);
    const result = await this.runtime.controlSession(session, {
      action: 'flash',
      sessionGeneration: ref.sessionGeneration,
      elfPath: params.elfPath,
      verify: params.verify,
      resetAfter: params.resetAfter,
      timeoutMs: params.timeoutMs,
    });
    this.applyControlPatch(session, result);
    const report = result.flash;
    if (!report) {
      throw new AutomationError('InternalError', 'flash outcome is missing the flash report', false);
    }
    return {
      operationId: operationId ?? `op_${randomUUID()}`,
      elfPath: report.elfPath,
      owner: report.owner,
      bytesProgrammed: report.bytesProgrammed,
      verified: report.verified,
      segments: report.segments.map(segment => ({ ...segment })),
      elapsedMs: report.elapsedMs,
    };
  }

  private requireSessionRegistry(): SessionRegistry {
    const registry = this.options.sessionRegistry;
    if (!registry) {
      throw new AutomationError('NoActiveSession', 'no session registry is wired for control', false);
    }
    return registry;
  }

  /**
   * Mirrors the settled control state into the registry snapshot. Running
   * clears any stale halted metadata (stopReason/pc) so the snapshot never
   * pairs a "running" target with a previous halt's reason and PC.
   */
  private applyControlPatch(session: vscode.DebugSession, result: AutomationControlResult): void {
    if (result.state !== 'running' && result.state !== 'halted') return;
    const patch: SessionUpdatePatch = {
      phase: result.state,
      targetState: result.state,
    };
    if (result.state === 'halted') {
      if (result.stopReason) patch.stopReason = result.stopReason;
      if (result.pc) patch.pc = result.pc;
    } else {
      patch.stopReason = null;
      patch.pc = null;
    }
    this.options.sessionRegistry?.update(session, patch);
  }

  private controlOutcomeData(
    sessionId: string,
    result: AutomationControlResult,
    operationId: string | undefined,
  ): ControlOutcome {
    const snapshot = this.options.sessionRegistry?.getSessionSnapshot(sessionId);
    if (!snapshot) {
      throw new AutomationError('NoActiveSession', `session ${sessionId} has no snapshot`, false);
    }
    return {
      operationId: operationId ?? `op_${randomUUID()}`,
      state: result.state,
      ...(result.pc ? { pc: result.pc } : {}),
      ...(result.stopReason ? { stopReason: result.stopReason } : {}),
      session: snapshot,
    };
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this.setCorsHeaders(res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'GET' && req.url === '/health') {
      this.handleHealth(res);
      return;
    }

    if (req.method === 'GET' && req.url === '/v1/events') {
      this.handleEvents(req, res);
      return;
    }

    if (req.method === 'POST' && req.url === '/v1/rpc') {
      await this.handleV1Rpc(req, res);
      return;
    }

    if (req.method !== 'POST' || req.url !== '/rpc') {
      this.writeJson(res, 404, { ok: false, error: 'Not found' });
      return;
    }

    if (!this.isAuthorized(req)) {
      this.writeJson(res, 401, { ok: false, error: 'Unauthorized' });
      return;
    }

    try {
      const body = await this.readBody(req);
      const request = JSON.parse(body) as JsonRpcRequest;
      const response = await this.handleRpc(request);
      this.writeJson(res, 200, response);
    } catch (err: any) {
      this.writeJson(res, 400, { ok: false, error: err?.message || String(err) });
    }
  }

  /** /health exposes only non-sensitive instance identity; never the token (§2.6). */
  private handleHealth(res: http.ServerResponse): void {
    try {
      if (!this.startedAtMs) {
        this.writeJson(res, 503, { ok: false, status: 'starting' });
        return;
      }
      this.writeJson(res, 200, {
        ok: true,
        status: 'ok',
        instanceId: this.registry.getInstanceId(),
        projectId: this.registry.getProjectId(),
        apiVersion: API_VERSION,
        uptimeMs: Date.now() - this.startedAtMs,
        pid: process.pid,
      });
    } catch {
      this.writeJson(res, 503, { ok: false, status: 'starting' });
    }
  }

  /** `GET /v1/events`: SSE transport (plan §2.5, Task 11). */
  private handleEvents(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (!this.isAuthorized(req)) {
      this.writeJson(res, 401, { ok: false, error: 'Unauthorized' });
      return;
    }
    const connectionId = this.headerValue(req.headers['x-orbit-connection-id']);
    if (!connectionId) {
      this.writeJson(res, 400, { ok: false, error: 'X-Orbit-Connection-Id header is required' });
      return;
    }
    try {
      this.handshake!.authorize(connectionId, 'read');
    } catch {
      this.writeJson(res, 401, { ok: false, error: 'ConnectionExpired' });
      return;
    }
    if (this.sseConnections.size >= MAX_SSE_CONNECTIONS) {
      this.writeJson(res, 429, { ok: false, error: 'SSE connection limit reached' });
      return;
    }

    const eventHub = this.options.eventHub;
    if (!eventHub) {
      this.writeJson(res, 503, { ok: false, error: 'Event stream unavailable' });
      return;
    }

    const filter = this.readEventTypeFilter(req);
    const lastEventId = this.headerValue(req.headers['last-event-id']);
    let initial: AutomationEvent[] = [];
    const replay = eventHub.eventsAfter(lastEventId);
    if (replay.reset) {
      const reset = this.buildResetEvent(replay.latestEventId);
      if (reset) initial.push(reset);
      initial = initial.concat(eventHub.eventsAfter(undefined).events);
    } else {
      initial = replay.events;
    }

    const connection = new SseConnection({
      res,
      filter,
      replay: initial,
      buildResetEvent: () => this.buildResetEvent(eventHub.latestEventId()),
      subscribe: listener => eventHub.subscribe(listener),
    });
    this.sseConnections.add(connection);
    connection.start();
    // Remove from the live set the moment the socket closes (disconnect cleanup).
    res.on('close', () => this.sseConnections.delete(connection));
  }

  /** Reads the repeated `X-Orbit-Event-Type` filter header (empty = no filter). */
  private readEventTypeFilter(req: http.IncomingMessage): ReadonlySet<string> | undefined {
    const raw = req.headers['x-orbit-event-type'];
    const values = Array.isArray(raw) ? raw : (typeof raw === 'string' ? [raw] : []);
    const filtered = values.filter(value => value.trim().length > 0);
    return filtered.length > 0 ? new Set(filtered) : undefined;
  }

  private headerValue(value: string | string[] | undefined): string | undefined {
    const raw = Array.isArray(value) ? value[0] : value;
    return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : undefined;
  }

  /** Builds the synthetic `events.reset` event from redacted snapshots (§2.5). */
  private buildResetEvent(latestEventId?: string): AutomationEvent | undefined {
    const eventHub = this.options.eventHub;
    if (!eventHub) return undefined;
    const id = latestEventId ?? eventHub.latestEventId();
    return {
      eventId: id ?? '0000000000000000',
      instanceId: this.getInstanceId(),
      projectId: this.getProjectId(),
      timestamp: String(Date.now()),
      type: 'events.reset',
      data: {
        latestEventId: id,
        sessions: this.options.sessionRegistry?.snapshot({ includeTerminated: false }) ?? [],
        breakpointCount: this.breakpointService.countSourceBreakpoints(),
        watch: this.viewState.watchExpressionList,
        timeline: this.viewState.timelineSnapshot(false).expressions,
        recording: this.recording.stats(),
      },
    };
  }

  private async handleV1Rpc(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.isAuthorized(req)) {
      this.writeJson(res, 401, { ok: false, error: 'Unauthorized' });
      return;
    }
    try {
      const body = await this.readBody(req);
      let request: unknown;
      try {
        request = JSON.parse(body) as unknown;
      } catch {
        // Malformed JSON must still produce a JSON-RPC 2.0 ParseError envelope.
        this.writeJson(res, 200, {
          jsonrpc: '2.0',
          id: null,
          error: new AutomationError('ParseError', 'invalid JSON body', false).toJsonRpcErrorObject(),
        });
        return;
      }
      if (!this.dispatcher) {
        this.writeJson(res, 503, { ok: false, error: 'Automation API is starting' });
        return;
      }
      const response = await this.dispatcher.dispatch(request, req.headers.authorization);
      if ('result' in response) this.touchConnection(request);
      this.writeJson(res, 200, response);
    } catch (err: any) {
      this.writeJson(res, 400, { ok: false, error: err?.message || String(err) });
    }
  }

  /** Any successful request renews the connection lease (§2.3). */
  private touchConnection(request: unknown): void {
    const params = (request as { params?: { context?: { connectionId?: unknown } } })?.params;
    const connectionId = params?.context?.connectionId;
    if (typeof connectionId === 'string') this.handshake?.touch(connectionId);
  }

  private async handleRpc(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    try {
      if (!request || typeof request.method !== 'string') {
        throw new Error('RPC method is required');
      }

      const data = await this.dispatch(request.method, request.params);
      return { id: request.id, ok: true, data };
    } catch (err: any) {
      return { id: request?.id, ok: false, error: err?.message || String(err) };
    }
  }

  private async dispatch(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'ozone.status':
        return { targetState: await this.runtime.getTargetState() };
      case 'ozone.target.getState':
        return { state: await this.runtime.getTargetState() };
      case 'ozone.expr.readMany':
        return { results: await this.runtime.readSignals(this.readManySignals(params as ReadManyParams)) };
      case 'ozone.expr.writeMany':
        return { results: await this.runtime.writeMany((params as WriteManyParams)?.writes || []) };
      case 'ozone.record.start':
        return this.recorder.start(params as RecordStartParams);
      case 'ozone.record.stop':
        return this.recorder.stop(params as RecordStopParams);
      case 'ozone.record.get':
        return this.recorder.get((params as RecordGetParams).recordingId);
      case 'ozone.record.clear':
        return this.recorder.clear((params as RecordClearParams) || {});
      case 'ozone.experiment.run':
        return this.experiment.run(params as any);
      default:
        throw new Error(`Unsupported method: ${method}`);
    }
  }

  private readManySignals(params: ReadManyParams): SignalSpec[] {
    if (Array.isArray(params?.signals)) return params.signals;
    if (Array.isArray(params?.expressions)) {
      return params.expressions.map(expression => ({ alias: expression, expression }));
    }
    throw new Error('readMany requires signals or expressions');
  }

  private isAuthorized(req: http.IncomingMessage): boolean {
    const header = req.headers.authorization || '';
    return header === `Bearer ${this.token}`;
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = '';
      let length = 0;
      req.setEncoding('utf8');
      req.on('data', chunk => {
        length += Buffer.byteLength(chunk);
        if (length > MAX_BODY_BYTES) {
          reject(new Error('Request body too large'));
          req.destroy();
          return;
        }
        body += chunk;
      });
      req.on('end', () => resolve(body));
      req.on('error', reject);
    });
  }

  private endpointInfo(): ApiEndpointInfo {
    if (!this.server) throw new Error('Plugin API server is not running');
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Plugin API server address unavailable');
    return {
      host: HOST,
      port: address.port,
      token: this.token,
      url: `http://${HOST}:${address.port}/rpc`,
      updatedAt: Date.now(),
    };
  }

  private writeJson(res: http.ServerResponse, statusCode: number, payload: unknown) {
    const body = JSON.stringify(payload);
    res.writeHead(statusCode, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
    });
    res.end(body);
  }

  private setCorsHeaders(res: http.ServerResponse) {
    res.setHeader('access-control-allow-origin', 'http://127.0.0.1');
    res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
    res.setHeader('access-control-allow-headers', 'authorization,content-type');
  }
}
