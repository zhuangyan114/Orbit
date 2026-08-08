# DAP-09 CMSIS-DAP RTOS View Acceptance Report

Date: 2026-08-08 23:10 CST
Branch: `codex/dap09-rtos-view`
Verified code head: `3266c40701f955409d492af05fd64c69b4555313`
Target profile: STM32F407VET6, CMSIS-DAP_LU (`C251:F001`, `LU_2022_8888`), wired CMSIS-DAP HID, FreeRTOS 10.3.1 with CMSIS-RTOS v1 wrapper.
Firmware workspace: `D:\STM32\project\vet6_led`

## Acceptance Status

Code review, unit/Mock verification, and builds: **PASS**.

Hardware acceptance for code head `3266c40`: **PENDING EXPLICIT AUTHORIZATION**. Earlier user-provided screenshots show that both DAPLink and J-Link could populate RTOS Views, but those screenshots predate the lifecycle fix and are not an independent hardware rerun. DAP-09 must not be declared independently accepted until the hardware gates below are executed with authorization.

## Code Review

- `handleRtosInfo()` registers its `AbortController` before waiting for the target-read gate. A newer `rtosInfo` request aborts the previous request.
- `beginControl()` reaches `cancelActiveTargetReads()`, which now aborts active `rtosInfo` work. Disconnect, Reset, Continue, session disposal/replacement, and owner-loss termination all advance the read epoch and cancel queued or in-flight RTOS work.
- A cancelled request returns DAP `success: false`, `detected: false`, and a structured `TargetReadCancelled`/`RtosReadCancelled` body with `targetState`, `elapsedMs`, and `diagnostics`. Stale success data cannot be published after control begins or the session terminates.
- `finally` clears the controller slot only when it still belongs to that request. The target-read gate is released only when that request acquired it, including thrown/error paths.
- Session disposal resets variable handles and their allocation generation. Tests assert no controller, gate waiter, waiter timer, drain timer, target-read flag, or variable handle remains.
- Ordinary `RtosNotDetected` and non-cancelled gate-unavailable results preserve the existing compatibility response semantics. Standard `evaluate`, lazy `variables`, byte-oriented `readMemory`, Local, Registers, Watch, Timeline, RTT, and the J-Link path were not disabled or rerouted.
- `probe: "cmsis-dap"` remains bound to one CMSIS-DAP helper owner. No OpenOCD, GDB server, `JLink.exe`, J-Link/legacy fallback, second helper, or second target owner was introduced.
- Main-agent source and final diff review completed. The attempted read-only sub-agent reviews were unavailable because of service-side HTTP 429 responses, so no independent review claim is made.
- No manual `dist/` edit and no `docs/bug-fix-log.md` change was made.

## Unit / Mock

- TDD red baseline: the new lifecycle characterization initially reported 5 failed and 50 passed tests. Failures covered active-controller registration and Continue/Reset/Disconnect/owner-loss cancellation.
- Focused `src/debug/dap-session-cmsis-dap.test.ts`: 57/57 passed after the fix.
- Focused DAP scopes, target-read gate, realtime variables, native scheduler, and session target channel: 126/126 passed at the first green checkpoint; the final full suite supersedes this count.
- `npm test`: 310/310 tests passed across 32 files.
- Coverage includes FreeRTOS detection and `rtosInfo`; ordinary detection-failure compatibility; in-flight and queued cancellation; successful Continue priority; Reset, Disconnect, session replacement, and owner loss; resource cleanup; lazy `evaluate`/`variables`/`readMemory`; Local/Registers; invalid-address recovery; RTT/Timeline coexistence; and the CMSIS-DAP no-fallback owner contract.
- `npm run test:cmsis-dap:mock`: passed.
- `npm run test:cpp-channel:mock`: passed.
- `npm run test:cmsis-dap:algorithm`: passed; algorithm size 1576 bytes.
- Unit and Mock results are protocol/lifecycle evidence, not hardware acceptance.

## Build

- `npm run typecheck`: passed.
- `npm run build`: passed.
- `npm run build:native`: passed.
- `out\native\win32-x64\orbit-cmsis-dap-helper.exe --selftest`: passed, 200 cases, 0 failures.
- `git diff --check`: passed.
- `git status --short -- dist`: clean.

## Hardware Status

No target-mutating operation was executed during this rework. The agent did not reset, halt, run, step, write RAM, write Flash, modify the external firmware, or start a hardware debug session. Agent-side Flash operation count is 0.

