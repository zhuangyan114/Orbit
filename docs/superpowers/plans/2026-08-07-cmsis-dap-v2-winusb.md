# CMSIS-DAP v2 WinUSB Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a tested CMSIS-DAP v2 WinUSB transport and route it through the existing single-owner helper/session architecture.

**Architecture:** Add a concrete WinUSB transport beside HID, with an injectable `WinUsbIo` boundary. Keep CMSIS-DAP protocol and target code shared. Extend helper transport selection and TypeScript configuration/diagnostics without introducing another owner or bypassing `NativeScheduler`.

**Tech Stack:** C++17, Windows SetupAPI/WinUSB, existing JSON-lines helper RPC, TypeScript/Vitest, CMake.

## Global Constraints

- Preserve all pre-existing worktree changes and do not edit generated `dist/` bundles.
- Allowed transport choices are `auto`, `cmsis-dap-v2`/`winusb`, `cmsis-dap`/`hid`, and existing `mock`; never add OpenOCD, a GDB server, `JLink.exe`, or a second physical owner.
- Keep request scheduling `control > watch > timeline > background` and share one target owner for DAP, Watch, Timeline, RTT, MemoryView, and Peripheral Viewer.
- Unknown bulk-write outcomes must not be retried; cancellation must settle before releasing overlapped buffers.
- Hardware testing is authorized only for `D:\\STM32\\project\\vet6_led`; record evidence layers separately and do not call it hardware support without real-device evidence.

### Task 1: WinUSB transport contract and fake seam

**Files:**
- Create: `native/cmsis-dap-helper/src/cmsis_dap_winusb_transport.h`
- Create: `native/cmsis-dap-helper/src/cmsis_dap_winusb_transport.cpp`
- Modify: `native/cmsis-dap-helper/src/cmsis_dap_transport.h`
- Test: `native/cmsis-dap-helper/src/main.cpp` self-test section

- [ ] Define `WinUsbDeviceDescriptor` fields for interface path, VID/PID, serial, interface number, bulk endpoint addresses/max packet lengths, and protocol packet capacity/source.
- [ ] Define `WinUsbIo` methods for SetupAPI enumeration, file/WinUSB lifecycle, `WinUsb_QueryInterfaceSettings`, `WinUsb_QueryPipe`, bulk read/write, cancellation, completion settlement, and stale-input drain.
- [ ] Implement packet-length checks, short/empty reads, removal/error mapping, and no-resend unknown-write semantics.
- [ ] Add fake backend tests for endpoint discovery, packet size, bulk framing, short reads, timeout/cancel/late completion, removal, stale drain, malformed frames, and write outcome classification.

### Task 2: Helper factory, RPC, and build wiring

**Files:**
- Modify: `native/cmsis-dap-helper/CMakeLists.txt`
- Modify: `native/cmsis-dap-helper/src/main.cpp`
- Modify: `native/cmsis-dap-helper/src/cmsis_dap_transport.h`

- [ ] Link `winusb` and compile the new transport.
- [ ] Replace the current WinUSB `not implemented` branch with transport creation and selector-aware `auto` preference.
- [ ] Return WinUSB endpoint and packet diagnostics from `hello`, `enumDevices`, `open`, and transfer results while preserving existing result `.ok` checks.
- [ ] Reject incompatible transport/device combinations without silently selecting J-Link or a second helper.

### Task 3: TypeScript configuration and owner routing

**Files:**
- Modify: `package.json`
- Modify: `src/ozone-backend/cmsis-dap-helper-channel.ts`
- Modify: `src/ozone-backend/session-target-channel.ts`
- Modify: `src/ozone-backend/types.ts`
- Tests: `src/ozone-backend/cmsis-dap-helper-channel.test.ts`, `src/ozone-backend/session-target-channel.test.ts`

- [ ] Mirror native error codes, transport names, device descriptor fields, endpoint diagnostics, and packet-size source in TypeScript.
- [ ] Pass `cmsisDapTransport`, path, VID, PID, and serial through launch/session configuration.
- [ ] Keep one `CmsisDapHelperClient` owner and route all Watch/Timeline/RTT requests through its scheduler.
- [ ] Test `auto`, explicit WinUSB, HID-only, and failed-start behavior.

### Task 4: Shared protocol coverage

**Files:**
- Modify: existing CMSIS-DAP protocol/mock tests in `native/cmsis-dap-helper/src/main.cpp` and `src/ozone-backend/*cmsis-dap*.test.ts`

- [ ] Parameterize the transport fixture so CMSIS-DAP `DAP_Transfer`/`DAP_TransferBlock`, ACK/WAIT/FAULT/NO_ACK, DPIDR, CTRL/STAT, and DP/AP validation execute through both HID and WinUSB implementations.
- [ ] Verify malformed response and packet-size guards remain protocol-layer failures rather than transport truncation.

### Task 5: Verification and report

**Files:**
- Create/modify: `docs/dap07-timeline-performance-report.md` or CMSIS-DAP v2 report
- Optional: `scripts/cmsis-dap/verify-cmsis-dap-v2-hw.js`

- [ ] Run `npm run typecheck`, `npm test -- --run`, `npm run build`, `npm run build:native`, `npm run test:cmsis-dap:mock`, `npm run test:cmsis-dap:algorithm`, `npm run test:cpp-channel:mock`, and `git diff --check`.
- [ ] Run authorized hardware enumeration/open/connect and baseline/WinUSB tests in `D:\\STM32\\project\\vet6_led`, recording endpoint/packet data, DPIDR, target state, three/six Watch, Timeline flush Hz, effective samples/sec, Watch success/P95, 60-second stability, cleanup, and write activity.
- [ ] Separate code, mock/raw-frame, build, hardware, and estimated evidence in the report; do not update `docs/bug-fix-log.md`.
