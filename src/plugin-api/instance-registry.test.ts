// InstanceRegistry: multi-window endpoint discovery, registry pointer, atomic
// heartbeat, stale cleanup and legacy pointer behavior (plan Task 2, §2.1/§2.6).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  BoundServerInfo,
  InstanceRegistry,
  InstanceRegistryOptions,
  RegistryFileSystem,
  computeProjectId,
  defaultRegistryPointerPath,
  detectChannel,
  detectExtensionHost,
  detectProfile,
  nodeRegistryFileSystem,
} from './instance-registry';

// ---------------------------------------------------------------------------
// In-memory file system so symlink/reparse and failure semantics are testable
// on every platform without administrator privileges.
// ---------------------------------------------------------------------------

class MemoryFs implements RegistryFileSystem {
  files = new Map<string, string>();
  dirs = new Set<string>();
  symlinks = new Set<string>();
  writeErrors = new Map<string, string>();
  writtenPaths: string[] = [];

  private notFound(p: string): NodeJS.ErrnoException {
    const error = new Error(`ENOENT: no such file or directory '${p}'`) as NodeJS.ErrnoException;
    error.code = 'ENOENT';
    return error;
  }

  private norm(p: string): string {
    return path.normalize(p);
  }

  async lstat(p: string) {
    const np = this.norm(p);
    if (this.symlinks.has(np)) {
      return { isSymbolicLink: () => true, isDirectory: () => false, isFile: () => false };
    }
    if (this.files.has(np)) {
      return { isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true };
    }
    if (this.dirs.has(np)) {
      return { isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false };
    }
    throw this.notFound(p);
  }

  async mkdir(p: string, options?: { recursive?: boolean }) {
    const np = this.norm(p);
    if (options?.recursive) {
      const stack: string[] = [];
      let current = np;
      for (;;) {
        if (this.dirs.has(current)) break;
        stack.push(current);
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
      }
      for (const dir of stack.reverse()) this.dirs.add(dir);
      return;
    }
    this.dirs.add(np);
  }

  async readFile(p: string) {
    const data = this.files.get(this.norm(p));
    if (data === undefined) throw this.notFound(p);
    return data;
  }

  async writeFile(p: string, data: string) {
    const np = this.norm(p);
    const failure = [...this.writeErrors.entries()].find(([prefix]) => np.startsWith(prefix))?.[1];
    if (failure) {
      const error = new Error(`${failure}: cannot write '${p}'`) as NodeJS.ErrnoException;
      error.code = failure;
      throw error;
    }
    this.writtenPaths.push(np);
    this.files.set(np, data);
  }

  async rename(from: string, to: string) {
    const nf = this.norm(from);
    const nt = this.norm(to);
    const data = this.files.get(nf);
    if (data === undefined) throw this.notFound(from);
    this.files.delete(nf);
    this.files.set(nt, data);
  }

  async unlink(p: string) {
    const np = this.norm(p);
    if (!this.files.delete(np)) throw this.notFound(p);
  }

  async readdir(p: string) {
    const np = this.norm(p);
    const prefix = np.endsWith(path.sep) ? np : np + path.sep;
    const names = new Set<string>();
    for (const file of this.files.keys()) {
      if (!file.startsWith(prefix)) continue;
      const rest = file.slice(prefix.length);
      if (!rest.includes(path.sep)) names.add(rest);
    }
    return [...names];
  }

  async chmod(_p: string, _mode: number) {
    // exercised through the injectable hardener in tests
  }
}

const ROOT = path.join('C:', 'orbit-test');
const ENDPOINT_DIR = path.join(ROOT, 'globalStorage', 'automation-api', 'endpoints');
const POINTER_PATH = path.join(ROOT, 'registry', 'registries.json');
const LEGACY_POINTER = path.join(ROOT, 'globalStorage', 'plugin-api-endpoint.json');

const WORKSPACE = {
  workspaceFileUri: undefined as string | undefined,
  workspaceFilePath: undefined as string | undefined,
  folders: [{ name: 'robot', uri: 'file:///C:/work/robot', path: 'C:\\work\\robot' }],
};

