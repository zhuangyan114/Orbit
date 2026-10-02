# 新芯片适配 PR 模板

标题使用中文并包含型号，例如 `支持 CMSIS-DAP 调试与烧录 STM32F407IG`。一个 PR 以一组有依据的型号/容量适配为核心；公共校验修复若为适配所必需，写清触发条件和已有型号的影响。正文从最终行为开始，不写聊天过程或 abandoned approach。

以下模板按实际覆盖填写。资料表见 [sources-and-boundaries.md](sources-and-boundaries.md)，验收基线见 [acceptance.md](acceptance.md)。不要把待填写项或未勾选项改成“通过”；没有板卡时标明 Draft/待硬件验收。没有要求时只准备 PR 文本，不自动提交或发送。

```markdown
## 新增行为

新增型号/完整 SKU：
接受的别名与容量：
用户配置示例（probe: cmsis-dap、device、实际 ELF、是否 Flash）：
连接/烧录/调试触发时，原行为与新行为：
当前状态：资料 / 自动化 / 实板调试 / 实板 Flash / 运行时 / 异常 / 长稳

## 器件资料与许可

| 项目 | 值/范围 | 来源版本、章节或 commit | 实板状态 |
| --- | --- | --- | --- |
| 型号、内核、DPIDR/家族 ID/容量 | | | |
| Flash/bank/全部扇区与编程粒度 | | | |
| RAM、代码/缓冲区/栈/static_base | | | |
| 缓存、保护、超时及勘误 | | | |
| 算法/SVD 来源、许可、构建工具链 | | | |

## 实现与影响

修改的目标定义、算法、构建和测试文件：
复用了哪些实现；为什么可以复用：
公共 helper/协议/调度修改的复现与必要性（无则写无）：
唯一 owner、Flash 开关、既有型号容量边界如何保留：
默认配置/能力变化（无则写无）：

## 自动化验证

| 命令/用例 | 结果与数量 | 日志/fixture/说明 |
| --- | --- | --- |
| focused Vitest | | |
| typecheck / full Vitest / build | | |
| native build / 算法镜像校验 | | |
| CMSIS-DAP native mock / selftest | | |
| J-Link 回归 / diff --check | | |

边界：最大/最后扇区、末尾字节、跨扇区、VMA/LMA、错误容量、RAM 布局。
失败路径：超时、保护、Verify、取消/未知写入和清理中已覆盖的用例。
native 校验是否真正执行，而非由 mock 替代：

## 实板验证

板卡/完整 SKU/电源；probe 固件、VID/PID、稳定 serial 标识、HID/WinUSB：
源码/工作区、helper/算法/ELF 标识与 SHA256；SWD 频率：
目标修改授权范围与测试 Flash 区域：

| 能力/阶段 | 结果 | 次数/时长/区域 | 可复核证据 |
| --- | --- | --- | --- |
| 只读身份、RAM stub、Init/UnInit | | | |
| 授权扇区、完整 ELF/Verify | | | |
| 非 Flash 启动、停止/再启动 | | | |
| 基本调试/断点/step into-over-out | | | |
| Watch/Timeline/RTT/Viewer | | | |
| 断线/helper 退出与新会话 | | | |
| 长稳与性能 | | | |

失败原始记录及修复后复验：
没有板卡时：未执行项、需要协作者提供的板卡/证据。

## 风险、文档与回退

尚未验证的容量/bank/transport/能力：
已知限制与可能影响的已有目标：
README / 用户文档 / 算法资料状态更新：
修复日志：是否已有明确用户确认（纯新增无历史修复则说明不适用）。
撤销本 PR 目标定义/算法/公共修改的方式与数据恢复注意事项：
如交付 VSIX：文件/平台/哈希、包内核验；是否实际发布。
```

Review 的最终检查：资料支持每个关键参数；预检早于 Flash；自动化跨到 native；实板结论能由记录支持；未测 transport/容量被保留为缺口。中文 Git 提交信息遵守 AGENTS.md。合并后更新支持矩阵仍以实际验证状态为准，不因 PR 被合并自动升级硬件结论。
