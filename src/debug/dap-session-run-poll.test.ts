import { afterEach, describe, expect, it, vi } from 'vitest';
import { OzoneBackend } from '../ozone-backend/commander';
import { TargetState } from '../ozone-backend/types';
import { DapSession, DebugProtocolMessage } from './dap-session';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(next => { resolve = next; });
  return { promise, resolve };
}

function fixture(writeOutcome: 'success' | 'failure' | 'throw' = 'success', resume = true) {
  let state = TargetState.Running;
  const writeStarted = deferred<void>();
  const writeFinished = deferred<void>();
  const backend = new OzoneBackend();
  const target = backend as any;
  target.targetIsHalted = vi.fn(async () => state === TargetState.Halted);
  target.ensureHalted = vi.fn(async () => { state = TargetState.Halted; return true; });
  target.targetWriteMemory = vi.fn(async () => {
    writeStarted.resolve();
    await writeFinished.promise;
    if (writeOutcome === 'throw') throw new Error('injected RAM write failure');
    return writeOutcome === 'success';
  });
  target.targetRun = vi.fn(async () => {
    if (resume) state = TargetState.Running;
    return resume;
  });
  const queryState = vi.fn(async (): Promise<any> => ({ ok: true, data: state }));
  const execute = backend.execute.bind(backend);
  vi.spyOn(backend, 'execute').mockImplementation(async command => {
    switch (command.cmd) {
      case 'setWatchValue': return execute(command);
      case 'getTargetState': return queryState();
      case 'readFastDataSampling':
      case 'evaluateExpression':
        const value = { expression: 'counter', value: 42, display: '42', hex: '0x2A' };
        return { ok: true, data: command.cmd === 'evaluateExpression' ? value : [value] };
      default: throw new Error(`Unexpected command: ${command.cmd}`);
    }
  });
  const session = new DapSession(backend);
  const internal = session as any;
  internal.phase = 'connected';
  internal.targetConnectionEstablished = true;
  internal.setTargetRunning(true);
  internal.lastHaltReason = 'breakpoint';
  internal.dataSamplingSpecs = [{ expression: 'counter', address: 0x20001024, size: 4, format: 'u32' }];
  internal.dataSamplingPending.set('counter', []);
  const messages: DebugProtocolMessage[] = [];
  session.on('send', message => messages.push(message));
  return {
    internal, messages, queryState, writeStarted, writeFinished,
    get state() { return state; },
    halt() { state = TargetState.Halted; },
    write() {
      return internal.handleSetWatchValue({
        type: 'request', seq: 1, command: 'setWatchValue',
        arguments: { expression: 'counter', value: 42, address: 0x20001024, typeName: 'uint32_t' },
      });
    },
  };
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('DapSession run-state polling across Watch writes', () => {
  it.each(['success', 'failure', 'throw'] as const)(
    'keeps the UI and Timeline running after a temporary write halt (%s)', async outcome => {
      vi.useFakeTimers();
      const f = fixture(outcome);
      f.internal.startPolling();
      const write = f.write();
      await f.writeStarted.promise;
      expect(f.state).toBe(TargetState.Halted);

      // Place the 200 ms run poll inside the real backend's halt/write/run path.
      await vi.advanceTimersByTimeAsync(200);
      f.writeFinished.resolve();
      await write;
      const watches = await f.internal.readWatchExpressions(['counter'], true);
      await f.internal.captureFastDataSample();

      expect({
        target: f.state,
        uiRunning: f.internal.targetRunning,
        stoppedEvents: f.messages.filter(message => message.event === 'stopped').length,
        watchValue: watches[0]?.value,
        timelineValues: f.internal.dataSamplingPending.get('counter').map((point: any) => point.value),
      }).toEqual({
        target: TargetState.Running, uiRunning: true, stoppedEvents: 0, watchValue: 42, timelineValues: [42],
      });
      expect(f.messages.find(message => message.request_seq === 1)?.body.ok).toBe(outcome === 'success');
      expect(f.queryState).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(200);
      expect(f.queryState).toHaveBeenCalledOnce();
      expect(f.internal.pollTimer).not.toBeNull();
    },
  );

  it.each(['during', 'after'] as const)(
    'discards an in-flight halt reply delivered %s the write', async delivery => {
      vi.useFakeTimers();
      const f = fixture();
      const reply = deferred<any>();
      f.queryState.mockImplementationOnce(() => reply.promise);
      f.internal.startPolling();
      await vi.advanceTimersByTimeAsync(200);
      expect(f.queryState).toHaveBeenCalledOnce();
      const write = f.write();
      await f.writeStarted.promise;
      if (delivery === 'after') {
        f.writeFinished.resolve();
        await write;
      }
      reply.resolve({ ok: true, data: TargetState.Halted });
      await vi.advanceTimersByTimeAsync(0);
      if (delivery === 'during') {
        f.writeFinished.resolve();
        await write;
      }

      expect(f.internal.targetRunning).toBe(true);
      expect(f.messages.filter(message => message.event === 'stopped')).toEqual([]);
      await vi.advanceTimersByTimeAsync(200);
      expect(f.queryState).toHaveBeenCalledTimes(2);
      expect(f.internal.pollTimer).not.toBeNull();
    },
  );

  it.each((['stop', 'restart', 'dispose'] as const).flatMap(action =>
    [TargetState.Halted, TargetState.Running].map(state => ({ action, state })),
  ))(
    'ignores a late $state reply from an old poll after $action', async ({ action, state }) => {
      vi.useFakeTimers();
      const f = fixture();
      const reply = deferred<any>();
      f.queryState.mockImplementationOnce(() => reply.promise);
      f.internal.startPolling();
      await vi.advanceTimersByTimeAsync(200);
      if (action === 'dispose') await f.internal.dispose();
      else if (action === 'restart') f.internal.startPolling();
      else f.internal.stopPolling();
      reply.resolve({ ok: true, data: state });
      await vi.advanceTimersByTimeAsync(0);

      expect(f.messages.filter(message => message.event === 'stopped')).toEqual([]);
      if (action === 'restart') {
        await vi.advanceTimersByTimeAsync(400);
        expect(f.queryState).toHaveBeenCalledTimes(3);
        expect(vi.getTimerCount()).toBe(1);
      } else {
        await vi.advanceTimersByTimeAsync(400);
        expect(f.queryState).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
      }
    },
  );

  it.each(['failure', 'throw'] as const)('retries a transient state query %s and still detects a real halt', async outcome => {
    vi.useFakeTimers();
    const f = fixture();
    f.queryState.mockImplementationOnce(async () => {
      if (outcome === 'throw') throw new Error('injected state query failure');
      return { ok: false, error: 'temporary state read failure', errorCode: 'TargetStateReadFailed' };
    });
    f.internal.startPolling();
    await vi.advanceTimersByTimeAsync(200);
    expect(f.internal.targetRunning).toBe(true);
    expect(f.messages.filter(message => message.event === 'stopped')).toEqual([]);
    f.halt();
    await vi.advanceTimersByTimeAsync(200);

    expect(f.queryState).toHaveBeenCalledTimes(2);
    expect(f.internal.targetRunning).toBe(false);
    expect(f.messages.filter(message => message.event === 'stopped')).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('still reports a real breakpoint after a successful write', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.internal.startPolling();
    const write = f.write();
    await f.writeStarted.promise;
    f.writeFinished.resolve();
    await write;
    f.halt();
    await vi.advanceTimersByTimeAsync(200);

    expect(f.messages.filter(message => message.event === 'stopped')).toEqual([
      expect.objectContaining({ body: { reason: 'breakpoint', threadId: 1, allThreadsStopped: true } }),
    ]);
    expect(f.internal.targetRunning).toBe(false);
    expect(f.internal.pollTimer).toBeNull();
    await vi.advanceTimersByTimeAsync(400);
    expect(f.queryState).toHaveBeenCalledOnce();
  });

  it('reports the real halt when the write cannot restore execution', async () => {
    vi.useFakeTimers();
    const f = fixture('success', false);
    f.internal.startPolling();
    const write = f.write();
    await f.writeStarted.promise;
    await vi.advanceTimersByTimeAsync(200);
    expect(f.messages.filter(message => message.event === 'stopped')).toEqual([]);
    f.writeFinished.resolve();
    await write;
    await vi.advanceTimersByTimeAsync(200);

    expect(f.messages.find(message => message.request_seq === 1)?.body).toMatchObject({
      ok: false, errorCode: 'TargetResumeFailed',
    });
    expect(f.state).toBe(TargetState.Halted);
    expect(f.internal.targetRunning).toBe(false);
    expect(f.messages.filter(message => message.event === 'stopped')).toHaveLength(1);
    expect(f.internal.pollTimer).toBeNull();
  });
});
