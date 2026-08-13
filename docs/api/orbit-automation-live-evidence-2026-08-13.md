# Orbit Automation API Task 2 — Live Dual-Instance Verification Evidence

> 状态：**真实环境实测（非 Mock）**。所有请求仅访问 `127.0.0.1`，全程未接触任何目标硬件；硬件路径（session/target/断点/内存等）属于 Task 4–11，本证据不含硬件结论。

- 日期：2026-08-13（北京时间 21:54–22:25）
- 基线：commit `91141a8` `feat(api): add multi-instance discovery and project handshake`
- 被测窗口：VS Code Stable（测试期间完成一次自动更新并重启）
- 工作区：`d:\STM32\project\vet6_led`（STM32F103VET6 项目，未连接硬件）
- 构建：`npm run build` 产物 `dist/extension.js`（开发主机加载）

---

## Phase 1 — 单活实例 API 冒烟（端口 53334）

| 检查项 | 结果 |
|---|---|
| `GET /health` | ✅ `{"ok":true,"status":"ok","instanceId":...,"projectId":...,"apiVersion":"1.0","uptimeMs":266664,"pid":16976}`；**无 token 字段** |
| `orbit.instance.describe` | ✅ 完整 `InstanceDescription`（version/channel/processId/startedAt/workspaceFolders/endpoint）+ 固定 envelope（requestId/instanceId/projectId） |
| `orbit.project.describe` | ✅ 1 个工作区目录、ELF `build\Debug\vet6_led.elf`、4 个 launch 配置（J-Link/DAPLink × Flash/NoFlash）、`registryGeneration: 0` |
| `orbit.system.capabilities` (`includeUnavailable=false`) | ✅ 仅返回可用项：`discovery`、`handshake`、`rpc.v1` |
| `orbit.handshake` | ✅ 请求 `[read, session.control, flash, memory.write, view.write]` → granted 仅 `['read']`（默认 `allowedScopes` 生效）；`expiresAt` 为字符串 |
| `orbit.connection.close` | ✅ `closed: true, releasedSubscriptions: 0` |
| 重复 close | ✅ `ConnectionExpired` (-32008) |
| 错误 projectId | ✅ `ProjectMismatch` (-32005) |
| 未知方法 | ✅ `MethodNotFound` (-32601) |
| `orbit.session.list`（Task 4 未实现） | ✅ `MethodNotFound`（符合阶段预期） |
| 错误 Bearer token | ✅ HTTP 401 |

## Phase 1b — 扩展宿主重启行为（真实环境观察）

再次执行 `code --extensionDevelopmentPath` 触发 Extension Host 重启：

- 旧 endpoint 文件（`095940e8-...json`）被 `dispose()` **干净删除**；
- 新 Extension Host 原子重建 endpoint（`8de7955f-...`，端口 50646）。

结论：dispose/start 生命周期在真实环境验证通过。

## Phase 2 — 双独立实例、同一 projectId

环境处理：同一 VS Code 实例的多个窗口共享一个 Extension Host（只有一个 API endpoint）；双实例需要独立 user-data-dir。第二实例使用 `--user-data-dir=<temp>` 并通过 `ORBIT_AUTOMATION_REGISTRY` 环境变量指向独立 registry 文件。

| 实例 | instanceId | 端口 | projectId |
|---|---|---|---|
| 主实例（dev 窗口） | `93e57011-88e3-446a-a017-9695fdc23e13` | 56619 | `sha256:13e29ccf746a96e264bc984a34a47b20dbab032c49ae589b459a03682a01b5c8` |
| 第二实例（隔离 profile） | `579efae1-5959-444a-aa5c-406bb94017db` | 52017 | `sha256:13e29ccf746a96e264bc984a34a47b20dbab032c49ae589b459a03682a01b5c8` |

- ✅ 同一 projectId、不同 instanceId、不同端口；
- ✅ 两个实例 `/health` 均 ok；
- ✅ `ORBIT_AUTOMATION_REGISTRY` 覆盖生效：第二实例的 registry entry 写入自己的 pointer 文件，主实例 pointer 不受影响；
- ✅ 客户端枚举（两个 registry 的 endpointDirectory）：同 projectId 匹配 2 个活 endpoint → **歧义规则触发（必须显式 instanceId，不得选择最近窗口）**；
- ✅ 显式 instanceId 握手两个实例均成功（各自返回独立 `connectionId`、granted `read`）；
- ✅ 用实例 1 的 instanceId 握手实例 2 → `InstanceMismatch`。

## Phase 3 — 崩溃残留与启动清理

1. 强杀第二实例整个进程树：
   - ✅ endpoint 文件残留（heartbeat 停止更新）；
   - ✅ 端口 52017 `/health` 连接失败；
   - ✅ 其 globalStorage 内 legacy pointer 仍标记 `unique`（**过期指针**——客户端必须 `/health` 校验，符合 §2.1）。
2. heartbeat 过期 33 秒后重启第二实例：
   - ✅ 启动清理删除残留文件 `579efae1-...json`（health 失败 + heartbeat > 30 s 规则）；
   - ✅ 写入全新身份 `6dc33fd1-c498-435c-954c-e84c0d34799d`、端口 49711。
3. 主实例全程健康：`93e57011`（端口 56619）heartbeat 持续刷新，legacy pointer `unique`。

## 环境事件记录

- 测试期间 VS Code 自动更新进程（`CodeSetup-stable`）持有 `vscode-updating` 互斥锁，阻塞第二实例启动约 15 分钟；用户点击更新完成后 VS Code 自动重启。
- 更新重启后主窗口短暂回落到**已安装旧版扩展**（旧格式 `plugin-api-endpoint.json`：`{host,port,token,url,updatedAt}`，端口 57511）——新旧版本共享 legacy pointer 文件、后写者覆盖，属计划中"一个兼容周期"的预期共存现象；重新启动 dev 窗口后恢复 v1 endpoint。
- 本证据中的 Bearer token 已隐去（`<redacted>`），响应实例 id 保留以便追溯。

## 与本证据对应的自动化覆盖

- `src/plugin-api/instance-registry.test.ts`（28 用例）：projectId 归一化、原子写入、心跳、pointer upsert、reparse 拒绝、stale 清理、legacy unique/ambiguous；
- `src/plugin-api/handshake-service.test.ts`（14 用例）：scope 交集、fence、租约过期/续租、连接上限；
- 验收矩阵 `API-001/002/017/018`（Automated）。
