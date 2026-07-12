# 调试引擎重构任务列表

本文档用于跟踪“状态机重写 + C++ J-Link 通道 + 调度器”重构。每个任务都包含目标、产出、验收标准和可复制给其他 AI 的提示词。

## 任务 01：建立逐过程性能基线

**目标**：量化当前逐过程延迟来源，避免重构后无法判断收益。

**产出**：
- `docs/debug-engine-refactor/performance-baseline.md`。
- 一份逐过程耗时日志格式说明。
- 至少覆盖普通语句、函数调用、循环、switch、do-while、用户断点命中场景。
- 记录 `read PC`、`readMemory`、`setBreakpoint`、`run`、`waitForHalt`、`cleanupBreakpoint`、DAP stopped event 的耗时。

**验收标准**：
- 能从 `outputs/Log/step.log` 或新增 profiling 日志中看出一次 step 的分段耗时。
- 能识别 5 秒级卡顿是否来自临时断点未命中。
- 不改变现有调试行为。

**给其他 AI 的提示词**：
```text
你在 Ozone for VS Code 项目中工作。请先阅读 AGENTS.md、docs/debug-engine-refactor/overall-guidance.md、docs/bug-fix-log.md 和 .agent/skills/ozone-debug-fix/SKILL.md。不要修改逐过程逻辑，只为当前 step over/step into/step out 增加低侵入 profiling 日志，记录 read PC、readMemory、setBreakpoint、run、waitForHalt、cleanupBreakpoint、DAP stopped event 的耗时。日志必须使用 src/utils/logger.ts 的分类，不要写 console.log。完成后运行 npm run typecheck，并说明如何用目标板复现和查看日志。
```

## 任务 02：定义 Native Debug Engine 边界

**目标**：确定 Node/DAP 层和 C++ 层的职责边界。

**产出**：
- `docs/debug-engine-refactor/native-debug-engine-api.md`。
- `NativeDebugEngine` API 草案。
- 命令、返回值、错误码、状态枚举说明。
- 明确哪些逻辑留在 TypeScript，哪些下沉到 C++。

**验收标准**：
- Step、断点、寄存器、内存、变量读写、快速采样都有对应 API。
- TypeScript 不再负责指令级 step-over 状态机。
- Watch/Timeline 的实时读写路径被保留。

**给其他 AI 的提示词**：
```text
请为 Ozone for VS Code 设计 NativeDebugEngine API 文档，目标是未来由 C++ J-Link 通道承载 step 状态机、断点管理、寄存器/内存读写和快速变量采样。请先阅读 AGENTS.md、docs/debug-engine-refactor/overall-guidance.md、任务 01 产生的 docs/debug-engine-refactor/performance-baseline.md，然后阅读 src/ozone-backend/types.ts、src/ozone-backend/commander.ts、src/debug/dap-session.ts 和 src/session/data-sampling-manager.ts。只写设计文档，不改源码。文档需说明 TypeScript 与 C++ 的职责边界、命令返回结构、错误码、线程/调度约束，以及如何保持 Watch/Timeline 实时变量读取和 setWatchValue 修改变量功能。
```

## 任务 03：整理 OpenOCD 调试状态机参考文档

**目标**：在设计本项目 Step 调试状态机之前，先系统整理 OpenOCD 的 target 状态、resume/step/breakpoint/polling 思路，作为“可模仿的设计参考”，但不复制 GPL 源码。

**产出**：
- 一份 `openocd-state-machine-notes.md` 参考文档。
- OpenOCD target 状态、单步、继续运行、断点、轮询、GDB remote 事件流的中文梳理。
- 明确哪些思想可借鉴，哪些代码或实现细节不能直接搬。
- 对照本项目当前 `doStepOver`、`waitForHalt`、DAP `handleStep` 的差异分析。

**验收标准**：
- 文档引用 OpenOCD 官方源码位置或官方文档链接，便于后续查证。
- 不包含大段 OpenOCD 源码复制。
- 输出的是架构和状态机层面的抽象，而不是 GPL 代码改写。
- 能直接作为下一步“设计 Step 调试状态机”的输入。

**给其他 AI 的提示词**：
```text
请为 Ozone for VS Code 重构编写一份 OpenOCD 调试状态机参考文档，保存到 docs/debug-engine-refactor/openocd-state-machine-notes.md。请先阅读 AGENTS.md、docs/debug-engine-refactor/overall-guidance.md、任务 02 产生的 docs/debug-engine-refactor/native-debug-engine-api.md，再查阅 OpenOCD 官方源码/文档，重点整理 target 状态、polling、resume、step、breakpoint、watchpoint、GDB remote stopped event 的设计思想。注意：OpenOCD 是 GPL 项目，不要复制大段源码，也不要把源码改写成本项目实现；只总结架构、状态转移、关键设计取舍和可借鉴点。最后请对照本项目 src/ozone-backend/commander.ts 的 doStepInto/doStepOver/doStepOut/setTempBpAndRun/waitForHalt，以及 src/debug/dap-session.ts 的 handleStep，指出本项目在单步进入、逐过程、单步跳出、运行到临时断点这些基础调试功能上应该模仿哪些状态机思想、避免哪些做法。
```

