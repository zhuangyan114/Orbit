# DAP-06 Watch 扩展类型支持指导

## 1. 状态与目标

本文档是 DAP-06 Watch 扩展类型工作的实施与验收依据。当前状态为“待实施”，本文档本身不代表功能已经通过。

本轮在现有 CMSIS-DAP Watch 路由、单一 physical owner、`NativeScheduler` 和 DAP 变量树合同上增加以下能力：

1. `enum` 同时显示精确整数和枚举项名称。
2. `int64_t`、`uint64_t` 精确读取并显示完整十进制和十六进制值。
3. `bool`/`_Bool` 同时显示 `0/1` 和 `false/true`。
4. `char` 按字符语义显示，并支持有界 C 字符串读取。
5. 函数指针显示目标地址和函数符号名，但绝不调用目标函数。

本轮不实现 Timeline、RTT、RTOS View、MemoryView、Peripheral Viewer、无线 DAPLink 或通用 C/C++ 表达式解释器。不得修改 J-Link 默认路径，不得创建第二 owner，不得回退 extension-host backend。

## 2. 现有路由与不变量

所有新增类型仍走现有生产路由：

```text
Watch UI / WatchProvider
  -> active ozone DebugSession.customRequest(dataSample)
  -> DapSession
  -> OzoneBackend
  -> SessionTargetSelector
  -> CmsisDapTargetChannel
  -> orbit-cmsis-dap-helper.exe
  -> 当前 CMSIS-DAP HID owner
```

必须保持：

- 一个 session 只有一个 CMSIS-DAP helper 和一个 physical owner。
- 不创建 J-Link native、J-Link legacy、OpenOCD、GDB server 或第二 helper。
- 所有目标访问经过 `NativeScheduler`，优先级保持 `control > watch > timeline > background`。
- 运行态 `dataSample` 不额外查询 target state。
- Watch 每个顶层表达式后释放 target-read gate。
- 控制请求、断点和变量写入期间不并发进入 Watch 读取临界区。
- session identity、generation fence 和终止状态阻止旧结果发布。
- backend 的真实读取错误不得被旧缓存伪装为本次实时读取成功。

## 3. 数据与显示合同

### 3.1 enum

DWARF 解析器必须保存 `DW_TAG_enumeration_type` 下每个 `DW_TAG_enumerator` 的 `DW_AT_name` 和有符号 `DW_AT_const_value`。

显示格式固定为：

```text
2 (DAP06_STATE_RUN)
```

- 已知值：显示整数和枚举名。
- 未知值：显示整数和十六进制，不虚构名称。
- 负值枚举必须保留符号。
- typedef、const 和 volatile 包装后仍能找到枚举表。

### 3.2 int64_t 与 uint64_t

64 位整数必须用 `bigint` 从 little-endian 字节精确解码，不能先转为 JavaScript `number`。有符号值按 64 位二进制补码解释。

显示格式固定为：

```text
-9223372036854775807 (0x8000000000000001)
18446744073709551615 (0xFFFFFFFFFFFFFFFF)
```

`WatchValue.value` 扩展为 `number | string`：JavaScript 安全整数继续使用 `number`，超出安全范围的 64 位整数必须使用精确十进制字符串，并可附带精确十六进制字段。DAP Watch 的 `display` 和验收证据必须使用精确字符串。超过 JavaScript 安全整数范围的值不得以近似 `number` 冒充精确结果；Timeline 等纯数值消费者必须先检查 `typeof value === 'number'`，并明确拒绝或忽略无法无损转换的值，禁止隐式调用 `Number(...)`。

本轮只要求 64 位整数读取和显示，不扩大 `setWatchValue` 的输入协议到 64 位字符串写入。

### 3.3 bool

通过 DWARF boolean encoding，以及解析后的 `_Bool`/`bool` 类型语义识别布尔值。

显示格式固定为：

```text
0 (false)
1 (true)
```

非零的异常底层值显示为 `<value> (true)`，不静默改写目标内存。

### 3.4 char 与字符串

不得仅凭“元素宽度为 1 字节”识别字符串。类型分类必须保留 typedef 名称和限定符链：

