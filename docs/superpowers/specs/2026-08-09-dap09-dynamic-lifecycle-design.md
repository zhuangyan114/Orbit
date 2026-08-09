# DAP-09 Dynamic Lifecycle and Session Replacement Design

## Goal

Close the remaining DAP-09 hardware gaps with an explicitly authorized FreeRTOS firmware fixture and two independent CMSIS-DAP session runs.

## Scope

- Modify only the application-owned USER CODE areas in `D:\STM32\project\vet6_led\Core\Src\freertos.c`.
- Build and flash the resulting `build\Debug\vet6_led.elf` through Orbit's CMSIS-DAP owner.
- Capture 20 real dynamic task create/delete rounds through DAP `rtosInfo`, `evaluate`, `variables`, and direct `readMemory`.
- Capture hardware owner cleanup across a first-session termination and a second-session replacement.

## Firmware Fixture

`MX_FREERTOS_Init` creates a controller task named `dap09Lifecycle`. The controller performs 20 rounds. Each round sets `g_dap09_lifecycle_round`, creates one dynamically allocated task named `dap09DynXX`, sets phase `created`, keeps it alive for a bounded window, deletes it, increments the delete counter, sets phase `deleted`, and waits before the next round. The worker increments a volatile runtime marker and delays, so the task is observable as a real FreeRTOS TCB rather than a synthetic variable.

The fixture exposes these stable symbols for DAP reads:

- `g_dap09_lifecycle_round`
- `g_dap09_lifecycle_phase` (`0=idle`, `1=created`, `2=deleted`, `3=complete`)
- `g_dap09_lifecycle_create_count`
- `g_dap09_lifecycle_delete_count`
- `g_dap09_lifecycle_live`
- `g_dap09_lifecycle_worker_counter`

The controller stops mutating after round 20 and remains alive until the debug session ends.

## Hardware Evidence

The lifecycle harness records probe VID/PID/serial, HID report details, DPIDR, owner selection, helper PID, launch configuration, every round's sampled phase and counters, dynamic task name/TCB number when present, and direct-memory cross-checks. It rejects missing rounds, counter regressions, stale task publication after deletion, additional owners, Flash activity outside the authorized launch, and residual helper processes.

The replacement harness launches a first DAP adapter process, starts concurrent Watch/RTOS requests, terminates that session, waits for the helper process to exit, then launches a second process against the same CMSIS-DAP serial. It records first/second owner identities and cleanup results separately; it does not claim that process replacement alone proves same-process VS Code session identity fencing.

## Acceptance Criteria

1. Firmware builds and flashes successfully through CMSIS-DAP.
2. Exactly 20 rounds reach both created and deleted phases.
3. Each created phase exposes a `dap09DynXX` task in RTOS View and each deleted phase removes it before the next round.
4. Create/delete counters and worker counter are monotonic and direct reads match DAP evaluate values.
5. The first hardware session terminates with no stale response publication and no remaining helper process.
6. The replacement session claims the same probe as a single owner, reads RTOS state, and disconnects cleanly.
7. Any unmet criterion remains an explicit DAP-09 acceptance gap.
