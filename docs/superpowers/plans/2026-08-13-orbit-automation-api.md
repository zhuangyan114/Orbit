# Orbit Automation API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Orbit 的全部用户级调试能力开放为稳定、版本化、可发现的本机 Automation API，使 Python、Node.js、PowerShell、MCP 和其他本机 AI Agent 能操控同一个可见的 VS Code 调试会话，并与 VS Code UI 双向同步。

**Architecture:** 每个 VS Code Extension Host 窗口启动一个仅监听 `127.0.0.1` 的 API 实例，并在共享实例目录中注册独立 endpoint。客户端先按项目发现实例并完成握手，再携带 `connectionId`、`projectId` 调用 `/v1/rpc`；目标绑定方法还必须携带精确的 `sessionId` 和 `sessionGeneration`。所有目标操作进入指定的 Orbit DAP session，由 DAP 访问唯一的 J-Link 或 CMSIS-DAP target owner。VS Code 的调试会话、断点集合和可视状态是权威来源，MCP 仅作为同一 API 的可选适配器。

**Tech Stack:** TypeScript 5.5、VS Code Extension API 1.90、Node.js HTTP/SSE、JSON-RPC 2.0、OpenRPC/JSON Schema、Vitest、`@vscode/test-electron`、现有 Orbit DAP、J-Link native/legacy owner、CMSIS-DAP helper。

## Global Constraints

- 本计划中的“开放所有 API”是指开放所有**用户级 Orbit 调试能力**；禁止开放任意 VS Code command、任意内部 `OzoneCommand`、任意 DLL 函数或任意 native helper RPC 透传。
- API 必须驱动真实、可见的 VS Code 调试会话；禁止使用鼠标/键盘模拟、窗口自动化或隐藏的第二调试会话。
- 一个 Orbit debug session 只能有一个物理 target owner。API 不得直接加载 J-Link DLL、启动第二 helper、创建 extension-host 目标连接或绕过 `SessionTargetSelector`。
- 存在目标 Orbit DAP session 时，所有状态、控制、变量、内存、断点、采样和 RTT 请求必须路由到该精确 `vscode.DebugSession`；失败后不得回退到 extension-host backend。
- 一个 VS Code 窗口实例同时最多允许一个处于 `starting|connected|running|halted|terminating` 的 Orbit target session。`orbit.session.start` 在已有该类 session 时返回 `SessionAlreadyActive`。这个限制是 VS Code 全局断点集合与精确 target owner 路由能够保持一致的前提。
- 所有 `targetBound=true` 的请求必须携带 `connectionId`、`projectId`、`sessionId` 和 `sessionGeneration`；其中 mutation 还必须携带 `idempotencyKey`。`orbit.session.start` 尚无 session identity，必须携带 connection/project/instance、当前 registry generation 和 `idempotencyKey`，且只允许在该实例没有活动 Orbit session 时执行。断点和非采样视图 mutation 属于项目/VS Code 状态操作，使用 `ConnectionMutationContext`，可在无活动 session 时执行。任一身份不匹配时返回错误，不得自动选择其他窗口或新会话。
- VS Code 的 `vscode.debug.breakpoints` 是断点请求的唯一权威集合。API 断点和用户断点不区分来源，必须在编辑器 gutter 和 Run and Debug 视图中可见、可编辑、可删除。
- API 只监听 `127.0.0.1`，每个 VS Code 实例使用独立随机 Bearer token；不得默认监听局域网或公网地址。
- 内存协议始终是 byte-oriented；地址和 64 位整数用字符串表示，内存数据用 Base64，禁止依赖 JSON `number` 表示 64 位精确值。
- 表达式边界只做 Unicode-preserving trim 和空值拒绝，不得删除 Han 字符或静默改写表达式。若现有 UI 历史数据需要清洗，只能整项拒绝并返回 `InvalidExpression`，禁止清洗后执行写入。
- 控制优先级保持 `control > watch > timeline > background`；API 不得通过停用 Watch、Timeline、variables、evaluate、RTT 或 Memory Viewer 来换取控制操作成功。
- `src/debug/dap-session.ts` 不得导入 `vscode`。Extension Host 与 DAP adapter 仍是两个独立进程。
- 不手工编辑 `dist/`。所有 bundle 由 `npm run build` 生成。
- 不在未经用户明确授权的情况下执行真实硬件写入、Flash、Reset、Continue、Step 或内存写入验收。
- Mock 结果只能称为 Mock/自动化验证，不能称为真实硬件通过。
- 每个任务先写失败测试，再做最小实现；每个任务单独审查、验证和提交，不把不相关重构混入同一提交。
- 当前工作区在编写本计划时存在未解决的 Timeline 合并冲突。实施前必须从用户确认的干净基线创建新分支/工作树；禁止以解决这些无关冲突为名修改或丢弃用户内容。

---

## 1. 最终能力范围

### 1.1 实例、项目与握手

| API | 目标 |
|---|---|
| `orbit.instance.describe` | 返回 VS Code 窗口实例、版本、工作区和 endpoint 信息 |
| `orbit.project.describe` | 返回单根/多根工作区、workspace 文件、ELF、launch 配置和稳定 `projectId` |
| `orbit.project.listLaunchConfigurations` | 列出本窗口可启动的 `orbit`/兼容 `ozone` launch 配置 |
| `orbit.handshake` | 校验 API 版本、实例、项目和所需权限，返回 `connectionId` |
| `orbit.connection.close` | 释放连接、SSE 订阅和幂等缓存 |
| `orbit.operation.get` | 查询已派发 mutation 的最终结果，避免断线或超时后重复执行 |
| `orbit.system.capabilities` | 返回当前版本和当前 owner/session 的可用能力 |

### 1.2 VS Code 调试会话与目标控制

| API | 目标 |
|---|---|
| `orbit.session.list` / `snapshot` | 获取精确会话身份、generation、phase、owner、target state、PC 和停止原因 |
| `orbit.session.start` | 通过 `vscode.debug.startDebugging()` 启动可见会话 |
| `orbit.session.stop` | 通过 `vscode.debug.stopDebugging(session)` 停止指定会话 |
| `orbit.session.restart` | 复用 DAP restart 语义并保持 VS Code UI 同步 |
| `orbit.target.pause` / `continue` / `reset` | 控制指定 session，并发出标准 DAP stopped/continued 事件 |
| `orbit.target.stepOver` / `stepInto` / `stepOut` / `stepInstruction` | 复用现有 source/instruction step 状态机 |
| `orbit.target.flash` | 仅通过选中的 session owner 执行显式 Flash；返回校验与诊断结果 |

### 1.3 可视化断点

| API | 目标 |
|---|---|
| `orbit.breakpoints.list` | 合并 VS Code requested 状态与 DAP verified/address/slot 状态 |
| `orbit.breakpoints.add` | 调用 `vscode.debug.addBreakpoints()`，随后等待 DAP 验证 |
| `orbit.breakpoints.update` | 以 remove+add 方式修改同一个 VS Code 断点语义 |
| `orbit.breakpoints.remove` | 只删除精确匹配的 VS Code breakpoint 对象 |
| `orbit.breakpoints.replace` | 原子替换指定 source 的完整断点集合，语义等同 DAP `setBreakpoints` |

### 1.4 运行态数据

| API | 目标 |
|---|---|
| `orbit.runtime.threads` / `stackTrace` / `scopes` / `variables` | 暴露标准 DAP 可观察结构和 `variablesReference` 生命周期 |
| `orbit.runtime.registers` | 读取核心/浮点/系统寄存器，保留精确值和 `memoryReference` |
| `orbit.expression.evaluate` / `readMany` / `writeMany` / `inspect` | 读取、写入、展开并检查调试器表达式 |
| `orbit.symbol.search` / `resolve` | 使用已加载 ELF/DWARF 搜索和解析符号，不扫描或猜测目标内存 |
| `orbit.memory.read` / `write` | 按字节读取/写入目标内存，支持 partial read 和可选写后校验；运行态直接访问当前 owner，不暂停目标程序 |

### 1.5 Watch、Timeline、录波、RTT 与诊断

| API | 目标 |
|---|---|
| `orbit.watch.list` / `replace` / `add` / `remove` | 与 `ozoneWatchExpressions` 和 Watch UI 双向同步 |
| `orbit.timeline.list` / `replace` / `start` / `stop` / `status` | 与 Timeline UI 表达式及采样状态双向同步 |
| `orbit.record.start` / `stop` / `list` / `get` / `clear` | 多通道同步录波；支持分页读取，禁止一次返回无限历史 |
| `orbit.experiment.run` | 保留 read/write/wait/record 通用实验模型，并增加 generation/权限/取消保护 |
| `orbit.rtt.status` / `start` / `stop` / `read` | 使用选中的 session owner；不把 RTT 与 Timeline 合并为同一逻辑消费者 |
| `orbit.diagnostics.snapshot` | 返回 API、DAP、owner、scheduler 和采样性能摘要，不返回 Bearer token |

