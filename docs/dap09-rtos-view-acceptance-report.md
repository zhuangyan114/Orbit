# DAP-09 CMSIS-DAP RTOS View Acceptance Report

Date: 2026-08-09 15:40 CST
Branch: `codex/dap09-rtos-view`
Verified implementation head: `1852d7e91db5079d2b2a3723f1c59946e8dd43a6`
Remote implementation head: `origin/codex/dap09-rtos-view` at `1852d7e91db5079d2b2a3723f1c59946e8dd43a6`
Evidence set: `outputs/dap09/20260809-140832/` (historical/unit) and `outputs/dap09/hardware/2026-08-09-07-44-19/` (current hardware)

The verified implementation head is the code and test commit exercised by the commands in this report. The documentation commit that contains this report is recorded separately by Git because a commit cannot contain its own SHA.

## Acceptance Status

**PARTIAL, NOT ACCEPTED**

Code review, unit/Mock tests, TypeScript/native builds, helper mocks, the Flash algorithm check, and the formal CMSIS-DAP helper selftest pass. The runtime-counter defect has a focused regression fix, and a 20-generation reused-TCB Mock test covers stale handle invalidation.

The authorized static-firmware hardware workload now passes: one CMSIS-DAP HID owner, no Flash or target-memory writes, a synchronized RTOS snapshot, 60.989 seconds of Watch/Timeline/RTT/RTOS concurrency, control latency, and disconnect cleanup. DAP-09 remains partial because the firmware has no authorized dynamic create/delete fixture and hardware session replacement was not manufactured.

## Root Cause and Fix

FreeRTOS 10.3.1 stores both `TCB_t.ulRunTimeCounter` and the application runtime total as 32-bit unsigned counters. Its source explicitly provides no overflow protection for runtime statistics.

Orbit previously treated every lower sample as a 32-bit wrap, accumulated synthetic high bits, cached task counters across reads, and forced `ulTotalRunTime` to at least the cached task-counter sum. A normal lower sample therefore became a fabricated value above `UINT32_MAX`. For example, captured raw hex `0x30DF7F6B` represents `819953515`, but the old decoder published `22294789995` in the later stopped snapshot.

Commit `6e9d8a3` removes `runtimeCounterWraps`, `runtimeTaskCounters`, wrap extension, and total synthesis. Runtime counters now use the same DWARF-declared scalar decoder as other `uint32_t` values.

Changed files and key symbols:

| File | Symbol/coverage | Change |
| --- | --- | --- |
| `src/ozone-backend/commander.ts` | `doEvaluateExpression`, `evaluateSingleField` | Removed runtime-counter special formatting and retained normal DWARF scalar decoding. |
| `src/ozone-backend/commander-realtime-variables.test.ts` | runtime counter tests | Covers a TCB field decreasing across samples and a decreasing global total without synthetic wrap extension. |
| `src/debug/dap-session-cmsis-dap.test.ts` | reused-TCB lifecycle test | Covers 20 generations at one TCB address and invalidates every old `variablesReference`. |

No `dist/` file or `docs/bug-fix-log.md` file was manually changed.

## ELF and DWARF Basis

Target ELF: `D:\STM32\project\vet6_led\build\Debug\vet6_led.elf`
SHA-256: `E62EFE9A1F61B2A3F4A923401D7DE907EF9C067A713C11C248C355209AEFEC44`

Firmware profile:

- FreeRTOS 10.3.1 with CMSIS-RTOS v1
- GCC `arm-none-eabi-gcc` 10.3-2021.10, `-O0 -g3`
- Cortex-M4F hard-float ABI, 32-bit pointers
- `configGENERATE_RUN_TIME_STATS=1`
- `configUSE_TRACE_FACILITY=1`
- `configSUPPORT_DYNAMIC_ALLOCATION=1`
- runtime clock source `DWT->CYCCNT`

DWARF proves the layout without guessing:

