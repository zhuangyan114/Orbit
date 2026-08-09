# DAP-09 CMSIS-DAP RTOS View Acceptance Report

Date: 2026-08-09 19:55 CST
Branch: `codex/dap09-rtos-view`
Verified code head: `b68143c`
Remote head at report preparation: `origin/codex/dap09-rtos-view` at `2d69d95`

Primary evidence:

- Static RTOS/concurrency/control: `outputs/dap09/hardware/2026-08-09-07-44-19/evidence.json`
- Authorized fixture Flash and lifecycle capture: `outputs/dap09/hardware/2026-08-09-09-28-24/lifecycle-evidence.json`
- Formal no-Flash lifecycle measurement: `outputs/dap09/hardware/2026-08-09-11-48-46/lifecycle-evidence.json`
- Hardware adapter/owner replacement: `outputs/dap09/hardware/2026-08-09-11-51-16/replacement-evidence.json`
- Historical/unit evidence: `outputs/dap09/20260809-140832/`

The verified code head is the implementation, harness, and test commit exercised by the final commands in this report. The later report-only publication commit is not described as a separately verified code head because a Git commit cannot contain its own SHA.

## Acceptance Status

**WAITING FOR USER INDEPENDENT ACCEPTANCE (等待用户独立验收)**

All DAP-09 automated and authorized hardware acceptance items in the project plan have evidence. This report does not mark the project plan complete, does not update `docs/bug-fix-log.md`, and does not start DAP-10.

| DAP-09 criterion | Result | Evidence |
| --- | --- | --- |
| At least 3 FreeRTOS tasks with name/state/priority/stack/runtime | pass | 4 tasks and 4/4 runtime cross-checks in `2026-08-09-07-44-19` |
| Dynamic create/delete refresh without stale reused TCB data | pass | 20/20 hardware rounds and 40 raw/evaluate snapshots in `2026-08-09-11-48-46`; 20-generation stale-handle Mock regression |
| RTOS refresh concurrent with Watch/Timeline/RTT while control remains usable | pass | 61.031 s hardware workload in `2026-08-09-07-44-19` |
| Continue/reset/disconnect cleanup | pass | hardware control matrix plus Mock generation/cancellation coverage |
| Session replacement | pass, layered | correlated pending cancellation and hardware adapter/physical-owner replacement in `2026-08-09-11-51-16`; same extension-host identity fence remains Mock evidence |
| ELF, ABI, FreeRTOS version, optimization, and layout basis recorded | pass | this report and retained evidence |

## Root Cause and Fix

FreeRTOS 10.3.1 stores `TCB_t.ulRunTimeCounter` and the application runtime total as 32-bit unsigned counters and provides no overflow protection for runtime statistics.

Orbit previously treated every lower sample as a 32-bit wrap, accumulated synthetic high bits, cached task counters across reads, and forced `ulTotalRunTime` to at least the cached task-counter sum. A normal lower sample therefore became a fabricated value above `UINT32_MAX`. Captured raw hex `0x30DF7F6B`, for example, is `819953515`, but the old decoder published `22294789995` in a later stopped snapshot.

Commit `6e9d8a3` removes runtime wrap extension, cached task-counter synthesis, and total synthesis. Runtime counters now use the DWARF-declared scalar decoder used for other `uint32_t` values. Commit `1852d7e` adds reused-TCB stale-handle coverage across 20 generations.

The final hardware gap was closed with an application-owned deterministic fixture and evidence harnesses:

| File | Key symbols/coverage |
| --- | --- |
| `src/ozone-backend/commander.ts` | `doEvaluateExpression`, `evaluateSingleField`; raw DWARF scalar decoding |
| `src/ozone-backend/commander-realtime-variables.test.ts` | decreasing task/global runtime counters without fabricated wrap |
| `src/debug/dap-session-cmsis-dap.test.ts` | 20 reused-TCB generations and stale `variablesReference` invalidation |
| `scripts/cmsis-dap/verify-dap09-lifecycle-hw.js` | authorized Flash mode and formal `--no-flash` lifecycle mode |
| `scripts/cmsis-dap/verify-dap09-session-replacement-hw.js` | two sequential adapter/owner sessions on one probe |
| `scripts/cmsis-dap/dap09-lifecycle-evidence-validation.js` | owner, helper, Flash, lifecycle, cleanup, and replacement evidence validator |
| `src/dap09-lifecycle-evidence-validation.test.ts` | positive and adverse evidence cases, including no-Flash mode and helper replacement |
| `D:\STM32\project\vet6_led\Core\Src\freertos.c` | external fixture: `Dap09LifecycleTask`, `Dap09LifecycleWorker`, and seven `g_dap09_lifecycle_*` symbols |

