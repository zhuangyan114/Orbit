# DAP-10 Peripheral Viewer 双链路真机验收报告

## 验收结论

**通过，用户于 2026-08-11 完成最终确认。** CMSIS-DAP/DAPLink 与 J-Link 两条真机链路均使用各自唯一 owner 完成标准 DAP `readMemory`、Continue -> Pause -> Refresh、Peripheral Viewer UI/raw 值逐项核对和正常断开。直接使用完整名称 `STM32F407VET6` 的 J-Link 尝试因当前 DLL 在 connect 阶段超时而保留为失败现场；改用该 DLL 支持的 `STM32F407VE` 家族标识后通过，不影响目标 MCU、ELF 和 SVD 均为 STM32F407VET6/VETx 的事实。

## 测试对象与配置

- MCU: `STM32F407VET6`
- Peripheral Viewer: `mcu-debug.peripheral-viewer` 1.6.1
- 插件路径: `C:\Users\22690\.vscode\extensions\mcu-debug.peripheral-viewer-1.6.1`
- ELF: `D:\STM32\project\vet6_led\build\Debug\vet6_led.elf`
- SVD: `D:\STM32\project\vet6_led\STM32F407VETx.svd`
- SVD 来源: 项目已有 STMicroelectronics STM32F407 SVD（2022，device version 1.5），未下载临时文件
- DAPLink 验收配置: `deviceName=STM32F407VET6`、`flashBeforeDebug=false`
- J-Link 补充配置: `deviceName=STM32F407VE`、`device=STM32F407VE`、`probe=jlink`、`nativeDebugEngineMode=native`、`flashBeforeDebug=false`。`STM32F407VE` 是 J-Link DLL 对 STM32F407VET6 的家族器件标识：目标板 MCU/ELF 为 STM32F407VET6，项目 SVD 为 `STM32F407VETx.svd`，连接返回 STM32F4 SW-DP ID `0x2BA01477`；完整名称尝试的超时现场也单独保存。
- 两条链路的 `svdFile` 与 `svdPath` 均指向上述 STM32F407 SVD
- `initialize.supportsReadMemoryRequest=true`

## CMSIS-DAP/DAPLink 结果

- DAP session: `b5a3cd4b-61f9-4408-84ef-331d05d3014c`
- `probe=cmsis-dap`
- `ownerKind=cmsis-dap`
- VID/PID: `C251:F001`
- Serial: `LU_2022_8888`
- Transport: HID / SWD / 1000 kHz
- 唯一 helper: `orbit-cmsis-dap-helper.exe` PID `17252`
- 未观察到 J-Link owner、legacy fallback、extension-host backend fallback 或第二 CMSIS-DAP helper
- 日志确认所有目标访问标记为 `owner=cmsis-dap`，通过 NativeScheduler

Peripheral Viewer 成功识别并展开 `RCC @ 0x40023800` 与 `GPIOA @ 0x40020000`。实际批量读取范围为 RCC `count=136`、GPIOA `count=40`，未读取 USART DR、EXTI PR、DMA 标志等已知读清除寄存器。

## 寄存器 UI/readMemory 对照

| 寄存器 | 地址 | Viewer UI | 标准 DAP `readMemory` | Base64 bytes | 结果 |
|---|---:|---:|---:|---|---|
| RCC_CR | `0x40023800` | `0x03007083` | `0x03007083` | `g3AAAw==` (`83 70 00 03`) | 一致 |
| RCC_CFGR | `0x40023808` | `0x0000940A` | `0x0000940A` | `CpQAAA==` (`0A 94 00 00`) | 一致 |
| GPIOA_MODER | `0x40020000` | `0xA8280004` | `0xA8280004` | `BAAoqA==` (`04 00 28 A8`) | 一致 |
| GPIOA_OTYPER | `0x40020004` | `0x00000000` | `0x00000000` | `AAAAAA==` (`00 00 00 00`) | 一致 |
| GPIOA_ODR | `0x40020014` | `0x00000002` | `0x00000002` | `AgAAAA==` (`02 00 00 00`) | 一致 |

