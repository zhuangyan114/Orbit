# 插件运行开销优化建议

本文档记录当前代码中仍可优化的运行开销点。内容只描述位置、现象、影响和建议方案，不包含代码修改。

在修改前一定要先弄明白当时为什么这样写,粗暴修改可能出现什么问题,避免修改导致更多的问题,切记切记

有可能部分问题已修复但未标记

## 背景

RTOS View 修复后，插件出现整体卡顿，典型表现包括：

- 打断点响应变慢。
- 继续运行、单步、暂停等调试操作延迟增加。
- RTOS Views、Watch、Timeline 等功能可能同时访问 J-Link/DAP，互相抢占后端调用。

已经处理过的主要问题包括：

- 默认关闭 RTOS Views 自动 focus/refresh。
- 移除首次 continue 前的 3 秒固定等待。
- 降低 DAP/RTOS 高频诊断日志输出。
- 对运行态 watch/hover/evaluate 增加短缓存，减少重复读目标内存。

下面是进一步建议优化的地方。

## 1. Watch 轮询存在两套 200ms 刷新

位置：

- `src/extension.ts:265`
- `src/webview/app.tsx:477`

现象：

- 扩展侧 `startWatchPolling()` 每 200ms 读取一次 Watch 表达式。
- Webview 侧也有 `setInterval(..., 200)`，每 200ms 向扩展发送 `evaluateWatches`。
- 如果两边同时工作，会形成重复刷新。

影响：

- Watch 表达式越多，J-Link 读内存次数越多。
- RTOS Views、断点设置、单步等操作会和 Watch 刷新竞争后端调用。
- 运行态刷新尤其容易造成“打断点很久才响应”的体感。

建议方案：

- 统一轮询来源，只保留一套调度。
- 推荐由 DAP/session 侧统一管理 Watch 刷新，Webview 只负责订阅表达式和显示结果。
- 根据视图可见性启停轮询：Watch 面板不可见时停止或降频。
- 默认刷新间隔从 200ms 调整为 500-1000ms，用户需要高速刷新时再手动配置。
- 暂停态可以实时刷新，运行态应降频或使用缓存。

优先级：高。

## 2. Timeline 默认采样间隔过激进

位置：

- `package.json:353`
- `src/debug/dap-session.ts:1180`
- `src/debug-providers/data-sampling-manager.ts:195`

现象：

 - `orbit.timelineSampleIntervalMs` 默认值是 `0.2` ms，目标采样率约 5 kHz。
- DAP 侧 `dataSamplingLoop()` 每次事件循环最多使用约 4ms，并且单轮最多采样 512 次。
- Timeline 一旦启用表达式采样，就可能持续占用后端读内存能力。

影响：

- 高速采样会明显占用 Node 事件循环和 J-Link 调用。
- 如果 Timeline、Watch、RTOS Views 同时运行，容易造成整体调试响应变慢。
- 默认 5 kHz 对多数调试场景过高，不适合作为默认行为。

建议方案：

- 将默认采样间隔调整为更保守的 5-20ms。
- 保留高速采样能力，但改为用户显式开启，例如“High speed mode”或配置项。
- 当 VS Code 调试操作正在进行时，例如 setBreakpoints、continue、step、pause，Timeline 采样应临时退避。
- Timeline 面板不可见时停止采样或只保留低频后台采样。
- 对表达式数量设置上限提示，表达式越多，默认采样间隔应自动变大。

优先级：高。

## 3. Continue 后固定等待 300ms 再开始轮询

位置：

- `src/debug/dap-session.ts:867`

现象：

- `handleContinue()` 执行 `run` 后固定等待 300ms，然后才调用 `startPolling()`。

影响：

- 如果目标很快命中断点，DAP 层最多会晚 300ms 才开始检测 halted 状态。
- 用户体感上会觉得 continue、断点命中响应慢。

建议方案：

- 将固定 300ms 改为更短的初始延迟，例如 30-50ms。
- 或者立即发送 `continued` 后启动低频 polling，再根据是否有 Watch/RTOS/Timeline 订阅动态调整频率。
- 如果没有任何 Watch 表达式或外部视图订阅，可以只做断点命中检测，不做额外表达式读取。

优先级：高。

## 4. 单步路径存在高频轮询和主动 halt

位置：

- `src/debug/dap-session.ts:903`
- `src/debug/dap-session.ts:944`
- `src/ozone-backend/commander.ts:447`
- `src/ozone-backend/commander.ts:565`