function boundServer(port = 45123): BoundServerInfo {
  return {
    host: '127.0.0.1',
    port,
    rpcUrl: `http://127.0.0.1:${port}/v1/rpc`,
    eventsUrl: `http://127.0.0.1:${port}/v1/events`,
    token: 'test-token-48-bytes',
    processId: 4242,
    startedAt: 1786540000000,
    apiVersions: ['1.0'],
  };
}

interface Harness {
  registry: InstanceRegistry;
  memoryFs: MemoryFs;
  clock: { now: number };
  harden: ReturnType<typeof vi.fn>;
  probe: ReturnType<typeof vi.fn>;
}

function makeRegistry(overrides: Partial<InstanceRegistryOptions> = {}, seedFs?: MemoryFs): Harness {
  const memoryFs = seedFs ?? new MemoryFs();
  const clock = { now: 1786540000000 };
  const harden = vi.fn(async (_p: string, _kind: 'file' | 'directory') => undefined);
  const probe = vi.fn(async (_healthUrl: string, _timeoutMs: number) => ({ ok: false }));
  const registry = new InstanceRegistry({
    endpointDirectory: ENDPOINT_DIR,
    registryPointerPath: POINTER_PATH,
    legacyPointerPath: LEGACY_POINTER,
    identity: { channel: 'stable', profile: '', extensionHost: 'local' },
    extensionVersion: '1.1.0',
    processId: 4242,
    getWorkspace: () => WORKSPACE,
    now: () => clock.now,
    platform: 'win32',
    fs: memoryFs,
    harden,
    probeHealth: probe,
    ...overrides,
  });
  return { registry, memoryFs, clock, harden, probe };
}

function readJson<T>(memoryFs: MemoryFs, file: string): T {
  const raw = memoryFs.files.get(path.normalize(file));
  expect(raw, `expected ${file} to exist`).toBeDefined();
  return JSON.parse(raw!) as T;
}

function endpointFile(harness: Harness, instanceId: string): string {
  return path.join(ENDPOINT_DIR, `${instanceId}.json`);
}

