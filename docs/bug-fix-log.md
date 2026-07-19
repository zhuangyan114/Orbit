# Bug 修复日志

## 修改规范

1. **每次修改前**, 先创建 Issue 或在顶部登记修改记录
2. **每个 Bug 一条记录**, 按时间倒序排列（最新的在最上面,）
3. **必须包含**: 问题描述、根因分析、修改方案、涉及文件及行号
4. **涉及步进相关逻辑时**, 修改后必须在目标板上验证至少一轮循环的"逐过程"功能
5. **硬件断点相关改动**（`jlink-dll.ts` / `handleSetBreakpoints` / `clearBreakpoint`）需额外注意并发竞争和状态同步
6. **必须用户明确同意后才能写入**（agent 不得自行决定写入）

## 修改记录

### Bug: 多行函数参数逐步调试边界异常及函数调用逐过程缓慢

- **日期**: 2026-07-18
- **问题描述**:
  1. 多行函数调用 `m = calcSum(count, count++);` 在参数跨行时，逐过程和单步进入会把同一条 C 语句拆成多个源代码范围，导致需要额外点击或停在异常位置。
  2. `sinf(count * 0.002f)` 等函数调用逐过程耗时明显，偶发停在调用返回地址并触发重试。
- **根因分析**:
  1. DWARF 行表会将同一条多行语句映射为 `256 → 257 → 256` 等多个源行；原实现只按当前物理行计算 Native source-step 边界，没有按完整逻辑语句合并。
  2. Native helper 通过返回地址临时硬件断点完成函数调用逐过程；命中返回地址后临时断点仍留在当前 PC，下一次 `JLINK_Step` 会重复命中同一断点，最终导致 `StepInstructionLimit` 和 DAP 重试。
- **修改方案**:
  1. `commander.ts` 增加源文件语句范围解析，识别括号/方括号、注释、字符串和行尾运算符，将跨行表达式合并为一个逻辑 source range；源文件不可用时保留原行范围回退。
  2. Native helper 在确认 PC 已到达返回地址后，只清理对应的临时返回断点，保留用户断点及其恢复状态。
  3. 增加多行调用的 Commander 回归测试和 Mock J-Link 临时返回断点清理测试。
- **涉及文件**:
  - `src/ozone-backend/commander.ts:1171`、`:1274` - 逻辑语句范围解析及 Native source-step 边界
  - `native/jlink-helper/src/main.cpp:926` - 返回地址临时断点命中后的清理
  - `native/jlink-helper/test/mock-jlink.cpp:85` - Mock 中复现当前断点重复命中
  - `src/ozone-backend/commander-native-stop.test.ts:74` - 多行函数调用范围回归
- **验证结果**:
  - **Mock/自动化**: Commander 测试 14/14、全量 Vitest 17 个文件/87 项测试、`npm run typecheck`、`npm run build:native`、`npm run test:cpp-channel:mock` 和 `npm run build` 全部通过。
  - **真实硬件**: 用户确认多行参数逐步调试已恢复正常；随后确认 `sinf` 逐过程由明显缓慢变为单次快速完成。

### Bug: 函数内逐过程返回调用者后仍停在调用行

- **日期**: 2026-07-18
- **问题描述**: 在 `m = calcSum(...)` 上单步进入 `calcSum` 后，从函数体内点击逐过程，光标只返回到 `m = calcSum(count,` 这一行，没有直接跳到下一句；单步跳出则可以正常到达下一句。
- **根因分析**:
  1. Native helper 从 `calcSum` 的当前源范围执行到函数返回地址 `0x8003d64`，这个地址在 DWARF 中仍映射到调用者的第 256 行，因此底层操作实际上已经返回调用者，但还没有完成调用语句。
  2. `commander.ts:1006` 原先只在执行前后仍属于同一文件、同一源行时才发起继续逐过程；从 `calcSum:221` 返回到调用者 `:256` 时被误判为一次完整成功，未继续执行调用者语句的剩余指令。
  3. 单步跳出拥有 `resolveStepOutSourceHint`，能将调用行返回地址调整到下一源语句；逐过程路径没有对应的跨函数返回续跑逻辑。
