# Ozone for VS Code — Agent Guide

## Build & verify order

```bash
npm run build          # esbuild → dist/extension.js + dist/webview.js
npm run typecheck      # tsc --noEmit (separate from build)
npm run dev            # build + launch extension host window
```

F5 in VS Code: "Run Extension" (build first) or "Extension + Watch" (esbuild watch mode).

`npm test` (vitest) is configured but no tests exist yet.

## Architecture

**Entrypoints**: `src/extension.ts` (Node host) + `src/webview/main.tsx` (React browser iife) + `src/debugadapter.ts` (standalone Node.js debug adapter process).

**Single shared `OzoneBackend`** instance is passed to all providers in `activate()` (`src/extension.ts:20-26`). Never create additional `OzoneBackend` instances.

**Backend**: `OzoneBackend` wraps `JLinkDLL` which calls JLink_x64.dll directly via koffi FFI. NO ozonede.exe child process. Commands go through `OzoneCommand` discriminated union (`src/ozone-backend/types.ts:71-89`).

**Communication layers**:
- Extension ↔ Debug: `OzoneBackend` → `JLinkDLL` (koffi FFI). Symbol resolution via `arm-none-eabi-nm.exe` (child process).
- WebView ↔ Extension: `postMessage` bridge. WebView sends `{ command: string }` → `webview-provider.ts` routes to VS Code commands. Extension posts `{ command: 'refresh' | 'showAIPanel' | 'showMemoryPanel' }` to WebView.
- WebView CSP: `style-src 'unsafe-inline'`; `script-src 'unsafe-eval'`.

**DAP integration** (`src/debug/`):
- `ozone-debug-config.ts`: DebugConfigurationProvider — resolves launch.json configs
- `ozone-debug-adapter.ts`: Thin wrapper around `DapSession` for inline usage (kept for reference)
- `dap-session.ts`: Core DAP command handler, framework-agnostic (no `vscode` dependency)
- `debugadapter.ts` (entrypoint): Standalone Node.js process — built to `dist/debugadapter.js`, runs via `package.json` `runtime: "node"` + `program: "./dist/debugadapter.js"` (same pattern as Cortex-Debug)
- DAP flow: F5 → resolveDebugConfiguration → spawn debugadapter.js (flash if enabled, pre-load symbols + line/address maps) → handleLaunch (connect JLink → halt → initialized) → VS Code sets breakpoints → handleConfigurationDone (sends `stopped` event) → user can step/continue
- **Why separate process**: child_process calls (`spawn`, `execFile`, `execSync`) crash VS Code extension host when called from `DebugAdapterInlineImplementation`. Running the debug adapter in a separate process (via `DebugAdapterExecutable`) isolates crashes and allows child_process calls to work safely.

**View registrations** (`package.json`):
- Activity bar container: `ozone-debug`
- WebView view: `ozoneDebugSession` (React app)
- Tree views: `ozoneBreakpoints`, `ozoneCallStack`, `ozoneVariables`, `ozoneRegisters`
- Note: `ozoneRegisters` and `ozoneVariables` both use `VariableProvider` as their data provider

## Key conventions

- **All commands** prefixed `ozone.*` and registered in `extension.ts:29-40`
- **Settings** under `ozone.*` in package.json (`ozonePath`, `jlinkPath`, `ozone.ai.*`, etc.)
- **DAP debugger type**: `ozone` — registered in package.json `debuggers` contribution
- **Windows-only** — JLink_x64.dll is Win64 DLL; koffi externalized in esbuild (`external: ['vscode', 'koffi']`)
- **Activation**: `onDebug`, `onCommand:ozone.startSession`, `onView:ozoneDebugSession`
- **Separate process DAP adapter**: `DebugAdapterExecutable` (spawns `debugadapter.js` as standalone Node.js process, like Cortex-Debug)

## AI system

**Provider interface** at `src/ai/types.ts:12-18`, `AIProviderManager` at `src/ai/ai-provider-manager.ts`. Configured via VS Code settings `ozone.ai.*`. Two built-in providers: Ollama (`ollama-provider.ts`) and OpenAI-compatible (`openai-compatible-provider.ts`). To add a new provider: implement `AIProvider` interface and add a case in `AIProviderManager.initProvider()`.

## Debugging

