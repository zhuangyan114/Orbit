# Orbit RTT 高速采样与 RTOS Trace 工程任务拆分

> 阶段 A 状态（2026-07-27）：进行中。已切换到 `D:\STM32\project\vet6_led`（STM32F407VET6）并完成真实目标连接、A03 DAP 短测和 A04 RTT Channel 1 三组吞吐窗口；有效 Step 延迟与完整 Timeline UI 基线仍待补测。
>
> 阶段 A 产物：[`docs/rtt-trace-phase-a/`](rtt-trace-phase-a/)，包括术语与边界、首批平台矩阵、技术决策、基线/验证矩阵和 MCU 侧官方兼容合同。

## 1. 文档目的

本文把以下能力拆分为可独立设计、实现和验收的小任务：

- 统一调试端 RTT 传输与调度；
- 为 Timeline 增加 RTT 高速变量采样链路；
- 建立目标端采样协议与配套固件模块；
- 实现 SystemView 兼容的 RTOS 事件解析与状态重建；
- 提供任务、ISR、CPU Load、事件列表等 RTOS Trace UI；
- 完成与 Step、Watch、普通 RTT 日志及现有 DAP 调试链路的并发整合；
- 建立自动测试、性能基线和真实硬件验收体系。

本文是任务路线图，不表示其中任何功能已经通过真实 J-Link/MCU 验证。实现状态、自动测试和真实硬件结论必须分别记录。

## 2. 范围和非目标

### 2.0 强制约束：MCU 侧官方接口兼容

以下规则是本工程的 **MUST/不可绕过约束**，优先级高于具体实现便利性：

1. MCU 侧 RTT 必须使用 SEGGER 官方 RTT 的 Control Block、Up/Down Buffer、通道和锁语义；
2. MCU 侧调用的 RTT API 必须保持官方名称、参数含义和返回值语义；不得创建一个行为相似但不兼容的 Orbit 私有 RTT 替代层；
3. SystemView 事件必须使用官方 target source、事件 API、编码规则和 RTOS integration 约定；
4. Orbit 自定义高速采样只能定义独立 RTT 通道中的 payload、signal descriptor 和版本扩展，不得修改 RTT 外壳；
5. 任何 target source 版本升级都必须重新执行官方工具互操作、协议向量、SystemView 对照和真实板回归；
6. “Orbit 自己能读到数据”不等于兼容通过；至少要有官方 J-Link RTT 工具或官方 SystemView 对照证据；
7. 如果官方接口无法表达某项需求，必须先记录 ADR 和兼容性影响，再决定增加独立通道或扩展协议；
8. 后续任务的“完成”定义不得删除或弱化上述约束。

因此，本工程采用以下分层：

```text
官方 RTT 传输接口
        ↓
官方 SystemView 事件接口（RTOS Trace）
        +
Orbit 独立 Sample payload（RTT Timeline）
        ↓
Orbit 主机端调度、解析、缓存和 UI
```

### 2.1 工程范围

1. **RTT 基础设施**
   - 统一 Native helper 与 Legacy koffi 的 RTT 能力；
   - 在活动 `ozone` DAP 会话中复用唯一的 `SessionTargetSelector` owner；
   - 对多个 RTT 消费者实施调度、限额、背压和生命周期管理。

2. **RTT Timeline**
   - 目标端主动采样并通过 RTT 发送带目标时间戳的二进制数据；
   - Timeline 可在现有 DAP 采样与 RTT 采样之间选择；
   - 支持丢包识别、缓存、降采样、记录和导出。

3. **RTOS Trace**
   - 支持 SystemView 目标端事件或 Orbit 自有兼容事件；
   - 重建 Task、ISR、Scheduler、Idle、API、Marker 等运行状态；
   - 提供独立 RTOS Trace 面板，而不是继续扩张现有 RTOS 内存快照视图。

4. **产品化**
   - 配置、诊断、文档、示例工程、兼容性矩阵和发布门禁。

5. **MCU 侧官方接口兼容**
   - RTT 使用 SEGGER 官方 Control Block、Up/Down Buffer、通道配置和 API 语义；
   - SystemView 使用官方 target source、事件 API、时间戳和 RTOS integration 约定；
   - Orbit 自定义高速采样只定义 payload/信号描述，不改变官方 RTT 传输接口。

### 2.2 非目标