| Item | DWARF evidence |
| --- | --- |
| TCB structure | `tskTaskControlBlock` DIE `0xbaa0`, size 100 bytes |
| Typedef chain | `TCB_t@0xbd26 -> tskTCB@0xbd19 -> tskTaskControlBlock@0xbaa0` |
| Runtime member | `ulRunTimeCounter` DIE `0xbb48`, offset 88 |
| Type chain | `uint32_t@0xb607 -> __uint32_t@0xb5a4 -> long unsigned int@0xb5b0` |
| Scalar type | 4 bytes, unsigned encoding |
| Alignment | AAPCS natural 4-byte alignment; `88 mod 4 = 0` |

## Runtime Counter Cross-Check

The historical halted snapshot at `outputs/dap09/20260809-131254/stopped-tcb-raw.json` predates the fix. It preserves raw low-32-bit hex alongside the old synthesized decimal. Independent little-endian decoding gives:

| Task | TCB | Field | Captured hex | LE bytes derived from hex | Independent `uint32_t` | Old published decimal |
| --- | --- | --- | --- | --- | ---: | ---: |
| `defaultTask` | `0x20000740` | `0x20000798` | `0x00000000` | `00 00 00 00` | 0 | 4294967296 |
| `myTask02` | `0x200009B8` | `0x20000A10` | `0x185A7721` | `21 77 5A 18` | 408581921 | 8998516513 |
| `rttBench` | `0x20000E30` | `0x20000E88` | `0x30DF7F6B` | `6B 7F DF 30` | 819953515 | 22294789995 |
| `IDLE` | `0x20003E58` | `0x20003EB0` | `0xE8CCF32A` | `2A F3 CC E8` | 3905745706 | 12495680298 |

The same snapshot records total hex `0x35F50E85`, which independently decodes to `905252485` and already matched its decimal value.

The stopped trace proves whole-TCB CMSIS-DAP reads, but it does not retain separate raw DAP `readMemory` response payload bytes for these four fields. Therefore this table is a valid diagnosis of the old conversion defect, not the required post-fix hardware acceptance cross-check.

Percentage basis is now explicit: `taskRawUint32 / totalRawUint32 * 100`, only when both values come from the same halted snapshot, total is non-zero, and no runtime timer overflow has occurred. Orbit must not invent a counter epoch after overflow.

Post-fix unit evidence passes in `src/ozone-backend/commander-realtime-variables.test.ts` (23/23 within that file). The current hardware snapshot passes the same-snapshot contract: `rtosInfo.detected=true`, `evaluate(pxReadyTasksLists)` returned `variablesReference=1000`, `variables` returned 7 list entries, and all four task runtime counters matched direct 4-byte `readMemory` values and independent little-endian `uint32_t` decoding.

Current hardware runtime-counter cross-check (`outputs/dap09/hardware/2026-08-09-07-44-19/evidence.json`):

| Task | Field address | Evaluate | Direct bytes | Independent `uint32_t` | Cross-check |
| --- | --- | ---: | --- | ---: | --- |
| `defaultTask` | `0x20000798` | 0 | `00 00 00 00` | 0 | pass |
| `myTask02` | `0x20000A10` | 99949563 | `FB 1B F5 05` | 99949563 | pass |
| `rttBench` | `0x20000E88` | 3103722348 | `6C 0B FF B8` | 3103722348 | pass |
| `IDLE` | `0x20003EB0` | 713360962 | `42 06 85 2A` | 713360962 | pass |

The same snapshot recorded four task names, priorities, stack base/top/end, stack usage, `uxTCBNumber`, and states: `defaultTask=Blocked`, `myTask02=Blocked`, `rttBench=Running`, `IDLE=Ready`.

## Dynamic Task Lifecycle

Mock result: **PASS**.

