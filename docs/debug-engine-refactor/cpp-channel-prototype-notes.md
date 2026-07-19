# C++ J-Link 通道最小原型说明

## 结论

任务 06 已按任务 05 的选型实现为独立 Windows C++ helper 进程。helper 通过 stdio NDJSON RPC 接收命令，在单一主线程中动态加载并调用 `JLink_x64.dll`。当前默认 DAP 和 extension host 路径没有引用该模块，仍完整使用现有 `koffi` 实现。

原型提供以下命令：

- `connect`
- `halt`
- `run`
- `step`
- `readRegister`
- `readMemory`
- `setBreakpoint`
- `clearBreakpoint`

辅助协议还提供 `hello` 握手、`load` DLL 诊断和 `shutdown`，用于独立测试和进程生命周期管理。

## 文件布局

```text
native/jlink-helper/
  CMakeLists.txt
  src/main.cpp
scripts/
  build-native.ps1
  cpp-channel-smoke.js
src/ozone-backend/
  cpp-jlink-channel.ts
out/native/win32-x64/
  orbit-jlink-helper.exe       # 本地构建产物，gitignored
  test/JLink_x64.dll           # 测试专用 mock DLL，gitignored
```

`src/ozone-backend/cpp-jlink-channel.ts` 是实验性 TypeScript 封装。它没有被 `src/extension.ts`、`src/debugadapter.ts`、`OzoneBackend` 或 DAP session 导入，因此不会改变默认调试路径。

## 构建

前提：Windows x64、CMake 3.20+，以及 Visual Studio C++ x64 工具链或 x64 MinGW-w64。

```powershell
npm run build:native
```

脚本优先使用 Visual Studio C++；没有 MSVC workload 时可回退到 MinGW-w64。两种路径都构建 C++17 helper，并静态链接对应的 C/C++ runtime，然后复制到：

```text
out/native/win32-x64/orbit-jlink-helper.exe
```

`npm run build` 仍只构建原有五个 TypeScript/browser entrypoint，不隐式要求 C++ 工具链。这样没有安装 MSVC 的扩展开发者仍可使用原有调试路径。

## 独立测试

不连接硬件时可验证 helper 启动、协议握手和结构化错误：

```powershell
npm run test:cpp-channel
```

使用测试专用 mock DLL 覆盖全部八个基础命令，不依赖探针或目标板：

```powershell
npm run test:cpp-channel:mock
```

mock DLL 只存在于 `out/native/win32-x64/test/`，不会进入默认调试路径或 VSIX。它验证的是 helper 的 DLL 动态加载、符号绑定、命令派发、数据编码和断点槽位逻辑；真实硬件时序仍需在连接开发板后运行下面的硬件测试。

仅加载真实 DLL、解析必需符号和读取版本，不连接探针：

```powershell
npm run test:cpp-channel -- --load-only --dll="C:\Program Files\SEGGER\JLink\JLink_x64.dll"
```

连接开发板并验证基础控制：

```powershell
npm run test:cpp-channel -- --hardware --dll="C:\Program Files\SEGGER\JLink\JLink_x64.dll" --device=STM32F407VG --speed=4000
```

可选验证硬件断点设置和清除：

```powershell
npm run test:cpp-channel -- --hardware --dll="C:\Program Files\SEGGER\JLink\JLink_x64.dll" --device=STM32F407VG --breakpoint=0x08000100
```

断点地址必须是当前目标上的合法可执行地址。smoke test 默认不设置断点，避免在未知固件地址上做破坏性验证。

## 实测报告

本次原型已连接真实 J-Link 和 STM32F407VG 目标板完成硬件 smoke test。测试使用的命令为：

```powershell
npm run test:cpp-channel -- --hardware --dll="C:\Program Files\SEGGER\JLink_V956\JLink_x64.dll" --device=STM32F407VG --speed=4000 --breakpoint=0x08000100
```

测试环境和目标信息：

| 项目 | 结果 |
|---|---|
| J-Link DLL | `C:\Program Files\SEGGER\JLink_V956\JLink_x64.dll` |
| DLL 版本 | `95600` |
| 探针 | `J-Link driver` |
| USB | `VID_1366&PID_0101` |
| 探针状态 | `OK` |
| 目标设备 | `STM32F407VG` |
| 接口/速度 | `SWD` / `4000 kHz` |
| 断点地址 | `0x08000100` |

真实硬件命令结果：

| 操作 | 结果 | 耗时 |
|---|---:|---:|
| `connect` | 通过 | smoke test 未单独记录 |
| `halt` | 通过 | `2 ms` |
| `readRegister` | 通过 | `0 ms` |
| `readMemory` | 通过 | `1 ms` |
| `step` | 通过 | `4 ms` |
| `run` | 通过 | `4 ms` |
| `setBreakpoint(0x08000100)` | 通过，使用 slot `0` | smoke test 未单独记录 |
| `clearBreakpoint` | 通过，清除后恢复运行状态 | smoke test 未单独记录 |

同时完成的非硬件验证：

