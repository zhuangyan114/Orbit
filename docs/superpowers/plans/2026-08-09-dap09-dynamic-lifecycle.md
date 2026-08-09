# DAP-09 Dynamic Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an authorized FreeRTOS dynamic-task fixture and collect real CMSIS-DAP lifecycle and session-replacement evidence.

**Architecture:** The firmware owns a deterministic 20-round create/delete state machine with volatile counters. Orbit keeps one CMSIS-DAP owner per DAP session; Node harnesses consume DAP frames and logs, then validate evidence without changing the owner route.

**Tech Stack:** C11/CMake STM32F407 firmware, FreeRTOS 10 CMSIS-RTOS v1, Node.js DAP client, Orbit CMSIS-DAP HID helper, Vitest.

## Global Constraints

- Only `D:\STM32\project\vet6_led` is authorized for firmware edits, build, flash, reset, halt, run, and step.
- CMSIS-DAP is the sole physical owner; do not invoke OpenOCD, GDB server, `JLink.exe`, or a second helper.
- Keep `flashBeforeDebug:false` for read-only workloads; use `flashBeforeDebug:true` only for the explicitly authorized fixture flash.
- Preserve DAP `evaluate`, `variables`, `readMemory`, Watch, Timeline, RTT, and RTOS View behavior.
- Do not edit generated `dist/` bundles or `docs/bug-fix-log.md`.

### Task 1: Add the dynamic fixture

**Files:**
- Modify: `D:\STM32\project\vet6_led\Core\Src\freertos.c` USER CODE sections.

**Interfaces:**
- Produces symbols `g_dap09_lifecycle_round`, `g_dap09_lifecycle_phase`, `g_dap09_lifecycle_create_count`, `g_dap09_lifecycle_delete_count`, `g_dap09_lifecycle_live`, and `g_dap09_lifecycle_worker_counter` for the harness.

- [ ] Add volatile counters and `Dap09LifecycleTask`/`Dap09LifecycleWorker` prototypes.
- [ ] Create `dap09Lifecycle` in `MX_FREERTOS_Init` after the existing tasks.
- [ ] Implement 20 rounds with `xTaskCreate`, a 250 ms live window, `vTaskDelete`, and a 250 ms inter-round delay.
- [ ] Build the firmware and inspect the ELF symbols before flashing.

### Task 2: Add lifecycle evidence collection

**Files:**
- Create: `scripts/cmsis-dap/verify-dap09-lifecycle-hw.js`.
- Create: `src/dap09-lifecycle-evidence-validation.test.ts`.

**Interfaces:**
- Consumes the DAP adapter's `evaluate`, `variables`, `readMemory`, and `rtosInfo` requests.
- Produces `outputs/dap09/hardware/<stamp>/lifecycle-evidence.json` and validation diagnostics.

- [ ] Write validator tests for 20 complete rounds, missing deletion, stale task publication, counter mismatch, and owner/process violations.
- [ ] Implement the validator and make the focused tests pass.
- [ ] Implement a DAP client that launches with `flashBeforeDebug:true`, runs to `osKernelStart`, polls the symbols and RTOS list, then disconnects.
- [ ] Run the lifecycle harness against the authorized hardware and retain logs on failure.

### Task 3: Add session replacement evidence

**Files:**
- Create: `scripts/cmsis-dap/verify-dap09-session-replacement-hw.js`.
- Create: `src/dap09-session-replacement-evidence-validation.test.ts`.

**Interfaces:**
- Consumes the existing DAP adapter and the same CMSIS-DAP serial configuration.
- Produces `outputs/dap09/hardware/<stamp>/replacement-evidence.json`.

- [ ] Write validator tests requiring first-session cleanup, second-session owner uniqueness, and zero residual helpers.
- [ ] Implement first-session termination while asynchronous Watch/RTOS requests are pending.
- [ ] Launch the second session, read RTOS state, and disconnect cleanly.
- [ ] Validate that no J-Link/OpenOCD/GDB owner appears in either session.

### Task 4: Build, flash, run, and update the report

**Files:**
- Modify: `docs/dap09-rtos-view-acceptance-report.md`.
- Modify: `package.json` only if a stable npm script is needed for the two harnesses.

- [ ] Run firmware build and the existing Orbit typecheck, build, and focused tests.
- [ ] Flash the authorized ELF through CMSIS-DAP and run lifecycle evidence.
- [ ] Run session replacement evidence and inspect helper cleanup snapshots.
- [ ] Update the report with exact evidence paths, owner details, round counts, and any remaining gaps.
- [ ] Run `git diff --check`, `npm test`, and build verification before commit.
- [ ] Commit Orbit changes without staging `Releases/Orbit-Config-skill/SKILL.md`.