Commit `1852d7e` adds 20 generations at reused TCB address `0x20005000`. Every control transition clears the previous handle; querying the old `variablesReference` returns an empty list. The new reference exposes only the current task name, `uxTCBNumber`, and `ulRunTimeCounter`. Final state is `stopGeneration=19`, one current handle, and zero backend target calls.

Separate tests cover a result that starts before Continue or owner loss and returns afterward; stale children, evaluate results, and memory results are not published.

Hardware result: **NOT RUN**. The current firmware contains static tasks only. Real acceptance still requires an authorized fixture build/Flash and 20 create/delete/refresh cycles, including a reused allocator address if one occurs.

## Concurrency and Control Latency

Mock scheduler result: **PASS**. Focused coverage preserves `control > watch > timeline > background`, prevents Timeline starvation of control, pauses Watch/Timeline/background for the complete control critical section, restores them on success/error, and cancels queued or in-flight RTOS work when control begins.

Historical read-only hardware baselines remain useful but are not control benchmarks:

| Evidence | Duration | Frames | Read errors | Control P50/P95/max |
| --- | ---: | ---: | ---: | --- |
| `outputs/dap09/20260809-130446/evidence.json` | 60 s | 39 | 0 | not measured |
| `outputs/dap09/20260809-133000/evidence.json` | 60 s | 40 | 0 | not measured |

Current hardware workload (`outputs/dap09/hardware/2026-08-09-07-44-19/evidence.json`) ran 61.031 seconds with eight Watch expressions, three Timeline expressions, RTT buffer 1 polling, and 60 RTOS refresh requests. Watch data success was 91/91; Timeline produced 54 events and 183 points for `uwTick`, `xTickCount`, and `aww`; RTT produced 124 reads (110 non-empty, 443520 bytes, zero overrun). RTOS refresh success was 88.3% (the remaining 7 requests were stale/cancelled around control transitions), with zero gate-unavailable and zero unrelated errors.

| Control | Attempts | Success | P50 | P95 | Max |
| --- | ---: | ---: | ---: | ---: | ---: |
| Continue/Pause | 9 | 9/9 | 257 ms | 599 ms | 599 ms |
| Instruction Step | 3 | 3/3 | 635 ms | 641 ms | 641 ms |
| Reset/Halt (`restart` to `osKernelStart`) | 2 | 2/2 | 552 ms | 641 ms | 641 ms |

Watch latency was P50 508 ms, P95 1595 ms, max 1613 ms. The trace recorded 7 stale-result cancellations and no target-read-gate-unavailable responses.

## State and Cleanup Matrix

| Transition | Mock | Hardware | Verified behavior at Mock layer |
| --- | --- | --- | --- |
| Continue | pass | pass (9/9) | advances read epoch, aborts RTOS work, clears stale handles/results |
| Reset | pass | pass (2/2) | cancels RTOS work and releases controller/gate/timers |
| Disconnect | pass | pass | cancels reads and disposes the selected owner |
| Session replacement | pass | not run | invalidates the old session generation and handles |
| Owner loss | pass | not run by design | terminates without J-Link fallback or stale publication |

Mock assertions cover the RTOS `AbortController`, gate waiters, waiter timers, drain timer, target-read flag, variable handles, and stale-result fences. `session-target-channel.test.ts` also covers symmetric CMSIS-DAP `DAP_Disconnect -> close -> helper exit` ordering.

The synchronized hardware disconnect returned success and the post-disconnect process snapshot contained zero Orbit owner processes. Session replacement was not run; the Mock generation fence remains the evidence for that transition.

## Owner and No-Fallback Evidence

Historical hardware evidence recorded one CMSIS-DAP HID owner:

| Capture | Helper PID | Owner | J-Link involved | Second owner |
| --- | ---: | --- | --- | --- |
| `outputs/dap09/20260809-130446/owner-process.json` | 6224 | `cmsis-dap` | false | false |
| `outputs/dap09/20260809-133000/owner-process.json` | 30564 | `cmsis-dap` | false | false |
| `outputs/dap09/hardware/2026-08-09-07-44-19/evidence.json` | 33632 | `cmsis-dap` | false | false |

