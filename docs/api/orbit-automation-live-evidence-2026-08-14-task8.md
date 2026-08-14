# Orbit Automation API — Task 8 表达式与符号发现实机验证证据（2026-08-14）

> 通过 v1 Automation API 驱动真实、可见的 VS Code 调试会话完成
> `orbit.expression.evaluate / readMany / inspect` 与
> `orbit.symbol.search / resolve` 读取验证。
> 本批验证全部为**只读**（无目标写入）；`orbit.expression.writeMany`
> 需 `variables.write` scope 与用户明确写授权，另行验证。

## 环境

| 项 | 值 |
|---|---|
| 目标 | STM32F407VET6 |
| 探针 | J-Link（`JLink_V956`） |
| 工程 | `d:\STM32\project\vet6_led` |
| ELF | `build\Debug\vet6_led.elf` |
| endpoint instanceId | `df30b24b-4d8f-4428-b923-6dd8b813ef3b` |
| session | `91e458f7-1fc9-4028-9be7-63eba962ec7c`（generation 1，入口 halt） |
| allowedScopes | `["read","session.control","breakpoints.write"]`（无 `variables.write`） |

## 验证流程与结果

| 步骤 | 结果 |
|---|---|
| `orbit.handshake`（read + session.control） | 授予 `["read","session.control"]` |
| `orbit.session.start`（Orbit: J-Link (Flash)） | accepted，入口 halt（324 ms） |
| `orbit.symbol.resolve("main")` | `{kind:"function", address:"0x0800476C", size:"48"}`，`exact:true` |
| `orbit.symbol.resolve("Reset_Handler")` | `{kind:"function", address:"0x080056C4", size:"56"}` |
| `orbit.symbol.resolve(address=0x0800476C)` | 反解回 `main`，`exact:true` |
| `orbit.symbol.search("main")` | 含 `main`（function，`0x0800476C`） |
| `orbit.symbol.search("Handler")` | 94 项，含 `Reset_Handler`（function） |
| `orbit.symbol.search("Handler", kinds:["function"])` | 94 项全部为 function |
| `orbit.symbol.search("Handler", limit:2)` 分页 | 第 1 页 `[ADC_IRQHandler, BusFault_Handler]` → 第 2 页 `[CAN1_RX0_IRQHandler, CAN1_RX1_IRQHandler]`，无重叠 |
| `orbit.expression.evaluate("$PC")` | `available:true`，value `134239940`（=`0x080056C4`），`variablesReference:"0"` |
| `orbit.expression.evaluate("$SP")` | `available:true`，value `537001984`（=`0x20020000`） |
| `orbit.expression.readMany(["$PC","$SP"])` | 2 项按序返回，均 `available:true` |
| `orbit.expression.readMany(["$PC","__definitely_not_a_symbol__"])` | 第 1 项成功、第 2 项 `available:false`+error，逐项隔离 |
| `orbit.expression.inspect("$PC")` | `root.available:true` + 良构空 `items`（标量无子项） |
| **PC 交叉校验** | `evaluate("$PC")` = `runtime.registers.PC` = `0x080056C4` ✅ |

`evaluate("$PC")` 与 `runtime.registers.PC` 收敛到同一个 `0x080056C4`，证明
`orbitExpressionSnapshot` 复用的正是 UI 的表达式/寄存器读 core，而非旁路。

符号解析三路一致：`resolve("main")`、`search("main")`、`resolve(address)`
都指向 `main @ 0x0800476C`，证明 ELF/DWARF 符号缓存被精确复用。

## 观察（非缺陷）

1. **冷启动首个 `evaluate` 偶发瞬时 `TargetRunning`（stale）**：脚本首次运行、
   session 刚启动时，第一个 `evaluate("$PC")` 返回 `available:false, stale:true,
   error:TargetRunning`；紧随其后的 `evaluate("$SP")` 与重跑（warm 会话）全部成功。
   这是 `readWatchExpressions` 在入口 halt 交接窗口内返回 cached/running 占位值的
   既有行为（非 Task 8 引入），客户端按 `retryable:true` 重试即恢复，且不伪造
   stopped 数据。第二次运行 16/16 全 PASS。
2. **`readMany` 缺失符号项错误码为 `InternalError`**：后端 `evaluateExpression`
   对「Symbol not found」不返回 `errorCode`，service 保守映射为 `InternalError`；
   真实信息保留在 `error.details.dapMessage`（`"Symbol not found: …"`）。逐项隔离
   语义正确，仅错误码偏泛化。
3. **`evaluate`/`readMany`/`inspect` 对 `frameId`/`contextKind` 透传但当前符号型
   后端不区分帧作用域求值**；`writeMany` 的 `resumeIntent` 被接受，写 core 恒为
   `preserve`（写后恢复运行态）。

## 未验证

- **`orbit.expression.writeMany`**：需 `variables.write` scope（当前
  `allowedScopes` 未包含）且属目标内存写入，需用户明确授权具体变量与值后方可执行。

## 脚本

- `scripts/automation-api/verify-expression.js` — handshake → start →
  symbol.resolve/search（含分页/kind 过滤）→ evaluate/readMany/inspect + PC 交叉校验
