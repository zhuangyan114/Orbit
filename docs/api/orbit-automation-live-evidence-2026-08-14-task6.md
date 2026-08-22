# Orbit Automation API — Task 6 断点实机验证证据（2026-08-14）

> 通过 v1 Automation API 驱动真实、可见的 VS Code 调试会话完成断点
> 读取/删除/运行/命中验证。本次验证经用户明确授权，执行了真实目标变更
> （Flash、halt/run、硬件断点编程）。

## 环境

| 项 | 值 |
|---|---|
| 目标 | STM32F407VET6 |
| 探针 | J-Link（`JLink_V956`，VID_1366&PID_0101 serial 000020090928） |
| 工程 | `d:\STM32\project\vet6_led` |
| ELF | `build\Debug\vet6_led.elf` |
| 源文件 | `Core\Src\freertos.c` → `StartTask02` 循环体（399–419 行） |
| endpoint instanceId | `5cb60836-a5c9-47b2-a918-c45df36e4fd9` |

## 验证流程与结果

| 步骤 | 结果 |
|---|---|
| `orbit.session.start`（Orbit: J-Link (Flash)） | accepted，sessionGeneration 1，入口 halt |
| `orbit.breakpoints.add`（freertos.c:402） | 断点进入 `vscode.debug.breakpoints` 并被 DAP 验证（slot 0）。**注**：`add` RPC 因 column 归一化 bug 返回 `InternalError`（见下），但断点实际已落盘并验证 |
| 用户手动在 `P_LOG` 行（freertos.c:412）加断点 | 验证通过（slot 1） |
| `orbit.breakpoints.list` | 两断点均 `verified=true`，slot 0/1，带 `sessionId`/`sessionGeneration` |
| `orbit.breakpoints.remove`（line 402） | 精确移除，返回被删快照 |
| `orbit.breakpoints.list`（删后） | 仅剩 line 412 |
| `orbit.target.continue` | `running` |
| 命中 line 412 | target halted，耗时 1010 ms（≈1000ms 日志节流） |
| `orbit.target.pause` 读回 PC | `0x8004e9c` |
| `addr2line` 反查 | `StartTask02` @ `freertos.c:412 (discriminator 3)` |

命中耗时 1010 ms 与 `if(HAL_GetTick() - last_log_tick >= 1000U)` 的节流一致，
且 PC 反查精确落在 412 行 `P_LOG(...)`，证明命中的是日志断点而非 402 行的
高频循环体（后者应 <1ms 命中）。

## 发现的缺陷与修复

### 1. `orbit.breakpoints.add` 的 column 往返不一致（已修复）

`buildLocation` 对未指定 column 的输入把起始字符设为 0，读回后变为
column 1；而 `add` 用「输入侧（无 column）」计算 id、用「读回侧（column 1）」
匹配，导致 id 不一致 → `add` 在断点已成功添加并验证后仍抛 `InternalError`。

修复：`src/plugin-api/breakpoint-service.ts` 增加 `canonicalColumn()`，把
「未指定」与「首列 column 1」归一到同一 id；`readRequestedBreakpoints` 与
`breakpointIdForInput` 两侧一致使用。回归测试
`src/plugin-api/breakpoint-service.test.ts` 的 seam 改为镜像真实 VS Code 的
`character=0` 行为，并新增 add→list id 一致性用例。

### 2. remove 后瞬时 `verified=false`（非缺陷）

`breakpoints.remove` 后立即 `list` 时，剩余断点短暂显示 `verified=false`
（VS Code 正在向 DAP 重同步该 source 的断点集合）。随后继续运行即正常命中，
证明只是异步重同步窗口，不是正确性缺陷。

## 提交

- `fix(api): canonicalize breakpoint column across add/list/remove`
- `test(api): add Task 6 breakpoint hardware verification scripts`

## 脚本

- `scripts/automation-api/verify-breakpoints.js` — 完整 add→list→run→hit→remove 流程
- `scripts/automation-api/verify-breakpoints-hit.js` — 读取/删除/命中跟进验证
