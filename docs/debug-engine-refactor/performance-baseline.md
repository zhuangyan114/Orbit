# Step Performance Baseline

## Purpose

This baseline records current step latency without changing debug behavior. It is intended for phase 1 of the debug-engine refactor: observe the existing TypeScript/J-Link path before moving step logic into a lower-level engine.

The profiling data is written through the existing logger:

- Backend step segments: `outputs/Log/step.log` through `log.step(...)`
- DAP request/response/event segments: `outputs/Log/dap.log` through `log.dap(...)`

No new debugger command path, breakpoint policy, timeout, or polling interval is introduced by this baseline.

## Log Format

Backend step logs use one profile id per `OzoneBackend.execute({ cmd: "stepOver" | "stepInto" | "stepOut" })` call:

```text
HH:MM:SS.mmm [Step] [profile#12] stepOver begin
HH:MM:SS.mmm [Step] [profile#12] read PC=0ms pc=0x8003a80
HH:MM:SS.mmm [Step] [profile#12] readMemory=1ms addr=0x8003a80 size=6 bytes=6
HH:MM:SS.mmm [Step] [profile#12] setBreakpoint=2ms addr=0x8003a86 bpIndex=1
HH:MM:SS.mmm [Step] [profile#12] run=0ms ok=true
HH:MM:SS.mmm [Step] [profile#12] waitForHalt=43ms halted=true polls=4/500
HH:MM:SS.mmm [Step] [profile#12] cleanupBreakpoint=1ms clearedBps=0
HH:MM:SS.mmm [Step] [profile#12] stepOver total=72ms ok=true
```

DAP logs use a separate DAP profile id for `handleStep(...)`:

```text
HH:MM:SS.mmm [DAP] [stepProfile#8] stepOver read PC=101ms pc=0x8003a80
HH:MM:SS.mmm [DAP] [stepProfile#8] stepOver backend=72ms attempt=1 ok=true
HH:MM:SS.mmm [DAP] [stepProfile#8] stepOver DAP response=0ms sinceStart=174ms
HH:MM:SS.mmm [DAP] [stepProfile#8] stepOver DAP stopped event=0ms poll=1 sinceStart=285ms
```

The backend and DAP profile ids are independent because they are produced in different objects. Use timestamps and command kind to correlate them.

## Recorded Segments

The current baseline records these step segments:

- `read PC`: `PC` read before instruction classification, plus selected `PC` reads before running to a temp breakpoint.
- `readMemory`: instruction bytes read for decode/classification.
- `setBreakpoint`: temporary breakpoint installation through `JLINK_SetBP`.
- `run`: `JLINK_Go` or `JLINK_Step` dispatch.
- `waitForHalt`: polling or fixed settle wait after run/single-step.
- `cleanupBreakpoint`: temporary breakpoint cleanup and user breakpoint restore path.
- `DAP stopped event`: elapsed time to emit the DAP `stopped` event after halt detection.
- `total`: total backend command duration for `stepOver`, `stepInto`, or `stepOut`.

Existing detail logs such as `waitForHalt: poll 100/500 ... still waiting`, `setTempBpAndRun: ...`, `sameLineStepping: ...`, `multiStep: ...`, and `nonBranchBp: ...` remain useful context around the profiling lines.

## Baseline Scenarios

Use a firmware image built with symbols and line mappings available to the extension. For each scenario, clear `outputs/Log/step.log` and `outputs/Log/dap.log`, start an `ozone` debug session, perform one step action, then inspect the profile lines.

