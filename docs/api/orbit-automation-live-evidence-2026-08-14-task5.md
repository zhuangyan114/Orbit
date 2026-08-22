# Orbit Automation API Task 5 — Real-Hardware Control Sequence Evidence

> 状态：**真实硬件实测（非 Mock）**。J-Link 实机烧录（用户已授权）、真实可见调试会话、全部通过 `orbit.target.continue` / `orbit.target.pause` 经 DAP session 驱动（无任何键盘/鼠标自动化）。所有请求仅访问 `127.0.0.1`。

- 日期：2026-08-14（北京时间 00:16–00:19，用户肉眼确认轮）
- 基线：commit `44a7743`（`feat(api): route automation control through the active DAP session`，Task 5 已构建入 `dist/extension.js` 与 `dist/debugadapter.js`）
- 被测窗口：用户 VS Code Stable（Extension Host pid 27812，窗口重载后加载新 bundle）
- 实例：`f6b00fe4-e33e-47af-9b64-2796aba93d79`，端口 65423
- 工作区：`d:\STM32\project\vet6_led`，projectId `sha256:13e29ccf…`
- 硬件：SEGGER J-Link（VID_1366&PID_0101，序列号 000020090928，`JLink_V956`）；目标 STM32F407VET6
- 配置：`Orbit: J-Link (Flash)`（flashBeforeDebug=true，烧录）/ `Orbit: J-Link (No Flash)`
- 驱动脚本：`scripts/automation-api/verify-control-sequence.js`（本次提交；动作间隔 `--step-ms 1000`）
- 证据 JSON：`outputs/task5-control-sequence-evidence.json`（outputs/ 不入库，内容摘录于下）

---

## 用户肉眼确认（2026-08-14 00:19）

用户原话确认第 2 轮观察结果与脚本记录一致：VS Code 调试工具栏在 run（播放）与 pause（暂停）之间切换、两次退出调试，两组序列（烧录 / 不烧录）均可见。

## 序列 A — `Orbit: J-Link (Flash)`（烧录启动）

| 步骤 | API 调用 | 结果 |
|---|---|---|
| 启动 | `orbit.session.start` (registryGeneration=4) | ✅ `accepted:true`，`sessionGeneration=5`，session `0x6b231c98…` 可见启动（Debug toolbar + Call Stack） |
| 启动后 | legacy `getTargetState` 轮询 | ✅ `halted`（烧录完成，暂停在入口） |
| run-1 | `orbit.target.continue{threadId:1}` | ✅ `ControlOutcome{state:"running"}`；snapshot `phase/targetState=running` 同步 |
| （1 s） | `orbit.target.pause{threadId:1}` | ✅ `ControlOutcome{state:"halted", pc:"0x800530a", stopReason:"pause"}`；snapshot 同步 |
| run-2 | `orbit.target.continue{threadId:1}` | ✅ `state:"running"`；snapshot 同步 |
| 退出 | `orbit.session.stop`（精确 ref） | ✅ `accepted:true`，会话进入 `terminated` 历史，registryGeneration 6 |

## 序列 B — `Orbit: J-Link (No Flash)`（不烧录启动）

| 步骤 | API 调用 | 结果 |
|---|---|---|
| 启动 | `orbit.session.start` (registryGeneration=6) | ✅ `accepted:true`，`sessionGeneration=7`（不烧录：日志 `flash skipped reason=flashBeforeDebug=false`） |
| 启动后 | legacy `getTargetState` 轮询 | ✅ `halted` |
| run-1 | `orbit.target.continue` | ✅ `state:"running"` |
| （1 s） | `orbit.target.pause` | ✅ `state:"halted", pc:"0x8003542", stopReason:"pause"` |
| run-2 | `orbit.target.continue` | ✅ `state:"running"` |
| 退出 | `orbit.session.stop` | ✅ accepted；registryGeneration 8 |

## Generation fence 全程单调

`registryGeneration`：4（基线）→ 5（start）→ 6（stop）→ 7（start）→ 8（stop）。每个 lifecycle transition 恰好 +1，与 §2.3 冻结规则一致。

## DAP 侧证据（outputs/Log/dap.log 摘要）

控制请求由 Extension Host 经 `customRequest('orbitAutomationControl', …)` 路由到 DAP 适配器，适配器复用标准 `continue`/`pause` handler 核心并发出标准事件（UI 同步）与脱敏 custom event：

```text
handleContinue: pc=0x8005308
handleContinue: clear bp result ok=true
handleContinue: re-set bp after step
handleContinue: run result ok=true
[protocol] event seq=N event=continued threadId=1 allThreadsContinued=true
handlePause: halt ok
[protocol] event seq=N event=stopped reason=pause threadId=1
```

## 已知限制（本轮未覆盖，按计划后置）

- `orbit.target.reset` / `orbit.target.step*` / `orbit.target.flash` / `orbit.session.restart` 仅完成 Mock 验证（`dap-session-automation.test.ts` 19 用例 + runtime-router 5 用例 + 全量 563 用例通过），未经硬件授权本轮未实机执行。
- `orbit.target.flash` 的 `verify` 参数为建议值：J-Link.exe 与 CMSIS-DAP 算法均由 owner 按其能力校验，`FlashReport.verified` 报告实际发生的情况。