No generated `dist/` file or `docs/bug-fix-log.md` file was manually changed. The firmware directory is not a Git repository; independent acceptance depends on the external fixture file and ELF named above.

## ELF and DWARF Basis

| Use | ELF SHA-256 |
| --- | --- |
| Static RTOS/concurrency evidence (`2026-08-09-07-44-19`) | `E62EFE9A1F61B2A3F4A923401D7DE907EF9C067A713C11C248C355209AEFEC44` |
| Dynamic lifecycle fixture (`D:\STM32\project\vet6_led\build\Debug\vet6_led.elf`) | `926CE0B65B6732932F5CA1BA807F4B2329D519F5FF01A28558736268BE179BB8` |

Firmware profile:

- STM32F407VET6, Cortex-M4F hard-float ABI, 32-bit pointers
- FreeRTOS 10.3.1 with CMSIS-RTOS v1
- GCC `arm-none-eabi-gcc` 10.3-2021.10, `-O0 -g3`
- `configGENERATE_RUN_TIME_STATS=1`
- `configUSE_TRACE_FACILITY=1`
- `configSUPPORT_DYNAMIC_ALLOCATION=1`
- runtime clock source `DWT->CYCCNT`

DWARF basis:

| Item | Evidence |
| --- | --- |
| TCB structure | `tskTaskControlBlock` DIE `0xbaa0`, size 100 bytes |
| Typedef chain | `TCB_t@0xbd26 -> tskTCB@0xbd19 -> tskTaskControlBlock@0xbaa0` |
| Runtime member | `ulRunTimeCounter` DIE `0xbb48`, offset 88 |
| Type chain | `uint32_t@0xb607 -> __uint32_t@0xb5a4 -> long unsigned int@0xb5b0` |
| Scalar/alignment | 4-byte unsigned; AAPCS natural 4-byte alignment; `88 mod 4 = 0` |

## Runtime Counter Cross-Check

The pre-fix halted artifact `outputs/dap09/20260809-131254/stopped-tcb-raw.json` preserves the conversion defect:

| Task | Captured hex | Independent `uint32_t` | Old published decimal |
| --- | --- | ---: | ---: |
| `defaultTask` | `0x00000000` | 0 | 4294967296 |
| `myTask02` | `0x185A7721` | 408581921 | 8998516513 |
| `rttBench` | `0x30DF7F6B` | 819953515 | 22294789995 |
| `IDLE` | `0xE8CCF32A` | 3905745706 | 12495680298 |

The post-fix synchronized hardware snapshot in `2026-08-09-07-44-19` matched DAP evaluation against direct 4-byte `readMemory` and independent little-endian decoding:

| Task | Field address | Evaluate | Direct bytes | Independent `uint32_t` |
| --- | --- | ---: | --- | ---: |
| `defaultTask` | `0x20000798` | 0 | `00 00 00 00` | 0 |
| `myTask02` | `0x20000A10` | 99949563 | `FB 1B F5 05` | 99949563 |
| `rttBench` | `0x20000E88` | 3103722348 | `6C 0B FF B8` | 3103722348 |
| `IDLE` | `0x20003EB0` | 713360962 | `42 06 85 2A` | 713360962 |

Percentages are valid only as `taskRawUint32 / totalRawUint32 * 100` when both values are from the same halted snapshot, total is non-zero, and no runtime timer overflow occurred. Orbit does not invent a counter epoch after overflow.

## Dynamic Task Lifecycle

Hardware result: **PASS, 20/20**.

The fixture exposes these ELF symbols at `0x200040DC` through `0x200040F4`: round, phase, create count, delete count, live flag, worker counter, and worker TCB pointer. It creates `dap09Dyn01` through `dap09Dyn20`, keeps each task observable for 250 ms, deletes it, and exposes a 250 ms deletion window.

Flash and formal measurement are separate evidence stages:

| Stage | Evidence | `flashBeforeDebug` | Flash operations | Result |
| --- | --- | --- | ---: | --- |
| Authorized fixture Flash | `2026-08-09-09-28-24` | true | 13 | 20/20 and Flash verify pass |
| Formal lifecycle measurement | `2026-08-09-11-48-46` | false | 0 | 20/20 pass after one DAP `restart`; 40/40 scalar blocks match |