现象：

- `handleStep()` 在 step 后会先等待 100ms。
- 随后最多循环 200 次，每 10ms 调用一次 `getTargetState`。
- 轮询超过一定次数后，还会中途调用 `halt` 做“soft settle”。
- 后端 `doStepInto()`、`doStepOut()` 也有额外的 sleep、寄存器读取、内存读取和临时断点逻辑。

影响：

- 最坏情况下单步路径可等待约 2 秒。
- 高频 `getTargetState` 会持续调用 J-Link `isHalted`。
- 中途主动 `halt` 可能干扰正常运行，尤其在复杂 step-over/step-out 场景下。

建议方案：

- 将 step 完成等待逻辑集中到后端，DAP 层不再重复轮询。
- 将 10ms 高频轮询改为退避式轮询，例如 10ms、20ms、50ms、100ms。
- 只有明确超时恢复时才调用 `halt`，不要在正常等待过程中周期性 halt。
- 对 stepInto 的“智能单步”路径设置更清晰的上限，并在失败时快速 fallback。

优先级：高。

## 5. 读寄存器固定等待 100ms

位置：

- `src/ozone-backend/commander.ts:285`

现象：

- `doReadRegister()` 在确认 halted 后仍固定等待 100ms，然后才读取寄存器。

影响：

- `continue` 前读取 PC、step 前读取 PC、stackTrace 相关路径都会受到影响。
- 这是常规调试热路径上的固定延迟。

建议方案：

- 只有刚刚执行过 halt、reset、step 后才需要 settle。
- 如果当前状态已经 halted，优先直接读取寄存器。
- 如果第一次读取失败，再做短延迟重试，例如 10-20ms。
- 可以引入 `lastHaltAt` 或 `needsSettleUntil` 标记，避免每次读寄存器都等待。

优先级：中高。

## 6. Webview fallback evaluate 会主动 halt 目标

位置：

- `src/webview/webview-provider.ts:150`
- `src/webview/webview-provider.ts:187`

现象：

- 当没有 active ozone DAP session 时，`evaluateWatches()` 会调用 `ensureHalted()`。
- `ensureHalted()` 如果发现目标未 halt，会执行 halt，等待 100ms，读完后再 run。

影响：

- Watch 刷新可能打断目标正常运行。
- 如果 Webview 轮询仍然存在，这会周期性 halt/run 目标，开销和行为风险都很高。

建议方案：

- 运行态不要为了 Watch 刷新自动 halt。
- 如果目标正在运行，返回缓存值或 `Running` 状态。
- 只有用户主动点击“暂停后刷新”或执行明确命令时才 halt。
- 优先通过 DAP `watchEvaluate` 或 `dataSample` 路径读取，避免 Webview provider 直接控制目标运行状态。

优先级：中高。

## 7. RTT 默认 50ms 轮询且默认开启

位置：

- `package.json:183`
- `package.json:193`
- `src/debug/dap-session.ts:300`

现象：

- `rttLogEnabled` 默认是 `true`。
- `rttPollIntervalMs` 默认是 50ms。
- RTT polling 会持续调用 `readRtt`。

影响：

- RTT 空闲时也会持续占用后端调用。
- 在 RTT 输出量低或没有 RTT 的场景下，这部分开销没有收益。
- 如果用户同时使用 RTOS Views、Watch、Timeline，RTT 轮询会增加竞争。

建议方案：

- 保留默认开启也可以，但增加空闲退避。
- 连续多次空读后，将轮询间隔退避到 200-500ms。
- 一旦读到数据，再恢复到配置的快速间隔。
- 如果 `startRtt` 多次失败，可暂停一段时间再重试，避免持续失败重试。

优先级：中。

## 8. J-Link 连接和断点设置仍有直接 console.log

位置：

- `src/ozone-backend/jlink-dll.ts:75`
- `src/ozone-backend/commander.ts:229`

现象：

- J-Link 连接流程中有多处 `console.log`。
- 设置断点时也有 `console.log`。

影响：

- 单次开销不大，但频繁断点操作时会产生额外 I/O。
- 日志输出会污染调试适配器输出，排查性能问题时不够可控。

建议方案：

- 改为统一 logger。
- 默认静默。
- 只有开启调试配置时输出，例如 `ozone.debugLogging`。

优先级：中。

## 9. 插件在 VS Code 启动后立即激活

位置：

- `package.json:31`
- `src/extension.ts:106`

