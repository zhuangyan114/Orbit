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

## 3.1 / 2026-11-18

- 状态：已完成，独立 mock 验收通过。实板回环验证归 3.4。
- 实现：native/cmsis-dap-helper/src/segger_rtt.h、segger_rtt.cpp、cmsis_dap_target.h、cmsis_dap_target.cpp、main.cpp 与 src/ozone-backend/cmsis-dap-helper-channel.ts、session-target-channel.ts、types.ts、commander.ts 实现可配置非固定 RAM 范围校验（1..32 段、防溢出/重叠/跨区/越界）及有界 Up/Down descriptor 与名称枚举（enumerateRtt，最多 64 Up + 64 Down、名称最多 64 bytes 并按 RAM/RO 范围钳制，区分 unused/valid/corrupt 与 null/empty/short-read/unterminated/invalid-address/read-failed，按方向独立检测重复名）；区分字段省略与显式非法值（controlBlockAddress、timeoutMs 在显式传入 null/负数/字符串/非 uint32 时返回 DapInvalidRequest，真正省略才允许复用已启动控制块或默认 timeout），并将 timeoutMs 作为 CmsisDapRttMemory、CmsisDapTarget::readMemory/readMemoryBlock 与 SeggerRttReader::enumerate（头/表/名称各阶段）的共享有界期限，超时或设备移除立即以 ReadTimeout/DeviceRemoved 终止枚举而不吞并或占住唯一 helper；未传递 ramRanges 的旧客户端与 J-Link helper 仍保留既有默认行为及 RTT Log/单物理 owner 路由，不扩充芯片支持，未提前实现 3.2 下行写入。
- 设计变更：将合法目标 RAM 范围校验同时用于 startRtt/readRtt 与 enumerateRtt；当已连接注册目标时由 CmsisDapTargetChannel 自动提供 target-pack 的 ramRegions（及枚举时的 flashBase/flashSize 作为 roRanges），未注册目标在 startRtt 省略参数时沿用既有 128 KiB 默认以兼容旧 RTT Log，在 enumerateRtt 无显式 ramRanges 时返回 UnsupportedCapability。
- 检查：node out/rtos-stage3/acceptance-3.1/manual-enumerate-rpc.cjs 复验通过（nullable 返回 DapInvalidRequest；64+64 通道 timeoutMs=1 5 次均于 elapsedMs=1 返回 ReadTimeout 且 count=0）；orbit-cmsis-dap-rtt-tests.exe（含 FakeClock 分阶段超时与 ReadTimeout 传播独立单测）、npm run test:cmsis-dap:mock、npm run test:cpp-channel:mock、聚焦 Vitest（4 文件 108 项：session-target-channel.test.ts、cmsis-dap-helper-channel.test.ts、commander-cmsis-dap.test.ts、dap-session-rtt.test.ts）、npm run typecheck、npm run build 与 git diff --check 全部通过。
- 硬件：未执行；3.1 仅涉及 CMSIS-DAP RTT 合法 RAM 范围与通道枚举，硬件传输门槛归 3.4。
- 证据：native/cmsis-dap-helper/src/segger_rtt_test.cpp、scripts/cmsis-dap-smoke.js、out/rtos-stage3/acceptance-3.1/manual-enumerate-rpc.cjs、src/ozone-backend/session-target-channel.test.ts、src/ozone-backend/cmsis-dap-helper-channel.test.ts、src/ozone-backend/commander-cmsis-dap.test.ts、src/debug/dap-session-rtt.test.ts。
- 独立复验覆盖原生构建、CMSIS-DAP 与 J-Link mock、五个聚焦 Vitest 文件的 121 项用例，以及原两个失败用例的复跑。下一小部分为 3.2（CMSIS-DAP Down-buffer 写入）。
- 提交：`实现 RTOS 阶段 3.1：完善 RTT 内存范围与通道枚举`。

## 3.2 / 2026-11-18

- 状态：已完成，独立 mock 验收通过。实板回环验证归 3.4。
- 实现：native/cmsis-dap-helper/src/cmsis_dap_target.cpp（writeMemory/writeMemoryBlock 共享 deadline 期限控制）、segger_rtt.h、segger_rtt.cpp（SeggerRttReader::writeDown 复用 3.1 合法 RAM 范围与 control block/descriptor 校验，并按无溢出 64 位区间校验拒绝 ring 与整个 RTT 控制块 [controlBlockAddress, +24+(maxUp+maxDown)*24) 重叠的元数据——含初始与 Mode 2 轮询重校验——紧邻表前/表尾不相交的 ring 仍合法；实现可用空间计算、环绕写入、Mode 0 SKIP / Mode 1 TRIM 可判定短写、Mode 2 BLOCK_IF_FIFO_FULL 有界超时、严格先写数据段后写 WrOff 并保留目标侧 RdOff，以及 data-first / data-second / commit-wroff / poll-wait 结构化结果与 completion 状态；downWriteFailure 保留 WriteTimeout/ReadTimeout/WriteCompletedLate/OutcomeUnknown/MalformedResponse/DeviceRemoved/DapAckNoAck/DapAckWait/DapAckFault 且禁止盲目重试与伪报已提交）、main.cpp（hello capabilities 新增 rttWrite、handleWriteRtt RPC、dispatch 与 selftest）；src/ozone-backend/cmsis-dap-helper-channel.ts（CmsisDapRttWriteOptions/Result 类型、writeRtt 控制优先级）、session-target-channel.ts（SessionTargetOwner/Selector/CmsisDapTargetChannel.writeRtt、helperCapabilities 同步校验与 isValidRttWriteResult 校验）、types.ts 与 commander.ts（writeRtt 命令路由与不支持能力返回 UnsupportedCapability）。
- 设计变更：无；沿用 3.1 的合法 RAM 范围校验规则，未注册目标无显式 ramRanges 时返回 UnsupportedCapability，省略 controlBlockAddress 时复用已启动 startRtt 控制块而不破坏已有 RTT Log 状态；未提前实现 3.3（J-Link RTT 统一）或 3.4（并发消费者）。
- 检查：node out/rtos-stage3/acceptance-3.2/independent-down-rpc.cjs 复验通过（正常环绕短写通过；pBuffer=controlBlockAddress 返回 RttInvalidBufferLayout，控制块与 WrOff/RdOff 完全不变）；orbit-cmsis-dap-rtt-tests.exe、npm run test:cmsis-dap:mock、npm run test:cpp-channel:mock、npm run typecheck、npm run build、聚焦 Vitest（5 文件）与 git diff --check 均在最终修改后通过（具体计数见交付报告）。
- 硬件：未执行；3.2 仅涉及 CMSIS-DAP Down-buffer 离线/mock 实现与验证，实板回环归 3.4。
- 证据：native/cmsis-dap-helper/src/segger_rtt_test.cpp（DownBufferMockMemory 独立原始内存与写序列核对，含控制块头/Up/Down 描述符相交、紧邻合法边界与高地址无溢出边界、Mode 2 轮询重校验重叠）、native/cmsis-dap-helper/src/main.cpp（--selftest 209 项）、scripts/cmsis-dap-smoke.js（runRttStage32Matrix）、out/rtos-stage3/acceptance-3.2/independent-down-rpc.cjs、src/ozone-backend/cmsis-dap-helper-channel.test.ts、src/ozone-backend/session-target-channel.test.ts、src/ozone-backend/commander-cmsis-dap.test.ts。
- 独立复验确认非法重叠的写入完整保留原控制块，正常环绕和短写仍通过。另有原生构建、CMSIS-DAP 与 J-Link mock、五个聚焦 Vitest 文件的 127 项用例通过。下一小部分为 3.3。
- 提交：`实现 RTOS 阶段 3.2：增加 RTT 下行控制能力`。

## 3.3 / 2026-11-19

- 状态：已完成。独立 J-Link mock 复验和全量自动化通过，实板回环归 3.4。
- 实现：native/jlink-helper/src/main.cpp（JLinkChannel 将 JLINK_ReadMem/JLINK_WriteMem 转为可选解析并在 load/connect/getRttCapabilities 返回实际可用 DLL API 与逐项 rttCapabilities；在原有 SeggerRttReader 内存协议解析器上接入 enumerateRtt、writeRtt、带可选 ramRanges/timeoutMs 的 startRtt 以及携带结构化元数据的 readRtt，JLinkRttMemory::write 将正数短写返回映射为 OutcomeUnknown，不构造第二 DLL owner 且不重新启用阻塞式 JLINK_RTTERMINAL_Read）；native/jlink-helper/test/mock-jlink.cpp、mock-jlink-no-write.cpp/def 与 CMakeLists.txt、scripts/build-native.ps1（为 JLink_x64.dll 增加可注入读写失败与部分写返回码的控制地址，并新增缺少 JLINK_WriteMem 与 JLINK_RTTERMINAL_* 入口的独立 JLink_x64_no_write.dll）；src/ozone-backend/rtt-contract.ts（统一 RttCapabilities 与校验辅助函数，消除重复校验逻辑）、jlink-dll.ts（新增导出可用性探测 getRttApiAvailability）、cpp-jlink-channel.ts（ExperimentalCppJLinkChannel 补齐 enumerateRtt、writeRtt、getRttCapabilities、目标包 ramRegions/roRanges 自动注入、watch/control/background 优先级与取消/失联语义）、session-target-channel.ts（SessionTargetOwner/Selector 统一 getRttCapabilities，LegacyJLinkTargetChannel 逐项声明 RTT 能力并返回 UnsupportedCapability，CmsisDapTargetChannel 补齐 getRttCapabilities 与 enumerateRtt capability 检查）、rmlink-target-channel.ts、types.ts 与 commander.ts（新增 getRttCapabilities 命令路由并保留单 owner 边界与原 RTT 文本行为）。
- 设计变更：无；沿用 3.2 的上层通道、selector 命令边界和合法 RAM 范围校验规则，未注册目标无显式 ramRanges 时返回 UnsupportedCapability，缺省 startRtt 仍保留默认 128 KiB 兼容旧 RTT Log；未提前实现 3.4（RTT 消费协调器与实板回环）。
- 检查：node out/rtos-stage3/acceptance-3.3/independent-jlink-rtt.cjs、npm run build:native、npm run test:cpp-channel:mock、npm run test:cmsis-dap:mock、聚焦 Vitest（7 文件：cpp-jlink-channel.test.ts、session-target-channel.test.ts、commander-session-owner.test.ts、commander-cmsis-dap.test.ts、cmsis-dap-helper-channel.test.ts、dap-session-rtt.test.ts、rmlink-target-channel.test.ts）、npm run typecheck、npm run build 与 git diff --check（结果与日志保存在 out/rtos-stage3/acceptance-3.3/）。
- 硬件：未执行；未连接物理 J-Link 或 CMSIS-DAP 探针，3.3 仅执行离线构建与独立 mock 验证，实板传输与消费协调归 3.4。
- 证据：native/jlink-helper/src/main.cpp、native/jlink-helper/test/mock-jlink.cpp、native/jlink-helper/test/mock-jlink-no-write.cpp、scripts/cpp-channel-smoke.js、out/rtos-stage3/acceptance-3.3/independent-jlink-rtt.cjs、out/rtos-stage3/acceptance-3.3/independent-jlink-rtt.json、src/ozone-backend/rtt-contract.ts、src/ozone-backend/cpp-jlink-channel.test.ts、src/ozone-backend/session-target-channel.test.ts、src/ozone-backend/commander-session-owner.test.ts。
- 独立复验：重跑原生构建、J-Link 与 CMSIS-DAP mock 和独立 J-Link JSON-RPC 测试，核对短写、未知写入结果、DLL 缺少写入接口和 owner 消失。全量 Vitest 为 1429 项通过、1 项跳过。
- 剩余事项：3.4 的 RTT 消费协调器与实板回环。
- 提交：`实现 RTOS 阶段 3.3：统一 J-Link 与 DAP 的 RTT 能力`。