- `char`：字符显示，例如 `'A' (65, 0x41)`。
- 控制字符：使用 C 转义，例如 `'\n' (10, 0x0A)`。
- `char[]`、`const char[]`、`char*`、`const char*`：按字符串语义读取和显示。
- `uint8_t`、`int8_t`、`unsigned char`、`signed char` 及其数组：继续按数值语义显示。

字符串读取边界：

- `char[N]` 最多读取 `N` 字节，遇到第一个 `\0` 停止文本解码，但保留数组 children 和 `memoryReference`。
- `char*`/`const char*` 分块读取，最多读取 256 字节；遇到 `\0` 停止。
- NULL 指针返回明确的空指针显示，不访问地址 0。
- 不可读地址返回结构化读取错误，不终止 session，不触发 fallback。
- 非 `\0` 终止缓冲区只读取到固定边界，并明确标记为 truncated/unterminated。
- 合法 UTF-8（包括中文）显示为文本；非法或截断 UTF-8 使用转义字节表示，不抛出未处理异常。

### 3.5 函数指针

DWARF 解析器必须识别 `DW_TAG_subroutine_type` 及指向它的 pointer/typedef/qualifier 链。求值器读取函数地址后：

1. 在 Cortex-M 上清除用于 Thumb 状态的地址 bit0，仅用于符号查找。
2. 只匹配 ELF 中函数类型符号的精确入口地址。
3. 显示原始函数指针地址和解析后的函数名。

显示格式固定为：

```text
dap06_transform @ 0x08001235
```

无法匹配时显示地址和 `<unknown>`，不得用最近符号猜测名称。NULL 函数指针显示 `NULL`。任何验收脚本和生产代码都不得调用函数指针。

## 4. 兼容性要求

以下既有行为必须保持：

- `uint8_t` 标量仍显示 `0..255`，`uint8_t[]` 仍是数值 children。
- `int8_t` 保持有符号显示。
- `uint16_t/uint32_t`、signed、float、double 的值和格式不回归。
- struct、union、数组、结构体数组和指向聚合类型的指针继续保留 `variablesReference`、children、`evaluateName` 和 `memoryReference`。
- union 继续展示所有成员；不虚构“活动成员”。
- Watch 表达式规范化保留数组、指针、成员访问和合法标点。
- `setWatchValue` 仍只写明确的 STM32F407 SRAM 数值变量，成功后立即失效对应缓存。

## 5. 自动化实施顺序

严格执行测试先行：

1. 在 DWARF parser 测试中加入 enum enumerator、subroutine type、char/typedef 区分用例，并先观察预期失败。
2. 在 Commander 测试中加入 enum、64 位边界、bool、char、字符串和函数指针显示用例，并先观察预期失败。
3. 加入 `uint8_t`/`int8_t` 标量与数组回归，证明字符串分支不误分类。
4. 在 DAP session 测试中验证精确显示、variables tree、错误传播和 backend 失败不使用旧缓存伪装成功。
5. 只实施让上述失败测试通过的最小 production 修改。
6. 运行 focused tests，再运行完整回归和构建。

测试不得与 production 共用同一错误 oracle。用于断言的 enum 值、64 位期望字节序、UTF-8 字节和函数地址映射必须在测试中独立给出。

优先测试文件：

```text
src/ozone-backend/jlink-symbols-extended-types.test.ts
src/ozone-backend/commander-realtime-variables.test.ts
src/debug/dap-session-realtime-variables.test.ts
src/debug/dap-session-scopes.test.ts
src/ozone-backend/native-scheduler.test.ts
src/utils/watch-expression-validation.test.ts
```

## 6. 真机固件夹具

在 `D:\STM32\project\vet6_led` 中增加独立且带 `volatile`/引用保活的数据夹具，实际符号必须从生成的 ELF/DWARF 中确认，不得根据源码名称假定存在。

至少包含：

