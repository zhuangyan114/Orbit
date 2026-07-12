# 实时变量读写保护

## 目标与结论

实时变量是 Native Debug Engine 重构的合并门槛。本任务把 Watch、Timeline、MCP/plugin API 的活动调试会话统一收口到 DAP 进程，并在 DAP 中建立控制操作与采样操作的排他栅栏。

当前规则保证：

- 运行态 Watch 请求在 step 期间立即返回最近缓存或 `running` 占位，不等待整个 step；
- Timeline 在控制操作期间暂停目标访问，每 10 ms 让出事件循环，控制结束后自动继续；
- `setWatchValue` 与 step 使用同一个串行控制锁，且在等待当前采样排空后执行；
- 活动 `ozone` 会话存在时，DAP 请求失败不会回退到扩展宿主的第二个 `OzoneBackend`；
- 写入前先发送已捕获的旧 Timeline 批次，写成功后清除对应 Watch 缓存。

## 证据与基线

2026-07-12 的 `outputs/Log/dap.log` 显示连续 step 的后端耗时约为 177–1388 ms，完整停止通知约为 280–1602 ms。同期 `outputs/Log/eval.log` 中 `cnt` 和 `huart1` 仍有周期 evaluate。这个时序说明 UI 读取不能同步等待 step 结束，同时 step 必须先排空已经开始的目标读取，不能只禁止后续读取。

任务 09 已使三种 Native step 进入 `NativeScheduler` 的 control queue，并在 step scope 内暂停 timeline queue；但 DAP 的 legacy/表达式采样仍需要自己的目标访问栅栏，否则 Native step 与已经开始的 `readFastDataSampling` 仍可能重叠。

## 读写路径

### Watch

```text
Watch webview / 500 ms extension poll
  -> activeDebugSession.customRequest("dataSample")
  -> DapSession.handleDataSample
  -> readWatchExpressions(forceRuntimeRead=true)
  -> OzoneBackend.evaluateExpression(force=true)
  -> J-Link memory/register access
  -> DAP response -> Watch UI
```

无活动 `ozone` 会话时，扩展宿主才允许直接调用本地 `OzoneBackend`。活动会话中的 DAP 失败会作为逐表达式错误返回，不允许绕过 DAP 调度器。

### Timeline

```text
Timeline UI
  -> DataSamplingManager.startRemoteSampling
  -> customRequest("dataSamplingStart")
  -> OzoneBackend.prepareFastDataSampling
  -> DapSession.dataSamplingLoop
  -> captureFastDataSample
  -> OzoneBackend.readFastDataSampling
  -> ozoneDataSamples event
  -> DataSamplingManager.acceptRemoteSamples
  -> Timeline UI
```

`prepareFastDataSampling` 负责把表达式解析为固定地址、宽度和格式；高频循环只按 plan 批量读取，不重复做 DWARF 解析。循环每轮最多占用 4 ms/512 次，控制操作期间不访问目标，并以 10 ms 让出周期避免 `setImmediate` 空转影响 DAP/UI。

### MCP/plugin API

```text
MCP client
  -> localhost Bearer RPC
  -> PluginApiServer.dispatch
  -> RuntimeRouter.readSignals / writeMany
  -> activeDebugSession.customRequest("dataSample" / "setWatchValue")
  -> DapSession
  -> OzoneBackend
```

读信号与 Watch 共用同一读栅栏；写信号与 Watch 编辑共用同一写栅栏。无活动调试会话时，RuntimeRouter 才使用扩展宿主后端。

### 写变量

```text
Watch edit / RuntimeRouter.writeMany
  -> customRequest("setWatchValue")
  -> withStepLock
  -> beginTargetControl (禁止新读并等待在途读排空)
  -> flushDataSampling (发布写前样本)
  -> OzoneBackend.doSetWatchValue
  -> halt if running -> write bytes -> resume if previously running
  -> invalidate Watch cache
  -> DAP write response
  -> resume Timeline/Watch reads
```

## 优先级规则

优先级从高到低为：

