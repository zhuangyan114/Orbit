# CMSIS-DAP Flash Init Interrupt Mask Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent a configurable target interrupt from preempting the first instruction of a CMSIS-DAP Flash Algorithm and turning the initial `Init` call into an intermittent HardFault/timeout.

**Architecture:** Keep the existing single CMSIS-DAP helper owner and `NativeScheduler` control critical section. Inside the existing bounded `CortexMDebug::executeFlashAlgorithm` primitive, arm `DHCSR.C_MASKINTS` while halted, preserve it while resuming the algorithm, then clear it after the trusted BKPT halt; never retry an erase/program operation.

**Tech Stack:** C++17 native CMSIS-DAP helper, built-in mock transport/selftest, CMake/PowerShell native build.

## Global Constraints

- Preserve all pre-existing working-tree changes and do not edit generated `dist/` bundles.
- `probe: 'cmsis-dap'` continues to use exactly one CMSIS-DAP native helper owner; no J-Link/OpenOCD fallback is introduced.
- Flash erase/program/verify operations are never automatically retried when completion is unknown.
- No target-mutating hardware command is run without explicit user authorization.
- Do not update `docs/bug-fix-log.md` until the user confirms the hardware fix.

---

### Task 1: Mask configurable interrupts across Flash Algorithm launch

**Files:**
- Modify: `native/cmsis-dap-helper/src/mock_transport.h`
- Modify: `native/cmsis-dap-helper/src/mock_transport.cpp`
- Modify: `native/cmsis-dap-helper/src/main.cpp`
- Modify: `native/cmsis-dap-helper/src/cortex_m_debug.cpp`

**Interfaces:**
- Consumes: `kCoreDebugCMaskInts`, `CortexMDebug::executeFlashAlgorithm(...)`, and the existing mock-device/selftest framework.
- Produces: Flash Algorithm execution that confirms `C_MASKINTS` before resume and confirms it is cleared after the trusted halt.

- [x] **Step 1: Add the failing native selftest fixture**

Extend the existing `1234:568E` interrupt-injection device with `interruptOnUnmaskedAlgorithmStart` and `algorithmInterruptMaskAtEntry`. At the prepared-algorithm boundary, leave the simulated core running instead of completing when the failure injection is enabled and the resume write lacks `C_MASKINTS`:

```cpp
if (injection_.interruptOnUnmaskedAlgorithmStart && !maskInterrupts) {
  preparedFlashAlgorithm_.pending = false;
  ++injection_.flashAlgorithmCount;
  state_.dhcsr = kMockCoreDebugCDebugEn;
  return;
}
```

Add a selftest that opens `1234:568F`, halts it, prepares `Init`, calls the real `CortexMDebug::executeFlashAlgorithm`, and requires all of the following:

```cpp
expect(algorithm.ok && algorithmResult.returnCode == 0,
       "dap02a-algorithm-interrupt-window-masked");
expect(mock.injection().algorithmInterruptMaskAtEntry,
       "dap02a-algorithm-interrupt-mask-present-at-entry");
expect((mock.targetState().lastDhcsrWrite & kMockCoreDebugCMaskInts) == 0 &&
           (mock.targetState().lastDhcsrWrite & kMockCoreDebugCHalt) != 0,
       "dap02a-algorithm-interrupt-mask-cleared-after-halt");
```

- [x] **Step 2: Run the selftest and verify RED**

Run: `npm run build:native; npm run test:cmsis-dap:mock`

Expected: FAIL at `dap02a-algorithm-interrupt-window-masked`, because the current algorithm resume writes only `DBGKEY | C_DEBUGEN`.

- [x] **Step 3: Implement the minimal launch-boundary fix**

In `CortexMDebug::executeFlashAlgorithm`, after clearing stale fault status and while the target is still halted, write and confirm the masked halted state:

```cpp
operation = writeWord(kCoreDebugDhcsr,
                      kCoreDebugDbgKey | kCoreDebugCDebugEn |
                          kCoreDebugCHalt | kCoreDebugCMaskInts,
                      diag, ioTimeout(timeout));
if (!operation.ok) return operation;
uint32_t dhcsr = 0;
operation = readDhcsr(dhcsr, diag, ioTimeout(timeout));
if (!operation.ok) return operation;
if ((dhcsr & (kCoreDebugSHalt | kCoreDebugCMaskInts)) !=
    (kCoreDebugSHalt | kCoreDebugCMaskInts)) {
  return Result::error(ErrorCodes::kDapControlTimeout,
                       "Cortex-M did not confirm the Flash Algorithm interrupt mask while halted");
}
```

Resume with `DBGKEY | C_DEBUGEN | C_MASKINTS`. After `waitForHalt(true, ...)` succeeds, clear the debug interrupt mask while preserving the halt, read back DHCSR, and require `S_HALT=1` and `C_MASKINTS=0` before checking the BKPT PC and R0 return code.

- [x] **Step 4: Run the focused selftest and verify GREEN**

Run: `npm run build:native; npm run test:cmsis-dap:mock`

Expected: PASS, including the new interrupt-window assertions and all existing raw-frame/control/Flash cases.

- [x] **Step 5: Run automated regression verification**

Run:

```powershell
npm run typecheck
npm test
npm run build
npm run build:native
npm run test:cpp-channel:mock
git diff --check
```

Expected: every command exits 0. Report the CMSIS-DAP mock as mock validation only; real STM32F407VET6 Flash remains a separate authorized hardware acceptance step.

- [x] **Step 6: Review the final diff without committing**

Confirm the diff changes only the four files listed above plus this plan, does not touch `dist/`, does not add a second owner or a retry, and preserves unrelated source-step work already present in the working tree. Do not stage or commit the changes.
