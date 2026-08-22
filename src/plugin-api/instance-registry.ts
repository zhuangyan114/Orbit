// Orbit Automation API v1 — multi-window instance discovery (plan Task 2).
//
// One InstanceRegistry lives per Extension Host window. It owns:
//   * the random `instanceId` and the stable `projectId` (§2.1),
//   * the atomic endpoint file `<globalStorage>/automation-api/endpoints/<instanceId>.json`
//     with a five-second atomic heartbeat,
//   * the per-user registry pointer upsert (§2.6) with env override, ACL/mode
//     hardening and symlink/junction/reparse rejection,
//   * startup stale-endpoint cleanup (health failure + heartbeat > 30 s), and
//   * the legacy `plugin-api-endpoint.json` pointer that only marks `unique` or
//     `ambiguous` and never silently selects a window (§2.6 / Task 2).
//
// This module deliberately imports neither `vscode` nor the plugin API legacy
// envelope so it stays unit-testable; the Extension Host adapts workspace,
// channel and launch configuration data through the injected callbacks.
import { createHash, randomUUID } from 'crypto';
import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as http from 'http';
import * as path from 'path';
import { Capability, CapabilitySnapshot, InstanceDescription, LaunchConfigurationSummary, ProjectDescription, WorkspaceFolderInfo } from './protocol';
import { LegacyEndpointPointer } from './types';

// --- Public shapes ---------------------------------------------------------

export type RegistryChannel = 'stable' | 'insiders' | 'portable' | 'remote';
export type ExtensionHostKind = 'local' | 'ssh' | 'wsl' | 'container';

/** Identity of one registry pointer entry (§2.6); profile is part of identity, never of projectId. */
export interface RegistryIdentity {
  channel: RegistryChannel;
  profile: string;
  extensionHost: ExtensionHostKind;
}

export interface RegistryPointerEntry extends RegistryIdentity {
  endpointDirectory: string;
  updatedAt: number;
}

export interface RegistryPointerFile {
  schemaVersion: 1;
  registries: RegistryPointerEntry[];
}

/** What the already-listening HTTP server hands to the registry at start. */
export interface BoundServerInfo {
  host: '127.0.0.1';
  port: number;
  rpcUrl: string;
  eventsUrl: string;
  token: string;
  processId: number;
  startedAt: number;
  apiVersions: string[];
}

/** Workspace view used for projectId hashing and project description. */
export interface WorkspaceSnapshot {
  /** file: URI of the workspace file, only when it is a real `.code-workspace` file. */
  workspaceFileUri?: string;
  /** Absolute filesystem path of that file (the hash input). */
  workspaceFilePath?: string;
  folders: WorkspaceFolderInfo[];
}

export interface HealthProbeResult {
  ok: boolean;
  instanceId?: string;
}

export interface RegistryFileStats {
  isSymbolicLink(): boolean;
  isDirectory(): boolean;
  isFile(): boolean;
}

/** Minimal injectable filesystem surface so security semantics are unit-testable. */
export interface RegistryFileSystem {
  lstat(targetPath: string): Promise<RegistryFileStats>;
  mkdir(targetPath: string, options?: { recursive?: boolean; mode?: number }): Promise<void>;
  readFile(targetPath: string): Promise<string>;
  writeFile(targetPath: string, data: string, options?: { mode?: number }): Promise<void>;
  rename(fromPath: string, toPath: string): Promise<void>;
  unlink(targetPath: string): Promise<void>;
  readdir(targetPath: string): Promise<string[]>;
  chmod(targetPath: string, mode: number): Promise<void>;
}

export const nodeRegistryFileSystem: RegistryFileSystem = {
  lstat: targetPath => fs.lstat(targetPath),
  mkdir: async (targetPath, options) => {
    await fs.mkdir(targetPath, options);
  },
  readFile: targetPath => fs.readFile(targetPath, 'utf8'),
  writeFile: (targetPath, data, options) => fs.writeFile(targetPath, data, { encoding: 'utf8', ...(options ?? {}) }),
  rename: (fromPath, toPath) => fs.rename(fromPath, toPath),
  unlink: targetPath => fs.unlink(targetPath),
  readdir: targetPath => fs.readdir(targetPath),
  chmod: (targetPath, mode) => fs.chmod(targetPath, mode),
};