- 不增加 OpenOCD、GDB Server、Ozone GUI 自动化或 `JLink.exe` 作为正常调试控制链路；
- 不允许同一调试会话中创建第二个物理 J-Link owner；
- RTT 高速采样不承诺任意 DWARF 表达式都能以目标控制周期采样；
- 第一版不追求一次性复制 SystemView 的全部窗口和全部 RTOS；
- 不复制 SEGGER 主机应用的专有实现、UI 或品牌资产；
- 不以 Mock、构建成功或“无报错运行”代替真实目标板验收。

## 3. 当前基线

截至本文创建时，仓库已有以下基础：

- `SessionTargetSelector` 为每个调试会话选择唯一 Native 或 Legacy owner；
- `NativeScheduler` 使用 `control > watch > timeline` 优先级并保证单 in-flight；
- Native helper 和 Legacy `JLinkDLL` 都已有 `startRtt`、`stopRtt`、`readRtt` 基础接口；
- 当前 Timeline 主要通过 DAP `dataSamplingStart`、`dataSample` 或扩展宿主表达式读取采样；
- 当前 Timeline 数据使用主机时间，尚不是目标端产生的高精度事件流；
- 尚无统一 RTT stream service、消费者配额、通道注册、二进制帧公共层、丢包统计和回压策略；
- 尚无 SystemView 主机端数据包解析器、RTOS 状态机和专用 Trace UI。
- 需要进一步固定 SEGGER RTT/SystemView target source 的版本、配置和许可证边界，避免 MCU 侧出现 Orbit 私有替代实现。

实现时优先参考：

- `src/ozone-backend/session-target-channel.ts`
- `src/ozone-backend/native-scheduler.ts`
- `src/ozone-backend/cpp-jlink-channel.ts`
- `src/ozone-backend/jlink-dll.ts`
- `native/jlink-helper/src/main.cpp`
- `src/debug/dap-session.ts`
- `src/debug-providers/data-sampling-manager.ts`
- `src/webview/timeline/`

## 4. 目标架构

```text
                         ┌───────────────────────────┐
                         │   SessionTargetSelector   │
                         │  唯一 Native/Legacy owner │
                         └─────────────┬─────────────┘
                                       │
                         ┌─────────────▼─────────────┐
                         │      NativeScheduler      │
                         │ control > watch > timeline│
                         └─────────────┬─────────────┘
                                       │
                         ┌─────────────▼─────────────┐
                         │       RttTransport        │
                         │ start/stop/read/capability│
                         └─────────────┬─────────────┘
                                       │
                         ┌─────────────▼─────────────┐
                         │    RttStreamScheduler     │
                         │ 通道、预算、背压、生命周期 │
                         └──────┬────────┬───────────┘
                                │        │
                ┌───────────────▼─┐   ┌──▼────────────────┐
                │ RTT Sample流    │   │ RTOS Trace事件流   │
                │ 变量/传感器/控制 │   │ Task/ISR/API/Marker│
                └───────┬─────────┘   └────────┬──────────┘
                        │                      │
                ┌───────▼─────────┐   ┌────────▼──────────┐
                │ RTT Timeline     │   │ RTOS Trace Panel  │
                │ 波形/记录/导出    │   │泳道/事件/CPU Load  │
                └─────────────────┘   └───────────────────┘
```

设计约束：

- 活动 DAP 会话存在时，RTT 必须由 DAP owner 提供，不得回退到扩展宿主的第二连接；
- `RttStreamScheduler` 是 NativeScheduler 之上的逻辑流调度，不直接绕过 owner；
- Step、Continue、Halt、Reset、Breakpoint 和变量写入始终优先于 RTT 读取；
- 普通 RTT 日志、RTT Timeline 和 RTOS Trace 使用独立逻辑消费者，优先使用独立 Up Channel；
- 目标端时间戳是采样与事件的权威时间；主机接收时间仅用于诊断；
- 所有流协议必须包含版本、长度、序号和恢复边界。

### 4.1 MCU 侧官方兼容合同

“与官方一致”需要分层验收，不能把“J-Link 能读到字节”误称为 SystemView 兼容：

| 兼容层 | Orbit 的要求 | 验收方式 |
|---|---|---|
| RTT 传输层 | 使用官方 `SEGGER_RTT_*` API、Control Block 和通道布局；J-Link RTT Viewer/SystemView 能发现和读取对应通道。 | 官方工具 + Orbit 同时读取；验证通道、读写偏移、缓冲区和 overflow 语义。 |
| SystemView 事件层 | 使用官方 `SEGGER_SYSVIEW_*` 事件 API、变长编码、时间戳和 RTOS integration；Orbit 解析官方 target source 生成的数据。 | 同一固件记录与官方 SystemView 对照，逐事件比较顺序、时间和参数。 |
| Orbit Sample 层 | 仍调用官方 RTT 写入 API；只在独立通道中定义 Orbit 的采样 payload，不修改 RTT 外壳。 | 官方 RTT 工具可读取原始字节；Orbit 能按版本、长度和序号解码。 |
| 主机产品层 | Orbit 可以拥有自己的缓存、解析器、Timeline 和 Trace UI，不要求复刻官方主机实现。 | 许可证/商标审查通过；功能差异在兼容表中明确。 |

