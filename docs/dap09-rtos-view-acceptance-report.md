# DAP-09 CMSIS-DAP RTOS View Acceptance Report

Date: 2026-08-08 21:40 CST
Branch: `codex/dap09-rtos-view`
Verified head: `40899e790b888dc68437754d2c867b0eaca3c8d5`
Target profile: STM32F407VET6, CMSIS-DAP_LU (`C251:F001`, `LU_2022_8888`), wired CMSIS-DAP HID, FreeRTOS 10.3.1 with CMSIS-RTOS v1 wrapper.
Firmware workspace: `D:\STM32\project\vet6_led`

## Acceptance Status

Automation and code review: **PASS**.
Hardware evidence: **USER-OBSERVED / PARTIAL**. The screenshots show complete RTOS Views through both DAPLink and J-Link sessions, but the agent did not independently start a target session or execute target-mutating operations. DAP-09-HW remains pending independent authorized re-verification.

## Code Review

- RTOS roots start collapsed and lazy `variables` requests expand one DAP level at a time, preserving standard non-RTOS compound `evaluate/variables` behavior.
- Stopped-state RTOS reads use the read gate and return structured failures with `errorCode`, `targetState`, `elapsedMs`, and `diagnostics` instead of publishing an empty successful tree.
- Transient `Busy`, `TargetReadUnavailable`, and `RtosReadCancelled` results remain retryable by the external RTOS Views tracker; permanent symbol/configuration errors remain visible.
- RTOS refreshes are background work. Native scheduling remains `control > watch > timeline > background`, and control operations propagate cancellation through the DAP gate, target channel, and physical owner.
- Stop generation, read epoch, connection phase, variable-handle generation, active-session identity, and replacement-session fences prevent stale task data from being published.
- `probe: "cmsis-dap"` remains bound to one CMSIS-DAP helper owner. No OpenOCD, GDB server, `JLink.exe`, J-Link fallback, second helper, or second target owner was added.
- No generated `dist/` bundle and no `docs/bug-fix-log.md` change was made for this report.

## Unit / Mock

- `npm test`: 303/303 tests passed.
- Focused DAP/CMSIS-DAP, scopes, target-read-gate, scheduler, owner-lifecycle, and session-channel tests passed.
- Coverage includes FreeRTOS detection and `rtosInfo`; lazy `evaluate`/`variables`/`readMemory`; standard compound variables; Local/Registers foreground priority; Continue/Reset/Disconnect/session replacement cancellation; invalid-address recovery; structured stale errors; and the prohibition on CMSIS-DAP J-Link/legacy fallback.
- `npm run test:cmsis-dap:mock`: passed.
- `npm run test:cpp-channel:mock`: passed.
- `npm run test:cmsis-dap:algorithm`: passed; algorithm size 1576 bytes.
- Mock and unit results are protocol/lifecycle evidence, not hardware acceptance.

## Build

- `npm run typecheck`: passed.
- `npm run build`: passed.
- `npm run build:native`: passed.
- `out\native\win32-x64\orbit-cmsis-dap-helper.exe --selftest`: passed, 200 cases, 0 failures.
- `git diff --check`: passed.
- `git status --short -- dist`: clean.

## Hardware Status

The following are screenshots supplied by the user after manual sessions. They are archived under `outputs/dap09/20260808-214005/screenshots/` and are not an agent-run hardware trace.

| Path | Session shown | Observed RTOS result | Refresh time |
| --- | --- | --- | --- |
| DAPLink | `Ozone: DAPLink Debug STM32F407VET6` | FreeRTOS detected; 4 threads, 1 queue, 2 MUX/SEMS | 1669 ms |
| J-Link | `Ozone: Debug STM32` | FreeRTOS detected; 4 threads, 1 queue, 2 MUX/SEMS | 189 ms |

The thread snapshots show `defaultTask`, `myTask02`, `rttBench`, and `IDLE`, with names, states, priorities, stack addresses/usage, and runtime percentages. The queue snapshot shows a capacity-4, 4-byte-item queue with zero used items. The MUX/SEMS snapshot shows one binary semaphore and one mutex with no waiters. Small stack/runtime differences between the two captures are expected because they are different sampling moments. The approximately 8.8x refresh-time difference is an observation from two screenshots, not a controlled latency benchmark.

Hardware authorization limits remain in force. The agent executed no reset, halt, run, step, RAM write, Flash write, or external firmware modification. The report does not claim Flash count for the user's manual sessions; the agent-side target-mutating operation count is 0.

## Owner / Routing

- Code and Mock evidence: CMSIS-DAP selects exactly one CMSIS-DAP helper owner and does not construct J-Link or Legacy owners for `probe: "cmsis-dap"`.
- J-Link and DAPLink screenshots demonstrate separate sessions can expose the same RTOS DAP contract; they do not independently prove helper PID, owner count, or replacement cleanup.
- RTOS, Watch, Timeline, RTT, Local/Registers, Variables, and Memory requests remain routed through the active DAP owner; no extension-host duplicate path is introduced.

## Concurrency and Latency

- Verified scheduler order: `control > watch > timeline > background`.
- RTOS refresh is cancellable background work and cannot permanently occupy the control/read gate.
- Continue/Halt/Step/Reset and session termination advance the relevant fences and invalidate queued RTOS results.
- Local and Registers retain foreground stopped-state priority while RTOS refresh is pending.
- Hardware observations: DAPLink screenshot refresh 1669 ms; J-Link screenshot refresh 189 ms. P95 control latency, 60-second stability, and concurrent Watch/Timeline/RTT control latency were not measured.

## Unimplemented / Deferred

- Independent authorized hardware rerun with a synchronized DAP trace.
- Dynamic task create/delete and proof that an invalidated TCB address is not reused.
- Capture of FreeRTOS ABI, compiler optimization level, and complete `FreeRTOSConfig` evidence in the same hardware run.
- Concurrent Watch, Timeline, RTT, RTOS View, and control-latency/P95 validation.
- Reset, Continue, Disconnect, helper-crash, and target-removal cleanup on real hardware.
- DAP-10 MemoryView remains out of scope.

## Commits and Pushes

All commits below were pushed to `origin/codex/dap09-rtos-view`:

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

Evidence index: `outputs/dap09/20260808-214005/evidence.json`.
