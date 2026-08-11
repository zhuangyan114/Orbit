# DAP-05 验收报告：硬件断点和源码级 Step

## 状态

**通过，用户于 2026-08-11 完成项目最终确认。** 本报告保留 DAP-05 返工时的代码、Mock 和自动化证据；后续有线 CMSIS-DAP 与 J-Link 调试/控制回归及项目最终验收完成后，阶段状态由“等待独立复验”收口为通过。本报告所述返工当轮未执行真机 reset、run、step、FPB、Flash、Option Bytes、RAM 或外设写操作，不能将后续证据误记为当轮执行。

## 返工根因与修改

1. `FP_CTRL.NUM_LIT` 应为 bits `[11:8]`，production、Mock 和独立 oracle 先前均错误使用 bit 7。已修正 `native/cmsis-dap-helper/src/fpb_breakpoint.cpp`、`native/cmsis-dap-helper/src/mock_transport.h` 和 `scripts/cmsis-dap/fpb-oracle.js`，并在 `native/cmsis-dap-helper/src/main.cpp`、`scripts/cmsis-dap-smoke.js` 增加硬编码 golden 检查。Oracle 不引用 production 常量。
2. `src/debug/dap-session.ts` 的 `handleSetBreakpoints` 先前未检查 clear 结果，并把异常压缩成成功的空断点响应。现在每次 clear 成功后才删除对应本地映射；首个或中途 clear 失败立即返回标准 DAP failure；set 失败保留已经成功设置的槽，并把未尝试项标记为 `NotAttempted`。`src/debug/dap-session-cmsis-dap.test.ts` 覆盖首个 clear 失败、中途 clear 失败、set 失败、backend 异常、成功替换和跨 source 共用槽。
3. `src/ozone-backend/session-target-channel.ts` 先前没有把无法原地清理的 CMSIS-DAP 故障统一升级为 owner loss。现在 `DeviceRemoved`、`HelperExited`、`MalformedResponse`、`StepCleanupFailed` 和 `FpbCleanupFailed` 转换为 `NativeOwnerLost`；selector 释放失败 owner、保持 `owner=none`，不会创建 J-Link/legacy/第二 owner。下一次 CMSIS-DAP owner 连接必须重新执行 `getFpbInfo`，由 ownership claim 清除目标上的 stale comparator。相关注入测试位于 `src/ozone-backend/session-target-channel.test.ts`。
4. `CmsisDapTargetChannel.controlViaHelper()` 先前在 helper 返回 `ok:true` 但缺少 `data` 时直接返回 `MalformedResponse`，绕过 `ownerLost()`，导致 channel 仍为 connected 且 selector 不释放 owner。现在先保留原始 `elapsedMs` 和 diagnostics 构造结构化 `MalformedResponse`，再通过 `ownerLost(method, malformedResult)` 返回 `NativeOwnerLost`。Selector 随即 dispose 该 owner 并变为 `none`，CMSIS-DAP 路径不创建 J-Link、legacy owner 或第二 helper。

本次返工直接修改的文件：

- FPB production/Mock/selftest：`native/cmsis-dap-helper/src/fpb_breakpoint.cpp`、`native/cmsis-dap-helper/src/mock_transport.h`、`native/cmsis-dap-helper/src/main.cpp`
- 独立 oracle/smoke：`scripts/cmsis-dap/fpb-oracle.js`、`scripts/cmsis-dap-smoke.js`
- DAP 原子替换及测试：`src/debug/dap-session.ts`、`src/debug/dap-session-cmsis-dap.test.ts`
- Owner-loss 路由及测试：`src/ozone-backend/session-target-channel.ts`、`src/ozone-backend/session-target-channel.test.ts`
- 验收文档：`docs/dap05-acceptance-report.md`、`docs/bug-fix-log.md`

## FP_CTRL 独立 Golden 证据

硬编码输入和期望值如下：

```text
FP_CTRL = 0x00000260
decode  = revision 1, codeComparators 6, literalComparators 2, enabled false
make    = 0x00000260
legacy shift=7 result = 4 (必须不等于 2)
```

独立 oracle 实际输出：