| Scenario | Action | Expected useful evidence |
|---|---|---|
| Normal statement | Stop on a simple assignment or arithmetic statement, press Step Over | Usually shows `read PC`, `readMemory`, then either single-step `run`/`waitForHalt` or a short temp-BP path. |
| Function call | Stop on a direct `foo()` call, press Step Over | Shows call classification context, `setBreakpoint` at return address, `run`, `waitForHalt`, and `cleanupBreakpoint`. |
| Loop | Stop inside a `for` or `while` loop body, press Step Over | Shows whether control uses `sameLineStepping`, `multiStep`, or a temp breakpoint. Loop wrap should be visible in existing location logs. |
| `switch` | Stop on a `case` body or `break`, press Step Over | Shows whether branch handling avoids a long temp-BP wait. A bad temp breakpoint appears as long `waitForHalt`. |
| `do-while` | Stop on the loop body or condition, press Step Over repeatedly | Shows same-line stepping and whether fallback temp-BP waits are used. |
| User breakpoint hit | Put a user breakpoint at the current PC, continue to hit it, then Step Over | Shows `clearCurrentBpAndTrack`, step segments, and `cleanupBreakpoint`/restore logs. |
| Step Into | Stop on a call and press Step Into | Shows `read PC`, `readMemory`, and temp-BP/run/wait if the current logic steps into a computed target. |
| Step Out | Stop inside a function and press Step Out | Shows `read PC` with `LR`, `setBreakpoint` at return address, `run`, `waitForHalt`, and cleanup. |

## Identifying 5 Second Stalls

A 5 second class stall caused by a missed temporary breakpoint is visible as a long `waitForHalt` segment:

```text
[profile#21] setBreakpoint=1ms addr=0x8003b08 bpIndex=1
[profile#21] run=0ms ok=true
waitForHalt: poll 100/500 t=1015ms still waiting
waitForHalt: poll 200/500 t=2031ms still waiting
waitForHalt: poll 300/500 t=3048ms still waiting
waitForHalt: poll 400/500 t=4063ms still waiting
waitForHalt: poll 500/500 t=5080ms still waiting
[profile#21] waitForHalt=5080ms halted=false polls=500/500 timeout=true
```

If `setBreakpoint` and `run` are short but `waitForHalt` consumes nearly all of `total`, the target ran without hitting the temporary breakpoint. Check the surrounding logs for the temp breakpoint address, source location, branch/same-line stepping path, and final PC after the forced halt.

If backend `total` is short but DAP `stopped event sinceStart` is long, the latency is after backend execution, usually in DAP polling, response timing, or target-state detection.

## Reproduction Notes

1. Build and launch the extension normally.
2. Start an `ozone` debug configuration with symbols loaded.
3. Exercise the scenarios above on target hardware.
4. Inspect `outputs/Log/step.log` for backend segments.
5. Inspect `outputs/Log/dap.log` for DAP response and stopped-event timing.

Keep the raw logs for before/after comparison during later refactor tasks. The important comparison values are backend `total`, `waitForHalt`, and DAP `stopped event sinceStart`.

## Target Baseline: 2026-07-12

This run used a target-board debug session against `D:/STM32/project/vet6_led/Core/Src/freertos.c`. The exercised code covered:

- Simple `for`, `while`, and `do-while` loops.
- `if` / `else if` / `else`.
- `switch-case` with `break`.
- Ternary expression.
- Direct function call (`BL`).
- Nested direct function calls.
- Function pointer call (`BLX register`).
- Recursive function.
- `osDelay(100)`.
- Floating-point arithmetic inside a loop.
- Nested `if` inside `for`.
- Array and pointer arithmetic.
- Compound expression with comma operator.

Only `stepOver` samples were captured in this run. `stepInto`, `stepOut`, and an explicit current-PC user-breakpoint sample should be captured in a later run before changing step behavior.

### Summary

The run did not show 5 second stalls and did not show a missed temporary breakpoint. Every captured backend profile had `Timeouts=0`; the largest individual `waitForHalt` segment was about `56ms`.

The dominant delay source was repeated same-source-line single stepping. Each `doSingleStep()` dispatch was fast, but the current path waits about `50ms` after each step before reading halt state and PC. Multi-instruction source lines therefore accumulate latency linearly.

