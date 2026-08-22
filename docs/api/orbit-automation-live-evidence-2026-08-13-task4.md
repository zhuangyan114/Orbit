# Orbit Automation API Task 3/4 — Real-Hardware Session Verification Evidence

> 状态：**真实硬件实测（非 Mock）**。J-Link 实机烧录（用户已授权）、真实可见调试会话、真实 generation fence。所有请求仅访问 `127.0.0.1`。

- 日期：2026-08-13（北京时间 23:33–23:42）
- 基线：commit `9ab1eb6`（Task 3/4 及 review 修复均已构建入 `dist/extension.js`）
- 被测窗口：用户 VS Code Stable（Extension Host pid 36188，23:25 启动，加载本分支构建）
- 实例：`f7c986e6-1983-4ab7-8702-2670d3e8a06f`，端口 57213
- 工作区：`d:\STM32\project\vet6_led`，projectId `sha256:13e29ccf…`
- 硬件：SEGGER J-Link（VID_1366&PID_0101，序列号 000020090928，`JLink_V956`）；目标 STM32F407VET6
- 配置：`Orbit: J-Link (Flash)`（flashBeforeDebug=true，烧录）/ `Orbit: J-Link (No Flash)`
- 驱动脚本：`scripts/automation-api/verify-session-hardware.js`（本次提交）
- 环境准备：工作区 settings.json 增加 `orbit.automation.allowedScopes: ["read","session.control"]`（字节级追加，原文件备份于 `%TEMP%\vet6_led-settings-backup-20260813-233230.json`）

---

## Phase 1 — 会话生命周期与 generation fence（API 全部 PASS）

| 检查项 | 结果 |
|---|---|
| `/health` | ✅ ok，无 token |
| `orbit.instance.describe` | ✅ version 1.1.0、1 个工作区目录、完整 envelope |
| `orbit.handshake`（请求 `read,session.control`） | ✅ granted `["read","session.control"]` |
| `orbit.project.describe` | ✅ `registryGeneration` 基线（本轮 12，此前各轮已单调累计） |
| `orbit.project.listLaunchConfigurations` | ✅ 4 个配置（J-Link/DAPLink × Flash/NoFlash） |
| `orbit.session.list`（基线） | ✅ `items: []` |
| `orbit.session.start("Orbit: J-Link (Flash)")` | ✅ `OperationAck{operationId, accepted:true, session}`；`sessionGeneration = registryGeneration + 1`（13 = 12+1） |
| **烧录后目标暂停** | ✅ legacy 通道（经 SessionRegistry fence）轮询 `getTargetState` → `halted` |
| 人工观察：暂停保持 8 s | ✅ 用户肉眼确认 VS Code 黄色暂停箭头 / Call Stack |
| **人工观察：F5 运行 → F6 暂停** | ✅ API 观测状态转换 `halted → running → halted`（`sawRun/sawPauseAgain: true`） |
| `orbit.session.snapshot` | ✅ 精确 sessionId + sessionGeneration=13 |
| 重复 start（陈旧 registryGeneration=12） | ✅ `InvalidRequest`，details `{expected:12, actual:13}` |
| 重复 start（当前 registryGeneration=13） | ✅ `SessionAlreadyActive` + 冻结 `current` snapshot；`registryGeneration` 不变（无 transition） |
| stop（sessionGeneration=0） | ✅ `InvalidParams`（冻结 schema ≥1，目标未受影响，仍 halted） |
| `orbit.session.stop`（精确 ref） | ✅ `accepted:true`；ack snapshot 已显示 `phase:"terminated"`、registryGeneration=14 |
| `session.list(includeTerminated:true)` | ✅ 历史保留（跨 4 轮验证共 8 条 terminated 记录，有界） |
| 已终止会话 `session.snapshot` | ✅ `NoActiveSession` |
| 第二轮 `session.start("Orbit: J-Link (No Flash)")` | ✅ generation 15；**无烧录**下目标仍 `halted`（日志 `flash skipped reason=flashBeforeDebug=false`） |
| stop（有效但陈旧的 sessionGeneration=2） | ✅ `SessionChanged` `{expected:2, actual:15}`，目标保持 halted 未被动 |
| `orbit.session.stop`（第二轮） | ✅ accepted；最终 registryGeneration=16 |
| `orbit.connection.close` | ✅ `closed:true` |

