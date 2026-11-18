# RTOS 阶段进度与交接

## 0.1 / 2026-11-18

- 状态：已完成，阶段 0 离线基线。
- 实现：建立 compatibility.md、validation.md、protocol.md 和本记录；固定版本、环境与验证方法。
- 设计变更：按用户确认的实施方案，阶段 0 以离线交付验收；原 0.1 实板对照测量移至 1.4，三种模式实板验证保留在 4.4。首版硬件门槛没有取消。
- 检查：类型检查与构建通过；全量 Vitest 98 文件，1328 项通过、1 项跳过；首次 worker 参数冲突及修正详见 validation.md。文档链接、差异与提交边界检查通过。
- 硬件：未执行；不连接 RMLink，不创建目标 owner，不烧录、不控制运行、不进行 RTT 指针/控制写入。
- 证据：validation.md、compatibility.md；本地 out/rtos-stage0/baseline-vitest.txt。
- 剩余事项：0.2 冻结契约及协议依据；0.3 交付可重建工程和独立样本。实板数据留待对应阶段补齐。
- 提交：建立 RTOS 阶段 0.1：冻结离线验证矩阵与基线；hash 用 git log 查询本记录所在提交。

## 0.2 / 2026-11-18

- 状态：已完成，契约与协议依据已冻结；不是运行时功能实现。
- 实现：protocol.md 定义身份、字段可用性、一致性、错误/capability、Trace 状态、缺口及三种模式目标路径。
- 设计变更：无。所选 3.32 满缓冲进入丢包路径，Single-Shot 用应用显式 Stop 冻结，不依赖未证明的自动停止。
- 检查：核对固定目标源码、RTT 结构、FreeRTOS trace 宏和官方手册；文档结构、链接及差异检查通过。此部分仅文档，不重复执行构建。
- 硬件：未执行。
- 证据：protocol.md 来源表；缺失官方源码 commit、独立 API 描述文件和 SVDat 互操作证据均已登记。
- 剩余事项：0.3 将固定源码、配置、manifest、独立样本纳入仓库并实际重建；接口实现仍按后续阶段执行。
- 提交：定义 RTOS 阶段 0.2：统一数据契约与协议依据；hash 用 git log 查询本记录所在提交。

## 0.3 / 2026-11-18

- 状态：已完成，阶段 0 离线出口通过。
- 实现：scripts/rtos/fixtures 含固定依赖、CMake/GCC 工程、11 个 ELF 变体、三种模式的 5 份原始样本、独立手工 oracle、重建脚本及负向检查；构建产物在 out/。
- 设计变更：无需 HAL 外设即可构成最小内核工程，复用 CMSIS system/startup 和链接内存布局。所选 3.32 的 Post-Mortem 固定通道初始化缺项通过官方自动分配配置解决，不修改 vendor。
- 检查：63 个依赖 hash、目标配置/符号/DWARF、字段关闭及优先级尺寸差异通过；5 份样本重建一致；7 项校验器测试通过；隔离源码和空输出目录重建通过。两次构建 11 个可加载镜像一致、5 份原始流一致；Debug ELF hash 差异分别登记。
- 硬件：未执行；没有连接服务/探针访问、烧录、目标控制、RAM 或 RTT 指针写入。主机样本仅操作本进程 RTT 内存。
- 证据：fixture README、vendor-manifest.json、samples/、offline-evidence.json、validation.md；原始日志/ELF/符号输出见 out/rtos-stage0/。
- 剩余事项：阶段 1.1 检测/布局编译尚未开始。实板任务、IRQ、栈、统计、吞吐和控制响应按 1.4/3.4/4.4 补验；SVDat、独立 API 描述文件等缺口仍见 protocol.md。
- 提交：补充 RTOS 阶段 0.3：建立可重建工程与独立样本；hash 用 git log 查询本记录所在提交。

## 1.1 / 2026-11-18

