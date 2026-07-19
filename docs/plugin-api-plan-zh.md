# Orbit 插件 API 计划

## 目标

从 VS Code 扩展暴露一个通用的本地 API，使外部的 MCP 服务器能够读取目标变量、写入选定的值、记录同步波形，并运行可重复的实验。该 API 不得硬编码 PID 字段、电机类型或单环假设。由 AI/MCP 端决定要读取、写入和记录的表达式。

## 设计原则

- 将每个目标值视为由调用方提供的调试器表达式。
- 批量处理读取和波形帧，使多个信号在每个采样周期共享一个时间戳。
- 将 PID、级联 PID、底盘、云台和电机相关的知识保留在插件 API 之外。
- 优先使用活动的 `ozone` 调试会话来访问目标；仅在无匹配调试会话活动时才回退到扩展宿主后端。
- 写入操作必须显式、可做范围检查且可审计。
- 将录制状态与 Timeline 网页视图分离，使 AI 实验不会改变 UI 状态。
- 仅在 `127.0.0.1` 上监听，并使用生成的 bearer token 保护 API。

## API 接口

### 表达式访问

- `ozone.expr.readMany`
- `ozone.expr.writeMany`

表达式是调试器表达式，例如：

- `motor->velocity_pid->kp`
- `motor->velocity_pid->output`
- `Chassis->chassis_motor[0]->message.rotor_velocity`
- `Chassis->chassis_motor[0]->angle_pid->target[0]`

### 波形录制

- `ozone.record.start`
- `ozone.record.stop`
- `ozone.record.get`
- `ozone.record.clear`

录制数据包含帧。每帧有一个时间戳和一个别名到值的映射。

### 实验执行

- `ozone.experiment.run`

实验由一系列通用步骤组成：

- 读取基线值
- 写入一个或多个表达式
- 等待
- 录制任意通道
- 读取最终值

### 未来的发现 API

- `ozone.symbol.search`
- `ozone.expr.inspect`

这些 API 将帮助 MCP 发现候选变量，但首次实现可以聚焦于运行时读/写/录制/实验执行。

## 数据模型

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

## 示例：级联电机 PID 试验

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

## 首次实现范围

1. 在 `src/plugin-api` 下添加类型化的请求/响应模型。
2. 为 `readMany`、`writeMany` 和 `getTargetState` 添加 `RuntimeRouter`。
3. 为多通道同步录制添加 `WaveRecorder`。
4. 为通用的读/写/等待/录制步骤添加 `ExperimentService`。
5. 使用 Node.js 内置 HTTP 服务器添加 `PluginApiServer`。
6. 在 `activate()` 中启动服务器，在 `deactivate()` 中释放。
7. 将端点元数据写入扩展的全局存储，供未来的 MCP 服务器读取。

## 待办事项（延期）

- 基于 ELF/DWARF 数据的符号搜索。
- 带子节点展开的表达式结构检查。
- 用户可见的允许列表管理。
- 硬实时采样保证。
- 用于实时 AI 反馈的 WebSocket/SSE 流式传输。
- 用于审查和批准写入操作的 UI。
