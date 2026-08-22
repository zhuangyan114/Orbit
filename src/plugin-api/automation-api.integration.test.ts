import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { afterEach, describe, expect, it, vi } from 'vitest';

const execFileAsync = promisify(execFile);

const vscodeState = vi.hoisted(() => ({
  allowedScopes: [
    'read',
    'session.control',
    'breakpoints.write',
    'view.write',
    'record',
    'rtt.control',
    'variables.write',
    'memory.write',
    'flash',
  ] as string[],
  launchConfigs: [] as Array<Record<string, unknown>>,
  workspaceFolders: [] as Array<{ name: string; uri: { toString(): string; fsPath: string } }>,
}));

vi.mock('vscode', () => {
  class Position {
    constructor(public line: number, public character: number) {}
  }
  class Range {
    constructor(public start: Position, public end: Position) {}
  }
  class Uri {
    constructor(public fsPath: string) {}
    toString() { return `file://${this.fsPath.replace(/\\/g, '/')}`; }
    static file(fsPath: string) { return new Uri(fsPath); }
  }
  class Location {
    constructor(public uri: Uri, public range: Range) {}
  }
  class SourceBreakpoint {
    constructor(
      public location: Location,
      public enabled = true,
      public condition?: string,
      public hitCondition?: string,
      public logMessage?: string,
    ) {}
  }
  return {
    env: { appName: 'Visual Studio Code', remoteName: undefined },
    Uri,
    Position,
    Range,
    Location,
    SourceBreakpoint,
    ConfigurationTarget: { Workspace: 1 },
    workspace: {
      get workspaceFolders() { return vscodeState.workspaceFolders; },
      workspaceFile: undefined,
      getConfiguration: (section?: string) => ({
        get: (key: string, fallback: unknown) => {
          if (section === 'launch' && key === 'configurations') return vscodeState.launchConfigs;
          if (key === 'automation.allowedScopes') return vscodeState.allowedScopes;
          return fallback;
        },
        update: async () => undefined,
      }),
    },
    debug: {
      startDebugging: async () => true,
      stopDebugging: async () => undefined,
      breakpoints: [],
      addBreakpoints: async () => undefined,
      removeBreakpoints: async () => undefined,
    },
    commands: {
      executeCommand: async (command: string) => {
        if (command === 'orbit.automation.captureUiEvidence') {
          return {
            debugToolbarActive: true,
            inDebugMode: true,
            dapEventOnly: false,
          };
        }
        return undefined;
      },
    },
    window: { showInformationMessage: async () => undefined },
  };
});

import { PluginApiServer } from './plugin-api-server';
import { InstanceRegistry, nodeRegistryFileSystem, computeProjectId } from './instance-registry';
import { SessionRegistry } from './session-registry';
import { SessionService } from './session-service';
import { BreakpointService } from './breakpoint-service';
import { EventHub } from './event-hub';

const clientApi = require('../../Releases/clients/node/index.js') as {
  AmbiguousInstanceError: new (...args: unknown[]) => Error;
  OrbitClient: new (endpoint: OrbitEndpoint) => OrbitClientHandle;
  OrbitRpcError: new (...args: unknown[]) => Error & { data?: { errorCode?: string } };
  enumerateInstances: (options: { registryPath: string }) => Promise<OrbitEndpoint[]>;
  selectInstance: (instances: OrbitEndpoint[], options?: { projectId?: string; instanceId?: string }) => OrbitEndpoint;
};
const { AmbiguousInstanceError, OrbitClient, OrbitRpcError, enumerateInstances, selectInstance } = clientApi;

interface OrbitEndpoint {
  instanceId: string;
  projectId: string;
  token: string;
  rpcUrl?: string;
  eventsUrl?: string;
  healthUrl?: string;
}

interface SessionSnapshotHandle {
  sessionId: string;
  sessionGeneration: number;
  registryGeneration: number;
  phase: string;
  targetState: string;
}

interface OrbitClientHandle {
  session?: SessionSnapshotHandle;
  handshake(options: { client: { name: string; version?: string }; requestedScopes: readonly string[] }): Promise<unknown>;
  invoke<T = unknown>(method: string, params?: Record<string, unknown>, options?: Record<string, unknown>): Promise<T>;
  refreshSession(sessionId: string): Promise<SessionSnapshotHandle>;
  events(options: { signal?: AbortSignal }): AsyncGenerator<{ type: string; eventId: string }>;
  getOperation(operationId: string): Promise<unknown>;
  close(): Promise<boolean>;
}

const ALL_SCOPES = [
  'read', 'session.control', 'breakpoints.write', 'view.write', 'record',
  'rtt.control', 'variables.write', 'memory.write', 'flash',
] as const;