## 3.4 / 2026-11-19

- 状态：自动化与 RMLink Wi-Fi 实板验收通过。J-Link native 和 CMSIS-DAP WinUSB/HID 对应硬件项目待验收。
- 实现：新增 src/rtos/rtt-coordinator.ts（RttConsumptionCoordinator、resolveRttTransportBudget 与入口校验辅助函数）与 src/ozone-backend/segger-rtt-memory.ts（纯 TypeScript SEGGER RTT 控制块/环形缓冲协议引擎，128B 分块读写、4 字节对齐边缘经范围与环形边界校验的 RMW 保留邻字节、结构化 completion/failureStage 状态、无盲重试）；更新 src/ozone-backend/rmlink-target-channel.ts（启用 writeAlignmentBytes=4、显式能力细节、非 RTT 非对齐 writeMemory 拒绝、序列化 writeRtt 并接入 enumerateRtt/writeRtt/多通道 readRtt，保留 ch0 默认 rtt_stream 兼容）、src/ozone-backend/rtt-contract.ts（validateRttMemoryRanges 支持 unknown 入口校验）、src/ozone-backend/cpp-jlink-channel.ts（Up ch1+ 独立 coalesceKey 避免跨通道合并）、src/ozone-backend/cmsis-dap-helper-channel.ts、src/ozone-backend/types.ts、src/ozone-backend/commander.ts，以及 src/debug/dap-session.ts（统一协调 ch0 RTT Log 与内部 orbitRttTransport，按 control > watch > timeline > background 与 acquireRttReadGate 调度、XR 采样冲突策略、串行化 owner stop/start、普通控制与 reset/dispose 退避分离、单会话单物理控制块绑定、入口 JSON 校验以及遵循 DAP ErrorResponse Message 对象规范的 sendRttTransportFailure，消除 body.error 字符串导致 VS Code Wpt.handleErrorResponse 抛出 TypeError 并保留 errorCode/completion/diagnostics）。新增离线单元测试 src/rtos/rtt-coordinator.test.ts、src/ozone-backend/segger-rtt-memory.test.ts 与 src/debug/dap-session-rtt-transport.test.ts（含 RMLink target.py 4 字节对齐规则与 DAP ErrorResponse 信封回归）。
- 设计变更：将 RMLink 的 enumerateRtt、writeRtt 与多通道/内存模式 readRtt 收敛到纯 TS SeggerRttMemoryEngine（单块 128B 以适配无线预算，Down 写入在同 owner 控制临界区内仅对完全落入合法 Down 环形缓冲及有效 RAM 范围、且不触及控制块/描述符的边缘做 4 字节对齐 RMW；越界几何明确以 RttInvalidBufferLayout / completion=not-started 拒绝）；ch0 缺省仍保留 rtt_stream 兼容。RMLink Wi-Fi 内存读者以 512 B/批、最小间隔 20 ms 的设计配置验证下文的有限负载，未测链路继续使用设计预算。
- 检查：npm run typecheck 与 npm run build 通过；全量 Vitest（`npm test -- --minWorkers=1 --maxWorkers=2`）111 文件、1442 项通过、1 项已有跳过；npm run build:native、npm run test:cpp-channel:mock 与 npm run test:cmsis-dap:mock 通过；五项独立复现脚本 independent-control-handoff.cjs、independent-owner-stop-start.cjs、independent-dap-request-bounds.cjs、independent-dap-control-block.cjs 与 independent-wifi-rmw-and-error-envelope.cjs 全部通过；git diff --check 通过。
- 硬件：沿用已打开的 VS Code 扩展开发宿主、RMLink 二号机 b81f3fc30470（0.3.4、Wi-Fi 512、SWD 4 MHz 请求）及 STM32H723VGT6（核心时钟 64 MHz）。11 字节 Down-to-Up 原样返回，Down 写指针从 253 环绕到 8，双订阅各收到同一批，并核对每批只推进一次 RdOff。停掉一份订阅后另一份继续读，Terminal 文本并发输出且 ANSI 按配置剥离。不存在的通道在 VS Code 返回 RttChannelUnavailable。
- 证据：src/rtos/rtt-coordinator.ts、src/ozone-backend/segger-rtt-memory.ts、src/ozone-backend/rmlink-target-channel.ts、src/debug/dap-session.ts、src/rtos/rtt-coordinator.test.ts、src/ozone-backend/segger-rtt-memory.test.ts、src/debug/dap-session-rtt-transport.test.ts、out/rtos-stage3/acceptance-3.4/offline-acceptance.json 与同目录五份独立复现 `.cjs/.json`。
- Wi-Fi 实测：Up 4096 B、Down 256 B，双订阅与 Terminal 20 ms 轮询并发。20 ms/64 B 的负载运行约 4 s，在线收取 3099 B/s，排空后两份订阅各有 208 帧和 13,312 B，0 缺失、重复、坏帧或主机丢弃。5 ms/64 B 过载时，在线收取 4327 B/s，排空后 346 帧和 22,144 B，固件丢弃 483 帧与序号缺口一致，主机报告拥塞。普通和环绕 11 B 回环端到端约 282–394 ms，含 Host 轮询与统计请求。上述数字适用于该配置和样本时长。
- 复验：在授权测试工作区的 `build/OrbitRttAcceptance` 运行 `build-loopback.ps1` 生成 `orbit-rtt-loopback.elf`，用已有扩展开发宿主运行 `node check-wifi-loopback.cjs`，可用 `--reuse` 重用已烧录 fixture、用 `--overload` 复查过载。原始证据在 `out/rtos-stage3/acceptance-3.4/independent-wifi-r2.json` 和 `independent-wifi-r2-overload.json`。本轮结束后测试探针 owner 已释放。
- 剩余事项：Windows 未枚举到 J-Link native 或 CMSIS-DAP WinUSB/HID，保留相应传输与发布硬件门槛。阶段 4.1 先从离线样本开展。
- 提交：`实现 RTOS 阶段 3.4：统一 RTT 消费与调度`。

## 4.1 / 2026-11-19

- 状态：已完成，离线与独立样本验收通过。
- 实现：新增 `src/trace/systemview-protocol.ts`（依据固定 SEGGER SystemView 3.32.0 `SEGGER_SYSVIEW.h`/`.c`/`_Int.h` 与 `SEGGER_SYSVIEW_FreeRTOS.h` 冻结 `0..23` 短事件 schema、显式长度事件 `24..31` 及 `EX` 子事件 `0..7`、`apiID_OFFSET=32` 的 111 项 FreeRTOS API 名称与 `trace*` 宏参数签名、`expandShrunkId` 32 位防溢出还原与 `SYSDESC` 键值解析）与 `src/trace/systemview-decoder.ts`（有界增量 `SystemViewStreamDecoder` 与 `decodeSystemViewStream`，基于单包状态机避免整段流反复复制，按 `5` 字节上限与第 5 字节 `<= 0x0f` 校验 varint U32，区分短 schema、合法 `NOP + delta` 与显式长度事件，通过 `TRACE_START + 有效 INIT` 的可证明重同步窗口与 `syncedSyncProbe` 拒绝弱候选并保持合法周期 sync 与时间连续性；`OVERFLOW` 缺口保留 `rawDropCount` 与 `minDroppedPackets` 下界语义并将 `droppedPackets` 设为 `unknown`；无 `SYSTIME_CYCLES` 锚点时保持相对 tick 而 `absoluteTicks` 留空，无有效 `sysFreqHz` 时不换算微秒/纳秒；支持 32/N-bit 回绕、元数据冲突检测、`maxPayloadBytes`/`maxStringBytes`/`maxChunkBytes`/`maxPrintArgs`/`maxResyncProbeBytes`/`maxSysDescKeys`（默认 256）确定上限）；新增单元测试 `src/trace/systemview-decoder.test.ts`。
- 设计变更：无；遵循 `plan.md` 第 8 节 4.1 边界与 `protocol.md` 协议依据，未提前实现 4.2 的任务/ISR/Ready/Marker 区间重建、存储、worker 接线、DAP 或 UI，未修改 vendor 与既有独立 fixture。
- 检查：`npx vitest run src/trace/systemview-decoder.test.ts`（18 项通过：含 5 份独立样本及 `host/oracle.json`、逐字节与全量 2 分片边界、粘包、5 字节 U32 边界及超长/溢出 varint、已知 payload 错长、有长度未知事件、无长度未知短事件、普通 payload 内 16 零字节、假 sync 回退、截断、连续溢出、timestamp wrap、元数据冲突、NOP 非零/零 delta 与邻接真 sync、400 KB 大块与 24,596 个 SYSDESC 键有界校验）；`npm run typecheck` 通过；`npm run build` 通过；全量 `npm test -- --minWorkers=1 --maxWorkers=2`（112 文件、1460 项通过、1 项已有跳过）；独立脚本 `node out/rtos-stage4/acceptance-4.1/verify-decoder.cjs`、`node out/rtos-stage4/acceptance-4.1/independent-large-chunk-and-sync.cjs`、`node out/rtos-stage4/acceptance-4.1/independent-official-nop-and-overflow.cjs` 与 `node out/rtos-stage4/acceptance-4.1/independent-metadata-bounds.cjs` 全部通过（EXIT 0）。
- 硬件：未执行；4.1 为离线流式解码器阶段，未连接或操作实板。
- 证据：`src/trace/systemview-protocol.ts`、`src/trace/systemview-decoder.ts`、`src/trace/systemview-decoder.test.ts`、`out/rtos-stage4/acceptance-4.1/verify-decoder.cjs`、`out/rtos-stage4/acceptance-4.1/report.json`、`out/rtos-stage4/acceptance-4.1/independent-large-chunk-and-sync.json`、`out/rtos-stage4/acceptance-4.1/independent-official-nop-and-overflow.json`、`out/rtos-stage4/acceptance-4.1/independent-metadata-bounds.json`、`out/rtos-stage4/acceptance-4.1/independent-official-nop.bin`。
- 独立复验：用固定原厂记录器重建五份样本并核对 SHA256，所有 24,723 个两片切分位置和逐字节流式回放结果均一致。通过手算 oracle 核对事件、tick 与任务 ID，并复验 400 KB 输入、断点后假同步、原厂 NOP、溢出计数及元数据上限。全量 1460 项通过、1 项跳过。
- 剩余事项：下一小部分为 4.2，重建任务、ISR、Ready 区间与基础 Marker 配对。
- 提交：`实现 RTOS 阶段 4.1：增加 SystemView 流式解码器`。

