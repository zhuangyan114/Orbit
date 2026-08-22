# Orbit Automation API v1 Acceptance Matrix

Each case is independently reportable. `Automated` means contract/unit/integration automation can decide it without physical target mutation. `Hardware-only` means the case remains pending until the named probe and target are explicitly authorized and evidence is captured. Method names in `Methods` are the complete mapping used by the contract validator.

### API-001: Endpoint discovery and stale validation

Category: Discovery
Status: Automated
Methods: `orbit.instance.describe`, `orbit.project.describe`, `orbit.project.listLaunchConfigurations`, `orbit.system.capabilities`
Acceptance: Enumerate Stable/Insiders/profile/portable/remote registry entries, reject unsafe files, validate `/health`, preserve displayed paths, and require `instanceId` for ambiguous live project matches.

### API-002: Authenticated handshake and connection lifecycle

Category: Handshake
Status: Automated
Methods: `orbit.handshake`, `orbit.connection.close`, `orbit.operation.get`
Acceptance: Reject missing/wrong bearer tokens, intersect requested and allowed scopes, renew/expire the lease, close SSE/idempotency state, and recover queued/running/final/outcome-unknown operations.

### API-003: Session discovery and generation lifecycle

Category: Session
Status: Automated
Methods: `orbit.session.list`, `orbit.session.snapshot`, `orbit.session.start`, `orbit.session.stop`, `orbit.session.restart`
Acceptance: Drive one visible Orbit session, preserve exact session identity, increment generations once per transition, reject duplicate starts, invalidate old references on restart, and publish lifecycle events.

### API-004: Target control and source stepping

Category: Control
Status: Automated
Methods: `orbit.target.pause`, `orbit.target.continue`, `orbit.target.reset`, `orbit.target.stepOver`, `orbit.target.stepInto`, `orbit.target.stepOut`, `orbit.target.stepInstruction`, `orbit.target.flash`
Acceptance: Route through the selected owner and scheduler control lane, preserve DAP state/UI events and source-step semantics, return operation IDs, and reject stale generation or unavailable capability before dispatch.

### API-005: Visible breakpoint lifecycle

Category: Breakpoints
Status: Automated
Methods: `orbit.breakpoints.list`, `orbit.breakpoints.add`, `orbit.breakpoints.update`, `orbit.breakpoints.remove`, `orbit.breakpoints.replace`
Acceptance: Use VS Code breakpoints as authority, show API edits in the UI, merge requested and verified/address/slot state, atomically replace one source, and return complete post-operation snapshots.

### API-006: DAP runtime trees and expression semantics

Category: Variables
Status: Automated
Methods: `orbit.runtime.threads`, `orbit.runtime.stackTrace`, `orbit.runtime.scopes`, `orbit.runtime.variables`, `orbit.runtime.registers`, `orbit.expression.evaluate`, `orbit.expression.readMany`, `orbit.expression.writeMany`, `orbit.expression.inspect`, `orbit.symbol.search`, `orbit.symbol.resolve`
Acceptance: Preserve expandable references and memory references, exact register/address values, loaded ELF/DWARF symbol behavior, per-item batch outcomes, Unicode-preserving trim, empty rejection, and control/read serialization for writes.

### API-007: Byte-oriented memory access

Category: Memory
Status: Automated
Methods: `orbit.memory.read`, `orbit.memory.write`
Acceptance: Use string addresses and Base64 bytes, enforce the 1 MiB limit, report partial reads, optionally verify writes, return operation IDs, and propagate structured address/transport errors without unsafe replay.

### API-008: Watch and Timeline synchronization

Category: Recording
Status: Automated
Methods: `orbit.watch.list`, `orbit.watch.replace`, `orbit.watch.add`, `orbit.watch.remove`, `orbit.timeline.list`, `orbit.timeline.replace`, `orbit.timeline.start`, `orbit.timeline.stop`, `orbit.timeline.status`
Acceptance: Synchronize persisted/UI expressions, page list results, fence sampling by exact session generation, prevent stale publication, allow raw fast-sampler cadence (`intervalMs=0`, no throttle), and preserve scheduler fairness.

### API-009: Recording and experiment lifecycle

Category: Recording
Status: Automated
Methods: `orbit.record.start`, `orbit.record.stop`, `orbit.record.list`, `orbit.record.get`, `orbit.record.clear`, `orbit.experiment.run`
Acceptance: Enforce connection/channel/frame/budget caps, return paged synchronized frames with monotonic string timestamps, preserve final snapshots, derive experiment scopes from typed steps, and support cancellation/outcome recovery.

### API-010: RTT and diagnostics isolation