- Launch configs in `.vscode/launch.json` — both use `--extensionDevelopmentPath=${workspaceFolder}`
- `OzoneCommandResult` is always `{ ok: true, data } | { ok: false, error }` — every consumer must check `.ok`
- Error state set to `TargetState.Error` on any exception in `execute()`
- Debug adapter logs to `debugadapter.log` in extension root via `daLog()` helper

## Critical pitfalls / known issues

### JLink DLL quirks
- `JLINK_SetBP(uint32, const char*)` hangs indefinitely — must use `ExecCommand("SetBP 0x...")` instead
- **ACTUAL**: `ExecCommand("SetBP 0x...")` also hangs on JLink V956. Using `JLINK_SetBP(uint32_t Index, uint32_t Addr)` with correct parameter order (Index first, Addr second) works. Uses `JLINK_ClrBP(uint32_t Handle)` for clearing.
- `JLINK_ReadReg(int, uint32*)` two-param version doesn't fill buffer — use single-param `JLINK_ReadReg(int)`, return value IS the register value
- `JLINK_Disconnect` does NOT exist — use `JLINK_Close()` for disconnection
- `JLINK_Close()` before `JLINK_Open()` causes access violation (segfault) → VS Code crash
- **connect() failure paths**: must call `this.close()` (which nulls `this.lib`) instead of direct `JLINK_Close()`, to prevent double-close and stale `this.lib` on reconnect
- **disconnect()**: does NOT call `this.close()` — `JLINK_Close()` is never called during normal disconnect. `this.lib` stays alive, `_wasOpened` stays true. On reconnect, `connect()` skips `JLINK_Open()` and only reconfigures (device/speed/TIF/Connect). This prevents the `JLINK_Close()` → `JLINK_Open()` crash.
- **`JLINK_Go()` on V956 does NOT auto-step-over breakpoints**: When the CPU is halted at a breakpoint address, `JLINK_Go()` should step over the instruction and then continue execution. On V956, this does NOT work — the CPU stays at the breakpoint forever. Workaround: `handleContinue` reads PC, clears BP at PC, calls `step()`, re-sets BP at PC (only if clear succeeded), then calls `run()`.
- **`ExecCommand("SetBP ...")` hangs on JLink V956** — not used, using `JLINK_SetBP` instead.
- **Breakpoints can be set while CPU is running**: Cortex-M4 FPB registers accessible via AHB-AP. `setBreakpoint()` does NOT call `halt()` first — this allows setting breakpoints during execution without stopping the CPU at the wrong location.
- **`clearBreakpoint()` calls `halt()` first**: `JLINK_ClrBP` may require CPU halted. Called before clearing.

### `JLINK_ReadReg()` hangs after step/continue
- `JLINK_ReadReg()` hangs when called after `JLINK_Step()` or `JLINK_Go()` (breakpoint hit). The DLL internal state is not properly synced after these operations.
- `readMemory`/`readMemoryU32` also returns wrong/stale data after `JLINK_Step()`.
- **CURRENT FIX**: `ensureHalted()` helper calls `halt()` then polls `isHalted()` every 50ms up to 10 times (500ms max). After `ensureHalted()`, a 100ms delay is added before reading registers in `doGetCallStack`, `doGetRegisters`, `doReadRegister`. `doStepOver` uses 10ms delay.
- **`readMemoryU32` corrupts DLL**: calling `readMemoryU32` makes subsequent `readRegister` calls hang. Removed from `doGetCallStack` (stack scanning) and `doGetLocals` (local variable reads). `doGetCallStack` only returns PC + LR frames. `doGetLocals` only returns symbol names.
- **`readRegisterDAP` (DCRSR/DCRDR) DOES NOT WORK on V956**: Attempted to read CPU registers via debug memory-mapped registers (0xE000EDF4/0xE000EDF8) using `JLINK_WriteMemU32`/`JLINK_ReadMemU32`. Returns null for all registers. Still defined in code but not used.
- **SCOPE**: `src/ozone-backend/commander.ts` (doGetCallStack/doGetRegisters/doGetLocals/doReadRegister/doStepOver), `src/ozone-backend/jlink-dll.ts` (readRegisterDAP - unused), `src/debug/dap-session.ts` (handleContinue step-before-run)

