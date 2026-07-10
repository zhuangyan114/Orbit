---
name: ozone-debug-fix
description: Fix Ozone VS Code extension step-over / breakpoint bugs on STM32/J-Link targets. Use when user reports step-over hangs, breakpoint operations cause unexpected behavior, CPU halts at random PC, or HardFault_Handler entry after debugging actions.
---

# Ozone Debug Fix Workflow

## ⚠️ 核心原则：先看日志，再分析，最后改代码

**绝对禁止**不分析日志就直接修改代码。所有步进/断点相关的 bug 必须在日志中找到确凿证据（PC 值、地址、时序）后，才能进行针对性修改。

现有日志不足以确定根因时，**必须增加日志**（在关键路径加 `daLog()` 调用），重新复现后分析新日志。**万万不可根据猜测直接改代码逻辑**——步进/断点涉及 J-Link DLL 状态机、DWARF 行号映射、时序竞争，猜错一次可能引入更难排查的 bug。

## 问题诊断流程

当遇到单步/断点相关 bug，按此流程定位：

### 1. 打开 daLog 诊断日志

`commander.ts` 和 `dap-session.ts` 中已有 `daLog` 基础设施（写入 `Log/ozone-step.log` + stderr）。确保 `enableDaLog()` 在模块加载时已调用。

### 2. 复现并分析日志

复现 bug 后读取 `Log/ozone-step.log`，寻找关键证据链，不得跳过此步骤。关键观察点：

| 日志特征 | 指向的 bug |
|---|---|
| `setBreakpoint resolved addr=62` 等非法地址 | 地址解析错误 → 加范围校验 `0x08000000~0x20100000` |
| `clearBreakpoint` 后 CPU halt 在 无关地址 | `clearBreakpoint` halt 后缺 `run()` → 保存 wasRunning 状态 |
| `setTempBpAndRun: addr=PC+2` + `waitForHalt` 超时 5.7s | 当前指令是无条件分支（`B`/`B.W`），temp BP 设在分支后方永不执行 → 检测分支指令，跳过 temp BP 走多步进循环 |
| 逐过程后跳回之前的行号 | DWARF 将分支目标地址映射到之前行号 → 多步进循环中 `line < startLoc.line → continue` |

### 3. 排查 `findNextSourceLineAddress`

当逐过程行为异常时，检查该函数。经典问题：

- **文件匹配过松**: `file.includes(fName)` 可能匹配到无关文件的同名行 → 改为 `file.endsWith(fName)` 严格后缀匹配
- **返回紧邻地址**: 当前指令是无条件分支（`B`/`B.W`），但函数返回 `PC+2`（分支目标另有地址，永不执行紧邻指令） → `doStepOver` 中检测 `isBranch` 跳过 temp BP 方式
- **行号回跳**: DWARF 将分支目标地址映射到之前行号（如 switch 结尾映射到 switch 行），导致步进提前停止 → 多步进循环中 `newLoc.line < startLoc.line → continue`

### 4. 排查 `clearBreakpoint`

`jlink-dll.ts` 中 `clearBreakpoint` 调用 `JLINK_ClrBP` 前需 halt CPU，但之后必须 resume：

```typescript
const wasRunning = !this.isHalted();
if (wasRunning) this.halt();
// ... clear BP ...
if (wasRunning) this.run();
```

`clearAllBreakpoints` 同理。

### 5. 排查 `doSetBreakpoint` 地址校验

`resolveLineAddress` 可能返回非法地址（如 `0x3E`），必须校验：

```typescript
if (addr < 0x08000000 || addr >= 0x20100000) {
  return { ok: false, error: `...outside valid flash range` };
}
```

优先使用 `lineEntries`（已按 `0x08000000~0x20100000` 过滤），兜底再用 `lineMapCache`。

### 6. `doStepOver` 分支指令处理

在 BL/BLX 检测之后、`findNextSourceLineAddress` 之前，增加无条件分支检测：

```typescript
const isBranch = !instrIs32 && (hw1 & 0xF000) === 0xE000  // 16-bit B
  || (hw1 & 0xF800) === 0xF000 && (hw2 & 0xC000) === 0x8000;  // 32-bit B.W
```

命中时跳过 temp BP，走多步进循环（配合 `newLoc.line < startLoc.line → continue` 逻辑）。

## 涉及文件

| 文件 | 关键函数 |
|---|---|
| `src/ozone-backend/commander.ts` | `doStepOver`, `doSetBreakpoint`, `doClearBreakpoint`, `resolveLineAddress`, `findNextSourceLineAddress` |
| `src/ozone-backend/jlink-dll.ts` | `clearBreakpoint`, `clearAllBreakpoints` |
| `src/ozone-backend/jlink-symbols.ts` | `resolveMappedStatementAddress` |
| `src/debug/dap-session.ts` | `handleSetBreakpoints`, `handleContinue`, `handleStep` |

## 验证清单

- [ ] 分支指令（`if`/`switch`/`while` 末尾）逐过程：不卡死、不回跳
- [ ] 在运行中设/删断点 → CPU 不意外 halt
- [ ] 非法地址设断点 → 报错不写目标
- [ ] 循环中逐过程 → 正常执行一轮不卡死
- [ ] 函数调用处逐过程 → 不跳进函数内部
