# RTOS 验证矩阵

- 冻结日期：2026-11-18；阶段 0 不访问目标板。
- 基线源码：a48b46d82da3e0a458586047ce545a48ee864717。
- 本表的“构建”“离线样本”“实板”分别登记；测试版本不等于已支持版本。

## 选定配置

| 项目 | 固定输入 | 当前证据 |
|---|---|---|
| 候选板卡 | STM32H723VGT6，单核 Cortex-M7，小端、32 位指针 | 本地工程配置；芯片 ID、CPUID、RAM 与时钟待实板核对 |
| 候选链路 | Wi-Fi RMLink，Orbit 当前会话唯一 owner | 本次不连接、不烧录、不控制运行、不推进 RTT 指针 |
| 内核 | STM32CubeH7 1.12.1 所带 FreeRTOS 10.3.1 | tasks.c SHA256：6f540b927668e4c87a064749c03f6ee0ca7370b9dfae7d9d5e96ebd0fdf12b8d |
| port | portable/GCC/ARM_CM4F，沿用现有 H723VG 工程 | 0.3 编译通过；硬件适用性待 CPUID 核对 |
| API 包装 | 原生、CMSIS-RTOS v1、CMSIS-RTOS v2，均来自上述固定包 | 三种入口构建与静态检查通过 |
| allocator | heap_4；动态任务与静态任务均纳入场景 | 仅 fixture 范围，不声明所有 allocator 均可解析 |
| 目标工具链 | Arm GNU Toolchain 13.3.Rel1，GCC 13.3.1 20240614 | 当前命令行实际版本；不按安装目录名猜版本 |
| 调试构建 | -Og -g3 -gdwarf-4；优化变体 -O2 -g3 -gdwarf-4 | 0.3 固定构建参数和输出清单 |
| SystemView | 3.32.0 目标端记录源码 | SEGGER_SYSVIEW.c SHA256：e78081730955cf18083beb7b9bc8b8c645e67d8b45774782ebcead367575d116 |
| helper / DLL / SWD | 本次无活动硬件 owner，不选定 helper、DLL 或 SWD 时钟 | 后续实板记录实际选中路径，不能沿用历史设备状态 |

## 离线工程矩阵

| 变体 | 必要差异 | 当前状态（0.3） |
|---|---|---|
| native-debug / cmsis-v1 / cmsis-v2 | 同一内核，三种任务入口 | ELF/DWARF/内核根符号核对通过；实板未执行 |
| native-optimized | -O2，保留 DWARF | 构建与符号核对通过；实板未执行 |
| native-no-stats | 关闭运行统计 | 构建通过；StaticTask_t 从 100 降至 96 bytes |
| native-no-stack-bound | 不记录栈高地址 | 构建通过；StaticTask_t 从 100 降至 96 bytes |
| native-tickless | 开启 tickless | 构建通过；休眠统计口径待实板核对 |
| native-no-dwarf | 由 native-debug 去除调试信息，保留普通符号 | 已确认没有 .debug_info，内核普通符号保留 |
| trace-continuous / trace-single-shot / trace-post-mortem | 三种目标配置及确定性主机样本 | 目标 ELF 构建、5 份主机原始样本通过；实板未执行 |

固定依赖与工程见 [fixture 使用说明](../../scripts/rtos/fixtures/README.md)。63 个 vendor 文件的来源/hash 见 vendor-manifest.json；没有虚构原始包的 Git commit。CMSIS v2 的 ready 列表总大小为 1120 bytes，其他变体为 160 bytes，对应 56/8 个优先级，不能复用固定布局。

## 使用条件与后续验收

快照需要 ELF 普通符号、可解析的 DWARF 类型和有效 RAM 范围；栈容量需要可靠边界，水位需要已知填充值和增长方向，CPU 区间统计需要有效计数器及记账口径。缺少这些条件时逐字段不可用。

Trace 还需要标准记录组件、实际 SysView 通道及模式元数据。离线样本不能证明 Wi-Fi 吞吐、目标时间精度或三种录制模式在板上可用。

J-Link native、CMSIS-DAP WinUSB/HID、J-Link legacy 和其他 RMLink/XR 路径的新 RTOS 能力均未实板验收；保留总计划中的首版验收要求。

## 阶段 1 实板新增（2026-11-18）

