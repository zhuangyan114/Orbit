---
name: cmsis-dap-add-target
description: 为 Orbit 的 CMSIS-DAP/DAPLink 链路新增或扩展芯片型号、容量及 Flash 算法支持，整理器件资料、实施最小适配、完成分层验收并准备 PR。用于新芯片适配和适配 PR 审查；一般调试故障使用 daplink-debug-fix。
---

# CMSIS-DAP 新芯片适配

面向 Orbit 贡献者与编码助手。按贡献范围提供可追溯的型号描述、可构建的算法、覆盖边界的测试、明确的硬件验证状态，以及便于复核的 PR。算法、Flash 参数及对应测试仅适用于本次声称或修改的能力；资料贡献、仅调试适配及复用已有实现的未改动项，分别说明不适用、复用依据或待补状态。仓库根目录是本文路径的基准；本 skill 文件夹内的链接按相对路径解析。

CMSIS-DAP 提供探针与主机之间的访问协议，芯片的 Flash 控制器、容量、扇区、RAM、缓存和安全状态仍需具体适配。不要把一种芯片成功的结果外推为整个系列可用。拥有开发板的人提供实板证据，没有开发板的人可以整理资料、实现和补测试，并提交标明缺口的 Draft PR。

## 开始前

1. 阅读根目录 [AGENTS.md](../../../AGENTS.md)、[DAPLink 准则](../daplink-debug-fix/SKILL.md) 和 [调试修复流程](../ozone-debug-fix/SKILL.md)。执行 `git status --short`，保留已有改动。
2. 明确新增的完整型号、接受的别名、容量、板卡、探针和目标能力：仅调试、Flash，或附带 RTT/Viewer。分别记录实现与验收状态；不要默认扩大到同系列其他容量。
3. 用 CodeGraph 了解注册表、算法加载和 owner 调用关系；文档、型号字符串、日志使用直接读取或 `rg`。CodeGraph 不可用时按仓库规则处理，不因工具缺失停止其余独立工作。
4. 给出改动范围、现有功能可能受影响的部分、撤销本次适配的方法和验证计划。任务授权足够时直接推进；实板写入和发布仍遵守原有授权范围。

## 一、先建立器件资料表

按 [资料来源与改动边界](references/sources-and-boundaries.md) 记录来源 URL、文档编号/版本、页码或章节、访问日期、源码 commit 和许可判断。优先厂商数据手册、参考手册、勘误与正式器件包；协议和算法 ABI 使用官方规范。社区案例用于寻找线索，不能单独支持寄存器或容量事实。

按目标能力至少确认以下相关信息；不能确认的项目列为缺口：

- 完整型号及别名的覆盖范围、内核/架构与端序；DPIDR、芯片家族 ID、容量寄存器及其可读条件。原始 ID 不能证明的封装信息由板卡/工程补充。
- Flash 基址、每个 bank、全部扇区边界、物理编程粒度、擦除值、保护状态、缓存维护和超时依据。
- ELF 允许使用的 RAM 窗口，以及算法代码、`static_base`、页缓冲区、栈实际使用的可访问 RAM。不能把 RAM 容量简单相加当作连续地址空间。
- 算法源码/镜像来源与许可、入口/返回约定、构建工具链；SVD 对应关系和许可（需要外设视图时）。

资料冲突先查勘误和具体型号，保留差异。硬件读值与配置冲突时保留 raw 数据并拒绝不匹配的 Flash；不得自动降级到邻近型号、最大容量或其他 owner。

## 二、选择最小实现范围

优先在 `src/ozone-backend/cmsis-dap-flasher.ts` 中增加 `FlashTargetDefinition` 和明确的别名，复用已经适配的传输与 Cortex-M 控制。只有确有控制器、ABI 或协议差异时才扩展对应层，并提供独立复现及回归。

| 位置 | 允许的适配内容 | 必须保留的边界 |
| --- | --- | --- |
| `src/ozone-backend/cmsis-dap-flasher.ts` | 型号、RAM/扇区、preflight、算法元数据；数据模型确实无法表达新器件时作最小扩展 | 精确范围、结构化错误；`p_vaddr` 为运行地址，`p_paddr` 为 Flash LMA |
| `native/cmsis-dap-flash-algorithm/`、`scripts/build-native.ps1` | 自研源码、链接布局、按目标/容量构建镜像 | 可复现构建；旧容量边界、入口和 ABI 不被隐式扩大 |
| flasher/helper/session 的测试与 `scripts/cmsis-dap*` | 型号边界、raw frame、native 校验及回归 | mock oracle 独立于 production 常量；mock 结果与真机分开 |
| `src/debug/svd-resolver.ts`、相关测试 | 新器件的 SVD 名称或解析映射 | 保留用户指定 SVD 的优先级；SVD 失败不擅自选其他芯片 |
| `native/cmsis-dap-helper/src/`、helper channel、session routing | 有证据的公共校验/能力扩展 | TypeScript/C++ 协议同步；不弱化校验，不新建 owner |
| README、用户文档、算法参考文档 | 支持矩阵、配置、资料及验收状态 | 区分源码、包内产物、发布和硬件验收；修复日志另遵守用户确认规则 |

新增目标通常不需要修改 J-Link、通用 DAP UI、采样调度或全局默认型号。如确实需要，PR 中解释依赖和影响，并补相关回归。具体文件与符号的索引见来源参考。