实现原则：

- MCU 侧优先直接集成并固定版本的 SEGGER 官方 `SEGGER_RTT.c/.h`、`SEGGER_RTT_Conf.h`、SystemView `SYSVIEW` 源码和对应 RTOS interface；
- Orbit 只提供项目配置、通道规划、signal descriptor 和解析/显示代码；
- 不自行复制 RTT Control Block 结构、读写偏移规则、锁语义或 SystemView 私有主机协议；
- 如果官方 SystemView 已有适合的 Data Sample API，优先评估复用；只有 Orbit 专用需求无法表达时，才增加独立 Orbit Sample payload；
- 每次升级官方 target source 都要重新跑 RTT 互操作、SystemView 对照和目标板回归。

## 5. 技术选型任务

### 阶段 A：需求、技术选型和基线

阶段 A 的当前执行记录见 [`docs/rtt-trace-phase-a/`](rtt-trace-phase-a/)。其中“源码/配置”“自动测试”和“真实硬件”分别记录，不互相替代。

| ID | 任务 | 描述 | 产物与验收 | 依赖 |
|---|---|---|---|---|
| A01 | 定义产品术语和边界 | 固定 `RTT Log`、`RTT Timeline`、`RTOS Trace`、`SystemView-compatible` 的含义，避免把数值流和事件流混为一体。 | 一份术语表；每项能力有明确输入、输出和非目标。 | 无 |
| A02 | 固定首批目标平台 | 选择首个 MCU、J-Link 型号、接口速率、FreeRTOS 版本、编译器和示例工程。 | 形成首批支持矩阵；至少包含一个真实 STM32 + FreeRTOS 工程。 | A01 |
| A03 | 建立现有 Timeline 基线 | 测量当前 DAP 表达式采样在 1、4、8、16 个变量下的频率、抖动、CPU 占用和 Step 延迟。 | 可重复的基线脚本/步骤及结果文件；区分 Native、Legacy 和硬件结果。 | A02 |
| A04 | 建立 RTT 原始吞吐基线 | 在不解析业务协议的情况下测试不同读取块、轮询周期、SWD 速率和缓冲区大小下的 RTT 吞吐及 overflow。 | 吞吐、延迟、CPU、丢字节和 Step 干扰基线。 | A02 |
| A05 | 作出协议兼容性决策 | 决定 RTT Timeline 使用 Orbit 自有二进制协议；RTOS Trace 是直接兼容 SystemView 事件、转换为 Orbit 中间格式，还是只实现语义兼容。 | ADR：选项、理由、风险、许可证边界、回退方案。 | A01 |
| A06 | 选择解析与渲染位置 | 比较 DAP 进程、扩展宿主、Webview、Worker/WASM 的解析和缓存职责，防止大流量阻塞 DAP stdio 或 VS Code UI。 | ADR：线程/进程边界、IPC 批量大小、最大内存和故障隔离。 | A03、A04 |
| A07 | 选择记录文件格式 | 比较 `.SVDat` 兼容、Orbit 自有容器、CSV/JSON 辅助导出；定义元数据、版本、索引和压缩。 | 文件格式 ADR 与最小 schema。 | A05、A06 |
| A08 | 许可证和命名审查 | 核对 SEGGER target source、SystemView 主机应用、协议资料及 “SystemView” 商标/兼容表述。 | 形成允许复用、必须重写、需要授权确认的清单。 | A05 |
| A09 | 建立验证矩阵 | 定义单元、集成、Mock DLL、回放、性能和真实硬件场景；预先规定通过门槛。 | `RTT/Trace validation matrix`；任何硬件结论都有日志和环境信息。 | A02、A03、A04 |
| A10 | 固定 MCU 官方兼容合同 | 固定 SEGGER RTT/SystemView target source 版本、配置头、RTOS integration、通道约定和允许的 Orbit 扩展点。 | 一份 MCU 侧兼容合同；列出可直接使用的官方 API、禁止重定义的结构和版本升级步骤。 | A05、A08 |

