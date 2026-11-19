import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DapSession, DebugProtocolMessage } from '../debug/dap-session';
import { SeggerRttMemoryEngine } from '../ozone-backend/segger-rtt-memory';
import type { SymbolCatalog } from '../symbols/symbol-catalog';
import { SYSTEMVIEW_COMMAND_IDS, SYSTEMVIEW_EVENT_IDS } from './systemview-protocol';
import {
  TraceRecordingCoordinator,
  TraceSessionHandle,
  TraceWorkerClientLike,
} from './trace-recording-coordinator';
import { TraceWorkerClient } from './trace-worker-client';

const tempDirs: string[] = [];
const coordinatorsToDispose: TraceRecordingCoordinator[] = [];
const sessionsToDispose: DapSession[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (coordinatorsToDispose.length > 0) {
    await coordinatorsToDispose.pop()!.dispose().catch(() => {});
  }
  while (sessionsToDispose.length > 0) {
    await sessionsToDispose.pop()!.dispose().catch(() => {});
  }
  while (tempDirs.length > 0) {
    await fs.rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

interface MockTargetOpts {
  mode: 1 | 2 | 3;
  targetState?: 'running' | 'halted';
  transport?: 'winusb' | 'hid' | 'rmlink-service';
  includeFixtureCapture?: boolean;
  includeGlobals?: boolean;
  includeDownWrite?: boolean;
  downWriteCompletionUnknown?: boolean;
  autoConsumeDown?: boolean;
  upRingSample?: Uint8Array;
  initialWrOff?: number;
  initialRdOff?: number;
  initialFrozen?: number;
  initialGeneration?: number;
  initialEnableState?: number;
  initialEnabledBeforeStop?: number;
  initialDropCount?: number;
}

function buildDwarfCatalog(opts: {
  postMortem: boolean;
  includeGlobals: boolean;
  includeFixtureCapture: boolean;
}): SymbolCatalog {
  const types: SymbolCatalog['types'] = {
    '0x1': { name: 'unsigned char', kind: 'base', byteSize: 1 },
    '0x2': { name: 'unsigned int', kind: 'base', byteSize: 4 },
    '0x3': { name: 'void *', kind: 'pointer', byteSize: 4 },
    '0x10': {
      name: 'SEGGER_SYSVIEW_CORE_CONTEXT',
      kind: 'struct',
      byteSize: opts.postMortem ? 24 : 28,
      fields: opts.postMortem
        ? [
            { name: 'EnableState', typeOffset: '0x1', byteOffset: 0 },
            { name: 'UpChannel', typeOffset: '0x1', byteOffset: 1 },
            { name: 'RecursionCnt', typeOffset: '0x1', byteOffset: 2 },
            { name: 'SysFreq', typeOffset: '0x2', byteOffset: 4 },
            { name: 'CPUFreq', typeOffset: '0x2', byteOffset: 8 },
            { name: 'LastTxTimeStamp', typeOffset: '0x2', byteOffset: 12 },
            { name: 'RAMBaseAddress', typeOffset: '0x2', byteOffset: 16 },
            { name: 'PacketCount', typeOffset: '0x2', byteOffset: 20 },
          ]
        : [
            { name: 'EnableState', typeOffset: '0x1', byteOffset: 0 },
            { name: 'UpChannel', typeOffset: '0x1', byteOffset: 1 },
            { name: 'RecursionCnt', typeOffset: '0x1', byteOffset: 2 },
            { name: 'SysFreq', typeOffset: '0x2', byteOffset: 4 },
            { name: 'CPUFreq', typeOffset: '0x2', byteOffset: 8 },
            { name: 'LastTxTimeStamp', typeOffset: '0x2', byteOffset: 12 },
            { name: 'RAMBaseAddress', typeOffset: '0x2', byteOffset: 16 },
            { name: 'DropCount', typeOffset: '0x2', byteOffset: 20 },
            { name: 'DownChannel', typeOffset: '0x1', byteOffset: 24 },
          ],
    },
    '0x11': {
      name: 'SEGGER_SYSVIEW_GLOBALS',
      kind: 'struct',
      byteSize: opts.postMortem ? 28 : 32,
      fields: [{ name: 'MainContext', typeOffset: '0x10', byteOffset: 0 }],
    },
    '0x20': {
      name: 'FixtureCapture',
      kind: 'struct',
      byteSize: 32,
      fields: [
        { name: 'mode', typeOffset: '0x2', byteOffset: 0 },
        { name: 'frozen', typeOffset: '0x2', byteOffset: 4 },
        { name: 'generation', typeOffset: '0x2', byteOffset: 8 },
        { name: 'size', typeOffset: '0x2', byteOffset: 12 },
        { name: 'wrOff', typeOffset: '0x2', byteOffset: 16 },
        { name: 'rdOff', typeOffset: '0x2', byteOffset: 20 },
        { name: 'enabledBeforeStop', typeOffset: '0x2', byteOffset: 24 },
        { name: 'buffer', typeOffset: '0x3', byteOffset: 28 },
      ],
    },
  };
  const roots: SymbolCatalog['roots'] = [
    { id: 'rtt', expression: '_SEGGER_RTT', file: 'SEGGER_RTT.c', typeOffset: '', address: 0x20001000, size: 168, pointerDepth: 0 },
  ];
  if (opts.includeGlobals) {
    roots.push({ id: 'sv', expression: '_SYSVIEW_Globals', file: 'SEGGER_SYSVIEW.c', typeOffset: '0x11', address: 0x20000100, size: opts.postMortem ? 28 : 32, pointerDepth: 0 });
  }
  if (opts.includeFixtureCapture) {
    roots.push({ id: 'fc', expression: 'fixtureCapture', file: 'main.c', typeOffset: '0x20', address: 0x20000000, size: 32, pointerDepth: 0 });
  }
  return { roots, types };
}

function createRttTargetHarness(opts: MockTargetOpts) {
  const ramBase = 0x20000000;
  const ram = Buffer.alloc(0x20000, 0);
  const postMortem = opts.mode === 3;
  const upBufAddr = 0x20004000;
  const upBufSize = 8192;
  const downBufAddr = 0x20003000;
  const downBufSize = 8;
  const ch0BufAddr = 0x20002000;
  const ch0BufSize = 256;
  const cbAddr = 0x20001000;

  // Strings in Flash RO space (read from RO ranges? For simplicity in memory engine, put names in RAM RO-safe area 0x20000400)
  const termNameAddr = 0x20000400;
  const sysviewNameAddr = 0x20000420;
  ram.write('Terminal\0', termNameAddr - ramBase, 'ascii');
  ram.write('SysView\0', sysviewNameAddr - ramBase, 'ascii');

  // _SEGGER_RTT header at 0x20001000: "SEGGER RTT\0...", MaxUp=3, MaxDown=(postMortem?0:3)
  ram.write('SEGGER RTT', cbAddr - ramBase, 'ascii');
  ram.writeUInt32LE(3, cbAddr - ramBase + 16);
  ram.writeUInt32LE(postMortem ? 0 : 3, cbAddr - ramBase + 20);

  const writeDesc = (slot: number, namePtr: number, bufPtr: number, size: number, wr: number, rd: number, flags = 0) => {
    const off = cbAddr - ramBase + 24 + slot * 24;
    ram.writeUInt32LE(namePtr >>> 0, off);
    ram.writeUInt32LE(bufPtr >>> 0, off + 4);
    ram.writeUInt32LE(size >>> 0, off + 8);
    ram.writeUInt32LE(wr >>> 0, off + 12);
    ram.writeUInt32LE(rd >>> 0, off + 16);
    ram.writeUInt32LE(flags >>> 0, off + 20);
  };

  writeDesc(0, termNameAddr, ch0BufAddr, ch0BufSize, 0, 0, 0);
  writeDesc(2, sysviewNameAddr, upBufAddr, upBufSize, opts.initialWrOff ?? 0, opts.initialRdOff ?? 0, 0);
  if (!postMortem) {
    writeDesc(3 + 2, sysviewNameAddr, downBufAddr, downBufSize, 0, 0, 0);
  }

  if (opts.upRingSample) {
    Buffer.from(opts.upRingSample).copy(ram, upBufAddr - ramBase);
  }

  // fixtureCapture at 0x20000000
  const setFixtureCapture = (fc: {
    mode?: number;
    frozen?: number;
    generation?: number;
    size?: number;
    wrOff?: number;
    rdOff?: number;
    enabledBeforeStop?: number;
    buffer?: number;
  }) => {
    if (fc.mode !== undefined) ram.writeUInt32LE(fc.mode, 0x00);
    if (fc.frozen !== undefined) ram.writeUInt32LE(fc.frozen, 0x04);
    if (fc.generation !== undefined) ram.writeUInt32LE(fc.generation, 0x08);
    if (fc.size !== undefined) ram.writeUInt32LE(fc.size, 0x0c);
    if (fc.wrOff !== undefined) ram.writeUInt32LE(fc.wrOff, 0x10);
    if (fc.rdOff !== undefined) ram.writeUInt32LE(fc.rdOff, 0x14);
    if (fc.enabledBeforeStop !== undefined) ram.writeUInt32LE(fc.enabledBeforeStop, 0x18);
    if (fc.buffer !== undefined) ram.writeUInt32LE(fc.buffer >>> 0, 0x1c);
  };

  setFixtureCapture({
    mode: opts.mode,
    frozen: opts.initialFrozen ?? 0,
    generation: opts.initialGeneration ?? 0,
    size: upBufSize,
    wrOff: opts.initialWrOff ?? 0,
    rdOff: opts.initialRdOff ?? 0,
    enabledBeforeStop: opts.initialEnabledBeforeStop ?? 1,
    buffer: upBufAddr,
  });

  // _SYSVIEW_Globals at 0x20000100
  const setGlobals = (g: { enableState?: number; lastTx?: number; dropCount?: number }) => {
    if (g.enableState !== undefined) ram.writeUInt8(g.enableState, 0x100);
    ram.writeUInt8(2, 0x101);
    ram.writeUInt32LE(64_000_000, 0x104);
    ram.writeUInt32LE(64_000_000, 0x108);
    if (g.lastTx !== undefined) ram.writeUInt32LE(g.lastTx, 0x10c);
    ram.writeUInt32LE(0x20000000, 0x110);
    if (g.dropCount !== undefined) ram.writeUInt32LE(g.dropCount, 0x114);
    if (!postMortem) ram.writeUInt8(2, 0x118);
  };
  setGlobals({
    enableState: opts.initialEnableState ?? (opts.mode === 1 ? 0 : 0),
    lastTx: 100,
    dropCount: opts.initialDropCount ?? 0,
  });

  const ramRanges = [{ address: ramBase, size: ram.length }];
  const engine = new SeggerRttMemoryEngine(
    {
      read: async (addr, size) => {
        const off = (addr >>> 0) - ramBase;
        return { ok: true, message: 'ok', targetState: 'Unknown', elapsedMs: 0, data: { bytes: Uint8Array.from(ram.subarray(off, off + size)) } };
      },
      write: async (addr, bytes) => {
        const off = (addr >>> 0) - ramBase;
        Buffer.from(bytes).copy(ram, off);
        return { ok: true, message: 'ok', targetState: 'Unknown', elapsedMs: 0, data: { bytesWritten: bytes.length } };
      },
    },
    { maxChunkBytes: 256, writeAlignmentBytes: opts.transport === 'rmlink-service' ? 4 : 1 },
  );

  let targetState = opts.targetState ?? 'running';
  let continuousPayloadToWrite: Uint8Array | undefined;
  let continuousStopTail: Uint8Array | undefined;
  const downCommandsReceived: number[] = [];
  let haltCalls = 0;
  let resetCalls = 0;
  let ch0Writes = 0;

  const writeUpBytes = (bytes: Uint8Array) => {
    const off = cbAddr - ramBase + 24 + 2 * 24;
    let wr = ram.readUInt32LE(off + 12);
    const rd = ram.readUInt32LE(off + 16);
    const avail = wr >= rd ? upBufSize - 1 - (wr - rd) : rd - wr - 1;
    const n = Math.min(avail, bytes.length);
    for (let i = 0; i < n; i++) {
      ram[upBufAddr - ramBase + wr] = bytes[i];
      wr = (wr + 1) % upBufSize;
    }
    ram.writeUInt32LE(wr, off + 12);
    ram.writeUInt32LE(wr, 0x10); // keep fixtureCapture.wrOff updated if frozen snapshots later
  };

  const writeCh0Bytes = (text: string) => {
    const off = cbAddr - ramBase + 24;
    let wr = ram.readUInt32LE(off + 12);
    const b = Buffer.from(text, 'utf8');
    for (let i = 0; i < b.length; i++) {
      ram[ch0BufAddr - ramBase + wr] = b[i];
      wr = (wr + 1) % ch0BufSize;
    }
    ram.writeUInt32LE(wr, off + 12);
  };

  const catalog = buildDwarfCatalog({
    postMortem,
    includeGlobals: opts.includeGlobals !== false,
    includeFixtureCapture: opts.includeFixtureCapture !== false,
  });

  const backend = {
    supportsProbeSubscriptions: opts.transport === 'rmlink-service',
    execute: vi.fn(async (cmd: any) => {
      if (cmd.cmd === 'getTargetState') return { ok: true, data: targetState };
      if (cmd.cmd === 'getSymbolCatalog') return { ok: true, data: catalog };
      if (cmd.cmd === 'resolveSymbol') {
        if (cmd.name === '_SEGGER_RTT') return { ok: true, data: { address: cbAddr, size: 168, type: 'B' } };
        return { ok: false, error: 'not found' };
      }
      if (cmd.cmd === 'getRttCapabilities') {
        return {
          ok: true,
          data: {
            ownerKind: 'cmsis-dap',
            rttStart: { available: true, evidence: 'offline' },
            rttEnumerate: { available: true, evidence: 'offline' },
            rttUpRead: { available: true, evidence: 'offline' },
            rttDownWrite: opts.includeDownWrite === false
              ? { available: false, reason: 'Owner does not support RTT down-buffer write', evidence: 'offline' }
              : { available: true, evidence: 'offline' },
          },
        };
      }
      if (cmd.cmd === 'startRtt') {
        return engine.start(cmd.controlBlockAddress, cmd.ramRanges ?? ramRanges);
      }
      if (cmd.cmd === 'stopRtt') {
        engine.stop();
        return { ok: true, data: {} };
      }
      if (cmd.cmd === 'enumerateRtt') {
        return engine.enumerate(cmd.controlBlockAddress, cmd.options?.ramRanges ?? ramRanges, cmd.options?.roRanges ?? [], cmd.options?.timeoutMs ?? 2000);
      }
      if (cmd.cmd === 'readRtt') {
        return engine.readUp(cmd.bufferIndex, cmd.size, cmd.signal);
      }
      if (cmd.cmd === 'writeRtt') {
        if (opts.downWriteCompletionUnknown) {
          return {
            ok: false,
            errorCode: 'WriteTimeout',
            error: 'Down write timed out with unknown outcome',
            diagnostics: { rtt: { completion: 'unknown', failureStage: 'commit-wroff' } },
          };
        }
        const res = await engine.writeDown(
          cmd.options?.controlBlockAddress ?? cbAddr,
          cmd.options?.ramRanges ?? ramRanges,
          cmd.bufferIndex,
          cmd.bytes,
          cmd.options?.timeoutMs ?? 2000,
        );
        if (res.ok && opts.autoConsumeDown !== false && targetState === 'running') {
          // Simulate target consuming Down command immediately
          const dOff = cbAddr - ramBase + 24 + (3 + cmd.bufferIndex) * 24;
          const wr = ram.readUInt32LE(dOff + 12);
          let rd = ram.readUInt32LE(dOff + 16);
          while (rd !== wr) {
            const cmdByte = ram[downBufAddr - ramBase + rd];
            rd = (rd + 1) % downBufSize;
            downCommandsReceived.push(cmdByte);
            if (cmdByte === SYSTEMVIEW_COMMAND_IDS.START) {
              setGlobals({ enableState: 1 });
              setFixtureCapture({ frozen: 0 });
              if (continuousPayloadToWrite) {
                writeUpBytes(continuousPayloadToWrite);
              }
            } else if (cmdByte === SYSTEMVIEW_COMMAND_IDS.STOP) {
              setGlobals({ enableState: 0 });
              if (continuousStopTail) {
                writeUpBytes(continuousStopTail);
              } else {
                // Append TRACE_STOP (0x0b) with delta=0
                writeUpBytes(Uint8Array.from([SYSTEMVIEW_EVENT_IDS.TRACE_STOP, 0x00]));
              }
            }
          }
          ram.writeUInt32LE(rd, dOff + 16);
        }
        return res;
      }
      if (cmd.cmd === 'readMemory') {
        const off = (cmd.address >>> 0) - ramBase;
        return { ok: true, data: { data: [...ram.subarray(off, off + cmd.size)] } };
      }
      if (cmd.cmd === 'halt') { haltCalls++; targetState = 'halted'; return { ok: true, data: { state: 'Halted' } }; }
      if (cmd.cmd === 'reset') { resetCalls++; return { ok: true, data: {} }; }
      if (cmd.cmd === 'disconnect') return { ok: true, data: {} };
      return { ok: false, error: `unexpected ${cmd.cmd}` };
    }),
    configureNativeSteps: vi.fn(),
    dispose: vi.fn(),
  };

  const session = new DapSession(backend as any);
  sessionsToDispose.push(session);
  Object.assign(session, {
    phase: 'connected',
    targetConnectionEstablished: true,
    _device: 'STM32H723VGT6',
    _loadedFirmware: { sha256: `sha-mode-${opts.mode}`, path: 'fixture.elf' },
    targetRunning: targetState === 'running',
    rttOwnerKind: 'cmsis-dap',
    rttTransportKind: opts.transport ?? 'winusb',
    rttLogEnabled: false,
    rttControlBlockAddress: cbAddr,
  });

  let reqSeq = 1;
  const sessionHandle: TraceSessionHandle = {
    id: `vscode-sess-${Math.random().toString(36).slice(2)}`,
    name: 'Orbit Acceptance Mock',
    type: 'orbit',
    customRequest: async (command: string, args: Record<string, unknown> = {}) => {
      const mySeq = reqSeq++;
      let captured: DebugProtocolMessage | undefined;
      const listener = (m: DebugProtocolMessage) => {
        if (m.type === 'response' && m.request_seq === mySeq) {
          captured = m;
        }
      };
      session.on('send', listener);
      try {
        await (session as any).handleRequest({ type: 'request', seq: mySeq, command, arguments: args });
      } finally {
        session.off('send', listener);
      }
      if (!captured) throw new Error(`No DAP response for ${command}`);
      if (!captured.success) {
        const err = new Error(captured.message || `DAP ${command} failed`) as Error & { body?: any };
        err.body = captured.body;
        throw err;
      }
      return captured.body;
    },
  };

  const attachCoordinator = (coordinator: TraceRecordingCoordinator) => {
    const forward = (m: DebugProtocolMessage) => {
      if (m.type === 'event') {
        coordinator.onCustomEvent(sessionHandle, m.event!, m.body);
      }
    };
    session.on('send', forward);
    coordinator.bindSession(sessionHandle);
    return () => session.off('send', forward);
  };

  return {
    ram,
    ramBase,
    cbAddr,
    upBufAddr,
    upBufSize,
    backend,
    session,
    sessionHandle,
    attachCoordinator,
    setTargetState: (s: 'running' | 'halted') => {
      targetState = s;
      (session as any).targetRunning = s === 'running';
    },
    setFixtureCapture,
    setGlobals,
    setUpPointers: (wr: number, rd: number) => {
      const off = cbAddr - ramBase + 24 + 2 * 24;
      ram.writeUInt32LE(wr, off + 12);
      ram.writeUInt32LE(rd, off + 16);
    },
    getSysViewRdOff: () => ram.readUInt32LE(cbAddr - ramBase + 24 + 2 * 24 + 16),
    getSysViewWrOff: () => ram.readUInt32LE(cbAddr - ramBase + 24 + 2 * 24 + 12),
    setContinuousPayload: (bytes: Uint8Array, tail?: Uint8Array) => {
      continuousPayloadToWrite = bytes;
      continuousStopTail = tail;
    },
    writeUpBytes,
    writeCh0Bytes,
    downCommandsReceived,
    getHaltResetCalls: () => ({ haltCalls, resetCalls }),
    bumpCh0Writes: () => { ch0Writes++; },
    getCh0Writes: () => ch0Writes,
  };
}

describe('TraceRecordingCoordinator Stage 4.4 (Extension Host -> DAP -> 4.3 Worker)', () => {
  it('runs Continuous mode end-to-end: Start/Stop Down protocol, bounded drain, ch0 RTT Log isolation, and raw export after close', async () => {
    const sample = await fs.readFile('scripts/rtos/fixtures/samples/continuous.bin');
    const dir = await makeTempDir('orbit-trace-cont-');
    const recDir = path.join(dir, 'rec-cont');
    const exportPath = path.join(dir, 'exported-continuous.bin');

    const target = createRttTargetHarness({ mode: 1, targetState: 'running', transport: 'winusb' });
    // Separate body vs TRACE_STOP tail (continuous.bin ends with TRACE_STOP packet [0x0b, 0x0a])
    const bodyWithoutStop = sample.subarray(0, sample.length - 2);
    const stopTail = sample.subarray(sample.length - 2);
    target.setContinuousPayload(bodyWithoutStop, stopTail);

    // Start independent RTT Log on Channel 0 first
    const rttLogChunks: string[] = [];
    target.session.on('send', (m: DebugProtocolMessage) => {
      if (m.type === 'event' && m.event === 'ozoneRttOutput') {
        rttLogChunks.push(String(m.body?.text || ''));
      }
    });
    (target.session as any).rttLogEnabled = true;
    (target.session as any).startRttLogPolling();
    target.writeCh0Bytes('hello-ch0\n');

    const coordinator = new TraceRecordingCoordinator({
      storageRoot: dir,
      workerFactory: () => new TraceWorkerClient(),
    });
    coordinatorsToDispose.push(coordinator);
    target.attachCoordinator(coordinator);

    const startRes = await coordinator.startRecording({
      mode: 'continuous',
      recordId: 'cont-1',
      recordingDir: recDir,
      pollIntervalMs: 10,
      startConfirmTimeoutMs: 1500,
    });
    expect(startRes.state).toBe('recording');
    expect(startRes.targetState).toBe('recording');
    expect(startRes.channelInfo?.upChannelIndex).toBe(2);
    expect(startRes.channelInfo?.downChannelIndex).toBe(2);
    expect(target.downCommandsReceived).toEqual([SYSTEMVIEW_COMMAND_IDS.START]);

    // Duplicate Start for same recordId must return existing status without second Down command or reader
    const dupStart = await coordinator.startRecording({ mode: 'continuous', recordId: 'cont-1' });
    expect(dupStart.state).toBe('recording');
    expect(target.downCommandsReceived).toEqual([SYSTEMVIEW_COMMAND_IDS.START]);

    // Wait briefly for Up stream batches to flow through Worker
    await vi.waitFor(async () => {
      const st = coordinator.getStatus('cont-1');
      expect(st?.counters.bytesReceived).toBeGreaterThanOrEqual(bodyWithoutStop.length);
    }, { timeout: 3000 });

    // Pause / Resume receiving keeps target recording running
    const paused = await coordinator.pauseReceiving('cont-1');
    expect(paused?.state).toBe('paused');
    const resumed = await coordinator.resumeReceiving('cont-1');
    expect(resumed?.state).toBe('recording');

    // Stop recording: sends STOP once, confirms EnableState==0 & TRACE_STOP, drains & persists
    const [stop1, stop2] = await Promise.all([
      coordinator.stopRecording('cont-1'),
      coordinator.stopRecording('cont-1'),
    ]);
    expect(stop1?.state).toBe('stopped');
    expect(stop2?.state).toBe('stopped');
    expect(stop1?.targetState).toBe('stopped');
    expect(target.downCommandsReceived).toEqual([SYSTEMVIEW_COMMAND_IDS.START, SYSTEMVIEW_COMMAND_IDS.STOP]);
    expect(stop1?.manifest?.committed.rawBytes).toBe(sample.length);

    // Channel 0 RTT Log stays alive after Trace stops!
    target.writeCh0Bytes('still-alive-after-trace-stop\n');
    await vi.waitFor(() => {
      expect(rttLogChunks.join('')).toContain('still-alive-after-trace-stop');
    }, { timeout: 2000 });

    // Close recording & re-open to verify persisted raw bytes match sample SHA256
    const closeRes = await coordinator.closeRecording('cont-1');
    expect(closeRes.ok).toBe(true);
    const reopened = await coordinator.openRecording(recDir, 'cont-1-reopen');
    expect(reopened.ok).toBe(true);
    const exported = await coordinator.exportRawToFile('cont-1-reopen', exportPath);
    expect(exported.ok).toBe(true);
    if (exported.ok) {
      expect(exported.data.exportedBytes).toBe(sample.length);
      const expectedSha = createHash('sha256').update(sample).digest('hex');
      expect(exported.data.sha256).toBe(expectedSha);
    }
    expect(target.getHaltResetCalls()).toEqual({ haltCalls: 0, resetCalls: 0 });
  });

  it('reports TargetNotRunning, UnsupportedCapability, limited/insufficient transport, backpressure, and unknown write outcome without blind retry', async () => {
    const dir = await makeTempDir('orbit-trace-cont-neg-');

    // 1. Target halted -> TargetNotRunning (never auto-halted or auto-run)
    const haltedTarget = createRttTargetHarness({ mode: 1, targetState: 'halted' });
    const c1 = new TraceRecordingCoordinator({ storageRoot: dir, workerFactory: () => new TraceWorkerClient() });
    coordinatorsToDispose.push(c1);
    haltedTarget.attachCoordinator(c1);
    const rHalted = await c1.startRecording({ mode: 'continuous', recordId: 'halted-1' });
    expect(rHalted.state).toBe('error');
    expect(rHalted.error?.errorCode).toBe('TargetNotRunning');
    expect(haltedTarget.downCommandsReceived).toEqual([]);

    // 2. Down channel unsupported -> UnsupportedCapability
    const noWriteTarget = createRttTargetHarness({ mode: 1, targetState: 'running', includeDownWrite: false });
    const c2 = new TraceRecordingCoordinator({ storageRoot: dir, workerFactory: () => new TraceWorkerClient() });
    coordinatorsToDispose.push(c2);
    noWriteTarget.attachCoordinator(c2);
    const rNoWrite = await c2.startRecording({ mode: 'continuous', recordId: 'nowrite-1' });
    expect(rNoWrite.state).toBe('error');
    expect(rNoWrite.error?.errorCode).toBe('UnsupportedCapability');

    // 3. Unknown write outcome -> completion=unknown, NO blind retry
    const unknownTarget = createRttTargetHarness({ mode: 1, targetState: 'running', downWriteCompletionUnknown: true });
    const c3 = new TraceRecordingCoordinator({ storageRoot: dir, workerFactory: () => new TraceWorkerClient() });
    coordinatorsToDispose.push(c3);
    unknownTarget.attachCoordinator(c3);
    const rUnknown = await c3.startRecording({ mode: 'continuous', recordId: 'unk-1' });
    expect(rUnknown.state).toBe('error');
    expect(rUnknown.error?.completion).toBe('unknown');
    expect(rUnknown.targetState).toBe('unknown');
    const writeCalls = vi.mocked(unknownTarget.backend.execute).mock.calls.filter(c => c[0].cmd === 'writeRtt');
    expect(writeCalls.length).toBe(1); // strictly 1 attempt, never retried!

    // 4. Backpressure + limited/insufficient transport + OVERFLOW
    const overflowSample = await fs.readFile('scripts/rtos/fixtures/samples/continuous-overflow.bin');
    const bpTarget = createRttTargetHarness({ mode: 1, targetState: 'running', transport: 'rmlink-service' });
    const firstChunk = overflowSample.subarray(0, 4096);
    const secondChunk = overflowSample.subarray(4096, overflowSample.length - 2);
    const stopTailOv = overflowSample.subarray(overflowSample.length - 2);
    bpTarget.setContinuousPayload(firstChunk, stopTailOv);

    let tryCount = 0;
    let waitDrainCalls = 0;
    const realWorker = new TraceWorkerClient();
    const backpressureWorker: TraceWorkerClientLike = {
      createRecording: o => realWorker.createRecording(o),
      ingestChunk: p => realWorker.ingestChunk(p),
      tryIngestChunk: async (p) => {
        tryCount++;
        if (tryCount === 1) {
          return { ok: false, backpressure: true, errorCode: 'WriteQueueFull', message: 'simulated host queue full' };
        }
        return realWorker.tryIngestChunk(p);
      },
      waitForInputDrain: async (t, b) => {
        waitDrainCalls++;
        return realWorker.waitForInputDrain(t, b);
      },
      markGap: p => realWorker.markGap(p),
      notifyTargetReset: p => realWorker.notifyTargetReset(p),
      flushRecording: id => realWorker.flushRecording(id),
      finishRecording: (id, r) => realWorker.finishRecording(id, r),
      closeRecording: id => realWorker.closeRecording(id),
      openRecording: o => realWorker.openRecording(o),
      inspectRecording: (d, v) => realWorker.inspectRecording(d, v),
      queryRange: (id, r) => realWorker.queryRange(id, r),
      queryLod: (id, r) => realWorker.queryLod(id, r),
      getSegments: id => realWorker.getSegments(id),
      getGaps: id => realWorker.getGaps(id),
      exportRawToFile: (id, out, o) => realWorker.exportRawToFile(id, out, o),
      getStats: id => realWorker.getStats(id),
      shutdown: r => realWorker.shutdown(r),
    };

    const c4 = new TraceRecordingCoordinator({
      storageRoot: dir,
      workerFactory: () => backpressureWorker,
    });
    coordinatorsToDispose.push(c4);
    bpTarget.attachCoordinator(c4);
    const bpStart = await c4.startRecording({
      mode: 'continuous',
      recordId: 'bp-1',
      recordingDir: path.join(dir, 'rec-bp'),
      pollIntervalMs: 20,
    });
    expect(bpStart.state).toBe('recording');
    expect(bpStart.transportBudget?.transport).toBe('rmlink-service');

    await vi.waitFor(() => {
      const st = c4.getStatus('bp-1');
      expect(st?.counters.backpressurePauses).toBeGreaterThanOrEqual(1);
      expect(st?.counters.bytesReceived).toBeGreaterThanOrEqual(firstChunk.length);
    }, { timeout: 3000 });

    bpTarget.writeUpBytes(secondChunk);
    await vi.waitFor(() => {
      const st = c4.getStatus('bp-1');
      expect(st?.counters.bytesReceived).toBeGreaterThanOrEqual(overflowSample.length - 2);
    }, { timeout: 3000 });

    const bpStop = await c4.stopRecording('bp-1');
    expect(bpStop?.state).toBe('stopped');
    expect(waitDrainCalls).toBeGreaterThanOrEqual(1);
    expect(bpStop?.transportAdequacy).toBe('insufficient');
    expect(bpStop?.integrity).toBe('target-overflow');
  });

  it('executes Single-Shot mode: waits for freeze, reads valid range without advancing RdOff, faithfully reports overflow, empty, and unprovable freeze', async () => {
    const ssSample = await fs.readFile('scripts/rtos/fixtures/samples/single-shot.bin');
    const ssOverflowSample = await fs.readFile('scripts/rtos/fixtures/samples/single-shot-overflow.bin');
    const dir = await makeTempDir('orbit-trace-ss-');

    // 1. Wait for freeze -> capture -> verify RdOff untouched & exact raw bytes
    const ssTarget = createRttTargetHarness({
      mode: 2,
      targetState: 'running',
      upRingSample: ssSample,
      initialWrOff: ssSample.length,
      initialRdOff: 0,
      initialFrozen: 0,
      initialGeneration: 0,
      initialEnableState: 1,
    });
    const coordinator = new TraceRecordingCoordinator({
      storageRoot: dir,
      workerFactory: () => new TraceWorkerClient(),
    });
    coordinatorsToDispose.push(coordinator);
    ssTarget.attachCoordinator(coordinator);

    setTimeout(() => {
      ssTarget.setGlobals({ enableState: 0 });
      ssTarget.setFixtureCapture({ frozen: 1, generation: 1, wrOff: ssSample.length, rdOff: 0, enabledBeforeStop: 1 });
    }, 120);

    const ssRes = await coordinator.startRecording({
      mode: 'single-shot',
      recordId: 'ss-1',
      recordingDir: path.join(dir, 'rec-ss-1'),
      freezeTimeoutMs: 3000,
    });
    expect(ssRes.state).toBe('stopped');
    expect(ssRes.integrity).toBe('complete');
    expect(ssRes.freezeEvidence?.rdOffAdvancedByHost).toBe(false);
    expect(ssTarget.getSysViewRdOff()).toBe(0);
    expect(ssRes.manifest?.committed.rawBytes).toBe(ssSample.length);
    const outSs = path.join(dir, 'ss-export.bin');
    const expSs = await coordinator.exportRawToFile('ss-1', outSs);
    expect(expSs.ok && expSs.data.sha256).toBe(createHash('sha256').update(ssSample).digest('hex'));
    expect(ssTarget.getHaltResetCalls()).toEqual({ haltCalls: 0, resetCalls: 0 });

    // 2. Single-Shot Overflow (enabledBeforeStop=2, DropCount=42)
    const ssOvTarget = createRttTargetHarness({
      mode: 2,
      targetState: 'running',
      upRingSample: ssOverflowSample,
      initialWrOff: ssOverflowSample.length,
      initialRdOff: 0,
      initialFrozen: 1,
      initialGeneration: 1,
      initialEnableState: 0,
      initialEnabledBeforeStop: 2,
      initialDropCount: 42,
    });
    ssOvTarget.attachCoordinator(coordinator);
    const ovRes = await coordinator.startRecording({
      mode: 'single-shot',
      recordId: 'ss-ov-1',
      recordingDir: path.join(dir, 'rec-ss-ov'),
    });
    expect(ovRes.state).toBe('stopped');
    expect(ovRes.integrity).toBe('target-overflow');
    expect(ovRes.freezeEvidence?.dropCount).toBe(42);
    const gapsRes = await coordinator.getGaps('ss-ov-1');
    expect(gapsRes.ok && gapsRes.data.some(g => g.kind === 'target-overflow')).toBe(true);

    // 3. Empty buffer (wrOff === rdOff) -> TraceNoRetainedData
    const ssEmptyTarget = createRttTargetHarness({
      mode: 2,
      targetState: 'running',
      initialWrOff: 0,
      initialRdOff: 0,
      initialFrozen: 1,
      initialGeneration: 1,
      initialEnableState: 0,
    });
    ssEmptyTarget.attachCoordinator(coordinator);
    const emptyRes = await coordinator.startRecording({
      mode: 'single-shot',
      recordId: 'ss-empty',
      recordingDir: path.join(dir, 'rec-ss-empty'),
    });
    expect(emptyRes.state).toBe('error');
    expect(emptyRes.error?.errorCode).toBe('TraceNoRetainedData');
    expect(emptyRes.integrity).toBe('empty');

    // 4. Missing fixtureCapture while target running -> FreezeUnprovable (NO whole-buffer fallback!)
    const unprovableTarget = createRttTargetHarness({
      mode: 2,
      targetState: 'running',
      includeFixtureCapture: false,
      upRingSample: ssSample,
      initialWrOff: ssSample.length,
      initialRdOff: 0,
    });
    unprovableTarget.attachCoordinator(coordinator);
    const unprovableRes = await coordinator.startRecording({
      mode: 'single-shot',
      recordId: 'ss-unprovable',
      recordingDir: path.join(dir, 'rec-ss-unprovable'),
    });
    expect(unprovableRes.state).toBe('error');
    expect(unprovableRes.error?.errorCode).toBe('FreezeUnprovable');
  });

  it('executes Post-Mortem mode: verifies frozen+mode, extracts ring chronologically without RdOff advance, requires real sync, rejects missing metadata and busy reader', async () => {
    const pmSample = await fs.readFile('scripts/rtos/fixtures/samples/post-mortem.bin');
    const pmMeta = JSON.parse(await fs.readFile('scripts/rtos/fixtures/samples/post-mortem.json', 'utf8')) as {
      bufferSize: number;
      rdOff: number;
      wrOff: number;
      retainedBytes: number;
      sha256: string;
    };
    expect(pmSample.length).toBe(pmMeta.retainedBytes);

    // Reconstruct physical 8192-byte wrapped ring RAM exactly as on target:
    // bytes [0..wrOff) hold tail of chronological sample; [rdOff..8192) hold head of chronological sample
    const ringRam = Buffer.alloc(pmMeta.bufferSize, 0xaa);
    const tailLen = pmMeta.bufferSize - pmMeta.rdOff;
    pmSample.subarray(0, tailLen).copy(ringRam, pmMeta.rdOff);
    pmSample.subarray(tailLen).copy(ringRam, 0);

    const dir = await makeTempDir('orbit-trace-pm-');
    const pmTarget = createRttTargetHarness({
      mode: 3,
      targetState: 'running',
      upRingSample: ringRam,
      initialWrOff: pmMeta.wrOff,
      initialRdOff: pmMeta.rdOff,
      initialFrozen: 1,
      initialGeneration: 1,
      initialEnableState: 0,
    });
    const coordinator = new TraceRecordingCoordinator({
      storageRoot: dir,
      workerFactory: () => new TraceWorkerClient(),
    });
    coordinatorsToDispose.push(coordinator);
    pmTarget.attachCoordinator(coordinator);

    const pmRes = await coordinator.startRecording({
      mode: 'post-mortem',
      recordId: 'pm-1',
      recordingDir: path.join(dir, 'rec-pm-1'),
    });
    expect(pmRes.state).toBe('stopped');
    expect(pmRes.integrity).toBe('prefix-overwritten');
    expect(pmRes.freezeEvidence?.wrapped).toBe(true);
    expect(pmRes.freezeEvidence?.rdOffAdvancedByHost).toBe(false);
    expect(pmTarget.getSysViewRdOff()).toBe(pmMeta.rdOff);
    expect(pmTarget.getSysViewWrOff()).toBe(pmMeta.wrOff);
    expect(pmRes.counters.segmentCount).toBeGreaterThanOrEqual(1);
    expect(pmRes.manifest?.committed.rawBytes).toBe(pmMeta.retainedBytes);

    const gapsRes = await coordinator.getGaps('pm-1');
    expect(gapsRes.ok && gapsRes.data.some(g => g.kind === 'prefix-overwritten')).toBe(true);

    // Verify raw.otbin exported after close matches exact chronological post-mortem.bin SHA256!
    await coordinator.closeRecording('pm-1');
    const reopened = await coordinator.openRecording(path.join(dir, 'rec-pm-1'), 'pm-1-verify');
    expect(reopened.ok).toBe(true);
    const exportedPm = await coordinator.exportRawToFile('pm-1-verify', path.join(dir, 'pm-export.bin'));
    expect(exportedPm.ok && exportedPm.data.sha256).toBe(pmMeta.sha256);
    expect(pmTarget.getHaltResetCalls()).toEqual({ haltCalls: 0, resetCalls: 0 });

    // No genuine sync in ring -> NoValidSyncFound!
    const garbage = Buffer.alloc(pmMeta.bufferSize, 0x55);
    const noSyncTarget = createRttTargetHarness({
      mode: 3,
      targetState: 'running',
      upRingSample: garbage,
      initialWrOff: 100,
      initialRdOff: 101,
      initialFrozen: 1,
      initialGeneration: 1,
      initialEnableState: 0,
    });
    noSyncTarget.attachCoordinator(coordinator);
    const noSyncRes = await coordinator.startRecording({
      mode: 'post-mortem',
      recordId: 'pm-nosync',
      recordingDir: path.join(dir, 'rec-pm-nosync'),
    });
    expect(noSyncRes.state).toBe('incomplete');
    expect(noSyncRes.integrity).toBe('no-sync');
    expect(noSyncRes.error?.errorCode).toBe('NoValidSyncFound');

    // Mode mismatch (Continuous firmware opened as Post-Mortem) -> TraceModeMismatch
    const wrongModeTarget = createRttTargetHarness({ mode: 1, targetState: 'halted', initialWrOff: 50, initialRdOff: 0 });
    wrongModeTarget.attachCoordinator(coordinator);
    const wrongModeRes = await coordinator.startRecording({
      mode: 'post-mortem',
      recordId: 'pm-wrongmode',
      recordingDir: path.join(dir, 'rec-pm-wrongmode'),
    });
    expect(wrongModeRes.state).toBe('error');
    expect(wrongModeRes.error?.errorCode).toBe('TraceModeMismatch');
  });

  it('isolates recordings across session termination and bootGeneration changes', async () => {
    const sample = await fs.readFile('scripts/rtos/fixtures/samples/continuous.bin');
    const dir = await makeTempDir('orbit-trace-iso-');
    const target = createRttTargetHarness({ mode: 1, targetState: 'running' });
    target.setContinuousPayload(sample.subarray(0, sample.length - 2));

    const coordinator = new TraceRecordingCoordinator({
      storageRoot: dir,
      workerFactory: () => new TraceWorkerClient(),
    });
    coordinatorsToDispose.push(coordinator);
    target.attachCoordinator(coordinator);

    const s1 = await coordinator.startRecording({
      mode: 'continuous',
      recordId: 'iso-boot',
      recordingDir: path.join(dir, 'rec-iso-boot'),
      pollIntervalMs: 20,
    });
    expect(s1.state).toBe('recording');

    // Trigger bootGeneration advance on DAP -> coordinator immediately isolates and marks incomplete
    (target.session as any).advanceRtosBootGeneration('restart');
    await vi.waitFor(() => {
      const st = coordinator.getStatus('iso-boot');
      expect(st?.state).toBe('incomplete');
      expect(st?.error?.errorCode).toBe('TargetReset');
    }, { timeout: 2000 });

    // Start a second recording under new bootGeneration (simulated MCU reboot resets _SYSVIEW_Globals.EnableState=0), then terminate session
    target.setGlobals({ enableState: 0 });
    target.setContinuousPayload(sample.subarray(0, sample.length - 2));
    const s2 = await coordinator.startRecording({
      mode: 'continuous',
      recordId: 'iso-term',
      recordingDir: path.join(dir, 'rec-iso-term'),
      pollIntervalMs: 20,
    });
    expect(s2.state).toBe('recording');
    coordinator.onSessionTerminated(target.sessionHandle);
    await vi.waitFor(() => {
      const st = coordinator.getStatus('iso-term');
      expect(st?.state).toBe('incomplete');
      expect(st?.error?.errorCode).toBe('SessionTerminated');
    }, { timeout: 2000 });
  });

  it('prevents start/stop/subscribe/createRecording races with synchronous reservation, idempotent same-id re-entry, and late cleanup', async () => {
    const dir = await makeTempDir('orbit-trace-races-');
    const truth = { available: true, evidence: 'test' as const };
    const caps = { rttStart: truth, rttEnumerate: truth, rttUpRead: truth, rttDownWrite: truth, ownerKind: 'cmsis-dap' as const };
    const budget = {
      ownerKind: 'cmsis-dap' as const,
      transport: 'winusb' as const,
      maxBatchBytes: 512,
      minPollIntervalMs: 10,
      defaultPollIntervalMs: 20,
      maxBatchesPerTurn: 2,
      source: 'test' as const,
    };
    const mkDesc = (downRd = 0, downWr = 0) => ({
      controlBlockAddress: 0x20001000,
      upBuffers: [{
        direction: 'up' as const,
        index: 1,
        bufferAddress: 0x20002000,
        status: 'valid' as const,
        name: 'SysView',
        nameStatus: 'ok' as const,
        valid: true,
        bufferSize: 4096,
        rdOff: 0,
        wrOff: 0,
      }],
      downBuffers: [{
        direction: 'down' as const,
        index: 1,
        bufferAddress: 0x20003000,
        status: 'valid' as const,
        name: 'SysView',
        nameStatus: 'ok' as const,
        valid: true,
        bufferSize: 64,
        rdOff: downRd,
        wrOff: downWr,
      }],
      duplicateUpNames: [],
      duplicateDownNames: [],
    });

    // 1. Concurrent same-id idempotency & different-id rejection before first await
    let releaseInspect!: () => void;
    const inspectGate = new Promise<void>(r => { releaseInspect = r; });
    let inspectCalls = 0;
    let downWrites = 0;
    let subCalls = 0;
    let unsubCalls = 0;
    let enableState = 0;

    const session1: TraceSessionHandle = {
      id: 'vs-s1',
      name: 's1',
      type: 'orbit',
      customRequest: (async (method: string, args: Record<string, unknown> = {}) => {
        if (method === 'orbitTraceTarget' && args.action === 'inspect') {
          inspectCalls++;
          await inspectGate;
          return {
            ok: true,
            identity: { sessionId: 's1', sessionGeneration: 1, bootGeneration: 1, operationGeneration: 1, elfSha256: 'sha', elfPath: 'a.elf', device: 'H7' },
            rttCapabilities: caps,
            targetState: 'Running',
            ramRangesAvailable: true,
            ramRanges: [{ address: 0x20000000, size: 0x10000 }],
            rttBudgets: { channel0: budget, binaryChannel: budget },
            rttControlBlockAddress: 0x20001000,
            globalsValues: { enableState },
          };
        }
        if (method === 'orbitTraceTarget' && args.action === 'readState') {
          return { ok: true, sessionGeneration: 1, bootGeneration: 1, targetState: 'Running', globalsValues: { enableState }, enumerate: mkDesc(downWrites, downWrites) };
        }
        if (method === 'orbitRttTransport' && args.action === 'enumerate') return { ok: true, data: mkDesc(0, 0) };
        if (method === 'orbitRttTransport' && args.action === 'subscribe') { subCalls++; return { ok: true, budget, bufferIndex: 1 }; }
        if (method === 'orbitRttTransport' && args.action === 'unsubscribe') { unsubCalls++; return { ok: true }; }
        if (method === 'orbitRttTransport' && args.action === 'writeDown') {
          downWrites++;
          const byte = Buffer.from(String(args.dataBase64 ?? ''), 'base64')[0];
          enableState = byte === SYSTEMVIEW_COMMAND_IDS.START ? 1 : 0;
          return { ok: true, data: { committedBytes: 1, committedWrOff: downWrites, rdOff: downWrites } };
        }
        return { ok: true };
      }) as TraceSessionHandle['customRequest'],
    };

    const storesCreated: string[] = [];
    const storesFinished: string[] = [];
    const storesClosed: string[] = [];
    let releaseLateCreate!: () => void;
    let releaseLateSubscribe!: () => void;
    let blockNextCreate = false;
    const emptySummary = (gapsRecorded = 0) => ({
      commitSeq: 1,
      committedRawBytes: 0,
      committedDataBytes: 0,
      packetsDecoded: 0,
      slicesEmitted: 0,
      activationsEmitted: 0,
      readyWaitsEmitted: 0,
      markersEmitted: 0,
      markerPointsEmitted: 0,
      gapsRecorded,
    });
    const mockWorker: TraceWorkerClientLike = {
      createRecording: async p => {
        storesCreated.push(p.recordId);
        if (blockNextCreate) {
          await new Promise<void>(r => { releaseLateCreate = r; });
        }
        return { ok: true, data: {} as any };
      },
      ingestChunk: async () => ({ ok: true, data: emptySummary() }),
      tryIngestChunk: async () => ({ ok: true, data: emptySummary() }),
      waitForInputDrain: async () => true,
      markGap: async () => ({ ok: true, data: emptySummary(1) }),
      notifyTargetReset: async () => ({ ok: true, data: emptySummary() }),
      flushRecording: async () => ({ ok: true, data: { commitSeq: 1, committedRawBytes: 0 } }),
      finishRecording: async id => { storesFinished.push(id); return { ok: true, data: { committed: { rawBytes: 0, packetCount: 0, sliceCount: 0, gapCount: 0, segmentCount: 0 } } as any }; },
      closeRecording: async id => { storesClosed.push(id); return { ok: true, data: { closed: true, alreadyClosed: false } }; },
      openRecording: async () => ({ ok: true, data: {} as any }),
      inspectRecording: async () => ({ ok: true, data: {} as any }),
      queryRange: async () => ({ ok: true, data: {} as any }),
      queryLod: async () => ({ ok: true, data: {} as any }),
      getSegments: async () => ({ ok: true, data: [] }),
      getGaps: async () => ({ ok: true, data: [] }),
      exportRawToFile: async () => ({ ok: true, data: { exportedBytes: 0, sha256: '' } }),
      getStats: async () => ({ ok: true, data: {} as any }),
      shutdown: async () => ({ exitCode: 0, forced: false }),
    };

    const coord = new TraceRecordingCoordinator({ storageRoot: dir, workerFactory: () => mockWorker });
    coordinatorsToDispose.push(coord);
    coord.bindSession(session1);

    const pSameA = coord.startRecording({ mode: 'continuous', recordId: 'same-id' });
    const pSameB = coord.startRecording({ mode: 'continuous', recordId: 'same-id' });
    const pDiff = coord.startRecording({ mode: 'continuous', recordId: 'other-id' });
    releaseInspect();
    const [rA, rB, rDiff] = await Promise.all([pSameA, pSameB, pDiff]);
    expect(rA.state).toBe('recording');
    expect(rB.state).toBe('recording');
    expect(rB.recordId).toBe('same-id');
    expect(rDiff.state).toBe('error');
    expect(rDiff.error?.errorCode).toBe('RecordingAlreadyActive');
    expect(inspectCalls).toBe(1);
    expect(storesCreated).toEqual(['same-id']);
    expect(subCalls).toBe(1);
    expect(downWrites).toBe(1);
    const stoppedSame = await coord.stopRecording('same-id');
    expect(stoppedSame?.state).toBe('stopped');

    // 2. Stop/Cancel during delayed worker.createRecording -> late create closes itself, zero subscribe or START
    storesCreated.length = 0;
    storesFinished.length = 0;
    storesClosed.length = 0;
    subCalls = 0;
    downWrites = 0;
    blockNextCreate = true;
    const pLateCreate = coord.startRecording({ mode: 'continuous', recordId: 'late-create' });
    await vi.waitFor(() => expect(storesCreated).toEqual(['late-create']), { timeout: 1000 });
    const stopEarly = await coord.stopRecording('late-create');
    expect(stopEarly?.state).toBe('incomplete');
    expect(stopEarly?.error?.errorCode).toBe('RecordingStoppedBeforeStart');
    releaseLateCreate();
    const settledLateCreate = await pLateCreate;
    expect(settledLateCreate.state).toBe('incomplete');
    expect(storesFinished).toEqual(['late-create']);
    expect(storesClosed).toEqual(['late-create']);
    expect(subCalls).toBe(0);
    expect(downWrites).toBe(0);
    blockNextCreate = false;

    // 3. Session replacement during delayed subscribe -> late subscribe immediately unsubscribes, zero orphaned consumer, zero START write
    unsubCalls = 0;
    subCalls = 0;
    downWrites = 0;
    const sessionLateSub: TraceSessionHandle = {
      id: 'vs-late-sub',
      name: 'late-sub',
      type: 'orbit',
      customRequest: (async (method: string, args: Record<string, unknown> = {}) => {
        if (method === 'orbitTraceTarget' && args.action === 'inspect') {
          return {
            ok: true,
            identity: { sessionId: 's-late', sessionGeneration: 1, bootGeneration: 1, operationGeneration: 1, elfSha256: 'sha', elfPath: 'a.elf', device: 'H7' },
            rttCapabilities: caps,
            targetState: 'Running',
            ramRangesAvailable: true,
            ramRanges: [{ address: 0x20000000, size: 0x10000 }],
            rttBudgets: { channel0: budget, binaryChannel: budget },
            rttControlBlockAddress: 0x20001000,
            globalsValues: { enableState: 0 },
          };
        }
        if (method === 'orbitRttTransport' && args.action === 'enumerate') return { ok: true, data: mkDesc(0, 0) };
        if (method === 'orbitRttTransport' && args.action === 'subscribe') {
          subCalls++;
          await new Promise<void>(r => { releaseLateSubscribe = r; });
          return { ok: true, budget, bufferIndex: 1 };
        }
        if (method === 'orbitRttTransport' && args.action === 'unsubscribe') {
          unsubCalls++;
          return { ok: true };
        }
        if (method === 'orbitRttTransport' && args.action === 'writeDown') {
          downWrites++;
          return { ok: true, data: { committedBytes: 1 } };
        }
        return { ok: true };
      }) as TraceSessionHandle['customRequest'],
    };
    coord.bindSession(sessionLateSub);
    const pLateSub = coord.startRecording({ mode: 'continuous', recordId: 'late-sub' });
    await vi.waitFor(() => expect(subCalls).toBe(1), { timeout: 1000 });
    coord.bindSession(session1); // replace active session mid-subscribe
    releaseLateSubscribe();
    const resLateSub = await pLateSub;
    expect(resLateSub.state).toBe('incomplete');
    expect(resLateSub.error?.errorCode).toBe('SessionChanged');
    expect(unsubCalls).toBe(1);
    expect(downWrites).toBe(0);
  });

  it('rejects stale Up backlog without Down consumption, guards already-recording target, splits missing seq into transport-gap, and seals interrupted manifest', async () => {
    const sample = await fs.readFile('scripts/rtos/fixtures/samples/continuous.bin');
    const dir = await makeTempDir('orbit-trace-gaps-');

    // 1. Missing batchSequence (seq=1 then seq=3) must mark transport-gap and split segments rather than merging as continuous!
    const gapTarget = createRttTargetHarness({ mode: 1, targetState: 'running', transport: 'winusb' });
    const coord = new TraceRecordingCoordinator({
      storageRoot: dir,
      workerFactory: () => new TraceWorkerClient(),
    });
    coordinatorsToDispose.push(coord);
    gapTarget.attachCoordinator(coord);

    const rec = await coord.startRecording({
      mode: 'continuous',
      recordId: 'seq-gap',
      recordingDir: path.join(dir, 'rec-seq-gap'),
      commitOnEachIngest: true,
    });
    expect(rec.state).toBe('recording');
    const chunkA = sample.subarray(0, sample.length - 2);
    const chunkB = sample.subarray(0, sample.length - 2);
    const cid = 'trace-seq-gap';
    const gapCh = rec.channelInfo!.upChannelIndex;
    coord.onCustomEvent(gapTarget.sessionHandle, 'orbitRttData', {
      consumerId: cid,
      sessionId: rec.identity!.sessionId,
      sessionGeneration: rec.identity!.sessionGeneration,
      bootGeneration: rec.identity!.bootGeneration,
      bufferIndex: gapCh,
      batchSequence: 1,
      dataBase64: Buffer.from(chunkA).toString('base64'),
    });
    // Intentionally skip batchSequence=2 and deliver batchSequence=3
    coord.onCustomEvent(gapTarget.sessionHandle, 'orbitRttData', {
      consumerId: cid,
      sessionId: rec.identity!.sessionId,
      sessionGeneration: rec.identity!.sessionGeneration,
      bootGeneration: rec.identity!.bootGeneration,
      bufferIndex: gapCh,
      batchSequence: 3,
      dataBase64: Buffer.from(chunkB).toString('base64'),
    });
    const stoppedGap = await coord.stopRecording('seq-gap');
    expect(stoppedGap?.state).toBe('stopped');
    expect(stoppedGap?.transportAdequacy).toBe('insufficient');
    expect(stoppedGap?.counters.segmentCount).toBe(2);
    const gapList = await coord.getGaps('seq-gap');
    expect(gapList.ok && gapList.data.some(g => g.kind === 'transport-gap' && g.reason.includes('2..2'))).toBe(true);
    await coord.closeRecording('seq-gap');

    // 2. Target already recording (EnableState=1) rejects by default without auto-STOP/halt/reset
    const busyTarget = createRttTargetHarness({ mode: 1, targetState: 'running', initialEnableState: 1 });
    busyTarget.attachCoordinator(coord);
    const alreadyRes = await coord.startRecording({
      mode: 'continuous',
      recordId: 'already-rec',
      recordingDir: path.join(dir, 'rec-already'),
    });
    expect(alreadyRes.state).toBe('error');
    expect(alreadyRes.error?.errorCode).toBe('TargetAlreadyRecording');
    expect(busyTarget.downCommandsReceived).toEqual([]);
    expect(busyTarget.getHaltResetCalls()).toEqual({ haltCalls: 0, resetCalls: 0 });

    // 3. Interrupted continuous session seals manifest as interrupted on disk & reopen preserves exact valid prefix
    const prefixTarget = createRttTargetHarness({ mode: 1, targetState: 'running', transport: 'winusb' });
    prefixTarget.attachCoordinator(coord);
    const termRecDir = path.join(dir, 'rec-term-manifest');
    const startedTerm = await coord.startRecording({
      mode: 'continuous',
      recordId: 'term-manifest',
      recordingDir: termRecDir,
      commitOnEachIngest: true,
    });
    expect(startedTerm.state).toBe('recording');
    const prefix = sample.subarray(0, 65);
    coord.onCustomEvent(prefixTarget.sessionHandle, 'orbitRttData', {
      consumerId: 'trace-term-manifest',
      sessionId: startedTerm.identity!.sessionId,
      sessionGeneration: startedTerm.identity!.sessionGeneration,
      bootGeneration: startedTerm.identity!.bootGeneration,
      bufferIndex: startedTerm.channelInfo!.upChannelIndex,
      batchSequence: 1,
      dataBase64: Buffer.from(prefix).toString('base64'),
    });
    await new Promise(r => setTimeout(r, 150));
    coord.onSessionTerminated(prefixTarget.sessionHandle);
    await vi.waitFor(() => {
      const st = coord.getStatus('term-manifest');
      expect(st?.state).toBe('incomplete');
      expect(st?.error?.errorCode).toBe('SessionTerminated');
    }, { timeout: 2000 });
    const manifestJson = JSON.parse(await fs.readFile(path.join(termRecDir, 'manifest.json'), 'utf8'));
    expect(manifestJson.state).toBe('interrupted');
    expect(manifestJson.failureCode).toBe('SessionTerminated');
    expect(manifestJson.committed.rawBytes).toBe(65);

    const inspectDisk = await coord.inspectRecordingDirectory(termRecDir);
    expect(inspectDisk.ok && inspectDisk.data.status).toBe('interrupted');
    expect(inspectDisk.ok && inspectDisk.data.isComplete).toBe(false);
    expect(inspectDisk.ok && inspectDisk.data.recoverableRawBytes).toBe(65);
    const reopenedTerm = await coord.openRecording(termRecDir, 'term-reopen');
    expect(reopenedTerm.ok && reopenedTerm.data.inspection.status).toBe('interrupted');
    const rawOut = path.join(dir, 'term-prefix.bin');
    const expPrefix = await coord.exportRawToFile('term-reopen', rawOut);
    expect(expPrefix.ok && expPrefix.data.exportedBytes).toBe(65);
    expect(expPrefix.ok && expPrefix.data.sha256).toBe(createHash('sha256').update(prefix).digest('hex'));
  });

  it('drains multi-batch 512 B STOP tail until physical RdOff==WrOff (including wrapped ring after pause) and shares batches cleanly', async () => {
    const sample = await fs.readFile('scripts/rtos/fixtures/samples/continuous.bin');
    const dir = await makeTempDir('orbit-trace-multidrain-');
    // Construct a ~4,322 B tail payload (> 8 x 512 B batches) that starts after an initial 66 B prefix
    const headPayload = sample.subarray(0, sample.length - 2);
    const repeatChunk = sample.subarray(10, sample.length - 2); // valid event frames
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < 75; i++) chunks.push(repeatChunk);
    const tailBody = Buffer.concat(chunks.map(c => Buffer.from(c)));
    const stopTail = sample.subarray(sample.length - 2);
    const expectedFullStream = Buffer.concat([Buffer.from(headPayload), tailBody, Buffer.from(stopTail)]);
    expect(tailBody.length).toBeGreaterThan(3500);

    // 1. Paused-then-STOP multi-batch drain across RMLink 512 B budget (models low-rate tail after pause)
    const target = createRttTargetHarness({ mode: 1, targetState: 'running', transport: 'rmlink-service' });
    // Pre-advance RTT pointers near end of 8192 B ring so the 4,322 B tail wraps across the ring boundary!
    target.setUpPointers(5800, 5800);
    target.setContinuousPayload(headPayload, stopTail);

    const coord = new TraceRecordingCoordinator({
      storageRoot: dir,
      workerFactory: () => new TraceWorkerClient(),
    });
    coordinatorsToDispose.push(coord);
    target.attachCoordinator(coord);

    const recDir = path.join(dir, 'rec-multi-tail');
    const started = await coord.startRecording({
      mode: 'continuous',
      recordId: 'multi-tail',
      recordingDir: recDir,
      maxBatchBytes: 512,
      pollIntervalMs: 25,
      stopDrainTimeoutMs: 4000,
    });
    expect(started.state).toBe('recording');

    // Wait until initial 66 B head has been streamed & committed
    await vi.waitFor(() => {
      const st = coord.getStatus('multi-tail');
      expect(st?.counters.bytesReceived).toBe(headPayload.length);
    }, { timeout: 2000 });

    // Explicitly pause host receiving, write >4 KB wrapped tail into target Up ring, then call STOP directly
    const paused = await coord.pauseReceiving('multi-tail');
    expect(paused?.state).toBe('paused');
    target.writeUpBytes(tailBody);
    expect(target.getSysViewWrOff()).not.toBe(target.getSysViewRdOff());

    // Subscribe a passive shared Channel 2 binary observer to prove single physical consumption & shared delivery
    const sharedConsumerBatches: Uint8Array[] = [];
    const rttCoord = (target.session as any).getOrCreateRttCoordinator();
    const sharedSub = await rttCoord.subscribe({
      consumerId: 'shared-observer',
      channelIndex: 2,
      deliveryKind: 'binary',
      deliveryMode: 'callback',
      conflictPolicy: 'best-effort',
      onBatch: (b: { bytes: Uint8Array }) => {
        if (b.bytes.length > 0) sharedConsumerBatches.push(Uint8Array.from(b.bytes));
      },
    });
    expect(sharedSub.ok).toBe(true);

    const stopped = await coord.stopRecording('multi-tail');
    expect(stopped?.state).toBe('stopped');
    expect(stopped?.manifest?.state).toBe('completed');
    expect(stopped?.targetState).toBe('stopped');
    expect(stopped?.counters.batchesReceived).toBeGreaterThanOrEqual(9);
    // Physical target Up pointers MUST be completely drained and reflected in finalRdOff/finalWrOff!
    const physRd = target.getSysViewRdOff();
    const physWr = target.getSysViewWrOff();
    expect(physRd).toBe(physWr);
    expect(stopped?.channelInfo?.finalRdOff).toBe(physRd);
    expect(stopped?.channelInfo?.finalWrOff).toBe(physWr);

    // Every batch size stayed within 512 B budget and shared consumer received exact combined tail bytes once
    expect(Buffer.concat(sharedConsumerBatches.map(b => Buffer.from(b)))).toEqual(
      Buffer.concat([tailBody, Buffer.from(stopTail)]),
    );
    // Shared observer leaves 3.4 unsubscribe({ drainLastBatch: true }) intact
    const sharedUnsub = await rttCoord.unsubscribe('shared-observer', 2, { drainLastBatch: true });
    expect(sharedUnsub.ok).toBe(true);

    await coord.closeRecording('multi-tail');
    const reopened = await coord.openRecording(recDir, 'multi-tail-verify');
    expect(reopened.ok && reopened.data.inspection.status).toBe('completed');
    const exportPath = path.join(dir, 'multi-tail.bin');
    const exported = await coord.exportRawToFile('multi-tail-verify', exportPath);
    expect(exported.ok).toBe(true);
    if (exported.ok) {
      expect(exported.data.exportedBytes).toBe(expectedFullStream.length);
      expect(exported.data.sha256).toBe(createHash('sha256').update(expectedFullStream).digest('hex'));
    }
  });

  it('seals partial committed prefix as interrupted with diagnostics on stopDrainTimeoutMs, backpressure, pause block, and DAP error', async () => {
    const sample = await fs.readFile('scripts/rtos/fixtures/samples/continuous.bin');
    const dir = await makeTempDir('orbit-trace-drain-fail-');
    const headPayload = sample.subarray(0, sample.length - 2);
    const repeatChunk = sample.subarray(10, sample.length - 2);
    const tailChunks: Uint8Array[] = [];
    for (let i = 0; i < 80; i++) tailChunks.push(repeatChunk);
    const largeTail = Buffer.concat(tailChunks.map(c => Buffer.from(c))); // ~4,640 B (> 9 x 512 B batches)

    // 1. Slow RTT read causes stopDrainTimeoutMs expiry partway through multi-batch STOP drain -> incomplete + interrupted manifest!
    const slowTarget = createRttTargetHarness({ mode: 1, targetState: 'running', transport: 'rmlink-service' });
    slowTarget.setContinuousPayload(headPayload, sample.subarray(sample.length - 2));
    const origExecute = slowTarget.backend.execute;
    let slowDownReads = false;
    slowTarget.backend.execute = vi.fn(async (cmd: any) => {
      if (cmd.cmd === 'readRtt' && slowDownReads) {
        await new Promise(r => setTimeout(r, 45));
      }
      return origExecute(cmd);
    });

    const coord = new TraceRecordingCoordinator({
      storageRoot: dir,
      workerFactory: () => new TraceWorkerClient(),
    });
    coordinatorsToDispose.push(coord);
    slowTarget.attachCoordinator(coord);

    const timeoutRecDir = path.join(dir, 'rec-drain-timeout');
    const s1 = await coord.startRecording({
      mode: 'continuous',
      recordId: 'drain-timeout',
      recordingDir: timeoutRecDir,
      maxBatchBytes: 512,
      pollIntervalMs: 25,
      stopDrainTimeoutMs: 140,
    });
    expect(s1.state).toBe('recording');
    await vi.waitFor(() => expect(coord.getStatus('drain-timeout')?.counters.bytesReceived).toBe(headPayload.length), { timeout: 2000 });

    await coord.pauseReceiving('drain-timeout');
    slowTarget.writeUpBytes(largeTail);
    slowDownReads = true;

    const stoppedTimeout = await coord.stopRecording('drain-timeout');
    expect(stoppedTimeout?.state).toBe('incomplete');
    expect(stoppedTimeout?.error?.errorCode).toBe('StopDrainTimeout');
    const physRdTimeout = slowTarget.getSysViewRdOff();
    const physWrTimeout = slowTarget.getSysViewWrOff();
    const expectedUnreadTimeout = physWrTimeout >= physRdTimeout
      ? physWrTimeout - physRdTimeout
      : 8192 - physRdTimeout + physWrTimeout;
    expect(expectedUnreadTimeout).toBeGreaterThan(0);
    expect(stoppedTimeout?.channelInfo?.finalRdOff).toBe(physRdTimeout);
    expect(stoppedTimeout?.channelInfo?.finalWrOff).toBe(physWrTimeout);
    expect(stoppedTimeout?.error?.diagnostics?.finalRdOff).toBe(physRdTimeout);
    expect(stoppedTimeout?.error?.diagnostics?.finalWrOff).toBe(physWrTimeout);
    expect(stoppedTimeout?.error?.diagnostics?.remainingUnreadBytes).toBe(expectedUnreadTimeout);
    expect(stoppedTimeout?.error?.diagnostics?.snapshotSource).toBe('target-readState');
    expect(stoppedTimeout?.manifest?.failureDiagnostics?.finalRdOff).toBe(physRdTimeout);
    expect(stoppedTimeout?.manifest?.failureDiagnostics?.finalWrOff).toBe(physWrTimeout);
    expect(stoppedTimeout?.manifest?.failureDiagnostics?.remainingUnreadBytes).toBe(expectedUnreadTimeout);
    expect(stoppedTimeout?.manifest?.state).toBe('interrupted');
    expect(stoppedTimeout?.manifest?.committed.rawBytes).toBe(stoppedTimeout?.counters.bytesReceived);
    expect(stoppedTimeout!.counters.committedRawBytes).toBeGreaterThan(headPayload.length);
    const timeoutInspect = await coord.inspectRecordingDirectory(timeoutRecDir);
    expect(timeoutInspect.ok && timeoutInspect.data.status).toBe('interrupted');
    expect(timeoutInspect.ok && timeoutInspect.data.recoverableRawBytes).toBe(stoppedTimeout?.counters.committedRawBytes);

    // 2. DAP readRtt error during STOP drain seals archive as failed (non-completed) with committed prefix preserved
    slowDownReads = false;
    const errTarget = createRttTargetHarness({ mode: 1, targetState: 'running', transport: 'rmlink-service' });
    errTarget.setContinuousPayload(headPayload, sample.subarray(sample.length - 2));
    const origErrExecute = errTarget.backend.execute;
    let failNextRead = false;
    errTarget.backend.execute = vi.fn(async (cmd: any) => {
      if (cmd.cmd === 'readRtt' && failNextRead) {
        return { ok: false, errorCode: 'SwdTransferFault', error: 'Simulated SWD fault during STOP tail drain' };
      }
      return origErrExecute(cmd);
    });
    errTarget.attachCoordinator(coord);
    const errRecDir = path.join(dir, 'rec-drain-err');
    const s2 = await coord.startRecording({
      mode: 'continuous',
      recordId: 'drain-dap-err',
      recordingDir: errRecDir,
      maxBatchBytes: 512,
      pollIntervalMs: 25,
    });
    expect(s2.state).toBe('recording');
    await vi.waitFor(() => expect(coord.getStatus('drain-dap-err')?.counters.bytesReceived).toBe(headPayload.length), { timeout: 2000 });
    await coord.pauseReceiving('drain-dap-err');
    errTarget.writeUpBytes(largeTail);
    failNextRead = true;

    const stoppedErr = await coord.stopRecording('drain-dap-err');
    expect(stoppedErr?.state).toBe('error');
    expect(stoppedErr?.error?.errorCode).toBe('SwdTransferFault');
    expect(stoppedErr?.manifest?.state).toBe('failed');
    expect(stoppedErr?.manifest?.committed.rawBytes).toBe(headPayload.length);

    // 3. Sustained host backpressure during STOP drain seals as interrupted StopDrainBackpressured
    const bpTarget = createRttTargetHarness({ mode: 1, targetState: 'running', transport: 'rmlink-service' });
    bpTarget.attachCoordinator(coord);
    const realWorker = new TraceWorkerClient();
    const bpCoord = new TraceRecordingCoordinator({
      storageRoot: dir,
      workerFactory: () => ({
        createRecording: p => realWorker.createRecording(p),
        ingestChunk: p => realWorker.ingestChunk(p),
        tryIngestChunk: () => Promise.resolve({
          ok: false,
          backpressure: true,
          errorCode: 'WriteQueueFull',
          message: 'Simulated full worker queue',
        }),
        waitForInputDrain: (timeoutMs = 100) => new Promise<boolean>(resolve => setTimeout(() => resolve(false), timeoutMs + 20)),
        markGap: p => realWorker.markGap(p),
        notifyTargetReset: p => realWorker.notifyTargetReset(p),
        flushRecording: id => realWorker.flushRecording(id),
        finishRecording: (id, reason, opts) => realWorker.finishRecording(id, reason, opts),
        closeRecording: id => realWorker.closeRecording(id),
        openRecording: o => realWorker.openRecording(o),
        inspectRecording: (d, v) => realWorker.inspectRecording(d, v),
        queryRange: (id, req) => realWorker.queryRange(id, req),
        queryLod: (id, req) => realWorker.queryLod(id, req),
        getSegments: id => realWorker.getSegments(id),
        getGaps: id => realWorker.getGaps(id),
        exportRawToFile: (id, out, o) => realWorker.exportRawToFile(id, out, o),
        getStats: id => realWorker.getStats(id),
        shutdown: r => realWorker.shutdown(r),
      }),
    });
    coordinatorsToDispose.push(bpCoord);
    bpTarget.attachCoordinator(bpCoord);
    bpTarget.setContinuousPayload(headPayload, sample.subarray(sample.length - 2));
    const bpRecDir = path.join(dir, 'rec-drain-bp');
    const s3 = await bpCoord.startRecording({
      mode: 'continuous',
      recordId: 'drain-bp',
      recordingDir: bpRecDir,
      backpressureWaitTimeoutMs: 2000,
      stopDrainTimeoutMs: 120,
    });
    expect(s3.state).toBe('recording');
    await vi.waitFor(() => expect(bpCoord.getStatus('drain-bp')?.counters.backpressurePauses).toBeGreaterThanOrEqual(1), { timeout: 2000 });
    const stoppedBp = await bpCoord.stopRecording('drain-bp');
    expect(stoppedBp?.state).toBe('incomplete');
    expect(stoppedBp?.error?.errorCode).toBe('StopDrainBackpressured');
    expect(stoppedBp?.manifest?.state).toBe('interrupted');
    await realWorker.shutdown().catch(() => {});

    // 4. Paused receiver failing to resume on STOP seals as interrupted StopDrainPaused with committed prefix preserved
    const pauseErrTarget = createRttTargetHarness({ mode: 1, targetState: 'running', transport: 'rmlink-service' });
    pauseErrTarget.attachCoordinator(coord);
    pauseErrTarget.setContinuousPayload(headPayload, sample.subarray(sample.length - 2));
    const s4 = await coord.startRecording({
      mode: 'continuous',
      recordId: 'drain-pause-fail',
      recordingDir: path.join(dir, 'rec-drain-pause-fail'),
      commitOnEachIngest: true,
    });
    expect(s4.state).toBe('recording');
    await vi.waitFor(() => expect(coord.getStatus('drain-pause-fail')?.counters.bytesReceived).toBe(headPayload.length), { timeout: 2000 });
    await coord.pauseReceiving('drain-pause-fail');
    pauseErrTarget.writeUpBytes(largeTail);
    const origHandleReq = (pauseErrTarget.session as any).handleRequest.bind(pauseErrTarget.session);
    (pauseErrTarget.session as any).handleRequest = async (req: any) => {
      if (req.command === 'orbitRttTransport' && req.arguments?.action === 'setBackpressure' && req.arguments?.paused === false) {
        (pauseErrTarget.session as any).sendResponse({
          type: 'response',
          seq: 999999,
          request_seq: req.seq,
          command: req.command,
          success: false,
          message: 'Simulated setBackpressure failure',
          body: { errorCode: 'TransportBusy' },
        });
        return;
      }
      return origHandleReq(req);
    };
    const stoppedPauseFail = await coord.stopRecording('drain-pause-fail');
    expect(stoppedPauseFail?.state).toBe('incomplete');
    expect(stoppedPauseFail?.error?.errorCode).toBe('StopDrainPaused');
    expect(stoppedPauseFail?.manifest?.state).toBe('interrupted');
    expect(stoppedPauseFail?.manifest?.committed.rawBytes).toBe(headPayload.length);
  });

  it('aligns final status, error.diagnostics, and disk failureDiagnostics to one coherent post-unsubscribe snapshot after drain timeout + late in-flight batch, and marks shared-consumer uncertainty honestly', async () => {
    const sample = await fs.readFile('scripts/rtos/fixtures/samples/continuous.bin');
    const dir = await makeTempDir('orbit-trace-r3-snapshot-');
    const truth = { available: true, evidence: 'test' as const };
    const caps = { rttStart: truth, rttEnumerate: truth, rttUpRead: truth, rttDownWrite: truth, ownerKind: 'cmsis-dap' as const };
    const budget = {
      ownerKind: 'cmsis-dap' as const,
      transport: 'rmlink-service' as const,
      maxBatchBytes: 512,
      minPollIntervalMs: 20,
      defaultPollIntervalMs: 50,
      maxBatchesPerTurn: 1,
      source: 'test' as const,
    };

    // Reproduce exact H7 R2 timeout numbers: paused at RdOff=2158, WrOff=7187 -> drain times out at RdOff=2670,
    // then in-flight 512 B batch advances RdOff to 3182 (4005 unread) before/during unsubscribe!
    let rdOff = 0;
    let wrOff = 0;
    let downRd = 0;
    let downWr = 0;
    let enableState = 0;
    let consumerId = '';
    let sharedRefCount = 0;
    const ringPayload = Buffer.concat([sample.subarray(0, 66), Buffer.alloc(446, 0x00)]); // 512 B valid chunk

    const mkEnum = () => ({
      controlBlockAddress: 0x20001000,
      upBuffers: [{
        direction: 'up' as const,
        index: 2,
        bufferAddress: 0x20004000,
        status: 'valid' as const,
        name: 'SysView',
        nameStatus: 'ok' as const,
        valid: true,
        bufferSize: 8192,
        rdOff,
        wrOff,
      }],
      downBuffers: [{
        direction: 'down' as const,
        index: 2,
        bufferAddress: 0x20003000,
        status: 'valid' as const,
        name: 'SysView',
        nameStatus: 'ok' as const,
        valid: true,
        bufferSize: 8,
        rdOff: downRd,
        wrOff: downWr,
      }],
      duplicateUpNames: [],
      duplicateDownNames: [],
    });

    const coord = new TraceRecordingCoordinator({
      storageRoot: dir,
      workerFactory: () => new TraceWorkerClient(),
    });
    coordinatorsToDispose.push(coord);

    const session: TraceSessionHandle = {
      id: 'vs-r3-snap',
      name: 'r3-snap',
      type: 'orbit',
      customRequest: (async (method: string, args: Record<string, unknown> = {}) => {
        if (method === 'orbitTraceTarget' && args.action === 'inspect') {
          rdOff = 0;
          return {
            ok: true,
            identity: { sessionId: 's-r3', sessionGeneration: 1, bootGeneration: 1, operationGeneration: 1, elfSha256: 'sha', elfPath: 'a.elf', device: 'H7' },
            rttCapabilities: caps,
            targetState: 'Running',
            ramRangesAvailable: true,
            ramRanges: [{ address: 0x20000000, size: 0x20000 }],
            rttBudgets: { channel0: budget, binaryChannel: budget },
            rttControlBlockAddress: 0x20001000,
            globalsValues: { enableState },
          };
        }
        if (method === 'orbitTraceTarget' && args.action === 'readState') {
          return {
            ok: true,
            sessionGeneration: 1,
            bootGeneration: 1,
            targetState: 'Running',
            globalsValues: { enableState },
            enumerate: mkEnum(),
          };
        }
        if (method === 'orbitRttTransport' && args.action === 'enumerate') {
          return { ok: true, data: mkEnum() };
        }
        if (method === 'orbitRttTransport' && args.action === 'subscribe') {
          consumerId = String(args.consumerId);
          return { ok: true, budget, bufferIndex: 2 };
        }
        if (method === 'orbitRttTransport' && args.action === 'writeDown') {
          downWr++;
          downRd++;
          const cmd = Buffer.from(String(args.dataBase64 ?? ''), 'base64')[0];
          enableState = cmd === SYSTEMVIEW_COMMAND_IDS.START ? 1 : 0;
          return { ok: true, data: { committedBytes: 1, committedWrOff: downWr, rdOff: downRd } };
        }
        if (method === 'orbitRttTransport' && args.action === 'drain') {
          // Batch 1 during drain advances rdOff from 2158 -> 2670, then returns timeout!
          rdOff = 2670;
          coord.onCustomEvent(session, 'orbitRttData', {
            consumerId,
            sessionId: 's-r3',
            sessionGeneration: 1,
            bootGeneration: 1,
            bufferIndex: 2,
            batchSequence: 1,
            dataBase64: ringPayload.toString('base64'),
            rdOff: 2158,
            wrOff,
            committedRdOff: 2670,
            overrun: false,
            congested: false,
          });
          // Simulate an in-flight batch whose IPC response/commit arrives AFTER drain returned timeout (2670 -> 3182)!
          setTimeout(() => {
            rdOff = 3182;
            coord.onCustomEvent(session, 'orbitRttData', {
              consumerId,
              sessionId: 's-r3',
              sessionGeneration: 1,
              bootGeneration: 1,
              bufferIndex: 2,
              batchSequence: 2,
              dataBase64: ringPayload.toString('base64'),
              rdOff: 2670,
              wrOff,
              committedRdOff: 3182,
              overrun: false,
              congested: false,
            });
          }, 15);
          return {
            ok: true,
            drained: false,
            reason: 'timeout',
            batchesDrained: 1,
            bytesDrained: 512,
            lastBatchSequence: 2,
            lastRdOff: 2670,
            lastWrOff: wrOff,
            bufferSize: 8192,
          };
        }
        if (method === 'orbitRttTransport' && args.action === 'unsubscribe') {
          return { ok: true, remainingRefCount: sharedRefCount, bufferIndex: 2, consumerId };
        }
        return { ok: true };
      }) as TraceSessionHandle['customRequest'],
    };

    coord.bindSession(session);
    const recDir = path.join(dir, 'rec-r3-timeout');
    const started = await coord.startRecording({
      mode: 'continuous',
      recordId: 'r3-timeout',
      recordingDir: recDir,
      stopDrainTimeoutMs: 50,
    });
    expect(started.state).toBe('recording');
    rdOff = 2158;
    wrOff = 7187;

    const res = await coord.stopRecording('r3-timeout');
    expect(res?.state).toBe('incomplete');
    expect(res?.error?.errorCode).toBe('StopDrainTimeout');
    // ALL THREE (channelInfo, error.diagnostics, disk manifest failureDiagnostics) MUST report the exact same settled snapshot (3182 / 7187 / 4005)!
    expect(res?.channelInfo?.finalRdOff).toBe(3182);
    expect(res?.channelInfo?.finalWrOff).toBe(7187);
    expect(res?.error?.diagnostics?.finalRdOff).toBe(3182);
    expect(res?.error?.diagnostics?.finalWrOff).toBe(7187);
    expect(res?.error?.diagnostics?.bufferSize).toBe(8192);
    expect(res?.error?.diagnostics?.remainingUnreadBytes).toBe(4005);
    expect(res?.error?.diagnostics?.remainingKnown).toBe(true);
    expect(res?.error?.diagnostics?.snapshotSource).toBe('target-readState');
    expect(res?.manifest?.state).toBe('interrupted');
    expect(res?.manifest?.committed.rawBytes).toBe(1024);
    expect(res?.manifest?.failureDiagnostics?.finalRdOff).toBe(3182);
    expect(res?.manifest?.failureDiagnostics?.finalWrOff).toBe(7187);
    expect(res?.manifest?.failureDiagnostics?.remainingUnreadBytes).toBe(4005);
    const diskManifest = JSON.parse(await fs.readFile(path.join(recDir, 'manifest.json'), 'utf8'));
    expect(diskManifest.failureDiagnostics.finalRdOff).toBe(3182);
    expect(diskManifest.failureDiagnostics.remainingUnreadBytes).toBe(4005);

    // 2. When another consumer remains subscribed on the shared channel (remainingRefCount > 0), mark remainingKnown=false / 'unknown' honestly!
    sharedRefCount = 1;
    enableState = 0;
    rdOff = 0;
    const sharedDir = path.join(dir, 'rec-r3-shared');
    const sShared = await coord.startRecording({
      mode: 'continuous',
      recordId: 'r3-shared',
      recordingDir: sharedDir,
      stopDrainTimeoutMs: 50,
    });
    expect(sShared.state).toBe('recording');
    const stoppedShared = await coord.stopRecording('r3-shared');
    expect(stoppedShared?.state).toBe('incomplete');
    expect(stoppedShared?.error?.diagnostics?.sharedOtherConsumers).toBe(1);
    expect(stoppedShared?.error?.diagnostics?.remainingKnown).toBe(false);
    expect(stoppedShared?.error?.diagnostics?.remainingUnreadBytes).toBe('unknown');
    expect(stoppedShared?.error?.diagnostics?.snapshotSource).toBe('shared-consumer-uncertain');
    expect(stoppedShared?.manifest?.failureDiagnostics?.remainingUnreadBytes).toBe('unknown');
    expect(stoppedShared?.manifest?.failureDiagnostics?.snapshotSource).toBe('shared-consumer-uncertain');
  });
});
