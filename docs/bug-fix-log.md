# Bug 修复日志

## 修改规范

1. **每次修改前**, 先创建 Issue 或在顶部登记修改记录
2. **每个 Bug 一条记录**, 按时间倒序排列（最新的在最上面,）
3. **必须包含**: 问题描述、根因分析、修改方案、涉及文件及行号
4. **涉及步进相关逻辑时**, 修改后必须在目标板上验证至少一轮循环的"逐过程"功能
5. **硬件断点相关改动**（`jlink-dll.ts` / `handleSetBreakpoints` / `clearBreakpoint`）需额外注意并发竞争和状态同步
6. **必须用户明确同意后才能写入**（agent 不得自行决定写入）

## 修改记录

### Bug: 浮点循环连续调用遗留幽灵硬件断点

- **日期**: 2026-07-12
- **问题描述**: 在 `for (int fi = 0; fi < 4; fi++) { f = f * 0.5 + 1.0; }` 处单步后，Continue 会反复停在 `0x08003B6E`，其源码位置为浮点表达式行，且界面中没有可删除的用户断点。
- **根因分析**: `0x08003B6E` 是 `BL __aeabi_dmul` 的返回地址。native `stepOverSourceLine` 在同一源码行内先后处理 `__aeabi_dmul` 与 `__adddf3` 时，只记录一个临时返回断点槽。第二次调用到达第一次临时返回地址时，helper 将自己的临时断点误当作用户断点，并在清理阶段重新安装，留下未被用户断点槽跟踪的硬件断点。
- **修改方案**: helper 追踪本次 step-over 创建的全部临时槽；当前 PC 命中自身临时槽时清除并从临时集合移除，仅恢复真实用户断点。step-over diagnostics 增加本次创建的临时槽数量，mock DLL 覆盖两个连续调用并验证槽位可立即复用。
- **涉及文件**:
  - `native/jlink-helper/src/main.cpp` - `stepOverSourceLine`
  - `native/jlink-helper/test/mock-jlink.cpp` - 连续调用的 mock 执行流
  - `scripts/cpp-channel-smoke.js` - 临时槽清理集成回归
  - `src/ozone-backend/cpp-jlink-channel.ts` - `NativeStepOverDiagnostics`
- **验证结果**: `npm run build:native`、`npm run test:cpp-channel:mock`、`npm run typecheck`、`npm test`（9 个文件，43 项）和 `npm run build` 通过。mock 验证不等同于真实硬件验收。

### Bug: 弱符号软浮点函数无法单步跳出

- **日期**: 2026-07-12
- **问题描述**: 从包含 `double` 运算的源码单步进入 `__aeabi_dmul` 后，执行单步跳出提示 `StepOutFunctionRangeUnavailable: no function contains PC 0x8000190`，调试器无法回到调用方。
- **根因分析**: `arm-none-eabi-nm` 将 `__aeabi_dmul` 标为弱函数符号 `W`，范围为 `0x08000190..0x080003E4`。`resolveFunctionRange` 仅接受 `T/t`，在调用 native helper 前错误地判定当前 PC 不属于任何函数。
- **修改方案**: 将带有效大小的 `W/w` 符号与 `T/t` 一样作为函数范围来源；native helper 继续验证 PC、LR、SP、返回地址可读性、断点生命周期和清理结果，不引入第二个 J-Link owner。
- **涉及文件**:
  - `src/ozone-backend/commander.ts` - `resolveFunctionRange`
  - `src/ozone-backend/commander-native-stop.test.ts` - `__aeabi_dmul` 弱函数范围 stepOut 回归测试
- **验证结果**: `npm run typecheck`、`npm test`（9 个文件、39 项）和 `npm run build` 通过。已用目标 ELF 的 `arm-none-eabi-nm` 确认符号类型和范围；真实硬件 stepOut 仍待复核。

### Bug: 浮点 for 循环逐过程耗尽同一源码行指令预算

- **日期**: 2026-07-12
- **问题描述**: 对 `double f = 1.0; for (int fi = 0; fi < 4; fi++) { f = f * 0.5 + 1.0; }` 执行逐过程时，native step-over 在同一行的循环回跳中多次报 `StepInstructionLimit`，需要重复点击才能离开该行。
- **根因分析**: 日志显示该源码行范围为 `0x08003B5A..0x08003B94`，32 条指令不足以覆盖 soft-float 运算和四轮循环回跳；helper 在仍位于同一行时安全地停止并返回失败。
- **修改方案**: Commander 为 native source step-over 传递 128 条指令预算，helper 默认预算调整为 128、上限调整为 256，保留超限错误保护。mock DLL 新增四轮回跳循环，验证单次 step-over 能完成 48 条同一行指令。
- **涉及文件**:
  - `src/ozone-backend/commander.ts` - `doStepOver`
  - `native/jlink-helper/src/main.cpp` - `stepOverSourceLine`
  - `native/jlink-helper/test/mock-jlink.cpp` - 同一行循环 mock
  - `scripts/cpp-channel-smoke.js` - mock 集成回归
  - `src/ozone-backend/commander-native-stop.test.ts` - Commander 指令预算回归
