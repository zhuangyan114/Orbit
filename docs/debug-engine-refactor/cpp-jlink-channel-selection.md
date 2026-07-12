# C++ J-Link 通道技术选型

## 结论

首选方案：独立 C++ helper 进程，使用 stdio JSON-RPC 作为本地 RPC 通道，helper 内部直接 `LoadLibrary` / `GetProcAddress` 调用 `JLink_x64.dll`，并用单线程命令队列串行管理所有会改变 J-Link/target 状态的 API。

备选方案：Node N-API native addon。它适合做早期性能原型或少量同步 API 验证，但不建议作为长期默认主通道，因为 J-Link DLL、C++ 解码器或 native 崩溃会直接带崩 VS Code extension host 或 debug adapter 进程。

保留方案：继续使用 `koffi` 作为回退路径和迁移期对照路径。它不再承担新增 step 状态机和高频采样调度的长期复杂度。

明确排除：不引入 OpenOCD/GDB server 作为实时变量、Watch、Timeline 或写变量的主通道。OpenOCD/GDB server 只可作为资料参考或独立诊断思路，不能替代本项目直连 `JLink_x64.dll` 的实时变量路径。

## 背景和约束

项目是 Windows-only VS Code 扩展。当前 TypeScript 通过 `koffi` 调用 `JLink_x64.dll`，DAP adapter 由 VS Code 作为独立 Node 进程启动，extension host 和 DAP adapter 拥有不同的 `OzoneBackend` 实例。

本轮 debug engine refactor 的目标不是换调试协议，而是把复杂 step、断点、变量读写和高频采样调度从 TypeScript 的跨语言 FFI 拼装中下沉到 Native Debug Engine。核心约束如下：

- J-Link DLL 仍是主硬件通道。
- 正常 debug 命令不走 Ozone GUI、JLink.exe、OpenOCD 或 GDB server。
- J-Link DLL 必须由一个受控线程或串行队列访问，避免并发调用破坏 DLL/target 状态。
- Watch、Timeline、MCP/plugin API 的实时变量读取和写变量延迟是一等需求。
- 新路径必须可通过配置开关灰度启用，并能回退到现有 `koffi` 路径。

## 方案对比

| 方案 | 形态 | 优点 | 缺点 | 结论 |
|---|---|---|---|---|
| 独立 C++ helper 进程 + stdio RPC | DAP adapter 启动/管理 helper，helper 加载 J-Link DLL | 崩溃隔离最好；DLL 状态集中；可独立重启；协议边界清晰；适合串行调度 Watch/Timeline/step/write | 需要设计 IPC、生命周期、版本握手和日志；打包多一个 exe | 首选长期方案 |
| 独立 C++ helper 进程 + TCP RPC | helper 监听 `127.0.0.1` 随机端口 | 便于外部工具复用；长连接和流式数据自然 | 端口/token/防火墙/清理成本更高；已有 DAP 是 stdio，早期没必要 | 备选 IPC，不作为首版默认 |
| Node N-API addon | Node 进程内加载 `.node` native addon，addon 加载 J-Link DLL | 调用延迟最低；TS 调用形态简单；无需单独进程 | native 崩溃带崩 Node；J-Link DLL 状态污染会杀掉调试会话；Node ABI/VS Code Electron 运行时打包复杂 | 性能原型或后备实现，不作为首选 |
| 继续 `koffi` FFI | 现有 TypeScript 直接 FFI | 当前已可用；迁移成本最低；适合作为回退 | 复杂状态机留在 TS；跨语言调用碎片多；高频采样和 step 调度难统一；错误/崩溃边界弱 | 保留回退，不继续扩展为新主架构 |
| GDB server / OpenOCD | 外部 server + MI/RSP | 生态成熟，资料多 | 不符合直连 J-Link DLL 和实时变量主通道要求；引入额外 server 状态；写变量/采样延迟和一致性不可控 | 明确排除主通道 |

## 为什么首选 helper 进程

J-Link DLL 是有全局状态和强时序假设的 native 组件。当前已知风险包括重复 open/close 崩溃、breakpoint API 改变 target halt 状态、step/go 后需要同步 DLL 状态、高频读内存可能影响后续寄存器/变量读取。把这些风险放进 Node 进程内，意味着任何 native 崩溃都会直接终止 DAP adapter 或 extension host。

helper 进程把风险边界移到进程外：

