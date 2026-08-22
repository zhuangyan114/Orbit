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
