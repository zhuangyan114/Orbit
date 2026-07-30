import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const vscodeState = vi.hoisted(() => ({
  activeDebugSession: undefined as any,
  timelineDataSource: 'dap' as 'dap' | 'rtt' | 'mixed',
}));
const disposable = { dispose: vi.fn() };

vi.mock('vscode', () => ({
  debug: {
    get activeDebugSession() { return vscodeState.activeDebugSession; },
    onDidChangeActiveDebugSession: vi.fn(() => disposable),
    onDidTerminateDebugSession: vi.fn(() => disposable),
    onDidReceiveDebugSessionCustomEvent: vi.fn(() => disposable),
  },
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn((key: string, defaultValue: unknown) => key === 'timelineDataSource'
        ? vscodeState.timelineDataSource
        : defaultValue),
    })),
    onDidChangeConfiguration: vi.fn(() => disposable),
  },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  Uri: { joinPath: vi.fn() },
}));

import { OzoneBackend } from '../ozone-backend/commander';
import { DataSamplingManager } from './data-sampling-manager';
import { WatchWebviewProvider } from './watch-webview-provider';

describe('runtime view target routing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vscodeState.activeDebugSession = undefined;
    vscodeState.timelineDataSource = 'dap';
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('does not start Timeline local polling while the extension backend is disconnected', async () => {
    const backend = {
      hasTargetConnection: false,
      execute: vi.fn(),
    } as unknown as OzoneBackend;
    const manager = new DataSamplingManager(backend);

    manager.setExpressions(['count']);
    await Promise.resolve();
    await Promise.resolve();
    await vi.runOnlyPendingTimersAsync();

    expect((manager as any).timer).toBeNull();
    expect((manager as any).sendTimer).toBeNull();
    expect(backend.execute).not.toHaveBeenCalled();
    manager.dispose();
  });

  it('keeps Timeline on the active ozone DAP route', async () => {
    const customRequest = vi.fn(async () => ({ ok: true }));
    vscodeState.activeDebugSession = { type: 'ozone', customRequest };
    const backend = {
      hasTargetConnection: false,
      execute: vi.fn(),
    } as unknown as OzoneBackend;
    const manager = new DataSamplingManager(backend);

    manager.setExpressions(['count']);
    await Promise.resolve();
    await Promise.resolve();

    expect(customRequest).toHaveBeenCalledWith('dataSamplingStart', expect.objectContaining({
      entries: [expect.objectContaining({ expression: 'count' })],
    }));
    expect(backend.execute).not.toHaveBeenCalled();
    manager.dispose();
  });

  it('routes an RTT Timeline source through the active ozone DAP session', async () => {
    vscodeState.timelineDataSource = 'rtt';
    const customRequest = vi.fn(async () => ({ ok: true }));
    vscodeState.activeDebugSession = { type: 'ozone', customRequest };
    const backend = {
      hasTargetConnection: false,
      execute: vi.fn(),
    } as unknown as OzoneBackend;
    const manager = new DataSamplingManager(backend);

    manager.setExpressions(['rttb.payload[0]']);
    await Promise.resolve();
    await Promise.resolve();

    expect(customRequest).toHaveBeenCalledWith('dataSamplingStart', expect.objectContaining({
      source: 'rtt',
      entries: [expect.objectContaining({ expression: 'rttb.payload[0]' })],
    }));
    expect(backend.execute).not.toHaveBeenCalled();
    manager.dispose();
  });

  it('does not fall back to extension-host polling when active RTT DAP start fails', async () => {
    vscodeState.timelineDataSource = 'rtt';
    const customRequest = vi.fn(async () => { throw new Error('RTTB source rejected'); });
    vscodeState.activeDebugSession = { type: 'ozone', customRequest };
    const backend = {
      hasTargetConnection: true,
      execute: vi.fn(),
    } as unknown as OzoneBackend;
    const manager = new DataSamplingManager(backend);

    manager.setExpressions(['rttb.payload[0]']);
    await Promise.resolve();
    await Promise.resolve();

    expect(backend.execute).not.toHaveBeenCalled();
    expect((manager as any).timer).toBeNull();
    manager.dispose();
  });

  it('routes mixed Timeline expressions through one active ozone session', async () => {
    vscodeState.timelineDataSource = 'mixed';
    const customRequest = vi.fn(async () => ({ ok: true }));
    vscodeState.activeDebugSession = { type: 'ozone', customRequest };
    const backend = {
      hasTargetConnection: false,
      execute: vi.fn(),
    } as unknown as OzoneBackend;
    const manager = new DataSamplingManager(backend);

    manager.setExpressions(['rttb.payload[1]', 'rtt_bench_attempted_frames']);
    await Promise.resolve();
    await Promise.resolve();

    expect(customRequest).toHaveBeenCalledWith('dataSamplingStart', expect.objectContaining({
      source: 'mixed',
      entries: [
        expect.objectContaining({ expression: 'rttb.payload[1]' }),
        expect.objectContaining({ expression: 'rtt_bench_attempted_frames' }),
      ],
    }));
    expect(backend.execute).not.toHaveBeenCalled();
    manager.dispose();
  });

  it('reports a disconnected Watch without calling the extension backend', async () => {
    const backend = {
      hasTargetConnection: false,
      execute: vi.fn(),
    } as unknown as OzoneBackend;
    const context = {
      workspaceState: { get: vi.fn(() => []), update: vi.fn() },
      extensionUri: {},
    } as any;
    const postMessage = vi.fn();
    const provider = new WatchWebviewProvider(context, backend);
    (provider as any).view = { webview: { postMessage } };

    await (provider as any).evaluateWatches(['count']);

    expect(backend.execute).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith({
      command: 'watchResults',
      results: [expect.objectContaining({ expression: 'count', error: 'No active Orbit debug session' })],
    });
  });

  it('does not send Watch requests through a stale ozone DAP session', async () => {
    const customRequest = vi.fn(async () => ({ results: [] }));
    vscodeState.activeDebugSession = { type: 'ozone', customRequest };
    const backend = {
      hasTargetConnection: true,
      execute: vi.fn(),
    } as unknown as OzoneBackend;
    const context = {
      workspaceState: { get: vi.fn(() => []), update: vi.fn() },
      extensionUri: {},
    } as any;
    const postMessage = vi.fn();
    const provider = new WatchWebviewProvider(context, backend, () => false);
    (provider as any).view = { webview: { postMessage } };

    await (provider as any).evaluateWatches(['count']);

    expect(customRequest).not.toHaveBeenCalled();
    expect(backend.execute).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith({
      command: 'watchResults',
      results: [expect.objectContaining({ expression: 'count', error: 'Debug session is not available' })],
    });
  });

  it('sanitizes Han characters before persisting Watch expressions', () => {
    const backend = {
      hasTargetConnection: false,
      execute: vi.fn(),
    } as unknown as OzoneBackend;
    const context = {
      workspaceState: { get: vi.fn(() => []), update: vi.fn() },
      extensionUri: {},
    } as any;
    const provider = new WatchWebviewProvider(context, backend);

    provider.addExpression('p6啊');
    provider.addExpression('p6,~@"/');

    expect(provider.expressionList).toEqual(['p6', 'p6,~@"/']);
  });
});