- helper 崩溃时，DAP adapter 可以返回结构化错误并提示重连，而不是整个 VS Code 扩展宿主崩溃。
- J-Link DLL 只在 helper 中加载一次，所有 DLL 状态、breakpoint table、sample plan、step state machine 归一个 native scheduler 管理。
- helper 可以用单线程 owner 模型保证 J-Link API 串行执行，同时把 TS 层请求分成 Control、Read、Sample 三类队列。
- 后续若要做更快的 Timeline 采样，数据可以在 helper 内部批量读取、批量返回，减少 Node 和 native 边界来回切换。

## RPC 通道选择

首版建议使用 stdio JSON-RPC，而不是 TCP。

DAP adapter 本身已经是 stdio 进程模型，启动 helper 后可直接持有 `stdin/stdout/stderr`。stdio 不需要端口分配、防火墙例外或 token 文件，也不会与现有 plugin API 的本地 HTTP server 混淆。

消息格式建议：

```json
{
  "id": 42,
  "method": "stepOverSourceLine",
  "params": {
    "policy": "default"
  }
}
```

响应必须结构化：

```json
{
  "id": 42,
  "ok": false,
  "errorCode": "JLinkTimeout",
  "message": "wait temp breakpoint timeout",
  "targetState": "Halted",
  "pc": 134222336,
  "elapsedMs": 501,
  "diagnostics": {
    "phase": "WaitTempBreakpoint",
    "pollCount": 47
  }
}
```

Timeline 高频采样不建议每个点都发一条 RPC。helper 应提供 `prepareFastSample`、`startSampling`、`stopSampling`、`readSampleBatch` 或事件式 batch 推送，每批包含多个变量和多个时间点。这样能降低 IPC 开销，也能在 step/continue/halt 抢占时统一丢弃或标记过期采样。

TCP 可以留作后续扩展：当 MCP 或外部工具需要直接访问 native engine 时，再考虑在 extension host 管理下启用 `127.0.0.1` 随机端口、Bearer token 和 endpoint 文件。首版不引入这个复杂度。

## Windows 构建方案

推荐构建产物：

```text
native/
  jlink-helper/
    CMakeLists.txt
    src/
out/native/win32-x64/ozone-jlink-helper.exe
```

构建工具建议：

- 使用 CMake + MSVC，目标平台 `win32-x64`。
- C++ 标准使用 C++20 或 C++17；首版优先 C++17，降低工具链要求。
- helper 以动态加载方式访问 `JLink_x64.dll`，不要链接 SEGGER import lib，避免用户安装路径和版本差异导致构建产物绑定死。
- CI 或本地 release 构建生成 `out/native/win32-x64/ozone-jlink-helper.exe`，再由 VS Code extension 打包进 `.vsix`。
- `npm run build` 仍只负责 TS/esbuild bundle；新增 `npm run build:native` 和 release 打包脚本时再串联 native 构建。

不建议首版使用 node-gyp 作为主构建，因为 helper 不是 Node addon。若同时保留 N-API 原型，可单独放在 `native/jlink-addon/`，不能阻塞 helper 主线。

## VS Code Extension 打包方式

helper exe 应随 extension 一起发布：

```text
dist/
  extension.js
  debugadapter.js
native/
  win32-x64/
    ozone-jlink-helper.exe
```

`package.json` 的 `files` 或 `.vscodeignore` 必须确保包含 `native/win32-x64/ozone-jlink-helper.exe`，同时继续排除中间构建目录和调试符号，除非发布诊断版。

DAP adapter 启动时按以下顺序选择通道：

1. 如果 `ozone.nativeDebugEngine.enabled = true`，优先启动 bundled helper。
2. 如果用户配置了开发版 helper 路径，例如 `ozone.nativeDebugEngine.helperPath`，仅在开发/诊断模式下使用。
3. helper 启动失败、版本握手失败或 DLL 加载失败时，返回明确诊断；迁移期可根据配置回退到 `koffi`。
4. 默认关闭 native 通道，待 step、Watch、Timeline、写变量验收通过后再考虑默认启用。

helper 生命周期归 DAP debug session 管理。每个 active `ozone` debug session 最多一个 helper 实例。extension host 的 Watch/Timeline 请求仍应通过 `session.customRequest(...)` 进入 DAP adapter，再由 DAP adapter 转发给 helper，避免 extension host 和 DAP adapter 同时拥有两个硬件通道。

## J-Link DLL 加载设计

helper 负责加载 `JLink_x64.dll`，加载路径优先级：

1. launch/config 中显式传入的 `jlinkDllPath`。
2. 现有 VS Code 设置 `ozone.jlinkDllPath` / `ozone.jlinkPath` 解析出的 DLL 路径。
3. SEGGER 常见安装目录探测。
4. 系统 `PATH`。

