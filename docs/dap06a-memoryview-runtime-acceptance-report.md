# DAP-06A 运行态 MemoryView 验收报告

- **项目**: Orbit for VS Code
- **阶段**: DAP-06A
- **日期**: 2026-08-09
- **验收对象**: 运行态添加 `mcu-debug.memory-view` MemoryView
- **目标读者**: 后续 AI 验收、代码审查和硬件复核人员
- **总体结论**: DAP-06A 运行态 MemoryView 添加已支持；本次负数边界修复和自动化验证通过，本次修复未执行真实硬件操作

## 1. 需求与边界

本阶段只解决目标程序处于 `Running` 状态时，MemoryView 添加视图不再因默认表达式
`4 * 1024 * 1024` 得到 `Result: running` 而失败。

本阶段明确不实现：

- 运行态 MemoryView 手动刷新或持续自动刷新
- 运行态 `readMemory` 行为、MemoryView `getMemory` 的 `Stopped` 限制
- 运行态 halt/pause/reset/run 的新语义
- 通用 C/C++ 表达式解释器
- J-Link、legacy、OpenOCD、GDB server 或 `JLink.exe` 路径
- 第二个 CMSIS-DAP helper 或第二个 physical owner
- Flash erase/program/verify、RAM 写入和断点持久化测试

## 2. 根因

第三方 MemoryView 0.0.29 在添加视图时调用：

```javascript
session.customRequest("evaluate", {
  expression: expr,
  context: "hover",
  frameId
})
```

插件默认 size 表达式为 `4 * 1024 * 1024`。原有 `DapSession.handleEvaluate` 在运行态会先申请
target-read gate，再检查目标是否 halted；目标运行时返回 WatchValue `running`，因此插件无法将
返回值识别为十进制或十六进制常量。

## 3. 实现变更

### 3.1 运行态短路

文件：`src/debug/dap-session.ts`

`handleEvaluate` 在 gate、halted 检查和 `backend.execute('evaluateExpression')` 之前增加：

- 仅当 `targetRunning === true` 时尝试常量解析
- 解析成功立即返回 DAP response
- 不访问目标、不调用 backend、不改变 `targetRunning`
- 解析失败继续原有 evaluate 路径

### 3.2 安全常量解析器

文件：`src/utils/constant-expression.ts`

导出函数：`parseConstantExpression(expression: unknown): number | undefined`

解析器为递归下降实现，禁止 JavaScript `eval`、`Function` 构造器和字符串替换执行。

支持：

- 十进制整数：`4096`
- 十六进制整数：`0x1000`
- 括号：`(4 * 1024)`
- `+`、`-`、`*`、`/`
- 一元 `+`
- 整数除法，非整除结果拒绝
- 中间结果和最终结果均限制在 `0..0xFFFFFFFF`

拒绝：

- 变量名、未知标识符和函数调用
- `&myVariable`、`*(0x20000000)`、成员访问和数组下标
- 浮点数、`NaN`、`Infinity`
- 除零和非整数除法
- 未知字符、语法残缺和括号不匹配
- 超出无符号 32 位范围的地址或 size

一元负号及其派生负数表达式均拒绝并返回 `undefined`，包括：`-1`、`-0x1`、`-(1)`、
`1 + -2` 和 `0 - 1`。

按位运算和移位运算本阶段未启用；不属于本阶段必要能力。

## 4. DAP response 兼容性

运行态常量返回插件可识别的纯数字字符串：

```json
{
  "result": "4194304",
  "variablesReference": 0
}
```

真实硬件返回示例：

| 表达式 | DAP `result` | `variablesReference` |
|---|---:|---:|
| `4 * 1024 * 1024` | `4194304` | `0` |
| `0x20000000 + 0x100` | `536871168` | `0` |
| `(1024 * 4)` | `4096` | `0` |

MemoryView 的 `getExprResult` 接受 `/^0x[0-9a-f]+$/i` 或 `/^[0-9]+$/`，上述返回值均满足其判断。

非常量运行态表达式保持原语义。例如真实硬件上 `myVariable` 仍返回：

```json
{
  "result": "running",
  "variablesReference": 0
}
```

这证明非法或依赖目标状态的表达式没有被伪装成常量成功。

## 5. 自动化验证

新增测试位于：

`src/debug/dap-session-realtime-variables.test.ts`

覆盖内容：

- 三种合法常量表达式的结果
- 变量、指针、函数、成员、数组、除零、浮点和越界表达式拒绝
- 负数和一元负号表达式拒绝
- 运行态常量不调用 backend
- 运行态常量不改变 `targetRunning`
- DAP response 的 `result` 和 `variablesReference`

已执行命令：

| 命令 | 结果 |
|---|---|
| `npm test -- --run src/debug/dap-session-realtime-variables.test.ts` | 通过，1 个测试文件，39 个测试 |
| `npm run typecheck` | 通过 |
| `npm test` | 通过，34 个测试文件，355 个测试 |
| `npm run build` | 通过 |
| `npm run build:native` | 通过 |
| `npm run test:cmsis-dap:mock` | 通过 |
| `npm run test:cpp-channel:mock` | 通过 |
| `git diff --check` | 通过 |

补充说明：`npm run lint` 未能启动，因为仓库当前没有 ESLint 9 所需的
`eslint.config.js`、`eslint.config.mjs` 或 `eslint.config.cjs`；这不是本次改动引入的源码错误。

## 6. 真实硬件验证

说明：本节记录 DAP-06A 首次实现时已经完成的真实 CMSIS-DAP 验证证据。本次负数边界修复只执行
代码和自动化测试，未重新连接或操作真实硬件。