## 任务 04：设计 Step 调试状态机

**目标**：用明确状态机统一设计单步进入、逐过程、单步跳出和运行到临时断点，替代当前补丁式 step 分支。

**产出**：
- `docs/debug-engine-refactor/step-state-machine-design.md`。
- `stepIntoInstruction`、`stepOverInstruction`、`stepOverSourceLine`、`resumeUntilBreakpoint` 状态图。
- Thumb 指令分类策略。
- 临时断点生命周期规则。
- 超时和异常恢复规则。

**验收标准**：
- 单步进入、逐过程、单步跳出都有明确状态图和失败恢复路径。
- 普通非调用指令优先走单指令 step。
- `BL/BLX` 只在确定 return address 后设置临时断点。
- 分支、循环、switch、do-while 有单独策略，不盲设不可达临时断点。
- 用户断点和临时断点冲突有确定处理规则。

**给其他 AI 的提示词**：
```text
请为 Ozone for VS Code 编写新的 Step 调试状态机设计文档，保存到 docs/debug-engine-refactor/step-state-machine-design.md。先阅读 AGENTS.md、docs/debug-engine-refactor/overall-guidance.md、任务 03 产生的 docs/debug-engine-refactor/openocd-state-machine-notes.md、docs/bug-fix-log.md 中所有 step 相关问题，再阅读 src/ozone-backend/commander.ts 的 doStepInto、doStepOver、doStepOut、setTempBpAndRun、waitForHalt、findNextSourceLineAddress、doSingleStep。目标是设计一个可迁移到 C++ 的状态机，统一覆盖 step into、step over instruction、step over source line、step out、resume until temporary breakpoint，而不是继续补丁式修改 TypeScript。请用中文写出状态、转移条件、超时策略、临时断点生命周期、用户断点冲突处理、Thumb BL/BLX/B/条件分支处理、step-out 返回地址策略，以及每类场景的验收用例。
```

## 任务 05：C++ J-Link 通道技术选型

**目标**：选择 C++ 集成方式，避免一开始走错工程路线。

**产出**：
- `docs/debug-engine-refactor/cpp-jlink-channel-selection.md`。
- Node native addon、独立 helper 进程、N-API、FFI 替代方案对比。
- Windows 构建方案。
- J-Link DLL 加载、版本检测、错误传播设计。

**验收标准**：
- 明确首选方案和备选方案。
- 明确如何打包到 VS Code extension。
- 明确不会引入 OpenOCD/GDB server 作为实时变量主通道。

**给其他 AI 的提示词**：
```text
请为 Ozone for VS Code 的 C++ J-Link 通道做技术选型。请先阅读 AGENTS.md、docs/debug-engine-refactor/overall-guidance.md、任务 04 产生的 docs/debug-engine-refactor/step-state-machine-design.md。项目是 Windows-only VS Code 扩展，当前用 koffi 调用 JLink_x64.dll。请比较 Node N-API addon、独立 C++ helper 进程、本地 TCP/stdio RPC、继续 koffi 的优缺点。重点考虑打包、崩溃隔离、性能、J-Link DLL 状态管理、实时变量采样和写变量延迟。输出中文 Markdown 设计建议，不改源码。
```

## 任务 06：实现 C++ 通道最小原型

**目标**：证明 C++ 层可稳定加载 J-Link DLL 并执行基础控制。

**产出**：
- `docs/debug-engine-refactor/cpp-channel-prototype-notes.md`。
- 最小 C++ 通道原型。
- 支持 connect、halt、run、step、readRegister、readMemory、setBreakpoint、clearBreakpoint。
- TypeScript 侧有实验性封装，不替换默认路径。

**验收标准**：
- 默认调试路径不受影响。
- 原型能在开发环境单独测试。
- 崩溃或加载失败时能回退现有 koffi 路径。

**给其他 AI 的提示词**：
```text
请在 Ozone for VS Code 中实现 C++ J-Link 通道最小原型，但不要替换现有默认 koffi 路径。先阅读 AGENTS.md、docs/debug-engine-refactor/overall-guidance.md、任务 05 产生的 docs/debug-engine-refactor/cpp-jlink-channel-selection.md、package.json、esbuild.config.js、src/ozone-backend/jlink-dll.ts。实现目标是能加载 JLink_x64.dll 并提供 connect、halt、run、step、readRegister、readMemory、setBreakpoint、clearBreakpoint。请优先保证实验路径隔离、错误可诊断、构建可重复。不要修改 dist。完成后运行 npm run build 和 npm run typecheck。
```