/** On-disk endpoint file content (§2.1). The token lives here, never in /health. */
export interface EndpointFileContent {
  schemaVersion: 1;
  instanceId: string;
  projectId: string;
  channel: string;
  profile: string;
  extensionHost: string;
  workspaceFolders: string[];
  host: '127.0.0.1';
  port: number;
  rpcUrl: string;
  eventsUrl: string;
  healthUrl: string;
  token: string;
  processId: number;
  startedAt: number;
  heartbeatAt: number;
  apiVersions: string[];
}

export interface LiveEndpointSummary {
  instanceId: string;
  projectId: string;
  host: string;
  port: number;
  rpcUrl: string;
  eventsUrl: string;
  healthUrl: string;
  token?: string;
  heartbeatAt: number;
}

export interface InstanceRegistryOptions {
  /** `<extension-global-storage>/automation-api/endpoints` */
  endpointDirectory: string;
  /** Registry pointer path, normally from defaultRegistryPointerPath(). */
  registryPointerPath: string;
  /** Legacy `plugin-api-endpoint.json` written during one compatibility cycle. */
  legacyPointerPath?: string;
  identity: RegistryIdentity;
  extensionVersion: string;
  processId: number;
  getWorkspace(): WorkspaceSnapshot;
  getRegistryGeneration?(): number;
  listElfFiles?(): string[];
  listLaunchConfigurations?(): LaunchConfigurationSummary[];
  getCapabilities?(): Capability[];
  platform?: NodeJS.Platform;
  heartbeatIntervalMs?: number;
  staleHeartbeatGraceMs?: number;
  healthTimeoutMs?: number;
  now?(): number;
  fs?: RegistryFileSystem;
  probeHealth?(healthUrl: string, timeoutMs: number): Promise<HealthProbeResult>;
  /** Tighten ACL/mode; must reject when permissions cannot be guaranteed. */
  harden?(targetPath: string, kind: 'file' | 'directory'): Promise<void>;
}

// --- Pure helpers ----------------------------------------------------------

/** Windows paths compare case-insensitively; separators and trailing slashes normalize. */
export function normalizeFsPath(p: string, platform: NodeJS.Platform): string {
  let normalized = p.replace(/\\/g, '/').replace(/\/+$/, '');
  if (platform === 'win32') normalized = normalized.toLowerCase();
  return normalized;
}

/**
 * projectId = sha256 of the normalized workspace-file path (only real
 * `.code-workspace` files) plus the sorted normalized workspace-folder paths
 * (§2.1). Empty windows hash an empty list, so they all share one id; the
 * `instanceId` remains the unique window identity.
 */
export function computeProjectId(workspace: WorkspaceSnapshot, platform: NodeJS.Platform = process.platform): string {
  const parts: string[] = [];
  if (workspace.workspaceFilePath) {
    parts.push(`workspaceFile:${normalizeFsPath(workspace.workspaceFilePath, platform)}`);
  }
  const folders = [...workspace.folders].sort((a, b) =>
    normalizeFsPath(a.path, platform) < normalizeFsPath(b.path, platform) ? -1 : 1,
  );
  for (const folder of folders) parts.push(`folder:${normalizeFsPath(folder.path, platform)}`);
  const digest = createHash('sha256').update(parts.join('\n'), 'utf8').digest('hex');
  return `sha256:${digest}`;
}

export function detectChannel(env: {
  remoteName?: string;
  appName: string;
  portableEnv?: string;
}): RegistryChannel {
  if (env.remoteName) return 'remote';
  if (env.portableEnv) return 'portable';
  if (/insiders/i.test(env.appName)) return 'insiders';
  return 'stable';
}

export function detectExtensionHost(remoteName?: string): ExtensionHostKind {
  if (!remoteName) return 'local';
  if (remoteName.includes('ssh')) return 'ssh';
  if (remoteName.includes('wsl')) return 'wsl';
  if (remoteName.includes('container')) return 'container';
  return 'local';
}

/** Derives the profile identity from the globalStorage path (`.../User/profiles/<id>/globalStorage`). */
export function detectProfile(globalStoragePath: string): string {
  const segments = globalStoragePath.split(/[\\/]/);
  const userIndex = segments.lastIndexOf('User');
  if (userIndex >= 0 && segments[userIndex + 1] === 'profiles') {
    return segments[userIndex + 2] ?? '';
  }
  return '';
}