- **修改方案**:
  1. `doStepOver` 比较 `pcBefore` 和 `pcAfter` 所属的函数范围，识别是否发生了从被调用函数到调用者的函数边界切换。
  2. 当返回地址的前一条指令仍属于调用源行时，再按调用者的逻辑语句范围调用一次 Native `stepOverSourceLine`，直到到达下一条源语句。
  3. 抽取并复用返回地址源行判断逻辑，避免改变已有 StepOut hint、断点和 Native owner 路由。
  4. 增加从函数体返回调用语句后自动续跑的回归测试。
- **涉及文件**:
  - `src/ozone-backend/commander.ts:979`、`:1180` - 跨函数返回续跑及返回地址源行判断
  - `src/ozone-backend/commander-native-stop.test.ts:290` - 函数返回后逐过程回归测试
- **验证结果**:
  - **Mock/自动化**: 聚焦 Commander 测试 15/15、全量 Vitest 17 个文件/88 项测试、`npm run typecheck` 和 `npm run build` 全部通过；日志出现 `stepOver phase=continueAfterFunctionReturn`，最终 PC 已到下一源语句。
  - **真实硬件**: 目标板上的该 `calcSum` 场景仍需再确认一轮；在确认前不将本条记为硬件验收完成。

### Bug: 调试异常中断残留 J-Link 导致后续 Flash 超时，烧录线断开未退出调试

- **日期**: 2026-07-17
- **问题描述**:
  1. 调试或烧录过程中意外中断后，`JLink.exe` 可能继续占用探针；下一次启动调试时烧录 `frame.elf` 会等待 30 秒并报 `Flash failed: Flash timeout (30s)`。
  2. 拔掉 J-Link USB 后调试能够退出，但只拔掉目标板 SWD 烧录线时，VS Code 仅显示调试暂停，不会结束会话和清理相关进程。
- **根因分析**:
  1. 原烧录进程的超时和 DAP 会话清理没有共同管理真实的 `JLink.exe` 子进程；异常退出时可能只结束等待逻辑，未可靠终止占用探针的进程。
  2. 当前会话由 native helper 作为唯一物理 target owner。硬件日志显示，拔掉 SWD 烧录线时 J-Link DLL 仍会报告已连接，并把目标状态从 `Running` 变为 `Halted`；VTref 保持正常，普通内存读取还可能返回缓存数据，因此 `JLINK_IsConnected`、VTref、`JLINK_IsHalted` 和普通内存读取均不能单独证明 SWD 链路仍然有效。
  3. `JLINK_IsHalted()` 的负数通信错误曾被布尔判断误认为已暂停，使真实通信故障无法进入连接丢失清理路径。
- **修改方案**:
  1. 烧录改为直接启动并跟踪真实 `JLink.exe` 子进程；DAP 取消、超时或会话释放时终止该进程、移除活动记录并清理临时命令文件，避免探针被孤儿进程持续占用。
  2. DAP 会话增加连接健康轮询和幂等终止路径：明确断开立即退出；瞬时读取错误连续 3 次后再终止，统一取消烧录、释放 target owner、结束调试会话并清理 helper/子进程。
  3. Native helper 与 Legacy koffi owner 在连接成功后执行一次只读 SW-DP 基线探测；仅在 DLL/目标支持且基线成功时启用周期探测。后续 SW-DP 访问失败返回 `TargetStateReadFailed`，由现有三次失败规则结束会话，避免依赖 J-Link 的缓存状态。
  4. 将 `JLINK_IsHalted()` 负返回值作为通信错误传播；保持单会话单 owner、NativeScheduler 串行访问和既有 Watch/Timeline 路由不变。