加载流程：

```text
start helper
  -> protocol handshake
  -> receive connect(config)
  -> resolve dll path
  -> LoadLibraryW
  -> GetProcAddress required symbols
  -> query J-Link version
  -> JLINK_Open / connect sequence
  -> return EngineResult
```

设计要点：

- `JLINK_Close()` 使用必须保守。现有约束指出 `disconnect()` 不应调用 `JLINK_Close()`，因为 reconnect 依赖已加载 DLL 和 `_wasOpened` 状态避免 close/open crash。helper 应继承这个策略：session 内 disconnect 只断开 target/清理状态，不轻易 unload DLL。
- 所有 J-Link 函数指针在加载阶段集中解析，缺失必需符号时直接返回 `MissingJLinkSymbol`。
- 可选符号用 capability 标记，不让 helper 因老版本 DLL 缺少非关键 API 而无法启动。
- DLL 路径、版本、加载耗时、connect 参数写入 `dll` 类日志。

## 版本检测和能力协商

需要区分三类版本：

- RPC protocol version：TypeScript 和 helper 的协议版本。
- helper build version：helper 自身构建版本、git commit、编译器、架构。
- J-Link DLL version：SEGGER DLL 版本和可用 API capability。

启动后第一条消息必须是 handshake：

```json
{
  "method": "hello",
  "params": {
    "clientProtocol": 1,
    "extensionVersion": "x.y.z",
    "requiredCapabilities": ["basicDebug", "readMemory", "writeMemory"]
  }
}
```

helper 返回：

```json
{
  "ok": true,
  "protocol": 1,
  "helperVersion": "0.1.0",
  "platform": "win32-x64",
  "capabilities": ["basicDebug", "readMemory", "writeMemory", "fastSampling"]
}
```

J-Link DLL 版本在 `loadJLink` 或 `connect` 阶段返回。若 DLL 版本过旧，helper 应返回 warning 或 `UnsupportedJLinkVersion`，由 TS 层显示给用户。版本不应只写日志，必须进入结构化结果，方便 DAP 错误展示和 bug 诊断。

## 错误传播设计

所有 helper API 都返回统一结果，不允许只用字符串或进程退出码表达业务错误。

```ts
interface EngineResult<T = unknown> {
  ok: boolean;
  data?: T;
  errorCode?: EngineErrorCode;
  message: string;
  targetState: "Unknown" | "Halted" | "Running" | "Stepping" | "WaitingForTempBreakpoint" | "Recovering" | "Error";
  pc?: number;
  elapsedMs: number;
  diagnostics?: Record<string, unknown>;
}
```

错误码建议分层：

- `ProtocolError`：JSON 格式、未知 method、版本不兼容。
- `HelperInternalError`：helper 内部状态不一致、未捕获异常被转换。
- `JLinkDllLoadFailed`：DLL 找不到或加载失败。
- `MissingJLinkSymbol`：必需 API 缺失。
- `UnsupportedJLinkVersion`：版本太旧或能力不足。
- `JLinkOpenFailed` / `JLinkConnectFailed`：打开或连接失败。
- `JLinkCallFailed`：API 返回失败，diagnostics 包含函数名和返回码。
- `TargetNotHalted`：命令需要 halted，但 target 状态不满足。
- `Timeout`：等待 halted、temp breakpoint 或 recovery 超时。
- `NoBreakpointSlot`：硬件断点槽不足。
- `InvalidAddress`：地址未对齐、超范围或不可执行。
- `SamplingInterrupted`：采样被 step/halt/write 抢占。
- `EngineStateCorrupted`：breakpoint table 或 DLL 状态无法恢复，需要重连。

TS 层消费规则保持当前项目约束：所有 `OzoneCommandResult` 消费者必须检查 `.ok` 后再读 `.data`。native 结果映射回 DAP 时，错误应尽量保留 `errorCode`、`phase`、`pc`、`elapsedMs`，不要压缩成普通 `Error.message`。

## 调度和延迟设计

helper 内部建议一个 J-Link owner 线程处理所有 DLL 调用，外部 RPC 线程只解析消息和排队。

队列优先级：

```text
ControlQueue: halt, step, continue, reset, breakpoint update, write variable
ReadQueue: watch, evaluate, read registers, read memory
SampleQueue: timeline fast sampling
```

规则：

