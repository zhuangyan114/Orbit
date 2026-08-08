# DAP-09 CMSIS-DAP RTOS View Acceptance Report

Date: 2026-08-08 18:37 CST
Branch: `codex/dap09-rtos-view`
Verified code head: `a7b22be38d456c192fedb583c8a2b9201a506985`
Target profile: STM32F407VET6, CMSIS-DAP_LU (`C251:F001`, `LU_2022_8888`), wired CMSIS-DAP HID, FreeRTOS 10.3.1 with CMSIS-RTOS v1 wrapper.

## Code Review

- The observed external failure was `FreeRTOS detected`, followed by missing `variablesReference` values and `Unable to collect full RTOS information`. Local and Registers also stalled while `rtos` was enabled.
- Root cause 1 was eager recursive expansion of FreeRTOS arrays and cyclic pointers during the initial evaluate request. RTOS roots now start collapsed with `expandedExpressions: []`, and each `variables` request expands one requested path.
- Root cause 2 was a successful zero-reference response after the stopped-target read gate timed out. Gate failures now return failed, structured DAP responses with `errorCode`, `targetState`, `elapsedMs`, and `diagnostics`.
- Independent review found that the first lazy-handle fix had broken ordinary non-RTOS compound `evaluate/variables` expansion. The standard DAP branch is restored and covered by a struct-child regression test.
- Independent review also found that RTOS `background` priority and cancellation stopped at the DAP gate. They now propagate through `OzoneCommand`, `OzoneBackend`, `SessionTargetOwner.readMemory`, and the unique CMSIS-DAP helper's `NativeScheduler`.
- A second review found that RTOS refresh still issued control-priority target-state probes at the DAP and Commander layers. Stopped RTOS requests now use the fenced DAP session state, so both hover and contextless standard evaluate avoid `getState` control work.
- Queued owner cancellation is normalized to `EvaluateCancelled`. Contextless RTOS background evaluate also skips the ordinary foreground evaluate's fixed 100 ms delay, while non-background requests retain their state check and delay.
- Connection loss clears all variable handles. Continue and other control paths clear handles, advance the read epoch, abort active reads, and prevent stale stop-generation results from being published.
- Invalidated lazy RTOS requests now fail with structured `RtosReadCancelled` metadata rather than succeeding with an empty task list.
- No OpenOCD, GDB server, `JLink.exe`, J-Link fallback, legacy fallback, second helper, or second target owner was introduced. No generated `dist/` file was edited manually.

## Unit / Mock

- Initial review red phase: 6 expected failures and 61 passes across two review-focused files.
- Scheduling review red phase: 3 expected failures and 67 passes; the contextless follow-up added one independently confirmed red case.
- Final review-focused set: 71/71 tests passed across the DAP and CMSIS-DAP backend files.
- Required cross-module set: 122/122 tests passed across DAP session, scopes, read gate, scheduler, owner, and CMSIS-DAP backend tests.
- Full Vitest suite: 299/299 tests passed across 31 files.
- Coverage includes FreeRTOS detection, `rtosInfo`, lazy `evaluate/variables/readMemory`, standard compound variables, foreground Local scheduling, background propagation without control state probes or fixed delay, owner cancellation, Continue invalidation, connection-loss cleanup, structured stale errors, and invalid-address recovery.
- CMSIS-DAP Mock and C++ channel Mock passed. These are protocol and lifecycle evidence only, not hardware acceptance.
- Final independent code review returned no findings. The reviewer performed no hardware operation.

## Build

- `npm run typecheck`: passed.
- `npm test`: passed, 299/299.
- `npm run build`: passed.
- `npm run build:native`: passed for the J-Link and CMSIS-DAP helpers.
- `npm run test:cmsis-dap:mock`: passed.
- `npm run test:cpp-channel:mock`: passed.
- `npm run test:cmsis-dap:algorithm`: passed; algorithm size 1576 bytes.
- `out/native/win32-x64/orbit-cmsis-dap-helper.exe --selftest`: passed, 200 cases, 0 failures.
- `git diff --check`: passed before documentation staging.
- `git status --short -- dist`: clean after the final build.