```c
enum Dap06Mode { DAP06_IDLE = 0, DAP06_RUN = 2, DAP06_ERROR = -3 };
volatile enum Dap06Mode g_dap06_mode;
volatile int64_t g_dap06_i64;
volatile uint64_t g_dap06_u64;
volatile _Bool g_dap06_bool;
volatile char g_dap06_char;
const char g_dap06_ascii[] = "Orbit-DAP06";
const char g_dap06_utf8[] = "轨道调试";
const char * volatile g_dap06_text_ptr = g_dap06_utf8;
char g_dap06_unterminated[16] = { 'N', 'O', 'T', '-', 'T', 'E', 'R', 'M', 'I', 'N', 'A', 'T', 'E', 'D', '!', '!' };
volatile uint8_t g_dap06_u8 = 255U;
volatile uint8_t g_dap06_u8_array[4] = { 0U, 127U, 128U, 255U };
typedef uint32_t (*Dap06Function)(uint32_t);
Dap06Function volatile g_dap06_function;
```

运行循环必须让 enum、bool 或其他已知字段按确定规律变化，以证明运行态结果不是停止态缓存。64 位边界值、字符串和函数指针保持稳定，便于逐字节核对。

## 7. 独立真机验收

新增独立脚本，建议路径：

```text
scripts/cmsis-dap/verify-dap06-watch-types-hw.js
```

证据输出到：

```text
outputs/dap06/watch-types/<timestamp>/evidence.json
```

不得复用或覆盖 startup-stop、基础 Watch 或 complex Watch 的证据文件。

真机顺序：

1. 编译固件并检查 ELF、DWARF、符号地址、大小和函数入口。
2. 使用已授权的 CMSIS-DAP owner 执行 erase/program/verify，并记录 Flash operation count。
3. 启动 session 后不做停止态 Watch 预热，立即运行并读取持续变化字段。
4. 连续运行态采样 60 秒，记录完成率、有效率、错误分类、采样率、P50/P95 和最大间隔。
5. 验证 enum 名称和值随固件规律变化，bool 在 `0 (false)`/`1 (true)` 间变化。
6. 逐项验证 64 位精确十进制和十六进制、ASCII、UTF-8、空字符串、长字符串、非终止缓冲区、NULL/不可读指针。
7. 验证 `uint8_t=255` 和 `uint8_t[]` 仍按数值显示。
8. 验证函数指针地址、Thumb bit 和实际 ELF 函数符号名一致。
9. Watch 活跃时执行 Halt、Step、Continue，确认控制不被长期饿死且 Watch 恢复。
10. 停止态读取 Local、Registers、Watch，并检查变量树合同。
11. 仅对既有明确 RAM 数值标量执行一次写入、读取新值和恢复原值；不写 enum、字符串、函数指针或 Flash 常量。
12. 终止 session，确认 helper 退出、轮询停止、无旧结果发布。

有效率目标至少 95%。稳定链路下低于目标时不得以“明确错误”代替通过。字符串和函数指针按精确内容计数，不纳入纯数值率的分母。

证据必须记录 MCU、probe、VID/PID、serial、transport、HID report、packet size、SWD speed、ELF、编译优化、helper PID、ownerKind、DPIDR、Flash 操作、`jlinkInvolved=false` 和第二 owner 检查。

## 8. 授权与禁止项

用户已授权本轮：修改外部测试固件、编译、Flash erase/program/verify、reset、halt、run、step、断点、受控 RAM 数值写入及恢复。

未授权且不得执行：Option Bytes 修改、保护位修改、无关 Flash 区域实验、调用固件函数指针、J-Link/OpenOCD/GDB fallback。

仓库工作树中的既有修改必须完整保留。不提交 Git，不手工修改 `dist/`，不更新 `docs/bug-fix-log.md`。

## 9. 完整验证命令

按顺序运行并记录真实退出码：

```text
npm run typecheck
npm test
npm run build
npm run build:native
npm run test:cmsis-dap:mock
npm run test:cpp-channel:mock
npm run test:cmsis-dap:algorithm
out/native/win32-x64/orbit-cmsis-dap-helper.exe --selftest
git diff --check
git status --short -- dist
```

只有 focused、完整自动化、构建、mock、selftest 和授权真机验收全部满足本文标准后，才能报告本轮 DAP-06 扩展类型通过。
