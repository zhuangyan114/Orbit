# Orbit for VS Code - Agent Guide

## Scope and Working Tree

- This is a Windows VS Code extension. The supported target access stacks are J-Link (native C++ helper or in-process `koffi` legacy channel) and CMSIS-DAP/DAPLink (dedicated native C++ helper over WinUSB v2 or HID v1). Do not add OpenOCD, a GDB server, Ozone GUI automation, or `JLink.exe` as a normal debug-control path.
- The worktree may already contain user changes. Preserve them. Do not revert, overwrite, stage, or otherwise change unrelated files.
- Source is under `src/` and `native/`; do not manually edit generated `dist/` bundles.
- Before changing a debugging bug, load `.agent/skills/ozone-debug-fix/SKILL.md`.
- Before inspecting, changing, diagnosing, or verifying any DAPLink/CMSIS-DAP path, also load `.agent/skills/daplink-debug-fix/SKILL.md`.

## Build and Test

- `npm install` installs the locked dependencies (`package-lock.json` is committed).
- `npm run build` bundles `dist/{extension,debugadapter,webview,timeline,watch}.js`.
- `npm run typecheck` runs `tsc --noEmit`; `npm test` runs Vitest.
- `npm run build:native` builds `out/native/win32-x64/orbit-jlink-helper.exe`.
- `npm run test:cpp-channel:mock` exercises the helper channel against the mock DLL. It is not hardware validation.
- `npm run build:native` also builds `out/native/win32-x64/orbit-cmsis-dap-helper.exe`; `npm run test:cmsis-dap:mock` and `npm run test:cmsis-dap:algorithm` cover the CMSIS-DAP protocol/helper and Flash Algorithm paths. They are not hardware validation.
- Watch/Timeline and stopped-state DAP changes have focused coverage in `src/debug/dap-session-realtime-variables.test.ts`, `src/debug/dap-session-scopes.test.ts`, `src/ozone-backend/native-scheduler.test.ts`, and `src/utils/watch-expression-validation.test.ts`; run the focused tests before the full suite when iterating on those paths.
- `npm run watch`, `npm run dev`, and `npm run mcp` respectively watch bundles, launch Extension Development Host, and start the local MCP client.
- Do not run target-mutating hardware commands without explicit user authorization.

## Process and Native Boundary

- Extension host (`src/extension.ts`) and DAP adapter (`src/debugadapter.ts`) are separate processes with separate backends. The DAP entrypoint communicates over stdio using DAP `Content-Length` frames; it must remain free of `vscode` imports in `src/debug/dap-session.ts`.
- `native/jlink-helper/src/main.cpp` is a Windows child process with the J-Link DLL loaded inside it. `ExperimentalCppJLinkChannel` owns its JSON-lines protocol, lifecycle, and process exit. Keep protocol version/capability changes synchronized with `src/ozone-backend/cpp-jlink-channel.ts`.
- `native/cmsis-dap-helper/src/main.cpp` is the separate Windows CMSIS-DAP child process. `CmsisDapHelperClient` and `CmsisDapTargetChannel` own its JSON-lines protocol, HID/WinUSB lifecycle, SWD/DP/AP access, Cortex-M control, Flash Algorithm execution, memory transport, and process exit. Keep protocol and capability changes synchronized with `src/ozone-backend/cmsis-dap-helper-channel.ts` and `src/ozone-backend/session-target-channel.ts`.
- The legacy channel loads `JLink_x64.dll` through `koffi`. Preserve the existing J-Link safety rules: six slot-indexed hardware breakpoints, no `ExecCommand("SetBP ...")`, no new `readMemoryU32` register/stack/local flows, and existing synchronization after run/step.
- Do not use `JLINK_Close()`/open as an owner switch. In particular, `JLinkDLL.disconnect()` must not close the DLL just to reconnect.

## One Target Owner per Debug Session

- `SessionTargetSelector` is the sole physical target-owner selector. A session has exactly one owner: `jlink-native`, `jlink-legacy`, or `cmsis-dap`.
- `probe: 'cmsis-dap'` creates only the CMSIS-DAP helper owner. It must never construct or fall back to a J-Link native/legacy owner or a second CMSIS-DAP helper. An established CMSIS-DAP owner loss ends the session after disposal; reconnect through a new session.
- When the native path is preferred, create and connect the helper first. Construct the legacy owner only after a failed native owner has fully disposed and its process has exited.
- Legacy fallback is allowed only when native startup fails or the current native owner reports `NativeOwnerLost`. The selector disposes the failed native process, reconnects legacy with the saved config, clears/restores tracked breakpoint slots, then publishes the new owner. Any failed fallback leaves no owner.
- Native source-level step APIs are unavailable on the legacy owner. Do not silently emulate them through a second DLL owner.

## Command, DAP, and Runtime Routing