## 4.2 / 2026-11-19

- 状态：已完成，离线与独立样本验收通过。
- 实现：新增 `src/trace/systemview-reconstructor.ts`（`SystemViewTraceReconstructor` 与 `reconstructSystemViewTrace`），消费 4.1 `SystemViewDecodeBatch` 并按 `sessionId`/`sessionGeneration`/`bootGeneration`/`recordId`/`segmentId` 与任务实例代次隔离连续性；重建单核独占执行切片（Task/Idle/ISR/Scheduler，ISR 占时不计入被抢占任务独占运行时间）与含 inclusive/exclusive/preempted 分解的上下文激活区间（Task/ISR/Timer）、Ready 等待区间（按固定 SystemView 3.32 FreeRTOS hook 区分 `TASK_START_READY` -> `TASK_START_EXEC` 完整链条、`TASK_STOP_READY` 移出及运行态阻塞自调 `TASK_STOP_READY`、缺失起始与重复 Ready）、`TASK_CREATE`/`TASK_INFO`/`STACK_INFO`/`TASK_TERMINATE`/`OS_vTaskDelete`（含自删延迟到切出终止与 TCB 同地址复用代次隔离，使用全局单调 `taskInstanceSeq` 与有界 `taskGenerationByKey` LRU 防止淘汰后主键碰撞或重新命中静态符号）、`MARK_START`/`MARK_STOP`/`EX_MARK` 基础配对与点事件；仅依据 `TASK_INFO`、`SYSDESC`、`EX_NAME_MARKER`、`NAME_RESOURCE` 与调用者 `symbolMap` 标注，缺信息显式标 `missing`；对缺口、复位、不连续 `batchSequence`（非 `lastBatchSequence + 1` 且未声明 `markGap` 拒绝为 `BatchSequenceGap`，`batchSequence` 跨 `bootGeneration` 保持单调连续）、非法重入、缺失退出、失序时间戳、重复 Marker、录制中途开始与半段 EOF 标为不完整/不确定且不填确切时长；所有 tick 与纳秒换算保持 `bigint`/十进制字符串并支持无 `SYSTIME_CYCLES`/零频率退化；未闭合栈、等待、Marker、任务及描述表均设硬上限且不持有历史已闭合区间。新增单元测试 `src/trace/systemview-reconstructor.test.ts`。
- 设计变更：无；遵循 `plan.md` 第 8 节 4.2 边界，未提前实现 4.3 存储/LOD/Worker 接线，未改动 DAP、硬件、vendor 或既有阶段 0 样本。
- 检查：`npx vitest run src/trace/systemview-reconstructor.test.ts src/trace/systemview-decoder.test.ts`（2 文件 28 项通过：包含阶段 0 五份独立样本与 `host/oracle.json`、逐片流式拆批一致、Ready 语义与运行态 `TASK_STOP_READY`、多层嵌套 ISR/`ISR_TO_SCHEDULER`/Timer、TCB 地址复用与 `OS_vTaskDelete` 自删、非法重入/缺失退出/重复 Marker/孤立退出/倒退时间戳/半段 EOF/缺 `INIT` 中途开始、外部缺口/复位/跨 boot `batchSequence`/错会话/错记录、`maxKnownTaskAddresses` LRU 淘汰后唯一主键、缺失绝对时间与大整数 `bigint` 精度、有界淘汰）；独立验收脚本 `node out/rtos-stage4/acceptance-4.2/independent-context-acceptance.cjs`（IRQ17 inclusive=20 exclusive=15，IRQ18 inclusive=5 exclusive=5，TCB 复用隔离）、`node out/rtos-stage4/acceptance-4.2/independent-record-with-loss.cjs`（缺口后未知任务隔离标签与实例 ID、`BatchSequenceGap` 拒绝缺序批次）与 `node out/rtos-stage4/acceptance-4.2/independent-task-id-budget.cjs`（budget=8 下淘汰后仍分配唯一实例 ID）全部通过；`npm run typecheck` 通过；`npm run build` 通过；全量 `npm test -- --minWorkers=1 --maxWorkers=2`（113 文件、1470 项通过、1 项已有跳过）；`git diff --check` 通过。
- 硬件：未执行；4.2 为离线区间重建阶段，未连接或操作实板。
- 证据：`src/trace/systemview-reconstructor.ts`、`src/trace/systemview-reconstructor.test.ts`、`out/rtos-stage4/acceptance-4.2/build-independent-context.py`、`out/rtos-stage4/acceptance-4.2/independent-context-acceptance.cjs`、`out/rtos-stage4/acceptance-4.2/independent-context-acceptance.json`、`out/rtos-stage4/acceptance-4.2/independent-record-with-loss.cjs`、`out/rtos-stage4/acceptance-4.2/independent-record-with-loss.json`、`out/rtos-stage4/acceptance-4.2/independent-task-id-budget.cjs`、`out/rtos-stage4/acceptance-4.2/independent-task-id-budget.json`。
- 独立复验：用固定原厂记录器核对 8 段独占切片、3 个 Ready 等待和 1 个 Marker；IRQ17/18 独占分别为 15/5 ticks。传输缺口后同址实例和名称重新识别，遗漏批次被拒绝，8 地址预算内淘汰时仍分配唯一实例 ID。全量 1470 项通过、1 项跳过。
- 剩余事项：下一小部分为 4.3，完成 Trace 存储、LOD 与 Worker 接线。
- 提交：`实现 RTOS 阶段 4.2：重建任务中断与等待区间`。

## 4.3 / 2026-11-19

- 状态：已完成。Trace 归档、范围索引、LOD 与 Worker 已通过独立复验和全量回归。
- 实现：
  - 新增 `src/trace/trace-format.ts`：定义 Orbit 内部 Trace 归档格式 `orbit-trace-v1`（版本 `1`，明确标注非 SEGGER `.SVDat`）。目录包含 `manifest.json`（元数据、生命周期状态与提交统计）、`raw.otbin`（与源输入逐字节一致的原始分块流）、`data.otd`（`OTD1` 字符串驻留与任意精度 BigInt 编码的二进制数据页，含页负载 CRC32）、`journal.otj`（`OTJ1` 提交边界日志，含帧头 CRC32、整帧 CRC32、raw/data 偏移与 CRC32）与 `index.otidx`（`OTI1` 有序关闭索引快照，含 BigInt 转字符串及还原）。`inspectRecordingDirectory` 按 `journal.otj` 帧序列交叉校验 `raw.otbin`/`data.otd`/`manifest.json` 区分 `completed`、`interrupted`（含未完整关闭、尾部截断与未提交尾部字节及可恢复前缀长度）、`failed`（ENOSPC/短写/后写失败但保留已提交前缀）和 `corrupted`。
  - 新增 `src/trace/trace-range-index.ts`：`TraceRangeIndex` 按 `(bootGeneration, segmentId)` 分区隔离多段相对 tick 回零；常规页用紧致边界与前缀 `maxEnd` 二分剪枝，跨时间页长区间归入 `longSlices`/`longActivations`/`longReadyWaits`/`longMarkers` 专用分页；支持 `relative-ticks`、`absolute-ticks`、`ns`、`relative-ns`、`byte-offset` 半开范围 `[start, end)` 精确相交及未锚定段显式排除；支持超限后将较早页目录溢写至 `index-spill.otidx` 并维持可量化内存上限；提供仅用于展示的 LOD 桶摘要聚合。
  - 新增 `src/trace/trace-recording-store.ts`：`TraceRecordingStore` 驱动或消费 4.1/4.2 批次，具备有界写缓冲、有界 LRU 页缓存、有界内存索引、精确原始流导出（逐块 CRC32 校验，仅写入尚不存在的非录制目标且通过独占临时文件原子重命名提交，拒绝自导出、同 `dev/ino` 别名与已有目标）、原子目录创建（`wx+` 独占建档与目录锁，拒绝覆盖非空目录并在初始化失败时仅回滚本次新建文件）、前置无副作用校验（身份/boot/序列拒绝不推进解码状态；不可回滚派生超预算时立即终止为 `failed` 并保留既有提交前缀）、`ENOSPC`/短写/后写 EIO 回滚、幂等关闭及支持 `AbortSignal`/`SharedArrayBuffer` 协作让步的可取消分页查询。`finish()` 封存写日志后保留只读句柄至 `close()`。
  - 新增 `src/trace/trace-worker-protocol.ts`、`src/trace/trace-worker.ts`、`src/trace/trace-worker-client.ts` 与 `esbuild.config.js`（新增 `dist/trace-worker.js` 打包入口，且支持 `tsc` 编译产物直接由 `node` 运行）；同步更新 `.vscodeignore` 排除 `out/rtos-stage*` 阶段验收目录并保留 `dist/trace-worker.js` 与原有 native 产物：`TraceWorkerRuntime` 按 `recordId` 严格隔离录制槽位、消费队列、单槽聚合 `progress` 通知与拉模式原始导出流；`TraceWorkerClient` 对 `ingestChunk`/`ingestDecoded` 施加在途与等待双预算（超限立即拒绝且不保留输入引用）、在发送前强制 `maxPendingQueries` 上限、管理无二次 release 的 `SharedArrayBuffer` 取消槽位，并实现幂等有序关闭。