### 代码风格

- 遵循附近 TypeScript/C/C++ 风格：TypeScript 使用明确类型、readonly 元数据和现有错误类；C/C++ 保持现有命名、缩进及整数宽度，地址用十六进制并标明单位。
- 型号和别名采用明确的 uppercase 条目，允许统一 trim/大小写归一化；不用模糊前缀或宽泛正则把不同容量归为同一目标。
- 参数放入目标描述；公共控制代码不散落型号字符串分支。共享算法必须证明寄存器、编程粒度与 ABI 相同；容量不同可以从同一源码构建独立镜像。
- 非显然的寄存器、缓存、bank/扇区编号写明文档章节；不把整份手册抄入源码。寄存器事实参考与代码复制的许可判断分开。
- 所有 `OzoneCommandResult` 先检查 `.ok` 再读 `.data`。使用 `logger.ts` 的共享分类并为 CMSIS-DAP 加 `[cmsis-dap]` 前缀，保留 owner、操作、耗时、状态和错误码。
- Git 提交信息与 PR 标题/正文使用中文；器件名、符号名与命令保留原文。不要在未被要求时提交、推送或合并。

### 不得改变的契约

- `probe: "cmsis-dap"` 只使用一个 CMSIS-DAP helper owner；Flash、Watch、Timeline、RTT、Memory/Peripheral/RTOS View 复用它。不得通过 J-Link/OpenOCD/GDB 或第二个 helper 回退。
- 保留 `control > watch > timeline > background`，控制和 Flash 的完整临界区排除低优先级读取；保留 session/generation fence 与标准 DAP memory/variables 能力。
- `flashBeforeDebug: false` 不擦除、编程、校验或执行 Flash 专用复位。Flash 前先完成身份、容量、ELF 段、算法及 RAM 布局检查；只擦除 ELF 涉及的扇区，不默认 mass erase，不写 Option Bytes。
- 擦除扇区大小、物理编程粒度、ProgramPage 大小和 RAM 页数据长度是不同量。校验实际传输数据占用，不把大扇区大小当成 RAM 缓冲区大小。
- 保留 PC/Thumb、可信 BKPT、返回码、栈对齐、代码/缓冲区/栈不重叠与范围校验。算法错误、取消、设备丢失或写入结果未知时不能盲目重试，不能自动换算法。

## 三、测试必须跨过真实实现边界

先针对本次改动运行 focused 测试，再执行 [验收流程与标准](references/acceptance.md)。实现 PR 按新增或修改的能力至少覆盖以下相关用例；资料 PR 核对来源与范围，不要求未实现能力的测试：

1. 型号/别名解析、错误容量与错误芯片拒绝；失败在 Flash 操作前发生。
2. 所有扇区的映射、最大扇区、最后扇区/最后合法字节、跨扇区页和越界；不同容量不互相放宽。
3. `.data` VMA/LMA、纯 `.bss`、重叠/溢出 ELF、RAM 窗口边界和代码/缓冲区/栈布局。
4. 编程对齐与擦除/编程/Verify、缓存、保护错误、超时、取消、未知写入结果和清理；按本次新增或复用的行为选择用例。
5. Flash 与非 Flash 启动、选定 owner、现有目标与 J-Link 回归。

若变更触及 native 参数校验或芯片算法，必须有使用实际 native helper 的 mock/selftest/RPC 用例。只 mock 掉 `runAlgorithm()` 的 TypeScript 测试不能替代这一层。新算法镜像应经入口/BKPT/ABI 检查；修改公共行为应先保存失败复现再验证修复。

## 四、分层实板验收

按只读身份 → RAM stub → Init/UnInit → 授权测试扇区 → 具体 ELF 完整烧录/校验 → 调试/运行时 → 断线与长稳推进。完整证据字段、最低重复次数、通过条件和失败停止规则在 [验收参考](references/acceptance.md)。

只在现有用户授权范围内操作目标。记录板卡、电源/VTref、probe VID/PID/serial、HID/WinUSB、helper/固件/ELF 版本及 SHA。失败证据与后续成功重验并存。HID 成功不代表 WinUSB 已通过；一个封装/容量成功不代表所有别名都有独立实板证据。

允许资料 PR 和未有实板证据的实现 Draft PR。任何“已支持/已验收”说明都要限定能力、型号、探针和验证层级；用户“已正常使用”的确认可记录为基本使用确认，不补造全扇区、异常或长稳结果。

## 五、准备 PR 与更新文档

使用 [PR 模板](references/pr-template.md)，先写新增型号和用户可见行为，再给出资料、改动边界、自动化结果、实板记录、风险/缺口和回退方法。没有硬件时明确 Draft 或待验收状态。PR 不提交本机绝对路径、临时输出、凭据、私有固件或无许可的算法二进制；用可共享的源码/fixture、摘要和经检查的日志支持结论。

同步 README/用户文档的型号、配置和状态，以及算法参考文档的来源/许可。`docs/bug-fix-log.md` 只在用户明确确认修复后新增记录，不为计划或 mock 成功写“真机通过”。

准备发布产物时从源码构建，不手改 `dist/`；检查 VSIX 内 helper、目标算法与运行依赖，并对比本次构建的哈希。包生成、安装和 Marketplace 发布是三个独立状态，发布不是本 skill 自动授予的权限。
