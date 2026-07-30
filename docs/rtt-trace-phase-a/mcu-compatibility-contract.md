# 阶段 A：MCU 侧官方 RTT/SystemView 兼容合同

状态：A10 已冻结合同原则；具体 target source 版本和 commit 必须在进入阶段 B 前填入。

## 1. 官方接口边界

MCU 侧必须直接使用固定版本的官方 SEGGER source/API：

- RTT：`SEGGER_RTT.c/.h`、`SEGGER_RTT_Conf.h`、官方 `Control Block`、Up/Down Buffer 和锁/返回值语义；
- SystemView：官方 `SEGGER_SYSVIEW_*` source、事件 API、timestamp 规则和对应 FreeRTOS integration；
- Orbit 扩展：只定义独立通道中的 Sample payload、signal descriptor、版本和恢复字段。

Orbit 不得：

1. 重定义 RTT Control Block、读写 offset、锁语义或官方 API 的返回值含义；
2. 把文本 RTT 日志字节直接解释为 Sample/Trace 事件；
3. 修改官方 SystemView 事件编码后仍称为“直接兼容”；
4. 在目标端加入与官方 API 同名但行为不同的替代层；
5. 因 Orbit 主机无法解析而修改官方传输结构。

## 2. 首批通道合同

| Channel | 逻辑用途 | 写入 API | 消费者 | 规则 |
|---:|---|---|---|---|
| 0 | RTT Log | 官方 RTT 写入 API | Orbit RTT Log | 保持现有文本/ANSI 行为；不混入二进制 Sample |
| 1 | Orbit RTT Timeline Sample | 官方 RTT 写入 API | Orbit Sample decoder | 只放版本化 Sample payload；具体 descriptor 在 C01/C02 冻结 |
| 2 | SystemView/RTOS Trace | 官方 SystemView/RTT integration | Orbit Trace decoder/官方工具对照 | 仅在官方 source 配置完成后启用；不与 Channel 1 混用 |

Channel 编号是首批工程建议，不是对已有固件的事实声明。若目标固件已经占用通道，必须在通道注册表中记录冲突并显式改配置。

## 3. 版本与升级记录

进入阶段 B 前必须填写：

```text
RTT repository/tag/commit:      TBD
SystemView repository/tag/commit: TBD
FreeRTOS source version:        V10.3.1
Target integration file/hash:   TBD
SEGGER_RTT_Conf.h hash:         TBD
SEGGER_SYSVIEW_Conf.h hash:     TBD
Target sample/trace channel map: TBD
```

每次官方 source 升级必须重新执行：

1. 编译和链接检查；
2. 官方 API/Control Block 互操作检查；
3. SystemView 官方工具对照（若涉及 Trace）；
4. Orbit parser 回放和真实 F407 目标回归；
5. 许可证文件与发布包检查。

## 4. 目标端资源与行为记录

合同验收必须记录目标端：

- RTT/SystemView 代码和 RAM 增量；
- 采样/事件写入的最大临界区时间或 CPU 开销；
- Up Buffer 大小、写满策略和 overflow 计数；
- timestamp 来源、频率、宽度、wrap 周期和复位行为；
- 目标 halt、reset、低功耗和异常退出时的缓冲区状态。

“J-Link 能读到字节”只能证明传输读通，不能单独证明官方兼容合同已通过。