- 设计变更：将 `TraceRecordingStore.finish()` 与 `close()` 职责解耦，`finish()` 仅封存写日志并转换状态为 `completed` 以便同一录制实例在显式 `closeRecording` 前继续响应范围查询、LOD 与原始导出；`orbit-trace-v1` 采用多文件录制目录以便 `raw.otbin` 直接对应纯源字节流并用 `journal.otj` 界定提交边界；尚未接入硬件、DAP/RTT 录制协调（4.4）、UI 泳道（4.5）及统计/公开 API（5）。
- 检查：
  - `npm run typecheck` 通过；`npm run build`（含 `dist/trace-worker.js`）通过；`git diff --check` 通过；`npx @vscode/vsce ls --no-dependencies` 核对确认排除全部 `out/rtos-stage*` 且保留 `dist/trace-worker.js` 及 `out/native/win32-x64/*.exe/.bin`。
  - 聚焦 Vitest（5 文件 44 项：`systemview-decoder.test.ts`、`systemview-reconstructor.test.ts`、`trace-format.test.ts`、`trace-recording-store.test.ts`、`trace-worker.test.ts`）全部通过（`trace-worker.test.ts` 改用已提交 `continuous.bin` 构造内存循环流，耗时 617 ms，无 `out/` 依赖）。
  - 默认 `npm test`（116 文件、1486 项通过、1 项已有跳过，12.20s）全部通过。
  - 独立验收脚本（均在 `out/rtos-stage4/acceptance-4.3/`）：
    - `node out/rtos-stage4/acceptance-4.3/independent-worker-million.cjs`（1,002,005 事件 / 167,000 周期 / 2,505,036 字节，SHA256 `9cda46b51f5a0a952a50ef96360fcacd83866943409a2b1945d10cf9a1ae8548`）：`ingestedMs=9619.05 ms`、`finishMs=13.43 ms`；`data.otd=194,527,030 B`、`index.otidx=489,387 B`、`journal.otj=569,443 B`、`raw.otbin=2,505,036 B`、`manifest.json=1,328 B`；查询 `[2700103, 2700132)` 命中精确 oracle `[2700103, 2700106, 2700111, 2700118, 2700129, 2700131]`（4 页）及切片 `isr [2700111, 2700118)`、`task [2700118, 2700129)`；Worker 峰值堆 `183,193,176 B`、峰值 RSS `420,593,664 B`、Host 峰值 RSS `423,100,416 B`、LRU 缓存峰值 `2/8` 页（`277,236 / 1,048,576 B`）、内存页描述符 `951 / 16,384`。
    - `node out/rtos-stage4/acceptance-4.3/independent-worker-million.cjs --smoke`：100 周期 1,536 字节通过。
    - `node out/rtos-stage4/acceptance-4.3/independent-host-waiters.cjs`：96 并发批（1 批 / 64 KiB 限制）仅保留 1 个 waiter（65,536 B），2 次成功、94 次即时背压拒绝，通过。
    - `node out/rtos-stage4/acceptance-4.3/independent-recording-path-integrity.cjs`：已有目录重创建返回 `RecordingDirectoryNotEmpty` 且 68 B 原文件 SHA256 不变，自导出 `raw.otbin` 返回 `ExportPathConflict` 且原文件无截断，通过。
    - `node out/rtos-stage4/acceptance-4.3/independent-rejected-batch.cjs`：seq=3 乱序被 `BatchSequenceGap` 拒绝后重送 seq=2/3，首任务 offset=35/ticks=110、末包 offset=66/ticks=210 与手算 oracle 一致，原始导出精确 68 字节，通过。
    - `node out/rtos-stage4/acceptance-4.3/verify-tsc-node.cjs`：以 `tsc` 编译产物直接由 `node` 拉起 `worker_threads` 并完成录制、查询、导出与退出码 0 关停，通过。
- 硬件：未执行；4.3 为离线存储、索引与 Worker 接线阶段，不连接或操作实板。
- 证据：`src/trace/trace-format.ts`、`src/trace/trace-range-index.ts`、`src/trace/trace-recording-store.ts`、`src/trace/trace-worker-protocol.ts`、`src/trace/trace-worker.ts`、`src/trace/trace-worker-client.ts`、`src/trace/*.test.ts`、`esbuild.config.js`、`out/rtos-stage4/acceptance-4.3/independent-worker-million.json`、`independent-worker-smoke.json`、`independent-host-waiters.json`、`independent-recording-path-integrity.json`、`independent-rejected-batch.json`、`tsc-node-verify.json`。
- 独立复验：用 1,002,005 事件核对精确分页和 2,505,036 字节原始导出的一致性，复验主机等待预算、目录与自导出保护、乱序后重试与查询取消。实际强制退出 Worker 后，档案标记 interrupted，准确导出已提交的 65 B 前缀，保留 13 B 未提交尾部的诊断。默认全量 1486 项通过、1 项跳过。打包清单保留 Worker 和原生 helper，排除阶段验收目录。
- 剩余事项：4.4 接入 DAP/RTT 录制协调器并实测 Continuous、Single-Shot 和 Post-Mortem。
- 提交：`实现 RTOS 阶段 4.3：增加 Trace 存储与范围查询`。

## 4.4 / 2026-11-19

- 状态：已完成。自动化、独立模拟、VS Code 扩展开发宿主和 STM32H723 三种录制模式均已通过验收。
- 实现：
  - 新增 `src/trace/systemview-target-metadata.ts` 与 `src/trace/systemview-target-metadata.test.ts`：解析 DWARF 中 `_SEGGER_RTT`、`_SYSVIEW_Globals`（识别 `SEGGER_SYSVIEW_POST_MORTEM_MODE` 编译特征）与 `fixtureCapture` 字段布局；校验 RTT 描述符与 RAM 边界，计算 Single-Shot / Post-Mortem 环形时间顺序读取区间（不推进 `RdOff`）。
  - 扩展 `src/debug/dap-session.ts`、`src/rtos/rtt-coordinator.ts` 与 `src/debug/dap-session-trace-target.test.ts`：新增内部请求 `orbitTraceTarget`（`inspect`、`readState`、`readMemoryRange`）与 `orbitTraceBootChanged` 事件，经单选 SWD/RTT owner 与 `liveAccess: true` 有界读取目标状态与缓冲区；在 `RttConsumptionCoordinator` 新增 `drainConsumer` 与 DAP `orbitRttTransport` `drain` 动作及 `flushCallbackQueue`，在保持单物理 reader、每批预算、共享 RTT 多消费者单次分发、`pull` 模式及 3.4 `unsubscribe` 不变的前提下：对暂停前已推进 `RdOff` 并落入缓存队列的 `callback` 批次，在 `setConsumerPaused(..., false)`、`drainConsumer` 与新批次投递前严格按 FIFO 先交付较旧序号（同时支持回调 `return false` 拒收重新触发 `backpressured`），退订前无法接收的滞留队列如实触发 `host-drop` 丢包事件（不再静默滞留并造成下一序号跳变 gap）。
  - 新增 `src/trace/trace-recording-coordinator.ts` 与 `src/trace/trace-recording-coordinator.test.ts`：在 Extension Host 精确绑定当前 `vscode.DebugSession` 与 `(sessionId, sessionGeneration, bootGeneration)`，接入 Continuous / Single-Shot / Post-Mortem 三模式与 Worker 查询/导出透传；包含首次 `await` 前同步槽位预约与同 `recordId` 幂等重入、迟到 `createRecording`/`subscribe` 自清理、START 边界与陈旧 Up 积压防护、`batchSequence` 跳号 `transport-gap` 分段；`stopContinuous` 默认 `stopDrainTimeoutMs` 设为 `4000` 并于 `unsubscribe` 与在途批结算后单次采样同步写入 `channelInfo`、`error.diagnostics` 与 `manifest.failureDiagnostics`（含 `StopDrainHostDrop` / `shared-consumer-uncertain` / `unavailable`）；不自动 `halt`/`reset`，不对不确定 Down 写重试。
  - 扩展 `src/trace/trace-format.ts`、`src/trace/trace-recording-store.ts`、`src/trace/trace-worker-protocol.ts`、`src/trace/trace-worker.ts`、`src/trace/trace-worker-client.ts`：为 `finish` / `finishRecording` 增加显式 `terminalState: 'completed' | 'interrupted' | 'failed'` 与 `failureCode` / `diagnostics`，非正常结束写 `FAILURE_MARK` 并保留已提交有效前缀，`manifest.json` / `journal.otj` / `open()` 重开状态一致，保留 4.3 正常完成路径不变。
  - 扩展 `src/extension.ts`：绑定会话生命周期与自定义事件，注册内部命令 `orbit.internal.traceRecording` 并在 `ExtensionMode.Test` 返回 `{ rtosProvider, traceCoordinator, extensionContext }`，保持 4.5 UI 泳道与 5.x 公开 API/MCP 边界不提前扩张。
- 设计变更：将 `orbit.internal.traceRecording` 作为阶段 4.4 的 Extension Host 内部调测与验收入口；针对 `codex-r3-h7-low-rate-tail.json` 与 `codex-r3-h7-low-rate-timeout.json` 暴露的 `inFlight` 读落入 `callback` 消费者缓存队列在恢复时未被 FIFO 清空的问题，增加 `flushCallbackQueue` 与退订丢包显式上报。
- 检查：
  - `npm run typecheck` 通过（0 errors）；`npm run build`（含 `dist/extension.js`、`dist/debugadapter.js`、`dist/trace-worker.js` 等全部产物）通过；`git diff --check` 通过。
  - 聚焦 Vitest（`src/rtos/rtt-coordinator.test.ts` 5 项 + `src/trace/trace-recording-coordinator.test.ts` 10 项，及 `systemview-target-metadata.test.ts` 4 项、`dap-session-trace-target.test.ts` 2 项）：覆盖悬挂 `inFlight` 读暂停入队 -> 恢复/`drainConsumer` 严格按序投递与共享消费者单次接收、回调拒收背压、退订未消费 `host-drop`、R3 三处快照一致与 `StopDrain*` 诊断，全部通过。
  - 独立模拟复验与真实 Extension Host 验证（`out/rtos-stage4/acceptance-4.4/`）：
    - `node out/rtos-stage4/acceptance-4.4/independent-start-race.cjs`（`pass: true`）。
    - `node out/rtos-stage4/acceptance-4.4/independent-stale-start-confirm.cjs`（`pass: true`）。
    - `node out/rtos-stage4/acceptance-4.4/independent-interrupted-manifest.cjs`（`pass: true`）。
    - `node out/rtos-stage4/acceptance-4.4/verify-vscode-host.cjs`（`pass: true`）。
    - `node out/rtos-stage4/acceptance-4.4/offline-acceptance.cjs`（`allOfflineEvidencePresentAndPassing: true`）。
  - 默认全量 `npm test -- --minWorkers=1 --maxWorkers=2`（**119 文件、1503 项通过、1 项已有跳过**，31.14s）。
