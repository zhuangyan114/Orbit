import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DecodedSystemViewPacket,
  decodeSystemViewStream,
  SystemViewDecodeBatch,
  SystemViewDecoderOptions,
  SystemViewStreamDecoder,
} from './systemview-decoder';
import {
  expandShrunkId,
  FREERTOS_API_NAMES,
  parseSystemDescription,
  SYSTEMVIEW_EVENT_IDS,
  SYSTEMVIEW_EX_IDS,
  SYSTEMVIEW_FREERTOS_API_OFFSET,
  SYSTEMVIEW_PROTOCOL_VERSION,
} from './systemview-protocol';

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

function encodeStr(text: string, force3Byte = false): number[] {
  const raw = Array.from(Buffer.from(text, 'utf8'));
  if (!force3Byte && raw.length < 255) {
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
}): number[] {
  const sysFreq = opts?.sysFreq ?? 1_000_000;
  const cpuFreq = opts?.cpuFreq ?? 64_000_000;
  const ramBase = opts?.ramBase ?? 0x20000000;
  const idShift = opts?.idShift ?? 2;
  const cycles = opts?.cycles ?? 100;
  return [
    ...makeSync(),
    ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.TRACE_START, [], 0),
    ...makeExplicitPacket(SYSTEMVIEW_EVENT_IDS.INIT, makeInitPayload(sysFreq, cpuFreq, ramBase, idShift), 0),
    ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.SYSTIME_CYCLES, encodeVarintU32(cycles), 0),
  ];
}

function simplifyPackets(packets: readonly DecodedSystemViewPacket[]) {
  return packets.map((p) => ({
    segmentId: p.segmentId,
    offset: p.streamByteOffset,
    byteLength: p.byteLength,
    eventId: p.eventId,
    deltaTicks: p.deltaTicks,
    rel: p.segmentRelativeTicks,
    abs: p.absoluteTicks,
    us: p.timestampUs,
    reliability: p.segmentReliability,
    schemaReliability: p.schemaReliability,
    timeAnchorStatus: p.timeAnchorStatus,
    decodedKind: p.decoded.kind,
  }));
}