- **涉及文件**:
  - `src/ozone-backend/flasher.ts` - `flashElf`、`cancelActiveFlashes`：真实烧录子进程跟踪、超时/取消终止及临时文件清理
  - `src/ozone-backend/commander.ts` - `cancelFlash`、会话 owner 释放：统一清理入口
  - `src/debug/dap-session.ts` - 连接健康轮询、连续失败判定、`terminateForConnectionLoss` 与幂等会话清理
  - `src/debug/ozone-debug-adapter.ts`、`src/debugadapter.ts` - DAP 退出/断开时等待异步资源释放
  - `src/ozone-backend/session-target-channel.ts` - Legacy owner 的断开、SW-DP 和目标状态错误传播
  - `src/ozone-backend/jlink-dll.ts` - `JLINK_IsConnected`、VTref、`JLINK_IsHalted` 返回值及 SW-DP 健康探测
  - `native/jlink-helper/src/main.cpp` - Native owner 的连接状态、VTref、SW-DP 探测、错误诊断和 disconnect 清理
  - `native/jlink-helper/test/mock-jlink.cpp`、`native/jlink-helper/test/mock-jlink.def`、`scripts/cpp-channel-smoke.js` - 断线和 SW-DP 失败的 Mock 协议回归
  - `src/ozone-backend/flasher.test.ts`、`src/ozone-backend/session-target-disconnect.test.ts`、`src/debug/dap-session-connection-loss.test.ts` - 烧录取消、状态识别和会话终止单元测试
- **验证结果**:
  - **Mock/自动化**: `npm run typecheck`、`npm run build`、`npm run build:native`、`npm run test:cpp-channel:mock` 全部通过；全量 Vitest 为 17 个测试文件、85 项测试全部通过。
  - **真实硬件**: 用户于 2026-07-17 确认拔掉 J-Link USB 会正常退出调试，拔掉目标板 SWD 烧录线也会正常退出，后续烧录持续正常，未再出现 30 秒 Flash timeout。

### Bug: Watch 一键添加 Timeline 后列表延迟刷新且勾选状态重置

- **日期**: 2026-07-15
- **问题描述**: 从 Watch 点击发送键添加变量后，Timeline 不会立即显示新变量，必须先删除一个 Timeline 变量才会刷新；刷新发生后，之前未勾选的变量又全部恢复为勾选状态。
- **根因分析**:
  1. Watch 的 `sendToTimeline` 路径只向 `DataSamplingManager` 添加表达式并打开 Timeline，没有通知已存在的 Timeline webview 刷新条目列表；Timeline 内部删除操作会发送 `entries` 消息，因此新变量表现为删除其他变量后才出现。
  2. Timeline 前端处理 `entries` 消息时用默认 `enabled: true` 重建全部条目，只保留已有纵轴状态，没有保留已有条目的 `enabled`，导致每次列表刷新都重新勾选所有变量。
- **修改方案**:
  1. 在采样表达式变更回调中调用 Timeline provider 的公开 `refreshEntries()`，使 Watch 发送、命令添加及其他表达式变更都能立即同步到已打开的 Timeline。
  2. 提取 Timeline 条目创建与刷新合并逻辑；列表刷新时应用新增/删除和颜色变化，同时保留已有条目的勾选状态、纵轴缩放模式、每格量程及中心值，新条目则采用 provider 给出的初始状态。
  3. 增加聚焦单元测试，覆盖新增条目状态以及刷新时保留未勾选和纵轴状态的回归场景。
- **涉及文件**:
  - `src/extension.ts` - `DataSamplingManager.onExpressionsChanged` Timeline 即时刷新
  - `src/webview/timeline/timeline-provider.ts` - `TimelineWebviewProvider.refreshEntries`
  - `src/webview/timeline/app.tsx` - `init`/`entries` 消息状态合并
  - `src/webview/timeline/timeline-entry-state.ts` - `createTimelineEntry`、`mergeTimelineEntryRefresh`
  - `src/webview/timeline/timeline-entry-state.test.ts` - Timeline 条目刷新状态回归测试