- 状态：布局编译与离线验证通过；阶段 1 的实板出口继续在 1.4 验收。
- 实现：src/rtos/freertos-layout.ts 从 ELF 全局变量的实际 DWARF 类型编译 TCB/List 读计划，沿用 jlink-symbols.ts 类型图；按 ELF 内容 hash 缓存，保留 DIE 身份，不按类型名称取首项，不硬编码字段偏移。
- 设计变更：无；版本号无法从类型图证明时保持不可用。
- 检查：类型检查通过；12 项布局测试通过，含固定工程的 8 个 ELF 变体（无 DWARF 正确拒绝），以及同名类型、成员损坏、可选字段关闭、缓存身份。
- 硬件：仅发现设备/会话；二号机 Wi-Fi 在线，无活动目标 owner，尚未读写目标。
- 剩余事项：1.2 任务读取、1.3 栈/统计、1.4 DAP 调度及实板验收。
- 提交：实现 RTOS 阶段 1.1：增加 FreeRTOS 识别与布局缓存；hash 用 git log 查询本记录所在提交。

## 1.2 / 2026-11-18

- 状态：任务解析与离线异常检查通过；实板出口归 1.4。
- 实现：src/rtos/snapshot-reader.ts 分轮读取内核锚点、链表节点和 TCB，合并临近地址；每次传输最多 256 bytes，整次限制字节、批次、节点和时间。验证前后锚点、双向链接、owner/container、尾节点、计数及覆盖列表；pending-ready 不重复计作任务。
- 设计变更：无。终止、无限期等待和挂起分别保留列表证据；运行态锚点一致仍只算 best effort。
- 检查：类型检查通过；11 项任务读取测试通过，含空表、40 节点深链、循环、重复、非法地址、短读、预算、变化与取消；布局 12 项继续通过。
- 硬件：尚未执行目标操作。
- 剩余事项：1.3 栈/计数器；1.4 会话与控制代次隔离、实板对照。
- 提交：实现 RTOS 阶段 1.2：完成任务链表与快照解析；hash 用 git log 查询本记录所在提交。

## 1.3 / 2026-11-18

- 状态：栈与运行统计模块检查通过；实板出口归 1.4。
- 实现：src/rtos/task-metrics.ts 按明确 port 契约计算栈容量，按任务请求分片扫描填充值；返回未用栈字节、水位扫描范围/耗时/完整性。运行统计基于任务累计计数和内核 ulTotalRunTime 差分，保留位宽、来源、睡眠与 ISR 记账口径。
- 设计变更：CPU 型号和 DWARF 不能证明栈填充值或计数器频率，必须提供有来源的 port 契约；缺条件的列保持不可用。计数差分使用可证明的频率上界区分回绕与重置，不推断多次回绕。
- 检查：6 项统计测试、11 项任务读取测试通过；覆盖已知填充区、首帧、统计/边界缺失、扫描预算、零区间、回绕/复位、地址复用和会话/控制代次改变。类型检查通过。
- 硬件：尚未执行目标操作。
- 剩余事项：1.4 接入、实板基线与出口检查。
- 提交：实现 RTOS 阶段 1.3：增加栈水位与任务运行统计；hash 用 git log 查询本记录所在提交。

## 1.4 / 2026-11-18

