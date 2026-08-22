# Orbit Automation 客户端

本目录是 **Automation API v1** 的对外发布面，给脚本和 AI 用。它不是 VS Code 扩展本身。

先装 Orbit 扩展并打开工作区设置：

```json
{
  "orbit.automation.enabled": true,
  "orbit.automation.allowedScopes": [
    "read",
    "session.control",
    "breakpoints.write",
    "variables.write",
    "memory.write",
    "view.write",
    "record",
    "rtt.control"
  ]
}
```

默认只有 `read`。缺 scope 时 handshake 仍成功，后续 mutation 会失败。`flash` 另需授权。API 只听本机 `127.0.0.1`。

## 目录

| 路径 | 内容 |
|---|---|
| [`docs/orbit-automation-api.md`](docs/orbit-automation-api.md) | 人读协议（含 quick start 与 legacy `/rpc` 迁移） |
| [`docs/orbit-automation-hardware-acceptance.md`](docs/orbit-automation-hardware-acceptance.md) | 自动化 / Mock / 真实硬件分层验收 |
| [`docs/orbit-automation-openrpc.json`](docs/orbit-automation-openrpc.json) | 机器契约（字段唯一来源） |
| [`docs/orbit-automation-events.schema.json`](docs/orbit-automation-events.schema.json) | SSE 事件 schema |
| [`node/`](node/README.md) | Node 库 + `orbit-automation` / `orbit-automation-session` |
| [`python/`](python/README.md) | 标准库单文件 `orbit_client.py` |
| [`LICENSE`](LICENSE) | MIT |

**默认一次性。** 看一眼、打一个断点、读几个变量：Node 用 `orbit-automation`，Python 握手→一次 `invoke`→`close()`。只有同一条流连打多步、且中间不会空等超过 10 分钟，才用长连接。

## Node

需要 Node 20+。

```bash
cd node
node cli.js instances
node cli.js status --instance <id>
node cli.js start "Orbit: J-Link (Flash)" --instance <id>
node session.js connect --instance <id>
```

说明见 [`node/README.md`](node/README.md)。

## Python

只需标准库。把 `python/orbit_client.py` 放到 `sys.path`，或拷到自己的脚本目录。

```python
from orbit_client import OrbitClient, enumerate_instances, select_instance
```

说明见 [`python/README.md`](python/README.md)。
