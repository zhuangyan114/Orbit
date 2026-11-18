import { afterEach, describe, expect, it, vi } from 'vitest';
import { DapSession } from './dap-session';

describe('DapSession orbitRttTransport & Stage 3.4 coordinator integration', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function createSessionHarness() {
    const ch0 = [Buffer.from('\x1b[32mhello\x1b[0m '), Buffer.from('world\n')];
    const ch1Raw = new Uint8Array([0x00, 0x80, 0xff, 0x1b, 0x5b, 0x32, 0x4a, 0x0d, 0x0a, 0x42]);
    const ch1Queue: Uint8Array[] = [ch1Raw];
    let controlStepCount = 0;

    const capabilities = {
      ownerKind: 'cmsis-dap' as const,
      rttStart: { available: true, evidence: 'offline' as const },
      rttEnumerate: { available: true, evidence: 'offline' as const },
      rttUpRead: { available: true, evidence: 'offline' as const },
      rttDownWrite: { available: true, evidence: 'offline' as const },
    };

    const enumResult = {
      controlBlockAddress: 0x20000100,
      maxUpBuffers: 2,
      maxDownBuffers: 1,
      upBuffers: [
        { direction: 'up', index: 0, configured: true, valid: true, status: 'valid', name: 'Terminal', nameStatus: 'ok', duplicateName: false, bufferAddress: 0x20001000, bufferSize: 1024, wrOff: 0, rdOff: 0, flags: 0, mode: 0 },
        { direction: 'up', index: 1, configured: true, valid: true, status: 'valid', name: 'SysView', nameStatus: 'ok', duplicateName: false, bufferAddress: 0x20001400, bufferSize: 1024, wrOff: 10, rdOff: 0, flags: 0, mode: 0 },
      ],
      downBuffers: [
        { direction: 'down', index: 0, configured: true, valid: true, status: 'valid', name: 'SysView', nameStatus: 'ok', duplicateName: false, bufferAddress: 0x20001800, bufferSize: 64, wrOff: 0, rdOff: 0, flags: 0, mode: 0 },
      ],
      duplicateUpNames: [] as string[],
      duplicateDownNames: [] as string[],
      validUpCount: 2,
      validDownCount: 1,
      corruptCount: 0,
      unusedCount: 0,
    };

    const writePayloads: Buffer[] = [];
    const readCommands: Array<{ bufferIndex: number; size: number }> = [];
    let stopRttCalls = 0;

    const backend = {
      execute: vi.fn(async (command: any) => {
        if (command.cmd === 'connect') return { ok: true, data: { state: 'Connected' } };
        if (command.cmd === 'loadSymbols') return { ok: true, data: 'symbols loaded' };
        if (command.cmd === 'resolveSymbol') return { ok: true, data: { address: 0x20000100, size: 0x50, type: 'B' } };
        if (command.cmd === 'getRttCapabilities') return { ok: true, data: capabilities };
        if (command.cmd === 'enumerateRtt') return { ok: true, data: enumResult };
        if (command.cmd === 'startRtt') return { ok: true, data: {} };
        if (command.cmd === 'stopRtt') {
          stopRttCalls++;
          return { ok: true, data: {} };
        }
        if (command.cmd === 'readRtt') {
          const bufferIndex = command.bufferIndex ?? 0;
          readCommands.push({ bufferIndex, size: command.size ?? 0 });
          if (bufferIndex === 0) {
            const next = ch0.shift();
            return { ok: true, data: { bytes: next ? Uint8Array.from(next) : new Uint8Array(0), rdOff: 0, wrOff: 0, bufferSize: 1024 } };
          }
          if (bufferIndex === 1) {
            const next = ch1Queue.shift();
            if (next) {
              return { ok: true, data: { bytes: next, rdOff: 0, wrOff: next.length, committedRdOff: next.length, bufferSize: 1024 } };
            }
            return { ok: true, data: { bytes: new Uint8Array(0), rdOff: 12, wrOff: 12, bufferSize: 1024 } };
          }
        }
        if (command.cmd === 'writeRtt') {
          writePayloads.push(Buffer.from(command.bytes));
          return {
            ok: true,
            data: {
              bufferIndex: command.bufferIndex,
              mode: 0,
              requestedBytes: command.bytes.length,
              writtenBytes: command.bytes.length,
              committedBytes: command.bytes.length,
              wrOff: 0,
              rdOff: 0,
              bufferSize: 64,
              wrapped: false,
              shortWrite: false,
              wrOffWriteAttempted: true,
              wrOffCommitted: true,
              firstSegmentWritten: true,
              secondSegmentWritten: false,
              completion: 'completed',
              failureStage: 'none',
            },
          };
        }
        if (command.cmd === 'halt') {
          controlStepCount++;
          return { ok: true, data: { state: 'Halted' } };
        }
        if (command.cmd === 'getTargetState') return { ok: true, data: 'running' };
        if (command.cmd === 'disconnect') return { ok: true, data: {} };
        return { ok: true, data: {} };
      }),
      configureNativeSteps: vi.fn(),
      dispose: vi.fn(),
    };

    const messages: any[] = [];
    const session = new DapSession(backend as any);
    session.on('send', msg => messages.push(msg));
    (session as any).rttPollIntervalMs = 10;
    (session as any).rttLogEnabled = true;
    (session as any).rttLogStripAnsi = true;
    (session as any).pRtLogEnabled = false;
    (session as any).rttControlBlockAddress = 0x20000100;

    let seq = 10;
    const request = async (command: string, args: Record<string, unknown>) => {
      const mySeq = ++seq;
      await (session as any).handleRequest({
        type: 'request',
        seq: mySeq,
        command,
        arguments: args,
      });
      return [...messages].reverse().find(m => m.type === 'response' && m.request_seq === mySeq);
    };

    return {
      session,
      backend,
      messages,
      request,
      ch1Raw,
      pushCh1: (bytes: Uint8Array) => ch1Queue.push(bytes),
      writePayloads,
      readCommands,
      getStopRttCalls: () => stopRttCalls,
      getControlStepCount: () => controlStepCount,
      setEnumDuplicate: () => {
        enumResult.duplicateUpNames = ['SysView'];
      },
    };
  }

  it('interleaves channel 0 text log and channel 1 SysView raw binary bytes without cross-contaminating decoders', async () => {
    vi.useFakeTimers();
    const h = createSessionHarness();

    try {
      const capsRes = await h.request('orbitRttTransport', { action: 'capabilities' });
      expect(capsRes.success).toBe(true);
      expect(capsRes.body.rttCapabilities.rttEnumerate.available).toBe(true);

      // Start legacy RTT text log polling on ch 0 AND binary SysView subscription by name on ch 1.
      (h.session as any).startRttLogPolling();

      const subRes = await h.request('orbitRttTransport', {
        action: 'subscribe',
        consumerId: 'sysview-binary',
        channelName: 'SysView',
        deliveryKind: 'binary',
        deliveryMode: 'callback',
        pollIntervalMs: 10,
      });
      expect(subRes.success).toBe(true);
      expect(subRes.body.bufferIndex).toBe(1);
      expect(subRes.body.channelName).toBe('SysView');

      await vi.advanceTimersByTimeAsync(12);
      await vi.advanceTimersByTimeAsync(12);

      // Text log output delivered interleaved channel 0 chunks cleanly via ozoneRttOutput.
      const textEvents = h.messages.filter(m => m.event === 'ozoneRttOutput').map(m => m.body.text);
      expect(textEvents.join('')).toBe('\x1b[32mhello\x1b[0m world\n');

      // Binary SysView stream kept exact untouched bytes (including NUL, 0x80, 0xFF, ESC [2J, CRLF).
      const binaryEvents = h.messages.filter(m => m.event === 'orbitRttData' && m.body.consumerId === 'sysview-binary');
      expect(binaryEvents.length).toBeGreaterThanOrEqual(1);
      expect(Uint8Array.from(Buffer.from(binaryEvents[0].body.dataBase64, 'base64'))).toEqual(h.ch1Raw);

      // Down write by channelName passes through control gate and writes exact payload.
      const writeRes = await h.request('orbitRttTransport', {
        action: 'writeDown',
        channelName: 'SysView',
        dataBase64: Buffer.from([0x01, 0xfe, 0x00]).toString('base64'),
      });
      expect(writeRes.success).toBe(true);
      expect(h.writePayloads[0]).toEqual(Buffer.from([0x01, 0xfe, 0x00]));

      // Unsubscribe binary consumer with drainLastBatch preserves text ch 0 and returns final batch.
      h.pushCh1(new Uint8Array([0xee, 0xdd]));
      const unsubRes = await h.request('orbitRttTransport', {
        action: 'unsubscribe',
        consumerId: 'sysview-binary',
        bufferIndex: 1,
        drainLastBatch: true,
      });
      expect(unsubRes.success).toBe(true);
      expect(Uint8Array.from(Buffer.from(unsubRes.body.drainedBatch.dataBase64, 'base64'))).toEqual(new Uint8Array([0xee, 0xdd]));
      expect(unsubRes.body.drainedBatch.isFinal).toBe(true);

      // Disconnect stops remaining ch 0 coordinator cleanly without issuing new RTT reads.
      const readsBeforeDisconnect = h.readCommands.length;
      await h.request('disconnect', {});
      expect(h.backend.execute).toHaveBeenCalledWith({ cmd: 'disconnect' });
      await vi.advanceTimersByTimeAsync(50);
      expect(h.readCommands.length).toBe(readsBeforeDisconnect);

      const postTermRes = await h.request('orbitRttTransport', { action: 'status' });
      expect(postTermRes.success).toBe(false);
      expect(postTermRes.message).toBe('Debug session is terminating');
    } finally {
      (h.session as any).stopRttLogPolling();
    }
  });

  it('rejects duplicate descriptor names and enforces XR Timeline conflict vs host-polled fallback', async () => {
    vi.useFakeTimers();
    const h = createSessionHarness();

    try {
      // Simulate XR active sampling via probe stream.
      (h.session as any).probeSampler = { active: true };
      (h.session as any).dataSamplingActive = true;
      (h.session as any).dataSamplingSource = 'probe';

      const conflict = await h.request('orbitRttTransport', {
        action: 'subscribe',
        consumerId: 'strict-sysview',
        channelName: 'SysView',
        deliveryKind: 'binary',
        conflictPolicy: 'reject-on-xr',
      });
      expect(conflict.success).toBe(false);
      expect(conflict.body.errorCode).toBe('SamplingConflict');

      (h.session as any).probeSampler = null;
      (h.session as any).dataSamplingActive = false;
      (h.session as any).dataSamplingSource = 'host';

      h.setEnumDuplicate();
      const dup = await h.request('orbitRttTransport', {
        action: 'resolveChannel',
        direction: 'up',
        channelName: 'SysView',
      });
      expect(dup.success).toBe(false);
      expect(dup.body.errorCode).toBe('RttDuplicateChannelName');
    } finally {
      (h.session as any).stopRttLogPolling();
    }
  });

  it('validates all JSON request types/bounds/enums/ranges/addresses and rejects conflicting controlBlockAddress without mutating state', async () => {
    vi.useFakeTimers();
    const h = createSessionHarness();
    (h.session as any).rttControlBlockAddress = undefined;

    try {
      const badPayloads: Array<Record<string, unknown>> = [
        { action: 'subscribe', consumerId: '', channelIndex: 0, deliveryKind: 'binary' },
        { action: 'subscribe', consumerId: 'b1', channelIndex: 0, deliveryKind: 'invalid-kind' },
        { action: 'subscribe', consumerId: 'b2', channelIndex: 0, deliveryKind: 'binary', deliveryMode: 'stream' },
        { action: 'subscribe', consumerId: 'b3', channelIndex: 0, deliveryKind: 'binary', backpressurePolicy: 'unknown' },
        { action: 'subscribe', consumerId: 'b4', channelIndex: 0, deliveryKind: 'binary', conflictPolicy: 'ignore-xr' },
        { action: 'subscribe', consumerId: 'b5', channelIndex: 0, deliveryKind: 'binary', maxQueueBytes: 'invalid', maxQueueBatches: 'invalid' },
        { action: 'subscribe', consumerId: 'b6', channelIndex: 0, deliveryKind: 'binary', maxBatchBytes: 0, pollIntervalMs: -5 },
        { action: 'subscribe', consumerId: 'b7', channelIndex: -1, deliveryKind: 'binary' },
        { action: 'subscribe', consumerId: 'b8', channelIndex: 0, deliveryKind: 'binary', controlBlockAddress: null },
        { action: 'subscribe', consumerId: 'b9', channelIndex: 0, deliveryKind: 'binary', controlBlockAddress: 0 },
        { action: 'subscribe', consumerId: 'b10', channelIndex: 0, deliveryKind: 'binary', ramRanges: [] },
        { action: 'resolveChannel', direction: 'sideways', channelName: 'SysView' },
        { action: 'writeDown', bufferIndex: 0, dataBase64: '!!!not-base64!!!' },
        { action: 'pull', consumerId: 'x', bufferIndex: 0, maxBytes: 'all' },
        { action: 'setBackpressure', consumerId: 'x', bufferIndex: 0, paused: 'yes' },
      ];
      for (const bad of badPayloads) {
        const res = await h.request('orbitRttTransport', bad);
        expect(res.success).toBe(false);
      }
      // Validation failures must not start RTT reads or mutate active channels.
      expect(h.readCommands).toHaveLength(0);
      const emptyStatus = await h.request('orbitRttTransport', { action: 'status' });
      expect(emptyStatus.body.status.activeChannelCount).toBe(0);

      // Concurrent conflicting controlBlockAddress subscriptions vs identical address deduplication:
      const [sub1, subConflict] = await Promise.all([
        h.request('orbitRttTransport', {
          action: 'subscribe',
          consumerId: 'cb-a',
          channelIndex: 1,
          deliveryKind: 'binary',
          deliveryMode: 'pull',
          controlBlockAddress: 0x20000100,
          pollIntervalMs: 10,
        }),
        h.request('orbitRttTransport', {
          action: 'subscribe',
          consumerId: 'cb-b',
          channelIndex: 1,
          deliveryKind: 'binary',
          deliveryMode: 'pull',
          controlBlockAddress: 0x20000200,
          pollIntervalMs: 10,
        }),
      ]);
      expect(sub1.success).toBe(true);
      expect(subConflict.success).toBe(false);
      expect(subConflict.body.errorCode).toBe('RttControlBlockConflict');

      const dedup = await h.request('orbitRttTransport', {
        action: 'subscribe',
        consumerId: 'cb-a',
        channelIndex: 1,
        deliveryKind: 'binary',
        deliveryMode: 'pull',
        controlBlockAddress: 0x20000100,
      });
      expect(dedup.success).toBe(true);
      expect(dedup.body.deduplicated).toBe(true);
      expect(dedup.body.refCount).toBe(1);

      const status = await h.request('orbitRttTransport', { action: 'status' });
      expect(status.body.status.controlBlockAddress).toBe(0x20000100);
      expect(status.body.status.channels[0].refCount).toBe(1);
    } finally {
      (h.session as any).stopRttLogPolling();
    }
  });

  it('emits VS Code DAP-compliant ErrorResponse envelopes (no string body.error) on writeDown, enumerate, and validation failures', async () => {
    const h = createSessionHarness();
    const simulateVsCodeHandleErrorResponse = (response: any): string => {
      expect(response.success).toBe(false);
      // VS Code RawDebugSession.handleErrorResponse crashes if body.error is a string
      expect(typeof response.body?.error).not.toBe('string');
      if (response.body?.error) {
        expect(typeof response.body.error.format).toBe('string');
        return response.body.error.format.replace(/\{([^}]+)\}/g, (_match: string, key: string) => (
          response.body.error.variables?.[key] ?? `{${key}}`
        ));
      }
      return response.message;
    };

    try {
      h.backend.execute.mockImplementation(async (command: any): Promise<any> => {
        if (command.cmd === 'getRttCapabilities') {
          return {
            ok: true,
            data: {
              ownerKind: 'cmsis-dap',
              rttStart: { available: true, evidence: 'offline' },
              rttEnumerate: { available: true, evidence: 'offline' },
              rttUpRead: { available: true, evidence: 'offline' },
              rttDownWrite: { available: true, evidence: 'offline' },
            },
          };
        }
        if (command.cmd === 'enumerateRtt') {
          return {
            ok: false,
            errorCode: 'ReadTimeout',
            error: 'ReadTimeout: enum exceeded 50 ms deadline',
            diagnostics: { elapsedMs: 50 },
            targetState: 'Running',
            elapsedMs: 50,
          };
        }
        if (command.cmd === 'writeRtt') {
          return {
            ok: false,
            errorCode: 'WriteTimeout',
            error: 'WriteTimeout: commit-wroff timed out',
            targetState: 'Running',
            elapsedMs: 25,
            diagnostics: {
              rtt: {
                controlBlockAddress: 0x20000100,
                bufferIndex: 1,
                completion: 'unknown',
                failureStage: 'commit-wroff',
                committedBytes: 0,
              },
            },
          };
        }
        return { ok: true, data: {} };
      });

      const writeFail = await h.request('orbitRttTransport', {
        action: 'writeDown',
        bufferIndex: 1,
        dataBase64: Buffer.from([0x00, 0xff, 0x80]).toString('base64'),
      });
      const formattedWriteErr = simulateVsCodeHandleErrorResponse(writeFail);
      expect(formattedWriteErr).toContain('WriteTimeout');
      expect(writeFail.body.errorCode).toBe('WriteTimeout');
      expect(writeFail.body.completion).toBe('unknown');
      expect(writeFail.body.failureStage).toBe('commit-wroff');
      expect(writeFail.body.diagnostics?.rtt?.completion).toBe('unknown');
      expect(writeFail.body.diagnostics?.rtt?.committedBytes).toBe(0);

      const enumFail = await h.request('orbitRttTransport', { action: 'enumerate' });
      const formattedEnumErr = simulateVsCodeHandleErrorResponse(enumFail);
      expect(formattedEnumErr).toContain('ReadTimeout');
      expect(enumFail.body.errorCode).toBe('ReadTimeout');
      expect(enumFail.body.diagnostics?.elapsedMs).toBe(50);

      const pullFail = await h.request('orbitRttTransport', { action: 'pull', consumerId: 'missing', bufferIndex: 1 });
      const formattedPullErr = simulateVsCodeHandleErrorResponse(pullFail);
      expect(formattedPullErr).toContain('InvalidRequest');
      expect(pullFail.body.errorCode).toBe('InvalidRequest');
    } finally {
      (h.session as any).stopRttLogPolling();
    }
  });
});
