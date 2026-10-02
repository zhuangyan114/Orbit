# CMSIS-DAP v2 WinUSB Report

Last updated: 2026-10-02

**当前状态：Horco CMSIS-DAP v2 的自动发现、USB 身份筛选、bulk 通信和 SWD 只读访问已通过真机验证；2026-10-02 用户完成了 Orbit 1.1.5、STM32F407IGT6、7 Watch / 2 Timeline 的 v1/v2 同配置会话，对照日志已归档。完整调试控制矩阵、专用 Flash 验收与小时级长稳仍需独立验证。**

本次相同前 120 秒的目标读取完成率估算为 v1 **240.79 Hz/表达式**、v2 **446.03 Hz/表达式**，v2 约 **1.85 倍（+85.23%）**。设备、固件哈希、RTT 实际负载、Watch 条件统计和原始证据见 [v1/v2 Timeline 对照记录](cmsis-dap-v1-v2-timeline-2026-10-02.md)。下文较早的验收状态保留为当时记录。

## 2026-10-02 Horco v2 适配与真实设备证据

### 枚举问题与修复

修改前，WinUSB 枚举能找到 bulk 接口，但 `manufacturer`/`product` 为空，`serial` 被填为复合接口路径中的 Windows instance token `8&14a501f9&0&0000`。`enumeratePreferred(auto)` 按名称过滤设备时丢弃 v2，转而选择同一台 Horco 的 HID v1；使用真实序列号筛选 v2 也无法匹配。