1. **Control**：halt、step、continue、reset、断点修改、`setWatchValue` 和其他写操作。
2. **Watch**：Watch 面板、MCP 主动读取、用户 evaluate。
3. **Timeline**：可丢弃或合并的高频采样。

`NativeScheduler` 使用 `control > watch > timeline` 队列。DAP 的对应规则是：控制操作先设置 `controlInProgress`，使新读立即返回缓存；随后等待唯一的 `targetReadInProgress` 结束。写变量还占用 `withStepLock`，因此不会和 step 并发，也不会被持续产生的低优先级采样饿死。

已开始的单次原生/J-Link 调用不做中途抢占。优先级在调用边界生效，这避免在 DLL 状态变更一半时强行取消。

## 一致性规则

- 活动调试会话是唯一运行时路由所有者；不得在 DAP 失败后访问扩展宿主后端。
- 一个时刻最多有一个 DAP 目标读或写；step 必须等待已开始的读完成，最长等待 1200 ms，超时返回 `Target busy`。
- step 期间 Watch/MCP 读不悬挂，返回最近缓存；没有缓存时返回带 `running` 状态的占位值。
- `setWatchValue` 的成功响应表示后端写操作已完成，且目标已恢复到写前的 running/halted 意图。
- 写响应之前先发送写前已捕获的 Timeline 点；响应之后不会再发送滞留的写前批次。
- 写成功后删除对应 Watch 缓存。下一次成功读取建立新的缓存值，不用旧值伪造写后确认。
- Timeline 允许在 step/写入窗口丢失采样点，不补造时间戳；恢复后的点保持单调时间顺序。
- 控制作用域的暂停令牌和 DAP 标志必须在成功、失败、超时路径释放。

## 冲突场景与处理

| 场景 | 旧风险 | 当前处理 |
|---|---|---|
| Timeline 已在读，用户发起 step | step 与 J-Link 读重叠 | 禁止新读并等待当前读结束后再 step |
| step 执行中 Watch/MCP 读取 | 请求等待 0.2–2 s，UI 失联 | 立即返回缓存或 `running` 占位 |
| 0.2 ms Timeline 持续采样，用户写变量 | 写请求长期抢不到目标 | 写进入 control/step lock，新采样立即停止 |
| 两个写请求同时到达 | 两次 halt/write/run 交错 | `withStepLock` 串行执行 |
| 写前 Timeline 批次尚未发送 | 写响应后 UI 又显示旧当前值 | 写前 flush，随后写入并失效缓存 |
| 活动 DAP 请求失败 | 扩展宿主后端绕过调度访问同一目标 | 返回路由错误，不做本地回退 |
| step 暂停高频循环 | `setImmediate` 空转占用事件循环 | 每 10 ms 让出，控制结束后自动恢复 |

## 代码改动

- `src/debug/dap-session.ts`
  - 新增 `beginTargetControl`，step/写入先排空在途读取；
  - `setWatchValue` 纳入 `withStepLock`；
  - 写入前 flush Timeline，成功后清 Watch 缓存；
  - 控制期间 Timeline 以 10 ms 周期让出事件循环。
- `src/extension.ts`、`src/debug-providers/watch-webview-provider.ts`
  - 活动 DAP 会话失败时不回退扩展宿主后端。
- `src/debug-providers/data-sampling-manager.ts`
  - 活动 DAP 会话的远程采样失败时不启动本地并行采样。
- `src/plugin-api/runtime-router.ts`
  - 活动会话读失败返回逐信号错误，不绕开 DAP；写路径原本已保持该规则。
- `src/debug/dap-session-realtime-variables.test.ts`
  - 覆盖采样与 step、采样与写变量冲突，以及 step 期间缓存响应。
- `src/ozone-backend/native-scheduler.test.ts`
  - 覆盖持续 Timeline 队列不能饿死 `setWatchValue` control task。

## 自动验证