阶段 A 退出条件：

- 首个目标板、RTOS 和 J-Link 环境确定；
- 技术路线、进程边界、协议兼容策略和记录格式均有明确 ADR；
- 现有 Timeline 与原始 RTT 都有可重复基线；
- 后续任务不再依赖“以后再决定”的核心架构选项。

当前完成度：A01、A02（当前目标已固定，J-Link 物理型号/实际 DLL 仍待硬件记录）、A05、A06、A07、A08、A10 已形成文档决策；A03 已有真实目标 DAP record 短测，A04 已完成三组 Channel 1 host-side readRtt 字节窗口。A03 完整 Timeline UI 统计、Legacy 对照、控制操作干扰和有效 Step P95 仍待补测。

## 6. RTT 传输与调度任务

### 阶段 B：统一 RTT 基础设施

| ID | 任务 | 描述 | 产物与验收 | 依赖 |
|---|---|---|---|---|
| B01 | 定义 `RttTransport` 接口 | 抽象 start、stop、read、control-block address、capabilities、owner loss 和错误类型。 | Native/Legacy 共享类型；上层不直接调用具体 DLL/helper。 | A05、A06 |
| B02 | Native helper RTT 协议补齐 | 为 helper JSON-lines 协议增加需要的 RTT capability、错误码、读取统计和必要控制参数。 | `main.cpp` 与 `cpp-jlink-channel.ts` 协议同步；Mock 覆盖握手与异常。 | B01 |
| B03 | Legacy RTT 能力对齐 | 使 koffi 路径与 Native 返回相同语义，包括 0 字节、负返回值、未启动、owner loss 和 stop 幂等。 | Native/Legacy 合约测试通过。 | B01、B02 |
| B04 | RTT 会话生命周期 | 定义 connect、DAP initialized、target run/halt、reset、disconnect、terminate 和 owner loss 时 RTT 的启动/停止行为。 | 状态机文档与测试；会话结束后无残留轮询。 | B01 |
| B05 | RTT Control Block 定位 | 支持 ELF 符号地址、用户显式地址和 J-Link 自动搜索；禁止在未知 RAM 范围无界扫描。 | 可报告实际使用的地址和定位方式；错误可诊断。 | B01、B04 |
| B06 | 通道注册与所有权 | 建立 Channel Registry，记录 channel index、名称、用途、消费者、缓冲策略和冲突。 | 日志、Timeline、Trace 不会静默争用同一通道。 | B04 |
| B07 | `RttStreamScheduler` 核心 | 在 NativeScheduler 之上实现轮询、块大小、每轮预算、公平性、取消、暂停和恢复。 | 控制任务不会因连续 RTT 流饿死；单 in-flight 保持。 | B03、B04、B06 |
| B08 | 消费者优先级与配额 | 定义普通日志、采样流、RTOS Trace 的逻辑优先级、吞吐配额和突发预算。 | 高流量消费者不能无限占用队列；配置有安全上下限。 | B07 |
| B09 | 背压和内存上限 | 为 DAP、扩展宿主和 Webview 之间的队列定义批量、上限、丢弃策略和关闭行为。 | 慢 UI 不会导致 DAP 内存持续增长；丢弃可见且有计数。 | A06、B07 |
| B10 | 流诊断指标 | 记录 bytes/s、read calls/s、空读率、队列深度、最大延迟、sequence gap、overflow 和消费者丢弃。 | `log.dap`/`log.dll` 中可重建一次流故障；无临时 `console.log`。 | B07、B09 |
| B11 | 故障注入测试 | 模拟空读、短读、分包、owner loss、目标 reset、通道消失、延迟和读错误。 | 自动测试验证恢复、停止和错误传播，无 extension-host fallback。 | B04、B07、B09 |
| B12 | RTT 并发硬件验收 | 在真实板上同时运行 Step、Watch、普通 RTT 日志和高流量读取。 | Step/Continue 正常，采样可恢复，overflow 与性能满足 A09 门槛。 | B10、B11 |
| B13 | 官方 RTT 互操作验收 | 使用官方 J-Link RTT 工具/系统工具检查 Control Block、通道、缓冲区和读写行为。 | 官方工具与 Orbit 能读取同一官方 RTT 通道；差异有记录，不接受“Orbit 自己能读”作为唯一结论。 | A10、B05、B06 |

阶段 B 退出条件：

- 所有 RTT 使用者都通过统一 Transport 和 Stream Scheduler；
- 调试控制始终优先，owner 生命周期无泄漏；
- Native 和 Legacy 至少在自动测试中行为一致；
- 真实板并发场景有可复查证据。