### 1.6 实时事件

`GET /v1/events` 使用 SSE，至少发布：

- `instance.changed`
- `project.changed`
- `session.started`、`session.phaseChanged`、`session.terminated`、`session.replaced`
- `target.running`、`target.stopped`、`target.reset`、`target.connectionLost`
- `breakpoints.changed`、`breakpoint.verified`、`breakpoint.hit`
- `watch.changed`、`timeline.changed`
- `record.started`、`record.frame`、`record.stopped`
- `rtt.stateChanged`
- `request.completed`、`request.failed`

### 1.7 API v1 规范方法清单

以下清单是 method catalog 的唯一命名来源。前文表格中的 `/` 仅用于紧凑展示，不代表一个组合 method：

```text
orbit.instance.describe
orbit.project.describe
orbit.project.listLaunchConfigurations
orbit.handshake
orbit.connection.close
orbit.operation.get
orbit.system.capabilities
orbit.session.list
orbit.session.snapshot
orbit.session.start
orbit.session.stop
orbit.session.restart
orbit.target.pause
orbit.target.continue
orbit.target.reset
orbit.target.stepOver
orbit.target.stepInto
orbit.target.stepOut
orbit.target.stepInstruction
orbit.target.flash
orbit.breakpoints.list
orbit.breakpoints.add
orbit.breakpoints.update
orbit.breakpoints.remove
orbit.breakpoints.replace
orbit.runtime.threads
orbit.runtime.stackTrace
orbit.runtime.scopes
orbit.runtime.variables
orbit.runtime.registers
orbit.expression.evaluate
orbit.expression.readMany
orbit.expression.writeMany
orbit.expression.inspect
orbit.symbol.search
orbit.symbol.resolve
orbit.memory.read
orbit.memory.write
orbit.watch.list
orbit.watch.replace
orbit.watch.add
orbit.watch.remove
orbit.timeline.list
orbit.timeline.replace
orbit.timeline.start
orbit.timeline.stop
orbit.timeline.status
orbit.record.start
orbit.record.stop
orbit.record.list
orbit.record.get
orbit.record.clear
orbit.experiment.run
orbit.rtt.status
orbit.rtt.start
orbit.rtt.stop
orbit.rtt.read
orbit.diagnostics.snapshot
```

在 v1 冻结后添加 method 属于向后兼容的 minor API 增量；重命名、删除、改变必填字段或改变错误语义需要新的 major API version。

### 1.8 方法元数据与完整 DTO 的冻结要求

Task 0 必须先生成 `docs/api/orbit-automation-openrpc.json`，它是所有公开 params/result 的唯一机器可读来源；Task 1 只能实现该文件，不得重新发明字段。每个 catalog method 都必须在 OpenRPC 中声明：

```ts
interface PublicMethodMetadata {
  name: `orbit.${string}`;
  bootstrap: boolean;
  requiredScopes: AutomationScope[];
  mutation: boolean;
  requiresIdempotency: boolean;
  targetBound: boolean;
  defaultTimeoutMs: number;
  paramsSchemaRef: string;
  resultSchemaRef: string;
  errorCodes: string[];
}
```

固定的公共 context 类型：

```ts
interface BootstrapContext {
  instanceId: string;
  projectId: string;
}

interface ConnectionContext extends BootstrapContext {
  connectionId: string;
}

interface ConnectionMutationContext extends ConnectionContext {
  idempotencyKey: string;
}

interface ProjectMutationContext extends ConnectionMutationContext {
  registryGeneration: number;
}

interface SessionRef {
  sessionId: string;
  sessionGeneration: number;
}

interface TargetRequestContext extends ConnectionContext, SessionRef {}

interface TargetMutationContext extends TargetRequestContext {
  idempotencyKey: string;
}
```

固定的返回 envelope 数据（外层仍是 JSON-RPC result/error）：

```ts
interface OperationResult<T> {
  requestId: string;
  instanceId: string;
  projectId: string;
  sessionId?: string;
  sessionGeneration?: number;
  targetState?: string;
  data: T;
  diagnostics?: Record<string, unknown>;
}
```

DTO 设计规则：

- list 方法返回 `{ items, nextCursor? }`；默认 limit 100，最大 1,000，除 recording frames 采用本计划的专门上限。
- add/update/remove/replace 返回操作后的完整资源 snapshot，而不是只返回 boolean。
- `session.snapshot`、`breakpoints.list`、`runtime.*`、`record.*` 和 `diagnostics.snapshot` 的完整 schema 必须在 Task 0 冻结。
- Task 0 的 contract validator 必须拒绝任何缺 params、result、metadata、scope、timeout 或 errorCodes 的 method。

固定 method policy（相同前缀的各个 method 仍须在 OpenRPC 逐项展开）：

| Method family | Bootstrap | Scopes | Mutation | Idempotency | Target bound | Timeout |
|---|---:|---|---:|---:|---:|---:|
| `instance.describe`, `project.describe`, `system.capabilities` | 是 | 无 | 否 | 否 | 否 | 2 s |
| `handshake` | 是 | 由 policy 裁剪 | 是 | 否 | 否 | 2 s |
| `connection.close` | 否 | `read` | 是 | 否 | 否 | 2 s |
| `operation.get`, `project.listLaunchConfigurations`, `session.list/snapshot` | 否 | `read` | 否 | 否 | 否 | 5 s |
| `session.start` | 否 | `session.control` | 是 | 是 | 否 | 30 s |
| `session.stop/restart`, `target.pause/continue/reset/step*` | 否 | `session.control` | 是 | 是 | 是 | 30 s |
| `target.flash` | 否 | `flash` | 是 | 是 | 是 | 180 s |
| `breakpoints.list` | 否 | `read` | 否 | 否 | 否 | 5 s |
| `breakpoints.add/update/remove/replace` | 否 | `breakpoints.write` | 是 | 是 | 否 | 15 s |
| `runtime.*`, `expression.evaluate/readMany/inspect`, `symbol.*`, `memory.read` | 否 | `read` | 否 | 否 | 是 | 10 s |
| `expression.writeMany` | 否 | `variables.write` | 是 | 是 | 是 | 15 s |
| `memory.write` | 否 | `memory.write` | 是 | 是 | 是 | 30 s |
| `watch.*`, `timeline.*` write methods | 否 | `view.write` | 是 | 是 | 否/是（sampling） | 10 s |
| `record.start/stop/clear` | 否 | `record` | 是 | 是 | 是 | 15 s |
| `record.list/get` | 否 | `read` | 否 | 否 | 是 | 10 s |
| `experiment.run` | 否 | 每个 step 所需 scopes 的并集 | 是 | 是 | 是 | request 指定，上限 10 min |
| `rtt.status/read` | 否 | `read` | 否 | 否 | 是 | 10 s |
| `rtt.start/stop` | 否 | `rtt.control` | 是 | 是 | 是 | 15 s |
| `diagnostics.snapshot` | 否 | `read` | 否 | 否 | 否/可选 session | 5 s |

---

## 2. 协议规范

### 2.1 Endpoint 发现

每个 Extension Host 生成随机 UUID `instanceId`，并原子写入：

```text
<extension-global-storage>/automation-api/endpoints/<instanceId>.json
```

endpoint 内容：

```json
{
  "schemaVersion": 1,
  "instanceId": "4aa4d6e7-...",
  "projectId": "sha256:...",
  "workspaceFolders": ["C:\\work\\robot"],
  "host": "127.0.0.1",
  "port": 49321,
  "rpcUrl": "http://127.0.0.1:49321/v1/rpc",
  "eventsUrl": "http://127.0.0.1:49321/v1/events",
  "token": "<random-48-byte-token>",
  "processId": 12345,
  "startedAt": 1786540000000,
  "heartbeatAt": 1786540005000,
  "apiVersions": ["1.0"]
}
```

规则：

- `projectId` = `sha256` of normalized workspace-file URI plus sorted normalized workspace-folder URIs。
- Windows 本地路径比较不区分大小写，但返回原始展示路径。
- 相同项目可被多个窗口打开，因此 `projectId` 不唯一；`instanceId` 才是窗口实例身份。
- heartbeat 每 5 秒原子更新；正常 deactivate 删除自己的文件。
- 客户端不能只信 heartbeat，必须调用 `/health`。连接失败或实例身份不符即视为 stale。
- 多个 endpoint 匹配同一个 `projectId` 时，客户端必须要求调用者指定 `instanceId`，不得选择最近活动窗口。