Category: Variables
Status: Automated
Methods: `orbit.rtt.status`, `orbit.rtt.start`, `orbit.rtt.stop`, `orbit.rtt.read`, `orbit.rttlog.read`, `orbit.diagnostics.snapshot`
Acceptance: Keep RTT logically separate from Timeline, use background scheduling and selected-owner semantics, return Base64 bytes, pause around control work, return decoded terminal log lines (distinguishing P-RTLog `decoded` from raw `text`) with a required line count, and prove diagnostics never include the bearer token.

### API-011: SSE ordering, replay, and reset

Category: Events
Status: Automated
Methods: `orbit.session.snapshot`, `orbit.breakpoints.list`, `orbit.watch.list`, `orbit.timeline.status`, `orbit.record.list`, `orbit.rtt.status`
Acceptance: Authenticate headers, apply scope-aware filters, emit monotonic decimal-string IDs in publication order, replay `Last-Event-ID`, produce a complete `events.reset`, heartbeat at 15 seconds, and disconnect consumers over 1 MiB pending bytes.

### API-012: Generated SDK interoperability

Category: SDK
Status: Automated
Methods: `orbit.instance.describe`, `orbit.handshake`, `orbit.session.snapshot`, `orbit.expression.readMany`, `orbit.memory.read`, `orbit.record.get`
Acceptance: Node and Python clients validated against OpenRPC produce identical JSON-RPC contexts, decode OperationResult/error envelopes, retain exact numeric strings, decode Base64, and follow pagination.

### API-013: Optional MCP adapter parity

Category: MCP
Status: Automated
Methods: `orbit.project.describe`, `orbit.session.list`, `orbit.target.pause`, `orbit.expression.evaluate`, `orbit.memory.read`, `orbit.diagnostics.snapshot`
Acceptance: MCP remains a client of the authenticated API, exposes no extra target path, preserves method errors and identity fields, and never falls back to an extension-host backend while DAP is active.

### API-014: Identity, scope, timeout, and outcome fault injection

Category: Error injection
Status: Automated
Methods: `orbit.handshake`, `orbit.session.start`, `orbit.target.continue`, `orbit.breakpoints.update`, `orbit.expression.writeMany`, `orbit.memory.write`, `orbit.record.get`, `orbit.experiment.run`
Acceptance: Inject wrong token/project/instance/generation, expired connection, missing scope, reused idempotency key with changed payload, queue timeout, outcome unknown, owner loss, and backpressure; verify the declared stable error and no duplicate handler execution.

### API-015: J-Link selected-owner hardware workflow

Category: J-Link hardware
Status: Hardware-only
Probe: J-Link
Methods: `orbit.session.start`, `orbit.target.pause`, `orbit.target.continue`, `orbit.target.reset`, `orbit.target.stepOver`, `orbit.target.stepInto`, `orbit.target.stepOut`, `orbit.target.stepInstruction`, `orbit.target.flash`, `orbit.breakpoints.add`, `orbit.expression.readMany`, `orbit.expression.writeMany`, `orbit.memory.read`, `orbit.memory.write`, `orbit.record.start`, `orbit.rtt.start`, `orbit.rtt.read`, `orbit.rtt.stop`, `orbit.record.stop`, `orbit.session.stop`
Acceptance: With explicit authorization, record DLL/helper version, owner kind, target, state/PC, operation IDs and verify evidence; prove one owner, native-to-legacy fallback only after full native disposal, scheduler ordering, UI synchronization, and no claim beyond the exercised hardware scope.

### API-016: CMSIS-DAP selected-owner hardware workflow

Category: CMSIS-DAP hardware
Status: Hardware-only
Probe: CMSIS-DAP
Methods: `orbit.session.start`, `orbit.target.pause`, `orbit.target.continue`, `orbit.target.reset`, `orbit.target.stepOver`, `orbit.target.stepInto`, `orbit.target.stepOut`, `orbit.target.stepInstruction`, `orbit.target.flash`, `orbit.breakpoints.add`, `orbit.expression.readMany`, `orbit.expression.writeMany`, `orbit.memory.read`, `orbit.memory.write`, `orbit.record.start`, `orbit.rtt.start`, `orbit.rtt.read`, `orbit.rtt.stop`, `orbit.record.stop`, `orbit.session.stop`
Acceptance: With explicit authorization, record VID/PID/serial/transport/helper/VTref/DPIDR/ACK/state/PC and Flash verify evidence; prove the sole CMSIS-DAP helper owner, no J-Link fallback, target-memory RTT, scheduler ordering, and no claim beyond the exercised target and transport.

### API-017: Channel, profile, and registry location matrix