每项独立 DAP 请求均为 `count=4`、响应长度 `4`、`unreadableBytes=0`。字节按 little-endian 解析，没有符号扩展、截断或地址错误。

## Continue/Pause/刷新

已完成顺序：停止态展开外设 -> Continue -> 目标运行 -> Pause/停止事件 -> Peripheral Viewer `Refresh All` -> 再次读取 RCC/GPIOA。

日志中可见 CMSIS-DAP `run` 成功、`continued` 事件、随后 `stopped` 事件；刷新后紧接着产生 GPIOA `0x40020000,count=40` 和 RCC `0x40023800,count=136` 的读取。用户提供的两张截图显示刷新后的 RCC/GPIOA 数值与上表一致，没有空值、错误地址或上一 session 陈旧数据。

## J-Link 结果

- 补充 DAP session: `5fe96c37-8a28-4fe2-9279-6f1619a6438b`（临时 DAP 客户端生成并贯穿同一 stdio session）
- VS Code Peripheral Viewer session: `065c0098-8685-40ec-be0c-f6ce8dd3ca44`；实际配置同样为 `STM32F407VE`、`probe=jlink`、`nativeDebugEngineMode=native`、`flashBeforeDebug=false`，helper PID `13772`，同 session 标准 DAP `readMemory` 返回 `RCC_CR=0x03007083`、`RCC_CFGR=0x0000940A`、`GPIOA_MODER=0xA8280004`、`GPIOA_OTYPER=0x00000000`、`GPIOA_ODR=0x00000002`。
- 实际 launch: `deviceName=STM32F407VE`、`device=STM32F407VE`、`probe=jlink`、`speedKHz=4000`、`nativeDebugEngineEnabled=true`、`nativeDebugEngineMode=native`、`flashBeforeDebug=false`、`svdFile`/`svdPath` 均为 `D:\STM32\project\vet6_led\STM32F407VETx.svd`
- owner: `ownerKind=jlink-native`，target-owner session `target-1`，helper PID `1180`；`secondOwnerObserved=false`、`fallbackObserved=false`、`legacyOwnerObserved=false`
- J-Link `Open`、`Connect`、SW-DP health probe 成功，DP ID `0x2BA01477`；helper 正常退出，断开后无 owner/helper 进程
- 正确顺序: `stopped:launch -> Continue -> continued -> Pause -> stopped:pause -> Peripheral Viewer Refresh All`
- `initialize.supportsReadMemoryRequest=true`；DAP trace 保存每个原始请求和完整响应体。五个寄存器均为 `count=4`、响应长度 `4`、无 `writeMemory` 请求：

| 寄存器 | 地址 | launch stopped raw base64 / little-endian | after Refresh All raw base64 / little-endian |
|---|---|---|---|
| RCC_CR | `0x40023800` | `g3AAAw==` / `0x03007083` | `g3AAAw==` / `0x03007083` |
| RCC_CFGR | `0x40023808` | `CpQAAA==` / `0x0000940A` | `CpQAAA==` / `0x0000940A` |
| GPIOA_MODER | `0x40020000` | `BAAoqA==` / `0xA8280004` | `BAAoqA==` / `0xA8280004` |
| GPIOA_OTYPER | `0x40020004` | `AAAAAA==` / `0x00000000` | `AAAAAA==` / `0x00000000` |
| GPIOA_ODR | `0x40020014` | `AAAAAA==` / `0x00000000` | `AAAAAA==` / `0x00000000` |

- 直接使用完整名称 `STM32F407VET6` 的失败现场也保留：J-Link `Open` 成功，但 `connect` 在 5 s 超时，未创建第二 owner、未 fallback、未产生目标读写；因此成功 session 采用 DLL 可连接的 `STM32F407VE` 家族标识。
- VS Code session 已执行 Peripheral Viewer `Refresh All`，并补采 RCC/GPIOA 截图及同 session 标准 DAP `readMemory` 对照。用户确认 UI 中的 RCC/GPIOA 数值与 raw 结果一致；J-Link raw、owner、路由和 UI 层均通过。

## 自动化回归

此前本阶段已运行并通过：

