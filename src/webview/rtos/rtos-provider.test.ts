import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RtosSnapshot } from '../../rtos/model';
import { TraceRecordingCoordinator } from '../../trace/trace-recording-coordinator';
import { TraceWorkerClient } from '../../trace/trace-worker-client';

const vscodeMock = vi.hoisted(() => {
  const listeners = {
    start: new Set<(s: any) => void>(),
    active: new Set<(s: any) => void>(),
    terminate: new Set<(s: any) => void>(),
    customEvent: new Set<(e: any) => void>(),
  };
  return {
    listeners,
    activeDebugSession: undefined as any,
    emitStart(session: any) { listeners.start.forEach(cb => cb(session)); },
    emitActive(session: any) { this.activeDebugSession = session; listeners.active.forEach(cb => cb(session)); },
    emitTerminate(session: any) {
      if (this.activeDebugSession === session) this.activeDebugSession = undefined;
      listeners.terminate.forEach(cb => cb(session));
    },
    emitCustomEvent(event: any) { listeners.customEvent.forEach(cb => cb(event)); },
    reset() {
      this.activeDebugSession = undefined;
      listeners.start.clear();
      listeners.active.clear();
      listeners.terminate.clear();
      listeners.customEvent.clear();
    },
  };
});

vi.mock('vscode', () => ({
  Uri: {
    joinPath: (...parts: any[]) => parts.join('/'),
    file: (fsPath: string) => ({ fsPath }),
  },
  debug: {
    get activeDebugSession() { return vscodeMock.activeDebugSession; },
    onDidStartDebugSession: (cb: any) => { vscodeMock.listeners.start.add(cb); return { dispose: () => vscodeMock.listeners.start.delete(cb) }; },
    onDidChangeActiveDebugSession: (cb: any) => { vscodeMock.listeners.active.add(cb); return { dispose: () => vscodeMock.listeners.active.delete(cb) }; },
    onDidTerminateDebugSession: (cb: any) => { vscodeMock.listeners.terminate.add(cb); return { dispose: () => vscodeMock.listeners.terminate.delete(cb) }; },
    onDidReceiveDebugSessionCustomEvent: (cb: any) => { vscodeMock.listeners.customEvent.add(cb); return { dispose: () => vscodeMock.listeners.customEvent.delete(cb) }; },
  },
}));

import { RtosWebviewProvider } from './rtos-provider';

function makeSnapshot(sessionId: string, sequence: number, taskName = 'worker'): RtosSnapshot {
  return {
    version: 1,
    sessionId,
    sessionGeneration: 1,
    operationGeneration: 1,
    bootGeneration: 1,
    elfSha256: 'abc',
    layoutId: 'layout-1',
    snapshotSequence: sequence,
    startedAt: 1000,
    completedAt: 1010,
    targetState: 'Halted',
    consistency: 'halted-consistent',
    kernel: { name: 'FreeRTOS', version: { available: false, reason: 'none', source: 'DWARF', unit: 'text' }, source: 'DWARF' },
    tasks: [{
      tcbAddress: 0x20001000,
      creationNumber: { available: true, value: '1', source: 'TCB', unit: 'count' },
      identityCertain: true,
      name: { available: true, value: taskName, source: 'TCB', unit: 'text' },
      state: 'running',
      lists: ['ready[1]'],
      listEvidence: 'traversed',
      current: true,
      priority: { available: true, value: 1, source: 'TCB', unit: 'priority' },
      basePriority: { available: true, value: 1, source: 'TCB', unit: 'priority' },
      stack: {
        base: { available: true, value: 0x20002000, source: 'TCB', unit: 'address' },
        end: { available: true, value: 0x200023fc, source: 'TCB', unit: 'address' },
        growthDirection: { available: true, value: 'down', source: 'port', unit: 'enum' },
        wordBytes: { available: true, value: 4, source: 'DWARF', unit: 'bytes' },
        capacityBytes: { available: true, value: 1024, source: 'TCB', unit: 'bytes' },
        watermarkBytes: { available: false, reason: 'Not requested', source: 'Stack fill scan', unit: 'bytes' },
        fillByte: { available: true, value: 0xa5, source: 'port', unit: 'byte' },
        scannedBytes: 0,
        scanComplete: false,
        scanMs: 0,
      },
      runtime: {
        counter: { available: true, value: '10', source: 'TCB', unit: 'counter-ticks' },
        bits: { available: true, value: 32, source: 'DWARF', unit: 'bits' },
        percent: { available: false, reason: 'First interval', source: 'Kernel', unit: 'percent' },
        intervalMs: { available: false, reason: 'No valid interval', source: 'Host', unit: 'ms' },
      },
    }],
    runtimeTotal: { available: true, value: '100', source: 'ulTotalRunTime', unit: 'counter-ticks' },
    runtimeTotalBits: { available: true, value: 32, source: 'DWARF', unit: 'bits' },
    issues: [],
    diagnostics: { bytes: 200, batches: 2, rounds: 2, nodes: 1, coveredLists: ['ready[1]'], queueWaitMs: 0, ioMs: 5, parseMs: 1, totalMs: 10 },
  };
}

