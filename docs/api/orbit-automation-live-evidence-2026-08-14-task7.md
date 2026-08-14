# Orbit Automation API — Task 7 运行态检查实机验证证据（2026-08-14）

> 通过 v1 Automation API 驱动真实、可见的 VS Code 调试会话完成
> `orbit.runtime.threads / stackTrace / scopes / variables / registers` 读取验证。
> 本次验证经用户明确授权，执行了真实目标变更（Flash、入口 halt）。

## 环境

| 项 | 值 |
|---|---|
| 目标 | STM32F407VET6 |
| 探针 | J-Link（`JLink_V956`，VID_1366&PID_0101 serial 000020090928） |
| 工程 | `d:\STM32\project\vet6_led` |
| ELF | `build\Debug\vet6_led.elf` |
| endpoint instanceId | `09c37c30-f3ab-444d-b164-2df14f7bf0c1` |
| session | `8d441417-3d96-4b8b-9625-ceebad513f1c`（generation 1，入口 halt） |

## 验证流程与结果

| 步骤 | 结果 |
|---|---|
| `orbit.handshake`（read + session.control） | 授予 `["read","session.control"]` |
| `orbit.session.start`（Orbit: J-Link (Flash)） | accepted，入口 halt（350 ms） |
| `orbit.runtime.threads` | threadId 1，`state=halted`，`stopped=true`，名称 `STM32F407VE (FreeRTOS)` |
| `orbit.runtime.stackTrace`（threadId 1） | frame0 `0x80056C4` @ `startup_stm32f407xx.s:61`（Reset_Handler） |
| `orbit.runtime.scopes`（frameId 1） | `Local`（vr `"1"`）+ `Registers`（vr `"2"`） |
| `orbit.runtime.variables`（vr `"2"`） | 返回 PC 寄存器变量 `0x080056C4`（type uint32，memoryReference） |
| `orbit.runtime.variables`（vr `"1"`） | 返回良构空列表（Reset_Handler 无局部变量，符合预期） |
| `orbit.runtime.registers` | R0–R12 / SP / PC / xPSR，各带 `group=core`、`bits=32`、精确 `value`、`memoryReference` |
| **PC 三路交叉校验** | `registers` = `variables(ref 2)` = `stackTrace.frame0` = `0x080056C4` ✅ |

三条相互独立的读路径（`getRegisters` 直读、标准 `variables` 处理器、
`getCallStack` 处理器）收敛到同一个 halted PC `0x080056C4`，证明
`orbitRuntimeSnapshot` 复用的正是 UI 所用的同一批 handler core，而非旁路读取。

关键寄存器值：`SP=0x20020000`（RAM 顶，复位态）、`xPSR=0x01000000`（Thumb 态）、
`R0–R12=0`，与复位入口处状态一致。

## 观察（非缺陷）

1. **frame0 `name` 为原始地址 `"0x80056c4"`**：入口 halt 时 `getCallStack`
   尚未解析出函数名，`name` 回退为地址；source 仍由 DWARF 正确定位到
   `startup_stm32f407xx.s:61`。属既有 `getCallStack` 行为，Task 7 只是透传。
2. **`Local` 为空**：入口停在 Reset_Handler 汇编，无局部变量，符合预期。
3. **寄存器列表无 `LR`**：J-Link native owner 对 index 14 读回 null，
   `getRegisters` 跳过；属既有后端特征，非 Task 7 变更。

## 提交

- `feat(api): expose runtime and stack inspection`（`4fec190`）
- `refactor(api): polish Task 7 runtime review findings`（`d073b19`）
- `test(api): add Task 7 runtime hardware verification script`

## 脚本

- `scripts/automation-api/verify-runtime.js` — handshake → start → threads/stackTrace/scopes/variables/registers + PC 交叉校验