Formal measurement details:

- exactly one owner `cmsis-dap`, adapter PID 31196, helper PID 32660, zero owner processes after disconnect
- 20 created and 20 deleted phases; final create/delete counts 20/20
- task names exactly `dap09Dyn01` through `dap09Dyn20`
- allocator reused TCB `0x20001520` in all 20 rounds
- `uxTCBNumber` changed for each new instance: 6, 8, ..., 44
- each created snapshot had a non-zero worker TCB pointer and rising worker counter; cross-round counters never regressed
- each deleted snapshot had `g_dap09_lifecycle_worker_tcb=0`, `workerTcbPointer=null`, and no active task
- every created/deleted snapshot detected FreeRTOS and returned 7 `pxReadyTasksLists` root variables through standard DAP `evaluate`/`variables`
- every snapshot also captured one contiguous 28-byte `readMemory` block for the seven fixture scalars; 40/40 base64 blocks, field addresses, 4-byte hex values, and independent little-endian decodes matched all 320 stopped `evaluate` values
- 157 running `watchEvaluate` polls, 40 `rtosInfo`, 320 stopped `evaluate`, 40 `variables`, and 100 `readMemory` requests
- one reset/restart, 41 continue, 41 pause, one disconnect; no target-memory write, breakpoint, Option Bytes, Flash, or second owner
- validator result `ok=true`, zero violations and zero harness errors

The Mock lifecycle regression remains complementary evidence: 20 generations reuse TCB address `0x20005000`; each transition invalidates the previous handle, and an old `variablesReference` returns an empty list rather than current task data. Every new handle is checked against that generation's task name, `uxTCBNumber`, state, priority, stack base/top/end, and runtime counter, so reused addresses cannot inherit the previous generation's fields.

## Concurrency and Control Latency

The 61.031 s hardware workload in `2026-08-09-07-44-19` used eight Watch expressions, three Timeline expressions, RTT buffer 1, and 60 RTOS refresh requests through one CMSIS-DAP owner.

- Watch: 91/91 data responses; latency P50/P95/max 508/1595/1613 ms
- Timeline: 54 events, 183 points for `uwTick`, `xTickCount`, and `aww`
- RTT: 124 reads, 110 non-empty, 443520 bytes, zero overrun
- RTOS refresh: 60 requests, 88.3% success; 7 expected stale/cancelled around control transitions, zero gate-unavailable, zero unrelated errors

| Control | Attempts | Success | P50 | P95 | Max |
| --- | ---: | ---: | ---: | ---: | ---: |
| Continue/Pause | 9 | 9/9 | 257 ms | 599 ms | 599 ms |
| Instruction Step | 3 | 3/3 | 635 ms | 641 ms | 641 ms |
| Reset/Halt | 2 | 2/2 | 552 ms | 641 ms | 641 ms |

Control P95 remained below the 1200 ms target-read gate bound. Mock scheduler coverage separately preserves `control > watch > timeline > background`, cancellation, coalescing, and resume behavior.

## Session Replacement and Cleanup

Hardware adapter/physical-owner replacement result: **PASS** in `2026-08-09-11-51-16`.

| Session | Adapter PID | Helper PID | Owner | Pending target result | Disconnect/exit | Forced kill | Residual owner processes |
| --- | ---: | ---: | --- | --- | --- | --- | ---: |
| First | 22772 | 33152 | `cmsis-dap` | seq 5 Watch completed; pending seq 6 RTOS cancelled as `TargetReadCancelled` | pass / code 0 | no | 0 |
| Second | 25336 | 37748 | `cmsis-dap` | `rtosInfo.detected=true` | pass / code 0 | no | 0 |

Both sessions used VID `C251`, PID `F001`, serial `LU_2022_8888`, HID, 1000 kHz, and `flashBeforeDebug:false`. Disconnect began with real pending requests seq 5 `watchEvaluate` and seq 6 `rtosInfo`; trace response `request_seq=6` carries `TargetReadCancelled`. The second session started only after first-session cleanup and used a new helper PID. The strengthened validator rejects a wrong owner, multiple/missing helpers, helper PID reuse, a cancellation unrelated to the captured pending set, non-zero adapter exit, forced kill, failed disconnect/termination, residual processes, or unexpected owner logs; the retained evidence passes those checks.