现在使用 [Microsoft WinUsb_GetDescriptor](https://learn.microsoft.com/en-us/windows/win32/api/winusb/nf-winusb-winusb_getdescriptor) 读取 USB device/string descriptors，根据 string index 0 公布的语言读取 manufacturer、product 和真实 serial，再应用 serial/product 筛选。缺失或损坏的描述符保留空值，不冒充真实序列号；显式 path 仍优先于其他筛选。独立 USB wire fixtures 覆盖非英语 LANGID、UTF-16/UTF-8、短/错误类型/奇数长度描述符、真实 serial 和 path 优先级。

WinUSB raw trace 使用既有 `ORBIT_CMSIS_DAP_TRACE=1` 开关，记录端点、请求/完成长度、错误码与原始字节；默认关闭。目标访问仍复用唯一 `cmsis-dap` helper，不增加 owner 或 J-Link fallback。

### 当前探针与目标

| 项目 | 本次读取结果 |
|---|---|
| Product / manufacturer | `Horco CMSIS-DAP v2` / `Horco` |
| VID/PID / serial | `FAED:4870` / `507874001033` |
| Windows service / interface | `WINUSB` / `MI_00`，interface number 0 |
| bulk OUT / IN | `0x01` / `0x81`，各 64-byte endpoint max packet |
| HID report 字段 | input/output 0，report ID 0；v2 不使用 HID report framing |
| DAP_Info(0x04) 原始字符串 | `Horco v0.2`；不解释为数字协议版本 |
| DAP packet size / count | 64 bytes / 32；来源 `protocol-info` |
| SWD clock | 1000 kHz |
| DPIDR | `0x2BA01477`，`DAP_Transfer` ACK=OK |
| DP CTRL/STAT，power-up 后 | `0xF0000040`，debug/system power-up ACK 完成 |
| CPUID | `0x410FC241`（Cortex-M4） |
| MEM-AP | CPUID 4 B、Flash `0x08000000` 512 B、SRAM `0x20000000` 64 B 读取成功 |
| targetState | `Running`；未发出 halt/run/reset |
| Owner / cleanup | 单 `cmsis-dap` helper；disconnect/close/shutdown 与进程退出通过，无残留 helper |
| 电气信息 | 电源/VTref 未测量；握手成功不替代电压或接线证据 |

测试配置了 DP ABORT、CTRL/STAT power-up 和 MEM-AP 访问寄存器；没有执行 CPU 控制、断点 claim、RAM 写、Flash erase/program/verify 或复位线控制。上述 ID 不能单独确定封装/完整料号。

### 失败与恢复记录

首轮在 `DAP_Info(0x01)` 遇到 bulk OUT `WriteTimeout`。独立 Windows WinUSB 同步诊断中，2-byte 与 64-byte `DAP_Info(0xFF)` 请求都返回 Windows error 121；ResetPipe 和重选 alternate setting 0 未恢复。系统同时存在 Keil µVision，但这些证据不能证明 Keil 占用是根因。

用户确认结束其他调试会话并重新插拔后，同一份 transport 实现恢复 bulk 通信。后续完整验证通过，失败记录仍保留。中间脚本的一次 `UnknownMethod: readDp` 是验收脚本 RPC 命名错误，已改为 `dpRead`；一次 CPUID `DapAckFault` 发生在脚本未完成 DP power-up 时，补齐标准 power-up handshake 后通过。未为这些脚本问题改动生产 DP/AP 或协议校验。

- 首次真实失败：`outputs/cmsis-dap-v2/2026-10-02T06-27-45-420Z/evidence.json`。
- 独立 raw 诊断：`outputs/cmsis-dap-v2/{raw-probe-diag,pipe-recovery-diag,alternate-setting-diag}.json`。
- 完整成功证据：`outputs/cmsis-dap-v2/2026-10-02T06-36-36-705Z/evidence.json` 与同目录 `helper-stderr.log`。
- 重跑命令：`node scripts/cmsis-dap/verify-v2-hw.js --serial=507874001033`；运行前结束其他 target owner。脚本仅访问 STM32 的上述只读地址。

### 自动化与使用范围

focused Vitest 72 项、全量 63 文件/872 项通过（1 项跳过），类型检查、扩展构建、native 构建、CMSIS-DAP mock、Flash Algorithm 镜像校验、J-Link mock、helper selftest、RTT C++ oracle 与 `git diff --check` 通过。它们不替代真实 v2 的控制、烧录或性能验收。

在现有 launch 配置中设置 `probe: "cmsis-dap"`，让 `cmsisDapTransport: "auto"` 优先选择 v2；需要锁定 v2 时使用 `cmsisDapTransport: "cmsis-dap-v2"`（或 `"winusb"`）。可用 `cmsisDapSerial: "507874001033"` 精确选择这台探针，保留原有 `device`/`program`。全局 `probe: "auto"` 仍遵循 J-Link 优先政策。

当前先以 `flashBeforeDebug: false` 使用已有固件。真实 v2 的 Flash、halt/run/step、断点、运行时并发和长期稳定性需要独立授权与验证；没有测量 v2 对 HID 的速度提升。

## 2026-08-07 历史基线

以下为当时的 HID-only 设备、代码/mock 与性能记录；其中“等待 v2 设备”的状态是历史状态，当前 Horco 证据见上文。

## Scope and Result

This change adds CMSIS-DAP v2 USB bulk/WinUSB as a transport beneath the existing CMSIS-DAP protocol and target stack. It does not add a DAP protocol implementation, J-Link path, OpenOCD, GDB server, or a second physical target owner.

`auto` enumerates WinUSB first and then HID. `cmsis-dap-v2`/`winusb` selects WinUSB only; `cmsis-dap`/`hid` selects HID only. A failed WinUSB startup returns the CMSIS-DAP error and never falls back to J-Link. HID remains supported.

## Routing and Transport Design

`CmsisDapWinUsbTransport` implements the existing `CmsisDapTransport` interface. It discovers interfaces with SetupAPI, opens them with WinUSB, queries the interface and bulk IN/OUT pipes, and exposes endpoint max-packet sizes separately from the CMSIS-DAP packet capacity. The common `CmsisDapTarget` and protocol layer continue to own `DAP_Transfer`, `DAP_TransferBlock`, ACK/WAIT/FAULT handling, SWD, Cortex-M, Flash Algorithm, Watch, Timeline, RTT, MemoryView, and Peripheral Viewer behavior.

The helper is the one physical CMSIS-DAP owner. `CmsisDapHelperClient` routes all helper RPC through `NativeScheduler`, retaining `control > watch > timeline > background`. Watch, Timeline, and RTT share that owner; no secondary connection is created.

The WinUSB transport handles bounded bulk reads/writes, endpoint discovery, packet-length validation, short and empty reads, stale-input drain, timeout/cancel/late-completion settlement, device removal, and close. A write whose completion is unknown is not retried.

## Evidence Categories

| Category | Evidence | Result |
|---|---|---|
| Code and unit/self-test | Injected `WinUsbIo` fake exercises endpoint discovery, bulk framing, packet-size separation, short read, timeout/cancel/late completion, removal, stale drain, malformed response, and unknown-write no-retry. The same protocol target tests run over scripted HID-like and WinUSB-like transports. | Implemented; not hardware evidence. |
| Mock/raw frame | `npm run test:cmsis-dap:mock` and helper `--selftest` validate CMSIS-DAP framing and error paths. | Protocol and transport mock evidence only. |
| Build | Native helper links `winusb`; TypeScript channel and launch configuration accept the v2 aliases. | Build evidence only. |
| Real hardware | Connected probe `C251:F001`, serial `LU_2022_8888`, product `CMSIS-DAP_LU`, reports HID input/output 65 bytes with report ID 0, CMSIS-DAP packet size 64. It enumerated no WinUSB interface. | HID-only hardware evidence; no v2 hardware acceptance. |
| Estimate | Bulk transport can avoid the HID 64-byte report framing limit when a probe actually exposes CMSIS-DAP v2. | No performance number is claimed without a v2 device. |

## Hardware Matrix

All hardware activity used `D:\STM32\project\vet6_led`; `flashBeforeDebug=false`. The referenced HID DAP-07 sessions used authorized halt/run/pause control to sample a running target, but performed no erase, program, verify, or RAM write. CMSIS-DAP v2 itself did not reach target access because the connected probe exposes no WinUSB interface.

| Probe / transport | VID/PID / serial | Endpoint / packet size | 60-second outcome | Flush Hz | Effective samples per expression per second | Watch success / P95 | Owner cleanup / Flash |
|---|---|---|---|---:|---:|---|---|
| CMSIS-DAP HID, 3 Watch | C251:F001 / LU_2022_8888 | HID 65/65 reports, report ID 0; DAP packet 64 | DPIDR, CTRL/STAT, DP/AP reads, target state, Watch, Timeline complete | 56.624 | 169.741 | 591/591, 13 ms | no residual owner; 0 Flash |
| CMSIS-DAP HID, 6 Watch | C251:F001 / LU_2022_8888 | HID 65/65 reports, report ID 0; DAP packet 64 | DPIDR, CTRL/STAT, DP/AP reads, target state, Watch, Timeline complete | 56.525 | 158.441 | 589/589, 18 ms | no residual owner; 0 Flash |
| CMSIS-DAP v2 WinUSB | C251:F001 / LU_2022_8888 | no WinUSB interface discovered | WinUSB enumeration returned no eligible device | n/a | n/a | n/a | n/a |
| J-Link baseline | unavailable | n/a | connect failed before sampling: `JLinkOpenFailed: JLINK_Open returned -1425101968` | n/a | n/a | n/a | no performance result |

The Timeline flush frequency is the rate of `ozoneDataSamples` deliveries. Effective sample rate is the valid sample count divided by three Timeline expressions and duration; it is deliberately reported separately because each delivery can carry multiple points.

The final independent HID read-only session recorded `DPIDR=0x2BA01477`, `CTRL/STAT=0xF0000000`, `AP CSW=0x23000052`, and `targetState=Halted` with `DHCSR=0x00030003`; it then disconnected and closed. These are HID baseline values, not CMSIS-DAP v2 values.

Hardware evidence files:

- `outputs/dap07/watch-3/2026-08-07-13-09-46/evidence.json`
- `outputs/dap07/watch-6/2026-08-07-13-13-26/evidence.json`
- `outputs/dap07/jlink/watch-3/2026-08-07-13-14-48/evidence.json`

## HID Versus WinUSB

HID wraps a CMSIS-DAP command in a fixed-length report and must account for report ID and report padding. WinUSB sends protocol packets over discovered bulk endpoints, so endpoint maximum-packet length is not assumed to be the CMSIS-DAP packet capacity. WinUSB can reduce framing waste and support larger probe packet capacities, but its actual benefit depends on the probe firmware, USB speed, packet size, SWD clock, target-read behavior, and scheduler load. The connected probe offers only HID, so CMSIS-DAP v2 versus HID uplift is **not measured**.

## Risks and Remaining Work

- Implemented, low-to-medium risk: shared transport interface; one-owner auto selection; injected WinUSB seam; scheduler preservation; endpoint and packet diagnostics; strict non-retry semantics for uncertain writes.
- Not implemented, high risk: performance claims or Flash programming acceptance on a physical WinUSB v2 probe; those require a probe that binds its v2 interface to WinUSB and a separate authorized test matrix.
- Unverified: real WinUSB enumeration/open/connect, endpoint behavior under unplug, long-duration v2 Watch/Timeline/RTT, and v2-vs-HID throughput. The current HID device cannot supply this evidence.

Next hardware step: attach a CMSIS-DAP v2/DAPLink device with a WinUSB-bound bulk interface, run read-only enumerate/open/connect plus DPIDR/CTRL-STAT/DP-AP, then repeat the 3- and 6-Watch 60-second matrix before making any performance comparison.
