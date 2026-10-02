# 验收流程与标准

## 状态和能力按层记录

| 层级 | 通过条件 | 可以写出的结论 |
| --- | --- | --- |
| 资料/实现 | 来源可追溯，定义和算法已实现 | 型号已注册/算法已实现；未验证项单列 |
| 自动化 | 相关单元、native mock、自测及构建通过 | 自动化通过；不代表实板 Flash 可用 |
| 基本实板调试 | 只读身份和基本调试用例通过 | 指定型号、板卡、探针/transport 的调试已验收 |
| 实板 Flash | 授权范围内的扇区、具体 ELF 编程及完整校验通过 | 明确覆盖范围的 Flash 已验收；未测 bank/扇区保留缺口 |
| 运行时/异常/长稳 | 对应组合、断线和持续运行用例通过 | 只列实际完成的能力、轮数、时长和性能 |

贡献者缺少板卡时可以提交资料 PR 或实现 Draft PR，列明所需板卡和待验收步骤，让持板者补证据。普通使用者确认“正常使用”可写为用户实板基本使用确认；没有逐项记录时不升级为本表的完整验收。

## 自动化命令

先运行涉及路径的 focused 测试。常见新增型号集合：

```powershell
npx vitest run src/ozone-backend/cmsis-dap-flasher.test.ts src/ozone-backend/session-target-channel.test.ts src/debug/dap-session-cmsis-dap.test.ts
npm run typecheck
npm test
npm run build
npm run build:native
npm run test:cmsis-dap:algorithm
npm run test:cmsis-dap:mock
npm run test:cpp-channel:mock
& .\out\native\win32-x64\orbit-cmsis-dap-helper.exe --selftest
git diff --check
```

这些命令是当前仓库脚本，使用前核对 `package.json`；`build:native` 需要 Windows C++ 工具链与 ARM GCC。新算法必须加入构建与镜像校验脚本；涉及 Watch/Timeline、RTT、SVD 或公共调度时，补跑 AGENTS.md 指定的对应 focused 回归。默认只跑 mock 和离线自测，不因执行本列表自动连接实板。

记录每条命令的退出状态和测试摘要。跳过的检查说明理由；缺工具链应写“未执行”，不能当作通过。只改文档时不重跑全套硬件/代码测试，检查 skill 格式、链接和状态一致性即可。

## 实板前的最小记录

- 日期、源码 commit/工作区差异标识、OS/工具链、helper 与算法 SHA256、固件源码标识及 ELF SHA256。
- 芯片完整型号与标记、板卡、电源/VTref 实测值或“不支持读取”、必要的 SWD/NRST 接线说明。
- Probe 名称/固件、VID/PID/serial、HID v1 或 WinUSB v2、report ID/长度或 USB endpoint/packet 信息、SWD 频率。
- `probe: "cmsis-dap"`、选定 owner、helper PID、完整 launch 参数，以及目标修改的现有授权范围和允许测试的 Flash 区域。
- 身份 raw 值（DPIDR、AP/CPUID/家族 ID/容量中实际可读项）、初始 targetState；记录寄存器地址、返回码、ACK 和重试/耗时。

证据公开前检查凭据、个人路径和私有固件。Probe serial 可脱敏为稳定标识，原始完整记录留在贡献者本地；不要脱敏影响判断的设备 ID、地址或错误码。

## 分级执行和判定

下表的次数是本 skill 的最低验收基线；更高可靠性或发布要求可追加。任何实板修改都以已有授权为前提；用户限定范围不足时先完成离线部分，不擅自扩大实板操作。

