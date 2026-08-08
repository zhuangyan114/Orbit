# J-Link Timeline Benchmark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run reproducible J-Link native 3-Watch and 6-Watch Timeline hardware benchmarks and compare both flush frequency and per-expression sample rate with CMSIS-DAP.

**Architecture:** Extend the existing DAP-07 evidence validator with probe-aware owner rules and a pure sampling-rate calculation, then parameterize the existing hardware harness so both probes share one DAP client and metric pipeline. Hardware runs remain single-owner, read-only with respect to Flash, and produce probe-separated evidence archives consumed by the report.

**Tech Stack:** Node.js CommonJS hardware harness, TypeScript/Vitest tests, VS Code DAP over stdio, native J-Link helper with JLink_x64.dll, Markdown report.

## Global Constraints

- Target/ELF: `D:\STM32\project\vet6_led` / `build\Debug\vet6_led.elf`.
- SWD speed: 1000 kHz for both probes.
- Timeline expressions: `uwTick`, `xTickCount`, `aww`; Watch interval 100 ms.
- Timeline target interval: 0.2 ms; DAP send interval: 16 ms.
- Formal runs: 3 Watch and 6 Watch, at least 60 seconds each.
- J-Link owner: exactly one `jlink-native` helper, `nativeDebugEngineMode=native`, no legacy fallback.
- `flashBeforeDebug=false`; Flash/erase/program/verify log count must be zero.
- Do not update `docs/bug-fix-log.md` before user UI confirmation.
- Do not commit implementation changes; the user requested only the earlier rollback checkpoint and the required design commit.

---

### Task 1: Probe-Aware Evidence Validation

**Files:**
- Modify: `src/debug/dap07-hardware-evidence.test.ts`
- Modify: `scripts/cmsis-dap/dap07-evidence-validation.js`

**Interfaces:**
- Consumes: benchmark summary fields already produced by `verify-dap07-timeline-hw.js`.
- Produces: `calculateActualSampleRate(pointCount, expressionCount, durationMs): number` and `validateDap07Summary(summary, expectedOwner): string[]`, where `expectedOwner` is `cmsis-dap` or `jlink-native`.

- [ ] **Step 1: Write failing tests for J-Link owner validation and rate calculation**

Add tests that expect:

```ts
expect(calculateActualSampleRate(11253, 3, 60511)).toBeCloseTo(61.99, 2);
expect(validateDap07Summary({
  ...valid,
  helperPids: [1234],
  selectedOwners: [{ mode: 'native', owner: 'jlink-native' }],
}, 'jlink-native')).toEqual([]);
expect(validateDap07Summary({
  ...valid,
  helperPids: [1234],
  selectedOwners: [{ mode: 'auto', owner: 'jlink-legacy' }],
}, 'jlink-native')).toContain(expect.stringContaining('jlink-native'));
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `npx vitest run src/debug/dap07-hardware-evidence.test.ts`

Expected: FAIL because `calculateActualSampleRate` is absent and `validateDap07Summary` still hard-codes CMSIS-DAP.

- [ ] **Step 3: Implement minimal probe-aware validation**

Implement finite positive rate calculation and select owner checks by `expectedOwner`:

```js
function calculateActualSampleRate(pointCount, expressionCount, durationMs) {
  if (![pointCount, expressionCount, durationMs].every(Number.isFinite)
      || pointCount < 0 || expressionCount <= 0 || durationMs <= 0) return 0;
  return pointCount / expressionCount / (durationMs / 1000);
}
```

For `cmsis-dap`, require `{ probe: 'cmsis-dap', owner: 'cmsis-dap' }`; for `jlink-native`, require `{ mode: 'native', owner: 'jlink-native' }`. Error text must name the expected owner.

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run: `npx vitest run src/debug/dap07-hardware-evidence.test.ts`

Expected: all evidence validation tests pass.

### Task 2: Parameterize the Hardware Harness

**Files:**
- Modify: `scripts/cmsis-dap/verify-dap07-timeline-hw.js`
- Test: `src/debug/dap07-hardware-evidence.test.ts`

**Interfaces:**
- Consumes: `--probe=cmsis-dap|jlink`, `calculateActualSampleRate`, and `validateDap07Summary(summary, expectedOwner)`.
- Produces: probe-specific launch configuration and evidence under `outputs/dap07/jlink/watch-{3|6}/...` for J-Link while preserving current CMSIS-DAP paths.

- [ ] **Step 1: Add failing probe parsing tests**

Export and test `normalizeProbe(value)`:

```ts
expect(normalizeProbe('jlink')).toBe('jlink');
expect(normalizeProbe('cmsis-dap')).toBe('cmsis-dap');
expect(() => normalizeProbe('openocd')).toThrow(/cmsis-dap or jlink/);
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `npx vitest run src/debug/dap07-hardware-evidence.test.ts`

