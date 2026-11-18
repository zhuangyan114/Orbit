import { describe, expect, it, vi } from 'vitest';
import { DapSession, DebugProtocolMessage } from './dap-session';
import { OzoneBackend } from '../ozone-backend/commander';
import { testCatalog } from '../rtos/test-fixture';
import { syntheticTarget } from '../rtos/target-fixture';

function setup() {
  const target = syntheticTarget(), catalog = testCatalog(), delta = 0x24000000;
  catalog.roots.forEach(root => { root.address! += delta; });
  const bytes = Buffer.from(target.bytes);
  for (let index = 0; index < bytes.length; index += 4) {
    const value = bytes.readUInt32LE(index);
    if (value >= 0x1000 && value < 0x10000) bytes.writeUInt32LE(value + delta, index);
  }
  const backend = { execute: vi.fn(async (command: any) => {
    if (command.cmd === 'getSymbolCatalog') return { ok: true, data: catalog };
    if (command.cmd === 'readMemory') return { ok: true, data: { data: [...bytes.subarray(command.address - delta, command.address - delta + command.size)] } };
    if (command.cmd === 'readMemoryBatch') return { ok: true, data: command.reads.map((read: any) => bytes.subarray(read.address - delta, read.address - delta + read.size)) };
    if (command.cmd === 'writeMemory') return { ok: true };
    return { ok: false, error: `unexpected ${command.cmd}` };
  }) } as unknown as OzoneBackend;
  const session = new DapSession(backend), messages: DebugProtocolMessage[] = [];
  session.on('send', message => messages.push(message));
  Object.assign(session, { phase: 'connected', targetConnectionEstablished: true, _device: 'STM32H723VGT6', _loadedFirmware: { sha256: 'fixture' } });
  const request = (seq: number, args = {}) => (session as any).handleRequest({ type: 'request', seq, command: 'orbitRtosSnapshot', arguments: args });
  return { session, backend, messages, request };
}
describe('DAP RTOS snapshot ownership and fences', () => {
  it('reads through the selected backend in live mode, yielding the gate between <=256-byte slices', async () => {
    const { session, backend, messages, request } = setup(); (session as any).targetRunning = true;
    await request(1);
    expect(messages.find(message => message.request_seq === 1)?.body).toMatchObject({ consistency: 'live-best-effort', tasks: expect.any(Array) });
    const reads = vi.mocked(backend.execute).mock.calls.map(call => call[0]).filter(command => command.cmd === 'readMemoryBatch');
    expect(reads.length).toBeGreaterThan(2);
    expect(reads.every(command => command.cmd === 'readMemoryBatch' && command.reads.length <= 4 && command.reads.every(read => read.size <= 256))).toBe(true);
    expect(vi.mocked(backend.execute).mock.calls.some(call => ['halt', 'run', 'connect'].includes(call[0].cmd))).toBe(false);
    expect((session as any).targetReadInProgress).toBe(false);
  });
  it('cancels a running snapshot and drains its read before a standard memory write', async () => {
    const { session, backend, messages, request } = setup();
    const original = vi.mocked(backend.execute).getMockImplementation()!;
    let release!: () => void;
    vi.mocked(backend.execute).mockImplementation(async (command: any) => {
      if (command.cmd === 'readMemory' || command.cmd === 'readMemoryBatch') await new Promise<void>(resolve => { release = resolve; });
      return original(command);
    });
    const pending = request(1); await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const writing = (session as any).handleWriteMemory({ type: 'request', seq: 2, command: 'writeMemory', arguments: { memoryReference: '0x24001000', data: 'AQAAAA==' } });
    await vi.waitFor(() => expect((session as any).controlInProgress).toBe(true));
    release(); await Promise.all([pending, writing]);
    expect(messages.find(message => message.request_seq === 1)?.body).toMatchObject({ consistency: 'unavailable', tasks: [], completion: 'unknown' });
    expect((session as any).targetReadInProgress).toBe(false);
    expect(messages.find(message => message.request_seq === 2)?.body.bytesWritten).toBe(4);
  });
  it('routes standard memory writes through the control generation and drains reads', async () => {
    const { session, messages } = setup(), epoch = (session as any).readCancelEpoch;
    await (session as any).handleWriteMemory({ type: 'request', seq: 3, command: 'writeMemory', arguments: { memoryReference: '0x24001000', data: 'AQAAAA==' } });
    expect((session as any).readCancelEpoch).toBeGreaterThan(epoch);
    expect((session as any).controlInProgress).toBe(false);
    expect(messages.find(message => message.request_seq === 3)?.body.bytesWritten).toBe(4);
  });
  it('does not read while unavailable and validates options before target access', async () => {
    const { session, backend, messages, request } = setup();
    await request(1, { action: 'other' }); expect(backend.execute).not.toHaveBeenCalled();
    await request(2, { action: 'refresh', objectAddresses: ['bad'] }); expect(backend.execute).not.toHaveBeenCalled();
    expect(messages.find(message => message.request_seq === 2)?.body).toMatchObject({
      consistency: 'unavailable',
      errorCode: 'InvalidAddress',
    });
    (session as any).phase = 'terminating'; await request(3);
    expect(messages.find(message => message.request_seq === 3)?.success).toBe(false);
  });
  it('includes object summary on request and forwards valid objectAddresses', async () => {
    const { session, messages, request } = setup();
    await request(1, { action: 'refresh', includeObjects: true, includeWaitDetails: true, objectAddresses: [0x24005000] });
    const body = messages.find(message => message.request_seq === 1)?.body;
    expect(body).toMatchObject({
      consistency: 'halted-consistent',
      objects: {
        registryCount: 0,
        globalCount: 0,
        listDiscoveredCount: 0,
        objects: [],
      },
    });
  });
});