| 范围 | 当前证据 | 支持边界 |
|---|---|---|
| H723 / FreeRTOS 10.3.1 / GCC ARM_CM4F / 原生 / heap_4 | 三个独立 API 检查点各 13 任务；任务、状态、创建编号、优先级、水位和累计计数一致 | 当前固定工程；不扩展为所有版本、allocator 或 port |
| Wi-Fi RMLink 二号机 / 0.3.4 / 4 MHz 请求时钟 | 唯一 CMSIS-DAP service owner；128-byte 后台片；运行态共存、暂停态、控制/会话隔离通过 | 实际 host 为 VS Code 1.146.0；不是 J-Link、WinUSB/HID 验收 |
| Live 任务字段 | 三轮 180.731 s，252 帧各 13 个新鲜任务字段；4 个完整图、263 个 partial 发布帧 | 全图一致性不足仍明确 partial；CPU 为有窗口说明的已结算计数估算 |
| 配置变体 | 新输出目录重建及类型图复验通过 | CMSIS v1/v2、优化、stats/stack-bound 关闭及 tickless 仍只有离线证据 |

上文“离线选定配置/阶段 0 当前状态”是阶段 0 的冻结记录。阶段 1 的精确环境、哈希、门槛及限制见 [验收报告](stage1-validation.md) 和 [原始证据索引](stage1-evidence.json)。阶段 2 内建面板、阶段 3 RTT 扩展、阶段 4 Trace 录制与阶段 6 其他链路/长稳门槛继续保留。

## 阶段 5.3 归档、CSV 与 SVDat 支持矩阵（2026-11-19）

| 格式 / 能力 | 状态 | 实际边界与依据 |
|---|---|---|
| Orbit 原始录制归档（`orbit-trace-v1` 目录） | 已支持 | 通过真实 Worker 保存/离线打开，支持 `manifest.json` 格式/版本号校验、`raw.otbin`/`data.otd`/`journal.otj`/`index.otidx` 逐帧 CRC32 与 `rawSha256` 核对；区分坏索引重建（`rebuilt-bad-index`）、坏块精确前缀截断恢复（`recovered-prefix-bad-chunk`）与未完整关闭恢复（`recovered-interrupted`），拒绝高于支持版本的归档（如 `formatVersion: 999`） |
| 原始 SystemView 二进制流（`.bin`） | 已支持（只读导出） | Orbit 仅将经 `journal.otj` 与 CRC32 校验的已提交 `raw.otbin` 裸原始流导出为 `.bin`；采用提交时原子无覆盖发布（`link` 优先，不支持时退回 `'wx'` 拷贝），禁止覆盖既有文件、目录内导出及 `.SVDat` 扩展名 |
| Trace CSV 导出（`.csv`） | 已支持 | 在 Worker 中有界分块流式导出 Trace 视口、A/B 选区与 Events 当前筛选范围；采用 LF（`\n`）行分隔、RFC 4180 字段引号转义（逗号、换行、单双引号）与原子无覆盖发布；固定 39 列元数据/时间单位/不确定性标志，对来自记录或 `manifest.json` 的外部字符串前缀中和 `=`/`+`/`-`/`@`/空白/`\t`/`\r`/`\n`，数值列保持原数值；不把百万事件或大文件整包传进 Webview |
| SEGGER `.SVDat` 导入 / 导出 | 不支持（保留例外） | 官方手册（`UM08027` V4.10b）对特定抓取场景允许裸流命名为 `.SVDat` 或 `.bin`，但本机 `Sample/*.SVDat` 带 `;` 文本元信息头，前者不证明 GUI 保存的带元数据归档可双向互通；`License_SystemView.txt` 包含 SFL/CUL 条款与第 `1(a)` 条限制描述，且本机 `SystemView.exe` V4.10b 打开 H723 `.bin` 在加载前即被 `"No Commercial-Use License"` 对话框阻断实测。Orbit 仅以 `.bin` 导出裸流，`.SVDat` 能力保持不可用，界面及接口均显式拒绝 `.SVDat` |

详见 [阶段 5.3 归档与 SVDat 评估报告](stage5-archive-validation.md)。

## 阶段 6 实板与安装复验（2026-11-21）

| 环境 | 已验证能力 | 仍需验证 |
| --- | --- | --- |
| STM32H723VGT6、FreeRTOS 10.3.1、RMLink 二号机 Wi-Fi 0.3.4 | Continuous 配合变量采样和控制交错运行 30 分钟，目标与主机丢包计数为 0。共享标记实测覆盖暂停前后，当前 RTT 联动保留近似提示。 | 其他探针、固件组合或更高 Trace 负载的等效表现。 |
| J-Link native、CMSIS-DAP WinUSB/HID | Windows 原生构建、mock、算法镜像检查与会话隔离回归通过。 | 当前版本的 RTOS 实板、吞吐和长稳。 |
| Windows x64 VSIX 1.2.1，VS Code 1.134.0 | 正常安装并打开归档，离线游标与 API、CMSIS-DAP 自检和 `koffi` 加载通过。 | 完整首版实板矩阵。 |

详见 [阶段 6 验收记录](stage6-acceptance.md)。