Expected: FAIL because `normalizeProbe` is absent.

- [ ] **Step 3: Implement minimal probe parameterization**

Add `normalizeProbe` to the evidence helper, parse `--probe` in the harness, and construct launch arguments as follows:

```js
const launchArgs = {
  program: elfPath,
  device: 'STM32F407VE',
  deviceName: 'STM32F407VE',
  interface: 'SWD',
  speedKHz,
  probe,
  flashBeforeDebug: false,
  nativeDebugEngineEnabled: true,
  nativeDebugEngineMode: isJLink ? 'native' : 'auto',
  loggingEnabled: true,
  clearLogsOnStart: true,
  rttLogEnabled: false,
  ...(isJLink ? {} : {
    cmsisDapTransport: 'hid', cmsisDapVid: vid,
    cmsisDapPid: pid, cmsisDapSerial: serial,
  }),
};
```

For J-Link parse helper PIDs with `/\[cpp-jlink process\] spawned pid=(\d+)/g`, owners with `/selected mode=([^ ]+) owner=([^ ]+)/g`, and flag `jlink-legacy`, CMSIS-DAP, JLink.exe, OpenOCD, or GDB lines as unexpected. Add `actualSampleRateHz` to the summary using three Timeline expressions.

- [ ] **Step 4: Verify syntax and focused behavior**

Run: `node --check scripts/cmsis-dap/verify-dap07-timeline-hw.js`

Run: `npx vitest run src/debug/dap07-hardware-evidence.test.ts`

Expected: syntax check exits 0 and all focused tests pass.

### Task 3: Build and J-Link Hardware Runs

**Files:**
- Generate evidence only: `outputs/dap07/jlink/watch-3/<timestamp>/`
- Generate evidence only: `outputs/dap07/jlink/watch-6/<timestamp>/`

**Interfaces:**
- Consumes: built `dist/debugadapter.js`, `orbit-jlink-helper.exe`, JLink_x64.dll, attached J-Link probe.
- Produces: validated J-Link evidence JSON/logs for both matrix rows.

- [ ] **Step 1: Run focused automated verification**

Run: `npm run typecheck`

Run: `npm run build`

Run: `npm run build:native`

Expected: all commands exit 0.

- [ ] **Step 2: Run a 5-second J-Link smoke benchmark**

Run: `node scripts/cmsis-dap/verify-dap07-timeline-hw.js --hardware --probe=jlink --duration-ms=5000 --watch-count=3`

Expected: validation `ok=true`, one `cpp-jlink` helper PID, selected owner `jlink-native`, Flash count 0, Watch data success 100%, and no owner process after disconnect.

- [ ] **Step 3: Run the formal 3-Watch benchmark**

Run: `node scripts/cmsis-dap/verify-dap07-timeline-hw.js --hardware --probe=jlink --duration-ms=60000 --watch-count=3`

Expected: evidence validation passes and an archive is created under the J-Link 3-Watch path.

- [ ] **Step 4: Run the formal 6-Watch benchmark**

Run: `node scripts/cmsis-dap/verify-dap07-timeline-hw.js --hardware --probe=jlink --duration-ms=60000 --watch-count=6`

Expected: evidence validation passes and an archive is created under the J-Link 6-Watch path.

### Task 4: Update Matrix and Final Verification

**Files:**
- Modify: `docs/dap07-timeline-performance-report.md`

**Interfaces:**
- Consumes: validated CMSIS-DAP and J-Link evidence JSON.
- Produces: one comparison matrix containing probe, Watch count, flush Hz, actual per-expression sample rate, event gaps, Watch latency, success rate, and Pause latency.

- [ ] **Step 1: Calculate matrix values from evidence JSON**

For every retained row use:

```text
flush Hz = sampleEvents / (durationMs / 1000)
actual sample Hz/expression = pointCount / 3 / (durationMs / 1000)
```

Do not derive actual sample rate from the configured 0.2 ms target interval.

- [ ] **Step 2: Update the report**

Add J-Link 3/6 Watch rows, add `实际采样 Hz/表达式` to the matrix, record J-Link DLL/helper owner evidence and archive paths, and explain that flush frequency is batched DAP delivery while actual sampling frequency is target data points per expression.

- [ ] **Step 3: Run final verification from the completed tree**

Run: `npm test`

Run: `npm run typecheck`

Run: `npm run build`

Run: `git diff --check`

Run a process check for `orbit-jlink-helper`, `orbit-cmsis-dap-helper`, `JLink.exe`, OpenOCD, and GDB.

Expected: 0 test/build/type/diff failures, no versioned `dist` change, and no target-owner process remains.
