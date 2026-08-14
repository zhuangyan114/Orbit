# Orbit Automation API v1

This document freezes the public Orbit Automation API 1.0 protocol. The field-level source of truth is [`orbit-automation-openrpc.json`](orbit-automation-openrpc.json); implementations, SDKs, the optional MCP adapter, and tests must consume that contract without adding private commands or transport-specific escape hatches.

## Scope and invariants

The API exposes the 58 user-level methods in the OpenRPC catalog. It does not expose arbitrary VS Code commands, internal `OzoneCommand` values, J-Link DLL functions, or native-helper RPC. Calls drive the visible VS Code debug session. Mouse/keyboard automation, hidden sessions, a second helper, direct DLL ownership, and fallback to an extension-host target connection while an Orbit DAP session exists are prohibited.

One window may have at most one Orbit-compatible session in `starting|connected|running|halted|terminating`. That session has exactly one physical owner: `jlink-native`, `jlink-legacy`, or `cmsis-dap`. All control, breakpoint, runtime, expression, memory, sampling, recording, RTT, and target diagnostics operations use that exact session and owner. Scheduler priority remains `control > watch > timeline > background`.

VS Code's `vscode.debug.breakpoints` collection is authoritative. API-created breakpoints are ordinary visible user breakpoints. Watch and Timeline methods synchronize with their existing UI state. The API must not disable Watch, Timeline, variables, evaluate, RTT, Memory Viewer, or related DAP behavior to make control calls succeed.

Addresses, timestamps/event IDs, and values requiring 64-bit precision are strings. `registryGeneration` and `sessionGeneration` are safe nonnegative JSON integers. Memory and RTT byte payloads are Base64 and counts are bytes. Expression boundaries perform Unicode-preserving trim and reject an empty result; they never delete Han characters or silently rewrite syntax.

## Discovery and identity

Each Extension Host creates a random `instanceId`, binds only to `127.0.0.1`, creates a random 48-byte bearer token, and atomically writes:

```text
<extension-global-storage>/automation-api/endpoints/<instanceId>.json
```

The `EndpointDescriptor` schema defines the endpoint file: schema version, instance/project identities, display-preserving workspace paths, loopback host/port, `/v1/rpc`, `/v1/events`, `/health`, token, process identity, decimal-string timestamps, and supported API versions. `projectId` is `sha256:` plus the hash of the normalized workspace-file URI and sorted normalized workspace-folder URIs. Windows path comparison is case-insensitive, but returned display paths retain their casing.

Heartbeat is atomically refreshed every five seconds. Clients must validate `/health`; heartbeat alone is insufficient. A failed health check plus heartbeat age over 30 seconds permits stale-file removal. A project can be open in several windows, so clients must require an `instanceId` when more than one live endpoint has the requested `projectId`.

The user-scoped registry pointer defaults to `%LOCALAPPDATA%\Orbit\automation\registries.json` on Windows, `~/Library/Application Support/Orbit/automation/registries.json` on macOS, and `${XDG_RUNTIME_DIR:-~/.local/state}/orbit/automation/registries.json` on Linux/Unix. `ORBIT_AUTOMATION_REGISTRY` overrides it. Registry entries identify Stable, Insiders, portable, and remote Extension Hosts by channel, profile, host kind, and absolute endpoint directory. Remote SSH/WSL/Container endpoints remain remote-loopback only unless the user arranges forwarding.

Windows files are restricted to the current user and SYSTEM. POSIX directories use `0700` and files `0600`. Startup fails if these permissions cannot be guaranteed. Registry and endpoint paths must reject symlinks, junctions, reparse points, non-regular files, and owner mismatches.

### Channel, profile, and portable/remote behavior

Each Extension Host derives its registry entry identity from the running VS Code:

- `stable` — production VS Code; `insiders` — VS Code Insiders.
- `portable` — portable VS Code still writes the same user-scope pointer, but its registry entry's `endpointDirectory` points at the portable global storage. If that location is not writable, `ORBIT_AUTOMATION_REGISTRY` must be set or API startup fails with an explicit error.
- `remote` — SSH/WSL/Container Extension Hosts run the API and endpoint on the Extension Host machine; the loopback address is that machine's loopback, and nothing is automatically forwarded to the local desktop.

