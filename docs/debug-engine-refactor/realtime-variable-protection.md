# 实时变量保护（现行）

活动 `ozone` DAP session 是 Watch、Timeline、MCP/plugin API 的唯一运行态 target 路由。extension-host backend 仅在没有活动 ozone session 时允许访问 target。

```text
Watch / Timeline / plugin API
  -> session.customRequest(dataSample | setWatchValue | getTargetState)
  -> DapSession read/control barrier
  -> OzoneBackend -> selected SessionTargetOwner
```

- `RuntimeRouter` 的 active-session 请求失败返回操作错误，不回退本地 backend。
- 控制操作（step、continue/halt/reset、断点、写变量）先禁止新 target read，并等待已开始的 read 完成；控制期间 Watch/MCP read 返回缓存或 `running` 占位。
- `setWatchValue` 与 step 串行，写前 flush 已捕获 Timeline 批次，写后失效对应 Watch cache；目标恢复到写前 running/halted 意图。
- Timeline 在控制期间暂停，不补造数据；恢复的时间戳必须单调。Native helper 路径额外使用 `NativeScheduler` 的 control/timeline 排序。

自动测试覆盖读/step、读/写、控制恢复和 active-DAP no-fallback。真实硬件有部分读取、写入和 step 后恢复证据，但仍缺少一个不重启 session 的完整 recording + Into/Over/Out 压力记录；因此不能宣称完整硬件通过。