Scope boundary: this hardware run proves sequential DAP adapter process replacement and physical-owner cleanup/reacquisition. It does not by itself prove the same VS Code extension-host `DebugSession` identity generation fence. That in-process identity fence, stale async completion suppression, handle invalidation, and owner-loss behavior remain covered by Mock tests. The two layers together cover the original acceptance requirement; this report does not overstate the hardware layer.

| Transition | Mock | Hardware | Result |
| --- | --- | --- | --- |
| Continue | pass | 9/9 plus lifecycle controls | stale read epoch/handles are not published |
| Reset/restart | pass | 2/2 plus formal lifecycle restart | controller, gate, timers, and RTOS reads recover |
| Disconnect | pass | all formal runs pass | selected owner disposed; zero residual helper |
| Session replacement | same-process identity fence pass | adapter/physical owner pass | layered acceptance as scoped above |
| Owner loss | pass | not manufactured by design | terminates without J-Link fallback or stale publication |

## Owner and No-Fallback Evidence

| Capture | Helper PID(s) | Owner(s) | J-Link/OpenOCD/GDB | Second concurrent owner |
| --- | --- | --- | --- | --- |
| Static concurrency `2026-08-09-07-44-19` | 33632 | `cmsis-dap` | none | none |
| Fixture Flash `2026-08-09-09-28-24` | 17544 | `cmsis-dap` | none | none |
| Formal lifecycle `2026-08-09-11-48-46` | 32660 | `cmsis-dap` | none | none |
| Replacement `2026-08-09-11-51-16` | 33152, then 37748 | `cmsis-dap`, sequential | none | none |

No J-Link DLL/legacy fallback, `JLink.exe`, OpenOCD, GDB server, extension-host backend fallback, or second CMSIS-DAP helper was observed. Hardware logs record HID reports 65/65, report ID 0, protocol packet size 64, and DPIDR/target-control traffic.

Formal helper hashes after `npm run build:native`:

- CMSIS-DAP helper: `3EBB4B29674C003DBEF621DC1F99EF46D5E8B95095D4A9C8A7836A2A13A8CFF6`
- J-Link helper: `31501F82FDC4AEF7187B879FCEA558C75F2AA6AE6A1C85F5D5792CAD3CEF5406`

## Verification Matrix

The following final verification rows are filled only from fresh commands run against the verified code head:

| Command | Result |
| --- | --- |
| focused RTOS/CMSIS-DAP/validator Vitest command | 7 files, 134/134 pass |
| `npx vitest run src/dap09-lifecycle-evidence-validation.test.ts` | 19/19 pass |
| `npm run typecheck` | pass |
| `npm test` | 34 files, 335/335 pass |
| `npm run build` | pass; extension/webview/debugadapter/timeline/watch bundles |
| `npm run build:native` | pass; both formal helpers and Flash algorithm rebuilt |
| `npm run test:cmsis-dap:mock` | pass; full mock smoke matrix |
| `npm run test:cpp-channel:mock` | pass |
| `npm run test:cmsis-dap:algorithm` | pass; 1576 bytes |
| `out/native/win32-x64/orbit-cmsis-dap-helper.exe --selftest` | 200 cases, 0 failures |
| lifecycle/replacement/Flash offline validation | all pass, zero violations; Flash has 13 operations |
| validator and both new harnesses `node --check` | pass |
| firmware `cmake --build build/Debug --parallel` | pass; no work to do; ELF hash and seven fixture symbols rechecked |
| `git diff --check` | pass |
| `git status --short -- dist` | clean |

Unit and Mock results are not hardware evidence.

## Hardware Mutation Record

All mutations below were within the user's explicit authorization for `D:\STM32\project\vet6_led` and the connected target.

Captured Flash operations:

| Evidence group | Runs | Init | Erase sector | Program page | Verify | Uninit | Total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Earlier VS Code fixture sessions | 2 | 2 | 6 | 8 | 8 | 2 | 26 |
| Lifecycle attempts `09-17-14` through `09-28-24` | 5 | 5 | 15 | 20 | 20 | 5 | 65 |
| Formal lifecycle and replacement runs | 8 | 0 | 0 | 0 | 0 | 0 | 0 |
| Total known DAP-09 Flash activity | 15 | 7 | 21 | 28 | 28 | 7 | 91 |

Each Flash lifecycle run used the same current CMSIS-DAP owner and completed 13 successful stages: init 1, eraseSector 3, programPage 4, verify 4, uninit 1. Failures in early lifecycle runs were evidence-harness interpretation/snapshot failures after successful Flash, not Flash failures.

