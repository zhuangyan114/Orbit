# NativeScheduler（现行）

`NativeScheduler` 位于 `CppJLinkHelperClient` 发送 helper JSON-lines RPC 之前，保证最多一个 in-flight RPC；helper 进程再串行调用 J-Link DLL。这不是跨 owner 调度器，legacy owner 仍由其会话路径控制。

| 优先级 | 典型请求 | 规则 |
|---|---|---|
| `control` | connect、halt/run/reset、step、断点、writeMemory/变量写入 | 永远先于未开始的读；control request 暂停 Timeline |
| `watch` | 寄存器、普通内存、evaluate/Watch read | control 为空时 FIFO |
| `timeline` | 高频 batch read、RTT read | 可 pause、cancel、同 key coalesce |

`schedule` 支持 `AbortSignal`、`coalesceKey` 和 label；任务已开始后不能安全抢占。`withPaused(['timeline'])` 以引用计数暂停低优先级任务，`finally` 必须恢复。`dispose` 拒绝排队任务，helper 生命周期负责中断在途 RPC。

限制：严格优先级可能使持续 Watch 流量压低 Timeline 吞吐；是否引入配额只能根据真实硬件压力数据决定。取消或合并不是 owner fallback，也不得伪造采样点。详细实时保护见 [realtime-variable-protection.md](realtime-variable-protection.md)。
