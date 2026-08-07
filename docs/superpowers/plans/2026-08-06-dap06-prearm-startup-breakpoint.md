# DAP-06 Pre-armed Startup Breakpoint Implementation Plan

> **For agentic workers:** Execute inline in the current workspace. Do not create a branch, commit, or subagent; preserve all existing user changes.

**Goal:** Prevent a fast STM32F407 reset from passing `main` before the CMSIS-DAP startup breakpoint is installed.

**Architecture:** Keep the existing single CMSIS-DAP helper and `NativeScheduler` control request. While the target is halted, reserve or share the startup FPB comparator before issuing AIRCR `SYSRESETREQ`; retain the existing reset/halt/run loop, PC validation, user-breakpoint restoration, and cleanup contract.

**Tech Stack:** C++17 CMSIS-DAP helper, JavaScript helper smoke test, PowerShell validation.

## Global Constraints

- Do not add another helper or any J-Link, legacy, OpenOCD, or GDB fallback.
- Preserve user comparator slots and release the startup comparator on every result path.
- Comparator exhaustion must occur before reset and leave the target halted.
- Do not edit `dist/`, `docs/bug-fix-log.md`, or unrelated user changes.
- Real target mutation is authorized only for `D:\STM32\project\vet6_led` startup-stop acceptance.

---

### Task 1: Reproduce the reset race

**Files:**
- Modify: `native/cmsis-dap-helper/src/mock_transport.h`
- Modify: `native/cmsis-dap-helper/src/mock_transport.cpp`
- Modify: `scripts/cmsis-dap-smoke.js`

- [ ] Add a mock probe whose reset executes past the startup entry unless an FPB comparator is already armed.
- [ ] Add a DAP-06 smoke assertion that `runToAddress(reset=true)` reaches the entry, preserves a user breakpoint, and releases its temporary comparator.
- [ ] Run `npm run build:native` and `npm run test:cmsis-dap:mock`; expect the new assertion to fail with `StartupStopTimeout` before the production change.

### Task 2: Pre-arm the startup comparator

**Files:**
- Modify: `native/cmsis-dap-helper/src/cmsis_dap_startup_stop.cpp`

- [ ] Halt/read the pre-reset target state before allocating the startup comparator.
- [ ] Install or share the startup comparator before calling `CortexMDebug::reset`.
- [ ] Route reset, halt, run, timeout, and capture failures through the existing temporary-comparator cleanup.
- [ ] Preserve the no-reset fast path and final trusted-PC validation.
- [ ] Run the focused mock again; expect the reset-race assertion and existing DAP-06 cleanup/exhaustion/timeout assertions to pass.

### Task 3: Verify offline and on hardware

**Files:**
- No production file additions.

- [ ] Run typecheck, Vitest, bundle/native builds, both helper mock suites, Flash Algorithm verification, helper selftest, `git diff --check`, and the `dist/` status check.
- [ ] Confirm there is no active VS Code CMSIS-DAP helper before hardware access.
- [ ] Use one helper against the authorized probe and ELF to verify reset/run-to-main, real PC/DHCSR/LR, comparator cleanup, user-breakpoint preservation, and process count.
- [ ] Report hardware results separately from mock results; do not update `docs/bug-fix-log.md` until the user confirms the fix.
