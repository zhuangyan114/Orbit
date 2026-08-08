import { describe, expect, it, vi } from 'vitest';
import { DapSession, DebugProtocolMessage } from './dap-session';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(next => { resolve = next; });
  return { promise, resolve };
}

function request(seq: number, command: string, args: Record<string, unknown> = {}): DebugProtocolMessage {
  return { type: 'request', seq, command, arguments: args };
}

describe('DapSession realtime variable arbitration', () => {
  it('strips Han characters before Watch target reads', async () => {
    const evaluated: string[] = [];
    const backend = {
      async execute(command: any) {
        if (command.cmd === 'prepareFastDataSampling') {
          return { ok: true, data: command.expressions.map((expression: string) => ({ expression, error: 'unsupported' })) };
        }
        if (command.cmd === 'evaluateExpression') {
          evaluated.push(command.expression);
          return { ok: true, data: { expression: command.expression, value: 1, display: '1', hex: '0x1' } };
        }
        throw new Error(`Unexpected command: ${command.cmd}`);
      },
      dispose() {},
    };
    const session = new DapSession(backend as any);

    await (session as any).handleDataSample(request(1, 'dataSample', {
      expressions: ['p6啊', '中文', 'p6,~@"/'],
    }));

    expect(evaluated).toEqual(['p6', 'p6,~@"/']);
  });

  it('does not query target state for forced runtime Watch/Timeline samples', async () => {
    let targetStateQueries = 0;
    const backend = {
      async execute(command: any) {
        if (command.cmd === 'getTargetState') {
          targetStateQueries++;
          return { ok: true, data: 'running' };
        }
        if (command.cmd === 'evaluateExpression') {
          return { ok: true, data: { expression: command.expression, value: 1, display: '1', hex: '0x1' } };
        }
        throw new Error(`Unexpected command: ${command.cmd}`);
      },
      dispose() {},
    };
    const session = new DapSession(backend as any);
    (session as any).setTargetRunning(true);

    await (session as any).handleDataSample(request(1, 'dataSample', { expressions: ['counter'] }));

    expect(targetStateQueries).toBe(0);
  });

  it('does not mask a completed backend Watch error with a stale runtime cache', async () => {
    let reads = 0;
    const backend = {
      async execute(command: any) {
        if (command.cmd !== 'evaluateExpression') throw new Error(`Unexpected command: ${command.cmd}`);
        reads++;
        if (reads === 1) return { ok: true, data: { expression: 'counter', value: 1, display: '1', hex: '0x1' } };
        return { ok: false, error: 'DeviceRemoved', errorCode: 'DeviceRemoved' };
      },
      dispose() {},
    };
    const session = new DapSession(backend as any);

    const first = await (session as any).readWatchExpressions(['counter'], true);
    const second = await (session as any).readWatchExpressions(['counter'], true);

    expect(first).toEqual([expect.objectContaining({ value: 1 })]);
    expect(second).toEqual([expect.objectContaining({ expression: 'counter', error: 'DeviceRemoved' })]);
    expect(second[0]).not.toHaveProperty('value', 1);
  });

  it('preserves the requested expression when backend returns a leaf Watch expression', async () => {
    const backend = {
      async execute(command: any) {
        if (command.cmd === 'evaluateExpression') {
          return {
            ok: true,
            data: {
              expression: 'counter',
              evaluateName: command.expression,
              value: 0x11223344,
              display: '0x11223344 (287454020)',
              hex: '0x11223344',
            },
          };
        }
        throw new Error(`Unexpected command: ${command.cmd}`);
      },
      dispose() {},
    };
    const session = new DapSession(backend as any);
    const sent: DebugProtocolMessage[] = [];
    session.on('send', message => sent.push(message));

    await (session as any).handleDataSample(request(1, 'dataSample', {
      expressions: ['g_dap06_complex.nested.counter'],
    }));

    expect(sent.find(message => message.request_seq === 1)?.body?.results).toEqual([
      expect.objectContaining({
        expression: 'g_dap06_complex.nested.counter',
        evaluateName: 'g_dap06_complex.nested.counter',
        value: 0x11223344,
      }),
    ]);
  });

  it('batches fast scalar Watch reads without replacing expanded expressions', async () => {
    const commands: any[] = [];
    const backend = {
      async execute(command: any) {
        commands.push(command);
        if (command.cmd === 'prepareFastDataSampling') {
          return {
            ok: true,
            data: [
              { expression: 'a', spec: { expression: 'a', address: 0x20000000, size: 4 } },
              { expression: 'b', spec: { expression: 'b', address: 0x20000004, size: 4 } },
            ],
          };
        }
        if (command.cmd === 'readFastDataSampling') {
          return {
            ok: true,
            data: command.specs.map((spec: any, index: number) => ({
              expression: spec.expression,
              value: index + 1,
              display: `${index + 1}`,
              hex: `0x${index + 1}`,
            })),
          };
        }
        if (command.cmd === 'evaluateExpression' && command.expression === 'root') {
          return {
            ok: true,
            data: { expression: 'root', value: 3, display: 'root', hex: '0x3', children: [{ expression: 'child', value: 4 }] },
          };
        }
        throw new Error(`Unexpected command: ${command.cmd}:${command.expression || ''}`);
      },
      dispose() {},
    };
    const session = new DapSession(backend as any);
    (session as any).setTargetRunning(true);

    const results = await (session as any).readWatchExpressions(['a', 'b', 'root'], true, ['root']);

    expect(commands.filter(command => command.cmd === 'readFastDataSampling')).toEqual([
      expect.objectContaining({ cmd: 'readFastDataSampling', priority: 'watch' }),
    ]);
    expect(commands.filter(command => command.cmd === 'evaluateExpression').map(command => command.expression)).toEqual(['root']);
    expect(results).toEqual([
      expect.objectContaining({ expression: 'a', value: 1 }),
      expect.objectContaining({ expression: 'b', value: 2 }),
      expect.objectContaining({ expression: 'root', children: expect.any(Array) }),
    ]);
  });

  it('keeps pointer Watch expressions on the semantic evaluator path', async () => {
    const commands: any[] = [];
    const backend = {
      async execute(command: any) {
        commands.push(command);
        if (command.cmd === 'prepareFastDataSampling') {
          return {
            ok: true,
            data: [
              { expression: 'text', spec: { expression: 'text', address: 0x20000000, size: 4, format: { kind: 'pointer' } } },
              { expression: 'a', spec: { expression: 'a', address: 0x20000004, size: 4, format: { kind: 'base' } } },
              { expression: 'b', spec: { expression: 'b', address: 0x20000008, size: 4, format: { kind: 'base' } } },
            ],
          };
        }
        if (command.cmd === 'readFastDataSampling') {
          return {
            ok: true,
            data: command.specs.map((spec: any, index: number) => ({
              expression: spec.expression,
              value: index + 1,
              display: `${index + 1}`,
              hex: `0x${index + 1}`,
            })),
          };
        }
        if (command.cmd === 'evaluateExpression' && command.expression === 'text') {
          return {
            ok: true,
            data: { expression: 'text', value: 0x20000100, display: '"Orbit"', hex: '0x20000100' },
          };
        }
        throw new Error(`Unexpected command: ${command.cmd}:${command.expression || ''}`);
      },
      dispose() {},
    };
    const session = new DapSession(backend as any);

    const results = await (session as any).readWatchExpressions(['text', 'a', 'b'], true);

    expect(commands.find(command => command.cmd === 'readFastDataSampling')?.specs.map((spec: any) => spec.expression)).toEqual(['a', 'b']);
    expect(commands.filter(command => command.cmd === 'evaluateExpression').map(command => command.expression)).toEqual(['text']);
    expect(results[0]).toMatchObject({ expression: 'text', display: '"Orbit"' });
  });

  it('falls back to ordinary evaluation when one fast Watch item fails', async () => {
    const evaluated: string[] = [];
    const backend = {
      async execute(command: any) {
        if (command.cmd === 'prepareFastDataSampling') {
          return {
            ok: true,
            data: command.expressions.map((expression: string, index: number) => ({
              expression,
              spec: { expression, address: 0x20000000 + index * 4, size: 4, format: { kind: 'base' } },
            })),
          };
        }
        if (command.cmd === 'readFastDataSampling') {
          return {
            ok: true,
            data: [
              { expression: 'a', value: 0, display: '', hex: '', error: 'read failed' },
              { expression: 'b', value: 2, display: '2', hex: '0x2' },
            ],
          };
        }
        if (command.cmd === 'evaluateExpression') {
          evaluated.push(command.expression);
          return { ok: true, data: { expression: command.expression, value: 7, display: '7', hex: '0x7' } };
        }
        throw new Error(`Unexpected command: ${command.cmd}`);
      },
      dispose() {},
    };
    const session = new DapSession(backend as any);

    const results = await (session as any).readWatchExpressions(['a', 'b'], true);

    expect(evaluated).toEqual(['a']);
    expect(results).toEqual([
      expect.objectContaining({ expression: 'a', value: 7 }),
      expect.objectContaining({ expression: 'b', value: 2 }),
    ]);
    expect((session as any).runtimeWatchCache.get('a')).toMatchObject({ value: 7 });
  });

  it('splits Watch batches and lets Timeline read between every slice', async () => {
    const order: string[] = [];
    const forwardedExpanded: string[][] = [];
    let session: DapSession;
    let timelineRead: Promise<boolean> | undefined;
    const backend = {
      async execute(command: any) {
        if (command.cmd === 'getTargetState') return { ok: true, data: 'running' };
        if (command.cmd === 'prepareFastDataSampling') {
          return { ok: true, data: command.expressions.map((expression: string) => ({ expression, error: 'unsupported' })) };
        }
        if (command.cmd === 'evaluateExpression') {
          order.push(`watch:${command.expression}`);
          forwardedExpanded.push(command.expandedExpressions);
          if (command.expression === 'a') {
            setImmediate(() => {
              timelineRead = (session as any).captureFastDataSample();
            });
          }
          return { ok: true, data: { expression: command.expression, value: 1, display: '1', hex: '0x1' } };
        }
        if (command.cmd === 'readFastDataSampling') {
          order.push('timeline');
          return { ok: true, data: [] };
        }
        throw new Error(`Unexpected command: ${command.cmd}`);
      },
      dispose() {},
    };
    session = new DapSession(backend as any);
    const sent: DebugProtocolMessage[] = [];
    session.on('send', message => sent.push(message));
    (session as any).setTargetRunning(true);
    (session as any).dataSamplingSpecs = [{ expression: 'sample', address: 0x20000000, size: 4, format: 'u32' }];

    await (session as any).handleDataSample(request(1, 'dataSample', {
      expressions: ['a', 'b', 'c'],
      expandedExpressions: ['a'],
    }));
    if (timelineRead) await timelineRead;

    expect(order).toEqual(['watch:a', 'timeline', 'watch:b', 'watch:c']);
    expect(forwardedExpanded).toEqual([['a'], ['a'], ['a']]);
    expect(sent.find(message => message.request_seq === 1)?.body?.results).toHaveLength(3);
  });

  it('does not start a new Watch target read while the DAP session is terminating', async () => {
    let evaluateCount = 0;
    const backend = {
      async execute(command: any) {
        if (command.cmd === 'evaluateExpression') evaluateCount++;
        return { ok: true, data: { expression: command.expression, value: 1, display: '1', hex: '0x1' } };
      },
      dispose() {},
    };
    const session = new DapSession(backend as any);
    (session as any).phase = 'terminating';

    const results = await (session as any).readWatchExpressions(['counter'], true);

    expect(evaluateCount).toBe(0);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ expression: 'counter', error: expect.any(String) });
  });

  it('flushes pending Timeline data on the configured send interval without waiting for another target read', async () => {
    vi.useFakeTimers();
    try {
      const backend = { async execute() { throw new Error('No target read is expected'); }, dispose() {} };
      const session = new DapSession(backend as any);
      const sent: DebugProtocolMessage[] = [];
      session.on('send', message => sent.push(message));
      (session as any).dataSamplingActive = true;
      (session as any).dataSamplingSendIntervalMs = 16;
      (session as any).dataSamplingEntries = [{ expression: 'counter', color: '#4EC9B0' }];
      (session as any).dataSamplingPending.set('counter', [{ timestamp: 1, value: 42, display: '42' }]);
      (session as any).dataSamplingLastDisplay.set('counter', '42');

      (session as any).startDataSamplingFlushTimer();
      await vi.advanceTimersByTimeAsync(16);

      expect(sent).toEqual([expect.objectContaining({
        event: 'ozoneDataSamples',
        body: expect.objectContaining({ snapshots: [expect.objectContaining({ data: [{ timestamp: 1, value: 42, display: '42' }] })] }),
      })]);
      (session as any).stopDataSampling();
    } finally {
      vi.useRealTimers();
    }
  });

  it('yields after one rejected Timeline read while a Watch read owns the target', async () => {
    const backend = {
      async execute(command: any) {
        throw new Error(`Timeline must not execute ${command.cmd} while Watch owns the read`);
      },
      dispose() {},
    };
    const session = new DapSession(backend as any);
    (session as any).dataSamplingActive = true;
    (session as any).setTargetRunning(true);
    (session as any).targetReadInProgress = true;
    (session as any).dataSamplingNextSampleMs = 0;
    vi.spyOn(session as any, 'nowMs').mockReturnValue(0);
    const capture = vi.spyOn(session as any, 'captureFastDataSample');
    vi.spyOn(session as any, 'scheduleDataSamplingLoop').mockImplementation(() => {});

    await (session as any).dataSamplingLoop();

    expect(capture).toHaveBeenCalledTimes(1);
    expect((session as any).dataSamplingNextSampleMs).toBe(0.2);
  });

  it('does not access the target or create Timeline points while DAP state is halted', async () => {
    let reads = 0;
    const backend = {
      async execute(command: any) {
        if (command.cmd === 'readFastDataSampling') reads++;
        throw new Error(`Unexpected command: ${command.cmd}`);
      },
      dispose() {},
    };
    const session = new DapSession(backend as any);
    (session as any).dataSamplingSpecs = [{ expression: 'counter', address: 0x20000000, size: 4, format: 'u32' }];
    (session as any).dataSamplingPending.set('counter', []);
    (session as any).setTargetRunning(false);

    await (session as any).captureFastDataSample();

    expect(reads).toBe(0);
    expect((session as any).dataSamplingPending.get('counter')).toEqual([]);
  });

  it('resumes Timeline sampling only after DAP returns to running', async () => {
    let reads = 0;
    const backend = {
      async execute(command: any) {
        if (command.cmd !== 'readFastDataSampling') throw new Error(`Unexpected command: ${command.cmd}`);
        reads++;
        return { ok: true, data: [{ expression: 'counter', value: 42, display: '42', hex: '0x2A' }] };
      },
      dispose() {},
    };
    const session = new DapSession(backend as any);
    (session as any).dataSamplingSpecs = [{ expression: 'counter', address: 0x20000000, size: 4, format: 'u32' }];
    (session as any).dataSamplingPending.set('counter', []);
    (session as any).setTargetRunning(false);

    await (session as any).captureFastDataSample();
    (session as any).setTargetRunning(true);
    await (session as any).captureFastDataSample();

    expect(reads).toBe(1);
    expect((session as any).dataSamplingPending.get('counter')).toEqual([
      expect.objectContaining({ value: 42, display: '42', startsNewSegment: true }),
    ]);
  });

  it('marks only the first valid sample for each expression as a new DAP session segment', async () => {
    const backend = {
      async execute(command: any) {
        if (command.cmd !== 'readFastDataSampling') throw new Error(`Unexpected command: ${command.cmd}`);
        return { ok: true, data: [{ expression: 'counter', value: 42, display: '42', hex: '0x2A' }] };
      },
      dispose() {},
    };
    const session = new DapSession(backend as any);
    (session as any).dataSamplingSpecs = [{ expression: 'counter', address: 0x20000000, size: 4, format: 'u32' }];
    (session as any).dataSamplingPending.set('counter', []);
    (session as any).setTargetRunning(true);

    await (session as any).captureFastDataSample();
    await (session as any).captureFastDataSample();

    const points = (session as any).dataSamplingPending.get('counter');
    expect(points).toHaveLength(2);
    expect(points[0]).toMatchObject({ value: 42, startsNewSegment: true });
    expect(points[1]).not.toHaveProperty('startsNewSegment');
  });

  it('does not advance the Timeline sampling clock while the target is halted', async () => {
    let now = 1000;
    const backend = {
      async execute(command: any) {
        if (command.cmd !== 'readFastDataSampling') throw new Error(`Unexpected command: ${command.cmd}`);
        return { ok: true, data: [{ expression: 'counter', value: 42, display: '42', hex: '0x2A' }] };
      },
      dispose() {},
    };
    const session = new DapSession(backend as any);
    vi.spyOn(session as any, 'nowMs').mockImplementation(() => now);
    (session as any).dataSamplingSpecs = [{ expression: 'counter', address: 0x20000000, size: 4, format: 'u32' }];
    (session as any).dataSamplingPending.set('counter', []);
    (session as any).setTargetRunning(true);

    await (session as any).captureFastDataSample();
    now = 1100;
    (session as any).setTargetRunning(false);
    now = 5100;
    (session as any).setTargetRunning(true);
    now = 5200;
    await (session as any).captureFastDataSample();

    expect((session as any).dataSamplingPending.get('counter').map((point: any) => point.timestamp)).toEqual([
      1000,
      1200,
    ]);
  });

  it('lets a Watch read run after an in-flight Timeline sample and resumes Timeline when that read completes', async () => {
    const sampleGate = deferred<void>();
    const sampleStarted = deferred<void>();
    let evaluateCount = 0;
    const backend = {
      async execute(command: any) {
        if (command.cmd === 'readFastDataSampling') {
          sampleStarted.resolve();
          await sampleGate.promise;
          return { ok: true, data: [] };
        }
        if (command.cmd === 'getTargetState') return { ok: true, data: 'running' };
        if (command.cmd === 'evaluateExpression') {
          evaluateCount++;
          return {
            ok: true,
            data: { expression: command.expression, value: 42, display: '42', hex: '0x2A' },
          };
        }
        throw new Error(`Unexpected command: ${command.cmd}`);
      },
      dispose() {},
    };
    const session = new DapSession(backend as any);
    const sent: DebugProtocolMessage[] = [];
    session.on('send', message => sent.push(message));
    (session as any).setTargetRunning(true);
    (session as any).dataSamplingSpecs = [{ expression: 'counter', address: 0x20000000, size: 4, format: 'u32' }];

    const sample = (session as any).captureFastDataSample();
    await sampleStarted.promise;
    const watch = (session as any).handleDataSample(request(10, 'dataSample', { expressions: ['counter'] }));

    await new Promise<void>(resolve => setTimeout(resolve, 5));
    expect(sent.find(message => message.request_seq === 10)).toBeUndefined();

    sampleGate.resolve();
    await sample;
    await watch;

    expect(evaluateCount).toBe(1);
    expect(sent.find(message => message.request_seq === 10)?.body?.results).toEqual([
      expect.objectContaining({ expression: 'counter', value: 42, display: '42' }),
    ]);
    expect((session as any).beginTargetRead('low')).toBe(true);
    (session as any).endTargetRead();
  });

  it('gives built-in DAP Watch evaluate the same priority over Timeline sampling', async () => {
    const sampleGate = deferred<void>();
    const sampleStarted = deferred<void>();
    const backend = {
      async execute(command: any) {
        if (command.cmd === 'readFastDataSampling') {
          sampleStarted.resolve();
          await sampleGate.promise;
          return { ok: true, data: [] };
        }
        if (command.cmd === 'getTargetState') return { ok: true, data: 'halted' };
        if (command.cmd === 'evaluateExpression') {
          return {
            ok: true,
            data: { expression: command.expression, value: 7, display: '7', hex: '0x7' },
          };
        }
        throw new Error(`Unexpected command: ${command.cmd}`);
      },
      dispose() {},
    };
    const session = new DapSession(backend as any);
    const sent: DebugProtocolMessage[] = [];
    session.on('send', message => sent.push(message));
    (session as any).setTargetRunning(true);
    (session as any).dataSamplingSpecs = [{ expression: 'counter', address: 0x20000000, size: 4, format: 'u32' }];

    const sample = (session as any).captureFastDataSample();
    await sampleStarted.promise;
    const evaluate = (session as any).handleEvaluate(request(11, 'evaluate', {
      expression: 'counter',
      context: 'watch',
    }));

    await new Promise<void>(resolve => setTimeout(resolve, 5));
    expect(sent.find(message => message.request_seq === 11)).toBeUndefined();

    sampleGate.resolve();
    await sample;
    await evaluate;

    expect(sent.find(message => message.request_seq === 11)?.body).toMatchObject({ result: '7' });
  });

  it('drains an in-flight timeline sample and prevents new samples from starving setWatchValue', async () => {
    const sampleGate = deferred<void>();
    const sampleStarted = deferred<void>();
    const writeGate = deferred<void>();
    const writeStarted = deferred<void>();
    let sampleCount = 0;
    const backend = {
      async execute(command: any) {
        if (command.cmd === 'readFastDataSampling') {
          sampleCount++;
          if (sampleCount === 1) {
            sampleStarted.resolve();
            await sampleGate.promise;
          }
          return { ok: true, data: [] };
        }
        if (command.cmd === 'setWatchValue') {
          writeStarted.resolve();
          await writeGate.promise;
          return { ok: true, data: { expression: command.expression, value: command.value } };
        }
        throw new Error(`Unexpected command: ${command.cmd}`);
      },
      dispose() {},
    };
    const session = new DapSession(backend as any);
    const responses: DebugProtocolMessage[] = [];
    session.on('send', message => responses.push(message));
    (session as any).setTargetRunning(true);
    (session as any).dataSamplingEntries = [{ expression: 'counter', color: '#4EC9B0' }];
    (session as any).dataSamplingSpecs = [{ expression: 'counter', address: 0x20000000, size: 4, format: 'u32' }];
    (session as any).dataSamplingPending.set('counter', [{ timestamp: 1, value: 41, display: '41' }]);
    (session as any).dataSamplingLastDisplay.set('counter', '41');

    const firstSample = (session as any).captureFastDataSample();
    await sampleStarted.promise;
    const write = (session as any).handleSetWatchValue(request(1, 'setWatchValue', {
      expression: 'counter',
      value: 42,
    }));

    await new Promise<void>(resolve => setTimeout(resolve, 5));
    expect(responses).toHaveLength(0);
    expect(sampleCount).toBe(1);

    sampleGate.resolve();
    await firstSample;
    await writeStarted.promise;

    await (session as any).captureFastDataSample();
    expect(sampleCount).toBe(1);

    writeGate.resolve();
    await write;
    expect(responses.at(-1)?.body).toMatchObject({ ok: true });
    expect(responses.map(message => message.event || message.command)).toEqual([
      'ozoneDataSamples',
      'setWatchValue',
    ]);

    await (session as any).captureFastDataSample();
    expect(sampleCount).toBe(2);
  });

  it('waits for an in-flight sample before step and serves cached UI data while sampling is paused', async () => {
    const sampleGate = deferred<void>();
    const sampleStarted = deferred<void>();
    const stepGate = deferred<void>();
    const stepStarted = deferred<void>();
    let sampleCount = 0;
    const backend = {
      async execute(command: any) {
        switch (command.cmd) {
          case 'readFastDataSampling':
            sampleCount++;
            sampleStarted.resolve();
            await sampleGate.promise;
            return { ok: true, data: [] };
          case 'readRegister':
            return { ok: true, data: { value: 0x08000100 } };
          case 'stepOver':
            stepStarted.resolve();
            await stepGate.promise;
            return { ok: true, data: 'stepped' };
          case 'getTargetState':
            return { ok: true, data: 'halted' };
          default:
            throw new Error(`Unexpected command: ${command.cmd}`);
        }
      },
      dispose() {},
    };
    const session = new DapSession(backend as any);
    const sent: DebugProtocolMessage[] = [];
    session.on('send', message => sent.push(message));
    (session as any).setTargetRunning(true);
    (session as any).dataSamplingSpecs = [{ expression: 'counter', address: 0x20000000, size: 4, format: 'u32' }];

    const sample = (session as any).captureFastDataSample();
    await sampleStarted.promise;
    const step = (session as any).handleStep(request(2, 'next'), 'stepOver');

    await new Promise<void>(resolve => setTimeout(resolve, 5));
    expect(sent).toHaveLength(0);

    sampleGate.resolve();
    await sample;
    await stepStarted.promise;

    await (session as any).captureFastDataSample();
    expect(sampleCount).toBe(1);

    await (session as any).handleDataSample(request(3, 'dataSample', { expressions: ['counter'] }));
    const dataResponse = sent.find(message => message.request_seq === 3);
    expect(dataResponse?.body?.results).toEqual([
      expect.objectContaining({ expression: 'counter', error: 'running' }),
    ]);

    stepGate.resolve();
    await step;
    expect(sent.find(message => message.request_seq === 2)?.success).toBe(true);
    expect(sent.some(message => message.event === 'stopped')).toBe(true);
  });
});
