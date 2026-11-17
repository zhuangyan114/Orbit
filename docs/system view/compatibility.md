# RTOS 离线验证矩阵

- 冻结日期：2026-11-18；阶段 0 不访问目标板。
- 基线源码：a48b46d82da3e0a458586047ce545a48ee864717。
- 本表的“构建”“离线样本”“实板”分别登记；测试版本不等于已支持版本。

## 选定配置

| 项目 | 固定输入 | 当前证据 |
|---|---|---|
| 候选板卡 | STM32H723VGT6，单核 Cortex-M7，小端、32 位指针 | 本地工程配置；芯片 ID、CPUID、RAM 与时钟待实板核对 |
| 候选链路 | Wi-Fi RMLink，Orbit 当前会话唯一 owner | 本次不连接、不烧录、不控制运行、不推进 RTT 指针 |
| 内核 | STM32CubeH7 1.12.1 所带 FreeRTOS 10.3.1 | tasks.c SHA256：6f540b927668e4c87a064749c03f6ee0ca7370b9dfae7d9d5e96ebd0fdf12b8d |
| port | portable/GCC/ARM_CM4F，沿用现有 H723VG 工程 | 编译与源码依据将在 0.3 记录；硬件适用性待 CPUID 核对 |
| API 包装 | 原生、CMSIS-RTOS v1、CMSIS-RTOS v2，均来自上述固定包 | 0.3 构建验收 |
| allocator | heap_4；动态任务与静态任务均纳入场景 | 仅 fixture 范围，不声明所有 allocator 均可解析 |
| 目标工具链 | Arm GNU Toolchain 13.3.Rel1，GCC 13.3.1 20240614 | 当前命令行实际版本；不按安装目录名猜版本 |
| 调试构建 | -Og -g3 -gdwarf-4；优化变体 -O2 -g3 -gdwarf-4 | 0.3 固定构建参数和输出清单 |
| SystemView | 3.32.0 目标端记录源码 | SEGGER_SYSVIEW.c SHA256：e78081730955cf18083beb7b9bc8b8c645e67d8b45774782ebcead367575d116 |
| helper / DLL / SWD | 本次无活动硬件 owner，不选定 helper、DLL 或 SWD 时钟 | 后续实板记录实际选中路径，不能沿用历史设备状态 |

## 离线工程矩阵

| 变体 | 必要差异 | 0.1 状态 |
|---|---|---|
| native-debug / cmsis-v1 / cmsis-v2 | 同一内核，三种任务入口 | 待 0.3 构建 |
| native-optimized | -O2，保留 DWARF | 待 0.3 构建 |
| native-no-stats | 关闭运行统计 | 待 0.3 构建 |
| native-no-stack-bound | 不记录栈高地址 | 待 0.3 构建 |
| native-tickless | 开启 tickless | 待 0.3 构建 |
| native-no-dwarf | 由 native-debug 去除调试信息，保留普通符号 | 待 0.3 构建 |
| trace-continuous / trace-single-shot / trace-post-mortem | 三种目标配置及确定性主机记录样本 | 待 0.3 验证 |

## 使用条件与后续验收

快照需要 ELF 普通符号、可解析的 DWARF 类型和有效 RAM 范围；栈容量需要可靠边界，水位需要已知填充值和增长方向，CPU 区间统计需要有效计数器及记账口径。缺少这些条件时逐字段不可用。

Trace 还需要标准记录组件、实际 SysView 通道及模式元数据。离线样本不能证明 Wi-Fi 吞吐、目标时间精度或三种录制模式在板上可用。

J-Link native、CMSIS-DAP WinUSB/HID、J-Link legacy 和其他 RMLink/XR 路径的新 RTOS 能力均未实板验收；保留总计划中的首版验收要求。