- **验证结果**: `npm run typecheck`、`npm run build`、`npm test`（14 个测试文件、70 项）和相关文件 `git diff --check` 通过；用户已确认 Watch 添加变量后 Timeline 立即显示，删除变量后未勾选状态保持不变。该修复不涉及 target 访问或硬件控制路径，无需真实硬件专项验收。

### Bug: 大型 Watch 批次导致 Timeline 周期性卡顿

- **日期**: 2026-07-15
- **问题描述**: 调试会话中存在多个大型结构体/指针 Watch 时，Timeline 波形会周期性停顿；相比此前问题已有改善，但仍表现为明显的“一卡一卡”。
- **根因分析**:
  1. 日志确认当前 native owner 会话每轮 Watch 包含 `ins_data`、`down_yaw`、`chassis`、`dr16`、`up_yaw` 5 个顶层对象，最近 100 轮平均约 681.96 ms 启动一轮；扣除 500 ms 轮询间隔后，整批实际占用 target-read 约 182 ms。
  2. 4 个顶层对象为指针类型。后台轮询无论节点是否展开，都会读取指向结构体并递归构建内部结构、数组和指针 children，`up_yaw` 与 `chassis` 分别平均占用约 77.3 ms 和 74.7 ms。
  3. DAP 原先为整批 Watch 持有高优先级 target-read 锁，全部表达式完成后才释放；Timeline 在该周期性临界区内只能跳过采样机会。
- **修改方案**:
  1. 自定义 Watch `dataSample` 携带已展开表达式集合；折叠的结构体、数组和指针只返回可展开元数据，不再读取或序列化 children，展开状态变化后立即按需刷新。
  2. 嵌套结构和指针只沿用户明确展开的完整表达式路径继续求值，标准 DAP `evaluate`/`variables` 的 eager 行为保持不变。
  3. Watch 批次按最多 2 个表达式或约 8 ms 分片；每片结束后释放 DAP target-read 并让出事件循环，使 Timeline 能在片间恢复低优先级采样。重叠的后台 Watch 请求继续使用缓存，避免堆积。
  4. 增加 `[watch] batch expressions=... expanded=... elapsedMs=...` 时序日志，用于后续硬件压力观察；未实施风险较高且当前收益不足的 Watch 批量内存读取重构。
- **涉及文件**:
  - `src/debug/dap-session.ts` - Watch 分片读取、target-read 片间让出和批次时序日志
  - `src/ozone-backend/commander.ts` - 展开路径驱动的结构体/数组/指针 children 懒求值
  - `src/ozone-backend/types.ts` - Watch 可展开元数据与展开路径命令参数
  - `src/debug-providers/watch-webview-provider.ts` - 展开状态传递及按需刷新
  - `src/extension.ts` - Watch 轮询携带展开路径
  - `src/webview/watch/app.tsx` - 无预加载 children 时仍显示展开控件
  - `src/debug/dap-session-realtime-variables.test.ts` - Watch 分片与 Timeline 片间读取回归
  - `src/ozone-backend/commander-realtime-variables.test.ts` - 折叠、精确展开及嵌套指针懒加载回归
- **验证结果**: `npm run typecheck`、`npm run build`、`npm test`（13 个文件、68 项）和相关文件 `git diff --check` 通过。用户已在当前真实硬件调试会话中确认 Timeline 流畅度大幅增加，Watch 未发现回归问题。

### Bug: Watch/Timeline 结构体变量读取、写入与颜色状态异常

- **日期**: 2026-07-13
- **问题描述**:
  1. Watch 添加指针变量 `down_yaw` 后，同批变量无法正常刷新；运行中编辑 PID 浮点子项时，`0.1` 被写成 `0`、`1.5` 被写成 `1`。
  2. Timeline 无法采样 `ins_data.yaw`、`down_yaw.target_position` 及 `down_yaw.message.out_velocity` 等结构体字段；指针根对象的嵌套结构体字段没有数据。
  3. Timeline 修改曲线颜色后会立即恢复旧颜色，重新打开视图后采样颜色与显示状态不一致。