The profile identity is derived from the globalStorage path (`.../User/profiles/<id>/globalStorage`, empty for the default profile). It distinguishes registry entries but never affects `projectId`. An extension upserts only its own entry; pointers with an unknown schema are rejected. Endpoint files and pointer updates are written atomically (temp + rename with hardening before rename). Startup removes residue only when `/health` fails and the heartbeat is over 30 seconds old, and never when `/health` answers with a different `instanceId`.

During one compatibility cycle the legacy `plugin-api-endpoint.json` pointer is still written, but it only marks the shared endpoint directory as `unique` (exactly one live instance; legacy fields and token present) or `ambiguous` (every live instance listed, no token). It never silently selects a window.

## Transport and authorization

RPC uses JSON-RPC 2.0 over authenticated `POST /v1/rpc`. Requests contain exactly one method-specific `params` object. Success is an `OperationResult<T>` JSON-RPC result; failure is a JSON-RPC error whose `data` requires stable `errorCode` and `retryable` fields. The contract defines the five standard JSON-RPC errors and the Orbit server errors in the `-32099..-32000` range. HTTP bodies are limited to 1 MiB and RPC results to 8 MiB.

Bootstrap methods validate the bearer token and `BootstrapContext`; they require no connection scope. `orbit.handshake` is the only bootstrap mutation that creates a connection. It accepts API version `1.0`, client identity, expected project/instance, and requested scopes. Granted scopes are the intersection with `orbit.automation.allowedScopes`, whose default is `read`; adding mutation scopes requires a saved VS Code workspace decision. The token does not grant scopes by itself. Connections expire after ten idle minutes, and any successful request renews the lease. One instance permits 32 connections and eight SSE connections.

Contexts are cumulative:

```text
BootstrapContext = instanceId + projectId
ConnectionContext = BootstrapContext + connectionId
ConnectionMutationContext = ConnectionContext + idempotencyKey
ProjectMutationContext = ConnectionMutationContext + registryGeneration
TargetRequestContext = ConnectionContext + sessionId + sessionGeneration
TargetMutationContext = TargetRequestContext + idempotencyKey
```

Breakpoint and non-sampling view mutations use `ConnectionMutationContext`, so they can edit VS Code/project state without an active target. `session.start` uses `ProjectMutationContext` because no session identity exists yet and the current registry generation must be fenced. Target reads and mutations use the exact active session identity. Diagnostics can optionally name a session but remain non-target-bound.

## Session generation and routing

`registryGeneration` is monotonic and begins at zero. Every transition that invalidates old target/session references increments it once. A newly started or successfully restarted usable session receives that value as `sessionGeneration`. Restart retains `sessionId` but invalidates old references and completions. Replacement is two transitions (old terminated, new started); the derived `session.replaced` event does not increment again. Owner loss increments the registry, moves the session toward error/termination, and requires a new session.

Identity and generation checks happen before any DAP forwarding. A mismatch returns `SessionChanged` with the expected and actual generations and never selects another window or session. `instance.describe`, `project.describe`, and `session.list` support recovery without a session generation. Duplicate `session.start` returns `SessionAlreadyActive` with the current `SessionSnapshot` and performs no transition.

While a DAP session exists, all target state, control, runtime, memory, sampling, and RTT requests route to its exact `vscode.DebugSession`; errors never fall back to the extension-host backend. CMSIS-DAP sessions never construct J-Link fallback ownership. Established owner loss ends the session.

## Method families

The OpenRPC document freezes every method's bootstrap flag, scopes, mutation/idempotency behavior, target binding, timeout, params/result refs, and errors. The public families are:

