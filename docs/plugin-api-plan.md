# Orbit Plugin API Plan

## Goal

Expose a generic local API from the VS Code extension so an external MCP server can read target variables, write selected values, record synchronized waveforms, and run repeatable experiments. The API must not hard-code PID fields, motor types, or single-loop assumptions. The AI/MCP side decides which expressions to read, write, and record.

## Design Principles

- Treat every target value as a debugger expression supplied by the caller.
- Batch reads and waveform frames so multiple signals share one timestamp per sample cycle.
- Keep PID, cascaded PID, chassis, gimbal, and motor-specific knowledge outside the plugin API.
- Prefer the active `ozone` debug session for target access; fall back to the extension-host backend only when no matching debug session is active.
- Make writes explicit, range-checkable, and auditable.
- Keep recording state separate from the Timeline webview so AI experiments do not mutate UI state.
- Listen only on `127.0.0.1` and protect the API with a generated bearer token.

## API Surface

### Expression Access

- `ozone.expr.readMany`
- `ozone.expr.writeMany`

Expressions are debugger expressions such as:

- `motor->velocity_pid->kp`
- `motor->velocity_pid->output`
- `Chassis->chassis_motor[0]->message.rotor_velocity`
- `Chassis->chassis_motor[0]->angle_pid->target[0]`

### Recording

- `ozone.record.start`
- `ozone.record.stop`
- `ozone.record.get`
- `ozone.record.clear`

Recordings contain frames. Each frame has one timestamp and a map of alias-to-value results.

### Experiment Execution

- `ozone.experiment.run`

An experiment is a sequence of generic steps:

- read baseline values
- write one or more expressions
- wait
- record arbitrary channels
- read final values

### Future Discovery APIs

- `ozone.symbol.search`
- `ozone.expr.inspect`

These will help MCP discover candidate variables, but the first implementation can focus on runtime read/write/record/experiment execution.

## Data Model

```ts
interface SignalSpec {
  alias: string;
  expression: string;
  role?: string;
  unit?: string;
  writable?: boolean;
}

interface WriteSpec {
  alias?: string;
  expression: string;
  value: number;
}

interface WaveFrame {
  timestamp: number;
  values: Record<string, {
    expression: string;
    value: number;
    display: string;
    hex?: string;
    error?: string;
  }>;
}

interface Recording {
  recordingId: string;
  startedAt: number;
  stoppedAt?: number;
  intervalMs: number;
  channels: SignalSpec[];
  frames: WaveFrame[];
}
```

## Example: Cascaded Motor PID Trial

```json
{
  "method": "ozone.experiment.run",
  "params": {
    "name": "motor cascade pid trial",
    "baseline": [
      { "alias": "angle_kp", "expression": "motor->angle_pid->kp" },
      { "alias": "speed_kp", "expression": "motor->velocity_pid->kp" },
      { "alias": "speed_ki", "expression": "motor->velocity_pid->ki" },
      { "alias": "speed_out_max", "expression": "motor->velocity_pid->out_max" }
    ],
    "steps": [
      {
        "type": "write",
        "writes": [
          { "alias": "target_position", "expression": "motor->target_position", "value": 1.57 }
        ]
      },
      {
        "type": "record",
        "durationMs": 2000,
        "intervalMs": 10,
        "channels": [
          { "alias": "angle_target", "expression": "motor->target_position" },
          { "alias": "angle_feedback", "expression": "motor->message.out_position" },
          { "alias": "angle_pid_out", "expression": "motor->angle_pid->output" },
          { "alias": "speed_target", "expression": "motor->target_velocity" },
          { "alias": "speed_feedback", "expression": "motor->message.rotor_velocity" },
          { "alias": "speed_pid_out", "expression": "motor->velocity_pid->output" },
          { "alias": "current_out", "expression": "motor->output" }
        ]
      }
    ]
  }
}
```

## First Implementation Scope

1. Add typed request/response models under `src/plugin-api`.
2. Add `RuntimeRouter` for `readMany`, `writeMany`, and `getTargetState`.
3. Add `WaveRecorder` for multi-channel synchronized recording.
4. Add `ExperimentService` for generic read/write/wait/record steps.
5. Add `PluginApiServer` using Node's built-in HTTP server.
6. Start the server from `activate()` and dispose it from `deactivate()`.
7. Write endpoint metadata to extension global storage for the future MCP server.

## Deferred Work

- Symbol search backed by ELF/DWARF data.
- Expression structure inspection with child expansion.
- User-visible allowlist management.
- Hard real-time sampling guarantees.
- WebSocket/SSE streaming for live AI feedback.
- UI for reviewing and approving write operations.