Category: Discovery
Status: Automated
Methods: `orbit.instance.describe`, `orbit.project.describe`
Acceptance: Derive Stable/Insiders/portable/remote channels and local/ssh/wsl/container hosts, per-platform pointer defaults with `ORBIT_AUTOMATION_REGISTRY` override, portable entries pointing at portable global storage, atomic temp+rename endpoint/heartbeat files, per-user ACL or 0700/0600 hardening, symlink/junction/reparse rejection, health-plus-30-second stale cleanup that never deletes a live identity, profile-isolated pointer entries, and legacy pointer `unique`/`ambiguous` marking that never selects a window.

### API-018: Handshake scopes and lease lifecycle

Category: Handshake
Status: Automated
Methods: `orbit.handshake`, `orbit.connection.close`
Acceptance: Intersect requested and allowed scopes without token self-granting, reject API/instance/project/workspace mismatches, enforce the 32-connection cap, expire idle leases after ten minutes, renew on any successful request, free leases on close, and return the frozen `HandshakeData` shape with a string `expiresAt`.

### API-019: Dual-window distinct-project discovery

Category: Discovery
Status: Automated
Methods: `orbit.instance.describe`, `orbit.project.describe`
Acceptance: Two `@vscode/test-electron` or in-process API windows open different projects, both endpoints stay live, `projectId` differs, and `instanceId` uniquely identifies each window.

### API-020: Same-project ambiguous instance rejection

Category: Discovery
Status: Automated
Methods: `orbit.handshake`
Acceptance: Two windows open the same project so `projectId` matches and `instanceId` differs; clients must reject selection until an explicit `instanceId` is provided.

### API-021: Visible VS Code debug UI evidence

Category: Session
Status: Automated
Methods: `orbit.session.start`, `orbit.breakpoints.add`
Acceptance: Use `@vscode/test-electron` to open Run and Debug, the target source, and the Orbit session. Official debug/session APIs must show an active debug context and Call Stack session; `vscode.debug.breakpoints` source locations must match the captured gutter screenshot. DAP events alone are not UI evidence.

### API-022: Session replacement generation fence

Category: Session
Status: Automated
Methods: `orbit.session.restart`, `orbit.target.pause`
Acceptance: After terminate/restart, a stale `sessionGeneration` mutation returns `SessionChanged` and never reaches the new DAP session; a refreshed snapshot can continue control.

### API-023: Crash residue and clean dispose

Category: Discovery
Status: Automated
Methods: `orbit.instance.describe`
Acceptance: Stale endpoint files fail `/health` and are excluded from discovery; a normal dispose deletes the live endpoint.

### API-024: Catalog evidence completeness

Category: SDK
Status: Automated
Methods: `orbit.instance.describe`, `orbit.project.describe`, `orbit.project.listLaunchConfigurations`, `orbit.handshake`, `orbit.connection.close`, `orbit.operation.get`, `orbit.system.capabilities`, `orbit.session.list`, `orbit.session.snapshot`, `orbit.session.start`, `orbit.session.stop`, `orbit.session.restart`, `orbit.target.pause`, `orbit.target.continue`, `orbit.target.reset`, `orbit.target.stepOver`, `orbit.target.stepInto`, `orbit.target.stepOut`, `orbit.target.stepInstruction`, `orbit.target.flash`, `orbit.breakpoints.list`, `orbit.breakpoints.add`, `orbit.breakpoints.update`, `orbit.breakpoints.remove`, `orbit.breakpoints.replace`, `orbit.runtime.threads`, `orbit.runtime.stackTrace`, `orbit.runtime.scopes`, `orbit.runtime.variables`, `orbit.runtime.registers`, `orbit.expression.evaluate`, `orbit.expression.readMany`, `orbit.expression.writeMany`, `orbit.expression.inspect`, `orbit.symbol.search`, `orbit.symbol.resolve`, `orbit.memory.read`, `orbit.memory.write`, `orbit.watch.list`, `orbit.watch.replace`, `orbit.watch.add`, `orbit.watch.remove`, `orbit.timeline.list`, `orbit.timeline.replace`, `orbit.timeline.start`, `orbit.timeline.stop`, `orbit.timeline.status`, `orbit.record.start`, `orbit.record.stop`, `orbit.record.list`, `orbit.record.get`, `orbit.record.clear`, `orbit.experiment.run`, `orbit.rtt.status`, `orbit.rtt.start`, `orbit.rtt.stop`, `orbit.rtt.read`, `orbit.rttlog.read`, `orbit.diagnostics.snapshot`
Acceptance: Every public catalog method has an Automated evidence case or an explicit Hardware-only case; the validator fails if any method is unmapped.
