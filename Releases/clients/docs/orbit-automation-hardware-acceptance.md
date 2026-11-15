# Orbit Automation API v1 Hardware Acceptance

This document is the Task 16 release record. Automated, Mock, and real-hardware layers are reported separately. A missing layer is `unverified` or `out-of-scope`, never `passed`.

**Task 16 is complete for the authorized 1.1.0 hardware scope.** J-Link native and CMSIS-DAP (HID v1, no flash) passed. J-Link legacy live run and `--flash` were not authorized and are **out of this release**, not deferred as unfinished work.

## Authorization gate

Target-mutating live runs require all of:

```text
node scripts/automation-api/verify-hardware.js --live --authorize --probe <jlink-native|jlink-legacy|cmsis-dap> --board <name>
```

`--flash` is an extra opt-in. Without `--authorize`, `--probe`, and `--board`, the script refuses pause/continue/reset/step/write/flash/RTT start. Mock mode (`--mock`, the CI default) never talks to a probe.

## Layer status (this checkout)

| Layer | Status | Evidence |
|---|---|---|
| Automated (contract, unit, integration, dual-window) | **passed** | Task 15 evidence + `npm test` / `test:automation-*` |
| Mock (J-Link helper + CMSIS-DAP helper) | **passed** | `npm run test:cpp-channel:mock`, `npm run test:cmsis-dap:mock` |
| Hardware J-Link native | **passed** (no flash) | 2026-08-22 authorized live run on `STM32F407VET6`; JSON in `outputs/automation-api/task16-jlink-native-evidence.json` |
| Hardware J-Link legacy | **out-of-scope** | Not authorized for 1.1.0; native-only source step remains `CapabilityUnavailable` and must not spawn a second owner |
| Hardware CMSIS-DAP | **passed** (HID v1, no flash) | 2026-08-22 authorized live run on `STM32F407VET6`; JSON in `outputs/automation-api/task16-cmsis-dap-evidence.json` |
| Explicit `orbit.target.flash` | **out-of-scope** | `--flash` was not granted; `flashBeforeDebug: false` on both live runs |

Do not collapse the table into “all passed”. CMSIS-DAP v2 WinUSB is code/Mock only in this release; live evidence is HID v1.

### J-Link native live run (2026-08-22)

Authorized by the user for the connected J-Link probe. Launch used `Orbit: J-Link (No Flash)` (`flashBeforeDebug: false`). `--flash` was not granted.

| Item | Result |
|---|---|
| Board | STM32F407VET6 (`d:\STM32\project\vet6_led`) |
| Owner | `jlink-native` only; helper pid 29912; `maxConcurrent=1`; no second owner |
| Session | generation 1; visible start, halt at entry, stop, helper gone after disconnect |
| Breakpoints | add/hit/remove on `Core/Src/freertos.c:402` |
| Control | pause, continue, reset, `stepInstruction`, `stepInto`, `stepOver`, `stepOut` |
| Data | `g_ram_data` read/write/restore; memory read/write/verify; Watch/Timeline sync; record; RTT; diagnostics (no token); SSE events |
| Flash | **skipped** |
| Stress | Watch+Timeline+record+RTT with 20 writes; source steps 20×3. `stepOut#1` returned `CapabilityUnavailable` once; no second owner, helper count stayed 1 |
| After stop | helper pid count 0 |

J-Link legacy live run is out of this release.

### CMSIS-DAP live run (2026-08-22)

Authorized by the user after swapping to a DAPLink probe. Launch used `Orbit: DAPLink (No Flash)` (`flashBeforeDebug: false`). `--flash` was not granted. Owner was `cmsis-dap` only; no J-Link helper appeared.

| Item | Result |
|---|---|
| Board | STM32F407VET6 (`d:\STM32\project\vet6_led`) |
| Owner | `cmsis-dap` only; helper pid 9172 (`orbit-cmsis-dap-helper.exe`); `maxConcurrent=1`; no second owner |
| Session | generation 5; visible start, halt at entry, stop, helper gone after disconnect |
| Breakpoints | add/hit/remove on `Core/Src/freertos.c:402` (`pc=0x8004e2e`, `stopReason=breakpoint`) |
| Control | pause, continue, reset, `stepInstruction`, `stepInto`, `stepOver`, `stepOut`. Continue RPC settled as `halted`/`breakpoint` (~1169 ms) because the tight loop hit before the RPC returned; that is a pass, not a failed continue |
| Data | `g_ram_data` read/write/restore; memory read/write/verify; Watch/Timeline sync; record; RTT (target-memory ring buffer); diagnostics (no token); SSE events |
| Flash | **skipped** |
| Stress | Watch+Timeline+record+RTT with 20 writes; source steps 20×3. `stepOut#1` returned `InternalError` once; no second owner, helper count stayed 1 |
| After stop | helper pid count 0 |

J-Link legacy live run and `--flash` are out of this release.

## Required live workflow (when authorized)

Run once per owner (`jlink-native`, `cmsis-dap`). Legacy J-Link only exercises its declared subset; `orbit.target.stepInto` / `stepOver` / `stepOut` must return `CapabilityUnavailable` and must not start a second owner.