Other target mutations:

- static concurrency run: 9 Continue/Pause cycles, 3 instruction steps, and 2 Reset/Halt cycles
- lifecycle Flash runs: launch/reset/run plus pause/continue snapshot controls; the successful Flash evidence contains 41 continue and 41 pause requests
- final formal lifecycle: one no-Flash DAP restart, 41 continue, 41 pause
- replacement attempts: sequential no-Flash sessions, each with continue and disconnect controls; all retained attempts used zero Flash
- target-memory writes: 0
- breakpoint writes: 0
- Option Bytes operations: 0

## Retained Failed Evidence

Failures are preserved and not overwritten by later success:

| Evidence | Observed failure | Decision |
| --- | --- | --- |
| `2026-08-09-09-17-14` | ordinary running `evaluate` returned running/unavailable; 0 rounds | harness changed to running `watchEvaluate` |
| `2026-08-09-09-21-05` | zero-address string normalization falsely marked a deleted task active | harness parser corrected |
| `2026-08-09-09-22-31` | Watch slices crossed lifecycle transitions; counter mismatch at round 16 | stopped-state counters captured in one snapshot |
| `2026-08-09-09-26-14` | same cross-time issue remained at round 17 | final snapshot method corrected |
| `2026-08-09-09-31-18` | second-session `rtosInfo` cancelled by premature disconnect | harness waits for result before disconnect |
| `2026-08-09-09-33-26` | hardware behavior passed but summary omitted `disconnectOk` alias | evidence schema corrected |
| `2026-08-09-11-05-34` | no-Flash launch retained completed SRAM state; skipped-Flash diagnostic miscounted | formal mode now performs one DAP restart and counts only structured Flash operation lines |
| `2026-08-09-11-49-24` | both pending reads were required to cancel even though seq 5 completed normally and seq 6 correctly returned `TargetReadCancelled` | validator corrected to require at least one captured pending target seq with a matching cancellation; evidence retained |

The earlier successful no-Flash `2026-08-09-11-08-06` and replacement `2026-08-09-10-57-35` captures are retained but superseded as primary evidence because they predate the raw scalar block and adapter-exit/forced-kill schema.

## Independent Acceptance Procedure

1. Check out the reported verified code head on `codex/dap09-rtos-view`; confirm the external fixture ELF hash is `926CE0B6...179BB8`.
2. Run the full Verification Matrix and confirm all exit codes are zero.
3. Re-run the offline validators against `2026-08-09-11-48-46` and `2026-08-09-11-51-16`; both violation arrays must be empty. Separately run the Flash validator against the 13 structured operation lines in `2026-08-09-09-28-24`.
4. With separate hardware authorization, run `node scripts/cmsis-dap/verify-dap09-lifecycle-hw.js --hardware --no-flash`; require 20/20 rounds, one helper, zero Flash, zero unexpected owners, successful disconnect, and zero residual processes.
5. With separate hardware authorization, run `node scripts/cmsis-dap/verify-dap09-session-replacement-hw.js --hardware`; require a captured pending target request seq with a same-seq `TargetReadCancelled`, two different sequential helper PIDs, both adapter exit codes 0, no forced kill, second-session RTOS detection, and zero residual processes.
6. Review the failure directories above as retained negative history rather than excluding them from the evidence set.

## Remaining Gaps and Stop Point

There are no remaining automated or authorized-hardware blockers for DAP-09. The only remaining action is the user's independent acceptance decision. The hardware session-replacement evidence has the explicit process/owner scope described above; same extension-host session identity behavior remains Mock-covered rather than overstated as hardware-proven.

DAP-09 is therefore **waiting for user independent acceptance**, not self-declared complete. The project plan and `docs/bug-fix-log.md` remain unchanged. DAP-10 has not been started.

## Commits and Push Status

- `6e9d8a3` `fix: preserve raw FreeRTOS runtime counters`
- `1852d7e` `test: cover reused RTOS task lifecycles`
- `2d69d95` `docs: add DAP-09 hardware acceptance harness`
- `ea1aa1a` `docs: design DAP-09 dynamic lifecycle acceptance`
- `b68143c` `test: close DAP-09 lifecycle hardware acceptance` (final verified implementation/harness commit)
- report publication commit: recorded by Git after this file is committed

Push status: pending report-only commit and push to `origin/codex/dap09-rtos-view`.