### 2.2 JSON-RPC 2.0

新协议使用 `POST /v1/rpc`：

```json
{
  "jsonrpc": "2.0",
  "id": "req-42",
  "method": "orbit.target.stepOver",
  "params": {
    "context": {
      "connectionId": "conn_...",
      "projectId": "sha256:...",
      "instanceId": "...",
      "sessionId": "...",
      "sessionGeneration": 7,
      "idempotencyKey": "trial-17-step-1"
    },
    "granularity": "source"
  }
}
```

成功响应：

```json
{
  "jsonrpc": "2.0",
  "id": "req-42",
  "result": {
    "requestId": "req-42",
    "sessionGeneration": 7,
    "targetState": "halted",
    "data": {}
  }
}
```

失败响应：

```json
{
  "jsonrpc": "2.0",
  "id": "req-42",
  "error": {
    "code": -32012,
    "message": "SessionChanged",
    "data": {
      "errorCode": "SessionChanged",
      "expectedGeneration": 7,
      "actualGeneration": 8,
      "retryable": false
    }
  }
}
```

统一业务错误码至少包括：

```text
Unauthorized, InvalidRequest, UnsupportedApiVersion, CapabilityUnavailable,
ProjectMismatch, InstanceMismatch, AmbiguousInstance, ConnectionExpired,
NoActiveSession, SessionStarting, SessionChanged, SessionTerminating,
TargetDisconnected, TargetRunning, TargetBusy, TargetReadCancelled,
InvalidExpression, ExpressionNotWritable, InvalidAddress, MemoryReadFailed,
MemoryWriteFailed, BreakpointNotFound, BreakpointUnverified,
RecordingNotFound, RateLimited, RequestTimeout, InternalError
```

### 2.3 握手与 generation fence

`orbit.handshake` 输入必须包含：

```ts
interface HandshakeRequest {
  apiVersion: '1.0';
  client: { name: string; version?: string; pid?: number };
  expected: { projectId: string; instanceId?: string; workspaceRoot?: string };
  requestedScopes: AutomationScope[];
}

type AutomationScope =
  | 'read'
  | 'session.control'
  | 'breakpoints.write'
  | 'view.write'
  | 'record'
  | 'rtt.control'
  | 'variables.write'
  | 'memory.write'
  | 'flash';
```

Bootstrap method 只验证 endpoint Bearer token、BootstrapContext 和 bootstrap schema，不要求 connection/scope。`handshake` 是唯一创建 connection 的 bootstrap mutation。

返回 `connectionId`、实际 scopes、project/instance 描述、当前 session snapshot 和 capabilities。实际 scopes = `requestedScopes ∩ orbit.automation.allowedScopes`；`allowedScopes` 是 VS Code 用户设置，默认仅 `read`，首次请求新增 mutation scope 时必须由 VS Code 模态确认并将选择保存到当前 workspace。Bearer token 本身不能自授 mutation scope。连接 10 分钟无活动后过期；任意成功请求刷新租约。

每个实例拥有一个单调递增的 `registryGeneration`。每次会使旧 target/session reference 失效的 transition 都先递增 registry generation；若 transition 创建或保留一个可用 session，则把新值赋给它的 `sessionGeneration`。因此 session 创建时两者相等，restart 后同一 sessionId 获得新的、仍与 registry generation 相等的 sessionGeneration；terminate 或 owner loss 后没有可用于 target request 的新 session reference：

- 实例首次启动且从未发生 session transition 时 `registryGeneration=0`；没有 session 时不存在 `sessionGeneration`，而 registry generation 保留最后的单调值，绝不回退到 0。
- 每个 lifecycle transition 只通过 `SessionRegistry.transition(eventId, nextState)` 递增一次。一次 replacement 被建模为 `old terminated`（+1）后 `new started`（+1）；`session.replaced` 只是派生事件，不再次递增。
- owner lost 使当前 session 进入 `error/terminating` 并递增一次；该 session 不会获得新 generation，必须终止后重新 start。
- `session.start` 成功后返回新 generation。
- `session.restart` 成功后保留 `sessionId`，registry generation 与 session generation 同步递增一次；旧 variablesReference、request context 和 DAP automation completion 全部失效。
- generation 不匹配时，读写都不得转发到 DAP。
- 只读的 `instance.describe`、`project.describe`、`session.list` 可不带 generation，用于恢复连接。
- duplicate `session.start` 返回 `SessionAlreadyActive` 和现有 snapshot，不创建新 session、不递增 generation。

### 2.4 幂等、限流与数据上限

- `requiresIdempotency=true` 的 mutation 必须包含 `idempotencyKey`；每个 connection 缓存最近 1024 个结果 5 分钟。`handshake` 和 `connection.close` 虽是 mutation，但 metadata 明确为 `requiresIdempotency=false`。
- Mutation dispatch 顺序固定为：认证/connection -> project/instance fence -> 对 `targetBound=true` 方法执行 session generation fence -> scope -> 按 `requiresIdempotency` 执行 lookup/reservation -> handler。
- 相同 key、相同规范化参数、相同 identity/generation 返回原结果；相同 key、不同参数或不同 generation 返回 `InvalidRequest`，绝不跨 generation replay 成功 mutation。
- 并发相同 key 合并到一个 in-flight Promise；只有一个 handler 可以开始。
- Handler 开始后，HTTP 断开不取消 mutation。服务保存最终结果供同 key 重试查询，避免客户端因断线重复写入。
- Timeout 分为 `queueTimeout`（handler 未开始，可安全重试）和 `outcomeUnknown`（mutation 已派发且无法证明完成）。`outcomeUnknown` 的相同 key 只能查询原 operation status，禁止再次执行；`orbit.operation.get({ connectionId, operationId })` 返回 `{ status: 'queued'|'running'|'succeeded'|'failed'|'outcomeUnknown', result?, error? }`，并可结合 `orbit.session.snapshot`/资源 read 验证状态。
- Flash、reset、continue、step、variable write、memory write 和 breakpoint mutation 必须返回 `operationId`，并发布最终 `request.completed/failed` 事件。
- HTTP body 上限 1 MiB；单次内存读写上限 1 MiB。
- 单实例最多 32 个握手连接、8 个 SSE 连接、4 个并发 recording。
- recording 最多 64 channels、50,000 frames；API recording 最小 interval 5 ms。
- SSE ring 保留最近 1,000 个事件；支持 `Last-Event-ID`，超出保留窗口返回 `events.reset` 快照事件。
- SSE 每 15 秒发送 heartbeat comment；客户端断开后立即释放 listener。
- 全实例 recording data 总预算 64 MiB；SSE ring 总预算 8 MiB；幂等 result cache 总预算 16 MiB；单 event 256 KiB；单 RPC result 8 MiB；超限时优先淘汰最旧 completed data，活动 mutation 不被静默取消。

### 2.5 SSE wire contract

客户端使用 `GET /v1/events`，设置 `Authorization: Bearer <token>`、`X-Orbit-Connection-Id: <connectionId>` 和可选 `Last-Event-ID`。v1 不支持浏览器原生 `EventSource`，因为它不能可靠设置 Authorization header；API 不提供 query-string token，CORS 默认关闭。

```text
id: 0000000000000042
event: target.stopped
data: {"eventId":"0000000000000042","instanceId":"...","projectId":"...","sessionId":"...","sessionGeneration":7,"timestamp":1786540000000,"type":"target.stopped","data":{"reason":"breakpoint","pc":"0x08001234"}}

```

规则：

- event id 是实例内单调递增的 64 位十进制字符串；publish 顺序就是 wire 顺序。
- filter 使用重复 header `X-Orbit-Event-Type`；未提供时订阅 connection scopes 允许的所有事件。
- 慢消费者 pending bytes 超过 1 MiB 时发送 `events.reset`（若 socket 仍可写）并关闭连接；不允许无界 socket queue。
- `events.reset.data` 包含当前 instance/project/session/breakpoint/view/recording/RTT snapshot 和最新 eventId。
- 不提供事件轮询 API；无法使用 SSE 的客户端轮询对应 snapshot 方法。客户端文档不得声称可以轮询历史事件。

### 2.6 Endpoint 位置与本机文件安全