## 任务 07：实现 Native 调度器

**目标**：统一控制 step、断点、变量读写和快速采样，避免 J-Link DLL 并发冲突。

**产出**：
- `docs/debug-engine-refactor/native-scheduler-design.md`。
- 调度器优先级规则。
- 控制命令、写变量、Watch 读取、Timeline 采样的队列策略。
- 取消、暂停、恢复机制。

**验收标准**：
- step/halt/continue/breakpoint/writeVariable 是高优先级。
- Timeline 高频采样不会阻塞 step。
- step 期间低优先级采样暂停，step 完成后恢复。
- 不破坏实时获取和修改变量功能。

**给其他 AI 的提示词**：
```text
请为 Ozone for VS Code 设计并实现 Native Debug Engine 调度器的第一版。先阅读 AGENTS.md、docs/debug-engine-refactor/overall-guidance.md、任务 06 产生的 docs/debug-engine-refactor/cpp-channel-prototype-notes.md、src/debug/dap-session.ts、src/session/data-sampling-manager.ts、src/debug-providers/watch-provider.ts、src/plugin-api/runtime-router.ts。调度器必须保护 J-Link DLL 单通道访问：step/halt/continue/breakpoint/writeVariable 高优先级，Watch 中优先级，Timeline 高频采样低优先级。step 期间暂停低优先级采样，完成后恢复。请保留现有实时变量读取和 setWatchValue 修改变量行为，不要引入 OpenOCD/GDB server。
```

## 任务 08：迁移 step-over 到 Native 状态机

**目标**：让逐过程核心逻辑从 TypeScript 迁移到 C++ 状态机。

**产出**：
- `docs/debug-engine-refactor/step-over-native-migration-notes.md`。
- Native `stepOverSourceLine` 实现。
- TypeScript `doStepOver` 改为薄封装。
- 新旧路径可通过配置切换。

**验收标准**：
- 普通语句逐过程延迟明显下降。
- 函数调用、循环、switch、do-while 不回退到 5 秒级卡顿。
- 用户断点、临时断点清理恢复正确。
- Watch/Timeline 在 step 后继续正常工作。

**给其他 AI 的提示词**：
```text
请把 Ozone for VS Code 的 step over 核心逻辑迁移到 Native Debug Engine 状态机。先阅读 AGENTS.md、docs/debug-engine-refactor/overall-guidance.md、docs/debug-engine-refactor/tasks.md、任务 07 产生的 docs/debug-engine-refactor/native-scheduler-design.md、docs/bug-fix-log.md，以及 src/ozone-backend/commander.ts 的 doStepOver。要求保留旧 TypeScript 路径作为配置开关回退，新路径由 C++ 执行 stepOverSourceLine。不要破坏 Watch/Timeline 实时变量读取和写变量功能。必须记录每次 step 的分段耗时，并运行 npm run typecheck。
```

## 任务 09：迁移 step-into 和 step-out

**目标**：统一所有单步控制路径，避免 step-over 单独快而其他路径仍旧阻塞。

**产出**：
- `docs/debug-engine-refactor/step-into-out-native-migration-notes.md`。
- Native `stepIntoInstruction`。
- Native `stepOut` 或等价 return breakpoint 策略。
- TypeScript 层统一封装。

**验收标准**：
- step into 不误触发用户断点清理逻辑。
- step out 对当前函数范围、LR、栈状态有清晰失败处理。
- DAP stopped event 时序正常。

**给其他 AI 的提示词**：
```text
请把 Ozone for VS Code 的 step into 和 step out 迁移到 Native Debug Engine。先阅读 AGENTS.md、docs/debug-engine-refactor/overall-guidance.md、任务 08 产生的 docs/debug-engine-refactor/step-over-native-migration-notes.md、src/ozone-backend/commander.ts 的 doStepInto、doStepOut、doSingleStep，以及 src/debug/dap-session.ts 的 handleStep。要求与新的 step over 调度器共享同一状态机和 J-Link 访问队列。保留旧路径配置回退，记录耗时，不破坏变量实时读取和修改。
```

## 任务 10：保护实时变量读取和修改

**目标**：把实时变量能力作为重构不可破坏的核心能力。

**产出**：
- `docs/debug-engine-refactor/realtime-variable-protection.md`。
- Watch、Timeline、MCP/plugin API 变量读写路径梳理。
- step 与采样并发冲突测试。
- 写变量优先级和一致性规则。

