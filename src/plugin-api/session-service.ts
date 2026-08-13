// Orbit Automation API v1 — visible VS Code session start/stop and launch
// configuration discovery (plan Task 4, §1.2/§2.3).
//
// `start()` drives the real, visible debug session through
// `vscode.debug.startDebugging()` only, reusing OzoneDebugConfigurationProvider
// normalization, and never creates a hidden session, a second owner, or a
// direct extension-host target connection. `stop()` always receives the exact
// `vscode.DebugSession`; it never stops sessions without one.
//
// All vscode/file-system access is injectable so the generation fences and
// error mapping are unit-testable without the Extension Host.
import * as fs from 'fs';
import * as vscode from 'vscode';
import { OzoneDebugConfigurationProvider } from '../debug/ozone-debug-config';
import { isOrbitDebugSessionType } from '../utils/debug-session-type';
import {
  AutomationError,
  LaunchConfiguration,
  OperationAck,
  ProjectMutationContext,
  SessionListData,
  SessionRef,
  SessionSnapshot,
} from './protocol';
import { SessionRegistry } from './session-registry';

const DEFAULT_START_TIMEOUT_MS = 30_000;
const MAX_START_TIMEOUT_MS = 30_000;
const START_POLL_INTERVAL_MS = 50;
const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 1_000;

/** Internal launch configuration shape accepted by `start()` (not on the v1 wire). */
export type OrbitLaunchConfiguration = vscode.DebugConfiguration;

export interface StartSessionRequest {
  /** Frozen ProjectMutationContext: no session identity yet, current registry generation fence. */
  context: ProjectMutationContext;
  /** Name of a launch.json configuration, or an inline configuration id. */
  configurationId: string;
  /** Optional display name override for the started session. */
  configurationName?: string;
  noDebug?: boolean;
  /** Bounded 1..30000 ms; the start-event wait budget. */
  timeoutMs?: number;
  /** Internal-only: an inline launch configuration (not part of the frozen wire params). */
  configuration?: OrbitLaunchConfiguration;
}

export interface SessionListOptions {
  includeTerminated?: boolean;
  cursor?: string;
  limit?: number;
}

export interface LaunchConfigurationPage {
  items: LaunchConfiguration[];
  nextCursor?: string;
}

export interface SessionServiceOptions {
  registry: SessionRegistry;
  /** vscode.debug.startDebugging seam. */
  startDebugging?(
    folder: vscode.WorkspaceFolder | undefined,
    nameOrConfiguration: string | vscode.DebugConfiguration,
    options?: vscode.DebugSessionOptions,
  ): Thenable<boolean>;
  /** vscode.debug.stopDebugging seam; must be called with the exact session. */
  stopDebugging?(session: vscode.DebugSession): Thenable<void>;
  workspaceFolders?(): readonly vscode.WorkspaceFolder[] | undefined;
  /** Launch configurations visible to `folder` (launch.json + settings merge). */
  launchConfigurations?(folder: vscode.WorkspaceFolder | undefined): vscode.DebugConfiguration[];
  /** Defaults to OzoneDebugConfigurationProvider normalization (plan Task 4). */
  resolveLaunchConfiguration?(
    folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration,
  ): vscode.ProviderResult<vscode.DebugConfiguration>;
  fileExists?(filePath: string): boolean;
  sleep?(ms: number): Promise<void>;
  now?(): number;
}

export class SessionService {
  private readonly opts: Required<SessionServiceOptions>;

  constructor(options: SessionServiceOptions) {
    const defaults: Required<SessionServiceOptions> = {
      startDebugging: (folder, nameOrConfiguration, sessionOptions) =>
        vscode.debug.startDebugging(folder, nameOrConfiguration, sessionOptions),
      stopDebugging: session => vscode.debug.stopDebugging(session),
      workspaceFolders: () => vscode.workspace.workspaceFolders,
      launchConfigurations: folder => readLaunchConfigurations(folder),
      resolveLaunchConfiguration: (folder, config) =>
        new OzoneDebugConfigurationProvider().resolveDebugConfiguration(folder, config),
      fileExists: filePath => fs.existsSync(filePath),
      sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
      now: () => Date.now(),
      registry: options.registry,
    };
    // An explicitly `undefined` seam falls back to the default implementation
    // (e.g. tests that only replace one seam), so merge key by key.
    const merged: Record<string, unknown> = { ...defaults, ...options };
    for (const [key, value] of Object.entries(defaults)) {
      if (merged[key] === undefined) merged[key] = value;
    }
    this.opts = merged as unknown as Required<SessionServiceOptions>;
  }