现象：

- activationEvents 包含 `onStartupFinished`。
- 激活后会创建 backend、watch provider、timeline provider、plugin API server，并写入 MCU debug views tracking 配置。

影响：

- 即使用户本次没有使用 Orbit，也会在 VS Code 启动后加载插件逻辑。
- 插件启动时还可能做配置更新和 ELF 自动检测。

建议方案：

- 移除或减少 `onStartupFinished`。
- 改成按需激活：打开 Orbit view、执行 Orbit 命令、启动 ozone debug session 时激活。
- Plugin API server 可以延迟到首次需要 API 或调试会话开始时启动。
- MCU debug views tracking 配置不应每次启动都检查/写入，可改成显式命令或首次启用后记录状态。

优先级：中。

## 10. 启动时自动扫描 ELF 并写 workspace 配置

位置：

- `src/extension.ts:122`
- `src/extension.ts:129`

现象：

- 插件激活时如果 `defaultProgram` 不存在，会扫描 workspace 下的 ELF/AXF 并写入配置。

影响：

- 大 workspace 中扫描可能比较慢。
- 激活时写 workspace 配置会触发 VS Code 配置变更事件。
- 与“插件启动即激活”叠加后，会增加非调试场景开销。

建议方案：

- 只在用户执行 `ozone.debug` 或打开设置页时扫描。
- 扫描结果缓存，并设置最大扫描深度或忽略目录。
- 避免激活阶段自动写 workspace 配置，改成用户确认后写入。

优先级：中。

## 11. Timeline Webview 状态保存可能过于频繁

位置：

- `src/webview/timeline/app.tsx:330`
- `src/webview/timeline/timeline-provider.ts:94`

现象：

- Timeline entries、timePerDiv、autoFollow 变化时会向扩展发送 `saveState`。
- 扩展收到后立即 `workspaceState.update`。

影响：

- 拖动、缩放、频繁切换时可能产生较多状态写入。
- 不是主要卡顿源，但会增加 UI 操作期间的异步写入。

建议方案：

- 对 `saveState` 做 debounce，例如 300-1000ms。
- 拖动过程中只更新内存状态，鼠标释放或停止操作后保存。

优先级：低到中。

## 12. Timeline Canvas 鼠标移动时每次都二分查找并 setState

位置：

- `src/webview/timeline/app.tsx:443`
- `src/webview/timeline/app.tsx:455`
- `src/webview/timeline/app.tsx:489`

现象：

- 鼠标移动时会对每条 active 曲线做二分查找。
- 同时调用 `setMousePos` 和 `setHoverVals`。
- 拖动画布时还会频繁 `setRenderTick`。

影响：

- 数据量大、曲线多时 UI thread 负担较高。
- 对调试后端影响较小，但会影响 VS Code UI 流畅度。

建议方案：

- 鼠标移动处理用 `requestAnimationFrame` 节流。
- 拖动过程中只更新 ref，在 animation frame 里统一 setState。
- 对 hover 查询结果做轻量缓存，避免同一像素位置重复计算。

优先级：低到中。

## 13. Plugin API 录波可能绕过全局采样限流

位置：

- `src/plugin-api/wave-recorder.ts:106`
- `src/plugin-api/runtime-router.ts:29`

现象：

- `WaveRecorder` 按自己的 interval 调用 `runtime.readSignals()`。
- `RuntimeRouter.readSignals()` 优先走 active DAP session 的 `dataSample`，失败后直接 `evaluateExpression(force: true)`。

影响：

- 如果外部插件/脚本启动录波，同时 Timeline 也在采样，会形成多路采样。
- 多路采样都会访问同一个后端/J-Link。

建议方案：

- 建立全局采样调度器，将 Timeline、WaveRecorder、Watch 运行态采样合并。
- 相同表达式在短时间窗口内复用结果。
- 给 Plugin API 录波增加全局预算限制，例如最小 interval、最大通道数、最大并发录波数量。

优先级：中。

## 建议实施顺序

第一阶段，优先降低常规调试路径开销：

1. 合并 Watch 轮询，只保留一套调度。
2. 降低 Timeline 默认采样频率，并增加视图不可见时的暂停/降频。
3. 将 continue 后 300ms 固定等待改成自适应 polling。
4. 移除 `doReadRegister()` 的无条件 100ms 等待。

第二阶段，优化复杂调试操作：

