# RTOS 验证方法与证据

## 0.1：原有自动化基线

执行日期：2026-11-18。工作树初始干净；源码 HEAD 为 a48b46d82da3e0a458586047ce545a48ee864717。本阶段未创建硬件 owner。

| 环境 | 实际值 |
|---|---|
| 系统 | Windows 10.0.26100，X64 |
| VS Code | 1.145.2 / c4453f8ea430795f941c1b2ff6c9321135a74a02 / x64 |
| Node / npm | v24.15.0 / 11.12.1 |
| CMake | 4.4.0 |
| 目标 GCC | Arm GNU Toolchain 13.3.Rel1，13.3.1 20240614 |
| 主机 GCC | MinGW-W64 8.1.0，x86_64-win32-seh |

| 命令 | 结果与层级 |
|---|---|
| npm run typecheck | 通过；L3 类型检查 |
| npm run build | 通过；扩展、Webview、DAP、Timeline、Watch、symbol-picker 和 Node 客户端构建 |
| npm test -- --minWorkers=1 --maxWorkers=2 | 98 文件通过；1328 项通过、1 项跳过；23.25 s；L1/L2 自动化 |
| npm test -- --maxWorkers=2 | 首次启动失败，minThreads/maxThreads 冲突；未执行任何测试。补充 minWorkers 后通过，不修改仓库测试配置 |

完整测试输出位于本地 out/rtos-stage0/baseline-vitest.txt；测试日志中出现的 flash、halt 等来自 mock，不是硬件操作。构建时间、测试耗时不能作为目标读取或控制响应基线。

## 实板基线方法：阶段 1.4 执行

当前状态：未执行，数值未冻结。用户将本次范围收窄为阶段 0 离线交付；实板操作授权不能代替实测证据。

固定源码、同一 fixture ELF/hash、probe/固件、链路、SWD 频率、任务负载与 VS Code 实例，分别记录：仅调试、加 Watch、加 Timeline、加文本 RTT、再加快照。每个场景至少 60 s，控制操作至少 30 次。记录请求数、成功数、取消/错误、有效频率、读取字节、排队/I/O/解析耗时及控制响应 p50/p95，保存原始数据和统计脚本。

暂停态核对任务表；运行态快照不得额外 halt。1.4 依据对照数据冻结快照及控制响应门槛；当前不填暂停态 20 ms 或性能提升等未经测量的结论。原有控制超时、安全规则及 Watch/Timeline/RTT 生命周期保持有效。

三种 Trace 模式的实板配置、有效缓冲区、启停/冻结和读取结果在 4.4 验收；链路预算在 3.4 冻结。阶段 0 只验收源代码、构建、离线样本及可复跑方法。

## 0.2 / 0.3 离线验收

契约与来源见 [protocol.md](protocol.md)，工程入口见 [fixture README](../../scripts/rtos/fixtures/README.md)，固定结果见 [offline-evidence.json](offline-evidence.json)。

| 检查 | 实际结果 |
|---|---|
| python scripts/rtos/fixtures/build.py --update-samples | 初始生成 5 个独立样本；后续排除未使用的大小写兼容头，最终依赖集合以下一行检查为准 |
| python scripts/rtos/fixtures/build.py | 最终 63 个依赖 hash、10 个固件及派生无 DWARF ELF 通过；重新生成并逐字节比较 5 个样本通过，不需要更新期望值 |
| python -m unittest discover -s scripts/rtos/fixtures -p test_fixtures.py -v | 7 项通过；覆盖手工包期望、字节损坏、缺失检查、未冻结、截断、溢出误标完整及 vendor 篡改 |
| 隔离源码、空输出目录构建 | 最终 fixture 复制至 out/rtos-stage0/clean-source-final，从其自身目录构建至 clean-build-final；全部通过，无原应用或 Cube 包路径依赖 |
| 两次构建比较 | 11/11 可加载镜像字节一致；5/5 原始流及元数据一致。带调试信息 ELF 的 hash 不同，分别登记，不宣称整个 ELF 字节可重复；去除 DWARF 的 ELF 一致 |
| ELF 配置与尺寸 | .fixture_config 与变体一致；原生 StaticTask_t=100 bytes，关闭统计或栈高地址后=96 bytes；Ready 数组 8 优先级=160 bytes，CMSIS v2 的 56 优先级=1120 bytes |

内核根符号、列表入口、同名类型编译单元和 DWARF 成员存在性均已检查。无 DWARF 变体确实不含 .debug_info，保留普通内核符号。以上属于构建/静态证据，不表示已读出目标任务。

基本样本含十个手工可核算包；Continuous/Single-Shot 均为 68 bytes。Continuous 溢出样本为 8201 bytes，恢复后有 OVERFLOW；Single-Shot 溢出样本为 8190 bytes，冻结前处于丢包状态；Post-Mortem 保留 8191 bytes，含周期同步和覆盖前缀状态。样本 hash 见 JSON 证据，不把主机模拟的 1 MHz timestamp 当作实板频率。

开发中已解决：CMSIS v1 声明而未实现 osKernelInitialize，fixture 不调用该入口；CMSIS v2 自带 SysTick_Handler，保留其包装并避免 port 同名映射；补齐 RTT ConfDefaults；归一化 Windows nm 换行。第三方源码未修改。Post-Mortem 初始化缺项及所采用的官方自动分配配置见 protocol.md。

已知警告：固定 CMSIS v1 源码有未使用参数；64 位主机编译 SystemView 的未使用 pointer/heap API 有指针宽度转换警告。样本使用明确 32 位 ID，目标另检查 32 位 ABI；不据此宣称任意主机指针 API 可用。

本地记录为 out/rtos-stage0/fixtures-run.txt、fixtures-verify.txt、final-verify.txt、clean-build-final-run.txt，以及 fixtures/、clean-build-final/ 下的 verification.json、编译日志、符号和 DWARF 输出。工程、固定依赖、样本及摘要纳入 Git；构建产物和完整日志保留在 out/。

阶段 0 离线出口已满足。阶段 1 引擎、新运行时接口、UI、实板和长稳均未开始；本次独立 fixture 改动不触发未受影响的原生 helper/Flash Algorithm 验收。

## 1.4 实板基线与阶段出口（2026-11-18）

阶段 1 已补齐本文件规定的六组实板场景，并在最终无线片预算上完成三轮共存对照。数据、失败记录、冻结门槛和复跑方法见 [阶段 1 验收](stage1-validation.md)，原始文件 hash 与独立复算结果见 [阶段 1 证据](stage1-evidence.json)。上文阶段 0 的“尚未开始/未执行”保留为当时记录，不代表当前进度。

阶段 1 的类型检查、构建、1378 项测试（1 项跳过）、J-Link/CMSIS-DAP mock、独立工程重建、样本与实板通过。当前真实硬件证据只覆盖 H723/Wi-Fi RMLink；未把 mock 或离线配置扩展为其他路径验收。