## 7. RTT Timeline 任务

### 阶段 C：目标端高速数值采样

| ID | 任务 | 描述 | 产物与验收 | 依赖 |
|---|---|---|---|---|
| C01 | 定义公共流帧头 | 定义 magic、version、stream type、header length、payload length、sequence、target timestamp、flags 和校验策略。 | 规范包含字节序、对齐、最大长度、版本升级和重同步规则。 | A05、B06 |
| C02 | 定义 Sample payload | 定义 signal ID、数据类型、单位/缩放、单点与批量布局；优先固定宽度批量格式。 | C 与 TypeScript 测试向量互相解析；禁止逐样本 JSON。 | C01 |
| C03 | 选择目标端信号注册方式 | 比较编译期注册表、主机下发地址表和 DWARF 自动解析；MVP 默认使用编译期注册或受控地址表。 | ADR 明确允许的数据类型、地址生命周期和安全检查。 | A05、C02 |
| C04 | 实现目标端采样模块 | 在目标控制周期或定时器中读取注册信号，打目标时间戳，批量写入独立 RTT Up Channel。 | 独立 C 模块、配置头和最小示例；不依赖 Orbit UI 才能产出测试流。 | C02、C03 |
| C05 | 目标时间基准 | 定义 DWT cycle counter、硬件 timer、tick 扩展、回绕处理和频率变化；发送时间基准元数据。 | 长时间记录跨回绕连续；时间单位可转换；频率变化有事件。 | C04 |
| C06 | 主机 Sample 解码器 | 实现增量拆包、跨 read 拼包、版本校验、sequence gap 和异常重同步。 | 纯函数/流式单元测试覆盖随机分片、损坏和丢包。 | C01、C02 |
| C07 | Timeline 数据源抽象 | 将现有 DAP 表达式采样与 RTT Sample 流抽象成独立 source，保持现有模式可用。 | 用户可明确选择 `DAP` 或 `RTT`；失败不静默切换。 | B07、C06 |
| C08 | 信号配置和发现 UI | 显示目标固件公开的 signal ID、名称、类型、单位和采样能力；不把任意表达式伪装为高速 RTT 信号。 | 配置可保存；固件与配置不匹配时给出明确错误。 | C03、C07 |
| C09 | 缓存、降采样和渲染 | 使用有界环形缓存；按像素或时间桶降采样；UI 批量更新，原始数据与显示数据分离。 | 在目标数据率下 UI 可交互，内存有明确上限，缩放不丢失峰值。 | A06、C07 |
| C10 | 记录与导出 | 将原始采样包或解码数据写入记录文件，支持离线打开及 CSV 导出。 | 长时间记录不依赖 Webview 常驻；导出保留目标时间戳和丢包区间。 | A07、C06、C09 |
| C11 | RTT Timeline 诊断 | 在面板显示当前速率、目标采样率、主机接收率、sequence gap、buffer overflow 和 UI drop。 | 用户能区分“目标没发送”“RTT 没读到”“主机主动降采样”。 | B10、C09 |
| C12 | RTT Timeline 验收 | 使用正弦/阶跃/计数器等可预测信号验证频率、相位、峰值、时间戳和丢包。 | 自动回放与真实板结果都达到 A09 门槛。 | C10、C11 |
| C13 | 官方 RTT API 采样适配 | 目标端采样模块只通过官方 RTT API 写入独立 Up Channel；Orbit descriptor 和 payload 不改变 RTT 外壳。 | 官方 RTT 工具可读取原始采样通道；官方 Control Block/lock/channel 语义保持不变。 | A10、C02、C04 |

阶段 C 退出条件：

- RTT Timeline 不再依赖主机 `Date.now()` 作为采样时间；
- 可以识别并显示丢包，而不是用直线掩盖数据缺口；
- 现有 DAP Timeline 保持可用；
- 真实板有高于现有 DAP 采样链路的可量化结果。

## 8. SystemView 兼容解析任务

### 阶段 D：RTOS 事件流和状态重建

