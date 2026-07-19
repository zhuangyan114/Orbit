# Native Debug Engine 任务状态

本清单是任务 03--13 的收尾状态，不重复历史提示词。当前架构和限制见 [overall-guidance.md](overall-guidance.md)，发布/回退见 [rollout-and-fallback.md](rollout-and-fallback.md)，场景细节见 [validation-matrix.md](validation-matrix.md)。

证据等级：**代码**表示实现已在仓库；**自动**表示可重复的构建、Mock 或 Vitest；**硬件**只表示有可复查的真实 J-Link/MCU 日志或用户确认。自动或历史 legacy 结果不升级为 Native 硬件通过。

| 任务 | 状态 | 代码 | 自动 | 真实硬件 | 现存缺口 |
|---|---|---|---|---|---|
| 03 OpenOCD 参考 | 完成 | `openocd-state-machine-notes.md` 保留为设计资料 | 不适用 | 不适用 | 不属于运行时依赖或控制路径 |
| 04 Step 状态机 | 部分完成 | helper 已承载 Native source into/over/out；legacy 保留 | helper Mock 和 Commander 回归 | 部分通过 | Native 延迟与完整场景门槛未达 |
| 05 C++ 通道选型 | 完成 | 选择独立 Windows helper + JSON-lines | build/helper handshake | 最小连接部分通过 | 无需引入 addon/OpenOCD/GDB server |
| 06 helper 原型 | 部分完成 | connect、控制、寄存器/内存、BP、RTT、source step 已实现 | `test:cpp-channel:mock` | 部分通过 | 故障、RTT、reset/reconnect 未完整硬件演练 |
| 07 NativeScheduler | 完成（代码/自动） | 三优先级、串行、暂停、coalesce、abort | scheduler Vitest | 部分通过 | 需验证持续 Watch 下 Timeline 饥饿与延迟 |
| 08 Native stepOver | 部分完成 | helper + Commander + BP snapshot/cleanup | Mock/Commander 回归 | 部分通过 | 非调用 stepOver 端到端延迟超门槛 |
| 09 Native into/out | 部分完成 | line bounds、source hint、trusted stop PC | Mock/Commander/DAP 回归 | 部分通过 | Into/Out 各 20 次与性能门槛未完成 |
| 10 实时变量保护 | 完成（代码/自动） | DAP read/control 栅栏、写入 flush/cache 失效、no-fallback | DAP/Router/Scheduler Vitest | 部分通过 | 同会话完整 recording + step 压力证据不足 |
| 11 DAP 响应优化 | 完成（代码/自动） | Native halted result 驱动 response-before-stopped | DAP Native executor 回归 | 部分通过 | 多场景硬件时序和性能仍需采集 |
| 12 验证矩阵 | 完成（文档） | VM-01--VM-23 定义和证据边界 | 自动基线映射 | 部分/未验证项保留 | 不得以缺失日志判定通过 |
| 13 验证续跑 | 完成（本次自动基线） | 本收尾更新事实来源 | build/native Mock/typecheck/bundle/Vitest 9 文件、43 项通过 | 不执行硬件命令 | 不改变既有硬件结论 |

## 当前发布判断

- 默认仍是 legacy。`nativeDebugEngineEnabled=false` 是现行安全默认值。
- Native 仅适合显式/灰度使用；`auto` 只可在 helper 初始化失败时回退 legacy。
- Native 已连接后丢失 owner 必须结束当前会话，不能热切 owner。
- 进入 Native 默认前，必须完成 validation matrix 的 VM-14、VM-15、VM-17、VM-20、VM-21、VM-23，以及同一会话内 Into/Over/Out 各 20 次、Timeline recording、变量写入和性能门槛。
