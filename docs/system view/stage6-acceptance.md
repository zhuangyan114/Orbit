# 阶段 6 验收记录

## STM32H723VGT6 与 RMLink 二号机

2026-11-21 在 `h7vgt6_test` 的 VS Code 1.146.0 扩展开发宿主实测。RMLink `b81f3fc30470` 运行固件 0.3.4，经 Wi-Fi、512 B 报文和 SWD 4 MHz 连接。测试使用 `Orbit: SystemView Trace (RMLink 2)` 的五任务低速 fixture，ELF SHA-256 为 `3118e9cd2dd94bdc0fb4ea162a67a556fbd45a2e43883abe408e07ca2d82ed2d`。扩展、DAP 和 Trace Worker 的 SHA-256 与阶段 6.4 候选包内文件一致。

| 验收项 | 结果 |
| --- | --- |
| Continuous 录制 | `1,800,015 ms`，`1,136,517 B`，`189,395` 包。目标溢出、目标丢包、主机丢字节与传输丢字节均为 `0`。 |
| 共存变量采样 | 请求间隔 `5 ms`，收到 `326,745` 个样本。录制期间 5 次暂停与继续，响应分别为 `60–184 ms`、`101–214 ms`。 |
| RTOS 快照 | 暂停态读取 5 个任务并返回 `halted-consistent`。录制期间 14 次运行快照，13 次 `partial`、1 次 `live-best-effort`，查询无超时。 |
| Worker 预算 | 输入队列峰值 `512 B`，写队列峰值 `1,844,884 B`。索引页描述符峰值 `3,099`，缓存峰值 `18` 页和 `2,817,541 B`，堆峰值 `63,054,628 B`。均低于对应的冻结上限。共享进程 RSS 峰值 `607,789,056 B`。 |
| 停止与回放 | 停止 RPC `626 ms`。独立 Worker 启用 SHA-256 校验重开，字节与包数一致，整个录制仅有 `eof` 结束边界。 |
| API 共存 | 录制中读取已提交的 1 秒窗口，取得 20 个分页事件及 8 个精确统计分箱。停止后两页各 10 个事件。全段统计达扫描预算后返回 `approx`。 |

前两次尝试的证据一同保留。首次约 7 分钟收到 `ConnectionLost`，重开恢复 `251,798 B`、`41,941` 包，原始流 SHA-256 校验通过。第二次在约 16 分钟遇到快照查询超时，脚本提前停止录制。最终轮将快照超时单独记账，录制满 30 分钟后才停止。

本轮证实该链路的低速 Trace 长稳和预算控制。控制样本量及五任务 fixture 与阶段 1 的 13 任务基准不同，报告保留其绝对耗时。J-Link native、CMSIS-DAP WinUSB 和 HID 的新 RTOS 实板指标仍待验证，阶段 6.2 的完整矩阵保持打开。

## 软件性能与候选包

百万包 Worker 基准在当前源码通过，解码 `96,987` 包/s，LOD、精确点和视口查询的 P95 分别为 `4.14 ms`、`10.97 ms`、`12.98 ms`。全量测试覆盖磁盘满、写入失败、低带宽降级、背压和会话断开。

Windows x64 候选包版本为 `1.2.1`，SHA-256 为 `26a2c6daa385bc7fc019121527fe157b9cd3bfa200caa62449e78434f2be5471`。在隔离 profile 以正常模式启动安装后的扩展并重开归档。安装目录中的同一扩展通过跨面板游标、离线 API 与原生 helper 自检。详见 [阶段进度](progress.md) 和 [使用指南](quick-start.md)。

可复验报告位于 `out/rtos-stage6/acceptance-6.2/` 的 `h723-rmlink-acceptance-summary.json`、`final-archive-verification.json`、`disconnect-archive-reopen.json`、`live-api-queries.json` 和 `worker-performance.json`。VSIX 及安装验证位于 `out/rtos-stage6/acceptance-6.4/`。长稳脚本为 `out/rtos-stage5/acceptance-5.4/codex-stage62-h723-endurance.cjs`，使用既有 H723 开发宿主和指定测试会话。