```json
{"golden":"0x260","made":"0x260","decoded":{"revision":1,"codeComparators":6,"literalComparators":2,"enabled":false},"legacyShift7LiteralComparators":4}
```

`scripts/cmsis-dap-smoke.js` 同时断言 decode、精确 make 结果和旧 shift=7 的失败值；native selftest 也使用硬编码 `0x260`，通过 `185/185`。

## setBreakpoints 原子性证据

Mock DAP 测试证明：

- 第一个 clear 失败时，本地 map 原样保留，未发起 set，failure response 保留 backend 的 `errorCode` 和 message。
- 中途 clear 失败时，仅删除已经确认清除的槽；失败槽及尚未处理、仍在硬件中的槽继续保留 ID，不产生幽灵槽。
- set 失败时，之前成功创建的硬件槽仍保留映射；失败项和未尝试项分别返回结构化错误。
- backend 抛异常时返回 `success:false`，不再伪装成 `{breakpoints: []}` 成功。
- 成功替换保持原有行为；被其他 source 引用的共享硬件槽不会被误清除。

聚焦测试与全量测试均通过；相关全量计数为 24 个测试文件、193 项测试。

## 临时 Comparator 与 Owner-Loss 证据

- Timeout Mock 路径返回 `cleanupOk=true`、`temporarySlot=1`、`restoredSlots=[0]`；随后槽 1 可再次分配，用户原槽 0 已恢复。这是状态与读回断言，不以 best-effort 日志代替成功证据。
- Disconnect/reconnect Mock 路径重新执行 ownership claim，并清除 FPB comparator 状态。
- `DeviceRemoved` 和协议异常 `MalformedResponse` 注入均返回 `NativeOwnerLost`，失败 owner 被释放且 selector 变为 `none`；测试断言没有创建 J-Link 或 legacy owner。
- Helper 返回 `ok:true` 但缺少 `data` 的注入测试先在旧实现上失败，修复后返回 `NativeOwnerLost`；断言保留 `method=stepOverSourceLine`、`ownerKind=cmsis-dap`、`causeErrorCode=MalformedResponse`、`elapsedMs=37` 及原始 `phase/rawLength` diagnostics。测试还证明 channel 状态为 `failed`、`dispose(false)` 被调用、selector 为 `none`，且 CMSIS-DAP/J-Link/legacy 工厂均无额外创建。
- 下一 owner 的测试断言再次调用 `getFpbInfo`。Native selftest 从空内存 bookkeeping 开始、目标 comparator 预置 stale 值，证明 `claimFpbOwnership` 会清除所有目标 stale comparator 后才接管。

## 自动化结果

| 命令 | 真实结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm test` | 通过，24 个测试文件、193 项测试 |
| `npm run build` | 通过；未手工编辑 `dist/` |
| `npm run build:native` | 通过；J-Link helper、CMSIS-DAP helper 均编译并复制到正式路径，Flash Algorithm 构建完成 |
| `npm run test:cmsis-dap:mock` | 通过，使用正式路径 helper |
| `npm run test:cpp-channel:mock` | 通过 |
| `npm run test:cmsis-dap:algorithm` | 通过 |
| `out/native/win32-x64/orbit-cmsis-dap-helper.exe --selftest` | 通过，185/185 |
| `git diff --check` | 通过；仅输出既有文件的 LF/CRLF 转换提示，无 whitespace error |
| `git status --short -- dist` | 无输出，`dist/` 无变更 |

## 返工当轮范围与未实现能力

- DAP-05 返工当轮仅完成 Mock/自动化验证；当轮尚未执行最终独立验收及真机复验，后续证据和 2026-08-11 用户确认完成了状态收口。
- 返工当轮 CMSIS-DAP v2/WinUSB 尚未实现、支持路径为 v1 HID；v2/WinUSB 后来由独立阶段实现和验收。
- 本报告不代表 DAP-06 完成。
- 未引入或创建 J-Link、OpenOCD、GDB server、legacy fallback 或第二 target owner。
- 未经新的明确授权，不得执行真机 reset、run、step、FPB、Flash 或其他目标写操作。
