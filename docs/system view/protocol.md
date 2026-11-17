# RTOS 数据契约与 SystemView 协议依据

- 冻结日期：2026-11-18；契约版本：1（阶段 0 设计基线）。
- 本阶段不注册新 DAP、Automation API 或 MCP 接口；本文件约束后续数据语义，线上接口名称和鉴权沿用相应实施阶段。
- 以固定文件内容为依据，不把当前上游分支或旧调研报告作为协议常量来源。

## 1. 身份、能力与错误

快照请求、响应与推送携带 sessionId、sessionGeneration、operationGeneration、elfSha256、bootGeneration、layoutId。sessionId 是精确会话身份；operationGeneration 在控制操作及刷新取消时失效；bootGeneration 在重启/重新烧录时改变。布局缓存由 ELF 内容和布局身份决定，运行数据及差分缓存还受启动代次限制。

Trace 另外携带 recordId、segmentId 和 batchSequence。会话替换、owner 丢失、停止后晚到的数据不能进入新会话或新记录。原始数据和归档中的大整数 tick 使用十进制字符串，计算模块可转 bigint。

capability 各项采用以下结构，UI 与 API 消费同一状态：

```typescript
type Capability = {
  available: boolean;
  reason?: string; // available=false 必填
  evidence: 'source' | 'offline' | 'hardware';
};
```

独立能力至少包括 layout、taskSnapshot、stackBounds、stackWatermark、runtimeCounters、rttEnumerate、rttUpRead、rttDownWrite、continuous、singleShot、postMortem、timeMapping。内存读取可用不等于 Trace 或精确时间映射可用；带宽声明须附链路、配置及证据。

错误包含稳定 errorCode、operation、message、retryable、completion（not-started/completed/unknown）及可用的 diagnostics，沿用底层已有错误码。RTOS 分类为 RtosNotDetected、DwarfUnavailable、LayoutIncomplete、LayoutAmbiguous、InvalidAddress、CorruptList、ShortRead、BudgetExceeded、SnapshotChanged、SessionChanged、TargetReadCancelled、UnsupportedCapability。短读保留请求和实际长度；写入完成状态 unknown 不自动重放。

## 2. 快照模型

```typescript
type Consistency = 'halted-consistent' | 'live-best-effort' | 'partial' | 'stale' | 'unavailable';
type Field<T> = {
  source: string;
  unit: string; // address、text、enum、bytes、words、ticks、percent 等
} & ({ available: true; value: T } | { available: false; reason: string });
```

值未知时没有 value，不能填 0。保留最后成功快照时返回 stale、原采集时间及原因；unavailable 表示没有可用快照。

| 数据组 | 必要字段与语义 |
|---|---|
| 封套 | 上述身份、snapshotSequence、主机采集起止时间、已知 targetState、consistency、reason、kernel/version 来源、tasks、问题清单 |
| 任务身份 | tcbAddress、可用的创建编号及来源；没有编号时声明跨帧身份不确定，不用名称或单一地址保证生命周期唯一 |
| 任务基础 | name、state、所属列表证据、current、priority、可选 basePriority；状态含 running/ready/blocked/suspended/termination/unknown |
| 栈 | stackBase、已知 stackEnd、growthDirection、stackWordBytes、capacityBytes、watermarkBytes、填充值、扫描时间/范围及完成状态 |
| 运行统计 | 累计计数、位宽、计数器/总量来源、有效差分区间、可用时的 percent；关闭、首帧、总量为零、重置或口径不明均不可用 |
| 预算诊断 | 队列等待、I/O、解析、总耗时，轮次/批次/字节/节点数、取消或预算原因、实际覆盖列表 |

布局从全局变量所指向的实际 DWARF 类型出发，保留 CU/类型身份；typedef、修饰类型、数组、指针尺寸及字段偏移复用现有类型图。同名类型不能取首个命中。ready、两条 delayed、pending-ready、suspended、termination 按符号和配置存在性解析，不用 fixture 数值偏移兜底。

按锚点→链表节点→TCB/详情分轮读取，每轮服从地址、字节、批次、节点和时间预算。RAM 范围来自目标描述或明确配置。控制操作使整次采集失效，不跨代次拼接。运行态前后检查锚点并验证结构；锚点相同仍只标 live-best-effort。暂停态结构完整且代次不变才标 halted-consistent。重试有界；损坏、短读或预算不足返回 partial 和覆盖范围。

