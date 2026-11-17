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

## 0.2 / 0.3 检查入口

契约、来源和录制模式依据见 protocol.md。fixture 构建、样本生成与检查命令将在 0.3 完成后补入本节。各条结果只标注实际完成的层级，阶段 1 快照引擎、UI、实板和长稳均未开始。
