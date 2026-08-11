# DAP-06 Watch AI 验收交接报告

日期：2026-08-07
状态：自动化、CMSIS-DAP 真机、J-Link 真机和用户手动观察均通过；用户于 2026-08-11 随项目最终验收确认 DAP-06 通过。

## 范围与约束

- MCU：STM32F407VET6。
- CMSIS-DAP：CMSIS-DAP_LU，VID:PID `C251:F001`，serial `LU_2022_8888`，v1 HID。
- J-Link：强制 `jlink-native` helper owner，不允许同 session 创建 legacy/第二 owner。
- 本阶段只处理 Watch，不进入 Timeline、RTT、RTOS View、MemoryView、Peripheral Viewer 或无线 DAPLink。
- 未提交 Git、未手工修改 `dist/`、未修改 J-Link 默认路径。本阶段未更新 `docs/bug-fix-log.md`；该文件在既有脏工作树中已有修改，已原样保留。

## 完成的工作

1. 新增 `docs/dap06-watch-extended-type-support-guide.md` 和实施计划。
2. 扩展 DWARF/Watch 解析：
   - enum 同时显示整数和枚举名。
   - `int64_t/uint64_t` 使用 BigInt 解码并保留精确十进制字符串。
   - bool 显示 `0/1` 和 `true/false`。
   - char 显示字符、整数和 hex。
   - 有界解析 `char[]`、UTF-8 和 `char*`；未终止字符串返回结构化错误。
   - 函数指针清除 Thumb bit0 后解析 ELF 函数名，不调用函数。
   - `uint8_t` 和 `uint8_t[]` 保持数值语义。
3. 修复当前 backend 错误被旧 Watch cache 遮蔽的问题。
4. 真机发现并以 TDD 修复：顶层 `evaluateExpression` 丢失 64 位 `exactValue/numericValueExact` 元数据；元数据现已透传到顶层、结构体字段和数组元素。
5. Timeline/data-sampling 对字符串或非安全 64 位整数不再隐式执行 `Number(...)`。
6. 外部固件 `D:\STM32\project\vet6_led\Core\Src\freertos.c` 增加 enum、64 位、bool、char、字符串、函数指针和多级结构体/联合体 fixture；原文件备份为 `freertos.c.before-dap06-extended-types-20260807-121318.bak`。
7. `scripts/cmsis-dap/verify-dap06-watch-types-hw.js` 支持独立 CMSIS-DAP/J-Link 真机证据目录。

主要生产文件：

- `src/ozone-backend/jlink-symbols.ts`
- `src/ozone-backend/commander.ts`
- `src/ozone-backend/types.ts`
- `src/plugin-api/types.ts`
- `src/debug/dap-session.ts`
- `src/debug-providers/data-sampling-manager.ts`
- `src/webview/app.tsx`

本阶段新增/扩展的主要测试与验收文件：

- `src/ozone-backend/jlink-symbols-extended-types.test.ts`
- `src/ozone-backend/jlink-symbols-union.test.ts`
- `src/ozone-backend/commander-realtime-variables.test.ts`
- `src/debug/dap-session-realtime-variables.test.ts`
- `src/debug-providers/watch-webview-provider.test.ts`
- `scripts/cmsis-dap/verify-dap06-watch-types-hw.js`

## 路由与并发结论

生产路由为：WatchProvider → 活动 ozone `customRequest(dataSample/setWatchValue)` → DapSession → OzoneBackend/Commander → SessionTargetSelector → 选定 channel → NativeScheduler → 单一 helper → 当前探针 owner。

- CMSIS-DAP session：仅 `ownerKind=cmsis-dap`。
- J-Link session：仅 `ownerKind=jlink-native`。
- 活动 DAP session 失败不回退 extension-host backend。
- 所有 native 访问经过 NativeScheduler，顺序保持 `control > watch > timeline > background`。
- 运行态 `dataSample` 不额外查询 target state。
- session identity、generation/read epoch fence 和终止清理阻止旧结果发布。

## 错误路径

- 非法表达式、不可读地址、`DapAckFault`、`DeviceRemoved` 和 `HelperExited` 均保留结构化错误，不触发 extension-host fallback 或第二 owner。
- 未终止字符串按预期返回结构化错误；正常 Watch 项仍继续采样。
- backend 当前错误不会再被旧 Watch cache 遮蔽；session 替换、终止或 owner loss 后的延迟结果受 identity/generation/read epoch fence 拦截。

