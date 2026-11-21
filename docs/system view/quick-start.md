# Orbit RTOS 与 SystemView 使用指南

## 任务快照

在带调试符号的 FreeRTOS 工程中启动 Orbit 调试，打开底部 RTOS 面板。暂停后点「刷新」，核对任务名、优先级与状态。运行时可以开启 Live。运行中的内核可能在读取任务列表时改动链表，面板会标出 `live-best-effort`、`partial` 或 `stale`。需要逐项核对时，暂停后重新读一次。

变量 TIMELINE 沿用已有的 Orbit 调试配置。采集 RTOS Trace Timeline 还需要固件编入 SystemView，并在 RTT 通道列表中提供名为 `SysView` 的缓冲区。

## 固件接入与录制

1. 选用与内核版本匹配的官方 SEGGER SystemView 及 FreeRTOS 适配文件。按适配说明连接任务切换、就绪和中断钩子，开启 `configUSE_TRACE_FACILITY`。保留 ELF 调试段和 RTT 控制块符号 `_SEGGER_RTT`。可核对仓库固定的 [H723 fixture](../../scripts/rtos/fixtures/README.md) 和 [协议版本](protocol.md)。
2. 为 SystemView 提供单调递增的目标时间戳，按其真实频率初始化 `SEGGER_SYSVIEW_Init`。H723 fixture 使用 64 MHz 的 DWT `CYCCNT`。将 SystemView 二进制流放在独立的 `SysView` Up 通道，将文本日志留在 `Terminal`。Continuous 还需要相应的 `SysView` Down 通道接收 START 和 STOP。
3. 用包含上述代码的 ELF 启动调试。从入口断点继续，让固件初始化 RTT，打开 RTOS → Trace Timeline，点「探测通道」。Continuous 由宿主发送 START 时，固件应处于已初始化、等待 START 的状态。
4. 选择 Continuous，开始录制并等待有效包与泳道出现。完成后停止录制，核对提交包数、完整性和缺口。Single-Shot 与 Post-Mortem 由相应模式的固件缓冲区提供冻结证据，使用该模式的 fixture 或按相同接入契约配置固件。

H723 实板示例可使用 `h7vgt6_test` 的 `Orbit: SystemView Trace (RMLink 2)`。它选择编入 SystemView 的测试 ELF。使用前核对 RMLink 编号和 ELF 路径。

| 面板提示 | 现场检查 |
| --- | --- |
| `NoActiveSession` | 启动当前工程的 Orbit 调试并继续运行，再探测通道。 |
| `RttChannelUnavailable` / `SysView` 缺失 | 确认启动配置使用 SystemView ELF。继续过入口断点，检查固件初始化和 RTT 通道名。只有 `Terminal` 通道时，变量 TIMELINE 和 RTT 文本仍可单独使用。 |
| `TargetAlreadyRecording` | 检查测试固件是否在初始化时主动调用 `SEGGER_SYSVIEW_Start`。使用等待宿主 START 的 Continuous 固件重新开始。 |
| 缺口或目标溢出 | 查看录制显示的完整性与诊断，以缺口为界读取区间统计。调试控制、链路拥塞和目标 RTT 环形缓冲区的丢包具有不同记录。 |
| 数值类型或内核布局缺失 | 检查 ELF 调试信息、FreeRTOS 版本和 port。匹配到内核符号后，仍需检查快照能力中的布局证据。 |

## 回放、导出和游标

在 Trace Timeline 点「保存录制」，可将轨迹保存为 Orbit 归档。调试结束后可以直接打开归档，使用 Trace Timeline、Contexts、Events 和 Trace Terminal。Events 支持筛选与分页。点击事件的定位操作可在泳道与事件列表间往返。Trace Terminal 展示固件打印记录与解码诊断。

将当前视口、A/B 区间或筛选后的 Events 导出为 CSV。原始 SystemView 包可以导出为 `.bin`。目前归档和运行时能力表均将 `.SVDat` 显示为未支持。[归档与互操作验证](stage5-archive-validation.md)

Trace Timeline 的「定位到变量 TIMELINE」和变量 TIMELINE 的「定位到 RTOS Trace」传送 A/B 游标，两侧各自保留 Auto-Follow。实时关联只使用同一会话、同一有效时钟区间的样本。RTT 交付与探针采样延迟会影响位置。面板显示「近似联动」时，误差上界未知。

离线记录可在两个面板分别用 A 标出同一已知事件，再到 Trace 点「手动对齐」。如果两边的 B 也标出了第二个共同事件，Orbit 会用两对游标计算时间比例。复位、频率变化或缺口会拆分可用区间。纳秒是显示单位，判断同步效果需看校准证据和误差。

## 自动化与验收状态

Automation API 和 MCP 可读 FreeRTOS 能力、任务快照、已打开录制、分页事件和区间统计。录制启停需要同时授权 `record` 与 `rtt.control`，并提供当前会话代次和幂等键。使用 `read` 连接即可查询已经在 RTOS 面板打开的离线归档。[API 示例与权限](../api/orbit-automation-api.md#freertos-and-systemview)

已验证的固件、具体探针及 transport 见 [兼容矩阵](compatibility.md)。[阶段进度](progress.md) 汇总真实 VS Code、板卡、性能与打包证据。可以在全新 profile 运行 `node scripts/rtos/verify-stage54-vscode.js` 复验离线游标，再运行 `node scripts/rtos/verify-stage55-vscode.js` 复验离线 API。