No OpenOCD, GDB server, `JLink.exe`, legacy fallback, extension-host backend fallback, or second CMSIS-DAP helper was observed. Mock selection and loss tests independently enforce the same contract.

The formal helper paths were rebuilt after confirming no active helper process:

- CMSIS-DAP helper SHA-256: `3EBB4B29674C003DBEF621DC1F99EF46D5E8B95095D4A9C8A7836A2A13A8CFF6`
- J-Link helper SHA-256: `31501F82FDC4AEF7187B879FCEA558C75F2AA6AE6A1C85F5D5792CAD3CEF5406`

## Verification Matrix

All commands below were run after commit `1852d7e` and exited 0:

| Command | Result |
| --- | --- |
| focused six-file Vitest command | 6 files, 128/128 tests |
| `npm run typecheck` | pass |
| `npm test` | 32 files, 313/313 tests |
| `npm run build` | pass |
| `npm run build:native` | pass; both formal helpers replaced |
| `npm run test:cmsis-dap:mock` | pass |
| `npm run test:cpp-channel:mock` | pass |
| `npm run test:cmsis-dap:algorithm` | pass; 1576 bytes |
| `out/native/win32-x64/orbit-cmsis-dap-helper.exe --selftest` | 200 cases, 0 failures |
| `npx vitest run src/dap09-evidence-validation.test.ts` | 3/3 pass |
| `node --check scripts/cmsis-dap/verify-dap09-rtos-hw.js` | pass |
| `git diff --check` | pass |
| `git status --short -- dist` | clean |

Unit and Mock results are not hardware evidence.

## Hardware Mutation Record

This continuation performed **zero** hardware operations: no target connection, Flash, reset, halt, run, step, breakpoint, or RAM write.

The two earlier VS Code launch sessions each recorded 13 CMSIS-DAP Flash operations before the read-only recording began:

| Session | Init | Erase sector | Program page | Verify | Uninit | Total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `20260809-130446` | 1 | 3 | 4 | 4 | 1 | 13 |
| `20260809-133000` | 1 | 3 | 4 | 4 | 1 | 13 |
| Total known | 2 | 6 | 8 | 8 | 2 | 26 |

The current authorized run issued only Reset/Halt/Run/Continue/Pause/Step and target reads. It issued zero Flash, erase, program, verify, breakpoint, option-byte, or target-memory-write operations. The helper log records VID `C251`, PID `F001`, serial `LU_2022_8888`, HID reports 65/65, report ID 0, protocol packet size 64, and DPIDR/target-control traffic.

## Remaining Acceptance Gaps

1. Build and Flash an explicitly authorized dynamic task fixture, then record 20 real create/delete/refresh cycles and stale TCB cleanup.
2. Manufacture a hardware session replacement case, or retain the Mock-only evidence with an explicit risk decision.

Until the dynamic lifecycle and session-replacement decisions are independently closed, DAP-09 remains **PARTIAL, NOT ACCEPTED**. The static-firmware hardware workload and synchronized runtime-counter cross-check are now accepted evidence. DAP-10 is out of scope and has not been started.

## Commits and Push Status

- `6e9d8a3` `fix: preserve raw FreeRTOS runtime counters`
- `1852d7e` `test: cover reused RTOS task lifecycles`

The DAP-09 hardware harness and validator are added in this documentation/acceptance commit: `scripts/cmsis-dap/verify-dap09-rtos-hw.js`, `scripts/cmsis-dap/dap09-evidence-validation.js`, and `src/dap09-evidence-validation.test.ts`.

Both implementation commits are pushed to `origin/codex/dap09-rtos-view`. The evidence set is intentionally under ignored `outputs/`; the report is the tracked acceptance index for those files.
