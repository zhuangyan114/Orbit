# DAP-09 CMSIS-DAP RTOS View Acceptance Report

Date: 2026-08-08 17:46 CST
Branch: `codex/dap09-rtos-view`
Target profile: STM32F407VET6, CMSIS-DAP_LU (`C251:F001`, `LU_2022_8888`), wired CMSIS-DAP HID, FreeRTOS 10.3.1 with CMSIS-RTOS v1 wrapper.

## Code Review

- `initialize` advertises the standard RTOS/read-memory capabilities and `rtosInfo` now probes `uxCurrentNumberOfTasks` through the active owner.
- RTOS View's observed chain is covered: `stackTrace` -> `evaluate` -> `variables`/`variablesReference` -> byte-oriented `readMemory`.
- The post-acceptance hardware observation was `FreeRTOS detected` followed by `Failed to get variable reference for pxReadyTasksLists` and `Unable to collect full RTOS information`; Local and Registers also stalled while `rtos` was enabled. The failure was traced to a successful DAP evaluate response with `variablesReference: 0` after gate timeout and eager recursive expansion of FreeRTOS lists.
- RTOS compound evaluates now start collapsed with `expandedExpressions: []`. Each `variables` request expands one requested DAP path, preserves a non-zero handle for unloaded compound children, and caches children within the same stop generation.
- `Continue`, Pause, Step, Restart, breakpoint control, Reset, disconnect, and connection-loss paths advance the read epoch. Active evaluate, stopped-state, and RTOS memory reads receive cancellation and stale results are not published.
- Variable handles are cleared when control begins, and active lazy RTOS expansion receives an abort signal, so a pre-control `variablesReference` tree cannot publish after Continue.
- RTOS evaluate and lazy expansion use background priority. Local and Registers retain foreground priority and are granted first when both are queued.
- Gate timeout and backend failures are failed DAP responses preserving `errorCode`, `targetState`, `elapsedMs`, and `diagnostics`; they are not successful zero-reference values.
- No OpenOCD, GDB server, J-Link executable, second target owner, or generated `dist/` edit was introduced.

## Unit / Mock

- Focused DAP-09 set: 97/97 tests passed across the five required test files.
- Full Vitest suite: 292/292 tests passed (31 files).
- Red/green evidence: the new contract tests initially failed in two places (`variablesReference` was zero; no RTOS background expansion was scheduled), then the focused four-file set passed 78/78 after the fix.
- New characterization and regression coverage includes one-level RTOS expansion, stable compound references, foreground Local scheduling, structured gate timeout, and cancellation of an active lazy RTOS expansion on Continue.
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

`D:\STM32\project\vet6_led\.vscode\launch.json` now has one `Ozone: DAPLink Debug STM32F407VET6` entry with FreeRTOS and the HID probe identity. The duplicate RTOS-only entry was removed. Its existing `flashBeforeDebug: true` value was preserved; this acceptance run did not launch that configuration and performed zero Flash operations.

## Owner / Routing

`probe: 'cmsis-dap'` remains bound to the unique CMSIS-DAP helper owner. The selector does not construct a J-Link or legacy owner for this probe. The existing owner lifecycle tests pass, including helper failure/disconnect cleanup and no residual owner.

## Concurrency and Latency

- Control requests have priority over Watch, Timeline, RTT background, and RTOS background reads.
- RTOS reads are split into one DAP expansion level per background critical section. Foreground Local/Registers requests win when queued, while control cancels an active RTOS expansion.
- Stop generation and read epoch are stored with lazy handles; generation changes prevent stale completions from reaching DAP clients.
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
- `46bc4ff` `fix: preserve structured memory cancellation errors` (pushed).
- `0da9b31` `docs: add DAP-09 acceptance evidence` (pushed).
- `6ca8756` `docs: record final DAP-09 commit` (pushed).
- `7f645d9` `test: characterize RTOS lazy variable expansion` (pushed).
- `7505d7d` `fix: lazily expand RTOS DAP variables` (pushed).

Evidence JSON: `outputs/dap09/20260808-174640/evidence.json`.
