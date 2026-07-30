# 阶段 A：技术决策记录

日期：2026-07-26

这些 ADR 只冻结阶段 B/C 的接口方向。具体帧字节布局、signal descriptor 和事件 ID 仍需在对应 C/D 任务中形成协议规范并测试。

## ADR-A05：RTT Timeline 与 RTOS Trace 分离

**状态：接受。**

### 决策

1. `RTT Timeline` 使用 Orbit 自有、版本化的二进制 Sample payload。
2. `RTOS Trace` 优先使用 SEGGER 官方 SystemView target source、RTOS integration 和事件语义；主机侧转换为 Orbit 中间模型。
3. 普通 `RTT Log`、`RTT Timeline`、`RTOS Trace` 不默认共用同一 Up Channel。
4. 在完成官方工具/回放逐事件对照前，不宣称完整 SystemView 主机协议或 `.SVDat` 兼容。

### 原因

数值采样需要高吞吐、固定字段和连续序列；RTOS Trace 需要事件 ID、变长参数、任务/ISR 状态和事件语义。把两者混成一个 payload 会让丢包恢复、解析、记录和 UI 都变得不可诊断。

### 主要风险与回退

- 风险：目标端需要多个 Up Buffer，增加 RAM 和配置复杂度。
- 回退：保留官方 SystemView/RTT 通道作为独立 Trace/Log 通道，暂停 Orbit Sample 通道；不得将两种 payload 静默混合。

## ADR-A06：解析、缓存和渲染边界

**状态：接受，先采用有界 MVP。**

```text
Native/Legacy owner
  -> RttTransport
  -> RttStreamScheduler（NativeScheduler 之上）
  -> DAP 进程：读取、帧边界检查、轻量解码、限额批次
  -> Extension Host：有界环形缓存、记录、统计、降采样
  -> Webview：只接收批次/降采样结果并渲染
```

### 约束

- DAP 进程不向扩展宿主转发无限长原始字节流；每批必须有最大字节数、最大样本数和处理预算。
- 扩展宿主缓存必须有总字节/样本上限；超限丢弃最旧数据并增加可见计数。
- Webview 不负责协议真值解析，不得因为 UI 卡顿阻塞 J-Link owner 或 DAP 控制请求。
- 如果 A04/C 阶段证明 DAP 事件批次仍阻塞 DAP stdio，再提交独立有界 IPC/Worker ADR；不能直接放宽队列上限。

## ADR-A07：记录格式

**状态：接受。**

### 决策

- 主记录格式采用 Orbit 自有 `.rtttrace` 容器，不把 `.SVDat` 作为首版写入格式。
- 容器包含版本、流类型、目标身份、ELF identity、目标时钟信息、通道、signal/event descriptor、起止序号、目标时间戳范围和数据块索引。
- 数据块采用二进制编码；CSV/JSON 只作为小规模辅助导出，不作为高频主记录格式。
- 每块必须能独立校验和恢复；记录 overflow、sequence gap、主机丢弃和 decoder error。

### 最小元数据

```text
magic = ORTR
formatVersion
streamKind = sample | rtos-trace
targetDevice / core / rtos
elfPath / elfHash
jlinkDllVersion / interface / speedKHz
targetClockHz / timestampUnit
channelIndex / channelName
descriptorTable
blockIndex: fileOffset, firstSequence, lastSequence, firstTimestamp, lastTimestamp
```

## ADR-A08：许可证与命名

**状态：工程结论接受；发布前仍需项目责任人/法务确认。**

- SEGGER SystemView 和 RTT target source 的仓库各自提供 `LICENSE.md`；若随固件示例或源码发布，必须保留版权、许可条件和免责声明。
- SystemView 主机应用不是 Orbit 的可再分发依赖。Orbit 不复制其 UI、私有实现或安装包，也不把商业授权默认为 Orbit 已拥有。
- `SystemView-compatible` 只描述经过验证的 target API/事件语义兼容范围；用户文档必须同时列出未支持项、对照工具和验证版本。
- “Orbit RTT Timeline”“Orbit RTOS Trace”作为 Orbit 产品名称使用；“SystemView”只作为兼容对象、参考资料和验证工具名称。

参考：

- [SEGGER SystemView target sources](https://github.com/SEGGERMicro/SystemView)
- [SEGGER RTT target sources](https://github.com/SEGGERMicro/RTT)
- [SystemView licensing](https://www.segger.com/products/development-tools/systemview/license/systemview-installation/)
- [SystemView supported RTOS](https://www.segger.com/products/development-tools/systemview/technology/supported-rtos/)