- Discovery and connection: `orbit.instance.describe`, `orbit.project.describe`, `orbit.project.listLaunchConfigurations`, `orbit.handshake`, `orbit.connection.close`, `orbit.operation.get`, `orbit.system.capabilities`.
- Session and control: `orbit.session.*`, `orbit.target.*`. Source stepping reuses the existing source step state machine; Flash uses only the selected owner and returns segment/verify diagnostics.
- Breakpoints: `orbit.breakpoints.*` returns complete post-operation snapshots, including requested and DAP verified/address/slot state.
- Runtime: `orbit.runtime.*` preserves DAP thread, frame, scope, expandable variable, register, `variablesReference`, and `memoryReference` semantics.
- Expressions, symbols, and memory: `orbit.expression.*`, `orbit.symbol.*`, and `orbit.memory.*` use typed per-item outcomes, loaded ELF/DWARF, byte-oriented memory, partial reads, and optional write verification.
- UI and sampling: `orbit.watch.*`, `orbit.timeline.*`, `orbit.record.*`, and `orbit.experiment.run` retain UI synchronization, generation fences, cancellation, paging, and separate logical consumers.
- RTT and diagnostics: `orbit.rtt.*` uses the selected owner; J-Link DLL RTT and CMSIS-DAP target-memory RTT remain owner-specific implementations. `orbit.diagnostics.snapshot` reports API/DAP/owner/scheduler/sampling summaries and explicitly excludes the bearer token.

All list/search responses include typed `items` and optional `nextCursor`; default limit is 100 and maximum is 1,000. Recording reads additionally cap each page at 1,000 frames. Resource mutations return a complete resulting snapshot rather than a boolean.

## Idempotency, outcomes, and limits

Methods marked `requiresIdempotency` require a key. Each connection retains 1,024 outcomes for five minutes. Dispatch order is authentication/connection, project/instance fence, target generation fence when applicable, scope check, idempotency lookup/reservation, then handler. The same key, canonical params, identity, and generation returns the original result; a changed payload or generation returns `InvalidRequest`. Concurrent identical calls share one in-flight operation.

Disconnecting HTTP after handler dispatch does not cancel a mutation. A `RequestTimeout` with `timeoutKind=queueTimeout` means the handler did not begin and retry is safe. `timeoutKind=outcomeUnknown` requires an `operationId`, means the mutation may have begun, and prevents the key from executing again; clients use that operation ID with `orbit.operation.get` plus resource/session snapshots. Flash, reset, continue, step, expression write, memory write, and breakpoint mutation responses carry `operationId` and ultimately emit `request.completed` or `request.failed`.

Single memory reads/writes are capped at 1 MiB. An instance supports four concurrent recordings, 64 channels per recording, and 50,000 frames. Recordings ride the adapter's continuous fast sampler (`dataSamplingStart` / `readFastDataSampling` / `ozoneDataSamples`) and emit one frame per capture timestamp, so `intervalMs` is a minimum hint with `0` meaning "no throttle" (raw fast-sampler cadence); the same high-rate stream also backs API Timeline sampling and the UI Timeline, which stay independent logical consumers. Global budgets are 64 MiB recording data, 8 MiB SSE ring, and 16 MiB idempotency results; one event is capped at 256 KiB. Old completed data is evicted first, and active mutations are never silently cancelled.

## Event stream

Events use authenticated `GET /v1/events` with `Authorization: Bearer <token>`, `X-Orbit-Connection-Id`, optional repeated `X-Orbit-Event-Type` filters, and optional `Last-Event-ID`. Query-string tokens and CORS are disabled. Native browser `EventSource` is unsupported because it cannot reliably set authorization headers.

Event IDs are monotonically increasing unsigned 64-bit decimal strings; publication order is wire order. Events cover instance/project changes, session lifecycle/replacement, target state/loss, breakpoint changes/hits, Watch/Timeline changes, recording lifecycle/frames, RTT state, and request completion/failure. The ring retains 1,000 events. Replay outside that window emits `events.reset` with current instance/project/session/breakpoint/view/recording/RTT snapshots and the latest event ID. Heartbeat comments occur every 15 seconds. A client exceeding 1 MiB pending output receives `events.reset` when possible and is disconnected. There is no historical event polling API; clients without SSE poll the corresponding snapshot methods.

## Safety and compatibility

Real hardware reset, run, step, breakpoint, RAM write, Flash, and memory-write acceptance requires explicit user authorization. Mock tests prove only protocol and implementation behavior. J-Link and CMSIS-DAP results must be reported separately with owner, transport, target, and evidence. `flashBeforeDebug: false` never performs Flash-only actions, while explicit `orbit.target.flash` uses the already-selected owner.

API 1.0 freezes method names, required identity fields, schema semantics, error meaning, and safety boundaries. New methods may be a compatible minor addition. Renaming/removing methods, changing required fields, or changing error semantics requires a new major API version.