- 默认 registry pointer 路径固定为当前用户范围：Windows `%LOCALAPPDATA%\Orbit\automation\registries.json`，macOS `~/Library/Application Support/Orbit/automation/registries.json`，Linux/Unix `${XDG_RUNTIME_DIR:-~/.local/state}/orbit/automation/registries.json`。`ORBIT_AUTOMATION_REGISTRY` 可覆盖该路径。
- Pointer schema 为 `{ "schemaVersion": 1, "registries": [{ "channel": "stable|insiders|portable|remote", "profile": "<name-or-empty>", "extensionHost": "local|ssh|wsl|container", "endpointDirectory": "<absolute-path>", "updatedAt": 0 }] }`。扩展按自己的 channel/profile/host 原子 upsert；客户端读取全部 registry entries 后枚举 endpoint。
- Portable VS Code 仍写上述 OS 用户范围 pointer，但 entry 指向 portable global storage；若该位置不可写，则必须设置 `ORBIT_AUTOMATION_REGISTRY`，API 启动给出明确错误。Profile 是 entry identity 的一部分，不影响 projectId。
- Remote SSH/WSL/Container 中 API 与 endpoint 运行在 Extension Host 所在机器；默认仅对该机器的 loopback 客户端可用，不自动端口转发到本地桌面。
- Windows 创建目录/文件后收紧 ACL 为当前用户和 SYSTEM；POSIX 使用目录 `0700`、文件 `0600`。无法保证权限时 API 启动失败，不降级为宽松权限。
- 写入前拒绝 endpoint 根、目录、临时文件或目标文件中的 symlink/junction/reparse point；客户端也拒绝非普通文件和 owner 不匹配的 registry。
- 启动时扫描同一 registry 下 stale 文件：只有 health 失败且 heartbeat 超过 30 秒才删除；不得删除 health 返回不同 instanceId 的活实例。
- Task 2 必须给 Stable/Insiders/portable/remote 行为写入用户文档和测试矩阵。

---

## 3. 目标文件结构

```text
src/plugin-api/
  protocol.ts                 # JSON-RPC、context、错误、公开 DTO
  schemas.ts                  # Zod request/response validation
  rpc-dispatcher.ts           # 方法注册、scope、generation、幂等和 timeout
  plugin-api-server.ts        # HTTP /health、/v1/rpc、/v1/events 薄传输层
  instance-registry.ts        # instanceId、projectId、endpoint、heartbeat、cleanup
  handshake-service.ts        # connection lease、scope 和项目握手
  session-registry.ts         # 精确 DebugSession identity 和 generation
  event-hub.ts                # 有界事件 ring 与 SSE subscriber
  session-service.ts          # start/stop/restart/snapshot/config
  breakpoint-service.ts       # VS Code breakpoint 权威集合与 DAP verified 合并
  runtime-router.ts           # 精确 session DAP 路由；无 active-session fallback
  runtime-service.ts          # threads/stack/scopes/variables/register/symbol/expression
  memory-service.ts           # base64 字节内存访问和 verify
  recording-service.ts        # recording/experiment 与统一采样消费者
  view-state-service.ts       # Watch/Timeline 表达式和 UI 状态
  rtt-service.ts              # RTT status/start/stop/read
  diagnostics-service.ts      # 脱敏 snapshot
  *.test.ts

src/debug/
  dap-automation-protocol.ts  # Extension Host 与 DAP 的内部类型契约
  dap-session.ts              # 复用现有 handler，增加 automation dispatch/event
  dap-session-automation.test.ts

clients/
  node/                       # Node fetch/SSE client + CLI
  python/                     # Python 标准库 client
  powershell/                 # Orbit.Automation.psm1

docs/api/
  orbit-automation-api.md     # 用户/API 文档
  orbit-automation-openrpc.json
  orbit-automation-events.schema.json

scripts/automation-api/
  verify-contract.js
  verify-multi-window.js
  verify-hardware.js
  acceptance-validator.js
```

`plugin-api-server.ts` 只负责传输，不应继续增长为包含所有业务 switch 的大文件。`dap-session.ts` 可保留状态机，但 automation DTO、验证和 extension-host 服务不得塞入其中。

---

## 4. 任务拆分

### Task 0: 建立干净实施基线与验收清单

**Depends on:** 无

**Files:**
- Create: `docs/api/orbit-automation-api.md`
- Create: `docs/api/orbit-automation-acceptance-matrix.md`
- Create: `docs/api/orbit-automation-openrpc.json`
- Create: `scripts/automation-api/verify-contract.js`
- Do not modify: 当前冲突中的 Timeline 文件

**Produces:** 冻结的 API v1 method metadata、完整 params/result/error schema、错误码和验收用例编号 `API-001...`。

- [ ] 从用户确认的 commit 创建 `codex/orbit-automation-api` 或独立 worktree，确认 `git diff --name-only --diff-filter=U` 为空。
- [ ] 读取仓库 `AGENTS.md`、相关 debug skill、`docs/architecture.md`、`docs/debug-engine-refactor/realtime-variable-protection.md` 和本计划。
- [ ] 将本计划第 1、2 节复制并细化为用户协议文档；为规范清单中的每一个 method 填写完整 OpenRPC params/result/error、bootstrap、scope、mutation、requiresIdempotency、targetBound 和 timeout；不得改变已经冻结的方法名、identity 字段和安全边界。
- [ ] 创建 contract validator，任何 method 缺 schema/metadata 或引用未定义的 context/DTO 时必须失败；Task 1 开始前 validator 必须通过。
- [ ] 建立验收矩阵，至少为发现、握手、会话、控制、断点、变量、内存、录波、事件、SDK、MCP、错误注入和双 probe 硬件各分配用例。
- [ ] 运行 `git diff --check`，预期 exit 0。
- [ ] Commit: `docs: define Orbit Automation API v1 contract`。

### Task 1: JSON-RPC 类型、Schema 与 Dispatcher

**Depends on:** Task 0

**Files:**
- Create: `src/plugin-api/protocol.ts`
- Create: `src/plugin-api/schemas.ts`
- Create: `src/plugin-api/rpc-dispatcher.ts`
- Create: `src/plugin-api/rpc-dispatcher.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**

```ts
export interface AutomationRequestContext {
  connectionId: string;
  projectId: string;
  instanceId: string;
  sessionId?: string;
  sessionGeneration?: number;
  idempotencyKey?: string;
}

export interface RpcMethodDefinition<P, R> {
  name: `orbit.${string}`;
  bootstrap: boolean;
  requiredScopes: AutomationScope[];
  mutation: boolean;
  requiresIdempotency: boolean;
  targetBound: boolean;
  timeoutMs: number;
  paramsSchema: z.ZodType<P>;
  handler(params: P, call: RpcCallContext): Promise<R>;
}

export class RpcDispatcher {
  register<P, R>(definition: RpcMethodDefinition<P, R>): void;
  dispatch(request: unknown, authorization: string | undefined): Promise<JsonRpcResponse>;
}

export interface RpcCallContext {
  requestId: string;
  connection?: ConnectionLease;
  identity?: BootstrapContext | ConnectionContext | ConnectionMutationContext | ProjectMutationContext | TargetRequestContext | TargetMutationContext;
  signal: AbortSignal;
  operationId?: string;
}
```

- [ ] 将 `zod@4.4.3` 加为直接 dependency，禁止依赖 MCP SDK 的传递依赖。
- [ ] 写失败测试：非法 JSON-RPC、未知 method、缺 context、scope 拒绝、generation mismatch、`requiresIdempotency=true` 缺 key、bootstrap handshake 不要求 key、重复请求复用结果、key 冲突。
- [ ] 实现统一 DTO、`AutomationError` 和 JSON-RPC error mapping。
- [ ] 实现 method registry、schema parse、timeout、scope/generation hook、`orbit.operation.get` operation store 和有界幂等缓存；只有 `targetBound=true` 才要求 session identity/generation，只有 `requiresIdempotency=true` 才要求 key。
- [ ] 严格实现 §2.4 的 fence/idempotency/timeout 顺序和 in-flight 合并；为 `outcomeUnknown` 写不会二次执行 handler 的测试。
- [ ] 保留旧 `/rpc` envelope 的类型，仅作为后续兼容层；新 service 不得返回旧 `{ok,error}` 顶层格式。
- [ ] Run: `npx vitest run src/plugin-api/rpc-dispatcher.test.ts`，预期全部通过。
- [ ] Run: `npm run typecheck`，预期 exit 0。
- [ ] Commit: `feat(api): add versioned RPC contract and dispatcher`。

### Task 2: 多 VS Code 实例发现与项目握手 已完成

**Depends on:** Task 1

**Files:**
- Create: `src/plugin-api/instance-registry.ts`
- Create: `src/plugin-api/instance-registry.test.ts`
- Create: `src/plugin-api/handshake-service.ts`
- Create: `src/plugin-api/handshake-service.test.ts`
- Modify: `src/plugin-api/plugin-api-server.ts`
- Modify: `src/plugin-api/types.ts` only for legacy compatibility types
- Modify: `src/extension.ts` only after unrelated conflicts are absent

**Interfaces:**

```ts
export class InstanceRegistry implements vscode.Disposable {
  start(server: BoundServerInfo): Promise<InstanceDescriptor>;
  describe(): InstanceDescriptor;
  dispose(): Promise<void>;
}