### Breakpoint function signature
- `JLINK_SetBP` parameter order is `(Index, Addr)` not `(Addr, Flags)`. First param is breakpoint slot index (0-5 for Cortex-M4).
- **FIXED**: `JLinkDLL` tracks 6 hardware breakpoint slots via `bpSlots: (number | null)[]` (stores address per slot, null = free). `JLINK_ClrBP(uint32_t)` for clearing.
- `clearAllBreakpoints()` clears all 6 slots unconditionally (not just tracked ones) to prevent ghost breakpoints from previous sessions.
- `setBreakpoint()` does NOT halt CPU before setting — Cortex-M4 FPB accessible while running.
- `clearBreakpoint()` calls `halt()` first — `JLINK_ClrBP` may require CPU halted.

## Current state & scope

### Working
- JLink DLL connect/disconnect/halt/run/step/reset via koffi FFI
- Register read (R0-R15, xPSR) — after `ensureHalted()` + 100ms delay
- Memory read
- Breakpoint set/clear via `JLINK_SetBP`/`JLINK_ClrBP`
- Ghost breakpoint cleanup: `doConnect()` calls `halt()` + `clearAllBreakpoints()` (all 6 slots)
- `bpSlots` is `(number | null)[]` — stores breakpoint address per slot
- Breakpoint cancel: `handleSetBreakpoints` tracks `file:line → bpIndex`, clears old before setting new
- Restart clears breakpoints: `handleRestart` calls `clearAllBreakpoints()` + `this.breakpoints.clear()`
- `handleContinue`: reads PC, clears BP at PC, steps, re-sets BP (only if clear succeeded)
- ELF symbol loading + DWARF line/address pre-computation
- DAP: launch → flash → connect → clearAllBreakpoints → loadSymbols → halt → initialized (no crash)
- Breakpoints set in VS Code gutter
- Pause works
- Restart works
- Auto-flash before debug
- `nm -S` output parsing fixed
- `addr2line` path → `objdump decodedline` filename resolution
- Multiple debug sessions: `disconnect()` no longer calls `JLINK_Close()`, `connect()` skips `JLINK_Open()` on reconnect via `_wasOpened` flag

### Step-over (逐过程) implementation
- `doStepOver()` detects BL/BLX/BLX Rm instructions via `readMemory(pc, 4)`:
  - BL (Thumb2): `hw1 & 0xF800 == 0xF000 && hw2 & 0xD000 == 0xD000`
  - BLX label (Thumb2): `hw1 & 0xF800 == 0xF000 && hw2 & 0xD000 == 0xC000`
  - BLX Rm (Thumb 16-bit): `hw1 & 0xFF87 == 0x4780`
- For call instructions: `clearCurrentBpAndTrack(pc)` then `setTempBpAndRun(returnAddr)`
- For non-call instructions: **smart step** — `doSingleStep()` repeatedly (up to 20×) until source line changes or a BL/BLX is hit. This handles multiple-instruction-per-line cases (e.g., function argument setup before BL).
- `doStepInto()`: hardware single step (`JLINK_Step()`) after `clearCurrentBpAndTrack(pc)`.
- `doStepOut()`: reads LR, sets temp BP at `(LR & ~1)` (clear Thumb bit), runs until hit. Falls back to single step if LR is invalid (0xFFFFFFFF, exception handler range, etc.).
- `handleStep` response: sent immediately after step command returns, then polls `isHalted()` every 10ms × 50 (500ms), falls back to background polling (200ms). This is necessary because `JLINK_Step()`/`JLINK_Go()` don't reliably sync DLL state — `isHalted()` may return false even after step succeeds. Background polling eventually catches up.
- `doSingleStep()`: after `JLINK_Step()` succeeds, calls `JLINK_Halt()` + 10ms wait to force DLL state sync. Retries up to 5× on failure.

### Fixed race conditions / bugs
- **`currentCommand` race (`dap-session.ts:30`)**: Removed shared mutable `this.currentCommand`. `sendResponse` now accepts `msg: DebugProtocolMessage` and reads `msg.command` directly. Eliminates concurrent `variables`/`scopes` requests overwriting the command name in step responses.
- **`restoreClearedBps` concurrent interference (`commander.ts:325`)**: Extracted bp cleanup from `ensureHalted()` into `cleanupStepBreakpoints()`. Only step operations (`doStepOver`, `doStepInto`, `doStepOut`) call it. `doGetCallStack`/`doGetRegisters`/`doGetLocals` no longer restore breakpoints while a step is in progress.
- **Concurrent `JLINK_Halt()` during step (`commander.ts:222,253,274`)**: `doGetCallStack`, `doGetRegisters`, `doGetLocals` changed to soft-check `jlink.isHalted()` instead of calling `ensureHalted()` (which calls `JLINK_Halt()`). Returns empty data if CPU is running — prevents halting the CPU inside a function's loop (e.g., `HAL_Delay` while-loop) during a concurrent stack trace.

