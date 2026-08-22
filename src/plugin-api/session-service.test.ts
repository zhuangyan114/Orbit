// SessionService: visible VS Code session start/stop, launch configuration
// discovery and the ProjectMutationContext fences (plan Task 4).
import * as vscode from 'vscode';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomationError, ProjectMutationContext } from './protocol';
import { SessionRegistry } from './session-registry';
import { SessionService, SessionServiceOptions } from './session-service';

const vscodeState = vi.hoisted(() => ({
  startDebuggingCalls: [] as Array<{ folder: unknown; config: Record<string, unknown>; options: unknown }>,
  stopDebuggingCalls: [] as unknown[],
  workspaceFolders: undefined as unknown[] | undefined,
  launchConfigs: [] as Array<Record<string, unknown>>,
}));

vi.mock('vscode', () => ({
  debug: {
    startDebugging: (folder: unknown, config: unknown, options?: unknown) => {
      vscodeState.startDebuggingCalls.push({ folder, config: config as Record<string, unknown>, options });
      return Promise.resolve(true);
    },
    stopDebugging: (session: unknown) => {
      vscodeState.stopDebuggingCalls.push(session);
      return Promise.resolve();
    },
  },
  workspace: {
    get workspaceFolders() {
      return vscodeState.workspaceFolders;
    },
    getConfiguration: () => ({
      get: (key: string, fallback: unknown) => (key === 'configurations' ? vscodeState.launchConfigs : fallback),
    }),
  },
}));

interface TestContext {
  service: SessionService;
  registry: SessionRegistry;
  advance: (ms: number) => void;
  stoppedSessions: vscode.DebugSession[];
  startResult: boolean;
  resolveCalls: Array<{ folder: unknown; config: vscode.DebugConfiguration }>;
}

function makeService(overrides: Partial<SessionServiceOptions> = {}): TestContext {
  let clockValue = 0;
  const registry = new SessionRegistry();
  const stoppedSessions: vscode.DebugSession[] = [];
  const resolveCalls: Array<{ folder: unknown; config: vscode.DebugConfiguration }> = [];
  const state = { startResult: true };
  const service = new SessionService({
    registry,
    startDebugging: vi.fn(async () => state.startResult),
    stopDebugging: vi.fn(async session => {
      stoppedSessions.push(session);
    }),
    workspaceFolders: () => vscodeState.workspaceFolders as vscode.WorkspaceFolder[] | undefined,
    launchConfigurations: () => vscodeState.launchConfigs as vscode.DebugConfiguration[],
    resolveLaunchConfiguration: vi.fn(async (folder, config) => {
      resolveCalls.push({ folder, config });
      return config;
    }),
    fileExists: filePath => overrides.fileExists?.(filePath) ?? filePath === 'C:\\ws\\build\\app.elf',
    sleep: async ms => {
      clockValue += ms;
    },
    now: () => clockValue,
    ...overrides,
  });
  return {
    service,
    registry,
    advance: ms => {
      clockValue += ms;
    },
    stoppedSessions,
    get startResult() {
      return state.startResult;
    },
    set startResult(value: boolean) {
      state.startResult = value;
    },
    resolveCalls,
  };
}

function fakeSession(id: string, type = 'orbit', name = 'Orbit Debug'): vscode.DebugSession {
  return { id, type, name } as unknown as vscode.DebugSession;
}

function context(generation: number): ProjectMutationContext {
  return {
    instanceId: 'inst-1',
    projectId: 'sha256:project-1',
    connectionId: 'conn-1',
    idempotencyKey: 'start-1',
    registryGeneration: generation,
  };
}

function catchError(fn: () => unknown): AutomationError {
  try {
    fn();
  } catch (error) {
    return error as AutomationError;
  }
  throw new Error('expected the call to throw');
}

async function catchAsyncError(promise: Promise<unknown>): Promise<AutomationError> {
  try {
    await promise;
  } catch (error) {
    return error as AutomationError;
  }
  throw new Error('expected the promise to reject');
}

beforeEach(() => {
  vscodeState.startDebuggingCalls = [];
  vscodeState.stopDebuggingCalls = [];
  vscodeState.workspaceFolders = undefined;
  vscodeState.launchConfigs = [];
});

