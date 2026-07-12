# Native Debug Engine 调度器设计（第一版）

## 结论

Native 调试通道必须只有一个 J-Link DLL owner。第一版在 `CppJLinkHelperClient` 与 helper stdio RPC 之间增加 `NativeScheduler`，所有 native 请求先排队，再由调度器一次只放行一个请求。C++ helper 仍在单一主线程执行 DLL 调用，形成两层保护：

```text
DAP / Watch / Timeline / plugin API
                |
        NativeScheduler (TS)
                |  最多一个 in-flight RPC
        C++ helper owner thread
                |  同步调用
           JLink_x64.dll
```

调度放在 RPC 发送前，而不是 helper 的同步 DLL 调用内部。原因是同步 DLL 调用不可安全抢占；只有在发送前排序，控制命令才不会被已经写入 stdio 的 Timeline 请求淹没。

本任务不启用 native 通道作为默认 DAP 路径，不引入 OpenOCD、GDB server 或 JLink.exe。任务 06 的回退行为保持不变。

## 优先级规则

调度器使用三个严格优先级队列，每个队列内部 FIFO：

| 优先级 | 队列 | 请求 | 规则 |
|---|---|---|---|
| 高 | `control` | `connect`、`halt`、`run/continue`、`step`、设置/清除断点、`writeVariable`、`writeMemory` | 下一次选取任务时总是先于其他队列 |
| 中 | `watch` | Watch/evaluate、寄存器读取、普通内存读取、用户主动读取 | 控制队列为空时执行，默认不丢弃 |
| 低 | `timeline` | `readFastSample`、Timeline 高频内存/变量采样 | 可暂停、取消和按采样计划合并，只在高/中队列为空时执行 |

严格优先级只作用于尚未开始的任务。已经进入 helper 的同步 DLL 调用不会被中途终止，因此 Timeline 单次读取必须有界且短小。批量采样应限制单批表达式数和读取字节数，不能用一个超大 RPC 规避调度。

为避免 Timeline 在 Watch 持续刷新时永久饥饿，后续压测若证实存在饥饿，应在中优先级连续执行配额后放行一个低优先级任务；第一版暂不加入该策略，因为 Watch 当前频率远低于 Timeline，且控制响应确定性优先。

## 队列策略

### 控制命令和写变量

- `step/halt/continue/breakpoint/writeVariable` 固定进入 `control`。
- 控制任务不合并。每个用户动作都必须得到明确结果。
- 写变量优先于所有读取，避免写操作长期排在采样之后。
- 一个控制操作可能包含多个 DLL 动作时，必须作为一个调度任务在 Native Engine 内完成，不能拆成多个可被 Watch 插入的 RPC。例如 clear-current-BP、step、restore-BP、continue 是一个原子控制事务。

### Watch 读取

- 普通 `readRegister/readMemory/evaluate` 默认进入 `watch`。
- Watch 默认 FIFO 且不合并，保证用户主动刷新和展开变量不会无声丢失。
- UI 周期刷新将来可提供 `coalesceKey`，例如 `watch:panel`，只保留尚未执行的最新一轮；用户主动 evaluate 不应使用合并键。
- `setWatchValue` 继续走现有 active DAP session 路由，没有会话时继续使用 extension-host backend。只有 native engine 真正接管变量写入后，才将最终 DLL 操作提交到 `control`；本任务不改变现有行为。

### Timeline 高频采样

- Timeline 调用显式传入 `priority: 'timeline'`。
- 同一采样计划使用稳定的 `coalesceKey`，例如 `timeline:<planId>`。新任务入队时，取消同 key 的旧排队任务，只保留最新请求。
- 合并表示丢弃尚未采集的过期 tick，不伪造数据点。调用方将 `NativeSchedulerCancelledError` 视为预期丢样，不触发 native fallback。
- 采样结果仍按现有 Timeline 批量发送节奏推送，调度器不改变 UI 数据格式。

## Step 暂停与恢复

`step` 通过 `withPaused(['timeline'])` 获取低优先级暂停令牌：

```text
pause timeline
  -> enqueue/execute step as control
  -> step success or failure
  -> finally release pause token
  -> resume queued latest timeline sample
```

暂停使用引用计数而不是布尔值，允许嵌套控制事务。任何成功、超时、异常和 fallback 路径都必须在 `finally` 中释放令牌。暂停只阻止新低优先级任务开始，不取消队列；若调用方希望清除旧采样，应同时调用 `cancelTimeline()` 或依赖 `coalesceKey` 更新为最新 tick。

第一版仅在 `step` 自动暂停 Timeline。`halt` 和断点修改是短控制命令，只依靠高优先级插队。未来 source-level step 状态机应在整个事务期间持有同一个暂停令牌，而不是只包裹单次 `JLINK_Step`。

