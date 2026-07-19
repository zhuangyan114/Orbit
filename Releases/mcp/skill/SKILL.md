---
name: ozone-mcp-control
description: Use Orbit MCP to inspect and control an STM32/J-Link target through the Orbit for VS Code plugin. Use when an agent needs to read target expressions, write selected numeric values, record synchronized waveform data, run generic experiments, or standardize tuning workflows such as PID, cascaded PID, motor, chassis, gimbal, or other embedded control loops.
---

# Orbit MCP Control

## Purpose

Use the Orbit MCP server as a generic target experiment interface. Do not assume PID-specific fields. Treat PID tuning as one use of the generic read/write/wait/record experiment model.

The VS Code extension owns target access. The MCP server is a thin adapter over the plugin API.

## MCP Setup

Use this MCP server command when an agent needs to connect:

```json
{
  "mcpServers": {
    "orbit": {
      "command": "node",
      "args": [
        "C:\\Users\\22690\\Desktop\\AI\\Orbit\\Releases\\mcp\\orbit-mcp-server.js"
      ],
      "env": {
        "ORBIT_PLUGIN_API_ENDPOINT_FILE": "C:\\Users\\22690\\AppData\\Roaming\\Code\\User\\globalStorage\\orbit-debug.orbit-for-vscode\\plugin-api-endpoint.json"
      }
    }
  }
}
```

Prerequisites:

- VS Code Orbit extension is running.
- The target debug session is active when target reads/writes are needed.
- The endpoint file exists and contains the plugin API URL/token.
- MCP and VS Code run on the same machine because the plugin API listens on `127.0.0.1`.

## Tools

Available MCP tools:

- `ozone_status`: return plugin/target state.
- `ozone_read_many`: read arbitrary debugger expressions.
- `ozone_write_many`: write numeric values to arbitrary debugger expressions.
- `ozone_record`: record synchronized frames for arbitrary expressions.
- `ozone_experiment_run`: run generic `read`, `write`, `wait`, and `record` steps.

Tool results are JSON serialized in text content. Parse the JSON before analysis.

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

1. Call `ozone_status`.
2. Identify candidate expressions from user input, source code, existing watch variables, or project conventions.
3. Run a read-only smoke test with `ozone_read_many`.
4. Record a short baseline with `ozone_record` before changing values.
5. If writing is required, constrain writes with explicit expressions and numeric ranges.
6. Run `ozone_experiment_run` for repeatable trials.
7. Compare trial recordings and recommend the next action.

Do not write target values before a successful read-only check unless the user explicitly asks for immediate writes.

## Generic Experiment Model

Use `ozone_experiment_run` for structured workflows:

```json
{
  "name": "control-loop-trial",
  "baseline": [
    { "alias": "kp", "expression": "motor->velocity_pid->kp" },
    { "alias": "ki", "expression": "motor->velocity_pid->ki" }
  ],
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
        { "alias": "output", "expression": "motor->velocity_pid->output" },
        { "alias": "p_out", "expression": "motor->velocity_pid->p_out" },
        { "alias": "i_out", "expression": "motor->velocity_pid->i_out" },
        { "alias": "d_out", "expression": "motor->velocity_pid->d_out" },
        { "alias": "err", "expression": "motor->velocity_pid->err[0]" }
      ]
    }
  ],
  "safety": [
    { "expression": "motor->velocity_pid->kp", "min": 0, "max": 100 },
    { "expression": "motor->velocity_pid->ki", "min": 0, "max": 10 }
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

Before calling `ozone_write_many` or a write step:

- Prefer writing one parameter at a time.
- Keep old values in the response or baseline.
- Use `safety` ranges in `ozone_experiment_run` when known.
- Never write expressions that look like raw pointers, peripheral registers, flash control, clock config, or communication buffers unless the user explicitly requests it.
- If unsure whether an expression is safe, ask the user or run read-only experiments first.

## Failure Handling

If a tool reports an expression error:

- Keep the failed expression in the result and continue analyzing successful channels.
- Try a simpler expression or ask for the root object name.
- For optimized builds, explain that some locals or fields may not be readable.

If `ozone_status` does not return `running` or `halted`:

- Ask the user to start or reconnect the Orbit debug session.
- Do not attempt writes.
