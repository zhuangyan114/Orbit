# CMSIS-DAP v2 WinUSB Design

**Goal:** Add CMSIS-DAP v2 USB Bulk/WinUSB transport while preserving the existing HID transport and sharing the current CMSIS-DAP protocol, SWD, Cortex-M, Watch, Timeline, RTT, MemoryView, and Peripheral Viewer paths.

## Architecture

`CmsisDapWinUsbTransport` implements the existing `CmsisDapTransport` contract. It owns only Windows discovery/open/close and bulk I/O framing. `CmsisDapProtocol`, `CmsisDapTarget`, and the existing helper RPC handlers remain transport-agnostic. A `WinUsbIo` interface wraps SetupAPI, file handles, WinUSB initialization, descriptor/pipe queries, synchronous or overlapped bulk operations, cancellation, and final completion settlement for deterministic tests.

The helper transport factory accepts `auto`, `cmsis-dap-v2`/`winusb`, `cmsis-dap`/`hid`, and `mock`. `auto` enumerates WinUSB first and uses HID only when no matching WinUSB device is available. An explicit WinUSB failure is returned to the caller and never falls through to J-Link or a second physical owner. The selected transport is stored in the one helper owner already managed by `SessionTargetChannel`; all requests continue through `NativeScheduler` with `control > watch > timeline > background`.

## WinUSB framing and lifecycle

- SetupAPI enumerates the CMSIS-DAP interface class/path, extracts VID/PID and serial, opens the device path with overlapped access, initializes WinUSB, queries the interface descriptor, and selects bulk IN/OUT pipes.
- CMSIS-DAP packet capacity is derived from `DAP_Info` when available, with a descriptor/configured fallback. Endpoint maximum packet length controls USB transfer chunking only; it is never treated as the protocol packet size.
- Writes reject packets larger than protocol capacity. Reads accept short payloads, reject malformed/truncated responses at the protocol boundary, and drain stale queued input before the first request.
- Read/write timeout, device removal, and handle-close paths cancel pending overlapped work and wait for a definitive `GetOverlappedResult`/WinUSB completion before releasing buffers. Unknown write outcomes are surfaced as `OutcomeUnknown` and are never retried.

## Configuration and diagnostics

Launch configuration exposes `cmsisDapTransport: auto | cmsis-dap-v2 | cmsis-dap | hid` plus path, VID, PID, and serial selectors. RPC results expose `transport`, endpoint addresses, endpoint packet sizes, protocol packet size/source, and stable WinUSB error codes. TypeScript unions mirror the native error/diagnostic contract.

## Verification

The native self-test injects a fake WinUSB backend and covers endpoint discovery, packet-size separation, bulk read/write, short/empty reads, timeout/cancel/late completion, removal, stale drain, malformed responses, and no-resend on unknown writes. Protocol golden tests run the same `CmsisDapProtocol` cases with HID and WinUSB scripted transports. Builds and existing CMSIS-DAP mock/algorithm tests are required before authorized hardware validation in `D:\\STM32\\project\\vet6_led`; hardware runs record owner, probe identity, DPIDR, target state, Watch/Timeline metrics, disconnect cleanup, and any target-mutating operation.

## Known limits

WinUSB support depends on a CMSIS-DAP v2 interface with a usable WinUSB driver and bulk endpoints. Devices exposing only HID remain on the HID path. No claim of real-device performance is made from mocks or builds; measurements without hardware evidence are labelled estimates.