## 取消机制

- 调用方可传入 `AbortSignal`。任务尚在队列时，abort 将其移除并以 `NativeSchedulerCancelledError` 拒绝。
- 已经开始的任务不可由 AbortSignal 强杀，因为 J-Link DLL 同步调用没有通用、安全的取消语义。
- `coalesceKey` 是 Timeline 的隐式取消：同队列、同 key 的旧排队任务被新任务替换。
- `cancel('timeline')` 或 `cancelTimeline()` 清空尚未开始的采样。
- `dispose()` 拒绝所有排队任务；当前 in-flight RPC 由 helper 退出/超时机制结束。

取消不等于失败切换。预期的 Timeline 合并或 AbortSignal 取消不得触发 koffi fallback；只有 helper 崩溃、协议错误、DLL 加载/连接失败和真实 RPC 超时才允许按任务 06 策略回退。

## 暂停和恢复 API

`NativeScheduler` 提供：

```ts
schedule(work, { priority, signal, coalesceKey, label })
pause(priority) -> resume()
withPaused(priorities, work)
cancel(priority, reason)
dispose(reason)
snapshot()
```

`pause()` 返回幂等 `resume()`，防止重复释放。`snapshot()` 提供 in-flight 状态、各队列长度和暂停队列，用于诊断与后续日志接入，不暴露可变内部队列。

## 实时变量兼容性

现有实时能力在第一版中保持：

- Watch 和 Timeline 在 active `ozone` session 存在时仍通过 `session.customRequest(...)` 路由到 DAP adapter。
- 无 active session 时仍通过 extension-host `OzoneBackend`。
- `setWatchValue` 的地址、类型和写入语义不变。
- DAP 的 MemoryView、Peripheral Viewer 和 RTOS Views 请求格式不变。
- native channel 仍是实验路径；helper 当前只有基础控制、寄存器/内存读取和断点原语。`writeVariable` 与 `readFastSample` 的底层实现属于后续任务，但其调度类别已经固定，接入时不得绕过调度器。

## 失败处理和诊断

- 单个任务失败只拒绝该任务，调度器继续选择下一项。
- step 失败仍恢复 Timeline。
- helper 退出时，所有已发送 RPC 按现有机制拒绝；排队任务随后会发现通道不可用并进入统一 fallback 流程。
- 建议日志字段：task id、label、priority、queue wait ms、execution ms、coalesced/cancelled 原因、各队列深度、暂停计数。
- 不记录变量值和原始内存内容，避免高频日志和敏感数据泄漏。

## 第一版代码映射

| 文件 | 职责 |
|---|---|
| `src/ozone-backend/native-scheduler.ts` | 三队列、单 in-flight、暂停令牌、取消、合并、快照 |
| `src/ozone-backend/cpp-jlink-channel.ts` | 所有 helper RPC 接入调度器；方法默认分类；step 自动暂停 Timeline；读取可显式指定类别 |
| `src/ozone-backend/native-scheduler.test.ts` | 优先级、串行、step 暂停/恢复、合并和取消测试 |
| `native/jlink-helper/src/main.cpp` | 保持单 owner 线程，作为 DLL 串行访问的最终保护层 |

## 验收标准

- [x] 任一时刻最多一个 helper RPC 访问 J-Link owner。
- [x] `step/halt/continue/breakpoint/writeVariable` 分类为高优先级。
- [x] 排队的 Timeline 不会阻塞后到达的 step；正在执行的短采样完成后 step 立即执行。
- [x] step 期间低优先级队列暂停，成功或失败后自动恢复。
- [x] Watch 默认中优先级，写变量高于 Watch 和 Timeline。
- [x] Timeline 支持合并旧 tick 和取消排队任务，不形成无界积压。
- [x] 现有实时读取、active-session 路由和 `setWatchValue` 行为未修改。
- [x] 单元测试覆盖串行、优先级、暂停/恢复、合并和 AbortSignal 取消。
- [ ] native `writeVariable/readFastSample` 原语接入后，补充真实硬件下的并发压测和延迟指标。

## 硬件验收场景

1. 以目标 Timeline 频率连续采样，同时连续执行 step，确认 step 延迟不随 Timeline 队列长度增长。
2. step 开始前记录 Timeline 序号；step 期间不应出现新的底层采样，step 完成后应自动出现新序号，不补造暂停期间的数据。
3. Timeline 运行时执行 `setWatchValue`，写入应先于所有尚未开始的采样，并在下一次有效样本中可见。
4. 同时刷新 Watch、Timeline 和 MemoryView，执行 halt/continue/断点增删，确认 helper 无并发 DLL 调用、无死锁、无意外 fallback。
5. 强制 step 超时或 helper 返回错误，确认暂停令牌释放，Watch/Timeline 能继续工作或按统一策略回退。