describe('computeProjectId', () => {
  it('hashes a single-root workspace with a sha256 prefix', () => {
    const id = computeProjectId(
      { workspaceFilePath: undefined, folders: [{ name: 'robot', uri: 'file:///C:/work/robot', path: 'C:\\work\\robot' }] },
      'win32',
    );
    expect(id).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('is independent of folder order for multi-root workspaces', () => {
    const foldersA = [
      { name: 'a', uri: 'file:///C:/a', path: 'C:\\a' },
      { name: 'b', uri: 'file:///C:/b', path: 'C:\\b' },
    ];
    const foldersB = [...foldersA].reverse();
    expect(computeProjectId({ folders: foldersA }, 'win32')).toBe(computeProjectId({ folders: foldersB }, 'win32'));
  });

  it('normalizes Windows paths case-insensitively but keeps POSIX case-sensitive', () => {
    const lower = { folders: [{ name: 'robot', uri: 'file:///C:/work/robot', path: 'c:\\work\\robot' }] };
    const upper = { folders: [{ name: 'robot', uri: 'file:///C:/work/robot', path: 'C:\\Work\\Robot' }] };
    expect(computeProjectId(lower, 'win32')).toBe(computeProjectId(upper, 'win32'));
    expect(computeProjectId(lower, 'linux')).not.toBe(computeProjectId(upper, 'linux'));
  });

  it('ignores trailing separators on Windows', () => {
    const plain = { folders: [{ name: 'robot', uri: 'file:///C:/work/robot', path: 'C:\\work\\robot' }] };
    const trailing = { folders: [{ name: 'robot', uri: 'file:///C:/work/robot', path: 'C:\\work\\robot\\' }] };
    expect(computeProjectId(plain, 'win32')).toBe(computeProjectId(trailing, 'win32'));
  });

  it('includes a real .code-workspace file and distinguishes it from folders-only', () => {
    const foldersOnly = { folders: WORKSPACE.folders };
    const withWorkspaceFile = {
      workspaceFilePath: 'C:\\work\\robot\\robot.code-workspace',
      folders: WORKSPACE.folders,
    };
    const otherWorkspaceFile = {
      workspaceFilePath: 'C:\\work\\robot\\other.code-workspace',
      folders: WORKSPACE.folders,
    };
    expect(computeProjectId(foldersOnly, 'win32')).not.toBe(computeProjectId(withWorkspaceFile, 'win32'));
    expect(computeProjectId(withWorkspaceFile, 'win32')).not.toBe(computeProjectId(otherWorkspaceFile, 'win32'));
    expect(computeProjectId(withWorkspaceFile, 'win32')).toBe(
      computeProjectId({ workspaceFilePath: 'c:\\WORK\\ROBOT\\robot.code-workspace', folders: WORKSPACE.folders }, 'win32'),
    );
  });

  it('gives every empty window the same stable id', () => {
    const empty = { folders: [] as { name: string; uri: string; path: string }[] };
    expect(computeProjectId(empty, 'win32')).toBe(computeProjectId(empty, 'win32'));
    expect(computeProjectId(empty, 'win32')).not.toBe(computeProjectId(WORKSPACE, 'win32'));
  });
});

describe('channel and registry pointer helpers', () => {
  it('derives remote before portable before insiders before stable', () => {
    expect(detectChannel({ appName: 'Visual Studio Code', remoteName: 'ssh-remote' })).toBe('remote');
    expect(detectChannel({ appName: 'Visual Studio Code', portableEnv: 'C:\\portable' })).toBe('portable');
    expect(detectChannel({ appName: 'Visual Studio Code - Insiders' })).toBe('insiders');
    expect(detectChannel({ appName: 'Visual Studio Code' })).toBe('stable');
  });

  it('maps remote names to extension host kinds', () => {
    expect(detectExtensionHost(undefined)).toBe('local');
    expect(detectExtensionHost('ssh-remote')).toBe('ssh');
    expect(detectExtensionHost('wsl')).toBe('wsl');
    expect(detectExtensionHost('dev-container')).toBe('container');
    expect(detectExtensionHost('attached-container')).toBe('container');
  });

  it('honors ORBIT_AUTOMATION_REGISTRY above platform defaults', () => {
    expect(defaultRegistryPointerPath({ ORBIT_AUTOMATION_REGISTRY: 'D:\\x\\r.json' }, 'win32')).toBe('D:\\x\\r.json');
    expect(
      defaultRegistryPointerPath({ LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, 'win32'),
    ).toBe(path.join('C:\\Users\\me\\AppData\\Local', 'Orbit', 'automation', 'registries.json'));
    expect(
      defaultRegistryPointerPath({ HOME: '/home/me' }, 'darwin'),
    ).toBe(path.join('/home/me', 'Library', 'Application Support', 'Orbit', 'automation', 'registries.json'));
    expect(
      defaultRegistryPointerPath({ XDG_RUNTIME_DIR: '/run/user/1000' }, 'linux'),
    ).toBe(path.join('/run/user/1000', 'orbit', 'automation', 'registries.json'));
    expect(
      defaultRegistryPointerPath({ HOME: '/home/me' }, 'linux'),
    ).toBe(path.join('/home/me', '.local', 'state', 'orbit', 'automation', 'registries.json'));
  });

  it('derives the profile id from the globalStorage path', () => {
    expect(detectProfile(path.join('C:', 'Users', 'me', 'AppData', 'Roaming', 'Code', 'User', 'globalStorage', 'x'))).toBe('');
    expect(
      detectProfile(path.join('C:', 'Users', 'me', 'AppData', 'Roaming', 'Code', 'User', 'profiles', 'abc123', 'globalStorage', 'x')),
    ).toBe('abc123');
    expect(
      detectProfile(path.join('C:', 'Users', 'me', 'AppData', 'Roaming', 'Code - Insiders', 'User', 'profiles', 'xyz', 'globalStorage', 'x')),
    ).toBe('xyz');
  });
});

describe('InstanceRegistry start/describe', () => {
  afterEach(() => vi.useRealTimers());

  it('writes a random instanceId and stable projectId endpoint atomically', async () => {
    const harness = makeRegistry();
    const description = await harness.registry.start(boundServer());
    expect(description.instanceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(description.endpoint.healthUrl).toBe('http://127.0.0.1:45123/health');

    const content = readJson<Record<string, unknown>>(harness.memoryFs, endpointFile(harness, description.instanceId));
    expect(content.schemaVersion).toBe(1);
    expect(content.projectId).toBe(computeProjectId(WORKSPACE, 'win32'));
    expect(content.instanceId).toBe(description.instanceId);
    expect(content.token).toBe('test-token-48-bytes');
    expect(content.host).toBe('127.0.0.1');
    expect(content.port).toBe(45123);
    expect(content.rpcUrl).toBe('http://127.0.0.1:45123/v1/rpc');
    expect(content.heartbeatAt).toBe(1786540000000);
    expect(content.startedAt).toBe(1786540000000);
    expect(content.processId).toBe(4242);
    expect(content.apiVersions).toEqual(['1.0']);
    expect(content.workspaceFolders).toEqual(['C:\\work\\robot']);
    expect([...harness.memoryFs.files.keys()].filter(p => p.includes('.tmp'))).toEqual([]);
  });

  it('throws when describe() is called before start()', () => {
    const harness = makeRegistry();
    expect(() => harness.registry.describe()).toThrow(/not started/i);
  });

  it('keeps the projectId stable while two windows get distinct instanceIds', async () => {
    const first = makeRegistry();
    const second = makeRegistry();
    const a = await first.registry.start(boundServer(45123));
    const b = await second.registry.start(boundServer(45124));
    expect(a.instanceId).not.toBe(b.instanceId);
    expect(first.registry.getProjectId()).toBe(second.registry.getProjectId());
  });

  it('refreshes the endpoint heartbeat every five seconds and stops after dispose', async () => {
    vi.useFakeTimers();
    const harness = makeRegistry();
    await harness.registry.start(boundServer());
    const instanceId = harness.registry.getInstanceId();
    const writesBefore = harness.memoryFs.writtenPaths.length;

    harness.clock.now += 5000;
    await vi.advanceTimersByTimeAsync(5000);
    const afterBeat = readJson<{ heartbeatAt: number }>(harness.memoryFs, endpointFile(harness, instanceId));
    expect(afterBeat.heartbeatAt).toBe(1786540005000);
    expect(harness.memoryFs.writtenPaths.length).toBeGreaterThan(writesBefore);

    await harness.registry.dispose();
    const writesAtDispose = harness.memoryFs.writtenPaths.length;
    harness.clock.now += 10000;
    await vi.advanceTimersByTimeAsync(10000);
    expect(harness.memoryFs.writtenPaths.length).toBe(writesAtDispose);
    expect(harness.memoryFs.files.has(path.normalize(endpointFile(harness, instanceId)))).toBe(false);
  });

  it('hardens directories and files and fails closed when hardening fails', async () => {
    const harness = makeRegistry();
    await harness.registry.start(boundServer());
    const calls = harness.harden.mock.calls.map(([p, kind]) => [path.normalize(p), kind] as const);
    const directories = calls.filter(([, kind]) => kind === 'directory');
    expect(directories).toEqual(
      expect.arrayContaining([
        [path.normalize(ENDPOINT_DIR), 'directory'],
        [path.normalize(path.dirname(POINTER_PATH)), 'directory'],
      ]),
    );
    // files are hardened while still temp, before the atomic rename makes them visible
    const files = calls.filter(([, kind]) => kind === 'file');
    expect(files.length).toBeGreaterThanOrEqual(2);
    for (const [filePath] of files) expect(filePath).toContain('.tmp');

    const failing = makeRegistry({ harden: vi.fn(async () => Promise.reject(new Error('icacls denied'))) });
    await expect(failing.registry.start(boundServer())).rejects.toThrow(/icacls denied/);
  });

  it('fails startup with a clear ORBIT_AUTOMATION_REGISTRY message when the pointer is unwritable', async () => {
    const memoryFs = new MemoryFs();
    memoryFs.writeErrors.set(path.normalize(POINTER_PATH), 'EACCES');
    const harness = makeRegistry({}, memoryFs);
    await expect(harness.registry.start(boundServer())).rejects.toThrow(/ORBIT_AUTOMATION_REGISTRY/);
  });

  it('rejects symlink/reparse points on the endpoint directory and the pointer', async () => {
    const directory = makeRegistry();
    directory.memoryFs.symlinks.add(path.normalize(ENDPOINT_DIR));
    await expect(directory.registry.start(boundServer())).rejects.toThrow(/symlink\/junction\/reparse/i);

    const pointer = makeRegistry();
    pointer.memoryFs.symlinks.add(path.normalize(POINTER_PATH));
    await expect(pointer.registry.start(boundServer())).rejects.toThrow(/symlink\/junction\/reparse/i);
  });

  it('refuses to write the heartbeat through a symlinked endpoint file', async () => {
    vi.useFakeTimers();
    const memoryFs = new MemoryFs();
    const harness = makeRegistry({}, memoryFs);
    await harness.registry.start(boundServer());
    const instanceId = harness.registry.getInstanceId();
    const endpointPath = path.normalize(endpointFile(harness, instanceId));
    const victim = path.normalize(path.join(ROOT, 'victim.json'));
    memoryFs.files.set(victim, 'VICTIM');
    // Simulate the endpoint file being replaced by a symlink to another file.
    memoryFs.files.delete(endpointPath);
    memoryFs.symlinks.add(endpointPath);
    harness.clock.now += 5000;
    await vi.advanceTimersByTimeAsync(5000);
    expect(memoryFs.files.get(victim)).toBe('VICTIM');
    expect(memoryFs.symlinks.has(endpointPath)).toBe(true);
  });
});

describe('InstanceRegistry registry pointer lifecycle', () => {
  it('upserts only its own entry and preserves other channels', async () => {
    const memoryFs = new MemoryFs();
    memoryFs.files.set(
      path.normalize(POINTER_PATH),
      JSON.stringify({
        schemaVersion: 1,
        registries: [
          { channel: 'stable', profile: '', extensionHost: 'local', endpointDirectory: 'C:\\old', updatedAt: 1 },
          { channel: 'insiders', profile: '', extensionHost: 'local', endpointDirectory: 'C:\\insiders', updatedAt: 2 },
        ],
      }),
    );
    const harness = makeRegistry({}, memoryFs);
    await harness.registry.start(boundServer());

    const pointer = readJson<{ registries: Array<Record<string, unknown>> }>(harness.memoryFs, POINTER_PATH);
    expect(pointer.registries).toHaveLength(2);
    const stable = pointer.registries.find(r => r.channel === 'stable')!;
    expect(stable.endpointDirectory).toBe(ENDPOINT_DIR);
    expect(stable.updatedAt).toBe(1786540000000);
    expect(pointer.registries.find(r => r.channel === 'insiders')?.endpointDirectory).toBe('C:\\insiders');
  });

  it('removes its own entry on dispose and deletes an empty pointer file', async () => {
    const memoryFs = new MemoryFs();
    memoryFs.files.set(
      path.normalize(POINTER_PATH),
      JSON.stringify({
        schemaVersion: 1,
        registries: [{ channel: 'stable', profile: '', extensionHost: 'local', endpointDirectory: 'C:\\old', updatedAt: 1 }],
      }),
    );
    const harness = makeRegistry({}, memoryFs);
    await harness.registry.start(boundServer());
    await harness.registry.dispose();
    expect(memoryFs.files.has(path.normalize(POINTER_PATH))).toBe(false);
    expect(memoryFs.files.has(path.normalize(endpointFile(harness, harness.registry.getInstanceId())))).toBe(false);
  });

  it('keeps other entries when its own entry is removed on dispose', async () => {
    const memoryFs = new MemoryFs();
    memoryFs.files.set(
      path.normalize(POINTER_PATH),
      JSON.stringify({
        schemaVersion: 1,
        registries: [
          { channel: 'stable', profile: '', extensionHost: 'local', endpointDirectory: 'C:\\old', updatedAt: 1 },
          { channel: 'insiders', profile: '', extensionHost: 'local', endpointDirectory: 'C:\\insiders', updatedAt: 2 },
        ],
      }),
    );
    const harness = makeRegistry({}, memoryFs);
    await harness.registry.start(boundServer());
    await harness.registry.dispose();
    const pointer = readJson<{ registries: Array<{ channel: string }> }>(harness.memoryFs, POINTER_PATH);
    expect(pointer.registries).toEqual([{ channel: 'insiders', profile: '', extensionHost: 'local', endpointDirectory: 'C:\\insiders', updatedAt: 2 }]);
  });

  it('rejects a registry pointer whose schema cannot be trusted', async () => {
    const memoryFs = new MemoryFs();
    memoryFs.files.set(path.normalize(POINTER_PATH), JSON.stringify({ schemaVersion: 2, registries: [] }));
    const harness = makeRegistry({}, memoryFs);
    await expect(harness.registry.start(boundServer())).rejects.toThrow(/registry pointer/i);
  });
});

describe('InstanceRegistry stale cleanup', () => {
  it('deletes only endpoints that fail health with a stale heartbeat', async () => {
    const memoryFs = new MemoryFs();
    const now = 1786540000000;
    const stale = now - 60_000;
    const fresh = now - 2_000;
    const seed = (id: string, heartbeatAt: number) => ({
      schemaVersion: 1,
      instanceId: id,
      projectId: 'sha256:seed',
      channel: 'stable',
      profile: '',
      extensionHost: 'local',
      workspaceFolders: [],
      host: '127.0.0.1',
      port: 46000,
      rpcUrl: `http://127.0.0.1:46000/v1/rpc`,
      eventsUrl: `http://127.0.0.1:46000/v1/events`,
      healthUrl: `http://127.0.0.1:46000/health`,
      token: '',
      processId: 1,
      startedAt: stale,
      heartbeatAt,
      apiVersions: ['1.0'],
    });
    memoryFs.files.set(path.join(ENDPOINT_DIR, 'fresh.json'), JSON.stringify(seed('fresh', fresh)));
    memoryFs.files.set(path.join(ENDPOINT_DIR, 'healthy.json'), JSON.stringify(seed('healthy', stale)));
    memoryFs.files.set(path.join(ENDPOINT_DIR, 'reused.json'), JSON.stringify(seed('reused', stale)));
    memoryFs.files.set(path.join(ENDPOINT_DIR, 'dead.json'), JSON.stringify(seed('dead', stale)));
    memoryFs.files.set(path.join(ENDPOINT_DIR, 'garbage.json'), '{not json');

    const probe = vi.fn(async (_healthUrl: string) => ({ ok: false }));
    // `dead` must fail health: give the dead seed its own port.
    const deadContent = JSON.parse(memoryFs.files.get(path.normalize(path.join(ENDPOINT_DIR, 'dead.json')))!) as { port: number; healthUrl: string; rpcUrl: string; eventsUrl: string };
    deadContent.port = 46001;
    deadContent.healthUrl = 'http://127.0.0.1:46001/health';
    deadContent.rpcUrl = 'http://127.0.0.1:46001/v1/rpc';
    deadContent.eventsUrl = 'http://127.0.0.1:46001/v1/events';
    memoryFs.files.set(path.normalize(path.join(ENDPOINT_DIR, 'dead.json')), JSON.stringify(deadContent));
    probe.mockImplementation(async (healthUrl: string) => {
      if (healthUrl.includes('46001')) return { ok: false };
      return { ok: true, instanceId: 'healthy' };
    });

    const harness = makeRegistry({ probeHealth: probe }, memoryFs);
    await harness.registry.start(boundServer());
    const names = await memoryFs.readdir(ENDPOINT_DIR);
    expect(names).not.toContain('dead.json');
    expect(names).toContain('fresh.json');
    expect(names).toContain('healthy.json');
    expect(names).toContain('reused.json');
    expect(names).toContain('garbage.json');
    // the live instance never deletes its own endpoint
    expect(names).toContain(`${harness.registry.getInstanceId()}.json`);
  });
});

describe('InstanceRegistry legacy pointer compatibility', () => {
  it('marks unique when it is the only live endpoint and ambiguous with several', async () => {
    vi.useFakeTimers();
    const harness = makeRegistry();
    await harness.registry.start(boundServer());

    const unique = readJson<Record<string, unknown>>(harness.memoryFs, LEGACY_POINTER);
    expect(unique.status).toBe('unique');
    expect(unique.instanceId).toBe(harness.registry.getInstanceId());
    expect(unique.token).toBe('test-token-48-bytes');
    expect(unique.url).toBe('http://127.0.0.1:45123/v1/rpc');
    expect(unique.rpcUrl).toBe('http://127.0.0.1:45123/v1/rpc');
    expect(unique.eventsUrl).toBe('http://127.0.0.1:45123/v1/events');
    expect(unique.healthUrl).toBe('http://127.0.0.1:45123/health');
    expect(unique.schemaVersion).toBe(1);

    // a second window (same shared globalStorage) becomes live
    const other = {
      schemaVersion: 1,
      instanceId: 'bbbbbbbb-1111-2222-3333-444444444444',
      projectId: 'sha256:other',
      channel: 'stable',
      profile: '',
      extensionHost: 'local',
      workspaceFolders: [],
      host: '127.0.0.1',
      port: 45124,
      rpcUrl: 'http://127.0.0.1:45124/v1/rpc',
      eventsUrl: 'http://127.0.0.1:45124/v1/events',
      healthUrl: 'http://127.0.0.1:45124/health',
      token: 'other-token',
      processId: 2,
      startedAt: 1786540000000,
      heartbeatAt: 1786540000000,
      apiVersions: ['1.0'],
    };
    harness.memoryFs.files.set(path.join(ENDPOINT_DIR, 'bbbbbbbb-1111-2222-3333-444444444444.json'), JSON.stringify(other));
    harness.clock.now += 5000;
    await vi.advanceTimersByTimeAsync(5000);

    const ambiguous = readJson<Record<string, unknown>>(harness.memoryFs, LEGACY_POINTER);
    expect(ambiguous.status).toBe('ambiguous');
    expect(ambiguous.token).toBeUndefined();
    expect(ambiguous.instances).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ instanceId: harness.registry.getInstanceId(), projectId: computeProjectId(WORKSPACE, 'win32') }),
        expect.objectContaining({ instanceId: 'bbbbbbbb-1111-2222-3333-444444444444', projectId: 'sha256:other' }),
      ]),
    );

    // the other window closes again
    harness.memoryFs.files.delete(path.join(ENDPOINT_DIR, 'bbbbbbbb-1111-2222-3333-444444444444.json'));
    harness.clock.now += 5000;
    await vi.advanceTimersByTimeAsync(5000);
    expect(readJson<{ status: string }>(harness.memoryFs, LEGACY_POINTER).status).toBe('unique');
  });

  it('lets the surviving window take over a unique pointer after dispose', async () => {
    const memoryFs = new MemoryFs();
    memoryFs.files.set(
      path.join(ENDPOINT_DIR, 'bbbbbbbb-1111-2222-3333-444444444444.json'),
      JSON.stringify({
        schemaVersion: 1,
        instanceId: 'bbbbbbbb-1111-2222-3333-444444444444',
        projectId: 'sha256:other',
        channel: 'stable',
        profile: '',
        extensionHost: 'local',
        workspaceFolders: [],
        host: '127.0.0.1',
        port: 45124,
        rpcUrl: 'http://127.0.0.1:45124/v1/rpc',
        eventsUrl: 'http://127.0.0.1:45124/v1/events',
        healthUrl: 'http://127.0.0.1:45124/health',
        token: 'other-token',
        processId: 2,
        startedAt: 1786540000000,
        heartbeatAt: 1786540000000,
        apiVersions: ['1.0'],
      }),
    );
    const harness = makeRegistry({}, memoryFs);
    await harness.registry.start(boundServer());
    await harness.registry.dispose();

    const pointer = readJson<Record<string, unknown>>(harness.memoryFs, LEGACY_POINTER);
    expect(pointer.status).toBe('unique');
    expect(pointer.instanceId).toBe('bbbbbbbb-1111-2222-3333-444444444444');
    expect(pointer.token).toBe('other-token');
    expect(memoryFs.files.has(path.normalize(endpointFile(harness, harness.registry.getInstanceId())))).toBe(false);
  });

  it('removes the legacy pointer when no live endpoint remains', async () => {
    const harness = makeRegistry();
    await harness.registry.start(boundServer());
    await harness.registry.dispose();
    expect(harness.memoryFs.files.has(path.normalize(LEGACY_POINTER))).toBe(false);
  });
});