function makeCapabilities(sessionId: string) {
  const okCap = { available: true, evidence: 'source' as const };
  return {
    sessionId,
    sessionGeneration: 1,
    operationGeneration: 1,
    bootGeneration: 1,
    elfSha256: 'abc',
    layoutId: 'layout-1',
    capabilities: {
      layout: okCap,
      taskSnapshot: okCap,
      stackBounds: okCap,
      stackWatermark: okCap,
      runtimeCounters: okCap,
      runtimePercent: okCap,
    },
  };
}

function createFakeView() {
  let visible = true;
  let onMsg: ((m: any) => void) | undefined;
  let onVis: (() => void) | undefined;
  let onDispose: (() => void) | undefined;
  const posted: any[] = [];
  const view: any = {
    get visible() { return visible; },
    set visible(v: boolean) { visible = v; },
    webview: {
      options: {},
      html: '',
      cspSource: 'vscode-webview:',
      asWebviewUri: (u: any) => String(u),
      postMessage: vi.fn((msg: any) => { posted.push(msg); return Promise.resolve(true); }),
      onDidReceiveMessage: (cb: any) => { onMsg = cb; return { dispose: () => {} }; },
    },
    onDidChangeVisibility: (cb: any) => { onVis = cb; return { dispose: () => {} }; },
    onDidDispose: (cb: any) => { onDispose = cb; return { dispose: () => {} }; },
    emitMessage: (m: any) => onMsg?.(m),
    setVisible: (v: boolean) => { visible = v; onVis?.(); },
    triggerDispose: () => onDispose?.(),
    posted,
  };
  return view;
}

function createHarness(seed: Record<string, unknown> = {}) {
  const saved = new Map(Object.entries(seed));
  const context = {
    extensionUri: 'file:///ext',
    workspaceState: {
      get: vi.fn((key: string, fallback?: unknown) => saved.has(key) ? saved.get(key) : fallback),
      update: vi.fn((key: string, value: unknown) => { saved.set(key, structuredClone(value)); return Promise.resolve(); }),
    },
  } as any;
  const provider = new RtosWebviewProvider(context);
  return { provider, context, saved };
}

afterEach(() => {
  vscodeMock.reset();
});