**验收标准**：
- 运行态 Watch 能继续刷新。
- Timeline 高频采样能继续采集。
- `setWatchValue` 写变量不会被低优先级采样饿死。
- step 期间暂停采样不会导致 UI 长时间失联。

**给其他 AI 的提示词**：
```text
请专项验证并加固 Ozone for VS Code 的实时变量读取和修改功能。先阅读 AGENTS.md、docs/debug-engine-refactor/overall-guidance.md、任务 09 产生的 docs/debug-engine-refactor/step-into-out-native-migration-notes.md、src/session/data-sampling-manager.ts、src/debug-providers/watch-provider.ts、src/plugin-api/runtime-router.ts、src/ozone-backend/commander.ts 中 readFastDataSampling、prepareFastDataSampling、doSetWatchValue。目标是在 Native Debug Engine 调度器引入后，Watch、Timeline、MCP/plugin API 仍能实时读取变量，setWatchValue 仍能可靠修改变量。请输出冲突场景、优先级策略、必要代码修改和验证步骤。
```

## 任务 11：DAP 层去除固定等待

**目标**：减少 DAP 层人为延迟，把 stopped 状态交给 Native 结果驱动。

**产出**：
- `docs/debug-engine-refactor/dap-step-response-optimization.md`。
- `handleStep` 改造方案。
- stopped event 触发规则。
- 旧路径兼容策略。

**验收标准**：
- Native step 成功返回后不再固定等待 100ms。
- 旧 koffi 路径仍可使用保守轮询。
- VS Code 调试 UI 不丢 stopped event。

**给其他 AI 的提示词**：
```text
请优化 Ozone for VS Code 的 DAP step 响应路径。先阅读 AGENTS.md、docs/debug-engine-refactor/overall-guidance.md、任务 10 产生的 docs/debug-engine-refactor/realtime-variable-protection.md、src/debug/dap-session.ts 的 handleStep、pollTargetState、beginControl/endControl、readCancelEpoch 相关逻辑。目标是在 Native Debug Engine 路径中由 native step 结果直接驱动 stopped event，去除固定 100ms 等待和多余轮询；旧路径保留兼容轮询。不得破坏 VS Code 调试 UI、Watch/Timeline 恢复和变量视图刷新。
```

## 任务 12：建立重构验证矩阵

**目标**：用场景矩阵防止新状态机重复旧 bug。

**产出**：
- `docs/debug-engine-refactor/validation-matrix.md`。
- 测试工程或手工测试脚本说明。
- 场景矩阵：普通语句、函数调用、函数指针、循环、switch、do-while、宏、多语句同行、用户断点、RTOS 运行态、Watch/Timeline 并发。
- 性能目标。

**验收标准**：
- 每个历史 bug 都有对应验证项。
- 每个验证项包含期望 PC/源码行/耗时范围。
- 能比较旧路径和 Native 路径。

**给其他 AI 的提示词**：
```text
请为 Ozone for VS Code 的 Native Debug Engine 重构建立验证矩阵。先阅读 AGENTS.md、docs/debug-engine-refactor/overall-guidance.md、任务 11 产生的 docs/debug-engine-refactor/dap-step-response-optimization.md、docs/bug-fix-log.md。请列出所有必须覆盖的 step over/step into/step out、断点、变量实时读取、变量写入、Timeline 采样场景。每个场景要包含复现代码形态、操作步骤、期望停靠源码行或 PC、性能目标、失败时应查看的日志。只写文档，不改源码。
```

## 任务 13：分阶段发布和回退

**目标**：让重构可以逐步启用，避免一次性替换导致不可调试。

**产出**：
- `docs/debug-engine-refactor/rollout-and-fallback.md`。
- 配置开关设计。
- 新旧路径 fallback 策略。
- 日志和错误上报规范。

**验收标准**：
- 用户可切换旧 TypeScript/koffi 路径和 Native 路径。
- Native 初始化失败自动回退。
- 单个命令失败不会污染 J-Link 状态到不可恢复。

**给其他 AI 的提示词**：
```text
请为 Ozone for VS Code 的 Native Debug Engine 重构设计分阶段发布和回退方案。先阅读 AGENTS.md、docs/debug-engine-refactor/overall-guidance.md、任务 12 产生的 docs/debug-engine-refactor/validation-matrix.md、package.json 的 configuration、src/extension.ts、src/ozone-backend/commander.ts、src/ozone-backend/jlink-dll.ts。要求提供配置开关、新旧路径 fallback、Native 初始化失败处理、日志规范、用户可诊断错误信息。目标是安全灰度，不一次性删除旧路径。
```
