# Orbit Automation Node 客户端

两种入口共用 `OrbitClient`。一次握手占用一个 10 分钟连接租约，实例上限 32 条；退出必须 `orbit.connection.close`。

**默认用一次性 `cli.js`。** 非必须不要开长连接。

| 入口 | 何时用 |
|---|---|
| `node cli.js` / `orbit-automation` | **默认。** 一条命令 handshake→执行→`close()` |
| `node session.js` / `orbit-automation-session` | **仅当**同一条流连打多步，且中间不会空等超过 10 分钟 |

必须用长连接的情况只有：需要进程内缓存 `sessionGeneration`、需要 `SessionChanged` 自动重试、或十几步连打要省握手。

`instances` 只读 registry，不握手。其余一次性命令握手后执行，`finally` 里 best-effort `close()`。

协议字段见 [`../docs/orbit-automation-api.md`](../docs/orbit-automation-api.md) 和 [`../docs/orbit-automation-openrpc.json`](../docs/orbit-automation-openrpc.json)。Python 见 [`../python/README.md`](../python/README.md)。

## 使用

本目录已是构建产物，不必再编译。

```bash
node cli.js --help
node session.js connect --instance <id>
```

或写入 `package.json` 的 `bin` 后用 `npx`：

```json
{
  "bin": {
    "orbit-automation": "cli.js",
    "orbit-automation-session": "session.js"
  }
}
```

全局参数：`--registry PATH`、`--project ID`、`--instance ID`、`--scopes a,b,c`。多窗口同一 `projectId` 必须显式 `--instance`。

## 长连接：`session.js`

verb 与一次性 CLI 相同。先 `connect` 起本机守护进程（handshake 一次），之后每条命令打到同一条连接；`quit` 关闭租约。再次 `connect` 复用健康守护进程，不二次握手。守护进程无响应时客户端 30s 超时。

```bash
node session.js connect --instance <id>
node session.js start "Orbit: J-Link (Flash)"
node session.js continue
node session.js step 1 --action into
node session.js read aww ass
node session.js breakpoints add --params "{\"breakpoint\":{\"source\":{\"path\":\"src/main.c\",\"line\":42}}}"
node session.js status
node session.js quit
```

默认 scopes（`connect` 时可用 `--scopes` 覆盖）：

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

`params` 与 OpenRPC 对应方法的业务字段一致（不含 `context`，客户端自动填）。所有 `step*` 都要求整数 `threadId`（≥1）；单核一般是 `1`。

`breakpoints.remove` 释放目标硬件槽（`verified` 变 `false`，不再命中），文件型断点标记按 VS Code 模型仍可能出现在 `list` 里（`enabled:true, verified:false`）。从 `pause` 落在厂商 delay/循环里再 `step-into`，PC 可能在同一函数内回跳，属分支回边。

无 verb、或第一参数以 `--` 开头时，仍接受 stdin NDJSON。

```bash
node session.js --instance <id> <<'EOF'
{"command":"start"}
{"command":"continue"}
{"command":"step","action":"into","params":{"threadId":1}}
{"command":"quit"}
EOF
```

PowerShell 会吃掉 `--params` 的 JSON 引号，复杂参数用 `@file` 或改 Python。

## 一次性 CLI：`cli.js`

```bash
node cli.js <command> [args] [--registry PATH] [--project ID] [--instance ID] [--params JSON]
node cli.js instances
node cli.js status --instance <id>
node cli.js start --instance <id>
node cli.js step 1 --action out --instance <id>
node cli.js read cnt --instance <id>
```

命令集与上表相同（无 `refresh`/`quit`）。`step`/`breakpoints`/`record` 用 `--action`；`read` 位置参数进 `expressions`；`start` 可带 configurationId。

库入口是 `index.js` / `index.d.ts`（`require("./index")`）。

## 租约

握手后空闲 10 分钟过期，任意成功请求续期。一次性 CLI 结束后立即 `close()`；长连接在 `quit`/EOF/SIGINT/SIGTERM 时 `close()`。空闲超过 10 分钟再调长连接 verb 会 `ConnectionExpired`，必须重新 `connect`。