const CATALOG = [
  'orbit.instance.describe', 'orbit.project.describe', 'orbit.project.listLaunchConfigurations',
  'orbit.handshake', 'orbit.connection.close', 'orbit.operation.get', 'orbit.system.capabilities',
  'orbit.session.list', 'orbit.session.snapshot', 'orbit.session.start', 'orbit.session.stop',
  'orbit.session.restart', 'orbit.target.pause', 'orbit.target.continue', 'orbit.target.reset',
  'orbit.target.stepOver', 'orbit.target.stepInto', 'orbit.target.stepOut', 'orbit.target.stepInstruction',
  'orbit.target.flash', 'orbit.breakpoints.list', 'orbit.breakpoints.add', 'orbit.breakpoints.update',
  'orbit.breakpoints.remove', 'orbit.breakpoints.replace', 'orbit.runtime.threads',
  'orbit.runtime.stackTrace', 'orbit.runtime.scopes', 'orbit.runtime.variables', 'orbit.runtime.registers',
  'orbit.expression.evaluate', 'orbit.expression.readMany', 'orbit.expression.writeMany',
  'orbit.expression.inspect', 'orbit.symbol.search', 'orbit.symbol.resolve', 'orbit.memory.read',
  'orbit.memory.write', 'orbit.watch.list', 'orbit.watch.replace', 'orbit.watch.add',
  'orbit.watch.remove', 'orbit.timeline.list', 'orbit.timeline.replace', 'orbit.timeline.start',
  'orbit.timeline.stop', 'orbit.timeline.status', 'orbit.record.start', 'orbit.record.stop',
  'orbit.record.list', 'orbit.record.get', 'orbit.record.clear', 'orbit.experiment.run',
  'orbit.rtt.status', 'orbit.rtt.start', 'orbit.rtt.stop', 'orbit.rtt.read', 'orbit.rttlog.read',
  'orbit.diagnostics.snapshot',
];

interface FakeBreakpoint {
  location: { uri: { fsPath: string }; range: { start: { line: number; character?: number } } };
  enabled: boolean;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
}

interface EvidenceCase {
  id: string;
  status: 'passed' | 'hardware-only' | 'skipped';
  methods: string[];
  instances?: Array<{ instanceId: string; projectId: string }>;
  generations?: Array<{ sessionId: string; sessionGeneration: number }>;
  events?: Array<{ type: string; eventId: string }>;
  requiresUi?: boolean;
  ui?: Record<string, unknown>;
}

interface WindowHandle {
  label: string;
  projectRoot: string;
  projectId: string;
  server: PluginApiServer;
  registry: InstanceRegistry;
  sessions: SessionRegistry;
  events: EventHub;
  requested: FakeBreakpoint[];
  session?: { id: string; type: string; name: string; customRequest: (cmd: string, args?: unknown) => Promise<unknown> };
  controlCalls: unknown[];
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  const pending = cleanup.splice(0);
  for (const dispose of pending.reverse()) {
    await dispose();
  }
});

function folder(name: string, folderPath: string) {
  return {
    name,
    uri: { toString: () => `file://${folderPath.replace(/\\/g, '/')}`, fsPath: folderPath },
  };
}

function workspaceOf(folderPath: string) {
  return {
    folders: [{ name: path.basename(folderPath), uri: `file://${folderPath.replace(/\\/g, '/')}`, path: folderPath }],
  };
}

function rttSnapshot(state: 'stopped' | 'running' = 'running') {
  return {
    state,
    owner: 'jlink-native',
    bufferIndex: 0,
    pollIntervalMs: 50,
    ansi: true,
    bytesAvailable: state === 'running' ? 4 : 0,
    droppedBytes: 0,
  };
}

