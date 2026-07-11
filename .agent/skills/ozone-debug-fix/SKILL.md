---
name: ozone-debug-fix
description: Fix any bug in the Ozone for VS Code extension. Load this skill before modifying code when the user reports a bug. Covers J-Link/DLL, DAP protocol, WebView, data sampling, RTT, symbol parsing, plugin API, and build issues.
---

# Ozone Debug Workflow

## ⚠️ 核心原则：先看日志和数据，再分析，最后改代码

**绝对禁止不分析直接改代码。** 所有 bug 必须在日志、DAP 追踪或源码中找到确凿证据后才能进行针对性修改。**严禁凭感觉乱猜瞎改**——Ozone 涉及 J-Link DLL 状态机、DAP 协议时序、DWARF 解析、多进程并发等多个复杂子系统，猜错一次可能引入更难排查的 bug 甚至烧坏目标板硬件。

**每次修改前必须：**
1. 从日志中定位到确凿的证据链（PC 值、地址、错误码、时序）***非常重要!!!!!***
2. 书面列出本次修改的**所有可能后果**（正面+负面），例如：
   - "这样改后，如果 CPU 正在运行中清除断点，会不会意外 halt？"
   - "增加这个分支检测后，会不会影响正常的 BL/BLX 调用步过？"
   - "修改路由后，没有活跃 DAP 会话时 Watch 还能更新吗？"
   - "加了这个限速后，高采样率场景会不会丢数据点？"
3. 只有所有负面后果都可接受或有应对措施，才能改代码

## 诊断入口

### 1. 阅读 Bug 修复日志

`docs/bug-fix-log.md` 记录了所有已修复 bug 的根因和修改方案。先排查是否与已知 bug 同类。

### 2. 确认日志源 (按需读取)

| 日志源 | 位置/方式 | 适用场景 |
|---|---|---|---|
| 步进/断点日志 | `outputs/Log/step.log` | 单步、逐过程、断点、temp BP |
| 变量求值/内存日志 | `outputs/Log/eval.log` | evaluate expression, read/write memory, DWARF |
| DLL 连接日志 | `outputs/Log/dll.log` | J-Link DLL open/close/connect/device/speed |
| DAP 会话日志 | `outputs/Log/dap.log` | 启动、polling、Watch、step 命令 |
| DAP stdio 追踪 | VS Code: `"ozone.trace": true` (输出到 Debug Console) | DAP 请求/响应不匹配 |
| 扩展宿主日志 | `"ozone.traceExtension": true` | 激活、Watch 轮询、数据采样异常 |
| 插件 API 日志 | `"ozone.tracePluginApi": true` | MCP / 外部工具 RPC 失败 |
| RTT 日志 | `outputs/Log/`下 RTT 输出文件 | RTT 无输出/乱码 |

### 3. 未找到日志时，增加追踪再复现

在怀疑的关键路径添加 `log.step()` / `log.eval()` / `log.dll()` / `log.dap()`（`src/utils/logger.ts`）或 `console.log`，重新复现后分析。

## Bug 大类诊断指南

### A. 步进/断点异常

见 `docs/bug-fix-log.md` 详细记录。典型根因：

| 现象 | 常见根因 |
|---|---|
| 逐过程卡死 ~5.7s | temp BP 设在执行不到的分支后方 → 分支指令检测 |
| 清除断点后 CPU halt 在随机地址 | `clearBreakpoint` 缺 `run()` 恢复 |
| 断点写入引发 HardFault | 地址解析返回 0x3E 等非法地址 → 缺范围校验 |
| 循环中逐过程跳回或卡死 | stale BP 判定、`findNextSourceLineAddress` 回扫 |

**关键代码**：
- `src/ozone-backend/commander.ts` — `doStepOver`, `doStepInto`, `doStepOut`, `doSetBreakpoint`, `doClearBreakpoint`, `resolveLineAddress`, `findNextSourceLineAddress`, `setTempBpAndRun`
- `src/ozone-backend/jlink-dll.ts` — `clearBreakpoint`, `clearAllBreakpoints`, `setBreakpoint`
- `src/ozone-backend/jlink-symbols.ts` — `resolveMappedStatementAddress`
- `src/debug/dap-session.ts` — `handleSetBreakpoints`, `handleContinue`, `handleStep`

### B. 连接/烧录失败

| 现象 | 排查方向 |
|---|---|
| DLL 加载失败 | `JLink_x64.dll` 路径：检查 `ozone.jlinkPath` / `ozone.jlinkDllPath` 设置 |
| 连接超时 | 设备型号、接口（SWD/JTAG）、速度（`defaultSpeed`）是否匹配目标板 |
| 烧录失败 | ELF 路径、`flash` 命令返回的 error 信息 |
| 重复 `JLINK_Open()` crash | `_wasOpened` 保护，`disconnect()` 不调 `JLINK_Close()` |

**关键代码**：`src/ozone-backend/jlink-dll.ts`, `src/ozone-backend/commander.ts`

### C. DAP 协议异常（VS Code 显示异常）