describe('SystemView 3.32.0 流式解码器 (阶段 4.1)', () => {
  it('与独立样本 continuous / single-shot 及手工 oracle.json 逐包一致', () => {
    const oracle = loadOracle();

    for (const sampleName of ['continuous', 'single-shot'] as const) {
      const { bytes, meta } = loadSample(sampleName);
      const res = decodeSystemViewStream(bytes, { timestampBits: meta.timestampBits });

      expect(res.summary.protocolVersion).toBe(SYSTEMVIEW_PROTOCOL_VERSION);
      expect(res.gaps).toEqual([]);
      expect(res.diagnostics).toEqual([]);
      expect(res.segments).toHaveLength(1);
      expect(res.segments[0]).toMatchObject({
        segmentId: 1,
        startByteOffset: 0,
        endByteOffset: bytes.length,
        reliability: 'trusted',
        syncProof: 'trace-start-init',
        closed: true,
        endReason: 'eof',
        timeAnchorStatus: 'anchored-cycles',
        metadata: {
          sysFreqHz: meta.frequencyHz,
          cpuFreqHz: 64_000_000,
          ramBaseAddress: 0x20000000,
          idShift: 2,
        },
      });

      // 前 4 包：TRACE_START, INIT, SYSTIME_CYCLES(100), NUMMODULES(0)
      expect(res.packets[0].eventId).toBe(SYSTEMVIEW_EVENT_IDS.TRACE_START);
      expect(res.packets[0].absoluteTicks).toBeUndefined();
      expect(res.packets[0].timeAnchorStatus).toBe('unanchored');

      expect(res.packets[1].decoded).toEqual({
        kind: 'init',
        sysFreqHz: 1_000_000,
        cpuFreqHz: 64_000_000,
        ramBaseAddress: 0x20000000,
        idShift: 2,
      });

      expect(res.packets[2].decoded).toEqual({ kind: 'systime-cycles', cycles: 100 });
      expect(res.packets[2].absoluteTicks).toBe('100');
      expect(res.packets[2].timestampUs).toBe(100);

      expect(res.packets[3].decoded).toEqual({ kind: 'nummodules', numModules: 0 });

      // 对照 oracle.json + checks 的 10 个包与结尾 TRACE_STOP
      expect(res.packets.length).toBe(4 + meta.checks.length + 1);

      for (let i = 0; i < meta.checks.length; i++) {
        const check = meta.checks[i];
        const pkt = res.packets[4 + i];
        const expectedBytes = Buffer.from(oracle.packets[check.name], 'hex');
        const scenarioEntry = oracle.scenario[i];
        expect(pkt.streamByteOffset).toBe(check.offset);
        expect(pkt.byteLength).toBe(check.length);
        expect(pkt.byteLength).toBe(expectedBytes.length);
        expect(pkt.absoluteTicks).toBe(String(scenarioEntry[0]));
        expect(pkt.timestampUs).toBe(scenarioEntry[0]);
      }

      // 核对 SHRINK_ID 还原 TaskHandle 0x20000100 及嵌套 ISR / Marker
      expect(res.packets[4].decoded).toEqual({
        kind: 'task-create',
        shrunkTaskId: 0x40,
        taskId: 0x20000100,
        idResolution: 'resolved',
      });
      expect(res.packets[6].decoded).toEqual({
        kind: 'task-start-exec',
        shrunkTaskId: 0x40,
        taskId: 0x20000100,
        idResolution: 'resolved',
      });
      expect(res.packets[7].decoded).toEqual({ kind: 'isr-enter', irqId: 17 });
      expect(res.packets[8].decoded).toEqual({ kind: 'isr-enter', irqId: 18 });
      expect(res.packets[9].decoded).toEqual({ kind: 'isr-exit' });
      expect(res.packets[10].decoded).toEqual({ kind: 'isr-exit' });
      expect(res.packets[11].decoded).toEqual({ kind: 'mark-start', markerId: 300 });
      expect(res.packets[12].decoded).toEqual({ kind: 'mark-stop', markerId: 300 });
      expect(res.packets[13].decoded).toEqual({
        kind: 'task-terminate',
        shrunkTaskId: 0x40,
        taskId: 0x20000100,
        idResolution: 'resolved',
      });
      expect(res.packets[14].decoded).toEqual({ kind: 'trace-stop' });
      expect(res.packets[14].absoluteTicks).toBe('210');
    }
  });

  it('正确解码 continuous-overflow 与 single-shot-overflow 样本并保留溢出边界', () => {
    const contOv = loadSample('continuous-overflow');
    const contRes = decodeSystemViewStream(contOv.bytes, { timestampBits: contOv.meta.timestampBits });

    expect(contOv.meta.integrity).toBe('target-overflow');
    expect(contRes.gaps).toHaveLength(1);
    expect(contRes.gaps[0]).toMatchObject({
      kind: 'target-overflow',
      droppedPackets: 'unknown',
      droppedBytes: 'unknown',
      rawDropCount: 3936,
      minDroppedPackets: 3937,
      preservesFraming: true,
    });
    expect(contRes.segments).toHaveLength(2);
    expect(contRes.segments[0].endReason).toBe('target-overflow');
    expect(contRes.segments[1].startByteOffset).toBe(contRes.gaps[0].byteOffset);

    const overflowPkt = contRes.packets.find((p) => p.decoded.kind === 'overflow');
    expect(overflowPkt).toBeDefined();
    expect(overflowPkt!.decoded).toEqual({
      kind: 'overflow',
      rawDropCount: 3936,
      incrementalRawDropDelta: 3936,
      minDroppedPackets: 3937,
    });
    expect(overflowPkt!.deltaTicks).toBe(39380);
    expect(overflowPkt!.absoluteTicks).toBe('60210');

    const lastTwo = contRes.packets.slice(-2);
    expect(lastTwo[0].decoded).toEqual({ kind: 'mark-start', markerId: 42 });
    expect(lastTwo[0].segmentId).toBe(2);
    expect(lastTwo[0].absoluteTicks).toBe('60210');
    expect(lastTwo[1].decoded).toEqual({ kind: 'trace-stop' });
    expect(lastTwo[1].absoluteTicks).toBe('60220');

    const ssOv = loadSample('single-shot-overflow');
    const ssRes = decodeSystemViewStream(ssOv.bytes, { timestampBits: ssOv.meta.timestampBits });
    expect(ssOv.meta.integrity).toBe('target-overflow');
    expect(ssRes.segments).toHaveLength(1);
    expect(ssRes.packets[ssRes.packets.length - 1].eventId).toBe(SYSTEMVIEW_EVENT_IDS.MARK_START);
    expect(ssRes.packets.some((p) => p.eventId === SYSTEMVIEW_EVENT_IDS.TRACE_STOP)).toBe(false);
    expect(ssRes.summary.truncated).toBe(false);
  });

  it('正确解码 post-mortem 样本：丢弃被覆盖前缀，在首个 sync 建立可信段，周期 sync 连续', () => {
    const { bytes, meta } = loadSample('post-mortem');
    const res = decodeSystemViewStream(bytes, { timestampBits: meta.timestampBits });

    expect(meta.integrity).toBe('prefix-overwritten');
    expect(res.diagnostics).toEqual([]);
    expect(res.gaps).toHaveLength(1);
    expect(res.gaps[0]).toMatchObject({
      kind: 'prefix-overwritten',
      byteOffset: 0,
      droppedBytes: 43,
      discardedUnsyncedBytes: 43,
      droppedPackets: 'unknown',
    });
    expect(res.summary.discardedUnsyncedBytes).toBe(43);

    expect(res.segments).toHaveLength(1);
    expect(res.segments[0]).toMatchObject({
      segmentId: 1,
      startByteOffset: 43,
      endByteOffset: 8191,
      reliability: 'trusted',
      syncProof: 'trace-start-init',
      syncCount: 50,
      timeAnchorStatus: 'anchored-cycles',
    });
    expect(res.syncs).toHaveLength(50);
    expect(res.syncs[0].byteOffset).toBe(43);
    expect(res.syncs[1].byteOffset).toBe(208);
    expect(res.syncs[49].byteOffset).toBe(8128);
    expect(res.packets[2].decoded).toEqual({ kind: 'systime-cycles', cycles: 43960 });
    expect(res.packets[res.packets.length - 1].decoded).toEqual({ kind: 'trace-stop' });
  });

  it('逐字节、所有 2 分片边界以及粘包输入均与整块输入结果完全一致', () => {
    const { bytes: contBytes } = loadSample('continuous');
    const baseline = decodeSystemViewStream(contBytes);

    // 逐字节输入
    const byteByByteChunks = Array.from(contBytes, (b) => new Uint8Array([b]));
    const byteRes = decodeSystemViewStream(byteByByteChunks);
    expect(simplifyPackets(byteRes.packets)).toEqual(simplifyPackets(baseline.packets));
    expect(byteRes.segments).toEqual(baseline.segments);
    expect(byteRes.gaps).toEqual(baseline.gaps);

    // 枚举所有 0..N 切两片边界
    for (let split = 0; split <= contBytes.length; split++) {
      const splitRes = decodeSystemViewStream([contBytes.subarray(0, split), contBytes.subarray(split)]);
      expect(simplifyPackets(splitRes.packets)).toEqual(simplifyPackets(baseline.packets));
      expect(splitRes.segments).toEqual(baseline.segments);
    }

    // post-mortem 逐字节与关键前导/sync 边界切两片
    const { bytes: pmBytes } = loadSample('post-mortem');
    const pmBaseline = decodeSystemViewStream(pmBytes);
    const pmByteRes = decodeSystemViewStream(Array.from(pmBytes, (b) => new Uint8Array([b])));
    expect(pmByteRes.segments).toEqual(pmBaseline.segments);
    expect(pmByteRes.gaps).toEqual(pmBaseline.gaps);
    expect(pmByteRes.packets.length).toBe(pmBaseline.packets.length);

    for (let split = 0; split <= 90; split++) {
      const pmSplit = decodeSystemViewStream([pmBytes.subarray(0, split), pmBytes.subarray(split)]);
      expect(pmSplit.segments).toEqual(pmBaseline.segments);
      expect(pmSplit.gaps).toEqual(pmBaseline.gaps);
      expect(pmSplit.packets.length).toBe(pmBaseline.packets.length);
    }

    // 多包粘包 + 显式长度 + 5 字节 U32 + 字符串所有边界切两片
    const stickyStream = new Uint8Array([
      ...makeStandardHeader({ cycles: 1000 }),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.TASK_INFO, [...encodeVarintU32(0x10), ...encodeVarintU32(5), ...encodeStr('WorkerA')], 7),
      ...makeExplicitPacket(SYSTEMVIEW_EVENT_IDS.PRINT_FORMATTED, [...encodeStr('val=%u'), ...encodeVarintU32(0), ...encodeVarintU32(1), ...encodeVarintU32(0xffffffff)], 13),
      ...makeExplicitPacket(1024, [0xaa, 0xbb, 0xcc], 0x80000000),
    ]);
    const stickyBase = decodeSystemViewStream(stickyStream);
    expect(stickyBase.diagnostics).toEqual([]);
    for (let split = 0; split <= stickyStream.length; split++) {
      const r = decodeSystemViewStream([stickyStream.subarray(0, split), stickyStream.subarray(split)]);
      expect(simplifyPackets(r.packets)).toEqual(simplifyPackets(stickyBase.packets));
    }
  });

  it('覆盖 5 字节 U32 边界与超长 varint / 非法第 5 字节拒收', () => {
    const validStream = new Uint8Array([
      ...makeStandardHeader({ ramBase: 0x80000000, idShift: 0, cycles: 0xffffffff }),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.MARK_START, encodeVarintU32(0x7fffffff), 0x80000000),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.MARK_STOP, encodeVarintU32(0xffffffff), 0xffffffff),
    ]);
    const valid = decodeSystemViewStream(validStream);
    expect(valid.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(valid.packets[2].decoded).toEqual({ kind: 'systime-cycles', cycles: 0xffffffff });
    expect(valid.packets[3].decoded).toEqual({ kind: 'mark-start', markerId: 0x7fffffff });
    expect(valid.packets[3].deltaTicks).toBe(0x80000000);
    expect(valid.packets[4].decoded).toEqual({ kind: 'mark-stop', markerId: 0xffffffff });
    expect(valid.packets[4].deltaTicks).toBe(0xffffffff);

    // 超长 varint（第 5 字节 MSB=1）与非法第 5 字节（>0x0f）
    const badVarintCases: Array<{ name: string; badTail: number[]; expectedCode: string }> = [
      {
        name: 'overlong-event-id',
        badTail: [0x80, 0x80, 0x80, 0x80, 0x80, 0x01],
        expectedCode: 'overlong-varint',
      },
      {
        name: 'overflow-event-id-5th-byte',
        badTail: [0x80, 0x80, 0x80, 0x80, 0x10],
        expectedCode: 'varint-overflow',
      },
      {
        name: 'overlong-payload-u32',
        badTail: [SYSTEMVIEW_EVENT_IDS.MARK_START, 0xff, 0xff, 0xff, 0xff, 0x8f, 0x00],
        expectedCode: 'overlong-varint',
      },
      {
        name: 'overflow-payload-u32-5th-byte',
        badTail: [SYSTEMVIEW_EVENT_IDS.MARK_START, 0xff, 0xff, 0xff, 0xff, 0x10, 0x00],
        expectedCode: 'varint-overflow',
      },
      {
        name: 'overlong-delta',
        badTail: [SYSTEMVIEW_EVENT_IDS.ISR_EXIT, 0x81, 0x80, 0x80, 0x80, 0x80, 0x00],
        expectedCode: 'overlong-varint',
      },
      {
        name: 'overflow-delta-5th-byte',
        badTail: [SYSTEMVIEW_EVENT_IDS.ISR_EXIT, 0xff, 0xff, 0xff, 0xff, 0x7f],
        expectedCode: 'varint-overflow',
      },
      {
        name: 'overlong-explicit-len',
        badTail: [SYSTEMVIEW_EVENT_IDS.PRINT_FORMATTED, 0x80, 0x80, 0x80, 0x80, 0x80, 0x00],
        expectedCode: 'overlong-varint',
      },
    ];

    for (const tc of badVarintCases) {
      const stream = new Uint8Array([
        ...makeStandardHeader(),
        ...tc.badTail,
        // 未经重同步的后续包绝不能被继续当成同一可信段
        ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.MARK_START, [7], 10),
      ]);
      const res = decodeSystemViewStream(stream);
      expect(res.diagnostics.some((d) => d.code === tc.expectedCode), tc.name).toBe(true);
      expect(res.gaps.some((g) => g.kind === 'decode-sync-loss'), tc.name).toBe(true);
      expect(res.packets.some((p) => p.decoded.kind === 'mark-start' && p.decoded.markerId === 7), tc.name).toBe(false);
    }
  });

  it('检测已知显式包 payload 错长并切断可信段', () => {
    const mismatchCases = [
      // INIT 只有 2 字节（缺字段）
      makeExplicitPacket(SYSTEMVIEW_EVENT_IDS.INIT, [0x01, 0x02], 5),
      // TASK_TERMINATE 为空 payload
      makeExplicitPacket(SYSTEMVIEW_EVENT_IDS.TASK_TERMINATE, [], 5),
      // TASK_TERMINATE 多出 1 字节
      makeExplicitPacket(SYSTEMVIEW_EVENT_IDS.TASK_TERMINATE, [0x40, 0x01], 5),
      // NUMMODULES 有 2 个 U32
      makeExplicitPacket(SYSTEMVIEW_EVENT_IDS.NUMMODULES, [0x01, 0x02], 5),
      // END_CALL 为空
      makeExplicitPacket(SYSTEMVIEW_EVENT_IDS.END_CALL, [], 5),
      // END_CALL 有 3 个 U32
      makeExplicitPacket(SYSTEMVIEW_EVENT_IDS.END_CALL, [0x22, 0x01, 0x02], 5),
      // NAME_RESOURCE 字符串声明长度大于剩余字节
      makeExplicitPacket(SYSTEMVIEW_EVENT_IDS.NAME_RESOURCE, [0x40, 10, 0x41, 0x42], 5),
      // EX_MARK 为空 payload
      makeExplicitPacket(SYSTEMVIEW_EVENT_IDS.EX, [SYSTEMVIEW_EX_IDS.MARK], 5),
    ];

    for (const badPkt of mismatchCases) {
      const stream = new Uint8Array([
        ...makeStandardHeader(),
        ...badPkt,
        ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.MARK_START, [55], 10),
      ]);
      const res = decodeSystemViewStream(stream);
      expect(res.diagnostics.some((d) => d.severity === 'error')).toBe(true);
      expect(res.gaps.some((g) => g.kind === 'decode-schema-error')).toBe(true);
      // 错包本身不得作为合法事件产出
      expect(res.packets.filter((p) => p.segmentReliability === 'trusted' && p.decoded.kind === 'mark-start')).toHaveLength(0);
      // 后续包处于 uncertain 段直到重新同步
      const mark = res.packets.find((p) => p.decoded.kind === 'mark-start');
      expect(mark?.segmentReliability).toBe('uncertain');
    }
  });

  it('支持有长度未知事件（保留原始字节并保持可信段连续）与无长度未知短事件（立即切断可信段）', () => {
    const unknownBytes = [0xde, 0xad, 0xbe, 0xef, 0x00, 0x00];
    const exUnknownBytes = [0x11, 0x22, 0x33];
    const explicitUnknownStream = new Uint8Array([
      ...makeStandardHeader({ cycles: 500 }),
      ...makeExplicitPacket(30, unknownBytes, 10),
      ...makeExplicitPacket(SYSTEMVIEW_EVENT_IDS.EX, [99, ...exUnknownBytes], 15),
      ...makeExplicitPacket(1050, [0x41, 0x42], 20),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.MARK_START, [88], 5),
    ]);
    const okRes = decodeSystemViewStream(explicitUnknownStream);
    expect(okRes.diagnostics).toEqual([]);
    expect(okRes.gaps).toEqual([]);
    expect(okRes.segments).toHaveLength(1);
    expect(okRes.segments[0].reliability).toBe('trusted');

    const pkt30 = okRes.packets[3];
    expect(pkt30.eventId).toBe(30);
    expect(pkt30.category).toBe('unknown-explicit');
    expect(pkt30.schemaReliability).toBe('unknown-explicit');
    expect(pkt30.decoded).toEqual({ kind: 'unknown-explicit', rawPayload: new Uint8Array(unknownBytes) });
    expect(pkt30.absoluteTicks).toBe('510');

    const pktEx99 = okRes.packets[4];
    expect(pktEx99.decoded).toEqual({ kind: 'ex-unknown', exId: 99, rawPayload: new Uint8Array(exUnknownBytes) });
    expect(pktEx99.absoluteTicks).toBe('525');

    const pktUser = okRes.packets[5];
    expect(pktUser.category).toBe('user');
    expect(pktUser.decoded).toEqual({ kind: 'user-event', rawPayload: new Uint8Array([0x41, 0x42]) });
    expect(pktUser.absoluteTicks).toBe('545');

    expect(okRes.packets[6].decoded).toEqual({ kind: 'mark-start', markerId: 88 });
    expect(okRes.packets[6].absoluteTicks).toBe('550');

    // 无长度未知短事件：使用精简短 schema 集（不含 ID 23）以及非 sync 的 0x00
    const shortIdsWithout23 = new Set(Array.from({ length: 22 }, (_, i) => i + 1));
    const unknownShortStream = new Uint8Array([
      ...makeStandardHeader({ cycles: 100 }),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.MARK_START, [1], 10),
      23, 0x01, 0x02, 0x05, // 未知短事件，无长度字段
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.MARK_STOP, [1], 10), // 绝不能越过未知短事件继续产包
      ...makeStandardHeader({ cycles: 900 }),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.MARK_START, [2], 10),
    ]);
    const badShortRes = decodeSystemViewStream(unknownShortStream, { knownShortEventIds: shortIdsWithout23 });
    expect(badShortRes.diagnostics.some((d) => d.code === 'unknown-short-event')).toBe(true);
    expect(badShortRes.gaps.some((g) => g.kind === 'decode-sync-loss')).toBe(true);
    expect(badShortRes.packets.some((p) => p.decoded.kind === 'mark-stop')).toBe(false);
    // 重同步后恢复新可信段
    const mark2 = badShortRes.packets.find((p) => p.decoded.kind === 'mark-start' && p.decoded.markerId === 2);
    expect(mark2).toBeDefined();
    expect(mark2!.segmentId).toBe(2);
    expect(mark2!.segmentReliability).toBe('trusted');
    expect(mark2!.absoluteTicks).toBe('910');
  });

  it('不把普通 payload 内的 10+ 零字节误判为 sync，并拒绝失步区假 sync 后成功重同步', () => {
    const sixteenZeros = new Array(16).fill(0);
    const payloadZeroStream = new Uint8Array([
      ...makeStandardHeader({ cycles: 100 }),
      // SYSDESC / PRINT_FORMATTED / 未知显式事件内部均包含 16 个连续 0x00
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.SYSDESC, encodeStr('A\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0B'), 5),
      ...makeExplicitPacket(1025, sixteenZeros, 5),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.MARK_START, [12], 10),
    ]);
    const noFalseSync = decodeSystemViewStream(payloadZeroStream);
    expect(noFalseSync.syncs).toHaveLength(1);
    expect(noFalseSync.segments).toHaveLength(1);
    expect(noFalseSync.gaps).toEqual([]);
    expect(noFalseSync.packets[4].decoded).toEqual({ kind: 'user-event', rawPayload: new Uint8Array(sixteenZeros) });
    expect(noFalseSync.packets[5].decoded).toEqual({ kind: 'mark-start', markerId: 12 });
    expect(noFalseSync.packets[5].absoluteTicks).toBe('120');

    // 失步区包含假 sync：
    // 1) 10*0x00 后跟非法超长 varint
    // 2) 10*0x00 后跟看似合法单包 03 00 再跟错误同步 00*9 0x0a
    // 3) 额外多出 2 个前导 0x00（12*0x00）后接真 TRACE_START + INIT + SYSTIME_CYCLES
    const falseSyncRecoveryStream = new Uint8Array([
      0xaa, 0xbb,
      ...makeSync(), 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
      ...makeSync(), 0x03, 0x00, ...new Array(9).fill(0), 0x0a,
      0x00, 0x00,
      ...makeStandardHeader({ cycles: 2000 }),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.MARK_START, [77], 15),
    ]);
    const recRes = decodeSystemViewStream(falseSyncRecoveryStream);
    expect(recRes.segments).toHaveLength(1);
    expect(recRes.segments[0].syncProof).toBe('trace-start-init');
    expect(recRes.gaps).toHaveLength(1);
    expect(recRes.gaps[0].kind).toBe('prefix-overwritten');
    expect(recRes.summary.discardedUnsyncedBytes).toBe(recRes.segments[0].startByteOffset);
    expect(recRes.packets[recRes.packets.length - 1].decoded).toEqual({ kind: 'mark-start', markerId: 77 });
    expect(recRes.packets[recRes.packets.length - 1].absoluteTicks).toBe('2015');
  });

  it('处理截断、连续溢出与显式传输缺口，并保持无起点的相对 tick 不制造绝对时间', () => {
    // 1) 截断：在包中途结束
    const truncatedStream = new Uint8Array([
      ...makeStandardHeader({ cycles: 100 }),
      SYSTEMVIEW_EVENT_IDS.TASK_INFO, 0x40, 0x02, 0x05, 0x41, 0x42, // 声明长度 5 只写了 2 字节
    ]);
    const truncRes = decodeSystemViewStream(truncatedStream);
    expect(truncRes.summary.truncated).toBe(true);
    expect(truncRes.diagnostics.some((d) => d.code === 'truncated-packet')).toBe(true);
    expect(truncRes.gaps.some((g) => g.kind === 'truncated')).toBe(true);
    expect(truncRes.segments[0].endReason).toBe('truncated');

    // 2) 连续溢出（含累计 DropCount 递增 + 异常回退）
    const consecOvStream = new Uint8Array([
      ...makeStandardHeader({ cycles: 100 }),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.OVERFLOW, encodeVarintU32(10), 20),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.MARK_START, [1], 5),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.OVERFLOW, encodeVarintU32(25), 30),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.OVERFLOW, encodeVarintU32(4), 10),
    ]);
    const ovRes = decodeSystemViewStream(consecOvStream);
    const ovPackets = ovRes.packets.filter((p) => p.decoded.kind === 'overflow');
    expect(ovPackets).toHaveLength(3);
    expect(ovPackets[0].decoded).toEqual({
      kind: 'overflow',
      rawDropCount: 10,
      incrementalRawDropDelta: 10,
      minDroppedPackets: 11,
    });
    expect(ovPackets[1].decoded).toEqual({
      kind: 'overflow',
      rawDropCount: 25,
      incrementalRawDropDelta: 15,
      minDroppedPackets: 16,
    });
    expect(ovPackets[2].decoded).toEqual({
      kind: 'overflow',
      rawDropCount: 4,
      incrementalRawDropDelta: undefined,
      minDroppedPackets: undefined,
      dropCountAnomaly: true,
    });
    expect(ovRes.gaps.filter((g) => g.kind === 'target-overflow')).toHaveLength(3);
    expect(ovRes.gaps.filter((g) => g.kind === 'target-overflow').every((g) => g.droppedPackets === 'unknown')).toBe(true);

    // 3) 无 SYSTIME 起点 + 无 INIT 频率：绝不制造绝对时间或微秒
    const noAnchorDecoder = new SystemViewStreamDecoder();
    const b1 = noAnchorDecoder.push(
      new Uint8Array([
        ...makeSync(),
        ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.TRACE_START, [], 0),
        ...makeExplicitPacket(SYSTEMVIEW_EVENT_IDS.INIT, makeInitPayload(1_000_000, 64_000_000, 0x20000000, 2), 0),
        ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.MARK_START, [9], 25),
        ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.MARK_STOP, [9], 15),
      ]),
    );
    const b2 = noAnchorDecoder.markGap({ kind: 'host-drop', droppedPackets: 3, droppedBytes: 40 });
    const b3 = noAnchorDecoder.push(
      new Uint8Array([
        ...makeSync(),
        ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.TRACE_START, [], 0),
        ...makeExplicitPacket(SYSTEMVIEW_EVENT_IDS.INIT, makeInitPayload(0, 64_000_000, 0x20000000, 2), 0),
        ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.SYSTIME_CYCLES, encodeVarintU32(500), 0),
        ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.MARK_START, [10], 20),
      ]),
    );
    const b4 = noAnchorDecoder.finish();

    const seg1Packets = [...b1.packets, ...b2.packets];
    expect(seg1Packets.every((p) => p.absoluteTicks === undefined && p.timestampUs === undefined)).toBe(true);
    expect(seg1Packets.map((p) => p.segmentRelativeTicks)).toEqual(['0', '0', '25', '40']);
    expect(b2.gaps[0]).toMatchObject({ kind: 'host-drop', droppedPackets: 3, droppedBytes: 40 });

    const seg2Packets = [...b3.packets, ...b4.packets];
    expect(seg2Packets[2].absoluteTicks).toBe('500');
    expect(seg2Packets[3].absoluteTicks).toBe('520');
    // INIT sysFreqHz=0 时，依然不能猜微秒/纳秒
    expect(seg2Packets[3].timestampUs).toBeUndefined();
    expect(seg2Packets[3].timestampNs).toBeUndefined();

    // 对齐流但缺少 INIT 时同样保持无微秒/纳秒
    const noInitRes = decodeSystemViewStream(
      new Uint8Array([
        ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.SYSTIME_CYCLES, encodeVarintU32(500), 0),
        ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.MARK_START, [10], 20),
      ]),
      { initialSyncMode: 'synced' },
    );
    expect(noInitRes.packets[1].absoluteTicks).toBe('520');
    expect(noInitRes.packets[1].timestampUs).toBeUndefined();
    expect(noInitRes.packets[1].timestampNs).toBeUndefined();
  });

  it('处理 32-bit 与 16-bit timestamp wrap 并检测超出 bit 宽度的 delta', () => {
    // 32-bit wrap
    const wrap32 = decodeSystemViewStream(
      new Uint8Array([
        ...makeStandardHeader({ cycles: 0xfffffff0 }),
        ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.MARK_START, [1], 0x20),
        ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.SYSTIME_CYCLES, encodeVarintU32(0x10), 0),
        ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.MARK_STOP, [1], 5),
      ]),
      { timestampBits: 32 },
    );
    expect(wrap32.diagnostics.filter((d) => d.code !== 'timestamp-wrap')).toEqual([]);
    expect(wrap32.packets[3].timestampWrapped).toBe(true);
    expect(wrap32.packets[3].absoluteTicks).toBe('4294967312'); // 0x100000010
    expect(wrap32.packets[3].rawTimestampMod).toBe(0x10);
    expect(wrap32.packets[5].absoluteTicks).toBe('4294967317');
    expect(wrap32.segments[0].timestampWrapCount).toBe(1);

    // 16-bit wrap
    const wrap16 = decodeSystemViewStream(
      new Uint8Array([
        ...makeStandardHeader({ cycles: 0xfff0 }),
        ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.MARK_START, [2], 0x20),
        ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.SYSTIME_CYCLES, encodeVarintU32(0x10), 0),
      ]),
      { timestampBits: 16 },
    );
    expect(wrap16.packets[3].timestampWrapped).toBe(true);
    expect(wrap16.packets[3].absoluteTicks).toBe('65552'); // 0x10010
    expect(wrap16.packets[3].rawTimestampMod).toBe(0x10);
    expect(wrap16.diagnostics.some((d) => d.code === 'time-anchor-conflict')).toBe(false);

    // delta >= 2^16 越界不确定性
    const bad16 = decodeSystemViewStream(
      new Uint8Array([
        ...makeStandardHeader({ cycles: 0x10 }),
        ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.MARK_START, [3], 0x10005),
      ]),
      { timestampBits: 16 },
    );
    expect(bad16.diagnostics.some((d) => d.code === 'timestamp-delta-exceeds-bits')).toBe(true);
    expect(bad16.packets[3].timeAnchorStatus).toBe('uncertain');
    expect(bad16.packets[3].absoluteTicks).toBeUndefined();
  });

  it('检测 INIT / expectedMetadata / SYSDESC / SYSTIME_CYCLES 元数据冲突', () => {
    const conflictStream = new Uint8Array([
      ...makeStandardHeader({ sysFreq: 1_000_000, cpuFreq: 64_000_000, ramBase: 0x20000000, idShift: 2, cycles: 100 }),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.SYSDESC, encodeStr('N=App,O=FreeRTOS,I#15=SysTick'), 0),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.SYSDESC, encodeStr('O=ThreadX,I#15=TIM2'), 0),
      // 同一时间段内的周期性 SYSTIME_CYCLES 与累计 delta 冲突
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.SYSTIME_CYCLES, encodeVarintU32(9999), 10),
      // 后续 INIT 修改频率与 RAMBase -> 切段并报告冲突
      ...makeSync(),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.TRACE_START, [], 0),
      ...makeExplicitPacket(SYSTEMVIEW_EVENT_IDS.INIT, makeInitPayload(2_000_000, 128_000_000, 0x24000000, 3), 0),
    ]);

    const res = decodeSystemViewStream(conflictStream, {
      expectedMetadata: { sysFreqHz: 4_000_000, ramBaseAddress: 0x20000000, idShift: 2 },
    });

    const codes = res.diagnostics.map((d) => d.code);
    expect(codes.filter((c) => c === 'metadata-conflict').length).toBeGreaterThanOrEqual(4);
    expect(codes).toContain('time-anchor-conflict');
    expect(res.segments).toHaveLength(2);
    expect(res.segments[0].endReason).toBe('metadata-reconfigured');
    expect(res.segments[1].metadata).toEqual({
      sysFreqHz: 2_000_000,
      cpuFreqHz: 128_000_000,
      ramBaseAddress: 0x24000000,
      idShift: 3,
    });
  });

  it('解释 FreeRTOS SYSDESC、API 事件、PRINT_FORMATTED、END_CALL、STACK_INFO、HEAP 与 DATA_SAMPLE', () => {
    const floatBits = Buffer.allocUnsafe(4);
    floatBits.writeFloatLE(3.5, 0);
    const fU32 = floatBits.readUInt32LE(0);

    const stream = new Uint8Array([
      ...makeStandardHeader({ sysFreq: 1_000_000, ramBase: 0x20000000, idShift: 2, cycles: 1000 }),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.SYSDESC, encodeStr('N=OrbitFixture,D=STM32H723,O=FreeRTOS,C=Cortex-M7,I#15=SysTick'), 0),
      ...makeShortPacket(
        SYSTEMVIEW_EVENT_IDS.TASK_INFO,
        [...encodeVarintU32(0x100 >> 2), ...encodeVarintU32(4), ...encodeStr('worker01')],
        10,
      ),
      ...makeShortPacket(
        SYSTEMVIEW_EVENT_IDS.STACK_INFO,
        [...encodeVarintU32(0x100 >> 2), ...encodeVarintU32(0x20001000), ...encodeVarintU32(512), ...encodeVarintU32(128)],
        5,
      ),
      ...makeExplicitPacket(
        SYSTEMVIEW_EVENT_IDS.NAME_RESOURCE,
        [...encodeVarintU32(0x400 >> 2), ...encodeStr('busLock')],
        5,
      ),
      ...makeExplicitPacket(
        SYSTEMVIEW_EVENT_IDS.PRINT_FORMATTED,
        [...encodeStr('tick=%u'), ...encodeVarintU32(1 | (1 << 6)), ...encodeVarintU32(1), ...encodeVarintU32(42)],
        5,
      ),
      ...makeExplicitPacket(
        SYSTEMVIEW_FREERTOS_API_OFFSET + 3, // vTaskDelay(ticksToDelay=50)
        encodeVarintU32(50),
        5,
      ),
      ...makeExplicitPacket(
        SYSTEMVIEW_FREERTOS_API_OFFSET + 2, // vTaskDelete(ShrinkId(0x20000100))
        encodeVarintU32(0x100 >> 2),
        5,
      ),
      ...makeExplicitPacket(
        SYSTEMVIEW_EVENT_IDS.END_CALL,
        [...encodeVarintU32(SYSTEMVIEW_FREERTOS_API_OFFSET + 58), ...encodeVarintU32(1)],
        5,
      ),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.DATA_SAMPLE, [...encodeVarintU32(7), ...encodeVarintU32(fU32)], 5),
      ...makeExplicitPacket(
        SYSTEMVIEW_EVENT_IDS.EX,
        [
          SYSTEMVIEW_EX_IDS.HEAP_ALLOC_EX,
          ...encodeVarintU32(0x800 >> 2),
          ...encodeVarintU32(0x1000 >> 2),
          ...encodeVarintU32(64 >> 2),
          ...encodeVarintU32(0xabcd),
        ],
        5,
      ),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.SYSTIME_US, [...encodeVarintU32(0x12345678), ...encodeVarintU32(0x00000001)], 5),
    ]);

    const res = decodeSystemViewStream(stream);
    expect(res.diagnostics).toEqual([]);
    expect(res.packets[3].decoded).toMatchObject({
      kind: 'sysdesc',
      parsed: {
        appName: 'OrbitFixture',
        deviceName: 'STM32H723',
        osName: 'FreeRTOS',
        coreName: 'Cortex-M7',
        interrupts: { 15: 'SysTick' },
      },
    });
    expect(res.packets[4].decoded).toEqual({
      kind: 'task-info',
      shrunkTaskId: 0x40,
      taskId: 0x20000100,
      idResolution: 'resolved',
      priority: 4,
      name: 'worker01',
    });
    expect(res.packets[5].decoded).toEqual({
      kind: 'stack-info',
      shrunkTaskId: 0x40,
      taskId: 0x20000100,
      idResolution: 'resolved',
      stackBase: 0x20001000,
      stackSize: 512,
      stackUsage: 128,
    });
    expect(res.packets[6].decoded).toEqual({
      kind: 'name-resource',
      shrunkResourceId: 0x100,
      resourceId: 0x20000400,
      idResolution: 'resolved',
      name: 'busLock',
    });
    expect(res.packets[7].decoded).toEqual({
      kind: 'print-formatted',
      text: 'tick=%u',
      options: 65,
      logLevel: 1,
      append: true,
      numArgs: 1,
      args: [42],
    });
    expect(res.packets[8].decoded).toMatchObject({
      kind: 'os-freertos',
      apiId: 3,
      apiName: FREERTOS_API_NAMES[3],
      interpretation: 'matched',
      params: [{ name: 'ticksToDelay', rawValue: 50, kind: 'u32' }],
    });
    expect(res.packets[9].decoded).toMatchObject({
      kind: 'os-freertos',
      apiId: 2,
      apiName: FREERTOS_API_NAMES[2],
      interpretation: 'matched',
      params: [{ name: 'taskId', rawValue: 0x40, kind: 'shrunk-id', resolvedId: 0x20000100, idResolution: 'resolved' }],
    });
    expect(res.packets[10].decoded).toEqual({
      kind: 'end-call',
      apiEventId: 90,
      apiId: 58,
      apiName: 'xQueueGenericSend',
      hasReturnValue: true,
      returnValue: 1,
    });
    expect(res.packets[11].decoded).toEqual({
      kind: 'data-sample',
      dataId: 7,
      rawValueBits: fU32,
      floatValue: 3.5,
    });
    expect(res.packets[12].decoded).toEqual({
      kind: 'ex-heap-alloc-ex',
      shrunkHeapId: 0x200,
      heapId: 0x20000800,
      heapIdResolution: 'resolved',
      shrunkUserDataId: 0x400,
      userDataAddress: 0x20001000,
      userDataIdResolution: 'resolved',
      userDataLenShifted: 16,
      userDataLenBytes: 64,
      tag: 0xabcd,
    });
    expect(res.packets[13].decoded).toEqual({
      kind: 'systime-us',
      systimeLow: 0x12345678,
      systimeHigh: 0x00000001,
      systimeUs: ((1n << 32n) | 0x12345678n).toString(),
    });
  });

  it('在持久半包、恶意长度、超大 chunk 与海量事件下保持确定上限与 O(1) 缓冲', () => {
    // 1) 恶意显式长度在首包头即被拦截，无需等待完整 payload
    const evilLenStream = new Uint8Array([
      ...makeStandardHeader(),
      ...encodeVarintU32(1024),
      ...encodeVarintU32(50000), // > maxPayloadBytes(4096)
      0xaa, 0xbb,
    ]);
    const evilRes = decodeSystemViewStream(evilLenStream, { maxPayloadBytes: 4096 });
    expect(evilRes.diagnostics.some((d) => d.code === 'payload-length-exceeded')).toBe(true);
    expect(evilRes.summary.maxPendingBytesObserved).toBeLessThan(256);

    // 2) 恶意短字符串 3 字节大端长度（0xff 0xff 0xff = 65535）在长度头立即拦截
    const evilStrStream = new Uint8Array([
      ...makeStandardHeader(),
      SYSTEMVIEW_EVENT_IDS.SYSDESC, 0xff, 0xff, 0xff,
      0x41, 0x42,
    ]);
    const evilStrRes = decodeSystemViewStream(evilStrStream, { maxStringBytes: 512 });
    expect(evilStrRes.diagnostics.some((d) => d.code === 'string-length-exceeded')).toBe(true);
    expect(evilStrRes.summary.maxPendingBytesObserved).toBeLessThan(256);

    // 3) 拒绝超出 maxChunkBytes 的单次来包
    const boundDecoder = new SystemViewStreamDecoder({ maxChunkBytes: 16 });
    expect(() => boundDecoder.push(new Uint8Array(17))).toThrow(/maxChunkBytes/);

    // 4) 持久半包不会泄漏无界状态，finish 时准确报告 truncated
    const partialDecoder = new SystemViewStreamDecoder({ maxPayloadBytes: 1024 });
    partialDecoder.push(new Uint8Array(makeStandardHeader()));
    partialDecoder.push(new Uint8Array([1024 & 0x7f | 0x80, 1024 >> 7, 0x40])); // 显式长 64B，仅先到 0B
    for (let i = 0; i < 20; i++) {
      const b = partialDecoder.push(new Uint8Array([i]));
      expect(b.packets).toEqual([]);
    }
    const endBatch = partialDecoder.finish();
    expect(endBatch.gaps.some((g) => g.kind === 'truncated')).toBe(true);
    expect(partialDecoder.getState().maxPendingBytesObserved).toBeLessThanOrEqual(64);

    // 5) 50,000 个事件流式解码保持常数级 maxPendingBytesObserved
    const decoder = new SystemViewStreamDecoder();
    decoder.push(new Uint8Array(makeStandardHeader({ cycles: 0 })));
    const singlePkt = new Uint8Array(makeShortPacket(SYSTEMVIEW_EVENT_IDS.MARK_START, [1], 10));
    const batchChunk = new Uint8Array(singlePkt.length * 1000);
    for (let i = 0; i < 1000; i++) {
      batchChunk.set(singlePkt, i * singlePkt.length);
    }
    let decodedCount = 0;
    for (let round = 0; round < 50; round++) {
      const out = decoder.push(batchChunk);
      decodedCount += out.packets.length;
    }
    decoder.finish();
    expect(decodedCount).toBe(50_000);
    expect(decoder.getState().maxPendingBytesObserved).toBeLessThan(64);
  });

  it('协议辅助函数：parseSystemDescription 与 expandShrunkId 溢出检查', () => {
    expect(expandShrunkId(0x40, 0x20000000, 2)).toEqual({ status: 'resolved', value: 0x20000100 });
    expect(expandShrunkId(0x40, undefined, 2)).toEqual({ status: 'unresolved-missing-init' });
    expect(expandShrunkId(0x40, 0x20000000, 32)).toEqual({ status: 'invalid-shift' });
    expect(expandShrunkId(0x40000000, 0x20000000, 2)).toEqual({ status: 'address-overflow' });

    const parsed = parseSystemDescription('N=Demo,D=H723,O=FreeRTOS,I#15=SysTick,baditem');
    expect(parsed.appName).toBe('Demo');
    expect(parsed.deviceName).toBe('H723');
    expect(parsed.osName).toBe('FreeRTOS');
    expect(parsed.interrupts).toEqual({ 15: 'SysTick' });
    expect(parsed.malformedItems).toEqual(['baditem']);
  });

  it('400,000 B 大块（200,000 包）通过 decodeSystemViewStream 不发生栈溢出', () => {
    const count = 200_000;
    const legal = new Uint8Array(count * 2);
    for (let i = 0; i < legal.length; i += 2) {
      legal[i] = SYSTEMVIEW_EVENT_IDS.IDLE;
      legal[i + 1] = 1;
    }
    const collected = decodeSystemViewStream(legal, { initialSyncMode: 'synced' });
    expect(collected.packets.length).toBe(count);
    expect(collected.packets[count - 1].segmentRelativeTicks).toBe(String(count));
    expect(collected.segments).toHaveLength(1);
  });

  it('markGap 后弱候选（10 零 + 1..2 个 Marker）不升级为 trusted，且十个零跨块与真 sync 恢复边界准确', () => {
    const { bytes: official } = loadSample('continuous');
    const zeroRun = new Uint8Array(10);

    // 1) 假候选后紧跟真官方 sync（含 10 零跨 push 块边界）
    const d1 = new SystemViewStreamDecoder();
    d1.push(official);
    d1.markGap({ kind: 'transport-gap', droppedBytes: 'unknown' });
    const unframedTwoMarkers = new Uint8Array([0xed, 0x11, ...zeroRun, 15, 65, 1, 16, 65, 1]);
    const b1 = d1.push(unframedTwoMarkers);
    // 十个零跨两块输入
    const b2 = d1.push(official.subarray(0, 4));
    const b3 = d1.push(official.subarray(4));
    const b4 = d1.finish();

    const allPackets = [...b1.packets, ...b2.packets, ...b3.packets, ...b4.packets];
    const allSyncs = [...b1.syncs, ...b2.syncs, ...b3.syncs, ...b4.syncs];
    const validRecoveryAt = official.length + unframedTwoMarkers.length;
    const beforeRealSync = allPackets.filter((p) => p.streamByteOffset < validRecoveryAt);
    expect(beforeRealSync.every((p) => p.segmentReliability !== 'trusted')).toBe(true);
    expect(allSyncs).toEqual([
      { byteOffset: validRecoveryAt, segmentId: 2, proof: 'trace-start-init', inSegment: false },
    ]);
    expect(allPackets.some((p) => p.segmentId === 2 && p.segmentReliability === 'trusted')).toBe(true);

    // 2) EOF 假候选不发布为 trusted，也不制造假 sync
    const d2 = new SystemViewStreamDecoder();
    d2.push(official);
    d2.markGap({ kind: 'transport-gap', droppedBytes: 'unknown' });
    const e1 = d2.push(new Uint8Array([0xed, 0x11, ...zeroRun, 15, 65, 1]));
    const e2 = d2.finish();
    expect([...e1.packets, ...e2.packets]).toEqual([]);
    expect([...e1.syncs, ...e2.syncs]).toEqual([]);
    expect(e2.gaps.some((g) => g.kind === 'transport-gap' && g.discardedUnsyncedBytes === 15)).toBe(true);

    // 2b) EOF 仅出现 sync + TRACE_START 缺少 INIT 的弱候选同样不升为 trusted
    const d2b = new SystemViewStreamDecoder();
    d2b.push(official);
    d2b.markGap({ kind: 'transport-gap', droppedBytes: 'unknown' });
    const e1b = d2b.push(new Uint8Array([0xed, 0x11, ...zeroRun, SYSTEMVIEW_EVENT_IDS.TRACE_START, 0]));
    const e2b = d2b.finish();
    expect([...e1b.packets, ...e2b.packets]).toEqual([]);
    expect([...e1b.syncs, ...e2b.syncs]).toEqual([]);
    expect([...e1b.diagnostics, ...e2b.diagnostics].some((d) => d.code === 'unconfirmed-sync-candidate')).toBe(true);

    // 3) uncertain 段内遇到假 10 零 + Marker 不得升为 trusted，真 sync+TRACE_START+INIT 才恢复 trusted
    const uncertainStream = new Uint8Array([
      ...makeStandardHeader({ cycles: 100 }),
      ...makeExplicitPacket(SYSTEMVIEW_EVENT_IDS.TASK_TERMINATE, [], 5), // 错长触发 uncertain
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.MARK_START, [1], 5),
      ...zeroRun,
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.MARK_STOP, [1], 5), // 弱候选
      ...makeStandardHeader({ cycles: 500 }),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.MARK_START, [2], 5),
    ]);
    const uRes = decodeSystemViewStream(uncertainStream);
    expect(uRes.packets.some((p) => p.decoded.kind === 'mark-stop' && p.segmentReliability === 'trusted')).toBe(false);
    const recoveredMark2 = uRes.packets.find((p) => p.decoded.kind === 'mark-start' && p.decoded.markerId === 2);
    expect(recoveredMark2?.segmentReliability).toBe('trusted');
    expect(recoveredMark2?.absoluteTicks).toBe('505');
  });

  it('正确解码合法 NOP (非零/零 delta)、逐字节分片与邻接真 sync，并区分 10 个零跟普通事件', () => {
    const nopStream = new Uint8Array([
      ...makeStandardHeader({ cycles: 100 }),
      0x00, 0x05, // NOP delta=5 -> 105
      0x00, 0x00, // NOP delta=0 -> 105
      0x00, 0x80, 0x01, // NOP delta=128 -> 233
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.MARK_START, [1], 7), // 240
      // 10 个 0 后跟 MARK_START（非 TRACE_START+INIT），应解码为 5 个 NOP(delta=0) 而非误判 sync
      ...new Array(10).fill(0),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.MARK_STOP, [1], 10), // 250
      // NOP(delta=0) 紧邻真 sync + TRACE_START + INIT + SYSTIME_CYCLES(250)
      0x00, 0x00,
      ...makeStandardHeader({ cycles: 250 }),
      ...makeShortPacket(SYSTEMVIEW_EVENT_IDS.MARK_START, [2], 12), // 262
    ]);

    const full = decodeSystemViewStream(nopStream);
    expect(full.diagnostics).toEqual([]);
    expect(full.gaps).toEqual([]);
    expect(full.segments).toHaveLength(1);
    expect(full.segments[0].syncCount).toBe(2);
    expect(full.syncs).toHaveLength(2);

    const nops = full.packets.filter((p) => p.eventId === SYSTEMVIEW_EVENT_IDS.NOP);
    expect(nops.map((n) => n.deltaTicks)).toEqual([5, 0, 128, 0, 0, 0, 0, 0, 0]);
    expect(full.packets.find((p) => p.decoded.kind === 'mark-start' && p.decoded.markerId === 1)?.absoluteTicks).toBe('240');
    expect(full.packets.find((p) => p.decoded.kind === 'mark-stop' && p.decoded.markerId === 1)?.absoluteTicks).toBe('250');
    expect(full.packets.find((p) => p.decoded.kind === 'mark-start' && p.decoded.markerId === 2)?.absoluteTicks).toBe('262');

    // 逐字节与全部 2 分片均一致
    const byteByByte = decodeSystemViewStream(Array.from(nopStream, (b) => new Uint8Array([b])));
    expect(simplifyPackets(byteByByte.packets)).toEqual(simplifyPackets(full.packets));
    expect(byteByByte.syncs).toEqual(full.syncs);

    for (let split = 0; split <= nopStream.length; split++) {
      const sp = decodeSystemViewStream([nopStream.subarray(0, split), nopStream.subarray(split)]);
      expect(simplifyPackets(sp.packets)).toEqual(simplifyPackets(full.packets));
      expect(sp.syncs).toEqual(full.syncs);
    }
  });

  it('SYSDESC 海量自定义键跨包冲突检测状态有界且保留标准键冲突检测', () => {
    const decoder = new SystemViewStreamDecoder({ initialSyncMode: 'synced' });
    decoder.push(new Uint8Array(makeShortPacket(SYSTEMVIEW_EVENT_IDS.SYSDESC, encodeStr('O=FreeRTOS'), 1)));

    for (let i = 0; i < 24_596; i++) {
      const text = `custom${i}=captured`;
      const pkt = new Uint8Array(makeShortPacket(SYSTEMVIEW_EVENT_IDS.SYSDESC, encodeStr(text), 1));
      const b = decoder.push(pkt);
      expect(b.packets).toHaveLength(1);
      expect((b.packets[0].decoded as any).parsed.entries[0]).toEqual({ key: `custom${i}`, value: 'captured' });
    }

    // 冲突标准键 O=ThreadX 仍能被检测到
    const conflictBatch = decoder.push(new Uint8Array(makeShortPacket(SYSTEMVIEW_EVENT_IDS.SYSDESC, encodeStr('O=ThreadX'), 1)));
    expect(conflictBatch.diagnostics.some((d) => d.code === 'metadata-conflict')).toBe(true);
    expect((decoder as any).activeSegment.sysDescKeys.size).toBeLessThanOrEqual(256);
    decoder.finish();
  });
});
