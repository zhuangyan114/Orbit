# Ozone for VS Code — Agent Guide

## Verify Commands
- `npm install`; `package-lock.json` is committed.
- `npm run build` bundles all 5 entrypoints via esbuild: `dist/{extension,debugadapter,webview,timeline,watch}.js`.
- `npm run typecheck` = `tsc --noEmit` (separate from build).
- `npm run watch` starts esbuild watch for all 5 bundles.
- `npm run dev` builds + launches VS Code at `.`.
- `npm run mcp` starts the MCP server from `mcp/ozone-mcp-server.js`.
- `npm test` = `vitest run` (no tests currently). `npm run lint` has no ESLint config — does nothing.
- F5 configs in `.vscode/launch.json`: `Run Extension` (preTask `npm: build`), `Extension + Watch` (background `npm: watch`).

## Architecture Boundaries
- This is a Windows-only VS Code extension: `JLink_x64.dll` is loaded via `koffi`; do not introduce an Ozone GUI or JLink.exe child-process control path for normal debug commands.
- Host entrypoint is `src/extension.ts`; DAP entrypoint is `src/debugadapter.ts`; browser bundles are `src/webview/main.tsx`, `src/webview/timeline/main.tsx`, and `src/webview/watch/main.tsx`.
- VS Code launches the debug adapter as a separate Node process from `package.json` debugger `program: "./dist/debugadapter.js"`; DAP adapter reads/writes stdio JSON with `Content-Length:` headers (no HTTP).
- `src/debug/dap-session.ts` is framework-agnostic DAP logic and should not import `vscode`.
- `esbuild.config.js` externals: `koffi` (native FFI, loaded at runtime) and `vscode` (provided by VS Code runtime). Sourcemaps for DAP/timeline/watch bundles are intentionally disabled.
- `OzoneBackend` owns command dispatch through the `OzoneCommand` union in `src/ozone-backend/types.ts`; every `OzoneCommandResult` consumer must check `.ok` before reading `.data`.
- Activation events: `onStartupFinished`, `onView:ozoneWatch`, `onView:ozoneTimeline`, `onDebugResolve:ozone`.
- Plugin API: local HTTP server at `127.0.0.1:{randomPort}`, Bearer token auth, writes endpoint to `globalStorage/plugin-api-endpoint.json`. MCP server (`npm run mcp`) calls it via RPC.

## Logging System
- Shared logger at `src/utils/logger.ts`; writes to `outputs/Log/` (auto-created, gitignored).
- Four categories, each writes to a separate file:

| Import | File | Content |
|---|---|---|
| `log.step(msg)` | `outputs/Log/step.log` | 步进、逐过程、temp BP、断点设置/清除、continue |
| `log.eval(msg)` | `outputs/Log/eval.log` | evaluate expression、内存读写、DWARF 解析错误 |
| `log.dll(msg)` | `outputs/Log/dll.log` | J-Link DLL open/close/connect/device/speed |
| `log.dap(msg)` | `outputs/Log/dap.log` | 启动、polling、Watch、step 命令、会话事件 |

- All categories enabled by default; each line is `HH:MM:SS.mmm [Tag] message`.
- Replace old `console.log('[JLinkDLL] ...')` and duplicate `daLog()` in `commander.ts`/`dap-session.ts` with appropriate category.
- Bug fix log is separate: `docs/bug-fix-log.md`, appended by agent per SKILL.md workflow.

## Runtime Routing
- The extension host and DAP adapter are different processes with different `OzoneBackend` instances; when an active `ozone` debug session exists, watch/data-sampling requests must route through `session.customRequest(...)` instead of directly using the extension-host backend.
- Watch UI is a webview view registered as `ozoneWatch`; Timeline is a webview view registered as `ozoneTimeline`, both under panel containers in `package.json`.
- Watch expressions persist in `workspaceState` key `ozoneWatchExpressions`; data-sampling expressions persist in `ozoneDataSamplingExpressions`.
- Data sampling uses `DataSamplingManager` with 10 ms sample/send intervals and a 50,000 point cap per variable; verify performance-sensitive changes against that cadence.

## MCU Debug Views Compatibility
- Keep the `ozone` debug adapter compatible with mcu-debug MemoryView, Peripheral Viewer, and RTOS Views through standard DAP requests where possible, not plugin-specific UI coupling.
- MemoryView and Peripheral Viewer depend on `initialize` advertising `supportsReadMemoryRequest: true` and on `readMemory` returning base64 data from a valid DAP `memoryReference`. If write support changes, keep `writeMemory` byte-oriented; DAP payloads are base64 bytes, not `uint32[]`.
- Peripheral Viewer expects launch configuration fields such as `deviceName`, `svdFile`, or `svdPath`; preserve the aliases in `package.json` and `src/debug/ozone-debug-config.ts`.
- RTOS Views relies heavily on `evaluate`, `variables`, and expandable `variablesReference` trees. Preserve struct/array/pointer child expansion and `memoryReference` values in `src/debug/dap-session.ts`.
- The command `ozone.enableMcuDebugViews` should only append workspace settings for external tracking (`memory-view.trackDebuggers` and `mcu-debug.rtos-views.trackDebuggers`); do not silently mutate global user settings on activation.

## Skills
- 修 bug 前先加载 `.agent/skills/ozone-debug-fix/SKILL.md`。

## J-Link/DAP Pitfalls
- `JLINK_SetBP` is used as `(slotIndex, address)` with six tracked hardware slots; `ExecCommand("SetBP ...")` is intentionally avoided because it can hang.
- `disconnect()` in `JLinkDLL` must not call `JLINK_Close()`; reconnect relies on the loaded DLL and `_wasOpened` state to avoid close/open crashes.
- Clearing breakpoints may halt the CPU; setting breakpoints intentionally does not halt first.
- After `JLINK_Step()` or `JLINK_Go()`, force DLL synchronization with the existing halt/delay patterns before reading registers or memory.
- Avoid adding new `readMemoryU32`-based register/stack/local-variable flows; this repo treats it as DLL-state-corrupting on affected J-Link versions.
- `handleContinue` works around breakpoints at the current PC by clearing the current BP, stepping once, restoring it, then running.

## Symbols And Debug Data
- ELF symbol and DWARF parsing lives in `src/ozone-backend/jlink-symbols.ts` and depends on `arm-none-eabi-nm` plus `arm-none-eabi-objdump` being on `PATH`.
- Launch/debug config type is `ozone`; default device/interface/speed/program settings are contributed under `ozone.*` in `package.json`.

## Style Notes
- Keep generated `dist/` outputs out of manual edits; source lives under `src/` and esbuild regenerates bundles.
- Preserve VS Code theme variables in webview CSS; avoid hardcoded editor colors.
