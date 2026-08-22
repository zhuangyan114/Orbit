---
name: orbit-mcp-control
description: Use Orbit MCP to inspect and control an STM32/J-Link or CMSIS-DAP target through the Orbit for VS Code plugin. Use when an agent needs to discover VS Code instances, handshake, start or control a visible debug session, read or write expressions, access memory, manage breakpoints, record synchronized waveform data, run generic experiments, or standardize tuning workflows such as PID, cascaded PID, motor, chassis, gimbal, or other embedded control loops.
---

# Orbit MCP Control

## Purpose

Use the Orbit MCP server as a thin Automation API v1 adapter. Do not assume PID-specific fields. Treat PID tuning as one use of the generic read/write/wait/record experiment model.

The VS Code Orbit debug session owns the single physical target. MCP never selects the most recently active window, never parses endpoint files itself, and never opens a second target owner.

## MCP Setup

```json
{
  "mcpServers": {
    "orbit": {
      "command": "node",
      "args": [
        "C:\\Users\\22690\\Desktop\\AI\\Orbit\\Releases\\mcp\\orbit-mcp-server.js"
      ]
    }
  }
}
```

`ozone-mcp-server.js` is only a filename-compatible launcher for `orbit-mcp-server.js`.

Prerequisites:

- VS Code Orbit extension is running with Automation API enabled.
- Discovery uses `ORBIT_AUTOMATION_REGISTRY` or the default `%LOCALAPPDATA%\Orbit\automation\registries.json`.
- Multiple windows with the same `projectId` require an explicit `instanceId`.
- Mutation tools require `idempotencyKey`. Target-bound tools need a handshake plus either an explicit `sessionId`/`sessionGeneration` or a unique active session.
- MCP and VS Code run on the same machine because the API listens on `127.0.0.1`.

## Tools

v1 tools:

- `orbit_instances`: list live instances; never returns tokens.
- `orbit_handshake`: validate project/instance and requested scopes.
- `orbit_session_list` / `orbit_session_snapshot` / `orbit_session_start` / `orbit_session_stop`
- `orbit_target_pause` / `orbit_target_continue` / `orbit_target_reset` / `orbit_target_step`
- `orbit_breakpoints_list` / `orbit_breakpoints_add`
- `orbit_memory_read` / `orbit_memory_write`
- `orbit_record_get` / `orbit_expression_evaluate` / `orbit_diagnostics_snapshot`
- `orbit_status` → `orbit.session.list`
- `orbit_read_many` → `orbit.expression.readMany`
- `orbit_write_many` → `orbit.expression.writeMany`
- `orbit_record` → paginated `orbit.record.start/get/stop/clear`
- `orbit_experiment_run` → `orbit.experiment.run`

Results are structured JSON. Failures include `errorCode` and must not be treated as text success.

`tools/list` always includes a `required` array on each object `inputSchema`. All-optional tools advertise `required: []`. Do not treat that as “this tool needs an argument”. It exists so opencode and strict OpenAI-compatible / Anthropic gateways do not see `required: null` (opencode issue 15540).

## Expression Rules

Always let the user, source code, ELF symbols, or prior reads determine expressions. Do not invent fixed variable names.

Good expressions are target debugger expressions such as:

```text
cnt
data[1]
motor->velocity_pid->kp
motor->velocity_pid->output
motor->angle_pid->target[0]
Chassis->chassis_motor[0]->message.rotor_velocity
```

Use `alias` names to normalize data for analysis. The alias is for returned data only; the actual target access uses `expression`.

## Standard Workflow

1. Call `orbit_instances`. If more than one instance matches, pass `instanceId`.
2. Call `orbit_handshake` or `orbit_status` with that `instanceId`.
3. Identify candidate expressions from user input, source code, existing watch variables, or project conventions.
4. Run a read-only smoke test with `orbit_read_many`.
5. Record a short baseline with `orbit_record` before changing values.
6. If writing is required, constrain writes with explicit expressions and numeric ranges. Provide `idempotencyKey`.
7. Run `orbit_experiment_run` for repeatable trials.
8. Compare trial recordings and recommend the next action.

Do not write target values before a successful read-only check unless the user explicitly asks for immediate writes.

## Generic Experiment Model

Use `orbit_experiment_run` for structured workflows. Tool `type` steps are mapped to Automation API `kind` steps:

```json
{
  "instanceId": "4aa4d6e7-...",
  "idempotencyKey": "trial-17",
  "name": "control-loop-trial",
  "timeoutMs": 60000,
  "steps": [
    {
      "type": "write",
      "writes": [
        { "alias": "target", "expression": "motor->target_velocity", "value": 3000 }
      ]
    },
    {
      "type": "record",
      "durationMs": 2000,
      "intervalMs": 10,
      "channels": [
        { "alias": "target", "expression": "motor->target_velocity" },
        { "alias": "feedback", "expression": "motor->message.rotor_velocity" },
        { "alias": "output", "expression": "motor->velocity_pid->output" }
      ]
    }
  ]
}
```

Use the same structure for non-PID experiments by changing expressions and aliases.

## Tuning Policy

For tuning tasks, standardize around trials:

- Baseline: read current parameters and limits.
- Stimulus: write or request a controlled target/change.
- Recording: capture target, feedback, output, internal terms, and safety signals.
- Analysis: compute qualitative behavior from the waveform.
- Update: write only selected tunable parameters.
- Repeat: run another trial with the same channel schema when possible.

Common metrics:

- final value and steady-state error
- overshoot and undershoot
- rise time and settling time
- oscillation or ringing
- output saturation
- integral windup
- delay or dead zone

When handling PID:

- PID is not special to the API. It is a naming convention over expressions.
- Record both external behavior and internal PID terms when available.
- For cascaded PID, record both outer-loop and inner-loop target, feedback, error, and output.
- If tuning a motor, also record the actuator command/current/output and any measured speed/position.
- Avoid changing multiple gains at once unless the user requests aggressive automated tuning.

## Safety Rules

Before calling `orbit_write_many` or a write step:

- Prefer writing one parameter at a time.
- Keep old values in the response or baseline.
- Never write expressions that look like raw pointers, peripheral registers, flash control, clock config, or communication buffers unless the user explicitly requests it.
- If unsure whether an expression is safe, ask the user or run read-only experiments first.

## Failure Handling

If a tool reports `errorCode`:

- Treat it as a structured failure, not a successful text payload.
- `AmbiguousInstance` means specify `instanceId`.
- `SessionChanged` means refresh with `orbit_session_snapshot` and do not replay the same mutation blindly.
- `CapabilityUnavailable` means the granted scopes or owner cannot perform that operation.

If `orbit_status` / `orbit_session_list` does not show `running` or `halted`:

- Ask the user to start or reconnect the Orbit debug session, or call `orbit_session_start` only with explicit consent.
- Do not attempt writes.
