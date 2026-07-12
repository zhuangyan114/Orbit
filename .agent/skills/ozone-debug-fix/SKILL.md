---
name: ozone-debug-fix
description: 诊断、修复或验收 Ozone for VS Code 缺陷。当用户报告 Ozone 调试器、DAP、J-Link/DLL、Native helper、调度器、采样、Watch/Timeline、变量、路由、RTT、符号/DWARF 或调试状态机问题时使用。
---

# Ozone 调试修复流程

## 强制门禁

1. 在修改任何内容前对请求分类：**仅诊断**、**修复**或**验收/验证**。仅诊断不授权修改代码或日志。
2. 阅读仓库 `AGENTS.md`，再运行 `git status --short`。保留所有既有改动。
3. 阅读相关的最小设计文档集合与 `docs/bug-fix-log.md`。以当前源码和测试为架构事实来源；历史文档和日志只能作为证据，不能用于恢复已废弃路径。
4. 在诊断前判定 target owner 与请求路由：native helper 或 legacy koffi；DAP 会话或 extension-host backend。在证据链中记录该判定。
5. 修复前先建立证据：日志、DAP trace、mock trace 或最小复现。适用时捕获 PC/地址、目标状态、操作顺序/时序、错误码或 DLL 返回码。
6. 列出预期收益、可能回归与回退方案。实施最小且有证据支撑的修复。禁止推测性重构。

## 硬性禁止项

- 不得在同一调试会话中创建第二个 J-Link owner，或从两条路径访问 DLL。
- 不得通过 `JLINK_Close()`/open 切换 owner。必须先完整释放 native helper，再构造 legacy；保留 selector 的受控 fallback 行为。
- 不得绕过活动的 `ozone` DAP 会话。`RuntimeRouter` 失败必须仍是错误，不能回落到 extension-host backend。
- 不得手动修改 `dist/`、将 mock 验证称为硬件验证，或未经授权执行会改变 target 状态的命令。
- 不得通过牺牲 Watch、Timeline、`evaluate`、`variables`、变量写入、RTT 或兼容 viewer 的 DAP 行为来修复 step。
- 不得自动写入 `docs/bug-fix-log.md`。等待用户明确确认后，才将条目插入 `## 修改记录` 下的首位。

## 最小阅读与证据

先阅读以上共享前置内容，再只选择报告问题所需的行。仅在日志能提供证据时读取对应日志；若不能，先增加范围严格受限的分类日志，再复现。

| 问题 | 最小代码/设计文档阅读 | 主要证据 |
|---|---|---|
| Step、continue、breakpoint | `commander.ts`、`dap-session.ts`、`session-target-channel.ts`、`step-into-out-native-migration-notes.md`、`dap-step-response-optimization.md` | `outputs/Log/step.log`、`dap.log`、DAP trace |
| Native owner 或 scheduler | `session-target-channel.ts`、`cpp-jlink-channel.ts`、`native-scheduler.ts`、`native-debug-engine-api.md`、`native-scheduler-design.md` | `dll.log`、`dap.log`、helper 协议/错误码 |
| DAP 或 UI 协议 | `dap-session.ts`、`ozone-debug-adapter.ts`、相关 provider/webview、`dap-step-response-optimization.md` | DAP trace、`dap.log`、浏览器控制台 |
| Watch、Timeline、变量写入 | `dap-session.ts`、`commander.ts`、`data-sampling-manager.ts`、`watch-webview-provider.ts`、`realtime-variable-protection.md` | `eval.log`、`dap.log`、操作时序 |
| RuntimeRouter 或 MCP | `runtime-router.ts`、`plugin-api-server.ts`、`extension.ts` | RPC 响应、`dap.log`、endpoint/auth 证据 |
| 符号或 DWARF | `jlink-symbols.ts`、`commander.ts` | `eval.log`、ELF/工具输出、解析地址 |
| RTT | `dap-session.ts`、已选 owner channel、RTT provider | `dll.log`、`dap.log`、RTT 配置/输出 |

所有权、调用方、路由与影响分析优先使用 CodeGraph。文档、配置、日志和字面错误字符串使用直接 read/search。

## Owner 与路由判定

在修改代码前记录以下事实：

- 是否选择 `nativeDebugEngine`，且 helper 是否连接成功？若是，helper 是唯一物理 J-Link owner；所有已选 owner 调用都经由它和 `NativeScheduler`。
- owner 是否为 legacy？native source-level step API 必须报告不可用，不得通过第二个 owner 模拟。
- native 启动是否失败，或是否报告 `NativeOwnerLost`？仅在此时，`SessionTargetSelector` 才可释放 native、重建 legacy 并恢复已跟踪的 breakpoint slot。
- 是否有活动的 `ozone` DAP 会话？若是，UI、plugin API 和 MCP 的 target 操作必须使用 DAP custom request；请求失败后不得回落到 extension-host backend。

## 修复规则

- 使用 `.data` 前，检查每个 `OzoneCommandResult.ok`。
- 保持 NativeScheduler 的串行与优先级：`control > watch > timeline`。step/control/变量写入的临界区必须排除并发的 watch/timeline 读取；排队的后台读取可被取消或合并，并必须在 control 工作结束后恢复。
- 对 source step，保持 source-level `stepInto`、有效的 `stepOut` source hint、step-out 后第一次 step 不得视觉空步、用户/临时 breakpoint 生命周期，以及 native PC/state 对过期状态的优先级。
- 保持 DAP viewer 合约：base64 字节内存访问、`memoryReference`、可展开变量、`evaluate` 与 `deviceName`/`svdFile`/`svdPath` 别名。
- 修改 native capability 或 result field 时，保持 C++ helper 协议、TypeScript channel 类型、mock 测试和 owner 选择一致。

## 分层验证

分别报告每一层。任一层通过均不代表后续层通过。

1. **代码审查：**检查路由、owner、结果检查、清理/错误路径和不利后果。
2. **Mock/单元测试：**按需运行聚焦 Vitest 和 `npm run test:cpp-channel:mock`。明确标注 mock DLL 结果仅为 mock 验证。
3. **自动化构建/类型检查：**运行最小相关命令；当影响面需要时再扩大检查范围。
4. **真实硬件：**仅在明确授权后执行。记录板卡、probe、DLL 版本、配置、复现路径、PC/state 证据和观察结果。

没有第 4 层证据时，不得声称“硬件通过”。若硬件不可用，必须明确将其列为剩余验收缺口。

## 用户确认与历史记录

修复后，先展示验证结果，并在修改 `docs/bug-fix-log.md` 前请求用户明确确认。确认后，将下列紧凑条目作为 `## 修改记录` 下的首项插入：

```markdown
### Bug: <简短标题>

- **日期**: <YYYY-MM-DD>
- **问题描述**: <复现和观察行为>
- **根因分析**: <有证据支撑的原因>
- **修改方案**: <最小修复>
- **涉及文件**: `<path>` - `<symbol>`
- **验证结果**: <分别列出 mock/自动化/硬件状态>
```

## 最终报告

使用以下简短格式：

```text
结论: <诊断、已修复或验证结果>
证据: <路由/owner，以及 PC、状态、时序、错误码、trace 或测试>
风险/缺口: <已考虑的回归与未验证层>
建议下一步: <最小有用后续动作>
需要真实硬件验收: <是/否；原因>
```
