# DAP-09 Hardware Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an independently executable CMSIS-DAP DAP-09 hardware acceptance harness and publish evidence for RTOS View, Watch, Timeline, RTT, control latency, and owner cleanup.

**Architecture:** Reuse the existing stdio DAP client and launch configuration used by DAP-07/08. Keep hardware orchestration in `scripts/cmsis-dap/verify-dap09-rtos-hw.js`; keep summary/threshold logic pure in `scripts/cmsis-dap/dap09-evidence-validation.js` so it can be unit-tested without hardware. The harness uses `flashBeforeDebug:false`, one CMSIS-DAP owner, and only the user-authorized reset/halt/run/step/read operations.

**Tech Stack:** Node.js CommonJS scripts, DAP Content-Length framing, Vitest, CMSIS-DAP HID, existing Orbit debug adapter.

## Global Constraints

- Do not Flash, erase, program, verify, write target memory, or modify `D:\STM32\project\vet6_led`.
- Use one physical CMSIS-DAP owner and route all target access through the active DAP session.
- Preserve standard DAP evaluate/variables/readMemory contracts and record structured failures/stale-result diagnostics.
- Hardware evidence is reported separately from mock/unit evidence; missing hardware workload keeps DAP-09 partial.

### Task 1: Evidence Validator

**Files:**
- Create: `scripts/cmsis-dap/dap09-evidence-validation.js`
- Test: `src/dap09-evidence-validation.test.ts`

- [ ] Write failing tests for latency percentiles, RTOS field coverage, owner/cleanup checks, and stale/gate error counting.
- [ ] Run `npx vitest run src/dap09-evidence-validation.test.ts` and confirm the missing-module failure.
- [ ] Implement pure `percentileStats`, `countDiagnostics`, and `validateDap09Summary` exports.
- [ ] Re-run the focused test and the existing focused DAP tests.

### Task 2: Hardware Harness

**Files:**
- Create: `scripts/cmsis-dap/verify-dap09-rtos-hw.js`

- [ ] Reuse DAP framing/client lifecycle from DAP-07/08 and refuse execution without `--hardware`.
- [ ] Launch the known ELF with CMSIS-DAP, `flashBeforeDebug:false`, RTT polling enabled, and `rtos:'FreeRTOS'`.
- [ ] Capture halted `rtosInfo`, task-root evaluate/variables expansion, four runtime-counter values, and direct byte-oriented `readMemory` cross-checks.
- [ ] Run a minimum 60-second workload with eight Watch expressions, Timeline sampling, RTT polling, and periodic RTOS refresh; interleave Continue/Pause, Step, and Reset while recording latency and diagnostics.
- [ ] Disconnect in `finally`, snapshot helper/owner processes, write `evidence.json`, and exit nonzero for failed acceptance checks.

### Task 3: Report and Verification

**Files:**
- Modify: `docs/dap09-rtos-view-acceptance-report.md`

- [ ] Parse the resulting evidence and append hardware owner, snapshot, workload, latency, and cleanup results while retaining the partial status when any required workload is unavailable.
- [ ] Run focused tests, typecheck, build, CMSIS-DAP mock, and `git diff --check`.
- [ ] Commit and push only the new script, validator/test, plan, and report; leave the user's unrelated edit untouched.