2026-07-12 执行结果：

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm run build` | 通过，5 个 bundle 完成 |
| `npm test` | 通过，5 个文件、17 项测试通过 |
| `npx vitest run src/debug/dap-session-realtime-variables.test.ts src/ozone-backend/native-scheduler.test.ts` | 2 个文件、9 项测试通过 |

专项测试验证：

1. 已开始的 Timeline 读完成前，step 和写变量都不会进入后端。
2. 写请求等待期间不能启动新 Timeline 读；写完成后采样可继续。
3. step 执行期间 `dataSample` 立即获得缓存/`running` 响应。
4. step 完成后发送成功 response 和 stopped event。
5. 32 个排队 Timeline task 之前，`setWatchValue` control task 先执行。
6. 写前 Timeline event 的发送顺序早于 `setWatchValue` 成功响应。

## 真实目标板验收步骤

自动测试不能替代真实 J-Link/MCU 验证。合并默认 Native 路径前执行：

1. 让计数变量持续变化，启动 `ozone` 会话并保持 target running；确认 Watch 至少连续刷新 30 秒。
2. 将同一变量加入 Timeline，使用项目配置的高频采样间隔采集 30 秒；确认持续收到数据且时间戳单调。
3. Timeline 采样期间连续调用 20 次 `setWatchValue`；每次请求应在有限时间内返回，写后 Watch 应读到新值或目标代码随后产生的新值，不得一直停留在写前缓存。
4. 在 Timeline 和 Watch 同时工作时分别执行 step into、step over、step out 各 20 次；step 期间 UI 可短暂显示缓存，不能长时间无响应。
5. 每次 step 完成后确认 Timeline 自动继续产生新点，无需停止并重新启动采样。
6. 通过 MCP `read_signals`/写信号接口重复步骤 1–3，确认活动会话始终走 DAP。
7. 检查 `outputs/Log/dap.log`、`eval.log`、`step.log`：不得出现 step 与变量写入同时进入后端、持续 `Target busy` 或采样永久停止。

真实目标板、不同 J-Link DLL 版本及目标固件负载下的 30 秒/20 次压力验证尚未在本任务环境声明通过。

## 真实硬件并发压力验证（2026-07-12）

### 环境

- 测试工程：`D:\STM32\project\vet6_led`
- ELF：`D:\STM32\project\vet6_led\build\Debug\vet6_led.elf`
- MCU：STM32F407VE
- 接口：SWD 4000 kHz
- J-Link DLL：`C:\Program Files\SEGGER\JLink_V956\JLink_x64.dll`，日志版本 `v117.112`
- 运行变量：`count`（任务中每约 1 ms 自增）、`uwTick`
- 写入变量：`count`；测试后按经过时间恢复到接近自然计数轨迹

### 自动化检查

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm run build` | 通过，5 个 bundle 完成 |
| `npm test` | 通过，5 个文件、17 项测试通过 |
| `npx vitest run src/debug/dap-session-realtime-variables.test.ts src/ozone-backend/native-scheduler.test.ts` | 通过，2 个文件、9 项测试通过 |

### 硬件结果

| 场景 | 操作次数 | 通过/失败 | 最大耗时 | 平均体感/实测耗时 | 异常日志 | 备注 |
|---|---:|---|---:|---:|---|---|
| 运行态 Watch/MCP 读取 | 60 次/约 30 秒 | 通过 | 35 ms | 10.15 ms | 无 | `uwTick` 147652 -> 178161，60/60 成功且严格递增 |
| 高频同步记录 | 1058 帧/30.007 秒 | 通过 | 最大帧间隙 234 ms | 平均帧间隔 28.37 ms | 0 错误帧 | `count`、`uwTick` 和时间戳均单调，记录未永久停止 |
| Timeline 等价记录期间写 `count` | 20 次 | 通过（有短暂降级） | 94 ms | 82.8 ms | 2 次立即读回为 `running` | 20/20 写请求成功；18 次立即确认，2 次为允许的短暂占位；并发记录 508 帧、0 错误、最大间隙 43 ms |
| step over | 53 次 | 通过 | 1492 ms | 524.62 ms | 无失败、无 `Target busy` | 53/53 第一次尝试成功并发送 stopped；超过要求的 20 次 |
| step into | 3 次 | 覆盖不足 | 431 ms | 360.33 ms | 无失败 | 3/3 成功，但未达到要求的 20 次 |
| step out | 2 次 | 覆盖不足 | 377 ms | 299 ms | 无失败 | 2/2 成功，但未达到要求的 20 次 |
| step 后 Watch 恢复 | 58 次 step 后 | 通过 | 最大读取空档 5021 ms | 平均日志读取间隔 1546.37 ms | 无永久停止 | 最后 step stopped 后约 2.16 秒仍有 `count` evaluate 日志 |
| MCP/plugin API 路由 | 多轮 read/write/record | 通过 | 见上 | 见上 | 2 次 DAP 返回 `running`，未出现本地后端读值 | 活动会话请求走 `dataSample`/`setWatchValue`；未观察到绕过 DAP 的成功读取 |
| J-Link owner | 1 个会话 | 通过 | 不适用 | 不适用 | 单轮 `JLINK_Open`/`JLINK_Connect` | 未发现 `ozone-jlink-helper` 第二 owner；本轮 Native step 未启用 |

