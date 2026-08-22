# Orbit Automation Python 客户端

标准库单文件：`orbit_client.py`。不装 pip 包，`import` 即可。协议字段以 [`../docs/orbit-automation-api.md`](../docs/orbit-automation-api.md) 和 [`../docs/orbit-automation-openrpc.json`](../docs/orbit-automation-openrpc.json) 为准。Node CLI 见 [`../node/README.md`](../node/README.md)。

**默认一次握手只打一条命令就 `close()`。** 只有同一条调试流要连打多步（`start`→断点→`continue`→step/read/write→`stop`），并且中间不会空等超过 10 分钟，才复用同一个 `OrbitClient`。

## 前提

- VS Code 里 Orbit 扩展已开，工作区开了 `orbit.automation.enabled`。
- `orbit.automation.allowedScopes` 必须覆盖你请求的 scope。默认只有 `read`。
- 目标 API 在本机 `127.0.0.1`。远程 SSH/WSL 窗口的 loopback 在远端，不会自动转发。

## 引入

```python
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # 或本目录的绝对路径

from orbit_client import (
    AmbiguousInstanceError,
    InstanceNotFoundError,
    OrbitClient,
    OrbitClientError,
    OrbitRpcError,
    decode_base64,
    enumerate_instances,
    select_instance,
)
```

也可把 `orbit_client.py` 拷到自己的脚本目录后直接 `from orbit_client import ...`。

## 一次性（默认）

```python
instances = enumerate_instances()
endpoint = select_instance(instances)  # 多窗口必须传 instance_id=
client = OrbitClient(endpoint)
try:
    client.handshake(
        client={"name": "demo", "version": "1.0.0"},
        requested_scopes=["read"],
    )
    print(client.invoke("orbit.session.list", {"includeTerminated": False}))
finally:
    client.close()
```

`enumerate_instances()` / `select_instance()` 只读 registry，不握手。其余调用握手后执行，**退出必须 `close()`**。`close()` 失败不要掩盖命令结果。

多窗口同一 `projectId`：

```python
endpoint = select_instance(instances, instance_id="<instance-id>")
# 或 select_instance(instances, project_id="sha256:...")
```

环境变量 `ORBIT_AUTOMATION_REGISTRY` 可覆盖 registry 指针。Windows 默认 `%LOCALAPPDATA%\Orbit\automation\registries.json`。

## 长连接（仅多步调试流）

同一进程里 handshake 一次，后续 `invoke` 复用 `connectionId` 和缓存的 `session`。空闲 10 分钟过期（`ConnectionExpired`），必须重新 handshake，不是挂死。

```python
client = OrbitClient(endpoint, timeout=90.0)
try:
    client.handshake(
        client={"name": "demo", "version": "1.0.0"},
        requested_scopes=[
            "read",
            "session.control",
            "breakpoints.write",
            "variables.write",
            "memory.write",
            "view.write",
            "record",
            "rtt.control",
        ],
    )
    client.invoke(
        "orbit.session.start",
        {"configurationId": "Orbit: J-Link (Flash)", "timeoutMs": 30000},
        context="projectMutation",
    )
    client.refresh_session()
    print(client.invoke("orbit.expression.readMany", {"expressions": ["aww", "ass"]}, context="target"))
    client.invoke("orbit.session.stop", context="targetMutation")
finally:
    client.close()
```

## API

| 符号 | 作用 |
|---|---|
| `enumerate_instances(registry_path=None)` | 读 pointer → 验 endpoint → `/health`，返回活实例 |
| `select_instance(instances, project_id=, instance_id=)` | 0 个 → `InstanceNotFoundError`；多个 → `AmbiguousInstanceError` |
| `OrbitClient(endpoint, timeout=30)` | 封装 JSON-RPC；`timeout` 秒 |
| `handshake(client=, requested_scopes=, workspace_root=)` | 创建连接；granted = 请求 ∩ 工作区 `allowedScopes` |
| `invoke(method, params=None, context="connection", idempotency_key=)` | 自动填 `context`；返回 `result.data` |
| `refresh_session(session_id=None)` | `session.snapshot`，写入 `client.session` |
| `get_operation(operation_id)` | `orbit.operation.get` |
| `paginate(method, params, context=)` | 跟 `nextCursor` |
| `poll_snapshots([{method, params, context}], interval=, iterations=)` | 轮询只读快照 |
| `events(event_types=, last_event_id=)` | SSE 迭代器；多类型在本地过滤 |
| `close()` | `orbit.connection.close`，清 `connection_id` / `session` |
| `decode_base64(s)` | 校验后解 memory/RTT 的 Base64 |

