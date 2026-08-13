// Orbit Automation API v1 — project handshake, scope intersection and
// connection leases (plan Task 2, §2.3).
//
// `orbit.handshake` is the only bootstrap mutation that creates a connection.
// Granted scopes are `requestedScopes ∩ orbit.automation.allowedScopes`; the
// bearer token never self-grants a scope. A connection expires after ten idle
// minutes and any successful request renews the lease. This module is
// `vscode`-free: settings, instance/project descriptions and the current
// session snapshot are injected by the Extension Host.
import { randomUUID } from 'crypto';
import {
  AutomationError,
  AutomationScope,
  CapabilitySnapshot,
  ConnectionLease,
  HandshakeData,
  InstanceDescription,
  ProjectDescription,
  WorkspaceFolderInfo,
} from './protocol';
import { normalizeFsPath } from './instance-registry';

export interface HandshakeClientInfo {
  name: string;
  version?: string;
  pid?: number;
}

export interface HandshakeExpected {
  projectId: string;
  instanceId?: string;
  workspaceRoot?: string;
}

export interface HandshakeRequest {
  apiVersion: string;
  client: HandshakeClientInfo;
  expected: HandshakeExpected;
  requestedScopes?: AutomationScope[];
}

export interface HandshakeServiceOptions {
  instanceId(): string;
  projectId(): string;
  allowedScopes(): readonly AutomationScope[];
  getInstanceDescription(): InstanceDescription;
  getProjectDescription(): ProjectDescription;
  getCapabilitySnapshot(): CapabilitySnapshot;
  getWorkspaceFolders(): WorkspaceFolderInfo[];
  getSessionSnapshot?(): unknown;
  leaseTtlMs?: number;
  maxConnections?: number;
  platform?: NodeJS.Platform;
  now?(): number;
}

export const DEFAULT_CONNECTION_LEASE_MS = 10 * 60 * 1000;
export const MAX_CONNECTIONS = 32;

export class HandshakeService {
  private readonly leases = new Map<string, ConnectionLease>();

  constructor(private readonly options: HandshakeServiceOptions) {}

  handshake(request: HandshakeRequest, context: { instanceId: string; projectId: string }): HandshakeData {
    if (request.apiVersion !== '1.0') {
      throw new AutomationError(
        'UnsupportedApiVersion',
        `unsupported apiVersion ${request.apiVersion}; only 1.0 is served`,
        false,
        undefined,
        { supportedApiVersions: ['1.0'] },
      );
    }
    if (context.instanceId !== this.options.instanceId()) {
      throw new AutomationError('InstanceMismatch', 'request instanceId does not match this instance', false);
    }
    if (context.projectId !== this.options.projectId()) {
      throw new AutomationError('ProjectMismatch', 'request projectId does not match this project', false);
    }
    if (request.expected.projectId !== this.options.projectId()) {
      throw new AutomationError('ProjectMismatch', `expected projectId ${request.expected.projectId} does not match this project`, false);
    }
    if (request.expected.instanceId !== undefined && request.expected.instanceId !== this.options.instanceId()) {
      throw new AutomationError('InstanceMismatch', `expected instanceId ${request.expected.instanceId} does not match this instance`, false);
    }
    if (request.expected.workspaceRoot !== undefined && !this.workspaceRootMatches(request.expected.workspaceRoot)) {
      throw new AutomationError(
        'ProjectMismatch',
        `workspaceRoot ${request.expected.workspaceRoot} is not part of this project`,
        false,
      );
    }
    if (this.leases.size >= (this.options.maxConnections ?? MAX_CONNECTIONS)) {
      throw new AutomationError(
        'RateLimited',
        `instance allows at most ${this.options.maxConnections ?? MAX_CONNECTIONS} connections`,
        false,
        undefined,
        { connectionLimit: this.options.maxConnections ?? MAX_CONNECTIONS },
      );
    }

    const allowed = this.options.allowedScopes();
    const grantedScopes = (request.requestedScopes ?? []).filter(
      (scope, index, scopes) => scopes.indexOf(scope) === index && allowed.includes(scope),
    );
    const connectionId = `conn_${randomUUID()}`;
    this.leases.set(connectionId, {
      connectionId,
      instanceId: this.options.instanceId(),
      projectId: this.options.projectId(),
      scopes: new Set(grantedScopes),
      expiresAt: this.now() + (this.options.leaseTtlMs ?? DEFAULT_CONNECTION_LEASE_MS),
    });

    const data: HandshakeData = {
      connectionId,
      expiresAt: String(this.leases.get(connectionId)!.expiresAt),
      grantedScopes,
      instance: this.options.getInstanceDescription(),
      project: this.options.getProjectDescription(),
      capabilities: this.options.getCapabilitySnapshot(),
    };
    const session = this.options.getSessionSnapshot?.();
    if (session !== undefined) data.session = session;
    return data;
  }

  /** Lease lookup for the dispatcher; does not refresh or judge expiry. */
  get(connectionId: string): ConnectionLease | undefined {
    return this.leases.get(connectionId);
  }

  /** Any successful request renews the lease (§2.3). */
  touch(connectionId: string): void {
    const lease = this.leases.get(connectionId);
    if (!lease || lease.expiresAt <= this.now()) return;
    lease.expiresAt = this.now() + (this.options.leaseTtlMs ?? DEFAULT_CONNECTION_LEASE_MS);
  }

  /** Scope-aware authorization used by the server and, later, the SSE transport. */
  authorize(connectionId: string, scope: AutomationScope): ConnectionLease {
    const lease = this.leases.get(connectionId);
    if (!lease || lease.expiresAt <= this.now()) {
      if (lease) this.leases.delete(connectionId);
      throw new AutomationError('ConnectionExpired', `connection ${connectionId} is closed or expired`, false);
    }
    if (!lease.scopes.has(scope)) {
      throw new AutomationError('Unauthorized', `connection ${connectionId} lacks required scope ${scope}`, false, undefined, {
        requiredScopes: [scope],
      });
    }
    return lease;
  }

  close(connectionId: string): { connectionId: string; closed: boolean; releasedSubscriptions: number } {
    const closed = this.leases.delete(connectionId);
    return { connectionId, closed, releasedSubscriptions: 0 };
  }

  closeAll(): void {
    this.leases.clear();
  }

  connections(): IterableIterator<string> {
    return this.leases.keys();
  }

  private workspaceRootMatches(root: string): boolean {
    const normalized = normalizeFsPath(root, this.options.platform ?? process.platform);
    return this.options.getWorkspaceFolders().some(folder => {
      const folderPath = normalizeFsPath(folder.path, this.options.platform ?? process.platform);
      return normalized === folderPath || normalized.startsWith(`${folderPath}/`);
    });
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }
}