- 硬件：在现有 `h7vgt6_test` 扩展开发宿主使用 STM32H723VGT6 与 RMLink 二号机（`b81f3fc30470`、固件 0.3.4、Wi-Fi 512 B、SWD 4 MHz）。沿用阶段 0 的 FreeRTOS 10.3.1 和 SystemView 3.32 样本对象。原 ELF 的加载段重叠，在专用测试目录使用显式 Flash 和 DTCM 加载段重新链接后烧录，链接脚本和段布局记录在验收目录。
  - Continuous 标准负载落盘 19,123 B、解码 3,232 包，目标过载计数 1,609，归档保留溢出状态。停止后 `RdOff = WrOff = 509`。
  - Continuous 低负载用同一夹具的 100 Hz Tick 变体，在读请求进行中暂停宿主，积压 5,019 B 再停止。落盘 6,666 B、解码 1,091 包、目标零丢包，只出现正常的 EOF 段结束记录。实测 `RdOff = WrOff = 7418`，恰等于预启动剔除的 752 B 与归档的 6,666 B 之和。
  - 同一低负载在 50 ms STOP 排空预算下返回 `StopDrainTimeout`。目标实测 `RdOff=3090`、`WrOff=7656`，返回值和磁盘都记录还剩 4,566 B。归档标为 `interrupted`，离线重新打开并核对了已提交的 2,219 B 和 SHA-256。
  - Single-Shot 读出 499 B，Post-Mortem 读出回卷后的 8,191 B。两者与独立读取的目标环字节及 SHA-256 一致，冻结代次和读写游标一致。Post-Mortem 标出 `prefix-overwritten`，解码 846 包和 616 个 Marker 点。
- 独立复验：`npm run typecheck`、`npm run build` 和 `git diff --check` 通过，完整 Vitest 1503 项通过、1 项跳过。独立 START 竞态、旧数据确认及中断归档脚本通过。
- 证据：`src/trace/systemview-target-metadata.ts`、`src/trace/trace-recording-coordinator.ts`、`src/rtos/rtt-coordinator.ts`、`src/debug/dap-session.ts`、`src/trace/trace-format.ts`、`src/trace/trace-recording-store.ts`、`src/trace/trace-worker*.ts`、`src/extension.ts`、`out/rtos-stage4/acceptance-4.4/{README.md,offline-acceptance.json,vscode-host-report.json,independent-*.json,codex-*}`。
- 剩余事项：4.5 接入 Trace Timeline。J-Link native 和 CMSIS-DAP WinUSB/HID 实板矩阵仍待补验。
- 提交：`实现 RTOS 阶段 4.4：接入实时与缓冲录制模式`。

## 4.5 / 2026-11-19

- 状态：已完成。独立自动化、两个真实 VS Code 宿主的集成和操作复验、H723 实板实时录制及归档重开均通过。
- 实现：
  - 新增 `src/webview/rtos/trace-timeline-state.ts`（与 `trace-timeline-state.test.ts`）和 `src/webview/rtos/trace-dto.ts`：保持 JSON-safe 字符串承载全部无损 `bigint` 相对/绝对 tick 与纳秒域，提供精确缩放/平移计算、时间域校验与非锚定/跨复位段隔离、缺口位置解析，以及 A/B 游标跨缺口/不确定段/不同时间域 `Δt` 连续性护栏。
  - 扩展 `src/trace/trace-recording-coordinator.ts`：新增 `onDidChangeStatus` 状态事件节流分发、串行入 `ingestChain` 的 `flushRecording(recordId)` 热提交支持，以及 `queryRange`/`queryLod` 的 `AbortSignal`/让步透传。
  - 扩展 `src/webview/rtos/rtos-view-state.ts`、`src/webview/rtos/rtos-provider.ts` 与 `src/extension.ts`：注入 `TraceRecordingCoordinator`；支持在无调试会话状态下独立保存（`orbit-trace-v1` 全套文件复制+可读校验）、打开、选择和关闭离线归档；支持实时热录制期间 350 ms 单飞 `flushRecording` 刷新已提交范围，视图隐藏/切换页面仅暂停轮询定时器与在途查询而不中止后台录制，销毁/切换记录/重启会话严格隔离过期异步回包；视口查询与 Hover/Cursor A/B 精确点查询各自携带递增序号与 `AbortController` 取消过期请求；保留现有 Watch、变量 Timeline、RTT Log、SVD/Mem/DAP 与阶段 2 Tasks/Objects/Timers/Heap 页面兼容。
  - 新增 `src/webview/rtos/trace-timeline-view.tsx` 并接入 `src/webview/rtos/app.tsx`：沿用现有 VS Code 主题令牌（`readTimelineTheme()` + `--vscode-*`）在单一 DPR 感知 `<canvas>` 上实现 Overview LOD 轨、ISR（含嵌套抢占含/独占与虚线轮廓）泳道、Task 运行条与 Ready 等待子轨、Markers 区间与点标记、缺口竖带与不确定段阴影、滚轮/按钮缩放、拖拽平移、Auto-Follow 随动与手动平移/缩离自动退出、Hover 与 A/B 游标精确查询，以及三种模式确认/错误/完成/冻结诊断条与 Chromium `rAF`/LongTask 采样。未提前扩张 5.x Contexts/CPU Load/Events/Terminal/CSV/SVDat/公开 API/MCP 或跨面板联动。
  - 冻结阶段 4 §10 Trace 性能门槛并落盘受控脚本与基准文档：`scripts/rtos/benchmark-trace-45.cjs`、`scripts/rtos/verify-stage45-vscode.js`、`scripts/rtos/vscode-stage45-driver.js`、`src/webview/rtos/trace-timeline-integration.test.ts`、`docs/system view/stage4-trace-performance-gates.json`、`docs/system view/stage4-trace-validation.md`。
- 设计变更：
  - 将所有跨 Webview `postMessage` 的 `bigint` 时间与持续时间转为十进制字符串 DTO，由视图侧还原为 `bigint` 运算，避免 JSON 序列化异常并保留 64-bit 时基精度；
  - 将热录制定时刷新严格限制在 Webview 可见、处于 Trace 子页且处于 `recording` 时以单飞 350 ms 节拍执行 `flushRecording`，绝不在 Webview 内另起目标通信链路，也不为不支持模式或未完成排空发自动 halt/reset。
- 检查：
  - 聚焦 Vitest（8 文件 79 项：`rtos-view-state.test.ts` 8、`rtos-provider.test.ts` 7、`trace-timeline-state.test.ts` 4、`trace-timeline-integration.test.ts` 4、`dap-session-realtime-variables.test.ts` 41、`dap-session-scopes.test.ts` 1、`native-scheduler.test.ts` 8、`watch-expression-validation.test.ts` 6）：全部通过（含阶段 0 固定样本、1,002,005 事件快速取消与无 halt/reset 热刷新）；
  - `npm run typecheck` 通过（0 errors）；`npm run build` 通过；
  - 全量 `npm test -- --minWorkers=1 --maxWorkers=2`：**121 文件、1512 项通过、1 项已有跳过（1513 总计）**；
  - §10 Node Worker 1M 基准（`node scripts/rtos/benchmark-trace-45.cjs`）：1,002,005 包（2,505,036 B / 668,000 slices）写入 `11002.71 ms`（`91,069 pkts/s`、`227,675 B/s`）、`finishMs = 42.02 ms`；LOD `p50=1.76 / p95=4.46 ms`、精确点 `p50=4.25 / p95=10.11 ms`、放大视口 `p50=5.02 / p95=12.24 ms`、12 次连续快速取消 `4.54 ms`（取消 11 次）；Worker 峰值堆 `106,739,968 B`、峰值 RSS `320,221,184 B`、LRU 缓存峰值 `30/64` 页（`8,365,182 B`）、页描述符 `847/16,384`；
  - 真实 VS Code 集成 UI 验收（`node scripts/rtos/verify-stage45-vscode.js`；返工 R2 在两个全新隔离 `--output` 目录 `r2-verify-1` 与 `r2-verify-2` 均复验通过）：确认原测试使用 `vscode.moveViews` 将 `ozoneRtos` 移回变空后隐藏的 `hideIfEmpty` Panel 容器 `workbench.view.extension.ozone-rtos-panel` 时，VS Code `moveViewsToContainer(..., 0)` 不会像内建 `ozoneRtos.resetViewLocation` 那样同步修复空容器位置、展开视图并 `openView`；测试驱动改走正当 `ozoneRtos.resetViewLocation` 入口并校验 `provider.isVisible === true`、Panel 切至 Watch 再切回确实隐藏/重显、恢复后的真实 Chromium Webview 渲染上报（`tracePerfSeq=4`）以及录制全程保持 `recording`。两轮全新隔离结果：`r2-verify-1` 1M 打开 `1483 ms`、10 次切换 `21 ms`、`lastDrawMs=1.5 / maxDrawMs=4.5 ms / over16msFrames=0 / longTasksOver50ms=0`；`r2-verify-2` 1M 打开 `1515 ms`、10 次切换 `21 ms`、`lastDrawMs=1.4 / maxDrawMs=3.6 ms / over16msFrames=0 / longTasksOver50ms=0`；阶段 0/5 份 H723 只读归档、Light/Dark 主题切换及 Post-Mortem 模式冲突均通过。
  - 阶段 2 面板 VS Code UI 回归（`node scripts/rtos/verify-stage2-vscode.js --output=out/rtos-stage4/acceptance-4.5/stage2-regression-vscode`）：通过。
- 硬件和实际操作：在原 `h7vgt6_test` 扩展开发宿主（VS Code 1.146.0）与 RMLink 二号机操作 Trace Timeline。100 Hz FreeRTOS 测试固件通过 UI 开始、跟随和停止，完成 58,803 B、9,797 包、3,387 个执行切片，目标和宿主丢包计数为 0。调试会话释放后，用原生保存和打开对话框保存副本并重开，独立核对 raw SHA-256 一致。
  - 真机回卷归档显示前缀覆盖、616 个 Marker 点，实际悬停查询得到 `EX_MARK markerId=5425 @off=827`，A/B 原始差值为 955,859 ns。打开 1,002,005 包归档，放大、平移并检视数据；原记录的游标状态没有进入新记录。
  - 独立用全新 VS Code 1.134.0 profile 复跑修订后的 UI 驱动，视图恢复到 Panel 后真实重绘、再次隐藏并重显，录制继续运行。百万事件测得 10 次视口切换 23 ms，采样 20 帧中最长绘制 3.7 ms，超过 50 ms 的长任务为 0。
  - 独立 Worker 性能复测为 92,244 包/s、230,613 B/s，精确点 p95 为 12.64 ms，连续 12 个查询取消了前 11 个并返回最后一个结果。实测对应已冻结门槛。