### Partially working / unstable
- **Step-over (逐过程)**: Reliable after smart-step fix. Single-instruction lines (BL, simple ALU) complete in ~10ms. Multi-instruction lines (function arg setup) may take 110ms per instruction × N. No longer requires repeated clicks — smart step auto-advances until line changes.
- **`readMemory`/`readRegister` after `step()`**: DLL returns wrong/stale data after `JLINK_Step()`. Workaround: `ensureHalted()` + 10ms delay before reads in `doStepOver`, 100ms delay in `doGetCallStack`/`doGetRegisters`/`doReadRegister`.
- **`readMemory` in `doStepOver` not reliable**: after `step()`, `readMemory` may return wrong instruction bytes, causing BL detection to misidentify instructions. Falls back to `step()` on failure. Smart step re-reads at each new PC — safer.
- **`evaluate` (hover/watch)**: returns `?` without DLL calls to avoid `readMemoryU32` hangs.
- **`doGetLocals`**: returns symbol names/addresses only, no memory reads (avoids DLL corruption).
- **`doGetCallStack`**: returns PC + LR frames only, no stack scanning (avoids `readMemoryU32` DLL corruption).

### Known bugs
- `ExecCommand("SetBP ...")` hangs on JLink V956 — not used, using `JLINK_SetBP` instead
- `readRegisterDAP` (DCRSR/DCRDR) returns null for all registers on V956
- `JLINK_Go()` on V956 doesn't auto-step-over breakpoint instructions — workaround: `handleContinue` clears BP at PC, steps, re-sets BP
- `JLINK_ReadReg()` hangs after `JLINK_Step()` or `JLINK_Go()` — DLL-level bug, workaround: `halt()` + delay before reads. `doSingleStep()` mitigates by calling `JLINK_Halt()` + 10ms after each step.
- `JLINK_Close()` before `JLINK_Open()` causes access violation — workaround: `disconnect()` doesn't call `JLINK_Close()`, `connect()` skips `JLINK_Open()` on reconnect
- `readMemoryU32` corrupts DLL state for subsequent `readRegister` calls — removed from `doGetCallStack`/`doGetLocals`
- `objdump --dwarf=decodedline` has duplicate entries with invalid addresses — filtered out

## Watch system

### Architecture
- **`evaluateExpression` command** (`src/ozone-backend/commander.ts:652-717`): Reads memory at symbol address. `force: true` skips halt check for polling reads. Caller manages halt/resume.
- **DAP evaluate** (`src/debug/dap-session.ts:464-480`): Returns real values to VS Code WATCH section when stopped. Auto-captures `context === 'watch'` expressions.
- **Watch polling** (`src/debug/dap-session.ts:70-130`): Combined 5Hz timer — checks breakpoints, then halts → batch reads all watch expressions → resumes. Uses `setTimeout` recursion (no overlap).
- **Polling halt+delay quirk**: After `halt()`, poll `isHalted()` up to 500ms then wait 100ms for DLL stabilization. Without this, `doEvaluateExpression` may return `{ error: 'running' }` because Jlink_Halt is async.
- **Polling race guard**: Every `await` in `pollLoop` checks `this.pollTimer === null` to abort if `stopPolling()` was called externally (e.g., Restart). `stopPolling()` in the halted path is called AFTER `sendEvent('stopped')` to avoid swallowing the stopped event.
- **WatchProvider** (`src/debug-providers/watch-provider.ts`): TreeDataProvider for `ozoneWatch` view. Tracks previous values for change highlighting (`debug-stackframe-dot` icon). Preserves last-known values when CPU is running.
- **Communication**: DAP adapter sends watch values via `output` event (`category: 'ozoneWatch'`). Extension's `DebugAdapterTracker` intercepts and updates WatchProvider.
- **Persistence**: Watch expressions saved to `workspaceState` via `saveWatchExpressions()` in extension.ts, restored on activation.

