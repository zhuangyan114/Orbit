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
