# DAP-04 Cortex-M Debug Control Implementation Plan

> **For agentic workers:** This plan is executed inline in the current workspace. Do not stage or commit any file.

**Goal:** Add mock-verified Cortex-M halt/run/reset/instruction-step/state/register control to the existing CMSIS-DAP owner without changing J-Link behavior or adding a second owner.

**Architecture:** Add a focused native `CortexMDebug` class over the existing `CmsisDapTarget` MEM-AP single-word operations. Add six helper RPC handlers that serialize the state-machine results and diagnostics, then route them through the existing TypeScript `NativeScheduler` control queue and CMSIS-DAP target channel. Reuse existing Commander and DAP command boundaries, selecting instruction stepping only for the CMSIS-DAP owner while preserving J-Link source stepping and all unsupported capabilities.

**Tech Stack:** C++17, existing CMSIS-DAP JSON-lines helper, existing SW-DP/MEM-AP protocol, TypeScript, Vitest, CMake, PowerShell, Node.js.

## Global Constraints

- Preserve all existing user changes; never reset, clean, revert, stage, or commit.
- Do not edit generated `dist/` bundles.
- Do not add OpenOCD, a GDB server, Ozone GUI automation, `JLink.exe`, or a second target owner.
- Do not change J-Link native/legacy behavior.
- CMSIS-DAP `writeMemory` remains `UnsupportedCapability`; only helper-internal CoreDebug writes are allowed.
- Do not update `docs/bug-fix-log.md` and do not claim hardware acceptance.
- Do not execute real hardware commands.
- Every control request uses `NativeScheduler` priority `control` and pauses timeline/background work for its critical section.
- Every `OzoneCommandResult` consumer checks `ok` before reading success data.

### Task 1: Establish failing native CoreDebug tests

**Files:**
- Create: `native/cmsis-dap-helper/src/cortex_m_debug.h`
- Create: `native/cmsis-dap-helper/src/cortex_m_debug.cpp`
- Modify: `native/cmsis-dap-helper/src/main.cpp`
- Modify: `native/cmsis-dap-helper/src/mock_transport.h`
- Modify: `native/cmsis-dap-helper/src/mock_transport.cpp`
- Modify: `native/cmsis-dap-helper/CMakeLists.txt`

**Interfaces:**
- `CortexMDebug` consumes `CmsisDapTarget` and produces state/register/step snapshots plus `Result` errors.
- `MockSwdState` produces deterministic DHCSR/DCRSR/DCRDR/AIRCR behavior and records CoreDebug writes.
- `runSelfTest()` consumes the helper methods and reports the existing DAP-03 cases plus DAP-04 cases.

- [ ] Add a native selftest block that opens mock device `1234:5678`, connects SWD, calls the six intended operations, and asserts halted/running transitions, PC change after one step, reset PC/state, R0-R12/SP/LR/PC/xPSR mapping, invalid register rejection, DHCSR key/control-bit values, and AIRCR reset write.
- [ ] Add selftest cases for control timeout, WAIT, FAULT, NO_ACK, removal, disconnect/InvalidState, and unknown control-write completion with exactly one write command.
- [ ] Build/run the focused selftest before adding production behavior and confirm failure is caused by missing CoreDebug symbols/RPC behavior rather than a test typo.

### Task 2: Implement native Cortex-M state machine

**Files:**
- Modify: `native/cmsis-dap-helper/src/cortex_m_debug.h`
- Modify: `native/cmsis-dap-helper/src/cortex_m_debug.cpp`
- Modify: `native/cmsis-dap-helper/src/cmsis_dap_transport.h`

**Interfaces:**
- Constants: `kCoreDebugDhcsr = 0xE000EDF0`, `kCoreDebugDcrsr = 0xE000EDF4`, `kCoreDebugDcrdr = 0xE000EDF8`, `kCoreDebugAircr = 0xE000ED0C`.
- Bitfields: `S_HALT` bit 17, `S_REGRDY` bit 16, `C_DEBUGEN` bit 0, `C_HALT` bit 1, `C_STEP` bit 2, `DBGKEY` bits 31:16, `REGSEL` bits 4:0, `VECTKEY` bits 31:16, `SYSRESETREQ` bit 2.
- Methods: `getState`, `halt`, `run`, `reset`, `stepInstruction`, `readRegister`, each accepting a bounded timeout and returning structured diagnostics.

- [ ] Implement internal 32-bit CoreDebug reads/writes via `CmsisDapTarget::readMemoryBlock`/`writeAp`-equivalent safe primitives without adding a JSON-RPC generic write-memory method.
- [ ] Implement bounded DHCSR polling and DCRSR `S_REGRDY` polling; include phase, register/address, timeout, observed DHCSR, retry and transfer diagnostics in helper results.
- [ ] Reject register indices outside 0..16 as `DapInvalidRequest`; never issue a DCRSR write for invalid input.
- [ ] Implement halt/run/step/reset exactly with the key and control values, confirming halted after step and returning the current owner PC/state.
- [ ] Ensure unknown write outcomes return `OutcomeUnknown` without retry; propagate WAIT/FAULT/NO_ACK/device removal unchanged.
- [ ] Run the native selftest and confirm the new cases pass while DAP-03 cases remain green.

### Task 3: Extend the mock CoreDebug oracle

**Files:**
- Modify: `native/cmsis-dap-helper/src/mock_transport.h`
- Modify: `native/cmsis-dap-helper/src/mock_transport.cpp`
- Modify: `native/cmsis-dap-helper/src/main.cpp`

**Interfaces:**
- Mock CoreDebug state is observable through `MockSwdState` fields for DHCSR, AIRCR, selected register, register data, PC, and control-write history.
- Mock device selectors provide deterministic control faults without changing existing DAP-03 selectors.

