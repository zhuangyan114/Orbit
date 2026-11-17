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