- 证据：`src/webview/rtos/{trace-timeline-state.ts,trace-dto.ts,trace-timeline-view.tsx,rtos-view-state.ts,rtos-provider.ts,app.tsx,trace-timeline-state.test.ts,trace-timeline-integration.test.ts,rtos-provider.test.ts,rtos-view-state.test.ts}`、`src/trace/trace-recording-coordinator.ts`、`src/extension.ts`、`scripts/rtos/{benchmark-trace-45.cjs,verify-stage45-vscode.js,vscode-stage45-driver.js}`、`docs/system view/{stage4-trace-validation.md,stage4-trace-performance-gates.json}`、`out/rtos-stage4/acceptance-4.5/{benchmark-worker.json,vscode-ui-report.json,r2-verify-1/{vscode-ui-report.json,verification.log},r2-verify-2/{vscode-ui-report.json,verification.log},stage2-regression-vscode/report.json,codex-benchmark-worker.json,codex-r2-vscode-091253/vscode-ui-report.json,codex-stage45-live-stop.json,codex-stage45-saved-copy.json}`。
- 剩余事项：5.1 增加上下文统计与 CPU 负载。30 分钟连续长稳与完整探针矩阵归阶段 6.2。
- 提交：`实现 RTOS 阶段 4.5：增加任务与中断泳道视图`。

## 5.1 / 2026-11-19

- 状态：已完成。独立手算样本、六份 H723 录制归档、真实 VS Code 操作及热录制回归均通过。
- 变更：
  - Worker 有界可取消分析聚合引擎：`src/trace/trace-analytics.ts`、`src/trace/trace-recording-store.ts`、`src/trace/trace-worker-protocol.ts`、`src/trace/trace-worker.ts`、`src/trace/trace-worker-client.ts`、`src/trace/trace-recording-coordinator.ts`。实现半开区间 ``start, end)` 与 64 位 `bigint` 精确裁剪、独占 CPU 时间与分箱守恒（`task + isr + scheduler + idle + unknown === binDuration`）、ISR 同时间戳嵌套独占归属与 `hasInclusiveNesting` 单独标识、完整激活（仅计窗口内完整激活样本计算 Min/Avg/Max）与越界裁剪计数、`taskInstanceId` 复用 TCB 地址隔离、Ready 延迟与缺失 `TASK_START_READY` 计入 `unknown`/排除不完整样本、Marker paired/point 统计、Gap/跨 boot/相对多段/跳频可验证性护栏与 `approx` 页预算降级，并修复 `OTD1` 页 `observedUntil` 孤立不完整项边界写入。
  - UI 状态、路由与联动视图：[src/webview/rtos/trace-timeline-state.ts`、`src/webview/rtos/rtos-provider.ts`、`src/webview/rtos/contexts-view.tsx`、`src/webview/rtos/trace-timeline-view.tsx`、`src/webview/rtos/app.tsx`。将共享 Trace 作用域/视口/`cursorA`/`cursorB` 提升至 `RtosApp`，接入 `ContextsView`（CPU Load 堆叠分箱 Canvas + 悬浮明细 + 点击分箱跳转 Timeline、视口/A-B 选区/全范围切换与缺端点护栏、Tasks/ISRs 统计表、Markers 表、阶段 5.2 Events/Terminal 占位提示），保持 `contexts` 页热录制定时器、宿主单调请求代次防重入与 Webview 重建不丢查询。
  - 验证与基准脚本：`src/trace/trace-analytics.test.ts`、`src/webview/rtos/contexts-view.test.ts`、`src/webview/rtos/rtos-provider.test.ts`、`scripts/rtos/benchmark-trace-51.cjs`、`scripts/rtos/verify-stage51-vscode.js`、`scripts/rtos/vscode-stage51-driver.js`、`scripts/rtos/vscode-stage45-driver.js`（R2 修正：修复 `cbe5e5e` 中 `latestViewportQuerySeq` 未重置导致 Explorer 首帧滞后 3.2s 掩盖的 `ozoneRtos.resetViewLocation` 后 Watch 面板抢占焦点时序，补齐 Explorer 与还原后 Panel 各自严格的 `tracePerfSeq` + `viewportRepliesApplied >= 1` + `readyCount > explorerReadyCount` 真绘制断言）。
- 验证：
  - `npm run typecheck` 通过；`npm run build` 通过；`git diff --check` 通过。
  - 聚焦测试（10 个文件，87 个用例）通过（含独立手算 SystemView 3.32.0 oracle 含同时间戳嵌套 ISR/Idle/Gap/Ready/Marker/跨边界/素数分箱末箱守恒/3-tick 极窄区间/长区间内窄查询/TCB 复用/64 位大 tick/Stage 0 样本与 4.4 post-mortem 只读副本/`1,002,005` 包取消与 `approx` 降级）。
  - 全量 `npm test -- --minWorkers=1 --maxWorkers=2`：123 个测试文件通过，1520 个用例通过，1 个既有跳过（`src/plugin-api/instance-registry.test.ts`）。
  - `node scripts/rtos/benchmark-trace-51.cjs`：百万事件 `1,002,005` 包 / `668,000` 切片全量精确分析 `P50=2094.67 ms`、`P95=2226.51 ms`、缩窄精确窗口 `P50=34.77 ms`、`P95=46.99 ms`、连续 12 次快速切换取消 `11/11`（总耗时 `355.82 ms`）、低预算页降级 `approx` 通过；6 份 H723 归档只读副本（`r4-standard` 33 段/`r4-low-rate-tail`/`r4-low-rate-timeout`/`r4-single-shot`/`r4-post-mortem`/`r45-saved-copy`）全部通过逐段守恒校验。
  - `node scripts/rtos/verify-stage51-vscode.js`（真实隔离 VS Code 1.134.0 Extension Host + Chromium Webview）通过：Stage 0 离线加载（`5.9 ms`）、6 份 H723 只读归档在 `Contexts` 页自动查询渲染、Mock DAP 热录制不 halt/reset 保持实时刷新绘制、百万事件 10 次连续切范围（`lastQueryMs=582.59 ms`, `lastDrawMs=0.6 ms`, `lastBins=120`）、切换回 Trace Timeline 绘制（`frameCount=5`, `lastDrawMs=2.3 ms`）及 Light/Dark 主题切换全部通过。
  - `node scripts/rtos/verify-stage45-vscode.js` 在全新隔离目录连续两次复跑均通过（`r2-stage45-run1`、`r2-stage45-run2`）：两次均实测 `explorerReadyCount=2`、`restoredReadyCount=3`、`restoredPerfSeq=5`、`restoredPanelHideShowVerified=true`、`survivedHideAndRecreate=true`、`haltedOrReset=false`，百万事件 10 次切换 `24-28 ms`、`over50msDrawFrames=0`、`longTasksOver50ms=0`、`droppedStaleReplies=0`。