/** Shared endpoint directory next to the user-scope registry pointer (§2.6). */
export function defaultEndpointDirectory(pointerPath: string): string {
  return path.join(path.dirname(pointerPath), 'endpoints');
}

export function defaultRegistryPointerPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (env.ORBIT_AUTOMATION_REGISTRY) return env.ORBIT_AUTOMATION_REGISTRY;
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || path.join(env.USERPROFILE || '', 'AppData', 'Local');
    return path.join(localAppData, 'Orbit', 'automation', 'registries.json');
  }
  if (platform === 'darwin') {
    return path.join(env.HOME || '~', 'Library', 'Application Support', 'Orbit', 'automation', 'registries.json');
  }
  const runtimeDir = env.XDG_RUNTIME_DIR || path.join(env.HOME || '~', '.local', 'state');
  return path.join(runtimeDir, 'orbit', 'automation', 'registries.json');
}

/** Truthful capability baseline for what Task 2 itself serves; later tasks enrich it. */
export function defaultCapabilities(): Capability[] {
  const planned = (name: string, task: string): Capability => ({ name, available: false, reason: `planned: ${task}` });
  return [
    { name: 'discovery', available: true },
    { name: 'handshake', available: true },
    { name: 'rpc.v1', available: true },
    planned('session.control', 'task 4'),
    planned('target.control', 'task 5'),
    planned('flash', 'task 5'),
    planned('breakpoints.write', 'task 6'),
    planned('runtime.inspection', 'task 7'),
    planned('expression.write', 'task 8'),
    planned('symbols', 'task 8'),
    planned('memory.access', 'task 9'),
    planned('recording', 'task 10'),
    planned('rtt', 'task 11'),
    planned('events.sse', 'task 11'),
  ];
}

/**
 * Health probes must never leave the machine: endpoint files are per-user
 * writable, so a tampered `healthUrl` must not turn startup cleanup into an
 * outbound request to an arbitrary host.
 */
export function isLoopbackHealthUrl(healthUrl: string): boolean {
  try {
    const parsed = new URL(healthUrl);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '::1')
    );
  } catch {
    return false;
  }
}

export function probeHealthUrl(healthUrl: string, timeoutMs = 300): Promise<HealthProbeResult> {
  if (!isLoopbackHealthUrl(healthUrl)) {
    return Promise.resolve({ ok: false });
  }
  return new Promise(resolve => {
    const request = http.get(healthUrl, { timeout: timeoutMs }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        body += chunk;
        if (body.length > 65536) {
          request.destroy();
          resolve({ ok: false });
        }
      });
      response.on('end', () => {
        const status = response.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          resolve({ ok: false });
          return;
        }
        try {
          const parsed = JSON.parse(body) as { instanceId?: unknown };
          resolve({ ok: true, instanceId: typeof parsed.instanceId === 'string' ? parsed.instanceId : undefined });
        } catch {
          resolve({ ok: false });
        }
      });
    });
    request.on('timeout', () => {
      request.destroy();
      resolve({ ok: false });
    });
    request.on('error', () => resolve({ ok: false }));
  });
}

/**
 * Default permission hardening: Windows tightens ACLs to the current user and
 * SYSTEM via icacls; POSIX uses 0700 directories and 0600 files. Startup fails
 * when the permissions cannot be guaranteed — there is no loose fallback (§2.6).
 */
export function defaultHarden(
  platform: NodeJS.Platform,
): (targetPath: string, kind: 'file' | 'directory') => Promise<void> {
  if (platform === 'win32') {
    return (targetPath, kind) =>
      new Promise<void>((resolve, reject) => {
        const user = process.env.USERNAME;
        if (!user) {
          reject(new Error(`cannot determine the current user to tighten ACLs on ${targetPath}`));
          return;
        }
        const suffix = kind === 'directory' ? ':(OI)(CI)F' : ':F';
        const child = spawn('icacls', [targetPath, '/inheritance:r', '/grant:r', `${user}${suffix}`, `SYSTEM${suffix}`], {
          windowsHide: true,
          stdio: 'ignore',
        });
        child.once('error', error => {
          reject(new Error(`icacls failed to tighten ACLs on ${targetPath}: ${error.message}`));
        });
        child.once('exit', code => {
          if (code === 0) resolve();
          else reject(new Error(`icacls failed to tighten ACLs on ${targetPath}: exit code ${code}`));
        });
      });
  }
  return async (targetPath, kind) => {
    await fs.chmod(targetPath, kind === 'directory' ? 0o700 : 0o600);
  };
}