describe('SessionService.start', () => {
  it('starts a named launch configuration through vscode.debug.startDebugging', async () => {
    const ctx = makeService();
    vscodeState.launchConfigs = [
      { name: 'Orbit Launch', type: 'orbit', request: 'launch', program: 'C:\\ws\\build\\app.elf' },
      { name: 'Node App', type: 'node', request: 'launch', program: '${workspaceFolder}/app.js' },
    ];
    vscodeState.workspaceFolders = [{ uri: { toString: () => 'file:///ws' }, fsPath: 'C:\\ws', name: 'ws' }];

    // Simulate the extension host wiring: the start event registers the session.
    const session = fakeSession('session-1', 'orbit', 'Orbit Launch');
    const promise = ctx.service.start(
      { context: context(0), configurationId: 'Orbit Launch', timeoutMs: 500 },
      'op-1',
    );
    ctx.registry.onStarted(session);
    const ack = await promise;

    expect(ack).toEqual({
      operationId: 'op-1',
      accepted: true,
      session: expect.objectContaining({ sessionId: 'session-1', sessionGeneration: 1, phase: 'starting' }),
    });
    expect(ctx.resolveCalls).toHaveLength(1);
    expect(ctx.resolveCalls[0].config).toMatchObject({ name: 'Orbit Launch', type: 'orbit' });
  });

  it('calls the real vscode.debug.startDebugging seam with the normalized config and noDebug', async () => {
    const ctx = makeService({
      startDebugging: undefined, // fall back to the module default (mocked vscode)
    });
    const session = fakeSession('session-2', 'orbit', 'Inline');
    const promise = ctx.service.start(
      {
        context: context(0),
        configurationId: 'unused',
        configuration: { name: 'Inline', type: 'ozone', request: 'launch', program: 'C:\\ws\\build\\app.elf' },
        noDebug: true,
        timeoutMs: 500,
      },
      'op-2',
    );
    ctx.registry.onStarted(session);
    const ack = await promise;

    expect(ack.accepted).toBe(true);
    expect(vscodeState.startDebuggingCalls).toHaveLength(1);
    const call = vscodeState.startDebuggingCalls[0];
    expect(call.config).toMatchObject({ name: 'Inline', type: 'ozone' });
    expect(call.options).toEqual({ noDebug: true });
  });

  it('applies the configurationName display override before starting', async () => {
    const ctx = makeService();
    vscodeState.launchConfigs = [
      { name: 'Orbit Launch', type: 'orbit', request: 'launch', program: 'C:\\ws\\build\\app.elf' },
    ];
    const session = fakeSession('session-3', 'orbit', 'Trial 17');
    const promise = ctx.service.start(
      { context: context(0), configurationId: 'Orbit Launch', configurationName: 'Trial 17', timeoutMs: 500 },
      'op-3',
    );
    ctx.registry.onStarted(session);
    await promise;

    expect(ctx.resolveCalls[0].config).toMatchObject({ name: 'Trial 17', type: 'orbit' });
  });

  it('rejects a duplicate start with SessionAlreadyActive and the current snapshot', async () => {
    const ctx = makeService();
    const session = fakeSession('session-1');
    ctx.registry.onStarted(session);
    ctx.registry.update(session, { phase: 'halted', targetState: 'halted' });

    const error = await catchAsyncError(
      ctx.service.start({ context: context(1), configurationId: 'Orbit Launch' }, 'op-dup'),
    );
    expect(error.errorCode).toBe('SessionAlreadyActive');
    expect(error.data).toEqual({ current: expect.objectContaining({ sessionId: 'session-1', sessionGeneration: 1 }) });
    expect(ctx.registry.registryGeneration).toBe(1); // no transition
  });

  it('fences a stale ProjectMutationContext registry generation', async () => {
    const ctx = makeService();
    const error = await catchAsyncError(
      ctx.service.start({ context: context(7), configurationId: 'Orbit Launch' }, 'op-stale'),
    );
    expect(error.errorCode).toBe('InvalidRequest');
    expect(error.details).toEqual({ expectedGeneration: 7, actualGeneration: 0 });
  });

  it('rejects an unknown configuration name', async () => {
    const ctx = makeService();
    vscodeState.launchConfigs = [
      { name: 'Orbit Launch', type: 'orbit', request: 'launch', program: 'C:\\ws\\build\\app.elf' },
    ];
    const error = await catchAsyncError(
      ctx.service.start({ context: context(0), configurationId: 'Missing' }, 'op-x'),
    );
    expect(error.errorCode).toBe('InvalidRequest');
    expect(error.details).toEqual({ configurationId: 'Missing' });
  });

  it('rejects an ambiguous configuration name across workspace folders', async () => {
    const ctx = makeService();
    vscodeState.launchConfigs = [
      { name: 'Orbit Launch', type: 'orbit', request: 'launch', program: 'C:\\ws1\\build\\app.elf' },
      { name: 'Orbit Launch', type: 'orbit', request: 'launch', program: 'C:\\ws2\\build\\app.elf' },
    ];
    vscodeState.workspaceFolders = [
      { uri: { toString: () => 'file:///ws1' }, fsPath: 'C:\\ws1', name: 'ws1' },
      { uri: { toString: () => 'file:///ws2' }, fsPath: 'C:\\ws2', name: 'ws2' },
    ];
    const error = await catchAsyncError(
      ctx.service.start({ context: context(0), configurationId: 'Orbit Launch' }, 'op-amb'),
    );
    expect(error.errorCode).toBe('InvalidRequest');
  });

  it('rejects a launch configuration with a non-Orbit type', async () => {
    const ctx = makeService();
    vscodeState.launchConfigs = [
      { name: 'Node App', type: 'node', request: 'launch', program: 'app.js' },
    ];
    const error = await catchAsyncError(
      ctx.service.start({ context: context(0), configurationId: 'Node App' }, 'op-type'),
    );
    expect(error.errorCode).toBe('InvalidRequest');
  });

  it('rejects an inline configuration with a non-Orbit type', async () => {
    const ctx = makeService();
    const error = await catchAsyncError(
      ctx.service.start(
        {
          context: context(0),
          configurationId: 'inline',
          configuration: { name: 'X', type: 'node', request: 'launch' },
        },
        'op-inline',
      ),
    );
    expect(error.errorCode).toBe('InvalidRequest');
  });

  it('rejects a configuration without an ELF program', async () => {
    const ctx = makeService();
    vscodeState.launchConfigs = [{ name: 'NoElf', type: 'orbit', request: 'launch' }];
    const error = await catchAsyncError(
      ctx.service.start({ context: context(0), configurationId: 'NoElf' }, 'op-noelf'),
    );
    expect(error.errorCode).toBe('CapabilityUnavailable');
  });

  it('rejects a configuration whose ELF program does not exist', async () => {
    const ctx = makeService({ fileExists: () => false });
    vscodeState.launchConfigs = [
      { name: 'MissingElf', type: 'orbit', request: 'launch', program: 'C:\\ws\\build\\missing.elf' },
    ];
    const error = await catchAsyncError(
      ctx.service.start({ context: context(0), configurationId: 'MissingElf' }, 'op-missing'),
    );
    expect(error.errorCode).toBe('CapabilityUnavailable');
    expect(error.details).toMatchObject({ capability: 'program' });
  });

  it('skips the existence check for unresolvable program variables', async () => {
    const ctx = makeService({ fileExists: () => false });
    vscodeState.launchConfigs = [
      { name: 'EnvElf', type: 'orbit', request: 'launch', program: '${env:BUILD_DIR}/app.elf' },
    ];
    const session = fakeSession('session-env', 'orbit', 'EnvElf');
    const promise = ctx.service.start(
      { context: context(0), configurationId: 'EnvElf', timeoutMs: 500 },
      'op-env',
    );
    ctx.registry.onStarted(session);
    const ack = await promise;
    expect(ack.accepted).toBe(true);
  });

  it('maps startDebugging=false to CapabilityUnavailable', async () => {
    const ctx = makeService();
    ctx.startResult = false;
    vscodeState.launchConfigs = [
      { name: 'Orbit Launch', type: 'orbit', request: 'launch', program: 'C:\\ws\\build\\app.elf' },
    ];
    const error = await catchAsyncError(
      ctx.service.start({ context: context(0), configurationId: 'Orbit Launch' }, 'op-false'),
    );
    expect(error.errorCode).toBe('CapabilityUnavailable');
  });

  it('maps a startDebugging rejection to CapabilityUnavailable', async () => {
    const ctx = makeService({
      startDebugging: vi.fn(async () => {
        throw new Error('configuration provider refused');
      }),
    });
    vscodeState.launchConfigs = [
      { name: 'Orbit Launch', type: 'orbit', request: 'launch', program: 'C:\\ws\\build\\app.elf' },
    ];
    const error = await catchAsyncError(
      ctx.service.start({ context: context(0), configurationId: 'Orbit Launch' }, 'op-throw'),
    );
    expect(error.errorCode).toBe('CapabilityUnavailable');
    expect(error.details).toMatchObject({ reason: 'configuration provider refused' });
  });

  it('times out with outcomeUnknown when the start event never arrives', async () => {
    const ctx = makeService();
    vscodeState.launchConfigs = [
      { name: 'Orbit Launch', type: 'orbit', request: 'launch', program: 'C:\\ws\\build\\app.elf' },
    ];
    const error = await catchAsyncError(
      ctx.service.start({ context: context(0), configurationId: 'Orbit Launch', timeoutMs: 300 }, 'op-tmo'),
    );
    expect(error.errorCode).toBe('RequestTimeout');
    expect(error.data).toEqual({ timeoutKind: 'outcomeUnknown', operationId: 'op-tmo' });
    expect(ctx.registry.currentSnapshot()).toBeUndefined();
  });

  it('ignores a pre-existing session when identifying the newly started one', async () => {
    const ctx = makeService();
    vscodeState.launchConfigs = [
      { name: 'Orbit Launch', type: 'orbit', request: 'launch', program: 'C:\\ws\\build\\app.elf' },
    ];
    // A terminated session already sits in the history; the new start must not
    // be mistaken for it.
    const old = fakeSession('old-1');
    ctx.registry.onStarted(old);
    ctx.registry.onTerminated(old);

    const fresh = fakeSession('fresh-1', 'orbit', 'Orbit Launch');
    const promise = ctx.service.start(
      { context: context(2), configurationId: 'Orbit Launch', timeoutMs: 500 },
      'op-fresh',
    );
    ctx.registry.onStarted(fresh);
    const ack = await promise;
    expect(ack.session).toMatchObject({ sessionId: 'fresh-1', sessionGeneration: 3 });
  });

  it('never attributes a concurrent manually started session to this call', async () => {
    const ctx = makeService();
    vscodeState.launchConfigs = [
      { name: 'Orbit Launch', type: 'orbit', request: 'launch', program: 'C:\\ws\\build\\app.elf' },
    ];
    const promise = ctx.service.start(
      { context: context(0), configurationId: 'Orbit Launch', timeoutMs: 300 },
      'op-race',
    );
    // Registered during the in-flight awaits (after the pre-existing capture):
    // its displayed name differs from the started configuration, so the wait
    // must keep polling instead of adopting it.
    ctx.registry.onStarted(fakeSession('manual-1', 'orbit', 'Manual Debug'));
    const error = await catchAsyncError(promise);
    expect(error.errorCode).toBe('RequestTimeout');
    expect(error.data).toEqual({ timeoutKind: 'outcomeUnknown', operationId: 'op-race' });
  });

  it('requires a non-empty operationId', async () => {
    const ctx = makeService();
    const error = await catchAsyncError(
      ctx.service.start({ context: context(0), configurationId: 'Orbit Launch' }, undefined),
    );
    expect(error.errorCode).toBe('InternalError');
  });
});

