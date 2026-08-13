// HandshakeService: scope intersection, project/instance/workspace fences,
// lease expiry/refresh, connection caps and close semantics (plan Task 2 §2.3).
import { describe, expect, it } from 'vitest';
import {
  AutomationError,
  AutomationScope,
  CapabilitySnapshot,
  InstanceDescription,
  ProjectDescription,
} from './protocol';
import { HandshakeService, HandshakeServiceOptions, HandshakeRequest } from './handshake-service';

const INSTANCE: InstanceDescription = {
  instanceId: 'instance-1',
  version: '1.1.0',
  channel: 'stable',
  processId: 4242,
  startedAt: '1786540000000',
  workspaceFolders: [{ name: 'robot', uri: 'file:///C:/work/robot', path: 'C:\\work\\robot' }],
  endpoint: {
    schemaVersion: 1,
    host: '127.0.0.1',
    port: 45123,
    rpcUrl: 'http://127.0.0.1:45123/v1/rpc',
    eventsUrl: 'http://127.0.0.1:45123/v1/events',
    healthUrl: 'http://127.0.0.1:45123/health',
    apiVersions: ['1.0'],
  },
};

const PROJECT: ProjectDescription = {
  projectId: 'sha256:project-1',
  workspaceFolders: INSTANCE.workspaceFolders,
  elfFiles: [],
  launchConfigurations: [],
  registryGeneration: 0,
};

const CAPABILITIES: CapabilitySnapshot = {
  apiVersion: '1.0',
  capabilities: [{ name: 'discovery', available: true }],
};

const CONTEXT = { instanceId: 'instance-1', projectId: 'sha256:project-1' };

function request(overrides: Partial<HandshakeRequest> = {}): HandshakeRequest {
  return {
    apiVersion: '1.0',
    client: { name: 'test-client', version: '0.1.0' },
    expected: { projectId: 'sha256:project-1' },
    requestedScopes: ['read'],
    ...overrides,
  };
}

interface Harness {
  service: HandshakeService;
  advance(ms: number): void;
  now(): number;
}

function makeService(overrides: Partial<HandshakeServiceOptions> = {}): Harness {
  let clock = 1_000_000;
  const service = new HandshakeService({
    instanceId: () => 'instance-1',
    projectId: () => 'sha256:project-1',
    allowedScopes: () => ['read', 'view.write'],
    getInstanceDescription: () => INSTANCE,
    getProjectDescription: () => PROJECT,
    getCapabilitySnapshot: () => CAPABILITIES,
    getWorkspaceFolders: () => INSTANCE.workspaceFolders,
    platform: 'win32',
    now: () => clock,
    ...overrides,
  });
  return {
    service,
    advance: ms => {
      clock += ms;
    },
    now: () => clock,
  };
}

describe('HandshakeService.handshake', () => {
  it('grants the intersection of requested and allowed scopes, preserving order', () => {
    const { service } = makeService();
    const response = service.handshake(
      request({ requestedScopes: ['flash', 'read', 'session.control', 'view.write', 'flash'] }),
      CONTEXT,
    );
    expect(response.connectionId).toMatch(/^conn_[0-9a-f-]{36}$/);
    expect(response.grantedScopes).toEqual(['read', 'view.write']);
    expect(response.expiresAt).toBe(String(1_000_000 + 10 * 60_000));
    expect(response.instance).toEqual(INSTANCE);
    expect(response.project).toEqual(PROJECT);
    expect(response.capabilities).toEqual(CAPABILITIES);
    expect(response.session).toBeUndefined();
  });

  it('supports an absent requestedScopes list', () => {
    const { service } = makeService();
    const response = service.handshake(request({ requestedScopes: undefined }), CONTEXT);
    expect(response.grantedScopes).toEqual([]);
  });

  it('rejects unsupported API versions', () => {
    const { service } = makeService();
    expect(() => service.handshake(request({ apiVersion: '2.0' }), CONTEXT)).toThrowError(
      expect.objectContaining({ errorCode: 'UnsupportedApiVersion' }),
    );
  });

  it('rejects wrong expected project, instance and workspace root', () => {
    const { service } = makeService();
    expect(() => service.handshake(request({ expected: { projectId: 'sha256:other' } }), CONTEXT)).toThrowError(
      expect.objectContaining({ errorCode: 'ProjectMismatch' }),
    );
    expect(() =>
      service.handshake(request({ expected: { projectId: 'sha256:project-1', instanceId: 'instance-9' } }), CONTEXT),
    ).toThrowError(expect.objectContaining({ errorCode: 'InstanceMismatch' }));
    expect(() =>
      service.handshake(
        request({ expected: { projectId: 'sha256:project-1', workspaceRoot: 'D:\\elsewhere' } }),
        CONTEXT,
      ),
    ).toThrowError(expect.objectContaining({ errorCode: 'ProjectMismatch' }));
  });

  it('rejects a bootstrap context that does not match this instance/project', () => {
    const { service } = makeService();
    expect(() =>
      service.handshake(request(), { instanceId: 'instance-1', projectId: 'sha256:other' }),
    ).toThrowError(expect.objectContaining({ errorCode: 'ProjectMismatch' }));
    expect(() =>
      service.handshake(request(), { instanceId: 'instance-9', projectId: 'sha256:project-1' }),
    ).toThrowError(expect.objectContaining({ errorCode: 'InstanceMismatch' }));
  });

  it('matches workspaceRoot case-insensitively on Windows and allows subpaths', () => {
    const { service } = makeService();
    expect(
      service.handshake(request({ expected: { projectId: 'sha256:project-1', workspaceRoot: 'c:\\WORK\\robot' } }), CONTEXT)
        .connectionId,
    ).toMatch(/^conn_/);
    expect(
      service.handshake(request({ expected: { projectId: 'sha256:project-1', workspaceRoot: 'C:\\work\\robot\\src' } }), CONTEXT)
        .connectionId,
    ).toMatch(/^conn_/);
  });

  it('is case-sensitive for workspaceRoot on POSIX', () => {
    const { service } = makeService({ platform: 'linux' });
    expect(() =>
      service.handshake(request({ expected: { projectId: 'sha256:project-1', workspaceRoot: 'c:\\WORK\\robot' } }), CONTEXT),
    ).toThrowError(expect.objectContaining({ errorCode: 'ProjectMismatch' }));
  });

  it('enforces the per-instance connection cap and frees slots on close', () => {
    const { service } = makeService({ maxConnections: 2 });
    service.handshake(request(), CONTEXT);
    service.handshake(request(), CONTEXT);
    expect(() => service.handshake(request(), CONTEXT)).toThrowError(expect.objectContaining({ errorCode: 'RateLimited' }));
    const [connectionId] = [...service.connections()];
    service.close(connectionId);
    expect(service.handshake(request(), CONTEXT).connectionId).toMatch(/^conn_/);
  });
});