// --- Registry --------------------------------------------------------------

export class InstanceRegistry {
  private instanceId?: string;
  private projectId?: string;
  private bound?: BoundServerInfo & { healthUrl: string };
  private startedAtMs?: number;
  private heartbeatTimer?: NodeJS.Timeout;
  private beatInFlight?: Promise<void>;
  /** Directories this instance already hardened; on Windows their (OI)(CI) ACLs inherit to new files. */
  private readonly hardenedDirectories = new Set<string>();
  private disposed = false;

  constructor(private readonly options: InstanceRegistryOptions) {}

  /** Starts discovery: endpoint file, registry pointer, legacy pointer, cleanup, heartbeat. */
  async start(server: BoundServerInfo): Promise<InstanceDescription> {
    if (this.bound) return this.describe();
    if (this.disposed) throw new Error('InstanceRegistry is disposed');
    const instanceId = randomUUID();
    const projectId = computeProjectId(this.options.getWorkspace(), this.platform);
    const bound: BoundServerInfo & { healthUrl: string } = {
      ...server,
      host: '127.0.0.1',
      healthUrl: `http://${server.host}:${server.port}/health`,
    };
    this.instanceId = instanceId;
    this.projectId = projectId;
    this.bound = bound;
    this.startedAtMs = this.now();
    try {
      await this.ensureEndpointDirectory();
      try {
        await this.upsertRegistryPointer();
      } catch (error) {
        throw new Error(
          `Orbit Automation API cannot write its registry pointer at ${this.options.registryPointerPath}; ` +
            `set ORBIT_AUTOMATION_REGISTRY to a writable per-user location and restart. Cause: ${(error as Error)?.message ?? String(error)}`,
        );
      }
      await this.writeEndpointFile();
      await this.syncLegacyPointer();
      await this.cleanStaleEndpoints();
    } catch (error) {
      await this.fs.unlink(this.endpointFilePath()).catch(() => undefined);
      this.instanceId = undefined;
      this.projectId = undefined;
      this.bound = undefined;
      this.startedAtMs = undefined;
      throw error;
    }
    const timer = setInterval(() => {
      this.beatInFlight = this.runBeat();
    }, this.options.heartbeatIntervalMs ?? 5000);
    timer.unref?.();
    this.heartbeatTimer = timer;
    return this.describe();
  }

  /** Wire InstanceDescription; the bearer token is never part of it. */
  describe(): InstanceDescription {
    const bound = this.requireStarted();
    return {
      instanceId: this.instanceId!,
      version: this.options.extensionVersion,
      channel: this.options.identity.channel,
      processId: this.options.processId,
      startedAt: String(this.startedAtMs),
      workspaceFolders: this.options.getWorkspace().folders,
      endpoint: {
        schemaVersion: 1,
        host: bound.host,
        port: bound.port,
        rpcUrl: bound.rpcUrl,
        eventsUrl: bound.eventsUrl,
        healthUrl: bound.healthUrl,
        apiVersions: [...bound.apiVersions],
      },
    };
  }

  getInstanceId(): string {
    this.requireStarted();
    return this.instanceId!;
  }

  getProjectId(): string {
    this.requireStarted();
    return this.projectId!;
  }

  getProjectDescription(): ProjectDescription {
    const workspace = this.options.getWorkspace();
    return {
      projectId: this.getProjectId(),
      workspaceFileUri: workspace.workspaceFileUri,
      workspaceFolders: workspace.folders,
      elfFiles: this.options.listElfFiles ? this.options.listElfFiles() : [],
      launchConfigurations: this.options.listLaunchConfigurations ? this.options.listLaunchConfigurations() : [],
      registryGeneration: this.options.getRegistryGeneration ? this.options.getRegistryGeneration() : 0,
    };
  }

  getRegistryGeneration(): number {
    return this.options.getRegistryGeneration ? this.options.getRegistryGeneration() : 0;
  }

