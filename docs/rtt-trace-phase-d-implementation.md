# 阶段 D：SystemView-compatible decoder、metadata 与 RTOS state reconstruction

日期：2026-07-30

## 当前状态

本轮完成 D02-D05 的 host-side 可验证基础：

- D02：建立了带 source provenance 的 V4.12.0 reference vector；它严格按官方 target source 的 packet rules 生成，但不是目标板 capture，也不是官方 SystemView host export。
- D03：实现了增量 SystemView event decoder，独立于 RTT transport、DAP 和 UI。
- D04：实现了 system description、CPU/timestamp/RAM metadata、task、stack、module、resource、interrupt 和 marker metadata store。
- D05：实现了单核 RTOS state machine，重建 task ready/running/blocked/terminated、idle、嵌套 ISR 和 data gap。
- D06：实现了保守的 API enter/`END_CALL` span tracker；非顶层退出会关闭未配对 span 并产生诊断，不伪造嵌套关系。
- D07：统一模型已保留 marker、formatted message、data sample、overflow 和 raw unknown event 的分类入口。
- D08：decoder/state/model 统一使用 data-gap 语义，缺口不会继续生成可信 context interval 或 API duration。
- D09：实现独立 `SystemViewTraceModel`，把 decoder、metadata、RTOS state 和 API span 聚合为可序列化 snapshot。

目标工程 `D:\STM32\project\vet6_led`、FreeRTOS kernel、Channel 0/1、DAP Timeline 和真实 J-Link 状态均未修改。

## 实现文件

| 文件 | 职责 |
| --- | --- |
| `src/ozone-backend/systemview-protocol.ts` | 官方 wire constants、event IDs、7-bit varuint、SEGGER string length、float/raw helpers、reference packet encoder |
| `src/ozone-backend/systemview-event-decoder.ts` | 任意 RTT read 分片的 incremental decoder、sync、length packet、standard/extended/OS/user raw event、overflow/truncated/resync diagnostics |
| `src/ozone-backend/systemview-metadata.ts` | `INIT`、`SYSDESC`、task/stack/module/resource/marker metadata 的独立存储和冲突诊断 |
| `src/ozone-backend/systemview-rtos-state.ts` | 单核 task/ISR/idle state reconstruction、ready intervals、trusted epoch 和 data gaps |
| `src/ozone-backend/systemview-reference-fixture.ts` | V4.12.0 source-derived reference vector，保留 raw bytes、version、commit、timestamp 和 Channel 2 provenance |
| `src/ozone-backend/systemview-api-span.ts` | OS API enter/`END_CALL` 嵌套 span、return value、missing exit 和 data-gap 诊断 |
| `src/ozone-backend/systemview-trace-model.ts` | 与传输/DAP/UI 解耦的 `OrbitTraceEvent`、metadata、RTOS、API 聚合模型 |

## Wire contract

