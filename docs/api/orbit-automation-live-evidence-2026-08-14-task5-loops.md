# Orbit Automation API Task 5 — Real-Hardware Pause/Run Loop Evidence

> 状态：**真实硬件实测（非 Mock）**。J-Link 实机烧录（用户已授权）、真实可见调试会话、4 轮 `orbit.target.continue`/`orbit.target.pause` 循环全部经 DAP session 驱动（无任何键盘/鼠标自动化）。所有请求仅访问 `127.0.0.1`。

- 日期：2026-08-14（北京时间 00:30–00:31，用户肉眼确认轮）
- 基线：commit `09137fe`（`fix(api): harden automation control robustness`，含 L1–L6 修复，已构建入 `dist/`）
- 被测窗口：用户 VS Code Stable（Extension Host pid 30912，00:28:48 启动，晚于 dist 构建 00:28:44，加载最新 bundle）
- 实例：`c122fb7a-3456-4e3e-bf4d-a62120f37193`，端口见 endpoint
- 工作区：`d:\STM32\project\vet6_led`，projectId `sha256:13e29ccf…`
- 硬件：SEGGER J-Link（VID_1366&PID_0101，序列号 000020090928，`JLink_V956`）；目标 STM32F407VET6
- 配置：`Orbit: J-Link (Flash)`（flashBeforeDebug=true，烧录）
- 驱动脚本：`scripts/automation-api/verify-control-loops.js`（本次提交；`--cycles 4 --step-ms 1000`）
- 证据 JSON：`outputs/task5-control-loops-evidence.json`（outputs/ 不入库，内容摘录于下）

---

## 用户肉眼确认（2026-08-14 00:31）

用户确认 4 次运行↔暂停切换（Debug toolbar / Call Stack / LED）与最终退出调试，与脚本记录一致。

## 循环序列 — `Orbit: J-Link (Flash)`，4 × (run → pause)

| 循环 | run（`orbit.target.continue`） | pause（`orbit.target.pause`） | snapshot 同步 |
|---|---|---|---|
| 1 | ✅ `state:running` | ✅ `state:halted` `pc:0x8005234` `stopReason:pause` | ✅ phase/targetState=halted，pc 一致 |
| 2 | ✅ `running` | ✅ `halted` `pc:0x80075c2` `pause` | ✅ |
| 3 | ✅ `running` | ✅ `halted` `pc:0x8006008` `pause` | ✅ |
| 4 | ✅ `running` | ✅ `halted` `pc:0x80063c8` `pause` | ✅ |

- 4 次暂停 PC 均不同，证明目标在每轮 run 后真实运行、再次被暂停（非同一断点位置回放）。
- `orbit.session.stop` 精确 ref → `accepted:true`，会话进入 `terminated` 历史。
- `registryGeneration`：0 → 1（start）→ 2（stop），每个 lifecycle transition 恰好 +1。

## L1 修复的实机印证

`run` 的 ControlOutcome session 快照仅含 `{phase:"running", targetState:"running"}`，**不再残留上一轮 pause 的 stopReason/pc**（对比修复前 `run-2` 快照会带 `stopReason:"pause", pc:…`）。运行态清空陈旧 halt 元数据生效。

## 已知限制（本轮未覆盖）

- `orbit.target.reset` / `orbit.target.step*` / `orbit.target.flash` / `orbit.session.restart` 仍仅 Mock 验证（`verify:false` 仅在 CMSIS-DAP 路径有实机意义；J-Link 路径恒校验）。