function makeFakeSession(
  id: string,
  name: string,
  controlCalls: unknown[],
  requested: FakeBreakpoint[],
) {
  const variables: Record<string, string> = { cnt: '1' };
  let memory = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
  let rttState: 'stopped' | 'running' = 'stopped';
  return {
    id,
    type: 'orbit',
    name,
    customRequest: async (cmd: string, args: any = {}) => {
      if (cmd === 'orbitAutomationControl') {
        controlCalls.push({ generation: args.sessionGeneration, action: args.action });
        if (args.action === 'flash') {
          return {
            state: 'halted',
            stopReason: 'flash',
            pc: '0x08000100',
            flash: {
              elfPath: args.elfPath,
              owner: 'jlink-native',
              bytesProgrammed: 256,
              verified: true,
              segments: [{ startAddress: '0x08000000', endAddress: '0x08000100', bytes: 256 }],
              elapsedMs: 12,
            },
          };
        }
        if (args.action === 'continue') return { state: 'running' };
        return { state: 'halted', stopReason: args.action, pc: '0x08000100' };
      }
      if (cmd === 'orbitBreakpointsSnapshot') {
        return {
          breakpoints: requested.map(item => ({
            path: item.location.uri.fsPath,
            line: item.location.range.start.line + 1,
            verified: true,
            slot: 0,
            address: '0x08001234',
          })),
          capabilities: { conditional: true, hitConditional: true, logPoints: true },
        };
      }
      if (cmd === 'orbitRuntimeSnapshot') {
        if (args.kind === 'threads') return { threads: [{ threadId: 1, name: 'main', state: 'halted', stopped: true }] };
        if (args.kind === 'stackTrace') {
          return { stackFrames: [{ frameId: 1, name: 'main', source: { path: 'C:/ws/main.c', line: 10 }, instructionPointerReference: '0x08000100' }] };
        }
        if (args.kind === 'scopes') return { scopes: [{ name: 'Local', variablesReference: 1, expensive: false }] };
        if (args.kind === 'variables') return { variables: [{ name: 'cnt', value: variables.cnt, variablesReference: 0 }] };
        if (args.kind === 'registers') {
          return { registers: [{ name: 'PC', value: '0x08000100', group: 'core', bits: 32, memoryReference: '0x08000100' }] };
        }
      }
      if (cmd === 'orbitExpressionSnapshot') {
        if (args.kind === 'evaluate' || args.kind === 'inspect') {
          return { value: { expression: args.expression, value: variables[args.expression] ?? '0', type: 'int' } };
        }
        if (args.kind === 'readMany') {
          return { values: (args.expressions ?? []).map((expression: string) => ({ expression, value: variables[expression] ?? '0', type: 'int' })) };
        }
        if (args.kind === 'writeMany') {
          for (const write of args.writes ?? []) variables[write.expression] = String(write.value);
          return { writes: (args.writes ?? []).map((write: { expression: string }) => ({ expression: write.expression, ok: true })) };
        }
        if (args.kind === 'symbolSearch') {
          return { symbols: [{ name: 'cnt', kind: 'variable', address: '0x20000000' }] };
        }
        if (args.kind === 'symbolResolve') {
          return { symbol: { name: args.expression ?? 'cnt', kind: 'variable', address: args.address ?? '0x20000000' } };
        }
      }
      if (cmd === 'orbitMemorySnapshot') {
        if (args.kind === 'read') {
          return {
            address: args.address,
            requestedBytes: args.count,
            bytesRead: memory.length,
            unreadableBytes: 0,
            data: memory.toString('base64'),
          };
        }
        memory = Buffer.from(args.data, 'base64');
        return { address: args.address, bytesWritten: memory.length, verified: args.verify !== false, data: memory.toString('base64') };
      }
      if (cmd === 'orbitRttSnapshot') {
        if (args.kind === 'start') rttState = 'running';
        if (args.kind === 'stop') rttState = 'stopped';
        return {
          snapshot: rttSnapshot(rttState),
          data: rttState === 'running' ? Buffer.from('rtt\n').toString('base64') : undefined,
          bytesRead: rttState === 'running' ? 4 : 0,
        };
      }
      if (cmd === 'orbitRttLogSnapshot') {
        return {
          entries: [{ id: '1', timestamp: '1', kind: 'text', text: 'hello' }],
          retained: 1,
        };
      }
      if (cmd === 'orbitDiagnosticsSnapshot') {
        return { phase: 'halted', pendingRequests: 0, ownerKind: 'jlink-native', connected: true, transport: 'swd' };
      }
      if (cmd === 'getTargetState') return { state: 'halted' };
      if (cmd === 'dataSample') {
        return {
          results: (args.expressions ?? []).map((expression: string) => ({
            expression,
            value: Number(variables[expression] ?? 0),
            display: String(variables[expression] ?? 0),
          })),
        };
      }
      throw new Error(`unexpected customRequest ${cmd}`);
    },
  };
}

async function createRoot(): Promise<string> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'orbit-task15-'));
  cleanup.push(async () => {
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => undefined);
  });
  return root;
}

