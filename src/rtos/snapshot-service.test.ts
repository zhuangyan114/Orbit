import { describe, expect, it, vi } from 'vitest';
import { syntheticTarget } from './target-fixture';
import { testCatalog } from './test-fixture';
import { RtosSnapshotService, SnapshotHost } from './snapshot-service';

function setup() {
  const target = syntheticTarget();
  const host: SnapshotHost = { identity: () => ({ ...target.request.identity }), available: () => true,
    targetState: () => 'Halted', catalog: async () => testCatalog(), ram: target.request.ram,
    read: async (address, size) => ({ bytes: await target.request.read(address, size), queueWaitMs: 0 }) };
  return { target, host, service: new RtosSnapshotService(host) };
}
describe('RTOS snapshot refresh service', () => {
  it('reports per-column capabilities from metadata without target reads', async () => {
    const { host, service } = setup(), read = vi.spyOn(host, 'read');
    const result = await service.capabilities();
    expect(result.capabilities.taskSnapshot.available).toBe(true);
    expect(result.capabilities.stackBounds).toMatchObject({ available: false, reason: expect.any(String) });
    expect(result.capabilities.runtimeCounters.available).toBe(true);
    expect(result.capabilities.runtimePercent.available).toBe(false);
    expect(read).not.toHaveBeenCalled(); service.dispose();
  });
  it('coalesces overlapping requests without a queue', async () => {
    const { host, service } = setup(), catalog = vi.spyOn(host, 'catalog');
    const a = service.refresh(), b = service.refresh();
    expect(a).toBe(b); expect((await a).consistency).toBe('halted-consistent');
    expect(catalog).toHaveBeenCalledTimes(1);
    service.dispose();
  });
  it.each(['control', 'boot', 'session', 'dispose'])('discards late reads after %s', async change => {
    const { target, host, service } = setup();
    let release!: () => void;
    host.read = async (address, size) => { await new Promise<void>(resolve => { release = resolve; }); return { bytes: target.bytes.subarray(address, address + size), queueWaitMs: 0 }; };
    const pending = service.refresh(); await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    if (change === 'control') service.invalidate('control');
    if (change === 'boot') target.request.identity.bootGeneration++;
    if (change === 'session') target.request.identity.sessionId = 'replacement';
    if (change === 'dispose') service.dispose();
    release(); await expect(pending).rejects.toThrow('identity changed');
    expect(service.stale('late')).toBeUndefined(); service.dispose();
  });
  it('preserves stale acquisition identity, never across a reboot', async () => {
    const { target, service } = setup(), first = await service.refresh();
    service.invalidate('control');
    const stale = service.stale('busy')!; expect(stale.consistency).toBe('stale'); expect(stale.startedAt).toBe(first.startedAt);
    target.request.identity.bootGeneration++; expect(service.stale('busy')).toBeUndefined(); service.dispose();
  });
  it('stops a timer during an in-flight refresh without publishing late events', async () => {
    const { host, service } = setup();
    let release!: () => void;
    host.catalog = () => new Promise(resolve => { release = () => resolve(testCatalog()); });
    const publish = vi.fn(); service.start(publish, 200); service.stop(); release();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(publish).not.toHaveBeenCalled(); service.dispose();
  });

  it('rounds diagnostic timings cleanly to prevent sub-millisecond IEEE-754 float jitter in the UI', async () => {
    const { target, host, service } = setup();
    host.read = async (address, size) => ({
      bytes: await target.request.read(address, size),
      queueWaitMs: 0.005123456789,
    });
    const snapshot = await service.refresh();
    expect(String(snapshot.diagnostics.queueWaitMs).length).toBeLessThanOrEqual(5);
    expect(String(snapshot.diagnostics.ioMs).length).toBeLessThanOrEqual(7);
    expect(String(snapshot.diagnostics.parseMs).length).toBeLessThanOrEqual(7);
    expect(String(snapshot.diagnostics.totalMs).length).toBeLessThanOrEqual(7);
    service.dispose();
  });
});
