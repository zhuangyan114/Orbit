# RTT Session Lifecycle（B04）

本文冻结统一 RTT transport 在一个 DAP debug session 内的生命周期边界。物理 target owner 仍由 `SessionTargetSelector` 唯一持有；`RttSessionLifecycle` 不创建第二个 Native/Legacy owner，也不直接操作 DLL/helper。

## 状态与转换

```text
disconnected
    │ connect
    ▼
connected ── DAP initialized / start ──► initialized
    │                                      │
    │ run                                  │ run / halt（保持 RTT）
    ▼                                      ▼
running ◄────────────────────────────── halted

initialized/running/halted ── resetStarted / stop ──► resetting
resetting ── resetCompleted / start ──► initialized

connected/initialized/running/halted/resetting
    ├─ disconnect / terminate ──► terminating ──► terminated
    └─ owner loss ──► owner-lost ──► terminated（只清理本地轮询，不访问失效 owner）
```

## 固定规则

| 事件 | RTT transport | Polling controller | 备注 |
|---|---|---|---|
| `connect` | 不启动 | 不启动 | 只完成 target owner 选择 |
| DAP `initialized` | `start` 一次 | `start` | 启动失败留在可重试状态 |
| target `run` / `halt` | 保持 started | 保持运行 | halt 不重复 stop/start |
| `resetStarted` | `stop` | 先 `stop` | reset 由调用方执行 |
| `resetCompleted` | `start` | `start` | 目标已完成 reset/halt 后调用 |
| `disconnect` / `terminate` | stop（幂等） | stop | 终止后无残留 timer |
| owner loss | 不再访问 owner | 立即 stop | 不得 fallback 到第二个 owner |

`RttSessionLifecycle` 和 `RttTransportAdapter` 当前已具备自动测试。活动 selector-backed DAP session 已在 launch initialized、run/halt、restart reset、disconnect、terminate 和 connection-loss 路径使用该生命周期；旧 RTT timer 仍负责文本解码和输出，但其 start/stop/read 已通过 `OzoneBackend` 的统一 Transport 边界执行。