| 现象 | 排查方向 |
|---|---|
| 变量/寄存器不显示 | `variables` 请求返回格式、`variablesReference` 树结构 |
| 内存视图空白 | `initialize` 未声明 `supportsReadMemoryRequest: true`，或 `readMemory` 返回错误格式 |
| 断点标记不对 | `setBreakpoints` 返回的断点 ID/行号映射 |
| 堆栈帧不对 | `stackTrace` / `scopes` 返回格式 |
| Watch 值不更新 | `dataSample` 请求返回、`session.customRequest` 路由 |

**DAP 规格对照**：https://microsoft.github.io/debug-adapter-protocol/specification

**关键代码**：`src/debug/dap-session.ts`

### D. 数据采样 / Timeline 异常

| 现象 | 排查方向 |
|---|---|
| Timeline 无波形 | `dataSamplingStart` 返回、`DataSamplingManager` 采样循环（10ms 间隔, 50k 点上限） |
| 采样值异常 | `prepareFastDataSampling` / `readFastDataSampling` 的 OzoneCommand 实现 |
| 500ms Watch 轮询不更新 | Watch 定时器、`session.customRequest('dataSample')` 路由、`runtime-router.ts` |

**关键代码**：
- `src/session/data-sampling-manager.ts` — `DataSamplingManager`
- `src/debug-providers/watch-provider.ts` — `WatchProvider`, `readWatchValues`
- `src/plugin-api/runtime-router.ts` — 活跃会话 vs 本地后端路由

### E. RTT 日志异常

| 现象 | 排查方向 |
|---|---|
| 无 RTT 输出 | `startRtt` 配置、Control Block 地址、通道号 |
| 输出乱码 | 编码/缓冲问题，`readRtt` 实现 |
| RTT 导致卡死 | `JLINK_RTTERMINAL_Read` 阻塞，检查超时参数 |

**关键代码**：`src/debug/dap-session.ts`, `src/debug-providers/rtt-log-provider.ts`

### F. 符号/DWARF 解析异常

| 现象 | 排查方向 |
|---|---|
| 单步停在错误行 | 行号映射错误、`lineEntries` vs `lineMapCache` 不一致 |
| 变量显示 NO ACCESS | 地址超出 RAM 范围、变量已优化掉 |
| 找不到函数/符号 | ELF 路径、`arm-none-eabi-nm` / `objdump` 是否在 PATH |

**关键代码**：`src/ozone-backend/jlink-symbols.ts`

### G. 插件 API / MCP 异常

| 现象 | 排查方向 |
|---|---|
| MCP 工具报连接失败 | `plugin-api-endpoint.json` 是否存在、端口和 token 是否匹配 |
| RPC 请求返回 403 | Bearer token 认证失败 |
| 实验/波形记录异常 | `ExperimentService`, `WaveRecorder` 中的步骤执行 |

**关键代码**：`src/plugin-api/`

### H. WebView 异常

| 现象 | 排查方向 |
|---|---|
| Watch/Timeline 面板空白 | Browser Developer Tools (F1 → Developer: Toggle Developer Tools) 查看 Console 错误 |
| 样式混乱 | VS Code theme CSS 变量使用、codicon 引用 |
| WebView 通信失败 | `postMessage` / `onDidReceiveMessage` 格式不匹配 |

**关键代码**：`src/webview/`

### I. 并发/时序问题

`OzoneBackend` 是有状态单例，多个调用方可能并发操作 J-Link DLL：

- Watch 轮询（500ms）与用户调试操作冲突 → 使用 `beginControl`/`endControl` + `withStepLock` 同步
- 数据采样（10ms 循环）与步进冲突 → `readCancelEpoch` 机制
- `clearBreakpoint` halt → run 序列中被打断 → 检查 `_wasOpened` 和 `_haltCount`

**关键代码**：
- `src/ozone-backend/commander.ts` — `beginControl`, `endControl`, `withStepLock`
- `src/debug/dap-session.ts` — `beginTargetRead`, `endTargetRead`, `readCancelEpoch`

## 验证清单

修改后按问题类别验证：

- [ ] 步进类：有/无断点时逐过程不卡死、不回跳、不跳入函数
- [ ] 断点类：设/删断点不意外 halt CPU，非法地址报错
- [ ] 连接类：重复 connect/disconnect 不 crash
- [ ] DAP 类：VS Code 界面显示、变量、内存、堆栈均正常
- [ ] 采样类：Watch 和 Timeline 数据正确更新
- [ ] RTT 类：日志连续输出、不乱码、不卡死

## 修复确认与日志写入

**必须先获得用户明确同意才写入日志**（不允许 agent 自行决定）。用户确认修复后，按以下格式在 `docs/bug-fix-log.md` 顶部插入新记录（按时间倒序）：

```markdown
### Bug: <简短标题>

- **日期**: <YYYY-MM-DD>
- **问题描述**: <现象复现步骤>
- **根因分析**:
  1. <逐条列出根因>
- **修改方案**:
  1. <逐条列出修改>
- **涉及文件**:
  - `<文件路径>` — `<函数/关键行>`
- **验证结果**: <确认方法>
