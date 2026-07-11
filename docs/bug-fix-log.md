# Bug 修复日志

## 修改规范

1. **每次修改前**, 先创建 Issue 或在顶部登记修改记录
2. **每个 Bug 一条记录**, 按时间倒序排列（最新的在最上面,）
3. **必须包含**: 问题描述、根因分析、修改方案、涉及文件及行号
4. **涉及步进相关逻辑时**, 修改后必须在目标板上验证至少一轮循环的"逐过程"功能
5. **硬件断点相关改动**（`jlink-dll.ts` / `handleSetBreakpoints` / `clearBreakpoint`）需额外注意并发竞争和状态同步
6. **必须用户明确同意后才能写入**（agent 不得自行决定写入）

## 修改记录

### Bug: sameLineStepping 步数限制不足导致 escape 后跳转到用户断点

- **日期**: 2026-07-11
- **问题描述**: 在 do-while 循环体（行 167）上点逐过程，CPU 回绕到 for 循环断点（行 145），而不是停在 do-while 之后的行
- **根因分析**:
  1. `sameLineStepping` 最多允许 10 步单步，但行 167 有 11+ 条指令（含循环变量递增、条件判断、分支），10 步后 PC 仍在行 167 的末指令
  2. 超出步数后走 escape 路径：`findNextSourceLineAddress` 返回不可达地址 `0x8003b08`，`setTempBpAndRun` 释放 CPU 后永不触发该 BP
  3. CPU 执行完 do-while 条件后自然回绕到 `while(1)` 顶部 `0x8003a80`，命中用户断点（slot 0），停在行 145
- **修改方案**: `sameLineStepping` 步数限制从 10 提高到 20
- **涉及文件**:
  - `src/ozone-backend/commander.ts` — `doStepOver` 内部 `sameLineStepping` 循环上限 `10 → 20`(L670)
- **验证结果**: 已验证通过

### Bug: switch-case break 逐过程卡死或跳回 switch 行

- **日期**: 2026-07-10
- **问题描述**: switch-case 的 `break;` 行按逐过程有两种表现：switch 行有断点时跳回 switch 行；无断点时卡死约 5.7 秒后停在随机位置
- **根因分析**:
  1. `break;` 编译为 Thumb 无条件分支指令 `B`（16-bit 编码 `0xE000` 或 32-bit `B.W`）。`findNextSourceLineAddress` 对 `break;` 返回了紧邻地址 `PC+2`，但 CPU 执行分支后跳到 switch 结尾，永远不执行该地址 → temp BP 永不触发 → `waitForHalt` 超时 5.7s
  2. 有断点时超时前 CPU 分支到 switch 结尾命中用户断点 → 显示在 switch 行
- **修改方案**:
  1. `doStepOver` 增加 Thumb 无条件分支检测（`B`/`B.W`），命中时跳过 temp BP 方式直接走多步进循环
  2. 多步进循环中 `newLoc.line < startLoc.line → continue` 步进经过 switch 行映射，到达真正下一行后停止
  3. `findNextSourceLineAddress` 第一轮扫描 `line !== startLoc.line` → `line > startLoc.line`
- **涉及文件**:
  - `src/ozone-backend/commander.ts` — `doStepOver`(L595-616), `findNextSourceLineAddress`(L650-651), 多步进循环(L623-628)
- **验证结果**: 已验证通过

### Bug: 未命中断点清除时 CPU 被 halt 不恢复

- **日期**: 2026-07-10
- **问题描述**: 在程序运行中设置断点（未命中），然后删除该断点时，CPU 停在了完全无关的地址，VS Code 显示暂停在随机位置
- **根因分析**: `jlink-dll.ts` 的 `clearBreakpoint` 在 CPU 运行时调用 `this.halt()` 暂停 CPU 以安全调用 `JLINK_ClrBP()`，但清除后从不调用 `run()` 恢复。导致每次删除运行中的 BP 后 CPU 被遗留在暂停状态，DAP 检测到 halt 后通知 VS Code 停下来。
- **修改方案**: `clearBreakpoint` 和 `clearAllBreakpoints` 在 halt 之前保存 `wasRunning` 状态，清除 BP 后若原来在运行则调用 `this.run()` 恢复
- **涉及文件**:
  - `src/ozone-backend/jlink-dll.ts` — `clearBreakpoint`(L300-315), `clearAllBreakpoints`(L317-326)