export class HandshakeService {
  handshake(request: HandshakeRequest): HandshakeResponse;
  authorize(connectionId: string, scope: AutomationScope): ConnectionLease;
  close(connectionId: string): void;
}
```

- [ ] 写失败测试：单根、多根、`.code-workspace` projectId；Windows 大小写归一化；两个相同 projectId 不同 instanceId；原子 endpoint；stale cleanup；错误 project/instance；lease expiry。
- [ ] 实现随机 `instanceId`、稳定 `projectId`、5 秒 heartbeat、atomic temp+rename 和 dispose cleanup。
- [ ] 实现 §2.6 的 Stable/Insiders/portable/remote registry 定位、env override、ACL/mode、reparse/symlink 拒绝、owner 校验和 30 秒 stale cleanup。
- [ ] 把现有固定 `plugin-api-endpoint.json` 改为 endpoint 目录；在一个兼容周期内继续写 legacy pointer 文件，但内容只标记 `ambiguous` 或唯一实例，禁止覆盖式选择错误窗口。
- [ ] 注册 `orbit.instance.describe`、`orbit.project.describe`、`orbit.handshake`、`orbit.connection.close`、`orbit.system.capabilities`。
- [ ] `/health` 返回 `instanceId`、`projectId`、API version 和 uptime，不返回 token。
- [ ] Run focused Vitest，预期全部通过；再运行 `npm run typecheck` 和 `npm run build`。
- [ ] Commit: `feat(api): add multi-instance discovery and project handshake`。

### Task 3: 精确 DebugSession 注册与 generation fence 已完成

**Depends on:** Task 2

**Files:**
- Create: `src/plugin-api/session-registry.ts`
- Create: `src/plugin-api/session-registry.test.ts`
- Create: `src/plugin-api/event-hub.ts`
- Create: `src/plugin-api/event-hub.test.ts`
- Modify: `src/extension.ts`
- Modify: `src/utils/debug-session-type.ts` if session type normalization needs reuse

**Interfaces:**

```ts
export interface SessionSnapshot {
  sessionId: string;
  sessionGeneration: number;
  type: 'orbit' | 'ozone';
  name: string;
  phase: 'starting' | 'connected' | 'running' | 'halted' | 'terminating' | 'terminated' | 'error';
  targetState: string;
  ownerKind?: string;
  stopReason?: string;
  pc?: string;
  source?: { path: string; line: number; column?: number };
}

export class SessionRegistry {
  onStarted(session: vscode.DebugSession): void;
  onActiveChanged(session: vscode.DebugSession | undefined): void;
  onTerminated(session: vscode.DebugSession): void;
  requireExact(ref: SessionRef): vscode.DebugSession;
  snapshot(): SessionSnapshot[];
}
```

- [x] 测试启动中、active 切换、termination、相同 session object、replacement、stale async completion 和非 Orbit session。
- [x] instance-level `registryGeneration` 在 start/terminate/replacement/owner-loss 边界按 §2.3 递增；新建或 restart 后当前 session 的 `sessionGeneration` 取递增后的 registry generation，active editor focus 变化不得无故递增。
- [x] 所有 registry 比较使用 `DebugSession.id` 和对象 identity，不只比较 `type`。
- [x] 建立 `EventHub` 有界 ring，但本任务只接 session lifecycle；SSE transport 留给 Task 11。
- [x] RuntimeRouter 接受明确 `SessionRef`，不再自行每次读取 `activeDebugSession`。
- [x] Run: focused tests + `src/plugin-api/runtime-router.test.ts` + typecheck。
- [x] Commit: `feat(api): fence automation calls by debug session generation`。

### Task 4: 可见会话启动、停止、重启与配置 已完成

**Depends on:** Task 3

**Files:**
- Create: `src/plugin-api/session-service.ts`
- Create: `src/plugin-api/session-service.test.ts`
- Modify: `src/debug/ozone-debug-config.ts`
- Modify: `src/extension.ts`

**Interfaces:**

```ts
export interface StartSessionParams {
  context: ProjectMutationContext; // connectionId/projectId/instanceId/current registry generation/idempotencyKey; no sessionId
  configurationName?: string;
  configuration?: OrbitLaunchConfiguration;
  saveAllBeforeStart?: boolean;
}

export class SessionService {
  listLaunchConfigurations(): LaunchConfigurationSummary[];
  start(params: StartSessionParams): Promise<SessionSnapshot>;
  stop(ref: SessionRef): Promise<void>;
}
```

- [x] 测试命名 launch、inline config、无 ELF、配置类型错误、start 返回 false、start event timeout、重复 start 返回 `SessionAlreadyActive`、精确 stop 和 session replacement。
- [x] `start()` 只能调用 `vscode.debug.startDebugging()`；必须复用 `OzoneDebugConfigurationProvider` 的归一化规则。
- [x] API 启动后，VS Code 必须出现 Debug toolbar、Call Stack session 和标准 initialized/stopped 状态。
- [x] `stop()` 必须传入精确 session，禁止无参数停止所有 VS Code sessions。
- [x] 注册 `orbit.project.listLaunchConfigurations`、`orbit.session.list/start/stop/snapshot`。`orbit.session.restart` 由 Task 5 的 DAP bridge 唯一实现，本 Task 不创建第二条 restart 路径。
- [x] Run focused tests、typecheck、build。
- [x] Commit: `feat(api): control visible VS Code debug sessions`。

### Task 5: DAP Automation Bridge 与基础控制

**Depends on:** Task 4

**Files:**
- Create: `src/debug/dap-automation-protocol.ts`
- Create: `src/debug/dap-session-automation.test.ts`
- Modify: `src/debug/dap-session.ts`
- Modify: `src/plugin-api/runtime-router.ts`
- Modify: `src/plugin-api/runtime-router.test.ts`

**Internal DAP contract:**

```ts
type AutomationControlAction =
  | 'pause' | 'continue' | 'reset' | 'restart'
  | 'stepOver' | 'stepInto' | 'stepOut' | 'stepInstruction'
  | 'flash';

interface AutomationControlRequest {
  action: AutomationControlAction;
  sessionGeneration: number;
}