栈扫描按需、分片执行，不将当前 SP 差值当作历史峰值。CPU 使用内核计数差分，说明 ISR 计入当前任务、当前运行段未结算等口径；不用低频采样命中次数替代 CPU%。回绕与启动重置分别处理，不跨身份不确定区间计算差分。

后续对象还须携带 kind、地址、发现方式（registry/global/list）和字段可用性；候选持有/等待关系附证据及快照一致性，不据单帧运行态结果宣称死锁。

## 3. Trace 生命周期与缺口

主状态为 idle → preparing → recording → stopping → stopped，另有 paused、error、incomplete。每次变更记录原因、身份和时间；接收暂停与目标记录停止是独立事实。

- 仅显式 Start 可以执行模式所需目标写入；打开面板、查询能力、打开离线文件不启停目标记录。
- 同 recordId 的重复 Start/Stop 返回现状；不创建第二 reader，不重复发送控制。stopping 在有界排空及落盘成功后才成为 stopped。
- 取消订阅只解除消息接收；最后订阅者关闭不停止显式录制。停止 Trace 不停止文本 RTT。
- 会话/owner 结束、写入状态未知、落盘失败或排空超时保留 incomplete/error，不声称目标已停止。
- 分别记录 target-overflow、host-drop、control-pause、decode-sync-loss、storage-failure；数量无法证明时为 unknown。缺口切断执行、Ready、Marker 配对，恢复同步后新建可信段。
- 保留原始 tick、timestampBits、frequencyHz、时间段及映射质量；频率变更、复位、不可信回绕另起段。主机接收时间不替代事件时间。

## 4. 协议与许可依据

| 范围 | 固定来源 | 已核对内容与边界 |
|---|---|---|
| SystemView | 现有 vet6_led/ThirdParty/SystemView，头文件声明 3.32.0；SEGGER_SYSVIEW.c hash 见 compatibility.md | 0.3 原样纳入 fixture；本地快照无确切官方 commit，不虚构 tag/commit |
| 上游 | https://github.com/SEGGERMicro/SystemView | 用于归属和对照，不用 main 覆盖固定快照 |
| 官方手册 | https://doc.segger.com/UM08027_SystemView.html ，2026-11-18 查阅 | Recording、Target configuration、三种模式；在线手册会更新，具体字节以固定源码及独立样本为准 |
| RTT | P-RTLog/third_party/segger_rtt 文件快照；上游 https://github.com/SEGGERMicro/RTT | 不从 SystemView 推断 RTT 版本；0.3 保存每文件 hash 和 RTT LICENSE.md |
| FreeRTOS | STM32CubeH7 1.12.1 中 10.3.1 及 CMSIS v1/v2 | 与原版 V10.3.1-kernel-only 区分，记录插桩差异及许可 |
| 许可 | SystemView 源文件头、RTT LICENSE.md、FreeRTOS MIT、CMSIS Apache-2.0、ST 组件许可 | 仅纳入必要源码和许可证，不复制桌面程序及商业软件许可包 |
| API 描述 | SEGGER_SYSVIEW_FreeRTOS.h 的 apiID 与 trace 宏 | apiID_OFFSET=32，参数逐宏核对；尚无独立官方 FreeRTOS 描述文件快照，列为后续 Events 解释缺口 |
| SVDat | 阶段 5.3 官方工具双向互操作专项 | 当前未验证容器，不输出自定义 .SVDat；原始流用 .bin |

### 4.1 RTT 结构

Cortex-M 32 位 ABI 下：control block 是 acID[16]、MaxNumUpBuffers、MaxNumDownBuffers，之后为 Up 数组再 Down 数组。descriptor 是 sName、pBuffer、SizeOfBuffer、WrOff、RdOff、Flags，六个 32 位字段共 24 bytes。依据 SEGGER_RTT.h；64 位主机 sizeof 不能替代目标 ABI。

按名称和合法元数据发现 SysView，不固定通道号；fixture 使用 Channel 2，文本为 0。普通环形缓冲容量为 SizeOfBuffer-1，WrOff==RdOff 表示空。Up 消费推进 RdOff；Down 先写数据后提交 WrOff。短写/超时可能不能判断提交结果，禁止盲重试。Post-Mortem 原始 RAM 读取不推进读指针。

### 4.2 字节编码、事件与命令

