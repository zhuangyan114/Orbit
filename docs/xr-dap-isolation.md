# XR-DAP 与主功能的隔离边界

本改动基于 Orbit PR #1 的 `21784c15e9cb36474b42e35861cb0899c4a040f1`，PR 基线为 `3928bbb6f4990ff336dfbe71f745f5f593b12e48`。

## 默认行为

`cmsisDapXrSampling` 缺省或为 `false` 时，使用原有主机 Timeline 采样。TCP 只是标准 CMSIS-DAP 的传输选择，不隐式启用 XR 私有协议。

| 功能 | 未开启 XR | 显式开启 XR 且探针支持 |
| --- | --- | --- |
| Timeline | 原有主机定时读取 | 探针定时采样、主机读取缓存 |
| XR INFO / SET / CTRL / DRAIN | 不发送 | 通过当前 CMSIS-DAP owner 发送 |
| Watch 标量读取 | 标准 CMSIS-DAP | XR 采样活动期间可使用厂商 READ |
| 自动 RTT 文本轮询 | 原有轮询逻辑 | 仅 XR 采样活动期间暂停，停止后恢复 |
| J-Link | 原有逻辑 | 忽略 XR 选项，保持原有逻辑 |

只有调试实际选中 CMSIS-DAP owner 且显式启用此配置，才会创建 XR sampler。远程 `dataSamplingStart` 的 `probeSampling: true` 不能覆盖 launch 开关；`probeSampling: false` 可以在已启用的会话里临时选择主机采样。

## 配置示例

标准 TCP 连接不需要 XR 选项：

```jsonc
{
  "type": "orbit",
  "request": "launch",
  "name": "CMSIS-DAP TCP",
  "probe": "cmsis-dap",
  "cmsisDapTransport": "tcp",
  "cmsisDapPath": "192.168.1.100:3241",
  "device": "STM32F407VET6",
  "cmsisDapXrSampling": false
}
```

具备 XR 固件的探针需要探针侧采样时，才把 `cmsisDapXrSampling` 设置为 `true`。该开关同样适用于 HID/WinUSB，不依赖 TCP。探针不支持采样或读取失败时，沿用 PR 的主机采样回退机制。

## 代码边界

- `DapSession` 延迟创建 XR sampler。原有 `captureFastDataSample` 恢复为 PR 基线实现，XR 时间戳修正和样本接收使用独立的 `acceptProbeDataSample`。
- commander 的原有 `readFastDataSampling` 恢复为 PR 基线实现。XR 帧单独格式化，不让 XR 数据格式调整直接改变主机采样格式。
- `CmsisDapTargetChannel` 在开关关闭时不查询 XR INFO，拒绝直接 start/read/stop 采样请求。开关随连接生效，普通重连不继承上次开启状态。
- native helper 只在 `open` 的 `xrSampling: true` 下接受 XR RPC，按序列号恢复残留 XR 采样的命令也受同一开关限制。普通请求只有 XR 已启用且 sampler 活动时才进入厂商 READ / 暂停恢复逻辑。
- 所有访问继续复用单一 target owner，保持 `control > watch > timeline > background` 调度和控制屏障。未创建第二个 helper 或目标连接。
- Timeline webview、缓存保留、CSV 导出和现有 RMLink 集成工作树不在本次改动范围内。公共采样发送格式继续兼容原有消费者。

## 验证范围

隔离回归覆盖默认关闭、显式启用、J-Link、HID/WinUSB/TCP、普通重连、直接 XR RPC 被拒绝、主机回退，以及 XR 时间戳和停止时序。native selftest 在禁用状态下检查四类 XR RPC 均无底层收发。

类型检查、扩展构建、完整单元测试和 native/mock 检查属于主机验证。硬件时序、长期性能和安装后的 VS Code 界面仍需另行验收；本工作树不代表硬件验收通过。

2026-10-19 主机验证结果：

- 先加入隔离测试：原 PR 为 8 项失败、51 项通过，复现缺少默认关闭与 helper 开关的问题。
- 最终完整 Vitest：78 个文件通过，1077 项通过、1 项跳过。
- `npm run typecheck`、`npm run build`、`npm run build:native` 通过。
- `npm run test:cmsis-dap:mock`、`npm run test:cpp-channel:mock`、`npm run test:cmsis-dap:algorithm` 通过。
- CMSIS-DAP helper `--selftest`：204 项、0 失败，包括禁用时四类 XR RPC 无底层收发。
- 对照 PR 基线检查：`captureFastDataSample` 和 `readFastDataSampling` 方法一致；共享调度器、Timeline webview 和缓存代码无差异。

验证输出位于本工作树的 `outputs/isolate-xrdap/`，不提交生成日志或构建产物。
