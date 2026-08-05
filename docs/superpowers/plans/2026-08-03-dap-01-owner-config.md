# DAP-01 Owner and Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add CMSIS-DAP launch configuration and a distinct single-owner skeleton while preserving the existing J-Link default path.

**Architecture:** Keep launch normalization pure and shared through backend types. `DapSession` owns the flash-before-connect decision, while `SessionTargetSelector` chooses exactly one owner from `probe`; CMSIS-DAP currently returns structured `UnsupportedCapability` results and never falls back to J-Link.

**Tech Stack:** TypeScript, Vitest, VS Code DAP, existing `SessionTargetSelector` and `OzoneBackend`.

## Global Constraints

- `probe` defaults to `jlink`.
- `cmsisDapTransport` defaults to `auto`; `hid` and `winusb` remain representable.
- `flashBeforeDebug` defaults to `true`; explicit `false` is preserved end-to-end.
- CMSIS-DAP does not create a fake helper, connect empty, or fall back to J-Link.
- One DAP session has one physical owner; owner loss terminates the session rather than hot-switching.
- Do not modify `dist/`, `docs/bug-fix-log.md`, or target hardware state.

### Task 1: Lock configuration and owner behavior with failing tests

**Files:**
- Create: `src/debug/dap-launch-config.test.ts`
- Modify: `src/ozone-backend/session-target-channel.test.ts`
- Modify: `src/debug/dap-session-native-executor.test.ts`

- [x] Add assertions for default J-Link configuration, CMSIS-DAP transport/serial/VID/PID preservation, CMSIS-DAP no-fallback selection, and explicit `flashBeforeDebug: false` forwarding.
- [x] Run the focused Vitest files and confirm they fail because the new fields and owner branch do not exist.

### Task 2: Implement the pure configuration and owner skeleton

**Files:**
- Create: `src/debug/dap-launch-config.ts`
- Modify: `src/debug/ozone-debug-config.ts`
- Modify: `src/ozone-backend/types.ts`
- Modify: `src/ozone-backend/session-target-channel.ts`
- Modify: `src/ozone-backend/cpp-jlink-channel.ts`

- [x] Add normalized probe/transport types and preserve optional selector strings.
- [x] Add `CmsisDapTargetChannel` with `kind: 'cmsis-dap'`; every unimplemented operation returns `errorCode: 'UnsupportedCapability'`.
- [x] Add a third selector factory and route `probe: 'cmsis-dap'` without constructing either J-Link owner.
- [x] Keep native owner loss and existing J-Link fallback rules unchanged; expose unique owner kinds `jlink-native`, `jlink-legacy`, and `cmsis-dap`.

### Task 3: Wire DAP launch and flash semantics

**Files:**
- Modify: `src/debugadapter.ts`
- Modify: `src/debug/dap-session.ts`
- Modify: `src/ozone-backend/commander.ts`
- Modify: `package.json`

- [x] Pass probe, CMSIS-DAP selectors, flash flag, and existing J-Link fields into the backend connect command.
- [x] Return `UnsupportedCapability` before any flash command for CMSIS-DAP with default flash enabled.
- [x] Guard direct `flash` commands carrying `probe: 'cmsis-dap'` before the J-Link flasher.
- [x] Preserve explicit false and report the CMSIS-DAP helper capability error without J-Link fallback.
- [x] Declare the new launch properties in the debugger contribution schema.

### Task 4: Verify the scoped implementation

- [x] Run focused Vitest files: 3 files, 14 tests passed; after adding operation coverage the full suite reports 20 files, 99 tests passed.
- [x] Run `npm run typecheck`: exit code 0.
- [x] Run `npm test`: 20 files and 99 tests passed.
- [x] Run `npm run build`: exit code 0.
- [x] Run `git diff --check`: no output; target hardware actions were not executed.
