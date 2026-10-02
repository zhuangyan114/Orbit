# 资料来源与改动边界

## 权威来源

| 资料 | 用途 | 记录要求 |
| --- | --- | --- |
| 芯片厂商产品页、数据手册 | 完整订货型号、容量、封装、内核和 RAM | URL、文档编号/修订、页码、访问日期；明确实际验证的 SKU |
| 厂商参考手册与勘误 | Flash 寄存器、bank/扇区、序列、保护、缓存、调试访问限制 | 具体章节/表号与勘误适用的 silicon revision；不同系列不套用地址 |
| 厂商 CMSIS Device/DFP、SVD、Flash Algorithm | 交叉核对器件覆盖、寄存器和算法 ABI | Pack 版本、设备条目、算法覆盖范围、源码 commit、许可文件与依赖 |
| [Arm CMSIS-DAP Commands](https://arm-software.github.io/CMSIS-DAP/latest/group__DAP__Commands__gr.html) | 协议命令、packet 边界、响应格式 | 使用的规范版本/访问日期及具体命令页；独立维护 raw-frame oracle |
| [Open-CMSIS-Pack Flash Programming](https://open-cmsis-pack.github.io/Open-CMSIS-Pack-Spec/main/html/flashAlgorithm.html) | Init/UnInit/EraseSector/ProgramPage/Verify ABI、器件参数 | 使用的规范版本/访问日期，入口、参数、static_base 与链接约定 |
| 授权后的板卡原始读值、日志、ELF | 验证文档与实际目标相符 | 原始值、地址、板卡/probe/固件信息、日期、失败及成功过程 |

上面两份官方规范链接在 2026-10-02 检查可访问；后续贡献以实际访问时的版本为准。历史证据可参考仓库 [算法资料](../../../../docs/cmsis-dap-flash-algorithm-references.md)，但当前源码决定实现行为。

OpenOCD、pyOCD 等可辅助理解行为和对照现象，不能覆盖官方协议/手册。GPL 代码只作参考，不复制、翻译或链接到 Orbit 的 MIT 实现；其他代码和算法镜像也必须逐项审查许可与依赖。能下载 `.FLM` 不等于能随 VSIX 再分发。

Orbit 当前的算法加载接口读取原始镜像或 JSON manifest；CMSIS-Pack/FLM 是 ABI 和器件资料来源，不代表已经支持直接导入任意 `.FLM`。若要增加转换/解析能力，作为明确的额外实现范围说明并验证。自研算法以可构建源码交付，不提交来源不明的 blob。

## PR 中的器件资料表

复制到 PR 并填写实际事实；不适用字段说明原因。

| 项目 | 具体数值或范围 | 来源/版本/章节 | 实板原始读值或状态 |
| --- | --- | --- | --- |
| 完整型号、别名、容量 | 待填写 | 待填写 | 芯片标记/板卡/工程 |
| 内核、端序、DP/AP、DPIDR | 待填写 | 待填写 | 待填写 |
| 家族 ID 与容量校验 | 寄存器地址、有效位、单位、适用 revision | 待填写 | 待填写 |
| Flash/bank/扇区 | 基址、大小、全部边界 | 待填写 | 验证了哪些扇区 |
| 物理编程粒度与 ProgramPage | 两者分别填写，含对齐/填充/ECC | 待填写 | 待填写 |
| RAM 与 loader 布局 | 各窗口及可访问性；代码/缓冲区/栈/static_base | 待填写 | 哪些窗口实际验证 |
| 缓存、保护、供电、超时 | 擦除/编程/Verify 序列及时间依据 | 待填写 | 实测耗时与错误码 |
| 算法、SVD 与许可 | 源码/Pack 路径及版本、许可、构建工具链 | 待填写 | 镜像/ELF SHA256 |

共享 DEV_ID 常常只识别家族，不能区分完整型号；DPIDR 通常属于调试端口，也不是 MCU 订货型号。不得宣称仅凭这些值识别到精确封装。原始身份、配置型号、ELF 地址范围和算法覆盖范围应相互一致；无法证明的部分写为未确认。

现有 `FlashTargetDefinition.preflight` 针对芯片 ID 和以 KiB 表示的容量寄存器。新芯片若不适用该模型，应明确扩展数据模型和验证器，保留旧行为及测试；不能虚构 F4 寄存器读值或绕过 preflight 来凑接口。

## 当前代码入口

| 文件 | 关键入口/责任 |
| --- | --- |
| `src/ozone-backend/cmsis-dap-flasher.ts` | `FlashTargetDefinition`、`FLASH_TARGETS`、`resolveFlashTarget`、`validateFlashTargetDefinition`、`BUILTIN_FLASH_ALGORITHMS`、`loadFlashAlgorithm`、ELF/sector/RAM 规划和 `flashCmsisDapElf` |
| `src/ozone-backend/cmsis-dap-flasher.test.ts` | 型号与算法、preflight、ELF、Flash 流程回归 |
| `src/ozone-backend/session-target-channel.ts` | `SessionTargetSelector` 与 `CmsisDapTargetChannel`：选择、持有和复用唯一 owner |
| `src/ozone-backend/cmsis-dap-helper-channel.ts` | helper 协议、生命周期及调度入口 |
| `native/cmsis-dap-helper/src/main.cpp` | Flash RPC 参数与 ABI 转换、缓存复用、native selftest |
| `native/cmsis-dap-helper/src/cortex_m_debug.cpp` | `CortexMDebug::executeFlashAlgorithm`：RAM 校验、寄存器、可信 BKPT 和完成状态 |
| `native/cmsis-dap-helper/src/mock_transport.*` | 与真实 USB 无关的 native 目标模型/故障注入 |
| `native/cmsis-dap-flash-algorithm/` | 原创 C 算法及链接脚本；固定入口空间、代码和数据布局 |
| `scripts/build-native.ps1` | helper 与目标算法的可复现构建、复制产物 |
| `scripts/cmsis-dap/verify-flash-algorithm.js`、`scripts/cmsis-dap-smoke.js` | 镜像/源码契约与 JSON-lines native mock 验证 |
| `src/debug/svd-resolver.ts` 及其测试 | SVD 定位及器件映射 |

它们是当前维护入口，贡献前用 CodeGraph 看调用方和影响；文件迁移时同步本文，避免把路径清单变成架构事实。

## F407IG 的回归教训

2026-10-02，F407IG 的小扇区擦除通过，到扇区 5（`0x08020000`、128 KiB）时失败。native 校验曾用 `request.size` 计算 RAM 页缓冲区大小，实际 EraseSector 的 `data` 是空数组；它把 Flash 扇区容量误当成 RAM 占用。修复使用实际页数据长度，并新增 native selftest 与 RPC mock。

贡献新器件时，以最大扇区、实际 loader RAM 和页数据大小组合测试；即使主机规划测试和 H7 的大 RAM mock 都通过，也不能略过该组合。相同错误也可能影响其他使用大扇区的已有目标。芯片自研算法仍需实板执行与 Verify，helper mock 不会证明 Flash 控制器时序正确。