- 状态：已完成，阶段 1.1～1.4 出口通过；阶段 2 尚未开始。
- 实现：src/rtos/snapshot-service.ts 与 DAP 内部 orbitRtosSnapshot 提供能力、单次/Live、状态、合并和取消；会话、boot/control、刷新取消代次围住每个异步边界。所有读复用已选 owner，不为了快照 halt。RMLink 内存通道补齐 priority/signal；标准 writeMemory 补控制屏障。
- 设计变更：无线高频任务链表变化时返回 partial，保留重新读取、独立验证的 TCB 字段，不沿用旧值。地址提示只减少发现成本。CPU 差分保留采集窗口与已结算/ISR/睡眠口径。实测后将 RMLink 后台片收紧为单段 128 bytes；冻结门槛保持不变。性能构建之后只修正取消错误 completion=unknown，并以 SHA256 校验其余性能路径字节一致。
- 检查：类型检查、扩展及原生构建通过；全量 104 文件、1378 项通过、1 项跳过；J-Link/CMSIS-DAP mock 通过。新目录重建、63 个 vendor hash、11 个原有 ELF 变体、5 份独立样本、7 项校验器测试及新 ELF 的 12 项布局测试通过。
- 硬件：H723VGT6，FreeRTOS 10.3.1，GCC/ARM_CM4F，heap_4；RMLink b81f3fc30470 / 0.3.4 / Wi-Fi / 4 MHz 请求值，唯一 CMSIS-DAP service owner。沿用用户的烧录/运行/断点/RAM/RTT 操作授权，未操作 Option Bytes。
- 实板结果：三个独立内核 API 检查点各 13 任务逐字段一致；35 项 lifecycle 通过。最终三轮共存对照 396 次控制零错误；pause p95 131→197 ms，continue p95 162→165 ms；252 个新鲜 13 任务字段帧 / 180.731 s，多数全图为 partial，未升级一致性。暖快照 p95 583 ms，全栈扫描 3217 ms；冻结门槛通过。
- 证据：stage1-validation.md、stage1-performance-gates.json、stage1-evidence.json；本地 out/rtos-stage1 下保留原始命令/响应、DAP trace、失败与各轮数据。测试固件保留在板上，测试会话/owner 已释放。
- 剩余事项：阶段 2.1 底部任务面板；其后对象、Trace、其他探针实板和长稳均按原计划实施。RMLink 当前 PC 断点继续的既有限制及脚本修正已登记，未写入 bug-fix-log；20 ms 暂停态优化目标未达到，实际无线门槛和统计可信范围已明确。
- 提交：接入 RTOS 阶段 1.4：完成安全刷新与会话隔离；hash 用 git log 查询本记录所在提交。

## 2.1 / 2026-11-18