  /** Named `orbit`/`ozone` launch configurations of this workspace (frozen wire shape). */
  listLaunchConfigurations(includeLegacyAlias = true): LaunchConfiguration[] {
    const items = listOrbitLaunchConfigurations();
    return includeLegacyAlias ? items : items.filter(config => config.type === 'orbit');
  }

  /** Paged form backing `orbit.project.listLaunchConfigurations` (index cursor). */
  listLaunchConfigurationsPage(
    page: { cursor?: string; limit?: number } = {},
    includeLegacyAlias = true,
  ): LaunchConfigurationPage {
    const limit = this.clampLimit(page.limit);
    const items = this.listLaunchConfigurations(includeLegacyAlias);
    const start = this.resolvePageStart(page.cursor, items.length);
    const slice = items.slice(start, start + limit);
    const result: LaunchConfigurationPage = { items: slice };
    if (start + limit < items.length) result.nextCursor = String(start + limit);
    return result;
  }

  /**
   * Starts the visible VS Code debug session. Fences, in order: the
   * ProjectMutationContext registry generation, the one-target-session rule,
   * configuration resolution/normalization/ELF validation, then
   * `vscode.debug.startDebugging()` and the session start event.
   */
  async start(request: StartSessionRequest, operationId?: string): Promise<OperationAck> {
    const registry = this.opts.registry;
    this.requireOperationId(operationId);

    if (request.context.registryGeneration !== registry.registryGeneration) {
      throw new AutomationError(
        'InvalidRequest',
        'registry generation changed; refresh the project description and retry',
        false,
        undefined,
        {
          expectedGeneration: request.context.registryGeneration,
          actualGeneration: registry.registryGeneration,
        },
      );
    }

    const currentSnapshot = registry.currentSnapshot();
    if (currentSnapshot) {
      throw new AutomationError(
        'SessionAlreadyActive',
        'an Orbit target session is already active in this instance',
        false,
        { current: currentSnapshot },
      );
    }

    // Capture before any await: with the one-target-session rule enforced
    // above, every session the registry reports from here on is the one this
    // call started (the extension host registers it during startDebugging).
    const preExisting = new Set(registry.snapshot({ includeTerminated: true }).map(item => item.sessionId));

    const { config, folder } = this.resolveConfiguration(request);
    const providerResult = await this.opts.resolveLaunchConfiguration(folder, { ...config });
    const finalConfig: vscode.DebugConfiguration = (providerResult ?? config) as vscode.DebugConfiguration;
    if (request.configurationName) finalConfig.name = request.configurationName;
    this.requireElfProgram(finalConfig, folder);

    let started = false;
    try {
      started = await this.opts.startDebugging(folder, finalConfig, { noDebug: request.noDebug });
    } catch (error) {
      const message = (error as Error)?.message ?? String(error);
      throw new AutomationError(
        'CapabilityUnavailable',
        `vscode.debug.startDebugging failed: ${message}`,
        false,
        undefined,
        { reason: message },
      );
    }
    if (!started) {
      throw new AutomationError(
        'CapabilityUnavailable',
        'vscode.debug.startDebugging returned false; the debug session did not start',
        false,
      );
    }

    const timeoutMs = this.clampTimeout(request.timeoutMs);
    const deadline = this.opts.now() + timeoutMs;
    while (this.opts.now() < deadline) {
      const snapshot = registry.currentSnapshot();
      if (snapshot && !preExisting.has(snapshot.sessionId)) {
        return { operationId: operationId!, accepted: true, session: snapshot };
      }
      await this.opts.sleep(START_POLL_INTERVAL_MS);
    }
    // The mutation was dispatched: the same idempotency key must never
    // re-execute it (plan §2.4). Clients verify via orbit.operation.get and
    // orbit.session.list/snapshot.
    throw new AutomationError(
      'RequestTimeout',
      'session start was accepted but the session start event did not arrive',
      false,
      { timeoutKind: 'outcomeUnknown', operationId: operationId! },
    );
  }

