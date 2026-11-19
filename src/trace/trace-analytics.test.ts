import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SYSTEMVIEW_EVENT_IDS } from './systemview-protocol';
import { bigIntRatioPct, formatBigIntMean } from './trace-analytics';
import { TraceRecordingStore } from './trace-recording-store';
import { TraceWorkerClient } from './trace-worker-client';

const tempDirs: string[] = [];
const clients: TraceWorkerClient[] = [];
const stores: TraceRecordingStore[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (stores.length > 0) {
    await stores.pop()!.close().catch(() => {});
  }
  while (clients.length > 0) {
    await clients.pop()!.shutdown('test-cleanup').catch(() => {});
  }
  while (tempDirs.length > 0) {
    await fs.rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 独立手算 SystemView 3.32.0 二进制流构造器（仅用于构造测试输入）
// ---------------------------------------------------------------------------
function encodeU32(val: number): number[] {
  let v = val >>> 0;
  const out: number[] = [];
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v & 0x7f);
  return out;
}

function encodeStr(s: string): number[] {
  const bytes = Buffer.from(s, 'utf8');
  return [bytes.length, ...bytes];
}

function makeShortRaw(id: number, rawFields: number[], delta: number): number[] {
  return [id, ...rawFields, ...encodeU32(delta)];
}

function makeShortPkt(id: number, params: number[], delta: number): number[] {
  return [id, ...params.flatMap(encodeU32), ...encodeU32(delta)];
}

function makeLongPkt(id: number, payload: number[], delta: number): number[] {
  return [id, ...encodeU32(payload.length), ...payload, ...encodeU32(delta)];
}

function buildPreamble(ramBase: number, sysFreqHz: number, idShift = 2, initAbsCycles = 1000): number[] {
  const sync = new Array(10).fill(0);
  const traceStart = [SYSTEMVIEW_EVENT_IDS.TRACE_START, 0];
  const initPayload = [
    ...encodeU32(sysFreqHz),
    ...encodeU32(sysFreqHz),
    ...encodeU32(ramBase),
    ...encodeU32(idShift),
  ];
  const initPkt = makeLongPkt(SYSTEMVIEW_EVENT_IDS.INIT, initPayload, 0);
  const systime = makeShortPkt(SYSTEMVIEW_EVENT_IDS.SYSTIME_CYCLES, [initAbsCycles], 0);
  return [...sync, ...traceStart, ...initPkt, ...systime];
}

function shrinkId(addr: number, ramBase: number, idShift: number): number {
  return ((addr - ramBase) >>> idShift) >>> 0;
}

describe('SystemView 上下文统计、Ready 延迟、Marker 与 CPU Load 分箱 (阶段 5.1)', () => {
  it('独立手算 oracle：同时间戳嵌套 ISR、Idle、Ready 延迟、Marker、缺口/未知与跨边界裁剪时间守恒', async () => {
    const RAM_BASE = 0x20000000;
    const ID_SHIFT = 2;
    const SYS_FREQ = 1_000_000; // 1 tick = 1000 ns (1 us)
    const TCB_A = 0x20001000;
    const TCB_B = 0x20001100;
    const TCB_C = 0x20001200;
    const TCB_D = 0x20001300;
    const sA = shrinkId(TCB_A, RAM_BASE, ID_SHIFT);
    const sB = shrinkId(TCB_B, RAM_BASE, ID_SHIFT);
    const sC = shrinkId(TCB_C, RAM_BASE, ID_SHIFT);
    const sD = shrinkId(TCB_D, RAM_BASE, ID_SHIFT);

    // 构造精确时间序列（相对 tick，段 1）：
    // t=0: INIT(1MHz), SYSTIME_CYCLES(1000) -> abs = 1000 + rel
    // t=0..100: TaskCreate(A,B,C,D) + TaskInfo + SysDesc(IRQ17, IRQ18)
    // t=100: TASK_START_EXEC(A)
    // t=105: MARK_START(10)          [Marker#10 开始，位于 Task A 内]
    // t=120: ISR_ENTER(17)           [Task A 独占切片 [100,120) = 20]
    // t=120: ISR_ENTER(18) (delta=0) [同时间戳嵌套！ISR17 [120,120) = 0]
    // t=130: EX_MARK(20)             [点 Marker#20 @ t=130 in ISR18]
    // t=135: ISR_EXIT                [ISR18 独占 [120,135) = 15, incl=15]
    // t=140: ISR_EXIT                [ISR17 独占 [135,140) = 5, incl=20, preempt=15]
    // t=145: MARK_STOP(10)           [Marker#10 结束 @ 145 -> dur = 40]
    // t=150: TASK_START_READY(B)     [Ready B 开始 @ 150]
    // t=160: IDLE                    [Task A [140,160) = 20, Task A 完整激活 [100,160) excl=40 incl=60 preempt=20]
    // t=200: TASK_START_EXEC(B)      [IDLE [160,200) = 40; Ready B->Running = 50]
    // t=210: TASK_START_READY(C)     [Task B 运行到 210]
    // t=220: MARK_START(11)          [未闭合 Marker#11]
    // t=225: TASK_STOP_READY(C, 1)   [Ready C 移出，不计入 Ready 延迟]
    // t=230: TASK_START_EXEC(D)      [Task B [200,230) = 30; D 缺 TASK_START_READY -> readyIncomplete]
    // t=250: TRACE_STOP              [然后主动 markGap(target-overflow)]
    // 段 2: t_rel=0 (abs=1300) -> 缺口 [1250, 1300) = 50 ticks!
    //       t_abs=1300..1350: Task A 运行 50 ticks，然后 t_abs=1350 TRACE_STOP

    const seg1Bytes: number[] = [
      ...buildPreamble(RAM_BASE, SYS_FREQ, ID_SHIFT, 1000),
      ...makeShortPkt(SYSTEMVIEW_EVENT_IDS.TASK_CREATE, [sA], 0),
      ...makeShortRaw(SYSTEMVIEW_EVENT_IDS.TASK_INFO, [...encodeU32(sA), ...encodeU32(3), ...encodeStr('TaskA')], 0),
      ...makeShortPkt(SYSTEMVIEW_EVENT_IDS.TASK_CREATE, [sB], 0),
      ...makeShortRaw(SYSTEMVIEW_EVENT_IDS.TASK_INFO, [...encodeU32(sB), ...encodeU32(2), ...encodeStr('TaskB')], 0),
      ...makeShortPkt(SYSTEMVIEW_EVENT_IDS.TASK_CREATE, [sC], 0),
      ...makeShortRaw(SYSTEMVIEW_EVENT_IDS.TASK_INFO, [...encodeU32(sC), ...encodeU32(2), ...encodeStr('TaskC')], 0),
      ...makeShortPkt(SYSTEMVIEW_EVENT_IDS.TASK_CREATE, [sD], 0),
      ...makeShortRaw(SYSTEMVIEW_EVENT_IDS.TASK_INFO, [...encodeU32(sD), ...encodeU32(1), ...encodeStr('TaskD')], 0),
      ...makeShortRaw(SYSTEMVIEW_EVENT_IDS.SYSDESC, encodeStr('I#17=SysTick'), 0),
      ...makeShortRaw(SYSTEMVIEW_EVENT_IDS.SYSDESC, encodeStr('I#18=DMA_IRQ'), 0),
      ...makeShortPkt(SYSTEMVIEW_EVENT_IDS.TASK_START_EXEC, [sA], 100), // t=100
      ...makeShortPkt(SYSTEMVIEW_EVENT_IDS.MARK_START, [10], 5),        // t=105
      ...makeShortPkt(SYSTEMVIEW_EVENT_IDS.ISR_ENTER, [17], 15),        // t=120
      ...makeShortPkt(SYSTEMVIEW_EVENT_IDS.ISR_ENTER, [18], 0),         // t=120 (同时间戳!)
      ...makeLongPkt(SYSTEMVIEW_EVENT_IDS.EX, [0, ...encodeU32(20)], 10), // t=130 EX_MARK(20)
      ...makeShortPkt(SYSTEMVIEW_EVENT_IDS.ISR_EXIT, [], 5),            // t=135
      ...makeShortPkt(SYSTEMVIEW_EVENT_IDS.ISR_EXIT, [], 5),            // t=140
      ...makeShortPkt(SYSTEMVIEW_EVENT_IDS.MARK_STOP, [10], 5),         // t=145
      ...makeShortPkt(SYSTEMVIEW_EVENT_IDS.TASK_START_READY, [sB], 5),  // t=150
      ...makeShortPkt(SYSTEMVIEW_EVENT_IDS.IDLE, [], 10),               // t=160
      ...makeShortPkt(SYSTEMVIEW_EVENT_IDS.TASK_START_EXEC, [sB], 40),  // t=200
      ...makeShortPkt(SYSTEMVIEW_EVENT_IDS.TASK_START_READY, [sC], 10), // t=210
      ...makeShortPkt(SYSTEMVIEW_EVENT_IDS.MARK_START, [11], 10),       // t=220
      ...makeShortPkt(SYSTEMVIEW_EVENT_IDS.TASK_STOP_READY, [sC, 1], 5),// t=225
      ...makeShortPkt(SYSTEMVIEW_EVENT_IDS.TASK_START_EXEC, [sD], 5),   // t=230
      ...makeShortPkt(SYSTEMVIEW_EVENT_IDS.TRACE_STOP, [], 20),         // t=250
    ];

    const seg2Bytes: number[] = [
      ...buildPreamble(RAM_BASE, SYS_FREQ, ID_SHIFT, 1300),
      ...makeShortPkt(SYSTEMVIEW_EVENT_IDS.TASK_CREATE, [sA], 0),
      ...makeShortRaw(SYSTEMVIEW_EVENT_IDS.TASK_INFO, [...encodeU32(sA), ...encodeU32(3), ...encodeStr('TaskA')], 0),
      ...makeShortPkt(SYSTEMVIEW_EVENT_IDS.TASK_START_EXEC, [sA], 0),   // abs=1300
      ...makeShortPkt(SYSTEMVIEW_EVENT_IDS.IDLE, [], 50),               // abs=1350 (TaskA [1300,1350) complete)
    ];

    const dir = await makeTempDir('orbit-51-oracle-');
    const store = await TraceRecordingStore.create({
      recordingDir: dir,
      recordId: 'oracle-rec',
      identity: { sessionId: 's-oracle', sessionGeneration: 1, bootGeneration: 1, recordId: 'oracle-rec' },
      commitOnEachIngest: true,
    });
    stores.push(store);

    expect((await store.ingestRawChunk(Uint8Array.from(seg1Bytes), { batchSequence: 1 })).ok).toBe(true);
    expect((await store.markGap({ kind: 'target-overflow', reason: 'test overflow gap', droppedPackets: 'unknown' })).ok).toBe(true);
    expect((await store.ingestRawChunk(Uint8Array.from(seg2Bytes), { batchSequence: 2 })).ok).toBe(true);
    expect((await store.finish('done')).ok).toBe(true);

    // 1. 全段绝对 ticks [1100, 1350) = 250 ticks:
    //    TaskA(seg1): [1100,1120)=20 + [1140,1160)=20 => 40 ticks
    //    ISR18:       [1120,1135)=15
    //    ISR17:       [1135,1140)=5 (inclusive=20, preempted=15)
    //    Idle:        [1160,1200)=40
    //    TaskB:       [1200,1230)=30 (Ready=50)
    //    TaskD:       [1230,1250) -> incomplete (cut by gap! 20 ticks -> unknown!)
    //    Gap:         [1250,1300) -> 50 ticks -> unknown!
    //    TaskA(seg2): [1300,1350)=50
    //    Total task = 40+30+50 = 120; isr = 20; idle = 40; unknown = 20 + 50 = 70; sum = 120+20+40+70 = 250!
    const fullRes = await store.queryAnalysis({
      start: '1100',
      end: '1350',
      unit: 'absolute-ticks',
      maxBins: 10,
    });
    expect(fullRes.ok).toBe(true);
    if (!fullRes.ok) return;
    const d = fullRes.data;
    expect(d.precision).toBe('exact');
    expect(d.verifiable).toBe(true);
    expect(d.windowDuration).toBe('250');
    expect(d.totals.taskDuration).toBe('120');
    expect(d.totals.isrDuration).toBe('20');
    expect(d.totals.schedulerDuration).toBe('0');
    expect(d.totals.idleDuration).toBe('40');
    expect(d.totals.unknownDuration).toBe('70');
    expect(d.totals.activeDuration).toBe('140');
    expect(d.totals.knownDuration).toBe('180');
    expect(d.totals.sliceOverlapDetected).toBe(false);
    expect(d.gapsInWindow.length).toBe(1);
    expect(d.gapsInWindow[0].kind).toBe('target-overflow');

    // 验证每箱守恒与总和守恒（250 / 10 = 25 ticks/bin）
    let sumTask = 0n, sumIsr = 0n, sumIdle = 0n, sumUnk = 0n;
    for (const b of d.bins) {
      const dur = BigInt(b.duration);
      const t = BigInt(b.taskDuration);
      const i = BigInt(b.isrDuration);
      const s = BigInt(b.schedulerDuration);
      const id = BigInt(b.idleDuration);
      const u = BigInt(b.unknownDuration);
      expect(t + i + s + id + u).toBe(dur);
      sumTask += t; sumIsr += i; sumIdle += id; sumUnk += u;
    }
    expect(sumTask).toBe(120n);
    expect(sumIsr).toBe(20n);
    expect(sumIdle).toBe(40n);
    expect(sumUnk).toBe(70n);

    // 验证上下文统计（ISR 嵌套、Ready 延迟、缺 Ready 起始、移出）
    const isr17 = d.contexts.find(c => c.irqId === 17);
    const isr18 = d.contexts.find(c => c.irqId === 18);
    expect(isr17).toBeDefined();
    expect(isr17!.clippedExclusiveDuration).toBe('5');
    expect(isr17!.completeActivationCount).toBe(1);
    expect(isr17!.exclusiveStats).toMatchObject({ min: '5', max: '5', avgFloor: '5' });
    expect(isr17!.inclusiveStats).toMatchObject({ min: '20', max: '20', avgFloor: '20' });
    expect(isr17!.preemptedTotalDuration).toBe('15');
    expect(isr17!.preemptionCountTotal).toBe(1);

    expect(isr18).toBeDefined();
    expect(isr18!.clippedExclusiveDuration).toBe('15');
    expect(isr18!.exclusiveStats).toMatchObject({ min: '15', max: '15' });
    expect(isr18!.preemptionCountTotal).toBe(0);

    const taskB = d.contexts.find(c => c.label === 'TaskB');
    expect(taskB).toBeDefined();
    expect(taskB!.clippedExclusiveDuration).toBe('30');
    expect(taskB!.readyCompleteCount).toBe(1);
    expect(taskB!.readyStats).toMatchObject({ min: '50', max: '50', avgFloor: '50' });

    const taskC = d.contexts.find(c => c.label === 'TaskC');
    expect(taskC).toBeDefined();
    expect(taskC!.readyCompleteCount).toBe(0);
    expect(taskC!.readyRemovedCount).toBe(1);
    expect(taskC!.readyStats).toBeUndefined(); // 不可填 0!

    const taskD = d.contexts.find(c => c.label === 'TaskD');
    expect(taskD).toBeDefined();
    expect(taskD!.clippedExclusiveDuration).toBe('0'); // 被 gap 截断的不完整切片不计入
    expect(taskD!.incompleteActivationCount).toBe(1);
    expect(taskD!.readyIncompleteCount).toBeGreaterThanOrEqual(1);
    expect(taskD!.readyStats).toBeUndefined(); // 缺起始不填 0!

    // 验证 Marker 统计
    const m10 = d.markers.find(m => m.markerId === 10);
    expect(m10).toBeDefined();
    expect(m10!.completeCount).toBe(1);
    expect(m10!.durationStats).toMatchObject({ min: '40', max: '40', total: '40' });

    const m11 = d.markers.find(m => m.markerId === 11);
    expect(m11).toBeDefined();
    expect(m11!.completeCount).toBe(0);
    expect(m11!.incompleteCount).toBe(1);
    expect(m11!.durationStats).toBeUndefined();

    const m20 = d.markers.find(m => m.markerId === 20);
    expect(m20).toBeDefined();
    expect(m20!.pointCount).toBe(1);
    expect(m20!.contextKeys[0]).toContain('isr:18');

    // 2. 越界裁剪与“无完整激活”校验：窄窗口 [1110, 1150) (40 ticks)
    //    TaskA 激活 [1100,1160) 跨过左右边界 -> 裁剪 CPU=20, completeActivation=0, boundaryActivation=1, exclusiveStats=undefined
    //    ISR17 [1120,1140) 与 ISR18 [1120,1135) 完整落入窗口 -> completeActivation=1
    //    Marker#10 [1105,1145) 跨左边界 -> complete=0, boundary=1, durationStats=undefined
    const narrowRes = await store.queryAnalysis({
      start: '1110',
      end: '1150',
      unit: 'absolute-ticks',
      bootGeneration: 1,
      segmentId: 1,
      maxBins: 7, // 40 / 7 -> 前 6 箱 5~6, 末箱有余数，核对末箱守恒
    });
    expect(narrowRes.ok).toBe(true);
    if (!narrowRes.ok) return;
    const nd = narrowRes.data;
    expect(nd.windowDuration).toBe('40');
    expect(nd.totals.taskDuration).toBe('20');
    expect(nd.totals.isrDuration).toBe('20');
    expect(nd.totals.idleDuration).toBe('0');
    expect(nd.totals.unknownDuration).toBe('0');
    const narrowTaskA = nd.contexts.find(c => c.label === 'TaskA');
    expect(narrowTaskA!.clippedExclusiveDuration).toBe('20');
    expect(narrowTaskA!.completeActivationCount).toBe(0);
    expect(narrowTaskA!.boundaryActivationCount).toBe(1);
    expect(narrowTaskA!.exclusiveStats).toBeUndefined();
    const narrowM10 = nd.markers.find(m => m.markerId === 10);
    expect(narrowM10!.completeCount).toBe(0);
    expect(narrowM10!.boundaryCount).toBe(1);
    expect(narrowM10!.durationStats).toBeUndefined();

    // 验证末箱精确边界与时间守恒
    const lastBin = nd.bins[nd.bins.length - 1];
    expect(lastBin.end).toBe('1150');
    expect(
      BigInt(lastBin.taskDuration) + BigInt(lastBin.isrDuration) + BigInt(lastBin.schedulerDuration) + BigInt(lastBin.idleDuration) + BigInt(lastBin.unknownDuration),
    ).toBe(BigInt(lastBin.duration));

    // 3. 任意超窄区间 [1123, 1126) (3 ticks < maxBins=64 -> 仅输出 3 个 1-tick 箱)
    const ultraNarrow = await store.queryAnalysis({
      start: '1123',
      end: '1126',
      unit: 'absolute-ticks',
      bootGeneration: 1,
      segmentId: 1,
      maxBins: 64,
    });
    expect(ultraNarrow.ok).toBe(true);
    if (!ultraNarrow.ok) return;
    expect(ultraNarrow.data.bins.length).toBe(3);
    expect(ultraNarrow.data.totals.isrDuration).toBe('3');
    expect(ultraNarrow.data.totals.unknownDuration).toBe('0');

    // 4. ns 单位验证（1 tick = 1000 ns）
    const nsRes = await store.queryAnalysis({
      start: '1100000',
      end: '1350000',
      unit: 'ns',
      maxBins: 10,
    });
    expect(nsRes.ok).toBe(true);
    if (!nsRes.ok) return;
    expect(nsRes.data.totals.taskDuration).toBe('120000');
    expect(nsRes.data.totals.isrDuration).toBe('20000');
    expect(nsRes.data.totals.idleDuration).toBe('40000');
    expect(nsRes.data.totals.unknownDuration).toBe('70000');
  });

  it('隔离复用 TCB 地址为两个独立任务实例并正确处理窄范围包围的长区间', async () => {
    const RAM_BASE = 0x20000000;
    const ID_SHIFT = 2;
    const TCB_REUSED = 0x20002000;
    const sReused = shrinkId(TCB_REUSED, RAM_BASE, ID_SHIFT);

    // 创建 Alpha -> 运行 [10, 5000)（被多次 ISR 打断并跨越页边界）-> 删除 -> 复用地址创建 Beta -> 运行 [5100, 5200)
    const bytes: number[] = [
      ...buildPreamble(RAM_BASE, 1_000_000, ID_SHIFT, 10000),
      ...makeShortPkt(SYSTEMVIEW_EVENT_IDS.TASK_CREATE, [sReused], 0),
      ...makeShortRaw(SYSTEMVIEW_EVENT_IDS.TASK_INFO, [...encodeU32(sReused), ...encodeU32(2), ...encodeStr('Alpha')], 0),
      ...makeShortPkt(SYSTEMVIEW_EVENT_IDS.TASK_START_EXEC, [sReused], 10), // rel=10
      ...makeShortPkt(SYSTEMVIEW_EVENT_IDS.MARK_START, [77], 0),            // 长 Marker [10, 4900)
      // 在 [100..4000) 内插入多个短 ISR，使常规页 maxEnd 推进并把长激活/长 Marker 路由至 long*
      ...makeShortPkt(SYSTEMVIEW_EVENT_IDS.ISR_ENTER, [19], 90),  // 100
      ...makeShortPkt(SYSTEMVIEW_EVENT_IDS.ISR_EXIT, [], 10),     // 110
      ...makeShortPkt(SYSTEMVIEW_EVENT_IDS.ISR_ENTER, [19], 90),  // 200
      ...makeShortPkt(SYSTEMVIEW_EVENT_IDS.ISR_EXIT, [], 10),     // 210
      ...makeShortPkt(SYSTEMVIEW_EVENT_IDS.MARK_STOP, [77], 4690),// 4900
      ...makeShortPkt(SYSTEMVIEW_EVENT_IDS.IDLE, [], 100),        // 5000: Alpha 激活 [10, 5000) 关闭
      ...makeLongPkt(SYSTEMVIEW_EVENT_IDS.TASK_TERMINATE, encodeU32(sReused), 50), // 5050
      ...makeShortPkt(SYSTEMVIEW_EVENT_IDS.TASK_CREATE, [sReused], 20),    // 5070
      ...makeShortRaw(SYSTEMVIEW_EVENT_IDS.TASK_INFO, [...encodeU32(sReused), ...encodeU32(3), ...encodeStr('Beta')], 0),
      ...makeShortPkt(SYSTEMVIEW_EVENT_IDS.TASK_START_READY, [sReused], 10), // 5080
      ...makeShortPkt(SYSTEMVIEW_EVENT_IDS.TASK_START_EXEC, [sReused], 20),  // 5100
      ...makeShortPkt(SYSTEMVIEW_EVENT_IDS.IDLE, [], 100),                   // 5200: Beta [5100, 5200)
    ];

    const dir = await makeTempDir('orbit-51-reuse-');
    const store = await TraceRecordingStore.create({
      recordingDir: dir,
      recordId: 'reuse-rec',
      identity: { sessionId: 's-reuse', sessionGeneration: 1, bootGeneration: 1, recordId: 'reuse-rec' },
      limits: { pageMaxItems: 4, longIntervalThresholdTicks: 1000n },
      commitOnEachIngest: true,
    });
    stores.push(store);

    expect((await store.ingestRawChunk(Uint8Array.from(bytes), { batchSequence: 1 })).ok).toBe(true);
    expect((await store.finish('done')).ok).toBe(true);

    // 1. 全段应保留 Alpha 与 Beta 两个独立实例行
    const full = await store.queryAnalysis({ start: '0', end: '5250', unit: 'relative-ticks' });
    expect(full.ok).toBe(true);
    if (!full.ok) return;
    const alpha = full.data.contexts.find(c => c.label === 'Alpha');
    const beta = full.data.contexts.find(c => c.label === 'Beta');
    expect(alpha).toBeDefined();
    expect(beta).toBeDefined();
    expect(alpha!.contextKey).not.toBe(beta!.contextKey);
    expect(alpha!.tcbAddress).toBe(TCB_REUSED);
    expect(beta!.tcbAddress).toBe(TCB_REUSED);
    expect(beta!.taskGeneration).toBeGreaterThan(alpha!.taskGeneration!);
    expect(alpha!.clippedExclusiveDuration).toBe('4970'); // 4990 - 20 ISR
    expect(beta!.clippedExclusiveDuration).toBe('100');
    expect(beta!.readyStats?.min).toBe('20');

    // 2. 窄范围 [1500, 1600) 被长切片/长激活/长 Marker 包围，仍准确命中 long* 页
    const narrow = await store.queryAnalysis({ start: '1500', end: '1600', unit: 'relative-ticks', maxBins: 5 });
    expect(narrow.ok).toBe(true);
    if (!narrow.ok) return;
    expect(narrow.data.totals.taskDuration).toBe('100');
    expect(narrow.data.totals.unknownDuration).toBe('0');
    const narrowAlpha = narrow.data.contexts.find(c => c.label === 'Alpha');
    expect(narrowAlpha?.clippedExclusiveDuration).toBe('100');
    expect(narrowAlpha?.boundaryActivationCount).toBe(1);
    expect(narrowAlpha?.completeActivationCount).toBe(0);
    const narrowMarker = narrow.data.markers.find(m => m.markerId === 77);
    expect(narrowMarker?.boundaryCount).toBe(1);
    expect(narrowMarker?.completeCount).toBe(0);
  });

  it('校验 64 位 tick 精度与时间域跳变/多段相对时间/重启隔离语义', async () => {
    // 验证大整数百分比与均值工具（> 2^53）
    const bigTotal = 18_014_398_509_481_984n; // 2^54
    expect(bigIntRatioPct(bigTotal / 4n, bigTotal)).toBe(25);
    expect(formatBigIntMean(bigTotal + 1n, 2, 2)).toBe('9007199254740992.50');

    const RAM_BASE = 0x20000000;
    const ID_SHIFT = 2;
    const s1 = shrinkId(0x20001000, RAM_BASE, ID_SHIFT);

    // 构造包含时钟频率跳变（Seg1: 1MHz -> Seg2: 2MHz）+ 64-bit SYSTIME_CYCLES + 后续 target reset (boot=2)
    // 注意：SEGGER SYSTIME_CYCLES 发送 U32 低 32 位，测试中也用多段与大 tick 验证
    const seg1 = [
      ...buildPreamble(RAM_BASE, 1_000_000, ID_SHIFT, 1000),
      ...makeShortPkt(SYSTEMVIEW_EVENT_IDS.TASK_CREATE, [s1], 0),
      ...makeShortPkt(SYSTEMVIEW_EVENT_IDS.TASK_START_EXEC, [s1], 10),
      ...makeShortPkt(SYSTEMVIEW_EVENT_IDS.IDLE, [], 40), // abs [1010, 1050) = 40 ticks @ 1MHz = 40,000 ns
    ];
    const seg2 = [
      ...buildPreamble(RAM_BASE, 2_000_000, ID_SHIFT, 2200),
      ...makeShortPkt(SYSTEMVIEW_EVENT_IDS.TASK_CREATE, [s1], 0),
      ...makeShortPkt(SYSTEMVIEW_EVENT_IDS.TASK_START_EXEC, [s1], 20),
      ...makeShortPkt(SYSTEMVIEW_EVENT_IDS.IDLE, [], 80), // abs [2220, 2300) = 80 ticks @ 2MHz = [1,110,000, 1,150,000) ns
    ];

    const dir = await makeTempDir('orbit-51-domain-');
    const store = await TraceRecordingStore.create({
      recordingDir: dir,
      recordId: 'domain-rec',
      identity: { sessionId: 's-dom', sessionGeneration: 1, bootGeneration: 1, recordId: 'domain-rec' },
      commitOnEachIngest: true,
    });
    stores.push(store);

    await store.ingestRawChunk(Uint8Array.from(seg1), { batchSequence: 1 });
    await store.markGap({ kind: 'control-pause', reason: 'freq change' });
    await store.ingestRawChunk(Uint8Array.from(seg2), { batchSequence: 2 });

    // 1. 多段 relative-ticks 不指定 segmentId：必须拒绝跨段合并，返回 verifiable=false + 可验证段列表
    const relConflict = await store.queryAnalysis({
      start: '0',
      end: '200',
      unit: 'relative-ticks',
    });
    expect(relConflict.ok).toBe(true);
    if (relConflict.ok) {
      expect(relConflict.data.verifiable).toBe(false);
      expect(relConflict.data.timeDomainJump).toBe(true);
      expect(relConflict.data.verifiableSegments.length).toBeGreaterThanOrEqual(2);
      expect(relConflict.data.totals.unknownDuration).toBe('200');
    }

    // 2. 不同频率段在 absolute-ticks 下不可合并 ticks：verifiable=false, timeDomainJump=true
    const absFreqJump = await store.queryAnalysis({
      start: '1000',
      end: '2100',
      unit: 'absolute-ticks',
    });
    expect(absFreqJump.ok).toBe(true);
    if (absFreqJump.ok) {
      expect(absFreqJump.data.verifiable).toBe(false);
      expect(absFreqJump.data.timeDomainJump).toBe(true);
      expect(absFreqJump.data.totals.unknownDuration).toBe('1100');
    }

    // 3. ns 单位下可按各段频率精确换算并提示 timeDomainJump 警告
    //    Seg1: 40 ticks @ 1MHz = 40,000 ns; Seg2: 80 ticks @ 2MHz = 40,000 ns -> total task = 80,000 ns
    const nsJump = await store.queryAnalysis({
      start: '1000000',
      end: '1150000',
      unit: 'ns',
      maxBins: 5,
    });
    expect(nsJump.ok).toBe(true);
    if (nsJump.ok) {
      expect(nsJump.data.verifiable).toBe(true);
      expect(nsJump.data.timeDomainJump).toBe(true);
      expect(nsJump.data.totals.taskDuration).toBe('80000');
    }

    // 4. 目标复位（bootGeneration 2）：默认仅统计最新 boot 2 并报告 excludedBootGenerations=[1]
    await store.notifyTargetReset(2, 'mcu reset');
    const boot2 = [
      ...buildPreamble(RAM_BASE, 2_000_000, ID_SHIFT, 3000),
      ...makeShortPkt(SYSTEMVIEW_EVENT_IDS.TASK_CREATE, [s1], 0),
      ...makeShortPkt(SYSTEMVIEW_EVENT_IDS.TASK_START_EXEC, [s1], 10),
      ...makeShortPkt(SYSTEMVIEW_EVENT_IDS.IDLE, [], 30),
    ];
    await store.ingestRawChunk(Uint8Array.from(boot2), { batchSequence: 3, bootGeneration: 2 });
    await store.finish('done');

    const latestBootRes = await store.queryAnalysis({ start: '1500000', end: '1520000', unit: 'ns' });
    expect(latestBootRes.ok).toBe(true);
    if (latestBootRes.ok) {
      expect(latestBootRes.data.excludedBootGenerations).toEqual([1]);
      expect(latestBootRes.data.totals.taskDuration).toBe('15000'); // 30 ticks @ 2MHz = 15000 ns
    }
  });

  it('在真实阶段 0 样本与 4.4/4.5 H723 只读归档上满足时间守恒与零越界异常', async () => {
    // 1. 阶段 0 样本 continuous.bin & continuous-overflow.bin
    const client = new TraceWorkerClient();
    clients.push(client);

    for (const sampleName of ['continuous.bin', 'continuous-overflow.bin']) {
      const bin = await fs.readFile(path.join('scripts/rtos/fixtures/samples', sampleName));
      const dir = await makeTempDir(`orbit-51-${sampleName}-`);
      await client.createRecording({
        recordingDir: dir,
        recordId: sampleName,
        identity: { sessionId: 's0', sessionGeneration: 1, bootGeneration: 1, recordId: sampleName },
        commitOnEachIngest: true,
      });
      await client.ingestChunk({
        recordId: sampleName,
        sessionId: 's0',
        sessionGeneration: 1,
        batchSequence: 1,
        chunk: bin,
        flush: true,
      });
      await client.finishRecording(sampleName, 'done');
      const segsRes = await client.getSegments(sampleName);
      expect(segsRes.ok).toBe(true);
      if (!segsRes.ok) continue;
      const seg = segsRes.data[0];
      const res = await client.queryAnalysis(sampleName, {
        start: seg.minRelativeTicks,
        end: BigInt(seg.maxRelativeTicks) > BigInt(seg.minRelativeTicks) ? seg.maxRelativeTicks : (BigInt(seg.minRelativeTicks) + 100n).toString(),
        unit: 'relative-ticks',
        bootGeneration: seg.bootGeneration,
        segmentId: seg.segmentId,
        maxBins: 64,
      });
      expect(res.ok).toBe(true);
      if (res.ok) {
        const t = res.data.totals;
        const sum = BigInt(t.taskDuration) + BigInt(t.isrDuration) + BigInt(t.schedulerDuration) + BigInt(t.idleDuration) + BigInt(t.unknownDuration);
        expect(sum).toBe(BigInt(res.data.windowDuration));
        expect(res.data.contexts.length).toBeGreaterThan(0);
      }
    }

    // 2. 只读打开 4.4 H723 归档（复制到临时目录只读验证，绝不写原目录）
    const summaryPath = 'out/rtos-stage4/acceptance-4.4/codex-r4-acceptance-summary.json';
    const summaryRaw = await fs.readFile(summaryPath, 'utf8').catch(() => '');
    if (summaryRaw) {
      const summary = JSON.parse(summaryRaw);
      const pmDir: string | undefined = summary?.hardware?.['post-mortem']?.recordingDir;
      if (pmDir) {
        const copyDir = await makeTempDir('orbit-51-h7-pm-');
        for (const f of ['manifest.json', 'raw.otbin', 'data.otd', 'journal.otj', 'index.otidx']) {
          const src = path.join(pmDir, f);
          const exists = await fs.access(src).then(() => true).catch(() => false);
          if (exists) await fs.copyFile(src, path.join(copyDir, f));
        }
        const openRes = await client.openRecording({ recordingDir: copyDir, recordId: 'h7-pm', verifyRawSha256: true });
        expect(openRes.ok).toBe(true);
        const segsRes = await client.getSegments('h7-pm');
        expect(segsRes.ok).toBe(true);
        if (segsRes.ok && segsRes.data.length > 0) {
          const seg = segsRes.data[0];
          const res = await client.queryAnalysis('h7-pm', {
            start: seg.minRelativeTicks,
            end: seg.maxRelativeTicks,
            unit: 'relative-ticks',
            bootGeneration: seg.bootGeneration,
            segmentId: seg.segmentId,
            maxBins: 80,
          });
          expect(res.ok).toBe(true);
          if (res.ok) {
            const t = res.data.totals;
            const sum = BigInt(t.taskDuration) + BigInt(t.isrDuration) + BigInt(t.schedulerDuration) + BigInt(t.idleDuration) + BigInt(t.unknownDuration);
            expect(sum).toBe(BigInt(res.data.windowDuration));
            expect(res.data.markers.some(m => m.pointCount > 0)).toBe(true);
          }
        }
      }
    }
  });

  it('在百万级事件录制上支持快速取消、预算退化 (approx) 与精确统计', async () => {
    const baseSample = await fs.readFile('scripts/rtos/fixtures/samples/continuous.bin');
    const preamble = baseSample.subarray(0, 31);
    const taskCreate = Uint8Array.from([8, 0x40, 1]);
    const cycle = Uint8Array.from([6, 0x40, 2, 4, 0x40, 3, 2, 17, 5, 3, 7, 5, 11, 17, 2]);
    const cycles = 167_000; // 1,002,005 packets
    const raw = new Uint8Array(preamble.length + taskCreate.length + cycles * cycle.length + 2);
    raw.set(preamble, 0);
    raw.set(taskCreate, preamble.length);
    let pos = preamble.length + taskCreate.length;
    for (let i = 0; i < cycles; i++) {
      raw.set(cycle, pos);
      pos += cycle.length;
    }
    raw[pos] = 11;
    raw[pos + 1] = 1;

    const dir = await makeTempDir('orbit-51-1m-');
    const client = new TraceWorkerClient();
    clients.push(client);

    await client.createRecording({
      recordingDir: dir,
      recordId: 'rec-1m-51',
      identity: { sessionId: 's-1m-51', sessionGeneration: 1, bootGeneration: 1, recordId: 'rec-1m-51' },
      commitOnEachIngest: false,
    });
    const chunkBytes = 32 * 1024;
    let seq = 1;
    for (let off = 0; off < raw.length; off += chunkBytes) {
      const r = await client.ingestChunk({
        recordId: 'rec-1m-51',
        sessionId: 's-1m-51',
        sessionGeneration: 1,
        batchSequence: seq++,
        chunk: raw.subarray(off, Math.min(raw.length, off + chunkBytes)),
      });
      expect(r.ok).toBe(true);
    }
    const fin = await client.finishRecording('rec-1m-51', 'done');
    expect(fin.ok).toBe(true);

    // 1. 连续 12 次快速改选区并立即取消前 11 次
    const controllers: AbortController[] = [];
    const promises: Array<Promise<any>> = [];
    for (let i = 0; i < 12; i++) {
      if (controllers.length > 0) controllers[controllers.length - 1].abort();
      const ac = new AbortController();
      controllers.push(ac);
      const start = BigInt(i * 100_000);
      const end = start + 500_000n;
      promises.push(
        client.queryAnalysis('rec-1m-51', { start, end, unit: 'relative-ticks', maxBins: 120 }, { signal: ac.signal }),
      );
    }
    const settled = await Promise.all(promises);
    const last = settled[settled.length - 1];
    expect(last.ok).toBe(true);
    if (last.ok) {
      expect(last.data.precision).toBe('exact');
      expect(last.data.bins.length).toBe(120);
      const t = last.data.totals;
      expect(
        BigInt(t.taskDuration) + BigInt(t.isrDuration) + BigInt(t.schedulerDuration) + BigInt(t.idleDuration) + BigInt(t.unknownDuration),
      ).toBe(500_000n);
    }

    // 2. 强制收紧 maxCandidatePages 触发 approx 降级且显式声明 precision='approx'
    const approxRes = await client.queryAnalysis('rec-1m-51', {
      start: '0',
      end: '3000000',
      unit: 'relative-ticks',
      maxBins: 60,
      maxCandidatePages: 8,
    });
    expect(approxRes.ok).toBe(true);
    if (approxRes.ok) {
      expect(approxRes.data.precision).toBe('approx');
      expect(approxRes.data.approxReason).toBeTruthy();
      expect(approxRes.data.contextsTruncated).toBe(true);
      expect(approxRes.data.bins.length).toBe(60);
    }
  }, 60000);
});
