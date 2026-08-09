# DAP-09 CMSIS-DAP RTOS View Acceptance Report

Date: 2026-08-09 13:20 CST
Branch: `codex/dap09-rtos-view`
Verified code head: `b1be0c668f3bd5c707fcd00a6cf45f4e8324f2d5`
Target profile: STM32F407VET6, CMSIS-DAP_LU (`C251:F001`, `LU_2022_8888`), wired CMSIS-DAP HID, FreeRTOS 10.3.1 with CMSIS-RTOS v1 wrapper.
Firmware workspace: `D:\STM32\project\vet6_led`

## Acceptance Status

Code review, unit/Mock verification, and builds: **PASS**.

Hardware acceptance for code head `b1be0c6`: **PARTIAL, NOT ACCEPTED**. The authorized read-only rerun proved a stable running-state FreeRTOS baseline, a stopped-state TCB snapshot, and a single CMSIS-DAP owner. It did not produce a dynamic create/delete fixture, synchronized raw DAP trace, concurrency latency, or a zero-Flash run. The running evidence is under `outputs/dap09/20260809-130446/`; the stopped snapshot is under `outputs/dap09/20260809-131254/`.

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

The authorized rerun used the already-open session and performed read-only expression reads plus a 60-second background recording. No reset, halt, run, step, RAM write, or external firmware edit was issued by the agent during the recording. However, the session's launch log contains 13 CMSIS-DAP Flash operations (`init`, 3 `eraseSector`, 4 `programPage`, 4 `verify`, `uninit`) at 04:45:19-04:45:24. Because that launch was not a separately captured zero-Flash run, the DAP-09 Flash=0 gate is **not met**.

Stopped-state snapshot (`outputs/dap09/20260809-131254/`) was captured after the user paused the already-open session. The API reported `targetState=halted`; the snapshot contains four tasks and uses each TCB address as its stable key:

| Task | Stable TCB key | Priority | Stack used |
| --- | --- | ---: | ---: |
| `defaultTask` | `0x20000740` | 3 | 204 / 1016 bytes (20.1%) |
| `myTask02` | `0x200009B8` | 0 | 316 / 504 bytes (62.7%) |
| `rttBench` | `0x20000E30` | 0 | 100 / 1016 bytes (9.8%) |
| `IDLE` | `0x20003E58` | 0 | 84 / 508 bytes (16.5%) |

The snapshot also records `uxTCBNumber` values 1-4, which can support invalidated-TCB detection when a dynamic create/delete fixture is available. Dynamic task creation/deletion was not exercised, so stale-key non-reuse remains unverified. The captured `ulRunTimeCounter` values showed a mismatch between decoded numeric values and their low 32-bit hexadecimal representation; runtime counters are retained as raw evidence but are not claimed as final accurate values. Raw captures are preserved in `stopped-tcb-raw.json` and `stopped-dap-trace.log`.

The restarted debug session produced a second read-only running-state recording in `outputs/dap09/20260809-133000/evidence.json`: 60 seconds, 500 ms interval, 40 frames, and 0 read errors. `uxCurrentNumberOfTasks` stayed at 4; all four task handles stayed unchanged; `pxCurrentTCB` switched between `0x20000E30` and `0x20003E58`. The active owner was one CMSIS-DAP HID helper (PID 30564); no J-Link, OpenOCD, GDB server, or second helper process was found. This is stability and owner evidence only; it does not prove Reset/Continue/Disconnect cleanup or control latency.

Read-only hardware evidence (`outputs/dap09/20260809-130446/evidence.json`):

- `targetState`: running; `uxCurrentNumberOfTasks`: 4 throughout 39 frames over 60.0 seconds; zero read errors.
- Stable task handles: `defaultTaskHandle=0x20000740`, `myTask02Handle=0x200009B8`, `rttBenchTaskHandle=0x20000E30`, `xIdleTaskHandle=0x20003E58`.
- `pxCurrentTCB` changed among three values while running, as expected from scheduler switches; this is not a consistent TCB snapshot.
- `ownerKind=cmsis-dap`, helper PID `6224`, no J-Link process or legacy/OpenOCD/GDB log match, and no second owner observed.
- Firmware evidence: FreeRTOS 10.3.1/CMSIS-RTOS v1, GCC 10.3, `-O0 -g3`, Cortex-M4F hard-float ABI; key `FreeRTOSConfig` values are recorded in `firmware-config.txt`.

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
- The 60-second running-state refresh baseline passed twice: the original run had 39 frames and zero read errors, and the restarted-session rerun had 40 frames and zero read errors. Hardware P50/P95 control latency, Watch + Timeline + RTT + RTOS concurrency, and stopped-state TCB consistency across transitions were not measured. The earlier 1669 ms and 189 ms screenshot refresh times are observations, not a controlled benchmark.

## Unimplemented / Deferred

- Dynamic task create/delete with proof that invalidated TCB data is not reused (the stopped-state four-task snapshot is recorded, but no lifecycle fixture was available).
- Reset, Continue, and Disconnect proof that stale tasks do not publish and no helper remains.
- Concurrent Watch, Timeline, RTT, and RTOS View refresh with control-latency P50/P95.
- 60-second stopped-state/concurrent refresh with control latency; the running-state 60-second baseline is recorded.
- Independent confirmation that the captured image's FreeRTOS version, ABI, optimization, and `FreeRTOSConfig` match the source workspace; source/build evidence is recorded for this run.
- Flash-zero launch evidence; this run recorded 13 Flash operations and therefore cannot satisfy the zero-Flash gate.
- Helper PID, `ownerKind`, `jlinkInvolved`, and `secondOwnerCreated` are present in the new evidence set; a raw synchronized DAP trace remains pending.
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