- [ ] Model CoreDebug memory addresses inside `accessAp`/MEM-AP memory access so DHCSR reads expose halted/running and `S_REGRDY`, DCRSR selects a register, DCRDR returns its value, and AIRCR reset applies the deterministic reset state.
- [ ] Make a valid `C_DEBUGEN|C_STEP` write increment PC and leave the target halted; make a valid AIRCR reset set the documented reset PC and state.
- [ ] Add per-device injections for control WAIT, FAULT, NO_ACK, timeout, device removal, disconnect, and unknown write completion without reusing J-Link or bypassing the CMSIS-DAP protocol.
- [ ] Keep all existing DAP-03 vector, boundary, packet-size, transfer, and unknown-memory-write assertions intact.
- [ ] Run `out/native/win32-x64/orbit-cmsis-dap-helper.exe --selftest` after building and record the actual case/failure counts.

### Task 4: Add helper RPC handlers and protocol capability declarations

**Files:**
- Modify: `native/cmsis-dap-helper/src/main.cpp`
- Modify: `src/ozone-backend/cmsis-dap-helper-channel.ts`
- Modify: `scripts/cmsis-dap-smoke.js`
- Modify: `package.json` only if the existing mock script lacks a required invocation

**Interfaces:**
- RPC methods: `getState`, `halt`, `run`, `reset`, `stepInstruction`, `readRegister`.
- Success data: `{ state, dhcsr?, pc?, pcBefore?, pcAfter?, register?, value? }` as applicable.
- Failure data keeps `errorCode`, `message`, `targetState`, `elapsedMs`, and diagnostics.

- [ ] Add `CortexMDebug` construction only after `ensureReady()` and use the negotiated packet size.
- [ ] Add one handler per method with parameter validation, elapsed time, target state, and diagnostics serialization; map all six dispatch names explicitly.
- [ ] Add helper capability names and TypeScript response types without exposing generic write-memory.
- [ ] Extend `priorityForMethod` so all six methods resolve to `control`, and expose `controlRequest`/paused critical-section behavior through the existing scheduler API.
- [ ] Add smoke assertions for successful routing and structured error passthrough, then run the focused smoke command.

### Task 5: Wire CMSIS-DAP target owner and Commander

**Files:**
- Modify: `src/ozone-backend/session-target-channel.ts`
- Modify: `src/ozone-backend/commander.ts`
- Modify: `src/ozone-backend/types.ts` only if a new command/result field is required
- Test: `src/ozone-backend/session-target-channel.test.ts`
- Test: `src/ozone-backend/commander-session-owner.test.ts`

**Interfaces:**
- `SessionTargetOwner` gains the minimal `stepInstruction`/state/register result shape only where the existing `stepIntoInstruction` contract cannot represent CMSIS-DAP data.
- `CmsisDapTargetChannel` calls the six helper RPCs with control priority and maps helper errors verbatim.
- J-Link channel implementations retain their current method bodies and routing.

- [ ] Write failing TypeScript tests for CMSIS-DAP halt/run/reset/step/state/register RPC calls, control priority, structured errors, invalid register, and no J-Link fallback.
- [ ] Implement channel methods and selector forwarding with exact owner identity checks; no fallback or cached PC/state.
- [ ] Update Commander command dispatch so `probe: 'cmsis-dap'` uses the owner methods while existing J-Link paths remain unchanged.
- [ ] Ensure CMSIS-DAP write-memory and source-level Step Into/Over/Out still return `UnsupportedCapability`.
- [ ] Run the focused Vitest files and verify the new tests fail before implementation and pass after it.

### Task 6: Route DAP requests and real owner events

**Files:**
- Modify: `src/debug/dap-session.ts`
- Modify: `src/debugadapter.ts` only if request capability advertisement or launch routing requires it
- Test: `src/debug/dap-session-native-executor.test.ts`
- Create or modify: focused CMSIS-DAP DAP session test near the existing DAP session tests

**Interfaces:**
- Standard DAP `continue`, `pause`, `stepIn`, and `restart`/reset requests call the active CMSIS-DAP owner through Commander.
- State/PC reads used for stopped/continued events come from the same active owner and are validated with `ok` before data access.

- [ ] Write failing DAP tests for real owner state in stopped/continued event paths, control error propagation, and exact CMSIS-DAP owner identity.
- [ ] Implement the smallest owner-aware branches: CMSIS-DAP `stepIn` maps to one instruction; source-level `next`/`stepOut` remain unsupported; existing J-Link stepping remains untouched.
- [ ] After halt/step/reset, query actual owner state and PC before publishing stopped; after run, publish continued only on confirmed run success.
- [ ] Prevent stale cached/J-Link state from filling CMSIS-DAP PC or state fields.
- [ ] Run the focused DAP tests and full TypeScript tests.

### Task 7: Full verification and handoff

**Files:**
- No source changes expected unless a verification failure identifies a scoped defect.

- [ ] Run `npm run typecheck`.
- [ ] Run `npm test`.
- [ ] Run `npm run build` without manually editing generated `dist/`.
- [ ] Run `npm run build:native`.
- [ ] Run `npm run test:cmsis-dap:mock`.
- [ ] Run `npm run test:cpp-channel:mock`.
- [ ] Run `out/native/win32-x64/orbit-cmsis-dap-helper.exe --selftest`.
- [ ] Run `git diff --check` and inspect `git status --short`/diff for unrelated changes, staged files, commits, `dist/`, and `docs/bug-fix-log.md`.
- [ ] Report exact results, changed files, CoreDebug state machine, constants/bitfields, unsupported capabilities, and explicitly state that no real hardware operation was performed.