describe('SessionService.stop', () => {
  it('stops the exact registered session object', async () => {
    const ctx = makeService();
    const session = fakeSession('session-1');
    ctx.registry.onStarted(session);
    ctx.registry.update(session, { phase: 'halted', targetState: 'halted' });

    const ack = await ctx.service.stop({ sessionId: 'session-1', sessionGeneration: 1 }, 'op-stop');
    expect(ack).toEqual({
      operationId: 'op-stop',
      accepted: true,
      session: expect.objectContaining({ sessionId: 'session-1', phase: 'halted' }),
    });
    expect(ctx.stoppedSessions).toEqual([session]);
    expect(ctx.stoppedSessions[0]).toBe(session); // exact object identity
  });

  it('rejects an unknown session with NoActiveSession', async () => {
    const ctx = makeService();
    const error = await catchAsyncError(
      ctx.service.stop({ sessionId: 'ghost', sessionGeneration: 1 }, 'op-ghost'),
    );
    expect(error.errorCode).toBe('NoActiveSession');
    expect(ctx.stoppedSessions).toEqual([]);
  });

  it('rejects a stale generation with SessionChanged without stopping anything', async () => {
    const ctx = makeService();
    const session = fakeSession('session-1');
    ctx.registry.onStarted(session);
    ctx.registry.onRestarted(session); // generation now 2

    const error = await catchAsyncError(
      ctx.service.stop({ sessionId: 'session-1', sessionGeneration: 1 }, 'op-stale'),
    );
    expect(error.errorCode).toBe('SessionChanged');
    expect(error.data).toEqual({ expectedGeneration: 1, actualGeneration: 2 });
    expect(ctx.stoppedSessions).toEqual([]);
  });

  it('rejects a terminating session with SessionTerminating', async () => {
    const ctx = makeService();
    const session = fakeSession('session-1');
    ctx.registry.onStarted(session);
    ctx.registry.markOwnerLost(session);

    const error = await catchAsyncError(
      ctx.service.stop({ sessionId: 'session-1', sessionGeneration: 1 }, 'op-term'),
    );
    expect(error.errorCode).toBe('SessionTerminating');
  });
});