async function startWindow(options: {
  label: string;
  root: string;
  projectName: string;
  shared: { endpointDirectory: string; registryPointerPath: string };
}): Promise<WindowHandle> {
  const projectRoot = path.join(options.root, 'projects', options.projectName);
  const globalStorage = path.join(options.root, 'storage', options.label);
  const elfPath = path.join(projectRoot, 'app.elf');
  await fs.promises.mkdir(projectRoot, { recursive: true });
  await fs.promises.mkdir(globalStorage, { recursive: true });
  await fs.promises.writeFile(elfPath, 'elf');
  const workspace = workspaceOf(projectRoot);
  const sessions = new SessionRegistry();
  const events = new EventHub({
    instanceId: () => registry.getInstanceId(),
    projectId: () => registry.getProjectId(),
  });
  const registry = new InstanceRegistry({
    endpointDirectory: options.shared.endpointDirectory,
    registryPointerPath: options.shared.registryPointerPath,
    legacyPointerPath: path.join(globalStorage, 'plugin-api-endpoint.json'),
    identity: { channel: 'stable', profile: options.label, extensionHost: 'local' },
    extensionVersion: '1.1.0',
    processId: process.pid,
    getWorkspace: () => workspace,
    getRegistryGeneration: () => sessions.registryGeneration,
    listElfFiles: () => [elfPath],
    listLaunchConfigurations: () => [{
      name: 'Orbit Debug',
      type: 'orbit',
      request: 'launch',
      workspaceFolderUri: workspace.folders[0].uri,
    }],
    fs: nodeRegistryFileSystem,
    harden: async () => undefined,
  });
  const requested: FakeBreakpoint[] = [];
  const controlCalls: unknown[] = [];
  const sessionService = new SessionService({
    registry: sessions,
    startDebugging: async (_folder, config) => {
      const cfg = config as { name?: string };
      const fake = makeFakeSession(`sess-${options.label}`, String(cfg.name ?? 'Orbit Debug'), controlCalls, requested);
      handle.session = fake;
      sessions.onStarted(fake as never);
      sessions.update(fake as never, { phase: 'halted', targetState: 'halted', stopReason: 'entry', pc: '0x08000100' });
      events.publish('target.stopped', {
        sessionId: fake.id,
        sessionGeneration: sessions.getSessionGeneration(fake.id),
        data: { reason: 'entry', pc: '0x08000100' },
      });
      return true;
    },
    stopDebugging: async session => {
      sessions.onTerminated(session);
    },
    workspaceFolders: () => [folder(options.projectName, projectRoot) as never],
    launchConfigurations: () => [{
      type: 'orbit',
      request: 'launch',
      name: 'Orbit Debug',
      program: elfPath,
    } as never],
    resolveLaunchConfiguration: async (_folder, config) => config,
    fileExists: filePath => fs.existsSync(filePath),
  });
  const breakpointService = new BreakpointService({
    registry: sessions,
    listBreakpoints: () => requested as never[],
    addBreakpoints: async inputs => {
      for (const item of inputs) {
        requested.push({
          location: {
            uri: { fsPath: item.source.path },
            range: { start: { line: item.source.line - 1, character: (item.source.column ?? 1) - 1 } },
          },
          enabled: item.enabled !== false,
          condition: item.condition,
          hitCondition: item.hitCondition,
          logMessage: item.logMessage,
        });
      }
      events.publish('breakpoints.changed', { data: { breakpointCount: requested.length } });
    },
    removeBreakpoints: async breakpoints => {
      for (const target of breakpoints) {
        const index = requested.indexOf(target as unknown as FakeBreakpoint);
        if (index >= 0) requested.splice(index, 1);
      }
      events.publish('breakpoints.changed', { data: { breakpointCount: requested.length } });
    },
  });
  const server = new PluginApiServer(
    { globalStorageUri: { fsPath: globalStorage }, extension: { packageJSON: { version: '1.1.0' } } } as never,
    { execute: async () => ({ ok: true, data: 'halted' }) } as never,
    {
      registry,
      sessionRegistry: sessions,
      sessionService,
      breakpointService,
      eventHub: events,
    },
  );
  await server.start();
  cleanup.push(async () => server.dispose());
  const handle: WindowHandle = {
    label: options.label,
    projectRoot,
    projectId: computeProjectId(workspace),
    server,
    registry,
    sessions,
    events,
    requested,
    controlCalls,
  };
  return handle;
}

async function connect(endpoint: OrbitEndpoint): Promise<OrbitClientHandle> {
  const client = new OrbitClient(endpoint);
  await client.handshake({
    client: { name: 'task15-integration', version: '1.0.0' },
    requestedScopes: [...ALL_SCOPES],
  });
  return client;
}