- 独立复验：从 SystemView 3.32 记录器生成的 27 包样本核对 [135, 225) tick 共 90 ticks，Active 60、Idle 5、Unknown 25，6 个分箱守恒。IRQ17 含嵌套耗时 20 ticks、独占 15 ticks，IRQ18 只占自身 5 ticks。复用同址的两个任务实例独立计数。Ready 样本 7 与 5 ticks，Marker 300 为 5 ticks。另核对 3-tick 窄窗、非整除尾箱、百万归档小范围精确结果、页预算降级及 8 个过期查询取消。
- VS Code 实际操作：原 `h7vgt6_test` 扩展开发宿主打开手算样本并从 Trace Timeline 切换至 A/B 统计。74.686 µs 选区中 Active 55.830 µs、Idle 5.000 µs、Unknown 13.856 µs。实际切换到 Marker 表核对 5.000 µs。统计从归档读取。
- 回归复验：用同一份最终构建在全新隔离 profile 跑通 4.5 与 5.1。4.5 恢复窗口确认新的 Webview ready、帧上报和有效视口回包后，再次切换 Watch 与 RTOS，热录制连续。最终 typecheck、build、Vitest 1,520 通过和 1 跳过。
- 证据：`out/rtos-stage5/acceptance-5.1/{benchmark-and-oracle.json,vscode-ui-report.json,r2-stage45-run1/vscode-ui-report.json,r2-stage45-run2/vscode-ui-report.json,codex-final-vscode-45-132147/vscode-ui-report.json,codex-final-vscode-51-132147/vscode-ui-report.json,codex-independent-analytics-report.json,codex-real-host-analytics.json}。
- 剩余事项：5.2 虚拟化 Events 与 Trace Terminal、5.3 原始归档/CSV/SVDat 导出、5.4 跨面板时间光标/时钟域同步、5.5 公开 API 与 MCP 工具。
- 提交：实现 RTOS 阶段 5.1：增加上下文统计与 CPU 负载。

## 5.2 / 2026-11-19

- 状态：已完成（含第二轮返工修复）。离线已知样本、Codex 独立 33 包 Oracle、零参数字面文本与旧归档回归、6 份 H723 归档只读副本、真实 H723 `trace-continuous-8-1795082609526`（`Orbit H723 SystemView ready`，`b2:s1:p24@254`）Trace 终端零自激与双向精确跳转、`1,002,005` 事件 Worker/Chromium 有界虚拟化与严格 provenance 防过期提交，以及两轮独立新 profile 隔离 VS Code Extension Host 全套操作与 5.1/4.5/2 回归均通过。
- 变更：
  - 严格有限词法格式化与 FreeRTOS API/ELF 只读段解释：`src/trace/systemview-formatter.ts`、`src/trace/systemview-formatter.test.ts`。严格仅读取已提交记录及经校验的 ELF `.rodata` 常量字符串（不执行目标表达式或任意格式串，拦截 `%n` 与未解引用 `%s`，限定输入/输出/宽度/精度/参数上限并转义 C0/ANSI 控制字符）；无损保留 `numArgs === 0` 的目标已格式化字面文本（含 `%d/%x/%%`），`EX_PRINT_ELF` 缺少/失配/越界/NULL 时明确标注未解析状态；生成首版 FreeRTOS API 参数表、枚举语义、shrunk ID 解析结果与事件诊断 DTO。
  - Worker 有界虚拟分页、精确双向定位、Trace Terminal 流式追加与诊断存储：`src/trace/trace-events.ts`、`src/trace/trace-format.ts`、`src/trace/trace-recording-store.ts`、`src/trace/trace-worker-protocol.ts`、`src/trace/trace-worker.ts`、`src/trace/trace-worker-client.ts`、`src/trace/trace-recording-coordinator.ts`、`src/trace/trace-events.test.ts`。实现 O(1) 页跳过虚拟偏移定位、`SegmentPartition` 稳定 `bootGeneration`/`segmentId` 推导（兼容未带扩展诊断字段的 d12b96f 旧归档）、切片级执行上下文与嵌套 ISR 深度（`isrDepth`/`nestedIsr`）归属、同上下文同段 `SEGGER_SYSVIEW_FLAG_APPEND` 合并及跨断段/重启/孤立前驱断链诊断、可取消扫描、持久化 `decoderDiagnostics`/`reconstructorDiagnostics`（有界 512）与惰性首包元数据恢复。
  - Contexts 内置 Events 虚拟事件表、Trace 终端、双向跳转、防过期 Provenance 门控与测试驱动：`src/webview/rtos/trace-timeline-state.ts`、`src/webview/rtos/rtos-provider.ts`、`src/webview/rtos/events-view.tsx`、`src/webview/rtos/terminal-view.tsx`、`src/webview/rtos/contexts-view.tsx`、`src/webview/rtos/trace-timeline-view.tsx`、`src/webview/rtos/app.tsx`、`src/webview/rtos/events-terminal-view.test.ts`、`src/webview/rtos/contexts-view.test.ts`、`src/webview/rtos/rtos-provider.test.ts`、`scripts/rtos/{verify-stage52-vscode.js,vscode-stage52-driver.js,vscode-stage2-driver.js}`。
    - 在 `ContextsView` 增加 `events` 与 `terminal` 子标签（在事件/终端页折叠 CPU 负载图且不额外拉取分析聚合）、缩放虚拟滚动槽（总高上限 `2,000,000` px，每页 window `120` 行，DOM 仅渲染可视行）、右边界/全段查询含末尾同刻包（`displayMaxStr + 1n`）以及无条件读取记录级解码/重建/存储/缺口诊断抽屉。
    - 第二轮返工修复（Events / Terminal Provenance 与防自激）：为 `EventsView` 与 `TerminalView` 增加 `doesEventsResponseMatchProvenance` / `doesTerminalResponseMatchProvenance` 与 `minValidSeqRef` 序列门控，在快速切换过滤或防抖期间丢弃旧筛选/旧查询页响应并阻塞旧行交互（避免未筛选 1,002,005 旧页提前提交覆盖）；在 `ContextsView` 中以 `useCallback` 稳定事件与终端回调、并在 `EventsView` / `TerminalView` 中用 ref 持有回调，消除静止归档下诊断结果触发的 24ms debounce 饥饿与无限自激循环。
    - 第二轮返工修复（真实 H723 Terminal <-> Trace 双向精确身份保持）：`computeTimelineJumpForEvent` 返回规范化有效 `scopeKey`/`unit`（单段 `all-anchored` 规范为 `1:1`），`App` 将目标轴键与有效 `traceAxisDomain`（而非仅首选设置）比对并在 `pendingTimelineJumpRef` 消费时同时支持有效轴键未变的分支；`TraceTimelineView` 的 `buildJumpToEventsTarget` 在 Cursor A 同刻多包检查结果返回后保留已选中 `focusedEvent` 的精确 `bootGeneration`/`segmentId`/`packetIndexInSegment`/`streamByteOffset`（不让 `cursorAInspect.packets[0]` 覆盖）。
    - 第三轮返工定位与修复（阶段 2 回归 Panel 恢复焦点时序）：经实测对照，`rtos-provider.ts`（`resolveWebviewView`/`handleVisibilityChange`/`ready`）与 `extension.ts` 无产品回归；`vscode-stage2-driver.js:372` 超时及紧随其后的 `objects wait details` 超时均源于 Step 5 聚焦过 Watch 面板、Step 6 将 `ozoneRtos` 移至 Explorer 导致空 `ozone-rtos-panel` 隐藏后，仅调用 `vscode.moveViews` + 单次 `ozoneRtos.focus` 时 Watch 面板在 VS Code 1.134.0 中异步抢回焦点使 `isVisible=false`。参考 `vscode-stage45-driver.js` 保持 `10000 ms` 原超时与 Explorer/Panel remount 真实断言，改用 `ozoneRtos.resetViewLocation` + 防抖 `ensureRestoredPanelFocused()`（`workbench.view.extension.ozone-rtos-panel` + `ozoneRtos.focus`），并在 `app.tsx` `rtosUiTestAction` 增加只读 `tasks.getState` 验证恢复到 Panel 后 Chromium 真实渲染出 `ctrlB` 行及 Watch 显隐切换，将完整 `panelMoveTrace` 写入报告。
    - 未提前实现 5.3 CSV/SVDat、5.4 变量 Timeline 时钟域或 5.5 公开 API/MCP，亦未改动现有 Watch/Timeline/RTT Log/调试通路。
- 验证：
  - `npm run typecheck`、`npm run build`、`git diff --check` 与全量 Vitest（含 `src/trace/systemview-formatter.test.ts`、`src/trace/trace-events.test.ts`、`src/webview/rtos/events-terminal-view.test.ts`、`src/webview/rtos/contexts-view.test.ts`、`src/webview/rtos/rtos-provider.test.ts`）通过；
  - Codex 独立脚本校验通过：
    - `node out/rtos-stage5/acceptance-5.2/codex-target-literal-formatter.cjs`：`pass: true`（`literal=%d %x %%` 零参数无损保留）；
    - `node out/rtos-stage5/acceptance-5.2/codex-independent-events.cjs`：`pass: true`（兼容 d12b96f 归档 `bootGeneration=1`、`locateEvent` 精确命中）；
    - `node out/rtos-stage5/acceptance-5.2/codex-events-wide-viewport.cjs`：`pass: true`（`1,002,001` 事件前后页高效扫描）；
  - 两轮独立新 profile 真实 VS Code Extension Host + Chromium Webview DOM 验收与回归均通过：
    - `node scripts/rtos/verify-stage52-vscode.js --output=out/rtos-stage5/acceptance-5.2/vscode-ui-r2-run1` & `--output=out/rtos-stage5/acceptance-5.2/vscode-ui-r2-run2`：
      - 真实 H723 归档 `trace-continuous-8-1795082609526`（`codex-h723-host-start-stopped.json` 只读副本）：首次进入 Trace 终端即显 `1` 行 `"Orbit H723 SystemView ready"`，600ms 静止窗口 `staticIdleQueriesDelta=0` / `staticIdleDiagDelta=0`；真实点击「定位Trace」后立即落至 `2:1` / `relative-ns`、游标 A `100037015` 且呈现「在 Events 中定位」按钮，回跳后完整保留精确包键 `b2:s1:p24@254`；
      - Stage 0 三样本（含 `continuous` 双向 `Events <-> Trace Timeline` 定位）、Codex 33 包 Oracle（`xQueueGenericSend` 4 参数、`EX_PRINT_ELF @0x0801FFF0` 无 ELF 显式未解析、`locateAt182` `exactMatch=true`）、全部 6 份 H723 只读归档副本（DOM 均 8 行）、多启动/坏包/超限/孤立 ISR 退栈/跨重启 append 断链 7 条诊断；
      - `1,002,005` 归档严格按生效 provenance + `appliedQuerySeq` 锁定验收：DOM 8 行有界渲染、跳行 999,000 分别耗时 `52 ms`（run1）/ `56 ms`（run2），连续 6 次快速过滤取消分别丢弃 `7` / `8` 条过期响应后稳定收敛至 `settledAppliedFilter={category:'isr', searchText:'IRQ'}`、`settledFilterTotalMatched=167000`、`ISR_ENTER` `IRQ 17` 样本行且 250ms 后 `postSettleStable=true`；
      - Mock DAP 热录制无 halt/reset 及 Light/Dark 主题切换全部通过；
    - 回归 `verify-stage51-vscode.js`（`regression-5.1-r2`）、`verify-stage45-vscode.js`（`regression-4.5-r2`）全部通过；
    - 第三轮返工后 3 次独立全新 profile 阶段 2 回归与阶段 5.2 回归均一次通过：
      - `verify-stage2-vscode.js`（`regression-2-r3-run1`、`regression-2-r3-run2`、`regression-2-r3-run3`）：三次均录得 `method="resetViewLocation"`、`initialReadyCount=1`、`explorerReadyCount=2`（`explorerVisible=true`）、`panelReadyCount=3`（`panelVisible=true`、`panelFocusAttempts=1`）、`panelRenderedRows=1`、`panelRenderedCtrlB=true`、`restoredContainerVerified=true`；
      - `verify-stage52-vscode.js`（`vscode-ui-r3`）：含 Codex 同刻二包（`TASK_INFO` / `STACK_INFO @b1:s1:p6@52`）、H723 `b2:s1:p24@254` 与百万事件 `167,000` ISR 全部通过。
- 硬件：在 `D:/STM32/project/h7vgt6_test` 的 VS Code 1.146.0 扩展开发宿主新增 `Orbit: SystemView Trace (RMLink 2)`，使用收到宿主 START 后才录制的 STM32H723VGT6 测试固件。RMLink 二号机 `b81f3fc30470` 经 Wi-Fi、4 MHz SWD 探测到 `SysView` Up/Down ch2。界面启动并停止 Continuous 后归档完整，共 4,156 B、670 包，目标、传输与主机丢包计数均为 0。Trace 终端显示 `Orbit H723 SystemView ready`，事件详情与原始偏移 254 一致。UP 工程未参与测试。
- 独立复验：最终构建在全新 VS Code profile 中验证实录归档第一次打开终端即显示测试消息，游标 A 落在 `100037015` 相对 ns，返回事件列表仍选中 `b2:s1:p24@254`。另用同刻的 `TASK_INFO` 和 `STACK_INFO` 复验，检查器显示首包 `TASK_INFO` 时回跳仍选中 `b1:s1:p6@52`。百万事件筛选稳定得到 167,000 条 IRQ ISR，界面可见行保持 8 行。全量 Vitest 为 1535 通过、1 个既有跳过。证据见 `out/rtos-stage5/acceptance-5.2/codex-h723-acceptance.json`、`codex-r2-final-vscode-212459/vscode-ui-report.json`、`codex-exact-tie-vscode-212755/vscode-ui-report.json`。
- 证据：`src/trace/{systemview-formatter.ts,systemview-formatter.test.ts,trace-events.ts,trace-events.test.ts,trace-format.ts,trace-recording-store.ts,trace-worker-protocol.ts,trace-worker.ts,trace-worker-client.ts,trace-recording-coordinator.ts}`、`src/webview/rtos/{trace-timeline-state.ts,rtos-provider.ts,events-view.tsx,terminal-view.tsx,contexts-view.tsx,trace-timeline-view.tsx,app.tsx,events-terminal-view.test.ts,contexts-view.test.ts,rtos-provider.test.ts}`、`scripts/rtos/{verify-stage52-vscode.js,vscode-stage52-driver.js,vscode-stage2-driver.js}`、`out/rtos-stage5/acceptance-5.2/{README.md,codex-target-literal-formatter-report.json,vscode-ui-r3/vscode-ui-report.json,regression-5.1-r2/vscode-ui-report.json,regression-4.5-r2/vscode-ui-report.json,regression-2-r3-run1/report.json,regression-2-r3-run2/report.json,regression-2-r3-run3/report.json}`。
- 剩余事项：5.3 原始归档、CSV 与 SVDat 评估，5.4 变量 Timeline 时钟域映射，5.5 公开 Automation API 与 MCP。
- 提交前复验：重新构建后，阶段 2 的 RTOS Webview 在 Panel 重建并渲染 `ctrlB`，阶段 5.2 的 H723 跳转、同刻多包回跳和百万事件筛选再次通过。见 `out/rtos-stage5/acceptance-5.2/codex-r3-final-2-214557/report.json` 与 `out/rtos-stage5/acceptance-5.2/codex-r3-final-52-214557/vscode-ui-report.json`。
- 提交：实现 RTOS 阶段 5.2：增加事件列表与 Trace 终端。

## 5.3 / 2026-11-19

- 状态：已完成。独立复验通过归档保存与恢复、百万行 CSV、并发发布保护以及真实 VS Code 界面回归。
- 实现：
  - **Orbit 归档校验与精确前缀恢复**：`src/trace/trace-format.ts`、`src/trace/trace-recording-store.ts`。`inspectRecordingDirectory` 校对 `format`/`formatVersion`/`manifest.json`/`journal.otj`/`index.otidx` 与 `rawSha256`，区分 `rebuilt-bad-index`（坏索引按 `journal.otj` 重建）、`recovered-prefix-bad-chunk`（已提交块 CRC 损坏精确截断在最后有效提交边界）、`recovered-interrupted`（未完整关闭或尾部 `journal.otj` 帧截断且可验证前缀 SHA）及 `UnsupportedArchiveVersion`/`UnsupportedArchiveFormat`；`TraceRecordingStore.open` 拒绝不可恢复或高版本（如 `999`）归档并附带结构化 `diagnostics`。
  - **Worker 有界流式归档保存、原始流导出、提交时原子无覆盖发布与路径安全**：`src/trace/trace-format.ts`（`TraceFileSystem.link`）、`src/trace/trace-recording-store.ts`（`saveArchive`、`publishStagedFileNoOverwrite`）、`src/trace/trace-worker-protocol.ts`、`src/trace/trace-worker.ts`、`src/trace/trace-worker-client.ts`、`src/trace/trace-recording-coordinator.ts`。`saveArchive` 按 `journal.otj` 边界分块流式拷贝已提交前缀并在损坏索引场景自动重建干净 `index.otidx` / `index-spill.otidx`（经 `this.index.getCompactedBlocks().length` 判定）；`exportRaw`/`exportCsv`/`saveArchive` 采用提交时原子无覆盖发布（优先同文件系统硬链接 `link`，在 `EXDEV`/`ENOTSUP` 等场景回退排他创建 `'wx'` 分块拷贝，不再先检查再调用可替换既有目标的 `rename`，且绝不删除并发赢家或外部文件），在 `ENOSPC` / `ShortWrite` / `AbortSignal` / SAB 中途取消时清理自身创建的临时/半成品产物。
  - **有界流式 CSV 导出（LF 行约定 + RFC 4180 引号转义）与公式中和**：`src/trace/trace-events.ts`（`streamMatchedEvents`）、`src/trace/trace-csv-export.ts`（`TRACE_CSV_COLUMNS` 固定 39 列、`formatCsvCell`、`streamEventsToCsvWriter`）。支持 Trace 视口（`trace-viewport`）、A/B 选区（`ab-selection`）与 Events 分页筛选（`events-page`）在 Worker 中按页流式导出，约定 LF（`\n`）作为记录分隔符、单元格遵循 RFC 4180 引号规则并明确 `timeDomain` / `timeAnchorStatus` / `sysFreqHz` / `uncertaintyFlags`；对来自记录或 `manifest.json`（含 `recordId`、`filterSummary`、`eventName`、`category`、`eventKey`、`contextKey`、`contextLabel`、`summary`、`terminalText`、`diagnostics`、`rawPayloadHex`）的外部字符串在 CR/LF 规范化与首部空白/BOM 之后统一中和 `=`, `+`, `-`, `@`, `\t`, `\r`, `\n`，数值列继续保留原始数值输出。
  - **UI 能力声明、操作入口与 `.SVDat` 例外对齐**：`src/webview/rtos/trace-dto.ts`、`src/webview/rtos/trace-timeline-state.ts`、`src/webview/rtos/rtos-provider.ts`、`src/webview/rtos/trace-timeline-view.tsx`、`src/webview/rtos/events-view.tsx`、`src/webview/rtos/contexts-view.tsx`、`src/webview/rtos/app.tsx`。新增保存归档、导出 `.bin`、导出视口/选区/Events CSV 与明确展示 `− .SVDat 未支持`（`TRACE_ARCHIVE_CAPABILITIES.svdat.available = false`），保持 4.5 泳道、5.1 Contexts 与 5.2 Events & Terminal 兼容。
- `.SVDat` 独立评估结论：核对 `UM08027_SystemView.pdf`（V4.10b）虽在特定抓取模式下允许裸原始流命名为 `.SVDat` 或 `.bin`，但这不证明官方 GUI `File -> Save Recording` 生成的带元数据归档可双向互通；本机 `Sample/*.SVDat` 含 `;` 文本元信息头，`License_SystemView.txt` 录有 SFL/CUL 条款文本，且 Codex 实测本机 `SystemView.exe V4.10b` 打开 H723 `.bin` 在加载前即被 `"No Commercial-Use License"` 对话框阻断（`out/rtos-stage5/acceptance-5.3/codex-official-viewer/observation.json`）。Orbit 仅将裸原始流导出为 `.bin`，保留 `.SVDat` 能力不可用，不输出 `.SVDat` 文件。
- 变更：上述源码与测试 `src/trace/{trace-csv-export.test.ts,trace-format.test.ts,trace-recording-store.test.ts,trace-worker.test.ts}`、`src/webview/rtos/rtos-provider.test.ts`、脚本 `scripts/rtos/{verify-stage53-vscode.js,vscode-stage53-driver.js}`，以及文档 `docs/system view/{stage5-archive-validation.md,compatibility.md,protocol.md,plan.md,progress.md}` 与 `docs/rtos-debug-guide.md`。
- 检查：
  - `npm run typecheck`、`npm run build`、`git diff --check` 通过；
  - 聚焦异常与第二轮同路径并发、提交竞态、取消用例（6 个文件，37 个用例）通过。独立测试让另一写入方在提交时创建目标文件，分别覆盖硬链接与排他创建两种路径下的 `.csv` 和 `.bin`。四次均返回 `ExportTargetExists`，保留已写入文件并清理导出临时文件。见 `out/rtos-stage5/acceptance-5.3/codex-publish-proof-UZcLMj/report.json`；
  - `npm test -- --minWorkers=1 --maxWorkers=2`：`127` 个测试文件全部通过，`1,544` 个用例通过，`1` 个既有跳过（`src/plugin-api/instance-registry.test.ts`）；
  - `node out/rtos-stage5/acceptance-5.3/verify-stage53-offline.cjs` 与 `node out/rtos-stage5/acceptance-5.3/codex-probe-archive-csv.cjs` 通过：H723 健康/坏索引/坏块（`1388 B` 前缀 SHA `1457da6b...`）/截断 journal（`4156 B`）/拒绝版本 `999`、33 包 A/B `[140, 180)` 15 行（`5,440 B`, SHA `b194192d...`）、1M 全量 `1,002,005` 行 CSV（`316,864,544 B`, SHA `586c8591...`, `34,863 ms`, 宿主 RSS `434.8 MiB`）及过滤 `10` 行 IRQ、公式中和、路径保护与 `AbortSignal` 取消全通过；
  - `node scripts/rtos/verify-stage53-vscode.js` 在全新隔离 VS Code 1.134.0 Extension Host + Chromium Webview 通过全部离线打开、恢复 oracle、UI 保存/重开/`.bin`/视口 CSV/A-B 选区 CSV、百万 Events `167,000` 行筛选导出（DOM `8` 行有界）与 `.SVDat` 拒绝；
  - 同构建回归 `verify-stage52-vscode.js`（`regression-5.2-r2`）以及首轮 `verify-stage52-vscode.js`、`verify-stage51-vscode.js`、`verify-stage45-vscode.js` 与 `verify-stage2-vscode.js` 均退出码 `0` 通过。
- 硬件：未执行（本阶段全部在 Orbit 离线样本、独立 Oracle 与隔离 VS Code 宿主验证，未连接探针或修改 `D:/STM32/project/h7vgt6_test` / `UP`）。
- 证据：`out/rtos-stage5/acceptance-5.3/{stage53-offline-report.json,verify-stage53-offline.cjs,codex-oracles-WIIMu3/oracle.json,codex-official-viewer/observation.json,vscode-ui/vscode-ui-report.json,regression-5.2-r2/vscode-ui-report.json,regression-5.2/vscode-ui-report.json,regression-5.1/vscode-ui-report.json,regression-4.5/vscode-ui-report.json,regression-2/report.json}`。
- 剩余事项：`.SVDat` 因本机官方工具受 `"No Commercial-Use License"` 对话框阻断实测且缺乏官方 GUI 带元数据归档双向核验，能力保持不可用；下一小部分为阶段 5.4（跨面板时钟域同步与变量 Timeline 对齐）与 5.5（公开 API / MCP）。
- 独立复验：健康、坏索引、坏块与截断 journal 四份归档另存后均可离线重开，原始字节及可恢复前缀的 SHA-256 与样本一致。最终构建再次通过 5.3、5.2 的新 VS Code profile 验收。见 `out/rtos-stage5/acceptance-5.3/codex-io-probe-60n09M/report.json`、`codex-r2-final-ui-53-231101/vscode-ui-report.json`、`codex-r2-final-ui-52-231101/vscode-ui-report.json`。
- 提交：实现 RTOS 阶段 5.3：完成录制归档与离线回放。
