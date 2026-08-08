# RTT 受限机会式后台轮询实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** Timeline 高频采样期间保持 RTT 日志轮询，并继续由 `orbit.rttPollIntervalMs` 控制完成后最小等待间隔。

**架构：** DAP 不再把 Timeline 启停映射为 RTT 生命周期启停；RTT poll loop 始终只提交一个 `background` 读取，并在该轮完成后按配置间隔安排下一轮。J-Link helper channel 将 RTT 生命周期操作恢复为 `control`，读取保持 `background`。

**技术栈：** TypeScript、Vitest、DAP custom request、现有 `NativeScheduler`。

## 全局约束

- 保持单一 `SessionTargetSelector` owner，不新增 DLL、helper 或 fallback 路径。
- 保持 `control > watch > timeline > background`。
- 不修改 `dist/`，不执行真实硬件命令，不写 `docs/bug-fix-log.md`。
- 保留工作区现有用户改动；源码文件不提交，避免把用户改动混入提交。
- RTT 间隔是完成后最小等待时间，不使用固定墙钟节拍，不追赶漏掉的轮询。

---

### 任务 1：锁定 RTT 与 Timeline 共存行为

**文件：**
- 修改：`src/debug/dap-session-rtt.test.ts`
- 修改：`src/debug/dap-session.ts:1003-1062,2426-2499`

**接口：**
- 使用：`DapSession.startRttLogPolling()`、`handleDataSamplingStart()`、`handleDataSamplingStop()`。
- 保持：`rttPollIntervalMs`、`AbortSignal`、generation fence 和结构化 RTT 错误日志。

- [ ] **步骤 1：添加失败的 Timeline 共存测试**

在 `src/debug/dap-session-rtt.test.ts` 中增加一个 fake-timer 用例：启动 RTT 并完成首轮读取，调用 `handleDataSamplingStart()` 后断言没有 `stopRtt`；Timeline 活动期间推进 `rttPollIntervalMs` 后断言继续出现 `readRtt`；调用 `handleDataSamplingStop()` 后断言没有额外 `startRtt` 或 `stopRtt`。

- [ ] **步骤 2：添加完成后间隔特征测试**

使用 deferred `readRtt`：首轮读取未完成时推进多个间隔，断言仍只有一个读取；完成首轮后推进 `interval - 1` 仍无第二次读取，再推进 `1 ms` 才出现第二次读取。

- [ ] **步骤 3：运行测试并确认 RED**

运行：

```powershell
npx vitest run src/debug/dap-session-rtt.test.ts
```

预期：Timeline 共存用例失败，原因是当前 `handleDataSamplingStart()` 调用了 `stopRttLogPolling()`，且 poll loop 在 `dataSamplingActive` 时退出；现有 RTT 生命周期用例保持通过。

- [ ] **步骤 4：实现最小 DAP 修改**

在 `startRttLogPolling()` 的 poll guard 中移除 `this.dataSamplingActive`：

```typescript
if (this.rttPollTimer === null || generation !== this.rttPollGeneration || signal.aborted) return;
```

从 `handleDataSamplingStart()` 删除 `this.stopRttLogPolling()`，从 `handleDataSamplingStop()` 删除 `this.startRttLogPolling()` 条件块。保留真正会话停止路径中的 `stopRttLogPolling()`。

- [ ] **步骤 5：运行聚焦测试并确认 GREEN**

运行：

```powershell
npx vitest run src/debug/dap-session-rtt.test.ts src/debug/dap-session-realtime-variables.test.ts src/debug/dap-session-target-read-gate.test.ts
```

预期：全部通过，RTT 与 Timeline 共存且已有 stale-completion fence 不回归。

### 任务 2：修正 J-Link RTT 生命周期优先级

**文件：**
- 修改：`src/ozone-backend/cpp-jlink-channel.test.ts`
- 修改：`src/ozone-backend/cpp-jlink-channel.ts:500-527`

**接口：**
- 使用：`ExperimentalCppJLinkChannel.startRtt()`、`stopRtt()`、`readRtt()`。
- 保持：`readRtt` 的 `{ priority: 'background', coalesceKey: 'rtt-read' }`。

- [ ] **步骤 1：添加失败的优先级路由测试**

对 `CppJLinkHelperClient.prototype.controlRequest` 和 `request` 建立 spy，将测试 channel 标记为已连接。调用 `startRtt`、`stopRtt`、`readRtt`，断言 start/stop 经过 `controlRequest`，read 经过带 `background` 和 `rtt-read` 的 `request`。

- [ ] **步骤 2：运行测试并确认 RED**

运行：

```powershell
npx vitest run src/ozone-backend/cpp-jlink-channel.test.ts
```

预期：start/stop 的 `controlRequest` 断言失败，因为当前映射把三个 RTT 方法都设为 `background`。

- [ ] **步骤 3：实现最小优先级修改**

将 `priorityForMethod()` 调整为：

```typescript
case 'startRtt':
case 'stopRtt':
  return 'control';
case 'readRtt':
  return 'background';
```

- [ ] **步骤 4：运行聚焦测试并确认 GREEN**

运行：

```powershell
npx vitest run src/ozone-backend/cpp-jlink-channel.test.ts src/ozone-backend/native-scheduler.test.ts
```

预期：全部通过，生命周期控制与后台读取优先级符合合同。

### 任务 3：分层验证与审查

**文件：**
- 审查：`src/debug/dap-session.ts`
- 审查：`src/ozone-backend/cpp-jlink-channel.ts`
- 不修改：`docs/bug-fix-log.md`

**接口：**
- 验证：owner 路由、generation/abort fence、Timeline 优先级、配置间隔语义。
- 输出：自动化验证结果与真实硬件验收缺口。

- [ ] **步骤 1：运行类型检查和构建**

```powershell
npm run typecheck
npm run build
```

- [ ] **步骤 2：运行完整测试**

```powershell
npm test
```

- [ ] **步骤 3：检查差异**

```powershell
git diff --check
git diff -- src/debug/dap-session.ts src/debug/dap-session-rtt.test.ts src/ozone-backend/cpp-jlink-channel.ts src/ozone-backend/cpp-jlink-channel.test.ts
```

确认只包含受限机会式轮询、优先级映射及对应回归测试；不覆盖用户的其他修改。

- [ ] **步骤 4：报告验证边界**

明确区分聚焦 Vitest、完整自动化、构建和真实硬件。没有授权的 RTT+Timeline 真机运行不得称为硬件通过。