### Flow
```
VS Code WATCH section (stopped) → handleEvaluate → evaluateExpression → return value
Ozone Watch tree view (running)  → combined poll → halt → batch read → resume → output event → WatchProvider → tree view
Auto-capture                     → handleEvaluate adds expr to watchExpressions → next poll picks it up
```

### F5 watch sync fix
`DebugAdapterTracker` in `extension.ts` catches `stopped` event → calls `syncWatchesToDap()` (NOT `watchEvaluate` directly). `syncWatchesToDap()` sends `setWatches` (populates DAP session's `this.watchExpressions`) then `watchEvaluate` (one-shot read). This ensures polling loop has expressions to read when user clicks Continue. Without this, `this.watchExpressions` stays empty → polling skips (`pollLoop: no watch expressions, skipping`).

### Key files
- `src/ozone-backend/types.ts:65-73` — WatchValue interface, evaluateExpression command
- `src/ozone-backend/commander.ts:652-717` — doEvaluateExpression implementation
- `src/debug/dap-session.ts:70-130` — combined polling loop
- `src/debug/dap-session.ts:464-480` — handleEvaluate (VS Code WATCH)
- `src/debug/dap-session.ts:482-510` — handleWatchEvaluate (batch custom request)
- `src/debug-providers/watch-provider.ts` — WatchProvider tree data provider
- `src/extension.ts:100-114,163-165` — WatchProvider setup, persistence, syncWatchesToDap

### Struct / DWARF support
- **DWARF parsing** (`src/ozone-backend/jlink-symbols.ts:109-296`): `parseDwarfTypeInfo()` runs `arm-none-eabi-objdump --dwarf=info` and parses DIEs recursively (depth 0/1/2+). Extracts `DW_TAG_structure_type` (including anonymous/unnamed structs from `typedef struct {} name`), `DW_TAG_member`, `DW_TAG_typedef`, `DW_TAG_base_type`, `DW_TAG_variable`.
- **DWARF 5**: Offsets use lowercase normalization (`0xb4` not `0xB4`). Attribute names with `(indirect string, offset: 0x...)` prefix are extracted to get the actual name.
- **Struct evaluation** (`commander.ts:819-863`): `evaluateSingleField()` uses `resolveDwarfType()` to resolve typedef chains and get correct `byteSize` per field. Nested structs are recursively parsed.
- **Tree view** (`watch-provider.ts:24-41`): `getChildren(element?)` returns struct field children. `CollapsibleState.Collapsed` for struct rows. Field labels show short name (e.g., `b` not `ab.b`).
- **Change highlighting**: Always shows `circle-outline` icon (maintains consistent spacing). Changes to `circle-filled` + `debugIcon.startForeground` green when value changes.

### Known limitations
- VS Code native WATCH section only updates when debuggee is stopped (DAP protocol limit)
- Ozone Watch tree view updates at both running and stopped states
- `doGetLocals()` now reads actual memory values (fixed from showing addresses only)
- Struct display only works for global/static variables with DWARF debug info (compiled with `-g`)
- Pointer dereferencing not yet supported (shows address only)

## UI contributions

### Commands
| command | keybinding | description |
|---|---|---|
| `ozone.flashAndRestart` | `Ctrl+Shift+F5` | Flash → reset → run |
| `ozone.addWatch` | — | Add expression to Ozone Watch |
| `ozone.removeWatch` | — | Remove from Ozone Watch |

### Views
- `ozoneWatch` — Ozone Watch tree view with + button in title, inline delete on hover

## Current state & scope

### Working
- All features from previous version (connect/disconnect/halt/run/step/reset, breakpoints, registers, memory, step-over)
- **DAP evaluate** returns real expression values (fixed)
- **doGetLocals** reads actual memory values (fixed)
- **Ozone Watch tree view** with 5Hz polling while running
- **Auto-capture** VS Code WATCH expressions into polling
- **Persistence** of watch expressions across sessions
- **Change highlighting** when variable value changes
- **Flash → reset → halt** on F5 launch

### Partially working / unstable
- Step-over (逐过程) — see previous notes

## Resources

- `resources/breakpoint.svg` — gutter icon for breakpoints (created)
- `resources/icon.png` — extension icon (created, 128x128 PNG)
- CSS uses VS Code CSS variables (`--vscode-sideBar-background`, etc.) — never hardcode colors