import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DecodedSystemViewPacket,
  decodeSystemViewStream,
  SystemViewDecodeBatch,
  SystemViewStreamDecoder,
} from './systemview-decoder';
import {
  SYSTEMVIEW_EVENT_IDS,
  SYSTEMVIEW_EX_IDS,
  SYSTEMVIEW_FREERTOS_API_OFFSET,
  SYSTEMVIEW_PROTOCOL_VERSION,
} from './systemview-protocol';
import {
  reconstructSystemViewTrace,
  SystemViewTraceReconstructor,
} from './systemview-reconstructor';

const FIXTURES_DIR = path.resolve(__dirname, '../../scripts/rtos/fixtures');

function loadSample(name: string): { bytes: Uint8Array; meta: Record<string, any> } {
  const bytes = new Uint8Array(fs.readFileSync(path.join(FIXTURES_DIR, 'samples', `${name}.bin`)));
  const meta = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'samples', `${name}.json`), 'utf8'));
  return { bytes, meta };
}

function loadOracle(): { basis: string; packets: Record<string, string>; scenario: any[] } {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'host/oracle.json'), 'utf8'));
}

function encodeVarintU32(value: number): number[] {
  let v = value >>> 0;
  const out: number[] = [];
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return out;
}

function encodeStr(text: string): number[] {
  const raw = Array.from(Buffer.from(text, 'utf8'));
  if (raw.length < 255) {
    return [raw.length, ...raw];
  }
  return [255, (raw.length >> 8) & 0xff, raw.length & 0xff, ...raw];
}

function makeShortPacket(id: number, payloadParts: number[], delta: number): number[] {
  return [id, ...payloadParts, ...encodeVarintU32(delta)];
}

function makeExplicitPacket(id: number, payload: number[], delta: number): number[] {
  return [
    ...encodeVarintU32(id),
    ...encodeVarintU32(payload.length),
    ...payload,
    ...encodeVarintU32(delta),
  ];
}

function makeInitPayload(sysFreq: number, cpuFreq: number, ramBase: number, idShift: number): number[] {
  return [
    ...encodeVarintU32(sysFreq),
    ...encodeVarintU32(cpuFreq),
    ...encodeVarintU32(ramBase),
    ...encodeVarintU32(idShift),
  ];
}

function makeSync(): number[] {
  return new Array(10).fill(0);
}

function makeStandardHeader(opts?: {
  sysFreq?: number;
  cpuFreq?: number;
  ramBase?: number;
  idShift?: number;
  cycles?: number;
  includeSystime?: boolean;
}): number[] {
  const sysFreq = opts?.sysFreq ?? 1_000_000;
  const cpuFreq = opts?.cpuFreq ?? 64_000_000;
  const ramBase = opts?.ramBase ?? 0x20000000;
  const idShift = opts?.idShift ?? 2;
  const cycles = opts?.cycles ?? 100;
  const out = [
    ...makeSync(),
    ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.TRACE_START, [], 0),
    ...makeExplicitPacket(SYSTEMVIEW_EVENT_IDS.INIT, makeInitPayload(sysFreq, cpuFreq, ramBase, idShift), 0),
  ];
  if (opts?.includeSystime !== false) {
    out.push(...makeShortPacket(SYSTEMVIEW_EVENT_IDS.SYSTIME_CYCLES, encodeVarintU32(cycles), 0));
  }
  return out;
}

function shrink(addr: number, ramBase = 0x20000000, idShift = 2): number {
  return ((addr - ramBase) >>> idShift) >>> 0;
}

function makeTaskInfoPayload(shrunkId: number, prio: number, name: string): number[] {
  return [...encodeVarintU32(shrunkId), ...encodeVarintU32(prio), ...encodeStr(name)];
}