| 阶段 | 具体操作 | 通过标准 |
| --- | --- | --- |
| 1. 只读身份 | 使用正式会话 owner 读取已确认可安全访问的 DP/芯片/容量地址 | DP/ACK 有效，型号、容量与配置一致；不盲读厂商地址，不新建连接扫描型号 |
| 2. RAM stub | 在授权的 loader RAM 执行最小返回 stub | Thumb PC/LR、SP、xPSR 正确；停在可信 BKPT，返回码/状态一致；算法布局没有越界和重叠 |
| 3. Init/UnInit | 使用新算法各完成至少 1 次 | 每次可确认完成，正确错误码，无 lockup/fault，不把 DHCSR 一次读取当成返回证明 |
| 4. 测试扇区 | 在明确允许的区域擦除、编程已知模式并校验 | 不超出授权区域；只有 1-to-0 的编程语义，需擦除时先擦除；覆盖所声明验收范围内的扇区/bank，禁止顺便 mass erase |
| 5. 具体 ELF | 使用 `flashBeforeDebug: true` 完整烧录可公开 fixture 或授权固件 | 预检先于 Flash；PT_LOAD 按 LMA 编程，`.bss` 不生成 Flash 数据；完整 Verify/read-back、启动入口和 `.data` 初始化正确 |
| 6. 非 Flash 启动 | 预先烧入相同固件，用 `flashBeforeDebug: false` 启动/停止至少 3 轮 | Flash/Verify/Flash 专用 reset 为零；唯一 owner；每次停止后 helper/探针释放，下一次启动可用 |
| 7. 基本调试 | halt/continue/reset、用户断点；适用内核的 step into/over/out 至少 10 轮 | PC/state 与源码相符；临时断点清理、用户断点保留；无错误、死锁或多 owner；不以抑制 Watch/Timeline 换取通过 |
| 8. 运行时组合 | Watch 含标量/结构体/数组，Timeline 与 RTT 按声称支持的能力同时运行至少 60 秒 | 样本来自同一会话；写入在允许 RAM 内且遵守 control barrier；控制后采样恢复；记录实际延迟/吞吐，无伪造采样率 |
| 9. 异常与清理 | 授权后在运行/采样阶段测试断线或 helper 退出；结束后重建会话至少 3 轮 | 错误有结构码；旧 owner 完整销毁、无隐式 J-Link fallback；旧结果不流入新 session；取消/未知写入不盲重试 |
| 10. 长稳 | 对声明的运行时组合连续运行至少 30 分钟 | 记录采样/RTT 成功率、点数/字节、延迟和内存走势；无死锁、持续异常或 owner/helper 泄漏 |

最小调试支持结论需要阶段 1、6、7；Flash 支持结论另需阶段 2–5，并明确授权及实际覆盖的地址、扇区和 bank。未获准的实板边界列为缺口，不阻止已完成区域的限定范围结论；不得将其表述为整颗芯片 Flash 全面验收。阶段 8–10 独立列状态，不把未完成项塞进“全通过”。RTT/RTOS/Viewer 若不适用，说明固件或工具条件，不用空返回值充当成功。第三方 Viewer 验证记录其版本与实际 DAP 行为。

Flash 边界测试特别要求：首个/最大/最后扇区（多 bank 按 bank 分别覆盖）、跨扇区数据和 Flash 末尾有效字节应至少有自动化用例；实板只在获准的区域执行，并明确哪些边界尚未实测。编程测试覆盖对齐、非对齐/尾页（算法声明允许时）和 ECC/缓存约束。不得为了补覆盖而覆盖板上未知数据。

探针兼容性按矩阵记：每个型号/容量 × 探针固件 × transport × 实际验证能力。HID 成功不能写成 WinUSB 成功，某个完整 SKU 成功也不能推断全部封装/容量；可依据官方资料共用实现，但共享实现和独立硬件证据要分开。

## 失败停止规则

- DPIDR/ACK/电源异常先保留 raw trace，排查供电、接线、SWJ 初始化和频率；没有证据时不继续改 Flash 算法或延长超时。
- preflight 不匹配、保护错误、非法 RAM/入口/BKPT 或 Verify mismatch 都按明确阶段失败；不自动放宽范围、清保护或切换算法。
- Flash 超时、设备移除、取消或写入结果未知时停止后续编程，不自动重放操作。记录已确认擦除/编程的区域与清理结果；若部分固件已擦除，说明恢复方案，重新烧录仍需现有授权覆盖。
- 失败不能被重新插拔后的成功覆盖。修复公共校验先保留能失败的 native 回归，再用同一用例重验。

## 产物核对

只有需要交付 VSIX 时执行：

1. 从源码构建本次 helper、算法与扩展，记录哈希；不手工修改 `dist/`。
2. 使用正常依赖打包，核对目标平台和 manifest；外部 `koffi` 依赖不能用 `--no-dependencies` 丢掉。
3. 检查 VSIX 内目标算法、helper 与本次构建字节一致；从解包目录加载运行依赖，并对包内 helper 执行离线 selftest。
4. 记录“包已生成”或已完成的具体安装/发布动作。未经授权不发布、上传或替换他人的安装环境。