interface AutomationControlResult {
  state: 'running' | 'halted';
  stopReason?: string;
  pc?: string;
  source?: { path: string; line: number };
  diagnostics?: Record<string, unknown>;
}
```

- [x] 先写 DAP framing 测试，证明 automation control 未实现时失败。
- [x] 抽取/复用现有 continue、pause、restart、step handler 的核心逻辑；标准 DAP request 和 automation request 必须调用同一实现。
- [x] Automation 调用成功时仍发送标准 `continued`/`stopped` event，使 VS Code UI 更新；同时发送脱敏 custom event 给 Extension Host。
- [x] 保持现有 control/read barrier、step lock、断点 cleanup、native PC/source hint 和 CMSIS-DAP 状态确认。
- [x] 失败响应必须包含 `errorCode`、target state 和 diagnostics；不得在 RuntimeRouter 回退本地 backend。
- [x] 注册所有 `orbit.target.*` 基础控制方法。
- [x] 将 `orbit.session.restart` 映射到同一个 DAP restart core；restart 不更换 VS Code `sessionId`，成功后递增 session generation 一次并使旧 references/context 失效。
- [x] `orbit.target.flash` 必须携带明确 ELF path 或已解析 launch configuration、`flash` scope 和幂等 key，只通过当前 session 的 selected owner 执行；未经硬件授权只能实现和运行 Mock 测试。
- [x] Run: `src/debug/dap-session-automation.test.ts`、realtime variables、native executor、CMSIS-DAP focused tests。
- [x] Run: typecheck、build、全量 Vitest。
- [x] Commit: `feat(api): route automation control through the active DAP session`。

### Task 6: VS Code 统一断点 API

**Depends on:** Task 5

**Files:**
- Create: `src/plugin-api/breakpoint-service.ts`
- Create: `src/plugin-api/breakpoint-service.test.ts`
- Modify: `src/debug/dap-automation-protocol.ts`
- Modify: `src/debug/dap-session.ts`
- Modify: `src/extension.ts`

**Public DTO:**

```ts
interface AutomationBreakpoint {
  breakpointId: string;
  source: { path: string; line: number; column?: number };
  enabled: boolean;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
  requested: true;
  verified: boolean;
  resolvedLine?: number;
  address?: string;
  hardwareSlot?: number;
  message?: string;
  session?: { sessionId: string; sessionGeneration: number };
}
```

- [ ] 测试 API add 后进入 `vscode.debug.breakpoints`、用户 add 后 API list 可见、任一侧 remove 双向同步、条件修改、重复断点、无 active session、DAP unresolved 和六槽耗尽。
- [ ] API add/remove/update 必须使用 `vscode.debug.addBreakpoints/removeBreakpoints`，不得直接调用 backend。
- [ ] Task 0 将 `breakpoints.list` 的 context 冻结为 `ConnectionContext`，将 add/update/remove/replace 冻结为 `ConnectionMutationContext`；这些方法不要求 session identity。存在 Orbit session 时才使用精确 `SessionRef` 拉取并合并 DAP verified snapshot。
- [ ] 因每实例最多一个 Orbit target session，全局 requested breakpoint 只与该 session 的 verified snapshot 合并；其他非 Orbit VS Code sessions 不属于本 API。无 Orbit session 时返回 requested breakpoint，`verified=false` 且 session 为空。
- [ ] 监听 `vscode.debug.onDidChangeBreakpoints`，发布 `breakpoints.changed`。
- [ ] DAP 提供 requested breakpoint 到 verified/address/slot 的 snapshot；Extension Host 按规范化 source location 合并。
- [ ] breakpointId 由规范化 path/line/column/condition/hitCondition/logMessage 哈希生成，不记录创建来源。
- [ ] `replace` 仅替换指定 source，不触碰其他 source；失败时返回每个 breakpoint 的 verified 结果。
- [ ] Run focused tests、DAP breakpoint tests、J-Link/CMSIS-DAP mock。
- [ ] Commit: `feat(api): synchronize automation with VS Code breakpoints`。

### Task 7: 状态、线程、调用栈、Scopes、Variables 与寄存器

**Depends on:** Task 5

**Files:**
- Create: `src/plugin-api/runtime-service.ts`
- Create: `src/plugin-api/runtime-service.test.ts`
- Modify: `src/debug/dap-automation-protocol.ts`
- Modify: `src/debug/dap-session.ts`

- [ ] 定义 automation snapshot 请求，复用 DAP threads/stackTrace/scopes/variables 数据模型，并返回 session-scoped `variablesReference`。
- [ ] variablesReference 必须附带 generation；session replacement 后旧 reference 返回 `SessionChanged`。
- [ ] stopped-state Locals/Registers 继续遵循现有 bounded read gate；running-state 不伪造 stopped 数据。
- [ ] `session.snapshot` 返回 phase、target state、PC、source、stopReason、ownerKind、probe、device、ELF。
- [ ] `runtime.registers` 返回 `valueExact` 字符串、hex、bits、group 和 memoryReference。
- [ ] 覆盖 optimized-out local、空栈、RTOS thread、扩展变量树、连接丢失和 stale completion。
- [ ] Run scopes、connection-loss、CMSIS-DAP、native focused tests和 typecheck/build。
- [ ] Commit: `feat(api): expose runtime and stack inspection`。

### Task 8: 表达式、变量写入与符号发现

**Depends on:** Task 7

**Files:**
- Modify: `src/plugin-api/runtime-service.ts`
- Modify: `src/plugin-api/runtime-router.ts`
- Create: `src/plugin-api/expression-service.test.ts`
- Modify: `src/debug/dap-session.ts`
- Modify: `src/utils/watch-expression-validation.ts`

- [ ] 注册 `expression.evaluate/readMany/writeMany/inspect` 和 `symbol.search/resolve`。
- [ ] 在所有边界复用统一表达式 normalize：保留全部 Unicode，只 trim 并拒绝空项；历史含非法控制字符/需要迁移的表达式整项返回 `InvalidExpression`，不得删字符后执行。
- [ ] readMany 保留输入顺序和逐项错误；单项失败不抹掉其他成功项。
- [ ] writeMany 每项显式 expression/value，可选 address/typeName/verify；整个写操作走 control barrier。
- [ ] 对 float、double、signed/unsigned 8/16/32/64、enum、pointer、array/struct child 建立测试。
- [ ] 64 位值同时返回 `display` 和 `exactValue`，不得用不精确 JSON number 冒充精确值。
- [ ] symbol search 只查询已加载 ELF/DWARF cache，并限制结果数量；不扫描内存。
- [ ] Run watch expression、realtime variable、symbol tests、typecheck/build。
- [ ] Commit: `feat(api): expose expressions variables and symbols`。

### Task 9: 字节内存读写 API

**Depends on:** Task 5

**Files:**
- Create: `src/plugin-api/memory-service.ts`
- Create: `src/plugin-api/memory-service.test.ts`
- Modify: `src/debug/dap-automation-protocol.ts`
- Modify: `src/debug/dap-session.ts`

**DTO:**

```ts
interface MemoryReadParams {
  context: TargetRequestContext;
  address: string;
  count: number;
  offset?: number;
  allowPartial?: boolean;
}

