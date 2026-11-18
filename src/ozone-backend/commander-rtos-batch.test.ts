import { describe, expect, it, vi } from 'vitest';
import { OzoneBackend } from './commander';

function setup() {
  const backend = Object.create(OzoneBackend.prototype) as OzoneBackend;
  const readMemoryBatch = vi.fn(async (reads: { address: number; size: number }[]) => ({ ok: true, data: {
    reads: reads.map(read => ({ address: read.address, bytes: new Uint8Array(read.size) })),
  } }));
  Object.assign(backend, { localTargetAccessBlocked: () => false, sessionTarget: { readMemoryBatch } });
  return { backend, readMemoryBatch };
}
describe('selected-owner RTOS memory batches', () => {
  it('sends a bounded live batch at background priority through the existing owner', async () => {
    const { backend, readMemoryBatch } = setup(), controller = new AbortController();
    const reads = [{ address: 0x20000000, size: 100 }, { address: 0x20002000, size: 20 }];
    expect(await backend.execute({ cmd: 'readMemoryBatch', reads, signal: controller.signal })).toMatchObject({ ok: true, data: [expect.any(Uint8Array), expect.any(Uint8Array)] });
    expect(readMemoryBatch).toHaveBeenCalledWith(reads, { priority: 'background', signal: controller.signal });
  });
  it('rejects excessive work before dispatch and keeps missing/short/misaddressed responses as errors', async () => {
    const { backend, readMemoryBatch } = setup();
    expect(await backend.execute({ cmd: 'readMemoryBatch', reads: [{ address: 0x20000000, size: 257 }] })).toMatchObject({ ok: false, errorCode: 'BudgetExceeded' });
    expect(readMemoryBatch).not.toHaveBeenCalled();
    readMemoryBatch.mockResolvedValue({ ok: true, data: { reads: [{ address: 0x20000004, bytes: new Uint8Array(4) }] } });
    expect(await backend.execute({ cmd: 'readMemoryBatch', reads: [{ address: 0x20000000, size: 4 }] })).toMatchObject({ ok: false, errorCode: 'ShortRead' });
  });
});