| ID | 任务 | 描述 | 产物与验收 | 依赖 |
|---|---|---|---|---|
| D01 | 确定首版兼容范围 | 首版限定 FreeRTOS 单核，并列出支持的 SystemView system events、OS events、user events 和明确不支持项。 | 兼容表按事件 ID/语义列出；不使用“完全兼容”模糊表述。 | A02、A05、A08 |
| D02 | 建立官方参考数据集 | 使用 SEGGER 官方 target source 和官方 SystemView 主机生成可对照记录，覆盖 Task、ISR、Marker、API 和 overflow。 | 保存固件版本、配置、原始字节、官方截图/导出和预期事件表。 | D01 |
| D03 | SystemView 增量拆包 | 解析事件 ID、变长整数、差分时间戳、同步和系统描述；支持任意 RTT read 分片。 | 测试向量与官方记录一致；损坏数据可重同步。 | C01、D02 |
| D04 | 系统与对象元数据 | 解析 CPU/timestamp 频率、RAM base、task/resource/ISR 名称、优先级、stack 信息和模块描述。 | 同一 ID 可稳定映射到可读对象；未知对象保留原始 ID。 | D03 |
| D05 | RTOS 状态机 | 根据 Task、Scheduler、ISR、Idle 事件重建 Running、Ready、Blocked、ISR nesting 和上下文切换。 | 对确定事件序列得到确定区间；非法序列产生诊断而非崩溃。 | D03、D04 |
| D06 | API 与嵌套调用模型 | 支持 API enter/exit、返回值、资源参数和嵌套持续时间；处理缺失 exit。 | 事件列表与 Timeline 可关联一次调用的开始、结束、上下文和耗时。 | D05 |
| D07 | Marker、Message 和 Data Sample | 解析性能标记、Terminal 输出和 SystemView Data Sample，并映射到统一时间轴。 | 可与 Task/ISR 事件同步选择；未知消息格式不破坏主流。 | D03、D04 |
| D08 | overflow、sync 和不完整记录 | 明确定义丢包后哪些状态失效、何时恢复、如何显示时间线断点。 | 不跨不可信区间计算错误 CPU Load；UI 显示数据缺口。 | D03、D05 |
| D09 | 中间事件模型 | 建立与传输格式解耦的 `TraceEvent`、`ContextInterval`、`ApiSpan`、`DataGap` 等模型。 | SystemView 和未来 Orbit 自有协议可进入同一 UI；模型可序列化。 | D05、D06、D08 |
| D10 | ELF 与消息映射 | 读取 ELF/专用 section 或消息文件，为资源和日志提供符号名称，同时处理 ELF 不匹配。 | 显示 ELF build identity；不匹配时降级为原始 ID/地址。 | D04、A07 |
| D11 | 解析性能优化 | 评估 TypeScript、Worker、Native/WASM；建立大记录的解码、索引和内存基线。 | 达到 A09 中的实时率和离线打开门槛，且不阻塞 DAP。 | A06、D09 |
| D12 | SystemView 解析验收 | 将 Orbit 解析结果与官方 SystemView 对同一记录的事件顺序、时间和上下文区间进行比较。 | 已支持事件逐项一致；差异都有原因和测试。 | D02、D10、D11 |
| D13 | 官方 SystemView target 对照 | 使用官方 SystemView target source 和 RTOS integration 生成记录，确认 Orbit 不依赖私有主机实现。 | 首版支持事件与官方工具在字节/事件语义上有对照证据；不支持项进入兼容表。 | A10、D02、D03 |

阶段 D 退出条件：

- 能稳定解析首版兼容范围内的官方参考记录；
- 事件流、RTOS 状态机和 UI 模型互相解耦；
- overflow 或损坏数据不会生成伪造的连续时间线；
- 兼容范围和许可证表述经过确认。

## 9. RTOS Trace UI 任务

### 阶段 E：独立 RTOS Trace 产品界面

