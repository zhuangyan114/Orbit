# DAP Breakpoint Source Tracking Implementation Plan

> **For agentic workers:** Execute inline with `superpowers:executing-plans`; current session constraints prohibit subagent delegation, staging, and commits.

**Goal:** Ensure every CMSIS-DAP breakpoint stop yields a non-empty DAP stack frame so VS Code consistently moves the source cursor to the trusted stopped PC.

**Architecture:** Keep the existing single CMSIS-DAP owner and target-read gate. Add a foreground-read reservation for stopped-state `stackTrace` and `variables` requests; once a foreground request is waiting, new Watch reads yield until it acquires and releases the gate. The currently running read is never interrupted.

**Tech Stack:** TypeScript, DAP, Vitest, NativeScheduler-backed CMSIS-DAP owner.

## Global Constraints

- Preserve every existing user change in the dirty worktree.
- Do not reset, clean, revert, stage, commit, or manually edit `dist/`.
- Do not modify `docs/bug-fix-log.md` without explicit user confirmation.
- Do not create a J-Link owner, OpenOCD/GDB server, `JLink.exe`, or a second helper.
- Do not perform target-mutating hardware operations during automated verification.

---

### Task 1: Reproduce foreground stack starvation

**Files:**
- Test: `src/debug/dap-session-cmsis-dap.test.ts`

**Interfaces:**
- Consumes: `DapSession.handleStackTrace`, `DapSession.beginWatchTargetRead`, and the existing `targetReadInProgress` gate.
- Produces: A regression proving a waiting stack request cannot be displaced by a newly arriving Watch read.

- [ ] Add a fake-timer test that starts `handleStackTrace` while one read owns the gate, releases that read, immediately offers a Watch read, and advances beyond the 700 ms stack timeout.
- [ ] Assert the Watch request yields and the `stackTrace` response contains the backend-provided frame.
- [ ] Run `npx vitest run src/debug/dap-session-cmsis-dap.test.ts` and confirm the new assertion fails because Watch currently acquires the gate.

### Task 2: Reserve the gate for foreground DAP reads

**Files:**
- Modify: `src/debug/dap-session.ts:220-251`
- Test: `src/debug/dap-session-cmsis-dap.test.ts`

**Interfaces:**
- Consumes: the existing target-read boolean gate and bounded polling loop.
- Produces: foreground, Watch, and low read priorities with foreground waiter accounting.

- [ ] Add a `foreground` read class and a foreground waiter counter.
- [ ] Increment the counter for the complete bounded wait in `beginTargetReadWhenAvailable('foreground', timeoutMs)` and decrement it in `finally`.
- [ ] Make Watch and low reads decline acquisition while a foreground waiter exists; never cancel the read already in progress.
- [ ] Route stopped-state `stackTrace` and `variables` waits through the foreground class while preserving their existing 700 ms and 1200 ms bounds.
- [ ] Run the focused test and confirm it passes.

### Task 3: Verify DAP and CMSIS-DAP regressions

**Files:**
- Verify only; no generated-file edits.

**Interfaces:**
- Consumes: repository scripts and existing mock oracles.
- Produces: evidence that source tracking, DAP ordering, CMSIS-DAP behavior, and J-Link regressions remain intact.

- [ ] Run `npm run typecheck`.
- [ ] Run `npm test` and `npm run build`.
- [ ] Run `npm run build:native`, `npm run test:cmsis-dap:mock`, `npm run test:cpp-channel:mock`, and `npm run test:cmsis-dap:algorithm`.
- [ ] Run `out\\native\\win32-x64\\orbit-cmsis-dap-helper.exe --selftest`.
- [ ] Run `git diff --check`.
- [ ] Stop before hardware verification and ask the user to reload the Extension Development Host and confirm repeated breakpoint cursor tracking.

### Task 4: Capture repeated-stop DAP protocol generations

**Files:**
- Modify: `src/debug/dap-session.ts`
- Test: `src/debug/dap-session-cmsis-dap.test.ts`

**Interfaces:**
- Consumes: `DapSession.sendEvent`, `DapSession.sendResponse`, `DapSession.handleStackTrace`, and the existing `log.dap` category.
- Produces: diagnostic-only stop generations and request/response correlation without adding private fields to DAP messages.

- [ ] Add a failing regression that drives two polled breakpoint stops at the same PC, requests `stackTrace` after each stop, and expects two distinct logged stop generations with matching DAP `seq`/`request_seq`, frame ID, PC, and source.
- [ ] Run `npx vitest run src/debug/dap-session-cmsis-dap.test.ts` and confirm the new assertion fails because protocol-boundary diagnostics do not exist yet.
- [ ] Add a session-local stop-generation counter. Increment it only for `stopped`; log `stopped`, `continued`, incoming `stackTrace`, and outgoing `stackTrace` response metadata through `log.dap` before emitting the message. Do not alter the message bodies sent to VS Code.
- [ ] Re-run the focused test and confirm it passes, then run `npm run typecheck` and `git diff --check`.
- [ ] Stop without hardware access and ask the user to reproduce once so the new DAP boundary evidence can identify the UI refresh failure.

### Task 5: Cancel stale stopped-state variable reads at control boundaries

**Files:**
- Modify: `src/debug/dap-session.ts`
- Modify: `src/ozone-backend/types.ts`
- Modify: `src/ozone-backend/commander.ts`
- Test: `src/debug/dap-session-cmsis-dap.test.ts`
- Test: `src/ozone-backend/commander-cmsis-dap.test.ts`

**Interfaces:**
- Consumes: `DapSession.readCancelEpoch`, stopped-state `variables`, `OzoneBackend.execute`, and the existing one-read-at-a-time gate.
- Produces: request-scoped `AbortSignal` cancellation for `getLocals`/`getRegisters`, with cancellation observed only between individual owner reads.

- [ ] Add a failing DAP regression that starts a long Locals request, begins Continue, and expects the old request to be aborted, its stale result discarded, and the next breakpoint `stackTrace` to remain non-empty.
- [ ] Add failing backend regressions proving `doGetLocals` and `doGetRegisters` stop before issuing the next owner read after their signal is aborted.
- [ ] Pass optional `AbortSignal` values through the `getLocals` and `getRegisters` commands. Abort the active stopped-state request from `beginControl`, reject requests whose captured read epoch became stale while waiting, and suppress stale results after execution.
- [ ] Check cancellation before and after each individual local/register owner read. Never interrupt or retry a read already sent to the owner.
- [ ] Run the focused DAP/backend tests, then the full DAP-05 automated verification matrix. Stop before hardware access and request a repeated-breakpoint UI retest.