依据 SEGGER_SYSVIEW.c 的 ENCODE_U32、_SendPacket、_SendPacket_Ex、_EncodeStr：U32 采用低 7 bit 优先、最高位继续标记的变长整数，最多 5 bytes。payload 后附 timestamp delta，按 timestampBits 截断。首个非零 timestamp 在 LastTxTimeStamp 为零时 delta=0，不能从接收时间补绝对起点。sync 为 10 个零字节，无 timestamp。短事件按 schema 读取；带长度事件的 payload 长度与随后 delta 分开处理，不能统一当作定长包。

| 事件 | ID（3.32） | 后续最小解释 |
|---|---|---|
| OVERFLOW | 1 | 丢包与可信段边界 |
| ISR_ENTER / ISR_EXIT | 2 / 3 | 进入参数与退出，支持嵌套 |
| TASK_START_EXEC / TASK_STOP_EXEC | 4 / 5 | 任务运行边界 |
| TASK_START_READY / TASK_STOP_READY | 6 / 7 | Ready 进入与离开 |
| TASK_CREATE / TASK_INFO | 8 / 9 | 身份及元数据 |
| TRACE_START / TRACE_STOP | 10 / 11 | 记录边界，不替代启停完成确认 |
| SYSTIME_CYCLES / SYSTIME_US / SYSDESC | 12 / 13 / 14 | 时间/系统描述 |
| MARK_START / MARK_STOP | 15 / 16 | 仅在完整可信段配对 |
| IDLE / ISR_TO_SCHEDULER | 17 / 18 | 调度相关语义 |
| TIMER_ENTER / TIMER_EXIT / STACK_INFO | 19 / 20 / 21 | 可区分时才形成 Timer 视图 |
| INIT / TASK_TERMINATE / EX | 24 / 29 / 31 | 时钟、生命周期及扩展事件 |

完整索引以固定 SEGGER_SYSVIEW.h 为准。未知事件不能猜 schema；有长度的保留原始字节，不能越过无长度的未知短事件继续制造可信区间。资源 ID 根据 INIT 的 RAM base 和 ID_SHIFT 还原，不把所有整数都当地址。

SEGGER_SYSVIEW_Int.h 的 Down 命令：START=1、STOP=2、GET_SYSTIME=3、GET_TASKLIST=4、GET_SYSDESC=5、GET_NUMMODULES=6、GET_MODULEDESC=7、HEARTBEAT=127、GET_MODULE=128（后随模块号）。普通命令单字节；所选实现对未知扩展命令消费一个参数。Post-Mortem 编译路径不处理普通 Down 命令。

## 5. 三种模式的目标路径

| 模式 | 固件配置与启停 | 有效区与同步依据 | 阶段 0 证据 |
|---|---|---|---|
| Continuous | POST_MORTEM_MODE=0；显式 Start/Stop；持续消费 Up；应用可调用标准 API 启停 | RdOff/WrOff，起始 sync/INIT；满缓冲时 WriteSkipNoLock 丢弃，后续 OVERFLOW | 0.3 用官方记录组件与独立主机 RTT 内存生成流，不接探针 |
| Single-Shot | POST_MORTEM_MODE=0；应用 Start；不消费 Up；场景结束 Stop 后置 frozen | 未环绕时 [0,WrOff)；冻结时记录容量/offset/溢出。所选满缓冲路径是丢包，不能假定自动 Stop | 0.3 验证显式冻结和满缓冲异常；溢出不伪装完整记录 |
| Post-Mortem | POST_MORTEM_MODE=1；应用 Start，周期 sync；Stop 后置 frozen；冻结前不允许普通 reader | WriteWithOverwriteNoLock 保留尾部；按冻结 descriptor 重排，从首个完整 sync 起解释，前缀损失保留状态 | 0.3 验证覆盖、周期 sync 和冻结；不是 HardFault 恢复实测 |

三种固件均导出 fixture 专用模式/状态/缓冲元数据，不改变标准事件协议。frozen 在单核临界区中、Stop 返回后发布，主机读取前后确认冻结身份。这是测试工程辅助证据，不能假设任意标准固件都有该元数据。

三种模式均未实板验证。0.3 交付可重建配置、停止/冻结及独立样本，4.4 再验证真实采集；某路径缺少可靠冻结状态或同步边界时报告受阻，不取消必选模式。

0.3 核对补充：固定 3.32 源码在 Post-Mortem 的非零固定通道初始化分支中没有赋值 context.UpChannel，而普通事件写入使用该字段。fixture 采用官方自动分配分支，先保留通道 1 后将 SysView 分配到 2；已通过独立主机样本核对，无第三方源码补丁。此配置依据见 fixture README，生产通道发现仍按名称和元数据。