### Step PC 与源码证据

58 个 profile 均保存了 PC before/after。完整明细在 `outputs/Log/dap.log` 与 `outputs/Log/step.log` 的 `stepProfile#1..58` 中。代表记录：

| Profile | 类型 | PC before | PC after | 停止位置 | DAP 总耗时 |
|---:|---|---|---|---|---:|
| 1 | stepOver | `0x08003A34` | `0x08003A3A` | `Core/Src/freertos.c:147` | 499 ms |
| 25 | stepInto | `0x08003B18` | `0x08003C58` | `calcSum` 内部地址 | 431 ms |
| 26 | stepOut | `0x08003C58` | `0x08003B24` | 返回 `StartDefaultTask` | 221 ms |
| 31 | stepInto | `0x08003B3C` | `0x08003CB4` | `calcRecursive` 内部地址 | 379 ms |
| 39 | stepInto | `0x08003B4A` | `0x08002F82` | `osDelay`/CMSIS-RTOS 路径 | 271 ms |
| 42 | stepOut | `0x08002F8E` | `0x08003B50` | 返回 `StartDefaultTask` | 377 ms |
| 44 | stepOver | `0x08003B5A` | `0x08003B94` | `Core/Src/freertos.c:196` | 1492 ms |
| 58 | stepOver | `0x08003C18` | `0x08003C34` | `Core/Src/freertos.c:212` | 873 ms |

日志顺序示例：

```text
06:45:43.933 handleStep: stepOut pcBefore=0x8002f8e
06:45:44.149 handleStep: stepOut attempt 1 result=true
06:45:44.149 stepOut response sent
06:45:44.149 stepOut DAP stopped event ... sinceStart=377ms
```

```text
06:46:05.529 handleStep: stepOver pcBefore=0x8003c18
06:46:06.198 handleStep: stepOver attempt 1 result=true
06:46:06.198 stepOver DAP stopped event ... sinceStart=873ms
06:46:08.359 doEvaluateExpression: varTypeOffset for "count" = 0xf6db
```

### 中断与异常说明

第一轮 30 秒记录期间测试者重启了 debug session。该轮出现 467 个错误通道和 `uwTick` 回零，日志同时显示新的 `Launch`、DLL 加载与 connect；它属于人工重启中断，不计入稳定会话结果。

step 压力前启动的 plugin recorder 也因随后重新启动会话而丢失 recording ID，因此无法用同一波形证明全部 58 次 step 期间 Timeline 连续。重启后的日志证明 Watch evaluate 在 step 间恢复；较早的稳定记录包含 2 次 step-over 且保持 0 错误，但不能替代规定的完整 20/20/20 覆盖。

写 `cnt` 后经常立即读回 6，不是缓存不一致：测试固件在 `Core/Src/freertos.c:189` 每轮执行 `cnt = calcRecursive(3)`。因此正式写入验证改用持续自增的 `count`，以写后值位于写入值到写入值 + 1000 为确认窗口。

### 未通过项与补测要求

当前没有发现需要立即修改代码的确定性并发缺陷。未完成的是验证覆盖：