## Phase 2 — 硬件连接与烧录证据（日志摘录，outputs/Log）

烧录会话（15:41）关键行：

```text
[DLL] [cpp-jlink stderr] [JLinkHelper] JLINK_Open OK
[DLL] [cpp-jlink stderr] [JLinkHelper] JLINK_Connect OK
[DLL] target-owner session=target-1 selected mode=auto owner=jlink-native command=connect targetConnected=true
[DLL] [cpp-jlink stderr] [JLinkHelper] SW-DP health probe enabled result=0 id=0x2ba01477
[DAP] Launch: device=STM32F407VE rtos=FreeRTOS elf=D:\STM32\project\vet6_led/build/Debug/vet6_led.elf
[DAP] [protocol] event seq=12 event=stopped stopGeneration=1 reason=entry threadId=1 allThreadsStopped=false
[Step] doGetCallStack pc=0x80056c4 lr=null
[Step] stackTrace frame0 pc=0x80056c4 pcSource=sessionTarget/jlink-native source=D:/STM32/project/vet6_led/startup_stm32f407xx.s:61
[DAP] [rtt] control block address=0x20005330 source=elf-symbol
[DAP] [rtt] startRtt ok
[DAP] [rtt] readRtt ok bytes=6
```

判定：

- `SW-DP id=0x2ba01477` 为 Cortex-M4 调试端口标准 IDCODE——J-Link 通过原生 helper（`owner=jlink-native`）物理连接成功；
- 烧录配置（`flashBeforeDebug=true`）下无 `flash skipped` 行（对比 No-Flash 会话显式输出该行）——烧录路径真实执行；用户肉眼确认烧录过程；
- 烧录后 `stopped reason=entry`、PC=`0x80056c4`（startup_stm32f407xx.s:61）——复位后停在入口，与「烧录→复位→入口暂停」一致；
- RTT 控制块从 ELF 符号解析（0x20005330）并读到 **6 字节上行数据**——新固件已在运行。

## Phase 3 — 观察说明与已知边界

- 本轮 4 次验证会话在**同一 Extension Host** 内 registryGeneration 从 0 单调递增至 17，从未回退——§2.3 单调性实测通过；
- `SessionSnapshot.phase` 在 Task 5 接入 DAP 阶段事件前保持 `starting`、`targetState: unknown`（本轮预期行为，非缺陷）；目标真实状态经 legacy `getTargetState`（走同一 SessionRegistry fence）确认；
- `orbit.target.continue/pause` 属 Task 5，本轮 run/pause 由用户在 VS Code 中按 F5/F6 驱动，API 侧记录状态转换；
- 工作区 settings.json 中 `orbit.automation.allowedScopes` 为验收所需新增，保留未还原（如需还原可移除该行）；
- 原始证据机读文件：`outputs/task4-hardware-evidence.json`（gitignored，内容已摘录于本表）。

## 与本证据对应的自动化覆盖

- `src/plugin-api/session-registry.test.ts`（19 用例）：生命周期、replacement、owner-loss、restart、有界历史；
- `src/plugin-api/session-service.test.ts`（28 用例）：start/stop、fence、SessionAlreadyActive、超时、分页；
- `src/plugin-api/event-hub.test.ts`（12 用例）、`rpc-dispatcher.test.ts`（35 用例，含 registryGeneration 幂等冲突）；
- 验收矩阵 `API-003`（Session discovery and generation lifecycle）：实机验证通过。