describe('SessionService.list / snapshot', () => {
  it('lists the active session and, when requested, terminated history with cursors', () => {
    const ctx = makeService();
    const s1 = fakeSession('s1');
    const s2 = fakeSession('s2');
    ctx.registry.onStarted(s1);
    ctx.registry.onTerminated(s1);
    ctx.registry.onStarted(s2);

    expect(ctx.service.list()).toEqual({
      items: [expect.objectContaining({ sessionId: 's2' })],
    });
    expect(ctx.service.list({ includeTerminated: true }).items.map(item => item.sessionId))
      .toEqual(['s2', 's1']);

    const page = ctx.service.list({ includeTerminated: true, limit: 1 });
    expect(page.items.map(item => item.sessionId)).toEqual(['s2']);
    expect(page.nextCursor).toBe('s2');
    expect(ctx.service.list({ includeTerminated: true, limit: 1, cursor: 's2' }).items.map(item => item.sessionId))
      .toEqual(['s1']);
  });

  it('rejects an unknown list cursor', () => {
    const ctx = makeService();
    expect(() => ctx.service.list({ cursor: 'nope' })).toThrowError(/unknown cursor/);
  });

  it('snapshots an active session and honors includeCapabilities', () => {
    const ctx = makeService();
    const session = fakeSession('s1');
    ctx.registry.onStarted(session);
    ctx.registry.update(session, {
      phase: 'halted',
      targetState: 'halted',
      capabilities: [{ name: 'flash', available: true }],
    });

    expect(ctx.service.snapshot('s1')).toMatchObject({
      sessionId: 's1',
      phase: 'halted',
      capabilities: [{ name: 'flash', available: true }],
    });
    expect(ctx.service.snapshot('s1', false).capabilities).toEqual([]);
  });

  it('snapshots a terminating session but not an unknown or terminated one', () => {
    const ctx = makeService();
    const session = fakeSession('s1');
    ctx.registry.onStarted(session);
    ctx.registry.markOwnerLost(session);
    expect(ctx.service.snapshot('s1')).toMatchObject({ phase: 'terminating' });

    ctx.registry.onTerminated(session);
    expect(catchError(() => ctx.service.snapshot('s1')).errorCode).toBe('NoActiveSession');
    expect(catchError(() => ctx.service.snapshot('ghost')).errorCode).toBe('NoActiveSession');
  });
});