1. 在不重启 DAP/extension host 的单个会话内重新启动 waveform recording。
2. 保持 Watch、Timeline 和 recording 活跃，精确执行 step into 20 次、step over 20 次、step out 20 次。
3. 结束后确认 recording ID 仍有效、时间戳单调、错误帧有限且最后一次 step 后继续产生新帧。
4. 若再次出现持续 `running` 或 `Target busy`，优先检查 `controlInProgress` 是否释放、`targetReadInProgress` 是否残留、`readCancelEpoch` 是否在控制结束后推进，以及 `dataSamplingLoop` 是否重新调度。
5. 若 write 成功但稳定变量长期保持旧值，检查 `setWatchValue` 写屏障、RuntimeRouter 的 DAP response 处理和 runtime Watch cache 失效；本轮只有瞬时 `running`，没有复现长期旧缓存。

### 最终判定

**任务 10 部分通过，但尚未通过完整真实硬件并发压力验证。**

已通过 Watch/MCP 30 秒实时读取、高频记录、20 次写变量优先级、53 次 step-over、3 次 step-into、2 次 step-out、Watch 恢复和单 owner 检查。由于 step-into/step-out 未达到各 20 次，且完整 step 序列缺少同一会话内的 Timeline recording 证据，不能给出最终通过结论。

### 补充 step 会话（2026-07-12 14:50）

测试者完成第二轮 UI step 后，日志记录到一个新的、独立的 debug session：

| 类型 | 本轮次数 | 成功 | 平均 DAP 总耗时 | 最大 DAP 总耗时 |
|---|---:|---:|---:|---:|
| step into | 6 | 6 | 423.5 ms | 714 ms |
| step over | 14 | 14 | 603 ms | 1728 ms |
| step out | 6 | 6 | 261.83 ms | 335 ms |

本轮 26/26 都在第一次尝试成功并发送 stopped event；`Target busy` 为 0。`eval.log` 保存了 65 次 `count` evaluate，最后一条为 `06:51:59.055`；`dll.log` 仍只有一轮 `JLINK_Open OK` 和 `JLINK_Connect OK`。

两轮累计实际覆盖：

| 类型 | 累计次数 | 累计成功 |
|---|---:|---:|
| step into | 9 | 9 |
| step over | 67 | 67 |
| step out | 8 | 8 |

补充会话没有启动新的 plugin waveform recorder，且结束后 target 状态为 `disconnected`。因此它增加了真实 step 覆盖，但仍不能补足 step-into/step-out 各 20 次，也不能提供同一会话内完整 Timeline 连续性证据。最终判定仍为“部分通过”。

### Timeline 全程开启的补充会话（2026-07-12 14:54）

测试者确认本轮调试期间 Timeline 面板全程开启。日志记录到 31 个完整 step profile：

| 类型 | 本轮次数 | 成功 | 平均 DAP 总耗时 | 最大 DAP 总耗时 |
|---|---:|---:|---:|---:|
| step into | 8 | 8 | 340.88 ms | 447 ms |
| step over | 16 | 16 | 491.12 ms | 1533 ms |
| step out | 7 | 7 | 271.57 ms | 323 ms |

本轮 31/31 第一次尝试成功并发送 stopped event，`Target busy` 为 0。最后一次 step-out 在 `06:55:54.152` 发送 stopped；`count` 的 Watch/evaluate 日志持续到 `06:56:03.158`，表明控制操作结束后 UI 读取自动恢复。`dll.log` 仍只有一轮 `JLINK_Open OK` 和 `JLINK_Connect OK`。

本轮没有独立 plugin recorder，因此 Timeline 连续性来自测试者对面板全程开启的人工观察，不等同于可离线计算帧间隙的 waveform 证据。结合此前 30 秒、1058 帧、0 错误的自动记录，可以确认 Timeline 基线与 step 后 UI 恢复，但不能计算本轮每个 step 周围的具体丢点数。

三轮累计实际覆盖更新为：

| 类型 | 累计次数 | 累计成功 | 距离 20 次门槛 |
|---|---:|---:|---:|
| step into | 17 | 17 | 3 |
| step over | 83 | 83 | 已超过 |
| step out | 15 | 15 | 5 |

最终判定仍为“部分通过”：并发行为没有发现失败，但 step-into 和 step-out 的累计数量仍未达到各 20 次。