describe('SystemView 3.32.0 区间重建器 (阶段 4.2)', () => {
  it('对照阶段 0 五份独立样本与手工 oracle.json 精确还原执行、抢占、嵌套 ISR、Ready 与 Marker', () => {
    const oracle = loadOracle();

    for (const sampleName of ['continuous', 'single-shot'] as const) {
      const { bytes, meta } = loadSample(sampleName);
      const decoded = decodeSystemViewStream(bytes, { timestampBits: meta.timestampBits });
      const res = reconstructSystemViewTrace(decoded, {
        identity: { sessionId: 's1', sessionGeneration: 1, bootGeneration: 1, recordId: `rec-${sampleName}` },
      });

      expect(res.diagnostics).toEqual([]);
      expect(res.gapBoundaries).toHaveLength(1);
      expect(res.gapBoundaries[0].kind).toBe('eof');

      // oracle.scenario 核对：
      // 110 task-create(0x20000100)
      // 120 task-ready(0x20000100)
      // 130 task-running(0x20000100) -> Ready [120,130]=10
      // 140 isr-outer(17) -> Task slice1 [130,140]=10
      // 150 isr-inner(18) -> ISR17 slice1 [140,150]=10
      // 160 isr-inner-exit -> ISR18 [150,160]=10
      // 170 isr-outer-exit -> ISR17 slice2 [160,170]=10, ISR17 activation incl=30 excl=20 preempted=10
      // 180 marker-start(300)
      // 190 marker-stop(300) -> Marker300 [180,190]=10
      // 200 task-terminate(0x20000100) -> Task slice2 [170,200]=30, Task activation incl=70 excl=40 preempted=30
      expect(res.readyWaits).toHaveLength(1);
      expect(res.readyWaits[0]).toMatchObject({
        completeness: 'complete',
        outcome: 'dispatched',
        tcbAddress: 0x20000100,
        taskGeneration: 1,
        durationTicks: '10',
        readyToRunningTicks: '10',
        timeDomain: 'anchored-ticks',
      });
      expect(res.readyWaits[0].start?.absoluteTicks).toBe('120');
      expect(res.readyWaits[0].end?.absoluteTicks).toBe('130');

      expect(res.executionSlices).toHaveLength(5);
      expect(
        res.executionSlices.map((s) => ({
          kind: s.contextKind,
          irqId: s.irqId,
          depth: s.isrDepth,
          start: s.start?.absoluteTicks,
          end: s.end?.absoluteTicks,
          dur: s.durationTicks,
          completeness: s.completeness,
        })),
      ).toEqual([
        { kind: 'task', irqId: undefined, depth: 0, start: '130', end: '140', dur: '10', completeness: 'complete' },
        { kind: 'isr', irqId: 17, depth: 1, start: '140', end: '150', dur: '10', completeness: 'complete' },
        { kind: 'isr', irqId: 18, depth: 2, start: '150', end: '160', dur: '10', completeness: 'complete' },
        { kind: 'isr', irqId: 17, depth: 1, start: '160', end: '170', dur: '10', completeness: 'complete' },
        { kind: 'task', irqId: undefined, depth: 0, start: '170', end: '200', dur: '30', completeness: 'complete' },
      ]);

      // 单核互斥总时长守恒：10 + 10 + 10 + 10 + 30 = 70 = 200 - 130
      const totalExclusive = res.executionSlices.reduce((acc, s) => acc + (s.durationTicksBigInt ?? 0n), 0n);
      expect(totalExclusive).toBe(70n);

      expect(res.contextActivations).toHaveLength(3);
      const isr18Act = res.contextActivations[0];
      const isr17Act = res.contextActivations[1];
      const taskAct = res.contextActivations[2];
      expect(isr18Act).toMatchObject({
        kind: 'isr',
        irqId: 18,
        isrDepth: 2,
        completeness: 'complete',
        inclusiveDurationTicks: '10',
        exclusiveDurationTicks: '10',
        preemptedDurationTicks: '0',
      });
      expect(isr17Act).toMatchObject({
        kind: 'isr',
        irqId: 17,
        isrDepth: 1,
        completeness: 'complete',
        inclusiveDurationTicks: '30',
        exclusiveDurationTicks: '20',
        preemptedDurationTicks: '10',
        preemptionCount: 1,
      });
      expect(taskAct).toMatchObject({
        kind: 'task-exec',
        tcbAddress: 0x20000100,
        completeness: 'complete',
        inclusiveDurationTicks: '70',
        exclusiveDurationTicks: '40',
        preemptedDurationTicks: '30',
        preemptionCount: 1,
        readyChainStatus: 'matched-ready',
        matchedReadyWaitId: res.readyWaits[0].waitId,
        endReason: 'task-terminate',
      });

      expect(res.markers).toHaveLength(1);
      expect(res.markers[0]).toMatchObject({
        markerId: 300,
        completeness: 'complete',
        durationTicks: '10',
        durationNs: '10000',
        startContextKey: taskAct.contextKey,
        endContextKey: taskAct.contextKey,
      });
      expect(res.markers[0].start?.absoluteTicks).toBe(String(oracle.scenario[7][0]));
      expect(res.markers[0].end?.absoluteTicks).toBe(String(oracle.scenario[8][0]));

      const taskSummary = res.tasksByInstanceId.get(taskAct.taskInstanceId!);
      expect(taskSummary).toMatchObject({
        tcbAddress: 0x20000100,
        generation: 1,
        createdInTrace: true,
        terminated: true,
        terminationSource: 'task-terminate',
        nameSource: 'missing',
      });
    }

    // continuous-overflow：包含段 1 完整场景、6000 个 MARK_START(index) 洪泛、OVERFLOW 缺口以及段 2 未闭合 MARK_START(42)
    {
      const { bytes, meta } = loadSample('continuous-overflow');
      const decoded = decodeSystemViewStream(bytes, { timestampBits: meta.timestampBits });
      const res = reconstructSystemViewTrace(decoded);

      expect(res.readyWaits).toHaveLength(1);
      expect(res.executionSlices).toHaveLength(5);
      const completeMarkers = res.markers.filter((m) => m.completeness === 'complete');
      expect(completeMarkers).toHaveLength(1);
      expect(completeMarkers[0]).toMatchObject({ markerId: 300, segmentId: 1, completeness: 'complete', durationTicks: '10' });
      const floodIncomplete = res.markers.filter((m) => m.completeness === 'incomplete');
      expect(floodIncomplete.length).toBeGreaterThan(100);
      const tailMarker42 = res.markers[res.markers.length - 1];
      expect(tailMarker42).toMatchObject({
        markerId: 42,
        segmentId: 2,
        completeness: 'incomplete',
        endReason: 'trace-stop',
      });
      expect(tailMarker42.durationTicks).toBeUndefined();
      expect(tailMarker42.observedUntil?.absoluteTicks).toBe('60220');
      expect(res.gapBoundaries.some((g) => g.kind === 'target-overflow')).toBe(true);
    }

    // single-shot-overflow：溢出丢包并提前截断无 TRACE_STOP，预溢出完整区间精确，洪泛 MARK_START 闭合为 incomplete
    {
      const { bytes, meta } = loadSample('single-shot-overflow');
      const decoded = decodeSystemViewStream(bytes, { timestampBits: meta.timestampBits });
      const res = reconstructSystemViewTrace(decoded);
      expect(res.readyWaits).toHaveLength(1);
      expect(res.executionSlices).toHaveLength(5);
      const completeMarkers = res.markers.filter((m) => m.completeness === 'complete');
      expect(completeMarkers).toHaveLength(1);
      expect(completeMarkers[0].markerId).toBe(300);
      expect(res.markers.filter((m) => m.completeness === 'incomplete').length).toBeGreaterThan(100);
    }

    // post-mortem：前缀被覆盖，首个可信同步段重建未闭合 MARK_START 与 TRACE_STOP，保留 prefix-overwritten 缺口
    {
      const { bytes, meta } = loadSample('post-mortem');
      const decoded = decodeSystemViewStream(bytes, { timestampBits: meta.timestampBits });
      const res = reconstructSystemViewTrace(decoded);
      expect(res.gapBoundaries[0].kind).toBe('prefix-overwritten');
      expect(res.markers.some((m) => m.completeness === 'complete')).toBe(false);
      expect(res.markers.filter((m) => m.completeness === 'incomplete').length).toBeGreaterThan(100);
      expect(res.executionSlices).toEqual([]);
    }
  });

  it('拆批与逐字节流式输入产生完全一致的重建区间，且重建器不持有历史完成区间', () => {
    for (const sampleName of ['continuous', 'continuous-overflow', 'post-mortem'] as const) {
      const { bytes, meta } = loadSample(sampleName);
      const oneShot = reconstructSystemViewTrace(decodeSystemViewStream(bytes, { timestampBits: meta.timestampBits }));

      const decoder = new SystemViewStreamDecoder({ timestampBits: meta.timestampBits });
      const reconstructor = new SystemViewTraceReconstructor();
      const slices: typeof oneShot.executionSlices[number][] = [];
      const acts: typeof oneShot.contextActivations[number][] = [];
      const waits: typeof oneShot.readyWaits[number][] = [];
      const markers: typeof oneShot.markers[number][] = [];
      const points: typeof oneShot.markerPoints[number][] = [];
      const gaps: typeof oneShot.gapBoundaries[number][] = [];

      const stepSizes = [1, 3, 7, 13, 29];
      let offset = 0;
      let batchSeq = 0;
      let stepIdx = 0;
      while (offset < bytes.length) {
        const size = stepSizes[stepIdx++ % stepSizes.length];
        const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + size));
        offset += chunk.length;
        const decBatch = decoder.push(chunk);
        const recBatch = reconstructor.pushBatch(decBatch, { batchSequence: ++batchSeq });
        slices.push(...recBatch.executionSlices);
        acts.push(...recBatch.contextActivations);
        waits.push(...recBatch.readyWaits);
        markers.push(...recBatch.markers);
        points.push(...recBatch.markerPoints);
        gaps.push(...recBatch.gapBoundaries);
      }
      const finDec = decoder.finish();
      const finRec1 = reconstructor.pushBatch(finDec, { batchSequence: ++batchSeq });
      const finRec2 = reconstructor.finish();
      slices.push(...finRec1.executionSlices, ...finRec2.executionSlices);
      acts.push(...finRec1.contextActivations, ...finRec2.contextActivations);
      waits.push(...finRec1.readyWaits, ...finRec2.readyWaits);
      markers.push(...finRec1.markers, ...finRec2.markers);
      points.push(...finRec1.markerPoints, ...finRec2.markerPoints);
      gaps.push(...finRec1.gapBoundaries, ...finRec2.gapBoundaries);

      expect(slices).toEqual(oneShot.executionSlices);
      expect(acts).toEqual(oneShot.contextActivations);
      expect(waits).toEqual(oneShot.readyWaits);
      expect(markers).toEqual(oneShot.markers);
      expect(points).toEqual(oneShot.markerPoints);
      expect(gaps).toEqual(oneShot.gapBoundaries);
    }
  });

  it('校验 FreeRTOS Ready 语义：完整链条、TASK_STOP_READY、运行态阻塞自调 STOP_READY、无前置 Ready 与重复 Ready', () => {
    const taskA = 0x20001000;
    const taskB = 0x20002000;
    const sA = shrink(taskA);
    const sB = shrink(taskB);

    const stream = new Uint8Array([
      ...makeStandardHeader({ cycles: 1000 }),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.TASK_INFO, makeTaskInfoPayload(sA, 2, 'TaskA'), 0),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.TASK_INFO, makeTaskInfoPayload(sB, 1, 'TaskB'), 0),
      // TaskA Ready(1010) -> Running(1035) => 完整链条 25 ticks
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.TASK_START_READY, encodeVarintU32(sA), 10),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.TASK_START_EXEC, encodeVarintU32(sA), 25),
      // TaskA 在 Running 中调用 vTaskPrioritySet 再次触发 TASK_START_READY -> 不得伪造 Ready 等待
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.TASK_START_READY, encodeVarintU32(sA), 5),
      // TaskA 阻塞（依据 SEGGER_SYSVIEW_FreeRTOS.h，运行中 TaskA 触发 OnTaskStopReady(A, 4)）-> 不报错 missing-ready-start
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.TASK_STOP_READY, [...encodeVarintU32(sA), ...encodeVarintU32(4)], 10),
      // TaskB 直接切换运行（无前置 TASK_START_READY）-> readyChainStatus='no-start-ready'，不伪造 Ready 延迟
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.TASK_START_EXEC, encodeVarintU32(sB), 5),
      // TaskA Ready(1060) -> 重复 Ready(1070) -> 被 Suspend STOP_READY(1090, cause=27)
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.TASK_START_READY, encodeVarintU32(sA), 5),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.TASK_START_READY, encodeVarintU32(sA), 10),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.TASK_STOP_READY, [...encodeVarintU32(sA), ...encodeVarintU32(27)], 20),
      // 未运行的 TaskA 在空等待时收到孤立 STOP_READY -> incomplete
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.TASK_STOP_READY, [...encodeVarintU32(sA), ...encodeVarintU32(4)], 10),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.TRACE_STOP, [], 10),
    ]);

    const res = reconstructSystemViewTrace(decodeSystemViewStream(stream));

    expect(res.readyWaits).toHaveLength(4);
    expect(res.readyWaits[0]).toMatchObject({
      completeness: 'complete',
      outcome: 'dispatched',
      label: 'TaskA',
      durationTicks: '25',
      readyToRunningTicks: '25',
    });
    expect(res.readyWaits[1]).toMatchObject({
      completeness: 'incomplete',
      outcome: 'incomplete',
      endReason: 'duplicate-task-ready',
    });
    expect(res.readyWaits[1].durationTicks).toBeUndefined();
    expect(res.readyWaits[1].readyToRunningTicks).toBeUndefined();

    expect(res.readyWaits[2]).toMatchObject({
      completeness: 'complete',
      outcome: 'removed-from-ready',
      durationTicks: '20',
      stopCause: 27,
      endReason: 'stop-ready',
    });
    expect(res.readyWaits[2].readyToRunningTicks).toBeUndefined();

    expect(res.readyWaits[3]).toMatchObject({
      completeness: 'incomplete',
      outcome: 'incomplete',
      endReason: 'stop-ready-without-start',
    });
    expect(res.readyWaits[3].start).toBeUndefined();
    expect(res.readyWaits[3].durationTicks).toBeUndefined();

    const taskBAct = res.contextActivations.find((a) => a.kind === 'task-exec' && a.tcbAddress === taskB);
    expect(taskBAct?.readyChainStatus).toBe('no-start-ready');
    expect(taskBAct?.matchedReadyWaitId).toBeUndefined();

    const diagCodes = res.diagnostics.map((d) => d.code);
    expect(diagCodes).toContain('ready-while-running');
    expect(diagCodes).toContain('duplicate-task-ready');
    expect(diagCodes).toContain('missing-ready-start');
  });

  it('处理多层嵌套 ISR、IDLE 抢占、Timer 回调与 ISR_TO_SCHEDULER，保持包含/独占时间精确无重复记账', () => {
    const taskA = 0x20001000;
    const taskB = 0x20002000;
    const timer1 = 0x20003000;

    const stream = new Uint8Array([
      ...makeStandardHeader({ cycles: 0 }),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.SYSDESC, encodeStr('N=App,I#15=SysTick,I#17=EXTI0'), 0),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.TASK_INFO, makeTaskInfoPayload(shrink(taskA), 2, 'TmrSvc'), 0),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.TASK_INFO, makeTaskInfoPayload(shrink(taskB), 3, 'Worker'), 0),
      ...makeExplicitPacket(SYSTEMVIEW_EVENT_IDS.NAME_RESOURCE, [...encodeVarintU32(shrink(timer1)), ...encodeStr('MyTimer')], 0),

      // t=10: TmrSvc 启动执行，t=20 进入 Timer，t=30 被 SysTick(15) 抢占，t=40 被 EXTI0(17) 抢占，
      // t=55 EXTI0 退出，t=70 SysTick 调用 ISR_TO_SCHEDULER
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.TASK_START_EXEC, encodeVarintU32(shrink(taskA)), 10),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.TIMER_ENTER, encodeVarintU32(shrink(timer1)), 10),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.ISR_ENTER, encodeVarintU32(15), 10),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.ISR_ENTER, encodeVarintU32(17), 10),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.ISR_EXIT, [], 15),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.ISR_TO_SCHEDULER, [], 15),
      // t=70..80 为 Scheduler 调度窗口，t=80 Worker 开始运行 -> t=100 IDLE -> t=110 SysTick -> t=120 恢复 IDLE -> t=130 TRACE_STOP
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.TASK_START_EXEC, encodeVarintU32(shrink(taskB)), 10),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.IDLE, [], 20),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.ISR_ENTER, encodeVarintU32(15), 10),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.ISR_EXIT, [], 10),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.TRACE_STOP, [], 10),
    ]);

    const res = reconstructSystemViewTrace(decodeSystemViewStream(stream), {
      symbolMap: {
        interrupts: { 15: 'FallbackSysTick', 19: 'EXTI3_IRQHandler' },
      },
    });

    // SYSDESC 优先于 symbolMap
    const isr15Act = res.contextActivations.find((a) => a.kind === 'isr' && a.irqId === 15 && a.start?.relativeTicks === '30');
    const isr17Act = res.contextActivations.find((a) => a.kind === 'isr' && a.irqId === 17);
    expect(isr15Act).toMatchObject({
      label: 'SysTick',
      labelSource: 'sysdesc',
      completeness: 'complete',
      inclusiveDurationTicks: '40', // 30..70
      exclusiveDurationTicks: '25', // 30..40 (10) + 55..70 (15)
      preemptedDurationTicks: '15',
      endReason: 'isr-to-scheduler',
    });
    expect(isr17Act).toMatchObject({
      label: 'EXTI0',
      labelSource: 'sysdesc',
      completeness: 'complete',
      inclusiveDurationTicks: '15', // 40..55
      exclusiveDurationTicks: '15',
    });

    const taskAAct = res.contextActivations.find((a) => a.kind === 'task-exec' && a.tcbAddress === taskA);
    expect(taskAAct).toMatchObject({
      completeness: 'complete',
      inclusiveDurationTicks: '60', // 10..70 (ISR_TO_SCHEDULER 结束驻留)
      exclusiveDurationTicks: '20', // 10..30
      preemptedDurationTicks: '40', // 30..70
      endReason: 'preempted-to-scheduler',
    });

    // Timer 在 ISR_TO_SCHEDULER 时仍在栈上，未见 TIMER_EXIT 因而于 trace-stop 关闭为 incomplete
    const timerAct = res.contextActivations.find((a) => a.kind === 'timer');
    expect(timerAct).toMatchObject({
      label: 'MyTimer',
      labelSource: 'name-resource',
      completeness: 'incomplete',
      endReason: 'trace-stop',
    });
    expect(timerAct?.inclusiveDurationTicks).toBeUndefined();
    expect(timerAct?.exclusiveDurationTicks).toBeUndefined();

    // 验证全段 [10, 120] 完整独占切片完全不重叠且总和等于 110
    const completeSlices = res.executionSlices.filter((s) => s.completeness === 'complete');
    expect(
      completeSlices.map((s) => `${s.contextKind}:${s.irqId ?? s.label ?? ''}[${s.start?.relativeTicks}-${s.end?.relativeTicks}]`),
    ).toEqual([
      'task:TmrSvc[10-30]',
      'isr:15[30-40]',
      'isr:17[40-55]',
      'isr:15[55-70]',
      'scheduler:Scheduler[70-80]',
      'task:Worker[80-100]',
      'idle:IDLE[100-110]',
      'isr:15[110-120]',
    ]);
    expect(completeSlices.reduce((sum, s) => sum + s.durationTicksBigInt!, 0n)).toBe(110n);

    // 末尾 IDLE(120..130) 由 TRACE_STOP 打断，标为 incomplete
    const tailIdle = res.executionSlices[res.executionSlices.length - 1];
    expect(tailIdle).toMatchObject({
      contextKind: 'idle',
      completeness: 'incomplete',
      endReason: 'trace-stop',
    });
    expect(tailIdle.durationTicks).toBeUndefined();
    expect(tailIdle.observedUntil?.relativeTicks).toBe('130');
  });

  it('TCB 地址复用时隔离代次，不沿用旧创建期的名称、优先级与栈信息，并正确处理 OS_vTaskDelete 自删', () => {
    const addr = 0x20004000;
    const other = 0x20005000;
    const sAddr = shrink(addr);
    const sOther = shrink(other);

    const stream = new Uint8Array([
      ...makeStandardHeader({ cycles: 0 }),
      // 第一代 TaskOld
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.TASK_CREATE, encodeVarintU32(sAddr), 10),
      ...makeExplicitPacket(SYSTEMVIEW_EVENT_IDS.TASK_INFO, makeTaskInfoPayload(sAddr, 4, 'OldTask'), 0),
      ...makeShortPacket(
        SYSTEMVIEW_EVENT_IDS.STACK_INFO,
        [...encodeVarintU32(sAddr), ...encodeVarintU32(0x20008000), ...encodeVarintU32(1024), ...encodeVarintU32(128)],
        0,
      ),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.TASK_START_READY, encodeVarintU32(sAddr), 10),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.TASK_START_EXEC, encodeVarintU32(sAddr), 10),
      // 自删：vTaskDelete(addr) 后在 PendSV/TASK_START_EXEC(other) 切换前仍短暂执行
      ...makeExplicitPacket(SYSTEMVIEW_EVENT_IDS.INIT + 8 + 2, [], 0), // dummy? No! Use exact FREERTOS_API_OFFSET + 2
      ...makeExplicitPacket(SYSTEMVIEW_FREERTOS_API_OFFSET + 2, encodeVarintU32(sAddr), 10),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.TASK_START_EXEC, encodeVarintU32(sOther), 10),
      // 同地址复用第二代：不发送 TASK_INFO，验证绝不沿用 OldTask 或 symbolMap 静态名
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.TASK_CREATE, encodeVarintU32(sAddr), 20),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.TASK_START_READY, encodeVarintU32(sAddr), 10),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.TASK_START_EXEC, encodeVarintU32(sAddr), 10),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.TASK_TERMINATE, encodeVarintU32(sAddr), 20),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.TRACE_STOP, [], 10),
    ]);

    // 去掉上面注释里误写的那行，重新构造干净流
    const cleanStream = new Uint8Array([
      ...makeStandardHeader({ cycles: 0 }),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.TASK_CREATE, encodeVarintU32(sAddr), 10),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.TASK_INFO, makeTaskInfoPayload(sAddr, 4, 'OldTask'), 0),
      ...makeShortPacket(
        SYSTEMVIEW_EVENT_IDS.STACK_INFO,
        [...encodeVarintU32(sAddr), ...encodeVarintU32(0x20008000), ...encodeVarintU32(1024), ...encodeVarintU32(128)],
        0,
      ),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.TASK_START_READY, encodeVarintU32(sAddr), 10),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.TASK_START_EXEC, encodeVarintU32(sAddr), 10),
      ...makeExplicitPacket(SYSTEMVIEW_FREERTOS_API_OFFSET + 2, encodeVarintU32(sAddr), 10),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.TASK_START_EXEC, encodeVarintU32(sOther), 10),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.TASK_CREATE, encodeVarintU32(sAddr), 20),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.TASK_START_READY, encodeVarintU32(sAddr), 10),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.TASK_START_EXEC, encodeVarintU32(sAddr), 10),
      ...makeExplicitPacket(SYSTEMVIEW_EVENT_IDS.TASK_TERMINATE, encodeVarintU32(sAddr), 20),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.TRACE_STOP, [], 10),
    ]);
    void stream;

    const res = reconstructSystemViewTrace(decodeSystemViewStream(cleanStream), {
      symbolMap: { tasks: { [addr]: 'StaticFallbackName' } },
    });

    const addrTasks = Array.from(res.tasksByInstanceId.values()).filter((t) => t.tcbAddress === addr);
    expect(addrTasks).toHaveLength(2);
    const gen1 = addrTasks[0];
    const gen2 = addrTasks[1];
    expect(gen1.taskInstanceId).not.toBe(gen2.taskInstanceId);
    expect(gen1).toMatchObject({
      generation: 1,
      name: 'OldTask',
      nameSource: 'task-info',
      priority: 4,
      terminated: true,
      terminationSource: 'os-vtask-delete',
    });
    expect(gen1?.stackInfo?.stackSize).toBe(1024);
    // 自删在 t=40 触发，直到 t=50 切换给 sOther 时才关闭执行区间
    expect(gen1?.terminatedAt?.relativeTicks).toBe('50');

    expect(gen2).toMatchObject({
      generation: 2,
      nameSource: 'missing',
      terminated: true,
      terminationSource: 'task-terminate',
    });
    expect(gen2?.name).toBeUndefined();
    expect(gen2?.priority).toBeUndefined();
    expect(gen2?.stackInfo).toBeUndefined();

    const gen2Slice = res.executionSlices.find((s) => s.taskInstanceId === gen2!.taskInstanceId);
    expect(gen2Slice).toMatchObject({
      labelSource: 'missing',
      durationTicks: '20',
    });
    expect(gen2Slice?.label).toBeUndefined();
  });

  it('拒绝伪造完整区间：非法重入 ISR、缺失 ISR 退出、重复 Marker、孤立退出、失序时间戳、半段 EOF 与无创建中途开始', () => {
    const taskA = 0x20001000;
    const sA = shrink(taskA);

    // 场景 A：中途开始（无 TRACE_START+INIT 但用 initialSyncMode='synced' 对齐的流，先遇到孤立退出和未命名任务）
    const midStartStream = new Uint8Array([
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.ISR_EXIT, [], 5),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.MARK_STOP, encodeVarintU32(99), 5),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.TASK_STOP_EXEC, [], 5),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.TASK_START_EXEC, encodeVarintU32(sA), 10),
    ]);
    const midRes = reconstructSystemViewTrace(
      decodeSystemViewStream(midStartStream, { initialSyncMode: 'synced' }),
    );
    expect(midRes.diagnostics.map((d) => d.code)).toEqual(
      expect.arrayContaining(['orphan-isr-exit', 'orphan-marker-stop', 'orphan-task-stop-exec', 'missing-init-for-id']),
    );
    // 缺 INIT 时绝不伪造真实 TCB 地址
    const midTask = Array.from(midRes.tasksByInstanceId.values())[0];
    expect(midTask.tcbAddress).toBeUndefined();
    expect(midTask.addressStatus).toBe('unresolved-missing-init');
    expect(midTask.createdInTrace).toBe(false);
    // 半段 EOF 截断未闭合任务切片
    const midLastSlice = midRes.executionSlices[midRes.executionSlices.length - 1];
    expect(midLastSlice.completeness).toBe('incomplete');
    expect(midLastSlice.end).toBeUndefined();
    expect(midLastSlice.durationTicks).toBeUndefined();

    // 场景 B：非法同号 ISR 重入、缺失 ISR 退出、重复 MARK_START -> 单次 MARK_STOP
    const anomalyStream = new Uint8Array([
      ...makeStandardHeader({ cycles: 100 }),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.TASK_START_EXEC, encodeVarintU32(sA), 10),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.ISR_ENTER, encodeVarintU32(17), 10),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.ISR_ENTER, encodeVarintU32(17), 10), // 非法重入自身
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.ISR_EXIT, [], 10),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.TASK_START_EXEC, encodeVarintU32(shrink(0x20002000)), 10), // 缺失外层 ISR 17 退出
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.MARK_START, encodeVarintU32(55), 5),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.MARK_START, encodeVarintU32(55), 5), // 重复 Marker
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.MARK_STOP, encodeVarintU32(55), 10),
      // 末尾半包截断（只有 1 字节事件 ID 0x02 缺参数）
      0x02,
    ]);
    const anomRes = reconstructSystemViewTrace(decodeSystemViewStream(anomalyStream));
    expect(anomRes.diagnostics.map((d) => d.code)).toEqual(
      expect.arrayContaining(['illegal-isr-reentry', 'missing-isr-exit', 'duplicate-marker-start']),
    );
    for (const isrAct of anomRes.contextActivations.filter((a) => a.kind === 'isr')) {
      expect(isrAct.completeness).toBe('incomplete');
      expect(isrAct.inclusiveDurationTicks).toBeUndefined();
    }
    expect(anomRes.markers).toHaveLength(2);
    for (const m of anomRes.markers) {
      expect(m.completeness).toBe('incomplete');
      expect(m.durationTicks).toBeUndefined();
    }

    // 场景 C：段内时间戳倒退失序
    const baseBatch = decodeSystemViewStream(
      new Uint8Array([
        ...makeStandardHeader({ cycles: 0 }),
        ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.MARK_START, encodeVarintU32(7), 50),
        ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.MARK_STOP, encodeVarintU32(7), 10),
      ]),
    );
    const outOfOrderPackets: DecodedSystemViewPacket[] = [
      baseBatch.packets[0],
      baseBatch.packets[1],
      baseBatch.packets[2],
      baseBatch.packets[3], // t=50 MARK_START
      {
        ...baseBatch.packets[4],
        segmentRelativeTicks: '40',
        segmentRelativeTicksBigInt: 40n,
        absoluteTicks: '40',
        absoluteTicksBigInt: 40n,
      },
    ];
    const ooRes = reconstructSystemViewTrace({ ...baseBatch, packets: outOfOrderPackets });
    expect(ooRes.diagnostics.some((d) => d.code === 'timestamp-out-of-order')).toBe(true);
    expect(ooRes.markers[0].completeness).toBe('incomplete');
    expect(ooRes.markers[0].durationTicks).toBeUndefined();
  });

  it('在外部缺口、目标 reset 与会话/记录/批次身份隔离下正确切断区间并拒绝错包', () => {
    const taskA = 0x20001000;
    const sA = shrink(taskA);

    const seg1Bytes = new Uint8Array([
      ...makeStandardHeader({ cycles: 100 }),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.TASK_CREATE, encodeVarintU32(sA), 10),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.TASK_INFO, makeTaskInfoPayload(sA, 2, 'Boot1Task'), 0),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.TASK_START_READY, encodeVarintU32(sA), 5),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.MARK_START, encodeVarintU32(12), 5),
    ]);

    const dec = new SystemViewStreamDecoder();
    const rec = new SystemViewTraceReconstructor({
      identity: { sessionId: 'sess-A', sessionGeneration: 2, bootGeneration: 1, recordId: 'rec-1' },
    });

    const b1 = rec.pushBatch(dec.push(seg1Bytes), {
      identity: { sessionId: 'sess-A', sessionGeneration: 2, bootGeneration: 1, recordId: 'rec-1' },
      batchSequence: 1,
    });
    expect(b1.accepted).toBe(true);

    // 错会话 / 错记录 / 乱序 batchSequence 必须被拒且不污染状态
    const badSess = rec.pushBatch(
      { packets: [], syncs: [], gaps: [], segments: [], diagnostics: [] },
      { identity: { sessionId: 'sess-B', sessionGeneration: 2, bootGeneration: 1, recordId: 'rec-1' }, batchSequence: 2 },
    );
    expect(badSess.accepted).toBe(false);
    expect(badSess.errorCode).toBe('SessionChanged');

    const badSeq = rec.pushBatch(
      { packets: [], syncs: [], gaps: [], segments: [], diagnostics: [] },
      { identity: { sessionId: 'sess-A', sessionGeneration: 2, bootGeneration: 1, recordId: 'rec-1' }, batchSequence: 1 },
    );
    expect(badSeq.accepted).toBe(false);
    expect(badSeq.errorCode).toBe('BatchSequenceInvalid');

    // 主动传入 host-drop 缺口：必须闭合 openReady 与 openMarker 为 incomplete
    const gapRes = rec.markGap({ kind: 'host-drop', droppedBytes: 64, reason: 'USB 丢包' });
    expect(gapRes.readyWaits).toHaveLength(1);
    expect(gapRes.readyWaits[0].completeness).toBe('incomplete');
    expect(gapRes.readyWaits[0].endReason).toBe('host-drop');
    expect(gapRes.markers).toHaveLength(1);
    expect(gapRes.markers[0].completeness).toBe('incomplete');
    expect(gapRes.markers[0].endReason).toBe('host-drop');

    // 缺口后重新运行同地址任务但无新 TASK_INFO：隔离为新未知代次且不沿用 Boot1Task 名字，若新段直接 MARK_STOP(12) 必须视为 orphan
    const afterGapBytes = new Uint8Array([
      ...makeStandardHeader({ cycles: 500 }),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.MARK_STOP, encodeVarintU32(12), 10),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.TASK_START_EXEC, encodeVarintU32(sA), 10),
    ]);
    const decAfterGap = new SystemViewStreamDecoder();
    const b2 = rec.pushBatch(decAfterGap.push(afterGapBytes), { batchSequence: 2 });
    expect(b2.markers[0].completeness).toBe('incomplete');
    expect(b2.markers[0].endReason).toBe('orphan-marker-stop');
    const postGapTask = b2.taskUpdates.find((t) => t.tcbAddress === taskA);
    expect(postGapTask?.generation).toBe(2);
    expect(postGapTask?.name).toBeUndefined();
    expect(postGapTask?.identityConfidence).toBe('carried-across-gap');

    // 不连续批次（跳过 batchSequence=3 直接投递 4）必须被明确拒绝，且不破坏已存在状态
    const gapSeqBatch = rec.pushBatch(
      { packets: [], syncs: [], gaps: [], segments: [], diagnostics: [] },
      { identity: { sessionId: 'sess-A', sessionGeneration: 2, bootGeneration: 1, recordId: 'rec-1' }, batchSequence: 4 },
    );
    expect(gapSeqBatch.accepted).toBe(false);
    expect(gapSeqBatch.errorCode).toBe('BatchSequenceGap');
    expect(gapSeqBatch.diagnostics[0].code).toBe('batch-sequence-gap');

    // 目标 reset (bootGeneration 1 -> 2)：切断正在运行任务并彻底清空旧 boot 的任务名称/代次；batchSequence 跨 boot 保持连续
    const segBoot2 = new Uint8Array([
      ...makeStandardHeader({ cycles: 0 }),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.TASK_START_EXEC, encodeVarintU32(sA), 10),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.TRACE_STOP, [], 15),
    ]);
    const decBoot2 = new SystemViewStreamDecoder();
    const b3 = rec.pushBatch(decBoot2.push(segBoot2), {
      identity: { sessionId: 'sess-A', sessionGeneration: 2, bootGeneration: 2, recordId: 'rec-1' },
      batchSequence: 3,
    });
    expect(b3.accepted).toBe(true);
    expect(b3.gapBoundaries[0].kind).toBe('target-reset');
    // 旧 boot 的运行切片以 target-reset 闭合为 incomplete
    expect(b3.executionSlices[0]).toMatchObject({
      bootGeneration: 1,
      completeness: 'incomplete',
      endReason: 'target-reset',
    });
    expect(b3.executionSlices[0].durationTicks).toBeUndefined();
    // 新 boot 同地址绝不沿用 Boot1Task 名字
    expect(b3.executionSlices[1]).toMatchObject({
      bootGeneration: 2,
      labelSource: 'missing',
      completeness: 'incomplete',
      endReason: 'trace-stop',
    });
    expect(b3.executionSlices[1].label).toBeUndefined();
    expect(b3.executionSlices[1].durationTicks).toBeUndefined();

    // 验证 EX_MARK 点事件与 EX_NAME_MARKER 名称绑定
    const exStream = new Uint8Array([
      ...makeStandardHeader({ cycles: 0 }),
      ...makeExplicitPacket(SYSTEMVIEW_EVENT_IDS.EX, [SYSTEMVIEW_EX_IDS.NAME_MARKER, ...encodeVarintU32(77), ...encodeStr('SyncPt')], 0),
      ...makeExplicitPacket(SYSTEMVIEW_EVENT_IDS.EX, [SYSTEMVIEW_EX_IDS.MARK, ...encodeVarintU32(77)], 12),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.TRACE_STOP, [], 5),
    ]);
    const exRes = reconstructSystemViewTrace(decodeSystemViewStream(exStream));
    expect(exRes.markerPoints).toHaveLength(1);
    expect(exRes.markerPoints[0]).toMatchObject({
      markerId: 77,
      name: 'SyncPt',
      nameSource: 'ex-name-marker',
    });
    expect(exRes.markerPoints[0].time.absoluteTicks).toBe('12');
  });

  it('支持缺失绝对时间与零频率的退化，以及超过 Number.MAX_SAFE_INTEGER 的 bigint 精度', () => {
    const taskA = 0x20001000;
    const sA = shrink(taskA);

    // 无 SYSTIME_CYCLES 且 sysFreqHz=0
    const noTimeStream = new Uint8Array([
      ...makeStandardHeader({ sysFreq: 0, includeSystime: false }),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.TASK_START_READY, encodeVarintU32(sA), 100),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.TASK_START_EXEC, encodeVarintU32(sA), 250),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.TASK_STOP_EXEC, [], 400),
    ]);
    const res = reconstructSystemViewTrace(decodeSystemViewStream(noTimeStream));
    expect(res.readyWaits[0]).toMatchObject({
      completeness: 'complete',
      durationTicks: '250',
      timeDomain: 'segment-relative-ticks',
    });
    expect(res.readyWaits[0].durationNs).toBeUndefined();
    expect(res.readyWaits[0].start?.absoluteTicks).toBeUndefined();
    expect(res.executionSlices[0]).toMatchObject({
      completeness: 'complete',
      durationTicks: '400',
      timeDomain: 'segment-relative-ticks',
    });
    expect(res.executionSlices[0].durationNs).toBeUndefined();

    // 超大 bigint 精度验证（> 2^53）
    const baseDecoded = decodeSystemViewStream(
      new Uint8Array([
        ...makeStandardHeader({ sysFreq: 1_000_000, cycles: 0 }),
        ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.MARK_START, encodeVarintU32(1), 10),
        ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.MARK_STOP, encodeVarintU32(1), 17),
      ]),
    );
    const hugeBase = (1n << 60n) + 1234567890123n;
    const patchedPackets: DecodedSystemViewPacket[] = baseDecoded.packets.map((p, idx) => {
      if (idx === 3) {
        const t = hugeBase;
        return { ...p, segmentRelativeTicks: t.toString(), segmentRelativeTicksBigInt: t, absoluteTicks: t.toString(), absoluteTicksBigInt: t };
      }
      if (idx === 4) {
        const t = hugeBase + 17n;
        return { ...p, segmentRelativeTicks: t.toString(), segmentRelativeTicksBigInt: t, absoluteTicks: t.toString(), absoluteTicksBigInt: t };
      }
      return p;
    });
    const hugeRes = reconstructSystemViewTrace({ ...baseDecoded, packets: patchedPackets });
    expect(hugeRes.markers[0].start?.absoluteTicksBigInt).toBe(hugeBase);
    expect(hugeRes.markers[0].end?.absoluteTicksBigInt).toBe(hugeBase + 17n);
    expect(hugeRes.markers[0].durationTicksBigInt).toBe(17n);
    expect(hugeRes.markers[0].durationTicks).toBe('17');
    expect(hugeRes.markers[0].durationNs).toBe('17000');
  });

  it('在持续流与大量未闭合区间下保持运行状态有界，触发预算淘汰并标为不完整', () => {
    const rec = new SystemViewTraceReconstructor({
      maxOpenMarkers: 4,
      maxOpenReadyTasks: 4,
      maxIsrDepth: 3,
      maxTrackedTasks: 10,
      maxKnownTaskAddresses: 16,
    });

    const header = decodeSystemViewStream(new Uint8Array([...makeStandardHeader({ cycles: 0 })]));
    rec.pushBatch({ packets: header.packets, syncs: header.syncs, gaps: [], segments: [], diagnostics: [] }, { batchSequence: 1 });

    // 注入 10 个未闭合 Marker 与 10 个未闭合 Ready + 4 层 ISR 嵌套，检查预算淘汰与状态大小上限
    const floodBytes: number[] = [];
    for (let i = 1; i <= 10; i++) {
      floodBytes.push(...makeShortPacket(SYSTEMVIEW_EVENT_IDS.MARK_START, encodeVarintU32(i), 1));
      floodBytes.push(...makeShortPacket(SYSTEMVIEW_EVENT_IDS.TASK_START_READY, encodeVarintU32(i), 1));
    }
    for (let irq = 10; irq < 14; irq++) {
      floodBytes.push(...makeShortPacket(SYSTEMVIEW_EVENT_IDS.ISR_ENTER, encodeVarintU32(irq), 1));
    }
    // 再运行 50 轮闭环任务切片，确认已闭合区间不留在重建器内
    for (let k = 0; k < 50; k++) {
      floodBytes.push(...makeShortPacket(SYSTEMVIEW_EVENT_IDS.MARK_START, encodeVarintU32(1000 + k), 1));
      floodBytes.push(...makeShortPacket(SYSTEMVIEW_EVENT_IDS.MARK_STOP, encodeVarintU32(1000 + k), 2));
    }

    const dec = new SystemViewStreamDecoder({ initialSyncMode: 'synced' });
    const batch = dec.push(new Uint8Array(floodBytes));
    // 对齐 segmentId=1
    const alignedPackets = batch.packets.map((p, i) => ({
      ...p,
      segmentId: 1,
      packetIndexInSegment: i + 3,
      segmentRelativeTicks: String(i + 1),
      segmentRelativeTicksBigInt: BigInt(i + 1),
    }));
    const out = rec.pushBatch({ ...batch, packets: alignedPackets }, { batchSequence: 2 });
    const state = rec.getState();

    expect(state.openMarkerCount).toBeLessThanOrEqual(4);
    expect(state.openReadyCount).toBeLessThanOrEqual(4);
    expect(state.activeIsrDepth).toBeLessThanOrEqual(3);
    expect(state.trackedTaskCount).toBeLessThanOrEqual(10);
    expect(state.knownTaskAddressCount).toBeLessThanOrEqual(16);
    expect(state.totalBudgetEvictions).toBeGreaterThan(0);
    expect(out.diagnostics.some((d) => d.code === 'budget-exceeded')).toBe(true);
    expect(out.markers.some((m) => m.endReason === 'budget-evicted' && m.completeness === 'incomplete')).toBe(true);
    expect(out.readyWaits.some((r) => r.endReason === 'budget-evicted' && r.completeness === 'incomplete')).toBe(true);
  });

  it('在 maxKnownTaskAddresses / maxTrackedTasks 受限淘汰旧地址后，再次复用首地址仍分配全局唯一 taskInstanceId 且不复用静态符号', () => {
    const reuseAddr = 0x20000100;
    const cycles: number[] = [];
    for (let i = 0; i < 10; i++) {
      const s = 0x40 + i;
      cycles.push(
        ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.TASK_CREATE, encodeVarintU32(s), 1),
        ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.TASK_START_EXEC, encodeVarintU32(s), 1),
        ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.TASK_STOP_EXEC, [], 1),
        ...makeExplicitPacket(SYSTEMVIEW_EVENT_IDS.TASK_TERMINATE, encodeVarintU32(s), 1),
      );
    }
    cycles.push(
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.TASK_CREATE, encodeVarintU32(0x40), 1),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.TASK_START_EXEC, encodeVarintU32(0x40), 1),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.TASK_STOP_EXEC, [], 1),
      ...makeExplicitPacket(SYSTEMVIEW_EVENT_IDS.TASK_TERMINATE, encodeVarintU32(0x40), 1),
    );
    const stream = new Uint8Array([...makeStandardHeader({ cycles: 100 }), ...cycles]);
    const res = reconstructSystemViewTrace(decodeSystemViewStream(stream), {
      maxKnownTaskAddresses: 8,
      maxTrackedTasks: 8,
      symbolMap: { tasks: { [reuseAddr]: 'InitialStaticTask' } },
    });

    expect(res.summary.knownTaskAddressCount).toBeLessThanOrEqual(8);
    expect(res.summary.trackedTaskCount).toBeLessThanOrEqual(8);
    const reuseSlices = res.executionSlices.filter((s) => s.tcbAddress === reuseAddr);
    expect(reuseSlices).toHaveLength(2);
    expect(reuseSlices[0].taskInstanceId).not.toBe(reuseSlices[1].taskInstanceId);
    expect(reuseSlices[0].label).toBe('InitialStaticTask');
    expect(reuseSlices[1].label).toBeUndefined();
    expect(reuseSlices[1].labelSource).toBe('missing');
    expect(res.tasksByInstanceId.size).toBe(11);
  });
});

// 保留类型检查用常量引用以避免未使用的 PROTOCOL_VERSION 警告
void SYSTEMVIEW_PROTOCOL_VERSION;
void SYSTEMVIEW_EX_IDS;
