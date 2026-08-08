# DAP-08 CMSIS-DAP RTT Design

## Goal

Enable explicit-address, SEGGER RTT Up Buffer logging for the CMSIS-DAP owner while preserving the existing J-Link RTT path and one-owner routing contract.

## Architecture

The CMSIS-DAP helper owns the RTT transaction. A small `SeggerRttReader` validates the 32-bit little-endian SEGGER RTT layout, reads a bounded byte slice, and commits `RdOff` only after the data read succeeds. It consumes an abstract byte-memory interface so an independent fake-memory oracle can test layout and failure behavior without reusing the production CMSIS-DAP transport.

`startRtt` is a control-priority helper RPC that validates and stores the explicit Control Block address. `readRtt` is a background-priority RPC whose complete read-and-commit transaction is serialized by `NativeScheduler`; `stopRtt` is control-priority and idempotent. The TypeScript owner forwards structured `CppJLinkResult` values through `SessionTargetSelector` and `Commander`, rather than reducing failures to `null` or a boolean.

## RTT layout and validation

- Main SRAM is `[0x20000000, 0x20020000)` for STM32F407VET6; address arithmetic is checked for 32-bit overflow before every access.
- Control Block: `acID[16]`, `MaxNumUpBuffers`, `MaxNumDownBuffers` (24-byte fixed header).
- `RTT_BUFFER`: `sName`, `pBuffer`, `SizeOfBuffer`, `WrOff`, `RdOff`, `Flags` (24 bytes, all fields 32-bit).
- The first 16 bytes must equal `SEGGER RTT`; max buffer counts, selected index, non-zero size, pointer range, and offsets are validated.
- Empty reads return success with zero bytes and never write `RdOff`.
- Wraparound is split into tail and head reads, capped by `rttReadSize`; only confirmed bytes advance `RdOff`.

## Errors and lifecycle

The helper uses stable error codes: `RttInvalidControlBlock`, `RttInvalidBufferIndex`, `RttInvalidBufferLayout`, `RttMemoryReadFailed`, `RttMemoryWriteFailed`, `RttBufferOverrun`, `RttOwnerLost`, `RttStopped`, `RequestCancelled`, `HelperExited`, `DeviceRemoved`, `DapAckWait`, `DapAckFault`, `DapAckNoAck`, and `MalformedResponse`. Every result retains target state, elapsed time, diagnostics, offsets, requested/read/committed byte counts, and wrap/overrun indicators.

The DAP session generation fence stops the timer and prevents stale completions from publishing after stop, disconnect, helper exit, or session replacement. Timeline sampling continues to pause best-effort RTT polling through the existing `dataSamplingActive` guard.

## Verification

1. TypeScript tests cover scheduler priority, owner forwarding, structured Commander results, repeated start/stop, and session fencing.
2. A standalone C++ RTT oracle uses literal SEGGER layout offsets and a fake memory transport to cover malformed blocks, boundaries, wraparound, empty reads, read/write failures, and overrun detection.
3. CMSIS-DAP mock smoke exercises the complete RPC path and confirms bytes and `RdOff` behavior; it remains mock evidence only.
4. Run focused tests, typecheck, full Vitest, bundle/native builds, both mock smoke suites, helper selftest, and `git diff --check`. No real target-mutating hardware operation is run without separate authorization.
