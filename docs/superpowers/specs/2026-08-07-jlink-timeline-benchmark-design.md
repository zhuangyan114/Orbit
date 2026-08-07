# J-Link Timeline 基准设计

## 目标

在同一 STM32F407VET6、同一 ELF 和同一 Timeline/Watch 参数下，对 J-Link native owner 执行与 CMSIS-DAP DAP-07 相同的 3 Watch、6 Watch 硬件基准，并把结果加入现有基准矩阵。

## 方案

参数化现有 `verify-dap07-timeline-hw.js`，通过 `--probe=cmsis-dap|jlink` 选择 owner，共享 DAP 客户端、表达式、统计公式、证据归档和失败门槛。J-Link 使用 `nativeDebugEngineMode=native`，不允许 legacy fallback；CMSIS-DAP 行为保持不变。

固定比较参数：

- Target/ELF：`D:\STM32\project\vet6_led` / `build\Debug\vet6_led.elf`
- SWD：1000 kHz
- Timeline：`uwTick`、`xTickCount`、`aww`
- Watch：前 3 个或全部 6 个表达式，100 ms 周期
- Timeline target interval：0.2 ms；DAP send interval：16 ms
- 每个正式场景运行至少 60 秒
- `flashBeforeDebug=false`，不执行 erase/program/verify

## 指标

- `Timeline flush Hz = ozoneDataSamples 事件数 / 有效运行秒数`
- `实际采样率 = Timeline 总数据点 / Timeline 表达式数 / 有效运行秒数`
- 同时记录 Timeline 事件间隔、Watch P50/P95/max、Pause 延迟和数据成功率。

Flush Hz 代表 DAP 到 Timeline 的批次发送频率；实际采样率代表每个 Timeline 表达式每秒获得的目标数据点数。

## 安全与失败条件

开始前拒绝任何已有 target-owner 进程。J-Link 场景必须且只能出现一个 native helper PID，selected owner 必须全部是 `jlink-native`，不得出现 legacy、CMSIS-DAP、JLink.exe、OpenOCD 或 GDB owner。Flash 日志必须为零，Watch 每项数据和全部 Timeline 表达式必须有效，Pause/Disconnect 必须成功，结束后 owner 进程必须为零。任何违例保存证据并非零退出。

## 测试与交付

先为 probe 参数、J-Link owner 校验和实际采样率公式添加失败测试，再实施最小参数化。通过聚焦测试、类型检查和构建后，依次运行 J-Link 3 Watch/6 Watch 60 秒基准。最终更新 `docs/dap07-timeline-performance-report.md` 的基准矩阵、证据路径、结论和跨 probe 限制；不更新 `docs/bug-fix-log.md`。
