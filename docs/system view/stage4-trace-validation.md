# 阶段 4.5：Trace Timeline 与 §10 基准冻结说明

冻结日期：2026-11-19。对应提交基线 `664cbab`，后续 4.5 源码与文档提交待用户/Codex 独立复验后本地提交。

## 1. 测量环境与脚本入口

| 项目 | 本轮实测环境 |
|---|---|
| 系统与 CPU | Windows (`win32 x64`) / AMD Ryzen 7 7745HX with Radeon Graphics（16 逻辑核） |
| Node 运行时 | `v24.15.0` |
| VS Code 集成宿主 | `.vscode-test/vscode-win32-x64-archive-1.134.0/Code.exe` |
| 离线吞吐/查询/内存脚本 | `node scripts/rtos/benchmark-trace-45.cjs` |
| VS Code 真实 UI/Chromium 脚本 | `node scripts/rtos/verify-stage45-vscode.js` |
| 阶段 2 面板回归脚本 | `node scripts/rtos/verify-stage2-vscode.js --output=out/rtos-stage4/acceptance-4.5/stage2-regression-vscode` |

## 2. 区分设计目标、离线/UI 已测数值与硬件待验收项

- **设计目标**：60 Hz 屏幕上百万级事件交互接近 60 fps（单帧绘制 < 16.6 ms，不产生 > 50 ms 主线程长任务）、Worker 队列/缓存与页面描述符严格有界、不整段复制录制数据、悬停与 A/B 游标始终精确查询。
- **离线 / 真实 VS Code 已测基线（本轮实际执行并记录，非虚构）**：
  - Node Worker（`benchmark-trace-45.cjs`，1,002,005 包 / 2,505,036 B / 668,000 slices / 334,000 activations / 167,000 readyWaits）：
    - 流式写入与重建吞吐：`ingestMs = 11002.71 ms`（`91,069 packets/s`、`227,675 B/s`），`finishMs = 42.02 ms`。
    - LOD 查询：`p50 = 1.76 ms`、`p95 = 4.46 ms`、`max = 5.21 ms`。
    - 精确点查询：`p50 = 4.25 ms`、`p95 = 10.11 ms`、`max = 10.23 ms`。
    - 放大视口查询：`p50 = 5.02 ms`、`p95 = 12.24 ms`、`max = 14.15 ms`。
    - 12 次连续快速并发取消：`rapidCancel12TotalMs = 4.54 ms`（取消 11 次，最后 1 次完成 `finalCancelOk = true`）。
    - 内存与有界队列：`workerPeakRssBytes = 320,221,184 B`（约 305.4 MiB）、`workerPeakHeapUsedBytes = 106,739,968 B`（约 101.8 MiB）、`workerInMemoryPageDescriptors = 847 / 16,384`、`workerCachedPagesPeak = 30 / 64`（`8,365,182 B / 8 MiB`）、`hostPeakRetainedInputBytes = 32,768 B`。
  - 真实 VS Code Extension Host + Chromium Webview（`verify-stage45-vscode.js`）：
    - 阶段 0 `continuous.bin` 无调试会话保存与重新打开、全部 5 份 4.4 STM32H723 实板只读归档副本（`standard` 33 段/33 缺口 3,232 包、`low-rate-tail` 1,091 包、`low-rate-timeout` `interrupted/incomplete` 349 包、`single-shot` 63 包、`post-mortem` `prefix-overwritten` 846 包/2 缺口）均在宿主成功打开并完成精确/视口查询。
    - 模拟热连续录制（`HotTraceSession`）在 `hide` / `moveViews` 重建后保持 active 且 `haltedOrReset = false`；在 `postMortemCompiled: true` 上启动 Continuous 返回 `TraceModeMismatch` 且同样无任何 halt/reset。
    - 1,002,005 事件在真实 Chromium Webview 测得：`openMs = 1490 ms`，10 次并发快速视口切换 `rapid10SwitchesMs = 23 ms`，Canvas `frameCount = 20`、`lastDrawMs = 2.3 ms`、`maxDrawMs = 2.7 ms`、`over16msFrames = 0`、`over50msDrawFrames = 0`、`longTasksOver50ms = 0`、`lastViewportQueryMs = 17.33 ms`、`lastPointInspectMs = 7.53 ms`；Worker 峰值堆 `59,015,476 B`、页描述符 `847 / 16,384`、`peakWriteQueueBytes = 5,168,824 B`（上限 16 MiB）。
- **H723 / RMLink 二号机实板 UI 复验**。原扩展开发宿主（VS Code 1.146.0）通过 Trace Timeline 开始、跟随并停止 100 Hz FreeRTOS 测试固件录制，得到 58,803 B、9,797 包、3,387 个执行切片，目标与宿主丢包计数为 0。释放调试会话后保存归档副本并离线重开，原始字节 SHA-256 一致。另在 Post-Mortem 归档复验前缀覆盖、Marker 悬停与 A/B，并在百万事件归档操作缩放、平移和精确悬停。
- 修订后的独立 VS Code 1.134.0 集成 UI 复测见 `out/rtos-stage4/acceptance-4.5/codex-r2-vscode-091253/vscode-ui-report.json`。百万事件冷打开 1,523 ms，10 次切换 23 ms，20 帧中最长绘制 3.7 ms，无超过 50 ms 的长任务。真实热录制与保存副本证据见同目录 `codex-stage45-live-stop.json` 和 `codex-stage45-saved-copy.json`。
- **6.2 待验收项**包括 30 分钟连续实板录制、控制交错、各链路容量对照及 J-Link native / CMSIS-DAP WinUSB/HID 实板矩阵。

## 3. 冻结门槛摘要

详见机器可读门槛文件 [stage4-trace-performance-gates.json](stage4-trace-performance-gates.json)：
- Worker 解码与持久化吞吐：`>= 40,000 packets/s`、`>= 100,000 B/s`、`finish <= 500 ms`（当前基于 1M 离线流）。
- 1M 查询延迟：`LOD p95 <= 30 ms`、`精确点查询 p95 <= 50 ms`、`放大视口 p95 <= 60 ms`、12 次连续快速切换取消 `<= 100 ms`。
- Chromium Canvas 绘图：`单帧 p95 <= 16.6 ms`、`单帧 max <= 50 ms`、1M 浏览期间 `longTasksOver50ms = 0`。
- 有界内存与队列：`maxCachedPages = 64`、`maxCachedBytes = 8 MiB`、`maxInMemoryPageDescriptors = 16,384`、`maxWriteQueueBytes = 16 MiB`、`1M Worker Peak Heap <= 256 MiB`。