  getCapabilitySnapshot(includeUnavailable = true): CapabilitySnapshot {
    const capabilities = this.options.getCapabilities ? this.options.getCapabilities() : defaultCapabilities();
    return {
      apiVersion: '1.0',
      capabilities: includeUnavailable ? capabilities : capabilities.filter(capability => capability.available),
    };
  }

  /** Deletes this window's endpoint file, then drops the pointer only if no peer remains. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    if (!this.instanceId) return;
    // Wait for an in-flight heartbeat so its atomic rename cannot resurrect
    // the endpoint file after the unlink below.
    if (this.beatInFlight) {
      try {
        await this.beatInFlight;
      } catch {
        // runBeat never rejects; this is defensive only.
      }
    }
    await this.fs.unlink(this.endpointFilePath()).catch(error => {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        console.error(`[Orbit] failed to remove automation endpoint: ${(error as Error)?.message ?? String(error)}`);
      }
    });
    await this.removeRegistryPointerEntry().catch(error => {
      console.error(`[Orbit] failed to update the automation registry pointer: ${(error as Error)?.message ?? String(error)}`);
    });
    await this.syncLegacyPointer().catch(error => {
      console.error(`[Orbit] failed to update the legacy endpoint pointer: ${(error as Error)?.message ?? String(error)}`);
    });
  }

  // --- internals -----------------------------------------------------------

  private get platform(): NodeJS.Platform {
    return this.options.platform ?? process.platform;
  }

  private get fs(): RegistryFileSystem {
    return this.options.fs ?? nodeRegistryFileSystem;
  }

  private get harden(): (targetPath: string, kind: 'file' | 'directory') => Promise<void> {
    return this.options.harden ?? defaultHarden(this.platform);
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  private requireStarted(): BoundServerInfo & { healthUrl: string } {
    if (!this.bound) throw new Error('InstanceRegistry is not started');
    return this.bound;
  }

  private endpointFilePath(): string {
    return path.join(this.options.endpointDirectory, `${this.instanceId}.json`);
  }

  private identityKey(identity: RegistryIdentity = this.options.identity): string {
    return `${identity.channel}\u0000${identity.profile}\u0000${identity.extensionHost}`;
  }

  private async ensureEndpointDirectory(): Promise<void> {
    await this.ensureDirectory(this.options.endpointDirectory);
  }

  private async ensureDirectory(directory: string): Promise<void> {
    await this.assertNoReparse(path.dirname(directory));
    await this.assertNoReparse(directory);
    await this.fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await this.harden(directory, 'directory');
    this.hardenedDirectories.add(path.normalize(directory));
  }

  /** Rejects symlink/junction/reparse points on the parent, target and temp file before writing (§2.6). */
  private async assertNoReparse(targetPath: string): Promise<void> {
    let stats: RegistryFileStats;
    try {
      stats = await this.fs.lstat(targetPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return;
      throw error;
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`refusing to write through a symlink/junction/reparse point: ${targetPath}`);
    }
  }

  /** Atomic temp + rename with hardening applied to the temp file before it becomes visible. */
  private async writeAtomic(targetPath: string, data: string): Promise<void> {
    await this.assertNoReparse(path.dirname(targetPath));
    await this.assertNoReparse(targetPath);
    const tempPath = `${targetPath}.${randomUUID().replace(/-/g, '').slice(0, 12)}.tmp`;
    await this.fs.writeFile(tempPath, data, { mode: 0o600 });
    try {
      // On Windows a directory hardened with /grant:r (OI)(CI) propagates its
      // ACL to every new child, so per-heartbeat icacls spawns on temp files
      // under directories this instance already hardened are redundant — and
      // each spawn is a process the heartbeat must not create every 5 s.
      const parentHardened = this.hardenedDirectories.has(path.normalize(path.dirname(targetPath)));
      if (!(this.platform === 'win32' && parentHardened)) {
        await this.harden(tempPath, 'file');
      }
    } catch (error) {
      await this.fs.unlink(tempPath).catch(() => undefined);
      throw error;
    }
    try {
      await this.fs.rename(tempPath, targetPath);
    } catch (error) {
      await this.fs.unlink(tempPath).catch(() => undefined);
      throw error;
    }
  }