  /** Stops the exact session; never stops sessions without the precise ref. */
  async stop(ref: SessionRef, operationId?: string): Promise<OperationAck> {
    this.requireOperationId(operationId);
    const session = this.opts.registry.requireExact(ref);
    await this.opts.stopDebugging(session);
    return {
      operationId: operationId!,
      accepted: true,
      session: this.opts.registry.getSessionSnapshot(ref.sessionId),
    };
  }

  /** `orbit.session.list`: active session first, then terminated history. */
  list(options: SessionListOptions = {}): SessionListData {
    const limit = this.clampLimit(options.limit);
    const all = this.opts.registry.snapshot({ includeTerminated: options.includeTerminated ?? false });
    const start = options.cursor === undefined ? 0 : all.findIndex(item => item.sessionId === options.cursor) + 1;
    if (options.cursor !== undefined && start === 0) {
      throw new AutomationError('InvalidRequest', `unknown cursor ${options.cursor}`, false);
    }
    const items = all.slice(start, start + limit);
    const data: SessionListData = { items };
    if (start + limit < all.length) data.nextCursor = items[items.length - 1].sessionId;
    return data;
  }

  /** `orbit.session.snapshot`: generation-free recovery read, NoActiveSession when absent. */
  snapshot(sessionId: string, includeCapabilities = true): SessionSnapshot {
    const snapshot = this.opts.registry.getSessionSnapshot(sessionId);
    if (!snapshot || snapshot.phase === 'terminated') {
      throw new AutomationError(
        'NoActiveSession',
        `no active session ${sessionId}`,
        false,
        undefined,
        { sessionId },
      );
    }
    return includeCapabilities ? snapshot : { ...snapshot, capabilities: [] };
  }

  // --- internals -----------------------------------------------------------

  private requireOperationId(operationId: string | undefined): void {
    if (!operationId) {
      throw new AutomationError('InternalError', 'session mutation dispatched without an operationId', false);
    }
  }

  private clampTimeout(timeoutMs: number | undefined): number {
    const value = timeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    if (!Number.isFinite(value)) return DEFAULT_START_TIMEOUT_MS;
    return Math.max(1, Math.min(Math.floor(value), MAX_START_TIMEOUT_MS));
  }

  private clampLimit(limit: number | undefined): number {
    const value = limit ?? DEFAULT_PAGE_LIMIT;
    if (!Number.isFinite(value)) return DEFAULT_PAGE_LIMIT;
    return Math.max(1, Math.min(Math.floor(value), MAX_PAGE_LIMIT));
  }

  private resolvePageStart(cursor: string | undefined, length: number): number {
    if (cursor === undefined) return 0;
    const start = Number(cursor);
    if (!Number.isInteger(start) || start < 0 || start >= length) {
      throw new AutomationError('InvalidRequest', `unknown cursor ${cursor}`, false);
    }
    return start;
  }

  private resolveConfiguration(request: StartSessionRequest): {
    config: vscode.DebugConfiguration;
    folder: vscode.WorkspaceFolder | undefined;
  } {
    if (request.configuration !== undefined) {
      const config: vscode.DebugConfiguration = { ...request.configuration };
      this.requireOrbitConfigurationType(config, 'inline configuration');
      return { config, folder: this.folderForUri(config.workspaceFolderUri) };
    }
    const matches = this.findNamedConfigurations(request.configurationId);
    if (matches.length === 0) {
      throw new AutomationError(
        'InvalidRequest',
        `no launch configuration named ${request.configurationId}`,
        false,
        undefined,
        { configurationId: request.configurationId },
      );
    }
    if (matches.length > 1) {
      throw new AutomationError(
        'InvalidRequest',
        `launch configuration name ${request.configurationId} is ambiguous across workspace folders`,
        false,
        undefined,
        { configurationId: request.configurationId },
      );
    }
    const match = matches[0];
    const config: vscode.DebugConfiguration = { ...match.config };
    this.requireOrbitConfigurationType(config, `launch configuration ${request.configurationId}`);
    return { config, folder: match.folder };
  }