- `npm run typecheck`
- `npm test`（355 tests）
- `npm run build`
- `npm run build:native`
- `npm run test:cmsis-dap:mock`
- `npm run test:cpp-channel:mock`
- `git diff --check`

这些是自动化/mock 证据，不替代 J-Link 真机验收。

## 实际硬件操作范围

已执行：探针枚举、HID/SWD 连接、halt、target state 读取、Continue/run、Pause/halt、RCC/GPIOA 外设读取、Peripheral Viewer 展开/刷新、正常断开。

明确未执行：Flash erase/program/verify、Flash 写入、RAM 写入、外设寄存器写入、Option Bytes 操作、固件修改、OpenOCD、GDB server、`JLink.exe`、Ozone GUI 控制路径。

DAPLink 和本轮 J-Link 均显式使用 `flashBeforeDebug=false`；J-Link 日志只有 `flash skipped reason=flashBeforeDebug=false`，Flash/erase/program/verify、RAM/外设写入和 Option Bytes 操作均为 0，DAP `writeMemory` 请求数为 0。

## 断开与清理

CMSIS-DAP 正常断开后，helper PID `17252` 已退出。先前 J-Link helper PID `13364` 已退出；本轮独立 DAP helper PID `1180` 和 VS Code session helper PID `13772` 也均正常退出，未留下活动 owner/helper。

## 剩余风险

当前 J-Link DLL 不接受完整器件名 `STM32F407VET6` 的连接现场仍保留；该环境需使用 DLL 支持的 `STM32F407VE` 家族标识。结论只覆盖本报告中的 probe、DLL、STM32F407VET6、ELF/SVD 和只读外设范围，不外推到其他 MCU、SVD 质量或具有读清除/写一清零副作用的寄存器。未发现 SVD、DAP adapter、owner 路由或刷新后的 session 数据污染问题。

## 完整证据路径

证据根目录: `C:\Users\22690\Desktop\AI\Ozone for VScode\outputs\dap10-peripheral-viewer\20260810-acceptance-fix`

- `cmsis-dap-evidence.json`
- `register-comparison.json`
- `cmsis-dap-dap.log`
- `cmsis-dap-dll.log`
- `screenshots/cmsis-dap-after-continue-pause-gpioa.png`
- `screenshots/cmsis-dap-after-continue-pause-rcc.png`
- `jlink-evidence-current.json`
- `jlink-register-comparison.json`
- `jlink-dap-current.log`
- `jlink-dll-current.log`
- `screenshots/jlink-after-explicit-pause-refresh.png`
- `screenshots/jlink-after-explicit-pause-refresh-rcc-position.png`
- `screenshots/jlink-final-user-refresh-all.png`
- `screenshots/jlink-after-continue-pause-gpioa.png`
- `screenshots/jlink-after-continue-pause-rcc.png`
- J-Link 原始失败证据: `..\20260810-175946\jlink-evidence.json`, `jlink-dap.log`, `jlink-dll.log`
- 本轮完整名称失败现场: `..\jlink-supplement-2026-08-11T03-54-18-717Z\jlink-supplemental-evidence.json`、`jlink-supplemental-dll.log`、`jlink-supplemental-dap.log`
- 本轮成功 J-Link raw 证据: `..\jlink-supplement-STM32F407VE-2026-08-11T03-56-52-907Z\jlink-supplemental-evidence.json`
- 本轮原始 DAP trace: `..\jlink-supplement-STM32F407VE-2026-08-11T03-56-52-907Z\jlink-readmemory-raw.json`、`jlink-supplemental-dap-trace.json`
- 本轮 owner/DAP 日志: `..\jlink-supplement-STM32F407VE-2026-08-11T03-56-52-907Z\jlink-supplemental-dll.log`、`jlink-supplemental-dap.log`
- VS Code 同 session 部分证据: `..\jlink-supplement-STM32F407VE-2026-08-11T03-56-52-907Z\jlink-vscode-session-evidence.json`、`jlink-vscode-session-dap.log`、`jlink-vscode-session-dll.log`
- 自动化日志: `..\20260810-175946\automation\`