  private endpointFileContent(heartbeatAt: number): EndpointFileContent {
    const bound = this.requireStarted();
    return {
      schemaVersion: 1,
      instanceId: this.instanceId!,
      projectId: this.projectId!,
      channel: this.options.identity.channel,
      profile: this.options.identity.profile,
      extensionHost: this.options.identity.extensionHost,
      workspaceFolders: this.options.getWorkspace().folders.map(folder => folder.path),
      host: bound.host,
      port: bound.port,
      rpcUrl: bound.rpcUrl,
      eventsUrl: bound.eventsUrl,
      healthUrl: bound.healthUrl,
      token: bound.token,
      processId: bound.processId,
      startedAt: bound.startedAt,
      heartbeatAt,
      apiVersions: [...bound.apiVersions],
    };
  }

  private async writeEndpointFile(): Promise<void> {
    const content = `${JSON.stringify(this.endpointFileContent(this.now()), null, 2)}\n`;
    await this.writeAtomic(this.endpointFilePath(), content);
  }

  /** One heartbeat tick; never rejects so dispose() can safely await the in-flight tick. */
  private runBeat(): Promise<void> {
    return (async () => {
      if (this.disposed || !this.bound) return;
      try {
        await this.writeEndpointFile();
        if (this.disposed) return;
        await this.syncLegacyPointer();
      } catch (error) {
        console.error(`[Orbit] automation endpoint heartbeat failed: ${(error as Error)?.message ?? String(error)}`);
      }
    })();
  }