1. 重构 step 完成检测，减少 10ms 高频 polling。
2. 优化 stepInto/stepOut 的固定 sleep 和 fallback 策略。
3. 避免 Webview fallback evaluate 自动 halt/run 目标。

第三阶段，优化后台和 UI 开销：

1. RTT 空闲退避。
2. Plugin API / Timeline / Watch 采样合并。
3. Timeline 状态保存 debounce。
4. 日志统一走可配置 logger。

## 总体原则

- 默认行为应优先保证调试操作响应速度。
- 运行态读取目标变量必须限频、缓存或用户显式启用。
- 暂停态可以提供完整实时信息，运行态应减少干扰目标。
- 所有高频功能都应具备视图可见性判断和退避策略。
- J-Link/DAP 调用应由统一调度器串行化或限流，避免多个功能同时抢占。

## 本次针对断点延迟和 RTOS Runtime 异常的处理记录

现象：

- 前几次断点、继续、RTOS Views 刷新都正常。
- 多测试几轮后，断点命中明显变慢，甚至点击继续运行也长时间无响应。
- Watch 变量已经停止更新，但编辑器光标过一会儿才跳到断点位置。
- RTOS Runtime 百分比再次出现异常，例如超过 100% 或 `NaN%`。

判断：

- RTOS Views 刷新会通过 DAP 连续发送大量 `evaluate`、`variables`、`readMemory` 请求。
- 这些请求读取 FreeRTOS 链表、TCB 字段、栈内存和 runtime counter，单轮刷新开销不小。
- 如果停止后 RTOS Views 抢先展开变量，VS Code 的 `stackTrace` 请求会被后端读取挤占，于是出现“目标已经停住，但光标很晚才定位”的现象。
- 如果点击 Continue 时上一轮 RTOS/Watch/Timeline 读取仍在进行，控制命令会和这些读取竞争 J-Link/DAP 后端，造成继续和断点设置延迟。
- RTOS Runtime 异常很可能来自非一致快照：`ulTotalRunTime` 和各任务 `ulRunTimeCounter` 不是同一时刻读到的，或者刷新过程中目标已经继续运行，导致分母/分子混合了不同时间点的数据。

已处理位置：

- `src/debug/dap-session.ts`

已处理方案：

- 增加 `controlInProgress`、`targetRunning`、`readCancelEpoch`、`targetReadInProgress` 状态。
- `setBreakpoints`、`continue`、`step`、`pause`、`restart`、`disconnect` 进入控制命令时，立即标记控制中并取消旧读取。
- 运行态或控制命令进行中，`evaluate`、`watchEvaluate`、`dataSample` 返回缓存值或 `running`，不再直接访问后端。
- 运行态或控制命令进行中，`variables` 返回空列表，`readMemory` 返回不可读，避免 RTOS Views 继续展开旧变量树。
- 停止事件发出后，给低优先级读取设置约 150ms 让路窗口，优先让 `stackTrace`、locals、registers 完成，减少光标定位延迟。
- 停止后 Watch 自动刷新延后约 150ms，避免刚停住时抢在 VS Code 光标定位前访问后端。
- 高速 Timeline 采样读取也走统一读锁；如果控制命令或其它读正在进行，本轮采样直接跳过。

预期效果：

- RTOS Views 打开时，断点、继续、暂停、单步等控制命令优先级高于 RTOS/Watch/Timeline 数据刷新。
- RTOS Views 某一轮刷新可能显示缓存或短暂为空，但不会把控制命令拖住。
- 断点命中后应先让 VS Code 完成光标定位，再进行 RTOS/Watch 刷新。
- Runtime 百分比异常的概率会降低，因为继续运行期间旧刷新会被取消或返回缓存，不再继续读取混合快照。

仍需观察：

- 如果 `ulTotalRunTime` 本身在 FreeRTOS 工程中更新不稳定，仍可能出现 Runtime 统计异常，需要从目标工程的 `configGENERATE_RUN_TIME_STATS`、`portCONFIGURE_TIMER_FOR_RUN_TIME_STATS`、`portGET_RUN_TIME_COUNTER_VALUE` 继续排查。
- 当前处理是“让 RTOS/Watch 让路”，不是完整的 RTOS 原子快照。后续更稳的方案是为 RTOS Views 提供专门的批量快照接口，一次性读取 `ulTotalRunTime` 和所有任务 counter。
- `handleStep()` 仍有 10ms 高频 polling 和中途主动 `halt`，这部分之前已经列为高优先级后续优化项。
