import * as http from 'http';
import * as path from 'path';
import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
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
  ConnectionContext,
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
import { LaunchConfigurationSummary, WorkspaceFolderInfo } from './protocol';
import { SessionRegistry } from './session-registry';

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

export interface PluginApiServerOptions {
  /** Injected for tests; defaults to an Extension-Host-backed registry. */
  registry?: InstanceRegistry;
  /** Injected for tests; defaults to a registry-backed HandshakeService. */
  handshakeFactory?: (registry: InstanceRegistry) => HandshakeService;
  /** Exact DebugSession registration and generation fence (plan Task 3). */
  sessionRegistry?: SessionRegistry;
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
export function listOrbitLaunchConfigurations(): LaunchConfigurationSummary[] {
  const configs = vscode.workspace
    .getConfiguration('launch')
    .get<Array<Record<string, unknown>>>('configurations', []);
  const firstFolderUri = vscode.workspace.workspaceFolders?.[0]?.uri.toString() ?? '';
  return configs
    .filter((config): config is Record<string, unknown> => typeof config === 'object' && config !== null)
    .filter(config => config.type === 'orbit' || config.type === 'ozone')
    .map(config => ({
      name: String(config.name ?? ''),
      type: config.type as 'orbit' | 'ozone',
      request: (config.request === 'attach' ? 'attach' : 'launch') as 'launch' | 'attach',
      workspaceFolderUri: firstFolderUri,
    }))
    .filter(config => config.name.length > 0);
}

export class PluginApiServer implements vscode.Disposable {
  private server: http.Server | null = null;
  private token = randomBytes(24).toString('hex');
  private runtime: RuntimeRouter;
  private recorder: WaveRecorder;
  private experiment: ExperimentService;
  private registry: InstanceRegistry;
  private handshake: HandshakeService | null = null;
  private dispatcher: RpcDispatcher | null = null;
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
    this.experiment = new ExperimentService(this.runtime, this.recorder);
    this.registry = this.options.registry ?? this.buildRegistry();
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
    this.recorder.dispose();
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
      // SSE transport lands in Task 11.
      this.writeJson(res, 501, { ok: false, error: 'SSE event stream is not implemented yet' });
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