| 命令 | 结果 |
|---|---|
| `npm run build:native` | 通过 |
| `npm run build` | 通过 |
| `npm run typecheck` | 通过 |
| `npm test` | 通过，2 个测试文件、4 个测试用例 |
| `npm run test:cpp-channel:mock` | 通过，mock DLL 覆盖八个基础命令 |
| `npm run test:cpp-channel -- --load-only` | 通过，真实 DLL 可加载并读取版本 |

结论：C++ helper 能稳定加载真实 `JLink_x64.dll`，并在开发环境中完成 `connect`、`halt`、`run`、`step`、`readRegister`、`readMemory`、`setBreakpoint`、`clearBreakpoint` 八项基础控制。默认 DAP/koffi 路径未被接入或替换，实验路径加载失败或崩溃时仍按 TypeScript 封装回退到现有 `koffi` 路径。

## RPC 协议

每行一个 UTF-8 JSON 对象。请求示例：

```json
{"id":1,"method":"hello","params":{"clientProtocol":1}}
{"id":2,"method":"connect","params":{"dllPath":"C:\\Program Files\\SEGGER\\JLink\\JLink_x64.dll","device":"STM32F407VG","speedKHz":4000,"interface":"SWD"}}
{"id":3,"method":"readRegister","params":{"index":15}}
{"id":4,"method":"readMemory","params":{"address":536870912,"size":16}}
```

响应统一包在 `result` 中：

```json
{
  "id": 3,
  "result": {
    "ok": true,
    "message": "register read",
    "targetState": "Halted",
    "elapsedMs": 0,
    "data": { "index": 15, "value": 134217984 }
  }
}
```

内存数据使用 base64 返回，避免 JSON 数字数组的体积和解析开销。错误包含 `errorCode`、`message`、`targetState`、`elapsedMs` 和可选 `diagnostics`。

## DLL 加载和调用约束

加载优先级：

1. `connect.params.dllPath`
2. `C:\Program Files\SEGGER\JLink_V*\JLink_x64.dll`，版本目录倒序
3. `C:\Program Files\SEGGER\Ozone\JLink_x64.dll`
4. 系统 DLL 搜索路径中的 `JLink_x64.dll`

helper 同时尝试 `JLINK_*` 与 `JLINKARM_*` 导出名。所有必需符号在首次 `connect` 时集中解析，缺失时返回 `MissingJLinkSymbol`。

连接顺序与现有路径保持一致：`Open -> ExecCommand(device) -> SetSpeed -> TIF_Select -> Connect`。断点固定维护六个槽位，并严格使用 `JLINK_SetBP(slotIndex, address)`。

helper session 内不调用 `JLINK_Close()` 或 `FreeLibrary()`。退出进程时由 Windows 回收模块，避免重复 close/open 引发的已知崩溃风险。

## TypeScript 实验封装和回退

`ExperimentalCppJLinkChannel` 可由后续实验代码显式创建。它首先启动 helper 并执行 `hello`，随后调用 native `connect`。以下情况会关闭 native helper，并重新通过现有 `JLinkDLL.open/connect` 使用 `koffi`：

- helper 可执行文件不存在或无法启动
- helper 进程崩溃或异常退出
- RPC 请求超时
- 协议版本不匹配
- DLL 加载或必需符号解析失败
- native open/connect 失败

回退结果的 `data.channel` 为 `koffi`，成功 native 连接为 `cpp`，调用方可以记录当前实际通道。

原型不自动接入 DAP，也不新增用户设置。要开始灰度接入，后续任务应在 DAP session 层增加默认关闭的配置开关，并确保 Watch/Timeline 仍通过 active debug session 路由。

## 已知限制

- 本任务只验证基础 J-Link 通道，不包含完整 native step-over 状态机、写内存、批量采样或断点命中等待。
- `step` 只发出单指令 `JLINK_Step`，不在原型内增加固定 sleep 或源码行轮询。
- helper 崩溃后会重连 `koffi`，但不会迁移 helper 内的断点表。调用方应将 native 崩溃视为需要重新同步断点的会话事件。
- helper 当前每个进程拥有一个 J-Link owner 线程，即主 RPC 循环；未来加入采样线程时，所有 DLL 调用仍必须回到该 owner 队列。
- 本地 C++ 构建产物位于 `out/`，当前不纳入 VSIX。正式灰度发布前需要增加 release 构建和 VSIX 内容检查。

## 验收映射

| 验收项 | 原型对应实现 |
|---|---|
| 默认调试路径不受影响 | 新 TS 模块没有被现有 entrypoint 或 backend 引用；`npm run build` 不依赖 native build |
| 可在开发环境单独测试 | `npm run build:native` 和 `npm run test:cpp-channel` |
| 支持八项基础控制 | helper RPC command dispatch 和 J-Link 动态函数表 |
| 加载失败可回退 | `ExperimentalCppJLinkChannel` 在 helper/DLL/open/connect 失败时调用现有 `JLinkDLL` |
| native 崩溃隔离 | helper 是独立子进程，TS 捕获 `error`/`exit` 并拒绝 pending RPC |
| 构建可重复 | CMake + C++17 + MSVC x64/MinGW-w64，输出路径固定且不手改 `dist/` |
