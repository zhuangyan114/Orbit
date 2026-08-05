# DAP-04 Cortex-M Debug Control Design

## Goal

Add the minimum Cortex-M debug-control surface for the existing CMSIS-DAP owner so a `probe: 'cmsis-dap'` DAP session can read state and registers, halt, run, reset, and execute one instruction step against an STM32F407VET6-class Cortex-M target.

## Boundaries

- The CMSIS-DAP helper remains the only physical owner for CMSIS-DAP sessions.
- The implementation uses the existing SW-DP, MEM-AP, TransferBlock, packet-size, and RDBUFF pipeline.
- Helper-only debug-register writes are allowed; no generic helper `writeMemory` RPC is added.
- J-Link native and legacy behavior is unchanged, and CMSIS-DAP never falls back to J-Link.
- Hardware breakpoints, source-level stepping, memory/variable writes, Flash, RTT, Watch, Timeline, RTOS View, WinUSB, and wireless DAPLink remain unsupported.
- `dist/` and `docs/bug-fix-log.md` are not edited.

## Architecture

`CortexMDebug` owns the Cortex-M register protocol inside `native/cmsis-dap-helper`. It calls internal single-word MEM-AP reads/writes on `CmsisDapTarget` and returns structured results with an operation phase and register/address diagnostics. The JSON-lines dispatcher exposes only `getState`, `halt`, `run`, `reset`, `stepInstruction`, and `readRegister`.

The TypeScript helper client maps these RPC methods to the existing `NativeScheduler` `control` priority. `CmsisDapTargetChannel` maps successful responses into the existing target-channel result shape and preserves helper error codes verbatim. `SessionTargetChannel`, `Commander`, and `DapSession` route basic control through the selected CMSIS-DAP owner while preserving the existing J-Link path and standard DAP events.

## Cortex-M register contract

| Register | Address | Fields used | Operation |
|---|---:|---|---|
| DHCSR | `0xE000EDF0` | `S_HALT` bit 17, `S_REGRDY` bit 16, `C_DEBUGEN` bit 0, `C_HALT` bit 1, `C_STEP` bit 2, `DBGKEY` bits 31:16 | Read state; write halt/run/step with key |
| DCRSR | `0xE000EDF4` | `REGSEL` bits 4:0 | Select R0-R12, R13/SP, R14/LR, R15/PC, R16/xPSR |
| DCRDR | `0xE000EDF8` | 32-bit data | Read selected core register after `S_REGRDY` |
| AIRCR | `0xE000ED0C` | `VECTKEY` bits 31:16, `SYSRESETREQ` bit 2 | Write system reset request |

All control writes use a bounded poll. A write with an unknown completion outcome is returned as `OutcomeUnknown` and is never retried. WAIT, FAULT, NO_ACK, device removal, timeout, helper exit, and post-disconnect invalid state remain structured failures.

## State transitions

- `getState`: read DHCSR from the current owner; return `Halted` when `S_HALT` is set, otherwise `Running`. Include the observed DHCSR and, when the caller requests the control snapshot, a PC read from the same owner.
- `halt`: write `DBGKEY | C_DEBUGEN | C_HALT`, then poll until `S_HALT` is set; return the confirmed state and PC.
- `run`: write `DBGKEY | C_DEBUGEN`, then poll until `S_HALT` is clear; return the confirmed running state.
- `stepInstruction`: require the current state to be halted, read PC, write `DBGKEY | C_DEBUGEN | C_STEP`, poll until halted again, read PC, and return both PCs plus the confirmed state. The mock guarantees a deterministic PC change.
- `reset`: write `VECTKEY | SYSRESETREQ` to AIRCR, read the resulting state from the same owner, and fail if the write or state read fails. It never fabricates a reset result.
- `readRegister`: reject indexes outside 0..16 with `DapInvalidRequest`; write DCRSR, poll `S_REGRDY`, then read DCRDR.

## Mock and selftest

The mock transport models the CoreDebug registers and a deterministic Cortex-M register bank. It records DHCSR writes, exposes halted/running state, increments PC on step, applies the reset state, and supports injected WAIT, FAULT, NO_ACK, timeout, unknown-write, removal, and disconnect outcomes. Existing DAP-03 vector, boundary, 1KB, and packet-size checks remain in the same selftest executable.

## Verification

TDD order is: add focused native/TypeScript tests and observe the expected failure; implement the smallest passing layer; then run the focused mock tests, `npm run typecheck`, `npm test`, `npm run build`, `npm run build:native`, both mock channel commands, the helper selftest, and `git diff --check`. No real hardware command is run.
