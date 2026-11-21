import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  calibrateClockSegment,
  deserializeTraceClockMap,
  hostNsToTimelineMs,
  mapHostNsToTraceSegments,
  mapSegmentTraceTickToHost,
  OnlineAffineAccumulator,
  serializeTraceClockMap,
  timelineMsToHostNs,
  unwrapCounterTick,
  type ClockCalibrationObservation,
  type TimelineClockSyncMeta,
  type TraceClockMap,
} from './clock-mapping';

const ORACLE_PATH = path.resolve(__dirname, '../../out/rtos-stage5/acceptance-5.4/codex-clock-oracle.json');

describe('clock-mapping', () => {
  it('verifies codex-clock-oracle.json with 32-bit wraps, +37/-17 ppm drift, multi-boot isolation, and invalidAnchor rejection', () => {
    const oracle = JSON.parse(fs.readFileSync(ORACLE_PATH, 'utf8'));

    // 1. Verify rawTick unwrapping on target (resets per boot) and probe (continuous across target reset, 32-bit wrap)
    let prevProbeRaw: bigint | null = null;
    let prevProbeUnwrapped = 0n;
    let probeWraps = 0;
    let prevProbeHostMid = 0n;
    let prevProbeHostWidth = 0;

    for (const win of oracle.windows as any[][]) {
      let prevTargetRaw = BigInt(win[0].target.rawTick);
      let prevTargetUnwrapped = BigInt(win[0].target.rawTick);
      let targetWraps = 0;

      const win0HostMid = (BigInt(win[0].hostWindow.lowerNs) + BigInt(win[0].hostWindow.upperNs)) / 2n;
      const win0HostWidth = Number(BigInt(win[0].hostWindow.upperNs) - BigInt(win[0].hostWindow.lowerNs));
      if (prevProbeRaw === null) {
        prevProbeRaw = BigInt(win[0].probe.rawTick);
        prevProbeUnwrapped = prevProbeRaw;
      } else {
        const pRaw0 = BigInt(win[0].probe.rawTick);
        const pRes0 = unwrapCounterTick({
          prevRawTick: prevProbeRaw,
          prevUnwrappedTick: prevProbeUnwrapped,
          prevWrapCount: probeWraps,
          nextRawTick: pRaw0,
          tickBits: oracle.probeClock.tickBits,
          direction: 'up',
          nominalHz: oracle.probeClock.nominalHz,
          expectedElapsedHostNs: win0HostMid - prevProbeHostMid,
          elapsedUncertaintyNs: win0HostWidth + prevProbeHostWidth,
        });
        expect(pRes0.ok).toBe(true);
        prevProbeRaw = pRaw0;
        prevProbeUnwrapped = pRes0.unwrappedTick!;
        probeWraps = pRes0.wrapCount!;
      }
      prevProbeHostMid = win0HostMid;
      prevProbeHostWidth = win0HostWidth;

      expect(prevTargetUnwrapped.toString()).toBe(win[0].target.unwrappedTick);
      expect(prevProbeUnwrapped.toString()).toBe(win[0].probe.unwrappedTick);

      for (let i = 1; i < win.length; i++) {
        const prevHostMid = (BigInt(win[i - 1].hostWindow.lowerNs) + BigInt(win[i - 1].hostWindow.upperNs)) / 2n;
        const nextHostMid = (BigInt(win[i].hostWindow.lowerNs) + BigInt(win[i].hostWindow.upperNs)) / 2n;
        const elapsedHostNs = nextHostMid - prevHostMid;
        const elapsedUnc =
          Number(BigInt(win[i].hostWindow.upperNs) - BigInt(win[i].hostWindow.lowerNs))
          + Number(BigInt(win[i - 1].hostWindow.upperNs) - BigInt(win[i - 1].hostWindow.lowerNs));

        const tRaw = BigInt(win[i].target.rawTick);
        const tRes = unwrapCounterTick({
          prevRawTick: prevTargetRaw,
          prevUnwrappedTick: prevTargetUnwrapped,
          prevWrapCount: targetWraps,
          nextRawTick: tRaw,
          tickBits: oracle.targetClock.tickBits,
          direction: 'up',
          nominalHz: oracle.targetClock.nominalHz,
          expectedElapsedHostNs: elapsedHostNs,
          elapsedUncertaintyNs: elapsedUnc,
        });
        expect(tRes.ok).toBe(true);
        expect(tRes.unwrappedTick!.toString()).toBe(win[i].target.unwrappedTick);
        prevTargetRaw = tRaw;
        prevTargetUnwrapped = tRes.unwrappedTick!;
        targetWraps = tRes.wrapCount!;

        const pRaw = BigInt(win[i].probe.rawTick);
        const pRes = unwrapCounterTick({
          prevRawTick: prevProbeRaw,
          prevUnwrappedTick: prevProbeUnwrapped,
          prevWrapCount: probeWraps,
          nextRawTick: pRaw,
          tickBits: oracle.probeClock.tickBits,
          direction: 'up',
          nominalHz: oracle.probeClock.nominalHz,
          expectedElapsedHostNs: elapsedHostNs,
          elapsedUncertaintyNs: elapsedUnc,
        });
        expect(pRes.ok).toBe(true);
        expect(pRes.unwrappedTick!.toString()).toBe(win[i].probe.unwrappedTick);
        prevProbeRaw = pRaw;
        prevProbeUnwrapped = pRes.unwrappedTick!;
        probeWraps = pRes.wrapCount!;
        prevProbeHostMid = nextHostMid;
        prevProbeHostWidth = Number(BigInt(win[i].hostWindow.upperNs) - BigInt(win[i].hostWindow.lowerNs));
      }
    }

    // 2. Calibrate Window 0 (boot 3, seg 11) & Window 1 (boot 4, seg 12) independently
    const buildSegment = (win: any[], targetWrapCount: number, probeWrapCount: number) => {
      const obs: ClockCalibrationObservation[] = win.map((pt, idx) => ({
        id: `w-${pt.bootGeneration}-${idx}`,
        source: 'shared-marker',
        targetTicks: BigInt(pt.target.unwrappedTick),
        probeTicks: BigInt(pt.probe.unwrappedTick),
        hostWindow: {
          lowerNs: BigInt(pt.hostWindow.lowerNs),
          upperNs: BigInt(pt.hostWindow.upperNs),
        },
      }));
      return calibrateClockSegment({
        recordId: 'codex-oracle',
        bootGeneration: win[0].bootGeneration,
        segmentId: win[0].segmentId,
        reliability: 'trusted',
        timeAnchorStatus: 'anchored-cycles',
        tickDomain: 'absolute-ticks',
        targetClock: {
          nominalHz: oracle.targetClock.nominalHz,
          direction: 'up',
          tickBits: oracle.targetClock.tickBits,
          wrapCount: targetWrapCount,
          startTicks: BigInt(win[0].target.unwrappedTick),
          endTicks: BigInt(win[win.length - 1].target.unwrappedTick),
        },
        probeClock: {
          available: true,
          source: 'probe-oracle',
          nominalHz: oracle.probeClock.nominalHz,
          direction: 'up',
          tickBits: oracle.probeClock.tickBits,
          wrapCount: probeWrapCount,
          startTicks: BigInt(win[0].probe.unwrappedTick),
          endTicks: BigInt(win[win.length - 1].probe.unwrappedTick),
        },
        hostOrigin: { originId: 'oracle-host', processKind: 'dap' },
        observations: obs,
        eventScaleNs: 1_000_000,
      });
    };

    const seg0 = buildSegment(oracle.windows[0], 1, 1);
    const seg1 = buildSegment(oracle.windows[1], 0, 0);

    expect(seg0.confidence).toBe('calibrated-high');
    expect(seg0.trustedForAutoPreciseSync).toBe(true);
    expect(seg0.targetFit?.driftPpm).toBeCloseTo(37, 0);
    expect(seg0.probeFit?.driftPpm).toBeCloseTo(-17, 0);

    expect(seg1.confidence).toBe('calibrated-high');
    expect(seg1.trustedForAutoPreciseSync).toBe(true);
    expect(seg1.targetFit?.driftPpm).toBeCloseTo(37, 0);
    expect(seg1.probeFit?.driftPpm).toBeCloseTo(-17, 0);

    // 3. Checkpoints fall strictly inside conservative uncertainty interval
    const cp0 = oracle.checkpoints[0];
    const m0 = mapSegmentTraceTickToHost(seg0, BigInt(cp0.unwrappedTargetTick));
    expect(m0.ok).toBe(true);
    expect(BigInt(cp0.expectedHostNs) >= m0.lowerHostNs!).toBe(true);
    expect(BigInt(cp0.expectedHostNs) <= m0.upperHostNs!).toBe(true);

    const cp1 = oracle.checkpoints[1];
    const m1 = mapSegmentTraceTickToHost(seg1, BigInt(cp1.unwrappedTargetTick));
    expect(m1.ok).toBe(true);
    expect(BigInt(cp1.expectedHostNs) >= m1.lowerHostNs!).toBe(true);
    expect(BigInt(cp1.expectedHostNs) <= m1.upperHostNs!).toBe(true);

    // 4. Cross-segment / cross-reset extrapolation & gap queries must be rejected
    const crossExtrapolate = mapSegmentTraceTickToHost(seg0, BigInt(cp1.unwrappedTargetTick));
    expect(crossExtrapolate.ok).toBe(false);
    expect(crossExtrapolate.errorCode).toBe('OutOfSegmentRange');

    const inGap = mapHostNsToTraceSegments([seg0, seg1], 14835000000000n);
    expect(inGap.ok).toBe(false);
    expect(inGap.errorCode).toBe('FallsInTraceGap');

    // 5. Invalid delayed anchor: rejected when used for verification or mixed into calibration, and rejected if unbounded alone
    const inv = oracle.invalidAnchor;
    const verifiedWithInvalid = calibrateClockSegment({
      recordId: 'codex-oracle',
      bootGeneration: 3,
      segmentId: 11,
      reliability: 'trusted',
      timeAnchorStatus: 'anchored-cycles',
      tickDomain: 'absolute-ticks',
      targetClock: {
        nominalHz: oracle.targetClock.nominalHz,
        direction: 'up',
        tickBits: 32,
        wrapCount: 1,
        startTicks: BigInt(oracle.windows[0][0].target.unwrappedTick),
        endTicks: BigInt(oracle.windows[0][5].target.unwrappedTick),
      },
      hostOrigin: { originId: 'oracle-host', processKind: 'dap' },
      observations: [
        ...oracle.windows[0].map((pt: any) => ({
          source: 'shared-marker' as const,
          targetTicks: BigInt(pt.target.unwrappedTick),
          hostWindow: { lowerNs: BigInt(pt.hostWindow.lowerNs), upperNs: BigInt(pt.hostWindow.upperNs) },
          role: 'calibration' as const,
        })),
        {
          id: 'invalid-anchor',
          source: 'shared-marker' as const,
          targetTicks: BigInt(inv.target.unwrappedTick),
          hostWindow: { lowerNs: BigInt(inv.hostWindow.lowerNs), upperNs: BigInt(inv.hostWindow.upperNs) },
          role: 'verification' as const,
        },
      ],
    });
    expect(verifiedWithInvalid.observationsSummary.verificationPassed).toBe(false);
    expect(verifiedWithInvalid.confidence).toBe('untrusted');
    expect(verifiedWithInvalid.trustedForAutoPreciseSync).toBe(false);

    const mixedWithInvalid = calibrateClockSegment({
      recordId: 'codex-oracle',
      bootGeneration: 3,
      segmentId: 11,
      reliability: 'trusted',
      timeAnchorStatus: 'anchored-cycles',
      tickDomain: 'absolute-ticks',
      targetClock: {
        nominalHz: oracle.targetClock.nominalHz,
        direction: 'up',
        tickBits: 32,
        wrapCount: 1,
        startTicks: BigInt(oracle.windows[0][0].target.unwrappedTick),
        endTicks: BigInt(oracle.windows[0][5].target.unwrappedTick),
      },
      hostOrigin: { originId: 'oracle-host', processKind: 'dap' },
      observations: [
        ...oracle.windows[0].map((pt: any) => ({
          source: 'shared-marker' as const,
          targetTicks: BigInt(pt.target.unwrappedTick),
          hostWindow: { lowerNs: BigInt(pt.hostWindow.lowerNs), upperNs: BigInt(pt.hostWindow.upperNs) },
        })),
        {
          id: 'invalid-anchor-mixed',
          source: 'shared-marker' as const,
          targetTicks: BigInt(inv.target.unwrappedTick),
          hostWindow: { lowerNs: BigInt(inv.hostWindow.lowerNs), upperNs: BigInt(inv.hostWindow.upperNs) },
        },
      ],
    });
    expect(mixedWithInvalid.confidence).toBe('untrusted');
    expect(mixedWithInvalid.trustedForAutoPreciseSync).toBe(false);

    const unboundedOnly = calibrateClockSegment({
      recordId: 'codex-oracle',
      bootGeneration: 3,
      segmentId: 11,
      reliability: 'trusted',
      timeAnchorStatus: 'anchored-cycles',
      tickDomain: 'absolute-ticks',
      targetClock: {
        nominalHz: oracle.targetClock.nominalHz,
        direction: 'up',
        tickBits: 32,
        wrapCount: 1,
        startTicks: BigInt(oracle.windows[0][0].target.unwrappedTick),
        endTicks: BigInt(oracle.windows[0][5].target.unwrappedTick),
      },
      hostOrigin: { originId: 'oracle-host', processKind: 'dap' },
      observations: [
        {
          id: 'invalid-unbounded',
          source: 'shared-marker',
          targetTicks: BigInt(inv.target.unwrappedTick),
          hostWindow: { lowerNs: BigInt(inv.hostWindow.lowerNs), upperNs: BigInt(inv.hostWindow.upperNs) },
          unboundedDelay: true,
        },
      ],
    });
    expect(unboundedOnly.confidence).toBe('untrusted');
    expect(unboundedOnly.trustedForAutoPreciseSync).toBe(false);
  });

  it('rejects ambiguous counter wraps, unknown directions, and large clock jumps', () => {
    const ambig = unwrapCounterTick({
      prevRawTick: 1000n,
      prevUnwrappedTick: 1000n,
      prevWrapCount: 0,
      nextRawTick: 2000n,
      tickBits: 16,
      direction: 'up',
      nominalHz: 1_000_000,
      expectedElapsedHostNs: 100_000_000n,
      elapsedUncertaintyNs: 40_000_000, // 40ms * 1MHz = 40000 ticks >= 65536/2
    });
    expect(ambig.ok).toBe(false);
    expect(ambig.errorCode).toBe('AmbiguousCounterWrap');

    const down = unwrapCounterTick({
      prevRawTick: 10n,
      prevUnwrappedTick: 10n,
      prevWrapCount: 0,
      nextRawTick: 246n, // 8-bit down counter wrapped by 20 ticks: 10 -> 0 -> 255 -> 246
      tickBits: 8,
      direction: 'down',
    });
    expect(down.ok).toBe(true);
    expect(down.unwrappedTick).toBe(-10n);
    expect(down.unwrappedTick! & 0xffn).toBe(246n);
    expect(down.wrapCount).toBe(1);

    // Full forward + reverse round-trip for 8-bit 1 kHz down-counter 3 -> 2 -> 0 -> 255
    const downReadings: Array<[bigint, bigint]> = [[3n, 0n], [2n, 1_000_000n], [0n, 3_000_000n], [255n, 4_000_000n]];
    let prevDownRaw = downReadings[0][0];
    let prevDownUnwrapped = downReadings[0][0];
    let downWraps = 0;
    const downObs: ClockCalibrationObservation[] = downReadings.map(([raw, hostNs], i) => {
      if (i > 0) {
        const res = unwrapCounterTick({
          prevRawTick: prevDownRaw,
          prevUnwrappedTick: prevDownUnwrapped,
          prevWrapCount: downWraps,
          nextRawTick: raw,
          tickBits: 8,
          direction: 'down',
          nominalHz: 1000,
          expectedElapsedHostNs: hostNs - downReadings[i - 1][1],
          maxDriftPpm: 0,
        });
        expect(res.ok).toBe(true);
        prevDownRaw = raw;
        prevDownUnwrapped = res.unwrappedTick!;
        downWraps = res.wrapCount!;
      }
      expect(prevDownUnwrapped & 0xffn).toBe(raw);
      return { source: 'shared-marker', targetTicks: prevDownUnwrapped, hostNs };
    });
    expect(downObs.map(o => o.targetTicks)).toEqual([3n, 2n, 0n, -1n]);
    expect(downWraps).toBe(1);

    const downSeg = calibrateClockSegment({
      recordId: 'down-counter-test',
      bootGeneration: 1,
      segmentId: 1,
      reliability: 'trusted',
      timeAnchorStatus: 'anchored-cycles',
      tickDomain: 'absolute-ticks',
      targetClock: {
        nominalHz: 1000,
        direction: 'down',
        tickBits: 8,
        wrapCount: downWraps,
        startTicks: downObs[0].targetTicks,
        endTicks: downObs[downObs.length - 1].targetTicks,
      },
      hostOrigin: { originId: 'test', processKind: 'offline' },
      observations: downObs,
      eventScaleNs: 2_000_000,
    });
    expect(downSeg.confidence).toBe('calibrated-moderate');
    expect(downSeg.trustedForAutoPreciseSync).toBe(true);
    expect(downSeg.errorBudget.tickResolutionNs).toBe(1_000_000);
    expect(downSeg.targetFit?.driftPpm).toBeCloseTo(0, 6);
    for (const [raw, expectedNs] of downReadings) {
      const obsItem = downObs.find(o => (o.targetTicks & 0xffn) === raw)!;
      const fwd = mapSegmentTraceTickToHost(downSeg, obsItem.targetTicks);
      expect(fwd.ok).toBe(true);
      expect(fwd.hostNs).toBe(expectedNs);
      const rev = mapHostNsToTraceSegments([downSeg], expectedNs);
      expect(rev.ok).toBe(true);
      expect(rev.targetTicks).toBe(obsItem.targetTicks);
      expect(rev.targetTicks! & 0xffn).toBe(raw);
    }

    const disc = unwrapCounterTick({
      prevRawTick: 100n,
      prevUnwrappedTick: 100n,
      prevWrapCount: 0,
      nextRawTick: 50_000_000n,
      tickBits: 32,
      direction: 'up',
      nominalHz: 1_000_000,
      expectedElapsedHostNs: 1_000_000n, // expected ~1000 ticks, saw 50M
      elapsedUncertaintyNs: 100_000,
    });
    expect(disc.ok).toBe(false);
    expect(disc.errorCode).toBe('CounterDiscontinuity');
  });

  it('distinguishes single-point, one-sided RTT arrival, uncalibrated wall-start, event-scale exceedance, and uncertain segments', () => {
    // 0 anchors -> uncalibrated
    const uncal = calibrateClockSegment({
      recordId: 'r1',
      bootGeneration: 1,
      segmentId: 1,
      reliability: 'trusted',
      timeAnchorStatus: 'anchored-cycles',
      tickDomain: 'absolute-ticks',
      targetClock: { nominalHz: 64_000_000, direction: 'up', tickBits: 32, wrapCount: 0, startTicks: 0n, endTicks: 64_000_000n },
      hostOrigin: { originId: 'host', processKind: 'extension-host' },
      observations: [],
    });
    expect(uncal.confidence).toBe('uncalibrated');
    expect(uncal.trustedForAutoPreciseSync).toBe(false);
    expect(uncal.errorBudget.displayUnitEqualsPhysicalPrecision).toBe(false);
    expect(uncal.precisionNotice).toContain('禁止硬对齐起点');

    // One-sided RTT batch arrivals -> approximate, never calibrated-high
    const rttSeg = calibrateClockSegment({
      recordId: 'r1',
      bootGeneration: 1,
      segmentId: 1,
      reliability: 'trusted',
      timeAnchorStatus: 'anchored-cycles',
      tickDomain: 'absolute-ticks',
      targetClock: { nominalHz: 64_000_000, direction: 'up', tickBits: 32, wrapCount: 0, startTicks: 0n, endTicks: 64_000_000n },
      hostOrigin: { originId: 'dap', processKind: 'dap' },
      observations: [
        { source: 'rtt-batch-arrival', oneSided: 'upper-bound', targetTicks: 0n, hostNs: 1_000_020_000_000n, uncertaintyNs: 10_000_000 },
        { source: 'rtt-batch-arrival', oneSided: 'upper-bound', targetTicks: 64_000_000n, hostNs: 1_001_035_000_000n, uncertaintyNs: 10_000_000 },
      ],
      eventScaleNs: 1_000_000,
    });
    expect(rttSeg.confidence).toBe('approximate');
    expect(rttSeg.exceedsEventScale).toBe(true);
    expect(rttSeg.trustedForAutoPreciseSync).toBe(false);

    // 2+ tight shared anchors but error (3ms) > eventScaleNs (500us) -> exceedsEventScale, no auto precise sync
    const largeScale = calibrateClockSegment({
      recordId: 'r1',
      bootGeneration: 1,
      segmentId: 1,
      reliability: 'trusted',
      timeAnchorStatus: 'anchored-cycles',
      tickDomain: 'absolute-ticks',
      targetClock: { nominalHz: 64_000_000, direction: 'up', tickBits: 32, wrapCount: 0, startTicks: 0n, endTicks: 64_000_000n },
      hostOrigin: { originId: 'dap', processKind: 'dap' },
      observations: [
        { source: 'shared-marker', targetTicks: 0n, hostWindow: { lowerNs: 1_000_000_000n, upperNs: 1_006_000_000n } },
        { source: 'shared-marker', targetTicks: 64_000_000n, hostWindow: { lowerNs: 2_000_000_000n, upperNs: 2_006_000_000n } },
      ],
      eventScaleNs: 500_000,
    });
    expect(largeScale.exceedsEventScale).toBe(true);
    expect(largeScale.trustedForAutoPreciseSync).toBe(false);

    // Uncertain segment reliability -> untrusted
    const uncertain = calibrateClockSegment({
      recordId: 'r1',
      bootGeneration: 1,
      segmentId: 1,
      reliability: 'uncertain',
      timeAnchorStatus: 'uncertain',
      tickDomain: 'relative-ticks',
      targetClock: { nominalHz: 64_000_000, direction: 'up', tickBits: 32, wrapCount: 0, startTicks: 0n, endTicks: 64_000_000n },
      hostOrigin: { originId: 'dap', processKind: 'dap' },
      observations: [
        { source: 'shared-marker', targetTicks: 0n, hostNs: 1_000_000_000n, uncertaintyNs: 1000 },
        { source: 'shared-marker', targetTicks: 64_000_000n, hostNs: 2_000_000_000n, uncertaintyNs: 1000 },
      ],
    });
    expect(uncertain.confidence).toBe('untrusted');
    expect(uncertain.trustedForAutoPreciseSync).toBe(false);
  });

  it('keeps O(1) bounded memory over 50,000 observations in OnlineAffineAccumulator and round-trips serialization', () => {
    const acc = new OnlineAffineAccumulator(64_000_000, 'up', 64);
    for (let i = 0; i < 50_000; i++) {
      const ticks = BigInt(i) * 64_000n; // 1 ms step for 50s
      const hostNs = 10_000_000_000_000n + BigInt(i) * 1_000_050n; // +50 ppm
      acc.add(ticks, hostNs, 2_000);
    }
    const fit = acc.buildFit();
    expect(fit).toBeDefined();
    expect(fit!.sampleCount).toBe(50_000);
    expect(fit!.anchors.length).toBeLessThanOrEqual(64);
    expect(fit!.driftPpm).toBeCloseTo(50, 3);

    const seg = calibrateClockSegment({
      recordId: 'long-rec',
      bootGeneration: 1,
      segmentId: 1,
      reliability: 'trusted',
      timeAnchorStatus: 'anchored-cycles',
      tickDomain: 'absolute-ticks',
      targetClock: { nominalHz: 64_000_000, direction: 'up', tickBits: 32, wrapCount: 0, startTicks: 0n, endTicks: 100_000_000n },
      hostOrigin: { originId: 'dap', processKind: 'dap' },
      observations: [
        { source: 'shared-marker', targetTicks: 0n, hostNs: 10_000_000_000n, uncertaintyNs: 5000 },
        { source: 'shared-marker', targetTicks: 64_000_000n, hostNs: 11_000_050_000n, uncertaintyNs: 5000 },
      ],
    });
    const map: TraceClockMap = {
      version: 1,
      recordId: 'long-rec',
      hostOrigin: { originId: 'dap', processKind: 'dap' },
      segments: [seg],
      boundaries: [],
    };
    const json = JSON.stringify(serializeTraceClockMap(map));
    const roundTripped = deserializeTraceClockMap(JSON.parse(json));
    expect(roundTripped.segments[0].targetFit?.anchorDomainTicks).toBe(0n);
    expect(roundTripped.segments[0].targetFit?.driftPpm).toBeCloseTo(50, 1);
  });

  it('maps Variable TIMELINE ms <-> Host monotonic ns across pauses, multi-session offsets, and cross-process pairings', () => {
    const meta: TimelineClockSyncMeta = {
      samplingSource: 'host',
      hostOrigin: { originId: 'dap-proc-1', processKind: 'dap' },
      originHostMs: 1000,
      pauseAdjusted: true,
      pauseIntervals: [
        { timelineMs: 500, pausedAtHostMs: 1500, resumedAtHostMs: 6500, pausedDurationMs: 5000 },
      ],
      sessionSegments: [
        { sessionIndex: 0, sessionId: 's1', name: 'Run 1', startedAtUtc: '2026-11-19T00:00:00Z', startMs: 0, hostStartMs: 1000, pauseAdjusted: true },
        { sessionIndex: 1, sessionId: 's2', name: 'Run 2', startedAtUtc: '2026-11-19T00:01:00Z', startMs: 1000, hostStartMs: 20000, pauseAdjusted: true },
      ],
    };

    // Before pause (timelineMs = 200 -> host = 1200ms)
    const r1 = timelineMsToHostNs(meta, 200);
    expect(r1.ok).toBe(true);
    expect(r1.hostNs).toBe(1_200_000_000n);

    // After pause inside session 0 (timelineMs = 700 -> host = 1000 + 700 + 5000 = 6700ms)
    const r2 = timelineMsToHostNs(meta, 700);
    expect(r2.ok).toBe(true);
    expect(r2.hostNs).toBe(6_700_000_000n);
    const back2 = hostNsToTimelineMs(meta, r2.hostNs!);
    expect(back2.ok).toBe(true);
    expect(back2.timelineMs).toBeCloseTo(700, 6);

    // Inside session 1 (timelineMs = 1250 -> host = 20000 + 250 = 20250ms)
    const r3 = timelineMsToHostNs(meta, 1250);
    expect(r3.ok).toBe(true);
    expect(r3.hostNs).toBe(20_250_000_000n);

    // Host time falling inside halt interval [1500, 6500) -> clamped at timelineMs=500 with fellInPause=true
    const inPause = hostNsToTimelineMs(meta, 3_000_000_000n);
    expect(inPause.ok).toBe(true);
    expect(inPause.fellInPause).toBe(true);
    expect(inPause.timelineMs).toBeCloseTo(500, 6);

    // Cross-process origin pairing shifts hostNs and propagates pairingErrorNs
    const paired = timelineMsToHostNs(meta, 200, {
      fromOriginId: 'dap-proc-1',
      toOriginId: 'ext-host-1',
      offsetNs: '50000000',
      pairingErrorNs: 250000,
      pairedAtWallMs: 1700000000000,
    });
    expect(paired.ok).toBe(true);
    expect(paired.hostNs).toBe(1_250_000_000n);
    expect(paired.crossProcessErrorNs).toBe(250_000);
  });
});