- **根因分析**:
  1. 指针 Watch 将未完成的 `evaluatePointerChildren()` Promise 写入 `WatchValue.children`，破坏 DAP/Webview 数据合约。
  2. 快速采样仅解析顶层标量和数组元素，不能计算结构体字段偏移，也不能先读取指针再读取指向对象中的字段。
  3. 实际侧栏 Watch bundle (`src/webview/watch/app.tsx`) 使用 `parseInt` 解析十进制输入并截取显示值的整数部分；子项写入路径也需要携带地址和类型，后端才可按浮点格式编码。
  4. Timeline provider 在 `setColor` 后用工作区状态中保存的旧颜色刷新条目，覆盖内存中的新颜色。
- **修改方案**:
  1. 等待指针子节点读取完成，保证 `children` 为数组或 `undefined`。
  2. 快速采样支持结构体标量字段、全局指针字段和内嵌结构体字段；指针字段按“先批读指针，再批读累计偏移后的字段”执行，保持 `timeline` 优先级和单一 session owner。
  3. Watch 输入改为严格的十进制/科学计数法/十六进制解析，保留显示值的小数部分，并将子项地址和类型传至 DAP；后端按 DWARF/类型名编码 `float` 与 `double`。
  4. Timeline 颜色变更同时更新采样管理器与工作区状态；初始化时将保存颜色恢复至采样管理器。
- **涉及文件**:
  - `src/ozone-backend/commander.ts` - 指针 Watch 子节点、快速采样字段解析/读取和浮点写入
  - `src/ozone-backend/types.ts` - `FastDataSampleSpec` 指针字段描述
  - `src/ozone-backend/commander-realtime-variables.test.ts` - 指针、嵌套字段和浮点写入回归
  - `src/webview/watch/app.tsx` - 实际 Watch bundle 的浮点输入提交
  - `src/webview/app.tsx` - 主 Webview Watch 输入同步
  - `src/webview/watch-value-input.ts` - Watch 数值提取与解析
  - `src/webview/watch-value-input.test.ts` - 小数、科学计数法和十六进制输入回归
  - `src/webview/timeline/timeline-provider.ts` - Timeline 颜色持久化与恢复
- **验证结果**: `npm run typecheck`、`npm run build`、`npm test`（13 个文件、63 项）和 `git diff --check` 通过。用户已在真实硬件会话中确认上述 Watch/Timeline 读取、结构体浮点子项写入和 Timeline 颜色修改均已修复。

### Bug: Timeline 起始飞线及跨调试会话追踪抖动

- **日期**: 2026-07-12
- **问题描述**: Timeline 波形左侧会额外连出一根终点落在画布中部的长直线；开启自动追踪后该线持续跳动。退出调试再进入时，上一会话尾段还会连接到新会话首段，并在追踪窗口移动期间抖动。
- **根因分析**:
  1. 可见窗口二分查找有意保留一个窗口外前驱点，但像素列抽取仍将该点按负 `x` 计算列并首次 `flushColumn()`，Canvas 因而先执行窗口外 `moveTo`，再向首个可见列执行 `lineTo`。
  2. 10 分钟历史在 DAP 会话结束后继续保留；新 DAP 会话的首批样本直接追加到旧尾点之后，缺少曲线段边界。auto-follow 持续移动 `tStart` 时，绘制器会沿这条跨会话长线反复计算不同的左边界交点，表现为连线抖动。
- **修改方案**:
  1. 提取可测试的 Timeline 路径构建器；窗口外前驱点只用于线性计算 `x=plotLeft` 的边界交点，不再作为负像素列参与 min/max 聚合或 `flushColumn()`。
  2. 每个 DAP 会话为每个表达式的首个有效样本添加一次 `startsNewSegment` 标记；Canvas 遇到该标记后重新 `moveTo`，保留旧历史和真实采样点，但不再跨调试会话连线。
  3. 保持同一会话内连续曲线、同列 min/max 聚合、10 分钟历史、Halted 逻辑时钟、rAF 批处理，以及 `control > watch > timeline` 调度不变。