1. handshake
2. visible `orbit.session.start`
3. breakpoint add / hit / remove
4. pause, continue, reset
5. `stepInstruction`, `stepInto`, `stepOver`, `stepOut`
6. flash (only with `--flash`)
7. symbol search/resolve
8. variable read/write/verify
9. memory read/write/verify
10. Watch / Timeline bidirectional sync
11. record
12. RTT
13. diagnostics (no token)
14. full SSE lifecycle
15. stop
16. prove `owners.maxConcurrent === 1` and no second helper in the process tree
17. after disconnect: owner count 0, helper gone, endpoint removed or `/health` failed

Every request record must include `instanceId`, `projectId`, `sessionId`, `sessionGeneration`, `ownerKind`, `targetState`, `pc`, `elapsedMs`, `errorCode`. Tokens are stripped.

## Concurrent stress (authorized live only)

While Watch + Timeline + recording + RTT are active:

- 20 variable writes
- 20 `stepInto` / `stepOver` / `stepOut`

Pass only if the target does not stay permanently halted, stale samples are not published, and a second owner never appears.

## Performance gates

Warm-up 100 + measured N. Record CPU / OS / Node / VS Code versions.

| Gate | Boundary | N | p95 limit |
|---|---|---:|---:|
| RPC parse/dispatch | handler call start/end, serial 1 KiB payload | 1,000 | 20 ms |
| DAP custom event → SSE write complete | Extension Host receive to SSE frame write | 100 | 100 ms |
| API control overhead | Extension Host dispatch minus `customRequest` resolve | 100 | 50 ms |

CI (`npm run test:automation-hardware`) records trend only. A release hard gate needs two consecutive rounds on the named acceptance machine, allowing 5% p95 jitter.

## Commands

```powershell
npm run test:automation-contract
npm run test:automation-clients
npm run test:automation-integration
npm run test:automation-acceptance
npm run test:automation-hardware
npm run typecheck
npm run build
npm run build:native
npm test
npm run test:cpp-channel:mock
npm run test:cmsis-dap:mock
```

Live (user-authorized machine only). 1.1.0 ran the first two; legacy and `--flash` stay opt-in:

```powershell
node scripts/automation-api/verify-hardware.js --live --authorize --probe jlink-native --board STM32F407VET6
node scripts/automation-api/verify-hardware.js --live --authorize --probe cmsis-dap --board STM32F407VET6
# out of 1.1.0 scope:
# node scripts/automation-api/verify-hardware.js --live --authorize --probe jlink-legacy --board STM32F407VET6
# node scripts/automation-api/verify-hardware.js --live --authorize --probe cmsis-dap --board STM32F407VET6 --flash
```

## STM32H723VGT6 device support (1.1.2)

Device-support acceptance is separate from the Automation API Task 16 layers above. All levels ran on the same STM32H723VGT6 board. A level is `passed` only with the evidence JSON named below; nothing here collapses into "all passed".

| Level | Scope | Result |
|---|---|---|
| P7-1 | read-only identity: SW-DP DPIDR, DBGMCU_IDCODE, Flash size register, RAM samples | **passed** (CMSIS-DAP, 2026-08-25) |
| P7-2 | RAM stub write/read-back on AXI SRAM, DTCM, D2, D3 | **passed** (CMSIS-DAP, 2026-08-25) |
| P7-3 | Flash Algorithm Init/UnInit round trip | **passed** (CMSIS-DAP, 2026-08-25) |
| P7-4 | authorized test-sector erase/program/verify, then restore `0xFF` | **passed** (CMSIS-DAP, 2026-08-25; last 128 KiB sector ~1.11 s) |
| P7-5 | real ELF `flashBeforeDebug: true` end to end (`h7vgt6_test.elf`) | **passed** (CMSIS-DAP, 2026-08-25) |
| P7-6 | J-Link native owner: connect, `JLink.exe` flash, entry stop, breakpoint hit, Watch evaluate, native source step, AXI SRAM read, disconnect cleanup | **passed** (J-Link V9.56, 2026-09-11) |
| P7-7 | long-run sampling, unplug / helper-crash disconnect behavior | **not verified** |

Evidence JSON is in `outputs/h723-p7/`. The P7-6 run recorded owner `jlink-native` only (helper pid 3844), no legacy or CMSIS-DAP fallback, no leftover helper process; DPIDR `0x6BA02477`, VTref 3.285 V, DBGMCU_IDCODE `0x10016483` (DEV_ID `0x483`, REV_ID `0x1001`), Flash size 1024 KiB, vector table SP `0x20020000` / Reset `0x0801AFD1`. Hardware scripts: `scripts/cmsis-dap/verify-h723-*-hw.js` and `scripts/jlink/verify-h723-jlink-hw.js`; every one refuses without its own `--hardware`/`--authorize-*` flag.

The J-Link path forwards `device` unchanged to the DLL and to `JLink.exe` instead of resolving the CMSIS-DAP flash registry, so it needs a device name the installed J-Link software knows. J-Link V9.56 has no `STM32H723VGT6`; the Commander reports it as unknown, falls back to `STM32H723VG` and can stall the automatic flash on a device-selection dialog until the 30 s flash timeout. Use `"device": "STM32H723VG"` with `probe: "jlink"`.

Verified register facts, sector map, timings, and the Flash Algorithm sources are in [CMSIS-DAP Flash algorithm references](../cmsis-dap-flash-algorithm-references.md).