- **验证结果**: 待验证

### Bug: 地址解析错误导致断点写入系统区引发 HardFault

- **日期**: 2026-07-10
- **问题描述**: 在 `bsp_can.c:214` 设断点时，`resolveLineAddress` 返回了地址 62（0x3E），J-Link 将 BKPT 写入了 Cortex-M 系统区。清除该断点时 CPU 跳入 HardFault_Handler（PC=0x800facc, LR=0xFFFFFFF1）
- **根因分析**:
  1. `resolveMappedStatementAddress` 文件匹配使用 `file.includes(fName)` 模糊子串匹配，可能匹配到错误的源文件条目，返回了错误的地址
  2. `resolveLineAddress` 直接使用 `lineMapCache`（未经地址过滤），而非 `lineEntries`（已过滤 `0x08000000~0x20100000`）
  3. `doSetBreakpoint` 没有对解析出的地址做范围校验，直接将非法地址传给 `jlink.setBreakpoint`
- **修改方案**:
  1. `doSetBreakpoint` 增加地址范围校验：`addr < 0x08000000 || addr >= 0x20100000` 时返回错误
  2. `resolveLineAddress` 优先使用 `lineEntries`（已过滤合法地址范围），兜底再用 `lineMapCache`
  3. `resolveMappedStatementAddress` 文件匹配改为严格后缀匹配（`file.endsWith(fName)`），且结果要求 `address >= 0x08000000`
- **涉及文件**:
  - `src/ozone-backend/commander.ts` — `doSetBreakpoint`(L232), `resolveLineAddress`(L947-953)
  - `src/ozone-backend/jlink-symbols.ts` — `resolveMappedStatementAddress`(L362-372)
- **验证结果**: 地址解析已正确返回 `0x8014e18`

### Bug: 循环中逐过程卡死 + 跳转到随机位置

- **日期**: 2026-07-10
- **问题描述**: 
  - 有断点时, 在第一句点逐过程会跳到函数内部; 取消断点后步过会卡死并跳转到奇怪的地方
  - 修复后有断点时第一句和第三句需要多次点击才生效
- **根因分析**:
  1. **循环尾 temp BP 设在错误地址**: `findNextSourceLineAddress` 第二遍扫描找到 `address <= pc` 的条目作为"下一行", temp BP 设在 CPU 执行路径后方, 从不触发 → `waitForHalt` 超时 5.6秒 → 强制 halt 在随机位置
  2. **stale BP 判定条件错误**: 原来用 `curPc === _lastTempBpAddr` 检查上次 temp BP 地址, 导致正常步过也被当作 stale BP, 走单步代替 temp BP
  3. **stale BP + 非调用单步后 PC 跑过 temp BP**: `doSingleStep` 让 PC 前进, 但 temp BP 仍在原地址, `jlink.run()` 从新 PC 启动后 CPU 绕过 temp BP
  4. **多步进到达同行 BL 时未清除用户断点**: 用户断点仍在目标地址, CPU 启动即命中, 函数未被执行
- **修改方案**:
  1. `doStepOver` 非调用路径: `findNextSourceLineAddress` 返回 `address <= pc` 时不用 temp BP, 改为多步进到调用指令或新行
  2. `setTempBpAndRun` stale BP 条件: `curPc === _lastTempBpAddr` → `curPc === nextAddr`
  3. `setTempBpAndRun` stale BP + 非调用: 单步后不再 `jlink.run()`, 改为一律单步到调用/新行
  4. 多步进到达同行 BL 时: 先 `clearCurrentBpAndTrack(newPc)` 再 `setTempBpAndRun(pc+4)`
- **涉及文件**:
  - `src/ozone-backend/commander.ts` — `doStepOver`(L646-680), `findNextSourceLineAddress`, `setTempBpAndRun`(L774-813)
  - `src/ozone-backend/jlink-dll.ts` — `setBreakpoint` 增加 `preferredSlot` 参数(L277-291)
- **验证结果**: 有/无断点时逐过程均 1 次点击正常, 无卡死无跳转