interface MemoryReadResult {
  address: string;
  dataBase64: string;
  bytesRead: number;
  unreadableBytes: number;
}
```

- [ ] 复用 DAP readMemory/writeMemory 的 base64 byte contract；禁止增加 `uint32[]` 特殊语义。
- [ ] 验证 32 位地址、offset overflow、0/负 count、1 MiB 上限、invalid base64、partial read。
- [ ] 写入支持 `verify: true`：同 owner 写后读回并逐字节比较；不匹配返回 `MemoryVerifyFailed`。
- [x] Automation API 的 running-state `memory.read` / `memory.write` 必须直接使用当前 session owner，不得执行隐式 `halt` / `run`；标准 DAP MemoryView 保持现有行为。
- [ ] 探针、传输或地址不支持运行态访问时返回结构化错误，不得自动回退到 halt/read-or-write/resume，也不得创建第二个 owner。
- [ ] 运行态大块读取不是原子快照；固件可与写入及 verify read-back 竞争，竞争导致的 read failure 或 `verified:false` 必须如实返回。
- [ ] 读仍使用有界 background read gate；写及 verify 仍使用 control barrier 和同一 owner，排除并发 Watch/Timeline/native access，但不得暂停 CPU。
- [ ] 覆盖 API 运行态读、写、verify 均不调用 halt/run，API 周期读取不再造成 Timeline 断段，并确认标准 DAP MemoryView 默认语义未改变。
- [ ] 覆盖 session termination、read cancellation、owner lost 和 stale generation。
- [ ] Run DAP memory focused tests、CMSIS/J-Link mock、typecheck/build。
- [ ] Commit: `feat(api): add byte-oriented memory access`。

### Task 10: Watch、Timeline 与统一录波调度

**Depends on:** Tasks 3, 8

**Files:**
- Create: `src/plugin-api/view-state-service.ts`
- Create: `src/plugin-api/view-state-service.test.ts`
- Create: `src/plugin-api/recording-service.ts`
- Create: `src/plugin-api/recording-service.test.ts`
- Modify: `src/plugin-api/wave-recorder.ts` or replace it with a compatibility facade
- Modify: `src/plugin-api/experiment-service.ts`
- Modify: `src/debug-providers/data-sampling-manager.ts` only on a conflict-free baseline
- Modify: `src/debug/dap-session.ts`

- [ ] Watch API 与 `ozoneWatchExpressions` 使用同一数据源，UI/API 修改触发同一 normalization 和 change event。
- [ ] Timeline API 与 `ozoneDataSamplingExpressions` 使用同一数据源，保留颜色和 UI 状态元数据。
- [ ] 将 API recording 注册为独立 sampling consumer，但在 DAP/scheduler 层复用相同表达式的短窗口读取结果。
- [ ] 保持 Watch、Timeline、recording、RTT 为不同逻辑消费者；control 时统一暂停/取消低优先级读，结束后恢复。
- [ ] recording 使用分页 `get(recordingId, cursor, limit)`，默认 1,000 frames，最大 5,000 frames/response。
- [ ] 每次追加 frame 前按序列化字节估算更新全实例 64 MiB budget；达到上限时淘汰最旧 stopped recording，再裁剪最旧 active frames并发布 `record.truncated`，不得超过预算继续增长。
- [ ] duration 到期、显式 stop、session terminate、connection close 均释放 timer/listener；不得留下后台采样。
- [ ] Experiment 的 write step 必须检查 scope、安全范围、generation 和幂等性；任何失败停止后续 mutation，并返回已完成步骤。
- [ ] 覆盖 4 并发 recordings、64 channels、50,000 frame retention、step/write 并发、session replacement、stale sample 不发布。
- [ ] Run realtime variable、target-read-gate、timeline、recording focused tests和全量 Vitest。
- [ ] Commit: `feat(api): unify watch timeline and automation recording`。

### Task 11: RTT、诊断快照与 SSE 事件流

**Depends on:** Tasks 3, 5, 6, 7, 8, 9, 10

**Files:**
- Create: `src/plugin-api/rtt-service.ts`
- Create: `src/plugin-api/rtt-service.test.ts`
- Create: `src/plugin-api/diagnostics-service.ts`
- Create: `src/plugin-api/plugin-api-events.test.ts`
- Modify: `src/plugin-api/event-hub.ts`
- Modify: `src/plugin-api/plugin-api-server.ts`
- Modify: `src/debug/dap-session.ts`

- [ ] 实现 §2.5 的 `GET /v1/events` Bearer auth、connection header、event filter、Last-Event-ID、wire envelope、ring replay、reset snapshot、1 MiB slow-consumer cutoff、15 秒 heartbeat 和 disconnect cleanup。
- [ ] DAP 在标准 stopped/continued/terminated 旁发送结构化 automation custom event；Extension Host 严格检查精确 session identity/generation 后发布。
- [ ] Breakpoint、Watch、Timeline、recording 和 RTT 服务把状态变化发布到同一 EventHub。
- [ ] RTT start/stop/read 只走 selected session owner，保留 buffer、size、control block 和 ANSI 配置。
- [ ] diagnostics 脱敏 token、Authorization、原始内存数据和用户变量值；只返回计数、状态、耗时和错误码。
- [ ] 测试慢消费者、断线、8 连接上限、事件 replay、ring overflow、旧 session event 丢弃、token 不泄漏。
- [ ] Run RTT、session replacement、API event focused tests、typecheck/build。
- [ ] Commit: `feat(api): stream session events and expose RTT diagnostics`。

### Task 12: HTTP 安全、兼容层与故障恢复

**Depends on:** Tasks 1-11

**Files:**
- Modify: `src/plugin-api/plugin-api-server.ts`
- Create: `src/plugin-api/plugin-api-server.test.ts`
- Create: `src/plugin-api/legacy-api-adapter.ts`
- Modify: `src/plugin-api/types.ts`
- Modify: `package.json`

- [ ] `/v1/rpc` 对所有请求强制 Bearer；`/health` 只返回非敏感实例信息。
- [ ] CORS 默认不开放浏览器来源；若保留浏览器调用，只允许配置的 exact loopback origins，禁止 `*`。
- [ ] body 超限、慢速上传、客户端中断、无效 UTF-8/JSON、重复 id、handler timeout 都有界结束。
- [ ] server dispose 停止接受新请求，取消 recordings/SSE，等待 in-flight 只读请求，拒绝新 mutation，然后删除 endpoint。
- [ ] 添加 `orbit.automation.enabled`（boolean，默认 `false`）和 `orbit.automation.allowedScopes`（string array，默认 `["read"]`）配置；覆盖启用/禁用、热切换、握手裁剪和 scope confirmation 测试。
- [ ] 旧 `/rpc` 方法仅映射现有 status/read/write/record/experiment，并在响应添加 deprecation；不得获得跳过 handshake/generation 的新 mutation 能力。
- [ ] 日志使用 `log.dap`/`log.eval`/`log.step`/`log.dll`，不得记录 token 或完整 Authorization。
- [ ] Run server tests、全量 Vitest、typecheck、build、`git diff --check`。
- [ ] Commit: `feat(api): harden transport and preserve legacy compatibility`。

### Task 13: OpenRPC、Node/Python/PowerShell 客户端与 CLI

**Depends on:** Task 12

**Files:**
- Modify/validate: `docs/api/orbit-automation-openrpc.json` created and frozen in Task 0
- Create: `docs/api/orbit-automation-events.schema.json`
- Create: `clients/node/package.json`
- Create: `clients/node/src/index.ts`
- Create: `clients/node/src/cli.ts`
- Create: `clients/node/test/client.test.ts`
- Create: `clients/python/orbit_client.py`
- Create: `clients/python/test_orbit_client.py`
- Create: `clients/powershell/Orbit.Automation.psm1`
- Create: `clients/powershell/Orbit.Automation.Tests.ps1`
- Modify/validate: `scripts/automation-api/verify-contract.js`

- [ ] 从 Task 0 的 OpenRPC 生成 TypeScript/Python/PowerShell client bindings 或验证手写 facade，禁止重新定义或维护互相漂移的方法列表。
- [ ] 三个客户端都实现 endpoint enumerate、health probe、项目选择、ambiguous instance 错误、handshake、RPC、session context refresh、`orbit.operation.get` 和 SSE/对应 snapshot 轮询。
- [ ] Node CLI 至少支持 `instances`、`status`、`operation`、`start`、`stop`、`pause`、`continue`、`step`、`breakpoints`、`read`、`write`、`memory-read`、`record`。
- [ ] Python 默认只用标准库；PowerShell 使用 `Invoke-RestMethod`/`Invoke-WebRequest`，不得要求 VS Code 内部模块。
- [ ] 客户端默认拒绝多个相同 projectId 实例，只有显式 `--instance`/参数才能选择。
- [ ] 使用 fake HTTP/SSE server 测试完全相同的 JSON wire payload。
- [ ] Run Node、Python、PowerShell tests和 contract validator。
- [ ] Commit: `feat(api): publish schemas clients and automation CLI`。

### Task 14: MCP 迁移为可选适配器

**Depends on:** Task 13

**Files:**
- Modify: `Releases/mcp/orbit-mcp-server.js`
- Modify: `Releases/mcp/ozone-mcp-server.js` as compatibility launcher only
- Create: `Releases/mcp/orbit-mcp-server.test.js`
- Modify: `package.json`
- Update: applicable MCP skill/user docs

- [ ] MCP 不再自己实现 endpoint 选择、RPC envelope 和重试，改用 Node client。
- [ ] MCP tools 增加 `orbit_instances`、`orbit_handshake`、session/control/breakpoint/memory tools；保留现有 read/write/record/experiment tool 名的兼容映射。
- [ ] 所有 mutation tool schema 必须要求项目/instance/session context 或使用已明确握手的 connection；禁止“最近窗口”默认值。
- [ ] MCP 返回结构化 JSON，不把底层异常吞成纯文本成功。
- [ ] 测试多窗口歧义、stale session、权限拒绝、record pagination 和 legacy tool mapping。
- [ ] Run MCP tests、`npm run mcp` smoke（不连接硬件）和 contract validator。
- [ ] Commit: `feat(mcp): adapt MCP tools to Automation API v1`。

### Task 15: Extension Host 集成与双窗口自动化验收

**Depends on:** Tasks 1-14

**Files:**
- Create: `src/plugin-api/automation-api.integration.test.ts`
- Create: `scripts/automation-api/verify-multi-window.js`
- Create: `scripts/automation-api/acceptance-validator.js`
- Modify: `package.json` scripts
- Update: `docs/api/orbit-automation-acceptance-matrix.md`

- [ ] 使用 `@vscode/test-electron` 启动两个 Extension Development Host，打开两个不同项目，验证两个 endpoint 同时存活。
- [ ] 再让两个窗口打开相同项目，验证 projectId 相同、instanceId 不同、未指定 instance 时客户端拒绝。
- [ ] API 启动 session 后验证 VS Code UI tracker 看到 initialized/stopped；API pause/continue/step 后验证标准 DAP events。
- [ ] UI harness 固定使用 `@vscode/test-electron` 启动的 Extension Development Host：通过 VS Code command/context API 打开 Run and Debug、目标 source 和对应 session，并保存 Electron 窗口截图；断言 Debug toolbar 对应 debug context 已激活、Call Stack 的 session 可由官方 debug/session API 关联、`vscode.debug.breakpoints` 中的 source location 与截图 gutter 一致。允许使用稳定的官方 integration hook；不得把脆弱的任意 DOM selector 作为唯一证据。仅收到 DAP event 不算 UI 可视验收。
- [ ] 从 API 添加断点，验证 VS Code breakpoint collection；从 VS Code 测试驱动添加/删除，验证 API snapshot/SSE。
- [ ] 终止并重启 session，验证旧 session context 的 mutation 返回 `SessionChanged`，connection 可通过新 snapshot 刷新 context，且旧请求没有进入新 DAP。
- [ ] 验证 endpoint crash residue 被 health probe 排除，正常退出删除 endpoint。
- [ ] 生成机器可读 evidence JSON，并由 validator 独立检查所有 case、identity、generation 和事件顺序。
- [ ] acceptance matrix 必须逐一引用 API v1 catalog 中每个公开 method；任何 method 没有自动化 case 或明确 hardware-only case 时 validator 失败。
- [ ] Run integration suite、full Vitest、typecheck、build、J-Link/CMSIS-DAP mock、`git diff --check`。
- [ ] Commit: `test(api): verify multi-window VS Code automation`。

### Task 16: 真实硬件验收、性能门禁与发布

**Depends on:** Task 15

**Files:**
- Create: `scripts/automation-api/verify-hardware.js`
- Create: `docs/api/orbit-automation-hardware-acceptance.md`
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: release user guide/package assets as applicable

**Hardware authorization gate:** 本任务的 target-mutating 部分只有在用户明确授权具体板卡、probe 和操作后才能执行。

- [ ] 在 J-Link native owner 和 CMSIS-DAP owner 各执行一次完整流程：handshake、visible start、breakpoint add/hit/remove、pause、continue、reset、stepInstruction、stepInto/Over/Out、flash（仅授权时）、symbol search/resolve、variable read/write/verify、memory read/write/verify、Watch/Timeline 双向同步、record、RTT、diagnostics、完整 SSE lifecycle、stop。
- [ ] Legacy J-Link 只验收其声明支持的能力；native-only source step 必须明确返回 capability unavailable，不得启动第二 owner 模拟。
- [ ] 每个请求记录 instanceId/projectId/sessionId/generation、owner kind、target state、PC、elapsed、errorCode；报告中移除 token。
- [ ] 并发压力：Watch + Timeline + recording + RTT 运行时执行 20 次变量写和 Into/Over/Out 各 20 次，确认无永久停止、无 stale sample、无第二 owner。
- [ ] 性能门禁统一执行 100 次 warm-up + 1,000 次测量；记录 CPU/OS/Node/VS Code 版本。RPC parse/dispatch 以 handler 调用前后为边界，单连接串行 1 KiB payload，p95 不超过 20 ms；DAP custom event 被 Extension Host 接收到 SSE write 完成为边界，100 次事件 p95 不超过 100 ms；API control overhead 以 Extension Host dispatch 到 customRequest resolve 之外的时间计算，100 次 p95 不超过 50 ms。CI 只记录趋势，发布硬门禁在指定验收机器连续两轮均通过，允许每轮 5% 抖动。
- [ ] evidence 必须记录目标 owner 最大并发数为 1，并证明 API/DAP/helper 进程树中没有第二 owner。
- [ ] 断开后确认 extension/DAP/helper 生命周期正确，目标 owner 数为 0，endpoint 被移除或 health 失败。
- [ ] 更新架构图、用户文档、API quick start、迁移说明和已知限制。
- [ ] 只有自动化、Mock 和获得授权的真实硬件层分别通过后，才标记相应验收状态；不得把缺失层写成通过。
- [ ] Run full release gate: `npm run typecheck`, `npm run build`, `npm run build:native`, `npm test`, `npm run test:cpp-channel:mock`, `npm run test:cmsis-dap:mock`, contract/client/integration validators。
- [ ] Commit: `docs: publish Orbit Automation API acceptance and usage`。

---

## 5. 任务依赖与并行规则

```text
Task 0 -> 1 -> 2 -> 3 -> 4 -> 5
                         |    |
                         |    +-> 6 (breakpoints)
                         |    +-> 7 -> 8 (runtime/expression)
                         |    +-> 9 (memory)
                         |              |
                         +--------------+-> 10 (sampling/recording)
                                         -> 11 (events/RTT)
