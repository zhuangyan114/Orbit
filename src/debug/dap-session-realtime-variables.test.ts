import { describe, expect, it } from 'vitest';
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
  it('lets a Watch read run after an in-flight Timeline sample instead of returning a stale placeholder', async () => {
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