`invoke` 的 `context`（客户端填 identity / generation / idempotencyKey，不要自己塞 `context` 对象）：

| `context=` | 何时用 | 客户端自动带 |
|---|---|---|
| `"bootstrap"` | `instance.describe` / `project.describe` / `system.capabilities` / handshake | `instanceId` `projectId` |
| `"connection"` | 只读、不断目标：`session.list/snapshot`、`breakpoints.list`、`watch.list`、`diagnostics`… | + `connectionId` |
| `"connectionMutation"` | 改 VS Code 状态：`breakpoints.add/update/remove/replace`、`watch.*`、`timeline.replace` | + `idempotencyKey` |
| `"projectMutation"` | 仅 `orbit.session.start` | + `registryGeneration` |
| `"target"` | 读目标：runtime / expression / symbol / memory.read / record.get / rtt.read… | + `sessionId` `sessionGeneration` |
| `"targetMutation"` | 改目标：stop/restart/pause/continue/reset/step\* / write / memory.write / timeline.start/stop / record.start/stop/clear / rtt.start/stop / experiment | + session + `idempotencyKey` |

`target` / `targetMutation` 之前必须有 `client.session`（handshake 带回来、`start` 的 `data.session`、或 `refresh_session()`）。`SessionChanged` 时 `refresh_session()` 再打一次，不要换窗口。

## 常用调用

业务字段与 OpenRPC 同名（不含 `context`）。`start` 停在入口，调用方再 `continue`。所有 `step*` 的 `threadId` ≥ 1，单核一般是 `1`。

```python
client.invoke("orbit.session.start", {"configurationId": "Orbit: J-Link (Flash)", "timeoutMs": 30000}, context="projectMutation")
client.refresh_session()

client.invoke("orbit.breakpoints.add", {
    "breakpoint": {"source": {"path": r"src\main.c", "line": 42}},
    "waitForVerificationMs": 8000,
}, context="connectionMutation")

client.invoke("orbit.target.continue", context="targetMutation")
# 轮询 session.list，直到 phase/targetState == halted

client.invoke("orbit.expression.readMany", {"expressions": ["aww", "ass"]}, context="target")
client.invoke("orbit.expression.writeMany", {"writes": [{"expression": "g_ram_data", "value": "0x5A5AA5A5"}]}, context="targetMutation")
client.invoke("orbit.memory.read", {"address": "0x20000010", "count": 4}, context="target")
client.invoke("orbit.target.stepInto", {"threadId": 1}, context="targetMutation")

client.invoke("orbit.record.start", {
    "name": "aww",
    "intervalMs": 20,
    "maxFrames": 40,
    "channels": [
        {"channelId": "aww", "expression": "aww", "valueType": "float"},
        {"channelId": "ass", "expression": "ass", "valueType": "float"},
    ],
}, context="targetMutation")
```

## Scopes

Handshake 只给 `requestedScopes ∩ orbit.automation.allowedScopes`。token 不能自授。

| scope | 典型方法 |
|---|---|
| `read` | list/snapshot/runtime/evaluate/read/memory.read/record.get/rtt.read/diagnostics |
| `session.control` | session.start/stop/restart，target.pause/continue/reset/step\* |
| `breakpoints.write` | breakpoints.add/update/remove/replace |
| `variables.write` | expression.writeMany |
| `memory.write` | memory.write |
| `view.write` | watch.add/replace/remove，timeline.replace/start/stop |
| `record` | record.start/stop/clear |
| `rtt.control` | rtt.start/stop |
| `flash` | target.flash（另需工作区授权；未授权不要请求） |

`orbit.experiment.run` 的实际 scope 是步骤并集（读/写/录）。

## 错误

- `OrbitRpcError`：JSON-RPC 失败。看 `error.code`、`error.data["errorCode"]`、`retryable`。
- `OrbitClientError`：传输 / 401 非信封 / 未握手 / 无 session。
- `InstanceNotFoundError` / `AmbiguousInstanceError`：发现阶段。

常见：`SessionChanged`（refresh 再试）、`ConnectionExpired`（重新 handshake）、`NoActiveSession`、`TargetRunning`（部分停止态读）。

## 注意

- 函数静态变量当全局读会失败，要在命中该函数后再读。
- `breakpoints.remove` 释放硬件槽（不再命中）；VS Code 文件标记仍可能出现在 `list` 里（`enabled:true, verified:false`）。
- 内存/RTT 字节是 Base64：读用 `decode_base64`，写自己 `base64.b64encode`。
- `events()` 在 `timeout` 内收不到帧会抛错；一次性脚本不要堵在 SSE 上。
- 实例上限 32 条连接；漏 `close()` 会占租约。
