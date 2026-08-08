# DAP-09 CMSIS-DAP RTOS View Acceptance Report

Date: 2026-08-08 16:29 CST
Branch: `codex/dap09-rtos-view`
Target profile: STM32F407VET6, CMSIS-DAP_LU (`C251:F001`, `LU_2022_8888`), wired CMSIS-DAP HID, FreeRTOS 10.3.1 with CMSIS-RTOS v1 wrapper.

## Code Review

- `initialize` advertises the standard RTOS/read-memory capabilities and `rtosInfo` now probes `uxCurrentNumberOfTasks` through the active owner.
- RTOS View's observed chain is covered: `stackTrace` -> `evaluate` -> `variables`/`variablesReference` -> byte-oriented `readMemory`.
- `Continue`, Pause, Step, Restart, breakpoint control, Reset, disconnect, and connection-loss paths advance the read epoch. Active evaluate, stopped-state, and RTOS memory reads receive cancellation and stale results are not published.
- Variable handles are cleared when control begins, so a pre-control `variablesReference` tree cannot be expanded after Continue.
- CMSIS-DAP memory reads use the background scheduler priority and preserve `errorCode`, `targetState`, `elapsedMs`, and `diagnostics`.
- No OpenOCD, GDB server, J-Link executable, second target owner, or generated `dist/` edit was introduced.

## Unit / Mock

- Focused DAP-09 set: 93/93 tests passed across the five required test files.
- Full Vitest suite: 288/288 tests passed (31 files).
- New characterization and regression coverage includes FreeRTOS `rtosInfo`, expandable variables, byte-oriented memory, stale variable trees, and cancellation of an in-flight RTOS `readMemory` on Continue.
- CMSIS-DAP owner tests cover single-owner routing, no J-Link fallback, helper disposal, disconnect, structured invalid/error responses, and scheduler/control behavior.

## Build

- `npm run typecheck`: passed.
- `npm run build`: passed.
- `npm run build:native`: passed for J-Link and CMSIS-DAP helpers.
- `npm run test:cmsis-dap:mock`: passed.
- `npm run test:cpp-channel:mock`: passed.
- `npm run test:cmsis-dap:algorithm`: passed.
- `out/native/win32-x64/orbit-cmsis-dap-helper.exe --selftest`: `selftest=ok`, 200 cases, 0 failures.
- `git diff --check`: passed; `git status --short -- dist`: clean.

## Hardware Status

真机门禁未授权，因此本阶段没有执行 reset、halt、run、step、RAM 写、Flash 或外部固件修改。没有伪造任务数量、任务状态、栈使用或运行计数结果。DAP-09-HW 仍待用户明确授权后执行。

## Owner / Routing

`probe: 'cmsis-dap'` remains bound to the unique CMSIS-DAP helper owner. The selector does not construct a J-Link or legacy owner for this probe. The existing owner lifecycle tests pass, including helper failure/disconnect cleanup and no residual owner.

## Concurrency and Latency

- Control requests have priority over Watch, Timeline, RTT background, and RTOS background reads.
- RTOS reads are gated and cancellable; generation changes prevent stale completions from reaching DAP clients.
- The full suite and helper selftest provide mock timing evidence only; no hardware latency claim is made.

## Unimplemented / Deferred

- Hardware acceptance with the specified CMSIS-DAP_LU probe and `D:\STM32\project\vet6_led` is not complete pending authorization.
- At least three live FreeRTOS tasks, TCB reuse after create/delete, stack high-water marks, and runtime counters require the authorized hardware run and a real DAP trace.
- FreeRTOS version/ABI/optimization/`FreeRTOSConfig` capture and independent re-verification remain open.
- This work stops at DAP-09; MemoryView-specific expansion is not part of this phase.

## Commits and Pushes

- `d187e06` `test: characterize RTOS View DAP contract` (pushed).
- `ea41517` `fix: preserve RTOS stopped-state requests` (pushed).
- `3b2e2dc` `fix: detect FreeRTOS through DAP rtosInfo` (pushed).
- `352d353` `test: preserve RTOS background read scheduling contract` (pushed).

Evidence JSON: `outputs/dap09/20260808-162903/evidence.json`.