describe('SessionService.listLaunchConfigurations', () => {
  it('lists orbit/ozone configurations and honors includeLegacyAlias and paging', () => {
    const ctx = makeService();
    vscodeState.launchConfigs = [
      { name: 'Orbit', type: 'orbit', request: 'launch' },
      { name: 'Legacy', type: 'ozone', request: 'launch' },
      { name: 'Attach', type: 'orbit', request: 'attach' },
      { name: 'Node', type: 'node', request: 'launch' },
    ];
    vscodeState.workspaceFolders = [{ uri: { toString: () => 'file:///ws' }, fsPath: 'C:\\ws', name: 'ws' }];

    expect(ctx.service.listLaunchConfigurations()).toEqual([
      { name: 'Orbit', type: 'orbit', request: 'launch', workspaceFolderUri: 'file:///ws' },
      { name: 'Legacy', type: 'ozone', request: 'launch', workspaceFolderUri: 'file:///ws' },
      { name: 'Attach', type: 'orbit', request: 'attach', workspaceFolderUri: 'file:///ws' },
    ]);
    expect(ctx.service.listLaunchConfigurations(false).map(item => item.type)).toEqual(['orbit', 'orbit']);

    const page = ctx.service.listLaunchConfigurationsPage({ limit: 2 });
    expect(page.items.map(item => item.name)).toEqual(['Orbit', 'Legacy']);
    expect(page.nextCursor).toBe('file:///ws\u0000Legacy');
    expect(
      ctx.service.listLaunchConfigurationsPage({ cursor: 'file:///ws\u0000Legacy', limit: 2 }).items.map(item => item.name),
    ).toEqual(['Attach']);
  });

  it('rejects an invalid page cursor', () => {
    const ctx = makeService();
    expect(() => ctx.service.listLaunchConfigurationsPage({ cursor: 'abc' })).toThrowError(/unknown cursor/);
    expect(() => ctx.service.listLaunchConfigurationsPage({ cursor: '99' })).toThrowError(/unknown cursor/);
  });
});