### 6.1 配置

- MCU：STM32F407VET6
- 工程：`D:\STM32\project\vet6_led`
- ELF：`D:\STM32\project\vet6_led\build\Debug\vet6_led.elf`
- 探针：CMSIS-DAP_LU
- VID/PID：`C251:F001`
- Serial：`LU_2022_8888`
- 传输：HID
- 接口：SWD
- SWD 频率：1000 kHz
- `flashBeforeDebug`: `false`

### 6.2 流程

真实 DAP adapter 流程：

```text
initialize
launch (probe=cmsis-dap, flashBeforeDebug=false)
configurationDone -> stopped(entry)
continue -> continued(Running)
evaluate constants while Running
evaluate unsafe expression while Running
pause -> stopped(pause)
disconnect
```

### 6.3 结果

最小硬件 runner 共 10 项检查，全部通过：

1. initialize
2. CMSIS-DAP launch，Flash disabled
3. configurationDone 和 entry stopped
4. continue 进入 Running
5. `4 * 1024 * 1024` 返回 `4194304`
6. `0x20000000 + 0x100` 返回 `536871168`
7. `(1024 * 4)` 返回 `4096`
8. `myVariable` 保持原有 `running` 结果
9. pause 成功
10. disconnect 成功

### 6.4 owner 与清理证据

日志中确认：

- `owner=cmsis-dap`
- helper PID：`31456`
- `transport=hid`
- `serial=LU_2022_8888`
- helper 以 `exit code=0` 正常退出
- disconnect 后没有残留 `orbit-*`、J-Link、OpenOCD 或 GDB 进程
- 未创建第二 helper
- 未发生 J-Link fallback

日志文件：

- `outputs/Log/dll.log`
- `outputs/Log/dap.log`

### 6.5 硬件操作范围

首次 DAP-06A 真机测试执行了已授权的 halt、run/continue、pause 和 disconnect，用于证明运行态路径。
没有执行：

- Flash erase/program/verify
- RAM write
- option bytes 操作
- 断点写入

## 7. 回归边界

本改动没有修改：

- `readMemory` 调度优先级
- MemoryView 运行态 `getMemory` 的 stopped 检查
- 自动刷新机制
- Watch、Timeline、RTT、RTOS View 的原有读取路径
- CMSIS-DAP owner selector、helper channel 和 scheduler
- `dist/` 生成 bundle
- `docs/bug-fix-log.md`

停止态普通 evaluate、Watch、Timeline、RTT、RTOS View、continue/pause/reset/step 的既有自动化回归均通过。

## 8. 验收清单

- [x] Running 状态添加 MemoryView 不再因 `4 * 1024 * 1024` 失败
- [x] MemoryView 可识别 DAP `result`
- [x] 纯常量不访问目标、不阻塞 scheduler、不改变运行状态
- [x] 非纯常量没有被误判为常量
- [x] stopped-state 原有行为回归通过
- [x] CMSIS-DAP 单一 owner 保持不变
- [x] 无 J-Link fallback、无第二 helper
- [x] 自动化构建、单元测试和 mock 通过；原 DAP-06A 真机核心证据保留，本次修复未复测硬件
- [x] 运行态手动刷新仍未实现，符合本阶段边界
- [x] 本次边界修复明确拒绝负数表达式
- [x] 本次边界修复未执行真实硬件操作

## 9. 复核建议

其他 AI 验收时应重点检查：

1. `handleEvaluate` 的常量短路是否位于 target-read gate 之前。
2. `parseConstantExpression` 是否存在 `eval`、`Function`、目标访问或 DWARF 依赖。
3. 解析失败是否继续原有 evaluate 路径。
4. DAP response 的 `result` 是否为纯十进制/十六进制字符串，`variablesReference` 是否为 `0`。
5. 真机日志是否显示单一 `cmsis-dap` owner 和 helper 正常退出。
6. 是否误将本次结果扩展为“运行态手动刷新已实现”。

## 10. 交付文件与复核入口

本阶段交付文件：

- `src/debug/dap-session.ts`：运行态 evaluate 常量短路
- `src/utils/constant-expression.ts`：无副作用常量表达式解析器
- `src/debug/dap-session-realtime-variables.test.ts`：解析器和 DAP 行为回归测试
- `docs/dap06a-memoryview-runtime-acceptance-report.md`：本验收报告

建议复核顺序：

1. 先阅读本报告第 1、4、6、7、8 节，确认需求边界、DAP 返回格式、真机证据和未实现项。
2. 检查 `dap-session.ts` 的运行态分支，再检查 `constant-expression.ts` 的输入限制和运算范围。
3. 执行 `npm run typecheck`、`npm test`、`npm run build`，必要时补跑两个 mock channel 命令。
4. 若要复做真机测试，使用同一 STM32F407VET6 工程和 CMSIS-DAP 配置；不要把 `flashBeforeDebug=false` 改成烧录测试。

验收判定：运行态下三个纯整数表达式必须返回纯数字 `result` 且
`variablesReference=0`；`myVariable` 等目标依赖表达式仍返回 `running` 或原有安全结果；停止态和断开清理不能回归；报告明确列出的运行态手动刷新不属于本阶段验收项。

本次边界修复声明：运行态 MemoryView 添加保持支持；运行态手动刷新仍未实现；未修改 `dist/`、
`docs/bug-fix-log.md`、CMSIS-DAP owner、NativeScheduler、J-Link fallback 或第二 helper 路径，
也未执行真实硬件操作。
