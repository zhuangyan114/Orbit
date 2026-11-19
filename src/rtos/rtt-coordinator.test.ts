import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resolveRttTransportBudget,
  RttChannelBatch,
  RttConsumerDropEvent,
  RttConsumptionCoordinator,
  RttCoordinatorHost,
  RttIdentity,
} from './rtt-coordinator';
import { RttCapabilities } from '../ozone-backend/rtt-contract';

class SimulatedPhysicalRttHost implements RttCoordinatorHost {
  sessionId = 'sess-1';
  sessionGeneration = 1;
  bootGeneration = 1;
  operationGeneration = 1;
  owner = 'cmsis-dap';
  transport = 'winusb';
  available = true;
  controlInProgress = false;
  terminating = false;
  xrActive = false;
  cbAddress = 0x20000100;

  rings = new Map<number, { buf: Uint8Array; size: number; wrOff: number; rdOff: number; overruns: number }>([
    [0, { buf: new Uint8Array(256), size: 256, wrOff: 0, rdOff: 0, overruns: 0 }],
    [1, { buf: new Uint8Array(256), size: 256, wrOff: 0, rdOff: 0, overruns: 0 }],
  ]);

  enumData: any = {
    controlBlockAddress: 0x20000100,
    maxUpBuffers: 3,
    maxDownBuffers: 1,
    upBuffers: [
      { direction: 'up', index: 0, configured: true, valid: true, status: 'valid', name: 'Terminal', nameStatus: 'ok', duplicateName: false, bufferAddress: 0x20001000, bufferSize: 256, wrOff: 0, rdOff: 0, flags: 0, mode: 0 },
      { direction: 'up', index: 1, configured: true, valid: true, status: 'valid', name: 'SysView', nameStatus: 'ok', duplicateName: false, bufferAddress: 0x20001100, bufferSize: 256, wrOff: 0, rdOff: 0, flags: 0, mode: 0 },
    ],
    downBuffers: [
      { direction: 'down', index: 0, configured: true, valid: true, status: 'valid', name: 'SysView', nameStatus: 'ok', duplicateName: false, bufferAddress: 0x20001200, bufferSize: 64, wrOff: 0, rdOff: 0, flags: 0, mode: 0 },
    ],
    duplicateUpNames: [],
    duplicateDownNames: [],
    validUpCount: 2,
    validDownCount: 1,
    corruptCount: 0,
    unusedCount: 1,
  };

  capabilities: RttCapabilities = {
    ownerKind: 'cmsis-dap',
    rttStart: { available: true, evidence: 'offline' },
    rttEnumerate: { available: true, evidence: 'offline' },
    rttUpRead: { available: true, evidence: 'offline' },
    rttDownWrite: { available: true, evidence: 'offline' },
  };

  startCalls = 0;
  stopCalls = 0;
  readCalls = new Map<number, number>();
  rdOffAdvances = new Map<number, number>();
  writeCalls = 0;
  gatePriorityLog: string[] = [];
  controlGateCalls = 0;
  ownerLostEvents: string[] = [];
  ownerFailure: string | null = null;
  pendingReadResolver: ((res?: any) => void) | null = null;
  holdNextRead = false;

  pushTargetBytes(channel: number, bytes: Uint8Array | string): void {
    const raw = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes;
    const ring = this.rings.get(channel)!;
    for (const b of raw) {
      const nextWr = (ring.wrOff + 1) % ring.size;
      if (nextWr === ring.rdOff) {
        ring.overruns++;
        continue;
      }
      ring.buf[ring.wrOff] = b;
      ring.wrOff = nextWr;
    }
  }

  identity(): RttIdentity {
    return {
      sessionId: this.sessionId,
      sessionGeneration: this.sessionGeneration,
      bootGeneration: this.bootGeneration,
      operationGeneration: this.operationGeneration,
    };
  }
  ownerKind(): string { return this.owner; }
  transportKind(): string { return this.transport; }
  async getRttCapabilities(): Promise<RttCapabilities> { return this.capabilities; }
  async ensureControlBlockAddress() { return { ok: true as const, address: this.cbAddress, source: 'elf-symbol' as const }; }
  isTargetAvailable(): boolean { return this.available; }
  isControlInProgress(): boolean { return this.controlInProgress; }
  isTerminating(): boolean { return this.terminating; }
  isXrSamplingActive(): boolean { return this.xrActive; }

  acquireReadGate(priority: 'watch' | 'background'): boolean {
    this.gatePriorityLog.push(priority);
    return !this.controlInProgress;
  }
  releaseReadGate(): void {}