- 状态：已完成（L1/L3/L4 与 VSIX 打包验收通过）。
- 实现：package.json 注册底部容器 ozone-rtos-panel（标题 RTOS）与视图 ozoneRtos（onView:ozoneRtos）；esbuild.config.js 新增 dist/rtos.js 构建入口；src/webview/rtos/rtos-view-state.ts、rtos-provider.ts、app.tsx、main.tsx 与 src/extension.ts 实现任务快照表格、逐行列表证据与 CPU 窗口说明、手动/Live 轮询、按需栈扫描、缺符号/无 DWARF 空态诊断、精确 DebugSession 路由及 workspaceState 视图设置持久化；scripts/rtos/verify-stage2-vscode.js 与 vscode-stage2-driver.js 提供真实 VS Code 自动化验收。
- 设计变更：面板使用 retainContextWhenHidden=true，并在隐藏或视图销毁时暂停后台 Live 轮询（不终止调试会话），视图重建或重新显示时从宿主状态与 workspaceState 恢复；在 ExtensionMode.Test 下仅向测试驱动暴露 rtosProvider 与 extensionContext。
- 检查：npm run typecheck、npm run build 通过；聚焦 Vitest 7 文件 56 项通过；scripts/rtos/verify-stage2-vscode.js 在真实 VS Code 中通过打开、隐藏、移动重建（readyCount 1→3）、亮暗主题切换（Default Light Modern / Default Dark Modern）、会话切换（ctrlA→ctrlB）、DwarfUnavailable 空态与设置持久化；vsce 打包的 out/rtos-stage2/orbit-stage2.1.vsix 内已确认包含 extension/dist/rtos.js。
- 硬件：未执行；真实 VS Code 验收使用隔离测试实例与内联 mock DAP 适配器，不连接或改变物理目标。
- 证据：src/webview/rtos/*.test.ts、scripts/rtos/verify-stage2-vscode.js、out/rtos-stage2/vscode-ui/report.json、out/rtos-stage2/orbit-stage2.1.vsix。
- 剩余事项：2.2 增加 Queue、Mutex、Semaphore 与等待关系。
- 提交：实现 RTOS 阶段 2.1：增加底部任务快照面板；hash 用 git log 查询本记录所在提交（54d8c3e）。

## 2.2 / 2026-11-18

- 状态：已完成（L1/L3/L4 自动化验收通过；硬件未执行）。
- 实现：src/rtos/model.ts、src/rtos/freertos-layout.ts、src/rtos/object-reader.ts、src/rtos/snapshot-service.ts 与 src/debug/dap-session.ts 新增 Queue/Mutex/Recursive Mutex/Binary & Counting Semaphore DWARF 布局编译（支持 xQueueRegistry 启用及 configQUEUE_REGISTRY_SIZE=0 退化探测与全局句柄收集）、三来源发现（registry/global/list）与多源去重、ELF .rodata 只读段静态名称零总线解析、仅针对互斥锁提取持有者/递归计数、结构完整性与删除中/异常状态校验、EventGroup 等非队列等待列表归入 unresolvedWaits、暂停态一致/运行态尽力采集下的候选等待环提取（partial 状态抑制误报）及按需 wait-list 遍历；src/webview/rtos/objects-view.tsx、app.tsx、rtos-view-state.ts 与 rtos-provider.ts 新增 Tasks & Objects 子页签、Live 含对象开关、按需对象详情加载、持有者/等待者与任务面板双向跳转。
- 设计变更：将 ELF 只读段（PT_LOAD flags&2===0，按 sha256 缓存）纳入 C 字符串只读解析并优先于 RAM 回退，避免为 Flash .rodata 中的静态 pcQueueName 发起无效 RAM 读；当 QueueDefinition/xQueueRegistry 仅在对象侧缺失或冲突时降级对象能力而不阻断任务快照。
- 检查：npm run typecheck 与 npm run build 通过；聚焦 Vitest 8 文件 65 项通过（含 7 个含 DWARF 阶段 0 ELF 变体队列/Registry 布局编译、object-reader.test.ts、rtos-view-state.test.ts、rtos-provider.test.ts 与 dap-session-rtos-snapshot.test.ts）；scripts/rtos/verify-stage2-vscode.js 在真实 VS Code 中通过 Queue/Mutex 能力条、Objects 子页签切换、按需详情加载（busLock）与设置持久化验证。
- 硬件：未执行；未针对队列/互斥锁/Semaphore 执行物理目标操作。
- 证据：src/rtos/object-reader.test.ts、src/rtos/freertos-layout.test.ts、out/rtos-stage2/vscode-ui/report.json。
- 剩余事项：2.3 增加 Software Timers 与 Heap 概览及统一刷新预算；2.4 清理旧 RTOS Views 专属集成。
- 提交：实现 RTOS 阶段 2.2：增加队列锁与任务等待关系；hash 用 git log 查询本记录所在提交（3711561）。

## 2.3 / 2026-11-18

- 状态：已完成（L1/L3/L4 自动化验收通过；硬件未执行）。
- 实现：src/rtos/model.ts、src/rtos/reader-helpers.ts、src/rtos/freertos-layout.ts、src/rtos/timer-heap-reader.ts、src/rtos/task-metrics.ts、src/rtos/snapshot-service.ts 与 src/debug/dap-session.ts 实现 ListItem_t.xItemValue、tmrTimerControl/xActiveTimerList1/2/pxCurrentTimerList/pxOverflowTimerList/xTickCount/TimerHandle_t/StaticTimer_t 布局编译与读写，区分 heap_4（ucHeap、xStart、pxEnd、xFreeBytesRemaining、xMinimumEverFreeBytesRemaining、成功分配与释放计数；含 pxEnd==NULL 未初始化态）与 heap_1/heap_2/heap_5/自定义或关闭状态，并将栈扫描、对象等待链、定时器与堆详情纳入统一的 SnapshotMemory detailBudgetBytes 刷新预算；src/webview/rtos/timers-heap-view.tsx、app.tsx、rtos-view-state.ts 与 rtos-provider.ts 增加“定时器与堆”子页签、能力状态徽章及诊断区详情预算分解展示。
- 设计变更：将栈扫描与对象/定时器/堆读取共用的字节上限直接收敛到单帧 SnapshotMemory.limits.bytes（baselineBytes + detailBudgetBytes），在任一详情段触发 BudgetExceeded 时记录问题、保留已收集的任务与轻量元数据、并按 partial 降级；对未引用且处于停止态的动态定时器明确不生成全量列表，对 heap 仅展示已记录计数而不猜测碎片率或泄漏。
- 检查：npm run typecheck 与 npm run build 通过；聚焦 Vitest 9 文件 71 项通过（含 7 个含 DWARF 阶段 0 ELF 变体的 Timer/Heap 布局校验、timer-heap-reader.test.ts 活动/溢出/全局停止/关闭配置/heap_4 初始化前后/非 heap_4 降级与统一预算溢出测试、rtos-view-state.test.ts、rtos-provider.test.ts 与 dap-session-rtos-snapshot.test.ts）；scripts/rtos/verify-stage2-vscode.js 在真实 VS Code 中通过定时器与堆子页签切换、inspectTimersHeap、heap_4 与 detailBudgetBytes 设置持久化验证。
- 硬件：未执行；未针对 Timer/Heap 执行物理目标操作。
- 证据：src/rtos/timer-heap-reader.test.ts、src/rtos/freertos-layout.test.ts、out/rtos-stage2/vscode-ui/report.json。
- 剩余事项：2.4 清理旧 mcu-debug.rtos-views 专属集成并执行阶段 2 出口回归与 VSIX 检查。
- 提交：实现 RTOS 阶段 2.3：增加定时器与堆概览；hash 用 git log 查询本记录所在提交（20421da）。

## 2.4 / 2026-11-18

- 状态：已完成，阶段 2.1～2.4 出口通过；硬件未执行（沿用阶段 1.4 实板基线）。
- 实现：删除 src/debug/rtos-views-tracker.ts、src/debug/rtos-views-tracker.test.ts 及旧 RTOS Views 专属脚本 scripts/check-config.js、verify-config.js、debug-tracker-test.js、rtos-fix-test.ps1；更新 src/extension.ts、package.json 与 src/utils/orbit-settings.ts，移除 mcu-debug.rtos-views.trackDebuggers 注入与 orbit.rtosViewsAutoRefresh（保留 memory-view、mcu-debug.debug-tracker-vscode、orbit.defaultRtos、rtosInfo、rtosExpansion 及标准 DAP 变量/内存读写路径）；更新 docs/rtos-debug-guide.md 为内建 RTOS 面板说明，并新增 src/utils/orbit-settings.test.ts。
- 设计变更：无；不修改 docs/bug-fix-log.md 中的历史故障记录。
- 检查：npm run typecheck 与 npm run build 通过；全量 Vitest（--minWorkers=1 --maxWorkers=2）108 文件、1401 项通过、1 项跳过；npm run test:cpp-channel:mock 与 npm run test:cmsis-dap:mock 通过；scripts/rtos/verify-stage2-vscode.js 在真实 VS Code 中通过挂载/隐藏/重建、亮暗主题、会话切换、Objects/Timers/Heap 子页签与未向工作区写入 mcu-debug.rtos-views.trackDebuggers 检查；out/rtos-stage2/orbit-stage2.4.vsix zip 检查确认包含 extension/dist/rtos.js 与 ozoneRtos 视图并排除 orbit.rtosViewsAutoRefresh。
- 硬件：未执行；阶段 2 未触发物理目标烧录、halt/run 或 RAM 写操作，实板任务快照基线见阶段 1.4 与 stage1-validation.md。
- 证据：src/utils/orbit-settings.test.ts、scripts/rtos/vscode-stage2-driver.js、out/rtos-stage2/vscode-ui/report.json、out/rtos-stage2/orbit-stage2.4.vsix。
- 剩余事项：阶段 2 已关闭，下一阶段为阶段 3（RTT 多通道枚举与下行写入）。
- 提交：清理 RTOS 阶段 2.4：移除旧 RTOS Views 专属集成；hash 用 git log 查询本记录所在提交。