The earlier screenshots under `outputs/dap09/20260808-214005/screenshots/` remain useful only as user-observed baseline evidence:

| Path | Session shown | Observed RTOS result | Refresh time |
| --- | --- | --- | --- |
| DAPLink | `Ozone: DAPLink Debug STM32F407VET6` | FreeRTOS detected; 4 threads, 1 queue, 2 MUX/SEMS | 1669 ms |
| J-Link | `Ozone: Debug STM32` | FreeRTOS detected; 4 threads, 1 queue, 2 MUX/SEMS | 189 ms |

Those captures show `defaultTask`, `myTask02`, `rttBench`, and `IDLE`, with names, states, priorities, stack data, and runtime percentages. They do not prove the new cancellation behavior, dynamic task deletion, 60-second stability, synchronized trace, helper PID, owner lifecycle, or control latency.

## Owner / Routing

- Code and Mock evidence confirms that CMSIS-DAP selects exactly one CMSIS-DAP helper owner and does not construct J-Link or Legacy owners for `probe: "cmsis-dap"`.
- RTOS, Watch, Timeline, RTT, Local/Registers, Variables, and Memory requests remain routed through the active DAP owner; no extension-host duplicate path was added.
- Hardware `ownerKind`, helper PID, `jlinkInvolved`, `secondOwnerCreated`, and replacement cleanup remain pending synchronized capture. They are not inferred from screenshots.

## Concurrency and Latency

- Verified scheduler order remains `control > watch > timeline > background`.
- `rtosInfo` owns the DAP read gate while its background owner operation runs, but Continue/Reset/Disconnect/termination abort it and allow control to drain the gate.
- The queued test proves Continue completes successfully and no `evaluateExpression` is issued by the cancelled RTOS request after the target starts running.
- Local and Registers retain foreground stopped-state priority while RTOS refresh is pending.
- Hardware P50/P95 control latency, Watch + Timeline + RTT + RTOS concurrency, and 60-second stability were not measured. The earlier 1669 ms and 189 ms screenshot refresh times are observations, not a controlled benchmark.

## Unimplemented / Deferred

- Independent authorized hardware rerun against code head `3266c40` with a synchronized DAP trace.
- At least three tasks plus dynamic task create/delete, with proof that invalidated TCB data is not reused.
- Reset, Continue, and Disconnect proof that stale tasks do not publish and no helper remains.
- Concurrent Watch, Timeline, RTT, and RTOS View refresh with control-latency P50/P95.
- Continuous 60-second refresh.
- FreeRTOS version, ABI, compiler optimization, and key `FreeRTOSConfig` capture from the tested image.
- Helper PID, `ownerKind`, `jlinkInvolved`, `secondOwnerCreated`, and Flash operation count in the same hardware evidence set.
- DAP-10 MemoryView remains out of scope.

## Commits and Pushes

All listed commits were pushed to `origin/codex/dap09-rtos-view`:

- `d187e06` test: characterize RTOS View DAP contract
- `ea41517` fix: preserve RTOS stopped-state requests
- `3b2e2dc` fix: detect FreeRTOS through DAP rtosInfo
- `352d353` test: preserve RTOS background read scheduling contract
- `0da9b31` docs: add DAP-09 acceptance evidence
- `6ca8756` docs: record final DAP-09 commit
- `7f645d9` test: characterize RTOS lazy variable expansion
- `7505d7d` fix: lazily expand RTOS DAP variables
- `5f13806` docs: update DAP-09 RTOS regression evidence
- `0304f0c` test: cover RTOS review regressions
- `7ef8fe9` fix: preserve RTOS scheduling and variable contracts
- `0cd96aa` test: cover RTOS background scheduling regressions
- `2397829` fix: keep RTOS refreshes off the control queue
- `0172357` test: cover contextless RTOS background evaluate
- `f8b963e` fix: avoid foreground work in RTOS background evaluate
- `a7b22be` test: assert contextless RTOS refresh has no delay
- `829072c` docs: add final DAP-09 acceptance evidence
- `0d1fdf5` fix: expose RTOS array evaluate names
- `cdd9b0a` fix: refresh RTOS views for replacement sessions
- `dde33eb` style: format RTOS refresh callback
- `b284016` fix: keep RTOS transient reads retryable
- `40899e7` docs: update Orbit RTOS View configuration guidance
- `79c39c0` docs: record DAP-09 RTOS hardware evidence
- `3266c40` fix: cancel stale RTOS info reads

Evidence index: `outputs/dap09/20260808-231053/evidence.json`.