- **涉及文件**:
  - `src/debug/dap-session.ts` - 新 DAP 会话首样本的曲线段标记
  - `src/ozone-backend/types.ts` - `DataPoint.startsNewSegment`
  - `src/webview/timeline/app.tsx` - Canvas 路径命令接入
  - `src/webview/timeline/timeline-sample-buffer.ts` - Timeline 点类型与历史追加
  - `src/webview/timeline/timeline-trace-path.ts` - 左边界插值、像素列聚合和跨会话子路径
  - `src/debug/dap-session-realtime-variables.test.ts` - 首样本段标记回归
  - `src/webview/timeline/timeline-trace-path.test.ts` - 前驱点、auto-follow、历史裁剪、同列聚合及跨会话路径命令回归
- **验证结果**: `npm run typecheck`、`npm run build`、`npm test`（11 个文件，57 项）和 `git diff --check` 通过。用户已在退出并重新进入 Ozone 调试会话后确认 Timeline 起始飞线与自动追踪抖动均已消失，旧历史保留且当前波形持续正常更新。

### Bug: Timeline 周期性卡顿及暂停恢复后补出平线

- **日期**: 2026-07-12
- **问题描述**: Timeline 同时显示 `count`、`aww` 等变量时，左侧数值和整段波形会周期性停住，随后一次补出一截；target Halted 后虽然画面停住，但恢复运行时会补出跨越暂停时长的平线。
- **根因分析**:
  1. DAP `beginWatchTargetRead(250)` 将 Watch 等待上限错误地保留为 Timeline 的固定低优先级禁入期。Watch 实际完成后 Timeline 仍被屏蔽约 250 ms，日志对应 `maxSampleGapMs=253..266`、`maxFlushGapMs=238..281`。
  2. Timeline 采样与 UI 发送原本绑定在同一高频循环，且 webview 每批样本复制历史数组并重绘完整可见序列，造成消息、React 更新和 Canvas 绘制节拍不均。
  3. Halted 时停止读 target 后，恢复样本仍使用绝对墙钟时间戳；Canvas 会连接暂停前最后一点和恢复后第一点，因此显示跨越暂停区间的伪平线。
- **修改方案**:
  1. 仅在 Watch 请求实际排队期间保持 `watch > timeline`，Watch 完成或超时后立即恢复 Timeline；保留 `control > watch > timeline` 和控制操作排他。
  2. 将采样与发送解耦，按独立发送定时器批量 flush；webview 按 animation frame 合并消息、原地追加有界历史、复用 Canvas backing store，并按可见窗口和像素列抽取绘制点。
  3. target Halted 后不再访问 target、丢弃停止竞态中的在途结果，也不新增点；采样时间戳改用扣除累计 Halted 时长的逻辑时钟，Continue 成功后从最后采样时间继续。
- **涉及文件**:
  - `src/debug/dap-session.ts` - Watch/Timeline 读仲裁、采样 flush、target 状态与逻辑采样时钟
  - `src/debug/dap-session-realtime-variables.test.ts` - Halted、恢复、flush、Watch 优先级与暂停时钟回归
  - `src/webview/timeline/app.tsx` - rAF 更新、可见窗口缩放与 Canvas 抽取绘制
  - `src/webview/timeline/timeline-sample-buffer.ts` - UI 帧批处理和点保留
  - `src/webview/timeline/timeline-sample-buffer.test.ts` - 多消息单帧合并与 50,000 点保留回归
- **验证结果**: `npm run typecheck`、`npm run build`、`npm test`（10 个文件，50 项）和 `git diff --check` 通过。修复后 Native 活动会话日志为 `mode=auto owner=native`，稳定达到约 392..415 次批读/秒、56..60 次非空 flush/秒，周期性约 250 ms 空窗消失；用户已在连接真实目标的 VS Code Timeline 中确认波形连续、Halted 后停止且恢复时不再补出平线。

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