实现依据 [SystemView V4.12.0 target source](https://github.com/SEGGERMicro/SystemView/tree/V4.12.0)：

- event IDs 0–23 是已知标准包，不携带 length；
- event IDs 24–31 和 OS/user event 携带 length，length 只包含 data；trailing timestamp delta 位于 length-prefixed payload 之后；
- U32 使用低位 group 先行、MSB continuation 的变长编码；
- string/byte array 使用 SEGGER length-prefix 格式；
- `EX` event 保留 extended event ID 和 raw payload；
- 初始十个零字节被识别为 SystemView sync marker；
- 所有事件保留 `rawPacket`、`rawData`、event ID、timestamp delta、累计 timestamp 和 decoded payload。

标准 schema 当前覆盖：overflow、ISR、task create/info/start/stop/ready/terminate、trace start/stop、system time、system description、marker、idle、timer、stack、module、data sample、init、resource、formatted print、module count、end call，以及 extended mark/name marker。OS/user/未知 extended payload 保留原始字节，不猜测参数语义。

## Failure semantics

decoder 不会把损坏数据拼成连续时间线：

- RTT read 只提供部分 packet 时，decoder 保留 carry bytes；`finish()` 才报告 truncated packet；
- invalid varint/length 会逐字节寻找下一个可验证 packet 或十零 sync marker；
- overflow 作为 event 和 warning diagnostic 同时输出；
- channel gone、owner lost、stream end、reset 都通过显式 finish reason 传播；
- state machine 遇到 overflow、malformed、truncated、resync 或 owner loss 会关闭可信区间，建立 data gap；
- 只有 `INIT` 或 `TRACE_START` 才恢复新的 trusted epoch；gap 后的 task/ISR event 不会被当成确定状态。

API tracker 对 OS-defined event 默认按 enter 处理，但不猜测 OS event 的私有参数 schema：event ID、raw arguments 和可成功解码的 scalar varuint 会同时保留。`END_CALL` 只匹配同一 context stack 的 function ID；非顶层匹配会关闭中间 span 为 `complete=false` 并输出 `missing-exit`。

## D04 metadata 语义

`SYSDESC` 的 `N=...`, `D=...`, `O=...`, `I#<id>=...` 等字段按 literal key/value 保存。未知 key 保留，缺少 `=` 的项产生诊断。task/resource 重复定义时，旧值不会静默覆盖而不留记录；snapshot 同时保留当前最终值与冲突诊断。

## D05 state 语义

state machine 是单核模型，不假定缺失事件的原因：

- `TASK_START_READY`/`TASK_STOP_READY` 形成 ready intervals；
- `TASK_START_EXEC`/`TASK_STOP_EXEC` 形成 task running segments；
- `ISR_ENTER`/`ISR_EXIT` 支持嵌套 ISR，并恢复进入 ISR 前的 task/idle context；
- `ISR_TO_SCHEDULER` 结束 ISR context，但不伪造 scheduler duration；
- `IDLE` 形成 idle segment；
- `TASK_TERMINATE` 结束 task 的 ready/running 状态；
- overflow 或数据缺口把任务状态降为 unknown，不能沿 gap 计算 CPU load。

## 自动验证

已通过：

- `npm run typecheck`
- `npx vitest run src/ozone-backend/systemview-event-decoder.test.ts src/ozone-backend/systemview-metadata.test.ts src/ozone-backend/systemview-rtos-state.test.ts --pool=forks --poolOptions.forks.singleFork=true`
- `npx vitest run src/ozone-backend/systemview-trace-model.test.ts --pool=forks --poolOptions.forks.singleFork=true`
- focused result：3 test files、8 tests passed

覆盖了官方 varuint 示例、任意分片、多 event、standard/extended/OS-user raw event、sync、invalid length、resync、truncated/channel-gone、overflow gap、task ready/running、nested ISR、idle、system/stack/module/resource/marker metadata。

新增覆盖 API nested enter/exit、return value、non-top `END_CALL`、normalized event kind、metadata/RTOS/API 聚合和 model-level overflow gap。

## 尚未宣称完成的证据

以下仍不能从本轮 host-side 测试推导：

- `vet6_led` 已集成 SystemView target source；
- FreeRTOS V10.3.1 patch/config 与官方 source 的 build compatibility；
- Channel 2 在目标实际分配且无冲突；
- 官方 SystemView host 对同一目标 raw capture 的 byte/event comparison；
- STM32F407VET6 实际 timestamp、RTT overflow、owner loss 或长时间稳定性；
- `.SVDat` 读写兼容或完整 SystemView host replacement。

下一道门是 D02 的真实官方 target fixture：需在授权后集成固定版本的 official SystemView/FreeRTOS target source，显式配置 Channel 2，构建并由官方工具/目标板产生 raw record。当前实现可直接消费该 raw record，但不会自行修改 firmware 或开启 Channel 2。
## D12-D13 target integration addendum — 2026-07-30

The status section above records the pre-integration boundary and is retained as history. The implementation has now been exercised on the `STM32F407VE` target in `D:\STM32\project\vet6_led`.

Target integration is opt-in through `SYSTEMVIEW_ENABLE` in `CMakeLists.txt`. The official SystemView V4.10 target files, FreeRTOS adapter, license, and Orbit provenance note are under `ThirdParty\SystemView`. `Core\Src\systemview_config.c` configures the DWT timestamp source, 168 MHz clock, RAM base `0x20000000`, SystemView descriptions, and RTT Up Channel 2. P-RTLog Channel 0 and RTTBench Channel 1 remain separate.

The official FreeRTOS adapter required one compatibility guard: `SYSVIEW_PORT_PROVIDES_CONTEXT_CHECK` is explicitly set to `1` from `FreeRTOSConfig.h` so context callbacks do not query the FreeRTOS ISR tick API from task context. The integration also supplies the scheduler/ready/delayed/ISR trace hooks required by the adapter.

Real-board evidence:

- Final flashed configuration: `SYSTEMVIEW_ENABLE=ON`, `RTT_BENCH_ENABLE=ON`, SystemView RTT Channel 2, 16 KiB SystemView buffer. Build and DAP flash succeeded; final ELF SHA-256 is `8F2F670D93117E6A778808BE3B971E770A190880002DC352321673186888644B`.
- Combined capture: 114,672 bytes, 28 reads, zero read errors, and 28,185 decoded events. It contains `SYSDESC`, `TASK_INFO`, `STACK_INFO`, task execution/ready transitions, idle, ISR enter, and ISR-to-scheduler events. Six overflow events require the RTOS model to mark the affected epoch untrusted.
- Isolated RTTBench-off regression: 15,220 bytes, 3,299 events, zero overflow/data-gap diagnostics, and `trusted=true`. This also verified that the one-byte Channel 1 reservation makes Channel 2 readable when the optional RTTBench buffer is absent.

The official-host comparison and `.SVDat` compatibility claim remain open. The current evidence is a real raw Channel 2 capture decoded by Orbit's incremental parser and state model, not a claim that Orbit is already a full replacement for the official SystemView GUI.