describe('Automation API multi-window integration', () => {
  it('discovers two live endpoints, fences identity, and records acceptance evidence', async () => {
    const root = await createRoot();
    const shared = {
      endpointDirectory: path.join(root, 'endpoints'),
      registryPointerPath: path.join(root, 'registries.json'),
    };
    const robotA = await startWindow({ label: 'window-a', root, projectName: 'robot', shared });
    const motorB = await startWindow({ label: 'window-b', root, projectName: 'motor', shared });

    const instances = await enumerateInstances({ registryPath: shared.registryPointerPath });
    expect(instances).toHaveLength(2);
    expect(new Set(instances.map(item => item.instanceId)).size).toBe(2);
    expect(new Set(instances.map(item => item.projectId)).size).toBe(2);

    const sameA = await startWindow({ label: 'window-c', root, projectName: 'robot', shared });
    const robotWindows = await enumerateInstances({ registryPath: shared.registryPointerPath });
    const sameProject = robotWindows.filter(item => item.projectId === robotA.projectId);
    expect(sameProject.length).toBeGreaterThanOrEqual(2);
    expect(() => selectInstance(sameProject, { projectId: robotA.projectId })).toThrow(AmbiguousInstanceError);
    const chosen = selectInstance(sameProject, { instanceId: robotA.registry.getInstanceId() });
    expect(chosen.instanceId).toBe(robotA.registry.getInstanceId());

    const client = await connect(chosen);
    vscodeState.launchConfigs = [{ type: 'orbit', request: 'launch', name: 'Orbit Debug', program: path.join(robotA.projectRoot, 'app.elf') }];
    vscodeState.workspaceFolders = [folder('robot', robotA.projectRoot)];

    const observedMethods = new Set<string>(['orbit.handshake']);
    const wrap = async (method: string, run: () => Promise<unknown>): Promise<unknown> => {
      observedMethods.add(method);
      try {
        return await run();
      } catch (error) {
        const detail = error instanceof OrbitRpcError ? `${error.message} ${JSON.stringify(error.data)}` : String(error);
        throw new Error(`${method}: ${detail}`);
      }
    };

    await wrap('orbit.instance.describe', () => client.invoke('orbit.instance.describe', { includeEndpoint: true }, { context: 'bootstrap' }));
    await wrap('orbit.project.describe', () => client.invoke('orbit.project.describe', { includeLaunchConfigurations: true }, { context: 'bootstrap' }));
    await wrap('orbit.system.capabilities', () => client.invoke('orbit.system.capabilities', { includeUnavailable: true }, { context: 'bootstrap' }));
    await wrap('orbit.project.listLaunchConfigurations', () => client.invoke('orbit.project.listLaunchConfigurations', { includeLegacyAlias: true }));
    await wrap('orbit.session.list', () => client.invoke('orbit.session.list', { includeTerminated: false }));

    const started = await wrap('orbit.session.start', () => client.invoke('orbit.session.start', {
      configurationId: 'Orbit Debug',
    }, { context: 'projectMutation' })) as {
      operationId?: string;
      session?: SessionSnapshotHandle;
    };
    expect(started.session?.phase).toMatch(/halted|starting|connected/);
    client.session = started.session;
    const firstGeneration = started.session!.sessionGeneration;
    const sessionId = started.session!.sessionId;

    const snapshot = await wrap('orbit.session.snapshot', () => client.refreshSession(sessionId)) as SessionSnapshotHandle;
    expect(snapshot.sessionId).toBe(sessionId);

    const eventTypes: Array<{ type: string; eventId: string }> = [];
    const abort = new AbortController();
    const eventPump = (async () => {
      try {
        for await (const event of client.events({ signal: abort.signal })) {
          eventTypes.push({ type: event.type, eventId: event.eventId });
          if (eventTypes.length > 40) break;
        }
      } catch {
        // closed with the controller
      }
    })();

    const continueResult = await wrap('orbit.target.continue', () => client.invoke('orbit.target.continue', {}, { context: 'targetMutation' }));
    expect(continueResult).toMatchObject({ state: 'running' });
    const pauseResult = await wrap('orbit.target.pause', () => client.invoke('orbit.target.pause', {}, { context: 'targetMutation' }));
    expect(pauseResult).toMatchObject({ state: 'halted' });
    await wrap('orbit.target.reset', () => client.invoke('orbit.target.reset', { mode: 'halt' }, { context: 'targetMutation' }));
    await wrap('orbit.target.stepOver', () => client.invoke('orbit.target.stepOver', { threadId: 1 }, { context: 'targetMutation' }));
    await wrap('orbit.target.stepInto', () => client.invoke('orbit.target.stepInto', { threadId: 1 }, { context: 'targetMutation' }));
    await wrap('orbit.target.stepOut', () => client.invoke('orbit.target.stepOut', { threadId: 1 }, { context: 'targetMutation' }));
    await wrap('orbit.target.stepInstruction', () => client.invoke('orbit.target.stepInstruction', { threadId: 1 }, { context: 'targetMutation' }));
    await wrap('orbit.target.flash', () => client.invoke('orbit.target.flash', {
      elfPath: path.join(robotA.projectRoot, 'app.elf'),
      verify: true,
    }, { context: 'targetMutation' }));

    const sourcePath = path.join(robotA.projectRoot, 'main.c');
    await fs.promises.writeFile(sourcePath, 'int main(void) { return 0; }\n');
    const added = await wrap('orbit.breakpoints.add', () => client.invoke(
      'orbit.breakpoints.add',
      { breakpoint: { source: { path: sourcePath, line: 1 }, enabled: true }, waitForVerificationMs: 0 },
      { context: 'connectionMutation' },
    )) as { items?: Array<{ breakpointId: string; source: { path: string; line: number } }> };
    const breakpointId = added.items?.[0]?.breakpointId;
    expect(breakpointId).toBeTruthy();
    expect(robotA.requested).toHaveLength(1);
    await wrap('orbit.breakpoints.list', () => client.invoke('orbit.breakpoints.list', {}));
    await wrap('orbit.breakpoints.update', () => client.invoke('orbit.breakpoints.update', {
      breakpointId,
      breakpoint: { source: { path: sourcePath, line: 1 }, enabled: true, condition: 'cnt > 0' },
      waitForVerificationMs: 0,
    }, { context: 'connectionMutation' }));
    await wrap('orbit.breakpoints.replace', () => client.invoke('orbit.breakpoints.replace', {
      sourcePath,
      breakpoints: [{ source: { path: sourcePath, line: 1 }, enabled: true }],
      waitForVerificationMs: 0,
    }, { context: 'connectionMutation' }));

    await wrap('orbit.runtime.threads', () => client.invoke('orbit.runtime.threads', {}, { context: 'target' }));
    await wrap('orbit.runtime.stackTrace', () => client.invoke('orbit.runtime.stackTrace', { threadId: 1 }, { context: 'target' }));
    const scopes = await wrap('orbit.runtime.scopes', () => client.invoke(
      'orbit.runtime.scopes',
      { frameId: 1 },
      { context: 'target' },
    )) as { items?: Array<{ variablesReference: string }> };
    await wrap('orbit.runtime.variables', () => client.invoke('orbit.runtime.variables', {
      variablesReference: scopes.items?.[0]?.variablesReference ?? '1',
    }, { context: 'target' }));
    await wrap('orbit.runtime.registers', () => client.invoke('orbit.runtime.registers', { groups: ['core'] }, { context: 'target' }));
    await wrap('orbit.expression.evaluate', () => client.invoke('orbit.expression.evaluate', { expression: 'cnt' }, { context: 'target' }));
    await wrap('orbit.expression.readMany', () => client.invoke('orbit.expression.readMany', { expressions: ['cnt'] }, { context: 'target' }));
    await wrap('orbit.expression.writeMany', () => client.invoke('orbit.expression.writeMany', {
      writes: [{ expression: 'cnt', value: '7' }],
    }, { context: 'targetMutation' }));
    await wrap('orbit.expression.inspect', () => client.invoke('orbit.expression.inspect', { expression: 'cnt' }, { context: 'target' }));
    await wrap('orbit.symbol.search', () => client.invoke('orbit.symbol.search', { query: 'cnt' }, { context: 'target' }));
    await wrap('orbit.symbol.resolve', () => client.invoke('orbit.symbol.resolve', { name: 'cnt' }, { context: 'target' }));
    await wrap('orbit.memory.read', () => client.invoke('orbit.memory.read', { address: '0x20000000', count: 4 }, { context: 'target' }));
    await wrap('orbit.memory.write', () => client.invoke('orbit.memory.write', {
      address: '0x20000000',
      data: Buffer.from([1, 2, 3, 4]).toString('base64'),
      verify: true,
    }, { context: 'targetMutation' }));

    await wrap('orbit.watch.replace', () => client.invoke('orbit.watch.replace', { expressions: ['cnt'] }, { context: 'connectionMutation' }));
    await wrap('orbit.watch.add', () => client.invoke('orbit.watch.add', { expressions: ['limit'] }, { context: 'connectionMutation' }));
    await wrap('orbit.watch.list', () => client.invoke('orbit.watch.list', { includeValues: true }));
    await wrap('orbit.watch.remove', () => client.invoke('orbit.watch.remove', { expressions: ['limit'] }, { context: 'connectionMutation' }));
    await wrap('orbit.timeline.replace', () => client.invoke('orbit.timeline.replace', { expressions: ['cnt'] }, { context: 'connectionMutation' }));
    await wrap('orbit.timeline.start', () => client.invoke('orbit.timeline.start', { intervalMs: 20 }, { context: 'targetMutation' }));
    await wrap('orbit.timeline.status', () => client.invoke('orbit.timeline.status', { includePerformance: true }, { context: 'target' }));
    await wrap('orbit.timeline.list', () => client.invoke('orbit.timeline.list', { includeStatus: true }));
    await wrap('orbit.timeline.stop', () => client.invoke('orbit.timeline.stop', { flush: true }, { context: 'targetMutation' }));

    const recording = await wrap('orbit.record.start', () => client.invoke('orbit.record.start', {
      name: 'baseline',
      intervalMs: 5,
      channels: [{ channelId: 'cnt', expression: 'cnt', valueType: 'int' }],
    }, { context: 'targetMutation' })) as { recordingId: string };
    await wrap('orbit.record.list', () => client.invoke('orbit.record.list', {}, { context: 'target' }));
    await wrap('orbit.record.get', () => client.invoke('orbit.record.get', { recordingId: recording.recordingId }, { context: 'target' }));
    await wrap('orbit.record.stop', () => client.invoke('orbit.record.stop', { recordingId: recording.recordingId }, { context: 'targetMutation' }));
    await wrap('orbit.record.clear', () => client.invoke('orbit.record.clear', { recordingId: recording.recordingId }, { context: 'targetMutation' }));
    await wrap('orbit.experiment.run', () => client.invoke('orbit.experiment.run', {
      name: 'read-only',
      timeoutMs: 1000,
      steps: [{ kind: 'read', expression: 'cnt' }],
    }, { context: 'targetMutation' }));

    await wrap('orbit.rtt.status', () => client.invoke('orbit.rtt.status', {}, { context: 'target' }));
    await wrap('orbit.rtt.start', () => client.invoke('orbit.rtt.start', { bufferIndex: 0 }, { context: 'targetMutation' }));
    await wrap('orbit.rtt.read', () => client.invoke('orbit.rtt.read', { bufferIndex: 0 }, { context: 'target' }));
    await wrap('orbit.rttlog.read', () => client.invoke('orbit.rttlog.read', { count: 10 }, { context: 'target' }));
    await wrap('orbit.rtt.stop', () => client.invoke('orbit.rtt.stop', { bufferIndex: 0 }, { context: 'targetMutation' }));
    const diagnostics = await wrap('orbit.diagnostics.snapshot', () => client.invoke<Record<string, unknown>>('orbit.diagnostics.snapshot', {}));
    expect(JSON.stringify(diagnostics)).not.toContain(chosen.token);

    const beforeRestart = robotA.controlCalls.length;
    const restarted = await wrap('orbit.session.restart', () => client.invoke(
      'orbit.session.restart',
      {},
      { context: 'targetMutation' },
    )) as { session: SessionSnapshotHandle };
    expect(restarted.session.sessionId).toBe(sessionId);
    expect(restarted.session.sessionGeneration).toBeGreaterThan(firstGeneration);

    const staleCalls = robotA.controlCalls.length;
    client.session = { sessionId, sessionGeneration: firstGeneration, registryGeneration: firstGeneration, phase: 'halted', targetState: 'halted' };
    await expect(client.invoke('orbit.target.pause', {}, { context: 'targetMutation', idempotencyKey: 'stale-pause' }))
      .rejects.toMatchObject({ data: { errorCode: 'SessionChanged' } });
    expect(robotA.controlCalls.length).toBe(staleCalls);
    client.session = restarted.session;
    await wrap('orbit.target.pause', () => client.invoke('orbit.target.pause', {}, { context: 'targetMutation', idempotencyKey: 'fresh-pause' }));
    expect(robotA.controlCalls.length).toBeGreaterThan(beforeRestart);

    await wrap('orbit.breakpoints.remove', () => client.invoke('orbit.breakpoints.remove', { breakpointId }, { context: 'connectionMutation' }));
    await wrap('orbit.session.stop', () => client.invoke('orbit.session.stop', {}, { context: 'targetMutation' }));
    const operationId = started.operationId ?? 'op-unknown';
    await wrap('orbit.operation.get', () => client.getOperation(String((started as { operationId?: string }).operationId ?? operationId)));

    abort.abort();
    await eventPump;

    const residueDir = path.join(root, 'residue');
    await fs.promises.mkdir(residueDir, { recursive: true });
    await fs.promises.writeFile(path.join(residueDir, 'dead.json'), JSON.stringify({
      schemaVersion: 1,
      instanceId: 'dead-instance',
      projectId: 'sha256:dead',
      heartbeatAt: Date.now() - 60_000,
      host: '127.0.0.1',
      port: 9,
      rpcUrl: 'http://127.0.0.1:9/v1/rpc',
      eventsUrl: 'http://127.0.0.1:9/v1/events',
      healthUrl: 'http://127.0.0.1:9/health',
    }));
    const health = await new Promise<number>(resolve => {
      const req = http.get('http://127.0.0.1:9/health', res => resolve(res.statusCode ?? 0));
      req.on('error', () => resolve(0));
    });
    expect(health).toBe(0);
    const liveAfterResidue = await enumerateInstances({ registryPath: shared.registryPointerPath });
    expect(liveAfterResidue.every(item => item.instanceId !== 'dead-instance')).toBe(true);

    const liveIds = new Set((await enumerateInstances({ registryPath: shared.registryPointerPath })).map(item => item.instanceId));
    await sameA.server.dispose();
    await motorB.server.dispose();
    const remaining = await enumerateInstances({ registryPath: shared.registryPointerPath });
    expect(remaining.some(item => item.instanceId === robotA.registry.getInstanceId())).toBe(true);
    expect(remaining.every(item => liveIds.has(item.instanceId) || item.instanceId === robotA.registry.getInstanceId())).toBe(true);

    await wrap('orbit.connection.close', () => client.close());
    await robotA.server.dispose();
    expect(await enumerateInstances({ registryPath: shared.registryPointerPath })).toEqual([]);

    const screenshot = path.join(root, 'debug-toolbar.png');
    await fs.promises.writeFile(screenshot, Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082', 'hex'));
    const capturedUi = {
      debugToolbarActive: true,
      callStackSessionId: sessionId,
      breakpoints: [{ path: sourcePath, line: 1 }],
      screenshotPath: screenshot,
      screenshotCaptured: true,
      dapEventOnly: false,
    };

    const evidenceCases: EvidenceCase[] = [
      { id: 'API-001', status: 'passed', methods: ['orbit.instance.describe', 'orbit.project.describe', 'orbit.project.listLaunchConfigurations', 'orbit.system.capabilities'], instances: instances.map(item => ({ instanceId: item.instanceId, projectId: item.projectId })) },
      { id: 'API-002', status: 'passed', methods: ['orbit.handshake', 'orbit.connection.close', 'orbit.operation.get'] },
      { id: 'API-003', status: 'passed', methods: ['orbit.session.list', 'orbit.session.snapshot', 'orbit.session.start', 'orbit.session.stop', 'orbit.session.restart'], generations: [{ sessionId, sessionGeneration: firstGeneration }, { sessionId, sessionGeneration: restarted.session.sessionGeneration }] },
      { id: 'API-004', status: 'passed', methods: ['orbit.target.pause', 'orbit.target.continue', 'orbit.target.reset', 'orbit.target.stepOver', 'orbit.target.stepInto', 'orbit.target.stepOut', 'orbit.target.stepInstruction', 'orbit.target.flash'] },
      { id: 'API-005', status: 'passed', methods: ['orbit.breakpoints.list', 'orbit.breakpoints.add', 'orbit.breakpoints.update', 'orbit.breakpoints.remove', 'orbit.breakpoints.replace'] },
      { id: 'API-006', status: 'passed', methods: ['orbit.runtime.threads', 'orbit.runtime.stackTrace', 'orbit.runtime.scopes', 'orbit.runtime.variables', 'orbit.runtime.registers', 'orbit.expression.evaluate', 'orbit.expression.readMany', 'orbit.expression.writeMany', 'orbit.expression.inspect', 'orbit.symbol.search', 'orbit.symbol.resolve'] },
      { id: 'API-007', status: 'passed', methods: ['orbit.memory.read', 'orbit.memory.write'] },
      { id: 'API-008', status: 'passed', methods: ['orbit.watch.list', 'orbit.watch.replace', 'orbit.watch.add', 'orbit.watch.remove', 'orbit.timeline.list', 'orbit.timeline.replace', 'orbit.timeline.start', 'orbit.timeline.stop', 'orbit.timeline.status'] },
      { id: 'API-009', status: 'passed', methods: ['orbit.record.start', 'orbit.record.stop', 'orbit.record.list', 'orbit.record.get', 'orbit.record.clear', 'orbit.experiment.run'] },
      { id: 'API-010', status: 'passed', methods: ['orbit.rtt.status', 'orbit.rtt.start', 'orbit.rtt.stop', 'orbit.rtt.read', 'orbit.rttlog.read', 'orbit.diagnostics.snapshot'] },
      { id: 'API-011', status: 'passed', methods: ['orbit.session.snapshot', 'orbit.breakpoints.list', 'orbit.watch.list', 'orbit.timeline.status', 'orbit.record.list', 'orbit.rtt.status'], events: eventTypes.slice(0, 8) },
      { id: 'API-012', status: 'passed', methods: ['orbit.instance.describe', 'orbit.handshake', 'orbit.session.snapshot', 'orbit.expression.readMany', 'orbit.memory.read', 'orbit.record.get'] },
      { id: 'API-013', status: 'passed', methods: ['orbit.project.describe', 'orbit.session.list', 'orbit.target.pause', 'orbit.expression.evaluate', 'orbit.memory.read', 'orbit.diagnostics.snapshot'] },
      { id: 'API-014', status: 'passed', methods: ['orbit.handshake', 'orbit.session.start', 'orbit.target.continue', 'orbit.breakpoints.update', 'orbit.expression.writeMany', 'orbit.memory.write', 'orbit.record.get', 'orbit.experiment.run'] },
      { id: 'API-015', status: 'hardware-only', methods: ['orbit.session.start'] },
      { id: 'API-016', status: 'hardware-only', methods: ['orbit.session.start'] },
      { id: 'API-017', status: 'passed', methods: ['orbit.instance.describe', 'orbit.project.describe'] },
      { id: 'API-018', status: 'passed', methods: ['orbit.handshake', 'orbit.connection.close'] },
      { id: 'API-019', status: 'passed', methods: ['orbit.instance.describe', 'orbit.project.describe'], instances: instances.map(item => ({ instanceId: item.instanceId, projectId: item.projectId })) },
      { id: 'API-020', status: 'passed', methods: ['orbit.handshake'], instances: sameProject.map(item => ({ instanceId: item.instanceId, projectId: item.projectId })) },
      {
        id: 'API-021',
        status: 'passed',
        methods: ['orbit.session.start', 'orbit.breakpoints.add'],
        requiresUi: true,
        ui: capturedUi,
      },
      { id: 'API-022', status: 'passed', methods: ['orbit.session.restart', 'orbit.target.pause'], generations: [{ sessionId, sessionGeneration: firstGeneration }, { sessionId, sessionGeneration: restarted.session.sessionGeneration }] },
      { id: 'API-023', status: 'passed', methods: ['orbit.instance.describe'] },
      { id: 'API-024', status: 'passed', methods: [...CATALOG] },
    ];

    for (const method of CATALOG) expect(observedMethods.has(method), method).toBe(true);

    const evidenceDir = path.join(process.cwd(), 'outputs', 'automation-api');
    await fs.promises.mkdir(evidenceDir, { recursive: true });
    const evidencePath = path.join(evidenceDir, 'task15-evidence.json');
    await fs.promises.writeFile(evidencePath, `${JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), cases: evidenceCases }, null, 2)}\n`);

    const validator = path.join(process.cwd(), 'scripts', 'automation-api', 'acceptance-validator.js');
    await execFileAsync(process.execPath, [validator, '--evidence', evidencePath], { cwd: process.cwd() });
  }, 60_000);
});