## 自动化证据

- TDD RED：enum/subroutine DWARF、64 位/bool/char、字符串、函数指针、stale-cache 和 64 位元数据端到端测试均观察到预期失败。
- Focused 最终结果：6 个文件，44 项通过。
- 全量最终结果：28 个文件，231 项通过。
- 以下命令退出码均为 0：
  - `npm run typecheck`
  - `npm test`
  - `npm run build`
  - `npm run build:native`
  - `npm run test:cmsis-dap:mock`
  - `npm run test:cpp-channel:mock`
  - `npm run test:cmsis-dap:algorithm`
  - `out/native/win32-x64/orbit-cmsis-dap-helper.exe --selftest`：185/185
  - `git diff --check`
- `git status --short -- dist` 无输出。

## CMSIS-DAP 真机证据

基础 Watch：`outputs/dap06/watch/2026-08-07-02-18-41/evidence.json`

- 60.104 秒，565 请求，完成率/有效数值率 100%。
- 9.4 Hz，P50/P95 `30/34 ms`，最大间隔 `130 ms`。
- 停止态 Local、Registers、Watch、变量树和 memoryReference 合同通过。
- `flashBeforeDebug:false`，Flash operation count 0。

复杂类型：`outputs/dap06/watch-complex/2026-08-07-03-00-29/evidence.json`

- 多级结构体、联合体、结构体数组、指针及子节点合同通过。
- 60 秒，567 请求，完成率/有效率 100%。

扩展类型：`outputs/dap06/watch-types/2026-08-07-04-34-56/evidence.json`

- 30/30 检查通过；292 请求；可读值有效率 100%。
- 4.853 Hz，P50/P95 `105/110 ms`，最大间隔 `268 ms`。
- helper PID `21884`，DPIDR `0x2BA01477`，无 J-Link/第二 owner，helper 已退出。
- RAM：`0xAAAAAAAA → 0xAAABAAAA → 0xAAAAAAAA`，新值立即可见并恢复。

## J-Link 真机证据

最终证据：`outputs/dap06/watch-types-jlink/2026-08-07-05-01-15/evidence.json`

- 30/30 检查通过；60 秒，297 请求；完成率/可读值有效率 100%。
- 4.936 Hz，P50/P95 `36/38 ms`，最大间隔 `316 ms`。
- Halt/Step/Continue 为 `10/71/8 ms`，Watch 随后恢复。
- RAM：`0xAAAAAAAA → 0xAAABAAAA → 0xAAAAAAAA`。
- `ownerKind=jlink-native`，helper PID `16152`，DPIDR `0x2BA01477`。
- 无 legacy、CMSIS-DAP、OpenOCD、GDB server、`JLink.exe` 或第二 helper；终止后 helper 退出，无旧结果发布。
- `flashBeforeDebug:false`，Flash operation count 0。

第一次 J-Link 尝试在等待一次性 FreeRTOS fixture 断点时超时，没有进入采样或 RAM 写入。最终验收在已确认的 entry stop 执行停止态类型/变量树检查，并独立验证断点设置与清除；该失败证据保留在 `outputs/dap06/watch-types-jlink/2026-08-07-04-58-37/evidence.json`。

## 硬件操作与遗留项

- 已执行：CMSIS-DAP 授权烧录、reset、halt、run、step、断点、RAM 写入和恢复；J-Link reset、halt、run、step、断点设置/清除、RAM 写入和恢复。
- 未执行：Option Bytes、保护位修改、函数指针调用；J-Link 验收未执行 Flash。
- 用户已手动确认 CMSIS-DAP 和 J-Link Watch 显示无异常。
- 真实遗留项：J-Link session 日志证明 `JLINK_Open/JLINK_Connect`，但未回显最终加载 DLL 的绝对路径；本阶段不包含 Timeline/RTT/Viewer/无线链路。

## 建议独立验收步骤

1. 阅读指导文档、最终源码和上述四个最终 evidence.json。
2. 复跑 focused tests、typecheck 和 `git diff --check`。
3. 核对两个最终 evidence 中 owner、helper PID、60 秒统计、控制延迟、RAM 恢复和终止清理。
4. 不把 startup-stop 计划/证据计入 DAP-06 Watch，不进入 DAP-07。