  private async readRegistryPointer(pointerPath: string): Promise<RegistryPointerFile | undefined> {
    await this.assertNoReparse(pointerPath);
    let raw: string;
    try {
      raw = await this.fs.readFile(pointerPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`invalid JSON in registry pointer at ${pointerPath}`);
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as { schemaVersion?: unknown }).schemaVersion !== 1 ||
      !Array.isArray((parsed as { registries?: unknown }).registries)
    ) {
      throw new Error(`untrusted registry pointer schema at ${pointerPath}`);
    }
    return parsed as RegistryPointerFile;
  }

  private async upsertRegistryPointer(): Promise<void> {
    const pointerPath = this.options.registryPointerPath;
    const existing = await this.readRegistryPointer(pointerPath);
    const key = this.identityKey();
    const registries = (existing?.registries ?? []).filter(entry => this.identityKey(entry) !== key);
    registries.push({
      channel: this.options.identity.channel,
      profile: this.options.identity.profile,
      extensionHost: this.options.identity.extensionHost,
      endpointDirectory: this.options.endpointDirectory,
      updatedAt: this.now(),
    });
    await this.ensureDirectory(path.dirname(pointerPath));
    await this.writeAtomic(pointerPath, `${JSON.stringify({ schemaVersion: 1, registries } satisfies RegistryPointerFile, null, 2)}\n`);
  }

  private async removeRegistryPointerEntry(): Promise<void> {
    const pointerPath = this.options.registryPointerPath;
    const existing = await this.readRegistryPointer(pointerPath);
    if (!existing) return;
    // Same channel/profile/host windows share one pointer entry. Keep it
    // while any other live endpoint still occupies this directory.
    const { live } = await this.scanEndpointFiles();
    if (live.length > 0) return;
    const key = this.identityKey();
    const registries = existing.registries.filter(entry => this.identityKey(entry) !== key);
    if (registries.length === 0) {
      await this.fs.unlink(pointerPath);
      return;
    }
    await this.writeAtomic(pointerPath, `${JSON.stringify({ schemaVersion: 1, registries } satisfies RegistryPointerFile, null, 2)}\n`);
  }

  /** Reads one endpoint file into a summary, or undefined when untrustworthy. */
  private async readEndpointFile(filePath: string): Promise<LiveEndpointSummary | undefined> {
    let raw: string;
    try {
      raw = await this.fs.readFile(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }
    const record = parsed as Record<string, unknown>;
    if (
      typeof record !== 'object' ||
      record === null ||
      record.schemaVersion !== 1 ||
      typeof record.instanceId !== 'string' ||
      typeof record.heartbeatAt !== 'number'
    ) {
      return undefined;
    }
    return {
      instanceId: record.instanceId,
      projectId: typeof record.projectId === 'string' ? record.projectId : 'sha256:unknown',
      host: typeof record.host === 'string' ? record.host : '127.0.0.1',
      port: typeof record.port === 'number' ? record.port : 0,
      rpcUrl: typeof record.rpcUrl === 'string' ? record.rpcUrl : '',
      eventsUrl: typeof record.eventsUrl === 'string' ? record.eventsUrl : '',
      healthUrl:
        typeof record.healthUrl === 'string'
          ? record.healthUrl
          : `http://${typeof record.host === 'string' ? record.host : '127.0.0.1'}:${typeof record.port === 'number' ? record.port : 0}/health`,
      token: typeof record.token === 'string' ? record.token : undefined,
      heartbeatAt: record.heartbeatAt,
    };
  }

  /**
   * Classifies every endpoint file in the shared directory as live or dead.
   * Deletion requires both a failed /health probe and a heartbeat older than
   * the 30 s grace; health serving a different instanceId keeps the file (§2.6).
   */
  private async scanEndpointFiles(): Promise<{ live: LiveEndpointSummary[]; dead: string[] }> {
    const live: LiveEndpointSummary[] = [];
    const dead: string[] = [];
    let names: string[];
    try {
      names = await this.fs.readdir(this.options.endpointDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { live, dead };
      throw error;
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const filePath = path.join(this.options.endpointDirectory, name);
      const summary = await this.readEndpointFile(filePath);
      if (!summary) continue; // unparseable residue: conservative, keep it
      const grace = this.options.staleHeartbeatGraceMs ?? 30_000;
      if (this.now() - summary.heartbeatAt <= grace) {
        live.push(summary);
        continue;
      }
      if (!isLoopbackHealthUrl(summary.healthUrl)) {
        continue; // untrusted health URL: keep the file, never probe it
      }
      const probe = await this.probeHealth(summary.healthUrl, this.options.healthTimeoutMs ?? 300);
      if (!probe.ok) {
        dead.push(filePath);
        continue;
      }
      if (probe.instanceId !== undefined && probe.instanceId !== summary.instanceId) {
        continue; // the port now serves a different live instance; keep this file
      }
      live.push(summary);
    }
    return { live, dead };
  }

  private async cleanStaleEndpoints(): Promise<void> {
    const { dead } = await this.scanEndpointFiles();
    for (const filePath of dead) {
      await this.fs.unlink(filePath).catch(error => {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
      });
    }
  }

  /**
   * Legacy pointer compatibility (§2.6 / Task 2): `unique` only when this
   * endpoint directory holds exactly one live instance, `ambiguous` with the
   * full instance list otherwise. Never selects a window by itself.
   */
  private async syncLegacyPointer(): Promise<void> {
    if (!this.options.legacyPointerPath) return;
    // The legacy pointer parent (this extension's globalStorage) is hardened
    // once per session so its children inherit the ACL on Windows; after that
    // the five-second heartbeat writes no further icacls processes.
    const parent = path.normalize(path.dirname(this.options.legacyPointerPath));
    if (!this.hardenedDirectories.has(parent)) {
      await this.ensureDirectory(parent);
    }
    const { live } = await this.scanEndpointFiles();
    if (live.length === 0) {
      await this.fs.unlink(this.options.legacyPointerPath).catch(error => {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
      });
      return;
    }
    let pointer: LegacyEndpointPointer;
    if (live.length === 1) {
      const only = live[0];
      pointer = {
        schemaVersion: 1,
        status: 'unique',
        instanceId: only.instanceId,
        projectId: only.projectId,
        host: only.host,
        port: only.port,
        rpcUrl: only.rpcUrl,
        eventsUrl: only.eventsUrl,
        healthUrl: only.healthUrl,
        url: only.rpcUrl,
        token: only.token,
        updatedAt: this.now(),
      };
    } else {
      pointer = {
        schemaVersion: 1,
        status: 'ambiguous',
        updatedAt: this.now(),
        instances: live.map(({ instanceId, projectId, host, port, rpcUrl, eventsUrl, healthUrl }) => ({
          instanceId,
          projectId,
          host,
          port,
          rpcUrl,
          eventsUrl,
          healthUrl,
        })),
      };
    }
    await this.writeAtomic(this.options.legacyPointerPath, `${JSON.stringify(pointer, null, 2)}\n`);
  }

  private probeHealth(healthUrl: string, timeoutMs: number): Promise<HealthProbeResult> {
    return this.options.probeHealth ? this.options.probeHealth(healthUrl, timeoutMs) : probeHealthUrl(healthUrl, timeoutMs);
  }
}