| ID | 任务 | 描述 | 产物与验收 | 依赖 |
|---|---|---|---|---|
| E01 | 创建独立 Trace 面板 | 新增 `RTOS Trace`/`Orbit Trace` 面板、会话状态和数据源选择，不挤入现有数值 Timeline。 | 面板可启动/停止/打开离线记录；无数据时状态清晰。 | D09 |
| E02 | Context Timeline 泳道 | 显示 ISR、Scheduler、Task、Idle 的运行区间、Ready 区间、嵌套和切换连线。 | 缩放、平移、hover 和选择在大数据量下可用。 | D05、E01 |
| E03 | Events 列表 | 显示序号、目标时间、上下文、事件类型、参数、持续时间和数据缺口。 | Timeline 与列表双向定位；支持类型和上下文过滤。 | D09、E01 |
| E04 | CPU Load 与 Context Statistics | 按可见时间窗计算 CPU Load、运行/Ready/Blocked 时间、次数和 min/max。 | 数据缺口不纳入可信统计；算法有单元测试。 | D08、E02 |
| E05 | API/Marker/Log 关联 | 在泳道和事件列表中显示 API span、Marker、Terminal 日志及其当前上下文。 | 同一时间点的波形、事件和日志可联动选择。 | D06、D07、E02、E03 |
| E06 | RTT Timeline 联动 | RTT 数值波形与 RTOS Trace 共用目标时间轴，支持同步游标、区域选择和缩放。 | 用户可查看某次 ISR/Task 区间内的变量变化。 | C09、D09、E02 |
| E07 | Heap 与资源视图 | 在首版调度功能稳定后增加 heap alloc/free、资源命名和泄漏提示。 | 缺失事件导致 heap 模型失效时必须明确标记。 | D06、D08 |
| E08 | 搜索、触发和导航 | 支持下一次同类事件、指定时间/事件、Marker、Task 切换和触发条件。 | 导航不会阻塞持续录制；触发结果可复现。 | E03 |
| E09 | 多核扩展设计 | 在单核稳定后设计每核 RTT channel、公共时间基准、跨核事件和 UI 分组。 | 独立 ADR；未完成前不对外宣称多核兼容。 | D12、E02 |
| E10 | 本地化与可访问性 | 为中文/英文文案、颜色、键盘操作和高对比度建立规范。 | 稳定英文 key，中文翻译不改变技术标识。 | E01—E08 |

阶段 E 退出条件：

- 用户可以从事件列表和泳道回答“何时发生、谁触发、运行多久”；
- RTT 数值与 RTOS 事件使用同一目标时间轴；
- UI 在持续记录与大文件回放时保持可操作；
- 统计对丢包和不完整记录保持诚实。

## 10. 集成、质量和发布任务

### 阶段 F：系统整合与发布

| ID | 任务 | 描述 | 产物与验收 | 依赖 |
|---|---|---|---|---|
| F01 | DAP 生命周期整合 | 在 launch、configurationDone、continue、pause、reset、terminate 和异常退出中统一管理 RTT 流。 | 无会话后轮询；停止/重启不会重复注册消费者。 | B04、C07、E01 |
| F02 | 控制操作并发回归 | 压测 Step Into/Over/Out、Continue、Halt、Breakpoint、Watch、变量写入与双 RTT 流并存。 | 满足现有 DAP 兼容不变量；控制操作不会饥饿。 | B12、C12、D12 |
| F03 | Native/Legacy 兼容矩阵 | 分别验证连接、RTT discovery、读取、重置、owner loss 和停止；记录不支持能力。 | 结果按代码、自动、硬件三个证据等级列出。 | B03、F01 |
| F04 | 长时间稳定性 | 连续记录 10 分钟、1 小时和更长场景，监控内存、文件大小、overflow、UI drop 和恢复。 | 没有无界内存增长；所有丢失均可观测。 | C10、D11、F02 |
| F05 | 低功耗和复位场景 | 验证 WFI/低功耗、软件复位、硬复位、RTT Control Block 重建和固件重刷后的行为。 | 不输出伪造连续数据；需要重启时给出明确提示。 | B04、B05、D08 |
| F06 | 配置与诊断 UX | 汇总 channel、control block、stream rate、buffer、固件协议版本和 ELF identity。 | 一份可复制的诊断报告足以定位常见故障。 | B10、C11、D10 |
| F07 | 固件 SDK 与示例 | 提供 RTT Sample 示例、FreeRTOS Trace 示例、配置头、linker 注意事项和通道规划。 | 示例工程可独立编译；目标端开销和限制有说明。 | C04、D02 |
| F08 | 用户文档 | 编写启用步骤、功能边界、带宽调优、overflow、低功耗、许可证和常见问题。 | 文档区分 DAP Timeline、RTT Timeline、RTOS View 和 RTOS Trace。 | F06、F07 |
| F09 | Feature Flag 与灰度 | RTT Timeline 和 RTOS Trace 分别设置实验开关、配置迁移和安全默认值。 | 可独立禁用或回退，不影响现有调试功能。 | F01—F08 |
| F10 | 发布门禁 | 固定必须通过的 typecheck、Vitest、native mock、bundle、回放和真实硬件矩阵。 | 门禁证据完整后才改变默认设置或发布说明。 | A09、F03、F04、F05 |

## 11. 建议里程碑

### M0：决策完成

完成 A01—A09。得到可执行 ADR、基线和验证矩阵。

### M1：统一 RTT 基础设施

完成 B01—B12。普通 RTT 日志和测试消费者均通过统一调度器，真实板并发可用。