- **验证结果**: `npm run build:native`、`npm run test:cpp-channel:mock`、`npm run typecheck`、`npm test`（9 个文件、38 项）和 `npm run build` 通过。用户已在真实硬件调试中确认该 for 循环可正常逐过程通过。

### Bug: stepOut 后首次 stepInto/stepOver 视觉上不前进

- **日期**: 2026-07-12
- **问题描述**: Native `stepOut` 返回后，VS Code 已通过 source hint 显示到调用后的下一条 statement，但真实 PC 仍停在 LR return address。紧接着第一次 `stepInto` 或 `stepOver` 实际只让 PC 追上 UI 已显示的位置，视觉上需要再点击一次才继续。
- **根因分析**:
  1. `stepOut` 的 source hint 只修正 stackTrace 首帧和 UI 源码位置，不移动真实 PC，这是正确行为。
  2. 下一次源码级 step 仍按真实 PC 的原始 DWARF 调用行计算边界，首次操作只执行了 return address 到 hint 地址之间的指令。
- **修改方案**:
  1. `resolveNativeLineBounds` 在 Native owner、stop PC 精确匹配且 hint 位于同一函数范围内时，从真实 PC 开始，将本次范围扩展到 hint statement 后的第一条不同源码位置。
  2. PC 不匹配、hint 无效或跨函数时完全保留原始 DWARF 范围；新的 Native stop info 自动覆盖旧 hint。
  3. 增加真实 PC、raw/hint source、有效 lineStart/lineEnd 和 hint 使用状态日志；不移动 PC，不改变 helper、owner 或 legacy fallback。
- **涉及文件**:
  - `src/ozone-backend/commander.ts` - `resolveNativeLineBounds`
  - `src/ozone-backend/commander-native-stop.test.ts` - stepOut 后 stepInto/stepOver 及无效 hint 回归测试
- **验证结果**: `npm run build:native`、`npm run test:cpp-channel:mock`、`npm run typecheck`、`npm run build`、`npm test` 全部通过，Vitest 9 个文件、37 项通过。用户已在真实硬件调试中确认 stepOut 后首次 stepInto/stepOver 行为正常，未观察到 stackTrace、Watch、Timeline 或变量操作退化。

### Bug: stepInto 需多次点击才进入调用函数，stepOut 返回后仍停在调用行

- **日期**: 2026-07-12
- **问题描述**: 光标位于包含 `calcSum(cnt, 7)` 等调用的源码行时，DAP `stepIn` 按单条指令执行参数准备指令，需点击 2-3 次才到达 `BL/BLX` 并进入函数；`stepOut` 到达 return address 后，DWARF 地址映射可能仍显示原调用行。
- **根因分析**:
  1. Native step-into 原先仅提供指令级原语，DAP 没有将当前源码行范围交给 Native helper，参数准备阶段被拆成多次 UI step。
  2. `pcAfter` 是正确的 return address，但地址到源码行的映射可能落在调用 statement，stackTrace 首帧缺少调用后的源码位置纠偏。
- **修改方案**:
  1. 新增 `stepIntoSourceLine`：在当前源码行地址范围内最多扫描 32 条 Thumb 指令，识别 `BL`、立即 `BLX` 与寄存器 `BLX` 后执行该指令进入函数；未发现调用而离开行范围或达到上限时正常停止。
  2. Commander 将 DAP `stepInto` 路由到源码级接口，记录每条扫描指令的 PC、分类和 call 判断，并保持 instruction step 与 legacy koffi fallback 可用。
  3. stepOut 返回后以可信 native `pcAfter` 为事实来源；若原始映射仍在调用行，则为 stackTrace 第一帧提供同一函数内下一源码 statement 的 source hint。
- **涉及文件**:
  - `native/jlink-helper/src/main.cpp` — `stepIntoSourceLine`
  - `src/ozone-backend/cpp-jlink-channel.ts` — `NativeStepExecutor.stepIntoSourceLine`
  - `src/ozone-backend/commander.ts` — `doStepInto`、`resolveNativeLineBounds`、`resolveStepOutSourceHint`
  - `scripts/cpp-channel-smoke.js` — Native helper Mock 集成用例
  - `src/ozone-backend/commander-native-stop.test.ts` — stepInto 路由、stepOut source hint 与 stackTrace 回归
- **验证结果**: `npm run build:native`、`npm run test:cpp-channel:mock`、`npm run typecheck`、`npm run build`、`npm test` 全部通过；Vitest 6 个文件、22 项通过。Mock 已覆盖两条普通指令后进入 BL、普通源码边界、最大指令数退出、既有 stepOver 断点生命周期及 stepOut source hint。用户已在连接目标的 VS Code UI 手动确认第 7/8 行调用可一次进入目标函数，stepOut 后光标位置正确。

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