  async startRtt() {
    this.startCalls++;
    if (this.ownerFailure) {
      return { ok: false as const, errorCode: this.ownerFailure, error: `${this.ownerFailure}: failed` };
    }
    return { ok: true as const, data: {} };
  }
  async stopRtt() {
    this.stopCalls++;
    return { ok: true as const, data: {} };
  }
  async enumerateRtt() {
    return { ok: true as const, data: this.enumData };
  }
  async readRtt(bufferIndex: number, size: number) {
    this.readCalls.set(bufferIndex, (this.readCalls.get(bufferIndex) ?? 0) + 1);
    const perform = () => {
      if (this.ownerFailure) {
        return { ok: false as const, errorCode: this.ownerFailure, error: `${this.ownerFailure}: failed` };
      }
      const ring = this.rings.get(bufferIndex);
      if (!ring) return { ok: false as const, errorCode: 'RttInvalidBufferIndex', error: 'missing ring' };
      const out: number[] = [];
      let rd = ring.rdOff;
      while (rd !== ring.wrOff && out.length < size) {
        out.push(ring.buf[rd]);
        rd = (rd + 1) % ring.size;
      }
      if (rd !== ring.rdOff) {
        ring.rdOff = rd;
        this.rdOffAdvances.set(bufferIndex, (this.rdOffAdvances.get(bufferIndex) ?? 0) + 1);
      }
      const overrun = ring.overruns > 0;
      return {
        ok: true as const,
        data: {
          bytes: Uint8Array.from(out),
          rdOff: ring.rdOff,
          wrOff: ring.wrOff,
          committedRdOff: ring.rdOff,
          bufferSize: ring.size,
          overrun,
        },
      };
    };
    if (this.holdNextRead) {
      this.holdNextRead = false;
      return new Promise<any>(resolve => {
        this.pendingReadResolver = (override?: any) => resolve(override ?? perform());
      });
    }
    return perform();
  }
  async writeRtt(_bufferIndex: number, bytes: Uint8Array) {
    this.writeCalls++;
    return { ok: true as const, data: { committedBytes: bytes.length, completion: 'completed' } };
  }
  async withWriteControlGate(run: () => Promise<any>) {
    this.controlGateCalls++;
    return run();
  }
  onOwnerLost(errorCode: string): void { this.ownerLostEvents.push(errorCode); }
  onRttUnavailable(): void {}
}

