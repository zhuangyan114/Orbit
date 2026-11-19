import { describe, expect, it, vi } from 'vitest';
import { DapSession, DebugProtocolMessage } from './dap-session';
import type { SymbolCatalog } from '../symbols/symbol-catalog';

function createCatalogAndMemory() {
  const ramBase = 0x20000000;
  const ram = Buffer.alloc(0x20000, 0);
  // fixtureCapture at 0x20000000: mode=3, frozen=1, generation=2, size=1024, wrOff=600, rdOff=700, enabledBeforeStop=1, buffer=0x20002000
  ram.writeUInt32LE(3, 0x00);
  ram.writeUInt32LE(1, 0x04);
  ram.writeUInt32LE(2, 0x08);
  ram.writeUInt32LE(1024, 0x0c);
  ram.writeUInt32LE(600, 0x10);
  ram.writeUInt32LE(700, 0x14);
  ram.writeUInt32LE(1, 0x18);
  ram.writeUInt32LE(0x20002000, 0x1c);

  // _SYSVIEW_Globals at 0x20001000 (Post-Mortem layout)
  ram.writeUInt8(0, 0x1000); // EnableState = 0
  ram.writeUInt8(2, 0x1001); // UpChannel = 2
  ram.writeUInt32LE(64_000_000, 0x1004); // SysFreq
  ram.writeUInt32LE(64_000_000, 0x1008); // CPUFreq
  ram.writeUInt32LE(0x11223344, 0x100c); // LastTxTimeStamp
  ram.writeUInt32LE(0x20000000, 0x1010); // RAMBaseAddress
  ram.writeUInt32LE(321, 0x1014); // PacketCount

  for (let i = 0; i < 1024; i++) {
    ram[0x2000 + i] = (i * 7 + 3) & 0xff;
  }

  const catalog: SymbolCatalog = {
    types: {
      '0x1': { name: 'unsigned char', kind: 'base', byteSize: 1 },
      '0x2': { name: 'unsigned int', kind: 'base', byteSize: 4 },
      '0x3': { name: 'void *', kind: 'pointer', byteSize: 4 },
      '0x10': {
        name: 'SEGGER_SYSVIEW_CORE_CONTEXT',
        kind: 'struct',
        byteSize: 24,
        fields: [
          { name: 'EnableState', typeOffset: '0x1', byteOffset: 0 },
          { name: 'UpChannel', typeOffset: '0x1', byteOffset: 1 },
          { name: 'RecursionCnt', typeOffset: '0x1', byteOffset: 2 },
          { name: 'SysFreq', typeOffset: '0x2', byteOffset: 4 },
          { name: 'CPUFreq', typeOffset: '0x2', byteOffset: 8 },
          { name: 'LastTxTimeStamp', typeOffset: '0x2', byteOffset: 12 },
          { name: 'RAMBaseAddress', typeOffset: '0x2', byteOffset: 16 },
          { name: 'PacketCount', typeOffset: '0x2', byteOffset: 20 },
        ],
      },
      '0x11': {
        name: 'SEGGER_SYSVIEW_GLOBALS',
        kind: 'struct',
        byteSize: 28,
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
    },
    roots: [
      { id: 'rtt', expression: '_SEGGER_RTT', file: 'SEGGER_RTT.c', typeOffset: '', address: 0x20000800, size: 168, pointerDepth: 0 },
      { id: 'sv', expression: '_SYSVIEW_Globals', file: 'SEGGER_SYSVIEW.c', typeOffset: '0x11', address: 0x20001000, size: 28, pointerDepth: 0 },
      { id: 'fc', expression: 'fixtureCapture', file: 'main.c', typeOffset: '0x20', address: 0x20000000, size: 32, pointerDepth: 0 },
    ],
  };

  return { ramBase, ram, catalog };
}

function setupSession(supportsProbeSubscriptions = true) {
  const { ramBase, ram, catalog } = createCatalogAndMemory();
  const enumResult = {
    controlBlockAddress: 0x20000800,
    maxUpBuffers: 3,
    maxDownBuffers: 1,
    upBuffers: [
      { direction: 'up', index: 0, descriptorAddress: 0x20000818, configured: true, valid: true, status: 'valid', name: 'Terminal', nameAddress: 0x08001000, nameStatus: 'ok', duplicateName: false, bufferAddress: 0x20001800, bufferSize: 512, wrOff: 0, rdOff: 0, flags: 0, mode: 0 },
      { direction: 'up', index: 1, descriptorAddress: 0x20000830, configured: true, valid: true, status: 'valid', name: 'FixtureReserved', nameAddress: 0x08001010, nameStatus: 'ok', duplicateName: false, bufferAddress: 0x20001a00, bufferSize: 16, wrOff: 0, rdOff: 0, flags: 0, mode: 0 },
      { direction: 'up', index: 2, descriptorAddress: 0x20000848, configured: true, valid: true, status: 'valid', name: 'SysView', nameAddress: 0x08001020, nameStatus: 'ok', duplicateName: false, bufferAddress: 0x20002000, bufferSize: 1024, wrOff: 600, rdOff: 700, flags: 0, mode: 0 },
    ],
    downBuffers: [],
    duplicateUpNames: [],
    duplicateDownNames: [],
    validUpCount: 3,
    validDownCount: 0,
    corruptCount: 0,
    unusedCount: 1,
  };

  const backend = {
    supportsProbeSubscriptions,
    execute: vi.fn(async (cmd: any) => {
      if (cmd.cmd === 'getTargetState') return { ok: true, data: 'running' };
      if (cmd.cmd === 'getSymbolCatalog') return { ok: true, data: catalog };
      if (cmd.cmd === 'getRttCapabilities') {
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
      if (cmd.cmd === 'enumerateRtt') return { ok: true, data: enumResult };
      if (cmd.cmd === 'readMemory') {
        const off = (cmd.address >>> 0) - ramBase;
        return { ok: true, data: { data: [...ram.subarray(off, off + cmd.size)] } };
      }
      if (cmd.cmd === 'halt' || cmd.cmd === 'run' || cmd.cmd === 'reset') {
        return { ok: true, data: { state: 'Halted' } };
      }
      return { ok: false, error: `unexpected ${cmd.cmd}` };
    }),
    configureNativeSteps: vi.fn(),
    dispose: vi.fn(),
  };

  const session = new DapSession(backend as any);
  const messages: DebugProtocolMessage[] = [];
  session.on('send', m => messages.push(m));
  Object.assign(session, {
    phase: 'connected',
    targetConnectionEstablished: true,
    _device: 'STM32H723VGT6',
    _loadedFirmware: { sha256: 'sha-pm-test', path: 'test.elf' },
    targetRunning: true,
    rttOwnerKind: 'cmsis-dap',
    rttTransportKind: supportsProbeSubscriptions ? 'rmlink-service' : 'winusb',
  });

  let seq = 1;
  const req = async (command: string, args: Record<string, unknown> = {}) => {
    const mySeq = seq++;
    await (session as any).handleRequest({ type: 'request', seq: mySeq, command, arguments: args });
    return messages.find(m => m.type === 'response' && m.request_seq === mySeq)!;
  };
  return { session, backend, messages, ram, req };
}

describe('DapSession orbitTraceTarget & bootGeneration events', () => {
  it('inspects SystemView metadata and reads live memory ranges in bounded chunks without halt/reset or RdOff writes', async () => {
    const { backend, ram, req } = setupSession(true);

    const inspectRes = await req('orbitTraceTarget', { action: 'inspect' });
    expect(inspectRes.success).toBe(true);
    expect(inspectRes.body.ok).toBe(true);
    expect(inspectRes.body.targetState).toBe('Running');
    expect(inspectRes.body.metadataLayout.globals.postMortemCompiled).toBe(true);
    expect(inspectRes.body.globalsValues).toMatchObject({ enableState: 0, packetCount: 321 });
    expect(inspectRes.body.fixtureCaptureValues).toMatchObject({ mode: 3, frozen: 1, generation: 2, wrOff: 600, rdOff: 700 });

    const readRes = await req('orbitTraceTarget', {
      action: 'readMemoryRange',
      address: 0x20002000,
      size: 600,
      expectedSessionGeneration: inspectRes.body.identity.sessionGeneration,
      expectedBootGeneration: inspectRes.body.identity.bootGeneration,
    });
    expect(readRes.success).toBe(true);
    expect(readRes.body.bytesRead).toBe(600);
    expect(Buffer.from(readRes.body.dataBase64, 'base64').equals(ram.subarray(0x2000, 0x2000 + 600))).toBe(true);

    const calls = vi.mocked(backend.execute).mock.calls.map(c => c[0]);
    expect(calls.some(c => ['halt', 'run', 'reset', 'writeMemory', 'writeRtt'].includes(c.cmd))).toBe(false);
    const memReads = calls.filter(c => c.cmd === 'readMemory');
    expect(memReads.every(c => c.liveAccess === true && c.size <= 128)).toBe(true);
  });

  it('rejects out-of-RAM readMemoryRange and bootGeneration mismatches cleanly', async () => {
    const { session, messages, req } = setupSession(false);

    const oob = await req('orbitTraceTarget', {
      action: 'readMemoryRange',
      address: 0x08000000,
      size: 64,
    });
    expect(oob.success).toBe(false);
    expect(oob.body.errorCode).toBe('InvalidAddress');

    const inspectRes = await req('orbitTraceTarget', { action: 'inspect' });
    (session as any).advanceRtosBootGeneration('test-reset');
    const bootEvt = messages.find(m => m.type === 'event' && m.event === 'orbitTraceBootChanged');
    expect(bootEvt?.body.bootGeneration).toBe(inspectRes.body.identity.bootGeneration + 1);

    const stale = await req('orbitTraceTarget', {
      action: 'readMemoryRange',
      address: 0x20002000,
      size: 64,
      expectedBootGeneration: inspectRes.body.identity.bootGeneration,
    });
    expect(stale.success).toBe(false);
    expect(stale.body.errorCode).toBe('SessionChanged');
  });
});
