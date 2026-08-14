# Orbit Automation API — Task 8 表达式、变量写入与符号发现实机验证证据（2026-08-14）

> 通过 v1 Automation API 驱动真实、可见的 VS Code 调试会话完成
> `orbit.expression.evaluate / readMany / inspect / writeMany` 与
> `orbit.symbol.search / resolve` 全量验证。
> 只读部分（evaluate/readMany/inspect/symbol.*）无需授权；`writeMany`
> 经用户明确授权，对专用 RAM 测试全局 `g_ram_data` 执行「写入→读回校验→恢复原值」。

## 环境

| 项 | 值 |
|---|---|
| 目标 | STM32F407VET6 |
| 探针 | J-Link（`JLink_V956`） |
| 工程 | `d:\STM32\project\vet6_led` |
| ELF | `build\Debug\vet6_led.elf` |
| endpoint instanceId | `df30b24b-4d8f-4428-b923-6dd8b813ef3b` |
| session | `91e458f7-1fc9-4028-9be7-63eba962ec7c`（generation 1，入口 halt） |
| allowedScopes | `["read","session.control","breakpoints.write","variables.write"]` |

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

## writeMany 写入验证（经用户授权）

目标专用 RAM 测试全局 `g_ram_data`（`uint32_t` @ `0x20000010`）：

| 步骤 | 结果 |
|---|---|
| 读原值（`readMany`） | `0xAAAAAAAA (2863311530)` |
| 写测试值（`writeMany` `0x5A5AA5A5`） | `written:true`，echo `value:"0x5A5AA5A5"` |
| 读回校验（`readMany`） | `0x5A5AA5A5 (1515890085)` ✅ |
| 恢复原值（`writeMany` `2863311530`） | `written:true` |
| 读回校验（`readMany`） | `0xAAAAAAAA (2863311530)` ✅（与原始一致） |
| 逐项隔离 | `[__not_a_symbol__, g_ram_data]` → 第 1 项 `written:false`，第 2 项 `written:true` ✅ |

写入走通了 `withStepLock` + `beginTargetWrite` 控制屏障，且标量 `uint32_t`
读回为 `0xHEX (DECIMAL)` 显示 + `type:"uint32_t"` + `memoryReference:"0x20000010"`。

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
4. **`writeMany` 缺失符号项错误码同为 `InternalError`**：与 readMany 一致，
   后端 `setWatchValue` 对「Symbol not found」不返回 `errorCode`；真实信息在
   `error.details.dapMessage`，逐项隔离语义正确。

## 已知限制（安全 review，经用户确认记录、暂不修复）

1. **[M·继承] J-Link 写路径无 RAM 范围护栏**：`doSetWatchValue` 仅对 CMSIS-DAP
   owner 强制 `0x20000000–0x20020000` SRAM 范围检查；J-Link（native/legacy）的
   `targetWriteMemory` 直接 `WriteMem`，无等价护栏。对 flash 映射符号（如函数符号）
   执行 `writeMany` 时，J-Link 会尝试原始写——运行时通常对 flash 失败，但无显式
   保证。此缺口属 UI Watch 写变量的既有行为，Task 8 复用同一 `setWatchValue` core
   而未新开洞。后续应给 J-Link 补一个与 CMSIS-DAP 对称的 SRAM 护栏。
2. **[L] `writeMany` 批量非原子**：逐项 `withStepLock`+`beginTargetWrite` 获取/释放，
   每项都过屏障但整批可被 step/continue 插入；Zod 上限 1000 兜底。
3. **[L] `parseWriteValue` 64 位精度损失**：>2^53 的十六进制值经 `Number.parseInt`
   损失精度，整数写再 `value >>> 0` 截断到 32 位；写入尺寸始终由符号 `size`（≤8 字节）
   约束，不越界，仅静默截断。
4. **[L] `symbol.search` 2000 条截断**：后端 `searchSymbols` cap `maxResults:2000`，
   cursor 分页重拉同一窗口，宽泛 query 匹配 >2000 时看不到之后的符号；有界无 DoS。
5. **[L·外观] 符号 query/name 未拒控制字符**：仅 `trim`+拒空，与表达式 normalize
   不一致；因 `.includes`/精确匹配为字面量，无注入风险。
6. **[L] `frameId`/`contextKind`/`resumeIntent` 被接受但不生效**：符号型后端无帧
   作用域求值、写后恒 `preserve`。

> 安全边界本身完好：`writeMany` 的 `variables.write` scope、`idempotencyKey`、
> session generation fence 均强制生效；`writeMany` 只能写 ELF 符号地址，不能写
> 任意地址（比 legacy `setWatchValue` 的 `address` 参数更安全）；无 shell/正则注入面。

## 提交

- `feat(api): expose expressions variables and symbols`（`0279181`）

## 脚本

- `scripts/automation-api/verify-expression.js` — handshake → start →
  symbol.resolve/search（含分页/kind 过滤）→ evaluate/readMany/inspect + PC 交叉校验
- `scripts/automation-api/verify-write.js` — handshake（含 variables.write）→
  `g_ram_data` 写测试值→读回校验→恢复原值→读回校验 + 逐项隔离
