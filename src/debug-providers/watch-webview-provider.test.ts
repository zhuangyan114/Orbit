import { describe, expect, it, vi } from 'vitest';

const vscodeState = vi.hoisted(() => ({ activeDebugSession: undefined as any }));

vi.mock('vscode', () => ({
  debug: vscodeState,
}));

import { OzoneBackend } from '../ozone-backend/commander';
import { WatchWebviewProvider } from './watch-webview-provider';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(next => { resolve = next; });
  return { promise, resolve };
}

function createProvider(isCurrentSession: (session: any) => boolean) {
  const postMessage = vi.fn();
  const context = {
    workspaceState: {
      get: vi.fn((_key: string, fallback: unknown) => fallback),
      update: vi.fn(),
    },
  } as any;
  const backend = { hasTargetConnection: false, execute: vi.fn() } as unknown as OzoneBackend;
  const provider = new WatchWebviewProvider(context, backend, isCurrentSession);
  (provider as any).view = { webview: { postMessage } };
  return { provider, postMessage };
}

describe('WatchWebviewProvider session fence', () => {
  it('does not publish a dataSample result from a replaced DAP session', async () => {
    const pending = deferred<any>();
    const firstSession = {
      type: 'ozone',
      customRequest: vi.fn(() => pending.promise),
    };
    const secondSession = { type: 'ozone', customRequest: vi.fn() };
    let currentSession: any = firstSession;
    vscodeState.activeDebugSession = firstSession;
    const { provider, postMessage } = createProvider(session => currentSession === session);

    const evaluating = (provider as any).evaluateWatches(['counter']);
    currentSession = secondSession;
    vscodeState.activeDebugSession = secondSession;
    pending.resolve({
      results: [{ expression: 'counter', value: 41, display: '41', hex: '0x29' }],
    });
    await evaluating;

    expect(postMessage).not.toHaveBeenCalled();
  });

  it('does not publish a setWatchValue result from a terminated DAP session', async () => {
    const pending = deferred<any>();
    const session = {
      type: 'ozone',
      customRequest: vi.fn(() => pending.promise),
    };
    let currentSession: any = session;
    vscodeState.activeDebugSession = session;
    const { provider, postMessage } = createProvider(candidate => currentSession === candidate);

    const writing = (provider as any).setWatchValue('counter', 42, 0x20000000, 'uint32_t');
    currentSession = null;
    vscodeState.activeDebugSession = undefined;
    pending.resolve({ ok: true });
    await writing;

    expect(postMessage).not.toHaveBeenCalled();
  });
});