describe('RtosWebviewProvider', () => {
  it('renders nonce-scoped CSP HTML and persists view settings across hide and recreate', async () => {
    const { provider, context, saved } = createHarness();
    const view1 = createFakeView();
    provider.resolveWebviewView(view1);
    expect(view1.webview.html).toContain('dist/rtos.js');
    expect(view1.webview.html).toContain("script-src 'nonce-");

    await (provider as any).handleMessage({
      command: 'updateSettings',
      settings: { activePage: 'trace', sortBy: 'cpu', sortDir: 'desc', stateFilter: 'blocked', liveIntervalMs: 200 },
    });
    expect(saved.get('orbitRtosViewSettings')).toMatchObject({
      activePage: 'trace',
      sortBy: 'cpu',
      sortDir: 'desc',
      stateFilter: 'blocked',
      liveIntervalMs: 200,
    });

    view1.triggerDispose();
    const provider2 = new RtosWebviewProvider(context);
    const view2 = createFakeView();
    provider2.resolveWebviewView(view2);
    await (provider2 as any).handleMessage({ command: 'ready' });
    expect(provider2.currentSettings).toMatchObject({
      activePage: 'trace',
      sortBy: 'cpu',
      sortDir: 'desc',
      stateFilter: 'blocked',
      liveIntervalMs: 200,
    });
    provider.dispose();
    provider2.dispose();
  });

  it('isolates sessions by exact identity, drops stale async replies, and ignores late events after switch/termination', async () => {
    let resolveCapsA!: (v: any) => void;
    const sessionA: any = {
      id: 'vscode-a',
      name: 'Board A',
      type: 'orbit',
      configuration: { device: 'STM32H723VGT6' },
      customRequest: vi.fn((cmd: string, args: any) => {
        if (cmd === 'orbitRtosSnapshot' && args.action === 'capabilities') {
          return new Promise(resolve => { resolveCapsA = resolve; });
        }
        return Promise.resolve({ stopped: true });
      }),
    };
    const sessionB: any = {
      id: 'vscode-b',
      name: 'Board B',
      type: 'orbit',
      configuration: { device: 'STM32F407VET6' },
      customRequest: vi.fn(async (_cmd: string, args: any) => {
        if (args.action === 'capabilities') return makeCapabilities('rtos-b');
        if (args.action === 'start') return { started: true, intervalMs: 500 };
        if (args.action === 'refresh') return makeSnapshot('rtos-b', 1, 'taskB');
        return { stopped: true };
      }),
    };

    const { provider } = createHarness();
    const view = createFakeView();
    provider.resolveWebviewView(view);
    vscodeMock.emitActive(sessionA);
    await vi.waitFor(() => expect(resolveCapsA).toBeTypeOf('function'));

    // Switch to B before A resolves capabilities.
    vscodeMock.emitActive(sessionB);
    resolveCapsA(makeCapabilities('rtos-a'));
    await vi.waitFor(() => expect(provider.currentState.snapshot?.sessionId).toBe('rtos-b'));
    expect(provider.currentState.snapshot?.tasks[0].name).toMatchObject({ value: 'taskB' });

    // Enable Live on B and reject stale events from A.
    await (provider as any).handleMessage({ command: 'setLive', enabled: true, intervalMs: 500 });
    expect(provider.currentState.liveActive).toBe(true);
    vscodeMock.emitCustomEvent({ session: sessionA, event: 'orbitRtosSnapshot', body: makeSnapshot('rtos-a', 99, 'staleA') });
    expect(provider.currentState.snapshot?.tasks[0].name).toMatchObject({ value: 'taskB' });

    // Accept valid live event from B, then terminate B and ensure state clears.
    vscodeMock.emitCustomEvent({ session: sessionB, event: 'orbitRtosSnapshot', body: makeSnapshot('rtos-b', 2, 'liveB') });
    expect(provider.currentState.snapshot?.tasks[0].name).toMatchObject({ value: 'liveB' });

    vscodeMock.emitTerminate(sessionB);
    expect(provider.currentState.session.phase).toBe('none');
    expect(provider.currentState.liveActive).toBe(false);
    expect(provider.currentState.snapshot).toBeNull();
    provider.dispose();
  });

  it('pauses Live polling when hidden and resumes when shown without stopping target debugging', async () => {
    const session: any = {
      id: 'vscode-1',
      name: 'Board',
      type: 'orbit',
      configuration: { device: 'STM32H723VGT6' },
      customRequest: vi.fn(async (_cmd: string, args: any) => {
        if (args.action === 'capabilities') return makeCapabilities('rtos-1');
        if (args.action === 'start') return { started: true, intervalMs: 500 };
        if (args.action === 'stop') return { stopped: true };
        return makeSnapshot('rtos-1', 1);
      }),
    };
    const { provider } = createHarness({ orbitRtosViewSettings: { liveEnabled: true, liveIntervalMs: 500 } });
    const view = createFakeView();
    provider.resolveWebviewView(view);
    vscodeMock.emitActive(session);
    await vi.waitFor(() => expect(provider.currentState.liveActive).toBe(true));

    view.setVisible(false);
    expect(provider.currentState.liveActive).toBe(false);
    expect(session.customRequest).toHaveBeenCalledWith('orbitRtosSnapshot', { action: 'stop' });

    view.setVisible(true);
    await vi.waitFor(() => expect(provider.currentState.liveActive).toBe(true));

    // Disposing the view stops polling only.
    view.triggerDispose();
    expect(provider.currentState.liveActive).toBe(false);
    provider.dispose();
  });

  it('surfaces missing DWARF / missing RTOS diagnostics without spinning Live timers', async () => {
    const session: any = {
      id: 'no-dwarf',
      name: 'No DWARF',
      type: 'orbit',
      configuration: { device: 'STM32H723VGT6' },
      customRequest: vi.fn(async (_cmd: string, args: any) => {
        if (args.action === 'capabilities') {
          return {
            version: 1,
            consistency: 'unavailable',
            tasks: [],
            errorCode: 'DwarfUnavailable',
            reason: 'No DWARF type for pxCurrentTCB',
          };
        }
        return {};
      }),
    };
    const { provider } = createHarness({ orbitRtosViewSettings: { liveEnabled: true } });
    const view = createFakeView();
    provider.resolveWebviewView(view);
    vscodeMock.emitActive(session);
    await vi.waitFor(() => expect(provider.currentState.capabilitiesError?.errorCode).toBe('DwarfUnavailable'));
    expect(provider.currentState.liveActive).toBe(false);
    expect(session.customRequest).toHaveBeenCalledTimes(1);
    provider.dispose();
  });

  it('retries once if an explicit stack scan coalesces onto a lightweight in-flight refresh', async () => {
    let calls = 0;
    const session: any = {
      id: 'scan-test',
      name: 'Scan',
      type: 'orbit',
      configuration: { device: 'STM32H723VGT6' },
      customRequest: vi.fn(async (_cmd: string, args: any) => {
        if (args.action === 'capabilities') return makeCapabilities('rtos-scan');
        if (args.action === 'refresh' && args.taskAddresses) {
          calls++;
          const snap = makeSnapshot('rtos-scan', calls);
          if (calls === 2) {
            snap.tasks[0].stack.watermarkBytes = { available: true, value: 320, source: 'scan', unit: 'bytes' };
          }
          return snap;
        }
        return makeSnapshot('rtos-scan', 0);
      }),
    };
    const { provider } = createHarness();
    const view = createFakeView();
    provider.resolveWebviewView(view);
    vscodeMock.emitActive(session);
    await vi.waitFor(() => expect(provider.currentState.snapshot).not.toBeNull());

    await (provider as any).handleMessage({ command: 'scanStack', taskAddresses: [0x20001000] });
    expect(calls).toBe(2);
    expect(provider.currentState.snapshot?.tasks[0].stack.watermarkBytes).toMatchObject({ available: true, value: 320 });
    provider.dispose();
  });

  it('requests on-demand object wait details via inspectObject and passes includeObjectsInLive to Live start', async () => {
    const inspected: any[] = [];
    const session: any = {
      id: 'obj-test',
      name: 'Objects',
      type: 'orbit',
      configuration: { device: 'STM32H723VGT6' },
      customRequest: vi.fn(async (_cmd: string, args: any) => {
        if (args.action === 'capabilities') return makeCapabilities('rtos-obj');
        if (args.action === 'start') return { started: true, intervalMs: args.intervalMs };
        if (args.action === 'stop') return { stopped: true };
        inspected.push(args);
        const snap = makeSnapshot('rtos-obj', inspected.length);
        snap.objects = {
          registryCapacity: 8,
          registryCount: 1,
          globalCount: 0,
          listDiscoveredCount: 0,
          coverageNote: 'ok',
          objects: [{
            address: 0x20005000,
            kind: 'mutex',
            kindSource: 'ucQueueType=1',
            name: { available: true, value: 'busLock', source: 'xQueueRegistry[0]', unit: 'text' },
            discoverySources: ['registry'],
            discoveryNote: 'xQueueRegistry[0]',
            health: 'valid',
            queueNumber: { available: true, value: 1, source: 'Queue_t', unit: 'count' },
            messagesWaiting: { available: true, value: 0, source: 'Queue_t', unit: 'count' },
            length: { available: true, value: 1, source: 'Queue_t', unit: 'count' },
            itemSize: { available: true, value: 0, source: 'Queue_t', unit: 'bytes' },
            staticallyAllocated: { available: true, value: false, source: 'Queue_t', unit: 'boolean' },
            rxLock: { available: true, value: -1, source: 'Queue_t', unit: 'count' },
            txLock: { available: true, value: -1, source: 'Queue_t', unit: 'count' },
            waitingToReceiveCount: { available: true, value: 1, source: 'Queue_t', unit: 'count' },
            waitingToSendCount: { available: true, value: 0, source: 'Queue_t', unit: 'count' },
            waitListEvidence: args.objectAddresses ? 'traversed' : 'summary-only',
          }],
          waitEdges: [],
          waitCycles: [],
          unresolvedWaits: [],
        };
        return snap;
      }),
    };
    const { provider } = createHarness();
    const view = createFakeView();
    provider.resolveWebviewView(view);
    vscodeMock.emitActive(session);
    await vi.waitFor(() => expect(provider.currentState.snapshot?.objects?.objects[0].waitListEvidence).toBe('summary-only'));

    await (provider as any).handleMessage({ command: 'inspectObject', address: 0x20005000 });
    expect(inspected.at(-1)).toMatchObject({
      action: 'refresh',
      includeObjects: true,
      includeWaitDetails: true,
      objectAddresses: [0x20005000],
    });
    expect(provider.currentState.snapshot?.objects?.objects[0].waitListEvidence).toBe('traversed');

    await (provider as any).handleMessage({ command: 'updateSettings', settings: { includeObjectsInLive: true, tasksSubTab: 'objects' } });
    await (provider as any).handleMessage({ command: 'setLive', enabled: true, intervalMs: 500 });
    expect(session.customRequest).toHaveBeenCalledWith('orbitRtosSnapshot', expect.objectContaining({
      action: 'start',
      intervalMs: 500,
      includeObjects: true,
      includeWaitDetails: true,
      includeTimers: true,
      includeHeap: true,
      detailBudgetBytes: 65536,
    }));

    inspected.length = 0;
    await (provider as any).handleMessage({ command: 'inspectTimersHeap' });
    expect(inspected.at(-1)).toMatchObject({
      action: 'refresh',
      includeTimers: true,
      includeHeap: true,
      detailBudgetBytes: 65536,
    });
    provider.dispose();
  });

  it('keeps active Trace recording running on view hide/dispose, isolates session switches, cancels superseded viewport queries, and supports offline save/reopen without a debug session', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-rtos-prov-trace-'));
    const workers: TraceWorkerClient[] = [];
    const coordinator = new TraceRecordingCoordinator({
      storageRoot: path.join(tmpRoot, 'recordings'),
      workerFactory: () => {
        const w = new TraceWorkerClient();
        workers.push(w);
        return w;
      },
    });

    try {
      const sampleBytes = await fs.readFile('scripts/rtos/fixtures/samples/continuous.bin');
      const saved = new Map<string, unknown>();
      const context = {
        extensionUri: 'file:///ext',
        workspaceState: {
          get: vi.fn((key: string, fallback?: unknown) => (saved.has(key) ? saved.get(key) : fallback)),
          update: vi.fn((key: string, value: unknown) => {
            saved.set(key, structuredClone(value));
            return Promise.resolve();
          }),
        },
      } as any;

      const provider = new RtosWebviewProvider(context, coordinator);
      const view = createFakeView();
      provider.resolveWebviewView(view);

      // 1. Offline open works with NO active debug session (session.phase === 'none')
      const seedDir = path.join(tmpRoot, 'seed-rec');
      const seedWorker = workers[0] ?? new TraceWorkerClient();
      if (!workers.includes(seedWorker)) workers.push(seedWorker);
      const createSeed = await seedWorker.createRecording({
        recordingDir: seedDir,
        recordId: 'seed-1',
        identity: { sessionId: 's-seed', sessionGeneration: 1, bootGeneration: 1, recordId: 'seed-1' },
        commitOnEachIngest: true,
      });
      expect(createSeed.ok).toBe(true);
      await seedWorker.ingestChunk({
        recordId: 'seed-1',
        sessionId: 's-seed',
        sessionGeneration: 1,
        batchSequence: 1,
        chunk: sampleBytes,
        flush: true,
      });
      await seedWorker.finishRecording('seed-1', 'seed-done');
      await seedWorker.closeRecording('seed-1');

      await (provider as any).handleMessage({ command: 'traceOpenRecording', recordingDir: seedDir });
      const openedId = provider.currentTraceState.selectedRecordId;
      expect(openedId).toBeTruthy();
      expect(provider.currentTraceState.records[0].source).toBe('offline');
      expect(provider.currentTraceState.records[0].segments.length).toBeGreaterThan(0);

      // Save copy to fresh directory and verify refusal on non-empty directory
      const copyDir = path.join(tmpRoot, 'saved-copy');
      await (provider as any).handleMessage({ command: 'traceSaveRecording', recordId: openedId, targetDir: copyDir });
      expect(provider.currentTraceState.lastActionMessage?.tone).toBe('ok');
      await (provider as any).handleMessage({ command: 'traceSaveRecording', recordId: openedId, targetDir: copyDir });
      expect(provider.currentTraceState.lastActionMessage?.tone).toBe('error');

      // Rapid consecutive viewport queries: older query is aborted/dropped, latest succeeds
      const q1 = (provider as any).handleMessage({
        command: 'traceQueryViewport',
        querySeq: 1,
        recordId: openedId,
        unit: 'relative-ticks',
        scopeKey: '1:1',
        bootGeneration: 1,
        segmentId: 1,
        start: '0',
        end: '1000',
        maxBuckets: 64,
      });
      const q2 = (provider as any).handleMessage({
        command: 'traceQueryViewport',
        querySeq: 2,
        recordId: openedId,
        unit: 'relative-ticks',
        scopeKey: '1:1',
        bootGeneration: 1,
        segmentId: 1,
        start: '0',
        end: '1000',
        maxBuckets: 64,
      });
      await Promise.all([q1, q2]);
      const vpMsgs = view.posted.filter((m: any) => m.command === 'traceViewportResult');
      expect(vpMsgs.length).toBeGreaterThanOrEqual(1);
      expect(vpMsgs[vpMsgs.length - 1].result.querySeq).toBe(2);
      expect(vpMsgs[vpMsgs.length - 1].result.slices.length).toBeGreaterThan(0);

      // 2. Hiding / disposing view MUST NOT stop an active recording in TraceRecordingCoordinator
      const stopSpy = vi.spyOn(coordinator, 'stopRecording');
      const fakeSession: any = {
        id: 'sess-live',
        name: 'Live',
        type: 'orbit',
        configuration: { device: 'STM32H723VGT6' },
        customRequest: vi.fn(async (cmd: string, args: any) => {
          if (cmd === 'orbitRtosSnapshot' && args.action === 'capabilities') {
            return makeCapabilities('sess-live');
          }
          if (cmd === 'orbitRtosSnapshot' && args.action === 'refresh') {
            return makeSnapshot('sess-live', 1);
          }
          return { stopped: true };
        }),
      };
      vscodeMock.emitActive(fakeSession);
      await (provider as any).handleMessage({ command: 'traceInspectTarget' });
      expect(provider.currentTraceState.targetProbe?.ok).toBe(false);

      // View hide & dispose only stop UI timers/queries, never stopRecording
      view.setVisible(false);
      view.triggerDispose();
      expect(stopSpy).not.toHaveBeenCalled();

      // Switch session clears stale target probe while keeping offline records inspectable
      vscodeMock.emitTerminate(fakeSession);
      expect(provider.currentTraceState.targetProbe).toBeNull();
      expect(provider.currentTraceState.records.some(r => r.recordId === openedId)).toBe(true);

      await (provider as any).handleMessage({ command: 'traceCloseRecording', recordId: openedId });
      expect(provider.currentTraceState.records.some(r => r.recordId === openedId)).toBe(false);

      provider.dispose();
    } finally {
      await coordinator.dispose();
      await Promise.all(workers.map(w => w.shutdown('test-end').catch(() => {})));
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });
});
