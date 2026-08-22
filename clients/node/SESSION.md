# Orbit Automation 客户端

两种入口共用 `OrbitClient` 和同一套命令解析。一次握手占用一个 10 分钟连接租约，实例上限 32 条；退出时必须 `orbit.connection.close` 释放。

**默认用一次性 `orbit-automation`。** 非必须不要开长连接。AI / 脚本每步单独调用、看一眼、打一个断点、读几个变量，都走一次性。只有下面「必须」成立时才用 `orbit-automation-session`。

| 入口 | 何时用 |
|---|---|
| `orbit-automation` | **默认。** 无状态，一条命令 handshake→执行→`close()`，不会挂守护进程、不会撞过期租约。 |
| `orbit-automation-session` | **仅当**同一条调试流要连打多步（`start`→断点→`continue`→step/read/write→`stop`），并且中间不会空等超过 10 分钟。 |

必须用长连接的情况只有：需要进程内缓存 `sessionGeneration`、需要 `SessionChanged` 自动重试、或十几步连打要省握手。除此之外一律一次性。

`instances` 只读 registry，不握手。其余一次性命令握手后执行，`finally` 里 best-effort `close()`；`close()` 失败不掩盖命令结果。

协议字段见 [`docs/api/orbit-automation-api.md`](../../docs/api/orbit-automation-api.md) 和 [`docs/api/orbit-automation-openrpc.json`](../../docs/api/orbit-automation-openrpc.json)。Python 模块用法见 [`clients/python/README.md`](../python/README.md)。

## 构建

```bash
npm run build:automation-client
# 产出 clients/node/dist/{cli,session,index}.js
```

```bash
npx orbit-automation --help
npx orbit-automation-session connect --instance <id>
```

全局参数：`--registry PATH`、`--project ID`、`--instance ID`、`--scopes a,b,c`。多窗口同一 `projectId` 必须显式 `--instance`。

## 长连接：`orbit-automation-session`

verb 与一次性 CLI 相同。先 `connect` 起本机守护进程（handshake 一次），之后每条命令打到同一条连接；`quit` 关闭租约。再次 `connect` 复用健康守护进程，不二次握手。守护进程无响应时客户端 30s 超时，不会一直挂。

```bash
orbit-automation-session connect --instance <id>
orbit-automation-session start "Orbit: J-Link (Flash)"
orbit-automation-session continue
orbit-automation-session step 1 --action into
orbit-automation-session read aww ass
orbit-automation-session breakpoints add --params '{"breakpoint":{"source":{"path":"src/main.c","line":42}}}'
orbit-automation-session status
orbit-automation-session quit
```

默认 scopes（`connect` 时可用 `--scopes` 覆盖）：

默认 scopes（可用 `--scopes` 覆盖）：

```
read, session.control, breakpoints.write, variables.write, record
```

### 协议

```
出: {"ok":true,"data":{"event":"ready","connectionId":"...","grantedScopes":[...],"session":null}}
入: {"command":"<name>","action"?,"params"?,"session"?,"idempotencyKey"?}
出: {"ok":true,"data":<invoke result>}
  | {"ok":false,"error":"...","code"?,"errorCode"?,"retryable"?}
入: {"command":"quit"}
出: {"ok":true,"data":{"closed":true,"interrupted":false}}
```

命令错误不杀进程。`SessionChanged` 自动 `refreshSession` 并重试一次。`start` 停在入口，调用方再发 `continue`。无 SSE；轮询 `status` / `refresh`。

### 命令

| command | action（默认） | 方法 |
|---|---|---|
| `start` | — | `orbit.session.start` |
| `stop` | — | `orbit.session.stop` |
| `pause` / `continue` | — | `orbit.target.pause` / `continue` |
| `step` | `into` / `over` / `out` / `instruction` | `orbit.target.step*`（`params.threadId` 必填，常用 `1`） |
| `status` | — | `orbit.session.list` |
| `refresh` | — | `refreshSession()` |
| `operation` | — | `orbit.operation.get` |
| `breakpoints` | `list` / `add` / `update` / `remove` / `replace` | `orbit.breakpoints.*` |
| `read` / `write` | — | `orbit.expression.readMany` / `writeMany` |
| `memory-read` | — | `orbit.memory.read` |
| `record` | `list` / `start` / `stop` / `get` / `clear` | `orbit.record.*` |
| `quit` / `exit` / `close` | — | `orbit.connection.close` |

`params` 与 OpenRPC 对应方法的业务字段一致（不含 `context`，客户端自动填）。所有 `step*` 都要求整数 `threadId`（≥1）；Bare-metal 单核一般是 `1`。一次性和长连接 verb 都可用位置参数 `step 1` 补上。

`breakpoints.remove` 释放目标硬件槽（`verified` 变 `false`，不再命中），文件型断点标记按 VS Code 模型仍可能出现在 `list` 里（`enabled:true, verified:false`）。从 `pause` 落在厂商 delay/循环里再 `step-into`，PC 可能在同一函数内回跳，属分支回边，不是步进回归。

无 verb、或第一参数以 `--` 开头时，仍接受 stdin NDJSON（脚本/管道用）。命令错误不杀守护进程。`SessionChanged` 自动 `refreshSession` 并重试一次。`start` 停在入口，调用方再发 `continue`。

### stdin NDJSON（可选）

```
出: {"ok":true,"data":{"event":"ready","connectionId":"...","grantedScopes":[...],"session":null}}
入: {"command":"<name>","action"?,"params"?,"session"?,"idempotencyKey"?}
出: {"ok":true,"data":<invoke result>}
  | {"ok":false,"error":"...","code"?,"errorCode"?,"retryable"?}
入: {"command":"quit"}
出: {"ok":true,"data":{"closed":true,"interrupted":false}}
```

```bash
orbit-automation-session --instance <id> <<'EOF'
{"command":"start"}
{"command":"continue"}
{"command":"step","action":"into","params":{"threadId":1}}
{"command":"quit"}
EOF
```

## 一次性 CLI：`orbit-automation`

```bash
orbit-automation <command> [args] [--registry PATH] [--project ID] [--instance ID] [--params JSON]
orbit-automation instances
orbit-automation status --instance <id>
orbit-automation start --instance <id>
orbit-automation step 1 --action out --instance <id>
orbit-automation read cnt --instance <id>
orbit-automation breakpoints add --params '{"source":{"path":"src/main.c"},"line":42}' --instance <id>
```

命令集与上表相同（无 `refresh`/`quit`）。`step`/`breakpoints`/`record` 用 `--action`；`read` 位置参数进 `expressions`；`start` 可带 configurationId。

## 租约

握手后空闲 10 分钟过期，任意成功请求续期。`orbit-automation` 结束后立即 `close()`；`orbit-automation-session` 在 `quit`/EOF/SIGINT/SIGTERM 时 `close()`。空闲超过 10 分钟再调长连接 verb 会 `ConnectionExpired`，必须重新 `connect`。非必须不要开长连接。