- `OzoneBackend` dispatches the `OzoneCommand` union. Every `OzoneCommandResult` consumer must test `.ok` before reading `.data` or using success-only fields.
- DAP owns target access while an `orbit` debug session is active; legacy `ozone` is only a compatible session-type alias. `SessionManager` must not connect its extension-host backend in that state.
- `RuntimeRouter` must send target state, reads, and writes to the active Orbit session through `session.customRequest(...)`: `getTargetState`, `dataSample`, and `setWatchValue`. If that request is malformed or fails, return an error for that operation. Never fall back to the extension-host backend while the active DAP session exists.
- Treat the active `vscode.DebugSession` identity as part of the routing contract, not just `isOrbitDebugSessionType(session.type)`. Watch polling, Watch webview requests, and remote Timeline sampling must stop or return an explicit unavailable-session error when that exact session terminates, is replaced, or is still starting; stale async completions must not publish results into a newer session.
- Guard asynchronous Watch polling and remote sampling start/stop transitions with a generation/session check. Do not start local sampling without an active target connection, and do not accept `ozoneDataSamples` from an inactive session.
- Watch and Timeline webviews persist expressions in `ozoneWatchExpressions` and `ozoneDataSamplingExpressions`. Their reads, writes, and sampling must observe the DAP owner rather than a duplicate backend.
- Normalize expressions at every boundary (`Watch` UI, persisted Watch expressions, DAP `setWatches`, `watchEvaluate`, and `dataSample`): strip Han characters, trim, and drop empty entries. Preserve the remaining punctuation and expression syntax; do not silently invent a different expression.
- RTT start/stop/read must use the selected owner and preserve the configured buffer, polling, target, and ANSI behavior.
- J-Link RTT uses the selected DLL owner. CMSIS-DAP RTT uses target-memory control-block/ring-buffer access through the selected CMSIS-DAP owner; do not call J-Link RTT APIs or create a second transport for it.

## Concurrency and Realtime Data

- `NativeScheduler` serializes native-owner access. Its dequeue order is `control > watch > timeline > background`; queued Watch/Timeline/background reads may be coalesced or cancelled, but control work is never bypassed.
- RTT polling is background work. `startRtt`, `stopRtt`, and `readRtt` must not compete with Watch/Timeline as an equal-priority stream; a control request pauses both `timeline` and `background` work for its complete critical section.
- Steps, continue/halt/reset, breakpoint changes, and variable writes are control work. They must exclude or pause concurrent Watch, Timeline, and RTT-background reads for their complete critical section, then allow sampling to resume.
- A Watch batch must release the target-read gate between small slices (currently one top-level expression per slice) so Timeline can make progress between Watch reads. Do not repair a step or latency issue by disabling Watch, Timeline, `evaluate`, `variables`, or variable writes.
- Fast Timeline sampling pauses best-effort RTT text polling while active and restores it after sampling stops. Keep RTT Log, Timeline sampling, and future RTOS Trace as distinct logical consumers even when they share the selected physical owner.
- Treat sampling cadence, generation/termination fences, and point retention as performance-sensitive behavior.

## DAP Compatibility Invariants

- Preserve standard DAP `evaluate`, `variables`, expandable `variablesReference` trees, struct/array/pointer children, and `memoryReference` values for RTOS Views.
- Stopped-state `variables` requests for Local and Registers may wait for the control/read handoff (bounded at 1200 ms) instead of returning an immediate empty list. On session termination or an unavailable target read, return a safe empty/error result and never issue a new native read.
- Runtime Watch/Timeline sampling is allowed to read while the target is running through the explicit realtime path; avoid an extra target-state query in that forced path because it serializes the owner and can block Timeline. Ordinary stopped-state DAP Watch refreshes must still respect target state and return cached/running values when reads are deferred.
- Keep `initialize.supportsReadMemoryRequest`, base64 byte-oriented `readMemory`/`writeMemory`, and valid DAP `memoryReference` behavior for MemoryView and Peripheral Viewer. Preserve `deviceName`, `svdFile`, and `svdPath` launch aliases.
- Preserve `probe`, `cmsisDapTransport`, `cmsisDapSerial`, `cmsisDapVid`, `cmsisDapPid`, `cmsisDapPath`, `cmsisDapFlashAlgorithmPath`, `flashBeforeDebug`, and `runToEntryPoint`. `flashBeforeDebug: true` must use the already-selected owner; `false` must not erase, program, verify, or issue Flash-only resets.
- A native source-level `stepInto` must scan/enter calls within the current source-line bounds, rather than regressing to repeated instruction-only UI clicks.
- A native `stepOut` source hint may improve displayed location but must not replace the trusted native PC. The first subsequent source-level step must advance visibly beyond that hint, not consume a visual empty step.
- Preserve user breakpoint ownership and temporary-breakpoint cleanup/restoration across step, step-out, continue-at-current-PC, timeout, and error paths. Trusted native stop PC/state must not be overwritten by stale legacy state.

## Logging, Symbols, and Configuration

- Use `src/utils/logger.ts`: `log.step` for stepping/breakpoints, `log.eval` for expressions/memory/DWARF, `log.dll` for DLL/connectivity, and `log.dap` for DAP/session/Watch traffic. Logs are `outputs/Log/{step,eval,dll,dap}.log`.
- Prefix CMSIS-DAP transport/connectivity diagnostics with `[cmsis-dap]` in the shared categories. Include owner kind, transport, request label, target state, elapsed time, and structured error code where applicable.
- Do not replace the shared categories with ad hoc `console.log` or duplicate logger helpers. Read only the log category relevant to the reported problem.
- ELF/DWARF work belongs in `src/ozone-backend/jlink-symbols.ts`; it requires `arm-none-eabi-nm` and `arm-none-eabi-objdump` on `PATH`.
- The plugin API is loopback HTTP with bearer authentication and publishes `plugin-api-endpoint.json` in extension global storage. The MCP server is a client of that API.
- `docs/bug-fix-log.md` is user history: write a new entry only after the user explicitly confirms the fix, inserting it as the first entry under `## 修改记录`.
