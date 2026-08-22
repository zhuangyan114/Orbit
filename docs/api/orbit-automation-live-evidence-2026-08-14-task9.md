# Orbit Automation API — Task 9 字节内存读写实机验证证据（2026-08-14）

> 通过 v1 Automation API 驱动真实、可见的 VS Code 调试会话完成
> `orbit.memory.read` / `orbit.memory.write` 全量验证，重点覆盖**运行态**
> 读写（backend 内部 halt→读写→resume 与 MemoryView 一致）。写操作经用户明确授权，
> 对专用 RAM 测试全局 `g_ram_data` 执行「读原值→写差值→读回校验→恢复原值」。

## 环境

| 项 | 值 |
|---|---|
| 目标 | STM32F407VET6 |
| 探针 | J-Link（`JLink_V956`） |
| 工程 | `d:\STM32\project\vet6_led` |
| ELF | `build\Debug\vet6_led.elf` |
| endpoint instanceId | `321b0920-d9c6-4c05-a5e0-42faa3dda8a1`（reload 后） |
| session | 由 `orbit.session.start`（`Orbit: J-Link (No Flash)`）拉起 |
| allowedScopes | `["read","session.control","breakpoints.write","variables.write","memory.write"]` |

## 验证流程与结果（18/18 PASS）

| 步骤 | 结果 |
|---|---|
| `orbit.handshake`（read + session.control + memory.write） | 授予全部三个 scope |
| `orbit.session.start`（No Flash） | accepted |
| `orbit.symbol.search("g_ram_data")` | `variable` @ `0x20000010`，size `4` |
| `orbit.memory.read` RAM（4 字节） | `bytesRead:4`，base64 `paVaWg==` = `0x5A5AA5A5` |
| `orbit.memory.read` Flash（`main` @ `0x0800476C`，8 字节） | `bytesRead:8`，base64 非空 |
| `orbit.target.continue` | `state:"running"` |
| **运行态 `orbit.memory.read`** | `0x5A5AA5A5` ✅（halt→read→resume） |
| **运行态 `orbit.memory.write`（verify:true）** | `bytesWritten:4, verified:true`，写 `0xA5A55A5A` |
| 运行态读回确认 | `0xA5A55A5A` ✅（与写入一致，非原地重写） |
| **运行态 `orbit.memory.write` 恢复（verify:true）** | `bytesWritten:4, verified:true`，写回 `0x5A5AA5A5` |
| 运行态读回确认 | `0x5A5AA5A5` ✅ |
| **运行态 hold 20s（每 2s 一次运行态读 ×10）** | 10 次全稳定 `0x5A5AA5A5`，无假停止 ✅ |
| `orbit.target.pause` | `state:"halted"`，pc `0x0800523A` |
| halted `orbit.memory.read` 确认 | `0x5A5AA5A5` ✅ |
| 负向：`memory.read` 地址 `0x1FFFFFFFF` | `InvalidAddress`（>32 位被 service 拒绝） |
| 负向：`memory.write` data `"!!!!"` | `InvalidRequest`（非规范 base64 被 service 拒绝） |

写入差值取 `original ^ 0xFFFFFFFF`，保证每次运行都真实改变 RAM 值（避免上轮残留
值使写退化为 no-op），`verifyData` 读回字节与写入逐字节一致才判 `verified:true`。

## 验证过程中发现并修复的两个缺陷（`b7cd250`）

1. **DAP `success:false` 错误码丢失 → 误报 `TargetDisconnected`**：VS Code 的
   `customRequest` 对 `success:false` 只 reject `Error(message)`，**不附 `.body`**，
   导致 memory service 读不到结构化 `errorCode`，把 `TargetReadCancelled` 等误映射为
   `TargetDisconnected`。修复：`memory-service.ts` 增加 `memoryFailureFromRejection`
   —— 优先读 `.body.errorCode`，否则从消息前缀 `ErrorCode:` 恢复，二者皆无才 rethrow。

2. **运行态内存访问触发 spurious `stopped` → UI 状态失同步**：运行态下 backend
   内存读写内部 halt→读写→resume，而 `continue` 起的 200ms 轮询把这个**内部短暂 halt**
   误判成真停止，发出假 `stopped` 事件（工具栏翻成「暂停」）+ `lowPriorityReadBlockedUntil`
   封锁 + 停轮询（Timeline 停摆）。修复：`dap-session.ts` 在 automation 内存读/写期间
   `stopPolling()`，结束后按原 `targetRunning` 状态 `startPolling()` 恢复。用户实机观察
   确认工具栏保持「运行中」、Watch 持续刷新、Timeline 正常推进，修复到位。

## 观察（非缺陷）

1. **SessionRegistry 将新启动会话标为 `starting` 直到首次 automation control**：`session.start`
   返回后 registry 相位停在 `starting`（DAP adapter 实际已 `connected`，读/写/符号查询均可用），
   直到第一次 `continue`/`pause` 才经 `AUTOMATION_CONTROL_EVENT` 更新为 `running`/`halted`。
   这是 registry 标签粒度问题，不影响任何 target 操作，`requireExact` 接受 `starting` 相位。

2. **No Flash 启动不复位 RAM**：`Orbit: J-Link (No Flash)` 连接不 reset，`g_ram_data`
   跨 session 保持上轮残留值（固件初始化器只在真实 reset/flash 时生效）。脚本按动态原值
   恢复，不破坏现场；这也是选择 No Flash 以「保留现有固件」的预期行为。

## 已知限制（沿用 Task 8 的记录口径，暂不修复）

1. **[L·继承] MemoryView 手动运行态读写仍可触发同一 spurious stopped**：本次修复只加在
   automation 内存路径；VS Code MemoryView 手动的 `readMemory`/`writeMemory` 走共享 handler
   （无 `stopPolling` 保护），运行态读写理论上仍会假停止。plan 要求 automation 与 MemoryView
   行为一致，故未改动共享 handler。若用户在手动 MemoryView 复现，再评估是否下沉到共享 handler。
2. **[L] `allowPartial` 被接受但 backend 全量读**：当前 `readMemoryChunked` 任一分块失败即
   整体 `ok:false`，不会产生 partial 读；`allowPartial:false` 因此永不触发，`unreadableBytes`
   成功路径恒为 0。字段按冻结契约透传，语义未变。
3. **[L] 无 `MemoryVerifyFailed` 错误码**：冻结契约不含该码，verify 不匹配按
   `MemoryWriteReport.verified:false` + `verifyData`（读回字节）返回，写本身已成功，客户端
   可比对 `data`/`verifyData` 感知偏差；verify 读回失败则映射 `MemoryWriteFailed`。

> 安全边界完好：`memory.write` 的 `memory.write` scope、`idempotencyKey`、session
> generation fence 均强制生效；地址为冻结 `0x` hex 且 service 强校验 32 位；内存数据
> 全走 base64，无 `uint32[]`/JSON number 精度泄漏面。

## 提交

- `99291f1` feat(api): add byte-oriented memory access
- `b7cd250` fix(api): map DAP memory failures and pause polling during running-state memory access
- `73cb12a` test(api): add Task 9 memory hardware verification
- `ffb7834` test(api): add running-state hold phase to Task 9 memory verification

## 脚本

- `scripts/automation-api/verify-memory.js` — handshake（含 memory.write）→ 无 session 时
  `session.start`（No Flash）→ symbol 定位 → halted/RAM/Flash 读 → continue → 运行态
  读/写(verify)/读回/恢复 → `ORBIT_HOLD_MS`（默认 10s）运行态 hold + 周期读 → pause →
  负向用例（InvalidAddress / InvalidRequest）