Slowest captured backend profiles:

| Backend profile | Total | Sum of waits | Max wait | Wait count | Timeouts | Run sum | Set BP sum |
|---:|---:|---:|---:|---:|---:|---:|---:|
| `profile#32` | `1387ms` | `990ms` | `55ms` | `22` | `0` | `52ms` | `4ms` |
| `profile#44` | `1281ms` | `1064ms` | `56ms` | `22` | `0` | `29ms` | `2ms` |
| `profile#22` | `824ms` | `687ms` | `53ms` | `14` | `0` | `23ms` | `1ms` |
| `profile#45` | `809ms` | `679ms` | `53ms` | `14` | `0` | `14ms` | `1ms` |
| `profile#46` | `661ms` | `441ms` | `52ms` | `10` | `0` | `36ms` | `2ms` |

Representative detail from `profile#44`:

```text
[profile#44] stepOver begin
[profile#44] read PC=0ms pc=0x8003bd4
[profile#44] readMemory=0ms addr=0x8003bd4 size=6 bytes=6
[profile#44] setBreakpoint=1ms addr=0x8003bd6 bpIndex=1
[profile#44] run=5ms ok=true
[profile#44] waitForHalt=16ms halted=true polls=1/500
sameLineStepping: start 0x8003bd6 line=207
[profile#44] run=2ms singleStep retry=0 ok=true
[profile#44] waitForHalt=51ms singleStep halted=true pc=0x8003bd8
...
[profile#44] waitForHalt=50ms singleStep halted=true pc=0x8003bf8
[profile#44] setBreakpoint=1ms addr=0x8003bfc bpIndex=1
[profile#44] run=5ms ok=true
[profile#44] waitForHalt=16ms halted=true polls=1/2000
[profile#44] cleanupBreakpoint=1ms clearedBps=0
[profile#44] stepOver total=1281ms ok=true
```

DAP timing did not dominate this run. `DAP stopped event` emission was `0-1ms`, usually on `poll=1`. The DAP layer still adds about `100ms` after backend completion because `handleStep` waits before polling target state:

```text
[stepProfile#44] stepOver backend=1281ms attempt=1 ok=true
[stepProfile#44] stepOver DAP response=0ms sinceStart=1384ms
[stepProfile#44] stepOver DAP stopped event=0ms poll=1 sinceStart=1497ms
```

### Current Baseline Ranges

Observed ranges from this run:

| Path | Observed latency |
|---|---:|
| Simple short step | about `180-400ms` |
| Multi-instruction same source line | about `550-1400ms` |
| Single `JLINK_Step` call | usually `0-11ms` |
| Fixed wait after single step | about `50-56ms` |
| Temp breakpoint hit wait | about `16-18ms` |
| DAP stopped event emission | `0-1ms` |
| DAP post-backend settle before stopped event | about `100ms` |

### Interpretation

For this run, the main latency source is not J-Link command execution, temporary breakpoint installation, or DAP event emission. The main source is the TypeScript step-over algorithm repeatedly single-stepping within one source line and paying a fixed halt/settle wait after every instruction.

Examples likely to trigger this path include:

- Multiple statements on one source line, such as `cnt += w; w++;`.
- `switch` case bodies written on one line, such as `case 0: cnt += 10; break;`.
- Compound expressions and comma expressions.
- Pointer arithmetic and floating-point expressions that compile into many instructions for one source line.

### Refactor Signal

Later refactor tasks should compare against these baseline indicators:

- Reduce repeated same-line single-step count or move it into a lower-latency engine path.
- Replace fixed `50ms` per-instruction settle with state-based confirmation where possible.
- Preserve the current no-timeout behavior for the tested `switch`, loop, and same-line expression cases.
- Keep `DAP stopped event` timing near `poll=1`; if backend latency drops but DAP `sinceStart` remains high, revisit the fixed DAP post-step wait.
