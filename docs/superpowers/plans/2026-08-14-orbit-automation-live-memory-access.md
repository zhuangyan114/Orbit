# Orbit Automation Live Memory Access Implementation Plan

> **For agentic workers:** Execute inline with TDD. Do not create another target owner and do not commit without explicit user authorization.

**Goal:** Make Automation API memory reads, writes, and verify reads access the selected owner without halting a running target.

**Architecture:** Add an internal live-access option to `OzoneCommand` memory operations. The Automation DAP bridge opts in; standard DAP MemoryView calls do not. Existing DAP gates and native scheduler priorities continue to serialize physical owner access.

**Tech Stack:** TypeScript, VS Code DAP, Vitest, J-Link/CMSIS-DAP native owner interfaces.

## Global Constraints

- Preserve one physical owner per debug session and prohibit extension-host fallback.
- Do not change standard DAP MemoryView behavior.
- Do not edit generated `dist/` files.
- Do not run target-mutating hardware verification without explicit authorization.

---

### Task 1: Define and prove live backend memory behavior

**Files:**
- Modify: `src/ozone-backend/types.ts`
- Modify: `src/ozone-backend/commander.ts`
- Test: `src/ozone-backend/commander-session-owner.test.ts`

**Interfaces:**
- `readMemory` and `writeMemory` commands gain optional `liveAccess?: boolean`.
- `liveAccess: true` skips state query, halt, delay, and resume.
- Omitted/false preserves the existing path.

- [x] Add failing owner tests asserting live read/write call only the selected owner's memory method.
- [x] Run the focused test and confirm it fails because state/halt/run are still called.
- [x] Add `liveAccess` to the command union and thread it through `execute`, `doReadMemory`, and `doWriteMemory`.
- [x] Run the focused test and confirm both live and default behavior pass.

### Task 2: Opt only Automation API into live access

**Files:**
- Modify: `src/debug/dap-session.ts`
- Test: `src/debug/dap-session-automation.test.ts`

**Interfaces:**
- Automation read dispatches backend `readMemory` with `liveAccess: true` while retaining the background target-read gate and standard base64 response.
- Automation write and verify dispatch `writeMemory` / `readMemory` with `liveAccess: true` inside the existing control barrier.
- Automation memory access no longer stops/restarts run-state polling.

- [x] Add failing DAP tests asserting all Automation memory backend commands carry `liveAccess: true` and polling is not restarted.
- [x] Run the focused test and confirm the new assertions fail against the halt/resume-compatible path.
- [x] Implement the minimal Automation-only routing change and remove obsolete polling suppression.
- [x] Run the focused DAP test and confirm it passes.

### Task 3: Verify regressions and documentation

**Files:**
- Modify: `docs/superpowers/plans/2026-08-13-orbit-automation-api.md`
- Verify: `docs/superpowers/specs/2026-08-14-orbit-automation-live-memory-design.md`

- [x] Run focused DAP realtime/memory and owner tests.
- [x] Run `npm run typecheck`, `npm run build`, and `npm test`.
- [x] Run `npm run test:cpp-channel:mock`, `npm run test:cmsis-dap:mock`, and `npm run test:cmsis-dap:algorithm` if the native mock prerequisites are available.
- [x] Run `git diff --check` and review the final diff for unrelated changes.
- [x] Complete the authorized real-hardware RAM test on `STM32F407VE` through
  the selected `jlink-native` owner: live read/write/verify/restore passed at
  `0x20000010`, the original `0x5A5AA5A5` value was restored, no implicit
  stopped/continued or polling restart occurred, and the target ended halted.