describe('InstanceRegistry real filesystem behavior', () => {
  let tempRoot: string;
  let junctionSupported = false;

  beforeEach(async () => {
    tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'orbit-registry-test-'));
    const realDir = path.join(tempRoot, 'real-dir');
    const link = path.join(tempRoot, 'linked-dir');
    try {
      await fs.promises.mkdir(realDir);
      await fs.promises.symlink(realDir, link, 'junction');
      junctionSupported = true;
    } catch {
      junctionSupported = false;
    }
  });

  afterEach(async () => {
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  });

  function realRegistry(): InstanceRegistry {
    const endpointDirectory = path.join(tempRoot, 'globalStorage', 'automation-api', 'endpoints');
    const registryPointerPath = path.join(tempRoot, 'registry', 'registries.json');
    return new InstanceRegistry({
      endpointDirectory,
      registryPointerPath,
      legacyPointerPath: path.join(tempRoot, 'globalStorage', 'plugin-api-endpoint.json'),
      identity: { channel: 'stable', profile: '', extensionHost: 'local' },
      extensionVersion: '1.1.0',
      processId: 123,
      getWorkspace: () => WORKSPACE,
      platform: 'win32',
      fs: nodeRegistryFileSystem,
      probeHealth: async () => ({ ok: false }),
      harden: async () => undefined,
    });
  }

  it('writes the endpoint atomically without temp residue and cleans up on dispose', async () => {
    const registry = realRegistry();
    await registry.start(boundServer(45200));
    const endpointDirectory = path.join(tempRoot, 'globalStorage', 'automation-api', 'endpoints');
    const files = await fs.promises.readdir(endpointDirectory);
    expect(files).toEqual([`${registry.getInstanceId()}.json`]);
    const content = JSON.parse(await fs.promises.readFile(path.join(endpointDirectory, files[0]), 'utf8'));
    expect(content.instanceId).toBe(registry.getInstanceId());
    await registry.dispose();
    expect(await fs.promises.readdir(endpointDirectory)).toEqual([]);
  });

  it.skipIf(!junctionSupported)('rejects a symlinked endpoint directory on the real filesystem', async () => {
    const realDir = path.join(tempRoot, 'real-endpoints');
    await fs.promises.mkdir(realDir, { recursive: true });
    const endpointDirectory = path.join(tempRoot, 'globalStorage', 'automation-api', 'endpoints');
    await fs.promises.mkdir(path.dirname(endpointDirectory), { recursive: true });
    await fs.promises.symlink(realDir, endpointDirectory, 'junction');
    await expect(realRegistry().start(boundServer(45201))).rejects.toThrow(/symlink\/junction\/reparse/i);
    expect(await fs.promises.readdir(realDir)).toEqual([]);
  });
});