## Hardware Status

Hardware authorization has not been granted. This stage did not execute reset, halt, run, step, RAM writes, Flash operations, or external firmware changes. No task count, task state, stack usage, runtime count, ABI, optimization, or dynamic-task result is claimed.

`D:\STM32\project\vet6_led\.vscode\launch.json` contains one `Ozone: DAPLink Debug STM32F407VET6` configuration with `rtos: "FreeRTOS"` and the specified HID probe identity. Its existing `flashBeforeDebug: true` remains in place. Starting that configuration would program Flash, so it was not launched during this unauthorized stage. Flash operation count is 0.

DAP-09-HW remains `pending-explicit-authorization`.

## Owner / Routing

`probe: 'cmsis-dap'` remains bound to one CMSIS-DAP helper owner. The selector does not construct a J-Link or legacy owner for this probe. RTOS, Watch, Timeline, RTT, variables, and Memory DAP requests reuse that same owner. Mock owner-lifecycle tests cover helper startup failure, disconnect, replacement cleanup, and the prohibition on J-Link fallback.

## Concurrency and Latency

- Native scheduling order remains `control > watch > timeline > background`.
- RTOS evaluation and lazy expansion are background reads at both the DAP gate and physical owner scheduler.
- Background RTOS evaluate does not schedule target-state control work or the ordinary foreground evaluate's 100 ms delay, including when the DAP request has no `context`.
- Local and Registers remain foreground stopped-state reads and win over queued RTOS refreshes.
- Continue/control aborts the DAP request and passes the same signal into queued owner reads, allowing `NativeScheduler` to cancel them before helper I/O.
- Stop generation, read epoch, connection phase, and handle generation fence stale completions.
- Current timing evidence is unit/Mock only. No hardware latency or long-run stability claim is made.

## Unimplemented / Deferred

- Authorized hardware validation with CMSIS-DAP_LU and `D:\STM32\project\vet6_led`.
- Display and verification of at least three live tasks with name, state, priority, stack usage, and runtime count.
- FreeRTOS version, ABI, compiler optimization, and relevant `FreeRTOSConfig` capture.
- Dynamic task create/delete refresh without reuse of an invalid TCB key.
- Concurrent Watch, Timeline, RTT, RTOS View, and control-latency validation.
- Reset, Continue, and Disconnect cleanup with no stale tasks or residual helper.
- Independent hardware re-verification. DAP-10 MemoryView remains out of scope.

## Commits and Pushes

All listed commits were pushed to `origin/codex/dap09-rtos-view`.

- `d187e06` `test: characterize RTOS View DAP contract`
- `ea41517` `fix: preserve RTOS stopped-state requests`
- `3b2e2dc` `fix: detect FreeRTOS through DAP rtosInfo`
- `352d353` `test: preserve RTOS background read scheduling contract`
- `46bc4ff` `fix: preserve structured memory cancellation errors`
- `0da9b31` `docs: add DAP-09 acceptance evidence`
- `6ca8756` `docs: record final DAP-09 commit`
- `7f645d9` `test: characterize RTOS lazy variable expansion`
- `7505d7d` `fix: lazily expand RTOS DAP variables`
- `5f13806` `docs: update DAP-09 RTOS regression evidence`
- `0304f0c` `test: cover RTOS review regressions`
- `7ef8fe9` `fix: preserve RTOS scheduling and variable contracts`
- `0cd96aa` `test: cover RTOS background scheduling regressions`
- `2397829` `fix: keep RTOS refreshes off the control queue`
- `0172357` `test: cover contextless RTOS background evaluate`
- `f8b963e` `fix: avoid foreground work in RTOS background evaluate`
- `a7b22be` `test: assert contextless RTOS refresh has no delay`

Evidence JSON: `outputs/dap09/20260808-181059/evidence.json`.