- ControlQueue 可暂停 SampleQueue。
- 写变量优先级高于 Watch 读取和 Timeline 采样，避免用户写入被高频采样饿死。
- step 开始时递增 read epoch，取消或标记旧采样结果。
- step 期间低优先级采样暂停，step 完成后恢复。
- running 态 Watch/Timeline 只能使用明确允许的无 halt 读取策略；需要 halt 的变量展开必须进入 halted 态或返回明确错误。
- breakpoint 修改、continue、step、halt 不允许与 J-Link breakpoint/read/write API 并发执行。

这套调度是选择 helper 的关键收益：它把跨来源请求统一排队，而不是让 extension host、DAP adapter、Watch provider、Timeline manager 分别尝试保护 J-Link DLL。

## N-API addon 备选设计

如果需要验证 native 解码器和 J-Link API 调用延迟，可实现一个最小 N-API addon：

- 只暴露 `decodeThumbInstruction`、`readRegisters`、`singleStep` 等少量 API。
- 仍然使用一个 native mutex/queue 串行 J-Link 调用。
- 不作为默认通道，不承载完整 step 状态机和高频采样。
- 不要求迁移期删除 `koffi`。

N-API 的主要风险是打包和崩溃隔离：

- `.node` addon 需要匹配 VS Code Electron 的 Node ABI 或使用稳定 Node-API。
- native 崩溃会直接终止调用它的 Node 进程。
- extension host 和 debug adapter 是不同 Node 进程，必须避免两个进程分别加载 addon 后同时访问同一目标。

因此 N-API 只能是性能原型或特定函数加速备选，不作为长期首选。

## `koffi` 回退路径

迁移期保留当前 `koffi` 路径：

- native helper 默认关闭。
- helper 启用后，先迁移 stepOver，再迁移 stepInto/stepOut，最后迁移 fast sampling。
- 每个能力有独立开关，例如 `ozone.nativeDebugEngine.stepOver`、`ozone.nativeDebugEngine.fastSampling`。
- 发现 helper 版本不匹配、DLL 加载失败或 `EngineStateCorrupted` 时，可按配置回退到 `koffi`，但必须在日志和 UI 中明确说明当前使用的是回退路径。

长期不建议继续把新状态机复杂度加到 `koffi` 路径。`koffi` 的价值是稳定回退和行为对照。

## 打包和发布风险

主要风险及应对：

| 风险 | 应对 |
|---|---|
| helper exe 被 `.vscodeignore` 排除 | release 前增加 VSIX 内容检查 |
| 用户机器缺少 VC runtime | 优先静态链接运行库，或在文档中明确依赖；发布包内不随意放系统 DLL |
| J-Link DLL 路径不一致 | 支持显式配置、常见路径探测和 PATH fallback |
| helper 与 extension 协议不匹配 | hello handshake 阻止继续运行，并显示版本诊断 |
| helper 崩溃 | DAP adapter 捕获进程退出，返回可诊断错误并要求重连 |
| 多进程同时访问 J-Link | 只有 active DAP session 启动 helper；Watch/Timeline 通过 `session.customRequest` 路由 |

## 推荐迁移顺序

1. 建立 helper skeleton、stdio RPC、hello/version handshake、日志。
2. 实现 DLL 加载、版本检测、connect/disconnect，但默认不开启。
3. 实现基础 read registers/read memory/write memory，并与 `koffi` 对照。
4. 实现 step state machine 的最小 fast path：非 call 单指令 step。
5. 实现 temp breakpoint、breakpoint table 和 step-over call。
6. 接入 DAP `stepOver` 灰度开关。
7. 接入 Watch/Timeline fast sampling，但保持 ControlQueue 抢占优先。
8. 完成写变量优先级和采样取消 epoch。
9. 历史 step 场景、实时变量读写、MemoryView/Peripheral Viewer/RTOS Views 验收通过后，再考虑默认启用。

## 验收对应关系

- 明确首选方案：独立 C++ helper 进程 + stdio JSON-RPC。
- 明确备选方案：Node N-API addon 作为性能原型；TCP RPC 作为后续外部复用通道；`koffi` 作为迁移回退。
- 明确 VS Code extension 打包：随 `.vsix` 打包 `native/win32-x64/ozone-jlink-helper.exe`，由 DAP adapter 管理生命周期。
- 明确 Windows 构建：CMake + MSVC，动态加载 `JLink_x64.dll`，生成 `win32-x64` helper exe。
- 明确 DLL 加载、版本检测、错误传播：helper 内集中加载、handshake、capability、结构化 `EngineResult`。
- 明确不引入 OpenOCD/GDB server 作为实时变量主通道：本方案继续直连 `JLink_x64.dll`，OpenOCD/GDB server 不进入主架构。