describe('HandshakeService lease lifecycle', () => {
  it('authorizes a granted scope and rejects missing or unknown connections', () => {
    const { service } = makeService();
    const { connectionId } = service.handshake(request({ requestedScopes: ['read', 'view.write'] }), CONTEXT);

    const lease = service.authorize(connectionId, 'view.write');
    expect(lease.connectionId).toBe(connectionId);
    expect([...lease.scopes]).toEqual(['read', 'view.write']);

    expect(() => service.authorize(connectionId, 'flash')).toThrowError(
      expect.objectContaining({ errorCode: 'Unauthorized' }),
    );
    expect(() => service.authorize('conn_missing', 'read')).toThrowError(
      expect.objectContaining({ errorCode: 'ConnectionExpired' }),
    );
  });

  it('expires an idle lease after ten minutes and removes it', () => {
    const { service, advance } = makeService();
    const { connectionId } = service.handshake(request(), CONTEXT);
    advance(10 * 60_000 + 1);
    expect(() => service.authorize(connectionId, 'read')).toThrowError(
      expect.objectContaining({ errorCode: 'ConnectionExpired' }),
    );
    expect(service.get(connectionId)).toBeUndefined();
  });

  it('renews the lease on touch so active connections stay alive', () => {
    const { service, advance } = makeService();
    const { connectionId } = service.handshake(request(), CONTEXT);
    advance(5 * 60_000);
    service.touch(connectionId);
    advance(6 * 60_000); // 11 minutes after handshake, 6 minutes after touch
    expect(service.authorize(connectionId, 'read').connectionId).toBe(connectionId);
    advance(5 * 60_000); // 11 minutes after touch
    expect(() => service.authorize(connectionId, 'read')).toThrowError(
      expect.objectContaining({ errorCode: 'ConnectionExpired' }),
    );
  });

  it('close reports whether the connection existed and releases state', () => {
    const { service } = makeService();
    const { connectionId } = service.handshake(request(), CONTEXT);
    expect(service.close(connectionId)).toEqual({ connectionId, closed: true, releasedSubscriptions: 0 });
    expect(service.close(connectionId)).toEqual({ connectionId, closed: false, releasedSubscriptions: 0 });
    expect(service.get(connectionId)).toBeUndefined();
  });

  it('closeAll drops every lease', () => {
    const { service } = makeService();
    const first = service.handshake(request(), CONTEXT);
    service.handshake(request(), CONTEXT);
    service.closeAll();
    expect(service.get(first.connectionId)).toBeUndefined();
    expect(() => service.authorize(first.connectionId, 'read')).toThrowError(
      expect.objectContaining({ errorCode: 'ConnectionExpired' }),
    );
  });

  it('produces AutomationError instances with retryable=false', () => {
    const { service } = makeService();
    try {
      service.handshake(request({ apiVersion: '9.9' }), CONTEXT);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AutomationError);
      expect((error as AutomationError).retryable).toBe(false);
    }
  });
});