### M2：RTT Timeline MVP

完成 C01—C12。目标端主动采样、目标时间戳、丢包识别、实时曲线和记录导出可用。

### M3：FreeRTOS Trace MVP

完成 D01—D12，并完成 E01—E04。可显示单核 FreeRTOS Task、ISR、Scheduler、Idle、Events 和 CPU Load。

### M4：波形与事件联动

完成 E05、E06、E08。RTT Timeline 与 RTOS Trace 使用同一时间轴并可相互定位。

### M5：产品化

按首版范围完成其余 E、F 任务，通过发布门禁。

## 12. 关键路径

最短有效路径为：

```text
A02 目标平台
  → A03/A04 基线
  → A05/A06 技术决策
  → B01—B12 RTT Transport/Scheduler
  → C01—C06 目标端 Sample + 主机解码
  → C07—C12 RTT Timeline
  → D01—D05 SystemView 解码 + RTOS 状态机
  → D09/D12 中间模型与兼容验收
  → E01—E06 Trace UI 与波形联动
  → F01—F10 集成和发布
```

以下任务可以并行：

- A07 记录格式与 A08 许可证审查；
- C04 目标端采样模块与 C06 主机解码器；
- D10 ELF 映射与 E01 面板骨架；
- F07 固件示例与 F08 用户文档；
- 自动回放测试可与真实硬件矩阵独立推进。

## 13. 每个任务的完成定义

每个任务只有同时满足以下条件才可标记完成：

1. 设计或行为已经写入对应文档、类型或协议规范；
2. 实现不绕过唯一 J-Link owner 和 NativeScheduler；
3. 错误、取消、会话结束和 owner loss 路径已经定义；
4. 有与风险相称的自动测试；
5. 如果任务声称硬件行为，必须有真实 J-Link/MCU 日志或用户确认；
6. 不将 Mock、构建或源代码存在误写为硬件通过；
7. 没有破坏 Watch、Timeline、DAP evaluate/variables、变量写入和 Step；
8. MCU 侧没有私自替换官方 RTT/SystemView 接口或 Control Block 语义；
9. 相关配置、诊断和文档已同步。

## 14. 参考资料

- [SEGGER SystemView 用户手册](https://doc.segger.com/UM08027_SystemView.html)
- [SEGGER SystemView 产品页](https://www.segger.com/products/development-tools/systemview/)
- [SEGGER SystemView target sources](https://github.com/SEGGERMicro/SystemView)
- [J-Link RTT 技术说明](https://www.segger.com/products/debug-probes/j-link/technology/about-real-time-transfer/)
- [SEGGER SystemView Knowledge Base](https://kb.segger.com/SystemView)

## 15. 首批建议执行任务

在开始写 RTT Timeline 或 Trace UI 前，建议依次执行：

1. **A02**：固定第一块目标板、FreeRTOS 和 J-Link 环境；
2. **A03、A04**：取得现有 DAP Timeline 与原始 RTT 的真实基线；
3. **A05、A06**：完成协议兼容策略和进程边界 ADR；
4. **B01、B04、B06、B07**：先定义 Transport、生命周期、Channel Registry 和 Stream Scheduler；
5. **B10、B11**：先具备诊断和故障注入，再接入真正业务流；
6. **C01、C02**：冻结公共帧头与 Sample payload；
7. **C04、C06**：用可预测测试信号完成第一个端到端 RTT 波形；
8. 通过 **C12** 后再正式进入 SystemView/RTOS Trace 解析。

这样可以先验证最基础、风险最高的 RTT 传输和调度问题，避免在协议、UI 和 RTOS 状态机都完成后才发现吞吐、owner 或调试并发不成立。

阶段 A 的执行顺序和当前状态：

1. 阅读 [`phase-a-glossary.md`](rtt-trace-phase-a/glossary.md) 和 [`platform-matrix.md`](rtt-trace-phase-a/platform-matrix.md)，冻结术语与首批目标；
2. 按 [`decision-records.md`](rtt-trace-phase-a/decision-records.md) 冻结协议、进程边界、记录格式以及 SystemView/RTT 命名边界；
3. 按 [`baseline-and-validation.md`](rtt-trace-phase-a/baseline-and-validation.md) 执行 A03/A04，未连接真实目标前只允许填写准备项，不能填写硬件通过；
4. 按 [`mcu-compatibility-contract.md`](rtt-trace-phase-a/mcu-compatibility-contract.md) 固定官方 RTT/SystemView source、版本和升级记录后，才进入阶段 B。