Tasks 1-11 -> 12 -> 13 -> 14 -> 15 -> 16
```

- Tasks 6、7、9 在 Task 5 合并后可以并行，但必须使用独立 worktree；它们都修改 `dap-session.ts`，合并时必须逐项重放测试，不能机械接受冲突。
- Task 8 依赖 Task 7；Task 10 依赖 Task 8 和当前 Timeline 冲突已由用户解决。
- Task 11 必须最后整合所有事件生产者。
- Task 12 之前不得宣布 API v1 transport 稳定；Task 15 之前不得宣布多窗口可用；Task 16 之前不得宣布真实硬件通过。

每个 AI worker 的输入至少包含：本计划、对应 Task、Global Constraints、前置 Task 的公开 interfaces、当前 `git status --short` 和相关 CodeGraph context。不要把整个计划替换成一句“实现 Task N”。

---

## 6. 分层验收流程

### Gate A: 合同与静态检查

- OpenRPC 中每个公开 method 都有 params/result/error schema。
- method catalog、dispatcher registry、Node/Python/PowerShell/MCP method 名完全一致。
- schema 禁止额外未知 mutation 字段；所有地址/精确整数规则一致。
- `npm run typecheck`、`npm run build`、`git diff --check` 通过。

### Gate B: 单元与协议测试

- 每个 service 有成功、权限拒绝、invalid input、timeout、stale generation、dispose 路径。
- JSON-RPC id、幂等 key、error mapping、body limit、SSE replay 有独立测试。
- RuntimeRouter no-fallback 有 spy 证明 DAP 失败后 extension backend 调用次数为 0。

### Gate C: DAP 与 Mock owner

- 标准 DAP UI 请求和 Automation 请求走同一 control/read implementation。
- J-Link mock 与 CMSIS-DAP mock 按 public method × owner capability matrix 覆盖 session/control/breakpoint/runtime/expression/symbol/memory/view/record/RTT/diagnostics/events；不支持项必须返回声明的 capability error。
- 任何失败路径都不创建第二 owner，不泄漏 helper，不遗留临时断点。

### Gate D: 双 VS Code 窗口集成

- 不同项目、相同项目两个场景都通过发现和歧义拒绝测试。
- API 操作在 VS Code UI 可见；UI 操作在 API snapshot/SSE 可见。
- UI 可见性必须有 Debug toolbar、Call Stack session 和 breakpoint gutter 的 integration evidence，不能只用 DAP event 代替。
- session replacement 后旧 generation 永不作用于新 session。

### Gate E: 客户端互操作

- Node、Python、PowerShell 对同一 fake/live instance 产生等价 JSON 请求。
- MCP 只使用同一 Node client/API，不存在旁路。
- CLI 在多个实例时必须报错并展示候选列表。

### Gate F: 真实硬件

- 分别记录 J-Link native、J-Link legacy capability subset、CMSIS-DAP。
- 读、写、控制、断点、录波、RTT 分开报告。
- 未获得授权或未执行的层标记为“未验证”，不能合并成“全部通过”。

---

## 7. Definition of Done

只有同时满足以下条件，最终目标才完成：

- 两个或更多 VS Code 窗口能同时注册，客户端能按 projectId/instanceId 无歧义握手。
- API 启动、停止和控制的是真实可见 VS Code Orbit session。
- API 与 VS Code 共用同一断点集合，双向修改和 DAP verified 状态一致。
- Session、target、breakpoint、runtime、expression、symbol、memory、Watch、Timeline、recording、experiment、RTT、diagnostics 和 events API 全部进入公开 catalog。
- 所有 target 请求绑定精确 session identity/generation；旧请求无法操作新会话。
- 活动 DAP 请求失败时没有 extension-host fallback，没有第二 target owner。
- Node、Python、PowerShell、CLI 和 MCP 均通过同一 `/v1/rpc` 与 `/v1/events` 协议。
- OpenRPC、事件 schema、用户文档、迁移文档和完整验收证据已发布。
- 自动化、Mock、双窗口集成全部通过；真实硬件结果按实际授权和执行情况如实报告。

## 8. 回退策略

- v1 功能以 `orbit.automation.enabled` 配置开关控制；关闭后不启动 endpoint/server，也不影响标准 VS Code 调试。
- 一个发布周期保留旧 `/rpc` 和旧 MCP tool 名；兼容层只调用新 service，不保留旧旁路实现。
- 新 DAP automation request 失败不得影响标准 DAP request；可单独关闭 Automation API 而不回退 target owner。
- 若 recording 合并导致采样退化，可暂时禁用 API recording consumer，但不得禁用 Watch/Timeline；保留读取/控制 API。
- 任何 owner、breakpoint 或 session identity 回归都阻止发布，而不是通过选择 legacy/另一个窗口掩盖问题。