  private requireOrbitConfigurationType(config: vscode.DebugConfiguration, label: string): void {
    if (!isOrbitDebugSessionType(config.type)) {
      throw new AutomationError(
        'InvalidRequest',
        `${label} must have type orbit or ozone; received ${String(config.type ?? '(none)')}`,
        false,
        undefined,
        { type: config.type },
      );
    }
  }

  private findNamedConfigurations(name: string): Array<{
    config: vscode.DebugConfiguration;
    folder: vscode.WorkspaceFolder | undefined;
  }> {
    const folders = this.opts.workspaceFolders() ?? [];
    const results: Array<{ config: vscode.DebugConfiguration; folder: vscode.WorkspaceFolder | undefined }> = [];
    if (folders.length === 0) {
      for (const config of this.opts.launchConfigurations(undefined)) {
        if (config && config.name === name) results.push({ config, folder: undefined });
      }
      return results;
    }
    for (const folder of folders) {
      for (const config of this.opts.launchConfigurations(folder)) {
        if (!config || config.name !== name) continue;
        // The same workspace-scoped entry may surface under every folder;
        // identical duplicates count as one match.
        if (results.some(match => this.sameConfiguration(match.config, config))) continue;
        results.push({ config, folder });
      }
    }
    return results;
  }

  private sameConfiguration(a: vscode.DebugConfiguration, b: vscode.DebugConfiguration): boolean {
    return a.name === b.name && a.type === b.type && a.request === b.request && a.program === b.program;
  }

  private folderForUri(workspaceFolderUri: unknown): vscode.WorkspaceFolder | undefined {
    const folders = this.opts.workspaceFolders() ?? [];
    if (typeof workspaceFolderUri !== 'string') return folders[0];
    return folders.find(folder => folder.uri.toString() === workspaceFolderUri) ?? folders[0];
  }

  /** Blocks only when the program is missing or verifiably absent on disk. */
  private requireElfProgram(config: vscode.DebugConfiguration, folder: vscode.WorkspaceFolder | undefined): void {
    const program = String(config.program ?? '').trim();
    if (!program) {
      throw new AutomationError(
        'CapabilityUnavailable',
        'no ELF program configured for the launch configuration',
        false,
        undefined,
        { capability: 'program', program },
      );
    }
    const resolved = this.resolveProgramPath(program, folder);
    if (resolved !== undefined && !this.opts.fileExists(resolved)) {
      throw new AutomationError(
        'CapabilityUnavailable',
        `ELF program does not exist: ${resolved}`,
        false,
        undefined,
        { capability: 'program', program, resolved },
      );
    }
  }

  private resolveProgramPath(program: string, folder: vscode.WorkspaceFolder | undefined): string | undefined {
    const folderPath = folder?.uri.fsPath ?? this.opts.workspaceFolders()?.[0]?.uri.fsPath;
    const resolved = folderPath
      ? program.replace(/\$\{workspaceFolder(?::[^}]*)?\}/g, folderPath)
      : program;
    // Unresolvable variables (${env:...}, ${command:...}) cannot be verified;
    // return undefined so requireElfProgram skips the existence check.
    return /\$\{[^}]+\}/.test(resolved) ? undefined : resolved;
  }
}

/**
 * Named `orbit`/`ozone` launch configurations of this workspace, normalized
 * to the frozen wire shape (shared with InstanceRegistry for project.describe).
 */
export function listOrbitLaunchConfigurations(): LaunchConfiguration[] {
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

function readLaunchConfigurations(folder: vscode.WorkspaceFolder | undefined): vscode.DebugConfiguration[] {
  const section = folder
    ? vscode.workspace.getConfiguration('launch', folder.uri)
    : vscode.workspace.getConfiguration('launch');
  const configs = section.get<Array<vscode.DebugConfiguration>>('configurations', []);
  return Array.isArray(configs) ? configs : [];
}
