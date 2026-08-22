# Orbit Automation Live Memory Access Design

## Scope

Only `orbit.memory.read` and `orbit.memory.write` change. Standard DAP
`readMemory` / `writeMemory` requests used by MemoryView keep their existing
halt/resume behavior.

## Behavior

- Automation memory reads and writes use the exact active session owner.
- When the target is running, Automation memory access does not query target
  state, halt the CPU, or resume it afterwards.
- Reads remain bounded background work. Writes and verify read-back remain one
  control critical section so Watch, Timeline, RTT background work, and other
  owner requests cannot interleave with the mutation.
- A live-access failure is returned as a structured Automation error. The
  implementation must not retry by halting the target or by using another
  owner/backend.
- Running firmware can mutate the same bytes concurrently. Large reads are not
  atomic snapshots, and write verification may return `verified:false` when
  firmware changes the bytes before read-back.

## Implementation Boundary

Add an optional live-access mode to the internal `OzoneCommand` memory read and
write variants. Only the Automation DAP bridge sets it. `OzoneBackend` skips
its halt/delay/resume wrapper in that mode and otherwise preserves the current
MemoryView-compatible path.

## Verification

- DAP Automation tests assert read, write, and verify commands request live
  access and do not restart the run-state poll loop.
- Backend tests assert live access performs owner read/write without state,
  halt, or run calls, while default memory commands retain existing behavior.
- Focused DAP/backend tests, typecheck, build, full Vitest, and native mock suites
  must pass before hardware validation.
- Real hardware acceptance repeats the Task 9 periodic running-state reads and
  confirms the CPU stays running and Timeline has no API-correlated gaps.