describe('RttConsumptionCoordinator', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fans out a single physical read and single RdOff advance to shared consumers while interleaving text & binary channels', async () => {
    const host = new SimulatedPhysicalRttHost();
    const coordinator = new RttConsumptionCoordinator(host);

    const textChunks: Uint8Array[] = [];
    const traceA: RttChannelBatch[] = [];
    const traceB: RttChannelBatch[] = [];

    const subText = await coordinator.subscribe({
      consumerId: 'rtt-log',
      channelIndex: 0,
      deliveryKind: 'text',
      pollIntervalMs: 10,
      onBatch: b => { textChunks.push(b.bytes); },
    });
    const subTraceA = await coordinator.subscribe({
      consumerId: 'sysview-recorder',
      channelName: 'SysView',
      deliveryKind: 'binary',
      pollIntervalMs: 10,
      onBatch: b => { traceA.push(b); },
    });
    const subTraceB = await coordinator.subscribe({
      consumerId: 'sysview-inspector',
      channelName: 'SysView',
      deliveryKind: 'binary',
      pollIntervalMs: 10,
      onBatch: b => { traceB.push(b); },
    });

    // Duplicate subscription deduplication preserves refCount=2.
    const dupSub = await coordinator.subscribe({
      consumerId: 'sysview-inspector',
      channelName: 'SysView',
      deliveryKind: 'binary',
      pollIntervalMs: 10,
      onBatch: b => { traceB.push(b); },
    });

    expect(subText.ok && subText.bufferIndex).toBe(0);
    expect(subTraceA.ok && subTraceA.bufferIndex).toBe(1);
    expect(subTraceB.ok && subTraceB.refCount).toBe(2);
    expect(dupSub.ok && dupSub.deduplicated && dupSub.refCount).toBe(2);

    const rawTrace = new Uint8Array([0x00, 0x80, 0xff, 0x1b, 0x5b, 0x32, 0x4a, 0x0d, 0x0a, 0x42]);
    host.pushTargetBytes(0, 'hello ');
    host.pushTargetBytes(1, rawTrace);

    await vi.advanceTimersByTimeAsync(12);
    await Promise.resolve();
    await Promise.resolve();

    host.pushTargetBytes(0, 'world\r\n');
    await vi.advanceTimersByTimeAsync(12);
    await Promise.resolve();

    expect(Buffer.concat(textChunks).toString('utf8')).toBe('hello world\r\n');
    expect(traceA).toHaveLength(1);
    expect(traceB).toHaveLength(1);
    expect(traceA[0].bytes).toEqual(rawTrace);
    expect(traceB[0].bytes).toEqual(rawTrace);
    // Physical RdOff advanced ONCE for channel 1 despite 2 consumers!
    expect(host.rdOffAdvances.get(1)).toBe(1);

    // Stopping one consumer keeps the second consumer & text channel active, then drainLastBatch stops channel 1 cleanly.
    const unsubA = await coordinator.unsubscribe('sysview-recorder', 1);
    expect(unsubA.remainingRefCount).toBe(1);
    expect(host.stopCalls).toBe(0);

    const finalBytes = new Uint8Array([0x11, 0x22, 0x33]);
    host.pushTargetBytes(1, finalBytes);
    const unsubB = await coordinator.unsubscribe('sysview-inspector', 1, { drainLastBatch: true });
    expect(unsubB.remainingRefCount).toBe(0);
    expect(unsubB.drainedBatch?.isFinal).toBe(true);
    expect(unsubB.drainedBatch?.bytes).toEqual(finalBytes);
    expect(host.stopCalls).toBe(0); // channel 0 is still active!

    // Text channel 0 still receives data after channel 1 unsubscribed.
    host.pushTargetBytes(0, 'after-trace-stop\n');
    await vi.advanceTimersByTimeAsync(12);
    expect(Buffer.concat(textChunks).toString('utf8')).toContain('after-trace-stop\n');

    await coordinator.unsubscribe('rtt-log', 0);
    expect(host.stopCalls).toBe(1);

    // Resume after full stop.
    const resumedChunks: Uint8Array[] = [];
    const subAgain = await coordinator.subscribe({
      consumerId: 'sysview-resumed',
      channelName: 'SysView',
      deliveryKind: 'binary',
      pollIntervalMs: 10,
      onBatch: b => { resumedChunks.push(b.bytes); },
    });
    expect(subAgain.ok).toBe(true);
    host.pushTargetBytes(1, new Uint8Array([0xfe, 0xca]));
    await vi.advanceTimersByTimeAsync(12);
    expect(resumedChunks.map(x => [...x]).flat()).toEqual([0xfe, 0xca]);

    coordinator.dispose();
  });

  it('rejects duplicate, missing, or unsupported channel names explicitly without heuristic fallback', async () => {
    const host = new SimulatedPhysicalRttHost();
    const coordinator = new RttConsumptionCoordinator(host);

    const missing = await coordinator.subscribe({ consumerId: 'c1', channelName: 'UnknownTrace', deliveryKind: 'binary' });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.errorCode).toBe('RttChannelUnavailable');

    host.enumData.duplicateUpNames = ['SysView'];
    host.enumData.upBuffers.push({
      direction: 'up', index: 2, configured: true, valid: true, status: 'valid', name: 'SysView', nameStatus: 'ok', duplicateName: true,
      bufferAddress: 0x20001400, bufferSize: 128, wrOff: 0, rdOff: 0, flags: 0, mode: 0,
    });
    const dup = await coordinator.subscribe({ consumerId: 'c2', channelName: 'SysView', deliveryKind: 'binary' });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.errorCode).toBe('RttDuplicateChannelName');

    host.capabilities.rttEnumerate = { available: false, reason: 'legacy owner lacks enumerateRtt', evidence: 'offline' };
    const unsup = await coordinator.subscribe({ consumerId: 'c3', channelName: 'SysView', deliveryKind: 'binary' });
    expect(unsup.ok).toBe(false);
    if (!unsup.ok) expect(unsup.errorCode).toBe('UnsupportedCapability');
  });

  it('binds a single physical control block across sequential and concurrent subscriptions while allowing identical-address deduplication', async () => {
    const host = new SimulatedPhysicalRttHost();
    const coordinator = new RttConsumptionCoordinator(host);

    // Concurrent subscriptions with conflicting control block addresses:
    // First settles on 0x20000100, second on 0x20000200 MUST reject without mutating session binding.
    const [first, second] = await Promise.all([
      coordinator.subscribe({
        consumerId: 'sub-a',
        channelName: 'SysView',
        deliveryKind: 'binary',
        controlBlockAddress: 0x20000100,
      }),
      coordinator.subscribe({
        consumerId: 'sub-b',
        channelIndex: 1,
        deliveryKind: 'binary',
        controlBlockAddress: 0x20000200,
      }),
    ]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.errorCode).toBe('RttControlBlockConflict');
    expect(coordinator.snapshot().controlBlockAddress).toBe(0x20000100);

    // Concurrent & sequential same-address sharing + deduplication succeed cleanly.
    const [sameA, dedupA] = await Promise.all([
      coordinator.subscribe({
        consumerId: 'sub-c',
        channelIndex: 1,
        deliveryKind: 'binary',
        controlBlockAddress: 0x20000100,
      }),
      coordinator.subscribe({
        consumerId: 'sub-a',
        channelIndex: 1,
        deliveryKind: 'binary',
        controlBlockAddress: 0x20000100,
      }),
    ]);
    expect(sameA.ok && sameA.refCount).toBe(2);
    expect(dedupA.ok && dedupA.deduplicated && dedupA.refCount).toBe(2);

    coordinator.dispose();
  });

  it('enforces bounded backpressure, reports drops & target overruns, honors XR conflicts, writes down without blind retry, and preserves control handoff vs session fences', async () => {
    const host = new SimulatedPhysicalRttHost();
    const coordinator = new RttConsumptionCoordinator(host);
    const drops: RttConsumerDropEvent[] = [];

    // 1) Bounded pull queue with pause-reader backpressure & resume on pull()
    await coordinator.subscribe({
      consumerId: 'pull-slow',
      channelIndex: 1,
      deliveryKind: 'binary',
      deliveryMode: 'pull',
      pollIntervalMs: 10,
      maxBatchBytes: 8,
      maxQueueBytes: 12,
      maxQueueBatches: 2,
      backpressurePolicy: 'pause-reader',
      onDrop: ev => drops.push(ev),
    });

    host.pushTargetBytes(1, new Uint8Array(24).fill(0x55));
    await vi.advanceTimersByTimeAsync(12);
    await vi.advanceTimersByTimeAsync(12);

    const pausedStatus = coordinator.getChannelStatus(1)!;
    expect(pausedStatus.pausedReason).toBe('backpressure');
    const readsAtPause = host.readCalls.get(1) ?? 0;

    await vi.advanceTimersByTimeAsync(40);
    expect(host.readCalls.get(1)).toBe(readsAtPause); // reader stayed paused

    const pulled = coordinator.pull('pull-slow', 1);
    expect(pulled.ok).toBe(true);
    expect(pulled.totalBytes).toBe(16);
    expect(coordinator.getChannelStatus(1)!.pausedReason).toBe('none');

    // 2) drop-oldest backpressure visibility
    await coordinator.unsubscribe('pull-slow', 1);
    const ring1 = host.rings.get(1)!;
    ring1.rdOff = ring1.wrOff;
    const oldDrops: RttConsumerDropEvent[] = [];
    await coordinator.subscribe({
      consumerId: 'drop-oldest-pull',
      channelIndex: 1,
      deliveryKind: 'binary',
      deliveryMode: 'pull',
      pollIntervalMs: 10,
      maxBatchBytes: 8,
      maxQueueBytes: 8,
      maxQueueBatches: 1,
      backpressurePolicy: 'drop-oldest',
      onDrop: ev => oldDrops.push(ev),
    });
    host.pushTargetBytes(1, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]));
    await vi.advanceTimersByTimeAsync(12);
    await vi.advanceTimersByTimeAsync(12);
    expect(oldDrops.some(d => d.reason === 'host-drop' && d.droppedBytes > 0)).toBe(true);
    const pulledLatest = coordinator.pull('drop-oldest-pull', 1);
    expect([...pulledLatest.batches[0].bytes]).toEqual([9, 10, 11, 12]);
    await coordinator.unsubscribe('drop-oldest-pull', 1);

    // 3) XR conflict: pause-on-xr, reject-on-xr, best-effort congestion
    host.xrActive = true;
    coordinator.onXrSamplingStateChanged();
    const rejected = await coordinator.subscribe({ consumerId: 'strict-trace', channelIndex: 1, deliveryKind: 'binary', conflictPolicy: 'reject-on-xr' });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.errorCode).toBe('SamplingConflict');

    const bestEffort = await coordinator.subscribe({ consumerId: 'be-trace', channelIndex: 1, deliveryKind: 'binary', conflictPolicy: 'best-effort', pollIntervalMs: 10 });
    expect(bestEffort.ok).toBe(true);
    host.pushTargetBytes(1, new Uint8Array([7]));
    await vi.advanceTimersByTimeAsync(12);
    expect(coordinator.getChannelStatus(1)!.congested).toBe(true);
    host.xrActive = false;
    coordinator.onXrSamplingStateChanged();
    await coordinator.unsubscribe('be-trace', 1);

    // 4) Down write goes through control gate
    const wRes = await coordinator.writeDown({ channelName: 'SysView', bytes: new Uint8Array([0x01, 0x02]) });
    expect(wRes.ok).toBe(true);
    expect(host.controlGateCalls).toBe(1);
    expect(host.writeCalls).toBe(1);

    // 5) Late packet fence: session/boot change discards in-flight completion
    host.holdNextRead = true;
    const staleDeliveries: RttChannelBatch[] = [];
    await coordinator.subscribe({ consumerId: 'fence-test', channelIndex: 1, deliveryKind: 'binary', pollIntervalMs: 10, onBatch: b => { staleDeliveries.push(b); } });
    host.pushTargetBytes(1, new Uint8Array([0xaa, 0xbb]));
    await vi.advanceTimersByTimeAsync(12);
    host.sessionGeneration++;
    host.pendingReadResolver?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(staleDeliveries).toHaveLength(0);

    // 6) Owner loss notification
    host.ownerFailure = 'DeviceRemoved';
    await vi.advanceTimersByTimeAsync(12);
    expect(host.ownerLostEvents).toContain('DeviceRemoved');

    // 7) Frozen design budgets exist for every supported owner/transport stack
    const rmlinkCh0Budget = resolveRttTransportBudget('cmsis-dap', 'rmlink-service', 0, false);
    const rmlinkMemBudget = resolveRttTransportBudget('cmsis-dap', 'rmlink-service', 1, true);
    const dapWinUsbBudget = resolveRttTransportBudget('cmsis-dap', 'winusb', 1, true);
    const dapHidBudget = resolveRttTransportBudget('cmsis-dap', 'hid', 1, true);
    const jlinkBudget = resolveRttTransportBudget('jlink-native', 'usb', 1, false);
    expect(rmlinkCh0Budget.source).toBe('design-budget');
    expect(rmlinkMemBudget.source).toBe('design-budget');
    expect(rmlinkMemBudget.maxBatchBytes).toBeLessThanOrEqual(512);
    expect(dapHidBudget.maxBatchBytes).toBeLessThan(dapWinUsbBudget.maxBatchBytes);
    expect(jlinkBudget.maxBatchBytes).toBeGreaterThanOrEqual(dapWinUsbBudget.maxBatchBytes);

    coordinator.dispose();
  });

  it('flushes queued FIFO in-flight callback batches in strict batchSequence order on resume/drain without double-delivering to shared consumers or silently losing undelivered bytes', async () => {
    const host = new SimulatedPhysicalRttHost();
    const coordinator = new RttConsumptionCoordinator(host);

    const primaryBatches: RttChannelBatch[] = [];
    const primaryDrops: RttConsumerDropEvent[] = [];
    const sharedBatches: RttChannelBatch[] = [];
    let rejectNextCallback = false;

    const subPrimary = await coordinator.subscribe({
      consumerId: 'cb-primary',
      channelIndex: 1,
      deliveryKind: 'binary',
      deliveryMode: 'callback',
      pollIntervalMs: 10,
      maxBatchBytes: 64,
      maxQueueBytes: 256,
      maxQueueBatches: 8,
      backpressurePolicy: 'pause-reader',
      onBatch: b => {
        primaryBatches.push(b);
        if (rejectNextCallback) {
          rejectNextCallback = false;
          return false;
        }
        return true;
      },
      onDrop: ev => primaryDrops.push(ev),
    });
    expect(subPrimary.ok).toBe(true);

    const subShared = await coordinator.subscribe({
      consumerId: 'cb-shared',
      channelIndex: 1,
      deliveryKind: 'binary',
      deliveryMode: 'callback',
      pollIntervalMs: 10,
      maxBatchBytes: 64,
      conflictPolicy: 'best-effort',
      onBatch: b => { sharedBatches.push(b); },
    });
    expect(subShared.ok).toBe(true);

    // 1) Initial live batch (16 B) delivered to both once
    const part1 = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
    host.pushTargetBytes(1, part1);
    await vi.advanceTimersByTimeAsync(12);
    expect(primaryBatches).toHaveLength(1);
    expect(sharedBatches).toHaveLength(1);

    // 2) Suspend an in-flight target read (35 B), pause cb-primary mid-read, then complete the read
    const part2 = Uint8Array.from({ length: 35 }, (_, i) => 0x20 + i);
    host.holdNextRead = true;
    host.pushTargetBytes(1, part2);
    await vi.advanceTimersByTimeAsync(12);
    expect(coordinator.setConsumerPaused('cb-primary', 1, true)).toBe(true);

    // Complete held read: target RdOff committed; shared receives seq=2 immediately, paused cb-primary buffers seq=2 (35 B)
    host.pendingReadResolver?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(sharedBatches).toHaveLength(2);
    expect(primaryBatches).toHaveLength(1);
    const queuedStatus = coordinator.getChannelStatus(1)!.consumers.find(c => c.consumerId === 'cb-primary')!;
    expect(queuedStatus.queuedBatches).toBe(1);
    expect(queuedStatus.queuedBytes).toBe(35);

    // 3) Push later target bytes (20 B), then resume cb-primary & run drainConsumer -> older seq=2 MUST flush BEFORE newer seq=3!
    const part3 = Uint8Array.from({ length: 20 }, (_, i) => 0x60 + i);
    host.pushTargetBytes(1, part3);
    expect(coordinator.setConsumerPaused('cb-primary', 1, false)).toBe(true);
    // Older in-flight batch (35 B, seq=2) was delivered synchronously on resume before seq=3 is even read!
    expect(primaryBatches.map(b => b.batchSequence)).toEqual([1, 2]);
    expect(primaryBatches[1].bytes.length).toBe(35);

    const drainRes = await coordinator.drainConsumer('cb-primary', 1, { timeoutMs: 200 });
    expect(drainRes.ok).toBe(true);
    expect(drainRes.drained).toBe(true);
    expect(primaryBatches.map(b => b.batchSequence)).toEqual([1, 2, 3]);
    expect(sharedBatches.map(b => b.batchSequence)).toEqual([1, 2, 3]);
    expect(Buffer.concat(primaryBatches.map(b => Buffer.from(b.bytes)))).toEqual(
      Buffer.concat([Buffer.from(part1), Buffer.from(part2), Buffer.from(part3)]),
    );
    expect(Buffer.concat(sharedBatches.map(b => Buffer.from(b.bytes)))).toEqual(
      Buffer.concat([Buffer.from(part1), Buffer.from(part2), Buffer.from(part3)]),
    );

    // 4) Host backpressure via callback returning false queues subsequent held/paused batch and resumes cleanly in FIFO order
    rejectNextCallback = true;
    const part4 = Uint8Array.from([0xa1, 0xa2, 0xa3, 0xa4]);
    host.pushTargetBytes(1, part4);
    await vi.advanceTimersByTimeAsync(12);
    expect(primaryBatches).toHaveLength(4);
    expect(coordinator.getChannelStatus(1)!.consumers.find(c => c.consumerId === 'cb-primary')!.backpressured).toBe(true);

    // Pause while another read lands in queue under backpressure, then unsubscribe while unable to receive -> explicit host-drop!
    const part5 = Uint8Array.from([0xb1, 0xb2, 0xb3]);
    host.holdNextRead = true;
    host.pushTargetBytes(1, part5);
    // Force one manual held batch via temporary unpause+pause during read
    expect(coordinator.setConsumerPaused('cb-primary', 1, false)).toBe(true);
    await vi.advanceTimersByTimeAsync(12);
    expect(coordinator.setConsumerPaused('cb-primary', 1, true)).toBe(true);
    host.pendingReadResolver?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(coordinator.getChannelStatus(1)!.consumers.find(c => c.consumerId === 'cb-primary')!.queuedBytes).toBe(3);

    const unsubRes = await coordinator.unsubscribe('cb-primary', 1);
    expect(unsubRes.ok).toBe(true);
    expect(unsubRes.remainingRefCount).toBe(1);
    expect(primaryDrops.some(d => d.reason === 'host-drop' && d.droppedBytes === 3)).toBe(true);
    // Shared consumer still received part4 & part5 cleanly once each
    expect(sharedBatches.map(b => b.batchSequence)).toEqual([1, 2, 3, 4, 5]);

    await coordinator.unsubscribe('cb-shared', 1);
    coordinator.dispose();
  });
});
