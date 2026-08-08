# CMSIS-DAP v2 WinUSB Report

Date: 2026-08-07

**Status: 未完成，等待具备 WinUSB bulk 接口的新 CMSIS-DAP v2/DAPLink 设备进行硬件验证。**

当前代码、mock、自测和构建已完成；真实 WinUSB enumerate/open/connect、性能矩阵和长稳测试尚未完成。

## Scope and Result

This change adds CMSIS-DAP v2 USB bulk/WinUSB as a transport beneath the existing CMSIS-DAP protocol and target stack. It does not add a DAP protocol implementation, J-Link path, OpenOCD, GDB server, or a second physical target owner.

`auto` enumerates WinUSB first and then HID. `cmsis-dap-v2`/`winusb` selects WinUSB only; `cmsis-dap`/`hid` selects HID only. A failed WinUSB startup returns the CMSIS-DAP error and never falls back to J-Link. HID remains supported.

## Routing and Transport Design

`CmsisDapWinUsbTransport` implements the existing `CmsisDapTransport` interface. It discovers interfaces with SetupAPI, opens them with WinUSB, queries the interface and bulk IN/OUT pipes, and exposes endpoint max-packet sizes separately from the CMSIS-DAP packet capacity. The common `CmsisDapTarget` and protocol layer continue to own `DAP_Transfer`, `DAP_TransferBlock`, ACK/WAIT/FAULT handling, SWD, Cortex-M, Flash Algorithm, Watch, Timeline, RTT, MemoryView, and Peripheral Viewer behavior.

The helper is the one physical CMSIS-DAP owner. `CmsisDapHelperClient` routes all helper RPC through `NativeScheduler`, retaining `control > watch > timeline > background`. Watch, Timeline, and RTT share that owner; no secondary connection is created.

The WinUSB transport handles bounded bulk reads/writes, endpoint discovery, packet-length validation, short and empty reads, stale-input drain, timeout/cancel/late-completion settlement, device removal, and close. A write whose completion is unknown is not retried.

## Evidence Categories

| Category | Evidence | Result |
|---|---|---|
| Code and unit/self-test | Injected `WinUsbIo` fake exercises endpoint discovery, bulk framing, packet-size separation, short read, timeout/cancel/late completion, removal, stale drain, malformed response, and unknown-write no-retry. The same protocol target tests run over scripted HID-like and WinUSB-like transports. | Implemented; not hardware evidence. |
| Mock/raw frame | `npm run test:cmsis-dap:mock` and helper `--selftest` validate CMSIS-DAP framing and error paths. | Protocol and transport mock evidence only. |
| Build | Native helper links `winusb`; TypeScript channel and launch configuration accept the v2 aliases. | Build evidence only. |
| Real hardware | Connected probe `C251:F001`, serial `LU_2022_8888`, product `CMSIS-DAP_LU`, reports HID input/output 65 bytes with report ID 0, CMSIS-DAP packet size 64. It enumerated no WinUSB interface. | HID-only hardware evidence; no v2 hardware acceptance. |
| Estimate | Bulk transport can avoid the HID 64-byte report framing limit when a probe actually exposes CMSIS-DAP v2. | No performance number is claimed without a v2 device. |

## Hardware Matrix

All hardware activity used `D:\STM32\project\vet6_led`; `flashBeforeDebug=false`. The referenced HID DAP-07 sessions used authorized halt/run/pause control to sample a running target, but performed no erase, program, verify, or RAM write. CMSIS-DAP v2 itself did not reach target access because the connected probe exposes no WinUSB interface.

| Probe / transport | VID/PID / serial | Endpoint / packet size | 60-second outcome | Flush Hz | Effective samples per expression per second | Watch success / P95 | Owner cleanup / Flash |
|---|---|---|---|---:|---:|---|---|
| CMSIS-DAP HID, 3 Watch | C251:F001 / LU_2022_8888 | HID 65/65 reports, report ID 0; DAP packet 64 | DPIDR, CTRL/STAT, DP/AP reads, target state, Watch, Timeline complete | 56.624 | 169.741 | 591/591, 13 ms | no residual owner; 0 Flash |
| CMSIS-DAP HID, 6 Watch | C251:F001 / LU_2022_8888 | HID 65/65 reports, report ID 0; DAP packet 64 | DPIDR, CTRL/STAT, DP/AP reads, target state, Watch, Timeline complete | 56.525 | 158.441 | 589/589, 18 ms | no residual owner; 0 Flash |
| CMSIS-DAP v2 WinUSB | C251:F001 / LU_2022_8888 | no WinUSB interface discovered | WinUSB enumeration returned no eligible device | n/a | n/a | n/a | n/a |
| J-Link baseline | unavailable | n/a | connect failed before sampling: `JLinkOpenFailed: JLINK_Open returned -1425101968` | n/a | n/a | n/a | no performance result |

The Timeline flush frequency is the rate of `ozoneDataSamples` deliveries. Effective sample rate is the valid sample count divided by three Timeline expressions and duration; it is deliberately reported separately because each delivery can carry multiple points.

The final independent HID read-only session recorded `DPIDR=0x2BA01477`, `CTRL/STAT=0xF0000000`, `AP CSW=0x23000052`, and `targetState=Halted` with `DHCSR=0x00030003`; it then disconnected and closed. These are HID baseline values, not CMSIS-DAP v2 values.

Hardware evidence files:

- `outputs/dap07/watch-3/2026-08-07-13-09-46/evidence.json`
- `outputs/dap07/watch-6/2026-08-07-13-13-26/evidence.json`
- `outputs/dap07/jlink/watch-3/2026-08-07-13-14-48/evidence.json`

## HID Versus WinUSB

HID wraps a CMSIS-DAP command in a fixed-length report and must account for report ID and report padding. WinUSB sends protocol packets over discovered bulk endpoints, so endpoint maximum-packet length is not assumed to be the CMSIS-DAP packet capacity. WinUSB can reduce framing waste and support larger probe packet capacities, but its actual benefit depends on the probe firmware, USB speed, packet size, SWD clock, target-read behavior, and scheduler load. The connected probe offers only HID, so CMSIS-DAP v2 versus HID uplift is **not measured**.

## Risks and Remaining Work

- Implemented, low-to-medium risk: shared transport interface; one-owner auto selection; injected WinUSB seam; scheduler preservation; endpoint and packet diagnostics; strict non-retry semantics for uncertain writes.
- Not implemented, high risk: performance claims or Flash programming acceptance on a physical WinUSB v2 probe; those require a probe that binds its v2 interface to WinUSB and a separate authorized test matrix.
- Unverified: real WinUSB enumeration/open/connect, endpoint behavior under unplug, long-duration v2 Watch/Timeline/RTT, and v2-vs-HID throughput. The current HID device cannot supply this evidence.

Next hardware step: attach a CMSIS-DAP v2/DAPLink device with a WinUSB-bound bulk interface, run read-only enumerate/open/connect plus DPIDR/CTRL-STAT/DP-AP, then repeat the 3- and 6-Watch 60-second matrix before making any performance comparison.
